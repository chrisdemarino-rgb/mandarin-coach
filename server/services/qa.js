// Q&A practice: the coach asks a spoken question about the script, the learner answers freely by voice.
//
//   POST /api/qa/next     : LLM proposes {question, key points as QUOTED substrings, model answer, hint}; CODE resolves the quotes to code-point
//                           offsets in the exact chunk, drops what it cannot find, builds the answer/hint fallbacks and SIGNS the result (HMAC, stateless).
//   POST /api/qa/attempt  : STT transcript -> LLM checks the answer against the signed key points ONLY -> CODE verifies evidence/quotes and derives
//                           counts, canPraise, wrong facts -> code-built coaching (the LLM never writes a spoken line, never gives offsets/verdicts).
//
// GROUNDING: the only truth is the script chunk (for questions) and the signed key points (for checking). Nothing about tones comes from the transcript.
import { pinyin as pinyinPro } from 'pinyin-pro';
import { ServiceError } from './openai.js';
import { resolveSpan, quoteInTranscript, isGrounded, hanziOnly, hz, cleanLine, TONE_CLAIM, NON_ZH, toneCorrection, suggestWords, wordSuggestions } from './retell.js';
import { questionIdOf, QA_TYPES } from '../lib/qa-sign.js';

export const MAX_KEY_POINTS = 3;
export const MAX_QA_CORRECTIONS = 2;
export const QA_MIN_CHUNK_HANZI = 6;
export const QA_MAX_SCRIPT_HANZI = 3000;   // whole script (all chunks), hanzi; was 2000 (app script limit raised to 3000 chars 2026-10-30)
export const QA_MAX_CHUNKS = 200;

// ---------------------------------------------------------------------------------------------------------------- fixed spoken lines (pre-warmed in TTS)
const ZH_N = ['', '一', '二', '三', '四'];
export const QA_ALL_ZH = '回答得很好，要点都讲到了。';
export const QA_ALL_TONE_ZH = '要点都讲到了，有一个发音可以再练一练。';
export const QA_SOFT_ZH = '还差一点，有个要点没讲全。';
export const QA_WORD_ZH = '有个词和原文不一样。';   // reused-phrase word check found a substituted/omitted script word: neutral, never praise
export const QA_WRONG_ZH = '有些地方和原文不一样。';
export const QA_DONTKNOW_ZH = '没关系，这个问题还没答出来。';
export const QA_OFFTOPIC_ZH = '这个回答好像没有回答问题。';
export const QA_GATE_ZH = '我没有听清楚，请再说一遍。';
export const QA_UNAVAILABLE_ZH = '这次没能检查你的回答。';
export const QA_NEXT_RETRY_ZH = '再试一次，或者下一个问题。';
export const QA_NEXT_OK_ZH = '来下一个问题吧。';
export const QA_NEXT_HINT_ZH = '想要提示可以点提示，也可以再试一次。';
export const qaMissingOpener = (n) => `有${ZH_N[Math.min(n, 4)] || '几'}个要点没讲到。`;
export const QA_PHRASES_ZH = [QA_ALL_ZH, QA_ALL_TONE_ZH, QA_SOFT_ZH, QA_WORD_ZH, QA_WRONG_ZH, QA_DONTKNOW_ZH, QA_OFFTOPIC_ZH, QA_GATE_ZH, QA_UNAVAILABLE_ZH, QA_NEXT_RETRY_ZH, QA_NEXT_OK_ZH, QA_NEXT_HINT_ZH, ...[1, 2, 3].map(qaMissingOpener)];
const DONT_KNOW_RE = /不知道|不清楚|不记得|忘了|想不起来|不会说|没听懂|不太懂|不明白|我不会/;
const GENERIC_HINT_ZH = '想一想原文里是怎么说的。';

