#!/usr/bin/env node
// OFFLINE report: builds test-results/VALIDATION.md from the CACHED real-clip results (test/fixtures/real-clips) +
// labels.json, applying the current assessment policy. Makes NO network calls and needs NO keys.
//   node server/scripts/report-validation.js
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, ASSESSMENT_POLICY as P } from '../config.js';
import { applyPolicy } from '../engines/assessment/policy.js';
import { deriveFacts } from '../engines/assessment/derive.js';

const dir = path.join(APP_ROOT, 'server', 'test-results');
const fx = path.join(APP_ROOT, 'server', 'test', 'fixtures', 'real-clips');
const labels = JSON.parse(fs.readFileSync(path.join(fx, 'labels.json'), 'utf8'));
const names = Object.keys(labels).filter((k) => !k.startsWith('_'));
const clip = (n) => JSON.parse(fs.readFileSync(path.join(fx, `${n}.json`), 'utf8'));
const f1 = (x) => (x == null ? '–' : String(x));

let before = { TP: 0, FP: 0 }; let after = { TP: 0, FP: 0 };
let correctSylls = 0; let fpBeforeSylls = 0; let fpAfterSylls = 0;
const correctClips = []; const sections = []; const gateRows = [];
const all = [];

for (const n of names) {
  const L = labels[n]; const { referenceText, result: raw } = clip(n);
  const pol = applyPolicy(raw); const facts = deriveFacts(pol);
  const kept = new Set(facts.confirmedToneErrors.map((f) => f.ref));
  const rawFlags = raw.syllables.filter((s) => s.tone.decision === 'review');
  all.push({ n, L, raw, pol, kept, rawFlags });
  const mismatch = L.mismatch || L.noSpeech;
  let s = `### ${n}\n- **Intended text (reference sent):** ${referenceText}\n- **What was actually said:** ${L.intent}\n`;
  s += `- **Engine (raw):** overall ${raw.overall}, pronunciation ${raw.scores?.pronunciation}, tone ${raw.scores?.tone}, warnings: ${raw.warnings?.join(', ') || 'none'}; credits ${raw.meta?.creditsCharged}\n`;
  s += `- **After policy:** ${pol.gate ? `**GATED (${pol.gate})**: ${pol.gateReasons.join('; ')}; no tone/sound claims, coach says 请再说一遍这句话。` : `matchesText ${pol.matchesText}; confirmed tone claims ${facts.confirmedToneErrors.length}; demoted to uncertain ${pol.policy.demoted.length}`}\n\n`;
  if (rawFlags.length || raw.syllables.some((x) => x.final.decision === 'review' || x.initial.decision === 'review')) {
    s += '| syllable | tone expected→heard | tone score | raw decision | judgment | basis for judgment | after policy |\n|---|---|---|---|---|---|---|\n';
    for (const sy of raw.syllables) {
      const isReview = sy.tone.decision === 'review';
      const soundReview = ['initial', 'final'].filter((d) => sy[d].decision === 'review');
      if (!isReview && !soundReview.length) continue;
      const ref = `tone:${sy.index}`; const J = L.flags[ref];
      const judg = mismatch ? 'invalid (audio does not match text)' : J ? J.label : '–';
      const basis = mismatch ? 'reference text does not describe the audio, so any per-syllable flag is meaningless' : J ? J.basis : '–';
      const aft = isReview ? (pol.gate ? 'suppressed (gate)' : kept.has(ref) ? 'KEPT as confirmed claim' : `demoted → uncertain (${pol.policy.demoted.find((d) => d.ref === ref)?.reason})`) : '–';
      const tn = isReview ? `${f1(sy.tone.expected)}→${f1(sy.tone.heard)}` : '–';
      s += `| ${sy.index} ${sy.char} | ${tn} | ${isReview ? sy.tone.score : '–'} | ${isReview ? 'review' : `${soundReview.join('/')} review (sound, never a claim)`} | ${judg} | ${basis} | ${aft} |\n`;
    }
    s += '\n';
  } else s += 'No `review` flags in this clip.\n\n';
  sections.push(s);

  if (!mismatch) {
    for (const sy of raw.syllables) {
      const ref = `tone:${sy.index}`; const flagged = sy.tone.decision === 'review'; const lab = L.flags[ref]?.label;
      if (flagged) { before[lab] += 1; if (kept.has(ref)) after[lab] += 1; }
      if (lab !== 'TP') { correctSylls += 1; if (flagged) fpBeforeSylls += 1; if (kept.has(ref)) fpAfterSylls += 1; }
    }
    if (L.correct) correctClips.push({ n, before: rawFlags.length > 0, after: kept.size > 0 });
  }
  gateRows.push(`| ${n} | ${raw.overall} | ${raw.scores?.pronunciation} | ${raw.warnings?.join(',') || '–'} | ${pol.gate ? 'GATED' : 'pass'} |`);
}

