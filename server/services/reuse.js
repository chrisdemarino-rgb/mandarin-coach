// Reused-phrase WORD CHECK (retell + Q&A). Computed by CODE only (no LLM), from the STT transcript and the script text.
//
// WHY: the meaning check lets the learner use their own words, so "一种不太好的谩骂的天赋" was accepted for the script phrase
// "一种不太好驾驭的天赋" although 驾驭 was replaced by a wrong word. Rule: when the transcript REUSES a script phrase almost verbatim, any
// substituted / omitted script CONTENT word inside that phrase is a word problem and may never yield an all-clear.
// Paraphrases (a different wording that shares little with the script) are NOT errors and are never flagged.
//
// ALGORITHM
//   1. Both texts -> hanzi only (transcript: simplified; punctuation only marks clause boundaries). Pinyin (toneless) agreement counts as a match
//      (STT noise; 'z/zh', 'an/ang' near-homophones too): reuses engines/assessment/words.js pairScore.
//   2. Smith-Waterman LOCAL alignment (match +3 / homophone +2.5 / near-homophone +1.2 / mismatch -2 / gap -2) finds the stretch of the
//      transcript that best reproduces the script unit (up to 3 passes, aligned parts masked).
//   3. The region is "near-verbatim reuse" only if ALL hold (ASSESSMENT_POLICY.REUSE_*): longest verbatim run >= REUSE_MIN_RUN, matched chars >=
//      REUSE_MIN_MATCHED and matched / max(script span, heard content chars) >= REUSE_MIN_RATIO.
//   4. Inside the region, every gap between two matching anchors is classified (function chars/particles/pronouns ignored on both sides):
//        script content + heard content  -> substituted (heard = what STT wrote)  needs verbatim runs >= REUSE_FLANK_MIN on BOTH sides; high when the heard
//                                           word shares no character with the script word and is about as long, else medium
//        script content, nothing heard    -> missed (omitted), same flank rule     medium (STT drops words); only when the WHOLE script word is
//                                           absent (学习 -> 学 and 自行车 -> 车 are shortened wordings, not omissions)
//        nothing in the script, content heard -> inserted (information only, never blocks praise: extra words are wording)
//      A gap longer than REUSE_MAX_BLOCK script characters is a rewrite, not a word slip: not flagged. Flagged blocks grow to whole script words.
//   5. Edge extension (script word right before/after the region, <= REUSE_EDGE_MAX_BLOCK chars, with a strong anchor next to it): only a
//      SUBSTITUTION by content words of the same clause is reported (medium). Edge omissions are not flagged (dropping a lead-in is a paraphrase).
import { pinyin as pinyinPro } from 'pinyin-pro';
import { ASSESSMENT_POLICY } from '../config.js';
import { pairScore, toneless, segmentWords } from '../engines/assessment/words.js';
import { toSimplified } from './retell.js';

const HZ = /[\u3400-\u9fff\uf900-\ufaff]/;
const REUSE_EDGE_MAX_BLOCK = 3;
/** Particles, adverbs of degree and pronouns: differences that are only these are wording, not word errors. (Negations 不/没 are CONTENT.) */
export const DIFF_FUNCTION_CHARS = new Set(Array.from('的了就也都还又和而着过吗呢吧啊嘛呀么地得之才很我你他她它们这那'));
const isFn = (c) => DIFF_FUNCTION_CHARS.has(c);
const GAP = -2;

const refTokens = (text) => { const out = []; let cp = 0; for (const ch of Array.from(String(text ?? ''))) { if (HZ.test(ch)) out.push({ ch, cp }); cp += 1; } return out; };
const sttTokens = (text) => {
  const out = []; let clause = 0; let inGap = false;
  for (const ch of Array.from(toSimplified(String(text ?? '')).normalize('NFKC'))) { if (HZ.test(ch)) { out.push({ ch, clause }); inGap = false; } else if (!inGap) { clause++; inGap = true; } }
  return out;
};

function localAlign(R, S, rPy, sPy, usedR, usedS) {
  const n = R.length; const m = S.length;
  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1)); const T = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  let best = 0; let bi = 0; let bj = 0;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    if (usedR[i - 1] || usedS[j - 1]) continue;
    const d = H[i - 1][j - 1] + pairScore(R[i - 1].ch, rPy[i - 1], S[j - 1].ch, sPy[j - 1]); const u = H[i - 1][j] + GAP; const l = H[i][j - 1] + GAP;
    const v = Math.max(0, d, u, l); H[i][j] = v; T[i][j] = v === 0 ? 0 : v === d ? 1 : v === u ? 2 : 3;
    if (v > best) { best = v; bi = i; bj = j; }
  }
  if (best <= 0) return null;
  const ops = []; let i = bi; let j = bj;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    const t = T[i][j];
    if (t === 1) { ops.push({ r: i - 1, s: j - 1, m: pairScore(R[i - 1].ch, rPy[i - 1], S[j - 1].ch, sPy[j - 1]) > 0 }); i--; j--; }
    else if (t === 2) { ops.push({ r: i - 1, s: null, m: false }); i--; } else if (t === 3) { ops.push({ r: null, s: j - 1, m: false }); j--; } else break;
  }
  return ops.reverse();
}

