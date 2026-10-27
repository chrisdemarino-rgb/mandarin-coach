// Engine-agnostic POLICY applied after an engine's result is normalized (never inside a vendor adapter).
// Goal: the coach may only make a tone claim when the evidence is strong, and never coach audio that does not
// match the text. Thresholds are named constants in config.js (ASSESSMENT_POLICY) with the data they came from.
//
//  1. Gate 'low_match': overall or pronunciation extremely low => status stays 'ok' but matchesText:false,
//     gate:'low_match'; ALL per-syllable decisions are neutralised (no_decision) and heard values withheld.
//  2. Tone flags: decision==='review' is necessary but not sufficient. A flag is a *confirmed claim* only if
//     tone.score <= TONE_REVIEW_MAX_SCORE and heard differs from expected. Otherwise it is demoted to 'uncertain'
//     (heard withheld, so nobody can say "I heard tone X"). Then the density rule, then the claim cap.
//  3. The result carries `policy` (what was demoted and why) for transparency/tests; nothing else is altered.
import { ASSESSMENT_POLICY } from '../../config.js';

export const POLICY_VERSION = 1;
export const GATE_MESSAGE_EN = "That recording doesn't seem to match the sentence (or I couldn't hear speech). Please say the sentence again.";

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function applyPolicy(input, P = ASSESSMENT_POLICY) {
  if (!input || input.status !== 'ok') return input;
  const result = structuredClone(input);
  const syl = result.syllables || [];
  const rawReviews = syl.filter((s) => s.tone?.decision === 'review');
  const thresholds = { ...P };

  // ---- 1. gate
  const reasons = [];
  const pron = result.scores?.pronunciation;
  if (isNum(result.overall) && result.overall < P.LOW_MATCH_OVERALL_MAX) reasons.push(`overall ${result.overall} < ${P.LOW_MATCH_OVERALL_MAX}`);
  if (isNum(pron) && pron < P.LOW_MATCH_PRONUNCIATION_MAX) reasons.push(`pronunciation ${pron} < ${P.LOW_MATCH_PRONUNCIATION_MAX}`);
  if (reasons.length) {
    for (const s of syl) {
      for (const dim of ['initial', 'final', 'tone']) {
        if (s[dim]) s[dim] = { ...s[dim], heard: null, decision: 'no_decision' };
      }
    }
    return { ...result, syllables: syl, matchesText: false, gate: 'low_match', gateReasons: reasons, gateMessage: GATE_MESSAGE_EN,
      policy: { version: POLICY_VERSION, gated: true, rawToneReviews: rawReviews.length, confirmedToneClaims: 0, demoted: [], thresholds } };
  }

  // ---- 2. tone-claim policy
  const demoted = [];
  const demote = (s, reason) => {
    demoted.push({ ref: `tone:${s.index}`, reason, score: s.tone.score ?? null });
    s.tone = { ...s.tone, heard: null, decision: 'uncertain', demotedFrom: 'review', demotedReason: reason };
  };
  let passing = [];
  for (const s of rawReviews) {
    const t = s.tone;
    if (!isNum(t.score)) demote(s, 'no_score');
    else if (t.score > P.TONE_REVIEW_MAX_SCORE) demote(s, 'score_above_threshold');
    else if (t.heard == null || t.heard === t.expected) demote(s, 'no_heard_mismatch');
    else passing.push(s);
  }
  if (syl.length >= P.TONE_DENSITY_MIN_SYLLABLES && passing.length / syl.length > P.TONE_DENSITY_MAX_RATIO) {
    for (const s of passing) demote(s, 'too_many_flags');
    passing = [];
  }
  passing.sort((a, b) => a.tone.score - b.tone.score || a.index - b.index);
  for (const s of passing.slice(P.TONE_MAX_CLAIMS)) demote(s, 'over_claim_cap');
  const kept = Math.min(passing.length, P.TONE_MAX_CLAIMS);

  return { ...result, syllables: syl, matchesText: true, gate: null,
    policy: { version: POLICY_VERSION, gated: false, rawToneReviews: rawReviews.length, confirmedToneClaims: kept, demoted, thresholds } };
}

/** Wrap any engine so every normalized result passes through the policy. */
export function withPolicy(engine, P = ASSESSMENT_POLICY) {
  return { ...engine, async assess(args) { return applyPolicy(await engine.assess(args), P); } };
}
