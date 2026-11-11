// Node test for the board editor's QA round: the writer's quoting of hand-built nodes, pcbnew's bounding boxes
// for the presence payload, what a peer is told about the selection, hit tests of text and arcs, and the
// Move command for every kind of item.
// Run: node server/static/tests/pcb-qa.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user) (35 "F.Fab" user))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (at 100 50)
    (property "Reference" "R1" (at 0 -3 0) (layer "F.SilkS") (uuid "p-1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 3 0) (layer "F.Fab") (hide yes) (uuid "p-2") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -2 -1) (end 2 -1) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l-1"))
    (fp_arc (start 3 0) (mid 2.121 2.121) (end 0 3) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l-2"))
    (pad "1" smd rect (at -1.5 0 90) (size 1 2) (layers "F.Cu") (net "GND") (uuid "pad-1"))
    (pad "2" smd rect (at 1.5 0) (size 1 2) (layers "F.Cu") (net "VCC") (uuid "pad-2")))
  (segment (start 110 50) (end 115 52) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-1"))
  (via (at 118 53) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v-1"))
  (gr_line (start 90 40) (end 140 40) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "g-1"))
  (gr_circle (center 120 70) (end 122 70) (stroke (width 0.2) (type default)) (fill no) (layer "F.SilkS") (uuid "g-2"))
  (gr_text "HELLO" (at 130 60 0) (layer "F.SilkS") (uuid "t-1") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net "GND") (layer "F.Cu") (uuid "z-1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes)
    (polygon (pts (xy 150 40) (xy 160 40) (xy 160 55) (xy 150 55)))
    (filled_polygon (layer "F.Cu") (pts (xy 149.5 39.5) (xy 160.5 39.5) (xy 160.5 55.5) (xy 149.5 55.5))))
)`;
const load = () => K.parseDoc(BOARD, "kicad_pcb");

test("the writer quotes what pcbnew quotes on nodes built by hand: layer, layers, net, group name, text", () => {
  const doc = load();
  const seg = P.segmentNode(doc, [1, 2], [3, 4], 0.25, "F.Cu", { code: -1, name: "VCC" });
  assert.equal(K.serialize(seg), '(segment (start 1 2) (end 3 4) (width 0.25) (layer "F.Cu") (net "VCC"))');
  assert.equal(K.serialize(P.segmentNode(doc, [1, 2], [3, 4], 0.25, "F.Cu", null)), '(segment (start 1 2) (end 3 4) (width 0.25) (layer "F.Cu") (net ""))');
  assert.equal(K.serialize(P.viaNode(doc, 1, 2, 0.8, 0.4, { code: -1, name: "GND" }, ["F.Cu", "B.Cu"])), '(via (at 1 2) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND"))');
  assert.match(K.serialize(P.lineNode([0, 0], [1, 1], "Edge.Cuts")), /\(stroke \(width 0\.05\) \(type default\)\) \(layer "Edge\.Cuts"\)\)$/);
  assert.match(K.serialize(P.textNode("abc", 1, 2, "B.SilkS")), /^\(gr_text "abc" \(at 1 2 0\) \(layer "B\.SilkS"\) \(uuid "[^"]+"\) \(effects \(font \(size [\d.]+ [\d.]+\) \(thickness [\d.]+\)\) \(justify left bottom mirror\)\)\)$/);
  assert.match(K.serialize(P.groupNode("pair", ["a", "b"])), /^\(group "pair" \(uuid "[^"]+"\) \(members "a" "b"\)\)$/);
  assert.equal(K.serialize(["layer", "F.SilkS", "knockout"]), '(layer "F.SilkS" knockout)');
  assert.equal(K.serialize(["property", "Reference", "R1"]), '(property "Reference" "R1")');
  // tokens stay tokens, and a node read from a file keeps exactly the quoting it came with
  assert.equal(K.serialize(["fill", "no"]), "(fill no)");
  assert.equal(K.serialize(["type", "default"]), "(type default)");
  assert.equal(K.serialize(K.parse('(pad "1" smd rect (layers "F.Cu" "F.Mask"))')), '(pad "1" smd rect (layers "F.Cu" "F.Mask"))');
  // a board from before names were quoted (KiCad 5) keeps its own style in what is sent for it
  const old = K.parseDoc('(kicad_pcb (version 20171130) (host pcbnew 5.1) (layers (0 F.Cu signal) (31 B.Cu signal)) (net 0 "") (net 1 GND)\n (segment (start 0 0) (end 5 0) (width 0.25) (layer F.Cu) (net 1) (tstamp 5A0B0001)))', "kicad_pcb");
  const it = K.createItem(old, P.segmentNode(old, [0, 0], [1, 0], 0.25, "F.Cu", { code: 1, name: "GND" }));
  assert.match(K.serializeItem(old, it), /\(layer F\.Cu\) \(net 1\)/);
});

test("boardItemBox is pcbnew's GetBoundingBox: tracks and vias to the unit, shapes by their own outline", () => {
  const doc = load(); const box = (id) => K.boardItemBox(doc.items.get(id), IU);
  // PCB_TRACK: radius = (width + 1) / 2 = 125000, the box is [pos, dim) so + 1
  assert.deepEqual(box("s-1"), [110e6 - 125000, 50e6 - 125000, 5e6 + 250000 + 1, 2e6 + 250000 + 1]);
  // PCB_VIA: radius of the pad (larger than the hole)
  assert.deepEqual(box("v-1"), [118e6 - 400000, 53e6 - 400000, 800001, 800001]);
  // EDA_SHAPE: points grown by width / 2
  assert.deepEqual(box("g-1"), [90e6 - 25000, 40e6 - 25000, 50e6 + 50000, 50000]);
  assert.deepEqual(box("g-2"), [118e6 - 100000, 68e6 - 100000, 4e6 + 200000, 4e6 + 200000]);
  // ZONE: the outline, not the fill that reaches past it
  assert.deepEqual(box("z-1"), [150e6, 40e6, 10e6, 15e6]);
  // FOOTPRINT: pads by their turned rectangle (pad 1 is 1 x 2 turned 90 -> 2 wide, 1 high), the arc only where it
  // sweeps (a quarter from (3,0) to (0,3)), the visible Reference, and not the hidden Value at y + 3
  const fp = box("fp-1");
  assert.equal(fp[0], 100e6 - 2500000, "left edge is the turned pad 1");
  assert.equal(fp[0] + fp[2], 100e6 + 3050000, "right edge is the arc's start plus half its stroke");
  assert.equal(fp[1] + fp[3], 50e6 + 3050000, "bottom edge is the arc's end, not the hidden value text");
  assert.ok(fp[1] < 50e6 - 3e6 && fp[1] > 50e6 - 4.2e6, "top edge is the reference text's box");
  // the renderer's culling box is a different rectangle (a full circle for the arc): not what a peer should get
  const it = doc.items.get("fp-1");
  assert.ok(Math.round(it.bbox[0] * IU) < fp[0], "culling box reaches further left than pcbnew's box");
});

test("presence: a board names its selection at rest and adds pcbnew's boxes only while it moves", () => {
  const doc = load(); const sel = new Set(["fp-1", "s-1", "gone"]);
  const rest = K.presenceSelection(doc, sel, IU, false);
  assert.deepEqual(rest, { selection: ["fp-1", "s-1"] }, "ids only — the desktop outlines its own boxes, so nothing can be off");
  const moving = K.presenceSelection(doc, sel, IU, true);
  assert.deepEqual(moving.selection, ["fp-1", "s-1"]);
  assert.equal(moving.boxes.length, 2, "paired by index with the ids");
  assert.deepEqual(moving.boxes[1], K.boardItemBox(doc.items.get("s-1"), IU));
  for (const b of moving.boxes) assert.ok(b.every(Number.isInteger), "internal units, integers");
  // a move shifts the box by exactly the move: that difference is what the desktop draws as the drag
  const before = K.boardItemBox(doc.items.get("fp-1"), IU);
  const it = doc.items.get("fp-1"); P.translateNode(it.node, 2.5, -1); K.replaceChange(doc, it);
  const after = K.boardItemBox(doc.items.get("fp-1"), IU);
  assert.deepEqual([after[0] - before[0], after[1] - before[1], after[2], after[3]], [2500000, -1000000, before[2], before[3]]);
  assert.equal(K.presenceSelection(doc, new Set(), IU, true), null);
  assert.equal(K.presenceSelection(doc, new Set(["s-1", "v-1", "g-1"]), IU, true, 2).boxes.length, 2, "capped");
  // a schematic keeps sending the renderer's extents with the ids
  const sch = K.parseDoc('(kicad_sch (version 20250114) (generator "eeschema") (uuid "u") (paper "A4") (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "w-1")))', "kicad_sch");
  const s = K.presenceSelection(sch, new Set(["w-1"]), 1e4, false);
  assert.deepEqual(s.selection, ["w-1"]); assert.equal(s.boxes.length, 1);
});

test("hit tests: text by its own box, an arc only on its sweep", () => {
  const doc = load(); const fp = doc.items.get("fp-1");
  const text = fp.geom.find((g) => g.t === "text" && g.text === "R1"), arc = fp.geom.find((g) => g.t === "arc");
  assert.ok(text && arc);
  assert.ok(K.geomHit(text, text.x, text.y, 0.05), "on the text");
  assert.ok(!K.geomHit(text, text.x + 1.6, text.y, 0.05), "beside a two-letter text (the old test used a square as wide as the string on every side)");
  assert.ok(!K.geomHit(text, text.x, text.y + 1.2, 0.05), "below it");
  assert.ok(K.geomHit(arc, 100 + 2.121, 50 + 2.121, 0.05), "on the quarter arc");
  assert.ok(!K.geomHit(arc, 100 - 2.121, 50 - 2.121, 0.05), "opposite side of the circle: not on the arc");
  const hit = K.hitTestDetail(doc, 98.5, 50, 0.1);
  assert.equal(hit.id, "fp-1"); assert.equal(hit.cls, 0, "a pad hit is class 0");
  assert.equal(K.hitTestDetail(doc, 100, 49, 0.1).cls, 1, "a silkscreen hit is class 1");
});

test("a selection box that takes what it touches goes by shape: a diagonal track by its copper, a zone by its outline", () => {
  const doc = load(); const seg = doc.items.get("s-1"), zone = doc.items.get("z-1"), circle = doc.items.get("g-2");
  // s-1 runs (110,50)-(115,52): a box in the corner of its bounding rectangle does not touch the copper
  assert.ok(!K.itemTouchesRect(seg, 113.5, 49.9, 114.9, 50.6, null), "corner of the bounding box, away from the track");
  assert.ok(K.itemTouchesRect(seg, 112, 50.5, 113, 51.5, null), "across the track");
  // a box inside the pour takes neither the fill nor the zone; one across its edge does
  assert.ok(!K.itemTouchesRect(zone, 152, 43, 157, 50, null), "inside the zone");
  assert.ok(K.itemTouchesRect(zone, 149, 43, 151, 45, null), "across the zone's outline");
  // inside the hole of an unfilled circle: not touching; across the ring: touching
  assert.ok(!K.itemTouchesRect(circle, 119.5, 69.5, 120.5, 70.5, null));
  assert.ok(K.itemTouchesRect(circle, 121.5, 69.5, 122.5, 70.5, null));
  // hidden layers do not count, and an item with nothing on a visible layer is not selectable
  assert.ok(!K.itemTouchesRect(seg, 112, 50.5, 113, 51.5, new Set(["F.Cu"])));
  assert.ok(!K.itemVisible(seg, new Set(["F.Cu"]))); assert.ok(K.itemVisible(seg, new Set(["B.Cu"])));
});

test("flip and rotate write a footprint's zero orientation the way pcbnew does: no angle at all", () => {
  const doc = load(); const fp = doc.items.get("fp-1");
  const flipped = P.flipFootprintNode(K.cloneNode(fp.node));
  assert.deepEqual(K.kid(flipped, "at"), ["at", 100, 50], "not (at 100 50 0)");
  assert.equal(K.str(K.kid(flipped, "layer")[1]), "B.Cu");
  const pads = K.kids(flipped, "pad");
  assert.deepEqual(K.kid(pads[0], "at").slice(1), [1.5, 0, -90], "pad 1 mirrored in X, its angle negated");
  assert.deepEqual(K.kid(pads[0], "layers").slice(1), ["B.Cu"]);
  assert.equal(K.str(K.kid(K.kids(flipped, "fp_line")[0], "layer")[1]), "B.SilkS");
  const back = P.rotateFootprintNode(P.rotateFootprintNode(K.cloneNode(fp.node), 90), -90);
  assert.deepEqual(K.kid(back, "at"), ["at", 100, 50]);
  assert.deepEqual(K.kid(K.kids(back, "pad")[1], "at"), ["at", 1.5, 0], "a pad back at zero carries no angle either");
});

test("unfill (Ctrl+B) drops the filled areas and the filled mark, as ZONE::UnFill and pcbnew's writer", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew")
  (zone (net "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))) (filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9))))
  (zone (net "GND") (layer "B.Cu") (uuid "z2") (hatch edge 0.5) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10)))))`, "kicad_pcb");
  const ch = P.unfillChanges(doc, [...doc.items.values()]);
  assert.equal(ch.length, 1, "an unfilled zone is left alone");
  assert.equal(ch[0].id, "z1"); const out = ch[0].sexpr;
  assert.ok(!/filled_polygon/.test(out) && /\(fill \(thermal_gap 0\.5\)/.test(out), out);
});

