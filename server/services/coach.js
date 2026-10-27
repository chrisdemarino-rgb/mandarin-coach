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
  return { kind: 'tone', targetText: fact.char, modelText: hanzi(chunkText) || fact.char, factRef: fact.ref, source: 'server_fact',
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
  if (!['tone', 'model', 'wording', 'omission'].includes(kind)) return { dropped: 'unknown_kind' };

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
  // wording / omission: transcript-derived only, never tone evidence
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
  const system = `You are a warm, concise Mandarin pronunciation coach for an English-speaking adult learner. The learner just spoke one short chunk. Reply as JSON only.
STRICT GROUNDING RULES:
- You may make pronunciation/tone statements ONLY about items listed in facts.confirmedToneErrors. Each has a "ref".
- A correction of kind "tone" MUST set factRef to that item's ref and name only that item's expectedTone and heardTone. Never invent or guess a tone.
- facts.uncertain items are NOT errors (the evidence was too weak, or the engine was unsure). You are NOT told what was heard for them, so never say what tone or sound the learner produced. At most say you are not sure and give the model pronunciation, with kind "model" (no tone or sound claims, factRef = that item's ref or null).
- Never say "you said/read it as tone X" or describe the learner's pitch (rising, falling, flat...) for anything except an item in facts.confirmedToneErrors.
- If facts.confirmedToneErrors is empty, do not claim any tone problem anywhere (not in praise either). Tone changes such as 3rd-tone sandhi are normal; never call them errors.
- kinds "wording"/"omission" are allowed ONLY if a transcript is given and it clearly differs from the chunk; they are never tone evidence. In retell mode wording changes are not errors; only mention missing meaning ("omission").
- If basis is "transcript", the tone facts were computed against what the learner was heard saying, so say briefly that this is based on what you heard.
STYLE: spoken, simple Mandarin (about HSK 3-4), each string under 40 characters, no English, no pinyin, no markdown. At most 2 corrections, most useful first.
OUTPUT JSON (keys in this order): {"praiseZh": string, "corrections": [{"kind":"tone|model|wording|omission","targetText":string,"explanationZh":string,"modelText":string,"factRef":string|null}], "nextPromptZh": string}
modelText must be copied from the chunk. nextPromptZh invites the learner to try again or continue.`;
  const user = JSON.stringify({ chunkText, mode: assessMode, basis, lowConfidence: !!lowConfidence, transcript: transcript || null,
    facts: { confirmedToneErrors: facts.confirmedToneErrors.map((f) => ({ ref: f.ref, char: f.char, expectedTone: f.expectedTone, heardTone: f.heardTone })),
      uncertain: facts.uncertain.map((u) => ({ ref: u.ref, char: u.char, dimension: u.dimension })) } });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Sentences for sentence-by-sentence TTS. */
export function splitSentences(text) {
  const parts = String(text).match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  return parts.map((s) => s.trim()).filter((s) => hanzi(s) || /\w/.test(s));
}

/**
 * Run coaching. Calls onUnit({kind:'praise'|'correction'|'next', text, correction?}) as validated units become ready.
 * Resolves to { corrections, praiseZh, nextPromptZh, dropped:[reason] }.
 */
export async function runCoach({ llm, chunkText, assessMode, basis = 'script', lowConfidence = false, transcript = null, facts, signal, onUnit = () => {} }) {
  if (!llm?.available) throw new ServiceError('llm_not_configured', 'OPENAI_API_KEY is not set on the server; coaching skipped.');
  const ctx = { chunkText, facts, transcript, assessMode };
  const scanner = new JsonUnitScanner();
  const corrections = []; const dropped = []; let praiseZh = null; let nextPromptZh = null;

  const emitCorrection = (c) => {
    if (corrections.length >= MAX_CORRECTIONS) { dropped.push('over_max'); return; }
    // keep the last slot free for a confirmed tone error if none has been covered yet
    if (facts.confirmedToneErrors.length && c.kind !== 'tone' && corrections.length === MAX_CORRECTIONS - 1 && !corrections.some((x) => x.kind === 'tone')) { dropped.push('reserved_for_tone'); return; }
    if ((c.factRef && corrections.some((x) => x.factRef === c.factRef)) || (c.targetText && corrections.some((x) => x.targetText === c.targetText && x.kind === c.kind))) { dropped.push('duplicate'); return; }
    corrections.push(c);
    onUnit({ kind: 'correction', text: c.explanationZh, correction: c });
    if (c.modelText) onUnit({ kind: 'correction_model', text: `应该这样说：${c.modelText}`, correction: c });
  };
  const handle = (ev) => {
    if (ev.type === 'string' && ev.key === 'praiseZh' && praiseZh === null) { praiseZh = sanitizeLine(ev.value, GENERIC_PRAISE_ZH); onUnit({ kind: 'praise', text: praiseZh }); }
    else if (ev.type === 'string' && ev.key === 'nextPromptZh' && nextPromptZh === null) { nextPromptZh = sanitizeLine(ev.value, GENERIC_NEXT_ZH); } // spoken last, after the fact guarantee below
    else if (ev.type === 'item' && ev.key === 'corrections') {
      const r = validateCorrection(ev.value, ctx);
      if (r.correction) emitCorrection(r.correction); else dropped.push(r.dropped);
    }
  };

  for await (const delta of llm.chatStream({ messages: buildMessages({ chunkText, assessMode, basis, lowConfidence, transcript, facts }), signal })) {
    for (const ev of scanner.push(delta)) handle(ev);
  }
  // Guarantee: a confirmed tone error is never silently lost.
  if (facts.confirmedToneErrors.length && !corrections.some((c) => c.kind === 'tone')) {
    emitCorrection(factCorrection(facts.confirmedToneErrors[0], chunkText));
  }
  if (!corrections.length && praiseZh === null && nextPromptZh === null) throw new ServiceError('llm_empty', 'The language model returned nothing usable.', { retryable: true });
  if (nextPromptZh === null) nextPromptZh = GENERIC_NEXT_ZH;
  onUnit({ kind: 'next', text: nextPromptZh });
  return { corrections, praiseZh, nextPromptZh, dropped };
}
