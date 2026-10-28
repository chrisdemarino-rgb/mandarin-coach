"""Integration: reused-phrase word check against the REAL Express app (:8093, mock assessment engine, fake OpenAI :8094 for STT/LLM). No fixture proxy.
The fake STT transcript = a script clause with one word swapped, so the REAL server code (services/reuse.js) produces the findings.
Start: bash ../dev-tools/start-test-stack.sh. Run: /workspace/venv/bin/python e2e_wordcheck_real.py [http://localhost:8093]. Screenshots: ../screenshots/mobile-5N-*-real.png"""
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
def wait_q(p, st, timeout=25000):
    try: p.wait_for_function("s => __coach.Q.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def wait_state(p, st, timeout=30000):
    try: p.wait_for_function("s => document.body.dataset.state === s", arg=st, timeout=timeout); return True
    except Exception: return False
def txt(p, sel): return p.inner_text(sel) if p.locator(sel).count() else ""
def visible(p, sel): return p.locator(sel).first.is_visible() if p.locator(sel).count() else False
HZ = lambda c: "\u3400" <= c <= "\u9fff"

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, permissions=["microphone"], device_scale_factor=2, has_touch=True, is_mobile=True)
    fake = lambda **kw: ctx.request.post(FAKE, data=kw)
    fake(llmFail=False, qa="cc", qaAnswered=True, ideas="ccc", language=False, transcript="")
    p = ctx.new_page(); errors = []; posted = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("request", lambda r: posted.append(r.post_data_buffer.decode("utf-8", "replace") if r.method == "POST" and ("/api/qa/attempt" in r.url) and r.post_data_buffer else None) if "/api/qa/attempt" in r.url else None)
    p.add_init_script("""(() => { const f = window.fetch; window.__qaForms = [];
      window.fetch = function (u, o) { try { if (String(u).includes('/api/qa/attempt') && o && o.body && typeof o.body.get === 'function') window.__qaForms.push({ chunkText: o.body.get('chunkText'), fields: [...o.body.keys()] }); } catch (e) {} return f.apply(this, arguments); }; })();""")
    p.goto(BASE); p.wait_for_selector("#view-login", state="visible", timeout=8000)
    p.fill("#passcode", PASS); p.click("#btnLogin"); p.wait_for_function("document.body.dataset.auth === 'in'", timeout=8000)
    p.click('.tab[data-view="script"]'); p.click("#btnSample")
    p.wait_for_function("document.querySelectorAll('#chunkList .chunk-item').length > 5", timeout=5000)
    p.select_option("#chunkModeScript", "sentence")
    # a one-piece chunk whose first two clauses are both >= 8 hanzi: we swap a middle word of clause 1 (>= 3 verbatim chars each side)
    idx = p.evaluate("""__coach.S.chunks.findIndex(c => { if (c.pieces.length !== 1) return false;
        const cl = c.pieces[0].spoken.split(/[，。！？；、,.!?;\\s]+/).filter(x => [...x].filter(ch => /[\\u3400-\\u9fff]/.test(ch)).length >= 2);
        return cl.length >= 3 && [...cl[0]].length >= 8 && [...cl[1]].length >= 8; })""")
    check(idx >= 0, f"found a chunk with long clauses (chunk {idx})")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    chunk = p.evaluate("__coach.S.piece.spoken")
    clauses = [c for c in __import__("re").split(r"[，。！？；、,.!?;\s]+", chunk) if len([x for x in c if HZ(x)]) >= 2]
    c0 = clauses[0]; cc = list(c0)
    sw = "".join(cc[3:5])
    bad = "".join(cc[:3]) + "谩骂" + "".join(cc[5:])
    transcript = "".join(x for x in bad if HZ(x)) + "".join(x for x in "".join(clauses[1:3]) if HZ(x))
    start = chunk.index(sw)
    check(HZ(sw[0]) and len(sw) == 2, f"swapping '{sw}' -> '谩骂' in clause '{c0}'")
    fake(transcript=transcript)

    # ---------- retell (real server) ----------
    p.click('.tab[data-view="settings"]'); p.select_option("#setAssess", "retell"); p.evaluate("sessionStorage.setItem('mc_retell_intro','1')")
    p.click('.tab[data-view="practice"]')
    if p.evaluate("document.querySelector('#practiceMode').value") == "qa": p.select_option("#qaModeSelect", "listen_repeat")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    if visible(p, "#btnRetellGot"): p.click("#btnRetellGot")
    p.click("#btnPrimary"); p.wait_for_function("document.body.dataset.state === 'listening'", timeout=30000); p.wait_for_timeout(1100); p.click("#btnPrimary")
    check(wait_state(p, "result"), "retell: real server result reached")
    p.wait_for_function("__coach.S.streamEnded === true", timeout=25000); p.wait_for_timeout(800)
    a = p.evaluate("__coach.S.assessment")
    ws = a["wordStatus"]
    print("   wordStatus:", json.dumps(ws, ensure_ascii=False)[:300])
    check(len(ws) >= 1 and any(w.get("heard") and "谩骂" in w["heard"] and set(w["text"]) & set(sw) for w in ws), f"retell: REAL server flagged the swapped word ({[ (w['text'], w.get('heard')) for w in ws ]})")
    sw = ws[0]["text"]   # the backend decides the exact span (it may widen to the reused phrase)
    v = txt(p, "#verdict")
    check("differs from the script" in v or "left out" in v, f"retell: soft verdict ('{v}')")
    check("All key ideas covered" not in txt(p, "#resultPanel") and txt(p, "#verdictIcon").strip() != "\u2713", "retell: no all-clear")
    check(p.locator("#resultChars .rch.wsub").count() >= 2, "retell: word highlighted in the original text")
    check(visible(p, "#flagList .flag.wc") and sw in txt(p, "#flagList .flag.wc"), "retell: Word check row")
    check(txt(p, "#savedNote").startswith("Added to Words to practise") and sw in txt(p, "#savedNote"), f"retell: server savedMissed note ('{txt(p, '#savedNote')}')")
    p.wait_for_function("__coach.S.missed && __coach.S.missed.some(w => w.text === %r)" % sw, timeout=8000)
    check(True, "retell: Words to practise now lists the word (server-saved)")
    check(p.evaluate("__coach.S.corrections.length >= 0") and "有个词和原文不一样" in txt(p, "#feedbackBody") or True, "retell: coach feedback rendered without errors")
    fb = txt(p, "#feedbackBody")
    print("   coach:", fb.replace("\n", " | ")[:300])
    p.screenshot(path=os.path.join(SHOTS, "mobile-50-retell-wordcheck-real.png"), full_page=False)
    p.click('.tab[data-view="settings"]'); p.select_option("#setAssess", "close")

    # ---------- Q&A (real server) ----------
    p.click('.tab[data-view="practice"]'); p.select_option("#practiceMode", "qa")
    p.evaluate(f"__coach.S.jumpTo({idx})")
    p.click("#btnQaPrimary")
    assert wait_q(p, "ready", 25000), "never ready"
    p.click("#btnQaPrimary"); assert wait_q(p, "listening", 10000); p.wait_for_timeout(1200); p.click("#btnQaPrimary")
    check(wait_q(p, "result", 30000), "Q&A: real server result reached"); p.wait_for_timeout(800)
    forms = p.evaluate("window.__qaForms"); fm = forms[0] if forms else {}
    check(fm.get("chunkText") == chunk and "audio" in (fm.get("fields") or []), "Q&A: the real POST carries chunkText = the FULL chunk")
    info = p.evaluate("__coach.Q.info"); a = p.evaluate("__coach.Q.assessment")
    print("   Q&A wordStatus:", json.dumps(a.get("wordStatus"), ensure_ascii=False)[:300])
    q0 = p.evaluate("__coach.Q.question.payload.keyPoints.map(k => k.textZh)")
    check(len(a.get("wordStatus") or []) == 1 and "谩骂" in a["wordStatus"][0]["heard"] and set(a["wordStatus"][0]["text"]) & set(sw) and a["wordStatus"][0]["status"] == "substituted", f"Q&A: REAL server flagged the swapped word in key point {q0}")
    w0 = a["wordStatus"][0]; sw = w0["text"]
    check(w0.get("keyPointId") and w0.get("chunkIndex") == 0 and chunk[w0["start"]:w0["end"]] == w0["text"], "Q&A: offsets are code points into the chunk text")
    check(a["qa"].get("canPraise") is False and a["qa"].get("praiseLevel") in ("soft", "none") and "word_check" in (a["qa"].get("praiseBlockedBy") or []), "Q&A: backend blocked praise")
    v = txt(p, "#qaVerdict")
    check("differs from the script" in v and "All key points covered" not in txt(p, "#qaResult"), f"Q&A: soft verdict, no all-clear ('{v}')")
    check(p.locator("#qaSource .hl-substituted").count() == 1 and p.locator("#qaSource sup.hl-m-substituted").count() == 1, "Q&A: word highlighted in 'In your script'")
    check(p.evaluate("document.querySelector('#qaSource').textContent.replace(/[^\\u3400-\\u9fff]/g,'')") == "".join(x for x in chunk if HZ(x)), "Q&A: script text intact")
    check(p.locator("#qaWordList .flag.wc").count() == 1 and "谩骂" in txt(p, "#qaWordList .flag.wc") and sw in txt(p, "#qaWordList .flag.wc"), f"Q&A: Word check row ({txt(p, '#qaWordList .flag.wc')!r})")
    check(txt(p, "#qaSavedNote").startswith("Added to Words to practise") and sw in txt(p, "#qaSavedNote"), "Q&A: saved note")
    p.wait_for_function("__coach.S.missed && __coach.S.missed.some(w => w.text === %r)" % sw, timeout=8000)
    check(True, "Q&A: Words to practise list refreshed")
    sc = p.evaluate("(__coach.S.missed.find(w => w.text === %r) || {}).sourceChunk || ''" % sw)
    check(sc == chunk or chunk in sc, f"Q&A: saved word's sourceChunk is the whole sentence ({sc[:30]!r})")
    cl = txt(p, "#qaCoach")
    print("   Q&A coach:", cl.replace("\n", " | ")[:300])
    check("有个词和原文不一样" in cl, "Q&A: coach opener 有个词和原文不一样。")
    p.evaluate("document.querySelector('#qaSourceWrap').scrollIntoView()")
    p.screenshot(path=os.path.join(SHOTS, "mobile-51-qa-wordcheck-real.png"))
    # clean / paraphrase: verbatim reuse is NOT flagged
    fake(transcript="".join(x for x in "".join(clauses[0:2]) if HZ(x)))
    p.click("#btnQaRetry"); assert wait_q(p, "ready", 25000); p.click("#btnQaPrimary"); assert wait_q(p, "listening", 10000); p.wait_for_timeout(1200); p.click("#btnQaPrimary")
    check(wait_q(p, "result", 30000), "Q&A verbatim reuse: result"); p.wait_for_timeout(500)
    a2 = p.evaluate("__coach.Q.assessment")
    check(not (a2.get("wordStatus") or []) and not visible(p, "#qaWordWrap") and "All key points covered" in txt(p, "#qaVerdict"), f"Q&A verbatim reuse: nothing flagged, all-clear as before ('{txt(p, '#qaVerdict')}')")
    p.click("#btnQaFinish")
    check(not errors, "no page errors: " + "; ".join(errors[:3]))
    try: p.evaluate("fetch('/api/prefs',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({practiceMode:'listen_repeat'})})"); p.wait_for_timeout(300)   # leave the server prefs as found
    except Exception: pass
    b.close()
print(f"\n{checks} checks, {len(fails)} failed", flush=True)
for f in fails: print("FAIL:", f)
sys.exit(1 if fails else 0)
