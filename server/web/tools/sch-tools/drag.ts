import type { Anchor, LineEnd, PartialLine, Rider, SchCtx, SchDrag, Pt } from "./types";
import { symbolLibId } from "./autoplace";
import { autoRotateChanges } from "./autorotate";
import { collisionCursor, collisionInit } from "./collision";
import { setSelectionIds } from "./commands";
import { junctionAt, lineEndsAt, lineMidsAt, needsJunction, pinsAt } from "./connect";
import { junctionNode, lineNode } from "./nodes";
import { anchorOf, shiftNode } from "./orient";
import { K, POINT_KINDS, S, atOf, kid, kids, num, ptsOf, setAt, setPts } from "./state";
import { endBreak } from "./transforms";
import { addNode, deep, modChange, r4, same, segDist, segs } from "./util";
import { wireModeChanged } from "./wire";

// ---------------------------------------------------------------- drag (KiCad's "drag": attached ends stretch)
// ---------------------------------------------------------------- connected drag (eeschema/tools/sch_move_tool.cpp)
// KiCad's DRAG keeps the moved item's connections: a wire end sitting on a moved
// connection point stretches (in 90° / 45° mode the wire stays on its own axis and
// grows a bend segment), a fixed pin, junction, label or sheet pin sitting on the
// point gets a brand-new wire, and no-connects ride along.  Afterwards junctions are
// added or dropped and collinear wires merged the way AddJunctionsIfNeeded and
// SCHEMATIC::CleanUp do on the desktop.  MOVE (M) is KiCad's plain move: the item
// goes, its connections stay where they were.
S.dragMode = "drag";                       // "drag" (G) | "move" (M)
S.lineMode = "90";                         // "90" | "45" | "free"  (eeschema's LINE_MODE)
export const LINE_MODES = ["90", "45", "free"];
export const LINE_MODE_LABEL: Record<string, string> = { "90": "90°", "45": "45°", free: "free" };
export const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
export const RIDER_KINDS = new Set(["junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
export const DRAG_KINDS = new Set(["symbol", "sheet", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text",
  "text_box", "rectangle", "circle", "arc", "ellipse", "ellipse_arc", "bezier", "rule_area", "table", "image"]);
export const isNetLine = (k: string) => k === "wire" || k === "bus";

export function modeText() { return `${S.dragMode === "drag" ? "drag keeps connections (G)" : "move leaves connections (M)"} · wires ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; }
export function announceModes(ctx: SchCtx) {
  if (ctx && ctx.setStatus) ctx.setStatus(modeText());
  if (typeof document !== "undefined") { const b = document.querySelector<HTMLElement>("[data-act=linemode]"); if (b) { b.textContent = LINE_MODE_LABEL[S.lineMode]; b.title = `Wire angle mode: ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; } }
}
export function setLineMode(ctx: SchCtx, mode: string) {
  if (!LINE_MODES.includes(mode)) return S.lineMode;
  const from = S.lineMode; S.lineMode = mode; announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  else if (S.wire) { wireModeChanged(ctx, from, mode); ctx.requestRender(); }
  return mode;
}
export function cycleLineMode(ctx: SchCtx) { return setLineMode(ctx, LINE_MODES[(LINE_MODES.indexOf(S.lineMode) + 1) % LINE_MODES.length]); }
export function setDragMode(ctx: SchCtx, mode: string) {
  S.dragMode = mode === "move" ? "move" : "drag"; announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  return S.dragMode;
}

