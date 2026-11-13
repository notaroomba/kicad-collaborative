// compact.ts — fold a document's journalled edits into a new whole file, without a desktop editor.
//
// The server keeps a document as a snapshot (a whole KiCad file) with the ops made since laid over it,
// and only the desktop editors write snapshots.  A project edited only in the browser or through the
// tools therefore carries its whole history as ops, which every open and every join pays for, and the
// server's own readers of "the file" (downloads, GitHub sync) see the last snapshot, not the design.
//
// This writes the file those ops describe.  It is a splice, not a save: the stored file is cut into its
// top-level elements and every one of them that no edit touched goes into the result as the same bytes,
// in the same place — the format version, the generator, the sections this reader does not model
// (embedded files and fonts, sheet and symbol instances, net declarations, anything newer than us) and
// every item nobody changed.  Only the items the ops added, changed or removed, the library symbols those
// brought or left unused, and the header sections an edit replaced (page, title block, board setup) are
// written, and those from the edit's own text wherever it carried one.
//
// What the ops mean is not decided here: they are applied with the editor's own applyChange, so the
// result is the document every open browser already shows.  The result is then read back and compared
// with that document, item by item, and anything short of identical is refused — a document that cannot
// be folded stays as it was (snapshot + ops), which is correct, only slower.
import { prettify, type PrettifyMode } from "../canvas/prettify";

/** The canvas functions used (window.KiCadCanvas in the host, the modules themselves in a test). */
export interface CanvasApi {
  parse(text: string): any;
  parseAll(text: string): any[];
  serialize(node: any): string;
  parseDoc(text: string, type: string): any;
  applyChange(doc: any, change: any, IU: number): boolean;
}
export interface FoldOp { seq?: number; changes?: any[] }
export type FoldResult = { ok: true; text: string; changed: number } | { ok: false; reason: string };

const SCH_KINDS = new Set(["symbol", "wire", "bus", "junction", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect", "sheet", "text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "bus_entry", "image",
  "table", "rule_area", "ellipse", "ellipse_arc", "net_chain", "group"]);
const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated",
  "gr_ellipse", "gr_ellipse_arc", "barcode", "point", "grid_item"]);
/** Sections that close a file: new items go in before them. */
const TRAILERS = new Set(["sheet_instances", "symbol_instances", "embedded_fonts", "embedded_files"]);
const BOARD_SECTIONS = ["general", "layers", "setup"] as const;

class Refuse extends Error {}
const refuse = (why: string): never => { throw new Refuse(why); };

// ---------------------------------------------------------------- the file as spans

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
/** End (exclusive) of the element starting at i: a quoted string, a bare atom or a balanced list.  -1 when the text ends first. */
function elementEnd(s: string, i: number): number {
  const n = s.length, c = s.charCodeAt(i);
  if (c === 34) { let j = i + 1; while (j < n) { const d = s.charCodeAt(j); if (d === 92) j += 2; else if (d === 34) return j + 1; else j++; } return -1; }
  if (c === 40) {
    let depth = 0, j = i;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 34) { j = elementEnd(s, j); if (j < 0) return -1; continue; }
      if (d === 40) depth++;
      else if (d === 41 && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  if (c === 41 || i >= n) return -1;
  let j = i; while (j < n) { const d = s.charCodeAt(j); if (isWs(d) || d === 40 || d === 41) break; j++; }
  return j;
}
interface Span { lead: string; text: string; head: string }
interface ListSpans { open: string; children: Span[]; tail: string }
/** A list cut into "(head", its elements (each with the whitespace before it) and what follows the last one. */
function cut(text: string): ListSpans | null {
  let i = 0; const n = text.length;
  while (i < n && isWs(text.charCodeAt(i))) i++;
  if (text.charCodeAt(i) !== 40) return null;
  const headEnd = elementEnd(text, i + 1); if (headEnd < 0) return null;
  const children: Span[] = []; let prev = headEnd;
  for (;;) {
    let j = prev; while (j < n && isWs(text.charCodeAt(j))) j++;
    if (j >= n) return null;
    if (text.charCodeAt(j) === 41) return { open: text.slice(0, headEnd), children, tail: text.slice(prev) };
    const e = elementEnd(text, j); if (e < 0) return null;
    const t = text.slice(j, e);
    children.push({ lead: text.slice(prev, j), text: t, head: headOf(t) });
    prev = e;
  }
}
function headOf(t: string): string { if (t.charCodeAt(0) !== 40) return ""; const e = elementEnd(t, 1); return e < 0 ? "" : t.slice(1, e); }
const unquote = (t: string): string => { if (t.charCodeAt(0) !== 34) return t; try { return JSON.parse(t); } catch { return t.slice(1, -1); } };
/** The first argument of a list when it is an atom or a string. */
function firstArg(t: string): string | null { const l = cut(t); if (!l || !l.children.length || l.children[0].head) return null; return unquote(l.children[0].text); }
function directValue(l: ListSpans, name: string): string | null { for (const c of l.children) if (c.head === name) return firstArg(c.text); return null; }
/** canvas/sexpr.ts uuidOf, on text. */
function uuidOfText(t: string): string {
  const l = cut(t); if (!l) return "";
  const u = directValue(l, "uuid") ?? directValue(l, "tstamp"); if (u) return u;
  if (headOf(t) === "rule_area") for (const c of l.children) if (c.head) { const inner = cut(c.text); const v = inner && directValue(inner, "uuid"); if (v) return v; }
  return "";
}

// ---------------------------------------------------------------- writing

/** A node's text laid out as KiCad lays a file out, to sit at `depth` tabs. */
function laidOut(text: string, depth: number, mode: PrettifyMode): string {
  const p = prettify(text.trim(), mode).replace(/\s+$/, "");
  if (!depth) return p;
  // indent the lines, but not a line break inside a quoted string: that one is content
  const tabs = "\t".repeat(depth); let out = "", from = 0, quoted = false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (quoted) { if (c === 92) i++; else if (c === 34) quoted = false; }
    else if (c === 34) quoted = true;
    else if (c === 10) { out += p.slice(from, i + 1) + tabs; from = i + 1; }
  }
  return out + p.slice(from);
}

