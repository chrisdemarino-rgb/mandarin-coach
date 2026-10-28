// Word check UI pieces shared by retell and Q&A (reused-phrase check, pure markup helpers over js/wordcheck.js).
import { esc, formatPinyin } from "./dom.js";
import { wordCheckLine, wordMark } from "../wordcheck.js";

/** <li> rows: marker + script word (+pinyin) + the sentence («you said “x”, the script has “y”» / «“y” was left out») + Save word. */
export function wordCheckRows(words, { meaningOf = () => "" } = {}) {
  return (words || []).map((w, i) => {
    const l = wordCheckLine(w), m = wordMark(w), meaning = meaningOf(w);
    return `<li class="flag wc is-${w.status}${l.hedged ? " is-hedged" : ""}"><span class="w"><span class="hl hl-${w.status}">${esc(w.text)}</span><sup class="hl-m hl-m-${w.status}" aria-hidden="true">${m.marker}</sup></span>`
      + `${w.pinyin ? `<span class="py">${esc(formatPinyin(w.pinyin))}</span>` : ""}<span class="why" lang="zh-CN">${esc(l.line)}</span><span class="sr-only">, ${esc(m.sr)}</span>`
      + `${meaning ? `<span class="cx">${esc(meaning)}</span>` : ""}<button type="button" class="btn ghost small js-save-wc" data-i="${i}" aria-label="Save word ${esc(w.text)}">Save word</button></li>`;
  }).join("");
}
/** Legend chunk explaining the word-check markers. */
export const WORD_LEGEND = '<span class="lg lg-w-sub"><span class="hl hl-substituted">word</span><sup class="hl-m">\u2194</sup> word differs from the script</span> <span class="lg lg-w-missed"><span class="hl hl-missed">word</span><sup class="hl-m">\u2212</sup> word left out</span>';
