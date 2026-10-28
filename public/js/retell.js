// Natural retelling (assessMode "retell"): pure helpers, no DOM. Node-testable.
// Backend contract (server/routes/attempt.js retellPipeline + services/retell.js; the Backend's retell work was still UNCOMMITTED when this was written,
// so everything below is defensive and the legacy shape keeps working):
//   assessment.retell = {comparisonStatus:"ok"|"unavailable", comparisonReason, ideas:[{id,textZh,refStart,refEnd,covered:true|false|"partial",evidence,confidence,issue?}],
//     coveredCount,totalCount,partialCount,canPraise,praiseLevel:"full"|"soft"|"none",missingIdeaIds,suggestedWords:[{text,pinyin,meaning,ideaId}],tone:{status,reason},transcript,sttStatus}
//   done.corrections kinds: missing_idea / wrong_meaning (ideaId, start/end, caption, heard, modelText), language (wording), tone (rough, acoustic).
//   LEGACY (no `retell` block): "omission" corrections only (gaps, no offsets) + done.summary.coached.
// Rules: the transcript is never tone evidence; scripted-speech scores are not shown; tone info only when flagged lowConfidence; never an all-clear
// while key ideas are missing or the meaning was not checked; never claim coverage the backend did not report.
import { normalizeWordStatus } from "./highlight.js";

const MISSING_KINDS = new Set(["omission", "missing", "missing_idea", "wrong_meaning", "key_idea", "idea"]);
const WORDING_KINDS = new Set(["language", "wording", "unnatural", "unnatural_wording", "wrong_wording", "wrong_word"]);

/** Split coach corrections into what the retell result shows in separate places. Order preserved. */
export function splitCorrections(corrections) {
  const out = { missing: [], wording: [], other: [] };
  for (const c of Array.isArray(corrections) ? corrections : []) {
    if (!c || typeof c !== "object") continue;
    const kind = String(c.kind || "").toLowerCase();
    const item = { kind, text: String(c.targetText || ""), model: String(c.modelText || ""), explanation: String(c.explanationZh || ""), caption: c.caption || "", heard: String(c.heard || ""), ideaId: c.ideaId || "", start: c.start, end: c.end, raw: c };
    if (MISSING_KINDS.has(kind)) out.missing.push(item);
    else if (WORDING_KINDS.has(kind)) out.wording.push(item);
    else out.other.push(c);
  }
  return out;
}

const cov = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : v === "partial" ? "partial" : undefined);
/**
 * assessment.retell -> {status:"ok"|"unavailable", reason, ideas:[{id,text,start,end,covered,evidence,confidence,issue}], counts, full, tone, suggestedWords} | null (no block).
 * Counts and "full praise" are re-derived from the ideas here (never trusted blindly); offsets are kept only when they fit the chunk (code points, end exclusive).
 */
export function normalizeRetellBlock(raw, chunkText = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const len = cps(chunkText).length;
  const ideas = (raw.comparisonStatus === "ok" && Array.isArray(raw.ideas) ? raw.ideas : []).map((x, i) => {
    const covered = x && cov(x.covered);
    if (!x || typeof x !== "object" || covered === undefined || typeof x.textZh !== "string" || !x.textZh.trim()) return null;
    const ok = Number.isInteger(x.refStart) && Number.isInteger(x.refEnd) && x.refStart >= 0 && x.refEnd > x.refStart && (!len || x.refEnd <= len);
    return { id: typeof x.id === "string" ? x.id : `i${i + 1}`, text: x.textZh.trim(), start: ok ? x.refStart : undefined, end: ok ? x.refEnd : undefined, covered,
      evidence: typeof x.evidence === "string" && x.evidence.trim() ? x.evidence.trim() : null, confidence: ["high", "medium", "low"].includes(x.confidence) ? x.confidence : "medium",
      issue: x.issue === "wrong_meaning" ? "wrong_meaning" : null };
  }).filter(Boolean);
  const status = raw.comparisonStatus === "ok" && ideas.length ? "ok" : "unavailable";
  const n = (f) => ideas.filter(f).length;
  const full = status === "ok" && n((x) => x.covered === true) === ideas.length && ideas.every((x) => x.confidence !== "low") && raw.canPraise !== false;
  const tone = raw.tone && typeof raw.tone === "object" ? { status: String(raw.tone.status || ""), reason: String(raw.tone.reason || "") } : { status: "", reason: "" };
  const suggestedWords = (Array.isArray(raw.suggestedWords) ? raw.suggestedWords : []).filter((w) => w && typeof w.text === "string" && w.text.trim())
    .map((w) => ({ text: w.text.trim(), pinyin: typeof w.pinyin === "string" ? w.pinyin : "", meaning: typeof w.meaning === "string" ? w.meaning : "", ideaId: w.ideaId || "" })).slice(0, 6);
  return { status, reason: String(raw.comparisonReason || ""), ideas, covered: n((x) => x.covered === true), partial: n((x) => x.covered === "partial"), missing: n((x) => x.covered === false && !x.issue),
    wrong: n((x) => x.covered === false && !!x.issue), full, tone, model: typeof raw.model === "string" ? raw.model : "", suggestedWords };
}
/** covered | partial | missing | wrong */
export const ideaKind = (i) => (i.covered === true ? "covered" : i.covered === "partial" ? "partial" : i.issue ? "wrong" : "missing");

