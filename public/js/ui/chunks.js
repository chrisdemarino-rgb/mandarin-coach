import { $, esc } from "./dom.js";

export function renderChunkList(S, onPick) {
  const list = $("#chunkList");
  const p = S.parsed;
  $("#chunkSummary").textContent = S.chunks.length ? `(${S.chunks.length} chunks · ${p.sentences.length} sentences · ${p.paragraphCount} paragraphs)` : "";
  if (!S.chunks.length) { list.innerHTML = `<li class="muted">Paste a script to see its chunks here.</li>`; return; }
  list.innerHTML = S.chunks.map((c, i) => `
    <li><button type="button" class="chunk-item" data-i="${i}" ${i === S.chunkIdx ? 'aria-current="true"' : ""}>
      <span class="n">${i + 1}${S.stats.doneChunks.has(c.id) ? ' <span class="done" aria-label="done">\u2713</span>' : ""}</span>
      <span class="t" lang="zh-CN">${c.display}</span>
      <span class="len">${c.hanzi}字${c.pieces.length > 1 ? ` · ${c.pieces.length} parts` : ""}</span>
    </button></li>`).join("");
  list.onclick = (e) => { const b = e.target.closest(".chunk-item"); if (b) onPick(+b.dataset.i); };
  const cur = list.querySelector('[aria-current="true"]');
  if (cur) {
    const top = cur.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - 8);
  }
}
