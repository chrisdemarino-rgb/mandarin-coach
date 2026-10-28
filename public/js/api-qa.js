// ADAPTER for Q&A practice. ALL knowledge of the Q&A endpoint shapes lives in this file (plus the generic retell key-idea normaliser it reuses).
// Aligned (Oct 28) to the Backend's REAL shapes (commit d236b1c; server/API-ATTEMPT.md "Q&A practice mode"):
//   POST /api/qa/next    json {chunks:[chunkText, ...following chunks (<=80, <=2000 hanzi in total)], chunkIndex:0 (= the chunk asked about), type?:'any', level?:1|2, avoid?:[earlier question TEXTS]}
//        -> {ok, questionId, type, level, questionZh, modelAnswerZh, hintZh:string, sourceChunkIndex, keyPoints:[{id,textZh,refStart,refEnd,chunkIndex}], signature, questionPinyin, repeated?}
//        STATELESS: the whole signed question object is sent back with the attempt. Errors: {ok:false,error:{code,message}} (chunks_too_short 400, question_generation_failed 502, llm_not_configured 503, ...).
//        There is no "exhausted" signal: the client walks the script chunk by chunk, one question per chunk (chunks <6 hanzi are skipped client-side).
//   POST /api/qa/attempt multipart {audio, question:<JSON string of the signed question>, attemptId, voice?, speed?} -> SSE: status | assessment | coach_text | coach_audio | error | done
//        assessment.qa: {questionId, transcript, tone, modelAnswerZh, keyPoints:[{id,textZh,refStart,refEnd,covered:true|false|'partial'|null,evidence,confidence,issue?:'wrong_fact'}],
//                        coveredCount,totalCount,partialCount, wrongFacts:[{claimZh,contradictsKeyPointId}], answeredQuestion, answerKind:'answered'|'dont_know'|'off_topic',
//                        canPraise, praiseLevel:'full'|'soft'|'none', comparisonStatus:'ok'|'unavailable', comparisonReason}
//   refStart/refEnd = code-point offsets (end exclusive) into the chunk sent as chunks[0].
//   Not called: POST /api/qa/hint {question,hintLevel} and POST /api/qa/answer {question}: the hint (level 1 = signed hintZh, level 2 = first half of key point 1, the server's documented rule) and the model answer are already in the signed question, so Hint / Show answer need no round trip.
// Rules baked in here: the transcript is "what I heard" only (tone fields are ignored); coverage is never assumed:
// no block / comparisonStatus != ok / no valid key points => "Could not compare"; the all-clear exists only when every key point is covered, answeredQuestion and canPraise.
import { req, jsonOf, readSse, extFor, noteMock, ApiError } from "./api.js";
import { normalizeRetellBlock, ideaKind } from "./retell.js";
import { normalizeWordCheck, praiseGate, wordCheckVerdict, WORD_CHECK_NOTE, mergeRuns } from "./wordcheck.js";

export const isUnsupported = (e) => !!e && (e.status === 404 || e.status === 501);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const cps = (s) => Array.from(String(s || ""));

const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
/** -> {id, text, pinyin, hints:[{text,from}], source:{start,end}|null, modelAnswer, payload, done} ; null if there is no usable question.
 *  `payload` = the object sent back to /attempt (signed fields + signature), kept verbatim. */
export function normalizeQuestion(raw, chunkText = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.done === true || raw.exhausted === true) return { done: true };
  const text = str(raw.questionZh);
  const id = str(String(raw.questionId ?? ""));
  if (!text || !id) return null;
  const len = cps(chunkText).length;
  const kps = (Array.isArray(raw.keyPoints) ? raw.keyPoints : []).filter((k) => k && Number.isInteger(k.refStart) && Number.isInteger(k.refEnd) && k.refEnd > k.refStart && (!len || k.refEnd <= len));
  const hint1 = str(raw.hintZh);
  const first = kps.length ? cps(str(kps[0].textZh)).filter((c) => HAN_RE.test(c)) : [];   // server: level 2 = first half (>= 1 hanzi) of key point 1
  // level-2 hint: same rule as the server's hintFor(q, 2): the first half of the first key point (code-built from the script, never invented)
  const hint2 = first.length >= 1 ? `答案是这样开头的：${first.slice(0, Math.max(1, Math.floor(first.length / 2))).join("")}……` : "";
  const hints = [hint1 && { text: hint1, from: "coach" }, hint2 && { text: hint2, from: "coach" }].filter(Boolean);
  const src = kps.length ? { start: Math.min(...kps.map((k) => k.refStart)), end: Math.max(...kps.map((k) => k.refEnd)) } : null;
  return { id, text, pinyin: str(raw.questionPinyin) || str(raw.pinyin), hints, source: src, modelAnswer: str(raw.modelAnswerZh), payload: raw, done: false };
}

