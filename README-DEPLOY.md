# Deploying the Mandarin coach on Railway

Target: **Railway, Hobby plan, Singapore region, one persistent volume at `/data`** for the SQLite file (`coach.db`).
The app is one Node 20 service (`server/index.js`) serving the web pages and the API; `Dockerfile` builds it.
Research read from docs.railway.com on **2026-10-27**; links at the bottom. Nothing below has been run against a real Railway account yet.

## What is in this folder for Railway
| File | Purpose |
|---|---|
| `Dockerfile` | Node 20 (bookworm-slim). Installs `better-sqlite3` (prebuilt binary; build tools as fallback). Honours Railway's `$PORT`. `DATA_DIR=/data`. No `VOLUME` line (Railway forbids it). |
| `docker-entrypoint.sh` | Railway mounts the volume as root. This hands `/data` to the `node` user, then starts the app unprivileged. |
| `railway.json` | Builder = Dockerfile, healthcheck `/api/health` (120 s), restart on failure. **Deprecated format, see caveat below.** |
| `deploy-railway.sh` | Helper: dry run by default; `--apply` does the first deploy; `--redeploy` pushes new code. Never prints secrets. |
| `.env.example` | Variable names only. |
| `fly.toml`, `render.yaml` | Old alternatives, not maintained (see the end). |

## Variables (names only)
| Variable | Where it comes from |
|---|---|
| `APP_PASSCODE`, `TONEPERFECT_API_KEY`, `OPENAI_API_KEY` | Chris, via the secure form (the bot may read them from `server/.env` on the box). **Required.** |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | Optional pair (better Mandarin voice). |
| `DATA_DIR=/data`, `NODE_ENV=production` | Set by the script. |
| `PORT` | **Do not set.** Railway injects it. |

## Region: Singapore is selectable on Hobby
- Railway's service regions are US West (`us-west2`), US East (`us-east4-eqdc4a`), EU West (`europe-west4-drams3a`) and **Southeast Asia / Singapore (`asia-southeast1-eqsg3a`)**. The Railway Metal page says Trial and Hobby users can deploy to all Metal regions in the US, Europe and Southeast Asia. Singapore is the closest to Perth (there is no Australian region).
- Set it with the CLI: `railway service scale --service mandarin-coach southeast-asia=1` (CLI accepts `southeast-asia` or the full id). Or in the dashboard: service -> **Settings** -> **Scale** -> Regions. Or `railway.json` `deploy.multiRegionConfig` (legacy, below).
- **Do this before attaching the volume.** A volume follows its service's region; changing the region later migrates the volume and causes downtime. Multi-region replicas are Pro-only and volumes cannot have replicas: keep exactly one region with 1 replica.
- Replacing the `southeast-asia=1` CLI form by the dashboard is the fallback if the CLI step errors before the first deploy (unverified).

## Which token? (non-interactive deploys)
| Token | Env var | Can do | Cannot do |
|---|---|---|---|
| **Account token** ("No workspace") or **workspace token** | `RAILWAY_API_TOKEN` | `whoami`, `init` (create project), `add` (service), volumes, variables, `up`, `domain`, `service scale` | (nothing relevant; it is broad: treat like a password) |
| **Project token** | `RAILWAY_TOKEN` | `railway up`, `redeploy`, `logs` in **one environment of one existing project** | `whoami`, `link`, creating projects/services/volumes |

