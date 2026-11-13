import type { SchCtx, Pt } from "./types";
import { type SymPin, globalPowerPin, symbolPins } from "./autoplace";
import { curTool, installDom, labelDefaults } from "./dom";
import { connPoints } from "./drag";
import { BUS_TEXT, previewJunctions } from "./junction";
import { anchorOf } from "./orient";
import { outline, paint } from "./overlay";
import { drawEditPoints } from "./point-edit";
import { collisionCursor, collisionMarkers, drawCollision } from "./collision";
import { snapAnchor, snapConn } from "./snap";
import { drawSchArcPreview } from "./arcs";
import { drawTableLines, sheetCorner, sheetNode } from "./nodes";
import { CLR, K, S, atOf, kids, ptsOf, str, toolOf } from "./state";
import { ghost, r4, same, segDist, segs } from "./util";
import { segNull } from "./wire";

// ---------------------------------------------------------------- dangling ends (UpdateDanglingState + SCH_PAINTER::drawDanglingIndicator)
// Every connection end on the sheet with its DANGLING_END_T, then each item's own rule for what attaches it:
// a wire end anything but a bus end or the bus side of an entry; a pin another symbol's pin, a label, a sheet pin,
// a wire end, a no-connect or a junction; a label or sheet pin a pin, a no-connect, a label or sheet pin, or any
// point of a wire or bus.  Returns the dangling points: { p, what: "wire" | "pin" | "label", item, color key }.
export const DANGLE_LABEL_COLOR: Record<string, string> = { label: "label", global_label: "glabel", hierarchical_label: "hlabel", netclass_flag: "netclass", directive_label: "netclass" };
/** A dangling connection end: where, which indicator (wire / pin / label), the item and its colour key. */
export interface Dangling { p: Pt; what: string; item: KItem; color: string }
export function danglingEnds(doc: KDoc): Dangling[] {
  const at = new Map<string, { type: string; item: KItem }[]>(), key = (p: Pt) => r4(p[0]) + "," + r4(p[1]);
  const add = (p: Pt, type: string, item: KItem) => { const k = key(p); let l = at.get(k); if (!l) at.set(k, l = []); l.push({ type, item }); };
  const lines: KItem[] = [], pins: { q: SymPin; item: KItem }[] = [], labels: { p: Pt; item: KItem; color: string }[] = [];
  for (const it of doc.items.values()) {
    const k = it.kind, n = it.node;
    if (k === "wire" || k === "bus") { const p = ptsOf(n); if (p.length < 2) continue; add(p[0], k === "wire" ? "WIRE_END" : "BUS_END", it); add(p[p.length - 1], k === "wire" ? "WIRE_END" : "BUS_END", it); lines.push(it); }
    else if (k === "symbol") for (const q of symbolPins(doc, it)) { add([q.x, q.y], "PIN_END", it); pins.push({ q, item: it }); }
    else if (k === "junction") add(atOf(n), "JUNCTION_END", it);
    else if (k === "no_connect") add(atOf(n), "NO_CONNECT_END", it);
    else if (DANGLE_LABEL_COLOR[k]) { add(atOf(n), "LABEL_END", it); labels.push({ p: atOf(n).slice(0, 2), item: it, color: DANGLE_LABEL_COLOR[k] }); }
    else if (k === "sheet") for (const pin of kids(n, "pin")) { add(atOf(pin), "SHEET_LABEL_END", it); labels.push({ p: atOf(pin).slice(0, 2), item: it, color: "sheetLabel" }); }
    else if (k === "bus_entry") { const c = connPoints(doc, it); add(c[0], "BUS_ENTRY_END", it); add(c[1], "WIRE_ENTRY_END", it); }
  }
  const out: Dangling[] = [];
  // SCH_BUS_WIRE_ENTRY::UpdateDanglingState: an end has a wire when another wire ends there, a bus when it lies on a
  // bus; a wire at one end and a bus at the other connects both, otherwise only the end that has either
  for (const it of doc.items.values()) {
    if (it.kind !== "bus_entry") continue;
    const ends = connPoints(doc, it); if (ends.length < 2) continue;
    const hasWire = [false, false], hasBus = [false, false];
    for (const ln of lines) for (let i = 0; i < 2; i++) {
      if (ln.kind === "wire") { const q = ptsOf(ln.node); if (same(q[0], ends[i]) || same(q[q.length - 1], ends[i])) hasWire[i] = true; }
      else if (segs(ln).some(([a, b]) => segDist(ends[i], a, b) <= 1e-3)) hasBus[i] = true;
    }
    let d0 = true, d1 = true;
    if ((hasWire[0] && hasBus[1]) || (hasWire[1] && hasBus[0])) d0 = d1 = false;
    else if (hasWire[0] || hasBus[0]) d0 = false;
    else if (hasWire[1] || hasBus[1]) d1 = false;
    if (d0) out.push({ p: ends[0], what: "busEntry", item: it, color: "busEntry" });
    if (d1) out.push({ p: ends[1], what: "busEntry", item: it, color: "busEntry" });
  }
  for (const it of lines) {
    if (it.kind !== "wire") continue;                                   // only wires show the indicator
    const p = ptsOf(it.node);
    for (const e of [p[0], p[p.length - 1]]) {
      const l = at.get(key(e)) || [];
      if (!l.some((x) => x.item !== it && x.type !== "BUS_END" && x.type !== "BUS_ENTRY_END")) out.push({ p: e, what: "wire", item: it, color: "wire" });
    }
  }
  const PIN_OK = new Set(["PIN_END", "LABEL_END", "SHEET_LABEL_END", "WIRE_END", "NO_CONNECT_END", "JUNCTION_END"]);
  for (const { q, item } of pins) {
    if (q.hidden && !globalPowerPin(doc, item, q)) continue;            // SCH_PAINTER: a hidden pin shows it only when it is global power
    const l = at.get(key([q.x, q.y])) || [];
    if (!l.some((x) => x.item !== item && PIN_OK.has(x.type))) out.push({ p: [q.x, q.y], what: "pin", item, color: "pin" });
  }
  const LABEL_OK = new Set(["PIN_END", "NO_CONNECT_END", "LABEL_END", "SHEET_LABEL_END"]);
  for (const lb of labels) {
    const l = at.get(key(lb.p)) || [];
    if (l.some((x) => x.item !== lb.item && LABEL_OK.has(x.type))) continue;
    if (lines.some((ln) => segs(ln).some(([a, b]) => segDist(lb.p, a, b) <= 1e-3))) continue;
    out.push({ p: lb.p, what: "label", item: lb.item, color: lb.color });
  }
  return out;
}
/**
 * SCH_SELECTION_TOOL::autostartEvent: the line a plain click on a dangling anchor starts — "wire", "bus" or
 * "polyline" (drawLines) — or null.  Pins, wire ends, labels and sheet pins that are dangling start a wire (a
 * bus for a bus label), dangling bus ends a bus, a bus entry a wire (a bus when it is not on a bus), and the
 * ends of a graphic line (never connected, so always dangling) a graphic line.
 */