/**
 * Word findings for ONE script unit against the transcript. -> { findings:[{kind:'substituted'|'missed', start, end, text, missedText?, heard?, confidence, detail, how}],
 *   inserted:[text], regions:[{...metrics}] }   (start/end = code-point offsets into `refText`)
 */
export function reuseWordDiff(refText, transcript, P = ASSESSMENT_POLICY) {
  const R = refTokens(refText); const S = sttTokens(transcript);
  const out = { findings: [], inserted: [], regions: [] };
  if (R.length < P.REUSE_MIN_MATCHED || S.length < P.REUSE_MIN_MATCHED) return out;
  const rPy = toneless(R.map((x) => x.ch)); const sPy = toneless(S.map((x) => x.ch));
  const usedR = new Array(R.length).fill(false); const usedS = new Array(S.length).fill(false);
  const segs = segmentWords(refText);
  const cpEnd = (i) => R[i].cp + 1;
  let rToS = new Map();                                    // script index -> transcript index for the ops of the current alignment pass
  const wordsOf = (a, b) => { // expand [R index a..b] to whole script words
    let s = R[a].cp; let e = cpEnd(b);
    for (const g of segs) if (g.start < e && g.end > s) { s = Math.min(s, g.start); e = Math.max(e, g.end); }
    const idx = R.map((x, i) => i).filter((i) => R[i].cp >= s && R[i].cp < e);
    return { start: s, end: e, text: idx.map((i) => R[i].ch).join(''), idx };
  };
  const addGap = (rIdx, sIdx, prevRun, nextRun, edge = false) => {
    const Rc = rIdx.filter((i) => !isFn(R[i].ch)); const Sc = sIdx.filter((j) => !isFn(S[j].ch));
    if (!Rc.length) { if (Sc.length && !edge && prevRun >= P.REUSE_FLANK_MIN && nextRun >= P.REUSE_FLANK_MIN) out.inserted.push(sIdx.map((j) => S[j].ch).join('')); return; }
    // a word slip sits BETWEEN verbatim words (both flanking runs >= REUSE_FLANK_MIN); the differing script block is contiguous (no sentence punctuation inside)
    // and the heard block lies in ONE transcript clause. Anything else is wording/reordering, not a word error.
    if (!edge && (prevRun < P.REUSE_FLANK_MIN || nextRun < P.REUSE_FLANK_MIN)) return;
    if (rIdx.some((i, k) => k > 0 && R[i].cp !== R[rIdx[k - 1]].cp + 1)) return;
    if (new Set(sIdx.map((j) => S[j].clause)).size > 1) return;
    if (rIdx.length > P.REUSE_MAX_BLOCK || (edge && Rc.length > REUSE_EDGE_MAX_BLOCK)) return;      // a rewrite, not a word slip
    if (edge && !Sc.length) return;                                                                // edge omission = paraphrase
    const w = wordsOf(Math.min(...Rc), Math.max(...Rc)); if (w.text.length > P.REUSE_MAX_BLOCK + 2) return;
    if (!Sc.length) {
      const omitted = Rc.map((i) => R[i].ch).join('');
      if (w.idx.some((i) => !rIdx.includes(i) && !isFn(R[i].ch))) return;   // only part of the word is missing (学习 -> 学, 自行车 -> 车): a shortened wording, not a missing word
      out.findings.push({ kind: 'missed', start: w.start, end: w.end, text: w.text, ...(omitted !== w.text ? { missedText: omitted } : {}), confidence: 'medium', how: 'omitted_in_reused_phrase',
        detail: 'a script word inside a phrase the transcript reuses almost verbatim is not in the transcript' });
      return;
    }
    // heard = the whole word STT wrote: the differing chars plus any chars of it that matched the script word (驾驭 vs 驾驶 -> heard 驾驶, not 驶)
    const partial = w.idx.filter((i) => !rIdx.includes(i) && !isFn(R[i].ch) && rToS.has(i)).map((i) => rToS.get(i));
    const hs = [...Sc, ...partial]; const heard = S.slice(Math.min(...hs), Math.max(...hs) + 1).map((x) => x.ch).join('').slice(0, 8);
    const shares = partial.length > 0 || Sc.some((j) => w.idx.some((i) => R[i].ch === S[j].ch));
    if (edge && (shares || Sc.length > Rc.length)) return;     // at the edge of the reused region only a clean same-size replacement counts (半小时 -> 三十分钟, 搬到 -> 搬去 are wording)
    const high = !edge && partial.length === 0 && !Sc.some((j) => w.idx.some((i) => R[i].ch === S[j].ch)) && Sc.length <= Rc.length + 1;   // 起床 -> 起来 / 驾驭 -> 驾驶 share a char: a variant, hedge it
    out.findings.push({ kind: 'substituted', start: w.start, end: w.end, text: w.text, heard, confidence: high ? 'high' : 'medium', how: 'substituted_in_reused_phrase',
      detail: `a script word inside a phrase the transcript reuses almost verbatim is replaced by a different word (matching runs ${prevRun}/${nextRun})` });
  };

  for (let pass = 0; pass < 3; pass++) {
    const ops = localAlign(R, S, rPy, sPy, usedR, usedS); if (!ops) break;
    rToS = new Map(ops.filter((o) => o.m).map((o) => [o.r, o.s]));
    const matched = ops.filter((o) => o.m).length;
    let run = 0; let longest = 0; for (const o of ops) { run = o.m ? run + 1 : 0; longest = Math.max(longest, run); }
    const rIdxAll = ops.filter((o) => o.r !== null).map((o) => o.r); const sIdxAll = ops.filter((o) => o.s !== null).map((o) => o.s);
    const rMin = Math.min(...rIdxAll); const rMax = Math.max(...rIdxAll); const sMin = Math.min(...sIdxAll); const sMax = Math.max(...sIdxAll);
    const heardContent = ops.filter((o) => o.s !== null && !o.m && !isFn(S[o.s].ch)).length;
    const ratio = matched / Math.max(rMax - rMin + 1, matched + heardContent);
    const region = { refStart: R[rMin].cp, refEnd: cpEnd(rMax), matched, longestRun: longest, ratio: Math.round(ratio * 100) / 100 };
    const reuse = longest >= P.REUSE_MIN_RUN && matched >= P.REUSE_MIN_MATCHED && ratio >= P.REUSE_MIN_RATIO;
    out.regions.push({ ...region, reuse });
    if (!reuse) break;
    for (let i = rMin; i <= rMax; i++) usedR[i] = true; for (let j = sMin; j <= sMax; j++) usedS[j] = true;

    // gaps between matching anchors (ops start and end with a match)
    const segsOps = []; for (const o of ops) { const last = segsOps[segsOps.length - 1]; if (last && last.m === o.m) last.ops.push(o); else segsOps.push({ m: o.m, ops: [o] }); }
    segsOps.forEach((g, k) => {
      if (g.m || !segsOps[k - 1] || !segsOps[k + 1]) return;
      addGap(g.ops.filter((o) => o.r !== null).map((o) => o.r), g.ops.filter((o) => o.s !== null).map((o) => o.s), segsOps[k - 1].ops.length, segsOps[k + 1].ops.length);
    });
    // edge extension: a short script word right before / after the region, substituted by content words of the same clause
    const firstRunLen = segsOps[0].ops.length; const lastRunLen = segsOps[segsOps.length - 1].ops.length;
    const leadIdx = []; for (let i = 0; i < rMin; i++) leadIdx.push(i); const tailIdx = []; for (let i = rMax + 1; i < R.length; i++) tailIdx.push(i);
    if (leadIdx.length && leadIdx.length <= REUSE_EDGE_MAX_BLOCK + 2 && firstRunLen >= P.REUSE_FLANK_MIN) {
      const clause = S[sMin].clause; const win = []; for (let j = sMin - 1; j >= 0 && win.length < leadIdx.length + 1 && S[j].clause === clause && !usedS[j]; j--) win.unshift(j);
      addGap(leadIdx, win, 0, firstRunLen, true);
    }
    if (tailIdx.length && tailIdx.length <= REUSE_EDGE_MAX_BLOCK + 2 && lastRunLen >= P.REUSE_FLANK_MIN) {
      const clause = S[sMax].clause; const win = []; for (let j = sMax + 1; j < S.length && win.length < tailIdx.length + 1 && S[j].clause === clause && !usedS[j]; j++) win.push(j);
      addGap(tailIdx, win, lastRunLen, 0, true);
    }
  }
  // a script word that IS in the transcript verbatim (repeated / reordered wording) is never a slip
  const sText = S.map((x) => x.ch).join('');
  const seen = new Set(); out.findings = out.findings.filter((f) => !sText.includes(f.text) && (seen.has(f.start) ? false : seen.add(f.start)));
  return out;
}

