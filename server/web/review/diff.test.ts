// review/diff.test.ts — the diff engine against small documents and one of KiCad's demo projects.
// Run by `npm test` (bundled for node by esbuild; the canvas library is the built static/kicad-canvas.js).
import { changeOfItem, countsText, diffDocs, type Change, type DocDiff } from "./diff";

declare const require: (m: string) => unknown;
declare const __dirname: string;
declare const process: { exit(code: number): void; env: Record<string, string | undefined>; cwd(): string };
const path = require("path") as { join(...p: string[]): string };
const fs = require("fs") as { readFileSync(p: string, enc: string): string; existsSync(p: string): boolean };
const root = process.env.KC_SERVER_DIR || process.cwd();
require(path.join(root, "static", "kicad-canvas.js"));
const K = (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", (e as Error).message); } }
function ok(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string): void { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pcb = (body: string): KDoc => K.parseDoc(`(kicad_pcb (version 20240108) (generator "pcbnew") (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "VBUS")
  ${body})`, "kicad_pcb");
const sch = (body: string, head = `(paper "A4")`): KDoc => K.parseDoc(`(kicad_sch (version 20231120) (generator "eeschema") (uuid "root") ${head} (lib_symbols) ${body})`, "kicad_sch");
const seg = (id: string, x0: number, y0: number, x1: number, y1: number, net = 1, w = 0.25, layer = "F.Cu"): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width ${w}) (layer "${layer}") (net ${net}) (uuid "${id}"))`;
const via = (id: string, x: number, y: number, net = 1): string => `(via (at ${x} ${y}) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${id}"))`;
const fp = (id: string, ref: string, value: string, x: number, y: number, rot = 0, layer = "F.Cu"): string =>
  `(footprint "Resistor_SMD:R_0603" (layer "${layer}") (uuid "${id}") (at ${x} ${y} ${rot})
     (property "Reference" "${ref}" (at 0 -1.4 0) (layer "F.SilkS") (uuid "${id}-r") (effects (font (size 1 1) (thickness 0.15))))
     (property "Value" "${value}" (at 0 1.4 0) (layer "F.Fab") (uuid "${id}-v") (effects (font (size 1 1) (thickness 0.15))))
     (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND") (uuid "${id}-p1"))
     (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "VBUS") (uuid "${id}-p2")))`;
const wire = (id: string, x0: number, y0: number, x1: number, y1: number): string => `(wire (pts (xy ${x0} ${y0}) (xy ${x1} ${y1})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const label = (id: string, text: string, x: number, y: number): string => `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id}"))`;
const find = (d: DocDiff, key: string): Change => { const c = d.changes.find((x) => x.key === key); if (!c) throw new Error(`no change ${key} in ${d.changes.map((x) => x.key).join(" ")}`); return c; };
const row = (c: Change, name: string) => c.props.find((r) => r.name === name);

test("identical documents: no differences", () => {
  const text = fp("f1", "R1", "10k", 10, 10) + seg("s1", 0, 0, 5, 0);
  const d = diffDocs(K, pcb(text), pcb(text));
  eq(d.changes.length, 0, "changes"); eq(countsText(d), "No differences", "summary");
});

test("a footprint added, one removed, one moved and re-valued", () => {
  const a = pcb(fp("f1", "R1", "10k", 10, 10) + fp("f2", "R2", "1k", 20, 10));
  const b = pcb(fp("f1", "R1", "22k", 12.54, 10) + fp("f3", "R3", "4k7", 30, 10));
  const d = diffDocs(K, a, b);
  eq(countsText(d), "1 added, 1 removed, 1 modified", "summary");
  eq(find(d, "added:f3").label, "Footprint R3 (4k7)", "added label");
  eq(find(d, "removed:f2").label, "Footprint R2 (1k)", "removed label");
  const m = find(d, "modified:f1");
  eq(row(m, "Value")?.before, "10k", "value before"); eq(row(m, "Value")?.after, "22k", "value after");
  eq(row(m, "Position X")?.before, "10 mm", "x before"); eq(row(m, "Position X")?.after, "12.54 mm", "x after");
  ok(!row(m, "Position Y"), "y did not change");
  ok(m.detail.startsWith("Value: 10k → 22k"), "detail names the value: " + m.detail);
  ok(m.bbox && m.bbox[0] < 10 && m.bbox[2] > 12.54, "the box covers both places");
  ok(d.added.has("f3") && d.removed.has("f2") && d.modified.has("f1") && d.modifiedOld.has("f1"), "id sets");
  eq(m.ref, "R1", "comment anchor");
});

