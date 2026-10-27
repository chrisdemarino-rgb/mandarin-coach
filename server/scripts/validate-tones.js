#!/usr/bin/env node
// Validate the real TonePerfect engine with REAL human recordings (never our own TTS).
//   node server/scripts/validate-tones.js            # free checks + run every sample present (max 8 credit-spending calls)
//   node server/scripts/validate-tones.js --list     # show which recordings are present/missing, call nothing
//   node server/scripts/validate-tones.js --only 03  # run only samples whose file starts with "03"
// Recordings go in app/server/test-results/recordings/ (see ../test-results/NEEDED-RECORDINGS.md).
// Results (normalized, no secrets, no audio) are written to app/server/test-results/results/<name>.json.
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, loadConfig, APP_ROOT } from '../config.js';
import { createToneperfectEngine } from '../engines/assessment/toneperfect.js';
import { deriveFacts } from '../engines/assessment/derive.js';

// name (file stem), reference text, what we expect. credits: 1 per started 15 s (unassessable are free).
export const SAMPLES = [
  { name: '01-nihao-correct', text: '你好', expect: 'ok; 你 tone 3 heard 2 is sandhi => NO confirmed tone error' },
  { name: '02-xiexie-correct', text: '谢谢', expect: 'ok; no confirmed tone errors' },
  { name: '03-xiexie-wrong-tone', text: '谢谢', expect: 'ok; 2nd 谢 said with rising tone 2 => confirmedToneErrors ideally includes index 1 (expected 4)' },
  { name: '04-xihuan-zhongwen-correct', text: '我喜欢学中文', expect: 'ok; 我喜 3-3 sandhi must not be flagged' },
  { name: '05-xihuan-zhongwen-wrong-tone', text: '我喜欢学中文', expect: 'ok; 学 said falling (xuè) and 中 said 3rd (zhǒng) => review on those if the engine is sure' },
  { name: '06-jintian-tianqi-correct', text: '今天天气很好', expect: 'ok; 很好 3-3 sandhi must not be flagged' },
  { name: '07-silence', text: '你好', expect: 'unavailable: no_speech or no_audio (free)' },
  { name: '08-wrong-sentence', text: '谢谢', expect: 'unavailable: different_content (free) - record yourself saying 你好 while the reference is 谢谢' },
];
const MAX_PAID = 8;
const EXTS = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webm': 'audio/webm' };

const dir = path.join(APP_ROOT, 'server', 'test-results');
const recDir = path.join(dir, 'recordings');
const outDir = path.join(dir, 'results');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

loadDotEnv();
const cfg = loadConfig();
const engine = createToneperfectEngine(cfg);

function find(name) {
  for (const [ext, mime] of Object.entries(EXTS)) {
    const p = path.join(recDir, name + ext);
    if (fs.existsSync(p)) return { file: p, mime };
  }
  return null;
}

fs.mkdirSync(recDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const present = SAMPLES.filter((s) => (!only || s.name.startsWith(only)) && find(s.name));
const missing = SAMPLES.filter((s) => !find(s.name));
console.log(`engine: toneperfect | key configured: ${engine.available() ? 'yes' : 'NO'} | base: ${cfg.toneperfect.baseUrl}`);

// Free checks first.
try {
  const caps = await engine.capabilities();
  console.log('capabilities (free):', JSON.stringify(caps));
  for (const s of SAMPLES.slice(0, 2)) console.log(`lint ${s.text} (free):`, JSON.stringify(await engine.lint(s.text)));
} catch (e) { console.log('free checks failed:', e.message); }

console.log(`\nrecordings present: ${present.length}/${SAMPLES.length}`);
for (const s of missing) console.log(`  MISSING ${s.name}.{m4a|wav|mp3}  ("${s.text}")`);
if (args.includes('--list')) process.exit(0);
if (!present.length) {
  console.log('\nNo real recordings found. Nothing was sent (no credits spent). See test-results/NEEDED-RECORDINGS.md');
  process.exit(2);
}
if (!engine.available()) { console.log('TONEPERFECT_API_KEY not set; cannot run.'); process.exit(3); }
if (present.length > MAX_PAID) present.length = MAX_PAID;

let spent = 0;
for (const s of present) {
  const { file, mime } = find(s.name);
  const audio = fs.readFileSync(file);
  const t0 = Date.now();
  const result = await engine.assess({ audio, mime, chunkText: s.text, attemptId: `validate-${s.name}-${Date.now()}` });
  const facts = deriveFacts(result);
  const record = { sample: s.name, referenceText: s.text, expectation: s.expect, elapsedMs: Date.now() - t0, result, facts };
  const json = JSON.stringify(record, null, 2);
  if (cfg.toneperfect.apiKey && json.includes(cfg.toneperfect.apiKey)) throw new Error('refusing to write: output contains the API key');
  fs.writeFileSync(path.join(outDir, `${s.name}.json`), json + '\n');
  spent += result.meta?.creditsCharged ?? 0;
  const tone = result.status === 'ok' ? `overall=${result.overall} confirmedToneErrors=${facts.confirmedToneErrors.map((e) => `${e.char}(${e.expectedTone}->${e.heardTone})`).join(',') || 'none'} uncertain=${facts.uncertain.length}` : `UNAVAILABLE ${result.error.code} retryable=${result.error.retryable}`;
  console.log(`${s.name}: ${tone}  [${record.elapsedMs} ms]\n    expected: ${s.expect}`);
}
console.log(`\ncredits charged this run: ${spent}. Results in ${path.relative(APP_ROOT, outDir)}/`);
