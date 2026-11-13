// pcb-menus6.test.js — board commands that were desktop-only (sweep 6): Get and Move Footprint (T, EDIT_TOOL::GetAndPlace),
// Add a Zone Cutout / Add a Similar Zone (DRAWING_TOOL::DrawZone ZONE_MODE::CUTOUT / SIMILAR), Move Individually (Ctrl+M,
// Tab skips), Move with Reference, Copy with Reference, the Interactive Offset Tool.
// Run: node server/static/tests/pcb-menus6.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { try { pcb.cancel && pcb.cancel(); } catch (e) { /* idle */ } P.state.moveSeq = null; P.state.pick = null; try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 5).join("\n       ")); } }
const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
const kids = (n, k) => n.filter((c) => Array.isArray(c) && c[0] === k);

const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND")
  (footprint "T:R" (layer "F.Cu") (uuid "fp1") (at 50 50)
    (property "Reference" "R2" (at 0 -2 0) (layer "F.SilkS") (uuid "r2ref"))
    (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (uuid "r2val"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p1")))
  (footprint "T:C" (layer "F.Cu") (uuid "fp2") (at 20 30)
    (property "Reference" "C1" (at 0 -2 0) (layer "F.SilkS") (uuid "c1ref"))
    (property "Value" "100n" (at 0 2 0) (layer "F.Fab") (uuid "c1val")))
  (zone (net 1) (net_name "GND") (layers "F.Cu" "B.Cu") (uuid "z1") (name "GND_1") (hatch edge 0.5) (priority 3)
    (connect_pads (clearance 0.5)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 100 0) (xy 100 100) (xy 0 100)))
    (filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 99 1) (xy 99 99) (xy 1 99))))
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 0 5) (end 10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s2"))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], clip: "", tools: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: false, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(l) { ctx.selection = new Set(l); }, setHighlight() {},
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tools.push(t); pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const sel = (ctx, ids) => { P.state.sel = new Set(ids); ctx.selection = new Set(ids); };

console.log("board commands (sweep 6)");

test("Get and Move Footprint: DIALOG_GET_FOOTPRINT_BY_NAME lists 'REF    ( VALUE )' sorted, the list fills the text", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.runAction("getAndPlace", ctx); pcb.setForm(null);
  assert.equal(spec.title, "Get and Move Footprint");
  assert.equal(spec.fields[0].label, "Reference designator:"); assert.equal(spec.fields[1].label, "Available footprints:");
  assert.deepEqual(spec.fields[1].options.map((o) => o[1].replace(/\u00a0/g, " ")), ["C1    ( 100n )", "R2    ( 10k )"]);
  const set = {}; spec.change("list", "R2", (k, v) => { set[k] = v; }); assert.equal(set.ref, "R2");
  spec.change("ref", " c1 ", (k, v) => { set[k] = v; }); assert.equal(set.list, "C1");
  spec.change("ref", "X9", (k, v) => { set[k] = v; }); assert.equal(set.list, "");
});
test("Get and Move Footprint: the chosen footprint is selected and rides the cursor by its position; a click drops it", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.runAction("getAndPlace", ctx); pcb.setForm(null);
  spec.apply({ ref: "r2" });   // CmpNoCase
  assert.ok(P.state.move, "a move runs"); assert.deepEqual([...ctx.selection], ["fp1"]);
  assert.deepEqual(P.state.move.start, [50, 50]);
  P.selectMoveTo(ctx, [10, 12]); P.finishSelectMove(ctx, true);
  assert.deepEqual(K.atOf(doc.items.get("fp1").node).slice(0, 2), [10, 12]);
  assert.equal(log.commits.length, 1);
});
test("Get and Move Footprint: an unknown reference does nothing", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.runAction("getAndPlace", ctx); pcb.setForm(null); spec.apply({ ref: "U7" });
  assert.equal(P.state.move, null); assert.equal(log.commits.length, 0);
});

