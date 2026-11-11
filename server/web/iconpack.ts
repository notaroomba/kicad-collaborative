// iconpack.ts — the KiCad icons only menus and context menus draw (static/dist/kicad-icons.json, written by
// scripts/gen-icon-pack.js at build time).  They are not inlined in ui.js: the file is fetched once, as soon as
// the bundle starts (with the page's ?v= cache-buster, so a long-lived cache is safe), and is in long before
// anyone can open a menu.  KIcon subscribes, so a menu opened in the first instant still fills in on arrival.
import { useSyncExternalStore } from "react";
import type { IconSpec } from "./spec";

let pack: Record<string, IconSpec> | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function version(): string {
  const s = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/ui.js"]');
  const m = s ? /[?&]v=([^&]+)/.exec(s.src) : null;
  return m ? "?v=" + m[1] : "";
}

/** Start (once) fetching the icon pack; resolves when it is in (or failed: menus then draw no icon). */
export function loadIconPack(): Promise<void> {
  if (pending) return pending;
  if (typeof fetch !== "function" || typeof document === "undefined") { pack = {}; return (pending = Promise.resolve()); }
  pending = fetch("/static/dist/kicad-icons.json" + version(), { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { icons: {} }))
    .then((j: { icons?: Record<string, IconSpec> }) => { pack = j.icons || {}; })
    .catch(() => { pack = {}; })
    .then(() => { for (const fn of listeners) fn(); });
  return pending;
}

/** An icon from the pack, or undefined (not in it, or not loaded yet). */
export function packIcon(name: string): IconSpec | undefined { return pack ? pack[name] : undefined; }
/** true once the pack has arrived (or failed). */
export function packReady(): boolean { return pack !== null; }

function subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** React: re-render when the pack arrives. */
export function useIconPack(): boolean { return useSyncExternalStore(subscribe, packReady, packReady); }
