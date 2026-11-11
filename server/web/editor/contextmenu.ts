// contextmenu.ts — the right-click menu: KiCad's selection rule, the menu for the active tool
// (ctxmenus.ts), and what each entry does here.
//
// The editor resolves every entry to a plain row (label, icon name, hotkey hint, check mark and
// either a run token or the reason it is dimmed) and publishes the tree on the store; the React
// ContextMenu component renders it and answers with dispatch({ type: "contextMenu", run }).
import { actions as CTX_ACTIONS } from "../generated/kicad-context-spec.json";
import type { AppAction, CtxItem, Editor } from "../store";
import { toolFor } from "../tables";
import { HANDLERS } from "./actions";
import { APP_TOOLS, state, store } from "./appstore";
import { enterSheet, rootSchematic, setGridPitch } from "./doc";
import { evaluate, GRID_ORIGIN, menuFor, type MenuCtx, type MenuDef, type Resolved } from "./ctxmenus";
import { activeModuleTool, clearAllSelection, hitsAt, interactionBusy, pcbState, pickAt, schState, selectAt, selectionBox, selectionChanged, selectionIds, selectionItems, selectItemId, stage, startMove, toolCtx, worldMm, zoomBy } from "./gestures";
import { E } from "./state";
import { activeModule, deleteSelection, moduleTool, runModuleAction, selectAll, setTool } from "./tools";
import { isSch, requestRender } from "./view";

type Mm = [number, number];
type Run = () => void;
interface Meta { id: string; label: string; tip: string | null; icon: string | null; key: string | null }
const META = CTX_ACTIONS as unknown as Record<string, Meta>;

// KiCad's zoom presets (include/zoom_defines.h ZOOM_LIST_EESCHEMA / ZOOM_LIST_PCBNEW)
const ZOOM_LIST: Record<Editor, number[]> = {
  sch: [0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.5, 6.5, 10, 15, 20, 30, 45, 65, 100],
  pcb: [0.13, 0.22, 0.35, 0.6, 1.0, 1.5, 2.2, 3.5, 5.0, 8.0, 13.0, 20.0, 35.0, 50.0, 80.0, 130.0, 220.0, 300.0],
};

const DESKTOP = "runs in the desktop app";
const NOT_YET = "not available in the web editor yet";
const VIEW_ONLY = "view-only access";

// ---------------------------------------------------------------- the menu's view of the editor
const editor = (): Editor => (isSch() ? "sch" : "pcb");
const ptsCount = (node: SNode): number => { const p = KiCadCanvas.kid(node, "pts"); return p ? KiCadCanvas.kids(p, "xy").length : 0; };
/** The kind a SELECTION_CONDITION sees: a two-point graphic polyline is KiCad's SCH_LINE on the notes layer. */
function kindOf(it: KItem): string { return it.docType === "sch" && it.kind === "polyline" && ptsCount(it.node) === 2 ? "gline" : it.kind; }
const isLocked = (node: SNode): boolean => { const l = KiCadCanvas.kid(node, "locked"); return node.includes("locked") || (!!l && KiCadCanvas.str(l[1]) !== "no"); };
const flag = (node: SNode, key: string): string => { const k = KiCadCanvas.kid(node, key); return k ? KiCadCanvas.str(k[1]) : ""; };
const attrHas = (node: SNode, word: string): boolean => { const a = KiCadCanvas.kid(node, "attr"); return !!a && a.includes(word); };

function attributeChecks(items: KItem[]): Record<string, boolean> {
  const some = (f: (n: SNode) => boolean) => items.length > 0 && items.every((it) => f(it.node));
  if (isSch()) return {
    "SCH_ACTIONS::setDNP": some((n) => flag(n, "dnp") === "yes"),
    "SCH_ACTIONS::setExcludeFromBOM": some((n) => flag(n, "in_bom") === "no"),
    "SCH_ACTIONS::setExcludeFromBoard": some((n) => flag(n, "on_board") === "no"),
    "SCH_ACTIONS::setExcludeFromSim": some((n) => flag(n, "exclude_from_sim") === "yes"),
    "SCH_ACTIONS::setExcludeFromPosFiles": some((n) => flag(n, "in_pos_files") === "no"),
  };
  return {
    "PCB_ACTIONS::toggleExcludeFromBOM": some((n) => attrHas(n, "exclude_from_bom")),
    "PCB_ACTIONS::toggleExcludeFromPosFiles": some((n) => attrHas(n, "exclude_from_pos_files")),
    "PCB_ACTIONS::toggleExcludeFromSim": some((n) => attrHas(n, "exclude_from_sim")),
  };
}

