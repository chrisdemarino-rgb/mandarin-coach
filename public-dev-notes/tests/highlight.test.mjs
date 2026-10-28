import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChunks } from "../../shared/script.js";
import { cpOffsets, normalizeWordStatus, highlightPieceHtml, flaggedWords, problemWords, reasonText, problemSummary, groupFlagged } from "../../public/js/highlight.js";

let n = 0; const t = (name, fn) => { fn(); n++; };

t("cpOffsets handles astral characters", () => {
  assert.deepEqual(cpOffsets("a𠮷b"), [0, 1, 3, 4]);
});

t("normalize keeps good entries, sorted, with text from the slice", () => {
  const ws = normalizeWordStatus([{ start: 2, end: 4, text: "天气", status: "missed", reason: "omitted", pinyin: "tian1 qi4" }, { start: 0, end: 2, text: "今天", status: "ok" }], "今天天气很好");
  assert.equal(ws.length, 2); assert.equal(ws[0].text, "今天"); assert.equal(ws[1].status, "missed"); assert.equal(ws[1].reason, "omitted");
});

t("bad offsets / unknown status are dropped, never thrown", () => {
  const txt = "今天天气很好";
  assert.deepEqual(normalizeWordStatus([{ start: -1, end: 2, status: "missed" }, { start: 3, end: 3, status: "missed" }, { start: 0, end: 99, status: "missed" }, { start: 0, end: 1, status: "banana" }, null, "x"], txt), []);
  assert.deepEqual(normalizeWordStatus(undefined, txt), []);
  assert.deepEqual(normalizeWordStatus([{ start: 0, end: 1, status: "missed" }], ""), []);
});

t("offsets are code points, not UTF-16 units", () => {
  const txt = "𠮷野家很好";   // 𠮷 is 2 UTF-16 units, 1 code point
  const ws = normalizeWordStatus([{ start: 1, end: 3, text: "野家", status: "wrong", reason: "tone" }], txt);
  assert.equal(ws.length, 1); assert.equal(ws[0].text, "野家");
  const piece = { spoken: txt, segments: [{ type: "text", text: txt, emph: false }], display: "x" };
  const html = highlightPieceHtml(piece, ws);
  assert.match(html, /^𠮷<span class="hl hl-wrong"[^>]*>野家<\/span>/);
});

t("mismatched text is relocated to the nearest occurrence, else dropped", () => {
  const txt = "我喜欢你，我喜欢他";
  const ws = normalizeWordStatus([{ start: 0, end: 3, text: "喜欢", status: "missed" }], txt); // wrong offsets, text exists nearby
  assert.equal(ws.length, 1); assert.equal(ws[0].start, 1);
  assert.deepEqual(normalizeWordStatus([{ start: 0, end: 2, text: "不在", status: "missed" }], txt), []);
});

t("overlaps keep the more severe status", () => {
  const ws = normalizeWordStatus([{ start: 0, end: 3, status: "uncertain" }, { start: 2, end: 4, status: "missed" }, { start: 1, end: 2, status: "wrong" }], "今天天气很好");
  assert.ok(ws.some((w) => w.status === "missed" && w.start === 2 && w.end === 4));
  assert.ok(ws.every((w, i) => i === 0 || w.start >= ws[i - 1].end), "no overlaps");
});

t("highlight inside a displayed piece with stage directions and emphasis", () => {
  const script = "你好[停顿]，我今天[强调]很高兴。再见。";
  const chunks = buildChunks(script, "sentence");
  const piece = chunks[0].pieces[0];
  assert.equal(piece.spoken, "你好，我今天很高兴。");
  const at = [...piece.spoken].indexOf("今");
  const ws = normalizeWordStatus([{ start: at, end: at + 2, text: "今天", status: "missed", reason: "omitted" }, { start: at + 2, end: at + 5, text: "很高兴", status: "uncertain" }], piece.spoken);
  const html = highlightPieceHtml(piece, ws);
  assert.ok(html.includes('class="badge badge-pause"'), "direction cue kept");
  assert.match(html, /<span class="hl hl-missed"[^>]*>今天<\/span><sup class="hl-m hl-m-missed" aria-hidden="true">/);
  assert.match(html, /class="sr-only">, missed</);
  assert.match(html, /hl-uncertain/);
  // the visible text without markup equals display text without markup
  const strip = (h) => h.replace(/<sup[^>]*>.*?<\/sup>/g, "").replace(/<span class="sr-only">.*?<\/span>/g, "").replace(/<[^>]+>/g, "");
  assert.equal(strip(html), strip(piece.display));
});

