// ContextMenu.tsx — the canvas's right-click menu.  The editor decides what is in it (KiCad's
// CONDITIONAL_MENU tables, server/web/editor/ctxmenus.ts) and publishes plain rows on the store;
// this draws them the way KiCad's menus look — icon column, label, hotkey hint, check marks,
// greyed-out entries, sub-menus that open beside their row — keeps every panel inside the
// window, and owns the keyboard while it is open (↑ ↓ ← → Enter Esc).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { dispatch, useApp, type CtxItem } from "../store";
import { hasIcon } from "../ctxspec";
import { cx } from "../util";
import { KIcon } from "./Icon";

const PANEL = "ctxmenu fixed min-w-[210px] max-h-[calc(100vh-8px)] overflow-y-auto bg-panel border border-line rounded-md p-1 shadow-panel text-ink text-sm select-none";
const ROW = "group/row relative flex items-center gap-2 w-full text-left border-0 py-1 pl-1.5 pr-2 rounded-xs whitespace-nowrap";
const KBD = "ml-6 text-xs font-mono font-normal leading-[normal] text-ink-3";

type Path = number[];
const samePath = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);
const startsWith = (a: Path, prefix: Path) => prefix.length <= a.length && prefix.every((v, i) => v === a[i]);
const usable = (it: CtxItem | undefined): boolean => !!it && !it.sep && (!!it.sub || (it.run !== undefined && !it.why));
const selectable = (it: CtxItem | undefined): boolean => !!it && !it.sep;
function itemsAt(items: CtxItem[], path: Path): CtxItem[] { let cur = items; for (const i of path) cur = (cur[i] && cur[i].sub) || []; return cur; }

/**
 * Keep a panel inside the window.  The root menu opens at the click and moves up / left when it would
 * not fit; a sub-menu opens beside its row, on the other side when there is no room, and slides up.
 * Panels are position: fixed so a scrolling parent panel never clips its sub-menu.
 */
function useClamp(root: boolean, x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, m = 4;
    const fitY = (top: number) => Math.max(m, Math.min(top, vh - h - m));
    if (root) { setStyle({ left: Math.max(m, Math.min(x, vw - w - m)), top: y + h + m > vh && y - h >= m ? y - h : fitY(y) }); return; }
    const row = el.parentElement ? el.parentElement.getBoundingClientRect() : new DOMRect(x, y, 0, 0);
    const right = row.right + w + m <= vw || row.left - w < m;
    setStyle({ left: right ? Math.min(row.right - 2, vw - w - m) : row.left - w + 2, top: fitY(row.top - 5) });
  }, [root, x, y]);
  return { ref, style };
}

interface PanelProps { items: CtxItem[]; path: Path; open: Path; active: Path; x: number; y: number; onHover: (p: Path, it: CtxItem) => void; onRun: (it: CtxItem) => void }

