// node server/static/tests/vrml.test.js — the VRML export (server/web/fab/vrml.ts), reached through the bundle's
// KiCadFab: the file is laid out as pcbnew's exporter_vrml.cpp writes it, the board body is a closed solid of the
// right volume, every layer faces the right way, and a part's Transform puts its model where the 3D viewer's own
// placement (viewer3d/models.ts placeMesh, a separate reading of KiCad's 3D viewer) puts it.
// `npm run build` must have produced static/dist/fab.js, static/dist/viewer3d.js and static/kicad-canvas.js first.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
require(path.join(__dirname, "..", "dist", "viewer3d.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab, V = globalThis.KiCadViewer3D;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

const model = (lib, name, extra) => `(model "\${KICAD10_3DMODEL_DIR}/${lib}.3dshapes/${name}.step" ${extra || "(offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))"})`;
const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6))
 (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen")
  (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (35 "F.Fab" user) (33 "B.Fab" user))
 (setup (pad_to_mask_clearance 0.05) (tenting (front yes) (back yes)))
 (net 0 "") (net 1 "GND")
 (gr_rect (start 100 50) (end 130 70) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 (gr_circle (center 125 65) (end 127 65) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "cut"))
 (gr_text "TOP" (at 110 68) (layer "F.SilkS") (uuid "t1") (effects (font (size 1.5 1.5) (thickness 0.2))))
 (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (uuid "f-R1") (at 105 55 30) (attr smd)
  (property "Reference" "R1" (at 0 -1.5 30) (layer "F.SilkS") (uuid "r-R1") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "10k" (at 0 1.5 30) (layer "F.Fab") (uuid "v-R1") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd roundrect (at -0.825 0 30) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net 1 "GND") (uuid "p-R1-1"))
  (pad "2" smd roundrect (at 0.825 0 30) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "p-R1-2"))
  ${model("Resistor_SMD", "R_0603_1608Metric", "(offset (xyz 0.5 0.25 0.1)) (scale (xyz 1 2 1.5)) (rotate (xyz 10 20 30))")})
 (footprint "Resistor_SMD:R_0603_1608Metric" (layer "B.Cu") (uuid "f-R2") (at 118 64 45) (attr smd)
  (property "Reference" "R2" (at 0 -1.5 45) (layer "B.SilkS") (uuid "r-R2") (effects (font (size 1 1) (thickness 0.15)) (justify mirror)))
  (property "Value" "10k" (at 0 1.5 45) (layer "B.Fab") (uuid "v-R2") (effects (font (size 1 1) (thickness 0.15)) (justify mirror)))
  (pad "1" smd roundrect (at -0.825 0 45) (size 0.8 0.95) (layers "B.Cu" "B.Mask" "B.Paste") (roundrect_rratio 0.25) (net 1 "GND") (uuid "p-R2-1"))
  (pad "2" smd roundrect (at 0.825 0 45) (size 0.8 0.95) (layers "B.Cu" "B.Mask" "B.Paste") (roundrect_rratio 0.25) (uuid "p-R2-2"))
  ${model("Resistor_SMD", "R_0603_1608Metric", "(offset (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 15 -25 40))")})
 (footprint "Connector:Pin" (layer "F.Cu") (uuid "f-J1") (at 110 60) (attr through_hole)
  (property "Reference" "J1" (at 0 -2.5) (layer "F.SilkS") (uuid "r-J1") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "Pin" (at 0 2.5) (layer "F.Fab") (uuid "v-J1") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "p-J1-1"))
  (pad "" np_thru_hole circle (at 5 0) (size 2 2) (drill 2) (layers "*.Cu" "*.Mask") (uuid "p-J1-2"))
  ${model("Connector", "Missing")})
 (segment (start 105 55) (end 110 60) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
 (via (at 120 55) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")))`;

const doc = K.parseDoc(BOARD, "kicad_pcb");
const ctx = { doc, setup: BOARD, projectName: "vrml" };
// a lopsided little solid, so a wrong turn or a mirror shows
const mesh = { pos: new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0.5]), nrm: new Float32Array(12), col: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]), idx: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 3, 1, 2]) };
const OPT = { unit: 0.001, separateModels: true, relativePaths: true, subdir: "/tmp/out/components", xref: 0, yref: 0, includeUnspecified: true, includeDnp: true, fileName: "/tmp/out/pcb.wrl" };
const out = F.writeVrml(ctx, OPT, (url) => (/Missing/.test(url) ? null : mesh));

