// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import { RADIO, setGroupCurrent, setToggles, store } from "./appstore";
import { E } from "./state";
import type { Anchor, PopoverKind, PopoverState } from "../store";
export function setRadio(group: string, id: string): void { const m: Record<string, boolean> = {}; for (const other of RADIO[group] || []) m[other] = other === id; setToggles(m); setGroupCurrent(group, id); }


// ---------- tiny helpers ----------
export function esc(t: unknown): string { const d = document.createElement("span"); d.textContent = (t ?? "") as string; return d.innerHTML; }


export function toast(msg: unknown, ms = 2200): void { store.set({ toast: { id: ++E.toastN, text: String(msg), ms } }); }

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// The answer is whatever JSON (or text) the endpoint returns: callers read the fields they asked for.
export async function api(path: string, opts: RequestInit = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`${r.status} ${t || r.statusText}`); }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}

// Popovers are React components (Overlays.tsx) rendered from store.popover: an anchor rect and a kind
// (desktop-only explanation, about, share, kicad, find, grid) with the data each kind shows.
export function anchorRect(a: Element | Anchor | null | undefined): Anchor | null { if (!a) return null; if (a instanceof Element) { const r = a.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; } return a; }

export function showPopover(kind: PopoverKind, extra?: Partial<PopoverState> | null, anchor?: Element | Anchor | null): void { store.set({ popover: Object.assign({ kind, anchor: anchorRect(anchor) }, extra || {}) }); }

export function closePopover() { if (store.get().popover) store.set({ popover: null }); }

// Status-bar units (EDA_DRAW_FRAME::UpdateStatusBar); the bar formats through server/web/units.ts, this is for messages.
export const UNITS: Record<string, { name: string; f: (v: number) => number; d: number }> = { mm: { name: "mm", f: (v) => v, d: 4 }, in: { name: "in", f: (v) => v / 25.4, d: 4 }, mil: { name: "mils", f: (v) => v / 0.0254, d: 2 } };


export function fmtLen(mm: number): string { const u = UNITS[E.units]; return u.f(mm).toFixed(u.d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); }
