// On-screen audio event log. Loaded ONLY when the page URL has ?debug=1 (see app.js); otherwise this file is never fetched.
// Shows the in-memory ring buffer of audio.js (also available as window.__audioEvents): which event fired, when, and whether it was
// ours (ignored), debounced (cleared before it persisted) or REAL (caused the pause). Tap the header to collapse; Copy puts it on the clipboard.
import { audio } from "./audio-io.js";

const COLORS = { REAL: "#ff6b6b", recovered: "#7bd88f", ours: "#8aa0b8", ignored: "#8aa0b8", debounced: "#e6c35c", "debounce-start": "#e6c35c", info: "#d8dee9" };

export function initAudioDebugPanel() {
  if (document.getElementById("audioDebugPanel")) return;
  const box = document.createElement("div");
  box.id = "audioDebugPanel";
  box.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(10,14,20,.92);color:#d8dee9;font:11px/1.35 ui-monospace,Menlo,monospace;border-top:1px solid #345;padding-bottom:env(safe-area-inset-bottom)";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;gap:8px;align-items:center;padding:4px 8px;background:#16202c";
  const title = document.createElement("span"); title.style.flex = "1"; title.textContent = "audio events";
  const mk = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.style.cssText = "font:inherit;padding:2px 8px;border:1px solid #456;background:#223;color:#fff;border-radius:4px"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return b; };
  const body = document.createElement("div");
  body.style.cssText = "max-height:32vh;overflow:auto;padding:4px 8px;white-space:pre-wrap;word-break:break-word;-webkit-overflow-scrolling:touch";
  const toText = () => audio.getEvents().map((e) => `${e.t.toFixed(2)}s ${e.verdict.toUpperCase()} ${e.name}${e.detail ? " - " + e.detail : ""} [${e.state}${e.hidden ? ",hidden" : ""}${e.session ? ",as=" + e.session : ""}]`).join("\n");
  const render = () => {
    const ev = audio.getEvents().slice(-60);
    body.textContent = "";
    for (const e of ev) {
      const d = document.createElement("div"); d.style.color = COLORS[e.verdict] || COLORS.info;
      d.textContent = `${e.t.toFixed(2)}s ${e.verdict.toUpperCase()} ${e.name}${e.detail ? " - " + e.detail : ""} [${e.state}${e.hidden ? ",hidden" : ""}${e.session ? ",as=" + e.session : ""}]`;
      body.appendChild(d);
    }
    const n = audio.getEvents().filter((e) => e.verdict === "REAL").length;
    title.textContent = `audio events (${audio.getEvents().length}, ${n} REAL)`;
    body.scrollTop = body.scrollHeight;
  };
  head.append(title,
    mk("Copy", async () => { const t = toText(); try { await navigator.clipboard.writeText(t); title.textContent = "copied"; } catch { window.prompt("Copy the log:", t); } }),
    mk("Clear", () => { audio.clearEvents(); render(); }),
    mk("Hide", () => { body.style.display = body.style.display === "none" ? "" : "none"; }));
  box.append(head, body);
  document.body.appendChild(box);
  let pending = false;
  audio.on("diag", () => { if (pending) return; pending = true; setTimeout(() => { pending = false; render(); }, 120); });
  render();
}
