import type { Box, Pt } from "./types";
import { tFrom } from "./orient";
import { K, atOf, kid, kids, str } from "./state";
import { deep, r4 } from "./util";

// ---------------------------------------------------------------- node builders (KiCad 9 file shapes)
export const fontNode = (size: number): SNode => ["font", ["size", size, size]];
export function lineNode(kind: string, a: Pt, b: Pt): SNode { return [kind, ["pts", ["xy", r4(a[0]), r4(a[1])], ["xy", r4(b[0]), r4(b[1])]], ["stroke", ["width", 0], ["type", "default"]]]; }
export function junctionNode(p: Pt): SNode { return ["junction", ["at", r4(p[0]), r4(p[1])], ["diameter", 0], ["color", 0, 0, 0, 0]]; }
export function noConnectNode(p: Pt): SNode { return ["no_connect", ["at", r4(p[0]), r4(p[1])]]; }
export function busEntryNode(p: Pt, dx: number, dy: number): SNode { return ["bus_entry", ["at", r4(p[0]), r4(p[1])], ["size", dx, dy], ["stroke", ["width", 0], ["type", "default"]]]; }
export function labelJustify(kind: string, rot: number): SNode {
  const right = rot === 180 || rot === 270;
  return kind === "label" || kind === "text" ? ["justify", right ? "right" : "left", "bottom"] : ["justify", right ? "right" : "left"];
}
export function labelNode(kind: string, text: string, p: Pt, rot: number): SNode {
  rot = ((Math.round(rot || 0) % 360) + 360) % 360;
  const at: SNode = ["at", r4(p[0]), r4(p[1]), rot];
  if (kind === "label") return ["label", text, at, ["effects", fontNode(1.27), labelJustify(kind, rot)]];
  if (kind === "text") return ["text", text, ["exclude_from_sim", "no"], at, ["effects", fontNode(1.27), labelJustify(kind, rot)]];
  const n: SNode = [kind, text, ["shape", "input"], at];
  if (kind === "global_label") n.push(["fields_autoplaced", "yes"]);
  n.push(["effects", fontNode(1.27), labelJustify(kind, rot)], ["uuid", K.newUuid()]);
  // KiCad always stores the intersheet-refs field on global labels
  if (kind === "global_label") n.push(["property", "Intersheetrefs", "${INTERSHEET_REFS}", ["at", r4(p[0]), r4(p[1]), 0], ["hide", "yes"], ["effects", fontNode(1.27), ["justify", "left"]]]);
  return n;
}
// Sheet-level graphic shapes (sch_io_kicad_sexpr_common.cpp formatRect/Circle/Arc/Poly): stroke, fill, then the uuid.
export const stroke0 = (): SNode => ["stroke", ["width", 0], ["type", "default"]];
export const fillNone = (): SNode => ["fill", ["type", "none"]];
export const xy = (p: Pt): SNode => ["xy", r4(p[0]), r4(p[1])];
export function corners(a: Pt, b: Pt): Box { return [r4(Math.min(a[0], b[0])), r4(Math.min(a[1], b[1])), r4(Math.max(a[0], b[0])), r4(Math.max(a[1], b[1]))]; }
export function rectangleNode(a: Pt, b: Pt): SNode { const [x0, y0, x1, y1] = corners(a, b); return ["rectangle", ["start", x0, y0], ["end", x1, y1], stroke0(), fillNone()]; }
/** EDA_UNIT_UTILS::FormatAngle: "{:.10g}" degrees. */
function angle10(deg: number): number { return +(+deg.toPrecision(10)).toString(); }
/** An ellipse being drawn (mm, Y down, degrees): ELLIPSE<int>'s centre, radii, rotation and arc angles. */
export interface SchEllipse { cx: number; cy: number; major: number; minor: number; rotation: number; start: number; end: number }
/**
 * ELLIPSE_GEOM_MANAGER::setBboxCorner2: the ellipse inscribed in the box from `a` to `b`, the major axis along the
 * longer side (rotation 0, or 90 for a tall box), in internal units as KiCad does.
 */