const isStr = (x) => typeof x === 'string';
const norm = (s) => hanziOnly(String(s ?? ''));
const spanText = (chunk, a, b) => Array.from(chunk).slice(a, b).join('');
const SENTENCE_END = /[。！？!?；;…\n]/;
const IS_HZ = /[\u3400-\u9fff\uf900-\ufaff]/;
/** Offsets of the span without leading/trailing punctuation or spaces (code points). */
function trimSpan(chunk, start, end) { const c = Array.from(chunk); while (start < end && !IS_HZ.test(c[start])) start++; while (end > start && !IS_HZ.test(c[end - 1])) end--; return { start, end }; }
const bigrams = (s) => { const h = [...hanziOnly(s)]; const o = new Set(); for (let i = 0; i + 1 < h.length; i++) o.add(h[i] + h[i + 1]); return o; };

// ---------------------------------------------------------------------------------------------------------------- /next : request
export const TYPE_HELP = {
  what: '"what" question (什么/哪些/做什么): asks for a thing, an action or a detail stated in the passage',
  why: '"why" question (为什么): asks for a reason that the passage states',
  how: '"how" question (怎么/怎么样/多久): asks for a way, a manner or a degree that the passage states',
  who: '"who" question (谁): the answer is a person or group named or described in the passage',
};
export function buildNextMessages({ chunk, preferredType, level, avoid = [] }) {
  const system = `You write ONE spoken comprehension question in Mandarin about a passage the learner has just studied. Reply as JSON only.
Rules:
- The question must be answerable ONLY from the passage text: no outside knowledge, no trivia, nothing the passage does not state. Simple HSK 3-4 Mandarin, max 30 characters, no English/pinyin/digits.
- Name the person or thing in the question (it is read aloud on its own). The question must NOT contain its own answer. For a "who" question the key point is just the person's name/description.
- Prefer 2-3 SMALL key points when the answer has several parts; one is fine for a single fact.
- Ask a ${TYPE_HELP[preferredType] || TYPE_HELP.what}. If the passage cannot support that type, ask another type and report the real type in "type" (what|why|how|who).
- level ${level === 2 ? '2: a reason or a link between two facts that the passage states' : '1: one fact stated directly in the passage'}.
- Never repeat or paraphrase a question in "avoid"; pick a different fact.
- keyPoints (1-3): the short ideas a correct answer must contain, each "refQuote" an EXACT contiguous substring COPIED from the passage (2-20 characters), in passage order.
- modelAnswerZh: one short natural sentence (max 40 characters) that answers the question using ONLY what the passage says.
- hintZh: a gentle hint (max 25 characters) that says where to look or what to think about, WITHOUT using the answer words.
JSON (keys in this order): {"type":string,"questionZh":string,"keyPoints":[{"refQuote":string}],"modelAnswerZh":string,"hintZh":string}`;
  const user = JSON.stringify({ passage: chunk, avoid: avoid.slice(0, 12).filter((x) => !/^q[0-9a-f]{12}$/.test(x)).map((x) => x.slice(0, 60)) });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Strict structural check of the raw LLM object (throws ServiceError('qa_schema') => retried once). */
export function parseNext(raw) {
  const bad = (why) => new ServiceError('qa_schema', `question JSON rejected: ${why}`, { retryable: true });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
  if (!isStr(raw.questionZh) || !isStr(raw.modelAnswerZh)) throw bad('questionZh/modelAnswerZh');
  if (raw.hintZh != null && !isStr(raw.hintZh)) throw bad('hintZh type');
  if (!Array.isArray(raw.keyPoints) || raw.keyPoints.length < 1 || raw.keyPoints.length > 6) throw bad('keyPoints must be an array of 1-6');
  const keyPoints = raw.keyPoints.map((k, i) => { const q = isStr(k) ? k : k?.refQuote; if (!isStr(q)) throw bad(`keyPoint ${i}`); return q.trim(); });
  return { type: isStr(raw.type) ? raw.type.trim().toLowerCase() : null, questionZh: raw.questionZh.trim(), keyPoints, modelAnswerZh: raw.modelAnswerZh.trim(), hintZh: isStr(raw.hintZh) ? raw.hintZh.trim() : '' };
}

/** CODE validation of a parsed question. Returns the unsigned question; throws ServiceError('qa_unusable') when nothing grounded is left. */
export function validateNext(parsed, { chunk, chunkIndex, preferredType, level = 1, avoid = [] }) {
  const dropped = [];
  const questionZh = parsed.questionZh;
  const qh = hz(questionZh).length;
  if (qh < 3 || qh > 40 || NON_ZH.test(questionZh) || TONE_CLAIM.test(questionZh)) throw new ServiceError('qa_unusable', 'question text unusable', { retryable: true });
  const qn = norm(questionZh);
  const found = []; const allSpanText = [];
  for (const quote of parsed.keyPoints) {
    const span = resolveSpan(chunk, quote);
    if (!span) { dropped.push('span_not_in_reference'); continue; }           // possibly invented: never ask about it
    const tr = trimSpan(chunk, span.start, span.end); allSpanText.push(spanText(chunk, tr.start, tr.end));
    if (SENTENCE_END.test(spanText(chunk, tr.start, tr.end))) { dropped.push('span_crosses_sentences'); continue; } // a key point is ONE clause (it is spoken and highlighted on its own)
    span.start = tr.start; span.end = tr.end;
    const text = spanText(chunk, span.start, span.end);
    if (hz(text).length < 2 || [...text].length > 40) { dropped.push('span_size'); continue; }
    if (norm(text).length >= 4 && qn.includes(norm(text))) { dropped.push('answer_in_question'); continue; }
    if (found.some((x) => Math.min(x.refEnd, span.end) - Math.max(x.refStart, span.start) > 0.5 * Math.min(x.refEnd - x.refStart, span.end - span.start))) { dropped.push('duplicate_span'); continue; }
    found.push({ textZh: text, refStart: span.start, refEnd: span.end, chunkIndex });
  }
  if (!found.length) throw new ServiceError('qa_unusable', 'no key point could be located in the script', { retryable: true });
  const keyPoints = found.sort((a, b) => a.refStart - b.refStart).slice(0, MAX_KEY_POINTS).map((k, i) => ({ id: `k${i + 1}`, ...k }));
  const fallbackAnswer = keyPoints.map((k) => k.textZh.replace(/[，。！？、；：,.\s]+$/u, '')).join('，');
  let modelAnswerZh = cleanLine(parsed.modelAnswerZh, 60);
  if (!modelAnswerZh || !isGrounded(modelAnswerZh, chunk)) { if (parsed.modelAnswerZh) dropped.push('model_answer_not_grounded'); modelAnswerZh = fallbackAnswer; }
  let hintZh = cleanLine(parsed.hintZh, 30);
  if (!hintZh || TONE_CLAIM.test(hintZh) || allSpanText.some((x) => norm(x).length >= 3 && norm(hintZh).includes(norm(x)))) { if (parsed.hintZh) dropped.push('hint_gives_answer'); hintZh = GENERIC_HINT_ZH; }
  const type = QA_TYPES.includes(parsed.type) ? parsed.type : preferredType;
  const questionId = questionIdOf(questionZh, keyPoints);
  const repeated = avoid.includes(questionId) || avoid.some((a) => a.length >= 4 && norm(a) === qn);
  return { questionId, type, level, questionZh, keyPoints, modelAnswerZh, hintZh, sourceChunkIndex: chunkIndex, repeated, dropped };
}

/** The LLM call for /next: strict-validated, ONE retry, wall cap. Never throws: {status:'ok', question, attempts} | {status:'failed', reason, attempts}. */
export async function generateQuestion({ llm, chunk, chunkIndex, preferredType, level = 1, avoid = [], signal, model, timings = {}, maxMs = 8000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'failed', reason: 'llm_not_configured', attempts: 0 };
  const ac = new AbortController(); const onAbort = () => ac.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), maxMs); timer.unref?.();
  let reason = 'generation_failed'; let repeatDraft = null; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try {
        const raw = await llm.chatJson({ messages: buildNextMessages({ chunk, preferredType, level, avoid }), signal: ac.signal, model, maxTokens: 420, temperature: 0.7, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        const q = validateNext(parseNext(raw), { chunk, chunkIndex, preferredType, level, avoid });
        if (q.repeated && i + 1 < attempts) { repeatDraft = q; continue; } // try once more for a different question
        return { status: 'ok', question: q, attempts: n };
      } catch (e) {
        reason = e.code === 'qa_schema' || e.code === 'llm_bad_json' ? 'malformed_output' : e.code === 'qa_unusable' ? 'no_grounded_key_point' : (e.code || 'generation_failed');
        if (ac.signal.aborted || (e.retryable === false && e.code !== 'qa_schema')) break;
      }
    }
    if (repeatDraft) return { status: 'ok', question: repeatDraft, attempts: n };
    return { status: 'failed', reason, attempts: n };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); timings.generateMs = Date.now() - t0; }
}

