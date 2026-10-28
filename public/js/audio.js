// audio.js: iPhone-Safari-safe audio module for the Mandarin coach (ES module, no dependencies).
// Owner: Audio & Deployment bot. Background and sources: docs/IOS-AUDIO-NOTES.md
//
// Rules this module enforces:
//   * Mic and playback NEVER overlap (startRecording refuses while anything is playing or speechSynthesis is speaking;
//     play() refuses while recording). A short guard delay after playback ends covers Bluetooth output latency.
//   * One reused <audio> element, unlocked by the first tap (unlock()).
//   * navigator.audioSession handling with graceful fallback when the API does not exist.
//   * One MediaStream kept open between takes by default (avoids permission re-prompts); tracks are disabled while idle.
//
// States: 'idle' | 'armed' | 'recording' | 'processing' | 'playing'
//   idle       nothing happening (mic may be closed)
//   armed      mic stream open and ready, nothing recording/playing
//   recording  MediaRecorder running
//   processing a take just finished / caller is uploading (caller calls markProcessing()/markDone())
//   playing    the <audio> element is playing a clip
//
// Public API:
//   init(opts)                      -> audioEl. opts: {keepMicOpen=true, sessionStrategy='before'|'kick', postPlaybackGuardMs=450,
//                                       maxRecordMs=110000, echoCancellation=true, noiseSuppression=true, autoGainControl=true, audioEl, log}
//   on(event, fn) / off(event, fn)  events: 'state' (newState, oldState), 'log' (msg), 'error' (err), 'maxlength',
//                                       'interrupted' (isInterrupted:bool, info:{source, recoverable}) -- DEBOUNCED: fires true only for a REAL
//                                       interruption (page hidden >= hiddenMs, audioSession 'interrupted' persisting >= interruptDebounceMs,
//                                       mic track muted that long while recording, or mic track 'ended' that we did not cause) and false when it is
//                                       over (page visible, audioSession back, track unmuted). Our own mic release, playback start/stop and
//                                       audioSession.type switches never count. 'diag' (entry) fires for every diagnostic entry.
//   recordEvent(name, verdict, detail) / getEvents() / clearEvents()   in-memory ring buffer, also window.__audioEvents + console.debug
//   getState()
//   unlock()                        -> Promise<bool>; call inside a tap handler, once. Unlocks <audio>, sets session 'playback'.
//   prime()                         -> Promise<bool>; call synchronously inside a tap when the clip is still being fetched: keeps playback permission on the shared element.
//   play(url|Blob)                  -> Promise resolved when 'ended' fired (after which state is armed/idle). Rejects if recording.
//   stop()                          stop playback now
//   startRecording()                -> Promise<{mime, sessionType, track}> (resolves once the recorder is actually running)
//   stopRecording()                 -> Promise<{blob, mime, durationMs, valid, reason?}>
//   markProcessing() / markDone()   optional: let the UI reflect upload state in the same state machine
//   resetToPlayback({kick})         after mic use: release session back to 'playback' (ends on 'playback')
//   releaseMic()                    stop the mic stream and reset to playback
//   pickMimeType()                  best MediaRecorder mime for this browser ('' means browser default)
//   diagnostics()                   plain object for logging
//   analyzeBlob(blob)               -> {sampleRate, channels, durationS, peak, rms} (decodes the recording; for tests/QA)
//   makeToneWav(opts)               -> Blob (wav) test tone, handy for tests

const listeners = {};
let audioEl = null;
let stream = null;
let recorder = null;
let chunks = [];
let state = 'idle';
let opts = {
  keepMicOpen: true, sessionStrategy: 'before', postPlaybackGuardMs: 450, maxRecordMs: 110000, interruptDebounceMs: 1800, hiddenMs: 1500,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, log: null,
};
let unlocked = false;
let silentUrl = null;
let lastPlaybackEndedAt = 0;
let recStartedAt = 0;
let overlapDuringTake = false;
let interruptedDuringTake = false;
let maxTimer = null;
let overlapTimer = null;
let currentPlayResolve = null;
let currentObjectUrl = null;

