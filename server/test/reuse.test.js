// Reused-phrase WORD CHECK (services/reuse.js) in retell + Q&A: a substituted/omitted script word inside a near-verbatim reuse of a script phrase
// is flagged by CODE (wordStatus 'substituted'/'missed', savedMissed, suggestedWords), caps praise at 'soft' and gets a code-built correction.
// Paraphrases / exact reuse / particle-only differences / STT noise are NEVER flagged.  Fakes only; no network, no keys.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, postAttempt } from './helpers.js';
import { startFakeToneperfect } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';
import { reuseWordDiff, reuseFindings, reuseCorrections, reuseWordStatus } from '../services/reuse.js';
import { planQaCoach, QA_WORD_ZH, QA_ALL_ZH, QA_NEXT_RETRY_ZH, buildQaBlock } from '../services/qa.js';
import { RT_WORD_ZH, RT_ALL_ZH, RT_NEXT_RETRY_ZH } from '../services/retell.js';
import { ASSESSMENT_POLICY } from '../config.js';

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
const ALL_CLEAR = /回答得很好|要点都讲到了|意思都讲到了|很好|完整|全对|都对/;

const PHRASE = '一种不太好驾驭的天赋';
const CHUNK = '他说，这种自我能量是一种不太好驾驭的天赋。';       // 一种不太好驾驭的天赋 = code points 10-20, 驾驭 = 15-17
const STT_BAD = '这种自我能量是一种不太好的谩骂的天赋。';          // the real iPhone transcript (驾驭 -> 谩骂)
const flat = (d) => d.findings.map((f) => [f.kind, f.text, f.heard ?? null, f.confidence, f.start, f.end]);

