// symedit/ui.ts — the Symbol Editor frame's chrome pieces: its stylesheet (theme tokens only — the canvas keeps
// KiCad's colours), KiCad's toolbar / menu icons (published by ui.js as window.KiCadIconFor) and a menu bar.
import { h } from "../dialogs/dom";
import { menuMeta } from "../menuspec";

interface IconSpec { vb?: string; light?: string; dark?: string }
interface UiGlobals { KiCadIconFor?: (name: string) => IconSpec | undefined; KiCadIconsReady?: Promise<void>; KiCadUiToolbars?: Record<string, Record<string, unknown[]>> }
export const UI = (): UiGlobals => window as unknown as UiGlobals;

export const CSS = `
.se-root{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:var(--fs-sm,12px)/1.35 var(--font);}
.se-root *{box-sizing:border-box}
.se-menubar{display:flex;align-items:center;gap:2px;padding:0 6px;height:28px;overflow-x:auto;overflow-y:hidden;background:var(--panel);border-bottom:1px solid var(--line)}
.se-menubar .se-title{margin-left:auto;min-width:0;color:var(--ink-2);padding-right:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.se-mb{flex:none;padding:3px 8px;border-radius:var(--r-1,3px);cursor:default;user-select:none}
.se-mb:hover,.se-mb.open{background:var(--sel-soft)}
.se-close{margin-left:6px;flex:none}
.se-tb{flex:none;display:flex;align-items:center;gap:1px;padding:2px 4px;background:var(--panel);border-bottom:1px solid var(--line);overflow-x:auto;min-height:34px}
.se-tbv{display:flex;flex-direction:column;align-items:center;gap:1px;padding:4px 2px;background:var(--panel);overflow-y:auto}
.se-tbl{border-right:1px solid var(--line)} .se-tbr{border-left:1px solid var(--line)}
.se-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:var(--r-1,3px);background:none;color:var(--ink);padding:0;cursor:pointer;flex:none}
.se-btn:hover{background:var(--sel-soft)}
.se-btn.on{background:var(--sel-soft);border-color:var(--sel)}
.se-btn:disabled,.se-btn.dim{opacity:.38;cursor:default}
.se-sep{width:1px;height:22px;background:var(--line);margin:0 4px;flex:none}
.se-tbv .se-sep{width:22px;height:1px;margin:4px 0}
.se-tb select{height:24px;max-width:170px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-1,3px);font:inherit}
.se-ic{width:22px;height:22px;display:block}
.se-ic .dk{display:none}
:root[data-theme="dark"] .se-ic .lt{display:none} :root[data-theme="dark"] .se-ic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .se-ic .lt{display:none} :root:not([data-theme="light"]) .se-ic .dk{display:inline}}
.se-info{display:none;align-items:center;gap:10px;padding:5px 10px;background:color-mix(in srgb,var(--warn) 18%,var(--panel));border-bottom:1px solid var(--line)}
.se-info.show{display:flex}
.se-info a{color:var(--blue);cursor:pointer;text-decoration:underline}
.se-info .se-x{margin-left:auto;cursor:pointer;color:var(--ink-2)}
.se-main{flex:1;display:flex;min-height:0;min-width:0}
.se-tree{width:240px;flex:none;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);min-height:0}
.se-tree.hide,.se-props.hide{display:none}
.se-tree input{margin:6px;height:24px;padding:2px 6px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-1,3px);font:inherit}
.se-list{flex:1;overflow:auto;padding-bottom:6px}
.se-row{display:flex;align-items:center;gap:4px;padding:1px 6px;white-space:nowrap;cursor:default;user-select:none}
.se-row:hover{background:var(--sel-soft)}
.se-row.cur{background:var(--sel);color:var(--on-accent,#fff)}
.se-row .tw{width:12px;text-align:center;color:var(--ink-2);flex:none}
.se-row .ds{color:var(--ink-3);overflow:hidden;text-overflow:ellipsis}
.se-row.cur .ds{color:inherit;opacity:.8}
.se-row.lib{font-weight:600}
.se-row.ro .nm{font-style:italic}
.se-centre{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.se-tabs{display:flex;gap:1px;background:var(--panel-2,var(--panel));border-bottom:1px solid var(--line);overflow-x:auto;min-height:26px}
.se-tab{display:flex;align-items:center;gap:6px;padding:3px 10px;cursor:default;white-space:nowrap;border-right:1px solid var(--line)}
.se-tab.cur{background:var(--bg);font-weight:600}
.se-tab .x{color:var(--ink-3);cursor:pointer}
.se-canvas{position:relative;flex:1;min-height:0;overflow:hidden;outline:none}
.se-canvas canvas{position:absolute;inset:0;width:100%;height:100%}
.se-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--ink-3);pointer-events:none;text-align:center;padding:20px}
.se-props{width:220px;flex:none;background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:8px}
.se-props h4{margin:0 0 6px;font-size:var(--fs-sm,12px)}
.se-props .kv{display:grid;grid-template-columns:max-content 1fr;gap:3px 8px}
.se-props .kv span:nth-child(odd){color:var(--ink-2)}
.se-msg{flex:none;display:flex;gap:18px;padding:4px 10px;min-height:40px;max-height:64px;background:var(--panel);border-top:1px solid var(--line);overflow-x:auto}
.se-msg div{display:flex;flex-direction:column;white-space:nowrap}
.se-msg b{font-weight:400;color:var(--ink-2)}
.se-status{flex:none;display:flex;gap:16px;align-items:center;padding:2px 10px;height:24px;background:var(--panel);border-top:1px solid var(--line);color:var(--ink-2);white-space:nowrap;overflow:hidden}
.se-status select{height:20px;background:var(--panel);color:var(--ink);border:1px solid var(--line);font:inherit}
.se-menu{position:fixed;z-index:56;min-width:220px;background:var(--panel);border:1px solid var(--line);border-radius:4px;box-shadow:var(--shadow);padding:3px 0}
.se-mi{display:flex;align-items:center;gap:8px;padding:3px 12px 3px 6px;cursor:default;white-space:nowrap}
.se-mi:hover{background:var(--accent);color:var(--on-accent)}
.se-mi.dim{opacity:.45} .se-mi.dim:hover{background:none;color:inherit}
.se-mi .k{margin-left:auto;padding-left:24px;color:var(--ink-3)}
.se-mi:hover .k{color:inherit}
.se-mi .ck{width:14px;text-align:center}
.se-mi .se-ic{width:16px;height:16px}
.se-ms{height:1px;background:var(--line);margin:3px 0}
.se-checker li{margin:0 0 8px}
.se-pinprev{border:1px solid var(--line);width:100%;height:160px;display:block}
`;

