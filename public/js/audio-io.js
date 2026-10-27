// Thin adapter over the Audio bot's module (./audio.js; DO NOT edit that file).
// Rules (docs/IOS-AUDIO-NOTES.md, STATUS.md): init() once, unlock() inside the first tap, ALL model/coach audio goes through
// audio.play(url|Blob) (single <audio> element), never speechSynthesis / AudioContext playback, never record while playing.
import * as audio from "./audio.js";

let inited = false;
let audioEl = null;
export function ensureInit() {
  if (!inited) { inited = true; audioEl = audio.init(); }
  return audio;
}
export const getAudioEl = () => audioEl;

/** Call inside a tap handler: unlock the audio element and open (arm) the microphone. Throws a friendly MicError. */
export async function startAudioFromTap() {
  ensureInit();
  await audio.unlock();
  try { await audio.armMic(); } catch (e) { throw micError(e); }
}

export class MicError extends Error { constructor(message, code, cause) { super(message); this.name = "MicError"; this.code = code; this.cause = cause; } }

export function micError(e) {
  if (e instanceof MicError) return e;
  const name = (e && e.name) || "";
  const msg = (e && e.message) || String(e);
  if (typeof window !== "undefined" && window.isSecureContext === false)
    return new MicError("The microphone needs a secure (https) page. Open the app from its https address.", "insecure", e);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return new MicError("Microphone access was blocked. On iPhone: Settings > Safari > Microphone (or tap the aA icon > Website Settings) and choose Allow, then tap Retry.", "denied", e);
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError")
    return new MicError("No microphone found. Connect headphones with a mic or check your device, then tap Retry.", "no-device", e);
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return new MicError("The microphone is busy (another app or a call may be using it). Close it and tap Retry.", "busy", e);
  if (/MediaRecorder not supported/i.test(msg) || (typeof MediaRecorder === "undefined"))
    return new MicError("This browser can't record audio. Use Safari on iPhone (iOS 14.5 or newer) or a recent Chrome.", "unsupported", e);
  return new MicError("Couldn't use the microphone: " + msg, "unknown", e);
}

export const RECORDING_PROBLEMS = {
  too_short: "That was too short. Try again.",
  overlap: "Discarded: audio played while recording. Try again.",
  interrupted: "Discarded: the recording was interrupted. Try again.",
  too_large: "That recording is too long to upload (over 10 MB). Record a shorter piece.",
};

export { audio };
