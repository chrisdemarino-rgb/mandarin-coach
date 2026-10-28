import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { startTestServer, postAttempt, fixtureEngine } from './helpers.js';
import { startFakeToneperfect, NIHAO_COMPACT } from './fake-toneperfect.js';
import { startFakeServices } from './fake-services.js';

const TP_KEY = 'tp_test_FAKEKEYFORTESTS0123456789';
const OAI_KEY = 'sk-fakeopenaikey0123456789';
const AZ_KEY = 'azurefakekey0123456789abcdef';
let tp; let svc;
before(async () => { tp = await startFakeToneperfect(); svc = await startFakeServices(); });
after(async () => { await tp.close(); await svc.close(); });
beforeEach(() => { tp.reset(); svc.reset(); svc.state.chatScript = null; });

const envBase = () => ({ TONEPERFECT_API_KEY: TP_KEY, TONEPERFECT_BASE_URL: tp.baseUrl, ASSESSMENT_ENGINE: 'toneperfect' });
const envOai = () => ({ ...envBase(), OPENAI_API_KEY: OAI_KEY, OPENAI_BASE_URL: svc.openaiBase, COACH_LLM_TONE: '1' }); // the LLM-phrased tone path is opt-in (latency); default path is tested in missed.test.js
async function server(env, opts) { const t = await startTestServer(env, opts); await t.login(); return t; }
const ev = (r, name) => r.events.filter((e) => e.event === name).map((e) => e.data);
const names = (r) => r.events.map((e) => e.event);
const llm = (o) => JSON.stringify(o);
const chatCalls = () => svc.state.requests.filter((r) => r.url === '/v1/chat/completions').length;

const GOOD_COACH = llm({ praiseZh: '很好，发音很清楚。', corrections: [
  { kind: 'tone', targetText: '谢', explanationZh: '第二个“谢”应该读第四声，你读成了第二声。', modelText: '谢谢', factRef: 'tone:1' }], nextPromptZh: '再说一遍吧。' });

test('happy path: SSE order, assessment payload, streamed grounded coaching, per-sentence audio, done', async () => {
  svc.state.chatScript = GOOD_COACH;
  const t = await server(envOai());
  try {
    const r = await postAttempt(t);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const n = names(r);
    assert.equal(n[0], 'status'); assert.equal(n.at(-1), 'done');
    assert.ok(n.indexOf('assessment') < n.indexOf('coach_text'));
    assert.ok(n.indexOf('coach_text') < n.indexOf('coach_audio'));
    const [a] = ev(r, 'assessment');
    assert.equal(a.status, 'ok'); assert.equal(a.engine, 'toneperfect'); assert.equal(a.mock, false); assert.equal(a.basis, 'script');
    assert.deepEqual(a.facts.confirmedToneErrors.map((f) => [f.ref, f.expectedTone, f.heardTone]), [['tone:1', 4, 2]]);
    assert.equal(a.facts.uncertain.length, 1);
    const texts = ev(r, 'coach_text'); const audios = ev(r, 'coach_audio');
    assert.equal(texts[0].delta, '很好，发音很清楚。');
    assert.ok(texts.some((x) => x.delta.includes('第四声')));
    assert.ok(texts.some((x) => x.delta === '应该这样说：谢谢'));
    assert.equal(audios.length, texts.length);
    assert.deepEqual(audios.map((x) => x.index), texts.map((x) => x.index)); // ordered, one audio per sentence
    const mp3 = await fetch(t.base + audios[0].url, { headers: { Cookie: t.cookie() } });
    assert.equal(mp3.status, 200); assert.equal(mp3.headers.get('content-type'), 'audio/mpeg'); assert.equal(mp3.headers.get('x-audio-source'), 'tts');
    const [done] = ev(r, 'done');
    assert.equal(done.corrections.length, 1);
    assert.deepEqual(done.corrections[0], { kind: 'tone', targetText: '谢', explanationZh: '第二个“谢”应该读第四声，你读成了第二声。', modelText: '谢谢', factRef: 'tone:1', source: 'llm' });
    assert.equal(done.summary.coached, true); assert.equal(done.summary.confirmedToneErrors, 1);
    assert.ok(done.summary.timings.firstAudioMs >= 0);
    // the LLM prompt only carries facts, never scores/raw vendor data; key only in Authorization header
    const chat = svc.state.requests.find((x) => x.url === '/v1/chat/completions');
    assert.equal(chat.headers.authorization, `Bearer ${OAI_KEY}`);
    const userMsg = JSON.parse(chat.json.messages[1].content);
    assert.deepEqual(Object.keys(userMsg).sort(), ['basis', 'chunkText', 'facts', 'lowConfidence', 'mode']); // no transcript for the LLM in close mode: it is only used by code for word diffs
    // nothing secret on the wire back to the client
    for (const k of [TP_KEY, OAI_KEY]) assert.ok(!r.text.includes(k));
  } finally { await t.close(); }
});

