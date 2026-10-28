# POST /api/attempt (SSE) and friends — for the Frontend

All `/api/*` except `/api/health` and `/api/login` need the `coach_session` cookie.

```bash
# login (cookie jar), then one attempt; -N = don't buffer the event stream
curl -c jar.txt -H 'Content-Type: application/json' -d '{"passcode":"<APP_PASSCODE>"}' http://localhost:8080/api/login
curl -N -b jar.txt http://localhost:8080/api/attempt \
  -F audio=@take.m4a \
  -F chunkText='谢谢' -F assessMode=close -F practiceMode=listen_repeat \
  -F attemptId=att-$(date +%s)-1 -F voice=zh-CN-XiaoxiaoNeural -F speed=1
```
Fields: `audio` (file, <=10 MB, audio/mp4|wav|webm|mpeg|ogg), `chunkText` (<=100 chars, no `[ ]【 】`), `assessMode` close|retell, `practiceMode` listen_repeat|fading_cues (`trouble_word` exists only in the prefs enum — drills use `/api/drill/attempt`), `attemptId` (8-100 chars `[A-Za-z0-9._:-]`, unique per recording; re-send the SAME id when retrying the same take), optional `voice`, `speed` (0.5-1.5).
Validation failures are plain JSON `400 {error:{code,message}}` BEFORE the stream starts (`missing_audio`, `invalid_chunk`, `stage_directions_in_chunk`, `invalid_assess_mode`, `invalid_practice_mode`, `invalid_attempt_id`, `tts_audio_rejected`), `413 upload_too_large`, `409 attempt_in_progress`, `429` rate limit.

## Events (`event: <name>\ndata: <json>\n\n`)
```
event: status      data: {"stage":"uploading","engine":"toneperfect","mock":false}
event: status      data: {"stage":"assessing"}            (retell: {"stage":"transcribing"} first, then {"stage":"assessing","detail":"meaning"}; also "coaching","speaking")
event: assessment  data: {"engine":"toneperfect","mock":false,"modelVersion":"…","status":"ok","overall":71.2,
                          "scores":{"overall":71.2,"pronunciation":70.1,"initial":90.2,"final":80.3,"tone":48.5},
                          "syllables":[{"index":1,"char":"谢","pinyin":"xie4","wordIndex":1,"startMs":200,"endMs":420,
                             "initial":{"expected":"x","heard":"x","score":90,"decision":"no_correction"},
                             "final":{"expected":"ie","heard":"ie","score":88,"decision":"no_correction"},
                             "tone":{"expected":4,"heard":2,"score":20.1,"decision":"review"}}, …],
                          "words":[{"text":"谢谢","score":…,"startMs":…,"endMs":…}],"warnings":[],"meta":{…},
                          "facts":{"confirmedToneErrors":[{"ref":"tone:1","index":1,"char":"谢","pinyin":"xie4","expectedTone":4,"heardTone":2,"score":20.1}],
                                   "uncertain":[{"ref":"final:0","index":0,"char":"谢","dimension":"final","expected":"ie","heard":"ie","score":70.2}]},
                          "basis":"script","referenceText":"谢谢"}
                    NEW fields (policy, applied to every engine): "matchesText":true|false, "gate":null|"low_match", and when gated
                    "gateReasons":[…], "gateMessage":"That recording doesn't seem to match the sentence (or I couldn't hear speech). Please say the sentence again."
                    plus "policy":{"version":1,"gated":false,"rawToneReviews":5,"confirmedToneClaims":2,
                                   "demoted":[{"ref":"tone:0","reason":"score_above_threshold","score":75.6}, …],"thresholds":{…}}.
                    Demoted tone flags arrive with syllables[i].tone = {decision:"uncertain", heard:null, demotedFrom:"review", demotedReason}; facts.uncertain
                    items never carry `heard`. ONLY facts.confirmedToneErrors may be shown as "you said tone X" (<= 2, lowest tone score first).
                    (+ "transcript","transcriptDerived":true when STT ran; retell => "basis":"transcript","lowConfidence":true and a `retell` block, see "Retell mode")
event: status      data: {"stage":"coaching"}
event: coach_text  data: {"delta":"很好，发音很清楚。","index":0,"role":"praise"}      roles: opener|praise|correction|correction_model|caveat|next|gate (see "Word-level feedback" below)
event: coach_text  data: {"delta":"第二个“谢”应该读第四声，你读成了第二声。","index":1,"role":"correction"}
event: coach_audio data: {"url":"/api/audio/9a93ae52934b74bcd1e1db9a.mp3","index":1,"text":"第二个“谢”应该读第四声，你读成了第二声。"}
event: done        data: {"corrections":[{"kind":"tone","targetText":"谢","explanationZh":"…","modelText":"谢谢","factRef":"tone:1","source":"llm"}],
                          "summary":{"engine":"toneperfect","mock":false,"overall":71.2,"confirmedToneErrors":1,"uncertain":1,"basis":"script",
                                     "transcriptUsed":false,"coached":true,"praiseZh":"…","nextPromptZh":"再说一遍吧。","droppedCorrections":0,
                                     "timings":{"assessMs":…,"firstAudioMs":…,"totalMs":…}}}
```
`coach_audio` arrive in order, one per `coach_text` index (the `next` prompt is last); each url is a short-lived (5 min) mp3 behind the cookie; play them with the single `<audio>` element, in order. `source` is `llm` | `server_fact` (server rewrote it from facts) | `server_rewrite` ("not sure" template).

Skips (stream continues, assessment still delivered): `{"stage":"coaching","skipped":true,"code":"llm_not_configured"|"openai_500"|…,"message":…}`, `{"stage":"speaking","skipped":true,"code":"tts_not_configured"|…}`, `{"stage":"transcribing","skipped":true,"code":"stt_timeout"|"stt_not_configured"|"openai_500"|…,"message":…}` (STT now runs for EVERY close-mode attempt, in parallel with TonePerfect, capped at `STT_WAIT_MS`=3000 ms; when it did not run the assessment still arrives, `facts.stt.status` says why and the coach adds the spoken caveat `这次没能检查有没有漏词。`).

**Terminal error (no assessment, NO coaching text, stream then ends):**
```
event: error  data: {"code":"no_speech","message":"No assessment obtained: …","retryable":true,"canSkip":true,"stage":"assessment","engine":"toneperfect","mock":false}
```
Codes: engine codes (`no_speech`, `no_audio`, `different_content`, `not_configured`, `rate_limit`, `engine_unavailable`, …), `stt_not_configured`, `no_speech_detected`, `retell_too_long` (retell transcript > 300 hanzi), `transcription_failed`, `invalid_reference`. Retry = re-POST with the SAME `attemptId` (failed attempts re-run; successful ones replay the recorded events with header `X-Attempt-Replayed: true` for 10 min, without spending credits again).

## Other endpoints
- `POST /api/tts {text<=500, voice?, speed?}` -> `audio/mpeg` (Range supported; `X-TTS-Cache: hit|miss`, `X-TTS-Provider`); 501 `tts_not_configured`.
- `GET /api/audio/:id.mp3` -> 200/206 mp3, 404 once expired.
- `POST /api/cues {chunkText, level 1-4}` -> `{level, cue, items?, source:"rule"|"llm"}`: 1 keywords+pinyin (`"练习 liànxí · 中文 zhōngwén"`, `items:[{text,pinyin}]`), 2 first char of each clause (`"我… 然…"`), 3 one-word topic hint (LLM, rule fallback), 4 `""`.

## Gate: audio does not match the text (`gate:"low_match"`)
When overall < 40 or pronunciation < 60 (wrong sentence, room noise) the assessment is still `status:"ok"` but `matchesText:false`, `gate:"low_match"`;
all per-syllable decisions are `no_decision` with `heard:null`; `facts` are empty. The stream then is:
```
event: assessment  data: {…,"status":"ok","overall":0.2,"matchesText":false,"gate":"low_match","gateMessage":"That recording doesn't seem to match…","facts":{"confirmedToneErrors":[],"uncertain":[]},…}
event: status      data: {"stage":"coaching","skipped":true,"code":"low_match","message":"That recording doesn't seem to match the sentence …"}
event: status      data: {"stage":"speaking","provider":"openai"}
event: coach_text  data: {"delta":"请再说一遍这句话。","index":0,"role":"gate"}
event: coach_audio data: {"url":"/api/audio/….mp3","index":0,"text":"请再说一遍这句话。"}
event: done        data: {"corrections":[],"summary":{…,"matchesText":false,"coached":false,"gate":"low_match","gatePhraseZh":"请再说一遍这句话。",…}}
```
No LLM call is made. UI: show `gateMessage` (English) and treat it as "try again", not as a score; do not colour syllables. Thresholds are constants in `config.js` (`ASSESSMENT_POLICY`); evidence and caveats in `test-results/VALIDATION.md` (n = 8 clips, one speaker).

