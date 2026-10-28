import assert from "node:assert/strict";
import { splitCorrections, normalizeKeyIdeas, normalizeRetellBlock, ideaKind, placeIdeas, toneAllowed, retellOutcome, retellPassed, modelLine } from "../../public/js/retell.js";
import { normalizeAssessment } from "../../public/js/assess.js";

let n = 0; const t = (name, fn) => { fn(); n++; };
const REF = "今天天气很好，我们去公园散步。";
const syl = (chars) => [...chars].map((c, i) => ({ index: i, char: c, pinyin: "x1", tone: { decision: "ok", expected: 1, heard: 1 } }));
const retellAssessment = (extra = {}) => ({ status: "ok", engine: "toneperfect", mock: false, modelVersion: "tp-2.3", basis: "transcript", lowConfidence: true, transcript: "今天天气很好", referenceText: "今天天气很好", overall: 88, syllables: syl("今天天气很好"), facts: { confirmedToneErrors: [{ index: 1, char: "天", pinyin: "tian1", expectedTone: 1, heardTone: 3 }], uncertain: [{ index: 2, char: "天", dimension: "tone" }], canPraise: true, completeness: "unknown" }, wordStatus: [], savedMissed: [], ...extra });
const omission = (text, extra = {}) => ({ kind: "omission", targetText: text, modelText: text, explanationZh: `漏掉了${text}`, basis: "transcript", source: "llm", ...extra });
const norm = (extra) => normalizeAssessment(retellAssessment(extra), REF);

t("splitCorrections: omission->missing, wording kinds->wording, tone/model stay as-is, junk ignored", () => {
  const r = splitCorrections([omission("公园"), { kind: "wording", targetText: "做练习", modelText: "练习" }, { kind: "tone", targetText: "天" }, { kind: "model" }, null, "x", { kind: "unnatural_wording", targetText: "a" }]);
  assert.equal(r.missing.length, 1); assert.equal(r.missing[0].text, "公园");
  assert.equal(r.wording.length, 2); assert.equal(r.other.length, 2);
  assert.deepEqual(splitCorrections(undefined), { missing: [], wording: [], other: [] });
});

t("normalizeKeyIdeas: tolerant of garbage, accepts covered bool or status", () => {
  assert.deepEqual(normalizeKeyIdeas(undefined), []);
  assert.deepEqual(normalizeKeyIdeas("x"), []);
  const k = normalizeKeyIdeas([{ text: "公园", covered: false }, { text: "散步", status: "covered" }, { text: "", covered: true }, { covered: true }, null, { text: "我们", status: "banana" }]);
  assert.deepEqual(k.map((x) => [x.text, x.covered]), [["公园", false], ["散步", true], ["我们", null]]);
});

t("placeIdeas: finds text in the reference (code points), marks it missed, lists the rest as unplaced", () => {
  const r = placeIdeas(REF, [{ text: "公园", model: "公园" }, { text: "不在文中", model: "" }]);
  assert.equal(r.placed.length, 1); assert.equal(r.unplaced.length, 1);
  assert.equal(r.wordStatus.length, 1); assert.equal(r.wordStatus[0].status, "missed"); assert.equal(r.wordStatus[0].text, "公园");
  assert.equal(r.wordStatus[0].start, [...REF].indexOf("公"));
});

t("placeIdeas: valid start/end used; wrong slice falls back to search; astral chars use code points", () => {
  assert.equal(placeIdeas(REF, [{ text: "公园", start: 10, end: 12 }]).placed[0].start, 10);
  const bad = placeIdeas(REF, [{ text: "公园", start: 0, end: 2 }]);
  assert.equal(bad.placed[0].start, 10);
  const ref = "𠮷野家很好";
  assert.equal(placeIdeas(ref, [{ text: "野家" }]).placed[0].start, 1);
  assert.equal(placeIdeas(ref, [{ text: "野家", start: 99, end: 120 }]).placed[0].start, 1);
});