// threshold sensitivity (tone score), no density/cap
const sens = [60, 65, 67.4, 70, 75, 75.7, 80].map((T) => {
  let tp = 0; let fp = 0;
  for (const { L, raw } of all) if (!(L.mismatch || L.noSpeech)) for (const sy of raw.syllables) if (sy.tone.decision === 'review' && sy.tone.score <= T) (L.flags[`tone:${sy.index}`].label === 'TP' ? (tp += 1) : (fp += 1));
  return `| ≤ ${T} | ${tp} | ${fp} |`;
});
// ablation: density rule on RAW flags (before the score threshold)
const dens = all.filter(({ L }) => !(L.mismatch || L.noSpeech)).map(({ n, raw, rawFlags }) => `${n}: ${rawFlags.length}/${raw.syllables.length} raw flags${raw.syllables.length >= P.TONE_DENSITY_MIN_SYLLABLES && rawFlags.length / raw.syllables.length > P.TONE_DENSITY_MAX_RATIO ? ' → raw-density rule WOULD demote all' : ''}`);
const tpScores = []; const fpScores = [];
for (const { L, raw } of all) if (!(L.mismatch || L.noSpeech)) for (const sy of raw.syllables) if (sy.tone.decision === 'review') (L.flags[`tone:${sy.index}`].label === 'TP' ? tpScores : fpScores).push(sy.tone.score);
const nCorrectBefore = correctClips.filter((c) => c.before).length; const nCorrectAfter = correctClips.filter((c) => c.after).length;
const pct = (a, b) => `${a}/${b} (${Math.round((100 * a) / b)}%)`;

