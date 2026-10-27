// Derived facts, computed by CODE (never by an LLM) from a normalized assessment.
// confirmedToneErrors = tone.decision === 'review' (after engines/assessment/policy.js: only strong, capped flags remain);
// uncertain = any component decision 'uncertain' (incl. demoted tone flags). `heard` is deliberately NOT exposed for uncertain
// items: they are never claimed as errors, so nobody may say what was heard. Gated results have neither.
export function deriveFacts(assessment) {
  const facts = { confirmedToneErrors: [], uncertain: [] };
  if (!assessment || assessment.status !== 'ok' || assessment.gate === 'low_match') return facts;
  for (const s of assessment.syllables || []) {
    if (s.tone?.decision === 'review') {
      facts.confirmedToneErrors.push({
        ref: `tone:${s.index}`, index: s.index, char: s.char, pinyin: s.pinyin,
        expectedTone: s.tone.expected, heardTone: s.tone.heard, score: s.tone.score,
      });
    }
    for (const dim of ['initial', 'final', 'tone']) {
      const c = s[dim];
      if (c?.decision === 'uncertain') {
        facts.uncertain.push({ ref: `${dim}:${s.index}`, index: s.index, char: s.char, dimension: dim, expected: c.expected, score: c.score, ...(c.demotedReason ? { demotedReason: c.demotedReason } : {}) });
      }
    }
  }
  return facts;
}
