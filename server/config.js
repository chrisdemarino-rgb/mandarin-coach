// Environment loading + validation. Secrets are read from process.env at call time
// and are NEVER logged or returned; use redact() / describe() for anything printable.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load app/.env (or app/server/.env) if present. Real env vars always win. */
/**
 * Assessment POLICY constants (applied to any engine's normalized result by engines/assessment/policy.js).
 * Derived from 8 clips of ONE speaker (see test-results/VALIDATION.md) - indicative, NOT statistically validated.
 *  - LOW_MATCH_*: a result this poor means the audio does not match the text (wrong sentence / noise), so no
 *    tone or sound claim is made. Observed: wrong sentence overall 0.2 / pron 32.2, room noise overall 2.3 / pron 45.5;
 *    every genuine attempt (incl. a deliberately mangled one) had overall >= 57 and pronunciation >= 86.2.
 *  - TONE_REVIEW_MAX_SCORE: a 'review' tone flag is only trusted if its tone score is <= this. Observed review flags:
 *    judged-correct flags 60, 60, 67.4; judged-false flags 60, 75.1, 75.6, 75.7, 75.7. 70 sits in the only gap (67.4..75.1).
 *  - TONE_MAX_CLAIMS: at most this many tone corrections are ever claimed (lowest tone score first).
 *  - TONE_DENSITY_*: if more than this share of a chunk's syllables (chunks with >= MIN syllables) still carry a
 *    trusted flag, the engine is unreliable on this clip: demote them all.
 */
export const ASSESSMENT_POLICY = Object.freeze({
  LOW_MATCH_OVERALL_MAX: 40,        // overall < 40  => gate 'low_match'
  LOW_MATCH_PRONUNCIATION_MAX: 60,  // pronunciation < 60 => gate 'low_match'
  TONE_REVIEW_MAX_SCORE: 70,        // review flag kept only if tone.score <= 70 (lower score = worse)
  TONE_MAX_CLAIMS: 2,
  TONE_DENSITY_MAX_RATIO: 0.4,
  TONE_DENSITY_MIN_SYLLABLES: 4,

  // ---- missed / skipped / substituted words (engines/assessment/words.js). Derived from the cached real-clip results
  //      (08 real clips + 2 ffmpeg-trimmed clips; n is tiny, see test-results/VALIDATION.md "Omission thresholds").
  // A reference word is an ACOUSTIC missing-word candidate when its word score is below this. Data: genuine words min 62.9;
  // omitted/truncated words 51.1-60.9 (3 samples); wrong-sentence/noise words <= 58.3. The margin is only ~2 points, so this
  // alone is NEVER enough to claim "missed" (acoustic-only => status 'uncertain', confidence 'low').
  ACOUSTIC_MISSING_WORD_MAX: 65,
  // ... or when the INITIAL consonant score is below this (only for syllables that have an initial). Data: skipped/truncated
  // syllables 1.1-5.4 (initial not heard at all); every genuine initial >= 57.3. Wide margin, but only 3 samples.
  ACOUSTIC_INITIAL_ABSENT_MAX: 30,
  // If the STT transcript explains less than this share of the reference characters while the acoustic result says the audio
  // matches, the transcript is considered unreliable (hallucination / accent / noise): STT-only evidence is downgraded to low.
  STT_MIN_COVERAGE: 0.3,
  // Auto-save to the 'words I don't know' list: omitted/substituted words (confidence high|medium) always; an acoustic-only low-score
  // word only when its word score is below this (stricter than the candidate threshold, to keep the list clean).
  SAVE_LOW_SCORE_WORD_MAX: 55,
  // /api/attempt starts STT in parallel with the assessment engine and waits for it at most this long (ms) after the
  // assessment is ready; on timeout the take is assessed acoustically only and facts.stt says so.
  STT_WAIT_MS: 3000,
  // ---- natural RETELL mode (services/retell.js)
  RETELL_TONE_WAIT_MS: 3000,        // how long to wait for the (optional) TonePerfect check of the transcript; later => tone skipped ("timeout")
  RETELL_COMPARE_MAX_MS: 9000,      // wall-clock cap of the meaning-comparison LLM call incl. its one retry; later => comparisonStatus "unavailable"
  RETELL_MAX_TRANSCRIPT_HANZI: 300, // longer retellings are refused (retell_too_long); the tone check additionally needs <= 100 hanzi (TonePerfect limit)
  // ---- Q&A practice mode (services/qa.js, routes/qa.js)
  QA_NEXT_MAX_MS: 8000,             // wall-clock cap of the question-generation LLM call incl. its one retry => 502 question_generation_failed
  QA_CHECK_MAX_MS: 8000,            // wall-clock cap of the answer-check LLM call incl. its one retry => comparisonStatus "unavailable"
  QA_TONE_WAIT_MS: 3000,            // optional TonePerfect check of the answer transcript (same policy as retell); later => tone skipped
  QA_MAX_TRANSCRIPT_HANZI: 300,     // longer answers are refused (qa_answer_too_long)
  // ---- reused-phrase word check (services/reuse.js; retell + Q&A). A stretch of the transcript that is a NEAR-VERBATIM reuse of a script
  //      phrase is compared word by word (pinyin-level local alignment); a substituted/omitted script word inside it blocks praise.
  //      Paraphrases (low overlap) are never flagged. See test/reuse.test.js for the paraphrase vs near-verbatim matrix.
  REUSE_MIN_RUN: 4,                 // the aligned region needs a verbatim run (identical or homophone chars) of at least this many script characters
  REUSE_MIN_MATCHED: 5,             // ... and at least this many matched characters in total
  REUSE_MIN_RATIO: 0.6,             // ... and matched / max(script span, heard content chars) >= this (function chars like 的/了 are not counted against it)
  REUSE_FLANK_MIN: 2,               // confidence 'high' needs a matching run of >= this many chars on BOTH sides of the differing words (else 'medium')
  REUSE_MAX_BLOCK: 6,               // a differing script block longer than this many characters is a rewrite, not a word slip: not flagged
  REUSE_MAX_FINDINGS: 3,            // at most this many word findings per attempt (the coach names at most 2)
  // A silent gap between consecutive syllables longer than this (ms) does not claim an error but blocks plain praise.
  // Data: genuine takes had gaps up to 625 ms (clip 05) so this only withholds praise, it never flags a word.
  LONG_PAUSE_MS: 500,
});

