// FREE TALK: the learner talks freely about a topic, one spoken turn at a time; the coach is a conversation partner.
//
//   POST /api/talk/turn     : STT -> [reply stream (LLM #1) ‖ correction finder (LLM #2) ‖ optional tone check] -> CODE validates everything -> TTS per sentence
//   POST /api/talk/opening  : LLM -> the coach's opening question (CODE validates; pinyin by code)
//   POST /api/talk/summary  : LLM -> takeaways / new words / phrases to try / strengths (CODE validates; stats by code)
//
// STATELESS: nothing is stored. The client sends the last few turns' TEXT with every call; audio/transcripts live only in the request (and the 10-min replay record).
// GROUNDING (what the LLM may and may not do):
//   * A correction must QUOTE the transcript (CODE verifies the quote is in it), is only about word choice / grammar / naturalness (never sound), must be high-confidence,
//     must actually change the wording (a quote that is only a homophone of the "better" text is an STT matter and is dropped) and is at most ONE per turn.
//   * No tone / pronunciation statement ever comes from the transcript or from LLM text: such sentences are dropped / the explanation is replaced by a fixed line.
//   * Script vocabulary hints can only be words the client sent in `scriptVocab` (exact match, checked by code).
//   * The LLM never supplies pinyin: CODE computes it.
import { pinyin as pinyinPro } from 'pinyin-pro';
import { ServiceError } from './openai.js';
import { toSimplified, TONE_CLAIM, PRAISE_RE, hz, hanziOnly } from './retell.js';
import { splitSentences, JsonUnitScanner } from './coach.js';

// ---------------------------------------------------------------------------------------------------------------- limits
export const TALK_MAX_TURNS = 8;              // last N turns are used (older ones are dropped silently)
export const TALK_MAX_TURN_CHARS = 300;       // per turn (code points)
export const TALK_MAX_CONTEXT_CHARS = 2400;   // all turns together (oldest dropped first)
export const TALK_MAX_VOCAB = 40;             // script vocabulary entries used
export const TALK_MAX_VOCAB_SENT = 200;       // more than this => 400
export const TALK_MAX_TOPIC = 120;
export const TALK_MAX_SCRIPT_CHARS = 3000;   // optional `script` text (code points; same limit as the app's script box) => 413 script_too_long
export const TALK_SUMMARY_MAX_TURNS_SENT = 200;
export const TALK_SUMMARY_MAX_CHARS_SENT = 20000;
export const TALK_SUMMARY_PROMPT_TURNS = 40;  // the last N turns / chars go to the LLM
export const TALK_SUMMARY_PROMPT_CHARS = 6000;
export const CORRECTION_KINDS = ['word_choice', 'grammar', 'unnatural', 'english_gap'];

// ---------------------------------------------------------------------------------------------------------------- fixed spoken lines (pre-warmed TTS)
export const TALK_GATE_ZH = '我没有听清楚，请再说一遍。';
export const TALK_FALLBACK_ZH = '请继续说，我在听。';
export const TALK_THEN_ZH = '然后呢？';
export const TALK_NATURAL_ZH = ['说得很自然。', '这样说很自然。', '你的说法很自然。'];
export const TALK_GENERIC_EXPLAIN_ZH = { word_choice: '这里换个词更自然。', grammar: '这里的说法可以这样改。', unnatural: '这样说更自然。', english_gap: '这个意思可以用中文这样说。' };
export const TALK_MODEL_PREFIX_ZH = '可以这样说：';
export const TALK_PHRASES_ZH = [TALK_GATE_ZH, TALK_FALLBACK_ZH, TALK_THEN_ZH, ...TALK_NATURAL_ZH, ...Object.values(TALK_GENERIC_EXPLAIN_ZH)];

// ---------------------------------------------------------------------------------------------------------------- helpers
const LATIN = /[A-Za-z]/;
const cpLen = (s) => Array.from(String(s ?? '')).length;
const cpSlice = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');
export const pinyinOf = (t) => { try { return pinyinPro(String(t), { toneType: 'symbol', type: 'array' }).join(' ').replace(/\s+([，。？！、；：,.?!])/g, '$1'); } catch { return ''; } };
const tonelessOf = (t) => { try { return pinyinPro(String(t), { toneType: 'none', type: 'array' }).join(' '); } catch { return ''; } };
const simp = (s) => toSimplified(String(s ?? '').normalize('NFKC'));
const EN_SOUND = /\b(?:tones?|toneless|pitch|pronunc\w*|mispronounc\w*|intonation|accent|enunciat\w*|articulat\w*)\b/i;
/** praise / evaluation of the learner's LANGUAGE (not of the content: "听起来很不错" about a weekend is fine) */
const LANG_PRAISE = /(?:中文|汉语|普通话|语法|表达|句子|口语|词汇|用词|造句)[^，。！？]{0,6}(?:很|真|太|非常|好|棒|流利|标准|地道|不错|进步)|(?:说|讲|写|用)得(?:很|真|太|非常|好|棒|不错|对)|流利|标准|地道|进步|做得好|全对|都对|完美|正确|没问题|\b(?:perfect|well done|excellent|correct|fluent)\b/i;
const soundy = (s) => TONE_CLAIM.test(String(s)) || EN_SOUND.test(String(s));

const LEVELS = ['easy', 'normal'];

