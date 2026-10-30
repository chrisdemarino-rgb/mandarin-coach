import assert from "node:assert/strict";
import { normalizeUpgrade, resolveSpan, segmentsOf, cpIndexOf, phrasesToSave, readEvent, upgradeOf, normalizeSaveable, upgradeNoteOf, scriptForTalk, scriptTooLongForTalk, talkErrorOf } from "../../public/js/api-talk.js";
import { scriptLimitInfo, SCRIPT_MAX } from "../../public/js/limits.js";

let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL", name); throw e; } };
const said = "我周末去公园玩了，天气很好。", better = "我周末去公园逛了逛，天气特别好。";

t("cpIndexOf counts code points (astral chars) and respects `from`", () => {
  assert.equal(cpIndexOf("𠮷好好", "好"), 1); assert.equal(cpIndexOf("好好", "好", 1), 1); assert.equal(cpIndexOf("abc", ""), -1); assert.equal(cpIndexOf("abc", "z"), -1);
});
t("resolveSpan: valid offsets win; mismatching/out-of-range offsets fall back to search; missing -> null", () => {
  assert.deepEqual(resolveSpan(said, "玩了", 6, 8), [6, 8]);
  assert.deepEqual(resolveSpan(said, "玩了", 0, 2), [6, 8], "offsets that don't match the fragment are ignored");
  assert.deepEqual(resolveSpan(said, "玩了", 99, 120), [6, 8]);
  assert.deepEqual(resolveSpan(said, "", 0, 2), [0, 2], "offsets alone are trusted when no fragment is given");
  assert.equal(resolveSpan(said, "不在", undefined, undefined), null);
  assert.deepEqual(resolveSpan("好好", "好", undefined, undefined, 1), [1, 2], "search after the previous change");
});
t("segmentsOf: sorted, overlaps dropped, unmarked text kept", () => {
  assert.deepEqual(segmentsOf("abcdef", [[3, 4], [0, 1], [0, 2]]).map((s) => [s.text, s.mark]), [["a", true], ["bc", false], ["d", true], ["ef", false]]);
  assert.deepEqual(segmentsOf("ab", []), [{ text: "ab", mark: false }]);
  assert.deepEqual(segmentsOf("ab", [null, [5, 6]]), [{ text: "ab", mark: false }]);
});
t("normalizeUpgrade: with offsets", () => {
  const u = normalizeUpgrade({ said, better, betterPinyin: " wǒ ", changes: [{ from: "玩了", to: "逛了逛", fromStart: 6, fromEnd: 8, toStart: 6, toEnd: 9, kind: "word_choice", note: "n" }], sourceLines: [{ chunkIndex: 3, text: "周末的时候。", start: 0, end: 6 }] });
  assert.equal(u.betterPinyin, "wǒ"); assert.deepEqual(u.changes[0].fromSpan, [6, 8]); assert.deepEqual(u.changes[0].toSpan, [6, 9]);
  assert.equal(u.saidSegs.filter((s) => s.mark).map((s) => s.text).join(), "玩了"); assert.equal(u.betterSegs.filter((s) => s.mark).map((s) => s.text).join(), "逛了逛");
  assert.equal(u.saidSegs.map((s) => s.text).join(""), said); assert.equal(u.betterSegs.map((s) => s.text).join(""), better);
  assert.deepEqual(u.sourceLines, [{ text: "周末的时候。", start: 0, end: 6 }]);   // chunkIndex is never sent (72c25bd); offsets point into the script
});
t("normalizeUpgrade: no offsets -> substring search, two changes, string sourceLines", () => {
  const u = normalizeUpgrade({ said, better, changes: [{ from: "玩了", to: "逛了逛" }, { from: "很好", to: "特别好" }], sourceLines: ["  周末。 ", "", 5] });
  assert.deepEqual(u.changes.map((c) => [c.fromSpan, c.toSpan]), [[[6, 8], [6, 9]], [[11, 13], [12, 15]]]);
  assert.deepEqual(u.sourceLines, [{ text: "周末。", start: null, end: null }]);
  assert.equal(u.betterSegs.filter((s) => s.mark).length, 2);
});
t("normalizeUpgrade: unfindable change is listed but not highlighted; insert/delete sides", () => {
  const u = normalizeUpgrade({ said, better, changes: [{ from: "不在这里", to: "逛了逛" }, { from: "", to: "特别" }, {}, null] });
  assert.equal(u.changes.length, 2); assert.equal(u.changes[0].fromSpan, null); assert.deepEqual(u.changes[0].toSpan, [6, 9]);
  assert.equal(u.saidSegs.some((s) => s.mark), false);
});
t("normalizeUpgrade: null / garbage / identical / missing sides -> null; never throws", () => {
  for (const x of [null, undefined, 5, "x", {}, { said: 5, better: null }, { said, better: said }, { said: "", better }, { said, better: "  " }]) assert.equal(normalizeUpgrade(x), null);
  assert.deepEqual(normalizeUpgrade({ said, better, changes: "nope", sourceLines: {} }).changes, []);
});
t("readEvent(done) carries the normalised upgrade + reply pinyin", () => {
  const d = readEvent("done", { replyZh: "好", questionZh: "呢？", replyPinyin: "hǎo", questionPinyin: "ne？", upgrade: { said, better, changes: [{ from: "玩了", to: "逛了逛" }] } });
  assert.equal(d.replyPinyin, "hǎo"); assert.equal(d.questionPinyin, "ne？"); assert.equal(d.upgrade.better, better);
  assert.equal(readEvent("done", { upgrade: null }).upgrade, null);
});
t("phrasesToSave: each changed Chinese 'to' phrase with the better sentence as sourceChunk; else the whole sentence", () => {
  const u = normalizeUpgrade({ said, better, changes: [{ from: "玩了", to: "逛了逛" }, { from: "很好", to: "特别好" }, { from: "x", to: "逛了逛" }] });
  assert.deepEqual(phrasesToSave(u), [{ text: "逛了逛", pinyin: "", meaning: "", sourceChunk: better }, { text: "特别好", pinyin: "", meaning: "", sourceChunk: better }]);
  assert.deepEqual(phrasesToSave(normalizeUpgrade({ said, better, changes: [] })), [{ text: better, pinyin: "", meaning: "", sourceChunk: better }]);
  assert.deepEqual(phrasesToSave(null), []);
});
t("scriptLimitInfo: 3000 limit, under-1000 hint, over-by count", () => {
  assert.equal(SCRIPT_MAX, 3000);
  assert.deepEqual(scriptLimitInfo(0), { label: "0 / 3,000 characters", under: false, over: false, overBy: 0 });
  assert.equal(scriptLimitInfo(999).under, true); assert.equal(scriptLimitInfo(1000).under, false);
  assert.equal(scriptLimitInfo(3000).over, false); assert.deepEqual([scriptLimitInfo(3012).over, scriptLimitInfo(3012).overBy], [true, 12]);
  assert.equal(scriptLimitInfo(1156).label, "1,156 / 3,000 characters");
});

