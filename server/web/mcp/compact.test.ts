// compact.test.ts — folding journalled edits into a whole file (compact.ts): `npm run test:compact`.
// Every case folds edits into a real demo file and checks the three promises: the result is the document
// the editor's own applier makes of those edits, nothing an edit did not touch moved by a byte, and the
// format version is the stored one.
import { foldOps, type CanvasApi, type FoldOp } from "./compact";

declare const require: (m: string) => unknown;
declare const process: { exit(code: number): void; env: Record<string, string | undefined>; cwd(): string };
const path = require("path") as { join(...p: string[]): string; resolve(...p: string[]): string };
const fs = require("fs") as { readFileSync(p: string, enc: string): string; existsSync(p: string): boolean };
// the built canvas library, the one the tool host runs
require(path.join(process.env.KC_SERVER_DIR || process.cwd(), "static", "kicad-canvas.js"));
const K = (globalThis as unknown as { KiCadCanvas: any }).KiCadCanvas;
const k: CanvasApi = K;
const parse = (t: string): any => K.parse(t), parseAll = (t: string): any[] => K.parseAll(t), serialize = (n: any): string => K.serialize(n);
const parseDoc = (t: string, type: string): any => K.parseDoc(t, type), applyChange = (d: any, c: any, IU: number): boolean => K.applyChange(d, c, IU);
const serializeItem = (d: any, it: any): string => K.serializeItem(d, it);
const kids = (n: any, key: string): any[] => (n || []).filter((c: any) => Array.isArray(c) && c[0] === key);
const kid = (n: any, key: string): any => kids(n, key)[0] || null;
const str = (v: unknown): string => String(v);
const DEMOS = path.resolve(process.env.KC_SERVER_DIR || process.cwd(), "../demos");
let failed = 0, passed = 0;
function ok(cond: unknown, what: string): void { if (cond) passed++; else { failed++; console.error("FAIL " + what); } }

/** The document the editor makes of the same edits. */
function editorDoc(file: string, docType: string, ops: FoldOp[]): any {
  const d: any = parseDoc(file, docType); const IU = docType === "kicad_sch" ? 1e4 : 1e6;
  for (const op of ops) for (const c of op.changes || []) if (!c.docProps && c.typeName !== "BOARD_SETUP") applyChange(d, c, IU);
  return d;
}
function sameDoc(a: any, b: any, what: string): void {
  const ids = (d: any) => [...d.items.keys()].filter((i: string) => !i.startsWith("anon-")).sort();
  ok(JSON.stringify(ids(a)) === JSON.stringify(ids(b)), what + ": same items");
  let diff = 0; for (const [id, it] of a.items) { const o = b.items.get(id); if (o && serialize(o.node) !== serialize(it.node)) diff++; }
  ok(diff === 0, what + ": every item reads the same (" + diff + " differ)");
  if (a.type === "sch") { const names = (d: any) => [...d.lib.keys()].sort(); ok(JSON.stringify(names(a)) === JSON.stringify(names(b)), what + ": same library symbols"); }
}
/** Lines of `a` that are not in `b`, by count. */
function linesLost(a: string, b: string): number { const have = new Map<string, number>(); for (const l of b.split("\n")) have.set(l, (have.get(l) || 0) + 1); let lost = 0; for (const l of a.split("\n")) { const n = have.get(l) || 0; if (n) have.set(l, n - 1); else lost++; } return lost; }

