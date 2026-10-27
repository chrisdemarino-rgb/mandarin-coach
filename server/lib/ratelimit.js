// Tiny in-memory fixed-window limiter (single process, single user app).
export function rateLimit({ windowMs, max, key = (req) => req.ip, code = 'rate_limited', message = 'Too many requests, slow down.' }) {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs);
  timer.unref?.();
  const mw = (req, res, next) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n += 1;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ ok: false, error: { code, message, retryable: true } });
    }
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}
