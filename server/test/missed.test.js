// Missing/substituted words end-to-end (cached REAL TonePerfect results + cached REAL STT transcripts / FAKE STT server; no network, no keys),
// the "words I don't know" list, trouble-word drills, and data minimisation.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postAttempt, postDrill, switchableEngine, fixtureEngine, sttFixture } from './helpers.js';
import { startFakeToneperfect } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';
import { openDb } from '../db.js';
import { DRILL_GRADUATE_STREAK } from '../config.js';
import { OPENER_ZH, PRAISE_RE, STT_UNAVAILABLE_ZH } from '../services/coach.js';

const TP_KEY = 'tp_test_FAKEKEYFORTESTS0123456789'; const OAI_KEY = 'sk-fakeopenaikey0123456789';
let tp; let svc;
before(async () => { tp = await startFakeToneperfect(); svc = await startFakeServices(); });
after(async () => { await tp.close(); await svc.close(); });
beforeEach(() => { tp.reset(); svc.reset(); svc.state.chatScript = JSON.stringify({ praiseZh: '很好。', corrections: [], nextPromptZh: '继续。' }); });

const envOai = (x = {}) => ({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect', OPENAI_API_KEY: OAI_KEY, OPENAI_BASE_URL: svc.openaiBase, ...x });
async function server(env, opts) { const t = await startTestServer(env, opts); await t.login(); return t; }
const ev = (r, n) => r.events.filter((e) => e.event === n).map((e) => e.data);
const chatCalls = () => svc.state.requests.filter((r) => r.url === '/v1/chat/completions').length;
const spokenText = (r) => ev(r, 'coach_text').map((x) => x.delta);
const noPraise = (lines) => lines.every((l) => !PRAISE_RE.test(l.replace(/应该这样说：.*$/, '').replace(/“[^”]*”/g, ''))); // a quoted script word such as “很好” is not praise

const CHUNK = '我喜欢学中文';
const attempt09 = async (t, over = {}) => { svc.state.sttText = await sttFixture('09-omit-xue-middle'); return postAttempt(t, { fields: { chunkText: CHUNK, ...over } }); };

test('E2E clip 09 (学 omitted, real TP + real STT transcript): wordStatus + facts + savedMissed; coach opens with the opener, names 学, models it; never praises; LLM not needed', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('09-omit-xue-middle') });
  try {
    const r = await attempt09(t);
    const [a] = ev(r, 'assessment');
    const m = a.wordStatus.find((w) => w.status === 'missed');
    assert.deepEqual({ ...m, detail: undefined }, { start: 3, end: 4, text: '学', pinyin: 'xué', status: 'missed', reason: 'omitted', source: 'both', confidence: 'high', detail: undefined });
    assert.equal(a.wordStatus.length, 6); assert.equal(Array.from(CHUNK).slice(m.start, m.end).join(''), '学');
    assert.deepEqual(a.facts.missingWords.map((w) => [w.text, w.start, w.end]), [['学', 3, 4]]);
    assert.deepEqual([a.facts.substitutedWords, a.facts.insertedText, a.facts.completeness, a.facts.canPraise, a.facts.stt.status], [[], [], 'incomplete', false, 'ok']);
    assert.equal(a.transcript, '我喜欢中文。');
    assert.deepEqual(a.savedMissed.map((s) => [s.text, s.pinyin, s.reason, s.start, s.end, s.missCount, s.isNew]), [['学', 'xué', 'omitted', 3, 4, 1, true]]);
    const lines = spokenText(r);
    assert.equal(lines[0], OPENER_ZH); assert.ok(lines[1].includes('学'), lines[1]);
    const cap = ev(r, 'coach_text')[1]; assert.deepEqual([cap.caption, cap.start, cap.end], ['学 xué', 3, 4]); // pinyin (+ gloss when known) travels as a caption; the spoken line stays Chinese
    assert.ok(noPraise(lines), lines.join('|'));
    assert.ok(ev(r, 'coach_audio').some((x) => x.text.includes('学'))); // the missed word is modelled via TTS
    const [done] = ev(r, 'done');
    assert.equal(done.corrections.length, 1); assert.deepEqual([done.corrections[0].kind, done.corrections[0].start, done.corrections[0].end, done.corrections[0].source], ['missing', 3, 4, 'server_fact']);
    assert.equal(chatCalls(), 0, 'no tone error to explain => the LLM is not on the critical path');
    for (const k of ['receiveMs', 'transcodeMs', 'assessMs', 'sttMs', 'analysisMs', 'firstCoachTextMs', 'firstAudioMs', 'totalMs']) assert.equal(typeof done.timings[k], 'number', k);
    assert.equal(done.summary.timings.totalMs, done.timings.totalMs);
    // list
    const l = await t.api('GET', '/api/words/missed');
    assert.deepEqual(l.json.map((w) => ({ ...w, lastMissedAt: typeof w.lastMissedAt })), [{ id: a.savedMissed[0].id, text: '学', pinyin: 'xué', meaning: null, missCount: 1, correctStreak: 0, needed: DRILL_GRADUATE_STREAK, lastMissedAt: 'string', sourceChunk: CHUNK, status: 'learning' }]);
    assert.ok(!Number.isNaN(Date.parse(l.json[0].lastMissedAt)));
  } finally { await t.close(); }
});