export function ellipseFromBox(a: Pt, b: Pt): SchEllipse {
  const IU = 1e4, iu = (v: number) => Math.round(v * IU), tdiv = (x: number, y: number) => Math.trunc(x / y);
  const x1 = iu(a[0]), y1 = iu(a[1]), x2 = iu(b[0]), y2 = iu(b[1]);
  const cx = tdiv(x1 + x2, 2), cy = tdiv(y1 + y2, 2), hw = tdiv(Math.abs(x2 - x1), 2), hh = tdiv(Math.abs(y2 - y1), 2), wide = hw >= hh;
  return { cx: cx / IU, cy: cy / IU, major: Math.max(wide ? hw : hh, 1) / IU, minor: Math.max(wide ? hh : hw, 1) / IU, rotation: wide ? 0 : 90, start: 0, end: 360 };
}
/** ELLIPSE::GetAngleAtPoint (degrees, Y down). */
export function ellipseAngle(e: SchEllipse, p: Pt): number {
  const a = Math.max(1e-4, e.major), b = Math.max(1e-4, e.minor), r = e.rotation * Math.PI / 180, dx = p[0] - e.cx, dy = p[1] - e.cy;
  return Math.atan2((-dx * Math.sin(r) + dy * Math.cos(r)) / b, (dx * Math.cos(r) + dy * Math.sin(r)) / a) * 180 / Math.PI;
}
/** ELLIPSE_GEOM_MANAGER::setStartAngle / setEndAngle: the end after the start, wrapped by 360. */
export function ellipseArcAngles(e: SchEllipse, s: Pt, t?: Pt): { start: number; end: number } {
  const start = ellipseAngle(e, s); if (!t) return { start, end: start + 360 };
  let end = ellipseAngle(e, t); while (end <= start) end += 360; return { start, end };
}
/** formatEllipse / formatEllipseArc on a sheet: centre, radii, rotation (and the arc's angles), stroke, fill. */
export function ellipseNode(e: SchEllipse, arc: boolean): SNode {
  return [arc ? "ellipse_arc" : "ellipse", ["center", r4(e.cx), r4(e.cy)], ["major_radius", r4(e.major)], ["minor_radius", r4(e.minor)], ["rotation_angle", angle10(e.rotation)],
    ...(arc ? [["start_angle", angle10(e.start)], ["end_angle", angle10(e.end)]] as SNode[] : []), stroke0(), fillNone()];
}
export function circleNode(c: Pt, r: number): SNode { return ["circle", ["center", r4(c[0]), r4(c[1])], ["radius", r4(r)], stroke0(), fillNone()]; }
export function arcNode(a: Pt, m: Pt, b: Pt): SNode { return ["arc", ["start", r4(a[0]), r4(a[1])], ["mid", r4(m[0]), r4(m[1])], ["end", r4(b[0]), r4(b[1])], stroke0(), fillNone()]; }
export function polylineNode(pts: Pt[]): SNode { return ["polyline", ["pts", ...pts.map(xy)], stroke0(), fillNone()]; }
// SCH_TEXTBOX: (at) is the top-left corner, (size) the extent; margins default to stroke/2 + 0.75 × text size.
export const TEXTBOX_MARGIN = r4(1.27 * 0.75);
export function textBoxNode(text: string, a: Pt, b: Pt): SNode {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["text_box", text, ["exclude_from_sim", "no"], ["at", x0, y0, 0], ["size", r4(x1 - x0), r4(y1 - y0)], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN],
    stroke0(), fillNone(), ["effects", fontNode(1.27), ["justify", "left", "top"]]];
}
// Hierarchical sheet (sch_io_kicad_sexpr.cpp saveSheet): flags, 6 mil solid border, transparent fill, uuid,
// then the Sheetname / Sheetfile fields where SCH_SHEET::AutoplaceFields puts them for a horizontal sheet:
// margin = round(border/2) + 4 IU + text size × 0.5 (name, above) or × 0.4 (file, below).
export const SHEET_BORDER = 0.1524, SHEET_NAME_OFF = r4(SHEET_BORDER / 2 + 0.000004 + 1.27 * 0.5), SHEET_FILE_OFF = r4(SHEET_BORDER / 2 + 0.000004 + 1.27 * 0.4);
/**
 * SCH_DRAWING_TOOLS::sizeSheet: the sheet keeps its first corner and grows toward the cursor only, at least
 * MIN_SHEET_WIDTH x MIN_SHEET_HEIGHT (500 x 150 mil), its far corner on the nearest grid point but never rounded
 * inside the minimum.
 */
