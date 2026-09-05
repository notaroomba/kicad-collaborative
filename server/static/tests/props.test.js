// props.test.js — the pure node editors of props.js against the StickHub sample.
// Run with `node server/static/tests/props.test.js` (node:test, no DOM needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../kicad-canvas.js");
const props = require("../props.js");
const K = globalThis.KiCadCanvas;
const H = props.helpers;

const SAMPLE_DIRS = [
  process.env.PROPS_SAMPLE_DIR,
  "/private/tmp/claude-502/-Users-roomba-Documents-GitHub-kicad-collaborative/dbbcf49c-094f-41fc-be3a-cd8a1023d083/scratchpad/shape-test/orig",
  path.join(__dirname, ".."),
].filter(Boolean);
const DIR = SAMPLE_DIRS.find((d) => fs.existsSync(path.join(d, "StickHub.kicad_sch")) && fs.existsSync(path.join(d, "StickHub.kicad_pcb")));
const skip = DIR ? false : "StickHub sample not found (set PROPS_SAMPLE_DIR)";
const t = (name, fn) => test(name, { skip }, fn);

const sch = DIR ? K.parseDoc(fs.readFileSync(path.join(DIR, "StickHub.kicad_sch"), "utf8")) : null;
const pcb = DIR ? K.parseDoc(fs.readFileSync(path.join(DIR, "StickHub.kicad_pcb"), "utf8")) : null;
const clone = (n) => JSON.parse(JSON.stringify(n));
function find(doc, pred) { for (const it of doc.items.values()) if (pred(it)) return it; throw new Error("sample item not found"); }
const byRef = (doc, kind, ref) => find(doc, (it) => it.kind === kind && it.ref === ref);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} ≈ ${b}`);
const sortPts = (pts) => pts.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const samePts = (a, b, msg) => { a = sortPts(a); b = sortPts(b); assert.equal(a.length, b.length, msg); a.forEach((p, i) => { near(p[0], b[i][0], msg); near(p[1], b[i][1], msg); }); };
const padCentres = (item) => item.geom.filter((g) => g.t === "pad" && g.layer !== "holes").map((g) => [g.x, g.y]);
const pinPts = (doc, item) => K.pinPoints(doc, item).map((p) => [p.x, p.y]);
/** p' = a + B·Aᵀ·(p − a): where a symbol's library-frame point lands after its transform changes. */
function remap(pts, a, A, B) {
  return pts.map(([x, y]) => { const dx = x - a[0], dy = y - a[1]; const lx = A[0] * dx + A[2] * dy, ly = A[1] * dx + A[3] * dy; return [a[0] + B[0] * lx + B[1] * ly, a[1] + B[2] * lx + B[3] * ly]; });
}

/** Serialize the edited node the way the panel does, push it through applyChange and hand back the fresh item; the doc is restored afterwards. */
function roundtrip(doc, item, node) {
  const sexpr = K.serializeItem(doc, Object.assign({}, item, { node, geom: [], bbox: null }));
  const trees = K.parseAll(sexpr);
  assert.equal(trees.length, 1, "one top-level form");
  const tree = trees[0];
  const body = tree[0] === "kicad_sch" ? tree.find((c, i) => i > 0 && Array.isArray(c) && c[0] === item.kind) : tree;
  assert.ok(body && body[0] === item.kind, "re-parsed node has the item's kind");
  assert.ok(K.applyChange(doc, { id: item.id, kind: "MODIFIED", typeName: K.typeNameOf(item), sexpr }, doc.type === "sch" ? 1e4 : 1e6), "change applies");
  const fresh = doc.items.get(item.id);
  doc.items.set(item.id, item);
  return fresh;
}

test("loads without a DOM and registers on CollabTools", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof props.render, "function");
  assert.equal(typeof props.inspect, "function");
  assert.equal(typeof props.refresh, "function");
});

// ---------------------------------------------------------------- symbols
t("setField edits symbol fields and creates missing ones hidden", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  H.setField(node, "Value", "4k7"); H.setField(node, "Reference", "R99");
  const p = H.setField(node, "MPN2", "abc");
  assert.ok(H.isHidden(p)); assert.deepEqual(H.kid(p, "at").slice(1, 3), [262.89, 207.01]);
  const fresh = roundtrip(sch, item, node);
  assert.equal(fresh.value, "4k7"); assert.equal(fresh.ref, "R99");
  assert.equal(H.str(H.field(fresh.node, "MPN2")[2]), "abc");
  assert.equal(item.value, "470", "original untouched");
});

t("setFieldHidden toggles (hide yes) and the drawn text", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  const shown = (it, layer) => it.geom.filter((g) => g.t === "text" && g.layer === layer).map((g) => g.text);
  assert.deepEqual(shown(item, "Reference & value").sort(), ["470", "R11"]);
  H.setFieldHidden(node, "Value", true); H.setFieldHidden(node, "Footprint", false);
  assert.equal(H.str(H.kid(H.field(node, "Value"), "hide")[1]), "yes");
  assert.equal(H.kid(H.field(node, "Footprint"), "hide"), null);
  const fresh = roundtrip(sch, item, node);
  assert.deepEqual(shown(fresh, "Reference & value"), ["R11"]);
  assert.ok(shown(fresh, "Fields").includes("footprints:R_1005_C"));
  // legacy bare `hide` inside effects is understood and replaced
  const old = clone(item.node); H.kid(H.field(old, "Value"), "effects").push("hide");
  assert.ok(H.isHidden(H.field(old, "Value")));
  H.setFieldHidden(old, "Value", false); assert.ok(!H.isHidden(H.field(old, "Value")));
  assert.ok(!H.kid(H.field(old, "Value"), "effects").includes("hide"));
});

t("setSymbolPosition moves the anchor, fields and pins together", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  H.setSymbolPosition(node, 265.43, 205.74);
  const fresh = roundtrip(sch, item, node);
  near(fresh.x, 265.43); near(fresh.y, 205.74);
  for (const p of H.kids(item.node, "property")) {
    const a0 = H.kid(p, "at"), a1 = H.kid(H.field(fresh.node, H.str(p[1])), "at");
    near(a1[1] - a0[1], 2.54, "field dx"); near(a1[2] - a0[2], -1.27, "field dy"); assert.equal(a1[3], a0[3], "field angle");
  }
  samePts(pinPts(sch, fresh), pinPts(sch, item).map(([x, y]) => [x + 2.54, y - 1.27]), "pins");
});

t("setSymbolRotation turns the body and fields about the anchor, keeping raw field angles", () => {
  const cases = [[byRef(sch, "symbol", "R11"), 90], [find(sch, (it) => it.kind === "symbol" && it.rot === 0 && !H.mirrorOf(it.node) && it.ref && !it.ref.startsWith("#")), 90], [byRef(sch, "symbol", "R11"), 0]];
  for (const [item, deg] of cases) {
    const node = clone(item.node); const a = [item.x, item.y];
    H.setSymbolRotation(node, deg);
    const fresh = roundtrip(sch, item, node);
    assert.equal(fresh.rot, deg, item.ref + " rot");
    const A = H.symbolT(item.rot, H.mirrorOf(item.node)), B = H.symbolT(deg, H.mirrorOf(item.node));
    samePts(pinPts(sch, fresh), remap(pinPts(sch, item), a, A, B), item.ref + " pins");
    const at0 = H.kid(H.field(item.node, "Reference"), "at"), at1 = H.kid(H.field(fresh.node, "Reference"), "at");
    samePts([[at1[1], at1[2]]], remap([[at0[1], at0[2]]], a, A, B), item.ref + " reference field");
    assert.equal(at1[3], at0[3], "raw field angle unchanged");
    near(fresh.x, item.x); near(fresh.y, item.y);
  }
});

t("setSymbolMirror adds/removes (mirror …) and maps pins through KiCad's transform", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  H.setSymbolMirror(node, "y");
  assert.deepEqual(H.kid(node, "mirror"), ["mirror", "y"]);
  const fresh = roundtrip(sch, item, node);
  samePts(pinPts(sch, fresh), remap(pinPts(sch, item), [item.x, item.y], H.symbolT(item.rot, ""), H.symbolT(item.rot, "y")), "mirror y pins");
  // undo it: pins and fields land back where they were
  H.setSymbolMirror(node, "");
  assert.equal(H.kid(node, "mirror"), null);
  const back = roundtrip(sch, item, node);
  samePts(pinPts(sch, back), pinPts(sch, item), "back pins");
  for (const p of H.kids(item.node, "property")) assert.deepEqual(H.kid(H.field(back.node, H.str(p[1])), "at"), H.kid(p, "at"));
  // a symbol that starts mirrored
  const gnd = find(sch, (it) => it.kind === "symbol" && H.mirrorOf(it.node) === "x"); const g = clone(gnd.node);
  H.setSymbolMirror(g, "");
  const gf = roundtrip(sch, gnd, g);
  samePts(pinPts(sch, gf), remap(pinPts(sch, gnd), [gnd.x, gnd.y], H.symbolT(gnd.rot, "x"), H.symbolT(gnd.rot, "")), "unmirrored pins");
});

t("setSymbolFlag writes (dnp yes) / (in_bom no) and creates missing flags", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  H.setSymbolFlag(node, "dnp", true); H.setSymbolFlag(node, "in_bom", false);
  H.delKid(node, "exclude_from_sim"); H.setSymbolFlag(node, "exclude_from_sim", true);
  const s = K.serialize(node);
  assert.match(s, /\(dnp yes\)/); assert.match(s, /\(in_bom no\)/); assert.match(s, /\(exclude_from_sim yes\)/);
  assert.ok(s.indexOf("(exclude_from_sim yes)") < s.indexOf("(uuid"), "flag sits before the uuid");
  const fresh = roundtrip(sch, item, node);
  assert.ok(fresh.geom.some((g) => g.color === K.SCH.dnp), "DNP cross drawn");
  assert.equal(H.yes(fresh.node, "in_bom", true), false);
  assert.ok(!item.geom.some((g) => g.color === K.SCH.dnp), "original untouched");
});

t("setSymbolUnit sets (unit n)", () => {
  const item = byRef(sch, "symbol", "R11"); const node = clone(item.node);
  H.setSymbolUnit(node, 2);
  assert.equal(roundtrip(sch, item, node).unit, 2);
  assert.equal(H.libUnitCount(sch, item.node), 1);
});

// ---------------------------------------------------------------- footprints
t("setField edits footprint fields", () => {
  const item = byRef(pcb, "footprint", "R7"); const node = clone(item.node);
  H.setField(node, "Reference", "R70"); H.setField(node, "Value", "1k");
  const fresh = roundtrip(pcb, item, node);
  assert.equal(fresh.ref, "R70"); assert.equal(fresh.value, "1k"); assert.equal(fresh.layer, "B.Cu");
  const p = H.setField(node, "Note", "x"); assert.equal(H.str(H.kid(p, "layer")[1]), "B.Fab");
});

t("setFootprintPosition moves the anchor and every pad with it", () => {
  const item = byRef(pcb, "footprint", "R7"); const node = clone(item.node);
  H.setFootprintPosition(node, 150, 90);
  const fresh = roundtrip(pcb, item, node);
  near(fresh.x, 150); near(fresh.y, 90); assert.equal(fresh.rot, item.rot);
  const dx = 150 - item.x, dy = 90 - item.y;
  samePts(padCentres(fresh), padCentres(item).map(([x, y]) => [x + dx, y + dy]), "pads");
});

t("setFootprintRotation carries the absolute pad and text angles along", () => {
  const item = byRef(pcb, "footprint", "R7"); const node = clone(item.node);   // -135 in the file
  assert.equal(H.setFootprintRotation(node, -135), false, "no-op");
  H.setFootprintRotation(node, 45);
  const fresh = roundtrip(pcb, item, node);
  assert.equal(fresh.rot, 45);
  H.kids(item.node, "pad").forEach((p, i) => assert.equal(H.kid(H.kids(fresh.node, "pad")[i], "at")[3], H.normDeg(H.num(H.kid(p, "at")[3]) + 180)));
  assert.equal(H.kid(H.field(fresh.node, "Reference"), "at")[3], -135);
  assert.equal(H.kid(H.field(fresh.node, "Datasheet"), "at")[3], 45);
  samePts(padCentres(fresh), padCentres(item).map(([x, y]) => [2 * item.x - x, 2 * item.y - y]), "pads turned 180°");
  const d4 = byRef(pcb, "footprint", "D4"); const n2 = clone(d4.node);   // -90 → 0 on the front
  H.setFootprintRotation(n2, 0);
  const f2 = roundtrip(pcb, d4, n2); assert.equal(f2.rot, 0);
  for (const p of H.kids(f2.node, "pad")) assert.equal(H.kid(p, "at")[3], 0);
});

t("setFootprintSide flips like KiCad: local Y mirrored, angles negated, layers swapped, text mirror toggled", () => {
  const item = byRef(pcb, "footprint", "R7"); const node = clone(item.node);
  assert.equal(H.setFootprintSide(node, "B.Cu"), false, "already there");
  H.setFootprintSide(node, "F.Cu");
  const fresh = roundtrip(pcb, item, node);
  assert.equal(fresh.layer, "F.Cu"); assert.equal(fresh.rot, 135);
  near(fresh.x, item.x); near(fresh.y, item.y);
  for (const p of H.kids(fresh.node, "pad")) { assert.deepEqual(H.kid(p, "layers").slice(1), ["F.Cu", "F.Mask", "F.Paste"]); assert.equal(H.kid(p, "at")[3], 135); }
  samePts(padCentres(fresh), padCentres(item).map(([x, y]) => [x, 2 * item.y - y]), "pads mirrored about the anchor's X axis");
  const ref0 = H.field(item.node, "Reference"), ref1 = H.field(fresh.node, "Reference");
  assert.equal(H.str(H.kid(ref1, "layer")[1]), "F.SilkS");
  near(H.kid(ref1, "at")[2], -H.kid(ref0, "at")[2]); assert.equal(H.kid(ref1, "at")[3], -45);
  assert.equal(H.kid(H.kid(ref1, "effects"), "justify"), null, "mirror flag dropped on the front");
  assert.equal(H.str(H.kid(H.field(fresh.node, "Value"), "layer")[1]), "F.Fab");
  const line0 = H.kids(item.node, "fp_line")[0], line1 = H.kids(fresh.node, "fp_line")[0];
  near(H.kid(line1, "start")[2], -H.kid(line0, "start")[2]); assert.equal(H.str(H.kid(line1, "layer")[1]), "F.CrtYd");
  assert.ok(fresh.geom.some((g) => g.layer === "F.SilkS"), "silk drawn on the front");
  // flipping back is exact
  H.setFootprintSide(node, "B.Cu");
  assert.equal(K.serialize(node), K.serialize(item.node));
  // and the front-side part: text on the back gets (justify mirror)
  const d4 = byRef(pcb, "footprint", "D4"); const n2 = clone(d4.node);
  H.setFootprintSide(n2, "B.Cu", false);
  const f2 = roundtrip(pcb, d4, n2);
  assert.equal(f2.layer, "B.Cu"); assert.equal(f2.rot, 90);
  assert.ok(H.kid(H.kid(H.field(f2.node, "Reference"), "effects"), "justify").includes("mirror"));
  assert.ok(f2.geom.some((g) => g.t === "text" && g.mirror), "mirrored text geometry");
  // KiCad's left/right flip direction maps the orientation to 180 − θ
  const n3 = clone(d4.node); H.setFootprintSide(n3, "B.Cu", true);
  assert.equal(K.atOf(n3)[2], -90); assert.equal(H.kid(H.kids(n3, "pad")[0], "at")[3], -90);
});

t("setFootprintAttrs keeps unknown tokens and drops an empty attr", () => {
  const item = byRef(pcb, "footprint", "R7"); const node = clone(item.node);
  assert.deepEqual(H.kid(node, "attr"), ["attr", "smd"]);
  H.setFootprintAttrs(node, { dnp: true }); assert.deepEqual(H.kid(node, "attr"), ["attr", "smd", "dnp"]);
  H.setFootprintAttrs(node, { exclude_from_bom: true, type: "through_hole" }); assert.deepEqual(H.kid(node, "attr"), ["attr", "through_hole", "exclude_from_bom", "dnp"]);
  const a = H.footprintAttrs(roundtrip(pcb, item, node).node); assert.equal(a.type, "through_hole"); assert.ok(a.dnp && a.exclude_from_bom && !a.exclude_from_pos_files);
  H.setFootprintAttrs(node, { type: "", dnp: false, exclude_from_bom: false }); assert.equal(H.kid(node, "attr"), null);
  const bridged = find(pcb, (it) => it.kind === "footprint" && H.footprintAttrs(it.node).allow_soldermask_bridges); const b = clone(bridged.node);
  H.kid(b, "attr").push("future_flag");
  H.setFootprintAttrs(b, { dnp: true });
  assert.deepEqual(H.kid(b, "attr").slice(1), ["exclude_from_pos_files", "dnp", "allow_soldermask_bridges", "future_flag"]);
  assert.deepEqual(H.footprintAttrs(roundtrip(pcb, bridged, b).node).other, ["future_flag"]);
});

t("padList and netNameOf read pads, inline net names and the numbered net table", () => {
  const pads = H.padList(pcb, byRef(pcb, "footprint", "R7").node);
  assert.deepEqual(pads.map((p) => [p.number, p.shape, p.w, p.h, p.net]), [["1", "roundrect", 0.4, 0.5, "Net-(D15-1)"], ["2", "roundrect", 0.4, 0.5, "/LED1"]]);
  assert.deepEqual(pads[0].layers, ["B.Cu", "B.Mask", "B.Paste"]);
  assert.equal(H.netNameOf(pcb, find(pcb, (it) => it.kind === "segment" && H.str(H.kid(it.node, "net")[1]) === "").node), "");
  assert.equal(H.netNameOf(pcb, find(pcb, (it) => it.kind === "via").node), "GND");
  const fake = { items: new Map([["f", { kind: "footprint", node: ["footprint", "x", ["pad", "1", "smd", "rect", ["net", 7, "SYN"]]] }]]) };
  assert.equal(H.netNameOf(fake, ["segment", ["net", 7]]), "SYN");
  assert.equal(H.netNameOf(fake, ["segment", ["net", 0]]), "");
  assert.equal(H.netNameOf(fake, ["segment", ["net", 9]]), "#9");
  assert.equal(H.netNameOf(fake, ["segment", ["net", 3, "GND"]]), "GND");
  assert.equal(H.netNameOf(fake, ["zone", ["net", 3], ["net_name", "VCC"]]), "VCC");
});

// ---------------------------------------------------------------- other items
t("wire stroke width", () => {
  const item = find(sch, (it) => it.kind === "wire"); const node = clone(item.node);
  H.setStrokeWidth(node, 0.5);
  assert.match(K.serialize(node), /\(stroke \(width 0\.5\) \(type solid\)\)/);
  assert.equal(roundtrip(sch, item, node).geom[0].w, 0.5);
  const bare = ["wire", ["pts", ["xy", 0, 0], ["xy", 1, 0]], ["uuid", "w1"]]; H.setStrokeWidth(bare, 0.25);
  assert.deepEqual(bare[2], ["stroke", ["width", 0.25]]);
});

t("track width and layer", () => {
  const item = find(pcb, (it) => it.kind === "segment"); const node = clone(item.node);
  H.setWidth(node, 0.3); H.setLayer(node, "B.Cu");
  const g = roundtrip(pcb, item, node).geom[0];
  assert.equal(g.w, 0.3); assert.equal(g.layer, "B.Cu");
  assert.ok(H.boardLayers(pcb, true).includes("F.Cu") && H.boardLayers(pcb, true).includes("B.Cu") && !H.boardLayers(pcb, true).includes("F.SilkS"));
  assert.ok(H.boardLayers(pcb, false).includes("F.SilkS"));
});

t("via size, drill and layers", () => {
  const item = find(pcb, (it) => it.kind === "via"); const node = clone(item.node);
  H.setViaSize(node, 0.6); H.setViaDrill(node, 0.25); H.setViaLayers(node, "In1.Cu", "B.Cu");
  const fresh = roundtrip(pcb, item, node);
  near(fresh.geom[0].r, 0.3); near(fresh.geom[1].r, 0.125);
  assert.deepEqual(H.kid(fresh.node, "layers"), ["layers", "In1.Cu", "B.Cu"]);
});

t("label text, rotation, size and shape", () => {
  const item = find(sch, (it) => it.kind === "label"); const node = clone(item.node);
  H.setText(node, "LED9"); H.setRotation(node, 90); H.setTextSize(node, 2);
  const fresh = roundtrip(sch, item, node);
  assert.equal(fresh.node[1], "LED9"); assert.equal(K.atOf(fresh.node)[2], 90); assert.equal(H.textSize(fresh.node), 2);
  assert.equal(fresh.geom.find((g) => g.t === "text").size, 2);
  const gl = K.addItem(sch, ["global_label", "X", ["shape", "input"], ["at", 100, 100, 0], ["effects", ["font", ["size", 1.27, 1.27]]], ["uuid", "test-glabel"]]);
  try {
    const n2 = clone(gl.node); H.setShape(n2, "output");
    assert.deepEqual(H.kid(roundtrip(sch, gl, n2).node, "shape"), ["shape", "output"]);
    const n3 = ["hierarchical_label", "Y", ["at", 1, 2, 0], ["uuid", "h"]]; H.setShape(n3, "passive");
    assert.deepEqual(n3[2], ["shape", "passive"]);
  } finally { sch.items.delete(gl.id); }
});

t("multi-line text and rotation", () => {
  const item = find(sch, (it) => it.kind === "text"); const node = clone(item.node);
  H.setText(node, "line one\nline \"two\""); H.setRotation(node, 90);
  const fresh = roundtrip(sch, item, node);
  assert.equal(fresh.node[1], "line one\nline \"two\""); assert.equal(K.atOf(fresh.node)[2], 90);
  assert.equal(fresh.geom.filter((g) => g.t === "text").length, 2);
  const gt = find(pcb, (it) => it.kind === "gr_text"); const n2 = clone(gt.node);
  H.setLayer(n2, "B.SilkS"); H.setTextSize(n2, 1);
  const f2 = roundtrip(pcb, gt, n2); assert.equal(f2.geom[0].layer, "B.SilkS"); assert.equal(f2.geom[0].size, 1);
});

t("junction diameter", () => {
  const item = find(sch, (it) => it.kind === "junction"); const node = clone(item.node);
  H.setDiameter(node, 1.5);
  near(roundtrip(sch, item, node).geom[0].r, 0.75);
});

t("zone name and priority", () => {
  const item = find(pcb, (it) => it.kind === "zone"); const node = clone(item.node);
  H.setZoneName(node, "GND fill"); H.setZonePriority(node, 2);
  const fresh = roundtrip(pcb, item, node);
  assert.deepEqual(H.kid(fresh.node, "name"), ["name", "GND fill"]); assert.deepEqual(H.kid(fresh.node, "priority"), ["priority", 2]);
  assert.equal(H.netNameOf(pcb, fresh.node), "GND");
  H.setZoneName(node, ""); H.setZonePriority(node, 0);
  assert.equal(H.kid(node, "name"), null); assert.equal(H.kid(node, "priority"), null);
});
