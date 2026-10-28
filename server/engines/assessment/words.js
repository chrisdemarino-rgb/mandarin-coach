// Word-level completeness analysis, computed by CODE only.
//
// Inputs : the exact chunkText the client sent, the policy-applied normalized assessment (acoustic evidence), and optionally an
//          STT transcript of the same take (NEVER given the script as a prompt) + the STT status.
// Outputs: wordStatus[] (one entry per reference character, code-point offsets into chunkText), plus facts
//          missingWords / substitutedWords / unclearWords / insertedText / stt / completeness.
//
// EVIDENCE MODEL (see test-results/VALIDATION.md "Omission thresholds" for the data):
//   acoustic  = word score < ACOUSTIC_MISSING_WORD_MAX or initial score < ACOUSTIC_INITIAL_ABSENT_MAX  (a *candidate* only)
//   stt       = Needleman-Wunsch alignment of the transcript to the reference at pinyin level says omitted / substituted
//   both      -> status missed|substituted, confidence high
//   stt only  -> status missed|substituted, confidence medium  (low if the transcript is unreliable: coverage < STT_MIN_COVERAGE)
//   acoustic only (STT agrees the word is there, or STT unavailable) -> status 'uncertain', reason low_score, confidence low
// The transcript is used ONLY for missing/substituted/inserted words. It is never used for tone/initial/final claims
// (gpt-4o-transcribe autocorrects mispronounced tones toward fluent text, so it cannot see tone errors).
import { pinyin as pinyinPro } from 'pinyin-pro';
import { ASSESSMENT_POLICY } from '../../config.js';

const HANZI = /[\u3400-\u9fff\uf900-\ufaff]/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DIGITS = '零一二三四五六七八九';

/** Reference characters (hanzi only) with code-point offsets into the exact string received. */
export function refChars(chunkText) {
  const out = []; let cp = 0;
  for (const ch of Array.from(String(chunkText ?? ''))) {
    if (HANZI.test(ch)) out.push({ ch, start: cp, end: cp + 1 });
    cp += 1;
  }
  return out;
}