export const questionPinyin = (q) => { try { return pinyinPro(q, { toneType: 'symbol', type: 'array' }).join(' ').replace(/\s+([，。？！、；：])/g, '$1'); } catch { return null; } };

// ---------------------------------------------------------------------------------------------------------------- hints (code only)
/** level 1: the signed hint; level 2: the start of the first key point (first half, at least 1 hanzi), code-built. */
export function hintFor(question, level = 1) {
  if (level !== 2) return { hintZh: question.hintZh, level: 1, hasMore: true };
  const first = Array.from(question.keyPoints[0].textZh).filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c));
  const n = Math.max(1, Math.floor(first.length / 2));
  return { hintZh: `答案是这样开头的：${first.slice(0, n).join('')}……`, level: 2, hasMore: false };
}

// ---------------------------------------------------------------------------------------------------------------- /attempt : request
export function buildCheckMessages({ question, transcript }) {
  const system = `You check a Mandarin learner's spoken ANSWER (an automatic speech-recognition transcript) against the key points of a question. The key points come from the reference script and are the only truth. Reply as JSON only.
- keyPoints: one entry per given key point id. covered: true = the answer states it in ANY wording; "partial" = only partly; false = absent or contradicted. evidence = a short EXACT quote copied from the transcript when covered is true or "partial", else null. confidence "high"|"medium"|"low".
- wrongFacts (0-2): statements in the transcript that CONTRADICT a key point (not merely missing ones, and not extra harmless details): claim = an EXACT transcript quote, contradicts = that key point id, confidence.
- answeredQuestion: true when the answer is an attempt to answer this question (even if wrong); false for off-topic speech, "I don't know" or nothing relevant.
Different wording, synonyms and small grammar slips are NOT errors. The transcript may contain recognition errors: do not blame the learner for one garbled word. Never comment on pronunciation or tones.
JSON (keys in this order): {"answeredQuestion":true|false,"keyPoints":[{"id":string,"covered":true|"partial"|false,"evidence":string|null,"confidence":string}],"wrongFacts":[{"claim":string,"contradicts":string,"confidence":string}]}`;
  const user = JSON.stringify({ question: question.questionZh, keyPoints: question.keyPoints.map((k) => ({ id: k.id, textZh: k.textZh })), modelAnswer: question.modelAnswerZh, transcript: String(transcript ?? '').slice(0, 600) });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const COVERED = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : v === 'partial' ? 'partial' : undefined);
