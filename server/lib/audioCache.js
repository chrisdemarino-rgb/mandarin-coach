// Short-lived in-memory store for coach audio served at GET /api/audio/:id.mp3. Never touches disk.
import crypto from 'node:crypto';

export function createAudioCache({ ttlMs = 5 * 60_000, maxEntries = 200, maxBytes = 50 * 1024 * 1024 } = {}) {
  const m = new Map(); let bytes = 0;
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of m) if (v.exp <= now) { m.delete(k); bytes -= v.buf.length; }
    while ((m.size > maxEntries || bytes > maxBytes) && m.size) { const [k, v] = m.entries().next().value; m.delete(k); bytes -= v.buf.length; }
  };
  const timer = setInterval(sweep, 30_000); timer.unref?.();
  return {
    put(buf) { const id = crypto.randomBytes(12).toString('hex'); m.set(id, { buf, exp: Date.now() + ttlMs }); bytes += buf.length; sweep(); return id; },
    get(id) { const v = m.get(id); if (!v) return null; if (v.exp <= Date.now()) { m.delete(id); bytes -= v.buf.length; return null; } return v.buf; },
    size: () => m.size,
    stop: () => clearInterval(timer),
  };
}