/** assessment.qa -> {status:'ok'|'unavailable', reason, transcript, points[], covered, partial, missing, wrong, full, answered, answerKind, modelAnswer} | null (no block). Counts are re-derived, never trusted. */
export function normalizeQaBlock(raw, chunkText = "", fallbackTranscript = "", extra = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // reused-phrase word check (855030d): assessment.wordStatus (+ facts, + the block's own praiseBlockedBy/wordCheck/canPraise) -> placed words + the praise gate
  const wc = normalizeWordCheck(extra.wordStatus, chunkText, { chunkIndex: Number.isInteger(extra.chunkIndex) ? extra.chunkIndex : 0 });
  const gate = praiseGate(raw, extra.facts), wordCount = Math.max(wc.total, gate.count);
  const wf = new Map((Array.isArray(raw.wrongFacts) ? raw.wrongFacts : []).filter((w) => w && typeof w.claimZh === "string").map((w) => [w.contradictsKeyPointId, w.claimZh.trim()]));
  const src = raw.keyPoints || raw.points || raw.ideas;
  const ideas = (Array.isArray(src) ? src : []).map((k) => {
    if (!k || typeof k !== "object") return k;
    const wrong = k.issue === "wrong_fact" || k.issue === "wrong_meaning";
    return wrong ? { ...k, covered: false, issue: "wrong_meaning", evidence: wf.get(k.id) || k.evidence } : k;   // a contradicted point is "differs from the script", never "partly covered"
  });
  const r = normalizeRetellBlock({ comparisonStatus: raw.comparisonStatus, comparisonReason: raw.comparisonReason, ideas, canPraise: raw.canPraise, suggestedWords: raw.suggestedWords }, chunkText);
  const byId = new Map(r.ideas.map((i) => [i.id, i.text]));
  const wrongFacts = [...wf.entries()].map(([id, claim]) => ({ claim, about: byId.get(id) || "" })).filter((w) => w.claim).slice(0, 3);
  const praise = ["full", "soft", "none"].includes(raw.praiseLevel) ? raw.praiseLevel : "";
  const transcript = str(raw.transcript) || str(fallbackTranscript);
  const answerKind = ["answered", "dont_know", "off_topic"].includes(raw.answerKind) ? raw.answerKind : "";
  return { status: r.status, reason: r.reason, transcript, points: r.ideas, covered: r.covered, partial: r.partial, missing: r.missing, wrong: r.wrong,
    words: wc.words, wordCount, gate, meaningFull: r.fullMeaning && raw.answeredQuestion !== false && !wrongFacts.length,
    full: r.fullMeaning && raw.answeredQuestion !== false && !wrongFacts.length && !gate.blocked && wordCount === 0 && (!praise || praise === "full"), wrongFacts, praise, suggestedWords: r.suggestedWords, answered: raw.answeredQuestion !== false && answerKind !== "dont_know" && answerKind !== "off_topic", answerKind, modelAnswer: str(raw.modelAnswerZh) || str(raw.answerZh) };
}

