// Natural RETELL mode (assessMode 'retell'): STT -> LLM meaning comparison (strict JSON, validated by CODE) -> code-built coaching.
// Fakes only (fake OpenAI incl. STT/LLM/TTS, fake or cached TonePerfect); no network, no keys.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { startTestServer, postAttempt, fixtureEngine } from './helpers.js';
import { startFakeToneperfect } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';
import { resolveSpan, quoteInTranscript, isGrounded, parseCompare, validateCompare, bestWindow, RT_UNAVAILABLE_ZH, RT_ALL_ZH, RT_SOFT_ZH, RT_GATE_ZH, RT_ALL_TONE_ZH, rtMissingOpener, RT_WRONG_ZH } from '../services/retell.js';

const TP_KEY = 'tp_test_FAKEKEYFORTESTS0123456789'; const OAI_KEY = 'sk-fakeopenaikey0123456789';
let tp; let svc;
before(async () => { tp = await startFakeToneperfect(); svc = await startFakeServices(); });
after(async () => { await tp.close(); await svc.close(); });
beforeEach(() => { tp.reset(); svc.reset(); svc.state.chatScript = null; });

const envOai = (x = {}) => ({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect', OPENAI_API_KEY: OAI_KEY, OPENAI_BASE_URL: svc.openaiBase, ...x });
async function server(env, opts) { const t = await startTestServer(env, opts); await t.login(); return t; }
const ev = (r, n) => r.events.filter((e) => e.event === n).map((e) => e.data);
const chatCalls = () => svc.state.requests.filter((r) => r.url === '/v1/chat/completions').length;
const lines = (r) => ev(r, 'coach_text').map((x) => x.delta);
const roles = (r) => ev(r, 'coach_text').map((x) => x.role);
const PRAISE = /很好|不错|太棒|很棒|完美|完整|全对|都对|正确|没问题/;
const noPraise = (r) => lines(r).every((l) => !PRAISE.test(l.replace(/(漏掉了这个意思|可以这样说|应该这样说)[：:].*$/, '')));

// 小明早上起床，骑自行车去学校，在学校学习数学。   offsets: 早上起床 2-6, 骑自行车去学校 7-14, 在学校学习数学 15-22
const CHUNK = '小明早上起床，骑自行车去学校，在学校学习数学。';
const IDEAS_ALL = (over = {}) => [
  { id: 'i1', textZh: '早上起床', refQuote: '早上起床', covered: true, evidence: '早上起来', confidence: 'high', ...(over.i1 || {}) },
  { id: 'i2', textZh: '骑车去学校', refQuote: '骑自行车去学校', covered: true, evidence: '骑车去学校', confidence: 'high', ...(over.i2 || {}) },
  { id: 'i3', textZh: '学习数学', refQuote: '在学校学习数学', covered: true, evidence: '上课学数学', confidence: 'high', ...(over.i3 || {}) },
];
const cmpJson = (ideas, corrections = [], summaryZh = '你用自己的话讲清楚了。') => JSON.stringify({ ideas, corrections, summaryZh });
const COVERED_TEXT = '小明早上起来，然后骑车去学校，上课学数学。';   // different wording, same meaning
const post = (t, over = {}) => postAttempt(t, { fields: { assessMode: 'retell', practiceMode: 'fading_cues', chunkText: CHUNK, ...over } });

// ------------------------------------------------------------------------------------------------ pure helpers
test('resolveSpan: CODE resolves quotes to code-point offsets (exact, punctuation-insensitive, fuzzy); unknown quotes => null', () => {
  assert.deepEqual(resolveSpan(CHUNK, '骑自行车去学校'), { start: 7, end: 14, how: 'exact' });
  assert.deepEqual(resolveSpan(CHUNK, '骑自行车，去学校'), { start: 7, end: 14, how: 'normalized' });   // punctuation in the quote is ignored
  const f = resolveSpan(CHUNK, '骑自行车到学校'); assert.equal(f.how, 'fuzzy'); assert.deepEqual([f.start, f.end], [7, 14]);
  assert.equal(resolveSpan(CHUNK, '他每天吃早饭'), null); assert.equal(resolveSpan(CHUNK, '学'), null); assert.equal(resolveSpan(CHUNK, ''), null);
  assert.deepEqual(resolveSpan('😀我爱你，你爱我。', '你爱我'), { start: 5, end: 8, how: 'exact' }); // offsets are code POINTS, not UTF-16 units
  assert.ok(bestWindow(['a', 'b', 'c', 'd'], ['b', 'c']).dist === 0);
});
test('quoteInTranscript: exact, punctuation, traditional/simplified (pinyin level); fabricated quotes are rejected', () => {
  const T = '小明早上起來，然後騎車去學校。';
  assert.ok(quoteInTranscript('早上起来', T)); assert.ok(quoteInTranscript('骑车去学校', T)); assert.ok(quoteInTranscript('起來，然後', T));
  assert.equal(quoteInTranscript('他吃了早饭', T), false); assert.equal(quoteInTranscript('学', T), false);
});
test('isGrounded: a modelled sentence may not add facts beyond the reference', () => {
  assert.ok(isGrounded('他骑自行车去学校。', CHUNK)); assert.ok(isGrounded('小明早上起床，然后去学校。', CHUNK));
  assert.equal(isGrounded('小明骑摩托车去北京出差。', CHUNK), false); assert.equal(isGrounded('他去school', CHUNK), false); assert.equal(isGrounded('这个字是第三声。', CHUNK), false);
});
test('parseCompare: strict schema (bad shapes throw, unknown correction kinds skipped, covered normalised)', () => {
  assert.throws(() => parseCompare(null)); assert.throws(() => parseCompare({ ideas: 'x' })); assert.throws(() => parseCompare({ ideas: [] }));
  assert.throws(() => parseCompare({ ideas: [{ textZh: 'a', refQuote: 'b' }] }), /covered/);
  assert.throws(() => parseCompare({ ideas: [{ textZh: 'a', refQuote: 'bb', covered: 'maybe' }] }));
  assert.throws(() => parseCompare({ ideas: [{ textZh: 'a', refQuote: 'bb', covered: true, evidence: 5 }] }));
  assert.throws(() => parseCompare({ ideas: [{ textZh: 'a', refQuote: 'bb', covered: true, confidence: 'sure' }] }));
  const ok = parseCompare({ ideas: [{ textZh: 'a', refQuote: 'bb', covered: 'false' }], corrections: [{ kind: 'wording' }, { kind: 'language', quote: 'x' }] });
  assert.equal(ok.ideas[0].covered, false); assert.equal(ok.corrections.length, 1);
});

// ------------------------------------------------------------------------------------------------ end to end
test('RETELL all ideas covered with DIFFERENT wording: canPraise, no corrections, retell block with offsets; TonePerfect scored against the transcript; wordStatus not computed', async () => {
  svc.state.sttText = COVERED_TEXT; svc.state.chatScript = cmpJson(IDEAS_ALL());
  const t = await server(envOai());
  try {
    const r = await post(t);
    const [a] = ev(r, 'assessment'); const R = a.retell;
    assert.equal(a.basis, 'transcript'); assert.equal(a.lowConfidence, true); assert.equal(a.transcriptDerived, true); assert.equal(a.transcript, COVERED_TEXT);
    assert.equal(a.referenceText, '小明早上起来然后骑车去学校上课学数学'); assert.equal(tp.requests.at(-1).fields.text, a.referenceText);
    assert.deepEqual(a.wordStatus, []); assert.deepEqual(a.facts.missingWords, []); assert.deepEqual(a.savedMissed, []);
    assert.deepEqual([R.comparisonStatus, R.sttStatus, R.coveredCount, R.totalCount, R.canPraise, R.praiseLevel, R.missingIdeaIds, R.tone], ['ok', 'ok', 3, 3, true, 'full', [], { status: 'ok' }]);
    assert.deepEqual(R.ideas.map((x) => [x.id, x.refStart, x.refEnd, x.covered]), [['i1', 2, 6, true], ['i2', 7, 14, true], ['i3', 15, 22, true]]);
    assert.equal(R.ideas[1].evidence, '骑车去学校'); assert.equal(a.facts.canPraise, true);
    for (const i of R.ideas) assert.equal(Array.from(CHUNK).slice(i.refStart, i.refEnd).join('').length, i.refEnd - i.refStart);
    assert.deepEqual(roles(r), ['praise', 'summary', 'next']); assert.equal(lines(r)[0], RT_ALL_ZH);
    const d = ev(r, 'done')[0]; assert.deepEqual(d.corrections, []);
    assert.ok(d.timings.sttMs >= 0 && d.timings.compareMs >= 0 && d.timings.assessMs >= 0 && d.timings.totalMs >= 0);
    assert.equal(ev(r, 'coach_audio').length, 3);
    // the LLM saw ONLY the reference and the transcript
    const sent = JSON.parse(svc.state.requests.find((x) => x.url === '/v1/chat/completions').json.messages[1].content);
    assert.deepEqual(Object.keys(sent).sort(), ['reference', 'transcript']); assert.equal(sent.reference, CHUNK);
    assert.equal(svc.state.requests.find((x) => x.url === '/v1/audio/transcriptions') !== undefined, true);
    const stt = svc.state.requests.find((x) => x.url === '/v1/audio/transcriptions');
    assert.ok(!stt.body.toString('latin1').includes(CHUNK) && !stt.body.toString('utf8').includes('小明'), 'the reference must never be in the STT request');
  } finally { await t.close(); }
});

test('RETELL missing idea: flagged with CODE-resolved offsets, named FIRST (opener, then the idea), modelled, no praise, suggestedWords', async () => {
  svc.state.sttText = '小明早上起来，在学校学数学。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i2: { covered: false, evidence: null, confidence: 'high', refQuote: '骑自行车去学校' }, i3: { evidence: '在学校学数学' } }),
    [{ kind: 'missing_idea', ideaId: 'i2', modelText: '他骑自行车去学校。' }], '很好，你都讲对了。');
  const t = await server(envOai());
  try {
    const r = await post(t); const [a] = ev(r, 'assessment'); const R = a.retell;
    assert.deepEqual([R.canPraise, R.praiseLevel, R.coveredCount, R.totalCount, R.missingIdeaIds], [false, 'none', 2, 3, ['i2']]);
    assert.deepEqual([R.ideas[1].refStart, R.ideas[1].refEnd, R.ideas[1].covered, R.ideas[1].evidence], [7, 14, false, null]);
    assert.equal(a.facts.canPraise, false);
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'next']);
    assert.equal(lines(r)[0], rtMissingOpener(1)); assert.equal(lines(r)[1], '漏掉了这个意思：骑车去学校'); assert.equal(lines(r)[2], '可以这样说：他骑自行车去学校。');
    const cc = ev(r, 'coach_text')[1]; assert.deepEqual([cc.start, cc.end, cc.caption], [7, 14, '骑车去学校']);
    assert.ok(noPraise(r), JSON.stringify(lines(r)));                                                  // the LLM's "很好，你都讲对了。" never reaches the user
    const [d] = ev(r, 'done'); assert.equal(d.corrections.length, 1);
    assert.deepEqual([d.corrections[0].kind, d.corrections[0].start, d.corrections[0].end, d.corrections[0].ideaId, d.corrections[0].factRef, d.corrections[0].source], ['missing_idea', 7, 14, 'i2', 'idea:i2', 'server_fact']);
    assert.ok(R.suggestedWords.length >= 1 && R.suggestedWords.every((w) => w.ideaId === 'i2' && /^[\u4e00-\u9fff]{2,}$/.test(w.text) && w.pinyin && Array.from(CHUNK).slice(7, 14).join('').includes(w.text)));
    assert.equal(t.db.listMissed().length, 0, 'retell never auto-saves to the words-I-do-not-know list');
  } finally { await t.close(); }
});

