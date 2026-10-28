// POST /api/attempt  and  POST /api/drill/attempt  (multipart -> text/event-stream)
// Nothing from an attempt is persisted: audio lives only in this request's memory (multer memoryStorage),
// transcripts/coaching only in the in-memory replay record (10 min) and are never written to disk or DB.
// (The only thing stored is the "words I don't know" list: a word, its pinyin, a gloss, counters. See lib/missed.js.)
//
// Events (in order):  status* , assessment | error , status(coaching) , coach_text* , coach_audio* , done
//   - `error` (stage 'assessment'|'transcribing') is terminal: no coaching text is ever produced without an assessment
//
// PIPELINE (latency): TonePerfect and STT start together; STT is awaited at most STT_WAIT_MS after it started. The assessment event
// goes out as soon as both are in. Fixed phrases (opener, praise, gate...) have pre-warmed TTS audio; missing/wrong-word corrections are
// built by code and spoken immediately; the LLM is only called for confirmed tone errors / retell and streams in parallel.
import { Router } from 'express';
import multer from 'multer';
import { deriveFacts } from '../engines/assessment/index.js';
import { analyzeWords, emptyWordFacts } from '../engines/assessment/words.js';
import { runCoach, splitSentences, hanzi, wordCorrection, planCorrections, factCorrection, GATE_PHRASE_ZH, FIXED_PHRASES_ZH, DRILL_OK_ZH, DRILL_RETRY_ZH } from '../services/coach.js';
import { compareMeaning, buildRetellBlock, toSimplified, planRetellCoach, RT_GATE_ZH, RETELL_PHRASES_ZH } from '../services/retell.js';
import { QA_PHRASES_ZH } from '../services/qa.js';
import { qaRoutes } from './qa.js';
import { saveMissed, fillGlosses, drillTarget } from '../lib/missed.js';
import { rateLimit } from '../lib/ratelimit.js';
import { log } from '../config.js';

const MAX_AUDIO = 10 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const GRADUATED_ZH = '这个词你学会了！';
const bad = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });

/** Kept for compatibility: STT now ALWAYS runs alongside the assessment when configured (close, retell and drills). */
export const needsTranscript = () => true;

const publicCorrection = (c) => ({ kind: c.kind, targetText: c.targetText, explanationZh: c.explanationZh, modelText: c.modelText, factRef: c.factRef, source: c.source,
  ...(c.start !== undefined ? { start: c.start, end: c.end } : {}), ...(c.pinyin ? { pinyin: c.pinyin } : {}), ...(c.meaning !== undefined ? { meaning: c.meaning } : {}),
  ...(c.heard ? { heard: c.heard } : {}), ...(c.ideaId ? { ideaId: c.ideaId } : {}), ...(c.keyPointId ? { keyPointId: c.keyPointId, chunkIndex: c.chunkIndex } : {}), ...(c.evidence ? { evidence: c.evidence } : {}) });

