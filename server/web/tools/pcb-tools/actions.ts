// pcb-tools/actions.ts — pcbnew's non-tool commands (pcb.actions): the action table, its dialogs and runAction.
import type { BoardDoc, FormField, PcbChange, PcbCtx, Pt } from "./types";
import type { RouterSettings } from "./router-settings";
import type { MeanderSettings } from "./meander";

/** One board command as menus, hotkeys and app.js run it (extra: menu, tip, check, toggle …). */
export interface PcbAction { id: string; label: string; key: string; run(ctx: PcbCtx): unknown; [extra: string]: unknown }
/** The tuner's settings in mm as Tuning Pattern Properties shows them. */
export type TuneView = ReturnType<typeof tuneSettingsView>;
/** The routing dialogs the editor bundle hands over (pcb.setRoutingDialogs). */
export interface RoutingDialogs {
  routerSettings?(ctx: PcbCtx): void; diffPair?(ctx: PcbCtx): void; layerPair?(ctx: PcbCtx): void; sizes?(ctx: PcbCtx): void;
  tuning?(req: { mode: string; settings: TuneView }, done: (v: TuneView) => void): void;
}
/** RequestSelection's options: the client filter, the lock filter (default on), quiet, and the re-run after Clarify Selection. */
export interface RequestOpts { filter?(it: KItem): boolean; locks?: boolean; quiet?: boolean; rerun?(ctx: PcbCtx): unknown }
import { root } from "../root";
import { appGlobal, editorState, gfxLayers, sizesOf } from "./app-state";
import { ARC_MODE_ACTIONS, arcDrawMode, setArcDrawMode, switchArcMode, syncArcDraw } from "./arcs";
import { arrayChanges } from "./array";
import { addedChange, boardNets, deleteChanges, replacedChange } from "./changes";
import { clipGet, clipSet, clipboardText, cursorPoint, duplicateChanges, pasteChanges, referencePoint, textOfItem } from "./clipboard";
import { connectedRun } from "./connected";
import { boardStatistics, convertChanges, footprintAttrChanges, justifyChanges, zonePriorityChanges } from "./convert";
import { copperOf, num0, openForm, settingsOf } from "./dialogs";
import { DIM_TYPE } from "./dimensions";
import { angleSnapMode, nextLineMode, setAngleSnap, stepDrawWidth } from "./draw-modes";
import { askText } from "./draw-tools";
import { drc, mm4 } from "./drc";
import { cycleVia, cycleWidth, stepLayer } from "./edit-commands";
import { applySelection, expandGroups, groupChanges, groupMembers, groupMembersChanges, groupOf, isLocked, lockChanges, selectedItems, selectionIds, topParentOf, ungroupChanges } from "./groups";
import { itemAt } from "./guess";
import { hitTestItem } from "./hit";
import { LENGTH_UNCONSTRAINED, TUNE_IU, setTargetLength, setTargetSkew, tuneCopy } from "./meander";
import { SELECTION_TYPES, filterIds, idsOnLayer, inspectClearance } from "./msgpanel";
import { connectedCopperIds, netHighlightIds, netInspector, netItemIds, netlist, ratsnest, selectionNets } from "./netlist";
import { netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { ARC_EDIT_ACTIONS, addCornerChanges, arcEditMode, canAddCorner, handleTol, nextArcEditMode, peSingleId, removeCornerChanges, setArcEditMode } from "./point-editor";
import { netUnder } from "./route-geom";
import { selectLayerAndPlaceVia, setLayer, startWithVia, toggleViaPlacement, undoRouteLeg, viaSpan } from "./route-tool";
import { CM_M45, CM_M90, CM_R45, CM_R90, RM_MARK, RM_SHOVE, RM_WALK, setRouterSettings } from "./router-settings";
import { beginCarryMove, moveTransform } from "./select-move";
import { K, S, bind, lastCtx } from "./state";
import { breakTrackChanges, cleanupChanges, cleanupPlan, trackEditChanges, trackLayerChanges } from "./track-edit";
import { alignChanges, anchorOf, bboxUnion, distributeChanges, flipChanges, mirrorChanges, moveExactChanges, packChanges, positionRelativeChanges, rotateChanges, swapChanges, topLeftAnchor, transformChanges } from "./transforms";
import { isTuningPattern, regenerateTuning, tuneStep, tuningPatternInfo } from "./tuning-patterns";
import { editTuningPattern, selectedTuningPattern, tuningNodeWithSettings } from "./tuning-edit";
import { isTuneTool, tuneMode, tuneUpdate } from "./tuning-tool";
import { clone, fmt, layerOf, r6, widthOf } from "./util";
import { diffPairMarkers, matchedLengthMarkers } from "./dru";

// ---------------------------------------------------------------- actions: pcbnew's non-tool commands
export const VIA_SIZES = [[0.6, 0.3], [0.8, 0.4], [1.0, 0.5], [1.2, 0.6], [1.6, 0.8]];
export const ACTIONS: Record<string, PcbAction> = {};
export function act(id: string, label: string, key: string, run: (ctx: PcbCtx) => unknown, extra?: Record<string, unknown>) { ACTIONS[id] = Object.assign({ id, label, key, run }, extra || {}); return ACTIONS[id]; }
export const alias = (id: string, of: string, label?: string, key?: string) => { ACTIONS[id] = Object.assign({}, ACTIONS[of], { id, label: label || ACTIONS[of].label, key: key || ACTIONS[of].key }); };
export function runAction(id: string, ctx: PcbCtx) { const a = ACTIONS[id]; if (!a) return false; bind(ctx); try { return !!a.run(ctx); } catch (e) { if (typeof console !== "undefined") console.warn(e); ctx.toast(`${a.label} failed: ${(e as Error).message}`); return true; } }
export const canEdit = (ctx: PcbCtx) => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
export const needSel = (ctx: PcbCtx, what?: string) => { const ids = selectionIds(ctx); if (!ids.size) { ctx.toast(what || "Select something first"); return null; } return ids; };
export const commitSel = (ctx: PcbCtx, changes: KChange[], label: string, keep?: boolean) => { if (!changes.length) { ctx.toast(`${label}: nothing to change`); return true; } ctx.commit(changes, label); if (keep !== false) ctx.requestRender(); return true; };
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function highlightIds(ctx: PcbCtx, ids: Set<string> | null) { if (ctx.setHighlight) ctx.setHighlight(ids && ids.size ? new Set(ids) : null); }
// Line Modes (BOARD_EDITOR_CONTROL::ChangeLineMode) and lineModeNext (Shift+Space)
act("lineModeFree", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "free"); return true; });
act("lineMode90", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "90"); return true; });
act("lineMode45", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "45"); return true; });
act("lineModeNext", "Line Modes", "Shift+Space", (ctx: PcbCtx) => { setAngleSnap(ctx, nextLineMode(angleSnapMode())); return true; });
act("incWidth", "Increase Line Width", "Ctrl++", (ctx: PcbCtx) => stepDrawWidth(ctx, 1));
act("decWidth", "Decrease Line Width", "Ctrl+-", (ctx: PcbCtx) => stepDrawWidth(ctx, -1));
// clipboard
// EDIT_TOOL::copyToClipboard / cutToClipboard: the selection, or the item under the cursor (a hover selection);
// the reference point is the anchor nearest the cursor.  KiCad writes "Selection copied" to the status bar only.
act("copy", "Copy", "Ctrl+C", (ctx: PcbCtx) => {
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("copy", c) }); if (!sel) return true;
  clipSet(ctx, clipboardText(ctx.doc, sel.ids, referencePoint(ctx.doc, sel.ids, cursorPoint(ctx)))); endHover(ctx, sel); return true;
});
act("cut", "Cut", "Ctrl+X", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("cut", c) }); if (!sel) return true;
  clipSet(ctx, clipboardText(ctx.doc, sel.ids, referencePoint(ctx.doc, sel.ids, cursorPoint(ctx))));
  ctx.commit(deleteChanges(ctx.doc, sel.ids), "cut"); applySelection(ctx, []); return true;
});
export function pasteAt(ctx: PcbCtx, opts: { annotations: string; clearNets?: boolean }) {
  clipGet(ctx, (text: string) => {
    if (!text) return;
    const r = pasteChanges(ctx.doc, text, cursorPoint(ctx), opts); if (!r.changes.length) return;
    // EDIT_TOOL::Paste: the pasted items hang on the cursor by their reference point until a click places them
    ctx.commit(r.changes, "paste", { tentative: true }); applySelection(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice() });
  });
  return true;
}
// PCB_CONTROL::Paste: a plain paste keeps the references (PASTE_MODE::KEEP_ANNOTATIONS); Paste Special asks
// (DIALOG_PASTE_SPECIAL: the three reference modes, KEEP preselected, and "Clear net assignments")
act("paste", "Paste", "Ctrl+V", (ctx: PcbCtx) => canEdit(ctx) && pasteAt(ctx, { annotations: "keep" }));
act("pasteSpecial", "Paste Special…", "Ctrl+Shift+V", (ctx: PcbCtx) => canEdit(ctx) && openForm({ title: "Paste Special", width: 460, fields: [
  { k: "annotations", label: "Reference Designators", type: "radio", value: "keep", options: [["unique", "Assign unique reference designators to pasted symbols", "Finds the next available reference designator for any designators that already exist in the design."], ["keep", "Keep existing reference designators, even if they are duplicated"], ["clear", "Clear reference designators on all pasted symbols", "Replaces reference designators with 'REF**'."]] },
  { k: "clearNets", label: "Clear net assignments", type: "check", value: false, tip: "Remove the net information from all connected items before pasting" }],
  apply: (v: { annotations: string; clearNets: boolean }) => { pasteAt(ctx, { annotations: v.annotations, clearNets: !!v.clearNets }); } }));
