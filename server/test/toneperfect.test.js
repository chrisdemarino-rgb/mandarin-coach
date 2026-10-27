import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createToneperfectEngine, normalizeCompact, toIdempotencyKey, ERROR_CODES } from '../engines/assessment/toneperfect.js';
import { deriveFacts } from '../engines/assessment/derive.js';
import { loadConfig } from '../config.js';
import { startFakeToneperfect, NIHAO_COMPACT, XIEXIE_WRONG_TONE } from './fake-toneperfect.js';

const FAKE_KEY = 'tp_test_FAKEKEYFORTESTS0123456789';
let fake; let cfg;
const audio = Buffer.from('RIFF....WAVEfmt fake-audio-bytes');
const fast = { baseBackoffMs: 5, maxRetryAfterMs: 20, totalBudgetMs: 3000, requestTimeoutMs: 1000, maxAttempts: 4 };
const mk = (o = {}) => createToneperfectEngine(cfg, { ...fast, ...o });
const call = (e, extra = {}) => e.assess({ audio, mime: 'audio/mp4', chunkText: '你好', attemptId: 'attempt-' + Math.random().toString(36).slice(2), ...extra });

before(async () => {
  fake = await startFakeToneperfect();
  cfg = loadConfig({ NODE_ENV: 'test', TONEPERFECT_API_KEY: FAKE_KEY, TONEPERFECT_BASE_URL: fake.baseUrl });
});
after(async () => { await fake.close(); });
beforeEach(() => fake.reset());

test('docs 你好 example: sandhi (3→2, no_correction) is NOT an error, heard tone preserved', async () => {
  const r = await call(mk());
  assert.equal(r.status, 'ok'); assert.equal(r.engine, 'toneperfect'); assert.equal(r.mock, false);
  assert.equal(r.modelVersion, 'mandarin-human-v2-85741cdf3967-fbf73d85ee88');
  assert.equal(r.overall, 99.6);
  assert.equal(r.syllables.length, 2);
  const [ni, hao] = r.syllables;
  assert.deepEqual([ni.char, ni.pinyin, ni.index], ['你', 'ni3', 0]);
  assert.deepEqual(ni.tone, { expected: 3, heard: 2, score: 99.7, decision: 'no_correction' });
  assert.deepEqual(ni.initial, { expected: 'n', heard: 'n', score: 96.6, decision: 'no_correction' });
  assert.deepEqual(hao.final, { expected: 'ao', heard: 'ao', score: 98.5, decision: 'no_correction' });
  assert.deepEqual(deriveFacts(r), { confirmedToneErrors: [], uncertain: [] });
});

test('request shape: bearer, compact header, idempotency key, multipart fields, hanzi-only reference', async () => {
  await call(mk(), { chunkText: '你好，', mime: 'audio/mp4;codecs=mp4a.40.2' });
  const q = fake.requests[0];
  assert.equal(q.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(q.headers['toneperfect-response'], 'compact');
  assert.match(q.key, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.equal(q.fields.text, '你好');
  assert.equal(q.fields.language, 'zh-CN');
  assert.equal(q.fields.task, 'connected_speech');
  assert.equal(q.fields.audio.type, 'audio/mp4');
  assert.match(q.fields.audio.name, /\.m4a$/);
});

test('confirmed tone error (review) becomes a fact; uncertain is separate; sandhi never flagged', async () => {
  const r = await call(mk(), { chunkText: '谢谢' });
  const f = deriveFacts(r);
  assert.equal(f.confirmedToneErrors.length, 1);
  assert.deepEqual([f.confirmedToneErrors[0].index, f.confirmedToneErrors[0].expectedTone, f.confirmedToneErrors[0].heardTone, f.confirmedToneErrors[0].ref], [1, 4, 2, 'tone:1']);
  assert.equal(f.uncertain.length, 1);
  assert.deepEqual([f.uncertain[0].dimension, f.uncertain[0].index], ['final', 0]);
  assert.equal(r.scores.tone, 48.5);
});

test('assessable:false => unavailable with reason, never a zero score', async () => {
  fake.script({ status: 200, json: { ...NIHAO_COMPACT, assessable: false, reason: 'no_speech', scores: { overall: 0, tone: 0 }, words: [] } });
  const r = await call(mk());
  assert.equal(r.status, 'unavailable'); assert.equal(r.error.code, 'no_speech'); assert.equal(r.error.retryable, true);
  assert.equal(r.overall, null); assert.equal(r.scores, null); assert.deepEqual(r.syllables, []);
  assert.deepEqual(deriveFacts(r), { confirmedToneErrors: [], uncertain: [] });
  for (const reason of ['no_audio', 'too_short', 'different_content', 'language_model_not_installed', 'unsupported_phonetic_symbols', 'no_calibrated_units', 'something_new']) {
    fake.script({ status: 200, json: { ...NIHAO_COMPACT, assessable: false, reason } });
    const x = await call(mk());
    assert.equal(x.status, 'unavailable'); assert.equal(x.error.code, reason); assert.ok(x.error.message.length > 10); assert.equal(x.overall, null);
  }
});

test('every documented error code maps to a typed error with message + retryable flag; no key leaks', async () => {
  const expectRetryable = { upload_timeout: true, idempotency_conflict: true, request_pending: true, idempotency_expired: true, missing_audio: true, invalid_audio: true,
    rate_limit: true, account_busy: true, gateway_busy: true, decoder_busy: true, audio_decoder_unavailable: true, engine_unavailable: true, request_interrupted: true };
  const finalizedBody = (code) => ({ error: { code, message: `leak ${FAKE_KEY}` }, id: 'req_f', billing: { credits: 0 } });
  for (const code of ERROR_CODES) {
    const status = { invalid_api_key: 401, subscription_required: 402, upload_too_large: 413 }[code] || 422;
    fake.reset();
    for (let i = 0; i < 6; i++) fake.script({ status, json: finalizedBody(code) }); // enough for auto-retries too
    const r = await call(mk({ maxAttempts: 2 }));
    assert.equal(r.status, 'unavailable', code);
    assert.equal(r.error.code, code);
    assert.equal(r.error.retryable, !!expectRetryable[code], `${code} retryable`);
    assert.ok(r.error.message && !r.error.message.includes(FAKE_KEY), code);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY), code);
    assert.equal(r.overall, null); assert.deepEqual(r.syllables, []);
  }
});

