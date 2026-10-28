// Coaching: streaming LLM + HARD grounding + server post-validation.
//
// The LLM receives ONLY: the reference chunk, the facts computed by code (confirmed tone errors, uncertain items),
// the assessment mode/basis and (close/retell) the transcript. It must return
//   { praiseZh, corrections:[{kind, targetText, explanationZh, modelText, factRef}], nextPromptZh }
// The server then validates every unit BEFORE it is shown or spoken:
//   - kind "tone" needs factRef === the ref of a confirmed tone error (decision 'review'); otherwise it is
//     rewritten as "not sure, here is the model pronunciation" (no tone claimed) or dropped
//   - a tone claim anywhere else (wrong kind, praise, next prompt) is rewritten/neutralised
//   - tone numbers named in a tone correction must be the fact's expected/heard tone, else a fact-built sentence is used
//   - max 2 corrections; modelText must be made of characters from the chunk
// Upstream, engines/assessment/policy.js has already (a) gated mismatched audio (no coaching at all) and (b) demoted weak tone
// flags to 'uncertain' with `heard` withheld, so a demoted item can only ever get the "not sure" wording.
import { ServiceError } from './openai.js';

export const MAX_CORRECTIONS = 2;
const TONE_CLAIM = /声调|声[一二三四1-4]|[一二三四1-4]声|轻声|升调|降调|音调|调子|平调|上扬|下降|升高|降低|\b(?:tones?|rising|falling|pitch)\b|[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
const HANZI = /[\u3400-\u9fff]/g;
const NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 1: 1, 2: 2, 3: 3, 4: 4 };
const ZH_NUM = { 1: '一', 2: '二', 3: '三', 4: '四' };

export const GATE_PHRASE_ZH = '请再说一遍这句话。'; // fixed line when the audio does not match the text (no LLM)
export const NOT_SURE_ZH = '这里我不太确定，请听一听标准读法。';
export const GENERIC_PRAISE_ZH = '不错，我们继续。';
export const GENERIC_NEXT_ZH = '再试一次吧。';
// Fixed lines (spoken without any LLM wait; their audio is cached/pre-warmed by the TTS layer, see FIXED_PHRASES_ZH)
export const OPENER_ZH = '有几个地方要再练一练。';            // replaces praise whenever a word is missing/substituted/unclear or there is a notable gap
export const RETRY_ZH = '再说一遍这句话吧。';
export const STT_UNAVAILABLE_ZH = '这次没能检查有没有漏词。';   // spoken when the transcript check did not run (confidence reduced)
export const PRAISE_LINES_ZH = ['很好，发音很清楚。', '说得不错，我们继续。', '很好，再来下一句。'];
export const DRILL_OK_ZH = '对了！';
export const DRILL_RETRY_ZH = '再试一次。';
export const FIXED_PHRASES_ZH = [GATE_PHRASE_ZH, OPENER_ZH, RETRY_ZH, STT_UNAVAILABLE_ZH, ...PRAISE_LINES_ZH, NOT_SURE_ZH, DRILL_OK_ZH, DRILL_RETRY_ZH, GENERIC_NEXT_ZH];
/** Praise/completeness wording. HARD RULE: when a word is missing/substituted/unclear (facts.canPraise === false) none of this may reach the user from the LLM. */
export const PRAISE_RE = /很好|不错|太棒|很棒|完美|完整|全对|都对|正确|没问题|做得好|说得好|说得很|\b(?:good|great|perfect|well done|excellent|complete|correct)\b/i;

export const hanzi = (s) => (String(s ?? '').match(HANZI) || []).join('');
const isSubsetOf = (part, whole) => { const w = hanzi(whole); return [...hanzi(part)].every((c) => w.includes(c)); };
const toneNumbersIn = (text) => {
  const out = new Set(); let m; const re = /第?([一二三四1-4])声|声([一二三四1-4])/g;
  while ((m = re.exec(text))) out.add(NUM[m[1] || m[2]]);
  if (/轻声/.test(text)) out.add(5);
  return out;
};
const toneWord = (n) => (n === 5 || n == null ? '轻声' : `第${ZH_NUM[n]}声`);

