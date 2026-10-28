// Q&A practice mode: /api/qa/next (LLM question + code-resolved key points + HMAC), /api/qa/attempt (STT -> LLM check -> code-verified -> code-built coaching),
// /api/qa/hint, /api/qa/answer.  Fakes only (fake OpenAI incl. STT/LLM/TTS, fake TonePerfect); no network, no keys.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { startTestServer, fixtureEngine } from './helpers.js';
import { startFakeToneperfect } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';
import { parseNext, validateNext, parseCheck, validateCheck, QA_GATE_ZH, QA_ALL_ZH, QA_ALL_TONE_ZH, QA_SOFT_ZH, QA_WRONG_ZH, QA_UNAVAILABLE_ZH, QA_DONTKNOW_ZH, QA_OFFTOPIC_ZH, QA_NEXT_RETRY_ZH, QA_NEXT_OK_ZH, QA_NEXT_HINT_ZH, qaMissingOpener } from '../services/qa.js';
import { signQuestion, verifyQuestion } from '../lib/qa-sign.js';

const TP_KEY = 'tp_test_FAKEKEYFORTESTS0123456789'; const OAI_KEY = 'sk-fakeopenaikey0123456789';
let tp; let svc;
before(async () => { tp = await startFakeToneperfect(); svc = await startFakeServices(); });
after(async () => { await tp.close(); await svc.close(); });
beforeEach(() => { tp.reset(); svc.reset(); svc.state.chatScript = null; });

const envOai = (x = {}) => ({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect', OPENAI_API_KEY: OAI_KEY, OPENAI_BASE_URL: svc.openaiBase, ...x });
async function server(env, opts) { const t = await startTestServer(env, opts); await t.login(); return t; }
const ev = (r, n) => r.events.filter((e) => e.event === n).map((e) => e.data);
const lines = (r) => ev(r, 'coach_text').map((x) => x.delta);
const roles = (r) => ev(r, 'coach_text').map((x) => x.role);
const chatCalls = () => svc.state.requests.filter((r) => r.url === '/v1/chat/completions').length;
const PRAISE = /很好|不错|太棒|很棒|完美|完整|全对|都对|正确|没问题/;
const noPraise = (r) => lines(r).every((l) => !PRAISE.test(l.replace(/(漏掉了这个要点|可以这样说|应该这样说|这个要点只讲了一部分|好像没讲到这个要点)[：:].*$/, '')));

// 小明早上起床，骑自行车去学校，在学校学习数学。   offsets: 早上起床 2-6, 骑自行车去学校 7-14, 在学校学习数学 15-22
const CHUNK = '小明早上起床，骑自行车去学校，在学校学习数学。';
const CHUNK2 = '他的妈妈是医生，每天在医院工作。';
const NEXT = (over = {}) => ({ type: 'what', questionZh: '小明每天都做些什么？', keyPoints: [{ refQuote: '早上起床' }, { refQuote: '骑自行车去学校' }, { refQuote: '在学校学习数学' }],
  modelAnswerZh: '小明早上起床，骑自行车去学校，在学校学习数学。', hintZh: '想一想他从早到晚的三件事。', ...over });
const ONE = (over = {}) => NEXT({ type: 'how', questionZh: '小明怎么去学校？', keyPoints: [{ refQuote: '骑自行车去学校' }], modelAnswerZh: '他骑自行车去学校。', hintZh: '想一想他用什么交通工具。', ...over });
const CHECK = (kps = {}, over = {}) => ({ answeredQuestion: true, keyPoints: [
  { id: 'k1', covered: true, evidence: '早上起来', confidence: 'high', ...(kps.k1 || {}) },
  { id: 'k2', covered: true, evidence: '骑车去学校', confidence: 'high', ...(kps.k2 || {}) },
  { id: 'k3', covered: true, evidence: '上课学数学', confidence: 'high', ...(kps.k3 || {}) }], wrongFacts: [], ...over });
const FULL_ANSWER = '小明早上起来，骑车去学校，上课学数学。';
const isNext = (j) => j.messages[0].content.includes('ONE spoken');
/** LLM fake: question generation vs answer check, selected by system prompt. */
const llm = ({ next = NEXT(), check = CHECK() } = {}) => (j) => JSON.stringify(isNext(j) ? (typeof next === 'function' ? next(j) : next) : check);

async function next(t, body = { chunks: [CHUNK] }, qs = '') { return t.api('POST', '/api/qa/next' + qs, body); }
async function getQuestion(t, over = {}) { svc.state.chatScript = llm(over); const r = await next(t); assert.equal(r.status, 200, r.text); return r.json; }
async function postQa(t, { question, audio = Buffer.alloc(2000, 7), fields = {}, noAudio = false, rawQuestion } = {}) {
  const form = new FormData();
  if (!noAudio) form.append('audio', new Blob([audio], { type: 'audio/mp4' }), 'rec.m4a');
  const f = { question: rawQuestion ?? JSON.stringify(question), attemptId: 'qa-' + Math.random().toString(36).slice(2, 12), ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) form.append(k, v);
  const res = await fetch(t.base + '/api/qa/attempt', { method: 'POST', body: form, headers: { Cookie: t.cookie() } });
  const text = await res.text(); const events = [];
  for (const block of text.split('\n\n')) { const m = /^event: (\w+)\ndata: (.*)$/ms.exec(block.trim()); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); }
  let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, events, text, headers: res.headers, json, attemptId: f.attemptId };
}
const answer = async (t, q, sttText, check) => { svc.state.sttText = sttText; svc.state.chatScript = llm({ check }); return postQa(t, { question: q }); };