export function parseCheck(raw) {
  const bad = (why) => new ServiceError('qa_schema', `answer-check JSON rejected: ${why}`, { retryable: true });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
  const answered = raw.answeredQuestion === true || raw.answeredQuestion === 'true' ? true : raw.answeredQuestion === false || raw.answeredQuestion === 'false' ? false : undefined;
  if (answered === undefined) throw bad('answeredQuestion must be a boolean');
  if (!Array.isArray(raw.keyPoints) || raw.keyPoints.length < 1 || raw.keyPoints.length > 8) throw bad('keyPoints must be an array');
  const keyPoints = raw.keyPoints.map((x, i) => {
    if (!x || typeof x !== 'object' || !isStr(x.id)) throw bad(`keyPoint ${i} id`);
    const covered = COVERED(x.covered); if (covered === undefined) throw bad(`keyPoint ${i} covered`);
    if (x.evidence != null && !isStr(x.evidence)) throw bad(`keyPoint ${i} evidence`);
    const confidence = ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : x.confidence == null ? 'medium' : (() => { throw bad(`keyPoint ${i} confidence`); })();
    return { id: x.id.trim(), covered, evidence: x.evidence == null ? null : x.evidence.trim() || null, confidence };
  });
  const wf = raw.wrongFacts == null ? [] : raw.wrongFacts;
  if (!Array.isArray(wf)) throw bad('wrongFacts must be an array');
  const wrongFacts = wf.slice(0, 4).map((w) => (w && typeof w === 'object' && isStr(w.claim) ? { claim: w.claim.trim(), contradicts: isStr(w.contradicts) ? w.contradicts.trim() : null, confidence: ['high', 'medium', 'low'].includes(w.confidence) ? w.confidence : 'medium' } : null)).filter(Boolean);
  return { answeredQuestion: answered, keyPoints, wrongFacts };
}

