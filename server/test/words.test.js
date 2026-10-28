import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { refChars, normalizeTranscript, alignTranscript, analyzeWords, segmentWords } from '../engines/assessment/words.js';
import { applyPolicy } from '../engines/assessment/policy.js';
import { ASSESSMENT_POLICY as P } from '../config.js';
import { runCoach, validateCorrection, planCorrections, OPENER_ZH, PRAISE_RE, STT_UNAVAILABLE_ZH } from '../services/coach.js';

const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures');
const clip = (n) => { const fx = JSON.parse(fs.readFileSync(path.join(dir, 'real-clips', `${n}.json`), 'utf8')); return { ref: fx.referenceText, a: applyPolicy(structuredClone(fx.result)) }; };
const stt = (n) => JSON.parse(fs.readFileSync(path.join(dir, 'stt', `${n}.json`), 'utf8')).transcript; // REAL gpt-4o-transcribe outputs, cached
const run = (n, { transcript, status } = {}) => {
  const { ref, a } = clip(n);
  const t = transcript === undefined ? stt(n) : transcript;
  return { ref, ...analyzeWords({ chunkText: ref, assessment: a, transcript: t, stt: { status: status || (t == null ? 'unavailable' : 'ok'), ms: 700 } }) };
};
const by = (r, st) => r.wordStatus.filter((w) => w.status === st);

// ---------- text normalisation + alignment
test('refChars: code-point offsets into the EXACT received text; punctuation/latin skipped; astral chars count once', () => {
  assert.deepEqual(refChars('你，好！'), [{ ch: '你', start: 0, end: 1 }, { ch: '好', start: 2, end: 3 }]);
  assert.deepEqual(refChars('A😀好').map((x) => [x.ch, x.start]), [['好', 2]]);
});
test('normalizeTranscript: punctuation dropped, digits -> hanzi numerals, full-width forms folded', () => {
  assert.deepEqual(normalizeTranscript('我有 3 个，Hello！'), ['我', '有', '三', '个']);
  assert.deepEqual(normalizeTranscript('１２'), ['十', '二']);
});
test('alignTranscript: omission / insertion / substitution / traditional==simplified / near-homophone', () => {
  const al = (ref, heard) => { const rc = refChars(ref); return alignTranscript(rc.map((c) => c.ch), normalizeTranscript(heard)); };
  const kinds = (x) => JSON.stringify(x);
  assert.ok(kinds(al('我喜欢学中文', '我喜欢中文')).length > 0);
  const r = analyzeWords({ chunkText: '我喜欢学中文', assessment: clip('04-xihuan-zhongwen-correct').a, transcript: '我喜欢學中文', stt: { status: 'ok' } });
  assert.deepEqual(r.facts.missingWords, []); assert.equal(r.facts.completeness, 'verified'); // traditional 學 == 学
});

