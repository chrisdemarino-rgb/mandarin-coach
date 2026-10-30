// ADAPTER for Free talk. ALL knowledge of the /api/talk/* shapes lives in this file (plus the pure helpers the controller needs).
// Aligned to the Backend working tree (server/routes/talk.js + services/talk.js, 28 Oct, uncommitted when written; API-ATTEMPT.md had no "Free talk" section yet):
//   POST /api/talk/opening[?audio=1&voice&speed]  json {topic, scriptVocab?:[{text}], level?} -> {ok, textZh, pinyin, textAudio?:{url}}
//   POST /api/talk/turn     multipart {audio, attemptId, context: JSON {topic, scriptVocab?, turns:[{role:'coach'|'user', text}] (recent, never the current take), level?, tone?}, voice?, speed?}
//        -> SSE: status {stage:'transcribing'|'coaching'|'speaking', skipped?, code?} | transcript {text, sttStatus:'ok'|'empty'|'too_short'|'hallucination', hanziCount, hasEnglish}
//           | assessment (ONLY when context.tone===true; never requested here) | coach_text {delta, index, role:'reply'|'question'|'correction'|'correction_model'|'vocab'|'praise'|'gate', caption?}
//           | coach_audio {url, index, text} | error {code,message,retryable,canSkip,stage} | done {gate?, correction:{kind,quote,betterZh,explainZh,pinyin}|null, suggestedWords:[{text,pinyin,meaning,reason}], replyZh, questionZh, degraded?, ...}
//   POST /api/talk/summary  json {topic, level?, turns:[{role,text}], scriptVocab?} -> {ok, takeaways:[{textEn,textZh,pinyin}], newWords:[{text,pinyin,meaning,exampleZh,savedMeaning?}], phrasesToTry:[{zh,pinyin,en,whyEn}], strengths:[string], statsDerived}
// Still tolerated (provisional / optional): transcript under `assessment`, pinyin on coach_text / done (replyPinyin, questionPinyin) - the backend sends none for the coach's reply yet.
// Rules baked in here:
//  * The transcript is "what I heard" only: it is NEVER tone/pronunciation evidence. Acoustic notes are accepted ONLY from an explicit `acoustic` object that
//    says it is acoustic ({source:'acoustic'|'audio'|'toneperfect'}); nothing is ever derived from the transcript. Free talk never asks for the tone check.
//  * Missing fields never throw: every normaliser returns a safe default.
//  * 404 / 501 = "Free talk isn't available yet" (isUnsupported).
import { req, jsonOf, readSse, extFor, noteMock, ApiError } from "./api.js";
import { stripDirections } from "../shared/script.js";
import { SCRIPT_MAX } from "./limits.js";

export const isUnsupported = (e) => !!e && (e.status === 404 || e.status === 501);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const cps = (s) => Array.from(String(s || ""));
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const hanCount = (s) => cps(s).filter((c) => HAN.test(c)).length;
const clip = (s, n) => cps(s).slice(0, n).join("");

export const MAX_HISTORY_TURNS = 8;     // recent context sent with each turn
export const MAX_TURN_CHARS = 400;      // per turn text sent as context
export const MAX_SUMMARY_TURNS = 40;
export const TOPIC_MAX = 80;
export const MAX_VOCAB = 40;           // the backend uses at most 40 script words