/** The verdict. Never an all-clear while a point is missing/partial or the comparison didn't run. */
export function qaOutcome(info) {
  if (!info || info.status !== "ok") {
    const why = { low_match: "I couldn't hear that clearly.", llm_not_configured: "The coach isn't set up on the server." }[info && info.reason] || "";
    return { state: "unchecked", label: "Could not compare", note: `${why} Nothing is marked as covered. Try again for coach feedback.`.trim(), badge: "?" };
  }
  if (info.answered === false) return { state: "missing", count: info.missing + info.wrong, label: info.answerKind === "dont_know" ? "Not answered yet" : "That didn't answer the question", note: "Try a hint, or show the answer. Nothing is marked as covered.", badge: "!" };
  const bad = info.missing + info.wrong;
  if (!bad && info.wrongFacts && info.wrongFacts.length) return { state: "missing", count: info.wrongFacts.length, label: "Check this", note: "Something you said may differ from the script (see below). Nothing here is an all-clear.", badge: "!" };
  if (bad > 0) {
    const label = info.wrong === 0 ? (bad === 1 ? "1 key point missing" : `${bad} key points missing`) : info.missing === 0 ? (bad === 1 ? "1 point differs from the script" : `${bad} points differ from the script`) : `${bad} key points missing or different`;
    return { state: "missing", count: bad, label, note: "Your own wording is fine. Try to include what's marked below.", badge: "!" };
  }
  if (info.partial > 0) return { state: "partial", count: info.partial, label: info.partial === 1 ? "1 point only partly covered" : `${info.partial} points only partly covered`, note: "Nothing is missing, but not everything was said in full.", badge: "~" };
  if (info.wordCount > 0) return { state: "wordcheck", count: info.wordCount, label: wordCheckVerdict(info.wordCount, info.words, { sure: info.meaningFull }), note: WORD_CHECK_NOTE, badge: "!" };
  if (info.gate && info.gate.blocked) return { state: "checked", label: "No missing points flagged", note: "The coach isn't giving a full all-clear for this one, so check the notes below.", badge: "~" };
  if (info.full) return { state: "covered", label: "All key points covered", note: "Compared by meaning: your own wording is fine.", badge: "\u2713" };
  return { state: "checked", label: "No missing points flagged", note: "I'm not fully sure about some points, so this isn't a full all-clear.", badge: "\u2713" };
}
export const qaPassed = (o) => !!o && (o.state === "covered" || o.state === "checked");

/** Progressive hints: the question's own hints ([{text, from:'coach'}]), else (only if the backend sent none) pieces of the script's source span, labelled 'script'. Never invented. */
export function hintsFor(q, chunkText) {
  if (!q) return [];
  if (q.hints && q.hints.length) return q.hints;
  if (!q.source) return [];
  const span = cps(chunkText).slice(q.source.start, q.source.end).filter((c) => HAN_RE.test(c));
  if (span.length < 4) return [];
  return [{ text: span.slice(0, 2).join("") + "\u2026", from: "script" }, { text: span.slice(0, Math.ceil(span.length / 2)).join("") + "\u2026", from: "script" }];
}
/** The model answer: the coach's (assessment, then question) else the script's own source sentence (labelled), else null. */
export function answerFor(q, info, chunkText) {
  const t = (info && info.modelAnswer) || (q && q.modelAnswer);
  if (t) return { text: t, from: "coach" };
  if (q && q.source) { const s = cps(chunkText).slice(q.source.start, q.source.end).join("").trim(); if (s) return { text: s, from: "script" }; }
  return null;
}

const MARK = {
  covered: { cls: "hl-covered", glyph: "\u2713", label: "covered" },
  partial: { cls: "hl-partial", glyph: "~", label: "only partly covered" },
  missing: { cls: "hl-missed", glyph: "\u2212", label: "missing" },
  wrong: { cls: "hl-wrong", glyph: "!", label: "differs from the script" },
};
export const QA_MARKS = MARK;
const RANK = { covered: 1, partial: 2, wrong: 3, missing: 4 };
/** [{text, kind:''|covered|partial|wrong|missing}] runs over the chunk text. Points without valid offsets are simply not placed (they stay in the checklist). */
export function segmentsOf(chunkText, info, words = []) {
  const chars = cps(chunkText), kinds = new Array(chars.length).fill("");
  if (info && info.status === "ok") for (const p of info.points) if (p.start !== undefined) {
    const k = ideaKind(p);
    for (let i = p.start; i < Math.min(p.end, chars.length); i++) if (!kinds[i] || RANK[k] > RANK[kinds[i]]) kinds[i] = k;
  }
  // word-check spans (reused-phrase check) are a second, independent marker set; runs split wherever either set changes
  if (words && words.length) return mergeRuns(chunkText, kinds, words);
  const out = [];
  chars.forEach((c, i) => { const last = out[out.length - 1]; if (last && last.kind === kinds[i]) last.text += c; else out.push({ text: c, kind: kinds[i] }); });
  return out;
}
export const placedCount = (info) => (info && info.status === "ok" ? info.points.filter((p) => p.start !== undefined).length : 0) + (info && info.words ? info.words.length : 0);

