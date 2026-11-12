// canvas/footprint-doc.ts — a library footprint (.kicad_mod) as an editable document: the Footprint Editor's
// BOARD that holds one FOOTPRINT, whose children are what the tools select, move and edit.
//
// The footprint sits at the origin, unrotated and on the front (FOOTPRINT_EDIT_FRAME keeps it there), so every
// child's coordinates are already the ones the board tools work in.  Each owned child of (footprint …) becomes one
// top-level item of the document; the graphic tokens are aliased to the board's so the board's geometry builders,
// hit tests, draw tools, point editor and item dialogs work on them unchanged:
//
//   fp_line / fp_rect / fp_circle / fp_arc / fp_poly / fp_curve / fp_ellipse / fp_ellipse_arc  ->  gr_*
//   fp_text user "t"  ->  gr_text "t"          fp_text_box  ->  gr_text_box
//   property "Reference" … (and the old fp_text reference / value)  ->  kind "property" (a PCB_FIELD)
//   pad, zone, group, dimension, image, table, point, barcode         keep their kind
//
// Everything else of the footprint (name, version, generator, layer, descr, tags, attr, private_layers,
// net_tie_pad_groups, jumper groups, clearances, model, embedded files and any token this reader does not know)
// stays in the header node, doc.fp, verbatim.  The wire id of the header is "footprint".
//
// serializeFootprintDoc writes the file back in PCB_IO_KICAD_SEXPR::format( FOOTPRINT ) order: a document nobody
// edited comes back byte for byte; otherwise each child nobody touched is its original text, edited ones are
// written from their nodes, and the whole runs through KiCad's Prettify, so the result reads as pcbnew's own.  The
// (version …) is never changed, and a child that had no uuid gets none unless it is edited.
import { atomText, serialize } from "./export";
import { QUOTED, cloneNode, isList, kid, kids, parse, str, uuidOf } from "./sexpr";
import { prettify } from "./prettify";
import type { Doc, Item, SAtom } from "./types";

/** File token -> the board token the item carries in the editor. */
export const FP_TO_BOARD: Record<string, string> = {
  fp_line: "gr_line", fp_rect: "gr_rect", fp_circle: "gr_circle", fp_arc: "gr_arc", fp_poly: "gr_poly", fp_curve: "gr_curve",
  fp_ellipse: "gr_ellipse", fp_ellipse_arc: "gr_ellipse_arc", fp_text_box: "gr_text_box",
};
/** Board token -> the file token a footprint writes. */
export const BOARD_TO_FP: Record<string, string> = Object.fromEntries(Object.entries(FP_TO_BOARD).map(([a, b]) => [b, a]));

/** Kinds a footprint document holds as items (beside the board kinds the aliases map onto). */
export const FP_KINDS = new Set(["property", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_ellipse", "gr_ellipse_arc", "gr_text", "gr_text_box",
  "fp_text", "pad", "zone", "group", "dimension", "image", "table", "point", "barcode"]);

/** The tokens of (footprint …) that are owned children (items), as written in a file. */
const OWNED_FILE_TOKENS = new Set(["property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_ellipse", "fp_ellipse_arc",
  "pad", "zone", "group", "dimension", "image", "table", "point", "barcode"]);

/** (property ki_fp_filters "…") is a footprint attribute written as a property, not a field. */
const isFieldNode = (n: SNode): boolean => n[0] === "property" ? typeof n[2] === "string" && n[1] !== "ki_fp_filters" : n[0] === "fp_text" && (n[1] === "reference" || n[1] === "value");
export function isOwnedFileNode(n: SAtom): n is SNode {
  if (!isList(n) || typeof n[0] !== "string" || !OWNED_FILE_TOKENS.has(n[0])) return false;
  if (n[0] === "property") return isFieldNode(n);
  return true;
}

/** A file child as the item node the editor holds (aliased token; fp_text user -> gr_text). */
export function toBoardNode(n: SNode): SNode {
  const k = str(n[0]);
  if (k === "fp_text" && n[1] !== "reference" && n[1] !== "value") {
    const q = QUOTED.get(n) || 0;
    const out: SNode = ["gr_text", ...n.slice(2)];
    const nq = (q >> 2) << 1; if (nq) QUOTED.set(out, nq);
    return out;
  }
  if (FP_TO_BOARD[k]) n[0] = FP_TO_BOARD[k];
  return n;
}

/** An item node as the footprint file writes it (a copy: the document's own node keeps the board token). */
export function toFileNode(n: SNode): SNode {
  const c = cloneNode(n); const k = str(c[0]);
  if (k === "gr_text") {
    const q = QUOTED.get(c) || 0;
    const out: SNode = ["fp_text", "user", ...c.slice(1)];
    QUOTED.set(out, ((q >> 1) << 2) | 4);
    return out;
  }
  if (BOARD_TO_FP[k]) c[0] = BOARD_TO_FP[k];
  return c;
}

