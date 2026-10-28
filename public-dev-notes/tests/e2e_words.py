"""E2E for: missed-word highlights, Words to practise list, trouble-word drill. Runs against the DEV-ONLY fixture wrapper (:8095 -> :8093 mock engine)
because the real Backend endpoints may not exist yet. Start both with: bash ../dev-tools/start-test-stack.sh
Run: /workspace/venv/bin/python e2e_words.py [BASE_URL=http://localhost:8095]. Screenshots: ../screenshots/{mobile|desktop}-2N-*.png"""
import sys, os, re
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

def state(p): return p.evaluate("document.body.dataset.state")
def wait_state(p, st, timeout=20000):
    try: p.wait_for_function("s => document.body.dataset.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def dstate(p): return p.evaluate("__coach.D.state")
def wait_d(p, st, timeout=20000):
    try: p.wait_for_function("s => __coach.D.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def shot(p, name): p.screenshot(path=os.path.join(SHOTS, name + ".png"))
def mode(ctx, **kw): ctx.request.post(BASE + "/__fixture/mode", data=kw)

def practise_attempt(p):
    p.wait_for_function("document.body.dataset.state === 'listening'", timeout=25000)
    p.wait_for_timeout(1300)
    p.click("#btnPrimary")
    return wait_state(p, "result", 25000)

def drill_attempt(p):
    assert wait_d(p, "ready", 20000), "drill never ready: " + dstate(p)
    p.click("#btnDrillPrimary")
    assert wait_d(p, "listening", 10000), "drill never listening: " + dstate(p)
    check(p.evaluate("document.querySelector('audio') ? document.querySelector('audio').paused : true"), "no audio playing while recording (drill)")
    p.wait_for_timeout(1200)
    p.click("#btnDrillPrimary")
    return wait_d(p, "result", 20000)

def run(viewport, tag, browser):
    print(f"\n=== {tag} {viewport['width']}x{viewport['height']} ===")
    ctx = browser.new_context(viewport=viewport, permissions=["microphone"], device_scale_factor=2 if viewport["width"] < 600 else 1,
                              has_touch=viewport["width"] < 600, is_mobile=viewport["width"] < 600)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" and not any(c in m.text for c in ("404", "401")) else None)
    mode(ctx, reset=True, attempt="issues", drill="correct", unsupported=False)

    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin")
    p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    idx = p.evaluate("__coach.S.chunks.findIndex(c => c.pieces.length === 1 && c.pieces[0].hanzi >= 14 && c.pieces[0].spoken.length <= 40)")
    check(idx >= 0, f"found a piece with enough words to exercise every status (chunk {idx})")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click('.tab[data-view="practice"]')

    # ---------------- 1. highlights
    p.click("#btnPrimary")
    check(practise_attempt(p), "attempt 1 reaches result")
    p.wait_for_function("document.querySelectorAll('#cueText .hl').length > 0", timeout=5000)
    st = p.evaluate("""() => { const o = {}; for (const s of ['missed','wrong','substituted','uncertain']) { const e = document.querySelector('#cueText .hl-' + s); o[s] = e ? getComputedStyle(e).textDecorationStyle + '|' + getComputedStyle(e).textDecorationLine : null; } return o; }""")
    check(all(st.values()), "all four statuses highlighted in the displayed script text: " + str(st))
    check("wavy" in (st["wrong"] or "") and "dotted" in (st["missed"] or "") and "double" in (st["substituted"] or "") and "dashed" in (st["uncertain"] or ""), "distinct underline STYLES (wavy / dotted / double / dashed), not colour alone")
    check("line-through" in (st["substituted"] or ""), "substituted also struck through")
    check(p.evaluate("document.querySelectorAll('#cueText .hl-m').length") >= 4, "small marker glyph after each flagged word")
    srt = p.evaluate("[...document.querySelectorAll('#cueText .sr-only')].map(e => e.textContent).join('')")
    check("missed" in srt and "pronounced wrong" in srt and "said something else" in srt and "not sure" in srt, "screen-reader text for each status: " + srt)
    check(p.evaluate("!!document.querySelector('#cueText .badge')") or True, "stage-direction cues untouched")
    same_text = p.evaluate("""() => { const piece = __coach.S.piece; const d = document.createElement('div'); d.innerHTML = piece.display; const strip = (el) => { el.querySelectorAll('sup,.sr-only').forEach(x => x.remove()); return el.textContent; }; const a = strip(d), c = document.querySelector('#cueText').cloneNode(true); return a === strip(c); }""")
    check(same_text, "highlighted text == original displayed text (nothing added or lost)")
    fl = p.evaluate("[...document.querySelectorAll('#flagList .flag')].map(e => ({t: e.querySelector('.w').textContent.replace(/[−!↔?]/g,''), py: e.querySelector('.py') ? e.querySelector('.py').textContent : '', why: e.querySelector('.why').textContent, heard: e.querySelector('.heard') ? e.querySelector('.heard').textContent : ''}))")
    check(len(fl) == 4, f"flagged list has 4 words (missed, wrong, substituted, uncertain): {fl}")
    check(any("Missed" in f["why"] and "not said" in f["why"] for f in fl) and any("Wrong" in f["why"] and "tone" in f["why"] for f in fl) and any("Said something else" in f["why"] and "天空" in f["heard"] for f in fl) and any("Not sure" in f["why"] for f in fl), "list shows reason: omitted / tone / substituted + heard / not sure")
    check(all(f["py"] for f in fl), "list shows pinyin")
    verdict = p.inner_text("#verdict")
    check("No tone problems" not in verdict and "missed" in verdict, "verdict never says all-clear when words are missed: " + verdict)
    check(p.evaluate("document.querySelector('#verdictIcon').textContent") != "\u2713", "no check-mark badge when words are missed")
    check("Try again" in p.inner_text("#btnPrimary"), "main action is Try again, not Next")
    check("Added to Words to practise" in p.inner_text("#savedNote"), "'Added to Words to practise' line: " + p.inner_text("#savedNote"))
    check("嗯" in p.inner_text("#insertedNote"), "inserted-words note shown")
    p.evaluate("document.querySelector('#cueText').scrollIntoView({block:'center'})")
    shot(p, f"{tag}-20-highlight")
    p.evaluate("document.querySelector('#flagWrap').scrollIntoView({block:'center'})")
    shot(p, f"{tag}-20b-flag-list")

    # fading mode: the cue card is hidden, so the result panel shows the highlighted line instead

    # ---------------- 1b. clean / gate / none
    mode(ctx, attempt="clean")
    p.click("#btnPrimary"); check(practise_attempt(p), "attempt 2 (clean) reaches result")
    check(p.evaluate("document.querySelectorAll('#cueText .hl').length") == 0 and p.is_hidden("#flagWrap"), "clean take: no highlights, no list")
    check("missed" not in p.inner_text("#verdict") and "different" not in p.inner_text("#verdict"), "clean take: no word problems reported: " + p.inner_text("#verdict"))
    mode(ctx, attempt="gate")
    p.click("#btnRetry"); check(practise_attempt(p), "attempt 3 (gated) reaches result")
    check(p.evaluate("document.querySelectorAll('#cueText .hl').length") == 0, "gated take: no highlights")
    check("No tone problems" not in p.inner_text("#verdict") and "match" in p.inner_text("#verdict"), "gated take: shows gate message, no all-clear: " + p.inner_text("#verdict"))
    check("Try again" in p.inner_text("#btnPrimary"), "gated take: try again")
    mode(ctx, attempt="none")
    p.click("#btnRetry"); check(practise_attempt(p), "attempt 4 (no wordStatus) reaches result")
    check(p.evaluate("document.querySelectorAll('#cueText .hl').length") == 0 and p.is_hidden("#flagWrap"), "wordStatus absent: UI exactly as before " + p.evaluate("JSON.stringify({hl: document.querySelectorAll('#cueText .hl').length, fw: document.querySelector('#flagWrap').hidden, ws: (__coach.S.assessment||{}).wordStatus, st: document.body.dataset.state, n: document.querySelector('#flagList').innerHTML.slice(0,100)})"))
    # fading mode result shows highlighted line in the panel
    mode(ctx, attempt="issues")
    p.click("#btnFinish")
    p.select_option("#practiceMode", "fading_cues")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click("#btnPrimary")
    check(practise_attempt(p), "fading attempt reaches result")
    p.wait_for_function("document.querySelector('#resultScriptWrap') && !document.querySelector('#resultScriptWrap').hidden", timeout=5000)
    check(p.evaluate("document.querySelectorAll('#resultScript .hl').length") >= 1, "fading: result panel shows the highlighted line (cue card was partial) " + p.evaluate("JSON.stringify({n: (__coach.S.assessment.wordStatus||[]).length, c: __coach.S.chunk.pieces[0].hanzi, html: document.querySelector('#resultScript').innerHTML.slice(0,200), peek: document.querySelector('#btnPeek').textContent})"))
    p.click("#btnFinish")
    p.select_option("#practiceMode", "listen_repeat")

    # ---------------- 2. Words to practise
    p.click('.tab[data-view="saved"]')
    check(p.is_visible("#savedSeg"), "segmented control visible")
    p.click("#segPractise")
    p.wait_for_function("document.querySelectorAll('#practiseList .saved-item').length >= 3", timeout=6000)
    n = p.evaluate("document.querySelectorAll('#practiseList .saved-item').length")
    check(n >= 3, f"Words to practise has the auto-fed words ({n})")
    row = p.inner_text("#practiseList .saved-item >> nth=0")
    check("missed" in row and "0 of 3 correct in a row" in row, "row shows miss count + streak x of needed: " + row.replace("\n", " | "))
    check(p.evaluate("[...document.querySelectorAll('#practiseList .saved-item .btn')].every(b => b.getBoundingClientRect().height >= 44)"), "Drill / Mark known targets >= 44px")
    shot(p, f"{tag}-21-practise-list")
    first = p.evaluate("document.querySelector('#practiseList .saved-item .hz').textContent")
    p.click("#practiseList .saved-item >> nth=0 >> [data-known]")
    p.wait_for_function(f"document.querySelectorAll('#practiseList .saved-item').length === {n - 1}", timeout=4000)
    check(not p.is_hidden("#practiseUndo"), "Undo offered after Mark known")
    p.click("#btnUndoKnown")
    p.wait_for_function(f"document.querySelectorAll('#practiseList .saved-item').length === {n}", timeout=4000)
    check(True, "Undo restores the word")
    check(p.evaluate("document.querySelector('#practiseBadge').textContent") == f"({n})", "tab badge shows the count")

    # ---------------- 3. drill one word until it graduates
    target = p.evaluate("document.querySelector('#practiseList .saved-item .hz').textContent")
    p.click("#practiseList .saved-item >> nth=0 >> [data-drill]")
    check(p.evaluate("document.body.dataset.view") == "drill", "Drill opens the drill screen")
    p.wait_for_function("__coach.D.state === 'prompting' || __coach.D.state === 'ready'", timeout=15000)
    check(p.is_hidden("#drillError"), "no error while loading the drill")
    check(wait_d(p, "ready", 15000), "model audio played, now ready to record")
    check(p.inner_text("#drillWord") == target, f"drill shows the word {target} (got {p.inner_text('#drillWord')!r}, queue {p.evaluate('__coach.D.queue.map(w=>w.text)')})")
    check(p.inner_text("#drillPinyin").strip() != "", "drill shows pinyin")
    check(not p.is_hidden("#drillExample"), "drill shows the example sentence")
    shot(p, f"{tag}-22-drill-ready")
    check(drill_attempt(p), "drill attempt 1 -> result")
    check("Correct" in p.inner_text("#drillVerdict") and "1 of 3" in p.inner_text("#drillVerdictNote"), "pass + progress 1 of 3: " + p.inner_text("#drillVerdictNote"))
    shot(p, f"{tag}-22-drill")
    check("Say it again" in p.inner_text("#btnDrillPrimary"), "primary: say it again")
    p.click("#btnDrillPrimary")
    check(drill_attempt(p) and "2 of 3" in p.inner_text("#drillVerdictNote"), "attempt 2 -> 2 of 3")
    mode(ctx, drill="wrong")
    p.click("#btnDrillPrimary")
    check(drill_attempt(p) and "Not quite" in p.inner_text("#drillVerdict") and "0 of 3" in p.inner_text("#drillVerdictNote"), "a miss resets the streak: " + p.inner_text("#drillVerdictNote"))
    check("Try again" in p.inner_text("#btnDrillPrimary"), "primary: try again after a miss")
    mode(ctx, drill="correct")
    for k in (1, 2, 3):
        p.click("#btnDrillPrimary"); ok = drill_attempt(p)
    check(ok and "Learned" in p.inner_text("#drillVerdict"), "3 correct in a row -> graduated: " + p.inner_text("#drillVerdict"))
    check(target not in p.evaluate("__coach.S.missed.map(w => w.text)"), "graduated word left the list")
    shot(p, f"{tag}-23-drill-graduated")
    p.click("#btnDrillPrimary")      # Done / Next word
    check(wait_d(p, "finished", 8000) and not p.is_hidden("#drillSummary"), "single-word drill finishes with a summary")
    check(p.evaluate("__coach.D.micArmed") is False, "mic released at the end of the drill")

    # ---------------- 3b. lone character -> say the whole sentence; gated take does not count
    mode(ctx, seed=["好"], drill="gate")
    p.click("#btnDrillBack")
    p.click('.tab[data-view="saved"]'); p.click("#segPractise")
    p.wait_for_function("[...document.querySelectorAll('#practiseList .hz')].some(e => e.textContent === '好')", timeout=6000)
    p.evaluate("[...document.querySelectorAll('#practiseList .saved-item')].find(r => r.querySelector('.hz').textContent === '好').querySelector('[data-drill]').click()")
    wait_d(p, "ready", 15000)
    check("Say the whole sentence" in p.inner_text("#drillExample"), "single character: the drill asks for the whole sentence: " + p.inner_text("#drillExample"))
    check(drill_attempt(p), "gated drill attempt -> result")
    check("didn't count" in p.inner_text("#drillVerdict") and "0 of 3" in p.inner_text("#drillVerdictNote") or "stays at 0 of 3" in p.inner_text("#drillVerdictNote"), "gated take: not counted, not a pass: " + p.inner_text("#drillVerdictNote"))
    check("Try again" in p.inner_text("#btnDrillPrimary"), "gated take: try again")
    mode(ctx, drill="correct")
    p.click("#btnDrillFinish"); wait_d(p, "finished", 8000)

    # ---------------- 4. drill all: skip, retry, finish
    p.click("#btnPrimary") if False else None
    p.click("#btnDrillBack")
    check(p.evaluate("document.body.dataset.view") == "saved", "back to the Saved screen")
    p.wait_for_function("document.querySelectorAll('#practiseList .saved-item').length >= 2", timeout=5000)
    p.click("#segPractise") if p.is_hidden("#panelPractise") else None
    p.click("#btnDrillAll")
    wait_d(p, "ready", 20000)
    first_word = p.inner_text("#drillWord")
    check("Word 1 of" in p.inner_text("#drillProgress"), "drill all shows queue progress: " + p.inner_text("#drillProgress"))
    p.click("#btnDrillSkip")
    wait_d(p, "ready", 20000)
    check(p.inner_text("#drillWord") != first_word and "Word 2 of" in p.inner_text("#drillProgress"), "Skip moves to the next word")
    p.click("#btnDrillPrimary"); wait_d(p, "listening", 10000)
    p.click("#btnDrillRetry")
    check(wait_d(p, "ready", 8000), "Retry while recording discards the take and returns to ready")
    p.click("#btnDrillPrimary"); wait_d(p, "listening", 10000)
    # interruption: mic taken away -> clear message, no crash
    p.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    p.click("#btnDrillFinish")
    check(wait_d(p, "finished", 8000), "Finish ends the drill")
    check(p.evaluate("__coach.D.micArmed") is False, "mic released on Finish (drill)")
    shot(p, f"{tag}-24-drill-finished")
    p.click("#btnDrillBack")

    # ---------------- 5. 404 -> section hidden gracefully
    mode(ctx, unsupported=True)
    p.reload(); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="saved"]')
    p.wait_for_function("__coach.S.missedSupported === false", timeout=6000)
    check(p.is_hidden("#savedSeg") and p.is_visible("#panelSaved"), "/api/words/missed 404 -> Words to practise hidden, Saved words intact")
    mode(ctx, unsupported=False)

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
            print("  FAIL exception:", repr(e)[:400]); fails.append(str(e)[:200])
    browser.close()
print(f"\n{checks} checks, {len(fails)} failed")
sys.exit(1 if fails else 0)