test('ASSESSMENT UNAVAILABLE => terminal error event, NO coaching text, LLM never called', async () => {
  svc.state.chatScript = GOOD_COACH;
  tp.script({ status: 200, json: { ...NIHAO_COMPACT, assessable: false, reason: 'no_speech' } });
  const t = await server(envOai());
  try {
    const r = await postAttempt(t);
    assert.deepEqual(names(r).filter((n) => n !== 'status'), ['error']);
    const [e] = ev(r, 'error');
    assert.equal(e.code, 'no_speech'); assert.equal(e.retryable, true); assert.equal(e.canSkip, true); assert.equal(e.stage, 'assessment');
    assert.match(e.message, /^No assessment obtained/);
    assert.equal(ev(r, 'coach_text').length, 0); assert.equal(ev(r, 'coach_audio').length, 0); assert.equal(ev(r, 'assessment').length, 0);
    assert.equal(chatCalls(), 0);
    assert.ok(!/"overall"/.test(r.text));
  } finally { await t.close(); }
});

test('engine failure (no key) and invalid reference also end in error without coaching', async () => {
  const t = await server({ ...envOai(), TONEPERFECT_API_KEY: '', ASSESSMENT_ENGINE: 'toneperfect' });
  try {
    const r = await postAttempt(t);
    assert.equal(ev(r, 'error')[0].code, 'not_configured'); assert.equal(ev(r, 'error')[0].retryable, false);
    assert.equal(chatCalls(), 0);
    const r2 = await postAttempt(await (async () => t)(), { fields: { chunkText: '我有3个苹果' } });
    assert.equal(ev(r2, 'error')[0].code, 'not_configured'); // key check precedes reference check
  } finally { await t.close(); }
});

test('GROUNDING: tone correction without factRef / with a made-up factRef is rewritten to "not sure", never a tone claim', async () => {
  svc.state.chatScript = llm({ praiseZh: '不错。', corrections: [
    { kind: 'tone', targetText: '谢', explanationZh: '第一个“谢”的声调错了，应该读第三声。', modelText: '谢谢', factRef: null },
    { kind: 'tone', targetText: '谢', explanationZh: '你把第二声读成了第一声。', modelText: '谢谢', factRef: 'tone:7' }], nextPromptZh: '再试试。' });
  const t = await server(envOai());
  try {
    const r = await postAttempt(t);
    const [done] = ev(r, 'done');
    assert.ok(done.corrections.every((c) => c.kind !== 'tone' || c.factRef === 'tone:1'));
    const spoken = ev(r, 'coach_text').map((x) => x.delta).join('|');
    assert.ok(!spoken.includes('第三声') && !spoken.includes('第一声'), spoken);
    assert.ok(done.corrections.some((c) => c.source === 'server_rewrite' && c.explanationZh.includes('不太确定')));
    assert.ok(done.corrections.length <= 2);
    // the REAL confirmed error is still guaranteed to be reported (fact-built, no LLM text)... if a slot remained
    assert.ok(done.corrections.some((c) => c.factRef === 'tone:1') || done.corrections.length === 2);
  } finally { await t.close(); }
});

