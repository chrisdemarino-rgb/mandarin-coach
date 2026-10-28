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
const mode = { attempt: "issues", drill: "correct", unsupported: false, retell: "" };   // retell: "" | "tone_flagged" | "tone_unflagged" | "legacy" (only touches basis:"transcript" assessments)
let words = [];  // {id,text,pinyin,meaning,missCount,correctStreak,needed,lastMissedAt,sourceChunk,status}
let seq = 0, attemptNo = 0, drillNo = 0;
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
  const out = blocks.map((b) => {
    const nm = (b.match(/^event: (.+)$/m) || [])[1];
    if (nm !== "assessment") return b;
    const dm = b.match(/^data: (.*)$/m); const d = strip(JSON.parse(dm[1]));
    if (d.basis === "transcript" && mode.retell) {
      const han = [...(d.referenceText || d.transcript || "")].filter((c) => HAN.test(c));
      if (mode.retell.startsWith("tone_") && han.length) {
        d.facts = { ...(d.facts || {}), confirmedToneErrors: [{ index: 0, char: han[0], pinyin: pinyinOf(han[0]), expectedTone: 3, heardTone: 4, ref: "t0" }] };
        if (Array.isArray(d.syllables) && d.syllables[0]) d.syllables[0].tone = { ...(d.syllables[0].tone || {}), decision: "review", expected: 3, heard: 4 };
        if (mode.retell === "tone_unflagged") delete d.lowConfidence;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/__fixture/mode" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (b.reset) { words = []; seq = 0; attemptNo = 0; drillNo = 0; seen.clear(); }
      for (const k of ["attempt", "drill", "unsupported", "retell"]) if (b[k] !== undefined) mode[k] = b[k];
      if (Array.isArray(b.seed)) for (const t of b.seed) { const w = addMissed(t, `例句：${t}很重要。`); w.missCount = 2; }
      return json(res, 200, { mode, words: words.length });
    }
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
