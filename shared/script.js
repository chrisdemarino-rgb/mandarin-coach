// Shared script helpers (owner: Frontend bot; the Backend may import this too). Pure ESM: no DOM, no storage, no deps.
// Works unchanged in the browser (served at /shared/script.js) and in Node >= 20.
//
//   stripDirections(text)            -> text without [..] / 【..】 / ［..］ stage directions (whitespace collapsed per line)
//   parseScript(text)                -> {sentences, paragraphCount, charCount, hanziCount}
//   buildChunks(text, mode, opts)    -> chunks; mode 'sentence' | 'four' | 'paragraph'. See chunksFromSentences.
//   chunkIndexForSentence(chunks, i) -> keep position when the chunk mode changes
//   splitAtPauses(piece)             -> [{text, pauseAfter}] so the player can insert real silence for [停顿]
//
// THE CAP: every assessable piece (chunk.pieces[i].spoken) is at most MAX_PIECE_CHARS (100) characters, so it is
// always a legal /api/attempt chunkText and TonePerfect reference. Chunks (what the user picks) may be longer; they are
// practised piece by piece. Pieces split on clause punctuation (，、：；) first and hard-split only when a clause is >100.

export const MAX_PIECE_CHARS = 100;
export const MODES = ["sentence", "four", "paragraph"];
export const MODE_LABELS = { sentence: "1 sentence", four: "4 sentences", paragraph: "Paragraph" };

// Stage directions: [..] ［..］ 【..】 (ASCII, full-width brackets, lenticular)
const DIR_RE = /[\[\uFF3B\u3010]([^\]\uFF3D\u3011\n]{1,24})[\]\uFF3D\u3011]/g;
const TERMINATORS = "。！？!?；";
const CLOSERS = "”’\"')）」』》】";
const CLAUSE_BREAK = /[，,、：:。！？!?；;…\s]/;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** Classify a direction label like "停顿", "强调", "停顿2秒". */
export function parseDirection(label) {
  const l = label.trim();
  if (/^(停顿|暂停|停|pause)/i.test(l)) {
    const m = l.match(/(\d+(?:\.\d+)?)/);
    return { type: "pause", label: l, seconds: m ? Math.min(Math.max(parseFloat(m[1]), 0.2), 10) : 1 };
  }
  if (/^(强调|重读|重音|emphasi[sz]e|stress)/i.test(l)) return { type: "emphasis", label: l };
  return { type: "note", label: l };
}

/** Count script characters shown to the user: excludes stage directions and whitespace. */
export function countScriptChars(text) {
  return [...String(text || "").replace(DIR_RE, "").replace(/\s+/g, "")].length;
}

export function countHanzi(s) {
  const m = String(s || "").match(/[\u3400-\u9fff]/g);
  return m ? m.length : 0;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Turn spoken text + directions into render segments:
 *   {type:"text", text, emph:boolean} | {type:"dir", dir}
 */
export function makeSegments(spoken, directions) {
  const cuts = new Set([0, spoken.length]);
  for (const d of directions) {
    cuts.add(d.at);
    if (d.type === "emphasis" && d.len > 0) cuts.add(d.at + d.len);
  }
  const pts = [...cuts].filter((n) => n >= 0 && n <= spoken.length).sort((a, b) => a - b);
  const segs = [];
  const dirsAt = (pos) => directions.filter((d) => d.at === pos);
  const isEmph = (pos) => directions.some((d) => d.type === "emphasis" && d.len > 0 && pos >= d.at && pos < d.at + d.len);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (const d of dirsAt(p)) segs.push({ type: "dir", dir: d });
    const next = pts[i + 1];
    if (next !== undefined && next > p) segs.push({ type: "text", text: spoken.slice(p, next), emph: isEmph(p) });
  }
  return segs;
}

export function segmentsToHtml(segments) {
  return segments
    .map((s) => {
      if (s.type === "dir") {
        const d = s.dir;
        const cls = d.type === "pause" ? "badge badge-pause" : d.type === "emphasis" ? "badge badge-emph" : "badge";
        const txt = d.type === "pause" ? "\u23F8 pause" + (d.seconds && d.seconds !== 1 ? ` ${d.seconds}s` : "") : d.type === "emphasis" ? "\u2605 stress" : escapeHtml(d.label);
        return `<span class="${cls}" data-dir="${d.type}">${txt}</span>`;
      }
      const t = escapeHtml(s.text);
      return s.emph ? `<mark class="emph">${t}</mark>` : t;
    })
    .join("");
}

