// FREE TALK: /api/talk/turn (STT -> transcript -> parallel streamed reply + correction finder [+ optional tone]), /api/talk/opening, /api/talk/summary.
// Fakes only (fake OpenAI incl. STT/LLM/TTS, fake TonePerfect); no network, no keys.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { startTestServer, fixtureEngine } from './helpers.js';
import { startFakeToneperfect } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';
import { parseTalkContext, validateFind, validateSummary, validateOpening, talkGate, talkStats, parseScriptVocab, cleanReplySentences, TalkSchemaError,
  TALK_GATE_ZH, TALK_FALLBACK_ZH, TALK_THEN_ZH, TALK_NATURAL_ZH, TALK_MAX_TURNS, TALK_MAX_TURN_CHARS, TALK_MAX_CONTEXT_CHARS } from '../services/talk.js';

const TP_KEY = 'tp_test_FAKEKEYFORTESTS0123456789'; const OAI_KEY = 'sk-fakeopenaikey0123456789';
let tp; let svc;
before(async () => { tp = await startFakeToneperfect(); svc = await startFakeServices(); });
after(async () => { await tp.close(); await svc.close(); });
beforeEach(() => { tp.reset(); svc.reset(); svc.state.chatScript = null; });

const envOai = (x = {}) => ({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect', OPENAI_API_KEY: OAI_KEY, OPENAI_BASE_URL: svc.openaiBase, ...x });
async function server(env, opts) { const t = await startTestServer(env, opts); await t.login(); return t; }
const ev = (r, n) => r.events.filter((e) => e.event === n).map((e) => e.data);
const names = (r) => r.events.map((e) => e.event);
const lines = (r) => ev(r, 'coach_text').map((x) => x.delta);
const roles = (r) => ev(r, 'coach_text').map((x) => x.role);
const chatCalls = () => svc.state.requests.filter((r) => r.url === '/v1/chat/completions').length;
const NO_TONE_WORDS = /声调|音调|声|发音|读音|语调|tone|pitch|pronounc/i;

const TOPIC = '我的周末';
const SAID = '我昨天去商店买了一个很多苹果，然后我回家。';
const REPLY = (over = {}) => ({ replyZh: '听起来很不错！', questionZh: '你最喜欢吃什么水果？', ...over });
const FIND = (over = {}) => ({ correction: null, vocabHints: [], natural: false, ...over });
const GOOD_FIX = { kind: 'word_choice', quote: '一个很多苹果', betterZh: '很多苹果', explainZh: '“很多”前面不用“一个”。', confidence: 'high' };
const marker = (j) => /TALK_(REPLY|FIND|OPEN|SUMMARY)/.exec(j.messages[0].content)?.[1];
const OPEN = { textZh: '这个周末你想做什么？' };
const SUMMARY = (over = {}) => ({
  takeaways: [{ textEn: 'You described what you bought and where you went.', textZh: '我去商店买了苹果。' }, { textEn: 'You linked two actions with 然后.', textZh: '然后我回家。' }, { textEn: 'You kept the topic going.', textZh: '我的周末很有意思。' }],
  newWords: [{ text: '水果', meaning: 'fruit', exampleZh: '我喜欢吃水果。' }], phrasesToTry: [{ zh: '我买了很多苹果。', en: 'I bought a lot of apples.', whyEn: 'Natural way to say a large amount.' }],
  strengths: ['Clear sequence of events.'], ...over });
/** LLM fake selected by the system-prompt marker; any entry may be a function(request) or a raw string (to send malformed output). */
const llm = ({ reply = REPLY(), find = FIND(), open = OPEN, summary = SUMMARY() } = {}) => (j) => {
  const v = { REPLY: reply, FIND: find, OPEN: open, SUMMARY: summary }[marker(j)]; const x = typeof v === 'function' ? v(j) : v;
  return typeof x === 'string' ? x : JSON.stringify(x);
};
const ctxOf = (over = {}) => ({ topic: TOPIC, turns: [{ role: 'coach', text: '周末你做了什么？' }], ...over });
async function postTurn(t, { audio = Buffer.alloc(2000, 7), ctx = ctxOf(), fields = {}, noAudio = false, rawContext, headers = {}, mime = 'audio/mp4' } = {}) {
  const form = new FormData();
  if (!noAudio) form.append('audio', new Blob([audio], { type: mime }), 'rec.m4a');
  const f = { context: rawContext ?? JSON.stringify(ctx), attemptId: 'talk-' + Math.random().toString(36).slice(2, 12), ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) form.append(k, v);
  const res = await fetch(t.base + '/api/talk/turn', { method: 'POST', body: form, headers: { Cookie: t.cookie(), ...headers } });
  const text = await res.text(); const events = [];
  for (const block of text.split('\n\n')) { const m = /^event: (\w+)\ndata: (.*)$/ms.exec(block.trim()); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); }
  let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, events, text, headers: res.headers, json, attemptId: f.attemptId };
}
const turn = async (t, { stt = SAID, script = llm(), ...o } = {}) => { svc.state.sttText = stt; svc.state.chatScript = script; return postTurn(t, o); };
const done = (r) => ev(r, 'done')[0];

