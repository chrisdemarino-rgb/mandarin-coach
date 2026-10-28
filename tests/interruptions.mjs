// Headless-Chrome test for the "false interruption pause" fix (audio.js v7 + session.js + app.js).
// Run:  PW_DIR=/tmp/pw node app/tests/interruptions.mjs          (starts its own static server on a free port; mocks /api/*)
// Needs playwright-core (PW_DIR/node_modules) and google-chrome. Chrome has NO real navigator.audioSession: this test installs a FAKE
// EventTarget with type/state and drives its 'statechange' by hand. It proves our logic (ours vs real, debounce, auto-resume at the same
// chunk), NOT how iOS behaves. Real-device confirmation: docs/IOS-AUDIO-NOTES.md ("False 'audio was interrupted' pause").
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PW_DIR ? process.env.PW_DIR + '/' : import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// 1.2 s 440 Hz wav for the mocked /api/tts (so "prompting" lasts a moment and the real play()/mic-release path runs).
function wav(sec = 1.2, rate = 22050) {
  const n = Math.floor(rate * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.2 * 32767), 44 + i * 2);
  return b;
}
const WAV = wav();
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.normalize(path.join(root, p.endsWith('/') ? p + 'index.html' : p));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

async function newPage(url) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let ttsCalls = 0;
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url()).pathname;
    const json = (o, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (u === '/api/tts') { ttsCalls++; return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); }
    if (u === '/api/me') return json({ ok: true });
    if (u === '/api/health') return json({ ok: true, mock: false });
    if (u === '/api/prefs') return json({});
    if (u.startsWith('/api/words')) return json([]);
    return json({}, 404);
  });
  // Fake navigator.audioSession (Chrome has none) + remember every mic stream so the test can poke the live track.
  await page.addInitScript(() => {
    const as = new EventTarget(); as.type = 'auto'; as.state = 'active';
    Object.defineProperty(navigator, 'audioSession', { value: as, configurable: true });
    window.__setAS = (st) => { as.state = st; as.dispatchEvent(new Event('statechange')); };
    window.__streams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__streams.push(s); return s; };
    let hidden = false; window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__coach && window.__coach.S);
  return { page, ctx, errors, ttsCalls: () => ttsCalls };
}
const st = (page) => page.evaluate(() => ({ s: window.__coach.S.state, c: window.__coach.S.chunkIdx, p: window.__coach.S.pieceIdx, reason: window.__coach.S.pauseReason, pend: window.__coach.S.autoResumePending, rec: null }));
const waitState = (page, want, ms = 8000) => page.waitForFunction((w) => window.__coach.S.state === w, want, { timeout: ms }).then(() => true, () => false);
// Session says 'listening' slightly before MediaRecorder is actually running (450ms guard + getUserMedia), so wait for the recorder too.
const waitRecording = (page, ms = 6000) => page.evaluate(async (ms) => {
  const A = await import('/js/audio.js'); const end = Date.now() + ms;
  while (Date.now() < end) { if (A.getState() === 'recording') return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
}, ms);
const events = (page) => page.evaluate(() => window.__audioEvents.map(e => `${e.verdict}:${e.name}`));
const SCRIPT = '你好。我是学生。我喜欢学习中文。今天天气很好。我们一起练习吧。';

// ---------------------------------------------------------------- debug panel: hidden unless ?debug=1
{
  const a = await newPage(base + '/index.html');
  await a.page.waitForTimeout(500);
  check('no debug panel by default', await a.page.evaluate(() => !document.getElementById('audioDebugPanel')));
  check('window.__audioEvents exists by default', await a.page.evaluate(() => Array.isArray(window.__audioEvents)));
  await a.ctx.close();
  const b = await newPage(base + '/index.html?debug=1');
  await b.page.waitForSelector('#audioDebugPanel', { timeout: 5000 }).then(() => check('?debug=1 shows the panel', true), () => check('?debug=1 shows the panel', false));
  await b.ctx.close();
}

// ---------------------------------------------------------------- main scenarios
const { page, errors, ttsCalls } = await newPage(base + '/index.html');
await page.evaluate(async (script) => {
  const S = window.__coach.S; S.loadScript(script);
  await S.start();
}, SCRIPT);

// 1) Our own mic release + playback start/stop with iOS-style audioSession noise around them: NO pause.
await page.evaluate(() => { window.__setAS('inactive'); });                       // what iOS reports when we stop the mic
await page.waitForTimeout(200);
await page.evaluate(() => { window.__setAS('interrupted'); });                    // transient 'interrupted' during playback start
await page.waitForTimeout(600);
await page.evaluate(() => { window.__setAS('active'); });                         // ... which clears by itself
await page.waitForTimeout(2600);                                                  // beyond the debounce
let s = await st(page);
check('own mic stop/playback + transient audioSession <2s: not paused', s.s !== 'paused', JSON.stringify(s));
check('session reached listening after the coach audio', await waitState(page, 'listening'));
let ev = await events(page);
check('ring buffer logged our own actions', ev.some(e => e.startsWith('ours:own:mic-stop:before-playback')) && ev.some(e => e === 'ours:own:playback-start'));
check('transient interrupted was debounced', ev.some(e => e === 'debounced:audioSession'));
check('nothing was declared REAL', !ev.some(e => e.startsWith('REAL:')), ev.filter(e => e.startsWith('REAL')).join());

// move to a later chunk so "same position" means something
await page.evaluate(() => window.__coach.S.jumpTo(Math.min(1, window.__coach.S.chunks.length - 1)));
check('listening again after jumpTo', await waitState(page, 'listening'));
await page.waitForTimeout(500);
const base0 = await st(page); const tts0 = ttsCalls();
console.log('  position before interruptions:', JSON.stringify(base0), 'tts calls', tts0);

await waitRecording(page);
// 2) Mic stop of an OLD (stale) track firing 'ended', and 'mute' while NOT ours-relevant but transient: no pause.
await page.evaluate(() => { const old = window.__streams[0].getAudioTracks()[0]; old.dispatchEvent(new Event('ended')); });
await page.evaluate(() => { const t = window.__streams[window.__streams.length - 1].getAudioTracks()[0]; t.dispatchEvent(new Event('mute')); setTimeout(() => t.dispatchEvent(new Event('unmute')), 500); });
await page.waitForTimeout(2600);
s = await st(page); check('stale-track ended + transient mute: still listening', s.s === 'listening', JSON.stringify(s));

// 3) Brief hide (< hiddenMs): no pause.
await page.evaluate(() => window.__setHidden(true)); await page.waitForTimeout(700); await page.evaluate(() => window.__setHidden(false));
await page.waitForTimeout(2200);
s = await st(page); check('page hidden <1s: still listening', s.s === 'listening', JSON.stringify(s));

// 4) Persistent audioSession 'interrupted' (> debounce): pause, then auto-resume at the same chunk with no coach replay.
await page.evaluate(() => window.__setAS('interrupted'));
check('persistent interrupted -> paused', await waitState(page, 'paused', 4000));
s = await st(page); check('paused with auto-resume armed and soft hint (no manual banner)', s.pend === true && !s.reason.startsWith('Paused:'), s.reason);
await page.evaluate(() => window.__setAS('active'));
check('audioSession active again -> auto-resumed to listening', await waitState(page, 'listening', 5000));
s = await st(page); check('same chunk/piece after auto-resume', s.c === base0.c && s.p === base0.p, JSON.stringify(s));
check('coach audio was NOT replayed on resume', ttsCalls() === tts0, `tts calls ${ttsCalls()} vs ${tts0}`);
check('recorder running again', await waitRecording(page));

// 5) Hidden > 2 s: pause, then auto-resume when visible.
await page.evaluate(() => window.__setHidden(true));
check('hidden >1.5s -> paused', await waitState(page, 'paused', 4000));
await page.evaluate(() => window.__setHidden(false));
check('visible again -> auto-resumed', await waitState(page, 'listening', 5000));
s = await st(page); check('same chunk/piece after hidden resume', s.c === base0.c && s.p === base0.p, JSON.stringify(s));

await waitRecording(page);
// 6) Persistent mic mute while recording: pause, unmute -> auto-resume.
await page.evaluate(() => { const t = window.__streams[window.__streams.length - 1].getAudioTracks()[0]; Object.defineProperty(t, 'muted', { get: () => window.__muted === true, configurable: true }); window.__muted = true; t.dispatchEvent(new Event('mute')); });
check('persistent mute -> paused', await waitState(page, 'paused', 4000));
await page.evaluate(() => { window.__muted = false; window.__streams[window.__streams.length - 1].getAudioTracks()[0].dispatchEvent(new Event('unmute')); });
check('unmute -> auto-resumed', await waitState(page, 'listening', 5000));

await waitRecording(page);
// 7) Real mic 'ended' that we did not cause: pause, NOT auto-resumed (nothing says the mic is back); manual Resume continues at the same chunk.
await page.evaluate(() => { window.__streams[window.__streams.length - 1].getAudioTracks()[0].dispatchEvent(new Event('ended')); });
check('unexpected mic ended -> paused', await waitState(page, 'paused', 3000));
await page.waitForTimeout(1500);
s = await st(page); check('still paused (manual Resume needed) with clear message', s.s === 'paused' && s.reason.startsWith('Paused:'), s.reason);
await page.evaluate(() => window.__coach.S.resume());
check('manual Resume -> listening', await waitState(page, 'listening', 5000));
s = await st(page); check('same chunk/piece after manual Resume', s.c === base0.c && s.p === base0.p, JSON.stringify(s));

// 8) Our own stop of a take / playback after all of that still works (record path not regressed): stop recording -> processing/error, no crash.
await waitRecording(page);
const take = await page.evaluate(async () => { const A = await import('/js/audio.js'); await new Promise(r => setTimeout(r, 1200)); const r = await A.stopRecording(); return { valid: r.valid, size: r.blob.size, reason: r.reason }; });
check('take after resume is a valid recording', take.valid === true && take.size > 500, JSON.stringify(take));

ev = await events(page); if (process.env.DUMP) console.log((await page.evaluate(() => window.__audioEvents.map(e => JSON.stringify(e)))).slice(-40).join('\n'));
console.log('  events (REAL / recovered):', ev.filter(e => /^(REAL|recovered):/.test(e)).join(', '));
const real = errors.filter(e => !/404/.test(e)); check('no page errors', real.length === 0, real.join(' | '));
await browser.close(); server.close();
const failed = results.filter(r => !r).length;
console.log(failed ? `FAILED ${failed}/${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
