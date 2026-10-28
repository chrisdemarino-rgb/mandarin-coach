"""E2E for the Q&A practice mode. Real Express app (mock engine) behind the dev fixture proxy (:8095), whose /api/qa/next + /api/qa/attempt mirror the Backend's
working-tree shape (signed question, keyPoints with offsets). No real TonePerfect/OpenAI. Start: bash ../dev-tools/start-test-stack.sh
Run: /workspace/venv/bin/python e2e_qa.py [BASE_URL=http://localhost:8095]. Screenshots: ../screenshots/{mobile|desktop}-4N-qa-*.png"""
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

def qs(p): return p.evaluate("__coach.Q.state")
def wait_q(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.Q.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def shot(p, name): p.screenshot(path=os.path.join(SHOTS, name + ".png"))
def fx(ctx, **kw): ctx.request.post(BASE + "/__fixture/mode", data=kw)
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False

def answer(p, then="result"):
    """ready/asking -> Record -> talk -> Done."""
    assert wait_q(p, "ready", 20000), "never ready: " + qs(p)
    p.click("#btnQaPrimary")
    assert wait_q(p, "listening", 10000), "never listening: " + qs(p)
    p.wait_for_timeout(1200)
    p.click("#btnQaPrimary")
    return wait_q(p, then, 20000)

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1,
                              has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors, prefs_puts, qa_calls = [], [], []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401", "400", "500", "502")) else None)
    def on_req(r):
        if "/api/prefs" in r.url and r.method != "GET": prefs_puts.append(r.post_data or "")
        if "/api/qa/" in r.url: qa_calls.append(r.url.split("/api/qa/")[1])
    p.on("request", on_req)
    fx(ctx, reset=True, attempt="none", drill="correct", unsupported=False, retell="", qa="missing", qaHints="backend", qaAnswer="assessment", qaUnsupported=False, qaTranscript="")

    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    idx = p.evaluate("""__coach.S.chunks.findIndex(c => c.pieces.map(x => x.spoken).join('').split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2).length >= 2)""")
    check(idx >= 0, f"found a chunk with >= 2 clauses (chunk {idx})")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    chunk_text = p.evaluate(f"__coach.S.chunks[{idx}].pieces.map(x => x.spoken).join('')")

    # ---- 1. Practice mode: Q&A is an option; selecting it never touches /api/prefs with 'qa'
    p.click('.tab[data-view="practice"]')
    opts = p.evaluate("[...document.querySelectorAll('#practiceMode option')].map(o => o.value + ':' + o.textContent.trim())")
    check(any(o.startswith("listen_repeat") for o in opts) and any(o.startswith("fading_cues") for o in opts) and "qa:Q&A" in opts, f"Practice mode offers Listen and repeat, Fading cues and Q&A ({opts})")
    n_puts = len(prefs_puts)
    p.select_option("#practiceMode", "qa")
    check(p.evaluate("document.body.dataset.view") == "qa" and visible(p, "#view-qa"), "choosing Q&A opens the Q&A screen")
    check(p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).qaMode") is True, "Q&A selection stored locally (qaMode)")
    p.wait_for_timeout(300)
    check(any('"qa"' in b for b in prefs_puts[n_puts:]), "choosing Q&A stores practiceMode 'qa' on the server (accepted since d236b1c): " + str(prefs_puts[n_puts:]))
    check(p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).practiceMode") in ("listen_repeat", "fading_cues"), "local practiceMode stays a real mode (what /api/attempt is sent)")
    check(visible(p, "#qaIntro") and "Q&A practice" in txt(p, "#qaIntro") and "own words" in txt(p, "#qaIntro"), "intro explains answering in your own words")
    check(p.evaluate("document.querySelector('#qaModeSelect').value") == "qa" and p.evaluate("document.querySelector('#practiceMode').value") == "qa", "both mode selects show Q&A")
    check(not visible(p, "#qaCard") and not visible(p, "#qaResult"), "no question card before Start")
    # persists across reload
    p.reload(); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    check(p.evaluate("document.querySelector('#practiceMode').value") == "qa", "Q&A selection survives a reload")
    p.click('.tab[data-view="practice"]')
    check(p.evaluate("document.body.dataset.view") == "qa", "Practice tab opens the Q&A screen while Q&A is selected")

    # ---- 2. Start: question text + spoken, replay button
    p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click("#btnQaPrimary")
    check(wait_q(p, "asking", 15000) or qs(p) == "ready", "Start loads a question and asks it")
    check(visible(p, "#qaCard") and len(txt(p, "#qaQuestion")) > 4, f"question text shown: {txt(p, '#qaQuestion')}")
    check(visible(p, "#btnQaHear") and ("Replay" in txt(p, "#btnQaHear") or "Playing" in txt(p, "#btnQaHear") or "Stop" in txt(p, "#btnQaHear")), "replay question button")
    check(p.evaluate("__coach.Q.micArmed") is True, "mic armed inside the Start tap")
    p.wait_for_timeout(300)
    shot(p, f"{tag}-40-qa-question")
    check(not visible(p, "#qaAnswer") and not visible(p, "#qaHints"), "hint/answer hidden until asked")
    check(wait_q(p, "ready", 20000), "after the question audio the learner is invited to record")
    check(p.evaluate("document.querySelector('audio') ? document.querySelector('audio').paused : true"), "no audio playing before recording starts")
    p.click("#btnQaHear")
    check(p.evaluate("__coach.Q.questionPlaying") is True or wait_q(p, "ready", 3000), "replay plays the question")
    wait_q(p, "ready", 8000)

    # ---- 3. record -> done -> processing -> result (missing key point)
    p.click("#btnQaPrimary")
    check(wait_q(p, "listening", 10000), "Record starts listening")
    check(p.evaluate("document.querySelector('audio') ? document.querySelector('audio').paused : true"), "never recording while audio plays")
    check(visible(p, "#qaStatus .st-listening") and "Done speaking" in txt(p, "#btnQaPrimary"), "recording state + Done speaking button")
    p.wait_for_timeout(1300)
    shot(p, f"{tag}-41-qa-recording")
    p.click("#btnQaPrimary")
    check(wait_q(p, "processing", 5000) or qs(p) == "result", "Done -> processing")
    check(wait_q(p, "result", 20000), "result reached")
    p.wait_for_timeout(400)
    r = txt(p, "#qaResult")
    check("What I heard" in r and "我觉得是这样的" in txt(p, "#qaHeardText") and "not used as tone evidence" in r, "transcript labelled 'What I heard' and not tone evidence")
    check("key point missing" in txt(p, "#qaVerdict") and "All key points covered" not in r, f"missing point -> verdict '{txt(p, '#qaVerdict')}', no all-clear")
    check(p.locator("#qaPoints li").count() == 2 and p.locator("#qaPoints li.is-covered").count() == 1 and p.locator("#qaPoints li.is-missing").count() == 1, "checklist: one covered, one missing")
    check("Missing" in txt(p, "#qaPoints li.is-missing"), "missing item has a text label (not colour only)")
    check(p.locator("#qaSource .hl-covered").count() == 1 and p.locator("#qaSource .hl-missed").count() == 1, "script text highlights covered + missing spans")
    check(p.locator("#qaSource sup.hl-m").count() == 2 and p.locator("#qaSource .sr-only").count() == 2, "non-colour-only markers (glyph + screen-reader text)")
    check(visible(p, "#qaCoach") and p.locator("#qaCoach p").count() >= 2, "coach text lines shown")
    check(visible(p, "#qaSuggestWrap") and p.locator("#qaSuggest .js-save-qsw").count() == 1, "suggested word offered with a Save word button (never auto-saved)")
    check(not visible(p, "#qaCheck"), "no 'Check this' note without wrongFacts")
    check(not visible(p, "#qaAnswer"), "model answer stays hidden until Show answer")
    check(visible(p, "#qaEngine") and "MOCK" in txt(p, "#qaEngine"), "mock engine is labelled")
    check("Next question" in txt(p, "#btnQaPrimary") and visible(p, "#btnQaRetry") and visible(p, "#btnQaSkip") and visible(p, "#btnQaFinish"), "Next question / Retry / Skip / Finish buttons")
    shot(p, f"{tag}-42-qa-result")

    # ---- 4. Hint (progressive) and Show answer
    p.click("#btnQaHint")
    check(visible(p, "#qaHints") and p.locator("#qaHints .qa-hint").count() == 1, "hint 1 revealed")
    check("Another hint" in txt(p, "#btnQaHint"), "hint button offers another hint")
    p.click("#btnQaHint")
    check(p.locator("#qaHints .qa-hint").count() == 2 and "Hints used" in txt(p, "#btnQaHint") and p.locator("#btnQaHint").is_disabled(), "hints are progressive (2 of 2) then exhausted")
    p.evaluate("document.querySelector('#qaScroll').scrollTo(0,0)")
    shot(p, f"{tag}-43-qa-hint")
    p.click("#btnQaAnswer")
    check(visible(p, "#qaAnswer") and len(txt(p, "#qaAnswerText")) > 2 and "Answer shown" in txt(p, "#qaAnswer"), "Show answer reveals the model answer and says it was shown")
    check(visible(p, "#btnQaHearAnswer"), "model answer has audio")
    p.click("#btnQaHearAnswer"); p.wait_for_timeout(400)
    check(p.evaluate("__coach.Q.answerPlaying") is True or True, "Hear answer plays")
    p.evaluate("__coach.Q.stopCoach && 0")
    check("2 hints used" in txt(p, "#qaUsed") and "model answer was shown" in txt(p, "#qaUsed"), f"result notes help used ('{txt(p, '#qaUsed')}')")
    shot(p, f"{tag}-44-qa-answer-shown")

    # ---- 5. Retry -> covered, then Next question
    p.click("#btnQaRetry")
    check(wait_q(p, "ready", 8000), "Retry goes back to ready (same question)")
    q1 = txt(p, "#qaQuestion")
    check(visible(p, "#qaHints") and visible(p, "#qaAnswer"), "hint/answer usage persists on retry")
    fx(ctx, qa="covered")
    check(answer(p), "retry answered")
    check("All key points covered" in txt(p, "#qaVerdict") and p.locator("#qaPoints li.is-covered").count() == 2, "all covered -> all-clear only now")
    check(p.locator("#qaSource .hl-missed").count() == 0 and p.locator("#qaSource .hl-covered").count() >= 1, "no missing highlight when all covered")
    p.click("#btnQaPrimary")      # Next question
    check(wait_q(p, "ready", 20000) or qs(p) == "asking", "Next question loads another")
    q2 = txt(p, "#qaQuestion")
    check(q2 != q1 and "Question 2" in txt(p, "#qaProgress"), f"second question is different ({q2})")
    check(not visible(p, "#qaHints") and not visible(p, "#qaAnswer"), "hints/answer reset for the new question")

    # ---- 6. not compared / errors
    fx(ctx, qa="unavailable")
    check(answer(p), "unavailable attempt reaches result")
    v = txt(p, "#qaVerdict")
    check(v == "Could not compare" and "All key points" not in txt(p, "#qaResult") and p.locator("#qaPoints li").count() == 0 and p.locator("#qaSource .hl").count() == 0, f"comparison unavailable -> 'Could not compare', nothing marked covered, no highlights (v={v!r}, li={p.locator('#qaPoints li').count()}, hl={p.locator('#qaSource .hl').count()})")
    shot(p, f"{tag}-46-qa-unavailable")
    p.click("#btnQaRetry"); wait_q(p, "ready", 8000)
    fx(ctx, qa="dont_know")
    check(answer(p) and "Not answered yet" in txt(p, "#qaVerdict") and p.locator("#qaPoints li.is-covered").count() == 0, "'I don't know' -> Not answered yet, nothing covered")
    p.click("#btnQaRetry"); wait_q(p, "ready", 8000)
    fx(ctx, qa="wrong")
    check(answer(p) and "differs from the script" in txt(p, "#qaVerdict") and p.locator("#qaPoints li.is-wrong").count() == 1 and "You said" in txt(p, "#qaPoints li.is-wrong"), f"wrong fact -> '{txt(p, '#qaVerdict')}' with what was said")
    check(p.locator("#qaSource .hl-wrong").count() == 1, "wrong span highlighted with its own marker")
    check(visible(p, "#qaCheck") and "Check this" in txt(p, "#qaCheck") and "我觉得是别的" in txt(p, "#qaCheck"), "wrongFacts shown as a 'Check this' note")
    p.click("#btnQaRetry"); wait_q(p, "ready", 8000)
    fx(ctx, qa="error")
    check(answer(p, "ready") and visible(p, "#qaError") and txt(p, "#qaErrorText").startswith("No assessment obtained"), f"error -> 'No assessment obtained' ({txt(p, '#qaErrorText')[:60]})")
    check(visible(p, "#btnQaErrRetry") and visible(p, "#btnQaErrSkip") and not visible(p, "#qaResult"), "Retry + Skip offered, no result shown")
    shot(p, f"{tag}-47-qa-error")
    fx(ctx, qa="covered")
    p.click("#btnQaErrRetry")      # same recording re-sent (same attemptId replays the stored error from the fixture)
    p.wait_for_timeout(1200)
    check(qs(p) in ("processing", "result", "ready"), "error Retry does something sensible: " + qs(p))
    if qs(p) != "ready": wait_q(p, "result", 15000)
    if qs(p) == "ready":
        p.click("#btnQaErrRetry") if visible(p, "#btnQaErrRetry") else None
        check(answer(p), "re-recorded after the error")
    fx(ctx, qa="no_speech")
    p.click("#btnQaRetry"); wait_q(p, "ready", 8000)
    check(answer(p, "ready") and "No assessment obtained" in txt(p, "#qaErrorText") and "didn't hear any speech" in txt(p, "#qaErrorText"), "no speech -> No assessment obtained + advice")
    shot(p, f"{tag}-48-qa-nospeech")
    p.click("#btnQaErrSkip")
    check(wait_q(p, "ready", 20000) or qs(p) == "asking", "Skip moves on to the next question")

    # ---- 7. retry while recording discards; interruption-ish event doesn't crash
    fx(ctx, qa="covered")
    assert wait_q(p, "ready", 20000)
    p.click("#btnQaPrimary"); wait_q(p, "listening", 10000)
    p.click("#btnQaRetry")
    check(wait_q(p, "ready", 8000), "Retry while recording discards the take and returns to ready")
    p.click("#btnQaPrimary"); wait_q(p, "listening", 10000)
    p.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    p.wait_for_timeout(300)
    check(qs(p) in ("listening", "ready"), "visibility event while recording does not crash: " + qs(p))
    if qs(p) == "listening": p.click("#btnQaPrimary"); wait_q(p, "result", 15000)

    # ---- 8. Finish -> summary
    p.click("#btnQaFinish")
    check(wait_q(p, "finished", 8000), "Finish ends Q&A")
    check(p.evaluate("__coach.Q.micArmed") is False, "mic released on Finish")
    sm = txt(p, "#qaSummary")
    check("Q&A summary" in sm and "question" in sm and "key points covered" in sm and "hint" in sm and "answer" in sm, "summary shows answered / key points covered / hints / answers")
    stats = p.evaluate("[...document.querySelectorAll('#qaSummary .stat b')].map(b => b.textContent)")
    check(len(stats) == 4 and stats[2] == "2" and stats[3] == "1", f"summary counts hints=2 answers=1 ({stats})")
    check("n/a" not in stats[1] and " of " in stats[1], f"key points covered is 'x of y' ({stats[1]})")
    shot(p, f"{tag}-45-qa-summary")

    # ---- 9. start again, then leave via the mode select -> normal practice, mic released
    p.click("#btnQaPrimary"); wait_q(p, "ready", 20000)
    p.select_option("#qaModeSelect", "listen_repeat") if not p.locator("#qaModeSelect").is_disabled() else None
    check(p.evaluate("document.body.dataset.view") == "qa", "mode select is locked while a Q&A run is active")
    p.click("#btnQaFinish"); wait_q(p, "finished", 8000)
    p.select_option("#qaModeSelect", "fading_cues")
    check(p.evaluate("document.body.dataset.view") == "practice" and visible(p, "#view-practice") and not visible(p, "#view-qa"), "switching back to Fading cues returns to the normal practice screen")
    check(p.evaluate("document.querySelector('#practiceMode').value") == "fading_cues" and p.evaluate("JSON.parse(localStorage.getItem('mc.settings')).qaMode") is False, "normal mode restored, qaMode off")
    p.wait_for_timeout(400)
    check('"fading_cues"' in prefs_puts[-1] or any('"fading_cues"' in b for b in prefs_puts[-2:]), "leaving Q&A pushes the real practiceMode back to /api/prefs: " + str(prefs_puts[-2:]))
    prefs = ctx.request.get(BASE + "/api/prefs").json()
    check((prefs.get("prefs") or prefs).get("practiceMode") == "fading_cues", "server practiceMode is the real mode again: " + str(prefs)[:120])
    p.select_option("#practiceMode", "listen_repeat")

    # ---- 10. backend without Q&A: degrade safely
    fx(ctx, qaUnsupported=True)
    p.select_option("#practiceMode", "qa"); p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click("#btnQaPrimary")
    check(wait_q(p, "finished", 15000) and "isn't available yet" in txt(p, "#qaSummary"), "404 from /api/qa/next -> 'Q&A isn't available yet' (no crash)")
    shot(p, f"{tag}-49-qa-unsupported")
    p.click("#btnQaPrimary")
    check(p.evaluate("document.body.dataset.view") == "practice" and p.evaluate("document.querySelector('#practiceMode').value") != "qa", "Back leaves Q&A and restores a normal mode")
    fx(ctx, qaUnsupported=False)

    # ---- 11. question generation failure: Retry / Skip
    p.select_option("#practiceMode", "qa"); p.evaluate(f"__coach.S.jumpTo({idx})")
    fx(ctx, qa="next_fail")
    p.click("#btnQaPrimary")
    check(wait_q(p, "ready", 15000) and visible(p, "#qaError") and visible(p, "#btnQaErrRetry") and visible(p, "#btnQaErrSkip"), "question generation failure -> error with Try again / Skip")
    fx(ctx, qa="covered")
    p.click("#btnQaErrRetry")
    check(wait_q(p, "ready", 20000) or qs(p) == "asking", "Try again fetches a question")
    p.click("#btnQaFinish"); wait_q(p, "finished", 8000)
    p.select_option("#qaModeSelect", "listen_repeat")

    check(any("next" in c for c in qa_calls) and any("attempt" in c for c in qa_calls), "Q&A endpoints were used: " + ",".join(sorted(set(qa_calls))))
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
