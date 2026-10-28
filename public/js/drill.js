// Trouble-word drill controller. Separate from the practice session (session.js) but uses the SAME audio path:
//   startAudioFromTap() (unlock + arm) in the tap, audio.play(blob) for model/coach audio, audio.startRecording()/stopRecording()
//   (only after playback has been stopped), markProcessing/markDone, releaseMic on Finish/leaving.
// States: idle | prompting (model audio) | ready (tap to record) | listening | processing | result | finished.
// The SERVER decides correctness and streak (done {correct, correctStreak, needed, graduated}); nothing is scored locally.
import * as api from "./api.js";
import * as apiWords from "./api-words.js";
import { audio, getAudioEl, ensureInit, startAudioFromTap, micError, MicError, RECORDING_PROBLEMS } from "./audio-io.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAttemptId = () => `drl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createDrill(S) {
  const subs = new Set();
  const D = {
    state: "idle", queue: [], idx: 0, mode: "all",             // mode: 'one' | 'all'
    result: null,       // {correct, correctStreak, needed, graduated}
    coachLines: [], coachAudio: [], coachPlaying: false,
    statusStage: "", error: null, notice: "", micArmed: false, recording: null, recStart: 0,
    stats: { words: new Set(), attempts: 0, correct: 0, graduated: [] , skipped: 0},
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { subs.forEach((fn) => { try { fn(D); } catch (e) { console.error(e); } }); },
    get active() { return !["idle", "finished"].includes(D.state); },
    get item() { return D.queue[D.idx] || null; },
  };

  let run = 0, ac = null, attemptId = null, coachChain = Promise.resolve(), discarding = Promise.resolve();
  const alive = (r) => r === run;
  const abortFlow = () => { run++; if (ac) { ac.abort(); ac = null; } coachChain = Promise.resolve(); };
  const stopAudio = () => { try { audio.stop(); } catch { /* ignore */ } D.coachPlaying = false; };
  const settings = () => S.store.settings;
  function resetWordState() { D.result = null; D.coachLines = []; D.coachAudio = []; D.statusStage = ""; D.error = null; D.notice = ""; attemptId = null; if (D.recording && D.recording.url) URL.revokeObjectURL(D.recording.url); D.recording = null; }

  async function discardTake() {
    if (audio.getState() === "recording") { try { await audio.stopRecording(); } catch { /* not recording */ } }
    try { audio.markDone(); } catch { /* ignore */ }
  }
  function releaseMic() { try { audio.releaseMic(); } catch { /* ignore */ } D.micArmed = false; }

  /** Tap handler entry: {wordId} for one word, or {all:true}. Unlock+arm must happen inside the user's tap, so no await before it. */
  D.start = async ({ wordId = null } = {}) => {
    if (S.sessionActive && S.state !== "paused") S.pause("Paused for a word drill. Tap Resume to carry on with your script.");
    abortFlow(); stopAudio();
    D.mode = wordId ? "one" : "all"; D.queue = []; D.idx = 0;
    D.stats = { words: new Set(), attempts: 0, correct: 0, graduated: [], skipped: 0 };
    resetWordState(); D.state = "prompting"; D.notice = "Loading…"; D.emit();
    const armed = startAudioFromTap().then(() => { D.micArmed = true; });
    try { await armed; }
    catch (e) { D.micArmed = false; const me = e instanceof MicError ? e : micError(e); D.queue = []; D.state = "ready"; D.notice = ""; D.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; D.emit(); await loadQueue(wordId); D.emit(); return; }
    await loadQueue(wordId);
    if (!D.queue.length) { D.state = "finished"; D.notice = ""; D.emit(); return; }
    D.emit();
    enterWord();
  };

  async function loadQueue(wordId) {
    try {
      if (wordId) {
        const w = S.missed.find((x) => x.id === wordId);
        D.queue = w ? [apiWords.normalizeDrillItem({ ...w, wordId: w.id })] : [];
      } else {
        try { D.queue = await apiWords.drill.next(5); }
        catch (e) { if (!apiWords.isUnsupported(e)) throw e; D.queue = S.missed.filter((w) => w.status === "learning").slice(0, 5).map((w) => apiWords.normalizeDrillItem({ ...w, wordId: w.id })); }
      }
    } catch (e) { D.queue = []; D.error = { kind: "load", action: "rerun", message: e.message || "Couldn't load the drill words.", canSkip: false }; }
    D.idx = 0;
  }

  /* model audio -> ready */
  async function enterWord() {
    abortFlow(); const r = run; ac = new AbortController();
    resetWordState(); D.state = "prompting"; D.emit();
    try {
      await discarding;
      if (!alive(r)) return;
      await playModel(r, D.item.promptText || D.item.text);
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      D.notice = e.network ? "Couldn't reach the coach voice. Read the word aloud, then tap Record." : "Couldn't play the model audio. Read the word aloud, then tap Record.";
    }
    if (!alive(r)) return;
    D.state = "ready"; D.emit();
  }
  async function playModel(r, text) {
    if (!text) return;
    let blob;
    try { blob = await api.tts(text, { voice: settings().voice, speed: settings().speed, signal: ac && ac.signal }); }
    catch (e) {
      if (e && e.name === "AbortError") return;
      if (e.status === 501 || e.code === "tts_not_configured") { D.notice = "The coach voice isn't set up on the server yet. Read the word aloud, then tap Record."; return; }
      throw e;
    }
    if (!alive(r)) return;
    D.coachPlaying = true; D.emit();
    try { await audio.play(blob); }
    catch { if (alive(r)) D.notice = "Couldn't play the model audio on this device. Read the word aloud, then tap Record."; }
    finally { D.coachPlaying = false; }
  }
  /** "Hear it" (word) / "Hear example" (sentence). Never while recording or processing. */
  D.hear = async (what = "word") => {
    if (!D.item || ["listening", "processing"].includes(D.state)) return;
    abortFlow(); const r = run; ac = new AbortController(); stopAudio();
    const text = what === "example" ? D.item.exampleSentence : (D.item.promptText || D.item.text);
    try { await playModel(r, text); } catch (e) { if (alive(r)) D.notice = "Couldn't play the model audio."; }
    D.emit();
  };

  /* record */
  D.record = async () => {
    if (!["prompting", "ready"].includes(D.state) || D.error && D.error.kind === "load") return;
    abortFlow(); const r = run; stopAudio();                 // never record while audio plays
    D.error = null; D.notice = ""; D.emit();
    try {
      await discarding;
      ensureInit();
      if (!D.micArmed) { await audio.unlock(); await audio.armMic(); D.micArmed = true; }
      await audio.startRecording();
    } catch (e) {
      if (!alive(r)) return;
      D.micArmed = false; const me = micError(e);
      D.state = "ready"; D.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; D.emit(); return;
    }
    if (!alive(r)) return;
    D.state = "listening"; D.recStart = performance.now(); D.emit();
  };

  D.stop = async () => {
    if (D.state !== "listening") return;
    const r = run;
    D.state = "processing"; D.statusStage = "uploading"; D.error = null; D.emit();
    let take;
    try { take = await audio.stopRecording(); }
    catch { if (!alive(r)) return; D.state = "ready"; D.error = { kind: "audio", action: "rerecord", message: "The recording failed. Tap Record to try again.", canSkip: true }; D.emit(); return; }
    if (!alive(r)) return;
    if (!take || !take.valid) {
      const reason = (take && take.reason) || "too_short";
      try { audio.markDone(); } catch { /* ignore */ }
      D.state = "ready"; D.statusStage = ""; D.error = { kind: "audio", action: "rerecord", message: RECORDING_PROBLEMS[reason] || `That recording wasn't usable (${reason}). Try again.`, canSkip: true }; D.emit(); return;
    }
    D.recording = { blob: take.blob, mime: take.mime, durationMs: take.durationMs, url: URL.createObjectURL(take.blob) };
    attemptId = newAttemptId();
    submit();
  };

  async function submit() {
    abortFlow(); const r = run; ac = new AbortController();
    const item = D.item; if (!item || !D.recording) return;
    D.state = "processing"; D.error = null; D.result = null; D.coachLines = []; D.coachAudio = []; D.emit();
    try { audio.markProcessing(); } catch { /* ignore */ }
    let terminalError = null, done = null;
    try {
      await apiWords.drill.attempt({
        blob: D.recording.blob, mime: D.recording.mime, wordId: item.wordId, attemptId, voice: settings().voice, speed: settings().speed, signal: ac.signal,
        onEvent: (name, data) => {
          if (!alive(r)) return;
          if (name === "status") D.statusStage = data && data.skipped ? D.statusStage : (data && data.stage) || D.statusStage;
          else if (name === "coach_text") D.coachLines[data.index] = { role: data.role || "", text: (D.coachLines[data.index]?.text || "") + (data.delta || ""), caption: data.caption || D.coachLines[data.index]?.caption || "" };
          else if (name === "coach_audio") { D.coachAudio[data.index] = { url: data.url, text: data.text }; queueCoachAudio(r, data.url); }
          else if (name === "done") done = data || {};
          else if (name === "error") terminalError = data || {};
          D.emit();
        },
      });
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      try { audio.markDone(); } catch { /* ignore */ }
      D.statusStage = ""; D.state = "ready";
      D.error = { kind: "upload", action: "reupload", message: e.message || "Upload failed.", canSkip: true }; D.emit(); return;
    }
    if (!alive(r)) return;
    try { audio.markDone(); } catch { /* ignore */ }
    D.statusStage = "";
    if (terminalError) {
      D.state = "ready";
      D.error = { kind: "assess", action: terminalError.retryable === false ? "rerecord" : "reupload", message: terminalError.message || "No result for that take.", canSkip: terminalError.canSkip !== false }; D.emit(); return;
    }
    if (!done || typeof done.correct !== "boolean") { D.state = "ready"; D.error = { kind: "assess", action: "reupload", message: "The server ended the response without a result.", canSkip: true }; D.emit(); return; }
    applyDone(done);
  }

  function applyDone(done) {
    const item = D.item;
    const streak = Number.isFinite(done.correctStreak) ? done.correctStreak : done.correct ? item.correctStreak + 1 : 0;
    const needed = Number.isFinite(done.needed) ? done.needed : item.needed;
    item.correctStreak = streak; item.needed = needed;
    // counted:false / reason:"low_match" = gated take (didn't sound like the target): not a pass, not a miss, streak unchanged
    const counted = done.counted !== false && done.reason !== "low_match";
    D.result = { correct: !!done.correct && counted, correctStreak: streak, needed, graduated: !!done.graduated, counted };
    if (counted) { D.stats.words.add(item.wordId); D.stats.attempts++; if (done.correct) D.stats.correct++; }
    if (done.graduated) {
      D.stats.graduated.push(item.text);
      S.missed = S.missed.filter((w) => w.id !== item.wordId);   // leaves the list at once; the refresh below confirms with the server
    } else { const w = S.missed.find((x) => x.id === item.wordId); if (w) { w.correctStreak = streak; w.needed = needed; if (!done.correct && counted) w.missCount++; } }
    D.state = "result"; D.emit();
    S.emit();
    S.loadMissed();
  }

  /** What the primary button does in 'result': graduated -> next word; otherwise another go at the same word. */
  D.resultAction = () => (D.result && D.result.graduated ? { kind: "next", label: D.idx + 1 >= D.queue.length && D.mode === "one" ? "Done" : "Next word" } : { kind: "again", label: D.result && D.result.correct ? "Say it again" : "Try again" });
  D.doResultAction = () => {
    if (D.state !== "result") return;
    if (D.resultAction().kind === "next") return advance(); 
    abortFlow(); stopAudio(); resetWordState(); D.state = "ready"; D.emit();
  };

  D.retry = async () => {
    if (!D.active || D.state === "processing") return;
    abortFlow(); stopAudio();
    discarding = discardTake();
    resetWordState(); D.state = "ready"; D.emit();
    await discarding; D.emit();
  };
  D.skip = () => { if (!D.active || D.state === "processing") return; abortFlow(); stopAudio(); discarding = discardTake(); D.stats.skipped++; advance(); };

  async function advance() {
    abortFlow(); stopAudio();
    D.idx++;
    if (D.idx >= D.queue.length) {
      if (D.mode === "all") {      // more words to drill? (graduated ones have left the server's list)
        try {
          const done = new Set(D.queue.map((q) => q.wordId));
          const more = (await apiWords.drill.next(5)).filter((q) => !done.has(q.wordId));
          if (more.length) { D.queue = more; D.idx = 0; return enterWord(); }
        } catch { /* fall through to finish */ }
      }
      return D.finish();
    }
    return enterWord();
  }

  D.finish = () => {
    if (D.state === "idle") return;
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    resetWordState(); D.state = "finished"; D.emit();
    S.loadMissed();
  };
  /** Leaving the drill screen: same as Finish but silent and back to idle. */
  D.leave = () => { if (D.state === "idle") return; if (D.active) { abortFlow(); stopAudio(); discarding = discardTake(); releaseMic(); } resetWordState(); D.state = "idle"; D.emit(); };

  D.errorAction = () => {
    const e = D.error; if (!e) return;
    if (e.action === "reupload" && D.recording) { D.error = null; D.state = "processing"; D.emit(); return submit(); }
    if (e.kind === "load") { D.error = null; return D.start({ wordId: D.mode === "one" && D.item ? D.item.wordId : null }); }
    D.error = null; D.emit();
    if (e.action === "resume") return D.record();
    D.state = "ready"; D.emit();
  };

  /* coach audio: queued through the single audio element; never while recording */
  function queueCoachAudio(r, url) {
    coachChain = coachChain.then(async () => {
      if (!alive(r) || settings().autoCoach === false) return;
      while (alive(r) && audio.getState() === "recording") await sleep(100);
      if (!alive(r)) return;
      D.coachPlaying = true; D.emit();
      try { await audio.play(url); } catch { /* text is shown anyway */ }
      finally { D.coachPlaying = false; D.emit(); }
    });
  }
  D.stopCoach = () => { coachChain = Promise.resolve(); stopAudio(); D.emit(); };
  D.replayCoach = async () => {
    const r = run; stopAudio();
    for (const c of D.coachAudio) { if (!c || !alive(r)) continue; D.coachPlaying = true; D.emit(); try { await audio.play(c.url); } catch { break; } }
    D.coachPlaying = false; D.emit();
  };

  /* interruptions (phone lock / call / app switch) -> discard the take, back to "tap to record" with a clear message */
  function interrupted() {
    if (!D.active || !["listening", "prompting"].includes(D.state)) return;
    const wasListening = D.state === "listening";
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    D.state = "ready";
    D.notice = wasListening ? "Your recording was interrupted (phone lock, a call, or switching apps) and discarded. Tap Record to go again." : "Audio was interrupted. Tap Record when you're ready.";
    D.emit();
  }
  try {
    ensureInit();
    audio.on("interrupted", interrupted);
    audio.on("maxlength", () => { if (D.state === "listening") D.stop(); });
    audio.on("error", (e) => {
      if (D.state === "listening") { const me = micError(e instanceof Error ? e : new Error(String((e && e.message) || e))); abortFlow(); D.micArmed = false; D.state = "ready"; D.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; D.emit(); }
    });
  } catch (e) { console.warn("drill audio init failed", e); }
  document.addEventListener("visibilitychange", () => { if (document.hidden && D.state === "listening") interrupted(); });

  return D;
}