export function sheetCorner(p0: Pt, cur: Pt, grid: number): Pt {
  const g = grid > 0 ? grid : 1.27, minW = 12.7, minH = 3.81;
  const w = Math.max(cur[0] - p0[0], minW), h = Math.max(cur[1] - p0[1], minH);
  let gx = Math.round((p0[0] + w) / g) * g, gy = Math.round((p0[1] + h) / g) * g;
  if (gx - p0[0] < minW - 1e-9) gx += g;
  if (gy - p0[1] < minH - 1e-9) gy += g;
  return [r4(gx), r4(gy)];
}
export function sheetNode(a: Pt, b: Pt, name: string, file: string): SNode {
  const [x0, y0, x1, y1] = corners(a, b);
  return ["sheet", ["at", x0, y0], ["size", r4(x1 - x0), r4(y1 - y0)], ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"], ["fields_autoplaced", "yes"],
    ["stroke", ["width", SHEET_BORDER], ["type", "solid"]], ["fill", ["color", 0, 0, 0, 0]], ["uuid", K.newUuid()],
    ["property", "Sheetname", name, ["at", x0, r4(y0 - SHEET_NAME_OFF), 0], ["effects", fontNode(1.27), ["justify", "left", "bottom"]]],
    ["property", "Sheetfile", file, ["at", x0, r4(y1 + SHEET_FILE_OFF), 0], ["effects", fontNode(1.27), ["justify", "left", "top"]]]];
}
// Sheet pin on one side of the sheet: SCH_SHEET_PIN::SetSide picks the spin style (left edge reads
// rightwards = justify left, right edge leftwards = justify right, top like right, bottom like left)
// and getSheetPinAngle the stored angle (right 0, top 90, left 180, bottom 270).
export const PIN_SIDE: Record<string, [number, string]> = { right: [0, "right"], top: [90, "right"], left: [180, "left"], bottom: [270, "left"] };
export function sheetPinNode(name: string, p: Pt, side: string, textSize = 1.27): SNode {
  const [rot, just] = PIN_SIDE[side] || PIN_SIDE.left;
  return ["pin", name, "input", ["at", r4(p[0]), r4(p[1]), rot], ["uuid", K.newUuid()], ["effects", fontNode(textSize), ["justify", just]]];
}
// Table (saveTable): border and separator strokes, column widths, row heights, uuid, then the cells as
// SCH_TABLECELLs (saveTextBox without a stroke).  Cells are the corner box split evenly, rounded to the
// grid with KiCad's 5 × 2 grid-step minimum (SCH_DRAWING_TOOLS::DrawTable).
export function tableNode(a: Pt, b: Pt, rows: number, cols: number, grid: number): SNode {
  const [x0, y0, x1, y1] = corners(a, b); grid = grid > 0 ? grid : 1.27; rows = Math.max(1, rows | 0); cols = Math.max(1, cols | 0);
  const cw = r4(Math.max(5 * grid, Math.round((x1 - x0) / cols / grid) * grid)), ch = r4(Math.max(2 * grid, Math.round((y1 - y0) / rows / grid) * grid));
  return tableGridNode([x0, y0], rows, cols, cw, ch);
}
/** SCH_DRAWING_TOOLS::DrawTable's sizing while the cursor moves: the table grows right and down from the first
 *  click, one column per 15 and one row per 2 default text heights of drag (at least one of each), cells at least
 *  5 x 2 grid steps and rounded to the grid.  Integer schematic IU (100 nm) like KiCad, so the cuts land alike.
 *  `textSize` is the schematic's m_DefaultTextSize (Schematic Setup > Formatting), 1.27 mm when not given. */