// Connection points of an item (mm): symbol pins, sheet pins, bus-entry ends, net-line ends, anchors.
export function connPoints(doc: KDoc, item: Pick<KItem, "kind" | "node"> & { id?: string }): Pt[] {
  const k = item.kind, n = item.node;
  if (k === "symbol") return K.pinPoints(doc, item).map((p) => [r4(p.x), r4(p.y)]);
  if (k === "sheet") return kids(n, "pin").map((p) => atOf(p).slice(0, 2).map(r4));
  if (k === "bus_entry") { const [x, y] = atOf(n), s = kid(n, "size"); return [[r4(x), r4(y)], [r4(x + num(s && s[1], 2.54)), r4(y + num(s && s[2], 2.54))]]; }
  if (isNetLine(k)) { const p = ptsOf(n); return p.length > 1 ? [p[0].slice(), p[p.length - 1].slice()] : []; }
  if (POINT_KINDS.has(k) || LABEL_KINDS.has(k)) return [atOf(n).slice(0, 2).map(r4)];
  return [];
}
export function labelsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (LABEL_KINDS.has(it.kind) && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
export function sheetPinsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "sheet" && it !== skip) for (const pin of kids(it.node, "pin")) if (same(atOf(pin), p)) { out.push(it); break; } return out; }
export function noConnectsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "no_connect" && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
export function busEntriesAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "bus_entry" && it !== skip && connPoints(doc, it).some((q) => same(q, p))) out.push(it); return out; }
// Which net lines a dragged item attaches to at a point (pins and sheet pins take wires only).
export function lineKindsFor(item: KItem) { return item.kind === "bus" ? ["bus"] : item.kind === "symbol" || item.kind === "sheet" || item.kind === "wire" || item.kind === "no_connect" ? ["wire"] : ["wire", "bus"]; }

// One anchor per connection point: the line ends that stretch, the stub wire to create and the
// no-connects that follow.  `moving` holds the ids travelling with the drag; they never anchor.
export function makeAnchor(doc: KDoc, item: KItem, p: Pt, moving: Set<string>): Anchor {
  const a: Anchor = { p: [r4(p[0]), r4(p[1])], ends: [], stub: null, followers: [] };
  const j = junctionAt(doc, p[0], p[1]);
  const fixedJunction = j && !moving.has(j.id) ? j : null;
  const ends = [];
  for (const kd of lineKindsFor(item)) for (const e of lineEndsAt(doc, p[0], p[1], kd)) if (!moving.has(e.item.id) && ptsOf(e.item.node).length > 1) ends.push(e);
  // An unselected junction on the point isolates the lines from the drag: the junction itself
  // gets the new stub wire and the lines stay put (getConnectedDragItems' ptHasUnselectedJunction).
  if (fixedJunction) a.stub = { from: a.p, kind: item.kind === "bus" || ends.some((e) => e.item.kind === "bus") ? "bus" : "wire" };
  else for (const e of ends) a.ends.push({ item: e.item, index: e.index, orig: ptsOf(e.item.node).map((q) => q.slice()) });
  if (!a.stub && item.kind !== "no_connect") {
    const fixed = pinsAt(doc, p[0], p[1]).some((q) => !moving.has(q.item.id))
      || labelsAt(doc, a.p, item).some((l) => !moving.has(l.id))
      || sheetPinsAt(doc, a.p, item).some((s) => !moving.has(s.id))
      || (item.kind !== "bus_entry" && busEntriesAt(doc, a.p, item).some((b) => !moving.has(b.id)));
    if (fixed) a.stub = { from: a.p, kind: item.kind === "bus" ? "bus" : "wire" };
    else if (LABEL_KINDS.has(item.kind)) {           // a label dragged off the middle of a line splits it (KiCad adds the junction)
      for (const kd of ["wire", "bus"]) { const mids = lineMidsAt(doc, p[0], p[1], kd).filter((m) => !moving.has(m.id) && ptsOf(m.node).length === 2); if (mids.length) { a.stub = { from: a.p, kind: kd, split: mids[0] }; break; } }
    }
  }
  if (item.kind !== "no_connect") for (const nc of noConnectsAt(doc, a.p, item)) if (!moving.has(nc.id)) a.followers.push({ item: nc, orig: atOf(nc.node).slice(0, 2) });
  return a;
}
// Items riding on a dragged net line: labels, junctions, entries and no-connects sitting on it.
// A junction at an end of the line is not a rider — it stays and gets a stub wire instead.
export function ridersOf(doc: KDoc, item: KItem) {
  const out: Rider[] = []; if (!isNetLine(item.kind)) return out;
  const pts = ptsOf(item.node); if (pts.length < 2) return out;
  const endsP = [pts[0], pts[pts.length - 1]], sg = segs(item);
  for (const it of doc.items.values()) {
    if (!RIDER_KINDS.has(it.kind) || it === item) continue;
    const cps = it.kind === "bus_entry" ? connPoints(doc, it) : [atOf(it.node).slice(0, 2)];
    if (!cps.some((c) => sg.some(([a, b]) => segDist(c, a, b) <= 1e-3))) continue;
    if (it.kind === "junction" && endsP.some((e) => same(e, atOf(it.node)))) continue;
    out.push({ item: it, orig: atOf(it.node).slice(0, 2) });
  }
  return out;
}

