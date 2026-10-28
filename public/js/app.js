// App wiring: login -> session (shared/script.js + real audio.js + /api/*) -> one idempotent render().
import { createSession } from "./session.js";
import * as api from "./api.js";
import { MODES, MODE_LABELS, countScriptChars } from "../shared/script.js";
import { SAMPLE_SCRIPT } from "./sample.js";
import { $, $$, announce, toast, fmtTime } from "./ui/dom.js";
import { renderCue } from "./ui/cue.js";
import { createResultView } from "./ui/result.js";
import { renderChunkList } from "./ui/chunks.js";
import { initSaved } from "./ui/saved.js";
import { createDrill } from "./drill.js";
import { initDrillUI } from "./ui/drill.js";
import { isPass } from "./assess.js";

const S = createSession();
const D = createDrill(S);
window.__coach = { S, D, api }; // debugging / tests
const store = S.store;

let peek = false, mockSeen = false, authed = false, booted = false;
const last = { chunks: "", state: "", piece: "", assess: null };
let rafId = 0;

/* ---------------- views ---------------- */
function setView(v) {
  if (v !== "drill" && document.body.dataset.view === "drill") D.leave();   // leaving the drill releases the mic and stops audio
  document.body.dataset.view = v;
  const tabView = v === "drill" ? "saved" : v;   // the drill lives under the Saved tab
  $$(".tab").forEach((t) => (t.getAttribute("data-view") === tabView ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current")));
  if (v === "saved") { S.loadWords(); S.loadMissed(); }
}
$$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
$("#btnGoPractice").addEventListener("click", () => setView("practice"));
$("#btnToScript").addEventListener("click", () => setView("script"));

/* ---------------- auth ---------------- */
function setAuth(ok) {
  authed = ok;
  document.body.dataset.auth = ok ? "in" : "out";
  if (!ok) setTimeout(() => $("#passcode").focus(), 50);
}
let lockTimer = 0;
function showLoginError(msg) { const e = $("#loginError"); e.textContent = msg; e.hidden = !msg; }
function lockout(sec) {
  clearInterval(lockTimer);
  const btn = $("#btnLogin"); let left = sec;
  const tick = () => {
    if (left <= 0) { clearInterval(lockTimer); btn.disabled = false; btn.textContent = "Sign in"; showLoginError(""); return; }
    btn.disabled = true; btn.textContent = `Locked (${left}s)`;
    showLoginError(`Too many wrong passcodes. Try again in ${left} second${left === 1 ? "" : "s"}.`); left--;
  };
  tick(); lockTimer = setInterval(tick, 1000);
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btnLogin"); if (btn.disabled) return;
  btn.disabled = true; showLoginError("");
  try {
    await api.login($("#passcode").value);
    $("#passcode").value = "";
    btn.disabled = false;
    setAuth(true); await boot();
    if (S.state === "paused" && S.pauseReason === "auth") S.pauseReason = "";
  } catch (err) {
    if (err.status === 429 || err.code === "login_locked") lockout(err.retryAfterSec || 30);
    else if (err.code === "bad_passcode" || err.status === 401) showLoginError("That passcode isn't right. Try again.");
    else showLoginError(err.message);
    if (!(err.status === 429)) btn.disabled = false;
  }
});
api.onAuthLost(() => { if (S.sessionActive) S.pause("auth"); setAuth(false); showLoginError("Your session expired. Sign in again to carry on."); });
$("#btnLogout").addEventListener("click", async () => { try { await api.logout(); } catch { /* ignore */ } S.finish(); setAuth(false); showLoginError(""); });

/* ---------------- script input ---------------- */
const input = $("#scriptInput");
let parseTimer;
function updateCount() {
  const n = countScriptChars(input.value);
  $("#charCount").textContent = `${n.toLocaleString()} character${n === 1 ? "" : "s"}`;
  $("#charWarn").hidden = n === 0 || n >= 1000;
}
function onScriptChanged(immediate) {
  updateCount();
  clearTimeout(parseTimer);
  const go = () => S.loadScript(input.value);
  if (immediate) go(); else parseTimer = setTimeout(go, 300);
}
input.value = store.script.text || "";
input.addEventListener("input", () => onScriptChanged(false));
$("#btnSample").addEventListener("click", () => {
  if (input.value.trim() && !confirm("Replace the current script with the sample?")) return;
  input.value = SAMPLE_SCRIPT; onScriptChanged(true); toast("Sample script loaded");
});
$("#btnClear").addEventListener("click", () => {
  if (input.value.trim() && !confirm("Clear the script and its progress?")) return;
  input.value = ""; onScriptChanged(true);
});
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.includes("\uFFFD")) { try { text = new TextDecoder("gb18030").decode(buf); } catch { /* keep utf-8 */ } }
  return text.replace(/^\uFEFF/, "");
}
async function loadFile(file) {
  if (!file) return;
  if (file.size > 2_000_000) return toast("That file is too big for a script.");
  try { input.value = await readTextFile(file); onScriptChanged(true); toast(`Loaded ${file.name}`); } catch { toast("Couldn't read that file."); }
}
$("#fileInput").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
const layout = $("#layout");
["dragenter", "dragover"].forEach((ev) => layout.addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); layout.classList.add("dragover"); } }));
["dragleave", "drop"].forEach((ev) => layout.addEventListener(ev, () => layout.classList.remove("dragover")));
layout.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); loadFile(e.dataTransfer.files[0]); } });

