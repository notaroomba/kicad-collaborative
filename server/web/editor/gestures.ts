// gestures.ts — KiCad's mouse model on the stage, and the one place that knows every piece of
// selection / drag state the editor keeps.
//
//  · right button: a click opens the context menu (contextmenu.ts), a drag past DRAG_THRESHOLD_PX pans;
//    middle button drag pans at once (KiCad's default, MOUSE_DRAG_ACTION::PAN on the middle button)
//  · wheel: zoom about the cursor; Shift+wheel pans up/down, Ctrl+wheel pans left/right
//    (common/settings/common_settings.cpp: scroll_modifier_zoom 0, _pan_v WXK_SHIFT, _pan_h WXK_CONTROL;
//    WX_VIEW_CONTROLS::onWheel moves the view by rotation × 0.001 of the screen); a horizontal wheel
//    pans sideways; a trackpad pinch (a ctrl-wheel the browser synthesises) zooms
//  · a drag whose button release never reached the stage is cancelled on the next move, on
//    pointercancel and when the window loses focus, with the dragged item put back
//  · hover: the item a click would select is brightened
//
// The selection lives in three places for historical reasons: E.selected (the primary symbol /
// footprint), E.selection (box / multi selection) and the tool module's own pick (a wire, a track).
// selectionItems() / clearAllSelection() / selectAt() treat them as the one selection KiCad has.
import { state, store } from "./appstore";
import { placeCrosshair } from "./crosshair";
import { renderObjects, snapMm, syncItemsFromDoc } from "./doc";
import { sendOp } from "./net";
import { breakFollow, sendPresence } from "./peers";
import { clearSelection, drawSelection, filterAllows, nearestFootprint, renderProps, selFilter } from "./selection";
import { E } from "./state";
import { activeModule, moveOp as moveOpRaw, runModuleAction, setTool, toolCtx as toolCtxRaw, unlockedForEdit } from "./tools";
import { applyView, canvas as canvasRaw, dragG as dragGRaw, isSch, pxPerMm, requestRender, requestRepaint, requestZoomEnd, stage as stageRaw, worldMm as worldMmRaw, zoomBy as zoomByRaw, zoomLimits } from "./view";

// typed faces of the untyped editor modules this file leans on
type Mm = [number, number];
type Fp = { id: string; x: number; y: number };
export const toolCtx = toolCtxRaw as unknown as () => ToolCtx;
export const worldMm = worldMmRaw as unknown as (ev: { clientX: number; clientY: number }) => Mm;
export const zoomBy = zoomByRaw as unknown as (factor: number, cx?: number, cy?: number) => void;
export const stage = stageRaw as HTMLElement;
const moveOp = moveOpRaw as unknown as (fp: Fp, nx: number, ny: number) => KChange;
const canvas = canvasRaw as HTMLCanvasElement, dragG = dragGRaw as SVGGElement;

/** Right-button travel (CSS px) before a press becomes a pan instead of a context-menu click. */
export const DRAG_THRESHOLD_PX = 5;

interface PcbState { sel: Set<string>; move?: { sticky?: boolean } | null; drag?: { bySelect?: boolean } | null; pending?: unknown; route?: unknown; draw?: { shape: string; pts?: unknown[] } | null }
interface SchState { sel: string | null; hover?: string | null; drag?: { byPointer?: boolean; moved?: boolean } | null; pending?: unknown; wire?: unknown; draw?: { shape: string; pts: unknown[]; await?: boolean } | null; carry?: unknown; highlight?: unknown }
interface PcbToolsApi { hitTestItem(doc: KDoc, x: number, y: number, slop: number): KItem | null; HIT_MM?: number }

export const schState = (): SchState | null => (CollabTools.sch ? (CollabTools.sch.state as unknown as SchState) : null);
export const pcbState = (): PcbState | null => (CollabTools.pcb ? (CollabTools.pcb.state as unknown as PcbState) : null);
const pcbTools = (): PcbToolsApi | null => ((window as unknown as { PcbTools?: PcbToolsApi }).PcbTools || null);
const doc = (): KDoc | null => E.kdoc as KDoc | null;

// ---------------------------------------------------------------- the selection, as one thing
/** Ids of everything selected: the app's primary item and multi-selection plus the active module's own pick. */
export function selectionIds(): string[] {
  const d = doc(); if (!d) return [];
  const ids = new Set<string>(E.selection as Set<string>);
  if (E.selected) ids.add(E.selected.id);
  if (isSch()) { const s = schState(); if (s && s.sel) ids.add(s.sel); }
  else { const p = pcbState(); if (p && p.sel) for (const id of p.sel) ids.add(id); }
  return [...ids].filter((id) => d.items.has(id));
}
export function selectionItems(): KItem[] { const d = doc(); return d ? selectionIds().map((id) => d.items.get(id)!) : []; }