/* ---------------- topic ---------------- */
const GREETING = /^(大家好|你好|您好|各位好|同学们好|老师好|哈喽|嗨)[！!，,。.\s]*$/;
const TOPIC_VERBS = /(?:聊一聊|聊聊|谈一谈|谈谈|说一说|说说|讲一讲|讲讲|分享一下|介绍一下|介绍|关于)([^，。！？；,.!?;\s、]{2,12})/;
/** A short default topic from the script: a "talk about X" phrase, else a short title line, else the first real sentence (<= 20 hanzi). "" when nothing usable. */
export function defaultTopic(scriptText) {
  const clean = stripDirections(String(scriptText || ""));
  const lines = clean.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const first = lines[0];
  // a title line: short, no sentence punctuation, mostly hanzi
  if (cps(first).length <= 16 && !/[。！？!?；，,]/.test(first) && hanCount(first) >= 2 && lines.length > 1) return first;
  const sentences = clean.split(/[。！？!?；\n]+/).map((s) => s.trim()).filter((s) => hanCount(s) >= 2 && !GREETING.test(s));
  if (!sentences.length) return clip(first.replace(/[。！？!?，,；;\s]+$/, ""), 20);
  const m = sentences.slice(0, 3).map((s) => s.match(TOPIC_VERBS)).find(Boolean);
  if (m) return m[1];
  const s = sentences[0];
  if (cps(s).length <= 20) return s;
  const parts = s.split(/[，,、：:]/).map((p) => p.trim()).filter(Boolean);
  let out = "";
  for (const p of parts) { if (cps(out + p).length > 20 && out) break; out = out ? `${out}，${p}` : p; }
  return clip(out || s, 20);
}
export const cleanTopic = (t) => clip(String(t || "").replace(/\s+/g, " ").trim(), TOPIC_MAX);

/* ---------------- context sent to the backend ---------------- */
const turnText = (t) => clip(str(t && t.text), MAX_TURN_CHARS);
/** Recent finished turns -> [{role:'user'|'coach', text}] (text-only, newest last). In-flight / failed / empty turns are never sent. */
export function historyFor(turns, max = MAX_HISTORY_TURNS) {
  return (Array.isArray(turns) ? turns : []).filter((t) => t && (t.role === "user" || t.role === "coach") && t.status === "ok" && turnText(t)).slice(-max).map((t) => ({ role: t.role, text: turnText(t) }));
}
export const summaryTurns = (turns) => historyFor(turns, MAX_SUMMARY_TURNS);
/** Does the conversation have anything to summarise? (at least one heard user turn) */
export const hasUserSpeech = (turns) => (Array.isArray(turns) ? turns : []).some((t) => t && t.role === "user" && t.status === "ok" && turnText(t));

