// Cue card: what the learner sees for the current piece. Stage directions render as muted badges (piece.display is pre-escaped HTML).
import { esc } from "./dom.js";
import { FADE_LABELS } from "../session.js";
import { highlightPieceHtml } from "../highlight.js";

/** Returns {html|text, cls} for the cue area. */
export function renderCue(els, S, { peek }) {
  const piece = S.piece, chunk = S.chunk;
  const fading = S.practiceMode === "fading_cues";
  const lvl = fading ? S.fade : 0;
  els.fadeIndicator.hidden = !fading;
  els.btnPeek.hidden = !(fading && lvl >= 1 && S.sessionActive);
  els.btnPeek.setAttribute("aria-pressed", String(!!peek));
  els.btnPeek.textContent = peek ? "Hide" : "Peek";
  els.btnHear.hidden = !S.sessionActive || ["listening", "processing"].includes(S.state);
  if (fading) {
    [...els.fadeIndicator.querySelectorAll(".fade-dots i")].forEach((d, i) => d.classList.toggle("on", i < lvl));
    els.fadeText.textContent = FADE_LABELS[lvl];
  }
  const t = els.cueText;
  t.classList.remove("placeholder");
  els.cueNote.hidden = true;
  if (!piece) { t.classList.add("placeholder"); t.textContent = "No script yet."; els.pieceLabel.textContent = ""; return; }
  els.pieceLabel.textContent = chunk.pieces.length > 1 ? `Part ${S.pieceIdx + 1} of ${chunk.pieces.length}` : "";
  if (!S.sessionActive && S.state !== "paused") { t.innerHTML = piece.display; return; }

  // after an attempt, mark the flagged words in the displayed text (underline style + marker + SR text; stage-direction cues stay as they are)
  const reviewing = ["result", "playback"].includes(S.state) && S.assessment && S.assessment.wordStatus && S.assessment.wordStatus.length;
  if (!fading || peek) { t.innerHTML = reviewing ? highlightPieceHtml(piece, S.assessment.wordStatus) : piece.display; return; }
  // fading: level 1 keywords + pinyin, 2 first characters, 3 topic hint, 4 nothing. Cues come from POST /api/cues.
  const c = S.cue;
  if (S.cueLoading || !c) { t.classList.add("placeholder"); t.textContent = "Loading cue…"; return; }
  if (c.failed) { t.innerHTML = piece.display; els.cueNote.hidden = false; els.cueNote.textContent = `${S.cueError} Showing the full text instead.`; return; }
  if (lvl === 1) {
    const items = c.items && c.items.length ? c.items : null;
    if (items) t.innerHTML = `<span class="cue-keywords">${items.map((i) => `<span class="kw"><span>${esc(i.text)}</span><small>${esc(i.pinyin || "")}</small></span>`).join("")}</span>`;
    else t.innerHTML = `<span class="cue-keywords">${esc(c.cue || "")}</span>`;
  } else if (lvl === 2) t.innerHTML = `<span class="cue-first">${esc(c.cue || "")}</span>`;
  else if (lvl === 3) t.innerHTML = c.cue ? `<span class="cue-topic">${esc(c.cue)}</span>` : "";
  else { t.classList.add("placeholder"); t.textContent = "Level 4: say it from memory. No text shown."; }
  if (lvl === 3 && !c.cue) { t.classList.add("placeholder"); t.textContent = "Say it from memory."; }
}