test('RETELL missing idea without any LLM model text: the model line is the reference span (code), never invented', async () => {
  svc.state.sttText = '小明早上起来，在学校学数学。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i2: { covered: false, evidence: null }, i3: { evidence: '在学校学数学' } }), [{ kind: 'missing_idea', ideaId: 'i2', modelText: '小明骑摩托车去北京出差了。' }]);
  const t = await server(envOai());
  try { const r = await post(t); assert.equal(lines(r)[2], '可以这样说：骑自行车去学校'); } finally { await t.close(); }
});

test('RETELL two missing ideas: max 2 corrections, counted opener, tone correction squeezed out', async () => {
  svc.state.sttText = '小明早上起来。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i2: { covered: false, evidence: null }, i3: { covered: false, evidence: null }, i1: { evidence: '早上起来' } }));
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    const r = await post(t); const R = ev(r, 'assessment')[0].retell;
    assert.deepEqual(R.missingIdeaIds, ['i2', 'i3']); assert.equal(lines(r)[0], rtMissingOpener(2));
    const d = ev(r, 'done')[0]; assert.equal(d.corrections.length, 2); assert.deepEqual(d.corrections.map((c) => c.kind), ['missing_idea', 'missing_idea']);
    assert.ok(ev(r, 'assessment')[0].facts.confirmedToneErrors.length >= 1);   // the tone fact exists but is not spoken: meaning first, max 2
  } finally { await t.close(); }
});

