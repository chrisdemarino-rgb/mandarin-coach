// FREE TALK: POST /api/talk/turn (multipart -> SSE) | /api/talk/opening | /api/talk/summary.  See API-ATTEMPT.md "Free talk".
// STATELESS: nothing is stored (no conversation, transcript, audio). The client sends the last turns' TEXT with every call.
// The only things kept in memory are the idempotent replay record (10 min, like every attempt) and the TTS audio cache (mp3 of the coach's own voice).
import multer from 'multer';
import { deriveFacts } from '../engines/assessment/index.js';
import { emptyWordFacts } from '../engines/assessment/words.js';
import { hanzi } from '../services/coach.js';
import { toSimplified, toneCorrection, hz } from '../services/retell.js';
import { parseTalkContext, parseScriptVocab, parseSummaryRequest, talkStats, talkGate, streamReply, findCorrection, generateOpening, generateSummary, pinyinOf, parseScript, generateUpgrade, upgradeSaveable,
  TALK_GATE_ZH, TALK_FALLBACK_ZH, TALK_THEN_ZH, TALK_NATURAL_ZH, TALK_MODEL_PREFIX_ZH, TALK_MAX_TOPIC } from '../services/talk.js';
import { rateLimit } from '../lib/ratelimit.js';

const MAX_AUDIO = 10 * 1024 * 1024;
const cpLen = (s) => Array.from(String(s ?? '')).length;
const race = (p, ms) => { let h; return Promise.race([p, new Promise((res) => { h = setTimeout(() => res('timeout'), Math.max(0, ms)); h.unref?.(); })]).finally(() => clearTimeout(h)); };

