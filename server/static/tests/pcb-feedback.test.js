// node server/static/tests/pcb-feedback.test.js: the board tools' feedback.
// Covers ratsnest adjustColor, snap indicator types, colliding courtyards, and the router start layer.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;

test("RATSNEST_VIEW_ITEM adjustColor: Brightened on dark, Darkened on light, alpha clamped to 1", () => {
  assert.equal(P.adjustColor("#808080", 0.5, 0.35), "rgba(192, 192, 192, 0.35)");
  assert.equal(P.adjustColor("#808080", 0.5, 1.4), "rgba(192, 192, 192, 1)");
  assert.equal(P.adjustColor("#808080", 0.5, 0.5, true), "rgba(64, 64, 64, 0.5)");
  // a static line while a net is highlighted: halved alpha, then the lit net brightens 0.8 at +0.4
  assert.equal(P.adjustColor("rgba(255,255,255,0.35)", 0, 0.35 / 2), "rgba(255, 255, 255, 0.175)");
});

test("snap types: router snaps map to POINT_TYPE, anchors keep theirs", () => {
  assert.equal(P.snapTypeOf(null), "none");
  assert.equal(P.snapTypeOf({ kind: "pad" }), "center");
  assert.equal(P.snapTypeOf({ kind: "via" }), "center");
  assert.equal(P.snapTypeOf({ kind: "track" }), "end");
  assert.equal(P.snapTypeOf({ kind: "anchor", type: "quadrant" }), "quadrant");
});

test("itemAnchors carry PCB_GRID_HELPER point types (rect centre, corners, side middles)", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (37 "F.SilkS" user))'
    + ' (gr_rect (start 0 0) (end 10 4) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "r1"))'
    + ' (gr_circle (center 5 5) (end 7 5) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "c1"))'
    + ' (gr_line (start 0 0) (end 4 0) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "l1")))');
  const types = (id) => P.itemAnchors(doc.items.get(id), false, null, 1).map((a) => a.t + "@" + a[0] + "," + a[1]);
  assert.deepEqual(types("r1"), ["center@5,2", "corner@0,0", "corner@10,0", "corner@10,4", "corner@0,4", "mid@5,0", "mid@10,2", "mid@5,4", "mid@0,2"]);
  assert.deepEqual(types("c1").map((s) => s.split("@")[0]), ["center", "quadrant", "quadrant", "quadrant", "quadrant"]);
  assert.deepEqual(types("l1"), ["end@0,0", "end@4,0", "mid@2,0"]);
});

test("SNAP_INDICATOR: white circle-cross of 16 px, one px wide, icon at +24/+10 px", () => {
  const ops = []; let st = "", lw = 0;
  const c = { save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {},
    arc(x, y, r) { ops.push({ arc: [x, y, r] }); }, stroke() { ops.push({ stroke: st, lw }); } };
  Object.defineProperty(c, "strokeStyle", { set: (v) => { st = v; }, get: () => st });
  Object.defineProperty(c, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  c.fillStyle = ""; c.globalAlpha = 1;
  P.drawSnapIndicator(c, [0, 0], "center", 0.5);
  const arcs = ops.filter((o) => o.arc);
  assert.deepEqual(arcs[0].arc, [0, 0, 8], "the 16 px circle at the point");
  assert.deepEqual(arcs[1].arc, [12, 5, 2], "the centre icon's ring at +24/+10 px");
  assert(ops.filter((o) => o.stroke).every((o) => o.stroke === "#FFFFFF" && o.lw === 0.5));
});

test("colliding courtyards: overlapping front courtyards mark both footprints, apart marks none", () => {
  const fp = (id, x) => `(footprint "T:C" (layer "F.Cu") (at ${x} 0) (uuid "${id}")`
    + ` (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd") (uuid "${id}-c"))`
    + ` (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (uuid "${id}-p")))`;
  const near = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (47 "F.CrtYd" user)) ' + fp("a", 0) + fp("b", 1.5) + ")");
  const hits = P.courtyardConflicts(near, new Set(["a"]));
  assert.deepEqual([...hits.keys()].sort(), ["a", "b"]);
  const far = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (47 "F.CrtYd" user)) ' + fp("a", 0) + fp("b", 5) + ")");
  assert.equal(P.courtyardConflicts(far, new Set(["a"])).size, 0);
});

test("ROUTER_TOOL::getStartLayer: a track on another copper layer starts the route there", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (net 1 "A")'
    + ' (segment (start 0 0) (end 10 0) (width 0.25) (layer "B.Cu") (net 1) (uuid "s1")))');
  P.state.layer = "F.Cu";
  const ctx = { doc, isSch: false };
  assert.equal(P.startLayerOf(ctx, { x: 5, y: 0, snap: null }, [5, 0]), "B.Cu");
  assert.equal(P.startLayerOf(ctx, { x: 5, y: 3, snap: null }, [5, 3]), null);
  assert.equal(P.startLayerOf(ctx, { x: 5, y: 0, snap: { kind: "track", onLayer: "B.Cu" } }, [5, 0]), "B.Cu");
});
