# Deploying the Mandarin coach on Render (plain-language guide)

**What you get:** one web address (https://mandarin-coach-xxxx.onrender.com) that works in iPhone Safari, with your practice history kept safely on a 1 GB disk.
**Cost (checked 2026-10-27):** Starter server **US$7/month** + 1 GB disk **US$0.25/month** (about **US$7.25/month**), and the Hobby workspace itself is $0. Render needs a **payment card** for any paid service (a US$1 card check is made and refunded). Prices: https://render.com/pricing. Disks need a paid plan: https://render.com/docs/disks

## Click by click (about 10 minutes; only you can do the account parts)

1. **Get the code onto GitHub.** You need a free GitHub account (github.com). Create a new **private** repository called `mandarin-coach`. Then either (a) tell me and I push the code once you have approved the connection, or (b) on the new repo page click **uploading an existing file** and drag in everything inside the `app` folder (not the folder itself) and click **Commit changes**. Option (b) is fine; the build copes with files GitHub's uploader drops.
2. Go to **https://render.com** and click **Get Started** / **Sign in**. Choose **GitHub** and allow Render to see your `mandarin-coach` repository.
3. Top right click **+ New** and choose **Blueprint**.
4. Pick the **mandarin-coach** repository, then **Connect**.
5. Render shows the plan it read from `render.yaml`: one web service `mandarin-coach` (Starter, Singapore) with a 1 GB disk. If it asks for a **payment card**, add it (Billing page opens). 
6. Fill in the boxes Render shows (these are the secrets; they are typed only here and never saved in the code):
   - **APP_PASSCODE**: the passcode you will use to log in to the coach.
   - **TONEPERFECT_API_KEY**: your TonePerfect key.
   - **OPENAI_API_KEY**: your OpenAI key.
   - **AZURE_SPEECH_KEY** and **AZURE_SPEECH_REGION**: leave empty unless you have them.
7. Click **Deploy Blueprint** (the button may say **Apply**). Wait 3 to 6 minutes. The service page shows **Live** with a green dot when it is done.
8. Click the address under the service name (ends in `.onrender.com`). Open it on your iPhone in **Safari** and log in. Send me the address.

Later changes: after you or I push new code to GitHub, Render rebuilds by itself (this takes a few minutes and the app is briefly unavailable). Change a secret later: Render dashboard > mandarin-coach > **Environment** > edit > **Save, rebuild, and deploy**.

## Why the settings in `render.yaml` are what they are
| Setting | Value | Reason |
|---|---|---|
| runtime | `docker` | Uses `Dockerfile`: pinned Node 20 plus build tools, so the SQLite add-on (better-sqlite3) installs the same way every time. |
| plan | `0.5c-512mb` (Starter) | Smallest paid plan; a persistent disk is **not** available on the free plan. |
| region | `singapore` | Closest to Perth. Cannot be changed later. |
| disk | 1 GB at `/data`, `DATA_DIR=/data` | The database file `coach.db` lives here and survives deploys. Can be enlarged later, never shrunk. Daily snapshots kept 7 days. |
| numInstances | 1 | A service with a disk **cannot be scaled to more than one instance** and has no zero-downtime deploys (a few seconds of downtime per deploy). |
| healthCheckPath | `/api/health` | Render only switches to a new version when this answers. |
| autoDeployTrigger | `commit` | Pushes go live without you clicking. For a one-person app the few seconds of downtime is fine. Set `off` in `render.yaml` if you would rather press **Manual Deploy** yourself. |
| PORT | not set | Render provides it (default 10000); the server reads `$PORT`. |
| secrets | `sync: false` | Render asks for them on screen at creation; they are never in the file. Note: Render asks **only the first time**; later edits are in the dashboard Environment tab. |

## Things to know
- The first load after a deploy is slow for a few seconds; Starter does not sleep.
- Free-plan services lose all files on every deploy; that is why we use the paid Starter plan with a disk.
- Backups: Render keeps disk snapshots for 7 days. For a copy on your Mac, ask me for an export.
- Do not "Add to Home Screen" yet (iOS asks for the microphone every launch).

## Troubleshooting
- Deploy fails: open the service > **Logs**, copy the last 30 lines to me.
- Page loads but login says wrong passcode: check **Environment** > `APP_PASSCODE`.
- Everything works but assessments fail: check `TONEPERFECT_API_KEY` and that you still have credits.

## Local run / other hosts
`cd app && npm install && npm start` (reads `.env`, see `.env.example`). The `Dockerfile` also runs on any Docker host (`docker build -t mandarin-coach . && docker run -p 8080:8080 -v coach-data:/data --env-file .env mandarin-coach`); a cheap VPS or Fly.io would work the same way (old Fly and Railway helper files are archived in `audio-deploy/archive-other-hosts/`).

## Sources
- Blueprint spec: https://render.com/docs/blueprint-spec (schema: https://render.com/schema/render.yaml.json)
- Disks: https://render.com/docs/disks
- Pricing: https://render.com/pricing
- Deploy a Blueprint: https://render.com/docs/infrastructure-as-code
