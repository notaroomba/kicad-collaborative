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
// serializeFootprintDoc writes the file back in PCB_IO_KICAD_SEXPR::format( FOOTPRINT ) order (the fields, then the
// drawings by cmp_drawings, the pads by cmp_pads, the zones by cmp_zones): a document nobody edited comes back byte
// for byte; otherwise each child nobody touched is its original text, edited ones are written from their nodes, and
// the whole runs through KiCad's Prettify, so the result reads as pcbnew's own.  The (version …) is never changed,
// and a child that had no uuid gets none while its content still derives its id (see derivedUuid).
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
const hex = (v: number, w: number) => (v >>> 0).toString(16).padStart(8, "0").slice(0, w);
/**
 * An id for a child the file gave no uuid.  `text` is the child's canonical form (serialize of its file node) and
 * `index` how many children with that same form came before it in the file, so every client derives the same id
 * from the same content however the file around it was reordered or edited by a Save: an op for it addresses the
 * same child everywhere, including on a client that opened a later snapshot.  The id is a valid uuid, and the file
 * only ever carries it once the child no longer derives it (it was edited, or its twins changed order).
 */
export function derivedUuid(index: number, text: string): string {
  const a = fnv(text), b = fnv(text, a ^ 0x9e3779b9), c = fnv(String(index) + ":" + text, b);
  return `${hex(a, 8)}-${hex(b, 4)}-4${hex(b >>> 16, 3)}-${(8 | (c & 3)).toString(16)}${hex(c, 3)}-${hex(fnv(text, c), 8)}${hex(c >>> 8, 4)}`;
}
/** Is `id` the id derivedUuid gives `text` at some occurrence index? (the first 13 characters depend on the text only) */
function derivesFrom(id: string, text: string): boolean {
  const a = fnv(text), b = fnv(text, a ^ 0x9e3779b9);
  if (!id.startsWith(`${hex(a, 8)}-${hex(b, 4)}-`)) return false;
  for (let k = 0; k < 64; k++) if (derivedUuid(k, text) === id) return true;
  return false;
}
/** The file node without its (uuid `id`), or null when it carries none / another one. */
function withoutUuid(file: SNode, id: string): SNode | null {
  for (let j = 1; j < file.length; j++) {
    const c = file[j];
    if (isList(c) && (c[0] === "uuid" || c[0] === "tstamp") && str(c[1]) === id) {
      const out = file.slice(0, j).concat(file.slice(j + 1)) as SNode;
      const q = QUOTED.get(file); if (q) QUOTED.set(out, (q & ((1 << j) - 1)) | ((q >>> (j + 1)) << j));
      return out;
    }
  }
  return null;
}
/**
 * The form of an item that tells whether it changed: a child whose id is derived from its content compares without
 * the (uuid …) an op gave it (an Undo that brings back an unedited child is no change, and writes no uuid).
 */
