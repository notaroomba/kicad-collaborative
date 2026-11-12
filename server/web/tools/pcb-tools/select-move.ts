// pcb-tools/select-move.ts — the select tool's move (EDIT_TOOL::doMoveSelection) and the stage's pointer handlers.
import type { BoardDoc, Obstacle, PadInfo, PcbChange, PcbCtx, PendingDrag, Pt, SelectMove } from "./types";

/** Where the obstacles a component drag hit were first met. */
export type DragHits = Obstacle[] & { at?: Pt | null };
import { unlockedIds } from "./actions";
import { isPcbDoc } from "./app-state";
import { cancelOps } from "./assistants";
import { deleteChanges, replacedChange } from "./changes";
import { cursorPoint } from "./clipboard";
import { settingsOf } from "./dialogs";
import { shapeBBox, shapeGap } from "./distances";
import { dragChanges } from "./drag-optimize";
import { assembleLine, dragCorner45, rp } from "./dragger";
import { netClearance } from "./drc";
import { routableItems } from "./edit-commands";
import { beginSelectDrag, bestDragOrigin, snapCursor } from "./grid-helper";
import { applySelection, expandGroups, selectionIds } from "./groups";
import { beginInlineDrag, dragMove, finishDrag } from "./inline-drag";
import { editHandleMove, editHandleUp } from "./point-editor";
import { padCovers, padsOf } from "./route-geom";
import { showViolations } from "./route-tool";
import { K, S, lastCtx } from "./state";
import { bboxUnion, flipNode, mirrorNode, rotateNode, translateNode } from "./transforms";
import { clone, layerOf, pt, r6, samePt } from "./util";
import { ROUTE_EPS, isFreePad, obstaclesNear, pathHits, routeObstacles, routerWorld } from "./walkaround";

export function moveNodesAt(m: SelectMove, dx: number, dy: number) {
  const out: { id: string; node: SNode }[] = [];
  for (const [id, orig] of m.orig) {
    const node = clone(orig);
    if (m.ids.includes(id)) translateNode(node, dx, dy);
    for (const e of m.ends) if (e.id === id) { const k = K.kid(node, e.key), o = K.kid(orig, e.key); if (k && o) { k[1] = r6(K.num(o[1]) + dx); k[2] = r6(K.num(o[2]) + dy); } }
    out.push({ id, node });
  }
  return out;
}
export function moveApply(ctx: PcbCtx, m: SelectMove, dx: number, dy: number) {   // live preview: the document's own nodes take the moved shape (originals come back on finish)
  for (const { id, node } of moveNodesAt(m, dx, dy)) { const it = ctx.doc.items.get(id); if (!it) continue; it.node.length = 0; it.node.push(...node); K.replaceChange(ctx.doc, it); }
}
/** The moved items exactly as they were before the move began (a turn in flight changed m.orig, not m.base). */
export function moveRestore(ctx: PcbCtx, m: SelectMove) {
  if (!m.base) { moveApply(ctx, m, 0, 0); return; }
  for (const [id, node] of m.base) { const it = ctx.doc.items.get(id); if (!it) continue; it.node.length = 0; it.node.push(...clone(node)); K.replaceChange(ctx.doc, it); }
}
/**
 * Rotate / Flip / Mirror while the selection follows the cursor (doMoveSelection passes rotateCw, rotateCcw, flip,
 * mirrorH and mirrorV through to EDIT_TOOL::Rotate / Flip / Mirror with the move's own commit): the moving items turn
 * about the move's reference point — the cursor — and the move goes on.  Nothing is committed here: the click commits
 * one Move step holding the turn and the translation, Escape puts the true originals back.  m.orig holds the shapes
 * at offset zero, so the turn is applied there about the reference point less the offset (m.start).  Flip of several
 * items turns about the middle of their box (selection.GetCenter()); a footprint is never mirrored (no message while
 * moving, as in KiCad).
 */