test("Add a Similar Zone needs one selected zone; without one nothing starts", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["s1"]);
  pcb.runAction("drawSimilarZone", ctx); assert.deepEqual(log.tools, []);
});
test("Add a Similar Zone: no dialog, the source's settings on the drawn outline, a unique name, unfilled, selected", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["z1"]);
  pcb.runAction("drawSimilarZone", ctx); assert.deepEqual(log.tools, ["zone"]);
  for (const p of [[110, 0], [120, 0], [120, 10]]) pcb.onPointerDown(ev(), p, ctx);
  pcb.onPointerDown(ev(), [110, 0], ctx);   // the first corner again closes it
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Draw Zone");
  const z = [...doc.items.values()].find((it) => it.kind === "zone" && it.id !== "z1");
  assert.ok(z); const n = z.node;
  assert.deepEqual(kid(n, "layers").slice(1), ["F.Cu", "B.Cu"]); assert.equal(kid(n, "priority")[1], 3); assert.equal(kid(n, "net")[1], 1);
  assert.equal(kid(n, "name")[1], "GND_2");
  assert.equal(kids(n, "filled_polygon").length, 0); assert.equal(kid(n, "fill")[1], kid(n, "fill")[1] === "yes" ? "no" : kid(n, "fill")[1]);
  assert.deepEqual(kid(kid(n, "polygon"), "pts").slice(1).map((x) => [x[1], x[2]]), [[110, 0], [120, 0], [120, 10]]);
  assert.notEqual(kid(n, "uuid")[1], "z1");
  assert.deepEqual([...ctx.selection], [z.id]);
});
test("BOARD::MakeUniqueZoneName: root_1, root_2 … with a trailing counter taken as the root's", () => {
  const doc = board();
  assert.equal(P.uniqueZoneName(doc, ""), ""); assert.equal(P.uniqueZoneName(doc, "PWR"), "PWR");
  assert.equal(P.uniqueZoneName(doc, "GND_1"), "GND_2"); assert.equal(P.uniqueZoneName(doc, "GND"), "GND");
});
test("Add a Zone Cutout: the drawn polygon becomes a hole; the zone is replaced, unfilled, and stays the source", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["z1"]);
  pcb.runAction("drawZoneCutout", ctx); assert.deepEqual(log.tools, ["zone"]);
  for (const p of [[40, 40], [60, 40], [60, 60], [40, 60]]) pcb.onPointerDown(ev(), p, ctx);
  pcb.onPointerDown(ev(), [40, 40], ctx);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Add Zone Cutout");
  assert.ok(!doc.items.has("z1"), "the source is removed");
  const zs = [...doc.items.values()].filter((it) => it.kind === "zone"); assert.equal(zs.length, 1);
  const polys = kids(zs[0].node, "polygon"); assert.equal(polys.length, 2, "outline and one hole");
  const hole = kid(polys[1], "pts").slice(1).map((x) => [x[1], x[2]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(hole, [[40, 40], [40, 60], [60, 40], [60, 60]]);
  assert.equal(kids(zs[0].node, "filled_polygon").length, 0);
  assert.equal(kid(zs[0].node, "name")[1], "GND_1"); assert.equal(kid(zs[0].node, "priority")[1], 3);
  assert.deepEqual(P.state.zoneMode, { mode: "cutout", src: zs[0].id });
});
test("Add a Zone Cutout across the zone splits it into one zone per remaining outline", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["z1"]);
  pcb.runAction("drawZoneCutout", ctx);
  for (const p of [[40, -10], [60, -10], [60, 110], [40, 110]]) pcb.onPointerDown(ev(), p, ctx);
  pcb.onPointerDown(ev(), [40, -10], ctx);
  const zs = [...doc.items.values()].filter((it) => it.kind === "zone"); assert.equal(zs.length, 2);
  assert.equal(log.commits[0].changes.length, 3);   // two added, the source removed: one undo step
});

