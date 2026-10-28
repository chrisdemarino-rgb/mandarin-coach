"""E2E for the reused-phrase word check (backend 855030d) in retell + Q&A, against the dev fixture proxy (:8095) -> real Express app (mock engine).
The fixture's `retell: wordcheck|wordcheck_medium|wordcheck_missed` / `qa: wordcheck|wordcheck_medium|wordcheck_missed` modes mirror the documented shape
(wordStatus reuse:true, facts, praiseBlockedBy, wordCheck, canPraise:false, savedMissed, done.corrections). Start: bash ../dev-tools/start-test-stack.sh
Run: /workspace/venv/bin/python e2e_wordcheck.py [BASE_URL=http://localhost:8095]. Screenshots: ../screenshots/{mobile|desktop}-5N-*.png"""
import sys, os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8095"
FAKE = os.environ.get("FAKE_URL", "http://127.0.0.1:8094/__fake")
PASS = os.environ.get("PASSCODE", "devpass")
SHOTS = os.path.join(os.path.dirname(__file__), "..", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
fails, checks = [], 0

def check(cond, msg):
    global checks
    checks += 1
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: fails.append(msg)

def wait_state(p, st, timeout=25000):
    try: p.wait_for_function("s => document.body.dataset.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def qs(p): return p.evaluate("__coach.Q.state")
def wait_q(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.Q.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def shot(p, name): p.screenshot(path=os.path.join(SHOTS, name + ".png"))
def fx(ctx, **kw): ctx.request.post(BASE + "/__fixture/mode", data=kw)
def fake(ctx, **kw): ctx.request.post(FAKE, data=kw)
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False
def last(ctx): return ctx.request.get(BASE + "/__fixture/last").json()

def q_answer(p):
    assert wait_q(p, "ready", 25000), "never ready: " + qs(p)
    p.click("#btnQaPrimary"); assert wait_q(p, "listening", 10000)
    p.wait_for_timeout(1200); p.click("#btnQaPrimary")
    return wait_q(p, "result", 25000)

def r_attempt(p, ctx):
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    p.wait_for_timeout(1000); p.click("#btnPrimary")
    ok = wait_state(p, "result", 30000)
    if ok: p.wait_for_function("__coach.S.streamEnded === true", timeout=20000); p.wait_for_timeout(400)
    return ok

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1,
                              has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors, saves = [], []
    p.on("request", lambda r: saves.append(r.url) if r.method == "POST" and r.url.split("?")[0].endswith("/api/words") else None)
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401", "400", "500", "502")) else None)
    fx(ctx, reset=True, attempt="none", drill="correct", unsupported=False, retell="", qa="covered", qaHints="backend", qaAnswer="assessment", qaUnsupported=False, qaTranscript="")
    fake(ctx, transcript="", omission="", wording="", llmFail=False)
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    idx = p.evaluate("""__coach.S.chunks.findIndex(c => c.pieces.length === 1 && c.pieces[0].spoken.length <= 70 &&
        c.pieces[0].spoken.split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2).length >= 3)""")
    check(idx >= 0, f"found a one-piece chunk with >= 3 clauses (chunk {idx})")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    spoken = p.evaluate("__coach.S.piece.spoken")
    hz = lambda t: [c for c in t if "\u3400" <= c <= "\u9fff"]
    fake(ctx, transcript="".join(hz(spoken)[:5]), ideas="ccc", language=False, llmFail=False)

    # ======================= RETELL =======================
    p.click('.tab[data-view="settings"]'); p.select_option("#setAssess", "retell")
    p.evaluate("sessionStorage.setItem('mc_retell_intro','1')")
    p.click('.tab[data-view="practice"]')
    if p.evaluate("document.querySelector('#practiceMode').value") == "qa": p.select_option("#qaModeSelect", "listen_repeat")   # prefs persist server-side across contexts
    p.evaluate(f"__coach.S.jumpTo({idx})")
    fx(ctx, retell="wordcheck")
    if visible(p, "#btnRetellGot"): p.click("#btnRetellGot")
    p.click("#btnPrimary")
    check(r_attempt(p, ctx), "retell + word check reaches the result")
    v = txt(p, "#verdict")
    check("one word differs from the script" in v and "Meaning covered" in v, f"retell: soft verdict, not an all-clear ('{v}')")
    check("All key ideas covered" not in txt(p, "#resultPanel") and txt(p, "#verdictIcon").strip() != "\u2713", "retell: no 'All key ideas covered' and no tick badge")
    check(p.locator("#resultChars .rch.wsub").count() >= 2 and p.locator("#resultChars .rch.wsub sup.hl-m").count() == 1, "retell: the swapped word is highlighted in the original text with ONE glyph marker")
    check("differs from the script" in (p.locator("#resultChars .rch.wsub").first.get_attribute("aria-label") or ""), "retell: highlighted characters carry screen-reader text")
    check(visible(p, "#flagWrap") and txt(p, "#flagWrap h3").strip() == "Word check", "retell: 'Word check' section shown")
    row = txt(p, "#flagList .flag.wc")
    check("谩骂" in row and "the script has" in row and "You said" in row and "I think" not in row, f"retell: high-confidence row says 'You said “谩骂”, the script has …' ({row!r})")
    check(p.locator("#flagList .flag.wc .py").count() == 1 and len(txt(p, "#flagList .flag.wc .py")) > 1, "retell: pinyin shown")
    check(p.locator("#flagList .js-save-wc").count() == 1, "retell: Save word button on the row")
    note = txt(p, "#savedNote")
    check(visible(p, "#savedNote") and note.startswith("Added to Words to practise:"), f"retell: 'Added to Words to practise' note ({note!r})")
    wtext = p.evaluate("__coach.S.assessment.wordStatus[0].text")
    check(wtext in note, "retell: the note names the word")
    p.wait_for_function("__coach.S.missed && __coach.S.missed.some(w => w.text === %r)" % wtext, timeout=8000)
    check(True, "retell: Words to practise list refreshed with the word (server-saved, not client-saved)")
    check(not saves, "retell: no client POST /api/words before the Save word tap (never auto-saved)")
    check(p.locator("#suggestList .sw .w:text-is('%s')" % wtext).count() == 0, "retell: the word isn't repeated in 'Words worth practising'")
    check("word differs from the script" in txt(p, "#resultPanel .legend"), "retell: legend explains the word marker")
    p.evaluate("document.querySelector('#flagWrap').scrollIntoView()")
    shot(p, f"{tag}-50-retell-wordcheck")
    p.click("#flagList .js-save-wc")
    p.wait_for_function("__coach.S.words.some(w => w.text === %r)" % wtext, timeout=5000)
    check(True, "retell: Save word saves explicitly on tap")
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "retell: no horizontal overflow")

    p.click("#btnPrimary"); fx(ctx, retell="wordcheck_medium")
    check(r_attempt(p, ctx), "retell medium reaches result")
    row = txt(p, "#flagList .flag.wc")
    check("I think I heard" in row and "谩骂" in row, f"retell: medium confidence is hedged ({row!r})")
    p.click("#btnPrimary"); fx(ctx, retell="wordcheck_missed")
    check(r_attempt(p, ctx), "retell missed reaches result")
    check("left out" in txt(p, "#flagList .flag.wc"), "retell: a missed word reads '“x” was left out'")
    check("one word was left out" in txt(p, "#verdict") and p.locator("#resultChars .rch.wmiss").count() >= 2, f"retell: missed verdict + dotted highlight ('{txt(p, '#verdict')}')")
    p.click("#btnPrimary"); fx(ctx, retell="")
    check(r_attempt(p, ctx), "retell clean reaches result")
    check(p.locator("#resultChars .rch.wsub, #resultChars .rch.wmiss").count() == 0 and p.locator("#flagList .flag.wc").count() == 0, "retell clean: no word-check UI")
    check("differs from the script" not in txt(p, "#verdict") and "left out" not in txt(p, "#verdict"), "retell clean: verdict unchanged")
    p.click('.tab[data-view="settings"]'); p.select_option("#setAssess", "close")

    # ======================= Q&A =======================
    p.click('.tab[data-view="practice"]'); p.select_option("#practiceMode", "qa")
    fx(ctx, qa="wordcheck")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click("#btnQaPrimary")
    check(q_answer(p), "Q&A + word check reaches the result"); p.wait_for_timeout(500)
    chunk = p.evaluate("__coach.Q.chunkText")
    lst = last(ctx)
    check(lst["qaChunkText"] == chunk and "chunkText" in lst["qaFields"], "Q&A: POST /api/qa/attempt carries the FULL chunk text (chunkText field)")
    v = txt(p, "#qaVerdict")
    check("one word differs from the script" in v and "Meaning covered" in v, f"Q&A: soft verdict ('{v}')")
    check("All key points covered" not in txt(p, "#qaResult"), "Q&A: no all-clear")
    check(p.locator("#qaSource .hl-substituted").count() == 1 and p.locator("#qaSource sup.hl-m-substituted").count() == 1 and p.locator("#qaSource .hl-covered").count() >= 1, "Q&A: word highlighted next to the key-point highlight (both marker sets present)")
    check(p.evaluate("document.querySelector('#qaSource').textContent.replace(/[^\\u3400-\\u9fff]/g,'')") == "".join(hz(chunk)), "Q&A: script text intact after merging markers")
    check(visible(p, "#qaWordWrap") and p.locator("#qaWordList .flag.wc").count() == 1, "Q&A: Word check section")
    row = txt(p, "#qaWordList .flag.wc")
    check("You said" in row and "谩骂" in row and "the script has" in row and p.locator("#qaWordList .py").count() == 1, f"Q&A: row text + pinyin ({row!r})")
    check(visible(p, "#qaSourceLegend") and "differs from the script" in txt(p, "#qaSourceLegend"), "Q&A: legend line")
    sn = txt(p, "#qaSavedNote")
    check(visible(p, "#qaSavedNote") and sn.startswith("Added to Words to practise:"), f"Q&A: saved note ({sn!r})")
    wtext = p.evaluate("__coach.Q.info.words[0].text")
    p.wait_for_function("__coach.S.missed && __coach.S.missed.some(w => w.text === %r)" % wtext, timeout=8000)
    check(True, "Q&A: Words to practise refreshed with the saved word")
    check(len(saves) == 1, "Q&A: no client save beyond the one explicit retell Save word tap (never auto-saved)")
    check(p.locator("#qaSuggest .sw .w:text-is('%s')" % wtext).count() == 0, "Q&A: not repeated in the suggested list")
    check(p.locator("#qaCoach p").count() >= 3 and "有个词和原文不一样" in txt(p, "#qaCoach") and "应该这样说" in txt(p, "#qaCoach"), "Q&A: coach_text sequence rendered (opener, correction, correction_model)")
    p.evaluate("document.querySelector('#qaSourceWrap').scrollIntoView()")
    shot(p, f"{tag}-51-qa-wordcheck")
    p.click("#qaWordList .js-save-wc")
    p.wait_for_function("__coach.S.words.some(w => w.text === %r)" % wtext, timeout=5000)
    check(True, "Q&A: Save word saves on tap")
    check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Q&A: no horizontal overflow")
    p.click("#btnQaRetry"); fx(ctx, qa="wordcheck_medium"); check(q_answer(p), "Q&A medium reaches result")
    check("I think I heard" in txt(p, "#qaWordList .flag.wc"), "Q&A: medium confidence hedged")
    p.click("#btnQaRetry"); fx(ctx, qa="wordcheck_missed"); check(q_answer(p), "Q&A missed reaches result")
    check("left out" in txt(p, "#qaWordList .flag.wc") and "one word was left out" in txt(p, "#qaVerdict") and p.locator("#qaSource .hl-missed").count() >= 1, "Q&A: missed word reads 'left out' with a missed highlight")
    p.click("#btnQaRetry"); fx(ctx, qa="covered"); check(q_answer(p), "Q&A clean reaches result")
    check("All key points covered" in txt(p, "#qaVerdict") and not visible(p, "#qaWordWrap") and p.locator("#qaSource .hl-substituted").count() == 0, "Q&A clean: all-clear as before, no Word check")
    p.click("#btnQaFinish")
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
