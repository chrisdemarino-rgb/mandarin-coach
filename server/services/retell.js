// Natural RETELL mode: the learner retells the reference chunk in their own words.
//
//   STT transcript  --->  LLM compares MEANING (one JSON call)  --->  CODE validates/resolves everything  --->  code-built coaching
//
// GROUNDING (what the LLM may and may not do)
//   * The LLM sees ONLY the reference chunk and the transcript. It proposes key ideas as {textZh, refQuote, covered, evidence, confidence}
//     and optional wrong_meaning/language corrections. It never supplies offsets, counts or verdicts: CODE resolves refQuote to code-point
//     offsets into the exact chunkText (exact -> punctuation-insensitive -> fuzzy), checks that every evidence/quote really is in the
//     transcript, derives covered/missing counts, canPraise, the spoken lines and the correction list.
//   * An idea whose span cannot be found in the reference is dropped (it may be invented). Evidence that is not in the transcript demotes
//     covered:true to "partial" + confidence "low" (never accuses, never over-praises). Malformed JSON => one retry, then
//     comparisonStatus "unavailable" and NO coverage claims.
//   * No tone/pronunciation statement ever comes from the transcript or from the LLM text (rewritten to a fixed line when attempted).
import { pinyin as pinyinPro } from 'pinyin-pro';
import { ServiceError } from './openai.js';

// ---- traditional -> simplified (STT sometimes answers in traditional characters; pinyin-pro misreads some of them, e.g. 車 -> "ju")
let t2s = null;
try { const m = await import('opencc-js'); const O = m.default || m; t2s = O.Converter({ from: 'tw', to: 'cn' }); } catch { /* optional: falls back to the pinyin-level comparison */ }
export const toSimplified = (text) => { const s = String(text ?? ''); try { return t2s ? t2s(s) : s; } catch { return s; } };

export const MAX_IDEAS = 8;
export const MAX_RETELL_CORRECTIONS = 2;
const HANZI_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
export const TONE_CLAIM = /声调|声[一二三四1-4]|[一二三四1-4]声|轻声|升调|降调|音调|调子|平调|上扬|下降|升高|降低|发音|读音|读成|读错|\b(?:tones?|pinyin|pitch|pronunciation)\b|[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
export const PRAISE_RE = /很好|不错|太棒|很棒|完美|完整|全对|都对|正确|没问题|做得好|说得好|说得很|讲得好|讲得很|\b(?:good|great|perfect|well done|excellent|complete|correct)\b/i;
export const NON_ZH = /[A-Za-z0-9]/;
export const hz = (s) => Array.from(String(s ?? '')).filter((c) => HANZI_RE.test(c));
export const hanziOnly = (s) => hz(s).join('');

// ---------------------------------------------------------------------------------------------------------------- fixed spoken lines
const ZH_N = ['', '一', '二', '三', '四', '五', '六', '七', '八'];
export const RT_ALL_ZH = '意思都讲到了，很好。';
export const RT_ALL_TONE_ZH = '意思都讲到了，有一个发音可以再练一练。';
export const RT_SOFT_ZH = '大部分意思都讲到了。';
export const RT_WRONG_ZH = '有些地方的意思和原文不一样。';
export const RT_WORD_ZH = '有个词和原文不一样。';   // reused-phrase word check found a substituted/omitted script word: neutral, never praise
export const RT_GATE_ZH = '我没有听清楚，请再讲一遍。';
export const RT_UNAVAILABLE_ZH = '这次没能比较意思。';
export const RT_UNAVAILABLE_NEXT_ZH = '再讲一遍吧。';
export const RT_NEXT_OK_ZH = '我们继续下一段。';
export const RT_NEXT_RETRY_ZH = '再讲一遍吧。';
export const rtMissingOpener = (n) => `有${n === 1 ? '一' : ZH_N[Math.min(n, 8)]}个意思没讲到。`;
export const RETELL_PHRASES_ZH = [RT_GATE_ZH, RT_ALL_ZH, RT_ALL_TONE_ZH, RT_SOFT_ZH, RT_WRONG_ZH, RT_WORD_ZH, RT_UNAVAILABLE_ZH, RT_NEXT_OK_ZH, RT_NEXT_RETRY_ZH, ...[1, 2, 3, 4, 5].map(rtMissingOpener)];

// ---------------------------------------------------------------------------------------------------------------- matching helpers
/** Semi-global edit-distance search of `needle` inside `hay` (arrays of tokens). Returns {start,end,dist} (end exclusive) with the lowest distance. */
export function bestWindow(hay, needle, eq = (a, b) => a === b) {
  const n = needle.length; const m = hay.length;
  if (!n || !m) return null;
  const D = Array.from({ length: n + 1 }, () => new Int32Array(m + 1)); // D[i][j]: needle[:i] vs a hay substring ending at j (free start)
  const B = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));  // start index of that substring
  for (let j = 0; j <= m; j++) { D[0][j] = 0; B[0][j] = j; }
  for (let i = 1; i <= n; i++) { D[i][0] = i; B[i][0] = 0; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const sub = D[i - 1][j - 1] + (eq(needle[i - 1], hay[j - 1]) ? 0 : 1); const del = D[i - 1][j] + 1; const ins = D[i][j - 1] + 1;
    const best = Math.min(sub, del, ins);
    D[i][j] = best; B[i][j] = best === sub ? B[i - 1][j - 1] : best === del ? B[i - 1][j] : B[i][j - 1];
  }
  let bj = 1; for (let j = 1; j <= m; j++) if (D[n][j] < D[n][bj] || (D[n][j] === D[n][bj] && j - B[n][j] > bj - B[n][bj])) bj = j;
  return { start: B[n][bj], end: bj, dist: D[n][bj] };
}

