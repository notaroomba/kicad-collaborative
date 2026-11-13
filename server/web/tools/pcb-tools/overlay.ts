// pcb-tools/overlay.ts — the overlay: what the tools draw over the board.
import type { BoardDoc, CopperShape, DrawState, GeomPrim, PcbCtx, Pt, RatsnestLine } from "./types";
import { editorState, netNameOf, netlistCached, sizesOf } from "./app-state";
import { drawArcPreview } from "./arcs";
import { drawStatusPopup, drawTwoPointAssistant } from "./assistants";
import { DIM_TYPE, dimensionNode, snap45 } from "./dimensions";
import type { DimSpec } from "./dimensions";
import { rectCore, shapeOffset } from "./distances";
import { POLY_TOOLS, RULE_AREA_LAYERS, drawWidth } from "./draw-modes";
import { selectionIds } from "./groups";
import { netTable, ratsnest } from "./netlist";
import { netOf } from "./nets";
import { tableGrid } from "./nodes";
import { drawEditPoints } from "./point-editor";
import { padsOf } from "./route-geom";
import { PAD_TOOLS, masterPad } from "./pad-tool";
import { drawDragPreview, drawRoute } from "./route-preview";
import { DEL, HALO_COLOR, HL, K, RATSNEST, RATSNEST_BRIGHT, S, VIA, bind } from "./state";
import { drawTune } from "./tuning-patterns";
import { drawGenEditPreview, drawTuningSelection } from "./tuning-edit";
import { isTuneTool } from "./tuning-tool";
import { color, pt, samePt, vadd, vsub } from "./util";

// ---------------------------------------------------------------- overlay
/** The board's ratsnest, rebuilt after a document change and kept until the next one. */
export function ratsnestLines(doc: BoardDoc) {
  if (!S.rats || S.rats.doc !== doc || S.ratsDirty) { S.rats = { doc, lines: ratsnest(doc, netlistCached(doc)) }; S.ratsDirty = false; }
  return S.rats.lines;
}
/**
 * CONNECTIVITY_DATA::ComputeLocalRatsnest: while items move, one line per net from the moving copper to the nearest
 * stationary anchor of the same net (RN_NET::NearestBicoloredPair) -- the old tracks stay, so the line runs from the
 * moved pad back to where its track ends.  `moving` is a set of item ids; nets whose anchors all move draw nothing.
 */