test('unknown error code and non-JSON 4xx are reported, not guessed', async () => {
  fake.script({ status: 418, json: { error: { code: 'teapot', message: 'x' } } });
  let r = await call(mk());
  assert.equal(r.error.code, 'teapot'); assert.equal(r.error.retryable, false);
  fake.script({ status: 400, body: '<html>nope</html>' });
  r = await call(mk());
  assert.equal(r.error.code, 'http_400'); assert.equal(r.status, 'unavailable');
});

test('retries reuse the SAME idempotency key: gateway_busy (+Retry-After), request_pending, decoder_busy', async () => {
  fake.script(
    { status: 503, json: { error: { code: 'gateway_busy', message: 'x' } }, headers: { 'Retry-After': '0' } },
    { status: 409, json: { error: { code: 'request_pending', message: 'x' } } },
    { status: 503, json: { error: { code: 'decoder_busy', message: 'x' } } },
  );
  const r = await call(mk());
  assert.equal(r.status, 'ok');
  assert.equal(fake.requests.length, 4);
  assert.equal(new Set(fake.requests.map((x) => x.key)).size, 1);
});

test('network error and HTML 502/504 proxy bodies retry with the same key', async () => {
  fake.script({ destroy: true }, { status: 504, body: '<html>Gateway Timeout</html>' }, { status: 502, body: '' });
  const r = await call(mk());
  assert.equal(r.status, 'ok');
  assert.equal(fake.requests.length, 4);
  assert.equal(new Set(fake.requests.map((x) => x.key)).size, 1);
});

test('replay with same key and same body returns completed result (idempotent), different attempt => different key', async () => {
  const e = mk();
  await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'same-attempt-1' });
  await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'same-attempt-1' });
  await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'other-attempt-2' });
  assert.equal(fake.requests[0].key, fake.requests[1].key);
  assert.notEqual(fake.requests[0].key, fake.requests[2].key);
});

test('retries are bounded: persistent 503 stops at maxAttempts and reports retryable', async () => {
  for (let i = 0; i < 10; i++) fake.script({ status: 503, json: { error: { code: 'gateway_busy', message: 'x' } }, headers: { 'Retry-After': '0' } });
  const r = await call(mk({ maxAttempts: 3 }));
  assert.equal(fake.requests.length, 3);
  assert.equal(r.status, 'unavailable'); assert.equal(r.error.code, 'gateway_busy'); assert.equal(r.error.retryable, true);
});