t("upgradeOf: status gates the card; onTopic tri-state; saveable shaped for /api/words (72c25bd)", () => {
  const up = { said, better, changes: [{ from: "玩了", to: "逛了逛" }], sourceLines: [{ text: "周末的时候。", start: 0, end: 6 }] };
  const sv = [{ text: "逛了逛", pinyin: "guàng le guàng", meaning: null, sourceChunk: "周末的时候。" }, { text: "逛了逛" }, { text: "" }];
  const ok = upgradeOf({ upgrade: up, upgradeStatus: "ok", onTopic: true, saveable: sv });
  assert.equal(ok.upgradeStatus, "ok"); assert.ok(ok.upgrade); assert.equal(ok.onTopic, true);
  assert.deepEqual(ok.saveable, [{ text: "逛了逛", pinyin: "guàng le guàng", meaning: "", sourceChunk: "周末的时候。" }]);
  for (const st of ["none", "ungrounded", "unavailable", "no_script", "skipped"]) { const r = upgradeOf({ upgrade: up, upgradeStatus: st }); assert.equal(r.upgrade, null); assert.equal(r.upgradeStatus, st); }
  assert.equal(upgradeOf({ upgrade: { said: 5 }, upgradeStatus: "ok" }).upgradeStatus, "none");
  assert.equal(upgradeOf({ onTopic: "yes" }).onTopic, null); assert.equal(upgradeOf({ onTopic: false }).onTopic, false); assert.equal(upgradeOf({}).onTopic, null);
  assert.equal(upgradeOf({ upgrade: up }).upgradeStatus, "ok");   // older server without upgradeStatus
  assert.deepEqual(normalizeSaveable("x"), []);
  assert.equal(readEvent("done", { upgrade: up, upgradeStatus: "ungrounded", onTopic: false }).upgrade, null);
  assert.equal(phrasesToSave(ok.upgrade, ok.saveable)[0].pinyin, "guàng le guàng");
});
t("upgradeNoteOf: soft notes only for ungrounded/unavailable/no_script and off-topic", () => {
  for (const st of ["ok", "none", "skipped"]) assert.equal(upgradeNoteOf(st, null), "");
  for (const st of ["ungrounded", "unavailable", "no_script"]) assert.ok(upgradeNoteOf(st, null).length > 10);
  assert.match(upgradeNoteOf("ok", false), /off your script's topic/); assert.equal(upgradeNoteOf("ok", true), "");
});
t("scriptForTalk: spoken text (directions stripped), NFC, trimmed; '' when over 3000", () => {
  const s = scriptForTalk("  [停顿]我喜欢[强调]周末。\n");
  assert.ok(!s.includes("[") && s.includes("我喜欢") && s.includes("周末") && s === s.trim());
  assert.equal(scriptForTalk(""), ""); assert.equal(scriptForTalk("好".repeat(3000)).length, 3000); assert.equal(scriptForTalk("好".repeat(3001)), "");
  assert.equal(scriptTooLongForTalk("好".repeat(3001)), true); assert.equal(scriptTooLongForTalk("好".repeat(3000)), false);
});
t("friendly 413 script_too_long / 400 invalid_context", () => {
  assert.match(talkErrorOf({ code: "script_too_long" }).message, /over 3,000 characters/);
  assert.match(talkErrorOf({ code: "invalid_context" }).message, /Reload/);
  assert.equal(talkErrorOf({ code: "script_too_long" }).retryable, false);
});
console.log(`talk-upgrade.test.mjs: ${n} tests passed`);
