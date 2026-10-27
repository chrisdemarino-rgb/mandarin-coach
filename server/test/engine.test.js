import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockEngine } from '../engines/assessment/mock.js';
import { createAssessmentEngine, deriveFacts } from '../engines/assessment/index.js';
import { loadConfig, redact } from '../config.js';

const audio = Buffer.alloc(100, 1);

test('mock engine is deterministic, labelled MOCK, and follows the normalized shape', async () => {
  const e = createMockEngine({ force: undefined });
  const a = await e.assess({ audio, chunkText: '你好，我们练习中文。' });
  const b = await e.assess({ audio, chunkText: '你好，我们练习中文。' });
  assert.deepEqual(a, b);
  assert.equal(a.engine, 'mock'); assert.equal(a.mock, true); assert.equal(a.status, 'ok');
  assert.equal(a.syllables.length, 8); // punctuation skipped
  for (const s of a.syllables) {
    assert.match(s.pinyin, /^[a-zü]+[0-5]$/);
    for (const d of ['initial', 'final', 'tone']) assert.ok('expected' in s[d] && 'heard' in s[d] && 'score' in s[d] && 'decision' in s[d]);
    assert.ok(s.tone.score === null || s.tone.score > 0);
  }
});

test('mock yields both clean and tone-error chunks; derived facts only count decision=review', async () => {
  const e = createMockEngine({ force: undefined });
  let withErr = 0; let without = 0;
  for (const txt of ['你好', '谢谢你', '我喜欢学中文', '今天天气很好', '请再说一遍', '明天见', '我想喝茶']) {
    const r = await e.assess({ audio, chunkText: txt });
    const f = deriveFacts(r);
    assert.equal(f.confirmedToneErrors.length, r.syllables.filter((s) => s.tone.decision === 'review').length);
    for (const c of f.confirmedToneErrors) { assert.notEqual(c.expectedTone, c.heardTone); assert.ok(c.ref.startsWith('tone:')); }
    f.confirmedToneErrors.length ? withErr++ : without++;
  }
  assert.ok(withErr > 0 && without > 0, 'mock should exercise both paths');
});

test('deriveFacts: sandhi (no_correction with mismatch) is NOT an error; uncertain surfaced separately', () => {
  const asm = { status: 'ok', syllables: [
    { index: 0, char: '你', pinyin: 'ni3', tone: { expected: 3, heard: 2, score: 99, decision: 'no_correction' }, initial: { decision: 'no_correction' }, final: { decision: 'no_correction' } },
    { index: 1, char: '好', pinyin: 'hao3', tone: { expected: 3, heard: 1, score: 40, decision: 'uncertain' }, initial: { decision: 'no_correction' }, final: { decision: 'no_correction' } },
  ] };
  const f = deriveFacts(asm);
  assert.equal(f.confirmedToneErrors.length, 0);
  assert.equal(f.uncertain.length, 1);
  assert.equal(f.uncertain[0].dimension, 'tone');
});

test('unavailable results carry an error and no scores; forced-unavailable mock', async () => {
  const e = createMockEngine({ force: 'unavailable' });
  const r = await e.assess({ audio, chunkText: '你好' });
  assert.equal(r.status, 'unavailable'); assert.equal(r.overall, null); assert.equal(r.error.retryable, true);
  assert.deepEqual(deriveFacts(r), { confirmedToneErrors: [], uncertain: [] });
  const empty = await createMockEngine({ force: undefined }).assess({ audio: Buffer.alloc(0), chunkText: '你好' });
  assert.equal(empty.status, 'unavailable');
});

test('engine selection: mock without key, toneperfect with key, explicit override wins', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).assessmentEngine, 'mock');
  assert.equal(loadConfig({ NODE_ENV: 'test', TONEPERFECT_API_KEY: 'tp_test_abcdefgh' }).assessmentEngine, 'toneperfect');
  assert.equal(loadConfig({ NODE_ENV: 'test', TONEPERFECT_API_KEY: 'tp_test_abcdefgh', ASSESSMENT_ENGINE: 'mock' }).assessmentEngine, 'mock');
  assert.equal(createAssessmentEngine(loadConfig({ NODE_ENV: 'test' })).name, 'mock');
});

test('dev passcode only outside production; production without passcode disables login', () => {
  const dev = loadConfig({ NODE_ENV: 'development' });
  assert.equal(dev.passcode, 'devpass'); assert.ok(dev.warnings.some((w) => /devpass/.test(w)));
  const prod = loadConfig({ NODE_ENV: 'production' });
  assert.equal(prod.passcode, null);
});

test('redact removes configured secrets and key-shaped strings', () => {
  const env = { OPENAI_API_KEY: 'sk-supersecretvalue123', TONEPERFECT_API_KEY: 'tp_live_abcdef123456' };
  const out = redact('failed with sk-supersecretvalue123 and Bearer tp_live_abcdef123456 and tp_test_zzzz9999', env);
  assert.ok(!out.includes('supersecret') && !out.includes('abcdef123456') && !out.includes('zzzz9999'));
});

test('redact catches tp_live_ / tp_test_ / sk- key shapes even when no env var is set', () => {
  const out = redact('Authorization: Bearer tp_live_AbC123_xyz-9 failed; also tp_test_ZZ99 and sk-proj-abcdefgh1234', {});
  assert.ok(!out.includes('AbC123') && !out.includes('ZZ99') && !out.includes('abcdefgh1234'));
  assert.match(out, /tp_live_\[redacted\]/);
  assert.match(out, /tp_test_\[redacted\]/);
});