// ------------------------------------------------------------------------------------------------ pure helpers
test('parseNext / validateNext: strict schema; CODE resolves quotes to code-point offsets; invented spans dropped', () => {
  assert.throws(() => parseNext(null)); assert.throws(() => parseNext({ questionZh: 'x' })); assert.throws(() => parseNext({ questionZh: '好吗', modelAnswerZh: 'a', keyPoints: [] }));
  assert.throws(() => parseNext({ questionZh: '好吗', modelAnswerZh: 'a', keyPoints: [{ nope: 1 }] }));
  const q = validateNext(parseNext(NEXT({ keyPoints: [{ refQuote: '骑自行车去学校' }, { refQuote: '他每天吃早饭' }, { refQuote: '早上起床' }] })), { chunk: CHUNK, chunkIndex: 3, preferredType: 'what' });
  assert.deepEqual(q.keyPoints.map((k) => [k.id, k.textZh, k.refStart, k.refEnd, k.chunkIndex]), [['k1', '早上起床', 2, 6, 3], ['k2', '骑自行车去学校', 7, 14, 3]]); // position order, invented one dropped
  assert.deepEqual(q.dropped, ['span_not_in_reference']); assert.equal(q.sourceChunkIndex, 3);
  assert.throws(() => validateNext(parseNext(NEXT({ keyPoints: [{ refQuote: '完全不存在的内容' }] })), { chunk: CHUNK, chunkIndex: 0, preferredType: 'what' }), /no key point/);
  const e = validateNext(parseNext({ questionZh: '😀小明怎么去学校？', modelAnswerZh: '他骑自行车去学校。', hintZh: '', keyPoints: ['骑自行车去学校'] }), { chunk: '😀' + CHUNK, chunkIndex: 0, preferredType: 'how' });
  assert.deepEqual([e.keyPoints[0].refStart, e.keyPoints[0].refEnd], [8, 15]); // code POINTS (the emoji counts as one)
});
test('parseCheck / validateCheck: strict schema; every signed key point must be present; evidence and quotes verified in the transcript', () => {
  assert.throws(() => parseCheck({ keyPoints: [] })); assert.throws(() => parseCheck({ answeredQuestion: 'yes', keyPoints: [{ id: 'k1', covered: true }] }));
  assert.throws(() => parseCheck({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: 'maybe' }] }));
  const q = { keyPoints: [{ id: 'k1', textZh: '早上起床', refStart: 2, refEnd: 6, chunkIndex: 0 }, { id: 'k2', textZh: '骑自行车去学校', refStart: 7, refEnd: 14, chunkIndex: 0 }] };
  assert.throws(() => validateCheck(parseCheck({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: false }] }), { question: q, transcript: '他睡觉。' }), /k2/);
  const v = validateCheck(parseCheck({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: true, evidence: '早上起来', confidence: 'high' }, { id: 'k2', covered: true, evidence: '开着汽车', confidence: 'high' }] }), { question: q, transcript: '他早上起来了。' });
  assert.deepEqual(v.keyPoints.map((k) => [k.covered, k.evidence, k.confidence]), [[true, '早上起来', 'high'], ['partial', null, 'low']]); // unverifiable evidence => not "covered"
});