// ------------------------------------------------------------------------------------------------ pure detection matrix
test('REUSE exact case from the iPhone: 驾驭 -> 谩骂 inside a near-verbatim reuse => substituted, heard 谩骂, high, offsets of 驾驭', () => {
  assert.deepEqual(flat(reuseWordDiff(PHRASE, STT_BAD)), [['substituted', '驾驭', '谩骂', 'high', 5, 7]]);
  assert.deepEqual(flat(reuseWordDiff(CHUNK, STT_BAD)), [['substituted', '驾驭', '谩骂', 'high', 15, 17]]);        // the whole chunk as the reference (retell)
  assert.deepEqual(flat(reuseWordDiff(PHRASE, '這種自我能量是一種不太好的謾罵的天賦。')), [['substituted', '驾驭', '谩骂', 'high', 5, 7]]); // traditional STT output
  const d = reuseWordDiff(PHRASE, STT_BAD); assert.equal(d.regions[0].reuse, true); assert.ok(d.regions[0].longestRun >= ASSESSMENT_POLICY.REUSE_MIN_RUN);
});
test('REUSE near-verbatim vs paraphrase matrix (nothing is flagged unless the script phrase is reused almost verbatim)', () => {
  const none = [
    [PHRASE, PHRASE, 'exact reuse'],
    [PHRASE, '这种自我能量是一种不太好驾驭的天赋。', 'exact reuse inside a longer sentence'],
    [PHRASE, '这种能量是一种很难控制的天赋', 'paraphrase: different words, only 的天赋 shared'],
    [PHRASE, '他有一种天赋，但是很难掌握', 'paraphrase, different order'],
    ['小明放学后回家踢足球', '他下课以后回去踢球', 'paraphrase'],
    ['小明早上起床，骑自行车去学校，在学校学习数学。', '小明早上起来，然后骑车去学校，上课学数学。', 'paraphrase (existing retell wording)'],
    [PHRASE, '一种不太好驾驭天赋', 'particle-only difference: 的 dropped'],
    [PHRASE, '一种不太好驾驭的了天赋', 'particle-only difference: 了 inserted'],
    [PHRASE, '一种不太好架玉的天赋', 'homophone (jia yu): STT noise, counts as a match'],
    ['在学校学习数学', '在学校学数学', 'shortened word 学习 -> 学 is wording, not an omission'],
    ['骑自行车去学校', '他骑车去学校', 'shortened word 自行车 -> 车'],
    [PHRASE, '谢谢观看，下期再见', 'STT hallucination / noise (low overlap)'],
    [PHRASE, '', 'empty'],
    ['他喜欢吃苹果', '他喜欢吃香蕉', 'too short to count as a reused phrase (matched < REUSE_MIN_MATCHED)'],
  ];
  for (const [ref, stt, why] of none) assert.deepEqual(reuseWordDiff(ref, stt).findings, [], `${why}: ${ref} / ${stt}`);
});
test('REUSE inserted extra content word is information only (never a finding); omitted whole content word inside a reused phrase => missed (medium)', () => {
  assert.deepEqual(reuseWordDiff(PHRASE, '这是一种不太好驾驭的非常特别的天赋').findings, []);
  for (const [stt, word] of [['一种不太好驾驭的非常天赋', '非常'], ['一种不太好非常驾驭的天赋', '非常'], ['这是一种不太好真的驾驭的天赋', '真的']]) { const ins = reuseWordDiff(PHRASE, stt); assert.deepEqual(ins.findings, [], stt); assert.deepEqual(ins.inserted, [word], stt); }
  assert.deepEqual(flat(reuseWordDiff(PHRASE, '这是一种不太好的天赋。')), [['missed', '驾驭', null, 'medium', 5, 7]]);
  assert.deepEqual(flat(reuseWordDiff(CHUNK, '这种自我能量是一种不太好的天赋。')), [['missed', '驾驭', null, 'medium', 15, 17]]);
});
test('REUSE confidence: high needs a heard word that shares no character with the script word and verbatim words on BOTH sides; a variant (驾驾/驾驶) is medium; no right-hand anchor = not flagged; edge substitution medium', () => {
  assert.deepEqual(flat(reuseWordDiff(PHRASE, '一种不太好驾驶的天赋')), [['substituted', '驾驭', '驾驶', 'medium', 5, 7]]);
  assert.deepEqual(flat(reuseWordDiff('他说这是一种不太好驾驭', '这是一种不太好谩骂')), [['substituted', '驾驭', '谩骂', 'medium', 9, 11]]);    // edge: only the left anchor
  assert.deepEqual(reuseWordDiff('小明早上起床，骑自行车去学校', '小明早上起来，然后骑自行车去学校').findings, []); // 起床 -> 起来 across a clause boundary: wording
});
test('REUSE thresholds are named constants in ASSESSMENT_POLICY and are honoured (calibration knobs)', () => {
  for (const k of ['REUSE_MIN_RUN', 'REUSE_MIN_MATCHED', 'REUSE_MIN_RATIO', 'REUSE_FLANK_MIN', 'REUSE_MAX_BLOCK', 'REUSE_MAX_FINDINGS']) assert.equal(typeof ASSESSMENT_POLICY[k], 'number', k);
  assert.equal(reuseWordDiff(PHRASE, STT_BAD, { ...ASSESSMENT_POLICY, REUSE_MIN_RUN: 6 }).findings.length, 0);        // stricter run => the same case is no longer "reuse"
  assert.equal(reuseWordDiff(PHRASE, STT_BAD, { ...ASSESSMENT_POLICY, REUSE_MIN_RATIO: 0.95 }).findings.length, 0);
  assert.equal(reuseWordDiff(PHRASE, STT_BAD, { ...ASSESSMENT_POLICY, REUSE_MIN_MATCHED: 9 }).findings.length, 0);
  assert.equal(reuseWordDiff(PHRASE, STT_BAD, { ...ASSESSMENT_POLICY, REUSE_FLANK_MIN: 4 }).findings.length, 0);      // right-hand anchor 的天赋 is only 3 long
  assert.equal(reuseWordDiff(PHRASE, STT_BAD).findings.length, 1);
});
test('reuseFindings over units: offsets = unit base + local offset, chunkIndex/keyPointId carried, ranked high first, capped; corrections are fixed phrases built from the diff only', () => {
  const f = reuseFindings({ units: [{ text: PHRASE, base: 10, chunkIndex: 2, keyPointId: 'k1' }, { text: '他每天早上六点起床', base: 30, chunkIndex: 2, keyPointId: 'k2' }], transcript: STT_BAD });
  assert.deepEqual(f.findings.map((x) => [x.ref, x.kind, x.text, x.heard, x.start, x.end, x.chunkIndex, x.keyPointId, x.pinyin, x.source]), [['reuse:0', 'substituted', '驾驭', '谩骂', 15, 17, 2, 'k1', 'jià yù', 'stt']]);
  const [c] = reuseCorrections(f.findings, { meaningOf: (w) => (w === '驾驭' ? 'to control' : null) });
  assert.deepEqual([c.kind, c.explanationZh, c.modelText, c.start, c.end, c.chunkIndex, c.keyPointId, c.heard, c.meaning, c.factRef], ['substituted', '你说的是“谩骂”，原文是“驾驭”。', '驾驭', 15, 17, 2, 'k1', '谩骂', 'to control', 'reuse:0']);
  const [m] = reuseCorrections(reuseFindings({ units: [{ text: PHRASE }], transcript: '这是一种不太好的天赋' }).findings);
  assert.deepEqual([m.kind, m.explanationZh], ['missing', '好像漏掉了“驾驭”这个词。']);
  const ws = reuseWordStatus(f.findings)[0]; assert.deepEqual([ws.status, ws.heard, ws.source, ws.confidence, ws.start, ws.end, ws.chunkIndex, ws.keyPointId], ['substituted', '谩骂', 'stt', 'high', 15, 17, 2, 'k1']);
});
test('planQaCoach / planRetell: word corrections rank FIRST and the total stays at 2 (3 findings => 2 spoken); never the all-clear', () => {
  const cs = ['甲乙', '丙丁', '戊己'].map((w, i) => ({ kind: 'substituted', targetText: w, start: i, end: i + 2, explanationZh: `你说的是“x${i}”，原文是“${w}”。`, modelText: w, factRef: `reuse:${i}` }));
  const qa = { comparisonStatus: 'ok', answeredQuestion: true, praiseLevel: 'soft', missingKeyPointIds: [] };
  const chk = { keyPoints: [{ id: 'k1', covered: true, confidence: 'high' }], wrongFacts: [] };
  const p = planQaCoach({ qa, chk, question: { modelAnswerZh: '他很好。', keyPoints: [] }, wordCorrections: cs });
  assert.equal(p.corrections.length, 2); assert.deepEqual(p.units.map((u) => u.kind), ['opener', 'correction', 'correction_model', 'correction', 'correction_model', 'next']);
  assert.equal(p.units[0].text, QA_WORD_ZH); assert.equal(p.units.at(-1).text, QA_NEXT_RETRY_ZH); assert.ok(p.units.every((u) => !ALL_CLEAR.test(u.text.replace(/原文是.*$/, ''))));
  assert.ok(buildQaBlock({ chk: { status: 'ok', keyPoints: [{ id: 'k1', textZh: '一二三四', refStart: 0, refEnd: 4, chunkIndex: 0, covered: true, evidence: 'x', confidence: 'high' }], wrongFacts: [], answeredQuestion: true, answerKind: 'answered' },
    question: { questionId: 'q1', modelAnswerZh: 'm', keyPoints: [] }, transcript: 't', tone: { status: 'skipped' }, meaningOf: () => null, wordFindings: [{ kind: 'substituted', text: '驾驭', pinyin: 'jià yù' }] }).canPraise === false);
});