test("a move alone says how far", () => {
  const d = diffDocs(K, pcb(fp("f1", "R1", "10k", 10, 10)), pcb(fp("f1", "R1", "10k", 13, 14)));
  eq(find(d, "modified:f1").detail, "moved 5 mm", "detail");
});
test("a rotation alone says the new angle", () => {
  const d = diffDocs(K, pcb(fp("f1", "R1", "10k", 10, 10)), pcb(fp("f1", "R1", "10k", 10, 10, 90)));
  eq(find(d, "modified:f1").detail, "rotated to 90°", "detail");
});
test("a footprint flipped to the back names the layer", () => {
  const d = diffDocs(K, pcb(fp("f1", "R1", "10k", 10, 10)), pcb(fp("f1", "R1", "10k", 10, 10, 0, "B.Cu")));
  const r = row(find(d, "modified:f1"), "Layer"); eq(r?.before, "F.Cu", "before"); eq(r?.after, "B.Cu", "after");
});

test("the tracks of a net are one row per category", () => {
  const a = pcb(seg("s1", 0, 0, 5, 0) + seg("s2", 5, 0, 5, 5) + seg("s9", 0, 9, 9, 9, 2));
  const b = pcb(seg("s1", 0, 0, 5, 0) + seg("s3", 5, 0, 8, 0) + seg("s4", 8, 0, 8, 5) + via("v1", 8, 5) + seg("s9", 0, 9, 9, 9, 2, 0.5));
  const d = diffDocs(K, a, b);
  const add = find(d, "added:routing:GND");
  eq(add.label, "Tracks on net GND", "label"); eq(add.detail, "2 segments, 1 via", "tally"); eq(add.ids.length, 3, "ids");
  eq(find(d, "removed:s2").label, "Track on F.Cu, net GND", "a lone removed segment keeps its own row");
  const w = find(d, "modified:s9");
  eq(row(w, "Width")?.before, "0.25 mm", "width before"); eq(row(w, "Width")?.after, "0.5 mm", "width after");
  eq(changeOfItem(d, "v1"), add, "an item finds its row");
});

test("a track moved to another net shows the nets by name", () => {
  const d = diffDocs(K, pcb(seg("s1", 0, 0, 5, 0, 1)), pcb(seg("s1", 0, 0, 5, 0, 2)));
  const r = row(find(d, "modified:s1"), "Net"); eq(r?.before, "GND", "before"); eq(r?.after, "VBUS", "after");
});

test("a zone refill alone is not a change; a new outline is", () => {
  const zone = (pts: string, fill: string): string => `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts ${pts})) ${fill})`;
  const sq = "(xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)";
  const a = pcb(zone(sq, `(filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))`));
  const refilled = pcb(zone(sq, `(filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)))`));
  eq(diffDocs(K, a, refilled).changes.length, 0, "refill only");
  const d = diffDocs(K, a, pcb(zone("(xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10)", "")));
  eq(find(d, "modified:z1").detail, "outline changed", "outline");
});

