// TonePerfect adapter - the ONLY file that knows TonePerfect wire formats.
//
// Schema choice: we send `TonePerfect-Response: compact` (toneperfect.compact.v1, documented + versioned).
// It carries, per character (word) in Mandarin: text, pinyin ("ni3"), start/end ms, and units[] with
// dimension (initial|final|tone), expected, heard, score and decision - everything we need. What it lacks
// versus the default schema is per-component `confidence`/`alternatives`/`advice` (engine diagnostics that
// are explicitly "not a stable contract"). We don't need them: the decision field is the authority.
//
// Safety rules implemented here:
//  - only decision==='review' is ever a correction candidate (see derive.js); uncertain/no_correction are passed through faithfully
//  - assessable:false => status 'unavailable' with the vendor reason; NEVER a zero score
//  - unknown => null, never 0; heard values are copied from the vendor, never invented
//  - one Idempotency-Key per recording attempt; reused ONLY for retries where the outcome may be unknown
//  - secrets never appear in results, errors or logs
import crypto from 'node:crypto';
import { log, redact } from '../../config.js';

// ---------------------------------------------------------------- errors
export class AssessmentError extends Error {
  constructor({ code, retryable, userMessage, status = null, requestId = null, newKeyRequired = false }) {
    super(userMessage);
    this.name = 'AssessmentError';
    Object.assign(this, { code, retryable, userMessage, status, requestId, newKeyRequired });
  }
  toJSON() { return { code: this.code, message: this.userMessage, retryable: this.retryable }; }
}

// code -> { retryable: can the user press Retry and reasonably succeed, auto: retry same key automatically, user: message }
const E = {
  invalid_multipart:       { retryable: false, user: 'The recording upload was malformed. This is an app bug; please report it.' },
  invalid_api_key:         { retryable: false, user: 'The TonePerfect API key is missing, wrong or revoked. Check TONEPERFECT_API_KEY on the server.' },
  subscription_required:   { retryable: false, user: 'TonePerfect free credits are used up and there is no active plan. Start or renew a plan in the TonePerfect dashboard.' },
  insufficient_credits:    { retryable: false, user: 'TonePerfect plan credits are exhausted. Buy a credit pack or wait for renewal.' },
  payment_balance_due:     { retryable: false, user: 'TonePerfect reports a balance due from a refunded or disputed purchase. Settle it in the dashboard.' },
  upload_timeout:          { retryable: true, auto: true, user: 'The upload was too slow. Please try again.' },
  idempotency_conflict:    { retryable: true, user: 'This attempt id was already used with different audio. Please record again.' },
  request_pending:         { retryable: true, auto: true, user: 'The assessment is still running. Please try again in a moment.' },
  idempotency_expired:     { retryable: true, user: 'This attempt expired. Please record again.' },
  upload_too_large:        { retryable: false, user: 'The recording is over 10 MB. Record a shorter piece.' },
  invalid_idempotency_key: { retryable: false, user: 'Internal error: bad attempt id.' },
  missing_audio:           { retryable: true, user: 'No audio was received. Please record again.' },
  invalid_reference:       { retryable: false, user: 'The reference text was rejected (empty or too long). Skip this chunk or shorten it.' },
  invalid_task:            { retryable: false, user: 'Internal error: invalid assessment task.' },
  invalid_test_outcome:    { retryable: false, user: 'Internal error: invalid test outcome.' },
  invalid_input:           { retryable: false, user: 'Internal error: invalid request fields.' },
  unsupported_language:    { retryable: false, user: 'Mandarin assessment is not available right now.' },
  invalid_audio:           { retryable: true, user: 'The recording could not be read, or was too short or too long (0.15-120 s). Please record again.' },
  invalid_assessment:      { retryable: false, user: 'The assessment engine rejected this reference text (for example digits, Latin letters or mismatched pinyin). Skip this chunk or fix the text.' },
  rate_limit:              { retryable: true, auto: true, user: 'Assessment service is rate limited. Please try again in a few seconds.' },
  account_busy:            { retryable: true, auto: true, user: 'Assessment service is busy with other recordings. Please try again.' },
  free_capacity:           { retryable: false, user: "TonePerfect's shared free capacity is used up for today. Try tomorrow or start a plan." },
  gateway_busy:            { retryable: true, auto: true, user: 'Assessment service is busy. Please try again.' },
  decoder_busy:            { retryable: true, auto: true, user: 'Assessment audio decoder is busy. Please try again.' },
  audio_decoder_unavailable: { retryable: true, auto: true, user: 'Assessment audio decoder is temporarily unavailable. Please try again.' },
  engine_unavailable:      { retryable: true, user: 'The assessment engine could not finish. Please try again in a moment.' }, // auto only when NOT finalized
  request_interrupted:     { retryable: true, user: 'The assessment was interrupted. Please try again.' },
};
export const ERROR_CODES = Object.keys(E);