test('E2E clip 09 with STT TIMEOUT: acoustic-only => nothing is claimed missed, nothing saved, coach says it is unsure + that STT was unavailable; no praise', async () => {
  svc.state.sttDelayMs = 900;
  const t = await server(envOai({ STT_WAIT_MS: '250' }), { engine: await fixtureEngine('09-omit-xue-middle') });
  try {
    const t0 = Date.now();
    const r = await postAttempt(t, { fields: { chunkText: CHUNK } });
    assert.ok(Date.now() - t0 < 800, 'proceeds after the STT cap');
    const [a] = ev(r, 'assessment');
    assert.equal(a.facts.stt.status, 'timeout'); assert.deepEqual(a.facts.missingWords, []); assert.equal(a.facts.completeness, 'incomplete');
    const u = a.wordStatus.find((w) => w.text === '学'); assert.deepEqual([u.status, u.source, u.confidence], ['uncertain', 'acoustic', 'low']);
    assert.deepEqual(a.savedMissed, []);
    const lines = spokenText(r); assert.equal(lines[0], OPENER_ZH); assert.ok(lines.includes(STT_UNAVAILABLE_ZH), lines.join('|'));
    assert.ok(noPraise(lines));
    assert.ok(ev(r, 'status').some((s) => s.stage === 'transcribing' && s.skipped && s.code === 'stt_timeout'));
  } finally { await t.close(); }
});

test('E2E clip 10 (only half said): 好 missed+saved; 很 is only low-confidence "uncertain" (word score above the save threshold => not saved)', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('10-half-only-jintian-tian') });
  try {
    svc.state.sttText = await sttFixture('10-half-only-jintian-tian');
    const r = await postAttempt(t, { fields: { chunkText: '今天天气很好' } });
    const [a] = ev(r, 'assessment');
    assert.ok(a.facts.missingWords.some((w) => w.text === '很好' && w.missedText === '好' && w.confidence === 'high'));
    assert.equal(spokenText(r)[1], '“很好”这个词里漏掉了“好”。'); assert.equal(ev(r, 'done')[0].corrections.length, 1); // facts are per script word (很好); wordStatus is per character
    assert.deepEqual(a.savedMissed.map((s) => s.text), ['很好']);
    assert.equal(a.facts.canPraise, false); assert.ok(noPraise(spokenText(r)));
  } finally { await t.close(); }
});

test('E2E clip 08 (wrong sentence): low_match gate still composes — no word claims, nothing saved, fixed line, STT disagreement ignored', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('08-wrong-sentence') });
  try {
    svc.state.sttText = await sttFixture('08-wrong-sentence');
    const r = await postAttempt(t, { fields: { chunkText: '谢谢' } });
    const [a] = ev(r, 'assessment');
    assert.equal(a.gate, 'low_match'); assert.deepEqual(a.wordStatus, []); assert.deepEqual(a.savedMissed, []); assert.deepEqual(a.facts.missingWords, []);
    assert.deepEqual(spokenText(r), ['请再说一遍这句话。']); assert.equal(t.db.listMissed(true).length, 0);
  } finally { await t.close(); }
});

