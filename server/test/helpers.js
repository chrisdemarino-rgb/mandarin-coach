import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createAssessmentEngine } from '../engines/assessment/index.js';
import { createApp } from '../app.js';
import { createServices } from '../services/index.js';

export async function startTestServer(env = {}, { loginGuard, tweakServices, engine: engineOverride } = {}) {
  const cfg = loadConfig({ NODE_ENV: 'test', APP_PASSCODE: 'test-pass', DATA_DIR: '', PORT: '0', PUBLIC_DIR: '/nonexistent', ...env });
  const db = openDb(':memory:');
  const engine = createAssessmentEngine(cfg);
  const services = createServices(cfg);
  tweakServices?.(services);
  const app = createApp({ cfg, db, engine: engineOverride || engine, services, loginGuard });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = async (method, path, body, { auth = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async (passcode = 'test-pass') => {
    const r = await api('POST', '/api/login', { passcode }, { auth: false });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return r;
  };
  return { cfg, db, engine, services, cookie: () => cookie, base, api, login, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

/** Multipart POST to /api/attempt, returns {status, events:[{event,data}], text, headers, json}. */
export async function postAttempt(t, { audio = Buffer.alloc(2000, 7), mime = 'audio/mp4', fields = {}, headers = {}, noAudio = false } = {}) {
  const form = new FormData();
  if (!noAudio) form.append('audio', new Blob([audio], { type: mime }), 'rec.m4a');
  const f = { chunkText: '谢谢', assessMode: 'close', practiceMode: 'listen_repeat', attemptId: 'att-' + Math.random().toString(36).slice(2, 12), ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) form.append(k, v);
  const res = await fetch(t.base + '/api/attempt', { method: 'POST', body: form, headers: { Cookie: t.cookie(), ...headers } });
  const text = await res.text();
  const events = [];
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const block of text.split('\n\n')) {
      const m = /^event: (\w+)\ndata: (.*)$/ms.exec(block.trim());
      if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
    }
  }
  let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
  return { status: res.status, events, text, headers: res.headers, json, attemptId: f.attemptId };
}

/** Engine that returns a cached normalized result (real-clip fixtures); runs through the same policy wrapper as production. */
export async function fixtureEngine(name) {
  const fs = await import('node:fs'); const url = await import('node:url'); const path = await import('node:path');
  const { withPolicy } = await import('../engines/assessment/policy.js');
  const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'real-clips');
  const fx = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  return withPolicy({ name: 'toneperfect', mock: false, available: () => true, async assess() { return structuredClone(fx.result); } });
}