/** Resolve an LLM-proposed quote to code-point offsets in the EXACT chunkText. Never trusts model numbers. -> {start,end,how} | null */
export function resolveSpan(chunkText, quote) {
  const ref = Array.from(String(chunkText ?? '')); const q = Array.from(String(quote ?? '').trim());
  if (q.length < 2 || !ref.length) return null;
  const trim = (s, e) => { while (s < e && !HANZI_RE.test(ref[s])) s++; while (e > s && !HANZI_RE.test(ref[e - 1])) e--; return e - s >= 2 ? { start: s, end: e } : null; };
  // 1. exact
  for (let i = 0; i + q.length <= ref.length; i++) if (q.every((c, k) => ref[i + k] === c)) { const t = trim(i, i + q.length); if (t) return { ...t, how: 'exact' }; }
  // 2. punctuation/space-insensitive
  const keep = []; ref.forEach((c, i) => { if (HANZI_RE.test(c)) keep.push(i); });
  const rf = keep.map((i) => ref[i]); const qf = q.filter((c) => HANZI_RE.test(c));
  if (qf.length < 2) return null;
  for (let i = 0; i + qf.length <= rf.length; i++) if (qf.every((c, k) => rf[i + k] === c)) return { start: keep[i], end: keep[i + qf.length - 1] + 1, how: 'normalized' };
  // 3. fuzzy: up to 25% edits and the match must still share most characters
  const w = bestWindow(rf, qf);
  if (w && w.end > w.start && w.dist <= Math.floor(qf.length * 0.25) && qf.length >= 3) return { start: keep[w.start], end: keep[w.end - 1] + 1, how: 'fuzzy' };
  return null;
}

const py = (chars) => (chars.length ? pinyinPro(chars.join(''), { toneType: 'none', type: 'array' }).map((p, i) => (p && p !== chars[i] ? String(p).replace(/ü/g, 'u') : chars[i])) : []);
/** Is `quote` (a claimed excerpt of the transcript) really in the transcript? Tolerant to punctuation, traditional/simplified (pinyin level) and 1 slip per 8 characters. */
export function quoteInTranscript(quote, transcript) {
  const q = hz(String(quote ?? '').normalize('NFKC')); const t = hz(String(transcript ?? '').normalize('NFKC'));
  if (q.length < 2 || !t.length) return false;
  const s2 = (a) => hz(toSimplified(a.join('')));
  const w = bestWindow(py(s2(t)), py(s2(q)));
  return !!w && w.dist <= Math.floor(q.length / 8);
}

