#!/usr/bin/env node
// Transcribe real recordings with the REAL OpenAI STT (cheap) and cache the transcripts as test fixtures.
//   node server/scripts/stt-fixtures.js [file ...]   (default: every file in test-results/recordings)
// Output: test/fixtures/stt/<name>.json = {sample, model, transcript, sttMs}. Never contains keys/audio.
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, loadConfig, APP_ROOT } from '../config.js';
import { createServices } from '../services/index.js';

loadDotEnv();
const cfg = loadConfig();
const services = createServices(cfg);
if (!services.stt.available) { console.log('OPENAI_API_KEY not set'); process.exit(3); }
const recDir = path.join(APP_ROOT, 'server', 'test-results', 'recordings');
const outDir = path.join(APP_ROOT, 'server', 'test', 'fixtures', 'stt');
fs.mkdirSync(outDir, { recursive: true });
const MIME = { '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(recDir).filter((f) => MIME[path.extname(f)]).map((f) => path.join(recDir, f));
for (const f of files) {
  const name = path.basename(f, path.extname(f));
  const t0 = Date.now();
  const transcript = await services.stt.transcribe({ audio: fs.readFileSync(f), mime: MIME[path.extname(f)] });
  const rec = { sample: name, model: cfg.openai.sttModel, language: 'zh', prompt: null, transcript, sttMs: Date.now() - t0 };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(rec, null, 1) + '\n');
  console.log(name, JSON.stringify(transcript), `${rec.sttMs}ms`);
}