/** CODE validation of the parsed check. Throws ServiceError('qa_schema') when a signed key point is missing from the LLM answer. */
export function validateCheck(parsed, { question, transcript }) {
  const dropped = []; const byId = new Map(parsed.keyPoints.map((k) => [k.id, k]));
  const keyPoints = question.keyPoints.map((kp) => {
    const raw = byId.get(kp.id);
    if (!raw) throw new ServiceError('qa_schema', `key point ${kp.id} missing from the check`, { retryable: true });
    let { covered, evidence, confidence } = raw;
    if (covered === false) evidence = null;
    else if (!evidence || !quoteInTranscript(evidence, transcript)) { if (evidence) dropped.push('evidence_not_in_transcript'); covered = 'partial'; evidence = null; confidence = 'low'; }
    return { id: kp.id, textZh: kp.textZh, refStart: kp.refStart, refEnd: kp.refEnd, chunkIndex: kp.chunkIndex, covered, evidence, confidence, issue: null };
  });
  const wrongFacts = []; const used = new Set();
  for (const w of parsed.wrongFacts) {
    const kp = keyPoints.find((k) => k.id === w.contradicts);
    if (!kp) { dropped.push('wrong_fact_unknown_key_point'); continue; }
    if (!quoteInTranscript(w.claim, transcript)) { dropped.push('wrong_fact_quote_not_in_transcript'); continue; } // hallucinated quote
    const claim = w.claim.replace(/^[^\u3400-\u9fff\uf900-\ufaff]+|[^\u3400-\u9fff\uf900-\ufaff]+$/g, '');
    if (hz(claim).length < 2 || [...claim].length > 40 || NON_ZH.test(claim) || SENTENCE_END.test(claim)) { dropped.push('wrong_fact_claim_unusable'); continue; } // quoted in a spoken line: one clause, no sentence enders
    w.claim = claim;
    if (kp.covered === true) { dropped.push('wrong_fact_on_covered_key_point'); continue; }                         // inconsistent: ignore
    if (w.confidence === 'low') { dropped.push('wrong_fact_low_confidence'); continue; }
    if (used.has(kp.id) || wrongFacts.length >= 2) continue;
    used.add(kp.id); kp.issue = 'wrong_fact';
    wrongFacts.push({ claimZh: w.claim, contradictsKeyPointId: kp.id, confidence: w.confidence });
  }
  const anyCovered = keyPoints.some((k) => k.covered === true || k.covered === 'partial');
  let answeredQuestion = parsed.answeredQuestion || anyCovered;
  if (answeredQuestion && !anyCovered && !wrongFacts.length) {   // the model says "answered" but nothing matches: check that the answer even shares words with the question/key points
    const ref = bigrams([question.questionZh, question.modelAnswerZh, ...question.keyPoints.map((k) => k.textZh)].join('，'));
    if (DONT_KNOW_RE.test(String(transcript)) || ![...bigrams(transcript)].some((b) => ref.has(b))) { answeredQuestion = false; dropped.push('answered_without_overlap'); }
  }
  const answerKind = answeredQuestion ? 'answered' : DONT_KNOW_RE.test(String(transcript)) ? 'dont_know' : 'off_topic';
  return { keyPoints, wrongFacts, answeredQuestion, answerKind, dropped };
}