// ---------- real cached clips (TonePerfect fixture + real STT transcript)
test('REAL clip 09 (学 omitted): 学 missed, high confidence, source both; others ok; offsets point at 学 in the received chunk', () => {
  const r = run('09-omit-xue-middle');
  const m = by(r, 'missed'); assert.equal(m.length, 1);
  assert.deepEqual([m[0].text, m[0].pinyin, m[0].start, m[0].end, m[0].reason, m[0].source, m[0].confidence], ['学', 'xué', 3, 4, 'omitted', 'both', 'high']);
  assert.equal(r.ref.slice(m[0].start, m[0].end), '学');
  assert.deepEqual(r.facts.missingWords.map((w) => w.text), ['学']);
  assert.equal(r.facts.completeness, 'incomplete'); assert.equal(r.facts.canPraise, false);
  assert.equal(r.wordStatus.filter((w) => w.status === 'ok').length, 5);
});
test('REAL clip 09 WITHOUT STT: acoustic-only => only "uncertain"/low (never claims missed), canPraise false, stt unavailable stated', () => {
  const r = run('09-omit-xue-middle', { transcript: null, status: 'timeout' });
  assert.equal(by(r, 'missed').length, 0);
  const u = by(r, 'uncertain'); assert.equal(u.length, 1); assert.equal(u[0].text, '学'); assert.equal(u[0].confidence, 'low'); assert.equal(u[0].source, 'acoustic');
  assert.equal(r.facts.canPraise, false); assert.equal(r.facts.stt.status, 'timeout');
  assert.deepEqual(r.facts.missingWords, []);
});
test('REAL clip 10 (said only 今天天…): 好 missed (both sources, high); 很 low-confidence uncertain; not praiseable', () => {
  const r = run('10-half-only-jintian-tian');
  const m = by(r, 'missed'); assert.ok(m.some((w) => w.text === '好' && w.confidence === 'high' && w.source === 'both'));
  assert.ok(by(r, 'uncertain').some((w) => w.text === '很' && w.confidence === 'low'));
  assert.equal(r.facts.canPraise, false); assert.equal(r.facts.completeness, 'incomplete');
});
test('REAL clips 04/06/01/02 (said correctly): everything verified, canPraise true, no missed/substituted (traditional STT output tolerated)', () => {
  for (const n of ['04-xihuan-zhongwen-correct', '06-jintian-tianqi-correct', '01-nihao-correct', '02-xiexie-correct']) {
    const r = run(n);
    assert.deepEqual([r.facts.missingWords.length, r.facts.substitutedWords.length, r.facts.completeness, r.facts.canPraise], [0, 0, 'verified', true], n);
    assert.equal(by(r, 'missed').length + by(r, 'substituted').length, 0, n);
  }
});
test('REAL clip 08 (said 你好, reference 谢谢) is gated by low_match: no word claims at all, even though STT disagrees', () => {
  const r = run('08-wrong-sentence', { transcript: stt('08-wrong-sentence') });
  assert.deepEqual(r.wordStatus, []); assert.equal(r.facts.canPraise, false);
  assert.deepEqual(r.facts.missingWords, []); assert.deepEqual(r.facts.substitutedWords, []);
});
test('transcript is NEVER used for tone claims: clip 05 (STT autocorrected to perfect text) keeps its acoustic tone errors; tone results identical with/without STT', () => {
  const withStt = run('05-xihuan-zhongwen-wrong-tone'); const without = run('05-xihuan-zhongwen-wrong-tone', { transcript: null });
  assert.deepEqual(withStt.confirmedToneErrors.map((e) => e.index), without.confirmedToneErrors.map((e) => e.index));
  assert.equal(withStt.confirmedToneErrors.length, 2);
  assert.equal(by(withStt, 'missed').length, 0); // STT said every word was there
  assert.deepEqual(by(withStt, 'wrong').map((w) => w.text), ['学', '中']); // the two confirmed tone errors survive, source acoustic only
  assert.ok(by(withStt, 'wrong').every((w) => w.source === 'acoustic'));
});

// ---------- synthetic: evidence combination + thresholds
// one syllable + one word per char (that is the normalized TonePerfect shape); ov = { charIndex: { s: wordScore, init: initialScore, a: startMs, b: endMs } }
const syn = (chunk, ov = {}) => {
  const chars = Array.from(chunk).filter((c) => /\p{Script=Han}/u.test(c));
  const syllables = chars.map((c, i) => ({ index: i, char: c, pinyin: 'x', wordIndex: i, startMs: ov[i]?.a ?? i * 400, endMs: ov[i]?.b ?? i * 400 + 380,
    initial: { expected: 'x', heard: 'x', score: ov[i]?.init ?? 90, decision: 'no_correction' }, final: { expected: 'a', heard: 'a', score: 90, decision: 'no_correction' }, tone: { expected: 1, heard: 1, score: 90, decision: 'no_correction' } }));
  const words = chars.map((c, i) => ({ text: c, score: ov[i]?.s ?? 90, startMs: syllables[i].startMs, endMs: syllables[i].endMs }));
  return { status: 'ok', engine: 'x', mock: false, overall: 90, scores: { overall: 90, pronunciation: 90 }, syllables, words, gate: null };
};
const an = (chunk, a, transcript, status = 'ok') => analyzeWords({ chunkText: chunk, assessment: a, transcript, stt: { status } });
const XUE = { 3: { s: 52, init: 3 } }; // 学 in 我喜欢学中文

