// DEV-ONLY fixture wrapper. NOT part of the shipped app and the shipped server is not modified.
// Sits in front of a running app instance (default http://127.0.0.1:8093, mock engine) and:
//   * proxies everything unchanged (cookies/login/SSE included),
//   * adds the proposed/confirmed word-level fields to POST /api/attempt's SSE (`wordStatus`, `savedMissed`, `facts.insertedText`, gate),
//   * implements GET /api/words/missed, POST /api/words/missed/:id/known|learning, DELETE .../:id, GET /api/drill/next, POST /api/drill/attempt
//     with an in-memory list, until the real Backend has them (shape: see js/api-words.js header).
// Control:  POST /__fixture/mode {"attempt":"issues|clean|gate|none","drill":"correct|wrong|gate|alternate","unsupported":true|false,"reset":true}
// Run:  node fixture-backend.mjs [listenPort=8095] [targetPort=8093]      then open http://localhost:8095
import http from "node:http";

const LISTEN = Number(process.argv[2] || 8095), TARGET = Number(process.argv[3] || 8093);
const NEEDED = 3;
const mode = { attempt: "issues", drill: "correct", unsupported: false, retell: "", qa: "missing", qaHints: "backend", qaAnswer: "assessment", qaUnsupported: false, qaTranscript: "", talk: "ok", talkUnsupported: false, talkOpening: "ok", talkSummary: "ok", talkTranscript: "", talkSlow: 0 };   // retell: "" | "tone_flagged" | "tone_unflagged" | "legacy" (only touches basis:"transcript" assessments)
let words = [];  // {id,text,pinyin,meaning,missCount,correctStreak,needed,lastMissedAt,sourceChunk,status}
let seq = 0, attemptNo = 0, drillNo = 0, talkNo = 0;
const last = { qaChunkText: null, qaFields: [], attemptChunkText: null, talkContext: null, talkFields: [], talkAttemptIds: [], talkTurnCalls: 0, talkOpeningBody: null, talkSummaryBody: null, talkSummaryCalls: 0 };   // what the frontend sent (GET /__fixture/last)
const seen = new Map();   // attemptId -> response body (replay)

const readBody = (req) => new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...extra }); res.end(JSON.stringify(obj)); };
const field = (buf, name) => { const m = buf.toString("latin1").match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`)); return m ? Buffer.from(m[1], "latin1").toString("utf8") : ""; };

async function authed(req) {
  try { const r = await fetch(`http://127.0.0.1:${TARGET}/api/me`, { headers: { cookie: req.headers.cookie || "" } }); return r.ok; } catch { return false; }
}
let pinyinPro = null;
try { pinyinPro = await import("pinyin-pro"); } catch {}
const pinyinOf = (t, num = true) => (pinyinPro ? pinyinPro.pinyin(t, { toneType: num ? "num" : "symbol" }) : "");
const HAN = /[\u3400-\u9fff]/;

/** Split chunkText into 2-character "words" (punctuation skipped); code-point offsets, end exclusive. */
function wordsOf(chunkText) {
  const cps = [...chunkText], out = []; let i = 0;
  while (i < cps.length) {
    if (!HAN.test(cps[i])) { i++; continue; }
    let j = i + 1; if (j < cps.length && HAN.test(cps[j])) j++;
    out.push({ start: i, end: j, text: cps.slice(i, j).join("") }); i = j;
  }
  return out;
}
/** Clauses of chunkText with >= 2 hanzi (code-point offsets, end exclusive; the trailing punctuation is excluded). */
function clausesOf(chunkText) {
  const cps = [...chunkText], out = []; let st = -1;
  for (let i = 0; i <= cps.length; i++) {
    const isHan = i < cps.length && HAN.test(cps[i]);
    if (isHan && st < 0) st = i;
    if (!isHan && st >= 0) { if (i - st >= 2) out.push({ start: st, end: i, text: cps.slice(st, i).join("") }); st = -1; }
  }
  return out.slice(0, 6);
}
function addMissed(text, sourceChunk) {
  let w = words.find((x) => x.text === text);
  if (!w) { w = { id: `m${++seq}`, text, pinyin: pinyinOf(text, false), meaning: null, missCount: 0, correctStreak: 0, needed: NEEDED, lastMissedAt: new Date().toISOString(), sourceChunk, status: "learning" }; words.push(w); }
  w.missCount++; w.correctStreak = 0; w.status = "learning"; w.lastMissedAt = new Date().toISOString();
  words.sort((a, b) => b.missCount - a.missCount);
  return w;
}

