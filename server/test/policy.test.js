import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPolicy } from '../engines/assessment/policy.js';
import { deriveFacts } from '../engines/assessment/derive.js';
import { ASSESSMENT_POLICY as P, loadConfig } from '../config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-clips');
const clip = (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
const run = (n) => { const r = applyPolicy(clip(n).result); return { r, facts: deriveFacts(r) }; };
const refs = (facts) => facts.confirmedToneErrors.map((f) => f.ref);

// ---- synthetic helpers
const syl = (i, { tone = [1, 1, 90, 'no_correction'] } = {}) => ({ index: i, char: '字', pinyin: 'zi1', wordIndex: i,
  initial: { expected: 'z', heard: 'z', score: 90, decision: 'no_correction' }, final: { expected: 'i', heard: 'i', score: 90, decision: 'no_correction' },
  tone: { expected: tone[0], heard: tone[1], score: tone[2], decision: tone[3] } });
const ok = (syllables, o = {}) => ({ status: 'ok', engine: 'x', mock: false, overall: 90, scores: { overall: 90, pronunciation: 90 }, syllables, words: [], ...o });

test('constants are named in config and exposed on cfg', () => {
  assert.deepEqual({ ...loadConfig({ NODE_ENV: 'test' }).policy }, { ...P });
  for (const k of ['LOW_MATCH_OVERALL_MAX', 'LOW_MATCH_PRONUNCIATION_MAX', 'TONE_REVIEW_MAX_SCORE', 'TONE_MAX_CLAIMS', 'TONE_DENSITY_MAX_RATIO', 'TONE_DENSITY_MIN_SYLLABLES', 'ACOUSTIC_MISSING_WORD_MAX', 'ACOUSTIC_INITIAL_ABSENT_MAX', 'STT_MIN_COVERAGE', 'STT_WAIT_MS', 'LONG_PAUSE_MS', 'SAVE_LOW_SCORE_WORD_MAX']) assert.equal(typeof P[k], 'number', k);
  assert.throws(() => { 'use strict'; P.TONE_MAX_CLAIMS = 9; }); // frozen
});

test('gate: boundaries on overall and pronunciation; unavailable results pass through untouched', () => {
  const s = [syl(0, { tone: [4, 2, 60, 'review'] })];
  assert.equal(applyPolicy(ok(s, { overall: P.LOW_MATCH_OVERALL_MAX })).gate, null);
  assert.equal(applyPolicy(ok(s, { overall: P.LOW_MATCH_OVERALL_MAX - 0.1 })).gate, 'low_match');
  assert.equal(applyPolicy(ok(s, { scores: { pronunciation: P.LOW_MATCH_PRONUNCIATION_MAX } })).gate, null);
  assert.equal(applyPolicy(ok(s, { scores: { pronunciation: P.LOW_MATCH_PRONUNCIATION_MAX - 0.1 } })).gate, 'low_match');
  assert.equal(applyPolicy(ok(s, { overall: null, scores: {} })).gate, null); // unknown is not "low"
  const un = { status: 'unavailable', error: { code: 'x' } };
  assert.equal(applyPolicy(un), un);
});

test('gate result: status ok, matchesText false, no decisions, no heard values, empty facts, English message', () => {
  const g = applyPolicy(ok([syl(0, { tone: [4, 3, 60, 'review'] })], { overall: 1 }));
  assert.equal(g.status, 'ok'); assert.equal(g.matchesText, false); assert.equal(g.gate, 'low_match');
  assert.match(g.gateMessage, /doesn't seem to match/); assert.ok(g.gateReasons.length);
  assert.equal(g.syllables[0].tone.decision, 'no_decision'); assert.equal(g.syllables[0].tone.heard, null); assert.equal(g.syllables[0].final.heard, null);
  assert.deepEqual(deriveFacts(g), { confirmedToneErrors: [], uncertain: [] });
  assert.equal(g.policy.gated, true);
});

test('tone flag: review needed but not sufficient (score threshold, heard mismatch); demoted => uncertain with heard withheld', () => {
  const r = applyPolicy(ok([
    syl(0, { tone: [4, 2, P.TONE_REVIEW_MAX_SCORE, 'review'] }),        // boundary: kept
    syl(1, { tone: [4, 2, P.TONE_REVIEW_MAX_SCORE + 0.1, 'review'] }),  // just above: demoted
    syl(2, { tone: [4, null, 50, 'review'] }),                          // nothing heard: no claim possible
    syl(3, { tone: [3, 3, 50, 'review'] }),                             // heard == expected: nothing to claim
    syl(4, { tone: [4, 2, null, 'review'] }),                           // no score
    syl(5, { tone: [4, 2, 30, 'no_correction'] }),                      // never a candidate
    syl(6), syl(7), syl(8), syl(9), syl(10), syl(11),
  ]));
  const f = deriveFacts(r);
  assert.deepEqual(refs(f), ['tone:0']);
  assert.deepEqual(f.uncertain.map((u) => [u.ref, u.demotedReason]), [['tone:1', 'score_above_threshold'], ['tone:2', 'no_heard_mismatch'], ['tone:3', 'no_heard_mismatch'], ['tone:4', 'no_score']]);
  for (const u of f.uncertain) assert.ok(!('heard' in u), 'heard must not be exposed for uncertain items');
  assert.equal(r.syllables[1].tone.heard, null); assert.equal(r.syllables[1].tone.demotedFrom, 'review');
  assert.equal(r.syllables[5].tone.heard, 2); // untouched
  assert.equal(r.policy.rawToneReviews, 5); assert.equal(r.policy.confirmedToneClaims, 1);
  assert.deepEqual(applyPolicy(r).syllables.map((s) => s.tone.decision), r.syllables.map((s) => s.tone.decision)); // idempotent
});

test('claim cap: only the TONE_MAX_CLAIMS lowest tone scores survive, the rest become uncertain', () => {
  const s = Array.from({ length: 12 }, (_, i) => syl(i));
  s[2] = syl(2, { tone: [4, 2, 65, 'review'] }); s[5] = syl(5, { tone: [4, 2, 55, 'review'] }); s[9] = syl(9, { tone: [1, 3, 60, 'review'] });
  const r = applyPolicy(ok(s)); const f = deriveFacts(r);
  assert.deepEqual(refs(f), ['tone:5', 'tone:9']);
  assert.deepEqual(f.uncertain.map((u) => [u.ref, u.demotedReason]), [['tone:2', 'over_claim_cap']]);
});

test('density: too many trusted flags in a longer chunk => engine unreliable, all demoted; short chunks exempt', () => {
  const many = Array.from({ length: 5 }, (_, i) => (i < 3 ? syl(i, { tone: [4, 2, 55, 'review'] }) : syl(i))); // 3/5 = 60% > 40%
  const r = applyPolicy(ok(many));
  assert.deepEqual(refs(deriveFacts(r)), []);
  assert.ok(r.policy.demoted.every((d) => d.reason === 'too_many_flags') && r.policy.demoted.length === 3);
  const short = applyPolicy(ok([syl(0, { tone: [4, 2, 55, 'review'] }), syl(1)])); // 1/2 but < MIN syllables
  assert.deepEqual(refs(deriveFacts(short)), ['tone:0']);
});

// ---------------- the 8 real clips (cached normalized results; no network, no key) ----------------
test('REAL clips 01/06 (correct): nothing flagged, match ok', () => {
  for (const n of ['01-nihao-correct', '06-jintian-tianqi-correct']) {
    const { r, facts } = run(n); assert.equal(r.matchesText, true); assert.deepEqual(refs(facts), []); assert.deepEqual(facts.uncertain, []);
  }
});

test('REAL clips: gate fires on the wrong-sentence clip (08) and the room-noise clip (07), on no genuine clip', () => {
  for (const n of ['07-silence', '08-wrong-sentence']) {
    const { r, facts } = run(n);
    assert.equal(r.status, 'ok'); assert.equal(r.gate, 'low_match', n); assert.equal(r.matchesText, false);
    assert.deepEqual(facts, { confirmedToneErrors: [], uncertain: [] });
    assert.ok(r.syllables.every((s) => ['initial', 'final', 'tone'].every((d) => s[d].decision === 'no_decision' && s[d].heard === null)));
  }
  assert.equal(clip('08-wrong-sentence').result.overall, 0.2); assert.equal(clip('07-silence').result.overall, 2.3);
  for (const n of Object.keys(labels).filter((k) => !k.startsWith('_') && !['07-silence', '08-wrong-sentence'].includes(k))) assert.equal(run(n).r.gate, null, n);
});

test('REAL clips: tone policy outcome (TP kept, 4 of 5 false positives removed; 02 cannot be separated from 03)', () => {
  assert.deepEqual(refs(run('02-xiexie-correct').facts), ['tone:1']);               // remaining FP: score 60, same as the TP in 03
  assert.deepEqual(refs(run('03-xiexie-wrong-tone').facts), ['tone:1']);            // TP kept
  const c4 = run('04-xihuan-zhongwen-correct'); assert.deepEqual(refs(c4.facts), []); assert.deepEqual(c4.facts.uncertain.map((u) => u.ref), ['tone:2']);
  const c5 = run('05-xihuan-zhongwen-wrong-tone');
  assert.deepEqual(refs(c5.facts), ['tone:3', 'tone:4']);                           // 学 (60) first, 中 (67.4): both TPs kept
  assert.deepEqual(c5.facts.confirmedToneErrors.map((f) => [f.char, f.expectedTone, f.heardTone]), [['学', 2, 4], ['中', 1, 3]]);
  assert.deepEqual(c5.facts.uncertain.map((u) => u.ref).sort(), ['tone:0', 'tone:1', 'tone:2']);
});

test('REAL clips: before/after counts against labels (label basis = instructions, see labels.json)', () => {
  let before = { TP: 0, FP: 0 }; let after = { TP: 0, FP: 0 };
  for (const [n, L] of Object.entries(labels)) {
    if (n.startsWith('_') || L.mismatch || L.noSpeech) continue;
    const raw = clip(n).result; const pol = applyPolicy(raw);
    for (const s of raw.syllables) if (s.tone.decision === 'review') before[L.flags[`tone:${s.index}`].label] += 1;
    for (const f of deriveFacts(pol).confirmedToneErrors) after[L.flags[f.ref].label] += 1;
  }
  assert.deepEqual(before, { TP: 3, FP: 5 });
  assert.deepEqual(after, { TP: 3, FP: 1 });
});
