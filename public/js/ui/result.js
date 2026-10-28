// Assessment result view. Rules: only confirmed tone errors ("review") are marked as mistakes; "uncertain" is a soft "not sure";
// no invented scores; no assessment => no verdict at all (the error panel handles that case).
import { esc, formatPinyin } from "./dom.js";
import { verdict, isPass } from "../assess.js";
import { highlightPieceHtml, flaggedWords, groupFlagged, problemWords, reasonText, STATUS_INFO } from "../highlight.js";

const TONE_NAME = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 0: "neutral", 5: "neutral" };

export function createResultView({ onSave }) {
  const el = document.getElementById("resultPanel");
  const q = (s) => el.querySelector(s);
  const sel = new Set();
  let current = null;
  let fbOpen = true;

  function renderSel() {
    const chars = current ? current.chars : [];
    const picked = chars.filter((c, i) => sel.has(i));
    q("#saveBar").hidden = picked.length === 0;
    q("#saveSel").textContent = picked.map((c) => c.ch).join("");
    el.querySelectorAll(".rch").forEach((b) => b.setAttribute("aria-pressed", String(sel.has(+b.dataset.i))));
  }

  q("#resultChars").addEventListener("click", (e) => {
    const b = e.target.closest(".rch"); if (!b || b.dataset.han !== "1") return;
    const i = +b.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); renderSel();
  });
  q("#btnClearSel").addEventListener("click", () => { sel.clear(); renderSel(); });
  q("#btnSaveSel").addEventListener("click", () => {
    if (!current) return;
    const idx = [...sel].sort((a, b) => a - b);
    const picked = idx.map((i) => current.chars[i]);
    const text = picked.map((c) => c.ch).join("");
    const pinyin = picked.map((c) => formatPinyin(c.pinyin)).filter(Boolean).join(" ");
    onSave({ text, pinyin });
    sel.clear(); renderSel();
  });
  q("#btnFeedback").addEventListener("click", () => { fbOpen = !fbOpen; q("#btnFeedback").setAttribute("aria-expanded", String(fbOpen)); q("#feedbackBody").hidden = !fbOpen; });

  return {
    el, shown: null,
    hide() { el.hidden = true; current = null; sel.clear(); },
    /** `a` normalized assessment; S session (coach lines/corrections can still stream in: call update() again). */
    show(S, opts) {
      const a = S.assessment;
      const first = current !== a;
      current = a; el.hidden = false;
      if (first) sel.clear();
      this.head(S, opts);
      q("#resultChars").innerHTML = a.chars.map((c, i) => {
        if (!c.han) return `<span class="rch plain" data-han="0" aria-hidden="true"><span>${esc(c.ch)}</span><small></small></span>`;
        const cls = c.review ? "review" : c.unsure ? "unsure" : "";
        const py = opts.showPinyin && c.pinyin ? formatPinyin(c.pinyin) : "";
        const tn = c.review ? `<span class="tn">${TONE_NAME[c.review.expected] ?? c.review.expected} tone, heard ${TONE_NAME[c.review.heard] ?? c.review.heard}</span>` : "";
        const label = `${c.ch}${c.pinyin ? " " + formatPinyin(c.pinyin) : ""}${c.review ? ", tone to review" : c.unsure ? ", not sure" : ""}`;
        return `<button type="button" class="rch ${cls}" data-i="${i}" data-han="1" aria-pressed="${sel.has(i)}" aria-label="${esc(label)}"><span>${esc(c.ch)}</span><small>${esc(py)}</small>${tn}</button>`;
      }).join("");
      const tb = q("#transcriptBox");
      tb.hidden = !a.transcript;
      if (a.transcript) tb.innerHTML = `<small>What the engine heard</small><span lang="zh-CN">${esc(a.transcript)}</span>`;
      this.update(S, opts);
      renderSel();
    },
    /** Verdict line + badge. Re-run on every update: word statuses can arrive after the assessment. */
    head(S) {
      const a = S.assessment;
      const pass = isPass(a), probs = problemWords(a.wordStatus).length;
      const badge = q("#verdictIcon");
      badge.className = "score-badge " + (pass ? "s-good" : a.gated ? "s-none" : "s-review");
      badge.textContent = pass ? "\u2713" : a.gated ? "?" : probs || !a.confirmed.length ? "!" : String(a.confirmed.length);
      q("#verdict").textContent = verdict(a);
      const notes = [];
      if (a.overall !== null && !a.gated) notes.push(`Overall ${a.overall}`);
      if (a.basis === "transcript") notes.push("Compared with what the engine heard you say");
      if (a.lowConfidence) notes.push("Low confidence: treat this as a rough guide");
      q("#verdictNote").textContent = notes.join(" \u00b7 ");
    },
    /** Flagged-word list, "added to Words to practise" and "extra words" notes. */
    flags(S, opts) {
      const a = S.assessment, list = groupFlagged(flaggedWords(a.wordStatus));
      const saved = [...new Set([...(a.savedMissed || []), ...(S.savedMissedExtra || [])])];
      const wrap = q("#flagWrap");
      wrap.hidden = !list.length && !saved.length && !a.insertedText;
      q("#flagList").innerHTML = list.map((w) => {
        const info = STATUS_INFO[w.status];
        const why = w.status === "substituted" ? "Said something else" : w.status === "missed" ? `Missed \u00b7 ${reasonText(w)}` : w.status === "wrong" ? `Wrong \u00b7 ${reasonText(w)}` : `Not sure${w.reason ? ` \u00b7 ${reasonText(w).replace(/^not sure (about )?/, "")}` : ""}`;
        return `<li class="flag is-${w.status}"><span class="w"><span class="hl hl-${w.status}">${esc(w.text)}</span><sup class="hl-m hl-m-${w.status}" aria-hidden="true">${info.marker}</sup></span>${w.pinyin ? `<span class="py">${esc(formatPinyin(w.pinyin))}</span>` : ""}<span class="why">${esc(why)}</span>${w.heard ? `<span class="heard">heard: <span lang="zh-CN">${esc(w.heard)}</span></span>` : ""}</li>`;
      }).join("");
      const ins = q("#insertedNote"); ins.hidden = !a.insertedText; ins.textContent = a.insertedText ? `Extra words I heard that aren't in the script: ${a.insertedText}` : "";
      const sn = q("#savedNote"); sn.hidden = !saved.length; sn.textContent = saved.length ? `Added to Words to practise: ${saved.join(", ")}` : "";
      q("#legendWords").hidden = !list.length;
      // the highlighted line: shown here only when the cue card above is NOT already showing the full text (fading cues)
      const sw = q("#resultScriptWrap"), piece = S.piece;
      const show = !!(piece && list.length && opts.cueShowsText === false);
      sw.hidden = !show;
      if (show) q("#resultScript").innerHTML = highlightPieceHtml(piece, a.wordStatus);
    },
    /** Coach text / corrections (streamed in after the assessment). */
    update(S, opts) {
      const a = S.assessment;
      this.head(S, opts); this.flags(S, opts);
      const wrap = q("#feedbackWrap");
      const lines = S.coachLines.filter(Boolean);
      const corr = S.corrections || [];
      wrap.hidden = !opts.showFeedback || (!lines.length && !corr.length && S.coachDone);
      if (!wrap.hidden) {
        q("#btnFeedback").setAttribute("aria-expanded", String(fbOpen));
        q("#feedbackBody").hidden = !fbOpen;
        const status = !S.coachDone && S.statusStage ? `<p class="fb-status">${S.statusStage === "speaking" ? "Coach is speaking…" : "Coach is writing feedback…"}</p>` : "";
        const corrHtml = corr.length ? `<div class="corrections">${corr.map((c) => `<div class="corr k-${esc(c.kind)}"><div class="ct">${c.kind === "tone" ? '<span class="badge badge-pause">tone</span>' : c.kind === "model" ? '<span class="badge">not sure</span>' : `<span class="badge">${esc(c.kind)}</span>`}<span lang="zh-CN">${esc(c.targetText || "")}</span></div>${c.explanationZh ? `<div class="cx" lang="zh-CN">${esc(c.explanationZh)}</div>` : ""}</div>`).join("")}</div>` : "";
        q("#feedbackBody").innerHTML = `<div class="coach-lines">${lines.map((l) => `<p class="${esc(l.role)}">${esc(l.text)}${l.caption ? `<small class="muted cap"> ${esc(l.caption)}</small>` : ""}</p>`).join("")}</div>${corrHtml}${status}`;
      }
      const tag = q("#engineTag");
      tag.className = "engine-tag muted" + (a.mock ? " is-mock" : "");
      tag.textContent = a.mock ? `MOCK engine (${a.engine || "mock"}): tone marks above are simulated.` : `Engine: ${a.engine || "unknown"}`;
      q("#btnHearCoach").disabled = !S.coachAudio.some(Boolean);
    },
  };
}