/** A correction built purely from a confirmed fact (no LLM text). */
export function factCorrection(fact, chunkText) {
  return { kind: 'tone', targetText: fact.char, start: fact.start, end: fact.end, pinyin: fact.pinyin, modelText: hanzi(chunkText) || fact.char, factRef: fact.ref, source: 'server_fact',
    explanationZh: `“${fact.char}”应该读${toneWord(fact.expectedTone)}，我听到的是${toneWord(fact.heardTone)}。` };
}

/** Validate one raw LLM correction. Returns {correction} | {dropped: reason}. */
export function validateCorrection(raw, ctx) {
  const { chunkText, facts, transcript, assessMode } = ctx;
  if (!raw || typeof raw !== 'object') return { dropped: 'not_an_object' };
  const kind = String(raw.kind || '').toLowerCase();
  const explanation = String(raw.explanationZh ?? '').trim().slice(0, 120);
  let target = String(raw.targetText ?? '').trim().slice(0, 30);
  let model = String(raw.modelText ?? '').trim().slice(0, 60);
  if (['missing', 'substituted', 'unclear'].includes(kind)) return { dropped: 'code_owned' }; // missing/wrong WORDS are built by code from facts, never by the LLM
  if (!['tone', 'model', 'wording', 'omission'].includes(kind)) return { dropped: 'unknown_kind' };
  if (ctx.canPraise === false && PRAISE_RE.test(explanation)) { // HARD RULE: no "good/complete" wording while words are missing
    const f = kind === 'tone' ? facts.confirmedToneErrors.find((x) => x.ref === raw.factRef) : null;
    return f ? { correction: { ...factCorrection(f, chunkText), source: 'server_fact' } } : { dropped: 'praise_while_incomplete' };
  }

  const modelFor = (t) => (model && isSubsetOf(model, chunkText) && hanzi(model) ? model : (t && isSubsetOf(t, chunkText) && hanzi(t) ? t : hanzi(chunkText)));
  const notSure = (t) => {
    const tt = t && hanzi(t) && isSubsetOf(t, chunkText) ? t : '';
    if (!tt && !hanzi(chunkText)) return { dropped: 'nothing_to_model' };
    return { correction: { kind: 'model', targetText: tt, modelText: modelFor(tt), factRef: null, explanationZh: NOT_SURE_ZH, source: 'server_rewrite' } };
  };

  if (kind === 'tone') {
    const fact = facts.confirmedToneErrors.find((f) => f.ref === raw.factRef);
    if (!fact) return notSure(target); // no evidence => no tone claim
    if (!target || !hanzi(target).includes(fact.char) || !isSubsetOf(target, chunkText)) target = fact.char;
    const nums = toneNumbersIn(explanation);
    const allowed = new Set([fact.expectedTone, fact.heardTone]);
    if (!explanation || [...nums].some((n) => !allowed.has(n))) return { correction: { ...factCorrection(fact, chunkText), targetText: target, source: 'server_fact' } };
    return { correction: { kind: 'tone', targetText: target, modelText: modelFor(target), factRef: fact.ref, explanationZh: explanation, source: 'llm' } };
  }
  if (kind === 'model') {
    if (!explanation || TONE_CLAIM.test(explanation)) return notSure(target);
    const refOk = facts.uncertain.some((u) => u.ref === raw.factRef);
    return { correction: { kind: 'model', targetText: target && isSubsetOf(target, chunkText) ? target : '', modelText: modelFor(target), factRef: refOk ? raw.factRef : null, explanationZh: explanation, source: 'llm' } };
  }
  // wording / omission: transcript-derived only, never tone evidence. In close mode missing/wrong words are computed by code (words.js).
  if (assessMode !== 'retell') return { dropped: 'code_owned' };
  if (!transcript) return { dropped: 'no_transcript' };
  if (assessMode === 'retell' && kind === 'wording') return { dropped: 'wording_not_error_in_retell' };
  if (!explanation || TONE_CLAIM.test(explanation)) return { dropped: 'tone_claim_without_evidence' };
  return { correction: { kind, targetText: target, modelText: modelFor(target), factRef: null, explanationZh: explanation, source: 'llm', basis: 'transcript' } };
}