// ---------------------------------------------------------------------------------------------------------------- LLM request
export function buildCompareMessages({ chunkText, transcript }) {
  const system = `You compare the MEANING of a Mandarin learner's free retelling (an automatic speech-recognition transcript) with a reference passage. Reply as JSON only.
1. ideas: split the reference into 2-6 key ideas, ONE per clause or action (each refQuote usually 4-12 characters, never more than 15; a passage with N clauses gives about N ideas, merge only tiny clauses when N > 6), so that a learner who skips one detail is caught. For each: id ("i1"...), refQuote (an EXACT contiguous substring COPIED from the reference that expresses the idea, at least 2 characters), covered (true = the transcript conveys it in ANY wording; "partial" = only partly; false = absent or contradicted), evidence (a short EXACT quote copied from the transcript when covered is true or "partial", else null), confidence ("high"|"medium"|"low").
Different wording, synonyms, reordering, extra words and small grammar slips are NOT errors: judge meaning only. The transcript may contain recognition errors: do not blame the learner for one garbled word. Never comment on pronunciation or tones.
2. corrections (0-2, only real problems): {"kind":"wrong_meaning","ideaId":"i2","quote":EXACT transcript quote that says something different from or contradicts the reference,"explanationZh":max 20 characters} or {"kind":"language","ideaId":string|null,"quote":EXACT transcript quote with a clear vocabulary/grammar mistake,"explanationZh":max 20 characters,"modelText":the corrected natural version, max 30 characters, saying ONLY what the reference says}. A missing idea needs NO correction entry. Use [] when there is nothing to correct.
3. summaryZh: ONLY when every idea is covered true: one short spoken sentence (max 25 characters), simple Mandarin, about meaning only. Otherwise "".
STYLE: HSK 3-4 Mandarin, no English/pinyin/markdown in Chinese strings.
JSON (keys in this order): {"ideas":[{"id":string,"refQuote":string,"covered":true|"partial"|false,"evidence":string|null,"confidence":string}],"corrections":[...],"summaryZh":string}`;
  const user = JSON.stringify({ reference: chunkText, transcript: String(transcript ?? '').slice(0, 600) });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---------------------------------------------------------------------------------------------------------------- strict schema
const isStr = (x) => typeof x === 'string';
const COVERED = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : v === 'partial' ? 'partial' : undefined);
/** Strict structural validation of the raw LLM object. Throws ServiceError('retell_schema') when unusable (=> retry once, then "unavailable"). */
export function parseCompare(raw) {
  const bad = (why) => new ServiceError('retell_schema', `comparison JSON rejected: ${why}`, { retryable: true });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
  if (!Array.isArray(raw.ideas) || raw.ideas.length < 1 || raw.ideas.length > MAX_IDEAS) throw bad('ideas must be an array of 1-8');
  const ideas = raw.ideas.map((x, i) => {
    if (!x || typeof x !== 'object') throw bad(`idea ${i} not an object`);
    const covered = COVERED(x.covered);
    if (!isStr(x.refQuote) || (x.textZh != null && !isStr(x.textZh)) || covered === undefined) throw bad(`idea ${i} missing refQuote/covered`);
    if (x.evidence != null && !isStr(x.evidence)) throw bad(`idea ${i} evidence type`);
    const confidence = ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : x.confidence == null ? 'medium' : (() => { throw bad(`idea ${i} confidence`); })();
    return { id: isStr(x.id) ? x.id : null, textZh: (x.textZh ?? x.refQuote).trim(), refQuote: x.refQuote.trim(), covered, evidence: x.evidence == null ? null : x.evidence.trim() || null, confidence };
  });
  const corrRaw = raw.corrections == null ? [] : raw.corrections;
  if (!Array.isArray(corrRaw)) throw bad('corrections must be an array');
  const corrections = corrRaw.slice(0, 4).map((c, i) => {
    if (!c || typeof c !== 'object' || !['missing_idea', 'wrong_meaning', 'language'].includes(c.kind)) return null; // unknown kinds are skipped, not fatal
    return { kind: c.kind, ideaId: isStr(c.ideaId) ? c.ideaId : null, quote: isStr(c.quote) ? c.quote.trim() : null, explanationZh: isStr(c.explanationZh) ? c.explanationZh.trim() : '', modelText: isStr(c.modelText) ? c.modelText.trim() : '' };
  }).filter(Boolean);
  if (raw.summaryZh != null && !isStr(raw.summaryZh)) throw bad('summaryZh type');
  return { ideas, corrections, summaryZh: raw.summaryZh ? raw.summaryZh.trim() : '' };
}