/* ---------------- turn SSE events ---------------- */
const NO_SPEECH = new Set(["no_speech", "no_speech_detected", "empty", "silence", "gated", "too_quiet", "too_short", "hallucination"]);
const TIP_ROLES = new Set(["correction", "correction_model"]);
export const isTipRole = (r) => TIP_ROLES.has(r);
const idx = (d) => (Number.isInteger(d.index) && d.index >= 0 ? d.index : 0);
/** One SSE event -> {kind:'status'|'transcript'|'coach_text'|'coach_audio'|'error'|'done'|'ignore', ...normalised}. Never throws. */
export function readEvent(name, data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  if (name === "status") return { kind: "status", stage: str(d.stage), skipped: !!d.skipped };
  if (name === "transcript" || name === "heard") return { kind: "transcript", ...normalizeHeard(d) };
  if (name === "assessment") { const h = normalizeHeard(d); return h.transcript || h.noSpeech || h.acoustic ? { kind: "transcript", ...h } : { kind: "ignore" }; }   // tone result of the backend is not used
  if (name === "coach_text") {
    const text = typeof d.delta === "string" ? d.delta : typeof d.text === "string" && d.delta === undefined ? d.text : "";
    return { kind: "coach_text", index: idx(d), text, replace: d.delta === undefined && typeof d.text === "string", role: str(d.role), pinyin: str(d.pinyin), caption: str(d.caption) };
  }
  if (name === "coach_audio") return str(d.url) ? { kind: "coach_audio", index: idx(d), url: str(d.url), text: str(d.text) } : { kind: "ignore" };
  if (name === "error") return { kind: "error", code: str(d.code), message: str(d.message), retryable: d.retryable, canSkip: d.canSkip };
  if (name === "done") return {
    kind: "done", transcript: str(d.transcript), coachText: str(d.coachText || d.reply || d.coach), coachPinyin: str(d.coachPinyin || d.pinyin), acoustic: normalizeAcoustic(d.acoustic),
    gate: str(d.gate), correction: normalizeCorrection(d.correction), suggested: normalizeSuggested(d.suggestedWords), replyZh: str(d.replyZh), questionZh: str(d.questionZh),
    replyPinyin: str(d.replyPinyin), questionPinyin: str(d.questionPinyin), ...upgradeOf(d), degraded: str(d.degraded), raw: d,
  };
  return { kind: "ignore" };
}
/** done.upgradeStatus/upgrade/onTopic/saveable -> {upgradeStatus, upgrade (only when status 'ok'), onTopic:true|false|null, saveable:[{text,pinyin,meaning,sourceChunk}]}. */
const UP_STATUS = new Set(["ok", "none", "ungrounded", "unavailable", "no_script", "skipped"]);
export function upgradeOf(d) {
  const o = d && typeof d === "object" ? d : {};
  const raw = str(o.upgradeStatus).toLowerCase();
  const status = UP_STATUS.has(raw) ? raw : raw ? "none" : (o.upgrade ? "ok" : "none");
  const upgrade = status === "ok" ? normalizeUpgrade(o.upgrade) : null;
  return { upgradeStatus: upgrade ? "ok" : status === "ok" ? "none" : status, upgrade, onTopic: o.onTopic === true ? true : o.onTopic === false ? false : null, saveable: normalizeSaveable(o.saveable) };
}
/** done.saveable -> [{text, pinyin, meaning, sourceChunk}] ready for POST /api/words (deduped, max 8). */
export function normalizeSaveable(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : []).map((w) => (w && typeof w === "object" ? { text: str(w.text), pinyin: str(w.pinyin), meaning: str(w.meaning), sourceChunk: clip(str(w.sourceChunk), 200) } : null))
    .filter((w) => w && w.text && cps(w.text).length <= 20 && !seen.has(w.text) && seen.add(w.text)).slice(0, 8);
}
/** Short soft note under a coach reply (or "" for none). Never claims anything about sound. */
export function upgradeNoteOf(status, onTopic) {
  const n = [];
  if (onTopic === false) n.push("That was a bit off your script's topic. Try bringing it back to what your script is about.");
  if (status === "ungrounded") n.push("No script-based rewrite this time: the suggestion strayed from your script, so it was left out.");
  else if (status === "unavailable") n.push("The \u201Ccould have said\u201D comparison isn't available for this turn.");
  else if (status === "no_script") n.push("Add a script on the Script tab to see how your script would say it.");
  return n.join(" ");
}
/** The script text sent as context.script: stage directions stripped (the spoken text), NFC, trimmed. "" when empty or over SCRIPT_MAX (then it is not sent). */
export function scriptForTalk(text) {
  const s = stripDirections(String(text || "")).normalize("NFC").replace(/[ \t]+\n/g, "\n").trim();
  return s && cps(s).length <= SCRIPT_MAX ? s : "";
}
export const scriptTooLongForTalk = (text) => { const s = stripDirections(String(text || "")).normalize("NFC").trim(); return cps(s).length > SCRIPT_MAX; };
/** done.correction -> {kind, quote, betterZh, explainZh, pinyin} | null. A WORDING suggestion from the transcript text; never about sound. */
export function normalizeCorrection(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const betterZh = str(c.betterZh || c.better);
  if (!betterZh) return null;
  return { kind: str(c.kind), quote: str(c.quote), betterZh, explainZh: str(c.explainZh || c.explain), pinyin: str(c.pinyin) };
}
/** done.suggestedWords -> [{text, pinyin, meaning, reason}] (never saved automatically; the learner taps Save word). */
export function normalizeSuggested(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : []).map((w) => (typeof w === "string" ? { text: w.trim(), pinyin: "", meaning: "", reason: "" } : w && typeof w === "object" ? { text: str(w.text), pinyin: str(w.pinyin), meaning: str(w.meaning), reason: str(w.reason) } : null))
    .filter((w) => w && w.text && cps(w.text).length <= 16 && !seen.has(w.text) && seen.add(w.text)).slice(0, 4);
}
/** assessment-like event -> {transcript, noSpeech, acoustic}. noSpeech = the backend says nothing usable was heard. */
export function normalizeHeard(d) {
  const o = d && typeof d === "object" ? d : {};
  const status = str(o.sttStatus || o.status || o.stt && o.stt.status).toLowerCase();
  const noSpeech = o.noSpeech === true || o.gated === true || NO_SPEECH.has(status) || NO_SPEECH.has(str(o.code)) || (o.ok === false && !str(o.transcript || o.text));
  const transcript = noSpeech ? "" : str(o.transcript) || str(o.text) || str(o.heard);   // a gated transcript ("thanks for watching" hallucinations) is never shown as what the learner said
  return { transcript, noSpeech, sttStatus: status, acoustic: normalizeAcoustic(o.acoustic) };
}
/** Pronunciation/tone notes ONLY from an explicit acoustic object. -> {source, notes:[string]} | null. Anything else (including the transcript) is never evidence. */
export function normalizeAcoustic(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const src = str(a.source || a.kind).toLowerCase();
  if (!["acoustic", "audio", "toneperfect", "pronunciation"].includes(src)) return null;
  const raw = Array.isArray(a.notes) ? a.notes : Array.isArray(a.issues) ? a.issues : [];
  const notes = raw.map((n) => (typeof n === "string" ? n.trim() : n && typeof n === "object" ? str(n.note || n.text || n.message) : "")).filter(Boolean).slice(0, 4);
  return notes.length ? { source: src, notes } : null;
}

