// pcb-tools/overlay.ts — the overlay: what the tools draw over the board.
import type { BoardDoc, CopperShape, DesignSettings, DrawState, GeomPrim, PcbCtx, Pt, RatsnestLine, SnapType } from "./types";
import { appGlobal, editorState, netlistCached, netNameOf, sizesOf } from "./app-state";
import { drawArcPreview } from "./arcs";
import { drawStatusPopup, drawTwoPointAssistant } from "./assistants";
import { DIM_TYPE, dimensionNode, snap45 } from "./dimensions";
import type { DimSpec } from "./dimensions";
import { padShape, polysOverlap, rectCore, shapeOffset } from "./distances";
import { courtyards, netClearance } from "./drc";
import { settingsOf } from "./dialogs";
import { POLY_TOOLS, RULE_AREA_LAYERS, drawWidth } from "./draw-modes";
import { selectionIds } from "./groups";
import { drawGroupFrames, enteredGroupIds } from "./group-edit";
import { netTable, ratsnest } from "./netlist";
import { netOf } from "./nets";
import { tableGrid } from "./nodes";
import { drawEditPoints } from "./point-editor";
import { padOnLayer, padsOf } from "./route-geom";
import { padOutline as drcPadOutline } from "./drc-zones";
import { PAD_TOOLS, masterPad } from "./pad-tool";
import { drawDragPreview, drawRoute } from "./route-preview";
import { CLEARANCE_MODE, HALO_COLOR, HL, K, RATSNEST, S, VIA, bind } from "./state";
import { drawTune } from "./tuning-patterns";
import { drawGenEditPreview, drawTuningSelection } from "./tuning-edit";
import { isTuneTool } from "./tuning-tool";
import { color, pt, samePt, vadd, vsub } from "./util";

// ---------------------------------------------------------------- overlay
export const CONFLICTS_SHADOW = "rgba(255, 0, 5, 0.5)";   // LAYER_CONFLICTS_SHADOW (builtin_color_themes.h)
/**
 * DRC_INTERACTIVE_COURTYARD_CLEARANCE while footprints move (EDIT_TOOL::doMoveSelection, m_ShowCourtyardCollisions):
 * the moving footprints' courtyards against every other footprint's, front against front and back against back.
 * Returns each colliding footprint (moving or not) with its courtyard polygons on the colliding side(s).
 */
export function courtyardConflicts(doc: BoardDoc, moving: Set<string>): Map<string, Pt[][]> {
  const out = new Map<string, Pt[][]>();
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint" && it.bbox);
  const mov = fps.filter((f) => moving.has(f.id)); if (!mov.length) return out;
  const cache = new Map<string, Record<string, Pt[][]>>(); const cyOf = (f: KItem) => { let c = cache.get(f.id); if (!c) cache.set(f.id, c = courtyards(f)); return c; };
  const mark = (f: KItem, polys: Pt[][]) => { const a = out.get(f.id) || []; for (const p of polys) if (!a.includes(p)) a.push(p); out.set(f.id, a); };
  for (const a of mov) {
    const ca = cyOf(a); if (!ca["F.CrtYd"].length && !ca["B.CrtYd"].length) continue;
    for (const b of fps) {
      if (b === a || (moving.has(b.id) && b.id < a.id)) continue;
      const A = a.bbox!, B = b.bbox!; if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) continue;
      const cb = cyOf(b);
      for (const layer of ["F.CrtYd", "B.CrtYd"]) for (const P of ca[layer]) for (const Q of cb[layer]) if (polysOverlap(P, Q)) { mark(a, ca[layer]); mark(b, cb[layer]); }
    }
  }
  return out;
}
/** ADVANCED_CFG m_HoleWallThickness (BOARD_DESIGN_SETTINGS::GetHolePlatingThickness), mm. */
export const HOLE_PLATING_THICKNESS = 0.02;
/** LAYER_NON_PLATEDHOLES (builtin_color_themes.h). */
const NPTH_COLOR = "#1AC4D2";
/** One clearance outline: a track's capsule or arc band, a via's or round pad's circle, a pad's grown outline. */
export type ClearanceShape =
  { t: "capsule"; a: Pt; b: Pt; r: number } | { t: "arcband"; x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean; w: number }
  | { t: "circle"; x: number; y: number; r: number } | { t: "poly"; pts: Pt[] };