function menuCtx(): MenuCtx {
  const items = selectionItems(), s = schState(), p = pcbState(), sch = isSch();
  const kinds = items.map(kindOf); if (E.selField && !kinds.length) kinds.push("field");
  const draw = sch ? (s && s.draw) : (p && p.draw);
  const n = draw && Array.isArray(draw.pts) ? draw.pts.length : 0;
  const outline = !!draw && (sch ? draw.shape === "polygon" || draw.shape === "rulearea" : ["gpoly", "zone", "rulearea"].includes(draw.shape));
  const drawingLine = sch && !!s && (!!s.wire || (!!s.draw && s.draw.shape === "lines"));
  const routing = !sch && !!p && !!p.route;
  const root = sch ? rootSchematic() : null;
  return {
    editor: editor(), kinds, tool: E.tool, drawingLine, routing,
    busy: interactionBusy() || drawingLine || routing || !!draw || (sch && !!s && !!s.carry),
    canClose: outline && n >= 3, canUndoPoint: (outline || (!!draw && (draw.shape === "lines" || draw.shape === "gcurve"))) && n >= 1,
    highlight: !!E.highlightIds, belowRoot: !!root && (state as { doc?: unknown }).doc !== root,
    hasLocked: items.some((it) => isLocked(it.node)), hasUnlocked: items.some((it) => !isLocked(it.node)),
    hasItems: !!E.kdoc && E.kdoc.items.size > 0, checks: attributeChecks(items),
  };
}

// ---------------------------------------------------------------- what an entry does
const moduleKey = (key: string): Run => () => { const m = activeModule(); if (m && m.onKey) { try { m.onKey(key, {}, toolCtx()); } catch (e) { console.warn(e); } requestRender(); } };
const escape: Run = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); };

function openProperties(): void {
  const d = E.kdoc as KDoc | null, K = window.KDialogs; if (!d || !K) return;
  if (E.selField) { const it = d.items.get(E.selField.id); if (it) K.openField(toolCtx(), it, E.selField.name); return; }
  const it = selectionItems()[0]; if (it) K.openItem(toolCtx(), it);
}
function deleteAll(): void {
  const ids = selectionIds(); if (!ids.length) return;
  clearAllSelection(false); E.selection = new Set(ids); deleteSelection(); selectionChanged();
}

