// Assessment result view. Rules: only confirmed tone errors ("review") are marked as mistakes; "uncertain" is a soft "not sure";
// no invented scores; no assessment => no verdict at all (the error panel handles that case).
import { esc, formatPinyin } from "./dom.js";
import { verdict, isPass } from "../assess.js";
import { splitCorrections, normalizeKeyIdeas, placeIdeas, ideaKind, modelLine } from "../retell.js";
import { highlightPieceHtml, flaggedWords, groupFlagged, problemWords, reasonText, STATUS_INFO } from "../highlight.js";

// retell idea markers: glyph + dotted/dashed/wavy underline + screen-reader text (never colour only)
const MARKS = {
  missing: { cls: "miss", hm: "hl-m-missed", glyph: "&minus;", sr: "missing idea", label: "Missing: not in what I heard", hl: "hl-missed" },
  partial: { cls: "part", hm: "hl-m-partial", glyph: "~", sr: "idea only partly covered", label: "Only partly covered", hl: "hl-partial" },
  wrong: { cls: "diff", hm: "hl-m-wrong", glyph: "!", sr: "idea differs from the original", label: "Different from the original", hl: "hl-wrong" },
};
const TONE_NAME = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 0: "neutral", 5: "neutral" };

export function createResultView({ onSave }) {
  const el = document.getElementById("resultPanel");
  const q = (s) => el.querySelector(s);
  const sel = new Set();
  let current = null;
  let gridSig = "";
  let grid = [];   // the tappable characters (close mode: what the engine scored; retell: the ORIGINAL text, so a saved word is a real word)
  let fbOpen = true;

  function renderSel() {
    const chars = current ? grid : [];
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
    const picked = idx.map((i) => grid[i]).filter(Boolean);
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
      this.paintGrid(S, opts);
      const tb = q("#transcriptBox");
      tb.hidden = !a.transcript;
      if (a.transcript) tb.innerHTML = `<small>What the engine heard</small><span lang="zh-CN">${esc(a.transcript)}</span>`;
      if (a.retell) { tb.hidden = false; tb.innerHTML = a.transcript ? `<small>What I heard</small><span lang="zh-CN">${esc(a.transcript)}</span><small class="muted">Speech-to-text of your retelling. It can contain recognition mistakes, and it is not used as tone evidence.</small>` : `<small>What I heard</small><span>Nothing I could make out.</span>`; }
      this.update(S, opts);
      renderSel();
    },
    /** Verdict line + badge. Re-run on every update: word statuses can arrive after the assessment. */
    head(S) {
      const a = S.assessment;
      if (a.retell) {
        const o = S.outcome();
        const b = q("#verdictIcon");
        b.className = "score-badge " + (o.state === "checked" ? "s-good" : o.state === "missing" ? "s-review" : "s-none");
        b.textContent = o.badge; q("#verdict").textContent = o.label; q("#verdictNote").textContent = o.note;
        return;
      }
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
    /** (Re)draw the tappable characters. Retell: called again when the coach's missing ideas arrive. */
    paintGrid(S, opts) {
      const a = S.assessment;
      const R = a.retell ? this.retellData(S) : null;
      grid = R ? R.grid : a.chars;
      q(".legend").innerHTML = R ? 'Tap characters in the original to save a word. <span class="lg lg-w-missed"><span class="hl hl-missed">word</span><sup class="hl-m">&minus;</sup> missing idea</span>'
        : 'Tap characters to select, then save as a word. <span class="lg lg-bad">tone to review</span> <span class="lg lg-unsure">not sure</span>';
      q("#resultChars").innerHTML = grid.map((c, i) => {
        if (c.mark) { const m = MARKS[c.mark]; return `<button type="button" class="rch ${m.cls}" data-i="${i}" data-han="1" aria-pressed="${sel.has(i)}" aria-label="${esc(c.ch)}, ${m.sr}"><span>${esc(c.ch)}</span><small></small><sup class="hl-m ${m.hm}" aria-hidden="true">${m.glyph}</sup></button>`; }
        if (R && c.han) return `<button type="button" class="rch" data-i="${i}" data-han="1" aria-pressed="${sel.has(i)}" aria-label="${esc(c.ch)}"><span>${esc(c.ch)}</span><small></small></button>`;
        if (!c.han) return `<span class="rch plain" data-han="0" aria-hidden="true"><span>${esc(c.ch)}</span><small></small></span>`;
        const cls = c.review ? "review" : c.unsure ? "unsure" : "";
        const py = opts.showPinyin && c.pinyin ? formatPinyin(c.pinyin) : "";
        const tn = c.review ? `<span class="tn">${TONE_NAME[c.review.expected] ?? c.review.expected} tone, heard ${TONE_NAME[c.review.heard] ?? c.review.heard}</span>` : "";
        const label = `${c.ch}${c.pinyin ? " " + formatPinyin(c.pinyin) : ""}${c.review ? ", tone to review" : c.unsure ? ", not sure" : ""}`;
        return `<button type="button" class="rch ${cls}" data-i="${i}" data-han="1" aria-pressed="${sel.has(i)}" aria-label="${esc(label)}"><span>${esc(c.ch)}</span><small>${esc(py)}</small>${tn}</button>`;
      }).join("");
    },
    /** Retell: the original text as tappable characters, with ideas that need work marked; plus the idea lists. */
    retellData(S) {
      const a = S.assessment, info = a.retellInfo;
      const piece = S.piece, text = piece ? piece.spoken : a.chunkText || "";
      const sp = splitCorrections(S.corrections);
      const HAN = /[\u3400-\u9fff]/;
      const chars = Array.from(text);
      const mark = new Map();
      let items = [], covered = [], missing = [], wording = sp.wording;
      if (info && info.status === "ok") {   // structured comparison: every idea, with its span in the original
        const byId = new Map(sp.missing.filter((m) => m.ideaId).map((m) => [m.ideaId, m]));
        items = info.ideas.map((idea) => ({ idea, kind: ideaKind(idea), corr: byId.get(idea.id) || null }));
        for (const it of items) if (it.kind !== "covered" && it.idea.start !== undefined) for (let i = it.idea.start; i < it.idea.end; i++) if (!mark.has(i) || it.kind === "missing") mark.set(i, it.kind);
      } else {
        // legacy: gaps only (omission corrections, no offsets) + an optional future keyIdeas list
        const ideas = normalizeKeyIdeas(a.keyIdeas), seen = new Set(sp.missing.map((m) => m.text || m.model));
        missing = [...sp.missing, ...ideas.filter((i) => i.covered === false && !seen.has(i.text)).map((i) => ({ kind: "key_idea", text: i.text, model: "", explanation: "", start: i.start, end: i.end }))];
        covered = ideas.filter((i) => i.covered === true);
        const { placed } = placeIdeas(text, missing);
        placed.forEach((p) => { for (let i = p.start; i < p.end; i++) mark.set(i, "missing"); });
      }
      const grid = chars.map((ch, i) => ({ ch, han: HAN.test(ch), pinyin: "", mark: mark.has(i) && HAN.test(ch) ? mark.get(i) : "" }));
      return { grid, info, items, covered, missing, wording, suggested: info && info.status === "ok" ? info.suggestedWords : [] };
    },
    /** Retell blocks: key ideas (missing, with a checklist-style list), wording notes, tone note, peek note. Re-run on every update (the coach streams in). */
    retell(S, opts) {
      const a = S.assessment, o = S.outcome(), R = this.retellData(S);
      const wrap = q("#retellWrap"); wrap.hidden = false;
      const sig = JSON.stringify(R.grid.map((c) => c.mark));
      if (sig !== gridSig) { gridSig = sig; this.paintGrid(S, opts); renderSel(); }
      let html = "";
      const li = (kind, w, why, extra = "", save = "") => `<li class="idea is-${kind === "covered" ? "covered" : kind}"><span class="ib" aria-hidden="true">${kind === "covered" ? "\u2713" : MARKS[kind].glyph}</span><span class="w">${esc(w)}</span><span class="why">${esc(why)}</span><span class="sr-only">, ${esc(why)}</span>${extra}${save}</li>`;
      if (R.info && R.info.status === "ok") {
        // every idea the backend checked: covered (with what you said), partly covered, missing, or different from the original
        html = `<ul class="idea-list" lang="zh-CN">${R.items.map(({ idea, kind, corr }) => {
          const why = (kind === "covered" ? "Covered" : MARKS[kind].label) + (idea.confidence === "low" ? " (not sure)" : "");
          const ex = [];
          if (kind === "covered" && idea.evidence) ex.push(`<div class="cx ev">You said: ${esc(idea.evidence)}</div>`);
          if (corr && corr.heard) ex.push(`<div class="cx ev">You said: ${esc(corr.heard)}</div>`);
          if (corr && corr.explanation) ex.push(`<div class="cx">${esc(corr.explanation)}</div>`);
          if (corr && corr.model && kind !== "covered") ex.push(`<div class="mt">You could say: <span>${esc(corr.model)}</span></div>`);
          return li(kind, idea.text, why, ex.join(""));
        }).join("")}</ul>${o.note ? `<p class="muted idea-note">${esc(o.note)}</p>` : ""}`;
      } else {
        const coveredHtml = R.covered.length ? `<ul class="idea-list" lang="zh-CN">${R.covered.map((c) => li("covered", c.text, "Covered")).join("")}</ul>` : "";
        if (o.state === "missing") {
          html = coveredHtml + `<ul class="idea-list" lang="zh-CN">${R.missing.map((m, i) => {
            const t = m.text || m.model;
            return li("missing", t || (m.explanation ? "(see note)" : "(unspecified)"), "Missing: not in what I heard", m.explanation ? `<div class="cx">${esc(m.explanation)}</div>` : "", t ? `<button type="button" class="btn ghost small js-save-idea" data-i="${i}">Save word</button>` : "");
          }).join("")}</ul><p class="muted idea-note">Your own wording is fine. These are meanings from the original that I didn't hear.</p>`;
        } else if (o.state === "checked") html = coveredHtml + `<p class="idea-ok"><span class="badge">\u2713</span> ${esc(o.label)}</p><p class="muted idea-note">${esc(o.note)} I only report gaps, so covered ideas aren't ticked off one by one.</p>`;
        else html = `<p class="idea-none"><span class="badge badge-pause">?</span> ${esc(o.label)}</p>${o.note ? `<p class="muted idea-note">${esc(o.note)}</p>` : ""}`;
      }
      q("#ideaBody").innerHTML = html;
      q("#ideaBody").querySelectorAll(".js-save-idea").forEach((b) => b.addEventListener("click", () => { const m = R.missing[+b.dataset.i]; const t = m && (m.text || m.model); if (t) onSave({ text: t, pinyin: "" }); }));
      const sg = q("#suggestWrap"); sg.hidden = !R.suggested.length;
      q("#suggestList").innerHTML = R.suggested.map((w, i) => `<li class="sw"><span class="w" lang="zh-CN">${esc(w.text)}</span>${w.pinyin ? `<span class="py">${esc(w.pinyin)}</span>` : ""}${w.meaning ? `<span class="why">${esc(w.meaning)}</span>` : ""}<button type="button" class="btn ghost small js-save-sw" data-i="${i}" aria-label="Save word ${esc(w.text)}">Save word</button></li>`).join("");
      q("#suggestList").onclick = (e) => { const b = e.target.closest(".js-save-sw"); const w = b && R.suggested[+b.dataset.i]; if (w) onSave({ text: w.text, pinyin: w.pinyin, meaning: w.meaning }); };
      const ww = q("#wordingWrap"); ww.hidden = !R.wording.length;
      q("#wordingList").innerHTML = R.wording.map((w) => `<li class="wording" lang="zh-CN"><span class="badge">wording</span>${w.text ? ` You said: <span class="w">${esc(w.text)}</span>` : ""}${w.explanation ? `<div class="cx">${esc(w.explanation)}</div>` : ""}${w.model ? `<div class="mt">More natural: <span>${esc(w.model)}</span></div>` : ""}</li>`).join("");
      // tone: only as a labelled rough guide, only if the backend flagged it low-confidence; never mapped onto the original text
      const tn = q("#toneNote"), items = a.toneShown ? [...a.confirmed.map((c) => `${c.char}: ${TONE_NAME[c.expected] ?? c.expected} tone, heard ${TONE_NAME[c.heard] ?? c.heard}`), ...a.uncertain.map((u) => `${u.char}: not sure`)] : [];
      tn.hidden = !items.length;
      tn.innerHTML = items.length ? `<strong>Tone, rough guide only.</strong> <span class="muted">From the sound of your speech, checked against what I heard (not the original text), so it's low confidence.</span><div lang="zh-CN">${items.map(esc).join(" \u00b7 ")}</div>` : "";
      const pn = q("#peekNote"); pn.hidden = !S.peeked; pn.textContent = S.peeked ? "You peeked at the text during this attempt." : "";
    },
    /** Coach text / corrections (streamed in after the assessment). */
    update(S, opts) {
      const a = S.assessment;
      q("#retellWrap").hidden = !a.retell;
      el.classList.toggle("is-retell", !!a.retell);
      this.head(S, opts); this.flags(S, opts);
      const wrap = q("#feedbackWrap");
      const lines = S.coachLines.filter(Boolean);
      const sp = a.retell ? splitCorrections(S.corrections) : null;
      const corr = a.retell ? sp.other.filter((c) => !["tone", "model"].includes(c.kind)) : S.corrections || [];   // retell: tone lives in the labelled "rough guide" note only
      if (a.retell) this.retell(S, opts);
      wrap.hidden = !opts.showFeedback || (!lines.length && !corr.length && S.coachDone);
      if (!wrap.hidden) {
        q("#btnFeedback").setAttribute("aria-expanded", String(fbOpen));
        q("#feedbackBody").hidden = !fbOpen;
        const status = !S.coachDone && S.statusStage ? `<p class="fb-status">${S.statusStage === "speaking" ? "Coach is speaking…" : "Coach is writing feedback…"}</p>` : "";
        const corrHtml = corr.length ? `<div class="corrections">${corr.map((c) => `<div class="corr k-${esc(c.kind)}"><div class="ct">${c.kind === "tone" ? `<span class="badge badge-pause">tone${a.retell ? " (rough)" : ""}</span>` : c.kind === "model" ? '<span class="badge">not sure</span>' : `<span class="badge">${esc(c.kind)}</span>`}<span lang="zh-CN">${esc(c.targetText || "")}</span></div>${c.explanationZh ? `<div class="cx" lang="zh-CN">${esc(c.explanationZh)}</div>` : ""}</div>`).join("")}</div>` : "";
        q("#feedbackBody").innerHTML = `<div class="coach-lines">${lines.map((l) => `<p class="${esc(l.role)}">${esc(l.text)}${l.caption ? `<small class="muted cap"> ${esc(l.caption)}</small>` : ""}</p>`).join("")}</div>${corrHtml}${status}`;
      }
      const tag = q("#engineTag");
      tag.className = "engine-tag muted" + (a.mock ? " is-mock" : "");
      tag.textContent = a.retell ? modelLine(a, S.summary) : a.mock ? `MOCK engine (${a.engine || "mock"}): tone marks above are simulated.` : `Engine: ${a.engine || "unknown"}`;
      q("#btnHearCoach").disabled = !S.coachAudio.some(Boolean);
    },
  };
}