/** Publish a changed selection: halo, Properties pane, Objects tab. */
export function selectionChanged(): void { drawSelection(); renderProps(); renderObjects(); requestRender(); }

/** KiCad's ClearSelection(): nothing stays selected anywhere. */
export function clearAllSelection(publish = true): void {
  clearSelection();
  const p = pcbState(); if (p && p.sel && p.sel.size) p.sel.clear();
  const s = schState(); if (s) { s.sel = null; s.hover = null; }
  E.hoverId = null;
  if (publish) selectionChanged();
}

/** Hit slop of a click, in mm (the left-click path's own value). */
const clickSlop = (): number => 5 / Math.max(1, E.zoom * 0.6);
function pcbPick(mm: Mm): KItem | null {
  const d = doc(), t = pcbTools(); if (!d || !t) return null;
  const it = t.hitTestItem(d, mm[0], mm[1], 0.15 + 2 / Math.max(1, pxPerMm()));
  return it && filterAllows(it.kind, it) ? it : null;
}
/**
 * A footprint was hit on its silkscreen, courtyard or text — not on a pad — while the cursor is inside a track,
 * via or graphic: KiCad's GuessSelectionCandidates drops the (much larger) footprint and takes the item.
 */
export function copperUnderBeatsFootprint(mm: Mm): boolean {
  const d = doc(), t = pcbTools(), h = E.lastFpHit as { onGeom?: boolean; cls?: number } | null;
  if (!d || !t || isSch() || !h || !h.onGeom || !(Number(h.cls) > 0)) return false;
  const it = t.hitTestItem(d, mm[0], mm[1], 0);
  return !!it && filterAllows(it.kind, it);
}
function schPick(mm: Mm): KItem | null {
  const m = CollabTools.sch; if (!m || E.viewOnly) return null;
  const pick = m._ && (m._.pickNonSymbol as ((ctx: ToolCtx, mm: Mm) => KItem | null) | undefined);
  if (!pick) return null;
  try { const it = pick(toolCtx(), mm); return it && filterAllows(it.kind, it) ? it : null; } catch { return null; }
}

/**
 * SCH_PIN::HitTest under the cursor (KiCad's 5 px selection threshold): the pin a click selects on its own, ahead of
 * its symbol's body, while the selection filter takes pins.  Hidden pins only while they are shown.
 */
export function pinUnder(mm: Mm, exact?: boolean): { id: string; number: string } | null {
  const m = CollabTools.sch, d = doc(); if (!isSch() || !m || !d || !m._) return null;
  const f = selFilter() as Record<string, boolean>; if (f.pins === false) return null;
  const pinAt = (m._ as unknown as { pinAt?: (d: KDoc, p: Mm, tol: number, hidden?: boolean) => { item: KItem; pin: { number: string } } | null }).pinAt;
  if (!pinAt) return null;
  try {
    const h = pinAt(d, mm, exact ? 0 : 5 / Math.max(1e-6, pxPerMm()), !!(E.renderOpts && E.renderOpts.showHiddenPins));
    if (!h || (f.lockedItems === false && h.item.node && KiCadCanvas.kid(h.item.node, "locked"))) return null;
    return { id: h.item.id, number: h.pin.number };
  } catch { return null; }
}
// sch-tools' pick asks this first: an exact pin hit beats a wire or label ending on it (GuessSelectionCandidates)
E.pinExactAt = (mm: Mm): boolean => !!pinUnder(mm, true);
/** SCH_SYMBOL::HitTest( aPos, 0 ): the point lies in the symbol's body bounding box (pins and fields left out). */
function symbolBodyHit(d: KDoc, id: string, mm: Mm): boolean {
  const it = d.items.get(id), m = CollabTools.sch; if (!it || it.kind !== "symbol" || !m || !m._) return false;
  const bodyBox = (m._ as unknown as { bodyBox?: (d: KDoc, it: KItem) => number[] | null }).bodyBox; if (!bodyBox) return false;
  try { const b = bodyBox(d, it); return !!b && mm[0] >= b[0] && mm[0] <= b[2] && mm[1] >= b[1] && mm[1] <= b[3]; } catch { return false; }
}
/**
 * The pin a plain click at `mm` selects on its own (GuessSelectionCandidates): an exact pin hit always; a pin only
 * within the pixel threshold loses to an exact hit on a symbol's body.
 */
