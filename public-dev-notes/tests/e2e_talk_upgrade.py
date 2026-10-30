"""E2E (fixture :8095) for the Free talk upgrade card (What you said / Could have said), reply pinyin and the 3000-character script limit. Screenshots *-70-talk-upgrade-*."""
import sys, os, json
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8095"
PASS = os.environ.get("PASSCODE", "devpass")
SHOTS = os.path.join(os.path.dirname(__file__), "..", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
fails, checks = [], 0

def check(cond, msg):
    global checks
    checks += 1
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: fails.append(msg)

def ts(p): return p.evaluate("__coach.T.state")
def wait_t(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.T.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def shot(p, tag, name): p.screenshot(path=os.path.join(SHOTS, f"{tag}-70-talk-{name}.png"))
def fx(ctx, **kw): ctx.request.post(BASE + "/__fixture/mode", data=kw)
def last(ctx): return ctx.request.get(BASE + "/__fixture/last").json()
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False
def nwords(p): return p.evaluate("fetch('/api/words').then(r => r.json()).then(j => (j.words || j || []).length)")

def speak_turn(p, then="ready"):
    """ready -> Record -> talk -> Done -> wait for `then` (default ready, i.e. the reply is in)."""
    assert wait_t(p, "ready", 20000), "never ready: " + ts(p)
    p.click("#btnTalkPrimary")
    assert wait_t(p, "listening", 10000), "never listening: " + ts(p)
    p.wait_for_timeout(1200)
    p.click("#btnTalkPrimary")
    p.wait_for_function("__coach.T.state !== 'listening'", timeout=5000)
    return wait_t(p, then, 25000)

UPG = ".turn.coach .turn-up:not([hidden])"
def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    mobile = viewport["width"] < 600
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if mobile else 1, has_touch=mobile, is_mobile=mobile)
    p = ctx.new_page(); errors, tts = [], []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e))); p.on("dialog", lambda d: d.accept())
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401", "400", "500", "502", "@blob:")) else None)
    p.on("request", lambda r: tts.append(r.post_data or "") if "/api/tts" in r.url and r.method == "POST" else None)
    fx(ctx, reset=True, talk="ok", talkUnsupported=False, talkOpening="ok", talkSummary="ok", talkTranscript="我周末去公园玩了，天气很好。", talkSlow=0, talkUpgrade="offsets", talkPinyin=True)
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.evaluate("fetch('/api/words').then(r => r.json()).then(j => Promise.all((j.words || j || []).map(w => fetch('/api/words/' + w.id, { method: 'DELETE' }))))")
    p.wait_for_timeout(600)
    if p.evaluate("document.body.dataset.view") == "talk": p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(300)

    # ---- 1. 3000-character script limit
    p.click('.tab[data-view="script"]')
    p.fill("#scriptInput", "我" * 999); p.wait_for_timeout(300)
    check("999 / 3,000 characters" in txt(p, "#charCount") and visible(p, "#charWarn") and not visible(p, "#charOver"), "999 chars: counter /3,000 + the existing under-1000 hint")
    p.fill("#scriptInput", "我" * 3000); p.wait_for_timeout(300)
    check("3,000 / 3,000" in txt(p, "#charCount") and not visible(p, "#charWarn") and not visible(p, "#charOver"), "exactly 3000: fine")
    p.fill("#scriptInput", "我" * 3012); p.wait_for_timeout(300)
    check(visible(p, "#charOver") and "by 12" in txt(p, "#charOver") and "3,000" in txt(p, "#charOver"), "over the limit: clear message: " + txt(p, "#charOver"))
    check(p.evaluate("document.querySelector('#scriptInput').value.length") == 3012, "nothing is silently cut off")
    shot(p, tag, "upgrade-01-limit")
    p.click("#btnSample"); p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    check(not visible(p, "#charOver") and "/ 3,000 characters" in txt(p, "#charCount"), "sample script under the limit: " + txt(p, "#charCount"))

    # ---- 2. Free talk turn with an upgrade + reply pinyin
    p.click('.tab[data-view="practice"]'); p.select_option("#practiceMode", "talk"); p.wait_for_timeout(300)
    p.click("#btnTalkPrimary"); check(wait_t(p, "ready", 15000), "started")
    if p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") != "true": p.click("#btnTalkPinyin")
    check(speak_turn(p), "turn with an upgrade")
    card = p.locator(UPG)
    check(card.count() == 1, "comparison card shown under the coach reply")
    ct = card.inner_text()
    check("What you said" in ct and "Could have said" in ct and "我周末去公园玩了，天气很好。" in ct.replace("\n", "") and "我周末去公园逛了逛，天气特别好。" in ct.replace("\n", ""), "both lines shown")
    dels = card.locator(".up-said del.up-m").all_inner_texts(); ins = card.locator(".up-better ins.up-m").all_inner_texts()
    check(dels == ["玩了", "很好"] and ins == ["逛了逛", "特别好"], f"changed phrases highlighted in both lines: {dels} / {ins}")
    deco = p.evaluate("getComputedStyle(document.querySelector('.turn-up .up-said del.up-m')).textDecorationLine")
    bold = p.evaluate("getComputedStyle(document.querySelector('.turn-up .up-better ins.up-m')).fontWeight")
    check("line-through" in deco and "underline" in deco and int(bold) >= 700, f"non-colour markers: strike+underline ({deco}), bold underline ({bold})")
    check("wǒ zhōu mò" in ct, "pinyin on 'Could have said' when the toggle is on")
    check("not your pronunciation" in ct, "card is about words, not pronunciation")
    coach = p.evaluate("__coach.T.turns.filter(t => t.role === 'coach').pop()")
    check("tīng qǐ lái" in (coach.get("pinyin") or "") and "nǐ zài gōng yuán" in coach["pinyin"], "reply pinyin from replyPinyin + questionPinyin")
    lastpy = p.locator("#talkChat li.turn.coach .turn-py").last
    check(lastpy.is_visible() and "tīng qǐ lái" in lastpy.inner_text() and "isn't available" not in lastpy.inner_text(), "pinyin toggle shows the real reply pinyin (no 'not available')")
    # show script line
    check(card.locator(".up-src").count() == 0, "script line hidden until tapped")
    card.locator(".js-up-src").click()
    check(card.locator(".up-src").is_visible() and "周末的时候" in card.locator(".up-src").inner_text() and "Hide script line" in card.locator(".js-up-src").inner_text(), "Show script line reveals the source line")
    shot(p, tag, "upgrade-02-card")
    card.locator(".js-up-src").click(); check(card.locator(".up-src").count() == 0, "Hide script line")
    # toggle pinyin off -> no better pinyin
    p.click("#btnTalkPinyin"); check("wǒ zhōu mò" not in card.inner_text(), "pinyin off hides the better-version pinyin"); p.click("#btnTalkPinyin")
    # save phrase (manual only)
    w0 = nwords(p)
    saves = card.locator(".js-up-save")
    check(saves.count() == 2 and "逛了逛" in saves.nth(0).inner_text(), "one Save phrase per changed phrase: " + str(saves.all_inner_texts()))
    check(w0 == 0, "nothing saved automatically")
    saves.nth(0).click(); p.wait_for_timeout(800)
    words = p.evaluate("fetch('/api/words').then(r => r.json()).then(j => j.words || j)")
    check(len(words) == 1 and words[0]["text"] == "逛了逛" and words[0].get("sourceChunk") == "周末的时候，我常常约几个中国朋友一起吃饭。" and words[0].get("pinyin") == "guàng le guàng", "Save phrase posts done.saveable as-is (text, pinyin, sourceChunk = script line): " + json.dumps(words, ensure_ascii=False)[:160])
    lc = last(ctx).get("talkContext") or {}
    check(isinstance(lc.get("script"), str) and 900 < len(lc["script"]) <= 3000 and "[停顿]" not in lc["script"] and "[强调]" not in lc["script"], "turn context.script = the full spoken script (stage directions stripped)")
    check("script" in (last(ctx).get("talkOpeningBody") or {}), "opening body carries the script")
    check("Saved" in card.locator(".js-up-save").nth(0).inner_text() and card.locator(".js-up-save").nth(0).is_disabled() and card.locator(".js-up-save").nth(1).is_enabled(), "saved state confirmed, other phrase still saveable")
    # hear better version
    n0 = len(tts)
    card.locator(".js-up-hear").click()
    try: p.wait_for_function("['playing','idle'].includes(__coach.T.betterPhase) && __coach.T.betterTurnId", timeout=10000); ok = True
    except Exception: ok = False
    check(ok and len(tts) > n0 and "逛了逛" in "".join(tts[n0:]), "Hear better version -> POST /api/tts {text: better}: " + "".join(tts[n0:])[:80])
    check(p.evaluate("__coach.T.betterPhase") != "error", "no playback error: " + p.evaluate("__coach.T.betterPhase") + " " + txt(p, "#talkNotice"))
    p.wait_for_timeout(1500)
    # never while recording
    p.click("#btnTalkPrimary"); wait_t(p, "listening", 10000)
    check(card.locator(".js-up-hear").is_disabled(), "Hear better version disabled while recording")
    p.evaluate("__coach.T.hearBetter(__coach.T.turns.filter(t => t.role === 'coach').pop().id)")
    check(ts(p) == "listening" and p.evaluate("__coach.T.betterPhase") != "loading", "hearBetter is a no-op while recording")
    p.click("#btnTalkPrimary"); wait_t(p, "ready", 25000)
    shot(p, tag, "upgrade-03-after")

    # ---- 3. offsets absent (substring search), string sourceLines, no pinyin from backend
    fx(ctx, talkUpgrade="strings", talkPinyin=False)
    n_prev = p.locator(UPG).count()
    check(speak_turn(p), "turn: upgrade without offsets")
    p.wait_for_function("n => document.querySelectorAll('%s').length > n" % UPG.replace("'", "\\'"), arg=n_prev, timeout=10000)
    card = p.locator(UPG).last
    check(card.locator(".up-said del.up-m").all_inner_texts() == ["玩了", "很好"] and card.locator(".up-better ins.up-m").all_inner_texts() == ["逛了逛", "特别好"], "offsets absent -> substring search highlights")
    card.locator(".js-up-src").click(); check("周末的时候" in card.locator(".up-src").inner_text(), "string sourceLines shown")
    check("isn't available" in p.locator("#talkChat li.turn.coach .turn-py").last.inner_text(), "no reply pinyin -> fallback message kept")
    fx(ctx, talkUpgrade="badoffsets")
    check(speak_turn(p), "turn: wrong offsets")
    check(p.locator(UPG).last.locator(".up-said del.up-m").all_inner_texts() == ["玩了", "很好"], "wrong offsets ignored, text found by search")
    fx(ctx, talkUpgrade="garbage")
    n_cards = p.locator(UPG).count()
    check(speak_turn(p) and p.locator(UPG).count() == n_cards, "malformed upgrade -> no card, turn still fine")
    fx(ctx, talkUpgrade="")
    check(speak_turn(p) and p.locator(UPG).count() == n_cards, "upgrade:null -> no card")
    fx(ctx, talkUpgrade="offsets", talkUpStatus="ungrounded")
    check(speak_turn(p), "turn: upgradeStatus ungrounded")
    p.wait_for_timeout(300)
    check(p.locator(".up-said").count() == p.locator(".up-said").count() and "strayed from your script" in p.locator("#talkChat li.turn.coach").last.inner_text() and p.locator("#talkChat li.turn.coach").last.locator(".up-said").count() == 0, "ungrounded -> soft note, no comparison")
    fx(ctx, talkUpStatus="", talkOffTopic=True)
    check(speak_turn(p), "turn: off topic")
    p.wait_for_timeout(300)
    lastc = p.locator("#talkChat li.turn.coach").last
    check("off your script's topic" in lastc.inner_text() and lastc.locator(".up-said").count() == 1, "onTopic:false -> gentle off-topic note (card still shown)")
    shot(p, tag, "upgrade-04-notes")
    fx(ctx, talkUpgrade="", talkOffTopic=False)

    p.click("#btnTalkFinish"); wait_t(p, "finished", 10000)
    p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(500)
    srv = ctx.request.get(BASE + "/api/prefs").json()
    check((srv.get("prefs") or srv).get("practiceMode") in ("listen_repeat", "fading_cues"), "server practiceMode restored")
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow")
    check(not errors, "no page errors: " + "; ".join(errors[:3]))
    ctx.close()

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    run({"width": 390, "height": 844}, "mobile", browser)
    run({"width": 1280, "height": 800}, "desktop", browser)
    browser.close()
print(f"\n{checks} checks, {len(fails)} failed")
sys.exit(1 if fails else 0)