export interface ClearanceOutline { id: string; padIndex?: number; npth?: boolean; shape: ClearanceShape }
/**
 * PCB_PAINTER's clearance lines (LAYER_CLEARANCE_*) for the copper layer being edited: PCB_DRAW_PANEL_GAL shows only
 * CLEARANCE_LAYER_FOR( active layer ).  Tracks and vias draw theirs with track_clearance_mode "Always show": a track
 * at width + 2 × its own clearance, a via as a circle of its radius on that layer (its drill radius plus the plating
 * where it is not flashed) plus its clearance.  Pads draw theirs with "Show pad clearance": the pad's shape grown by
 * its own clearance (pad, else footprint override, else the net class), or the hole grown by it where the pad has no
 * copper on the layer (an NPTH, drawn in the non-plated hole colour).  Nothing is drawn for a clearance of 0.
 */
export function clearanceOutlines(doc: BoardDoc, s: DesignSettings, layer: string, opt: { tracks: boolean; pads: boolean; netName(n: { code: number; name: string }): string; hidden?: Set<string> | null; objHide?: Set<string> | null }): ClearanceOutline[] {
  const oh = opt.objHide || null;   // the Appearance object rows: hidden tracks, vias, pads or footprints draw no clearance either
  const out: ClearanceOutline[] = []; if (!/\.Cu$/.test(layer) || (opt.hidden && opt.hidden.has(layer))) return out;
  const clrOf = (net: { code: number; name: string }) => netClearance(s, opt.netName(net));
  for (const it of doc.items.values()) {
    const n = it.node;
    if (opt.tracks && (it.kind === "segment" || it.kind === "arc")) {
      if (oh && oh.has("tracks")) continue;
      if (K.str((K.kid(n, "layer") || [])[1]) !== layer) continue;
      const w = K.kid(n, "width"), half = (w ? K.num(w[1]) : 0.25) / 2, clr = clrOf(netOf(n)); if (clr <= 0) continue;
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue;
      const m = it.kind === "arc" ? pt(n, "mid") : null, arc = m ? K.arcFrom3(a, m, b) : null;
      out.push({ id: it.id, shape: arc ? { t: "arcband", x: arc.x, y: arc.y, r: arc.r, a0: arc.a0, a1: arc.a1, anticlockwise: !!arc.anticlockwise, w: half + clr } : { t: "capsule", a, b, r: half + clr } });
    } else if (opt.tracks && it.kind === "via") {
      if (oh && oh.has("vias")) continue;
      if (!viaOnLayer(n, layer, doc)) continue;
      const clr = clrOf(netOf(n)); if (clr <= 0) continue;
      const at = K.atOf(n), sz = K.kid(n, "size"), r = (sz ? K.num(sz[1]) : 0.8) / 2;   // flashed on every layer it spans
      out.push({ id: it.id, shape: { t: "circle", x: at[0], y: at[1], r: r + clr } });
    } else if (opt.pads && it.kind === "footprint") {
      if (oh && (oh.has("pads") || oh.has(/^B\./.test(K.str((K.kid(n, "layer") || [])[1])) ? "fpBack" : "fpFront"))) continue;
      const fpClr = K.kid(n, "clearance");
      for (const p of padsOf(it)) {
        if (!padOnLayer(p, layer)) continue;
        const own = K.kid(p.node, "clearance"), clr = own ? K.num(own[1]) : fpClr ? K.num(fpClr[1]) : clrOf(p.net as { code: number; name: string });
        if (!(clr > 0)) continue;
        const npth = p.type === "np_thru_hole";
        // an NPTH whose copper is no bigger than its hole is not flashed: its hole is what keeps the clearance
        const dr = K.kid(p.node, "drill"), hd = dr ? dr.slice(1).filter((v) => typeof v === "number" || /^[\d.]+$/.test(String(v))).map((v) => K.num(v)) : [];
        const holeW = hd[0] || 0, holeH = hd[1] || holeW;
        const flashed = !npth || p.w > holeW + 1e-6 || p.h > holeH + 1e-6;
        if (flashed) {
          const sh = padShape(p);
          if (sh.t === "circle") out.push({ id: it.id, padIndex: p.index, npth, shape: { t: "circle", x: sh.x, y: sh.y, r: sh.r + clr } });
          else if (sh.t === "seg") out.push({ id: it.id, padIndex: p.index, npth, shape: { t: "capsule", a: sh.a, b: sh.b, r: sh.r + clr } });
          else out.push({ id: it.id, padIndex: p.index, npth, shape: { t: "poly", pts: drcPadOutline(p, clr) } });
        } else if (holeW > 0) {
          if (Math.abs(holeW - holeH) < 1e-9) out.push({ id: it.id, padIndex: p.index, npth, shape: { t: "circle", x: p.x, y: p.y, r: holeW / 2 + clr } });
          else { const sh = padShape({ shape: "oval", x: p.x, y: p.y, w: holeW, h: holeH, rot: p.rot }); out.push({ id: it.id, padIndex: p.index, npth, shape: sh.t === "seg" ? { t: "capsule", a: sh.a, b: sh.b, r: sh.r + clr } : { t: "circle", x: p.x, y: p.y, r: Math.min(holeW, holeH) / 2 + clr } }); }
        }
      }
    }
  }
  return out;
}
/** A via spans `layer`: a through via every copper layer, a blind / buried / micro via the layers of its pair. */
function viaOnLayer(n: SNode, layer: string, doc: BoardDoc): boolean {
  const ls = K.kid(n, "layers"); if (!ls) return true;
  const copper = (doc as unknown as { copper?: string[] }).copper || [];
  const pair = [K.str(ls[1]), K.str(ls[2])];
  if (!n.includes("blind") && !n.includes("micro") && !n.includes("buried")) return copper.length ? copper.includes(layer) : true;
  const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]), i = copper.indexOf(layer);
  return i0 >= 0 && i1 >= 0 && i >= 0 ? i >= Math.min(i0, i1) && i <= Math.max(i0, i1) : pair.includes(layer);
}
/**
 * The outlines on the canvas, one device pixel wide (m_outlineWidth), in the item's colour on the clearance layer:
 * the layer colour (an NPTH pad's in LAYER_NON_PLATEDHOLES), darkened with a net highlight unless the item is lit,
 * brightened when lit, and in the selected colour when selected (PCB_RENDER_SETTINGS::GetColor).
 */
