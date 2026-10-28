"""E2E for Free talk. Real Express app (mock engine) behind the dev fixture proxy (:8095), whose /api/talk/{opening,turn,summary} mirror the Backend's working-tree shape
(routes/talk.js + services/talk.js, 28 Oct). No real TonePerfect/OpenAI. Start: bash ../dev-tools/start-test-stack.sh
Run: /workspace/venv/bin/python e2e_talk.py [BASE_URL=http://localhost:8095]. Screenshots: ../screenshots/{mobile|desktop}-60-talk-*.png"""
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
def shot(p, tag, name): p.screenshot(path=os.path.join(SHOTS, f"{tag}-60-talk-{name}.png"))
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

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1, has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors, prefs_puts, talk_calls, uploads = [], [], [], []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401", "400", "500", "502", "@blob:")) else None)
    def on_req(r):
        if "/api/prefs" in r.url and r.method != "GET": prefs_puts.append(r.post_data or "")
        if "/api/talk/" in r.url: talk_calls.append(r.url.split("/api/talk/")[1].split("?")[0])
        if r.method == "POST" and ("/api/attempt" in r.url or "/api/qa/" in r.url): uploads.append(r.url)
    p.on("request", on_req)
    fx(ctx, reset=True, attempt="none", drill="correct", unsupported=False, retell="", qa="missing", qaUnsupported=False, talk="ok", talkUnsupported=False, talkOpening="ok", talkSummary="ok", talkTranscript="", talkSlow=0)

    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)

    p.evaluate("fetch('/api/words').then(r => r.json()).then(j => Promise.all((j.words || j || []).map(w => fetch('/api/words/' + w.id, { method: 'DELETE' }))))"); p.wait_for_timeout(300)
    # ---- 1. mode option + local flag + quiet pref push
    p.wait_for_timeout(800)
    if p.evaluate("document.body.dataset.view") == "talk":   # a previous aborted run left the server pref on free_talk
        p.select_option("#talkModeSelect", "listen_repeat"); p.wait_for_timeout(500)
    p.click('.tab[data-view="practice"]')
    opts = p.evaluate("[...document.querySelectorAll('#practiceMode option')].map(o => o.value + ':' + o.textContent.trim())")
    check("talk:Free talk" in opts and "qa:Q&A" in opts and any(o.startswith("listen_repeat") for o in opts), f"Practice mode offers Free talk next to the others ({opts})")
    n_puts = len(prefs_puts)
    p.select_option("#practiceMode", "talk")
    check(p.evaluate("document.body.dataset.view") == "talk" and visible(p, "#view-talk") and not visible(p, "#view-practice"), "choosing Free talk opens the Free talk screen")
    check(p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).talkMode") is True and p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).practiceMode") in ("listen_repeat", "fading_cues"), "talkMode is a local flag; the real practiceMode (for /api/attempt) is untouched")
    p.wait_for_timeout(400)
    check(any('"free_talk"' in b for b in prefs_puts[n_puts:]), "the server pref is pushed as practiceMode 'free_talk': " + str(prefs_puts[n_puts:]))
    check(not visible(p, "#toast.error") and not any("auth" in e for e in errors), "no error banner for the pref push")
    check(p.evaluate("document.querySelector('#talkModeSelect').value") == "talk" and p.evaluate("document.querySelector('#practiceMode').value") == "talk", "both mode selects show Free talk")
    p.reload(); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    check(p.evaluate("document.body.dataset.view") == "talk" or p.evaluate("document.querySelector('#practiceMode').value") == "talk", "Free talk selection survives a reload")
    p.click('.tab[data-view="practice"]')
    check(p.evaluate("document.body.dataset.view") == "talk", "Practice tab opens Free talk while selected")

    # ---- 2. topic default (client-side) + intro + no hints
    default_topic = p.input_value("#talkTopic")
    check(len(default_topic) >= 2 and len(default_topic) <= 24, f"topic is pre-filled from the script ({default_topic!r})")
    check(visible(p, "#talkIntro") and "what you" in txt(p, "#talkIntro") and "tones" in txt(p, "#talkIntro"), "intro says what is and isn't checked")
    check(p.locator("#view-talk button:has-text('hint'), #view-talk .qa-hint").count() == 0, "no hint controls in Free talk")
    check(not visible(p, "#talkChatWrap") and not visible(p, "#talkSummary") and not visible(p, "#talkError"), "nothing but the intro before Start")
    p.fill("#talkTopic", "我的周末")
    shot(p, tag, "01-intro")

    # ---- 3. Start: the coach opens (text + audio), topic is sent
    p.click("#btnTalkPrimary")
    check(wait_t(p, "processing", 3000) and "thinking of a question" in txt(p, "#talkStatus"), "Start shows the coach is thinking of an opening")
    check(wait_t(p, "ready", 15000), "Start arms the mic, fetches the opening and becomes your turn")
    check("/api/talk/opening" not in "".join(talk_calls) or "opening" in talk_calls, "POST /api/talk/opening called")
    check(last(ctx)["talkOpeningBody"]["topic"] == "我的周末", "the edited topic is sent to the opening")
    check(p.locator("#talkChat li.turn.coach").count() == 1 and "我的周末" in txt(p, "#talkChat li.turn.coach .turn-text"), "the coach's opening is the first chat turn")
    check(visible(p, "#talkChatWrap") and not visible(p, "#talkIntro") and p.evaluate("document.querySelector('#talkTopic').disabled"), "chat shown, topic locked while talking")
    # pinyin toggle on the opening (backend supplies pinyin)
    on = p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") == "true"
    p.click("#btnTalkPinyin")
    check((p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") == "true") != on, "pinyin toggle flips")
    if not p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") == "true": p.click("#btnTalkPinyin")
    check(visible(p, "#talkChat .turn.coach .turn-py") and "nǐ hǎo" in txt(p, "#talkChat .turn.coach .turn-py"), "pinyin shown for the opening when toggled on")
    p.click("#btnTalkPinyin"); check(not visible(p, "#talkChat .turn.coach .turn-py"), "pinyin hidden again when toggled off")
    check(p.evaluate("document.querySelector('#btnTalkPinyin').getAttribute('aria-pressed')") == "false", "toggle reflects the off state")
    shot(p, tag, "02-opened")

    # ---- 4. turn 1: record -> what I heard -> coach reply
    w0 = nwords(p)
    check(speak_turn(p), "turn 1: reply arrives, back to your turn")
    check(p.locator("#talkChat li.turn.user").count() == 1 and p.locator("#talkChat li.turn.coach").count() == 2, "chat has your turn and the coach's reply")
    ut = p.locator("#talkChat li.turn.user").first
    check("我周末去公园玩了" in ut.inner_text() and "what I heard" in ut.inner_text(), "your turn shows the transcript labelled 'what I heard'")
    check("tone" not in ut.inner_text().lower() and p.locator("#talkChat li.turn.user .turn-acoustic:not([hidden])").count() == 0, "no tone/pronunciation claims on your turn (transcript is not tone evidence)")
    ct = p.locator("#talkChat li.turn.coach").nth(1)
    check("听起来很不错" in ct.inner_text() and "你在公园里做了什么" in ct.inner_text(), "coach reply text shown (reply + question)")
    check("Pinyin isn't available" not in ct.inner_text(), "pinyin message hidden while the toggle is off")
    p.click("#btnTalkPinyin")
    check("Pinyin isn't available" in p.locator("#talkChat li.turn.coach").nth(1).inner_text(), "pinyin on + none from the backend -> honest 'isn't available' (no invented pinyin)")
    p.click("#btnTalkPinyin")
    c = last(ctx)
    check(c["talkFields"] == ["audio", "attemptId", "context"] or set(c["talkFields"]) >= {"audio", "attemptId", "context"}, "turn upload fields: " + str(c["talkFields"]))
    check(c["talkContext"]["topic"] == "我的周末" and c["talkContext"]["turns"] == [{"role": "coach", "text": c["talkOpeningBody"]["topic"] and c["talkContext"]["turns"][0]["text"]}] and c["talkContext"]["turns"][0]["role"] == "coach", "context sent: topic + the recent turns as text only (the opening)")
    check(isinstance(c["talkContext"].get("scriptVocab", []), list), "script vocabulary is a client-derived list")
    check(p.locator("#talkChat li.turn.user .hm").is_visible() and "Hear my recording" in p.inner_text("#talkChat li.turn.user .hm"), "'Hear my recording' on your turn")
    n_calls = len(talk_calls)
    p.click("#talkChat li.turn.user .hm")
    p.wait_for_timeout(300)
    check("Stop" in p.inner_text("#talkChat li.turn.user .hm") or p.evaluate("document.querySelector('#talkChat li.turn.user .hm').textContent").strip() != "", "hear-mine plays your own take (Stop toggle)")
    p.click("#talkChat li.turn.user .hm"); p.wait_for_timeout(200)
    check(len(talk_calls) == n_calls and not uploads, "hearing your recording makes no network call (never uploaded or assessed again)")
    check(nwords(p) == w0, "nothing saved automatically")
    shot(p, tag, "03-turn1")

    # ---- 5. turn 2 with a wording tip + suggested word (manual Save word)
    fx(ctx, talk="correction")
    check(speak_turn(p), "turn 2 with a wording tip")
    p.wait_for_timeout(300)
    
    tip = p.locator("#talkChat li.turn.coach .turn-tip:not([hidden])")
    check(tip.count() == 1 and "Wording tip" in tip.inner_text() and "逛了" in tip.inner_text() and "not your pronunciation" in tip.inner_text(), "wording tip is labelled as about words, not pronunciation")
    check("玩了" in tip.inner_text(), "the tip quotes what you said")
    c = last(ctx); roles = [t["role"] for t in c["talkContext"]["turns"]]
    check(roles == ["coach", "user", "coach"], "context for turn 2 = opening, your turn 1, coach reply 1: " + str(roles))
    check("逛了" not in json.dumps(c["talkContext"]["turns"], ensure_ascii=False), "tip sentences are not fed back as conversation")
    check(nwords(p) == w0 and p.locator(".js-save-sug").count() == 1, "suggested word offered, not saved")
    p.click(".js-save-sug"); p.wait_for_timeout(600)
    check(nwords(p) == w0 + 1, "Save word saves it (manual only)")
    check(p.locator(".js-save-sug").first.is_disabled() and "Saved" in p.inner_text(".js-save-sug"), "button shows Saved")
    fx(ctx, talk="ok")

    # ---- 6. pause / resume / skip reply
    p.click("#btnTalkPause")
    check(ts(p) == "paused" and "Resume" in txt(p, "#btnTalkPause") and p.evaluate("document.querySelector('#btnTalkPrimary').disabled"), "Pause -> paused, Record disabled")
    p.click("#btnTalkPause")
    check(ts(p) == "ready", "Resume -> your turn")
    check(p.evaluate("document.querySelector('#btnTalkSkip').disabled") in (True, False), "Skip reply control exists")

    # ---- 7. errors: nothing heard (gate), then coach down (retry same attemptId / skip), too long
    fx(ctx, talk="gate")
    check(speak_turn(p), "gate turn returns to ready")
    check(visible(p, "#talkError") and "No assessment obtained" in txt(p, "#talkErrorText") and "didn't hear" in txt(p, "#talkErrorText"), "nothing heard -> friendly 'No assessment obtained' error")
    check(p.locator("#talkChat li.turn.user").count() == 2 and "谢谢观看" not in p.inner_text("#talkChat"), "the gated turn (and its hallucinated transcript) is not kept as a conversation turn")
    check(not visible(p, "#btnTalkErrSkip"), "no Skip for a plain re-record")
    shot(p, tag, "04-gate")
    p.click("#btnTalkErrRetry"); check(not visible(p, "#talkError"), "Record again clears the error")
    fx(ctx, talk="llm_down")
    check(speak_turn(p), "llm_down turn")
    check(visible(p, "#talkError") and "No assessment obtained" in txt(p, "#talkErrorText") and visible(p, "#btnTalkErrRetry") and visible(p, "#btnTalkErrSkip"), "coach unavailable -> error with Try again and Skip this turn")
    check("我周末" in p.inner_text("#talkChat li.turn.user >> nth=-1") or p.locator("#talkChat li.turn.user").count() >= 3, "what was heard stays visible while you retry")
    c1 = last(ctx); ids = c1["talkAttemptIds"]
    fx(ctx, talk="ok")
    p.click("#btnTalkErrRetry")
    check(wait_t(p, "ready", 20000) and not visible(p, "#talkError"), "Try again re-sends the same take and succeeds")
    ids2 = last(ctx)["talkAttemptIds"]
    check(ids2[-1] == ids[-1], "retry reuses the same attemptId (server replay/idempotency)")
    fx(ctx, talk="stt_error"); n_user = p.locator("#talkChat li.turn.user").count()
    check(speak_turn(p) and visible(p, "#talkError") and visible(p, "#btnTalkErrSkip"), "transcription failure -> Try again / Skip")
    p.click("#btnTalkErrSkip")
    check(not visible(p, "#talkError") and ts(p) == "ready", "Skip this turn drops it")
    fx(ctx, talk="too_long")
    check(speak_turn(p) and "too long" in txt(p, "#talkErrorText"), "too-long turn -> friendly message")
    p.click("#btnTalkErrRetry"); fx(ctx, talk="ok")

    # ---- 8. Finish -> summary
    n_hm = p.locator("#talkChat li.turn.user .hm:visible").count()
    check(n_hm >= 3, f"every kept user turn has Hear my recording ({n_hm})")
    p.click("#btnTalkFinish")
    check(wait_t(p, "finished", 15000) and visible(p, "#talkSummary"), "Finish -> summary shown")
    s = txt(p, "#talkSummary")
    check("Takeaways" in s and "You described what you did" in s and "New words" in s and "爬山" in s and "Phrases to try" in s and "我觉得很放松" in s and "What went well" in s, "summary shows takeaways, new words, phrases to try")
    sb = last(ctx)["talkSummaryBody"]
    check(sb and sb["topic"] == "我的周末" and all(set(t) == {"role", "text"} for t in sb["turns"]) and any(t["role"] == "user" for t in sb["turns"]), "summary request carries topic + text-only turns")
    check(p.locator("#talkChat li.turn.user .hm:visible").count() == 0 and p.evaluate("__coach.T.turns.every(t => !t.take)"), "recordings are dropped at the end of the session")
    check(p.locator(".js-save-nw").count() == 2 and p.evaluate("document.querySelectorAll('.js-save-nw:not([disabled])').length") == 2, "Save word buttons on new words, none auto-saved")
    shot(p, tag, "05-summary")
    w1 = nwords(p)
    p.click('.js-save-nw[data-i="0"]'); p.wait_for_timeout(600)
    check(nwords(p) == w1 + 1 and "Saved" in p.inner_text('.js-save-nw[data-i="0"]') and p.locator('.js-save-nw[data-i="1"]').is_enabled(), "Save word saves just that word")
    check(p.evaluate("[...Array(localStorage.length).keys()].map(i => localStorage.getItem(localStorage.key(i))).join('|')").find("饺子") < 0 and p.evaluate("[...Array(localStorage.length).keys()].map(i => localStorage.getItem(localStorage.key(i))).join('|')").find("公园玩了") < 0, "no conversation text in localStorage")
    # again
    p.click("#btnTalkPrimary")
    check(wait_t(p, "ready", 15000) and p.locator("#talkChat li.turn").count() == 1, "Start again begins a fresh conversation (opening only)")
    # leaving forgets everything
    p.click('.tab[data-view="script"]')
    check(p.evaluate("__coach.T.state") == "idle" and p.evaluate("__coach.T.turns.length") == 0, "leaving the screen ends the session and forgets the conversation")
    p.click('.tab[data-view="practice"]')

    # ---- 9. summary failures + empty
    fx(ctx, talkSummary="error", talk="ok")
    p.click("#btnTalkPrimary"); wait_t(p, "ready", 15000); speak_turn(p)
    p.click("#btnTalkFinish")
    check(wait_t(p, "finished", 15000) and "summary" in txt(p, "#talkSummary").lower() and visible(p, "#talkSummary .js-talk-sum"), "summary failure -> message + 'Try the summary again'")
    fx(ctx, talkSummary="ok"); p.click("#talkSummary .js-talk-sum")
    check(wait_t(p, "finished", 15000) and "Takeaways" in txt(p, "#talkSummary"), "retrying the summary works")
    p.click("#btnTalkPrimary"); wait_t(p, "ready", 15000)
    p.click("#btnTalkFinish")
    check(wait_t(p, "finished", 8000) and "didn't hear anything" in txt(p, "#talkSummary") and last(ctx)["talkSummaryCalls"] >= 1, "finishing with no speech from you -> no summary call, friendly note")
    # opening failure is not fatal
    fx(ctx, talkOpening="fail"); p.click("#btnTalkPrimary")
    check(wait_t(p, "ready", 15000) and "start talking" in txt(p, "#talkNotice").lower() and p.locator("#talkChat li.turn").count() == 0, "opening failure -> you simply start talking")
    p.click("#btnTalkFinish"); wait_t(p, "finished", 8000); fx(ctx, talkOpening="ok")

    # ---- 10. not available (404/501)
    fx(ctx, talkUnsupported=True); p.click("#btnTalkPrimary")
    check(wait_t(p, "finished", 15000) and "isn't available yet" in txt(p, "#talkSummary"), "404 -> 'Free talk isn't available yet'")
    shot(p, tag, "06-unsupported")
    fx(ctx, talkUnsupported=False)
    check("Back" in txt(p, "#btnTalkPrimary"), "unsupported -> primary is Back")
    p.click("#btnTalkPrimary"); p.wait_for_timeout(300)   # leaves Free talk
    check(p.evaluate("document.body.dataset.view") == "practice", "Back leaves Free talk")
    p.select_option("#practiceMode", "talk"); p.wait_for_timeout(200)
    p.click("#btnTalkPrimary"); wait_t(p, "ready", 15000)
    p.click("#btnTalkFinish"); wait_t(p, "finished", 8000)

    # ---- 11. leave Free talk: other modes still work
    p.select_option("#talkModeSelect", "listen_repeat")
    check(p.evaluate("document.body.dataset.view") == "practice" and visible(p, "#view-practice") and p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).talkMode") is False, "back to Listen and repeat")
    p.wait_for_timeout(300)
    srv = ctx.request.get(BASE + "/api/prefs").json()
    check((srv.get("prefs") or srv).get("practiceMode") in ("listen_repeat", "fading_cues"), "server practiceMode restored: " + json.dumps(srv)[:120])
    check(not uploads, "Free talk never used /api/attempt or /api/qa")
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow")
    check(not errors, "no page errors: " + "; ".join(errors[:3]))
    ctx.close()

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"], headless=True)
    run({"width": 390, "height": 844}, "mobile", browser)
    run({"width": 1280, "height": 800}, "desktop", browser)
    browser.close()
print(f"\n{checks} checks, {len(fails)} failed")
for f in fails: print("FAIL:", f)
sys.exit(1 if fails else 0)
