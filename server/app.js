import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { log, redact } from './config.js';
import { requireAuth } from './lib/auth.js';
import { rateLimit } from './lib/ratelimit.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { prefsRouter } from './routes/prefs.js';
import { wordsRouter } from './routes/words.js';
import { mediaRouter } from './routes/media.js';
import { attemptRouter } from './routes/attempt.js';
import { createServices } from './services/index.js';

/** Build the Express app. Dependencies are injected so tests can use fakes. */
export function createApp({ cfg, db, engine, services = createServices(cfg), loginGuard }) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  // Request log: method, path (no query string), status, ms. Never bodies/headers/cookies.
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => { if (req.path.startsWith('/api/')) log('info', `${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`); });
    next();
  });

  if (cfg.corsOrigins.length) {
    app.use('/api', (req, res, next) => {
      const o = req.headers.origin;
      if (o && cfg.corsOrigins.includes(o)) {
        res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
          'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.use('/api', express.json({ limit: '100kb' }));

  // Public: health + login/logout/me (me checks auth itself)
  app.use('/api', healthRouter(cfg, engine));
  app.use('/api', authRouter(cfg, loginGuard ? { guard: loginGuard } : undefined));

  // Everything else under /api requires the session cookie.
  app.use('/api', requireAuth(cfg), rateLimit({ windowMs: 60_000, max: 300 }));
  app.use('/api', prefsRouter(db));
  app.use('/api', wordsRouter(db));
  app.use('/api', mediaRouter({ services, cfg }));
  app.use('/api', attemptRouter({ cfg, engine, services }));

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: { code: 'not_found', message: `No such endpoint: ${req.method} ${req.path}` } }));

  // Frontend (owned by Frontend bot): static files from app/public, same origin.
  if (fs.existsSync(cfg.publicDir)) {
    app.use(express.static(cfg.publicDir, { index: 'index.html', maxAge: cfg.isProd ? '5m' : 0 }));
  } else {
    app.get('/', (req, res) => res.type('text').send('Mandarin coach API is running. (app/public not found yet.)'));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    const status = e.type === 'entity.too.large' ? 413 : e.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) log('error', `unhandled: ${e.message}`);
    res.status(status).json({ ok: false, error: { code: status === 500 ? 'internal_error' : 'bad_request', message: status === 500 ? 'Internal error.' : redact(e.message) } });
  });
  return app;
}