// ---- interruption handling (v7) -------------------------------------------------------------------------------
// Why: iOS fires audioSession 'statechange' (and track mute/ended) as a side effect of OUR OWN mic release, playback start/stop and
// audioSession.type switches, and for brief Bluetooth route changes. The old code treated every statechange as an interruption.
// Rules now: (1) everything we do opens a short "ours" window (own()); (2) only the 'interrupted' state, a muted mic, or hidden page can
// start an interruption, and only if it PERSISTS past a debounce; (3) events are logged with a verdict in a ring buffer.
const OWN_MS = 1500;                 // events within this long after one of our own actions are attributed to us
let ownUntil = 0;
let realInterruption = null;         // source name while a persisted interruption is active (announced via 'interrupted' true)
let hiddenAt = 0;
const suspectTimers = {};
const EVENT_MAX = 300;
const eventRing = [];
const t0Diag = (typeof performance !== 'undefined' ? performance.now() : 0);
if (typeof window !== 'undefined') window.__audioEvents = eventRing;
export function getEvents() { return eventRing.slice(); }
export function clearEvents() { eventRing.length = 0; }
// verdict: 'info' | 'ours' | 'ignored' | 'debounce-start' | 'debounced' (cleared before persisting) | 'REAL' | 'recovered'
export function recordEvent(name, verdict = 'info', detail = '') {
  const e = { t: +(((typeof performance !== 'undefined' ? performance.now() : 0) - t0Diag) / 1000).toFixed(2), name, verdict, detail: String(detail || ''),
    state, hidden: typeof document !== 'undefined' ? !!document.hidden : null, session: hasSession() ? navigator.audioSession.state : null };
  eventRing.push(e); if (eventRing.length > EVENT_MAX) eventRing.shift();
  try { console.debug('[audio-event]', e.t, name, verdict, e.detail); } catch (err) {}
  emit('diag', e);
  return e;
}
const isOwn = () => Date.now() < ownUntil;
function own(label, ms = OWN_MS) { ownUntil = Math.max(ownUntil, Date.now() + ms); recordEvent('own:' + label, 'ours'); }
// Stop every mic track. We call this on purpose, so it is "ours" (stop() itself does not fire 'ended' per spec, but Safari may fire
// mute/statechange around it).
function stopStream(why) {
  if (!stream) return;
  own('mic-stop:' + why);
  stream.getTracks().forEach(t => t.stop()); stream = null;
}
// Start a debounce for a suspected interruption. After the delay (plus any remaining "ours" window) it becomes REAL only if check() still holds.
function suspect(source, check, ms, { extendOwn = true } = {}) {
  if (suspectTimers[source]) return;
  const wait = ms + (extendOwn ? Math.max(0, ownUntil - Date.now()) : 0);
  recordEvent(source, 'debounce-start', `${wait} ms${extendOwn && isOwn() ? ' (extended: our own action in progress)' : ''}`);
  suspectTimers[source] = setTimeout(() => {
    delete suspectTimers[source];
    if (check()) declareInterruption(source); else recordEvent(source, 'debounced', 'cleared before it persisted');
  }, wait);
}
function unsuspect(source, why) {
  if (!suspectTimers[source]) return;
  clearTimeout(suspectTimers[source]); delete suspectTimers[source];
  recordEvent(source, 'debounced', why || 'recovered before it persisted');
}
function declareInterruption(source, { recoverable = true } = {}) {
  if (realInterruption) { recordEvent(source, 'ignored', `already interrupted by ${realInterruption}`); return; }
  realInterruption = source;
  if (state === 'recording') interruptedDuringTake = true;
  recordEvent(source, 'REAL', recoverable ? 'interruption persisted' : 'not auto-recoverable');
  emit('interrupted', true, { source, recoverable });
  if (state === 'playing') stop();   // after the emit, so the session has already aborted its flow when play() settles
}
// Is the interruption over? Page visible, audioSession not 'interrupted', no live mic track muted. Then announce recovery once.
function checkRecovered() {
  if (!realInterruption) return;
  if (realInterruption === 'mic-ended') return;   // nothing tells us the mic is back: needs a user Resume
  if (typeof document !== 'undefined' && document.hidden) return;
  if (hasSession() && navigator.audioSession.state === 'interrupted') return;
  if (stream && stream.getAudioTracks().some(t => t.readyState === 'live' && t.muted)) return;
  const source = realInterruption; realInterruption = null;
  recordEvent(source, 'recovered', 'interruption over');
  emit('interrupted', false, { source });
}
function clearInterruption(why) { if (realInterruption) { recordEvent(realInterruption, 'info', 'interruption state cleared: ' + why); realInterruption = null; } }