// assessable:false reasons
const REASONS = {
  no_speech:         { retryable: true, user: "I didn't hear any speech. Check the mic and try again." },
  no_audio:          { retryable: true, user: "I didn't get any usable audio. Try again." },
  too_short:         { retryable: true, user: 'That was too short to assess. Say the whole sentence.' },
  different_content: { retryable: true, user: "That didn't seem to match the sentence, so no assessment was made. Try again, or skip." },
  language_model_not_installed: { retryable: false, user: 'The Mandarin model is not installed on the assessment server.' },
  unsupported_phonetic_symbols: { retryable: false, user: 'This text uses sounds the assessment engine cannot grade. Skip it.' },
  no_calibrated_units: { retryable: false, user: 'None of the sounds could be graded for this recording. Try again, or skip.' },
};

const err = (code, extra = {}) => {
  const def = E[code] || { retryable: false, user: 'Assessment failed.' };
  return new AssessmentError({ code, retryable: def.retryable, userMessage: def.user, ...extra });
};

// ---------------------------------------------------------------- helpers
const DECISIONS = new Set(['review', 'uncertain', 'no_correction', 'unassessable', 'partial', 'legacy_correction']);
const HANZI = /[\u3400-\u9fff]/g;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function toneNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n === 0 ? 5 : n;
}
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

const MIME_EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'm4a' };
const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

