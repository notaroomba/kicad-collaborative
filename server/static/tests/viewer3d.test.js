// node server/static/tests/viewer3d.test.js — the 3D viewer's board geometry (server/web/viewer3d: outline.ts,
// bodies.ts, textures.ts), reached through the bundle's KiCadViewer3D.geometry.  No WebGL and no DOM needed:
// `npm run build` must have produced static/dist/viewer3d.js and static/kicad-canvas.js first.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "viewer3d.js"));
const K = globalThis.KiCadCanvas;
const G = globalThis.KiCadViewer3D.geometry;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= (tol || 1e-6), (msg || "") + ` expected ${b}, got ${a}`);

const HEAD = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.2))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user))
 (net 0 "") (net 1 "GND")`;
const edge = (body) => body + ` (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`;
// a 40 x 30 board with rounded top-right corner (arc), drawn as unordered segments, plus a circular and a rectangular cut-out
const OUTLINE = [
  edge(`(gr_line (start 40 30) (end 0 30)`),
  edge(`(gr_line (start 0 0) (end 35 0)`),
  edge(`(gr_line (start 0 30) (end 0 0)`),
  edge(`(gr_arc (start 35 0) (mid 38.535534 1.464466) (end 40 5)`),
  edge(`(gr_line (start 40 5) (end 40 30)`),
  edge(`(gr_circle (center 10 10) (end 13 10)`),
  edge(`(gr_rect (start 20 15) (end 30 25)`),
].join("\n");
const FP = (ref, at, attr, pads, extra) => `(footprint "Lib:${ref}" (layer "${/B\.Cu/.test(extra || "") ? "B.Cu" : "F.Cu"}") (uuid "00000000-0000-0000-0000-0000000000${ref.length}${ref.charCodeAt(0)}") (at ${at})
  (property "Reference" "${ref}" (at 0 -2) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  ${attr ? `(attr ${attr})` : ""}
  (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd"))
  ${pads})`;
const SMD_PADS = `(pad "1" smd rect (at -1 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste")) (pad "2" smd rect (at 1 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste"))`;
const THT_PADS = `(pad "1" thru_hole circle (at -1.27 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask")) (pad "2" thru_hole oval (at 1.27 0) (size 1.6 2.4) (drill oval 0.8 1.6) (layers "*.Cu" "*.Mask"))`;
const BOARD = `${HEAD}
${OUTLINE}
${FP("R1", "5 22 90", "smd", SMD_PADS)}
${FP("U2", "34 12", "through_hole", THT_PADS)}
${FP("H3", "5 5", "", `(pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask"))`)}
 (via (at 16 26) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "aaaaaaaa-0000-0000-0000-000000000001"))
 (via (at 10 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "aaaaaaaa-0000-0000-0000-000000000002"))
 (via (at 0.1 15) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "aaaaaaaa-0000-0000-0000-000000000003"))
 (segment (start 5 22) (end 16 26) (width 0.25) (layer "F.Cu") (net 1) (uuid "aaaaaaaa-0000-0000-0000-000000000004"))
 (zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "aaaaaaaa-0000-0000-0000-000000000005") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25)
  (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
  (polygon (pts (xy 1 1) (xy 39 1) (xy 39 29) (xy 1 29)))
  (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 39 1) (xy 39 29) (xy 1 29))))
)`;
const doc = K.parseDoc(BOARD, "kicad_pcb");

test("board thickness is read from (general (thickness …))", () => { near(doc.thickness, 1.2); });

test("Edge.Cuts segments and arcs chain into one outline with its cut-outs", () => {
  const s = G.boardShape(doc);
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.outlines.length, 1, "one outline");
  assert.strictEqual(s.outlines[0].cutouts.length, 2, "circle + rectangle cut-outs");
  near(s.bbox[0], 0); near(s.bbox[1], 0); near(s.bbox[2], 40, 1e-3); near(s.bbox[3], 30);
  // 40 x 30 minus the corner the quarter-circle of radius 5 rounds off: 25 - pi*25/4
  near(Math.abs(G.polyArea(s.outlines[0].contour)), 1200 - (25 - Math.PI * 25 / 4), 0.05, "outline area");
  const areas = s.outlines[0].cutouts.map((c) => Math.abs(G.polyArea(c))).sort((a, b) => a - b);
  near(areas[0], Math.PI * 9, 0.2, "circular cut-out (a polygon inscribed in the circle)"); near(areas[1], 100, 1e-6, "rectangular cut-out");
});

test("an unclosed outline falls back to the board's bounding box", () => {
  const open = K.parseDoc(`${HEAD}\n${edge("(gr_line (start 0 0) (end 30 0)")}\n${edge("(gr_line (start 30 0) (end 30 20)")}\n (segment (start 2 2) (end 20 12) (width 0.25) (layer "F.Cu") (net 1) (uuid "bbbbbbbb-0000-0000-0000-000000000001")))`, "kicad_pcb");
  const s = G.boardShape(open);
  assert.strictEqual(s.fallback, true);
  assert.strictEqual(s.outlines.length, 1); assert.strictEqual(s.outlines[0].contour.length, 4);
});

test("outline ends that miss by a few hundredths still close", () => {
  const sloppy = K.parseDoc(`${HEAD}\n${edge("(gr_line (start 0 0) (end 30 0.04)")}\n${edge("(gr_line (start 30 0) (end 30 20)")}\n${edge("(gr_line (start 30.03 20) (end 0 20)")}\n${edge("(gr_line (start 0 20.02) (end 0 0)")})`, "kicad_pcb");
  const s = G.boardShape(sloppy);
  assert.strictEqual(s.fallback, false); near(Math.abs(G.polyArea(s.outlines[0].contour)), 600, 2);
});

test("nested loops alternate outline / cut-out / island", () => {
  const sq = (c, r) => [[c - r, c - r], [c + r, c - r], [c + r, c + r], [c - r, c + r]];
  const o = G.nestLoops([sq(0, 1), sq(0, 10), sq(0, 5), sq(30, 2)]);
  assert.strictEqual(o.length, 3, "outer board, the island inside its cut-out, and a second board");
  const outer = o.find((x) => Math.abs(G.polyArea(x.contour)) === 400);
  assert.strictEqual(outer.cutouts.length, 1); near(Math.abs(G.polyArea(outer.cutouts[0])), 100);
});

test("arcs are sampled the way the canvas draws them", () => {
  const q = G.arcPoints(0, 0, 5, 0, Math.PI / 2, false);
  near(q[0][0], 5); near(q[0][1], 0); near(q[q.length - 1][0], 0, 1e-9); near(q[q.length - 1][1], 5);
  const mid = q[Math.floor(q.length / 2)]; assert(mid[0] > 0 && mid[1] > 0, "the short way round");
  const long = G.arcPoints(0, 0, 5, 0, Math.PI / 2, true);
  assert(long.some((p) => p[0] < -4.9), "anticlockwise goes the long way");
  for (const p of long) near(Math.hypot(p[0], p[1]), 5, 1e-9);
});

test("oval drills are stadiums in the pad's orientation", () => {
  const o = G.ovalPoints(0, 0, 0.8, 1.6, 0);
  const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]);
  near(Math.max(...xs), 0.4, 1e-9); near(Math.min(...xs), -0.4, 1e-9); near(Math.max(...ys), 0.8, 1e-9); near(Math.min(...ys), -0.8, 1e-9);
  near(Math.abs(G.polyArea(o)), 0.8 * 0.8 + Math.PI * 0.16, 0.02);
  const r = G.ovalPoints(0, 0, 0.8, 1.6, 90);
  near(Math.max(...r.map((p) => p[0])), 0.8, 1e-9, "rotated 90°: long axis along X");
});

test("drilled holes: vias, pad drills, NPTH; one per plated pad", () => {
  const holes = G.boardHoles(doc);
  assert.strictEqual(holes.length, 6, "3 vias + 2 pad drills + 1 NPTH");
  const npth = holes.filter((h) => !h.plated); assert.strictEqual(npth.length, 1); near(npth[0].r, 1.1); near(npth[0].x, 5); near(npth[0].y, 5);
  const via = holes.find((h) => h.via && h.x === 16); near(via.r, 0.2);
  const oval = holes.find((h) => !h.via && h.plated && Math.abs(h.r - 0.8) < 1e-9); assert(oval, "the oval drill keeps its true size, not the plating wall's");
  near(oval.x, 34 + 1.27); near(oval.y, 12);
});

test("holes are cut only where the board is solid around them", () => {
  const s = G.boardShape(doc); const holes = G.boardHoles(doc);
  const { perOutline, rest } = G.assignHoles(s, holes);
  assert.strictEqual(perOutline[0].length, 4, "via at 16,26, the two pad drills and the NPTH");
  assert.strictEqual(rest.length, 2, "the via inside the circular cut-out and the one on the board edge are only painted");
  assert(rest.some((h) => h.x === 10 && h.y === 10) && rest.some((h) => h.x === 0.1));
  // two overlapping holes: the larger is cut, the smaller painted
  const big = { x: 20, y: 5, r: 1, pts: G.circlePoints(20, 5, 1), plated: true, via: false }, small = { x: 20.5, y: 5, r: 0.3, pts: G.circlePoints(20.5, 5, 0.3), plated: true, via: true };
  const r2 = G.assignHoles(s, [small, big]);
  assert.deepStrictEqual(r2.perOutline[0], [big]); assert.deepStrictEqual(r2.rest, [small]);
});

test("placeholder bodies: class, side, rotation and what gets none", () => {
  const bodies = G.boardBodies(doc);
  assert.strictEqual(bodies.length, 2, "the 1-pad mounting hole has no body");
  const r1 = bodies.find((b) => b.ref === "R1"), u2 = bodies.find((b) => b.ref === "U2");
  assert.strictEqual(r1.cls, "smd"); assert.strictEqual(u2.cls, "tht"); assert.strictEqual(r1.back, false);
  // courtyard 4 x 2 inset by 0.25 -> 3.5 x 1.5, rotated 90°: tall in Y on the board
  const xs = r1.pts.map((p) => p[0]), ys = r1.pts.map((p) => p[1]);
  near(Math.max(...xs) - Math.min(...xs), 1.5, 1e-6); near(Math.max(...ys) - Math.min(...ys), 3.5, 1e-6);
  near((Math.max(...xs) + Math.min(...xs)) / 2, 5, 1e-6); near((Math.max(...ys) + Math.min(...ys)) / 2, 22, 1e-6);
  assert(r1.height >= 0.35 && r1.height <= 0.65, "chip resistor height"); assert(u2.height > r1.height, "a through-hole IC stands taller");
  assert(G.footprintAttrs(["footprint", "x", ["attr", "smd", "dnp"]]).has("dnp"));
});

test("face stencils take artwork, not the editor's display aids", () => {
  const pick = (layer) => { const out = []; for (const it of doc.items.values()) for (const g of it.geom) if (G.stencilGeom(g, layer, it.kind)) out.push([it.kind, g]); return out; };
  const f = pick("F.Cu");
  assert(f.some(([k, g]) => k === "segment" && g.track), "tracks");
  assert(f.some(([k, g]) => k === "footprint" && g.pad), "pads");
  assert(f.some(([k, g]) => k === "via"), "via annulus");
  assert(!f.some(([, g]) => g.padText || g.hole), "no pad numbers, no holes");
  const b = pick("B.Cu");
  assert(b.some(([k, g]) => k === "zone" && g.zoneFill), "zone fill"); assert(!b.some(([k, g]) => k === "zone" && !g.zoneFill), "no zone outline / hatch");
  assert(pick("F.Mask").length >= 4, "mask openings of the pads");
});

test("texture extent respects the GPU limit and the pixel budget", () => {
  const e = G.textureExtent([0, 0, 40, 30], 4096);
  near(e.pxPerMm, 40); assert.strictEqual(e.width, Math.round(40.4 * 40));
  const big = G.textureExtent([0, 0, 320, 110], 8192);
  assert(big.width <= 8192 && big.width * big.height <= 12.1e6, "within the budget"); assert(big.pxPerMm > 15, "still sharp enough for tracks");
  const small = G.textureExtent([0, 0, 320, 110], 2048); assert(small.width <= 2048);
});

test("part models: axial along the leads, DIP with a notch, SOIC with leads, chip ends, cans, headers", () => {
  const pad = (num, x, y, drill, w = 1.6, h = 1.6) => ({ num: String(num), x, y, w, h, drill });
  const top = (ss) => Math.max(...ss.map((s) => (s.k === "prism" ? s.z1 : s.z + s.r)));
  // R_Axial_DIN0207: a 6.3 mm x 2.5 mm cylinder centred between pads 10.16 mm apart, lying along X
  let s = G.partSolids("Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal", "R1", [pad(1, 0, 0, true), pad(2, 10.16, 0, true)], null, null, false);
  const body = s.find((x) => x.k === "cyl" && x.r > 1);
  near(body.r, 1.25); near(Math.abs(body.b[0] - body.a[0]), 6.3, 1e-6); near((body.a[0] + body.b[0]) / 2, 5.08, 1e-6); near(body.a[1], 0); assert(top(s) < 3, "an axial lies low");
  // a diode gets its cathode band at pad 1
  s = G.partSolids("Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", "D1", [pad(1, 0, 0, true), pad(2, 7.62, 0, true)], null, null, false);
  const band = s.filter((x) => x.k === "cyl" && x.r > 0.5)[1]; assert(band && band.a[0] < 3.81, "band at pad 1's end");
  // DIP-40 600 mil: body between the rows, ~3.8 mm high, a notch at pin 1's end
  const dip = []; for (let i = 0; i < 20; i++) { dip.push(pad(i + 1, 0, i * 2.54, true)); dip.push(pad(40 - i, 15.24, i * 2.54, true)); }
  s = G.partSolids("Package_DIP:DIP-40_W15.24mm", "U1", dip, null, null, false);
  const db = s[0]; const xs = db.pts.map((p) => p[0]); near(Math.max(...xs) - Math.min(...xs), 13.94, 1e-6); near(db.z1, 3.8, 1e-6);
  const notch = s.find((x) => x.round); assert(notch && Math.min(...notch.pts.map((p) => p[1])) < 0, "notch at the pin-1 end");
  // a socketed DIP stands on its socket
  s = G.partSolids("Package_DIP:DIP-8_W7.62mm_Socket", "U2", [pad(1, 0, 0, true), pad(2, 0, 2.54, true), pad(3, 7.62, 2.54, true), pad(4, 7.62, 0, true)], null, null, false);
  assert(top(s) > 6 && top(s) < 7.5, "socket + package");
  // SOIC-8 from its name: 3.9 x 4.9 body, 1.6 high, leads out to the pads
  const so = [pad(1, -2.7, -1.905, false, 1.5, 0.6), pad(2, -2.7, -0.635, false, 1.5, 0.6), pad(3, -2.7, 0.635, false, 1.5, 0.6), pad(4, -2.7, 1.905, false, 1.5, 0.6), pad(5, 2.7, 1.905, false, 1.5, 0.6), pad(6, 2.7, 0.635, false, 1.5, 0.6), pad(7, 2.7, -0.635, false, 1.5, 0.6), pad(8, 2.7, -1.905, false, 1.5, 0.6)];
  s = G.partSolids("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "U3", so, null, null, true);
  const sx = s[0].pts.map((p) => p[0]); near(Math.max(...sx) - Math.min(...sx), 3.9, 1e-6); assert(top(s) <= 1.7 && top(s) >= 1.2, "SOIC height " + top(s));
  assert.strictEqual(s.filter((x) => x.k === "prism" && x.z1 < 0.5).length, 8, "eight leads");
  // chip resistor 0805: body + two tinned ends, oriented along its pads
  s = G.partSolids("Resistor_SMD:R_0805_2012Metric", "R2", [pad(1, 0, -0.9, false, 1, 1.2), pad(2, 0, 0.9, false, 1, 1.2)], null, null, true);
  assert.strictEqual(s.length, 3); const ys = s.flatMap((x) => x.pts.map((p) => p[1])); near(Math.max(...ys) - Math.min(...ys), 2.0, 1e-6);
  // an electrolytic can from its D, centred on the fab circle
  s = G.partSolids("Capacitor_THT:CP_Radial_D8.0mm_P3.50mm", "C1", [pad(1, 0, 0, true), pad(2, 3.5, 0, true)], null, { x: 1.75, y: 0, r: 4 }, false);
  near(top(s), 11.02, 1e-6); assert(s[0].round, "a can is round");
  // pin header: plastic strip and 8.5 mm posts
  s = G.partSolids("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "J1", [pad(1, 0, 0, true), pad(2, 0, 2.54, true), pad(3, 0, 5.08, true)], null, null, false);
  near(top(s), 8.5, 1e-6); assert.strictEqual(s.length, 4);
  // nothing recognisable: no model (the plain body is drawn instead)
  assert.strictEqual(G.partSolids("Lib:Mystery", "X1", [pad(1, 0, 0, true), pad(2, 5, 0, true)], null, null, false), null);
});

test("a footprint's 3D models: KiCad's library by library and name, a vendor part's from its vendor", () => {
  const fp = (model, extra) => K.parseDoc(`${HEAD}\n(footprint "Button_Switch_SMD:SW_Push" (layer "F.Cu") (uuid "00000000-0000-0000-0000-00000000aa01") (at 10 10 90)
    (property "Reference" "SW1" (at 0 -2) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) ${extra || ""} (attr smd)
    (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd")) ${SMD_PADS} ${model})\n)`, "kicad_pcb");
  const first = (d) => Array.from(d.items.values()).find((it) => it.kind === "footprint");
  const k = G.footprintModels(first(fp(`(model "\${KICAD10_3DMODEL_DIR}/Button_Switch_SMD.3dshapes/SW_Push_SPST_NO_Alps_SKRK.step" (offset (xyz 0 0.5 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 -90)))`)).node);
  assert.strictEqual(k.length, 1); assert.strictEqual(k[0].source, "kicad");
  assert.strictEqual(k[0].url, "/api/kicad-lib/model?lib=Button_Switch_SMD&name=SW_Push_SPST_NO_Alps_SKRK");
  assert.deepStrictEqual(k[0].offset, [0, 0.5, 0]); assert.deepStrictEqual(k[0].rotate, [0, 0, -90]); assert.deepStrictEqual(k[0].scale, [1, 1, 1]);
  const old = G.footprintModels(first(fp(`(model "\${KISYS3DMOD}/Crystal.3dshapes/Crystal_SMD_3225-4Pin_3.2x2.5mm.wrl" (at (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`)).node);
  assert.strictEqual(old[0].url, "/api/kicad-lib/model?lib=Crystal&name=Crystal_SMD_3225-4Pin_3.2x2.5mm", "an old .wrl path names the same library model");
  const v = G.footprintModels(first(fp(`(model "\${KICAD_COLLAB_3DMODELS}/Parts.3dshapes/TS-1187A.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`, `(property "LCSC" "C318884" (at 0 0) (layer "F.Fab") (hide yes))`)).node);
  assert.strictEqual(v[0].source, "vendor"); assert.strictEqual(v[0].url, "/api/parts/model.step?vendor=lcsc&id=C318884");
  assert.strictEqual(G.footprintModels(first(fp(`(model "\${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step" (hide yes))`)).node).length, 0, "a hidden model is not drawn");
  assert.strictEqual(G.footprintModels(first(fp("")).node).length, 0);
  const body = G.boardBodies(fp(`(model "\${KICAD10_3DMODEL_DIR}/A.3dshapes/B.step")`))[0];
  assert.strictEqual(body.models.length, 1); near(body.x, 10); near(body.rot, 90);
});

test("a model is placed as KiCad's viewer places it", () => {
  const mesh = { pos: new Float32Array([1, 0, 0.5]), nrm: new Float32Array([1, 0, 0]), col: new Float32Array(3), idx: new Uint32Array(0) };
  const ref = (o) => Object.assign({ url: "", source: "kicad", name: "", offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] }, o);
  const place = (r, at) => { let out; G.placeMesh(mesh, ref(r), Object.assign({ x: 10, y: 20, z: 0, rot: 0, back: false }, at), (x, y, z, nx, ny, nz) => { out = [x, y, z, nx, ny, nz]; }); return out; };
  const eq = (a, b, msg) => a.forEach((v, i) => near(v, b[i], 1e-6, msg + ` [${i}]`));
  eq(place({}, {}), [11, 20, 0.5, 1, 0, 0], "as is");
  eq(place({}, { rot: 90 }), [10, 21, 0.5, 0, 1, 0], "the footprint's rotation turns it anticlockwise");
  eq(place({}, { back: true, z: -1.6 }), [11, 20, -2.1, 1, 0, 0], "on the back it hangs below the board");
  eq(place({}, { back: true, rot: 90, z: -1.6 }), [10, 21, -2.1, 0, 1, 0], "back and turned");
  eq(place({ rotate: [0, 0, 90] }, {}), [10, 19, 0.5, 0, -1, 0], "the model's own rotation is clockwise, as in the footprint editor");
  eq(place({ offset: [0, 2, 0], scale: [2, 1, 1] }, {}), [12, 22, 0.5, 1, 0, 0], "scale, then offset");
});

test("a tessellated STEP file becomes one mesh with each face's colour", () => {
  const m = G.flattenOcct({ success: true, meshes: [
    { color: [0.1, 0.2, 0.3], attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] } }, index: { array: [0, 1, 2] }, brep_faces: [] },
    { attributes: { position: { array: [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1] }, normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] } }, index: { array: [0, 1, 2, 1, 3, 2] }, brep_faces: [{ first: 1, last: 1, color: [1, 0, 0] }] },
  ] });
  assert.strictEqual(m.pos.length, 21); assert.deepStrictEqual(Array.from(m.idx), [0, 1, 2, 3, 4, 5, 4, 6, 5]);
  near(m.col[0], 0.1, 1e-6); near(m.col[6 * 3], 1, 1e-6, "the coloured face's corner"); near(m.col[3 * 3], 0.6, 1e-6, "no colour: grey");
  assert.strictEqual(G.flattenOcct({ success: false }), null); assert.strictEqual(G.flattenOcct({ success: true, meshes: [] }), null);
});

console.log(`viewer3d: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