/** A word graduates from the "words I don't know" list after this many CONSECUTIVE correct drill attempts; any miss resets it to 0. */
export const DRILL_GRADUATE_STREAK = 3;

export function loadDotEnv() {
  for (const p of [path.join(APP_ROOT, '.env'), path.join(APP_ROOT, 'server', '.env')]) {
    if (fs.existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* ignore malformed .env */ }
    }
  }
}

const SECRET_KEYS = ['TONEPERFECT_API_KEY', 'OPENAI_API_KEY', 'AZURE_SPEECH_KEY', 'APP_PASSCODE', 'SESSION_SECRET'];

const has = (v) => typeof v === 'string' && v.trim() !== '';

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const warnings = [];

  let passcode = has(env.APP_PASSCODE) ? env.APP_PASSCODE : null;
  let devPasscode = false;
  if (!passcode && !isProd) {
    passcode = 'devpass';
    devPasscode = true;
    warnings.push('APP_PASSCODE not set: using the DEV-ONLY passcode "devpass". Never deploy like this.');
  }
  if (!passcode && isProd) {
    warnings.push('APP_PASSCODE is not set in production: login is DISABLED (503) until you set it.');
  }

  const tpKey = has(env.TONEPERFECT_API_KEY) ? env.TONEPERFECT_API_KEY.trim() : null;
  let engine = (env.ASSESSMENT_ENGINE || '').trim().toLowerCase();
  if (!engine) engine = tpKey ? 'toneperfect' : 'mock';
  if (!['mock', 'toneperfect'].includes(engine)) {
    warnings.push(`Unknown ASSESSMENT_ENGINE "${engine}"; falling back to mock.`);
    engine = 'mock';
  }
  if (engine === 'toneperfect' && !tpKey) {
    warnings.push('ASSESSMENT_ENGINE=toneperfect but TONEPERFECT_API_KEY is missing: assessments will report "no assessment obtained".');
  }

  if ((env.LLM_PROVIDER || 'openai').toLowerCase() !== 'openai') {
    warnings.push(`LLM_PROVIDER=${env.LLM_PROVIDER} is not implemented yet; only "openai" is supported.`);
  }

  const dataDir = has(env.DATA_DIR) ? path.resolve(env.DATA_DIR) : path.join(APP_ROOT, 'data');
  const port = Number.parseInt(env.PORT, 10) || 8080;

  const cfg = {
    nodeEnv, isProd, port, dataDir,
    publicDir: has(env.PUBLIC_DIR) ? path.resolve(env.PUBLIC_DIR) : path.join(APP_ROOT, 'public'),
    passcode, devPasscode,
    sessionSecret: has(env.SESSION_SECRET) ? env.SESSION_SECRET : null, // else derived from passcode
    sessionDays: Number.parseInt(env.SESSION_DAYS, 10) || 30,
    assessmentEngine: engine,
    policy: Object.freeze({ ...ASSESSMENT_POLICY, ...(has(env.STT_WAIT_MS) && Number(env.STT_WAIT_MS) > 0 ? { STT_WAIT_MS: Number(env.STT_WAIT_MS) } : {}) }),
    coachLlmTone: env.COACH_LLM_TONE === '1' || env.COACH_LLM_TONE === 'true',
    drillGraduateStreak: DRILL_GRADUATE_STREAK,
    toneperfect: {
      apiKey: tpKey,
      baseUrl: (env.TONEPERFECT_BASE_URL || 'https://api.toneperfect.app').replace(/\/+$/, ''),
    },
    openai: {
      apiKey: has(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY.trim() : null,
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      coachModel: env.COACH_MODEL || 'gpt-4.1-mini',
      qaModel: env.QA_MODEL || env.COACH_MODEL || 'gpt-4.1-mini',
      retellModel: env.RETELL_MODEL || env.COACH_MODEL || 'gpt-4.1-mini',
      sttModel: env.STT_MODEL || 'gpt-4o-transcribe',
      ttsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    },
    azure: {
      key: has(env.AZURE_SPEECH_KEY) ? env.AZURE_SPEECH_KEY.trim() : null,
      region: has(env.AZURE_SPEECH_REGION) ? env.AZURE_SPEECH_REGION.trim() : null,
      baseUrl: has(env.AZURE_SPEECH_BASE_URL) ? env.AZURE_SPEECH_BASE_URL.replace(/\/+$/, '') : null, // tests only
    },
    llmProvider: (env.LLM_PROVIDER || 'openai').toLowerCase(),
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY : (isProd ? 1 : false),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    warnings,
  };
  return cfg;
}

/** Which providers are usable right now (booleans only, safe to expose). */
export function services(cfg) {
  const azure = !!(cfg.azure.key && cfg.azure.region);
  return {
    assessment: cfg.assessmentEngine === 'mock' ? true : !!cfg.toneperfect.apiKey,
    llm: !!cfg.openai.apiKey,
    tts: azure ? 'azure' : cfg.openai.apiKey ? 'openai' : null,
    stt: !!cfg.openai.apiKey,
  };
}

/** Replace any secret value found in a string. Use for every log/error line that may embed upstream text. */
export function redact(text, env = process.env) {
  let s = String(text ?? '');
  for (const k of SECRET_KEYS) {
    const v = env[k];
    if (has(v) && v.length >= 4) s = s.split(v).join(`[redacted:${k}]`);
  }
  return s.replace(/\btp_(live|test)_[A-Za-z0-9_-]+/g, 'tp_$1_[redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
}

export function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${redact(msg)}${extra ? ' ' + redact(JSON.stringify(extra)) : ''}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}
