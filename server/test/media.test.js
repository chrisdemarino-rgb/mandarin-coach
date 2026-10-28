import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { startFakeServices } from './fake-services.js';
import { JsonUnitScanner, splitSentences, validateCorrection } from '../services/coach.js';
import { keywordItems, clauseStarts } from '../services/cues.js';

let svc;
before(async () => { svc = await startFakeServices(); });
after(async () => { await svc.close(); });
beforeEach(() => svc.reset());
const OAI = () => ({ ASSESSMENT_ENGINE: 'mock', OPENAI_API_KEY: 'sk-fakeopenaikey0123456789', OPENAI_BASE_URL: svc.openaiBase });

test('POST /api/tts: 501 not_configured without keys; mp3 + memory cache with keys; validation', async () => {
  let t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' }); await t.login();
  try {
    const r = await t.api('POST', '/api/tts', { text: '你好' });
    assert.equal(r.status, 501); assert.equal(r.json.error.code, 'tts_not_configured');
  } finally { await t.close(); }
  t = await startTestServer(OAI()); await t.login();
  try {
    const post = (body, headers = {}) => fetch(t.base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: t.cookie(), ...headers }, body: JSON.stringify(body) });
    const a = await post({ text: '你好', speed: 0.8 });
    assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'audio/mpeg'); assert.equal(a.headers.get('x-tts-cache'), 'miss'); assert.equal(a.headers.get('x-tts-provider'), 'openai');
    const bytes = Buffer.from(await a.arrayBuffer()); assert.ok(bytes.subarray(0, 3).toString() === 'ID3');
    const b = await post({ text: '你好', speed: 0.8 });
    assert.equal(b.headers.get('x-tts-cache'), 'hit');
    assert.equal(svc.state.requests.filter((x) => x.url === '/v1/audio/speech').length, 1);
    const sent = svc.state.requests.find((x) => x.url === '/v1/audio/speech').json;
    assert.equal(sent.voice, 'nova'); assert.equal(sent.speed, 0.8); assert.equal(sent.input, '你好'); // Azure voice names are mapped to an OpenAI voice
    const rng = await post({ text: '你好', speed: 0.8 }, { Range: 'bytes=0-3' });
    assert.equal(rng.status, 206); assert.match(rng.headers.get('content-range'), /^bytes 0-3\//);
    for (const bad of [{}, { text: '' }, { text: 'x'.repeat(501) }, { text: '你', speed: 5 }, { text: '你', voice: '../x' }]) assert.equal((await post(bad)).status, 400);
    svc.state.ttsStatus = 500;
    const fail = await post({ text: '别的' }); assert.equal(fail.status, 502);
    assert.equal((await fail.json()).error.code, 'openai_500');
  } finally { await t.close(); }
});

test('POST /api/tts: identical concurrent requests share ONE provider call (prefetch + tap, double tap)', async () => {
  const t = await startTestServer(OAI()); await t.login();
  try {
    svc.state.ttsDelayMs = 300;
    const post = (text) => fetch(t.base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: t.cookie() }, body: JSON.stringify({ text }) });
    const [a, b, c] = await Promise.all([post('他每天早上七点起床。'), post('他每天早上七点起床。'), post('他每天早上七点起床。')]);
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    const bufs = await Promise.all([a, b, c].map(async (r) => Buffer.from(await r.arrayBuffer())));
    assert.ok(bufs[0].length > 3 && bufs[0].equals(bufs[1]) && bufs[0].equals(bufs[2]));
    assert.equal(svc.state.requests.filter((x) => x.url === '/v1/audio/speech').length, 1);
    assert.equal((await post('他每天早上七点起床。')).headers.get('x-tts-cache'), 'hit');
  } finally { await t.close(); }
});

test('GET /api/audio/:id.mp3: auth required, unknown/expired => 404', async () => {
  const t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' }); await t.login();
  try {
    assert.equal((await t.api('GET', '/api/audio/' + 'a'.repeat(24) + '.mp3')).status, 404);
    assert.equal((await t.api('GET', '/api/audio/../../etc/passwd.mp3')).status, 404);
    const id = t.services.audioCache.put(Buffer.from('0123456789'));
    const full = await fetch(`${t.base}/api/audio/${id}.mp3`, { headers: { Cookie: t.cookie() } });
    assert.equal(await full.text(), '0123456789');
    const part = await fetch(`${t.base}/api/audio/${id}.mp3`, { headers: { Cookie: t.cookie(), Range: 'bytes=2-' } });
    assert.equal(part.status, 206); assert.equal(await part.text(), '23456789');
    const nocookie = await fetch(`${t.base}/api/audio/${id}.mp3`);
    assert.equal(nocookie.status, 401);
  } finally { await t.close(); }
});