function transformAttempt(body, chunkText, attemptId) {
  attemptNo++;
  const m = mode.attempt;
  const strip = (d) => { delete d.wordStatus; delete d.savedMissed; if (d.facts) delete d.facts.insertedText; return d; };
  const blocks = body.replace(/\r\n/g, "\n").split("\n\n").filter(Boolean);
  const ws = wordsOf(chunkText);
  const flagged = [];
  let wcInfo = null;
  const out = blocks.map((b) => {
    const nm = (b.match(/^event: (.+)$/m) || [])[1];
    if (nm === "done" && wcInfo) { const dd = JSON.parse((b.match(/^data: (.*)$/m) || [])[1] || "{}"); dd.corrections = [{ kind: wcInfo.status, targetText: wcInfo.text, heard: wcInfo.heard, start: wcInfo.start, end: wcInfo.end, factRef: "reuse:0", source: "server_fact" }]; return `event: done\ndata: ${JSON.stringify(dd)}`; }
    if (nm !== "assessment") return b;
    const dm = b.match(/^data: (.*)$/m); const d = strip(JSON.parse(dm[1]));
    if (d.basis === "transcript" && mode.retell) {
      const han = [...(d.referenceText || d.transcript || "")].filter((c) => HAN.test(c));
      if (mode.retell.startsWith("tone_") && han.length) {
        d.facts = { ...(d.facts || {}), confirmedToneErrors: [{ index: 0, char: han[0], pinyin: pinyinOf(han[0]), expectedTone: 3, heardTone: 4, ref: "t0" }] };
        if (Array.isArray(d.syllables) && d.syllables[0]) d.syllables[0].tone = { ...(d.syllables[0].tone || {}), decision: "review", expected: 3, heard: 4 };
        if (mode.retell === "tone_unflagged") delete d.lowConfidence;
      }
      if (mode.retell.startsWith("wordcheck")) {   // reused-phrase word check (backend 855030d): one script word swapped; praise blocked everywhere
        const hanIdx = [...chunkText].map((c, i) => (HAN.test(c) ? i : -1)).filter((i) => i >= 0), st = hanIdx[Math.min(2, hanIdx.length - 2)], text = [...chunkText].slice(st, st + 2).join("");
        const hi = mode.retell === "wordcheck_medium" ? "medium" : "high", status = mode.retell === "wordcheck_missed" ? "missed" : "substituted";
        d.wordStatus = [{ start: st, end: st + 2, text, pinyin: pinyinOf(text, false), status, ...(status === "missed" ? { reason: "omitted" } : { heard: "谩骂" }), source: "stt", confidence: status === "missed" ? "medium" : hi, detail: "fixture", reuse: true }];
        d.facts = { ...(d.facts || {}), substitutedWords: status === "substituted" ? [{ ref: "reuse:0", text, start: st, end: st + 2, heard: "谩骂", confidence: hi }] : [], missingWords: status === "missed" ? [{ ref: "reuse:0", text, start: st, end: st + 2 }] : [], completeness: "incomplete", canPraise: false, reusedPhrase: { findings: 1, inserted: [] } };
        d.savedMissed = [addMissed(text, chunkText)].map((w) => ({ id: w.id, text: w.text, pinyin: w.pinyin, meaning: null, reason: status, start: st, end: st + 2, missCount: w.missCount, isNew: true }));
        if (d.retell) { d.retell.canPraise = false; d.retell.praiseLevel = "soft"; d.retell.praiseBlockedBy = ["word_check"]; d.retell.wordCheck = { status: "found", count: 1 }; d.retell.suggestedWords = [{ text, pinyin: pinyinOf(text), meaning: "fixture meaning", reason: status === "missed" ? "omitted" : "substituted", ideaId: "i1" }, ...(d.retell.suggestedWords || [])].slice(0, 3); }
        wcInfo = { text, start: st, end: st + 2, heard: "谩骂", status };
      }
      if (mode.retell === "legacy") delete d.retell;   // pre-`retell`-block backend: the UI must fall back to omission corrections
      return `event: assessment\ndata: ${JSON.stringify(d)}`;
    }
    if (m === "gate") { d.matchesText = false; d.gate = "low_match"; d.gateMessage = "That recording doesn't seem to match the sentence (or I couldn't hear speech). Please say the sentence again."; return `event: assessment\ndata: ${JSON.stringify(d)}`; }
    if (m === "issues") {
      d.wordStatus = ws.map((w, k) => {
        const base = { ...w, pinyin: pinyinOf(w.text), source: "both", confidence: "high" };
        if (k === 1) { flagged.push(w); return { ...base, status: "missed", reason: "omitted" }; }
        if (k === 2) { flagged.push(w); return { ...base, status: "wrong", reason: "tone" }; }
        if (k === 3) { flagged.push(w); return { ...base, status: "substituted", heard: "天空", source: "stt" }; }
        if (k === 4) return { ...base, status: "uncertain", reason: "final", confidence: "low" };
        return { ...base, status: "ok" };
      });
      d.facts = { ...(d.facts || {}), canPraise: false, completeness: "incomplete", insertedText: "嗯", missingWords: flagged.slice(0, 1).map((w) => w.text) };
      d.savedMissed = flagged.map((w) => addMissed(w.text, chunkText)).map((w) => ({ id: w.id, text: w.text }));
    } else if (m === "none") { /* nothing added: the UI must behave exactly as before */ } else if (m === "clean") d.wordStatus = ws.map((w) => ({ ...w, pinyin: pinyinOf(w.text), status: "ok" }));
    return `event: assessment\ndata: ${JSON.stringify(d)}`;
  });
  return out.join("\n\n") + "\n\n";
}