export const DEFAULT_TEXT_SIZE = 1.27;
export function drawTableSize(origin: Pt, cur: Pt, grid: number, textSize = DEFAULT_TEXT_SIZE): { rows: number; cols: number; cw: number; ch: number } {
  const IU = 10000, iu = (v: number) => Math.round(v * IU), g = iu(grid > 0 ? grid : 1.27), fs = Math.max(1, iu(textSize > 0 ? textSize : DEFAULT_TEXT_SIZE));
  const dx = iu(cur[0]) - iu(origin[0]), dy = iu(cur[1]) - iu(origin[1]);
  const cols = Math.max(1, Math.trunc(dx / (fs * 15))), rows = Math.max(1, Math.trunc(dy / (fs * 2)));
  let cw = Math.max(g * 5, Math.trunc(dx / cols)), ch = Math.max(g * 2, Math.trunc(dy / rows));
  cw = Math.round(cw / g) * g; ch = Math.round(ch / g) * g;
  return { rows, cols, cw: r4(cw / IU), ch: r4(ch / IU) };
}
/** The new table; each cell's text size is the default text size (cell->SetTextSize( m_DefaultTextSize )). */
export function drawTableNode(origin: Pt, cur: Pt, grid: number, textSize = DEFAULT_TEXT_SIZE): SNode {
  const z = drawTableSize(origin, cur, grid, textSize);
  return tableGridNode(origin, z.rows, z.cols, z.cw, z.ch, textSize > 0 ? textSize : DEFAULT_TEXT_SIZE);
}
/** The preview of the table being drawn: its outline and the row / column lines, as segments. */
export function drawTableLines(origin: Pt, cur: Pt, grid: number, textSize = DEFAULT_TEXT_SIZE): number[][] {
  const z = drawTableSize(origin, cur, grid, textSize), [x0, y0] = origin, x1 = x0 + z.cols * z.cw, y1 = y0 + z.rows * z.ch, out: number[][] = [];
  for (let r = 0; r <= z.rows; r++) out.push([x0, y0 + r * z.ch, x1, y0 + r * z.ch]);
  for (let c = 0; c <= z.cols; c++) out.push([x0 + c * z.cw, y0, x0 + c * z.cw, y1]);
  return out;
}
function tableGridNode(o: Pt, rows: number, cols: number, cw: number, ch: number, textSize = DEFAULT_TEXT_SIZE): SNode {
  const [x0, y0] = o;
  const cells: SNode[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push(["table_cell", "", ["exclude_from_sim", "no"], ["at", r4(x0 + c * cw), r4(y0 + r * ch), 0], ["size", cw, ch],
    ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN], ["span", 1, 1], fillNone(), ["effects", fontNode(r4(textSize)), ["justify", "left", "top"]], ["uuid", K.newUuid()]]);
  return ["table", ["column_count", cols], ["border", ["external", "yes"], ["header", "yes"], stroke0()], ["separators", ["rows", "yes"], ["cols", "yes"], stroke0()],
    ["column_widths", ...Array(cols).fill(cw)], ["row_heights", ...Array(rows).fill(ch)], ["uuid", K.newUuid()], ["cells", ...cells]];
}
// formatBezier: start, control 1, control 2, end.
export function bezierNode(p0: Pt, c1: Pt, c2: Pt, p1: Pt): SNode { return ["bezier", ["pts", xy(p0), xy(c1), xy(c2), xy(p1)], stroke0(), fillNone()]; }
// A polygon is an open SCH_SHAPE polyline closed by hand: the drawing tool ends on the first point,
// so the file repeats it (SCH_SHAPE::EndEdit keeps the outline open).
export function polygonNode(pts: Pt[]): SNode { return ["polyline", ["pts", ...pts.map(xy), xy(pts[0])], stroke0(), fillNone()]; }
// saveRuleArea: the exclude flags, then the closed polyline (dashed, no repeat) carrying the uuid.
export function ruleAreaNode(pts: Pt[]): SNode {
  return ["rule_area", ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"],
    ["polyline", ["pts", ...pts.map(xy)], ["stroke", ["width", 0], ["type", "dash"]], fillNone(), ["uuid", K.newUuid()]]];
}
// saveBitmap: (at) is the image centre; (scale) is only written when it is not 1; the PNG/JPEG bytes
// follow base64-encoded in 76-character lines (KICAD_FORMAT::FormatStreamData).
export const IMAGE_LINE = 76, IMAGE_PPI = 300;                     // BITMAP_BASE's default resolution
export function imageNode(p: Pt, base64: string): SNode {
  const chunks: string[] = []; for (let i = 0; i < base64.length; i += IMAGE_LINE) chunks.push(base64.slice(i, i + IMAGE_LINE));
  return ["image", ["at", r4(p[0]), r4(p[1])], ["uuid", K.newUuid()], ["data", ...chunks]];
}
export function imageData(node: SNode) { const d = kid(node, "data"); return d ? d.slice(1).map(str).join("") : ""; }
// Pixel size from a PNG IHDR or the first JPEG SOF marker; null for anything else.
export function imageSize(b: Uint8Array | null): Pt | null {
  if (!b || b.length < 4) return null;
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b.length >= 24) return [u32(16), u32(20)];
  if (b[0] === 0xFF && b[1] === 0xD8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1]; if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}
