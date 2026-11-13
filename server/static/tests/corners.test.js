// Square track corners: the finder behind review_design's tracks.corners and run_checks' track_right_angle.
//   node static/tests/corners.test.js
const test = require("node:test"); const assert = require("node:assert"); const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "pcb-tools.js")); require(path.join(__dirname, "..", "dist", "autoroute.js"));
const R = globalThis.PcbAutoRouter;
const seg = (id, a, b, net = "SIG", layer = "F.Cu") => ({ id, net, layer, a, b });
const none = () => false;

test("a 90° bend is a square corner, a 45° bend is not", () => {
  assert.strictEqual(R.findSquareCorners([seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [5, 5])], none, none).length, 1);
  assert.strictEqual(R.findSquareCorners([seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [8, 3])], none, none).length, 0);
});
test("an acute bend counts, a tee does not", () => {
  assert.strictEqual(R.findSquareCorners([seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [1, 1])], none, none).length, 1);
  assert.strictEqual(R.findSquareCorners([seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [5, 5]), seg("3", [5, 0], [10, 0])], none, none).length, 0);
});
test("a bend under a pad, on another layer or on an RF net is left alone", () => {
  const L = [seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [5, 5])];
  assert.strictEqual(R.findSquareCorners(L, () => true, none).length, 0);
  assert.strictEqual(R.findSquareCorners([seg("1", [0, 0], [5, 0]), seg("2", [5, 0], [5, 5], "SIG", "B.Cu")], none, none).length, 0);
  assert.strictEqual(R.findSquareCorners(L.map((s) => ({ ...s, net: "RF_ANT" })), none, (n) => /RF/.test(n)).length, 0);
});
test("the router leaves no square corner on a real board", () => {
  const fs = require("node:fs"); const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
  const file = path.join(__dirname, "..", "..", "..", "demos", "pic_programmer", "pic_programmer.kicad_pcb"); if (!fs.existsSync(file)) return;
  const doc = K.parseDoc(fs.readFileSync(file, "utf8"), "kicad_pcb"); const settings = P.designSettings(null);
  for (const [id, it] of Array.from(doc.items)) if (it.kind === "segment" || it.kind === "arc" || it.kind === "via") doc.items.delete(id);
  const res = R.route(K, P, doc, settings, { passes: 1, timeMs: 30000 }); for (const it of res.items) K.createItem(doc, it.node);
  assert.deepStrictEqual(R.boardSquareCorners(doc, P), []);
});