// Tiny silent 8 kHz mono WAV used only to unlock the <audio> element on first tap.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export function on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => off(ev, fn); }
export function off(ev, fn) { listeners[ev]?.delete(fn); }
function emit(ev, ...args) { for (const fn of listeners[ev] || []) { try { fn(...args); } catch (e) { /* listener errors must not break audio */ } } }
function log(msg) { emit('log', msg); if (opts.log) try { opts.log(msg); } catch (e) {} }
function setState(s) { if (s === state) return; const old = state; state = s; log(`state ${old} -> ${s}`); emit('state', s, old); }
export function getState() { return state; }
// Mic permission as the Permissions API reports it: 'granted' | 'denied' | 'prompt' | 'unknown'.
// Safari support varies (older iOS has no 'microphone' query, or rejects), so any failure -> 'unknown'. Read-only; never prompts.
export async function getMicPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const s = (await navigator.permissions.query({ name: 'microphone' })).state;
    return s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown';
  } catch (e) { return 'unknown'; }
}

const hasSession = () => typeof navigator !== 'undefined' && 'audioSession' in navigator && navigator.audioSession;
export function getSessionType() { return hasSession() ? navigator.audioSession.type : null; }
function setSession(type) {
  if (!hasSession()) return false;
  if (navigator.audioSession.type !== type) own('audioSession.type=' + type);   // the statechange this triggers is ours
  try { navigator.audioSession.type = type; log(`audioSession.type = ${type}`); return true; }
  catch (e) { log(`audioSession.type=${type} failed: ${e.message}`); return false; }
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  const webm = ['audio/webm;codecs=opus', 'audio/webm'];
  const ogg = ['audio/ogg;codecs=opus'];
  const order = isIOS() ? [...mp4, ...webm, ...ogg] : [...webm, ...mp4, ...ogg];
  for (const t of order) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
  return '';
}

