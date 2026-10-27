// POST /api/attempt  (multipart -> text/event-stream)
// Nothing from an attempt is persisted: audio lives only in this request's memory (multer memoryStorage),
// transcripts/coaching only in the in-memory replay record (10 min) and are never written to disk or DB.
//
// Events (in order):  status* , assessment | error , status(coaching) , coach_text* , coach_audio* , done
//   - `error` (stage 'assessment'|'transcribing') is terminal: no coaching text is ever produced without an assessment
import { Router } from 'express';
import multer from 'multer';
import { deriveFacts } from '../engines/assessment/index.js';
import { runCoach, splitSentences, hanzi, GATE_PHRASE_ZH } from '../services/coach.js';
import { rateLimit } from '../lib/ratelimit.js';
import { log } from '../config.js';

const MAX_AUDIO = 10 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const bad = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });

/** STT is used for retelling (it is the reference) and for close-rehearsal omission detection, but not for listen-and-repeat. */
export const needsTranscript = (assessMode, practiceMode) => assessMode === 'retell' || (assessMode === 'close' && practiceMode !== 'listen_repeat');

const publicCorrection = (c) => ({ kind: c.kind, targetText: c.targetText, explanationZh: c.explanationZh, modelText: c.modelText, factRef: c.factRef, source: c.source });

