import type { EditFollower, EditPoints, PointEdit, PtrEvent, SchCtx, Pt, Box } from "./types";
import { restoreNode } from "./drag";
import { TEXTBOX_MARGIN } from "./nodes";
import { mmPerPx, snapConn } from "./snap";
import { K, S, atOf, kid, kids, num, ptsOf, setPts, str } from "./state";
import { deep, modChange, r4, same } from "./util";

// ---------------------------------------------------------------- point editor (eeschema/tools/sch_point_editor.cpp)
// A single selected line, shape, text box, sheet or rule area shows KiCad's edit points; dragging one reshapes
// the item ("Move Point").  Rectangles, text boxes and sheets also get the four edge handles (EDIT_LINE midpoints)
// that move one side; a rectangle's centre point moves it whole.  Graphic lines drag the graphic line joined at
// the edited end (LINE_POINT_EDIT_BEHAVIOR, notes layer only); a sheet's pins stay on their edges
// (SCH_SHEET::Resize / ConstrainOnEdge) and the wires and no-connects on them follow.
export const PE_MIN = 0.0254;                                   // schIUScale.MilsToIU( 1 )
export const RECT_LINES = [[0, 1], [1, 3], [3, 2], [2, 0]];      // RECT_TOP, RECT_RIGHT, RECT_BOT, RECT_LEFT
export function boxOf(item: Pick<KItem, "kind" | "node">): Box {
  const n = item.node;
  if (item.kind === "rectangle") { const s = kid(n, "start")!, e = kid(n, "end")!; return [Math.min(num(s[1]), num(e[1])), Math.min(num(s[2]), num(e[2])), Math.max(num(s[1]), num(e[1])), Math.max(num(s[2]), num(e[2]))]; }
  const at = kid(n, "at")!, sz = kid(n, "size")!; const x = num(at[1]), y = num(at[2]), w = num(sz[1]), h = num(sz[2]);
  return [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)];
}
export function circleOf(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
export const kp = (n: SNode, key: string): Pt | null => { const k = kid(n, key); return k ? [num(k[1]), num(k[2])] : null; };
// The edit points of an item: { pts, lines (edge handles, by point index pairs), guides (indicator lines) } or null.
export function editPoints(doc: KDoc, item: KItem): EditPoints | null {
  if (!item) return null;
  const k = item.kind, n = item.node;
  if (k === "wire" || k === "bus" || k === "polyline" || k === "bezier") {
    const pts = ptsOf(n); if (pts.length < 2) return null;
    return { pts, lines: [], guides: k === "bezier" && pts.length === 4 ? [[0, 1], [3, 2]] : [] };
  }
  if (k === "rule_area") { const pl = kid(n, "polyline"); const pts = pl ? ptsOf(pl) : []; return pts.length ? { pts, lines: [], guides: [] } : null; }
  if (k === "rectangle" || k === "text_box" || k === "sheet") {
    const [x0, y0, x1, y1] = boxOf(item);
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    if (k !== "sheet") pts.push([(x0 + x1) / 2, (y0 + y1) / 2]);     // RECT_CENTER
    return { pts, lines: RECT_LINES, guides: [] };
  }
  if (k === "circle") { const c = kp(n, "center"), r = num((kid(n, "radius") || [])[1]); return c ? { pts: [c, [c[0] + r, c[1]]], lines: [], guides: [] } : null; }
  if (k === "arc") {
    const s = kp(n, "start"), m = kp(n, "mid"), e = kp(n, "end"); if (!s || !m || !e) return null;
    const c = circleOf(s, m, e); if (!c) return null;
    return { pts: [s, m, e, c], lines: [], guides: [[3, 0], [3, 2]] };            // ARC_START, ARC_MID, ARC_END, ARC_CENTER
  }
  return null;
}
// Handles in pick order: the points, then each edge's midpoint (index pts.length + line).
export function editHandles(ep: EditPoints): Pt[] { return ep.pts.concat(ep.lines.map(([a, b]) => [(ep.pts[a][0] + ep.pts[b][0]) / 2, (ep.pts[a][1] + ep.pts[b][1]) / 2])); }
export const normA = (a: number) => { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
// The arc through start and end on circle c, swept the way the original arc went: its true midpoint.
export function arcMid(c: Pt, s: Pt, e: Pt, ccw: boolean): Pt {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = Math.atan2(e[1] - c[1], e[0] - c[0]), r = Math.hypot(s[0] - c[0], s[1] - c[1]);
  const am = ccw ? a0 + normA(a1 - a0) / 2 : a0 - normA(a0 - a1) / 2;
  return [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)];
}
export const resize = (c: Pt, v: Pt, r: number): Pt => { const l = Math.hypot(v[0], v[1]) || 1; return [c[0] + v[0] / l * r, c[1] + v[1] / l * r]; };
// PinEditedCorner: the edited corner (or edge) stays inside the opposite one by the minimum size.
export function pinCorner(idx: number, tl: Pt, tr: Pt, bl: Pt, br: Pt, minW: number, minH: number) {
  if (idx === 0) { tl[0] = Math.min(tl[0], br[0] - minW); tl[1] = Math.min(tl[1], br[1] - minH); tr[1] = tl[1]; bl[0] = tl[0]; }
  else if (idx === 1) { tr[0] = Math.max(tr[0], bl[0] + minW); tr[1] = Math.min(tr[1], bl[1] - minH); tl[1] = tr[1]; br[0] = tr[0]; }
  else if (idx === 2) { bl[0] = Math.min(bl[0], tr[0] - minW); bl[1] = Math.max(bl[1], tr[1] + minH); br[1] = bl[1]; tl[0] = bl[0]; }
  else if (idx === 3) { br[0] = Math.max(br[0], tl[0] + minW); br[1] = Math.max(br[1], tl[1] + minH); bl[1] = br[1]; tr[0] = br[0]; }
}
// The new box for a dragged corner (0..3), centre (4, rectangles only) or edge (lines: top, right, bottom, left).
export function editBox(box: Box, ep: EditPoints, idx: number, p: Pt, minW: number, minH: number): Box {
  let [x0, y0, x1, y1] = box;
  const np = ep.pts.length;
  if (idx < 4) {
    const tl = [x0, y0], tr = [x1, y0], bl = [x0, y1], br = [x1, y1], c = [tl, tr, bl, br][idx];
    c[0] = p[0]; c[1] = p[1];
    if (idx === 0) { tr[1] = p[1]; bl[0] = p[0]; } else if (idx === 1) { tl[1] = p[1]; br[0] = p[0]; } else if (idx === 2) { br[1] = p[1]; tl[0] = p[0]; } else { bl[1] = p[1]; tr[0] = p[0]; }
    pinCorner(idx, tl, tr, bl, br, minW, minH);
    return [tl[0], tl[1], br[0], br[1]];
  }
  if (idx === 4 && np === 5) { const dx = p[0] - (x0 + x1) / 2, dy = p[1] - (y0 + y1) / 2; return [x0 + dx, y0 + dy, x1 + dx, y1 + dy]; }
  const edge = idx - np;
  if (edge === 0) y0 = Math.min(p[1], y1 - minH); else if (edge === 1) x1 = Math.max(p[0], x0 + minW);
  else if (edge === 2) y1 = Math.max(p[1], y0 + minH); else if (edge === 3) x0 = Math.min(p[0], x1 - minW);
  return [x0, y0, x1, y1];
}
// Sheet minimum size (SCH_SHEET::GetMinWidth / GetMinHeight): the pins on the moving edges' perpendicular sides keep fitting.
export function sheetMin(node: SNode, box: Box, fromRight: boolean, fromBottom: boolean) {
  let w = PE_MIN, h = PE_MIN;
  for (const pin of kids(node, "pin")) {
    const [x, y, rot] = atOf(pin), r = ((Math.round(rot || 0) % 360) + 360) % 360;
    if (r === 90 || r === 270) w = Math.max(w, fromRight ? x - box[0] : box[2] - x);
    else h = Math.max(h, fromBottom ? y - box[1] : box[3] - y);
  }
  return [w, h];
}
// SCH_TEXTBOX::GetMinSize: the text's own box height (EDA_TEXT::GetTextBox: the stroke glyph extent inflated by
// 1.5 x pen width each side, + 17 %, + an interline pitch per further line, + an overbar's sixth) plus the top
// and bottom margins — or, for vertical text, that plus the left and right margins as a minimum width.  Empty
// text: no minimum.
export function textBoxMinSize(node: SNode): Pt {
  const text = str(node[1]); if (!text) return [0, 0];
  const ef = kid(node, "effects"), f = ef && kid(ef, "font"), sz = f && kid(f, "size"), th = f && kid(f, "thickness"), ls = f && kid(f, "line_spacing");
  const size = sz ? num(sz[2], num(sz[1], 1.27)) : 1.27, bold = !!(f && (f.includes("bold") || (kid(f, "bold") && str(kid(f, "bold")![1]) !== "no")));
  const pen = th && num(th[1]) > 0.001 ? num(th[1]) : Math.min(bold ? size / 5 : size / 8, size / 4);
  const lines = text.split("\n").length, ext = size + 2 * 1.5 * pen;
  let h = ext + 0.17 * ext + (lines - 1) * size * 1.68 * 0.9583 * (ls ? num(ls[1], 1) : 1);
  if (text.includes("~{")) h += ext / 6;
  const mg = kid(node, "margins"), m = mg ? [num(mg[1]), num(mg[2]), num(mg[3]), num(mg[4])] : [TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN];
  const rot = Math.round(num((kid(node, "at") || [])[3], 0)) % 180;
  return rot === 90 ? [r4(h + m[0] + m[2]), 0] : [0, r4(h + m[1] + m[3])];
}
// Apply a dragged edit point: mutates the item's node (and its followers') in place, from the originals in pe.
export function applyPointEdit(doc: KDoc, pe: PointEdit, p: Pt) {
  const item = pe.item, n = item.node, k = item.kind, ep = pe.ep, idx = pe.idx;
  restoreNode(n, pe.orig); for (const f of pe.followers) restoreNode(f.item.node, f.orig);
  const touched = [item];
  if (k === "wire" || k === "bus" || k === "polyline" || k === "bezier") {
    const pts = ep.pts.map((q: Pt) => q.slice()); pts[idx] = [r4(p[0]), r4(p[1])]; setPts(n, pts);
    for (const f of pe.followers) if (f.end === idx) { const q: Pt[] = ptsOf(f.item.node); q[f.index!] = pts[idx].slice(); setPts(f.item.node, q); touched.push(f.item); }
  } else if (k === "rule_area") {
    const pl = kid(n, "polyline")!, pts = ep.pts.map((q: Pt) => q.slice()); pts[idx] = [r4(p[0]), r4(p[1])]; setPts(pl, pts);
  } else if (k === "circle") {
    const c = ep.pts[0];
    if (idx === 0) { const ck = kid(n, "center")!; ck[1] = r4(p[0]); ck[2] = r4(p[1]); }
    else { const rk = kid(n, "radius")!; rk[1] = r4(Math.max(PE_MIN, Math.hypot(p[0] - c[0], p[1] - c[1]))); }
  } else if (k === "arc") {
    const [s, m, e, c] = ep.pts, ccw = normA(Math.atan2(m[1] - c[1], m[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0])) < normA(Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]));
    let ns = s, ne = e, cc = c;
    if (idx === 3) { const dx = p[0] - c[0], dy = p[1] - c[1]; ns = [s[0] + dx, s[1] + dy]; ne = [e[0] + dx, e[1] + dy]; cc = p; }
    else if (idx === 1) { const r = Math.max(PE_MIN, Math.hypot(p[0] - c[0], p[1] - c[1])); ns = resize(c, [s[0] - c[0], s[1] - c[1]], r); ne = resize(c, [e[0] - c[0], e[1] - c[1]], r); }   // EditArcMidKeepCenter
    else {                                                                                                                                            // EditArcEndpointKeepCenter
      const mv = idx === 0 ? s : e, other = idx === 0 ? e : s;
      let v1: Pt = [p[0] - c[0], p[1] - c[1]]; if (!v1[0] && !v1[1]) v1 = [mv[0] - c[0], mv[1] - c[1]];
      let v2: Pt = [other[0] - c[0], other[1] - c[1]]; if (!v2[0] && !v2[1]) v2 = [1, 0];
      const r = Math.max(PE_MIN, Math.hypot(v1[0], v1[1])), p1 = resize(c, v1, r), p2 = resize(c, v2, r);
      if (idx === 0) { ns = p1; ne = p2; } else { ns = p2; ne = p1; }
    }
    const nm = arcMid(cc, ns, ne, ccw);
    for (const [key, q] of [["start", ns], ["mid", nm], ["end", ne]] as [string, Pt][]) { const kk = kid(n, key)!; kk[1] = r4(q[0]); kk[2] = r4(q[1]); }
  } else if (k === "rectangle" || k === "text_box") {
    const mn = k === "text_box" ? textBoxMinSize(pe.orig) : [0, 0];
    const b = editBox(boxOf({ kind: k, node: pe.orig }), ep, idx, p, Math.max(PE_MIN, mn[0]), Math.max(PE_MIN, mn[1])).map(r4);
    if (k === "rectangle") { const s = kid(n, "start")!, e = kid(n, "end")!; s[1] = b[0]; s[2] = b[1]; e[1] = b[2]; e[2] = b[3]; }
    else { const at = kid(n, "at")!, sz = kid(n, "size")!; at[1] = b[0]; at[2] = b[1]; sz[1] = r4(b[2] - b[0]); sz[2] = r4(b[3] - b[1]); }
  } else if (k === "sheet") {
    const ob = boxOf({ kind: k, node: pe.orig }), np = ep.pts.length, edge = idx - np;
    const fromRight = idx === 1 || idx === 3 || edge === 1, fromBottom = idx === 2 || idx === 3 || edge === 2;
    const [mw, mh] = sheetMin(pe.orig, ob, fromRight, fromBottom);
    const b = editBox(ob, ep, idx, p, mw, mh).map(r4);
    const at = kid(n, "at")!, sz = kid(n, "size")!, dx = r4(b[0] - ob[0]), dy = r4(b[1] - ob[1]);
    at[1] = b[0]; at[2] = b[1]; sz[1] = r4(b[2] - b[0]); sz[2] = r4(b[3] - b[1]);
    if (dx || dy) for (const f of kids(n, "property")) { const fa = kid(f, "at"); if (fa) { fa[1] = r4(num(fa[1]) + dx); fa[2] = r4(num(fa[2]) + dy); } }   // SetPositionIgnoringPins moves the fields
    const moved: Pt[][] = [];
    for (const pin of kids(n, "pin")) {                                                                     // ConstrainOnEdge( pos, false )
      const pa = kid(pin, "at")!, r = ((Math.round(num(pa[3]) || 0) % 360) + 360) % 360, was = [num(pa[1]), num(pa[2])];
      if (r === 0 || r === 180) { pa[1] = r === 180 ? b[0] : b[2]; pa[2] = r4(Math.min(Math.max(num(pa[2]), b[1]), b[3])); }
      else { pa[2] = r === 90 ? b[1] : b[3]; pa[1] = r4(Math.min(Math.max(num(pa[1]), b[0]), b[2])); }
      moved.push([was, [num(pa[1]), num(pa[2])]]);
    }
    for (const f of pe.followers) {
      const mvp = moved.find(([w]) => same(w, f.at!)); if (!mvp || same(mvp[0], mvp[1])) continue;
      if (f.item.kind === "no_connect") { const fa = kid(f.item.node, "at")!; fa[1] = mvp[1][0]; fa[2] = mvp[1][1]; }
      else { const q: Pt[] = ptsOf(f.item.node); q[f.index!] = mvp[1].slice(); setPts(f.item.node, q); }
      touched.push(f.item);
    }
  }
  for (const it of new Set(touched.concat(pe.followers.map((f) => f.item)))) K.replaceChange(doc, it);
  return touched;
}
// The items that follow an edit: graphic lines joined at a graphic line's ends, the wires / no-connects on a sheet's pins.
export function editFollowers(doc: KDoc, item: KItem, ep: EditPoints) {
  const out: EditFollower[] = [];
  if (item.kind === "polyline" && ep.pts.length === 2) {
    for (let end = 0; end < 2; end++) {
      for (const o of doc.items.values()) {
        if (o === item || o.kind !== "polyline") continue;
        const q = ptsOf(o.node); if (q.length !== 2) continue;
        const i = same(q[0], ep.pts[end], 1e-6) ? 0 : same(q[1], ep.pts[end], 1e-6) ? 1 : -1;
        if (i >= 0) { out.push({ item: o, orig: deep(o.node), end, index: i }); break; }
      }
    }
  } else if (item.kind === "sheet") {
    for (const pin of kids(item.node, "pin")) {
      const [x, y] = atOf(pin);
      for (const o of doc.items.values()) {
        if (o.kind === "wire" || o.kind === "bus") { const q = ptsOf(o.node); const i = same(q[0], [x, y], 1e-6) ? 0 : same(q[q.length - 1], [x, y], 1e-6) ? q.length - 1 : -1; if (i >= 0) out.push({ item: o, orig: deep(o.node), at: [x, y], index: i }); }
        else if (o.kind === "no_connect" && same(atOf(o.node), [x, y], 1e-6)) out.push({ item: o, orig: deep(o.node), at: [x, y] });
      }
    }
  }
  return out;
}
// The one item the point editor works on: a single selection of an editable kind.
export function pointEditTarget(ctx: SchCtx) {
  if (S.multi && S.multi.size > 1) return null;
  if (ctx.selection && ctx.selection.size > 1) return null;
  const it = S.sel ? ctx.doc.items.get(S.sel) : ctx.selected ? ctx.doc.items.get(ctx.selected.id) : null;
  if (!it) return null;
  const ep = editPoints(ctx.doc, it); return ep ? { item: it, ep } : null;
}
export const EDIT_POINT_PX = 8;                                  // EDIT_POINT::POINT_SIZE
export function pointEditStart(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null) {
  if (ctx.viewOnly || S.drag || S.wire || S.carry) return false;
  const t = pointEditTarget(ctx); if (!t) return false;
  const tol = (EDIT_POINT_PX / 2 + 2) * mmPerPx(ctx), hs = editHandles(t.ep);
  let best = -1, bd = Infinity;
  hs.forEach((h, i) => { const d = Math.max(Math.abs(h[0] - mm[0]), Math.abs(h[1] - mm[1])); if (d <= tol && d < bd) { bd = d; best = i; } });
  if (best < 0) return false;
  S.pedit = { item: t.item, ep: t.ep, idx: best, orig: deep(t.item.node), followers: editFollowers(ctx.doc, t.item, t.ep), start: hs[best], moved: false, last: hs[best] };
  try { if (ev && ev.pointerId !== undefined) ctx.stage.setPointerCapture(ev.pointerId); } catch (e) { /* not a real pointer */ }
  ctx.requestRender();
  return true;
}
export function pointEditSnap(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null): Pt {
  const pe = S.pedit!, k = pe.item.kind;
  if (k === "wire" || k === "bus") return snapConn(ctx, mm, k, ev);
  if (ev && (ev.ctrlKey || ev.metaKey)) return [r4(mm[0]), r4(mm[1])];
  return ctx.snap([mm[0], mm[1]]).map(r4);
}
export function pointEditMove(ctx: SchCtx, mm: Pt, ev?: PtrEvent | null) {
  const pe = S.pedit; if (!pe) return;
  const p = pointEditSnap(ctx, mm, ev);
  if (!pe.moved && same(p, pe.start)) return;
  pe.moved = true; pe.last = p;
  applyPointEdit(ctx.doc, pe, p); ctx.requestRender();
}
export function pointEditEnd(ctx: SchCtx, commit: boolean) {
  const pe = S.pedit; S.pedit = null; if (!pe) return null;
  const doc = ctx.doc;
  let nodes: { it: KItem; node: SNode }[] | null = null;
  if (commit && pe.moved) { const touched = applyPointEdit(doc, pe, pe.last); nodes = touched.map((it) => ({ it, node: deep(it.node) })); }
  restoreNode(pe.item.node, pe.orig); for (const f of pe.followers) restoreNode(f.item.node, f.orig);   // originals back, so commit() records a true inverse
  K.replaceChange(doc, pe.item); for (const f of pe.followers) K.replaceChange(doc, f.item);
  let changes: KChange[] = [];
  if (nodes) {
    const seen = new Set<string>();
    for (const { it, node } of nodes) { if (seen.has(it.id)) continue; seen.add(it.id); if (K.serialize(node) !== K.serialize(it.node)) changes.push(modChange(doc, it, node)); }
    if (changes.length) ctx.commit(changes, "Move Point");
  }
  ctx.requestRender();
  return changes;
}
// EDIT_POINTS::ViewDraw: filled squares in the aux-items colour with a lighter border; edge handles the same.
export function drawEditPoints(c: CanvasRenderingContext2D, ctx: SchCtx, px: number) {
  const t = S.pedit ? { item: S.pedit.item, ep: editPoints(ctx.doc, S.pedit.item) } : pointEditTarget(ctx); if (!t || !t.ep) return;
  const fill = K.SCH.aux || "#000000", border = "rgba(179,179,179,0.8)", size = EDIT_POINT_PX * px / 2;
  c.save();
  if (t.ep.guides.length) { c.strokeStyle = fill; c.lineWidth = px; c.setLineDash([3 * px, 3 * px]); c.beginPath(); for (const [a, b] of t.ep.guides) { c.moveTo(t.ep.pts[a][0], t.ep.pts[a][1]); c.lineTo(t.ep.pts[b][0], t.ep.pts[b][1]); } c.stroke(); c.setLineDash([]); }
  c.fillStyle = fill; c.strokeStyle = border; c.lineWidth = 3 * px;
  for (const h of editHandles(t.ep)) { c.strokeRect(h[0] - size, h[1] - size, 2 * size, 2 * size); c.fillRect(h[0] - size, h[1] - size, 2 * size, 2 * size); }
  c.restore();
}