// ---------------------------------------------------------------------------------------------------------------- code validation
// Function/common characters that a paraphrased model sentence may add without introducing a new fact.
export const FUNCTION_CHARS = new Set(Array.from('的了是在有和也都就很把被让给对从到说我你他她它们这那个不没还又但而所以因为如果会能要想去来上下可以一二三四五六七八九十为什么怎么然先再最'));
/** A modelled sentence is accepted only when it adds (almost) nothing beyond the reference: at most 1 / 15% of its characters are new. */
export function isGrounded(modelText, chunkText) {
  const m = hz(modelText); if (m.length < 2 || m.length > 60 || NON_ZH.test(modelText) || TONE_CLAIM.test(modelText)) return false;
  const ref = new Set(hz(chunkText)); const novel = m.filter((c) => !ref.has(c) && !FUNCTION_CHARS.has(c)).length;
  return novel <= Math.max(1, Math.floor(m.length * 0.15));
}
export const cleanLine = (s, max = 40) => { const t = String(s ?? '').trim(); return t && t.length <= max && hz(t).length >= 2 && !NON_ZH.test(t) ? t : ''; };

/**
 * Turn the parsed LLM object into code-owned facts. Returns
 * { ideas:[{id,textZh,refStart,refEnd,covered,evidence,confidence,issue}], llmCorrections:[...validated wrong_meaning/language/model texts], summaryZh, dropped:[reason] }
 * or throws ServiceError('retell_unusable') when too little survives.
 */
export function validateCompare(parsed, { chunkText, transcript }) {
  const dropped = []; const kept = [];
  for (const raw of parsed.ideas) {
    const span = resolveSpan(chunkText, raw.refQuote);
    if (!span) { dropped.push('span_not_in_reference'); continue; }                // may be invented: never accuse the learner of missing it
    let { covered, evidence, confidence } = raw;
    const textZh = (cleanLine(raw.textZh, 30) && !TONE_CLAIM.test(raw.textZh)) ? raw.textZh : Array.from(chunkText).slice(span.start, span.end).join('');
    if (covered === false) evidence = null;                                          // nothing to quote when absent
    else if (!evidence || !quoteInTranscript(evidence, transcript)) {               // claimed coverage without verifiable evidence
      if (evidence) dropped.push('evidence_not_in_transcript');
      covered = 'partial'; evidence = null; confidence = 'low';
    }
    if (span.how === 'fuzzy' && confidence === 'high') confidence = 'medium';
    kept.push({ id: raw.id, textZh, refStart: span.start, refEnd: span.end, covered, evidence, confidence, issue: null, _oldId: raw.id });
  }
  // de-duplicate ideas that resolve to (almost) the same span: keep the first
  const ideas = [];
  for (const k of kept.sort((a, b) => a.refStart - b.refStart || b.refEnd - a.refEnd)) {
    const dup = ideas.find((x) => Math.min(x.refEnd, k.refEnd) - Math.max(x.refStart, k.refStart) > 0.7 * Math.min(x.refEnd - x.refStart, k.refEnd - k.refStart));
    if (dup) { dropped.push('duplicate_span'); continue; }
    ideas.push(k);
  }
  if (!ideas.length || dropped.filter((d) => d === 'span_not_in_reference').length > ideas.length) throw new ServiceError('retell_unusable', 'too few key ideas could be located in the reference', { retryable: true });
  const idMap = new Map(); ideas.forEach((x, i) => { idMap.set(x._oldId, `i${i + 1}`); x.id = `i${i + 1}`; delete x._oldId; });

  const llmCorrections = [];
  for (const c of parsed.corrections) {
    const ideaId = c.ideaId ? idMap.get(c.ideaId) ?? null : null;
    const idea = ideas.find((x) => x.id === ideaId);
    const model = c.modelText && isGrounded(c.modelText, chunkText) ? c.modelText : null;
    if (c.kind === 'missing_idea') { if (idea && idea.covered !== true && model) llmCorrections.push({ kind: c.kind, ideaId, modelText: model }); continue; }
    if (!c.quote || !quoteInTranscript(c.quote, transcript)) { dropped.push(`${c.kind}_quote_not_in_transcript`); continue; } // hallucinated quote
    if (c.kind === 'wrong_meaning') {
      if (!idea || idea.covered === true) { dropped.push('wrong_meaning_without_idea'); continue; }
      if (idea.covered === 'partial' && idea.confidence === 'low') { dropped.push('wrong_meaning_low_confidence'); continue; }
    }
    const fixed = c.kind === 'wrong_meaning' ? '这里的意思和原文不一样。' : '这个说法可以更自然一些。';
    let explanation = cleanLine(c.explanationZh, 40);
    if (!explanation || TONE_CLAIM.test(c.explanationZh) || PRAISE_RE.test(c.explanationZh)) explanation = fixed;   // rewritten, never passed through
    if (!model && c.kind === 'language') { dropped.push('language_without_grounded_model'); continue; }               // nothing safe to model
    llmCorrections.push({ kind: c.kind, ideaId, quote: c.quote.slice(0, 40), explanationZh: explanation, modelText: model, rewritten: explanation === fixed });
    if (c.kind === 'wrong_meaning' && idea) idea.issue = 'wrong_meaning';
  }
  let summaryZh = cleanLine(parsed.summaryZh, 40);
  if (summaryZh && (TONE_CLAIM.test(summaryZh))) { summaryZh = ''; dropped.push('summary_tone_claim'); }
  return { ideas, llmCorrections, summaryZh, dropped };
}

