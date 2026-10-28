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

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === "/v1/chat/completions") {
    const j = JSON.parse(body.toString());
    const sys = j.messages?.[0]?.content || "";
    let content;
    if (/ONE Chinese word/.test(sys)) content = JSON.stringify({ hint: "生活" });
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
  if (req.url === "/v1/audio/transcriptions") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ text: process.env.FAKE_TRANSCRIPT || "我们今天练习中文。" })); }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1", () => console.log(`fake openai on ${port}`));