export function attemptRouter({ cfg, engine, services }) {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 12, fieldSize: 4096, parts: 16 } }).single('audio');
  const records = new Map(); // attemptId -> { state:'running'|'done', ok, events:[], at }
  const sweep = () => { const cut = Date.now() - 10 * 60_000; for (const [k, v] of records) if (v.at < cut && v.state !== 'running') records.delete(k); while (records.size > 200) records.delete(records.keys().next().value); };

  r.post('/attempt', rateLimit({ windowMs: 60_000, max: 30, code: 'too_many_attempts' }), (req, res, next) => {
    upload(req, res, (e) => {
      if (!e) return next();
      if (e.code === 'LIMIT_FILE_SIZE') return bad(res, 413, 'upload_too_large', 'Recording is over 10 MB. Record a shorter piece.');
      return bad(res, 400, 'invalid_upload', 'Could not read the upload (expect multipart/form-data with an "audio" file).');
    });
  }, async (req, res) => {
    // ---- validation (plain JSON errors before the stream starts)
    const b = req.body || {};
    const audio = req.file?.buffer;
    const chunkText = typeof b.chunkText === 'string' ? b.chunkText.trim() : '';
    const assessMode = b.assessMode ?? 'close';
    const practiceMode = typeof b.practiceMode === 'string' ? b.practiceMode : '';
    const attemptId = b.attemptId;
    if (b.source === 'tts' || String(req.headers['x-audio-source'] || '').toLowerCase() === 'tts') return bad(res, 400, 'tts_audio_rejected', 'Audio tagged as TTS is never assessed.');
    if (!audio || !audio.length) return bad(res, 400, 'missing_audio', 'Attach the recording as the "audio" file part.');
    if (!chunkText || [...chunkText].length > 100) return bad(res, 400, 'invalid_chunk', 'chunkText is required and must be at most 100 characters.');
    if (/[[\]【】]/.test(chunkText)) return bad(res, 400, 'stage_directions_in_chunk', 'Strip stage directions like [停顿] before sending chunkText.');
    if (!['close', 'retell'].includes(assessMode)) return bad(res, 400, 'invalid_assess_mode', 'assessMode must be "close" or "retell".');
    if (practiceMode && !['listen_repeat', 'fading_cues'].includes(practiceMode)) return bad(res, 400, 'invalid_practice_mode', 'practiceMode must be listen_repeat or fading_cues.');
    if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) return bad(res, 400, 'invalid_attempt_id', 'attemptId (8-100 chars: letters, digits . _ : -) is required; use a new one per recording attempt.');

    // ---- idempotency: replay a finished successful attempt, refuse a concurrent duplicate
    sweep();
    const prev = records.get(attemptId);
    if (prev?.state === 'running') return bad(res, 409, 'attempt_in_progress', 'This attempt is still being processed.');
    const replay = prev?.state === 'done' && prev.ok;
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(replay ? { 'X-Attempt-Replayed': 'true' } : {}) });
    res.flushHeaders();
    let closed = false;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) { closed = true; ac.abort(); } });
    const write = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    if (replay) {
      for (const [ev, d] of prev.events) write(ev, d);
      return res.end();
    }
    const rec = { state: 'running', ok: false, events: [], at: Date.now() };
    records.set(attemptId, rec);
    const send = (event, data) => { rec.events.push([event, data]); write(event, data); };
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);

    const t0 = Date.now(); const timings = {};
    const label = { engine: engine.name, mock: !!engine.mock };
    try {
      await pipeline();
    } catch (e) {
      log('error', `attempt pipeline crashed: ${e?.message}`);
      send('error', { code: 'internal_error', message: 'Something went wrong; no assessment obtained.', retryable: true, canSkip: true, stage: 'internal', ...label });
    } finally {
      clearInterval(ping);
      rec.state = 'done'; rec.at = Date.now();
      if (!closed) res.end();
    }

    async function pipeline() {
      send('status', { stage: 'uploading', ...label });
      const transcribe = needsTranscript(assessMode, practiceMode);
      const mime = req.file.mimetype || 'audio/wav';
      const sttFn = async () => { const t = Date.now(); try { return { text: await services.stt.transcribe({ audio, mime, signal: ac.signal }) }; } catch (e) { return { err: e }; } finally { timings.sttMs = Date.now() - t; } };
      const assessFn = async (text, lowConfidence) => { const t = Date.now(); const out = await engine.assess({ audio, mime, chunkText: text, attemptId, lowConfidence }); timings.assessMs = Date.now() - t; return out; };
      const terminal = (code, message, retryable, stage) => send('error', { code, message, retryable, canSkip: true, stage, ...label });

      let transcript = null; let basis = 'script'; let assessment;
      if (assessMode === 'retell') {
        if (!services.stt.available) return terminal('stt_not_configured', 'OPENAI_API_KEY is not set on the server, so retelling cannot be transcribed; no assessment obtained.', false, 'transcribing');
        send('status', { stage: 'transcribing' });
        const s = await sttFn();
        if (closed) return;
        if (s.err) return terminal(s.err.code || 'transcription_failed', 'Could not transcribe your retelling; no assessment obtained.', s.err.retryable !== false, 'transcribing');
        transcript = s.text; const ref = hanzi(transcript);
        if (!ref) return terminal('no_speech_detected', "I couldn't hear Mandarin speech in that recording. Try again.", true, 'transcribing');
        if ([...ref].length > 100) return terminal('retell_too_long', 'That retelling is too long to assess in one go (over 100 characters heard). Retell in shorter pieces.', false, 'transcribing');
        basis = 'transcript';
        send('status', { stage: 'assessing' });
        assessment = await assessFn(ref, true);
      } else if (transcribe && services.stt.available) {
        send('status', { stage: 'assessing' }); send('status', { stage: 'transcribing' });
        const [a, s] = await Promise.all([assessFn(chunkText, false), sttFn()]);
        assessment = a;
        if (s.err) send('status', { stage: 'transcribing', skipped: true, code: s.err.code || 'transcription_failed', message: 'Transcription failed; omission checks skipped (pronunciation result unaffected).' });
        else transcript = s.text;
      } else {
        send('status', { stage: 'assessing' });
        if (transcribe) send('status', { stage: 'transcribing', skipped: true, code: 'stt_not_configured', message: 'OPENAI_API_KEY not set; omission checks skipped (pronunciation result unaffected).' });
        assessment = await assessFn(chunkText, false);
      }
      if (closed) return;

      if (assessment.status !== 'ok') {
        const er = assessment.error || {};
        return terminal(er.code || 'assessment_unavailable', `No assessment obtained: ${er.message || 'the assessment service did not return a result.'}`, er.retryable !== false, 'assessment');
      }
      const facts = deriveFacts(assessment);
      const referenceText = basis === 'transcript' ? hanzi(transcript) : chunkText;
      send('assessment', { ...assessment, facts, basis, referenceText, ...(transcript !== null ? { transcript, transcriptDerived: true } : {}) });
      rec.ok = true;

      // ---- coaching + sentence-by-sentence TTS (only after a real assessment)
      const summaryBase = { ...label, overall: assessment.overall, matchesText: assessment.matchesText !== false, confirmedToneErrors: facts.confirmedToneErrors.length, uncertain: facts.uncertain.length, basis, transcriptUsed: transcript !== null };
      let idx = 0; let chain = Promise.resolve(); let ttsNoted = false; let ttsSkipNoted = false;
      const noteTts = (code, message) => { if (!ttsSkipNoted) { ttsSkipNoted = true; ttsNoted = true; send('status', { stage: 'speaking', skipped: true, code, message }); } };
      const speak = (text, index) => {
        if (!services.tts.available) return noteTts('tts_not_configured', 'No TTS provider configured; coaching is text only.');
        if (!ttsNoted) { ttsNoted = true; send('status', { stage: 'speaking', provider: services.tts.provider }); }
        const p = services.tts.synthesize({ text, voice: b.voice, speed: Number(b.speed) || undefined, signal: ac.signal }).then((v) => ({ v }), (e) => ({ e }));
        chain = chain.then(async () => {
          const x = await p; if (closed) return;
          if (x.e) return noteTts(x.e.code || 'tts_failed', 'Speech synthesis failed; coaching continues as text.');
          const id = services.audioCache.put(x.v.buf);
          if (timings.firstAudioMs === undefined) timings.firstAudioMs = Date.now() - t0;
          send('coach_audio', { url: `/api/audio/${id}.mp3`, index, text });
        });
      };
      const onUnit = (u) => {
        for (const sentence of splitSentences(u.text)) {
          const index = idx++;
          send('coach_text', { delta: sentence, index, role: u.kind });
          speak(sentence, index);
        }
      };
      // ---- GATE: the audio does not match the text => fixed Mandarin line (no LLM, no tone/sound claims), nothing else.
      if (assessment.gate === 'low_match') {
        send('status', { stage: 'coaching', skipped: true, code: 'low_match', message: assessment.gateMessage });
        onUnit({ kind: 'gate', text: GATE_PHRASE_ZH });
        await chain;
        if (closed) return;
        return send('done', { corrections: [], summary: { ...summaryBase, coached: false, gate: 'low_match', gatePhraseZh: GATE_PHRASE_ZH, timings: { ...timings, totalMs: Date.now() - t0 } } });
      }
      if (!services.llm.available) {
        send('status', { stage: 'coaching', skipped: true, code: 'llm_not_configured', message: 'OPENAI_API_KEY is not set; coaching skipped. The assessment above is real.' });
        return send('done', { corrections: [], summary: { ...summaryBase, coached: false, timings: { ...timings, totalMs: Date.now() - t0 } } });
      }
      send('status', { stage: 'coaching' });
      let result;
      try {
        result = await runCoach({ llm: services.llm, chunkText, assessMode, basis, lowConfidence: basis === 'transcript', transcript, facts, signal: ac.signal, onUnit });
      } catch (e) {
        if (closed) return;
        await chain;
        send('status', { stage: 'coaching', skipped: true, code: e.code || 'coaching_failed', message: 'Coaching failed; the assessment above is real. Retry for coaching.' });
        return send('done', { corrections: [], summary: { ...summaryBase, coached: false, timings: { ...timings, totalMs: Date.now() - t0 } } });
      }
      await chain;
      if (closed) return;
      send('done', { corrections: result.corrections.map(publicCorrection),
        summary: { ...summaryBase, coached: true, praiseZh: result.praiseZh, nextPromptZh: result.nextPromptZh, droppedCorrections: result.dropped.length, timings: { ...timings, totalMs: Date.now() - t0 } } });
    }
  });
  return r;
}