export function autostartKind(doc: KDoc, p: Pt) {
  for (const d of danglingList(doc)) if (d.what !== "busEntry" && same(d.p, p)) {
    if (d.what === "label") { const n = d.item.kind === "sheet" ? null : d.item.node; if (n && BUS_TEXT.test(str(n[1]))) return "bus"; }
    return "wire";
  }
  for (const it of doc.items.values()) {
    if (it.kind === "bus") {
      const q = ptsOf(it.node); if (q.length < 2) continue;
      for (const e of [q[0], q[q.length - 1]]) if (same(e, p)) {
        const other = Array.from(doc.items.values()).some((o) => o !== it && connPoints(doc, o).some((c) => same(c, p)) && o.kind !== "wire" && o.kind !== "symbol");
        if (!other) return "bus";
      }
    } else if (it.kind === "bus_entry") {
      const [a, b] = connPoints(doc, it), onBus = Array.from(doc.items.values()).some((o) => o.kind === "bus" && segs(o).some(([u, v]) => segDist(a, u, v) <= 1e-3));
      const endFree = !Array.from(doc.items.values()).some((o) => o !== it && connPoints(doc, o).some((c) => same(c, b)));
      if ((same(a, p) && !onBus) || (same(b, p) && endFree)) return onBus ? "wire" : "bus";
    } else if (it.kind === "polyline") {
      const q = ptsOf(it.node); if (q.length === 2 && (same(q[0], p) || same(q[1], p))) return "polyline";
    }
  }
  return null;
}
// KiCad's LINE_WIRE / LINE_BUS / LINE_GRAPHIC cursors: the crosshair with a pencil and a short line of the kind's colour.
// the selection tool's m_nonModifiedCursor over an autostart point (sch_selection_tool.cpp:1566-1577)
export const AUTOSTART_CURSOR: Record<string, string> = { wire: "LINE_WIRE", bus: "LINE_BUS", polyline: "LINE_GRAPHIC" };
export const AUTOSTART_TOOL: Record<string, string> = { wire: "wire", bus: "bus", polyline: "lines" };
S.autoStartWires = true;                   // eeschema drawing.auto_start_wires (default on)
export const brighten = (hex: string, f: number) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "")); if (!m) return hex; const v = parseInt(m[1], 16); const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round(x * (1 - f) + 255 * f)); return `rgb(${c[0]},${c[1]},${c[2]})`; };
export const MIL = 0.0254, DANGLING_SYMBOL_SIZE = 12 * MIL, TARGET_PIN_RADIUS = 15 * MIL, DEFAULT_PEN = 6 * MIL, TARGET_BUSENTRY_RADIUS = 12 * MIL;
let danglingCache: { doc: KDoc | null; gen: number; list: Dangling[] } = { doc: null, gen: -1, list: [] };
S.docGen = 0;
export function danglingList(doc: KDoc) {
  if (danglingCache.doc !== doc || danglingCache.gen !== S.docGen || S.drag) danglingCache = { doc, gen: S.docGen, list: danglingEnds(doc) };
  return danglingCache.list;
}
/** The local labels whose connection point dangles (render's `dangling` option: a selected one shows no anchor). */
let danglingIdsCache: { list: Dangling[] | null; ids: Set<string> } = { list: null, ids: new Set() };
export function danglingLabelIds(doc: KDoc): Set<string> {
  const list = danglingList(doc);
  if (danglingIdsCache.list !== list) danglingIdsCache = { list, ids: new Set(list.filter((d) => d.what === "label" && d.item.kind === "label").map((d) => d.item.id)) };
  return danglingIdsCache.ids;
}
export function drawDangling(c: CanvasRenderingContext2D, doc: KDoc, px: number) {
  danglingList(doc);
  const thick = Math.max(DEFAULT_PEN / 3, px);
  c.save(); c.lineWidth = thick;
  for (const d of danglingCache.list) {
    const col = brighten(K.SCH[d.color] || K.SCH.wire, 0.3); c.strokeStyle = col;
    if (d.what === "pin") { c.beginPath(); c.arc(d.p[0], d.p[1], TARGET_PIN_RADIUS, 0, Math.PI * 2); c.stroke(); continue; }
    // SCH_PAINTER::draw( SCH_BUS_ENTRY_BASE ): a circle of the pen width plus TARGET_BUSENTRY_RADIUS / 2 (6 mils)
    if (d.what === "busEntry") { const n = d.item.node, st = n.find((x) => Array.isArray(x) && x[0] === "stroke") as SNode | undefined, wd = st ? (st.find((x) => Array.isArray(x) && x[0] === "width") as SNode | undefined) : undefined; const pen = wd && +wd[1] > 0 ? +wd[1] : DEFAULT_PEN; c.beginPath(); c.arc(d.p[0], d.p[1], pen + TARGET_BUSENTRY_RADIUS / 2, 0, Math.PI * 2); c.stroke(); continue; }
    const w = d.what === "wire" ? DEFAULT_PEN : DANGLING_SYMBOL_SIZE / 2, r = w + DANGLING_SYMBOL_SIZE / 2;
    c.strokeRect(d.p[0] - r, d.p[1] - r, 2 * r, 2 * r);
  }
  c.restore();
}
// Junction dots in the junction colour (the preview of where a drop will add them), KiCad's default dot size.
export function drawJunctionDots(c: CanvasRenderingContext2D, pts: Pt[], px: number) {
  if (!pts || !pts.length) return;
  const r = Math.max(0.9144 / 2, 2 * px);
  c.save(); c.fillStyle = K.SCH.junction || CLR.wire;
  for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
export function drawOverlay(c: CanvasRenderingContext2D, view: KView, ctx: SchCtx) {
  S.ctx = ctx; installDom(ctx);
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1)), doc = ctx.doc;
  if (S.showDangling !== false) drawDangling(c, doc, px);
  // no rollover in any tool but the delete tool (SCH_TOOL_BASE::InteractiveDelete), which brightens the item a click
  // would remove: LAYER_BRIGHTENED with its 0.15-alpha shadow (BrightenItem), the rest of the sheet as it is
  if (S.hover && !S.drag && curTool() === "delete") { const it = doc.items.get(S.hover); if (it) paintItems(c, view, doc, [it], { highlight: new Set([it.id]) }); }
  // the selected item gets KiCad's selection shadow from the canvas pass (the host adds S.sel to the selection)
  if (curTool() === "select" && !S.drag) drawEditPoints(c, ctx, px);
  if (S.highlight && typeof ctx.setHighlight !== "function") {   // app.js paints the highlight when it can; else a plain outline
    for (const id of S.highlight) { const it = doc.items.get(id); if (it) outline(c, it, "#FF40FF", px, 2); }
  }
  if (S.markers.length && S.markersDoc === doc && typeof ctx.setMarkers !== "function") {   // ERC markers: KiCad's little arrow, red for errors
    for (const m of S.markers) {
      const s = 6 * px; c.save(); c.fillStyle = m.severity === "error" ? "rgba(255,0,0,0.85)" : "rgba(255,180,0,0.9)"; c.strokeStyle = "#000"; c.lineWidth = px;
      c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(m.x + 1.6 * s, m.y - 0.6 * s); c.lineTo(m.x + 1.1 * s, m.y - 1.1 * s); c.lineTo(m.x + 0.6 * s, m.y - 1.6 * s); c.closePath(); c.fill(); c.stroke(); c.restore();
    }
  }
  if (S.drag) {
    // the dragged items keep their selection shadow from the canvas pass (the host adds them to the selection)
    for (const s of S.drag.preview || []) {                 // new wires the drop will create
      c.save(); c.strokeStyle = s.kind === "bus" ? CLR.bus : CLR.wire; c.lineWidth = Math.max(s.kind === "bus" ? 0.3048 : 0.1524, 2 * px); c.lineCap = "round"; c.globalAlpha = 0.85;
      c.beginPath(); c.moveTo(s.pts[0][0], s.pts[0][1]); for (let i = 1; i < s.pts.length; i++) c.lineTo(s.pts[i][0], s.pts[i][1]); c.stroke(); c.restore();
    }
    // SCH_MOVE_TOOL: every step previews JUNCTION_HELPERS::PreviewJunctions of the selection and the drag lines
    let warn = false;
    if (S.drag.moved) {
      const js = dragJunctions(doc, S.drag); drawJunctionDots(c, js, px);
      if (S.drag.collision) { const m = collisionMarkers(doc, S.drag.collision, js); drawCollision(c, m, px); warn = m.junctions.length + m.breaks.length > 0; }   // SCH_DRAG_NET_COLLISION_MONITOR::Update
    }
    collisionCursor(ctx.stage, warn);
  } else if (S.collisionCursor != null) collisionCursor(ctx.stage, false);
  const w = S.wire;
  if (w) {
    // the segments in KiCad's preview colours (wire / bus / notes), then the junction dots the drop would add
    c.save(); c.strokeStyle = w.kind === "bus" ? CLR.bus : w.kind === "polyline" ? K.SCH.notes : CLR.wire; c.lineWidth = Math.max(w.kind === "bus" ? 0.3048 : 0.1524, 2 * px); c.lineCap = "round"; c.lineJoin = "round";
    if (w.kind === "polyline") c.setLineDash([1.27 * 0.5, 1.27 * 0.5]);
    c.beginPath(); for (const sg of w.segs) if (!segNull(sg)) { c.moveTo(sg[0][0], sg[0][1]); c.lineTo(sg[1][0], sg[1][1]); } c.stroke();
    c.restore();
    if (w.kind !== "polyline") drawJunctionDots(c, previewJunctions(doc, w.segs.map((sg) => ({ kind: w.kind, a: sg[0], b: sg[1] }))), px);
  }
  const d = S.draw;
  if (d) {
    c.save(); c.strokeStyle = K.SCH.notes; c.lineWidth = Math.max(0.1524, 2 * px); c.lineCap = "round"; c.lineJoin = "round"; c.globalAlpha = 0.85;
    const cur = d.await ? d.pts[1] : d.cur, p0 = d.pts[0];
    if (d.shape === "sheet") c.strokeStyle = K.SCH.sheet; else if (d.shape === "rulearea") { c.strokeStyle = K.SCH.ruleArea; c.setLineDash([4 * px, 3 * px]); }
    if (d.shape === "table") { c.beginPath(); for (const l of drawTableLines(p0, cur, S.ctx ? S.ctx.gridPitch : 1.27, labelDefaults().textSize)) { c.moveTo(l[0], l[1]); c.lineTo(l[2], l[3]); } c.stroke(); }
    else if (d.shape === "sheet") {
      // the preview is the sheet itself (a Clone with "Untitled Sheet" / "untitled.kicad_sch"), sized by sizeSheet
      const b = d.await ? cur : sheetCorner(p0, cur, S.ctx ? S.ctx.gridPitch : 1.27), it = ghost(doc, sheetNode(p0, b, "Untitled Sheet", "untitled.kicad_sch"));
      if (it) { c.restore(); paintItems(c, view, doc, [it], {}); c.save(); }
    }
    else if (d.shape === "rect" || d.shape === "textbox") c.strokeRect(Math.min(p0[0], cur[0]), Math.min(p0[1], cur[1]), Math.abs(cur[0] - p0[0]), Math.abs(cur[1] - p0[1]));
    else if (d.shape === "circle") { c.beginPath(); c.arc(p0[0], p0[1], Math.hypot(cur[0] - p0[0], cur[1] - p0[1]), 0, Math.PI * 2); c.stroke(); }
    else if (d.shape === "arc" && d.arc) drawSchArcPreview(c, d, px);
    else if (d.shape === "bezier") {
      // the manager's preview: end and control 2 trail the cursor until they are fixed
      const n = d.pts.length, e = n > 2 ? d.pts[2] : cur;
      const ctrl = n === 1 ? [p0, cur, cur, cur] : n === 2 ? [p0, d.pts[1], cur, cur] : [p0, d.pts[1], [2 * e[0] - cur[0], 2 * e[1] - cur[1]], e];
      const bp = K.bezierPts(ctrl, 24); c.beginPath(); c.moveTo(bp[0][0], bp[0][1]); for (let i = 1; i < bp.length; i++) c.lineTo(bp[i][0], bp[i][1]); c.stroke();
      c.save(); c.setLineDash([2 * px, 2 * px]); c.globalAlpha = 0.5; c.beginPath(); c.moveTo(ctrl[0][0], ctrl[0][1]); c.lineTo(ctrl[1][0], ctrl[1][1]); c.moveTo(ctrl[3][0], ctrl[3][1]); c.lineTo(ctrl[2][0], ctrl[2][1]); c.stroke(); c.restore();
    } else {
      c.beginPath(); c.moveTo(p0[0], p0[1]); for (let i = 1; i < d.pts.length; i++) c.lineTo(d.pts[i][0], d.pts[i][1]); c.lineTo(cur[0], cur[1]);
      if (d.shape !== "lines" && d.pts.length >= 2) c.closePath();   // polygons and rule areas close back to the first point
      c.stroke();
    }
    if (d.shape !== "sheet") { c.fillStyle = CLR.sel; const h = 3 * px; for (const p of d.pts) c.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h); }
    c.restore();
  }
  if (S.carry && S.carry.item) {
    // SCH_DRAWING_TOOLS: the new item is IS_NEW | IS_MOVING and selected, so it draws in its own colours and font with
    // the selection shadow, its field anchors hidden while it moves (parentMoving); an image as its bitmap
    const it = S.carry.item;
    paintItems(c, view, doc, [it], { selected: new Set([it.id]), moving: new Set([it.id]) });
  }
  // EE_GRID_HELPER: a cursor snapped to an object's anchor (a pin, a wire end, a label …) shows the SNAP_INDICATOR,
  // a plain grid snap nothing
  const sp = snapIndicatorAt(ctx);
  if (sp) drawSnapIndicator(c, sp, px);
}
/**
 * Items drawn by the canvas painter over the overlay: a carried item, the delete tool's brightened candidate.  They
 * are painted as a document of their own, over what the canvas holds.
 */