export function pinForClick(mm: Mm): { id: string; number: string } | null {
  const exact = pinUnder(mm, true); if (exact) return exact;
  const pin = pinUnder(mm); if (!pin) return null;
  const d = doc(); if (!d) return pin;
  const best = nearestFootprint(mm[0], mm[1], clickSlop()) as { id: string } | null;
  return best && symbolBodyHit(d, best.id, mm) ? null : pin;
}
/** What a plain left click at `mm` selects, without touching the selection: the field, movable item or module item. */
export function pickAt(mm: Mm): { field?: { id: string; name: string }; pin?: { id: string; number: string }; movable?: { id: string }; item?: KItem } | null {
  const d = doc(); if (!d) return null;
  const [x, y] = mm;
  // schematic: the tool module's capture handler sees a click first, so a wire, label or junction under the cursor wins
  if (isSch()) { const it = schPick(mm); if (it) return { item: it }; }
  if (window.KDialogs) {
    const f = (KiCadCanvas.fieldAt as (d: KDoc, x: number, y: number, hidden: Set<string>) => { item: KItem; name: string } | null)(d, x, y, E.hiddenLayers);
    if (f) return { field: { id: f.item.id, name: f.name } };
  }
  const best = nearestFootprint(x, y, clickSlop()) as { id: string } | null;
  if (isSch()) {
    // GuessSelectionCandidates: exact hits beat sloppy ones.  An exact pin hit wins outright; a click inside a
    // symbol's body box (SCH_SYMBOL::HitTest at accuracy 0) beats a pin that is only within the pixel threshold.
    const pin = pinForClick(mm); if (pin) return { pin };
    return best ? { movable: best } : null;
  }
  // board: a track / via / graphic under the cursor beats a footprint whose only claim is its bounding box
  if (best && E.lastFpHit && E.lastFpHit.onGeom && !copperUnderBeatsFootprint(mm)) return { movable: best };
  const it = pcbPick(mm);
  if (it) return { item: it };
  return best ? { movable: best } : null;
}

/** SelectPoint(): replace the selection with what is under `mm`; false when nothing is there. */
export function selectAt(mm: Mm): boolean {
  clearAllSelection(false);
  const hit = pickAt(mm);
  if (hit) selectPick(hit);
  selectionChanged();
  return !!hit;
}
export function selectPick(hit: NonNullable<ReturnType<typeof pickAt>>): void {
  if (hit.field) E.selField = hit.field;
  else if (hit.pin) E.selPins = [hit.pin];
  else if (hit.movable) E.selected = hit.movable;
  else if (hit.item) selectItemId(hit.item.id);
}
/** Select one document item by id, in whichever store its kind lives. */
export function selectItemId(id: string): void {
  const d = doc(); const it = d && d.items.get(id); if (!it) return;
  const fp = (E.items as { id: string }[]).find((f) => f.id === id);
  if (fp) { E.selected = fp; return; }
  if (isSch()) { if (CollabTools.sch) CollabTools.sch.select(id); }
  else { const p = pcbState(); if (p) p.sel = new Set([id]); }
}

/** Union bbox (mm) of the selection, or null. */
export function selectionBox(): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const it of selectionItems()) { const q = it.bbox; if (!q) continue; b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : [q[0], q[1], q[2], q[3]]; }
  return b;
}

/**
 * Every item whose own geometry is under `mm` — the candidates KiCad's Clarify Selection menu lists.
 * A symbol counts by its body box (SCH_SYMBOL::HitTest); a footprint only by geometry that is drawn there.
 */
