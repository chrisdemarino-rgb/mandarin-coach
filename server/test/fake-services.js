// Fake OpenAI-compatible + Azure TTS servers for tests. Records requests; never needs real keys.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeServices() {
  const state = { chatScript: null, chatStatus: 200, sttText: '我们今天练习中文。', sttDelayMs: 0, sttStatus: 200, ttsStatus: 200, azureStatus: 200, chatDelayMs: 0,
    requests: [], jsonCalls: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const rec = { url: req.url, headers: req.headers, body };
    state.requests.push(rec);
    const fakeMp3 = (txt) => Buffer.concat([Buffer.from('ID3FAKE'), crypto.createHash('sha1').update(txt).digest()]);

    if (req.url === '/v1/chat/completions') {
      if (state.chatStatus !== 200) { res.writeHead(state.chatStatus, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"boom sk-leakleakleak1234"}}'); }
      const j = JSON.parse(body.toString()); rec.json = j;
      const content = typeof state.chatScript === 'function' ? state.chatScript(j) : state.chatScript;
      if (!j.stream) { state.jsonCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = content ?? '{}';
      for (let i = 0; i < text.length; i += 9) {
        if (state.chatDelayMs) await new Promise((r) => setTimeout(r, state.chatDelayMs));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 9) } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n'); return res.end();
    }
    if (req.url === '/v1/audio/transcriptions') {
      if (state.sttDelayMs) await new Promise((r) => setTimeout(r, state.sttDelayMs));
      if (state.sttStatus !== 200) { res.writeHead(state.sttStatus); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: state.sttText }));
    }
    if (req.url === '/v1/audio/speech') {
      if (state.ttsStatus !== 200) { res.writeHead(state.ttsStatus); return res.end('nope'); }
      rec.json = JSON.parse(body.toString());
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(fakeMp3(rec.json.input));
    }
    if (req.url === '/cognitiveservices/v1') {
      if (state.azureStatus !== 200) { res.writeHead(state.azureStatus); return res.end('nope'); }
      rec.ssml = body.toString();
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(fakeMp3(rec.ssml));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, openaiBase: `${origin}/v1`, azureBase: origin, state, reset() { state.requests.length = 0; state.jsonCalls = 0; state.chatStatus = 200; state.sttStatus = 200; state.ttsStatus = 200; state.azureStatus = 200; state.chatDelayMs = 0; state.sttText = '我们今天练习中文。'; state.sttDelayMs = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
