// Single-user passcode auth. Cookie = "<expiryMs>.<hmac>", httpOnly, signed with a key derived
// from SESSION_SECRET (or the passcode). No server-side session state => survives restarts.
import crypto from 'node:crypto';

export const COOKIE = 'coach_session';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function signingKey(cfg) {
  return crypto.createHash('sha256').update(`coach-session-v1:${cfg.sessionSecret || cfg.passcode || ''}`).digest();
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function issueToken(cfg, now = Date.now()) {
  const exp = String(now + cfg.sessionDays * 86400_000);
  return `${exp}.${hmac(signingKey(cfg), exp)}`;
}

export function verifyToken(cfg, token, now = Date.now()) {
  if (!cfg.passcode || typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(sig, hmac(signingKey(cfg), exp));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieOptions(cfg, req) {
  const secure = cfg.isProd || req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''}`;
}

export function setSessionCookie(cfg, req, res) {
  res.append('Set-Cookie', `${COOKIE}=${issueToken(cfg)}; Max-Age=${cfg.sessionDays * 86400}; ${cookieOptions(cfg, req)}`);
}
export function clearSessionCookie(cfg, req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieOptions(cfg, req)}`);
}

export function requireAuth(cfg) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (verifyToken(cfg, token)) return next();
    res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Login required.' } });
  };
}
