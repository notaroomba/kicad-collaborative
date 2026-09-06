// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { buildGeom } from "./geom";
import { has, isList, kid, kids, num, parse, str, uuidOf } from "./sexpr";
// ---------------------------------------------------------------- documents
export function newDoc(type) { return { type, items: new Map(), lib: new Map(), page: [297, 210], layers: new Map(), copper: [], bbox: null, nets: new Map() }; }

export function paperSize(node) {
  const name = str(node[1]);
  const sizes = { A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
    A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
    USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4] };
  let s = sizes[name] || (name === "User" ? [num(node[2], 297), num(node[3], 210)] : [297, 210]);
  if (has(node, "portrait")) s = [s[1], s[0]];
  return s.slice();
}


export function parseDoc(text, docType) {
  const tree = parse(text);
  if (!tree) throw new Error("not an s-expression document");
  const type = tree[0] === "kicad_sch" ? "sch" : tree[0] === "kicad_pcb" ? "pcb" : (docType === "kicad_sch" ? "sch" : "pcb");
  const doc = newDoc(type);
  if (type === "sch") { const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s); }
  for (let j = 1; j < tree.length; j++) {
    const node = tree[j]; if (!isList(node)) continue;
    const k = node[0];
    if (k === "paper") doc.page = paperSize(node);
    else if (type === "pcb" && k === "layers") {
      // (0 "F.Cu" signal ["user name"])
      for (const l of node.slice(1)) if (isList(l)) { const name = str(l[1]), ltype = str(l[2]); doc.layers.set(name, { id: num(l[0]), type: ltype, userName: l[3] !== undefined ? str(l[3]) : "" }); if (/\.Cu$/.test(name) && ltype !== "user") doc.copper.push(name); }
    }
    else if (k === "net") { if (type === "pcb") doc.nets.set(num(node[1], -1), str(node[2])); continue; }   // (net 3 "GND"): the board's net table
    else if (k === "lib_symbols" || k === "version" || k === "generator" || k === "generator_version" || k === "general" || k === "setup" || k === "title_block" || k === "sheet_instances" || k === "symbol_instances" || k === "embedded_fonts" || k === "embedded_files" || k === "uuid") continue;
    else addItem(doc, node);
  }
  computeBBox(doc);
  return doc;
}


export const SCH_KINDS = new Set(["symbol", "wire", "bus", "junction", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect", "sheet", "text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "bus_entry", "image", "table", "rule_area"]);

export const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated"]);


export function addItem(doc, node) {
  const k = node[0];
  if (doc.type === "sch" ? !SCH_KINDS.has(k) : !PCB_KINDS.has(k)) return null;
  let id = uuidOf(node);
  if (!id) id = "anon-" + (doc.items.size + 1) + "-" + Math.random().toString(36).slice(2, 8);
  const item = { id, kind: k, node, geom: [], bbox: null, movable: false, hiddenGeom: null, docType: doc.type };
  buildGeom(doc, item);
  doc.items.set(id, item);
  return item;
}


export function computeBBox(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (b) => { if (!b) return; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); };
  if (doc.type === "pcb") {
    // What a person means by "the board": the outline together with the copper.
    for (const it of doc.items.values()) if (it.edge || it.kind === "segment" || it.kind === "via" || it.kind === "footprint" || it.kind === "zone" || it.kind === "arc") take(it.bbox);
    if (!isFinite(x0)) for (const it of doc.items.values()) take(it.bbox);
  } else {
    x0 = 0; y0 = 0; x1 = doc.page[0]; y1 = doc.page[1];
  }
  doc.bbox = isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, doc.page[0], doc.page[1]];
}