let md = `# Validation report: TonePerfect on real speech + the coaching policy

**Read this first.** n = 8 clips (6 genuine attempts + 1 room-noise + 1 wrong-sentence), **one speaker (Chris)**, one phone, one session, 3 deliberate tone errors in total. That is far too small to prove anything about accuracy, false-positive rate or threshold choice. Everything below is **indicative of the failure modes we saw, not evidence that the policy generalises**. "True/false positive" labels are **instruction-based** (what Chris was asked to say; for deliberate errors we also check that the engine's heard tone equals the tone he was asked to produce). Nobody re-listened to the audio; no native-speaker review. The thresholds were chosen from these same 8 clips, so they are fitted to them (overfit risk is real).

Generated by \`node server/scripts/report-validation.js\` from cached results only (\`test/fixtures/real-clips/*.json\`, \`labels.json\`); no network, no API key. Credits spent on the real clips: 8 (the planned free "silence" and "wrong sentence" clips were both assessable and billed 1 credit each, contrary to NEEDED-RECORDINGS.md's expectation). Raw synthetic-speech appendix: \`VALIDATION-SYNTHETIC.md\`.

## Verification of the coordinator's findings (from the cached JSON)
1. *'review' fires on real speech:* **confirmed.** 03 flagged 谢#2 (4→2, tone score 60); 05 flagged 学 (2→4, 60) and 中 (1→3, 67.4). The heard tones equal the tones Chris was asked to produce (rising, falling, 3rd).
2. *False positives on correct clips:* **confirmed**, with a correction: there are **4** correct clips (01, 02, 04, 06), not 3; 2 of them flagged (02: 谢#2 4→3, score 60; 04: 欢 1→2, score 75.7). 05 also flagged 我 (3→1, 75.6), 喜 (3→2, 75.1), 欢 (1→2, 75.7) which were not meant to be altered (5 of 6 syllables flagged in that clip, 2 real). Note the 欢 1→2 / 75.7 flag is identical in 04 and 05.
3. *Wrong sentence & "silence":* **confirmed.** 08: overall 0.2, pronunciation 32.2, status ok, every unit decision \`review\` (tone 4→3 at the 60 floor, initial/final at the 10 floor). 07 (room noise, not silence): overall 2.3, pronunciation 45.5, assessable, warnings \`content\` (also present on 08 and on no genuine clip); one *final* flagged \`review\`. Both billed 1 credit. Additional observation: per-syllable tone score never goes below 60 and initial/final never below 10 in this data, so 60/10 look like floors; a flag at 60 therefore means "at the floor", not a graded value.

## Policy (engines/assessment/policy.js; constants in config.js \`ASSESSMENT_POLICY\`)
| constant | value | meaning |
|---|---|---|
| LOW_MATCH_OVERALL_MAX | ${P.LOW_MATCH_OVERALL_MAX} | overall < this ⇒ gate \`low_match\` |
| LOW_MATCH_PRONUNCIATION_MAX | ${P.LOW_MATCH_PRONUNCIATION_MAX} | pronunciation < this ⇒ gate \`low_match\` |
| TONE_REVIEW_MAX_SCORE | ${P.TONE_REVIEW_MAX_SCORE} | a \`review\` tone flag is a claim only if tone score ≤ this (and heard ≠ expected) |
| TONE_MAX_CLAIMS | ${P.TONE_MAX_CLAIMS} | at most this many tone claims, lowest tone score first; others → uncertain |
| TONE_DENSITY_MAX_RATIO / MIN_SYLLABLES | ${P.TONE_DENSITY_MAX_RATIO} / ${P.TONE_DENSITY_MIN_SYLLABLES} | if more than 40% of syllables (chunks ≥ 4 syllables) still carry a claim ⇒ demote all |

Demoted flags become \`uncertain\`, with \`heard\` withheld, so the coach may only say "not sure" and model the sound.

### Why these values
- **Gate.** Mismatched audio: overall 0.2 and 2.3, pronunciation 32.2 and 45.5. Genuine attempts (including the deliberately mangled clip 05): overall ≥ 57, pronunciation ≥ 86.2. Both signals have a very wide empty gap (overall 2.3…57, pronunciation 45.5…86.2), so any threshold inside it gives the same result on these clips. 40/60 were chosen on the cautious side: a wrongly gated poor attempt just gets "please say it again", while coaching noise would produce claims about nothing. The vendor's \`content\` warning matched exactly the two mismatched clips but is **not** used as a trigger (its meaning is undocumented to us). A real beginner who scores < 40 would also be gated; untested.
- **Tone score threshold.** Flags on the 3 deliberate errors (judged true) had tone scores ${tpScores.sort((a, b) => a - b).join(', ')}; flags judged false ${fpScores.sort((a, b) => a - b).join(', ')}. The scores **partially** separate them: everything above 67.4 is false in this data, but **two flags at the 60 floor cannot be separated** (02's false flag and 03's real one are the same syllable of the same text with the same score 60, and clip 02's heard tone 3 may even be an acceptable neutral-tone 谢谢). 70 lies in the single gap (67.4…75.1); any value in [67.4, 75.1) gives identical results (table below). With only 3 real errors the true boundary is unknown; real mild errors with scores 70–80 will be silently dropped (the cost of being conservative).
- **Cap 2** matches the coaching limit; lowest score first.
- **Density rule on post-threshold flags.** Applied to *raw* flags it would have demoted both real errors in clip 05 (5/6 raw flags). I deliberately apply it after the score threshold and disclose that this choice was made knowing that result; on these clips the density rule never fires (so it is untested on real data and exists only as a backstop).

#### Sensitivity (tone score threshold only; 3 real errors, 5 false flags in the 6 genuine clips)
| threshold | real errors kept | false flags kept |
|---|---|---|
${sens.join('\n')}

#### Raw-flag density (ablation, not applied)
${dens.map((d) => `- ${d}`).join('\n')}

## Results
### Gate on all 8 clips
| clip | overall | pronunciation | warnings | gate |
|---|---|---|---|---|
${gateRows.join('\n')}

Genuine clips gated: 0 of 6. Mismatched clips gated: 2 of 2 (08 wrong sentence overall 0.2; 07 room noise overall 2.3). Both get an assessment event with \`matchesText:false\`, \`gate:'low_match'\`, empty facts, the fixed spoken line 请再说一遍这句话。, no LLM call, \`corrections: []\`.

### Tone flags before vs after the policy (6 genuine clips)
| | before policy | after policy |
|---|---|---|
| real errors kept (of ${before.TP} deliberate) | ${before.TP} | ${after.TP} |
| false flags | ${before.FP} | ${after.FP} |
| correct clips (01,02,04,06) with ≥ 1 false flag | ${pct(nCorrectBefore, correctClips.length)} | ${pct(nCorrectAfter, correctClips.length)} |
| false flags per intended-correct syllable (${correctSylls} syllables in the 6 genuine clips) | ${pct(fpBeforeSylls, correctSylls)} | ${pct(fpAfterSylls, correctSylls)} |
| precision of tone claims | ${pct(before.TP, before.TP + before.FP)} | ${pct(after.TP, after.TP + after.FP)} |

Remaining false flag: clip 02 (谢#2, score 60). **True positives lost: 0 of 3** (but 3 is a tiny sample). The apparent improvement is partly by construction, because the threshold was set inside the gap in this very data.

## Per-clip tables
${sections.join('')}
## What this does NOT tell us
- Whether the false-flag rate on correct speech is 5% or 40%: after policy it is 1 flag in ${correctSylls} syllables on one speaker.
- Whether real mild tone errors (scores 70–80) exist and are being hidden.
- Whether other speakers, phones, rooms, or longer sentences behave the same; iPhone PWA recordings (mp4) were not tested here (these were m4a files).
- Whether the neutral-tone convention (谢谢, 妈妈…) produces systematic false flags; one clip suggests it might.
- The real recordings are not committed as audio fixtures; tests use only the cached normalized results.

## Appendix
Synthetic-speech run (8 credits, TTS audio, indicative only): see \`VALIDATION-SYNTHETIC.md\`.
`;
fs.writeFileSync(path.join(dir, 'VALIDATION.md'), md);
console.log('wrote test-results/VALIDATION.md', JSON.stringify({ before, after, correctSylls, fpBeforeSylls, fpAfterSylls }));
