#!/usr/bin/env node
// OFFLINE ENGINE VALIDATION with SYNTHETIC speech. This is a test harness only - the app itself never
// sends TTS audio to assessment (routes/attempt.js rejects TTS-tagged uploads).
//   node server/scripts/validate-synthetic.js            # run uncached samples (<= 8 TonePerfect credits total), write VALIDATION-SYNTHETIC.md
//   node server/scripts/validate-synthetic.js --report   # only rebuild VALIDATION-SYNTHETIC.md from cached results (no calls)
// Each normalized result is cached in test-results/synthetic/<name>.json and is NEVER re-run once cached.
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, loadConfig, APP_ROOT, redact } from '../config.js';
import { createToneperfectEngine } from '../engines/assessment/toneperfect.js';
import { deriveFacts } from '../engines/assessment/derive.js';

const CREDIT_BUDGET = 8;
// reference = INTENDED text scored against; say = what OpenAI TTS is asked to say (may differ to simulate a mistake).
export const SAMPLES = [
  { name: 's01-xiexie-correct', reference: '谢谢', say: '谢谢', note: 'control: correct tones (xiè xie, neutral 2nd syllable is acceptable)' },
  { name: 's02-xihuan-zhongwen-correct', reference: '我喜欢学中文', say: '我喜欢学中文', note: 'control: correct; 我喜 is 3-3 sandhi and must NOT be a confirmed error' },
  { name: 's03-ma1-said-ma1', reference: '妈', say: '妈', note: 'control: tone 1 said as tone 1' },
  { name: 's04-ma1-said-ma2', reference: '妈', say: '麻', note: 'wrong tone: intended mā (1), TTS says má (2)' },
  { name: 's05-ma1-said-ma3', reference: '妈', say: '马', note: 'wrong tone: intended mā (1), TTS says mǎ (3)' },
  { name: 's06-ma1-said-ma4', reference: '妈', say: '骂', note: 'wrong tone: intended mā (1), TTS says mà (4)' },
  { name: 's07-xue2-said-xue3', reference: '我喜欢学中文', say: '我喜欢雪中文', note: 'sentence with a swapped tone: 学 xué (2) is said as 雪 xuě (3), same syllable, different tone' },
  { name: 's08-ma1-said-ma2-isolated-word', reference: '妈', say: '麻', task: 'isolated_word', note: 'same as s04 but scored with task=isolated_word (capabilities lists it) to see whether single characters are judged more sharply' },
];
const INSTRUCTIONS = 'Read exactly the given Chinese text aloud in standard Mandarin (Putonghua), using the standard tone of each character. Say nothing else.';

const dir = path.join(APP_ROOT, 'server', 'test-results');
const synDir = path.join(dir, 'synthetic');
fs.mkdirSync(synDir, { recursive: true });
loadDotEnv();
const cfg = loadConfig();
const reportOnly = process.argv.includes('--report');
const jsonPath = (n) => path.join(synDir, `${n}.json`);
const wavPath = (n) => path.join(synDir, `${n}.wav`);