# Word-level feedback: missed / skipped / wrong words  (added 2026-10-28)

**Rule:** missing and wrong *words* matter more than tones. TonePerfect per-word/initial scores are the *acoustic* evidence; an STT transcript (gpt-4o-transcribe, `language:"zh"`, prompt does NOT contain the reference) aligned to the reference text at character/pinyin level is the *second* source. The transcript is used ONLY for missing/wrong words — never for a tone claim (it autocorrects wrong tones). All word claims are computed by code (`engines/assessment/words.js`); the LLM never creates, drops or rephrases one. Constants: `ASSESSMENT_POLICY` in `config.js`; evidence: `test-results/VALIDATION.md`.

| evidence | `status` | `confidence` | `source` |
|---|---|---|---|
| word absent/different in the transcript **and** acoustic candidate (word score < 65 or initial score < 30) | `missed` / `substituted` | `high` | `both` |
| absent/different in the transcript only | `missed` / `substituted` | `medium` | `stt` |
| acoustic candidate only (STT timeout/failure/not configured/unreliable, or the transcript has the word) | `uncertain` (`reason:"low_score"`) | `low` | `acoustic` |
| confirmed tone error (policy-surviving `review`) | `wrong` (`reason:"tone"`) | `medium` | `acoustic` |
| weak tone/initial/final evidence | `uncertain` (`reason:"tone"|"initial"|"final"`) | `low` | `acoustic` |

A single source never produces "good": any `missed`/`substituted`/`uncertain(low_score)` word or a pause > 500 ms between words makes `facts.canPraise:false` and the coach says the fixed opener `有几个地方要再练一练。` instead of praise (even if the LLM wrote praise — it is dropped).

## `assessment` event additions (every field below is new; existing fields unchanged)
`wordStatus` — one entry per Chinese character of the chunk you sent, **code-point offsets into the exact `chunkText` received** (`end` exclusive, punctuation/latin/spaces skipped, so `Array.from(chunkText).slice(start,end).join("")===text`). `[]` when the result is gated (`gate:"low_match"`).
```
"wordStatus":[
  {"start":0,"end":1,"text":"我","pinyin":"wǒ","status":"ok"},
  {"start":2,"end":3,"text":"欢","pinyin":"huan","status":"ok"},
  {"start":3,"end":4,"text":"学","pinyin":"xué","status":"missed","reason":"omitted","source":"both","confidence":"high",
   "detail":"not found in the transcript; word score 60.9 < 65; initial score 3.3 < 30"},
  {"start":4,"end":5,"text":"中","pinyin":"zhōng","status":"wrong","reason":"tone","source":"acoustic","confidence":"medium","detail":"expected tone 1, heard tone 3"},
  {"start":1,"end":2,"text":"喜","pinyin":"xǐ","status":"substituted","heard":"爱","source":"stt","confidence":"medium","detail":"transcript has a different word here"}
]
```
`status` ok|missed|substituted|wrong|uncertain · `reason` omitted|low_score|tone|initial|final (|added: never emitted, insertions go to `facts.insertedText`) · `heard` only for `substituted` · `source` acoustic|stt|both · `confidence` high|medium|low · `detail` English, for a debug tooltip only. `ok` entries carry only start/end/text/pinyin. `pinyin` is the contextual reading (neutral tones unmarked: `huan`). Suggested UI: red = missed, orange = substituted/wrong, grey dashed = uncertain; never show `uncertain` as an error.

`facts` gains (real output for a take that skipped 学 in 我喜欢学中文, STT transcript `我喜欢中文。`):
```
"facts":{"confirmedToneErrors":[],"uncertain":[],
  "missingWords":[{"ref":"missing:0","score":60.9,"text":"学","pinyin":"xué","start":3,"end":4,"chars":[{"start":3,"end":4,"text":"学"}],
                   "source":"both","confidence":"high","missedText":"学"}],
  "substitutedWords":[],                      // same shape + "heard":"爱"
  "unclearWords":[],                          // low-confidence acoustic-only words, same shape without heard
  "insertedText":[],                          // [{"text":"很","afterOffset":1}] = extra word(s) heard after reference offset 1; informational, does not block praise
  "notableGaps":[],                           // [{"afterStart":1,"ms":640}] pause > 500 ms after the char at offset 1
  "stt":{"status":"ok","ms":773,"coverage":0.83,"reliable":true},   // status ok|timeout|failed|unavailable (+ "reason"); reliable=false when coverage < 0.3 (transcript ignored)
  "completeness":"incomplete",                // verified | unverified (STT did not/could not confirm) | incomplete | unknown (gated)
  "canPraise":false}
```
`missingWords[].text` is the script *word* (Intl.Segmenter), `missedText` the skipped characters inside it (differs for a partly-skipped word such as 很好 where only 好 was lost); `start/end` span the script word. Existing `confirmedToneErrors[]` items also gain `start`,`end`.
Also on the event: `"savedMissed":[{"id":1,"text":"学","pinyin":"xué","meaning":null,"reason":"omitted","start":3,"end":4,"missCount":1,"isNew":true}]` (words just auto-saved to the "words I don't know" list; `reason` omitted|substituted|low_score; `meaning` fills in later via the LLM — fetch `GET /api/words/missed` to see it) and `"transcript":"我喜欢中文。","transcriptDerived":true` (display only, as a hint "I heard …"; never persisted).

## `coach_text` / `done` for word feedback (real output)
```
event: coach_text  data: {"delta":"有几个地方要再练一练。","index":0,"role":"opener"}
event: coach_text  data: {"delta":"漏掉了“学”这个词。","index":1,"role":"correction","caption":"学 xué","start":3,"end":4}
event: coach_text  data: {"delta":"应该这样说：喜欢学","index":2,"role":"correction_model","start":3,"end":4}
event: coach_text  data: {"delta":"再说一遍这句话吧。","index":3,"role":"next"}
event: coach_audio data: {"url":"/api/audio/….mp3","index":1,"text":"漏掉了“学”这个词。"}        // the missed word is modelled via TTS
event: done        data: {"corrections":[{"kind":"missing","targetText":"学","explanationZh":"漏掉了“学”这个词。","modelText":"喜欢学","factRef":"missing:0",
                     "source":"server_fact","start":3,"end":4,"pinyin":"xué","meaning":null,"evidence":{"source":"both","confidence":"high"}}],
                   "summary":{…,"missingWords":1,"substitutedWords":0,"completeness":"incomplete","stt":"ok","llmCalled":false,"timings":{…}},
                   "timings":{"receiveMs":7,"transcodeMs":0,"assessMs":2001,"sttMs":560,"sttWaitMs":0,"analysisMs":1,"firstCoachTextMs":2003,"firstAudioMs":2004,"ttsFirstAudioMs":0,"ttsFirstCached":true,"totalMs":3100}}
```
- New `role`s: `opener` (replaces praise whenever anything is missing/uncertain/toned), `caveat` (`这次没能检查有没有漏词。` when STT did not run), plus `praise` only when `facts.canPraise`. `caption` = `"<word> <pinyin>[ — <English gloss>]"` for a on-screen card while the line is spoken; `start/end` let you highlight the word in the chunk. Hedged wording for `medium` evidence: `好像漏掉了“X”这个词。`; substitution: `这里应该是“X”，我听到的是“Y”。`; partly skipped word: `“很好”这个词里漏掉了“好”。`.
- Correction `kind`s now: `tone` (as before), `missing`, `substituted`, `unclear` (hedged `“X”这个词我听得不太清楚。`), `model`; all word kinds are `source:"server_fact"`; each carries `start`,`end`,`pinyin`,`meaning` (nullable) and `evidence{source,confidence}`. **Max 2 corrections in total; missing/substituted rank above tone errors above unclear.**
- `done.timings` (ms, content-free; also logged): `receiveMs` (upload parse), `transcodeMs` (always 0: no transcode), `assessMs` (TonePerfect), `sttMs` (transcription call), `sttWaitMs` (time the pipeline waited on STT after TonePerfect returned; 0 when STT finished first; capped at 3000 → `facts.stt.status:"timeout"`), `analysisMs`, `llmFirstTokenMs`/`llmTotalMs` (only when the LLM ran), `firstCoachTextMs`, `firstAudioMs` (first `coach_audio` sent, from request start), `ttsFirstAudioMs`, `ttsFirstCached`, `totalMs`. All are from the server's request start (after the upload completed). Also in `summary.timings`.
- Tone corrections are code-built from the confirmed fact by default (instant). `COACH_LLM_TONE=1` makes the LLM phrase them (costs ≈ 1.5–3 s).

