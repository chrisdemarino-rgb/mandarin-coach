// Run: node shared/script.test.mjs   (from app/)
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseScript, buildChunks, chunksFromSentences, chunkIndexForSentence, splitAtPauses, countScriptChars, parseDirection, stripDirections, capRanges, MAX_PIECE_CHARS } from "./script.js";
const SAMPLE_SCRIPT = fs.readFileSync(fileURLToPath(new URL("../../samples/sample-script-1000.txt", import.meta.url)), "utf8");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("splits on 。！？!?；", () => {
  const { sentences } = parseScript("你好。你好吗？很好！好!行?行；再见");
  assert.deepEqual(sentences.map((s) => s.spoken), ["你好。", "你好吗？", "很好！", "好!", "行?", "行；", "再见"]);
});

t("paragraphs split on newlines and blank lines", () => {
  const r = parseScript("第一段。第二句。\n\n第二段。\n第三段。");
  assert.equal(r.paragraphCount, 3);
  assert.deepEqual(r.sentences.map((s) => s.paragraph), [0, 0, 1, 2]);
});

t("closing quotes stay with their sentence", () => {
  const { sentences } = parseScript("他说：“你好。”然后走了。");
  assert.deepEqual(sentences.map((s) => s.spoken), ["他说：“你好。”", "然后走了。"]);
});

t("ellipsis optional", () => {
  assert.equal(parseScript("等一下……好吧。").sentences.length, 1);
  assert.equal(parseScript("等一下……好吧。", { ellipsis: true }).sentences.length, 2);
});

t("directions are stripped from spoken, kept as positions", () => {
  const { sentences } = parseScript("你好。[停顿]我是[强调]大卫，很高兴。");
  assert.equal(sentences[0].spoken, "你好。");
  assert.deepEqual(sentences[0].directions.map((d) => [d.type, d.at]), [["pause", 3]]);
  assert.equal(sentences[1].spoken, "我是大卫，很高兴。");
  const e = sentences[1].directions[0];
  assert.equal(e.type, "emphasis");
  assert.equal(e.at, 2);
  assert.equal(e.len, 2); // 大卫
  assert.ok(!/[\[\]【】［］]/.test(sentences[1].spoken));
  assert.match(sentences[1].display, /<mark class="emph">大卫<\/mark>/);
  assert.match(sentences[0].display, /badge-pause/);
});

t("full-width and lenticular brackets", () => {
  const { sentences } = parseScript("好的。【停顿】［强调］谢谢！");
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].directions[0].type, "pause");
  assert.equal(sentences[1].spoken, "谢谢！");
  assert.equal(sentences[1].directions[0].type, "emphasis");
});

t("pause seconds and unknown notes", () => {
  assert.equal(parseDirection("停顿2秒").seconds, 2);
  assert.equal(parseDirection("微笑").type, "note");
});

t("direction-only paragraph attaches to previous sentence; leading directions to first", () => {
  const a = parseScript("你好。\n[停顿]\n再见。");
  assert.equal(a.sentences.length, 2);
  assert.equal(a.sentences[0].directions[0].type, "pause");
  const b = parseScript("[停顿]\n你好。");
  assert.equal(b.sentences.length, 1);
  assert.equal(b.sentences[0].directions[0].at, 0);
});

t("chunk modes", () => {
  const { sentences } = parseScript("一。二。三。四。五。\n六。七。");
  assert.equal(chunksFromSentences(sentences, "sentence").length, 7);
  const four = chunksFromSentences(sentences, "four");
  assert.deepEqual(four.map((c) => [c.sentenceStart, c.sentenceEnd]), [[0, 3], [4, 6]]);
  const para = chunksFromSentences(sentences, "paragraph");
  assert.deepEqual(para.map((c) => [c.sentenceStart, c.sentenceEnd]), [[0, 4], [5, 6]]);
  const fourNo = chunksFromSentences(sentences, "four", { crossParagraphs: false });
  assert.deepEqual(fourNo.map((c) => [c.sentenceStart, c.sentenceEnd]), [[0, 3], [4, 4], [5, 6]]);
});

t("position preserved when switching mode", () => {
  const { sentences } = parseScript("一。二。三。四。五。\n六。七。八。");
  const one = chunksFromSentences(sentences, "sentence");
  const four = chunksFromSentences(sentences, "four");
  const para = chunksFromSentences(sentences, "paragraph");
  const cur = one[5].sentenceStart; // sentence 5 (paragraph 2)
  assert.equal(chunkIndexForSentence(four, cur), 1);
  assert.equal(chunkIndexForSentence(para, cur), 1);
  const back = chunkIndexForSentence(one, four[1].sentenceStart);
  assert.equal(back, 4);
  assert.equal(chunkIndexForSentence(four, 999), four.length - 1);
});

t("chunk directions are offset into combined spoken text", () => {
  const { sentences } = parseScript("你好。我是[强调]大卫。再见。[停顿]");
  const [c] = chunksFromSentences(sentences, "four");
  assert.equal(c.spoken, "你好。我是大卫。再见。");
  const em = c.directions.find((d) => d.type === "emphasis");
  assert.equal(c.spoken.slice(em.at, em.at + em.len), "大卫。".slice(0, em.len));
  const p = c.directions.find((d) => d.type === "pause");
  assert.equal(p.at, c.spoken.length);
});