test('GROUNDING: wrong tone numbers in a valid-ref correction are replaced by a fact-built sentence; tone claims in praise neutralised; max 2', async () => {
  svc.state.chatScript = llm({ praiseZh: '你的声调非常好！', corrections: [
    { kind: 'tone', targetText: '谢', explanationZh: '应该读第三声，你读成了第一声。', modelText: '你好吗', factRef: 'tone:1' },
    { kind: 'model', targetText: '谢', explanationZh: '这个字也可以再听一遍。', modelText: '谢谢', factRef: 'final:0' },
    { kind: 'omission', targetText: '谢', explanationZh: '多说一个。', modelText: '谢谢', factRef: null }], nextPromptZh: '再来一次，注意第二声。' });
  const t = await server(envOai());
  try {
    const r = await postAttempt(t);
    const [done] = ev(r, 'done');
    assert.equal(done.corrections.length, 2);
    const tone = done.corrections.find((c) => c.kind === 'tone');
    assert.equal(tone.source, 'server_fact'); assert.equal(tone.explanationZh, '“谢”应该读第四声，我听到的是第二声。');
    assert.equal(tone.modelText, '谢谢'); // modelText not from the chunk => replaced
    const texts = ev(r, 'coach_text').map((x) => x.delta);
    assert.equal(texts[0], '不错，我们继续。'); // praise had a tone claim without evidence
    assert.ok(!texts.join('').includes('第二声，注意') && !texts.includes('再来一次，注意第二声。'));
    assert.equal(done.summary.nextPromptZh, '再试一次吧。');
  } finally { await t.close(); }
});

test('no confirmed errors => LLM tone correction is neutralised and a clean chunk is never "fixed"; sandhi stays unflagged', async () => {
  svc.state.chatScript = llm({ praiseZh: '很好！', corrections: [{ kind: 'tone', targetText: '你', explanationZh: '你应该读第三声。', modelText: '你好', factRef: 'tone:0' }], nextPromptZh: '继续。' });
  const t = await server(envOai());
  try {
    const r = await postAttempt(t, { fields: { chunkText: '你好' } });
    const [a] = ev(r, 'assessment'); assert.equal(a.facts.confirmedToneErrors.length, 0); // 你 3->2 is no_correction
    const [done] = ev(r, 'done');
    assert.ok(done.corrections.every((c) => c.kind === 'model' && c.explanationZh.includes('不太确定')));
  } finally { await t.close(); }
});

test('without OPENAI key: real assessment still delivered, coaching skipped with a clear status, nothing fabricated', async () => {
  const t = await server(envBase());
  try {
    const r = await postAttempt(t);
    assert.equal(ev(r, 'assessment').length, 1);
    const skip = ev(r, 'status').find((s) => s.stage === 'coaching');
    assert.equal(skip.skipped, true); assert.equal(skip.code, 'llm_not_configured');
    assert.equal(ev(r, 'coach_text').length, 0); assert.equal(ev(r, 'coach_audio').length, 0);
    const [done] = ev(r, 'done'); assert.deepEqual(done.corrections, []); assert.equal(done.summary.coached, false);
  } finally { await t.close(); }
});

test('LLM failure mid-way: assessment kept, coaching skipped status, done still sent', async () => {
  svc.state.chatStatus = 500;
  const t = await server(envOai());
  try {
    const r = await postAttempt(t);
    assert.equal(ev(r, 'assessment').length, 1);
    assert.equal(ev(r, 'status').find((s) => s.skipped && s.stage === 'coaching').code, 'openai_500');
    assert.equal(ev(r, 'done')[0].summary.coached, false);
    assert.ok(!r.text.includes('leakleak'));
  } finally { await t.close(); }
});