test('E2E clip 04 (said perfectly, real STT returned plain text): praise allowed, verified, nothing saved', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('04-xihuan-zhongwen-correct') });
  try {
    svc.state.sttText = await sttFixture('04-xihuan-zhongwen-correct');
    const r = await postAttempt(t, { fields: { chunkText: CHUNK } });
    const [a] = ev(r, 'assessment');
    assert.deepEqual([a.facts.completeness, a.facts.canPraise, a.savedMissed.length], ['verified', true, 0]);
    assert.equal(ev(r, 'coach_text')[0].role, 'praise');
  } finally { await t.close(); }
});

test('E2E: STT mismatch only (good acoustics, transcript has a different word) => substituted/medium with heard text; saved; coach names it; STT never drives a tone claim', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('06-jintian-tianqi-correct') });
  try {
    svc.state.sttText = '今天天气很棒。';
    const r = await postAttempt(t, { fields: { chunkText: '今天天气很好' } });
    const [a] = ev(r, 'assessment');
    const s = a.wordStatus.find((w) => w.status === 'substituted');
    assert.deepEqual([s.text, s.heard, s.source, s.confidence, s.start, s.end], ['好', '棒', 'stt', 'medium', 5, 6]);
    assert.deepEqual(a.facts.substitutedWords.map((w) => [w.text, w.heard]), [['很好', '棒']]);
    assert.deepEqual(a.savedMissed.map((x) => [x.text, x.reason]), [['很好', 'substituted']]);
    assert.deepEqual(a.facts.confirmedToneErrors, []);
    const lines = spokenText(r); assert.equal(lines[0], OPENER_ZH); assert.ok(lines[1].includes('很好') && lines[1].includes('棒'), lines[1]);
  } finally { await t.close(); }
});

// ---------------- list endpoints
test('missed list: dedupe by text, missCount increments, order missCount desc then lastMissedAt desc, ?all=1, known/learning/delete 204/404, streak reset on known', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('09-omit-xue-middle') });
  try {
    await attempt09(t); await attempt09(t);
    let l = (await t.api('GET', '/api/words/missed')).json; assert.equal(l.length, 1); assert.equal(l[0].missCount, 2);
    t.db.recordMiss({ text: '文化', pinyin: 'wénhuà', sourceChunk: '文化很好' });
    t.db.recordMiss({ text: '朋友', pinyin: 'péngyou', sourceChunk: '朋友' }); // newest
    l = (await t.api('GET', '/api/words/missed')).json; assert.deepEqual(l.map((w) => w.text), ['学', '朋友', '文化']);
    const id = l[0].id;
    assert.equal((await t.api('POST', `/api/words/missed/${id}/known`)).status, 204);
    assert.deepEqual((await t.api('GET', '/api/words/missed')).json.map((w) => w.text), ['朋友', '文化']);
    const all = (await t.api('GET', '/api/words/missed?all=1')).json; assert.equal(all.length, 3); assert.equal(all.find((w) => w.id === id).status, 'known');
    assert.equal((await t.api('POST', `/api/words/missed/${id}/learning`)).status, 204);
    assert.equal((await t.api('GET', '/api/words/missed')).json.find((w) => w.id === id).status, 'learning');
    assert.equal((await t.api('DELETE', `/api/words/missed/${id}`)).status, 204);
    assert.equal((await t.api('DELETE', `/api/words/missed/${id}`)).status, 404);
    assert.equal((await t.api('POST', '/api/words/missed/99999/known')).status, 404);
    assert.equal((await t.api('POST', '/api/words/missed/abc/known')).status, 404);
    assert.equal((await t.api('GET', '/api/words/missed', undefined, { auth: false })).status, 401);
    // the older saved-words API is untouched
    assert.equal((await t.api('GET', '/api/words')).status, 200);
  } finally { await t.close(); }
});

test('graduation after DRILL_GRADUATE_STREAK correct drills; a miss resets the streak; known words leave the drill queue', async () => {
  assert.equal(DRILL_GRADUATE_STREAK, 3);
  const db = openDb(':memory:');
  const { id } = db.recordMiss({ text: '学', pinyin: 'xué', sourceChunk: CHUNK });
  let r = db.recordDrill(id, true, 3); assert.deepEqual([r.word.correctStreak, r.graduated, r.word.status], [1, false, 'learning']);
  r = db.recordDrill(id, true, 3); assert.equal(r.word.correctStreak, 2);
  r = db.recordDrill(id, false, 3); assert.deepEqual([r.word.correctStreak, r.graduated, r.word.status], [0, false, 'learning']);
  for (let i = 1; i <= 3; i++) { r = db.recordDrill(id, true, 3); assert.equal(r.graduated, i === 3); }
  assert.equal(r.word.status, 'known'); assert.equal(db.drillQueue(5).length, 0);
  db.recordMiss({ text: '学', pinyin: 'xué', sourceChunk: CHUNK }); // missing it again brings it back
  const w = db.getMissedByText('学'); assert.deepEqual([w.status, w.correctStreak, w.missCount], ['learning', 0, 3]); // the failed drill counted as a miss too
  db.close();
});