## Words I don't know (auto-saved) — `GET/POST/DELETE /api/words/missed`
Every `missed`/`substituted` word with `confidence` ≠ low (and an acoustic-only word with word score < `SAVE_LOW_SCORE_WORD_MAX`=55) is saved/updated automatically (dedupe by `text`; `missCount`+1, `correctStreak` reset to 0, status back to `learning`). Stored: word text, pinyin, short English gloss, counters, your own script chunk — **never audio, never transcripts**. Gloss: cheap LLM call, only if OpenAI is configured, cached, tried once; otherwise `meaning:null`.
```
GET /api/words/missed            (learning only; add ?all=1 to include known)
200 [{"id":1,"text":"学","pinyin":"xué","meaning":"to study","missCount":1,"correctStreak":0,"needed":3,
      "lastMissedAt":"2026-10-28T02:24:25.365Z","sourceChunk":"我喜欢学中文","status":"learning"}]      sorted missCount desc, then lastMissedAt desc
POST   /api/words/missed/:id/known      -> 204   (graduated manually; streak reset)       404 {"ok":false,"error":{"code":"not_found",…}}
POST   /api/words/missed/:id/learning   -> 204   (back to the list)
DELETE /api/words/missed/:id            -> 204
```
`needed` = `DRILL_GRADUATE_STREAK` (3, constant in `config.js`). `/api/words` (saved vocabulary) is unchanged.

## Trouble-word drills
```
GET /api/drill/next?n=5      (1-20; learning words, lowest streak first, then most missed, then newest)
200 [{"wordId":1,"text":"学","pinyin":"xué","meaning":"to study","exampleSentence":"我喜欢学中文","promptText":"我喜欢学中文","correctStreak":0,"needed":3}]
```
`promptText` is what the learner must say. For a word of 2+ characters it is the word itself. For a **single character** (a poor isolated test: TonePerfect scores single syllables badly and coarticulation is missing) it is the user's own `sourceChunk`, and only the target span is judged. Show `text/pinyin/meaning`; play the model via `POST /api/tts {text: promptText}`.

`POST /api/drill/attempt` — multipart `audio`, `wordId`, `attemptId` (same rules as `/api/attempt`; optional `voice`,`speed`). 404 `not_found` for an unknown `wordId`. SSE with the same event names. `correct` is decided **server-side** (every character of the target is `ok`, or only tone/initial/final-`uncertain`; a `missed`/`substituted`/`wrong`/low-score character or a gated take is not correct) and any client-sent `correct` field is ignored.
```
event: status      data: {"stage":"uploading",…}  {"stage":"assessing"}  {"stage":"transcribing"}  {"stage":"coaching"}  {"stage":"speaking",…}
event: assessment  data: {…same as /api/attempt…, "referenceText":"我喜欢学中文","wordStatus":[…],"facts":{…},"savedMissed":[],
                          "target":{"wordId":1,"text":"学","start":3,"end":4}}      // judge wordStatus within [start,end)
event: coach_text  data: {"delta":"对了！","index":0,"role":"praise"}                // wrong: role correction (+caption,start,end) + correction_model + next("再试一次。")
event: coach_audio data: {"url":"/api/audio/….mp3","index":0,"text":"对了！"}
event: done        data: {"correct":true,"counted":true,"correctStreak":1,"needed":3,"graduated":false,"wordId":1,"corrections":[],
                          "timings":{"receiveMs":1,"transcodeMs":0,"assessMs":1,"sttMs":2,"sttWaitMs":1,"analysisMs":1,"firstCoachTextMs":4,"firstAudioMs":4,"ttsFirstAudioMs":0,"ttsFirstCached":true,"totalMs":4}}
```
`counted:false` (+ `"reason":"low_match"`) when the take did not match the text (nothing changes). A miss resets `correctStreak` to 0 (and counts as a miss in `missCount`); the 3rd consecutive correct take sets `graduated:true`, `correctStreak:3`, status → `known` (spoken line `这个词你学会了！`), and the word leaves `/api/drill/next`. Drill attempts never auto-save new words (`savedMissed:[]`).


## Retell mode (`assessMode:"retell"`): the learner retells `chunkText` freely, in their own words
Pipeline: **STT** (gpt-4o-transcribe, zh, the reference is NEVER in the STT prompt; transcript normalised to *simplified* characters) -> in parallel **(a) meaning comparison LLM** (`RETELL_MODEL`, JSON mode, temperature 0, 9 s cap, 1 retry) and **(b) TonePerfect on the transcript** (see "Tone in retell") -> `assessment` (waits for both; TonePerfect is waited for at most 3 s after the comparison is ready) -> code-built coaching.
The LLM sees ONLY `{reference, transcript}`. It proposes key ideas as `{refQuote (substring of the reference), covered, evidence (substring of the transcript), confidence}`; **CODE** resolves `refQuote` to code-point offsets (exact -> punctuation-insensitive -> fuzzy <= 25% edits; LLM-given numbers are never used; unresolvable spans are dropped), verifies every `evidence` quote against the transcript (pinyin-level, so trad/simp STT output is fine; a covered/partial idea with unverifiable evidence is demoted to `partial` + `confidence:"low"`, `evidence:null`), de-duplicates overlapping spans, renumbers `i1..` by position, and computes `coveredCount/totalCount/canPraise/missingIdeaIds`. Strict schema check; on malformed JSON it retries once, then `comparisonStatus:"unavailable"` with **no coverage claims**.
Wording changes are NOT errors: **`wordStatus` is `[]`, `savedMissed` is `[]` and `facts.missingWords/substitutedWords` are `[]` in retell, EXCEPT for the reused-phrase word check** (a script word that is wrong/missing inside a phrase the learner reused almost verbatim — see "Reused-phrase word check" below; changed 2026-10-28). Nothing is persisted but those saved words: no audio, no transcript (the transcript is returned to the client only).

