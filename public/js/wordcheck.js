// Reused-phrase word check (retell + Q&A): pure helpers, no DOM, Node-testable.
// Backend (855030d, server/API-ATTEMPT.md "Reused-phrase word check"): when the learner reuses a script phrase almost verbatim but a content word is
// swapped or left out, `assessment.wordStatus` is NON-EMPTY in retell/Q&A: [{start,end,text,pinyin,status:'substituted'|'missed',heard?,source:'stt',
// confidence:'high'|'medium',detail,reuse:true,chunkIndex?,keyPointId?}] (code-point offsets into the chunk text; Q&A: chunks[chunkIndex]).
// Praise is then never 'full': praiseBlockedBy:['word_check'], wordCheck:{status:'found',count}, canPraise:false, praiseLevel max 'soft'.
// Rules here: wordStatus never lights an all-clear; offsets are validated against the exact chunk text (a mismatch is relocated or dropped, never mis-painted);
// nothing is saved from the client (the server auto-saves to Words to practise; Save word is an explicit tap).
import { normalizeWordStatus, STATUS_INFO } from "./highlight.js";

const KINDS = new Set(["substituted", "missed"]);
const cps = (s) => Array.from(String(s || ""));

/**
 * Raw wordStatus -> [{start,end,text,pinyin,status,heard,confidence,keyPointId,chunkIndex}] placed on `chunkText` (sorted, non-overlapping).
 * Only substituted/missed entries are kept. With opts.chunkIndex (Q&A) entries for another chunk are skipped (offsets would not apply to this text).
 * `total` counts every well-formed entry, placed or not (an unplaced finding still blocks the all-clear).
 */
export function normalizeWordCheck(list, chunkText, { chunkIndex } = {}) {
  const raw = (Array.isArray(list) ? list : []).filter((w) => w && typeof w === "object" && w.reuse === true && KINDS.has(String(w.status || "").toLowerCase()));   // reuse:true only: a plain per-word status is never used for retell/Q&A
  const total = raw.length;
  const mine = raw.filter((w) => !(Number.isInteger(w.chunkIndex) && Number.isInteger(chunkIndex) && w.chunkIndex !== chunkIndex));
  const placed = normalizeWordStatus(mine, chunkText);   // validates offsets/text, relocates a mismatching slice, drops the rest
  const words = placed.map((p) => {
    const src = mine.find((w) => w.text === p.text && Math.abs((w.start | 0) - p.start) <= 1) || mine.find((w) => w.text === p.text) || {};
    return { ...p, confidence: src.confidence === "high" ? "high" : "medium", keyPointId: typeof src.keyPointId === "string" ? src.keyPointId : "", chunkIndex: Number.isInteger(src.chunkIndex) ? src.chunkIndex : undefined };
  });
  return { words, total };
}

/**
 * The praise gate from a retell/Q&A block (+ optional facts): {blocked, count, reasons}. blocked when the backend says so in ANY of its ways.
 * (A missing field is not evidence of a clean answer on its own: callers also pass their own word count.)
 */
export function praiseGate(block, facts) {
  const b = block && typeof block === "object" ? block : {}, f = facts && typeof facts === "object" ? facts : {};
  const reasons = Array.isArray(b.praiseBlockedBy) ? b.praiseBlockedBy.filter((x) => typeof x === "string" && x) : [];
  const wc = b.wordCheck && typeof b.wordCheck === "object" ? b.wordCheck : null;
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const count = Math.max(wc && Number.isInteger(wc.count) ? wc.count : 0, n(f.substitutedWords) + n(f.missingWords), f.reusedPhrase && Number.isInteger(f.reusedPhrase.findings) ? f.reusedPhrase.findings : 0);
  const blocked = reasons.length > 0 || count > 0 || (wc && wc.status === "found") || b.canPraise === false || f.canPraise === false || (typeof b.praiseLevel === "string" && b.praiseLevel !== "full");
  return { blocked: !!blocked, count, reasons };
}

const pick = (words, st) => words.filter((w) => w.status === st);
/** "Meaning covered, but one word differs from the script" / "... N words differ from the script" / "... one word was left out". n = findings (>=1). */
export function wordCheckVerdict(n, words = [], { sure = true } = {}) {
  const sub = pick(words, "substituted").length, miss = pick(words, "missed").length;
  const head = sure ? "Meaning covered" : "Meaning looks covered";
  if (n <= 1) return `${head}, but ${miss && !sub ? "one word was left out" : "one word differs from the script"}`;
  return `${head}, but ${n} words differ from the script`;
}
export const WORD_CHECK_NOTE = "Your wording was fine, but a word from the script was replaced or left out. See the Word check below. Nothing here is an all-clear.";

/** One Word check row as plain text parts: {kind, line, hedged}. */
export function wordCheckLine(w) {
  const hedged = w.confidence !== "high";
  if (w.status === "substituted") {
    const heard = w.heard ? `“${w.heard}”` : "a different word";
    return { kind: "substituted", hedged, line: hedged ? `I think I heard ${heard}, but the script has “${w.text}”.` : `You said ${heard}, the script has “${w.text}”.` };
  }
  return { kind: "missed", hedged, line: hedged ? `“${w.text}” may have been left out.` : `“${w.text}” was left out.` };
}

/** The marks of a word (glyph + screen-reader text); the same vocabulary as close mode (highlight.js STATUS_INFO). */
export const wordMark = (w) => STATUS_INFO[w.status === "missed" ? "missed" : "substituted"];

/** [{start,end,status}] -> per-character status array (length = code points of chunkText). */
export function wordKinds(chunkText, words) {
  const kinds = new Array(cps(chunkText).length).fill("");
  for (const w of words || []) for (let i = w.start; i < Math.min(w.end, kinds.length); i++) kinds[i] = w.status;
  return kinds;
}

/**
 * Merge key-point/idea kinds with word-check spans into runs: [{text, kind, word?}]. `kinds` = per-char idea kind ('' | covered | partial | wrong | missing).
 * The two sets stay independent: a run boundary appears wherever EITHER changes, `word` is only present on word-check characters, `endsWord` marks the last
 * run of a span (where the marker glyph goes) and `wordSpan` identifies it. Text is always preserved.
 */
export function mergeRuns(chunkText, kinds, words) {
  const chars = cps(chunkText), wk = wordKinds(chunkText, words);
  const spanAt = new Array(chars.length).fill(-1);
  (words || []).forEach((w, si) => { for (let i = w.start; i < Math.min(w.end, chars.length); i++) spanAt[i] = si; });
  const out = [];
  chars.forEach((c, i) => {
    const kind = (kinds && kinds[i]) || "", word = wk[i], span = spanAt[i];
    const last = out[out.length - 1];
    if (last && last.kind === kind && (last.word || "") === word && last.wordSpan === (span >= 0 ? span : undefined)) last.text += c;
    else out.push({ text: c, kind, ...(word ? { word, wordSpan: span } : {}) });
  });
  // the marker goes after the last run of each span
  const lastRun = new Map();
  out.forEach((r, i) => { if (r.wordSpan !== undefined) lastRun.set(r.wordSpan, i); });
  for (const i of lastRun.values()) out[i].endsWord = true;
  return out;
}