export function moveTransform(ctx: PcbCtx, how: string, arg?: number | string) {
  const m = S.move; if (!m) return false;
  if ((m.conns && m.conns.length) || m.ends.length) return true;   // a drag keeps its tracks attached: they cannot follow a turn
  if (!m.base) m.base = new Map(Array.from(m.orig, ([id, n]) => [id, clone(n)]));
  let cx = m.start[0], cy = m.start[1];
  if (how === "flip" && m.ids.length > 1) {
    const b = bboxUnion(m.ids.map((id: string) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]);
    if (b) { cx = (b[0] + b[2]) / 2 - m.last[0]; cy = (b[1] + b[3]) / 2 - m.last[1]; }
  }
  for (const id of m.ids) {
    const n = m.orig.get(id); if (!n) continue;
    if (how === "rotate") rotateNode(n, cx, cy, arg as number);
    else if (how === "flip") flipNode(n, cx, ctx.doc);
    else mirrorNode(n, cx, cy, arg as string);
  }
  m.xformed = true; moveApply(ctx, m, m.last[0], m.last[1]); ctx.requestRender(); return true;
}
export function selectMoveTo(ctx: PcbCtx, mm: Pt, mods?: SelectMove["mods"]) {
  const m = S.move; if (!m) return;
  // EDIT_TOOL::doMoveSelection: the cursor resolved through the grid helper (magnetic anchors of what is not moving,
  // then the grid; Shift: grid only, Ctrl: no grid) less the drag origin
  const sn = snapCursor(ctx, [mm[0], mm[1]], m.skip || new Set(m.orig.keys()), mods || m.mods); m.snapAt = sn.anchor;
  const sN = sn.p; const dx = r6(sN[0] - m.start[0]), dy = r6(sN[1] - m.start[1]);
  if (dx === m.last[0] && dy === m.last[1]) return;
  m.last = [dx, dy]; m.moved = true; moveApply(ctx, m, dx, dy); ctx.requestRender();
}
export function finishSelectMove(ctx: PcbCtx, commit: boolean, force?: boolean) {
  const m = S.move; S.move = null; if (!m) return; moveCursor(ctx, false);
  const [dx, dy] = m.last; moveRestore(ctx, m);            // originals back first, so commit() records a true inverse
  const unhover = () => { if (m.hover) applySelection(ctx, []); };   // a hover selection does not outlive the move
  if (!commit && m.placing) {   // Escape on a paste / duplicate that still follows the cursor takes the new items out again
    const gone = m.placing.filter((id: string) => ctx.doc.items.has(id)).map((id: string) => ctx.doc.items.get(id)!);
    const back = (m.restore || []).filter((r) => ctx.doc.items.has(r.id)).map((r) => replacedChange(ctx.doc.items.get(r.id)!, r.node));   // groups the copies had joined
    if (gone.length || back.length) ctx.commit(back.concat(deleteChanges(ctx.doc, gone)), "cancel", { amend: true, discard: true });
    applySelection(ctx, []); ctx.requestRender(); return;
  }
  if (!commit || (!m.xformed && (!m.moved || (!dx && !dy)))) { unhover(); ctx.requestRender(); return; }
  if (m.conns && !force) {   // COMPONENT_DRAGGER::FixRoute: refused while the dragged items collide (Ctrl+click forces)
    moveApply(ctx, m, dx, dy); const hits = componentDragHits(ctx, m, dx, dy); moveApply(ctx, m, 0, 0); S.rworld = null; S.sworld = null;
    if (hits.length) { showViolations(hits, hits.at || cursorPoint(ctx)); ctx.toast("Track violates DRC."); ctx.requestRender(); return; }
  }
  const changes = moveNodesAt(m, dx, dy).map(({ id, node }) => replacedChange(ctx.doc.items.get(id)!, node));
  if (m.conns && m.conns.length) changes.push(...dragChanges(ctx, { sol: { lines: connLines(m, dx, dy) } }));
  ctx.commit(changes, m.conns && m.conns.length ? "drag" : "move", m.placing ? { amend: true } : undefined);
  unhover(); ctx.requestRender();
}
/**
 * Move (M, EDIT_TOOL::Move): everything selected — tracks, vias, graphics, text, zones, footprints, the members of a
 * selected group — follows the cursor from where it is; a click drops it, Escape puts it back.  Unlike a drag,
 * nothing attached follows.  Locked items stay put unless "Override locks" is on.
 */
