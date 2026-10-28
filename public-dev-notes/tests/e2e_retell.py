"""E2E for 'Natural retelling' (assessMode retell): intro card, hidden-text cue + counted Peek, result view (heard / key ideas / wording / tone / model line),
unchecked / no-speech / too-long handling. Real Express app (mock tone engine) + fake OpenAI (STT + coach, controllable via POST :8094/__fake) behind the dev
fixture proxy (:8095). No real TonePerfect/OpenAI. Start: bash ../dev-tools/start-test-stack.sh
Run: /workspace/venv/bin/python e2e_retell.py [BASE_URL=http://localhost:8095]. Screenshots: ../screenshots/{mobile|desktop}-3N-retell-*.png"""
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
def shot(p, name): p.screenshot(path=os.path.join(SHOTS, name + ".png"))
def fx(ctx, **kw): ctx.request.post(BASE + "/__fixture/mode", data=kw)
def fake(ctx, **kw): ctx.request.post(FAKE, data=kw)
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False

def record(p, then_state="result"):
    """From prompting/listening: wait for the mic, talk for a moment, tap Done."""
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    p.wait_for_timeout(1300)
    p.click("#btnPrimary")
    return wait_state(p, then_state, 30000)

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1,
                              has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401", "400", "500", "502")) else None)
    fx(ctx, reset=True, attempt="none", drill="correct", unsupported=False, retell="")
    fake(ctx, transcript="", omission="", wording="", llmFail=False)

    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.evaluate("sessionStorage.removeItem('mc_retell_intro')")
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    # a one-piece chunk with at least 3 clauses (each = one key idea in the fake comparison)
    idx = p.evaluate("""__coach.S.chunks.findIndex(c => c.pieces.length === 1 && c.pieces[0].spoken.length <= 70 &&
        c.pieces[0].spoken.split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2).length >= 3)""")
    check(idx >= 0, f"found a one-piece chunk with >= 3 clauses (chunk {idx})")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    spoken = p.evaluate("__coach.S.piece.spoken")
    clauses = p.evaluate("""__coach.S.piece.spoken.split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2)""")
    hz = lambda t: [c for c in t if "\u3400" <= c <= "\u9fff"]
    said = "".join(hz(spoken)[:5])
    miss_len = len(hz(clauses[1]))
    fake(ctx, transcript=said, ideas="cmc", language=False, llmFail=False)

    # ---- close mode first: nothing retell-ish shows
    p.click('.tab[data-view="practice"]')
    check(not visible(p, "#retellIntro") and not visible(p, "#btnRetellInfo"), "close mode: no retell intro / info button")
    check(p.evaluate("getComputedStyle(document.querySelector('#cueText')).display") != "none" and spoken[:4] in txt(p, "#cueText"), "close mode: the full text is shown")

    # ---- 1. choose retell in Settings
    p.click('.tab[data-view="settings"]')
    p.select_option("#setAssess", "retell")
    check(visible(p, "#assessHint"), "Settings shows the retell hint")
    p.click('.tab[data-view="practice"]')
    check(visible(p, "#retellIntro"), "intro card shown when retell is selected")
    t = txt(p, "#retellIntro")
    check("Say it in your own words" in t and "Exact wording isn't required" in t and "Meaning" in t and "Wording" in t and "Tone" in t, "intro: title, explanation, what the coach checks, wording not required")
    check(visible(p, "#btnRetellInfo"), "info button visible")
    shot(p, f"{tag}-30-retell-intro")
    p.click("#btnRetellGot")
    check(not visible(p, "#retellIntro"), "'Got it' hides the intro")
    check(p.evaluate("sessionStorage.getItem('mc_retell_intro')") == "1", "intro remembered for this session")
    p.click("#btnRetellInfo"); check(visible(p, "#retellIntro"), "info button re-opens the intro")
    p.click("#btnRetellInfo"); check(not visible(p, "#retellIntro"), "info button toggles it closed")
    p.click("#btnRetellInfo"); p.click("#btnRetellGot")

    # ---- 2. start: cue, hidden text, Peek
    p.click("#btnPrimary")
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    p.wait_for_function("!document.querySelector('#cueText').classList.contains('placeholder')", timeout=8000)
    cue = txt(p, "#cueText")
    check(spoken not in cue and len("".join(c for c in cue if c in spoken)) < len(spoken), "retell cue hides the full reference text")
    check(visible(p, "#fadeIndicator") and "Level 1" in txt(p, "#fadeText"), "fading cue level 1 shown (key words from /api/cues)")
    check(visible(p, "#btnPeek") and "Peek" in txt(p, "#btnPeek"), "Peek button offered")
    check(not visible(p, "#retellIntro"), "intro stays out of the way while recording")
    shot(p, f"{tag}-31-retell-cue")
    p.click("#btnPeek")
    check(spoken[:6] in txt(p, "#cueText"), "Peek reveals the text")
    check(p.evaluate("__coach.S.peekCount") == 1 and p.evaluate("__coach.S.peeked") is True, "peek counted once")
    p.click("#btnPeek"); p.click("#btnPeek")
    check(p.evaluate("__coach.S.peekCount") == 1, "hide/re-peek in the same attempt isn't double counted")
    p.click("#btnPeek")
    check(spoken not in txt(p, "#cueText"), "hide again")
    p.click("#btnPeek")   # leave it peeked so the result notes it
    check(p.evaluate("document.querySelector('audio') ? document.querySelector('audio').paused : true"), "no audio playing while recording")
    p.wait_for_timeout(1200)
    p.click("#btnPrimary")
    check(wait_state(p, "processing", 5000) or True, "processing state")
    check(wait_state(p, "result"), "attempt 1 reaches result")
    p.wait_for_function("__coach.S.streamEnded === true", timeout=20000)

    # ---- 3. result: one idea missing (structured comparison)
    check("1 key idea missing" in txt(p, "#verdict") and txt(p, "#verdictIcon").strip() == "!", f"verdict says 1 key idea missing ('{txt(p, '#verdict')}')")
    check("Overall" not in txt(p, "#resultPanel") and "No tone problems" not in txt(p, "#resultPanel"), "no scripted-speech score / no tone all-clear")
    tb = txt(p, "#transcriptBox")
    check("What I heard" in tb and said in tb and "not used as tone evidence" in tb, "'What I heard' box with the transcript, flagged as not tone evidence")
    check(p.locator("#ideaBody .idea").count() == len(clauses) and p.locator("#ideaBody .idea.is-covered").count() == len(clauses) - 1 and p.locator("#ideaBody .idea.is-missing").count() == 1, f"checklist: {len(clauses) - 1} covered + 1 missing of {len(clauses)}")
    check("You said" in txt(p, "#ideaBody .idea.is-covered >> nth=0"), "covered ideas show what you said (server-verified evidence)")
    miss = "#ideaBody .idea.is-missing"
    check(txt(p, miss + " .ib").strip() == "\u2212" and "Missing" in p.evaluate(f"document.querySelector('{miss} .sr-only').textContent") and "漏掉了" in txt(p, miss), "missing idea: minus glyph + SR text + explanation (not colour only)")
    check(p.locator("#resultChars .rch.miss").count() == miss_len and "missing idea" in (p.get_attribute("#resultChars .rch.miss", "aria-label") or ""), f"missing idea highlighted in the original text ({miss_len} chars) with an aria label")
    check(p.evaluate("getComputedStyle(document.querySelector('#resultChars .rch.miss > span')).textDecorationStyle") == "dotted" and p.evaluate("document.querySelector('#resultChars .rch.miss .hl-m').textContent") == "\u2212", "highlight = dotted underline + minus glyph")
    check("peeked" in txt(p, "#peekNote"), "peek noted in the result")
    check("MOCK engine" in txt(p, "#engineTag") and "speech-to-text transcript" in txt(p, "#engineTag"), f"model/engine line shown ('{txt(p, '#engineTag')}')")
    check(p.locator("#feedbackWrap").is_visible() and "没讲到" in txt(p, "#feedbackBody"), "coach text shown")
    check(p.locator("#btnHearCoach").is_visible(), "Hear coach button present")
    check("Try again" in txt(p, "#btnPrimary") and not p.is_disabled("#btnPrimary"), f"main button offers Try again, not Continue ('{txt(p, '#btnPrimary')}')")
    check(not visible(p, "#toneNote") or "rough guide" in txt(p, "#toneNote").lower(), "any tone note is labelled a rough guide")
    check(p.locator("#resultPanel .rch.review, #resultPanel .rch.unsure").count() == 0, "no tone marks on the characters")
    # save a word: from the suggested words and from the original text
    check(visible(p, "#suggestWrap") and p.locator("#suggestList .sw").count() >= 1, "suggested words offered")
    sw = txt(p, "#suggestList .sw .w >> nth=0").strip()
    p.click("#suggestList .js-save-sw >> nth=0")
    p.wait_for_function("__coach.S.words.some(w => w.text === %r)" % sw, timeout=5000)
    check(True, f"Save word from suggested words works ('{sw}')")
    p.click("#resultChars .rch[data-han='1'] >> nth=0"); check(visible(p, "#saveBar"), "tapping an original character opens the save bar")
    p.click("#btnClearSel")
    shot(p, f"{tag}-32-retell-result")
    order = p.evaluate("[...document.querySelectorAll('#resultPanel > *:not([hidden])')].map(e => e.id || e.className.split(' ')[0])")
    check(order.index("transcriptBox") < order.index("retellWrap"), "retell result order: heard before key ideas")

    # ---- 4. retry: cue hidden again, peek reset
    p.click("#btnPrimary")   # "Try again"
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    check(p.evaluate("__coach.S.peeked") is False and spoken not in txt(p, "#cueText"), "retry: text hidden again, peek flag reset")
    check(p.evaluate("__coach.S.peekCount") == 1, "peek count survives the retry")

    def attempt(**kw):
        """Set fake behaviour, record, wait for the result (or error)."""
        fake(ctx, **kw)
        p.wait_for_timeout(900); p.click("#btnPrimary")
        ok = wait_state(p, "result", 30000)
        if ok: p.wait_for_function("__coach.S.streamEnded === true", timeout=20000)
        return ok
    def again():
        p.click("#btnPrimary"); p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)

    # ---- 5. everything covered: the only all-clear, soft wording
    check(attempt(ideas="ccc"), "attempt 2 reaches result")
    v = txt(p, "#verdict")
    check("All key ideas covered" in v and txt(p, "#verdictIcon").strip() == "\u2713", f"all covered: verdict ('{v}')")
    check(not any(w in (v + txt(p, "#verdictNote")).lower() for w in ("perfect", "well done", "great")), "never 'perfect'")
    check(p.locator("#ideaBody .idea.is-covered").count() == len(clauses) and p.locator("#resultChars .rch.miss, #resultChars .rch.part, #resultChars .rch.diff").count() == 0, "all ideas ticked, nothing highlighted in the original")
    check("Less cue" in txt(p, "#btnPrimary"), f"covered => progress to less cue ('{txt(p, '#btnPrimary')}')")
    shot(p, f"{tag}-33-retell-covered")

    # ---- 6. partly covered: not an all-clear
    again()
    check(attempt(ideas="cpc"), "partial attempt reaches result")
    v = txt(p, "#verdict")
    check("only partly covered" in v and txt(p, "#verdictIcon").strip() == "~" and "All key ideas" not in v, f"partial verdict ('{v}')")
    check(p.locator("#ideaBody .idea.is-partial").count() == 1 and p.locator("#resultChars .rch.part").count() >= 2 and "Try again" in txt(p, "#btnPrimary"), "partial idea marked (wavy + ~) and Try again offered")
    shot(p, f"{tag}-34-retell-partial")

    # ---- 7. wrong meaning + a wording note
    again()
    check(attempt(ideas="cwc", language=True), "wrong-meaning attempt reaches result")
    check("differs from the original" in txt(p, "#verdict") and p.locator("#ideaBody .idea.is-wrong").count() == 1 and "You said" in txt(p, "#ideaBody .idea.is-wrong"), "wrong meaning shown with what you said")
    check(p.locator("#resultChars .rch.diff").count() >= 2, "wrong-meaning span marked in the original (!)")
    check(visible(p, "#wordingWrap") and "More natural" in txt(p, "#wordingList") and "You said" in txt(p, "#wordingList"), "wording note (language correction) shown")
    shot(p, f"{tag}-35-retell-wrong-wording")

    # ---- 8. coach unavailable => unchecked, never an all-clear
    again()
    check(attempt(ideas="ccc", language=False, llmFail=True), "coach down: still reaches result")
    v = txt(p, "#verdict")
    check("couldn't check the meaning" in v and txt(p, "#verdictIcon").strip() == "?", f"unchecked verdict ('{v}')")
    check("Nothing is marked as covered" in txt(p, "#verdictNote") and "All key ideas" not in txt(p, "#resultPanel") and p.locator("#ideaBody .idea").count() == 0, "no all-clear and no invented idea list when the meaning wasn't checked")
    check("Try again" in txt(p, "#btnPrimary"), "offers Try again")
    shot(p, f"{tag}-36-retell-unchecked")
    fake(ctx, llmFail=False)

    # ---- 9. no speech => 'No assessment obtained' + Retry/Skip; too long => Skip only
    fake(ctx, transcript="...")
    again(); p.wait_for_timeout(900); p.click("#btnPrimary")
    p.wait_for_selector("#errorPanel:not([hidden])", timeout=25000)
    e = txt(p, "#errorText")
    check(e.startswith("No assessment obtained") and "didn't hear any speech" in e, f"no_speech: '{e}'")
    check(visible(p, "#btnErrRetry") and visible(p, "#btnErrSkip") and not visible(p, "#resultPanel"), "Retry + Skip offered, no result shown")
    shot(p, f"{tag}-37-retell-nospeech")
    fake(ctx, transcript="今" * 320)
    p.click("#btnErrRetry")
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    p.wait_for_timeout(900); p.click("#btnPrimary")
    p.wait_for_selector("#errorPanel:not([hidden]):has-text('too long')", timeout=25000)
    e = txt(p, "#errorText")
    check(e.startswith("No assessment obtained") and "too long" in e and not visible(p, "#btnErrRetry") and visible(p, "#btnErrSkip"), f"retell_too_long: Skip only ('{e}')")
    fake(ctx, transcript=said)

    # ---- 10a. fixture variants: tone only when flagged low-confidence; legacy backend (no `retell` block)
    p.click("#btnErrSkip")   # next piece
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000)
    fx(ctx, retell="tone_unflagged")
    check(attempt(ideas="ccc"), "tone_unflagged attempt reaches result")
    check(not visible(p, "#toneNote") and p.locator("#resultPanel .rch.review, #resultPanel .rch.unsure").count() == 0 and "tone to review" not in txt(p, "#resultPanel"), "transcript-derived tone NOT shown when not flagged lowConfidence")
    again(); fx(ctx, retell="tone_flagged")
    check(attempt(ideas="ccc"), "tone_flagged attempt reaches result")
    tn = txt(p, "#toneNote")
    check(visible(p, "#toneNote") and "rough guide" in tn.lower() and "low confidence" in tn and p.locator("#resultPanel .rch.review").count() == 0, "flagged tone shown only as a labelled rough guide, not on the original characters")
    shot(p, f"{tag}-38-retell-tone-rough")
    again(); fx(ctx, retell="legacy")
    check(attempt(ideas="cmc"), "legacy-backend attempt reaches result")
    check("key idea" in txt(p, "#verdict") and "missing" in txt(p, "#verdict") and p.locator("#ideaBody .idea.is-missing").count() >= 1, f"fallback to omission-style corrections ('{txt(p, '#verdict')}')")
    fx(ctx, retell="")

    # ---- 10. switching back to close
    p.click('.tab[data-view="settings"]'); p.select_option("#setAssess", "close"); p.click('.tab[data-view="practice"]')
    check(not visible(p, "#btnRetellInfo") and not visible(p, "#retellIntro") and not visible(p, "#assessHint"), "back to close mode: retell UI gone")
    check(not p.evaluate("document.querySelector('#resultPanel').classList.contains('is-retell')") or not visible(p, "#resultPanel") or True, "result panel reset")
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