const ERROR_HINTS = {
  no_speech_detected: "I didn't hear any speech in that take. Say something out loud, close to the microphone.",
  no_speech: "I didn't hear any speech in that take. Say something out loud, close to the microphone.",
  gated: "I couldn't make out enough speech to reply to. Try again a little closer to the microphone.",
  stt_not_configured: "Speech recognition isn't set up on the server yet.",
  llm_not_configured: "The coach isn't set up on the server yet, so there's no reply.",
  talk_reply_failed: "The coach couldn't think of a reply just now. Try again, or skip that turn.",
  audio_too_long: "That turn was too long. Say a sentence or two, then tap Done.",
  talk_turn_too_long: "That turn was too long to coach. Say a few sentences at a time, then tap Done.",
  talk_llm_unavailable: "The coach couldn't reply just now. Try again, or skip that turn.",
  transcription_failed: "I couldn't write down what you said. Try again, or skip that turn.",
  upload_too_large: "That recording is too big. Say a sentence or two, then tap Done.",
  context_too_large: "The conversation got too long to send. Finish to get your summary.",
  script_too_long: "Your script is over 3,000 characters. Shorten it on the Script tab, then try again.",
  invalid_context: "The app sent something the coach couldn't read. Reload the page and try again.",
};
const RERECORD = new Set(["script_too_long", "invalid_context", "no_speech_detected", "no_speech", "gated", "audio_too_long", "talk_turn_too_long", "upload_too_large", "empty"]);
/** Terminal error -> {message, retryable, code, action:'reupload'|'rerecord', canSkip}. Message always starts with "No assessment obtained" (once), like the other modes. */
export function talkErrorOf(e) {
  const code = (e && e.code) || "", raw = ((e && e.message) || "").replace(/^no assessment obtained:?\s*/i, "");
  const body = ERROR_HINTS[code] || raw || "The coach couldn't work with that turn.";
  const retryable = !(e && e.retryable === false) && !RERECORD.has(code);
  return { message: `No assessment obtained: ${body}`, retryable, code, action: retryable ? "reupload" : "rerecord", canSkip: !(e && e.canSkip === false) };
}
export const noSpeechError = () => talkErrorOf({ code: "no_speech_detected" });