export function init(options = {}) {
  opts = { ...opts, ...options };
  audioEl = options.audioEl || audioEl || document.createElement('audio');
  audioEl.setAttribute('playsinline', '');
  audioEl.setAttribute('webkit-playsinline', '');
  audioEl.preload = 'auto';
  audioEl.controls = false;
  if (!audioEl.isConnected && options.attach !== false) { audioEl.style.display = 'none'; document.body.appendChild(audioEl); }
  if (!audioEl.__wired) { audioEl.__wired = true;
  audioEl.addEventListener('ended', onEnded);
  audioEl.addEventListener('error', () => { const err = new Error('audio element error ' + (audioEl.error && audioEl.error.code)); recordEvent('audio.error', 'info', err.message); emit('error', err); settlePlay(err); });
  // Diagnostics only: the <audio> element's own pause/play events never pause the session.
  audioEl.addEventListener('pause', () => recordEvent('audio.pause', (isOwn() || state !== 'playing') ? 'ours' : 'info', state === 'playing' ? 'while playing (system pause?)' : ''));
  audioEl.addEventListener('play', () => recordEvent('audio.play', 'info'));
  audioEl.addEventListener('ended', () => recordEvent('audio.ended', 'info'));
  if (hasSession() && navigator.audioSession.addEventListener) {
    navigator.audioSession.addEventListener('statechange', () => {
      const st = navigator.audioSession.state;
      log(`audioSession.state = ${st}`);
      if (st === 'interrupted') {
        recordEvent('audioSession.statechange:interrupted', isOwn() ? 'ours' : 'info', isOwn() ? 'inside our own-action window; only counts if it persists' : '');
        suspect('audioSession', () => hasSession() && navigator.audioSession.state === 'interrupted', opts.interruptDebounceMs);
      } else {
        // 'active' / 'inactive' are what iOS reports around our own mic release / playback: never an interruption by themselves.
        recordEvent('audioSession.statechange:' + st, isOwn() ? 'ours' : 'ignored');
        unsuspect('audioSession', 'audioSession is ' + st + ' again');
        checkRecovered();
      }
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      recordEvent('visibilitychange:hidden', 'info');
      // Debounced: a brief hide (Control Center, notification, app-switcher peek) is not an interruption.
      suspect('hidden', () => document.hidden || (hiddenAt && Date.now() - hiddenAt >= opts.hiddenMs), opts.hiddenMs, { extendOwn: false });
    } else {
      recordEvent('visibilitychange:visible', 'info', hiddenAt ? `hidden ${Date.now() - hiddenAt} ms` : '');
      // Timers are frozen while a locked page is suspended, so judge by how long we were actually hidden.
      const wasHidden = hiddenAt ? Date.now() - hiddenAt : 0;
      unsuspect('hidden', `visible again after ${wasHidden} ms`);
      if (wasHidden >= opts.hiddenMs && !realInterruption) declareInterruption('hidden');
      hiddenAt = 0;
      checkRecovered();
    }
  });
  // Diagnostics only (no behaviour): other lifecycle signals we want on record when debugging on a real device.
  window.addEventListener('pagehide', () => recordEvent('pagehide', 'info'));
  window.addEventListener('pageshow', () => recordEvent('pageshow', 'info'));
  window.addEventListener('blur', () => recordEvent('window.blur', 'ignored'));
  window.addEventListener('focus', () => recordEvent('window.focus', 'info'));
  }
  log(`init: audioSession ${hasSession() ? 'present' : 'ABSENT'}, mime=${pickMimeType() || '(default)'}`);
  return audioEl;
}

// Call from inside a tap handler (first interaction). Safe to call repeatedly.
let unlockPromise = null;
export function unlock() {
  if (!audioEl) init();
  // Never switch to 'playback' while the mic stream is live: on iOS that silently kills the mic (0-byte takes).
  if (!streamLive()) setSession('playback');
  if (unlocked) return Promise.resolve(true);
  if (unlockPromise) return unlockPromise;   // idempotent: concurrent taps share one attempt
  unlockPromise = (async () => {
    try {
      if (!silentUrl) silentUrl = URL.createObjectURL(makeToneWav({ seconds: 0.2, gain: 0 }));
      audioEl.src = silentUrl; audioEl.muted = false; audioEl.volume = 1;
      // play() can hang forever on iOS if the source is bad, so never wait more than 2 s.
      await Promise.race([audioEl.play(), new Promise((_, rej) => setTimeout(() => rej(new Error('play() did not settle in 2 s')), 2000))]);
      audioEl.pause();
      unlocked = true;
      log('audio element unlocked');
    } catch (e) { log('unlock play() failed: ' + e.message); }
    try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch (e) {}
    unlockPromise = null;
    return unlocked;
  })();
  return unlockPromise;
}

// prime(): re-assert playback permission INSIDE a tap, synchronously (no await before it). Used when the clip is not here yet (slow TTS fetch):
// the tap starts a tiny silent clip on the shared <audio> element so iOS keeps treating this element as user-started, and the real clip is
// then loaded into the SAME element when it arrives (play(src) sets a new src; it never creates another element). Unlike unlock() it does
// not depend on the `unlocked` flag, and it releases the mic first (a live mic stream must not run across playback anyway: BUG 3).
// Never touches `state`; our own pause/ended events are attributed to us through own(). Resolves true/false, never rejects.
let primeTimer = null;
export function prime() {
  try {
    if (!audioEl) init();
    if (state === 'recording' || state === 'playing') return Promise.resolve(false);
    if (stream) { stopStream('before-prime'); log('mic released before prime (reopened for next take)'); }
    if (!streamLive()) setSession('playback');
    if (!silentUrl) silentUrl = URL.createObjectURL(makeToneWav({ seconds: 0.2, gain: 0 }));
    own('prime');
    audioEl.src = silentUrl; audioEl.muted = false; audioEl.volume = 1;
    audioEl.loop = true;        // keep the element "actively playing" (silence) until the real clip is loaded into it; play()/stop() clear loop
    const p = audioEl.play();   // synchronous call inside the gesture
    clearTimeout(primeTimer);
    primeTimer = setTimeout(() => { if (audioEl.src === silentUrl && state !== 'playing') { audioEl.loop = false; try { audioEl.pause(); } catch (e) {} } }, 25000);   // safety: a fetch that never returns must not leave a silent loop running
    return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('prime play() did not settle in 2 s')), 2000))])
      .then(() => { unlocked = true; recordEvent('prime', 'ours', 'silent clip started'); return true; },
        (e) => { recordEvent('prime', 'info', 'play() rejected: ' + (e && e.name)); return false; });
  } catch (e) { return Promise.resolve(false); }
}

