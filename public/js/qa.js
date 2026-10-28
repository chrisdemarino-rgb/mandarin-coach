// Q&A practice controller. Same audio path as drill.js / session.js: startAudioFromTap() (unlock + arm) inside the Start tap, audio.play(blob|url)
// for the question / model answer / coach audio, audio.startRecording()/stopRecording() only after playback has been stopped, markProcessing/markDone,
// releaseMic on Finish/leaving. audio.js and audio-io.js are NOT modified. All endpoint shapes live in api-qa.js.
// States: idle | loading | asking (question audio) | ready (tap to record) | listening | processing | result | finished.
import * as api from "./api.js";
import * as apiQa from "./api-qa.js";
import { countHanzi as hanCount } from "../shared/script.js";
import { audio, ensureInit, startAudioFromTap, micError, MicError, RECORDING_PROBLEMS } from "./audio-io.js";

const MIN_HANZI = 6;   // the backend refuses to ask about shorter chunks (chunks_too_short)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAttemptId = () => `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createQa(S) {
  const subs = new Set();
  const Q = {
    state: "idle", askedTexts: [], chunkIdx: 0, nextChunk: 0, loadFailed: false, chunkText: "", question: null, askedIds: [], number: 0,
    info: null, transcript: "", outcome: null, assessment: null,
    hintsShown: 0, answerShown: false, answerPlaying: false,
    coachLines: [], coachAudio: [], coachPlaying: false, questionPlaying: false,
    statusStage: "", error: null, notice: "", micArmed: false, recStart: 0, recording: null,
    records: [], unsupported: false,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { subs.forEach((fn) => { try { fn(Q); } catch (e) { console.error(e); } }); },
    get active() { return !["idle", "finished"].includes(Q.state); },
    get rec() { return Q.records[Q.records.length - 1] || null; },
    get hints() { return apiQa.hintsFor(Q.question, Q.chunkText); },
    get answer() { return apiQa.answerFor(Q.question, Q.info, Q.chunkText); },
    get summary() { return apiQa.summarize(Q.records); },
  };

  let run = 0, ac = null, attemptId = null, coachChain = Promise.resolve(), discarding = Promise.resolve();
  const alive = (r) => r === run;
  const abortFlow = () => { run++; if (ac) { ac.abort(); ac = null; } coachChain = Promise.resolve(); };
  const stopAudio = () => { try { audio.stop(); } catch { /* ignore */ } Q.coachPlaying = false; Q.questionPlaying = false; Q.answerPlaying = false; };
  const settings = () => S.store.settings;
  function resetAttempt() {
    Q.info = null; Q.transcript = ""; Q.outcome = null; Q.assessment = null; Q.coachLines = []; Q.coachAudio = []; Q.statusStage = ""; Q.error = null; Q.notice = ""; attemptId = null;
    if (Q.recording && Q.recording.url) URL.revokeObjectURL(Q.recording.url); Q.recording = null;
  }
  function resetQuestion() { resetAttempt(); Q.hintsShown = 0; Q.answerShown = false; }
  async function discardTake() {
    if (audio.getState() === "recording") { try { await audio.stopRecording(); } catch { /* not recording */ } }
    try { audio.markDone(); } catch { /* ignore */ }
  }
  function releaseMic() { try { audio.releaseMic(); } catch { /* ignore */ } Q.micArmed = false; }
  const scriptChunkText = (i) => { const c = S.chunks[i]; return c ? c.pieces.map((p) => p.spoken).join("") : ""; };

  /** Tap handler entry. Unlock+arm must happen inside the user's tap, so no await before it. */
  Q.start = async () => {
    if (!S.chunks.length) return;
    if (S.sessionActive && S.state !== "paused") S.pause("Paused for Q&A. Tap Resume to carry on with your script.");
    abortFlow(); stopAudio();
    Q.records = []; Q.askedIds = []; Q.askedTexts = []; Q.number = 0; Q.unsupported = false; Q.chunkIdx = Math.min(S.chunkIdx, S.chunks.length - 1); Q.nextChunk = Q.chunkIdx; Q.loadFailed = false; Q.chunkText = scriptChunkText(Q.chunkIdx);
    Q.question = null; resetQuestion(); Q.state = "loading"; Q.notice = "Getting a question…"; Q.emit();
    const armed = startAudioFromTap().then(() => { Q.micArmed = true; });
    try { await armed; }
    catch (e) { Q.micArmed = false; const me = e instanceof MicError ? e : micError(e); Q.state = "ready"; Q.question = null; Q.notice = ""; Q.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; Q.emit(); return; }
    await loadNext();
  };

  /** Walk the script chunk by chunk, ONE question per chunk (the backend has no "exhausted" signal). Chunks with < 6 hanzi can't be asked about and are skipped. At the end -> finished. */
  async function loadNext() {
    abortFlow(); const r = run; ac = new AbortController();
    Q.state = "loading"; Q.notice = "Getting a question…"; Q.error = null; Q.emit();
    for (let hops = 0; hops < 200; hops++) {
      const idx = Q.nextChunk;
      if (idx >= S.chunks.length) return Q.finish();
      const text = scriptChunkText(idx);
      if (hanCount(text) < MIN_HANZI) { Q.nextChunk++; continue; }
      let q;
      try { q = await apiQa.qa.next({ chunks: apiQa.chunkWindow(S.chunks.map((_, i) => scriptChunkText(i)), idx), avoid: Q.askedTexts }); }
      catch (e) {
        if (!alive(r) || (e && e.name === "AbortError")) return;
        if (apiQa.isUnsupported(e)) { Q.unsupported = true; Q.state = "finished"; Q.notice = ""; Q.emit(); return; }
        if (e && e.code === "chunks_too_short") { Q.nextChunk++; continue; }
        const er = apiQa.qaErrorOf(e);
        Q.loadFailed = true; Q.state = "ready"; Q.notice = "";
        Q.error = { kind: "load", action: "rerun", message: er.message.replace(/^No assessment obtained: /, "") || "Couldn't get a question.", canSkip: true }; Q.emit(); return;
      }
      if (!alive(r)) return;
      Q.loadFailed = false; Q.chunkIdx = idx; Q.chunkText = text; Q.nextChunk = idx + 1;
      Q.question = q; Q.askedIds = [...Q.askedIds, q.id]; Q.askedTexts = [...Q.askedTexts, q.text]; Q.number++;
      Q.records.push({ id: q.id, attempts: 0, info: null, hints: 0, answerShown: false, skipped: false });
      return enterQuestion();
    }
    Q.finish();
  }

  /** Speak the question, then wait for the learner (never record while audio plays). */
  async function enterQuestion() {
    abortFlow(); const r = run; ac = new AbortController();
    resetQuestion(); Q.notice = ""; Q.state = "asking"; Q.emit();
    try { await discarding; if (!alive(r)) return; await playText(r, Q.question.text, "questionPlaying"); }
    catch (e) { if (!alive(r) || (e && e.name === "AbortError")) return; Q.notice = e.network ? "Couldn't reach the coach voice. Read the question, then tap Record." : "Couldn't play the question audio. Read the question, then tap Record."; }
    if (!alive(r)) return;
    Q.state = "ready"; Q.emit();
  }
  async function playText(r, text, flag) {
    if (!text) return;
    let blob;
    try { blob = await api.tts(text, { voice: settings().voice, speed: settings().speed, signal: ac && ac.signal }); }
    catch (e) {
      if (e && e.name === "AbortError") return;
      if (e.status === 501 || e.code === "tts_not_configured") { Q.notice = "The coach voice isn't set up on the server yet. Read the text, then tap Record."; return; }
      throw e;
    }
    if (!alive(r)) return;
    Q[flag] = true; Q.emit();
    try { await audio.play(blob); }
    catch { if (alive(r)) Q.notice = "Couldn't play the audio on this device. Read the text instead."; }
    finally { Q[flag] = false; }
  }
  /** Replay the question. Never while recording or processing. */
  Q.hear = async () => {
    if (!Q.question || ["listening", "processing", "loading"].includes(Q.state)) return;
    abortFlow(); const r = run; ac = new AbortController(); stopAudio();
    try { await playText(r, Q.question.text, "questionPlaying"); } catch { if (alive(r)) Q.notice = "Couldn't play the question."; }
    Q.emit();
  };

  /* hints / answer: allowed before and after an attempt, never while recording/processing. Usage is counted per question. */
  Q.hint = () => {
    if (!["ready", "result", "asking"].includes(Q.state) || !Q.question) return;
    if (Q.hintsShown >= Q.hints.length) return;
    Q.hintsShown++; if (Q.rec) Q.rec.hints = Math.max(Q.rec.hints, Q.hintsShown); Q.emit();
  };
  Q.showAnswer = () => {
    if (!["ready", "result", "asking"].includes(Q.state) || !Q.question || Q.answerShown) return;
    Q.answerShown = true; if (Q.rec) Q.rec.answerShown = true; Q.emit();
  };
  Q.hearAnswer = async () => {
    const a = Q.answer; if (!a || !Q.answerShown || ["listening", "processing"].includes(Q.state)) return;
    abortFlow(); const r = run; ac = new AbortController(); stopAudio();
    try { await playText(r, a.text, "answerPlaying"); } catch { if (alive(r)) Q.notice = "Couldn't play the answer audio."; }
    Q.answerPlaying = false; Q.emit();
  };

  /* record */
  Q.record = async () => {
    if (!["asking", "ready"].includes(Q.state) || !Q.question) return;
    abortFlow(); const r = run; stopAudio();                 // never record while audio plays
    Q.error = null; Q.notice = ""; Q.emit();
    try {
      await discarding; ensureInit();
      if (!Q.micArmed) { await audio.unlock(); await audio.armMic(); Q.micArmed = true; }
      await audio.startRecording();
    } catch (e) {
      if (!alive(r)) return;
      Q.micArmed = false; const me = micError(e);
      Q.state = "ready"; Q.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; Q.emit(); return;
    }
    if (!alive(r)) return;
    resetAttempt();
    Q.state = "listening"; Q.recStart = performance.now(); Q.emit();
  };

  Q.stop = async () => {
    if (Q.state !== "listening") return;
    const r = run;
    Q.state = "processing"; Q.statusStage = "uploading"; Q.error = null; Q.emit();
    let take;
    try { take = await audio.stopRecording(); }
    catch { if (!alive(r)) return; Q.state = "ready"; Q.error = { kind: "audio", action: "rerecord", message: "The recording failed. Tap Record to try again.", canSkip: true }; Q.emit(); return; }
    if (!alive(r)) return;
    if (!take || !take.valid) {
      const reason = (take && take.reason) || "too_short";
      try { audio.markDone(); } catch { /* ignore */ }
      Q.state = "ready"; Q.statusStage = ""; Q.error = { kind: "audio", action: "rerecord", message: RECORDING_PROBLEMS[reason] || `That recording wasn't usable (${reason}). Try again.`, canSkip: true }; Q.emit(); return;
    }
    Q.recording = { blob: take.blob, mime: take.mime, durationMs: take.durationMs, url: URL.createObjectURL(take.blob) };
    attemptId = newAttemptId();
    submit();
  };

  async function submit() {
    abortFlow(); const r = run; ac = new AbortController();
    const q = Q.question; if (!q || !Q.recording) return;
    Q.state = "processing"; Q.error = null; Q.info = null; Q.outcome = null; Q.coachLines = []; Q.coachAudio = []; Q.emit();
    try { audio.markProcessing(); } catch { /* ignore */ }
    let terminalError = null, assessment = null;
    try {
      await apiQa.qa.attempt({
        blob: Q.recording.blob, mime: Q.recording.mime, question: q, attemptId, voice: settings().voice, speed: settings().speed, signal: ac.signal,
        onEvent: (name, data) => {
          if (!alive(r)) return;
          data = data || {};
          if (name === "status") Q.statusStage = data.skipped ? Q.statusStage : data.stage || Q.statusStage;
          else if (name === "assessment") assessment = data;
          else if (name === "coach_text") Q.coachLines[data.index] = { role: data.role || "", text: (Q.coachLines[data.index]?.text || "") + (data.delta || ""), caption: data.caption || Q.coachLines[data.index]?.caption || "" };
          else if (name === "coach_audio") { Q.coachAudio[data.index] = { url: data.url, text: data.text }; queueCoachAudio(r, data.url); }
          else if (name === "error") terminalError = data;
          Q.emit();
        },
      });
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      try { audio.markDone(); } catch { /* ignore */ }
      if (!assessment) {   // nothing usable arrived: retry re-sends the same take with the same attemptId
        Q.statusStage = ""; Q.state = "ready";
        Q.error = { kind: "upload", action: "reupload", message: `No assessment obtained: ${e.message || "upload failed."}`, canSkip: true }; Q.emit(); return;
      }
    }
    if (!alive(r)) return;
    try { audio.markDone(); } catch { /* ignore */ }
    Q.statusStage = "";
    if (terminalError && !assessment) {
      const er = apiQa.qaErrorOf(terminalError);
      Q.state = "ready"; Q.error = { kind: "assess", action: er.retryable && !["no_speech_detected", "qa_answer_too_long"].includes(er.code) ? "reupload" : "rerecord", message: er.message, retryable: er.retryable, canSkip: terminalError.canSkip !== false }; Q.emit(); return;
    }
    if (!assessment) { Q.state = "ready"; Q.error = { kind: "assess", action: "reupload", message: "No assessment obtained: the server ended the response without a result.", canSkip: true }; Q.emit(); return; }
    applyAssessment(assessment);
  }

  function applyAssessment(a) {
    const info = apiQa.normalizeQaBlock(a.qa, Q.chunkText, a.transcript);
    Q.assessment = a; Q.info = info; Q.transcript = (info && info.transcript) || (typeof a.transcript === "string" ? a.transcript.trim() : "");
    Q.outcome = apiQa.qaOutcome(info);
    const rec = Q.rec;
    if (rec) { rec.attempts++; rec.info = info; rec.hints = Math.max(rec.hints, Q.hintsShown); rec.answerShown = rec.answerShown || Q.answerShown; }
    Q.state = "result"; Q.emit();
  }

  /** Primary button in 'result': next question. */
  Q.next = () => {
    if (Q.state !== "result" && Q.state !== "ready") return;
    abortFlow(); stopAudio(); discarding = discardTake();
    if (Q.loadFailed) { Q.nextChunk++; Q.loadFailed = false; }   // skipping from a failed question request moves on to the next part of the script
    else if (Q.rec && Q.rec.attempts === 0) Q.rec.skipped = true;
    return loadNext();
  };
  Q.skip = () => { if (!Q.active || ["processing", "loading"].includes(Q.state)) return; Q.next(); };
  /** Same question again (hints/answer-shown stay counted). */
  Q.retry = async () => {
    if (!Q.active || ["processing", "loading"].includes(Q.state) || !Q.question) return;
    abortFlow(); stopAudio(); discarding = discardTake();
    resetAttempt(); Q.state = "ready"; Q.emit();
    await discarding; Q.emit();
  };
  Q.finish = () => {
    if (Q.state === "idle") return;
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    resetAttempt(); Q.state = "finished"; Q.emit();
  };
  /** Leaving the Q&A screen: same as Finish but silent and back to idle. */
  Q.leave = () => { if (Q.state === "idle") return; if (Q.active) { abortFlow(); stopAudio(); discarding = discardTake(); releaseMic(); } resetAttempt(); Q.question = null; Q.state = "idle"; Q.emit(); };

  Q.errorAction = () => {
    const e = Q.error; if (!e) return;
    if (e.action === "reupload" && Q.recording) { Q.error = null; Q.state = "processing"; Q.emit(); return submit(); }
    if (e.kind === "load") { Q.error = null; return loadNext(); }
    Q.error = null; Q.emit();
    if (e.action === "resume") return Q.record();
    Q.state = "ready"; Q.emit();
  };

  /* coach audio: queued through the single audio element; never while recording */
  function queueCoachAudio(r, url) {
    coachChain = coachChain.then(async () => {
      if (!alive(r) || settings().autoCoach === false) return;
      while (alive(r) && audio.getState() === "recording") await sleep(100);
      if (!alive(r)) return;
      Q.coachPlaying = true; Q.emit();
      try { await audio.play(url); } catch { /* the text is shown anyway */ }
      finally { Q.coachPlaying = false; Q.emit(); }
    });
  }
  Q.stopCoach = () => { coachChain = Promise.resolve(); stopAudio(); Q.emit(); };
  Q.replayCoach = async () => {
    const r = run; stopAudio();
    for (const c of Q.coachAudio) { if (!c || !alive(r)) continue; Q.coachPlaying = true; Q.emit(); try { await audio.play(c.url); } catch { break; } }
    Q.coachPlaying = false; Q.emit();
  };

  /* interruptions (phone lock / call / app switch): discard the take, back to "tap to record" with a clear message (same as drill.js) */
  function interrupted() {
    if (!Q.active || !["listening", "asking"].includes(Q.state)) return;
    const wasListening = Q.state === "listening";
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    Q.state = "ready";
    Q.notice = wasListening ? "Your recording was interrupted (phone lock, a call, or switching apps) and discarded. Tap Record to go again." : "Audio was interrupted. Tap Record when you're ready.";
    Q.emit();
  }
  try {
    ensureInit();
    audio.on("interrupted", (isInt) => { if (isInt) interrupted(); });
    audio.on("maxlength", () => { if (Q.state === "listening") Q.stop(); });
    audio.on("error", (e) => {
      if (Q.state === "listening") { const me = micError(e instanceof Error ? e : new Error(String((e && e.message) || e))); abortFlow(); Q.micArmed = false; Q.state = "ready"; Q.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; Q.emit(); }
    });
  } catch (e) { console.warn("qa audio init failed", e); }

  return Q;
}