function canonical(it: Pick<Item, "id" | "node">): { file: SNode; sig: string; derived: boolean } {
  const file = toFileNode(it.node);
  const own = uuidOf(file);
  if (!own) return { file, sig: serialize(file), derived: true };
  if (own === it.id) { const bare = withoutUuid(file, it.id); if (bare) { const sig = serialize(bare); if (derivesFrom(it.id, sig)) return { file: bare, sig, derived: true }; } }
  return { file, sig: serialize(file), derived: false };
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
  const seen = new Map<string, number>();
  for (let j = 2; j < tree.length; j++) {
    const c = tree[j]; const span = spans[j]; const src = span ? text.slice(span[0], span[1]) : serialize(c);
    if (isList(c) && c[0] === "version") d.version = Number(c[1]) || 0;
    if (!isOwnedFileNode(c)) { header.push(c); if (isList(c)) st.headerSrc.set(c, src); continue; }
    const node = toBoardNode(c);
    const sig = serialize(toFileNode(node));
    let id = uuidOf(node);
    if (!id) { const k = seen.get(sig) || 0; seen.set(sig, k + 1); id = derivedUuid(k, sig); }
    const it = addItem(d, node, id);
    if (!it) continue;
    st.itemSrc.set(it.id, { text: src, sig });
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

// ---------------------------------------------------------------- format( FOOTPRINT )'s sort orders
/** PCB_LAYER_ID of a layer name (KiCad 9+ numbering: F.Cu 0, B.Cu 2, InN.Cu 2+2N, technical layers odd). */
export function layerOrdinal(name: string): number {
  if (LAYER_IDS[name] !== undefined) return LAYER_IDS[name];
  const m = /^In(\d+)\.Cu$/.exec(name); if (m) return 2 + 2 * Number(m[1]);
  const u = /^User\.(\d+)$/.exec(name); if (u) return 37 + 2 * Number(u[1]);
  if (name === "Rescue") return 37;
  return 1000;
}
/** LSET::Seq of a (layers …) list (wildcards expanded), ascending. */
function layerSeq(node: SNode): number[] {
  const l = kid(node, "layers") || kid(node, "layer"); const out = new Set<number>();
  for (const a of l ? l.slice(1) : []) {
    const n = str(a);
    if (n === "*.Cu") { for (let i = 0; i <= 64; i += 2) out.add(i); }
    else if (n === "F&B.Cu") { out.add(0); out.add(2); }
    else if (n.startsWith("*.")) { out.add(layerOrdinal("F." + n.slice(2))); out.add(layerOrdinal("B." + n.slice(2))); }
    else out.add(layerOrdinal(n));
  }
  return Array.from(out).sort((a, b) => a - b);
}
function cmpSeq(a: number[], b: number[]): number { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }
const nm = (v: unknown) => { const x = Number(v); return isNaN(x) ? 0 : Math.round(x * 1e6); };   // internal units (nm): KiCad compares integers
function pt(node: SNode, key: string): [number, number] | null { const k = kid(node, key); return k ? [nm(k[1]), nm(k[2])] : null; }
function cmpPt(a: [number, number] | null, b: [number, number] | null): number { const p = a || [0, 0], q = b || [0, 0]; return p[0] - q[0] || p[1] - q[1]; }
function polyPts(node: SNode): [number, number][] { const p = kid(node, "pts"); return p ? kids(p, "xy").map((x) => [nm(x[1]), nm(x[2])] as [number, number]) : []; }
const SHAPE_ORD: Record<string, number> = { gr_line: 0, gr_rect: 1, gr_arc: 2, gr_circle: 3, gr_poly: 4, gr_curve: 5, gr_ellipse: 6, gr_ellipse_arc: 7 };
/** KICAD_T order of a graphical item (PCB_SHAPE_T < PCB_REFERENCE_IMAGE_T < PCB_TEXT_T < PCB_TEXTBOX_T < PCB_TABLE_T < dimensions). */
function typeOrd(kind: string, node: SNode): number {
  if (SHAPE_ORD[kind] !== undefined) return 4;
  if (kind === "image") return 5;
  if (kind === "gr_text" || kind === "fp_text") return 8;
  if (kind === "gr_text_box") return 9;
  if (kind === "table") return 10;
  if (kind === "barcode") return 18;
  if (kind === "dimension") { const t = str((kid(node, "type") || [])[1]); return ({ aligned: 19, leader: 20, center: 21, radial: 22, orthogonal: 23 } as Record<string, number>)[t] ?? 17; }
  return 30;
}
const PAD_SHAPE_ORD: Record<string, number> = { circle: 0, rect: 1, oval: 2, trapezoid: 3, roundrect: 4, custom: 6 };
function padShapeOrd(node: SNode): number { const s = str(node[3]); if (s === "roundrect" && kid(node, "chamfer")) return 5; return PAD_SHAPE_ORD[s] ?? 7; }
function textCmp(a: SNode, b: SNode): number {
  const aa = kid(a, "at") || [], ba = kid(b, "at") || [];
  const c = nm(aa[1]) - nm(ba[1]) || nm(aa[2]) - nm(ba[2]); if (c) return c;
  const r = Number(aa[3] || 0) - Number(ba[3] || 0); if (r) return r;
  const font = (n: SNode) => { const e = kid(n, "effects"); return e ? kid(e, "font") : null; };
  const fa = font(a), fb = font(b);
  const size = (f: SNode | null) => { const s = f && kid(f, "size"); return s ? [nm(s[2]), nm(s[1])] : [0, 0]; };   // GetTextSize: (width, height); the file writes height width
  const sa = size(fa), sb = size(fb); const sc = sa[0] - sb[0] || sa[1] - sb[1]; if (sc) return sc;
  const th = (f: SNode | null) => { const t = f && kid(f, "thickness"); return t ? nm(t[1]) : 0; };
  const tc = th(fa) - th(fb); if (tc) return tc;
  const flag = (f: SNode | null, k: string) => { if (!f) return 0; const x = kid(f, k); return x ? (str(x[1]) === "no" ? 0 : 1) : (f.includes(k) ? 1 : 0); };
  for (const k of ["bold", "italic"]) { const d = flag(fa, k) - flag(fb, k); if (d) return d; }
  const mir = (n: SNode) => { const e = kid(n, "effects"); const j = e && kid(e, "justify"); return j && j.includes("mirror") ? 1 : 0; };
  const md = mir(a) - mir(b); if (md) return md;
  const ls = (f: SNode | null) => { const l = f && kid(f, "line_spacing"); return l ? Number(l[1]) : 1; };
  const lc = ls(fa) - ls(fb); if (lc) return lc;
  const ta = str(a[1]), tb = str(b[1]); return ta < tb ? -1 : ta > tb ? 1 : 0;
}
/** FOOTPRINT::cmp_drawings without its final uuid / pointer tie-break. */
export function cmpDrawings(ka: string, a: SNode, kb: string, b: SNode): number {
  const t = typeOrd(ka, a) - typeOrd(kb, b); if (t) return t;
  const la = layerOrdinal(str((kid(a, "layer") || [])[1])), lb = layerOrdinal(str((kid(b, "layer") || [])[1])); if (la !== lb) return la - lb;
  if (SHAPE_ORD[ka] !== undefined) {
    const s = SHAPE_ORD[ka] - SHAPE_ORD[kb]; if (s) return s;
    if (ka === "gr_poly") {
      const pa = polyPts(a), pb = polyPts(b); if (pa.length !== pb.length) return pa.length - pb.length;
      for (let i = 0; i < pa.length; i++) { const c = cmpPt(pa[i], pb[i]); if (c) return c; }
    } else if (ka === "gr_curve") {
      const pa = polyPts(a), pb = polyPts(b);
      for (const i of [0, 3, 1, 2]) { const c = cmpPt(pa[i] || null, pb[i] || null); if (c) return c; }
    } else if (ka === "gr_ellipse" || ka === "gr_ellipse_arc") {
      const c = cmpPt(pt(a, "center"), pt(b, "center")); if (c) return c;
      for (const k of ["major_radius", "minor_radius", "rotation", "start_angle", "end_angle"]) { const x = kid(a, k), y = kid(b, k); const d = (x ? nm(x[1]) : 0) - (y ? nm(y[1]) : 0); if (d) return d; }
    } else {
      const sk = ka === "gr_circle" ? "center" : "start";
      let c = cmpPt(pt(a, sk), pt(b, sk)); if (c) return c;
      c = cmpPt(pt(a, "end"), pt(b, "end")); if (c) return c;
      if (ka === "gr_arc") { c = cmpPt(pt(a, "mid"), pt(b, "mid")); if (c) return c; }
    }
    const w = (n: SNode) => { const s = kid(n, "stroke"); const x = s ? kid(s, "width") : kid(n, "width"); return x ? nm(x[1]) : 0; };
    return w(a) - w(b);
  }
  if (typeOrd(ka, a) === 8) return textCmp(a, b);
  return 0;
}
/** FOOTPRINT::cmp_pads without its final uuid / pointer tie-break. */
export function cmpPads(a: SNode, b: SNode, strNum: (x: string, y: string) => number = strNumCmp): number {
  const na = str(a[1]), nb = str(b[1]);
  if (na !== nb) return strNum(na, nb) < 0 ? -1 : 1;
  const c = cmpPt(pt(a, "at"), pt(b, "at")); if (c) return c;
  const sa = pt(a, "size") || [0, 0], sb = pt(b, "size") || [0, 0];
  if (sa[0] !== sb[0]) return sa[0] - sb[0];
  if (sa[1] !== sb[1]) return sa[1] - sb[1];
  const sh = padShapeOrd(a) - padShapeOrd(b); if (sh) return sh;
  return cmpSeq(layerSeq(a), layerSeq(b));
}
/** FOOTPRINT::cmp_zones without its final uuid / pointer tie-break. */
function cmpZones(a: SNode, b: SNode): number {
  const pr = (n: SNode) => { const p = kid(n, "priority"); return p ? Number(p[1]) : 0; };
  const d = pr(a) - pr(b); if (d) return d;
  const l = cmpSeq(layerSeq(a), layerSeq(b)); if (l) return l;
  const outline = (n: SNode) => { const out: [number, number][] = []; for (const p of kids(n, "polygon")) out.push(...polyPts(p)); return out; };
  const pa = outline(a), pb = outline(b); if (pa.length !== pb.length) return pa.length - pb.length;
  for (let i = 0; i < pa.length; i++) { const c = cmpPt(pa[i], pb[i]); if (c) return c; }
  return 0;
}
/** StrNumCmp (KiCad's natural string order, case-insensitive). */
export function strNumCmp(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) || [], rb = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i]; const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else { const c = x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0; if (c) return c; }
  }
  return ra.length - rb.length;
}
/** FOOTPRINT::GetFields order: the mandatory fields first, then the others as they were added. */
const FIELD_ORD: Record<string, number> = { Reference: 0, Value: 1, Datasheet: 2, Description: 3 };

