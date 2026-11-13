// ui.tsx — the home view's small building blocks: glyphs, avatar, modal, menu, toasts.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuScroller } from "../menufit";

// ---------------------------------------------------------------- glyphs (24×24 stroke, like the editor's)
const PATHS: Record<string, string> = {
  projects: '<rect x="3.5" y="4.5" width="7" height="6.5" rx="1"/><rect x="13.5" y="4.5" width="7" height="6.5" rx="1"/><rect x="3.5" y="13.5" width="7" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="7" height="6.5" rx="1"/>',
  explore: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".8"/><circle cx="4.8" cy="12" r=".8"/><circle cx="4.8" cy="17.5" r=".8"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5"/><path d="M18 8v6M15 11h6"/>',
  edit: '<path d="M4.5 19.5l1-4L16 5l3 3L8.5 18.5z"/><path d="M14 7l3 3"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5L16.5 11M5 19.5h14"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 19.5h14"/>',
  open: '<path d="M13.5 5H19v5.5M19 5l-8 8"/><path d="M17 13.5V19H5V7h5.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5V5.5a1 1 0 00-1-1h-9a1 1 0 00-1 1v9a1 1 0 001 1h3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
  leave: '<path d="M10 4.5H5.5v15H10M15 8l4 4-4 4M19 12H9.5"/>',
  people: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.6-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><circle cx="17" cy="9.5" r="2.3"/><path d="M16.5 14.4c2.2.2 3.6 1.7 4 4.1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 11-2.3-5.4"/><path d="M19.5 4.5v5h-5"/>',
  file: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
  desktop: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  star: '<path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 102.3-5.4"/><path d="M4.5 4.5v5h5"/>',
  branch: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="8.5" r="2.2"/><path d="M7 8.2v7.6M17 10.7c0 3.3-4.5 2.6-8 4.6"/>',
  plugin: '<path d="M9 4.5a2 2 0 014 0V6h4v4h1.5a2 2 0 010 4H17v5h-4.2v-1.2a1.8 1.8 0 00-3.6 0V19H5v-4.5h1.3a2 2 0 000-4H5V6h4z"/>',
  signout: '<path d="M10 4.5H5.5v15H10M15 8l4 4-4 4M19 12H9.5"/>',
};
export function Ic({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return <svg className="hp-ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] || "" }} />;
}

// ---------------------------------------------------------------- avatar
const HUES = ["#C83434", "#4D7FC4", "#006464", "#009600", "#D19200", "#840084", "#5959C9"];
export function Avatar({ login, url, size = 22 }: { login: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (url && !broken) return <img className="hp-avatar" style={style} src={url} alt="" loading="lazy" onError={() => setBroken(true)} />;
  let h = 0; for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return <span className="hp-avatar" style={{ ...style, background: HUES[h % HUES.length] }} aria-hidden="true">{(login[0] || "?").toUpperCase()}</span>;
}

// ---------------------------------------------------------------- media
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query); const fn = () => setOn(m.matches);
    fn(); m.addEventListener("change", fn); return () => m.removeEventListener("change", fn);
  }, [query]);
  return on;
}
export const PHONE = "(max-width: 760px)";

// ---------------------------------------------------------------- toasts
export interface ToastItem { id: number; text: string; kind: "ok" | "err"; action?: { label: string; run: () => void }; out?: boolean }
let toasts: ToastItem[] = [];
let toastN = 0;
const toastSubs = new Set<() => void>();
const emitToasts = () => toastSubs.forEach((f) => f());
export function toast(text: string, opts: { kind?: "ok" | "err"; action?: ToastItem["action"]; ms?: number } = {}) {
  const item: ToastItem = { id: ++toastN, text, kind: opts.kind || "ok", action: opts.action };
  // The same message again replaces the one on screen instead of stacking under it.
  toasts = [...toasts.filter((t) => t.text !== text).slice(-2), item]; emitToasts();
  setTimeout(() => dismissToast(item), opts.ms || (opts.kind === "err" ? 5000 : opts.action ? 6000 : 2600));
}
/** A toast leaves the way it came: it fades down for a moment, then it is gone. */
function dismissToast(item: ToastItem) {
  if (item.out || !toasts.includes(item)) return;
  item.out = true; toasts = [...toasts]; emitToasts();
  setTimeout(() => { toasts = toasts.filter((t) => t !== item); emitToasts(); }, 160);
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), { kind: "err" });
export function Toasts() {
  const list = useSyncExternalStore((fn) => { toastSubs.add(fn); return () => { toastSubs.delete(fn); }; }, () => toasts, () => toasts);
  return createPortal(
    <div className="hp-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div className={"hp-toast " + t.kind + (t.out ? " out" : "")} key={t.id}>
          <span>{t.text}</span>
          {t.action ? <button type="button" disabled={t.out} onClick={() => { t.action!.run(); dismissToast(t); }}>{t.action.label}</button> : null}
        </div>
      ))}
    </div>, document.body);
}