test('migration: opening an OLD database (no missed_words table) keeps saved_words/prefs intact and adds the table', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mig-')), 'old.db');
  const first = openDb(f); first.raw.exec('DROP TABLE missed_words'); first.raw.prepare("INSERT INTO saved_words (text) VALUES ('你好')").run?.(); first.close();
  const again = openDb(f);
  assert.ok(again.raw.prepare("select name from sqlite_master where name='missed_words'").get());
  assert.equal(again.raw.prepare('select count(*) c from saved_words').get().c, 1);
  again.close(); fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

// ---------------- drills
test('DRILL e2e: server decides correct; 3 correct -> graduated; a missed take resets; client "correct" field ignored; gate not counted; shapes', async () => {
  const eng = await switchableEngine('04-xihuan-zhongwen-correct');
  const t = await server(envOai(), { engine: eng });
  try {
    const { id } = t.db.recordMiss({ text: '学', pinyin: 'xué', sourceChunk: CHUNK });
    const next = (await t.api('GET', '/api/drill/next?n=5')).json;
    assert.deepEqual(next, [{ wordId: id, text: '学', pinyin: 'xué', meaning: null, exampleSentence: CHUNK, promptText: CHUNK, correctStreak: 0, needed: 3 }]);
    svc.state.sttText = await sttFixture('04-xihuan-zhongwen-correct');
    // client tries to cheat
    let r = await postDrill(t, { wordId: id, fields: { correct: 'true' } });
    let [done] = ev(r, 'done'); const [a] = ev(r, 'assessment');
    assert.deepEqual(a.target, { wordId: id, text: '学', start: 3, end: 4 });
    assert.deepEqual([done.correct, done.counted, done.correctStreak, done.needed, done.graduated, done.wordId], [true, true, 1, 3, false, id]);
    assert.equal(typeof done.timings.totalMs, 'number'); assert.ok(ev(r, 'coach_text').length > 0);
    // a take with 学 skipped (real clip 09 + its real transcript) => incorrect, streak reset, short code-built correction naming 学
    await eng.use('09-omit-xue-middle'); svc.state.sttText = await sttFixture('09-omit-xue-middle');
    r = await postDrill(t, { wordId: id }); [done] = ev(r, 'done');
    assert.deepEqual([done.correct, done.correctStreak, done.graduated], [false, 0, false]);
    assert.ok(spokenText(r).some((l) => l.includes('学')) && noPraise(spokenText(r)));
    assert.equal(done.corrections.length, 1);
    // wrong sentence => gated, NOT counted
    await eng.use('08-wrong-sentence'); r = await postDrill(t, { wordId: id }); [done] = ev(r, 'done');
    assert.deepEqual([done.correct, done.counted, done.correctStreak, done.reason], [false, false, 0, 'low_match']);
    // three good takes graduate
    await eng.use('04-xihuan-zhongwen-correct'); svc.state.sttText = await sttFixture('04-xihuan-zhongwen-correct');
    const out = [];
    for (let i = 0; i < 3; i++) { r = await postDrill(t, { wordId: id }); out.push(ev(r, 'done')[0]); }
    assert.deepEqual(out.map((d) => [d.correctStreak, d.graduated]), [[1, false], [2, false], [3, true]]);
    assert.equal(t.db.getMissed(id).status, 'known');
    assert.deepEqual((await t.api('GET', '/api/drill/next')).json, []);
    // errors
    assert.equal((await postDrill(t, { wordId: 99999 })).status, 404);
    assert.equal((await t.api('POST', '/api/drill/attempt', {})).status, 400);
  } finally { await t.close(); }
});

test('DRILL: a multi-character word is drilled on its own text (not the sentence)', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('01-nihao-correct') });
  try {
    const { id } = t.db.recordMiss({ text: '你好', pinyin: 'nǐhǎo', sourceChunk: '你好吗' });
    assert.equal((await t.api('GET', '/api/drill/next')).json[0].promptText, '你好');
    svc.state.sttText = '你好。';
    const r = await postDrill(t, { wordId: id }); assert.equal(ev(r, 'done')[0].correct, true);
    assert.equal(tp.requests.length, 0); // (engine override) no TonePerfect traffic in tests
  } finally { await t.close(); }
});

