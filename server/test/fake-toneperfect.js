// Local fake TonePerfect server for tests (no real key, no network). Replays the docs' 你好 example
// (compact schema), plus scripted error cases. Records every request for assertions.
import http from 'node:http';
import { pinyin as pinyinPro } from 'pinyin-pro';

export const NIHAO_COMPACT = {
  schema: 'toneperfect.compact.v1', id: 'req_example', assessable: true, reason: null, locale: 'zh-CN', task: 'connected_speech',
  model_version: 'mandarin-human-v2-85741cdf3967-fbf73d85ee88',
  scores: { overall: 99.6, pronunciation: 97.8, initial: 98.2, final: 97.3, tone: 98, fluency: null, rhythm: null, completeness: null },
  words: [
    { text: '你', pinyin: 'ni3', score: 99.3, start_ms: 0, end_ms: 155, decision: null, units: [
      { dimension: 'initial', expected: 'n', heard: 'n', score: 96.6, decision: 'no_correction' },
      { dimension: 'final', expected: 'i', heard: 'i', score: 96.1, decision: 'no_correction' },
      { dimension: 'tone', expected: '3', heard: '2', score: 99.7, decision: 'no_correction' }] },
    { text: '好', pinyin: 'hao3', score: 99.5, start_ms: 155, end_ms: 424, decision: null, units: [
      { dimension: 'initial', expected: 'h', heard: 'h', score: 99.8, decision: 'no_correction' },
      { dimension: 'final', expected: 'ao', heard: 'ao', score: 98.5, decision: 'no_correction' },
      { dimension: 'tone', expected: '3', heard: '3', score: 96.3, decision: 'no_correction' }] },
  ],
  warnings: [], billing: { credits: 1, balance_credits: 2499 },
};

/** 谢谢: 2nd syllable tone expected 4 heard 2, confirmed (review); first syllable final uncertain. */
export const XIEXIE_WRONG_TONE = {
  ...NIHAO_COMPACT, id: 'req_wrongtone',
  scores: { overall: 71.2, pronunciation: 70.1, initial: 90.2, final: 80.3, tone: 48.5, fluency: null, rhythm: null, completeness: null },
  words: [
    { text: '谢', pinyin: 'xie4', score: 85.0, start_ms: 0, end_ms: 200, decision: null, units: [
      { dimension: 'initial', expected: 'x', heard: 'x', score: 91.0, decision: 'no_correction' },
      { dimension: 'final', expected: 'ie', heard: 'ie', score: 70.2, decision: 'uncertain' },
      { dimension: 'tone', expected: '4', heard: '4', score: 93.0, decision: 'no_correction' }] },
    { text: '谢', pinyin: 'xie4', score: 55.0, start_ms: 200, end_ms: 420, decision: null, units: [
      { dimension: 'initial', expected: 'x', heard: 'x', score: 90.0, decision: 'no_correction' },
      { dimension: 'final', expected: 'ie', heard: 'ie', score: 88.0, decision: 'no_correction' },
      { dimension: 'tone', expected: '4', heard: '2', score: 20.1, decision: 'review' }] },
  ],
};

const TEST_OUTCOMES = {
  unassessable: [200, { ...NIHAO_COMPACT, assessable: false, reason: 'no_speech', scores: { overall: null }, words: [] }],
  invalid_assessment: [422, { error: { code: 'invalid_assessment', message: 'bad ref' }, id: 'req_x', billing: { credits: 0 } }],
  engine_unavailable: [503, { error: { code: 'engine_unavailable', message: 'x' }, id: 'req_x', billing: { credits: 0 } }],
  subscription_required: [402, { error: { code: 'subscription_required', message: 'x' }, request_id: 'req_y' }],
  insufficient_credits: [402, { error: { code: 'insufficient_credits', message: 'x' }, request_id: 'req_y' }],
  account_busy: [429, { error: { code: 'account_busy', message: 'x' } }],
  rate_limit: [429, { error: { code: 'rate_limit', message: 'x' } }],
};