act("duplicate", "Duplicate", "Ctrl+D", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("duplicate", c) }); if (!sel) return true;
  // EDIT_TOOL::Duplicate: the copies follow the cursor from where the originals are; a click places them (one
  // "Duplicate" step), Escape drops them; a hover selection is not kept afterwards
  const r = duplicateChanges(ctx.doc, sel.ids); if (!r.changes.length) return true;
  ctx.commit(r.changes, "duplicate", { tentative: true }); applySelection(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice(), restore: r.restore, hover: sel.hover }); return true;
});
act("duplicateIncrement", "Duplicate and Increment", "Ctrl+Shift+D", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("duplicateIncrement", c) }); if (!sel) return true;
  const r = duplicateChanges(ctx.doc, sel.ids, null, { increment: true }); if (!r.changes.length) return true;
  ctx.commit(r.changes, "duplicate", { tentative: true }); applySelection(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice(), restore: r.restore, hover: sel.hover }); return true;
});
act("copyAsText", "Copy as Text", "", (ctx: PcbCtx) => { const ids = needSel(ctx); if (!ids) return true; const t = Array.from(ids, (id) => textOfItem(ctx.doc.items.get(id)!)).filter(Boolean).join("\n"); clipSet(ctx, t); ctx.toast(t ? "Text copied" : "Nothing textual selected"); return true; });
// selection
act("selectNet", "Select Net", "", (ctx: PcbCtx) => {
  const ids = needSel(ctx, "Select a track, via or footprint first"); if (!ids) return true; const nl = netlist(ctx.doc); const out = new Set(ids);
  for (const key of selectionNets(ctx, nl)) for (const id of netItemIds(ctx.doc, key, nl)) if (ctx.doc.items.get(id)!.kind !== "footprint") out.add(id);
  applySelection(ctx, out); ctx.toast(`${plural(out.size, "item")} selected`); return true;
});
act("deselectNet", "Deselect Net", "", (ctx: PcbCtx) => { const ids = needSel(ctx); if (!ids) return true; const nl = netlist(ctx.doc); const drop = new Set(); for (const key of selectionNets(ctx, nl)) for (const id of netItemIds(ctx.doc, key, nl)) drop.add(id); applySelection(ctx, Array.from(ids).filter((id) => !drop.has(id))); return true; });
act("selectConnection", "Select/Expand Connection", "U", (ctx: PcbCtx) => { const ids = needSel(ctx, "Select a track first"); if (!ids) return true; const run = connectedRun(ctx.doc, ids); if (!run.size) { ctx.toast("No tracks in the selection"); return true; } for (const id of ids) run.add(id); applySelection(ctx, run); ctx.toast(run.size > ids.size ? `Selected the connected run (${run.size} items)` : "Nothing else connected"); return true; });
export function unconnectedNeighbours(ctx: PcbCtx) {
  const ids = needSel(ctx, "Select a footprint first"); if (!ids) return null; const out = new Set<string>();
  for (const l of ratsnest(ctx.doc)) { const [a, b] = l.ids; if (ids.has(a) && !ids.has(b)) out.add(b); else if (ids.has(b) && !ids.has(a)) out.add(a); }
  return Array.from(out).filter((id) => ctx.doc.items.get(id)!.kind === "footprint");
}
act("selectUnconnected", "Select Unconnected Footprints", "O", (ctx: PcbCtx) => { const n = unconnectedNeighbours(ctx); if (!n) return true; if (!n.length) { ctx.toast("Nothing unconnected to reach"); return true; } applySelection(ctx, n); ctx.toast(`${plural(n.length, "footprint")} at the other end of the ratsnest selected`); return true; });
act("grabUnconnected", "Grab Unconnected Footprints", "Shift+O", (ctx: PcbCtx) => { const n = unconnectedNeighbours(ctx); if (!n) return true; if (!n.length) { ctx.toast("Nothing unconnected to grab"); return true; } applySelection(ctx, n); ctx.toast(`${plural(n.length, "footprint")} selected — drag them into place`); return true; });
act("selectAllOnLayer", "Select All on Active Layer", "", (ctx: PcbCtx) => { const layer = ctx.activeLayer || S.layer; const ids = idsOnLayer(ctx.doc, layer); applySelection(ctx, ids); ctx.toast(`${plural(ids.size, "item")} on ${layer}`); return true; });
act("selectSameSheet", "Select Footprints on Same Sheet", "", (ctx: PcbCtx) => {
  const ids = needSel(ctx, "Select a footprint first"); if (!ids) return true; const sheets = new Set();
  for (const id of ids) { const it = ctx.doc.items.get(id); const sf = it!.kind === "footprint" && (K.kid(it!.node, "sheetfile") || K.kid(it!.node, "sheetname")); if (sf) sheets.add(K.str(sf[1])); }
  if (!sheets.size) { ctx.toast("The selection carries no sheet"); return true; } const out = new Set<string>();
  for (const it of ctx.doc.items.values()) if (it.kind === "footprint") { const sf = K.kid(it.node, "sheetfile") || K.kid(it.node, "sheetname"); if (sf && sheets.has(K.str(sf[1]))) out.add(it.id); }
  applySelection(ctx, out); ctx.toast(`${plural(out.size, "footprint")} on ${Array.from(sheets).join(", ")}`); return true;
});
act("filterSelection", "Filter Selected Items…", "", (ctx: PcbCtx) => {
  const ids = needSel(ctx); if (!ids) return true;
  return openForm({ title: "Filter Selected Items", fields: Object.keys(SELECTION_TYPES).map((t) => ({ k: t, label: t[0].toUpperCase() + t.slice(1), type: "check", value: true })), apply: (v: Record<string, boolean>) => { const kept = filterIds(ctx.doc, ids, v); applySelection(ctx, kept); ctx.toast(`${plural(kept.length, "item")} kept`); } });
});
act("unselectAll", "Unselect All", "", (ctx: PcbCtx) => { applySelection(ctx, []); return true; });
// placement
export const overrideLocks = () => !!appGlobal(() => editorState()!.overrideLocks, false);
export const LOCKED_WARNING = "Selection contains locked items. Enable 'Override locks' to operate on them.";
/**
 * Locked items sit out of every move, turn, flip, mirror and delete unless "Override locks" is ticked.  KiCad's
 * RequestSelection filters them (FilterCollectorForLockedItems: the item, or a group holding a locked member) and,
 * when anything was filtered, hands the action an empty selection: the whole action does nothing and
 * ReportFilteredLockedItems shows its infobar warning.  Returns the ids that may be edited: all of them, or none.
 */
export function unlockedIds(ctx: PcbCtx, ids: string[], quiet?: boolean) {
  if (overrideLocks()) return ids;
  const locked = ids.some((id: string) => { const it = ctx.doc.items.get(id); return it && isLocked(it.node); });
  if (!locked) return ids;
  if (!quiet) ctx.toast(LOCKED_WARNING, 3500);
  return [];
}
/**
 * The ids KiCad's hover selection would take at mm: the editor's Clarify Selection candidates (its hit test with
 * GuessSelectionCandidates applied) when the app supplies them, else the module's own pick.  A pad stands for its
 * footprint (FilterCollectorForFreePads), a group member for its group (FilterCollectorForHierarchy).
 */
