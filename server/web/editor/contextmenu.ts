import { netLabel } from "../review/names";
// contextmenu.ts — the right-click menu: KiCad's selection rule, the menu for the active tool
// (ctxmenus.ts), and what each entry does here.
//
// The editor resolves every entry to a plain row (label, icon name, hotkey hint, check mark and
// either a run token or the reason it is dimmed) and publishes the tree on the store; the React
// ContextMenu component renders it and answers with dispatch({ type: "contextMenu", run }).
import { actions as CTX_ACTIONS } from "../generated/kicad-context-spec.json";
import { menuMeta } from "../menuspec";
import type { AppAction, CtxItem, Editor } from "../store";
import { ZOOM_LIST, toolFor } from "../tables";
import { gridChoiceText } from "../units";
import { deleteSelectedField } from "./fieldops";
import { HANDLERS } from "./actions";
import { canComment, commentOnItem, commentOnNet, netOfItem, showThread, startThread, threadsOnItem } from "./comments";
import { APP_TOOLS, state, store } from "./appstore";
import { enterSheet, rootSchematic, setGridPitch } from "./doc";
import { ARC_EDIT_MODE_MENU, evaluate, GRID_ORIGIN, menuFor, type MenuCtx, type MenuDef, type Resolved } from "./ctxmenus";
import { activeModuleTool, clearAllSelection, hitsAt, interactionBusy, pcbState, pickAt, schState, selectAt, selectionBox, selectionChanged, selectionIds, selectionItems, selectItemId, stage, startFieldMove, startMove, toolCtx, worldMm, zoomBy } from "./gestures";
import { E } from "./state";
import { HIT_PX, nearestFootprint } from "./selection";
import { activeModule, deleteSelection, moduleTool, runModuleAction, selectAll, setTool } from "./tools";
import { isSch, kicadZoom, pxPerMm, requestRender } from "./view";
/** The table cell selection's view for the menu, filled in by editor/tablecells.ts at install. */
export const tableMenu: { state(): { n: number; block: boolean; merged: boolean; structure: boolean } | null; pick(mm: Mm): boolean; actions: Record<string, () => boolean> } = { state: () => null, pick: () => false, actions: {} };
import { toast } from "./util";

type Mm = [number, number];
type Run = () => void;
interface Meta { id: string; label: string; tip: string | null; icon: string | null; key: string | null }
const META = CTX_ACTIONS as unknown as Record<string, Meta>;
/** The context spec holds what the generator saw in context menus; entries added by hand (PCB_POINT_EDITOR) fall back to the action table. */
const metaOf = (act: string): Meta | null => META[act] || (menuMeta(act.startsWith("SCH_") ? "sch" : act.startsWith("PCB_") ? "pcb" : null, act.split("::").pop() as string) as Meta | null);


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

const SCH_ARC_MODES = ["drawArcCenter", "drawArcStartEndMid", "drawArcStartEndCenter", "drawArcTangent", "drawArcStartDirEnd"];
function schArcChecks(): Record<string, boolean> {
  const m = CollabTools.sch as unknown as { _?: { schArcDrawMode?: () => number } } | undefined; const f = m && m._ && m._.schArcDrawMode; if (!f) return {};
  const cur = f(); return Object.fromEntries(SCH_ARC_MODES.map((id, i) => ["SCH_ACTIONS::" + id, cur === i]));
}
function attributeChecks(items: KItem[]): Record<string, boolean> {
  const some = (f: (n: SNode) => boolean) => items.length > 0 && items.every((it) => f(it.node));
  if (isSch()) return {
    "SCH_ACTIONS::setDNP": some((n) => flag(n, "dnp") === "yes"),
    "SCH_ACTIONS::setExcludeFromBOM": some((n) => flag(n, "in_bom") === "no"),
    "SCH_ACTIONS::setExcludeFromBoard": some((n) => flag(n, "on_board") === "no"),
    "SCH_ACTIONS::setExcludeFromSim": some((n) => flag(n, "exclude_from_sim") === "yes"),
    "SCH_ACTIONS::setExcludeFromPosFiles": some((n) => flag(n, "in_pos_files") === "no"),
    // EE_GRAPHIC_TOOL's arc mode check items: the mode ARC_MODE_SESSION draws in
    ...schArcChecks(),
  };
  // ROUTER_TOOL's check items (router mode, corner mode) as pcb-tools.js's router settings stand
  const router = (CollabTools.pcb as unknown as { routerChecks?: () => Record<string, boolean> } | undefined);
  return {
    ...(router && router.routerChecks ? router.routerChecks() : {}),
    "PCB_ACTIONS::toggleExcludeFromBOM": some((n) => attrHas(n, "exclude_from_bom")),
    "PCB_ACTIONS::toggleExcludeFromPosFiles": some((n) => attrHas(n, "exclude_from_pos_files")),
    "PCB_ACTIONS::toggleExcludeFromSim": some((n) => attrHas(n, "exclude_from_sim")),
  };
}