/* ---------------- selects / settings ---------------- */
$$(".js-chunk-mode").forEach((sel) => {
  MODES.forEach((m) => sel.add(new Option(MODE_LABELS[m], m)));
  sel.value = store.settings.chunkMode;
  sel.addEventListener("change", () => S.setChunkMode(sel.value));
});
$("#practiceMode").value = store.settings.practiceMode;
$("#practiceMode").addEventListener("change", (e) => S.setPracticeMode(e.target.value));
const f = { assess: $("#setAssess"), rate: $("#setRate"), rateOut: $("#setRateOut"), voice: $("#setVoice"), pinyin: $("#setPinyin"), fb: $("#setFeedback"), auto: $("#setAutoCoach") };
function loadSettingsForm() {
  const s = store.settings;
  f.assess.value = s.assessMode; f.rate.value = s.speed; f.rateOut.textContent = Number(s.speed).toFixed(2);
  f.voice.value = s.voice || ""; f.pinyin.checked = s.showPinyin; f.fb.checked = s.showFeedback; f.auto.checked = s.autoCoach !== false;
  $("#practiceMode").value = s.practiceMode;
  $$(".js-chunk-mode").forEach((sel) => (sel.value = s.chunkMode));
}
f.assess.addEventListener("change", () => S.setAssessMode(f.assess.value));
f.rate.addEventListener("input", () => { f.rateOut.textContent = Number(f.rate.value).toFixed(2); });
f.rate.addEventListener("change", () => S.setSpeed(Number(f.rate.value)));
f.voice.addEventListener("change", () => S.setVoice(f.voice.value.trim()));
f.pinyin.addEventListener("change", () => S.setLocal({ showPinyin: f.pinyin.checked }));
f.fb.addEventListener("change", () => S.setLocal({ showFeedback: f.fb.checked }));
f.auto.addEventListener("change", () => { S.setLocal({ autoCoach: f.auto.checked }); if (!f.auto.checked) S.stopCoach(); });
$("#btnTestConn").addEventListener("click", async () => {
  const out = $("#connResult"); out.textContent = "Checking…";
  try {
    const h = await api.health(); const sv = h.services || {};
    out.textContent = `Server OK. Assessment engine: ${h.engine}${h.mock ? " (MOCK)" : ""}. Services: assessment ${sv.assessment ? "on" : "off"}, coach text ${sv.llm ? "on" : "off"}, coach voice ${sv.tts ? "on" : "off"}, speech-to-text ${sv.stt ? "on" : "off"}.`;
  } catch (e) { out.textContent = e.message; }
});