// ------------------------------------------------------------------------------------------------ pure helpers
test('parseTalkContext: caps turns / chars / vocab, validates shape, defaults', () => {
  const ok = parseTalkContext(JSON.stringify({ topic: ' 旅游 ', turns: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'user' : 'coach', text: '你好' + i })), scriptVocab: [{ text: '苹果' }, '香蕉', { text: '苹果' }] }));
  assert.equal(ok.ctx.topic, '旅游'); assert.equal(ok.ctx.level, 'normal'); assert.equal(ok.ctx.tone, false);
  assert.equal(ok.ctx.turns.length, TALK_MAX_TURNS); assert.equal(ok.ctx.turnsSent, 20); assert.equal(ok.ctx.turnsUsed, TALK_MAX_TURNS); assert.deepEqual(ok.ctx.scriptVocab.map((v) => v.text), ['苹果', '香蕉']);
  assert.equal(ok.ctx.scriptVocab[0].pinyin, 'píng guǒ');   // pinyin always computed by code
  const long = parseTalkContext(JSON.stringify({ topic: 'a', turns: [{ role: 'user', text: '好'.repeat(5000) }, { role: 'coach', text: '好'.repeat(TALK_MAX_TURN_CHARS) }, { role: 'user', text: '好'.repeat(TALK_MAX_TURN_CHARS) }] }));
  assert.ok(long.ctx.turns.every((x) => Array.from(x.text).length <= TALK_MAX_TURN_CHARS)); assert.ok(long.ctx.turns.reduce((n, x) => n + Array.from(x.text).length, 0) <= TALK_MAX_CONTEXT_CHARS);
  for (const bad of ['', 'nope', '[]', '{"turns":[{"role":"robot","text":"x"}]}', '{"turns":"x"}', '{"topic":5}', '{"level":"hard"}', '{"tone":"yes"}', '{"scriptVocab":"x"}']) assert.ok(parseTalkContext(bad).error, bad);
  assert.equal(parseTalkContext(JSON.stringify({ scriptVocab: Array.from({ length: 300 }, (_, i) => ({ text: '词' + i })) })).error.status, 413);
  assert.deepEqual(parseTalkContext(JSON.stringify({ topic: 'x', level: 'easy', tone: true })).ctx.level, 'easy');
});
test('talkGate: empty / too short / STT hallucination; English counts as speech', () => {
  assert.equal(talkGate(''), 'empty'); assert.equal(talkGate('  。 '), 'empty'); assert.equal(talkGate('好'), 'too_short'); assert.equal(talkGate('谢谢观看'), 'hallucination');
  assert.equal(talkGate('请不吝点赞 订阅 转发'), 'hallucination'); assert.equal(talkGate('Thanks for watching'), 'hallucination');
  assert.equal(talkGate('我喜欢这个周末。'), null); assert.equal(talkGate('我想说 breakfast'), null); assert.equal(talkGate('我今天去了商店，谢谢观看这个视频的人们都很好'), null);
});
test('validateFind: quote verified in transcript; high confidence only; homophone / no-change / rewrite dropped; vocab only from scriptVocab and not already used', () => {
  const ctx = { scriptVocab: [{ text: '苹果', pinyin: 'píng guǒ' }, { text: '香蕉', pinyin: 'xiāng jiāo' }] };
  const v = (c, t = SAID, extra = {}) => validateFind({ correction: c, vocabHints: [], natural: false, ...extra }, { transcript: t, ctx });
  assert.equal(v(GOOD_FIX).correction.quote, '一个很多苹果');
  assert.equal(v({ ...GOOD_FIX, quote: '一个很多香蕉' }).correction, null); assert.ok(v({ ...GOOD_FIX, quote: '一个很多香蕉' }).dropped.includes('correction_quote_not_in_transcript'));
  assert.equal(v({ ...GOOD_FIX, confidence: 'medium' }).correction, null); assert.equal(v({ ...GOOD_FIX, kind: 'pronunciation' }).correction, null);
  assert.equal(v({ ...GOOD_FIX, betterZh: '一个很多苹果' }).correction, null);
  assert.equal(v({ ...GOOD_FIX, quote: '商店', betterZh: '伤店' }).correction, null);                                   // same sounds: never a text error
  assert.equal(v({ ...GOOD_FIX, explainZh: '你的第三声读错了。' }).correction.explainZh.includes('声'), false);              // tone claim rewritten to the generic line
  assert.equal(v({ ...GOOD_FIX, explainZh: 'The tone is wrong' }).correction.explainZh.includes('tone'), false);
  assert.equal(v({ ...GOOD_FIX, betterZh: 'a lot of apples' }).correction, null);
  const eg = v({ kind: 'english_gap', quote: 'breakfast', betterZh: '早餐', explainZh: '“breakfast”可以说“早餐”。', confidence: 'high' }, '我今天吃了 breakfast。').correction; assert.equal(eg.kind, 'english_gap'); assert.equal(eg.quote, 'breakfast');
  assert.equal(v({ kind: 'english_gap', quote: 'lunch', betterZh: '午饭', explainZh: '午饭。', confidence: 'high' }, '我今天吃了 breakfast。').correction, null);
  assert.equal(validateFind(FIND({ vocabHints: ['苹果', '榴莲', '香蕉'] }), { transcript: '我喜欢吃面条。', ctx }).vocabHints.map((h) => h.text).join(), '苹果,香蕉');
  assert.equal(validateFind(FIND({ vocabHints: ['苹果'] }), { transcript: SAID, ctx }).vocabHints.length, 0);   // he already said 苹果
  assert.equal(validateFind(FIND({ natural: true, correction: GOOD_FIX }), { transcript: SAID, ctx }).natural, false);
  assert.throws(() => validateFind('x', { transcript: SAID, ctx }), TalkSchemaError); assert.throws(() => validateFind({ correction: 5 }, { transcript: SAID, ctx }), TalkSchemaError);
  assert.throws(() => validateFind({ correction: null, vocabHints: 'x' }, { transcript: SAID, ctx }), TalkSchemaError);
  // trad transcript: quote is mapped back to the transcript's own spelling
  assert.equal(v({ ...GOOD_FIX, quote: '一个很多苹果' }, '我昨天去商店買了一個很多蘋果。').correction.quote, '一個很多蘋果');
});
test('cleanReplySentences: tone / pronunciation talk, praise of Chinese, latin text and over-long sentences never reach the learner', () => {
  assert.deepEqual(cleanReplySentences('你的声调很准。你周末做了什么？'), ['你周末做了什么？']);
  assert.deepEqual(cleanReplySentences('你的中文说得真好！今天天气怎么样？'), ['今天天气怎么样？']);
  assert.deepEqual(cleanReplySentences('That is great！你喜欢哪里？'), ['你喜欢哪里？']);
  assert.deepEqual(cleanReplySentences(''), []); assert.deepEqual(cleanReplySentences(5), []);
});
test('validateOpening / validateSummary: strict schema, claims filtered, stats by code', () => {
  assert.equal(validateOpening({ textZh: '这个周末你想做什么？' }).pinyin.length > 0, true);
  for (const bad of [null, {}, { textZh: 5 }, { textZh: '好' }, { textZh: 'Hello how are you today' }, { textZh: '你的声调怎么样？' }]) assert.throws(() => validateOpening(bad), TalkSchemaError, JSON.stringify(bad));
  const s = validateSummary(SUMMARY({ strengths: ['Good tones!', 'Clear sequence of events.'], newWords: [{ text: '水果', meaning: 'fruit', exampleZh: '我喜欢吃水果。' }, { text: '苹果', meaning: 'apple', exampleZh: '没有这个词。' }, { text: 'fruit', meaning: 'x', exampleZh: '水果' }] }));
  assert.deepEqual(s.strengths, ['Clear sequence of events.']); assert.deepEqual(s.newWords.map((w) => w.text), ['水果']); assert.equal(s.newWords[0].pinyin, 'shuǐ guǒ');
  assert.throws(() => validateSummary({ takeaways: [], phrasesToTry: [], strengths: [] }), TalkSchemaError); assert.throws(() => validateSummary({ takeaways: 'x' }), TalkSchemaError);
  assert.deepEqual(talkStats([{ role: 'coach', text: '你好吗？' }, { role: 'user', text: '我很好，thanks.' }, { role: 'user', text: '你呢' }]), { turns: 3, userTurns: 2, approxCharsSpoken: 5 });
  assert.deepEqual(parseScriptVocab([{ text: '苹果' }, { text: 'apple' }, { text: '' }]).list.map((x) => x.text), ['苹果']);
});

