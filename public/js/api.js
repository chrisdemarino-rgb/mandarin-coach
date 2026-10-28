// Client for the real backend (same origin, cookie session). Contract: PLAN.md + app/server/API-ATTEMPT.md.
//   POST /api/login  GET /api/me  POST /api/logout  GET /api/health
//   GET/PUT /api/prefs   GET/POST/DELETE /api/words  POST /api/words/:id/history
//   POST /api/tts -> mp3   POST /api/cues -> {cue, items}   POST /api/attempt (multipart -> SSE)

export class ApiError extends Error {
  constructor(message, o = {}) {
    super(message);
    this.name = "ApiError";
    this.status = o.status || 0;
    this.code = o.code || "";
    this.retryable = o.retryable !== false;
    this.retryAfterSec = o.retryAfterSec || 0;
    this.network = !!o.network;
    this.auth = !!o.auth;
  }
}

const listeners = { mock: new Set(), auth: new Set() };
export const onMock = (fn) => listeners.mock.add(fn);      // fn({source, mock, engine})
export const onAuthLost = (fn) => listeners.auth.add(fn);
/** Tell the MOCK banner an event came from the mock engine (used by api-words.js). */
export const noteMock = (data, source) => { if (data && data.mock === true) fire(listeners.mock, { source, mock: true, engine: data.engine }); };
const fire = (set, ...a) => set.forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } });

async function errorFromResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  const e = (body && body.error) || {};
  const ra = Number(res.headers.get("Retry-After")) || e.retryAfterSec || 0;
  const status = res.status;
  let message = e.message || `Server error (${status}).`;
  if (status === 401 && e.code !== "bad_passcode") message = "Your session expired. Please sign in again.";
  if (status === 429 && ra) message = e.message || `Too many attempts. Try again in ${ra} seconds.`;
  return new ApiError(message, {
    status, code: e.code || (status === 401 ? "unauthorized" : ""), retryAfterSec: ra,
    retryable: e.retryable !== undefined ? e.retryable : status >= 500 || status === 429 || status === 409,
    auth: status === 401 && e.code !== "bad_passcode",
  });
}

export async function req(method, path, { json, body, signal, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: "same-origin", signal,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError("Can't reach the coach server. Check your connection and try again.", { network: true, retryable: true });
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (err.auth && path !== "/api/login") fire(listeners.auth, err);
    throw err;
  }
  return res;
}
export const jsonOf = async (res) => (res.status === 204 ? null : res.json());

/* ---------------- auth / health / prefs ---------------- */
export const login = (passcode) => req("POST", "/api/login", { json: { passcode } }).then(jsonOf);
export const logout = () => req("POST", "/api/logout").then(jsonOf);
export const me = () => req("GET", "/api/me").then(jsonOf);
export async function health() {
  const h = await req("GET", "/api/health").then(jsonOf);
  fire(listeners.mock, { source: "health", mock: !!h.mock, engine: h.engine });
  return h;
}
export const getPrefs = () => req("GET", "/api/prefs").then(jsonOf);
export const putPrefs = (patch) => req("PUT", "/api/prefs", { json: patch }).then(jsonOf);

/* ---------------- words ---------------- */
export const words = {
  list: () => req("GET", "/api/words").then(jsonOf),
  add: ({ text, pinyin, meaning, sourceChunk }) => req("POST", "/api/words", { json: { text, pinyin, meaning, sourceChunk } }).then(jsonOf),
  remove: (id) => req("DELETE", `/api/words/${encodeURIComponent(id)}`).then(jsonOf),
  history: (id, result) => req("POST", `/api/words/${encodeURIComponent(id)}/history`, { json: { result } }).then(jsonOf),
};

/* ---------------- tts / cues ---------------- */
const ttsCache = new Map(); // "voice|speed|text" -> Blob (small LRU)
const ttsInflight = new Map(); // same key -> Promise<Blob> of the ONE request in flight (shared by prefetch + taps; never carries a caller's AbortSignal)
const ttsKey = (text, { voice, speed } = {}) => `${voice || ""}|${speed || 1}|${text}`;
/** Synchronous cache peek (Blob | null). Lets a tap handler start playback inside the user gesture when the audio is already here. */
export function ttsPeek(text, o = {}) { const b = ttsCache.get(ttsKey(text, o)); return b || null; }
const abortable = (p, signal) => !signal ? p : new Promise((resolve, reject) => {
  const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  if (signal.aborted) return onAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
});
/** Model/coach voice for `text` (<= 500 chars). Returns an audio/mpeg Blob. Never upload this to /api/attempt.
 *  The network request is shared per key: a second call (prefetch, double tap, retry) joins the request already in flight instead of
 *  restarting it, and `signal` only stops THIS caller from waiting (it no longer cancels the shared request). */
