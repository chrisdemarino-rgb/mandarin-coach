import assert from "node:assert/strict";
import { chunkWindow, normalizeQuestion, normalizeQaBlock, qaOutcome, qaPassed, hintsFor, answerFor, segmentsOf, placedCount, summarize, qaErrorOf, isUnsupported, QA_MARKS } from "../../public/js/api-qa.js";

const ideaKindOf = (p) => (p.covered === true ? "covered" : p.covered === "partial" ? "partial" : p.issue ? "wrong" : "missing");
let n = 0; const t = (name, fn) => { fn(); n++; };
const CH = "今天天气很好，我们去公园散步。";   // 15 code points; 今天天气很好 = 0..6, 我们去公园散步 = 7..14
const kp = (id, s, e, covered, extra = {}) => ({ id, textZh: [...CH].slice(s, e).join(""), refStart: s, refEnd: e, chunkIndex: 0, covered, evidence: covered === false ? null : "我说了", confidence: "high", ...extra });
const block = (kps, extra = {}) => ({ questionId: "q0123456789ab", transcript: "我觉得天气好", keyPoints: kps, comparisonStatus: "ok", answeredQuestion: true, answerKind: "answered", canPraise: kps.every((k) => k.covered === true), modelAnswerZh: "今天天气很好。", ...extra });
const RAWQ = { ok: true, questionId: "q0123456789ab", type: "what", level: 1, questionZh: "今天天气怎么样？", modelAnswerZh: "今天天气很好。", hintZh: "想一想天气。", sourceChunkIndex: 0,
  keyPoints: [{ id: "k1", textZh: "今天天气很好", refStart: 0, refEnd: 6, chunkIndex: 0 }], signature: "sig", questionPinyin: "jīn tiān tiān qì zěn me yàng？" };

t("normalizeQuestion: real shape -> id/text/pinyin/hints/source/modelAnswer + verbatim payload", () => {
  const q = normalizeQuestion(RAWQ, CH);
  assert.equal(q.id, "q0123456789ab"); assert.equal(q.text, "今天天气怎么样？"); assert.equal(q.pinyin, "jīn tiān tiān qì zěn me yàng？");
  assert.equal(q.modelAnswer, "今天天气很好。"); assert.deepEqual(q.source, { start: 0, end: 6 }); assert.equal(q.payload, RAWQ); assert.equal(q.done, false);
  assert.deepEqual(q.hints.map((h) => h.text), ["想一想天气。", "答案是这样开头的：今天天……"]);   // level 2 = first half of the first key point (same rule as the server)
});
t("normalizeQuestion: rejects junk, keeps working without hint/keyPoints, drops out-of-range offsets", () => {
  for (const bad of [null, undefined, "x", [], {}, { questionZh: "你好吗？" }, { questionId: "q1" }]) assert.equal(normalizeQuestion(bad, CH), null);
  const q = normalizeQuestion({ ...RAWQ, hintZh: undefined, keyPoints: [{ id: "k1", textZh: "x", refStart: 0, refEnd: 999 }] }, CH);
  assert.deepEqual(q.hints, []); assert.equal(q.source, null);
  assert.deepEqual(normalizeQuestion({ done: true }), { done: true });
});
t("hintsFor: question hints, else script-derived (labelled 'script'), else none; never invented", () => {
  assert.equal(hintsFor(normalizeQuestion(RAWQ, CH), CH)[0].from, "coach");
  const q = normalizeQuestion({ ...RAWQ, hintZh: "", keyPoints: [{ id: "k1", textZh: "今天天气很好", refStart: 0, refEnd: 6 }, { id: "k2", textZh: "x", refStart: 7, refEnd: 15 }] }, CH);
  q.hints = []; const h = hintsFor(q, CH);
  assert.equal(h.length, 2); assert.ok(h.every((x) => x.from === "script")); assert.equal(h[0].text, "今天…");
  assert.deepEqual(hintsFor({ hints: [], source: null }, CH), []); assert.deepEqual(hintsFor(null, CH), []);
});
t("answerFor: assessment answer > question answer > script span (labelled) > null", () => {
  const q = normalizeQuestion(RAWQ, CH);
  assert.deepEqual(answerFor(q, { modelAnswer: "A" }, CH), { text: "A", from: "coach" });
  assert.deepEqual(answerFor(q, null, CH), { text: "今天天气很好。", from: "coach" });
  assert.deepEqual(answerFor({ ...q, modelAnswer: "" }, null, CH), { text: "今天天气很好", from: "script" });
  assert.equal(answerFor({ source: null, modelAnswer: "" }, null, CH), null); assert.equal(answerFor(null, null, CH), null);
});