// ---------------------------------------------------------------------------------------------------------------- request context validation
/** Parse + validate the client's `context` (turn endpoint) -> { ctx } | { error: {code,message,status} }. Turns are capped here (stateless server). */
export function parseTalkContext(raw) {
  let c = raw;
  if (typeof raw === 'string') { try { c = JSON.parse(raw); } catch { return { error: { status: 400, code: 'invalid_context', message: 'context must be a JSON object string.' } }; } }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: { status: 400, code: 'invalid_context', message: 'context must be a JSON object: {topic, scriptVocab?, turns?, level?, tone?}.' } };
  const e = (message, status = 400, code = 'invalid_context') => ({ error: { status, code, message } });
  if (c.topic != null && typeof c.topic !== 'string') return e('topic must be a string.');
  const topic = String(c.topic ?? '').trim();
  if (cpLen(topic) > TALK_MAX_TOPIC) return e(`topic is over ${TALK_MAX_TOPIC} characters.`, 413, 'context_too_large');
  if (c.level != null && !LEVELS.includes(c.level)) return e('level must be "easy" or "normal".', 400, 'invalid_level');
  if (c.tone != null && typeof c.tone !== 'boolean') return e('tone must be a boolean.');
  if (c.turns != null && (!Array.isArray(c.turns) || c.turns.length > 100)) return e('turns must be an array (at most 100 entries; only the last 8 are used).', c.turns?.length > 100 ? 413 : 400, c.turns?.length > 100 ? 'context_too_large' : 'invalid_context');
  const turns = [];
  for (const t of c.turns || []) {
    if (!t || typeof t !== 'object' || !['coach', 'user'].includes(t.role) || typeof t.text !== 'string') return e('every turn must be {role:"coach"|"user", text:string}.');
    const text = cpSlice(t.text.trim(), TALK_MAX_TURN_CHARS); if (text) turns.push({ role: t.role, text });
  }
  let used = turns.slice(-TALK_MAX_TURNS); let chars = used.reduce((n, t) => n + cpLen(t.text), 0);
  while (used.length > 1 && chars > TALK_MAX_CONTEXT_CHARS) { chars -= cpLen(used[0].text); used = used.slice(1); }
  const vocab = parseScriptVocab(c.scriptVocab); if (vocab.error) return { error: vocab.error };
  const sc = parseScript(c.script); if (sc.error) return { error: sc.error };
  return { ctx: { topic, level: c.level || 'normal', tone: c.tone === true, turns: used, turnsSent: turns.length, turnsUsed: used.length, scriptVocab: vocab.list, script: sc.script } };
}

/** optional script text -> { script } | { error }. Not stored anywhere; only sent to the LLM for this request. */
export function parseScript(v) {
  if (v == null || v === '') return { script: '' };
  if (typeof v !== 'string') return { error: { status: 400, code: 'invalid_context', message: 'script must be a string.' } };
  const script = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const n = cpLen(script);
  if (n > TALK_MAX_SCRIPT_CHARS) return { error: { status: 413, code: 'script_too_long', message: `The script is over ${TALK_MAX_SCRIPT_CHARS} characters (${n}).` } };
  return { script };
}

/** scriptVocab: [{text, pinyin?}] (or plain strings) -> unique entries of 1-12 hanzi, at most TALK_MAX_VOCAB; > TALK_MAX_VOCAB_SENT entries => error. Pinyin is always computed by code. */
export function parseScriptVocab(v) {
  if (v == null) return { list: [] };
  if (!Array.isArray(v)) return { error: { status: 400, code: 'invalid_context', message: 'scriptVocab must be an array of {text, pinyin?}.' } };
  if (v.length > TALK_MAX_VOCAB_SENT) return { error: { status: 413, code: 'context_too_large', message: `scriptVocab has more than ${TALK_MAX_VOCAB_SENT} entries.` } };
  const seen = new Set(); const list = [];
  for (const x of v) {
    const text = typeof x === 'string' ? x.trim() : typeof x?.text === 'string' ? x.text.trim() : '';
    if (!text || seen.has(text) || !/^[\u3400-\u9fff\uf900-\ufaff]{1,12}$/.test(text)) continue;
    seen.add(text); list.push({ text, pinyin: pinyinOf(text) });
    if (list.length >= TALK_MAX_VOCAB) break;
  }
  return { list };
}

