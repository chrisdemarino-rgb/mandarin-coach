// Compare coach LLM candidates for latency + JSON/grounding reliability on the cached real clip 05 (wrong tones) facts.
// Usage: node server/scripts/compare-coach-models.js [model ...]   (real OpenAI calls, ~3 per model; prints content-free stats only)
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadDotEnv, loadConfig } from '../config.js';
import { createServices } from '../services/index.js';
import { applyPolicy } from '../engines/assessment/policy.js';
import { analyzeWords } from '../engines/assessment/words.js';
import { buildMessages, JsonUnitScanner, validateCorrection } from '../services/coach.js';

loadDotEnv();
const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const fx = JSON.parse(fs.readFileSync(path.join(dir, 'real-clips', '05-xihuan-zhongwen-wrong-tone.json'), 'utf8'));
const a = applyPolicy(fx.result); const chunkText = fx.referenceText;
const w = analyzeWords({ chunkText, assessment: a, transcript: JSON.parse(fs.readFileSync(path.join(dir, 'stt', '05-xihuan-zhongwen-wrong-tone.json'), 'utf8')).transcript, stt: { status: 'ok' } });
const facts = { confirmedToneErrors: w.confirmedToneErrors, uncertain: [], ...w.facts };
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'];
for (const model of models) {
  const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', COACH_MODEL: model, DATA_DIR: '', APP_PASSCODE: 'x' });
  const { llm } = createServices(cfg); const rows = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now(); let ttft = null; const sc = new JsonUnitScanner(); let kept = 0; let dropped = 0; let ok = true;
    try {
      for await (const d of llm.chatStream({ messages: buildMessages({ chunkText, assessMode: 'close', basis: 'script', lowConfidence: false, transcript: null, facts }), maxTokens: 260 })) {
        ttft ??= Date.now() - t0;
        for (const ev of sc.push(d)) if (ev.type === 'item' && ev.key === 'corrections') { const r = validateCorrection(ev.value, { chunkText, facts, transcript: null, assessMode: 'close', canPraise: true }); r.correction ? kept++ : dropped++; }
      }
    } catch { ok = false; }
    rows.push({ ttftMs: ttft, totalMs: Date.now() - t0, ok, keptCorrections: kept, droppedByValidation: dropped });
  }
  console.log(JSON.stringify({ model, rows }));
}
process.exit(0);