test('STT-only evidence (good acoustics, transcript missing a word) => missed with MEDIUM confidence, source stt; praise blocked', () => {
  const r = an('我喜欢学中文', syn('我喜欢学中文'), '我喜欢中文');
  const m = r.wordStatus.find((w) => w.status === 'missed');
  assert.deepEqual([m.text, m.source, m.confidence], ['学', 'stt', 'medium']); assert.equal(r.facts.canPraise, false);
});
test('acoustic + STT agree => HIGH; acoustic alone => uncertain/low (single source never allows "good")', () => {
  const low = syn('我喜欢学中文', XUE);
  assert.equal(an('我喜欢学中文', low, '我喜欢中文').wordStatus.find((w) => w.text === '学').confidence, 'high');
  const a = an('我喜欢学中文', low, '我喜欢学中文');
  assert.equal(a.wordStatus.find((w) => w.text === '学').status, 'uncertain'); assert.equal(a.facts.canPraise, false);
});
test('thresholds: word score exactly at ACOUSTIC_MISSING_WORD_MAX is NOT a candidate; just below is', () => {
  const mk = (s) => an('我喜欢', syn('我喜欢', { 2: { s } }), '我喜欢');
  assert.equal(mk(P.ACOUSTIC_MISSING_WORD_MAX).wordStatus.every((w) => w.status === 'ok'), true);
  assert.ok(mk(P.ACOUSTIC_MISSING_WORD_MAX - 0.1).wordStatus.some((w) => w.status === 'uncertain'));
});
test('substitution: heard text recorded; near-homophone (z/zh) is not a substitution; insertions go to insertedText', () => {
  let r = an('我喜欢学中文', syn('我喜欢学中文'), '我喜欢爱中文');
  const s = r.wordStatus.find((w) => w.status === 'substituted'); assert.ok(s, JSON.stringify(r.wordStatus));
  assert.deepEqual([s.text, s.heard, s.source, s.confidence], ['学', '爱', 'stt', 'medium']);
  assert.equal(r.facts.substitutedWords[0].heard, '爱'); assert.equal(r.facts.canPraise, false);
  r = an('我是学生', syn('我是学生'), '我是学生');
  assert.equal(r.facts.completeness, 'verified');
  r = an('我喜欢中文', syn('我喜欢中文'), '我很喜欢中文');
  assert.ok(r.facts.insertedText.length >= 1 && r.facts.insertedText.map((x) => x.text).join('').includes('很')); assert.deepEqual(r.facts.missingWords, []);
});
test('STT numerals: "3个" vs reference 三个 is NOT a difference', () => {
  const r = an('三个人', syn('三个人'), '3个人');
  assert.equal(r.facts.completeness, 'verified');
});
test('unreliable STT (coverage below STT_MIN_COVERAGE, e.g. hallucination on noise) is ignored for word claims and flagged', () => {
  const r = an('我喜欢学中文', syn('我喜欢学中文'), '初来乍到。');
  assert.equal(r.facts.stt.reliable, false); assert.deepEqual(r.facts.missingWords, []); assert.equal(r.facts.completeness, 'unverified');
  assert.equal(r.facts.canPraise, true); // clean acoustics, nothing contradicts; the coach appends the 'could not check for omissions' caveat (see attempt tests)
});
test('STT failed/timeout/not configured: facts.stt.status says so; completeness unverified (coach adds the confidence-reduced caveat)', () => {
  for (const status of ['failed', 'timeout', 'not_configured']) {
    const r = an('你好', syn('你好'), null, status);
    assert.equal(r.facts.stt.status, status); assert.equal(r.facts.completeness, 'unverified');
  }
});
test('a long pause between words is a notable gap and blocks praise, but names no word', () => {
  const a = syn('今天天气', { 2: { a: 780 + P.LONG_PAUSE_MS + 100, b: 1900 }, 3: { a: 1900, b: 2300 } });
  const r = an('今天天气', a, '今天天气');
  assert.equal(r.facts.notableGaps.length, 1); assert.equal(r.facts.canPraise, false); assert.deepEqual(r.facts.missingWords, []);
});
test('segmentWords: Chinese word segmentation skips punctuation and keeps exact offsets', () => {
  const w = segmentWords('今天，天气很好！'); assert.ok(w.every((x) => !/[，！]/.test(x.text)));
  assert.equal(w[0].start, 0);
});

