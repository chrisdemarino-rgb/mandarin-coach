// Real end-to-end check of Free talk: REAL OpenAI LLM (reply stream + correction finder + opening + summary), REAL STT, REAL TTS (learner audio + coach audio).
// TonePerfect is NEVER called (tone flag off; the engine here throws if it is touched).
// Usage: node server/scripts/talk-real-check.js [--write-fixtures] [--runs 1]
// Writes test-results/TALK-REAL.json (+ test/fixtures/talk/real.json with --write-fixtures: transcripts + raw LLM JSON, no keys, no audio). Never prints keys.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadDotEnv, loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { createServices } from '../services/index.js';
import { FIXED_PHRASES_ZH } from '../services/coach.js';
import { TALK_PHRASES_ZH } from '../services/talk.js';

const here = path.dirname(url.fileURLToPath(import.meta.url)); const root = path.join(here, '..');
loadDotEnv();
try { const { setGlobalDispatcher, Agent } = await import('undici'); setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 })); } catch { /* optional */ }
const WRITE = process.argv.includes('--write-fixtures'); const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', APP_PASSCODE: 'measure-pass', DATA_DIR: '', PORT: '0', PUBLIC_DIR: '' });
if (!cfg.openai.apiKey) { console.error('OPENAI_API_KEY not configured'); process.exit(2); }
const db = openDb(':memory:'); const services = createServices(cfg);
let captured = [];
const origJson = services.llm.chatJson.bind(services.llm); const origStream = services.llm.chatStream.bind(services.llm);
services.llm = { ...services.llm, available: services.llm.available,
  chatJson: async (o) => { const r = await origJson(o); captured.push({ kind: marker(o), raw: structuredClone(r) }); return r; },
  chatStream: async function* (o) { let all = ''; for await (const d of origStream(o)) { all += d; yield d; } captured.push({ kind: marker(o), raw: all }); } };
const marker = (o) => /TALK_(\w+)/.exec(o.messages?.[0]?.content || '')?.[1] || '?';
const engine = { name: 'toneperfect', mock: false, available: () => true, async assess() { throw new Error('TonePerfect must never be called by this script'); } };
const app = createApp({ cfg, db, engine, services });
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'measure-pass' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true }); fs.mkdirSync(path.join(root, 'test/fixtures/talk'), { recursive: true });

const TOPIC = '我的周末'; const VOCAB = [{ text: '爬山' }, { text: '风景' }, { text: '放松' }, { text: '周末' }, { text: '计划' }];
const SCENARIOS = [
  { name: 'grammar_error', said: '我昨天去了公园玩，然后我吃了东西很多，我觉得很高兴非常。', expect: 'a correction is welcome (clear errors)' },
  { name: 'english_mixed', said: '周末我喜欢去 hiking，山上的 scenery 很漂亮，但是我不知道 scenery 用中文怎么说。', expect: 'english_gap correction, not an error' },
  { name: 'natural_1', said: '周末我常常和朋友去爬山，山上的风景特别美，爬完山我们一起吃饭。', expect: 'NO correction' },
  { name: 'natural_2', said: '上个周末我在家休息，看了一部电影，晚上还给我妈妈打了电话。', expect: 'NO correction' },
  { name: 'natural_3', said: '我最近在学做饭，昨天做了西红柿炒鸡蛋，味道还不错。', expect: 'NO correction' },
  { name: 'noise_hallucination', said: '嗯。', expect: 'gate (fixed line), no LLM' },
];
const report = { note: 'OpenAI STT/LLM/TTS are real; TonePerfect never called (tone flag off).', opening: null, turns: [], summary: null };
await services.tts.warm({ phrases: [...FIXED_PHRASES_ZH, ...TALK_PHRASES_ZH], speed: 1 });

// ---- opening
captured = []; let t0 = Date.now();
const o = await (await post('/api/talk/opening?audio=1', { topic: TOPIC, scriptVocab: VOCAB, level: 'normal' })).json();
report.opening = { ms: Date.now() - t0, ...o }; console.log('OPENING', JSON.stringify(report.opening));
const session = [{ role: 'coach', text: o.textZh }]; const fixtures = [];
const dec = new TextDecoder();
for (let run = 0; run < RUNS; run++) for (const sc of SCENARIOS) {
  const tts = await services.tts.synthesize({ text: sc.said, speed: 1 });
  captured = [];
  const form = new FormData(); form.append('audio', new Blob([tts.buf], { type: 'audio/mpeg' }), 'rec.mp3');
  form.append('context', JSON.stringify({ topic: TOPIC, scriptVocab: VOCAB, turns: session.slice(-6), level: 'normal' })); form.append('attemptId', 'tr-' + Math.random().toString(36).slice(2, 12));
  t0 = Date.now(); const res = await fetch(base + '/api/talk/turn', { method: 'POST', body: form, headers: { Cookie: cookie } });
  const at = {}; let buf = ''; let done = null; let err = null; let transcript = null; const lines = [];
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: (\w+)\ndata: (.*)$/s.exec(blk); if (!m) continue;
      const d = JSON.parse(m[2]); at[m[1]] ??= Date.now() - t0;
      if (m[1] === 'done') done = d; if (m[1] === 'error') err = d; if (m[1] === 'transcript') transcript = d; if (m[1] === 'coach_text') lines.push(`${d.role}: ${d.delta}`);
    }
  }
  const row = { scenario: sc.name, expect: sc.expect, said: sc.said, transcript: transcript?.text, sttStatus: transcript?.sttStatus, lines, correction: done?.correction ?? null, correctionStatus: done?.correctionStatus, suggestedWords: done?.suggestedWords,
    vocabHints: done?.vocabHints, error: err?.code ?? null, sseMs: { transcript: at.transcript, firstCoachText: at.coach_text, firstCoachAudio: at.coach_audio, done: at.done }, timings: done?.timings, droppedClaims: done?.summary?.droppedClaims };
  report.turns.push(row); console.log(JSON.stringify(row, null, 1));
  if (WRITE && transcript && captured.length) fixtures.push({ name: sc.name, said: sc.said, transcript: transcript.text, scriptVocab: VOCAB.map((v) => v.text), llm: captured });
  if (run === 0 && transcript?.text && !done?.gate) { session.push({ role: 'user', text: transcript.text }); if (done?.replyZh) session.push({ role: 'coach', text: [done.replyZh, done.questionZh].filter(Boolean).join('') }); }
}
// ---- summary
captured = []; t0 = Date.now();
const sres = await post('/api/talk/summary', { topic: TOPIC, turns: session, scriptVocab: VOCAB, level: 'normal' }); const sj = await sres.json();
report.summary = { status: sres.status, ms: Date.now() - t0, ...sj }; console.log('SUMMARY', JSON.stringify(report.summary, null, 1));
if (WRITE) { fixtures.push({ name: 'summary', session, llm: captured }); fs.writeFileSync(path.join(root, 'test/fixtures/talk/real.json'), JSON.stringify({ note: 'transcripts (real STT of TTS learner audio) + raw gpt JSON/text from scripts/talk-real-check.js; replayed through validators in tests', items: fixtures }, null, 1)); }
fs.writeFileSync(path.join(root, 'test-results', 'TALK-REAL.json'), JSON.stringify(report, null, 1));
server.close(); db.close();