t("normalizeQaBlock: all covered -> full, counts re-derived (not trusted)", () => {
  const b = normalizeQaBlock({ ...block([kp("k1", 0, 7, true), kp("k2", 7, 14, true)]), coveredCount: 0 }, CH);
  assert.equal(b.status, "ok"); assert.equal(b.covered, 2); assert.equal(b.missing, 0); assert.equal(b.full, true); assert.equal(b.answered, true);
  assert.equal(b.points[0].start, 0); assert.equal(b.points[1].end, 14); assert.equal(b.modelAnswer, "今天天气很好。");
});
t("normalizeQaBlock: missing / partial / wrong_fact (a contradicted point is 'wrong', never 'partial')", () => {
  let b = normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 14, false)]), CH);
  assert.equal(b.missing, 1); assert.equal(b.full, false); assert.equal(b.points[1].covered, false);
  b = normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 14, "partial")]), CH);
  assert.equal(b.partial, 1); assert.equal(b.full, false);
  b = normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 14, "partial", { issue: "wrong_fact" })], { wrongFacts: [{ claimZh: "我们去商店", contradictsKeyPointId: "k2" }] }), CH);
  assert.equal(b.wrong, 1); assert.equal(b.partial, 0); assert.equal(b.points[1].evidence, "我们去商店"); assert.equal(ideaKindOf(b.points[1]), "wrong");
});
t("normalizeQaBlock: unavailable / malformed / null-covered => status unavailable, no points", () => {
  assert.equal(normalizeQaBlock(null, CH), null); assert.equal(normalizeQaBlock("x", CH), null);
  let b = normalizeQaBlock(block([kp("k1", 0, 7, null)], { comparisonStatus: "unavailable", comparisonReason: "malformed_output" }), CH);
  assert.equal(b.status, "unavailable"); assert.equal(b.points.length, 0); assert.equal(b.reason, "malformed_output");
  b = normalizeQaBlock(block([kp("k1", 0, 7, null)]), CH); assert.equal(b.status, "unavailable");   // ok but nothing valid to show
  b = normalizeQaBlock({ transcript: "x", keyPoints: [kp("k1", 0, 7, true)] }, CH); assert.equal(b.status, "unavailable");   // no comparisonStatus at all
});
t("normalizeQaBlock: bad offsets are not placed but the point stays; off-topic/dont_know is never 'full'", () => {
  const b = normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 999, false)]), CH);
  assert.equal(b.points.length, 2); assert.equal(b.points[1].start, undefined); assert.equal(placedCount(b), 1);
  const d = normalizeQaBlock(block([kp("k1", 0, 7, true)], { answeredQuestion: false, answerKind: "off_topic", canPraise: true }), CH);
  assert.equal(d.full, false); assert.equal(d.answered, false);
});
t("normalizeQaBlock: canPraise false or a low-confidence point blocks the all-clear", () => {
  assert.equal(normalizeQaBlock(block([kp("k1", 0, 7, true)], { canPraise: false }), CH).full, false);
  assert.equal(normalizeQaBlock(block([kp("k1", 0, 7, true, { confidence: "low" })]), CH).full, false);
});

t("qaOutcome: never an all-clear when unchecked / missing / partial / wrong / not answered", () => {
  const o = (kps, extra) => qaOutcome(normalizeQaBlock(block(kps, extra), CH));
  assert.equal(qaOutcome(null).label, "Could not compare"); assert.equal(qaOutcome(null).state, "unchecked");
  assert.equal(qaOutcome(normalizeQaBlock(block([], { comparisonStatus: "unavailable" }), CH)).label, "Could not compare");
  assert.equal(o([kp("k1", 0, 7, true), kp("k2", 7, 14, false)]).label, "1 key point missing");
  assert.equal(o([kp("k1", 0, 7, false), kp("k2", 7, 14, false)]).label, "2 key points missing");
  assert.equal(o([kp("k1", 0, 7, true), kp("k2", 7, 14, false, { issue: "wrong_fact" })]).label, "1 point differs from the script");
  assert.equal(o([kp("k1", 0, 7, false), kp("k2", 7, 14, false, { issue: "wrong_fact" })]).label, "2 key points missing or different");
  assert.equal(o([kp("k1", 0, 7, true), kp("k2", 7, 14, "partial")]).state, "partial");
  assert.equal(o([kp("k1", 0, 7, false)], { answeredQuestion: false, answerKind: "dont_know" }).label, "Not answered yet");
  assert.equal(o([kp("k1", 0, 7, false)], { answeredQuestion: false, answerKind: "off_topic" }).label, "That didn't answer the question");
  const all = o([kp("k1", 0, 7, true), kp("k2", 7, 14, true)]); assert.equal(all.state, "covered"); assert.equal(all.label, "All key points covered"); assert.ok(qaPassed(all));
  const soft = o([kp("k1", 0, 7, true), kp("k2", 7, 14, true, { confidence: "low" })]); assert.equal(soft.state, "checked"); assert.notEqual(soft.label, "All key points covered");
  for (const bad of [o([kp("k1", 0, 7, false)]), o([kp("k1", 0, 7, "partial")]), qaOutcome(null)]) assert.equal(qaPassed(bad), false);
});

