// Q&A screen wiring: reads the Q&A controller `Q` (js/qa.js), never touches audio or network itself.
import { $, $$, esc, formatPinyin, announce, fmtTime } from "./dom.js";
import { QA_MARKS, segmentsOf, placedCount } from "../api-qa.js";
import { ideaKind } from "../retell.js";
import { createHearMine } from "../hear-mine.js";

const STAGE = { uploading: "Uploading your answer…", transcribing: "Writing down what you said…", assessing: "Checking your answer…", coaching: "Checking the meaning against the script…" };

export function initQaUI(Q, S, { onLeave, onSave = () => {} }) {
  let rafId = 0, lastKey = "";
  const primary = $("#btnQaPrimary");

  primary.addEventListener("click", () => {
    const st = Q.state;
    if (st === "idle") onStart();
    else if (st === "asking" || st === "ready") Q.record();
    else if (st === "listening") Q.stop();
    else if (st === "result") Q.next();
    else if (st === "finished") (Q.unsupported ? onLeave() : onStart());
  });
  function onStart() { Q.start(); }   // unlock + arm run synchronously inside this tap (see qa.js)
  $("#btnQaRetry").addEventListener("click", () => Q.retry());
  $("#btnQaSkip").addEventListener("click", () => Q.skip());
  $("#btnQaFinish").addEventListener("click", () => Q.finish());
  $("#btnQaHear").addEventListener("click", () => Q.hear());
  $("#btnQaHint").addEventListener("click", () => Q.hint());
  $("#btnQaAnswer").addEventListener("click", () => Q.showAnswer());
  $("#btnQaHearAnswer").addEventListener("click", () => Q.hearAnswer());
  $("#btnQaErrRetry").addEventListener("click", () => Q.errorAction());
  $("#btnQaErrSkip").addEventListener("click", () => { Q.error = null; Q.skip(); });
  // "Hear my recording" next to What I heard: the in-memory take through the shared <audio> element (hear-mine.js).
  const hearMine = createHearMine($("#btnQaHearMine"), { getTake: () => (Q.state === "result" ? Q.recording : null), blocked: () => Q.state !== "result" || Q.coachPlaying || Q.questionPhase === "loading" || Q.answerPhase === "loading" });
  $("#btnQaHearCoach").addEventListener("click", () => (Q.coachPlaying ? Q.stopCoach() : Q.replayCoach()));

  const OUT_CLASS = { covered: "s-good", checked: "s-good", partial: "s-review", missing: "s-review", unchecked: "s-none" };

  function primaryLabel() {
    switch (Q.state) {
      case "idle": return "Start Q&A";
      case "loading": return "Getting a question…";
      case "asking": return "Record answer";
      case "ready": return Q.error && Q.error.kind === "mic" ? "Retry microphone" : Q.rec && Q.rec.attempts ? "Record again" : "Tap to record";
      case "listening": return "Done speaking";
      case "processing": return "Checking…";
      case "result": return "Next question";
      case "finished": return Q.unsupported ? "Back" : "Start again";
    }
    return "Start";
  }

  const segHtml = (chunkText, info) => segmentsOf(chunkText, info).map((seg) => {
    if (!seg.kind) return esc(seg.text);
    const m = QA_MARKS[seg.kind];
    return `<span class="hl ${m.cls}" data-status="${seg.kind}">${esc(seg.text)}</span><sup class="hl-m hl-m-${seg.kind === "covered" ? "covered" : seg.kind === "missing" ? "missed" : seg.kind}" aria-hidden="true">${m.glyph}</sup><span class="sr-only">, ${m.label}</span>`;
  }).join("");

  function render() {
    const st = Q.state, q = Q.question, info = Q.info, out = Q.outcome;
    const busy = ["listening", "processing", "loading"].includes(st);
    const inFlow = Q.active;

    // intro / idle
    $("#qaIntro").hidden = st !== "idle"; $("#qaNoScript").hidden = !!S.chunks.length;
    $("#qaProgress").textContent = q && inFlow ? `Question ${Q.number} · chunk ${Q.chunkIdx + 1} of ${S.chunks.length}` : S.chunks.length ? "Q&A practice" : "Q&A practice: add a script first";
    $("#qaModeSelect").disabled = inFlow; $$("#view-qa .js-chunk-mode").forEach((el) => (el.disabled = inFlow));

    // question card
    const showQ = !!q && inFlow;
    $("#qaCard").hidden = !showQ;
    if (q) {
      $("#qaNumber").textContent = String(Q.number);
      $("#qaQuestion").textContent = q.text;
      const py = S.settings.showPinyin !== false ? formatPinyin(q.pinyin) : "";
      $("#qaPinyin").textContent = py; $("#qaPinyin").hidden = !py;
      $("#btnQaHear").disabled = busy || Q.questionPhase === "loading";   // no duplicate taps while the audio loads
      $("#btnQaHear").textContent = Q.questionPhase === "loading" ? "Loading audio…" : Q.questionPhase === "error" ? "Tap to retry" : Q.questionPlaying ? "\u25A0 Stop" : "\u{1F50A} Replay question";
      const nt = $("#qaNotice"); nt.hidden = !Q.notice; nt.textContent = Q.notice;
      const hints = Q.hints, shown = hints.slice(0, Q.hintsShown);
      $("#qaHints").hidden = !shown.length;
      $("#qaHints").innerHTML = shown.map((h, i) => `<p class="qa-hint"><span class="badge">Hint ${i + 1}</span> ${esc(h.text)}${h.from === "script" ? ' <small class="muted">(start of the sentence in your script)</small>' : ""}</p>`).join("");
      const hb = $("#btnQaHint");
      hb.disabled = busy || !hints.length || Q.hintsShown >= hints.length;
      hb.textContent = !hints.length ? "No hint available" : Q.hintsShown >= hints.length ? `Hints used (${Q.hintsShown} of ${hints.length})` : Q.hintsShown ? `Another hint (${Q.hintsShown} of ${hints.length})` : "Hint";
      const ans = Q.answer, ab = $("#btnQaAnswer");
      ab.disabled = busy || !ans || Q.answerShown;
      ab.textContent = !ans ? "No answer available" : Q.answerShown ? "Answer shown" : "Show answer";
      $("#qaAnswer").hidden = !(Q.answerShown && ans);
      if (ans) {
        $("#qaAnswerText").textContent = ans.text;
        $("#qaAnswerFrom").textContent = ans.from === "script" ? "(from your script)" : "";
        $("#btnQaHearAnswer").disabled = busy || Q.answerPhase === "loading";   // no duplicate taps while the audio loads
        $("#btnQaHearAnswer").textContent = Q.answerPhase === "loading" ? "Loading audio…" : Q.answerPhase === "error" ? "Tap to retry" : Q.answerPlaying ? "\u25A0 Stop" : "\u{1F50A} Hear answer";
      }
    }

    // status
    const kind = ["asking", "ready", "listening", "processing", "loading"].includes(st) ? st : "";
    const sp = $("#qaStatus"); sp.hidden = !kind; sp.dataset.kind = kind;
    $$("#qaStatus .st").forEach((el) => (el.hidden = !el.classList.contains("st-" + kind)));
    $("#qaProcTitle").textContent = STAGE[Q.statusStage] || "Checking your answer…";

    // error
    const err = Q.error;
    $("#qaError").hidden = !err;
    if (err) {
      $("#qaErrorText").textContent = err.message;
      $("#btnQaErrRetry").hidden = err.retryable === false;
      $("#btnQaErrRetry").textContent = err.action === "reupload" ? "Try again (re-send)" : err.action === "resume" ? "Retry microphone" : err.kind === "load" ? "Try again" : "Record again";
      $("#btnQaErrSkip").hidden = err.canSkip === false || err.kind === "mic";
    }

    // result
    const rp = $("#qaResult");
    rp.hidden = st !== "result" || !out;
    if (st === "result" && out) {
      const badge = $("#qaBadge");
      badge.className = "score-badge " + (OUT_CLASS[out.state] || "s-none"); badge.textContent = out.badge;
      $("#qaVerdict").textContent = out.label; $("#qaVerdictNote").textContent = out.note;
      $("#qaHeardText").textContent = Q.transcript || "(nothing transcribed)";
      const pts = info && info.status === "ok" ? info.points : [];
      $("#qaPointsWrap").hidden = !pts.length;
      $("#qaPoints").innerHTML = pts.map((p) => {
        const k = ideaKind(p), m = k === "covered" ? { glyph: "\u2713", label: "Covered" } : { glyph: QA_MARKS[k].glyph, label: ({ missing: "Missing: not in what I heard", partial: "Only partly covered", wrong: "Different from the script" })[k] };
        const why = m.label + (p.confidence === "low" ? " (not sure)" : "");
        return `<li class="idea is-${k}"><span class="ib" aria-hidden="true">${m.glyph}</span><span class="w">${esc(p.text)}</span><span class="why">${esc(why)}</span><span class="sr-only">, ${esc(why)}</span>${(k === "covered" || k === "wrong") && p.evidence ? `<div class="cx ev">You said: ${esc(p.evidence)}</div>` : ""}</li>`;
      }).join("");
      const placed = placedCount(info);
      $("#qaSourceWrap").hidden = !placed;
      $("#qaSource").innerHTML = placed ? segHtml(Q.chunkText, info) : "";
      const wf = (info && info.status === "ok" && info.wrongFacts) || [];
      const ck = $("#qaCheck"); ck.hidden = !wf.length;
      ck.innerHTML = wf.length ? `<strong>Check this:</strong> ${wf.map((w) => `you said <span lang="zh-CN">“${esc(w.claim)}”</span>${w.about ? `, but the script says <span lang="zh-CN">“${esc(w.about)}”</span>` : ", which differs from the script"}`).join("; ")}.` : "";
      const sw = (info && info.status === "ok" && info.suggestedWords) || [];
      $("#qaSuggestWrap").hidden = !sw.length;
      $("#qaSuggest").innerHTML = sw.map((w, i) => `<li class="sw"><span class="w" lang="zh-CN">${esc(w.text)}</span>${w.pinyin ? `<span class="py">${esc(w.pinyin)}</span>` : ""}${w.meaning ? `<span class="why">${esc(w.meaning)}</span>` : ""}<button type="button" class="btn ghost small js-save-qsw" data-i="${i}" aria-label="Save word ${esc(w.text)}">Save word</button></li>`).join("");
      $("#qaSuggest").onclick = (e) => { const b = e.target.closest(".js-save-qsw"); const w = b && sw[+b.dataset.i]; if (w) onSave({ text: w.text, pinyin: w.pinyin, meaning: w.meaning }); };
      const lines = Q.coachLines.filter(Boolean);
      $("#qaCoach").innerHTML = lines.map((l) => `<p class="${esc(l.role)}">${esc(l.text)}${l.caption && !l.text.includes(l.caption) ? `<small class="muted cap"> ${esc(l.caption)}</small>` : ""}</p>`).join("");
      $("#btnQaHearCoach").hidden = !Q.coachAudio.some(Boolean);
      $("#btnQaHearCoach").textContent = Q.coachPlaying ? "\u25A0 Stop coach" : "\u{1F50A} Hear coach again";
      const used = [Q.hintsShown ? `${Q.hintsShown} hint${Q.hintsShown === 1 ? "" : "s"} used` : "", Q.answerShown ? "the model answer was shown" : ""].filter(Boolean);
      $("#qaUsed").hidden = !used.length; $("#qaUsed").textContent = used.length ? `For this question: ${used.join(" and ")}.` : "";
      const a = Q.assessment || {}, eng = $("#qaEngine");
      eng.hidden = !a.engine; eng.textContent = a.engine ? `${a.mock ? "MOCK engine" : "Engine"}${typeof a.engine === "string" && !a.mock ? `: ${a.engine}` : ""} · speech-to-text transcript` : "";
      eng.classList.toggle("is-mock", !!a.mock);
    }

    // summary
    const sum = $("#qaSummary");
    sum.hidden = st !== "finished";
    if (st === "finished") {
      const s = Q.summary;
      sum.innerHTML = Q.unsupported
        ? `<h2>Q&amp;A isn't available yet</h2><p class="muted">The server doesn't have the Q&amp;A feature yet. Nothing was recorded. Try again once the backend has it.</p>`
        : !s.questions ? `<h2>Q&amp;A finished</h2><p class="muted">No questions were asked.</p>`
        : `<h2>Q&amp;A summary</h2><div class="stats"><div class="stat"><b>${s.answered}</b>question${s.answered === 1 ? "" : "s"} answered</div><div class="stat"><b>${s.pointsTotal ? `${s.pointsCovered} of ${s.pointsTotal}` : "n/a"}</b>key points covered</div><div class="stat"><b>${s.hints}</b>hint${s.hints === 1 ? "" : "s"} used</div><div class="stat"><b>${s.answers}</b>answer${s.answers === 1 ? "" : "s"} shown</div></div>`
          + `<p class="muted">${s.pointsTotal ? "Key points are counted from your last checked answer to each question." : "No answer could be compared, so no key points are counted."}${s.unchecked ? ` ${s.unchecked} answer${s.unchecked === 1 ? "" : "s"} could not be compared.` : ""}${s.skipped ? ` ${s.skipped} question${s.skipped === 1 ? "" : "s"} skipped.` : ""}</p>`;
    }

    hearMine.sync();
    primary.textContent = primaryLabel();
    primary.disabled = st === "processing" || st === "loading" || (st === "idle" && !S.chunks.length);
    primary.classList.toggle("recording", st === "listening");
    const wait = st === "processing" || st === "loading";   // Retry/Skip while recording just discard the take (same as the drill)
    $("#btnQaRetry").disabled = !inFlow || wait || !q;
    $("#btnQaSkip").disabled = !inFlow || wait;
    $("#btnQaFinish").disabled = !inFlow;

    const key = st + (err ? "!" : "") + (out ? out.state : "") + Q.number;
    if (key !== lastKey) {
      lastKey = key;
      const msg = { asking: "Coach is asking a question", ready: "Your turn. Tap record.", listening: "Recording. Answer now.", processing: "Checking your answer", loading: "Getting a question", finished: "Q and A finished" }[st];
      if (st === "result" && out) announce(`${out.label}. ${out.note}`); else if (msg) announce(msg);
      if (err) announce(err.message);
      if (st === "result" || st === "finished") requestAnimationFrame(() => { const t = st === "result" ? $("#qaResult") : $("#qaSummary"); if (!t.hidden) $("#qaScroll").scrollTo({ top: t.offsetTop - 8 }); });
    }
    if (st === "listening" && !rafId) rafId = requestAnimationFrame(tick);
  }
  function tick() { rafId = 0; if (Q.state !== "listening") return; $("#qaTimer").textContent = fmtTime(performance.now() - Q.recStart); rafId = requestAnimationFrame(tick); }
  Q.subscribe(render);
  S.subscribe && S.subscribe(render);
  render();
  return { render };
}