const numToZh = (n) => {
  if (n < 10) return DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return `十${DIGITS[n - 10]}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
  return String(n).split('').map((d) => DIGITS[Number(d)]).join('');
};

/** Transcript -> array of hanzi characters. Drops punctuation/latin, maps digits to hanzi numerals (traditional/simplified handled at the pinyin level). */
export function normalizeTranscript(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/\d+/g, (d) => numToZh(Number(d)));
  return Array.from(t).filter((c) => HANZI.test(c));
}

// ---- pinyin helpers (toneless; ü->u so 'xue'/'xüe' agree)
const toneless = (chars) => {
  if (!chars.length) return [];
  const arr = pinyinPro(chars.join(''), { toneType: 'none', type: 'array' });
  return chars.map((c, i) => (arr[i] && arr[i] !== c ? String(arr[i]) : c).replace(/ü/g, 'u'));
};
const INIT = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
const split = (py) => { const i = INIT.find((x) => py.startsWith(x)); return i ? [i, py.slice(i.length)] : ['', py]; };
const INIT_CONFUSABLE = [['z', 'zh'], ['c', 'ch'], ['s', 'sh'], ['n', 'l']];
const FINAL_CONFUSABLE = [['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['ian', 'iang'], ['uan', 'uang']];
const inPair = (pairs, a, b) => pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

/** 3 identical char, 2.5 same toneless pinyin, 1.2 near-homophone (z/zh, an/ang ... : counts as heard), else -2. */
export function pairScore(refCh, refPy, sttCh, sttPy) {
  if (refCh === sttCh) return 3;
  if (refPy === sttPy) return 2.5;
  const [ri, rf] = split(refPy); const [si, sf] = split(sttPy);
  if ((ri === si && inPair(FINAL_CONFUSABLE, rf, sf)) || (rf === sf && inPair(INIT_CONFUSABLE, ri, si))) return 1.2;
  return -2;
}

/** Needleman-Wunsch. Returns per-reference ops [{op:'match'|'sub'|'del', heard?}] and inserted runs [{afterRef, text}]. */
export function alignTranscript(refList, sttChars) {
  const refPy = toneless(refList); const sttPy = toneless(sttChars);
  const n = refList.length; const m = sttChars.length; const GAP = -1.5;
  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const T = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up(del), 3 left(ins)
  for (let i = 1; i <= n; i++) { H[i][0] = i * GAP; T[i][0] = 2; }
  for (let j = 1; j <= m; j++) { H[0][j] = j * GAP; T[0][j] = 3; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const d = H[i - 1][j - 1] + pairScore(refList[i - 1], refPy[i - 1], sttChars[j - 1], sttPy[j - 1]);
    const u = H[i - 1][j] + GAP; const l = H[i][j - 1] + GAP;
    const best = Math.max(d, u, l); H[i][j] = best;
    T[i][j] = best === d ? 1 : best === u ? 2 : 3; // ties prefer diagonal (substitution) over gaps
  }
  const ops = new Array(n); const ins = []; let i = n; let j = m;
  while (i > 0 || j > 0) {
    const t = T[i][j];
    if (t === 1) {
      const s = pairScore(refList[i - 1], refPy[i - 1], sttChars[j - 1], sttPy[j - 1]);
      ops[i - 1] = s > 0 ? { op: 'match', heard: sttChars[j - 1] } : { op: 'sub', heard: sttChars[j - 1] };
      i--; j--;
    } else if (t === 2) { ops[i - 1] = { op: 'del' }; i--; }
    else { ins.push({ afterRef: i - 1, ch: sttChars[j - 1] }); j--; }
  }
  const runs = [];
  for (const x of ins.reverse()) {
    const last = runs[runs.length - 1];
    if (last && last.afterRef === x.afterRef) last.text += x.ch; else runs.push({ afterRef: x.afterRef, text: x.ch });
  }
  const matched = ops.filter((o) => o.op === 'match').length;
  return { ops, inserted: runs, coverage: n ? matched / n : 0 };
}

/** Intl.Segmenter words as code-point ranges. */
export function segmentWords(chunkText) {
  const out = []; let cp = 0;
  try {
    for (const s of new Intl.Segmenter('zh', { granularity: 'word' }).segment(String(chunkText))) {
      const len = Array.from(s.segment).length;
      if (HANZI.test(s.segment)) out.push({ text: Array.from(s.segment).filter((c) => HANZI.test(c)).join(''), start: cp, end: cp + len, raw: s.segment });
      cp += len;
    }
  } catch { /* no ICU: char-level fallback below */ }
  if (!out.length) for (const c of refChars(chunkText)) out.push({ text: c.ch, start: c.start, end: c.end, raw: c.ch });
  return out;
}

const markPinyin = (text) => { try { return pinyinPro(text, { type: 'array' }).join(' ').trim(); } catch { return ''; } };
const CONF_RANK = { low: 0, medium: 1, high: 2 };

/**
 * @param {object} p
 * @param {string} p.chunkText    exactly as received from the client
 * @param {object} p.assessment   policy-applied normalized assessment (status ok)
 * @param {string|null} p.transcript  STT transcript or null
 * @param {{status:'ok'|'unavailable'|'timeout'|'failed'|'not_run', reason?:string, ms?:number}} p.stt
 */
export function analyzeWords({ chunkText, assessment, transcript = null, stt = { status: 'not_run' }, policy = ASSESSMENT_POLICY }) {
  const P = policy;
  const refs = refChars(chunkText);
  const gated = assessment?.gate === 'low_match';
  const syl = assessment?.syllables || []; const words = assessment?.words || [];
  const acousticAligned = !gated && syl.length === refs.length && words.length === refs.length;
  const sttOk = stt.status === 'ok' && typeof transcript === 'string';

  // ---- STT alignment
  let ali = null; let sttNote = null;
  if (sttOk) {
    const chars = normalizeTranscript(transcript);
    ali = alignTranscript(refs.map((r) => r.ch), chars);
    if (!chars.length) sttNote = 'transcript contained no Mandarin characters';
  }
  const coverage = ali ? ali.coverage : null;
  const sttReliable = !!ali && coverage >= P.STT_MIN_COVERAGE;
  const sttInfo = { status: stt.status, ...(stt.ms != null ? { ms: stt.ms } : {}), ...(stt.reason ? { reason: stt.reason } : {}),
    ...(coverage != null ? { coverage: Math.round(coverage * 100) / 100, reliable: sttReliable } : {}), ...(sttNote ? { note: sttNote } : {}) };

  const py = (() => { const a = pinyinPro(String(chunkText), { type: 'array' }); return Array.from(String(chunkText)).length === a.length ? a : null; })();
  const charPy = (r) => (py ? py[r.start] : markPinyin(r.ch)) || r.ch;

  const entries = refs.map((r, i) => {
    const e = { start: r.start, end: r.end, text: r.ch, pinyin: charPy(r), status: 'ok' };
    if (gated) return e;
    // acoustic candidate
    const ac = [];
    if (acousticAligned) {
      const w = words[i]; const ini = syl[i]?.initial;
      // a null/absent score is "unknown", never "low" (unknown must not become evidence)
      if (isNum(w?.score) && w.score < P.ACOUSTIC_MISSING_WORD_MAX) ac.push(`word score ${w.score} < ${P.ACOUSTIC_MISSING_WORD_MAX}`);
      if (ini?.expected && isNum(ini.score) && ini.score < P.ACOUSTIC_INITIAL_ABSENT_MAX) ac.push(`initial score ${ini.score} < ${P.ACOUSTIC_INITIAL_ABSENT_MAX}`);
    }
    const acoustic = ac.length > 0;
    if (ac.some((x) => x.startsWith('word score'))) Object.defineProperty(e, 'lowScore', { value: true, enumerable: false }); // survives a later status upgrade (e.g. to a confirmed tone error)
    const op = sttReliable ? ali.ops[i] : null; // an unreliable transcript is ignored for word status (facts.stt.reliable=false says so)
    if (op?.op === 'del') {
      Object.assign(e, { status: 'missed', reason: 'omitted', source: acoustic ? 'both' : 'stt', confidence: acoustic ? 'high' : 'medium',
        detail: acoustic ? `not found in the transcript; ${ac.join('; ')}` : 'not found in the transcript' });
    } else if (op?.op === 'sub') {
      Object.assign(e, { status: 'substituted', reason: 'omitted', heard: op.heard, source: acoustic ? 'both' : 'stt', confidence: acoustic ? 'high' : 'medium',
        detail: acoustic ? `transcript has a different word here; ${ac.join('; ')}` : 'transcript has a different word here' });
      delete e.reason;
    } else if (acoustic) {
      Object.assign(e, { status: 'uncertain', reason: 'low_score', source: 'acoustic', confidence: 'low',
        detail: `${ac.join('; ')}${sttReliable ? '; the transcript does contain it' : sttOk ? '; transcript unreliable, not used' : stt.status !== 'not_run' ? '; transcript unavailable' : ''}` });
    }
    return e;
  });

  // ---- tone / sound flags on syllables that were NOT missed/substituted (policy-surviving only)
  if (!gated && acousticAligned) {
    entries.forEach((e, i) => {
      if (e.status === 'missed' || e.status === 'substituted') return;
      const s = syl[i];
      if (s.tone?.decision === 'review') {
        const prior = e.status === 'uncertain' && e.reason === 'low_score' ? `${e.detail}; ` : '';
        Object.assign(e, { status: 'wrong', reason: 'tone', source: 'acoustic', confidence: 'medium', detail: `${prior}expected tone ${s.tone.expected}, heard tone ${s.tone.heard}` });
      } else if (e.status === 'ok') {
        const dim = ['tone', 'initial', 'final'].find((d) => s[d]?.decision === 'uncertain');
        if (dim) Object.assign(e, { status: 'uncertain', reason: dim, source: 'acoustic', confidence: 'low', detail: `${dim} evidence too weak to claim` });
      }
    });
  }

  // ---- facts (grouped by script word, so the coach can name "the word")
  const segs = segmentWords(chunkText);
  const segOf = (e) => segs.find((s) => e.start >= s.start && e.start < s.end) || { text: e.text, start: e.start, end: e.end };
  const group = (pred, build) => {
    const map = new Map();
    for (const e of entries.filter(pred)) { const s = segOf(e); const k = `${s.start}:${s.end}`; if (!map.has(k)) map.set(k, { s, es: [] }); map.get(k).es.push(e); }
    return [...map.values()].map(({ s, es }, n) => build(s, es, n));
  };
  const best = (es) => es.reduce((a, b) => (CONF_RANK[b.confidence] > CONF_RANK[a.confidence] ? b : a));
  const wordPy = (s) => markPinyin(s.text);
  const scoreOf = (es) => { const v = es.map((e) => words[refs.findIndex((r) => r.start === e.start)]?.score).filter(isNum); return v.length ? Math.min(...v) : null; };
  const base = (s, es) => ({ score: acousticAligned ? scoreOf(es) : null, text: s.text, pinyin: wordPy(s), start: s.start, end: s.end, chars: es.map((e) => ({ start: e.start, end: e.end, text: e.text })), source: best(es).source, confidence: best(es).confidence });
  const missingWords = group((e) => e.status === 'missed', (s, es, n) => ({ ref: `missing:${n}`, ...base(s, es), missedText: es.map((e) => e.text).join('') }));
  const substitutedWords = group((e) => e.status === 'substituted', (s, es, n) => ({ ref: `sub:${n}`, ...base(s, es), heard: es.map((e) => e.heard).join('') }));
  const unclearWords = group((e) => e.lowScore && e.status !== 'missed' && e.status !== 'substituted', (s, es, n) => ({ ref: `unclear:${n}`, ...base(s, es) }));
  const insertedText = (ali?.inserted || []).filter((x) => sttReliable).map((x) => ({ text: x.text, afterOffset: x.afterRef >= 0 && refs[x.afterRef] ? refs[x.afterRef].end : 0 }));

  // tone claims are meaningless on a syllable the speaker skipped or replaced
  const dropped = new Set(entries.filter((e) => e.status === 'missed' || e.status === 'substituted').map((e) => e.start));
  const confirmedToneErrors = (assessment?.syllables || []).filter((s) => !gated && s.tone?.decision === 'review' && !dropped.has(refs[s.index]?.start))
    .map((s) => ({ ref: `tone:${s.index}`, index: s.index, char: s.char, pinyin: s.pinyin, expectedTone: s.tone.expected, heardTone: s.tone.heard, score: s.tone.score, start: refs[s.index]?.start, end: refs[s.index]?.end }));

  // long pauses: block plain praise, never flag a word
  const notableGaps = [];
  if (acousticAligned) for (let i = 1; i < syl.length; i++) {
    const gap = (syl[i].startMs ?? 0) - (syl[i - 1].endMs ?? 0);
    if (isNum(gap) && gap > P.LONG_PAUSE_MS) notableGaps.push({ afterStart: refs[i - 1].start, ms: Math.round(gap) });
  }

  const hasIssue = missingWords.length + substitutedWords.length > 0;
  const incomplete = hasIssue || unclearWords.length > 0 || notableGaps.length > 0;
  const completeness = gated ? 'unknown' : incomplete ? 'incomplete' : sttReliable ? 'verified' : 'unverified';
  const facts = { missingWords, substitutedWords, unclearWords, insertedText, notableGaps, stt: sttInfo, completeness,
    canPraise: !gated && !incomplete };
  return { wordStatus: gated ? [] : entries, facts, confirmedToneErrors, hasIssue };
}

/** Facts for modes without a script to diff against (retell): no word claims, nothing withheld. */
export const emptyWordFacts = () => ({ missingWords: [], substitutedWords: [], unclearWords: [], insertedText: [], notableGaps: [], completeness: 'unknown', canPraise: true });
