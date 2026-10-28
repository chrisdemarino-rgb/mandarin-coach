// Model-voice player for "Hear answer" / "Replay question" (Q&A) built on the ONE shared <audio> element (audio.js).
// Why it exists (docs/IOS-AUDIO-NOTES.md, "Hear answer does not play"): the old path fetched /api/tts AFTER the tap with no feedback, then called
// audio.play() seconds later, outside the user gesture. Here:
//   1. speak() is called synchronously from the tap handler. If the first clip is not cached it calls audio.prime() before any await, so the
//      shared element is already playing (silence) inside the gesture; the real clip is then loaded into the SAME element.
//   2. long text is split into sentences/short chunks; the first chunk is fetched and played ASAP, the rest are fetched in parallel meanwhile
//      and queued (ended -> next) on the same element. Clips are cached by voice|speed|text (api.js), shared with prefetch().
//   3. every failure ends in a typed error so the UI can show "Tap to retry" (the retry tap plays the cached clip inside its own gesture).
// Never records, never uploads, never creates another <audio>. The mic is released by audio.prime()/audio.play() before any sound.
import * as api from "./api.js";
import { audio } from "./audio-io.js";

const SINGLE_MAX = 60;     // <= this many characters: one request (the backend keeps model answers to ~60 characters)
const FIRST_MAX = 36;      // first chunk is one short sentence/clause so it comes back fast
const REST_MAX = 90;       // later chunks: whole sentences packed up to this length

/** Split Chinese text into [first short chunk, ...packed chunks]. Short text -> [text]. Pure; unit-tested. */
export function splitForTts(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  if ([...t].length <= SINGLE_MAX) return [t];
  const sentences = t.match(/[^。！？!?；;\n]+[。！？!?；;]*/g) || [t];
  const pieces = [];
  for (const raw of sentences) {
    const s = raw.trim(); if (!s) continue;
    if ([...s].length <= REST_MAX) { pieces.push(s); continue; }
    let cur = "";   // an over-long sentence: break after commas, then hard-cut
    for (const part of s.match(/[^，,、：:]+[，,、：:]*/g) || [s]) {
      if ([...cur + part].length > REST_MAX && cur) { pieces.push(cur); cur = ""; }
      cur += part;
      while ([...cur].length > REST_MAX) { const a = [...cur]; pieces.push(a.slice(0, REST_MAX).join("")); cur = a.slice(REST_MAX).join(""); }
    }
    if (cur) pieces.push(cur);
  }
  const out = []; let first = pieces.shift() || "";
  if ([...first].length > FIRST_MAX) {   // make the first chunk short: cut at the first comma inside the limit
    const a = [...first]; let cut = -1;
    for (let i = 0; i < Math.min(a.length, FIRST_MAX); i++) if (/[，,、：:]/.test(a[i])) cut = i + 1;
    if (cut > 4) { pieces.unshift(a.slice(cut).join("")); first = a.slice(0, cut).join(""); }
  }
  out.push(first);
  let cur = "";
  for (const p of pieces) { if (cur && [...cur + p].length > REST_MAX) { out.push(cur); cur = ""; } cur += p; }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

export class TtsPlayError extends Error {
  /** kind: 'fetch' (network/server) | 'blocked' (play() NotAllowedError: iOS wants a tap) | 'play' (any other playback failure) | 'not_configured' */
  constructor(kind, cause) { super(`${kind}: ${(cause && cause.message) || kind}`); this.name = "TtsPlayError"; this.kind = kind; this.cause = cause; this.network = !!(cause && cause.network); }
}

const isAbort = (e) => e && e.name === "AbortError";

/** Fetch (and cache) every chunk of `text` so a later tap plays instantly. Fire-and-forget; never throws. */
export function prefetch(text, { voice, speed } = {}) {
  for (const c of splitForTts(text)) api.tts(c, { voice, speed }).catch(() => {});
}
/** True when the FIRST chunk is already in memory (the tap can start playback synchronously). */
export const isReady = (text, o = {}) => { const c = splitForTts(text)[0]; return !!c && !!api.ttsPeek(c, o); };

/**
 * Speak `text`. MUST be called synchronously from the tap handler (no await before it).
 * o: {voice, speed, signal, isAlive(), onPhase('loading'|'playing')}. Resolves when everything played or was cancelled; rejects TtsPlayError.
 */
export async function speak(text, o = {}) {
  const chunks = splitForTts(text);
  if (!chunks.length) return;
  const { voice, speed, signal } = o;
  const alive = o.isAlive || (() => true);
  const first = api.ttsPeek(chunks[0], { voice, speed });
  // Inside the gesture, before any await: if the clip is not here yet, keep playback permission by priming the shared element.
  if (!first) { o.onPhase && o.onPhase("loading"); audio.prime(); }
  // Start every fetch now (shared + cached by api.tts): chunk 0 first, the rest in parallel so they are ready by the time chunk 0 ends.
  const fetches = chunks.map((c, i) => (i === 0 && first ? Promise.resolve(first) : api.tts(c, { voice, speed, signal })));
  fetches.forEach((p) => p.catch(() => {}));
  for (let i = 0; i < chunks.length; i++) {
    let blob;
    if (i === 0 && first) blob = first;
    else {
      try { blob = await fetches[i]; }
      catch (e) {
        if (isAbort(e) || !alive()) { return; }
        try { audio.stop(); } catch { /* end the silent prime */ }
        if (e && (e.status === 501 || e.code === "tts_not_configured")) throw new TtsPlayError("not_configured", e);
        throw new TtsPlayError("fetch", e);
      }
    }
    if (!alive()) { try { audio.stop(); } catch { /* ignore */ } return; }
    o.onPhase && o.onPhase("playing");
    try { await playOnce(blob, alive); }
    catch (e) {
      if (!alive()) return;
      throw new TtsPlayError(e && e.name === "NotAllowedError" ? "blocked" : "play", e);
    }
    if (!alive()) return;
  }
}

/** audio.play(blob), retried ONCE after a short pause (an AbortError from the prime->real src swap or a transient rejection often succeeds). */
async function playOnce(blob, alive) {
  try { return await audio.play(blob); }
  catch (e) {
    if (!alive() || audio.getState() === "recording") throw e;
    await new Promise((r) => setTimeout(r, 150));
    if (!alive()) return;
    return audio.play(blob);   // not in a gesture any more: if iOS refuses (NotAllowedError) the caller shows "Tap to retry"
  }
}