export function paintItems(c: CanvasRenderingContext2D, view: KView, doc: KDoc, items: KItem[], opts: Record<string, unknown>) {
  const one = Object.assign({}, doc, { items: new Map(items.map((it) => [it.id, it])) }) as KDoc;
  c.save();
  try { K.render(one, c, view, Object.assign({ background: false, overlay: true, grid: 0, frame: false, hidden: S.ctx && (S.ctx as { hiddenLayers?: Set<string> }).hiddenLayers || undefined }, opts) as KRenderOpts); }
  finally { c.restore(); }
}
/** Where the tool's cursor snapped to an object anchor (the wire / bus tools, a carried label), or null. */
export function snapIndicatorAt(ctx: SchCtx): Pt | null {
  const t = toolOf(S.tool); if (!S.cursor || (t && t.id === "delete")) return null;
  if (S.mods && S.mods.shiftKey) return null;   // Shift: no magnetic snap
  const c = S.carry;
  const kind = S.wire ? S.wire.kind : c ? (TEXT_KINDS_SNAP.has(c.kind) ? (c.kind === "bus" ? "bus" : "wire") : null) : t && (t.kind === "wire" || t.kind === "bus") ? t.kind : null;
  if (!kind || kind === "polyline") return null;
  return snapAnchor(ctx, S.cursor, kind);
}
// what placeCarry snaps to connections rather than the grid alone
const TEXT_KINDS_SNAP = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect", "junction", "bus_entry", "wire", "bus"]);
/**
 * KIGFX::SNAP_INDICATOR (ORIGIN_VIEWITEM CIRCLE_CROSS, 16 px, 1 px pen) in COLOR4D( 0, 0.1, 0.4, 1 ).  A schematic
 * anchor carries no POINT_TYPE, so no type icon is added.
 */
