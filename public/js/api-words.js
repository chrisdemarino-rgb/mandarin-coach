// ADAPTER for "Words to practise" + trouble-word drill. ALL knowledge of these endpoints' shapes lives here (and the wordStatus
// shape in highlight.js normalizeWordStatus). Backend-confirmed shape (see server/API-ATTEMPT.md when it lands):
//   GET    /api/words/missed[?all=1]      -> [{id,text,pinyin,meaning|null,missCount,correctStreak,needed,lastMissedAt,sourceChunk,status:'learning'|'known'}]
//   POST   /api/words/missed/:id/known    -> 204      POST .../learning -> 204 (undo)      DELETE /api/words/missed/:id -> 204
//   GET    /api/drill/next?n=5            -> [{wordId,text,pinyin,meaning,exampleSentence,correctStreak,needed}]
//   POST   /api/drill/attempt multipart {audio, wordId, attemptId} -> SSE (status|assessment|coach_text|coach_audio|error) ending
//          done {correct, correctStreak, needed, graduated, timings}     (server decides correctness and streak)
// A 404 from the list endpoint means "backend doesn't have this yet": callers hide the section (see isUnsupported()).
import { req, jsonOf, readSse, extFor, noteMock, ApiError } from "./api.js";

export const isUnsupported = (e) => !!e && (e.status === 404 || e.status === 501);

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function normalizeMissed(r) {
  r = r || {};
  return {
    id: str(r.id ?? r.wordId), text: str(r.text), pinyin: str(r.pinyin), meaning: r.meaning ? str(r.meaning) : "",
    missCount: num(r.missCount ?? r.misses), correctStreak: num(r.correctStreak ?? r.streak), needed: num(r.needed ?? r.streakNeeded),
    lastMissedAt: r.lastMissedAt || "", sourceChunk: str(r.sourceChunk), exampleSentence: str(r.exampleSentence),
    status: r.status === "known" ? "known" : "learning",
  };
}
/** What the learner must say in a drill. Mirrors the server's drillTarget(): the word itself, except a lone character (a poor isolated test) -> the user's own sentence. */
export function promptTextOf(w) {
  const t = String((w && w.text) || ""), src = String((w && (w.sourceChunk || w.exampleSentence)) || "");
  return Array.from(t).length >= 2 || !src || !src.includes(t) ? t : src;
}
export function normalizeDrillItem(r) {
  const w = normalizeMissed({ ...r, id: r && (r.wordId ?? r.id) });
  w.wordId = w.id; if (!w.exampleSentence) w.exampleSentence = w.sourceChunk;
  w.promptText = (r && typeof r.promptText === "string" && r.promptText) || promptTextOf(w);
  return w;
}
const listOf = (body, key) => (Array.isArray(body) ? body : body && Array.isArray(body[key]) ? body[key] : body && Array.isArray(body.words) ? body.words : []);

/** "1 of 3" (needed unknown -> "1 in a row") */
export const streakLabel = (streak, needed) => (needed ? `${streak} of ${needed} correct in a row` : `${streak} correct in a row`);

export const missed = {
  list: async ({ all = false } = {}) => listOf(await req("GET", `/api/words/missed${all ? "?all=1" : ""}`).then(jsonOf), "missed").map(normalizeMissed),
  known: (id) => req("POST", `/api/words/missed/${encodeURIComponent(id)}/known`).then(jsonOf),
  learning: (id) => req("POST", `/api/words/missed/${encodeURIComponent(id)}/learning`).then(jsonOf),
  remove: (id) => req("DELETE", `/api/words/missed/${encodeURIComponent(id)}`).then(jsonOf),
};

export const drill = {
  next: async (n = 5) => listOf(await req("GET", `/api/drill/next?n=${encodeURIComponent(n)}`).then(jsonOf), "items").map(normalizeDrillItem),
  /** Same contract as api.attempt(): resolves {replayed}; rejects ApiError. onEvent(name,data). Re-call with the same attemptId to retry. */
  async attempt({ blob, mime, wordId, attemptId, voice, speed, signal, onEvent }) {
    const fd = new FormData();
    fd.append("audio", blob, `take.${extFor(mime || blob.type || "")}`);
    fd.append("wordId", wordId);
    fd.append("attemptId", attemptId);
    if (voice) fd.append("voice", voice);
    if (speed) fd.append("speed", String(speed));
    const res = await req("POST", "/api/drill/attempt", { body: fd, signal });
    let terminal = false;
    try {
      await readSse(res, (name, data) => { noteMock(data, name); if (name === "error" || name === "done") terminal = true; onEvent(name, data); });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true });
    }
    if (!terminal) throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true });
    return { replayed: res.headers.get("X-Attempt-Replayed") === "true" };
  },
};
