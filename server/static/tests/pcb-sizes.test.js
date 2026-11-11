// Node test for the board's routing sizes: the pre-defined lists and netclasses read from the project
// file, KiCad's selector labels, W / ' stepping, the width and via the router emits, and the edits
// written back into .kicad_pro.
// Run: node server/static/tests/pcb-sizes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb, PS = K.pcbSizes;
const IU = 1e6;

const PRO = `{
  "board": {
    "design_settings": {
      "defaults": {},
      "diff_pair_dimensions": [],
      "rules": {
        "min_through_hole_diameter": 0.5,
        "min_track_width": 0.25,
        "min_via_diameter": 0.9
      },
      "track_widths": [
        0.0,
        0.4,
        0.5
      ],
      "via_dimensions": [
        {
          "diameter": 0.0,
          "drill": 0.0
        }
      ]
    }
  },
  "net_settings": {
    "classes": [
      { "name": "Default", "priority": 2147483647, "track_width": 0.5, "via_diameter": 1.6, "via_drill": 0.6, "clearance": 0.2 },
      { "name": "POWER", "priority": 0, "track_width": 0.8 }
    ],
    "netclass_assignments": { "/CLK": ["POWER"] },
    "netclass_patterns": [
      { "netclass": "POWER", "pattern": "GND" },
      { "netclass": "POWER", "pattern": "VCC*" }
    ]
  }
}
`;
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal "top") (4 "In1.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user))
  (setup (aux_axis_origin 62.23 153.67) (grid_origin 10 20))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (transform (translate 100 50) (rotate 0) (scale 1 1))
    (pad "1" smd rect (at 0 0) (size 1 1.2) (layers "F.Cu") (net "GND") (uuid "pad-1"))
    (pad "2" smd rect (at 5 0) (size 1 1.2) (layers "F.Cu") (net "/SIG") (uuid "pad-2")))
  (segment (start 120 50) (end 125 50) (width 0.35) (layer "F.Cu") (net "/SIG") (uuid "s-1"))
)`;
const board = () => K.parseDoc(BOARD, IU);
function fakeCtx(doc, designSettings) {
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, designSettings,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const fresh = () => { const R = PS.state; R.reset(); return R; };
const val = (node, k) => K.num(K.kid(node, k)[1]);

test("the project file's lists, rules and netclasses", () => {
  const s = PS.boardSizes(PRO);
  assert.deepEqual(s.trackWidths, [0, 0.4, 0.5]); assert.deepEqual(s.vias, [{ diameter: 0, drill: 0 }]);
  assert.equal(s.minTrackWidth, 0.25); assert.equal(s.minViaDiameter, 0.9); assert.equal(s.minThroughDrill, 0.5);
  assert.equal(PS.effectiveNetclass(s, "GND").track_width, 0.8);
  assert.equal(PS.effectiveNetclass(s, "GND").via_diameter, 1.6, "what POWER leaves out comes from Default");
  assert.equal(PS.effectiveNetclass(s, "VCC_3V3").name.includes("POWER"), true);
  assert.equal(PS.effectiveNetclass(s, "/CLK").track_width, 0.8, "explicit assignment");
  assert.equal(PS.effectiveNetclass(s, "XGND").track_width, 0.5, "patterns are anchored");
  assert.equal(PS.effectiveNetclass(s, "").track_width, 0.5);
  // no project file: KiCad's stock lists
  const d = PS.boardSizes(undefined); assert.equal(d.trackWidths[0], 0); assert.ok(d.trackWidths.length > 1); assert.ok(d.vias.length > 1);
});

test("selector labels as PCB_EDIT_FRAME::UpdateTrackWidthSelectBox / UpdateViaSizeSelectBox write them", () => {
  const s = PS.boardSizes(PRO); s.vias.push({ diameter: 0.8, drill: 0.4 }, { diameter: 1.0, drill: 0 });
  assert.deepEqual(PS.trackWidthLabels(s, "mm"), ["Track: use netclass width", "Track: 0.400 mm (15.75 mils)", "Track: 0.500 mm (19.69 mils)"]);
  assert.deepEqual(PS.trackWidthLabels(s, "mil"), ["Track: use netclass width", "Track: 15.75 mils (0.400 mm)", "Track: 19.69 mils (0.500 mm)"]);
  assert.equal(PS.trackWidthLabels(s, "in")[1], "Track: 0.01575 in (0.400 mm)");
  assert.deepEqual(PS.viaSizeLabels(s, "mm"), ["Via: use netclass sizes", "Via: 0.800 / 0.400 mm (31.50 / 15.75 mils)", "Via: 1.000 mm (39.37 mils)"]);
  assert.equal(PS.viaSizeLabels(s, "mil")[1], "Via: 31.50 / 15.75 mils (0.800 / 0.400 mm)");
});

test("stepping: W / Shift+W and ' / \\ walk the lists, skipping the netclass entry once past it", () => {
  assert.deepEqual([PS.nextPredefinedIndex(0, true, 3), PS.nextPredefinedIndex(1, true, 3), PS.nextPredefinedIndex(2, true, 3), PS.nextPredefinedIndex(1, false, 3), PS.nextPredefinedIndex(0, false, 3)], [1, 2, 1, 2, 2]);
  const R = fresh(); R.load(PRO);
  assert.equal(R.currentTrackWidth(), 0.5); assert.equal(R.stepTrackWidth(true), 0.4); assert.equal(R.trackIndex, 1); assert.equal(R.stepTrackWidth(true), 0.5); assert.equal(R.stepTrackWidth(false), 0.4);
  assert.equal(R.steppedWidth(0.4, true), 0.5); assert.equal(R.steppedWidth(0.5, true), null); assert.equal(R.steppedWidth(0.45, false), 0.4);
  R.setLists([1.2, 0.4, 0.5], [{ diameter: 1.0, drill: 0.5 }, { diameter: 0.8, drill: 0.4 }]);
  assert.deepEqual(R.sizes.trackWidths, [0, 0.4, 0.5, 1.2]); assert.deepEqual(R.sizes.vias.map((v) => v.diameter), [0, 0.8, 1.0]);
  assert.deepEqual(R.stepViaSize(true), { diameter: 0.8, drill: 0.4 }); assert.deepEqual(R.steppedVia(0.8, true), { diameter: 1.6, drill: 0.6 }, "the Default netclass via heads the list, as in ViaSizeInc"); assert.deepEqual(R.steppedVia(1.6, false), { diameter: 1.0, drill: 0.5 });
});

test("the width a route takes (ImportSizes)", () => {
  const R = fresh(); R.load(PRO);
  assert.equal(R.routeWidth("GND", null), 0.8, "netclass of the routed net");
  assert.equal(R.routeWidth("/SIG", null), 0.5);
  assert.equal(R.routeWidth("GND", 0.35), 0.35, "the connected track wins while auto track width is on");
  R.toggleConnectedWidth(); assert.equal(R.routeWidth("GND", 0.35), 0.8); R.toggleConnectedWidth();
  R.setTrackIndex(1); assert.equal(R.routeWidth("GND", null), 0.4, "a selected size overrides the netclass");
  R.stepTrackWidth(true, true); assert.equal(R.routeWidth("GND", 0.35), 0.5, "W mid-route overrides the connected width"); R.endRoute(); assert.equal(R.routeWidth("GND", 0.35), 0.35);
  assert.deepEqual(R.routeVia("GND"), { diameter: 1.6, drill: 0.6 });
  R.setLists([0.1], [{ diameter: 0.8, drill: 0.4 }]); R.setTrackIndex(1); R.setViaIndex(1);
  assert.equal(R.routeWidth("", null), 0.25, "never below the board minimum"); assert.deepEqual(R.routeVia("GND"), { diameter: 0.8, drill: 0.4 });
});

test("writing the lists back keeps the rest of the project file byte for byte", () => {
  const R = fresh(); R.load(PRO); R.setLists([0.4, 0.5, 1.2], [{ diameter: 0.8, drill: 0.4 }]);
  const out = PS.sizesToProject(PRO, R.sizes);
  const j = JSON.parse(out);
  assert.deepEqual(j.board.design_settings.track_widths, [0, 0.4, 0.5, 1.2]);
  assert.deepEqual(j.board.design_settings.via_dimensions, [{ diameter: 0, drill: 0 }, { diameter: 0.8, drill: 0.4 }]);
  assert.match(out, /"track_widths": \[\n {8}0\.0,\n {8}0\.4,\n {8}0\.5,\n {8}1\.2\n {6}\]/, "KiCad's own layout and 0.0 floats");
  assert.equal(out.slice(out.indexOf('"net_settings"')), PRO.slice(PRO.indexOf('"net_settings"')), "untouched sections are not reformatted");
  assert.equal(PS.sizesToProject(out, R.sizes), out, "idempotent");
  assert.deepEqual(PS.boardSizes(out).vias[1], { diameter: 0.8, drill: 0.4 });
});

test("layers: every enabled layer in UI order, the copper stack and + / -", () => {
  const doc = board(); const ls = PS.enabledLayers(doc, () => "#000");
  assert.deepEqual(ls.map((l) => l.name), ["F.Cu", "In1.Cu", "B.Cu", "F.SilkS", "Edge.Cuts"]);
  assert.equal(ls[0].label, "top"); assert.equal(ls[0].copper, true); assert.equal(ls[3].copper, false);
  const cu = ["B.Cu", "F.Cu", "In1.Cu"]; assert.deepEqual(PS.copperStack(cu), ["F.Cu", "In1.Cu", "B.Cu"]);
  assert.equal(PS.stepCopperLayer(cu, "F.Cu", true), "In1.Cu"); assert.equal(PS.stepCopperLayer(cu, "F.Cu", true, new Set(["In1.Cu"])), "B.Cu"); assert.equal(PS.stepCopperLayer(cu, "B.Cu", false), "In1.Cu");
  const R = fresh(); assert.equal(R.pairedLayer("F.Cu"), "B.Cu"); assert.equal(R.pairedLayer("B.Cu"), "F.Cu"); assert.equal(R.pairedLayer("In1.Cu"), "F.Cu");
  R.setLayerPair("In1.Cu", "B.Cu"); assert.equal(R.pairedLayer("In1.Cu"), "B.Cu");
});

test("origins: read from the board's setup; the grid is measured from the grid origin", () => {
  const doc = board(); assert.deepEqual(doc.auxOrigin, [62.23, 153.67]); assert.deepEqual(doc.gridOrigin, [10, 20]);
  const R = fresh(); assert.deepEqual(R.snapToGrid([10.3, 20.4], 0.25), [10.25, 20.5]);
  R.setGridOrigin([0.1, 0.05]); assert.deepEqual(R.snapToGrid([10.3, 20.4], 0.25), [10.35, 20.3]);
});

test("router: netclass width, selected width, inherited width, via from the selection, Backspace and End", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc, PRO); const R = fresh();
  pcb.onDocChanged(ctx); pcb.onKey("x", ev(), ctx);
  pcb.onPointerDown(ev(), [100.1, 50.1], ctx);                       // pad 1, GND -> POWER 0.8
  assert.equal(P.state.route.net.name, "GND"); assert.equal(P.state.route.width, 0.8);
  pcb.onPointerMove(ev(), [100, 60], ctx); pcb.onPointerDown(ev(), [100, 60], ctx);
  // the route is one transaction: a click fixes a stage, nothing reaches the board until the route ends
  const stageNodes = (st) => st.ops.map((o) => o.add || o.node).filter(Boolean);
  assert.equal(log.commits.length, 0); assert.equal(P.state.route.stages.length, 1);
  const first = stageNodes(P.state.route.stages[0]).filter((n) => n[0] === "segment"); assert.ok(first.length >= 1); for (const n of first) assert.equal(val(n, "width"), 0.8);
  // Backspace takes the leg back and routing goes on from the pad
  assert.equal(pcb.onKey("Backspace", ev(), ctx), true); assert.deepEqual(P.state.route.last, [100, 50]); assert.equal(P.state.route.stages.length, 0);
  // W mid-route: the next pre-defined width applies to what is drawn next
  pcb.onKey("w", ev(), ctx); assert.equal(R.trackIndex, 1);
  pcb.onPointerMove(ev(), [100, 58], ctx); pcb.onPointerDown(ev(), [100, 58], ctx);
  const leg = stageNodes(P.state.route.stages[P.state.route.stages.length - 1]).filter((n) => n[0] === "segment"); assert.ok(leg.length >= 1); for (const n of leg) assert.equal(val(n, "width"), 0.4);
  // V: a via of the net's class (no pre-defined via chosen) follows the head, the next click places it and routing goes on on the paired layer
  pcb.onPointerMove(ev(), [104, 58], ctx); pcb.onKey("v", ev(), ctx); assert.ok(P.state.route.placingVia);
  pcb.onPointerDown(ev(), [104, 58], ctx);
  const via = stageNodes(P.state.route.stages[P.state.route.stages.length - 1]).find((n) => n[0] === "via");
  assert.equal(val(via, "size"), 1.6); assert.equal(val(via, "drill"), 0.6); assert.deepEqual(K.kid(via, "layers").slice(1).map(K.str), ["F.Cu", "B.Cu"]);
  assert.equal(P.state.route.layer, "B.Cu"); assert.equal(R.activeLayer, "B.Cu");
  // End fixes the leg under the cursor and finishes: one commit
  pcb.onPointerMove(ev(), [110, 58], ctx); assert.equal(pcb.onKey("End", ev(), ctx), true); assert.equal(P.state.route, null);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  assert.equal(R.tempOverride, false);
  // a route started on the end of an existing 0.35 track inherits its width and net
  pcb.onKey("PageUp", ev(), ctx); R.setTrackIndex(0);
  pcb.onPointerDown(ev(), [125, 50], ctx); assert.equal(P.state.route.width, 0.35); assert.equal(P.state.route.net.name, "/SIG");
  pcb.onActivate("select", ctx); pcb.onActivate("route", ctx); assert.equal(P.state.route, null);
  // ... unless "automatically select track width" is off
  R.toggleConnectedWidth(); pcb.onPointerDown(ev(), [125, 50], ctx); assert.equal(P.state.route.width, 0.5); pcb.onActivate("select", ctx); R.toggleConnectedWidth();
  // the via tool places the selected pre-defined via
  R.setLists([0.4, 0.5], [{ diameter: 0.8, drill: 0.4 }]); pcb.onKey("'", ev(), ctx); assert.equal(R.viaIndex, 1);
  pcb.onActivate("via", ctx); pcb.onPointerDown(ev(), [140, 70], ctx);
  const v2 = doc.items.get(log.commits[log.commits.length - 1].changes[0].id); assert.equal(v2.kind, "via"); assert.equal(val(v2.node, "size"), 0.8); assert.equal(val(v2.node, "drill"), 0.4);
  fresh();
});
