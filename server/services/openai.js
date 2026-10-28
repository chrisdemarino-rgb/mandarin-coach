// Minimal OpenAI-compatible client (chat streaming, transcription, speech). Base URL is overridable
// (OPENAI_BASE_URL) so tests use a local fake. The key is only ever placed in the Authorization header.
import { redact, log } from '../config.js';

export class ServiceError extends Error {
  constructor(code, message, { retryable = false, status = null } = {}) { super(message); Object.assign(this, { code, retryable, status }); }
}

const ext = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'video/mp4': 'mp4' };

// Network-level failures (timeout, DNS, reset) become typed, retryable ServiceErrors instead of bare exceptions.
async function net(promise, what) {
  try { return await promise; } catch (e) {
    if (e instanceof ServiceError) throw e;
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    log('warn', `openai ${what} ${timeout ? 'timed out/aborted' : 'network error'}: ${redact(String(e?.cause?.code || e?.message || e)).slice(0, 120)}`);
    throw new ServiceError(timeout ? 'openai_timeout' : 'openai_unreachable', `${what} ${timeout ? 'timed out' : 'could not reach OpenAI'}.`, { retryable: true });
  }
}

export function createOpenAI(cfg) {
  const { apiKey, baseUrl } = cfg.openai;
  const auth = () => ({ Authorization: `Bearer ${apiKey}` });
  const notConfigured = (what) => new ServiceError('openai_not_configured', `OPENAI_API_KEY is not set on the server; ${what} unavailable.`);

  async function checked(res, what) {
    if (res.ok) return res;
    let detail = '';
    try { detail = redact((await res.text()).slice(0, 200)); } catch { /* ignore */ }
    log('warn', `openai ${what} failed: HTTP ${res.status} ${detail}`);
    const retryable = res.status === 429 || res.status >= 500;
    throw new ServiceError(`openai_${res.status}`, `${what} failed (HTTP ${res.status}).`, { retryable, status: res.status });
  }

  return {
    available: !!apiKey,

    /** Async generator of content deltas (strings) from a streaming chat completion in JSON mode. */
    async *chatStream({ messages, signal, model = cfg.openai.coachModel, maxTokens = 600, timeoutMs = 30_000, temperature = 0.3 }) {
      if (!apiKey) throw notConfigured('coaching');
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await checked(await net(fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, signal: sig,
        body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
      }), 'chat'), 'chat');
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) yield d; } catch { /* partial/keepalive */ }
        }
      }
    },

    /** Non-streaming JSON completion -> parsed object. */
    async chatJson({ messages, signal, model = cfg.openai.coachModel, maxTokens = 200, timeoutMs = 15_000, temperature = 0.3 }) {
      if (!apiKey) throw notConfigured('LLM');
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await checked(await net(fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, signal: sig,
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
      }), 'chat'), 'chat');
      const j = await res.json();
      try { return JSON.parse(j.choices?.[0]?.message?.content ?? ''); } catch { throw new ServiceError('llm_bad_json', 'The language model returned invalid JSON.', { retryable: true }); }
    },

    /** Speech-to-text, Mandarin. Deliberately NOT given the script as a prompt (it would hide omissions). */
    async transcribe({ audio, mime, signal, timeoutMs = 25_000 }) {
      if (!apiKey) throw notConfigured('speech-to-text');
      const bm = String(mime || 'audio/wav').split(';')[0].trim().toLowerCase();
      const form = new FormData();
      form.append('file', new Blob([audio], { type: bm }), `speech.${ext[bm] || 'wav'}`);
      form.append('model', cfg.openai.sttModel);
      form.append('language', 'zh');
      form.append('response_format', 'json');
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await checked(await net(fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: auth(), body: form, signal: sig }), 'transcription'), 'transcription');
      const j = await res.json();
      return typeof j.text === 'string' ? j.text.trim() : '';
    },

    /** Text-to-speech -> mp3 Buffer. */
    async speech({ text, voice = 'nova', speed = 1, signal, timeoutMs = 20_000 }) {
      if (!apiKey) throw notConfigured('text-to-speech');
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const body = { model: cfg.openai.ttsModel, input: text, voice, response_format: 'mp3',
        instructions: 'Speak clearly in standard Mandarin (Putonghua) with accurate tones, at a calm teaching pace.' };
      if (speed && speed !== 1) body.speed = speed;
      let res = await net(fetch(`${baseUrl}/audio/speech`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig }), 'speech');
      if (res.status === 400 && body.speed) { // some models reject `speed`; retry without
        delete body.speed;
        res = await net(fetch(`${baseUrl}/audio/speech`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig }), 'speech');
      }
      await checked(res, 'speech');
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
