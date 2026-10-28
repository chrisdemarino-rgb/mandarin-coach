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
- Retell (and close + fading_cues): STT transcript. In retell the transcript (hanzi only, normalised to simplified; skipped when it has digits/latin or > 100 hanzi) is the assessment reference and the result is labelled `basis:'transcript'`, `lowConfidence:true`; syllables/words/`confirmedToneErrors` therefore refer to the learner's own words, not to `chunkText`. The engine runs in parallel with the LLM meaning comparison (`services/retell.js`); `wordStatus` is not computed in retell and a `low_match` gate on the transcript makes the meaning comparison `unavailable`.
- Real-data caveat: with synthetic speech the engine returned `no_correction` for every deliberate tone mismatch (see `test-results/VALIDATION.md`); the `review` threshold is unproven until real recordings are scored.

## Policy layer (`policy.js`, applied to ANY engine after normalization; constants in `config.js` `ASSESSMENT_POLICY`)
- `createAssessmentEngine` wraps the engine with `withPolicy`; adapters (toneperfect.js) stay vendor-only and unchanged.
- **Gate:** overall < 40 or pronunciation < 60 => `status:'ok'`, `matchesText:false`, `gate:'low_match'`, all decisions `no_decision`, heard withheld, facts empty.
- **Tone claims:** `review` is necessary, not sufficient: tone.score <= 70 and heard != expected; max 2 (lowest score first); if > 40% of a >= 4-syllable chunk still flagged => demote all. Demoted => `uncertain`, `heard:null`, `demotedFrom:'review'`, `demotedReason`.
- Result gains `matchesText`, `gate`, `policy` (and `gateReasons`/`gateMessage` when gated). `deriveFacts` never exposes `heard` for uncertain items.
- Evidence: `test-results/VALIDATION.md` (8 real clips, 1 speaker: indicative only).

## Words layer (`words.js`, runs after the policy, in `/api/attempt` and `/api/drill/attempt`)
- Input: the policy-applied normalized assessment (per-character `syllables`/`words` with `score`, `initial.score`), the chunk text, and an optional STT transcript (`gpt-4o-transcribe`, `language:zh`, prompt without the reference). Output: `wordStatus[]` (per character, code-point offsets) and `facts` additions `missingWords`, `substitutedWords`, `unclearWords`, `insertedText`, `notableGaps`, `stt{status,ms,coverage,reliable}`, `completeness`, `canPraise`.
- Transcript alignment: Needleman-Wunsch on toneless pinyin (pinyin-pro) so traditional/simplified, homophone variants and digits/number words compare equal; punctuation ignored; reference words via `Intl.Segmenter('zh')`.
- Evidence: acoustic candidate = word score < `ACOUSTIC_MISSING_WORD_MAX` or initial score < `ACOUSTIC_INITIAL_ABSENT_MAX`. STT missing/different + candidate = missed|substituted/high; STT only = medium; candidate only = `uncertain`/low (never "missed"). Transcript ignored when coverage < `STT_MIN_COVERAGE`. A confirmed tone error (policy `review`) becomes `wrong/tone`.
- **The transcript is never used for tone claims** (it autocorrects tones; clip 05 returned perfect text). Tone facts come only from `confirmedToneErrors` as before.
- Engines remain vendor-agnostic: the layer needs only per-char word/syllable scores and initial scores; missing initial scores simply disable that criterion.
- Gate composes: a `low_match` result gets `wordStatus:[]`, `canPraise:false`, `completeness:'unknown'`, and no word claims.
- Evidence and limits: `test-results/VALIDATION.md` ("Missing / skipped / wrong words").

