import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer({ ASSESSMENT_ENGINE: 'mock' }); });
after(async () => { await t.close(); });

test('health is public and labels the mock engine', async () => {
  const r = await t.api('GET', '/api/health', undefined, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.engine, 'mock');
  assert.equal(r.json.mock, true);
  assert.deepEqual(Object.keys(r.json.services).sort(), ['assessment', 'llm', 'stt', 'tts']);
  assert.equal(r.json.services.llm, false);
  assert.equal(r.json.services.tts, null);
});

test('everything but login/health requires auth', async () => {
  for (const [m, p] of [['GET', '/api/prefs'], ['GET', '/api/words'], ['PUT', '/api/prefs'], ['GET', '/api/me']]) {
    const r = await t.api(m, p, m === 'PUT' ? {} : undefined, { auth: false });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('login: wrong passcode rejected, right passcode sets httpOnly cookie', async () => {
  const bad = await t.login('nope');
  assert.equal(bad.status, 401);
  const ok = await t.login();
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.equal((await t.api('GET', '/api/me')).status, 200);
});

test('tampered or expired cookie rejected', async () => {
  const { verifyToken, issueToken } = await import('../lib/auth.js');
  const tok = issueToken(t.cfg);
  assert.equal(verifyToken(t.cfg, tok), true);
  assert.equal(verifyToken(t.cfg, tok.slice(0, -2) + 'xx'), false);
  assert.equal(verifyToken(t.cfg, tok, Date.now() + 365 * 86400_000), false);
  assert.equal(verifyToken({ ...t.cfg, passcode: 'other' }, tok), false);
});

test('prefs: defaults, partial update, validation', async () => {
  await t.login();
  let r = await t.api('GET', '/api/prefs');
  assert.equal(r.json.chunkMode, 'sentence');
  assert.equal(r.json.assessMode, 'close');
  r = await t.api('PUT', '/api/prefs', { chunkMode: 'four', speed: 0.8 });
  assert.equal(r.status, 200);
  assert.equal(r.json.chunkMode, 'four');
  assert.equal(r.json.speed, 0.8);
  assert.equal(r.json.assessMode, 'close');
  assert.equal((await t.api('PUT', '/api/prefs', { chunkMode: 'bogus' })).status, 400);
  assert.equal((await t.api('PUT', '/api/prefs', { speed: 3 })).status, 400);
  assert.equal((await t.api('PUT', '/api/prefs', { hax: 1 })).status, 400);
  assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'fading_cues' })).status, 200);
  assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'karaoke' })).status, 400); // unknown modes rejected
  assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'free_talk' })).json.practiceMode, 'free_talk'); // Free talk client mode (own endpoints /api/talk/*)
  assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'listen_repeat' })).json.practiceMode, 'listen_repeat');
});

test('words: add, dedupe, list, history, delete', async () => {
  await t.login();
  let r = await t.api('POST', '/api/words', { text: '练习', pinyin: 'lian4 xi2', meaning: 'practice', sourceChunk: '我们练习中文。' });
  assert.equal(r.status, 201);
  const id = r.json.id;
  r = await t.api('POST', '/api/words', { text: '练习' });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, id);
  assert.equal((await t.api('POST', '/api/words', { text: '  ' })).status, 400);
  r = await t.api('POST', `/api/words/${id}/history`, { result: { mode: 'close', toneScore: 88, outcome: 'ok', audio: 'ignored' } });
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(r.json.history[0].result), { mode: 'close', outcome: 'ok', toneScore: 88 });
  assert.equal((await t.api('POST', `/api/words/${id}/history`, { result: 'tone_error' })).status, 201);
  assert.equal((await t.api('POST', `/api/words/${id}/history`, { result: { evil: 1 } })).status, 400);
  r = await t.api('GET', '/api/words');
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].attempts, 2);
  assert.equal(r.json[0].lastResult, 'tone_error');
  assert.equal((await t.api('DELETE', `/api/words/${id}`)).status, 204);
  assert.equal((await t.api('DELETE', `/api/words/${id}`)).status, 404);
  assert.deepEqual((await t.api('GET', '/api/words')).json, []);
});

test('unknown api route is JSON 404 (after auth)', async () => {
  await t.login();
  const r = await t.api('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
});
