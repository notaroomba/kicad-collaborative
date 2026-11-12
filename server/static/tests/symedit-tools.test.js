// symedit-tools.test.js — Symbol Editor drawing tools and the pieces added after the first frame: ellipses and
// elliptical arcs (ELLIPSE_GEOM_MANAGER, EDA_SHAPE::rotate / flip, formatEllipse), number precision on save.
// Run: node server/static/tests/symedit-tools.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const M = load("symedit/model.ts");
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const head = (n) => M.text(n).replace(/ \(stroke.*$/, "");

(async () => {
console.log("symbol editor tools under node");
await test("FormatAngle is {:.10g}", () => {
  assert.strictEqual(M.fmtAngle(33.690067525979785), "33.69006753");
  assert.strictEqual(M.fmtAngle(90), "90"); assert.strictEqual(M.fmtAngle(-0), "-0"); assert.strictEqual(M.fmtAngle(1e-11), "1e-11");
  assert.strictEqual(M.fmtAngle(-153.4349488), "-153.4349488"); assert.strictEqual(M.fmtAngle(0.5), "0.5");
});
await test("ellipse from a box: centre, major along the longer side, rotation 0 or 90 (calcEdit ELLIPSE)", () => {
  const w = M.ellipseFromBox([0, 0], [10.16, 5.08]);
  assert.deepStrictEqual([w.cx, w.cy, w.major, w.minor, w.rotation], [5.08, 2.54, 5.08, 2.54, 0]);
  const t = M.ellipseFromBox([0, 0], [2.54, -7.62]);
  assert.deepStrictEqual([t.cx, t.cy, t.major, t.minor, t.rotation], [1.27, -3.81, 3.81, 1.27, 90]);
  const z = M.ellipseFromBox([1, 1], [1, 1]); assert.strictEqual(z.major, 0.0001, "radii never below 1 IU");
  assert.strictEqual(head(M.ellipseNode(w, false)), "(ellipse (center 5.08 2.54) (major_radius 5.08) (minor_radius 2.54) (rotation_angle 0)");
});
await test("elliptical arc angles: internal (Y down) angle, end after start wrapped by 360", () => {
  const e = M.ellipseFromBox([-10, -5], [10, 5]);
  const a = M.ellipseArcAngles(e, [10, 0], [0, 5]);   // (0, 5) is up on screen: -90 internally, so 270
  assert.deepStrictEqual(a, { start: 0, end: 270 });
  const b = M.ellipseArcAngles(e, [0, 5]); assert.deepStrictEqual(b, { start: -90, end: 270 }, "while the end is not set the arc is whole");
  Object.assign(e, a);
  assert.strictEqual(head(M.ellipseNode(e, true)), "(ellipse_arc (center 0 0) (major_radius 10) (minor_radius 5) (rotation_angle 0) (start_angle 0) (end_angle 270)");
  const c = M.ellipseArcAngles(e, [10, 0], [10, 5]);   // atan2(-5/5, 10/10) = -45 -> 315
  assert.strictEqual(c.end, 315);
});
await test("rotate and mirror an ellipse arc as EDA_SHAPE does", () => {
  const e = Object.assign(M.ellipseFromBox([-10, -5], [10, 5]), { start: 0, end: 270 });
  const r = M.ellipseNode(e, true); M.rotateNode(r, 0, 0, true);
  assert.ok(M.text(r).includes("(rotation_angle -90) (start_angle 0) (end_angle 270)"), M.text(r));
  const r2 = M.ellipseNode(e, true); M.rotateNode(r2, 2, 0, false);
  assert.ok(M.text(r2).includes("(center 2 2)") && M.text(r2).includes("(rotation_angle -270)"), M.text(r2));
  const h = M.ellipseNode(e, true); M.mirrorNode(h, 0, 0, true);
  assert.ok(M.text(h).includes("(start_angle -90) (end_angle 180)"), M.text(h));
  const v = M.ellipseNode(e, true); M.mirrorNode(v, 0, 1, false);
  assert.ok(M.text(v).includes("(center 0 2)") && M.text(v).includes("(start_angle -270) (end_angle 0)"), M.text(v));
});
await test("a file's ten-digit angles and coordinates are written back as read", () => {
  const src = "(ellipse_arc (center 1.27 -2.54) (major_radius 3.81) (minor_radius 1.905) (rotation_angle 12.5) (start_angle 33.69006753) (end_angle 213.6900675))";
  assert.strictEqual(M.text(M.node(src)), src);
  const n = M.node("(xy 0 0)"); n[1] = 0.1 + 0.2; assert.strictEqual(M.text(n), "(xy 0.3 0)", "arithmetic noise still rounds");
});
await test("SYMBOL_IMPORT_MANAGER on 4xxx.kicad_sym: ancestors auto-included, descendants dropped with their parent", () => {
  const fs = require("fs"); const f = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "libs", "4xxx.kicad_sym");
  const lib = M.parseLibrary(fs.readFileSync(f, "utf8"));
  const m = new M.SymbolImportManager(lib, (n) => n === "4001");
  assert.strictEqual(m.names().length, 51);
  assert.deepStrictEqual([...m.ancestors("4066")], ["4016"]); assert.deepStrictEqual([...m.descendants("4538")].sort(), ["14528", "14538", "4528"]);
  m.setSelected("4066", true);
  assert.ok(m.infos.get("4066").checked && !m.infos.get("4016").checked && m.infos.get("4016").auto);
  assert.deepStrictEqual(m.toImport(), ["4016", "4066"]); assert.strictEqual(m.status(), "1 symbols selected, 1 parents auto-included");
  m.setSelected("4538", true); assert.ok(!m.infos.get("14528").checked && !m.infos.get("14528").auto, "a parent does not pull its children");
  m.setSelected("14528", true); m.setSelected("4528", true); m.deselectWithDescendants("4538");
  assert.deepStrictEqual(m.toImport(), ["4016", "4066"]);
  m.setSelected("4001", true); assert.deepStrictEqual(m.conflicts(), ["4001"]);
  m.deselectAll(); m.selectAll((n) => M.SymbolImportManager.matches(n, "453")); assert.deepStrictEqual(m.toImport(), ["14538", "4538"]); assert.strictEqual(m.status(), "2 symbols selected");
  m.selectAll(); assert.strictEqual(m.toImport().length, 51); assert.strictEqual(m.autoCount(), 0);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