/** Optional future field: keyIdeas [{text, covered:boolean|status:'covered'|'missed', start?, end?}]. Returns [] when absent/garbled. */
export function normalizeKeyIdeas(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    if (!x || typeof x !== "object" || typeof x.text !== "string" || !x.text.trim()) return null;
    const covered = typeof x.covered === "boolean" ? x.covered : x.status === "covered" ? true : x.status === "missed" || x.status === "missing" ? false : null;
    return { text: x.text.trim(), covered, start: Number.isInteger(x.start) ? x.start : undefined, end: Number.isInteger(x.end) ? x.end : undefined };
  }).filter(Boolean);
}

const cps = (s) => Array.from(String(s || ""));
function findCp(refCps, needle, taken) {
  const n = cps(needle); if (!n.length) return -1;
  for (let i = 0; i + n.length <= refCps.length; i++) {
    if (taken.some(([a, b]) => i < b && i + n.length > a)) continue;
    let ok = true; for (let j = 0; j < n.length; j++) if (refCps[i + j] !== n[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/**
 * Place missing ideas in the reference text. Uses start/end when they check out (code points, end exclusive, slice === text), else finds the text
 * (targetText, then modelText) in the reference. Never guesses: an idea that can't be placed is returned in `unplaced` (the UI lists it without highlight).
 * @returns {{wordStatus:Array, placed:Array, unplaced:Array}}  wordStatus is ready for highlightPieceHtml (status "missed").
 */
export function placeIdeas(referenceText, ideas) {
  const ref = cps(referenceText), taken = [], entries = [], placed = [], unplaced = [];
  for (const it of ideas || []) {
    let start = -1, end = -1;
    const want = it.text || it.model;
    if (Number.isInteger(it.start) && Number.isInteger(it.end) && it.start >= 0 && it.end > it.start && it.end <= ref.length
      && (!want || ref.slice(it.start, it.end).join("") === want || !it.text)) { start = it.start; end = it.end; }
    if (start < 0) for (const needle of [it.text, it.model]) { if (!needle) continue; const i = findCp(ref, needle, taken); if (i >= 0) { start = i; end = i + cps(needle).length; break; } }
    if (start < 0 || taken.some(([a, b]) => start < b && end > a)) { unplaced.push(it); continue; }
    taken.push([start, end]); placed.push({ ...it, start, end });
    entries.push({ start, end, text: ref.slice(start, end).join(""), pinyin: "", status: "missed", reason: "omitted" });
  }
  return { wordStatus: normalizeWordStatus(entries, referenceText), placed, unplaced };
}

/** Tone info is allowed in retell ONLY when the backend flags it as reduced-confidence (basis "transcript" + lowConfidence). */
export const toneAllowed = (a) => !!a && (a.basis !== "transcript" || a.lowConfidence === true);

/**
 * The retell verdict. state: pending | gated | nospeech | unchecked | missing | checked.
 * Input: {assessment (normalized), corrections, keyIdeas?, streamEnded, coachSkipped, summary}
 * "checked" means the coach compared the meaning and flagged nothing: it is NOT "all correct" (the coach reports at most 2 gaps).
 */
export function retellOutcome({ assessment: a, corrections, keyIdeas, streamEnded, coachSkipped, summary } = {}) {
  if (!a || !a.ok) return { state: "none", label: "No assessment obtained", note: "", badge: "?" };
  if (a.gated) return { state: "gated", label: "I couldn't make out a clear retelling", note: "Nothing was marked. Try again, a little closer to the microphone.", badge: "?" };
  if (!String(a.transcript || "").trim()) return { state: "nospeech", label: "I couldn't hear what you said", note: "Nothing was marked. Try again.", badge: "?" };
  const info = a.retellInfo;
  if (info) {   // structured meaning comparison from the backend
    if (info.status !== "ok") {
      const why = { llm_not_configured: "The coach isn't set up on the server, so I couldn't compare the meaning.", low_match: "The recording didn't match what was transcribed." }[info.reason] || "Nothing is marked as covered.";
      return { state: "unchecked", label: "I couldn't check the meaning this time", note: `${why} Try again for coach feedback.`, badge: "?" };
    }
    const bad = info.missing + info.wrong;
    if (bad > 0) {
      const label = info.wrong === 0 ? (bad === 1 ? "1 key idea missing" : `${bad} key ideas missing`) : info.missing === 0 ? (bad === 1 ? "1 idea differs from the original" : `${bad} ideas differ from the original`) : `${bad} key ideas missing or different`;
      return { state: "missing", count: bad, label, note: "Your own wording is fine. Try to include what's marked below.", badge: "!" };
    }
    if (info.partial > 0) return { state: "partial", count: info.partial, label: info.partial === 1 ? "1 idea only partly covered" : `${info.partial} ideas only partly covered`, note: "Nothing is missing, but not everything was said in full.", badge: "~" };
    if (info.full) return { state: "covered", label: "All key ideas covered", note: "Compared by meaning: your own wording is fine.", badge: "\u2713" };
    return { state: "checked", label: "No missing ideas flagged", note: "I'm not fully sure about some ideas, so this isn't a full all-clear.", badge: "\u2713" };
  }
  const sp = splitCorrections(corrections);
  const ideas = normalizeKeyIdeas(keyIdeas);
  const missing = [...sp.missing.map((m) => m.text || m.model).filter(Boolean), ...ideas.filter((i) => i.covered === false).map((i) => i.text)];
  const nMissing = Math.max(sp.missing.length, new Set(missing).size);
  if (nMissing > 0) return { state: "missing", count: nMissing, label: nMissing === 1 ? "1 key idea missing" : `${nMissing} key ideas missing`, note: "Your own wording is fine. Try to include the missing idea.", badge: "!" };
  if (!streamEnded) return { state: "pending", label: "Checking the meaning…", note: "", badge: "?" };
  const coached = summary && typeof summary.coached === "boolean" ? summary.coached : !coachSkipped;
  if (coachSkipped || !coached) return { state: "unchecked", label: "I couldn't check the meaning this time", note: "Nothing is marked as covered. Try again for coach feedback.", badge: "?" };
  return { state: "checked", label: "No missing ideas flagged", note: "The coach compared the meaning with the original. This is not a full marking: wording changes are fine.", badge: "\u2713" };
}

/** Does this outcome count as a pass (fade progress / session stats)? Only "checked". */
export const retellPassed = (o) => !!o && (o.state === "checked" || o.state === "covered");

/** "toneperfect · model 2.1 · speech-to-text transcript · coach <model>" (only what the payloads actually say). */
export function modelLine(a, summary) {
  if (!a) return "";
  const parts = [];
  if (a.mock) parts.push(`MOCK engine (${a.engine || "mock"}): simulated`);
  else parts.push(a.engine ? `Engine: ${a.engine}` : "Engine: unknown");
  if (a.modelVersion) parts.push(`model ${a.modelVersion}`);
  if (a.transcript) parts.push("speech-to-text transcript");
  const sm = summary || {};
  const coach = (a.retellInfo && a.retellInfo.model) || sm.compareModel || sm.coachModel || sm.llmModel;
  if (coach) parts.push(`coach ${coach}`);
  return parts.join(" \u00b7 ");
}
