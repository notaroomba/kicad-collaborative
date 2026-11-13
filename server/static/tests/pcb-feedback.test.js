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

// a recording 2D context: strokes and fills with their colours, and the transform the stroke font reads
function recCtx() {
  const ops = []; const st = { strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1 };
  const c = new Proxy({}, { get(_t, k) {
    if (k === "ops") return ops;
    if (k === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    if (k === "measureText") return (s) => ({ width: s.length });
    if (k in st) return st[k];
    if (k === "stroke" || k === "fill" || k === "strokeRect" || k === "fillRect" || k === "fillText") return (...a) => ops.push({ op: k, stroke: st.strokeStyle, fill: st.fillStyle, lw: st.lineWidth, alpha: st.globalAlpha, a });
    if (k === "moveTo" || k === "lineTo" || k === "arc") return (...a) => ops.push({ op: k, a });
    return () => {};
  }, set(_t, k, v) { st[k] = v; return true; } });
  return c;
}
const GROUPED = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (net 1 "A")'
  + ' (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))'
  + ' (segment (start 0 5) (end 10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s2"))'
  + ' (segment (start 0 9) (end 10 9) (width 0.25) (layer "F.Cu") (net 1) (uuid "s3"))'
  + ' (group "INNER" (uuid "g2") (members "s2"))'
  + ' (group "OUTER" (uuid "g1") (members "g2" "s1")))';

test("Enter Group: picking a member stays inside the entered group; its box and members", () => {
  const doc = K.parseDoc(GROUPED);
  P.state.enteredGroup = null;
  assert.deepEqual([...P.expandGroups(doc, ["s1"])].sort(), ["g1", "g2", "s1", "s2"], "outside: a member selects the whole group");
  P.state.enteredGroup = "g1";
  assert.deepEqual([...P.expandGroups(doc, ["s1"])].sort(), ["s1"], "entered: the member alone");
  assert.deepEqual([...P.expandGroups(doc, ["s2"])].sort(), ["g2", "s2"], "entered: a sub-group is still picked whole");
  assert.deepEqual([...P.enteredGroupIds(doc)].sort(), ["g1", "g2", "s1", "s2"]);
  const b = P.groupBox(doc, "g1"); assert(b && b[1] < 0 && b[3] > 5 && b[3] < 9, "the box spans s1 and s2 only: " + b);
  P.state.enteredGroup = null;
});

test("an entered group scopes box selection and Select All (FilterCollectorForHierarchy: WithinScope)", () => {
  const doc = K.parseDoc(GROUPED);
  P.state.enteredGroup = null;
  assert.deepEqual(P.withinEnteredGroup(doc, ["s1", "s2", "s3", "g1"]), ["s1", "s2", "s3", "g1"], "no group entered: unchanged");
  P.state.enteredGroup = "g1";
  assert.deepEqual(P.withinEnteredGroup(doc, ["s1", "s2", "s3", "g1", "g2"]), ["s1", "s2", "g2"], "entered: members to any depth, not the group itself nor s3");
  P.state.enteredGroup = null;
});

test("outside an entered group items fade to the Outside Group opacity, selected ones do not", () => {
  const doc = K.parseDoc(GROUPED);
  const run = (opts) => { const c = recCtx(); c.canvas = { width: 400, height: 300 }; K.render(doc, c, { ppm: 20, zoom: 1, panX: 0, panY: 0, x0: -2, y0: -2, dpr: 1 }, Object.assign({ frame: false, netNames: false }, opts)); return c.ops.filter((o) => o.op === "stroke" && o.lw > 0.2); };
  const plain = run({}); assert(plain.every((o) => o.alpha === 1));
  const ent = run({ enteredGroup: new Set(["g1", "g2", "s1", "s2"]), outsideGroupOpacity: 0.2 });
  assert.equal(ent.filter((o) => Math.abs(o.alpha - 0.2) < 1e-6).length, 1, "s3 faded");
  assert.equal(ent.filter((o) => o.alpha === 1).length, 2, "the members at full opacity");
  const sel = run({ enteredGroup: new Set(["g1", "g2", "s1", "s2"]), outsideGroupOpacity: 0.2, selected: new Set(["s3"]) });
  assert(sel.every((o) => o.alpha === 1), "a selected item outside the group keeps its opacity");
});

test("PCB_PAINTER::draw( PCB_GROUP ): a selected group's box at 2 px with its name tab, nothing for a group not selected", () => {
  const doc = K.parseDoc(GROUPED);
  const ctx = (sel) => ({ doc, selection: new Set(sel), isSch: false });
  let c = recCtx(); P.drawGroupFrames(c, ctx([]), 0.05); assert.equal(c.ops.length, 0);
  c = recCtx(); P.drawGroupFrames(c, ctx(["g1", "g2", "s1", "s2"]), 0.05);
  const rects = c.ops.filter((o) => o.op === "strokeRect"); assert.equal(rects.length, 1, "only the outer group (its parent is not selected)");
  assert.equal(rects[0].lw, 0.1);
  assert.equal(rects[0].stroke.toLowerCase().replace(/\s/g, ""), K.selectedColor("#FF26E2").toLowerCase().replace(/\s/g, ""));
  assert(c.ops.filter((o) => o.op === "stroke").length > 1, "the title tab and the stroke-font name");
});

test("clearance outlines (Always show): one px outline at width + 2 × clearance in the layer colour, active layer only", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 0) (uuid "s1"))'
    + ' (segment (start 0 5) (end 10 5) (width 0.25) (layer "B.Cu") (net 0) (uuid "s2")) (via (at 20 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v1")))');
  const S = P.state, keep = [S.trackClearance, S.layer, S.padClearance];
  try {
    S.trackClearance = 4; S.layer = "F.Cu";
    const c = recCtx(); P.drawClearanceOutlines(c, { doc, isSch: false }, 0.05);
    const strokes = c.ops.filter((o) => o.op === "stroke"); assert.equal(strokes.length, 2, "the F.Cu track and the via, not the B.Cu track");
    assert(strokes.every((o) => o.lw === 0.05 && o.stroke === K.pcbColor("F.Cu")));
    const ring = c.ops.find((o) => o.op === "arc" && o.a[0] === 20); assert(ring && ring.a[2] > 0.3 + 0.1, "via ring past its radius: " + (ring && ring.a[2]));
    S.layer = "B.Cu"; const c2 = recCtx(); P.drawClearanceOutlines(c2, { doc, isSch: false }, 0.05);
    assert(c2.ops.filter((o) => o.op === "stroke").every((o) => o.stroke === K.pcbColor("B.Cu")), "on B.Cu in the B.Cu colour");
    S.trackClearance = 2; const c3 = recCtx(); P.drawClearanceOutlines(c3, { doc, isSch: false }, 0.05);
    assert.equal(c3.ops.filter((o) => o.op === "stroke").length, 0, "not in the default mode");
  } finally { [S.trackClearance, S.layer, S.padClearance] = keep; }
});