export function cursorCandidates(ctx: PcbCtx, mm: Pt) {
  let ids: string[] | null = null;
  if (typeof ctx.candidatesAt === "function") { try { ids = ctx.candidatesAt(mm); } catch (e) { ids = null; } }
  if (!ids) { const it = itemAt(ctx, mm); ids = it ? [it.id] : []; }
  const out: string[] = [];
  for (let id of ids) {
    const h = typeof id === "string" ? id.indexOf("#") : -1; if (h > 0) id = id.slice(0, h);
    const top = topParentOf(ctx.doc, id); if (top) id = top.id;   // a group or generator member stands for its parent
    if (ctx.doc.items.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
/**
 * PCB_SELECTION_TOOL::RequestSelection for an EDIT_TOOL / BOARD_EDITOR_CONTROL action.  With items selected those
 * are the action's items; with nothing selected the item under the cursor is (KiCad's old-style hover selection,
 * selection.IsHover(): the action clears it again when it is done).  opts.filter(item) is the action's client filter
 * (markers, generated items, tracks for Swap …), opts.locks (default on) FilterCollectorForLockedItems.  When the
 * cursor is over several candidates the editor's Clarify Selection popup asks, and opts.rerun runs the action again
 * on the pick.  Returns { ids (groups expanded), items, hover } or null: nothing to act on, and nothing said.
 */
export function requestSelection(ctx: PcbCtx, opts?: RequestOpts) {
  opts = opts || {};
  // a generator (tuning pattern) passes the action's filter when one of its members does (it is a PCB_GROUP)
  const keep = (it: KItem): boolean => !!it && (!opts!.filter || (it.kind === "generated" ? groupMembers(it.node).some((id) => { const m = ctx.doc.items.get(id); return !!m && opts!.filter!(m); }) : opts!.filter(it)));
  let ids = Array.from(selectionIds(ctx)), hover = !!S.forceHover;
  if (!ids.length && S.padSel) { const i = S.padSel.lastIndexOf("#"), fp = S.padSel.slice(0, i); if (ctx.doc.items.has(fp)) ids = [fp]; }   // a selected pad stands for its footprint (FilterCollectorForFreePads)
  if (!ids.length) {
    hover = true;
    const at = ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx);
    const cands = cursorCandidates(ctx, at).filter((id) => keep(ctx.doc.items.get(id)!));
    if (!cands.length) return null;
    if (cands.length > 1 && opts.rerun && typeof ctx.clarify === "function") {
      // doSelectionMenu: the pick becomes the (hover) selection and the action runs on it
      ctx.clarify(cands, (fresh) => { S.forceHover = true; try { opts!.rerun!(fresh || ctx); } finally { S.forceHover = false; } });
      return null;
    }
    ids = [cands[0]];
  }
  ids = Array.from(expandGroups(ctx.doc, ids)).filter((id) => keep(ctx.doc.items.get(id)!) || ctx.doc.items.get(id)!.kind === "group");
  if (!ids.length) return null;
  if (opts.locks !== false && !unlockedIds(ctx, ids, opts.quiet).length) return null;
  return { ids, items: ids.map((id) => ctx.doc.items.get(id)).filter((it) => it && it.kind !== "group" && it.kind !== "generated") as KItem[], hover };
}
/** The end of an action on a hover selection: selection.IsHover() -> selectionClear. */
export function endHover(ctx: PcbCtx, sel: { hover: boolean } | null) { if (sel && sel.hover) applySelection(ctx, []); }
/**
 * EDIT_TOOL::updateModificationPoint: a lone item turns about its own position, several about the grid-snapped
 * centre of their bounding box.  Rotate takes the centre of a lone rectangle, polygon, text box or table instead.
 */
export function modificationPoint(ctx: PcbCtx, items: KItem[], forRotate: boolean): Pt {
  if (items.length === 1) {
    const it = items[0];
    if (forRotate && (it.kind === "gr_rect" || it.kind === "gr_poly" || it.kind === "gr_text_box" || it.kind === "table") && it.bbox) return [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2];
    return anchorOf(it);
  }
  const b = bboxUnion(items); const c = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
  return ctx.snapOn && ctx.snap ? ctx.snap(c) : c;
}
export function editableOrToast(ctx: PcbCtx, what: string) { const ids = selectionOrToast(ctx, what); if (!ids) return null; const free = unlockedIds(ctx, ids); return free.length ? free : null; }
export function selectionOrToast(ctx: PcbCtx, what: string) { const ids = needSel(ctx, what); return ids && canEdit(ctx) ? Array.from(expandGroups(ctx.doc, ids)) : null; }
// EDIT_TOOL::Move: the selection, or the item under the cursor (hover: selected while it moves, cleared after)
act("move", "Move", "M", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("move", c) }); if (!sel) return true;
  if (sel.hover) applySelection(ctx, sel.ids);
  beginCarryMove(ctx, { ids: sel.ids, hover: sel.hover }); return true;
});
act("moveExactly", "Move Exactly…", "Shift+M", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("moveExactly", c) }); if (!sel) return true; const ids = sel.ids;
  return openForm({ title: "Move Item Exactly", fields: [{ k: "dx", label: "Move X (mm)", type: "num", value: 0 }, { k: "dy", label: "Move Y (mm)", type: "num", value: 0 }, { k: "rotation", label: "Rotate (°)", type: "num", value: 0 }, { k: "about", label: "Rotate around", type: "select", value: "center", options: [["center", "Selection center"], ["anchor", "Item anchor"]] }],
    apply: (v: { dx: number; dy: number; rotation: number; about: string }) => commitSel(ctx, moveExactChanges(ctx.doc, ids, { dx: num0(v.dx, 0), dy: num0(v.dy, 0), rotation: num0(v.rotation, 0), about: v.about }), "move exactly") });
});
alias("moveExact", "moveExactly");
act("positionRelative", "Position Relative To…", "Shift+P", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("positionRelative", c) }); if (!sel) return true; const ids = sel.ids;
  const fps = Array.from(ctx.doc.items.values()).filter((it) => it.kind === "footprint" && !ids.includes(it.id)).sort((a, b) => (a.ref || "").localeCompare(b.ref || "", undefined, { numeric: true }));
  const items = ids.map((id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]; const a = topLeftAnchor(items);
  return openForm({ title: "Position Relative To Reference Item", fields: [
    { k: "ref", label: "Reference", type: "select", value: "origin", options: [["origin", "Grid origin (0, 0)"], ["point", "Point below"]].concat(fps.map((f) => [f.id, `${f.ref || f.lib} (${fmt(f.x!)}, ${fmt(f.y!)})`])) },
    { k: "px", label: "Point X (mm)", type: "num", value: r6(a[0]) }, { k: "py", label: "Point Y (mm)", type: "num", value: r6(a[1]) },
    { k: "dx", label: "Offset X (mm)", type: "num", value: 0 }, { k: "dy", label: "Offset Y (mm)", type: "num", value: 0 }],
    apply: (v: { ref: string; px: number; py: number; dx: number; dy: number }) => { const ref = v.ref === "origin" ? [0, 0] : v.ref === "point" ? [num0(v.px, 0), num0(v.py, 0)] : anchorOf(ctx.doc.items.get(v.ref)!); return commitSel(ctx, positionRelativeChanges(ctx.doc, ids, ref, num0(v.dx, 0), num0(v.dy, 0)), "position relative"); } });
});
for (const [id, mode, label] of [["alignLeft", "left", "Align to Left"], ["alignRight", "right", "Align to Right"], ["alignTop", "top", "Align to Top"], ["alignBottom", "bottom", "Align to Bottom"], ["alignCenterX", "centerX", "Align to Vertical Center"], ["alignCenterY", "centerY", "Align to Horizontal Center"]])
  act(id, label, "", (ctx: PcbCtx) => { const ids = editableOrToast(ctx, "Select two or more items to align"); if (!ids) return true; return commitSel(ctx, alignChanges(ctx.doc, ids, mode, ctx.cursor!), label.toLowerCase()); });
for (const [id, axis, centers, label] of [["distributeH", "x", false, "Distribute Horizontally by Gaps"], ["distributeV", "y", false, "Distribute Vertically by Gaps"], ["distributeHCenters", "x", true, "Distribute Horizontally by Centers"], ["distributeVCenters", "y", true, "Distribute Vertically by Centers"]] as [string, string, boolean, string][])
  act(id, label, "", (ctx: PcbCtx) => { const ids = editableOrToast(ctx, "Select three or more items to distribute"); if (!ids) return true; if (ids.length < 3) { ctx.toast("Distribute needs at least three items"); return true; } return commitSel(ctx, distributeChanges(ctx.doc, ids, axis, centers), label.toLowerCase()); });
alias("distributeHorizontallyGaps", "distributeH"); alias("distributeVerticallyGaps", "distributeV"); alias("distributeHorizontallyCenters", "distributeHCenters"); alias("distributeVerticallyCenters", "distributeVCenters");
/**
 * A board footprint the app itself is dragging (its pointer drag) goes over to the module's move first, so a turn
 * in flight has a move session to act on (ctx.handoffDrag, from the editor).
 */
export const moveInFlight = (ctx: PcbCtx) => !!S.move || !!(ctx.handoffDrag && ctx.handoffDrag() && S.move);
/** EDIT_TOOL::Rotate: about the modification point; a hover selection is cleared afterwards; while moving, the move turns. */
export function rotateBy(ctx: PcbCtx, deg: number) {
  if (S.route) return true;   // isRouterActive: wxBell
  if (moveInFlight(ctx)) return moveTransform(ctx, "rotate", deg);
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => rotateBy(c, deg) }); if (!sel) return true;
  const c = modificationPoint(ctx, sel.items, true);
  const ch = rotateChanges(ctx.doc, sel.ids, c[0], c[1], deg); if (ch.length) ctx.commit(ch, "rotate");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
act("rotateSelection", "Rotate Counterclockwise", "R", (ctx: PcbCtx) => rotateBy(ctx, 90)); alias("rotateCcw", "rotateSelection");
act("rotateSelectionCw", "Rotate Clockwise", "", (ctx: PcbCtx) => rotateBy(ctx, -90)); alias("rotateCw", "rotateSelectionCw");
/**
 * EDIT_TOOL::Flip ("Change Side / Flip"): a lone item about its own position (a rectangle or table about its centre),
 * several about the middle of their box; nothing is said afterwards.
 */
export function flipBy(ctx: PcbCtx) {
  if (S.route) return true;
  if (moveInFlight(ctx)) return moveTransform(ctx, "flip");
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => flipBy(c) }); if (!sel) return true;
  const items = sel.items, one = items.length === 1 && items[0]!.kind !== "gr_rect" && items[0]!.kind !== "table";
  const b = bboxUnion(items); const cx = one ? anchorOf(items[0]!)[0] : b ? (b[0] + b[2]) / 2 : 0;
  const ch = flipChanges(ctx.doc, sel.ids, cx); if (ch.length) ctx.commit(ch, "flip");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
act("flipSelection", "Flip", "F", (ctx: PcbCtx) => flipBy(ctx));
alias("flip", "flipSelection");
export const MIRROR_FOOTPRINTS = "Footprints cannot be mirrored. Use Flip to move them to the other side of the board.";
export const MIRROR_GROUPS = "Groups containing footprints or other items that cannot be mirrored were skipped.";
/**
 * EDIT_TOOL::Mirror (mirrorH / mirrorV): graphics, text, tracks, zones … in place about the modification point (a lone
 * item's position, else the grid-snapped centre of the selection).  Footprints are skipped (MIRROR_SKIPS), and so is a
 * group holding one, with KiCad's infobar message.
 */