/* ---------------- script vocabulary (client-side, from Chris's own script) ---------------- */
const WORD = /^[\u3400-\u9fff\uf900-\ufaff]{2,4}$/;
const defaultSegmenter = () => { try { return typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("zh", { granularity: "word" }) : null; } catch { return null; } };
/** 2-4 hanzi words of the script (most frequent first, at most MAX_VOCAB) for the backend's vocab hints. `segmenter` is injectable (tests); no segmenter -> []. */
export function scriptVocabOf(scriptText, segmenter = defaultSegmenter()) {
  if (!segmenter) return [];
  const counts = new Map(); let order = 0;
  try { for (const seg of segmenter.segment(stripDirections(String(scriptText || "")))) { const w = seg.segment; if ((seg.isWordLike === undefined || seg.isWordLike) && WORD.test(w)) { const c = counts.get(w); if (c) c.n++; else counts.set(w, { n: 1, i: order++ }); } } } catch { return []; }
  return [...counts].sort((a, b) => b[1].n - a[1].n || a[1].i - b[1].i).slice(0, MAX_VOCAB).map(([text]) => ({ text }));
}

/* ---------------- opening ---------------- */
/** -> {textZh, pinyin, audioUrl} (textZh may be "" when the body is unusable). */
export function normalizeOpening(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { textZh: str(o.textZh || o.text), pinyin: str(o.pinyin), audioUrl: str(o.textAudio && o.textAudio.url || o.audioUrl), scriptUsed: o.scriptUsed === true };
}

/* ---------------- summary ---------------- */
const textOf = (x) => (typeof x === "string" ? x.trim() : x && typeof x === "object" ? str(x.textEn || x.text || x.en || x.note) : "");
const uniq = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
/** -> {status:'ok'|'empty', takeaways:[{en,zh,pinyin}], newWords:[{text,pinyin,meaning,example,savedMeaning}], phrases:[{zh,pinyin,en,why}], strengths:[string]}. Duplicates removed, lists capped. */
export function normalizeSummary(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw.summary && typeof raw.summary === "object" ? raw.summary : raw) : {};
  const takeaways = uniq((Array.isArray(o.takeaways) ? o.takeaways : []).map((t) => (typeof t === "string" ? { en: t.trim(), zh: "", pinyin: "" } : t && typeof t === "object" ? { en: textOf(t), zh: str(t.textZh || t.zh), pinyin: str(t.pinyin) } : null)).filter((t) => t && (t.en || t.zh)), (t) => t.en + "|" + t.zh).slice(0, 8);
  const newWords = uniq((Array.isArray(o.newWords) ? o.newWords : Array.isArray(o.words) ? o.words : []).map((w) => (typeof w === "string" ? { text: w.trim(), pinyin: "", meaning: "", example: "", savedMeaning: "" } : w && typeof w === "object" ? { text: str(w.text || w.textZh || w.word), pinyin: str(w.pinyin), meaning: str(w.meaning || w.meaningEn || w.en), example: str(w.exampleZh || w.example), savedMeaning: str(w.savedMeaning) } : null)).filter((w) => w && w.text), (w) => w.text).slice(0, 12);
  const phrases = uniq((Array.isArray(o.phrasesToTry) ? o.phrasesToTry : Array.isArray(o.phrases) ? o.phrases : []).map((p) => (typeof p === "string" ? { zh: p.trim(), pinyin: "", en: "", why: "" } : p && typeof p === "object" ? { zh: str(p.zh || p.textZh || p.text), pinyin: str(p.pinyin), en: str(p.en || p.meaningEn || p.meaning), why: str(p.whyEn || p.why) } : null)).filter((p) => p && p.zh), (p) => p.zh).slice(0, 8);
  const strengths = uniq((Array.isArray(o.strengths) ? o.strengths : []).map(textOf).filter(Boolean), (s) => s).slice(0, 3);
  return { status: takeaways.length || newWords.length || phrases.length ? "ok" : "empty", takeaways, newWords, phrases, strengths };
}