export function beginCarryMove(ctx: PcbCtx, opts?: { placing?: string[]; ids?: string[]; at?: Pt; origin?: Pt; sticky?: boolean; restore?: SelectMove["restore"]; hover?: boolean; drag?: boolean }) {
  const doc = ctx.doc; if (!doc) return false; opts = opts || {};
  const ids = Array.from(expandGroups(doc, opts.placing ? new Set(opts.placing) : opts.ids ? new Set(opts.ids) : selectionIds(ctx))).filter((id) => { const it = doc.items.get(id); return it && it.kind !== "group"; });
  if (!ids.length) return false;
  const free = unlockedIds(ctx, ids);
  if (!free.length) return true;
  cancelOps();
  // the drag origin (BestDragOrigin): the moved items' anchor nearest the mouse; a paste keeps its reference point,
  // which already sits under the cursor
  const mouse = opts.at ? opts.at.slice() : (ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx));
  // which already sits under the cursor.  A browser cannot warp the mouse onto the origin (GetMoveWarpsCursor), so a
  // drag made with the button held keeps KiCad's no-warp behaviour: the reference is the cursor where the drag began.
  const at = opts.origin ? opts.origin.slice() : opts.placing && !opts.restore ? cursorPoint(ctx) : opts.sticky === false ? snapCursor(ctx, mouse, new Set(free), {}).p : bestDragOrigin(doc, free, mouse, ctx.gridPitch);
  const m: SelectMove = { ids: free, start: at.slice(), orig: new Map(), ends: [], last: [0, 0], moved: false, sticky: opts.sticky !== false, placing: opts.placing || null, restore: opts.restore || null, hover: !!opts.hover };
  for (const id of free) m.orig.set(id, clone(doc.items.get(id)!.node));
  if (opts.drag) dragEnds(doc, m);
  m.skip = new Set(m.orig.keys()); S.move = m; moveCursor(ctx, true); ctx.requestRender(); return true;
}
/** KICURSOR::MOVING on the canvas while a move runs (the tool's own cursor comes back afterwards). */
export function moveCursor(ctx: PcbCtx, on: boolean) {
  const st = ctx.stage && ctx.stage.style; if (!st) return;
  if (on) { if (S.cursorBefore === undefined) S.cursorBefore = st.cursor; st.cursor = "move"; }
  else if (S.cursorBefore !== undefined) { st.cursor = S.cursorBefore; S.cursorBefore = undefined; }
}
/**
 * Drag (D, EDIT_TOOL::Drag -> COMPONENT_DRAGGER on footprints): every line attached to a moving pad (ending on its
 * centre or inside it) is re-routed with LINE::DragCorner - its attached end follows the pad, the rest bends at 45° - and
 * a line running between two pads that both move goes along whole.  A via's tracks stretch with it.
 */
export function dragEnds(doc: BoardDoc, m: SelectMove) {
  const pads: PadInfo[] = [], vias: Pt[] = [];
  for (const id of m.ids) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "footprint") for (const p of padsOf(it)) pads.push(p);
    else if (it.kind === "via") { const at = pt(it.node, "at"); if (at) vias.push(at); }
  }
  if (!pads.length && !vias.length) return;
  const onLayer = (layers: string[], l: string) => layers.some((x) => x === l || (x === "*.Cu" && /\.Cu$/.test(l)) || (x === "F&B.Cu" && (l === "F.Cu" || l === "B.Cu")));
  const padAtEnd = (q: Pt, l: string) => pads.some((p) => onLayer(p.layers, l) && (samePt(q, [p.x, p.y]) || padCovers(p, q[0], q[1])));
  const seen = new Set<string>(); m.conns = [];
  for (const sg of Array.from(doc.items.values())) {
    if (sg.kind !== "segment" || m.ids.includes(sg.id) || seen.has(sg.id)) continue;
    const l = layerOf(sg.node);
    for (const key of ["start", "end"]) {
      const q = pt(sg.node, key); if (!q) continue;
      if (vias.some((v) => samePt(q, v))) { m.ends.push({ id: sg.id, key }); if (!m.orig.has(sg.id)) m.orig.set(sg.id, clone(sg.node)); continue; }
      if (!padAtEnd(q, l) || seen.has(sg.id)) continue;
      const ln = assembleLine(doc, sg); if (!ln) continue; ln.ids.forEach((id) => seen.add(id));
      const first = ln.pts[0], last = ln.pts[ln.pts.length - 1];
      const atFirst = Math.hypot(first[0] - q[0], first[1] - q[1]) <= Math.hypot(last[0] - q[0], last[1] - q[1]);
      if (padAtEnd(first, l) && padAtEnd(last, l)) { for (const id of ln.ids) { if (!m.ids.includes(id)) m.ids.push(id); if (!m.orig.has(id)) m.orig.set(id, clone(doc.items.get(id)!.node)); } break; }   // between two moving pads: carried whole
      m.conns.push({ l: ln, vertex: atFirst ? 0 : ln.pts.length - 1 }); break;
    }
  }
}
/**
 * NODE::CheckColliding( m_draggedItems ) for a component drag, with the document already at the dragged offset: the
 * moved pads and the re-bent attached lines against everything else at its place after the drag (the attached lines'
 * old shapes are gone from the node, the footprint's pads are where they were dropped).  Returns the obstacles hit,
 * with `at` the first place a hit was found.
 */
