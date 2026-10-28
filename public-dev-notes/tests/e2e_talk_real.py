"""Integration: Free talk UI against the REAL Express app (:8093, mock assessment engine, fake OpenAI :8094 answering the real talk.js LLM prompts TALK_OPEN/REPLY/FIND/SUMMARY).
No fixture proxy. Checks /api/talk/opening|turn|summary shapes end to end, prefs 'free_talk', gate, llm-down error, Save word, nothing stored.
Start: bash ../dev-tools/start-test-stack.sh. Run: /workspace/venv/bin/python e2e_talk_real.py [http://localhost:8093]"""
import sys, os, json
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8093"
FAKE = "http://127.0.0.1:8094/__fake"
PASS = os.environ.get("PASSCODE", "devpass")
SHOTS = os.path.join(os.path.dirname(__file__), "..", "screenshots")
fails, checks = [], 0
def check(cond, msg):
    global checks
    checks += 1
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond: fails.append(msg)
def ts(p): return p.evaluate("__coach.T.state")
def wait_t(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.T.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False
def speak(p, then="ready"):
    assert wait_t(p, "ready", 20000), "never ready: " + ts(p)
    p.click("#btnTalkPrimary"); assert wait_t(p, "listening", 10000), "never listening"
    p.wait_for_timeout(1200); p.click("#btnTalkPrimary")
    return wait_t(p, then, 30000)
def nwords(p): return p.evaluate("fetch('/api/words').then(r => r.json()).then(j => (j.words || j || []).length)")

def run(viewport, tag, b):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    mobile = viewport["width"] < 600
    ctx = b.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if mobile else 1, has_touch=mobile, is_mobile=mobile)
    def fake(**kw): ctx.request.post(FAKE, data=kw)
    fake(llmFail=False, transcript="我周末去公园玩了，天气很好。", talkCorrect=True)
    p = ctx.new_page(); errors, talk_resp, uploads = [], [], []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("response", lambda r: talk_resp.append((r.url.split("/api/")[1].split("?")[0], r.status)) if "/api/talk/" in r.url or "/api/prefs" in r.url else None)
    p.on("request", lambda r: uploads.append(r.url) if r.method == "POST" and ("/api/attempt" in r.url or "/api/qa/" in r.url) else None)
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.evaluate("fetch('/api/words').then(r => r.json()).then(j => Promise.all((j.words || j || []).map(w => fetch('/api/words/' + w.id, { method: 'DELETE' }))))"); p.wait_for_timeout(300)
    R = ctx.request
    # ---- HTTP-level contract on the real routes
    anon = b.new_context().request
    check(anon.post(BASE + "/api/talk/opening", data={"topic": "x"}).status == 401, "talk routes need login (401 without cookie)")
    r = R.post(BASE + "/api/talk/opening?audio=1", data={"topic": "我的周末"}); j = r.json()
    check(r.status == 200 and j.get("ok") and j.get("textZh") and j.get("pinyin") and (j.get("textAudio") or {}).get("url"), f"real /api/talk/opening: {j.get('textZh')} | {j.get('pinyin')} | {(j.get('textAudio') or {}).get('url')}")
    r = R.post(BASE + "/api/talk/summary", data={"topic": "我的周末", "turns": [{"role": "user", "text": "我周末去公园玩了。"}]}); j = r.json()
    check(r.status == 200 and j.get("ok") and j.get("takeaways") and j.get("newWords") is not None and j.get("phrasesToTry") is not None, f"real /api/talk/summary keys: {sorted(j.keys())}")
    p.click('.tab[data-view="practice"]'); p.wait_for_timeout(500)
    if p.evaluate("document.body.dataset.view") == "talk": p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(300)
    n_pref = len(talk_resp)
    p.select_option("#practiceMode", "talk"); p.wait_for_timeout(600)
    check(any(u == "prefs" and s == 200 for u, s in talk_resp[n_pref:]), f"real server accepts practiceMode 'free_talk' (PUT /api/prefs 200): {talk_resp[n_pref:]}")
    check(R.get(BASE + "/api/prefs").json().get("practiceMode") == "free_talk", "server pref is free_talk")
    check(visible(p, "#view-talk") and p.input_value("#talkTopic") != "", f"topic default from the script: {p.input_value('#talkTopic')!r}")
    shot = lambda n: p.screenshot(path=os.path.join(SHOTS, f"{tag}-60-talk-real-{n}.png"))
    shot("01-intro")
    p.fill("#talkTopic", "我的周末")
    p.click("#btnTalkPrimary")
    check(wait_t(p, "ready", 25000), "Start -> real opening -> your turn: " + ts(p))
    first = p.evaluate("__coach.T.turns[0]")
    check(first and first["role"] == "coach" and "我的周末" in first["text"] and (first.get("audio") or [{}])[0].get("url"), f"opening text + audio from the real route: {first and first['text']}")
    check(bool(first.get("pinyin")), "opening carries real pinyin: " + str(first.get("pinyin"))[:60])
    # ---- turn 1 (with a correction from the finder)
    check(speak(p), "turn 1 completes against the real SSE: " + ts(p))
    turns = p.evaluate("__coach.T.turns")
    check([t["role"] for t in turns] == ["coach", "user", "coach"], "chat = opening, your turn, coach reply: " + str([t["role"] for t in turns]))
    u, c = turns[1], turns[2]
    check(u["text"] == "我周末去公园玩了，天气很好。" and "what I heard" in p.inner_text("#talkChat li.turn.user"), "your turn shows the real transcript, 'what I heard'")
    check("听起来很不错" in c["text"] and "你还做了什么" in c["text"], "coach reply text: " + c["text"])
    check(len(c.get("audio") or []) >= 2 and all(a.get("url") for a in c["audio"]), f"coach_audio per sentence: {len(c.get('audio') or [])}")
    check(bool(c.get("correction")) and c["correction"]["quote"] == "玩了" and c["correction"]["betterZh"] == "逛了", "real done.correction normalised: " + json.dumps(c.get("correction"), ensure_ascii=False))
    check(p.locator("#talkChat li.turn.coach .turn-tip:not([hidden])").count() == 1 and "not your pronunciation" in txt(p, "#talkChat li.turn.coach .turn-tip:not([hidden])"), "wording tip is about words, not pronunciation")
    check(bool(c.get("pinyin")) or "isn't available" in txt(p, "#talkChat"), "coach pinyin from the backend: " + repr(c.get("pinyin"))[:80])
    check(p.locator("#talkChat li.turn.user .hm").is_visible(), "'Hear my recording' on your turn")
    shot("02-turn1")
    # ---- gate: STT returns almost nothing
    fake(transcript="嗯")
    n_before = len(p.evaluate("__coach.T.turns"))
    speak(p)
    check(visible(p, "#talkError") and len(p.evaluate("__coach.T.turns")) == n_before, "gated turn -> friendly retry, not added to the conversation: " + txt(p, "#talkErrorText")[:100])
    shot("03-gate")
    p.click("#btnTalkErrRetry") if visible(p, "#btnTalkErrRetry") else None
    p.wait_for_timeout(300)
    # ---- llm down on the coach side
    fake(transcript="我和朋友一起吃了饺子。", llmFail=True)
    speak(p)
    check(visible(p, "#talkError") and ("coach" in txt(p, "#talkErrorText").lower() or "unavailable" in txt(p, "#talkErrorText").lower() or "try" in txt(p, "#talkErrorText").lower()), "llm down -> friendly error: " + txt(p, "#talkErrorText")[:120])
    check(visible(p, "#btnTalkErrSkip"), "Skip available")
    fake(llmFail=False)
    p.click("#btnTalkErrRetry"); check(wait_t(p, "ready", 30000) and not visible(p, "#talkError"), "Try again (new attemptId handled by the server) succeeds")
    shot("04-turn2")
    # ---- finish -> real summary
    w0 = nwords(p)
    p.click("#btnTalkFinish"); check(wait_t(p, "finished", 30000), "Finish -> summary")
    check(p.locator("#talkSummary .js-save-nw").count() >= 1 and len(txt(p, "#talkSummary")) > 80, "real summary rendered: takeaways / new words / phrases")
    check("Takeaways" in txt(p, "#talkSummary") and "New words" in txt(p, "#talkSummary") and "try" in txt(p, "#talkSummary").lower(), "summary sections present")
    check(nwords(p) == w0, "nothing auto-saved")
    shot("05-summary")
    p.click('.js-save-nw[data-i="0"]'); p.wait_for_timeout(700)
    check(nwords(p) == w0 + 1, "Save word saves just that word (real /api/words/missed)")
    check(not uploads, "Free talk never used /api/attempt or /api/qa")
    # ---- restore prefs
    p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(500)
    check(R.get(BASE + "/api/prefs").json().get("practiceMode") in ("listen_repeat", "fading_cues"), "server practiceMode restored")
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow")
    check(not errors, "no page errors: " + "; ".join(errors[:3]))
    fake(llmFail=False, transcript="")
    ctx.close()

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    run({"width": 390, "height": 844}, "mobile", b)
    run({"width": 1280, "height": 800}, "desktop", b)
    b.close()
print(f"\n{checks} checks, {len(fails)} failed")
sys.exit(1 if fails else 0)