// a reader for what the writer writes: the part Transforms and the layer Shapes
function read(text) {
  const parts = []; const re = /Transform \{\n(?:  rotation ([^\n]*)\n)?  translation ([^\n]*)\n  scale ([^\n]*)\n  children \[\n    Inline \{\n      url "([^"]*)"\n    \} \]\n  \}\n/g; let m;
  while ((m = re.exec(text))) parts.push({ rot: m[1] ? m[1].split(" ").map(Number) : null, t: m[2].split(" ").map(Number), s: m[3].split(" ").map(Number), url: m[4] });
  const shapes = []; const rs = /diffuseColor ([^\n]*)\n[\s\S]*?point \[\n([\s\S]*?)\n\s*\]\n\s*\}\n\s*coordIndex \[\n([\s\S]*?)\n\s*\]/g;
  while ((m = rs.exec(text))) {
    const pts = m[2].trim() ? m[2].split(",").map((p) => p.trim().split(/\s+/).map(Number)) : [];
    const ix = m[3].trim() ? m[3].split(",").map((v) => parseInt(v, 10)) : []; const tris = [];
    for (let i = 0; i + 3 < ix.length + 1; i += 4) { assert.strictEqual(ix[i + 3], -1); tris.push([ix[i], ix[i + 1], ix[i + 2]]); }
    shapes.push({ color: m[1], pts, tris });
  }
  return { parts, shapes };
}
const got = read(out.text);
const normalZ = (s, t) => { const [a, b, c] = t.map((i) => s.pts[i]); return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); };
const areaOf = (s) => s.tris.reduce((sum, t) => sum + Math.abs(normalZ(s, t)) / 2, 0) * 2.54 * 2.54;   // mm²