// End state of a stretched 2-point line: fixed end Q, moving end P -> Pn.  90°/45° keep an
// orthogonal line on its axis and add a bend; anything else (free mode, diagonal lines) stretches.
export function bendPath(Q: Pt, P: Pt, Pn: Pt, lineMode: string): Pt[] {
  if (same(P, Pn)) return [Q, P];
  if (lineMode === "free" || same(Q, P)) return [Q, Pn];
  const horiz = Math.abs(Q[1] - P[1]) <= 1e-3, vert = Math.abs(Q[0] - P[0]) <= 1e-3;
  if (!horiz && !vert) return [Q, Pn];
  let C = horiz ? [Pn[0], Q[1]] : [Q[0], Pn[1]];
  if (lineMode === "45") {                                 // the jog leaves the axis at 45°
    const ax = Math.abs(Pn[0] - Q[0]), ay = Math.abs(Pn[1] - Q[1]);
    const C45 = horiz ? [r4(Pn[0] - Math.sign(Pn[0] - Q[0]) * ay), Q[1]] : [Q[0], r4(Pn[1] - Math.sign(Pn[1] - Q[1]) * ax)];
    const run = horiz ? (C45[0] - Q[0]) * (Pn[0] - Q[0]) : (C45[1] - Q[1]) * (Pn[1] - Q[1]);
    if (run > 1e-6) C = C45; else if ((horiz ? ax : ay) <= 1e-6) return [Q, Pn];
  }
  C = [r4(C[0]), r4(C[1])];
  if (same(C, Q) || same(C, Pn)) return [Q, Pn];
  return [Q, C, Pn];
}
// New point list for a stretched end plus the extra bend segment (null when there is none).
export function endGeometry(e: LineEnd, Pn: Pt, lineMode: string): { pts: Pt[]; extra: Pt[] | null; zero: boolean } {
  const pts = e.orig.map((q: Pt) => q.slice());
  if (pts.length !== 2) { pts[e.index] = Pn.slice(); return { pts, extra: null, zero: false }; }
  const P = pts[e.index], Q = pts[e.index === 0 ? 1 : 0];
  const path = bendPath(Q, P, Pn, lineMode);
  if (path.length === 3) return { pts: e.index === 0 ? [path[1], path[0]] : [path[0], path[1]], extra: [path[1], path[2]], zero: false };
  return { pts: e.index === 0 ? [path[1], path[0]] : [path[0], path[1]], extra: null, zero: same(path[0], path[1]) };
}
export function restoreNode(node: SNode, orig: SNode) { node.length = 0; for (const c of deep(orig)) node.push(c); }
export function lineCovers(doc: KDoc, kind: string, a: Pt, b: Pt) {                   // an existing collinear line already spans a-b
  for (const it of doc.items.values()) { if (it.kind !== kind) continue; for (const [s, e] of segs(it)) if (segDist(a, s, e) <= 1e-3 && segDist(b, s, e) <= 1e-3) return true; }
  return false;
}