/** The LLM call for /attempt. Never throws: {status:'ok', attempts, ...validated} | {status:'unavailable', reason, attempts}. */
export async function checkAnswer({ llm, question, transcript, signal, model, timings = {}, maxMs = 8000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', attempts: 0 };
  const ac = new AbortController(); const onAbort = () => ac.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), maxMs); timer.unref?.();
  let reason = 'check_failed'; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try {
        const raw = await llm.chatJson({ messages: buildCheckMessages({ question, transcript }), signal: ac.signal, model, maxTokens: 450, temperature: 0, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        return { status: 'ok', attempts: n, ...validateCheck(parseCheck(raw), { question, transcript }) };
      } catch (e) {
        reason = e.code === 'qa_schema' || e.code === 'llm_bad_json' ? 'malformed_output' : (e.code || 'check_failed');
        if (ac.signal.aborted || (e.retryable === false && e.code !== 'qa_schema')) break;
      }
    }
    return { status: 'unavailable', reason, attempts: n };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); timings.checkMs = Date.now() - t0; }
}

// ---------------------------------------------------------------------------------------------------------------- derived facts + coaching plan
/** suggestedWords from key-point texts (the question payload carries texts, not the chunk). */
export function suggestQaWords(keyPoints, transcript, meaningOf) {
  let text = ''; const ideas = [];
  for (const k of keyPoints) { const start = [...text].length; text += k.textZh + '，'; ideas.push({ id: k.id, covered: k.covered, refStart: start, refEnd: start + [...k.textZh].length }); }
  return suggestWords(ideas, text, transcript, meaningOf).map(({ ideaId, ...w }) => ({ ...w, keyPointId: ideaId }));
}

export function buildQaBlock({ chk, question, transcript, stt, tone, meaningOf, wordFindings = [] }) {
  const base = { questionId: question.questionId, transcript, sttStatus: stt?.status ?? 'ok', tone, modelAnswerZh: question.modelAnswerZh };
  const owner = (f) => ({ keyPointId: f.keyPointId ?? null });
  if (chk.status !== 'ok') {
    return { ...base, keyPoints: question.keyPoints.map((k) => ({ ...k, covered: null, evidence: null, confidence: null })), coveredCount: 0, totalCount: question.keyPoints.length, partialCount: 0,
      wrongFacts: [], answeredQuestion: null, answerKind: null, canPraise: false, praiseLevel: 'none', comparisonStatus: 'unavailable', comparisonReason: chk.reason, missingKeyPointIds: [], suggestedWords: wordSuggestions(wordFindings, [], meaningOf, owner), ...(wordFindings.length ? { praiseBlockedBy: ['word_check'] } : {}) };
  }
  const keyPoints = chk.keyPoints.map(({ id, textZh, refStart, refEnd, chunkIndex, covered, evidence, confidence, issue }) => ({ id, textZh, refStart, refEnd, chunkIndex, covered, evidence, confidence, ...(issue ? { issue } : {}) }));
  const coveredCount = keyPoints.filter((x) => x.covered === true).length;
  const missing = keyPoints.filter((x) => x.covered === false);
  const allTrue = coveredCount === keyPoints.length && keyPoints.every((x) => x.confidence !== 'low') && chk.wrongFacts.length === 0 && chk.answeredQuestion;
  const praiseLevel = allTrue && !wordFindings.length ? 'full' : (missing.length || chk.wrongFacts.length || !chk.answeredQuestion) ? 'none' : 'soft';
  return { ...base, keyPoints, coveredCount, totalCount: keyPoints.length, partialCount: keyPoints.filter((x) => x.covered === 'partial').length, wrongFacts: chk.wrongFacts,
    answeredQuestion: chk.answeredQuestion, answerKind: chk.answerKind, canPraise: praiseLevel === 'full', praiseLevel, comparisonStatus: 'ok', missingKeyPointIds: missing.map((x) => x.id),
    suggestedWords: wordSuggestions(wordFindings, suggestQaWords(chk.keyPoints, transcript, meaningOf), meaningOf, owner),
    ...(wordFindings.length ? { praiseBlockedBy: allTrue ? ['word_check'] : [], wordCheck: { status: 'found', count: wordFindings.length } } : {}) };
}

const kpCorrection = (kind, kp, extra = {}) => ({ kind, targetText: kp.textZh, start: kp.refStart, end: kp.refEnd, chunkIndex: kp.chunkIndex, keyPointId: kp.id, caption: kp.textZh, modelText: kp.textZh,
  factRef: `kp:${kp.id}`, source: 'server_fact', evidence: { source: 'transcript', confidence: kp.confidence }, ...extra });