let styled = false;
export function ensureStyle(): void {
  if (styled) return; styled = true;
  document.head.append(h("style", { id: "symedit-style" }, CSS));
}

const NS = "http://www.w3.org/2000/svg";
const waiting = new Set<{ el: SVGSVGElement; name: string }>();
let hooked = false;
function fill(el: SVGSVGElement, ic: IconSpec): void {
  el.setAttribute("viewBox", ic.vb || "0 0 24 24");
  el.innerHTML = `<g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g>`;
}
/** KiCad's icon `name` as an inline SVG element (filled in when the icon pack arrives). */
export function icon(name: string | null | undefined): SVGSVGElement {
  const el = document.createElementNS(NS, "svg") as SVGSVGElement; el.setAttribute("class", "se-ic"); el.setAttribute("aria-hidden", "true"); el.setAttribute("viewBox", "0 0 24 24");
  if (!name) return el;
  const g = UI(); const ic = g.KiCadIconFor ? g.KiCadIconFor(name) : undefined;
  if (ic) fill(el, ic);
  else {
    waiting.add({ el, name });
    if (!hooked && g.KiCadIconsReady) { hooked = true; g.KiCadIconsReady.then(() => { for (const w of waiting) { const i = UI().KiCadIconFor?.(w.name); if (i) fill(w.el, i); } waiting.clear(); }).catch(() => undefined); }
  }
  return el;
}

/** An action's label / tooltip / icon / hotkey (the schematic editor's table: the symbol editor's actions live there too). */
export function meta(id: string): { label: string; tip: string; icon: string | null; key: string } {
  const m = menuMeta("sch", id);
  return { label: m ? m.label : id, tip: m ? m.tip || m.label : id, icon: m ? m.icon : null, key: m && m.key ? m.key : "" };
}

export interface MenuEntry { id?: string; label?: string; sep?: boolean; sub?: MenuEntry[]; check?: () => boolean; enabled?: () => boolean; run?: () => void; icon?: string | null; key?: string }
let openMenu: HTMLElement[] = [];
export function closeMenus(): void { for (const m of openMenu) m.remove(); openMenu = []; for (const b of Array.from(document.querySelectorAll(".se-mb.open"))) b.classList.remove("open"); }
/** A dropdown (or context menu) at (x, y). */
export function showMenu(x: number, y: number, items: MenuEntry[], depth = 0): HTMLElement {
  if (depth === 0) closeMenus(); else { for (const m of openMenu.splice(depth)) m.remove(); }
  const m = h("div", { class: "se-menu", role: "menu", style: `left:${x}px;top:${y}px` });
  for (const it of items) {
    if (it.sep) { m.append(h("div", { class: "se-ms" })); continue; }
    const on = it.enabled ? it.enabled() : !!it.run || !!it.sub;
    const row = h("div", { class: "se-mi" + (on ? "" : " dim"), role: "menuitem", "data-id": it.id || undefined },
      h("span", { class: "ck" }, it.check ? (it.check() ? "✓" : "") : ""), it.icon !== undefined ? icon(it.icon) : h("span", { style: "width:16px" }), h("span", null, it.label || ""), h("span", { class: "k" }, it.sub ? "▸" : it.key || ""));
    if (!on && it.id && !it.run) row.title = "Runs in the KiCad desktop app";
    row.addEventListener("pointerenter", () => { if (it.sub) { const r = row.getBoundingClientRect(); showMenu(r.right - 2, r.top - 3, it.sub, depth + 1); } else { for (const o of openMenu.splice(depth + 1)) o.remove(); } });
    row.addEventListener("click", (ev) => { ev.stopPropagation(); if (!on || it.sub) return; closeMenus(); if (it.run) it.run(); });
    m.append(row);
  }
  document.body.append(m); openMenu[depth] = m;
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = Math.max(0, innerWidth - r.width - 4) + "px";
  if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height - 4) + "px";
  if (depth === 0) setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  return m;
}
function away(ev: Event): void {
  const t = ev.target as Element | null; if (t && t.closest && (t.closest(".se-menu") || t.closest(".se-mb"))) return;
  closeMenus(); document.removeEventListener("pointerdown", away, true);
}