test('finalized engine_unavailable is NOT auto-retried; next try of that attempt gets a NEW key; unfinalized IS retried same key', async () => {
  const e = mk();
  fake.script({ status: 503, json: { error: { code: 'engine_unavailable', message: 'x' }, id: 'req_f', billing: { credits: 0 } } });
  const a = await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'attempt-final-1' });
  assert.equal(a.error.code, 'engine_unavailable'); assert.equal(a.error.retryable, true);
  assert.equal(fake.requests.length, 1);
  const b = await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'attempt-final-1' });
  assert.equal(b.status, 'ok');
  assert.notEqual(fake.requests[0].key, fake.requests[1].key);
  fake.reset();
  fake.script({ status: 503, json: { error: { code: 'engine_unavailable', message: 'x' } } }); // no id/billing => pending
  const c = await e.assess({ audio, mime: 'audio/wav', chunkText: '你好', attemptId: 'attempt-pending-2' });
  assert.equal(c.status, 'ok');
  assert.equal(fake.requests[0].key, fake.requests[1].key);
});

test('invalid_api_key, billing errors and invalid_assessment are never retried', async () => {
  for (const [status, code] of [[401, 'invalid_api_key'], [402, 'insufficient_credits'], [422, 'invalid_assessment']]) {
    fake.reset(); fake.script({ status, json: { error: { code, message: 'x' } } });
    const r = await call(mk());
    assert.equal(fake.requests.length, 1, code);
    assert.equal(r.error.retryable, false, code);
  }
});

test('timeout is treated as unknown outcome: retried with same key, then retryable error', async () => {
  fake.script({ hang: true }, { hang: true });
  const r = await call(mk({ requestTimeoutMs: 80, maxAttempts: 2 }));
  assert.equal(r.status, 'unavailable'); assert.equal(r.error.code, 'network_timeout'); assert.equal(r.error.retryable, true);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0].key, fake.requests[1].key);
});

test('local prechecks spend nothing: digits/Latin, empty, too long, no audio, no key', async () => {
  for (const text of ['我有3个苹果', 'hello 你好', '，。', '好'.repeat(101)]) {
    const r = await call(mk(), { chunkText: text });
    assert.equal(r.status, 'unavailable'); assert.equal(r.error.code, 'invalid_reference'); assert.equal(r.error.retryable, false);
  }
  assert.equal((await call(mk(), { audio: Buffer.alloc(0) })).error.code, 'missing_audio');
  const nokey = createToneperfectEngine(loadConfig({ NODE_ENV: 'test', TONEPERFECT_BASE_URL: fake.baseUrl }), fast);
  assert.equal(nokey.available(), false);
  assert.equal((await call(nokey)).error.code, 'not_configured');
  assert.equal(fake.requests.length, 0);
});

test('unknown schema / empty words are refused, not guessed', async () => {
  fake.script({ status: 200, json: { assessable: true, scores: { overall: 80 }, words: [{ word: 'x' }] } });
  assert.equal((await call(mk())).error.code, 'unexpected_schema');
  fake.script({ status: 200, json: { ...NIHAO_COMPACT, words: [] } });
  assert.equal((await call(mk())).error.code, 'malformed_response');
});

test('normalizeCompact: unknown fields stay null (never 0), unknown decisions => no_decision, neutral tone 0/5 => 5', () => {
  const r = normalizeCompact({ ...NIHAO_COMPACT, scores: { overall: 80 }, words: [
    { text: '吗', pinyin: 'ma0', score: null, start_ms: 0, end_ms: 100, units: [
      { dimension: 'final', expected: 'a', heard: null, score: null, decision: 'wat' },
      { dimension: 'tone', expected: '0', heard: null, score: null, decision: 'uncertain' }] }] }, { lowConfidence: true });
  const s = r.syllables[0];
  assert.deepEqual(s.initial, { expected: null, heard: null, score: null, decision: 'no_decision' });
  assert.deepEqual(s.final, { expected: 'a', heard: null, score: null, decision: 'no_decision' });
  assert.deepEqual(s.tone, { expected: 5, heard: null, score: null, decision: 'uncertain' });
  assert.equal(r.scores.tone, null); assert.equal(r.lowConfidence, true);
});

test('idempotency key format is always valid', () => {
  for (const id of ['abc', 'x'.repeat(500), 'uuid-123e4567-e89b-12d3-a456-426614174000', 'has spaces & symbols!', '', undefined]) {
    assert.match(toIdempotencyKey(id), /^[A-Za-z0-9._:-]{8,128}$/);
  }
  assert.match(toIdempotencyKey('abc-attempt', 2), /:r2$/);
});

test('capabilities() and lint() hit the free endpoints without credentials', async () => {
  const e = mk();
  const caps = await e.capabilities();
  assert.equal(caps.mandarin.available, true); assert.equal(caps.limits.maxUploadBytes, 10485760);
  assert.equal((await e.lint('你好')).ok, true);
  assert.equal((await e.lint('我有3个苹果')).ok, false);
});

test('XIEXIE fixture sanity (guards the fake server)', () => {
  assert.equal(XIEXIE_WRONG_TONE.words[1].units[2].decision, 'review');
});
