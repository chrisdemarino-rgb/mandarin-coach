// "Hear my recording": plays the learner's just-recorded take back through the ONE shared <audio> element (audio.js), in every result view
// (close rehearsal + natural retelling share one result card; Q&A and the trouble-word drill have their own).
// Rules (docs/IOS-AUDIO-NOTES.md):
//  * audio.play(blob) is called synchronously inside the tap: it releases the mic first (stopStream before playback), re-asserts the
//    'playback' session and starts <audio>.play() on the shared element inside the gesture. No other element, no AudioContext.
//  * The take stays in browser memory only (Blob + object URL owned by session/drill/qa). Nothing here uploads or stores it; audio.js revokes
//    the playback URL when the clip ends, is stopped or is replaced, and the owners revoke the take URL when the next take starts / the
//    session or screen ends. This module never calls api.js, so the assessment path can never see this playback.
//  * Start/stop are "ours" for the interruption logic (audio.play/stop open own() windows) and never start a take.
//  * Disabled while recording / processing / the coach is speaking or loading audio (owner supplies blocked()). Stop toggle while playing;
//    on error the button says "Tap to retry" (the retry tap is a fresh gesture).
import { audio } from "./audio-io.js";

/** MediaRecorder blobs carry e.g. 'audio/mp4;codecs=mp4a.40.2' (iOS AAC) or 'audio/webm;codecs=opus'. Give <audio> a plain, correct type. */
export function playableBlob(take) {
  const b = take.blob, raw = String(take.mime || b.type || "").toLowerCase();
  const type = /mp4|m4a|aac/.test(raw) ? "audio/mp4" : /webm/.test(raw) ? "audio/webm" : /ogg/.test(raw) ? "audio/ogg" : /wav/.test(raw) ? "audio/wav" : /mpeg|mp3/.test(raw) ? "audio/mpeg" : raw.split(";")[0] || "audio/mp4";
  return b.type === type ? b : new Blob([b], { type });
}

/**
 * btn: the button element. getTake(): {blob, mime} | null (the owner's CURRENT take). blocked(): true while recording/processing/coach audio.
 * Returns {sync(), reset(), phase()}. Call sync() from the owner's render().
 */
export function createHearMine(btn, { getTake, blocked = () => false, label = "\u{1F50A} Hear my recording" }) {
  let phase = "idle", gen = 0, shown = null;
  function sync() {
    const take = getTake();
    if (take !== shown) { shown = take; if (phase !== "idle") reset(); }   // a new take (or none): drop any playing/error state of the old one
    btn.hidden = !take;
    if (!take) return;
    btn.disabled = phase !== "playing" && !!blocked();                      // Stop stays available while playing
    btn.textContent = phase === "playing" ? "\u25A0 Stop" : phase === "error" ? "Tap to retry" : label;
    btn.setAttribute("aria-pressed", phase === "playing" ? "true" : "false");
  }
  function reset() {
    gen++;
    if (phase === "playing") { try { audio.stop(); } catch { /* ignore */ } }
    phase = "idle"; sync();
  }
  btn.addEventListener("click", () => {
    if (phase === "playing") { gen++; try { audio.stop(); } catch { /* ignore */ } phase = "idle"; sync(); return; }   // Stop toggle
    const take = getTake();
    if (!take || blocked()) return;
    const mine = ++gen;
    phase = "playing"; sync();
    let p;
    // audio.play() runs synchronously up to its first await: mic release + src + <audio>.play() all happen inside this tap.
    try { p = audio.play(playableBlob(take)); } catch (e) { p = Promise.reject(e); }
    p.then(() => { if (mine === gen) { phase = "idle"; sync(); } },
      (e) => { if (mine !== gen) return; phase = "error"; console.warn("[hear-mine]", e && e.name, e && e.message); sync(); });
  });
  return { sync, reset, phase: () => phase };
}