export function hitsAt(mm: Mm): KItem[] {
  const d = doc(); if (!d) return [];
  const [x, y] = mm, tol = Math.max(0.1, 3 / Math.max(1, pxPerMm())), hidden = E.hiddenLayers as Set<string>;
  const geomHit = KiCadCanvas.geomHit as (g: KGeom, x: number, y: number, tol: number) => boolean;
  const out: KItem[] = [];
  for (const it of d.items.values()) {
    const b = it.bbox; if (!b || x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
    if (!filterAllows(it.kind, it)) continue;
    let hit = false;
    if (it.kind === "symbol" || it.kind === "sheet") hit = true;
    else for (const g of it.geom) {
      if (g.layer && hidden.has(g.layer)) continue;
      if (g.padText || g.padNum || g.noBox) continue;
      if (it.kind === "zone" && g.fill) continue;
      try { if (geomHit(g, x, y, tol)) { hit = true; break; } } catch { /* a geometry record the hit test does not know */ }
    }
    if (hit) out.push(it);
  }
  const area = (it: KItem) => (it.bbox ? (it.bbox[2] - it.bbox[0]) * (it.bbox[3] - it.bbox[1]) : 0);
  return out.sort((a, b) => area(a) - area(b));
}

// ---------------------------------------------------------------- drags in flight
/** Is the user in the middle of something a click or Esc would end? */
export function interactionBusy(): boolean {
  if (E.drag || E.fdrag || E.boxSel || E.zoomRect || (E.measure && E.measure.set)) return true;
  if (isSch()) { const s = schState(); return !!(s && (s.drag || s.pending)); }
  const p = pcbState(); return !!(p && (p.move || p.pending || (p.drag && p.drag.bySelect)));
}

function revertAppDrag(): void {
  const g = E.drag; E.drag = null; dragG.replaceChildren(); if (!g) return;
  const d = doc();
  if (g.engine) {
    if (CollabTools.sch && CollabTools.sch.cancelDrag) { try { CollabTools.sch.cancelDrag(toolCtx()); } catch (e) { console.warn(e); } }
    // a symbol's live position went out as real ops while it moved: tell the others it is back
    if (g.moved && g.fp && g.curMm) sendOp([moveOp({ id: g.fp.id, x: Math.round(g.curMm[0] * E.IU), y: Math.round(g.curMm[1] * E.IU) }, g.fp.x, g.fp.y)], true);
  } else if (g.group) {
    if (g.moved && d) {
      const back = [];
      for (const m of g.group) { back.push(moveOp({ id: m.fp.id, x: m.fp.x, y: m.fp.y }, m.ox, m.oy)); KiCadCanvas.applyChange(d, moveOp(m.fp, m.ox, m.oy), E.IU); m.fp.x = m.ox; m.fp.y = m.oy; }
      sendOp(back, true);
    }
  } else if (g.moved && d && g.fp) {
    const cx = Math.round(g.curMm[0] * E.IU), cy = Math.round(g.curMm[1] * E.IU);
    KiCadCanvas.applyChange(d, moveOp({ id: g.fp.id, x: cx, y: cy }, g.fp.x, g.fp.y), E.IU);
    for (const w of g.wires || []) { const p = KiCadCanvas.ptsOf(w.item.node); p[w.index] = w.orig; KiCadCanvas.setPts(w.item.node, p); w.item.geom = []; w.item.bbox = null; KiCadCanvas.replaceChange(d, w.item); }
    sendOp([moveOp({ id: g.fp.id, x: cx, y: cy }, g.fp.x, g.fp.y)], true);
  }
  sendPresence(E.lastCursorMm, []);
  if (d) syncItemsFromDoc();
}

function revertFieldDrag(): void {
  const fd = E.fdrag; E.fdrag = null; if (!fd) return;
  const d = doc(), it = d && d.items.get(fd.id);
  const K = window.KDialogs as (KDialogsApi & { _: { fieldNode?(node: SNode, name: string): SNode | null } }) | undefined;
  const pn = it && K && K._.fieldNode ? K._.fieldNode(it.node, fd.name) : null, at = pn && KiCadCanvas.kid(pn, "at");
  if (d && it && at && fd.moved) { at[1] = fd.orig[0]; at[2] = fd.orig[1]; KiCadCanvas.replaceChange(d, it); }
}

/**
 * Cancel whatever drag is in flight and put the document back as it was (KiCad's cancelInteractive
 * for a move).  Returns true when there was something to cancel.
 */
export function cancelInteraction(): boolean {
  let took = false;
  if (E.rdown) { E.rdown = null; }
  if (E.pan) { E.pan = null; stage.classList.remove("panning"); took = true; }
  if (E.zoomRect) { E.zoomRect = null; took = true; }
  if (E.boxSel) { E.boxSel = null; took = true; }
  if (E.measure && E.measure.set) { E.measure = null; took = true; }   // MeasureTool: Esc drops a ruler that follows the cursor; the tool stays
  if (E.fdrag) { revertFieldDrag(); took = true; }
  if (E.drag) { revertAppDrag(); took = true; }
  const s = schState();
  if (s && isSch() && (s.drag || s.pending)) { s.pending = null; if (s.drag && CollabTools.sch && CollabTools.sch.cancelDrag) { try { CollabTools.sch.cancelDrag(toolCtx()); } catch (e) { console.warn(e); } } took = true; }
  const p = pcbState(), pm = CollabTools.pcb as (PcbToolModule & { cancel?(): void }) | undefined;
  if (p && !isSch() && (p.move || p.pending || (p.drag && p.drag.bySelect))) { p.pending = null; if (pm && pm.cancel) { try { pm.cancel(); } catch (e) { console.warn(e); } } took = true; }
  if (took) { drawSelection(); renderProps(); requestRender(); }
  return took;
}

/** A pointer-driven drag is running although no button is down any more: the release was lost. */
function buttonLost(ev: PointerEvent): boolean {
  if (ev.pointerType !== "mouse" || ev.buttons !== 0) return false;
  if (E.pan || E.rdown || E.boxSel || E.zoomRect || E.fdrag) return true;
  if (E.drag && !E.drag.sticky) return true;
  if (isSch()) { const s = schState(); return !!(s && (s.pending || (s.drag && s.drag.byPointer))); }
  const p = pcbState(); return !!(p && (p.pending || (p.move && !p.move.sticky) || (p.drag && p.drag.bySelect)));   // a Move that follows the cursor needs no button
}

// ---------------------------------------------------------------- "Move" from the menu / M: the item follows the cursor until a click
let finishDrag: ((ev: PointerEvent) => void) | null = null;
/** index.ts hands over its pointer-up routine so a click can drop an item that is following the cursor. */
export function registerPointerUp(fn: (ev: PointerEvent) => void): void { finishDrag = fn; }

/**
 * KiCad's Move (M) / Drag (G): the selection follows the cursor, a click drops it, Esc puts it back.
 * On a schematic the tool module's engine does it (Drag keeps the wires attached); on a board the
 * selected footprints move.  Returns false when the selection has nothing this can move.
 */
export function startMove(mode: "move" | "drag"): boolean {
  const d = doc(); if (!d || E.viewOnly) return false;
  cancelInteraction();
  const mm: Mm = [E.lastCursorMm[0], E.lastCursorMm[1]];
  if (isSch()) {
    const m = CollabTools.sch; if (!m) return false;
    const items = selectionItems(); if (!items.length) return false;
    try { m.setDragMode(toolCtx(), mode); return !!m.beginDrag(toolCtx(), items.length === 1 ? items[0] : items, mm, false); } catch (e) { console.warn(e); return false; }
  }
  // board: EDIT_TOOL::Move in the module for everything (footprints too), so Rotate / Flip / Mirror act on the move in
  // flight, the reference point and snapping are KiCad's, and with nothing selected the item under the cursor moves
  if (CollabTools.pcb) return runModuleAction("move");
  const all = selectionIds(); if (!all.length) return false;
  const fps = (unlockedForEdit(all) as string[]).map((id) => (E.items as { id: string; x: number; y: number }[]).find((f) => f.id === id)).filter(Boolean) as { id: string; x: number; y: number }[];
  if (!fps.length) return true;   // everything selected is locked: said so, nothing to carry
  const fp = fps[0];
  if (fps.length === 1) E.drag = { fp, startMm: mm, curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, grabOff: [mm[0] - fp.x / E.IU, mm[1] - fp.y / E.IU], wires: [], engine: false, sticky: true };
  else E.drag = { fp, group: fps.map((f) => ({ fp: f, ox: f.x, oy: f.y })), startMm: mm, grab: snapMm(mm), curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, last: [0, 0], sticky: true };
  return true;
}

/**
 * The app's own pointer drag of footprints (E.drag) handed to the board module's move, which can turn, flip and mirror
 * what it carries (doMoveSelection passes Rotate / Flip / Mirror to EDIT_TOOL with the move's commit).  The footprints
 * go back to where the drag found them and the module picks them up under the same cursor.  True when a module move
 * now runs.
 */
E.hooks.handoffDrag = (): boolean => handoffAppDrag();
// True while something follows the cursor (a move, a drag, a placement).
E.hooks.busy = (): boolean => interactionBusy();
E.hooks.selectedIds = (): string[] => selectionIds();
export function handoffAppDrag(): boolean {
  const g = E.drag as { fp?: { id: string }; group?: { fp: { id: string } }[]; engine?: boolean; startMm?: Mm; sticky?: boolean } | null;
  const pm = CollabTools.pcb as (PcbToolModule & { beginMove?(ctx: ToolCtx, at: Mm, sticky: boolean): boolean }) | undefined;
  const PT = (window as unknown as { PcbTools?: { selectMoveTo?(ctx: ToolCtx, mm: Mm): void } }).PcbTools;
  if (!g || isSch() || g.engine || !g.startMm || !pm || !pm.beginMove || !PT || !PT.selectMoveTo || !E.kdoc) return false;
  const ids = g.group ? g.group.map((m) => m.fp.id) : g.fp ? [g.fp.id] : [];
  if (!ids.length) return false;
  const start: Mm = [g.startMm[0], g.startMm[1]], cur: Mm = [E.lastCursorMm[0], E.lastCursorMm[1]], sticky = !!g.sticky;
  revertAppDrag();
  (toolCtx() as unknown as { setSelection(ids: string[]): void }).setSelection(ids);
  const c2 = toolCtx(); if (!pm.beginMove(c2, start, sticky)) return false;
  PT.selectMoveTo(c2, cur); return true;
}

// ---------------------------------------------------------------- hover
let hoverRaf = 0, hoverEv: { clientX: number; clientY: number } | null = null;
function computeHover(): void {
  hoverRaf = 0; const ev = hoverEv; hoverEv = null;
  const d = doc(); if (!d || !ev) return;
  let id: string | null = null, over = false;
  if (E.tool === "select" && !interactionBusy() && !E.pan && !E.contextMenuOpen) {
    const hit = pickAt(worldMm(ev));
    // the schematic module outlines its own items (wires, labels …) on hover; fields have their own selection box
    if (hit && hit.movable) id = hit.movable.id; else if (hit && hit.item && !isSch()) id = hit.item.id;
    const under = hit && (hit.movable ? hit.movable.id : hit.item ? hit.item.id : null);
    over = !!under && !E.viewOnly && selectionIds().includes(under);
  }
  if (id !== E.hoverId) { E.hoverId = id; requestRepaint(); }
  // over something already selected a drag moves it: say so with the cursor (KiCad's "moving" arrow)
  stage.classList.toggle("over-sel", over);
}
function queueHover(ev: PointerEvent): void { hoverEv = { clientX: ev.clientX, clientY: ev.clientY }; if (!hoverRaf) hoverRaf = requestAnimationFrame(computeHover); }

/** Brighten the hovered item (called from the canvas pass, in document space). */
export function drawHover(ctx: CanvasRenderingContext2D, view: KView): void {
  const d = doc(), id = E.hoverId as string | null; if (!d || !id || !d.items.has(id)) return;
  // neither eeschema nor pcbnew has a rollover look: an item lights up only when it is selected, or while its
  // Clarify Selection row is hovered (the menu brightens the candidate it names)
  if (!E.hoverPinned) return;
  const dpr = view.dpr || 1, s = view.ppm * view.zoom * dpr;
  const drawHalo = KiCadCanvas.drawHalo as (ctx: CanvasRenderingContext2D, doc: KDoc, ids: Set<string>, s: number, dpr: number, hidden: Set<string>, style: { color: string | ((c: string) => string); alpha: number; extraPx: number; extraMm?: number; strokesOnly?: boolean }) => void;
  const bright = KiCadCanvas.brightened as (c: string, f: number) => string;
  ctx.save();
  try {
    KiCadCanvas.setViewTransform(ctx, view);
    drawHalo(ctx, d, new Set([id]), s, dpr, E.hiddenLayers, isSch() ? { color: (KiCadCanvas.SCH as Record<string, string>).selection, alpha: 1, extraPx: 2, extraMm: 2 * 0.0254, strokesOnly: true } : { color: (c: string) => bright(c || "#ffffff", 0.6), alpha: 0.32, extraPx: 3 });
  } catch (e) { console.warn(e); } finally { ctx.restore(); }
}

// ---------------------------------------------------------------- wheel
let ctrlHeld = false;
function panBy(dx: number, dy: number, mm: Mm): void {
  E.viewTouched = true; E.panX += dx; E.panY += dy; breakFollow(); applyView(); sendPresence(mm, undefined);
}
function onWheel(ev: WheelEvent): void {
  ev.preventDefault();
  const r = stage.getBoundingClientRect(), unit = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? r.height : 1;
  const dx = ev.deltaX * unit, dy = ev.deltaY * unit, mm = worldMm(ev);
  // a pinch arrives as ctrl+wheel with no Ctrl key held
  const pinch = ev.ctrlKey && !ctrlHeld;
  if (pinch) { zoomBy(Math.pow(1.01, -dy), ev.clientX - r.left, ev.clientY - r.top); return; }
  const mods = (ev.shiftKey ? 1 : 0) + (ev.ctrlKey ? 1 : 0) + (ev.altKey ? 1 : 0);
  if (mods > 1) return;                                                      // KiCad forwards multi-modifier scrolls to the tools
  // browsers turn Shift+wheel into a horizontal delta: read whichever axis carries the rotation
  const rot = dy !== 0 ? dy : dx;
  if (ev.shiftKey) { panBy(0, -rot * 0.0012 * r.height, mm); return; }      // 0.001 × 120 units a notch ≈ 12 % of the screen
  if (ev.ctrlKey) { panBy(-rot * 0.0012 * r.width, 0, mm); return; }
  if (ev.altKey) return;
  if (dx !== 0 && Math.abs(dx) > Math.abs(dy)) { panBy(-dx, 0, mm); return; } // horizontal wheel / two-finger sideways
  wheelZoom(Math.pow(E.zoomStep || 1.0018, -dy), ev.clientX - r.left, ev.clientY - r.top);
}

// ---------------------------------------------------------------- smooth wheel zoom
// KiCad's GAL eases a wheel zoom in over a few frames instead of jumping; the first step lands on the very next
// frame (no added lag), the rest follow an ease-out over ZOOM_EASE_MS.  Notches that arrive while it runs retarget
// it from where the view is now, so fast scrolling accelerates rather than queues.  Off with E.smoothZoom === false
// or the OS "reduce motion" setting.
const ZOOM_EASE_MS = 110;
interface ZoomAnim { from: number; to: number; cx: number; cy: number; t0: number; raf: number }
const reducedMotion = (): boolean => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
function wheelZoom(factor: number, cx: number, cy: number): void {
  const prev = E.zoomAnim as ZoomAnim | null;
  if (E.smoothZoom === false || reducedMotion()) { zoomBy(factor, cx, cy); return; }
  const [lo, hi] = (zoomLimits as unknown as () => [number, number])();
  const base = prev ? prev.to : E.zoom as number;
  const to = Math.min(Math.max(hi, E.zoom), Math.max(Math.min(lo, E.zoom), base * factor));
  if (prev) cancelAnimationFrame(prev.raf);
  const a: ZoomAnim = { from: E.zoom, to, cx, cy, t0: performance.now(), raf: 0 };
  E.zoomAnim = a;
  const step = (now: number): void => {
    if (E.zoomAnim !== a) return;
    const p = Math.min(1, Math.max(0, (now - a.t0) / ZOOM_EASE_MS)), e = 1 - Math.pow(1 - p, 3);
    const z = a.from * Math.pow(a.to / a.from, p >= 1 ? 1 : Math.max(e, 0.35));
    if (p >= 1) E.zoomAnim = null;
    if (z !== E.zoom) zoomBy(z / E.zoom, a.cx, a.cy);
    if (p >= 1) requestZoomEnd(); else a.raf = requestAnimationFrame(step);
  };
  a.raf = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- right / middle button
type OpenMenu = (ev: PointerEvent) => void;
let openMenu: OpenMenu = () => {};
function startPan(ev: PointerEvent, fromX: number, fromY: number): void {
  E.pan = { x: fromX - E.panX, y: fromY - E.panY };
  stage.classList.add("panning"); E.hoverId = null;
  try { stage.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
}
function onDownCapture(ev: PointerEvent): void {
  const t = ev.target as Element;
  if (t.closest && (t.closest("#cmtPanel") || t.closest("#signinOverlay") || t.closest("#pcbChip") || t.closest("[data-schtools]"))) return;
  if (ev.button === 1) { ev.preventDefault(); ev.stopImmediatePropagation(); if (E.middleDragPan !== false) startPan(ev, ev.clientX, ev.clientY); return; }   // Preferences > Mouse and Touchpad
  if (ev.button === 2) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    E.rdown = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    try { stage.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    return;
  }
  // a click drops an item that is following the cursor after Move / M
  if (ev.button === 0 && E.drag && E.drag.sticky && finishDrag) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    const g = E.drag; g.sticky = false; finishDrag(ev);
    if (E.drag === g) revertAppDrag();
  }
}
function onMoveCapture(ev: PointerEvent): void {
  if (buttonLost(ev)) { cancelInteraction(); }
  if (E.rdown && !E.pan && E.rightDragPan !== false && Math.hypot(ev.clientX - E.rdown.x, ev.clientY - E.rdown.y) > DRAG_THRESHOLD_PX) { const r = E.rdown; E.rdown = null; startPan(ev, r.x, r.y); }
  queueHover(ev);
}
function onUpCapture(ev: PointerEvent): void {
  if (ev.button === 2 && E.rdown) {
    E.rdown = null; ev.stopImmediatePropagation();
    try { stage.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    openMenu(ev); return;
  }
  if (E.pan && (ev.button === 1 || ev.button === 2 || (ev.button === 0 && E.tool === "pan"))) stage.classList.remove("panning");
}

/** Wire the stage.  Capture phase and registered first, so these see every event before the tool modules do. */
export function installGestures(open: OpenMenu): void {
  openMenu = open;
  stage.addEventListener("wheel", onWheel, { passive: false });
  // A press on the canvas takes the keyboard back from whatever chrome control had it — a toolbar selector or
  // checkbox, or a panel's text box such as the search panel Ctrl+G focuses — as clicking pcbnew's canvas does
  // (the press is default-prevented further down, so the focus would otherwise stay there and swallow the hotkeys).
  stage.addEventListener("pointerdown", () => {
    const ae = document.activeElement as HTMLElement | null;
    if (!ae || ae === document.body || stage.contains(ae) || ae.closest(".kd-overlay, [role='dialog']")) return;
    if (/^(SELECT|K-SELECT|BUTTON|INPUT|TEXTAREA)$/.test(ae.tagName) || ae.isContentEditable) ae.blur();
  }, true);
  stage.addEventListener("pointerdown", onDownCapture, true);
  stage.addEventListener("pointermove", onMoveCapture, true);
  stage.addEventListener("pointerup", onUpCapture, true);
  stage.addEventListener("pointercancel", () => { cancelInteraction(); }, true);
  stage.addEventListener("pointerleave", () => { placeCrosshair(null); if (E.hoverId) { E.hoverId = null; requestRepaint(); } stage.classList.remove("over-sel"); });
  stage.addEventListener("auxclick", (ev) => ev.preventDefault());           // no autoscroll / paste on a middle click
  stage.addEventListener("mousedown", (ev) => { if (ev.button === 1) ev.preventDefault(); });
  window.addEventListener("blur", () => { ctrlHeld = false; cancelInteraction(); });
  window.addEventListener("keydown", (ev) => { if (ev.key === "Control") ctrlHeld = true; }, true);
  window.addEventListener("keyup", (ev) => { if (ev.key === "Control") ctrlHeld = false; }, true);
  // Esc while something is being dragged puts it back and nothing else: registered ahead of the tool
  // modules' own capture handlers so every kind of drag is cancelled, and reverted for the peers, the same way.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || state.view !== "editor" || E.contextMenuOpen || !interactionBusy()) return;
    const t = ev.target as Element | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (window.KDialogs && window.KDialogs.isOpen()) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); cancelInteraction();
  }, true);
  watchPixels();
}