// ------------------------------------------------------------------------------------------------ /api/talk/turn
test('TURN happy path: events in order; transcript first; reply, correction, model, question spoken in that order; one correction; done has everything; no tone claims', async () => {
  const t = await server(envOai());
  try {
    const r = await turn(t, { script: llm({ find: FIND({ correction: GOOD_FIX, vocabHints: ['苹果'] }) }), ctx: ctxOf({ scriptVocab: [{ text: '苹果' }, { text: '香蕉' }] }) });
    assert.equal(r.status, 200); const n = names(r);
    assert.equal(n[0], 'status'); assert.ok(n.indexOf('transcript') < n.indexOf('coach_text')); assert.ok(n.indexOf('coach_text') < n.indexOf('coach_audio')); assert.equal(n.at(-1), 'done'); assert.equal(ev(r, 'assessment').length, 0);
    assert.deepEqual(ev(r, 'transcript')[0], { text: SAID, sttStatus: 'ok', hanziCount: 19, hasEnglish: false });
    assert.deepEqual(roles(r), ['reply', 'correction', 'correction_model', 'question']);
    assert.equal(lines(r)[0], '听起来很不错！'); assert.equal(lines(r)[3], '你最喜欢吃什么水果？'); assert.match(lines(r)[2], /^可以这样说：很多苹果$/);
    assert.deepEqual(ev(r, 'coach_text').map((x) => x.index), [0, 1, 2, 3]);
    assert.equal(ev(r, 'coach_audio').length, 4);
    const d = done(r);
    assert.deepEqual(d.correction, { kind: 'word_choice', quote: '一个很多苹果', betterZh: '很多苹果', explainZh: '“很多”前面不用“一个”。', pinyin: 'hěn duō píng guǒ', source: 'llm' });
    assert.deepEqual(d.suggestedWords.map((w) => [w.text, w.reason]), [['很多苹果', 'word_choice']]);        // 苹果 already said -> no vocab hint
    assert.deepEqual(d.vocabHints, []); assert.equal(d.replyZh, '听起来很不错！'); assert.equal(d.questionZh, '你最喜欢吃什么水果？');
    for (const k of ['sttMs', 'replyFirstTokenMs', 'replyMs', 'correctionMs', 'firstCoachTextMs', 'totalMs']) assert.equal(typeof d.timings[k], 'number', k);
    assert.equal(d.summary.tone, 'skipped'); assert.equal(d.summary.toneReason, 'not_requested');
    assert.ok(lines(r).every((l) => !NO_TONE_WORDS.test(l)));
    assert.equal(tp.requests.length, 0, 'tone is skipped by default: no TonePerfect call');
    assert.equal(chatCalls(), 2);
  } finally { await t.close(); }
});
test('TURN: nothing clearly wrong => no correction invented; natural turn gets at most a short fixed natural line; model prompts say how to behave', async () => {
  const t = await server(envOai());
  try {
    const r = await turn(t, { stt: '周末我喜欢和朋友一起去公园散步。', script: llm({ find: FIND({ natural: true }) }) });
    assert.deepEqual(roles(r), ['reply', 'praise', 'question']); assert.ok(TALK_NATURAL_ZH.includes(lines(r)[1])); assert.equal(done(r).correction, null); assert.deepEqual(done(r).suggestedWords, []);
    const find = svc.state.requests.filter((x) => x.json?.messages?.[0]?.content?.includes('TALK_FIND'))[0].json;
    assert.equal(find.temperature, 0); assert.match(find.messages[0].content, /highly confident/); assert.match(find.messages[0].content, /speech-to-text/i);
    const r2 = await turn(t, { stt: '周末我喜欢和朋友一起去公园散步。', script: llm({ find: FIND() }) });
    assert.deepEqual(roles(r2), ['reply', 'question']); assert.equal(done(r2).correction, null);
  } finally { await t.close(); }
});
test('TURN: hallucinated quote => dropped (no correction); medium confidence dropped; two corrections requested => still at most one', async () => {
  const t = await server(envOai());
  try {
    let r = await turn(t, { script: llm({ find: FIND({ correction: { ...GOOD_FIX, quote: '我昨天去学校了' } }) }) });
    assert.equal(done(r).correction, null); assert.equal(done(r).summary.droppedClaims, 1); assert.deepEqual(roles(r), ['reply', 'question']);
    r = await turn(t, { script: llm({ find: FIND({ correction: { ...GOOD_FIX, confidence: 'low' } }) }) }); assert.equal(done(r).correction, null);
    r = await turn(t, { script: llm({ find: FIND({ correction: [GOOD_FIX, { ...GOOD_FIX, quote: '然后我回家' }] }) }) });   // an array is not the schema: finder fails, no correction, reply unaffected
    assert.equal(done(r).correction, null); assert.match(done(r).correctionStatus, /^unavailable/); assert.equal(done(r).replyZh, '听起来很不错！');
    r = await turn(t, { script: llm({ find: FIND({ correction: GOOD_FIX }) }) }); assert.equal(roles(r).filter((x) => x === 'correction').length, 1);
  } finally { await t.close(); }
});
test('TURN: tone / pronunciation claims in the LLM output are dropped or rewritten (reply, question, explanation, model); the transcript never yields a tone claim', async () => {
  const t = await server(envOai());
  try {
    const r = await turn(t, { script: llm({ reply: REPLY({ replyZh: '你的第三声很准。我也喜欢周末。', questionZh: '你的发音真好！你周末做了什么？' }), find: FIND({ correction: { ...GOOD_FIX, explainZh: '你的声调不对，要读第二声。' } }) }) });
    assert.ok(lines(r).length >= 3); assert.ok(lines(r).every((l) => !NO_TONE_WORDS.test(l)), lines(r).join('|'));
    assert.ok(!NO_TONE_WORDS.test(JSON.stringify(done(r).correction)), JSON.stringify(done(r).correction)); assert.equal(done(r).correction.kind, 'word_choice');
    assert.ok(lines(r).includes('我也喜欢周末。'));
  } finally { await t.close(); }
});
test('TURN english_gap: English in the transcript => Mandarin word with pinyin as the model, NOT an error, offered as a suggested word', async () => {
  const t = await server(envOai());
  try {
    const gap = { kind: 'english_gap', quote: 'breakfast', betterZh: '早餐', explainZh: '“breakfast”用中文可以说“早餐”。', confidence: 'high' };
    const r = await turn(t, { stt: '我今天早上吃了 breakfast，很好吃。', script: llm({ find: FIND({ correction: gap }) }) });
    assert.equal(ev(r, 'transcript')[0].hasEnglish, true); const d = done(r);
    assert.deepEqual(d.correction, { kind: 'english_gap', quote: 'breakfast', betterZh: '早餐', explainZh: '这个意思可以用中文这样说。', pinyin: 'zǎo cān', source: 'server' });   // explanation had latin text: replaced by the fixed line
    assert.deepEqual(d.suggestedWords, [{ text: '早餐', pinyin: 'zǎo cān', meaning: 'breakfast', reason: 'english_gap' }]);
    assert.deepEqual(roles(r), ['reply', 'correction', 'correction_model', 'question']); assert.equal(lines(r)[2], '可以这样说：早餐');
    assert.equal(ev(r, 'coach_text').some((x) => /[A-Za-z]/.test(x.delta)), false, 'no latin text is ever spoken');
    // English-only turn is still a turn (not noise)
    const r2 = await turn(t, { stt: 'I do not know how to say breakfast', script: llm({ find: FIND({ correction: gap }) }) }); assert.equal(ev(r2, 'transcript')[0].sttStatus, 'ok'); assert.equal(done(r2).correction.kind, 'english_gap');
  } finally { await t.close(); }
});
test('TURN vocabHints: only entries of the SENT scriptVocab, not already said; spoken as one short line when there is no correction', async () => {
  const t = await server(envOai());
  try {
    const sv = [{ text: '水果', pinyin: 'ignored-by-code' }, { text: '香蕉' }];
    const r = await turn(t, { stt: '我周末买了很多好吃的东西。', ctx: ctxOf({ scriptVocab: sv }), script: llm({ find: FIND({ vocabHints: ['水果', '榴莲'] }) }) });
    const d = done(r); assert.deepEqual(d.vocabHints, [{ text: '水果', pinyin: 'shuǐ guǒ' }]); assert.deepEqual(d.suggestedWords, [{ text: '水果', pinyin: 'shuǐ guǒ', meaning: null, reason: 'script_vocab' }]);
    assert.deepEqual(roles(r), ['reply', 'vocab', 'question']); assert.equal(lines(r)[1], '你也可以用“水果”这个词。');
    const r2 = await turn(t, { stt: '我周末买了很多好吃的东西。', ctx: ctxOf(), script: llm({ find: FIND({ vocabHints: ['水果'] }) }) });   // no scriptVocab sent => nothing can be hinted
    assert.deepEqual(done(r2).vocabHints, []); assert.deepEqual(roles(r2), ['reply', 'question']);
  } finally { await t.close(); }
});
test('TURN stateless: only the last turns are used (capped), nothing persisted (DB, temp dir), no words saved; recordings/transcripts are not stored', async () => {
  const priv = fs.mkdtempSync((fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()) + '/talk-priv-'); const oldTmp = process.env.TMPDIR; process.env.TMPDIR = priv;
  const t = await server(envOai());
  const snap = () => JSON.stringify(t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => [x.name, t.db.raw.prepare(`select * from ${x.name}`).all()]));
  try {
    const s0 = snap();
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'user' : 'coach', text: i < 22 ? `旧的第${i}句话` : `新的第${i}句话` }));
    const r = await turn(t, { ctx: ctxOf({ turns }), script: llm({ find: FIND({ correction: GOOD_FIX }) }) });
    assert.equal(done(r).summary.turnsSent, 30); assert.equal(done(r).summary.turnsUsed, TALK_MAX_TURNS);
    const sent = svc.state.requests.filter((x) => x.json?.messages?.[0]?.content?.includes('TALK_REPLY'))[0].json.messages[1].content;
    assert.ok(sent.includes('新的第29句话') && sent.includes('新的第22句话') && !sent.includes('旧的第21句话')); assert.ok(sent.includes(SAID));
    const s1 = snap(); assert.equal(s0, s1, 'database unchanged'); assert.ok(!s1.includes('很多苹果') && !s1.includes(SAID) && !s1.includes('新的第29'));
    assert.deepEqual(t.db.listMissed(), []); assert.deepEqual(fs.readdirSync(priv), [], 'nothing written to the temp dir');
  } finally { await t.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(priv, { recursive: true, force: true }); }
});
test('TURN idempotent replay: same attemptId => recorded events, no second STT/LLM call; a failed attempt re-runs', async () => {
  const t = await server(envOai());
  try {
    const script = llm({ find: FIND({ correction: GOOD_FIX }) });
    svc.state.sttText = SAID; svc.state.chatScript = script;
    const a = await postTurn(t, { fields: { attemptId: 'talk-replay-0001' } }); const stt = () => svc.state.requests.filter((x) => x.url === '/v1/audio/transcriptions').length; const c = chatCalls();
    const b = await postTurn(t, { fields: { attemptId: 'talk-replay-0001' } });
    assert.equal(b.headers.get('x-attempt-replayed'), 'true'); assert.deepEqual(names(b), names(a)); assert.equal(stt(), 1); assert.equal(chatCalls(), c);
    svc.state.sttStatus = 500; const f1 = await postTurn(t, { fields: { attemptId: 'talk-fail-00001' } }); assert.equal(ev(f1, 'error')[0].stage, 'transcribing');
    svc.state.sttStatus = 200; const f2 = await postTurn(t, { fields: { attemptId: 'talk-fail-00001' } }); assert.equal(names(f2).at(-1), 'done');
  } finally { await t.close(); }
});
test('TURN gate: empty / too short / hallucinated transcript => the fixed line, no LLM, no TonePerfect, done.gate set', async () => {
  const t = await server(envOai());
  try {
    for (const [stt, gate] of [['', 'empty'], ['好', 'too_short'], ['谢谢观看', 'hallucination']]) {
      svc.state.requests.length = 0;
      const r = await turn(t, { stt, ctx: ctxOf({ tone: true }) });
      assert.equal(ev(r, 'transcript')[0].sttStatus, gate); assert.deepEqual(lines(r), [TALK_GATE_ZH]); assert.equal(roles(r)[0], 'gate');
      assert.equal(done(r).gate, gate); assert.equal(done(r).correction, null); assert.equal(done(r).summary.llmCalled, false); assert.equal(chatCalls(), 0); assert.equal(tp.requests.length, 0);
    }
  } finally { await t.close(); }
});
test('TURN errors: STT failure, no OpenAI key, too long, LLM unavailable (no fabricated reply), LLM malformed (fallback line, no correction)', async () => {
  const t = await server(envOai());
  try {
    svc.state.sttStatus = 500; let r = await turn(t); assert.equal(ev(r, 'error')[0].stage, 'transcribing'); assert.equal(ev(r, 'coach_text').length, 0); assert.equal(ev(r, 'transcript').length, 0); svc.state.sttStatus = 200;
    r = await turn(t, { stt: '好'.repeat(401) }); assert.equal(ev(r, 'error')[0].code, 'talk_turn_too_long');
    svc.state.chatStatus = 500; r = await turn(t); assert.equal(ev(r, 'transcript').length, 1); assert.equal(ev(r, 'error')[0].code, 'talk_llm_unavailable'); assert.equal(ev(r, 'coach_text').length, 0); assert.equal(ev(r, 'done').length, 0); assert.equal(ev(r, 'error')[0].retryable, true);
    svc.state.chatStatus = 200;
    r = await turn(t, { script: llm({ reply: 'not json at all', find: 'oops' }) });
    assert.deepEqual(roles(r), ['reply']); assert.equal(lines(r)[0], TALK_FALLBACK_ZH); assert.equal(done(r).degraded, 'reply_malformed'); assert.equal(done(r).correction, null); assert.equal(done(r).questionZh, null);
    r = await turn(t, { script: llm({ reply: REPLY({ replyZh: 5, questionZh: null }), find: FIND() }) }); assert.equal(done(r).degraded, 'reply_malformed');
    r = await turn(t, { script: llm({ reply: { replyZh: '', questionZh: '' } }) }); assert.equal(lines(r)[0], TALK_FALLBACK_ZH);
    r = await turn(t, { script: llm({ reply: REPLY({ replyZh: '', questionZh: '' }) }) }); assert.equal(done(r).degraded, 'reply_malformed');
    r = await turn(t, { script: llm({ find: 'malformed' }) }); assert.deepEqual(roles(r), ['reply', 'question']); assert.equal(done(r).correction, null); assert.match(done(r).correctionStatus, /^unavailable:malformed_output/);
    r = await turn(t, { script: llm({ reply: REPLY({ questionZh: '' }) }) }); assert.equal(lines(r).at(-1), TALK_THEN_ZH);
  } finally { await t.close(); }
  const t2 = await server({ ...envOai(), OPENAI_API_KEY: '' });
  try { svc.state.requests.length = 0; const r = await postTurn(t2); assert.equal(ev(r, 'error')[0].code, 'llm_not_configured'); assert.equal(chatCalls(), 0); } finally { await t2.close(); }
});
test('TURN slow finder (> TALK_FIND_WAIT_MS): the question is spoken first, the late correction follows (never blocks the conversation)', async () => {
  const t = await server(envOai());
  try {
    svc.state.chatDelayFn = (j) => (marker(j) === 'FIND' ? 3700 : 0);
    const r = await turn(t, { script: llm({ find: FIND({ correction: GOOD_FIX }) }) });
    assert.deepEqual(roles(r), ['reply', 'question', 'correction', 'correction_model']); assert.equal(done(r).correctionLate, true); assert.equal(done(r).correction.betterZh, '很多苹果');
    assert.ok(done(r).timings.firstAudioMs < 1500, 'the first audio does not wait for the finder');
  } finally { svc.state.chatDelayFn = null; await t.close(); }
});
test('TURN tone:true: TonePerfect runs on the transcript (low confidence, policy applied); a confirmed tone error is the single correction when the text has none; text correction wins; default skips', async () => {
  const said = '我喜欢学中文。';
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    let r = await turn(t, { stt: said, ctx: ctxOf({ tone: true }) });
    const a = ev(r, 'assessment')[0]; assert.ok(a); assert.equal(a.lowConfidence, true); assert.equal(a.basis, 'transcript'); assert.equal(a.referenceText, '我喜欢学中文'); assert.ok(a.facts.confirmedToneErrors.length >= 1);
    assert.ok(names(r).indexOf('assessment') < names(r).indexOf('done')); assert.equal(done(r).correction.kind, 'tone'); assert.equal(done(r).correction.source, 'server_fact'); assert.equal(done(r).summary.tone, 'ok');
    assert.ok(roles(r).includes('correction_model')); assert.equal(done(r).suggestedWords.length, 0);
    r = await turn(t, { stt: said, ctx: ctxOf({ tone: true }), script: llm({ find: FIND({ correction: { kind: 'word_choice', quote: '喜欢学', betterZh: '爱学', explainZh: '可以说“爱学”。', confidence: 'high' } }) }) });
    assert.equal(done(r).correction.kind, 'word_choice'); assert.equal(roles(r).filter((x) => x === 'correction').length, 1); assert.equal(ev(r, 'assessment').length, 1);
    r = await turn(t, { stt: said }); assert.equal(ev(r, 'assessment').length, 0); assert.equal(done(r).correction, null); assert.equal(done(r).summary.toneReason, 'not_requested');
  } finally { await t.close(); }
  const t2 = await server(envOai());   // tone cannot run: skipped silently (no error), conversation unaffected
  try {
    for (let i = 0; i < 4; i++) tp.script({ status: 503, json: { error: { code: 'engine_unavailable', message: 'x' } } });   // the engine retries once
    let r = await turn(t2, { stt: said, ctx: ctxOf({ tone: true }) }); assert.equal(names(r).at(-1), 'done'); assert.equal(ev(r, 'assessment').length, 0); assert.equal(done(r).summary.tone, 'skipped'); assert.ok(done(r).summary.toneReason);
    const n0 = tp.requests.length;
    r = await turn(t2, { stt: '我吃了 3 个苹果。', ctx: ctxOf({ tone: true }) }); assert.equal(done(r).summary.toneReason, 'transcript_has_digits_or_latin'); assert.equal(tp.requests.length, n0, 'digits/latin: TonePerfect not called');
  } finally { await t2.close(); }
});
test('TURN validation: auth required, missing audio, bad/missing context, bad attemptId, TTS source, oversize audio / context', async () => {
  const t = await server(envOai()); const anon = await startTestServer(envOai());
  try {
    assert.equal((await postTurn(anon)).status, 401);
    const cases = [[{ noAudio: true }, 'missing_audio'], [{ rawContext: '' }, 'invalid_context'], [{ rawContext: 'nope' }, 'invalid_context'], [{ ctx: { turns: [{ role: 'x', text: 'y' }] } }, 'invalid_context'],
      [{ ctx: ctxOf({ level: 'hard' }) }, 'invalid_level'], [{ fields: { attemptId: 'short' } }, 'invalid_attempt_id'], [{ fields: { attemptId: undefined } }, 'invalid_attempt_id'], [{ fields: { source: 'tts' } }, 'tts_audio_rejected'],
      [{ headers: { 'X-Audio-Source': 'tts' } }, 'tts_audio_rejected']];
    for (const [o, code] of cases) { const r = await postTurn(t, o); assert.equal(r.status, 400, code); assert.equal(r.json.error.code, code); }
    const big = await postTurn(t, { audio: Buffer.alloc(10 * 1024 * 1024 + 10) }); assert.equal(big.status, 413); assert.equal(big.json.error.code, 'upload_too_large');
    const bigCtx = await postTurn(t, { rawContext: JSON.stringify({ topic: 'x', filler: 'x'.repeat(40 * 1024) }) }); assert.equal(bigCtx.status, 413); assert.equal(bigCtx.json.error.code, 'context_too_large');
    const manyVocab = await postTurn(t, { ctx: ctxOf({ scriptVocab: Array.from({ length: 300 }, (_, i) => ({ text: '词' + i })) }) }); assert.equal(manyVocab.status, 413);
    assert.equal(chatCalls(), 0); assert.equal(tp.requests.length, 0);
  } finally { await t.close(); await anon.close(); }
});

