// TTS provider selection: Azure (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION) > OpenAI > none.
// NOTE: everything produced here is the app's own voice. It is served with `X-Audio-Source: tts` and the
// assessment endpoints reject uploads tagged source=tts - the app must never assess its own TTS.
import crypto from 'node:crypto';
import { redact, log } from '../config.js';
import { ServiceError } from './openai.js';

const OPENAI_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);
const esc = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function createTts(cfg, openai) {
  const az = cfg.azure;
  const azureOn = !!(az.key && az.region);
  const provider = azureOn ? 'azure' : openai.available ? 'openai' : null;
  const cache = new Map(); // hash -> {buf, provider}; insertion-ordered LRU
  const MAX_ENTRIES = 300; const MAX_BYTES = 40 * 1024 * 1024; let bytes = 0;

  async function azureSpeak({ text, voice, speed, signal }) {
    const base = az.baseUrl || `https://${az.region}.tts.speech.microsoft.com`;
    const v = /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voice) ? voice : 'zh-CN-XiaoxiaoNeural';
    const rate = `${Math.round((speed - 1) * 100)}%`;
    const ssml = `<speak version="1.0" xml:lang="zh-CN" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${v}"><prosody rate="${rate}">${esc(text)}</prosody></voice></speak>`;
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const res = await fetch(`${base}/cognitiveservices/v1`, { method: 'POST', signal: sig,
      headers: { 'Ocp-Apim-Subscription-Key': az.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'mandarin-coach' },
      body: ssml });
    if (!res.ok) {
      log('warn', `azure tts failed: HTTP ${res.status} ${redact((await res.text().catch(() => '')).slice(0, 120))}`);
      throw new ServiceError(`azure_${res.status}`, `Azure TTS failed (HTTP ${res.status}).`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // In-flight de-duplication: the client prefetches the model answer and the user may tap before that finishes (or tap twice); identical
  // requests join the ONE provider call instead of starting another (the old code paid for, and waited on, each duplicate). The signal of the caller that
  // STARTED the call still applies to it (POST /api/tts passes none, so a client giving up never wastes the synthesis; attempt.js passes its own).
  const inflight = new Map();
  const warmed = new Set();
  return {
    provider, // 'azure' | 'openai' | null
    /** Pre-synthesize fixed phrases for this voice/speed so their audio is a cache hit later. Fire-and-forget, once per (voice,speed). */
    warm({ phrases, voice, speed = 1 }) {
      if (!provider) return Promise.resolve();
      const k = `${voice}|${speed}`; if (warmed.has(k)) return Promise.resolve(); warmed.add(k);
      const todo = [...phrases]; const worker = async () => { for (let t; (t = todo.shift());) { try { await this.synthesize({ text: t, voice, speed }); } catch { warmed.delete(k); return; } } };
      return Promise.all([worker(), worker(), worker()]).then(() => {});
    },
    available: !!provider,
    /** -> { buf: Buffer(mp3), provider, cached } */
    async synthesize({ text, voice, speed = 1, signal }) {
      if (!provider) throw new ServiceError('tts_not_configured', 'No TTS provider configured (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION, or OPENAI_API_KEY).');
      const sp = Math.min(1.2, Math.max(0.6, Number(speed) || 1));
      const v = provider === 'openai' ? (OPENAI_VOICES.has(voice) ? voice : 'nova') : (voice || 'zh-CN-XiaoxiaoNeural');
      const key = crypto.createHash('sha256').update(JSON.stringify([provider, v, sp, text])).digest('hex');
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return { buf: hit, provider, cached: true }; }
      let pending = inflight.get(key);
      const joined = !!pending;
      if (!pending) {
        pending = (async () => {
          const out = provider === 'azure' ? await azureSpeak({ text, voice: v, speed: sp, signal }) : await openai.speech({ text, voice: v, speed: sp, signal });
          if (!out.length) throw new ServiceError('tts_empty', 'TTS returned no audio.', { retryable: true });
          cache.set(key, out); bytes += out.length;
          while ((cache.size > MAX_ENTRIES || bytes > MAX_BYTES) && cache.size) { const [k, b] = cache.entries().next().value; cache.delete(k); bytes -= b.length; }
          return out;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const buf = await pending;
      return { buf, provider, cached: false, ...(joined ? { joined: true } : {}) };
    },
  };
}