function onEnded() {
  lastPlaybackEndedAt = Date.now();
  own('playback-ended');
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  settlePlay(null);
  setState(streamLive() ? 'armed' : 'idle');
}
function settlePlay(err) { const r = currentPlayResolve; currentPlayResolve = null; if (r) err ? r.reject(err) : r.resolve(); }
function streamLive() { return !!stream && stream.getAudioTracks().some(t => t.readyState === 'live'); }

export async function play(src) {
  if (!audioEl) init();
  if (state === 'recording') throw new Error('refusing to play while recording');
  if (isSpeaking()) throw new Error('refusing to play while speechSynthesis is speaking');
  if (state === 'playing') stop();
  // Disable the mic while the model speaks so nothing can be captured even if a recorder existed.
  // iOS Safari: a mic stream kept alive across a playback often produces EMPTY takes afterwards (verified on iPhone,
  // iOS 18.7). So fully release the mic before any playback; the next take reopens it. Bonus: Bluetooth headphones
  // go back to high-quality playback while the model speaks.
  if (stream) { stopStream('before-playback'); log('mic released before playback (reopened for next take)'); }
  // If the mic is NOT open, make sure the session is 'playback' (media channel, ignores the mute switch).
  // If the mic IS open we must stay on 'play-and-record' (setting 'playback' would end the mic track per the W3C draft).
  if (!streamLive()) setSession('playback');
  let url = src;
  if (src instanceof Blob) { currentObjectUrl = URL.createObjectURL(src); url = currentObjectUrl; }
  own('playback-start');
  clearTimeout(primeTimer); audioEl.loop = false;   // a prime() silent loop may still be running on this element
  audioEl.src = url;
  audioEl.currentTime = 0;
  const done = new Promise((resolve, reject) => { currentPlayResolve = { resolve, reject }; });
  setState('playing');
  try { await audioEl.play(); }
  catch (e) { settlePlay(null); setState(streamLive() ? 'armed' : 'idle'); throw e; }
  return done;
}

export function stop() {
  if (!audioEl) return;
  own('stop');
  clearTimeout(primeTimer); audioEl.loop = false;
  try { audioEl.pause(); } catch (e) {}
  lastPlaybackEndedAt = Date.now();
  if (state === 'playing') { settlePlay(null); setState(streamLive() ? 'armed' : 'idle'); }
}

function isSpeaking() {
  try { return !!(window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)); } catch (e) { return false; }
}