// ---------------------------------------------------------------------------------------------------------------- gates (no LLM)
const HALLUCINATION = /谢谢(大家|你们)?(的)?(观看|收看|收听|观赏)|感谢(您|你|大家)?(的)?(观看|收看|收听|关注)|请?(不吝)?(点赞|订阅|转发|打赏)|订阅(我的|本)?频道|(中文|英文)?字幕(由|志愿者|制作|提供)?|amara\.?org|subtitles?\s+by|thank(s| you)\s+(so much\s+)?for\s+(watching|listening)|please\s+subscribe|明镜|点点栏目|下期再见|我们下期|see you (next|in the next)/gi;
/** -> null | 'empty' | 'too_short' | 'hallucination'. `text` is the transcript (simplified). English words count as speech (the English-gap case). */
export function talkGate(text) {
  const t = String(text ?? '').trim(); const hzN = hz(t).length; const words = (t.match(/[A-Za-z]{2,}/g) || []).length;
  if (!t || (!hzN && !words)) return 'empty';
  const rest = t.replace(HALLUCINATION, '').replace(/[\s\p{P}]/gu, '');
  if (rest !== t.replace(/[\s\p{P}]/gu, '') && cpLen(rest) <= 2) return 'hallucination';
  if (hzN + words < 2 || (hzN === 1 && !words && cpLen(t.replace(/[\s\p{P}]/gu, '')) <= 1)) return 'too_short';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------- prompts
const turnsJson = (ctx) => ctx.turns.map((t) => ({ role: t.role, text: t.text }));
const topicOf = (ctx) => ctx.topic || 'free conversation about everyday life';
const levelNote = (level) => (level === 'easy' ? 'Level: EASY (HSK 2-3): very common words, very short sentences (under 12 characters each).' : 'Level: NORMAL (HSK 3-4): common words, short sentences (under 20 characters each).');

export function buildReplyMessages({ ctx, transcript }) {
  const system = `TALK_REPLY. You are a friendly Mandarin conversation partner for an adult learner. Keep the conversation going. Reply as JSON only, keys in this order:
{"replyZh": string, "questionZh": string}
replyZh: ONE short, warm, natural reaction or comment about the CONTENT of what the learner just said (a few characters up to ~20; may be empty only if they said almost nothing). questionZh: ONE natural follow-up question about the topic that invites them to say more.
RULES: simplified Chinese only, no pinyin, no English, no markdown, no emojis. ${levelNote(ctx.level)} Total 1-3 short sentences. Do NOT correct or evaluate the learner's language, do NOT praise their Chinese, and NEVER mention pronunciation, tones, pitch or how anything sounded (you only have a text transcript, which may contain speech-to-text mistakes). If the learner mixed in English or said they do not know how to say something, just answer the meaning naturally. If the transcript looks garbled, ask them kindly to say it another way. Do not repeat their sentence word for word.`;
  if (ctx.script) {
    const sys2 = `${system}
SCRIPT MODE: the learner is practising to talk about their own SCRIPT (given in the user message). Your questionZh must be about the script's topics, its argument / reasoning (why, how, what follows) and its conclusions, so the learner practises expressing those ideas in their own words. If what the learner just said is NOT related to the script's topics, keep replyZh a brief friendly reaction and make questionZh gently steer back to a point of the script. Add a third key "onTopic": true if what the learner just said is related to the script's topics, false if it drifted off-topic. Key order: replyZh, questionZh, onTopic. Never quote long parts of the script.`;
    const user = JSON.stringify({ topic: topicOf(ctx), script: ctx.script, conversationSoFar: turnsJson(ctx), learnerJustSaid: transcript });
    return [{ role: 'system', content: sys2 }, { role: 'user', content: user }];
  }
  const user = JSON.stringify({ topic: topicOf(ctx), conversationSoFar: turnsJson(ctx), learnerJustSaid: transcript });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function buildFindMessages({ ctx, transcript }) {
  const system = `TALK_FIND. You check ONE utterance of a Mandarin learner. The text comes from speech-to-text (STT): it may contain recognition mistakes, may have "autocorrected" the learner, and may even be traditional characters. You only see TEXT: you know NOTHING about pronunciation or tones. Output JSON only:
{"correction": null | {"kind": "word_choice"|"grammar"|"unnatural"|"english_gap", "quote": string, "betterZh": string, "explainZh": string, "confidence": "high"|"medium"|"low"}, "vocabHints": [string], "natural": boolean}
RULES:
- At most ONE correction, ONLY for a CLEAR error (wrong word, ungrammatical pattern, or a phrase a native speaker would not say) and ONLY when you are highly confident. If the sentence is understandable and acceptable, correction MUST be null. Do NOT invent a correction, do NOT fix style preferences, do NOT touch things that could just be a speech-recognition slip (homophones, odd characters in an otherwise fine sentence). Never say anything about pronunciation, tones or sound.
- "quote" must be copied EXACTLY (character for character) from learnerText: the smallest wrong part (2-12 characters). "betterZh": the corrected / more natural Chinese for that part only (simplified, at most 20 characters, no pinyin, no English). "explainZh": one very short Mandarin explanation (at most 20 characters, simplified Chinese).
- english_gap: ONLY when learnerText contains English words/phrases because the learner did not know the Mandarin: "quote" = the English words copied exactly, "betterZh" = the natural Mandarin word/phrase for them (this is not an error). kind english_gap needs no confidence below high.
- vocabHints: up to 2 entries copied EXACTLY from scriptVocab that the learner could naturally have used for what they were trying to say but did NOT use. Empty array if none fit or scriptVocab is empty.
- natural: true only if learnerText is clearly natural, correct Mandarin (and correction is null).
${levelNote(ctx.level)}`;
  const user = JSON.stringify({ topic: topicOf(ctx), conversationSoFar: turnsJson(ctx), learnerText: transcript, scriptVocab: ctx.scriptVocab.map((v) => v.text) });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---------------------------------------------------------------------------------------------------------------- reply: sentence sanitising (streamed units)
/** One streamed LLM string -> the sentences that may be spoken (tone/sound claims, praise of the learner's Chinese, Latin text, over-long sentences are dropped). */
export function cleanReplySentences(text, { allowPraise = false } = {}) {
  const out = [];
  for (const s0 of splitSentences(String(text ?? ''))) {
    const s = s0.trim();
    if (hz(s).length < 2 || hz(s).length > 40 || LATIN.test(s) || /[#*_`<>{}[\]]/.test(s)) continue;
    if (soundy(s)) continue;
    if (!allowPraise && LANG_PRAISE.test(s)) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- finder: validation
export class TalkSchemaError extends ServiceError { constructor(m) { super('talk_schema', m, { retryable: true }); } }
/** Parsed LLM finder output -> { correction|null, vocabHints:[texts], natural, dropped:[reason] } (throws TalkSchemaError for a malformed shape) */
export function validateFind(parsed, { transcript, ctx }) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TalkSchemaError('not an object');
  if (!('correction' in parsed)) throw new TalkSchemaError('missing correction');
  if (parsed.correction !== null && (typeof parsed.correction !== 'object' || Array.isArray(parsed.correction))) throw new TalkSchemaError('bad correction');
  if (parsed.vocabHints != null && !Array.isArray(parsed.vocabHints)) throw new TalkSchemaError('bad vocabHints');
  const dropped = []; const tSimp = simp(transcript); const tHz = hanziOnly(tSimp);
  let correction = null;
  const c = parsed.correction;
  if (c) {
    const kind = c.kind;
    const quote = typeof c.quote === 'string' ? c.quote.normalize('NFKC').trim() : ''; const better = typeof c.betterZh === 'string' ? c.betterZh.normalize('NFKC').trim() : '';
    const why = (() => {
      if (!CORRECTION_KINDS.includes(kind)) return 'bad_kind';
      if (c.confidence !== 'high') return 'not_high_confidence';
      if (!quote || !better) return 'missing_fields';
      if (hz(better).length < 1 || cpLen(better) > 24 || LATIN.test(better) || soundy(better)) return 'bad_better';
      if (kind === 'english_gap') {
        if (!LATIN.test(quote) || cpLen(quote) > 80) return 'bad_english_quote';
        const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
        if (!norm(transcript).includes(norm(quote))) return 'quote_not_in_transcript';
        return null;
      }
      const qh = hanziOnly(simp(quote));
      if (qh.length < 2 || qh.length > 30) return 'bad_quote';
      if (!tHz.includes(qh)) return 'quote_not_in_transcript';           // hallucinated quote
      const bh = hanziOnly(simp(better));
      if (!bh || bh === qh) return 'no_change';
      if (tonelessOf(qh) === tonelessOf(bh)) return 'homophone_only';     // same sounds: an STT / pronunciation matter, never a text error
      if (bh.includes(qh) && bh.length > qh.length + 8) return 'rewrite';
      return null;
    })();
    if (why) dropped.push(`correction_${why}`);
    else {
      let explain = typeof c.explainZh === 'string' ? c.explainZh.trim() : ''; let rewritten = false;
      if (!explain || cpLen(explain) > 40 || hz(explain).length < 2 || LATIN.test(explain) || soundy(explain) || PRAISE_RE.test(explain)) { explain = TALK_GENERIC_EXPLAIN_ZH[kind]; rewritten = true; dropped.push('explain_rewritten'); }
      correction = { kind, quote: kind === 'english_gap' ? quote : (quoteInOriginal(transcript, qhOf(quote)) || quote), /* the transcript's own spelling of the verified quote */ betterZh: better, explainZh: explain, pinyin: pinyinOf(better), source: rewritten ? 'server' : 'llm' };
    }
  }
  // vocab hints: only entries of the client's scriptVocab, and only words the learner did not already say
  const allowed = new Map(ctx.scriptVocab.map((v) => [v.text, v])); const vocabHints = [];
  for (const x of Array.isArray(parsed.vocabHints) ? parsed.vocabHints : []) {
    const t = typeof x === 'string' ? x.trim() : typeof x?.text === 'string' ? x.text.trim() : '';
    const v = allowed.get(t);
    if (!v) { if (t) dropped.push('vocab_not_in_scriptVocab'); continue; }
    if (tHz.includes(hanziOnly(v.text))) { dropped.push('vocab_already_used'); continue; }
    if (!vocabHints.some((h) => h.text === v.text) && vocabHints.length < 2) vocabHints.push({ text: v.text, pinyin: v.pinyin });
  }
  return { correction, vocabHints, natural: parsed.natural === true && !correction, dropped };
}
const qhOf = (q) => hanziOnly(simp(q));
/** the transcript's own spelling of a verified quote (trad/simp tolerant): the first hanzi window of the ORIGINAL text whose simplified form equals qh */
function quoteInOriginal(transcript, qh) {
  const chars = hz(transcript);
  for (let i = 0; i + qh.length <= chars.length; i++) { const w = chars.slice(i, i + qh.length).join(''); if (hanziOnly(simp(w)) === qh) return w; }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------- LLM wrappers
function abortable(signal, maxMs) {
  const ac = new AbortController(); const onAbort = () => ac.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), maxMs); timer.unref?.();
  return { ac, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}
const failReason = (e) => (e.code === 'talk_schema' || e.code === 'llm_bad_json' ? 'malformed_output' : e.code || 'llm_failed');

/** The correction finder (non-streaming JSON, temp 0, one retry). -> {status:'ok', correction, vocabHints, natural, dropped, attempts} | {status:'unavailable', reason, attempts} */
export async function findCorrection({ llm, ctx, transcript, signal, model, timings = {}, maxMs = 8000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', attempts: 0 };
  const { ac, done } = abortable(signal, maxMs); let reason = 'find_failed'; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try {
        const raw = await llm.chatJson({ messages: buildFindMessages({ ctx, transcript }), signal: ac.signal, model, maxTokens: 260, temperature: 0, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        return { status: 'ok', attempts: n, ...validateFind(raw, { transcript, ctx }) };
      } catch (e) { reason = failReason(e); if (ac.signal.aborted || (e.retryable === false && e.code !== 'talk_schema')) break; }
    }
    return { status: 'unavailable', reason, attempts: n };
  } finally { done(); timings.correctionMs = Date.now() - t0; }
}

/**
 * The conversational reply: streams {"replyZh","questionZh"}. `onReply(sentences)` is called as soon as replyZh is complete (speak at once); questionZh is returned
 * (held by the caller until a correction decision). One retry (non-streaming) when the stream failed/was malformed before anything was spoken.
 * -> { status:'ok'|'malformed'|'unavailable', replySentences, questionSentences, reason?, attempts }
 */
export async function streamReply({ llm, ctx, transcript, signal, model, timings = {}, onReply = () => {}, maxMs = 12000 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', replySentences: [], questionSentences: [], attempts: 0 };
  const { ac, done } = abortable(signal, maxMs);
  const out = { status: 'unavailable', reason: 'reply_failed', replySentences: [], questionSentences: [], attempts: 0, onTopic: null }; let full = '';
  const take = (key, value) => {
    if (key === 'replyZh' && !out.replySpoken) { out.replySpoken = true; const s = cleanReplySentences(value).slice(0, 2); out.replySentences = s; if (s.length) onReply(s); }
    else if (key === 'questionZh' && !out.questionSeen) { out.questionSeen = true; out.questionSentences = cleanReplySentences(value, { allowPraise: true }).slice(0, 1); }
  };
  try {
    const messages = buildReplyMessages({ ctx, transcript });
    out.attempts = 1; let err = null;
    try {
      const scanner = new JsonUnitScanner();
      for await (const delta of llm.chatStream({ messages, signal: ac.signal, model, maxTokens: 160, temperature: 0.6, timeoutMs: maxMs })) {
        if (timings.replyFirstTokenMs === undefined) timings.replyFirstTokenMs = Date.now() - t0;
        full += delta;
        for (const ev of scanner.push(delta)) if (ev.type === 'string') take(ev.key, ev.value);
      }
    } catch (e) { err = e; }
    try { const j = JSON.parse(full); if (typeof j?.onTopic === 'boolean') out.onTopic = j.onTopic; } catch { /* partial / malformed: onTopic unknown */ }
    if (!err && (out.replySpoken || out.questionSeen)) { out.status = 'ok'; delete out.reason; }
    else if (!out.replySentences.length && !ac.signal.aborted) {
      // nothing usable was spoken: one non-streaming retry
      out.attempts = 2; out.reason = err ? failReason(err) : 'malformed_output';
      try {
        const raw = await llm.chatJson({ messages, signal: ac.signal, model, maxTokens: 160, temperature: 0.4, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        if (raw && typeof raw === 'object') { take('replyZh', raw.replyZh); take('questionZh', raw.questionZh); if (typeof raw.onTopic === 'boolean') out.onTopic = raw.onTopic; }
        if (out.replySpoken || out.questionSeen) { out.status = 'ok'; delete out.reason; } else { out.status = 'malformed'; out.reason = 'malformed_output'; }
      } catch (e) { out.reason = failReason(e); out.status = e.code === 'llm_bad_json' ? 'malformed' : 'unavailable'; }
    } else if (err) { out.status = out.replySentences.length ? 'ok' : 'unavailable'; out.reason = failReason(err); }
    if (out.status === 'ok' && !out.replySentences.length && !out.questionSentences.length) { out.status = 'malformed'; out.reason = 'nothing_speakable'; }
    return out;
  } finally { done(); timings.replyMs = Date.now() - t0; }
}

// ---------------------------------------------------------------------------------------------------------------- opening
export function buildOpeningMessages({ topic, scriptVocab, level, script = '' }) {
  const system = `TALK_OPEN. You are a friendly Mandarin conversation partner. Start a free conversation with an adult learner about the topic. Reply as JSON only: {"textZh": string}.
textZh: ONE short, friendly, open question (or a one-sentence greeting plus one question) that invites the learner to talk about the topic from their own experience; at most 30 characters; simplified Chinese only, no pinyin, no English, no markdown. ${levelNote(level)} Never mention pronunciation or tones. You may use (not required) ideas from scriptVocab.`;
  if (script) return [{ role: 'system', content: `${system}
SCRIPT MODE: the learner has a SCRIPT (in the user message) they are practising to talk about. Ask about its main topic or its central argument / conclusion, in a way that invites them to explain it in their own words. Do not quote the script.` },
    { role: 'user', content: JSON.stringify({ topic, script, scriptVocab: scriptVocab.map((v) => v.text) }) }];
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ topic, scriptVocab: scriptVocab.map((v) => v.text) }) }];
}
export function validateOpening(parsed) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.textZh !== 'string') throw new TalkSchemaError('textZh missing');
  const sentences = cleanReplySentences(parsed.textZh, { allowPraise: true }).slice(0, 2); const text = sentences.join('');
  if (hz(text).length < 4 || cpLen(text) > 60) throw new TalkSchemaError('textZh unusable');
  return { textZh: text, pinyin: pinyinOf(text) };
}
/** -> {status:'ok', textZh, pinyin, attempts} | {status:'unavailable', reason, attempts} */
export async function generateOpening({ llm, topic, scriptVocab, level, script = '', signal, model, timings = {}, maxMs = 8000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', attempts: 0 };
  const { ac, done } = abortable(signal, maxMs); let reason = 'opening_failed'; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try { const raw = await llm.chatJson({ messages: buildOpeningMessages({ topic, scriptVocab, level, script }), signal: ac.signal, model, maxTokens: 120, temperature: 0.8, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) }); return { status: 'ok', attempts: n, ...validateOpening(raw) }; }
      catch (e) { reason = failReason(e); if (ac.signal.aborted || (e.retryable === false && e.code !== 'talk_schema')) break; }
    }
    return { status: 'unavailable', reason, attempts: n };
  } finally { done(); timings.openingMs = Date.now() - t0; }
}

// ---------------------------------------------------------------------------------------------------------------- summary
/** Validate the client's summary request body -> { value } | { error } */
export function parseSummaryRequest(b) {
  const e = (message, status = 400, code = 'invalid_request') => ({ error: { status, code, message } });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return e('Body must be a JSON object.');
  if (b.topic != null && typeof b.topic !== 'string') return e('topic must be a string.');
  const topic = String(b.topic ?? '').trim(); if (cpLen(topic) > TALK_MAX_TOPIC) return e(`topic is over ${TALK_MAX_TOPIC} characters.`, 413, 'context_too_large');
  if (b.level != null && !LEVELS.includes(b.level)) return e('level must be "easy" or "normal".', 400, 'invalid_level');
  if (!Array.isArray(b.turns) || !b.turns.length) return e('turns must be a non-empty array of {role, text}.', 400, 'invalid_turns');
  if (b.turns.length > TALK_SUMMARY_MAX_TURNS_SENT) return e(`turns has more than ${TALK_SUMMARY_MAX_TURNS_SENT} entries.`, 413, 'session_too_long');
  const turns = [];
  for (const t of b.turns) {
    if (!t || typeof t !== 'object' || !['coach', 'user'].includes(t.role) || typeof t.text !== 'string') return e('every turn must be {role:"coach"|"user", text:string}.', 400, 'invalid_turns');
    const text = t.text.trim(); if (text) turns.push({ role: t.role, text: cpSlice(text, 2000) });
  }
  if (turns.reduce((n, t) => n + cpLen(t.text), 0) > TALK_SUMMARY_MAX_CHARS_SENT) return e(`The session text is over ${TALK_SUMMARY_MAX_CHARS_SENT} characters.`, 413, 'session_too_long');
  if (!turns.some((t) => t.role === 'user')) return e('There is no learner turn to summarise.', 400, 'no_user_turns');
  const vocab = parseScriptVocab(b.scriptVocab); if (vocab.error) return { error: vocab.error };
  const sc = parseScript(b.script); if (sc.error) return { error: sc.error };
  return { value: { topic, level: b.level || 'normal', turns, scriptVocab: vocab.list, script: sc.script } };
}
/** stats derived by CODE */
export function talkStats(turns) {
  const user = turns.filter((t) => t.role === 'user');
  return { turns: turns.length, userTurns: user.length, approxCharsSpoken: user.reduce((n, t) => n + hz(t.text).length, 0) };
}
export function buildSummaryMessages({ topic, level, turns, scriptVocab, script = '' }) {
  let used = turns.slice(-TALK_SUMMARY_PROMPT_TURNS); let chars = used.reduce((n, t) => n + cpLen(t.text), 0);
  while (used.length > 1 && chars > TALK_SUMMARY_PROMPT_CHARS) { chars -= cpLen(used[0].text); used = used.slice(1); }
  const system = `TALK_SUMMARY. You review a finished free-talk Mandarin conversation for an English-speaking adult learner. Output JSON only:
{"takeaways":[{"textEn":string,"textZh":string}], "newWords":[{"text":string,"meaning":string,"exampleZh":string}], "phrasesToTry":[{"zh":string,"en":string,"whyEn":string}], "strengths":[string]}
- takeaways: 3-5 short, specific, encouraging observations about WHAT the learner said and how they expressed it (vocabulary, sentence patterns, content, fluency of ideas). textEn: English label (<= 90 chars). textZh: a short Mandarin example from or related to the conversation (<= 30 characters).
- newWords: 0-8 useful Chinese words (1-6 characters) that came up in the conversation or that the learner clearly needed. text = Chinese; meaning = short English gloss; exampleZh = a short natural Chinese sentence that CONTAINS the word. ${levelNote(level)}
- phrasesToTry: 3-5 natural Chinese phrases/sentences relevant to what the learner was trying to say. zh = Chinese; en = English meaning; whyEn = why it is useful (<= 100 chars).
- strengths: 1-2 genuine strengths (English, <= 100 chars).
You only have TEXT (speech-to-text): NEVER say anything about pronunciation, tones, pitch, accent or how it sounded. Do not invent things the learner did not say. Simplified Chinese; no pinyin.`;
  const user = JSON.stringify({ topic: topic || 'free conversation', ...(script ? { script } : {}), conversation: used, scriptVocab: scriptVocab.map((v) => v.text) });
  const sys = script ? `${system}\nThe learner was practising to talk about their SCRIPT (in the user message): judge how well they conveyed its topics, reasoning and conclusions; phrasesToTry should preferably be natural phrasings taken from or close to the script.` : system;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}
const str = (x, max) => { const s = typeof x === 'string' ? x.trim() : ''; return s && cpLen(s) <= max ? s : ''; };
const zhOnly = (s, min, max) => { const t = String(s ?? '').trim(); return t && hz(t).length >= min && cpLen(t) <= max && !LATIN.test(t) && !soundy(t) ? t : ''; };
const enOk = (s, max) => { const t = str(s, max); return t && !soundy(t) ? t : ''; };
/** -> { takeaways, newWords, phrasesToTry, strengths, dropped } or throws TalkSchemaError */
export function validateSummary(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TalkSchemaError('not an object');
  for (const k of ['takeaways', 'phrasesToTry', 'strengths']) if (!Array.isArray(parsed[k])) throw new TalkSchemaError(`${k} must be an array`);
  if (parsed.newWords != null && !Array.isArray(parsed.newWords)) throw new TalkSchemaError('newWords must be an array');
  const dropped = [];
  const takeaways = []; for (const t of parsed.takeaways) { const en = enOk(t?.textEn, 140); const zh = zhOnly(t?.textZh, 2, 60); if (en && zh) takeaways.push({ textEn: en, textZh: zh, pinyin: pinyinOf(zh) }); else dropped.push('takeaway'); }
  const newWords = []; const seen = new Set();
  for (const w of parsed.newWords || []) {
    const text = String(w?.text ?? '').trim(); const meaning = enOk(w?.meaning, 80); const ex = zhOnly(w?.exampleZh, 3, 60);
    if (!/^[\u3400-\u9fff\uf900-\ufaff]{1,8}$/.test(text) || !meaning || !ex || !ex.includes(text) || seen.has(text)) { dropped.push('newWord'); continue; }
    seen.add(text); newWords.push({ text, pinyin: pinyinOf(text), meaning, exampleZh: ex });
  }
  const phrasesToTry = []; for (const p of parsed.phrasesToTry) { const zh = zhOnly(p?.zh, 2, 60); const en = enOk(p?.en, 140); const why = enOk(p?.whyEn, 200); if (zh && en && why) phrasesToTry.push({ zh, pinyin: pinyinOf(zh), en, whyEn: why }); else dropped.push('phrase'); }
  const strengths = []; for (const s of parsed.strengths) { const t = enOk(s, 200); if (t) strengths.push(t); else dropped.push('strength'); }
  if (takeaways.length < 2 || !phrasesToTry.length || !strengths.length) throw new TalkSchemaError('too little usable content');
  return { takeaways: takeaways.slice(0, 5), newWords: newWords.slice(0, 8), phrasesToTry: phrasesToTry.slice(0, 5), strengths: strengths.slice(0, 2), dropped };
}
/** -> {status:'ok', ...summary, attempts} | {status:'unavailable', reason, attempts} */
export async function generateSummary({ llm, req, signal, model, timings = {}, maxMs = 12000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', attempts: 0 };
  const { ac, done } = abortable(signal, maxMs); let reason = 'summary_failed'; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try { const raw = await llm.chatJson({ messages: buildSummaryMessages(req), signal: ac.signal, model, maxTokens: 900, temperature: 0.3, timeoutMs: Math.max(2000, maxMs - (Date.now() - t0)) }); return { status: 'ok', attempts: n, ...validateSummary(raw) }; }
      catch (e) { reason = failReason(e); if (ac.signal.aborted || (e.retryable === false && e.code !== 'talk_schema')) break; }
    }
    return { status: 'unavailable', reason, attempts: n };
  } finally { done(); timings.summaryMs = Date.now() - t0; }
}

// ---------------------------------------------------------------------------------------------------------------- script-grounded UPGRADE (LLM #3, only with a script)
// "Say it like your script": keeps the learner's meaning, uses the script's vocabulary / phrasing, modest edits. CODE checks every claim:
//   * sourceLines must be VERBATIM substrings of the script (others dropped); offsets are code points into the script, end exclusive
//   * every change.from must occur in `said`, every change.to in `better` (others dropped); offsets are code points into said / better, end exclusive
//   * `better` may not add content: new hanzi (not in said ∪ sourceLines ∪ a small function-word list) above UPGRADE_MAX_NEW_RATIO => ungrounded (dropped)
export const UPGRADE_MAX_NEW_RATIO = 0.15;   // share of better's hanzi that may be "new" (neither said, nor in the cited script lines, nor function words)
export const UPGRADE_MAX_NEW_ABS = 1;        // ... but 1 new hanzi is always tolerated (e.g. a measure word)
export const UPGRADE_FUNCTION_HANZI = new Set(Array.from('的了是在和也都就很还又把被给对跟与而但所以因为如果虽然然后我们你他她它这那个些一不没有着过吗呢吧啊得地要会能可以更最其中之此于则并且或者从到为让使'));
const cpIndex = (hay, needle) => { const i = String(hay).indexOf(needle); return i < 0 ? -1 : cpLen(String(hay).slice(0, i)); };
export function buildUpgradeMessages({ ctx, transcript }) {
  const system = `TALK_UPGRADE. A Mandarin learner is practising to talk about their own SCRIPT. Rewrite what they just said (learnerText, from speech-to-text) so it uses the SCRIPT's vocabulary and phrasing while keeping THEIR meaning. Output JSON only:
{"upgrade": null | {"said": string, "better": string, "changes": [{"from": string, "to": string, "kind": "word_choice"|"grammar"|"unnatural"|"english_gap", "note": string}], "sourceLines": [string]}}
RULES:
- "said": learnerText, or the ONE sentence of it you upgrade, copied EXACTLY. "better": that sentence rewritten with modest edits (swap words/phrases for the script's, fix clear errors). Do NOT add facts, ideas or details that the learner did not say, even if the script has them.
- "changes": 1-5 edits; "from" copied EXACTLY from said, "to" copied EXACTLY from better. "note": optional, short English (<= 60 chars), never about pronunciation/tones.
- "sourceLines": 1-3 short excerpts copied VERBATIM (character for character) from the script that the new wording comes from.
- If what they said is unrelated to the script, or already uses the script's wording well, return {"upgrade": null}.
Simplified Chinese; no pinyin; never mention pronunciation, tones or accent.`;
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ script: ctx.script, learnerText: transcript }) }];
}
/** -> { upgrade|null, status:'ok'|'none'|'ungrounded', dropped:[reason], newRatio? }; throws TalkSchemaError for a malformed shape */
export function validateUpgrade(parsed, { transcript, script }) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('upgrade' in parsed)) throw new TalkSchemaError('upgrade key missing');
  const u = parsed.upgrade; const dropped = [];
  if (u === null) return { upgrade: null, status: 'none', dropped };
  if (!u || typeof u !== 'object' || Array.isArray(u) || typeof u.better !== 'string' || !Array.isArray(u.changes)) throw new TalkSchemaError('upgrade shape');
  const t = String(transcript ?? '').trim();
  let said = typeof u.said === 'string' ? u.said.trim() : '';
  if (!said || !t.includes(said)) { if (said) dropped.push('said_not_in_transcript'); said = t; }
  const better = u.better.trim();
  if (hz(better).length < 2 || LATIN.test(better) || soundy(better) || /[#*_`<>{}[\]]/.test(better) || cpLen(better) > Math.max(cpLen(said) * 2, cpLen(said) + 40)) return { upgrade: null, status: 'none', dropped: [...dropped, 'bad_better'] };
  if (hanziOnly(better) === hanziOnly(said)) return { upgrade: null, status: 'none', dropped: [...dropped, 'no_change'] };
  const sourceLines = [];
  for (const x of Array.isArray(u.sourceLines) ? u.sourceLines : []) {
    const text = (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '').trim();
    if (!text || hz(text).length < 2 || cpLen(text) > 160 || !script.includes(text)) { dropped.push('sourceLine_not_in_script'); continue; }
    if (sourceLines.some((s) => s.text === text) || sourceLines.length >= 3) continue;
    const start = cpIndex(script, text); sourceLines.push({ text, start, end: start + cpLen(text) });
  }
  const changes = [];
  for (const c of u.changes) {
    const from = typeof c?.from === 'string' ? c.from.trim() : ''; const to = typeof c?.to === 'string' ? c.to.trim() : '';
    if (!from || !to || from === to) { dropped.push('change_empty'); continue; }
    if (!said.includes(from)) { dropped.push('change_from_not_in_said'); continue; }
    if (!better.includes(to)) { dropped.push('change_to_not_in_better'); continue; }
    if (LATIN.test(to) || soundy(to) || hz(to).length < 1) { dropped.push('change_to_unusable'); continue; }
    if (changes.length >= 5) break;
    const fromStart = cpIndex(said, from); const toStart = cpIndex(better, to);
    const ch = { from, to, fromStart, fromEnd: fromStart + cpLen(from), toStart, toEnd: toStart + cpLen(to) };
    if (CORRECTION_KINDS.includes(c.kind)) ch.kind = c.kind;
    const note = typeof c.note === 'string' ? c.note.trim() : '';
    if (note && cpLen(note) <= 80 && !soundy(note) && !LANG_PRAISE.test(note)) ch.note = note;
    changes.push(ch);
  }
  if (!changes.length) return { upgrade: null, status: 'none', dropped: [...dropped, 'no_valid_changes'] };
  // grounding: better may not add content that is neither in what he said nor in the cited script lines
  const allowed = new Set([...hz(simp(said)), ...sourceLines.flatMap((l) => hz(simp(l.text))), ...UPGRADE_FUNCTION_HANZI]);
  const bh = hz(simp(better)); const fresh = bh.filter((h) => !allowed.has(h)); const newRatio = bh.length ? fresh.length / bh.length : 1;
  if (fresh.length > UPGRADE_MAX_NEW_ABS && newRatio > UPGRADE_MAX_NEW_RATIO) return { upgrade: null, status: 'ungrounded', dropped: [...dropped, 'ungrounded'], newRatio };
  return { upgrade: { said, better, betterPinyin: pinyinOf(better), changes, sourceLines }, status: 'ok', dropped, newRatio };
}
/** saveable phrases from the changes' `to` (compatible with POST /api/words: text <= 100, pinyin <= 200, sourceChunk <= 200) */
export function upgradeSaveable(upgrade) {
  if (!upgrade) return [];
  const out = []; const src = upgrade.sourceLines[0]?.text || upgrade.better;
  for (const c of upgrade.changes) {
    const text = c.to.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
    if (hz(text).length < 1 || cpLen(text) > 20 || out.some((x) => x.text === text)) continue;
    out.push({ text, pinyin: pinyinOf(text), meaning: null, sourceChunk: cpSlice(src, 200) });
  }
  return out;
}
/** -> {status:'ok'|'none'|'ungrounded', upgrade, dropped, attempts} | {status:'unavailable', reason, attempts} */
export async function generateUpgrade({ llm, ctx, transcript, signal, model, timings = {}, maxMs = 8000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured', attempts: 0 };
  const { ac, done } = abortable(signal, maxMs); let reason = 'upgrade_failed'; let n = 0;
  try {
    for (let i = 0; i < attempts; i++) {
      n = i + 1;
      try {
        const raw = await llm.chatJson({ messages: buildUpgradeMessages({ ctx, transcript }), signal: ac.signal, model, maxTokens: 450, temperature: 0, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        return { attempts: n, ...validateUpgrade(raw, { transcript, script: ctx.script }) };
      } catch (e) { reason = failReason(e); if (ac.signal.aborted || (e.retryable === false && e.code !== 'talk_schema')) break; }
    }
    return { status: 'unavailable', reason, attempts: n };
  } finally { done(); timings.upgradeMs = Date.now() - t0; }
}