/** Idempotency-Key: 8-128 of [A-Za-z0-9._:-]. */
export function toIdempotencyKey(attemptId, generation = 1) {
  let id = String(attemptId ?? '').replace(/[^A-Za-z0-9._:-]/g, '-');
  if (id.length < 4 || id.length > 100) id = crypto.createHash('sha256').update(String(attemptId ?? crypto.randomUUID())).digest('hex').slice(0, 40);
  return `coach-${id}${generation > 1 ? `:r${generation}` : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- normalization
function unavailable(base, error, meta) {
  return { ...base, status: 'unavailable', overall: null, scores: null, syllables: [], words: [],
    error: { code: error.code, message: error.userMessage, retryable: error.retryable }, ...(meta ? { meta } : {}) };
}

/** Compact toneperfect.compact.v1 body -> NormalizedAssessment. Pure function (unit-tested). */
export function normalizeCompact(body, { lowConfidence = false } = {}) {
  const base = { engine: 'toneperfect', mock: false, modelVersion: str(body?.model_version), ...(lowConfidence ? { lowConfidence: true } : {}) };
  const meta = { requestId: str(body?.id), task: str(body?.task), creditsCharged: num(body?.billing?.credits), balanceCredits: num(body?.billing?.balance_credits) };
  if (!body || body.schema !== 'toneperfect.compact.v1') {
    return unavailable(base, new AssessmentError({ code: 'unexpected_schema', retryable: false,
      userMessage: 'The assessment service returned an unrecognised response format; no assessment obtained.' }), meta);
  }
  if (body.assessable !== true) {
    const reason = str(body.reason) || 'unassessable';
    const def = REASONS[reason] || { retryable: true, user: 'This recording could not be assessed. Try again, or skip.' };
    return unavailable(base, new AssessmentError({ code: reason, retryable: def.retryable, userMessage: def.user }), meta);
  }
  const words = Array.isArray(body.words) ? body.words : [];
  if (!words.length) {
    return unavailable(base, new AssessmentError({ code: 'malformed_response', retryable: true,
      userMessage: 'The assessment service returned no per-syllable detail; no assessment obtained.' }), meta);
  }
  const dec = (d) => (DECISIONS.has(d) ? d : 'no_decision');
  const comp = (units, dim) => {
    const u = Array.isArray(units) ? units.find((x) => x?.dimension === dim) : null;
    if (!u) return { expected: null, heard: null, score: null, decision: 'no_decision' };
    const isTone = dim === 'tone';
    return { expected: isTone ? toneNum(u.expected) : str(u.expected), heard: isTone ? toneNum(u.heard) : str(u.heard), score: num(u.score), decision: dec(u.decision) };
  };
  const syllables = words.map((w, i) => ({
    index: i, char: str(w.text) ?? '', pinyin: str(w.pinyin) ?? '', wordIndex: i,
    startMs: num(w.start_ms), endMs: num(w.end_ms),
    initial: comp(w.units, 'initial'), final: comp(w.units, 'final'), tone: comp(w.units, 'tone'),
  }));
  const s = body.scores || {};
  return { ...base, status: 'ok',
    overall: num(s.overall),
    scores: { overall: num(s.overall), pronunciation: num(s.pronunciation), initial: num(s.initial), final: num(s.final), tone: num(s.tone) },
    syllables,
    words: words.map((w) => ({ text: str(w.text) ?? '', score: num(w.score), startMs: num(w.start_ms), endMs: num(w.end_ms) })),
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((x) => typeof x === 'string').slice(0, 5) : [],
    meta };
}

// ---------------------------------------------------------------- engine
const DEFAULTS = { requestTimeoutMs: 32_000, totalBudgetMs: 45_000, maxAttempts: 4, maxRetryAfterMs: 5_000, baseBackoffMs: 400, concurrency: 2 };

export function createToneperfectEngine(cfg, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const baseUrl = cfg.toneperfect.baseUrl;
  const burned = new Map(); // attemptId -> generation after a FINALIZED failure (next call needs a new key)
  let active = 0; const waiters = [];
  const acquire = async () => { if (active >= o.concurrency) await new Promise((r) => waiters.push(r)); active += 1; };
  const release = () => { active -= 1; waiters.shift()?.(); };

  async function send({ audio, mime, text, pinyin, key, task = 'connected_speech' }, timeoutMs) {
    const form = new FormData();
    const bm = baseMime(mime) || 'audio/wav';
    form.append('audio', new Blob([audio], { type: bm }), `recording.${MIME_EXT[bm] || 'wav'}`);
    form.append('text', text);
    form.append('language', 'zh-CN');
    form.append('task', task);
    if (pinyin) form.append('pinyin', pinyin);
    const res = await fetch(`${baseUrl}/v1/assess`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.toneperfect.apiKey}`, 'Idempotency-Key': key, 'TonePerfect-Response': 'compact', Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* html/empty proxy body */ }
    return { status: res.status, json, headers: res.headers };
  }

  /** Classify a response: {done:body} | {retrySame:true, delayMs} | {fail:AssessmentError} */
  function classify(r) {
    const retryAfter = Number(r.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, o.maxRetryAfterMs) : null;
    if (r.status === 200 && r.json) return { done: r.json };
    const code = r.json?.error?.code;
    const requestId = r.json?.request_id || r.json?.id || r.headers.get('x-request-id') || null;
    if (!code) {
      if (r.status === 502 || r.status === 504 || r.status === 503 || r.status === 408) return { retrySame: true, delayMs, last: err('request_interrupted', { status: r.status, requestId }) };
      return { fail: new AssessmentError({ code: `http_${r.status}`, retryable: r.status >= 500, userMessage: 'The assessment service returned an unexpected response; no assessment obtained.', status: r.status, requestId }) };
    }
    const def = E[code];
    if (!def) return { fail: new AssessmentError({ code, retryable: r.status >= 500, userMessage: 'The assessment service reported an error; no assessment obtained.', status: r.status, requestId }) };
    const finalized = !!(r.json.id && r.json.billing); // finalized failure: stored under the key, not charged
    if (code === 'engine_unavailable' || code === 'request_interrupted') {
      if (!finalized && code === 'engine_unavailable') return { retrySame: true, delayMs, last: err(code, { status: r.status, requestId }) };
      return { fail: err(code, { status: r.status, requestId: r.json.id || requestId, newKeyRequired: true }) };
    }
    if (def.auto) return { retrySame: true, delayMs, last: err(code, { status: r.status, requestId }) };
    const newKey = code === 'invalid_assessment' || code === 'idempotency_expired' || code === 'idempotency_conflict';
    return { fail: err(code, { status: r.status, requestId, newKeyRequired: newKey }) };
  }

  return {
    name: 'toneperfect',
    mock: false,
    available: () => !!cfg.toneperfect.apiKey,

    async assess({ audio, mime, chunkText, attemptId, pinyin, lowConfidence = false, task } = {}) {
      const base = { engine: 'toneperfect', mock: false, modelVersion: null, ...(lowConfidence ? { lowConfidence: true } : {}) };
      const fail = (e) => unavailable(base, e);
      if (!cfg.toneperfect.apiKey) {
        return fail(new AssessmentError({ code: 'not_configured', retryable: false, userMessage: 'TONEPERFECT_API_KEY is not set on the server; no assessment obtained.' }));
      }
      if (!Buffer.isBuffer(audio) || audio.length === 0) return fail(err('missing_audio'));
      if (audio.length > 10 * 1024 * 1024) return fail(err('upload_too_large'));
      // Reference = Chinese characters only (punctuation/stage marks removed). Digits/Latin are refused locally: free + clear.
      const text = (String(chunkText ?? '').match(HANZI) || []).join('');
      if (/[0-9A-Za-z０-９]/.test(String(chunkText ?? ''))) {
        return fail(new AssessmentError({ code: 'invalid_reference', retryable: false, userMessage: 'Write numbers and foreign words in Chinese characters (e.g. 三 not 3) so they can be assessed. Skip this chunk or fix the text.' }));
      }
      if (!text || text.length > 100) return fail(err('invalid_reference'));

      const generation = burned.get(attemptId) || 1;
      const key = toIdempotencyKey(attemptId, generation); // fixed for every retry of THIS call
      const started = Date.now();
      let last = null;
      await acquire();
      try {
        for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
          const remaining = o.totalBudgetMs - (Date.now() - started);
          if (remaining <= 250) break;
          let delayMs = null;
          try {
            const r = await send({ audio, mime, text, pinyin, key, task }, Math.min(o.requestTimeoutMs, remaining));
            const c = classify(r);
            if (c.done) return normalizeCompact(c.done, { lowConfidence });
            if (c.fail) {
              if (c.fail.newKeyRequired) { burned.set(attemptId, generation + 1); if (burned.size > 500) burned.delete(burned.keys().next().value); }
              log('warn', `toneperfect assess failed: code=${c.fail.code} status=${c.fail.status} request=${c.fail.requestId}`);
              return fail(c.fail);
            }
            last = c.last; delayMs = c.delayMs;
          } catch (e) {
            // network error / timeout: outcome unknown -> retry with the SAME key
            const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
            last = new AssessmentError({ code: timedOut ? 'network_timeout' : 'network_error', retryable: true,
              userMessage: 'Could not reach the assessment service. Please try again.' });
            log('warn', `toneperfect network ${last.code}: ${redact(e?.cause?.code || e?.message || '')}`);
          }
          if (attempt === o.maxAttempts) break;
          const wait = delayMs ?? Math.min(o.baseBackoffMs * 2 ** (attempt - 1), 3000);
          if (wait >= o.totalBudgetMs - (Date.now() - started)) break;
          await sleep(wait);
        }
      } finally { release(); }
      const final = last || err('request_interrupted');
      log('warn', `toneperfect assess gave up: code=${final.code}`);
      return fail(new AssessmentError({ code: final.code, retryable: true, userMessage: final.userMessage, status: final.status, requestId: final.requestId }));
    },

    /** Free, unauthenticated reference check (use when authoring content, not in the learner path). */
    async lint(text) {
      const res = await fetch(`${baseUrl}/v1/lint`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: 'zh-CN' }), signal: AbortSignal.timeout(10_000) });
      const j = await res.json();
      return { ok: !!j.ok, issues: (j.issues || []).map((i) => ({ code: i.code, message: i.message, severity: i.severity })), units: j.units ?? null };
    },

    /** Free, unauthenticated. Normalised: Mandarin availability + limits. */
    async capabilities() {
      const res = await fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json();
      const zh = (j.languages || []).find((l) => l.locale === 'zh-CN');
      return { modelVersion: j.model_version ?? null, mandarin: zh ? { available: !!zh.available, status: zh.status, dimensions: zh.dimensions, tasks: zh.tasks } : null,
        limits: { maxAudioSeconds: j.limits?.max_audio_seconds ?? null, maxUploadBytes: j.limits?.max_upload_bytes ?? null, concurrent: j.limits?.concurrent_requests_per_account ?? null } };
    },
  };
}