async function acquireStream() {
  if (streamLive()) return stream;
  if (stream) stopStream('stale-before-acquire');
  if (opts.sessionStrategy === 'kick') setSession('auto'); else setSession('play-and-record');
  const constraints = { audio: {
    echoCancellation: opts.echoCancellation, noiseSuppression: opts.noiseSuppression, autoGainControl: opts.autoGainControl,
    channelCount: 1,
  } };
  own('getUserMedia');   // route changes (Bluetooth HFP switch) while the mic opens are ours
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  own('getUserMedia-done');
  if (opts.sessionStrategy === 'kick') setSession('play-and-record');
  const myStream = stream;
  const t = stream.getAudioTracks()[0];
  if (t) {
    log(`mic track: "${t.label}" settings=${JSON.stringify(t.getSettings ? t.getSettings() : {})}`);
    t.addEventListener('ended', () => {
      log('mic track ended');
      // Ours: we already released this stream (stale track) or are inside one of our own actions. Never an interruption.
      if (stream !== myStream) { recordEvent('mic.ended', 'ours', 'stale track (we released it)'); return; }
      // Our own releases go through stopStream(), which nulls `stream` first (so they are the stale case above, and track.stop() does not
      // fire 'ended' anyway). A live current track that ends is therefore the system's doing, even inside an own-action window.
      if (state === 'armed') setState('idle');
      stream = null;
      recordEvent('mic.ended', 'info', 'current track ended; not caused by us' + (isOwn() ? ' (inside own-action window)' : ''));
      declareInterruption('mic-ended', { recoverable: false });
    });
    t.addEventListener('mute', () => {
      log('mic track muted (system interruption?)');
      if (stream !== myStream) { recordEvent('mic.mute', 'ours', 'stale track'); return; }
      if (state !== 'recording') { recordEvent('mic.mute', isOwn() ? 'ours' : 'ignored', `not recording (state ${state})`); return; }
      recordEvent('mic.mute', isOwn() ? 'ours' : 'info', 'while recording; counts only if it persists');
      suspect('mic-mute', () => stream === myStream && t.muted, opts.interruptDebounceMs);
    });
    t.addEventListener('unmute', () => { log('mic track unmuted'); recordEvent('mic.unmute', 'info'); unsuspect('mic-mute', 'unmuted again'); checkRecovered(); });
  }
  return stream;
}

// Open the mic ahead of time (must be inside a tap the first time). Optional: startRecording() does this itself.
export async function armMic() {
  clearInterruption('armMic');   // user/session is (re)arming: any earlier interruption is over or handed to the user
  await acquireStream();
  if (stream) stream.getAudioTracks().forEach(t => { t.enabled = false; });
  if (state === 'idle') setState('armed');
}