async function synth(text) {
  const res = await fetch(`${cfg.openai.baseUrl}/audio/speech`, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.openai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'wav', instructions: INSTRUCTIONS }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const cached = (n) => (fs.existsSync(jsonPath(n)) ? JSON.parse(fs.readFileSync(jsonPath(n), 'utf8')) : null);
const spentSoFar = () => SAMPLES.reduce((a, s) => a + (cached(s.name)?.creditsCharged ?? 0), 0);

if (!reportOnly) {
  const engine = createToneperfectEngine(cfg);
  if (!engine.available() || !cfg.openai.apiKey) { console.log('Need TONEPERFECT_API_KEY and OPENAI_API_KEY in env/.env.'); process.exit(3); }
  for (const s of SAMPLES) {
    if (cached(s.name)) { console.log(`${s.name}: cached, skipping (no call)`); continue; }
    if (spentSoFar() + 1 > CREDIT_BUDGET) { console.log(`${s.name}: SKIPPED - credit budget (${CREDIT_BUDGET}) would be exceeded`); continue; }
    const audio = fs.existsSync(wavPath(s.name)) ? fs.readFileSync(wavPath(s.name)) : await synth(s.say);
    fs.writeFileSync(wavPath(s.name), audio);
    const durSec = audio.length > 44 ? (audio.length - 44) / (audio.readUInt32LE(28) || 48000) : 0;
    if (durSec > 14.5) { console.log(`${s.name}: clip is ${durSec.toFixed(1)}s (>14.5s, would cost 2 credits) - skipped`); continue; }
    const t0 = Date.now();
    const result = await engine.assess({ audio, mime: 'audio/wav', chunkText: s.reference, attemptId: `synthetic-${s.name}-${Date.now()}`, task: s.task });
    const facts = deriveFacts(result);
    const record = { ...s, synthetic: true, ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy', clipSeconds: +durSec.toFixed(2), elapsedMs: Date.now() - t0,
      creditsCharged: result.meta?.creditsCharged ?? (result.status === 'ok' ? 1 : 0), result, facts };
    const out = JSON.stringify(record, null, 2);
    for (const k of [cfg.toneperfect.apiKey, cfg.openai.apiKey]) if (k && out.includes(k)) throw new Error('refusing to write: output contains an API key');
    fs.writeFileSync(jsonPath(s.name), out + '\n');
    console.log(`${s.name}: ${result.status}${result.status === 'ok' ? ` overall=${result.overall}` : ' ' + result.error?.code} credits=${record.creditsCharged}`);
  }
}

// ---- VALIDATION.md ----
const comp = (u) => (u ? `${u.expected ?? '?'}→${u.heard ?? '?'} ${u.decision}` : '-');
let md = `# Appendix: offline validation with SYNTHETIC speech (TonePerfect engine)\n\n(Real-speech report: VALIDATION.md. This file is generated raw output; the policy in engines/assessment/policy.js was NOT applied to the tables below.)\n\n` +
`> **Caveat — read first.** The audio below is synthetic (OpenAI \`gpt-4o-mini-tts\`, voice \`alloy\`, wav), not a human. OpenAI TTS may **not honor the requested tones**, especially for isolated characters or deliberately "wrong" text, and it may normalise or neutralise tones. These results are therefore **indicative only**, not proof of accuracy on Chris's voice. **Chris's real recordings are still needed** (see \`NEEDED-RECORDINGS.md\`). The app never sends its own TTS audio to assessment; this harness is the only exception, run offline.\n\n` +
`Decision legend: \`review\` = engine is confident enough to treat as a correction candidate; \`uncertain\` = never stated as an error; \`no_correction\` = e.g. tone sandhi, never flagged. Each cell is \`expected→heard decision\`.\n\n` +
`Credits charged by this harness (cached samples only): **${spentSoFar()} / ${CREDIT_BUDGET}**. Raw normalized results: \`test-results/synthetic/<sample>.json\`; generated by \`node server/scripts/validate-synthetic.js --report\`.\n\n`;
for (const s of SAMPLES) {
  const r = cached(s.name);
  md += `## ${s.name}\n- **Intended reference (scored against):** ${s.reference}\n- **TTS was asked to say:** ${s.say}\n- **Purpose:** ${s.note}\n- **TonePerfect task:** ${s.task || 'connected_speech'}\n`;
  if (!r) { md += `- **Result:** not run yet\n\n`; continue; }
  const res = r.result;
  md += `- **Clip:** ${r.clipSeconds}s, credits ${r.creditsCharged}\n`;
  if (res.status !== 'ok') { md += `- **Result:** UNAVAILABLE — \`${res.error?.code}\`: ${redact(res.error?.message || '')} (no scores; nothing is guessed)\n\n`; continue; }
  md += `- **Overall:** ${res.overall}\n- **Confirmed tone errors (decision=review):** ${r.facts.confirmedToneErrors.map((e) => `${e.char}@${e.index} expected ${e.expectedTone} heard ${e.heardTone}`).join('; ') || 'none'}\n- **Uncertain items:** ${r.facts.uncertain.map((u) => u.ref).join(', ') || 'none'}\n\n`;
  md += `| # | char | pinyin | initial | final | tone |\n|---|---|---|---|---|---|\n`;
  for (const y of res.syllables) md += `| ${y.index} | ${y.char} | ${y.pinyin ?? ''} | ${comp(y.initial)} | ${comp(y.final)} | ${comp(y.tone)} |\n`;
  md += '\n';
}
md += `## Reading the results\n_(Filled in by the validating bot after the run; see summary below.)_\n`;
const summaryPath = path.join(dir, 'VALIDATION-SUMMARY.md');
if (fs.existsSync(summaryPath)) md = md.replace(/## Reading the results[\s\S]*$/, fs.readFileSync(summaryPath, 'utf8'));
fs.writeFileSync(path.join(dir, 'VALIDATION-SYNTHETIC.md'), md);
console.log(`wrote ${path.relative(APP_ROOT, path.join(dir, 'VALIDATION-SYNTHETIC.md'))}; credits (cached) ${spentSoFar()}/${CREDIT_BUDGET}`);