export function attemptRouter({ cfg, engine, services, db }) {
  const r = Router();
  const P = cfg.policy;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 12, fieldSize: 4096, parts: 16 } }).single('audio');
  const records = new Map(); // attemptId -> { state:'running'|'done', ok, events:[], at }
  const sweep = () => { const cut = Date.now() - 10 * 60_000; for (const [k, v] of records) if (v.at < cut && v.state !== 'running') records.delete(k); while (records.size > 200) records.delete(records.keys().next().value); };
  const stamp = (req, res, next) => { req._t0 = Date.now(); next(); };
  const receive = (req, res, next) => upload(req, res, (e) => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return bad(res, 413, 'upload_too_large', 'Recording is over 10 MB. Record a shorter piece.');
    return bad(res, 400, 'invalid_upload', 'Could not read the upload (expect multipart/form-data with an "audio" file).');
  });

  /** Shared SSE plumbing: idempotent replay, concurrency guard, ping, timings. `run(S)` does the work. */
  function stream(req, res, attemptId, run) {
    sweep();
    const prev = records.get(attemptId);
    if (prev?.state === 'running') return bad(res, 409, 'attempt_in_progress', 'This attempt is still being processed.');
    const replay = prev?.state === 'done' && prev.ok;
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(replay ? { 'X-Attempt-Replayed': 'true' } : {}) });
    res.flushHeaders();
    const S = { closed: false, ac: new AbortController(), t0: Date.now(), timings: { receiveMs: req._t0 ? Date.now() - req._t0 : 0, transcodeMs: 0 } };
    res.on('close', () => { if (!res.writableFinished) { S.closed = true; S.ac.abort(); } });
    const write = (event, data) => { if (!S.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    if (replay) { for (const [ev, d] of prev.events) write(ev, d); return res.end(); }
    const rec = { state: 'running', ok: false, events: [], at: Date.now() };
    records.set(attemptId, rec);
    S.send = (event, data) => { rec.events.push([event, data]); write(event, data); };
    S.markOk = () => { rec.ok = true; };
    S.label = { engine: engine.name, mock: !!engine.mock };
    S.terminal = (code, message, retryable, stage) => S.send('error', { code, message, retryable, canSkip: true, stage, ...S.label });
    const ping = setInterval(() => { if (!S.closed) res.write(': ping\n\n'); }, 15_000);
    return (async () => {
      try { await run(S); } catch (e) {
        log('error', `attempt pipeline crashed: ${e?.message}`);
        S.send('error', { code: 'internal_error', message: 'Something went wrong; no assessment obtained.', retryable: true, canSkip: true, stage: 'internal', ...S.label });
      } finally {
        clearInterval(ping); rec.state = 'done'; rec.at = Date.now();
        if (!S.closed) res.end();
        if (S.timings.totalMs !== undefined) log('info', `attempt timings ${JSON.stringify(S.timings)}`); // numbers only: no content, no keys
      }
    })();
  }

  /** TonePerfect ‖ STT. Returns { assessment, transcript, stt:{status,ms,reason?} }. STT is awaited at most STT_WAIT_MS from its start. */
  async function takeAssessment(S, { audio, mime, chunkText, attemptId, wantStt = true, lowConfidence = false }) {
    const sttOn = wantStt && services.stt.available;
    const T = S.timings;
    let transcript = null; const stt = { status: sttOn ? 'ok' : 'unavailable', reason: sttOn ? undefined : (wantStt ? 'stt_not_configured' : 'not_requested') };
    const sttStart = Date.now(); const sttAc = new AbortController();
    const kill = () => sttAc.abort();
    S.ac.signal.addEventListener('abort', kill, { once: true });
    const sttP = sttOn ? services.stt.transcribe({ audio, mime, signal: sttAc.signal }).then((text) => ({ text }), (e) => ({ err: e })).finally(() => { T.sttMs = Date.now() - sttStart; }) : Promise.resolve(null);
    S.send('status', { stage: 'assessing' });
    if (sttOn) S.send('status', { stage: 'transcribing' });
    const t = Date.now();
    const assessment = await engine.assess({ audio, mime, chunkText, attemptId, lowConfidence }).finally(() => { T.assessMs = Date.now() - t; });
    if (sttOn && assessment?.status === 'ok') {
      const waitStart = Date.now();
      const timer = new Promise((res) => { const left = Math.max(0, P.STT_WAIT_MS - (Date.now() - sttStart)); const h = setTimeout(() => res('timeout'), left); h.unref?.(); });
      const out = await Promise.race([sttP, timer]);
      T.sttWaitMs = Date.now() - waitStart;
      if (out === 'timeout') { stt.status = 'timeout'; stt.reason = 'stt_timeout'; kill(); }
      else if (out?.err) { stt.status = 'failed'; stt.reason = out.err.code || 'transcription_failed'; }
      else transcript = out?.text ?? null;
      if (stt.status !== 'ok') S.send('status', { stage: 'transcribing', skipped: true, code: stt.reason, message: 'Transcription unavailable; word-completeness check reduced to acoustic evidence (pronunciation result unaffected).' });
    } else if (sttOn) kill();
    else if (wantStt) S.send('status', { stage: 'transcribing', skipped: true, code: 'stt_not_configured', message: 'OPENAI_API_KEY not set; word-completeness check reduced to acoustic evidence (pronunciation result unaffected).' });
    S.ac.signal.removeEventListener('abort', kill);
    stt.ms = T.sttMs ?? Date.now() - sttStart;
    return { assessment, transcript, stt };
  }

  /** Per-sentence TTS with ordered coach_audio events. */
  function speaker(S, b) {
    let idx = 0; let chain = Promise.resolve(); let noted = false; let skipNoted = false; let ttsReqStart = null;
    const note = (code, message) => { if (!skipNoted) { skipNoted = true; noted = true; S.send('status', { stage: 'speaking', skipped: true, code, message }); } };
    const speak = (text, index) => {
      if (!services.tts.available) return note('tts_not_configured', 'No TTS provider configured; coaching is text only.');
      if (!noted) { noted = true; S.send('status', { stage: 'speaking', provider: services.tts.provider }); }
      const t = Date.now(); ttsReqStart ??= t;
      const p = services.tts.synthesize({ text, voice: b.voice, speed: Number(b.speed) || undefined, signal: S.ac.signal }).then((v) => ({ v }), (e) => ({ e }));
      chain = chain.then(async () => {
        const x = await p; if (S.closed) return;
        if (x.e) return note(x.e.code || 'tts_failed', 'Speech synthesis failed; coaching continues as text.');
        const id = services.audioCache.put(x.v.buf);
        if (S.timings.firstAudioMs === undefined) { S.timings.firstAudioMs = Date.now() - S.t0; S.timings.ttsFirstAudioMs = Date.now() - ttsReqStart; S.timings.ttsFirstCached = !!x.v.cached; }
        S.send('coach_audio', { url: `/api/audio/${id}.mp3`, index, text });
      });
    };
    const unit = (u) => {
      for (const sentence of splitSentences(u.text)) {
        const index = idx++;
        if (S.timings.firstCoachTextMs === undefined) S.timings.firstCoachTextMs = Date.now() - S.t0;
        S.send('coach_text', { delta: sentence, index, role: u.kind, ...(u.correction?.caption && u.kind === 'correction' ? { caption: u.correction.caption } : {}), ...(u.correction?.start !== undefined ? { start: u.correction.start, end: u.correction.end } : {}) });
        speak(sentence, index);
      }
    };
    return { unit, done: () => chain };
  }

  const warmTts = (b) => { services.tts.warm?.({ phrases: [...FIXED_PHRASES_ZH, ...RETELL_PHRASES_ZH, ...QA_PHRASES_ZH], voice: b.voice, speed: Number(b.speed) || undefined })?.catch?.(() => {}); };
  const meaningOf = (text) => db.getMissedByText(text)?.meaning ?? null;

  /** Word analysis + facts + auto-save. */
  function analyse({ assessment, chunkText, transcript, stt, save }) {
    const base = deriveFacts(assessment);
    const t = Date.now();
    const a = analyzeWords({ chunkText, assessment, transcript, stt, policy: P });
    const facts = { ...base, ...a.facts, confirmedToneErrors: assessment.gate === 'low_match' ? [] : a.confirmedToneErrors };
    const savedMissed = save && assessment.gate !== 'low_match' ? saveMissed(db, facts, chunkText, P) : [];
    return { facts, wordStatus: a.wordStatus, savedMissed, analysisMs: Date.now() - t };
  }

  // =================================================================== POST /api/attempt
  r.post('/attempt', stamp, rateLimit({ windowMs: 60_000, max: 30, code: 'too_many_attempts' }), receive, async (req, res) => {
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
    warmTts(b);
    await stream(req, res, attemptId, (S) => attemptPipeline(S, { req, b, audio, chunkText, assessMode, attemptId }));
  });

  async function attemptPipeline(S, { req, b, audio, chunkText, assessMode, attemptId }) {
    const { send, timings } = S; const label = S.label;
    send('status', { stage: 'uploading', ...label });
    const mime = req.file.mimetype || 'audio/wav';
    let transcript = null; let basis = 'script'; let assessment; let stt = { status: 'not_run' }; let coachText = chunkText;
    if (assessMode === 'retell') return retellPipeline(S, { b, audio, mime, chunkText, attemptId });
    {
      const out = await takeAssessment(S, { audio, mime, chunkText, attemptId });
      assessment = out.assessment; transcript = out.transcript; stt = out.stt;
    }
    if (S.closed) return;
    if (assessment.status !== 'ok') {
      const er = assessment.error || {};
      return S.terminal(er.code || 'assessment_unavailable', `No assessment obtained: ${er.message || 'the assessment service did not return a result.'}`, er.retryable !== false, 'assessment');
    }

    // ---- word-level analysis (script modes only), facts, auto-save
    let facts; let wordStatus = []; let savedMissed = [];
    if (basis === 'script') { const a = analyse({ assessment, chunkText, transcript, stt, save: true }); ({ facts, wordStatus, savedMissed } = a); timings.analysisMs = a.analysisMs; }
    else facts = { ...deriveFacts(assessment), ...emptyWordFacts() };
    const referenceText = basis === 'transcript' ? hanzi(transcript) : chunkText;
    send('assessment', { ...assessment, facts, wordStatus, savedMissed, basis, referenceText, ...(transcript !== null ? { transcript, transcriptDerived: true } : {}) });
    S.markOk();

    // ---- coaching + sentence-by-sentence TTS (only after a real assessment)
    const summaryBase = { ...label, overall: assessment.overall, matchesText: assessment.matchesText !== false, confirmedToneErrors: facts.confirmedToneErrors.length, uncertain: facts.uncertain.length,
      missingWords: facts.missingWords.length, substitutedWords: facts.substitutedWords.length, completeness: facts.completeness, basis, transcriptUsed: transcript !== null, ...(facts.stt ? { stt: facts.stt.status } : {}) };
    const finish = (extra) => { timings.totalMs = Date.now() - S.t0; return { ...extra, timings: { ...timings }, summary: { ...summaryBase, ...extra.summary, timings: { ...timings } } }; };
    const sp = speaker(S, b);
    const afterDone = () => { if (savedMissed.length) fillGlosses(db, services.llm, savedMissed.map((x) => x.id)).catch(() => {}); };
    // GATE: the audio does not match the text => fixed Mandarin line (no LLM, no tone/sound claims), nothing else.
    if (assessment.gate === 'low_match') {
      send('status', { stage: 'coaching', skipped: true, code: 'low_match', message: assessment.gateMessage });
      sp.unit({ kind: 'gate', text: GATE_PHRASE_ZH });
      await sp.done(); if (S.closed) return;
      return send('done', finish({ corrections: [], summary: { coached: false, gate: 'low_match', gatePhraseZh: GATE_PHRASE_ZH } }));
    }
    const plan = planCorrections(facts, coachText, meaningOf);
    const llmNeeded = assessMode === 'retell' || plan.toneSlots > 0;
    if (llmNeeded && !services.llm.available && !plan.hard.length) {
      send('status', { stage: 'coaching', skipped: true, code: 'llm_not_configured', message: 'OPENAI_API_KEY is not set; coaching skipped. The assessment above is real.' });
      afterDone();
      return send('done', finish({ corrections: [], summary: { coached: false } }));
    }
    send('status', { stage: 'coaching' });
    let result;
    try {
      result = await runCoach({ llm: services.llm, chunkText, assessMode, basis, lowConfidence: basis === 'transcript', transcript, facts, signal: S.ac.signal, onUnit: sp.unit, meaningOf, seed: attemptId, timings, llmTone: cfg.coachLlmTone });
    } catch (e) {
      if (S.closed) return;
      await sp.done();
      send('status', { stage: 'coaching', skipped: true, code: e.code || 'coaching_failed', message: 'Coaching failed; the assessment above is real. Retry for coaching.' });
      afterDone();
      return send('done', finish({ corrections: [], summary: { coached: false } }));
    }
    await sp.done();
    if (S.closed) return;
    afterDone();
    send('done', finish({ corrections: result.corrections.map(publicCorrection), summary: { coached: true, praiseZh: result.praiseZh, nextPromptZh: result.nextPromptZh, droppedCorrections: result.dropped.length, llmCalled: result.llmCalled } }));
  }


  // =================================================================== RETELL (free retelling, meaning comparison)
  // STT (needed first) -> [ meaning-comparison LLM  ||  TonePerfect on the TRANSCRIPT ] -> assessment{retell} -> code-built coaching.
  // The tone check uses the transcript (hanzi only) as the reference, lowConfidence:true; it is OPTIONAL: skipped when the transcript has digits/latin or
  // is > 100 hanzi (TonePerfect refuses those), or when TonePerfect fails / times out (RETELL_TONE_WAIT_MS). It is also a cross-check: audio that does not
  // match its own transcript (gate low_match: noise, STT hallucination) makes the meaning comparison "unavailable" instead of accusing the learner.
  async function retellPipeline(S, { b, audio, mime, chunkText, attemptId }) {
    const { send, timings } = S; const label = S.label;
    if (!services.stt.available) return S.terminal('stt_not_configured', 'OPENAI_API_KEY is not set on the server, so retelling cannot be transcribed; no assessment obtained.', false, 'transcribing');
    send('status', { stage: 'transcribing' });
    const t = Date.now(); let transcript;
    try { transcript = toSimplified(await services.stt.transcribe({ audio, mime, signal: S.ac.signal })); } catch (e) { timings.sttMs = Date.now() - t; if (S.closed) return; return S.terminal(e.code || 'transcription_failed', 'Could not transcribe your retelling; no assessment obtained.', e.retryable !== false, 'transcribing'); }
    timings.sttMs = Date.now() - t; // `transcript` is normalised to simplified characters (STT sometimes answers in traditional)
    if (S.closed) return;
    const ref = hanzi(transcript);
    if (!ref) return S.terminal('no_speech_detected', "I couldn't hear Mandarin speech in that recording. Try again.", true, 'transcribing');
    if ([...ref].length > P.RETELL_MAX_TRANSCRIPT_HANZI) return S.terminal('retell_too_long', `That retelling is too long to assess in one go (over ${P.RETELL_MAX_TRANSCRIPT_HANZI} characters heard). Retell in shorter pieces.`, false, 'transcribing');

    send('status', { stage: 'assessing', detail: 'meaning' });
    const compareP = compareMeaning({ llm: services.llm, chunkText, transcript, signal: S.ac.signal, model: cfg.openai.retellModel, timings, maxMs: P.RETELL_COMPARE_MAX_MS });
    let toneSkip = null;
    if (/[A-Za-z0-9]/.test(String(transcript).normalize('NFKC'))) toneSkip = 'transcript_has_digits_or_latin';
    else if ([...ref].length > 100) toneSkip = 'transcript_too_long_for_tone';
    const toneStart = Date.now();
    const toneP = toneSkip ? null : engine.assess({ audio, mime, chunkText: ref, attemptId, lowConfidence: true })
      .catch((e) => ({ status: 'unavailable', error: { code: 'assessment_unavailable', message: String(e?.message || 'assessment failed').slice(0, 120), retryable: true } }))
      .finally(() => { timings.assessMs = Date.now() - toneStart; });
    let cmp = await compareP;
    if (S.closed) return;
    let assessment = null; let tone = { status: 'skipped', reason: toneSkip };
    if (toneP) {
      const left = Math.max(0, P.RETELL_TONE_WAIT_MS - (Date.now() - toneStart)); const w0 = Date.now(); let h;
      const out = await Promise.race([toneP, new Promise((res) => { h = setTimeout(() => res('timeout'), left); h.unref?.(); })]); clearTimeout(h);
      timings.toneWaitMs = Date.now() - w0; // time spent waiting for TonePerfect AFTER the meaning comparison was ready
      if (S.closed) return;
      if (out === 'timeout') tone = { status: 'skipped', reason: 'tone_check_timeout' };
      else if (out?.status !== 'ok') tone = { status: 'skipped', reason: out?.error?.code || 'assessment_unavailable', ...(out?.error?.message ? { message: out.error.message } : {}) };
      else if (out.gate === 'low_match') { assessment = out; tone = { status: 'skipped', reason: 'low_match' }; cmp = { status: 'unavailable', reason: 'low_match' }; }
      else { assessment = out; tone = { status: 'ok' }; }
    }
    if (cmp.status !== 'ok' && !assessment) {
      return S.terminal(tone.reason === 'tone_check_timeout' || !toneP ? 'assessment_unavailable' : tone.reason, `No assessment obtained: the meaning comparison was unavailable (${cmp.reason}) and ${toneP ? 'the tone check failed' : 'no tone check was possible'}.`, true, 'assessment');
    }
    const gated = assessment?.gate === 'low_match';
    const toneFacts = assessment && !gated ? deriveFacts(assessment).confirmedToneErrors : [];
    const retell = buildRetellBlock({ cmp, chunkText, transcript, stt: { status: 'ok' }, tone, meaningOf });
    const shown = assessment || { status: 'ok', engine: engine.name, mock: !!engine.mock, overall: null, syllables: [], words: [], matchesText: null, gate: null, lowConfidence: true };
    const facts = { ...(assessment ? deriveFacts(assessment) : { confirmedToneErrors: [], uncertain: [] }), ...emptyWordFacts(), canPraise: retell.canPraise, completeness: 'unknown' };
    facts.confirmedToneErrors = toneFacts;
    send('assessment', { ...shown, lowConfidence: true, facts, wordStatus: [], savedMissed: [], basis: 'transcript', referenceText: ref, transcript, transcriptDerived: true, retell });
    S.markOk();

    const sp = speaker(S, b);
    const finish = (extra) => { timings.totalMs = Date.now() - S.t0; return { ...extra, timings: { ...timings }, summary: { ...label, basis: 'transcript', transcriptUsed: true, confirmedToneErrors: toneFacts.length, comparisonStatus: retell.comparisonStatus, coveredCount: retell.coveredCount, totalCount: retell.totalCount, canPraise: retell.canPraise, tone: tone.status, ...extra.summary, timings: { ...timings } } }; };
    if (gated) {
      send('status', { stage: 'coaching', skipped: true, code: 'low_match', message: assessment.gateMessage || 'The recording does not match what was transcribed.' });
      sp.unit({ kind: 'gate', text: RT_GATE_ZH });
      await sp.done(); if (S.closed) return;
      return send('done', finish({ corrections: [], summary: { coached: false, gate: 'low_match', gatePhraseZh: RT_GATE_ZH } }));
    }
    send('status', { stage: 'coaching' });
    const plan = planRetellCoach({ retell, cmp, chunkText, toneFacts, toneRef: ref });
    for (const u of plan.units) sp.unit(u);
    await sp.done(); if (S.closed) return;
    send('done', finish({ corrections: plan.corrections.map(publicCorrection), summary: { coached: true, llmCalled: cmp.attempts !== undefined || cmp.status === 'ok', droppedIdeas: (cmp.dropped || []).length, compareAttempts: cmp.attempts ?? 0 } }));
  }

  // =================================================================== POST /api/drill/attempt
  r.post('/drill/attempt', stamp, rateLimit({ windowMs: 60_000, max: 40, code: 'too_many_attempts' }), receive, async (req, res) => {
    const b = req.body || {};
    const audio = req.file?.buffer; const attemptId = b.attemptId;
    if (b.source === 'tts' || String(req.headers['x-audio-source'] || '').toLowerCase() === 'tts') return bad(res, 400, 'tts_audio_rejected', 'Audio tagged as TTS is never assessed.');
    if (!audio || !audio.length) return bad(res, 400, 'missing_audio', 'Attach the recording as the "audio" file part.');
    if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) return bad(res, 400, 'invalid_attempt_id', 'attemptId (8-100 chars: letters, digits . _ : -) is required; use a new one per recording attempt.');
    const wordId = /^\d{1,12}$/.test(String(b.wordId ?? '')) ? Number(b.wordId) : null;
    const word = wordId == null ? null : db.getMissed(wordId);
    if (!word) return bad(res, 404, 'not_found', 'No such word in the missed-words list (wordId).');
    warmTts(b);
    await stream(req, res, attemptId, (S) => drillPipeline(S, { req, b, audio, word, attemptId }));
  });

  async function drillPipeline(S, { req, b, audio, word, attemptId }) {
    const { send, timings } = S; const label = S.label;
    send('status', { stage: 'uploading', ...label });
    const mime = req.file.mimetype || 'audio/wav';
    const tgt = drillTarget(word); const needed = cfg.drillGraduateStreak;
    const out = await takeAssessment(S, { audio, mime, chunkText: tgt.promptText, attemptId });
    const { assessment, transcript, stt } = out;
    if (S.closed) return;
    if (assessment.status !== 'ok') {
      const er = assessment.error || {};
      return S.terminal(er.code || 'assessment_unavailable', `No assessment obtained: ${er.message || 'the assessment service did not return a result.'}`, er.retryable !== false, 'assessment');
    }
    const a = analyse({ assessment, chunkText: tgt.promptText, transcript, stt, save: false });
    timings.analysisMs = a.analysisMs;
    const span = a.wordStatus.filter((w) => w.start >= tgt.start && w.end <= tgt.end);
    const gated = assessment.gate === 'low_match';
    // Server-side verdict (the client cannot fake it): every character of the target word is ok / merely tone-or-sound-uncertain.
    const correct = !gated && span.length > 0 && span.every((w) => w.status === 'ok' || (w.status === 'uncertain' && w.reason !== 'low_score'));
    send('assessment', { ...assessment, facts: a.facts, wordStatus: a.wordStatus, savedMissed: [], basis: 'script', referenceText: tgt.promptText, target: { wordId: word.id, text: word.text, start: tgt.start, end: tgt.end }, ...(transcript !== null ? { transcript, transcriptDerived: true } : {}) });
    S.markOk();

    let counted = false; let after = word; let graduated = false;
    if (!gated) {
      counted = true;
      const rr = db.recordDrill(word.id, correct, needed);
      if (rr) { after = rr.word; graduated = rr.graduated; }
    }
    const sp = speaker(S, b);
    send('status', { stage: 'coaching' });
    if (gated) {
      sp.unit({ kind: 'gate', text: GATE_PHRASE_ZH });
    } else if (correct) {
      sp.unit({ kind: 'praise', text: graduated ? GRADUATED_ZH : DRILL_OK_ZH });
    } else {
      // one short correction for the target word, built by code from facts only
      const f = a.facts; const inSpan = (w) => w.start >= tgt.start && w.end <= tgt.end;
      const pick = f.missingWords.find(inSpan) && wordCorrection('missing', f.missingWords.find(inSpan), tgt.promptText, after.meaning)
        || f.substitutedWords.find(inSpan) && wordCorrection('substituted', f.substitutedWords.find(inSpan), tgt.promptText, after.meaning)
        || f.confirmedToneErrors.filter((t) => t.start >= tgt.start && t.end <= tgt.end).map((t) => factCorrection(t, word.text))[0]
        || f.unclearWords.find(inSpan) && wordCorrection('unclear', f.unclearWords.find(inSpan), tgt.promptText, after.meaning);
      const c = pick || { kind: 'model', targetText: word.text, modelText: word.text, explanationZh: '再听一听标准读法。', factRef: null, source: 'server_fact' };
      const cc = { ...c, modelText: word.text.length >= 2 ? word.text : c.modelText };
      sp.unit({ kind: 'correction', text: cc.explanationZh, correction: cc });
      sp.unit({ kind: 'correction_model', text: `应该这样说：${cc.modelText}`, correction: cc });
      sp.unit({ kind: 'next', text: DRILL_RETRY_ZH });
      out.correction = cc;
    }
    await sp.done(); if (S.closed) return;
    timings.totalMs = Date.now() - S.t0;
    send('done', { correct, counted, correctStreak: after.correctStreak, needed, graduated, wordId: word.id, ...(gated ? { reason: 'low_match' } : {}), corrections: out.correction ? [publicCorrection(out.correction)] : [], timings: { ...timings } });
  }

  qaRoutes(r, { cfg, engine, services, db, bad, stamp, stream, speaker, warmTts, meaningOf, publicCorrection, ID_RE });
  return r;
}
