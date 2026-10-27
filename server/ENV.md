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
| `OPENAI_BASE_URL`, `COACH_MODEL`, `STT_MODEL`, `OPENAI_TTS_MODEL` | Overrides | `gpt-4o-mini`, `gpt-4o-transcribe`, `gpt-4o-mini-tts` |
| `MOCK_FORCE=unavailable` | Dev: make the mock engine always fail | Exercises the "no assessment obtained" Retry/Skip UI |

## Behaviour notes
- **Login lockout**: per IP, 5 wrong passcodes => locked 30 s, then 1 m, 5 m, 15 m, 1 h, 6 h on each further round; globally 20 failures in 10 min (any IPs) => 1 m, 5 m, 15 m, 1 h, 6 h. Locked => `429 {error:{code:"login_locked"}}` + `Retry-After`, even for the right passcode. Success resets that IP's ladder. Passcode compare is constant-time. State is in memory (resets on restart). Behind a proxy set `TRUST_PROXY` so IPs are real.
- **practiceMode** is validated against `listen_repeat|fading_cues` (prefs and attempt). Future values are rejected until implemented.
- **Keys unlock**: `TONEPERFECT_API_KEY` real assessment · `OPENAI_API_KEY` coaching text, STT (retell, close-mode omission detection when practiceMode=fading_cues), OpenAI TTS fallback, level-3 cues · `AZURE_SPEECH_KEY`+`REGION` preferred TTS · `APP_PASSCODE` login.
- Audio uploads are held in memory only and never written to disk or logged; TTS audio is cached in memory (5 min for /api/audio, LRU for /api/tts).
- Offline harness (not the app path): `node server/scripts/validate-synthetic.js` (OpenAI TTS -> TonePerfect, <= 8 credits, cached in `test-results/synthetic/`), `node server/scripts/validate-tones.js` (real recordings).

- **Assessment policy** (not env-configurable; named constants in `config.js` `ASSESSMENT_POLICY`): gate `LOW_MATCH_OVERALL_MAX=40`, `LOW_MATCH_PRONUNCIATION_MAX=60`; tone claims `TONE_REVIEW_MAX_SCORE=70`, `TONE_MAX_CLAIMS=2`, `TONE_DENSITY_MAX_RATIO=0.4` (chunks >= `TONE_DENSITY_MIN_SYLLABLES=4`). Derivation and caveats: `test-results/VALIDATION.md`.

Chris only ever has to supply: `APP_PASSCODE`, `TONEPERFECT_API_KEY`, `OPENAI_API_KEY`, and optionally `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`.
