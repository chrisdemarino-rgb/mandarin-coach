import { loadDotEnv, loadConfig, services as healthServices, log } from './config.js';
import { openDb } from './db.js';
import { createAssessmentEngine } from './engines/assessment/index.js';
import { createApp } from './app.js';
import { createServices } from './services/index.js';

loadDotEnv();
const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const engine = createAssessmentEngine(cfg);
const services = createServices(cfg);
const app = createApp({ cfg, db, engine, services });

app.listen(cfg.port, () => {
  log('info', `Mandarin coach listening on http://localhost:${cfg.port} (env=${cfg.nodeEnv}, data=${cfg.dataDir})`);
  log('info', `assessment engine: ${engine.name}${engine.mock ? '  *** MOCK: results are NOT real pronunciation scores ***' : ''}`);
  log('info', `services: ${JSON.stringify(healthServices(cfg))}`);
  for (const w of cfg.warnings) log('warn', `*** ${w} ***`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.close(); process.exit(0); });
