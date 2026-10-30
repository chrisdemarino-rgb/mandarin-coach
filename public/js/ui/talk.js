// Free talk screen wiring: reads the controller `T` (js/talk.js), never touches audio or network itself.
// The chat list is keyed by turn id (DOM rows are kept, text is updated in place) so each user row owns ONE hear-mine instance whose button never gets rebuilt mid-playback.
import { $, esc, formatPinyin, announce, fmtTime } from "./dom.js";
import { createHearMine } from "../hear-mine.js";
import { defaultTopic } from "../api-talk.js";
import * as apiTalk from "../api-talk.js";

const STAGE = { opening: "The coach is thinking of a question…", uploading: "Uploading your turn…", transcribing: "Writing down what you said…", assessing: "Listening…", coaching: "The coach is thinking of a reply…" };

export function initTalkUI(T, S, { onLeave, onSave = () => Promise.resolve(false) }) {
  let rafId = 0, lastKey = "", topicTouched = false, pinyinOn = !!S.store.settings.showPinyin, lastSig = "", sumSig = "";
  const saved = new Set();
  const rows = new Map();   // turn id -> {li, turn, hear, ...}
  const primary = $("#btnTalkPrimary"), topicEl = $("#talkTopic"), chat = $("#talkChat");

  /* ---- topic: defaults from the script until the learner edits it ---- */
  const scriptDefault = () => defaultTopic(S.store.script && S.store.script.text);
  topicEl.addEventListener("input", () => { topicTouched = true; T.setTopic(topicEl.value); });
  function syncTopic() {
    if (!topicTouched && T.state === "idle") { const d = scriptDefault(); if (topicEl.value !== d) topicEl.value = d; T.topic = d; }
    topicEl.disabled = T.active && T.state !== "finished";
  }

  /* ---- controls ---- */
  primary.addEventListener("click", () => {
    const st = T.state;
    if (st === "idle") { T.setTopic(topicEl.value); T.start(); }   // unlock + arm run synchronously inside this tap (see talk.js)
    else if (st === "ready") (T.error && T.error.kind === "mic" ? T.errorAction() : T.record());
    else if (st === "listening") T.stop();
    else if (st === "finished") (T.unsupported ? onLeave() : T.again());
  });
  $("#btnTalkPause").addEventListener("click", () => (T.state === "paused" ? T.resume() : T.pause()));
  $("#btnTalkSkip").addEventListener("click", () => T.skipReply());
  $("#btnTalkFinish").addEventListener("click", () => T.finish());
  $("#btnTalkErrRetry").addEventListener("click", () => T.errorAction());
  $("#btnTalkErrSkip").addEventListener("click", () => T.skipTurn());
  $("#btnTalkPinyin").addEventListener("click", () => { pinyinOn = !pinyinOn; render(); });

  function primaryLabel() {
    switch (T.state) {
      case "idle": return "Start talking";
      case "ready": return T.error && T.error.kind === "mic" ? "Retry microphone" : T.userTurns.length ? "Tap to record" : "Tap to record";
      case "listening": return "Done speaking";
      case "processing": return "Thinking…";
      case "paused": return "Paused";
      case "finishing": return "Writing summary…";
      case "finished": return T.unsupported ? "Back" : "Start again";
    }
    return "Start";
  }

  /* ---- chat rows ---- */
  function makeRow(turn) {
    const li = document.createElement("li"); li.className = `turn ${turn.role}`; li.dataset.id = turn.id;
    const row = { li, turn };
    if (turn.role === "user") {
      li.innerHTML = `<div class="who">You <span class="muted">· what I heard</span></div><p class="turn-text" lang="zh-CN"></p><ul class="turn-acoustic" hidden></ul><div class="turn-actions"><button type="button" class="btn small hm" hidden>\u{1F50A} Hear my recording</button></div>`;
      row.text = li.querySelector(".turn-text"); row.acoustic = li.querySelector(".turn-acoustic");
      row.hear = createHearMine(li.querySelector(".hm"), {
        getTake: () => (row.turn.status === "ok" ? row.turn.take : null),
        blocked: () => T.state === "listening" || T.state === "processing" || T.state === "finishing" || T.coachPlaying,
      });
    } else {
      li.innerHTML = `<div class="who">Coach</div><p class="turn-text" lang="zh-CN"></p><p class="turn-py" hidden></p><div class="turn-tip" hidden></div><div class="turn-up" hidden></div><div class="turn-actions"><button type="button" class="chip replay" hidden>\u{1F50A} Hear again</button></div>`;
      row.text = li.querySelector(".turn-text"); row.py = li.querySelector(".turn-py"); row.tip = li.querySelector(".turn-tip"); row.up = li.querySelector(".turn-up"); row.srcOpen = false; row.replay = li.querySelector(".replay");
      row.replay.addEventListener("click", () => T.replay(row.turn.id));
    }
    return row;
  }
  /** Wording tip + suggested words under a coach reply. About WORDS/grammar from the transcript text, never about sound. Save word is manual only. */
  function tipHtml(t) {
    const c = t.correction, sug = t.suggested || [];
    if ((!t.tipText && !c || t.upgrade) && !sug.length) return "";
    let h = "";
    if ((t.tipText || c) && !t.upgrade) {   // with an upgrade card the comparison below says the same thing, better
      h += `<div class="tip-h">Wording tip <span class="muted">(about your words, not your pronunciation)</span></div>`;
      if (c && c.quote) h += `<p class="tip-line">You said <q lang="zh-CN">${esc(c.quote)}</q></p>`;
      if (c) h += `<p class="tip-line">Try: <b lang="zh-CN">${esc(c.betterZh)}</b>${pinyinOn && c.pinyin ? ` <span class="py">${esc(formatPinyin(c.pinyin))}</span>` : ""}</p>`;
      if (t.tipText && !c) h += `<p class="tip-line" lang="zh-CN">${esc(t.tipText)}</p>`;
    }
    if (sug.length) h += `<div class="tip-h">Words you could save</div><ul class="talk-words">${sug.map((w, i) => `<li class="sw"><span class="w" lang="zh-CN">${esc(w.text)}</span>${w.pinyin ? `<span class="py">${esc(formatPinyin(w.pinyin))}</span>` : ""}${w.meaning ? `<span class="why">${esc(w.meaning)}</span>` : ""}<button type="button" class="btn ghost small js-save-sug" data-i="${i}" aria-label="Save word ${esc(w.text)}"${saved.has(w.text) ? " disabled" : ""}>${saved.has(w.text) ? "Saved \u2713" : "Save word"}</button></li>`).join("")}</ul>`;
    return h;
  }
  /** "What you said / Could have said" card (done.upgrade). Changed phrases are marked by more than colour: <del> (strikethrough) + underline on
   *  what you said, <ins> (bold underline) on the better version, plus a text legend for screen readers. About wording only, never sound. */
  const segHtml = (segs, tag) => segs.map((g) => (g.mark ? `<${tag} class="up-m">${esc(g.text)}</${tag}>` : esc(g.text))).join("");
  function upHtml(t, row) {
    const u = t.upgrade, note = apiTalk.upgradeNoteOf(t.upgradeStatus, t.onTopic);
    if (!u) return note ? `<p class="up-note muted">${esc(note)}</p>` : "";
    const busy = ["listening", "processing", "finishing"].includes(T.state);
    const mine = T.betterTurnId === t.id, ph = mine ? T.betterPhase : "idle";
    const hearLabel = ph === "loading" ? "Loading\u2026" : ph === "playing" ? "\u25A0 Stop" : ph === "error" ? "\u{1F50A} Tap to retry" : "\u{1F50A} Hear better version";
    const saves = apiTalk.phrasesToSave(u, t.saveable);
    let h = `<div class="up-h">Could have said <span class="muted">(about your words, not your pronunciation)</span></div>`;
    h += `<div class="up-line up-said"><span class="up-lbl">What you said</span><p lang="zh-CN">${segHtml(u.saidSegs, "del")}</p></div>`;
    h += `<div class="up-line up-better"><span class="up-lbl">Could have said</span><p lang="zh-CN">${segHtml(u.betterSegs, "ins")}</p>${pinyinOn && u.betterPinyin ? `<p class="py up-py">${esc(formatPinyin(u.betterPinyin))}</p>` : ""}</div>`;
    const ch = u.changes.filter((c) => c.from || c.to);
    if (ch.length) h += `<ul class="up-changes">${ch.map((c) => `<li><span class="sr-only">Changed: </span>${c.from ? `<del lang="zh-CN">${esc(c.from)}</del>` : "<span class=\"muted\">(added)</span>"} \u2192 ${c.to ? `<ins lang="zh-CN">${esc(c.to)}</ins>` : "<span class=\"muted\">(left out)</span>"}${c.note ? ` <span class="muted">${esc(c.note)}</span>` : ""}</li>`).join("")}</ul>`;
    h += `<div class="row gap wrap up-actions"><button type="button" class="chip js-up-hear" ${busy || ph === "loading" ? "disabled" : ""} aria-pressed="${ph === "playing"}">${hearLabel}</button>`;
    if (u.sourceLines.length) h += `<button type="button" class="chip js-up-src" aria-expanded="${row.srcOpen}">${row.srcOpen ? "Hide script line" : "Show script line"}</button>`;
    h += saves.map((p, i) => { const done = saved.has(p.text); return `<button type="button" class="chip js-up-save" data-i="${i}" ${done ? "disabled" : ""}>${done ? "\u2713 Saved" : `Save phrase${saves.length > 1 || p.text !== u.better ? ` <span lang="zh-CN">${esc(p.text)}</span>` : ""}`}</button>`; }).join("");
    h += `</div>`;
    if (note) h += `<p class="up-note muted">${esc(note)}</p>`;
    if (u.sourceLines.length && row.srcOpen) h += `<div class="up-src"><div class="up-lbl">From your script</div>${u.sourceLines.map((l) => `<p lang="zh-CN">${esc(l.text)}</p>`).join("")}</div>`;
    return h;
  }
  chat.addEventListener("click", (e) => {
    const ub = e.target.closest(".js-up-hear, .js-up-src, .js-up-save");
    if (ub) {
      const row = rows.get(ub.closest("li.turn").dataset.id); if (!row || !row.turn.upgrade) return;   // buttons exist only on an 'ok' upgrade card
      if (ub.classList.contains("js-up-hear")) { T.hearBetter(row.turn.id); return; }   // synchronous call inside the tap: the player primes <audio> here
      if (ub.classList.contains("js-up-src")) { row.srcOpen = !row.srcOpen; render(); return; }
      const p = apiTalk.phrasesToSave(row.turn.upgrade, row.turn.saveable)[+ub.dataset.i]; if (!p || saved.has(p.text)) return;
      ub.disabled = true; ub.textContent = "Saving\u2026";
      Promise.resolve(onSave({ text: p.text, pinyin: p.pinyin || "", meaning: p.meaning || "", sourceChunk: p.sourceChunk }))
        .then((ok) => { if (ok) { saved.add(p.text); announce(`Saved ${p.text} to Words to practise.`); } else announce("Couldn't save that phrase. Try again."); row.upSig = ""; render(); }, () => { row.upSig = ""; render(); });
      return;
    }
    const b = e.target.closest(".js-save-sug"); if (!b) return;
    const row = rows.get(b.closest("li.turn").dataset.id), w = row && row.turn.suggested && row.turn.suggested[+b.dataset.i];
    if (!w || saved.has(w.text)) return;
    b.disabled = true;
    Promise.resolve(onSave({ text: w.text, pinyin: w.pinyin, meaning: w.meaning, sourceChunk: "" })).then((ok) => { if (ok) saved.add(w.text); render(); }, () => render());
  });
  function updateRow(row) {
    const t = row.turn, li = row.li;
    li.classList.toggle("pending", t.status === "pending");
    if (t.role === "user") {
      const waiting = t.status === "pending" && !t.text;
      row.text.textContent = t.text || (waiting ? (STAGE[T.statusStage] || "…") : "(nothing transcribed)");
      row.text.classList.toggle("muted", waiting);
      const notes = t.acoustic && t.acoustic.notes || [];   // only ever from an explicit acoustic object (api-talk.normalizeAcoustic)
      row.acoustic.hidden = !notes.length; row.acoustic.innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join("");
      row.hear.sync();
    } else {
      row.text.textContent = t.text || "…";
      const hasAudio = t.audio.some(Boolean);
      row.replay.hidden = !hasAudio; row.replay.disabled = ["listening", "processing", "finishing"].includes(T.state);
      row.replay.textContent = T.coachPlaying && T.playingTurnId === t.id ? "\u25A0 Stop" : "\u{1F50A} Hear again";
      row.py.hidden = !pinyinOn || t.status === "pending" && !t.text;
      const py = t.pinyin ? formatPinyin(t.pinyin) : "";
      row.py.textContent = py || "Pinyin isn't available for this reply.";
      row.py.classList.toggle("muted", !py);
      const html = tipHtml(t);
      row.tip.hidden = !html; if (row.tipSig !== html) { row.tipSig = html; row.tip.innerHTML = html; }
      const uh = upHtml(t, row);
      row.up.hidden = !uh; if (row.upSig !== uh) { row.upSig = uh; row.up.innerHTML = uh; }
    }
  }
  function syncChat() {
    const ids = new Set(T.turns.map((t) => t.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.li.remove(); rows.delete(id); }
    let prev = null;
    for (const t of T.turns) {
      let row = rows.get(t.id);
      if (!row) { row = makeRow(t); rows.set(t.id, row); }
      row.turn = t;
      if (row.li.previousElementSibling !== prev || row.li.parentNode !== chat) chat.insertBefore(row.li, prev ? prev.nextSibling : chat.firstChild);
      updateRow(row); prev = row.li;
    }
  }

  /* ---- summary ---- */
  function summaryHtml() {
    if (T.unsupported) return `<h2>Free talk isn't available yet</h2><p class="muted">The server doesn't have the Free talk feature yet. Nothing was recorded. Try again once the backend has it.</p>`;
    const s = T.summary, ss = T.summaryState, n = T.userTurns.length;
    const head = `<h2>Free talk summary</h2><div class="stats"><div class="stat"><b>${n}</b>turn${n === 1 ? "" : "s"} from you</div></div>`;
    if (ss === "empty" && !s) return `<h2>Free talk finished</h2><p class="muted">${n ? "There's nothing to summarise yet." : "I didn't hear anything from you, so there's no summary."}</p>`;
    if (ss === "unsupported") return `${head}<p class="muted">The summary isn't available yet (the server doesn't have it). Your conversation is above.</p>`;
    if (ss === "error") return `${head}<p class="notice" role="alert">${esc(T.summaryError)}</p><div class="row gap wrap"><button type="button" class="btn primary js-talk-sum">Try the summary again</button></div>`;
    if (!s || s.status !== "ok") return `${head}<p class="muted">The coach didn't send any takeaways this time.</p><div class="row gap wrap"><button type="button" class="btn js-talk-sum">Try the summary again</button></div>`;
    const tk = s.takeaways.length ? `<h3 class="h3">Takeaways</h3><ul class="talk-list">${s.takeaways.map((x) => `<li>${x.en ? esc(x.en) : ""}${x.zh ? ` <span class="talk-eg" lang="zh-CN">${esc(x.zh)}</span>${x.pinyin ? ` <span class="py">${esc(formatPinyin(x.pinyin))}</span>` : ""}` : ""}</li>`).join("")}</ul>` : "";
    const st = s.strengths.length ? `<h3 class="h3">What went well</h3><ul class="talk-list">${s.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    const nw = s.newWords.length ? `<h3 class="h3">New words</h3><ul class="idea-list talk-words">${s.newWords.map((w, i) => { const done = saved.has(w.text) || !!w.savedMeaning; return `<li class="sw"><span class="w" lang="zh-CN">${esc(w.text)}</span>${w.pinyin ? `<span class="py">${esc(formatPinyin(w.pinyin))}</span>` : ""}${w.meaning ? `<span class="why">${esc(w.meaning)}</span>` : ""}${w.example ? `<span class="ex" lang="zh-CN">${esc(w.example)}</span>` : ""}<button type="button" class="btn ghost small js-save-nw" data-i="${i}" aria-label="Save word ${esc(w.text)}"${done ? " disabled" : ""}>${done ? (w.savedMeaning && !saved.has(w.text) ? "Already saved" : "Saved \u2713") : "Save word"}</button></li>`; }).join("")}</ul>` : "";
    const ph = s.phrases.length ? `<h3 class="h3">Phrases to try next time</h3><ul class="talk-list talk-phrases">${s.phrases.map((p) => `<li><span class="w" lang="zh-CN">${esc(p.zh)}</span>${p.pinyin ? `<span class="py">${esc(formatPinyin(p.pinyin))}</span>` : ""}${p.en ? `<span class="why">${esc(p.en)}</span>` : ""}${p.why ? `<span class="muted">${esc(p.why)}</span>` : ""}</li>`).join("")}</ul>` : "";
    return `${head}${tk}${st}${nw}${ph}`;
  }
  $("#talkSummary").addEventListener("click", (e) => {
    if (e.target.closest(".js-talk-sum")) return T.summarize();
    const b = e.target.closest(".js-save-nw"); const w = b && T.summary && T.summary.newWords[+b.dataset.i];
    if (!w || saved.has(w.text) || w.savedMeaning) return;
    b.disabled = true;   // no double taps; the word is saved only because the learner tapped this
    Promise.resolve(onSave({ text: w.text, pinyin: w.pinyin, meaning: w.meaning, sourceChunk: "" })).then((ok) => { if (ok) saved.add(w.text); render(); }, () => render());
  });

  function render() {
    const st = T.state, err = T.error;
    syncTopic();
    $("#talkIntro").hidden = st !== "idle";
    $("#talkChatWrap").hidden = !T.turns.length && st === "idle";
    $("#talkTopicShown").textContent = T.topic || "(none)";
    chat.dataset.pinyin = pinyinOn ? "1" : "";
    $("#btnTalkPinyin").setAttribute("aria-pressed", pinyinOn ? "true" : "false");
    syncChat();

    if (st !== "finished") sumSig = "";
    const kind = ["ready", "listening", "processing", "paused", "finishing"].includes(st) ? st : "";
    const sp = $("#talkStatus"); sp.hidden = !kind; sp.dataset.kind = kind;
    document.querySelectorAll("#talkStatus .st").forEach((el) => (el.hidden = !el.classList.contains("st-" + kind)));
    $("#talkProcTitle").textContent = STAGE[T.statusStage] || "Listening to your turn…";
    $("#talkReadyHint").textContent = T.userTurns.length ? "Tap Record and reply, then tap Done." : T.topic ? `Say a sentence or two about “${T.topic}”, then tap Done.` : "Say a sentence or two, then tap Done.";
    const nt = $("#talkNotice"); nt.hidden = !T.notice; nt.textContent = T.notice || "";
    const showErr = !!err && st === "ready";
    $("#talkError").hidden = !showErr;
    if (showErr) {
      $("#talkErrorText").textContent = err.message;
      const retry = $("#btnTalkErrRetry");
      retry.textContent = err.action === "reupload" ? "Try again (re-send)" : err.action === "resume" ? "Retry microphone" : "Record again";
      $("#btnTalkErrSkip").hidden = err.canSkip === false || !err.turnId;
    }
    const sum = $("#talkSummary"); sum.hidden = st !== "finished";
    if (st === "finished") { const h = summaryHtml(); if (sumSig !== h) { sumSig = h; sum.innerHTML = h; } }

    primary.textContent = primaryLabel();
    primary.disabled = ["processing", "paused", "finishing"].includes(st);
    primary.classList.toggle("recording", st === "listening");
    $("#btnTalkPause").textContent = st === "paused" ? "Resume" : "Pause";
    $("#btnTalkPause").disabled = !["ready", "listening", "paused"].includes(st);
    $("#btnTalkSkip").disabled = !T.coachPlaying;
    $("#btnTalkFinish").disabled = !T.active || st === "finishing";

    const key = st + (err ? "!" : "") + T.turns.length;
    if (key !== lastKey) {
      lastKey = key;
      const msg = { ready: "Your turn. Tap record.", listening: "Recording. Speak now.", processing: "Listening to your turn", paused: "Paused", finishing: "Writing your summary", finished: "Free talk finished" }[st];
      if (msg) announce(msg);
      if (err) announce(err.message);
      const last = T.turns[T.turns.length - 1];
      if (last && last.role === "coach" && last.text && last.status === "ok") announce(`Coach: ${last.text}`);
    }
    const sig = `${T.turns.map((t) => t.id + ":" + t.text.length).join(",")}|${st}`;
    if (sig !== lastSig) { lastSig = sig; requestAnimationFrame(() => { const sc = $("#talkScroll"); if (sc) sc.scrollTo({ top: st === "finished" && !sum.hidden ? Math.max(0, sum.offsetTop - 8) : sc.scrollHeight }); }); }
    if (st === "listening" && !rafId) rafId = requestAnimationFrame(tick);
  }
  function tick() { rafId = 0; if (T.state !== "listening") return; $("#talkTimer").textContent = fmtTime(performance.now() - T.recStart); rafId = requestAnimationFrame(tick); }
  T.subscribe(render);
  S.subscribe && S.subscribe(render);
  render();
  return { render };
}