export function mirrorBy(ctx: PcbCtx, axis: string) {
  if (S.route) return true;
  if (moveInFlight(ctx)) return moveTransform(ctx, "mirror", axis);
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => mirrorBy(c, axis) }); if (!sel) return true;
  const doc = ctx.doc; let footprints = 0, groups = 0; const skip = new Set();
  for (const id of sel.ids) {
    const it = doc.items.get(id); if (!it || it.kind !== "group" || groupOf(doc, id)) continue;   // the top-level groups
    const inner = Array.from(expandGroups(doc, [id]));
    if (inner.some((x) => { const m = doc.items.get(x); return m && m.kind === "footprint"; })) { groups++; inner.forEach((x) => skip.add(x)); }
  }
  for (const it of sel.items) if (it!.kind === "footprint" && !skip.has(it!.id)) footprints++;
  const ids = sel.ids.filter((id) => !skip.has(id)); const items = ids.map((id) => doc.items.get(id)).filter((it) => it && it.kind !== "group") as KItem[];
  if (items.length) { const c = modificationPoint(ctx, items, false); const ch = mirrorChanges(doc, ids, c[0], c[1], axis); if (ch.length) ctx.commit(ch, "mirror"); }
  if (footprints) ctx.toast(MIRROR_FOOTPRINTS, 3500); else if (groups) ctx.toast(MIRROR_GROUPS, 3500);
  endHover(ctx, sel); ctx.requestRender(); return true;
}
for (const [id, axis, label] of [["mirrorH", "h", "Mirror Horizontally"], ["mirrorV", "v", "Mirror Vertically"]]) act(id, label, "", (ctx: PcbCtx) => mirrorBy(ctx, axis));
// EDIT_TOOL::Swap (no tracks: PCB_TRACE_T is filtered) and PackAndMoveFootprints (footprints only)
act("swap", "Swap", "Alt+S", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: (it: KItem) => it.kind !== "segment", rerun: (c: PcbCtx) => runAction("swap", c) }); if (!sel) return true;
  const ch = swapChanges(ctx.doc, sel.ids); if (ch.length) ctx.commit(ch, "swap"); endHover(ctx, sel); ctx.requestRender(); return true;
});
act("pack", "Pack and Move Footprints", "P", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: (it: KItem) => it.kind === "footprint" || it.kind === "group", rerun: (c: PcbCtx) => runAction("pack", c) }); if (!sel) return true;
  const ch = packChanges(ctx.doc, sel.ids); if (ch.length) ctx.commit(ch, "pack footprints"); endHover(ctx, sel); ctx.requestRender(); return true;
});
alias("packAndMoveFootprints", "pack");
act("createArray", "Create Array…", "", (ctx: PcbCtx) => {   // DIALOG_CREATE_ARRAY lives in web/editor/pcbdialogs/array.ts; this short form stands in without it
  const ids = selectionOrToast(ctx, "Select items to array"); if (!ids) return true;
  return openForm({ title: "Create Array", fields: [{ k: "nx", label: "Horizontal count", type: "num", value: 5, step: "1" }, { k: "ny", label: "Vertical count", type: "num", value: 5, step: "1" }, { k: "dx", label: "Horizontal spacing (mm)", type: "num", value: 2.54 }, { k: "dy", label: "Vertical spacing (mm)", type: "num", value: 2.54 }],
    apply: (v: { nx: number; ny: number; dx: number; dy: number }) => { const r = arrayChanges(ctx.doc, ids, { type: "grid", nx: num0(v.nx, 1), ny: num0(v.ny, 1), dx: num0(v.dx, 0), dy: num0(v.dy, 0), offX: 0, offY: 0, stagger: 1, staggerRows: true, centred: false, hThenV: true }); if (!r.changes.length) return; ctx.commit(r.changes, r.label); applySelection(ctx, r.ids); } });
});
act("swapLayers", "Swap Layers…", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const copper = copperOf(doc); const layers = copper.concat(gfxLayers(doc).filter((l) => !copper.includes(l)));
  return openForm({ title: "Swap Layers", width: 380, fields: layers.map((l) => ({ k: l, label: l, type: "select", value: l, options: layers })), apply: (v: Record<string, string>) => {
    const map: Record<string, string> = {}; for (const l of layers) if (v[l] && v[l] !== l) map[l] = v[l]; if (!Object.keys(map).length) { ctx.toast("No layers swapped"); return; }
    const ch = transformChanges(doc, Array.from(doc.items.keys()), (n, it: KItem) => {
      if (it.kind === "footprint" || it.kind === "group") return false; let did = false;
      const l = K.kid(n, "layer"); if (l && map[K.str(l[1])]) { l[1] = map[K.str(l[1])]; did = true; }
      const ls = K.kid(n, "layers"); if (ls) for (let i = 1; i < ls.length; i++) if (map[K.str(ls[i])]) { ls[i] = map[K.str(ls[i])]; did = true; }
      if (it.kind === "zone") for (const fp of K.kids(n, "filled_polygon")) { const fl = K.kid(fp, "layer"); if (fl && map[K.str(fl[1])]) { fl[1] = map[K.str(fl[1])]; did = true; } }
      if (it.kind === "dimension") { const gt = K.kid(n, "gr_text"); const gl = gt && K.kid(gt, "layer"); if (gl && map[K.str(gl[1])]) { gl[1] = map[K.str(gl[1])]; did = true; } }
      return did ? undefined : false;
    });
    commitSel(ctx, ch, "swap layers");
  } });
});
// tracks and vias
act("changeTrackWidth", "Change Track Width / Via Size…", "", (ctx: PcbCtx) => {
  const ids = selectionOrToast(ctx, "Select tracks or vias first"); if (!ids) return true; const copper = copperOf(ctx.doc);
  const items = ids.map((id) => ctx.doc.items.get(id)); const seg = items.find((it) => it!.kind === "segment" || it!.kind === "arc"), via = items.find((it) => it!.kind === "via");
  if (!seg && !via) { ctx.toast("No tracks or vias in the selection"); return true; }
  const vl = via ? (K.kid(via.node, "layers") || [0, "F.Cu", "B.Cu"]).slice(1).map(K.str) : ["F.Cu", "B.Cu"];
  return openForm({ title: "Track & Via Properties", fields: [
    { k: "netclass", label: "Use netclass values", type: "check", value: false },
    { k: "width", label: "Track width (mm)", type: "num", value: seg ? widthOf(seg.node, 0.25) : "" },
    { k: "viaSize", label: "Via diameter (mm)", type: "num", value: via ? K.num((K.kid(via.node, "size") || [0, 0.8])[1]) : "" }, { k: "viaDrill", label: "Via drill (mm)", type: "num", value: via ? K.num((K.kid(via.node, "drill") || [0, 0.4])[1]) : "" },
    { k: "viaType", label: "Via type", type: "select", value: via ? (via.node.includes("micro") ? "micro" : via.node.includes("blind") ? "blind" : "through") : "through", options: [["through", "Through"], ["blind", "Blind/buried"], ["micro", "Micro"]] },
    { k: "l0", label: "Via start layer", type: "select", value: vl[0], options: copper }, { k: "l1", label: "Via end layer", type: "select", value: vl[1] || copper[copper.length - 1], options: copper }],
    apply: (v: { netclass: boolean; width: number; viaSize: number; viaDrill: number; viaType: string; l0: string; l1: string }) => commitSel(ctx, trackEditChanges(ctx.doc, ids, { netclass: v.netclass, width: num0(v.width, 0), viaSize: num0(v.viaSize, 0), viaDrill: num0(v.viaDrill, 0), viaType: v.viaType, viaLayers: [v.l0, v.l1] }, settingsOf(ctx)), "track width") });
});
alias("editTracksAndVias", "changeTrackWidth");
act("setTrackWidthFromNetclass", "Set Track / Via Sizes from Netclass", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select tracks or vias first"); if (!ids) return true; return commitSel(ctx, trackEditChanges(ctx.doc, ids, { netclass: true }, settingsOf(ctx)), "netclass sizes"); });
act("trackWidthInc", "Increase Track Width", "W", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleWidth(ctx, 1); return true; });
act("trackWidthDec", "Decrease Track Width", "Shift+W", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleWidth(ctx, -1); return true; });
act("viaSizeInc", "Increase Via Size", "'", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleVia(ctx, 1); return true; }); act("viaSizeDec", "Decrease Via Size", "\\", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleVia(ctx, -1); return true; });
act("autoTrackWidth", "Automatically select track width", "", (ctx: PcbCtx) => { const on = sizesOf(ctx).toggleConnectedWidth(); ctx.toast(on ? "Routing from an existing track uses its width" : "New tracks take the current width setting"); return true; }, { toggle: () => !!K.pcbSizes.state.useConnectedWidth, menu: "-" });
// the active layer (PCB_CONTROL): PgUp / PgDn, + / -, and V with nothing being routed toggles within the routing pair
act("layerTop", "Switch to Component (F.Cu) layer", "PgUp", (ctx: PcbCtx) => { setLayer(ctx, viaSpan(ctx.doc)[0]); return true; }, { menu: "-" });
act("layerBottom", "Switch to Copper (B.Cu) Layer", "PgDn", (ctx: PcbCtx) => { setLayer(ctx, viaSpan(ctx.doc)[1]); return true; }, { menu: "-" });
act("layerNext", "Switch to Next Layer", "+", (ctx: PcbCtx) => stepLayer(ctx, true), { menu: "-" });
act("layerPrev", "Switch to Previous Layer", "-", (ctx: PcbCtx) => stepLayer(ctx, false), { menu: "-" });
act("layerToggle", "Toggle Layer", "", (ctx: PcbCtx) => { setLayer(ctx, sizesOf(ctx).pairedLayer(S.route ? S.route.layer : S.layer)); return true; }, { menu: "-" });
act("ratsnestLineMode", "Curved Ratsnest Lines", "", (ctx: PcbCtx) => { const R = sizesOf(ctx); R.setCurvedRatsnest(!R.curvedRatsnest); ctx.requestRender(); return true; }, { toggle: () => !!K.pcbSizes.state.curvedRatsnest, menu: "-" });
// the two routing dialogs are built by the editor bundle (web/editor/pcbrouting.ts) and handed over through pcb.setRoutingDialogs
export let routingDialogs: RoutingDialogs = {};
// ROUTER_TOOL: the router's mode (PCB_ACTIONS::routerHighlightMode / routerShoveMode / routerWalkaroundMode, cycleRouterMode),
// its settings dialog, the corner modes and the via commands (ACT_* in router_tool.cpp; context hotkeys in onCaptureKey / onKey)
export const ROUTER_ACTION = { menu: false };
act("routerHighlightMode", "Router Highlight Mode", "", () => { setRouterSettings({ mode: RM_MARK }); return true; }, Object.assign({ tip: "Switch router to highlight mode", check: () => S.rs.mode === RM_MARK }, ROUTER_ACTION));
act("routerShoveMode", "Router Shove Mode", "", () => { setRouterSettings({ mode: RM_SHOVE }); return true; }, Object.assign({ tip: "Switch router to shove mode", check: () => S.rs.mode === RM_SHOVE }, ROUTER_ACTION));
act("routerWalkaroundMode", "Router Walkaround Mode", "", () => { setRouterSettings({ mode: RM_WALK }); return true; }, Object.assign({ tip: "Switch router to walkaround mode", check: () => S.rs.mode === RM_WALK }, ROUTER_ACTION));
act("cycleRouterMode", "Cycle Router Mode", "", () => { setRouterSettings({ mode: S.rs.mode === RM_MARK ? RM_SHOVE : S.rs.mode === RM_SHOVE ? RM_WALK : RM_MARK }); return true; }, Object.assign({ tip: "Cycle router to the next mode" }, ROUTER_ACTION));
act("routerSettingsDialog", "Interactive Router Settings...", "", (ctx: PcbCtx) => { if (routingDialogs.routerSettings) routingDialogs.routerSettings(ctx); else ctx.toast("Interactive Router Settings: dialogs are unavailable here"); return true; }, { menu: "Route", tip: "Open Interactive Router settings" });
// the length tuner's settings and steps (PCB_ACTIONS::lengthTunerSettings, spacingIncrease / spacingDecrease, amplIncrease / amplDecrease)
/** The tuner's settings in mm as the Tuning Pattern Properties dialog shows them. */
export function tuneSettingsView(st: MeanderSettings, mode: string) {
  const tgt = mode === "skew" ? st.skew.opt / TUNE_IU : st.target.opt === LENGTH_UNCONSTRAINED ? null : st.target.opt / TUNE_IU;
  return { targetLength: tgt, minAmp: st.minAmp / TUNE_IU, maxAmp: st.maxAmp / TUNE_IU, spacing: st.spacing / TUNE_IU,
    round: st.round, crPct: st.crPct, singleSided: st.singleSided, overrideCustomRules: st.overrideCustomRules };
}
/** DIALOG_TUNING_PATTERN_PROPERTIES::TransferDataFromWindow onto MEANDER_SETTINGS. */
export function applyTuneSettings(st: MeanderSettings, v: TuneView, mode: string) {
  if (mode === "skew") setTargetSkew(st, v.targetLength == null ? 0 : Math.round(v.targetLength * TUNE_IU));
  else setTargetLength(st, v.targetLength == null ? LENGTH_UNCONSTRAINED : Math.round(v.targetLength * TUNE_IU));
  st.overrideCustomRules = !!v.overrideCustomRules;
  st.minAmp = Math.round(v.minAmp * TUNE_IU); st.maxAmp = Math.round(v.maxAmp * TUNE_IU); st.spacing = Math.round(v.spacing * TUNE_IU);
  st.round = !!v.round; st.crPct = Math.round(v.crPct); st.singleSided = !!v.singleSided;
}
export function openTuneSettings(ctx: PcbCtx) {
  const mode = tuneMode(); const T = S.tune.pattern; const cur = T ? T.st : S.tuneSettings[mode];
  if (!routingDialogs.tuning) { ctx.toast("Length Tuning Settings: dialogs are unavailable here"); return true; }
  routingDialogs.tuning({ mode: mode === "skew" ? "diff_pair_skew" : mode === "diffpair" ? "diff_pair" : "single", settings: tuneSettingsView(cur, mode) }, (v) => {
    applyTuneSettings(S.tuneSettings[mode], v, mode);   // StoreDefaults
    if (S.tune.pattern) { const side = S.tune.pattern.st.initialSide; S.tune.pattern.st = tuneCopy(S.tuneSettings[mode]); S.tune.pattern.st.initialSide = side; tuneUpdate(lastCtx || ctx); }   // ApplyToolSettings, updateTuningPattern
    (lastCtx || ctx).requestRender();
  });
  return true;
}
// handled only inside the tuner's event loop (PCB_TUNING_PATTERN's tool, pcb_tuning_pattern.cpp): elsewhere Ctrl+L does
// nothing (the key is still taken, so the browser does not move focus to its address bar)
act("lengthTunerSettings", "Length Tuning Settings...", "Ctrl+L", (ctx: PcbCtx) => (isTuneTool(S.modTool) ? openTuneSettings(ctx) : true), { menu: false, tip: "Displays tuning pattern properties dialog" });
/** The tuner's loop takes PCB_ACTIONS::properties like lengthTunerSettings: E opens Tuning Pattern Properties. */
export function tunerProperties(ctx: PcbCtx) {
  bind(ctx);
  if (isTuneTool(S.modTool)) return openTuneSettings(ctx);
  // EDIT_TOOL::Properties on a selected pattern: PCB_TUNING_PATTERN::ShowPropertiesDialog
  const gen = selectedTuningPattern(ctx); if (!gen) return false;
  return openPatternProperties(ctx, gen);
}
/**
 * PCB_TUNING_PATTERN::ShowPropertiesDialog: Tuning Pattern Properties prefilled from the pattern (a custom rule's
 * length / skew prefills the target unless the pattern overrides custom rules); OK re-tunes it in one commit,
 * "Edit Tuning Pattern".
 */