test("items without a uuid are matched by what they say", () => {
  const line = (x: number): string => `(gr_line (start 0 0) (end ${x} 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))`;
  eq(diffDocs(K, pcb(line(10) + line(20)), pcb(line(20) + line(10))).changes.length, 0, "same lines, other order");
  const d = diffDocs(K, pcb(line(10)), pcb(line(15)));
  eq(countsText(d), "1 added, 1 removed", "a changed anonymous line is a removal and an addition");
});

test("schematic: wires that touch are one row, a label edit is a text change", () => {
  const a = sch(label("l1", "VBUS", 10, 10) + wire("w1", 0, 0, 10, 0));
  const b = sch(label("l1", "VIN", 10, 10) + wire("w1", 0, 0, 10, 0) + wire("w2", 10, 0, 10, 5) + wire("w3", 10, 5, 20, 5) + wire("w4", 50, 50, 60, 50)
    + `(junction (at 10 5) (diameter 0) (color 0 0 0 0) (uuid "j1"))`);
  const d = diffDocs(K, a, b);
  const wiring = d.changes.filter((c) => c.label === "Wiring");
  eq(wiring.length, 1, "one cluster"); eq(wiring[0].detail, "2 wires, 1 junction", "tally");
  eq(find(d, "added:w4").label, "Wire", "the wire elsewhere is its own row");
  const l = find(d, "modified:l1");
  eq(l.label, "Label VIN", "label"); eq(row(l, "Text")?.before, "VBUS", "before"); eq(row(l, "Text")?.after, "VIN", "after");
});

test("sheet settings: page size and title block", () => {
  const a = sch("", `(paper "A4") (title_block (title "Amp") (rev "A"))`), b = sch("", `(paper "A3") (title_block (title "Amp") (rev "B"))`);
  const c = find(diffDocs(K, a, b), "modified:document");
  eq(c.label, "Sheet settings", "label");
  ok(row(c, "Page size")?.after.startsWith("A3"), "page"); eq(row(c, "Title block rev")?.after, "B", "rev");
});

test("a real board: moving one footprint and deleting a track is exactly two changes", () => {
  const file = path.join(root, "..", "demos", "pic_programmer", "pic_programmer.kicad_pcb");
  if (!fs.existsSync(file)) { console.log("  (demo board not present, skipped)"); return; }
  const text = fs.readFileSync(file, "utf8");
  const a = K.parseDoc(text, "kicad_pcb"), b = K.parseDoc(text, "kicad_pcb");
  eq(diffDocs(K, a, b).changes.length, 0, "the same file twice");
  const foot = Array.from(b.items.values()).find((it) => it.kind === "footprint" && it.ref) as KItem;
  const at = K.kid(foot.node, "at") as SNode; at[1] = K.num(at[1]) + 2.54;
  const track = Array.from(b.items.values()).find((it) => it.kind === "segment") as KItem;
  b.items.delete(track.id);
  const d = diffDocs(K, a, b);
  eq(countsText(d), "1 removed, 1 modified", "summary");
  eq(find(d, "modified:" + foot.id).detail, "moved 2.54 mm", "the move");
});

test("a real schematic compares clean with itself", () => {
  const file = path.join(root, "..", "demos", "pic_programmer", "pic_programmer.kicad_sch");
  if (!fs.existsSync(file)) { console.log("  (demo schematic not present, skipped)"); return; }
  const text = fs.readFileSync(file, "utf8");
  const a = K.parseDoc(text, "kicad_sch"), b = K.parseDoc(text, "kicad_sch");
  eq(diffDocs(K, a, b).changes.length, 0, "the same file twice");
  const sym = Array.from(b.items.values()).find((it) => it.kind === "symbol" && it.ref && !it.ref.startsWith("#")) as KItem;
  for (const p of K.kids(sym.node, "property")) if (K.str(p[1]) === "Value") p[2] = "CHANGED";
  const c = find(diffDocs(K, a, b), "modified:" + sym.id);
  eq(row(c, "Value")?.after, "CHANGED", "value row");
});

console.log(`review diff: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
