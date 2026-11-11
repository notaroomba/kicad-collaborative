// MenuBar.tsx — the project manager's bar on the home view and KiCad's editor menus (tables.ts MENUS, from
// eeschema/menubar.cpp / pcbnew/menubar_pcb_editor.cpp) in the editor, behaving like a native menu bar:
//
//   • a click opens a menu, hovering another title while one is open switches to it, Esc / a click elsewhere closes;
//   • sub-menus open after a short hover delay (or at once with → / Enter), and every panel is placed with
//     position: fixed inside the viewport — a sub-menu flips to the left of its parent when it would leave the
//     window, shifts up when it would run off the bottom, and a menu taller than the window scrolls;
//   • ↑ ↓ Home End move, → opens a sub-menu or goes to the next menu, ← closes it or goes to the previous menu,
//     Enter / Space run the entry, a letter jumps to the entry starting with it (a "&" mnemonic first);
//     Alt+letter opens the menu with that mnemonic, a tap on Alt focuses the bar;
//   • entries show KiCad's icon (KIcon), a checkmark when a checkable entry is on, the hotkey right-aligned;
//   • an entry the web editor lacks stays in place, dimmed, and explains that it runs in the desktop app; an
//     entry that cannot apply right now (nothing selected, nothing to undo, a view-only visitor) is greyed out.
//
// A tool-module action KiCad's menus do not place (CollabTools.<m>.actions) lands in a trailing "Other Commands"
// sub-menu of the menu it names (default Edit) rather than as a flat list.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HOME_MENUS, LINKS, MENUS, MENU_CHECKS, MODULE_ACTION_MENUS, MODULE_ALIAS, MODULE_DUPLICATES, NEEDS_SELECTION, READ_ONLY_OK, SUBMENU_ICONS, type MenuEntry } from "../tables";
import { useApp, type AppState, type Editor, type ModuleAction } from "../store";
import { iconFor, isOn, keyFor, labelFor, runUiAction, unavailable, useAvail, type Avail } from "../actions";
import { cx } from "../util";
import { AssistantToggle } from "../ai/Assistant";
import { usePluginMenus } from "../plugins/PluginUi";
import { PRODUCT_VERSION } from "../generated/product-version";
import { KIcon } from "./Icon";

// ---------------------------------------------------------------- the menu tree
interface ItemNode { kind: "item"; id: string; label?: string }
interface SubNode { kind: "sub"; title: string; mnemonic: string; nodes: MenuNode[] }
interface SepNode { kind: "sep" }
type MenuNode = ItemNode | SubNode | SepNode;
interface TopMenu { title: string; mnemonic: string; nodes: MenuNode[] }