export function drawClearanceOutlines(c: CanvasRenderingContext2D, ctx: PcbCtx, cpx: number) {
  const doc = ctx.doc, s = settingsOf(ctx), layer = S.layer;
  const hidden = appGlobal(() => editorState()!.hiddenLayers as Set<string> | null, null);
  const hl = appGlobal(() => (editorState() as unknown as { highlightIds?: Set<string> | null }).highlightIds || null, null);
  const sel = new Set<string>(selectionIds(ctx));
  const objHide = appGlobal(() => ((editorState() as unknown as { renderOpts?: { objects?: { hide?: Set<string> } } }).renderOpts?.objects?.hide) || null, null);
  const list = clearanceOutlines(doc, s, layer, { tracks: S.trackClearance === CLEARANCE_MODE.ALWAYS, pads: S.padClearance !== false, netName: (net) => netNameOf(ctx, net as never), hidden, objHide });
  if (!list.length) return;
  const KC = K as unknown as { selectedColor(c: string): string; highlightColor(c: string, pcb: boolean): string; darkened(c: string, f: number): string; HL_FACTOR: number };
  c.save(); c.globalAlpha = 1; c.setLineDash([]); c.lineWidth = cpx; c.lineCap = "round"; c.lineJoin = "round";
  const base = color(layer);
  // group edit mode: what is outside the entered group fades to the Outside Group opacity, unless selected
  const entered = enteredGroupIds(doc);
  const ro = entered ? appGlobal(() => (editorState() as unknown as { renderOpts?: { outsideGroupOpacity?: number; objects?: { opacity?: Record<string, number> } } }).renderOpts || null, null) : null;
  const outsideOp = !entered ? 1 : ro && typeof ro.outsideGroupOpacity === "number" ? ro.outsideGroupOpacity : ro && ro.objects && ro.objects.opacity && typeof ro.objects.opacity.outsideGroup === "number" ? ro.objects.opacity.outsideGroup : 0.2;
  for (const o of list) {
    c.globalAlpha = entered && !entered.has(o.id) && !sel.has(o.id) ? outsideOp : 1;
    let col = o.npth ? NPTH_COLOR : base;
    const lit = !!hl && (hl.has(o.id) || (o.padIndex !== undefined && hl.has(o.id + "#" + o.padIndex)));
    if (sel.has(o.id)) col = KC.selectedColor(col);
    if (hl) col = lit ? KC.highlightColor(col, true) : KC.darkened(col, 1 - KC.HL_FACTOR);
    c.strokeStyle = col; c.beginPath(); traceClearance(c, o.shape); c.stroke();
  }
  c.restore();
}
/** The path of one clearance outline. */
export function traceClearance(c: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void; closePath(): void }, sh: ClearanceShape) {
  if (sh.t === "circle") { c.moveTo(sh.x + sh.r, sh.y); c.arc(sh.x, sh.y, sh.r, 0, 2 * Math.PI); return; }
  if (sh.t === "poly") { if (!sh.pts.length) return; c.moveTo(sh.pts[0][0], sh.pts[0][1]); for (let i = 1; i < sh.pts.length; i++) c.lineTo(sh.pts[i][0], sh.pts[i][1]); c.closePath(); return; }
  if (sh.t === "arcband") { c.arc(sh.x, sh.y, sh.r + sh.w, sh.a0, sh.a1, sh.anticlockwise); c.arc(sh.x, sh.y, Math.max(sh.r - sh.w, 0), sh.a1, sh.a0, !sh.anticlockwise); c.closePath(); return; }
  const a = sh.a, b = sh.b, r = sh.r, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  if (L < 1e-9) { c.moveTo(a[0] + r, a[1]); c.arc(a[0], a[1], r, 0, 2 * Math.PI); return; }
  const nx = -dy / L * r, ny = dx / L * r;
  c.moveTo(a[0] + nx, a[1] + ny); c.lineTo(b[0] + nx, b[1] + ny); c.arc(b[0], b[1], r, ang + Math.PI / 2, ang - Math.PI / 2, true);
  c.lineTo(a[0] - nx, a[1] - ny); c.arc(a[0], a[1], r, ang - Math.PI / 2, ang + Math.PI / 2, true); c.closePath();
}
/** The tools whose cursor the router snaps (no snap indicator). */
export const ROUTER_TOOLS = new Set(["route", "routediff", "tunesingle", "tunediff", "tuneskew", "drag"]);
/** PCB_CONTROL's grid origin marker colour: the grid colour Brightened( 0.25 ), Darkened on a light background. */
export function gridOriginColor() {
  const gc = appGlobal(() => (editorState() as unknown as { renderOpts: { gridColor?: string } }).renderOpts.gridColor, null) || "#848484";   // LAYER_GRID
  return adjustColor(gc, 0.25, alphaOf(gc), brightness(K.PCB_BG) >= 0.5);
}
/** A css colour's channels 0..255 and alpha 0..1. */
export function rgbaOf(col: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(col);
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
  const q = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(col);
  return q ? [+q[1], +q[2], +q[3], q[4] === undefined ? 1 : +q[4]] : [255, 255, 255, 1];
}
export const alphaOf = (col: string) => rgbaOf(col)[3];
/** COLOR4D::GetBrightness (0..1). */
export function brightness(col: string) { const [r, g, b] = rgbaOf(col); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
/** RATSNEST_VIEW_ITEM's adjustColor: Brightened( delta ) on a dark background, Darkened( delta ) on a light one, WithAlpha( min( a, 1 ) ). */
export function adjustColor(col: string, delta: number, alpha: number, lightBg = false) {
  const [r, g, b] = rgbaOf(col); const k = (v: number) => Math.round(lightBg ? v * (1 - delta) : v * (1 - delta) + 255 * delta);
  return `rgba(${k(r)}, ${k(g)}, ${k(b)}, ${+Math.min(alpha, 1).toFixed(4)})`;
}
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
export const SNAP_INDICATOR_COLOR = "#FFFFFF", SNAP_INDICATOR_SIZE = 16;   // SNAP_INDICATOR( COLOR4D::WHITE, 16 )
/**
 * SNAP_INDICATOR::ViewDraw at `p`: the ORIGIN_VIEWITEM CIRCLE_CROSS (a circle of `size` px and a cross with `size` px
 * arms, one pixel wide), and the icon of the snap's POINT_TYPE, `size` px wide, 24 px right of and 10 px below the point.
 * `cpx` is one screen (css) pixel in document units.
 */
export function drawSnapIndicator(c: CanvasRenderingContext2D, p: Pt, type: SnapType | null | undefined, cpx: number, color = SNAP_INDICATOR_COLOR) {
  const r = SNAP_INDICATOR_SIZE * cpx;
  c.save(); c.globalAlpha = 1; c.setLineDash([]); c.lineCap = "butt"; c.lineJoin = "miter"; c.strokeStyle = color; c.fillStyle = color; c.lineWidth = cpx;
  ring(c, p, r); line(c, [p[0] - r, p[1]], [p[0] + r, p[1]]); line(c, [p[0], p[1] - r], [p[0], p[1] + r]);
  const at: Pt = [p[0] + 24 * cpx, p[1] + 10 * cpx], size = SNAP_INDICATOR_SIZE * cpx, node = size / 8;
  const dot = (q: Pt) => { c.beginPath(); c.arc(q[0], q[1], node, 0, Math.PI * 2); c.fill(); };
  switch (type) {
    case "corner": { const k: Pt = [at[0] - size / 2 + node, at[1] - size / 2 + node]; line(c, k, [k[0] + size - node, k[1]]); line(c, k, [k[0], k[1] + size - node]); dot(k); break; }
    case "end": { const s0: Pt = [at[0] - (size / 2 - node), at[1]]; dot(s0); line(c, s0, [s0[0] + size - node, s0[1]]); break; }
    case "mid": dot(at); line(c, [at[0] - size / 2, at[1]], [at[0] + size / 2, at[1]]); break;
    case "center": ring(c, at, size / 4); line(c, [at[0] - size / 2, at[1]], [at[0] + size / 2, at[1]]); line(c, [at[0], at[1] - size / 2], [at[0], at[1] + size / 2]); break;
    case "quadrant": {
      const q: Pt = [at[0], at[1] - (size / 2 - node)], ar = size - node * 2; dot(q);
      // most of the top half of a circle through the node: EDA_ANGLE -160 … 140 sweep in GAL's (y-down) frame
      const a0 = -160 * Math.PI / 180; c.beginPath(); c.arc(q[0], q[1] + ar, ar, a0, a0 + 140 * Math.PI / 180); c.stroke();
      break;
    }
    case "intersection": { dot(at); const lx = size / 2, ly = size / 3; line(c, [at[0] - lx, at[1] - ly], [at[0] + lx, at[1] + ly]); line(c, [at[0] - lx, at[1] + ly], [at[0] + lx, at[1] - ly]); break; }
    case "onElement": dot([at[0] + size / 4, at[1]]); line(c, [at[0] - size / 2, at[1]], [at[0] + size / 2, at[1]]); break;
    default: break;
  }
  c.restore();
}
/** The POINT_TYPE a router / via snap target stands for: a pad or via centre, a track end, a point on a track. */
export function snapTypeOf(snap: { kind: string; type?: SnapType } | null | undefined): SnapType {
  if (!snap) return "none";
  if (snap.kind === "anchor") return snap.type || "none";
  return snap.kind === "pad" || snap.kind === "via" ? "center" : snap.kind === "track" ? "end" : snap.kind === "trackMid" ? "onElement" : "none";
}
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
    c.globalAlpha = 1; c.lineWidth = 1 * px;
    const curved = K.pcbSizes.state.curvedRatsnest;   // RATSNEST_VIEW_ITEM: a Bezier whose two control points sit 10% off the midpoint
    const trace = (l: { a: Pt; b: Pt }) => {
      c.moveTo(l.a[0], l.a[1]);
      if (curved) { const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], mx = l.a[0] + 0.5 * dx - 0.1 * dy, my = l.a[1] + 0.5 * dy + 0.1 * dx; c.bezierCurveTo(mx, my, mx, my, l.b[0], l.b[1]); }
      else c.lineTo(l.b[0], l.b[1]);
    };
    // RATSNEST_VIEW_ITEM::ViewDraw: while anything moves or a net is highlighted every static line is drawn at half its
    // alpha; the lines of highlighted nets (a ` highlight, the routed net) are adjustColor( c, 0.8, a + 0.4 ), and the
    // dynamic lines of what is moving adjustColor( c, 0.5, a + 0.3 )
    const moving = movingIds();   // the static lines of moving items give way to the dynamic ones
    const hlNets = new Set<string>(); if (S.route && S.route.netKey) hlNets.add(S.route.netKey); if (S.route && S.route.netKeyN) hlNets.add(S.route.netKeyN); if (S.highlightNet) hlNets.add(S.highlightNet);
    if (S.drag) for (const d of S.drag.subs) if (d.netKey) hlNets.add(d.netKey);
    const dimStatic = moving.size > 0 || hlNets.size > 0;
    const lightBg = brightness(K.PCB_BG) >= 0.5;
    const baseOf = (net: string) => (S.ratsnestColors && S.ratsnestColors.get(net)) || RATSNEST;
    const byColor = new Map<string, RatsnestLine[]>();
    for (const l of lines) {
      if (S.hiddenNets.has(l.net)) continue; if (sel && !l.ids.some((id: string) => sel.has(id))) continue; if (moving.size && l.ids.some((id: string) => moving.has(id))) continue;
      let col = baseOf(l.net), a = alphaOf(col);
      if (dimStatic) { a = a / 2; col = adjustColor(col, 0, a, lightBg); }
      if (hlNets.has(l.net)) col = adjustColor(col, 0.8, a + 0.4, lightBg);
      let arr = byColor.get(col); if (!arr) byColor.set(col, arr = []); arr.push(l);
    }
    for (const [col, arr] of byColor) { c.strokeStyle = col; c.beginPath(); for (const l of arr) trace(l); c.stroke(); }
    if (moving.size) {
      const dyn = new Map<string, { a: Pt; b: Pt }[]>();
      for (const l of dynamicRatsnest(doc, moving)) { if (S.hiddenNets.has(l.net)) continue; const b = baseOf(l.net); const col = adjustColor(b, 0.5, alphaOf(b) + 0.3, lightBg); let arr = dyn.get(col); if (!arr) dyn.set(col, arr = []); arr.push(l); }
      for (const [col, arr] of dyn) { c.strokeStyle = col; c.beginPath(); for (const l of arr) trace(l); c.stroke(); }
    }
  }
  // the grid origin (circle + X) and the drill / place file origin (circle + cross, red): ORIGIN_VIEWITEM, 16 px, hidden at 0,0
  { const R = K.pcbSizes.state; const r = 16 * px; c.globalAlpha = 1; c.lineWidth = 1 * px;
    const g = S.modTool === "gridorigin" && S.hover ? [S.hover.x, S.hover.y] : R.gridOrigin, d = S.modTool === "drillorigin" && S.hover ? [S.hover.x, S.hover.y] : R.auxOrigin;
    if (g[0] || g[1]) { c.strokeStyle = gridOriginColor(); ring(c, g, r); line(c, [g[0] - r, g[1] - r], [g[0] + r, g[1] + r]); line(c, [g[0] - r, g[1] + r], [g[0] + r, g[1] - r]); }
    if (d[0] || d[1]) { c.strokeStyle = "#CC0000"; ring(c, d, r); line(c, [d[0] - r, d[1]], [d[0] + r, d[1]]); line(c, [d[0], d[1] - r], [d[0], d[1] + r]); } }
  // DRC markers: PCB_PAINTER::draw(PCB_MARKER) -- MARKER_BASE's pin polygon scaled by 1/sqrt(zoom), filled in
  // LAYER_DRC_ERROR / LAYER_DRC_WARNING over the LAYER_MARKER_SHADOWS outline
  if (S.markers.length && K.drawMarkers) {
    const shown = S.hiddenSeverities && S.hiddenSeverities.size ? S.markers.filter((m) => !S.hiddenSeverities!.has(m.severity)) : S.markers;
    if (shown.length) K.drawMarkers(c, shown, "pcb", K.markerScale("pcb", view), K.PCB_BG);
  }
  // PCB_PAINTER::draw(FOOTPRINT) on LAYER_CONFLICTS_SHADOW: the courtyards of footprints flagged COURTYARD_CONFLICT
  if (S.move && S.move.moved && S.showCourtyardConflicts !== false) {
    const m = S.move, key = m.last[0] + "," + m.last[1] + (m.xformed ? "x" : "");
    if (!m.conflicts || m.conflicts.key !== key) m.conflicts = { key, fps: courtyardConflicts(doc, new Set(m.ids)) };
    if (m.conflicts.fps.size) { c.globalAlpha = 1; c.fillStyle = CONFLICTS_SHADOW; c.beginPath(); for (const polys of m.conflicts.fps.values()) for (const P of polys) { c.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) c.lineTo(P[i][0], P[i][1]); c.closePath(); } c.fill("nonzero"); }
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
        // ZONE_CREATE_HELPER's POLYGON_ITEM: the locked-in chain 1 px in WHITE, the leader in LAYER_AUX_ITEMS (white), and
        // the polygon they make with the closing loop filled in the layer colour at alpha 0.2 (no outline for the loop)
        const leader = (d.leader && d.leader.length > 1 ? d.leader : [d.pts[d.pts.length - 1], d.cur]) as Pt[];
        const loop = (d.loop && d.loop.length > 1 ? d.loop : [d.cur, d.pts[0]]) as Pt[];
        const fill = d.pts.concat(leader, loop);
        if (fill.length > 2) { const [r, g, b] = rgbaOf(color(layer)); c.globalAlpha = 1; c.fillStyle = `rgba(${r}, ${g}, ${b}, 0.2)`; c.beginPath(); c.moveTo(fill[0][0], fill[0][1]); for (let i = 1; i < fill.length; i++) c.lineTo(fill[i][0], fill[i][1]); c.closePath(); c.fill(); }
        c.globalAlpha = 1; c.strokeStyle = "#FFFFFF"; c.lineWidth = px * (view.dpr || 1); c.lineJoin = "miter"; c.lineCap = "butt";
        if (d.pts.length >= 2) polyline(c, d.pts, false);
        polyline(c, leader, false);
        c.lineJoin = "round"; c.lineCap = "round";
      }
    } else if (DIM_TYPE[d.shape]) drawDimPreview(c, d, px);
    else ring(c, d.start, Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]));
    if (d.pts && !POLY_TOOLS.has(d.shape)) { c.fillStyle = HL; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h); }
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
  drawClearanceOutlines(c, ctx, px * (view.dpr || 1));   // the active copper layer's clearance lines (always-show tracks / vias, pads)
  drawGroupFrames(c, ctx, px * (view.dpr || 1));   // PCB_PAINTER::draw( PCB_GROUP ): a selected or entered group's box
  drawStatusPopup(c, px * (view.dpr || 1));
  // delete tool: what the click would remove is brightened by the document pass (brightenedIds), as KiCad does
  // a move's magnetic snap (the anchor the cursor was pulled onto): GRID_HELPER's SNAP_INDICATOR
  const cpx = px * (view.dpr || 1);
  if (S.move && S.move.snapAt) drawSnapIndicator(c, S.move.snapAt, S.move.snapAt.t, cpx);
  // cursor: the via about to be placed, and the magnetic snap marker
  const hv = S.hover;
  if (hv && S.modTool) {
    if (S.modTool === "via" && !S.route) { const v = sizesOf(ctx).routeVia(netNameOf(ctx, hv.snap ? hv.snap.net : null)); c.globalAlpha = 0.6; c.strokeStyle = VIA; c.lineWidth = (v.diameter - v.drill) / 2; ring(c, [hv.x, hv.y], (v.diameter + v.drill) / 4); }
    // GRID_HELPER::BestSnapAnchor shows the snap indicator; the router snaps through TOOL_BASE::snapToItem, which shows none
    if (hv.snap && !ROUTER_TOOLS.has(S.modTool) && !S.route) drawSnapIndicator(c, [hv.x, hv.y], snapTypeOf(hv.snap as { kind: string; type?: SnapType }), cpx);
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
