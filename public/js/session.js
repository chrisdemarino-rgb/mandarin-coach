// Practice session controller. Owns the state machine, the script -> chunks -> pieces model, audio flow and API calls.
// UI modules only read `S` fields and call its methods; they never touch audio or the network.
import { buildChunks, chunkIndexForSentence, parseScript, splitAtPauses, countScriptChars, MAX_PIECE_CHARS } from "../shared/script.js";
import { createMachine, createStore, hashString } from "./state.js";
import * as api from "./api.js";
import { normalizeAssessment, isPass, wordOutcome, applyWordStatus, normalizeSavedMissed } from "./assess.js";
import { retellOutcome, retellPassed } from "./retell.js";
import * as apiWords from "./api-words.js";
import { audio, getAudioEl, ensureInit, startAudioFromTap, micError, MicError, RECORDING_PROBLEMS } from "./audio-io.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAttemptId = () => `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const FADE_LABELS = {
  1: "Level 1 · keywords + pinyin",
  2: "Level 2 · first characters",
  3: "Level 3 · topic hint",
  4: "Level 4 · from memory",
};

export function createSession() {
  const store = createStore();
  const machine = createMachine();
  const subs = new Set();

  const S = {
    store, machine,
    parsed: null, chunks: [], chunkIdx: 0, pieceIdx: 0,
    fade: 1, cue: null, cueLoading: false, cueError: "",
    heardKey: "",
    assessment: null,         // normalized assessment of the latest attempt
    attemptInfo: null,        // {replayed, summary}
    coachLines: [], coachAudio: [], coachPlaying: false, coachDone: false,
    corrections: [],
    streamEnded: false, coachSkipped: false, summary: null,   // retell: has the SSE stream ended / was the coach (meaning check) skipped / done.summary
    peeked: false, peekCount: 0,                              // retell: reference text peeked at during this attempt / times this session
    retellIntroSeen: (() => { try { return sessionStorage.getItem("mc_retell_intro") === "1"; } catch { return false; } })(), retellIntroOpen: false,
    statusStage: "",          // uploading | assessing | transcribing | coaching | speaking
    error: null,              // {message, code, retryable, canSkip, kind:'mic'|'upload'|'assess'|'audio'|'tts', network}
    notice: "",               // soft, non-blocking note (e.g. coach audio skipped)
    pauseReason: "",
    autoResumePending: false, // paused by a real interruption that may end by itself (see S.interrupt / S.onAudioBack)
    recording: null,          // last take {blob, mime, durationMs, url}
    recStart: 0,
    playPos: { t: 0, d: 0, what: "" },
    micArmed: false, ttsOff: false,
    stats: { peeks: 0, attempts: 0, passed: 0, toneFlags: 0, skipped: 0, startedAt: 0, doneChunks: new Set(), weak: new Map() },
    saveMsg: "",
    words: [], wordsLoaded: false,
    savedMissedExtra: [],     // savedMissed from the `done` event (assessment carries its own)
    missed: [], missedSupported: null, missedError: "", missedLoaded: false, missedUndo: null,   // "Words to practise" (backend /api/words/missed)
    prefsError: "",

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { subs.forEach((fn) => { try { fn(S); } catch (e) { console.error(e); } }); },
    get state() { return machine.state; },
    get settings() { return store.settings; },
    get practiceMode() { return store.settings.practiceMode; },
    get retell() { return store.settings.assessMode === "retell"; },
    /** Fading-cue flow (key-word prompts from /api/cues, text hidden): chosen as the practice mode, and always used for retelling. */
    get cueFlow() { return store.settings.practiceMode === "fading_cues" || store.settings.assessMode === "retell"; },
    get chunk() { return S.chunks[S.chunkIdx] || null; },
    get piece() { const c = S.chunk; return c ? c.pieces[S.pieceIdx] || null : null; },
    get pieceKey() { return `${S.chunkIdx}:${S.pieceIdx}:${S.chunk ? S.chunk.id : ""}`; },
    get hasScript() { return S.chunks.length > 0; },
    get totalPieces() { return S.chunks.reduce((n, c) => n + c.pieces.length, 0); },
    get pieceNumber() { let n = 0; for (let i = 0; i < S.chunkIdx; i++) n += S.chunks[i].pieces.length; return n + S.pieceIdx + 1; },
    get sessionActive() { return !["idle", "finished"].includes(machine.state); },
  };

  let runId = 0;                // bumps to cancel in-flight async flows
  let ac = null;                // AbortController for network calls of the current flow
  let currentAttemptId = null;  // reused while retrying the SAME take
  let coachChain = Promise.resolve();
  let tickRaf = 0;
  let pendingWordStatus = null; // a word_status event that arrived before the assessment

  const abortFlow = () => { runId++; if (ac) { ac.abort(); ac = null; } coachChain = Promise.resolve(); };
  const newFlow = () => { abortFlow(); ac = new AbortController(); return { run: runId, signal: ac.signal }; };
  const alive = (run) => run === runId;
  const stopAudio = () => { try { audio.stop(); } catch { /* ignore */ } S.coachPlaying = false; stopTick(); };

  function stopTick() { cancelAnimationFrame(tickRaf); tickRaf = 0; S.playPos = { t: 0, d: 0, what: "" }; }
  function startTick(what) {
    cancelAnimationFrame(tickRaf);
    const step = () => {
      const a = getAudioEl();
      if (a && isFinite(a.duration) && a.duration > 0) { S.playPos = { t: a.currentTime, d: a.duration, what }; S.emit(); }
      tickRaf = requestAnimationFrame(step);
    };
    tickRaf = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ script / chunks */
  S.loadScript = (text, { resetProgress = true } = {}) => {
    abortFlow(); stopAudio(); releaseMic();
    store.setScript(text);
    S.parsed = parseScript(text);
    const h = hashString(text);
    if (resetProgress || store.progress.scriptHash !== h) store.setProgress({ sentenceIndex: 0, done: [], scriptHash: h });
    S.rebuild(store.progress.sentenceIndex || 0);
    machine.send("ABORT") || (machine.state === "finished" && machine.send("RESET"));
    resetAttemptState();
    S.emit();
  };

  S.rebuild = (sentenceIndex = null) => {
    const text = store.script.text;
    if (!text) { S.chunks = []; return; }
    const si = sentenceIndex ?? (S.chunk ? S.chunk.sentenceStart : 0);
    S.chunks = buildChunks(text, store.settings.chunkMode);
    S.chunkIdx = Math.min(chunkIndexForSentence(S.chunks, si), Math.max(0, S.chunks.length - 1));
    S.pieceIdx = 0;
  };

  S.setChunkMode = (mode) => {
    if (store.settings.chunkMode === mode) return;
    const si = S.chunk ? S.chunk.sentenceStart : 0;
    store.setSettings({ chunkMode: mode }, true);
    S.rebuild(si);
    S.pushPrefs({ chunkMode: mode });
    // changing mid-session: restart the current piece for the new chunk; keep recording state tidy
    if (S.sessionActive && machine.state !== "paused") {
      abortFlow(); stopAudio(); cancelTake(); resetAttemptState(); S.fade = 1;
      machine.send("RETRY") || machine.send("NEXT");
      enterPrompting();
    } else { resetAttemptState(); }
    S.emit();
  };

  S.setPracticeMode = (mode) => {
    if (store.settings.practiceMode === mode) return;
    store.setSettings({ practiceMode: mode }, true);
    S.fade = 1; S.cue = null; S.heardKey = "";
    S.pushPrefs({ practiceMode: mode });
    if (S.sessionActive && machine.state !== "paused") { abortFlow(); stopAudio(); cancelTake(); resetAttemptState(); machine.send("RETRY") || machine.send("NEXT"); enterPrompting(); }
    S.emit();
  };

  S.setAssessMode = (mode) => {
    if (store.settings.assessMode === mode) return;
    store.setSettings({ assessMode: mode }, true); S.pushPrefs({ assessMode: mode });
    S.fade = 1; S.cue = null; S.heardKey = "";
    if (S.sessionActive && machine.state !== "paused") { abortFlow(); stopAudio(); cancelTake(); resetAttemptState(); machine.send("RETRY") || machine.send("NEXT"); enterPrompting(); }
    S.emit();
  };
  /** Retell intro card ("Say it in your own words"): shown once per session until "Got it"; re-openable with the info button. */
  S.ackRetellIntro = () => { S.retellIntroSeen = true; S.retellIntroOpen = false; try { sessionStorage.setItem("mc_retell_intro", "1"); } catch { /* private mode */ } S.emit(); };
  S.openRetellIntro = (open = true) => { S.retellIntroOpen = open; S.emit(); };
  /** Retell: the learner looked at the reference text. Counted per attempt (flag) and per session (stats); shown in the result. */
  S.notePeek = () => { if (!S.peeked) { S.peeked = true; S.peekCount++; S.stats.peeks++; } };
  S.outcome = () => (S.retell ? retellOutcome({ assessment: S.assessment, corrections: S.corrections, keyIdeas: S.assessment && S.assessment.keyIdeas, streamEnded: S.streamEnded, coachSkipped: S.coachSkipped, summary: S.summary }) : null);
  /** Did this attempt pass? Retell: only when the coach compared the meaning and flagged no missing idea (tone is never part of it). */
  S.passed = () => (S.retell ? retellPassed(S.outcome()) : S.assessment ? isPass(S.assessment) : false);
  S.setVoice = (voice) => { store.setSettings({ voice }, true); S.pushPrefs({ voice: voice || undefined }); S.emit(); };
  S.setSpeed = (speed) => { store.setSettings({ speed }, true); S.pushPrefs({ speed }); S.emit(); };
  S.setLocal = (patch) => { store.setSettings(patch); S.emit(); };

  S.pushPrefs = (patch) => {
    api.putPrefs(patch).then(() => { S.prefsError = ""; }).catch((e) => { S.prefsError = e.auth ? "" : "Couldn't save that setting to the server."; S.emit(); });
  };
  S.applyServerPrefs = (p) => {
    if (!p) return;
    const patch = {};
    for (const k of ["chunkMode", "assessMode", "practiceMode", "voice", "speed"]) if (p[k] !== undefined && p[k] !== null) patch[k] = p[k];
    store.setSettings(patch, true);
    if (S.parsed) S.rebuild(S.chunk ? S.chunk.sentenceStart : store.progress.sentenceIndex || 0);
  };

  /* ------------------------------------------------------------------ helpers */
  function resetAttemptState() {
    S.assessment = null; S.attemptInfo = null; S.coachLines = []; S.coachAudio = []; S.corrections = [];
    S.streamEnded = false; S.coachSkipped = false; S.summary = null; S.peeked = false;
    S.coachDone = false; S.coachPlaying = false; S.statusStage = ""; S.error = null; S.notice = ""; S.pauseReason = "";
    S.savedMissedExtra = []; pendingWordStatus = null;
    if (S.recording && S.recording.url) URL.revokeObjectURL(S.recording.url);
    S.recording = null; currentAttemptId = null;
  }
  // audio.js has no cancel: stop the recorder and throw the take away. enterPrompting() awaits `discarding` so a new take never starts early.
  let discarding = Promise.resolve();
  async function discardTake() {
    if (audio.getState() === "recording") { try { await audio.stopRecording(); } catch { /* not recording */ } }
    try { audio.markDone(); } catch { /* ignore */ }
  }
  function cancelTake() { discarding = discardTake(); }
  function releaseMic() { try { audio.releaseMic(); } catch { /* ignore */ } S.micArmed = false; }
  function setError(kind, e, extra = {}) {
    const err = e instanceof Error ? e : new Error(String(e));
    S.error = {
      kind, message: err.message, code: err.code || "", network: !!err.network,
      retryable: err.retryable !== false, canSkip: true, retryAfterSec: err.retryAfterSec || 0, ...extra,
    };
  }
  function persistProgress() {
    const c = S.chunk;
    if (c) store.setProgress({ sentenceIndex: c.sentenceStart, done: [...S.stats.doneChunks], scriptHash: store.progress.scriptHash });
  }

  /* ------------------------------------------------------------------ cues (fading) */
  async function loadCue(run, signal) {
    S.cue = null; S.cueError = "";
    const p = S.piece;
    if (!S.cueFlow || !p) return;
    if (S.fade === 4) { S.cue = { level: 4, cue: "", items: [] }; return; }
    S.cueLoading = true; S.emit();
    try {
      const c = await api.cues(p.spoken, S.fade);
      if (alive(run)) S.cue = c;
    } catch (e) {
      if (!alive(run)) return;
      // Cue is a helper, not a gate. Fall back to showing the text so the user can still practise.
      S.cueError = e.network ? "Couldn't load the cue (offline?)." : "Couldn't load the cue.";
      S.cue = { level: S.fade, cue: "", items: [], failed: true };
    } finally { S.cueLoading = false; }
  }

  function prefetchAhead() {
    // While the user is speaking, warm caches for what comes next (best effort, never throws).
    const nxt = peekNext();
    if (!nxt) return;
    if (S.cueFlow) api.prefetchCues(nxt.spoken, [1]);
    else if (!S.ttsOff) for (const seg of splitAtPauses(nxt)) if (seg.text && /[\u3400-\u9fff]/.test(seg.text)) api.tts(seg.text, { voice: store.settings.voice, speed: store.settings.speed }).catch(() => {});
  }
  function peekNext() {
    const c = S.chunk; if (!c) return null;
    if (S.pieceIdx + 1 < c.pieces.length) return c.pieces[S.pieceIdx + 1];
    const n = S.chunks[S.chunkIdx + 1]; return n ? n.pieces[0] : null;
  }

  /* ------------------------------------------------------------------ model audio */
  /** Play the model voice for a piece (listen-and-repeat prompt / "hear it" / fading reveal). Resolves when done. */
  async function playModel(piece, run, { signal } = {}) {
    if (!piece || S.ttsOff) return;
    const segs = splitAtPauses(piece);   // [{text}|{pauseMs}]
    for (const seg of segs) {
      if (!alive(run)) return;
      if (!seg.text || !/[\u3400-\u9fff0-9A-Za-z]/.test(seg.text)) { if (seg.pauseAfter) await sleep(seg.pauseAfter * 1000); continue; }
      let blob;
      try { blob = await api.tts(seg.text, { voice: store.settings.voice, speed: store.settings.speed, signal }); }
      catch (e) {
        if (e && e.name === "AbortError") return;
        if (e.status === 501 || e.code === "tts_not_configured") { S.ttsOff = true; S.notice = "The coach voice isn't set up on the server yet, so there's no model audio. Read the text aloud, then record."; return; }
        throw e;
      }
      if (!alive(run)) return;
      S.coachPlaying = true; startTick("model"); S.emit();
      try { await audio.play(blob); }
      catch (e) { if (alive(run)) S.notice = "Couldn't play the model audio on this device. Read the text aloud, then record."; return; }
      finally { stopTick(); S.coachPlaying = false; }
      if (seg.pauseAfter && alive(run)) { S.notice = ""; await sleep(Math.min(seg.pauseAfter, 5) * 1000); }
    }
  }

  /* ------------------------------------------------------------------ flow */
  async function enterPrompting({ forceModel = null } = {}) {
    const { run, signal } = newFlow();
    S.error = null; S.assessment = null; S.attemptInfo = null; S.coachLines = []; S.coachAudio = []; S.corrections = []; S.coachDone = false; S.streamEnded = false; S.coachSkipped = false; S.summary = null; S.peeked = false; S.statusStage = ""; S.savedMissedExtra = []; pendingWordStatus = null;
    if (!S.hasScript || !S.piece) { finishSession(); return; }
    const piece = S.piece;
    currentAttemptId = null;
    if (S.recording && S.recording.url) URL.revokeObjectURL(S.recording.url);
    S.recording = null;
    S.emit();
    try {
      await discarding;
      if (!alive(run)) return;
      await loadCue(run, signal);
      if (!alive(run)) return;
      S.emit();
      const fading = S.cueFlow;
      const wantModel = forceModel !== null ? forceModel : !fading || (S.fade === 1 && S.heardKey !== S.pieceKey);
      if (wantModel) {
        await playModel(piece, run, { signal });
        if (!alive(run)) return;
        if (fading) S.heardKey = S.pieceKey;
      }
      if (!alive(run)) return;
      await enterListening(run);
    } catch (e) {
      if (!alive(run) || (e && e.name === "AbortError")) return;
      setError("tts", e, { action: "rerun", retryable: true });
      S.emit();
    }
  }

  async function enterListening(run) {
    if (!machine.send("PROMPT_DONE")) machine.send("REARM");
    try {
      if (!S.micArmed) { await audio.armMic(); S.micArmed = true; }
      await audio.startRecording();
    } catch (e) {
      if (!alive(run)) return;
      S.micArmed = false;
      const me = micError(e);
      S.error = { kind: "mic", action: "resume", message: me.message, code: me.code, retryable: true, canSkip: false };
      machine.send("PAUSE"); S.pauseReason = "";
      S.emit(); return;
    }
    if (!alive(run)) return;
    S.recStart = performance.now();
    S.emit();
    prefetchAhead();
  }

  /** User tapped Start (inside the tap handler: unlock + arm mic must happen synchronously with the gesture). */
  S.start = async ({ fromSentence = null } = {}) => {
    if (!S.hasScript) return;
    S.stats = { peeks: 0, attempts: 0, passed: 0, toneFlags: 0, skipped: 0, startedAt: Date.now(), doneChunks: new Set(), weak: new Map() };
    if (fromSentence !== null) { S.rebuild(fromSentence); } else if (machine.state === "finished") { S.rebuild(0); }
    S.pieceIdx = 0; S.fade = 1; S.heardKey = ""; S.ttsOff = false; S.peekCount = 0;
    if (S.retell && !S.retellIntroSeen) { S.retellIntroSeen = true; try { sessionStorage.setItem("mc_retell_intro", "1"); } catch { /* ignore */ } }   // starting counts as having seen it
    S.retellIntroOpen = false;
    resetAttemptState();
    machine.send("RESET"); machine.send("START");
    S.emit();
    try { await startAudioFromTap(); S.micArmed = true; }
    catch (e) {
      S.micArmed = false;
      const me = e instanceof MicError ? e : micError(e);
      S.error = { kind: "mic", action: "resume", message: me.message, code: me.code, retryable: true, canSkip: false };
      machine.send("PAUSE"); S.emit(); return;
    }
    enterPrompting();
  };

  S.pause = (reason = "") => {
    if (!machine.can("PAUSE")) return;
    const was = machine.state;
    abortFlow(); stopAudio();
    if (was === "listening") cancelTake();
    machine.send("PAUSE");
    S.pauseReason = reason;
    releaseMic();   // release on Pause (privacy + lets other apps use the mic); re-armed on Resume (user tap = allowed)
    S.emit();
  };

  /** Resume from Pause. `auto` = we are resuming by ourselves after a real interruption ended (no user tap), so a failure
   *  (iOS wants a gesture, mic refused) falls back to the manual "Paused... Tap Resume" banner instead of a mic error.
   *  Keeps the chunk/piece/fade; a take interrupted while listening goes straight back to listening (no model replay). */
  S.resume = async ({ auto = false } = {}) => {
    if (!machine.can("RESUME")) return;
    const to = machine.resumeTo;
    S.error = null; S.pauseReason = ""; S.autoResumePending = false;
    audio.recordEvent("session.resume", "info", `${auto ? "auto" : "manual tap"} -> ${to} @ chunk ${S.chunkIdx} piece ${S.pieceIdx}`);
    machine.send("RESUME");
    S.emit();
    try { ensureInit(); await audio.unlock(); await audio.armMic(); S.micArmed = true; }
    catch (e) {
      const me = micError(e);
      machine.send("PAUSE");
      if (auto) { S.pauseReason = MANUAL_PAUSE_MSG; audio.recordEvent("session.resume", "info", `auto-resume failed (${me.code}); manual Resume needed`); }
      else S.error = { kind: "mic", action: "resume", message: me.message, code: me.code, retryable: true, canSkip: false };
      S.emit(); return;
    }
    if (to === "result" && S.assessment) { S.emit(); return; }
    if (to === "listening" && !S.assessment) {
      // Same piece, same position in the loop: just start the take again (the coach already spoke; do not replay it).
      const { run } = newFlow();
      await discarding;
      if (alive(run)) await enterListening(run);
      return;
    }
    if (to === "prompting" || !S.assessment) { machine.send("RETRY") || 0; enterPrompting(); }
  };

  S.skipPrompt = () => {
    if (machine.state !== "prompting") return;
    const { run } = newFlow();
    stopAudio(); S.error = null; S.emit();
    enterListening(run);
  };

  S.errorAction = () => {
    const e = S.error; if (!e) return;
    if (e.action === "reupload") return S.reupload();
    if (e.action === "resume") { S.error = null; return machine.state === "paused" ? S.resume() : S.retry(); }
    S.error = null;
    if (machine.can("RETRY")) return S.retry();
  };

  S.retry = () => {
    if (!machine.can("RETRY")) return;
    abortFlow(); stopAudio(); cancelTake();
    machine.send("RETRY");
    // Fading: keep the level; retrying doesn't count as a new heard-model reveal
    enterPrompting({ forceModel: S.cueFlow ? false : null });
    S.emit();
  };

  S.skip = () => {
    if (!machine.can("NEXT")) return;
    abortFlow(); stopAudio(); cancelTake();
    S.stats.skipped++;
    advance();
  };

  /** Move to the next piece (or next chunk / finish). Fading restarts at level 1 for the new piece. */
  function advance() {
    const c = S.chunk;
    if (!c) return finishSession();
    if (S.pieceIdx + 1 < c.pieces.length) { S.pieceIdx++; }
    else {
      S.stats.doneChunks.add(c.id);
      if (S.chunkIdx + 1 >= S.chunks.length) { persistProgress(); return finishSession(); }
      S.chunkIdx++; S.pieceIdx = 0;
    }
    persistProgress();
    S.fade = 1;
    machine.send("NEXT");
    enterPrompting();
    S.emit();
  }

  /** Is the current piece the very last one of the script? */
  S.isLast = () => S.chunkIdx >= S.chunks.length - 1 && S.chunk && S.pieceIdx >= S.chunk.pieces.length - 1;

  /** What the main button does in the result state. Fading: pass -> one level less cue on the SAME piece (level 4 pass -> next piece);
   *  no pass -> one level more cue. Listen-and-repeat: pass -> next piece, no pass -> try again. */
  S.resultAction = () => {
    const passed = S.passed();
    const fading = S.cueFlow;
    if (S.retell) {
      const o = S.outcome();
      if (o.state === "pending") return { kind: "wait", label: "Checking the meaning…", disabled: true };
      if (o.state === "missing") return { kind: "easier", label: S.fade > 1 ? `Try again with more cue (level ${S.fade - 1})` : "Try again, with the missing idea" };
      if (!retellPassed(o)) return { kind: "retry", label: "Try again" };   // partly covered / not checked: same cue level
    }
    if (fading) {
      if (passed) return S.fade < 4 ? { kind: "harder", label: `Less cue (level ${S.fade + 1} of 4)` } : { kind: "next", label: S.isLast() ? "Finish" : "Next piece" };
      return { kind: "easier", label: S.fade > 1 ? `Try again with more cue (level ${S.fade - 1})` : "Try again" };
    }
    return passed ? { kind: "next", label: S.isLast() ? "Finish" : "Next" } : { kind: "retry", label: "Try again" };
  };
  S.doResultAction = () => {
    if (machine.state !== "result" && machine.state !== "playback") return;
    const act = S.resultAction();
    if (act.disabled) return;
    abortFlow(); stopAudio();
    if (act.kind === "harder") { S.fade++; machine.send("RETRY"); enterPrompting({ forceModel: false }); }
    else if (act.kind === "easier") { S.fade = Math.max(1, S.fade - 1); machine.send("RETRY"); enterPrompting({ forceModel: false }); }
    else if (act.kind === "retry") { machine.send("RETRY"); enterPrompting(); }
    else advance();
    S.emit();
  };

  S.finish = () => { if (machine.state === "idle") return; finishSession(); };
  function finishSession() {
    abortFlow(); stopAudio(); cancelTake(); releaseMic();
    machine.send("FINISH");
    persistProgress();
    S.emit();
  }
  S.reset = () => { abortFlow(); stopAudio(); releaseMic(); machine.send("RESET"); resetAttemptState(); S.emit(); };

  /* ------------------------------------------------------------------ stop recording -> attempt */
  S.stopRecording = async () => {
    if (machine.state !== "listening") return;
    const run = runId;
    machine.send("STOP"); S.statusStage = "uploading"; S.error = null; S.emit();
    let take;
    try { take = await audio.stopRecording(); }
    catch (e) { if (!alive(run)) return; setError("audio", e, { action: "rerecord", message: "The recording failed. Tap Retry to record again.", canSkip: true }); S.emit(); return; }
    if (!alive(run)) return;
    if (!take || !take.valid) {
      const reason = (take && take.reason) || "too_short";
      S.error = { kind: "audio", action: "rerecord", message: RECORDING_PROBLEMS[reason] || `That recording wasn't usable (${reason}). Try again.`, code: reason, retryable: true, canSkip: true, local: true };
      try { audio.markDone(); } catch { /* ignore */ }
      S.emit(); return;
    }
    S.recording = { blob: take.blob, mime: take.mime, durationMs: take.durationMs, url: URL.createObjectURL(take.blob) };
    currentAttemptId = newAttemptId();
    submitAttempt();
  };

  async function submitAttempt() {
    const piece = S.piece;
    if (!piece || !S.recording) return;
    const { run, signal } = newFlow();
    const { blob, mime } = S.recording;
    S.error = null; S.statusStage = "uploading";
    try { audio.markProcessing(); } catch { /* ignore */ }
    S.emit();
    let gotAssessment = false, terminalError = null;
    coachChain = Promise.resolve();
    try {
      await api.attempt({
        blob, mime, chunkText: piece.spoken, assessMode: store.settings.assessMode, practiceMode: store.settings.practiceMode,
        attemptId: currentAttemptId, voice: store.settings.voice, speed: store.settings.speed, signal,
        onEvent: (name, data) => {
          if (!alive(run)) return;
          if (name === "status") { S.statusStage = data.skipped ? S.statusStage : data.stage; if (data.skipped && data.message && data.stage !== "transcribing") S.notice = data.stage === "speaking" ? "Coach audio isn't available right now; showing text only." : data.message; }
          else if (name === "assessment") { gotAssessment = true; onAssessment(data, piece); }
          else if (name === "word_status") { const list = Array.isArray(data) ? data : data && (data.wordStatus || data.words); if (S.assessment) applyWordStatus(S.assessment, list); else pendingWordStatus = list; }
          else if (name === "coach_text") { S.coachLines[data.index] = { role: data.role || "", text: (S.coachLines[data.index]?.text || "") + (data.delta || ""), caption: data.caption || S.coachLines[data.index]?.caption || "" }; }
          else if (name === "coach_audio") { S.coachAudio[data.index] = { url: data.url, text: data.text }; queueCoachAudio(run, data.url); }
          else if (name === "done") { S.corrections = data.corrections || []; if (data.savedMissed) S.savedMissedExtra = normalizeSavedMissed(data.savedMissed); if (data.wordStatus && S.assessment && !S.assessment.wordStatus.length) applyWordStatus(S.assessment, data.wordStatus); S.attemptInfo = { ...(S.attemptInfo || {}), summary: data.summary || null }; S.coachDone = true; S.statusStage = ""; }
          else if (name === "error") { terminalError = data; }
          if (name === "status" && data && data.skipped && data.stage === "coaching") S.coachSkipped = true;
          if (name === "done") { S.summary = data && data.summary && typeof data.summary === "object" ? data.summary : null; S.streamEnded = true; if (S.summary && S.summary.coached === false) S.coachSkipped = true; }
          S.emit();
        },
      });
    } catch (e) {
      if (!alive(run) || (e && e.name === "AbortError")) return;
      if (gotAssessment) { S.coachDone = true; S.streamEnded = true; S.coachSkipped = true; S.statusStage = ""; S.notice = "Connection dropped before the coach finished; the assessment above is complete."; S.emit(); return; }
      onUploadFailure(e); return;
    }
    if (!alive(run)) return;
    if (terminalError) { onAttemptError(terminalError); return; }
    if (!gotAssessment) { onUploadFailure(new api.ApiError("The server ended the response without a result.", { network: true })); return; }
    try { audio.markDone(); } catch { /* ignore */ }
    S.statusStage = "";
    if (!S.streamEnded) { S.streamEnded = true; S.coachSkipped = true; }   // stream closed without `done`: the meaning check can't be claimed
    if (S.retell && S.assessment && S.assessment.ok && retellPassed(S.outcome())) S.stats.passed++;
    S.emit();
    S.loadMissed();   // the backend auto-feeds "Words to practise" from missed words: refresh after every attempt
  }

  function onUploadFailure(e) {
    // Network drop or pre-stream validation error. Keep the take + attemptId so Retry-upload re-posts the SAME attempt.
    try { audio.markDone(); } catch { /* ignore */ }
    S.statusStage = "";
    const retryAfter = e.retryAfterSec ? ` Try again in ${e.retryAfterSec}s.` : "";
    setError("upload", e, { action: S.recording ? "reupload" : "rerecord", message: (e.message || "Upload failed.") + (e.status === 429 ? retryAfter : ""), canReupload: !!S.recording && (e.network || e.status >= 500 || e.status === 409 || e.status === 429), canSkip: true });
    if (e.status === 409) S.error.message = "That take is already being processed. Wait a moment, then tap Try again.";
    S.emit();
  }
  /** Retell/STT error codes get a plain explanation. Always starts with "No assessment obtained" so nothing looks like a result. */
  const ERROR_HINTS = {
    no_speech_detected: "I didn't hear any speech in that take. Say the passage in your own words, close to the microphone.",
    retell_too_long: "That passage is too long to retell in one go. Use a shorter chunk (Settings > Chunking) and try again.",
    stt_not_configured: "Speech-to-text isn't set up on the server yet, so free retelling can't be checked.",
  };
  function errorText(d) {
    const base = ERROR_HINTS[d.code] || d.message || "";
    return /^no assessment obtained/i.test(base) ? base : `No assessment obtained${base ? `: ${base}` : "."}`;
  }
  function onAttemptError(d) {
    try { audio.markDone(); } catch { /* ignore */ }
    S.statusStage = "";
    S.assessment = null;
    const reupload = !d.code || /^(engine_unavailable|rate_limit|upstream|timeout|internal|engine_error|service_unavailable)/.test(d.code);
    S.error = {
      kind: "assess", action: reupload && S.recording ? "reupload" : "rerecord", code: d.code || "", message: errorText(d), retryable: d.retryable !== false, canSkip: d.canSkip !== false,
      canReupload: d.retryable !== false && /engine_unavailable|rate_limit|not_configured|unavailable|timeout|upstream/.test(d.code || "") && !!S.recording,
      engine: d.engine || "", mock: d.mock === true, stage: d.stage || "",
    };
    S.emit();
  }

  /** Re-send the SAME recording with the SAME attemptId (server replays or re-runs). */
  S.reupload = () => {
    if (!S.recording || machine.state !== "processing") return;
    S.error = null; S.emit(); submitAttempt();
  };

  function onAssessment(data, piece) {
    const a = normalizeAssessment(data, piece.spoken);
    if (pendingWordStatus && !a.wordStatus.length) applyWordStatus(a, pendingWordStatus);
    pendingWordStatus = null;
    S.assessment = a;
    if (!a.ok) { // status unavailable inside an assessment event: treat as no-assessment error
      onAttemptError({ code: "unavailable", message: "No assessment obtained for that take.", retryable: true, canSkip: true, engine: a.engine, mock: a.mock });
      return;
    }
    S.stats.attempts++;
    if (!a.retell) {   // retell: tone flags are a rough, transcript-based guide only and the pass is decided when the coach finishes
      if (isPass(a)) S.stats.passed++;
      S.stats.toneFlags += a.confirmed.length;
      const key = piece.spoken;
      if (a.confirmed.length) S.stats.weak.set(key, a.confirmed.length); else S.stats.weak.delete(key);
    }
    machine.send("RESULT");
    S.statusStage = a.mock ? "" : S.statusStage;
    if (!a.retell) recordWordHistory(a, piece);   // word history needs word facts about the REFERENCE; retell has none
    S.emit();
  }

  async function recordWordHistory(a, piece) {
    try {
      if (!S.words.length) return;
      for (const w of S.words) {
        const outcome = wordOutcome(a, w.text, piece.spoken);
        if (outcome) api.words.history(w.id, { mode: store.settings.practiceMode.slice(0, 16), outcome }).catch(() => {});
      }
    } catch { /* best effort */ }
  }

  /* ------------------------------------------------------------------ coach audio queue (single <audio>) */
  function queueCoachAudio(run, url) {
    coachChain = coachChain.then(async () => {
      if (!alive(run) || store.settings.autoCoach === false) return;
      while (alive(run) && audio.getState() === "recording") await sleep(100);
      if (!alive(run)) return;
      S.coachPlaying = true; startTick("coach"); S.emit();
      try { await audio.play(url); }
      catch { if (alive(run)) S.notice = "Couldn't play the coach audio. The text is shown above."; }
      finally { S.coachPlaying = false; stopTick(); S.emit(); }
    });
  }
  S.stopCoach = () => { coachChain = Promise.resolve(); stopAudio(); S.emit(); };
  S.replayCoach = async () => {
    const run = runId;
    stopAudio();
    for (const c of S.coachAudio) { if (!c || !alive(run)) continue; S.coachPlaying = true; startTick("coach"); S.emit(); try { await audio.play(c.url); } catch { break; } }
    S.coachPlaying = false; stopTick(); S.emit();
  };

  /* ------------------------------------------------------------------ extra actions */
  /** "Hear it" — play the model voice for the current piece (not allowed while recording). */
  S.hearModel = async () => {
    if (!S.piece || machine.state === "listening" || machine.state === "processing") return;
    const run = runId;
    stopAudio();
    try { await playModel(S.piece, run); } catch (e) { if (alive(run)) { S.notice = e.network ? "Couldn't reach the coach voice. Check your connection." : "Couldn't play the model audio."; } }
    S.emit();
  };
  /** Play back the learner's own take (result state only). */
  S.playTake = async () => {
    if (!S.recording || !["result", "paused"].includes(machine.state) || machine.state === "paused") return;
    const run = runId;
    stopAudio();
    if (!machine.send("PLAY")) return;
    S.emit();
    try { startTick("take"); await audio.play(S.recording.blob); }
    catch { if (alive(run)) S.notice = "Couldn't play your recording back on this device."; }
    finally { stopTick(); if (alive(run)) machine.send("PLAY_END"); S.emit(); }
  };
  S.stopTake = () => { stopAudio(); if (machine.state === "playback") machine.send("PLAY_END"); S.emit(); };

  /** Fading: user wants an easier / harder cue right now. */
  S.setFade = (level) => {
    if (!S.cueFlow || !machine.can("RETRY")) return;
    S.fade = Math.max(1, Math.min(4, level));
    S.retry();
  };
  S.revealModel = () => S.hearModel();

  S.jumpTo = (chunkIdx) => {
    if (chunkIdx < 0 || chunkIdx >= S.chunks.length) return;
    abortFlow(); stopAudio(); cancelTake();
    S.chunkIdx = chunkIdx; S.pieceIdx = 0; persistProgress();
    if (S.sessionActive) { machine.send("NEXT") || machine.send("RETRY"); enterPrompting(); }
    S.emit();
  };

  /* ------------------------------------------------------------------ saved words */
  S.loadWords = async () => { try { S.words = await api.words.list(); S.words = Array.isArray(S.words) ? S.words : (S.words.words || []); S.wordsLoaded = true; } catch (e) { S.wordsError = e.message; } S.emit(); };
  S.saveWord = async ({ text, pinyin = "", meaning = "" }) => {
    const sourceChunk = S.piece ? S.piece.spoken : S.chunk ? S.chunk.spoken || "" : "";
    try { await api.words.add({ text, pinyin, meaning, sourceChunk: sourceChunk.slice(0, 200) }); S.saveMsg = `Saved “${text}”.`; await S.loadWords(); }
    catch (e) { S.saveMsg = e.message; S.emit(); }
  };
  /* ------------------------------------------------------------------ words to practise (rolling list, fed by the backend) */
  S.loadMissed = async () => {
    if (S.missedSupported === false) return;
    try { S.missed = await apiWords.missed.list(); S.missedSupported = true; S.missedError = ""; S.missedLoaded = true; }
    catch (e) { if (apiWords.isUnsupported(e)) { S.missedSupported = false; S.missed = []; } else if (!e.auth) S.missedError = e.message || "Couldn't load Words to practise."; }
    S.emit();
  };
  S.markKnown = async (id) => {
    const w = S.missed.find((x) => x.id === id); if (!w) return;
    try { await apiWords.missed.known(id); S.missed = S.missed.filter((x) => x.id !== id); S.missedUndo = { id, text: w.text }; S.missedError = ""; }
    catch (e) { S.missedError = e.message || "Couldn't update that word."; }
    S.emit();
  };
  S.undoKnown = async () => {
    const u = S.missedUndo; if (!u) return;
    S.missedUndo = null;
    try { await apiWords.missed.learning(u.id); } catch (e) { S.missedError = e.message || "Couldn't restore that word."; }
    await S.loadMissed();
  };
  S.removeWord = async (id) => { try { await api.words.remove(id); S.words = S.words.filter((w) => w.id !== id); } catch (e) { S.saveMsg = e.message; } S.emit(); };

  /* ------------------------------------------------------------------ audio events */
  /** Phone lock / incoming call / app switch / mic taken away: never pretend the take is fine. Pause with a clear message. */
  // Only called for a REAL, persisted interruption (audio.js debounces and ignores our own mic release / playback / session switches).
  // Pauses in place (chunk, piece and fade are kept) and, when the cause can end by itself, resumes automatically (S.onAudioBack).
  const MANUAL_PAUSE_MSG = "Paused: audio was interrupted (phone lock, a call, or switching apps) and couldn't restart by itself. Tap Resume to carry on from the same spot.";
  const AUTO_PAUSE_HINT = "Audio was interrupted. Carrying on by itself when it's back, or tap Resume.";
  S.interrupt = (info = {}) => {
    if (!S.sessionActive || machine.state === "paused") return;
    const wasListening = machine.state === "listening";
    S.pause("interrupted");
    if (machine.state !== "paused") { audio.recordEvent("session.interrupt", "ignored", `cannot pause from ${machine.state}`); return; }
    const recoverable = info.recoverable !== false;
    S.autoResumePending = recoverable;
    audio.recordEvent("session.interrupt", "REAL", `${info.source || "?"} while ${wasListening ? "listening (take discarded)" : "not recording"}; auto-resume ${recoverable ? "armed" : "off"}`);
    S.pauseReason = recoverable ? AUTO_PAUSE_HINT : MANUAL_PAUSE_MSG;
    S.emit();
  };
  /** The interruption ended (page visible again / audioSession active again / mic unmuted): resume by ourselves if we paused for it. */
  let autoTimer = null;
  S.onAudioBack = (info = {}) => {
    if (!S.autoResumePending || machine.state !== "paused") return;
    clearTimeout(autoTimer);
    // Short settle delay: iOS needs a moment after unlock/return before the mic can be reopened reliably.
    autoTimer = setTimeout(() => {
      if (!S.autoResumePending || machine.state !== "paused") return;
      S.resume({ auto: true });
    }, 400);
  };

  try {
    ensureInit();
    // (isInterrupted, info): true only for a persisted real interruption, false when it is over. The old handler ignored the boolean and
    // paused on BOTH, so the 'active' statechange iOS fires after our own mic release paused the session.
    audio.on("interrupted", (isInt, info) => (isInt ? S.interrupt(info) : S.onAudioBack(info)));
    audio.on("maxlength", () => {
      // Recording hit the safety cap: treat as a normal stop so the take can be assessed or discarded by `valid`.
      if (machine.state === "listening") S.stopRecording();
    });
    audio.on("error", (e) => {
      if (machine.state === "listening") {
        const me = micError(e instanceof Error ? e : new Error(String((e && e.message) || e)));
        S.error = { kind: "mic", action: "resume", message: me.message, code: me.code, retryable: true, canSkip: false };
        S.micArmed = false;
        abortFlow(); machine.send("PAUSE"); S.emit();
      }
    });
  } catch (e) { console.warn("audio init failed", e); }

  /* ------------------------------------------------------------------ boot with stored script */
  if (store.script && store.script.text) {
    S.parsed = parseScript(store.script.text);
    S.rebuild(store.progress.sentenceIndex || 0);
  }
  S.countChars = () => (store.script.text ? countScriptChars(store.script.text) : 0);
  S.MAX_PIECE_CHARS = MAX_PIECE_CHARS;
  return S;
}
