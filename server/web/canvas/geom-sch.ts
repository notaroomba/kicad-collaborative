// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { SCH, SCH_Z, dimColor, parseColor } from "./colors";
import { G, bboxAdd, boxUnion, textGeom, textLines, transformedText } from "./geom";
import { arcFrom3, atOf, bezierPts, colorOf, dashOf, effectsOf, faceOf, ellipsePts, fillOf, has, isList, justOf, kid, kids, num, ptsOf, rotPt, str, strokeColorOf, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { hatchLines } from "./geom-pcb";
import { arcEnds, arcTangents, bezierEndings, emitEnding, hasEndings, polyTangents, readEndings, shortenArc, shortenPoly, shortenSegment } from "./line-ending";
import { MIL, SCH_PEN, layoutPen, parseMarkup, textPen, textWidth, unescapeText } from "./text";
import { linebreakText } from "./stroke-font";
import { expandTextVars, sheetTextVars, varResolver } from "./sheet";
import type { Box, Doc, GeomSink, Item, Pt, SheetContext, TextEffects, Tf } from "./types";
/** SCH_SYMBOL::ResolveTextVar: the Sim.* fields a symbol may lack, which resolve to "" rather than staying ${…}. */
const SIM_VARS = new Set(["SIM.DEVICE", "SIM.TYPE", "SIM.PINS", "SIM.PARAMS", "SIM.LIBRARY", "SIM.NAME"]);

/** What buildPinGeom needs of the symbol around a pin. */
/** `literalTilde`: the file is at version 20250318 or later, where a pin named "~" is literally "~" (older files meant no name). */
export interface PinSym { literalTilde?: boolean; nameOff: number; hideNames: boolean; hideNums: boolean; maxNameHalf: number; col: (c: string) => string; alpha?: number; showHidden?: boolean; altIcons?: boolean }
/** ${VAR} in free text: the title-block / sheet / project variables GetShownText resolves; unknown ones stay as written. */
export function expandDocVars(doc: SheetContext | null | undefined, text: string): string {
  if (!text || text.indexOf("${") < 0) return text;
  try { return expandTextVars(text, varResolver(sheetTextVars(doc), { project: (doc && doc.projectVars) || null })); } catch (e) { return text; }
}
/** The file version from which a pin name "~" is no longer read as an empty name. */
export const TILDE_LITERAL_VERSION = 20250318;
// ---- schematic ----
// KiCad TRANSFORM matrices on library (Y up) coordinates: screen = T·lib + origin (x' = T0·x + T1·y, y' = T2·x + T3·y)
export const ORIENT: Record<number, number[]> = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };

export function symbolTransform(rot: number, mirror: string): number[] {
  let T = ORIENT[((Math.round(rot) % 360) + 360) % 360] || ORIENT[0];
  if (mirror === "y") T = [-T[0], -T[1], T[2], T[3]];   // mirror y negates the X row
  if (mirror === "x") T = [T[0], T[1], -T[2], -T[3]];   // mirror x negates the Y row
  return T.map((v) => v + 0);   // no -0 entries
}

// KiCad's own (internal, Y-down lib coordinates) matrix, used for field/text justification: T·diag(1,-1)
export const internalT = (T: readonly number[]): number[] => [T[0], -T[1], T[2], -T[3]];

export function resolveLib(doc: Pick<KDoc, "lib">, name: string, depth?: number): SNode | null {
  const s = doc.lib.get(name); if (!s) return null;
  const ext = kid(s, "extends");
  if (ext && (depth || 0) < 4) {
    const parent = resolveLib(doc, name.split(":")[0] + ":" + str(ext[1]), (depth || 0) + 1) || resolveLib(doc, str(ext[1]), (depth || 0) + 1);
    if (parent) {
      // a derived symbol inherits the parent's drawing, pin settings and power flag
      const merged = s.slice();
      for (const c of parent.slice(1)) if (isList(c) && (c[0] === "symbol" || (c[0] === "pin_names" && !kid(s, "pin_names")) || (c[0] === "pin_numbers" && !kid(s, "pin_numbers")) || (c[0] === "power" && !kid(s, "power")))) merged.push(c);
      return merged;
    }
  }
  return s;
}


// label flag shapes (eeschema/sch_label.cpp)
export const SPIN: Record<number, string> = { 0: "R", 90: "U", 180: "L", 270: "B" };
   // file angle → spin style
export const SPIN_ROT: Record<string, number> = { L: 0, U: -90, R: 180, B: 90 };
        // template rotation per spin (RotatePoint sign)
export const SPIN_IDX: Record<string, number> = { L: 0, U: 1, R: 2, B: 3 };

export const HIER_TPL: Record<string, number[][]> = {
  input: [[0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0], [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0], [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0], [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0]],
  output: [[-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0], [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2], [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0], [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2]],
  bidirectional: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  tri_state: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  passive: [[0, -1, -2, -1, -2, 1, 0, 1, 0, -1], [1, 0, 1, -2, -1, -2, -1, 0, 1, 0], [0, -1, 2, -1, 2, 1, 0, 1, 0, -1], [1, 0, 1, 2, -1, 2, -1, 0, 1, 0]],
};

export function hierShape(x: number, y: number, size: number, shape: string, spin: string): Pt[] {
  const t = (HIER_TPL[shape] || HIER_TPL.input)[SPIN_IDX[spin]]; const hs = size / 2; const pts: Pt[] = [];
  for (let i = 0; i < t.length; i += 2) pts.push([x + hs * t[i], y + hs * t[i + 1]]);
  return pts;
}

export function spinText(spin: string): { rot: number; h: string } { return { rot: spin === "U" || spin === "B" ? 90 : 0, h: spin === "R" || spin === "U" ? "left" : "right" }; }