/** "&File" → ["File", "f"]; without a marker the first letter is the mnemonic. */
function splitTitle(raw: string): [string, string] {
  const i = raw.indexOf("&");
  if (i < 0 || i === raw.length - 1) return [raw, raw.charAt(0).toLowerCase()];
  return [raw.slice(0, i) + raw.slice(i + 1), raw.charAt(i + 1).toLowerCase()];
}
function build(entries: MenuEntry[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const e of entries) {
    if (e === "-") { if (out.length && out[out.length - 1].kind !== "sep") out.push({ kind: "sep" }); continue; }
    if (Array.isArray(e)) { const [title, mnemonic] = splitTitle(e[0]); const nodes = build(e[1]); if (nodes.length) out.push({ kind: "sub", title, mnemonic, nodes }); continue; }
    const bar = e.indexOf("|");
    out.push(bar < 0 ? { kind: "item", id: e } : { kind: "item", id: e.slice(0, bar), label: e.slice(bar + 1) });
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}
function listedIds(nodes: MenuNode[], out: Set<string>): Set<string> {
  for (const n of nodes) { if (n.kind === "sub") listedIds(n.nodes, out); else if (n.kind === "item") out.add(n.id); }
  return out;
}
/** Where a module action no menu lists goes: its own `menu`, else KiCad's grouping by what the command does, else Edit. */
function menuOf(a: ModuleAction): string {
  if (a.menu) return a.menu;
  if (/drc|erc|inspect|statistic|netInspector|ratsnest|highlight|clearance|marker|simulat/i.test(a.id)) return "Inspect";
  if (/cleanup|annotat|bom\b|fieldsTable|symbolFields|update|generate|export|import|remap|rescue/i.test(a.id)) return "Tools";
  return "Edit";
}
/** The editor's menus: the static tree plus an "Other Commands" sub-menu for module actions it does not place. */
export function editorMenus(editor: Editor, moduleActions: ModuleAction[], source?: [string, MenuEntry[]][]): TopMenu[] {
  const tops = (source || MENUS[editor]).map(([raw, entries]) => { const [title, mnemonic] = splitTitle(raw); return { title, mnemonic, nodes: build(entries) }; });
  const placed = new Set<string>();
  for (const t of tops) listedIds(t.nodes, placed);
  const covered = new Set<string>(MODULE_DUPLICATES[editor]);
  for (const id of placed) covered.add(id.startsWith("module:") ? id.slice(7) : id);
  for (const [kicad, own] of Object.entries(MODULE_ALIAS[editor])) if (placed.has(kicad)) covered.add(own);
  const seen = new Set<string>();
  for (const a of moduleActions) {
    if (covered.has(a.id)) continue;
    const sig = a.label + "\u0000" + (a.key || ""); if (seen.has(sig)) continue; seen.add(sig);   // the same command under two names
    const want = menuOf(a).toLowerCase();
    const top = tops.find((t) => t.title.toLowerCase() === want && MODULE_ACTION_MENUS.includes(t.title)) || tops.find((t) => t.title === "Edit");
    if (!top) continue;
    let other = top.nodes.find((n): n is SubNode => n.kind === "sub" && n.title === "Other Commands");
    if (!other) { other = { kind: "sub", title: "Other Commands", mnemonic: "o", nodes: [] }; top.nodes.push({ kind: "sep" }, other); }
    other.nodes.push({ kind: "item", id: "module:" + a.id });
  }
  return tops;
}

// ---------------------------------------------------------------- entry state
interface Ctx { a: Avail; toggles: AppState["toggles"]; panes: AppState["panes"]; viewOnly: boolean; undo: AppState["undo"]; selCount: number; editing: boolean; inEditor: boolean }

/** Why an available entry cannot run right now (KiCad greys these out); null when it can. */
function disabledWhy(c: Ctx, id: string): string | null {
  if (!c.inEditor) return c.viewOnly && (id === "share" || id === "checkpoint") ? "View-only access" : null;
  if (id === "undo" && !c.undo.undo) return "Nothing to undo";
  if (id === "redo" && !c.undo.redo) return "Nothing to redo";
  // Plugin entries stay open to viewers: reading and exporting are theirs to do, and the plugin host refuses a viewer's writes itself.
  if (c.viewOnly && c.editing && !READ_ONLY_OK.has(id) && !id.startsWith("plugin")) return "View-only access";
  if (NEEDS_SELECTION.has(id) && c.selCount === 0) return "Nothing selected";
  return null;
}
const isCheckable = (id: string) => MENU_CHECKS.has(id);

// ---------------------------------------------------------------- panels
const PANEL = "dd fixed min-w-[230px] bg-panel border border-line rounded-md p-1 z-50 shadow-panel overflow-y-auto overflow-x-hidden";
const ROW = "mi flex items-center w-full text-left bg-transparent border-0 py-[5px] pl-1.5 pr-2.5 rounded-xs text-ink no-underline hover:no-underline cursor-default whitespace-nowrap";
const KBD = "ml-6 text-xs font-mono font-normal leading-[normal] text-ink-3";

interface PanelProps {
  nodes: MenuNode[]; depth: number; anchor: () => DOMRect | null; parentPanel: () => DOMRect | null;
  sel: number[]; open: number; c: Ctx;
  onHover: (depth: number, idx: number) => void; onEnterPanel: (depth: number) => void; onRun: (node: ItemNode, el: Element) => void; onOpenSub: (depth: number, idx: number) => void;
}

function Panel({ nodes, depth, anchor, parentPanel, sel, open, c, onHover, onEnterPanel, onRun, onOpenSub }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  // Place the panel inside the viewport: below the title for a top-level menu, beside its row for a sub-menu
  // (flipped to the left of the parent panel when it would leave the window), never past the bottom edge.
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const parentRef = useRef(parentPanel); parentRef.current = parentPanel;
  useLayoutEffect(() => {
    const el = ref.current, r = anchorRef.current(); if (!el || !r) return;
    const vw = window.innerWidth, vh = window.innerHeight, pad = 4;
    const w = el.offsetWidth, natural = el.scrollHeight + 2;   // scrollHeight: the full content, whatever max-height is in force
    let left: number, top: number;
    if (depth === 0) { left = Math.max(pad, Math.min(r.left, vw - w - pad)); top = r.bottom + 2; }
    else {
      const p = parentRef.current() || r;
      left = p.right - 3;
      if (left + w > vw - pad) left = p.left - w + 3;                 // flip to the other side of the parent
      if (left < pad) left = Math.max(pad, vw - w - pad);
      top = r.top - 5;
    }
    const h = Math.min(natural, vh - 2 * pad);
    if (top + h > vh - pad) top = depth === 0 ? top : Math.max(pad, vh - pad - h);   // a sub-menu shifts up; a top-level menu scrolls
    const maxHeight = vh - pad - top;
    setStyle({ left, top, maxHeight, visibility: "visible" });
  }, [nodes, depth]);
  // keep the highlighted row in view while the keyboard walks a scrolling menu
  const hi = sel.length > depth ? sel[depth] : -1;
  useEffect(() => {
    const el = ref.current; if (!el || hi < 0) return;
    const row = el.querySelector<HTMLElement>(`:scope > [data-idx="${hi}"]`); if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const rectOf = useCallback((idx: number) => () => { const el = ref.current; const row = el && el.querySelector(`:scope > [data-idx="${idx}"]`); return row ? row.getBoundingClientRect() : null; }, []);
  const ownRect = useCallback(() => (ref.current ? ref.current.getBoundingClientRect() : null), []);
  const openIdx = open > depth ? sel[depth] : -1;
  return (
    <div className={PANEL} ref={ref} style={style} role="menu" data-depth={depth} onMouseEnter={() => onEnterPanel(depth)} onMouseMove={(ev) => ev.stopPropagation()} onClick={(ev) => ev.stopPropagation()}>
      {nodes.map((n, i) => {
        if (n.kind === "sep") return <div className="sep h-px bg-line my-1 mx-0.5" key={"sep" + i} role="separator" />;
        const active = hi === i;
        if (n.kind === "sub") {
          const icon = SUBMENU_ICONS[n.title];
          return (
            <div key={"sub" + n.title} data-idx={i} data-sub={n.title} role="menuitem" aria-haspopup="true" aria-expanded={openIdx === i}
              className={cx(ROW, "sub", active && "bg-accent text-white")} onMouseMove={() => onHover(depth, i)} onClick={() => onOpenSub(depth, i)}>
              <span className="w-5 h-4 mr-1.5 shrink-0 flex items-center justify-center">{icon ? <KIcon name={icon} size={16} /> : null}</span>
              <span className="flex-1">{n.title}</span><span className="ml-6 text-2xs opacity-70">▶</span>
              {openIdx === i ? <Panel nodes={n.nodes} depth={depth + 1} anchor={rectOf(i)} parentPanel={ownRect} sel={sel} open={open} c={c} onHover={onHover} onEnterPanel={onEnterPanel} onRun={onRun} onOpenSub={onOpenSub} /> : null}
            </div>
          );
        }
        const id = n.id, why = unavailable(c.a, id), off = why ? null : disabledWhy(c, id);
        const checkable = isCheckable(id), on = checkable && isOn(id, c.toggles, c.panes);
        const k = keyFor(c.a, id), icon = checkable ? null : iconFor(c.a, id);
        const label = n.label || labelFor(c.a, id);
        const title = id === "undo" && c.undo.undo ? `${c.undo.undo} step${c.undo.undo === 1 ? "" : "s"}` : id === "redo" && c.undo.redo ? `${c.undo.redo} step${c.undo.redo === 1 ? "" : "s"}` : why || off || undefined;
        const body: ReactNode = (
          <>
            <span className="w-5 h-4 mr-1.5 shrink-0 flex items-center justify-center text-base leading-none" data-check={checkable ? (on ? "on" : "off") : undefined}>{on ? "✓" : icon ? <KIcon name={icon} size={16} /> : null}</span>
            <span className="flex-1">{label}</span>{k ? <kbd className={cx(KBD, active && !off && "text-white")}>{k}</kbd> : null}
          </>
        );
        const cls = cx(ROW, active && !off && "bg-accent text-white", why && "desk opacity-50", off && "off opacity-40", on && "on");
        if (LINKS[id]) return <a className={cls} key={id + i} href={LINKS[id]} target="_blank" rel="noreferrer" role="menuitem" data-idx={i} data-uiact={id} onMouseMove={() => onHover(depth, i)} onClick={(ev) => { ev.preventDefault(); onRun(n, ev.currentTarget); }}>{body}</a>;
        return (
          <button type="button" className={cls} key={id + i} role={checkable ? "menuitemcheckbox" : "menuitem"} aria-checked={checkable ? on : undefined} aria-disabled={off ? true : undefined}
            data-idx={i} data-uiact={id} title={title} tabIndex={-1} onMouseMove={() => onHover(depth, i)} onClick={(ev) => { if (!off) onRun(n, ev.currentTarget); }}>{body}</button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the bar
const SUB_DELAY = 220;   // ms a row is hovered before its sub-menu opens (or a sibling's closes)
interface Open { menu: number; sel: number[]; open: number }

export function MenuBar() {
  const a = useAvail();
  const view = useApp((s) => s.view);
  const editor = useApp((s) => s.document.editor);
  const me = useApp((s) => s.me);
  const project = useApp((s) => s.project);
  const role = useApp((s) => s.role);
  const moduleActions = useApp((s) => s.tool.moduleActions);
  const toggles = useApp((s) => s.toggles);
  const panes = useApp((s) => s.panes);
  const viewOnly = useApp((s) => s.viewOnly);
  const undo = useApp((s) => s.undo);
  const inEditor = view === "editor" && !!editor;
  const withPlugins = usePluginMenus(inEditor && editor ? MENUS[editor] : HOME_MENUS, inEditor && editor ? editor : null);   // plugin actions, importers and exporters join KiCad's menus
  const menus = useMemo<TopMenu[]>(() => (inEditor && editor ? editorMenus(editor, moduleActions, withPlugins)
    : HOME_MENUS.map(([raw, entries]) => { const [title, mnemonic] = splitTitle(raw); return { title, mnemonic, nodes: build(entries) }; })), [inEditor, editor, moduleActions, withPlugins]);

  const [st, setSt] = useState<Open | null>(null);       // the open menu, the highlighted index per depth, how many sub-menus are open
  const [focus, setFocus] = useState<number | null>(null); // a title focused from the keyboard without its menu open (Alt)
  const [selCount, setSelCount] = useState(0);
  const stRef = useRef<Open | null>(null); stRef.current = st;
  const focusRef = useRef<number | null>(null); focusRef.current = focus;
  const menusRef = useRef(menus); menusRef.current = menus;
  const barRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const hoverRef = useRef("");
  const cancelTimer = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = 0; } };

  const close = useCallback(() => { cancelTimer(); setSt(null); setFocus(null); }, []);
  const openMenu = useCallback((menu: number, first?: boolean) => {
    cancelTimer(); setFocus(null); hoverRef.current = "";
    setSelCount(window.CollabApp && window.CollabApp.selectionCount ? window.CollabApp.selectionCount() : 0);   // read as the menu opens, as KiCad evaluates its conditions
    setSt({ menu, sel: first ? [firstIdx(menusRef.current[menu].nodes, 1, -1)] : [], open: 0 });
  }, []);
  useEffect(() => { close(); }, [view, editor, close]);
  // while a menu is open (or the bar is focused) the editor's hotkeys stand down (editor/hotkeys.ts typingTarget)
  useEffect(() => { if (st || focus !== null) document.body.dataset.menuOpen = "1"; else delete document.body.dataset.menuOpen; }, [st, focus]);

  const c: Ctx = { a, toggles, panes, viewOnly, undo, selCount, editing: false, inEditor };
  const ctxFor = (menu: number): Ctx => ({ ...c, editing: inEditor && !/^(View|Preferences|Help)$/.test(menus[menu].title) });
  const cRef = useRef(c); cRef.current = c;

  /** The nodes of the panel at `depth` for an open state. */
  const nodesAt = (s: Open, depth: number): MenuNode[] => {
    let nodes = menusRef.current[s.menu].nodes;
    for (let d = 0; d < depth; d++) { const n = nodes[s.sel[d]]; if (!n || n.kind !== "sub") return []; nodes = n.nodes; }
    return nodes;
  };
  const selectable = (s: Open, depth: number, n: MenuNode | undefined): boolean => {
    if (!n || n.kind === "sep") return false;
    if (n.kind === "sub") return true;
    const cc = { ...cRef.current, editing: cRef.current.inEditor && !/^(View|Preferences|Help)$/.test(menusRef.current[s.menu].title) };
    return !!unavailable(cc.a, n.id) || !disabledWhy(cc, n.id);
  };
  function firstIdx(nodes: MenuNode[], dir: number, from: number, s?: Open, depth?: number): number {
    const n = nodes.length; if (!n) return -1;
    for (let step = 1; step <= n; step++) {
      const i = (((from + dir * step) % n) + n) % n;
      const node = nodes[i];
      if (node.kind === "sep") continue;
      if (s && depth !== undefined && !selectable(s, depth, node)) continue;
      return i;
    }
    return -1;
  }

  const run = useCallback((node: ItemNode, el: Element) => { close(); runUiAction(cRef.current.a, node.id, el); }, [close]);
  const onHover = useCallback((depth: number, idx: number) => {
    const s = stRef.current; if (!s) return;
    const hk = `${s.menu}:${depth}:${idx}`; if (hoverRef.current === hk) return; hoverRef.current = hk;   // once per row entered, however much the pointer moves inside it
    const node = nodesAt(s, depth)[idx];
    if (s.open > depth && s.sel[depth] === idx) { cancelTimer(); if (s.sel.length !== depth + 1 || s.open !== depth + 1) setSt({ ...s, sel: s.sel.slice(0, depth + 1), open: depth + 1 }); return; }   // back on the open sub-menu's own row
    if (s.open <= depth) setSt({ ...s, sel: [...s.sel.slice(0, depth), idx], open: Math.min(s.open, depth) });
    cancelTimer();
    timer.current = window.setTimeout(() => {
      timer.current = 0; const cur = stRef.current; if (!cur || cur.menu !== s.menu) return;
      setSt({ ...cur, sel: [...cur.sel.slice(0, depth), idx], open: node && node.kind === "sub" ? depth + 1 : depth });
    }, SUB_DELAY);
  }, []);
  // the pointer reached a sub-menu before the delay ran out: keep it and its parent row
  const onEnterPanel = useCallback((depth: number) => { const s = stRef.current; if (!s) return; if (depth > 0 && s.open >= depth) cancelTimer(); }, []);
  const onOpenSub = useCallback((depth: number, idx: number) => { const s = stRef.current; if (!s) return; cancelTimer(); setSt({ ...s, sel: [...s.sel.slice(0, depth), idx], open: depth + 1 }); }, []);

  // click-away and the keyboard
  useEffect(() => {
    const away = (ev: PointerEvent) => { if ((stRef.current || focusRef.current !== null) && barRef.current && !barRef.current.contains(ev.target as Node)) close(); };
    let altAlone = false;
    const typing = (ev: KeyboardEvent) => { const t = ev.target as HTMLElement | null; return !!t && !!t.tagName && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest(".kd-overlay"))); };
    const key = (ev: KeyboardEvent) => {
      const s = stRef.current, f = focusRef.current, ms = menusRef.current, k = ev.key;
      if (k === "Alt") { altAlone = !ev.repeat && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey; return; }
      altAlone = false; hoverRef.current = "";
      const eat = () => { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); };
      if (!s && f === null) {
        // Alt+letter opens the menu with that mnemonic (the Alt+C comment tool is not one of them)
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !typing(ev)) {
          const m = /^Key([A-Z])$/.exec(ev.code || ""); const letter = m ? m[1].toLowerCase() : "";
          const i = letter ? ms.findIndex((t) => t.mnemonic === letter) : -1;
          if (i >= 0) { eat(); openMenu(i, true); }
        }
        return;
      }
      if (ev.ctrlKey || ev.metaKey) return;
      if (s) {
        const depth = s.open, nodes = nodesAt(s, depth), cur = s.sel.length > depth ? s.sel[depth] : -1;
        if (k === "Escape") { eat(); if (depth > 0) setSt({ ...s, sel: s.sel.slice(0, depth), open: depth - 1 }); else close(); return; }
        if (k === "ArrowDown" || k === "ArrowUp") { eat(); cancelTimer(); const i = firstIdx(nodes, k === "ArrowDown" ? 1 : -1, cur < 0 ? (k === "ArrowDown" ? -1 : 0) : cur, s, depth); if (i >= 0) setSt({ ...s, sel: [...s.sel.slice(0, depth), i] }); return; }
        if (k === "Home" || k === "End") { eat(); const i = firstIdx(nodes, k === "Home" ? 1 : -1, k === "Home" ? -1 : 0, s, depth); if (i >= 0) setSt({ ...s, sel: [...s.sel.slice(0, depth), i] }); return; }
        const node = cur >= 0 ? nodes[cur] : undefined;
        if (k === "ArrowRight") {
          eat(); cancelTimer();
          if (node && node.kind === "sub") setSt({ ...s, sel: [...s.sel.slice(0, depth + 1), firstIdx(node.nodes, 1, -1)], open: depth + 1 });
          else openMenu((s.menu + 1) % ms.length, true);
          return;
        }
        if (k === "ArrowLeft") { eat(); cancelTimer(); if (depth > 0) setSt({ ...s, sel: s.sel.slice(0, depth), open: depth - 1 }); else openMenu((s.menu - 1 + ms.length) % ms.length, true); return; }
        if (k === "Enter" || k === " ") {
          eat(); if (!node) return;
          if (node.kind === "sub") { setSt({ ...s, sel: [...s.sel.slice(0, depth + 1), firstIdx(node.nodes, 1, -1)], open: depth + 1 }); return; }
          if (node.kind === "item" && selectable(s, depth, node)) { const el = barRef.current && barRef.current.querySelector(`[data-depth="${depth}"] > [data-idx="${cur}"]`); run(node, el || barRef.current!); }
          return;
        }
        if (k === "Tab") { eat(); return; }
        if (k.length === 1 && /\S/.test(k)) {
          // a letter: a sub-menu's "&" mnemonic, else the entries starting with it — run a single match, cycle through several
          eat(); const ch = k.toLowerCase();
          const cc = { ...cRef.current };
          const text = (n: MenuNode) => (n.kind === "sub" ? n.title : n.kind === "item" ? (n.label || labelFor(cc.a, n.id)) : "").toLowerCase();
          const hits = nodes.map((n, i) => i).filter((i) => selectable(s, depth, nodes[i]) && (text(nodes[i]).startsWith(ch) || (nodes[i].kind === "sub" && (nodes[i] as SubNode).mnemonic === ch)));
          if (!hits.length) return;
          const next = hits.find((i) => i > cur) ?? hits[0], target = nodes[next];
          if (hits.length === 1 && target.kind === "sub") setSt({ ...s, sel: [...s.sel.slice(0, depth), next, firstIdx(target.nodes, 1, -1)], open: depth + 1 });
          else if (hits.length === 1 && target.kind === "item") { const el = barRef.current && barRef.current.querySelector(`[data-depth="${depth}"] > [data-idx="${next}"]`); run(target, el || barRef.current!); }
          else setSt({ ...s, sel: [...s.sel.slice(0, depth), next] });
          return;
        }
        return;
      }
      // the bar is focused (Alt), no menu open
      if (f === null) return;
      if (k === "Escape") { eat(); close(); return; }
      if (k === "ArrowRight" || k === "ArrowLeft") { eat(); setFocus((f + (k === "ArrowRight" ? 1 : -1) + ms.length) % ms.length); return; }
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") { eat(); openMenu(f, true); return; }
      if (k.length === 1) { const i = ms.findIndex((t) => t.mnemonic === k.toLowerCase()); eat(); if (i >= 0) openMenu(i, true); else close(); return; }
      close();
    };
    const keyup = (ev: KeyboardEvent) => {
      if (ev.key !== "Alt") return;
      if (altAlone && !typing(ev)) { ev.preventDefault(); if (stRef.current || focusRef.current !== null) close(); else setFocus(0); }
      altAlone = false;
    };
    const blur = () => { altAlone = false; close(); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", keyup, true); window.removeEventListener("blur", blur); window.removeEventListener("resize", close); };
  }, [close, openMenu, run]);

  const titleRect = useCallback((i: number) => () => { const el = barRef.current && barRef.current.querySelector(`[data-menu-idx="${i}"] > button`); return el ? el.getBoundingClientRect() : null; }, []);
  const none = useCallback(() => null, []);
  const next = encodeURIComponent(location.pathname);
  const showKeys = !!st || focus !== null;
  return (
    <div id="menubar" className="flex items-center gap-0.5 px-2 bg-bench border-b border-line select-none">
      <div className="brand flex items-center gap-2 font-semibold mr-3">
        <svg className="logo w-4.5 h-4.5 block" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="5" fill="#001023" /><path d="M10.5 10.5 L21.5 21.5" stroke="#F2EDA1" strokeWidth="2.6" strokeLinecap="round" /><circle cx="10.5" cy="10.5" r="4.2" fill="#C83434" /><circle cx="21.5" cy="21.5" r="4.2" fill="#4D7FC4" /></svg>
        KiCad Collaborative <span className="ver text-xs font-mono font-normal leading-[normal] text-ink-3">{PRODUCT_VERSION}</span>
      </div>
      <div id={inEditor ? "kmenus" : "homeMenus"} className="flex gap-0.5" role="menubar" ref={barRef}>
        {menus.map((m, i) => {
          const isOpen = !!st && st.menu === i, at = m.title.toLowerCase().indexOf(m.mnemonic);
          return (
            <div className={cx("menu relative", isOpen && "open")} data-menu={m.title.toLowerCase()} data-menu-idx={i} key={m.title}>
              <button type="button" role="menuitem" aria-haspopup="true" aria-expanded={isOpen} tabIndex={-1}
                className={cx("bg-transparent border-0 py-1 px-2.5 rounded-sm text-ink hover:bg-paper hover:shadow-[inset_0_0_0_1px_var(--line)]", (isOpen || focus === i) && "bg-paper shadow-[inset_0_0_0_1px_var(--line)]")}
                onPointerDown={(ev) => { if (ev.button !== 0) return; ev.preventDefault(); if (isOpen) close(); else openMenu(i); }}
                onMouseEnter={() => { if (st && !isOpen) openMenu(i); else if (focus !== null && !st) setFocus(i); }}>
                {showKeys && at >= 0 ? <>{m.title.slice(0, at)}<u>{m.title.charAt(at)}</u>{m.title.slice(at + 1)}</> : m.title}
              </button>
              {isOpen && st ? <Panel nodes={m.nodes} depth={0} anchor={titleRect(i)} parentPanel={none} sel={st.sel} open={st.open} c={ctxFor(i)} onHover={onHover} onEnterPanel={onEnterPanel} onRun={run} onOpenSub={onOpenSub} /> : null}
            </div>
          );
        })}
      </div>
      {inEditor && project ? (
        <>
          <span className="name ml-3.5 font-semibold" id="projName">{project.name}</span>
          <span className={cx("pill", role, "ml-1.5")} id="roleChip">{role || "guest"}</span>
        </>
      ) : null}
      <div className="spacer flex-1" />
      {inEditor ? <AssistantToggle /> : null}
      <div className="user flex items-center gap-2 text-ink-2" id="userBox">
        {me ? (
          <>
            {me.avatarUrl ? <img className="w-5 h-5 rounded-full" src={me.avatarUrl} alt="" /> : null}
            <span>{me.name || me.login}</span>
            {!inEditor ? <button type="button" className="btn sm" id="logoutBtn" onClick={() => window.CollabHome?.signOut()}>Log out</button> : null}
          </>
        ) : <a className="btn sm" id="signinBtn" href={`/auth/github/login?next=${next}`}>Sign in with GitHub</a>}
      </div>
    </div>
  );
}
