// Pure helpers (no DOM, Node-testable): map the backend's per-word statuses onto the displayed script text.
//
// Backend shape (assessment event, or a separate `word_status` event):
//   wordStatus: [{start, end, text, pinyin, status:'ok'|'missed'|'substituted'|'wrong'|'uncertain',
//                 reason?:'omitted'|'low_score'|'tone'|'initial'|'final', heard?, source?, confidence?, detail?}]
//   start/end = CODE POINT offsets (end exclusive) into the exact chunkText that was sent (= piece.spoken, stage directions stripped).
// The displayed piece (piece.segments) also carries stage-direction cues and may be one of several pieces of a chunk, so offsets are
// mapped onto piece.spoken and rendered through piece.segments. If this shape changes, edit normalizeWordStatus() only.
import { segmentsToHtml } from "../shared/script.js";

export const STATUSES = ["ok", "uncertain", "wrong", "missed", "substituted"];
const SEVERITY = { ok: 0, uncertain: 1, wrong: 3, missed: 4, substituted: 5 };
/** marker = small glyph shown after the word (not colour alone); sr = screen-reader text; cls = CSS class suffix. */
export const STATUS_INFO = {
  missed: { marker: "\u2212", sr: "missed", label: "Missed" },
  wrong: { marker: "!", sr: "pronounced wrong", label: "Wrong" },
  substituted: { marker: "\u2194", sr: "said something else", label: "Different word" },
  uncertain: { marker: "?", sr: "not sure", label: "Not sure" },
};
export const REASON_LABELS = {
  omitted: "not said", low_score: "unclear pronunciation", tone: "tone", initial: "initial sound", final: "final sound", added: "extra word",
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** UTF-16 index of every code point of `s`, plus s.length at the end. offs[cp] = unit index where code point `cp` starts. */
export function cpOffsets(s) {
  const out = []; let u = 0;
  for (const ch of s) { out.push(u); u += ch.length; }
  out.push(u);
  return out;
}

/** Find `text` in `chunkText`, returning the code-point start closest to `near`, or -1. */
function relocate(chunkText, offs, text, near) {
  const cps = offs.length - 1;
  let best = -1, bestD = Infinity, from = 0;
  for (;;) {
    const u = chunkText.indexOf(text, from);
    if (u < 0) break;
    const cp = offs.indexOf(u);
    if (cp >= 0 && Math.abs(cp - near) < bestD) { best = cp; bestD = Math.abs(cp - near); }
    from = u + 1;
    if (from > chunkText.length || cps === 0) break;
  }
  return best;
}

/**
 * Validate + normalise the server's wordStatus against the exact chunkText. Never throws.
 * Entries with bad offsets are dropped; if `text` does not match the slice the entry is relocated (nearest occurrence) or dropped
 * (so a unit mismatch never paints the wrong characters). Overlaps keep the more severe status. Result is sorted by start.
 */
export function normalizeWordStatus(list, chunkText) {
  if (!Array.isArray(list) || typeof chunkText !== "string" || !chunkText) return [];
  const chars = [...chunkText], offs = cpOffsets(chunkText), n = chars.length;
  const out = [];
  for (const w of list) {
    if (!w || typeof w !== "object") continue;
    const status = String(w.status || "").toLowerCase();
    if (!STATUSES.includes(status)) continue;
    let { start, end } = w;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > n) {
      if (typeof w.text === "string" && w.text && Number.isInteger(start)) { const r = relocate(chunkText, offs, w.text, start); if (r >= 0) { start = r; end = r + [...w.text].length; } else continue; }
      else continue;
    }
    const slice = chars.slice(start, end).join("");
    if (typeof w.text === "string" && w.text && slice !== w.text) {
      const r = relocate(chunkText, offs, w.text, start);
      if (r < 0) continue;
      start = r; end = r + [...w.text].length;
    }
    out.push({
      start, end, text: chars.slice(start, end).join(""), pinyin: typeof w.pinyin === "string" ? w.pinyin : "", status,
      reason: typeof w.reason === "string" ? w.reason : "", heard: typeof w.heard === "string" ? w.heard : "",
      source: w.source || "", confidence: w.confidence || "", detail: typeof w.detail === "string" ? w.detail : "",
    });
  }
  // overlaps: most severe wins (greedy by severity, then earlier start); result sorted by start
  const kept = [];
  for (const w of [...out].sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.start - b.start)) {
    if (kept.every((k) => w.end <= k.start || w.start >= k.end)) kept.push(w);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** Words that were not fine (everything except 'ok'), in script order. */
export const flaggedWords = (ws) => (ws || []).filter((w) => w.status !== "ok");

/** For the LIST only: the server may report one entry per character; merge touching entries that share status/reason/heard into one word (the highlights stay per entry). */
export function groupFlagged(list) {
  const out = [];
  for (const w of list || []) {
    const last = out[out.length - 1];
    if (last && last.end === w.start && last.status === w.status && (last.reason || "") === (w.reason || "") && (last.heard || "") === (w.heard || "")) {
      last.end = w.end; last.text += w.text;
      last.pinyin = [last.pinyin, w.pinyin].filter(Boolean).join(" ");
    } else out.push({ ...w });
  }
  return out;
}
/** Real problems only (uncertain is soft and does not count). */
export const problemWords = (ws) => (ws || []).filter((w) => w.status === "missed" || w.status === "substituted" || w.status === "wrong");

/** Human reason: "tone", "initial sound", "not said", "said something else (heard: X)" ... */
export function reasonText(w) {
  const base = w.status === "substituted" ? "said something else" : w.status === "missed" ? (REASON_LABELS[w.reason] || "missed") : (REASON_LABELS[w.reason] || (w.status === "wrong" ? "pronunciation" : ""));
  if (w.status === "uncertain") return `not sure${REASON_LABELS[w.reason] ? ` about ${REASON_LABELS[w.reason]}` : ""}`;
  return base;
}

/** Map ranges onto piece.spoken (UTF-16 units): [{u0,u1,w}] */
export function unitRanges(spoken, ws) {
  const offs = cpOffsets(spoken);
  return (ws || []).filter((w) => w.status !== "ok" && w.end < offs.length).map((w) => ({ u0: offs[w.start], u1: offs[w.end], w }));
}

/**
 * HTML for a displayed piece with the flagged words marked. Same structure as piece.display (direction cues stay muted badges,
 * emphasis stays <mark>), but flagged words are wrapped:
 *   <span class="hl hl-missed" data-status="missed">字</span> (+ a small marker and screen-reader text after the last fragment)
 * A word interrupted by a direction cue is wrapped per fragment. With no flagged words returns piece.display unchanged.
 */
export function highlightPieceHtml(piece, ws) {
  const ranges = unitRanges(piece.spoken, ws);
  if (!ranges.length) return piece.display;
  let pos = 0;
  const html = piece.segments.map((seg) => {
    if (seg.type !== "text") return segmentsToHtml([seg]);
    const a = pos, b = pos + seg.text.length; pos = b;
    let out = "", cur = a;
    for (const r of ranges) {
      const s = Math.max(a, r.u0), e = Math.min(b, r.u1);
      if (e <= s) continue;
      if (s > cur) out += esc(seg.text.slice(cur - a, s - a));
      const info = STATUS_INFO[r.w.status];
      const closes = e === r.u1;
      out += `<span class="hl hl-${r.w.status}" data-status="${r.w.status}" data-start="${r.w.start}">${esc(seg.text.slice(s - a, e - a))}</span>`;
      if (closes) out += `<sup class="hl-m hl-m-${r.w.status}" aria-hidden="true">${info.marker}</sup><span class="sr-only">, ${info.sr}</span>`;
      cur = e;
    }
    if (cur < b) out += esc(seg.text.slice(cur - a));
    return seg.emph ? `<mark class="emph">${out}</mark>` : out;
  }).join("");
  return html;
}

/** Plain-text one-liner for a verdict / announcement. */
export function problemSummary(ws) {
  const p = problemWords(ws);
  const missed = p.filter((w) => w.status === "missed").length, sub = p.filter((w) => w.status === "substituted").length, wrong = p.filter((w) => w.status === "wrong").length;
  const parts = [];
  if (missed) parts.push(missed === 1 ? "1 word missed" : `${missed} words missed`);
  if (sub) parts.push(sub === 1 ? "1 word different" : `${sub} words different`);
  if (wrong) parts.push(wrong === 1 ? "1 word to fix" : `${wrong} words to fix`);
  return parts;
}