interface Written { it: Item; rank: number; pos: number; c: ReturnType<typeof canonical> }
/** The items in the order format( FOOTPRINT ) writes them. */
function sortedItems(d: FpDoc): Written[] {
  const st = d.fpState!; const pos = new Map(st.order.map((id, i) => [id, i]));
  let next = st.order.length;
  const list: Written[] = [];
  for (const it of d.items.values()) list.push({ it, rank: itemRank(it.kind), pos: pos.has(it.id) ? pos.get(it.id)! : next++, c: canonical(it) });
  // the uuid tie-break: KiCad's random ids for children a file gave none keep no order, so those keep the file's
  const tie = (x: Written, y: Written) => (x.c.derived && y.c.derived ? x.pos - y.pos : x.it.id < y.it.id ? -1 : x.it.id > y.it.id ? 1 : x.pos - y.pos);
  list.sort((x, y) => {
    if (x.rank !== y.rank) return x.rank - y.rank;
    const a = x.c.file, b = y.c.file; let c = 0;
    if (x.rank === RANK_FIELDS) { const fa = FIELD_ORD[fieldName(a)] ?? 4, fb = FIELD_ORD[fieldName(b)] ?? 4; return fa - fb || x.pos - y.pos; }
    if (x.rank === 30) c = cmpDrawings(str(x.it.node[0]), x.it.node, str(y.it.node[0]), y.it.node);
    else if (x.rank === 32) c = cmpPads(a, b);
    else if (x.rank === 33) c = cmpZones(a, b);
    else if (x.rank === 31) c = cmpPt(pt(a, "at"), pt(b, "at"));
    return c || tie(x, y);
  });
  return list;
}