/** The item kind of a file child. */
export function fpItemKind(n: SNode): string {
  const k = str(n[0]);
  if (k === "property" || (k === "fp_text" && (n[1] === "reference" || n[1] === "value"))) return "property";
  return k;
}

/** The field name of a property / old fp_text reference|value node. */
export function fieldName(n: SNode): string {
  if (n[0] === "fp_text") return n[1] === "reference" ? "Reference" : n[1] === "value" ? "Value" : str(n[1]);
  return str(n[1]);
}
/** The field's text. */
export function fieldText(n: SNode): string { return str(n[2]); }

// ---------------------------------------------------------------- spans of the source text
/** [start, end) of each element (atom or list) directly inside the root list of `text`. */
export function childSpans(text: string): [number, number][] {
  const out: [number, number][] = []; const n = text.length;
  let i = text.indexOf("("); if (i < 0) return out; i++;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  for (;;) {
    while (i < n && ws(text[i])) i++;
    if (i >= n || text[i] === ")") break;
    const st = i;
    if (text[i] === "(") {
      let depth = 0, inStr = false;
      for (; i < n; i++) {
        const c = text[i];
        if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
      }
    } else if (text[i] === '"') {
      i++; while (i < n && text[i] !== '"') { if (text[i] === "\\") i++; i++; } i++;
    } else { while (i < n && !ws(text[i]) && text[i] !== "(" && text[i] !== ")") i++; }
    out.push([st, i]);
  }
  return out;
}

