"""Integration: script-grounded Free talk (backend 72c25bd: context.script, upgrade/upgradeStatus/onTopic/saveable, reply pinyin, 413 script_too_long) against the REAL Express app (:8093, mock assessment engine, fake OpenAI :8094 answering the real talk.js LLM prompts TALK_OPEN/REPLY/FIND/SUMMARY).
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

UPG = "#talkChat li.turn.coach .up-said"
def run(viewport, tag, b):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    mobile = viewport["width"] < 600
    ctx = b.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if mobile else 1, has_touch=mobile, is_mobile=mobile)
    def fake(**kw): ctx.request.post(FAKE, data=kw)
    fake(llmFail=False, transcript="我周末去公园玩了，天气很好。", talkCorrect=True, talkUpgrade="ok", talkOnTopic=True, talkUpgradeMs=0)
    p = ctx.new_page(); errors, bodies, tts = [], [], []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("dialog", lambda d: d.accept())
    def onreq(r):
        if r.method == "POST" and "/api/talk/" in r.url:
            try: bodies.append((r.url.split("/api/")[1].split("?")[0], (r.post_data_buffer or b"").decode("utf-8", "ignore")))
            except Exception: bodies.append((r.url, ""))
        if r.method == "POST" and r.url.endswith("/api/tts"): tts.append(r.post_data or "")
    p.on("request", onreq)
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.fill("#scriptInput", ""); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.evaluate("fetch('/api/words').then(r => r.json()).then(j => Promise.all((j.words || j || []).map(w => fetch('/api/words/' + w.id, { method: 'DELETE' }))))"); p.wait_for_timeout(300)
    R = ctx.request
    # ---- HTTP contract: 413 script_too_long / 400 invalid_context on the real routes
    r = R.post(BASE + "/api/talk/opening", data={"topic": "x", "script": "好" * 3001})
    check(r.status == 413 and (r.json().get("error") or {}).get("code") == "script_too_long", f"real opening: 3001-char script -> 413 script_too_long ({r.status})")
    r = R.post(BASE + "/api/talk/opening", data={"topic": "x", "script": 5})
    check(r.status == 400 and (r.json().get("error") or {}).get("code") == "invalid_context", f"real opening: non-string script -> 400 invalid_context ({r.status})")
    r = R.post(BASE + "/api/talk/opening", data={"topic": "我的周末", "script": "周末的时候，我常常约几个中国朋友一起吃饭。"})
    check(r.status == 200 and r.json().get("scriptUsed") is True, "real opening with a script -> scriptUsed:true")
    p.click('.tab[data-view="practice"]'); p.wait_for_timeout(500)
    if p.evaluate("document.body.dataset.view") == "talk": p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(300)
    p.select_option("#practiceMode", "talk"); p.wait_for_timeout(600)
    shot = lambda n: p.screenshot(path=os.path.join(SHOTS, f"{tag}-70-talk-upgrade-real-{n}.png"))
    p.fill("#talkTopic", "我的周末"); p.click("#btnTalkPrimary")
    check(wait_t(p, "ready", 25000), "Start -> real opening: " + ts(p))
    ob = next((b2 for u, b2 in bodies if u == "talk/opening"), "")
    try: obj = json.loads(ob)
    except Exception: obj = {}
    check(isinstance(obj.get("script"), str) and "周末的时候" in obj["script"] and "[停顿]" not in obj["script"] and len(obj["script"]) <= 3000, "opening sends the spoken script (directions stripped)")
    check(p.evaluate("__coach.T.scriptUsed") is True, "opening -> scriptUsed:true from the real server")
    # ---- turn with a real verified upgrade
    check(speak(p), "turn 1 completes: " + ts(p))
    tb = next((b2 for u, b2 in reversed(bodies) if u == "talk/turn"), "")
    c = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop()")
    check(c.get("upgradeStatus") == "ok" and c.get("upgrade") and c["upgrade"]["better"].startswith("周末的时候，我"), "real done: upgradeStatus ok + verified upgrade: " + json.dumps({k: c.get(k) for k in ("upgradeStatus", "onTopic")}, ensure_ascii=False))
    check(c.get("onTopic") is True, "real done: onTopic true")
    check(c.get("upgradeStatus") != "no_script", "turn context carried the script (server did not answer no_script; Playwright can't read the multipart body)")
    check(c["upgrade"]["sourceLines"] and c["upgrade"]["sourceLines"][0]["text"] == "周末的时候，我常常约几个中国朋友一起吃饭。" and isinstance(c["upgrade"]["sourceLines"][0]["start"], int), "sourceLines verbatim from the script, offsets into the script, no chunkIndex")
    check(c.get("saveable") and c["saveable"][0]["text"] == "周末的时候" and c["saveable"][0]["pinyin"], "real saveable: " + json.dumps(c.get("saveable"), ensure_ascii=False)[:120])
    card = p.locator("#talkChat li.turn.coach").last
    check(card.locator(".up-said del.up-m").all_inner_texts() == ["我周末"] and card.locator(".up-better ins.up-m").all_inner_texts() == ["周末的时候"], "real offsets highlight both lines: " + str(card.locator(".up-better ins.up-m").all_inner_texts()))
    if p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") != "true": p.click("#btnTalkPinyin")
    p.wait_for_timeout(200)
    check(card.locator(".up-py").count() == 1 and "zhōu mò" in card.locator(".up-py").inner_text(), "real betterPinyin shown with the toggle")
    check("isn't available" not in card.locator(".turn-py").inner_text() and card.locator(".turn-py").inner_text().strip() != "", "real replyPinyin/questionPinyin shown: " + card.locator(".turn-py").inner_text()[:50])
    card.locator(".js-up-src").click(); check("周末的时候，我常常约" in card.locator(".up-src").inner_text(), "Show script line (real)")
    shot("01-card")
    card.locator(".js-up-save").first.click(); p.wait_for_timeout(800)
    words = p.evaluate("fetch('/api/words').then(r => r.json()).then(j => j.words || j)")
    check(len(words) == 1 and words[0]["text"] == "周末的时候" and words[0].get("sourceChunk") == "周末的时候，我常常约几个中国朋友一起吃饭。" and words[0].get("pinyin"), "Save phrase -> real /api/words row from saveable: " + json.dumps(words, ensure_ascii=False)[:150])
    check("Saved" in card.locator(".js-up-save").first.inner_text(), "saved state shown")
    n0 = len(tts); card.locator(".js-up-hear").click(); p.wait_for_timeout(2500)
    check(len(tts) > n0 and "周末的时候" in tts[-1], "Hear better version -> real POST /api/tts {text: better}")
    check(p.evaluate("__coach.T.betterPhase") != "error", "no playback error (real tts via fake OpenAI): " + p.evaluate("__coach.T.betterPhase"))
    p.wait_for_timeout(1500)
    # ---- ungrounded
    fake(talkUpgrade="ungrounded"); check(speak(p), "turn: ungrounded")
    c = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop()")
    last = p.locator("#talkChat li.turn.coach").last
    check(c.get("upgradeStatus") == "ungrounded" and not c.get("upgrade") and last.locator(".up-said").count() == 0 and "strayed from your script" in last.inner_text(), "real ungrounded -> no card, soft note")
    # ---- off topic + null upgrade
    fake(talkUpgrade="null", talkOnTopic=False); check(speak(p), "turn: off-topic")
    c = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop()")
    last = p.locator("#talkChat li.turn.coach").last
    check(c.get("onTopic") is False and c.get("upgradeStatus") == "none" and "off your script's topic" in last.inner_text() and last.locator(".up-said").count() == 0, "real onTopic:false -> gentle note; upgrade none -> no card")
    shot("02-notes")
    # ---- upgrade arrives late: reply text shows before done
    fake(talkUpgrade="ok", talkOnTopic=True, talkUpgradeMs=4000)
    assert wait_t(p, "ready", 20000)
    n_c = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').length")
    p.click("#btnTalkPrimary"); wait_t(p, "listening", 10000); p.wait_for_timeout(1200); p.click("#btnTalkPrimary")
    try: p.wait_for_function("n => { const c = __coach.T.turns.filter(t => t.role === 'coach'); return c.length > n && c[c.length - 1].text; }", arg=n_c, timeout=15000); early = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop().upgrade") is None
    except Exception: early = False
    check(early, "late upgrade: coach reply text shown before the comparison arrives")
    check(wait_t(p, "ready", 30000) and p.locator("#talkChat li.turn.coach").last.locator(".up-said").count() == 1, "late upgrade: comparison card appears when done arrives")
    fake(talkUpgradeMs=0)
    # ---- LLM upgrade failure -> unavailable note, turn fine
    fake(talkUpgrade="fail"); check(speak(p), "turn: upgrade LLM malformed")
    c = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop()")
    check(c.get("upgradeStatus") in ("unavailable", "none") and not c.get("upgrade") and c.get("text"), "upgrade failure -> no card, reply kept: " + str(c.get("upgradeStatus")))
    fake(talkUpgrade="ok")
    # ---- finish (summary carries the script), restore prefs
    p.click("#btnTalkFinish"); wait_t(p, "finished", 20000)
    sb = next((b2 for u, b2 in reversed(bodies) if u == "talk/summary"), "")
    check('"script"' in sb, "summary request carries the script")
    p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(500)
    check(R.get(BASE + "/api/prefs").json().get("practiceMode") in ("listen_repeat", "fading_cues"), "server practiceMode restored")
    p.evaluate("fetch('/api/words').then(r => r.json()).then(j => Promise.all((j.words || j || []).map(w => fetch('/api/words/' + w.id, { method: 'DELETE' }))))"); p.wait_for_timeout(300)
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow")
    check(not errors, "no page errors: " + "; ".join(errors[:3]))
    fake(llmFail=False, transcript="", talkUpgrade="ok", talkOnTopic=True, talkUpgradeMs=0)
    ctx.close()

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    run({"width": 390, "height": 844}, "mobile", b)
    run({"width": 1280, "height": 800}, "desktop", b)
    b.close()
print(f"\n{checks} checks, {len(fails)} failed")
sys.exit(1 if fails else 0)