// ------------------------------------------------------------------------------------------------ /api/talk/opening
test('OPENING: topic -> {textZh, pinyin}; ?audio=1 adds textAudio; validation; LLM malformed / unavailable / no key => clear errors; auth required; nothing stored', async () => {
  const t = await server(envOai()); const snap = () => JSON.stringify(t.db.raw.prepare('select * from sqlite_master').all());
  try {
    svc.state.chatScript = llm(); const s0 = snap();
    let r = await t.api('POST', '/api/talk/opening', { topic: TOPIC, scriptVocab: [{ text: '苹果' }], level: 'easy' });
    assert.equal(r.status, 200); assert.equal(r.json.textZh, '这个周末你想做什么？'); assert.equal(r.json.pinyin, 'zhè ge zhōu mò nǐ xiǎng zuò shén me？'); assert.equal(typeof r.json.timings.totalMs, 'number'); assert.equal(r.json.textAudio, undefined);
    assert.match(svc.state.requests.at(-1).json.messages[0].content, /EASY/); assert.equal(snap(), s0);
    r = await t.api('POST', '/api/talk/opening?audio=1', { topic: TOPIC }); assert.match(r.json.textAudio.url, /^\/api\/audio\/[\w-]+\.mp3$/);
    assert.equal((await fetch(t.base + r.json.textAudio.url, { headers: { Cookie: t.cookie() } })).status, 200);
    for (const b of [{}, { topic: '' }, { topic: 5 }, { topic: 'x'.repeat(200) }, { topic: 'a', level: 'hard' }, { topic: 'a', scriptVocab: 'x' }]) assert.equal((await t.api('POST', '/api/talk/opening', b)).status, 400, JSON.stringify(b));
    svc.state.chatScript = llm({ open: 'garbage' }); r = await t.api('POST', '/api/talk/opening', { topic: TOPIC }); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'opening_generation_failed');
    svc.state.chatScript = llm({ open: { textZh: '你的声调很好吗？' } }); assert.equal((await t.api('POST', '/api/talk/opening', { topic: TOPIC })).status, 502);
    svc.state.chatStatus = 500; assert.equal((await t.api('POST', '/api/talk/opening', { topic: TOPIC })).status, 502); svc.state.chatStatus = 200;
    assert.equal((await t.api('POST', '/api/talk/opening', { topic: TOPIC }, { auth: false })).status, 401);
  } finally { await t.close(); }
  const t2 = await server({ ...envOai(), OPENAI_API_KEY: '' });
  try { const r = await t2.api('POST', '/api/talk/opening', { topic: TOPIC }); assert.equal(r.status, 503); assert.equal(r.json.error.code, 'llm_not_configured'); } finally { await t2.close(); }
});