// ---------------------------------------------------------------- ids
/** FNV-1a over a string, as 32-bit unsigned. */
function fnv(s: string, seed = 0x811c9dc5): number { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
/**
 * An id for a child the file gave no uuid: every client derives the same one from the same snapshot (position and
 * text), so an op for it addresses the same child everywhere.  It is a valid uuid, and it is only ever written into
 * the file once the child is edited (an edited child carries its id, as KiCad gives every child one).
 */
export function derivedUuid(index: number, text: string): string {
  const a = fnv(text), b = fnv(text, a ^ 0x9e3779b9), c = fnv(String(index) + ":" + text, b);
  const hex = (v: number, w: number) => (v >>> 0).toString(16).padStart(8, "0").slice(0, w);
  return `${hex(a, 8)}-${hex(b, 4)}-4${hex(b >>> 16, 3)}-${(8 | (c & 3)).toString(16)}${hex(c, 3)}-${hex(fnv(text, c), 8)}${hex(c >>> 8, 4)}`;
}

// ---------------------------------------------------------------- the document
/** The footprint-editor state a pcb Doc carries. */
export interface FpDocState {
  /** the header: (footprint "name" …) with the owned children taken out */
  fp: SNode;
  /** the file as read (a document nobody edited is written back as exactly this) */
  source: string;
  /** source text of each header child (by node identity) and of each item (by id) */
  headerSrc: Map<SNode, string>;
  itemSrc: Map<string, { text: string; sig: string }>;
  /** serialize(header) as read: the header counts as edited once it differs */
  headerSig: string;
  /** ids in file order */
  order: string[];
}

type FpDoc = Doc;

/** The layers the Footprint Editor shows (FOOTPRINT_EDIT_FRAME::updateEnabledLayers with EXPAND_INNER_LAYERS). */
export const FP_EDITOR_LAYERS: [string, string][] = [
  ["F.Cu", "signal"], ["In1.Cu", "signal"], ["B.Cu", "signal"],
  ["B.Adhes", "user"], ["F.Adhes", "user"], ["B.Paste", "user"], ["F.Paste", "user"], ["B.SilkS", "user"], ["F.SilkS", "user"], ["B.Mask", "user"], ["F.Mask", "user"],
  ["Dwgs.User", "user"], ["Cmts.User", "user"], ["Eco1.User", "user"], ["Eco2.User", "user"], ["Edge.Cuts", "user"], ["Margin", "user"],
  ["B.CrtYd", "user"], ["F.CrtYd", "user"], ["B.Fab", "user"], ["F.Fab", "user"],
  ["User.1", "user"], ["User.2", "user"], ["User.3", "user"], ["User.4", "user"],
];
const LAYER_IDS: Record<string, number> = { "F.Cu": 0, "B.Cu": 2, "In1.Cu": 4, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15,
  "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "F.CrtYd": 31, "B.CrtYd": 29, "F.Fab": 35, "B.Fab": 33,
  "User.1": 39, "User.2": 41, "User.3": 43, "User.4": 45 };

/**
 * Fill `doc` (a fresh pcb Doc) from a .kicad_mod tree.  `addItem` is the document's own (doc.ts), passed in so this
 * module does not import doc.ts.
 */
export function loadFootprintDoc(doc: Doc, tree: SNode, text: string, addItem: (doc: Doc, node: SNode, id?: string) => Item | null): void {
  const d = doc as FpDoc;
  d.fpEditor = true;
  const spans = childSpans(text);
  const header: SNode = [tree[0], tree[1]];
  const hq = QUOTED.get(tree); if (hq) QUOTED.set(header, hq & 3);
  const st: FpDocState = { fp: header, source: text, headerSrc: new Map(), itemSrc: new Map(), headerSig: "", order: [] };
  d.fpState = st;
  for (const [name, type] of FP_EDITOR_LAYERS) { d.layers.set(name, { id: LAYER_IDS[name] ?? 0, type, userName: "" }); if (type === "signal") d.copper.push(name); }
  for (let j = 2; j < tree.length; j++) {
    const c = tree[j]; const span = spans[j]; const src = span ? text.slice(span[0], span[1]) : serialize(c);
    if (isList(c) && c[0] === "version") d.version = Number(c[1]) || 0;
    if (!isOwnedFileNode(c)) { header.push(c); if (isList(c)) st.headerSrc.set(c, src); continue; }
    const node = toBoardNode(c);
    const id = uuidOf(node) || derivedUuid(j, src);
    const it = addItem(d, node, id);
    if (!it) continue;
    st.itemSrc.set(it.id, { text: src, sig: serialize(toFileNode(node)) });
    st.order.push(it.id);
  }
  st.headerSig = serialize(header);
}

/** Replace the header from a wire change's (footprint …) text. */
export function applyFootprintHeader(doc: Doc, sexpr: string): boolean {
  const d = doc as FpDoc; if (!d.fpState) return false;
  // the fragment may come wrapped (kicad_pcb … (footprint …)) or bare
  let node = parse(sexpr); if (!node) return false;
  if (node[0] === "kicad_pcb") { const f = kid(node, "footprint"); if (!f) return false; node = f; }
  if (node[0] !== "footprint" && node[0] !== "module") return false;
  const header: SNode = [node[0], node[1]]; const q = QUOTED.get(node); if (q) QUOTED.set(header, q & 3);
  for (const c of node.slice(2)) if (!isOwnedFileNode(c)) header.push(c);
  d.fpState.fp = header;
  const v = kid(header, "version"); if (v) d.version = Number(v[1]) || d.version;
  return true;
}

/** The header as the wire carries it: (footprint "name" …header children…). */
export function footprintHeaderSexpr(doc: Doc): string { const d = doc as FpDoc; return d.fpState ? serialize(d.fpState.fp) : ""; }

/** The footprint's name (its FPID item name). */
export function footprintName(doc: Doc): string { const d = doc as FpDoc; return d.fpState ? str(d.fpState.fp[1]) : ""; }

// format( FOOTPRINT ) order, header tokens: anything unknown keeps the place of the known token before it.
const HEADER_RANK: Record<string, number> = {
  version: 0, generator: 1, generator_version: 2, locked: 3, placed: 4, layer: 5, uuid: 6, tstamp: 6, at: 7, transform: 7, descr: 8, tags: 9, height: 10,
  // 11: the fields
  component_classes: 12, property: 13, path: 14, sheetname: 15, sheetfile: 16, units: 17, solder_mask_margin: 18, solder_paste_margin: 19, solder_paste_margin_ratio: 20, solder_paste_ratio: 20,
  clearance: 21, zone_connect: 22, thermal_width: 22, thermal_gap: 22, attr: 23, stackup: 24, private_layers: 25, net_tie_pad_groups: 26, duplicate_pad_numbers_are_jumpers: 27, jumper_pad_groups: 28,
  // 30-35: drawings, points, pads, zones, groups, constraints
  variant: 40, embedded_fonts: 41, embedded_files: 42, model: 43,
};
const RANK_FIELDS = 11;
function itemRank(kind: string): number {
  if (kind === "property") return RANK_FIELDS;
  if (kind === "point") return 31;
  if (kind === "pad") return 32;
  if (kind === "zone") return 33;
  if (kind === "group") return 34;
  return 30;   // shapes, texts, text boxes, dimensions, tables, images, barcodes: FOOTPRINT::GraphicalItems
}

/** Has anything of the footprint changed since it was read? */
export function footprintModified(doc: Doc): boolean {
  const d = doc as FpDoc; const st = d.fpState; if (!st) return false;
  if (serialize(st.fp) !== st.headerSig) return true;
  let n = 0;
  for (const it of d.items.values()) { const s = st.itemSrc.get(it.id); if (!s || s.sig !== serialize(toFileNode(it.node))) return true; n++; }
  return n !== st.itemSrc.size;
}

/** The .kicad_mod text of the document. */
export function serializeFootprintDoc(doc: Doc): string {
  const d = doc as FpDoc; const st = d.fpState;
  if (!st) throw new Error("not a footprint document");
  if (!footprintModified(doc)) return st.source;
  const parts: { rank: number; seq: number; text: string }[] = [];
  let seq = 0, lastRank = 0;
  for (const c of st.fp.slice(2)) {
    const head = isList(c) ? str(c[0]) : str(c);
    const r = HEADER_RANK[head]; if (r !== undefined) lastRank = r;
    const text = isList(c) ? (st.headerSrc.get(c) || serialize(c)) : atomText(c, false);
    parts.push({ rank: r !== undefined ? r : lastRank, seq: seq++, text });
  }
  // items: file order first, then the ones added since in the order they arrived
  const pos = new Map(st.order.map((id, i) => [id, i]));
  const items = [...d.items.values()].sort((a, b) => (pos.has(a.id) ? pos.get(a.id)! : 1e9) - (pos.has(b.id) ? pos.get(b.id)! : 1e9));
  for (const it of items) {
    const file = toFileNode(it.node); const s = st.itemSrc.get(it.id); const sig = serialize(file);
    parts.push({ rank: itemRank(it.kind), seq: seq++, text: s && s.sig === sig ? s.text : sig });
  }
  parts.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  const q = QUOTED.get(st.fp) || 0;
  const head = "(" + str(st.fp[0]) + " " + atomText(st.fp[1], st.fp[0] === "footprint" || (q & 2) === 2);   // KiCad quotes the name; a (module …) kept it bare
  return prettify(head + (parts.length ? " " + parts.map((p) => p.text).join(" ") : "") + ")");
}

/** After a save: what was written is the new baseline (no '*'). */
export function markFootprintSaved(doc: Doc, text: string): void {
  const d = doc as FpDoc; const st = d.fpState; if (!st) return;
  const tree = parse(text); if (!tree) return;
  const spans = childSpans(text);
  st.source = text; st.headerSrc = new Map(); st.itemSrc = new Map(); st.order = [];
  // re-key the sources by the parsed children: the header nodes are matched by their text, the items by id
  const headerBySig = new Map<string, SNode[]>();
  for (const c of st.fp.slice(2)) if (isList(c)) { const k = serialize(c); const l = headerBySig.get(k) || []; l.push(c); headerBySig.set(k, l); }
  const itemIdsBySig = new Map<string, string[]>();
  for (const it of d.items.values()) { const k = serialize(toFileNode(it.node)); const l = itemIdsBySig.get(k) || []; l.push(it.id); itemIdsBySig.set(k, l); }
  for (let j = 2; j < tree.length; j++) {
    const c = tree[j]; const span = spans[j]; if (!span || !isList(c)) continue;
    const src = text.slice(span[0], span[1]); const sig = serialize(c);
    if (!isOwnedFileNode(c)) { const l = headerBySig.get(sig); const h = l && l.shift(); if (h) st.headerSrc.set(h, src); continue; }
    const l = itemIdsBySig.get(sig); const id = l && l.shift(); if (!id) continue;
    st.itemSrc.set(id, { text: src, sig }); st.order.push(id);
  }
  st.headerSig = serialize(st.fp);
}

/** Kinds the footprint keeps as fields, for the tools: Reference and Value cannot be deleted (FOOTPRINT::Remove refuses). */
export function isMandatoryField(it: Pick<Item, "kind" | "node">): boolean { return it.kind === "property" && (fieldName(it.node) === "Reference" || fieldName(it.node) === "Value"); }

/** The fields of the footprint by name (Reference, Value, …). */
export function footprintFields(doc: Doc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of doc.items.values()) if (it.kind === "property") out[fieldName(it.node)] = fieldText(it.node);
  return out;
}

/** The whole footprint as one node at the origin (the board footprint's shape): header + every child in file form. */
export function footprintNode(doc: Doc): SNode {
  const text = serializeFootprintDoc(doc); const n = parse(text); if (!n) throw new Error("footprint does not parse");
  return n;
}

/** kids(header, key) shortcut for the dialogs. */
export function headerKids(doc: Doc, key: string): SNode[] { const d = doc as FpDoc; return d.fpState ? kids(d.fpState.fp, key) : []; }

/** What KiCadCanvas.footprintDoc publishes to the editor and the tools (one sexpr module: the quoting marks live there). */
export const footprintDocApi = { serializeFootprintDoc, footprintModified, markFootprintSaved, footprintHeaderSexpr, footprintName, footprintFields, footprintNode,
  toFileNode, toBoardNode, fpItemKind, fieldName, fieldText, isMandatoryField, isOwnedFileNode, headerKids, derivedUuid, applyFootprintHeader, prettify, FP_EDITOR_LAYERS, FP_TO_BOARD, BOARD_TO_FP };