// ------------------------------------------------------------------------------------------------ POST /api/qa/next
test('NEXT returns a signed question with key points grounded at code-resolved offsets (+ pinyin, id, timings); nothing else', async () => {
  const t = await server(envOai());
  try {
    svc.state.chatScript = llm(); const r = await next(t, { chunks: ['你好吗，今天好。', CHUNK], chunkIndex: 1 });
    assert.equal(r.status, 200, r.text); const q = r.json;
    assert.deepEqual([q.ok, q.type, q.level, q.questionZh, q.sourceChunkIndex], [true, 'what', 1, '小明每天都做些什么？', 1]);
    assert.match(q.questionId, /^q[0-9a-f]{12}$/); assert.match(q.questionPinyin, /xiǎo míng/);
    assert.deepEqual(q.keyPoints, [{ id: 'k1', textZh: '早上起床', refStart: 2, refEnd: 6, chunkIndex: 1 }, { id: 'k2', textZh: '骑自行车去学校', refStart: 7, refEnd: 14, chunkIndex: 1 }, { id: 'k3', textZh: '在学校学习数学', refStart: 15, refEnd: 22, chunkIndex: 1 }]);
    for (const k of q.keyPoints) assert.equal(Array.from(CHUNK).slice(k.refStart, k.refEnd).join(''), k.textZh);
    assert.equal(q.modelAnswerZh, '小明早上起床，骑自行车去学校，在学校学习数学。'); assert.equal(q.hintZh, '想一想他从早到晚的三件事。');
    assert.ok(q.signature.length >= 40); assert.equal(q.signature, signQuestion(t.cfg, q)); assert.equal(q.questionAudio, undefined);
    assert.ok(q.timings.totalMs >= 0 && q.timings.llmAttempts === 1); assert.equal(svc.state.requests.filter((x) => x.url === '/v1/chat/completions').length, 1);
    const prompt = svc.state.requests.at(-1).json.messages; assert.ok(prompt[1].content.includes('骑自行车去学校')); assert.ok(!prompt[1].content.includes('你好吗')); // only the chosen chunk is sent
    assert.ok(svc.state.requests.at(-1).json.model); assert.ok(svc.state.requests.at(-1).json.temperature > 0);
  } finally { await t.close(); }
});
test('NEXT drops hallucinated key points; none valid => ONE retry then 502 (never an ungrounded question)', async () => {
  const t = await server(envOai());
  try {
    let r = (svc.state.chatScript = llm({ next: NEXT({ keyPoints: [{ refQuote: '骑摩托车去北京' }, { refQuote: '在学校学习数学' }] }) }), await next(t));
    assert.equal(r.status, 200); assert.deepEqual(r.json.keyPoints.map((k) => [k.id, k.textZh]), [['k1', '在学校学习数学']]);
    svc.reset(); svc.state.chatScript = llm({ next: NEXT({ keyPoints: [{ refQuote: '骑摩托车去北京' }, { refQuote: '他每天吃很多米饭' }] }) });
    r = await next(t); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'question_generation_failed'); assert.match(r.json.error.message, /no_grounded_key_point/); assert.equal(chatCalls(), 2);
    svc.reset(); let n = 0; svc.state.chatScript = (j) => (++n === 1 ? 'not json {' : JSON.stringify(NEXT()));
    r = await next(t); assert.equal(r.status, 200); assert.equal(r.json.timings.llmAttempts, 2);
    svc.reset(); svc.state.chatScript = 'garbage'; r = await next(t); assert.equal(r.status, 502); assert.match(r.json.error.message, /malformed_output/); assert.equal(chatCalls(), 2);
    svc.reset(); svc.state.chatStatus = 500; r = await next(t); assert.equal(r.status, 502);
  } finally { await t.close(); }
});
test('NEXT code fixes weak LLM text: answer inside the question dropped, ungrounded model answer replaced by the key-point text, hint that gives the answer replaced', async () => {
  const t = await server(envOai());
  try {
    svc.state.chatScript = llm({ next: NEXT({ questionZh: '小明为什么骑自行车去学校？', modelAnswerZh: '因为他喜欢骑摩托车去北京。', hintZh: '他骑自行车去学校。' }) });
    const q = (await next(t)).json;
    assert.deepEqual(q.keyPoints.map((k) => k.textZh), ['早上起床', '在学校学习数学']); // 骑自行车去学校 is in the question itself
    assert.equal(q.modelAnswerZh, '早上起床，在学校学习数学'); assert.equal(q.hintZh, '想一想原文里是怎么说的。');
    svc.state.chatScript = llm({ next: NEXT({ questionZh: '小明怎么去学校？ 请用中文，tone 3', modelAnswerZh: '好的' }) }); assert.equal((await next(t)).status, 502); // latin in the question is unusable
  } finally { await t.close(); }
});
test('NEXT request validation: clear 400/413 errors (chunks, stage directions, size, short chunks, type, level, avoid, chunkIndex)', async () => {
  const t = await server(envOai()); svc.state.chatScript = llm();
  try {
    const code = async (body) => { const r = await next(t, body); return [r.status, r.json.error.code]; };
    assert.deepEqual(await code({}), [400, 'invalid_chunks']); assert.deepEqual(await code({ chunks: [] }), [400, 'invalid_chunks']); assert.deepEqual(await code({ chunks: [5] }), [400, 'invalid_chunks']);
    assert.deepEqual(await code({ chunks: [CHUNK, '[停顿] 你好'] }), [400, 'stage_directions_in_chunk']);
    assert.deepEqual(await code({ chunks: ['你'.repeat(2001)] }), [413, 'script_too_long']); assert.deepEqual(await code({ chunks: Array(81).fill('好') }), [400, 'invalid_chunks']);
    assert.deepEqual(await code({ chunks: ['你好。', '谢谢'] }), [400, 'chunks_too_short']);
    assert.deepEqual(await code({ chunks: [CHUNK], type: 'when' }), [400, 'invalid_type']); assert.deepEqual(await code({ chunks: [CHUNK], level: 3 }), [400, 'invalid_level']);
    assert.deepEqual(await code({ chunks: [CHUNK], avoid: 'x' }), [400, 'invalid_avoid']); assert.deepEqual(await code({ chunks: [CHUNK], avoid: ['a'.repeat(121)] }), [400, 'invalid_avoid']);
    assert.deepEqual(await code({ chunks: [CHUNK, '你好。'], chunkIndex: 1 }), [400, 'invalid_chunk_index']);
    assert.equal((await next(t, { chunks: [CHUNK + '好'.repeat(1980)] })).status, 200); assert.equal(chatCalls(), 1); // 2000 hanzi is allowed; the earlier requests never reached the LLM
  } finally { await t.close(); }
  const t2 = await server({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect' });
  try { const r = await next(t2); assert.equal(r.status, 503); assert.equal(r.json.error.code, 'llm_not_configured'); } finally { await t2.close(); }
});
test('NEXT type param is honoured in the prompt; "any" rotates what/why/how/who by the number already asked; avoid list reaches the LLM; repeats are retried', async () => {
  const t = await server(envOai());
  try {
    svc.state.chatScript = llm();
    for (const ty of ['what', 'why', 'how', 'who']) { await next(t, { chunks: [CHUNK], type: ty }); assert.match(svc.state.requests.at(-1).json.messages[0].content, new RegExp(`Ask a "${ty}" question`)); }
    for (const [n, ty] of [[1, 'why'], [2, 'how'], [3, 'who'], [4, 'what']]) { await next(t, { chunks: [CHUNK], avoid: Array(n).fill('旧问题一二三四五') }); assert.match(svc.state.requests.at(-1).json.messages[0].content, new RegExp(`Ask a "${ty}" question`)); }
    await next(t, { chunks: [CHUNK], level: 2 }); assert.match(svc.state.requests.at(-1).json.messages[0].content, /level 2/);
    // the avoid texts (not ids) are part of the user prompt; ids are not leaked to the model
    await next(t, { chunks: [CHUNK], avoid: ['小明几点起床？', 'q0123456789ab'] });
    const user = JSON.parse(svc.state.requests.at(-1).json.messages[1].content); assert.deepEqual(user.avoid, ['小明几点起床？']);
    // a question equal to one in avoid (by id or by text) is retried once; if still repeated it is returned flagged, never silently
    const first = (await next(t)).json; svc.reset(); let n = 0;
    svc.state.chatScript = (j) => JSON.stringify(++n === 1 ? NEXT() : ONE());
    const r = await next(t, { chunks: [CHUNK], avoid: [first.questionId] }); assert.equal(r.json.questionZh, '小明怎么去学校？'); assert.equal(r.json.repeated, undefined); assert.equal(chatCalls(), 2);
    svc.reset(); svc.state.chatScript = llm(); const rep = await next(t, { chunks: [CHUNK], avoid: ['小明每天都做些什么'] }); assert.equal(rep.json.repeated, true); assert.equal(chatCalls(), 2);
    // the returned type is the type actually asked (the model may switch when the script cannot support the requested one)
    svc.reset(); svc.state.chatScript = llm({ next: NEXT({ type: 'why' }) }); assert.equal((await next(t, { chunks: [CHUNK], type: 'who' })).json.type, 'why');
  } finally { await t.close(); }
});
test('NEXT ?audio=1 returns questionAudio.url via the TTS cache (optional; failure just omits it)', async () => {
  const t = await server(envOai());
  try {
    svc.state.chatScript = llm(); let r = await next(t, { chunks: [CHUNK] }, '?audio=1'); assert.match(r.json.questionAudio.url, /^\/api\/audio\/.+\.mp3$/);
    const au = await fetch(t.base + r.json.questionAudio.url, { headers: { Cookie: t.cookie() } }); assert.equal(au.status, 200);
    svc.state.ttsStatus = 500; svc.state.chatScript = llm({ next: NEXT({ questionZh: '小明每天做什么事情？' }) }); r = await next(t, { chunks: [CHUNK] }, '?audio=1'); assert.equal(r.status, 200); assert.equal(r.json.questionAudio, undefined);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ signature
test('SIGNATURE: any tampered field (key point text/offsets/id, model answer, hint, question, extra key point) or a foreign key is rejected by hint, answer and attempt', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    const mut = (f) => { const c = structuredClone(q); f(c); return c; };
    const bads = [mut((c) => { c.modelAnswerZh = '小明骑摩托车去北京。'; }), mut((c) => { c.hintZh = '答案是自行车。'; }), mut((c) => { c.questionZh = '小明几岁？'; }), mut((c) => { c.keyPoints[0].textZh = '睡觉'; }),
      mut((c) => { c.keyPoints[1].refStart = 8; }), mut((c) => { c.keyPoints[2].chunkIndex = 5; }), mut((c) => { c.keyPoints.pop(); }), mut((c) => { c.keyPoints.push({ id: 'k4', textZh: '吃饭了', refStart: 0, refEnd: 3, chunkIndex: 0 }); }),
      mut((c) => { c.type = 'why'; }), mut((c) => { c.signature = c.signature.slice(0, -2) + 'AA'; }), mut((c) => { c.signature = ''; })];
    svc.state.sttText = FULL_ANSWER;
    for (const b of bads) {
      const h = await t.api('POST', '/api/qa/hint', b); const a = await t.api('POST', '/api/qa/answer', b); const p = await postQa(t, { question: b });
      assert.ok([h, a, p].every((x) => x.status === 400), JSON.stringify(b)); assert.ok([h, a, p].every((x) => ['invalid_question_signature', 'invalid_question'].includes(x.json.error.code)));
    }
    assert.equal((await t.api('POST', '/api/qa/hint', mut((c) => { c.keyPoints[0].textZh = '睡觉'; }))).json.error.code, 'invalid_question_signature');
    assert.equal((await t.api('POST', '/api/qa/hint', {})).json.error.code, 'invalid_question');
    assert.equal((await postQa(t, { rawQuestion: 'not json' })).json.error.code, 'invalid_question');
    // unsigned extras are ignored (pinyin/audio/timings/ok); a key from another server secret is rejected
    assert.equal((await t.api('POST', '/api/qa/hint', { ...q, questionAudio: { url: '/x' }, extra: 1 })).status, 200);
    assert.equal(verifyQuestion({ passcode: 'other-pass' }, q).code, 'invalid_question_signature'); assert.equal(verifyQuestion(t.cfg, q).ok, true);
    assert.equal(chatCalls(), 1); // none of this called the LLM again
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ hint / answer
test('HINT and ANSWER: no LLM; level 1 = signed hint, level 2 = first key point partially revealed; answer returns offsets for highlighting', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const calls = chatCalls();
    let h = await t.api('POST', '/api/qa/hint', q); assert.deepEqual(h.json, { ok: true, questionId: q.questionId, hintZh: q.hintZh, level: 1, hasMore: true });
    h = await t.api('POST', '/api/qa/hint', { ...q, hintLevel: 2 }); assert.deepEqual(h.json, { ok: true, questionId: q.questionId, hintZh: '答案是这样开头的：早上……', level: 2, hasMore: false });
    assert.equal((await t.api('POST', '/api/qa/hint', { ...q, hintLevel: 3 })).json.error.code, 'invalid_hint_level');
    const a = await t.api('POST', '/api/qa/answer', q); assert.equal(a.status, 200);
    assert.deepEqual([a.json.questionId, a.json.modelAnswerZh, a.json.sourceChunkIndex, a.json.keyPoints], [q.questionId, q.modelAnswerZh, 0, q.keyPoints.map(({ id, textZh, refStart, refEnd, chunkIndex }) => ({ id, textZh, refStart, refEnd, chunkIndex }))]);
    assert.ok(a.json.suggestedWords.some((w) => w.text === '自行车') && a.json.suggestedWords.every((w) => w.keyPointId)); // vocabulary of the key points; never auto-saved
    assert.equal(chatCalls(), calls); assert.equal(t.db.raw.prepare('select count(*) c from missed_words').get().c, 0);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ POST /api/qa/attempt
test('ATTEMPT full answer in different wording => canPraise, praise + next, no corrections; qa block shape; TonePerfect scored on the TRANSCRIPT; wordStatus not computed', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const r = await answer(t, q, FULL_ANSWER, CHECK());
    assert.equal(r.status, 200); const [a] = ev(r, 'assessment'); const Q = a.qa;
    assert.deepEqual([a.basis, a.lowConfidence, a.transcriptDerived, a.transcript, a.referenceText], ['transcript', true, true, FULL_ANSWER, '小明早上起来骑车去学校上课学数学']);
    assert.equal(tp.requests.at(-1).fields.text, a.referenceText); assert.deepEqual([a.wordStatus, a.savedMissed], [[], []]);
    assert.deepEqual([Q.questionId, Q.sttStatus, Q.comparisonStatus, Q.coveredCount, Q.totalCount, Q.canPraise, Q.praiseLevel, Q.answeredQuestion, Q.answerKind, Q.missingKeyPointIds, Q.wrongFacts, Q.tone, Q.modelAnswerZh],
      [q.questionId, 'ok', 'ok', 3, 3, true, 'full', true, 'answered', [], [], { status: 'ok' }, q.modelAnswerZh]);
    assert.deepEqual(Q.keyPoints.map((k) => [k.id, k.textZh, k.refStart, k.refEnd, k.chunkIndex, k.covered, k.evidence, k.confidence]),
      [['k1', '早上起床', 2, 6, 0, true, '早上起来', 'high'], ['k2', '骑自行车去学校', 7, 14, 0, true, '骑车去学校', 'high'], ['k3', '在学校学习数学', 15, 22, 0, true, '上课学数学', 'high']]);
    assert.equal(a.facts.canPraise, true); assert.deepEqual(roles(r), ['praise', 'next']); assert.deepEqual(lines(r), [QA_ALL_ZH, QA_NEXT_OK_ZH]); assert.deepEqual(ev(r, 'done')[0].corrections, []);
    const d = ev(r, 'done')[0]; assert.ok(d.timings.sttMs >= 0 && d.timings.checkMs >= 0 && d.timings.totalMs >= 0 && d.timings.firstCoachTextMs >= 0); assert.equal(d.summary.canPraise, true); assert.equal(d.summary.questionId, q.questionId);
    assert.equal(ev(r, 'coach_audio').length, 2);
    const sys = svc.state.requests.filter((x) => x.url === '/v1/chat/completions').at(-1).json.messages; const u = JSON.parse(sys[1].content);
    assert.deepEqual(Object.keys(u).sort(), ['keyPoints', 'modelAnswer', 'question', 'transcript']); assert.deepEqual(u.keyPoints[0], { id: 'k1', textZh: '早上起床' }); assert.ok(!sys[1].content.includes('refStart'));
  } finally { await t.close(); }
});
test('ATTEMPT missing key point: named FIRST with its offsets, model answer, no praise; max 2 corrections; offers retry/next', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    let r = await answer(t, q, '小明早上起来，上课学数学。', CHECK({ k2: { covered: false, evidence: null } }));
    let Q = ev(r, 'assessment')[0].qa;
    assert.deepEqual([Q.canPraise, Q.praiseLevel, Q.coveredCount, Q.missingKeyPointIds], [false, 'none', 2, ['k2']]);
    assert.deepEqual(lines(r), [qaMissingOpener(1), '漏掉了这个要点：骑自行车去学校', `可以这样说：${q.modelAnswerZh}`, QA_NEXT_RETRY_ZH]); assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'next']);
    const cs = ev(r, 'coach_text'); assert.deepEqual([cs[1].start, cs[1].end, cs[1].caption], [7, 14, '骑自行车去学校']);
    const d = ev(r, 'done')[0]; assert.deepEqual([d.corrections.length, d.corrections[0].kind, d.corrections[0].keyPointId, d.corrections[0].factRef, d.corrections[0].start, d.corrections[0].end, d.corrections[0].chunkIndex], [1, 'missing_key_point', 'k2', 'kp:k2', 7, 14, 0]);
    assert.ok(noPraise(r)); assert.ok(Q.suggestedWords.some((w) => w.text === '自行车'));
    r = await answer(t, q, '小明睡觉。', CHECK({ k1: { covered: false, evidence: null }, k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null } }));
    Q = ev(r, 'assessment')[0].qa; assert.equal(Q.missingKeyPointIds.length, 3);
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction', 'correction_model', 'next']); assert.equal(lines(r)[0], qaMissingOpener(3)); assert.equal(ev(r, 'done')[0].corrections.length, 2); assert.ok(noPraise(r));
    // only a part of a key point said (confident) => named as partial; low confidence missing => softened wording
    r = await answer(t, q, '小明早上起来，骑车，上课学数学。', CHECK({ k2: { covered: 'partial', evidence: '骑车', confidence: 'medium' } }));
    Q = ev(r, 'assessment')[0].qa; assert.deepEqual([Q.praiseLevel, Q.canPraise, Q.partialCount], ['soft', false, 1]); assert.deepEqual(lines(r).slice(0, 2), [QA_SOFT_ZH, '这个要点只讲了一部分：骑自行车去学校']);
  } finally { await t.close(); }
});
test('ATTEMPT wrong fact: flagged only when the quote is really in the transcript; hallucinated quotes and low-confidence claims dropped; never contradicts a covered key point', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const T = '小明早上起来，骑摩托车去学校，上课学数学。';
    const wf = (claim, contradicts = 'k2', confidence = 'high') => ({ wrongFacts: [{ claim, contradicts, confidence }] });
    let r = await answer(t, q, T, CHECK({ k2: { covered: false, evidence: null } }, wf('骑摩托车去学校')));
    let Q = ev(r, 'assessment')[0].qa;
    assert.deepEqual(Q.wrongFacts, [{ claimZh: '骑摩托车去学校', contradictsKeyPointId: 'k2', confidence: 'high' }]); assert.equal(Q.keyPoints[1].issue, 'wrong_fact'); assert.equal(Q.canPraise, false);
    assert.deepEqual(lines(r), [QA_WRONG_ZH, '你说的“骑摩托车去学校”和原文不一样。', `可以这样说：${q.modelAnswerZh}`, QA_NEXT_RETRY_ZH]); assert.equal(ev(r, 'done')[0].corrections[0].kind, 'wrong_fact'); assert.equal(ev(r, 'done')[0].corrections[0].heard, '骑摩托车去学校'); assert.ok(noPraise(r));
    // hallucinated quote => dropped: the key point stays "missing" (no accusation)
    r = await answer(t, q, T, CHECK({ k2: { covered: false, evidence: null } }, wf('开着汽车去公司')));
    Q = ev(r, 'assessment')[0].qa; assert.deepEqual(Q.wrongFacts, []); assert.equal(Q.missingKeyPointIds[0], 'k2'); assert.ok(!lines(r).join('').includes('开着汽车')); assert.ok(lines(r).includes('漏掉了这个要点：骑自行车去学校'));
    // low confidence, unknown key point id, covered key point => dropped
    for (const w of [wf('骑摩托车去学校', 'k2', 'low'), wf('骑摩托车去学校', 'k9'), wf('骑摩托车去学校', 'k1')]) {
      r = await answer(t, q, T, CHECK({ k2: { covered: false, evidence: null } }, w)); assert.deepEqual(ev(r, 'assessment')[0].qa.wrongFacts, []);
    }
    // wrong fact + a missing one: wrong fact first, max 2 corrections in total
    r = await answer(t, q, T, CHECK({ k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null }, k1: { covered: false, evidence: null } }, wf('骑摩托车去学校')));
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction', 'correction_model', 'next']); assert.match(lines(r)[1], /^你说的“骑摩托车去学校”/); assert.match(lines(r)[2], /^漏掉了这个要点/); assert.equal(lines(r)[0], qaMissingOpener(2));
  } finally { await t.close(); }
});
test('ATTEMPT "I don\'t know" and off-topic answers: no praise, said so, hint/answer offered (model answer stays one tap away); no false accusations', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const none = CHECK({ k1: { covered: false, evidence: null }, k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null } }, { answeredQuestion: false });
    let r = await answer(t, q, '我不知道。', none); let Q = ev(r, 'assessment')[0].qa;
    assert.deepEqual([Q.answeredQuestion, Q.answerKind, Q.canPraise, Q.praiseLevel, Q.coveredCount], [false, 'dont_know', false, 'none', 0]); assert.deepEqual(lines(r), [QA_DONTKNOW_ZH, QA_NEXT_HINT_ZH]); assert.ok(noPraise(r)); assert.deepEqual(ev(r, 'done')[0].corrections, []);
    assert.equal(Q.modelAnswerZh, q.modelAnswerZh);
    r = await answer(t, q, '今天天气很好，我喜欢吃苹果。', none); Q = ev(r, 'assessment')[0].qa;
    assert.deepEqual([Q.answerKind, Q.canPraise], ['off_topic', false]); assert.deepEqual(lines(r), [QA_OFFTOPIC_ZH, QA_NEXT_HINT_ZH]); assert.deepEqual(roles(r), ['opener', 'next']);
    // an off-topic transcript for which the model nevertheless claims "answered" but nothing is covered is NOT praised
    r = await answer(t, q, '今天天气很好。', CHECK({ k1: { covered: false, evidence: null }, k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null } }, { answeredQuestion: true }));
    assert.equal(ev(r, 'assessment')[0].qa.canPraise, false); assert.ok(noPraise(r));
  } finally { await t.close(); }
});
test('ATTEMPT unverifiable evidence cannot earn praise: covered:true with a quote not in the transcript => partial/low, no canPraise', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const r = await answer(t, q, '小明早上起来，上课学数学。', CHECK({ k2: { evidence: '骑自行车去学校了' } }));
    const Q = ev(r, 'assessment')[0].qa; assert.deepEqual([Q.keyPoints[1].covered, Q.keyPoints[1].evidence, Q.keyPoints[1].confidence, Q.canPraise], ['partial', null, 'low', false]);
    assert.equal(Q.coveredCount, 2); assert.ok(noPraise(r)); assert.equal(ev(r, 'done')[0].summary.droppedClaims, 1);
  } finally { await t.close(); }
});
test('ATTEMPT malformed LLM JSON (twice) => comparison "unavailable", could-not-check line, key points shown without verdicts, NO claims', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); svc.state.sttText = FULL_ANSWER; svc.state.chatScript = 'this is not json {'; const before = chatCalls();
    const r = await postQa(t, { question: q }); const Q = ev(r, 'assessment')[0].qa;
    assert.equal(chatCalls() - before, 2);
    assert.deepEqual([Q.comparisonStatus, Q.comparisonReason, Q.canPraise, Q.praiseLevel, Q.answeredQuestion, Q.wrongFacts, Q.missingKeyPointIds, Q.coveredCount], ['unavailable', 'malformed_output', false, 'none', null, [], [], 0]);
    assert.ok(Q.keyPoints.every((k) => k.covered === null && k.evidence === null)); assert.deepEqual(lines(r), [QA_UNAVAILABLE_ZH, QA_NEXT_RETRY_ZH]); assert.equal(ev(r, 'done')[0].corrections.length, 0);
    // schema-valid but a signed key point missing from the check => rejected too
    svc.state.chatScript = JSON.stringify({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: true, evidence: '早上起来', confidence: 'high' }], wrongFacts: [] });
    assert.equal(ev(await postQa(t, { question: q }), 'assessment')[0].qa.comparisonStatus, 'unavailable');
  } finally { await t.close(); }
});
test('ATTEMPT gate noise (audio does not match its transcript => low_match): fixed line only, no claims', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('08-wrong-sentence') });
  try {
    const q = await getQuestion(t); const r = await answer(t, q, '初来乍到。', CHECK({ k1: { covered: false, evidence: null }, k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null } }));
    const a = ev(r, 'assessment')[0]; assert.equal(a.gate, 'low_match'); assert.deepEqual([a.qa.comparisonStatus, a.qa.comparisonReason, a.qa.canPraise, a.qa.wrongFacts], ['unavailable', 'low_match', false, []]);
    assert.deepEqual(lines(r), [QA_GATE_ZH]); assert.equal(ev(r, 'done')[0].summary.gate, 'low_match'); assert.deepEqual(ev(r, 'done')[0].corrections, []);
  } finally { await t.close(); }
});
test('ATTEMPT errors: no STT key, STT failure, silence, too long => terminal error before any coaching; STT/LLM not called needlessly', async () => {
  let t = await server(envOai()); const q = await getQuestion(t);
  const tNo = await server({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect' });
  try {
    const qq = { ...q }; // signature is derived from the passcode only, so it is valid on the other test server too
    const r0 = await postQa(tNo, { question: qq }); assert.equal(ev(r0, 'error')[0].code, 'stt_not_configured'); assert.equal(tp.requests.length, 0);
    svc.state.sttText = 'um...'; assert.equal(ev(await postQa(t, { question: q }), 'error')[0].code, 'no_speech_detected');
    svc.state.sttText = '好'.repeat(301); assert.equal(ev(await postQa(t, { question: q }), 'error')[0].code, 'qa_answer_too_long');
    svc.state.sttStatus = 500; svc.state.sttText = '你好'; const before = chatCalls();
    const r = await postQa(t, { question: q }); assert.equal(ev(r, 'error')[0].stage, 'transcribing'); assert.equal(ev(r, 'assessment').length, 0); assert.equal(ev(r, 'coach_text').length, 0);
    assert.equal(tp.requests.length, 0); assert.equal(chatCalls(), before);
  } finally { await t.close(); await tNo.close(); }
});
test('ATTEMPT tone: skipped silently (reason in qa.tone) when the transcript has digits or TonePerfect fails; meaning feedback is still delivered; BOTH failing => terminal error', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    let r = await answer(t, q, '小明7点起床，骑车去学校，上课学数学。', CHECK({ k1: { evidence: '7点起床' } })); let Q = ev(r, 'assessment')[0].qa;
    assert.deepEqual(Q.tone, { status: 'skipped', reason: 'transcript_has_digits_or_latin' }); assert.equal(tp.requests.length, 0);
    const down = () => ({ status: 503, json: { error: { code: 'gateway_busy', message: 'x' } }, headers: { 'Retry-After': '0' } });
    tp.script(...Array.from({ length: 10 }, down)); r = await answer(t, q, FULL_ANSWER, CHECK());
    Q = ev(r, 'assessment')[0].qa; assert.equal(Q.tone.status, 'skipped'); assert.ok(Q.tone.reason); assert.equal(Q.canPraise, true); assert.deepEqual(roles(r), ['praise', 'next']);
    tp.reset(); tp.script(...Array.from({ length: 10 }, down)); svc.state.chatScript = 'garbage'; r = await postQa(t, { question: q });
    assert.equal(ev(r, 'assessment').length, 0); assert.equal(ev(r, 'error')[0].stage, 'assessment'); assert.equal(ev(r, 'coach_text').length, 0);
  } finally { await t.close(); }
});
test('ATTEMPT STT answers in TRADITIONAL characters: normalised to simplified; evidence verifies', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const r = await answer(t, q, '小明早上起來，騎車去學校，上課學數學。', CHECK({ k1: { evidence: '早上起来' }, k2: { evidence: '騎車去學校' }, k3: { evidence: '學數學' } }));
    const a = ev(r, 'assessment')[0]; assert.equal(a.transcript, '小明早上起来，骑车去学校，上课学数学。'); assert.equal(a.qa.canPraise, true); assert.equal(tp.requests.at(-1).fields.text, '小明早上起来骑车去学校上课学数学');
  } finally { await t.close(); }
});
test('ATTEMPT request validation: audio, question field, attemptId, TTS-tagged audio; idempotent replay with the same attemptId; auth required everywhere', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    assert.equal((await postQa(t, { question: q, noAudio: true })).json.error.code, 'missing_audio');
    assert.equal((await postQa(t, { question: q, fields: { attemptId: 'x' } })).json.error.code, 'invalid_attempt_id');
    assert.equal((await postQa(t, { question: q, fields: { source: 'tts' } })).json.error.code, 'tts_audio_rejected');
    assert.equal((await postQa(t, { question: q, fields: { question: '{}' } })).json.error.code, 'invalid_question');
    svc.state.sttText = FULL_ANSWER; svc.state.chatScript = llm();
    const r1 = await postQa(t, { question: q, fields: { attemptId: 'qa-replay-0001' } }); const calls = chatCalls();
    const r2 = await postQa(t, { question: q, fields: { attemptId: 'qa-replay-0001' } });
    assert.equal(r2.headers.get('x-attempt-replayed'), 'true'); assert.equal(chatCalls(), calls); assert.deepEqual(ev(r2, 'assessment')[0].qa, ev(r1, 'assessment')[0].qa);
    // auth
    const anon = { ...t, cookie: () => '' };
    assert.equal((await t.api('POST', '/api/qa/next', { chunks: [CHUNK] }, { auth: false })).status, 401);
    assert.equal((await t.api('POST', '/api/qa/hint', q, { auth: false })).status, 401); assert.equal((await t.api('POST', '/api/qa/answer', q, { auth: false })).status, 401);
    assert.equal((await postQa(anon, { question: q })).status, 401);
  } finally { await t.close(); }
});
test('QA persists NOTHING: DB unchanged, no temp files, no auto-saved words (next, hint, answer and attempt incl. a wrong answer)', async () => {
  const priv = fs.mkdtempSync((fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()) + '/qa-priv-'); const oldTmp = process.env.TMPDIR; process.env.TMPDIR = priv; // private tmpdir: other test files run in parallel processes
  const t = await server(envOai());
  const snap = () => JSON.stringify(t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => [x.name, t.db.raw.prepare(`select * from ${x.name}`).all()]));
  try {
    const s0 = snap(); const q = await getQuestion(t);
    await t.api('POST', '/api/qa/hint', q); await t.api('POST', '/api/qa/answer', q);
    const r = await answer(t, q, '小明早上起来，骑着一辆神秘的摩托车。', CHECK({ k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null } }, { wrongFacts: [{ claim: '骑着一辆神秘的摩托车', contradicts: 'k2', confidence: 'high' }] }));
    assert.equal(ev(r, 'assessment')[0].qa.wrongFacts.length, 1);
    const s1 = snap(); assert.equal(s1, s0, 'the database is unchanged'); assert.ok(!s1.includes('摩托车') && !s1.includes(CHUNK) && !s1.includes(q.questionZh));
    assert.deepEqual(fs.readdirSync(priv), [], 'nothing written to the temp dir');
  } finally { await t.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(priv, { recursive: true, force: true }); }
});
test('PREFS: practiceMode "qa" is accepted (the attempt endpoint for it is /api/qa/attempt)', async () => {
  const t = await server(envOai());
  try { assert.equal((await t.api('PUT', '/api/prefs', { practiceMode: 'qa' })).status, 200); assert.equal((await t.api('GET', '/api/prefs')).json.practiceMode, 'qa'); } finally { await t.close(); }
});
test('ATTEMPT tone (acoustic facts from TonePerfect on the transcript only): full answer + confirmed tone error => tone line in a leftover slot; meaning first, max 2 corrections', async () => {
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    const q = await getQuestion(t);
    let r = await answer(t, q, FULL_ANSWER, CHECK()); const a = ev(r, 'assessment')[0];
    assert.ok(a.facts.confirmedToneErrors.length >= 1); assert.equal(a.qa.canPraise, true);
    assert.deepEqual([roles(r)[0], lines(r)[0]], ['opener', QA_ALL_TONE_ZH]); assert.ok(roles(r).includes('correction')); assert.equal(roles(r).at(-1), 'next'); assert.ok(ev(r, 'done')[0].corrections.every((c) => c.kind === 'tone' || c.kind));
    assert.ok(ev(r, 'done')[0].corrections.length <= 2);
    r = await answer(t, q, '小明早上起来。', CHECK({ k2: { covered: false, evidence: null }, k3: { covered: false, evidence: null }, k1: { evidence: '早上起来' } }));
    assert.deepEqual(ev(r, 'done')[0].corrections.map((c) => c.kind), ['missing_key_point', 'missing_key_point']); // meaning first; the tone fact exists but is not spoken
  } finally { await t.close(); }
});
test('validateNext trims punctuation off span edges (offsets follow) and drops spans that cross a sentence end; claims lose edge punctuation and sentence-spanning claims are dropped', () => {
  const chunk = '小明早上起床。骑自行车去学校，在学校学习数学。';
  const q = validateNext(parseNext(NEXT({ keyPoints: [{ refQuote: '起床。骑自行车' }, { refQuote: '，在学校学习数学。' }, { refQuote: '早上起床。' }] })), { chunk, chunkIndex: 0, preferredType: 'what' });
  assert.deepEqual(q.keyPoints.map((k) => [k.textZh, k.refStart, k.refEnd]), [['早上起床', 2, 6], ['在学校学习数学', 15, 22]]); assert.ok(q.dropped.includes('span_crosses_sentences'));
  const Q = { questionZh: '小明怎么去学校？', modelAnswerZh: '他骑自行车去学校。', keyPoints: [{ id: 'k1', textZh: '骑自行车去学校', refStart: 7, refEnd: 14, chunkIndex: 0 }] };
  const T = '小明骑摩托车去学校。他很高兴。';
  const v = validateCheck(parseCheck({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: false, evidence: null, confidence: 'high' }], wrongFacts: [{ claim: '骑摩托车去学校。', contradicts: 'k1', confidence: 'high' }] }), { question: Q, transcript: T });
  assert.deepEqual(v.wrongFacts.map((w) => w.claimZh), ['骑摩托车去学校']);
  const v2 = validateCheck(parseCheck({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: false, evidence: null, confidence: 'high' }], wrongFacts: [{ claim: '骑摩托车去学校。他很高兴', contradicts: 'k1', confidence: 'high' }] }), { question: Q, transcript: T });
  assert.deepEqual(v2.wrongFacts, []);
});
test('validateCheck: an answer that shares no words with the question/key points is off-topic even if the model said "answered"; a wrong answer that shares words stays "answered"', () => {
  const Q = { questionZh: '老师下课以后做什么？', modelAnswerZh: '老师下课以后常常帮同学解答问题。', keyPoints: [{ id: 'k1', textZh: '常常帮同学解答问题', refStart: 0, refEnd: 9, chunkIndex: 0 }] };
  const raw = { answeredQuestion: true, keyPoints: [{ id: 'k1', covered: false, evidence: null, confidence: 'high' }], wrongFacts: [] };
  const off = validateCheck(parseCheck(raw), { question: Q, transcript: '我喜欢吃苹果。' }); assert.deepEqual([off.answeredQuestion, off.answerKind], [false, 'off_topic']);
  const dk = validateCheck(parseCheck(raw), { question: Q, transcript: '我不知道，我不太清楚这个问题。' }); assert.deepEqual([dk.answeredQuestion, dk.answerKind], [false, 'dont_know']);
  const wrong = validateCheck(parseCheck(raw), { question: Q, transcript: '老师下课以后去睡觉。' }); assert.deepEqual([wrong.answeredQuestion, wrong.answerKind], [true, 'answered']);
});

