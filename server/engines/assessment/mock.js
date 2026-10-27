// MOCK assessment engine. Deterministic, offline, clearly labelled. NOT real scoring:
// every payload carries engine:'mock' and mock:true so the UI can show a banner.
// Behaviour (derived from a hash of the chunk text, so the same text always gives the same result):
//   - ~1/2 of chunks get one confirmed tone error (decision 'review') on a deterministic syllable
//   - ~1/3 get one 'uncertain' component
//   - MOCK_FORCE=unavailable makes every call return status:'unavailable' (exercise the retry/skip UI)
import crypto from 'node:crypto';
import { pinyin as pinyinPro } from 'pinyin-pro';

const HANZI = /[\u3400-\u9fff]/;
export const MOCK_VERSION = 'mock-v1';

function h32(s) { return crypto.createHash('sha256').update(s).digest().readUInt32BE(0); }

export function createMockEngine({ force = process.env.MOCK_FORCE } = {}) {
  return {
    name: 'mock',
    mock: true,
    available: () => true,
    async assess({ audio, chunkText }) {
      const base = { engine: 'mock', mock: true, modelVersion: MOCK_VERSION };
      if (force === 'unavailable') {
        return { ...base, status: 'unavailable', overall: null, syllables: [], words: [],
          error: { code: 'mock_forced_unavailable', message: 'MOCK engine forced unavailable (MOCK_FORCE=unavailable).', retryable: true } };
      }
      if (!audio || audio.length < 16) {
        return { ...base, status: 'unavailable', overall: null, syllables: [], words: [],
          error: { code: 'invalid_audio', message: 'No audio received.', retryable: true } };
      }
      const chars = [...String(chunkText || '')];
      const seed = h32(chars.join(''));
      const syllables = [];
      let idx = 0; let wordIndex = 0; let t = 0;
      const hanziCount = chars.filter((c) => HANZI.test(c)).length;
      const errAt = (seed & 1) === 0 && hanziCount ? (seed >>> 3) % hanziCount : -1;
      const uncAt = seed % 3 === 0 && hanziCount > 1 ? (seed >>> 7) % hanziCount : -1;
      for (const ch of chars) {
        if (!HANZI.test(ch)) continue;
        const py = pinyinPro(ch, { toneType: 'num', type: 'array', v: true })[0] || '';
        const m = /^([a-züv]+?)([0-5])?$/i.exec(py);
        const tone = m && m[2] ? Number(m[2]) : 5;
        const sy = pinyinPro(ch, { pattern: 'initial', type: 'array' })[0] || '';
        const fin = pinyinPro(ch, { pattern: 'final', type: 'array', v: true })[0] || '';
        const k = syllables.length;
        const hasInitial = sy !== '';
        const comp = (expected, score) => ({ expected, heard: expected, score, decision: 'no_correction' });
        const s = {
          index: idx, char: ch, pinyin: py, wordIndex, startMs: t, endMs: t + 220,
          initial: hasInitial ? comp(sy, 90 + (seed + k) % 8) : { expected: null, heard: null, score: null, decision: 'no_correction' },
          final: comp(fin, 90 + (seed + 2 * k) % 8),
          tone: comp(tone, 90 + (seed + 3 * k) % 8),
        };
        if (k === errAt && tone !== 5) {
          const heard = tone === 4 ? 2 : tone + 1;
          s.tone = { expected: tone, heard, score: 41 + (seed % 10), decision: 'review' };
        } else if (k === uncAt) {
          s.final = { expected: fin, heard: fin, score: 68, decision: 'uncertain' };
        }
        syllables.push(s);
        idx += 1; wordIndex += 1; t += 220;
      }
      const scores = syllables.flatMap((s) => [s.initial.score, s.final.score, s.tone.score]).filter((x) => x != null);
      const overall = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
      return { ...base, status: 'ok', overall, syllables,
        words: syllables.map((s) => ({ text: s.char, score: Math.round((s.initial.score ?? s.final.score) ), startMs: s.startMs, endMs: s.endMs })) };
    },
  };
}
