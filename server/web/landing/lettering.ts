// Headings in KiCad's own stroke font (Newstroke, the lettering on every KiCad sheet and board),
// drawn from the editor's glyph table as one SVG path per heading.  The heading's text stays in the
// page for readers and search; without script it simply shows in the page font.

import { K } from "./demo";

interface Glyph { adv: number; strokes: number[][] }
const glyph = (ch: string): Glyph => {
  const api = K as unknown as { strokeGlyph(cp: number): Glyph | null };
  return api.strokeGlyph(ch.codePointAt(0) as number) || api.strokeGlyph(63) as Glyph;
};
const widthOf = (s: string): number => { let w = 0; for (const ch of s) w += glyph(ch).adv; return w; };

function letter(el: HTMLElement): void {
  const text = el.dataset.text || (el.dataset.text = (el.textContent || "").trim().replace(/\s+/g, " "));
  const size = parseFloat(getComputedStyle(el).fontSize) * 0.78, room = el.clientWidth;
  if (!room || !size) return;
  if (el.dataset.at === room + ":" + size) return;
  el.dataset.at = room + ":" + size;
  const lines: string[] = []; let cur = "";
  for (const word of text.split(" ")) {
    const next = cur ? cur + " " + word : word;
    if (cur && widthOf(next) * size > room) { lines.push(cur); cur = word; } else cur = next;
  }
  if (cur) lines.push(cur);
  const lead = size * 1.6, pen = Math.max(1.4, size * (el.tagName === "H1" ? 0.15 : 0.14)), pad = pen / 2 + 1;
  let d = "", wide = 0;
  lines.forEach((line, li) => {
    let x = pad; const y = pad + size + li * lead;
    for (const ch of line) {
      const g = glyph(ch);
      for (const st of g.strokes) for (let i = 0; i + 1 < st.length; i += 2) d += (i ? "L" : "M") + (x + st[i] * size).toFixed(1) + " " + (y + st[i + 1] * size).toFixed(1);
      x += g.adv * size;
    }
    wide = Math.max(wide, x);
  });
  const w = Math.ceil(wide + pad), h = Math.ceil(pad * 2 + size * 1.32 + (lines.length - 1) * lead);
  el.innerHTML = `<span class="t"></span><svg aria-hidden="true" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" stroke-width="${pen.toFixed(2)}"/></svg>`;
  (el.firstChild as HTMLElement).textContent = text;
  el.classList.add("lettered");
}

export function startLettering(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-stroke]"));
  const all = () => els.forEach(letter);
  all();
  window.addEventListener("resize", all);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(all).catch(() => undefined);
}