t("segmentsOf: covered/partial/wrong/missing runs, priority missing > wrong > partial > covered, text preserved", () => {
  const b = normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 14, false)]), CH);
  const seg = segmentsOf(CH, b);
  assert.equal(seg.map((s) => s.text).join(""), CH);
  assert.deepEqual(seg.map((s) => s.kind), ["covered", "missing", ""]);
  const o = normalizeQaBlock(block([kp("k1", 0, 7, "partial"), kp("k2", 4, 10, false)]), CH);
  assert.equal(segmentsOf(CH, o).find((s) => s.text.includes("很")).kind, "missing");
  assert.deepEqual(segmentsOf(CH, null), [{ text: CH, kind: "" }]);
  assert.deepEqual(segmentsOf(CH, normalizeQaBlock(block([], { comparisonStatus: "unavailable" }), CH)), [{ text: CH, kind: "" }]);
  for (const k of ["covered", "partial", "missing", "wrong"]) assert.ok(QA_MARKS[k].glyph && QA_MARKS[k].label && QA_MARKS[k].cls);   // non-colour-only markers
});

t("summarize: answered / skipped / unchecked, last assessed attempt counts, hints & answers used", () => {
  const ok = (cov, tot) => ({ status: "ok", covered: cov, points: new Array(tot).fill(0) });
  const s = summarize([
    { attempts: 2, info: ok(2, 2), hints: 1, answerShown: false },
    { attempts: 1, info: ok(1, 3), hints: 2, answerShown: true },
    { attempts: 1, info: { status: "unavailable", points: [] }, hints: 0, answerShown: false },
    { attempts: 0, info: null, hints: 1, answerShown: false, skipped: true },
  ]);
  assert.deepEqual(s, { questions: 4, answered: 3, unchecked: 1, skipped: 1, pointsCovered: 3, pointsTotal: 5, hints: 4, answers: 1 });
  assert.equal(summarize([]).questions, 0);
});

t("qaErrorOf: always 'No assessment obtained' once; new recording for no-speech/too-long, never retry a rejected question", () => {
  const a = qaErrorOf({ code: "no_speech_detected", retryable: true });
  assert.ok(a.message.startsWith("No assessment obtained: ")); assert.equal(a.retryable, true);
  const b = qaErrorOf({ code: "assessment_unavailable", message: "No assessment obtained: the answer check was unavailable.", retryable: true });
  assert.equal(b.message.match(/No assessment obtained/gi).length, 1);
  assert.equal(qaErrorOf({ code: "qa_answer_too_long", retryable: false }).retryable, true);
  assert.equal(qaErrorOf({ code: "invalid_question_signature", retryable: true }).retryable, false);
  assert.equal(qaErrorOf({ retryable: false }).retryable, false);
  assert.ok(qaErrorOf(null).message.startsWith("No assessment obtained"));
});
t("isUnsupported: 404/501 only", () => { assert.ok(isUnsupported({ status: 404 })); assert.ok(isUnsupported({ status: 501 })); assert.ok(!isUnsupported({ status: 500 })); assert.ok(!isUnsupported(null)); });

t("praiseLevel gates the all-clear: soft/none or wrongFacts without flagged points -> never 'full' / 'covered'", () => {
  const kps = [kp("k1", 0, 7, true), kp("k2", 7, 14, true)];
  assert.equal(normalizeQaBlock(block(kps, { praiseLevel: "full" }), CH).full, true);
  for (const lvl of ["soft", "none"]) { const b = normalizeQaBlock(block(kps, { praiseLevel: lvl }), CH); assert.equal(b.full, false); assert.notEqual(qaOutcome(b).state, "covered"); }
  const w = normalizeQaBlock(block(kps, { praiseLevel: "full", wrongFacts: [{ claimZh: "他昨天去了", contradictsKeyPointId: "k1", confidence: "high" }] }), CH);
  assert.equal(w.full, false); assert.equal(w.wrongFacts.length, 1);
  const o = qaOutcome(w); assert.notEqual(o.state, "covered"); assert.equal(o.label, "Check this");
});
t("suggestedWords pass through only when the comparison is ok", () => {
  const sw = [{ text: "公园", pinyin: "gōng yuán", meaning: null, keyPointId: "k2" }];
  assert.equal(normalizeQaBlock(block([kp("k1", 0, 7, true), kp("k2", 7, 14, false)], { suggestedWords: sw }), CH).suggestedWords[0].text, "公园");
});
t("chunkWindow: current chunk first, then followers within 80 chunks / 2000 hanzi; an oversized first chunk is still sent (server answers 413)", () => {
  const T = Array.from({ length: 100 }, (_, i) => "你好吗我很好" + i);
  assert.equal(chunkWindow(T, 0).length, 80); assert.equal(chunkWindow(T, 95).length, 5); assert.equal(chunkWindow(T, 95)[0], T[95]);
  const big = ["我".repeat(900), "你".repeat(900), "他".repeat(900)];
  assert.equal(chunkWindow(big, 0).length, 2);
  assert.equal(chunkWindow(["我".repeat(2500), "你好"], 0).length, 1);
  assert.deepEqual(chunkWindow([], 0), []);
});
t("qaErrorOf: real error shapes (nested error.code) map to retry policy", () => {
  assert.ok(qaErrorOf({ code: "question_generation_failed", message: "x" }).message.startsWith("No assessment obtained"));
  assert.equal(qaErrorOf({ code: "invalid_question_signature" }).retryable, false);
});

console.log(`qa.test.mjs: ${n} tests passed`);