const RANK = { high: 2, medium: 1, low: 0 };
const py = (t) => { try { return pinyinPro(t, { type: 'array' }).join(' ').trim(); } catch { return ''; } };

/**
 * Word findings over several script units (retell: the chunk; Q&A: every key point of the question). `units`: [{ text, base?, chunkIndex?, keyPointId? }]
 * where `base` is the code-point offset of unit.text inside the full chunk text. -> [{ ref, kind, text, pinyin, start, end, heard?, missedText?, confidence, source:'stt',
 *   detail, chunkIndex?, keyPointId? }] (high first, then position; at most REUSE_MAX_FINDINGS) plus `inserted`.
 */
export function reuseFindings({ units, transcript, policy = ASSESSMENT_POLICY }) {
  const all = []; const inserted = []; const regions = [];
  for (const u of units) {
    const d = reuseWordDiff(u.text, transcript, policy);
    for (const f of d.findings) all.push({ ...f, start: f.start + (u.base ?? 0), end: f.end + (u.base ?? 0), ...(u.chunkIndex !== undefined ? { chunkIndex: u.chunkIndex } : {}), ...(u.keyPointId ? { keyPointId: u.keyPointId } : {}) });
    inserted.push(...d.inserted); regions.push(...d.regions.map((r) => ({ ...r, ...(u.keyPointId ? { keyPointId: u.keyPointId } : {}) })));
  }
  const seen = new Set();
  const findings = all.filter((f) => { const k = `${f.chunkIndex ?? ''}:${f.start}:${f.end}`; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0) || a.start - b.start).slice(0, policy.REUSE_MAX_FINDINGS)
    .map((f, n) => ({ ref: `reuse:${n}`, ...f, pinyin: py(f.text), source: 'stt' }));
  return { findings, inserted: [...new Set(inserted)].slice(0, 4), regions };
}

