// Headless-Chrome test for "Hear my recording" (hear-mine.js + audio.js play()/stop() + session/drill/qa wiring) in all four result views:
// close rehearsal, natural retelling, Q&A, trouble-word drill.  Run: PW_DIR=/tmp/pw node app/tests/hear-mine.mjs   (in-process backend, see tests/_stack.mjs)
// Proves OUR logic: button present/hidden/disabled states, playback through the ONE shared <audio> element with a correctly typed blob URL, mic released,
// Stop toggle, object URLs revoked on stop/next take/session end, and NO request to any upload/assessment/tts endpoint while the user's own audio plays.
// It does not (cannot) prove iOS routing or the iOS autoplay rule: headless Chrome ignores it. See docs/IOS-AUDIO-NOTES.md.
import { startStack, reporter, sleep, CHUNK, CHUNK2 } from './_stack.mjs';
const R = reporter(); const check = R.check;
const SCRIPT = '你好。我是学生。我喜欢学习中文。今天天气很好。我们一起练习吧。';
const s = await startStack({ wavSec: 1.0 });
s.t.db.recordMiss({ text: '学校', pinyin: 'xué xiào', meaning: 'school', sourceChunk: CHUNK });

const UPLOADS = /^\/api\/(attempt|qa\/attempt|drill\/attempt|tts|stt|upload)/;
const uploadsSince = (n) => s.reqs.slice(n).filter((r) => UPLOADS.test(r.path));
const waitFor = (page, fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const rec = (page, ms = 1700) => page.evaluate(async (ms) => {   // wait until the recorder is really running, then talk (fake mic) for ms
  const A = await import('/js/audio.js'); const end = Date.now() + 8000;
  while (Date.now() < end && A.getState() !== 'recording') await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, ms)); return A.getState();
}, ms);

/** views: each describes how to reach "result", the take's url, the button, how to start the next take and how to end. */
const VIEWS = {
  close: {
    btn: '#btnHearMine',
    async toResult(page) {
      await page.evaluate((t) => { const { S } = window.__coach; S.loadScript(t); }, SCRIPT);
      await page.click('.tab[data-view="practice"]');
      await page.evaluate(() => window.__coach.S.start());
      await waitFor(page, () => window.__coach.S.state === 'listening');
      await rec(page); await page.evaluate(() => window.__coach.S.stopRecording());
      return waitFor(page, () => window.__coach.S.state === 'result');
    },
    take: (page) => page.evaluate(() => window.__coach.S.recording && window.__coach.S.recording.url),
    coachIdle: (page) => waitFor(page, () => !window.__coach.S.coachPlaying, null, 15000),
    next: (page) => page.evaluate(() => window.__coach.S.retry()),
    recording: (page) => waitFor(page, () => window.__coach.S.state === 'listening'),
    end: (page) => page.evaluate(() => window.__coach.S.finish()),
  },
  retell: {
    btn: '#btnHearMine',
    async toResult(page) {
      await page.evaluate((t) => { const { S } = window.__coach; S.loadScript(t); S.setAssessMode('retell'); S.ackRetellIntro(); }, CHUNK);
      await page.click('.tab[data-view="practice"]');
      await page.evaluate(() => window.__coach.S.start());
      await waitFor(page, () => ['listening', 'ready'].includes(window.__coach.S.state), null, 15000);
      await rec(page, 2500); await page.evaluate(() => window.__coach.S.stopRecording());
      return waitFor(page, () => window.__coach.S.state === 'result', null, 20000);
    },
    take: (page) => page.evaluate(() => window.__coach.S.recording && window.__coach.S.recording.url),
    coachIdle: (page) => waitFor(page, () => !window.__coach.S.coachPlaying, null, 15000),
    next: (page) => page.evaluate(() => window.__coach.S.retry()),
    recording: (page) => waitFor(page, () => ['listening', 'ready'].includes(window.__coach.S.state)),
    end: (page) => page.evaluate(() => window.__coach.S.finish()),
  },
  qa: {
    btn: '#btnQaHearMine',
    async toResult(page) {
      await page.evaluate((t) => { const { S } = window.__coach; S.loadScript(t); S.setQaMode(true); }, CHUNK + CHUNK2);
      await page.click('.tab[data-view="practice"]'); await page.click('#btnQaPrimary');
      await waitFor(page, () => window.__coach.Q.state === 'ready');
      await page.evaluate(() => window.__coach.Q.record());
      await rec(page, 2000); await page.evaluate(() => window.__coach.Q.stop());
      return waitFor(page, () => window.__coach.Q.state === 'result', null, 20000);
    },
    take: (page) => page.evaluate(() => window.__coach.Q.recording && window.__coach.Q.recording.url),
    coachIdle: (page) => waitFor(page, () => !window.__coach.Q.coachPlaying, null, 15000),
    next: (page) => page.evaluate(() => window.__coach.Q.retry()),
    recording: (page) => waitFor(page, () => ['ready', 'asking'].includes(window.__coach.Q.state)),
    end: (page) => page.evaluate(() => window.__coach.Q.finish()),
  },
  drill: {
    btn: '#btnDrillHearMine',
    async toResult(page) {
      await page.evaluate(() => { window.__coach.S.loadMissed(); document.body.dataset.view = 'drill'; });
      await page.evaluate(() => window.__coach.D.start());
      await waitFor(page, () => window.__coach.D.state === 'ready', null, 15000);
      await page.evaluate(() => window.__coach.D.record());
      await rec(page, 1500); await page.evaluate(() => window.__coach.D.stop());
      return waitFor(page, () => window.__coach.D.state === 'result', null, 20000);
    },
    take: (page) => page.evaluate(() => window.__coach.D.recording && window.__coach.D.recording.url),
    coachIdle: (page) => waitFor(page, () => !window.__coach.D.coachPlaying, null, 15000),
    next: (page) => page.evaluate(() => window.__coach.D.retry()),
    recording: (page) => waitFor(page, () => ['ready', 'listening', 'prompting'].includes(window.__coach.D.state)),
    end: (page) => page.evaluate(() => window.__coach.D.leave()),
  },
};

