export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
export function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
/** Screen-reader announcement (aria-live polite region). */
export function announce(msg) {
  const l = $("#live");
  l.textContent = "";
  setTimeout(() => (l.textContent = msg), 30);
}
export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const TONE_MARKS = { a: "āáǎàa", e: "ēéěèe", i: "īíǐìi", o: "ōóǒòo", u: "ūúǔùu", ü: "ǖǘǚǜü" };
/** "ni3 hao3" -> "nǐ hǎo". Leaves already-marked pinyin untouched. */
export function formatPinyin(py) {
  if (!py) return "";
  return String(py).split(/\s+/).map((syl) => {
    const m = syl.match(/^([a-zü:v]+?)([0-5])$/i);
    if (!m) return syl;
    let base = m[1].toLowerCase().replace("u:", "ü").replace(/v/g, "ü");
    const tone = parseInt(m[2], 10);
    const t = tone === 0 ? 5 : tone;
    let idx = base.search(/[aeo]/);
    if (base.includes("ou")) idx = base.indexOf("o");
    if (idx < 0) { idx = Math.max(base.lastIndexOf("i"), base.lastIndexOf("u"), base.lastIndexOf("ü")); }
    if (idx < 0) return base;
    const ch = base[idx];
    return base.slice(0, idx) + (TONE_MARKS[ch] ? TONE_MARKS[ch][t - 1] : ch) + base.slice(idx + 1);
  }).join(" ");
}