test('TTS not configured => coach_text only + clear status; TTS failure => same, coaching continues', async () => {
  svc.state.chatScript = GOOD_COACH;
  let t = await server(envOai(), { tweakServices: (s) => { s.tts = { available: false, provider: null }; } });
  try {
    const r = await postAttempt(t);
    assert.ok(ev(r, 'coach_text').length > 0); assert.equal(ev(r, 'coach_audio').length, 0);
    assert.equal(ev(r, 'status').find((s) => s.stage === 'speaking').code, 'tts_not_configured');
    assert.equal(ev(r, 'done')[0].summary.coached, true);
  } finally { await t.close(); }
  svc.state.ttsStatus = 500;
  t = await server(envOai());
  try {
    const r = await postAttempt(t);
    assert.ok(ev(r, 'coach_text').length > 0); assert.equal(ev(r, 'coach_audio').length, 0);
    assert.equal(ev(r, 'status').filter((s) => s.stage === 'speaking' && s.skipped).length, 1);
    assert.equal(names(r).at(-1), 'done');
  } finally { await t.close(); }
});

test('Azure TTS is preferred when keyed (SSML voice + rate); OpenAI speech not called', async () => {
  svc.state.chatScript = GOOD_COACH;
  const t = await server({ ...envOai(), AZURE_SPEECH_KEY: AZ_KEY, AZURE_SPEECH_REGION: 'eastasia', AZURE_SPEECH_BASE_URL: svc.azureBase });
  try {
    assert.equal(t.services.tts.provider, 'azure');
    const r = await postAttempt(t, { fields: { voice: 'zh-CN-YunxiNeural', speed: '0.8' } });
    assert.ok(ev(r, 'coach_audio').length > 0);
    const az = svc.state.requests.filter((x) => x.url === '/cognitiveservices/v1');
    assert.ok(az.length > 0);
    assert.equal(az[0].headers['ocp-apim-subscription-key'], AZ_KEY);
    assert.match(az[0].ssml, /voice name="zh-CN-YunxiNeural"/); assert.match(az[0].ssml, /rate="-20%"/);
    assert.equal(svc.state.requests.filter((x) => x.url === '/v1/audio/speech').length, 0);
    assert.ok(!r.text.includes(AZ_KEY));
  } finally { await t.close(); }
});

test('RETELL: STT first, TonePerfect scored against the TRANSCRIPT, flagged lowConfidence + transcript-derived', async () => {
  svc.state.sttText = '我，喜欢学中文。'; svc.state.chatScript = llm({ praiseZh: '根据我听到的，说得不错。', corrections: [], nextPromptZh: '再讲一遍。' });
  const t = await server(envOai());
  try {
    const r = await postAttempt(t, { fields: { assessMode: 'retell', practiceMode: 'fading_cues', chunkText: '我爱说中文，每天练习。' } });
    const [a] = ev(r, 'assessment');
    assert.equal(a.basis, 'transcript'); assert.equal(a.lowConfidence, true); assert.equal(a.transcriptDerived, true);
    assert.equal(a.transcript, '我，喜欢学中文。'); assert.equal(a.referenceText, '我喜欢学中文');
    assert.equal(tp.requests.at(-1).fields.text, '我喜欢学中文');
    assert.ok(names(r).indexOf('status') < names(r).indexOf('assessment'));
    assert.deepEqual(ev(r, 'status').map((s) => s.stage).filter((s) => ['transcribing', 'assessing'].includes(s)), ['transcribing', 'assessing']);
    const chat = JSON.parse(svc.state.requests.find((x) => x.url === '/v1/chat/completions').json.messages[1].content);
    assert.equal(chat.basis, 'transcript'); assert.equal(chat.lowConfidence, true); assert.equal(chat.chunkText, '我爱说中文，每天练习。');
    assert.equal(ev(r, 'done')[0].corrections.length, 0);
  } finally { await t.close(); }
});