t("splitAtPauses inserts silence between segments", () => {
  const { sentences } = parseScript("你好。[停顿]我是大卫。[停顿2秒]");
  const [c] = chunksFromSentences(sentences, "four");
  assert.deepEqual(splitAtPauses(c), [{ text: "你好。", pauseAfter: 1 }, { text: "我是大卫。", pauseAfter: 2 }]);
});

t("sample script >= 1000 chars, with directions, no stray brackets in spoken", () => {
  const r = parseScript(SAMPLE_SCRIPT);
  console.log("   sample chars:", r.charCount, "hanzi:", r.hanziCount, "sentences:", r.sentences.length, "paragraphs:", r.paragraphCount);
  assert.ok(r.charCount >= 1000 && r.charCount < 1300);
  assert.ok(countScriptChars(SAMPLE_SCRIPT) === r.charCount);
  assert.ok(r.sentences.every((s) => !/[\[\]【】［］]/.test(s.spoken)));
  assert.ok(r.sentences.some((s) => s.directions.some((d) => d.type === "pause")));
  assert.ok(r.sentences.some((s) => s.directions.some((d) => d.type === "emphasis" && d.len > 0)));
  for (const mode of ["sentence", "four", "paragraph"]) {
    const chunks = chunksFromSentences(r.sentences, mode);
    assert.equal(chunks.map((c) => c.spoken).join(""), r.sentences.map((s) => s.spoken).join(""));
  }
});

t("empty script", () => {
  const r = parseScript("   \n\n ");
  assert.equal(r.sentences.length, 0);
  assert.deepEqual(chunksFromSentences(r.sentences, "four"), []);
  assert.equal(chunkIndexForSentence([], 3), 0);
});


t("stripDirections", () => {
  assert.equal(stripDirections("你好。[停顿] 我是[强调]大卫。【停顿2秒】\n再见［笑］。"), "你好。 我是大卫。\n再见。");
  assert.equal(stripDirections(""), "");
  assert.equal(stripDirections(null), "");
});

t("buildChunks(text, mode) end to end on the sample file", () => {
  assert.ok(SAMPLE_SCRIPT.length >= 1000);
  for (const mode of ["sentence", "four", "paragraph"]) {
    const chunks = buildChunks(SAMPLE_SCRIPT, mode);
    assert.ok(chunks.length > 0);
    for (const c of chunks) {
      assert.ok(c.pieces.length >= 1);
      assert.equal(c.pieces.map((p) => p.spoken).join(""), c.spoken);
      for (const p of c.pieces) {
        assert.ok(p.spoken.length <= MAX_PIECE_CHARS, `piece too long: ${p.spoken.length}`);
        assert.ok(p.hanzi <= 100);
        assert.ok(!/[\[\]【】［］]/.test(p.spoken));
        assert.ok(p.spoken.trim().length > 0);
        for (const d of p.directions) assert.ok(d.at >= 0 && d.at <= p.spoken.length);
      }
    }
  }
  assert.equal(buildChunks(SAMPLE_SCRIPT, "paragraph").length, parseScript(SAMPLE_SCRIPT).paragraphCount);
  assert.equal(buildChunks(SAMPLE_SCRIPT, "four").length, Math.ceil(parseScript(SAMPLE_SCRIPT).sentences.length / 4));
});

t("cap: long sentence splits on clause punctuation first", () => {
  const clause = "我今天早上起床以后先喝了一杯热水然后出门去散步";   // 23 chars
  const long = Array.from({ length: 8 }, () => clause).join("，") + "。";     // ~ 8*23+8 = 192
  const [c] = buildChunks(long, "sentence");
  assert.ok(c.pieces.length >= 2);
  for (const p of c.pieces) assert.ok(p.spoken.length <= 100);
  for (const p of c.pieces.slice(0, -1)) assert.ok(/[，。]$/.test(p.spoken), "cut after punctuation: " + p.spoken.slice(-3));
  assert.equal(c.pieces.map((p) => p.spoken).join(""), c.spoken);
});

t("cap: hard split when a clause has no punctuation", () => {
  const blob = "好".repeat(250) + "。";
  const [c] = buildChunks(blob, "sentence");
  assert.deepEqual(c.pieces.map((p) => p.spoken.length), [100, 100, 51]);
  assert.deepEqual(capRanges("好".repeat(100)), [{ start: 0, end: 100 }]);
});

t("cap: paragraph of many short sentences packs pieces, never over 100", () => {
  const para = Array.from({ length: 30 }, (_, i) => `这是第${i}句话。`).join("");
  const [c] = buildChunks(para, "paragraph");
  assert.ok(c.pieces.length >= 3 && c.pieces.every((p) => p.spoken.length <= 100));
  assert.equal(c.pieces.map((p) => p.spoken).join(""), c.spoken);
});

t("cap: directions are rebased into the right piece; pauses trail, emphasis leads", () => {
  const a = "甲".repeat(60) + "，";            // 61
  const b = "乙".repeat(60) + "。";            // 61 -> boundary after a
  const [c] = buildChunks(a + "[停顿][强调]" + b, "sentence");
  assert.equal(c.pieces.length, 2);
  const p0 = c.pieces[0], p1 = c.pieces[1];
  assert.deepEqual(p0.directions.map((d) => [d.type, d.at]), [["pause", 61]]);
  assert.equal(p1.directions[0].type, "emphasis");
  assert.equal(p1.directions[0].at, 0);
  assert.deepEqual(splitAtPauses(p0), [{ text: p0.spoken, pauseAfter: 1 }]);
});

console.log(`\n${n} tests passed`);