test("Move Individually: each item rides the cursor in turn; all placements are one undo step", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["fp1", "fp2"]);
  pcb.runAction("moveIndividually", ctx);
  assert.ok(P.state.moveSeq); assert.deepEqual([...ctx.selection], ["fp1"]);
  assert.match(P.state.popup.text, /^Click to place R2 \(item 1 of 2\)\nPress <esc> to cancel all; double-click to finish$/);
  P.selectMoveTo(ctx, [5, 5]); P.finishSelectMove(ctx, true);
  assert.deepEqual([...ctx.selection], ["fp2"]); assert.match(P.state.popup.text, /item 2 of 2/);
  P.selectMoveTo(ctx, [7, 7]); P.finishSelectMove(ctx, true);
  assert.deepEqual(K.atOf(doc.items.get("fp1").node).slice(0, 2), [5, 5]); assert.deepEqual(K.atOf(doc.items.get("fp2").node).slice(0, 2), [7, 7]);
  assert.equal(log.commits.length, 2); assert.equal(log.commits[0].opts, undefined); assert.deepEqual(log.commits[1].opts, { amend: true });
  assert.equal(P.state.moveSeq, null);
});
test("Move Individually: Tab skips an item (it goes back), Escape puts every placed item back", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["fp1", "fp2", "s1"]);
  pcb.runAction("moveIndividually", ctx);
  P.selectMoveTo(ctx, [5, 5]); P.finishSelectMove(ctx, true);   // R2 placed
  P.selectMoveTo(ctx, [9, 9]); assert.equal(pcb.onKey("Tab", ev(), ctx), true);   // C1 skipped
  assert.deepEqual(K.atOf(doc.items.get("fp2").node).slice(0, 2), [20, 30]);
  assert.deepEqual([...ctx.selection], ["s1"]);
  P.finishSelectMove(ctx, false);   // Escape
  assert.deepEqual(K.atOf(doc.items.get("fp1").node).slice(0, 2), [50, 50]);
  const last = log.commits[log.commits.length - 1]; assert.deepEqual(last.opts, { amend: true, discard: true });
  assert.equal(P.state.moveSeq, null);
});
test("Move with Reference: the picked point is the move's reference point", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["fp2"]);
  pcb.runAction("moveWithReference", ctx);
  assert.equal(P.state.modTool, "pickpoint"); assert.equal(P.state.pick.prompt, "Select reference point for move...");
  pcb.onPointerDown(ev(), [21, 31], ctx);
  assert.ok(P.state.move); assert.deepEqual(P.state.move.start, [21, 31]);
  P.selectMoveTo(ctx, [151, 151]); P.finishSelectMove(ctx, true);
  assert.deepEqual(K.atOf(doc.items.get("fp2").node).slice(0, 2), [150, 150]); assert.equal(log.commits.length, 1);
});
test("Copy with Reference: the clipboard's origin is the picked point", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["s1"]);
  pcb.runAction("copyWithReference", ctx); assert.equal(P.state.pick.prompt, "Select reference point for the copy...");
  pcb.onPointerDown(ev(), [2, 0], ctx);
  assert.match(log.clip, /\(segment \(start -2 0\) \(end 8 0\)/);
  assert.equal(P.state.popup.text, "Selection copied");
});
test("Interactive Offset: Offset Item starts at the vector between the points; OK lands the first point at the second plus the offset", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); sel(ctx, ["s2"]); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.runAction("interactiveOffsetTool", ctx);
  assert.equal(P.state.pick.prompt, "Select the reference point on the item to move.");
  pcb.onPointerDown(ev(), [0, 5], ctx);
  assert.equal(P.state.pick.prompt, "Select the point to define the new offset from.");
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.setForm(null);
  assert.equal(spec.title, "Offset Item"); assert.equal(spec.fields[0].value, -10); assert.equal(spec.fields[1].value, -5);
  spec.apply({ x: 1, y: 2, polar: false });
  assert.equal(log.commits[0].label, "Set Relative Position Interactively");
  const s = doc.items.get("s2").node; assert.deepEqual(kid(s, "start").slice(1), [11, 12]);
  const set = {}; spec.change("polar", true, (k, v) => { set[k] = v; }); assert.equal(set.x, Math.round(Math.hypot(10, 5) * 1e6) / 1e6);
});

const RBOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "A")
  (footprint "T:R1" (layer "F.Cu") (uuid "fa") (at 10 10)
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "fa-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pa")))
  (footprint "T:R2" (layer "F.Cu") (uuid "fb") (at 30 10)
    (property "Reference" "R2" (at 0 -2 0) (layer "F.SilkS") (uuid "fb-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pb")))
  (segment (start 0 30) (end 10 30) (width 0.25) (layer "F.Cu") (net 0) (uuid "t1"))
  (segment (start 10 30) (end 20 30) (width 0.25) (layer "F.Cu") (net 0) (uuid "t2"))
  (segment (start 20 30) (end 30 30) (width 0.25) (layer "F.Cu") (net 0) (uuid "t3"))
)`;
test("Attempt Finish (F while routing) walks the head to the ratsnest end and fixes the route there", () => {
  const doc = K.parseDoc(RBOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc); P.state.layer = "F.Cu";
  ctx.setTool("route"); pcb.onPointerDown(ev(), [10, 10], ctx);
  assert.ok(P.state.route, "routing"); assert.equal(pcb.runAction("routerAttemptFinish", ctx), true);
  assert.equal(P.state.route, null, "the route ended");
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  const segs = [...doc.items.values()].filter((it) => it.kind === "segment" && !["t1", "t2", "t3"].includes(it.id));
  const ends = segs.flatMap((s) => [kid(s.node, "start").slice(1), kid(s.node, "end").slice(1)].map((p) => p.join(",")));
  assert.ok(ends.includes("10,10") && ends.includes("30,10"), ends.join(" "));
  ctx.setTool("select");
});
test("Attempt Finish outside routing leaves F to Flip", () => {
  const doc = K.parseDoc(RBOARD, "kicad_pcb"); const { ctx } = fakeCtx(doc);
  assert.equal(pcb.runAction("routerAttemptFinish", ctx), false);
});
test("Unroute Segment: the selected track goes, the tracks it touched become the selection", () => {
  const doc = K.parseDoc(RBOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc); sel(ctx, ["t2"]);
  assert.equal(pcb.runAction("unrouteSegment", ctx), true);
  assert.equal(log.commits[0].label, "Unroute Segment"); assert.ok(!doc.items.has("t2"));
  assert.deepEqual([...ctx.selection].sort(), ["t1", "t3"]);
});
test("Route Selected: each unrouted end of the selected footprints starts a route in turn", () => {
  const doc = K.parseDoc(RBOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc); P.state.layer = "F.Cu"; sel(ctx, ["fa"]);
  pcb.runAction("routerRouteSelected", ctx);
  assert.ok(P.state.route, "a route started"); assert.deepEqual(P.state.route.start, [10, 10]);
  assert.deepEqual(P.state.routeQueue.items, ["fa"]);
  pcb.cancel && pcb.cancel(); ctx.setTool("select");
  assert.equal(P.state.routeQueue, null, "Escape stops the queue");
});
test("Attempt Finish Selected (Shift+F) routes every selected footprint's ratsnest it can", () => {
  const doc = K.parseDoc(RBOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc); P.state.layer = "F.Cu"; sel(ctx, ["fa"]);
  pcb.runAction("routerAutorouteSelected", ctx);
  assert.equal(P.state.route, null); assert.equal(log.commits.length, 1); assert.equal(P.state.routeQueue, null);
  ctx.setTool("select");
});

// ---- Shift+V / Shift+S (PCB_CONTROL::CycleLayerPresets, SnapMode)
const LBOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal "Top") (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user))
  (gr_line (start 0 5) (end 10 5) (layer "B.SilkS") (width 0.1) (uuid "b1"))
  (gr_line (start 0 8) (end 10 8) (layer "F.SilkS") (width 0.1) (uuid "f1"))
)`;
test("GetEnabledLayerPairs: the last manual pair first as Manual, then the enabled presets; the current one's index", () => {
  P.resetLayerPairCycle();
  const presets = [{ top: "F.Cu", bottom: "B.Cu", enabled: true }, { top: "In1.Cu", bottom: "In2.Cu", enabled: true, name: "inner" }, { top: "F.Cu", bottom: "In1.Cu", enabled: false }];
  let r = P.enabledLayerPairs(["B.Cu", "F.Cu"], presets);
  assert.equal(r.pairs.length, 2); assert.equal(r.current, 0, "HasSameLayers ignores the order");
  r = P.enabledLayerPairs(["F.Cu", "In2.Cu"], presets);
  assert.deepEqual(r.pairs.map((p) => p.name || ""), ["Manual", "", "inner"]); assert.equal(r.current, 0);
  r = P.enabledLayerPairs(["In1.Cu", "In2.Cu"], presets);
  assert.equal(r.pairs[0].name, "Manual", "the manual pair stays in the cycle"); assert.equal(r.current, 2);
  r = P.enabledLayerPairs(["F.Cu", "B.Cu"], presets.concat([{ top: "In2.Cu", bottom: "F.Cu", enabled: true }]));
  assert.equal(r.pairs[0].name, undefined, "a manual pair that became a preset is no longer Manual");
});
test("Shift+V cycles the routing layer pair through the presets; fewer than two does nothing", () => {
  P.resetLayerPairCycle();
  const doc = K.parseDoc(LBOARD, "kicad_pcb"); const { ctx } = fakeCtx(doc); const R = K.pcbSizes.state;
  const shown = []; globalThis.window = globalThis.window || {}; globalThis.window.kcHotkeyCyclePopup = (t, items, sel) => shown.push([t, items, sel]);
  R.layerPairPresets = [{ top: "F.Cu", bottom: "B.Cu", enabled: true }]; R.setLayerPair("F.Cu", "B.Cu");
  assert.equal(pcb.runAction("layerPairPresetsCycle", ctx), true); assert.deepEqual(R.layerPair, ["F.Cu", "B.Cu"]); assert.equal(shown.length, 0);
  R.layerPairPresets = [{ top: "F.Cu", bottom: "B.Cu", enabled: true }, { top: "In1.Cu", bottom: "In2.Cu", enabled: true, name: "inner" }];
  pcb.runAction("layerPairPresetsCycle", ctx); assert.deepEqual(R.layerPair, ["In1.Cu", "In2.Cu"]);
  assert.deepEqual(shown[0], ["Preset Layer Pairs", ["Top / B.Cu", "In1.Cu / In2.Cu (inner)"], 1]);
  pcb.runAction("layerPairPresetsCycle", ctx); assert.deepEqual(R.layerPair, ["F.Cu", "B.Cu"]);
  R.layerPairPresets = []; R.setLayerPair("F.Cu", "B.Cu"); delete globalThis.window.kcHotkeyCyclePopup;
});
test("Shift+S: snapping to the active layer only (KiCad's default) or to all layers", () => {
  const doc = K.parseDoc(LBOARD, "kicad_pcb"); const { ctx } = fakeCtx(doc); const R = K.pcbSizes.state;
  P.state.snapAllLayers = false; R.setActiveLayer("F.SilkS");
  const at = (p) => P.snapCursor(ctx, p, null, {}).p;
  assert.deepEqual(at([0.3, 5.2]), [0.3, 5.2], "a B.SilkS end is not an anchor on F.SilkS");
  assert.deepEqual(at([0.3, 8.2]), [0, 8], "an F.SilkS end is");
  pcb.runAction("magneticSnapToggle", ctx); assert.equal(P.state.snapAllLayers, true);
  assert.deepEqual(at([0.3, 5.2]), [0, 5], "all layers: the B.SilkS end snaps");
  pcb.runAction("magneticSnapActiveLayer", ctx); assert.equal(P.state.snapAllLayers, false);
  pcb.runAction("magneticSnapAllLayers", ctx); assert.equal(P.state.snapAllLayers, true);
  P.state.snapAllLayers = false; R.setActiveLayer("");
});

test("Grid Origin...: X / Y in the user's units, Reset zeroes both, OK moves the grid origin (no board change)", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); const R = K.pcbSizes.state; R.setGridOrigin([12.5, -3]);
  let spec = null; pcb.setForm((sp) => { spec = sp; return true; });
  pcb.runAction("gridOrigin", ctx); pcb.setForm(null);
  assert.equal(spec.title, "Grid Origin");
  assert.deepEqual(spec.fields.map((f) => f.label), ["X:", "Y:", "Reset"]);
  assert.deepEqual([spec.fields[0].value, spec.fields[1].value, spec.fields[0].unit], [12.5, -3, "mm"]);
  const vals = {}; spec.change("reset", true, (k, v) => { vals[k] = v; }); assert.deepEqual(vals, { x: 0, y: 0 });
  spec.apply({ x: 25.4, y: 1.27 }); assert.deepEqual(R.gridOrigin, [25.4, 1.27]);
  assert.equal(log.commits.length, 0);
  R.setGridOrigin([0, 0]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