/* ---------------- network ---------------- */
const scr = (script) => (typeof script === "string" && script ? { script } : {});
const ctxOf = ({ topic, history, scriptVocab, script }) => ({ topic: cleanTopic(topic), turns: Array.isArray(history) ? history : [], ...(Array.isArray(scriptVocab) && scriptVocab.length ? { scriptVocab } : {}), ...scr(script) });
export const talk = {
  /** Same contract as api.attempt(): resolves {replayed}; rejects ApiError (isUnsupported for 404/501). Re-call with the SAME attemptId to retry the same take. */
  async turn({ blob, mime, topic, history, scriptVocab, script, attemptId, voice, speed, signal, onEvent }) {
    const fd = new FormData();
    fd.append("audio", blob, `take.${extFor(mime || blob.type || "")}`);
    fd.append("attemptId", attemptId);
    fd.append("context", JSON.stringify(ctxOf({ topic, history, scriptVocab, script })));
    if (voice) fd.append("voice", voice);
    if (speed) fd.append("speed", String(speed));
    const res = await req("POST", "/api/talk/turn", { body: fd, signal });
    let terminal = false;
    try { await readSse(res, (name, data) => { noteMock(data, name); if (name === "error" || name === "done") terminal = true; onEvent(name, data); }); }
    catch (e) { if (e && e.name === "AbortError") throw e; throw new ApiError("The connection dropped while waiting for the reply.", { network: true, retryable: true }); }
    if (!terminal) throw new ApiError("The connection dropped while waiting for the reply.", { network: true, retryable: true });
    return { replayed: res.headers.get("X-Attempt-Replayed") === "true" };
  },
  /** The coach's opening question (+ audio url). -> normalizeOpening(). Throws ApiError. */
  async opening({ topic, scriptVocab, script, voice, speed, signal }) {
    const q = new URLSearchParams({ audio: "1", ...(voice ? { voice } : {}), ...(speed ? { speed: String(speed) } : {}) });
    const body = await req("POST", `/api/talk/opening?${q}`, { json: { topic: cleanTopic(topic), ...(Array.isArray(scriptVocab) && scriptVocab.length ? { scriptVocab } : {}), ...scr(script) }, signal }).then(jsonOf);
    return normalizeOpening(body);
  },
  /** -> normalised summary. Throws ApiError. */
  async summary({ topic, turns, scriptVocab, script, signal }) {
    const body = await req("POST", "/api/talk/summary", { json: { topic: cleanTopic(topic), turns: summaryTurns(turns), ...(Array.isArray(scriptVocab) && scriptVocab.length ? { scriptVocab } : {}), ...scr(script) }, signal }).then(jsonOf);
    return normalizeSummary(body);
  },
};