function run(demo: string, name: string, docType: string): void {
  const file = fs.readFileSync(path.join(DEMOS, demo, name), "utf8");
  const sch = docType === "kicad_sch";
  const doc: any = parseDoc(file, docType);
  const items = [...doc.items.values()].filter((i: any) => !i.id.startsWith("anon-"));
  const tag = demo + "/" + name;

  // nothing to fold: the same bytes
  const none = foldOps(k, docType, file, []);
  ok(none.ok && none.text === file, tag + ": no edits, the same file");

  // a move (a value edit, no fragment), a replacement, a removal, an addition, page settings
  const mover = items.find((i: any) => i.kind === (sch ? "symbol" : "footprint")), gone = items.find((i: any) => i.kind === (sch ? "wire" : "segment")), copy = items.find((i: any) => i.kind === (sch ? "junction" : "via")) || gone;
  const repl = items.find((i: any) => i.kind === (sch ? "label" : "gr_line")) || items.find((i: any) => i !== mover && i !== gone && i !== copy);
  const IU = sch ? 1e4 : 1e6;
  const newId = "0f0f0f0f-1111-4222-8333-444444444444";
  const copyText = serialize(copy.node).replace(copy.id, newId);
  const frag = (body: string) => sch ? body : `(kicad_pcb (version ${doc.version}) (generator "kicad-collab-web") ${body})`;
  const replText = serializeItem(doc, repl);
  const ops: FoldOp[] = [
    { seq: 1, changes: [{ id: mover.id, kind: "MODIFIED", properties: [{ name: "Position X", after: { v: Math.round((mover.x + 2.54) * IU) } }, { name: "Position Y", after: { v: Math.round((mover.y + 1.27) * IU) } }] }] },
    { seq: 2, changes: [{ id: gone.id, kind: "REMOVED", properties: [] }] },
    { seq: 3, changes: [{ id: newId, kind: "ADDED", sexpr: frag(copyText) }] },
    { seq: 4, changes: [{ id: repl.id, kind: "MODIFIED", sexpr: replText }] },   // sent again unchanged: must fold to no change
    { seq: 5, changes: [{ id: "page", kind: "MODIFIED", docProps: { paper: '(paper "A2")', titleBlock: '(title_block (title "Folded") (rev "7"))' } }] },
    { seq: 6, changes: [{ id: "never-there", kind: "REMOVED", properties: [] }] },
  ];
  const r = foldOps(k, docType, file, ops);
  ok(r.ok, tag + ": folds" + (r.ok ? "" : " (" + r.reason + ")"));
  if (!r.ok) return;
  const want = editorDoc(file, docType, ops), got: any = parseDoc(r.text, docType);
  sameDoc(want, got, tag);
  ok(!got.items.has(gone.id) && got.items.has(newId), tag + ": the removal and the addition are in the file");
  const tree: any = parse(r.text), base: any = parse(file);
  ok(serialize(kid(tree, "version")) === serialize(kid(base, "version")), tag + ": format version untouched");
  ok(serialize(kid(tree, "generator")) === serialize(kid(base, "generator")), tag + ": generator untouched");
  ok(str(kid(tree, "paper")[1]) === "A2" && str(kid(kid(tree, "title_block"), "title")[1]) === "Folded", tag + ": page settings are in the file");
  // everything else is the stored text: the lines that went are those of the moved and removed items and the page header
  const lost = linesLost(file, r.text), budget = serialize(mover.node).length / 8 + 400;
  ok(lost < budget, tag + ": untouched text kept (" + lost + " of " + file.split("\n").length + " lines changed)");
  for (const h of ["sheet_instances", "embedded_fonts", "setup", "layers", "general", "lib_symbols"]) { const a = kid(base, h), b = kid(tree, h); if (a) ok(b && file.includes(sliceOf(file, h)) && r.text.includes(sliceOf(file, h)), tag + ": (" + h + ") byte for byte"); }
  // folding twice is folding once
  const again = foldOps(k, docType, r.text, []);
  ok(again.ok && again.text === r.text, tag + ": the result is stable");
  // and it reads as one balanced list
  ok(parseAll(r.text).length === 1, tag + ": one list");

  // an edit this reader cannot take refuses, it does not write a guess
  const bad = foldOps(k, docType, file, [{ seq: 1, changes: [{ id: "x", kind: "ADDED", sexpr: frag('(no_such_item (uuid "x"))') }] }]);
  ok(!bad.ok, tag + ": an unknown item is refused");
  if (!sch) {
    const layers = serialize(kid(base, "layers"));
    const s = foldOps(k, docType, file, [{ seq: 1, changes: [{ id: "board-setup", kind: "MODIFIED", typeName: "BOARD_SETUP", properties: [{ name: "layers", after: { type: "sexpr", v: layers.replace('"F.Cu"', '"F.Cu"').replace(/\)$/, ' (39 "User.9" user "Notes"))') } }] }] }]);
    ok(s.ok && /\(39 "?User\.9"? user "Notes"\)/.test((s as any).text), tag + ": a board setup edit lands" + (s.ok ? "" : " (" + (s as any).reason + ")"));
    if (s.ok) ok(linesLost(file, s.text) < 80, tag + ": and only the layer table changed");
    // Repair Board: an item given a new id (REMOVED + ADDED with replaces) stays where it was in the file
    const mid = items[Math.floor(items.length / 2)], reId = "0e0e0e0e-1111-4222-8333-555555555555";
    const r = foldOps(k, docType, file, [{ seq: 1, changes: [{ id: mid.id, kind: "REMOVED" }, { id: reId, kind: "ADDED", replaces: mid.id, sexpr: frag(serialize(mid.node).replace(mid.id, reId)) }] }]);
    ok(r.ok, tag + ": a re-id folds" + (r.ok ? "" : " (" + (r as any).reason + ")"));
    if (r.ok) {
      const ord = (t: string): string[] => [...(parseDoc(t, docType) as any).items.keys()].filter((x: string) => !x.startsWith("anon-"));
      const was = ord(file), now = ord(r.text);
      ok(now.indexOf(reId) === was.indexOf(mid.id) && !now.includes(mid.id), tag + ": the re-id'd item keeps its place");
    }
  } else {
    // a symbol placed from a library the sheet did not have brings its library copy
    const sym = items.find((i: any) => i.kind === "symbol"); const libId = str(kid(sym.node, "lib_id")[1]); const libNode = doc.lib.get(libId);
    if (libNode) {
      const libText = serialize(libNode).replace(JSON.stringify(libId), JSON.stringify("Folded:Part"));
      const symText = serialize(sym.node).replace(JSON.stringify(libId), JSON.stringify("Folded:Part")).replace(sym.id, newId);
      const s = foldOps(k, docType, file, [{ seq: 1, changes: [{ id: newId, kind: "ADDED", sexpr: "(lib_symbols " + libText + ") " + symText }] }]);
      ok(s.ok, tag + ": a symbol with its library copy folds" + (s.ok ? "" : " (" + (s as any).reason + ")"));
      if (s.ok) { const d: any = parseDoc(s.text, docType); ok(d.lib.has("Folded:Part") && d.items.has(newId), tag + ": both are in the file"); ok(kids(kid(parse(s.text) as any, "lib_symbols"), "symbol").length === doc.lib.size + 1, tag + ": the stored library symbols stay"); }
    }
  }
}
/** The text of the first top-level (head …) of a file. */
function sliceOf(file: string, head: string): string { const i = file.indexOf("\n\t(" + head); if (i < 0) return "\u0000"; let d = 0, j = i + 2, q = false; for (; j < file.length; j++) { const c = file[j]; if (q) { if (c === "\\") j++; else if (c === '"') q = false; } else if (c === '"') q = true; else if (c === "(") d++; else if (c === ")" && --d === 0) break; } return file.slice(i + 2, j + 1); }

for (const [demo, name, type] of [["stickhub", "StickHub.kicad_sch", "kicad_sch"], ["stickhub", "StickHub.kicad_pcb", "kicad_pcb"], ["video", "video.kicad_sch", "kicad_sch"]] as const) {
  if (!fs.existsSync(path.join(DEMOS, demo, name))) { console.log("skip " + demo + "/" + name); continue; }
  const t = Date.now(); run(demo, name, type); console.log(`${demo}/${name}: ${Date.now() - t} ms`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