export function tts(text, { voice, speed, signal } = {}) {
  const key = ttsKey(text, { voice, speed });
  if (ttsCache.has(key)) { const b = ttsCache.get(key); ttsCache.delete(key); ttsCache.set(key, b); return Promise.resolve(b); }
  let p = ttsInflight.get(key);
  if (!p) {
    p = (async () => {
      const res = await req("POST", "/api/tts", { json: { text, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}) } });
      const blob = await res.blob();
      ttsCache.set(key, blob);
      if (ttsCache.size > 40) ttsCache.delete(ttsCache.keys().next().value);
      return blob;
    })().finally(() => ttsInflight.delete(key));
    ttsInflight.set(key, p);
    p.catch(() => {}); // a prefetch nobody awaits must not raise an unhandled rejection
  }
  return abortable(p, signal);
}

const cueCache = new Map(); // "level|text" -> promise<{level,cue,items?,source}>
/** Fading cue for a piece (<= 100 chars). Level 1 keywords+pinyin, 2 first chars, 3 topic hint, 4 nothing. Cached + prefetchable. */
export function cues(chunkText, level) {
  const key = `${level}|${chunkText}`;
  if (cueCache.has(key)) return cueCache.get(key);
  const p = req("POST", "/api/cues", { json: { chunkText, level } }).then(jsonOf);
  cueCache.set(key, p);
  p.catch(() => cueCache.delete(key));
  if (cueCache.size > 300) cueCache.delete(cueCache.keys().next().value);
  return p;
}
export const prefetchCues = (text, levels = [1, 2, 3, 4]) => levels.forEach((l) => cues(text, l).catch(() => {}));

/* ---------------- attempt (multipart -> SSE) ---------------- */
export const extFor = (mime) => (/mp4|m4a|aac/.test(mime) ? "m4a" : /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "bin");

/** Parse a text/event-stream from a fetch Response, calling onEvent(name, data) per event. */
export async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (block) => {
    let ev = "message"; const data = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const f = i < 0 ? line : line.slice(0, i);
      const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (f === "event") ev = v; else if (f === "data") data.push(v);
    }
    if (!data.length) return;
    let parsed; try { parsed = JSON.parse(data.join("\n")); } catch { return; }
    onEvent(ev, parsed);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  buf += dec.decode();
  if (buf.trim()) flush(buf.replace(/\r\n/g, "\n"));
}

/**
 * Upload one recorded take and stream the result.
 * Re-call with the SAME attemptId to retry the same take after a network failure (server dedupes / replays).
 * onEvent(name, data) gets status | assessment | coach_text | coach_audio | error | done.
 * Resolves {replayed} when the stream ends; rejects ApiError (pre-stream validation / network / dropped stream).
 */
export async function attempt({ blob, mime, chunkText, assessMode, practiceMode, attemptId, voice, speed, signal, onEvent }) {
  const fd = new FormData();
  fd.append("audio", blob, `take.${extFor(mime || blob.type || "")}`);
  fd.append("chunkText", chunkText);
  fd.append("assessMode", assessMode);
  fd.append("practiceMode", practiceMode);
  fd.append("attemptId", attemptId);
  if (voice) fd.append("voice", voice);
  if (speed) fd.append("speed", String(speed));
  const res = await req("POST", "/api/attempt", { body: fd, signal });
  let sawTerminal = false;
  try {
    await readSse(res, (name, data) => {
      if (data && data.mock === true) fire(listeners.mock, { source: name, mock: true, engine: data.engine });
      if (name === "error" || name === "done" || name === "assessment") sawTerminal = true;
      onEvent(name, data);
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true });
  }
  if (!sawTerminal) throw new ApiError("The connection dropped while waiting for the result.", { network: true, retryable: true });
  return { replayed: res.headers.get("X-Attempt-Replayed") === "true" };
}
