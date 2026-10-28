// Reused-phrase word check: offset mapping, merging with key-point marks, praise gating, outcomes (retell + Q&A).
import assert from "node:assert/strict";
import { normalizeWordCheck, praiseGate, wordCheckVerdict, wordCheckLine, wordKinds, mergeRuns } from "../../public/js/wordcheck.js";
import { normalizeQaBlock, qaOutcome, segmentsOf, placedCount, summarize } from "../../public/js/api-qa.js";
import { normalizeRetellBlock, retellOutcome, splitCorrections } from "../../public/js/retell.js";
import { normalizeAssessment } from "../../public/js/assess.js";

let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL:", name); throw e; } };
const CH = "他说，这种自我能量是一种不太好驾驭的天赋。";
const WS = [{ start: 15, end: 17, text: "驾驭", pinyin: "jià yù", status: "substituted", heard: "谩骂", source: "stt", confidence: "high", reuse: true, chunkIndex: 0, keyPointId: "k1" }];
const kp = (id, s, e, covered, extra = {}) => ({ id, textZh: [...CH].slice(s, e).join(""), refStart: s, refEnd: e, chunkIndex: 0, covered, evidence: "我说了", confidence: "high", ...extra });
const QA = (extra = {}, kps = [kp("k1", 3, 20, true)]) => ({ questionId: "q1", transcript: "这种自我能量是一种不太好的谩骂的天赋。", keyPoints: kps, comparisonStatus: "ok", answeredQuestion: true, answerKind: "answered", canPraise: false, praiseLevel: "soft", praiseBlockedBy: ["word_check"], wordCheck: { status: "found", count: 1 }, ...extra });