/** The LLM call: strict-validated, one retry on malformed/failed output, total wall-clock cap. Never throws: returns {status:'ok',...} | {status:'unavailable', reason}. */
export async function compareMeaning({ llm, chunkText, transcript, signal, model, timings = {}, maxMs = 9000, attempts = 2 }) {
  const t0 = Date.now();
  if (!llm?.available) return { status: 'unavailable', reason: 'llm_not_configured' };
  const ac = new AbortController(); const onAbort = () => ac.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), maxMs); timer.unref?.();
  let reason = 'comparison_failed';
  try {
    for (let i = 0; i < attempts; i++) {
      try {
        const raw = await llm.chatJson({ messages: buildCompareMessages({ chunkText, transcript }), signal: ac.signal, model, maxTokens: 700, temperature: 0, timeoutMs: Math.max(1500, maxMs - (Date.now() - t0)) });
        const v = validateCompare(parseCompare(raw), { chunkText, transcript });
        return { status: 'ok', attempts: i + 1, ...v };
      } catch (e) {
        reason = e.code === 'retell_schema' || e.code === 'llm_bad_json' ? 'malformed_output' : e.code === 'retell_unusable' ? 'unusable_output' : (e.code || 'comparison_failed');
        if (ac.signal.aborted || (e.retryable === false && e.code !== 'retell_schema')) break;
      }
    }
    return { status: 'unavailable', reason, attempts };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); timings.compareMs = Date.now() - t0; }
}

// ---------------------------------------------------------------------------------------------------------------- derived facts + coaching plan
const spanText = (chunkText, a) => Array.from(chunkText).slice(a.refStart, a.refEnd).join('');