/** Keep the canvas backing store on the device pixel grid: exact size where the browser reports it, and a repaint when the DPR changes. */
function watchPixels(): void {
  try {
    new ResizeObserver((entries) => {
      const e = entries[entries.length - 1], box = e && e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      const next = box && box.inlineSize > 0 && box.blockSize > 0 ? [box.inlineSize, box.blockSize] : null;
      const cur = E.canvasPx as number[] | null;
      if ((next && (!cur || cur[0] !== next[0] || cur[1] !== next[1])) || (!next && cur)) { E.canvasPx = next; requestRender(); }
    }).observe(canvas, { box: "device-pixel-content-box" });
  } catch { E.canvasPx = null; /* no device-pixel-content-box here: sizeCanvas rounds clientSize × DPR */ }
  const onDpr = () => {
    requestRender();
    window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener("change", onDpr, { once: true });
  };
  window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener("change", onDpr, { once: true });
}

/** Tools that work on the selection instead of starting from an empty one. */
const KEEPS_SELECTION = new Set(["select", "pan", "zoomtool", "measure", "comment", "highlight", "follow", "drag", "place", "power", "image"]);
/** The tool is about to change: a drag in flight goes back, and a drawing tool starts with nothing selected (KiCad clears the selection when a tool is activated). */
export function toolChanging(next: string): void {
  if (interactionBusy() || E.pan || E.rdown) cancelInteraction();
  if (E.hoverId) { E.hoverId = null; stage.classList.remove("over-sel"); }
  if (!KEEPS_SELECTION.has(next) && (selectionIds().length || E.selField || E.selPins.length)) clearAllSelection();
}