/** Entries with behaviour of their own.  A function returns the runner, or a string saying why the row is dimmed. */
const SPECIAL: Record<string, (c: MenuCtx) => Run | string> = {
  "ACTIONS::cancelInteractive": () => escape,
  "ACTIONS::finishInteractive": (c) => (c.drawingLine || c.routing || c.canUndoPoint ? moduleKey("Enter") : "nothing is being drawn"),
  "SCH_ACTIONS::undoLastSegment": (c) => (schState()?.wire ? moduleKey("Backspace") : c.canUndoPoint ? moduleKey("Backspace") : "no segment to take back"),
  "ACTIONS::deleteLastPoint": () => moduleKey("Backspace"),
  "SCH_ACTIONS::switchSegmentPosture": () => (schState()?.wire ? moduleKey("/") : "no wire is being drawn"),
  "ACT_SwitchPosture": (c) => (c.routing ? moduleKey("/") : "no track is being routed"),
  "ACT_PlaceThroughVia": (c) => (c.routing ? moduleKey("v") : "no track is being routed"),
  "PCB_ACTIONS::routerUndoLastSegment": (c) => (c.routing ? moduleKey("Backspace") : "no track is being routed"),
  "SCH_ACTIONS::closeOutline": () => moduleKey("Enter"),
  "PCB_ACTIONS::closeOutline": () => moduleKey("Enter"),
  "SCH_ACTIONS::properties": () => (window.KDialogs ? openProperties : NOT_YET),
  "PCB_ACTIONS::properties": () => (window.KDialogs ? openProperties : NOT_YET),
  "ACTIONS::selectAll": () => () => { clearAllSelection(false); selectAll(); requestRender(); },
  "ACTIONS::unselectAll": () => () => clearAllSelection(),
  "ACTIONS::doDelete": () => (E.selField ? DESKTOP : deleteAll),
  "SCH_ACTIONS::move": () => (selectionItems().length ? () => { startMove("move"); } : NOT_YET),
  "SCH_ACTIONS::drag": () => (selectionItems().length ? () => { startMove("drag"); } : NOT_YET),
  "PCB_ACTIONS::move": () => (selectionItems().length ? () => { startMove("move"); } : NOT_YET),
  "PCB_ACTIONS::drag45Degree": dragTrack, "PCB_ACTIONS::dragFreeAngle": dragTrack,
  "SCH_ACTIONS::enterSheet": () => { const it = selectionItems()[0]; const file = it && it.file; return file ? () => enterSheet(file) : NOT_YET; },
  "SCH_ACTIONS::leaveSheet": () => () => HANDLERS.navigateUp(),
  "SCH_ACTIONS::clearHighlight": () => clearHighlight, "PCB_ACTIONS::clearHighlight": () => clearHighlight,
};
function clearHighlight(): void { if (!runModuleAction("clearHighlight")) { E.highlightIds = null; } requestRender(); }
function dragTrack(): Run | string {
  const it = selectionItems()[0]; if (!it) return NOT_YET;
  if (it.kind === "footprint") return () => { const m = CollabTools.pcb as unknown as { dragSelection?: (c: unknown) => boolean }; if (!(m.dragSelection && m.dragSelection(toolCtx()))) startMove("move"); };   // attached tracks follow
  if (it.kind !== "segment" || !moduleTool("drag")) return NOT_YET;
  return () => { const p = pcbState(); clearAllSelection(false); if (p) p.sel = new Set([it.id]); setTool("drag"); selectionChanged(); };
}

/** KiCad action → module action id, where the web's id differs. */
const ALIAS: Record<Editor, Record<string, string>> = {
  sch: { rotateCCW: "rotateSelection", rotateCW: "rotateSelectionCW", mirrorH: "mirrorSelectionX", mirrorV: "mirrorSelectionY", autoplaceFields: "autoplace" },
  pcb: { flip: "flipSelection", moveExact: "moveExactly", packAndMoveFootprints: "pack", rotateCcw: "rotateSelection", rotateCw: "rotateSelectionCw", highlightNetSelection: "highlightNet" },
};
/** Board entries whose short id collides with a handler that means something else here. */
const NO_HANDLER = new Set(["PCB_ACTIONS::mirrorH", "PCB_ACTIONS::mirrorV"]);
/** What a view-only visitor may still run: looking, selecting, navigating, copying. */
const READ_ONLY_OK = new Set(["cancelInteractive", "selectAll", "unselectAll", "properties", "enterSheet", "leaveSheet", "clearHighlight", "highlightNetSelection", "highlightNet",
  "selectConnection", "selectNet", "selectNode", "selectSameSheet", "selectUnconnected", "filterSelection", "copy", "copyAsText", "showDatasheet", "inspectClearance", "showNetInRatsnest", "hideNetInRatsnest"]);

function resolve(act: string, c: MenuCtx): { run?: Run; why?: string; key?: string } {
  const sid = act.split("::").pop() as string, ed = c.editor, m = activeModule();
  if (E.viewOnly && !READ_ONLY_OK.has(sid)) return { why: VIEW_ONLY };
  const special = SPECIAL[act];
  if (special) { const r = special(c); return typeof r === "string" ? { why: r } : { run: r }; }
  const mid = ALIAS[ed][sid] || sid, ma = m && m.actions ? m.actions[mid] : undefined;
  if (ma) return { run: () => { runModuleAction(mid); selectionChanged(); }, key: ma.key || undefined };
  const h = (HANDLERS as Record<string, ((a: unknown) => void) | undefined>)[sid];
  if (h && !NO_HANDLER.has(act)) return { run: () => h(null) };
  const tid = toolFor(ed, sid);
  if (tid) return (APP_TOOLS as string[]).includes(tid) || moduleTool(tid) ? { run: () => setTool(tid) } : { why: NOT_YET };
  return { why: DESKTOP };
}