export async function startFakeToneperfect() {
  const requests = [];
  const queue = []; // scripted responses consumed in order: {status, json?, body?, headers?, destroy?, hang?}
  const stored = new Map(); // idempotency replay
  const state = { queue, requests, stored };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === '/v1/capabilities') {
      return send(200, { model_version: 'fake', languages: [{ locale: 'zh-CN', available: true, status: 'experimental', dimensions: ['pronunciation', 'initial', 'final', 'tone'], tasks: ['general', 'connected_speech', 'isolated_word'] }],
        limits: { max_audio_seconds: 120, max_upload_bytes: 10485760, concurrent_requests_per_account: 2 } });
    }
    if (url.pathname === '/v1/lint') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const { text } = JSON.parse(Buffer.concat(chunks).toString());
      return /[0-9A-Za-z]/.test(text) ? send(200, { ok: false, issues: [{ code: 'non_chinese_characters', message: 'm', severity: 'error' }], units: 1 }) : send(200, { ok: true, issues: [], units: [...text].length });
    }
    if (url.pathname !== '/v1/assess' || req.method !== 'POST') return send(404, { error: { code: 'not_found' } });

    // read multipart through the platform parser
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let fields = {};
    try {
      const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      for (const [k, v] of fd.entries()) fields[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size };
    } catch { /* leave empty */ }
    const rec = { headers: { ...req.headers }, fields, key: req.headers['idempotency-key'] };
    requests.push(rec);

    const scripted = queue.shift();
    if (scripted) {
      if (scripted.destroy) return req.socket.destroy();
      if (scripted.hang) return; // never answer
      if (scripted.body !== undefined) { res.writeHead(scripted.status, { 'Content-Type': 'text/html', ...(scripted.headers || {}) }); return res.end(scripted.body); }
      return send(scripted.status, scripted.json, scripted.headers);
    }
    const auth = req.headers.authorization || '';
    if (!/^Bearer tp_(test|live)_\S+$/.test(auth)) return send(401, { error: { code: 'invalid_api_key', message: 'x' } });
    const key = req.headers['idempotency-key'] || '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return send(422, { error: { code: 'invalid_idempotency_key', message: 'x' } });
    if (!fields.audio) return send(422, { error: { code: 'missing_audio', message: 'x' } });
    if (!fields.text && !fields.pinyin) return send(422, { error: { code: 'invalid_reference', message: 'x' } });
    const sig = JSON.stringify([fields.text, fields.pinyin, fields.audio.size]);
    const prev = stored.get(key);
    if (prev && prev.sig !== sig) return send(409, { error: { code: 'idempotency_conflict', message: 'x' } });
    if (prev) return send(200, prev.json, { 'Idempotent-Replayed': 'true' });
    const outcome = req.headers['toneperfect-test-outcome'];
    if (outcome && TEST_OUTCOMES[outcome]) return send(...TEST_OUTCOMES[outcome]);
    let json;
    if (fields.text === '你好') json = NIHAO_COMPACT;
    else if (fields.text === '谢谢') json = XIEXIE_WRONG_TONE;
    else {
      const chars = [...fields.text];
      json = { ...NIHAO_COMPACT, id: 'req_generic', words: chars.map((c, i) => {
        const py = pinyinPro(c, { toneType: 'num', type: 'array' })[0];
        const t = py.slice(-1);
        return { text: c, pinyin: py, score: 90, start_ms: i * 200, end_ms: i * 200 + 200, decision: null, units: [
          { dimension: 'initial', expected: 'x', heard: 'x', score: 90, decision: 'no_correction' },
          { dimension: 'final', expected: 'a', heard: 'a', score: 90, decision: 'no_correction' },
          { dimension: 'tone', expected: t, heard: t, score: 90, decision: 'no_correction' }] };
      }) };
    }
    stored.set(key, { sig, json });
    send(200, json);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, ...state, script: (...items) => queue.push(...items), reset: () => { requests.length = 0; queue.length = 0; stored.clear(); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