/** The document is going away: nothing in flight, selected, hovered or armed survives into the next one. */
export function resetInteraction(): void {
  E.selField = null; E.selPins = []; E.fdrag = null; E.pan = null; E.rdown = null; E.zoomRect = null; E.boxSel = null; E.hoverId = null; E.hoverPinned = false;
  stage.classList.remove("panning", "over-sel");
  const p = pcbState(); if (p && p.sel) p.sel.clear();
  const s = schState(); if (s) { s.sel = null; s.hover = null; s.pending = null; }
  if (E.contextMenuOpen || store.get().contextMenu) { E.contextMenuOpen = false; store.set({ contextMenu: null }); }
  if (E.tool !== "select") { try { setTool("select"); } catch (e) { console.warn(e); } }
}

/** After a document change: drop what no longer exists from every selection store and from a drag in flight. */
export function pruneSelection(): void {
  const d = doc(); if (!d) return;
  const sel = E.selection as Set<string>;
  for (const id of [...sel]) if (!d.items.has(id)) sel.delete(id);
  if (E.selected && !d.items.has(E.selected.id)) E.selected = null;
  if (E.selField && !d.items.has(E.selField.id)) E.selField = null;
  if (E.selPins.length) E.selPins = E.selPins.filter((p: { id: string }) => d.items.has(p.id));
  if (E.fdrag && !d.items.has(E.fdrag.id)) E.fdrag = null;
  if (E.hoverId && !d.items.has(E.hoverId)) E.hoverId = null;
  const g = E.drag;
  if (g) {
    const gone = g.group ? g.group.some((m: { fp: { id: string } }) => !d.items.has(m.fp.id)) : !d.items.has(g.fp.id);
    if (gone) {                                                  // someone deleted what is being dragged: stop, keep the rest where it was
      if (g.group) g.group = g.group.filter((m: { fp: { id: string } }) => d.items.has(m.fp.id));
      if (g.group && g.group.length) revertAppDrag();
      else { E.drag = null; dragG.replaceChildren(); if (g.engine && CollabTools.sch && CollabTools.sch.cancelDrag) { try { CollabTools.sch.cancelDrag(toolCtx()); } catch (e) { console.warn(e); } } }
    }
  }
}

/** The active module's tool definition for the current tool, if it is one of the module's. */
export function activeModuleTool(): boolean { const m = activeModule(); return !!(m && m.tools && m.tools.some((t: { id: string }) => t.id === E.tool)); }