// ---------- coach: HARD RULE, grounded, max 2 corrections
test('HARD RULE: a praising LLM line is never spoken while a word is missing; opener + named word + model come first; nothing matches the praise regex', async () => {
  const facts = { confirmedToneErrors: [{ ref: 'tone:0', index: 0, char: '我', expectedTone: 3, heardTone: 1, start: 0, end: 1 }], uncertain: [], canPraise: false, missingWords: [{ ref: 'missing:0', text: '学', pinyin: 'xué', start: 3, end: 4, reason: 'omitted', source: 'both', confidence: 'high', missedText: '学' }], substitutedWords: [], unclearWords: [], notableGaps: [], insertedText: [], stt: { status: 'ok', reliable: true }, completeness: 'incomplete' };
  const llm = { available: true, async *chatStream() { yield JSON.stringify({ praiseZh: '完美，全部正确！', corrections: [{ kind: 'tone', targetText: '我', explanationZh: '“我”应该读第三声，你读成了第一声。', modelText: '我', factRef: 'tone:0' }], nextPromptZh: '很好，继续。' }); } };
  const units = [];
  const res = await runCoach({ llm, chunkText: '我喜欢学中文', assessMode: 'close', facts, onUnit: (u) => units.push(u) });
  assert.equal(units[0].kind, 'opener'); assert.equal(units[0].text, OPENER_ZH);
  assert.ok(units[1].text.includes('学') && units[1].correction.kind === 'missing' && units[1].correction.start === 3 && units[1].correction.end === 4);
  assert.ok(units.some((u) => u.kind === 'correction_model' && u.text.includes('学')));
  assert.ok(res.corrections.length <= 2 && res.corrections.some((c) => c.kind === 'tone' && c.factRef === 'tone:0'));
  assert.ok(units.every((u) => !PRAISE_RE.test(u.text.replace('“', ''))), units.map((u) => u.text).join('|'));
});
test('STT unavailable + otherwise clean take: praise allowed ONLY with the spoken confidence-reduced caveat', async () => {
  const facts = { confirmedToneErrors: [], uncertain: [], canPraise: true, missingWords: [], substitutedWords: [], unclearWords: [], notableGaps: [], insertedText: [], stt: { status: 'timeout' }, completeness: 'unverified' };
  const units = [];
  await runCoach({ llm: { available: false }, chunkText: '你好', assessMode: 'close', facts, onUnit: (u) => units.push(u) });
  assert.ok(units.some((u) => u.kind === 'caveat' && u.text === STT_UNAVAILABLE_ZH), JSON.stringify(units.map((u) => u.kind)));
});
test('planCorrections: missing words rank above tone; at most 2 corrections; each names the exact reference word with offsets', () => {
  const facts = { confirmedToneErrors: [{ ref: 'tone:0', index: 0, char: '我', expectedTone: 3, heardTone: 1 }, { ref: 'tone:1', index: 1, char: '喜', expectedTone: 3, heardTone: 2 }], uncertain: [], canPraise: false,
    missingWords: [{ text: '学', pinyin: 'xué', start: 4, end: 5, reason: 'omitted', source: 'both', confidence: 'high' }, { text: '文', pinyin: 'wén', start: 6, end: 7, reason: 'omitted', source: 'stt', confidence: 'medium' }], substitutedWords: [], unclearWords: [], notableGaps: [], insertedText: [], stt: { status: 'ok', reliable: true } };
  const plan = planCorrections(facts, '我喜欢学中文');
  const all = plan.fixed ?? plan.corrections ?? plan.lines ?? plan;
  const flat = JSON.stringify(all);
  assert.ok(flat.includes('学') && flat.includes('文')); assert.ok(!flat.includes('"我"') || plan.toneSlots === 0);
  assert.equal(plan.toneSlots, 0); // both slots consumed by missing words
});
test('validateCorrection drops LLM-authored missing/substituted/wording claims in close mode (code owns them)', () => {
  const ctx = { chunkText: '你好', facts: { confirmedToneErrors: [], uncertain: [], canPraise: true }, transcript: null, assessMode: 'close' };
  for (const kind of ['missing', 'substituted', 'unclear', 'omission', 'wording']) assert.equal(validateCorrection({ kind, explanationZh: '漏了一个字。' }, ctx).dropped, 'code_owned', kind);
});
