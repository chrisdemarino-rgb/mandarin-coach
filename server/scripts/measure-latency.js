// End-to-end latency measurement of POST /api/attempt using REAL OpenAI STT/LLM/TTS calls and a CACHED TonePerfect result
// replayed after a SIMULATED delay (default 2000 ms; real TonePerfect elapsedMs in the cached fixtures were 1435-2322 ms).
// Usage: node server/scripts/measure-latency.js <tag> [--runs 2] [--tp-delay 2000]
// Output: test-results/LATENCY-<tag>.json + a table on stdout. Never prints keys or transcript/coach content.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadDotEnv, loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { withPolicy } from '../engines/assessment/policy.js';
import { createApp } from '../app.js';
import { createServices } from '../services/index.js';
import { FIXED_PHRASES_ZH } from '../services/coach.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
loadDotEnv();
if (!process.argv.includes('--no-keepalive')) { try { const { setGlobalDispatcher, Agent } = await import('undici'); setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 })); } catch { /* default */ } } // same as server/index.js
const tag = process.argv[2] || 'run';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const RUNS = arg('--runs', 2); const TP_DELAY = arg('--tp-delay', 2000);

const SCENARIOS = [
  { name: 'clean-04 (listen_repeat)', rec: 'recordings/04-xihuan-zhongwen-correct.m4a', fx: '04-xihuan-zhongwen-correct', chunk: '我喜欢学中文', practiceMode: 'listen_repeat' },
  { name: 'wrong-tone-05 (listen_repeat)', rec: 'recordings/05-xihuan-zhongwen-wrong-tone.m4a', fx: '05-xihuan-zhongwen-wrong-tone', chunk: '我喜欢学中文', practiceMode: 'listen_repeat' },
  { name: 'omitted-word-09 (listen_repeat)', rec: 'trimmed/09-omit-xue-middle.m4a', fx: '09-omit-xue-middle', chunk: '我喜欢学中文', practiceMode: 'listen_repeat' },
];

const cfg = loadConfig({ ...process.env, ...(process.argv.includes('--llm-tone') ? { COACH_LLM_TONE: '1' } : {}), NODE_ENV: 'test', APP_PASSCODE: 'measure-pass', DATA_DIR: '', PORT: '0', PUBLIC_DIR: '/nonexistent' });
const db = openDb(':memory:');
const services = createServices(cfg);
let current;
const engine = withPolicy({ name: 'toneperfect', mock: false, available: () => true, async assess() {
  await new Promise((r) => setTimeout(r, TP_DELAY));
  return structuredClone(JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/real-clips', `${current.fx}.json`), 'utf8')).result);
} }, cfg.policy);
const app = createApp({ cfg, db, engine, services });
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'measure-pass' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];

async function once(sc) {
  current = sc;
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(path.join(root, 'test-results', sc.rec))], { type: 'audio/mp4' }), 'rec.m4a');
  const speed = 0.9 + Math.floor(Math.random() * 1000) / 10000; // unique speed per run => defeats the TTS cache, so the per-take lines (the missed word etc.) are always cold
  if (!process.argv.includes('--no-warm')) await services.tts.warm({ phrases: FIXED_PHRASES_ZH, speed }); // = what the server does at startup for the saved voice/speed: fixed lines are cache hits
  const f = { chunkText: sc.chunk, assessMode: 'close', practiceMode: sc.practiceMode, attemptId: 'm-' + Math.random().toString(36).slice(2, 12), speed: String(speed) };
  for (const [k, v] of Object.entries(f)) form.append(k, v);
  const res = await fetch(base + '/api/attempt', { method: 'POST', body: form, headers: { Cookie: cookie } });
  const t0 = Date.now(); const at = {}; let buf = ''; let done = null; let kinds = [];
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const blk = buf.slice(0, i); buf = buf.slice(i + 2);
      const m = /^event: (\w+)\ndata: (.*)$/s.exec(blk); if (!m) continue;
      const ev = m[1]; const now = Date.now() - t0; const d = JSON.parse(m[2]);
      at[ev] ??= now; if (ev === 'coach_text') kinds.push(d.role);
      if (ev === 'done') done = d;
    }
  }
  return { sc: sc.name, firstAssessmentMs: at.assessment, firstCoachTextMs: at.coach_text, firstCoachAudioMs: at.coach_audio, doneMs: at.done, serverTimings: done?.timings ?? done?.summary?.timings ?? null, roles: kinds.join(',') };
}
const out = [];
for (const sc of SCENARIOS) for (let i = 0; i < RUNS; i++) { const r = await once(sc); out.push(r); console.log(JSON.stringify(r)); }
fs.writeFileSync(path.join(root, 'test-results', `LATENCY-${tag}.json`), JSON.stringify({ tag, tpDelaySimulatedMs: TP_DELAY, note: 'TonePerfect is a cached result replayed after a SIMULATED delay; OpenAI STT/LLM/TTS are real calls. Client-side ms measured from the end of the upload.', coachModel: cfg.openai.coachModel, results: out }, null, 1));
server.close(); db.close();