/** suggestedWords: multi-character vocabulary inside the spans of ideas that were not fully covered and that the transcript does not contain. */
export function suggestWords(ideas, chunkText, transcript, meaningOf = () => null, max = 4) {
  const have = hanziOnly(transcript); const out = []; const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  for (const idea of ideas.filter((x) => x.covered !== true)) {
    const parts = Array.from(seg.segment(spanText(chunkText, idea)), (x) => x.segment);
    for (let k = 0; k < parts.length; k++) {
      let w = hanziOnly(parts[k]);
      // the segmenter splits suffix nouns (自行|车): glue a following common suffix character
      if (w.length >= 2 && k + 1 < parts.length && '车子机院者员店馆站部'.includes(parts[k + 1]) && parts[k + 1].length === 1) { w += parts[k + 1]; k++; }
      if (w.length < 2 || [...w].every((c) => FUNCTION_CHARS.has(c)) || have.includes(w) || out.some((o) => o.text === w)) continue;
      out.push({ text: w, pinyin: pinyinPro(w, { toneType: 'symbol', type: 'array' }).join(' '), meaning: meaningOf(w) ?? null, ideaId: idea.id });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Script words found by the reused-phrase word check (services/reuse.js) first (they are words the learner cannot say yet), then the vocabulary of uncovered ideas. */
export function wordSuggestions(findings, rest, meaningOf = () => null, owner = {}) {
  const out = [];
  for (const f of findings) if (!out.some((o) => o.text === f.text)) out.push({ text: f.text, pinyin: f.pinyin, meaning: meaningOf(f.text) ?? null, ...owner(f), reason: f.kind === 'missed' ? 'omitted' : 'substituted' });
  for (const w of rest) if (!out.some((o) => o.text === w.text)) out.push(w);
  return out;
}

/** The public `retell` block (everything derived by code). `cmp` is compareMeaning()'s result. `wordFindings` = reused-phrase word check results: they cap praise at 'soft'. */
export function buildRetellBlock({ cmp, chunkText, transcript, stt, tone, meaningOf, wordFindings = [] }) {
  const base = { transcript, sttStatus: stt?.status ?? 'ok', tone };
  const ideaOf = (f) => ({ ideaId: cmp.ideas?.find((x) => f.start >= x.refStart && f.start < x.refEnd)?.id ?? null });
  if (cmp.status !== 'ok') return { ...base, ideas: [], coveredCount: 0, totalCount: 0, canPraise: false, praiseLevel: 'none', comparisonStatus: 'unavailable', comparisonReason: cmp.reason, missingIdeaIds: [], suggestedWords: wordSuggestions(wordFindings, [], meaningOf, ideaOf), ...(wordFindings.length ? { praiseBlockedBy: ['word_check'] } : {}) };
  const ideas = cmp.ideas.map(({ id, textZh, refStart, refEnd, covered, evidence, confidence, issue }) => ({ id, textZh, refStart, refEnd, covered, evidence, confidence, ...(issue ? { issue } : {}) }));
  const coveredCount = ideas.filter((x) => x.covered === true).length;
  const missing = ideas.filter((x) => x.covered === false);
  const allTrue = coveredCount === ideas.length && ideas.every((x) => x.confidence !== 'low');
  const praiseLevel = allTrue && !wordFindings.length ? 'full' : missing.length ? 'none' : 'soft'; // partial / low-confidence / a substituted script word => soft at most
  return { ...base, ideas, coveredCount, totalCount: ideas.length, partialCount: ideas.filter((x) => x.covered === 'partial').length, canPraise: praiseLevel === 'full', praiseLevel,
    comparisonStatus: 'ok', missingIdeaIds: missing.map((x) => x.id), suggestedWords: wordSuggestions(wordFindings, suggestWords(cmp.ideas, chunkText, transcript, meaningOf), meaningOf, ideaOf),
    ...(wordFindings.length ? { praiseBlockedBy: allTrue ? ['word_check'] : [], wordCheck: { status: 'found', count: wordFindings.length } } : {}) };
}

/**
 * Build the spoken/written coaching units (ALL code, from validated facts). Returns { units:[{kind,text,correction?}], corrections:[...] }.
 * Order: opener (counts) -> meaning corrections (wrong_meaning / missing idea / language / partial; max 2 incl. tone) -> tone (only if slots remain) -> optional summary -> next.
 */
export function planRetellCoach({ retell, cmp, chunkText, toneFacts = [], toneRef = '', wordCorrections = [] }) {
  const units = []; const corrections = []; const say = (kind, text, correction) => units.push({ kind, text, ...(correction ? { correction } : {}) });
  if (retell.comparisonStatus !== 'ok') {
    say('opener', RT_UNAVAILABLE_ZH);
    for (const c of wordCorrections.slice(0, MAX_RETELL_CORRECTIONS)) { corrections.push(c); say('correction', c.explanationZh, c); say('correction_model', `应该这样说：${c.modelText}`, c); }
    for (const f of toneFacts.slice(0, Math.min(1, MAX_RETELL_CORRECTIONS - corrections.length))) { const c = toneCorrection(f, toneRef); corrections.push(c); say('correction', c.explanationZh, c); say('correction_model', `应该这样说：${c.modelText}`, c); }
    say('next', RT_UNAVAILABLE_NEXT_ZH);
    return { units, corrections };
  }
  const byId = new Map(cmp.ideas.map((x) => [x.id, x]));
  const cands = [];
  const modelFor = (idea, prefer) => (prefer && isGrounded(prefer, chunkText) ? prefer : spanText(chunkText, idea));
  for (const lc of cmp.llmCorrections.filter((x) => x.kind === 'wrong_meaning')) { const idea = byId.get(lc.ideaId); if (idea) cands.push(ideaCorrection('wrong_meaning', idea, chunkText, lc)); }
  const modelOf = (id) => cmp.llmCorrections.find((x) => x.kind === 'missing_idea' && x.ideaId === id)?.modelText;
  for (const idea of cmp.ideas.filter((x) => x.covered === false && x.issue !== 'wrong_meaning')) cands.push(ideaCorrection('missing_idea', idea, chunkText, { modelText: modelFor(idea, modelOf(idea.id)) }));
  for (const lc of cmp.llmCorrections.filter((x) => x.kind === 'language')) cands.push({ kind: 'language', targetText: lc.quote, explanationZh: lc.explanationZh, modelText: lc.modelText, factRef: lc.ideaId ? `idea:${lc.ideaId}` : null, source: lc.rewritten ? 'server_fact' : 'llm', ...(lc.ideaId ? { ideaId: lc.ideaId } : {}), heard: lc.quote });
  for (const idea of cmp.ideas.filter((x) => x.covered === 'partial' && x.confidence !== 'low')) cands.push(ideaCorrection('missing_idea', idea, chunkText, { modelText: modelFor(idea, modelOf(idea.id)) }, true));
  const seen = new Set(); const meaning = [];
  const words = wordCorrections.slice(0, MAX_RETELL_CORRECTIONS);   // a substituted/omitted SCRIPT word in a reused phrase ranks first
  for (const c of cands) { const key = c.ideaId ? `${c.ideaId}` : `q:${c.targetText}`; if (seen.has(key)) continue; seen.add(key); if (words.length + meaning.length < MAX_RETELL_CORRECTIONS) meaning.push(c); }
  const slots = MAX_RETELL_CORRECTIONS - words.length - meaning.length;
  const tones = toneFacts.slice(0, slots).map((f) => toneCorrection(f, toneRef));

  const missingN = retell.missingIdeaIds.length; const anyWrong = cmp.ideas.some((x) => x.issue === 'wrong_meaning');
  const hasTone = toneFacts.length > 0;
  if (retell.praiseLevel === 'full') { if (hasTone) say('opener', RT_ALL_TONE_ZH); else say('praise', RT_ALL_ZH); }
  else if (retell.praiseLevel === 'soft') say('opener', words.length ? RT_WORD_ZH : RT_SOFT_ZH);
  else say('opener', anyWrong && missingN === cmp.ideas.filter((x) => x.issue === 'wrong_meaning').length ? RT_WRONG_ZH : rtMissingOpener(missingN));
  for (const c of [...words, ...meaning, ...tones]) { corrections.push(c); say('correction', c.explanationZh, c); if (c.modelText) say('correction_model', `${['tone', 'substituted', 'missing'].includes(c.kind) ? '应该这样说' : '可以这样说'}：${c.modelText}`, c); }
  // the LLM's one-sentence summary is spoken only when everything is covered (validated: no tone talk, no negatives)
  if (retell.praiseLevel === 'full' && cmp.summaryZh && !/没|漏|错|不对|但|不过|可是/.test(cmp.summaryZh)) say('summary', cmp.summaryZh);
  say('next', retell.praiseLevel === 'full' ? RT_NEXT_OK_ZH : RT_NEXT_RETRY_ZH);
  return { units, corrections };
}

function ideaCorrection(kind, idea, chunkText, lc, partial = false) {
  const hedge = idea.confidence === 'low';
  const explanation = kind === 'wrong_meaning' ? (lc.explanationZh || '这里的意思和原文不一样。')
    : partial ? `这个意思只讲了一部分：${idea.textZh}` : hedge ? `好像没讲到这个意思：${idea.textZh}` : `漏掉了这个意思：${idea.textZh}`;
  return { kind, targetText: spanText(chunkText, idea), start: idea.refStart, end: idea.refEnd, ideaId: idea.id, caption: idea.textZh, explanationZh: explanation, modelText: lc.modelText || spanText(chunkText, idea),
    factRef: `idea:${idea.id}`, source: kind === 'wrong_meaning' && lc.explanationZh && !lc.rewritten ? 'llm' : 'server_fact',
    ...(kind === 'wrong_meaning' && lc.quote ? { heard: lc.quote } : {}), evidence: { source: 'transcript', confidence: idea.confidence } };
}
const TONE_NAMES = { 1: '第一声', 2: '第二声', 3: '第三声', 4: '第四声', 5: '轻声' };
export function toneCorrection(f, toneRef) {
  const modelText = Array.from(String(toneRef)).slice(Math.max(0, f.start - 1), f.end + 1).join(''); // the learner's own word(s) around the syllable
  const w = (n) => TONE_NAMES[n] || '轻声';
  return { kind: 'tone', targetText: f.char, start: f.start, end: f.end, pinyin: f.pinyin, modelText: modelText || f.char, factRef: f.ref, source: 'server_fact', evidence: { source: 'acoustic', confidence: 'low' },
    explanationZh: `按我听到的词，“${f.char}”应该读${w(f.expectedTone)}，我听到的是${w(f.heardTone)}。` };
}