test('RETELL error paths: no STT key, empty transcript, too long, STT failure => terminal error, no assessment, no coaching', async () => {
  let t = await server(envBase());
  try {
    const r = await postAttempt(t, { fields: { assessMode: 'retell' } });
    assert.equal(ev(r, 'error')[0].code, 'stt_not_configured'); assert.equal(tp.requests.length, 0);
  } finally { await t.close(); }
  t = await server(envOai());
  try {
    svc.state.sttText = 'um...';
    assert.equal(ev(await postAttempt(t, { fields: { assessMode: 'retell' } }), 'error')[0].code, 'no_speech_detected');
    svc.state.sttText = '好'.repeat(101);
    assert.equal(ev(await postAttempt(t, { fields: { assessMode: 'retell' } }), 'error')[0].code, 'retell_too_long');
    svc.state.sttStatus = 500; svc.state.sttText = '你好';
    const r = await postAttempt(t, { fields: { assessMode: 'retell' } });
    assert.equal(ev(r, 'error')[0].stage, 'transcribing'); assert.equal(ev(r, 'assessment').length, 0);
    assert.equal(tp.requests.length, 0); assert.equal(chatCalls(), 0);
  } finally { await t.close(); }
});

test('CLOSE: STT ALWAYS runs alongside the assessment (listen_repeat too); transcript labelled; STT failure/timeout is non-fatal and stated in facts', async () => {
  svc.state.chatScript = llm({ praiseZh: '好。', corrections: [], nextPromptZh: '继续。' });
  svc.state.sttText = '谢谢';
  const t = await server(envOai());
  const sttCalls = () => svc.state.requests.filter((x) => x.url === '/v1/audio/transcriptions').length;
  try {
    let r = await postAttempt(t, { fields: { practiceMode: 'listen_repeat', chunkText: '谢谢' } });
    let [a] = ev(r, 'assessment'); assert.equal(a.transcript, '谢谢'); assert.equal(a.transcriptDerived, true); assert.equal(a.basis, 'script');
    assert.equal(a.referenceText, '谢谢'); assert.equal(sttCalls(), 1);
    assert.deepEqual([a.facts.stt.status, a.facts.stt.reliable, a.facts.completeness], ['ok', true, 'verified']);
    r = await postAttempt(t, { fields: { practiceMode: 'fading_cues' } }); assert.equal(sttCalls(), 2);
    // STT HTTP error: assessment still returned, facts.stt says so, a status event explains, the coach says it could not check for omissions
    svc.state.sttStatus = 500;
    r = await postAttempt(t, { fields: { practiceMode: 'listen_repeat' } });
    assert.equal(ev(r, 'status').find((s) => s.stage === 'transcribing' && s.skipped).code, 'openai_500');
    [a] = ev(r, 'assessment'); assert.equal(a.facts.stt.status, 'failed'); assert.equal(a.facts.completeness, 'unverified'); assert.equal(a.transcript, undefined);
    assert.ok(ev(r, 'coach_text').some((x) => x.role === 'caveat' && x.delta === '这次没能检查有没有漏词。'));
  } finally { await t.close(); }
});