// One item or a list of them (a multi-selection): every connection point of every moved item is an
// anchor, riders of every moved net line come along, and a line whose ends all sit on moved items
// (a wire between two dragged symbols) is promoted into the moved set so it just moves.
export function beginDrag(ctx: SchCtx, items: KItem | KItem[], mm: Pt, byPointer?: boolean, opts?: { plain?: boolean }) {
  const doc = ctx.doc, seen = new Set<string>(), list: KItem[] = [], partial: PartialLine[] = [];
  for (const it of Array.isArray(items) ? items : [items]) if (it && DRAG_KINDS.has(it.kind) && !seen.has(it.id)) {
    seen.add(it.id);
    // a line selected by one end (STARTPOINT / ENDPOINT): SCH_MOVE_TOOL::moveItem moves that end only
    const e = !(opts && opts.plain) && S.selEnds ? S.selEnds.get(it.id) : undefined, pts = e === 0 || e === 1 ? ptsOf(it.node) : null;
    if (pts && pts.length === 2) partial.push({ item: it, index: e!, orig: pts.map((q) => q.slice()) }); else list.push(it);
  }
  if (!list.length && !partial.length) return null;
  if (S.drag) endDrag(ctx, false);
  const item = list[0] || partial[0].item, anchor0 = list.length ? anchorOf(item.kind, item.node) : partial[0].orig[partial[0].index].slice();
  const d: SchDrag = { items: list.map((it) => ({ item: it, kind: it.kind, orig: deep(it.node) })), item, kind: item.kind, orig: null, anchor0, grab: [mm[0] - anchor0[0], mm[1] - anchor0[1]],
    last: [0, 0], applied: [0, 0], moved: false, byPointer: !!byPointer, riders: [], anchors: [], preview: [] };
  if (partial.length) d.ends = partial;
  d.orig = d.items.length ? d.items[0].orig : deep(item.node);
  for (let pass = 0; pass < 8 && !(opts && opts.plain); pass++) {   // plain: new items (a paste) carry nothing along                   // re-resolve after each promotion, the moved set grew
    const moving = new Set([...d.items.map((e) => e.item.id), ...partial.map((e) => e.item.id)]);
    d.riders = [];
    for (const e of d.items) for (const r of ridersOf(doc, e.item)) if (!moving.has(r.item.id)) { moving.add(r.item.id); d.riders.push(r); }
    // a label on a partly selected line's moved end goes with it when dragging (getConnectedDragItems), not when moving
    const endLabels: Rider[][] = partial.map((e) => isNetLine(e.item.kind) ? labelsAt(doc, e.orig[e.index]).filter((l) => !moving.has(l.id)).map((l) => ({ item: l, orig: atOf(l.node).slice(0, 2) })) : []);
    for (const l of endLabels) for (const r of l) moving.add(r.item.id);
    d.anchors = [];
    for (const e of d.items) for (const p of connPoints(doc, e.item)) d.anchors.push(makeAnchor(doc, e.item, p, moving));
    partial.forEach((e, i) => { if (!isNetLine(e.item.kind)) return; const a = makeAnchor(doc, e.item, e.orig[e.index], moving); a.followers.push(...endLabels[i]); d.anchors.push(a); });
    for (const r of d.riders) {
      if (r.item.kind === "junction") d.anchors.push(makeAnchor(doc, r.item, r.orig, moving));
      else if (r.item.kind === "bus_entry") for (const p of connPoints(doc, r.item)) d.anchors.push(makeAnchor(doc, r.item, p, moving));
    }
    const seenEnd = new Set<string>();                              // a line end belongs to one anchor only
    for (const a of d.anchors) a.ends = a.ends.filter((e) => { const k = e.item.id + ":" + e.index; if (seenEnd.has(k)) return false; seenEnd.add(k); return true; });
    const spanned: KItem[] = [], idx = new Map<string, Set<number>>();
    for (const a of d.anchors) for (const e of a.ends) { if (!idx.has(e.item.id)) idx.set(e.item.id, new Set()); idx.get(e.item.id)!.add(e.index); }
    for (const [id, ends] of idx) { const it = doc.items.get(id); const n = it ? ptsOf(it.node).length : 0; if (it && n > 1 && ends.has(0) && ends.has(n - 1)) spanned.push(it); }
    if (!spanned.length) {
      for (const a of d.anchors) for (const f of a.followers) moving.add(f.item.id);
      for (const e of partial) e.attach = isNetLine(e.item.kind) ? partialAttach(doc, e, moving) : undefined;
      break;
    }
    for (const it of spanned) d.items.push({ item: it, kind: it.kind, orig: deep(it.node) });
  }
  // SCH_MOVE_TOOL: a SCH_DRAG_NET_COLLISION_MONITOR for any selection that is not graphics only
  d.collision = d.items.some((e) => connPoints(doc, e.item).length) ? collisionInit(doc, d, !!(opts && opts.plain)) : null;
  S.drag = d; announceModes(ctx); return d;
}
// Live preview: the moved items and stretched ends are edited in place (restored by endDrag),
// stub wires are drawn from d.preview by the overlay.
export function applyDrag(doc: KDoc, d: SchDrag, dx: number, dy: number) {
  for (const e of d.items) {
    if (e.base) { restoreNode(e.item.node, e.base); if (dx || dy) shiftNode(e.kind, e.item.node, dx, dy); }
    else if (!dx && !dy) restoreNode(e.item.node, e.orig);
    else shiftNode(e.kind, e.item.node, r4(dx - d.applied[0]), r4(dy - d.applied[1]));
    K.replaceChange(doc, e.item);
  }
  d.applied = [dx, dy];
  for (const r of d.riders) { if (r.base) restoreNode(r.item.node, r.base); const [cx, cy] = atOf(r.item.node); shiftNode(r.item.kind, r.item.node, r4(r.orig[0] + dx - cx), r4(r.orig[1] + dy - cy)); K.replaceChange(doc, r.item); }
  d.preview = [];
  const connected = S.dragMode === "drag";
  for (const e of d.ends || []) {
    const g = partialGeometry(e, dx, dy, connected && !d.mode && S.lineMode !== "free");
    setPts(e.item.node, g.pts); K.replaceChange(doc, e.item);
    if (e.attach) for (const l of e.attach.lines) { const q = l.orig.map((v) => v.slice()); if (g.stretch === l) q[l.index] = [r4(q[l.index][0] + g.perp[0]), r4(q[l.index][1] + g.perp[1])]; setPts(l.item.node, q); K.replaceChange(doc, l.item); }
    for (const x of g.extra) d.preview.push({ kind: e.item.kind, pts: x });
  }
  for (const a of d.anchors) {
    const Pn = anchorTo(d, a.p, dx, dy);
    for (const e of a.ends) {
      let pts = e.orig.map((q: Pt) => q.slice());
      if (connected) { const g = endGeometry(e, Pn, d.mode ? "free" : S.lineMode); pts = g.extra ? (e.index === 0 ? [g.extra[1], g.extra[0], g.pts[1]] : [g.pts[0], g.extra[0], g.extra[1]]) : g.pts; }
      setPts(e.item.node, pts); K.replaceChange(doc, e.item);
    }
    for (const f of a.followers) { const to = connected ? Pn : f.orig; const [cx, cy] = atOf(f.item.node); shiftNode(f.item.kind, f.item.node, r4(to[0] - cx), r4(to[1] - cy)); K.replaceChange(doc, f.item); }
    if (connected && a.stub && !same(a.p, Pn)) d.preview.push({ kind: a.stub.kind, pts: [a.p, Pn] });
  }
}
/** Where a connection point found before the drag is now: turned with the drag's R / X / Y, then moved. */
export function anchorTo(d: SchDrag, p: Pt, dx: number, dy: number): Pt { const q = d.mapPt ? d.mapPt(p) : p; return [r4(q[0] + dx), r4(q[1] + dy)]; }
/** The nodes as they were before the drag (a drag turned with R keeps its turned copies in `base`). */
export function restorePristine(doc: KDoc, d: SchDrag) {
  for (const e of d.items) if (e.base) { restoreNode(e.item.node, e.orig); K.replaceChange(doc, e.item); }
  for (const r of d.riders) if (r.node0) { restoreNode(r.item.node, r.node0); K.replaceChange(doc, r.item); }
  if (d.mapPt) for (const a of d.anchors) {                // the wires stretched to the turned pins go back too
    for (const e of a.ends) { setPts(e.item.node, e.orig.map((q: Pt) => q.slice())); K.replaceChange(doc, e.item); }
    for (const f of a.followers) { const [cx, cy] = atOf(f.item.node); shiftNode(f.item.kind, f.item.node, r4(f.orig[0] - cx), r4(f.orig[1] - cy)); K.replaceChange(doc, f.item); }
  }
}
export function moveDrag(ctx: SchCtx, mm: Pt) {
  const d = S.drag; if (!d) return;
  const t = ctx.snap([mm[0] - d.grab[0], mm[1] - d.grab[1]]);
  const dx = r4(t[0] - d.anchor0[0]), dy = r4(t[1] - d.anchor0[1]);
  if (dx === d.last[0] && dy === d.last[1]) return;
  d.last = [dx, dy]; d.moved = true;
  applyDrag(ctx.doc, d, dx, dy); ctx.requestRender();
}
export function endDrag(ctx: SchCtx, commit: boolean) {
  const d = S.drag; S.drag = null; collisionCursor(ctx.stage, false); if (!d) return;
  // only a drag that really moved (or a key-started move) eats the following double click; an unmoved
  // press/release on a selected item must leave the dblclick to open its properties (SCH_SELECTION_TOOL::Main)
  if (d.moved || !d.byPointer) S.dragEndedAt = Date.now();
  const [dx, dy] = d.last, doc = ctx.doc;
  applyDrag(doc, d, 0, 0);                      // originals back first, so commit() records a true inverse
  const done = () => { if (d.restoreMode) { S.dragMode = d.restoreMode; announceModes(ctx); } ctx.requestRender(); };
  if (d.brk) { endBreak(ctx, d, commit); done(); return; }
  if (d.local) {                                // a paste / duplicate in flight: never committed yet
    if (!commit) { dropLocal(ctx, d); done(); return; }
    const changes = dragChanges(ctx, d, dx, dy, true);
    for (const id of d.local) ctx.doc.items.delete(id);
    if (changes.length) ctx.commit(changes, d.label || "paste");
    setSelectionIds(ctx, Array.from(d.local).filter((id) => ctx.doc.items.has(id)));
    done(); return;
  }
  const turned = !!d.mapPt;
  if (!commit || (!turned && (!d.moved || (!dx && !dy)))) { restorePristine(doc, d); done(); return; }
  const changes = dragChanges(ctx, d, dx, dy, true);
  if (changes.length) ctx.commit(changes, S.dragMode === "drag" ? "drag" : "move");
  done();
}
// The local items of a paste in flight go, with the library symbols the paste brought in.
export function dropLocal(ctx: SchCtx, d: SchDrag) {
  for (const id of d.local!) ctx.doc.items.delete(id);
  for (const name of d.libs || []) if (!Array.from(ctx.doc.items.values()).some((it) => it.kind === "symbol" && symbolLibId(it.node) === name)) ctx.doc.lib.delete(name);
  setSelectionIds(ctx, []);
}
export function cancelDrag(ctx: SchCtx) { if (S.drag) endDrag(ctx, false); }