export function componentDragHits(ctx: PcbCtx, m: SelectMove, dx: number, dy: number) {
  const doc = ctx.doc, s = settingsOf(ctx); S.rworld = null; S.sworld = null;
  const lines = connLines(m, dx, dy); const gone = new Set<string | null>(); for (const c of m.conns || []) for (const id of c.l.ids) gone.add(id);
  const moved = new Set<string | null>(m.ids); const hits = new Set<Obstacle>(); let at: Pt | null = null;
  const hit = (ob: Obstacle, p: Pt) => { if (!hits.has(ob)) { hits.add(ob); if (!at) at = p; } };
  const segsOf = (pts: Pt[]) => pts.slice(0, -1).map((a: Pt, i: number) => ({ t: "seg" as const, a, b: pts[i + 1] }));
  // the moved lines against the board, and against each other when their nets differ
  lines.forEach(({ l, pts }, i: number) => {
    if (pts.length < 2) return; const r = l.width / 2;
    for (const ob of pathHits(routeObstacles(doc, s, l.netKey, l.layer, l.netKey ? null : new Set(l.ids)), pts, r)) if (!gone.has(ob.id)) hit(ob, pts[0]);
    lines.forEach((o, j: number) => {
      if (j <= i || o.l.layer !== l.layer || o.pts.length < 2 || (l.netKey && o.l.netKey === l.netKey)) return;
      const clr = Math.max(netClearance(s, l.netKey), netClearance(s, o.l.netKey), s.minClearance || 0);
      for (const a of segsOf(pts)) for (const b of segsOf(o.pts)) if (shapeGap(Object.assign({ r }, a), Object.assign({ r: o.l.width / 2 }, b)) < clr - ROUTE_EPS) {
        const shape = Object.assign({ r: o.l.width / 2 }, b); hit({ id: o.l.ids[0], kind: "segment", net: o.l.netKey, shape, bbox: shapeBBox(shape), clr }, a.a);
      }
    });
  });
  // the moved pads against the board (other than their own footprint and the lines that were re-bent) and the new lines
  for (const c of routerWorld(doc).conds) {
    if (c.kind !== "pad" || !moved.has(c.id) || isFreePad(c.pad)) continue;
    for (const layer of c.layers) {
      const O = routeObstacles(doc, s, c.net, layer, null);
      obstaclesNear(O, c.bbox, 0, (ob) => { if (!moved.has(ob.id) && !gone.has(ob.id) && ob.kind !== "keepout" && shapeGap(c.shape, ob.shape) < ob.clr - ROUTE_EPS) hit(ob, [c.pad.x, c.pad.y]); return false; });
      for (const { l, pts } of lines) {
        if (l.layer !== layer || pts.length < 2 || (c.net ? c.net === l.netKey : !l.netKey)) continue;
        const clr = Math.max(netClearance(s, l.netKey), netClearance(s, c.net), s.minClearance || 0);
        for (const sg of segsOf(pts)) { const shape = Object.assign({ r: l.width / 2 }, sg); if (shapeGap(c.shape, shape) < clr - ROUTE_EPS) hit({ id: l.ids[0], kind: "segment", net: l.netKey, shape, bbox: shapeBBox(shape), clr }, [c.pad.x, c.pad.y]); }
      }
    }
  }
  S.rworld = null; S.sworld = null;
  const out: DragHits = Array.from(hits); out.at = at; return out;
}
/** The attached lines at a component drag's offset (LINE::DragCorner of the attached end, 45°). */
export function connLines(m: SelectMove, dx: number, dy: number) { return (m.conns || []).map((c) => { const p = c.l.pts[c.vertex]; return { l: c.l, pts: dragCorner45(c.l.pts, c.vertex, rp([p[0] + dx, p[1] + dy]), 0) }; }); }
/** A press while the selection follows the cursor: the left button drops it there (and the click goes no further). */
export function onStickyPointerDown(ev: PointerEvent) {
  const ctx = lastCtx; const m = S.move; if (!m || !m.sticky || !ctx || !isPcbDoc()) return;
  if ((ev.target as Element).closest && ((ev.target as Element).closest("#pcbChip") || (ev.target as Element).closest("#cmtPanel"))) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  if (ev.button !== 0) return;
  selectMoveTo(ctx, ctx.worldMm(ev)); S.stickyUp = true; finishSelectMove(ctx, true, !!(ev.ctrlKey || ev.metaKey));
}
export const DRAG_PX = 5;
/**
 * PCB_SELECTION_TOOL::Main on a left-drag that started on the selection: a routable selection (tracks, or one via) runs
 * the router's drag (drag45Degree, TRACK_DRAG_ACTION::DRAG), anything else is moved.
 */
