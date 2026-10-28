import assert from "node:assert/strict";
import { defaultTopic, cleanTopic, historyFor, summaryTurns, hasUserSpeech, readEvent, normalizeHeard, normalizeAcoustic, normalizeCorrection, normalizeSuggested, talkErrorOf, noSpeechError,
  normalizeSummary, normalizeOpening, scriptVocabOf, isUnsupported, isTipRole, MAX_HISTORY_TURNS } from "../../public/js/api-talk.js";

let n = 0; const t = (name, fn) => { fn(); n++; };
const ok = (role, text) => ({ role, text, status: "ok" });

t("defaultTopic: short title line, 'talk about X' phrase, first sentence, empty", () => {
  assert.equal(defaultTopic("我的周末\n今天天气很好，我去了公园。"), "我的周末");
  assert.equal(defaultTopic("大家好！今天我想聊聊我的家乡。它在海边。"), "我的家乡");
  assert.equal(defaultTopic("我喜欢吃饺子。"), "我喜欢吃饺子");
  assert.ok([...defaultTopic("我昨天和朋友一起去了很远的地方，那里的风景非常漂亮，我们玩得很开心，还拍了很多照片。")].length <= 20);
  assert.equal(defaultTopic(""), ""); assert.equal(defaultTopic(null), "");
  assert.equal(defaultTopic("[pause] 大家好！"), "大家好");   // only a greeting: falls back to the first line, never throws
});
t("cleanTopic: collapses whitespace, caps length", () => {
  assert.equal(cleanTopic("  我的   周末 "), "我的 周末"); assert.equal([...cleanTopic("长".repeat(200))].length, 80); assert.equal(cleanTopic(undefined), "");
});
t("historyFor: only finished text turns, newest last, capped, roles kept, current take excluded by the caller", () => {
  const turns = [ok("coach", "你好"), ok("user", "你好！"), { role: "user", text: "进行中", status: "pending" }, ok("coach", ""), { role: "bot", text: "x", status: "ok" }, ok("coach", "你好吗？")];
  assert.deepEqual(historyFor(turns), [{ role: "coach", text: "你好" }, { role: "user", text: "你好！" }, { role: "coach", text: "你好吗？" }]);
  const many = Array.from({ length: 20 }, (_, i) => ok(i % 2 ? "user" : "coach", `句子${i}`));
  const h = historyFor(many); assert.equal(h.length, MAX_HISTORY_TURNS); assert.equal(h[h.length - 1].text, "句子19");
  assert.equal([...historyFor([ok("user", "字".repeat(900))])[0].text].length, 400);
  assert.deepEqual(historyFor(null), []);
  assert.ok(summaryTurns(many).length > MAX_HISTORY_TURNS);
});
t("hasUserSpeech", () => { assert.equal(hasUserSpeech([ok("coach", "你好")]), false); assert.equal(hasUserSpeech([ok("coach", "你好"), ok("user", "你好")]), true); assert.equal(hasUserSpeech([{ role: "user", text: "x", status: "pending" }]), false); });

