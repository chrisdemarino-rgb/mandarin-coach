// Free talk controller: a spoken conversation with the coach about a topic. Same audio path as qa.js / drill.js: startAudioFromTap() (unlock + arm) inside the
// Start tap, audio.play(url) for coach audio, audio.startRecording()/stopRecording() only after playback has been stopped, markProcessing/markDone,
// releaseMic on Finish / leaving. audio.js and audio-io.js are NOT modified. ALL endpoint shapes live in api-talk.js.
// The conversation lives in memory ONLY (T.turns): nothing goes to localStorage or the server except what the learner explicitly saves (Save word).
// Each user turn keeps its take (Blob) in memory for "Hear my recording" (hear-mine.js); takes are dropped at Finish / leaving / a cap of MAX_TAKES, never re-uploaded
// except a failed turn's retry (same attemptId).
// States: idle | ready (your turn) | listening | processing | paused | finishing (summary request) | finished.
import * as apiTalk from "./api-talk.js";
import * as player from "./tts-player.js";
import { audio, ensureInit, startAudioFromTap, micError, MicError, RECORDING_PROBLEMS } from "./audio-io.js";

const MAX_TAKES = 12;   // newest user takes kept for "Hear my recording"; older ones are dropped (their button disappears)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function createTalk(S) {
  const subs = new Set();
  const T = {
    state: "idle", turns: [], topic: "", error: null, notice: "", statusStage: "", micArmed: false, recStart: 0, unsupported: false,
    vocab: [], summary: null, summaryState: "idle", summaryError: "", coachPlaying: false, playingTurnId: "", turnCount: 0, betterTurnId: "", betterPhase: "idle",
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { subs.forEach((fn) => { try { fn(T); } catch (e) { console.error(e); } }); },
    get active() { return !["idle", "finished"].includes(T.state); },
    get busy() { return ["listening", "processing", "finishing"].includes(T.state); },
    get userTurns() { return T.turns.filter((t) => t.role === "user"); },
  };

  let run = 0, ac = null, coachChain = Promise.resolve(), discarding = Promise.resolve();
  const alive = (r) => r === run;
  const abortFlow = () => { run++; if (ac) { ac.abort(); ac = null; } coachChain = Promise.resolve(); };
  const stopAudio = () => { try { audio.stop(); } catch { /* ignore */ } T.coachPlaying = false; T.playingTurnId = ""; if (T.betterPhase !== "error") T.betterPhase = "idle"; };
  const settings = () => S.store.settings;
  async function discardTake() {
    if (audio.getState() === "recording") { try { await audio.stopRecording(); } catch { /* not recording */ } }
    try { audio.markDone(); } catch { /* ignore */ }
  }
  function releaseMic() { try { audio.releaseMic(); } catch { /* ignore */ } T.micArmed = false; }
  /** Forget every take (the Blobs become garbage; hear-mine owns no URL of its own after playback ends). */
  function dropTakes() { T.turns.forEach((t) => { t.take = null; }); }
  function trimTakes() { const withTake = T.turns.filter((t) => t.take); withTake.slice(0, Math.max(0, withTake.length - MAX_TAKES)).forEach((t) => { t.take = null; }); }
  function resetAll() { dropTakes(); T.turns = []; T.error = null; T.notice = ""; T.statusStage = ""; T.unsupported = false; T.summary = null; T.summaryState = "idle"; T.summaryError = ""; T.turnCount = 0; }

  T.setTopic = (t) => { T.topic = apiTalk.cleanTopic(t); };

  /** Tap handler entry. Unlock + arm must happen inside the user's tap, so no await before it. */
  T.start = async () => {
    if (S.sessionActive && S.state !== "paused") S.pause("Paused for Free talk. Tap Resume to carry on with your script.");
    abortFlow(); stopAudio(); discarding = discardTake(); resetAll();
    T.state = "processing"; T.statusStage = "opening"; T.emit();   // arming the mic + the coach's opening
    const r = run;
    T.vocab = apiTalk.scriptVocabOf(S.store.script && S.store.script.text);
    T.script = apiTalk.scriptForTalk(S.store.script && S.store.script.text); T.scriptTooLong = apiTalk.scriptTooLongForTalk(S.store.script && S.store.script.text);
    const armed = startAudioFromTap().then(() => { T.micArmed = true; });
    try { await armed; }
    catch (e) { if (!alive(r)) return; T.micArmed = false; const me = e instanceof MicError ? e : micError(e); T.state = "ready"; T.statusStage = ""; T.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; T.emit(); return; }
    if (alive(r)) await opening(r);
  };

  /** The coach speaks first: POST /api/talk/opening (text + audio). Any failure except "not available" just means you start the conversation yourself. */
  async function opening(r) {
    ac = new AbortController(); T.state = "processing"; T.statusStage = "opening"; T.emit();
    try {
      const o = await apiTalk.talk.opening({ topic: T.topic, scriptVocab: T.vocab, script: T.script, voice: settings().voice, speed: settings().speed, signal: ac.signal });
      if (!alive(r)) return;
      T.statusStage = "";
      if (!o.textZh) throw new Error("empty opening");
      const coach = { id: newId("c"), role: "coach", text: o.textZh, pinyin: o.pinyin, lines: [{ text: o.textZh, pinyin: o.pinyin, role: "opening" }], tipText: "", correction: null, suggested: [], status: "ok", audio: [] };
      T.turns.push(coach);
      if (o.audioUrl) { coach.audio[0] = { url: o.audioUrl, text: o.textZh }; queueCoachAudio(r, coach, o.audioUrl); }
      T.scriptUsed = !!o.scriptUsed;
      T.state = "ready"; if (T.scriptTooLong) T.notice = "Your script is over 3,000 characters, so the coach isn't using it. Shorten it on the Script tab for script-based coaching."; T.emit();
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      T.statusStage = "";
      if (e && (e.code === "script_too_long" || e.code === "invalid_context")) { T.state = "ready"; T.notice = apiTalk.talkErrorOf(e).message.replace(/^No assessment obtained: /, ""); T.emit(); return; }
      if (apiTalk.isUnsupported(e)) { T.unsupported = true; T.state = "finished"; releaseMic(); T.emit(); return; }
      T.state = "ready"; T.notice = "The coach couldn't start the conversation. Tap Record and start talking about the topic."; T.emit();
    }
  }

  /* ------------------------------------------------------------ record */
  T.record = async () => {
    if (T.state !== "ready") return;
    abortFlow(); const r = run; stopAudio();                 // never record while audio plays
    T.error = null; T.notice = ""; T.emit();
    try {
      await discarding; ensureInit();
      if (!T.micArmed) { await audio.unlock(); await audio.armMic(); T.micArmed = true; }
      await audio.startRecording();
    } catch (e) {
      if (!alive(r)) return;
      T.micArmed = false; const me = micError(e);
      T.state = "ready"; T.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; T.emit(); return;
    }
    if (!alive(r)) return;
    T.state = "listening"; T.recStart = performance.now(); T.emit();
  };

  T.stop = async () => {
    if (T.state !== "listening") return;
    const r = run;
    T.state = "processing"; T.statusStage = "uploading"; T.error = null; T.emit();
    let take;
    try { take = await audio.stopRecording(); }
    catch { if (!alive(r)) return; T.state = "ready"; T.error = { kind: "audio", action: "rerecord", message: "The recording failed. Tap Record to try again.", canSkip: false }; T.emit(); return; }
    if (!alive(r)) return;
    if (!take || !take.valid) {
      const reason = (take && take.reason) || "too_short";
      try { audio.markDone(); } catch { /* ignore */ }
      T.state = "ready"; T.statusStage = ""; T.error = { kind: "audio", action: "rerecord", message: RECORDING_PROBLEMS[reason] || `That recording wasn't usable (${reason}). Try again.`, canSkip: false }; T.emit(); return;
    }
    const turn = { id: newId("u"), role: "user", text: "", pinyin: "", status: "pending", take: { blob: take.blob, mime: take.mime, durationMs: take.durationMs }, attemptId: newId("talk"), acoustic: null };
    T.turns.push(turn); T.turnCount++; trimTakes();
    submit(turn);
  };

  /* ------------------------------------------------------------ one turn: upload -> transcript -> coach reply */
  async function submit(turn) {
    abortFlow(); const r = run; ac = new AbortController();
    T.state = "processing"; T.error = null; T.notice = ""; T.emit();
    // everything after this turn in the list (a half-finished reply from an earlier try) is discarded
    const at = T.turns.indexOf(turn); if (at >= 0) T.turns.length = at + 1;
    turn.text = ""; turn.status = "pending"; turn.acoustic = null;
    const history = apiTalk.historyFor(T.turns.slice(0, at >= 0 ? at : T.turns.length));
    let coach = null, heard = null, terminalError = null, doneEv = null;
    const coachTurn = () => { if (!coach) { coach = { id: newId("c"), role: "coach", text: "", pinyin: "", lines: [], tipText: "", correction: null, suggested: [], status: "pending", audio: [] }; T.turns.push(coach); } return coach; };
    const syncCoach = () => {   // wording-tip sentences (correction + model) are shown in the tip box; everything else is the conversation reply
      const ls = coach.lines.filter(Boolean), main = ls.filter((l) => !apiTalk.isTipRole(l.role)), tip = ls.filter((l) => apiTalk.isTipRole(l.role));
      coach.text = main.map((l) => l.text).filter(Boolean).join(""); coach.pinyin = main.map((l) => l.pinyin).filter(Boolean).join(" "); coach.tipText = tip.map((l) => l.text).filter(Boolean).join("");
    };
    try { audio.markProcessing(); } catch { /* ignore */ }
    try {
      await apiTalk.talk.turn({
        blob: turn.take.blob, mime: turn.take.mime, topic: T.topic, history, scriptVocab: T.vocab, script: T.script, attemptId: turn.attemptId, voice: settings().voice, speed: settings().speed, signal: ac.signal,
        onEvent: (name, data) => {
          if (!alive(r)) return;
          const ev = apiTalk.readEvent(name, data);
          if (ev.kind === "status") T.statusStage = ev.skipped ? T.statusStage : ev.stage || T.statusStage;
          else if (ev.kind === "transcript") { heard = ev; turn.text = ev.noSpeech ? "" : ev.transcript; turn.acoustic = ev.acoustic; }
          else if (ev.kind === "coach_text") {
            coachTurn(); const l = coach.lines[ev.index] || (coach.lines[ev.index] = { text: "", pinyin: "", role: ev.role });
            l.text = ev.replace ? ev.text : l.text + ev.text; if (ev.pinyin) l.pinyin = ev.pinyin; if (ev.role) l.role = ev.role; syncCoach();
          }
          else if (ev.kind === "coach_audio") { coachTurn(); coach.audio[ev.index] = { url: ev.url, text: ev.text }; queueCoachAudio(r, coach, ev.url); }
          else if (ev.kind === "error") terminalError = ev;
          else if (ev.kind === "done") doneEv = ev;
          T.emit();
        },
      });
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      try { audio.markDone(); } catch { /* ignore */ }
      if (apiTalk.isUnsupported(e)) { T.turns = T.turns.filter((t) => t !== turn && t !== coach); T.unsupported = true; T.state = "finished"; T.statusStage = ""; dropTakes(); T.emit(); return; }
      if (!heard) {   // nothing usable arrived: retry re-sends the same take with the same attemptId
        T.statusStage = ""; T.state = "ready";
        T.error = { kind: "upload", action: "reupload", message: `No assessment obtained: ${e.message || "upload failed."}`, canSkip: true, turnId: turn.id }; T.emit(); return;
      }
    }
    if (!alive(r)) return;
    try { audio.markDone(); } catch { /* ignore */ }
    T.statusStage = "";
    if (doneEv) {   // fields the backend may only send in `done`
      if (!turn.text && doneEv.transcript && !(heard && heard.noSpeech) && !doneEv.gate) turn.text = doneEv.transcript;
      if (!turn.acoustic && doneEv.acoustic) turn.acoustic = doneEv.acoustic;
      const reply = doneEv.coachText || [doneEv.replyZh, doneEv.questionZh].filter(Boolean).join("");
      if (reply && !(coach && coach.text) && !doneEv.gate) { coachTurn(); coach.lines = [{ text: reply, pinyin: doneEv.coachPinyin || [doneEv.replyPinyin, doneEv.questionPinyin].filter(Boolean).join(" "), role: "reply" }]; syncCoach(); }
      else if (coach && !coach.pinyin && (doneEv.replyPinyin || doneEv.questionPinyin)) coach.pinyin = [doneEv.replyPinyin, doneEv.questionPinyin].filter(Boolean).join(" ");
      if (coach && !doneEv.gate) { coach.correction = doneEv.correction; coach.suggested = doneEv.suggested; coach.upgrade = doneEv.upgrade || null; coach.upgradeStatus = doneEv.upgradeStatus || "none"; coach.onTopic = doneEv.onTopic === undefined ? null : doneEv.onTopic; coach.saveable = doneEv.saveable || []; }
    }
    const realErr = terminalError && terminalError.code && !["no_speech_detected", "no_speech", "gated"].includes(terminalError.code);
    if (realErr && !turn.text && !doneEv) {   // e.g. transcription failed: the take is still good, so keep it and offer Try again / Skip (same attemptId)
      if (coach) { T.turns = T.turns.filter((t) => t !== coach); coach = null; }
      const er = apiTalk.talkErrorOf(terminalError);
      turn.status = "pending"; T.state = "ready"; T.error = { kind: "assess", action: er.action, message: er.message, canSkip: er.canSkip, turnId: turn.id, retryable: er.retryable }; T.emit(); return;
    }
    const noSpeech = !turn.text || (heard && heard.noSpeech) || !!(doneEv && doneEv.gate);
    if (noSpeech) {   // nothing was heard: drop this turn (and any reply) and ask for a new take
      T.turns = T.turns.filter((t) => t !== turn && t !== coach); turn.take = null;
      const er = terminalError && terminalError.code && !["no_speech_detected", "no_speech", "gated"].includes(terminalError.code) ? apiTalk.talkErrorOf(terminalError) : apiTalk.noSpeechError();
      T.state = "ready"; T.error = { kind: "assess", action: er.action, message: er.message, canSkip: false }; T.emit(); return;
    }
    turn.status = "ok";
    if (terminalError && !(coach && coach.text)) {   // heard, but the coach could not reply: keep what was heard, offer Try again / Skip
      if (coach) { T.turns = T.turns.filter((t) => t !== coach); coach = null; }
      const er = apiTalk.talkErrorOf(terminalError);
      turn.status = "pending"; T.state = "ready"; T.error = { kind: "assess", action: "reupload", message: er.message, canSkip: er.canSkip, turnId: turn.id, retryable: er.retryable }; T.emit(); return;
    }
    if (coach && coach.text) coach.status = "ok";
    else { if (coach) T.turns = T.turns.filter((t) => t !== coach); T.notice = "The coach didn't send a reply to that. Tap Record to carry on."; }
    T.state = "ready"; T.emit();
  }

  /* ------------------------------------------------------------ errors */
  T.errorAction = () => {
    const e = T.error; if (!e) return;
    if (e.action === "reupload") { const turn = T.turns.find((t) => t.id === e.turnId) || [...T.turns].reverse().find((t) => t.role === "user" && t.take); if (turn && turn.take) { T.error = null; return submit(turn); } }
    T.error = null; T.emit();
    if (e.action === "resume") return T.record();
  };
  /** Skip the failed turn: it is dropped from the conversation (and its take with it). */
  T.skipTurn = () => {
    const e = T.error; if (!e) return;
    const turn = T.turns.find((t) => t.id === e.turnId);
    if (turn) { turn.take = null; T.turns = T.turns.filter((t) => t !== turn); }
    T.error = null; T.state = "ready"; T.emit();
  };

  /* ------------------------------------------------------------ coach audio: queued through the one audio element; never while recording */
  function queueCoachAudio(r, turn, url) {
    coachChain = coachChain.then(async () => {
      if (!alive(r) || settings().autoCoach === false) return;
      while (alive(r) && audio.getState() === "recording") await sleep(100);
      if (!alive(r)) return;
      T.coachPlaying = true; T.playingTurnId = turn.id; T.emit();
      try { await audio.play(url); } catch { /* the text is shown anyway */ }
      finally { if (alive(r)) { T.coachPlaying = false; T.playingTurnId = ""; T.emit(); } }
    });
  }
  T.stopCoach = () => { coachChain = Promise.resolve(); stopAudio(); T.emit(); };
  /** Replay one coach reply (Stop toggle when it is the one playing). Never while recording / uploading. */
  T.replay = async (turnId) => {
    if (["listening", "processing", "finishing"].includes(T.state)) return;
    if (T.coachPlaying && T.playingTurnId === turnId) return T.stopCoach();
    const turn = T.turns.find((t) => t.id === turnId); if (!turn || !turn.audio.some(Boolean)) return;
    const r = ++run; coachChain = Promise.resolve(); stopAudio();
    T.coachPlaying = true; T.playingTurnId = turnId; T.emit();
    for (const c of turn.audio) { if (!c || !alive(r)) break; try { await audio.play(c.url); } catch { break; } }
    if (alive(r)) { T.coachPlaying = false; T.playingTurnId = ""; T.emit(); }
  };
  /** "Hear better version": POST /api/tts {text: better} through the shared <audio> (tts-player.js), primed inside the tap like Hear answer.
   *  Must be called synchronously from the tap handler (no await before player.speak). Never while recording/processing; Stop toggle. */
  let ttsOff = false;
  T.hearBetter = async (turnId) => {
    if (["listening", "processing", "finishing"].includes(T.state)) return;
    const turn = T.turns.find((t) => t.id === turnId); const text = turn && turn.upgrade && turn.upgrade.better; if (!text) return;
    if (T.betterTurnId === turnId && T.betterPhase === "loading") return;
    if (T.betterTurnId === turnId && T.betterPhase === "playing") { run++; coachChain = Promise.resolve(); stopAudio(); T.betterPhase = "idle"; T.emit(); return; }
    if (ttsOff) { T.notice = "The coach voice isn't set up on the server yet. Read the better version instead."; T.emit(); return; }
    const r = ++run; coachChain = Promise.resolve(); stopAudio(); T.notice = "";
    T.betterTurnId = turnId; T.betterPhase = "loading";
    const setPhase = (ph) => { if (!alive(r)) return; T.betterPhase = ph; T.coachPlaying = ph === "playing"; T.playingTurnId = ph === "playing" ? turnId + ":better" : ""; T.emit(); };
    try {
      const p = player.speak(text, { voice: settings().voice, speed: settings().speed, isAlive: () => alive(r), onPhase: setPhase });   // primes in the tap
      T.emit(); await p;
      if (alive(r)) { T.betterPhase = "idle"; T.coachPlaying = false; T.playingTurnId = ""; }
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      T.coachPlaying = false; T.playingTurnId = "";
      if (e && e.kind === "not_configured") { ttsOff = true; T.betterPhase = "idle"; T.notice = "The coach voice isn't set up on the server yet. Read the better version instead."; }
      else { T.betterPhase = "error"; T.notice = "Couldn't play the better version. Tap \u201CTap to retry\u201D to hear it."; }
    }
    if (alive(r) || T.betterTurnId === turnId) T.emit();
  };
  /** "Skip reply": stop the coach talking and go straight to your turn. */
  T.skipReply = () => { if (!T.coachPlaying) return; T.stopCoach(); };

  /* ------------------------------------------------------------ pause / finish / leave */
  T.pause = () => {
    if (!["ready", "listening"].includes(T.state)) return;
    const wasListening = T.state === "listening";
    abortFlow(); stopAudio(); discarding = discardTake(); if (wasListening) releaseMic();
    T.state = "paused"; T.error = null; T.notice = wasListening ? "Paused. That take was thrown away. Tap Resume, then Record when you're ready." : "Paused. Tap Resume when you're ready."; T.emit();
  };
  T.resume = () => { if (T.state !== "paused") return; T.notice = ""; T.state = "ready"; T.emit(); };

  /** Finish: stop everything, then ask the backend for the summary of THIS conversation (client-side turns). The takes are dropped as soon as the session ends. */
  T.finish = async () => {
    if (!T.active || T.state === "finishing") return;
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    T.turns = T.turns.filter((t) => t.status === "ok");   // a turn still in flight is not part of the conversation
    dropTakes(); T.error = null; T.notice = ""; T.statusStage = "";
    if (!apiTalk.hasUserSpeech(T.turns)) { T.summary = null; T.summaryState = "empty"; T.state = "finished"; T.emit(); return; }
    return T.summarize();
  };
  T.summarize = async () => {
    abortFlow(); const r = run; ac = new AbortController();
    T.state = "finishing"; T.summaryState = "loading"; T.summaryError = ""; T.emit();
    try {
      const s = await apiTalk.talk.summary({ topic: T.topic, turns: T.turns, scriptVocab: T.vocab, script: T.script, signal: ac.signal });
      if (!alive(r)) return;
      T.summary = s; T.summaryState = s.status === "ok" ? "ok" : "empty";
    } catch (e) {
      if (!alive(r) || (e && e.name === "AbortError")) return;
      T.summary = null;
      if (apiTalk.isUnsupported(e)) T.summaryState = "unsupported";
      else { T.summaryState = "error"; T.summaryError = e && (e.code === "script_too_long" || e.code === "invalid_context") ? apiTalk.talkErrorOf(e).message.replace(/^No assessment obtained: /, "") : e.message || "Couldn't get the summary."; }
    }
    T.state = "finished"; T.emit();
  };
  /** Leaving the Free talk screen: same as Finish without the summary, back to idle. The conversation is forgotten. */
  T.leave = () => {
    if (T.state === "idle") return;
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic(); resetAll(); T.state = "idle"; T.emit();
  };
  /** "Start again" after finishing: a fresh conversation (same topic). Runs unlock+arm inside the tap. */
  T.again = () => T.start();

  /* ------------------------------------------------------------ interruptions (phone lock / call / app switch): discard the take, back to "tap to record" */
  function interrupted() {
    if (!T.active || !(T.state === "listening" || T.coachPlaying)) return;
    const wasListening = T.state === "listening";
    abortFlow(); stopAudio(); discarding = discardTake(); releaseMic();
    T.state = "ready";
    T.notice = wasListening ? "Your recording was interrupted (phone lock, a call, or switching apps) and discarded. Tap Record to go again." : "Audio was interrupted. Tap Record when you're ready.";
    T.emit();
  }
  try {
    ensureInit();
    audio.on("interrupted", (isInt) => { if (isInt) interrupted(); });
    audio.on("maxlength", () => { if (T.state === "listening") T.stop(); });
    audio.on("error", (e) => {
      if (T.state === "listening") { const me = micError(e instanceof Error ? e : new Error(String((e && e.message) || e))); abortFlow(); T.micArmed = false; T.state = "ready"; T.error = { kind: "mic", action: "resume", message: me.message, canSkip: false }; T.emit(); }
    });
  } catch (e) { console.warn("talk audio init failed", e); }

  return T;
}
