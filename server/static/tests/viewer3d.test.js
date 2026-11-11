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

console.log(`viewer3d: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
