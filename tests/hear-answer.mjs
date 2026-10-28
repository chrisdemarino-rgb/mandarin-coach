// Headless-Chrome test for the "Hear answer does not play / error, then plays ~15 s later" fix (api.js shared tts, audio.prime(), tts-player.js, qa.js, ui/qa.js).
// Run:  PW_DIR=/tmp/pw node app/tests/hear-answer.mjs      (own in-process backend on a free port, mocked slow /api/tts; see tests/_stack.mjs)
// HONEST LIMIT: headless Chrome here runs with --autoplay-policy=no-user-gesture-required, so it can NOT reproduce iOS's gesture rule. What it proves:
// the button shows Loading and is disabled, the SAME single <audio> element is primed inside the tap and then plays the clip, the first sentence plays
// before the rest are fetched, a rejected play() (simulated NotAllowedError) leaves "Tap to retry" and a retry plays, and prefetch makes a later tap instant.
import { startStack, reporter, sleep, CHUNK, CHUNK2 } from './_stack.mjs';
const R = reporter(); const check = R.check;
const ANSWER = '小明早上起床，骑自行车去学校，在学校学习数学。';

const s = await startStack({ wavSec: 1.0 });
const btn = (page) => page.evaluate(() => { const b = document.querySelector('#btnQaHearAnswer'); return { text: b.textContent.trim(), disabled: b.disabled }; });
const waitBtn = (page, re, ms = 9000) => page.waitForFunction((src) => { const b = document.querySelector('#btnQaHearAnswer'); return new RegExp(src).test(b.textContent); }, re.source, { timeout: ms }).then(() => true, () => false);
async function toAnswerShown(page) {
  await page.evaluate((txt) => { const { S } = window.__coach; S.loadScript(txt); S.setQaMode(true); }, CHUNK + CHUNK2);
  await page.click('.tab[data-view="practice"]');
  await page.click('#btnQaPrimary');
  await page.waitForFunction(() => window.__coach.Q.state === 'ready', null, { timeout: 15000 });
  await page.evaluate(() => document.addEventListener('click', () => { window.__tap = performance.now(); }, true));
  await page.click('#btnQaAnswer');
  await page.waitForSelector('#btnQaHearAnswer', { state: 'visible' });
}
const answerReqs = () => s.tts.filter((t) => t.text === ANSWER);

