// Q&A practice mode: POST /api/qa/next | /api/qa/attempt (SSE) | /api/qa/hint | /api/qa/answer.  See API-ATTEMPT.md "Q&A practice".
// STATELESS: nothing is stored (no conversation, transcript, audio, question). A question is a signed payload the client sends back.
import multer from 'multer';
import { deriveFacts } from '../engines/assessment/index.js';
import { emptyWordFacts } from '../engines/assessment/words.js';
import { hanzi } from '../services/coach.js';
import { toSimplified } from '../services/retell.js';
import { generateQuestion, checkAnswer, buildQaBlock, planQaCoach, hintFor, questionPinyin, suggestQaWords, QA_GATE_ZH, QA_MIN_CHUNK_HANZI, QA_MAX_SCRIPT_HANZI, QA_MAX_CHUNKS } from '../services/qa.js';
import { signQuestion, verifyQuestion, QA_TYPES } from '../lib/qa-sign.js';
import { rateLimit } from '../lib/ratelimit.js';

const hzCount = (s) => (String(s).match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
const MAX_AUDIO = 10 * 1024 * 1024;

export function qaRoutes(r, { cfg, engine, services, db, bad, stamp, stream, speaker, warmTts, meaningOf, publicCorrection, ID_RE }) {
  const P = cfg.policy;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 8, fieldSize: 16 * 1024, parts: 12 } }).single('audio');
  const receive = (req, res, next) => upload(req, res, (e) => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return bad(res, 413, 'upload_too_large', 'Recording is over 10 MB. Record a shorter answer.');
    if (e.code === 'LIMIT_FIELD_VALUE') return bad(res, 413, 'question_too_large', 'The question field is too large.');
    return bad(res, 400, 'invalid_upload', 'Could not read the upload (expect multipart/form-data with an "audio" file and a "question" field).');
  });
  const publicQuestion = (q) => ({ ...q, signature: signQuestion(cfg, q) });
  const fromBody = (res, body) => { const v = verifyQuestion(cfg, body?.question ?? body); if (!v.ok) { bad(res, 400, v.code, v.message); return null; } return v.question; };

  // =================================================================== POST /api/qa/next
  r.post('/qa/next', rateLimit({ windowMs: 60_000, max: 60, code: 'too_many_requests' }), async (req, res) => {
    const t0 = Date.now(); const b = req.body || {};
    if (!Array.isArray(b.chunks) || !b.chunks.length || b.chunks.length > QA_MAX_CHUNKS || !b.chunks.every((c) => typeof c === 'string')) return bad(res, 400, 'invalid_chunks', `chunks must be an array of 1-${QA_MAX_CHUNKS} strings.`);
    if (b.chunks.some((c) => /[[\]【】]/.test(c))) return bad(res, 400, 'stage_directions_in_chunk', 'Strip stage directions like [停顿] before sending chunks.');
    const total = b.chunks.reduce((n, c) => n + hzCount(c), 0);
    if (total > QA_MAX_SCRIPT_HANZI) return bad(res, 413, 'script_too_long', `The script is over ${QA_MAX_SCRIPT_HANZI} characters (${total}). Send the chunk(s) you want to be asked about.`);
    const eligible = b.chunks.map((c, i) => ({ c, i })).filter((x) => hzCount(x.c) >= QA_MIN_CHUNK_HANZI);
    if (!eligible.length) return bad(res, 400, 'chunks_too_short', `No chunk has at least ${QA_MIN_CHUNK_HANZI} Chinese characters to ask about.`);
    const type = b.type == null ? 'any' : b.type;
    if (type !== 'any' && !QA_TYPES.includes(type)) return bad(res, 400, 'invalid_type', 'type must be what|why|how|who|any.');
    const level = b.level == null ? 1 : b.level;
    if (![1, 2].includes(level)) return bad(res, 400, 'invalid_level', 'level must be 1 or 2.');
    if (b.avoid != null && (!Array.isArray(b.avoid) || b.avoid.length > 40 || !b.avoid.every((x) => typeof x === 'string' && x.length <= 120))) return bad(res, 400, 'invalid_avoid', 'avoid must be an array of at most 40 questionIds / question texts (<=120 chars each).');
    const avoid = (b.avoid || []).map((x) => x.trim()).filter(Boolean);
    let pick;
    if (b.chunkIndex != null) { pick = eligible.find((x) => x.i === b.chunkIndex); if (!pick) return bad(res, 400, 'invalid_chunk_index', 'chunkIndex must point at a chunk with enough Chinese text.'); }
    else pick = eligible[Math.floor(Math.random() * eligible.length)];
    // no avoid list => random start; otherwise rotate what/why/how/who by how many were already asked, so consecutive questions differ in type
    const askedIds = avoid.filter((x) => /^q[0-9a-f]{12}$/.test(x)).length; const asked = Math.max(askedIds, avoid.length - askedIds); // ids and texts of the same questions are not counted twice
    const preferredType = type !== 'any' ? type : QA_TYPES[(asked ? asked : Math.floor(Math.random() * QA_TYPES.length)) % QA_TYPES.length];
    if (!services.llm?.available) return bad(res, 503, 'llm_not_configured', 'OPENAI_API_KEY is not set on the server, so questions cannot be generated.');
    const timings = {};
    const gen = await generateQuestion({ llm: services.llm, chunk: pick.c, chunkIndex: pick.i, preferredType, level, avoid, model: cfg.openai.qaModel, timings, maxMs: P.QA_NEXT_MAX_MS });
    if (gen.status !== 'ok') return bad(res, gen.reason === 'llm_not_configured' ? 503 : 502, 'question_generation_failed', `Could not produce a question with grounded key points (${gen.reason}). Try again.`);
    const { dropped, repeated, ...q } = gen.question;
    const out = { ok: true, ...publicQuestion(q), questionPinyin: questionPinyin(q.questionZh), ...(repeated ? { repeated: true } : {}) };
    let audioMs = null;
    if (req.query.audio === '1' && services.tts.available) {
      const a0 = Date.now();
      try {
        const v = await services.tts.synthesize({ text: q.questionZh, voice: typeof req.query.voice === 'string' ? req.query.voice : undefined, speed: Number(req.query.speed) || undefined });
        out.questionAudio = { url: `/api/audio/${services.audioCache.put(v.buf)}.mp3` };
      } catch { /* the client can still call POST /api/tts */ }
      audioMs = Date.now() - a0;
    }
    out.timings = { generateMs: timings.generateMs, llmAttempts: gen.attempts, ...(audioMs !== null ? { audioMs } : {}), totalMs: Date.now() - t0 };
    res.json(out);
  });

  // =================================================================== POST /api/qa/hint  /  POST /api/qa/answer   (no LLM)
  r.post('/qa/hint', (req, res) => {
    const q = fromBody(res, req.body); if (!q) return;
    const level = req.body?.hintLevel == null ? 1 : req.body.hintLevel;
    if (![1, 2].includes(level)) return bad(res, 400, 'invalid_hint_level', 'hintLevel must be 1 or 2.');
    res.json({ ok: true, questionId: q.questionId, ...hintFor(q, level) });
  });
  r.post('/qa/answer', (req, res) => {
    const q = fromBody(res, req.body); if (!q) return;
    res.json({ ok: true, questionId: q.questionId, modelAnswerZh: q.modelAnswerZh, sourceChunkIndex: q.sourceChunkIndex, keyPoints: q.keyPoints, suggestedWords: suggestQaWords(q.keyPoints.map((k) => ({ ...k, covered: false })), '', meaningOf) });
  });

  // =================================================================== POST /api/qa/attempt  (multipart -> text/event-stream)
  r.post('/qa/attempt', stamp, rateLimit({ windowMs: 60_000, max: 30, code: 'too_many_attempts' }), receive, async (req, res) => {
    const b = req.body || {}; const audio = req.file?.buffer; const attemptId = b.attemptId;
    if (b.source === 'tts' || String(req.headers['x-audio-source'] || '').toLowerCase() === 'tts') return bad(res, 400, 'tts_audio_rejected', 'Audio tagged as TTS is never assessed.');
    if (!audio || !audio.length) return bad(res, 400, 'missing_audio', 'Attach the recording as the "audio" file part.');
    let raw; try { raw = JSON.parse(String(b.question ?? '')); } catch { return bad(res, 400, 'invalid_question', 'question must be the JSON payload returned by /api/qa/next, sent as a string field.'); }
    const q = fromBody(res, raw); if (!q) return;
    if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) return bad(res, 400, 'invalid_attempt_id', 'attemptId (8-100 chars: letters, digits . _ : -) is required; use a new one per recording attempt.');
    warmTts(b);
    await stream(req, res, attemptId, (S) => qaPipeline(S, { req, b, audio, q, attemptId }));
  });

  async function qaPipeline(S, { req, b, audio, q, attemptId }) {
    const { send, timings } = S; const label = S.label;
    const mime = req.file.mimetype || 'audio/wav';
    if (!services.stt.available) return S.terminal('stt_not_configured', 'OPENAI_API_KEY is not set on the server, so answers cannot be transcribed; no assessment obtained.', false, 'transcribing');
    send('status', { stage: 'transcribing' });
    const t = Date.now(); let transcript;
    try { transcript = toSimplified(await services.stt.transcribe({ audio, mime, signal: S.ac.signal })); } catch (e) { timings.sttMs = Date.now() - t; if (S.closed) return; return S.terminal(e.code || 'transcription_failed', 'Could not transcribe your answer; no assessment obtained.', e.retryable !== false, 'transcribing'); }
    timings.sttMs = Date.now() - t;
    if (S.closed) return;
    const ref = hanzi(transcript);
    if (!ref) return S.terminal('no_speech_detected', "I couldn't hear Mandarin speech in that recording. Try again.", true, 'transcribing');
    if ([...ref].length > P.QA_MAX_TRANSCRIPT_HANZI) return S.terminal('qa_answer_too_long', `That answer is too long to check (over ${P.QA_MAX_TRANSCRIPT_HANZI} characters heard). Answer in one or two sentences.`, false, 'transcribing');

    send('status', { stage: 'assessing', detail: 'answer' });
    const checkP = checkAnswer({ llm: services.llm, question: q, transcript, signal: S.ac.signal, model: cfg.openai.qaModel, timings, maxMs: P.QA_CHECK_MAX_MS });
    // optional tone check on the TRANSCRIPT (same policy as retell): the transcript is never a tone source by itself
    let toneSkip = null;
    if (/[A-Za-z0-9]/.test(String(transcript).normalize('NFKC'))) toneSkip = 'transcript_has_digits_or_latin';
    else if ([...ref].length > 100) toneSkip = 'transcript_too_long_for_tone';
    const toneStart = Date.now();
    const toneP = toneSkip ? null : engine.assess({ audio, mime, chunkText: ref, attemptId, lowConfidence: true })
      .catch((e) => ({ status: 'unavailable', error: { code: 'assessment_unavailable', message: String(e?.message || 'assessment failed').slice(0, 120), retryable: true } }))
      .finally(() => { timings.assessMs = Date.now() - toneStart; });
    let chk = await checkP;
    if (S.closed) return;
    let assessment = null; let tone = { status: 'skipped', reason: toneSkip };
    if (toneP) {
      const left = Math.max(0, P.QA_TONE_WAIT_MS - (Date.now() - toneStart)); const w0 = Date.now(); let h;
      const out = await Promise.race([toneP, new Promise((res) => { h = setTimeout(() => res('timeout'), left); h.unref?.(); })]); clearTimeout(h);
      timings.toneWaitMs = Date.now() - w0;
      if (S.closed) return;
      if (out === 'timeout') tone = { status: 'skipped', reason: 'tone_check_timeout' };
      else if (out?.status !== 'ok') tone = { status: 'skipped', reason: out?.error?.code || 'assessment_unavailable', ...(out?.error?.message ? { message: out.error.message } : {}) };
      else if (out.gate === 'low_match') { assessment = out; tone = { status: 'skipped', reason: 'low_match' }; chk = { status: 'unavailable', reason: 'low_match' }; }
      else { assessment = out; tone = { status: 'ok' }; }
    }
    if (chk.status !== 'ok' && !assessment) {
      return S.terminal(tone.reason === 'tone_check_timeout' || !toneP ? 'assessment_unavailable' : tone.reason, `No assessment obtained: the answer check was unavailable (${chk.reason}) and ${toneP ? 'the tone check failed' : 'no tone check was possible'}.`, true, 'assessment');
    }
    const gated = assessment?.gate === 'low_match';
    const toneFacts = assessment && !gated ? deriveFacts(assessment).confirmedToneErrors : [];
    const qa = buildQaBlock({ chk, question: q, transcript, stt: { status: 'ok' }, tone, meaningOf });
    const shown = assessment || { status: 'ok', engine: engine.name, mock: !!engine.mock, overall: null, syllables: [], words: [], matchesText: null, gate: null, lowConfidence: true };
    const facts = { ...(assessment ? deriveFacts(assessment) : { confirmedToneErrors: [], uncertain: [] }), ...emptyWordFacts(), canPraise: qa.canPraise, completeness: 'unknown' };
    facts.confirmedToneErrors = toneFacts;
    send('assessment', { ...shown, lowConfidence: true, facts, wordStatus: [], savedMissed: [], basis: 'transcript', referenceText: ref, transcript, transcriptDerived: true, qa });
    S.markOk();

    const sp = speaker(S, b);
    const finish = (extra) => { timings.totalMs = Date.now() - S.t0; return { ...extra, timings: { ...timings }, summary: { ...label, basis: 'transcript', transcriptUsed: true, questionId: q.questionId, confirmedToneErrors: toneFacts.length, comparisonStatus: qa.comparisonStatus, coveredCount: qa.coveredCount, totalCount: qa.totalCount, canPraise: qa.canPraise, tone: tone.status, ...extra.summary, timings: { ...timings } } }; };
    if (gated) {
      send('status', { stage: 'coaching', skipped: true, code: 'low_match', message: assessment.gateMessage || 'The recording does not match what was transcribed.' });
      sp.unit({ kind: 'gate', text: QA_GATE_ZH });
      await sp.done(); if (S.closed) return;
      return send('done', finish({ corrections: [], summary: { coached: false, gate: 'low_match', gatePhraseZh: QA_GATE_ZH } }));
    }
    send('status', { stage: 'coaching' });
    const plan = planQaCoach({ qa, chk, question: q, toneFacts, toneRef: ref });
    for (const u of plan.units) sp.unit(u);
    await sp.done(); if (S.closed) return;
    send('done', finish({ corrections: plan.corrections.map(publicCorrection), summary: { coached: true, llmCalled: chk.attempts !== undefined, droppedClaims: (chk.dropped || []).length, checkAttempts: chk.attempts ?? 0 } }));
  }
}