// ------------------------------------------------------------------------------------------------ Q&A path
const NEXT = (over = {}) => ({ type: 'what', questionZh: '他说这种自我能量是什么？', keyPoints: [{ refQuote: PHRASE }], modelAnswerZh: '这是一种不太好驾驭的天赋。', hintZh: '想一想他怎么形容这种能量。', ...over });
const isNext = (j) => j.messages[0].content.includes('ONE spoken');
const CHECK = (ev1 = '一种不太好的谩骂的天赋', over = {}) => ({ answeredQuestion: true, keyPoints: [{ id: 'k1', covered: true, evidence: ev1, confidence: 'high' }], wrongFacts: [], ...over });
const llm = ({ next = NEXT(), check = CHECK() } = {}) => (j) => JSON.stringify(isNext(j) ? next : check);
async function getQuestion(t, over = {}, chunks = [CHUNK]) { svc.state.chatScript = llm(over); const r = await t.api('POST', '/api/qa/next', { chunks }); assert.equal(r.status, 200, r.text); return r.json; }
async function postQa(t, q, fields = {}) {
  const form = new FormData(); form.append('audio', new Blob([Buffer.alloc(2000, 7)], { type: 'audio/mp4' }), 'rec.m4a');
  for (const [k, v] of Object.entries({ question: JSON.stringify(q), attemptId: 'qa-' + Math.random().toString(36).slice(2, 12), ...fields })) form.append(k, v);
  const res = await fetch(t.base + '/api/qa/attempt', { method: 'POST', body: form, headers: { Cookie: t.cookie() } });
  const text = await res.text(); const events = [];
  for (const block of text.split('\n\n')) { const m = /^event: (\w+)\ndata: (.*)$/ms.exec(block.trim()); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); }
  return { status: res.status, events, text };
}
const qaAnswer = async (t, q, stt, check, fields) => { svc.state.sttText = stt; svc.state.chatScript = llm({ check }); return postQa(t, q, fields); };