// ------------------------------------------------------------------ Free talk (Backend working-tree shape, services/talk.js + routes/talk.js, 28 Oct)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (ev, d) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
const TALK_TRANSCRIPTS = ["我周末去公园玩了，天气很好。", "我和朋友一起吃了饺子，很好吃。", "下个周末我想去爬山。"];
const TALK_REPLIES = [["听起来很不错！", "你在公园里做了什么？"], ["饺子是我最喜欢的。", "你们在哪儿吃的？"], ["爬山很有意思。", "你想去哪座山？"]];
function wavBuf(ms = 400) { const n = Math.floor(8000 * ms / 1000), b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; }
const notFound = (res) => json(res, 404, { error: { code: "not_found", message: "Not found" } });
async function talkRoute(req, res, p) {
  if (p === "/__fixture/talk.wav") { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wavBuf().length }); return res.end(wavBuf()); }
  if (mode.talkUnsupported) { await readBody(req); return notFound(res); }
  if (!(await authed(req))) { await readBody(req); return json(res, 401, { error: { code: "unauthorized", message: "Sign in required." } }); }
  if (p === "/api/talk/opening") {
    const b = JSON.parse((await readBody(req)).toString() || "{}"); last.talkOpeningBody = b;
    if (mode.talkSlow) await sleep(mode.talkSlow);
    if (mode.talkOpening === "fail") return json(res, 502, { ok: false, error: { code: "opening_generation_failed", message: "Could not produce an opening (opening_failed). Try again." } });
    return json(res, 200, { ok: true, textZh: `你好！我们聊聊${b.topic || "你的生活"}吧，你最近怎么样？`, pinyin: "nǐ hǎo! wǒ men liáo liáo ba, nǐ zuì jìn zěn me yàng?", textAudio: { url: "/__fixture/talk.wav" }, timings: {} });
  }
  if (p === "/api/talk/summary") {
    const b = JSON.parse((await readBody(req)).toString() || "{}"); last.talkSummaryBody = b; last.talkSummaryCalls++;
    if (mode.talkSlow) await sleep(mode.talkSlow);
    if (mode.talkSummary === "error") return json(res, 502, { ok: false, error: { code: "summary_generation_failed", message: "Could not produce a summary (summary_failed). Try again." } });
    if (mode.talkSummary === "empty") return json(res, 200, { ok: true, takeaways: [], newWords: [], phrasesToTry: [], strengths: [] });
    return json(res, 200, { ok: true, takeaways: [{ textEn: "You described what you did over the weekend clearly.", textZh: "我周末去了公园。", pinyin: "wǒ zhōu mò qù le gōng yuán." }, { textEn: "You linked two ideas with a reason.", textZh: "天气很好，所以我去了。", pinyin: "tiān qì hěn hǎo, suǒ yǐ wǒ qù le." }],
      newWords: [{ text: "爬山", pinyin: "pá shān", meaning: "to go hiking", exampleZh: "周末我们去爬山。" }, { text: "饺子", pinyin: "jiǎo zi", meaning: "dumplings", exampleZh: "我喜欢吃饺子。", savedMeaning: mode.talkSummary === "saved" ? "dumplings" : undefined }],
      phrasesToTry: [{ zh: "我觉得很放松。", pinyin: "wǒ jué de hěn fàng sōng.", en: "I feel very relaxed.", whyEn: "Describes how an activity felt." }], strengths: ["You kept the conversation going with full sentences."], statsDerived: { turns: (b.turns || []).length, userTurns: (b.turns || []).filter((t) => t.role === "user").length, approxCharsSpoken: 20 }, timings: {} });
  }
  if (p === "/api/talk/turn") {
    const buf = await readBody(req); last.talkTurnCalls++;
    last.talkFields = [...buf.toString("latin1").matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    try { last.talkContext = JSON.parse(field(buf, "context")); } catch { last.talkContext = null; }
    const attemptId = field(buf, "attemptId"); last.talkAttemptIds.push(attemptId);
    const done = seen.get("talk:" + attemptId);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...(done ? { "X-Attempt-Replayed": "true" } : {}) });
    if (done) return res.end(done);
    const n = talkNo++, m = mode.talk;
    const wait = async (ms = 120) => sleep(ms + (mode.talkSlow || 0) / 4);
    let out = ""; const w = async (ev, d, ms) => { const chunk = sse(ev, d); out += chunk; res.write(chunk); await wait(ms); };
    await w("status", { stage: "transcribing" });
    if (m === "stt_error") { await w("error", { code: "transcription_failed", message: "Could not transcribe your speech.", retryable: true, canSkip: true, stage: "transcribing" }); return res.end(); }
    if (m === "too_long") { await w("error", { code: "talk_turn_too_long", message: "That turn is too long to coach.", retryable: false, canSkip: true, stage: "transcribing" }); return res.end(); }
    const gate = m === "gate";
    const text = mode.talkTranscript || TALK_TRANSCRIPTS[n % TALK_TRANSCRIPTS.length];
    await w("transcript", { text: gate ? "谢谢观看" : text, sttStatus: gate ? "hallucination" : "ok", hanziCount: gate ? 4 : [...text].length, hasEnglish: false });
    await w("status", { stage: "coaching" });
    if (gate) {
      await w("status", { stage: "coaching", skipped: true, code: "no_speech", message: "Nothing usable was heard." });
      await w("coach_text", { delta: "我没有听清楚，请再说一遍。", index: 0, role: "gate" }); await w("coach_audio", { url: "/__fixture/talk.wav", index: 0, text: "我没有听清楚，请再说一遍。" });
      await w("done", { gate: "hallucination", correction: null, correctionStatus: "skipped", suggestedWords: [], replyZh: null, questionZh: null, timings: {}, summary: { coached: false } });
      seen.set("talk:" + attemptId, out); return res.end();
    }
    if (m === "llm_down") { await w("error", { code: "talk_llm_unavailable", message: "The coach could not reply right now (llm_failed). No reply was made up.", retryable: true, canSkip: true, stage: "coaching" }); return res.end(); }
    const [reply, question] = TALK_REPLIES[n % TALK_REPLIES.length];
    await w("coach_text", { delta: reply, index: 0, role: "reply" }); await w("coach_audio", { url: "/__fixture/talk.wav", index: 0, text: reply });
    let idx = 1, correction = null, suggestedWords = [];
    if (m === "correction") {
      correction = { kind: "word_choice", quote: "玩了", betterZh: "逛了", explainZh: "这里换个词更自然。", pinyin: "guàng le" };
      await w("coach_text", { delta: correction.explainZh, index: idx, role: "correction", caption: "逛了 guàng le" }); await w("coach_audio", { url: "/__fixture/talk.wav", index: idx++, text: correction.explainZh });
      await w("coach_text", { delta: "可以这样说：逛了", index: idx, role: "correction_model", caption: "逛了 guàng le" }); await w("coach_audio", { url: "/__fixture/talk.wav", index: idx++, text: "可以这样说：逛了" });
      suggestedWords = [{ text: "逛公园", pinyin: "guàng gōng yuán", meaning: "to stroll around a park", reason: "word_choice" }];
    }
    await w("coach_text", { delta: question, index: idx, role: "question" }); await w("coach_audio", { url: "/__fixture/talk.wav", index: idx, text: question });
    await w("done", { correction, correctionStatus: correction ? "ok" : "none", suggestedWords, vocabHints: [], replyZh: reply, questionZh: question, timings: {}, summary: { coached: true, tone: "skipped" } });
    seen.set("talk:" + attemptId, out); return res.end();
  }
  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/__fixture/last") return json(res, 200, last);
    if (p === "/__fixture/mode" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (b.reset) { words = []; seq = 0; attemptNo = 0; drillNo = 0; seen.clear(); talkNo = 0; Object.assign(last, { talkContext: null, talkFields: [], talkAttemptIds: [], talkTurnCalls: 0, talkOpeningBody: null, talkSummaryBody: null, talkSummaryCalls: 0 }); }
      for (const k of ["attempt", "drill", "unsupported", "retell", "qa", "qaHints", "qaAnswer", "qaUnsupported", "qaTranscript", "talk", "talkUnsupported", "talkOpening", "talkSummary", "talkTranscript", "talkSlow"]) if (b[k] !== undefined) mode[k] = b[k];
      if (Array.isArray(b.seed)) for (const t of b.seed) { const w = addMissed(t, `例句：${t}很重要。`); w.missCount = 2; }
      return json(res, 200, { mode, words: words.length });
    }
    if (p.startsWith("/api/talk/") || p === "/__fixture/talk.wav") return talkRoute(req, res, p);
    const fx = p.startsWith("/api/words/missed") || p.startsWith("/api/drill/");
    if (fx && !(await authed(req))) return json(res, 401, { error: { code: "unauthorized", message: "Sign in required." } });
    if (fx && mode.unsupported) return json(res, 404, { error: { code: "not_found", message: "Not found" } });

    if (req.method === "GET" && p === "/api/words/missed") {
      const all = url.searchParams.get("all") === "1";
      return json(res, 200, words.filter((w) => all || w.status === "learning").sort((a, b) => b.missCount - a.missCount));
    }
    let m;
    if ((m = p.match(/^\/api\/words\/missed\/([^/]+)\/(known|learning)$/)) && req.method === "POST") {
      const w = words.find((x) => x.id === m[1]); if (!w) return json(res, 404, { error: { code: "not_found", message: "No such word" } });
      w.status = m[2]; if (m[2] === "learning") w.correctStreak = 0; res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/api\/words\/missed\/([^/]+)$/)) && req.method === "DELETE") { words = words.filter((x) => x.id !== m[1]); res.writeHead(204); return res.end(); }
    if (req.method === "GET" && p === "/api/drill/next") {
      const n = Math.min(Number(url.searchParams.get("n") || 5), 20);
      return json(res, 200, words.filter((w) => w.status === "learning").slice(0, n).map((w) => ({ wordId: w.id, text: w.text, pinyin: w.pinyin, meaning: w.meaning, exampleSentence: w.sourceChunk, promptText: [...w.text].length >= 2 ? w.text : w.sourceChunk, correctStreak: w.correctStreak, needed: w.needed })));
    }
    if (req.method === "POST" && p === "/api/drill/attempt") {
      const buf = await readBody(req);
      const wordId = field(buf, "wordId"), attemptId = field(buf, "attemptId");
      const w = words.find((x) => x.id === wordId);
      if (!w) return json(res, 404, { error: { code: "not_found", message: "No such word" } });
      if (seen.has(attemptId)) { res.writeHead(200, { "Content-Type": "text/event-stream", "X-Attempt-Replayed": "true" }); return res.end(seen.get(attemptId)); }
      drillNo++;
      const gated = mode.drill === "gate";
      const correct = gated ? false : mode.drill === "correct" ? true : mode.drill === "wrong" ? false : drillNo % 2 === 1;
      let graduated = false;
      if (gated) { /* not counted */ } else if (correct) { w.correctStreak++; if (w.correctStreak >= w.needed) { w.status = "known"; graduated = true; } } else { w.correctStreak = 0; w.missCount++; }
      const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
      const body = ev("status", { stage: "assessing" }) + ev("assessment", { status: "ok", engine: "mock", mock: true, overall: null, syllables: [], facts: { confirmedToneErrors: [], uncertain: [] }, referenceText: w.text })
        + ev("coach_text", { delta: correct ? (graduated ? "太棒了！你已经学会这个词了。" : "很好，再来一次。") : "再试一次，注意声调。", index: 0, role: "coach" })
        + ev("done", { correct, counted: !gated, ...(gated ? { reason: "low_match" } : {}), wordId: w.id, correctStreak: w.correctStreak, needed: w.needed, graduated, timings: { totalMs: 5 } });
      seen.set(attemptId, body);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      await new Promise((r) => setTimeout(r, 400));
      return res.end(body);
    }


    /* ---- Q&A: mirrors the Backend's working-tree shape (routes/qa.js, 28 Oct, uncommitted): stateless signed question, keyPoints with code-point offsets into chunks[0]. ---- */
    if (p === "/api/qa/next" || p === "/api/qa/attempt") {
      if (!(await authed(req))) return json(res, 401, { error: { code: "unauthorized", message: "Sign in required." } });
      if (mode.qaUnsupported) return json(res, 404, { error: { code: "not_found", message: "Not found" } });
    }
    if (req.method === "POST" && p === "/api/qa/next") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const err = (st, code, message) => json(res, st, { ok: false, error: { code, message } });
      if (mode.qa === "next_fail") return err(502, "question_generation_failed", "Could not produce a question with grounded key points (malformed_output). Try again.");
      if (!Array.isArray(b.chunks) || !b.chunks.length) return err(400, "invalid_chunks", "chunks must be an array of 1-80 strings.");
      const chunk = String(b.chunks[0]), cl = clausesOf(chunk);
      if ([...chunk].filter((c) => HAN.test(c)).length < 6 || !cl.length) return err(400, "chunks_too_short", "No chunk has at least 6 Chinese characters to ask about.");
      const c = cl[(b.avoid || []).length % cl.length], cps = [...chunk], half = Math.max(1, Math.floor((c.end - c.start) / 2));
      const kp = (k, s0, e0) => ({ id: `k${k}`, textZh: cps.slice(s0, e0).join(""), refStart: s0, refEnd: e0, chunkIndex: 0 });
      const keyPoints = [kp(1, c.start, c.start + half), ...(c.end - c.start - half >= 1 ? [kp(2, c.start + half, c.end)] : [])];
      const hex = [...c.text].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7).toString(16).padStart(8, "0") + String((b.avoid || []).length).padStart(4, "0");
      const q = { questionId: `q${hex}`, type: "what", level: 1, questionZh: `原文里，关于“${c.text.slice(0, 2)}”说了什么？`, modelAnswerZh: c.text, hintZh: mode.qaHints === "none" ? "" : `想一想“${c.text.slice(0, 1)}”后面是什么。`, sourceChunkIndex: 0, keyPoints };
      const out = { ok: true, ...q, signature: "fixture-signature", questionPinyin: pinyinOf(q.questionZh, false) };
      if (!out.hintZh) delete out.hintZh;
      return json(res, 200, out);
    }
    if (req.method === "POST" && p === "/api/qa/attempt") {
      const buf = await readBody(req);
      const attemptId = field(buf, "attemptId"), q = JSON.parse(field(buf, "question") || "null");
      last.qaChunkText = field(buf, "chunkText") || null; last.qaFields = [...buf.toString("latin1").matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
      if (seen.has(attemptId)) { res.writeHead(200, { "Content-Type": "text/event-stream", "X-Attempt-Replayed": "true" }); return res.end(seen.get(attemptId)); }
      const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
      let body;
      if (!q || !Array.isArray(q.keyPoints)) body = ev("error", { code: "invalid_question", message: "question payload is incomplete or malformed.", retryable: false, stage: "assessment" });
      else if (mode.qa === "no_speech") body = ev("status", { stage: "transcribing" }) + ev("error", { code: "no_speech_detected", message: "I couldn't hear Mandarin speech in that recording. Try again.", retryable: true, stage: "transcribing" });
      else if (mode.qa === "error") body = ev("error", { code: "assessment_unavailable", message: "No assessment obtained: the answer check was unavailable (malformed_output) and no tone check was possible.", retryable: true, stage: "assessment" });
      else if (mode.qa === "too_long") body = ev("status", { stage: "transcribing" }) + ev("error", { code: "qa_answer_too_long", message: "That answer is too long to check (over 300 characters heard). Answer in one or two sentences.", retryable: false, stage: "transcribing" });
      else {
        const transcript = mode.qaTranscript || "我觉得是这样的。";
        const cov = { covered: [true, true], missing: [true, false], partial: [true, "partial"], wrong: [true, false], dont_know: [false, false] }[mode.qa] || [true, true];
        const kps = q.keyPoints.map((k, i) => ({ ...k, covered: cov[i] === undefined ? true : cov[i], evidence: cov[i] === false ? null : "我说了这个意思", confidence: "high", ...(mode.qa === "wrong" && i === 1 ? { issue: "wrong_fact" } : {}) }));
        const unavailable = mode.qa === "unavailable";
        const answered = mode.qa !== "dont_know";
        const wc = mode.qa.startsWith("wordcheck");
        let wcw = null;
        if (wc) { const k0 = q.keyPoints[0], text = [...k0.textZh].slice(0, 2).join(""); wcw = { start: k0.refStart, end: k0.refStart + 2, text, pinyin: pinyinOf(text, false), status: mode.qa === "wordcheck_missed" ? "missed" : "substituted", ...(mode.qa === "wordcheck_missed" ? { reason: "omitted" } : { heard: "谩骂" }), source: "stt", confidence: mode.qa === "wordcheck_medium" || mode.qa === "wordcheck_missed" ? "medium" : "high", detail: "fixture", reuse: true, chunkIndex: 0, keyPointId: k0.id }; }
        const wrongFacts = mode.qa === "wrong" ? [{ claimZh: "我觉得是别的", contradictsKeyPointId: "k2", confidence: "high" }] : [];
        const missing = kps.filter((x) => x.covered === false);
        const full = !unavailable && answered && !wc && kps.every((x) => x.covered === true);
        const qa = unavailable
          ? { questionId: q.questionId, transcript, sttStatus: "ok", tone: { status: "skipped" }, modelAnswerZh: q.modelAnswerZh, keyPoints: q.keyPoints.map((k) => ({ ...k, covered: null, evidence: null, confidence: null })), coveredCount: 0, totalCount: q.keyPoints.length, partialCount: 0, wrongFacts: [], answeredQuestion: null, answerKind: null, canPraise: false, praiseLevel: "none", comparisonStatus: "unavailable", comparisonReason: "malformed_output", missingKeyPointIds: [], suggestedWords: [] }
          : { questionId: q.questionId, transcript, sttStatus: "ok", tone: { status: "skipped", reason: "transcript_has_digits_or_latin" }, modelAnswerZh: q.modelAnswerZh, keyPoints: kps, coveredCount: kps.filter((x) => x.covered === true).length, totalCount: kps.length, partialCount: kps.filter((x) => x.covered === "partial").length, wrongFacts, answeredQuestion: answered, answerKind: answered ? "answered" : "dont_know", canPraise: full, praiseLevel: full ? "full" : missing.length || !answered ? "none" : "soft", ...(wc ? { praiseBlockedBy: ["word_check"], wordCheck: { status: "found", count: 1 } } : {}), comparisonStatus: "ok", comparisonReason: null, missingKeyPointIds: missing.map((x) => x.id), suggestedWords: missing.slice(0, 1).map((k) => ({ text: [...k.textZh].slice(0, 2).join(""), pinyin: pinyinOf([...k.textZh].slice(0, 2).join(""), false), meaning: null, keyPointId: k.id })) };
        const lines = wc ? ["有个词和原文不一样。", `你说的是“${wcw.heard || ""}”，原文是“${wcw.text}”。`, `应该这样说：${wcw.text}`, "来下一个问题吧。"] : unavailable ? ["这次没能检查你的回答。", "再试一次，或者下一个问题。"] : !answered ? ["没关系，这个问题还没答出来。", "想要提示，就点提示；也可以再试一次。"] : full ? ["回答得很好，要点都讲到了。", "来下一个问题吧。"] : ["有一个要点没讲到。", `漏掉了这个要点：${(missing[0] || kps[1] || kps[0]).textZh}`, "再试一次，或者下一个问题。"];
        body = ev("status", { stage: "transcribing" }) + ev("status", { stage: "assessing", detail: "answer" })
          + ev("assessment", { status: "ok", engine: "mock", mock: true, lowConfidence: true, basis: "transcript", transcript, transcriptDerived: true, qa, ...(wc ? { wordStatus: [wcw], facts: { substitutedWords: wcw.status === "substituted" ? [{ ref: "reuse:0", text: wcw.text, start: wcw.start, end: wcw.end, heard: wcw.heard, chunkIndex: 0, keyPointId: wcw.keyPointId }] : [], missingWords: wcw.status === "missed" ? [{ ref: "reuse:0", text: wcw.text }] : [], completeness: "incomplete", canPraise: false, reusedPhrase: { findings: 1, inserted: [] } }, savedMissed: [(() => { const w = addMissed(wcw.text, last.qaChunkText || ""); return { id: w.id, text: w.text, pinyin: wcw.pinyin, meaning: null, reason: wcw.status, start: wcw.start, end: wcw.end, missCount: w.missCount, isNew: true }; })()] } : {}) })
          + ev("status", { stage: "coaching" })
          + lines.map((t, k) => ev("coach_text", { delta: t, index: k, role: k === 0 ? "opener" : "coach" })).join("")
          + ev("done", { summary: { comparisonStatus: qa.comparisonStatus }, timings: { totalMs: 5 }, ...(wc ? { corrections: [{ kind: wcw.status, targetText: wcw.text, heard: wcw.heard, start: wcw.start, end: wcw.end, chunkIndex: 0, keyPointId: wcw.keyPointId, factRef: "reuse:0", source: "server_fact" }] } : {}) });
      }
      seen.set(attemptId, body);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      await new Promise((r) => setTimeout(r, 500));
      return res.end(body);
    }

    // attempt: proxy, then enrich the SSE
    if (req.method === "POST" && p === "/api/attempt") {
      const buf = await readBody(req);
      const r = await fetch(`http://127.0.0.1:${TARGET}${req.url}`, { method: "POST", headers: { ...req.headers, host: `127.0.0.1:${TARGET}` }, body: buf, duplex: "half" });
      const text = await r.text();
      const heads = {}; r.headers.forEach((v, k) => { if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k)) heads[k] = v; });
      res.writeHead(r.status, heads);
      return res.end((r.headers.get("content-type") || "").includes("event-stream") ? transformAttempt(text, field(buf, "chunkText"), field(buf, "attemptId")) : text);
    }

    // everything else: plain streaming proxy
    const pr = http.request({ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${TARGET}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    pr.on("error", () => { if (!res.headersSent) json(res, 502, { error: { message: "target down" } }); else res.end(); });
    req.pipe(pr);
  } catch (e) { if (!res.headersSent) json(res, 500, { error: { code: "fixture", message: String(e && e.message || e) } }); else res.end(); }
});
server.listen(LISTEN, "127.0.0.1", () => console.log(`fixture backend on :${LISTEN} -> :${TARGET}`));
