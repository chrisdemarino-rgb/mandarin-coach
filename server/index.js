import { loadDotEnv, loadConfig, services as healthServices, log } from './config.js';
import { openDb } from './db.js';
import { createAssessmentEngine } from './engines/assessment/index.js';
import { createApp } from './app.js';
import { createServices } from './services/index.js';
import { FIXED_PHRASES_ZH } from './services/coach.js';

loadDotEnv();

// HTTP keep-alive for outbound calls (OpenAI / Azure / TonePerfect). Node's built-in fetch drops idle sockets after 4 s, but a practice
// take is >4 s apart, so every attempt used to pay a fresh TCP+TLS handshake per service. Optional: falls back silently to the default.
try {
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 }));
} catch { /* undici not installed: default dispatcher */ }
const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const engine = createAssessmentEngine(cfg);
const services = createServices(cfg);
const app = createApp({ cfg, db, engine, services });

app.listen(cfg.port, () => {
  // Warm the TTS cache for the fixed coach lines (opener, praise, retry, ...) with the saved voice/speed so the first feedback is a cache hit.
  const p = db.getPrefs?.() || {};
  services.tts.warm?.({ phrases: FIXED_PHRASES_ZH, voice: p.voice, speed: p.speed })?.catch?.(() => {});
  log('info', `Mandarin coach listening on http://localhost:${cfg.port} (env=${cfg.nodeEnv}, data=${cfg.dataDir})`);
  log('info', `assessment engine: ${engine.name}${engine.mock ? '  *** MOCK: results are NOT real pronunciation scores ***' : ''}`);
  log('info', `services: ${JSON.stringify(healthServices(cfg))}`);
  for (const w of cfg.warnings) log('warn', `*** ${w} ***`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.close(); process.exit(0); });