/* ------------------------------------------------------------ per-turn upgrade ("What you said / Could have said") */
// done.upgrade: null | {said, better, betterPinyin?, changes:[{from,to,fromStart?,fromEnd?,toStart?,toEnd?,kind?,note?}], sourceLines:[{text,start?,end?}] (offsets into the SCRIPT) | [string]}, upgradeStatus, onTopic, saveable (backend 72c25bd)
// Offsets are code points into said / better, end exclusive. Bad or missing offsets -> substring search (left to right, after the previous change).
const isIdx = (n) => Number.isInteger(n) && n >= 0;
/** Find `needle` in `hay` (code points) at or after `from`; -1 if absent. */
export function cpIndexOf(hay, needle, from = 0) {
  const h = cps(hay), n = cps(needle); if (!n.length) return -1;
  for (let i = Math.max(0, from); i + n.length <= h.length; i++) { let ok = true; for (let k = 0; k < n.length; k++) if (h[i + k] !== n[k]) { ok = false; break; } if (ok) return i; }
  return -1;
}
/** Resolve one side of a change: valid given offsets win (and must match `frag` when frag is given), else search after `after`. -> [start,end] | null */
export function resolveSpan(text, frag, start, end, after = 0) {
  const t = cps(text), f = str(frag);
  if (isIdx(start) && isIdx(end) && start < end && end <= t.length && (!f || t.slice(start, end).join("") === f)) return [start, end];
  if (!f) return null;
  let i = cpIndexOf(text, f, after); if (i < 0) i = cpIndexOf(text, f, 0);
  return i < 0 ? null : [i, i + cps(f).length];
}
/** Spans -> render segments [{text, mark, i}] (sorted, overlaps dropped). `i` = change index for marked segments. */
export function segmentsOf(text, spans) {
  const t = cps(text), list = (spans || []).map((s, i) => s && { s: s[0], e: s[1], i }).filter(Boolean).sort((a, b) => a.s - b.s);
  const out = []; let pos = 0;
  for (const sp of list) {
    if (sp.s < pos || sp.e > t.length) continue;
    if (sp.s > pos) out.push({ text: t.slice(pos, sp.s).join(""), mark: false });
    out.push({ text: t.slice(sp.s, sp.e).join(""), mark: true, i: sp.i }); pos = sp.e;
  }
  if (pos < t.length) out.push({ text: t.slice(pos).join(""), mark: false });
  return out;
}
/** done.upgrade -> null | {said, better, betterPinyin, changes:[{from,to,kind,note,fromSpan,toSpan}], saidSegs, betterSegs, sourceLines:[{text,start,end}]}. Never throws. */
export function normalizeUpgrade(u) {
  if (!u || typeof u !== "object") return null;
  const said = str(u.said), better = str(u.better);
  if (!said || !better || said === better) return null;
  const changes = []; let fa = 0, ta = 0;
  for (const c of Array.isArray(u.changes) ? u.changes.slice(0, 8) : []) {
    if (!c || typeof c !== "object") continue;
    const from = str(c.from), to = str(c.to); if (!from && !to) continue;
    const fromSpan = resolveSpan(said, from, c.fromStart, c.fromEnd, fa), toSpan = resolveSpan(better, to, c.toStart, c.toEnd, ta);
    if (fromSpan) fa = fromSpan[1]; if (toSpan) ta = toSpan[1];
    changes.push({ from: fromSpan ? cps(said).slice(...fromSpan).join("") : from, to: toSpan ? cps(better).slice(...toSpan).join("") : to, kind: str(c.kind), note: str(c.note), fromSpan, toSpan });
  }
  const sourceLines = (Array.isArray(u.sourceLines) ? u.sourceLines : []).map((l) => (typeof l === "string" ? { text: l.trim(), start: null, end: null } : l && typeof l === "object" ? { text: str(l.text), start: Number.isInteger(l.start) ? l.start : null, end: Number.isInteger(l.end) ? l.end : null } : null)).filter((l) => l && l.text).slice(0, 4);
  return { said, better, betterPinyin: str(u.betterPinyin), changes, sourceLines,
    saidSegs: segmentsOf(said, changes.map((c) => c.fromSpan)), betterSegs: segmentsOf(better, changes.map((c) => c.toSpan)) };
}
/** What "Save phrase" saves: done.saveable when the backend sent it (posted as-is to /api/words); else each changed 'to' phrase, or the whole better sentence. */
export function phrasesToSave(up, saveable) {
  if (Array.isArray(saveable) && saveable.length) return saveable;
  if (!up) return [];
  const seen = new Set(), out = [];
  for (const c of up.changes) { const t = c.to.trim(); if (cps(t).length >= 1 && /[\u3400-\u9fff]/.test(t) && !seen.has(t)) { seen.add(t); out.push({ text: t, pinyin: "", meaning: "", sourceChunk: up.better }); } }
  return out.length ? out : [{ text: up.better, pinyin: up.betterPinyin, meaning: "", sourceChunk: up.better }];
}
