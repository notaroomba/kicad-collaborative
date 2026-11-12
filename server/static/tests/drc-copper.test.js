// drc-copper.test.js — DRC_TEST_PROVIDER_SLIVER_CHECKER (copper_sliver) and DRC_TEST_PROVIDER_CONNECTION_WIDTH
// (connection_width) against KiCad's own regression boards (qa/tests/pcbnew/drc/test_drc_copper_sliver.cpp and
// test_drc_copper_conn.cpp give the counts), and the Board Setup minimums a project leaves out.
// Run: node server/static/tests/drc-copper.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("DRC: copper slivers, connection width, implicit board setup minimums");
const read = (f, ext) => { try { return fs.readFileSync(path.join(QA, f + ext), "utf8"); } catch (e) { return null; } };
function run(name, code) {
  const doc = K.parseDoc(read(name, ".kicad_pcb"), "kicad_pcb"); const pro = read(name, ".kicad_pro");
  return P.drc(doc, P.designSettings(pro ? JSON.parse(pro) : null), { unconnected: false, rules: read(name, ".kicad_dru") }).filter((m) => m.code === code);
}

test("copper_sliver: sliver has one, the issue boards none (test_drc_copper_sliver.cpp)", () => {
  const s = run("sliver", "copper_sliver");
  assert.equal(s.length, 1); assert.equal(s[0].text, "Copper sliver (F.Cu)"); assert.equal(s[0].severity, "warning"); assert.equal(s[0].layer, "F.Cu");
  for (const f of ["issue14449", "issue14549_2"]) assert.equal(run(f, "copper_sliver").length, 0, f);
});
test("copper_sliver: a sharp spike past the width tolerance, not a right angle", () => {
  // a 10 x 2 mm block with an 11° spike out to (15, 1) on its right side, wound as Clipper's outer contours are
  let poly = [[0, 0], [10e6, 0], [10e6, 0.5e6], [15e6, 1e6], [10e6, 1.5e6], [10e6, 2e6], [0, 2e6]];
  if (P.clipperArea(poly) < 0) poly = poly.reverse();
  assert.deepEqual(P.sliverPoints(poly), [[15e6, 1e6]]);
  let blunt = [[0, 0], [10e6, 0], [10e6, 0.5e6], [11e6, 1e6], [10e6, 1.5e6], [10e6, 2e6], [0, 2e6]];   // 53°: no sliver
  if (P.clipperArea(blunt) < 0) blunt = blunt.reverse();
  assert.deepEqual(P.sliverPoints(blunt), []);
});
test("connection_width: the rule and board setup minimums of connection_width_rules (3), none on issue12831 / issue14130", () => {
  const m = run("connection_width_rules", "connection_width");
  assert.equal(m.length, 3);
  assert.deepEqual(m.map((x) => x.rule).sort(), ["board setup constraints", "rule 'high_current_area'", "rule 'high_current_netclass'"]);
  assert.match(m[0].text, /^Copper connection too narrow \((rule '[a-z_]+'|board setup constraints) minimum connection width 0\.\d{4} mm; actual 0\.\d{4} mm\) \(F\.Cu\)$/);
  for (const f of ["issue12831", "issue14130"]) assert.equal(run(f, "connection_width").length, 0, f);
});
test("POLYGON_TEST finds the neck of a dumbbell and nothing in a plain rectangle", () => {
  const T = new P.PolygonTest(200000);
  const bell = [[0, 0], [1e6, 0], [1e6, 0.45e6], [2e6, 0.45e6], [2e6, 0], [3e6, 0], [3e6, 1e6], [2e6, 1e6], [2e6, 0.55e6], [1e6, 0.55e6], [1e6, 1e6], [0, 1e6]];
  assert.ok(T.findPairs(bell).length >= 1);
  assert.deepEqual(new P.PolygonTest(200000).findPairs([[0, 0], [3e6, 0], [3e6, 1e6], [0, 1e6]]), []);
});
test("implicit board setup minimums: KiCad's defaults when the project leaves them out, the project's value otherwise", () => {
  const d = P.designSettings(null);
  assert.deepEqual([d.minThroughDrill, d.minTrackWidth, d.minViaDiameter, d.minMicroViaDrill, d.minHoleToHole, d.holeClearance, d.edgeClearance, d.minResolvedSpokes, d.minClearance, d.minViaAnnular], [0.3, 0.2, 0.5, 0.1, 0.25, 0.25, 0.5, 2, 0, 0.1]);
  const p = P.designSettings({ board: { design_settings: { rules: { min_track_width: 0.15, min_through_hole_diameter: 0 } } } });
  assert.equal(p.minTrackWidth, 0.15); assert.equal(p.minThroughDrill, 0); assert.equal(p.minViaDiameter, 0.5, "absent: the default stays");
  assert.equal(p.minViaDrill, undefined, "renamed to minThroughDrill");
});
test("annular width slow path: trapezoid, custom and offset pads measured to their outline; a hole outside is 0", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (net 0 "")
  (footprint "X:Y" (layer "F.Cu") (uuid "fp1") (at 20 20)
    (property "Reference" "J1" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole trapezoid (at 0 0) (size 2 2) (rect_delta 0 0.6) (drill 1) (layers "*.Cu" "*.Mask") (uuid "p1"))
    (pad "2" thru_hole custom (at 6 0) (size 1.2 1.2) (drill 1) (layers "*.Cu" "*.Mask") (options (clearance outline) (anchor circle))
      (primitives (gr_rect (start -0.5 -0.5) (end 3 0.5) (width 0) (fill yes))) (uuid "p2"))
    (pad "3" thru_hole rect (at 12 0) (size 2 2) (drill 0.6 (offset 1.5 0)) (layers "*.Cu" "*.Mask") (uuid "p3"))))`, "kicad_pcb");
  const pads = P.padsOf(doc.items.get("fp1"));
  const w = pads.map((p) => P.padAnnulus(p, [], { min: 1, max: null }));
  assert.ok(Math.abs(w[0] - (Math.cos(Math.atan(0.3)) - 0.5)) < 0.005, "trapezoid: the slanted side's distance less the hole radius, got " + w[0]);
  assert.equal(w[1], null, "a custom outline comes from the plotter, which drc() hands in");
  assert.equal(w[2], 0, "the hole 1.5 off a 2 mm square is outside the copper");
  const m = P.drc(doc, P.designSettings({ board: { design_settings: { rules: { min_via_annular_width: 0.15 } } } }), { unconnected: false }).filter((x) => x.code === "annular_width");
  assert.deepEqual(m.map((x) => x.text), ["Annular width (board setup constraints min annular width 0.1500 mm; actual 0.0953 mm)", "Annular width (board setup constraints min annular width 0.1500 mm; actual 0.0000 mm)"],
    "the custom pad's disc anchor (1.2 mm, 1 mm hole) is the narrowest part of its merged outline");
});

// fracture (web/fab/poly.ts) against the straightforward version it replaced: the same outlines, vertex for vertex
const esbuild = require("esbuild");
function loadTs(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require); return mod.exports;
}
function fractureRef(paths) {
  const area = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return a / 2; };
  const pip = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  if (paths.length < 2) return paths;
  let pos = 0, neg = 0; for (const p of paths) { const a = area(p); if (a > 0) pos += a; else neg -= a; }
  const outerSign = pos >= neg ? 1 : -1; const outers = [], holes = [];
  for (const p of paths) { if (Math.sign(area(p)) === outerSign) outers.push({ pts: p, holes: [], a: Math.abs(area(p)) }); else holes.push(p); }
  if (!holes.length) return paths;
  outers.sort((a, b) => a.a - b.a);
  for (const h of holes) { const o = outers.find((c) => pip(c.pts, h[0][0], h[0][1]) || pip(c.pts, (h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2)); if (o) o.holes.push(h); }
  return outers.map((o) => {
    let poly = o.pts.slice();
    const hs = o.holes.map((h) => { let mi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i; return { h, mi }; });
    hs.sort((a, b) => b.h[b.mi][0] - a.h[a.mi][0]);
    for (const { h, mi } of hs) {
      const hx = h[mi][0], hy = h[mi][1]; let best = -1, bestX = Infinity;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if (a[1] === b[1]) continue; if (Math.min(a[1], b[1]) > hy || Math.max(a[1], b[1]) < hy) continue; const x = a[0] + (b[0] - a[0]) * (hy - a[1]) / (b[1] - a[1]); if (x >= hx && x < bestX) { bestX = x; best = i; } }
      if (best < 0) continue;
      const cut = [bestX, hy]; const ring = []; for (let k = 0; k <= h.length; k++) ring.push(h[(mi + k) % h.length]);
      poly = poly.slice(0, best + 1).concat([cut], ring, [cut], poly.slice(best + 1));
    }
    return poly;
  });
}
test("fracture: the banded hole join gives the reference outlines exactly, ties on a shared cut line included", () => {
  const PL = loadTs("fab/poly.ts");
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const sq = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  let holes = 0;
  for (let t = 0; t < 200; t++) {
    const polys = []; for (let i = 0, m = 1 + Math.floor(rnd() * 6); i < m; i++) polys.push(sq(rnd() * 50, rnd() * 50, 5 + rnd() * 40, 5 + rnd() * 40));
    const cut = [];
    for (let i = 0; i < 60; i++) { const x = Math.round(rnd() * 90), y = Math.round(rnd() * 90), r = 0.3 + rnd(), k = 3 + Math.floor(rnd() * 8); const c = []; for (let j = 0; j < k; j++) c.push([x + r * Math.cos(-j * 2 * Math.PI / k), y + r * Math.sin(-j * 2 * Math.PI / k)]); cut.push(c); }
    const U = PL.subtract(PL.union(polys), cut); holes += U.length;
    assert.deepEqual(PL.fracture(U), fractureRef(U), "case " + t);
  }
  assert.ok(holes > 1000, "the cases have holes to join");
});
test("boxGrid: the same candidates as a scan over every box, in their order", () => {
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const items = []; for (let i = 0; i < 400; i++) { const x = rnd() * 100, y = rnd() * 100, w = rnd() < 0.05 ? 80 : rnd() * 3; items.push({ i, b: [x, y, x + w, y + rnd() * 3] }); }
  const g = P.boxGrid(items, (t) => t.b, 2);
  for (let q = 0; q < 300; q++) { const x = rnd() * 100, y = rnd() * 100, b = [x, y, x + rnd() * 2, y + rnd() * 2];
    assert.deepEqual(g.query(b, 0.01).map((t) => t.i), items.filter((t) => P.boxesTouch(t.b, b, 0.01)).map((t) => t.i)); }
});
// test_drc_copper_conn.cpp fills the zones first (KI_TEST::FillZones) and counts every error-severity violation;
// issue9870 needs ERROR_OUTSIDE circles and track ends (a 0.5 mm via just touching a fill corner)
async function refilled(name) {
  require(path.join(__dirname, "..", "dist", "fab.js")); const F = globalThis.KiCadFab;
  const text = read(name, ".kicad_pcb"), pro = read(name, ".kicad_pro"); const s = P.designSettings(pro ? JSON.parse(pro) : null);
  const doc = K.parseDoc(text, "kicad_pcb");
  const rules = { netClearance: (n) => { const nc = P.netclassOf(s, n); return nc && nc.clearance !== undefined ? nc.clearance : s.clearance; }, minClearance: s.minClearance || 0, holeClearance: s.holeClearance || 0, edgeClearance: s.edgeClearance };
  for (const r of await F.fillZones({ doc, setup: text }, rules, null)) { const it = doc.items.get(r.id); it.node = F.filledZoneNode(it.node, r, doc.copper, (n) => K.cloneNode(n)); }
  for (const k of ["invalid_outline", "unconnected_items", "copper_sliver", "starved_thermal", "drill_out_of_range", "via_diameter", "lib_footprint_issues", "lib_footprint_mismatch"]) s.severities[k] = "ignore";
  s.severities.connection_width = "error";
  return P.drc(doc, s, { unconnected: false, rules: read(name, ".kicad_dru") }).filter((m) => m.severity === "error");
}
const asyncTests = [];
if (read("issue9870", ".kicad_pcb")) asyncTests.push(["connection_width after a refill: issue9870 12, connection_width_rules 3, issue12831 / issue14130 0 (test_drc_copper_conn.cpp)", async () => {
  for (const [name, n] of [["issue9870", 12], ["connection_width_rules", 3], ["issue12831", 0], ["issue14130", 0]]) assert.equal((await refilled(name)).length, n, name);
}]);
test("ERROR_OUTSIDE circle and oval: every vertex outside the true shape, chord middles on it, the track's width kept", () => {
  const c = P.circleOutside(10, 10, 0.25); assert.equal(c.length % 8, 0);
  for (let i = 0; i < c.length; i++) { const a = c[i], b = c[(i + 1) % c.length]; assert.ok(Math.hypot(a[0] - 10, a[1] - 10) >= 0.25); assert.ok(Math.abs(Math.hypot((a[0] + b[0]) / 2 - 10, (a[1] + b[1]) / 2 - 10) - 0.25) < 2e-6); }
  const o = P.ovalOutside([0, 0], [3, 4], 0.635); const ys = o.map((p) => (-p[0] * 4 + p[1] * 3) / 5);
  assert.ok(Math.max(...ys) <= 0.3175 + 1e-6 && Math.min(...ys) >= -0.3175 - 1e-6, "cut back to the width");
  assert.ok(Math.max(...o.map((p) => (p[0] * 3 + p[1] * 4) / 5)) > 5 + 0.3175, "the ends pushed out");
});

(async () => {
  for (const [name, fn] of asyncTests) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