export function talkRoutes(r, { cfg, engine, services, db, bad, stamp, stream, speaker, warmTts, meaningOf, ID_RE }) {
  const P = cfg.policy; const model = cfg.openai.talkModel;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 8, fieldSize: 64 * 1024, parts: 12 } }).single('audio');
  const receive = (req, res, next) => upload(req, res, (e) => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return bad(res, 413, 'upload_too_large', 'Recording is over 10 MB. Record a shorter turn.');
    if (e.code === 'LIMIT_FIELD_VALUE') return bad(res, 413, 'context_too_large', 'The context field is too large (send only the last few turns).');
    return bad(res, 400, 'invalid_upload', 'Could not read the upload (expect multipart/form-data with an "audio" file and a "context" field).');
  });

  // =================================================================== POST /api/talk/opening
  r.post('/talk/opening', rateLimit({ windowMs: 60_000, max: 40, code: 'too_many_requests' }), async (req, res) => {
    const t0 = Date.now(); const b = req.body || {};
    if (typeof b.topic !== 'string' || !b.topic.trim() || cpLen(b.topic.trim()) > TALK_MAX_TOPIC) return bad(res, 400, 'invalid_topic', `topic must be a non-empty string of at most ${TALK_MAX_TOPIC} characters.`);
    if (b.level != null && !['easy', 'normal'].includes(b.level)) return bad(res, 400, 'invalid_level', 'level must be "easy" or "normal".');
    const vocab = parseScriptVocab(b.scriptVocab); if (vocab.error) return bad(res, vocab.error.status, vocab.error.code, vocab.error.message);
    const sc = parseScript(b.script); if (sc.error) return bad(res, sc.error.status, sc.error.code, sc.error.message);
    if (!services.llm?.available) return bad(res, 503, 'llm_not_configured', 'OPENAI_API_KEY is not set on the server, so the opening cannot be generated.');
    const timings = {};
    const gen = await generateOpening({ llm: services.llm, topic: b.topic.trim(), scriptVocab: vocab.list, level: b.level || 'normal', script: sc.script, model, timings, maxMs: P.TALK_OPENING_MAX_MS });
    if (gen.status !== 'ok') return bad(res, gen.reason === 'llm_not_configured' ? 503 : 502, 'opening_generation_failed', `Could not produce an opening (${gen.reason}). Try again.`);
    const out = { ok: true, textZh: gen.textZh, pinyin: gen.pinyin, scriptUsed: !!sc.script };
    let audioMs = null;
    if (req.query.audio === '1' && services.tts.available) {
      const a0 = Date.now();
      try {
        const v = await services.tts.synthesize({ text: gen.textZh, voice: typeof req.query.voice === 'string' ? req.query.voice : undefined, speed: Number(req.query.speed) || undefined });
        out.textAudio = { url: `/api/audio/${services.audioCache.put(v.buf)}.mp3` };
      } catch { /* the client can still call POST /api/tts */ }
      audioMs = Date.now() - a0;
    }
    out.timings = { openingMs: timings.openingMs, llmAttempts: gen.attempts, ...(audioMs !== null ? { audioMs } : {}), totalMs: Date.now() - t0 };
    res.json(out);
  });

  // =================================================================== POST /api/talk/summary
  r.post('/talk/summary', rateLimit({ windowMs: 60_000, max: 20, code: 'too_many_requests' }), async (req, res) => {
    const t0 = Date.now();
    const v = parseSummaryRequest(req.body); if (v.error) return bad(res, v.error.status, v.error.code, v.error.message);
    if (!services.llm?.available) return bad(res, 503, 'llm_not_configured', 'OPENAI_API_KEY is not set on the server, so the summary cannot be generated.');
    const timings = {};
    const gen = await generateSummary({ llm: services.llm, req: v.value, model, timings, maxMs: P.TALK_SUMMARY_MAX_MS });
    if (gen.status !== 'ok') return bad(res, gen.reason === 'llm_not_configured' ? 503 : 502, 'summary_generation_failed', `Could not produce a summary (${gen.reason}). Try again.`);
    const { status, attempts, dropped, ...body } = gen;
    body.newWords = body.newWords.map((w) => ({ ...w, ...(meaningOf(w.text) ? { savedMeaning: meaningOf(w.text) } : {}) }));
    res.json({ ok: true, ...body, statsDerived: talkStats(v.value.turns), timings: { summaryMs: timings.summaryMs, llmAttempts: attempts, droppedItems: dropped.length, totalMs: Date.now() - t0 } });
  });

  // =================================================================== POST /api/talk/turn  (multipart -> text/event-stream)
  r.post('/talk/turn', stamp, rateLimit({ windowMs: 60_000, max: 40, code: 'too_many_attempts' }), receive, async (req, res) => {
    const b = req.body || {}; const audio = req.file?.buffer; const attemptId = b.attemptId;
    if (b.source === 'tts' || String(req.headers['x-audio-source'] || '').toLowerCase() === 'tts') return bad(res, 400, 'tts_audio_rejected', 'Audio tagged as TTS is never assessed.');
    if (!audio || !audio.length) return bad(res, 400, 'missing_audio', 'Attach the recording as the "audio" file part.');
    if (typeof b.context !== 'string' || !b.context.trim()) return bad(res, 400, 'invalid_context', 'context (JSON string: {topic, scriptVocab?, turns?, level?, tone?}) is required.');
    const parsed = parseTalkContext(b.context); if (parsed.error) return bad(res, parsed.error.status, parsed.error.code, parsed.error.message);
    if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) return bad(res, 400, 'invalid_attempt_id', 'attemptId (8-100 chars: letters, digits . _ : -) is required; use a new one per recording.');
    warmTts(b);
    await stream(req, res, attemptId, (S) => talkPipeline(S, { req, b, audio, ctx: parsed.ctx, attemptId }));
  });

  async function talkPipeline(S, { req, b, audio, ctx, attemptId }) {
    const { send, timings } = S; const mime = req.file.mimetype || 'audio/wav';
    if (!services.llm?.available) return S.terminal('llm_not_configured', 'OPENAI_API_KEY is not set on the server, so the coach cannot reply.', false, 'coaching');
    if (!services.stt.available) return S.terminal('stt_not_configured', 'OPENAI_API_KEY is not set on the server, so speech cannot be transcribed.', false, 'transcribing');
    send('status', { stage: 'transcribing' });
    const t = Date.now(); let transcript;
    try { transcript = toSimplified(await services.stt.transcribe({ audio, mime, signal: S.ac.signal })); } catch (e) { timings.sttMs = Date.now() - t; if (S.closed) return; return S.terminal(e.code || 'transcription_failed', 'Could not transcribe your speech.', e.retryable !== false, 'transcribing'); }
    timings.sttMs = Date.now() - t;
    if (S.closed) return;
    const ref = hanzi(transcript); const hanziCount = hz(transcript).length; const hasEnglish = /[A-Za-z]{2,}/.test(transcript);
    const gate = talkGate(transcript);
    if (hanziCount > P.TALK_MAX_TRANSCRIPT_HANZI) return S.terminal('talk_turn_too_long', `That turn is too long to coach (over ${P.TALK_MAX_TRANSCRIPT_HANZI} characters heard). Say a few sentences at a time.`, false, 'transcribing');
    send('transcript', { text: transcript, sttStatus: gate || 'ok', hanziCount, hasEnglish });
    const sp = speaker(S, b);
    const finish = (extra) => { timings.totalMs = Date.now() - S.t0; return { ...extra, timings: { ...timings }, summary: { basis: 'transcript', transcriptUsed: true, turnsUsed: ctx.turnsUsed, turnsSent: ctx.turnsSent, ...extra.summary } }; };
    if (gate) {
      send('status', { stage: 'coaching', skipped: true, code: 'no_speech', message: 'Nothing usable was heard.' });
      sp.unit({ kind: 'gate', text: TALK_GATE_ZH });
      await sp.done(); if (S.closed) return;
      S.markOk();
      return send('done', finish({ gate, correction: null, correctionStatus: 'skipped', suggestedWords: [], vocabHints: [], replyZh: null, questionZh: null, replyPinyin: null, questionPinyin: null, onTopic: null, upgrade: null, upgradeStatus: ctx.script ? 'skipped' : 'no_script', saveable: [], summary: { coached: false, llmCalled: false, tone: 'skipped' } }));
    }

    send('status', { stage: 'coaching' });
    // optional tone check on the TRANSCRIPT (same policy as retell/Q&A); default skipped
    let toneSkip = ctx.tone ? null : 'not_requested';
    if (ctx.tone) { if (/[A-Za-z0-9]/.test(String(transcript).normalize('NFKC'))) toneSkip = 'transcript_has_digits_or_latin'; else if (hanziCount > 100) toneSkip = 'transcript_too_long_for_tone'; else if (!ref) toneSkip = 'no_hanzi'; }
    const toneStart = Date.now();
    const toneP = toneSkip ? null : engine.assess({ audio, mime, chunkText: ref, attemptId, lowConfidence: true })
      .catch((e) => ({ status: 'unavailable', error: { code: 'assessment_unavailable', message: String(e?.message || 'assessment failed').slice(0, 120), retryable: true } }))
      .finally(() => { timings.assessMs = Date.now() - toneStart; });

    // two parallel LLM calls: the streamed conversational reply (spoken as soon as it arrives) and the correction finder (arrives while the reply is spoken)
    const findStart = Date.now();
    const findP = findCorrection({ llm: services.llm, ctx, transcript, signal: S.ac.signal, model, timings, maxMs: P.TALK_FIND_MAX_MS });
    // 3rd parallel call (only with a script): the script-grounded upgrade; never spoken, awaited (bounded) just before done
    const upStart = Date.now();
    const upP = ctx.script ? generateUpgrade({ llm: services.llm, ctx, transcript, signal: S.ac.signal, model, timings, maxMs: P.TALK_UPGRADE_MAX_MS }).catch(() => ({ status: 'unavailable', reason: 'upgrade_failed', attempts: 0 })) : null;
    const reply = await streamReply({ llm: services.llm, ctx, transcript, signal: S.ac.signal, model, timings, maxMs: P.TALK_REPLY_MAX_MS, onReply: (sentences) => { if (!S.closed) sp.unit({ kind: 'reply', text: sentences.join('') }); } });
    if (S.closed) return;
    if (reply.status === 'unavailable') return S.terminal(reply.reason === 'llm_not_configured' ? 'llm_not_configured' : 'talk_llm_unavailable', `The coach could not reply right now (${reply.reason}). No reply was made up.`, reply.reason !== 'llm_not_configured', 'coaching');
    let degraded = null;
    if (reply.status === 'malformed') { degraded = 'reply_malformed'; sp.unit({ kind: 'reply', text: TALK_FALLBACK_ZH }); }
    const questionText = reply.status === 'ok' ? (reply.questionSentences[0] || TALK_THEN_ZH) : null;
    const askQuestion = () => { if (questionText) sp.unit({ kind: 'question', text: questionText }); };

    // wait (bounded) for the finder, then speak: [correction + model | vocab hint | natural] then the question
    let find = await race(findP, P.TALK_FIND_WAIT_MS - (Date.now() - findStart));
    let late = false;
    if (find === 'timeout') { late = true; if (!degraded) askQuestion(); find = await race(findP, P.TALK_FIND_MAX_MS + 500 - (Date.now() - findStart)); if (find === 'timeout') find = null; }
    if (S.closed) return;
    const findOk = find?.status === 'ok';
    let correction = findOk ? find.correction : null; let correctionStatus = findOk ? (correction ? 'ok' : 'none') : find ? `unavailable:${find.reason}` : 'timeout';
    const vocabHints = findOk ? find.vocabHints : [];

    // tone (only with tone:true, only from the acoustic engine): wait bounded, emit the assessment, a confirmed error is the (single) correction when there is no text correction
    let tone = { status: 'skipped', reason: toneSkip };
    if (toneP) {
      const left = P.TALK_TONE_WAIT_MS - (Date.now() - toneStart); const w0 = Date.now();
      const out = await race(toneP, left); timings.toneWaitMs = Date.now() - w0;
      if (S.closed) return;
      if (out === 'timeout') tone = { status: 'skipped', reason: 'tone_check_timeout' };
      else if (out?.status !== 'ok') tone = { status: 'skipped', reason: out?.error?.code || 'assessment_unavailable' };
      else if (out.gate === 'low_match') tone = { status: 'skipped', reason: 'low_match' };
      else {
        const facts = { ...deriveFacts(out), ...emptyWordFacts() }; tone = { status: 'ok' };
        send('assessment', { ...out, lowConfidence: true, facts, wordStatus: [], savedMissed: [], basis: 'transcript', referenceText: ref, transcript, transcriptDerived: true });
        const f = facts.confirmedToneErrors?.[0];
        if (f && !correction) { const c = toneCorrection(f, ref); correction = { kind: 'tone', quote: c.targetText, betterZh: c.modelText, explainZh: c.explanationZh, pinyin: c.pinyin, source: 'server_fact', evidence: c.evidence, factRef: c.factRef, _tone: true }; correctionStatus = 'ok'; }
      }
    }

    if (correction) {
      const caption = `${correction.betterZh}${correction.pinyin ? ' ' + correction.pinyin : ''}`;
      sp.unit({ kind: 'correction', text: correction.explainZh, correction: { caption } });
      sp.unit({ kind: 'correction_model', text: `${correction._tone ? '应该这样说：' : TALK_MODEL_PREFIX_ZH}${correction.betterZh}`, correction: { caption } });
    } else if (vocabHints.length && !late) {
      sp.unit({ kind: 'vocab', text: `你也可以用“${vocabHints[0].text}”这个词。` });
    } else if (find?.natural && !late && hz(ref).length >= 6) {
      sp.unit({ kind: 'praise', text: TALK_NATURAL_ZH[Math.floor(Math.random() * TALK_NATURAL_ZH.length)] });
    }
    if (!late && !degraded) askQuestion();
    await sp.done(); if (S.closed) return;

    // suggested words (never auto-saved)
    const suggestedWords = []; const add = (w) => { if (w.text && !suggestedWords.some((x) => x.text === w.text)) suggestedWords.push(w); };
    if (correction && !correction._tone) {
      const bh = hz(correction.betterZh).length;
      if (correction.kind === 'english_gap') add({ text: correction.betterZh, pinyin: correction.pinyin, meaning: correction.quote, reason: 'english_gap' });
      else if (bh >= 2 && bh <= 6) add({ text: correction.betterZh, pinyin: correction.pinyin, meaning: meaningOf(correction.betterZh), reason: correction.kind });
    }
    for (const h of vocabHints) add({ text: h.text, pinyin: h.pinyin, meaning: meaningOf(h.text), reason: 'script_vocab' });
    const { _tone, ...pub } = correction || {};
    let up = null; let upgradeStatus = 'no_script';
    if (upP) {
      up = await race(upP, P.TALK_UPGRADE_MAX_MS + 300 - (Date.now() - upStart)); if (S.closed) return;
      upgradeStatus = up === 'timeout' ? 'unavailable' : up.status;
      if (up === 'timeout') up = { status: 'unavailable', reason: 'timeout', attempts: 0 };
    }
    const upgrade = up?.status === 'ok' ? up.upgrade : null;
    const replyZh = reply.replySentences.join('') || null; const questionZh = questionText && !degraded ? questionText : null;
    S.markOk();
    send('done', finish({ correction: correction ? pub : null, correctionStatus, ...(late ? { correctionLate: true } : {}), suggestedWords, vocabHints,
      replyZh, questionZh, replyPinyin: replyZh ? pinyinOf(replyZh) : null, questionPinyin: questionZh ? pinyinOf(questionZh) : null,
      onTopic: ctx.script ? (typeof reply.onTopic === 'boolean' ? reply.onTopic : null) : null,
      upgrade, upgradeStatus, saveable: upgradeSaveable(upgrade), ...(degraded ? { degraded } : {}),
      summary: { coached: true, llmCalled: true, replyAttempts: reply.attempts, findAttempts: find?.attempts ?? 0, droppedClaims: (find?.dropped || []).length, ...(up ? { upgradeAttempts: up.attempts ?? 0, upgradeDropped: (up.dropped || []).length, ...(up.reason ? { upgradeReason: up.reason } : {}) } : {}), tone: tone.status, ...(tone.status === 'ok' ? { engine: S.label?.engine, mock: S.label?.mock } : {}), ...(tone.reason ? { toneReason: tone.reason } : {}) } }));
  }
}