test('input validation: JSON 400s before the stream starts; TTS-tagged audio refused; stage directions refused', async () => {
  const t = await server(envOai());
  try {
    const cases = [
      [{ noAudio: true }, 'missing_audio'], [{ fields: { chunkText: '' } }, 'invalid_chunk'], [{ fields: { chunkText: '好'.repeat(101) } }, 'invalid_chunk'],
      [{ fields: { chunkText: '你好[停顿]' } }, 'stage_directions_in_chunk'], [{ fields: { assessMode: 'x' } }, 'invalid_assess_mode'],
      [{ fields: { practiceMode: 'free_talk' } }, 'invalid_practice_mode'], [{ fields: { attemptId: 'short' } }, 'invalid_attempt_id'],
      [{ fields: { attemptId: undefined } }, 'invalid_attempt_id'], [{ fields: { source: 'tts' } }, 'tts_audio_rejected'],
      [{ headers: { 'X-Audio-Source': 'tts' } }, 'tts_audio_rejected'],
    ];
    for (const [opts, code] of cases) {
      const r = await postAttempt(t, opts);
      assert.equal(r.status, 400, code); assert.equal(r.json.error.code, code);
    }
    assert.equal(tp.requests.length, 0);
    const big = await postAttempt(t, { audio: Buffer.alloc(10 * 1024 * 1024 + 10) });
    assert.equal(big.status, 413); assert.equal(big.json.error.code, 'upload_too_large');
    const unauth = await fetch(t.base + '/api/attempt', { method: 'POST' });
    assert.equal(unauth.status, 401);
  } finally { await t.close(); }
});

test('idempotency: finished attempt replays (no second TonePerfect call); failed attempt re-runs; concurrent duplicate => 409', async () => {
  svc.state.chatScript = GOOD_COACH;
  const t = await server(envOai());
  try {
    const first = await postAttempt(t, { fields: { attemptId: 'attempt-replay-0001' } });
    assert.equal(tp.requests.length, 1);
    const again = await postAttempt(t, { fields: { attemptId: 'attempt-replay-0001' } });
    assert.equal(again.headers.get('x-attempt-replayed'), 'true');
    assert.equal(tp.requests.length, 1);
    assert.deepEqual(names(again), names(first));
    // failed attempts are not replayed
    tp.script({ status: 422, json: { error: { code: 'invalid_audio', message: 'x' } } });
    const f1 = await postAttempt(t, { fields: { attemptId: 'attempt-fail-00001' } });
    assert.equal(ev(f1, 'error')[0].code, 'invalid_audio');
    const f2 = await postAttempt(t, { fields: { attemptId: 'attempt-fail-00001' } });
    assert.equal(ev(f2, 'assessment').length, 1);
    // concurrent duplicate
    svc.state.chatDelayMs = 150;
    const p1 = postAttempt(t, { fields: { attemptId: 'attempt-conc-00001' } });
    await new Promise((r) => setTimeout(r, 120));
    const dup = await postAttempt(t, { fields: { attemptId: 'attempt-conc-00001' } });
    assert.equal(dup.status, 409); assert.equal(dup.json.error.code, 'attempt_in_progress');
    assert.equal((await p1).events.at(-1).event, 'done');
  } finally { await t.close(); }
});

test('mock engine path is labelled in the SSE payload; nothing is written to disk', async () => {
  const before = fs.readdirSync(os.tmpdir()).length;
  const t = await server({ ASSESSMENT_ENGINE: 'mock' });
  try {
    const r = await postAttempt(t, { fields: { chunkText: '今天天气很好' } });
    const [a] = ev(r, 'assessment'); assert.equal(a.engine, 'mock'); assert.equal(a.mock, true);
    assert.ok(ev(r, 'status').every((s) => s.engine === undefined || s.mock === true));
    assert.equal(ev(r, 'done')[0].summary.mock, true);
    assert.equal(fs.readdirSync(os.tmpdir()).length, before); // multer memoryStorage: no temp files
    assert.deepEqual(t.db.raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((x) => x.name).sort(), ['missed_words', 'prefs', 'saved_words', 'word_history']);
  } finally { await t.close(); }
});