/** records: [{attempts, info, hints, answerShown, skipped}] (one per question) -> summary numbers. Only the LAST assessed attempt of a question counts for points. */
export function summarize(records) {
  const s = { questions: records.length, answered: 0, unchecked: 0, skipped: 0, pointsCovered: 0, pointsTotal: 0, hints: 0, answers: 0 };
  for (const r of records) {
    s.hints += r.hints || 0; s.answers += r.answerShown ? 1 : 0;
    if (r.attempts > 0) { s.answered++; if (r.info && r.info.wordCount > 0) s.wordChecks = (s.wordChecks || 0) + 1; if (r.info && r.info.status === "ok") { s.pointsCovered += r.info.covered; s.pointsTotal += r.info.points.length; } else s.unchecked++; }
    else if (r.skipped) s.skipped++;
  }
  return s;
}

const ERROR_HINTS = {
  no_speech_detected: "I didn't hear any speech in that take. Answer out loud, close to the microphone.",
  stt_not_configured: "Speech recognition isn't set up on the server yet.",
  qa_answer_too_long: "That answer was too long to check. Answer in one or two sentences.",
  invalid_question_signature: "This question can't be checked any more. Skip it to get a new one.",
  invalid_question: "This question can't be checked any more. Skip it to get a new one.",
  script_too_long: "This part of the script is too long to ask about. Use a smaller chunk size.",
  stage_directions_in_chunk: "A stage direction got into the text. Check the script and try again.",
  llm_not_configured: "The coach isn't set up on the server yet, so questions can't be made.",
  question_generation_failed: "I couldn't make a good question from this part. Try again, or skip it.",
};
const NEVER_RETRY = new Set(["invalid_question_signature", "invalid_question"]);
/** Terminal SSE/HTTP error -> {message, retryable}. Always starts with "No assessment obtained" (once). */
export function qaErrorOf(e) {
  const code = (e && e.code) || "", msg = ((e && e.message) || "").replace(/^no assessment obtained:?\s*/i, "");
  const body = ERROR_HINTS[code] || msg || "The coach couldn't assess that answer.";
  return { message: `No assessment obtained: ${body}`, retryable: !(e && e.retryable === false && code !== "qa_answer_too_long") && !NEVER_RETRY.has(code), code };
}

export const qa = {
  /** One question about chunks[0] (offsets in the answer refer to this exact text). Throws ApiError (code from the server; isUnsupported for 404/501). */
  async next({ chunks, avoid = [] }) {
    const chunkText = chunks[0];   // chunkIndex 0 = the chunk asked about; the following chunks are context only (the server asks about ONE chunk)
    const body = await req("POST", "/api/qa/next", { json: { chunks, chunkIndex: 0, type: "any", level: 1, ...(avoid.length ? { avoid: avoid.slice(-40).map((t) => cps(t).slice(0, 120).join("")) } : {}) } }).then(jsonOf);
    const q = normalizeQuestion(body, chunkText);
    if (!q || q.done) throw new ApiError("The server sent a question I couldn't read.", { retryable: true });
    return q;
  },
  /** Same contract as api.attempt(): resolves {replayed}; rejects ApiError. Re-call with the same attemptId to retry. onEvent(name, data). */
  async attempt({ blob, mime, question, attemptId, chunkText, voice, speed, signal, onEvent }) {
    const fd = new FormData();
    fd.append("audio", blob, `take.${extFor(mime || blob.type || "")}`);
    fd.append("question", JSON.stringify(question.payload)); fd.append("attemptId", attemptId);
    if (chunkText) fd.append("chunkText", chunkText);   // the FULL chunk of the key points (chunks[sourceChunkIndex], directions stripped): the saved word's sourceChunk is then the whole sentence
    if (voice) fd.append("voice", voice);
    if (speed) fd.append("speed", String(speed));
    const res = await req("POST", "/api/qa/attempt", { body: fd, signal });
    let terminal = false;
    try { await readSse(res, (name, data) => { noteMock(data, name); if (name === "error" || name === "done" || name === "assessment") terminal = true; onEvent(name, data); }); }
    catch (e) { if (e && e.name === "AbortError") throw e; throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true }); }
    if (!terminal) throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true });
    return { replayed: res.headers.get("X-Attempt-Replayed") === "true" };
  },
};

/** The chunks to send: `idx` first, then the following ones while the server limits hold (<= 80 chunks, <= 2000 hanzi in total). texts = already direction-stripped. */
export function chunkWindow(texts, idx, { maxChunks = 80, maxHanzi = 2000 } = {}) {
  const out = []; let hz = 0;
  for (let i = idx; i < texts.length && out.length < maxChunks; i++) {
    const n = (String(texts[i]).match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    if (out.length && hz + n > maxHanzi) break;
    out.push(texts[i]); hz += n;
  }
  return out;
}