test('POST /api/cues: levels 1,2,4 rule-based; level 3 LLM hint with rule fallback; validation', async () => {
  let t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' }); await t.login();
  try {
    const chunk = '我们今天练习中文发音，然后复习生词。';
    let r = await t.api('POST', '/api/cues', { chunkText: chunk, level: 1 });
    assert.equal(r.status, 200); assert.equal(r.json.source, 'rule');
    assert.ok(r.json.items.length >= 2 && r.json.items.length <= 4);
    for (const i of r.json.items) { assert.ok(chunk.includes(i.text)); assert.match(i.pinyin, /[a-zāáǎàēéěèīíǐìōóǒòūúǔù]/); }
    assert.match(r.json.cue, /练习 liànxí/);
    r = await t.api('POST', '/api/cues', { chunkText: chunk, level: 2 });
    assert.equal(r.json.cue, '我… 然…');
    assert.equal((await t.api('POST', '/api/cues', { chunkText: chunk, level: 4 })).json.cue, '');
    r = await t.api('POST', '/api/cues', { chunkText: chunk, level: 3 }); // no LLM => rule fallback word from the chunk
    assert.equal(r.json.source, 'rule'); assert.ok(chunk.includes(r.json.cue));
    for (const bad of [{ chunkText: chunk, level: 0 }, { chunkText: chunk, level: 5 }, { chunkText: chunk, level: '1' }, { chunkText: '', level: 1 }, { chunkText: '好'.repeat(101), level: 1 }]) assert.equal((await t.api('POST', '/api/cues', bad)).status, 400);
  } finally { await t.close(); }
  t = await startTestServer(OAI()); await t.login();
  try {
    svc.state.chatScript = JSON.stringify({ hint: '学习' });
    let r = await t.api('POST', '/api/cues', { chunkText: '我们今天练习中文。', level: 3 });
    assert.deepEqual([r.json.cue, r.json.source], ['学习', 'llm']);
    await t.api('POST', '/api/cues', { chunkText: '我们今天练习中文。', level: 3 });
    assert.equal(svc.state.jsonCalls, 1); // cached
    svc.state.chatScript = JSON.stringify({ hint: 'a very long English hint' });
    r = await t.api('POST', '/api/cues', { chunkText: '明天去北京出差。', level: 3 });
    assert.equal(r.json.source, 'rule');
  } finally { await t.close(); }
});

test('cue helpers', () => {
  assert.deepEqual(clauseStarts('你好，我是学生。再见！'), ['你', '我', '再']);
  assert.ok(keywordItems('我的朋友').length >= 1);
});

test('JsonUnitScanner: identical output however the stream is chunked; braces/quotes inside strings are safe', () => {
  const doc = JSON.stringify({ praiseZh: '很{好}"棒"。', corrections: [{ kind: 'tone', explanationZh: '说"一声"{x}', factRef: 'tone:1' }, { kind: 'model', explanationZh: 'b' }], nextPromptZh: '再来。' });
  const ref = new JsonUnitScanner().push(doc);
  assert.equal(ref.length, 4);
  for (const size of [1, 2, 3, 7, 50]) {
    const s = new JsonUnitScanner(); const out = [];
    for (let i = 0; i < doc.length; i += size) out.push(...s.push(doc.slice(i, i + size)));
    assert.deepEqual(out, ref, `chunk size ${size}`);
  }
  assert.deepEqual(ref.map((e) => [e.type, e.key]), [['string', 'praiseZh'], ['item', 'corrections'], ['item', 'corrections'], ['string', 'nextPromptZh']]);
});

test('splitSentences + validateCorrection edge cases', () => {
  assert.deepEqual(splitSentences('很好。再来一次！好吗？'), ['很好。', '再来一次！', '好吗？']);
  const facts = { confirmedToneErrors: [{ ref: 'tone:0', index: 0, char: '妈', expectedTone: 1, heardTone: 3 }], uncertain: [] };
  const ctx = { chunkText: '妈妈', facts, transcript: null, assessMode: 'close' };
  assert.equal(validateCorrection({ kind: 'wording', explanationZh: 'x' }, ctx).dropped, 'code_owned'); // close mode: missing/wrong words come from code
  assert.equal(validateCorrection({ kind: 'wording', explanationZh: 'x' }, { ...ctx, assessMode: 'retell' }).dropped, 'no_transcript');
  assert.equal(validateCorrection({ kind: 'missing', explanationZh: 'x' }, ctx).dropped, 'code_owned');
  assert.equal(validateCorrection({ kind: 'nonsense' }, ctx).dropped, 'unknown_kind');
  assert.equal(validateCorrection(null, ctx).dropped, 'not_an_object');
  const ok = validateCorrection({ kind: 'tone', targetText: '妈', explanationZh: '“妈”应该读第一声，你读成了第三声。', modelText: '妈妈', factRef: 'tone:0' }, ctx);
  assert.equal(ok.correction.source, 'llm');
  const retellWording = validateCorrection({ kind: 'wording', explanationZh: '换了说法。' }, { ...ctx, transcript: '妈', assessMode: 'retell' });
  assert.equal(retellWording.dropped, 'wording_not_error_in_retell');
  assert.equal(validateCorrection({ kind: 'omission', explanationZh: '这个字读第三声。' }, { ...ctx, transcript: '妈', assessMode: 'retell' }).dropped, 'tone_claim_without_evidence');
});