/* ---------------- result / saved ---------------- */
const resultView = createResultView({ onSave: (w) => S.saveWord(w).then(() => toast(S.saveMsg)) });
initSaved(S, { onDrill: (wordId) => { setView("drill"); D.start(wordId ? { wordId } : {}); } });   // D.start runs unlock+arm inside this tap
initDrillUI(D, S, { onLeave: () => setView("saved") });

/* ---------------- controls ---------------- */
const btn = { primary: $("#btnPrimary"), pause: $("#btnPause"), retry: $("#btnRetry"), skip: $("#btnSkip"), finish: $("#btnFinish") };
btn.primary.addEventListener("click", () => {
  const st = S.state;
  if (st === "idle" || st === "finished") { setView("practice"); S.start({ fromSentence: null }); }
  else if (st === "prompting") S.skipPrompt();
  else if (st === "listening") S.stopRecording();
  else if (st === "playback") S.stopTake();
  else if (st === "paused") S.resume();
  else if (st === "result") S.doResultAction();
});
btn.pause.addEventListener("click", () => (S.state === "paused" ? S.resume() : S.pause()));
btn.retry.addEventListener("click", () => S.retry());
btn.skip.addEventListener("click", () => S.skip());
btn.finish.addEventListener("click", () => S.finish());
$("#btnPlayback").addEventListener("click", () => S.playTake());
$("#btnHearCoach").addEventListener("click", () => S.replayCoach());
$("#btnHear").addEventListener("click", () => S.hearModel());
$("#btnPeek").addEventListener("click", () => { peek = !peek; render(); });
$("#btnErrRetry").addEventListener("click", () => S.errorAction());
$("#btnErrSkip").addEventListener("click", () => { S.error = null; S.skip(); });

/* ---------------- mock banner ---------------- */
api.onMock((v) => { if (v.source === "health") mockSeen = !!v.mock; else if (v.mock) mockSeen = true; renderBanner(); });
function renderBanner() {
  $("#mockBanner").hidden = !mockSeen;
  $("#mockBannerText").textContent = "Simulated assessment: scores and tone marks are not real.";
}

/* ---------------- render ---------------- */
const STATUS_TEXT = { idle: "Ready", prompting: "Coach is speaking", listening: "Recording. Speak now.", processing: "Processing your recording", result: "Result ready", playback: "Playing your recording", paused: "Paused", finished: "Session finished" };

function primaryLabel() {
  switch (S.state) {
    case "idle": return "Start";
    case "finished": return "Start new session";
    case "prompting": return "Skip audio and record";
    case "listening": return "Done speaking";
    case "processing": return "Assessing…";
    case "playback": return "Stop playback";
    case "paused": return "Resume";
    case "result": return S.resultAction().label;
  }
  return "";
}
const STAGE_TEXT = { uploading: "Uploading your recording…", transcribing: "Listening to what you said…", assessing: "Assessing your speech…", coaching: "Assessing your speech…" };