test("the file opens as pcbnew's does: header, title, one Transform with the world scale", () => {
  assert.ok(out.text.startsWith('#VRML V2.0 utf8\nWorldInfo {\n  title "/tmp/out/pcb.wrl - Generated by Pcbnew"\n}\nTransform {\n  scale 0.00254 0.00254 0.00254\n  children [\n'));
  assert.ok(out.text.endsWith("]\n}\n"));
});
test("ten layer shapes in pcbnew's order", () => {
  assert.strictEqual(got.shapes.length, 10);
  const col = got.shapes.map((s) => s.color);
  assert.strictEqual(col[1], col[4]); assert.strictEqual(col[2], col[5]); assert.strictEqual(col[3], col[6]); assert.strictEqual(col[8], col[9]); assert.strictEqual(col[7], col[2]);
  assert.notStrictEqual(col[0], col[1]);
});
test("the board body is a closed solid of the outline less the cut-out and the holes, 1.6 mm thick", () => {
  const s = got.shapes[0]; const edges = new Map();
  for (const t of s.tris) for (let i = 0; i < 3; i++) { const a = t[i], b = t[(i + 1) % 3]; edges.set(a + ">" + b, (edges.get(a + ">" + b) || 0) + 1); }
  for (const [k, n] of edges) { const [a, b] = k.split(">"); assert.strictEqual(n, 1, "edge " + k + " used " + n + " times"); assert.strictEqual(edges.get(b + ">" + a), 1, "edge " + k + " has no partner"); }
  // the volume by the divergence theorem, in mm³
  let vol = 0; for (const t of s.tris) { const [a, b, c] = t.map((i) => s.pts[i]); vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
  vol *= 2.54 ** 3;
  const plated = Math.PI * (0.5 + 0.005 * 2.54) ** 2;      // the pad's hole, cut wider by the plating
  const area = 30 * 20 - Math.PI * 2 * 2 - plated - Math.PI * 1 * 1 - Math.PI * 0.2 * 0.2;
  const want = area * (1.6 - 0.025);
  assert.ok(Math.abs(vol - want) / want < 0.01, `volume ${vol.toFixed(2)} mm³, expected about ${want.toFixed(2)}`);
});
test("top layers face up, bottom layers face down", () => {
  for (const i of [1, 2, 3, 8]) for (const t of got.shapes[i].tris) assert.ok(normalZ(got.shapes[i], t) > 0, "layer " + i + " has a face turned down");
  for (const i of [4, 5, 6, 9]) for (const t of got.shapes[i].tris) assert.ok(normalZ(got.shapes[i], t) < 0, "layer " + i + " has a face turned up");
  const z = (i) => got.shapes[i].pts[0][2] * 2.54;
  assert.ok(Math.abs(z(1) - 0.8) < 1e-4 && Math.abs(z(4) + 0.8) < 1e-4); assert.ok(z(8) > z(3) && z(3) > z(1)); assert.ok(z(9) < z(6) && z(6) < z(4));
});
test("each layer covers what is drawn on it", () => {
  const pad = 0.8 * 0.95 - (4 - Math.PI) * (0.2 * 0.2);            // a rounded rectangle, corner radius 0.25 of 0.8
  // top paste: R1's two pads; bottom paste: R2's
  assert.ok(Math.abs(areaOf(got.shapes[2]) - 2 * pad) < 0.02, "top paste " + areaOf(got.shapes[2])); assert.ok(Math.abs(areaOf(got.shapes[5]) - 2 * pad) < 0.02, "bottom paste " + areaOf(got.shapes[5]));
  // top copper holds R1's pads, the pin's ring, the via's ring and the track; bottom copper has no track
  assert.ok(areaOf(got.shapes[1]) > areaOf(got.shapes[4]) + 1); assert.ok(areaOf(got.shapes[4]) > 2 * pad + 2);
  // the mask is the board less its openings
  const board = 30 * 20 - Math.PI * 4;
  assert.ok(areaOf(got.shapes[3]) < board - 2 * pad - 2 && areaOf(got.shapes[3]) > board - 20, "top mask " + areaOf(got.shapes[3]));
  // the legend: the text and R1's and J1's references
  assert.ok(areaOf(got.shapes[8]) > 1 && areaOf(got.shapes[8]) < 40); assert.ok(areaOf(got.shapes[9]) > 0.2);
});
test("the plated barrels are walls only, around the pin's hole and the via", () => {
  const s = got.shapes[7]; assert.ok(s.tris.length > 0); assert.strictEqual(s.tris.length, s.pts.length);
  const xs = new Set(s.pts.map((p) => Math.round(p[0] * 2.54))); assert.ok(xs.has(110) && xs.has(120) && !xs.has(115), "the unplated hole has no barrel");
  // seen from inside the hole: each wall's normal points at the hole's axis
  for (const t of s.tris) {
    const [a, b, c] = t.map((i) => s.pts[i]); const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])];
    const cx = (Math.round(a[0] * 2.54) === 110 ? 110 : 120) / 2.54, cy = (Math.round(a[0] * 2.54) === 110 ? -60 : -55) / 2.54;
    assert.ok(n[0] * (cx - a[0]) + n[1] * (cy - a[1]) > 0, "a barrel wall faces away from its hole");
  }
});
test("a part's Transform puts its model where the 3D viewer puts it, front and back", () => {
  assert.strictEqual(got.parts.length, 2); assert.deepStrictEqual(out.stats.missing, ["Connector/Missing"]); assert.strictEqual(out.stats.placed, 2);
  assert.ok(got.parts.every((p) => p.url === "components/R_0603_1608Metric.wrl"));
  assert.strictEqual(out.models.length, 1); assert.strictEqual(out.models[0].name, "R_0603_1608Metric.wrl");
  // the model file's own points, in its unit
  const file = read("Transform {\n" + out.models[0].text).shapes; const pts = []; for (const s of file) for (const t of s.tris) for (const i of t) pts.push(s.pts[i]);
  assert.strictEqual(pts.length, 12);
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint" || (it.node && it.node[0] === "footprint")).map((it) => it.node).filter((n) => /R_0603/.test(String(n[1])));
  assert.strictEqual(fps.length, 2);
  const at = [{ x: 105, y: -55, z: 0.8, rot: 30, back: false }, { x: 118, y: -64, z: -0.8, rot: 45, back: true }];
  got.parts.forEach((p, k) => {
    const ref = V.geometry.footprintModels(fps[k])[0];
    // the viewer's placement of the mesh, mm, Y up
    const want = []; V.geometry.placeMesh(mesh, ref, at[k], (x, y, z) => want.push([x, y, z]));
    // the file's: scale, turn about the axis, move; then the world's 2.54
    const turn = (v) => {
      if (!p.rot) return v; const [ax, ay, az, a] = p.rot; const l = Math.hypot(ax, ay, az), u = [ax / l, ay / l, az / l], c = Math.cos(a), s = Math.sin(a);
      const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2], cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      return [0, 1, 2].map((i) => v[i] * c + cr[i] * s + u[i] * d * (1 - c));
    };
    const seen = new Map(); for (const q of pts) seen.set(q.join(","), q);
    const mine = Array.from(seen.values()).map((q) => turn([q[0] * p.s[0], q[1] * p.s[1], q[2] * p.s[2]]).map((v, i) => (v + p.t[i]) * 2.54));
    for (const w of want) assert.ok(mine.some((q) => Math.hypot(q[0] - w[0], q[1] - w[1], q[2] - w[2]) < 0.002), `part ${k}: the viewer has a corner at ${w.map((v) => v.toFixed(3))}, the file has ${mine.map((q) => q.map((v) => v.toFixed(3)).join(" ")).join(" | ")}`);
  });
});
test("models written into the board file itself when no model files are asked for", () => {
  const one = F.writeVrml(ctx, Object.assign({}, OPT, { separateModels: false }), (url) => (/Missing/.test(url) ? null : mesh));
  assert.strictEqual(one.models.length, 0); assert.ok(!/Inline/.test(one.text)); assert.strictEqual(read(one.text).shapes.length, 10 + 2 * 2);
});
test("parts left out as the options say; the reference point moves everything", () => {
  const few = F.writeVrml(ctx, Object.assign({}, OPT, { xref: 100, yref: 50 }), () => mesh);
  const r = read(few.text); assert.strictEqual(r.parts.length, 3);
  const xs = r.shapes[0].pts.map((p) => p[0] * 2.54), ys = r.shapes[0].pts.map((p) => p[1] * 2.54);
  assert.ok(Math.abs(Math.min(...xs)) < 1e-3 && Math.abs(Math.max(...xs) - 30) < 1e-3 && Math.abs(Math.max(...ys)) < 1e-3 && Math.abs(Math.min(...ys) + 20) < 1e-3);
  assert.throws(() => F.writeVrml(ctx, Object.assign({}, OPT, { unit: 100 }), () => mesh), /WorldScale out of range/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