export function openPatternProperties(ctx: PcbCtx, gen: KItem) {
  if (!routingDialogs.tuning) { ctx.toast("Tuning Pattern Properties: dialogs are unavailable here"); return true; }
  const info = tuningPatternInfo(gen); const mode = info.mode === "diff_pair_skew" ? "skew" : "single"; const st = tuneCopy(info.st);
  if (!st.overrideCustomRules && S.ruleConstraint) {
    const mem = K.groupMemberIds(gen.node).map((id) => ctx.doc.items.get(id)).filter((it) => it && (it.kind === "segment" || it.kind === "arc")) as KItem[];
    const c = S.ruleConstraint(ctx.doc, mode === "skew" ? "skew" : "length", mem[0] || null, null);
    if (c && c.opt != null) { if (mode === "skew") setTargetSkew(st, Math.round(c.opt * TUNE_IU)); else setTargetLength(st, Math.round(c.opt * TUNE_IU)); if (mode !== "skew" && c.min != null && c.max != null) st.target = { min: Math.round(c.min * TUNE_IU), opt: Math.round(c.opt * TUNE_IU), max: Math.round(c.max * TUNE_IU) }; }
  }
  routingDialogs.tuning({ mode: info.mode === "diff_pair_skew" ? "diff_pair_skew" : info.mode === "diff_pair" ? "diff_pair" : "single", settings: tuneSettingsView(st, mode) }, (v) => {
    const c = lastCtx || ctx; const cur = c.doc.items.get(gen.id); if (!cur || !canEdit(c)) return;
    const next = tuneCopy(st); applyTuneSettings(next, v, mode); next.initialSide = st.initialSide;
    editTuningPattern(c, cur, tuningNodeWithSettings(cur.node, next, info.mode)); c.requestRender();
  });
  return true;
}
act("spacingIncrease", "Increase Spacing", "1", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "spacing", 1) : false, { menu: false, tip: "Increase tuning pattern spacing by one step." });
act("spacingDecrease", "Decrease Spacing", "2", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "spacing", -1) : false, { menu: false, tip: "Decrease tuning pattern spacing by one step." });
act("amplIncrease", "Increase Amplitude", "3", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "ampl", 1) : false, { menu: false, tip: "Increase tuning pattern amplitude by one step." });
act("amplDecrease", "Decrease Amplitude", "4", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "ampl", -1) : false, { menu: false, tip: "Decrease tuning pattern amplitude by one step." });
// GENERATOR_TOOL: Edit > Update All Tuning Patterns (and Tools > Rebuild All / Selected Generators where shown)
act("regenerateAllTuning", "Update All Tuning Patterns", "", (ctx: PcbCtx) => regenerateTuning(ctx, [...ctx.doc.items.values()].filter(isTuningPattern), "Update Tuning Patterns"), { menu: false, tip: "Attempt to re-tune existing tuning patterns within their bounds" });
act("regenerateAll", "Rebuild All Generators", "", (ctx: PcbCtx) => regenerateTuning(ctx, [...ctx.doc.items.values()].filter(isTuningPattern), "Regenerate All"), { menu: false, tip: "Rebuilds geometry of all generators" });
act("regenerateSelected", "Rebuild Selected Generators", "", (ctx: PcbCtx) => { const sel = expandGroups(ctx.doc, selectionIds(ctx)); return regenerateTuning(ctx, [...sel].map((id) => ctx.doc.items.get(id)).filter(isTuningPattern), "Regenerate Selected"); }, { menu: false, tip: "Rebuilds geometry of selected generator(s)" });
// handlePnSCornerModeChange: Ctrl+/ steps MITERED_45 → ROUNDED_45 → MITERED_90 → ROUNDED_90
act("ACT_SwitchCornerModeToNext", "Track Corner Mode Switch", "", () => { setRouterSettings({ corner_mode: (S.rs.corner_mode + 1) % 4 }); return true; }, Object.assign({ tip: "Switches between sharp/rounded and 45°/90° corners when routing tracks." }, ROUTER_ACTION));
act("ACT_SwitchCornerMode45", "Track Corner Mode 45", "", () => { setRouterSettings({ corner_mode: CM_M45 }); return true; }, Object.assign({ tip: "Switch to 45° corner when routing tracks.", check: () => S.rs.corner_mode === CM_M45 }, ROUTER_ACTION));
act("ACT_SwitchCornerModeArc45", "Track Corner Mode Arc 45", "", () => { setRouterSettings({ corner_mode: CM_R45 }); return true; }, Object.assign({ tip: "Switch to arc 45° corner when routing tracks.", check: () => S.rs.corner_mode === CM_R45 }, ROUTER_ACTION));
act("ACT_SwitchCornerMode90", "Track Corner Mode 90", "", () => { setRouterSettings({ corner_mode: CM_M90 }); return true; }, Object.assign({ tip: "Switch to 90° corner when routing tracks.", check: () => S.rs.corner_mode === CM_M90 }, ROUTER_ACTION));
act("ACT_SwitchCornerModeArc90", "Track Corner Mode Arc 90", "", () => { setRouterSettings({ corner_mode: CM_R90 }); return true; }, Object.assign({ tip: "Switch to arc 90° corner when routing tracks.", check: () => S.rs.corner_mode === CM_R90 }, ROUTER_ACTION));
export const routingOnly = (ctx: PcbCtx, fn: () => void) => { if (!S.route) return false; if (!canEdit(ctx)) return true; fn(); return true; };
act("ACT_PlaceThroughVia", "Place Through Via", "", (ctx: PcbCtx) => {
  if (S.route) return routingOnly(ctx, () => toggleViaPlacement(ctx, "through"));
  if (S.modTool === "routediff") return true;   // the pair's vias come with a route (DIFF_PAIR_PLACER::ToggleVia)
  if (S.modTool !== "route") return false;
  startWithVia(ctx); return true;
}, Object.assign({ tip: "Adds a through-hole via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_PlaceBlindVia", "Place Blind/Buried Via", "", (ctx: PcbCtx) => routingOnly(ctx, () => toggleViaPlacement(ctx, "blind")), Object.assign({ tip: "Adds a blind or buried via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_PlaceMicroVia", "Place Microvia", "", (ctx: PcbCtx) => routingOnly(ctx, () => toggleViaPlacement(ctx, "micro")), Object.assign({ tip: "Adds a microvia at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceThroughVia", "Select Layer and Place Through Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "through")), Object.assign({ tip: "Select a layer, then add a through-hole via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceBlindVia", "Select Layer and Place Blind/Buried Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "blind")), Object.assign({ tip: "Select a layer, then add a blind or buried via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceMicroVia", "Select Layer and Place Micro Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "micro")), Object.assign({ tip: "Select a layer, then add a micro via at the end of currently routed track." }, ROUTER_ACTION));
act("routerDiffPairDialog", "Differential Pair Dimensions...", "", (ctx: PcbCtx) => { if (routingDialogs.diffPair) routingDialogs.diffPair(ctx); else ctx.toast("Differential Pair Dimensions: dialogs are unavailable here"); return true; }, Object.assign({ tip: "Open Differential Pair Dimension settings" }, ROUTER_ACTION));
act("routerUndoLastSegment", "Undo Last Segment", "", (ctx: PcbCtx) => routingOnly(ctx, () => undoRouteLeg(ctx)), Object.assign({ tip: "Walks the current track back one segment." }, ROUTER_ACTION));
act("selectLayerPair", "Set Layer Pair...", "", (ctx: PcbCtx) => { if (routingDialogs.layerPair) routingDialogs.layerPair(ctx); else ctx.toast("Set Layer Pair: dialogs are unavailable here"); return true; }, { menu: "-" });
act("editPredefinedSizes", "Edit Pre-defined Sizes...", "", (ctx: PcbCtx) => { if (routingDialogs.sizes) routingDialogs.sizes(ctx); else ctx.toast("Edit Pre-defined Sizes: dialogs are unavailable here"); return true; }, { menu: "-" });
// the grid origin and the drill / place file origin: picked with a one-shot tool, reset to the page origin
act("gridResetOrigin", "Reset Grid Origin", "", (ctx: PcbCtx) => { sizesOf(ctx).setGridOrigin([0, 0]); ctx.toast("Grid origin reset"); ctx.requestRender(); return true; }, { menu: "-" });
act("drillResetOrigin", "Reset Drill Origin", "", (ctx: PcbCtx) => { if (canEdit(ctx)) { sizesOf(ctx).setAuxOrigin([0, 0]); ctx.toast("Drill/place file origin reset"); ctx.requestRender(); } return true; }, { menu: "-" });
act("changeTrackLayerNext", "Move Track to Next Layer", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select tracks first"); if (!ids) return true; return commitSel(ctx, trackLayerChanges(ctx.doc, ids, 1), "track layer"); });
act("changeTrackLayerPrev", "Move Track to Previous Layer", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select tracks first"); if (!ids) return true; return commitSel(ctx, trackLayerChanges(ctx.doc, ids, -1), "track layer"); });
act("cleanupTracks", "Cleanup Tracks & Vias…", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const preview = cleanupPlan(doc, {});
  const opts = [["shorts", "Delete tracks connecting different nets"], ["vias", "Delete redundant vias"], ["merge", "Merge co-linear tracks"], ["dangling", "Delete tracks unconnected at one end"], ["danglingVias", "Delete dangling vias"], ["inPads", "Delete tracks fully inside pads"]];
  return openForm({ title: "Cleanup Tracks and Vias", width: 480, fields: opts.map(([k, label]): FormField => ({ k, label, type: "check", value: true })).concat([{ k: "list", type: "table", columns: [{ label: "Action", width: "1fr" }, { label: "Items", width: "60px" }], rows: preview.items.map((i) => [i.text, i.ids.length]), empty: "Nothing to clean up with every option on.", onRow: (i: number) => highlightIds(ctx, new Set(preview.items[i].ids)) }]),
    apply: (v: Record<string, boolean>) => { const plan = cleanupPlan(doc, v); const ch = cleanupChanges(doc, plan); highlightIds(ctx, null); if (!ch.length) { ctx.toast("Nothing to clean up"); return; } ctx.commit(ch, "cleanup tracks"); ctx.toast(`Cleanup: ${plural(plan.items.length, "change")}`); } });
});
alias("cleanupTracksAndVias", "cleanupTracks");
act("breakTrack", "Break Track", "", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; const seg = selectedItems(ctx).find((it) => it.kind === "segment"); return commitSel(ctx, breakTrackChanges(ctx.doc, cursorPoint(ctx), seg && hitTestItem(ctx.doc, cursorPoint(ctx)[0], cursorPoint(ctx)[1], 0.3) === seg ? seg : null), "break track"); });
act("unrouteSelected", "Unroute Selected", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints or tracks to unroute"); if (!ids) return true; const nl = netlist(ctx.doc); const seeds = new Set(ids); const remove = connectedCopperIds(nl, seeds); return commitSel(ctx, deleteChanges(ctx.doc, Array.from(remove)), "unroute"); });
act("deleteFull", "Delete Full Track", "Shift+Delete", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select a track first"); if (!ids) return true; const run = connectedRun(ctx.doc, ids); for (const id of ids) run.add(id); S.sel.clear(); return commitSel(ctx, deleteChanges(ctx.doc, Array.from(run)), "delete full track"); });
// inspection
act("runDRC", "Design Rules Checker…", "", (ctx: PcbCtx) => {
  bind(ctx); const s = settingsOf(ctx); S.markers = drc(ctx.doc, s, { rules: S.dru ? S.dru.rules : null }).concat(S.dru ? matchedLengthMarkers(ctx.doc, s, S.dru.rules).concat(diffPairMarkers(ctx.doc, s, S.dru.rules)) : []); ctx.requestRender();
  const errors = S.markers.filter((m) => m.severity === "error").length, warnings = S.markers.length - errors;
  openForm({ title: "DRC Control", width: 620, fields: [{ type: "note", value: `${plural(errors, "error")}, ${plural(warnings, "warning")} — click a row to highlight it.` }, { k: "list", type: "table", columns: [{ label: "Severity", width: "70px" }, { label: "Violation", width: "1fr" }], rows: S.markers.map((m) => [m.severity, m.text]), empty: "No violations found.", onRow: (i: number) => { highlightIds(ctx, new Set(S.markers[i].ids)); if (ctx.setSelection && S.markers[i].ids.length) applySelection(ctx, S.markers[i].ids); } }], apply: () => { highlightIds(ctx, null); } });
  return true;
});
act("clearMarkers", "Clear DRC Markers", "", (ctx: PcbCtx) => { S.markers = []; ctx.requestRender(); return true; });
act("netInspector", "Net Inspector…", "", (ctx: PcbCtx) => {
  const rows = netInspector(ctx.doc);
  return openForm({ title: "Net Inspector", width: 640, fields: [{ k: "list", type: "table", columns: [{ label: "Name", width: "2fr" }, { label: "Pads", width: "50px" }, { label: "Vias", width: "50px" }, { label: "Track length", width: "100px" }, { label: "Unconnected", width: "90px" }], rows: rows.map((r) => [r.name, r.padCount, r.viaCount, fmt(r.trackLength) + " mm", r.unconnected]), empty: "No nets on this board.", onRow: (i: number) => highlightIds(ctx, netHighlightIds(ctx.doc, rows[i].name)) }], apply: () => { highlightIds(ctx, null); } });
});
alias("showNetInspector", "netInspector");
act("boardStatistics", "Board Statistics…", "", (ctx: PcbCtx) => {
  const s = boardStatistics(ctx.doc);
  return openForm({ title: "Board Statistics", width: 440, fields: [{ k: "list", type: "table", columns: [{ label: "Item", width: "1fr" }, { label: "Count", width: "120px" }], rows: [["Footprints (front / back)", `${s.footprints.total} (${s.footprints.front} / ${s.footprints.back})`], ["Footprints SMD / THT / other", `${s.footprints.smd} / ${s.footprints.tht} / ${s.footprints.other}`], ["Pads SMD / THT / NPTH", `${s.pads.smd} / ${s.pads.tht} / ${s.pads.npth}`], ["Vias through / blind / micro", `${s.vias.through} / ${s.vias.blind} / ${s.vias.micro}`], ["Tracks (count, length)", `${s.tracks.count}, ${fmt(s.tracks.length)} mm`], ["Zones", s.zones], ["Drill holes", s.drills], ["Board size", `${fmt(s.width)} × ${fmt(s.height)} mm`], ["Board area", `${fmt(s.area)} mm²`]] }] });
});
act("inspectClearance", "Clearance Resolution…", "", (ctx: PcbCtx) => {
  const ids = Array.from(selectionIds(ctx)); if (ids.length !== 2) { ctx.toast("Select exactly two copper items"); return true; }
  const r = inspectClearance(ctx.doc, ids[0], ids[1], settingsOf(ctx)); if (!r) { ctx.toast("Both items need copper"); return true; }
  return openForm({ title: "Clearance Report", fields: [{ type: "note", value: r.sameNet ? `Both items are on net '${r.nets[0]}': no clearance applies.` : r.gap === null ? "The items share no copper layer." : `Clearance required ${mm4(r.required)}; actual ${mm4(r.gap)} — ${r.gap >= r.required ? "OK" : "VIOLATION"}` }] });
});
act("showRatsnest", "Show Ratsnest", "", (ctx: PcbCtx) => { S.showRatsnest = !S.showRatsnest; ctx.toast(S.showRatsnest ? "Ratsnest shown" : "Ratsnest hidden"); ctx.requestRender(); return true; }, { toggle: () => !!S.showRatsnest });
act("localRatsnestTool", "Local Ratsnest (selected footprints only)", "", (ctx: PcbCtx) => { S.localRatsnest = !S.localRatsnest; ctx.toast(S.localRatsnest ? "Ratsnest: selected footprints only" : "Ratsnest: whole board"); ctx.requestRender(); return true; }, { toggle: () => !!S.localRatsnest });
act("hideNetInRatsnest", "Hide Net in Ratsnest", "", (ctx: PcbCtx) => { const nl = netlist(ctx.doc); const keys = selectionNets(ctx, nl); for (const k of keys) S.hiddenNets.add(k); ctx.toast(keys.size ? `Hidden: ${Array.from(keys).join(", ")}` : "Select something on a net"); ctx.requestRender(); return true; });
act("showNetInRatsnest", "Show Net in Ratsnest", "", (ctx: PcbCtx) => { const nl = netlist(ctx.doc); const keys = selectionNets(ctx, nl); if (!keys.size) S.hiddenNets.clear(); else for (const k of keys) S.hiddenNets.delete(k); ctx.requestRender(); return true; });
act("highlightNet", "Highlight Net", "`", (ctx: PcbCtx) => {
  const nl = netlist(ctx.doc); let keys = selectionNets(ctx, nl);
  if (!keys.size) { const p = cursorPoint(ctx); const k = nl.table.key(netUnder(ctx.doc, p[0], p[1], null)); if (k) keys = new Set([k]); }
  if (!keys.size) { highlightIds(ctx, null); S.highlightNet = null; return true; }
  const key = keys.values().next().value; if (S.highlightNet === key) { S.highlightNet = null; highlightIds(ctx, null); return true; }
  S.highlightNet = key!; const ids = new Set<string>(); for (const k of keys) for (const id of netHighlightIds(ctx.doc, k, nl)) ids.add(id); highlightIds(ctx, ids); return true;   // no infobar: the net shows in the message panel
});
act("clearHighlight", "Clear Net Highlighting", "~", (ctx: PcbCtx) => { S.highlightNet = null; highlightIds(ctx, null); return true; });
alias("toggleNetHighlight", "highlightNet", "Toggle Last Net Highlight", "Alt+`"); alias("highlightNetSelection", "highlightNet", "Highlight Net of Selection", "");
// groups and locks
act("group", "Group Items", "", (ctx: PcbCtx) => { const ids = needSel(ctx, "Select items to group"); if (!ids || !canEdit(ctx)) return true; const ch = groupChanges(ctx.doc, ids, ""); if (!ch.length) { ctx.toast("Nothing to group"); return true; } ctx.commit(ch, "group"); ctx.toast(`Grouped ${plural(ids.size, "item")}`); return true; });
act("ungroup", "Ungroup Items", "", (ctx: PcbCtx) => { const ids = needSel(ctx, "Select a group or a member"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, ungroupChanges(ctx.doc, ids), "ungroup"); });
act("addToGroup", "Add Items to Group", "", (ctx: PcbCtx) => { const ids = needSel(ctx); if (!ids || !canEdit(ctx)) return true; const g = Array.from(ids).map((id) => groupOf(ctx.doc, id) || (ctx.doc.items.get(id)!.kind === "group" ? ctx.doc.items.get(id) : null)).find(Boolean); if (!g) { ctx.toast("The selection touches no group"); return true; } return commitSel(ctx, groupMembersChanges(ctx.doc, g, Array.from(ids).filter((id) => id !== g.id), []), "add to group"); });
act("removeFromGroup", "Remove Items from Group", "", (ctx: PcbCtx) => { const ids = needSel(ctx); if (!ids || !canEdit(ctx)) return true; const out = []; const seen = new Map(); for (const id of ids) { const g = groupOf(ctx.doc, id); if (g) { if (!seen.has(g.id)) seen.set(g.id, { g, ids: [] }); seen.get(g.id).ids.push(id); } } for (const { g, ids: rm } of seen.values()) out.push(...groupMembersChanges(ctx.doc, g, [], rm)); return commitSel(ctx, out, "remove from group"); });
// BOARD_EDITOR_CONTROL::ToggleLockSelected: the selection or the item under the cursor; locked if anything was not
act("toggleLock", "Toggle Lock", "L", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("toggleLock", c) }); if (!sel) return true;
  const on = !sel.items.every((it) => isLocked(it!.node)); const ch = lockChanges(ctx.doc, sel.ids, on); if (ch.length) ctx.commit(ch, on ? "lock" : "unlock");
  endHover(ctx, sel); ctx.requestRender(); return true;
});
act("lock", "Lock", "", (ctx: PcbCtx) => { const ids = needSel(ctx, "Select items to lock"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, lockChanges(ctx.doc, ids, true), "lock"); });
act("unlock", "Unlock", "", (ctx: PcbCtx) => { const ids = needSel(ctx, "Select items to unlock"); if (!ids || !canEdit(ctx)) return true; return commitSel(ctx, lockChanges(ctx.doc, ids, false), "unlock"); });
// footprint attributes, text, conversions, zones
act("toggleExcludeFromBOM", "Exclude from Bill of Materials", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_bom"), "exclude from BOM"); });
act("toggleExcludeFromPosFiles", "Exclude from Position Files", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_pos_files"), "exclude from position files"); });
act("toggleDNP", "Do Not Populate", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "dnp"), "dnp"); });
for (const [id, how, label] of [["leftJustify", "left", "Left Justify"], ["centerJustify", "center", "Center Justify"], ["rightJustify", "right", "Right Justify"]])
  act(id, label, "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select text first"); if (!ids) return true; return commitSel(ctx, justifyChanges(ctx.doc, ids, how), label.toLowerCase()); });
for (const [id, to, label] of [["convertToPoly", "poly", "Create Polygon from Selection"], ["convertToLines", "lines", "Create Lines from Selection"], ["convertToTracks", "tracks", "Create Tracks from Selection"], ["convertToZone", "zone", "Create Zone from Selection"], ["convertToKeepout", "keepout", "Create Rule Area from Selection"]])
  act(id, label, "", (ctx: PcbCtx) => {
    const ids = selectionOrToast(ctx, "Select graphic shapes first"); if (!ids) return true;
    if (to === "zone") { const items = ids.map((i) => ctx.doc.items.get(i)); const layer = /\.Cu$/.test(layerOf(items[0]!.node, "")) ? layerOf(items[0]!.node) : S.layer; const nets = boardNets(ctx.doc);
      askText(ctx, "Zone net", "", (name: string | null) => { if (name === null) return; const net = name ? (nets.find((n) => n.name === name) || { code: -1, name }) : { code: 0, name: "" }; commitSel(ctx, convertChanges(ctx.doc, ids, "zone", { layer, net }), "zone from shapes"); }, nets.map((n) => n.name)); return true; }
    return commitSel(ctx, convertChanges(ctx.doc, ids, to), label.toLowerCase());
  });
for (const [id, how, label] of [["zonePriorityRaise", "raise", "Raise Zone Priority"], ["zonePriorityLower", "lower", "Lower Zone Priority"], ["zonePriorityMoveToTop", "top", "Move Zone Priority to Top"], ["zonePriorityMoveToBottom", "bottom", "Move Zone Priority to Bottom"]])
  act(id, label, "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; return commitSel(ctx, zonePriorityChanges(ctx.doc, ids, how), label.toLowerCase()); });
act("zoneDuplicate", "Duplicate Zone onto Layer…", "", (ctx: PcbCtx) => {
  const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; const zones = ids.map((id) => ctx.doc.items.get(id)).filter((it) => it!.kind === "zone"); if (!zones.length) { ctx.toast("No zone selected"); return true; }
  return openForm({ title: "Duplicate Zone", fields: [{ k: "layer", label: "Layer", type: "select", value: zoneLayers(zones[0]!.node)[0] || "F.Cu", options: copperOf(ctx.doc) }], apply: (v: { layer: string }) => { const out = []; for (const z of zones) { const node = clone(z!.node); const u = K.kid(node, "uuid"); if (u) node.splice(node.indexOf(u), 1); for (const fp of K.kids(node, "filled_polygon")) node.splice(node.indexOf(fp), 1); const l = K.kid(node, "layer"), ls = K.kid(node, "layers"); if (l) l[1] = v.layer; else if (ls) ls.splice(1, ls.length - 1, v.layer); out.push(addedChange(ctx.doc, node, netOf(node))); } commitSel(ctx, out, "duplicate zone"); } });
});
// PCB_POINT_EDITOR::addCorner / removeCorner on the single selected item, at the cursor
act("pointEditorAddCorner", "Create Corner", "Ins", (ctx: PcbCtx) => {
  const id = peSingleId(ctx); if (!id || !canAddCorner(ctx.doc.items.get(id)!)) return false;
  if (!canEdit(ctx)) return true; const ch = addCornerChanges(ctx.doc, id, cursorPoint(ctx)); if (ch.length) ctx.commit(ch, "add corner"); return true;
});
act("pointEditorRemoveCorner", "Remove Corner", "", (ctx: PcbCtx) => {
  const id = peSingleId(ctx); if (!id) return false;
  if (!canEdit(ctx)) return true; const ch = removeCornerChanges(ctx.doc, id, ctx.cursor || cursorPoint(ctx), handleTol()); if (ch.length) ctx.commit(ch, "remove corner"); return true;
});
// PCB_POINT_EDITOR::changeArcEditMode: the three arc editing modes (check items of the Arc toolbar group's menu) and
// Cycle Arc Editing Mode (Ctrl+Space, also in the selection menu for one selected arc)
ARC_EDIT_ACTIONS.forEach((id, m) => {
  act(id, ["Keep Arc Center, Adjust Radius", "Keep Arc Endpoints or Direction of Starting Point", "Keep Arc Radius and Center, adjust angle"][m], "", () => { setArcEditMode(m); return true; },
    { tip: ["Switch arc editing mode to keep center, adjust radius and endpoints", "Switch arc editing mode to keep endpoints, or to keep direction of the other point", "Switch arc editing mode to maintaining radius when endpoint are moved"][m], check: () => arcEditMode() === m });
});
act("cycleArcEditMode", "Cycle Arc Editing Mode", "Ctrl+Space", () => { setArcEditMode(nextArcEditMode(arcEditMode())); return true; }, { tip: "Switch to a different method of editing arcs" });
// DRAWING_TOOL::DrawArc's modes (PCB_ACTIONS::drawArcCenter …): each starts Draw Arcs in its mode, or switches the arc
// being drawn to it (ARC_MODE_SESSION::HandleModeEvent); Switch Arc Posture and Cycle Arc Drawing Mode act on the arc in progress.
ARC_MODE_ACTIONS.forEach((id, m) => {
  const label = ["Draw Arc: Center, Start, End", "Draw Arc: Start, End, Midpoint", "Draw Arc: Start, End, Center", "Draw Arc: Tangent", "Draw Arc: Start, Direction, End"][m];
  act(id, label, "", (ctx: PcbCtx) => { if (S.modTool === "garc") switchArcMode(ctx, m); else { setArcDrawMode(m); ctx.setTool("garc"); } return true; },
    { check: () => arcDrawMode() === m });
});
act("arcPosture", "Switch Arc Posture", "/", (ctx: PcbCtx) => {
  const d = S.draw; if (S.modTool !== "garc") return false;
  if (d && d.shape === "garc") { d.arc!.toggleClockwise(); syncArcDraw(d); ctx.requestRender(); }
  return true;
}, { tip: "Switch arc posture between clockwise and counter-clockwise" });
act("cycleArcDrawMode", "Cycle Arc Drawing Mode", "Alt+/", (ctx: PcbCtx) => { if (S.modTool !== "garc") return false; switchArcMode(ctx, (arcDrawMode() + 1) % 5); return true; },
  { tip: "Switch to the next method of drawing arcs" });
// DRAWING_TOOL::DrawDimension's changeDimensionArrows (the drawing tool's menu while a dimension is drawn): inward <-> outward
// on an aligned or orthogonal dimension; the others have no arrows to swap (wxBell).
act("changeDimensionArrows", "Switch Dimension Arrows", "", (ctx: PcbCtx) => {
  const d = S.draw; if (!d || !DIM_TYPE[d.shape]) return false;
  const type = DIM_TYPE[d.shape]; if (type === "aligned" || type === "orthogonal" || type === "radial") { d.arrowInward = !d.arrowInward; ctx.requestRender(); }
  return true;
}, { tip: "Switch between inward and outward dimension arrows" });
// ZONE_FILLER_TOOL::ZoneFillAll / ZoneFill: the browser's ZONE_FILLER (web/fab/zonefill.ts, run by
// web/editor/pcbdialogs/zonefill.ts with KiCad's progress reporter); the editor installs the same actions over these.
export const zoneFiller = () => root.PcbZoneFill || null;
act("zoneFillAll", "Fill All Zones", "B", (ctx: PcbCtx) => { const z = zoneFiller(); if (!z) { ctx.toast("The zone filler is not loaded"); return true; } return z.fillAll(ctx); });
act("zoneFill", "Draft Fill Selected Zone(s)", "", (ctx: PcbCtx) => { const z = zoneFiller(); if (!z) { ctx.toast("The zone filler is not loaded"); return true; } return z.fillSelected(ctx); });
// ZONE::UnFill (ZONE_FILLER_TOOL::ZoneUnfill / ZoneUnfillAll): the filled areas go and the zone is no longer marked
// filled — exactly what pcbnew writes after an unfill, so the browser can do it itself.
export function unfillChanges(doc: BoardDoc, zones: (KItem | undefined)[]) {
  const out: PcbChange[] = [];
  for (const z of zones) {
    if (!z || z.kind !== "zone") continue;
    const node = clone(z.node); let changed = false;
    for (let i = node.length - 1; i > 0; i--) if (Array.isArray(node[i]) && (node[i] as SNode)[0] === "filled_polygon") { node.splice(i, 1); changed = true; }
    const fill = K.kid(node, "fill"); if (fill && fill[1] === "yes") { fill.splice(1, 1); changed = true; }
    if (changed) out.push(replacedChange(z, node));
  }
  return out;
}
act("zoneUnfill", "Unfill Selected Zone(s)", "", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; const ids = selectionOrToast(ctx, "Select a zone first"); if (!ids) return true; return commitSel(ctx, unfillChanges(ctx.doc, ids.map((id) => ctx.doc.items.get(id))), "Unfill Zone"); });
act("zoneUnfillAll", "Unfill All Zones", "Ctrl+B", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; return commitSel(ctx, unfillChanges(ctx.doc, Array.from(ctx.doc.items.values())), "Unfill All Zones"); });
// The autorouter is its own bundle (web/router → dist/autoroute.js); this is its entry in the Route menu.
act("autoroute", "Autoroute…", "", (ctx: PcbCtx) => { const r = root.PcbAutoRouter; if (!r || !r.open) { ctx.toast("The autorouter is not loaded"); return true; } return r.open(ctx); }, { menu: "Route" });
act("autoplace", "Auto Place Footprints…", "", (ctx: PcbCtx) => { const r = root.PcbAutoRouter; if (!r || !r.openPlace) { ctx.toast("The placer is not loaded"); return true; } return r.openPlace(ctx); }, { menu: "Tools" });
// library access (web/editor/library.ts, window.KiCadLibrary): KiCad's footprint chooser and the footprint library browser
export const libraryAction = (opts?: Record<string, unknown>) => (ctx: PcbCtx) => { const L = root.KiCadLibrary; if (!L || !L.chooseAndPlace) { ctx.toast("The library module is not loaded"); return true; } L.chooseAndPlace("footprint", opts); return true; };
act("placeFootprint", "Place Footprints", "A", libraryAction());
act("showFootprintBrowser", "Footprint Library Browser", "", libraryAction({ browser: true }));
Object.freeze(ACTIONS);
/** pcb.setRoutingDialogs: the routing dialogs the editor bundle hands over. */
export function setRoutingDialogsImpl(d: RoutingDialogs) { routingDialogs = d; }