t("a word interrupted by a direction is wrapped per fragment, marker once", () => {
  const piece = { spoken: "今天好", segments: [{ type: "text", text: "今", emph: false }, { type: "dir", dir: { type: "pause", label: "停顿", seconds: 1 } }, { type: "text", text: "天好", emph: false }], display: "" };
  const ws = normalizeWordStatus([{ start: 0, end: 2, text: "今天", status: "wrong", reason: "tone" }], piece.spoken);
  const html = highlightPieceHtml(piece, ws);
  assert.equal((html.match(/class="hl hl-wrong"/g) || []).length, 2);
  assert.equal((html.match(/<sup/g) || []).length, 1);
});

t("multi-piece chunk: offsets are relative to the piece, not the chunk", () => {
  const text = readFileSync(new URL("../../../samples/sample-script-1000.txt", import.meta.url), "utf8");
  const chunks = buildChunks(text, "paragraph");
  const multi = chunks.find((c) => c.pieces.length > 1);
  assert.ok(multi, "sample has a multi-piece chunk");
  const p2 = multi.pieces[1];
  const han = [...p2.spoken];
  const ws = normalizeWordStatus([{ start: 1, end: 3, text: han.slice(1, 3).join(""), status: "wrong", reason: "initial" }], p2.spoken);
  const html = highlightPieceHtml(p2, ws);
  assert.ok(html.includes(`data-start="1"`) && html.includes(han.slice(1, 3).join("")));
  assert.equal(highlightPieceHtml(p2, []), p2.display, "no statuses -> unchanged display");
});

t("escaping: no markup injection from spoken text", () => {
  const piece = { spoken: "a<b>好", segments: [{ type: "text", text: "a<b>好", emph: false }], display: "" };
  const html = highlightPieceHtml(piece, normalizeWordStatus([{ start: 3, end: 4, text: "好", status: "missed" }], piece.spoken));
  assert.ok(html.startsWith("a&lt;b&gt;"));
});

t("lists and wording", () => {
  const ws = normalizeWordStatus([
    { start: 0, end: 2, text: "今天", status: "wrong", reason: "tone", pinyin: "jin1 tian1" },
    { start: 2, end: 4, text: "天气", status: "substituted", heard: "天空" },
    { start: 4, end: 5, text: "很", status: "uncertain", reason: "final" },
    { start: 5, end: 6, text: "好", status: "ok" },
  ], "今天天气很好");
  assert.equal(flaggedWords(ws).length, 3); assert.equal(problemWords(ws).length, 2);
  assert.equal(reasonText(ws[0]), "tone"); assert.equal(reasonText(ws[1]), "said something else"); assert.equal(reasonText(ws[2]), "not sure about final sound");
  assert.deepEqual(problemSummary(ws), ["1 word different", "1 word to fix"]);
  assert.equal(reasonText({ status: "missed", reason: "omitted" }), "not said");
});

t("server shape: per-character entries (real Backend) highlight per char, list merges touching same-status chars", () => {
  const chunkText = "我叫大卫，今天";
  const ch = (start, text, status, extra = {}) => ({ start, end: start + 1, text, pinyin: "", status, ...extra });
  const raw = [ch(0, "我", "ok"), ch(1, "叫", "ok"), ch(2, "大", "missed", { reason: "omitted", source: "stt", confidence: "medium" }), ch(3, "卫", "missed", { reason: "omitted" }), ch(5, "今", "wrong", { reason: "tone" }), ch(6, "天", "wrong", { reason: "tone" })];
  const ws = normalizeWordStatus(raw, chunkText);
  assert.equal(ws.length, 6);
  const g = groupFlagged(flaggedWords(ws));
  assert.deepEqual(g.map((w) => [w.text, w.start, w.end, w.status]), [["大卫", 2, 4, "missed"], ["今天", 5, 7, "wrong"]]);
  const piece = buildChunks("我叫大卫，今天", "sentence")[0].pieces[0];
  assert.equal((highlightPieceHtml(piece, ws).match(/class="hl hl-/g) || []).length, 4);
  assert.deepEqual(groupFlagged([ch(2, "大", "missed"), ch(4, "x", "missed")]).length, 2);   // not touching -> separate
});

console.log(`highlight tests passed (${n})`);