test('Q&A REGRESSION (iPhone): key point 一种不太好驾驭的天赋, transcript 谩骂 for 驾驭, LLM says covered => substituted 驾驭, no praise, exact words named, saved, offsets in the chunk', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); assert.deepEqual([q.keyPoints[0].textZh, q.keyPoints[0].refStart, q.keyPoints[0].refEnd], [PHRASE, 10, 20]);
    const r = await qaAnswer(t, q, STT_BAD, CHECK(), { chunkText: CHUNK });
    assert.equal(r.status, 200, r.text); const [a] = ev(r, 'assessment'); const Q = a.qa;
    assert.equal(Q.keyPoints[0].covered, true, 'the meaning check is unchanged (own wording is allowed)');
    assert.deepEqual([Q.canPraise, Q.praiseLevel, Q.praiseBlockedBy, a.facts.canPraise, Q.wordCheck], [false, 'soft', ['word_check'], false, { status: 'found', count: 1 }]);
    assert.deepEqual(a.wordStatus, [{ start: 15, end: 17, text: '驾驭', pinyin: 'jià yù', status: 'substituted', heard: '谩骂', source: 'stt', confidence: 'high',
      detail: a.wordStatus[0].detail, reuse: true, chunkIndex: 0, keyPointId: 'k1' }]);
    assert.equal(Array.from(CHUNK).slice(15, 17).join(''), '驾驭');
    assert.deepEqual(a.facts.substitutedWords.map((w) => [w.text, w.heard, w.start, w.end, w.confidence, w.chunkIndex]), [['驾驭', '谩骂', 15, 17, 'high', 0]]);
    assert.deepEqual([a.facts.completeness, a.facts.canPraise], ['incomplete', false]);
    assert.deepEqual(Q.suggestedWords[0], { text: '驾驭', pinyin: 'jià yù', meaning: null, keyPointId: 'k1', reason: 'substituted' });
    assert.deepEqual(a.savedMissed.map((w) => [w.text, w.reason, w.start, w.end, w.isNew]), [['驾驭', 'substituted', 15, 17, true]]);
    const saved = t.db.listMissed(); assert.equal(saved.length, 1); assert.equal(saved[0].text, '驾驭'); assert.equal(saved[0].sourceChunk, CHUNK);
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'next']);
    assert.deepEqual(lines(r), [QA_WORD_ZH, '你说的是“谩骂”，原文是“驾驭”。', '应该这样说：驾驭', QA_NEXT_RETRY_ZH]);
    assert.ok(lines(r).every((l) => !l.includes('回答得很好') && !l.includes('要点都讲到了')) && !lines(r).includes(QA_ALL_ZH));
    const cc = ev(r, 'coach_text')[1]; assert.deepEqual([cc.start, cc.end, cc.caption], [15, 17, '驾驭 jià yù']);
    const [d] = ev(r, 'done'); assert.deepEqual(d.corrections.map((c) => [c.kind, c.targetText, c.heard, c.start, c.end, c.chunkIndex, c.keyPointId, c.factRef, c.source]), [['substituted', '驾驭', '谩骂', 15, 17, 0, 'k1', 'reuse:0', 'server_fact']]);
    assert.equal(d.summary.canPraise, false); assert.equal(d.summary.wordFindings, 1);
  } finally { await t.close(); }
});
test('Q&A saved word: sourceChunk = key point text without chunkText, a forged chunkText is ignored, a repeat bumps missCount', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    await qaAnswer(t, q, STT_BAD, CHECK()); assert.equal(t.db.listMissed()[0].sourceChunk, PHRASE);
    await qaAnswer(t, q, STT_BAD, CHECK(), { chunkText: '完全不同的文字，没有这个要点。' }); const w = t.db.listMissed(); assert.equal(w.length, 1); assert.equal(w[0].sourceChunk, PHRASE); assert.equal(w[0].missCount, 2);
  } finally { await t.close(); }
});
test('Q&A exact verbatim reuse => NOT flagged, praise still allowed, nothing saved', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t); const r = await qaAnswer(t, q, '这种自我能量是一种不太好驾驭的天赋。', CHECK('一种不太好驾驭的天赋'));
    const [a] = ev(r, 'assessment'); assert.deepEqual([a.qa.canPraise, a.qa.praiseLevel, a.wordStatus, a.savedMissed], [true, 'full', [], []]); assert.equal(a.qa.praiseBlockedBy, undefined);
    assert.equal(lines(r)[0], QA_ALL_ZH); assert.equal(t.db.listMissed().length, 0);
  } finally { await t.close(); }
});
test('Q&A pure paraphrase (own wording, no reuse) => NOT flagged; particle-only difference => NOT flagged; extra content word => NOT flagged', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    for (const [stt, ev1] of [['他说这是一种很难控制的能力。', '一种很难控制的能力'], ['这种自我能量是一种不太好驾驭天赋。', '一种不太好驾驭天赋'], ['这种自我能量是一种不太好驾驭的非常特别的天赋。', '一种不太好驾驭的非常特别的天赋']]) {
      const r = await qaAnswer(t, q, stt, CHECK(ev1)); const [a] = ev(r, 'assessment');
      assert.deepEqual([a.wordStatus, a.savedMissed, a.qa.praiseLevel, a.qa.canPraise], [[], [], 'full', true], stt);
    }
    assert.equal(t.db.listMissed().length, 0);
  } finally { await t.close(); }
});
test('Q&A omitted whole content word inside the reused phrase => missed (medium), named, no praise; traditional-character STT behaves like simplified; noise does not create flags', async () => {
  const t = await server(envOai());
  try {
    const q = await getQuestion(t);
    let r = await qaAnswer(t, q, '这种自我能量是一种不太好的天赋。', CHECK('一种不太好的天赋')); let [a] = ev(r, 'assessment');
    assert.deepEqual(a.wordStatus.map((w) => [w.status, w.text, w.reason, w.confidence, w.start, w.end]), [['missed', '驾驭', 'omitted', 'medium', 15, 17]]); assert.equal(a.qa.canPraise, false);
    assert.deepEqual(lines(r).slice(0, 3), [QA_WORD_ZH, '好像漏掉了“驾驭”这个词。', '应该这样说：驾驭']);
    r = await qaAnswer(t, q, '這種自我能量是一種不太好的謾罵的天賦。', CHECK('一種不太好的謾罵的天賦')); [a] = ev(r, 'assessment');
    assert.deepEqual(a.wordStatus.map((w) => [w.status, w.text, w.heard]), [['substituted', '驾驭', '谩骂']]); assert.equal(a.transcript, STT_BAD);
    r = await qaAnswer(t, q, '谢谢大家观看，我们下期再见。', CHECK(null, { answeredQuestion: false, keyPoints: [{ id: 'k1', covered: false, evidence: null, confidence: 'high' }] })); [a] = ev(r, 'assessment');
    assert.deepEqual([a.wordStatus, a.savedMissed], [[], []]);
  } finally { await t.close(); }
});
test('Q&A: a word finding ranks first and shares the 2-correction cap with a missing key point; wording of the other key point stays meaning-only', async () => {
  const t = await server(envOai());
  try {
    const chunk = '他说，这种自我能量是一种不太好驾驭的天赋，他每天早上六点起床。';
    const q = await getQuestion(t, { next: NEXT({ questionZh: '他说了什么？', keyPoints: [{ refQuote: PHRASE }, { refQuote: '他每天早上六点起床' }], modelAnswerZh: '这是一种不太好驾驭的天赋，他每天早上六点起床。' }) }, [chunk]);
    const r = await qaAnswer(t, q, STT_BAD, { answeredQuestion: true, keyPoints: [{ id: 'k1', covered: true, evidence: '一种不太好的谩骂的天赋', confidence: 'high' }, { id: 'k2', covered: false, evidence: null, confidence: 'high' }], wrongFacts: [] });
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'correction', 'correction_model', 'next']);
    assert.equal(lines(r)[1], '你说的是“谩骂”，原文是“驾驭”。'); assert.match(lines(r)[3], /^漏掉了这个要点：他每天早上六点起床/);
    assert.equal(ev(r, 'done')[0].corrections.length, 2);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------------------------------------ retell path
const cmpJson = (evidence = '一种不太好的谩骂的天赋') => JSON.stringify({ ideas: [{ id: 'i1', textZh: PHRASE, refQuote: PHRASE, covered: true, evidence, confidence: 'high' }], corrections: [], summaryZh: '你用自己的话讲清楚了。' });
const retell = (t, over = {}) => postAttempt(t, { fields: { assessMode: 'retell', practiceMode: 'fading_cues', chunkText: CHUNK, ...over } });

test('RETELL REGRESSION: same case => substituted 驾驭 in wordStatus/facts/savedMissed/suggestedWords, praise capped at soft, exact words named, no all-clear', async () => {
  svc.state.sttText = STT_BAD; svc.state.chatScript = cmpJson();
  const t = await server(envOai());
  try {
    const r = await retell(t); assert.equal(r.status, 200, r.text); const [a] = ev(r, 'assessment'); const R = a.retell;
    assert.equal(R.ideas[0].covered, true);
    assert.deepEqual([R.canPraise, R.praiseLevel, R.praiseBlockedBy, a.facts.canPraise, a.facts.completeness], [false, 'soft', ['word_check'], false, 'incomplete']);
    assert.deepEqual(a.wordStatus.map((w) => [w.start, w.end, w.text, w.status, w.heard, w.source, w.confidence, w.chunkIndex]), [[15, 17, '驾驭', 'substituted', '谩骂', 'stt', 'high', undefined]]);
    assert.deepEqual(a.savedMissed.map((w) => [w.text, w.reason, w.start, w.end]), [['驾驭', 'substituted', 15, 17]]);
    assert.deepEqual([R.suggestedWords[0].text, R.suggestedWords[0].reason, R.suggestedWords[0].ideaId], ['驾驭', 'substituted', 'i1']);
    const saved = t.db.listMissed(); assert.deepEqual(saved.map((w) => [w.text, w.sourceChunk]), [['驾驭', CHUNK]]);
    assert.deepEqual(roles(r), ['opener', 'correction', 'correction_model', 'next']);
    assert.deepEqual(lines(r), [RT_WORD_ZH, '你说的是“谩骂”，原文是“驾驭”。', '应该这样说：驾驭', RT_NEXT_RETRY_ZH]);
    assert.ok(!lines(r).includes(RT_ALL_ZH) && lines(r).every((l) => !ALL_CLEAR.test(l.replace(/原文是.*$/, ''))));
    const [d] = ev(r, 'done'); assert.deepEqual(d.corrections.map((c) => [c.kind, c.targetText, c.heard, c.start, c.end]), [['substituted', '驾驭', '谩骂', 15, 17]]);
  } finally { await t.close(); }
});
test('RETELL exact reuse and plain paraphrase are not flagged (praise unchanged); close mode and drills do not get reuse findings', async () => {
  const t = await server(envOai());
  try {
    svc.state.sttText = '这种自我能量是一种不太好驾驭的天赋。'; svc.state.chatScript = cmpJson('一种不太好驾驭的天赋');
    let r = await retell(t); let [a] = ev(r, 'assessment'); assert.deepEqual([a.retell.canPraise, a.retell.praiseLevel, a.wordStatus, a.savedMissed], [true, 'full', [], []]); assert.equal(lines(r)[0], RT_ALL_ZH);
    svc.state.sttText = '他说这是一种很难控制的能力。'; svc.state.chatScript = cmpJson('一种很难控制的能力');
    r = await retell(t); [a] = ev(r, 'assessment'); assert.deepEqual([a.retell.praiseLevel, a.wordStatus], ['full', []]);
    assert.equal(t.db.listMissed().length, 0);
    // close mode (script basis): wordStatus is still the per-character STT/acoustic analysis, reuse never applies
    svc.state.sttText = STT_BAD; r = await postAttempt(t, { fields: { chunkText: '这种自我能量是一种不太好驾驭的天赋。', practiceMode: 'listen_repeat' } });
    [a] = ev(r, 'assessment'); assert.equal(a.basis, 'script'); assert.ok(a.wordStatus.length > 10); assert.ok(a.wordStatus.every((w) => w.reuse === undefined));
  } finally { await t.close(); }
});
test('RETELL / Q&A persist NOTHING but the word itself: no transcript, heard text or audio in the DB', async () => {
  const t = await server(envOai());
  try {
    svc.state.sttText = STT_BAD; svc.state.chatScript = cmpJson(); await retell(t);
    const q = await getQuestion(t); await qaAnswer(t, q, STT_BAD, CHECK());
    const tables = t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => x.name);
    const dump = JSON.stringify(tables.map((n) => [n, t.db.raw.prepare(`select * from ${n}`).all()]));
    assert.ok(dump.includes('驾驭')); assert.ok(!dump.includes('谩骂') && !dump.includes('自我能量是一种不太好的') && !dump.includes('Buffer'), 'transcript / heard text must never be stored');
    assert.equal(t.db.listMissed().length, 1); assert.equal(t.db.listMissed()[0].missCount, 2);
  } finally { await t.close(); }
});