// The committed change set for a finished drag, built from cloned nodes.
export function dragChanges(ctx: SchCtx, d: SchDrag, dx: number, dy: number, pristine = false) {
  const doc = ctx.doc, connected = S.dragMode === "drag", out = new Map<string, KChange>();
  // a turned drag builds from the turned copies, then hands the document its pre-drag nodes back so the commit's undo is true
  const res = dragChangeList(ctx, d, dx, dy, connected, out);
  if (pristine) restorePristine(doc, d);
  return res;
}
function dragChangeList(ctx: SchCtx, d: SchDrag, dx: number, dy: number, connected: boolean, out: Map<string, KChange>) {
  const doc = ctx.doc;
  const put = (c: KChange) => {
    const prev = out.get(c.id);
    if (prev && prev.kind === "ADDED" && c.kind === "REMOVED") { out.delete(c.id); doc.items.delete(c.id); return; }
    if (prev && prev.kind === "ADDED" && c.kind === "MODIFIED") c = Object.assign({}, c, { kind: "ADDED" });
    out.set(c.id, c);
  };
  const touched: Pt[] = [];
  for (const e of d.items) { const n = deep(e.item.node); shiftNode(e.kind, n, dx, dy); const c = modChange(doc, e.item, n); put(d.local && d.local.has(e.item.id) ? Object.assign(c, { kind: "ADDED" }) : c); }
  for (const r of d.riders) { const n = deep(r.item.node); shiftNode(r.item.kind, n, dx, dy); put(modChange(doc, r.item, n)); }
  for (const e of d.ends || []) {
    const g = partialGeometry(e, dx, dy, connected && !d.mode && S.lineMode !== "free"), pts = g.pts;
    touched.push(...e.orig, ...pts);
    if (same(pts[0], pts[1])) put(K.removeChange(e.item));
    else { const n = deep(e.item.node); setPts(n, pts); put(modChange(doc, e.item, n)); }
    if (g.stretch) {
      const l = g.stretch, q = l.orig.map((v) => v.slice()); q[l.index] = [r4(q[l.index][0] + g.perp[0]), r4(q[l.index][1] + g.perp[1])]; touched.push(q[l.index]);
      if (same(q[0], q[q.length - 1])) put(K.removeChange(l.item)); else { const n = deep(l.item.node); setPts(n, q); put(modChange(doc, l.item, n)); }
    }
    for (const x of g.extra) if (!same(x[0], x[1])) { put(addNode(doc, lineNode(e.item.kind, x[0], x[1])).change); touched.push(...x); }
  }
  for (const e of d.items) for (const p of (d.local && isNetLine(e.kind) ? ptsOf(e.item.node) : connPoints(doc, e.item))) { if (!d.local) touched.push(p); touched.push([r4(p[0] + dx), r4(p[1] + dy)]); }
  for (const p of d.touched0 || []) touched.push(p);
  if (connected) for (const a of d.anchors) {
    const Pn = anchorTo(d, a.p, dx, dy); touched.push(a.p, Pn);
    for (const e of a.ends) {
      const g = endGeometry(e, Pn, d.mode ? "free" : S.lineMode);
      if (g.zero) { put(K.removeChange(e.item)); continue; }
      const n = deep(e.item.node); setPts(n, g.pts); put(modChange(doc, e.item, n));
      if (g.extra) { put(addNode(doc, lineNode(e.item.kind, g.extra[0], g.extra[1])).change); touched.push(g.extra[0]); }
    }
    for (const f of a.followers) { const n = deep(f.item.node), [cx, cy] = atOf(n); shiftNode(f.item.kind, n, r4(Pn[0] - cx), r4(Pn[1] - cy)); put(modChange(doc, f.item, n)); }
    if (a.stub && !same(a.p, Pn)) {
      if (a.stub.split) {                        // the line the label sat on becomes two lines meeting at the stub
        const m = a.stub.split, mp = ptsOf(m.node), n = deep(m.node);
        setPts(n, [mp[0], a.p]); put(modChange(doc, m, n));
        put(addNode(doc, lineNode(m.kind, a.p, mp[1])).change);
      }
      if (!lineCovers(doc, a.stub.kind, a.p, Pn)) put(addNode(doc, lineNode(a.stub.kind, a.p, Pn)).change);
    }
  }
  const keep = new Set([...d.items.map((e) => e.item.id), ...d.riders.map((r) => r.item.id), ...(d.ends || []).map((e) => e.item.id)]);
  for (const c of cleanupAt(doc, Array.from(out.values()), touched, keep, ctx.IU || 1e4)) put(c);
  for (const c of out.values()) if (c.kind === "ADDED") doc.items.delete(c.id);   // commit re-adds them from the fragments
  return autoRotateChanges(doc, Array.from(out.values()), ctx.IU || 1e4);
}
// SCHEMATIC::CleanUp + AddJunctionsIfNeeded around the touched points, evaluated on a dry run
// of the changes (applied, inspected, then swapped back so the document is untouched).
export function cleanupAt(doc: KDoc, changes: KChange[], touched: Pt[], keep: Set<string>, IU: number) {
  const saved = new Map<string, KItem | null>(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  for (const c of changes) K.applyChange(doc, c, IU);
  const out: KChange[] = [], seen = new Set<string>();
  try {
    for (const p of touched) {
      const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
      const j = junctionAt(doc, p[0], p[1]);
      const needed = needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      const dropJ = j && !needed && !keep.has(j.id);
      if (dropJ) out.push(K.removeChange(j));
      else if (!j && needed) out.push(addNode(doc, junctionNode(p)).change);
      if ((!j || dropJ) && !needed) for (const kd of ["wire", "bus"]) { const m = mergeAt(doc, p, kd); if (m) { out.push(...m); break; } }
    }
  } finally {
    for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); }
  }
  return out;
}
// Two same-kind lines meeting end to end at p with nothing else there: one straight line.
export function mergeAt(doc: KDoc, p: Pt, kind: string) {
  const ends = lineEndsAt(doc, p[0], p[1], kind); if (ends.length !== 2 || ends[0].item === ends[1].item) return null;
  if (pinsAt(doc, p[0], p[1]).length || labelsAt(doc, p).length || sheetPinsAt(doc, p).length || noConnectsAt(doc, p).length || busEntriesAt(doc, p).length) return null;
  if (lineMidsAt(doc, p[0], p[1], "wire").length || lineMidsAt(doc, p[0], p[1], "bus").length) return null;
  const [A, B] = ends, pa = ptsOf(A.item.node), pb = ptsOf(B.item.node); if (pa.length !== 2 || pb.length !== 2) return null;
  const fa = pa[A.index === 0 ? 1 : 0], fb = pb[B.index === 0 ? 1 : 0];
  const u = [fa[0] - p[0], fa[1] - p[1]], v = [fb[0] - p[0], fb[1] - p[1]];
  if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-6 || u[0] * v[0] + u[1] * v[1] >= 0) return null;   // must run straight through p
  const n = deep(A.item.node); setPts(n, A.index === 0 ? [fb, fa] : [fa, fb]);
  return [modChange(doc, A.item, n), K.removeChange(B.item)];
}