t("placeIdeas: no overlap, no throw on empty/garbage; modelText used when targetText is absent", () => {
  assert.equal(placeIdeas(REF, [{ text: "公园" }, { text: "公园" }]).placed.length, 1);   // the second one has nowhere left to go
  assert.deepEqual(placeIdeas("", [{ text: "公园" }]).placed, []);
  assert.deepEqual(placeIdeas(REF, undefined).wordStatus, []);
  assert.equal(placeIdeas(REF, [{ text: "", model: "散步" }]).placed.length, 1);
});

t("assess: retell drops the scripted-speech overall score and word statuses", () => {
  const a = norm({ wordStatus: [{ start: 0, end: 2, text: "今天", status: "missed", reason: "omitted" }] });
  assert.equal(a.retell, true); assert.equal(a.overall, null); assert.deepEqual(a.wordStatus, []);
});

t("assess: retell tone info is kept ONLY when flagged lowConfidence", () => {
  const flagged = norm();
  assert.equal(flagged.toneShown, true); assert.equal(flagged.confirmed.length, 1); assert.equal(flagged.uncertain.length, 1); assert.equal(toneAllowed(flagged), true);
  const plain = norm({ lowConfidence: undefined });
  assert.equal(plain.toneShown, false); assert.equal(plain.confirmed.length, 0); assert.equal(plain.uncertain.length, 0);
  assert.ok(plain.chars.every((c) => !c.review && !c.unsure)); assert.equal(toneAllowed(plain), false);
  const explicitFalse = norm({ lowConfidence: false });
  assert.equal(explicitFalse.confirmed.length, 0);
});

t("assess: close mode is unchanged (overall + tone errors still shown)", () => {
  const a = normalizeAssessment({ ...retellAssessment(), basis: "audio", lowConfidence: undefined }, REF);
  assert.equal(a.retell, false); assert.equal(a.overall, 88); assert.equal(a.confirmed.length, 1); assert.equal(toneAllowed(a), true);
});

const base = (o = {}) => ({ assessment: norm(), corrections: [], streamEnded: true, coachSkipped: false, summary: { coached: true }, ...o });

t("outcome: missing idea => 'missing', never an all-clear (even before the stream ends, even with praise)", () => {
  const o = retellOutcome(base({ corrections: [omission("公园")] }));
  assert.equal(o.state, "missing"); assert.equal(o.count, 1); assert.match(o.label, /1 key idea missing/); assert.equal(retellPassed(o), false);
  assert.equal(retellOutcome(base({ corrections: [omission("公园"), omission("散步")], streamEnded: false })).state, "missing");
  assert.match(retellOutcome(base({ corrections: [omission("公园"), omission("散步")] })).label, /2 key ideas missing/);
});

t("outcome: key ideas from a future backend field count too", () => {
  const o = retellOutcome(base({ keyIdeas: [{ text: "公园", covered: false }, { text: "今天", covered: true }] }));
  assert.equal(o.state, "missing"); assert.equal(o.count, 1);
  assert.equal(retellOutcome(base({ keyIdeas: [{ text: "今天", covered: true }] })).state, "checked");
});

t("outcome: pending while the coach is still streaming; not a pass", () => {
  const o = retellOutcome(base({ streamEnded: false, summary: null }));
  assert.equal(o.state, "pending"); assert.equal(retellPassed(o), false);
});

t("outcome: coach skipped / not coached / dropped connection => 'unchecked' (no all-clear)", () => {
  for (const x of [{ coachSkipped: true }, { summary: { coached: false } }, { coachSkipped: true, summary: null }]) {
    const o = retellOutcome(base(x)); assert.equal(o.state, "unchecked", JSON.stringify(x)); assert.equal(retellPassed(o), false); assert.match(o.note, /Nothing is marked as covered/);
  }
});