function render() {
  const st = S.state, total = S.chunks.length;
  document.body.dataset.state = st;
  renderBanner();
  loadSettingsFormIfNeeded();

  const done = S.stats.doneChunks.size;
  $("#progressLabel").textContent = total ? `Chunk ${S.chunkIdx + 1} of ${total}` : "Chunk 0 of 0";
  $("#progressDone").textContent = total ? `${done} completed` : "";
  const pct = total ? Math.round((done / total) * 100) : 0;
  const pb = $("#progressBar"); pb.setAttribute("aria-valuenow", String(pct)); pb.firstElementChild.style.width = pct + "%";

  $$(".js-chunk-mode").forEach((sel) => { if (sel.value !== store.settings.chunkMode) sel.value = store.settings.chunkMode; });
  if ($("#practiceMode").value !== store.settings.practiceMode) $("#practiceMode").value = store.settings.practiceMode;

  $("#emptyScript").hidden = total > 0;
  $("#cueCard").hidden = !total || st === "finished";
  if (S.pieceKey !== last.piece) { peek = false; last.piece = S.pieceKey; }
  renderCue({ cueText: $("#cueText"), fadeIndicator: $("#fadeIndicator"), fadeText: $("#fadeText"), btnPeek: $("#btnPeek"), btnHear: $("#btnHear"), cueNote: $("#cueNote"), pieceLabel: $("#pieceLabel") }, S, { peek });
  const notice = $("#notice"); notice.hidden = !S.notice; notice.textContent = S.notice;
  $("#idleHint").textContent = S.practiceMode === "fading_cues"
    ? "Tap Start. You'll hear the line once, then say it again with less and less help."
    : "Tap Start. You'll hear the line, then it's your turn to repeat.";

  // status panel
  const kind = { idle: "idle", prompting: "prompting", listening: "listening", processing: "processing", playback: "playback", paused: "paused" }[st] || "";
  const sp = $("#statusPanel");
  sp.hidden = !kind || (st === "idle" && !total);
  sp.dataset.kind = kind;
  $$("#statusPanel .st").forEach((el) => (el.hidden = !el.classList.contains("st-" + kind)));
  $("#procTitle").textContent = STAGE_TEXT[S.statusStage] || "Assessing your speech…";
  $("#procHint").textContent = S.error ? "" : "This takes a few seconds.";
  $("#pausedHint").textContent = S.pauseReason && S.pauseReason !== "auth" && !S.pauseReason.startsWith("Paused:") ? S.pauseReason : S.pauseReason === "auth" ? "Signed out. Sign in again, then tap Resume." : "Tap Resume when you're ready. The microphone is released while paused.";
  const pp = S.playPos, frac = pp.d ? Math.min(1, pp.t / pp.d) : 0;
  $("#playFill").style.width = Math.round(frac * 100) + "%";
  $("#playFill").parentElement.setAttribute("aria-valuenow", String(Math.round(frac * 100)));

  // error (and interrupted message)
  const err = S.error;
  const showErr = !!err || (st === "paused" && S.pauseReason.startsWith("Paused:"));
  $("#errorPanel").hidden = !showErr;
  if (showErr) {
    $("#errorText").textContent = err ? err.message : S.pauseReason;
    $("#btnErrRetry").hidden = !err;
    $("#btnErrRetry").textContent = !err ? "" : err.action === "reupload" ? "Try again (re-send)" : err.action === "resume" ? "Retry microphone" : err.action === "rerun" ? "Try again" : "Record again";
    $("#btnErrSkip").hidden = !err || err.canSkip === false;
  }

  // result
  if ((st === "result" || st === "playback") && S.assessment && S.assessment.ok) {
    const o = { showPinyin: store.settings.showPinyin, showFeedback: store.settings.showFeedback, cueShowsText: S.practiceMode !== "fading_cues" || peek };
    if (resultView.shown !== S.assessment) { resultView.show(S, o); resultView.shown = S.assessment; } else { resultView.el.hidden = false; resultView.update(S, o); }
  } else { resultView.hide(); resultView.shown = null; }
  $("#btnPlayback").disabled = st !== "result" || !S.recording;
  $("#btnHearCoach").textContent = S.coachPlaying && S.playPos.what === "coach" ? "\u25A0 Stop coach" : "\u{1F50A} Hear coach again";
  $("#btnHearCoach").onclick = () => (S.coachPlaying ? S.stopCoach() : S.replayCoach());

  // summary
  const sum = $("#summaryPanel");
  sum.hidden = st !== "finished" || !S.stats.startedAt;
  if (!sum.hidden) renderSummary(sum);

  // controls
  const p = btn.primary;
  p.textContent = primaryLabel();
  p.disabled = st === "processing" || ((st === "idle" || st === "finished") && !total);
  p.classList.toggle("recording", st === "listening");
  btn.pause.textContent = st === "paused" ? "Resume" : "Pause";
  btn.pause.disabled = !(S.machine.can("PAUSE") || st === "paused");
  btn.retry.disabled = !S.machine.can("RETRY");
  btn.skip.disabled = !S.machine.can("NEXT");
  btn.finish.disabled = st === "idle" || st === "finished";

  const ck = [S.chunks.length, store.settings.chunkMode, S.chunkIdx, done, S.parsed ? S.parsed.charCount : 0].join("|");
  if (ck !== last.chunks) { last.chunks = ck; renderChunkList(S, (i) => { S.jumpTo(i); setView("practice"); }); }

  if (st !== last.state) {
    if (st === "result" || st === "finished") requestAnimationFrame(() => { const t = st === "result" ? $("#resultPanel") : $("#summaryPanel"); if (!t.hidden) $("#practiceScroll").scrollTo({ top: t.offsetTop - 8 }); });
    announce(STATUS_TEXT[st] + (st === "result" && S.assessment ? `. ${$("#verdict").textContent}` : ""));
    last.state = st;
  }
  if (err && last.err !== err) { announce(err.message); }
  last.err = err;
  const pe = $("#prefsError"); pe.hidden = !S.prefsError; pe.textContent = S.prefsError;
  if (st === "listening" && !rafId) rafId = requestAnimationFrame(tick);
}
let settingsSig = "";
function loadSettingsFormIfNeeded() { const sig = JSON.stringify(store.settings); if (sig !== settingsSig) { settingsSig = sig; loadSettingsForm(); } }