test("align uses a footprint's box without its texts (FOOTPRINT::GetBoundingBox( false ))", () => {
  const fp = (ref, x, y, ty) => `(footprint "L:F" (layer "F.Cu") (uuid "${ref}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 ${ty}) (layer "F.SilkS") (uuid "${ref}-r") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "${ref}-l"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "${ref}-p")))`;
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") ${fp("A", 10, 10, -6)} ${fp("B", 20, 12, -1.5)})`, "kicad_pcb");
  const a = P.alignBox(doc.items.get("A")), b = P.alignBox(doc.items.get("B"));
  assert.ok(Math.abs(a[1] - (10 - 1.05)) < 1e-6, "top of A is its silk line, not its reference text: " + a);
  assert.ok(Math.abs(b[1] - (12 - 1.05)) < 1e-6, String(b));
  assert.ok(doc.items.get("A").bbox[1] < a[1] - 4, "the drawn box does include the text");
});

test("a route started mid-track splits that track there (PNS splitAdjacentSegments)", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (net 1 "N")
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1")))`, "kicad_pcb");
  const s = doc.items.get("s1");
  const ch = P.splitChanges(doc, { id: "s1", point: [4, 0], node: K.cloneNode(s.node) });
  assert.equal(ch.length, 2);
  assert.equal(ch[0].id, "s1"); assert.match(ch[0].sexpr, /\(start 0 0\) \(end 4 0\) \(width 0\.25\)/);
  assert.match(ch[1].sexpr, /\(start 4 0\) \(end 10 0\) \(width 0\.25\) \(layer "F\.Cu"\) \(net 1\) \(uuid "/);
  assert.notEqual(ch[1].id, "s1");
  assert.equal(P.splitChanges(doc, { id: "s1", point: [10, 0], node: K.cloneNode(s.node) }).length, 0, "an end is not split");
});
