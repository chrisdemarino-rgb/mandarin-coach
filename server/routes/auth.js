import { Router } from 'express';
import { rateLimit } from '../lib/ratelimit.js';
import { createLoginGuard } from '../lib/loginGuard.js';
import { safeEqual, setSessionCookie, clearSessionCookie, requireAuth } from '../lib/auth.js';

export function authRouter(cfg, { guard = createLoginGuard() } = {}) {
  const r = Router();
  const loginLimit = rateLimit({ windowMs: 60_000, max: 30, code: 'too_many_logins', message: 'Too many login attempts. Wait a minute.' });
  r.post('/login', loginLimit, (req, res) => {
    if (!cfg.passcode) {
      return res.status(503).json({ ok: false, error: { code: 'passcode_not_configured', message: 'APP_PASSCODE is not set on the server.' } });
    }
    const lock = guard.check(req.ip);
    if (!lock.ok) {
      res.set('Retry-After', String(lock.retryAfterSec));
      return res.status(429).json({ ok: false, error: { code: 'login_locked', message: `Too many wrong passcodes. Try again in ${lock.retryAfterSec} seconds.`, retryable: true, retryAfterSec: lock.retryAfterSec } });
    }
    const given = req.body?.passcode;
    if (typeof given !== 'string' || !given.length || given.length > 200 || !safeEqual(given, cfg.passcode)) {
      guard.fail(req.ip);
      const after = guard.check(req.ip);
      if (!after.ok) res.set('Retry-After', String(after.retryAfterSec));
      return res.status(401).json({ ok: false, error: { code: 'bad_passcode', message: 'Wrong passcode.', ...(after.ok ? {} : { locked: true, retryAfterSec: after.retryAfterSec }) } });
    }
    guard.success(req.ip);
    setSessionCookie(cfg, req, res);
    res.json({ ok: true });
  });
  r.post('/logout', (req, res) => { clearSessionCookie(cfg, req, res); res.json({ ok: true }); });
  // Lets the frontend check whether its cookie is still valid.
  r.get('/me', requireAuth(cfg), (req, res) => res.json({ ok: true }));
  return r;
}