// ------------------------------------------------------------------------------------------------ /api/talk/summary
const SESSION = [{ role: 'coach', text: '这个周末你想做什么？' }, { role: 'user', text: SAID }, { role: 'coach', text: '你最喜欢吃什么水果？' }, { role: 'user', text: '我喜欢吃 banana。' }];
test('SUMMARY: strict JSON -> takeaways / newWords / phrasesToTry / strengths + stats by CODE; malformed, missing fields, no learner turns, size caps, auth, nothing stored', async () => {
  const t = await server(envOai()); const snap = () => JSON.stringify(t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => [x.name, t.db.raw.prepare(`select * from ${x.name}`).all()]));
  try {
    svc.state.chatScript = llm(); const s0 = snap();
    let r = await t.api('POST', '/api/talk/summary', { topic: TOPIC, turns: SESSION, scriptVocab: [{ text: '水果' }], level: 'normal' });
    assert.equal(r.status, 200, r.text); const j = r.json;
    assert.deepEqual(j.statsDerived, { turns: 4, userTurns: 2, approxCharsSpoken: 23 }); assert.equal(j.takeaways.length, 3); assert.deepEqual(Object.keys(j.takeaways[0]).sort(), ['pinyin', 'textEn', 'textZh']);
    assert.deepEqual(j.newWords[0], { text: '水果', pinyin: 'shuǐ guǒ', meaning: 'fruit', exampleZh: '我喜欢吃水果。' }); assert.equal(j.phrasesToTry[0].pinyin, 'wǒ mǎi le hěn duō píng guǒ。'); assert.equal(j.strengths.length, 1);
    assert.equal(typeof j.timings.totalMs, 'number'); assert.equal(snap(), s0); assert.deepEqual(t.db.listMissed(), []);
    assert.ok(!NO_TONE_WORDS.test(JSON.stringify(j)));
    svc.state.chatScript = llm({ summary: SUMMARY({ strengths: ['Your tones were great.'], phrasesToTry: [{ zh: '你的声调很好。', en: 'x', whyEn: 'y' }, ...SUMMARY().phrasesToTry] }) });
    r = await t.api('POST', '/api/talk/summary', { turns: SESSION }); assert.equal(r.status, 502, 'only a tone claim as strength => nothing usable => error, not a fabricated strength');
    svc.state.chatScript = llm({ summary: SUMMARY({ strengths: ['Great flow.', 'Your pronunciation is clear.'], phrasesToTry: [{ zh: '你的声调很好。', en: 'x', whyEn: 'y' }, ...SUMMARY().phrasesToTry] }) });
    r = await t.api('POST', '/api/talk/summary', { turns: SESSION }); assert.equal(r.status, 200); assert.deepEqual(r.json.strengths, ['Great flow.']); assert.equal(r.json.phrasesToTry.length, 1);
    for (const bad of ['garbage', { takeaways: [] }, '{"takeaways":"x"}']) { svc.state.chatScript = llm({ summary: bad }); r = await t.api('POST', '/api/talk/summary', { turns: SESSION }); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'summary_generation_failed'); }
    svc.state.chatScript = llm();
    const bads = [[{}, 'invalid_turns'], [{ turns: [] }, 'invalid_turns'], [{ turns: 'x' }, 'invalid_turns'], [{ turns: [{ role: 'bot', text: 'x' }] }, 'invalid_turns'], [{ turns: [{ role: 'coach', text: '你好' }] }, 'no_user_turns'],
      [{ turns: SESSION, level: 'hard' }, 'invalid_level'], [{ turns: SESSION, topic: 5 }, 'invalid_request'], [{ turns: SESSION, scriptVocab: 'x' }, 'invalid_context']];
    for (const [b, code] of bads) { r = await t.api('POST', '/api/talk/summary', b); assert.equal(r.status, 400, code); assert.equal(r.json.error.code, code, JSON.stringify(b)); }
    r = await t.api('POST', '/api/talk/summary', { turns: Array.from({ length: 300 }, () => ({ role: 'user', text: '你好' })) }); assert.equal(r.status, 413); assert.equal(r.json.error.code, 'session_too_long');
    r = await t.api('POST', '/api/talk/summary', { turns: [{ role: 'user', text: '好'.repeat(1900) }, ...Array.from({ length: 12 }, () => ({ role: 'user', text: '好'.repeat(1900) }))] }); assert.equal(r.status, 413);
    const calls = chatCalls(); assert.equal((await t.api('POST', '/api/talk/summary', { turns: SESSION }, { auth: false })).status, 401); assert.equal(chatCalls(), calls);
    // the prompt only carries the last turns (bounded)
    svc.state.requests.length = 0; await t.api('POST', '/api/talk/summary', { turns: Array.from({ length: 150 }, (_, i) => ({ role: i % 2 ? 'user' : 'coach', text: `第${i}句` })) });
    const sent = JSON.parse(svc.state.requests.find((x) => x.json?.messages?.[0]?.content?.includes('TALK_SUMMARY')).json.messages[1].content); assert.ok(sent.conversation.length <= 40);
  } finally { await t.close(); }
  const t2 = await server({ ...envOai(), OPENAI_API_KEY: '' });
  try { const r = await t2.api('POST', '/api/talk/summary', { turns: SESSION }); assert.equal(r.status, 503); assert.equal(r.json.error.code, 'llm_not_configured'); } finally { await t2.close(); }
});
test('PREFS: practiceMode "free_talk" is accepted (own endpoints /api/talk/*); /api/attempt still has no such mode', async () => {
  const t = await server(envOai());
  try { assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'free_talk' })).status, 200); assert.equal((await t.api('GET', '/api/prefs')).json.practiceMode, 'free_talk'); } finally { await t.close(); }
});
