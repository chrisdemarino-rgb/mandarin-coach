// Pure helpers: turn a backend `assessment` event into what the UI shows. No DOM. Node-testable.
// Rules (PLAN.md): only tone decision === "review" is a mistake; "uncertain" is shown softly as "not sure";
// no score of 0 / invented scores (overall may be null); status !== "ok" means NO assessment.

const HAN = /[\u3400-\u9fff]/;

const toneDec = (s) => s && s.tone && s.tone.decision;
const anyUncertain = (s) => ["initial", "final", "tone"].filter((d) => s && s[d] && s[d].decision === "uncertain");

/** @returns {{ok:boolean, status, engine, mock, overall:number|null, chars:Array, confirmed:Array, uncertain:Array, basis, referenceText, transcript, lowConfidence, syllables:Array}} */
export function normalizeAssessment(data, fallbackText = "") {
  const d = data || {};
  const ok = d.status === "ok" || (d.status === undefined && Array.isArray(d.syllables) && d.syllables.length > 0);
  const syllables = ok && Array.isArray(d.syllables) ? [...d.syllables].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  const overall = ok && typeof d.overall === "number" && Number.isFinite(d.overall) && d.overall > 0 ? Math.round(d.overall) : null;

  // facts: trust the server's, else derive from syllables
  const confirmed = ok
    ? (d.facts && Array.isArray(d.facts.confirmedToneErrors)
      ? d.facts.confirmedToneErrors.map((f) => ({ index: f.index, char: f.char, pinyin: f.pinyin, expected: f.expectedTone, heard: f.heardTone }))
      : syllables.filter((s) => toneDec(s) === "review").map((s) => ({ index: s.index, char: s.char, pinyin: s.pinyin, expected: s.tone.expected, heard: s.tone.heard })))
    : [];
  const uncertain = ok
    ? (d.facts && Array.isArray(d.facts.uncertain)
      ? d.facts.uncertain.map((f) => ({ index: f.index, char: f.char, dimension: f.dimension }))
      : syllables.flatMap((s) => anyUncertain(s).map((dim) => ({ index: s.index, char: s.char, dimension: dim }))))
    : [];

  const referenceText = d.referenceText || fallbackText || "";
  const byIdx = new Map(syllables.map((s, i) => [s.index ?? i, s]));
  const confMap = new Map(confirmed.map((c) => [c.index, c]));
  const uncMap = new Map();
  uncertain.forEach((u) => { const a = uncMap.get(u.index) || []; a.push(u.dimension); uncMap.set(u.index, a); });

  // chars: walk the reference text and attach syllables to Han characters in order (only if counts line up)
  const refChars = [...referenceText];
  const hanN = refChars.filter((c) => HAN.test(c)).length;
  const sylList = syllables;
  let chars;
  if (ok && hanN === sylList.length && hanN > 0) {
    let k = 0;
    chars = refChars.map((ch) => {
      if (!HAN.test(ch)) return { ch, han: false };
      const s = sylList[k++];
      return charInfo(ch, s, confMap, uncMap);
    });
  } else {
    chars = sylList.map((s) => charInfo(s.char, s, confMap, uncMap));
  }
  return {
    ok, status: ok ? "ok" : "unavailable", engine: d.engine || "", mock: d.mock === true, modelVersion: d.modelVersion || "",
    overall, chars, confirmed, uncertain, syllables, basis: d.basis || "script", referenceText,
    transcript: d.transcript || "", lowConfidence: !!d.lowConfidence, byIdx,
  };
}

function charInfo(ch, s, confMap, uncMap) {
  const idx = s ? (s.index ?? 0) : -1;
  const c = confMap.get(idx);
  return {
    ch, han: true, index: idx, pinyin: s ? s.pinyin || "" : "",
    review: c ? { expected: c.expected, heard: c.heard } : null,
    unsure: uncMap.has(idx) ? uncMap.get(idx) : null,
  };
}

/** Passed = a real assessment with no confirmed tone error. (Overall grade alone is never a diagnosis.) */
export const isPass = (a) => !!(a && a.ok && a.confirmed.length === 0);

/** One-line verdict, English. */
export function verdict(a) {
  if (!a || !a.ok) return "No assessment obtained";
  const n = a.confirmed.length, u = new Set(a.uncertain.map((x) => x.index)).size;
  const parts = [];
  parts.push(n === 0 ? "No tone problems detected" : n === 1 ? "1 tone to review" : `${n} tones to review`);
  if (u) parts.push(u === 1 ? "not sure about 1 sound" : `not sure about ${u} sounds`);
  return parts.join(" · ");
}

/** Pinyin per Han char (numeric) from an assessment, keyed by position among the piece's Han characters. */
export function pinyinByHanIndex(a) {
  const out = [];
  if (!a || !a.ok) return out;
  for (const c of a.chars) if (c.han) out.push(c.pinyin || "");
  return out;
}

/** Outcome label for POST /api/words/:id/history for a saved word text appearing in the piece. null if not in piece. */
export function wordOutcome(a, wordText, pieceSpoken) {
  if (!a || !a.ok) return null;
  const han = [...pieceSpoken].filter((c) => HAN.test(c));
  const w = [...wordText].filter((c) => HAN.test(c));
  if (!w.length) return null;
  const hay = han.join("");
  const at = hay.indexOf(w.join(""));
  if (at < 0) return null;
  const idxs = new Set(a.chars.filter((c) => c.han).slice(at, at + w.length).map((c) => c.index));
  if (a.confirmed.some((c) => idxs.has(c.index))) return "tone_error";
  if (a.uncertain.some((c) => idxs.has(c.index))) return "uncertain";
  return "ok";
}