test('RETELL wrong meaning: LLM correction kept only with a verified transcript quote; explanation sanitised; offsets from code', async () => {
  svc.state.sttText = '小明早上起来，骑车去学校，上课学英语。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i3: { covered: false, evidence: null } }), [{ kind: 'wrong_meaning', ideaId: 'i3', quote: '上课学英语', explanationZh: '你说的是英语，原文是数学。', modelText: '他在学校学习数学。' }]);
  const t = await server(envOai());
  try {
    const r = await post(t); const R = ev(r, 'assessment')[0].retell;
    assert.equal(R.ideas[2].issue, 'wrong_meaning'); assert.equal(lines(r)[0], RT_WRONG_ZH);
    const c = ev(r, 'done')[0].corrections[0];
    assert.deepEqual([c.kind, c.ideaId, c.start, c.end, c.heard, c.explanationZh, c.modelText, c.source], ['wrong_meaning', 'i3', 15, 22, '上课学英语', '你说的是英语，原文是数学。', '他在学校学习数学。', 'llm']);
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'next']);
  } finally { await t.close(); }
});

test('RETELL partial coverage => SOFT praise only (never "good/complete"), partial idea named', async () => {
  svc.state.sttText = '小明早上起来，骑车去学校，在学校学习。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i3: { covered: 'partial', evidence: '在学校学习', confidence: 'medium' } }));
  const t = await server(envOai());
  try {
    const r = await post(t); const R = ev(r, 'assessment')[0].retell;
    assert.deepEqual([R.canPraise, R.praiseLevel, R.coveredCount, R.partialCount, R.missingIdeaIds], [false, 'soft', 2, 1, []]);
    assert.equal(lines(r)[0], RT_SOFT_ZH); assert.equal(lines(r)[1], '这个意思只讲了一部分：学习数学'); assert.ok(!lines(r).includes(RT_ALL_ZH));
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ validation / grounding
test('RETELL malformed LLM JSON: one retry, then comparisonStatus "unavailable": no coverage claims, no praise, says it could not compare', async () => {
  svc.state.sttText = COVERED_TEXT; svc.state.chatScript = 'this is not json {';
  const t = await server(envOai());
  try {
    const r = await post(t); const R = ev(r, 'assessment')[0].retell;
    assert.equal(chatCalls(), 2);
    assert.deepEqual([R.comparisonStatus, R.comparisonReason, R.ideas, R.coveredCount, R.totalCount, R.canPraise, R.missingIdeaIds, R.suggestedWords], ['unavailable', 'malformed_output', [], 0, 0, false, [], []]);
    assert.equal(lines(r)[0], RT_UNAVAILABLE_ZH); assert.ok(!lines(r).some((l) => PRAISE.test(l)) && !lines(r).some((l) => /漏|没讲/.test(l)));
    assert.deepEqual(ev(r, 'done')[0].corrections, []);
  } finally { await t.close(); }
});
test('RETELL schema-invalid JSON (valid JSON, wrong shape) is treated like malformed; a valid answer on the retry is used', async () => {
  svc.state.sttText = COVERED_TEXT; let n = 0;
  svc.state.chatScript = () => (++n === 1 ? JSON.stringify({ ideas: 'nope' }) : cmpJson(IDEAS_ALL()));
  const t = await server(envOai());
  try { const r = await post(t); assert.equal(chatCalls(), 2); assert.equal(ev(r, 'assessment')[0].retell.comparisonStatus, 'ok'); assert.equal(ev(done(r), 'x').length, 0); assert.equal(ev(r, 'done')[0].summary.compareAttempts, 2); } finally { await t.close(); }
  function done(x) { return x; }
});
test('RETELL LLM HTTP failure: retried once then "unavailable"; tone check still reported', async () => {
  svc.state.sttText = COVERED_TEXT; svc.state.chatStatus = 500;
  const t = await server(envOai());
  try { const r = await post(t); const R = ev(r, 'assessment')[0].retell; assert.equal(R.comparisonStatus, 'unavailable'); assert.equal(R.canPraise, false); assert.equal(R.tone.status, 'ok'); assert.equal(lines(r)[0], RT_UNAVAILABLE_ZH); } finally { await t.close(); }
});

test('RETELL hallucinated span (not in the reference) => idea dropped; hallucinated evidence => demoted to partial/low, NOT praised; hallucinated correction quote => dropped', async () => {
  svc.state.sttText = '小明早上起来，骑车去学校。';
  svc.state.chatScript = cmpJson([
    ...IDEAS_ALL({ i3: { covered: true, evidence: '他在公园里踢足球', confidence: 'high' }, i2: { evidence: '骑车去学校' } }),
    { id: 'i4', textZh: '吃早饭', refQuote: '他每天吃很多早饭', covered: false, evidence: null, confidence: 'high' }],
  [{ kind: 'wrong_meaning', ideaId: 'i3', quote: '我喜欢踢足球', explanationZh: '不对。', modelText: '他在学校学习数学。' }, { kind: 'language', ideaId: null, quote: '他去公园', explanationZh: '说法不对。', modelText: '他去学校。' }]);
  const t = await server(envOai());
  try {
    const r = await post(t); const R = ev(r, 'assessment')[0].retell;
    assert.equal(R.totalCount, 3); assert.ok(!R.ideas.some((i) => i.textZh === '吃早饭'), 'invented idea (span not in reference) dropped');
    const i3 = R.ideas[2]; assert.deepEqual([i3.covered, i3.evidence, i3.confidence], ['partial', null, 'low']);
    assert.deepEqual([R.canPraise, R.praiseLevel], [false, 'soft']);
    assert.equal(ev(r, 'done')[0].corrections.length, 0, 'quotes that are not in the transcript are rejected, and a low-confidence partial idea is not turned into an accusation');
    assert.equal(ev(r, 'done')[0].summary.droppedIdeas >= 3, true);
    assert.ok(!lines(r).some((l) => l === RT_ALL_ZH));
  } finally { await t.close(); }
});
test('RETELL too many hallucinated spans => unusable => "unavailable" (never a fabricated verdict)', async () => {
  svc.state.sttText = COVERED_TEXT;
  svc.state.chatScript = cmpJson([{ id: 'i1', textZh: '甲', refQuote: '完全不存在的内容', covered: false, evidence: null, confidence: 'high' }, { id: 'i2', textZh: '乙', refQuote: '另一个不存在的东西', covered: false, evidence: null, confidence: 'high' }]);
  const t = await server(envOai());
  try { const R = ev(await post(t), 'assessment')[0].retell; assert.equal(R.comparisonStatus, 'unavailable'); assert.equal(R.comparisonReason, 'malformed_output'.replace('malformed_output', 'unusable_output')); } finally { await t.close(); }
});

test('RETELL tone-like claims in LLM text are rewritten/dropped: summary dropped, language explanation replaced with a fixed line, model text with tone talk ignored', async () => {
  svc.state.sttText = '小明早上起来，骑车去学校，上课学数学。';
  svc.state.chatScript = cmpJson(IDEAS_ALL(), [{ kind: 'language', ideaId: 'i3', quote: '上课学数学', explanationZh: '“数”应该读第四声，你读成了第三声。', modelText: '他在学校学习数学。' }], '你的声调很准，第二声也不错。');
  const t = await server(envOai());
  try {
    const r = await post(t); const all = lines(r).join('|');
    assert.ok(!/声调|第[一二三四]声|声/.test(all), all);
    assert.ok(!roles(r).includes('summary'));
    const c = ev(r, 'done')[0].corrections[0]; assert.equal(c.kind, 'language'); assert.equal(c.explanationZh, '这个说法可以更自然一些。'); assert.equal(c.source, 'server_fact');
  } finally { await t.close(); }
});
test('RETELL wording-only changes are NOT errors: LLM "wording" correction ignored, synonyms covered => full praise, zero corrections', async () => {
  svc.state.sttText = '小明一早就起床了，他骑单车去学堂，在那儿学数学。';
  svc.state.chatScript = cmpJson(IDEAS_ALL({ i1: { evidence: '一早就起床了' }, i2: { evidence: '骑单车去学堂' }, i3: { evidence: '在那儿学数学' } }), [{ kind: 'wording', ideaId: 'i2', quote: '骑单车', explanationZh: '应该说自行车。', modelText: '骑自行车' }]);
  const t = await server(envOai());
  try { const r = await post(t); assert.equal(ev(r, 'assessment')[0].retell.canPraise, true); assert.deepEqual(ev(r, 'done')[0].corrections, []); } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ tone / TonePerfect composition
test('RETELL tone: a confirmed tone error on the transcript is reported (hedged, code-built) after meaning; not spoken as praise', async () => {
  svc.state.sttText = '我喜欢学中文。';
  svc.state.chatScript = cmpJson([{ id: 'i1', textZh: '喜欢学中文', refQuote: '我喜欢学中文', covered: true, evidence: '我喜欢学中文', confidence: 'high' }]);
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    const r = await postAttempt(t, { fields: { assessMode: 'retell', chunkText: '我喜欢学中文。' } });
    const a = ev(r, 'assessment')[0]; assert.equal(a.retell.tone.status, 'ok'); assert.ok(a.facts.confirmedToneErrors.length >= 1);
    assert.equal(lines(r)[0], RT_ALL_TONE_ZH); assert.equal(roles(r)[1], 'correction');
    const c = ev(r, 'done')[0].corrections[0]; assert.equal(c.kind, 'tone'); assert.equal(c.source, 'server_fact'); assert.match(c.explanationZh, /^按我听到的词/);
  } finally { await t.close(); }
});
test('RETELL tone check skipped (and said so) when the transcript has digits/latin; meaning comparison still works; TonePerfect is not called', async () => {
  svc.state.sttText = '小明7点起床，骑自行车去学校。'; svc.state.chatScript = cmpJson([{ id: 'i1', textZh: '早上起床', refQuote: '早上起床', covered: true, evidence: '7点起床', confidence: 'medium' }]);
  const t = await server(envOai());
  try {
    const r = await post(t); const a = ev(r, 'assessment')[0];
    assert.equal(tp.requests.length, 0); assert.deepEqual(a.retell.tone, { status: 'skipped', reason: 'transcript_has_digits_or_latin' });
    assert.equal(a.retell.comparisonStatus, 'ok'); assert.deepEqual(a.syllables, []); assert.equal(a.overall, null); assert.equal(ev(r, 'done')[0].summary.tone, 'skipped');
  } finally { await t.close(); }
});
test('RETELL TonePerfect failure => tone skipped (reason given), meaning feedback still delivered; BOTH failing => terminal error, no coaching', async () => {
  svc.state.sttText = COVERED_TEXT; svc.state.chatScript = cmpJson(IDEAS_ALL());
  const t = await server(envOai());
  try {
    const down = () => ({ status: 503, json: { error: { code: 'gateway_busy', message: 'x' } }, headers: { 'Retry-After': '0' } });
    tp.script(...Array.from({ length: 10 }, down));
    let r = await post(t); let a = ev(r, 'assessment')[0];
    assert.equal(a.retell.tone.status, 'skipped'); assert.ok(a.retell.tone.reason); assert.equal(a.retell.canPraise, true);
    tp.reset(); tp.script(...Array.from({ length: 10 }, down));
    svc.state.chatScript = 'garbage';
    r = await post(t);
    assert.equal(ev(r, 'assessment').length, 0); assert.equal(ev(r, 'error')[0].stage, 'assessment'); assert.equal(ev(r, 'coach_text').length, 0);
  } finally { await t.close(); }
});
test('RETELL cross-check: audio that does not match its own transcript (gate low_match, e.g. noise/STT hallucination) => comparison "unavailable", fixed line, no claims', async () => {
  svc.state.sttText = '初来乍到。'; svc.state.chatScript = cmpJson(IDEAS_ALL({ i1: { covered: false, evidence: null }, i2: { covered: false, evidence: null }, i3: { covered: false, evidence: null } }));
  const t = await server(envOai(), { engine: await fixtureEngine('08-wrong-sentence') });
  try {
    const r = await post(t); const a = ev(r, 'assessment')[0];
    assert.equal(a.gate, 'low_match'); assert.deepEqual([a.retell.comparisonStatus, a.retell.comparisonReason, a.retell.ideas, a.retell.canPraise], ['unavailable', 'low_match', [], false]);
    assert.deepEqual(lines(r), [RT_GATE_ZH]); assert.equal(ev(r, 'done')[0].summary.gate, 'low_match'); assert.deepEqual(ev(r, 'done')[0].corrections, []);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ errors, persistence, misc
test('RETELL error paths: no STT key, empty transcript, too long, STT failure => terminal error, no assessment, no coaching, nothing else called', async () => {
  let t = await server({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect' });
  try { const r = await post(t); assert.equal(ev(r, 'error')[0].code, 'stt_not_configured'); assert.equal(tp.requests.length, 0); } finally { await t.close(); }
  t = await server(envOai());
  try {
    svc.state.sttText = 'um...'; assert.equal(ev(await post(t), 'error')[0].code, 'no_speech_detected');
    svc.state.sttText = '好'.repeat(301); assert.equal(ev(await post(t), 'error')[0].code, 'retell_too_long');
    svc.state.sttStatus = 500; svc.state.sttText = '你好';
    const r = await post(t); assert.equal(ev(r, 'error')[0].stage, 'transcribing'); assert.equal(ev(r, 'assessment').length, 0); assert.equal(ev(r, 'coach_text').length, 0);
    assert.equal(tp.requests.length, 0); assert.equal(chatCalls(), 0);
  } finally { await t.close(); }
});
test('RETELL long retelling (> 100 hanzi, <= 300) is compared; tone check skipped with a reason', async () => {
  svc.state.sttText = '小明早上起床，'.repeat(20); svc.state.chatScript = cmpJson([{ id: 'i1', textZh: '早上起床', refQuote: '早上起床', covered: true, evidence: '小明早上起床', confidence: 'high' }]);
  const t = await server(envOai());
  try { const r = await post(t); const R = ev(r, 'assessment')[0].retell; assert.equal(R.comparisonStatus, 'ok'); assert.deepEqual(R.tone, { status: 'skipped', reason: 'transcript_too_long_for_tone' }); assert.equal(tp.requests.length, 0); } finally { await t.close(); }
});
test('RETELL idempotent replay: same attemptId replays recorded events (no new LLM/TP/STT call)', async () => {
  svc.state.sttText = COVERED_TEXT; svc.state.chatScript = cmpJson(IDEAS_ALL());
  const t = await server(envOai());
  try {
    const r1 = await post(t, { attemptId: 'retell-replay-0001' }); const calls = chatCalls();
    const r2 = await post(t, { attemptId: 'retell-replay-0001' });
    assert.equal(r2.headers.get('x-attempt-replayed'), 'true'); assert.equal(chatCalls(), calls); assert.deepEqual(ev(r2, 'assessment')[0].retell, ev(r1, 'assessment')[0].retell);
  } finally { await t.close(); }
});
test('RETELL persists NOTHING: no transcript/audio in the DB, no temp files, no auto-saved words', async () => {
  svc.state.sttText = '小明早上起来，骑着一辆神秘的摩托车。'; svc.state.chatScript = cmpJson(IDEAS_ALL({ i2: { covered: false, evidence: null }, i3: { covered: false, evidence: null } }));
  const priv = fs.mkdtempSync(os.tmpdir() + '/retell-priv-'); const oldTmp = process.env.TMPDIR; process.env.TMPDIR = priv; // private tmpdir: other test files run in parallel processes
  const t = await server(envOai());
  const tables = () => t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => x.name);
  const snap = () => JSON.stringify(tables().map((n) => [n, t.db.raw.prepare(`select * from ${n}`).all()]));
  try {
    const s0 = snap(); const r = await post(t);
    assert.equal(ev(r, 'assessment')[0].retell.missingIdeaIds.length, 2);
    const s1 = snap(); assert.equal(s1, s0, 'the database is unchanged by a retell attempt');
    assert.ok(!s1.includes('摩托车') && !s1.includes(CHUNK));
    assert.deepEqual(fs.readdirSync(priv), [], 'nothing written to the temp dir');
  } finally { await t.close(); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(priv, { recursive: true, force: true }); }
});
test('RETELL: invalid input still rejected; TTS-tagged audio rejected', async () => {
  const t = await server(envOai());
  try {
    assert.equal((await post(t, { chunkText: '' })).status, 400);
    assert.equal((await post(t, { source: 'tts' })).status, 400);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------------------------------- real model output (cached fixtures)
// test/fixtures/retell/*.json = REAL gpt-4.1-mini JSON for REAL gpt-4o-transcribe text of OpenAI-TTS "learner" audio (scripts/retell-real-check.js). No keys, no audio.
import fsSync from 'node:fs';
import { compareMeaning } from '../services/retell.js';
const FXDIR = new URL('./fixtures/retell/', import.meta.url);
const real = (n) => JSON.parse(fsSync.readFileSync(new URL(n + '.json', FXDIR), 'utf8'));
async function replay(fx) {
  return compareMeaning({ llm: { available: true, chatJson: async () => structuredClone(fx.llmRaw) }, chunkText: fx.chunkText, transcript: fx.transcript });
}
const spanOf = (fx, i) => Array.from(fx.chunkText).slice(i.refStart, i.refEnd).join('');

test('REAL model output: retelling with different wording => every span resolved by code, every evidence verified, all covered', async () => {
  const fx = real('all-ideas-own-words'); const c = await replay(fx);
  assert.equal(c.status, 'ok'); assert.equal(c.dropped.length, 0);
  assert.ok(c.ideas.length >= 2 && c.ideas.every((i) => i.covered === true && i.evidence && i.confidence !== 'low'), JSON.stringify(c.ideas));
  assert.ok(c.ideas.every((i, k) => i.refEnd > i.refStart && (k === 0 || i.refStart >= c.ideas[k - 1].refEnd - 3)), 'spans are ordered');
});

test('REAL model output: omitted idea => exactly the football idea is not covered, at its real offsets', async () => {
  const fx = real('omits-football'); const c = await replay(fx);
  assert.equal(c.status, 'ok'); assert.equal(c.dropped.length, 0);
  const missing = c.ideas.filter((i) => i.covered !== true);
  assert.equal(missing.length, 1); assert.equal(spanOf(fx, missing[0]), '下午回家踢足球'); assert.equal(missing[0].evidence, null);
  assert.ok(c.ideas.filter((i) => i.covered === true).every((i) => i.evidence));
});

test('REAL model output: wrong meaning => the contradicted ideas are not covered; wrong_meaning corrections survive code validation', async () => {
  const fx = real('wrong-meaning'); const c = await replay(fx);
  assert.equal(c.status, 'ok');
  const bad = c.ideas.filter((i) => i.covered !== true).map((i) => spanOf(fx, i)).join('|');
  assert.match(bad, /骑自行车去学校/); assert.match(bad, /数学和英语/); assert.match(bad, /踢足球/);
  assert.ok(c.llmCorrections.some((x) => x.kind === 'wrong_meaning'), JSON.stringify(c.llmCorrections));
});

test('RETELL STT answers in TRADITIONAL characters: transcript is normalised to simplified; evidence still verifies; TonePerfect gets simplified hanzi', async () => {
  svc.state.sttText = '小明早上起來，然後騎車去學校，上課學數學。'; svc.state.chatScript = cmpJson(IDEAS_ALL({ i1: { evidence: '早上起来' }, i2: { evidence: '騎車去學校' }, i3: { evidence: '學數學' } }));
  const t = await server(envOai());
  try {
    const r = await post(t); const [a] = ev(r, 'assessment');
    assert.equal(a.transcript, '小明早上起来，然后骑车去学校，上课学数学。'); assert.equal(a.retell.transcript, a.transcript);
    assert.equal(tp.requests.at(-1).fields.text, '小明早上起来然后骑车去学校上课学数学');
    assert.equal(a.retell.canPraise, true); assert.ok(a.retell.ideas.every((i) => i.evidence && i.confidence !== 'low'));
  } finally { await t.close(); }
});

test('suggestWords: vocabulary of the missed idea (suffix nouns kept whole, function words skipped, words the learner said excluded)', async () => {
  const { suggestWords } = await import('../services/retell.js');
  assert.deepEqual(suggestWords([{ id: 'i3', covered: false, refStart: 0, refEnd: 7 }], '骑自行车去学校。', '').map((x) => x.text), ['自行车', '学校']);
  assert.deepEqual(suggestWords([{ id: 'i3', covered: false, refStart: 0, refEnd: 7 }], '骑自行车去学校。', '我去学校').map((x) => x.text), ['自行车']);
  assert.deepEqual(suggestWords([{ id: 'i1', covered: true, refStart: 0, refEnd: 7 }], '骑自行车去学校。', ''), []);
});