function Panel({ items, path, open, active, x, y, onHover, onRun }: PanelProps) {
  const { ref, style } = useClamp(path.length === 0, x, y);
  const lead = items.some((it) => it.check || hasIcon(it.icon));
  return (
    <div ref={ref} className={PANEL} style={style} role="menu" data-ctxdepth={path.length}>
      {items.map((it, i) => {
        if (it.sep) return <div className="sep h-px bg-line my-1 mx-0.5" key={"s" + i} role="separator" />;
        const p = [...path, i], isActive = samePath(active, p) || (!!it.sub && startsWith(open, p)), dim = !!it.why && !it.sub;
        return (
          <div className="relative" key={i}>
            <button type="button" role={it.check ? "menuitemcheckbox" : "menuitem"} aria-checked={it.check ? !!it.checked : undefined} aria-disabled={dim || undefined} aria-haspopup={it.sub ? "menu" : undefined}
              className={cx(ROW, isActive ? (dim ? "bg-line/40 text-ink" : "bg-accent text-white") : "bg-transparent text-ink", dim ? "opacity-50 cursor-default" : "cursor-pointer")}
              title={it.why ? `${it.label} — ${it.why}` : undefined} data-ctxact={it.act || it.label} data-dim={dim ? "1" : undefined}
              onPointerEnter={() => onHover(p, it)} onClick={(ev) => { ev.stopPropagation(); if (!it.sub) onRun(it); }}>
              {lead ? (
                <span className="flex-none w-4 h-4 inline-flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4" aria-hidden="true">
                  {it.check ? (it.checked ? <svg viewBox="0 0 16 16"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null)
                    : hasIcon(it.icon) ? <KIcon name={it.icon} /> : null}
                </span>
              ) : null}
              <span className="flex-1">{it.label}</span>
              {it.key ? <kbd className={cx(KBD, isActive && !dim && "text-white")}>{it.key}</kbd> : null}
              {it.sub ? <span className="ml-4 -mr-0.5" aria-hidden="true">›</span> : null}
            </button>
            {it.sub && startsWith(open, p) ? <Panel items={it.sub} path={p} open={open} active={active} x={0} y={0} onHover={onHover} onRun={onRun} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu() {
  const menu = useApp((s) => s.contextMenu);
  const [open, setOpen] = useState<Path>([]);       // the chain of open sub-menus
  const [active, setActive] = useState<Path>([]);   // the highlighted row
  const hovered = useRef<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const id = menu ? menu.id : 0;
  useEffect(() => { setOpen([]); setActive([]); hovered.current = null; }, [id]);

  const close = useCallback(() => dispatch({ type: "contextMenu" }), []);
  const brighten = useCallback((it: CtxItem | undefined) => {
    const h = (it && it.hover) || null;
    if (h !== hovered.current) { hovered.current = h; dispatch({ type: "contextMenu", hover: h }); }
  }, []);
  const run = useCallback((it: CtxItem) => { if (it.why || it.run === undefined) return; dispatch({ type: "contextMenu", run: it.run }); }, []);
  const hover = useCallback((p: Path, it: CtxItem) => { setActive(p); setOpen(it.sub ? p : p.slice(0, -1)); brighten(it); }, [brighten]);

  useEffect(() => {
    if (!menu) return;
    const items = menu.items;
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key;
      if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return;
      ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
      const level = active.length ? active.slice(0, -1) : open, list = itemsAt(items, level), at = active.length ? active[active.length - 1] : -1;
      const step = (dir: 1 | -1) => {
        if (!list.some(selectable)) return;
        let i = at; for (let n = 0; n < list.length; n++) { i = (i + dir + list.length) % list.length; if (at < 0 && dir < 0 && n === 0) i = list.length - 1; if (selectable(list[i])) break; }
        const p = [...level, i]; setActive(p); setOpen(level); brighten(list[i]);
      };
      const enter = (it: CtxItem | undefined) => {
        if (!it || !it.sub) return false;
        const first = it.sub.findIndex(selectable); if (first < 0) return false;
        setOpen(active); setActive([...active, first]); brighten(it.sub[first]); return true;
      };
      if (k === "Escape") { if (open.length) { const up = open.slice(0, -1); setActive(open); setOpen(up); brighten(undefined); } else close(); }
      else if (k === "ArrowDown") step(1);
      else if (k === "ArrowUp") step(-1);
      else if (k === "Home") { const i = list.findIndex(selectable); if (i >= 0) setActive([...level, i]); }
      else if (k === "End") { let i = list.length - 1; while (i >= 0 && !selectable(list[i])) i--; if (i >= 0) setActive([...level, i]); }
      else if (k === "ArrowRight") enter(list[at]);
      else if (k === "ArrowLeft") { if (level.length) { setActive(level); setOpen(level.slice(0, -1)); brighten(undefined); } }
      else if (k === "Enter" || k === " ") { const it = list[at]; if (it && !enter(it) && usable(it)) run(it); }
    };
    const away = (ev: Event) => {
      if (host.current && ev.target instanceof Node && host.current.contains(ev.target)) return;
      close();
      // a left click away only dismisses the menu, as in KiCad; a right click goes on to open the next one
      if (ev instanceof PointerEvent && ev.button === 0) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }
    };
    const swallow = (ev: Event) => { if (host.current && ev.target instanceof Node && host.current.contains(ev.target)) ev.preventDefault(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    document.addEventListener("contextmenu", swallow, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("wheel", away, true);
      document.removeEventListener("contextmenu", swallow, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, open, active, close, run, brighten]);

  if (!menu) return null;
  return (
    <div ref={host} id="ctxMenu" className="fixed inset-0 z-[70] pointer-events-none [&_.ctxmenu]:pointer-events-auto" key={menu.id}>
      <Panel items={menu.items} path={[]} open={open} active={active} x={menu.x} y={menu.y} onHover={hover} onRun={run} />
    </div>
  );
}