// ---------------------------------------------------------------- a line selected by one end (SCH_MOVE_TOOL)
/** m_lineConnectionCache for the unselected end of a partly selected net line: what is attached there and not moving. */
export function partialAttach(doc: KDoc, e: PartialLine, moving: Set<string>): NonNullable<PartialLine["attach"]> {
  const q = e.orig[e.index === 0 ? 1 : 0], kinds = e.item.kind === "bus" ? ["bus"] : ["wire", "bus"];
  const lines: LineEnd[] = [];
  for (const kd of kinds) for (const le of lineEndsAt(doc, q[0], q[1], kd)) if (le.item !== e.item && !moving.has(le.item.id)) lines.push({ item: le.item, index: le.index, orig: ptsOf(le.item.node).map((v) => v.slice()) });
  const j = junctionAt(doc, q[0], q[1]), junction = !!j && !moving.has(j.id);
  const pin = pinsAt(doc, q[0], q[1]).some((p) => !moving.has(p.item.id)) || sheetPinsAt(doc, q).some((s) => !moving.has(s.id));
  const any = lines.length > 0 || junction || pin || labelsAt(doc, q).some((l) => !moving.has(l.id)) || busEntriesAt(doc, q).some((b) => !moving.has(b.id))
    || lineMidsAt(doc, q[0], q[1], e.item.kind === "bus" ? "bus" : "wire").some((m) => m !== e.item && !moving.has(m.id));
  return { lines, junction, pin, any };
}
/**
 * The points of a partly selected line moved by (dx, dy): moveItem moves the selected end; in DRAG with the line mode
 * constrained, orthoLineDrag keeps an orthogonal line orthogonal for the part of the move across it — the attached
 * line running that way stretches and the whole line shifts, a junction alone gets a new wire to the shifted end,
 * anything else (a pin, a label) keeps the line and gets a bend at the moved end; a free end just moves.
 * `stretch` is the attached line whose end follows by `perp`, `extra` the new lines.
 */
