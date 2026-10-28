// Real end-to-end check of RETELL mode: OpenAI TTS makes the "learner" audio, then the REAL pipeline (STT -> meaning compare LLM -> coach TTS)
// runs in-process. TonePerfect is NEVER called: the engine is a SYNTHETIC result built from the transcript, replayed after a SIMULATED delay.
// Usage: node server/scripts/retell-real-check.js [--tp-delay 2000] [--runs 1] [--write-fixtures]
// Writes: test-results/RETELL-REAL.json (+ test/fixtures/retell/*.json with --write-fixtures: transcript + raw compare JSON, no keys, no audio).
// Never prints keys. Prints the (synthetic) transcripts and idea table, which are TTS test content, not user speech.
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
import { FIXED_PHRASES_ZH } from '../services/coach.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
loadDotEnv();
try { const { setGlobalDispatcher, Agent } = await import('undici'); setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 })); } catch { /* optional */ }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TP_DELAY = arg('--tp-delay', 2000); const RUNS = arg('--runs', 1); const WRITE = process.argv.includes('--write-fixtures');

export const CHUNK = '小明早上起床，吃了早饭，骑自行车去学校。他在学校学习数学和英语，下午回家踢足球。';
export const SCENARIOS = [
  { name: 'all-ideas-own-words', say: '小明每天早晨起来，先吃早餐，然后骑单车去上学。在学校里他学数学跟英语，放学回到家以后就去踢足球。' },
  { name: 'omits-football', say: '小明早上起床，吃了早饭，骑自行车去学校。他在学校学习数学和英语。' },
  { name: 'wrong-meaning', say: '小明早上起床，吃了早饭，走路去学校。他在学校学习历史和音乐，下午回家看电视。' },
];

const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', APP_PASSCODE: 'measure-pass', DATA_DIR: '', PORT: '0', PUBLIC_DIR: '' });
if (!cfg.openai.apiKey) { console.error('OPENAI_API_KEY not configured'); process.exit(2); }
const db = openDb(':memory:');
const services = createServices(cfg);
let capturedLlm = null;
const origJson = services.llm.chatJson.bind(services.llm);
services.llm = { ...services.llm, available: services.llm.available, chatStream: services.llm.chatStream, chatJson: async (o) => { const r = await origJson(o); capturedLlm = structuredClone(r); return r; } };

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

fs.mkdirSync(path.join(root, 'test-results/retell-audio'), { recursive: true });
fs.mkdirSync(path.join(root, 'test/fixtures/retell'), { recursive: true });
const out = [];
for (const sc of SCENARIOS) {
  const f = path.join(root, 'test-results/retell-audio', sc.name + '.mp3');
  if (!fs.existsSync(f)) fs.writeFileSync(f, await services.tts.speech?.({ text: sc.say, voice: 'alloy' }) ?? await (await import('../services/openai.js')).createOpenAI(cfg).speech({ text: sc.say, voice: 'alloy' }));
  for (let run = 0; run < RUNS; run++) {
    capturedLlm = null;
    const speed = 0.9 + Math.floor(Math.random() * 1000) / 10000;
    await services.tts.warm({ phrases: [...FIXED_PHRASES_ZH, ...RETELL_PHRASES_ZH], speed });
    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(f)], { type: 'audio/mpeg' }), 'rec.mp3');
    for (const [k, v] of Object.entries({ chunkText: CHUNK, assessMode: 'retell', practiceMode: 'listen_repeat', attemptId: 'rr-' + Math.random().toString(36).slice(2, 12), speed: String(speed) })) form.append(k, v);
    const t0 = Date.now(); const res = await fetch(base + '/api/attempt', { method: 'POST', body: form, headers: { Cookie: cookie } });
    const at = {}; let buf = ''; if (!res.ok || !/event-stream/.test(res.headers.get('content-type') || '')) console.log('HTTP', res.status, res.headers.get('content-type')); let assessment = null; let done = null; const lines = []; let err = null; const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(blk); if (!m) continue;
        const d = JSON.parse(m[2]); at[m[1]] ??= Date.now() - t0;
        if (m[1] === 'assessment') assessment = d; if (m[1] === 'done') done = d; if (m[1] === 'error') err = d;
        if (m[1] === 'coach_text') lines.push(`${d.role}: ${d.delta ?? JSON.stringify(d)}`);
      }
    }
    const R = assessment?.retell;
    const row = { scenario: sc.name, run, ms: { assessment: at.assessment, firstCoachText: at.coach_text, firstCoachAudio: at.coach_audio, done: at.done }, timings: done?.timings, error: err?.code ?? null,
      transcript: R?.transcript, comparisonStatus: R?.comparisonStatus, coveredCount: R?.coveredCount, totalCount: R?.totalCount, canPraise: R?.canPraise, tone: R?.tone, dropped: done?.summary?.droppedIdeas, attempts: done?.summary?.compareAttempts,
      ideas: R?.ideas?.map((x) => ({ id: x.id, textZh: x.textZh, span: CHUNK.slice(x.refStart, x.refEnd), covered: x.covered, confidence: x.confidence, evidence: x.evidence })), missing: R?.missingIdeaIds, suggestedWords: R?.suggestedWords, lines, retellBlock: R, done };
    out.push(row); console.log(JSON.stringify(row, null, 1));
    if (WRITE && run === 0 && R && capturedLlm) fs.writeFileSync(path.join(root, 'test/fixtures/retell', sc.name + '.json'), JSON.stringify({ name: sc.name, chunkText: CHUNK, transcript: R.transcript, llmRaw: capturedLlm, note: 'real gpt-4.1-mini output on real gpt-4o-transcribe text of OpenAI-TTS audio; no keys, no audio' }, null, 1));
  }
}
fs.writeFileSync(path.join(root, 'test-results', 'RETELL-REAL.json'), JSON.stringify({ tpDelaySimulatedMs: TP_DELAY, note: 'TonePerfect = SYNTHETIC result replayed after SIMULATED delay; OpenAI STT/LLM/TTS are real.', rows: out }, null, 1));
server.close(); db.close();