// Node's Buffer: a free variable that only exists under node (the tests); the browser takes btoa / atob.
declare const Buffer: { from(data: Uint8Array): { toString(enc: "base64"): string }; from(data: string, enc: "base64"): Uint8Array } | undefined;
export function bytesToBase64(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // fromCharCode.apply takes any array-like at run time; its typing asks for number[]
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}
export function base64ToBytes(b64: string) {
  try { if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64")); const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  catch (e) { return null; }
}
// Directive label (netclass flag) with its Netclass field where SCH_DIRECTIVE_LABEL::AutoplaceFields puts it
// for the spin style of the angle: symbol size 20 mil + text offset (0.15 × size) beside the pin-length flag.
export const FLAG_LENGTH = 2.54, FLAG_SYMBOL = 0.508, FLAG_MARGIN = r4(0.15 * 1.27);
export function flagFieldAt(p: Pt, rot: number): SNode {
  const off = rot === 180 ? [FLAG_SYMBOL + FLAG_MARGIN, FLAG_LENGTH] : rot === 90 ? [-FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)]
    : rot === 270 ? [FLAG_LENGTH, -(FLAG_SYMBOL + FLAG_MARGIN)] : [FLAG_SYMBOL + FLAG_MARGIN, -FLAG_LENGTH];
  return ["at", r4(p[0] + off[0]), r4(p[1] + off[1]), rot === 90 || rot === 270 ? 90 : 0];
}
export function classLabelNode(name: string, p: Pt, rot: number): SNode {
  rot = ((Math.round(rot || 0) % 360) + 360) % 360;
  return ["netclass_flag", "", ["length", FLAG_LENGTH], ["shape", "round"], ["at", r4(p[0]), r4(p[1]), rot], ["fields_autoplaced", "yes"],
    ["effects", fontNode(1.27), ["justify", "left", "bottom"]], ["uuid", K.newUuid()],
    ["property", "Netclass", name, flagFieldAt(p, rot), ["effects", fontNode(1.27), ["justify", "left", "bottom"]]]];
}
export const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
export function symbolNode(doc: KDoc, libId: string, p: Pt, rot: number, mirror?: string): SNode {
  const lib = K.resolveLib(doc, libId);
  const T = tFrom(rot || 0, mirror || "");
  const tf = (lx: number, ly: number) => [r4(p[0] + T[0] * lx + T[1] * ly), r4(p[1] + T[2] * lx + T[3] * ly)];
  const n: SNode = ["symbol", ["lib_id", libId], ["at", r4(p[0]), r4(p[1]), rot || 0]];
  if (mirror) n.push(["mirror", mirror]);
  n.push(["unit", 1], ["body_style", 1], ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"], ["uuid", K.newUuid()]);
  // KiCad 10 libraries carry (property private "Name" "Value" …) notes; they stay in the library copy
  // (as a field named "private" on the placed symbol they stop desktop KiCad loading the sheet)
  const isPrivate = (lp: SNode) => str(lp[1]) === "private" && lp.length > 3 && !Array.isArray(lp[2]) && !Array.isArray(lp[3]);
  const libProps = lib ? kids(lib, "property").filter((lp) => !str(lp[1]).startsWith("ki_") && !isPrivate(lp)) : [];
  const fromLib = (name: string) => libProps.find((lp) => str(lp[1]) === name);
  const prop = (name: string, lp: SNode | undefined): SNode => {
    let val = lp ? str(lp[2]) : (name === "Value" ? libId.split(":").pop() as string : name === "Datasheet" ? "~" : "");
    if (name === "Reference") val = (val || "U") + "?";                       // the desktop annotates
    else if (name === "Value" && !val) val = libId.split(":").pop() as string;
    const [lx, ly, lr] = lp ? atOf(lp) : [0, 0, 0]; const [px, py] = tf(lx, ly);
    const out: SNode = ["property", name, val, ["at", px, py, lr || 0]];
    const h = lp && kid(lp, "hide");
    const hidden = lp ? (h ? str(h[1]) !== "no" : lp.includes("hide")) : name !== "Reference" && name !== "Value";
    if (hidden) out.push(["hide", "yes"]);
    const ef = lp && kid(lp, "effects"); out.push(ef ? deep(ef) : ["effects", fontNode(1.27)]);
    return out;
  };
  for (const name of MANDATORY) n.push(prop(name, fromLib(name)));
  for (const lp of libProps) if (!MANDATORY.includes(str(lp[1]))) n.push(prop(str(lp[1]), lp));
  if (lib) for (const sub of kids(lib, "symbol")) for (const pin of kids(sub, "pin")) { const nn = kid(pin, "number"); n.push(["pin", str(nn ? nn[1] : ""), ["uuid", K.newUuid()]]); }
  return n;
}