export function labelFields(item: Item, n: SNode, color: string, layer: string, z: number): void {
  for (const p of kids(n, "property")) {
    const ef = effectsOf(p); const val = str(p[2]); if (!val || /^\$\{.*\}$/.test(val)) continue;
    const [px, py, pr] = atOf(p);
    // a hidden field: kept aside in LAYER_HIDDEN for show_hidden_fields, outside the hit boxes
    const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
    textLines(sink, px, py, val, ef.size, ef.hide ? SCH.hidden : color, pr, ef.just, layer, { z, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, field: str(p[1]) });
    if (ef.hide && sink.geom.length) { for (const g of sink.geom) { g.hiddenText = true; g.noBox = true; } (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
  }
}


export function buildSchGeom(doc: Doc, item: Item): void {
  const n = item.node, k = item.kind;
  if (k === "wire" || k === "bus" || k === "polyline") {
    const p = ptsOf(n); const isBus = k === "bus";
    const w = widthOf(n, 0) || (isBus ? 0.3048 : 0.1524);
    const color = strokeColorOf(n) || (isBus ? SCH.bus : k === "polyline" ? SCH.notes : SCH.wire);
    if (k === "polyline" && p.length > 2) {
      // a closed polyline with a fill (drawPolygon writes one): SCH_SHAPE fill rules, as for library bodies
      const f = fillOf(n);
      const fill = f.type === "background" ? SCH.body : f.type === "outline" || f.type === "solid" ? color : f.type === "color" ? f.color : null;
      if (fill) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer: "Notes", z: f.type === "outline" || f.type === "solid" ? SCH_Z.notes : SCH_Z.notesBg, noStroke: true });
    }
    if (k === "polyline" && hasEndings(n)) {
      // KiCad 10 line endings: the body is shortened (ShortenSegmentForEndings / ShortenPolyForEndings), the
      // endings drawn along the outward tangent at each end
      const e = readEndings(n), tan = polyTangents(p);
      const seg = p.length === 2 ? shortenSegment(p[0], p[1], e.start, e.end, w) : null;
      const body = p.length === 2 ? (seg ? [seg[0], seg[1]] : null) : shortenPoly(p, e.start, e.end, w);
      if (body) G(item, Object.assign({ t: "poly" as const, pts: body, close: false, w, color, layer: "Notes", z: SCH_Z.notes, cap: "round" }, dashOf(n)));
      emitEnding(item, e.start, p[0], tan[0], w, color, "Notes", SCH_Z.notes); emitEnding(item, e.end, p[p.length - 1], tan[1], w, color, "Notes", SCH_Z.notes);
    } else
    G(item, Object.assign({ t: "poly" as const, pts: p, close: false, w, color, layer: isBus ? "Buses" : k === "polyline" ? "Notes" : "Wires", z: isBus ? SCH_Z.bus : k === "polyline" ? SCH_Z.notes : SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "bus_entry") {
    // wire-to-bus entries take the wire colour and width
    const [x, y] = atOf(n); const s = kid(n, "size"); const dx = s ? num(s[1]) : 2.54, dy = s ? num(s[2]) : 2.54;
    G(item, Object.assign({ t: "line" as const, x1: x, y1: y, x2: x + dx, y2: y + dy, w: widthOf(n, 0) || 0.1524, color: strokeColorOf(n) || SCH.busEntry, layer: "Wires", z: SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "junction") {
    const [x, y] = atOf(n); const d = kid(n, "diameter"); const dflt = doc && doc.schSettings && typeof doc.schSettings.junctionDiameter === "number" ? doc.schSettings.junctionDiameter : 0.9144;   // Schematic Setup > Formatting > Junction dot size
    const r = (d && num(d[1]) > 0 ? num(d[1]) : dflt) / 2;
    G(item, { t: "circle", x, y, r, w: 0, color: colorOf(n) || SCH.junction, fill: colorOf(n) || SCH.junction, layer: "Junctions", z: SCH_Z.junction });
  } else if (k === "no_connect") {
    const [x, y] = atOf(n); const s = Math.max(1.2192, SCH_PEN * 3) / 2;   // DEFAULT_NOCONNECT_SIZE 48 mil
    G(item, { t: "line", x1: x - s, y1: y - s, x2: x + s, y2: y + s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
    G(item, { t: "line", x1: x - s, y1: y + s, x2: x + s, y2: y - s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
  } else if (k === "label" || k === "global_label" || k === "hierarchical_label" || k === "netclass_flag" || k === "directive_label") {
    buildLabelGeom(item, n, k);
  } else if (k === "text") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n);
    // SCH_TEXT::GetSchematicTextOffset: a fixed 0.25 mm lift; angles are kept upright (KeepUpright)
    textLines(item, x, y - 0.25, expandDocVars(doc, str(n[1])), ef.size, colorOf(n) || SCH.notes, rot, ef.just, "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
  } else if (k === "text_box") {
    const [x, y, rot] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 10, h = s ? num(s[2]) : 5; const ef = effectsOf(n);
    const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h), x1 = Math.max(x, x + w), y1 = Math.max(y, y + h);
    const bw = widthOf(n, 0); const border = bw < 0 ? 0 : (bw || SCH_PEN); const f = fillOf(n);
    const fill = f.type === "color" ? f.color : f.type === "background" ? SCH.body : f.type === "solid" ? SCH.notes : null;
    if (fill) G(item, { t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: 0, color: fill, fill, layer: "Notes", z: SCH_Z.notesBg, noStroke: true });
    if (border > 0) G(item, Object.assign({ t: "rect" as const, x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: border, color: strokeColorOf(n) || SCH.notes, fill: null, layer: "Notes", z: SCH_Z.notes }, dashOf(n)));
    const mg = kid(n, "margins"); const lm = mg ? num(mg[1]) : border / 2 + ef.size * 0.75, tm = mg ? num(mg[2]) : lm, rm = mg ? num(mg[3]) : lm, bm = mg ? num(mg[4]) : lm;
    const j = justOf(ef.just);   // the file default is centre / centre (parseEDA_TEXT)
    const vert = ((rot % 180) + 180) % 180 === 90;
    // SCH_TEXTBOX::GetDrawPos: anchor on the box edge matching the justification
    let tx: number, ty: number;
    if (vert) { ty = j.h === "left" ? y1 - bm : j.h === "right" ? y0 + tm : (y0 + y1) / 2; tx = j.v === "top" ? x0 + lm : j.v === "bottom" ? x1 - rm : (x0 + x1) / 2; }
    else { tx = j.h === "left" ? x0 + lm : j.h === "right" ? x1 - rm : (x0 + x1) / 2; ty = j.v === "top" ? y0 + tm : j.v === "bottom" ? y1 - bm : (y0 + y1) / 2; }
    // SCH_TEXTBOX::GetShownText: wrapped to the box's inner width (its height when the text runs vertically)
    const col = vert ? (y1 - y0) - tm - bm : (x1 - x0) - lm - rm;
    textLines(item, tx, ty, linebreakText(unescapeText(expandDocVars(doc, str(n[1]))), col, ef.sizeX, ef.thick, ef.italic), ef.size, colorOf(n) || SCH.notes, rot, [j.h, j.v], "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
  } else if (k === "rectangle" || k === "circle" || k === "arc" || k === "bezier" || k === "ellipse" || k === "ellipse_arc") {
    shapeGeom(item, n, k, (x: number, y: number) => [x, y], SCH.notes, "Notes", SCH_Z.notes, SCH_Z.notesBg, widthOf(n, 0) || SCH_PEN);
  } else if (k === "rule_area") {
    for (const pl of kids(n, "polyline")) {
      const p = ptsOf(pl); if (p.length < 2) continue;
      G(item, Object.assign({ t: "poly" as const, pts: p, close: true, w: widthOf(pl, 0) || SCH_PEN, color: strokeColorOf(pl) || SCH.ruleArea, layer: "Rule areas", z: SCH_Z.ruleArea }, dashOf(pl)));
    }
  } else if (k === "table") {
    buildTableGeom(doc, item, n);
  } else if (k === "image") {
    buildImageGeom(doc, item, n);
  } else if (k === "sheet") {
    buildSheetGeom(item, n);
  } else if (k === "symbol") {
    buildSymbolGeom(doc, item);
  }
}

/** ROUNDRECT::TransformToPolygon: the rectangle x0,y0 – x1,y1 with each corner a quarter circle of radius r (at most half the shorter side). */
export function roundRectPts(x0: number, y0: number, x1: number, y1: number, r: number): Pt[] {
  const l = Math.min(x0, x1), t = Math.min(y0, y1), rr = Math.max(x0, x1), b = Math.max(y0, y1);
  r = Math.min(r, (rr - l) / 2, (b - t) / 2); if (!(r > 0)) return [[l, t], [rr, t], [rr, b], [l, b]];
  const out: Pt[] = [], n = 8;
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + (Math.PI / 2) * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  corner(rr - r, t + r, -Math.PI / 2); corner(rr - r, b - r, 0); corner(l + r, b - r, Math.PI / 2); corner(l + r, t + r, Math.PI);
  return out;
}
/**
 * EDA_SHAPE::UpdateHatching for an SCH_SHAPE filled hatch / reverse_hatch / cross_hatch: lines of slope -1, +1 or
 * both, GetHatchLineWidth() = effective width / 2 wide, 40 of those apart (at most 100 lines across the major
 * axis), clipped to the outline; drawn on the background layer in the fill colour (the stroke colour when none).
 */
export function hatchGeom(item: GeomSink, outline: Pt[], type: string, w: number, color: string, layer: string, z: number): void {
  const slopes = type === "cross_hatch" ? [1, -1] : type === "hatch" ? [-1] : type === "reverse_hatch" ? [1] : null;
  if (!slopes || outline.length < 3) return;
  const lw = w / 2; let spacing = lw * 40; if (!(spacing > 0)) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const major = Math.max(x1 - x0, y1 - y0); if (major / spacing > 100) spacing = major / 100;
  for (const sl of slopes) for (const [ax, ay, bx, by] of hatchLines(outline, sl, spacing, -1))
    G(item, { t: "line", x1: ax, y1: ay, x2: bx, y2: by, w: lw, color, layer, z, cap: "round", noShadow: true });
}

/** Graphic shape shared by sheet-level notes and library bodies (tf maps node coords to screen). */
export function shapeGeom(item: GeomSink, g: SNode, gk: string, tf: Tf, color: string, layer: string, z: number, zBg: number, w: number, bodyFill?: unknown, invertY?: boolean): void {
  const f = fillOf(g); const sc = strokeColorOf(g) || color;
  const fill = f.type === "background" ? SCH.body : f.type === "outline" ? sc : f.type === "color" ? f.color : f.type === "solid" ? sc : null;
  const fz = f.type === "outline" || f.type === "solid" ? z : zBg;   // KiCad fills device-coloured shapes in the foreground
  const closed = f.type !== "none"; const ds = dashOf(g);
  const hatch = (outline: Pt[]) => hatchGeom(item, outline, f.type, w, f.color || sc, layer, zBg);
  if (gk === "rectangle") {
    const s0 = kid(g, "start"), e0 = kid(g, "end"); if (!s0 || !e0) return;
    const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]);
    // (radius r): SCH_PAINTER draws a ROUNDRECT, its fill and shadow following the same outline
    const rN = kid(g, "radius"), rad = rN ? num(rN[1]) : 0;
    const pts = rad > 0 ? roundRectPts(x0, y0, x1, y1, rad).map(([x, y]) => tf(x, y)) : [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    if (fill) G(item, { t: "poly", pts, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    hatch(pts);
    G(item, Object.assign({ t: "poly" as const, pts, close: true, w, color: sc, layer, z }, ds));
  } else if (gk === "polyline" || gk === "bezier") {
    const ctrl = ptsOf(g).map(([x, y]) => tf(x, y)); let p = ctrl; if (p.length < 2) return;
    if (gk === "bezier") p = bezierPts(p);
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (gk === "polyline" && p.length > 2) hatch(p);
    if (hasEndings(g)) {
      const e = readEndings(g);
      let body: Pt[] | null, tan: [Pt | null, Pt | null];
      if (gk === "bezier") { const r = bezierEndings(p, ctrl, e.start, e.end, w); body = r.body; tan = r.tan; }
      else { body = shortenPoly(p, e.start, e.end, w); tan = polyTangents(p); }
      if (body) G(item, Object.assign({ t: "poly" as const, pts: body, close: false, w, color: sc, layer, z }, ds));
      emitEnding(item, e.start, p[0], tan[0], w, sc, layer, z); emitEnding(item, e.end, p[p.length - 1], tan[1], w, sc, layer, z);
      return;
    }
    G(item, Object.assign({ t: "poly" as const, pts: p, close: false, w, color: sc, layer, z }, ds));
  } else if (gk === "circle") {
    const c = kid(g, "center"), r = kid(g, "radius"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const rad = r ? num(r[1]) : 1;
    if (fill) G(item, { t: "circle", x: cx, y: cy, r: rad, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (f.type.endsWith("hatch")) { const ring: Pt[] = []; for (let i = 0; i < 64; i++) ring.push([cx + rad * Math.cos(i * Math.PI / 32), cy + rad * Math.sin(i * Math.PI / 32)]); hatch(ring); }
    G(item, Object.assign({ t: "circle" as const, x: cx, y: cy, r: rad, w, color: sc, layer, z }, ds));
  } else if (gk === "ellipse" || gk === "ellipse_arc") {
    const e = ellipsePts(g, invertY); if (!e) return; const p = e.pts.map(([x, y]) => tf(x, y));
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (gk === "ellipse") hatch(p);
    G(item, Object.assign({ t: "poly" as const, pts: p, close: e.closed, w, color: sc, layer, z }, ds));
  } else if (gk === "arc") {
    const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !m0 || !e0) return;
    const a = arcFrom3(tf(num(s0[1]), num(s0[2])), tf(num(m0[1]), num(m0[2])), tf(num(e0[1]), num(e0[2])));
    if (a && hasEndings(g)) {
      const e = readEndings(g), body = shortenArc(a, e.start, e.end, w), tan = arcTangents(a), [ps, pe] = arcEnds(a);
      if (body) G(item, Object.assign({ t: "arc" as const, w, color: sc, layer, z, fill: closed ? fill : null }, body, ds));
      emitEnding(item, e.start, ps, tan[0], w, sc, layer, z); emitEnding(item, e.end, pe, tan[1], w, sc, layer, z);
    } else if (a) G(item, Object.assign({ t: "arc" as const, w, color: sc, layer, z, fill: closed ? fill : null }, a, ds));
    else { const p0 = tf(num(s0[1]), num(s0[2])), p1 = tf(num(e0[1]), num(e0[2])); G(item, Object.assign({ t: "line" as const, x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color: sc, layer, z }, ds)); }
  }
}

export function buildLabelGeom(item: Item, n: SNode, k: string): void {
  const [x, y, rot] = atOf(n); const ef = effectsOf(n); const text = str(n[1]); const size = ef.size;
  const spin = SPIN[((Math.round(rot) % 360) + 360) % 360] || "R"; const st = spinText(spin);
  const pen = textPen(ef, size), lpen = layoutPen(ef, size); const off = schFormat.textOffsetRatio * size;   // SCHEMATIC_SETTINGS::m_TextOffsetRatio
  const shapeN = kid(n, "shape"); const shape = shapeN ? str(shapeN[1]) : "";
  if (k === "label") {
    const d = off + lpen; const tx = st.rot ? x - d : x, ty = st.rot ? y : y - d;
    textGeom(item, tx, ty, text, size, colorOf(n) || SCH.label, st.rot, [st.h, "bottom"], "Labels", { z: SCH_Z.loclabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else if (k === "global_label") {
    const color = colorOf(n) || SCH.glabel; const margin = schFormat.labelSizeRatio * size;   // SCHEMATIC_SETTINGS::m_LabelSizeRatio
    let horiz = margin; if (shape === "input" || shape === "bidirectional" || shape === "tri_state") horiz += size * 0.75;
    const vert = size * 0.0715;
    const to = spin === "L" ? [-horiz, vert] : spin === "U" ? [vert, -horiz] : spin === "R" ? [horiz, vert] : [vert, horiz];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.globlabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    // outline: SCH_GLOBALLABEL::CreateGraphicShape
    const halfSize = size / 2 + margin; const symbLen = textWidth(parseMarkup(text).text, size, lpen) + 2 * margin;
    const bx = symbLen + lpen, by = halfSize + lpen;
    let pts: Pt[] = [[0, 0], [0, -by], [-bx, -by], [-bx, 0], [-bx, by], [0, by]]; let xo = 0;
    if (shape === "input") { xo = -halfSize; pts[0][0] += halfSize; }
    else if (shape === "output") pts[3][0] -= halfSize;
    else if (shape === "bidirectional" || shape === "tri_state") { xo = -halfSize; pts[0][0] += halfSize; pts[3][0] -= halfSize; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px + xo, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    G(item, { t: "poly", pts, close: true, w: pen, color, layer: "Labels", z: SCH_Z.globlabel });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else if (k === "hierarchical_label") {
    const color = colorOf(n) || SCH.hlabel; const d = off + ef.sizeX;
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.hierlabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    G(item, { t: "poly", pts: hierShape(x, y, size, shape || "input", spin), close: false, w: pen, color, layer: "Labels", z: SCH_Z.hierlabel });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields);
  } else {
    // directive label / netclass flag: SCH_DIRECTIVE_LABEL::CreateGraphicShape
    const color = colorOf(n) || SCH.netclass; const lenN = kid(n, "length"); const pinLen = lenN ? num(lenN[1]) : 2.54;
    const symSize = 0.508; let s = symSize; let pts: Pt[], kind = shape || "round";
    if (kind === "dot") { s = symSize * 0.7; pts = [[0, 0], [0, pinLen - s], [0, pinLen]]; }
    else if (kind === "round") pts = [[0, 0], [0, pinLen - s], [0, pinLen]];
    else if (kind === "diamond") pts = [[0, 0], [0, pinLen - s], [-2 * symSize, pinLen], [0, pinLen + s], [2 * symSize, pinLen], [0, pinLen - s]];
    else { s = symSize * 0.8; pts = [[0, 0], [0, pinLen - s], [-2 * s, pinLen - s], [-2 * s, pinLen + s], [2 * s, pinLen + s], [2 * s, pinLen - s], [0, pinLen - s]]; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    const w = Math.max(pen, SCH_PEN);
    if (kind === "dot" || kind === "round") {
      G(item, { t: "line", x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], w, color, layer: "Labels", z: SCH_Z.netclass });
      G(item, { t: "circle", x: pts[2][0], y: pts[2][1], r: Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]), w, color, fill: kind === "dot" ? color : null, layer: "Labels", z: SCH_Z.netclass });
    } else G(item, { t: "poly", pts, close: false, w, color, layer: "Labels", z: SCH_Z.netclass });
    if (text) textGeom(item, x, y, text, size, color, st.rot, [st.h, "bottom"], "Labels", { z: SCH_Z.netclass, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    labelFields(item, n, SCH.netclass, "Labels", SCH_Z.netclass);
  }
}

export function buildSheetGeom(item: Item, n: SNode): void {
  const [x, y] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 20, h = s ? num(s[2]) : 20;
  const f = fillOf(n); const bw = widthOf(n, 0) || SCH_PEN;
  // (dnp yes): the sheet, its fields and pins dimmed (draw( …, DNP )) under the red cross; (exclude_from_sim yes): the marker
  const dnp = yesNo(n, "dnp"), noSim = yesNo(n, "exclude_from_sim");
  const col = dnp ? (c: string) => dimColor(c, SCH.bg) : (c: string) => c;
  if (f.color) G(item, { t: "rect", x, y, w, h, wd: 0, color: col(f.color), fill: col(f.color), layer: "Sheets", z: SCH_Z.sheetBg, noStroke: true });
  G(item, Object.assign({ t: "rect" as const, x, y, w, h, wd: bw, color: col(strokeColorOf(n) || SCH.sheet), fill: null, layer: "Sheets", z: SCH_Z.sheet }, dashOf(n)));
  item.movable = true; item.x = x; item.y = y; item.w = w; item.h = h; item.rot = 0;
  // A subsheet's page number lives HERE, in the parent's instance data — the child's own file has no
  // (sheet_instances …) at all.  SCH_SCREEN::GetPageNumber() is what feeds the child's ${#}
  // (eeschema/sch_view.cpp:134), so the child cannot answer it from its own text.
  const inst = kid(n, "instances");
  if (inst) for (const proj of kids(inst, "project")) for (const path of kids(proj, "path")) { const pg = kid(path, "page"); if (pg) { item.page = str(pg[1]); break; } }
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Sheetname") item.name = val; if (name === "Sheetfile") item.file = val;
    if (ef.hide || !val) continue;
    const [px, py, pr] = atOf(p);
    const color = col(name === "Sheetname" ? SCH.sheetName : name === "Sheetfile" ? SCH.sheetFile : SCH.sheetFields);
    textLines(item, px, py, (name === "Sheetfile" ? "File: " : "") + val, ef.size, color, pr, ef.just, "Sheets", { z: SCH_Z.sheetFields, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
  }
  for (const pin of kids(n, "pin")) {
    const [px, py, pr] = atOf(pin); const ef = effectsOf(pin); const size = ef.size; const pen = textPen(ef, size);
    // side → spin: right edge reads leftwards into the sheet, etc. (SCH_SHEET_PIN::SetSide)
    const side = ((Math.round(pr) % 360) + 360) % 360; const spin = side === 0 ? "L" : side === 90 ? "B" : side === 180 ? "R" : "U";
    let shape = str(pin[2]) || "input"; if (shape === "input") shape = "output"; else if (shape === "output") shape = "input";
    const g0 = item.geom.length;
    G(item, { t: "poly", pts: hierShape(px, py, size, shape, spin), close: false, w: SCH_PEN, color: col(SCH.sheetLabel), layer: "Sheets", z: SCH_Z.sheet });
    const d = 0.15 * size + ef.sizeX; const st = spinText(spin);
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, px + to[0], py + to[1], str(pin[1]), size, col(SCH.sheetLabel), st.rot, [st.h, "middle"], "Sheets", { z: SCH_Z.sheet, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    for (let i = g0; i < item.geom.length; i++) item.geom[i].pinNo = str(pin[1]);   // "sheetId#pin:<name>" in a net highlight
  }
  if (dnp && schFormat.showDnpMarkers) {   // m_ShowDNPMarkers
    // the symbol's DNP cross: the body box grown toward the pins (GetBoundingBox), 3 x the default line width
    const all = item.bbox || [x, y, x + w, y + h];
    const mx0 = Math.max(x - all[0], all[2] - (x + w)), my0 = Math.max(y - all[1], all[3] - (y + h));
    const mx = Math.max(mx0 * 0.6, my0 * 0.3), my = Math.max(my0 * 0.6, mx0 * 0.3);
    const b = [x - mx, y - my, x + w + mx, y + h + my];
    G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Sheets", z: SCH_Z.marker, cap: "round" });
    G(item, { t: "line", x1: b[2], y1: b[1], x2: b[0], y2: b[3], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Sheets", z: SCH_Z.marker, cap: "round" });
  }
  if (noSim) { const sw = 25 * MIL; simMarker(item, [x - sw / 2, y - sw / 2, x + w + sw / 2, y + h + sw / 2], sw, 0.5); }
}

/** LIB_SYMBOL::LetterSubReference( unit, 'A' ): A..Z, then AA.. */
export function unitLetter(unit: number): string {
  let u: number, suffix = "";
  do { u = (unit - 1) % 26; suffix = String.fromCharCode(65 + u) + suffix; unit = (unit - u) / 26 | 0; } while (unit > 0);
  return suffix;
}

export const PIN_TEXT_OFFSET = Math.round(24 * 0.15) * MIL, PIN_TEXT_MARGIN = 4 * MIL, TARGET_PIN_RADIUS = 15 * MIL;

export const pinHidden = (g: SNode): boolean => has(g, "hide") || !!(kid(g, "hide") && str(kid(g, "hide")![1]) === "yes");

export function buildSymbolGeom(doc: Doc, item: Item): void {
  const n = item.node;
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const [ax, ay, rot] = atOf(n);
  const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1;
  const styleN = kid(n, "body_style") || kid(n, "convert"); const style = styleN ? num(styleN[1], 1) : 1;
  const dnp = yesNo(n, "dnp"); const noSim = yesNo(n, "exclude_from_sim");
  const T = symbolTransform(rot, mirror); const Ti = internalT(T);
  const tf = (lx: number, ly: number): Pt => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  item.movable = true; item.x = ax; item.y = ay; item.rot = rot; item.lib = str((kid(n, "lib_id") || [])[1]) || libId; item.unit = unit;
  const lib = resolveLib(doc, libId) || (libId !== str((kid(n, "lib_id") || [])[1]) ? resolveLib(doc, str((kid(n, "lib_id") || [])[1])) : null);
  const col = dnp ? (c: string) => dimColor(c, SCH.bg) : (c: string) => c;
  // excluded from simulation: only the marker below (SCH_PAINTER keeps the symbol's own colours)
  const alpha: number | undefined = undefined;
  const bodyLayer = "Symbols";
  let bodyBox: Box | null = null, pinBox: Box | null = null, unitCount = 1;
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m && +m[1] > unitCount) unitCount = +m[1]; }
  const take = (g0: string) => { const b = item.bbox; if (!b) return; if (g0 === "pin") pinBox = boxUnion(pinBox, b[0], b[1], b[2], b[3]); else bodyBox = boxUnion(bodyBox, b[0], b[1], b[2], b[3]); };
  if (lib) {
    const pn = kid(lib, "pin_names"); const nameOff = pn && kid(pn, "offset") ? num(kid(pn, "offset")![1]) : 0.508;
    const hideNames = !!(pn && (has(pn, "hide") || (kid(pn, "hide") && str(kid(pn, "hide")![1]) === "yes")));
    const pnu = kid(lib, "pin_numbers"); const hideNums = !!(pnu && (has(pnu, "hide") || (kid(pnu, "hide") && str(kid(pnu, "hide")![1]) === "yes")));
    const subs = kids(lib, "symbol");
    // tallest visible pin name of the whole symbol positions names above horizontal pins
    let maxNameHalf = 0;
    for (const sub of subs) for (const p of kids(sub, "pin")) { const nm = kid(p, "name"); if (nm && str(nm[1]) && (str(nm[1]) !== "~" || (doc.version || 0) >= TILDE_LITERAL_VERSION)) maxNameHalf = Math.max(maxNameHalf, effectsOf(nm).size / 2); }
    // show_pin_alt_icons (EESCHEMA_SETTINGS, on by default): pins with alternates draw drawAltPinModesIcon
    const sym: PinSym = { nameOff, hideNames, hideNums, maxNameHalf, col, alpha, literalTilde: (doc.version || 0) >= TILDE_LITERAL_VERSION, altIcons: schDisplay.pinAltIcons };
    const geomStart = item.geom.length;
    for (const sub of subs) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || (s !== 0 && s !== style)) continue;   // unit 0 / body style 0 = common to all (LIB_SYMBOL)
      for (let j = 2; j < sub.length; j++) {
        const g = sub[j]; if (!isList(g)) continue;
        const gk = g[0];
        if (yesNo(g, "private")) continue;
        const before = item.bbox ? item.bbox.slice() : null; item.bbox = null;
        if (gk === "rectangle" || gk === "polyline" || gk === "bezier" || gk === "circle" || gk === "arc" || gk === "ellipse" || gk === "ellipse_arc") {
          shapeGeom(item, g, gk, tf, col(SCH.outline), bodyLayer, SCH_Z.device, SCH_Z.deviceBg, widthOf(g, 0) || SCH_PEN, undefined, true);
          take("body");
        } else if (gk === "text") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g);
          if (!ef.hide) { const [px, py] = tf(tx, ty); transformedText(item, Ti, px, py, str(g[1]), ef.size, col(strokeColorOf(g) || SCH.outline), tr, ef.just, bodyLayer, { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, alpha }); take("body"); }
        } else if (gk === "text_box") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g); const sz = kid(g, "size"); const [px, py] = tf(tx, ty);
          if (!ef.hide) { transformedText(item, Ti, px, py, str(g[1]), ef.size, col(SCH.outline), tr, ef.just, bodyLayer, { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, alpha, defH: "left", defV: "top" }); take("body"); }
        } else if (gk === "pin") {
          if (pinHidden(g)) {
            // kept aside, untouched bbox: drawn only under the showHiddenPins render option, in KiCad's hidden-item colour
            const shadow: GeomSink = { geom: [], bbox: null };
            buildPinGeom(shadow, g, tf, Object.assign({}, sym, { col: () => SCH.hidden, showHidden: true }));
            if (shadow.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...shadow.geom);
          } else { buildPinGeom(item, g, tf, sym); take("pin"); }
        }
        if (before) item.bbox = item.bbox ? boxUnion(item.bbox, before[0], before[1], before[2], before[3]) : before;
      }
    }
    if (alpha !== undefined) for (let i = geomStart; i < item.geom.length; i++) if (item.geom[i].alpha === undefined) item.geom[i].alpha = alpha;
    if (alpha !== undefined && item.hiddenGeom) for (const hg of item.hiddenGeom) if (hg.alpha === undefined) hg.alpha = alpha;
  } else {
    G(item, { t: "rect", x: ax - 2.54, y: ay - 2.54, w: 5.08, h: 5.08, wd: SCH_PEN, color: SCH.outline, fill: null, layer: bodyLayer, z: SCH_Z.device });
    bodyBox = item.bbox!.slice();   // G just grew it
  }
  if (!bodyBox) bodyBox = [ax, ay, ax, ay]; if (!pinBox) pinBox = bodyBox.slice();
  let localPower = false;
  if (lib) { const pw = kid(lib, "power"); if (pw && str(pw[1]) === "local") { const pins: SNode[] = []; for (const sub of kids(lib, "symbol")) pins.push(...kids(sub, "pin")); localPower = pins.length === 1 && str(pins[0][1]) === "power_in"; } }
  const union = boxUnion(bodyBox, pinBox[0], pinBox[1], pinBox[2], pinBox[3]);
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Reference") item.ref = val; if (name === "Value") item.value = val;
    if (!val || name.startsWith("ki_")) continue;
    const [px, py, pr] = atOf(p);
    const isRef = name === "Reference", isVal = name === "Value";
    // a hidden field is kept aside in LAYER_HIDDEN, drawn under show_hidden_fields (outside the hit boxes)
    const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
    const color = ef.hide ? SCH.hidden : col(isRef || isVal ? SCH.ref : SCH.field);
    // SCH_FIELD::GetShownText: the reference of a multi-unit symbol carries its unit letter (U2 → U2A)
    let shown = isRef && unitCount > 1 ? val + unitLetter(unit) : val;
    // SCH_SYMBOL::ResolveTextVar: ${REFERENCE}, ${VALUE}, ${UNIT} and the symbol's other fields by name
    if (shown.indexOf("${") >= 0) shown = expandTextVars(shown, (tok) => {
      const up = tok.toUpperCase();
      if (up === "UNIT") return unitCount > 1 ? unitLetter(unit) : "";
      for (const q of kids(n, "property")) if (str(q[1]).toUpperCase() === up && q !== p) return str(q[2]);
      // missing simulation fields read as empty, not unresolved (exact, upper-case token names)
      if (SIM_VARS.has(tok)) return "";
      return null;
    });
    const tg = transformedText(sink, Ti, px, py, shown, ef.size, color, pr, ef.just, isRef || isVal ? "Reference & value" : "Fields", { z: isRef ? SCH_Z.ref : isVal ? SCH_Z.value : SCH_Z.fields, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, alpha, field: name });
    // a local power symbol (IsSymbolLikePowerLocalLabel) marks its Value with drawLocalPowerIcon
    if (isVal && localPower) localPowerIcon(sink, tg, shown, textPen(ef, ef.size), color, name);
    if (ef.hide) { for (const hg of sink.geom) { hg.hiddenText = true; hg.noBox = true; } if (sink.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
  }
  if (dnp && schFormat.showDnpMarkers) {   // m_ShowDNPMarkers
    // SCH_PAINTER: body box grown toward the pins, crossed at 3× the default line width
    const mx0 = Math.max(bodyBox[0] - union[0], union[2] - bodyBox[2]), my0 = Math.max(bodyBox[1] - union[1], union[3] - bodyBox[3]);
    const mx = Math.max(mx0 * 0.6, my0 * 0.3), my = Math.max(my0 * 0.6, mx0 * 0.3);
    const b = [bodyBox[0] - mx, bodyBox[1] - my, bodyBox[2] + mx, bodyBox[3] + my];
    G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
    G(item, { t: "line", x1: b[0], y1: b[3], x2: b[2], y2: b[1], w: 3 * SCH_PEN, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
  }
  if (noSim) {
    // exclude-from-simulation marker: grey frame plus the wave badge at the bottom-right corner
    const sw = 25 * MIL; const b = [bodyBox[0] - sw / 2, bodyBox[1] - sw / 2, bodyBox[2] + sw / 2, bodyBox[3] + sw / 2];
    simMarker(item, b, sw, 1);
  }
  if (!item.bbox) bboxAdd(item, ax, ay, 2.54);
}

/**
 * The schematic View-menu options that change geometry (EESCHEMA_SETTINGS appearance): the pin alternate icons.  The
 * host sets them and rebuilds the sheet's symbols (KiCadCanvas.setSchDisplay).
 */
/**
 * Schematic Setup > Formatting values the painter reads (SCHEMATIC_SETTINGS, the project's schematic.drawing):
 * text_offset_ratio (0.15), label_size_ratio (0.375), pin_symbol_size (25 mil; 0 = from the pin's text sizes),
 * show_dnp_markers.  default_line_thickness is text.ts's SCH_PEN.  setSchFormatting (index.ts) rebuilds the sheet.
 */
export const schFormat = { textOffsetRatio: 0.15, labelSizeRatio: 0.375, pinSymbolSize: 25 * MIL, showDnpMarkers: true, overbarHeight: 1.23, hopOverChoice: 0 };
export const schDisplay = { pinAltIcons: true };
/**
 * SCH_PAINTER's excluded-from-simulation marker (mark_sim_exclusions): the body box framed at
 * m_ExcludeFromSimulationLineWidth (25 mils) and the wave badge at its bottom-right corner, in
 * LAYER_EXCLUDED_FROM_SIM (a sheet's at alpha 0.5).  Tagged simMarker: render() leaves it out when the option is off.
 */
export function simMarker(item: GeomSink, b: number[], sw: number, alpha: number): void {
  const [r, g, bl] = parseColor(SCH.excluded); const col = (a: number) => `rgba(${r},${g},${bl},${a})`;
  const c = alpha < 1 ? col(alpha) : SCH.excluded, layer = "Symbols", z = SCH_Z.marker;
  G(item, { t: "poly", pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], close: true, w: sw, color: c, layer, z, simMarker: true });
  const off = 2 * sw; const cx = b[2] + off + sw, cy = b[3] - off;
  G(item, { t: "circle", x: cx, y: cy, r: off, w: sw, color: c, fill: col(0.1), layer, z, simMarker: true });
  G(item, { t: "poly", pts: bezierPts([[cx - off, cy], [cx, cy + off], [cx, cy - off], [cx + off, cy]], 12), close: false, w: sw, color: c, layer, z, simMarker: true });
}
/**
 * SCH_PAINTER::drawLocalPowerIcon beside a local power symbol's Value: SCH_SYMBOL::BuildLocalPowerIconShape (three
 * beziers and a filled dot, line width size / 10) at bbox.left - h/2, bottom - h/6, size h / 1.5 (the vertical text's
 * variant rotated 90 degrees), in the field colour.  `tg` is the field's text record.
 */
export function localPowerIcon(item: GeomSink, tg: { x: number; y: number; rot: number; h: string; v: string; size: number; sizeX?: number }, text: string, pen: number, color: string, field: string): void {
  const w = textWidth(parseMarkup(text).text, tg.sizeX || tg.size, pen), hgt = tg.size + pen, rotated = ((Math.round(tg.rot) % 180) + 180) % 180 === 90;
  // the field's box in sheet coordinates
  const along0 = tg.h === "left" ? 0 : tg.h === "right" ? -w : -w / 2, across0 = tg.v === "top" ? 0 : tg.v === "bottom" ? -hgt : -hgt / 2;
  let bx0: number, by0: number, bw: number, bh: number;
  if (!rotated) { bx0 = tg.x + along0; by0 = tg.y + across0; bw = w; bh = hgt; }
  else { bx0 = tg.x + across0; by0 = tg.y - along0 - w; bw = hgt; bh = w; }
  const size = rotated ? bw / 1.5 : bh / 1.5;
  const pos: Pt = rotated ? [bx0 + bw - bw / 6, by0 + bh + bw / 2] : [bx0 - bh / 2, by0 + bh - bh / 6];
  const xr = size / 1.6180339887, xm = xr / 2;
  const P = (x: number, y: number): Pt => rotated ? [pos[0] + y, pos[1] - x] : [pos[0] + x, pos[1] + y];   // RotatePoint 90 CCW, then Move
  const bottom: Pt = [xm, 0], left: Pt = [0, -2 * size / 3], right: Pt = [xr, -2 * size / 3];
  const bA: Pt = [xm, -size / 4], l1: Pt = [0, -size / 2.5], l2: Pt = [0, -size * 1.15], r1: Pt = [xr, -size / 2.5], r2: Pt = [xr, -size * 1.15];
  const lw = size / 10, layer = "Reference & value", z = SCH_Z.value;
  for (const c of [[bottom, bA, l1, left], [left, l2, r2, right], [right, r1, bA, bottom]])
    G(item, { t: "poly", pts: bezierPts(c.map((p) => P(p[0], p[1])), 12), close: false, w: lw, color, layer, z, field, cap: "round" });
  const cc = P((left[0] + right[0]) / 2, (left[1] + right[1]) / 2);
  G(item, { t: "circle", x: cc[0], y: cc[1], r: size / 15, w: lw, color, fill: color, layer, z, field });
}

/** One library pin mapped to the sheet: line, shape decoration, name and number (PIN_LAYOUT_CACHE rules). */
/** drawAltPinModesIcon (sch_painter.cpp), base function selected: two arrows, the lower one leaving an S-bend. */
function altPinModesIcon(item: GeomSink, x: number, y: number, size: number, rotate: boolean, color: string): void {
  const w = size / 10, lyo = size / 4, ah = size / 8, layer = "Pin names", z = SCH_Z.pinName;
  const P = (px: number, py: number): Pt => (rotate ? [x + py, y - px] : [x + px, y + py]);   // GAL Rotate( 270 deg )
  const seg = (a: Pt, b: Pt) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  const tr: Pt = [size / 2, -lyo], br: Pt = [size / 2, lyo];
  seg(P(tr[0], tr[1]), P(tr[0] - size, tr[1]));
  seg(P(tr[0], tr[1]), P(tr[0] - ah * 1.2, tr[1] - ah)); seg(P(tr[0], tr[1]), P(tr[0] - ah * 1.2, tr[1] + ah));
  seg(P(br[0], br[1]), P(br[0] - size / 2, br[1]));
  seg(P(br[0], br[1]), P(br[0] - ah * 1.2, br[1] - ah)); seg(P(br[0], br[1]), P(br[0] - ah * 1.2, br[1] + ah));
  const arc: Pt[] = []; for (let i = 0; i <= 8; i++) { const t = Math.PI - (Math.PI / 2) * i / 8; arc.push(P(lyo * Math.cos(t), lyo * Math.sin(t))); }   // centre (0, 0), 180 -> 90 deg
  G(item, { t: "poly", pts: arc, close: false, w, color, layer, z });
}
export function buildPinGeom(item: GeomSink, g: SNode, tf: Tf, sym: PinSym): void {
  const type = str(g[1]), shape = str(g[2]);
  const [px, py, pr] = atOf(g); const lenN = kid(g, "length"); const len = lenN ? num(lenN[1]) : 2.54;
  if (pinHidden(g) && !sym.showHidden) return;   // hidden (e.g. power) pins draw nothing unless asked for
  // every geometry of the pin carries its number: a net highlight brightens single pins ("symbolId#pin:<number>")
  const g0 = item.geom.length, numTag = kid(g, "number"); const tag = numTag ? str(numTag[1]) : "";
  try { buildPinGeomInner(item, g, tf, sym, type, shape, px, py, pr, len); } finally { for (let i = g0; i < item.geom.length; i++) item.geom[i].pinNo = tag; }
}
function buildPinGeomInner(item: GeomSink, g: SNode, tf: Tf, sym: PinSym, type: string, shape: string, px: number, py: number, pr: number, len: number): void {
  const dir = ((Math.round(pr) % 360) + 360) % 360;
  const d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];   // file angle points into the body
  const pos = tf(px, py), rootPt = tf(px + d[0] * len, py + d[1] * len);
  const tip = tf(px + d[0], py + d[1]); let ox = pos[0] - tip[0], oy = pos[1] - tip[1];   // outward: body → connection point
  const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
  // KiCad's PIN_RIGHT/LEFT/UP/DOWN name the direction from the connection point into the body
  const orient = ox < 0 ? "R" : ox > 0 ? "L" : oy > 0 ? "U" : "D"; const vertical = orient === "U" || orient === "D";
  const color = sym.col(SCH.pin); const w = SCH_PEN; const z = SCH_Z.pin, layer = "Pins";
  const nameN = kid(g, "name"), numN = kid(g, "number");
  const nameEf: Pick<TextEffects, "size" | "hide"> = nameN ? effectsOf(nameN) : { size: 1.27, hide: false }, numEf: Pick<TextEffects, "size" | "hide"> = numN ? effectsOf(numN) : { size: 1.27, hide: false };
  const ps = schFormat.pinSymbolSize;   // SCH_PAINTER::externalPinDecoSize / internalPinDecoSize: m_PinSymbolSize when set
  const radius = ps > 0 ? ps : numEf.size / 2, diam = radius * 2, clock = ps > 0 ? ps : (nameEf.size || numEf.size) / 2;
  const p0 = rootPt; const line = (a: Pt, b: Pt) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  const tri = (a: Pt, b: Pt, c: Pt) => G(item, { t: "poly", pts: [a, b, c], close: false, w, color, layer, z });
  const P = (dx: number, dy: number): Pt => [p0[0] + dx, p0[1] + dy];
  if (len > 0 || shape !== "line") {
    if (type === "no_connect") {
      line(p0, pos); const r = TARGET_PIN_RADIUS;
      line([pos[0] - r, pos[1] - r], [pos[0] + r, pos[1] + r]); line([pos[0] + r, pos[1] - r], [pos[0] - r, pos[1] + r]);
    } else if (shape === "inverted") {
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "inverted_clock") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "clock_low" || shape === "edge_clock_high") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
      if (len > 0) line(p0, pos);
    } else if (shape === "clock") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(0, clock), P(-ox * clock, 0), P(0, -clock)); else tri(P(clock, 0), P(0, -oy * clock), P(-clock, 0));
    } else if (shape === "input_low") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
    } else if (shape === "output_low") {
      if (len > 0) line(p0, pos);
      if (!oy) line(P(0, -diam), P(ox * diam, 0)); else line(P(-diam, 0), P(0, oy * diam));
    } else if (shape === "non_logic") {
      if (len > 0) line(p0, pos);
      line(P(-(ox + oy) * radius, -(oy - ox) * radius), P((ox + oy) * radius, (oy - ox) * radius));
      line(P(-(ox - oy) * radius, -(ox + oy) * radius), P((ox - oy) * radius, (ox + oy) * radius));
    } else if (len > 0) line(p0, pos);
  }
  bboxAdd(item, pos[0], pos[1]); bboxAdd(item, p0[0], p0[1]);
  // --- text ---
  const pinName = nameN ? str(nameN[1]) : "", pinNum = numN ? str(numN[1]) : "";
  const named = !!pinName && (pinName !== "~" || !!sym.literalTilde);   // SCH_IO_KICAD_SEXPR_PARSER: "~" is empty only before 20250318
  const showName = named && !sym.hideNames && !nameEf.hide;
  const showNum = !!pinNum && !sym.hideNums && !numEf.hide;
  const nameThick = Math.min(SCH_PEN, 0.18 * nameEf.size), numThick = Math.min(SCH_PEN, 0.18 * numEf.size);
  const clearance = PIN_TEXT_OFFSET + PIN_TEXT_MARGIN; const halfLen = len / 2;
  const inside = sym.nameOff > 0;
  const both = named && !sym.hideNames && !inside;   // name drawn outside → number moves to the other side
  const alongX = orient === "L" ? pos[0] - halfLen : pos[0] + halfLen, alongY = orient === "D" ? pos[1] + halfLen : pos[1] - halfLen;
  const nameColor = sym.col(SCH.pinName), numColor = sym.col(SCH.pinNum);
  if (showNum) {
    const perp = clearance + numEf.size / 2 + numThick;
    if (vertical) textGeom(item, both ? pos[0] + perp : pos[0] - perp, alongY, pinNum, numEf.size, numColor, 90, ["center", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
    else textGeom(item, alongX, both ? pos[1] + perp : pos[1] - perp, pinNum, numEf.size, numColor, 0, ["center", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
  }
  if (showName && sym.altIcons && kids(g, "alternate").length) {
    // PIN_LAYOUT_CACHE::getUntransformedAltIconBox + drawAltPinModesIcon: beyond an inside name, before an outside one
    const icon = Math.min(nameEf.size, 1.5), nw = textWidth(pinName, nameEf.size, nameThick);
    const ux = -ox, uy = -oy;   // connection point → body
    const along = inside ? len + sym.nameOff + nw + icon * 0.75 : halfLen - nw / 2 - icon * 0.75;
    const perp = inside ? 0 : vertical ? clearance + nameEf.size / 2 + nameThick : sym.maxNameHalf + clearance + nameThick;
    const cx = pos[0] + ux * along - (vertical ? perp : 0), cy = pos[1] + uy * along - (vertical ? 0 : perp);
    altPinModesIcon(item, cx, cy, icon, vertical, nameColor);
  }
  if (showName) {
    if (inside) {
      const dd = len + sym.nameOff;
      const at = orient === "R" ? [pos[0] + dd, pos[1]] : orient === "L" ? [pos[0] - dd, pos[1]] : orient === "U" ? [pos[0], pos[1] - dd] : [pos[0], pos[1] + dd];
      textGeom(item, at[0], at[1], pinName, nameEf.size, nameColor, vertical ? 90 : 0, [orient === "R" || orient === "U" ? "left" : "right", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else if (vertical) {
      textGeom(item, pos[0] - (clearance + nameEf.size / 2 + nameThick), alongY, pinName, nameEf.size, nameColor, 90, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else {
      textGeom(item, alongX, pos[1] - (sym.maxNameHalf + clearance + nameThick), pinName, nameEf.size, nameColor, 0, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    }
  }
}