function menuCtx(): MenuCtx {
  const items = selectionItems(), s = schState(), p = pcbState(), sch = isSch();
  const kinds = items.map(kindOf); if (E.selField && !kinds.length) kinds.push("field"); if (E.selPins.length && !kinds.length) for (let i = 0; i < E.selPins.length; i++) kinds.push("pin");
  const cells = tableMenu.state(); if (cells) for (let i = 0; i < cells.n; i++) kinds.push("table_cell");   // PCB_TABLECELL_T / SCH_TABLECELL_T
  const draw = sch ? (s && s.draw) : (p && p.draw);
  const n = draw && Array.isArray(draw.pts) ? draw.pts.length : 0;
  const outline = !!draw && (sch ? draw.shape === "polygon" || draw.shape === "rulearea" : ["gpoly", "zone", "thievingzone", "rulearea"].includes(draw.shape));
  const drawingLine = sch && !!s && (!!s.wire || (!!s.draw && s.draw.shape === "lines"));
  const routing = !sch && !!p && !!p.route;
  const root = sch ? rootSchematic() : null;
  // PCB_POINT_EDITOR's corner conditions, asked of the module for the one selected item at the cursor
  const P = (window as unknown as { PcbTools?: { canAddCorner?: (it: unknown) => boolean; canRemoveCorner?: (d: KDoc, id: string, at: number[] | null) => boolean } }).PcbTools;
  const one = !sch && items.length === 1 ? items[0] : null;
  const canAddCorner = !!(one && P && P.canAddCorner && P.canAddCorner(one));
  const canRemoveCorner = !!(one && P && P.canRemoveCorner && E.kdoc && P.canRemoveCorner(E.kdoc as KDoc, one.id, (E.lastCursorMm as number[] | null) || null));
  return {
    editor: editor(), kinds, tool: E.tool, drawingLine, routing,
    busy: interactionBusy() || drawingLine || routing || !!draw || (sch && !!s && !!s.carry),
    canAddCorner, canRemoveCorner,
    canClose: outline && n >= 3, canUndoPoint: (outline || (!!draw && (draw.shape === "lines" || draw.shape === "gcurve"))) && n >= 1,
    pinAlts: !!(E.selPins.length === 1 && E.kdoc && schPins() && schPins()!.pinAlternates(E.kdoc as KDoc, E.selPins[0])),   // ALT_PIN_FUNCTION_MENU: one pin only
    highlight: !!E.highlightIds, belowRoot: !!root && (state as { doc?: unknown }).doc !== root,
    hasLocked: items.some((it) => isLocked(it.node)), hasUnlocked: items.some((it) => !isLocked(it.node)),
    groupSelected: boardGroupSelected(), inGroup: !sch && !!(CollabTools.pcb && (CollabTools.pcb.state as { enteredGroup?: string | null }).enteredGroup),
    hasItems: !!E.kdoc && E.kdoc.items.size > 0, checks: attributeChecks(items),
    cells: cells ? { block: cells.block, merged: cells.merged, structure: cells.structure } : null,
  };
}

// ---------------------------------------------------------------- what an entry does
const moduleKey = (key: string): Run => () => { const m = activeModule(); if (m && m.onKey) { try { m.onKey(key, {}, toolCtx()); } catch (e) { console.warn(e); } requestRender(); } };
const escape: Run = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); };

function openProperties(): void {
  const d = E.kdoc as KDoc | null, K = window.KDialogs; if (!d || !K) return;
  if (E.selField) { const it = d.items.get(E.selField.id); if (it) K.openField(toolCtx(), it, E.selField.name); return; }
  if (E.selPins.length) { if (E.selPins.length === 1) { const it = d.items.get(E.selPins[0].id); if (it) K.openItem(toolCtx(), it); } return; }   // Properties promotes a lone pin to its symbol; several pins open nothing
  const it = selectionItems()[0]; if (it) K.openItem(toolCtx(), it);
}
/** SCH_MOVE_TOOL: selected pins move as their parent symbols. */
function promotePin(): void {
  if (!E.selPins.length) return; const ids = Array.from(new Set((E.selPins as { id: string }[]).map((p) => p.id))); E.selPins = [];
  const fps = ids.map((id) => (E.items as { id: string }[]).find((f) => f.id === id)).filter((f): f is { id: string } => !!f);
  if (fps.length) E.selected = fps[0] as typeof E.selected; if (fps.length > 1) E.selection = new Set(fps.map((f) => f.id));
}
function deleteAll(): void {
  const ids = selectionIds(); if (!ids.length) return;
  clearAllSelection(false); E.selection = new Set(ids); deleteSelection(); selectionChanged();
}