export const sanitizeLine = (text, fallback) => {
  const t = String(text ?? '').trim().slice(0, 100);
  return !t || TONE_CLAIM.test(t) ? fallback : t;
};

/** Incremental scanner for the LLM's top-level JSON object. Emits complete top-level strings and array elements. */
export class JsonUnitScanner {
  constructor() { this.buf = ''; this.pos = 0; this.depth = 0; this.inStr = false; this.esc = false; this.strStart = 0; this.expectKey = false; this.key = null; this.itemStart = -1; }
  /** @returns {Array<{type:'string',key,value}|{type:'item',key,value}>} */
  push(delta) {
    this.buf += delta; const out = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') {
          this.inStr = false;
          if (this.depth === 1) {
            let v; try { v = JSON.parse(this.buf.slice(this.strStart, this.pos + 1)); } catch { continue; }
            if (this.expectKey) this.key = v; else out.push({ type: 'string', key: this.key, value: v });
          }
        }
        continue;
      }
      if (this.depth === 0) { if (c === '{') { this.depth = 1; this.expectKey = true; } continue; }
      if (c === '"') { this.inStr = true; this.strStart = this.pos; }
      else if (c === '{' || c === '[') { this.depth += 1; if (c === '{' && this.depth === 3) this.itemStart = this.pos; }
      else if (c === '}' || c === ']') {
        if (c === '}' && this.depth === 3 && this.itemStart >= 0) {
          try { out.push({ type: 'item', key: this.key, value: JSON.parse(this.buf.slice(this.itemStart, this.pos + 1)) }); } catch { /* skip malformed */ }
          this.itemStart = -1;
        }
        this.depth -= 1;
      } else if (this.depth === 1 && c === ':') this.expectKey = false;
      else if (this.depth === 1 && c === ',') this.expectKey = true;
    }
    return out;
  }
}

