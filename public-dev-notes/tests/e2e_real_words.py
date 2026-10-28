"""Integration smoke against the REAL Express server (mock assessment engine, fake OpenAI) - no fixture wrapper. Proves the real wordStatus /
savedMissed / /api/words/missed / /api/drill/* shapes work with the frontend.
Start the stack with:  FAKE_TRANSCRIPT="我叫今天我想用中文跟大家我的生活" bash ../dev-tools/start-test-stack.sh      (transcript omits 大卫 and 聊一聊)
Run: /workspace/venv/bin/python e2e_real_words.py [BASE_URL=http://localhost:8093]"""
import sys, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8093"
fails, checks = [], 0
def check(c, m):
    global checks; checks += 1; print(("  ok   " if c else "  FAIL ") + m)
    if not c: fails.append(m)
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, permissions=["microphone"]); p = ctx.new_page(); errs = []
    p.on("pageerror", lambda e: errs.append(str(e)))
    p.goto(BASE); p.fill("#passcode", os.environ.get("PASSCODE", "devpass")); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth==='in'")
    p.click('.tab[data-view="script"]'); p.click("#btnSample"); p.wait_for_timeout(500); p.select_option("#chunkModeScript", "sentence")
    idx = p.evaluate("__coach.S.chunks.findIndex(c => c.pieces[0].spoken === '我叫大卫，今天我想用中文跟大家聊一聊我的生活。')")
    check(idx >= 0, "sample sentence found")
    p.evaluate(f"__coach.S.jumpTo({idx})"); p.click('.tab[data-view="practice"]'); p.click("#btnPrimary")
    p.wait_for_function("document.body.dataset.state==='listening'"); p.wait_for_timeout(1200); p.click("#btnPrimary")
    p.wait_for_function("document.body.dataset.state==='result'"); p.wait_for_timeout(1500)
    check(p.evaluate("document.querySelectorAll('#cueText .hl-missed').length") >= 4, "real wordStatus: missed characters highlighted")
    check(p.evaluate("document.querySelectorAll('#cueText .hl-wrong').length") >= 1, "real wordStatus: wrong-tone character highlighted")
    check("大卫" in p.inner_text("#flagList") and "聊" in p.inner_text("#flagList"), "flag list has the merged word 大卫 and 聊")
    check(p.evaluate("document.querySelectorAll('#flagList .flag.is-missed').length") <= 4, "touching characters merged in the list")
    check("Added to Words to practise" in p.inner_text("#savedNote") and "大卫" in p.inner_text("#savedNote"), "real savedMissed -> 'Added to Words to practise' line: " + p.inner_text("#savedNote"))
    check("No tone problems" not in p.inner_text("#verdict"), "no all-clear when words are missed")
    p.click('.tab[data-view="saved"]'); p.click("#segPractise"); p.wait_for_timeout(800)
    check(p.evaluate("__coach.S.missedSupported") is True and p.evaluate("document.querySelectorAll('#practiseList .saved-item').length") >= 3, "real GET /api/words/missed lists the auto-saved words")
    row = p.inner_text("#practiseList .saved-item >> nth=0")
    check("missed" in row and "of 3" in row, "row: " + row.replace("\n", " | "))
    p.click("#practiseList .saved-item >> nth=0 >> [data-known]"); p.wait_for_timeout(600)
    check(not p.is_hidden("#practiseUndo"), "Mark known (real POST .../known 204) + Undo offered")
    p.click("#btnUndoKnown"); p.wait_for_timeout(600)
    check(p.evaluate("document.querySelectorAll('#practiseList .saved-item').length") >= 3, "Undo (real POST .../learning 204) restores")
    p.click("#btnDrillAll"); p.wait_for_function("__coach.D.state==='ready'", timeout=20000)
    check(p.inner_text("#drillWord") != "", "real GET /api/drill/next -> drill word shown: " + p.inner_text("#drillWord"))
    p.click("#btnDrillPrimary"); p.wait_for_function("__coach.D.state==='listening'"); p.wait_for_timeout(1500); p.click("#btnDrillPrimary")
    p.wait_for_function("__coach.D.state==='result' || !!__coach.D.error", timeout=30000)
    check(p.evaluate("__coach.D.error") is None and p.evaluate("__coach.D.result.needed") == 3, "real POST /api/drill/attempt SSE -> result with streak/needed: " + p.evaluate("JSON.stringify(__coach.D.result)"))
    p.screenshot(path=os.path.join(os.path.dirname(__file__), "..", "screenshots", "mobile-25-real-drill-result.png"))
    p.click("#btnDrillFinish"); p.wait_for_timeout(500)
    check(p.evaluate("__coach.D.micArmed") is False, "mic released")
    check(not errs, "no page errors " + "; ".join(errs[:2]))
    b.close()
print(f"\n{checks} checks, {len(fails)} failed"); sys.exit(1 if fails else 0)