export async function copyText(text: string, done = "Copied"): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); toast(done); return true; }
  catch {
    // Clipboard API needs a secure context and focus; fall back to the selection route.
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    toast(ok ? done : "Couldn't copy. Select the text and copy it by hand.", { kind: ok ? "ok" : "err" });
    return ok;
  }
}

// ---------------------------------------------------------------- layers
// Dialogs and menus stack (a confirm over the share dialog, a menu over a dialog).
// Only the top one answers the keyboard, so Escape closes one layer at a time.
const layers: object[] = [];
function useLayer(): () => boolean {
  const me = useRef({}).current;
  useEffect(() => { layers.push(me); return () => { const i = layers.indexOf(me); if (i >= 0) layers.splice(i, 1); }; }, [me]);
  return () => layers[layers.length - 1] === me;
}
/** True while a dialog or menu of the home UI is open: the editor leaves the keyboard alone. */
export const layerOpen = () => layers.length > 0;

// ---------------------------------------------------------------- exits
// A dialog or menu is unmounted the moment it closes (focus, the keyboard and the layer stack move
// on at once).  What stays for a few frames is a lifeless copy that fades out, kept in a closed
// shadow tree so that nothing — a selector, the keyboard, a pointer — can mistake it for the real one.
let ghostCss: CSSStyleSheet | null | undefined;
function ghostSheet(): CSSStyleSheet | null {
  if (ghostCss !== undefined) return ghostCss;
  ghostCss = null;
  try {
    let text = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try { for (const rule of Array.from(sheet.cssRules)) if (rule.type !== CSSRule.IMPORT_RULE) text += rule.cssText + "\n"; } catch { /* a sheet from elsewhere */ }
    }
    const made = new CSSStyleSheet(); made.replaceSync(text); ghostCss = made;
  } catch { /* no constructed style sheets here: things just disappear */ }
  return ghostCss;
}
function leaveGhost(node: HTMLElement | null, ms: number) {
  if (!node || !node.isConnected || document.hidden || typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const sheet = ghostSheet();
    if (!sheet) return;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true"); host.inert = true;
    host.style.cssText = `position:fixed;inset:0;z-index:${getComputedStyle(node).zIndex || 200};pointer-events:none`;
    const root = host.attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [sheet];
    const copy = node.cloneNode(true) as HTMLElement;
    copy.classList.add("closing");
    root.appendChild(copy); document.body.appendChild(host);
    // the copy shows what was on screen, scrolled to where it was
    const from = node.querySelectorAll<HTMLElement>(".hp-modal-b, .hp-menu"), to = copy.querySelectorAll<HTMLElement>(".hp-modal-b, .hp-menu");
    from.forEach((el, i) => { if (el.scrollTop && to[i]) to[i].scrollTop = el.scrollTop; });
    setTimeout(() => host.remove(), ms);
  } catch { /* an exit animation is never worth an error */ }
}

// ---------------------------------------------------------------- modal
/** A dialog: centred on a desktop, a bottom sheet on a phone.  Escape and the backdrop close it; focus is trapped inside. */
export function Modal({ title, onClose, children, footer, width = 480, busy }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  const top = useLayer();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") || el.querySelector<HTMLElement>("input, textarea, select, k-select, button:not(.hp-x)");
    (first || el).focus();
    const onKey = (ev: KeyboardEvent) => {
      if (!top()) return;
      if (ev.key === "Escape") {
        // An open suggestion list or drop-down list takes the first Escape.
        if ((ev.target as HTMLElement | null)?.closest?.("[data-popup-open]")) return;
        ev.stopPropagation(); if (!busyRef.current) close.current(); return;
      }
      if (ev.key !== "Tab") return;
      const f = Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), k-select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === a) { ev.preventDefault(); z.focus(); }
      else if (!ev.shiftKey && document.activeElement === z) { ev.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); if (prev && document.contains(prev)) prev.focus(); };
  }, []);
  useLayoutEffect(() => { const scrim = ref.current?.parentElement || null; return () => leaveGhost(scrim, 150); }, []);
  return createPortal(
    <div className="hp-scrim" onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); }}>
      <div className="hp-modal" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} style={{ "--w": width + "px" } as CSSProperties}>
        <header className="hp-modal-h">
          <h2>{title}</h2>
          <button type="button" className="hp-x hp-iconbtn" aria-label="Close" onClick={onClose} disabled={busy}><Ic name="close" /></button>
        </header>
        <div className="hp-modal-b">{children}</div>
        {footer ? <footer className="hp-modal-f">{footer}</footer> : null}
      </div>
    </div>, document.body);
}