const label = (page, sel) => page.evaluate((sel) => { const b = document.querySelector(sel); return { text: b.textContent.trim(), disabled: b.disabled, hidden: b.hidden, visible: !!(b.offsetParent) }; }, sel);
const waitLabel = (page, sel, re, ms = 6000) => page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel).textContent), [sel, re.source], { timeout: ms }).then(() => true, () => false);

try {
  for (const [name, V] of Object.entries(VIEWS)) {
    console.log(`\n--- ${name}`);
    const { page, errors } = await s.newPage();
    const owner = name === 'drill' ? 'D' : name === 'qa' ? 'Q' : 'S';
    // sampler: every 15 ms, if the coach is speaking and the button is shown, remember whether it was disabled
    await page.evaluate(([o, sel]) => { window.__sawCoachEnabled = []; setInterval(() => { const b = document.querySelector(sel); if (window.__coach[o].coachPlaying && !b.hidden) window.__sawCoachEnabled.push(b.disabled); }, 15); }, [owner, V.btn]);
    const ok = await V.toResult(page);
    check(`${name}: reached the result view`, ok);
    if (!ok) { await page.context().close(); continue; }
    const coachSamples = await page.evaluate(() => window.__sawCoachEnabled);
    check(`${name}: button disabled every time it was sampled while the coach was speaking`, coachSamples.every((d) => d === true), `samples=${coachSamples.length}`);
    await V.coachIdle(page); await sleep(700);   // post-playback guard
    let b = await label(page, V.btn);
    check(`${name}: "Hear my recording" present, visible and enabled in the result`, b.visible && !b.disabled && /Hear my recording/.test(b.text), JSON.stringify(b));
    // deterministic "coach speaking" check: replay the coach and look at the button while it talks
    await page.evaluate((o) => { window.__coach[o].replayCoach(); }, owner);
    const talking = await waitFor(page, (o) => window.__coach[o].coachPlaying, owner, 4000);
    const dis = talking ? await label(page, V.btn) : null;
    check(`${name}: disabled while the coach replay is speaking`, talking && dis.disabled, JSON.stringify(dis));
    if (talking) await page.click(V.btn, { timeout: 500, force: true }).catch(() => {});   // a tap on the disabled button must do nothing
    await V.coachIdle(page); await sleep(700);
    const take = await V.take(page);
    check(`${name}: take URL exists in memory only`, /^blob:/.test(take || ''));
    const nreq = s.reqs.length;
    await page.click(V.btn);
    check(`${name}: playing -> label "Stop"`, await waitLabel(page, V.btn, /Stop/, 3000));
    const st = await page.evaluate(() => { const els = [...window.__playEls]; const e = els.find((x) => !x.paused && !x.loop) || els[0]; const u = window.__urls.created.slice(-1)[0];
      return { els: els.length, paused: e.paused, blobSrc: String(e.src).startsWith('blob:'), mic: window.__micLive(), type: u.type, size: u.size }; });
    check(`${name}: plays through the ONE shared <audio>, mic released, blob typed as audio`, st.els === 1 && !st.paused && st.blobSrc && !st.mic && /^audio\/(webm|mp4|ogg|wav)$/.test(st.type) && st.size > 500, JSON.stringify(st));
    const ev1 = await page.evaluate(() => window.__audioEvents.filter((e) => e.verdict === 'REAL').length);
    await sleep(600);
    await page.click(V.btn);
    check(`${name}: Stop toggle stops it, label restored`, await waitLabel(page, V.btn, /Hear my recording/, 3000) && (await page.evaluate(() => [...window.__playEls][0].paused)));
    const urlsAfterStop = await page.evaluate(() => ({ created: window.__urls.created.length, revoked: window.__urls.revoked.length }));
    check(`${name}: the playback object URL was revoked when stopped`, urlsAfterStop.revoked >= 1);
    await page.click(V.btn);
    check(`${name}: replays, then returns to idle at the end of the clip`, await waitLabel(page, V.btn, /Stop/, 3000) && await waitLabel(page, V.btn, /Hear my recording/, 8000));
    check(`${name}: no upload/assessment/tts request, no new take, no REAL interruption during playback`,
      uploadsSince(nreq).length === 0 && (await page.evaluate(() => window.__audioEvents.filter((e) => e.verdict === 'REAL').length)) === ev1 && ev1 === 0
        && (await page.evaluate((n) => window.__coach[n].state, owner)) === 'result', `uploads=${JSON.stringify(uploadsSince(nreq))}`);
    // rejected play (simulated NotAllowedError) -> Tap to retry -> retry plays
    await page.evaluate(() => { window.__rejectPlays = 1; });
    await page.click(V.btn);
    check(`${name}: rejected play() -> "Tap to retry"`, await waitLabel(page, V.btn, /Tap to retry/, 3000));
    await page.click(V.btn);
    check(`${name}: retry tap plays`, await waitLabel(page, V.btn, /Stop/, 3000));
    await page.click(V.btn); await waitLabel(page, V.btn, /Hear my recording/, 3000);
    // next take: URL revoked, button gone/disabled while recording
    const before = await page.evaluate(() => window.__urls.revoked.length);
    await V.next(page);
    await V.recording(page); await sleep(300);
    const takeRevoked = await page.evaluate((u) => window.__urls.revoked.includes(u), take);
    b = await label(page, V.btn);
    check(`${name}: next take revoked the old take URL`, takeRevoked, `revoked ${before}->${await page.evaluate(() => window.__urls.revoked.length)}`);
    check(`${name}: button hidden/disabled while the next take is being made`, b.hidden || b.disabled || !b.visible, JSON.stringify(b));
    check(`${name}: no page errors`, errors.length === 0, errors.join('|'));
    await page.context().close();
  }

  // session end revokes too (close rehearsal): finish after a result
  console.log('\n--- session end');
  {
    const { page } = await s.newPage();
    await VIEWS.close.toResult(page); await VIEWS.close.coachIdle(page);
    const take = await VIEWS.close.take(page);
    await VIEWS.close.end(page); await sleep(300);
    check('session end: take URL revoked and discarded', await page.evaluate((u) => window.__urls.revoked.includes(u) && window.__coach.S.recording === null, take));
    await page.context().close();
  }
  // leaving the drill / Q&A screen revokes the take too
  for (const name of ['qa', 'drill']) {
    const { page } = await s.newPage();
    await VIEWS[name].toResult(page); await VIEWS[name].coachIdle(page);
    const take = await VIEWS[name].take(page);
    await page.evaluate((n) => { n === 'qa' ? window.__coach.Q.leave() : window.__coach.D.leave(); }, name); await sleep(300);
    check(`${name} leave: take URL revoked`, await page.evaluate((u) => window.__urls.revoked.includes(u), take));
    await page.context().close();
  }
} catch (e) { console.log('FAIL exception', e && e.stack || e); R.check('no exception', false); }
await s.close();
const bad = R.done(); process.exit(bad ? 1 : 0);
