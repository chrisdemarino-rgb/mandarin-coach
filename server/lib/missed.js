// "Words I don't know": auto-save of missed words + cached gloss. Persists ONLY words (spans of the user's own script),
// pinyin, a short gloss, counters, status. Never audio, never transcripts.
import { log } from '../config.js';

const seen = (list, text) => list.some((x) => x.text === text);

/** Words from this attempt's facts that qualify for the list. -> [{text, pinyin, reason, start, end}] */
export function missedCandidates(facts, policy) {
  const out = [];
  for (const w of facts.missingWords || []) if (w.confidence !== 'low') out.push({ text: w.text, pinyin: w.pinyin, reason: 'omitted', start: w.start, end: w.end });
  for (const w of facts.substitutedWords || []) if (w.confidence !== 'low' && !seen(out, w.text)) out.push({ text: w.text, pinyin: w.pinyin, reason: 'substituted', start: w.start, end: w.end });
  for (const w of facts.unclearWords || []) if (typeof w.score === 'number' && w.score < policy.SAVE_LOW_SCORE_WORD_MAX && !seen(out, w.text)) out.push({ text: w.text, pinyin: w.pinyin, reason: 'low_score', start: w.start, end: w.end });
  return out;
}

/** -> savedMissed: [{ id, text, pinyin, meaning, reason, start, end, missCount, isNew }] */
export function saveMissed(db, facts, chunkText, policy) {
  const saved = [];
  for (const c of missedCandidates(facts, policy)) {
    try {
      const r = db.recordMiss({ text: c.text, pinyin: c.pinyin, sourceChunk: chunkText });
      saved.push({ id: r.id, text: c.text, pinyin: r.word.pinyin ?? c.pinyin, meaning: r.word.meaning ?? null, reason: c.reason, start: c.start, end: c.end, missCount: r.word.missCount, isNew: r.created });
    } catch (e) { log('warn', `missed-word save failed: ${String(e?.message).slice(0, 80)}`); }
  }
  return saved;
}

/** Cheap English gloss for words without one. Only when OpenAI is available; result cached in the row; a failure is not retried. Fire-and-forget. */
export async function fillGlosses(db, llm, ids) {
  if (!llm?.available) return;
  for (const id of ids) {
    const w = db.getMissed(id);
    if (!w || w.meaning || w.glossTried) continue;
    db.markGlossTried(id);
    try {
      const j = await llm.chatJson({ maxTokens: 40, timeoutMs: 8000, messages: [
        { role: 'system', content: 'Give a very short English gloss (max 6 words) for the Mandarin word. JSON only: {"meaning": string}.' },
        { role: 'user', content: JSON.stringify({ word: w.text, pinyin: w.pinyin, context: w.sourceChunk }) }] });
      const m = typeof j?.meaning === 'string' ? j.meaning.trim().slice(0, 60) : '';
      if (m && !/[\u3400-\u9fff]/.test(m)) db.setMissedMeaning(id, m);
    } catch (e) { log('warn', `gloss failed: ${e?.code || 'error'}`); }
  }
}

/** What the learner must say in a drill: the word itself (2+ chars) or - for a lone character, a poor isolated test - the user's own sentence, judging only the target span (code-point offsets). */
export function drillTarget(word) {
  const w = Array.from(word.text);
  if (w.length >= 2 || !word.sourceChunk) return { promptText: word.text, start: 0, end: w.length };
  const arr = Array.from(word.sourceChunk);
  for (let i = 0; i + w.length <= arr.length; i++) if (arr.slice(i, i + w.length).join('') === word.text) return { promptText: word.sourceChunk, start: i, end: i + w.length };
  return { promptText: word.text, start: 0, end: w.length };
}
