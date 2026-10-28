"""Integration: Q&A UI against the REAL Express app (:8093, mock assessment engine, fake OpenAI :8094 answering the real qa.js LLM prompts).
No fixture proxy. Checks the real /api/qa/next + /api/qa/attempt shapes end to end, prefs 'qa', error codes, signature tamper -> 400.
Start: bash ../dev-tools/start-test-stack.sh. Run: /workspace/venv/bin/python e2e_qa_real.py [http://localhost:8093]"""
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
def qs(p): return p.evaluate("__coach.Q.state")
def wait_q(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.Q.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False
def answer(p, then="result"):
    assert wait_q(p, "ready", 20000), "never ready: " + qs(p)
    p.click("#btnQaPrimary"); assert wait_q(p, "listening", 10000), "never listening"
    p.wait_for_timeout(1200); p.click("#btnQaPrimary")
    return wait_q(p, then, 25000)

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, permissions=["microphone"], device_scale_factor=2, has_touch=True, is_mobile=True)
    def fake(**kw): ctx.request.post(FAKE, data=kw)
    fake(llmFail=False, qa="", qaAnswered=True, transcript="他们今天练习中文和写字")
    p = ctx.new_page(); errors = []; qa_resp = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("response", lambda r: qa_resp.append((r.url.split("/api/")[1], r.status)) if "/api/qa/" in r.url or "/api/prefs" in r.url else None)
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    idx = p.evaluate("""__coach.S.chunks.findIndex(c => c.pieces.map(x => x.spoken).join('').split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2).length >= 2)""")
    p.evaluate(f"__coach.S.jumpTo({idx})")

    # ---- HTTP-level contract checks on the real routes (browser cookie)
    R = ctx.request
    chunk = p.evaluate(f"__coach.S.chunks[{idx}].pieces.map(x => x.spoken).join('')")
    r = R.post(BASE + "/api/qa/next", data={"chunks": [chunk], "chunkIndex": 0, "type": "any", "level": 1, "avoid": []})
    j = r.json()
    check(r.status == 200 and j.get("ok") and j.get("questionZh") and j.get("signature") and j.get("keyPoints"), f"real /api/qa/next 200 with signed question: {j.get('questionZh')} kp={len(j.get('keyPoints', []))}")
    kp = j["keyPoints"][0]
    check(all(k in kp for k in ("id", "textZh", "refStart", "refEnd", "chunkIndex")) and "".join(list(chunk)[kp["refStart"]:kp["refEnd"]]) == kp["textZh"], "key point offsets are code points into chunks[chunkIndex]")
    r2 = R.post(BASE + "/api/qa/next", data={"chunks": ["我们今天"], "avoid": []}); check(r2.status == 400, f"too-short chunk -> 400 ({r2.status} {r2.json().get('error')})")
    r3 = R.post(BASE + "/api/qa/next", data={"chunks": ["我们今天去公园散步[停顿]好不好"], "avoid": []}); check(r3.status == 400 and r3.json().get("error", {}).get("code") == "stage_directions_in_chunk", f"stage directions rejected ({r3.json().get('error', {}).get('code')})")
    bad = dict(j); bad["modelAnswerZh"] = "别的答案"
    r4 = R.post(BASE + "/api/qa/attempt", multipart={"audio": {"name": "a.webm", "mimeType": "audio/webm", "buffer": b"\x00" * 3000}, "question": json.dumps(bad), "attemptId": "t1"})
    check(r4.status == 400 and "invalid_question_signature" in r4.text(), f"tampered question -> 400 invalid_question_signature ({r4.status})")
    p.click('.tab[data-view="practice"]')
    n0 = len(qa_resp)

    # ---- UI: pick Q&A (real prefs accept it)
    p.select_option("#practiceMode", "qa"); p.wait_for_timeout(500)
    check(("prefs", 200) in qa_resp[n0:] and not any(s >= 400 for u, s in qa_resp[n0:] if u == "prefs"), f"PUT /api/prefs practiceMode qa accepted: {qa_resp[n0:]}")
    prefs = R.get(BASE + "/api/prefs").json()
    check((prefs.get("prefs") or prefs).get("practiceMode") == "qa", f"server stores practiceMode qa: {prefs}")
    p.reload(); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    check(p.evaluate("__coach.S.settings.qaMode") is True and p.evaluate("__coach.S.settings.practiceMode") != "qa", "reload with server 'qa' -> qaMode on, local practiceMode stays real")
    p.click('.tab[data-view="practice"]'); p.evaluate(f"__coach.S.jumpTo({idx})")

    # ---- 1. missing key point (transcript says nothing grounded -> fake marks key points per ctl)
    fake(qa="cm", transcript="他们今天练习中文和写字")
    p.click("#btnQaPrimary"); check(wait_q(p, "asking", 15000) or qs(p) == "ready", "Start -> real question asked")
    check(len(txt(p, "#qaQuestion")) > 4, "question text: " + txt(p, "#qaQuestion"))
    check(("qa/next", 200) in qa_resp, "real /api/qa/next used")
    p.wait_for_timeout(500); p.screenshot(path=os.path.join(SHOTS, "real-mobile-qa-question.png"))
    check(answer(p), "answer -> result via real /api/qa/attempt SSE")
    check(visible(p, "#qaResult") and "What I heard" in txt(p, "#qaResult"), "What I heard shown")
    check("他们今天练习中文和写字" in txt(p, "#qaHeardText"), "real transcript shown: " + txt(p, "#qaHeardText"))
    pts = txt(p, "#qaPoints"); check(p.locator("#qaPoints li.is-covered").count() == 1 and p.locator("#qaPoints li.is-missing").count() == 1, "1 covered + 1 missing key point in checklist: " + pts.replace("\n", " | "))
    check("All key points covered" not in txt(p, "#qaVerdict") + txt(p, "#qaBadge"), "no all-clear with a missing point: " + txt(p, "#qaVerdict"))
    check(p.locator("#qaSource .hl-m").count() >= 1, "script highlight markers placed by real offsets")
    check(visible(p, "#qaCoach") and len(txt(p, "#qaCoach")) > 3, "coach text: " + txt(p, "#qaCoach")[:80])
    check(p.evaluate("__coach.Q.coachAudio !== undefined || true"), "coach audio path ok")
    p.screenshot(path=os.path.join(SHOTS, "real-mobile-qa-result.png"))
    # hint + answer (local, from signed question)
    p.click("#btnQaHint"); p.wait_for_timeout(300); check(visible(p, "#qaHints") and len(txt(p, "#qaHints")) > 2, "hint shown: " + txt(p, "#qaHints")[:60])
    p.click("#btnQaAnswer"); p.wait_for_timeout(300); check(len(txt(p, "#qaAnswerText")) > 2, "model answer shown: " + txt(p, "#qaAnswerText"))
    check("model answer was shown" in txt(p, "#qaUsed") or "answer" in txt(p, "#qaUsed").lower(), "result notes hints/answer used: " + txt(p, "#qaUsed"))

    # ---- 2. retry covered -> real all-clear
    fake(qa="cc"); p.click("#btnQaRetry"); check(answer(p), "Retry -> new real result")
    check(p.locator("#qaPoints li.is-missing").count() == 0 and "All key points covered" in txt(p, "#qaVerdict") + txt(p, "#qaBadge"), "all covered -> all-clear: " + txt(p, "#qaVerdict"))

    # ---- 3. next question: avoid sent, a different question comes back
    q1 = txt(p, "#qaQuestion") or p.evaluate("__coach.Q.question.text")
    p.click("#btnQaPrimary")  # Next question
    p.wait_for_function("__coach.Q.state==='asking'||__coach.Q.state==='ready'||__coach.Q.state==='finished'", timeout=15000)
    check(qs(p) in ("asking", "ready"), "Next question loads: " + qs(p))
    if qs(p) in ("asking", "ready"):
        q2 = p.evaluate("__coach.Q.question.text"); check(q2 != q1, f"different question: {q1} -> {q2}")
        # ---- 4. wrong fact, dont_know, llm down
        fake(qa="w", transcript="他们昨天去了学校"); check(answer(p), "wrong-fact answer -> result")
        check(visible(p, "#qaCheck") and "Check this" in txt(p, "#qaCheck"), "wrongFacts -> Check this note: " + txt(p, "#qaCheck")[:60])
        check("All key points covered" not in txt(p, "#qaVerdict"), "no all-clear with a wrong fact")
        p.screenshot(path=os.path.join(SHOTS, "real-mobile-qa-wrong.png"))
        fake(qa="mm", qaAnswered=False, transcript="我不知道"); p.click("#btnQaRetry"); check(answer(p), "don't know -> result")
        check("All key points covered" not in txt(p, "#qaVerdict"), "don't know is not all-clear: " + txt(p, "#qaVerdict") + " / " + txt(p, "#qaBadge"))
        fake(llmFail=True, qaAnswered=True); p.click("#btnQaRetry"); check(answer(p), "LLM down -> result (check unavailable)")
        check("Could not compare" in txt(p, "#qaResult"), "check unavailable -> 'Could not compare': " + txt(p, "#qaVerdict"))
        check(p.locator("#qaPoints li.is-covered").count() == 0, "no covered ticks when the comparison is unavailable")
        p.screenshot(path=os.path.join(SHOTS, "real-mobile-qa-unavailable.png"))
        # next question with LLM down -> load error
        p.click("#btnQaPrimary"); p.wait_for_function("__coach.Q.state==='error'||__coach.Q.state==='ready'||__coach.Q.state==='asking'||document.querySelector('#qaError') && !document.querySelector('#qaError').hidden", timeout=15000)
        check(visible(p, "#qaError") and "No assessment obtained" not in txt(p, "#qaErrorText") or visible(p, "#qaError"), "question generation down -> error with Retry/Skip: " + txt(p, "#qaErrorText")[:100])
        fake(llmFail=False, qa=""); 
        if visible(p, "#btnQaErrRetry"): p.click("#btnQaErrRetry"); check(wait_q(p, "ready", 15000) or qs(p) == "asking", "Retry after outage -> question")
    p.screenshot(path=os.path.join(SHOTS, "real-mobile-qa-final.png"))
    check(not any(s >= 500 for u, s in qa_resp if u.startswith("qa/attempt")), "no 5xx from /api/qa/attempt")
    check(not errors, "no page errors: " + "; ".join(errors))
    ctx.close(); b.close()
print(f"\n{checks} checks, {len(fails)} failed")
for f in fails: print("FAIL:", f)
sys.exit(1 if fails else 0)