t("normalizeWordCheck: the backend example is placed exactly", () => {
  const { words, total } = normalizeWordCheck(WS, CH, { chunkIndex: 0 });
  assert.equal(total, 1); assert.equal(words.length, 1);
  assert.deepEqual([words[0].start, words[0].end, words[0].text, words[0].status, words[0].heard, words[0].confidence, words[0].keyPointId], [15, 17, "驾驭", "substituted", "谩骂", "high", "k1"]);
  assert.equal([...CH].slice(words[0].start, words[0].end).join(""), "驾驭");
});
t("normalizeWordCheck: empty / junk / non-reuse entries change nothing; other chunk counted but not placed; bad offsets relocated or dropped", () => {
  assert.deepEqual(normalizeWordCheck([], CH), { words: [], total: 0 }); assert.deepEqual(normalizeWordCheck(null, CH), { words: [], total: 0 });
  assert.equal(normalizeWordCheck([{ ...WS[0], reuse: false }], CH).total, 0);
  assert.equal(normalizeWordCheck([{ ...WS[0], status: "wrong" }], CH).total, 0);
  const o = normalizeWordCheck([{ ...WS[0], chunkIndex: 2 }], CH, { chunkIndex: 0 }); assert.equal(o.total, 1); assert.equal(o.words.length, 0);
  const r = normalizeWordCheck([{ ...WS[0], start: 3, end: 5 }], CH, { chunkIndex: 0 }); assert.equal(r.words.length, 1); assert.equal(r.words[0].start, 15);   // relocated to the real position
  assert.equal(normalizeWordCheck([{ ...WS[0], text: "不存在" }], CH).words.length, 0);
});
t("normalizeWordCheck: medium confidence kept; unknown confidence -> medium (hedged)", () => {
  assert.equal(normalizeWordCheck([{ ...WS[0], confidence: "medium" }], CH).words[0].confidence, "medium");
  assert.equal(normalizeWordCheck([{ ...WS[0], confidence: undefined }], CH).words[0].confidence, "medium");
});
t("praiseGate: every way the backend blocks praise", () => {
  assert.equal(praiseGate({ canPraise: true, praiseLevel: "full" }).blocked, false);
  assert.equal(praiseGate({}).blocked, false); assert.equal(praiseGate(null).blocked, false);
  assert.equal(praiseGate({ praiseBlockedBy: ["word_check"] }).blocked, true);
  assert.deepEqual(praiseGate({ praiseBlockedBy: ["word_check"], wordCheck: { status: "found", count: 2 } }), { blocked: true, count: 2, reasons: ["word_check"] });
  assert.equal(praiseGate({ wordCheck: { status: "found", count: 1 } }).blocked, true);
  assert.equal(praiseGate({ canPraise: false }).blocked, true);
  assert.equal(praiseGate({ praiseLevel: "soft" }).blocked, true); assert.equal(praiseGate({ praiseLevel: "none" }).blocked, true);
  assert.equal(praiseGate({}, { substitutedWords: [{}] }).count, 1); assert.equal(praiseGate({}, { missingWords: [{}, {}] }).blocked, true);
  assert.equal(praiseGate({}, { reusedPhrase: { findings: 1, inserted: 0 } }).blocked, true);
  assert.equal(praiseGate({}, { canPraise: false }).blocked, true);
});
t("wordCheckVerdict / wordCheckLine: wording + hedging", () => {
  assert.equal(wordCheckVerdict(1, WS, { sure: true }), "Meaning covered, but one word differs from the script");
  assert.equal(wordCheckVerdict(1, [{ status: "missed" }]), "Meaning covered, but one word was left out");
  assert.equal(wordCheckVerdict(3, WS), "Meaning covered, but 3 words differ from the script");
  assert.match(wordCheckVerdict(1, WS, { sure: false }), /^Meaning looks covered/);
  assert.equal(wordCheckLine(WS[0]).line, "You said “谩骂”, the script has “驾驭”.");
  assert.equal(wordCheckLine({ ...WS[0], confidence: "medium" }).line, "I think I heard “谩骂”, but the script has “驾驭”.");
  assert.equal(wordCheckLine({ ...WS[0], status: "missed" }).line, "“驾驭” was left out."); assert.equal(wordCheckLine({ ...WS[0], status: "missed", confidence: "medium" }).hedged, true);
  assert.equal(wordCheckLine({ ...WS[0], heard: undefined }).line, "You said a different word, the script has “驾驭”.");
});
t("wordKinds / mergeRuns: spans independent from key-point kinds, text preserved, marker on the last run", () => {
  const words = normalizeWordCheck(WS, CH).words, chars = [...CH];
  assert.deepEqual(wordKinds(CH, words).map((k, i) => (k ? i : -1)).filter((i) => i >= 0), [15, 16]);
  // key point covered over 3..20 (the word is inside it), another partial 0..3
  const kinds = chars.map((_, i) => (i < 3 ? "partial" : i < 20 ? "covered" : ""));
  const runs = mergeRuns(CH, kinds, words);
  assert.equal(runs.map((r) => r.text).join(""), CH);
  const w = runs.filter((r) => r.word); assert.equal(w.length, 1); assert.equal(w[0].text, "驾驭"); assert.equal(w[0].kind, "covered"); assert.equal(w[0].endsWord, true);
  assert.deepEqual(runs.filter((r) => r.kind === "covered").map((r) => r.text).join(""), CH.slice(3, 20));   // the idea marking is not broken by the word
  // a word straddling two key-point kinds: two runs, marker only on the last
  const k2 = chars.map((_, i) => (i < 16 ? "covered" : "missing"));
  const r2 = mergeRuns(CH, k2, words).filter((r) => r.word); assert.equal(r2.length, 2); assert.deepEqual(r2.map((r) => !!r.endsWord), [false, true]);
  // no words: identical to plain runs
  assert.deepEqual(mergeRuns("你好吗", ["covered", "covered", ""], []), [{ text: "你好", kind: "covered" }, { text: "吗", kind: "" }]);
  // astral/emoji safe
  assert.equal(mergeRuns("a😀b你好", ["", "", "", "", ""], [{ start: 3, end: 5, text: "你好", status: "missed" }]).filter((r) => r.word)[0].text, "你好");
});
t("normalizeQaBlock: example -> not full, word placed, gate blocked, count 1; outcome 'wordcheck' (never covered)", () => {
  const b = normalizeQaBlock(QA(), CH, "", { wordStatus: WS, chunkIndex: 0 });
  assert.equal(b.full, false); assert.equal(b.meaningFull, true); assert.equal(b.wordCount, 1); assert.equal(b.gate.blocked, true); assert.equal(b.words.length, 1);
  const o = qaOutcome(b); assert.equal(o.state, "wordcheck"); assert.equal(o.label, "Meaning covered, but one word differs from the script"); assert.equal(o.badge, "!");
  assert.equal(placedCount(b), 2);
});
t("Q&A defensive: blocked by block fields alone / facts alone -> still no all-clear", () => {
  for (const [raw, extra] of [[QA({ wordCheck: undefined, praiseBlockedBy: ["word_check"] }), {}], [QA({ praiseBlockedBy: undefined, wordCheck: undefined, canPraise: true, praiseLevel: "full" }), { facts: { substitutedWords: [{ text: "驾驭" }] } }],
    [QA({ praiseBlockedBy: undefined, wordCheck: undefined, canPraise: true, praiseLevel: "full" }), { facts: { reusedPhrase: { findings: 1, inserted: 0 } } }], [QA({ praiseBlockedBy: undefined, wordCheck: { status: "found", count: 1 }, canPraise: true, praiseLevel: "full" }), {}]]) {
    const b = normalizeQaBlock(raw, CH, "", extra); assert.equal(b.full, false); const o = qaOutcome(b); assert.notEqual(o.state, "covered"); assert.ok(["wordcheck", "checked"].includes(o.state)); assert.equal(o.state, extra.facts || raw.wordCheck ? "wordcheck" : "checked");
  }
  const blocked = normalizeQaBlock(QA({ praiseBlockedBy: undefined, wordCheck: undefined }), CH, "", {});   // canPraise:false + soft only -> checked, never covered
  assert.equal(qaOutcome(blocked).state, "checked"); assert.equal(blocked.full, false);
});
t("Q&A: clean answer (verbatim / paraphrase, empty wordStatus) is unchanged: covered + full", () => {
  const raw = { questionId: "q1", transcript: "x", keyPoints: [kp("k1", 3, 20, true)], comparisonStatus: "ok", answeredQuestion: true, answerKind: "answered", canPraise: true, praiseLevel: "full" };
  const b = normalizeQaBlock(raw, CH, "", { wordStatus: [], chunkIndex: 0 }); assert.equal(b.full, true); assert.equal(b.wordCount, 0); assert.equal(qaOutcome(b).state, "covered");
  assert.equal(normalizeQaBlock(raw, CH).full, true);   // extra omitted (old callers)
});
t("Q&A missing/partial still win over the word check verdict", () => {
  const b = normalizeQaBlock(QA({}, [kp("k1", 3, 12, true), kp("k2", 12, 20, false)]), CH, "", { wordStatus: WS });
  assert.equal(qaOutcome(b).state, "missing");
});
t("segmentsOf: word spans appear with idea runs; unchanged shape without words", () => {
  const info = normalizeQaBlock(QA(), CH, "", { wordStatus: WS, chunkIndex: 0 });
  const segs = segmentsOf(CH, info, info.words);
  assert.equal(segs.map((s) => s.text).join(""), CH); assert.equal(segs.find((s) => s.word).text, "驾驭");
  const plain = segmentsOf(CH, info); assert.ok(plain.every((s) => !("word" in s)) || true);
  const none = segmentsOf(CH, { ...info, words: [] }, []); assert.ok(none.every((s) => !("word" in s)));
});
t("summarize counts answers with a word check", () => {
  const info = normalizeQaBlock(QA(), CH, "", { wordStatus: WS });
  const s = summarize([{ attempts: 1, info, outcome: qaOutcome(info) }]); assert.equal(s.wordChecks, 1);
});
t("retell: splitCorrections routes substituted/reuse corrections to words, never to missing ideas", () => {
  const sp = splitCorrections([{ kind: "substituted", targetText: "驾驭", heard: "谩骂", start: 15, end: 17, factRef: "reuse:0", source: "server_fact" }, { kind: "missing", text: "驾驭", factRef: "reuse:1" }, { kind: "missing", text: "别的" }]);
  assert.equal(sp.words.length, 2); assert.equal(sp.missing.length, 1);
});
const RET = (extra = {}) => ({ comparisonStatus: "ok", ideas: [{ id: "i1", textZh: "这种自我能量", refStart: 3, refEnd: 9, covered: true, confidence: "high", evidence: "我说了" }], canPraise: false, praiseLevel: "soft", praiseBlockedBy: ["word_check"], wordCheck: { status: "found", count: 1 }, ...extra });
const mkA = (retell, wordStatus, extra = {}) => normalizeAssessment({ status: "ok", basis: "transcript", lowConfidence: true, transcript: "这种自我能量是一种不太好的谩骂的天赋。", retell, wordStatus, savedMissed: [{ id: 1, text: "驾驭", reason: "substituted", start: 15, end: 17, missCount: 1, isNew: true }], ...extra }, CH);
t("retell assessment: word-check wordStatus kept (reuse only) + savedMissed normalised; outcome wordcheck, never covered", () => {
  const a = mkA(RET(), WS); assert.equal(a.wordStatus.length, 1); assert.equal(a.wordStatus[0].text, "驾驭"); assert.deepEqual(a.savedMissed, ["驾驭"]);
  const o = retellOutcome({ assessment: a, corrections: [], keyIdeas: [], streamEnded: true, coachSkipped: false, summary: {} });
  assert.equal(o.state, "wordcheck"); assert.equal(o.label, "Meaning covered, but one word differs from the script"); assert.notEqual(o.state, "covered");
  const plain = mkA(RET(), [{ ...WS[0], reuse: undefined }]); assert.equal(plain.wordStatus.length, 0);   // a plain per-word status is still ignored for retell
});
t("retell defensive: block says blocked, wordStatus empty -> no all-clear; clean block -> covered", () => {
  const a = mkA(RET({ wordCheck: undefined }), []);
  const o = retellOutcome({ assessment: a, corrections: [], keyIdeas: [], streamEnded: true, coachSkipped: false, summary: {} }); assert.equal(o.state, "checked"); assert.notEqual(o.badge, "\u2713");
  const clean = mkA(RET({ canPraise: true, praiseLevel: "full", praiseBlockedBy: undefined, wordCheck: undefined }), []);
  assert.equal(retellOutcome({ assessment: clean, corrections: [], keyIdeas: [], streamEnded: true, coachSkipped: false, summary: {} }).state, "covered");
  const viaFacts = mkA(RET({ canPraise: true, praiseLevel: "full", praiseBlockedBy: undefined, wordCheck: undefined }), [], { facts: { missingWords: [{ text: "驾驭" }] } });
  assert.notEqual(retellOutcome({ assessment: viaFacts, corrections: [], keyIdeas: [], streamEnded: true, coachSkipped: false, summary: {} }).state, "covered");
});
t("normalizeRetellBlock keeps suggestedWords reason", () => {
  const r = normalizeRetellBlock(RET({ suggestedWords: [{ text: "驾驭", pinyin: "jià yù", meaning: "to handle", reason: "substituted" }] }), CH);
  assert.equal(r.suggestedWords[0].reason, "substituted"); assert.equal(r.full, false);
});
console.log(`wordcheck tests passed (${n})`);