export function dynamicRatsnest(doc: BoardDoc, moving: Set<string>) {
  if (!moving || !moving.size) return [];
  const NT = netTable(doc), dyn = new Map<string, { p: Pt; id: string }[]>(), stat = new Map<string, { p: Pt; id: string }[]>();
  const put = (m: Map<string, { p: Pt; id: string }[]>, net: string, p: Pt, id: string) => { if (!net) return; let a = m.get(net); if (!a) m.set(net, a = []); a.push({ p, id }); };
  for (const it of doc.items.values()) {
    const mv = moving.has(it.id);
    if (it.kind === "footprint") { for (const p of padsOf(it)) if (p.type !== "np_thru_hole") put(mv ? dyn : stat, NT.key(p.net), [p.x, p.y], it.id); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) put(mv ? dyn : stat, NT.key(netOf(it.node)), a, it.id); }
    else if (it.kind === "segment" || it.kind === "arc") { const k = NT.key(netOf(it.node)); for (const key of ["start", "end"]) { const a = pt(it.node, key); if (a) put(mv ? dyn : stat, k, a, it.id); } }
  }
  const out: { a: Pt; b: Pt; net: string; ids: string[] }[] = [];
  for (const [net, ds] of dyn) {
    const ss = stat.get(net); if (!ss || !ss.length) continue;
    let best: (typeof out)[number] | null = null, bd = Infinity;
    for (const d of ds) for (const t of ss) { const dd = (d.p[0] - t.p[0]) ** 2 + (d.p[1] - t.p[1]) ** 2; if (dd < bd) { bd = dd; best = { a: d.p, b: t.p, net, ids: [d.id, t.id] }; } }
    if (best && bd > 1e-12) out.push(best);
  }
  return out;
}
/** Ids moving right now: the app's footprint drag / Move (M) and the module's own select-tool move. */
export function movingIds() {
  const out = new Set<string>(); const E = editorState();
  const d = E && E.drag; if (d && d.moved) { if (d.group) for (const g of d.group) out.add(g.fp.id); else if (d.fp) out.add(d.fp.id); }
  if (S.move && S.move.moved) { for (const id of S.move.ids || []) out.add(id); for (const c of S.move.conns || []) for (const id of c.l.ids) out.add(id); }   // a D drag's attached lines go with it
  return out;
}
export function strokeGeom(c: CanvasRenderingContext2D, g: GeomPrim) {
  if (g.t === "line") { c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
  else if (g.t === "poly") { if (g.pts.length < 2) return; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); c.stroke(); }
  else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); c.stroke(); }
  else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.stroke(); }
  else if (g.t === "rect" || g.t === "image") c.strokeRect(g.x, g.y, g.w, g.h);
}
export function line(c: CanvasRenderingContext2D, a: Pt, b: Pt) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
/** A router shape grown by `grow` mm, filled (ROUTER_PREVIEW_ITEM's drawShape / drawClearanceHalo). */
export function drawShape(c: CanvasRenderingContext2D, sh: CopperShape, grow: number, colour: string, alpha: number) {
  c.globalAlpha = alpha; c.fillStyle = colour; c.strokeStyle = colour;
  const off = shapeOffset(sh) + grow;
  if (sh.t === "circle") { c.beginPath(); c.arc(sh.x, sh.y, Math.max(off, 1e-4), 0, Math.PI * 2); c.fill(); return; }
  const pts = sh.t === "seg" ? [sh.a, sh.b] : sh.t === "rect" ? rectCore(sh).concat([rectCore(sh)[0]]) : sh.pts;
  const closed = sh.t === "rect" || sh.t === "poly";
  if (closed) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.closePath(); c.fill(); }
  if (off > 0) { c.lineWidth = 2 * off; c.lineJoin = "round"; c.lineCap = "round"; polyline(c, pts, closed); }
}
export function ring(c: CanvasRenderingContext2D, p: Pt, r: number) { c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.stroke(); }
export function polyline(c: CanvasRenderingContext2D, pts: Pt[], close: boolean) { if (pts.length < 2) return; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); if (close) c.closePath(); c.stroke(); }
/** A dimension in progress, drawn from the same geometry the node gets. */
/** The dimension being drawn, as the item it will be (the preview VIEW_GROUP shows the PCB_DIMENSION itself). */
export function drawDimPreview(c: CanvasRenderingContext2D, d: DrawState, px: number) {
  const type = DIM_TYPE[d.shape], layer = S.gfxLayer, s = d.start;
  const dd: DimSpec = { start: s, end: d.end || d.cur, height: d.height || 0, orientation: d.orientation, arrowInward: !!d.arrowInward, thickness: drawWidth(layer) };
  if (type === "center" && !d.end) dd.end = vadd(s, snap45(vsub(d.cur, s)));
  if (samePt(dd.start, dd.end)) return;
  const item = { id: "", kind: "dimension", node: dimensionNode(type, dd, layer) } as KItem;   // buildGeom fills in its geometry
  try { K.buildGeom({ type: "pcb", items: new Map(), layers: new Map(), copper: [] }, item); } catch (e) { return; }
  const m = c.getTransform ? c.getTransform() : null, base = m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null;
  for (const g of (item.geom || []) as GeomPrim[]) {
    if (g.t === "line") { c.lineWidth = Math.max(g.w || 0, px); line(c, [g.x1, g.y1], [g.x2, g.y2]); }
    else if (g.t === "circle") { c.lineWidth = Math.max(g.w || 0, px); ring(c, [g.x, g.y], g.r); }
    else if (g.t === "poly" && g.pts) { c.lineWidth = Math.max(g.w || 0, px); polyline(c, g.pts, !!g.close); }
    else if (g.t === "text" && base && K.drawTextStroke) { c.save(); K.drawTextStroke(c, g, px, c.strokeStyle, base, false); c.restore(); }
  }
}
export function drawOverlay(c: CanvasRenderingContext2D, view: KView, ctx: PcbCtx) {
  bind(ctx); const doc = ctx.doc; if (!doc) return;
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1)); S.mmPerPx = px * (view.dpr || 1);
  c.lineCap = "round"; c.lineJoin = "round";
  // the selection is not drawn here: the document pass repaints selected items in their layer's selected colour
  // (PCB_PAINTER::getColor, m_layerColorsSel), with no outline
  // ratsnest (KiCad's default colour), the whole board or only the lines reaching the selected footprints
  if (S.showRatsnest) {
    const lines = ratsnestLines(doc); const sel = S.localRatsnest ? selectionIds(ctx) : null;
    c.globalAlpha = 1; c.strokeStyle = RATSNEST; c.lineWidth = 1 * px; c.beginPath();
    const curved = K.pcbSizes.state.curvedRatsnest;   // RATSNEST_VIEW_ITEM: a Bezier whose two control points sit 10% off the midpoint
    const trace = (l: { a: Pt; b: Pt }) => {
      c.moveTo(l.a[0], l.a[1]);
      if (curved) { const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], mx = l.a[0] + 0.5 * dx - 0.1 * dy, my = l.a[1] + 0.5 * dy + 0.1 * dx; c.bezierCurveTo(mx, my, mx, my, l.b[0], l.b[1]); }
      else c.lineTo(l.b[0], l.b[1]);
    };
    const tinted: RatsnestLine[] | null = S.ratsnestColors && S.ratsnestColors.size ? [] : null;   // net name -> colour, set by the Appearance pane's Nets tab
    const hlNet = S.route && S.route.netKey ? S.route.netKey : null, bright: RatsnestLine[] | null = hlNet ? [] : null;   // while routing: the rest at half alpha, the routed net brightened 0.8, alpha + 0.4
    if (hlNet) c.globalAlpha = 0.5;
    const moving = movingIds();   // RATSNEST_VIEW_ITEM: the static lines of moving items give way to the dynamic ones
    for (const l of lines) { if (S.hiddenNets.has(l.net)) continue; if (sel && !l.ids.some((id: string) => sel.has(id))) continue; if (moving.size && l.ids.some((id: string) => moving.has(id))) continue; if (bright && l.net === hlNet) { bright.push(l); continue; } if (tinted && S.ratsnestColors!.has(l.net)) { tinted.push(l); continue; } trace(l); }
    c.stroke();
    if (tinted) for (const l of tinted) { c.strokeStyle = S.ratsnestColors!.get(l.net)!; c.beginPath(); trace(l); c.stroke(); }
    if (bright && bright.length) { c.globalAlpha = 1; c.strokeStyle = RATSNEST_BRIGHT; c.beginPath(); for (const l of bright) trace(l); c.stroke(); }
    if (moving.size) { c.globalAlpha = 1; c.strokeStyle = RATSNEST; c.beginPath(); for (const l of dynamicRatsnest(doc, moving)) { if (!S.hiddenNets.has(l.net)) trace(l); } c.stroke(); }
  }
  // the grid origin (circle + X) and the drill / place file origin (circle + cross, red): ORIGIN_VIEWITEM, 16 px, hidden at 0,0
  { const R = K.pcbSizes.state; const r = 16 * px; c.globalAlpha = 1; c.lineWidth = 1 * px;
    const g = S.modTool === "gridorigin" && S.hover ? [S.hover.x, S.hover.y] : R.gridOrigin, d = S.modTool === "drillorigin" && S.hover ? [S.hover.x, S.hover.y] : R.auxOrigin;
    if (g[0] || g[1]) { c.strokeStyle = "#C2C2C2"; ring(c, g, r); line(c, [g[0] - r, g[1] - r], [g[0] + r, g[1] + r]); line(c, [g[0] - r, g[1] + r], [g[0] + r, g[1] - r]); }
    if (d[0] || d[1]) { c.strokeStyle = "#CC0000"; ring(c, d, r); line(c, [d[0] - r, d[1]], [d[0] + r, d[1]]); line(c, [d[0], d[1] - r], [d[0], d[1] + r]); } }
  // DRC markers: PCB_PAINTER::draw(PCB_MARKER) -- MARKER_BASE's pin polygon scaled by 1/sqrt(zoom), filled in
  // LAYER_DRC_ERROR / LAYER_DRC_WARNING over the LAYER_MARKER_SHADOWS outline
  if (S.markers.length && K.drawMarkers) {
    const shown = S.hiddenSeverities && S.hiddenSeverities.size ? S.markers.filter((m) => !S.hiddenSeverities!.has(m.severity)) : S.markers;
    if (shown.length) K.drawMarkers(c, shown, "pcb", K.markerScale("pcb", view), K.PCB_BG);
  }
  // drag in progress (ROUTER::moveDragging): the rebuilt lines over the hidden originals
  drawDragPreview(c, ctx, view, px);
  drawGenEditPreview(c, ctx);   // a tuning pattern being edited: its re-tuned line over the hidden originals
  if (!S.route && !S.draw && !S.drag && !S.modTool) drawTuningSelection(c, ctx, px);   // PCB_TUNING_PATTERN::ViewDraw while selected
  drawEditPoints(c, ctx, px);   // PCB_POINT_EDITOR's EDIT_POINTS over the selected item
  // PAD_PLACER: the pad that a click would put down follows the cursor (F.Cu, or the layer it lives on)
  if (S.modTool && PAD_TOOLS[S.modTool] && S.hover) drawPadPreview(c, doc, PAD_TOOLS[S.modTool], [S.hover.x, S.hover.y], S.padPlace ? S.padPlace.angle : 0, px);
  // route in progress: fixed legs are already in the document, the current one lives here
  // ROUTER::markViolations: obstacles in violation (a refused start or via) in pure green over their clearance halo
  if (S.violations) for (const ob of S.violations.obs) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
  // route in progress (ROUTER::movePlacing): what is fixed on the route's branch, what the shove pushed, the head since
  // the last click (and the via it carries) over its clearance halo, the collisions it marks, then the leading ratsnest line
  if (S.route) drawRoute(c, ctx, px);
  if (isTuneTool(S.modTool)) drawTune(c, ctx, px);
  // drawing preview
  if (S.draw) {
    const d = S.draw; const layer = d.layer || (d.shape === "zone" || d.shape === "thievingzone" ? S.layer : d.shape === "rulearea" ? RULE_AREA_LAYERS[0] : S.gfxLayer);
    c.globalAlpha = 0.85; c.strokeStyle = color(layer); c.lineWidth = Math.max(drawWidth(layer), 1.5 * px);
    const box = (): [number, number, number, number] => [Math.min(d.start[0], d.cur[0]), Math.min(d.start[1], d.cur[1]), Math.abs(d.cur[0] - d.start[0]), Math.abs(d.cur[1] - d.start[1])];
    if (d.shape === "gline") line(c, d.start, d.cur);
    else if (d.shape === "grect" || d.shape === "gtextbox") c.strokeRect(...box());
    else if (d.shape === "table") {   // the table KiCad would make of the drag: it hangs from the first click
      const L = tableGrid(d.start, d.cur, layer, ctx.gridPitch || 0), w = L.cols * L.cw, h = L.rows * L.ch;
      c.strokeRect(L.x, L.y, w, h);
      for (let i = 1; i < L.cols; i++) line(c, [L.x + L.cw * i, L.y], [L.x + L.cw * i, L.y + h]);
      for (let i = 1; i < L.rows; i++) line(c, [L.x, L.y + L.ch * i], [L.x + w, L.y + L.ch * i]);
    } else if (d.shape === "garc") drawArcPreview(c, d, px, color(layer)); else if (d.shape === "gcurve") {
      const pts = d.pts.concat([d.cur]); polyline(c, K.bezierPts(pts), false);
      c.setLineDash([2 * px, 2 * px]); polyline(c, pts, false); c.setLineDash([]);   // the control polygon
    } else if (POLY_TOOLS.has(d.shape)) {
      if (d.pending) { /* the properties dialog is open: nothing drawn yet */ }
      else {
        polyline(c, d.pts.concat((d.leader || [null, d.cur]).slice(1) as Pt[]), false);
        const loop = d.loop && d.loop.length > 1 ? d.loop : [d.cur, d.pts[0]];
        if (d.pts.length > 1) { c.setLineDash([2 * px, 2 * px]); polyline(c, loop, false); c.setLineDash([]); }
      }
    } else if (DIM_TYPE[d.shape]) drawDimPreview(c, d, px);
    else ring(c, d.start, Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]));
    if (d.pts) { c.fillStyle = HL; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h); }
    drawTwoPointAssistant(c, d, px, color(layer));
  }
  // the picked reference image, centred on the cursor
  if (S.image && S.hover && S.modTool === "image") {
    const img = S.image;
    // the image itself, as the preview of the item being placed; a frame until it has decoded
    if (img.el && img.el.complete && img.el.naturalWidth) { c.drawImage(img.el, S.hover.x - img.w / 2, S.hover.y - img.h / 2, img.w, img.h); }
    else {
    c.globalAlpha = 0.85; c.strokeStyle = color(S.gfxLayer); c.lineWidth = 1.5 * px; c.setLineDash([4 * px, 3 * px]);
    c.strokeRect(S.hover.x - img.w / 2, S.hover.y - img.h / 2, img.w, img.h); c.setLineDash([]);
    line(c, [S.hover.x - img.w / 2, S.hover.y - img.h / 2], [S.hover.x + img.w / 2, S.hover.y + img.h / 2]);
    line(c, [S.hover.x + img.w / 2, S.hover.y - img.h / 2], [S.hover.x - img.w / 2, S.hover.y + img.h / 2]);
    }
  }
  drawStatusPopup(c, px * (view.dpr || 1));
  // delete tool: what the click would remove is brightened by the document pass (brightenedIds), as KiCad does
  // a move's magnetic snap (the anchor the cursor was pulled onto)
  if (S.move && S.move.snapAt) { c.globalAlpha = 1; c.strokeStyle = HL; c.lineWidth = 1.5 * px; ring(c, S.move.snapAt, 5 * px); }
  // cursor: the via about to be placed, and the magnetic snap marker
  const hv = S.hover;
  if (hv && S.modTool) {
    if (S.modTool === "via" && !S.route) { const v = sizesOf(ctx).routeVia(netNameOf(ctx, hv.snap ? hv.snap.net : null)); c.globalAlpha = 0.6; c.strokeStyle = VIA; c.lineWidth = (v.diameter - v.drill) / 2; ring(c, [hv.x, hv.y], (v.diameter + v.drill) / 4); }
    if (hv.snap) { c.globalAlpha = 1; c.strokeStyle = HL; c.lineWidth = 1.5 * px; ring(c, [hv.x, hv.y], 5 * px); }
  }
  c.globalAlpha = 1;
}

