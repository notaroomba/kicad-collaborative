// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { addItem } from "./doc";
import { serializeItem } from "./export";
import { buildGeom } from "./geom";
import { resolveLib, symbolTransform } from "./geom-sch";
import { setAt, setPts } from "./ops";
import { atOf, kid, kids, num, ptsOf, str, uuidOf } from "./sexpr";
import { shiftTable } from "./tables-images";
import { textWidth } from "./text";
// ---------------------------------------------------------------- editing helpers (for the tools layer)
/** Move an item's anchor to (x, y) mm; symbols carry their fields along.  Returns the wire-format change. */
export function moveItem(doc, item, x, y, IU) {
  const [ox, oy] = item.kind === "table" ? [item.x || 0, item.y || 0] : atOf(item.node);
  const dx = x - ox, dy = y - oy;
  if (doc.type === "sch" && (item.kind === "wire" || item.kind === "bus" || item.kind === "polyline")) {
    const p = ptsOf(item.node).map(([px, py]) => [px + dx, py + dy]); setPts(item.node, p); buildGeom(doc, item);
    return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) };
  }
  if (item.kind === "table") {   // a table's position is its first cell's: every cell moves
    shiftTable(item.node, dx, dy); buildGeom(doc, item);
    return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) };
  }
  setAt(item.node, x, y);
  if (doc.type === "sch" && item.kind === "symbol") for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
  buildGeom(doc, item);
  return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), properties: [
    { name: "Position X", before: { type: "int", v: Math.round(ox * IU) }, after: { type: "int", v: Math.round(x * IU) } },
    { name: "Position Y", before: { type: "int", v: Math.round(oy * IU) }, after: { type: "int", v: Math.round(y * IU) } }] };
}

/** Whole-item replace change for an item whose node was edited in place. */
export function replaceChange(doc, item) { buildGeom(doc, item); return { id: item.id, kind: "MODIFIED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) }; }

export function addChange(doc, item) { return { id: item.id, kind: "ADDED", typeName: typeNameOf(item), sexpr: serializeItem(doc, item) }; }

export function removeChange(item) { return { id: item.id, kind: "REMOVED", typeName: typeNameOf(item), properties: [] }; }

export const SCH_TYPE_NAMES = { symbol: "SCH_SYMBOL", wire: "SCH_LINE", bus: "SCH_LINE", polyline: "SCH_LINE", junction: "SCH_JUNCTION", label: "SCH_LABEL", global_label: "SCH_GLOBALLABEL", hierarchical_label: "SCH_HIERLABEL", no_connect: "SCH_NO_CONNECT", sheet: "SCH_SHEET", text: "SCH_TEXT", text_box: "SCH_TEXTBOX", bus_entry: "SCH_BUS_WIRE_ENTRY", rectangle: "SCH_SHAPE", circle: "SCH_SHAPE", arc: "SCH_SHAPE", netclass_flag: "SCH_DIRECTIVE_LABEL", directive_label: "SCH_DIRECTIVE_LABEL", table: "SCH_TABLE", image: "SCH_BITMAP" };

export const PCB_TYPE_NAMES = { footprint: "FOOTPRINT", segment: "PCB_TRACK", arc: "PCB_ARC", via: "PCB_VIA", zone: "ZONE", gr_line: "PCB_SHAPE", gr_rect: "PCB_SHAPE", gr_circle: "PCB_SHAPE", gr_arc: "PCB_SHAPE", gr_poly: "PCB_SHAPE", gr_text: "PCB_TEXT", gr_text_box: "PCB_TEXTBOX", table: "PCB_TABLE", image: "PCB_REFERENCE_IMAGE" };

export function typeNameOf(item) {
  // kinds shared by both editors (arc, table, image) resolve through the item's document type
  const first = item.docType === "pcb" ? PCB_TYPE_NAMES : SCH_TYPE_NAMES, second = first === SCH_TYPE_NAMES ? PCB_TYPE_NAMES : SCH_TYPE_NAMES;
  return first[item.kind] || second[item.kind] || item.kind.toUpperCase();
}

/** Screen-space connection points of a symbol's pins (mm). */
export function pinPoints(doc, item) {
  const out = [];
  if (item.kind !== "symbol") return out;
  const n = item.node; const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]); const lib = resolveLib(doc, libId) || resolveLib(doc, str((kid(n, "lib_id") || [])[1])); if (!lib) return out;
  const [ax, ay, rot] = atOf(n); const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1;
  const T = symbolTransform(rot, mirror);
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0; if (u !== 0 && u !== unit) continue;
    for (const g of kids(sub, "pin")) { const [px, py] = atOf(g); out.push({ x: ax + T[0] * px + T[1] * py, y: ay + T[2] * px + T[3] * py, number: str((kid(g, "number") || [])[1]), name: str((kid(g, "name") || [])[1]) }); }
  }
  return out;
}

/** Wires/buses with an endpoint within tol of (x, y): [{item, index}] */
export function wireEndsAt(doc, x, y, tol) {
  const out = []; tol = tol || 0.01;
  for (const it of doc.items.values()) {
    if (it.kind !== "wire" && it.kind !== "bus") continue;
    const p = ptsOf(it.node);
    p.forEach((pt, i) => { if (Math.abs(pt[0] - x) <= tol && Math.abs(pt[1] - y) <= tol) out.push({ item: it, index: i }); });
  }
  return out;
}

/** Screen-space quads of an item's field texts (symbol / footprint properties): [{name, pts:[[x,y]×4], geom}] */
export function fieldBoxes(item, hidden) {
  const out = [];
  for (const g of item.geom || []) {
    if (g.t !== "text" || !g.field) continue;
    if (hidden && g.layer && hidden.has(g.layer)) continue;             // a field on a hidden layer is not on screen
    const w = textWidth(g.text || "", g.size, g.w), h = g.size, pad = 0.18 * g.size;
    const lx0 = (g.h === "left" ? 0 : g.h === "right" ? -w : -w / 2) - pad, lx1 = lx0 + w + 2 * pad;
    const ly0 = (g.v === "top" ? 0 : g.v === "bottom" ? -h : -h / 2) - pad, ly1 = ly0 + h + 2 * pad;
    const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = g.mirror ? -1 : 1;
    const P = (lx, ly) => [g.x + (lx * mx) * c - ly * sn, g.y + (lx * mx) * sn + ly * c];
    out.push({ name: g.field, pts: [P(lx0, ly0), P(lx1, ly0), P(lx1, ly1), P(lx0, ly1)], geom: g });
  }
  return out;
}

export function pointInQuad(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The field of any symbol / footprint under (x, y) mm, or null: {item, name, pts} */
export function fieldAt(doc, x, y, hidden) {
  let best = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "footprint") continue;
    const b = it.bbox; if (b && (x < b[0] - 5 || x > b[2] + 5 || y < b[1] - 5 || y > b[3] + 5)) continue;
    for (const f of fieldBoxes(it, hidden)) if (pointInQuad(f.pts, x, y)) { const area = Math.abs((f.pts[1][0] - f.pts[0][0]) * (f.pts[3][1] - f.pts[0][1]) - (f.pts[3][0] - f.pts[0][0]) * (f.pts[1][1] - f.pts[0][1])); if (!best || area < best.area) best = { item: it, name: f.name, pts: f.pts, area }; }
  }
  return best;
}

export function newUuid() { return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }); }

/** Build a fresh item node of a kind and add it to the document. */
export function createItem(doc, node) { if (!uuidOf(node)) node.push(["uuid", newUuid()]); return addItem(doc, node); }