t("outcome: coached and nothing flagged => 'checked' with soft wording, not 'perfect'", () => {
  const o = retellOutcome(base());
  assert.equal(o.state, "checked"); assert.equal(retellPassed(o), true);
  assert.doesNotMatch(o.label + o.note, /perfect|all correct|great|well done/i);
  assert.match(o.label, /No missing ideas flagged/);
});

t("outcome: tone corrections / wording alone don't make it a pass-blocker or a pass-maker", () => {
  assert.equal(retellOutcome(base({ corrections: [{ kind: "tone", targetText: "天" }] })).state, "checked");
  assert.equal(retellOutcome(base({ corrections: [{ kind: "wording", targetText: "x" }] })).state, "checked");
});

t("outcome: empty transcript => nospeech; gated => gated; not ok => none", () => {
  assert.equal(retellOutcome(base({ assessment: norm({ transcript: "  " }) })).state, "nospeech");
  assert.equal(retellOutcome(base({ assessment: norm({ transcript: "", referenceText: "" }) })).state, "nospeech");
  assert.equal(retellOutcome(base({ assessment: norm({ matchesText: false, gate: "low_match" }) })).state, "gated");
  assert.equal(retellOutcome(base({ assessment: normalizeAssessment({ status: "unavailable" }, REF) })).state, "none");
  assert.equal(retellOutcome({}).state, "none");
});

t("modelLine: only what the payload says; mock is labelled", () => {
  assert.equal(modelLine(norm(), null), "Engine: toneperfect \u00b7 model tp-2.3 \u00b7 speech-to-text transcript");
  assert.match(modelLine(norm({ mock: true, engine: "mock", modelVersion: null }), null), /^MOCK engine \(mock\): simulated/);
  assert.match(modelLine(norm(), { coachModel: "gpt-x" }), /coach gpt-x$/);
  assert.equal(modelLine(null), "");
  assert.match(modelLine(norm({ engine: undefined, modelVersion: undefined })), /^Engine: unknown/);
});


// ---------------------------------------------------------------- structured `retell` block (Backend: services/retell.js buildRetellBlock)
const idea = (id, textZh, s, e, covered, extra2 = {}) => ({ id, textZh, refStart: s, refEnd: e, covered, evidence: covered === false ? null : "今天天气", confidence: "high", ...extra2 });
const block = (ideas, extra2 = {}) => ({ comparisonStatus: "ok", ideas, coveredCount: ideas.filter((i) => i.covered === true).length, totalCount: ideas.length, canPraise: true, praiseLevel: "full", tone: { status: "ok" }, suggestedWords: [], ...extra2 });
const withBlock = (b) => normalizeAssessment(retellAssessment({ retell: b }), REF);
const bo = (b, o = {}) => retellOutcome({ assessment: withBlock(b), corrections: [], streamEnded: false, summary: null, ...o });

t("block: normalised ideas, offsets checked against the chunk, counts re-derived", () => {
  const a = withBlock(block([idea("i1", "今天天气很好", 0, 6, true), idea("i2", "去公园散步", 9, 14, false), idea("i3", "坏偏移", 50, 60, "partial"), { id: "x", textZh: "", covered: true }, { textZh: "no covered" }]));
  const r = a.retellInfo;
  assert.equal(r.status, "ok"); assert.equal(r.ideas.length, 3);
  assert.equal(r.ideas[2].start, undefined);   // out of range -> no highlight, still listed
  assert.deepEqual([r.covered, r.partial, r.missing, r.wrong], [1, 1, 1, 0]);
  assert.deepEqual(r.ideas.map(ideaKind), ["covered", "missing", "partial"]);
  assert.equal(normalizeRetellBlock(undefined), null); assert.equal(normalizeRetellBlock("x"), null); assert.equal(normalizeRetellBlock([]), null);
});

t("block: unavailable / empty ideas => status unavailable (no coverage claims)", () => {
  assert.equal(normalizeRetellBlock({ comparisonStatus: "unavailable", comparisonReason: "malformed_output", ideas: [idea("i1", "x", 0, 2, true)] }, REF).ideas.length, 0);
  assert.equal(normalizeRetellBlock({ comparisonStatus: "ok", ideas: [] }, REF).status, "unavailable");
});