/** Entries with behaviour of their own.  A function returns the runner, or a string saying why the row is dimmed. */
const SPECIAL: Record<string, (c: MenuCtx) => Run | string> = {
  "ACTIONS::cancelInteractive": () => escape,
  "ACTIONS::finishInteractive": (c) => (c.drawingLine || c.routing || c.canUndoPoint || (c.editor === "sch" && (c.tool === "arc" || c.tool === "bezier")) ? moduleKey("Enter") : "nothing is being drawn"),
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
  // SCH_EDIT_TOOL::SwapPinLabels (the error goes to the infobar)
  "SCH_ACTIONS::swapPinLabels": () => (schPins() ? () => { const P = schPins()!; const err = P.swapPinLabels(toolCtx(), (E.selPins as PinRef[]).slice()); if (err) toast(err, 5000); selectionChanged(); requestRender(); } : NOT_YET),
  // a field selected on its own: a schematic field is hidden (SCH_EDIT_TOOL::DoDelete, fieldops.ts); a board footprint field
  // goes to the board module's Delete (EDIT_TOOL::DeleteItems, PCB_FIELD_T: "Hide Field")
  "ACTIONS::doDelete": () => (E.selField && !selectionItems().length ? (isSch() ? () => { deleteSelectedField(); } : moduleKey("Delete")) : E.selPins.length ? () => { /* SCH_EDIT_TOOL::DoDelete: a pin is never deleted on its own */ } : deleteAll),
  // SCH_MOVE_TOOL with a field selected on its own: the field follows the cursor (gestures.ts startFieldMove)
  "SCH_ACTIONS::move": () => (E.selField && !selectionItems().length ? () => { startFieldMove((E.lastCursorMm || [0, 0]) as [number, number]); } : selectionItems().length || E.selPins.length ? () => { promotePin(); startMove("move"); } : NOT_YET),
  "SCH_ACTIONS::drag": () => (E.selField && !selectionItems().length ? () => { startFieldMove((E.lastCursorMm || [0, 0]) as [number, number]); } : selectionItems().length || E.selPins.length ? () => { promotePin(); startMove("drag"); } : NOT_YET),
  "PCB_ACTIONS::move": () => (selectionItems().length || E.selField ? () => { startMove("move"); } : NOT_YET),
  "PCB_ACTIONS::drag45Degree": () => dragTrack(false), "PCB_ACTIONS::dragFreeAngle": () => dragTrack(true),
  "SCH_ACTIONS::enterSheet": () => { const it = selectionItems()[0]; const file = it && it.file; return file ? () => enterSheet(file) : NOT_YET; },
  "SCH_ACTIONS::leaveSheet": () => () => HANDLERS.navigateUp(),
  "SCH_ACTIONS::clearHighlight": () => clearHighlight, "PCB_ACTIONS::clearHighlight": () => clearHighlight,
};
function clearHighlight(): void { if (!runModuleAction("clearHighlight")) { E.highlightIds = null; } requestRender(); }
function dragTrack(free: boolean): Run | string {
  const it = selectionItems()[0]; if (!it) return NOT_YET;
  if (it.kind === "footprint") return () => { const m = CollabTools.pcb as unknown as { dragSelection?: (c: unknown) => boolean }; if (!(m.dragSelection && m.dragSelection(toolCtx()))) startMove("move"); };   // attached tracks follow
  if ((it.kind !== "segment" && it.kind !== "via") || !moduleTool("drag")) return NOT_YET;
  // EDIT_TOOL::Drag -> ROUTER_TOOL::InlineDrag: the selection is dragged by the router, 45° or free angle
  return () => { const m = CollabTools.pcb as unknown as { inlineDrag?: (c: unknown, f: boolean) => boolean }; if (m.inlineDrag) m.inlineDrag(toolCtx(), free); selectionChanged(); };
}

/** KiCad action → module action id, where the web's id differs. */
const ALIAS: Record<Editor, Record<string, string>> = {
  sch: { rotateCCW: "rotateSelection", rotateCW: "rotateSelectionCW", mirrorH: "mirrorSelectionX", mirrorV: "mirrorSelectionY", autoplaceFields: "autoplace" },
  pcb: { flip: "flipSelection", moveExact: "moveExactly", packAndMoveFootprints: "pack", rotateCcw: "rotateSelection", rotateCw: "rotateSelectionCw", highlightNetSelection: "highlightNet", groupEnter: "enterGroup", groupLeave: "leaveGroup" },
};
/** Board entries whose short id collides with a handler that means something else here. */
const NO_HANDLER = new Set(["PCB_ACTIONS::mirrorH", "PCB_ACTIONS::mirrorV"]);
/** What a view-only visitor may still run: looking, selecting, navigating, copying. */
const READ_ONLY_OK = new Set(["cancelInteractive", "selectAll", "unselectAll", "properties", "enterSheet", "leaveSheet", "clearHighlight", "highlightNetSelection", "highlightNet",
  "selectConnection", "selectNet", "selectNode", "selectSameSheet", "selectUnconnected", "filterSelection", "copy", "copyAsText", "showDatasheet", "selectColumns", "selectRows", "selectTable", "exportTableCSV", "editTable", "inspectClearance", "showNetInRatsnest", "hideNetInRatsnest"]);

