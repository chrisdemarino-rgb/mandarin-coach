// Stateless proof that a Q&A question (its key points, model answer, hint) was issued by THIS server.
// signature = HMAC-SHA256(key derived from SESSION_SECRET/APP_PASSCODE, canonical JSON of the signed fields). Nothing is stored server-side.
import crypto from 'node:crypto';

const key = (cfg) => crypto.createHash('sha256').update(`coach-qa-v1:${cfg.sessionSecret || cfg.passcode || ''}`).digest();
const TYPES = ['what', 'why', 'how', 'who'];
export const QA_TYPES = TYPES;

/** The signed fields in a FIXED order (extra client fields such as questionPinyin / questionAudio are not signed and are ignored). */
export function canonicalQuestion(q) {
  return JSON.stringify([1, q.questionId, q.type, q.level, q.questionZh, q.modelAnswerZh, q.hintZh, q.sourceChunkIndex,
    q.keyPoints.map((k) => [k.id, k.textZh, k.refStart, k.refEnd, k.chunkIndex])]);
}
export const questionIdOf = (questionZh, keyPoints) => 'q' + crypto.createHash('sha256').update(`${questionZh}|${keyPoints.map((k) => k.textZh).join('|')}`).digest('hex').slice(0, 12);
export const signQuestion = (cfg, q) => crypto.createHmac('sha256', key(cfg)).update(canonicalQuestion(q)).digest('base64url');

const isStr = (x, max) => typeof x === 'string' && x.length > 0 && [...x].length <= max;
const isInt = (x) => Number.isInteger(x) && x >= 0 && x < 100000;

/**
 * Validate the structure of a client-sent question payload and its signature.
 * -> { ok:true, question:{signed fields only} } | { ok:false, code, message }.  Codes: invalid_question (shape), invalid_question_signature (tampered / other server).
 */
export function verifyQuestion(cfg, raw) {
  const no = (code, message) => ({ ok: false, code, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('invalid_question', 'question must be the object returned by /api/qa/next.');
  const { questionId, type, level, questionZh, modelAnswerZh, hintZh, sourceChunkIndex, keyPoints, signature } = raw;
  if (!/^q[0-9a-f]{12}$/.test(String(questionId)) || !TYPES.includes(type) || ![1, 2].includes(level) || !isStr(questionZh, 80) || !isStr(modelAnswerZh, 160) || !isStr(hintZh, 80)
    || !isInt(sourceChunkIndex) || !Array.isArray(keyPoints) || keyPoints.length < 1 || keyPoints.length > 4 || typeof signature !== 'string' || signature.length > 100) return no('invalid_question', 'question payload is incomplete or malformed.');
  const kps = [];
  for (const k of keyPoints) {
    if (!k || typeof k !== 'object' || !/^k[1-9]$/.test(String(k.id)) || !isStr(k.textZh, 80) || !isInt(k.refStart) || !isInt(k.refEnd) || k.refEnd <= k.refStart || !isInt(k.chunkIndex)) return no('invalid_question', 'question keyPoints are malformed.');
    kps.push({ id: k.id, textZh: k.textZh, refStart: k.refStart, refEnd: k.refEnd, chunkIndex: k.chunkIndex });
  }
  const q = { questionId, type, level, questionZh, modelAnswerZh, hintZh, sourceChunkIndex, keyPoints: kps };
  const want = Buffer.from(signQuestion(cfg, q)); const got = Buffer.from(signature);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return no('invalid_question_signature', 'The question was altered or was not issued by this server; ask for a new question.');
  return { ok: true, question: q };
}