- Never set both (the project token silently wins). A project token only exists after the project does, so it **cannot do the first deploy**.
- **Recommendation: Chris creates one *account* token (https://railway.com/account/tokens, Workspace = "No workspace") and gives it to the bot via the secure form.** The bot does the whole first deploy. After it works, Chris deletes that token; for later code updates create a *project* token (project -> Settings -> Tokens) and use `--redeploy`.
- A workspace token (pick Chris's workspace in the dropdown) is narrower and probably also works with `railway init --workspace`, but this is **not verified**; if `whoami`/`init` rejects it, switch to the account token.
- The CLI never needs `railway login` when `RAILWAY_API_TOKEN` is set.

## First deploy: copy-paste (bot, from the box)
The token is read from the environment; secrets are read from `server/.env` (or env vars) and sent over stdin, never printed.
```bash
cd /workspace/mandarin-coach/app
export PATH="$HOME/.local/bin:$PATH"          # railway 5.71.0 lives here
# Token pasted from the secure form (do NOT echo it; don't use set -x):
read -rs RAILWAY_API_TOKEN && export RAILWAY_API_TOKEN

./deploy-railway.sh                # 1) dry run: checks CLI, token, secret NAMES, prints the plan
./deploy-railway.sh --apply        # 2) real first deploy
```
`--apply` runs exactly these CLI steps (you can run them by hand instead; replace `mandarin-coach` if you rename it):
```bash
railway whoami                                             # token works?
railway init --name mandarin-coach                         # add --workspace "<name or id>" if the account has several workspaces
railway add --service mandarin-coach                       # empty service
railway service scale --service mandarin-coach southeast-asia=1    # Singapore (before the volume)
railway volume add --mount-path /data --service mandarin-coach     # persistent disk; Hobby allows up to 5 GB
railway variable set NODE_ENV=production DATA_DIR=/data --skip-deploys --service mandarin-coach
printf %s "$APP_PASSCODE" | railway variable set APP_PASSCODE --stdin --skip-deploys --service mandarin-coach
printf %s "$TONEPERFECT_API_KEY" | railway variable set TONEPERFECT_API_KEY --stdin --skip-deploys --service mandarin-coach
printf %s "$OPENAI_API_KEY" | railway variable set OPENAI_API_KEY --stdin --skip-deploys --service mandarin-coach
railway up <clean copy of app/ without .env, data/> --path-as-root --ci --service mandarin-coach   # build + deploy, streams build log
railway domain --service mandarin-coach                    # https://<something>.up.railway.app
curl https://<something>.up.railway.app/api/health         # expect {"ok":true,...}
```
Then open `https://<domain>/audio-test.html` (and `/`) on the iPhone in Safari.

**Update later:** `./deploy-railway.sh --redeploy` (re-sets variables, uploads, deploys). A redeploy of a service with a volume has a short downtime (Railway does not run two deployments on one volume).

## Dashboard-only / fallback steps
Only these can need the dashboard (everything else is CLI):
1. **Account + Hobby plan + card** (Chris only).
2. **Creating the token** (Chris only).
3. If a CLI step fails: Region = service -> Settings -> Scale; Volume = right-click project canvas (or `Cmd+K`) -> Volume -> pick the service, mount path `/data`; Public URL = service -> Settings -> Networking -> Generate Domain; Healthcheck = service -> Settings -> Deploy -> Healthcheck Path `/api/health`.

## Caveat: `railway.json` is deprecated
Railway's docs (2026-10-27): "Config as Code (`railway.json`/`railway.toml`) is deprecated... New services cannot opt into Config as Code. Existing files stop being read on **2026-12-01**." So for a brand-new service Railway may ignore `railway.json`. That is harmless here: Railway **always builds with a root `Dockerfile` it finds**, the restart policy default already retries on failure, and the healthcheck is optional (set it in the dashboard if you want it, step 3 above). The replacement is Infrastructure as Code (`.railway/railway.ts`, `railway config plan/apply`); not used here to keep the first deploy simple.

## Native module check (`better-sqlite3`)
Backend uses `better-sqlite3` 11.10.0 (locked), a native module, not `node:sqlite`. On the box (Node 20.19.2, linux-x64 glibc), `npm ci --omit=dev` installs it and `require('better-sqlite3')` opens an in-memory DB (SQLite 3.49.2). GitHub release assets for `node-v115` (Node 20) exist for linux-x64 glibc and musl, so the `node:20-bookworm-slim` build downloads a prebuilt binary; the `python3 make g++` in the build stage is only the fallback. The real Docker/Railway build has **not** been run (no Docker here).

## Cost, honestly
Hobby is **US$5/month**, which includes US$5 of usage (CPU, RAM, volume, traffic); extra usage is billed on top. A single idle Node service plus a small volume will probably stay inside the included usage, but I have not measured it. Railway only takes cards for plans. (https://docs.railway.com/pricing/plans)

## Safety checklist
- `APP_PASSCODE` must be a real passcode: this is a public URL. The one currently in `server/.env` is very short; choose a longer one before deploying.
- Upload is made from a clean copy: no `.env`, `data/` or dev notes leave the box (the script does this; `.dockerignore` repeats it for the image).
- Delete the Railway token when finished (https://railway.com/account/tokens).
- Back up `coach.db` now and then: `railway volume files download /coach.db ./coach-backup.db` (needs the token again).

## Old alternatives (not the plan)
Fly.io (`fly.toml`, about US$4/mo, no free plan) and Render (`render.yaml`, about US$7.25/mo with a disk) were evaluated and dropped. Vercel/Netlify/GitHub Pages cannot run this app (needs a long-running server and a disk).

## Sources
- Tokens / CLI auth: https://docs.railway.com/cli/login , https://docs.railway.com/integrations/api , https://docs.railway.com/cli/deploying , https://station.railway.com/questions/railway-cli-rejects-newly-created-tokens-9f39cdae
- Regions: https://docs.railway.com/deployments/regions , https://docs.railway.com/platform/railway-metal , https://docs.railway.com/cli/service (`scale`)
- Volumes (root-owned mount, `RAILWAY_RUN_UID=0` alternative, one volume per service): https://docs.railway.com/volumes , https://docs.railway.com/volumes/reference ; CLI: https://docs.railway.com/cli/volume
- CLI commands: https://docs.railway.com/cli/init , https://docs.railway.com/cli/add , https://docs.railway.com/cli/variable , https://docs.railway.com/cli/domain
- Config as Code deprecation / IaC: https://docs.railway.com/config-as-code/reference , https://docs.railway.com/infrastructure-as-code
- Dockerfile detection and `VOLUME` ban: https://docs.railway.com/builds/dockerfiles , https://station.railway.com/questions/build-from-dockerfile-error-the-volume-8a90b885
- Plans: https://docs.railway.com/pricing/plans , https://docs.railway.com/pricing/faqs