/** PCB_SELECTION_TOOL's groupEnterCondition: the selection is one group. */
function boardGroupSelected(): boolean {
  if (isSch() || !CollabTools.pcb || !CollabTools.pcb.selectedTopGroup) return false;
  try { return !!CollabTools.pcb.selectedTopGroup(toolCtx()); } catch (e) { return false; }
}
function resolve(act: string, c: MenuCtx): { run?: Run; why?: string; key?: string } {
  const sid = act.split("::").pop() as string, ed = c.editor, m = activeModule();
  if (E.viewOnly && !READ_ONLY_OK.has(sid)) return { why: VIEW_ONLY };
  // the table edit tool: its own actions, and Properties / clipboard / Delete on a cell selection
  const ta = tableMenu.actions[act];
  if (ta && (act.startsWith("ACTIONS::") && !["ACTIONS::copy", "ACTIONS::paste", "ACTIONS::cut", "ACTIONS::doDelete"].includes(act) || c.kinds.some((k) => k === "table_cell"))) return { run: () => { ta(); selectionChanged(); } };
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
  const cur = kicadZoom();
  return ZOOM_LIST[editor()].map((f) => ({ label: `Zoom: ${f.toFixed(2)}`, check: true, checked: Math.abs(f - cur) / cur < 0.1, run: runRow(() => zoomBy(f / cur)) }));
}
function gridRows(c: MenuCtx): CtxItem[] {
  const rows: CtxItem[] = [row(GRID_ORIGIN, false, c), { sep: true }];
  // GRID_MENU::update: every grid of the list in the user units, the current one checked
  const vp = store.get().viewport;
  for (const g of vp.gridChoices) {
    rows.push({ label: gridChoiceText(g, vp.units, vp.lastImperial, isSch() ? "sch" : "pcb"), check: true, checked: Math.abs(g.mm - E.gridPitch) < 1e-9, run: runRow(() => setGridPitch(g.mm)) });
  }
  return rows;
}
function row(act: string, check: boolean, c: MenuCtx): CtxItem {
  const meta = metaOf(act), r = resolve(act, c);
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
/** DIFF_PAIR_MENU's rows, from the board module (pcb-tools.js diffPairMenu). */
interface DpRow { sep?: boolean; label?: string; tip?: string; checked?: boolean; run?: () => void }
function diffPairRows(): CtxItem[] {
  const pcb = (CollabTools as unknown as { pcb?: { diffPairMenu?: (ctx: unknown) => DpRow[] } }).pcb;
  if (!pcb || !pcb.diffPairMenu) return [];
  return pcb.diffPairMenu(toolCtx()).map((r): CtxItem => (r.sep ? { sep: true } : { label: r.label, check: true, checked: !!r.checked, run: runRow(() => { if (r.run) r.run(); }) }));
}
/** The schematic module's pin helpers (sch-tools pins.ts). */
interface PinRef { id: string; number: string }
interface SchPins {
  pinAlternates(d: KDoc, r: PinRef): { base: string; alts: string[]; current: string } | null;
  setAltPinFunction(ctx: unknown, r: PinRef, alt: string): boolean;
  pinHelper(ctx: unknown, pins: PinRef[], what: string, ref?: (it: KItem) => string): string[];
  swapPinLabels(ctx: unknown, pins: PinRef[]): string | null;
  PIN_HELPERS: { id: string; label: string; icon: string }[];
}
function schPins(): SchPins | null { const m = CollabTools.sch; const u = m && (m._ as unknown as SchPins | undefined); return u && typeof u.pinHelper === "function" ? u : null; }
/** ALT_PIN_FUNCTION_MENU::update: the base function, then the alternates (a std::map, so by name), as check items. */
function pinFunctionRows(): CtxItem[] {
  const P = schPins(), pin = (E.selPins.length === 1 ? E.selPins[0] : null) as PinRef | null; if (!P || !pin || !E.kdoc) return [];
  const info = P.pinAlternates(E.kdoc as KDoc, pin); if (!info) return [];
  const ro = !!E.viewOnly;
  const one = (name: string, on: boolean): CtxItem => { const it: CtxItem = { label: name, check: true, checked: on }; if (ro) it.why = VIEW_ONLY; else it.run = runRow(() => { P.setAltPinFunction(toolCtx(), pin, name); requestRender(); }); return it; };
  const out = [one(info.base, !info.current || info.current === info.base)];
  for (const a of info.alts.slice().sort()) if (a !== info.base) out.push(one(a, a === info.current));
  return out;
}
/** PIN_TRICKS_MENU::update: Wire, No Connect, Net Label, Hierarchical Label, Global Label on the selected pins. */
function pinHelperRows(): CtxItem[] {
  const P = schPins(), pins = E.selPins.slice() as PinRef[]; if (!P || !pins.length) return [];
  return P.PIN_HELPERS.map((h): CtxItem => {
    const it: CtxItem = { label: h.label, icon: h.icon };
    if (E.viewOnly) it.why = VIEW_ONLY;
    else it.run = runRow(() => { E.selPins = []; P.pinHelper(toolCtx(), pins, h.id); selectionChanged(); requestRender(); });
    return it;
  });
}
function subRows(menu: MenuDef, items: Resolved[], c: MenuCtx): CtxItem[] { return menu.dynamic === "zoom" ? zoomRows() : menu.dynamic === "grid" ? gridRows(c) : menu.dynamic === "diffpair" ? diffPairRows() : menu.dynamic === "pinfunction" ? pinFunctionRows() : menu.dynamic === "pinhelpers" ? pinHelperRows() : rows(items, c); }

/** "Symbol R1 (10k)", "Wire", "Track [VCC] on B.Cu, length 0.6400 mm": how KiCad names an item in a disambiguation menu. */
function describe(it: KItem | string): string {
  const P = (window as unknown as { PcbTools?: { itemDescription?: (d: KDoc, id: string, u: string) => string } }).PcbTools;
  if (!isSch() && P && P.itemDescription && E.kdoc) { const t = P.itemDescription(E.kdoc as KDoc, typeof it === "string" ? it : it.id, E.units); if (t) return t; }
  if (typeof it === "string") return it;
  const names = (CollabTools.props && CollabTools.props.KIND_NAMES) || {};
  const kind = names[it.kind] || it.kind.replace(/^gr_/, "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
  const what = it.ref ? `${it.ref}${it.value ? ` (${it.value})` : ""}` : it.name || (it.kind.includes("label") || it.kind === "text" || it.kind === "gr_text" ? KiCadCanvas.str(it.node[1]) : "");
  const layer = it.docType === "pcb" && it.layer ? ` on ${it.layer}` : "";
  return `${kind}${what ? " " + what : ""}${layer}`;
}
/**
 * The candidates under the cursor, as ids: on a board a pad under the cursor is its own candidate
 * ("footprintId#padIndex", ahead of its footprint), as PCB_SELECTION_TOOL's collector lists PCB_PAD_T.
 */
function candidatesAt(mm: Mm): string[] {
  const hits = hitsAt(mm); const ids = hits.map((it) => it.id);
  if (isSch() || !E.kdoc) return ids;
  // FOOTPRINT::HitTest: a footprint is hit inside its bounding hull, not only on its drawn shapes (as a left click's pickAt)
  const fp = nearestFootprint(mm[0], mm[1], 5 / Math.max(1, E.zoom * 0.6)) as { id: string } | null;
  // (only where nothing drawn is hit: over its own shapes or another item the existing candidates already decide)
  if (fp && !ids.length) ids.push(fp.id);
  let pad: { item?: KItem; index?: number } | null = null;
  try { pad = (KiCadCanvas.padAt as (d: KDoc, x: number, y: number) => { item?: KItem; index?: number } | null)(E.kdoc as KDoc, mm[0], mm[1]); } catch { pad = null; }
  const f = store.get().filter as Record<string, boolean>;
  if (pad && pad.item && pad.index !== undefined && f.pads !== false) { const i = ids.indexOf(pad.item.id); const key = `${pad.item.id}#${pad.index}`; if (i >= 0) ids.splice(i, 0, key); else ids.unshift(key); }
  return ids;
}
/** Select one candidate: a pad key goes to the board module's pad selection. */
function selectCandidate(id: string): void {
  const hash = id.indexOf("#");
  if (hash > 0 && !isSch()) { const ps = pcbState() as unknown as { padSel?: string | null } | null; if (ps) ps.padSel = id; requestRender(); return; }
  selectItemId(id);
}
/**
 * PCB_SELECTION_TOOL::GuessSelectionCandidates (pcb-tools.js guessCandidates): exact hits beat sloppy ones, a small
 * item beats a much larger one around it, the active layer beats the others — so only real overlaps (stacked tracks,
 * a via on a track, two pads) stay ambiguous.
 */
type Guess = (d: KDoc, ids: string[], where: Mm, o: { px: number; hidden: Set<string>; viewport: [number, number] }) => string[];
function ambiguousAt(mm: Mm): string[] {
  const ids = candidatesAt(mm); if (isSch() || !E.kdoc) return ids;
  const P = (window as unknown as { PcbTools?: { guessCandidates?: Guess } }).PcbTools;
  if (P && P.guessCandidates) {
    const ppm = Math.max(1e-6, pxPerMm()), r = stage.getBoundingClientRect();
    try { return P.guessCandidates(E.kdoc as KDoc, ids, mm, { px: 1 / ppm, hidden: E.hiddenLayers as Set<string>, viewport: [r.width / ppm, r.height / ppm] }); } catch (e) { console.warn(e); }
  }
  const others = ids.filter((id) => { const it = (E.kdoc as KDoc).items.get(id); return !(it && it.kind === "footprint"); });
  return others.length ? others : ids;
}
/**
 * The board module's hover selection (PCB_SELECTION_TOOL::RequestSelection with nothing selected) asks here: the
 * candidates under a point after GuessSelectionCandidates, and doSelectionMenu between them at the pointer.
 */
E.hooks.candidatesAt = (mm: Mm): string[] => (E.kdoc ? ambiguousAt(mm) : []);
/**
 * The footprint field (PCB_FIELD) RequestSelection's collector keeps at a point, or null: the field's text quad is
 * under the point, the selection filter lets text through, and its own footprint is not collected there too —
 * FilterCollectorForHierarchy drops a child whose footprint is a candidate, and GENERAL_COLLECTOR collects a
 * footprint by its hull (FOOTPRINT::HitTestAccurate, which leaves the fields out) within the 5 px accuracy.
 */
E.hooks.fieldAt = (mm: Mm): { id: string; name: string } | null => {
  if (isSch() || !E.kdoc) return null;
  const f = store.get().filter as Record<string, boolean>; if (f.text === false) return null;
  const hit = KiCadCanvas.fieldAt(E.kdoc as KDoc, mm[0], mm[1], E.hiddenLayers as Set<string>); if (!hit || hit.item.kind !== "footprint") return null;
  if (f.footprints !== false && footprintHullHit(hit.item, mm)) return null;
  return { id: hit.item.id, name: hit.name };
};
/** FOOTPRINT::HitTestAccurate as the editor approximates it (canvas hitTestDetail): the box of its shapes and pads, never its texts, within 5 px. */
function footprintHullHit(it: KItem, mm: Mm): boolean {
  const tol = HIT_PX / Math.max(1e-6, pxPerMm()), hidden = E.hiddenLayers as Set<string>;
  const geomBox = KiCadCanvas.geomBox as (g: KGeom) => number[] | null;
  let hull: number[] | null = null;
  for (const g of it.geom) {
    if ((g.layer && hidden.has(g.layer)) || g.padText || g.padNum || g.noBox || g.t === "text") continue;
    const b = geomBox(g); if (!b) continue;
    hull = hull ? [Math.min(hull[0], b[0]), Math.min(hull[1], b[1]), Math.max(hull[2], b[2]), Math.max(hull[3], b[3])] : b.slice();
  }
  return !!hull && mm[0] >= hull[0] - tol && mm[0] <= hull[2] + tol && mm[1] >= hull[1] - tol && mm[1] <= hull[3] + tol;
}
E.hooks.clarify = (ids: string[], then: () => void): void => {
  const c = (E.lastClient as [number, number] | null) || [window.innerWidth / 2, window.innerHeight / 2];
  clarifyPopup({ clientX: c[0], clientY: c[1] }, ids, then);
};
/** KiCad's "Clarify Selection" list: offered when the click could have meant more than one item. */
function clarifyRows(mm: Mm): CtxItem | null {
  const ids = candidatesAt(mm).slice(0, 12); if (ids.length < 2) return null;
  const sel = new Set(selectionIds()); const ps = pcbState() as unknown as { padSel?: string | null } | null;
  return { label: "Clarify Selection", icon: "cursor", sub: ids.map((id): CtxItem => ({
    label: describe(id), check: true, checked: sel.has(id) || (!!ps && ps.padSel === id), hover: id.includes("#") ? id.slice(0, id.indexOf("#")) : id,
    run: runRow(() => { clearAllSelection(false); selectCandidate(id); selectionChanged(); if (anchor) show(anchor.x, anchor.y, anchor.mm, false); }),
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
  const ids = candidatesAt(mm).slice(0, 100); if (ids.length < 2) return false;
  clarifyPopup(ev, ids, null); return true;
}
/** SELECTION_TOOL::doSelectionMenu: numbered rows, then Select All; `then` runs after a pick (the context menu). */
function clarifyPopup(ev: { clientX: number; clientY: number }, ids: string[], then: (() => void) | null): void {
  runners = new Map(); anchor = null;
  const hoverOf = (id: string) => (id.includes("#") ? id.slice(0, id.indexOf("#")) : id);
  const pick = (list: string[]): void => { clearAllSelection(false); for (const id of list) selectCandidate(id); selectionChanged(); if (then) then(); };
  const items: CtxItem[] = ids.map((id, i): CtxItem => ({ label: describe(id), key: i < 9 ? String(i + 1) : undefined, hover: hoverOf(id), run: runRow(() => pick([id])) }));
  items.push({ sep: true }, { label: "Select All", key: "A", run: runRow(() => pick(ids.filter((id) => !id.includes("#")))) });
  E.contextMenuOpen = true; E.hoverId = null; stage.classList.remove("over-sel");
  store.set({ contextMenu: { id: ++menuId, x: ev.clientX, y: ev.clientY, items } });
  requestRender();
}

/**
 * Design review rows, after KiCad's own: start a comment thread on the item under the menu (a part, a
 * track, a label …), on its net, or on the spot; and open the threads already pinned to it.
 */
function reviewRows(mm: Mm, c: MenuCtx): CtxItem[] {
  if (c.busy || (E.tool !== "select" && E.tool !== "highlight")) return [];
  const out: CtxItem[] = [], sel = selectionItems(), it = sel.length === 1 ? sel[0] : null;
  if (it) for (const t of threadsOnItem(it.id).slice(0, 4)) out.push({ label: `Show Comment: ${t.body.replace(/\s+/g, " ").slice(0, 32)}${t.body.length > 32 ? "…" : ""}`, run: runRow(() => showThread(t.id)) });
  if (canComment()) {
    if (it) {
      const what = it.ref || it.name || describe(it);
      out.push({ label: `Add Comment on ${what}…`, hover: it.id, run: runRow(() => commentOnItem(it.id, it.ref || it.name ? undefined : mm)) });
      const net = netOfItem(it, mm);
      if (net) out.push({ label: `Add Comment on Net ${netLabel(net.name)}…`, run: runRow(() => commentOnNet(it.id, mm)) });
    } else if (!sel.length) out.push({ label: "Add Comment Here…", run: runRow(() => startThread(mm, null)) });
  }
  return out;
}

// ---------------------------------------------------------------- long-press disambiguation
// PCB_SELECTION_TOOL's m_disambiguateTimer: a left press held still for m_DisambiguationMenuDelay (500 ms) over more
// than one candidate opens the Clarify Selection popup; moving or releasing first cancels it.
let lpTimer = 0, lpAt: { x: number; y: number } | null = null;
export function startLongPress(ev: PointerEvent): void {
  cancelLongPress();
  if (ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || isSch() || E.tool !== "select" || !E.kdoc) return;
  lpAt = { x: ev.clientX, y: ev.clientY };
  const at = lpAt;
  lpTimer = window.setTimeout(() => {
    lpTimer = 0; if (!lpAt || lpAt !== at) return;
    const g = E.drag as { moved?: boolean } | null; if (g && g.moved) return;
    const ps = pcbState() as unknown as { drag?: { moved?: boolean } | null; move?: unknown; pending?: unknown } | null;
    if (ps && ((ps.drag && ps.drag.moved) || ps.move)) return;
    if (candidatesAt(worldMm({ clientX: at.x, clientY: at.y } as PointerEvent)).length < 2) return;
    // the press becomes the disambiguation: whatever it started (a box, a pending drag) is dropped
    E.boxSel = null; if (g) E.drag = null; if (ps) ps.pending = null; E.fdrag = null;
    openClarifyMenu({ clientX: at.x, clientY: at.y });
  }, 500);
}
export function moveLongPress(ev: PointerEvent): void { if (lpAt && Math.hypot(ev.clientX - lpAt.x, ev.clientY - lpAt.y) > 4) cancelLongPress(); }
export function cancelLongPress(): void { if (lpTimer) window.clearTimeout(lpTimer); lpTimer = 0; lpAt = null; }

// ---------------------------------------------------------------- open / close
function show(x: number, y: number, mm: Mm, clarify: boolean): void {
  runners = new Map(); anchor = { x, y, mm };
  const c = menuCtx();
  const items = rows(evaluate(menuFor(c, activeModuleTool()), c), c);
  const review = reviewRows(mm, c);
  if (review.length) {
    // before the Zoom / Grid sub-menus that close every KiCad menu
    let at = items.length; while (at > 0 && (items[at - 1].sub || items[at - 1].sep)) at--;
    items.splice(at, 0, ...(at > 0 && !items[at - 1].sep ? [{ sep: true } as CtxItem] : []), ...review);
  }
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
  if ((E.tool === "select" || E.tool === "highlight") && !interactionBusy() && tableMenu.pick(mm)) { /* a table cell under the cursor (selectPoint collects cells) */ }
  else if ((E.tool === "select" || E.tool === "highlight") && !interactionBusy()) {
    if (E.selPins.length) {
      const hit = pickAt(mm);
      if (!(hit && hit.pin && (E.selPins as PinRef[]).some((p) => p.id === hit.pin!.id && p.number === hit.pin!.number))) selectAt(mm);
    } else if (E.selField) {
      const hit = pickAt(mm);
      if (!(hit && hit.field && hit.field.id === E.selField.id && hit.field.name === E.selField.name)) selectAt(mm);
    } else if (!selectionIds().length && !(pcbState() as unknown as { padSel?: string | null } | null)?.padSel) {
      // PCB_SELECTION_TOOL::selectPoint on a right-click with nothing selected: more than one candidate left after the
      // heuristics opens the stand-alone Clarify Selection popup, and the context menu follows the pick
      const amb = isSch() ? [] : ambiguousAt(mm);
      if (amb.length > 1) { clarifyPopup(ev, amb.slice(0, 100), () => show(ev.clientX, ev.clientY, mm, false)); return; }
      if (amb.length === 1 && amb[0].includes("#")) { clearAllSelection(false); selectCandidate(amb[0]); selectionChanged(); }
      else if (amb.length || isSch()) selectAt(mm);
    }
    else {
      const b = selectionBox(), g = Math.max(E.gridPitch || 0, 0.5);
      const outside = !b || mm[0] < b[0] - g || mm[0] > b[2] + g || mm[1] < b[1] - g || mm[1] > b[3] + g;
      if (outside && pickAt(mm)) selectAt(mm);
    }
  }
  show(ev.clientX, ev.clientY, mm, true);
}

/**
 * The "Track routing tools" toolbar group's context menu (toolbars_pcb_editor.cpp): the three router modes as check
 * items, then Interactive Router Settings, opened under the button.
 */
export function openRouterModeMenu(at?: { left: number; bottom: number } | null): void {
  if (!E.kdoc || state.view !== "editor" || isSch()) return;
  const c = menuCtx();
  const items: CtxItem[] = [row("PCB_ACTIONS::routerHighlightMode", true, c), row("PCB_ACTIONS::routerShoveMode", true, c), row("PCB_ACTIONS::routerWalkaroundMode", true, c),
    { sep: true }, row("PCB_ACTIONS::routerSettingsDialog", false, c)];
  const x = at ? at.left : stage.getBoundingClientRect().left + 40, y = at ? at.bottom : stage.getBoundingClientRect().top + 40;
  E.contextMenuOpen = true; anchor = null;
  store.set({ contextMenu: { id: ++menuId, x, y, items } });
  requestRender();
}

/**
 * The left toolbar's grid button menu: eeschema's holds Edit Grids... alone (toolbars_sch_editor.cpp), pcbnew's adds
 * Grid Origin... (toolbars_pcb_editor.cpp).
 */
export function openGridButtonMenu(at?: { left: number; bottom: number } | null): void {
  if (!E.kdoc || state.view !== "editor") return;
  const c = menuCtx();
  const items: CtxItem[] = [row("ACTIONS::gridProperties", false, c)];
  if (!isSch()) items.push(row(GRID_ORIGIN, false, c));
  const x = at ? at.left : stage.getBoundingClientRect().left + 40, y = at ? at.bottom : stage.getBoundingClientRect().top + 40;
  E.contextMenuOpen = true; anchor = null;
  store.set({ contextMenu: { id: ++menuId, x, y, items } });
}

/** The Arc toolbar group's menu (toolbars_pcb_editor.cpp): the three arc editing modes as check items. */
export function openArcEditModeMenu(at?: { left: number; bottom: number } | null): void {
  if (!E.kdoc || state.view !== "editor" || isSch()) return;
  const c = menuCtx();
  const items: CtxItem[] = ARC_EDIT_MODE_MENU.map((act) => row(act, true, c));
  const x = at ? at.left : stage.getBoundingClientRect().left + 40, y = at ? at.bottom : stage.getBoundingClientRect().top + 40;
  E.contextMenuOpen = true; anchor = null;
  store.set({ contextMenu: { id: ++menuId, x, y, items } });
  requestRender();
}

/** A plain entry of a stand-alone popup (a dialog's wxMenu): a label and what it runs, a separator, or a radio / check row. */
export interface PopupEntry { sep?: boolean; label?: string; tip?: string; run?: () => void; check?: boolean; checked?: boolean; disabled?: boolean }
/** wxWindow::GetPopupMenuSelectionFromUser: a popup of plain rows at a client position, drawn by the chrome's context menu. */
export function openPopupMenu(x: number, y: number, entries: PopupEntry[]): void {
  runners = new Map(); anchor = null;
  const items: CtxItem[] = entries.map((e): CtxItem => {
    if (e.sep) return { sep: true };
    const it: CtxItem = { label: e.label || "" };
    if (e.check) { it.check = true; it.checked = !!e.checked; }
    if (e.run && !e.disabled) it.run = runRow(e.run); else it.why = e.tip || " ";
    return it;
  });
  E.contextMenuOpen = true;
  store.set({ contextMenu: { id: ++menuId, x, y, items } });
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
