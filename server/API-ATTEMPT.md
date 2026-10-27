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
Fields: `audio` (file, <=10 MB, audio/mp4|wav|webm|mpeg|ogg), `chunkText` (<=100 chars, no `[ ]【 】`), `assessMode` close|retell, `practiceMode` listen_repeat|fading_cues, `attemptId` (8-100 chars `[A-Za-z0-9._:-]`, unique per recording; re-send the SAME id when retrying the same take), optional `voice`, `speed` (0.5-1.5).
Validation failures are plain JSON `400 {error:{code,message}}` BEFORE the stream starts (`missing_audio`, `invalid_chunk`, `stage_directions_in_chunk`, `invalid_assess_mode`, `invalid_practice_mode`, `invalid_attempt_id`, `tts_audio_rejected`), `413 upload_too_large`, `409 attempt_in_progress`, `429` rate limit.

## Events (`event: <name>\ndata: <json>\n\n`)
```
event: status      data: {"stage":"uploading","engine":"toneperfect","mock":false}
event: status      data: {"stage":"assessing"}            (retell: {"stage":"transcribing"} first; also "coaching","speaking")
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
                    (+ "transcript","transcriptDerived":true when STT ran; retell => "basis":"transcript","lowConfidence":true)
event: status      data: {"stage":"coaching"}
event: coach_text  data: {"delta":"很好，发音很清楚。","index":0,"role":"praise"}      roles: praise|correction|correction_model|next
event: coach_text  data: {"delta":"第二个“谢”应该读第四声，你读成了第二声。","index":1,"role":"correction"}
event: coach_audio data: {"url":"/api/audio/9a93ae52934b74bcd1e1db9a.mp3","index":1,"text":"第二个“谢”应该读第四声，你读成了第二声。"}
event: done        data: {"corrections":[{"kind":"tone","targetText":"谢","explanationZh":"…","modelText":"谢谢","factRef":"tone:1","source":"llm"}],
                          "summary":{"engine":"toneperfect","mock":false,"overall":71.2,"confirmedToneErrors":1,"uncertain":1,"basis":"script",
                                     "transcriptUsed":false,"coached":true,"praiseZh":"…","nextPromptZh":"再说一遍吧。","droppedCorrections":0,
                                     "timings":{"assessMs":…,"firstAudioMs":…,"totalMs":…}}}
```
`coach_audio` arrive in order, one per `coach_text` index (the `next` prompt is last); each url is a short-lived (5 min) mp3 behind the cookie; play them with the single `<audio>` element, in order. `source` is `llm` | `server_fact` (server rewrote it from facts) | `server_rewrite` ("not sure" template).

Skips (stream continues, assessment still delivered): `{"stage":"coaching","skipped":true,"code":"llm_not_configured"|"openai_500"|…,"message":…}`, `{"stage":"speaking","skipped":true,"code":"tts_not_configured"|…}`, `{"stage":"transcribing","skipped":true,…}` (close mode only).

**Terminal error (no assessment, NO coaching text, stream then ends):**
```
event: error  data: {"code":"no_speech","message":"No assessment obtained: …","retryable":true,"canSkip":true,"stage":"assessment","engine":"toneperfect","mock":false}
```
Codes: engine codes (`no_speech`, `no_audio`, `different_content`, `not_configured`, `rate_limit`, `engine_unavailable`, …), `stt_not_configured`, `no_speech_detected`, `retell_too_long` (retell transcript > 100 hanzi), `invalid_reference`. Retry = re-POST with the SAME `attemptId` (failed attempts re-run; successful ones replay the recorded events with header `X-Attempt-Replayed: true` for 10 min, without spending credits again).

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