function tick() {
  rafId = 0;
  if (S.state !== "listening") return;
  $("#recTimer").textContent = fmtTime(performance.now() - S.recStart);
  rafId = requestAnimationFrame(tick);
}

function renderSummary(el) {
  const m = S.stats, mins = Math.max(1, Math.round((Date.now() - m.startedAt) / 60000));
  const weak = [...m.weak.keys()];
  el.innerHTML = `
    <h2>Session summary</h2>
    <div class="stats">
      <div class="stat"><b>${m.attempts}</b>assessed attempts</div>
      <div class="stat"><b>${m.passed}</b>without tone flags</div>
      <div class="stat"><b>${m.toneFlags}</b>tones flagged to review</div>
      <div class="stat"><b>${m.doneChunks.size}/${S.chunks.length}</b>chunks completed</div>
      <div class="stat"><b>${m.skipped}</b>skipped</div>
      <div class="stat"><b>${mins} min</b>practice time</div>
    </div>
    ${weak.length ? `<p><strong>Worth another go</strong></p><ul class="weak-list" lang="zh-CN">${weak.map((w) => `<li>${w.replace(/[&<>]/g, "")}</li>`).join("")}</ul>` : ""}
    <div class="row gap wrap">
      <button class="btn primary" type="button" id="sumContinue">Continue where I left off</button>
      <button class="btn" type="button" id="sumRestart">Restart from the top</button>
      <button class="btn ghost" type="button" id="sumSaved">Saved words</button>
    </div>`;
  $("#sumContinue").onclick = () => { setView("practice"); S.start({ fromSentence: S.chunk ? S.chunk.sentenceStart : 0 }); };
  $("#sumRestart").onclick = () => { setView("practice"); S.start({ fromSentence: 0 }); };
  $("#sumSaved").onclick = () => setView("saved");
}

S.subscribe(render);

/* ---------------- boot ---------------- */
async function boot() {
  if (booted) return; booted = true;
  try {
    const prefs = await api.getPrefs();
    S.applyServerPrefs(prefs);
    loadSettingsForm();
  } catch (e) { S.prefsError = ""; }
  S.loadWords(); S.loadMissed();
  render();
}
async function init() {
  updateCount();
  S.loadScript(input.value, { resetProgress: false });
  setView(input.value.trim() ? "practice" : "script");
  render();
  api.health().then(() => {}).catch(() => {});
  try { await api.me(); setAuth(true); await boot(); }
  catch (e) { if (e.auth || e.status === 401) { setAuth(false); } else { setAuth(false); showLoginError(e.message); } }
}
init();

// If the page is hidden mid-recording (iOS suspends capture), pause cleanly. audio.js also emits 'interrupted'.
document.addEventListener("visibilitychange", () => { if (document.hidden && S.state === "listening") S.interrupt(); });