/** All spoken/written lines are code-built from validated facts. Returns { units:[{kind,text,correction?}], corrections }. */
export function planQaCoach({ qa, chk, question, toneFacts = [], toneRef = '', wordCorrections = [] }) {
  const units = []; const corrections = []; const say = (kind, text, correction) => units.push({ kind, text, ...(correction ? { correction } : {}) });
  const toneUnits = (slots) => { for (const f of toneFacts.slice(0, slots)) { const c = toneCorrection(f, toneRef); corrections.push(c); say('correction', c.explanationZh, c); if (c.modelText) say('correction_model', `应该这样说：${c.modelText}`, c); } };
  if (qa.comparisonStatus !== 'ok') {
    say('opener', QA_UNAVAILABLE_ZH);
    for (const c of wordCorrections.slice(0, MAX_QA_CORRECTIONS)) { corrections.push(c); say('correction', c.explanationZh, c); say('correction_model', `应该这样说：${c.modelText}`, c); }
    toneUnits(Math.min(1, MAX_QA_CORRECTIONS - corrections.length)); say('next', QA_NEXT_RETRY_ZH);
    return { units, corrections };
  }
  if (!qa.answeredQuestion) {                                  // off-topic / "I don't know": say so, offer the hint (the model answer stays one tap away)
    say('opener', qa.answerKind === 'dont_know' ? QA_DONTKNOW_ZH : QA_OFFTOPIC_ZH); say('next', QA_NEXT_HINT_ZH);
    return { units, corrections };
  }
  const byId = new Map(chk.keyPoints.map((k) => [k.id, k]));
  const cands = [];
  for (const w of chk.wrongFacts) { const kp = byId.get(w.contradictsKeyPointId); if (kp) cands.push(kpCorrection('wrong_fact', kp, { explanationZh: `你说的“${w.claimZh}”和原文不一样。`, heard: w.claimZh })); }
  for (const kp of chk.keyPoints.filter((k) => k.covered === false && k.issue !== 'wrong_fact')) cands.push(kpCorrection('missing_key_point', kp, { explanationZh: `${kp.confidence === 'low' ? '好像没讲到' : '漏掉了'}这个要点：${kp.textZh}` }));
  for (const kp of chk.keyPoints.filter((k) => k.covered === 'partial' && k.issue !== 'wrong_fact')) cands.push(kpCorrection('missing_key_point', kp, { explanationZh: `${kp.confidence === 'low' ? '这个要点好像没讲全' : '这个要点只讲了一部分'}：${kp.textZh}` }));
  const words = wordCorrections.slice(0, MAX_QA_CORRECTIONS);   // a substituted/omitted SCRIPT word in a reused phrase ranks first
  const meaning = cands.slice(0, MAX_QA_CORRECTIONS - words.length);
  if (qa.praiseLevel === 'full') say(toneFacts.length ? 'opener' : 'praise', toneFacts.length ? QA_ALL_TONE_ZH : QA_ALL_ZH);
  else if (qa.praiseLevel === 'soft') say('opener', words.length ? QA_WORD_ZH : QA_SOFT_ZH);
  else { const plain = chk.keyPoints.filter((k) => k.covered === false && k.issue !== 'wrong_fact').length; say('opener', plain ? qaMissingOpener(plain) : QA_WRONG_ZH); }
  for (const c of words) { corrections.push(c); say('correction', c.explanationZh, c); say('correction_model', `应该这样说：${c.modelText}`, c); }
  for (const c of meaning) { corrections.push(c); say('correction', c.explanationZh, c); }
  if (meaning.length) say('correction_model', `可以这样说：${question.modelAnswerZh}`, { ...meaning[0], modelText: question.modelAnswerZh });
  else if (qa.praiseLevel !== 'full' && !(words.length && qa.praiseLevel === 'soft')) say('correction_model', `可以这样说：${question.modelAnswerZh}`);
  toneUnits(MAX_QA_CORRECTIONS - words.length - meaning.length);
  say('next', qa.praiseLevel === 'full' ? QA_NEXT_OK_ZH : QA_NEXT_RETRY_ZH);
  return { units, corrections };
}