test("pad clearance outlines: the pad grown by its own clearance (pad, footprint, net class); an NPTH's hole", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")'
    + ' (footprint "x" (layer "F.Cu") (at 10 10) (clearance 0.3) (uuid "fp")'
    + '  (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (uuid "p1"))'
    + '  (pad "2" smd oval (at 3 0) (size 2 1) (layers "F.Cu") (clearance 0.5) (uuid "p2"))'
    + '  (pad "3" smd rect (at 6 0) (size 1 1) (layers "F.Cu") (uuid "p3"))'
    + '  (pad "4" np_thru_hole circle (at 9 0) (size 1.2 1.2) (drill 1.2) (layers "*.Cu" "*.Mask") (uuid "p4"))'
    + '  (pad "5" smd circle (at 0 3) (size 1 1) (layers "B.Cu") (uuid "p5"))))');
  const s = { clearance: 0.2, netclasses: [] };
  const list = P.clearanceOutlines(doc, s, "F.Cu", { tracks: false, pads: true, netName: () => "" });
  assert.deepEqual(list.map((o) => o.padIndex), [0, 1, 2, 3], "the B.Cu pad has no outline on F.Cu");
  assert.equal(list[0].shape.t, "circle"); assert(Math.abs(list[0].shape.r - 0.8) < 1e-9, "footprint override 0.3: " + list[0].shape.r);
  assert.equal(list[1].shape.t, "capsule"); assert(Math.abs(list[1].shape.r - 1.0) < 1e-9, "pad override 0.5");
  assert.equal(list[2].shape.t, "poly");
  const xs = list[2].shape.pts.map((p) => p[0]); assert(Math.abs(Math.max(...xs) - (16 + 0.5 + 0.3)) < 1e-6, "rect grown by 0.3: " + Math.max(...xs));
  assert(list[3].npth && list[3].shape.t === "circle" && Math.abs(list[3].shape.r - 0.9) < 1e-9, "an NPTH's hole grown by 0.3");
  assert.equal(P.clearanceOutlines(doc, s, "F.Cu", { tracks: false, pads: true, netName: () => "", objHide: new Set(["pads"]) }).length, 0, "hidden pads draw none");
  assert.equal(P.clearanceOutlines(doc, s, "F.SilkS", { tracks: true, pads: true, netName: () => "" }).length, 0, "no clearance layer for a technical layer");
});

test("PREVIEW::GetConstantGlyphHeight: 12 / 10 px, 9 / 8 px on HiDPI", () => {
  assert.deepEqual(P.statusNoteDims(1), { text: 12, hint: 10, pen: 0.2 });
  assert.deepEqual(P.statusNoteDims(2), { text: 9, hint: 8, pen: 0.15 });
});

test("ROUTER_STATUS_VIEW_ITEM: the note in the stroke font (no fillText), framed 2 px, 0.9 fill", () => {
  const c = recCtx(); P.drawStatusNote(c, [0, 0], 0.1, "Track violates DRC.", "(Ctrl+click to commit anyway.)");
  assert.equal(c.ops.filter((o) => o.op === "fillText").length, 0);
  const box = c.ops.find((o) => o.op === "fillRect"); assert(box && box.alpha === 0.9);
  const frame = c.ops.find((o) => o.op === "strokeRect"); assert(frame && Math.abs(frame.lw - 0.2) < 1e-9);
  assert(c.ops.filter((o) => o.op === "stroke").length >= 2, "two stroked text lines");
  assert(box.a[0] > 0 && box.a[1] < 0, "above and right of the cursor");
});