function finalizeSentence(raw, index, paragraph) {
  // raw: {text, dirs:[{...dir, rawAt}]}
  const text = raw.text;
  const isAscii = (c) => !!c && /[\x21-\x7e]/.test(c);
  let spoken = "";
  const map = new Array(text.length + 1).fill(0);
  for (let i = 0; i < text.length; i++) {
    map[i] = spoken.length;
    const ch = text[i];
    if (!/\s/.test(ch)) { spoken += ch; continue; }
    // keep ONE ASCII space only between two ASCII non-space chars (e.g. "iPhone 15"); drop all other whitespace
    let n = i + 1;
    while (n < text.length && /\s/.test(text[n])) n++;
    if (isAscii(spoken[spoken.length - 1]) && isAscii(text[n])) spoken += " ";
  }
  map[text.length] = spoken.length;
  const directions = raw.dirs.map((d) => {
    const { rawAt, ...rest } = d;
    return { ...rest, at: map[Math.min(rawAt, text.length)] };
  });
  // emphasis spans: from at until next clause break / next direction
  const ats = directions.map((d) => d.at);
  for (const d of directions) {
    if (d.type !== "emphasis") continue;
    let end = d.at;
    while (end < spoken.length && !CLAUSE_BREAK.test(spoken[end])) end++;
    for (const a of ats) if (a > d.at && a < end) end = a;
    d.len = end - d.at;
  }
  const segments = makeSegments(spoken, directions);
  return { index, paragraph, spoken, directions, segments, display: segmentsToHtml(segments), hanzi: countHanzi(spoken) };
}

/**
 * Parse a script into sentences.
 * opts.ellipsis: also split at … (default false)
 */
export function parseScript(script, opts = {}) {
  const terms = TERMINATORS + (opts.ellipsis ? "\u2026" : "");
  const paragraphs = String(script || "").split(/\r?\n+/).map((p) => p.trim()).filter(Boolean);
  const raws = []; // {text, dirs, paragraph}
  let leading = null; // directions waiting for a first sentence

  paragraphs.forEach((para, pIdx) => {
    let cur = { text: "", dirs: [], paragraph: pIdx };
    let ended = false;
    const close = () => {
      if (cur.text.length || cur.dirs.length) {
        if (!HAS_WORD.test(cur.text)) {
          // punctuation/direction-only fragment: merge into previous sentence (or carry forward)
          const prev = raws[raws.length - 1];
          if (prev) {
            const off = prev.text.length;
            prev.text += cur.text;
            cur.dirs.forEach((d) => prev.dirs.push({ ...d, rawAt: d.rawAt + off }));
          } else {
            leading = leading || { text: "", dirs: [] };
            const off = leading.text.length;
            leading.text += cur.text;
            cur.dirs.forEach((d) => leading.dirs.push({ ...d, rawAt: d.rawAt + off }));
          }
        } else {
          if (leading && !raws.length) {
            const off = leading.text.length;
            cur.dirs.forEach((d) => (d.rawAt += off));
            cur.text = leading.text + cur.text;
            cur.dirs = leading.dirs.concat(cur.dirs);
            leading = null;
          }
          raws.push(cur);
        }
      }
      cur = { text: "", dirs: [], paragraph: pIdx };
      ended = false;
    };

    let last = 0;
    const handleText = (str) => {
      for (const ch of str) {
        if (ended && !terms.includes(ch) && !CLOSERS.includes(ch)) close();
        cur.text += ch;
        if (terms.includes(ch)) ended = true;
      }
    };
    DIR_RE.lastIndex = 0;
    let m;
    while ((m = DIR_RE.exec(para))) {
      handleText(para.slice(last, m.index));
      last = m.index + m[0].length;
      const dir = parseDirection(m[1]);
      // A pause right after a sentence terminator trails that sentence; anything else after it opens the next one.
      if (ended && dir.type !== "pause") close();
      cur.dirs.push({ ...dir, rawAt: cur.text.length });
    }
    handleText(para.slice(last));
    close();
  });

  const sentences = raws.map((r, i) => finalizeSentence(r, i, r.paragraph)).filter((s) => s.spoken.length);
  sentences.forEach((s, i) => (s.index = i));
  return {
    sentences,
    paragraphCount: paragraphs.length,
    charCount: countScriptChars(script),
    hanziCount: sentences.reduce((n, s) => n + s.hanzi, 0),
  };
}


/** Remove stage directions from raw script text. Never throws. */
export function stripDirections(text) {
  return String(text || "")
    .replace(DIR_RE, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u3000]+/g, " ").trim())
    .join("\n");
}

/** Han characters in a string (what TonePerfect counts). */
export const hanCount = countHanzi;

const CLAUSE_PUNCT = /[，,、：:；;。！？!?…]/;
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;

/**
 * Cut a spoken string (with directions positioned by `at`) into pieces of at most `cap` UTF-16 units
 * (so also at most `cap` characters). Prefers to cut after clause punctuation, packing clauses greedily;
 * hard-splits a single clause longer than `cap`.
 * Returns [{start, end}].
 */