export async function startRecording() {
  if (!audioEl) init();
  if (state === 'recording') throw new Error('already recording');
  if (state === 'playing' || isSpeaking()) throw new Error('refusing to record while audio is playing (would capture the model voice)');
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder not supported in this browser');
  if (audioEl && audioEl.loop) { clearTimeout(primeTimer); audioEl.loop = false; own('stop-prime'); try { audioEl.pause(); } catch (e) {} }   // end a prime() silent loop so it can't count as overlap
  // Let Bluetooth/output buffers drain after the last clip before the mic opens.
  const wait = opts.postPlaybackGuardMs - (Date.now() - lastPlaybackEndedAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (state === 'playing' || isSpeaking()) throw new Error('audio started during guard delay; not recording');
  clearInterruption('startRecording');
  await acquireStream();
  // Reused stream: make sure the session is still play-and-record (something may have switched it).
  if (hasSession() && navigator.audioSession.type !== 'play-and-record') setSession('play-and-record');
  stream.getAudioTracks().forEach(t => { t.enabled = true; });
  const mime = pickMimeType();
  chunks = []; overlapDuringTake = false; interruptedDuringTake = false;
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onerror = e => emit('error', e.error || new Error('MediaRecorder error'));
  recorder.start();
  recStartedAt = Date.now();
  setState('recording');
  clearTimeout(maxTimer);
  clearInterval(overlapTimer);
  overlapTimer = setInterval(() => { if (isSpeaking() || (audioEl && !audioEl.paused && audioEl.src !== SILENT_WAV)) { overlapDuringTake = true; log('OVERLAP: audio played while recording; take will be discarded'); } }, 100);
  maxTimer = setTimeout(() => { emit('maxlength'); log('max record length reached'); stopRecording().catch(() => {}); }, opts.maxRecordMs);
  return { mime: recorder.mimeType || mime || '', sessionType: getSessionType(), track: stream.getAudioTracks()[0] };
}

let stopping = null;
export function stopRecording() {
  if (stopping) return stopping;
  if (!recorder || recorder.state === 'inactive') return Promise.reject(new Error('not recording'));
  clearTimeout(maxTimer);
  clearInterval(overlapTimer);
  const r = recorder;
  stopping = new Promise((resolve) => {
    r.onstop = () => {
      const durationMs = Date.now() - recStartedAt;
      const mimeOut = r.mimeType || pickMimeType() || 'audio/mp4';
      const blob = new Blob(chunks, { type: mimeOut });
      chunks = []; recorder = null; stopping = null;
      if (stream) stream.getAudioTracks().forEach(t => { t.enabled = false; });
      let valid = true, reason;
      if (overlapDuringTake) { valid = false; reason = 'overlap'; }
      else if (interruptedDuringTake) { valid = false; reason = 'interrupted'; }
      else if (durationMs < 400 || blob.size < 500) { valid = false; reason = 'too_short'; }
      else if (blob.size > 10 * 1024 * 1024) { valid = false; reason = 'too_large'; }
      // A long take that produced no data means the mic stream went dead: drop it so the next take reopens it.
      if (reason === 'too_short' && durationMs >= 1000 && blob.size < 500 && stream) {
        log('dead mic stream detected (empty take); closing it so the next take reopens the mic');
        stopStream('dead-stream');
      }
      if (!opts.keepMicOpen) releaseMic();
      setState('processing');
      log(`take: ${durationMs} ms, ${blob.size} bytes, ${mimeOut}, valid=${valid}${reason ? ' (' + reason + ')' : ''}`);
      resolve({ blob, mime: mimeOut, durationMs, valid, reason });
    };
    try { r.stop(); } catch (e) { r.onstop(); }
  });
  return stopping;
}

// Optional helpers so the UI can show 'processing' during upload using the same state machine.
export function markProcessing() { if (state !== 'recording' && state !== 'playing') setState('processing'); }
export function markDone() { if (state === 'processing') setState(streamLive() ? 'armed' : 'idle'); }

// Return the iOS audio session to high-quality playback after the mic has been used.
export function resetToPlayback({ kick = true } = {}) {
  if (!hasSession()) return false;
  if (streamLive()) { log('resetToPlayback skipped: mic stream still live (it would end the track)'); return false; }
  setSession('playback');
  if (kick) { setSession('auto'); setSession('playback'); }
  return true;
}

export function releaseMic() {
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} }
  if (stream) { stopStream('releaseMic'); log('mic released'); }
  resetToPlayback();
  if (state === 'armed') setState('idle');
}

export function diagnostics() {
  const t = stream && stream.getAudioTracks()[0];
  return {
    userAgent: navigator.userAgent,
    isIOS: isIOS(),
    secureContext: window.isSecureContext,
    standalone: !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)),
    audioSessionSupported: !!hasSession(),
    audioSessionType: getSessionType(),
    audioSessionState: hasSession() ? navigator.audioSession.state : null,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    mimeChosen: pickMimeType() || '(default)',
    mimeSupport: typeof MediaRecorder !== 'undefined' ? Object.fromEntries(
      ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].map(m => [m, MediaRecorder.isTypeSupported(m)])) : {},
    speechSynthesis: 'speechSynthesis' in window,
    micTrack: t ? { label: t.label, readyState: t.readyState, enabled: t.enabled, muted: t.muted, settings: t.getSettings ? t.getSettings() : null } : null,
    state, unlocked,
  };
}

export async function analyzeBlob(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    let peak = 0, sum = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i] * d[i]; n++; }
    }
    return { sampleRate: buf.sampleRate, channels: buf.numberOfChannels, durationS: +buf.duration.toFixed(2), peak: +peak.toFixed(4), rms: +Math.sqrt(sum / n).toFixed(5), contextRate: ctx.sampleRate };
  } finally { try { ctx.close(); } catch (e) {} }
}

// Test tone as a WAV Blob (default 440 Hz, 1.5 s, gentle fade). Not speech; just something audible and clearly artificial.
export function makeToneWav({ freq = 440, seconds = 1.5, rate = 22050, gain = 0.4 } = {}) {
  const n = Math.floor(rate * seconds), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 0.05), (n - i) / (rate * 0.05));
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * freq * i / rate) * gain * env * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
