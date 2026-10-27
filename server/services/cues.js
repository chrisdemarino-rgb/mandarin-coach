// Fading cues. Level 1 keywords+pinyin, 2 first character of each clause, 3 one-word topic hint, 4 nothing.
// Levels 1, 2, 4 are rule-based (instant, no LLM). Level 3 asks the LLM for one hint word (rule fallback).
import { pinyin as pinyinPro } from 'pinyin-pro';
import { hanzi } from './coach.js';

const STOP = new Set([...'的了是在和也都就我你他她它们吗呢吧啊嘛这那有个一不很把被让给对']);
const seg = new Intl.Segmenter('zh', { granularity: 'word' });
const py = (t) => pinyinPro(t, { toneType: 'symbol', type: 'array' }).join('');

function words(chunk) {
  return [...seg.segment(chunk)].filter((s) => s.isWordLike && hanzi(s.segment)).map((s) => hanzi(s.segment));
}

export function keywordItems(chunk, max = 4) {
  const ws = words(chunk);
  let kw = ws.filter((w) => [...w].length >= 2 && ![...w].every((c) => STOP.has(c)));
  if (!kw.length) kw = ws.filter((w) => ![...w].every((c) => STOP.has(c))).sort((a, b) => b.length - a.length).slice(0, 2);
  if (kw.length > max) { // keep the longest `max`, in original order
    const keep = new Set([...kw].sort((a, b) => b.length - a.length).slice(0, max));
    kw = kw.filter((w) => keep.has(w));
  }
  return kw.map((w) => ({ text: w, pinyin: py(w) }));
}

export function clauseStarts(chunk) {
  return chunk.split(/[，,。！？!?；;：:、\n]+/).map((c) => hanzi(c)[0]).filter(Boolean);
}

export function createCues({ llm }) {
  const cache = new Map();
  const remember = (k, v) => { cache.set(k, v); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; };

  return async function makeCue({ chunkText, level, signal }) {
    const k = `${level}|${chunkText}`;
    if (cache.has(k)) return cache.get(k);
    if (level === 4) return remember(k, { level, cue: '', source: 'rule' });
    if (level === 2) return remember(k, { level, cue: clauseStarts(chunkText).map((c) => `${c}…`).join(' '), source: 'rule' });
    if (level === 1) {
      const items = keywordItems(chunkText);
      return remember(k, { level, cue: items.map((i) => `${i.text} ${i.pinyin}`).join(' · '), items, source: 'rule' });
    }
    // level 3: one-word topic hint
    let hint = null;
    if (llm?.available) {
      try {
        const j = await llm.chatJson({ signal, maxTokens: 60, messages: [
          { role: 'system', content: 'Give ONE Chinese word (1-4 characters) that names the topic of the sentence the learner must recall. It is a hint, so do not copy the whole sentence. Reply JSON only: {"hint": string}.' },
          { role: 'user', content: chunkText }] });
        const h = hanzi(j?.hint);
        if (h && [...h].length <= 4) hint = h;
      } catch { /* fall back to rule */ }
    }
    if (hint) return remember(k, { level, cue: hint, source: 'llm' });
    const best = [...words(chunkText)].filter((w) => ![...w].every((c) => STOP.has(c))).sort((a, b) => b.length - a.length)[0];
    return remember(k, { level, cue: best || '', source: 'rule' });
  };
}
