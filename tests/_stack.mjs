// Shared harness for the headless-Chrome tests that need a REAL backend (in-process: fake OpenAI/TTS/STT, mock assessment engine, no keys,
// no network) serving the real public/ files. Chrome's fake mic device records real audio; /api/tts and /api/audio/* are intercepted in the
// browser and answered with a playable WAV (the fake servers only return undecodable fake mp3 bytes) with a per-text delay.
// Headless Chrome with --autoplay-policy=no-user-gesture-required does NOT enforce iOS's autoplay rules: these tests prove OUR logic
// (states, ordering, same element, caching), never iOS behaviour. Run via: PW_DIR=/tmp/pw node tests/<file>.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PW_DIR ? process.env.PW_DIR + '/' : import.meta.url);
const { chromium } = require('playwright-core');
const { startTestServer } = await import('../server/test/helpers.js');
const { startFakeServices } = await import('../server/test/fake-services.js');

export function wav(sec = 1.0, rate = 22050) {
  const n = Math.floor(rate * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.2 * 32767), 44 + i * 2);
  return b;
}

export const CHUNK = '小明早上起床，骑自行车去学校，在学校学习数学。';
export const CHUNK2 = '他的妈妈是医生，每天在医院工作。';
export const NEXT = (over = {}) => ({ type: 'what', questionZh: '小明每天都做些什么？', keyPoints: [{ refQuote: '早上起床' }, { refQuote: '骑自行车去学校' }, { refQuote: '在学校学习数学' }],
  modelAnswerZh: '小明早上起床，骑自行车去学校，在学校学习数学。', hintZh: '想一想他从早到晚的三件事。', ...over });
export const CHECK = () => ({ answeredQuestion: true, keyPoints: [
  { id: 'k1', covered: true, evidence: '早上起来', confidence: 'high' }, { id: 'k2', covered: true, evidence: '骑车去学校', confidence: 'high' },
  { id: 'k3', covered: true, evidence: '上课学数学', confidence: 'high' }], wrongFacts: [] });

/** opts.ttsDelay(text) -> ms for the mocked /api/tts (default 0); opts.wavSec. Returns the stack with helpers. */
export async function startStack({ ttsDelay = () => 0, wavSec = 1.0, next = () => NEXT(), check = CHECK } = {}) {
  const svc = await startFakeServices();
  svc.state.sttText = '小明早上起来，骑车去学校，上课学数学。';
  svc.state.chatScript = (j) => JSON.stringify(j.messages[0].content.includes('ONE spoken') ? next(j) : check(j));
  const t = await startTestServer({ ASSESSMENT_ENGINE: 'mock', OPENAI_API_KEY: 'sk-fakeopenaikey0123456789', OPENAI_BASE_URL: svc.openaiBase, PUBLIC_DIR: path.join(here, '..', 'public') });
  await t.login();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const WAV = wav(wavSec);
  const stack = { t, svc, browser, base: t.base, reqs: [], tts: [], ttsDelay, ttsFail: false,
    async close() { await browser.close(); await t.close(); await svc.close(); } };
  stack.newPage = async ({ ttsMode } = {}) => {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
    const [name, value] = t.cookie().split('=');
    await ctx.addCookies([{ name, value, url: t.base }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) stack.reqs.push({ method: r.method(), path: u.pathname, at: Date.now() }); });
    await page.route('**/api/tts', async (route) => {
      let text = ''; try { text = JSON.parse(route.request().postData() || '{}').text || ''; } catch { /* */ }
      const rec = { text, start: Date.now(), end: 0 }; stack.tts.push(rec);
      const d = stack.ttsDelay(text, stack.tts.length - 1); if (d) await new Promise((r) => setTimeout(r, d));
      rec.end = Date.now();
      if (stack.ttsFail) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV });
    });
    await page.route('**/api/audio/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
    await page.addInitScript(() => {
      window.__streams = [];
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__streams.push(s); return s; };
      window.__micLive = () => window.__streams.some((s) => s.getTracks().some((tr) => tr.readyState === 'live'));
      // object URL accounting (blob: URLs that were created and revoked)
      window.__urls = { created: [], revoked: [] };
      const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = c(b); window.__urls.created.push({ url: u, type: b.type, size: b.size }); return u; };
      URL.revokeObjectURL = (u) => { window.__urls.revoked.push(u); return r(u); };
      // Simulate iOS-style autoplay rejection of REAL (non-priming) plays: window.__rejectPlays = N rejects the next N plays that are not the silent prime loop.
      window.__rejectPlays = 0; window.__playLog = []; window.__playEls = new Set();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__playEls.add(this);
        window.__playLog.push({ t: performance.now(), loop: this.loop, src: String(this.src).slice(0, 30) });
        if (!this.loop && window.__rejectPlays > 0) { window.__rejectPlays--; return Promise.reject(new DOMException('The request is not allowed by the user agent', 'NotAllowedError')); }
        return play.call(this);
      };
    });
    await page.goto(t.base + '/');
    await page.waitForFunction(() => window.__coach && window.__coach.S);
    return { page, ctx, errors };
  };
  return stack;
}

export function reporter() {
  const results = [];
  return { check(name, ok, extra = '') { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); },
    done() { const bad = results.filter((x) => !x).length; console.log(`\n${results.length - bad}/${results.length} passed`); return bad; } };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