// ---- shapes shared with close mode (wordStatus entries, facts.missingWords / substitutedWords) so the existing consumers keep working
/** wordStatus entries: ONE per flagged script word (close mode lists one per character), status 'substituted' | 'missed', offsets are code points into the chunk text. */
export const reuseWordStatus = (findings) => findings.map((f) => ({ start: f.start, end: f.end, text: f.text, pinyin: f.pinyin, status: f.kind === 'missed' ? 'missed' : 'substituted',
  ...(f.kind === 'missed' ? { reason: 'omitted' } : { heard: f.heard }), source: 'stt', confidence: f.confidence, detail: f.detail, reuse: true,
  ...(f.chunkIndex !== undefined ? { chunkIndex: f.chunkIndex } : {}), ...(f.keyPointId ? { keyPointId: f.keyPointId } : {}) }));
export const reuseFacts = (findings) => {
  const mk = (f) => ({ ref: f.ref, score: null, text: f.text, pinyin: f.pinyin, start: f.start, end: f.end, chars: [], source: 'stt', confidence: f.confidence,
    ...(f.kind === 'missed' ? { missedText: f.missedText ?? f.text } : { heard: f.heard }), ...(f.chunkIndex !== undefined ? { chunkIndex: f.chunkIndex } : {}), ...(f.keyPointId ? { keyPointId: f.keyPointId } : {}) });
  return { missingWords: findings.filter((f) => f.kind === 'missed').map(mk), substitutedWords: findings.filter((f) => f.kind === 'substituted').map(mk) };
};

/** Code-built corrections (fixed phrases, grounded only in the diff facts). `modelOf(f)` = the text to model aloud (the script word, with a neighbour when it is a single character). */
export function reuseCorrections(findings, { meaningOf = () => null, modelOf = (f) => f.text } = {}) {
  return findings.map((f) => {
    const hedge = f.confidence !== 'high';
    const explanationZh = f.kind === 'missed'
      ? (f.missedText && f.missedText !== f.text ? `${hedge ? '好像' : ''}“${f.text}”这个词里漏掉了“${f.missedText}”。` : `${hedge ? '好像' : ''}漏掉了“${f.text}”这个词。`)
      : (hedge ? `我好像听到的是“${f.heard}”，原文是“${f.text}”。` : `你说的是“${f.heard}”，原文是“${f.text}”。`);
    const meaning = meaningOf(f.text);
    return { kind: f.kind === 'missed' ? 'missing' : 'substituted', targetText: f.text, start: f.start, end: f.end, pinyin: f.pinyin, meaning: meaning ?? null, factRef: f.ref, source: 'server_fact',
      evidence: { source: 'stt', confidence: f.confidence }, caption: `${f.text} ${f.pinyin}${meaning ? ` — ${meaning}` : ''}`, modelText: modelOf(f), explanationZh,
      ...(f.heard ? { heard: f.heard } : {}), ...(f.chunkIndex !== undefined ? { chunkIndex: f.chunkIndex } : {}), ...(f.keyPointId ? { keyPointId: f.keyPointId } : {}) };
  });
}
