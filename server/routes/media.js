// POST /api/tts, GET /api/audio/:id.mp3, POST /api/cues
import { Router } from 'express';
import { ServiceError } from '../services/openai.js';
import { log, redact } from '../config.js';

const E = (res, status, code, message, extra = {}) => res.status(status).json({ ok: false, error: { code, message, ...extra } });

export function sendMp3(req, res, buf) {
  res.set({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300', 'X-Audio-Source': 'tts' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) { // iOS Safari insists on Range support for <audio>
    let start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : buf.length - 1;
    end = Math.min(end, buf.length - 1);
    if (start > end || start >= buf.length) { res.set('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': String(end - start + 1) });
    return res.end(buf.subarray(start, end + 1));
  }
  res.set('Content-Length', String(buf.length));
  res.end(buf);
}

export function mediaRouter({ services, cfg }) {
  const r = Router();

  r.post('/tts', async (req, res) => {
    const { text, voice, speed } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || [...text].length > 500) return E(res, 400, 'invalid_text', 'text is required (max 500 characters).');
    if (speed !== undefined && !(typeof speed === 'number' && speed >= 0.6 && speed <= 1.2)) return E(res, 400, 'invalid_speed', 'speed must be 0.6-1.2.');
    if (voice !== undefined && !(typeof voice === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(voice))) return E(res, 400, 'invalid_voice', 'voice must be a voice id.');
    if (!services.tts.available) return E(res, 501, 'tts_not_configured', 'No TTS provider is configured on the server (AZURE_SPEECH_KEY+AZURE_SPEECH_REGION or OPENAI_API_KEY).');
    try {
      const out = await services.tts.synthesize({ text: text.trim(), voice, speed: speed ?? 1 });
      res.set({ 'X-TTS-Provider': out.provider, 'X-TTS-Cache': out.cached ? 'hit' : 'miss' });
      sendMp3(req, res, out.buf);
    } catch (e) {
      const known = e instanceof ServiceError;
      if (!known) log('warn', `tts unexpected error: ${redact(String(e?.message || e)).slice(0, 160)}`);
      E(res, known ? 502 : 500, known ? e.code : 'tts_failed', known ? e.message : 'TTS failed.', { retryable: known ? !!e.retryable : true });
    }
  });

  r.get('/audio/:id.mp3', (req, res) => {
    const buf = /^[a-f0-9]{24}$/.test(req.params.id) ? services.audioCache.get(req.params.id) : null;
    if (!buf) return E(res, 404, 'audio_expired', 'That audio has expired or does not exist.');
    sendMp3(req, res, buf);
  });

  r.post('/cues', async (req, res) => {
    const { chunkText, level } = req.body || {};
    if (typeof chunkText !== 'string' || !chunkText.trim() || [...chunkText].length > 100) return E(res, 400, 'invalid_chunk', 'chunkText is required (max 100 characters).');
    if (!Number.isInteger(level) || level < 1 || level > 4) return E(res, 400, 'invalid_level', 'level must be an integer 1-4.');
    const out = await services.cues({ chunkText: chunkText.trim(), level });
    res.json(out);
  });
  return r;
}