/**
 * The file `ops` make of `file`.  `ops` are the journal after the snapshot, in order.
 */
export function foldOps(k: CanvasApi, docType: string, file: string, ops: FoldOp[]): FoldResult {
  try { return fold(k, docType, file, ops); }
  catch (e) { if (e instanceof Refuse) return { ok: false, reason: e.message }; return { ok: false, reason: "failed: " + (e instanceof Error ? e.message : String(e)) }; }
}

function fold(k: CanvasApi, docType: string, file: string, ops: FoldOp[]): FoldResult {
  const sch = docType === "kicad_sch"; if (!sch && docType !== "kicad_pcb") refuse("not a schematic or a board");
  const kinds = sch ? SCH_KINDS : PCB_KINDS, IU = sch ? 1e4 : 1e6;
  const top = cut(file) || refuse("the stored file is not one list");
  if (headOf(file.trimStart()) !== docType) refuse("the stored file is not a " + docType);
  // KiCad 9 and later keep (font …), (stroke …) and (fill …) on one line; write new text the way the file is written
  const mode: PrettifyMode = /\(font \(/.test(file) ? "compactText" : "normal";
  const ser = (n: any): string => k.serialize(n);
  const canon = (t: string): string => { const n = k.parse(t); if (!n) refuse("unreadable text"); return ser(n); };

  // ---- the document as every browser has it
  let doc = k.parseDoc(file, docType) || refuse("the stored file could not be read");
  const before = new Map<string, string>(); for (const [id, it] of doc.items) before.set(id, ser(it.node));
  const libBefore = new Map<string, string>(); if (sch) for (const [name, n] of doc.lib) libBefore.set(name, ser(n));

  // ---- its items in the file
  const where = new Map<string, number>();   // item id -> index in top.children
  top.children.forEach((c, i) => {
    if (!kinds.has(c.head)) return;
    const id = uuidOfText(c.text); if (!id) return;   // no identity: no op can name it, it stays as it is
    if (where.has(id)) refuse("two items share the id " + id);
    if (!before.has(id)) refuse("item " + id + " is in the file but not in the document");
    where.set(id, i);
  });
  for (const id of before.keys()) if (!where.has(id) && !id.startsWith("anon-")) refuse("item " + id + " is in the document but not in the file");

  // ---- the edits
  let paper: string | null = null, title: string | null = null; const sections: Record<string, string> = {};
  const fragText = new Map<string, string>();   // the text an edit carried for an item or a library symbol
  const noteFragment = (frag: string): void => {
    const walk = (t: string): void => {
      const h = headOf(t);
      if (h === "kicad_sch" || h === "kicad_pcb") { const l = cut(t); if (l) for (const c of l.children) if (c.head === "lib_symbols" || kinds.has(c.head)) walk(c.text); return; }
      if (h === "lib_symbols") { const l = cut(t); if (l) for (const c of l.children) if (c.head === "symbol") { const name = firstArg(c.text); if (name !== null) fragText.set("lib:" + name, c.text); } return; }
      const id = uuidOfText(t); if (id) fragText.set(id, t);
    };
    let i = 0; const n = frag.length;
    for (;;) { while (i < n && isWs(frag.charCodeAt(i))) i++; if (i >= n) break; const e = elementEnd(frag, i); if (e < 0) break; walk(frag.slice(i, e)); i = e; }
  };
  for (const op of ops) for (const c of op.changes || []) {
    if (!c || typeof c !== "object") continue;
    if (c.docProps) {
      const p = c.docProps;
      if (typeof p.paper === "string" && p.paper) { const n = k.parse(p.paper); if (n && n[0] === "paper") paper = p.paper.trim(); }
      if (typeof p.titleBlock === "string") { const n = p.titleBlock ? k.parse(p.titleBlock) : null; title = n && n[0] === "title_block" ? p.titleBlock.trim() : ""; }
      continue;
    }
    if (c.typeName === "BOARD_SETUP") {
      if (sch) continue;
      for (const p of c.properties || []) {
        if (!p || !(BOARD_SECTIONS as readonly string[]).includes(p.name) || !p.after || typeof p.after.v !== "string") continue;
        const n = k.parse(p.after.v); if (!n) continue;
        if (n[0] !== p.name) refuse("a board setup edit names " + p.name + " but carries " + String(n[0]));
        sections[p.name] = p.after.v.trim();
      }
      continue;
    }
    const frag = c.sexpr || c.itemSexpr, kind = String(c.kind || "").toUpperCase();
    let ok = false;
    try { ok = k.applyChange(doc, c, IU); } catch (e) { refuse("an edit could not be applied: " + (e instanceof Error ? e.message : String(e))); }
    // the editors' own rule (editor/doc.ts mutateDoc): a removal or a value edit of an item that is not there is
    // nothing; a fragment that could not be taken means the copies differ, and then this one must not be written
    if (!ok && (frag || kind === "ADDED")) refuse("an edit to " + String(c.id) + " could not be applied");
    if (ok && typeof frag === "string") noteFragment(frag);
  }

  // ---- the new file
  /** The text for an item or library symbol as it now stands: the edit's own text when that is what it still is. */
  const textOf = (key: string, node: any, depth: number): string => {
    const now = ser(node), sent = fragText.get(key);
    let own = false; if (sent !== undefined) { try { own = canon(sent) === now; } catch { own = false; } }
    return laidOut(own ? sent! : now, depth, mode);
  };
  let changed = 0;
  const out: string[] = [top.open];
  const live = new Set<string>(); for (const id of doc.items.keys()) live.add(id);
  const fresh: string[] = []; for (const [id, it] of doc.items) if (!where.has(id) && !before.has(id)) fresh.push(textOf(id, it.node, 1));
  changed += fresh.length;

  // where additions go: after the last item of the stored file, else before the sections that close it, else at the end
  let lastItem = -1, firstTrailer = -1, paperAt = -1, titleAt = -1, libAt = -1; const sectionAt: Record<string, number> = {};
  top.children.forEach((c, i) => {
    if (kinds.has(c.head)) lastItem = i;
    else if (TRAILERS.has(c.head)) { if (firstTrailer < 0) firstTrailer = i; }
    else if (c.head === "paper") { if (paperAt < 0) paperAt = i; }
    else if (c.head === "title_block") { if (titleAt < 0) titleAt = i; }
    else if (c.head === "lib_symbols") { if (libAt < 0) libAt = i; }
    else if ((BOARD_SECTIONS as readonly string[]).includes(c.head)) { if (!(c.head in sectionAt)) sectionAt[c.head] = i; }
  });
  if ((paper !== null || title) && paperAt < 0) refuse("the stored file has no (paper …) section");
  for (const name of Object.keys(sections)) if (!(name in sectionAt)) refuse("the stored board has no (" + name + " …) section to replace");

  // library symbols (schematic): the stored ones in place, the ones an edit brought after them
  let libText: string | null = null;   // null: as stored
  if (sch) {
    const lib = libAt >= 0 ? cut(top.children[libAt].text) : null;
    if (libAt >= 0 && !lib) refuse("unreadable (lib_symbols …)");
    const stored = new Set<string>(); let touched = false; const parts: string[] = [];
    if (lib) for (const c of lib.children) {
      if (c.head !== "symbol") { parts.push(c.lead + c.text); continue; }
      const name = firstArg(c.text); if (name === null) refuse("a library symbol without a name");
      if (stored.has(name!)) refuse("two library symbols are named " + name);
      if (!libBefore.has(name!)) refuse("library symbol " + name + " is in the file but not in the document");
      stored.add(name!);
      const node = doc.lib.get(name!);
      if (!node) { touched = true; continue; }                                   // no symbol uses it any more
      if (ser(node) === libBefore.get(name!)) parts.push(c.lead + c.text);
      else { touched = true; parts.push(c.lead + textOf("lib:" + name, node, 2)); }
    }
    for (const name of libBefore.keys()) if (!stored.has(name)) refuse("library symbol " + name + " is in the document but not in the file");
    for (const [name, node] of doc.lib) if (!stored.has(name)) { touched = true; parts.push("\n\t\t" + textOf("lib:" + name, node, 2)); }
    if (touched) { changed++; libText = (lib ? lib.open : "(lib_symbols") + parts.join("") + (lib ? lib.tail : "\n\t)"); }
  }

  const add = (texts: string[]): void => { for (const t of texts) out.push("\n\t" + t); };
  const same = (a: string, b: string): boolean => { try { return canon(a) === canon(b); } catch { return false; } };
  let freshDone = false;
  top.children.forEach((c, i) => {
    if (i === firstTrailer && lastItem < 0 && !freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); freshDone = true; }
    if (i === paperAt) {
      if (paper !== null && !same(paper, c.text)) { out.push(c.lead + laidOut(paper, 1, mode)); changed++; } else out.push(c.lead + c.text);
      if (title && titleAt < 0) { out.push("\n\t" + laidOut(title, 1, mode)); changed++; }
    } else if (i === titleAt) {
      if (title === null || (title && same(title, c.text))) out.push(c.lead + c.text);
      else { changed++; if (title) out.push(c.lead + laidOut(title, 1, mode)); }
    } else if (i === libAt && sch) out.push(c.lead + (libText !== null ? libText : c.text));
    else if (!sch && sectionAt[c.head] === i && sections[c.head] !== undefined && !same(sections[c.head], c.text)) { out.push(c.lead + laidOut(sections[c.head], 1, mode)); changed++; }
    else if (kinds.has(c.head)) {
      const id = uuidOfText(c.text);
      if (!id || where.get(id) !== i) out.push(c.lead + c.text);
      else if (!live.has(id)) changed++;                                        // removed
      else {
        const node = doc.items.get(id).node;
        if (ser(node) === before.get(id)) out.push(c.lead + c.text);
        else { out.push(c.lead + textOf(id, node, 1)); changed++; }
      }
    } else out.push(c.lead + c.text);
    if (i === lastItem && !freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); freshDone = true; }
  });
  if (!freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); }
  out.push(top.tail);
  const text = out.join("");
  if (!changed) return { ok: true, text: file, changed: 0 };

  // ---- read it back: it must be the document, and everything else must be the stored bytes
  // (the document is reduced to what is compared and let go first: a large board is not held twice)
  const want = new Map<string, string>(), wantLib = new Map<string, string>(); let anonA = 0, anonB = 0;
  for (const [id, it] of doc.items) { if (id.startsWith("anon-")) anonA++; else want.set(id, ser(it.node)); }
  if (sch) for (const [name, n] of doc.lib) wantLib.set(name, ser(n));
  doc = null; before.clear(); libBefore.clear(); fragText.clear();
  const back = k.parseDoc(text, docType) || refuse("the new file could not be read back");
  for (const [id, it] of back.items) { if (id.startsWith("anon-")) { anonB++; continue; } const w = want.get(id); if (w === undefined) refuse("item " + id + " is in the new file but not in the document"); if (ser(it.node) !== w) refuse("item " + id + " reads back differently"); }
  for (const id of want.keys()) if (!back.items.has(id)) refuse("item " + id + " is missing from the new file");
  if (anonA !== anonB) refuse("the new file has a different number of unnamed items");
  if (sch) {
    if (back.lib.size !== wantLib.size) refuse("the new file has a different set of library symbols");
    for (const [name, w] of wantLib) { const b = back.lib.get(name); if (!b || ser(b) !== w) refuse("library symbol " + name + " reads back differently"); }
  }
  const kept = (l: ListSpans): string[] => l.children.filter((c) => !kinds.has(c.head) && c.head !== "paper" && c.head !== "title_block" && c.head !== "lib_symbols" && !(!sch && (BOARD_SECTIONS as readonly string[]).includes(c.head))).map((c) => c.text);
  const topBack = cut(text) || refuse("the new file is not one list");
  const a = kept(top), b = kept(topBack!);
  if (a.length !== b.length || a.some((t, i) => t !== b[i]) || top.open !== topBack!.open) refuse("a section no edit touched came out differently");
  const section = (l: ListSpans, name: string): string | null => { const c = l.children.find((x) => x.head === name); return c ? c.text : null; };
  const expect = (name: string, set: string | null | undefined): void => {
    const was = section(top!, name), is = section(topBack!, name);
    const want = set === undefined || set === null ? was : set === "" ? null : set;
    if ((want === null) !== (is === null) || (want !== null && !same(want, is!))) refuse("the (" + name + " …) section reads back differently");
  };
  expect("paper", paper); expect("title_block", title);
  if (!sch) for (const name of BOARD_SECTIONS) expect(name, sections[name]);
  return { ok: true, text, changed };
}