t("readEvent: transcript / gate / coach_text / coach_audio / error / done", () => {
  assert.deepEqual(readEvent("status", { stage: "coaching", skipped: true }), { kind: "status", stage: "coaching", skipped: true });
  const h = readEvent("transcript", { text: "我去了公园", sttStatus: "ok", hanziCount: 5 });
  assert.equal(h.kind, "transcript"); assert.equal(h.transcript, "我去了公园"); assert.equal(h.noSpeech, false);
  const g = readEvent("transcript", { text: "谢谢观看", sttStatus: "hallucination" });
  assert.equal(g.noSpeech, true); assert.equal(g.transcript, "", "a gated transcript is never shown as what the learner said");
  assert.equal(readEvent("transcript", { text: "", sttStatus: "empty" }).noSpeech, true);
  const c = readEvent("coach_text", { delta: "很好。", index: 2, role: "reply" });
  assert.deepEqual([c.kind, c.text, c.index, c.role, c.replace], ["coach_text", "很好。", 2, "reply", false]);
  assert.equal(readEvent("coach_text", { text: "全文", index: 0 }).replace, true);
  assert.equal(readEvent("coach_audio", { url: "/api/audio/a.mp3", index: 1, text: "x" }).url, "/api/audio/a.mp3");
  assert.equal(readEvent("coach_audio", { index: 1 }).kind, "ignore");
  assert.equal(readEvent("error", { code: "x", message: "m", retryable: false, canSkip: true }).retryable, false);
  assert.equal(readEvent("assessment", { status: "ok", overall: 80 }).kind, "ignore", "the backend's tone assessment is never used as what was heard");
  assert.equal(readEvent("whatever", {}).kind, "ignore"); assert.equal(readEvent("done", null).kind, "done"); assert.equal(readEvent("status", "x").stage, "");
});
t("readEvent done: correction, suggested words, reply text, gate", () => {
  const d = readEvent("done", { gate: "too_short", correction: { kind: "word_choice", quote: "玩了", betterZh: "逛了", explainZh: "更自然", pinyin: "guàng le", factRef: "x" },
    suggestedWords: [{ text: "爬山", pinyin: "pá shān", meaning: "hike", reason: "script_vocab" }, { text: "爬山" }, { text: "" }, "饺子"], replyZh: "很好。", questionZh: "然后呢？" });
  assert.equal(d.gate, "too_short"); assert.deepEqual(d.correction, { kind: "word_choice", quote: "玩了", betterZh: "逛了", explainZh: "更自然", pinyin: "guàng le" });
  assert.deepEqual(d.suggested.map((w) => w.text), ["爬山", "饺子"]); assert.equal(d.replyZh, "很好。");
  assert.equal(normalizeCorrection({ quote: "x" }), null); assert.equal(normalizeCorrection(null), null); assert.deepEqual(normalizeSuggested("x"), []);
  assert.equal(normalizeSuggested(Array.from({ length: 9 }, (_, i) => ({ text: `词${i}` }))).length, 4);
  assert.ok(isTipRole("correction") && isTipRole("correction_model") && !isTipRole("reply") && !isTipRole("question"));
});
t("normalizeHeard / normalizeAcoustic: acoustic only when explicitly flagged; the transcript is never tone evidence", () => {
  assert.equal(normalizeHeard({ transcript: "你好", sttStatus: "ok" }).acoustic, null);
  assert.equal(normalizeAcoustic({ notes: ["tone 3 was flat"] }), null, "unflagged notes are ignored");
  assert.equal(normalizeAcoustic({ source: "transcript", notes: ["x"] }), null);
  assert.deepEqual(normalizeAcoustic({ source: "acoustic", notes: ["Tone 3 in 好 sounded flat.", { note: "second" }, ""] }), { source: "acoustic", notes: ["Tone 3 in 好 sounded flat.", "second"] });
  assert.equal(normalizeAcoustic({ source: "acoustic", notes: [] }), null); assert.equal(normalizeAcoustic([]), null);
  assert.equal(normalizeHeard({ ok: false }).noSpeech, true); assert.equal(normalizeHeard(null).transcript, "");
});
t("talkErrorOf / noSpeechError: 'No assessment obtained', retry vs re-record, skip", () => {
  const e = talkErrorOf({ code: "talk_llm_unavailable", message: "The coach could not reply", retryable: true, canSkip: true });
  assert.ok(e.message.startsWith("No assessment obtained: ")); assert.equal(e.action, "reupload"); assert.equal(e.canSkip, true);
  assert.equal(talkErrorOf({ code: "talk_turn_too_long", retryable: false }).action, "rerecord");
  assert.equal(talkErrorOf({ code: "no_speech_detected", retryable: true }).action, "rerecord");
  assert.equal(talkErrorOf({ code: "x", message: "No assessment obtained: already prefixed" }).message.match(/No assessment obtained/g).length, 1);
  assert.equal(talkErrorOf(null).action, "reupload"); assert.equal(talkErrorOf({ canSkip: false }).canSkip, false);
  assert.ok(noSpeechError().message.includes("didn't hear"));
});
t("isUnsupported: 404/501 only", () => { assert.equal(isUnsupported({ status: 404 }), true); assert.equal(isUnsupported({ status: 501 }), true); assert.equal(isUnsupported({ status: 500 }), false); assert.equal(isUnsupported(null), false); });

