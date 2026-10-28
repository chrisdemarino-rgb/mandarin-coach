// Drill screen wiring: reads the drill controller `D` (js/drill.js), never touches audio or network itself.
import { $, $$, esc, formatPinyin, announce, fmtTime } from "./dom.js";
import { streakLabel } from "../api-words.js";

export function initDrillUI(D, S, { onLeave }) {
  let rafId = 0, lastKey = "";
  const primary = $("#btnDrillPrimary");

  primary.addEventListener("click", () => {
    const st = D.state;
    if (st === "prompting" || st === "ready") D.record();
    else if (st === "listening") D.stop();
    else if (st === "result") D.doResultAction();
    else if (st === "finished") onLeave();
  });
  $("#btnDrillRetry").addEventListener("click", () => D.retry());
  $("#btnDrillSkip").addEventListener("click", () => D.skip());
  $("#btnDrillFinish").addEventListener("click", () => D.finish());
  $("#btnDrillBack").addEventListener("click", () => onLeave());
  $("#btnDrillHear").addEventListener("click", () => D.hear("word"));
  $("#btnDrillExample").addEventListener("click", () => D.hear("example"));
  $("#btnDrillErrRetry").addEventListener("click", () => D.errorAction());
  $("#btnDrillErrSkip").addEventListener("click", () => { D.error = null; D.skip(); });
  $("#btnDrillHearCoach").addEventListener("click", () => (D.coachPlaying ? D.stopCoach() : D.replayCoach()));

  function primaryLabel() {
    switch (D.state) {
      case "prompting": return "Record now";
      case "ready": return D.error && D.error.kind === "mic" ? "Retry microphone" : D.stats.attempts || D.result ? "Record again" : "Tap to record";
      case "listening": return "Done speaking";
      case "processing": return "Checking…";
      case "result": return D.resultAction().label;
      case "finished": return "Back to words";
    }
    return "Record";
  }

  function render() {
    const st = D.state, it = D.item;
    const kind = ["prompting", "ready", "listening", "processing"].includes(st) ? st : "";
    const sp = $("#drillStatus"); sp.hidden = !kind; sp.dataset.kind = kind;
    $$("#drillStatus .st").forEach((el) => (el.hidden = !el.classList.contains("st-" + kind)));
    $("#drillProcTitle").textContent = D.statusStage === "uploading" ? "Uploading your recording…" : "Checking your word…";

    const showWord = !!it && st !== "finished" && st !== "idle";
    $("#drillCard").hidden = !showWord;
    if (it) {
      $("#drillWord").textContent = it.text;
      const py = S.settings.showPinyin !== false ? formatPinyin(it.pinyin) : "";
      $("#drillPinyin").textContent = py; $("#drillPinyin").hidden = !py;
      $("#drillMeaning").textContent = it.meaning || ""; $("#drillMeaning").hidden = !it.meaning;
      const sentenceMode = !!(it.promptText && it.promptText !== it.text);   // lone character: the learner says their own sentence
      const ex = sentenceMode ? it.promptText : it.exampleSentence && it.exampleSentence !== it.text ? it.exampleSentence : "";
      $("#drillExample").hidden = !ex; $("#drillExample").textContent = ex ? (sentenceMode ? `Say the whole sentence: ${ex}` : `Example: ${ex}`) : "";
      $("#btnDrillExample").hidden = !ex || sentenceMode;
      const needed = it.needed || 0, n = Math.min(it.correctStreak || 0, needed || 99);
      const dots = $("#drillStreak .streak-dots");
      dots.innerHTML = needed ? Array.from({ length: needed }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("") : "";
      $("#drillStreakText").textContent = streakLabel(it.correctStreak || 0, needed);
      $("#drillStreak").setAttribute("aria-label", streakLabel(it.correctStreak || 0, needed));
    }
    $("#btnDrillHear").disabled = ["listening", "processing"].includes(st);
    $("#btnDrillExample").disabled = ["listening", "processing"].includes(st);
    $("#drillProgress").textContent = D.queue.length && st !== "finished" ? `Word ${Math.min(D.idx + 1, D.queue.length)} of ${D.queue.length}` : "Word drill";
    const nt = $("#drillNotice"); nt.hidden = !D.notice; nt.textContent = D.notice;

    const err = D.error;
    $("#drillError").hidden = !err;
    if (err) {
      $("#drillErrorText").textContent = err.message;
      $("#btnDrillErrRetry").textContent = err.action === "reupload" ? "Try again (re-send)" : err.action === "resume" ? "Retry microphone" : err.kind === "load" ? "Try again" : "Record again";
      $("#btnDrillErrSkip").hidden = err.canSkip === false;
    }

    const res = D.result, rp = $("#drillResult");
    rp.hidden = st !== "result" || !res;
    if (res) {
      const badge = $("#drillBadge");
      badge.className = "score-badge " + (!res.counted ? "s-none" : res.correct ? "s-good" : "s-review");
      badge.textContent = !res.counted ? "?" : res.correct ? "\u2713" : "\u00d7";
      $("#drillVerdict").textContent = !res.counted ? "That didn't count" : res.graduated ? "Learned! This word has left your list." : res.correct ? "Correct" : "Not quite. Try again.";
      $("#drillVerdictNote").textContent = !res.counted ? `It didn't sound like the word, so your streak stays at ${res.correctStreak} of ${res.needed || "?"}. Listen, then try again.` : res.graduated ? streakLabel(res.correctStreak, res.needed) : res.correct ? `${streakLabel(res.correctStreak, res.needed)}. Keep going.` : `Streak reset: ${streakLabel(res.correctStreak, res.needed)}.`;
      const lines = D.coachLines.filter(Boolean);
      $("#drillCoach").innerHTML = lines.map((l) => `<p class="${esc(l.role)}">${esc(l.text)}${l.caption ? `<small class="muted cap"> ${esc(l.caption)}</small>` : ""}</p>`).join("");
      $("#btnDrillHearCoach").hidden = !D.coachAudio.some(Boolean);
      $("#btnDrillHearCoach").textContent = D.coachPlaying ? "\u25A0 Stop coach" : "\u{1F50A} Hear coach again";
    }

    const sum = $("#drillSummary");
    sum.hidden = st !== "finished";
    if (st === "finished") {
      const s = D.stats;
      sum.innerHTML = D.queue.length ? `<h2>Drill finished</h2><div class="stats"><div class="stat"><b>${s.attempts}</b>attempts</div><div class="stat"><b>${s.correct}</b>correct</div><div class="stat"><b>${s.graduated.length}</b>learned</div></div>${s.graduated.length ? `<p><strong>Learned:</strong> <span lang="zh-CN">${s.graduated.map(esc).join("、")}</span></p>` : ""}`
        : `<h2>Nothing to drill</h2><p class="muted">${D.error ? esc(D.error.message) : "Your Words to practise list is empty. Words you miss during practice will be added automatically."}</p>`;
    }

    primary.textContent = primaryLabel();
    primary.disabled = st === "processing" || st === "idle";
    primary.classList.toggle("recording", st === "listening");
    $("#btnDrillRetry").disabled = !D.active || st === "processing";
    $("#btnDrillSkip").disabled = !D.active || st === "processing";
    $("#btnDrillFinish").disabled = !D.active;

    const key = st + (D.error ? "!" : "") + (res ? (!res.counted ? "g" : res.correct ? "y" : "n") : "");
    if (key !== lastKey) {
      lastKey = key;
      const msg = { prompting: "Coach is speaking", ready: "Your turn. Tap record.", listening: "Recording. Say the word now.", processing: "Checking your word", finished: "Drill finished" }[st];
      if (st === "result" && res) announce(!res.counted ? "That didn't count. Try again." : res.graduated ? "Learned. This word has left your list." : res.correct ? `Correct. ${streakLabel(res.correctStreak, res.needed)}` : "Not quite. Try again.");
      else if (msg) announce(msg);
      if (err) announce(err.message);
      if (st === "result" || st === "finished") requestAnimationFrame(() => { const t = st === "result" ? $("#drillResult") : $("#drillSummary"); if (!t.hidden) $("#drillScroll").scrollTo({ top: t.offsetTop - 8 }); });
    }
    if (st === "listening" && !rafId) rafId = requestAnimationFrame(tick);
  }
  function tick() { rafId = 0; if (D.state !== "listening") return; $("#drillTimer").textContent = fmtTime(performance.now() - D.recStart); rafId = requestAnimationFrame(tick); }
  D.subscribe(render);
  render();
  return { render };
}
