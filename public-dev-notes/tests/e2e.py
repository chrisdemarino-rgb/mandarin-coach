"""End-to-end test of the real frontend against the real Express server (mock engine + fake OpenAI), headless Chrome, fake mic.
Run: PORT=8093 ... node server/index.js (see README in public-dev-notes) then: /workspace/venv/bin/python e2e.py [BASE_URL]
Writes screenshots to ../screenshots/. Exits non-zero on any failed check."""
import sys, json, re, time, os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8093"
PASS = os.environ.get("PASSCODE", "devpass")
SHOTS = os.path.join(os.path.dirname(__file__), "..", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
fails, checks = [], 0

def check(cond, msg):
    global checks
    checks += 1
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: fails.append(msg)

def state(p): return p.evaluate("document.body.dataset.state")
def wait_state(p, st, timeout=20000):
    try: p.wait_for_function("s => document.body.dataset.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def wait_in(p, sts, timeout=20000):
    try: p.wait_for_function("l => l.includes(document.body.dataset.state)", arg=sts, timeout=timeout); return True
    except Exception: return False
def shot(p, name): p.screenshot(path=os.path.join(SHOTS, name + ".png"))

def record_one(p, speak_ms=1400):
    """Primary tap -> wait for listening -> speak -> Done."""
    assert wait_state(p, "listening", 25000), "never reached listening, state=" + state(p)
    p.wait_for_timeout(speak_ms)
    p.click("#btnPrimary")

def login(p):
    p.goto(BASE)
    p.wait_for_selector("#view-login", state="visible", timeout=8000)

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1,
                              has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("401", "429", "503")) and not ("ERR_FILE_NOT_FOUND" in m.text and str(m.location.get("url")).startswith("blob:")) else None)  # 401/429/503 are injected on purpose; blob ERR_FILE_NOT_FOUND = the shared <audio> re-touching its revoked hear-my-recording URL (Audio's hear-mine.js; harmless, reported)
    attempts = []
    p.on("request", lambda r: attempts.append(r) if r.url.endswith("/api/attempt") else None)

    # ---- login
    login(p)
    check(p.is_visible("#view-login"), "login view shown when signed out")
    shot(p, f"{tag}-01-login")
    if tag == "mobile":  # one wrong attempt only: the server locks out after 5 (that is tested with a stubbed 429 below)
        p.fill("#passcode", "wrong"); p.click("#btnLogin")
        p.wait_for_selector("#loginError:not([hidden])", timeout=5000)
        check("isn't right" in p.inner_text("#loginError"), "wrong passcode message")
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    check(not p.is_visible("#view-login"), "signed in, login hidden")
    cookies = [c for c in ctx.cookies() if c["name"] == "coach_session"]
    check(len(cookies) == 1 and cookies[0]["httpOnly"], "httpOnly coach_session cookie (no bearer token in JS)")
    p.wait_for_function("document.querySelector('#mockBanner').hidden === false", timeout=5000)
    check(True, "MOCK banner visible (engine is mock)")

    # ---- script
    p.click('.tab[data-view="script"]')
    p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    n_sent = p.evaluate("document.querySelectorAll('#chunkList .chunk-item').length")
    check(p.evaluate("parseInt(document.querySelector('#charCount').textContent.replace(/,/g,''))") >= 1000, f"sample >= 1000 chars ({p.inner_text('#charCount')})")
    check(p.evaluate("__coach.S.chunks.every(c => c.pieces.every(x => x.spoken.length <= 100))"), "every piece <= 100 chars")
    check(not re.search(r"[\[\]【】]", p.evaluate("__coach.S.chunks.map(c=>c.pieces.map(x=>x.spoken).join('')).join('')")), "no stage directions in spoken text")
    p.select_option("#chunkModeScript", "four")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length < " + str(n_sent), timeout=3000)
    check(True, "chunk mode 4 sentences -> fewer chunks")
    p.select_option("#chunkModeScript", "sentence")
    shot(p, f"{tag}-02-script")

    # ---- listen & repeat
    p.click('.tab[data-view="practice"]')
    p.select_option("#practiceMode", "listen_repeat")
    p.click("#btnPrimary")
    check(wait_in(p, ["prompting", "listening"], 8000), "Start -> prompting/listening")
    shot(p, f"{tag}-03-prompting")
    record_one(p)
    check(wait_in(p, ["processing", "result"], 8000), "Done -> processing")
    shot(p, f"{tag}-04-processing") if state(p) == "processing" else None
    check(wait_state(p, "result", 25000), "assessment arrives -> result")
    check(len(attempts) >= 1, "POST /api/attempt sent")
    p.wait_for_timeout(1500)
    shot(p, f"{tag}-05-result")
    ok_marks = p.evaluate("({review: document.querySelectorAll('.rch.review').length, unsure: document.querySelectorAll('.rch.unsure').length, chars: document.querySelectorAll('.rch[data-han=\"1\"]').length})")
    check(ok_marks["chars"] > 0, f"result chars rendered ({ok_marks})")
    check(p.evaluate("__coach.S.assessment.confirmed.length") == ok_marks["review"], "only server-confirmed tone errors are marked as errors")
    check("MOCK" in p.inner_text("#engineTag"), "engine tag says MOCK")
    # coach text streamed
    p.wait_for_function("document.querySelector('#feedbackBody').innerText.length > 5", timeout=15000)
    check(True, "written feedback streamed in")
    check(p.evaluate("__coach.S.coachAudio.filter(Boolean).length") >= 1, "coach_audio events received")
    # save a word
    p.click('.rch[data-han="1"] >> nth=0')
    p.click("#btnSaveSel")
    p.wait_for_timeout(600)
    p.click('.tab[data-view="saved"]')
    p.wait_for_function("document.querySelectorAll('#savedList .saved-item').length >= 1", timeout=5000)
    check(True, "word saved via /api/words and listed")
    shot(p, f"{tag}-06-saved")
    p.click('.tab[data-view="practice"]')
    # "Hear my recording" (replaced the old #btnPlayback; in-memory take, see tests/hear-mine.mjs)
    check(p.locator("#btnHearMine").is_visible(), "Hear my recording button shown in the close result")
    p.click("#btnHearMine"); p.wait_for_timeout(300)
    try: p.wait_for_function("!/Stop/.test(document.querySelector('#btnHearMine').textContent)", timeout=10000)   # let the take play to its end (stopping mid-load logs a resource error)
    except Exception: pass
    wait_state(p, "result", 8000)
    # retry & skip
    p.click("#btnRetry")
    check(wait_in(p, ["prompting", "listening"], 8000), "Retry -> prompting")
    # mid-session chunk mode switch
    p.select_option("#chunkModePractice", "paragraph")
    p.wait_for_timeout(500)
    check(p.evaluate("__coach.S.settings.chunkMode") == "paragraph" and p.evaluate("__coach.S.state") in ("prompting", "listening"), "chunk mode switched mid-session, session continues")
    shot(p, f"{tag}-07-paragraph-mode")
    pieces = p.evaluate("Math.max(...__coach.S.chunks.map(c => c.pieces.length))")
    check(pieces >= 2, f"paragraph mode: longest chunk is practised in {pieces} pieces (<=100 chars each)")
    p.evaluate("__coach.S.jumpTo(__coach.S.chunks.findIndex(c => c.pieces.length > 1))")
    p.wait_for_function("document.querySelector('#pieceLabel').textContent.startsWith('Part 1 of')", timeout=5000)
    check(True, "multi-piece chunk shows 'Part 1 of N'")
    shot(p, f"{tag}-07b-paragraph-pieces")
    p.select_option("#chunkModePractice", "sentence")
    p.wait_for_timeout(400)
    # pause / resume
    wait_in(p, ["listening"], 15000)
    p.click("#btnPause")
    check(wait_state(p, "paused", 4000), "Pause -> paused")
    check(p.evaluate("__coach.S.micArmed") is False, "mic released on Pause")
    shot(p, f"{tag}-08-paused")
    p.click("#btnPause")
    check(wait_in(p, ["prompting", "listening"], 8000), "Resume -> session continues")
    # interrupted (phone lock / call)
    wait_state(p, "listening", 15000)
    p.evaluate("__coach.S.interrupt()")
    check(wait_state(p, "paused", 3000) and "interrupted" in (p.inner_text("#errorText") + " " + p.inner_text("#pausedHint")), "interruption pauses with a clear message (auto-resume hint since 97d9056)")
    shot(p, f"{tag}-09-interrupted")
    p.click("#btnPause")
    wait_in(p, ["prompting", "listening"], 8000)

    # ---- fading cues
    p.select_option("#practiceMode", "fading_cues")
    check(p.evaluate("__coach.S.practiceMode") == "fading_cues", "fading mode on")
    for lvl in (1, 2, 3, 4):
        p.evaluate(f"__coach.S.fade = {lvl}; __coach.S.retry()")
        wait_state(p, "listening", 20000)
        p.wait_for_timeout(300)
        txt = p.inner_text("#cueText").strip()
        check(p.evaluate("__coach.S.fade") == lvl and len(txt) > 0, f"fading level {lvl} cue shown: {txt[:40]!r}")
        shot(p, f"{tag}-10-fading-level{lvl}")
    # level 4: peek shows the full text
    before = p.inner_text("#cueText")
    p.click("#btnPeek")
    check(p.inner_text("#cueText") != before and "memory" not in p.inner_text("#cueText"), "Peek reveals full text")
    p.click("#btnPeek")
    # one real fading attempt + result action
    record_one(p, 1200)
    wait_state(p, "result", 25000)
    act = p.inner_text("#btnPrimary")
    check(bool(act), f"fading result primary action: {act!r}")
    shot(p, f"{tag}-11-fading-result")
    p.click("#btnPrimary")
    check(wait_in(p, ["prompting", "listening"], 10000), "result action continues the ladder")

    # ---- finish + summary
    p.click("#btnFinish")
    check(wait_state(p, "finished", 5000), "Finish -> finished")
    check(p.is_visible("#summaryPanel"), "summary shown")
    check(p.evaluate("__coach.S.micArmed") is False, "mic released on Finish")
    shot(p, f"{tag}-12-summary")

    # ---- settings
    p.click('.tab[data-view="settings"]')
    p.click("#btnTestConn"); p.wait_for_function("document.querySelector('#connResult').textContent.includes('Server OK')", timeout=5000)
    check("MOCK" in p.inner_text("#connResult"), "settings: server check reports engine mock")
    shot(p, f"{tag}-13-settings")
    prefs = p.evaluate("fetch('/api/prefs').then(r=>r.json())")
    check(prefs.get("chunkMode") == "sentence" or "chunkMode" in prefs, f"prefs persisted on server: {json.dumps(prefs)[:100]}")

    # ---- error UI (route interception of /api/attempt)
    p.click('.tab[data-view="practice"]')
    p.select_option("#practiceMode", "listen_repeat")
    def sse_error(code, retry, skip):
        body = 'event: status\ndata: {"stage":"uploading"}\n\nevent: error\ndata: ' + json.dumps({"code": code, "message": "No assessment obtained: " + code, "retryable": retry, "canSkip": skip, "stage": "assessment", "engine": "mock", "mock": True}) + "\n\n"
        return lambda route: route.fulfill(status=200, headers={"Content-Type": "text/event-stream"}, body=body)
    p.route("**/api/attempt", sse_error("no_speech", True, True))
    p.click("#btnPrimary")
    record_one(p, 1200)
    p.wait_for_selector("#errorPanel:not([hidden])", timeout=15000)
    check("no_speech" in p.inner_text("#errorText") and p.is_visible("#btnErrSkip") and "Record again" in p.inner_text("#btnErrRetry"), "terminal error event -> message + Record again + Skip, no assessment shown")
    check(not p.is_visible("#resultPanel"), "no result panel when no assessment")
    shot(p, f"{tag}-14-error-no-speech")
    p.unroute("**/api/attempt")
    # network failure then re-upload with SAME attemptId
    ids = []
    def flaky(route):
        req = route.request
        m = re.search(rb'name="attemptId"\r\n\r\n([^\r]+)', req.post_data_buffer or b"")
        ids.append(m.group(1).decode() if m else None)
        if len(ids) == 1: route.fulfill(status=503, headers={"Content-Type": "application/json"}, body=json.dumps({"ok": False, "error": {"code": "unavailable", "message": "Service unavailable."}}))
        else: route.continue_()
    p.click("#btnErrSkip"); wait_in(p, ["prompting", "listening"], 10000)
    p.route("**/api/attempt", flaky)
    record_one(p, 1200)
    p.wait_for_selector("#errorPanel:not([hidden])", timeout=15000)
    check("re-send" in p.inner_text("#btnErrRetry"), "upload failure offers re-send of the same take")
    shot(p, f"{tag}-15-error-upload")
    p.click("#btnErrRetry")
    check(wait_state(p, "result", 25000), "re-send succeeds -> result")
    check(len(ids) == 2 and ids[0] and ids[0] == ids[1], f"retry re-posts the SAME attemptId ({ids})")
    p.unroute("**/api/attempt")
    # session expiry
    p.route("**/api/attempt", lambda r: r.fulfill(status=401, headers={"Content-Type": "application/json"}, body='{"ok":false,"error":{"code":"unauthorized","message":"Sign in."}}'))
    p.click("#btnRetry"); record_one(p, 1200)
    p.wait_for_function("document.body.dataset.auth === 'out'", timeout=10000)
    check(p.is_visible("#view-login"), "401 -> login view")
    shot(p, f"{tag}-16-session-expired")
    p.unroute("**/api/attempt")
    # lockout
    p.route("**/api/login", lambda r: r.fulfill(status=429, headers={"Content-Type": "application/json", "Retry-After": "30"}, body='{"ok":false,"error":{"code":"login_locked","message":"locked","retryAfterSec":30}}'))
    p.fill("#passcode", "x"); p.click("#btnLogin")
    p.wait_for_function("document.querySelector('#loginError').textContent.includes('Try again in')", timeout=4000)
    check("Try again in" in p.inner_text("#loginError"), "login lockout shows countdown")
    shot(p, f"{tag}-17-lockout")
    p.unroute("**/api/login")

    # layout sanity
    sw = p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
    check(sw, "no horizontal overflow")
    check(not errors, "no console/page errors: " + "; ".join(errors[:3]))
    ctx.close()

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True,
        args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    for vp, tag in (({"width": 390, "height": 844}, "mobile"), ({"width": 1280, "height": 800}, "desktop")):
        try: run(vp, tag, browser)
        except Exception as e:
            print("  FAIL exception:", repr(e)[:300]); fails.append(str(e)[:200])
    browser.close()
print(f"\n{checks} checks, {len(fails)} failed")
sys.exit(1 if fails else 0)