// ---------------------------------------------------------------- rows
let runners = new Map<number, Run>(), token = 0, menuId = 0;
let anchor: { x: number; y: number; mm: Mm } | null = null;
const runRow = (fn: Run): number => { runners.set(++token, fn); return token; };

function zoomRows(): CtxItem[] {
  const view = { ppm: stage.clientWidth / (E.vb[2] / E.vbPerMm), zoom: E.zoom, panX: 0, panY: 0, x0: 0, y0: 0 };
  const cur = (KiCadCanvas.zoomFactor as (v: KView) => number)(view);
  return ZOOM_LIST[editor()].map((f) => ({ label: `Zoom: ${f.toFixed(2)}`, check: true, checked: Math.abs(f - cur) / cur < 0.1, run: runRow(() => zoomBy(f / cur)) }));
}
function gridRows(c: MenuCtx): CtxItem[] {
  const rows: CtxItem[] = [row(GRID_ORIGIN, false, c), { sep: true }];
  const choices = store.get().viewport.gridChoices as [number, string][];
  for (const [pitch] of choices) {
    const mm = `${pitch.toFixed(4)} mm`, mils = `${(pitch / 0.0254).toFixed(2)} mils`;
    rows.push({ label: isSch() ? `${mils} (${mm})` : `${mm} (${mils})`, check: true, checked: Math.abs(pitch - E.gridPitch) < 1e-9, run: runRow(() => setGridPitch(pitch)) });
  }
  return rows;
}
function row(act: string, check: boolean, c: MenuCtx): CtxItem {
  const meta = META[act], r = resolve(act, c);
  const it: CtxItem = { act, label: meta ? meta.label.replace(/\.\.\.$/, "…") : (act.split("::").pop() as string), icon: meta && meta.icon ? meta.icon : undefined, key: r.key || (meta && meta.key) || undefined };
  if (check) { it.check = true; it.checked = !!c.checks[act]; }
  if (r.run) it.run = runRow(r.run); else it.why = r.why || DESKTOP;
  return it;
}
function rows(list: Resolved[], c: MenuCtx): CtxItem[] {
  return list.map((e): CtxItem => {
    if ("sep" in e) return { sep: true };
    if ("menu" in e) return { label: e.menu.title, icon: e.menu.icon, sub: subRows(e.menu, e.items, c) };
    return row(e.act, e.check, c);
  });
}
function subRows(menu: MenuDef, items: Resolved[], c: MenuCtx): CtxItem[] { return menu.dynamic === "zoom" ? zoomRows() : menu.dynamic === "grid" ? gridRows(c) : rows(items, c); }

