// pcb-tools/edit-commands.ts — edit commands on the selection: layer steps, rotate, flip, delete, track width and via size cycling.
import type { BoardDoc, PcbCtx, Pt } from "./types";
import { requestSelection, runAction, unlockedIds } from "./actions";
import { appGlobal, editorState, netNameOf, sizesOf } from "./app-state";
import { deleteChanges, replacedChange } from "./changes";
import { connectedRun } from "./connected";
import { copperOf } from "./dialogs";
import { refreshChip } from "./dom";
import { trackEnds } from "./dragger";
import { applySelection, expandGroups, selectedItems } from "./groups";
import { distSeg } from "./hit";
import { setLayer } from "./route-tool";
import { K, S, lastCtx } from "./state";
import { clone, pt, r6, widthOf } from "./util";
import { cursorPoint } from "./clipboard";
import { hideFieldChanges, requestField } from "./field-edit";

/** + / - (PCB_CONTROL::LayerNext / LayerPrev): the next visible copper layer down or up the stack. */
export function stepLayer(ctx: PcbCtx, forward: boolean) {
  const R = sizesOf(ctx); const hidden = appGlobal(() => editorState()!.hiddenLayers, null);
  const to = K.pcbSizes.stepCopperLayer(copperOf(ctx.doc), S.route ? S.route.layer : (R.activeLayer || S.layer), forward, hidden);
  if (to) setLayer(ctx, to); return true;
}
// R / F: a lone footprint turns or flips about its own anchor; anything more goes through the selection actions
// (about the selection centre).  Nothing of ours selected lets app.js's orientation-only fallback run.
export function rotateSelected(ctx: PcbCtx) { return runAction("rotateSelection", ctx); }
export function flipSelected(ctx: PcbCtx) { return runAction("flipSelection", ctx); }
export function deleteSelection(ctx: PcbCtx) {
  const ids = unlockedIds(ctx, Array.from(expandGroups(ctx.doc, S.sel))); if (!ids.length) return;   // locked: the warning, nothing deleted
  const changes = deleteChanges(ctx.doc, ids); S.sel.clear(); if (!changes.length && !changes.infoError) return;
  ctx.commit(changes, "delete");   // EDIT_TOOL::Remove says nothing
}
/** EDIT_TOOL::Remove with nothing selected: the item under the cursor (hover), locks honoured; silent. */
export function hoverDelete(ctx: PcbCtx) {
  // a footprint field (the selected one, or the one under the cursor) is hidden, never removed (DeleteItems, PCB_FIELD_T)
  const fr = requestField(ctx, ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx));
  if (fr) { ctx.commit(hideFieldChanges(ctx.doc, fr), "delete"); if (!fr.hover && ctx.clearField) ctx.clearField(); ctx.requestRender(); return; }
  const sel = requestSelection(ctx, { rerun: (c) => hoverDelete(c) }); if (!sel) return;
  ctx.commit(deleteChanges(ctx.doc, sel.ids), "delete"); applySelection(ctx, []);
}
export const sizeUnits = () => appGlobal(() => editorState()!.units, "mm") || "mm";
/** A size in the editor's units, trailing zeros trimmed: "0.25 mm", "9.84 mils". */
export function fmtSize(v: number, bare?: boolean) { const u = sizeUnits(); const x = u === "mil" ? +(v / 0.0254).toFixed(2) : u === "in" ? +(v / 25.4).toFixed(5) : +v.toFixed(4); return bare ? String(x) : x + (u === "mil" ? " mils" : u === "in" ? " in" : " mm"); }
/** Tracks, arcs and vias only, with the select tool: W and ' then edit the selection instead of the current size. */
export function sizeSelection(ctx: PcbCtx) {
  if (S.modTool) return null;
  const items = selectedItems(ctx); if (!items.length || !items.every((it) => it.kind === "segment" || it.kind === "arc" || it.kind === "via")) return null;
  return items;
}
/** W / Shift+W (BOARD_EDITOR_CONTROL::TrackWidthInc / Dec). */
export function cycleWidth(ctx: PcbCtx, dir: number) {
  const R = sizesOf(ctx), fwd = dir !== -1;
  if (S.route) {
    R.stepTrackWidth(fwd, true); S.route.width = R.routeWidth(netNameOf(ctx, S.route.net), S.route.connected);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const sel = sizeSelection(ctx);
  if (sel) {   // each selected track goes to the next larger (smaller) of the netclass width and the pre-defined widths
    const changes = [];
    for (const it of sel) {
      if (it.kind === "via") continue; const w = R.steppedWidth(widthOf(it.node, 0), fwd); if (w === null) continue;
      const node = clone(it.node); const wn = K.kid(node, "width"); if (wn) wn[1] = r6(w); else node.splice(node.indexOf(K.kid(node, "layer")!), 0, ["width", r6(w)]); changes.push(replacedChange(it, node));
    }
    if (changes.length) ctx.commit(changes, fwd ? "Increase Track Width" : "Decrease Track Width");
    return;
  }
  R.stepTrackWidth(fwd, false); refreshChip(ctx);   // the toolbar's width combo shows it
}
/** ' / \ (ViaSizeInc / Dec). */
export function cycleVia(ctx: PcbCtx, dir: number) {
  const R = sizesOf(ctx), fwd = dir !== -1;
  const sel = S.route ? null : sizeSelection(ctx);
  if (sel) {
    const changes = [];
    for (const it of sel) {
      if (it.kind !== "via") continue; const sn = K.kid(it.node, "size"); const v = R.steppedVia(sn ? K.num(sn[1]) : 0, fwd); if (!v) continue;
      const node = clone(it.node); const s2 = K.kid(node, "size"), d2 = K.kid(node, "drill"); if (s2) s2[1] = r6(v.diameter); if (d2 && v.drill > 0) d2[1] = r6(v.drill); changes.push(replacedChange(it, node));
    }
    if (changes.length) ctx.commit(changes, fwd ? "Increase Via Size" : "Decrease Via Size");
    return true;
  }
  R.stepViaSize(fwd); refreshChip(ctx); if (ctx.requestRender) ctx.requestRender(); return true;
}
/** { size, drill } of a via node, or of the via the tools would place now. */
export function viaNow(node: SNode) {
  if (node) { const s = K.kid(node, "size"), d = K.kid(node, "drill"); return { size: s ? K.num(s[1]) : 0, drill: d ? K.num(d[1]) : 0 }; }
  const R = sizesOf(lastCtx!); const v = S.route ? R.routeVia(netNameOf((lastCtx || {}) as PcbCtx, S.route.net)) : R.currentVia(); return { size: v.diameter, drill: v.drill };
}
export function expandSelection(ctx: PcbCtx) {
  if (!S.sel.size) return false;
  const before = S.sel.size; S.sel = connectedRun(ctx.doc, S.sel);
  ctx.toast(S.sel.size > before ? `Selected the connected run (${S.sel.size} items)` : "Nothing else connected"); ctx.requestRender(); return true;
}
/** KiCad's `routable` selection (PCB_SELECTION_TOOL::Main): tracks, or one via, and nothing else.  Arcs are moved instead here. */
export function routableItems(doc: BoardDoc, ids: Iterable<string>) {
  const its = Array.from(ids, (id) => doc.items.get(id)).filter(Boolean) as KItem[];
  const segs = its.filter((it) => it!.kind === "segment").length, vias = its.filter((it) => it!.kind === "via").length;
  if (!its.length || segs + vias !== its.length || vias > 1 || (!segs && vias !== 1)) return null;
  return its;
}
export const distToItem = (it: KItem, p: Pt) => { if (it.kind === "via") { const a = pt(it.node, "at"); return Math.hypot(p[0] - a![0], p[1] - a![1]); } const [a, b] = trackEnds(it); return distSeg(p[0], p[1], a[0], a[1], b[0], b[1]); };
