# Backend environment variables

Read from the process environment at run time (a local `app/.env` is also loaded for dev if present; real env vars win).
Never commit secrets, never put them in the frontend, never log them (logs are redacted).

| Variable | Needed for | Default / notes |
|---|---|---|
| `APP_PASSCODE` | Login (REQUIRED in production) | Dev only (NODE_ENV != production): `devpass` with a loud warning. In production, if unset, login returns 503 `passcode_not_configured`. |
| `TONEPERFECT_API_KEY` | Real pronunciation assessment | `tp_live_...` (real, spends credits) or `tp_test_...` (fixed fake result, free). Absent => engine `mock`. |
| `OPENAI_API_KEY` | Coaching LLM, speech-to-text, TTS fallback | Absent => `services.llm/stt` false; coaching/STT report a clear "not configured" error, nothing invented. |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | Azure Mandarin neural TTS (preferred) | Optional. Both required. Else OpenAI TTS is used if `OPENAI_API_KEY` is set. |
| `ASSESSMENT_ENGINE` | Force an engine | `mock` or `toneperfect`. Default: `toneperfect` if a key is set, else `mock`. |
| `PORT` | HTTP port | `8080` |
| `DATA_DIR` | SQLite location (`coach.db`) | `app/data` (needs a persistent disk when deployed) |
| `NODE_ENV` | `production` => Secure cookie, no dev passcode | |
| `SESSION_SECRET` | Cookie signing | Optional; derived from the passcode if unset. |
| `SESSION_DAYS` | Login cookie lifetime | `30` |
| `TRUST_PROXY` | Express trust proxy | `1` in production (behind one reverse proxy), off otherwise |
| `CORS_ORIGINS` | Comma-separated allowed origins | Empty. Frontend is same-origin, so normally unused. |
| `TONEPERFECT_BASE_URL` | Point at a fake server in tests | `https://api.toneperfect.app` |
| `AZURE_SPEECH_BASE_URL` | Test override for the Azure endpoint | `https://<region>.tts.speech.microsoft.com` |
| `LLM_PROVIDER` | Coaching LLM provider | only `openai` is implemented; anything else logs a warning and falls back |
| `OPENAI_BASE_URL`, `COACH_MODEL`, `STT_MODEL`, `OPENAI_TTS_MODEL` | Overrides | `gpt-4.1-mini`, `gpt-4o-transcribe`, `gpt-4o-mini-tts` |
| `STT_WAIT_MS` | How long to wait for the STT transcript after TonePerfect returned, before going acoustic-only | `3000` |
| `RETELL_MODEL` | Model for the retell meaning comparison (JSON mode, temperature 0, max 700 tokens) | `COACH_MODEL`, else `gpt-4.1-mini` |
| `QA_MODEL` | Model for Q&A question generation (JSON mode, temp 0.7, max 420 tokens) and the Q&A answer check (temp 0, max 450 tokens) | `COACH_MODEL`, else `gpt-4.1-mini` |
| `COACH_LLM_TONE` | `1`/`true`: let the LLM phrase tone explanations (≈ +1.5–3 s; default: code-built lines) | off |
| `MOCK_FORCE=unavailable` | Dev: make the mock engine always fail | Exercises the "no assessment obtained" Retry/Skip UI |

## Behaviour notes
- **Login lockout**: per IP, 5 wrong passcodes => locked 30 s, then 1 m, 5 m, 15 m, 1 h, 6 h on each further round; globally 20 failures in 10 min (any IPs) => 1 m, 5 m, 15 m, 1 h, 6 h. Locked => `429 {error:{code:"login_locked"}}` + `Retry-After`, even for the right passcode. Success resets that IP's ladder. Passcode compare is constant-time. State is in memory (resets on restart). Behind a proxy set `TRUST_PROXY` so IPs are real.
- **practiceMode** is validated against `listen_repeat|fading_cues` for `/api/attempt`; the prefs enum also accepts `trouble_word` (drills use `/api/drill/attempt`).
- **Keys unlock**: `TONEPERFECT_API_KEY` real assessment · `OPENAI_API_KEY` coaching text, STT (retell, and **every close-mode attempt** for missing/wrong-word detection, in parallel with TonePerfect; without it the assessment is acoustic-only and says so), OpenAI TTS fallback, level-3 cues · `AZURE_SPEECH_KEY`+`REGION` preferred TTS · `APP_PASSCODE` login.
- Audio uploads are held in memory only and never written to disk or logged; TTS audio is cached in memory (5 min for /api/audio, LRU for /api/tts).
- Offline harness (not the app path): `node server/scripts/validate-synthetic.js` (OpenAI TTS -> TonePerfect, <= 8 credits, cached in `test-results/synthetic/`), `node server/scripts/validate-tones.js` (real recordings).

- **Assessment policy** (not env-configurable; named constants in `config.js` `ASSESSMENT_POLICY`): gate `LOW_MATCH_OVERALL_MAX=40`, `LOW_MATCH_PRONUNCIATION_MAX=60`; tone claims `TONE_REVIEW_MAX_SCORE=70`, `TONE_MAX_CLAIMS=2`, `TONE_DENSITY_MAX_RATIO=0.4` (chunks >= `TONE_DENSITY_MIN_SYLLABLES=4`). Derivation and caveats: `test-results/VALIDATION.md`.

Chris only ever has to supply: `APP_PASSCODE`, `TONEPERFECT_API_KEY`, `OPENAI_API_KEY`, and optionally `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`.
- **Word detection / latency constants** (`ASSESSMENT_POLICY`, not env-configurable except `STT_WAIT_MS`): `ACOUSTIC_MISSING_WORD_MAX=65`, `ACOUSTIC_INITIAL_ABSENT_MAX=30`, `STT_MIN_COVERAGE=0.3`, `SAVE_LOW_SCORE_WORD_MAX=55`, `LONG_PAUSE_MS=500`; `DRILL_GRADUATE_STREAK=3`. Outbound HTTP uses undici keep-alive; fixed coach phrases are pre-synthesised at startup (TTS cache). `node server/scripts/measure-latency.js [--runs N --tp-delay ms --llm-tone]` measures stage timings against fakes + real OpenAI.
- **Retell constants** (`ASSESSMENT_POLICY`, not env-configurable): `RETELL_TONE_WAIT_MS=3000` (max extra wait for TonePerfect after the meaning comparison is ready), `RETELL_COMPARE_MAX_MS=9000` (wall cap incl. 1 retry), `RETELL_MAX_TRANSCRIPT_HANZI=300` (`retell_too_long`). Retell needs `OPENAI_API_KEY` (STT is mandatory; the LLM compare degrades to `comparisonStatus:"unavailable"`). Dependency: `opencc-js` (traditional -> simplified for STT output).
- **Q&A constants** (`ASSESSMENT_POLICY`, not env-configurable): `QA_NEXT_MAX_MS=8000` (wall cap of question generation incl. 1 retry => `502 question_generation_failed`), `QA_CHECK_MAX_MS=8000` (answer check => `comparisonStatus:"unavailable"`), `QA_TONE_WAIT_MS=3000`, `QA_MAX_TRANSCRIPT_HANZI=300`; script limits in `services/qa.js`: 2000 hanzi / 80 chunks per `/api/qa/next`, chunks need >= 6 hanzi. Question signatures use a key derived from `SESSION_SECRET` (or `APP_PASSCODE`): changing either invalidates in-flight questions. Q&A needs `OPENAI_API_KEY` (503/terminal `stt_not_configured` otherwise).