export function buildMessages({ chunkText, assessMode, basis, lowConfidence, transcript, facts }) {
  // Short on purpose (latency): the LLM is only called when there is a confirmed tone error to explain, or in retell mode.
  const system = `You are a warm, concise Mandarin pronunciation coach. Reply as JSON only.
GROUNDING: make pronunciation statements ONLY about facts.confirmedToneErrors (each has a "ref"). A "tone" correction MUST set factRef to that ref and name only its expectedTone and heardTone. facts.uncertain items are not errors and you are not told what was heard: at most say you are not sure and give the model pronunciation (kind "model", no tone/sound claims). Never describe the learner's pitch otherwise. Tone sandhi is normal, never an error.
Missing or wrong WORDS are handled by the system: never mention them and never say the learner did well/completely/correctly overall.${assessMode === 'retell' ? '\nRetell mode: wording changes are not errors; only kind "omission" for missing meaning (transcript given).' : ''}${basis === 'transcript' ? '\nTone facts are based on what was heard, say so briefly.' : ''}
STYLE: simple spoken Mandarin (HSK 3-4), each string under 30 characters, no English/pinyin/markdown. At most 2 corrections.
JSON (keys in this order): {"praiseZh": string, "corrections": [{"kind":"tone|model|omission","targetText":string,"explanationZh":string,"modelText":string,"factRef":string|null}], "nextPromptZh": string}
modelText is copied from the chunk.`;
  const user = JSON.stringify({ chunkText, mode: assessMode, basis, lowConfidence: !!lowConfidence, ...(assessMode === 'retell' ? { transcript: transcript || null } : {}),
    facts: { confirmedToneErrors: facts.confirmedToneErrors.map((f) => ({ ref: f.ref, char: f.char, expectedTone: f.expectedTone, heardTone: f.heardTone })),
      uncertain: facts.uncertain.map((u) => ({ ref: u.ref, char: u.char, dimension: u.dimension })) } });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Sentences for sentence-by-sentence TTS. */
export function splitSentences(text) {
  const parts = String(text).match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  return parts.map((s) => s.trim()).filter((s) => hanzi(s) || /\w/.test(s));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Code-built corrections for missing / substituted / unclear WORDS (never LLM text). All content comes from facts computed by code.
const modelWindow = (chunkText, w) => {
  // a lone character is hard to hear in isolation: model it together with a neighbouring script word (max 4 chars)
  if (hanzi(w.text).length >= 2) return hanzi(w.text);
  const segs = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(String(chunkText))].map((x) => x.segment).filter((x) => hanzi(x));
  const at = segs.findIndex((x) => hanzi(x) === hanzi(w.text));
  const withNeighbour = at > 0 ? hanzi(segs[at - 1]) + hanzi(w.text) : at >= 0 && segs[at + 1] ? hanzi(w.text) + hanzi(segs[at + 1]) : hanzi(w.text);
  return withNeighbour.length <= 4 ? withNeighbour : hanzi(w.text);
};
const caption = (w, meaning) => `${w.text} ${w.pinyin}${meaning ? ` — ${meaning}` : ''}`;
const common = (w, meaning, extra) => ({ targetText: w.text, start: w.start, end: w.end, pinyin: w.pinyin, meaning: meaning ?? null, factRef: w.ref, source: 'server_fact',
  evidence: { source: w.source, confidence: w.confidence }, caption: caption(w, meaning), ...extra });

export function wordCorrection(kind, w, chunkText, meaning = null) {
  const hedge = w.confidence !== 'high';
  const modelText = modelWindow(chunkText, w);
  if (kind === 'missing') {
    const part = w.missedText && w.missedText !== w.text; // only some characters of a multi-character word were skipped
    return common(w, meaning, { kind, modelText, explanationZh: part ? (hedge ? `“${w.text}”这个词里好像漏掉了“${w.missedText}”。` : `“${w.text}”这个词里漏掉了“${w.missedText}”。`)
      : (hedge ? `好像漏掉了“${w.text}”这个词。` : `漏掉了“${w.text}”这个词。`) });
  }
  if (kind === 'substituted') return common(w, meaning, { kind, modelText, heard: w.heard,
    explanationZh: hedge ? `这里应该是“${w.text}”，我好像听到的是“${w.heard}”。` : `这里应该是“${w.text}”，我听到的是“${w.heard}”。` });
  return common(w, meaning, { kind: 'unclear', modelText, explanationZh: `“${w.text}”这个词我听得不太清楚。` });
}

/**
 * Pick at most MAX_CORRECTIONS corrections, ranked: missing/substituted (high, then medium) > confirmed tone error > low-confidence/unclear.
 * Returns { words:[code-built word corrections in priority order], toneSlots, order } -- tone corrections are filled in later (LLM-validated or fact-built).
 */
export function planCorrections(facts, chunkText, meaningOf = () => null) {
  const hard = [...facts.missingWords.map((w) => wordCorrection('missing', w, chunkText, meaningOf(w.text))), ...facts.substitutedWords.map((w) => wordCorrection('substituted', w, chunkText, meaningOf(w.text)))]
    .filter((c) => c.evidence.confidence !== 'low')
    .sort((a, b) => (b.evidence.confidence === 'high') - (a.evidence.confidence === 'high') || a.start - b.start);
  const hardPick = hard.slice(0, MAX_CORRECTIONS);
  const toneSlots = Math.min(facts.confirmedToneErrors.length, MAX_CORRECTIONS - hardPick.length);
  const hardStarts = new Set([...facts.missingWords, ...facts.substitutedWords].map((w) => w.start)); // a word already named as missed/wrong is not also "unclear"
  const low = [...facts.unclearWords.filter((w) => !hardStarts.has(w.start)).map((w) => wordCorrection('unclear', w, chunkText, meaningOf(w.text))),
    ...[...facts.missingWords, ...facts.substitutedWords].filter((w) => w.confidence === 'low').map((w) => wordCorrection('unclear', w, chunkText, meaningOf(w.text)))];
  const lowPick = low.slice(0, MAX_CORRECTIONS - hardPick.length - toneSlots);
  return { hard: hardPick, toneSlots, low: lowPick, overflow: hard.length - hardPick.length };
}

/** Does this turn need the LLM at all? In retell mode, or (opt-in COACH_LLM_TONE=1, costs ~2-3 s) to phrase a confirmed tone error. By default tone errors use the code-built fact sentence. Everything else is code. */
export const needsLlm = ({ assessMode, plan, llmTone = false }) => assessMode === 'retell' || (llmTone && plan.toneSlots > 0);

const praiseFor = (seed) => PRAISE_LINES_ZH[[...String(seed || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % PRAISE_LINES_ZH.length];

/**
 * Run coaching. Calls onUnit({kind:'opener'|'praise'|'correction'|'correction_model'|'caveat'|'next', text, correction?}) as validated units become ready.
 * Order: [opener|praise] , code-built word corrections (immediately, no LLM wait) , tone corrections (LLM, validated, or fact-built) , low-confidence , caveat , next.
 * Resolves to { corrections, praiseZh, nextPromptZh, dropped:[reason], llmCalled }.
 */
export async function runCoach({ llm, chunkText, assessMode, basis = 'script', lowConfidence = false, transcript = null, facts, signal, onUnit = () => {}, meaningOf, seed, timings = {}, llmTone = false }) {
  const plan = planCorrections(facts, chunkText, meaningOf);
  const wantLlm = needsLlm({ assessMode, plan, llmTone });
  if (wantLlm && !llm?.available && assessMode === 'retell') throw new ServiceError('llm_not_configured', 'OPENAI_API_KEY is not set on the server; coaching skipped.');
  const useLlm = wantLlm && !!llm?.available; // without an LLM, tone errors still get their fact-built sentence
  const canPraise = facts.canPraise !== false;
  const toneFirst = !useLlm && plan.toneSlots > 0 && assessMode !== 'retell'; // code-built tone sentence follows: open with the neutral opener, not praise
  const ctx = { chunkText, facts, transcript, assessMode, canPraise };
  const corrections = []; const dropped = []; let praiseZh = null; let nextPromptZh = null; let opened = false;

  const emitCorrection = (c) => {
    if (corrections.length >= MAX_CORRECTIONS) { dropped.push('over_max'); return false; }
    if ((c.factRef && corrections.some((x) => x.factRef === c.factRef)) || (c.targetText && corrections.some((x) => x.targetText === c.targetText && x.kind === c.kind))) { dropped.push('duplicate'); return false; }
    corrections.push(c);
    onUnit({ kind: 'correction', text: c.explanationZh, correction: c });
    if (c.modelText) onUnit({ kind: 'correction_model', text: `应该这样说：${c.modelText}`, correction: c });
    return true;
  };
  const open = () => {
    if (opened) return; opened = true;
    if (!canPraise || toneFirst) { praiseZh = OPENER_ZH; onUnit({ kind: 'opener', text: OPENER_ZH }); } // never "good!" and then a correction
  };

  // ---- LLM (started first so it runs while the code-built lines are being spoken). Its units are handled as they stream in,
  //      but only after the code-built lines have been emitted (queue until `ready`).
  let toneDone = 0; let ready = false; const queue = []; let llmErr = null;
  const handle = (ev) => {
    if (ev.type === 'string' && ev.key === 'praiseZh' && praiseZh === null) {
      if (canPraise) { praiseZh = sanitizeLine(ev.value, GENERIC_PRAISE_ZH); onUnit({ kind: 'praise', text: praiseZh }); }
      else dropped.push('praise_while_incomplete');
    } else if (ev.type === 'string' && ev.key === 'nextPromptZh' && nextPromptZh === null) {
      nextPromptZh = sanitizeLine(ev.value, GENERIC_NEXT_ZH);
      if (!canPraise && PRAISE_RE.test(nextPromptZh)) nextPromptZh = GENERIC_NEXT_ZH;
    } else if (ev.type === 'item' && ev.key === 'corrections') {
      const r = validateCorrection(ev.value, ctx);
      if (!r.correction) { dropped.push(r.dropped); return; }
      const c = r.correction;
      if (c.kind === 'tone') { if (toneDone >= plan.toneSlots) { dropped.push('over_max'); return; } if (emitCorrection(c)) toneDone++; }
      else if (corrections.length < MAX_CORRECTIONS - (plan.toneSlots - toneDone)) emitCorrection(c); // keep slots for tone errors
      else dropped.push('reserved_for_tone');
    }
  };
  let llmDone = Promise.resolve();
  if (useLlm) {
    const t0 = Date.now(); const scanner = new JsonUnitScanner();
    llmDone = (async () => {
      try {
        for await (const delta of llm.chatStream({ messages: buildMessages({ chunkText, assessMode, basis, lowConfidence, transcript, facts }), signal, maxTokens: 260 })) {
          if (timings.llmFirstTokenMs === undefined) timings.llmFirstTokenMs = Date.now() - t0;
          for (const ev of scanner.push(delta)) { if (ready) handle(ev); else queue.push(ev); }
        }
      } catch (e) { llmErr = e; }
      timings.llmTotalMs = Date.now() - t0;
    })();
  }

  // ---- 1. opener (fixed, cached audio) + code-built word corrections: no LLM wait
  open();
  for (const c of plan.hard) emitCorrection(c);

  // ---- 2. LLM units (praise only when allowed; tone corrections validated)
  if (useLlm) {
    ready = true; for (const ev of queue.splice(0)) handle(ev);
    await llmDone;
    if (llmErr && !corrections.length) throw llmErr;
  } else if (canPraise && praiseZh === null && !toneFirst) {
    praiseZh = praiseFor(seed); onUnit({ kind: 'praise', text: praiseZh });
  }
  // Guarantee: a confirmed tone error that fits the cap is never silently lost (fact-built sentence when the LLM did not cover it).
  for (const f of facts.confirmedToneErrors) { if (toneDone >= plan.toneSlots) break; if (!corrections.some((x) => x.factRef === f.ref) && emitCorrection(factCorrection(f, chunkText))) toneDone++; }

  // ---- 3. low-confidence words (hedged, only if slots remain)
  for (const c of plan.low) emitCorrection(c);

  // ---- 4. honesty caveat when the transcript check did not run + next prompt
  if (facts.stt && assessMode !== 'retell' && facts.stt.status !== 'ok') onUnit({ kind: 'caveat', text: STT_UNAVAILABLE_ZH });
  if (!corrections.length && praiseZh === null && nextPromptZh === null) throw new ServiceError('llm_empty', 'The language model returned nothing usable.', { retryable: true });
  if (nextPromptZh === null) nextPromptZh = !canPraise ? RETRY_ZH : GENERIC_NEXT_ZH;
  onUnit({ kind: 'next', text: nextPromptZh });
  return { corrections, praiseZh, nextPromptZh, dropped, llmCalled: useLlm, plan: { hard: plan.hard.length, tone: plan.toneSlots, low: plan.low.length, overflow: plan.overflow } };
}
