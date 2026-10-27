import { esc, formatPinyin, toast, $ } from "./dom.js";

export const savedToText = (list) => list.map((w) => [w.text, formatPinyin(w.pinyin), w.meaning || ""].join("\t")).join("\n");
export function savedToCsv(list) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return "text,pinyin,meaning,attempts,last_result,saved_at\n" + list.map((w) => [q(w.text), q(formatPinyin(w.pinyin)), q(w.meaning), q(w.attempts), q(w.lastResult), q(w.createdAt)].join(",")).join("\n");
}
const lastLabel = (r) => { if (!r) return ""; try { const o = typeof r === "string" && r.startsWith("{") ? JSON.parse(r) : r; return typeof o === "object" ? o.outcome || "" : String(o); } catch { return String(r); } };

export function initSaved(S) {
  const render = () => {
    const items = S.words;
    $("#savedCount").textContent = items.length ? `(${items.length})` : "";
    $("#savedEmpty").hidden = items.length > 0;
    const err = $("#savedError"); err.hidden = !S.wordsError; err.textContent = S.wordsError ? `${S.wordsError} Tap Refresh to retry.` : "";
    $("#savedList").innerHTML = items.map((w) => `
      <li class="saved-item" data-id="${esc(w.id)}">
        <div class="info"><div class="hz" lang="zh-CN">${esc(w.text)}</div><div class="py">${esc(formatPinyin(w.pinyin))}${w.meaning ? " · " + esc(w.meaning) : ""}${w.attempts ? ` · practised ${w.attempts}×` : ""}${lastLabel(w.lastResult) ? ` · last: ${esc(lastLabel(w.lastResult).replace(/_/g, " "))}` : ""}</div></div>
        <button type="button" class="btn danger" data-del="${esc(w.id)}" aria-label="Delete ${esc(w.text)}">Delete</button>
      </li>`).join("");
  };
  S.subscribe(render);
  $("#savedList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    await S.removeWord(b.dataset.del); toast("Deleted");
  });
  $("#btnRefreshWords").addEventListener("click", () => { S.wordsError = ""; S.loadWords(); });
  $("#btnCopyWords").addEventListener("click", async () => {
    if (!S.words.length) return toast("Nothing to copy");
    const text = savedToText(S.words);
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    toast(`Copied ${S.words.length} words`);
  });
  $("#btnExportWords").addEventListener("click", () => {
    if (!S.words.length) return toast("Nothing to export");
    const blob = new Blob(["\uFEFF" + savedToCsv(S.words)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "saved-words.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  return { render };
}