export const SNAP_INDICATOR_COLOR = "rgb(0,26,102)", SNAP_INDICATOR_SIZE = 16;
export function drawSnapIndicator(c: CanvasRenderingContext2D, p: Pt, px: number) {
  const r = SNAP_INDICATOR_SIZE * px;
  c.save(); c.globalAlpha = 1; c.setLineDash([]); c.strokeStyle = SNAP_INDICATOR_COLOR; c.lineWidth = px; c.lineCap = "butt";
  c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2);
  c.moveTo(p[0] - r, p[1]); c.lineTo(p[0] + r, p[1]); c.moveTo(p[0], p[1] - r); c.lineTo(p[0], p[1] + r); c.stroke(); c.restore();
}
/** The junctions a move / drag would add: PreviewJunctions over the moved lines, the stretched ends and the new drag lines. */
export function dragJunctions(doc: KDoc, d: NonNullable<typeof S.drag>): Pt[] {
  const lines: { kind: string; a: Pt; b: Pt }[] = [], skip = new Set<string>();
  const add = (kind: string, pts: Pt[]) => { for (let i = 1; i < pts.length; i++) lines.push({ kind, a: pts[i - 1], b: pts[i] }); };
  // the moved and stretched lines are already where the drag has them: they count once, as preview lines
  const line = (it: KItem) => { if ((it.kind === "wire" || it.kind === "bus") && !skip.has(it.id) && doc.items.get(it.id)) { skip.add(it.id); add(it.kind, ptsOf(doc.items.get(it.id)!.node)); } };
  for (const e of d.items || []) if (e.item) line(e.item);
  for (const a of d.anchors || []) for (const e of a.ends || []) line(e.item);
  for (const s of d.preview || []) add(s.kind, s.pts);
  if (!lines.length) return [];
  try { return previewJunctions(doc, lines, skip); } catch (e) { return []; }
}