// ------------------------------------------------------------------------------------------------ REAL model output (cached by scripts/qa-real-check.js; replayed through the production validators, no network)
const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/qa/${n}.json`, import.meta.url), 'utf8'));
test('REAL model output (question generation): every cached gpt question validates; key-point offsets are real substrings of the chunk; hints never contain the answer', () => {
  const f = fx('next-real'); assert.ok(f.items.length >= 5);
  const types = new Set();
  for (const it of f.items) {
    const q = validateNext(parseNext(it.llmRaw), { chunk: it.chunk, chunkIndex: it.chunkIndex, preferredType: 'what' });
    assert.ok(q.keyPoints.length >= 1); types.add(q.type);
    for (const k of q.keyPoints) assert.equal(Array.from(it.chunk).slice(k.refStart, k.refEnd).join(''), k.textZh);
    assert.equal(q.questionId, it.resultQuestionId); assert.ok(!q.dropped.includes('hint_gives_answer'), JSON.stringify(q.dropped));
  }
  assert.ok(types.size >= 3, [...types].join());
});
test('REAL model output (answer check): good => full praise; partial/wrong => not covered, wrong fact quote verified; off-topic and "don\'t know" => not answered, no claims', () => {
  const by = Object.fromEntries(fx('check-real').items.map((i) => [i.name, i]));
  const run = (n) => { const i = by[n]; const q = { questionZh: i.question.questionZh, modelAnswerZh: i.question.modelAnswerZh, keyPoints: i.question.keyPoints }; return validateCheck(parseCheck(i.llmRaw), { question: q, transcript: i.transcript }); };
  const good = run('good'); assert.ok(good.keyPoints.every((k) => k.covered === true && k.evidence)); assert.equal(good.wrongFacts.length, 0); assert.equal(good.answeredQuestion, true);
  const part = run('partial'); assert.ok(part.keyPoints.some((k) => k.covered === false)); assert.ok(part.keyPoints.some((k) => k.covered === true));
  const wrong = run('wrong'); assert.equal(wrong.wrongFacts.length, 1); assert.ok(by.wrong.transcript.includes(wrong.wrongFacts[0].claimZh)); assert.equal(wrong.keyPoints.find((k) => k.id === wrong.wrongFacts[0].contradictsKeyPointId).issue, 'wrong_fact');
  for (const n of ['offtopic', 'dont_know']) { const r = run(n); assert.equal(r.answeredQuestion, false); assert.equal(r.wrongFacts.length, 0); assert.ok(r.keyPoints.every((k) => k.covered === false)); }
  assert.equal(run('dont_know').answerKind, 'dont_know'); assert.equal(run('offtopic').answerKind, 'off_topic');
});