export function capRanges(spoken, cap = MAX_PIECE_CHARS) {
  const ranges = [];
  let start = 0;
  while (start < spoken.length) {
    if (spoken.length - start <= cap) { ranges.push({ start, end: spoken.length }); break; }
    let end = -1;
    for (let i = start + cap; i > start; i--) {
      if (CLAUSE_PUNCT.test(spoken[i - 1])) { end = i; break; }
    }
    if (end < 0) { // hard split
      end = start + cap;
      if (isHighSurrogate(spoken.charCodeAt(end - 1))) end--;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

function makePiece(chunkSpoken, chunkDirs, { start, end }, index) {
  const spoken = chunkSpoken.slice(start, end);
  const directions = [];
  for (const d of chunkDirs) {
    const inside = d.at > start && d.at < end;
    const atStart = d.at === start;
    const atEnd = d.at === end;
    // pause on a boundary trails the previous piece; other directions at a boundary open the next piece.
    const mine = inside || (atStart && (d.type !== "pause" || start === 0)) || (atEnd && d.type === "pause");
    if (!mine) continue;
    const nd = { ...d, at: d.at - start };
    if (nd.type === "emphasis" && nd.len != null) nd.len = Math.max(0, Math.min(nd.len, spoken.length - nd.at));
    if (nd.type === "emphasis" && !nd.len) continue;
    directions.push(nd);
  }
  const segments = makeSegments(spoken, directions);
  return { index, start, end, spoken, directions, segments, display: segmentsToHtml(segments), hanzi: countHanzi(spoken) };
}

/**
 * Group parsed sentences into chunks and cut each chunk into assessable pieces (<= opts.cap, default 100).
 * mode: "sentence" | "four" | "paragraph"
 * opts.crossParagraphs (default true): in "four" mode groups of 4 may span paragraph breaks.
 * Chunk: {id,index,mode,sentenceStart,sentenceEnd,paragraph,spoken,directions,segments,display,hanzi,pieces:[{index,start,end,spoken,directions,segments,display,hanzi}]}
 */
export function chunksFromSentences(sentences, mode = "sentence", opts = {}) {
  const cross = opts.crossParagraphs !== false;
  const cap = opts.cap || MAX_PIECE_CHARS;
  const groups = [];
  if (mode === "paragraph") {
    for (const s of sentences) {
      const g = groups[groups.length - 1];
      if (g && g[0].paragraph === s.paragraph) g.push(s);
      else groups.push([s]);
    }
  } else if (mode === "four") {
    let g = [];
    for (const s of sentences) {
      if (g.length && (g.length >= 4 || (!cross && g[0].paragraph !== s.paragraph))) { groups.push(g); g = []; }
      g.push(s);
    }
    if (g.length) groups.push(g);
  } else {
    for (const s of sentences) groups.push([s]);
  }
  return groups.map((g, index) => {
    let spoken = "";
    const directions = [];
    for (const s of g) {
      for (const d of s.directions) directions.push({ ...d, at: d.at + spoken.length });
      spoken += s.spoken;
    }
    const segments = makeSegments(spoken, directions);
    const pieces = capRanges(spoken, cap).map((r, i) => makePiece(spoken, directions, r, i));
    return {
      id: `${g[0].index}-${g[g.length - 1].index}`,
      index, mode,
      sentenceStart: g[0].index, sentenceEnd: g[g.length - 1].index,
      paragraph: g[0].paragraph,
      spoken, directions, segments, display: segmentsToHtml(segments), hanzi: countHanzi(spoken),
      pieces,
    };
  });
}

/** Convenience: raw script text -> chunks. */
export function buildChunks(text, mode = "sentence", opts = {}) {
  return chunksFromSentences(parseScript(text, opts).sentences, mode, opts);
}

/** Index of the chunk containing sentence `sentenceIndex` (clamped). Used to keep position across mode switches. */
export function chunkIndexForSentence(chunks, sentenceIndex) {
  if (!chunks.length) return 0;
  const i = chunks.findIndex((c) => sentenceIndex >= c.sentenceStart && sentenceIndex <= c.sentenceEnd);
  if (i >= 0) return i;
  return sentenceIndex < 0 ? 0 : chunks.length - 1;
}

/**
 * Split a piece (or chunk) at [停顿] pauses so the player can insert real silence between TTS segments.
 * Returns [{text, pauseAfter}] (seconds). Works on anything with {spoken, directions}.
 */
export function splitAtPauses(item) {
  const pauses = item.directions.filter((d) => d.type === "pause").sort((a, b) => a.at - b.at);
  if (!pauses.length) return [{ text: item.spoken, pauseAfter: 0 }];
  const out = [];
  let pos = 0;
  for (const p of pauses) {
    const text = item.spoken.slice(pos, p.at);
    const secs = p.seconds || 1;
    if (text) out.push({ text, pauseAfter: secs });
    else if (out.length) out[out.length - 1].pauseAfter += secs;
    else out.push({ text: "", pauseAfter: secs });
    pos = Math.max(pos, p.at);
  }
  const rest = item.spoken.slice(pos);
  if (rest) out.push({ text: rest, pauseAfter: 0 });
  return out;
}
