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
Wording changes are NOT errors: **`wordStatus` is `[]` and no missed/substituted words are computed or auto-saved in retell** (`savedMissed:[]`, `facts.missingWords:[]`). Nothing is persisted: no audio, no transcript (the transcript is returned to the client only).

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
