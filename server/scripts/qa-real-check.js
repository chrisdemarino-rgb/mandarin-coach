// Real end-to-end check of Q&A mode: REAL OpenAI LLM (question generation + answer check), REAL STT, REAL TTS (learner audio + coach audio).
// TonePerfect is NEVER called: the engine is a SYNTHETIC result built from the transcript, replayed after a SIMULATED delay.
// Usage: node server/scripts/qa-real-check.js [--tp-delay 2000] [--nexts 6] [--write-fixtures]
// Writes test-results/QA-REAL.json (+ test/fixtures/qa/*.json with --write-fixtures: raw LLM JSON + chunk/transcript, no keys, no audio). Never prints keys.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pinyin } from 'pinyin-pro';
import { loadDotEnv, loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { withPolicy } from '../engines/assessment/policy.js';
import { createApp } from '../app.js';
import { createServices } from '../services/index.js';
import { RETELL_PHRASES_ZH } from '../services/retell.js';
import { QA_PHRASES_ZH } from '../services/qa.js';
import { FIXED_PHRASES_ZH } from '../services/coach.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
loadDotEnv();
try { const { setGlobalDispatcher, Agent } = await import('undici'); setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 })); } catch { /* optional */ }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TP_DELAY = arg('--tp-delay', 2000); const NEXTS = arg('--nexts', 6); const WRITE = process.argv.includes('--write-fixtures');

export const CHUNKS = [
  '小明每天早上六点半起床，因为学校离家很远。他骑自行车去学校，路上要二十分钟。',
  '他的老师姓王，是一位很和气的女老师。她教小明数学，下课以后常常帮同学解答问题。',
  '下午放学以后，小明回家踢足球，因为他最喜欢足球。晚上他和妈妈一起做饭。',
];
const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', APP_PASSCODE: 'measure-pass', DATA_DIR: '', PORT: '0', PUBLIC_DIR: '' });
if (!cfg.openai.apiKey) { console.error('OPENAI_API_KEY not configured'); process.exit(2); }
const db = openDb(':memory:');
const services = createServices(cfg);
let captured = [];
const origJson = services.llm.chatJson.bind(services.llm);
services.llm = { ...services.llm, available: services.llm.available, chatStream: services.llm.chatStream, chatJson: async (o) => { const r = await origJson(o); captured.push(structuredClone(r)); return r; } };

const engine = withPolicy({ name: 'toneperfect', mock: false, available: () => true, async assess({ chunkText }) {
  await new Promise((r) => setTimeout(r, TP_DELAY)); // SIMULATED TonePerfect latency; result is synthetic (all tones 'no_correction')
  const chars = [...chunkText]; let t = 0;
  const syllables = chars.map((c, i) => { const py = pinyin(c, { toneType: 'num', type: 'array' })[0] || 'a1'; const tone = Number(/\d$/.exec(py)?.[0] || 5); const o = { index: i, char: c, pinyin: py, wordIndex: i, startMs: t, endMs: t + 250,
    initial: { expected: null, heard: null, score: null, decision: 'no_decision' }, final: { expected: null, heard: null, score: null, decision: 'no_decision' }, tone: { expected: tone, heard: tone, score: 85, decision: 'no_correction' } }; t += 250; return o; });
  return { engine: 'toneperfect', mock: false, modelVersion: 'SYNTHETIC', status: 'ok', overall: 88, scores: { overall: 88, pronunciation: 88, initial: 88, final: 88, tone: 85 }, syllables,
    words: chars.map((c, i) => ({ text: c, score: 88, startMs: i * 250, endMs: i * 250 + 250 })), warnings: [], meta: { requestId: 'synthetic', task: 'connected_speech', creditsCharged: 0, balanceCredits: 0 } };
} }, cfg.policy);
const app = createApp({ cfg, db, engine, services });
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'measure-pass' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
fs.mkdirSync(path.join(root, 'test-results/qa-audio'), { recursive: true }); fs.mkdirSync(path.join(root, 'test/fixtures/qa'), { recursive: true });
const report = { tpDelaySimulatedMs: TP_DELAY, note: 'TonePerfect = SYNTHETIC result replayed after SIMULATED delay; OpenAI STT/LLM/TTS are real.', nexts: [], attempts: [] };
const span = (c, k) => Array.from(CHUNKS[c]).slice(k.refStart, k.refEnd).join('');

// ---- 1. /next x N with an accumulating avoid list ------------------------------------------------------------------------------------------------
const asked = []; const nextFixtures = [];
for (let i = 0; i < NEXTS; i++) {
  captured = []; const t0 = Date.now();
  const res = await post('/api/qa/next', { chunks: CHUNKS, avoid: asked.flatMap((q) => [q.questionId, q.questionZh]) });
  const ms = Date.now() - t0; const j = await res.json();
  if (!res.ok) { console.log('NEXT HTTP', res.status, JSON.stringify(j.error)); report.nexts.push({ status: res.status, error: j.error, ms }); continue; }
  asked.push(j);
  const row = { i, ms, type: j.type, sourceChunkIndex: j.sourceChunkIndex, questionZh: j.questionZh, keyPoints: j.keyPoints.map((k) => ({ id: k.id, textZh: k.textZh, spanFromOffsets: span(j.sourceChunkIndex, k), offsetsOk: span(j.sourceChunkIndex, k) === k.textZh })), modelAnswerZh: j.modelAnswerZh, hintZh: j.hintZh, repeated: !!j.repeated, serverTimings: j.timings };
  report.nexts.push(row); console.log(JSON.stringify(row));
  if (WRITE && captured[0]) nextFixtures.push({ chunk: CHUNKS[j.sourceChunkIndex], chunkIndex: j.sourceChunkIndex, preferredType: null, avoidCount: asked.length - 1, llmRaw: captured[0], resultType: j.type, resultQuestionId: j.questionId });
}
if (WRITE) fs.writeFileSync(path.join(root, 'test/fixtures/qa/next-real.json'), JSON.stringify({ note: 'raw gpt question JSON for CHUNKS (scripts/qa-real-check.js); replayed through validateNext in tests', chunks: CHUNKS, items: nextFixtures }, null, 1));