/** "Symbol R1 (10k)", "Wire", "Track on F.Cu": how KiCad names an item in a disambiguation menu. */
function describe(it: KItem): string {
  const names = (CollabTools.props && CollabTools.props.KIND_NAMES) || {};
  const kind = names[it.kind] || it.kind.replace(/^gr_/, "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
  const what = it.ref ? `${it.ref}${it.value ? ` (${it.value})` : ""}` : it.name || (it.kind.includes("label") || it.kind === "text" || it.kind === "gr_text" ? KiCadCanvas.str(it.node[1]) : "");
  const layer = it.docType === "pcb" && it.layer ? ` on ${it.layer}` : "";
  return `${kind}${what ? " " + what : ""}${layer}`;
}
/** KiCad's "Clarify Selection" list: offered when the click could have meant more than one item. */
function clarifyRows(mm: Mm): CtxItem | null {
  const hits = hitsAt(mm).slice(0, 12); if (hits.length < 2) return null;
  const sel = new Set(selectionIds());
  return { label: "Clarify Selection", icon: "cursor", sub: hits.map((it): CtxItem => ({
    label: describe(it), check: true, checked: sel.has(it.id), hover: it.id,
    run: runRow(() => { clearAllSelection(false); selectItemId(it.id); selectionChanged(); if (anchor) show(anchor.x, anchor.y, anchor.mm, false); }),
  })) };
}

/**
 * Alt+click in the select tool (SELECTION_TOOL::setModifiersState: m_skip_heuristics off Windows): every item under
 * the cursor in KiCad's "Clarify Selection" popup (doSelectionMenu) — numbered rows, then Select All.  False when the
 * click is not ambiguous, and the click selects as usual.
 */
export function openClarifyMenu(ev: { clientX: number; clientY: number }): boolean {
  if (!E.kdoc || state.view !== "editor" || (E.tool !== "select" && E.tool !== "highlight") || interactionBusy()) return false;
  const mm = worldMm(ev); E.lastCursorMm = mm;
  const hits = hitsAt(mm).slice(0, 100); if (hits.length < 2) return false;
  runners = new Map(); anchor = null;
  const pick = (ids: string[]): void => { clearAllSelection(false); for (const id of ids) selectItemId(id); selectionChanged(); };
  const items: CtxItem[] = hits.map((it, i): CtxItem => ({ label: describe(it), key: i < 9 ? String(i + 1) : undefined, hover: it.id, run: runRow(() => pick([it.id])) }));
  items.push({ sep: true }, { label: "Select All", key: "A", run: runRow(() => pick(hits.map((it) => it.id))) });
  E.contextMenuOpen = true; E.hoverId = null; stage.classList.remove("over-sel");
  store.set({ contextMenu: { id: ++menuId, x: ev.clientX, y: ev.clientY, items } });
  requestRender(); return true;
}

// ---------------------------------------------------------------- open / close
function show(x: number, y: number, mm: Mm, clarify: boolean): void {
  runners = new Map(); anchor = { x, y, mm };
  const c = menuCtx();
  const items = rows(evaluate(menuFor(c, activeModuleTool()), c), c);
  if (clarify && (E.tool === "select" || E.tool === "highlight")) { const cl = clarifyRows(mm); if (cl) items.unshift(cl, { sep: true }); }
  E.contextMenuOpen = true; E.hoverId = null; stage.classList.remove("over-sel");
  store.set({ contextMenu: { id: ++menuId, x, y, items } });
  requestRender();
}

/**
 * A right click at a client position.  SCH_SELECTION_TOOL / PCB_SELECTION_TOOL: with nothing selected
 * the item under the cursor is selected first; with a selection, a click away from it (outside its
 * bounding box grown by a grid square) on another item replaces it; then the menu opens.
 */
export function openContextMenu(ev: { clientX: number; clientY: number }): void {
  if (!E.kdoc || state.view !== "editor") return;
  if (window.KDialogs && window.KDialogs.isOpen()) return;
  const mm = worldMm(ev);
  E.lastCursorMm = mm;
  if ((E.tool === "select" || E.tool === "highlight") && !interactionBusy()) {
    if (E.selField) {
      const hit = pickAt(mm);
      if (!(hit && hit.field && hit.field.id === E.selField.id && hit.field.name === E.selField.name)) selectAt(mm);
    } else if (!selectionIds().length) selectAt(mm);
    else {
      const b = selectionBox(), g = Math.max(E.gridPitch || 0, 0.5);
      const outside = !b || mm[0] < b[0] - g || mm[0] > b[2] + g || mm[1] < b[1] - g || mm[1] > b[3] + g;
      if (outside && pickAt(mm)) selectAt(mm);
    }
  }
  show(ev.clientX, ev.clientY, mm, true);
}

export function closeContextMenu(): void {
  if (!E.contextMenuOpen && !store.get().contextMenu) return;
  E.contextMenuOpen = false; runners = new Map(); anchor = null;
  if (E.hoverId) { E.hoverId = null; }
  store.set({ contextMenu: null }); requestRender();
}

/** The chrome's answer: run a row, brighten the item a row stands for, or (neither) close. */
export function contextMenuAction(a: Extract<AppAction, { type: "contextMenu" }>): void {
  if (a.hover !== undefined) { E.hoverId = a.hover; E.hoverPinned = !!a.hover; requestRender(); if (a.run === undefined) return; }
  const fn = a.run !== undefined ? runners.get(a.run) : undefined;
  const keep = anchor;
  closeContextMenu(); E.hoverPinned = false;
  if (!fn) return;
  anchor = keep;                                   // Clarify Selection reopens the menu where it was
  try { fn(); } catch (e) { console.warn("context menu action failed", e); } finally { if (!E.contextMenuOpen) anchor = null; }
}