// ---------------- policy end-to-end with cached REAL clips (no network, fake LLM/TTS) ----------------
test('GATE (real clip 08 wrong sentence, real noise clip 07): assessment event + fixed Mandarin line spoken, no LLM, corrections []', async () => {
  svc.state.chatScript = GOOD_COACH;
  for (const clipName of ['08-wrong-sentence', '07-silence']) {
    const t = await server(envOai(), { engine: await fixtureEngine(clipName) });
    try {
      const r = await postAttempt(t, { fields: { chunkText: clipName.startsWith('08') ? '谢谢' : '你好' } });
      const [a] = ev(r, 'assessment');
      assert.equal(a.status, 'ok'); assert.equal(a.matchesText, false); assert.equal(a.gate, 'low_match');
      assert.match(a.gateMessage, /doesn't seem to match/);
      assert.deepEqual([a.facts.confirmedToneErrors, a.facts.uncertain, a.facts.missingWords, a.facts.substitutedWords, a.wordStatus, a.facts.canPraise], [[], [], [], [], [], false]);
      assert.ok(a.syllables.every((x) => x.tone.decision === 'no_decision' && x.tone.heard === null));
      const texts = ev(r, 'coach_text'); const audios = ev(r, 'coach_audio');
      assert.deepEqual(texts.map((x) => [x.delta, x.role]), [['请再说一遍这句话。', 'gate']]);
      assert.equal(audios.length, 1); assert.equal(audios[0].text, '请再说一遍这句话。');
      const [done] = ev(r, 'done');
      assert.deepEqual(done.corrections, []); assert.equal(done.summary.gate, 'low_match'); assert.equal(done.summary.matchesText, false);
      assert.equal(chatCalls(), 0, 'LLM must not be called for a gated result');
      assert.ok(ev(r, 'status').some((x) => x.stage === 'coaching' && x.skipped && x.code === 'low_match'));
      assert.equal(names(r).at(-1), 'done');
      assert.ok(!/第[一二三四]声|应该读/.test(r.text.replace(/"gateMessage"[^,]*,/, '')));
    } finally { await t.close(); }
  }
});

test('GATE without TTS: text line + clear speaking status; without LLM key the gate still works (no LLM needed)', async () => {
  const t = await server(envBase(), { engine: await fixtureEngine('08-wrong-sentence') });
  try {
    const r = await postAttempt(t, { fields: { chunkText: '谢谢' } });
    assert.equal(ev(r, 'coach_text')[0].delta, '请再说一遍这句话。');
    assert.equal(ev(r, 'status').find((x) => x.stage === 'speaking').code, 'tts_not_configured');
    assert.equal(ev(r, 'done')[0].summary.gate, 'low_match');
  } finally { await t.close(); }
});

test('POLICY e2e (real clip 05): demoted 我/喜/欢 can NOT be claimed by the LLM; kept 学/中 are; praise/next tone claims neutralised', async () => {
  svc.state.chatScript = llm({ praiseZh: '你的第三声读得很好！', corrections: [
    { kind: 'tone', targetText: '我', explanationZh: '“我”应该读第三声，你读成了第一声。', modelText: '我喜欢', factRef: 'tone:0' },   // demoted => must be rewritten
    { kind: 'model', targetText: '欢', explanationZh: '你把“欢”读成了第二声，要读第一声。', modelText: '欢', factRef: 'tone:2' },     // claim inside a "model" correction
    { kind: 'tone', targetText: '学', explanationZh: '“学”应该读第二声，你读成了第四声。', modelText: '学', factRef: 'tone:3' },        // confirmed => kept
  ], nextPromptZh: '再试试，注意升调。' });
  svc.state.sttText = '我喜欢学中文。'; // STT autocorrects the wrong tones to fluent text (real finding): tone claims must NOT depend on it
  const t = await server(envOai(), { engine: await fixtureEngine('05-xihuan-zhongwen-wrong-tone') });
  try {
    const r = await postAttempt(t, { fields: { chunkText: '我喜欢学中文' } });
    const [a] = ev(r, 'assessment');
    assert.equal(a.matchesText, true); assert.equal(a.gate, null);
    assert.deepEqual(a.facts.confirmedToneErrors.map((f) => f.ref), ['tone:3', 'tone:4']);
    assert.deepEqual(a.facts.uncertain.map((u) => u.ref).sort(), ['tone:0', 'tone:1', 'tone:2']);
    assert.ok(a.facts.uncertain.every((u) => !('heard' in u)));
    assert.equal(a.policy.confirmedToneClaims, 2); assert.equal(a.policy.rawToneReviews, 5);
    // what the LLM was told
    const sent = JSON.parse(svc.state.requests.find((x) => x.url === '/v1/chat/completions').json.messages[1].content);
    assert.deepEqual(sent.facts.confirmedToneErrors.map((f) => f.ref), ['tone:3', 'tone:4']);
    assert.ok(sent.facts.uncertain.every((u) => !('heardTone' in u) && !('heard' in u)));
    const [done] = ev(r, 'done');
    assert.equal(done.corrections.length, 2);
    // demoted item: the LLM's claim about 我 is NOT spoken (the two slots go to the confirmed errors; the rewrite would be 'not sure' anyway)
    assert.ok(!done.corrections.some((c) => c.targetText === '我' || c.targetText === '欢'));
    assert.ok(done.corrections.every((c) => c.kind === 'tone' && c.factRef));
    assert.ok(done.corrections.some((c) => c.kind === 'tone' && c.factRef === 'tone:3' && c.source === 'llm'));
    const spoken = ev(r, 'coach_text').map((x) => x.delta).join('|');
    assert.ok(!spoken.includes('“我”') && !spoken.includes('“欢”') && !spoken.includes('升调'), spoken); // nothing about the demoted syllables
    assert.ok(spoken.includes('第二声') && spoken.includes('第四声') && spoken.includes('“中”应该读第一声，我听到的是第三声')); // only the confirmed items, with their facts
    assert.equal(ev(r, 'coach_text')[0].delta, '有几个地方要再练一练。'); // 中 (word score 62.9) is an acoustic-only low-score candidate => no plain praise
    assert.equal(done.summary.confirmedToneErrors, 2);
  } finally { await t.close(); }
});

test('POLICY e2e (real clip 04, correct speech): demoted 欢 flag => LLM is not even called (nothing to explain); fixed praise; no tone claim spoken', async () => {
  svc.state.chatScript = llm({ praiseZh: '很好！', corrections: [{ kind: 'tone', targetText: '欢', explanationZh: '“欢”读成了第二声。', modelText: '欢', factRef: 'tone:2' }], nextPromptZh: '继续。' });
  svc.state.sttText = '我喜欢学中文。';
  const t = await server(envOai(), { engine: await fixtureEngine('04-xihuan-zhongwen-correct') });
  try {
    const r = await postAttempt(t, { fields: { chunkText: '我喜欢学中文' } });
    assert.deepEqual(ev(r, 'assessment')[0].facts.confirmedToneErrors, []);
    const [done] = ev(r, 'done');
    assert.equal(chatCalls(), 0); assert.deepEqual(done.corrections, []); assert.equal(done.summary.llmCalled, false);
    assert.equal(ev(r, 'coach_text')[0].role, 'praise'); assert.equal(ev(r, 'assessment')[0].facts.completeness, 'verified');
    assert.ok(!ev(r, 'coach_text').map((x) => x.delta).join('').match(/第.声/));
  } finally { await t.close(); }
});

test('POLICY e2e: any tone-describing wording (pitch words, tone numbers) is stripped from praise/next/model text', async () => {
  svc.state.chatScript = llm({ praiseZh: '音调很自然。', corrections: [{ kind: 'model', targetText: '谢', explanationZh: '这里的音调上扬了。', modelText: '谢谢', factRef: null }], nextPromptZh: '声调再降低一点。' });
  const t = await server(envOai(), { engine: await fixtureEngine('01-nihao-correct') });
  try {
    const r = await postAttempt(t, { fields: { chunkText: '你好' } });
    const spoken = ev(r, 'coach_text').map((x) => x.delta).join('|');
    assert.ok(!/音调|上扬|声调|降低/.test(spoken), spoken);
  } finally { await t.close(); }
});
