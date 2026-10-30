// DEV/TEST ONLY. Tiny OpenAI-compatible fake for frontend tests (never used in production, not served by Express).
//   node fake-openai.mjs [port=8094]    then start the app with OPENAI_API_KEY=fake OPENAI_BASE_URL=http://127.0.0.1:8094/v1
// chat/completions -> grounded coach JSON built from the facts in the prompt, or a topic hint for level-3 cues;
// FAKE_TRANSCRIPT=... overrides the transcription text (lets the real server see omitted/substituted words).
// audio/speech -> a short quiet WAV (served as audio/mpeg; Chrome sniffs it), audio/transcriptions -> fixed text.
import http from "node:http";

function wav(ms = 450, hz = 440) {
  const sr = 8000, n = Math.floor((sr * ms) / 1000), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 600), 44 + i * 2);
  return buf;
}
const AUDIO = wav();
const port = Number(process.argv[2] || process.env.FAKE_OPENAI_PORT || 8094);

// Runtime control (dev only): POST /__fake {"transcript":"...","ideas":"cpm","language":true,"llmFail":true|false}.
//   ideas: one letter per key idea (a reference clause): c = covered (evidence quoted from the transcript), p = partial, m = missing, w = missing + wrong_meaning. Default "ccc".
//   language: add a "language" correction quoting the transcript. Only used for the retell meaning comparison (system prompt "compare the MEANING").
const ctl = { transcript: process.env.FAKE_TRANSCRIPT || "", ideas: process.env.FAKE_IDEAS || "", language: false, llmFail: false };
const HZ = /[\u3400-\u9fff]/;
// Q&A (real server qa.js prompts). ctl.qa = one letter per key point for the answer check: c covered, p partial, m missing, w missing + wrongFact; ctl.qaAnswered:false = off-topic/don't know.
ctl.qa = ""; ctl.qaAnswered = true;
const QTEXT = ["这段话讲了什么？", "他们是怎么做的？", "原文还说了什么？", "这里提到了什么事？"];
function qaQuestionJson(userJ) {
  const passage = String(userJ.passage || ""), avoid = userJ.avoid || [];
  const clauses = passage.split(/[，。！？；、,.!?;\s]+/).filter((c) => [...c].filter((x) => HZ.test(x)).length >= 2);
  const n = clauses.length, i0 = (avoid.length * 2) % Math.max(1, n);
  const kp = [clauses[i0], clauses[(i0 + 1) % n]].filter((x, k, a) => x && a.indexOf(x) === k);
  return { type: "what", questionZh: QTEXT[avoid.length % QTEXT.length], keyPoints: kp.map((q) => ({ refQuote: q })), modelAnswerZh: kp.join("，"), hintZh: "想一想这段话的开头。" };
}
function qaCheckJson(userJ) {
  const kps = userJ.keyPoints || [], tr = String(userJ.transcript || "");
  const codes = (ctl.qa || "c".repeat(kps.length)).split("");
  const ev = [...tr].filter((x) => HZ.test(x)).slice(0, 3).join("");
  const wrongFacts = [];
  const keyPoints = kps.map((k, i) => { const c = codes[i] || "c"; if (c === "w" && ev.length >= 2) wrongFacts.push({ claim: ev, contradicts: k.id, confidence: "high" }); return { id: k.id, covered: c === "c" ? true : c === "p" ? "partial" : false, evidence: c === "m" || c === "w" || !ev ? null : ev, confidence: "high" }; });
  return { answeredQuestion: ctl.qaAnswered !== false, keyPoints, wrongFacts };
}
function compareJson(sys, userJ) {
  const ref = String(userJ.reference || ""), tr = String(userJ.transcript || "");
  const clauses = ref.split(/[，。！？；、,.!?;\s]+/).filter((c) => [...c].filter((x) => HZ.test(x)).length >= 2).slice(0, 4);
  const codes = (ctl.ideas || "c".repeat(clauses.length)).split("");
  const ev = [...tr].filter((x) => HZ.test(x)).slice(0, 3).join("");
  const ideas = clauses.map((q, k) => { const c = codes[k] || "c"; return { id: `i${k + 1}`, textZh: [...q].slice(0, 8).join(""), refQuote: q, covered: c === "c" ? true : c === "p" ? "partial" : false, evidence: c === "m" || c === "w" ? null : ev, confidence: "high" }; });
  const corrections = [];
  codes.forEach((c, k) => { if (c === "w" && ideas[k]) corrections.push({ kind: "wrong_meaning", ideaId: ideas[k].id, quote: ev, explanationZh: "这里的意思和原文不一样。", modelText: ideas[k].refQuote }); });
  if (ctl.language && ev.length >= 2) corrections.push({ kind: "language", ideaId: null, quote: ev.slice(0, 2), explanationZh: "这个说法可以更自然一些。", modelText: clauses[0] || "" });
  return { ideas, corrections, summaryZh: "你把大意讲出来了。" };
}
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === "/__fake") { try { Object.assign(ctl, JSON.parse(body.toString() || "{}")); } catch { /* ignore */ } res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(ctl)); }
  if (req.url === "/v1/chat/completions") {
    const j = JSON.parse(body.toString());
    if (ctl.llmFail) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "fake llm down" } })); }
    const sys = j.messages?.[0]?.content || "";
    let content;
    if (/^TALK_OPEN/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } content = JSON.stringify({ textZh: `你好！我们聊聊${String(u.topic || "生活").slice(0, 12)}吧，你最近怎么样？` }); }
    else if (/^TALK_REPLY/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } content = JSON.stringify({ replyZh: "听起来很不错！", questionZh: ctl.talkQuestion || "你还做了什么有意思的事情？", ...(/SCRIPT MODE/.test(sys) ? { onTopic: ctl.talkOnTopic !== false } : {}) }); }
    else if (/^TALK_UPGRADE/.test(sys)) {   // backend 72c25bd upgrade call. ctl.talkUpgrade: "ok" (default) | "null" | "ungrounded" | "fail"; ctl.talkUpgradeMs delays it
      let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ }
      if (ctl.talkUpgradeMs) await new Promise((r) => setTimeout(r, +ctl.talkUpgradeMs));
      const said = String(u.learnerText || ""), script = String(u.script || ""), mode = ctl.talkUpgrade || "ok";
      const line = (script.match(/[^。！？\n]*周末的时候[^。！？\n]*[。！？]/) || [""])[0];
      if (mode === "fail") content = "not json {";
      else if (mode === "null" || !line || !said.includes("我周末")) content = JSON.stringify({ upgrade: null });
      else if (mode === "ungrounded") content = JSON.stringify({ upgrade: { said, better: said.replace("玩了", "跳舞唱歌弹钢琴"), changes: [{ from: "玩了", to: "跳舞唱歌弹钢琴", kind: "word_choice" }], sourceLines: [line] } });
      else content = JSON.stringify({ upgrade: { said, better: said.replace("我周末", "周末的时候，我"), changes: [{ from: "我周末", to: "周末的时候", kind: "word_choice", note: "Script wording." }], sourceLines: [line] } });
    }
    else if (/^TALK_FIND/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } const t = String(u.learnerText || ""); content = JSON.stringify(t.includes("玩了") && ctl.talkCorrect !== false ? { correction: { kind: "word_choice", quote: "玩了", betterZh: "逛了", explainZh: "这里换个词更自然。", confidence: "high" }, vocabHints: [], natural: false } : { correction: null, vocabHints: [], natural: true }); }
    else if (/^TALK_SUMMARY/.test(sys)) content = JSON.stringify({ takeaways: [{ textEn: "You described your weekend clearly.", textZh: "我周末去了公园。" }, { textEn: "You joined two ideas together.", textZh: "天气很好，所以我去了。" }, { textEn: "You kept the conversation going.", textZh: "我们聊得很开心。" }], newWords: [{ text: "爬山", meaning: "to go hiking", exampleZh: "周末我们去爬山。" }, { text: "逛公园", meaning: "to stroll in a park", exampleZh: "我喜欢逛公园。" }], phrasesToTry: [{ zh: "我觉得很放松。", en: "I feel very relaxed.", whyEn: "A natural way to say how you feel." }, { zh: "天气真好。", en: "The weather is great.", whyEn: "A common weather remark." }, { zh: "下次一起去吧。", en: "Let's go together next time.", whyEn: "A friendly invitation." }], strengths: ["You spoke in full sentences."] });
    else if (/ONE spoken comprehension question/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } content = JSON.stringify(qaQuestionJson(u)); }
    else if (/You check a Mandarin learner's spoken ANSWER/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } content = JSON.stringify(qaCheckJson(u)); }
    else if (/ONE Chinese word/.test(sys)) content = JSON.stringify({ hint: "生活" });
    else if (/compare the MEANING/.test(sys)) { let u = {}; try { u = JSON.parse(j.messages[1].content); } catch { /* ignore */ } content = JSON.stringify(compareJson(sys, u)); }
    else {
      let facts = { confirmedToneErrors: [], uncertain: [] };
      try { facts = JSON.parse(j.messages[1].content).facts || facts; } catch { /* ignore */ }
      const e = facts.confirmedToneErrors[0], u = facts.uncertain[0];
      const corrections = [];
      if (e) corrections.push({ kind: "tone", targetText: e.char, explanationZh: `“${e.char}”应该读第${["", "一", "二", "三", "四"][e.expectedTone] || ""}声，你读成了第${["", "一", "二", "三", "四"][e.heardTone] || ""}声。`, modelText: e.char, factRef: e.ref });
      else if (u) corrections.push({ kind: "model", targetText: u.char, explanationZh: `我不太确定“${u.char}”，再听一遍标准发音。`, modelText: u.char, factRef: u.ref });
      content = JSON.stringify({ praiseZh: e ? "说得不错，继续加油。" : "很好，发音很清楚。", corrections, nextPromptZh: "再说一遍吧。" });
    }
    if (!j.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 0; i < content.length; i += 9) { await new Promise((r) => setTimeout(r, 15)); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 9) } }] })}\n\n`); }
    res.write("data: [DONE]\n\n"); return res.end();
  }
  if (req.url === "/v1/audio/speech") { res.writeHead(200, { "Content-Type": "audio/mpeg" }); return res.end(AUDIO); }
  if (req.url === "/v1/audio/transcriptions") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ text: ctl.transcript || "我们今天练习中文。" })); }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1", () => console.log(`fake openai on ${port}`));