// ---- 2. attempts: learner audio (TTS) for good / partial / wrong / off-topic / don't know ---------------------------------------------------
const q = asked.find((x) => x.keyPoints.length >= 2) || asked[0];
if (!q) { console.error('no question to attempt'); process.exit(1); }
captured = [];
const gen = await services.llm.chatJson({ model: cfg.openai.qaModel, temperature: 0.5, maxTokens: 400, messages: [
  { role: 'system', content: 'You role-play a Mandarin learner (HSK3). Given a question, its correct key points and the correct answer, write SHORT spoken answers (1-2 sentences, max 40 characters each). JSON only: {"good":"correct, in your OWN different wording","partial":"states only the FIRST key point, nothing else","wrong":"answers the question but with a wrong fact that contradicts a key point","offtopic":"talks about something unrelated"}' },
  { role: 'user', content: JSON.stringify({ question: q.questionZh, keyPoints: q.keyPoints.map((k) => k.textZh), correctAnswer: q.modelAnswerZh }) }] });
const answers = { ...gen, dont_know: '我不知道，我不太清楚这个问题。' };
console.log('QUESTION', q.questionZh, '| key points:', q.keyPoints.map((k) => k.textZh).join(' / '));
const dec = new TextDecoder(); const attemptFixtures = [];
for (const [name, text] of Object.entries(answers)) {
  if (typeof text !== 'string') continue;
  const tts = await services.tts.synthesize({ text, speed: 1 }); const f = path.join(root, 'test-results/qa-audio', name + '.mp3'); fs.writeFileSync(f, tts.buf);
  await services.tts.warm({ phrases: [...FIXED_PHRASES_ZH, ...RETELL_PHRASES_ZH, ...QA_PHRASES_ZH], speed: 1 });
  captured = [];
  const form = new FormData(); form.append('audio', new Blob([tts.buf], { type: 'audio/mpeg' }), 'rec.mp3');
  form.append('question', JSON.stringify(q)); form.append('attemptId', 'qr-' + Math.random().toString(36).slice(2, 12));
  const t0 = Date.now(); const res = await fetch(base + '/api/qa/attempt', { method: 'POST', body: form, headers: { Cookie: cookie } });
  const at = {}; let buf = ''; let assessment = null; let done = null; let err = null; const lines = [];
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: (\w+)\ndata: (.*)$/s.exec(blk); if (!m) continue;
      const d = JSON.parse(m[2]); at[m[1]] ??= Date.now() - t0;
      if (m[1] === 'assessment') assessment = d; if (m[1] === 'done') done = d; if (m[1] === 'error') err = d; if (m[1] === 'coach_text') lines.push(`${d.role}: ${d.delta}`);
    }
  }
  const Q = assessment?.qa;
  const row = { scenario: name, said: text, ms: { assessment: at.assessment, firstCoachText: at.coach_text, firstCoachAudio: at.coach_audio, done: at.done }, timings: done?.timings, error: err?.code ?? null, transcript: Q?.transcript,
    comparisonStatus: Q?.comparisonStatus, answeredQuestion: Q?.answeredQuestion, answerKind: Q?.answerKind, coveredCount: Q?.coveredCount, totalCount: Q?.totalCount, canPraise: Q?.canPraise, praiseLevel: Q?.praiseLevel, tone: Q?.tone,
    keyPoints: Q?.keyPoints?.map((k) => ({ id: k.id, covered: k.covered, confidence: k.confidence, evidence: k.evidence, ...(k.issue ? { issue: k.issue } : {}) })), wrongFacts: Q?.wrongFacts, dropped: done?.summary?.droppedClaims, attempts: done?.summary?.checkAttempts, coach: lines };
  report.attempts.push(row); console.log(JSON.stringify(row, null, 1));
  if (WRITE && Q && captured.at(-1)) attemptFixtures.push({ name, question: { keyPoints: q.keyPoints, questionZh: q.questionZh, modelAnswerZh: q.modelAnswerZh }, transcript: Q.transcript, llmRaw: captured.at(-1) });
}
if (WRITE) fs.writeFileSync(path.join(root, 'test/fixtures/qa/check-real.json'), JSON.stringify({ note: 'raw gpt answer-check JSON for TTS learner answers (scripts/qa-real-check.js); replayed through validateCheck in tests', items: attemptFixtures }, null, 1));
fs.writeFileSync(path.join(root, 'test-results', 'QA-REAL.json'), JSON.stringify(report, null, 1));
server.close(); db.close();