/** The outline of the master pad at `at`, rotated `angle` degrees: rect / roundrect / trapezoid as a rectangle, the rest as an oval. */
function drawPadPreview(c: CanvasRenderingContext2D, doc: BoardDoc, type: (typeof PAD_TOOLS)[string], at: Pt, angle: number, px: number) {
  const pad = masterPad(doc, type, S.padTemplate || null);
  const sz = K.kid(pad, "size"); const w = sz ? K.num(sz[1]) : 1, h = sz ? K.num(sz[2]) : 1;
  const layers = (K.kid(pad, "layers") || []).slice(1).map(String);
  c.save(); c.translate(at[0], at[1]); c.rotate(-angle * Math.PI / 180);
  c.globalAlpha = 0.6; c.strokeStyle = layers.some((l) => l === "B.Cu") && !layers.some((l) => l === "F.Cu" || l === "*.Cu") ? "#4D7FC4" : "#C83434"; c.lineWidth = 1.5 * px;
  const shape = String(pad[3]);
  c.beginPath();
  if (shape === "circle") c.arc(0, 0, w / 2, 0, Math.PI * 2);
  else if (shape === "oval") { const r = Math.min(w, h) / 2; if (w >= h) { c.moveTo(-w / 2 + r, -r); c.lineTo(w / 2 - r, -r); c.arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2); c.lineTo(-w / 2 + r, r); c.arc(-w / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5); } else { c.moveTo(r, -h / 2 + r); c.lineTo(r, h / 2 - r); c.arc(0, h / 2 - r, r, 0, Math.PI); c.lineTo(-r, -h / 2 + r); c.arc(0, -h / 2 + r, r, Math.PI, Math.PI * 2); } }
  else c.rect(-w / 2, -h / 2, w, h);
  c.stroke();
  const drill = K.kid(pad, "drill"); if (drill) { const d = K.num(drill.find((x: unknown) => typeof x === "number" || /^[\d.]+$/.test(String(x)))); if (d > 0) { c.beginPath(); c.arc(0, 0, d / 2, 0, Math.PI * 2); c.stroke(); } }
  c.restore();
}
