// Brute-force protection for the (short) passcode. In-memory, single process.
//  - per IP: 5 consecutive failures -> lockout, escalating 30s, 1m, 5m, 15m, 1h, 6h (resets on success / after 24h quiet)
//  - global (all IPs): 20 failures within 10 min -> lockout for everyone, escalating 1m, 5m, 15m, 1h, 6h
// While locked, even the correct passcode is refused (429 + Retry-After). Existing login cookies keep working.
const IP_STEPS = [30, 60, 300, 900, 3600, 21600];
const GLOBAL_STEPS = [60, 300, 900, 3600, 21600];

export function createLoginGuard({ now = () => Date.now(), ipFails = 5, globalFails = 20, globalWindowMs = 600_000 } = {}) {
  const ips = new Map();
  const g = { times: [], level: 0, until: 0, lastFail: 0 };
  const QUIET = 24 * 3600_000;

  const get = (ip) => { let s = ips.get(ip); if (!s) { s = { fails: 0, level: 0, until: 0, last: 0 }; ips.set(ip, s); } return s; };
  const prune = () => { const t = now(); for (const [k, s] of ips) if (s.until < t && t - s.last > QUIET) ips.delete(k); if (ips.size > 5000) ips.clear(); };

  return {
    /** @returns {{ok:true}|{ok:false, retryAfterSec:number, scope:'ip'|'global'}} */
    check(ip) {
      const t = now(); const s = get(ip);
      const wait = Math.max(s.until - t, g.until - t);
      if (wait > 0) return { ok: false, retryAfterSec: Math.ceil(wait / 1000), scope: g.until - t >= s.until - t ? 'global' : 'ip' };
      return { ok: true };
    },
    fail(ip) {
      prune(); const t = now(); const s = get(ip);
      if (t - s.last > QUIET) { s.level = 0; s.fails = 0; }
      s.last = t; s.fails += 1;
      if (s.fails >= ipFails) { s.until = t + IP_STEPS[Math.min(s.level, IP_STEPS.length - 1)] * 1000; s.level += 1; s.fails = 0; }
      if (t - g.lastFail > QUIET) { g.level = 0; g.times = []; }
      g.lastFail = t; g.times = g.times.filter((x) => t - x < globalWindowMs); g.times.push(t);
      if (g.times.length >= globalFails) { g.until = t + GLOBAL_STEPS[Math.min(g.level, GLOBAL_STEPS.length - 1)] * 1000; g.level += 1; g.times = []; }
    },
    success(ip) { const s = get(ip); s.fails = 0; s.level = 0; s.until = 0; },
  };
}