t("block outcome: missing / wrong / partial / covered / soft, never an all-clear with a gap", () => {
  assert.equal(bo(block([idea("i1", "a", 0, 2, true), idea("i2", "b", 9, 11, false)])).state, "missing");
  assert.match(bo(block([idea("i1", "a", 0, 2, true), idea("i2", "b", 9, 11, false)])).label, /1 key idea missing/);
  assert.match(bo(block([idea("i1", "a", 0, 2, false, { issue: "wrong_meaning" })])).label, /1 idea differs from the original/);
  assert.match(bo(block([idea("i1", "a", 0, 2, false), idea("i2", "b", 4, 6, false, { issue: "wrong_meaning" })])).label, /2 key ideas missing or different/);
  const part = bo(block([idea("i1", "a", 0, 2, true), idea("i2", "b", 9, 11, "partial")]));
  assert.equal(part.state, "partial"); assert.equal(retellPassed(part), false);
  const full = bo(block([idea("i1", "a", 0, 2, true), idea("i2", "b", 9, 11, true)]));
  assert.equal(full.state, "covered"); assert.equal(retellPassed(full), true); assert.match(full.label, /All key ideas covered/);
  const soft = bo(block([idea("i1", "a", 0, 2, true, { confidence: "low" })]));
  assert.equal(soft.state, "checked"); assert.match(soft.note, /not fully sure/);
  assert.equal(bo(block([idea("i1", "a", 0, 2, true)], { canPraise: false })).state, "checked");   // the server says no full praise: we don't give it
});

t("block outcome: available at assessment time (no waiting for the stream); unavailable => unchecked with a reason", () => {
  assert.equal(bo(block([idea("i1", "a", 0, 2, true)]), { streamEnded: false }).state, "covered");
  const u = bo({ comparisonStatus: "unavailable", comparisonReason: "llm_not_configured", ideas: [] });
  assert.equal(u.state, "unchecked"); assert.match(u.note, /isn't set up/); assert.equal(retellPassed(u), false);
  assert.match(bo({ comparisonStatus: "unavailable", comparisonReason: "malformed_output" }).note, /Nothing is marked as covered/);
});

t("block + corrections: ideaId links; language => wording; wrong_meaning/missing_idea => missing group", () => {
  const sp = splitCorrections([{ kind: "missing_idea", ideaId: "i2", targetText: "去公园", explanationZh: "漏掉了", modelText: "去公园" }, { kind: "wrong_meaning", ideaId: "i1", heard: "足球" }, { kind: "language", targetText: "做练习", modelText: "练习" }, { kind: "tone", targetText: "天" }]);
  assert.deepEqual(sp.missing.map((m) => m.ideaId), ["i2", "i1"]); assert.equal(sp.missing[1].heard, "足球");
  assert.equal(sp.wording.length, 1); assert.equal(sp.other.length, 1);
});

t("block: suggestedWords kept (max 6, text required)", () => {
  const r = withBlock(block([idea("i1", "a", 0, 2, false)], { suggestedWords: [{ text: "公园", pinyin: "gōng yuán", meaning: "park", ideaId: "i1" }, { text: "" }, null, { text: "散步" }] })).retellInfo;
  assert.deepEqual(r.suggestedWords.map((w) => w.text), ["公园", "散步"]); assert.equal(r.suggestedWords[0].meaning, "park");
});

t("block: modelLine mentions the comparison model only if the payload names one", () => {
  assert.doesNotMatch(modelLine(withBlock(block([idea("i1", "a", 0, 2, true)])), null), /coach/);
  assert.match(modelLine(withBlock(block([idea("i1", "a", 0, 2, true)], { model: "gpt-4.1-mini" })), null), /coach gpt-4.1-mini/);
});

console.log(`retell tests passed (${n})`);