// ---------------- data minimisation + prefs
test('NO audio and NO transcript is persisted: the only things stored are word text/pinyin/gloss/counters/source chunk', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('09-omit-xue-middle') });
  const before = fs.readdirSync(os.tmpdir()).length;
  try {
    await attempt09(t);
    const dump = JSON.stringify(['prefs', 'saved_words', 'word_history', 'missed_words'].map((n) => t.db.raw.prepare(`select * from ${n}`).all()));
    assert.ok(!dump.includes('我喜欢中文'), 'the STT transcript must not be stored'); // chunk is 我喜欢学中文; transcript 我喜欢中文。
    assert.ok(dump.includes(CHUNK));
    const cols = t.db.raw.prepare('pragma table_info(missed_words)').all().map((c) => c.name).sort();
    assert.deepEqual(cols, ['correct_streak', 'created_at', 'gloss_tried', 'id', 'last_missed_at', 'miss_count', 'meaning', 'pinyin', 'source_chunk', 'status', 'text'].sort());
    assert.equal(fs.readdirSync(os.tmpdir()).length, before);
  } finally { await t.close(); }
});

test('gloss: filled once via the cheap LLM when OpenAI is available (cached, English only), null otherwise; failure not retried', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('09-omit-xue-middle') });
  try {
    svc.state.chatScript = JSON.stringify({ meaning: 'to study' });
    await attempt09(t);
    for (let i = 0; i < 20 && !t.db.getMissedByText('学').meaning; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.db.getMissedByText('学').meaning, 'to study');
    const calls = chatCalls(); await attempt09(t); await new Promise((r) => setTimeout(r, 100));
    assert.equal(chatCalls(), calls, 'cached gloss is not requested again');
    assert.equal((await t.api('GET', '/api/words/missed')).json[0].meaning, 'to study');
  } finally { await t.close(); }
  const t2 = await server({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect' }, { engine: await fixtureEngine('09-omit-xue-middle') });
  try {
    const r = await postAttempt(t2, { fields: { chunkText: CHUNK } });
    const [a] = ev(r, 'assessment'); assert.equal(a.facts.stt.status, 'unavailable'); assert.deepEqual(a.facts.missingWords, []);
    assert.equal(spokenText(r)[0], OPENER_ZH);
    assert.equal(t2.db.listMissed(true).length, 0); // acoustic-only low-confidence flag with score >= SAVE_LOW_SCORE_WORD_MAX is not saved
  } finally { await t2.close(); }
});

test("prefs: practiceMode 'trouble_word' is accepted (drill client mode) but /api/attempt has no such mode", async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('04-xihuan-zhongwen-correct') });
  try {
    const p = await t.api('PUT', '/api/prefs', { practiceMode: 'trouble_word' });
    assert.ok(p.status === 200 || p.status === 204, p.text);
    assert.equal((await t.api('GET', '/api/prefs')).json.practiceMode, 'trouble_word');
  } finally { await t.close(); }
});

test('DEFAULT tone path (no COACH_LLM_TONE): the LLM is NOT called; opener then the code-built tone facts (max 2 corrections), no praise — real clip 05', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    svc.state.sttText = await sttFixture('05-xihuan-zhongwen-wrong-tone');
    const r = await postAttempt(t, { fields: { chunkText: CHUNK } });
    assert.equal(chatCalls(), 0);
    const lines = spokenText(r); assert.equal(lines[0], OPENER_ZH);
    const [done] = ev(r, 'done');
    assert.equal(done.corrections.length, 2); assert.ok(done.corrections.every((c) => c.kind === 'tone' && c.source === 'server_fact'));
    assert.ok(noPraise(lines), lines.join('|')); assert.equal(done.summary.llmCalled, false);
  } finally { await t.close(); }
});
