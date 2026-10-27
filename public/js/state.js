// State machine (pure, node-testable) + small persisted store (localStorage, guarded so node can import it).

/* ---------------- practice state machine ---------------- */
export const STATES = ["idle", "prompting", "listening", "processing", "result", "playback", "paused", "finished"];

// state -> { EVENT: nextState }.  RESUME is special: goes back to ctx.resumeTo.
export const TRANSITIONS = {
  idle:       { START: "prompting", FINISH: "finished" },
  prompting:  { PROMPT_DONE: "listening", RETRY: "prompting", NEXT: "prompting", PAUSE: "paused", FINISH: "finished", ABORT: "idle" },
  listening:  { STOP: "processing", REARM: "listening", RETRY: "prompting", NEXT: "prompting", PAUSE: "paused", FINISH: "finished", ABORT: "idle" },
  processing: { RESULT: "result", RETRY: "prompting", NEXT: "prompting", FINISH: "finished", ABORT: "idle" },
  result:     { PLAY: "playback", RETRY: "prompting", NEXT: "prompting", PAUSE: "paused", FINISH: "finished", ABORT: "idle" },
  playback:   { PLAY_END: "result", RETRY: "prompting", NEXT: "prompting", PAUSE: "paused", FINISH: "finished" },
  paused:     { RESUME: null, RETRY: "prompting", NEXT: "prompting", FINISH: "finished", ABORT: "idle" },
  finished:   { RESET: "idle", START: "prompting" },
};
// What PAUSE remembers so RESUME can restore it (playback resumes as result).
const RESUME_MAP = { prompting: "prompting", listening: "listening", result: "result", playback: "result" };

export function createMachine(initial = "idle") {
  let state = initial;
  let resumeTo = null;
  const subs = new Set();
  return {
    get state() { return state; },
    get resumeTo() { return resumeTo; },
    can(event) { return event in (TRANSITIONS[state] || {}); },
    /** Returns true if the transition happened. Invalid events are ignored (no throw). */
    send(event, data) {
      const row = TRANSITIONS[state] || {};
      if (!(event in row)) return false;
      const from = state;
      let to = row[event];
      if (event === "PAUSE") resumeTo = RESUME_MAP[from] || "result";
      if (event === "RESUME") to = resumeTo || "result";
      state = to;
      const info = { from, to, event, data, resumed: event === "RESUME" };
      subs.forEach((fn) => fn(info));
      return true;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/* ---------------- persisted store ---------------- */
const mem = {};
const ls = {
  get(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : mem[k] ?? null; } catch { return mem[k] ?? null; } },
  set(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); else mem[k] = v; } catch { mem[k] = v; } },
};
export function loadJSON(key, fallback) {
  try {
    const v = ls.get(key);
    if (!v) return fallback;
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : { ...fallback, ...parsed };
  } catch { return fallback; }
}
export function saveJSON(key, value) { ls.set(key, JSON.stringify(value)); }

export const KEYS = { script: "mc.script", progress: "mc.progress", settings: "mc.settings" };

// Server-side prefs (GET/PUT /api/prefs): chunkMode, assessMode, practiceMode, voice, speed.
// Local-only prefs: showFeedback, showPinyin.
export const DEFAULT_SETTINGS = {
  chunkMode: "sentence",
  assessMode: "close",          // close | retell
  practiceMode: "listen_repeat", // listen_repeat | fading_cues
  voice: "",                    // "" = server default
  speed: 1,                     // 0.6 - 1.2
  showFeedback: true,
  showPinyin: true,
  autoCoach: true,
};

export function createStore() {
  const subs = new Set();
  const emit = (what) => subs.forEach((fn) => fn(what));
  const store = {
    settings: { ...DEFAULT_SETTINGS, ...loadJSON(KEYS.settings, {}) },
    script: loadJSON(KEYS.script, { text: "" }),
    progress: loadJSON(KEYS.progress, null),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setSettings(patch, quiet = false) { store.settings = { ...store.settings, ...patch }; saveJSON(KEYS.settings, store.settings); if (!quiet) emit("settings"); },
    setScript(text) { store.script = { text }; saveJSON(KEYS.script, store.script); emit("script"); },
    setProgress(p) { store.progress = p; saveJSON(KEYS.progress, p); },
  };
  if (!store.progress || typeof store.progress !== "object" || Array.isArray(store.progress)) {
    store.progress = { sentenceIndex: 0, done: [], scriptHash: "" };
  }
  return store;
}

export function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}
