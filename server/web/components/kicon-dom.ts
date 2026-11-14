// components/kicon-dom.ts — one of KiCad's icons (the web icon pack derived from resources/bitmaps_png, published by
// ui.js as window.KiCadIconFor) as a plain DOM <svg>, for the parts of the editor built without React: the light and
// dark variants follow the theme, and an icon asked for before the pack is in fills in when it arrives.
import type { IconSpec } from "../spec";

interface IconGlobals { KiCadIconFor?: (name: string) => IconSpec | undefined; KiCadIconsReady?: Promise<void> }
const G = (): IconGlobals => (typeof window === "undefined" ? {} : window as unknown as IconGlobals);
const NS = "http://www.w3.org/2000/svg";
const CSS = `
.kicon-dom .dk { display: none; }
:root[data-theme="dark"] .kicon-dom .lt { display: none; } :root[data-theme="dark"] .kicon-dom .dk { display: inline; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .kicon-dom .lt { display: none; } :root:not([data-theme="light"]) .kicon-dom .dk { display: inline; } }
`;
let styled = false;
function ensureCss(): void {
  if (styled || typeof document === "undefined") return; styled = true;
  const st = document.createElement("style"); st.id = "kicon-dom-css"; st.textContent = CSS; document.head.appendChild(st);
}
function fill(el: SVGSVGElement, ic: IconSpec): void {
  el.setAttribute("viewBox", ic.vb || "0 0 24 24");
  el.innerHTML = `<g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g>`;
  el.dataset.icon = el.dataset.want || "";
}

/** KiCad's icon `name` as an inline SVG, `size` px square. */
export function kicadIcon(name: string, size = 16): SVGSVGElement {
  ensureCss();
  const el = document.createElementNS(NS, "svg") as SVGSVGElement;
  el.setAttribute("class", "kicon-dom"); el.setAttribute("aria-hidden", "true"); el.setAttribute("width", String(size)); el.setAttribute("height", String(size));
  setKicadIcon(el, name);
  return el;
}

/** Point an icon made by kicadIcon at another of KiCad's icons (TEXT_BUTTON_URL::UpdateButtonBitmaps). */
export function setKicadIcon(el: SVGSVGElement, name: string): void {
  if (el.dataset.want === name && el.dataset.icon === name) return;
  el.dataset.want = name;
  const g = G(), ic = g.KiCadIconFor ? g.KiCadIconFor(name) : undefined;
  if (ic) { fill(el, ic); return; }
  if (g.KiCadIconsReady) void g.KiCadIconsReady.then(() => { if (el.dataset.want !== name) return; const i = G().KiCadIconFor?.(name); if (i) fill(el, i); }).catch(() => undefined);
}