try {
  // ------------------------------------------------------------ 1. slow server: Loading state, primed shared element, no duplicate request, plays when ready
  s.ttsDelay = (text) => (text === ANSWER ? 4000 : 0);
  {
    const { page, errors } = await s.newPage();
    await toAnswerShown(page);
    const ready0 = await page.evaluate(() => window.__coach.Q.answerPhase);
    check('answer prefetch started when the question arrived (before any tap)', answerReqs().length === 1 && ready0 === 'idle', `reqs=${answerReqs().length}`);
    await page.click('#btnQaHearAnswer');
    const b1 = await btn(page);
    check('tap while fetching -> "Loading audio…" and button disabled', /Loading audio/.test(b1.text) && b1.disabled, JSON.stringify(b1));
    const during = await page.evaluate(() => { const els = [...window.__playEls]; const e = els[0]; return { n: els.length, paused: e && e.paused, loop: e && e.loop, micLive: window.__micLive() }; });
    check('inside the tap the shared <audio> was primed (playing silent loop) and the mic is released', during.n === 1 && during.paused === false && during.loop === true && during.micLive === false, JSON.stringify(during));
    await page.evaluate(() => document.querySelector('#btnQaHearAnswer').click()); await sleep(100);
    check('second tap while loading is ignored: still exactly ONE /api/tts request for the answer', answerReqs().length === 1, `reqs=${answerReqs().length}`);
    const okPlay = await waitBtn(page, /Stop/, 9000);
    const rec = answerReqs()[0];
    const playing = await page.evaluate(() => { const els = [...window.__playEls]; const e = els[0]; return { n: els.length, paused: e.paused, loop: e.loop, blob: String(e.src).startsWith('blob:'), real: window.__playLog.filter((p) => !p.loop).length }; });
    check('clip plays on the SAME single element after the fetch ("■ Stop" shown, loop cleared)', okPlay && playing.n === 1 && !playing.paused && !playing.loop && playing.blob && playing.real >= 1, JSON.stringify(playing));
    const lag = await page.evaluate(() => window.__playLog.filter((p) => !p.loop && p.t > window.__tap).map((p) => p.t)[0]);
    check('answer was fetched in ~4 s (mock) and playback began right after the fetch (<700 ms)', rec.end > 0 && Date.now() - rec.end < 20000 && (await page.evaluate(() => performance.timeOrigin)) + lag - rec.end < 700, `end->play=${Math.round((await page.evaluate(() => performance.timeOrigin)) + lag - rec.end)}ms`);
    const ended = await waitBtn(page, /Hear answer/, 6000);
    check('after the clip ends the button returns to "Hear answer" (enabled)', ended && !(await btn(page)).disabled);
    check('no page errors', errors.length === 0, errors.join('|'));
    const hearsReal = await page.evaluate(() => window.__audioEvents.filter((e) => e.verdict === 'REAL').length);
    check('no interruption was judged REAL during playback', hearsReal === 0);
    await page.context().close();
  }

  // ------------------------------------------------------------ 2. rejected play() (simulated iOS NotAllowedError): Tap to retry, retry plays; no refetch
  s.tts.length = 0; s.ttsDelay = () => 0;
  {
    const { page } = await s.newPage();
    await toAnswerShown(page); await sleep(400);
    await page.evaluate(() => { window.__rejectPlays = 2; });   // the first play and the automatic retry are refused
    await page.click('#btnQaHearAnswer');
    const gotRetry = await waitBtn(page, /Tap to retry/, 5000);
    const notice = await page.evaluate(() => (document.querySelector('#qaNotice') || {}).textContent || '');
    check('rejected play() -> button says "Tap to retry" (not a dead end)', gotRetry && !(await btn(page)).disabled, notice);
    const before = answerReqs().length;
    await page.evaluate(() => { window.__rejectPlays = 0; });
    await page.click('#btnQaHearAnswer');
    const playingAgain = await waitBtn(page, /Stop|Hear answer/, 5000); await sleep(200);
    const st = await page.evaluate(() => ({ n: [...window.__playEls].length, real: window.__playLog.filter((p) => !p.loop).length }));
    check('retry tap plays (same single element) with no new /api/tts request (clip was cached)', playingAgain && st.n === 1 && st.real >= 3 && answerReqs().length === before, JSON.stringify(st));
    await waitBtn(page, /Hear answer/, 4000);
    // Stop toggle
    await page.click('#btnQaHearAnswer'); const isStop = await waitBtn(page, /Stop/, 3000);
    await page.click('#btnQaHearAnswer'); const back = await waitBtn(page, /Hear answer/, 3000);
    check('Stop toggle stops playback and restores the label', isStop && back);
    // server failure -> retry label, then recover
    await page.context().close();
  }

  // ------------------------------------------------------------ 2b. server error -> Tap to retry -> recovers
  s.tts.length = 0;
  {
    s.ttsDelay = (t) => (t === ANSWER ? 3000 : 0); s.ttsFail = false;
    const { page } = await s.newPage();
    await toAnswerShown(page);
    s.ttsFail = true;               // the in-flight prefetch (started at question arrival) will fail when it completes
    await page.click('#btnQaHearAnswer');
    const failed = await waitBtn(page, /Tap to retry/, 8000);
    check('server error on the clip -> "Tap to retry"', failed);
    s.ttsFail = false; s.ttsDelay = () => 0;
    await page.click('#btnQaHearAnswer');
    check('retry after the server recovers plays', await waitBtn(page, /Stop|Hear answer/, 4000) && (await page.evaluate(() => window.__playLog.filter((p) => !p.loop).length)) >= 1);
    await page.context().close();
  }

  // ------------------------------------------------------------ 3. prefetch: a later tap is instant (no fetch, plays within the tap)
  s.tts.length = 0; s.ttsDelay = (t) => (t === ANSWER ? 300 : 0);
  {
    const { page } = await s.newPage();
    await toAnswerShown(page); await sleep(1200);
    check('answer clip was prefetched into memory before the tap', answerReqs().length === 1 && answerReqs()[0].end > 0);
    await page.evaluate(() => { window.__playLog.length = 0; });
    await page.click('#btnQaHearAnswer');
    await sleep(150);
    const r = await page.evaluate(() => ({ real: window.__playLog.filter((p) => !p.loop).map((p) => p.t - window.__tap), primes: window.__playLog.filter((p) => p.loop).length, text: document.querySelector('#btnQaHearAnswer').textContent.trim() }));
    check('tap after prefetch: playback starts in <250 ms, no prime/loading, no new request', r.real.length >= 1 && r.real[0] < 250 && r.primes === 0 && answerReqs().length === 1 && /Stop/.test(r.text), JSON.stringify(r));
    await page.context().close();
  }

  // ------------------------------------------------------------ 4. chunking: first sentence plays before the rest are fetched; queued on the same element
  s.tts.length = 0;
  {
    const LONG = '小明早上起床，然后骑自行车去学校。到了学校以后，他先和同学们一起读书、背诵课文，然后认真地听老师讲数学课。中午他在食堂吃饭，下午上体育课和美术课。放学之后，他还要留下来打扫教室，最后才回家吃晚饭。回到家里，他先做完作业，再帮妈妈洗菜做饭。晚上他会看一会儿书，然后早早睡觉。';
    const { page } = await s.newPage();
    const pieces = await page.evaluate(async (t) => (await import('/js/tts-player.js')).splitForTts(t), LONG);
    check('long answer is split into >=3 chunks, first one short', pieces.length >= 3 && [...pieces[0]].length <= 36 && pieces.join('') === LONG, JSON.stringify(pieces.map((p) => [...p].length)));
    s.ttsDelay = (t) => (t === pieces[0] ? 0 : 2500);
    const t0 = Date.now();
    await page.evaluate((t) => { window.__done = false; window.__events = []; import('/js/tts-player.js').then((m) => m.speak(t, { onPhase: (p) => window.__events.push([p, performance.now()]) }).then(() => { window.__done = true; })); }, LONG);
    await page.waitForFunction(() => window.__playLog.some((p) => !p.loop), null, { timeout: 8000 });
    const firstPlayAt = Date.now() - t0;
    const rest = s.tts.filter((x) => x.text !== pieces[0]);
    check('first chunk plays before the later chunks have been fetched', firstPlayAt < 1500 && rest.length >= 2 && rest.every((x) => x.end === 0 || x.end > t0 + firstPlayAt), `first play after ${firstPlayAt}ms; later chunks requested in parallel=${rest.length}`);
    await page.waitForFunction(() => window.__done, null, { timeout: 20000 });
    const q = await page.evaluate(() => ({ els: [...window.__playEls].length, plays: window.__playLog.filter((p) => !p.loop).length }));
    check('all chunks played in order on the one shared element', q.els === 1 && q.plays === pieces.length, JSON.stringify(q));
    await page.context().close();
  }
} catch (e) { console.log('FAIL exception', e && e.stack || e); R.check('no exception', false); }
await s.close();
const bad = R.done(); process.exit(bad ? 1 : 0);