/** "Are you sure?" with the consequence spelled out. */
export function Confirm({ title, body, action, danger, onConfirm, onClose }: {
  title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { toastError(e); setBusy(false); } };
  return (
    <Modal title={title} onClose={onClose} width={420} busy={busy}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus={danger ? true : undefined}>Cancel</button>
        <button type="button" className={"btn " + (danger ? "hp-danger" : "primary")} onClick={go} disabled={busy} data-autofocus={danger ? undefined : true}>{busy ? "Working…" : action}</button></>}>
      <div className="hp-prose">{body}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- menu
export interface MenuItem { id: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; hint?: string; run: () => void }
export type MenuEntry = MenuItem | "-";
/** A context menu: anchored to a point or an element's rect on a desktop, a bottom sheet on a phone. */
/** Where a menu opens: a point, or under a button (`right` = its right edge, `top` = its top edge, so the menu can open above it instead). */
export interface MenuAt { x: number; y: number; right?: number; top?: number }
export function Menu({ items, at, title, onClose }: { items: MenuEntry[]; at: MenuAt; title?: string; onClose: () => void }) {
  const phone = useMedia(PHONE);
  const ref = useRef<HTMLDivElement>(null);
  // Placed off-screen-invisible with opacity, not visibility: a hidden element cannot take focus.
  const [pos, setPos] = useState<CSSProperties>({ left: at.x, top: at.y, opacity: 0 });
  useLayoutEffect(() => {
    if (phone || !ref.current) return;
    const r = { width: ref.current.offsetWidth, height: ref.current.offsetHeight };   // not the bounding box: the menu is still scaling in
    let left = at.right !== undefined ? at.right - r.width : at.x;
    let top = at.y;
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
    // No room below: open above the button (or the pointer), never on top of it.
    const up = top + r.height > innerHeight - 8;
    if (up) top = Math.max(8, (at.top !== undefined ? at.top - 4 : at.y) - r.height);
    // Taller than the room it has: cut to the window and scrolled, as a native menu (web/menufit.ts).
    const maxHeight = Math.max(80, innerHeight - 8 - top);
    setPos({ left, top, maxHeight, overflowY: "auto", transformOrigin: `${up ? "bottom" : "top"} ${at.right !== undefined ? "right" : "left"}` });
    menuScroller(ref.current);
  }, [phone, at.x, at.y, at.right, at.top]);
  useLayoutEffect(() => { const scrim = ref.current?.parentElement || null; return () => leaveGhost(scrim, 110); }, []);
  const close = useRef(onClose); close.current = onClose;
  const top = useLayer();
  useEffect(() => {
    const el = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!phone) el.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true });   // a sheet opened by touch shows no focus ring
    const onKey = (ev: KeyboardEvent) => {
      if (!top()) return;
      if (ev.key === "Escape") { ev.stopPropagation(); close.current(); return; }
      if (ev.key === "Tab") { ev.preventDefault(); close.current(); return; }
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
      ev.preventDefault();
      const f = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled])"));
      const i = f.indexOf(document.activeElement as HTMLElement);
      const n = ev.key === "Home" ? 0 : ev.key === "End" ? f.length - 1 : (i + (ev.key === "ArrowDown" ? 1 : f.length - 1)) % f.length;
      f[n]?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Back to whatever opened the menu, unless the chosen item moved focus itself (a dialog, a rename box).
      const at = document.activeElement;
      if ((!at || at === document.body || el.contains(at)) && opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [phone]);
  return createPortal(
    <div className={"hp-menu-scrim" + (phone ? " sheet" : "")} onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }} onContextMenu={(ev) => { ev.preventDefault(); onClose(); }}>
      <div className="hp-menu" role="menu" ref={ref} style={phone ? undefined : pos}>
        {phone && title ? <div className="hp-menu-title">{title}</div> : null}
        {items.map((it, i) => it === "-" ? <div className="hp-menu-sep" key={"s" + i} /> : (
          <button type="button" role="menuitem" key={it.id} className={it.danger ? "danger" : undefined} disabled={it.disabled} title={it.hint}
            onMouseEnter={phone ? undefined : (ev) => ev.currentTarget.focus({ preventScroll: true })}
            onClick={() => { onClose(); it.run(); }}>
            <Ic name={it.icon || ""} /><span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>, document.body);
}

/** "3 min ago" that stays honest while the page is open. */
export function ago(iso: string | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
