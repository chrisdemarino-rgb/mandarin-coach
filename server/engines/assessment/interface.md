# AssessmentEngine interface

Nothing outside `engines/assessment/<engine>.js` may know an engine's wire format
(e.g. TonePerfect field names). Everything else consumes the normalized shape below.

```js
engine = {
  name: 'toneperfect' | 'mock' | ...,
  mock: boolean,                       // true => every payload is labelled MOCK, UI shows a banner
  available(): boolean,                // credentials/config present
  async assess({ audio: Buffer, mime: string, chunkText: string, attemptId: string,
                 pinyin?: string, task?: 'connected_speech'|'isolated_word', lowConfidence?: boolean }) -> NormalizedAssessment
}
```

`assess` must NEVER throw for expected failures: return `status:'unavailable'` with `error`.
`attemptId` is the idempotency key for one recording attempt (reuse on retry of the SAME attempt only).

## NormalizedAssessment
```
{ status: "ok" | "unavailable", engine, mock, modelVersion,
  error?: { code, message, retryable },
  overall: number|null,
  syllables: [{ index, char, pinyin /* "ni3" */, wordIndex, startMs, endMs,
     initial: {expected, heard, score, decision},
     final:   {expected, heard, score, decision},
     tone:    {expected /*1-5*/, heard /*1-5 | null*/, score, decision} }],
  words: [{ text, score, startMs, endMs }] }
```
Rules: unknown => `null`, never 0 as filler. `decision` is passed through faithfully:
`review` (strong evidence; the only decision that is a correction candidate), `uncertain`
(say "not sure", never claim an error), `no_correction` (not an error, e.g. tone sandhi).
Never invent a heard value. `assessable:false` from the vendor => `status:'unavailable'`
with `error.code` = the vendor reason (e.g. `no_speech`, `different_content`), never a zero score.

## Derived facts (code, `derive.js`)
`confirmedToneErrors` = syllables with `tone.decision==='review'`; `uncertain` = any component `uncertain`.

## How `/api/attempt` uses it (step 3)
- `assess` result `status:'unavailable'` => SSE `error` event, coaching never starts (the LLM is not called).
- The LLM receives ONLY: chunk text, `facts` (above), mode/basis, transcript. Never raw vendor data or scores.
- Coach output is post-validated in `services/coach.js`: a `tone` correction must cite a `factRef` equal to a `confirmedToneErrors` ref, else it is rewritten to a "not sure" line or dropped; stated tone numbers must match the fact; `uncertain`/`no_correction` are never stated as errors; max 2 corrections.
- Retell (and close + fading_cues): STT transcript. In retell the transcript (hanzi only) is the assessment reference and the result is labelled `basis:'transcript'`, `lowConfidence:true`.
- Real-data caveat: with synthetic speech the engine returned `no_correction` for every deliberate tone mismatch (see `test-results/VALIDATION.md`); the `review` threshold is unproven until real recordings are scored.

## Policy layer (`policy.js`, applied to ANY engine after normalization; constants in `config.js` `ASSESSMENT_POLICY`)
- `createAssessmentEngine` wraps the engine with `withPolicy`; adapters (toneperfect.js) stay vendor-only and unchanged.
- **Gate:** overall < 40 or pronunciation < 60 => `status:'ok'`, `matchesText:false`, `gate:'low_match'`, all decisions `no_decision`, heard withheld, facts empty.
- **Tone claims:** `review` is necessary, not sufficient: tone.score <= 70 and heard != expected; max 2 (lowest score first); if > 40% of a >= 4-syllable chunk still flagged => demote all. Demoted => `uncertain`, `heard:null`, `demotedFrom:'review'`, `demotedReason`.
- Result gains `matchesText`, `gate`, `policy` (and `gateReasons`/`gateMessage` when gated). `deriveFacts` never exposes `heard` for uncertain items.
- Evidence: `test-results/VALIDATION.md` (8 real clips, 1 speaker: indicative only).