`assessment` event, retell additions (everything else as in close mode; `basis:"transcript"`, `transcriptDerived:true`, `lowConfidence:true`, `referenceText` = hanzi of the transcript, `facts.canPraise` = `retell.canPraise`):
```
"transcript":"小明早上起床，吃了早饭，骑自行车去学校。他在学校学习数学和英语。",
"wordStatus":[],"savedMissed":[],
"retell":{
  "transcript":"小明早上起床，吃了早饭，骑自行车去学校。他在学校学习数学和英语。",   // same text as above (simplified chars), for display
  "sttStatus":"ok",
  "ideas":[
    {"id":"i1","textZh":"小明早上起床","refStart":0,"refEnd":6,"covered":true,"evidence":"小明早上起床","confidence":"high"},
    {"id":"i2","textZh":"吃了早饭","refStart":7,"refEnd":11,"covered":true,"evidence":"吃了早饭","confidence":"high"},
    {"id":"i3","textZh":"骑自行车去学校","refStart":12,"refEnd":19,"covered":true,"evidence":"骑自行车去学校","confidence":"high"},
    {"id":"i4","textZh":"他在学校学习数学和英语","refStart":20,"refEnd":31,"covered":true,"evidence":"他在学校学习数学和英语","confidence":"high"},
    {"id":"i5","textZh":"下午回家踢足球","refStart":32,"refEnd":39,"covered":false,"evidence":null,"confidence":"high"}],
  "coveredCount":4,"totalCount":5,"partialCount":0,
  "canPraise":false,                       // true ONLY when every idea is covered:true with non-low confidence
  "praiseLevel":"none",                    // "full" | "soft" (partial / low-confidence only) | "none" (any covered:false)
  "comparisonStatus":"ok",                 // "ok" | "unavailable" (then ideas:[], counts 0, canPraise:false, comparisonReason:"malformed_output"|"unusable_output"|"low_match"|"llm_not_configured"|<error code>)
  "missingIdeaIds":["i5"],
  "suggestedWords":[{"text":"下午","pinyin":"xià wǔ","meaning":null,"ideaId":"i5"},{"text":"回家","pinyin":"huí jiā","meaning":null,"ideaId":"i5"},{"text":"足球","pinyin":"zú qiú","meaning":null,"ideaId":"i5"}],   // optional "Save word" candidates (<= 4); NOT saved by the server
  "tone":{"status":"ok"}                   // or {"status":"skipped","reason":"transcript_has_digits_or_latin"|"transcript_too_long_for_tone"|"tone_check_timeout"|<TonePerfect error code>}
}
```
`refStart/refEnd` are **code-point offsets, end exclusive, into the exact `chunkText` sent** (`Array.from(chunkText).slice(refStart, refEnd)` = the idea's span; highlight it in the reference). `textZh` is the reference wording of the idea (<= 30 chars, never invented). `covered:"partial"` shows as "partly said". An idea with `confidence:"low"` is never counted as fully covered.

`coach_text` roles in retell (all lines are code-built from fixed phrases, except `summary` (LLM, only on full praise, validated) and tone lines; first audio comes from the pre-warmed TTS cache):
- all covered: `praise` ("意思都讲到了，很好。"), `summary` (optional), `next`.
- something missing: `opener` ("有一个意思没讲到。" / "有N个意思没讲到。"; "有些地方的意思和原文不一样。" when every non-covered idea is a wrong meaning), then <= 2 of `correction` (`caption` = idea `textZh`, `start/end` = offsets; "漏掉了这个意思：…" for missing, short explanation for `wrong_meaning`/`language`) each followed by `correction_model` ("可以这样说：" + reference wording), then `next`. Order: wrong_meaning > missing > language > partial; tone only fills a leftover slot.
- partial/low-confidence only: `opener` "大部分意思都讲到了。" (soft praise only), partial corrections.
- `comparisonStatus:"unavailable"`: `opener` "这次没能比较意思。" + `next` ("再讲一遍吧。"); no claim about coverage. When the transcript does not match the TonePerfect check (`gate:"low_match"`: noise, a different sentence) the only line is `gate` "我没有听清楚，请再讲一遍。" (status `coaching` skipped, code `low_match`), with `comparisonReason:"low_match"`.
`done.corrections[]` carry `ideaId`; `done.summary` has `comparisonStatus, coveredCount, totalCount, canPraise, tone, droppedIdeas, compareAttempts`. `done.timings` adds `sttMs`, `compareMs` (LLM only), `assessMs` (TonePerfect, in parallel), `toneWaitMs` (extra wait for TonePerfect after the comparison was ready), plus `firstCoachTextMs`, `firstAudioMs`, `totalMs`.

Errors (terminal, no coaching): `stt_not_configured`, `transcription_failed`, `no_speech_detected` (stage `transcribing`), `retell_too_long` (> 300 hanzi). If BOTH the comparison and the tone check fail the stream ends with an `error` at stage `assessment`. If only the comparison fails the assessment is still sent (`comparisonStatus:"unavailable"`) with a tone result.

### Tone in retell (decision)
The acoustic reference is the **transcript** (hanzi only, simplified), `lowConfidence:true`, existing tone policy (<= 2 confirmed claims, score threshold, density limit) unchanged. Consequences, documented on purpose: `assessment.syllables[]/words[]/facts.confirmedToneErrors` refer to `referenceText` (the learner's own words), NOT to `chunkText`; a tone line is a hedged, code-built sentence ("按我听到的词，“X”应该读第N声，我听到的是第M声。") modelled on the learner's own word, and only appears after meaning feedback (it never replaces it and never accompanies praise from the LLM). **The transcript is never used to make a tone claim** - tone claims come only from TonePerfect facts. TonePerfect is skipped (`retell.tone.status:"skipped"` + reason, no claim) when the transcript has digits/latin letters, > 100 hanzi, or TonePerfect fails/times out (3 s); the meaning feedback is delivered anyway.

### Validation of LLM text (retell)
`wrong_meaning`/`language` corrections must quote the transcript (verified); `wrong_meaning` needs a non-covered idea; explanations containing tone talk or praise are replaced by a fixed line (`source:"server_fact"`); `modelText` must be grounded (<= 15% characters not in the reference/function words, no latin/digits, no tone talk) else the reference span is used instead; the LLM `summary` is spoken only when `canPraise` and contains no negative words.


## Reused-phrase word check (retell + Q&A; added 2026-10-28, bug: a mispronounced script word must never get an all-clear)
**Why.** The meaning check allows own wording, so `一种不太好的谩骂的天赋` (STT of a mispronounced 驾驭) still "covered" the key point 一种不太好驾驭的天赋 and the coach said "回答得很好，要点都讲到了". Now CODE (no LLM) looks for stretches of the transcript that reuse a script phrase almost verbatim and reports the script words that are wrong/missing in them.

**Detection** (`services/reuse.js`, thresholds = named constants in `ASSESSMENT_POLICY`): units = retell: the chunk; Q&A: each key point text of the signed question. Transcript is normalised to simplified (opencc). Smith-Waterman local alignment at pinyin level (same toneless pinyin = match, near-homophone = partial match, so STT homophones never count), up to 3 passes. A region counts as a **reuse** only if `longest verbatim run >= REUSE_MIN_RUN (4)`, `matched chars >= REUSE_MIN_MATCHED (5)` and `matched / max(script span, matched + heard content chars) >= REUSE_MIN_RATIO (0.6)`; everything else (paraphrases, noise, hallucinations) is never flagged. Inside a reuse region the gaps between matching runs are classified (function chars 的了就也都还又和而着过吗呢吧啊嘛呀么地得之才很 + pronouns 我你他她它们这那 and punctuation ignored; 不/没 are content):
- script content word(s) vs heard content word(s) => **`substituted`**, `heard` = the word STT wrote. `confidence:"high"` when both neighbouring runs are verbatim (>= `REUSE_FLANK_MIN` (2) chars each side, required for ANY finding), the heard word shares no character with the script word and is about as long; `"medium"` otherwise (variant sharing a character, e.g. 驾驭 vs 驾驶; one-sided anchor at the edge of the reuse = at most 3 chars, same-size replacement only).
- script word absent, nothing heard => **`missed`** (`reason:"omitted"`, `confidence:"medium"`), only when the WHOLE script word is gone (学习 -> 学, 自行车 -> 车 are wording, not omissions).
- extra heard content words with no script counterpart => insertion, **informational only** (never a finding, never blocks praise); listed in `facts.reusedPhrase.inserted` (strings) for information.
- gaps longer than `REUSE_MAX_BLOCK` (6) chars, gaps across sentence punctuation, and script words that appear verbatim elsewhere in the transcript are never flagged. At most `REUSE_MAX_FINDINGS` (3), high first. Flagged spans are expanded to whole script words.

**Consequences** (only when findings exist): `praiseLevel` is never `"full"` (`"soft"` or `"none"`), `canPraise:false` (also `facts.canPraise`), `praiseBlockedBy:["word_check"]`, `wordCheck:{status:"found",count}`, `facts.completeness:"incomplete"`; the all-clear line is never spoken. Coaching: opener `有个词和原文不一样。` (instead of the soft praise line), then max **2** corrections in total, **word problems first**, each followed by a `correction_model` `应该这样说：<script word>` (TTS = the correct word, like close mode): high `你说的是“谩骂”，原文是“驾驭”。`, medium `我好像听到的是“谩骂”，原文是“驾驭”。`, missed `漏掉了“X”这个词。` (medium: `好像漏掉了“X”这个词。`). Text is built from the diff facts only. Tone rules are unchanged (the transcript is never used for tone; TonePerfect-on-transcript in retell is untouched).

**Data.** Each finding appears in `wordStatus` (one entry per script word, NOT per character; `reuse:true`): `{start,end,text,pinyin,status:"substituted"|"missed",heard?|reason:"omitted",source:"stt",confidence,detail,reuse:true,chunkIndex?,keyPointId?}`; `start/end` are code-point offsets into the exact `chunkText` (retell: the chunk you sent; Q&A: the question's chunk — `chunkIndex` + `keyPointId` are on the entry; offsets = `keyPoint.refStart` + local offset). Also in `facts.substitutedWords` / `facts.missingWords`, `retell.suggestedWords` / `qa.suggestedWords` (`reason:"substituted"|"omitted"`, listed first), `done.corrections[]` (`kind:"substituted"|"missing"`, `heard`, `factRef:"reuse:N"`), `coach_text` (`start/end/caption`), and **auto-saved** to the "words I don't know" list exactly like close rehearsal (`savedMissed` on the event, `sourceChunk` = the script chunk; no audio / transcript / heard text persisted — the heard text is only in the event). `wordStatus` / `savedMissed` stay `[]` in retell/Q&A when nothing is found. **Q&A: send the optional multipart field `chunkText`** (the script chunk the question was generated from; used as `sourceChunk` only when it reproduces EVERY key point text at its `refStart`; otherwise the key point text is stored).

**Highlighting (Frontend).** Highlight `chunkText[start,end)` ("In your script") in the substituted colour and show a "Word check" row: `你说的是“<heard>”，原文是“<text>”`. Exact case (real output of the fakes, Q&A; retell has the same shape without `chunkIndex/keyPointId`, `retell.suggestedWords[].ideaId`, `retell.praiseBlockedBy`, `retell.wordCheck`):
```json
{
 "basis": "transcript",
 "transcript": "这种自我能量是一种不太好的谩骂的天赋。",
 "lowConfidence": true,
 "wordStatus": [
  {
   "start": 15,
   "end": 17,
   "text": "驾驭",
   "pinyin": "jià yù",
   "status": "substituted",
   "heard": "谩骂",
   "source": "stt",
   "confidence": "high",
   "detail": "a script word inside a phrase the transcript reuses almost verbatim is replaced by a different word (matching runs 5/3)",
   "reuse": true,
   "chunkIndex": 0,
   "keyPointId": "k1"
  }
 ],
 "savedMissed": [
  {
   "id": 1,
   "text": "驾驭",
   "pinyin": "jià yù",
   "meaning": null,
   "reason": "substituted",
   "start": 15,
   "end": 17,
   "missCount": 1,
   "isNew": true
  }
 ],
 "facts": {
  "substitutedWords": [
   {
    "ref": "reuse:0",
    "score": null,
    "text": "驾驭",
    "pinyin": "jià yù",
    "start": 15,
    "end": 17,
    "chars": [],
    "source": "stt",
    "confidence": "high",
    "heard": "谩骂",
    "chunkIndex": 0,
    "keyPointId": "k1"
   }
  ],
  "missingWords": [],
  "completeness": "incomplete",
  "canPraise": false,
  "reusedPhrase": {
   "findings": 1,
   "inserted": []
  }
 },
 "qa": {
  "keyPoints": [
   {
    "id": "k1",
    "textZh": "一种不太好驾驭的天赋",
    "refStart": 10,
    "refEnd": 20,
    "chunkIndex": 0,
    "covered": true,
    "evidence": "一种不太好的谩骂的天赋",
    "confidence": "high"
   }
  ],
  "canPraise": false,
  "praiseLevel": "soft",
  "praiseBlockedBy": [
   "word_check"
  ],
  "wordCheck": {
   "status": "found",
   "count": 1
  },
  "suggestedWords": [
   {
    "text": "驾驭",
    "pinyin": "jià yù",
    "meaning": null,
    "keyPointId": "k1",
    "reason": "substituted"
   }
  ],
  "comparisonStatus": "ok"
 }
}
```
Coach lines (`coach_text`): opener: 有个词和原文不一样。 | correction (start 15, end 17, caption "驾驭 jià yù"): 你说的是“谩骂”，原文是“驾驭”。 | correction_model (start 15, end 17): 应该这样说：驾驭 | next: 再试一次，或者下一个问题。
Q&A chunk used: `他说，这种自我能量是一种不太好驾驭的天赋。` (`驾驭` = code points 15-17).

# Q&A practice mode (added 2026-10-28)

The coach asks a spoken Mandarin question about the script; the learner answers freely by voice; the answer is checked against the **script text only**. **Stateless**: nothing is stored (no question, transcript, audio, conversation); a question is a *signed payload* the client keeps and sends back. All routes need the login cookie (401 otherwise). Prefs: `practiceMode` now also accepts `"qa"` (`PUT /api/prefs`); `POST /api/attempt` itself still only takes `listen_repeat|fading_cues` (Q&A has its own endpoints). Code: `server/services/qa.js`, `server/routes/qa.js`, `server/lib/qa-sign.js`.

Flow: `POST /api/qa/next` -> speak `questionZh` (client calls `POST /api/tts`, or use `?audio=1`) -> record -> `POST /api/qa/attempt` (SSE) -> on a miss the client may call `/api/qa/hint` (level 1, then 2) or `/api/qa/answer`, retry the same question (send the same question payload with a NEW `attemptId`) or call `/next` again with `avoid`.

## POST /api/qa/next   (JSON)
```
{ "chunks": ["小明放学后回家踢足球。晚上他和妈妈一起做饭。"],   // required, 1-80 strings, already stripped of [stage directions]; a chunk needs >= 6 hanzi to be asked about
  "type": "what|why|how|who|any",     // optional (default any). any = the server rotates what->why->how->who by how many questions the client already asked (avoid.length); the LLM may switch if the text cannot support the type; the RETURNED type is the type actually asked
  "level": 1,                         // optional: 1 = one stated fact (default), 2 = a reason / a link between two stated facts
  "avoid": ["qc0b9f15c685b", "小明为什么早上六点半起床？"],   // optional, <= 40 entries (ids and/or question TEXTS, <= 120 chars). Send the question TEXTS (and ids): only texts reach the LLM so it can pick a different fact; ids give an exact-duplicate check. The server keeps no memory.
  "chunkIndex": 0 }                   // optional: force which chunk to ask about (default: random among the eligible chunks)
```
`?audio=1[&voice=..&speed=..]` additionally synthesises the question (OpenAI TTS via the shared TTS cache) and returns `questionAudio:{url}` (the url is valid ~5 min like all `/api/audio/*`); if TTS fails the field is simply absent (use `POST /api/tts`). Default: no audio (keeps `/next` ~1-2 s).

Response (the whole object minus `ok`, `questionPinyin`, `questionAudio`, `timings`, `repeated` must be sent back unchanged as `question`; extra fields are ignored, **unsigned**: `questionPinyin`, `questionAudio`, `timings`, `ok`, `repeated`):
```json
{
 "ok": true,
 "questionId": "qc0b9f15c685b",
 "type": "how",
 "level": 1,
 "questionZh": "小明放学后怎么安排时间？",
 "keyPoints": [
  {
   "id": "k1",
   "textZh": "回家踢足球",
   "refStart": 5,
   "refEnd": 10,
   "chunkIndex": 0
  },
  {
   "id": "k2",
   "textZh": "晚上他和妈妈一起做饭",
   "refStart": 11,
   "refEnd": 21,
   "chunkIndex": 0
  }
 ],
 "modelAnswerZh": "他放学后先踢足球，晚上和妈妈做饭。",
 "hintZh": "看看放学后的活动顺序。",
 "sourceChunkIndex": 0,
 "signature": "IBC0CcPXRuKijqkjQSPM-0EDb4u21XmJ1kuISOhgGEk",
 "questionPinyin": "xiǎo míng fàng xué hòu zěn me ān pái shí jiān？",
 "questionAudio": {
  "url": "/api/audio/ac8b5e8f198fdfa19bb7a3be.mp3"
 },
 "timings": {
  "generateMs": 5,
  "llmAttempts": 1,
  "audioMs": 6,
  "totalMs": 24
 }
}
```
- `keyPoints`: 1-3 short ideas an answer must contain. `textZh` is the exact reference text; `refStart/refEnd` are **code-point** offsets into chunk `chunkIndex` (== the `chunks[]` index you sent) **resolved by the server** (the LLM only quotes; unresolvable/invented quotes are dropped; spans never cross a sentence end). Highlight with `Array.from(chunk).slice(refStart, refEnd)`.
- `questionId` is deterministic (`q` + hash of question + key points): the same question gets the same id. `signature` = HMAC-SHA256 (key derived from `SESSION_SECRET`/`APP_PASSCODE`) over `questionId, type, level, questionZh, modelAnswerZh, hintZh, sourceChunkIndex, keyPoints[id,textZh,refStart,refEnd,chunkIndex]` — a changed or foreign payload gets `400 invalid_question_signature`; a malformed one `400 invalid_question`. Ids/signatures stay valid across restarts as long as the secret is unchanged; changing `APP_PASSCODE`/`SESSION_SECRET` invalidates all in-flight questions (ask for a new one).
- `repeated:true` (only then present): the model could not find a question different from `avoid` after one retry; show it or call `/next` again.
- Errors: `400 invalid_chunks|stage_directions_in_chunk|chunks_too_short|invalid_type|invalid_level|invalid_avoid|invalid_chunk_index`, `413 script_too_long` (> 2000 hanzi in total), `503 llm_not_configured`, **`502 question_generation_failed`** (no question with a grounded key point after 2 LLM tries; message names the reason: `no_grounded_key_point|malformed_output|...`; just retry).

## POST /api/qa/hint   (JSON: the question payload, optional `"hintLevel": 1|2`; no LLM)
```
{"ok":true,"questionId":"qc0b9f15c685b","hintZh":"看看放学后的活动顺序。","level":1,"hasMore":true}
{"ok":true,"questionId":"qc0b9f15c685b","hintZh":"答案是这样开头的：回家……","level":2,"hasMore":false}
```
Level 1 = the signed hint (does not contain the answer words); level 2 = code-built: the first half of the first key point. Speak either via `POST /api/tts`. (`hintLevel`, not `level`: `level` is part of the signed question.) `400 invalid_hint_level|invalid_question|invalid_question_signature`.

## POST /api/qa/answer   (JSON: the question payload; no LLM)
```json
{
 "ok": true,
 "questionId": "qc0b9f15c685b",
 "modelAnswerZh": "他放学后先踢足球，晚上和妈妈做饭。",
 "sourceChunkIndex": 0,
 "keyPoints": [
  {
   "id": "k1",
   "textZh": "回家踢足球",
   "refStart": 5,
   "refEnd": 10,
   "chunkIndex": 0
  },
  {
   "id": "k2",
   "textZh": "晚上他和妈妈一起做饭",
   "refStart": 11,
   "refEnd": 21,
   "chunkIndex": 0
  }
 ],
 "suggestedWords": [
  {
   "text": "回家",
   "pinyin": "huí jiā",
   "meaning": null,
   "keyPointId": "k1"
  },
  {
   "text": "足球",
   "pinyin": "zú qiú",
   "meaning": null,
   "keyPointId": "k1"
  },
  {
   "text": "晚上",
   "pinyin": "wǎn shàng",
   "meaning": null,
   "keyPointId": "k2"
  },
  {
   "text": "妈妈",
   "pinyin": "mā ma",
   "meaning": null,
   "keyPointId": "k2"
  }
 ]
}
```
`suggestedWords` = vocabulary of the key points (same builder as retell); only the words found by the reused-phrase word check (below) are auto-saved.

## POST /api/qa/attempt   (multipart -> SSE, same plumbing as `/api/attempt`)
Fields: `audio` (file, <= 10 MB), `question` (**string**: the JSON payload from `/next`, <= 16 KB), `attemptId` (8-100 chars; **idempotent replay** within 10 min exactly like `/api/attempt`; use a new id for every recording, also for a retry of the same question), optional `voice`, `speed` (coach TTS). `source:"tts"` audio is rejected. Errors before the stream: `400 missing_audio|invalid_question|invalid_question_signature|invalid_attempt_id|tts_audio_rejected`, `413 upload_too_large|question_too_large`, `409 attempt_in_progress`, `429`.

Events: `status*`, `assessment | error`, `status(coaching)`, `coach_text*`, `coach_audio*`, `done` (same names/semantics as `/api/attempt`; `coach_text` payload is `{delta,index,role,caption?,start?,end?}`).
Pipeline: STT (no reference in the prompt, normalised to simplified) -> **LLM answer check** (`QA_MODEL`, temp 0, strict JSON, 1 retry) in parallel with the optional **TonePerfect** check of the transcript (same policy as retell: `lowConfidence:true`, skipped when the transcript has digits/latin or > 100 hanzi, waits at most `QA_TONE_WAIT_MS=3000`, skipped silently with a reason otherwise). The LLM sees ONLY the signed key points + model answer + transcript; it returns per key point `covered true|"partial"|false` + `evidence` + `confidence`, `wrongFacts[{claim,contradicts,confidence}]`, `answeredQuestion`. **CODE** then verifies: evidence and wrong-fact quotes must really be in the transcript (pinyin-level, trad/simp tolerant; otherwise `covered` is demoted to `partial`/`low` and the claim dropped), a wrong fact needs a non-low confidence, an existing key point id and may not contradict a covered key point (max 2), all signed key point ids must be present, and an answer sharing no words with the question/key points (or "I don't know") is `off_topic`/`dont_know` even if the model said "answered". Counts, `canPraise`, `praiseLevel` are computed by code; every spoken line is code-built (the LLM never writes coaching text, never gives offsets).

`assessment` event: the usual fields of the retell assessment (`basis:"transcript"`, `referenceText` = the transcript's hanzi, `transcript`, `facts`, `wordStatus:[]` and `savedMissed:[]` (except reused-phrase findings, below), `lowConfidence:true`, + TonePerfect fields when tone ran) **plus `qa`** (real output; here key point 2 is missed):
```json
{
 "questionId": "qc0b9f15c685b",
 "transcript": "他放学后踢足球。",
 "sttStatus": "ok",
 "tone": {
  "status": "ok"
 },
 "modelAnswerZh": "他放学后先踢足球，晚上和妈妈做饭。",
 "keyPoints": [
  {
   "id": "k1",
   "textZh": "回家踢足球",
   "refStart": 5,
   "refEnd": 10,
   "chunkIndex": 0,
   "covered": true,
   "evidence": "放学后踢足球",
   "confidence": "high"
  },
  {
   "id": "k2",
   "textZh": "晚上他和妈妈一起做饭",
   "refStart": 11,
   "refEnd": 21,
   "chunkIndex": 0,
   "covered": false,
   "evidence": null,
   "confidence": "high"
  }
 ],
 "coveredCount": 1,
 "totalCount": 2,
 "partialCount": 0,
 "wrongFacts": [],
 "answeredQuestion": true,
 "answerKind": "answered",
 "canPraise": false,
 "praiseLevel": "none",
 "comparisonStatus": "ok",
 "missingKeyPointIds": [
  "k2"
 ],
 "suggestedWords": [
  {
   "text": "晚上",
   "pinyin": "wǎn shàng",
   "meaning": null,
   "keyPointId": "k2"
  },
  {
   "text": "妈妈",
   "pinyin": "mā ma",
   "meaning": null,
   "keyPointId": "k2"
  },
  {
   "text": "一起",
   "pinyin": "yì qǐ",
   "meaning": null,
   "keyPointId": "k2"
  },
  {
   "text": "做饭",
   "pinyin": "zuò fàn",
   "meaning": null,
   "keyPointId": "k2"
  }
 ]
}
```
- `comparisonStatus`: `"ok"` | `"unavailable"` (malformed/failed LLM output, or gate `low_match`; `comparisonReason`); when unavailable: key points are listed with `covered:null`, `answeredQuestion:null`, `coveredCount:0`, no claims, `canPraise:false`.
- `covered`: `true` | `"partial"` | `false` | `null`. A key point with a wrong fact has `covered:false, issue:"wrong_fact"`.
- `praiseLevel`: `full` (all key points covered with non-low confidence, no wrong facts, question answered => `canPraise:true`) | `soft` (nothing missing or wrong, but a partial/low-confidence key point) | `none`. `answerKind`: `answered | dont_know | off_topic`.
- `tone`: `{status:"ok"}` or `{status:"skipped", reason}`; tone is NEVER derived from the transcript.

`coach_text` roles (all lines code-built; fixed lines have pre-warmed TTS): 
- full: `praise` "回答得很好，要点都讲到了。" -> `next` "来下一个问题吧。" (with a confirmed tone error: `opener` "要点都讲到了，有一个发音可以再练一练。", the tone `correction`/`correction_model`, `next`).
- missing/wrong/partial: `opener` ("有一个要点没讲到。" / "有些地方和原文不一样。" / "还差一点，有个要点没讲全。") -> up to **2** `correction`s (wrong fact > missing > partial; `caption` + `start/end` = the key point's offsets in chunk `sourceChunkIndex`; "你说的“…”和原文不一样。" / "漏掉了这个要点：…" / "这个要点只讲了一部分：…") -> one `correction_model` "可以这样说：<signed modelAnswerZh>" -> `next` "再试一次，或者下一个问题。". Tone corrections only fill leftover slots (meaning first).
- off-topic / "I don't know": `opener` ("这个回答好像没有回答问题。" / "没关系，这个问题还没答出来。") -> `next` "想要提示可以点提示，也可以再试一次。" (no model answer is spoken: offer hint / `/api/qa/answer`).
- unavailable: `opener` "这次没能检查你的回答。" -> `next`. Gate noise: only "我没有听清楚，请再说一遍。".
`done`: `corrections[]` (`kind: missing_key_point|wrong_fact|tone`, `keyPointId`, `chunkIndex`, `start/end`, `factRef:"kp:k2"`, `heard` for wrong facts), `summary {questionId, comparisonStatus, coveredCount, totalCount, canPraise, tone, droppedClaims, checkAttempts, llmCalled, coached, timings}` and `timings {receiveMs, sttMs, checkMs, assessMs, toneWaitMs, firstCoachTextMs, firstAudioMs, ttsFirstAudioMs, ttsFirstCached, totalMs}` (`checkMs` = the answer-check LLM). Terminal `error` events (stage `transcribing|assessment`): `stt_not_configured`, `transcription_failed`, `no_speech_detected`, `qa_answer_too_long` (> 300 hanzi), `assessment_unavailable` (check AND tone both failed).
Remaining events (output of the code, fake STT/LLM; the answer "他放学后踢足球。" misses key point 2):
```
EVENT coach_text {"delta":"有一个要点没讲到。","index":0,"role":"opener"}
EVENT coach_text {"delta":"漏掉了这个要点：晚上他和妈妈一起做饭","index":1,"role":"correction","caption":"晚上他和妈妈一起做饭","start":11,"end":21}
EVENT coach_text {"delta":"可以这样说：他放学后先踢足球，晚上和妈妈做饭。","index":2,"role":"correction_model","start":11,"end":21}
EVENT coach_text {"delta":"再试一次，或者下一个问题。","index":3,"role":"next"}
EVENT done {"corrections":[{"kind":"missing_key_point","targetText":"晚上他和妈妈一起做饭","explanationZh":"漏掉了这个要点：晚上他和妈妈一起做饭","modelText":"晚上他和妈妈一起做饭","factRef":"kp:k2","source":"server_fact","start":11,"end":21,"keyPointId":"k2","chunkIndex":0,"evidence":{"source":"transcript","confidence":"high"}}],"summary":{"engine":"toneperfect","mock":false,"basis":"transcript","transcriptUsed":true,"questionId":"qc0b9f15c685b","confirmedToneErrors":0,"comparisonStatus":"ok","coveredCount":1,"totalCount":2,"canPraise":false,"tone":"ok","coached":true,"llmCalled":true,"droppedClaims":0,"checkAttempts":1,"timings":{"receiveMs":6,"transcodeMs":0,"sttMs":11,"checkMs":9,"assessMs":17,"toneWaitMs":9,"firstCoachTextMs":30,"firstAudioMs":38,"ttsFirstAudioMs":8,"ttsFirstCached":false,"totalMs":46}},"timings":{"receiveMs":6,"transcodeMs":0,"sttMs":11,"checkMs":9,"assessMs":17,"toneWaitMs":9,"firstCoachTextMs":30,"firstAudioMs":38,"ttsFirstAudioMs":8,"ttsFirstCached":false,"totalMs":46}}
```

### Q&A limits (documented)
The checker only knows the signed key points + model answer: facts outside the key points cannot be judged (they are neither praised nor accused). A question is generated from ONE chunk (the rest of the script is not sent to the LLM). Very short clips ("我不知道") can be mis-transcribed by STT (once heard as Japanese) and then give `no_speech_detected`. The learner's grammar slips may be auto-corrected by STT. Tone checking of free answers uses the transcript as the acoustic reference (unvalidated with real credits for QA).


# Free talk mode (added 2026-10-28)

Chris talks freely in Mandarin about a topic, one turn at a time. Each turn the server does STT, then the coach answers in SHORT spoken Mandarin: a natural reaction + ONE follow-up question (conversation partner), plus **at most one correction** (word choice / grammar / unnatural phrase / "I don't know how to say X") and, if relevant, **script vocabulary he could have used** (only words the client sent). All routes need the login cookie (401 otherwise). Prefs: `practiceMode` now also accepts `"free_talk"` (`PUT /api/prefs`); `POST /api/attempt` still only takes `listen_repeat|fading_cues` (Free talk has its own endpoints). Code: `server/services/talk.js` (pure logic + prompts + validation), `server/routes/talk.js`. Env: `TALK_MODEL` (ENV.md).

**Stateless.** Nothing is stored: no conversation, transcript, audio, corrections or words (tests assert DB + temp dir are untouched; nothing is auto-saved to "words I don't know" — `suggestedWords` are only suggestions for the client's "Save word" button, `POST /api/words/missed` is the client's call). The client keeps the conversation and sends the last turns' TEXT with every call. The server uses only the last **8 turns** (each turn <= 300 chars, all turns together <= 2400 chars; older/longer is silently cut; `done.summary.turnsSent/turnsUsed` tells you what happened). The only server memory is the usual 10-minute SSE replay record for an `attemptId` and the mp3 cache of the coach's own TTS.

**Grounding (what the coach may and may not say).**
- Corrections come from the **transcript text only** (word choice / grammar / unnatural phrasing). The LLM must quote the transcript; CODE verifies the quote is in the transcript (trad/simplified tolerant; a hallucinated quote => correction dropped), requires `confidence:"high"`, drops corrections whose "better" version has the same sounds (that is STT/pronunciation, never a text error) or is unchanged, and keeps at most ONE. `explainZh` is rewritten by code to a fixed neutral line if it is empty, long, contains Latin text, praise or a sound claim (`correction.source:"server"` instead of `"llm"`).
- **No tone / pronunciation claims are ever made from the transcript.** Reply, question, explanation and model sentences are filtered for tone/pitch/pronunciation words (same `TONE_CLAIM` filter as retell/Q&A, plus English sound words) and for praise of the learner's Chinese; a filtered sentence is dropped (never "repaired"). Tone is only reported from the **acoustic** engine when the client asks for it (`tone:true`, below).
- STT may autocorrect or mis-hear; the finder prompt says so and says "no correction unless clearly wrong and highly confident". If nothing is clearly wrong there is **no correction** — and if the finder judged the turn clearly natural (and it was >= 6 hanzi) the coach adds one short fixed line (`说得很自然。` / `这样说很自然。` / `你的说法很自然。`, role `praise`) at most. The server never invents a correction to have something to say.
- `english_gap` (he said English words because he did not know the Mandarin): the English text in the transcript is the `quote`, `betterZh` is the Mandarin word/phrase, `pinyin` is computed by code; it is **not an error** (spoken as "可以这样说：…"), and it is offered as a suggested word with `meaning` = the English he said (`reason:"english_gap"`). No Latin text is ever spoken or put in `coach_text`.
- `vocabHints` / `suggestedWords[reason:"script_vocab"]`: ONLY entries of the `scriptVocab` the client sent in this request (anything else the LLM names is dropped), and only words he did not already say. At most 2; the first one is spoken as `你也可以用“水果”这个词。` (role `vocab`) when there is no correction. Pinyin is always computed by code.

## POST /api/talk/turn  (multipart -> `text/event-stream`, same plumbing as `/api/attempt`)

Fields: `audio` (file, <= 10 MB), `attemptId` (8-100 chars; same idempotent replay as the other modes: same id => recorded events replayed with `X-Attempt-Replayed: true`, no second STT/LLM call; failed attempts re-run; concurrent duplicate => 409), `context` (JSON **string**, <= 32 KB), optional `voice`, `speed` (0.5-1.5, like the other modes). `source=tts` / `X-Audio-Source: tts` => 400 `tts_audio_rejected`.

```json
// context
{"topic": "我的周末",
 "scriptVocab": [{"text": "爬山"}, {"text": "风景", "pinyin": "ignored — computed by the server"}],   // optional, <= 200 entries sent (413 context_too_large beyond that); the first 40 unique 1-12 hanzi entries are used
 "turns": [{"role": "coach", "text": "这个周末你想做什么？"}, {"role": "user", "text": "我想去爬山。"}],   // optional, last turns' TEXT (capped as above); role "coach"|"user"
 "level": "normal",                                                                                        // optional "easy" (HSK2-3, <12 char sentences) | "normal" (default, HSK3-4)
 "tone": false}                                                                                            // optional, default false (see "Tone")
```

Pre-stream errors (JSON `{ok:false,error:{code,message}}`): 400 `missing_audio` `invalid_context` (not JSON / bad shape / bad `turns` role / non-boolean `tone` / non-string `topic`) `invalid_level` `invalid_attempt_id` `tts_audio_rejected` `invalid_upload`; 413 `upload_too_large` `context_too_large`; 401; 429 (40 turns / min). In-stream `error` events (retryable flag + `stage`): `llm_not_configured`, `stt_not_configured` (no OpenAI key), `talk_turn_too_long` (> 400 hanzi heard; ask for shorter turns), the usual STT failures (`stage:"transcribing"`, nothing coached), and `talk_llm_unavailable` (`stage:"coaching"`, `retryable:true`): the reply LLM failed twice — **no reply is fabricated**; the `transcript` event was already sent so the UI can keep what he said and offer "try again" (re-send with a NEW `attemptId`).

### Events (in this order; every event is optional except `transcript`/`done`)
1. `status {stage:"transcribing"}`
2. **`transcript`** — sent the moment STT finishes: `{"text":"我昨天去商店买了一个很多苹果，然后我回家。","sttStatus":"ok","hanziCount":19,"hasEnglish":false}`. `sttStatus` = `ok` | `empty` | `too_short` | `hallucination` (a non-`ok` status means the gate fired, see below). Show `text` as "what I heard"; it is simplified Chinese (+ any English he said).
3. `status {stage:"coaching"}`, then (only with `tone:true` and when it could run) `assessment` (below), `coach_text`, `coach_audio` …
4. **`coach_text`** `{"delta":"听起来很不错！","index":0,"role":"reply"}` — one event per spoken sentence, streamed as early as possible (the reply is sent to TTS the moment the LLM has produced it, before the correction finder is done). `role` ∈ `reply` (reaction to what he said) · `correction` (short Mandarin explanation; has `caption:"很多苹果 hěn duō píng guǒ"`) · `correction_model` (`可以这样说：很多苹果`; tone fact: `应该这样说：…`) · `vocab` · `praise` · `question` (the follow-up question) · `gate` (the fixed "didn't catch that" line). `index` counts spoken units from 0.
5. **`coach_audio`** `{"url":"/api/audio/<id>.mp3","index":0,"text":"听起来很不错！"}` — per sentence, in order, TTS pipelined (play them in `index` order; the `status {stage:"speaking"}` / `tts_unavailable` behaviour is identical to the other modes: when TTS is unavailable you still get all `coach_text`).
6. **`done`**
```json
{"correction": {"kind": "word_choice", "quote": "一个很多苹果", "betterZh": "很多苹果", "explainZh": "“很多”前面不用“一个”。", "pinyin": "hěn duō píng guǒ", "source": "llm"},
 "correctionStatus": "ok",
 "suggestedWords": [{"text": "很多苹果", "pinyin": "hěn duō píng guǒ", "meaning": null, "reason": "word_choice"},
                    {"text": "水果", "pinyin": "shuǐ guǒ", "meaning": null, "reason": "script_vocab"}],
 "vocabHints": [{"text": "水果", "pinyin": "shuǐ guǒ"}],
 "replyZh": "听起来很不错！", "questionZh": "你最喜欢吃什么水果？",
 "summary": {"basis": "transcript", "transcriptUsed": true, "turnsUsed": 1, "turnsSent": 1, "coached": true, "llmCalled": true, "replyAttempts": 1, "findAttempts": 1, "droppedClaims": 0, "tone": "skipped", "toneReason": "not_requested"},
 "timings": {"receiveMs": 20, "transcodeMs": 0, "sttMs": 18, "correctionMs": 13, "replyFirstTokenMs": 15, "replyMs": 17, "firstCoachTextMs": 37, "firstAudioMs": 46, "ttsFirstAudioMs": 9, "ttsFirstCached": false, "totalMs": 60}}
```
- `correction`: `null` or ONE object `{kind, quote, betterZh, explainZh, pinyin, source}`; `kind` ∈ `word_choice` | `grammar` | `unnatural` | `english_gap` (| `tone`, only with `tone:true`, see below). `quote` is verified to be in the transcript (for `english_gap`: the English words he said). `pinyin` is for `betterZh`. `suggestedWords[].meaning` is `null` unless known (English gap: the English he said; or a word already in the user's saved list); `reason` ∈ `word_choice|grammar|unnatural|english_gap|script_vocab`. For non-English kinds a short (2-6 hanzi) `betterZh` is offered as a suggested word.
- `correctionStatus`: `ok` (a correction is returned) | `none` (checked, nothing clearly wrong) | `unavailable:<reason>` (finder failed/malformed twice — conversation unaffected, simply no correction) | `timeout` | `skipped` (gate). `correctionLate:true` when the finder took longer than 3.5 s: then the order is reply → **question** → correction → model (the conversation is never blocked on the correction).
- `degraded:"reply_malformed"`: the reply LLM answered but twice not in the schema: the coach says the fixed line `请继续说，我在听。` (`replyZh` is then `null`, no question, no correction guessed).
- `timings`: `sttMs` (STT), `replyFirstTokenMs` (first LLM token of the reply), `replyMs`, `correctionMs` (finder wall time), `firstCoachTextMs`, `firstAudioMs` (from request start to the first `coach_audio`), `ttsFirstAudioMs`, `totalMs`; tone: `assessMs`, `toneWaitMs`.
- Stream design (measured choice): TWO parallel LLM calls after STT — a streamed **reply** call (`{"replyZh","questionZh"}`, temp 0.6, 160 tokens; `replyZh` is spoken as soon as its JSON string closes, `questionZh` is held until the correction decision) and a non-streamed **finder** call (temp 0, 260 tokens). A single streamed call was rejected: the correction needs a careful temp-0 judgement and must not delay the first audio.

### Gate (silence / noise / STT hallucination)
Empty, < 2 characters, or a known STT hallucination ("谢谢观看", "请订阅", "Thanks for watching" …) => `transcript.sttStatus` = `empty|too_short|hallucination`, ONE spoken line `我没有听清楚，请再说一遍。` (`coach_text.role:"gate"` + audio), `done {gate:"empty|too_short|hallucination", correction:null, correctionStatus:"skipped", suggestedWords:[], vocabHints:[], replyZh:null, questionZh:null, summary:{coached:false,llmCalled:false}}`. No LLM, no TonePerfect call. English-only speech is NOT noise (it is the "I don't know how to say it" case).

### Tone (optional, default OFF)
`context.tone:true` runs TonePerfect on the **transcript** as the reference (same as retell/Q&A; `lowConfidence:true`, existing policy: confirmed errors only, hedged). It is skipped silently (no error; `done.summary.tone:"skipped"` + `toneReason`) when: not requested (`not_requested`), the transcript has digits/Latin (`transcript_has_digits_or_latin`), > 100 hanzi, no hanzi, engine error/low-match/not finished within 3 s (`tone_check_timeout`). If it ran, an `assessment` event `{…engine result…, "lowConfidence":true, "basis":"transcript", "referenceText":"…", "transcript":"…", "facts":{…}, "wordStatus":[], "savedMissed":[]}` is sent before `done`, and a *confirmed* tone error becomes the single correction (`correction.kind:"tone", source:"server_fact"`, with `evidence`) **only when the text finder returned none** — the text correction always wins; at most one correction per turn. Tone is never inferred from text. Costs one TonePerfect credit per turn, so leave it off unless Chris asks.

## POST /api/talk/opening  (JSON, `?audio=1&voice=&speed=` optional)
Request `{"topic":"我的周末","scriptVocab":[{"text":"爬山"}],"level":"normal"}` (`topic` required, <= 120 chars; `scriptVocab`, `level` optional). Response:
```json
{"ok": true, "textZh": "这个周末你想做什么？", "pinyin": "zhè ge zhōu mò nǐ xiǎng zuò shén me？",
 "textAudio": {"url": "/api/audio/27e9a46d7568faba86d5dc62.mp3"},     // only with ?audio=1 (else call POST /api/tts with textZh)
 "timings": {"openingMs": 4, "llmAttempts": 1, "audioMs": 4, "totalMs": 8}}
```
Errors: 400 `invalid_topic` `invalid_level` `invalid_context`/`context_too_large` (scriptVocab), 503 `llm_not_configured`, 502 `opening_generation_failed` (LLM failed/malformed twice or the output broke a filter — never a fabricated opening; the client may fall back to its own canned question), 429 (40/min). One short friendly open question (<= 30 chars), no tone talk. Nothing stored.

## POST /api/talk/summary  (JSON)
Request `{"topic":"我的周末","turns":[{"role":"coach","text":"…"},{"role":"user","text":"…"}], "scriptVocab":[{"text":"爬山"}], "level":"normal"}` — the WHOLE session text (<= 200 turns, <= 20 000 chars total, else 413 `session_too_long`; the prompt itself uses only the last 40 turns / 6000 chars). Needs >= 1 non-empty `user` turn (400 `no_user_turns`). Response:
```json
{"ok": true,
 "takeaways": [{"textEn": "You described what you bought and where you went.", "textZh": "我去商店买了苹果。", "pinyin": "wǒ qù shāng diàn mǎi le píng guǒ。"}],     // 2-5 (aim 3-5)
 "newWords": [{"text": "水果", "pinyin": "shuǐ guǒ", "meaning": "fruit", "exampleZh": "我喜欢吃水果。"}],                              // 0-8, each word is 1-8 hanzi and appears in its own exampleZh; saveable by the client
 "phrasesToTry": [{"zh": "我买了很多苹果。", "pinyin": "wǒ mǎi le hěn duō píng guǒ。", "en": "I bought a lot of apples.", "whyEn": "Natural way to say a large amount."}],   // 1-5
 "strengths": ["Clear sequence of events."],                                                                                          // 1-2
 "statsDerived": {"turns": 4, "userTurns": 2, "approxCharsSpoken": 23},                                                              // by CODE: hanzi count of the user's turns
 "timings": {"summaryMs": 1500, "llmAttempts": 1, "droppedItems": 0, "totalMs": 1503}}
```
Strict schema check by code; items that break a rule (Latin in the Chinese fields, tone/pronunciation/accent words anywhere, newWord not contained in its example, …) are dropped; too little left (< 2 takeaways, no phrase or no strength) => retry once, then 502 `summary_generation_failed` (no fabricated summary). Errors: 400 `invalid_turns` `invalid_level` `invalid_request` `no_user_turns`, 413, 503 `llm_not_configured`, 429 (20/min). No pronunciation/tone claims, nothing stored.

### Free talk limits (documented)
Corrections are text-only judgements by an LLM with code guards: a wrong-but-grammatical phrase can slip through (no correction is the safe default), and when STT autocorrects a real error the coach cannot see it (he is never told his pronunciation was off — only the optional acoustic check can say that). One correction per turn means other errors in the same turn are not mentioned. English words are only detected as such when STT writes them in Latin letters (STT may transliterate/translate English into hanzi). Turns longer than 400 hanzi are refused. The coach reply varies (temperature 0.6); the finder is deterministic (temp 0).