/** Has anything of the footprint changed since it was read? */
export function footprintModified(doc: Doc): boolean {
  const d = doc as FpDoc; const st = d.fpState; if (!st) return false;
  if (serialize(st.fp) !== st.headerSig) return true;
  let n = 0;
  for (const it of d.items.values()) { const s = st.itemSrc.get(it.id); if (!s || s.sig !== canonical(it).sig) return true; n++; }
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
  // items in KiCad's order; a child whose id the reader derives from its content (and its place among identical
  // twins) is written without a uuid, any other carries its id so every reader keys it the same
  const seen = new Map<string, number>();
  for (const w of sortedItems(d)) {
    const s = st.itemSrc.get(w.it.id); let text: string;
    if (w.c.derived) {
      const k = seen.get(w.c.sig) || 0;
      if (derivedUuid(k, w.c.sig) === w.it.id) { seen.set(w.c.sig, k + 1); text = s && s.sig === w.c.sig ? s.text : w.c.sig; }
      else { const f = cloneNode(w.c.file); f.push(["uuid", w.it.id]); text = serialize(f); }
    } else text = s && s.sig === w.c.sig ? s.text : w.c.sig;
    parts.push({ rank: w.rank, seq: seq++, text });
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
  const byId = new Map<string, string>(); const bySig = new Map<string, string[]>();
  for (const it of d.items.values()) { const k = canonical(it).sig; byId.set(it.id, k); const l = bySig.get(k) || []; l.push(it.id); bySig.set(k, l); }
  const taken = new Set<string>();
  for (let j = 2; j < tree.length; j++) {
    const c = tree[j]; const span = spans[j]; if (!span || !isList(c)) continue;
    const src = text.slice(span[0], span[1]);
    if (!isOwnedFileNode(c)) { const l = headerBySig.get(serialize(c)); const h = l && l.shift(); if (h) st.headerSrc.set(h, src); continue; }
    // a child the file names by id is that item; one without an id the item of the same content
    const own = uuidOf(c); let id = "", sig = "";
    if (own && byId.has(own)) { const bare = withoutUuid(c, own); const bs = bare ? serialize(bare) : ""; sig = byId.get(own) === bs ? bs : serialize(c); id = own; }
    else { sig = serialize(c); const l = bySig.get(sig); while (l && l.length && taken.has(l[0])) l.shift(); id = (l && l.shift()) || ""; }
    if (!id || taken.has(id)) continue;
    taken.add(id); st.itemSrc.set(id, { text: src, sig }); st.order.push(id);
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
/** FOOTPRINT::GetDatasheet-or-description URL (FOOTPRINT_EDITOR_CONTROL::ShowDatasheet): the Datasheet field unless empty
 * or "~", else the first http(s) URL in the description (ExtractUrl's rules: stops at a control char, a quote or an
 * unbalanced ")"; a trailing ".,:;" dropped). */
export function footprintDocUrl(fields: Record<string, string>, descr: string): string | null {
  const ds = (fields.Datasheet || "").trim(); if (ds && ds !== "~") return ds;
  let idx = descr.indexOf("http:"); if (idx < 0) idx = descr.indexOf("https:"); if (idx < 0) return null;
  let url = "", nesting = 0;
  for (const ch of descr.slice(idx)) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c >= 0x7f || ch === '"') break;
    if (ch === "(") nesting++; else if (ch === ")" && --nesting < 0) break;
    url += ch;
  }
  if (".,:;".includes(url.slice(-1))) url = url.slice(0, -1);
  return url || null;
}

export const footprintDocApi = { footprintDocUrl, serializeFootprintDoc, footprintModified, markFootprintSaved, footprintHeaderSexpr, footprintName, footprintFields, footprintNode,
  toFileNode, toBoardNode, fpItemKind, fieldName, fieldText, isMandatoryField, cmpPads, cmpDrawings, strNumCmp, layerOrdinal, isOwnedFileNode, headerKids, derivedUuid, applyFootprintHeader, prettify, FP_EDITOR_LAYERS, FP_TO_BOARD, BOARD_TO_FP };