export function startPendingDrag(ctx: PcbCtx, pd: PendingDrag) {
  const ids = pd.ids.filter((id: string) => ctx.doc.items.has(id)); if (!ids.length) return false;
  const its = routableItems(ctx.doc, ids);
  if (its) return beginInlineDrag(ctx, its, pd.mm, false, pd.app ? "app" : "select");
  if (ids.length > 1) return beginCarryMove(ctx, { at: pd.mm, sticky: false });
  return beginSelectDrag(ctx, ctx.doc.items.get(ids[0])!, pd.mm);
}
export function onStagePointerMove(ev: PointerEvent) {
  const ctx = lastCtx; if (!ctx || !isPcbDoc()) return;
  if (S.pedit) { ev.stopImmediatePropagation(); editHandleMove(ctx, ctx.worldMm(ev)); return; }
  if (S.pending) {
    const pd = S.pending;
    // the drag starts past KiCad's drag threshold in screen pixels (gestures.ts DRAG_THRESHOLD_PX)
    if (Math.hypot(ev.clientX! - pd.client[0], ev.clientY! - pd.client[1]) <= DRAG_PX) return;
    S.pending = null; startPendingDrag(ctx, pd);
  }
  if (S.drag && S.drag.bySelect) { dragMove(ctx, ctx.worldMm(ev)); ctx.requestRender(); }
  else if (S.move) { S.move.mods = { shiftKey: !!ev.shiftKey, ctrlKey: !!ev.ctrlKey, metaKey: !!ev.metaKey }; selectMoveTo(ctx, ctx.worldMm(ev)); }
}
export function onStagePointerUp(ev?: PointerEvent | null) {
  const ctx = lastCtx; S.pending = null; if (!ctx) return;
  if (S.pedit) { if (ev) { ev.stopImmediatePropagation(); editHandleMove(ctx, ctx.worldMm(ev)); } editHandleUp(ctx, !!ev && ev.type === "pointerup"); return; }
  if (S.stickyUp) { S.stickyUp = false; if (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); } return; }   // the release of the click that dropped a Move
  if (S.drag && S.drag.bySelect) { if (ev) dragMove(ctx, ctx.worldMm(ev)); finishDrag(ctx, true, !!(ev && (ev.ctrlKey || ev.metaKey))); }   // Ctrl on release commits a drag in violation
  else if (S.move && !S.move.sticky) finishSelectMove(ctx, true);
}