export function partialGeometry(e: PartialLine, dx: number, dy: number, ortho: boolean): { pts: Pt[]; perp: Pt; stretch: LineEnd | null; extra: Pt[][] } {
  const pts = e.orig.map((v) => v.slice()), i = e.index, o = i === 0 ? 1 : 0, P = pts[i], Q = pts[o];
  const Pn = [r4(P[0] + dx), r4(P[1] + dy)], none = { perp: [0, 0], stretch: null, extra: [] as Pt[][] };
  const horiz = Math.abs(P[1] - Q[1]) <= 1e-6, vert = Math.abs(P[0] - Q[0]) <= 1e-6;
  if (!ortho || !e.attach || !e.attach.any || (horiz && vert) || (!horiz && !vert)) { pts[i] = Pn; return { pts, ...none }; }
  const perp: Pt = horiz ? [0, dy] : [dx, 0];
  if (!perp[0] && !perp[1]) { pts[i] = Pn; return { pts, ...none }; }
  const Qn = [r4(Q[0] + perp[0]), r4(Q[1] + perp[1])];
  // a connected line running the way of the move (or shortened to nothing) lengthens / shortens
  const along = (l: LineEnd) => { const a = l.orig[0], b = l.orig[l.orig.length - 1]; return l.orig.length === 2 && (horiz ? Math.abs(a[0] - b[0]) <= 1e-6 && Math.abs(a[1] - b[1]) > 1e-6 : Math.abs(a[1] - b[1]) <= 1e-6 && Math.abs(a[0] - b[0]) > 1e-6); };
  const found = e.attach.lines.find(along) || null;
  if (found) { pts[i] = Pn; pts[o] = Qn; return { pts, perp, stretch: found, extra: [] }; }
  if (e.attach.junction && !e.attach.pin) { pts[i] = Pn; pts[o] = Qn; return { pts, perp, stretch: null, extra: [[Q, Qn]] }; }
  // the bend: the line stays, running to the moved end's parallel coordinate, and a new segment goes across
  const C = horiz ? [Pn[0], Q[1]] : [Q[0], Pn[1]];
  pts[i] = C; return { pts, perp: [0, 0], stretch: null, extra: [[C, Pn]] };
}