t("normalizeSummary: real shape", () => {
  const s = normalizeSummary({ ok: true, takeaways: [{ textEn: "Clear", textZh: "我去了公园。", pinyin: "wǒ qù le gōng yuán." }, { textEn: "Clear", textZh: "我去了公园。" }, "plain"], newWords: [{ text: "爬山", pinyin: "pá shān", meaning: "hike", exampleZh: "我们爬山。", savedMeaning: "to hike" }, { text: "爬山" }, { text: "" }],
    phrasesToTry: [{ zh: "我觉得很放松。", pinyin: "p", en: "I feel relaxed.", whyEn: "feelings" }, { zh: "" }], strengths: ["Good flow", "Good flow"] });
  assert.equal(s.status, "ok"); assert.equal(s.takeaways.length, 2); assert.deepEqual(s.takeaways[0], { en: "Clear", zh: "我去了公园。", pinyin: "wǒ qù le gōng yuán." });
  assert.equal(s.newWords.length, 1); assert.equal(s.newWords[0].example, "我们爬山。"); assert.equal(s.newWords[0].savedMeaning, "to hike");
  assert.deepEqual(s.phrases, [{ zh: "我觉得很放松。", pinyin: "p", en: "I feel relaxed.", why: "feelings" }]); assert.deepEqual(s.strengths, ["Good flow"]);
});
t("normalizeSummary: empty/garbage/provisional shapes never throw", () => {
  for (const x of [null, undefined, 5, "x", [], {}, { takeaways: "no" }, { newWords: [null, 3] }]) assert.equal(normalizeSummary(x).status, "empty");
  const p = normalizeSummary({ summary: { takeaways: ["a"], phrases: [{ textZh: "你好", meaningEn: "hi" }], words: ["词"] } });
  assert.equal(p.status, "ok"); assert.equal(p.phrases[0].en, "hi"); assert.equal(p.newWords[0].text, "词");
  assert.equal(normalizeSummary({ takeaways: Array.from({ length: 30 }, (_, i) => `t${i}`) }).takeaways.length, 8);
});
t("normalizeOpening", () => {
  assert.deepEqual(normalizeOpening({ ok: true, textZh: "你好吗？", pinyin: "nǐ hǎo ma?", textAudio: { url: "/api/audio/x.mp3" } }), { textZh: "你好吗？", pinyin: "nǐ hǎo ma?", audioUrl: "/api/audio/x.mp3" });
  assert.deepEqual(normalizeOpening(null), { textZh: "", pinyin: "", audioUrl: "" });
});
t("scriptVocabOf: 2-4 hanzi words, most frequent first, injectable segmenter, no segmenter -> []", () => {
  const fake = { segment: (txt) => txt.split(/(?<=[，。 ])/).flatMap((p) => p.match(/[\u4e00-\u9fff]{1,6}|[^\u4e00-\u9fff]+/g) || []).map((segment) => ({ segment, isWordLike: /[\u4e00-\u9fff]/.test(segment) })) };
  const v = scriptVocabOf("天气 公园 天气 我 去公园玩耍好久 [pause] 天气，", fake);
  assert.deepEqual(v.map((w) => w.text), ["天气", "公园"], "single characters and >4 hanzi runs are not vocabulary");
  assert.deepEqual(scriptVocabOf("你好", null), []); assert.deepEqual(scriptVocabOf("x", { segment() { throw new Error("boom"); } }), []);
  assert.ok(scriptVocabOf(Array.from({ length: 80 }, (_, i) => `词${String.fromCharCode(0x4e00 + i)}`).join(" "), { segment: (s) => s.split(" ").map((segment) => ({ segment, isWordLike: true })) }).length <= 40);
  const real = scriptVocabOf("今天天气很好，我们去公园散步。公园里有很多人。"); assert.ok(Array.isArray(real));
});
console.log(`talk.test.mjs: ${n} tests passed`);
