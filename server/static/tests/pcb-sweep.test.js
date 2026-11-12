// pcb-sweep.test.js — KiCad parity fixes in the board tools (pcb-tools.js): GuessSelectionCandidates for the hover
// selection, NextLineMode's order, Ctrl (not Alt) as the grid-off modifier, Undo / Redo with an operation in flight,
// a cancelled paste keeping the redo list (the step is tentative), Paste Special's radio tooltips.
// Run: node server/static/tests/pcb-sweep.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { try { pcb.cancel && pcb.cancel(); } catch (e) { /* idle */ } try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 5).join("\n       ")); } }

const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (44 "Edge.Cuts" user))
  (net 1 "VCC") (net 2 "SIG")
  (segment (start 10 10) (end 30 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "top"))
  (segment (start 10 10.73) (end 30 10.73) (width 0.25) (layer "B.Cu") (net 2) (uuid "bot"))
  (segment (start 10 10.35) (end 30 10.35) (width 0.25) (layer "F.Cu") (net 2) (uuid "near"))
  (via (at 20 20) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v"))
  (segment (start 10 20) (end 30 20) (width 0.25) (layer "F.Cu") (net 1) (uuid "under"))
  (footprint "T:R" (layer "F.Cu") (uuid "fp") (at 50 50)
    (fp_line (start -3 -2) (end 3 -2) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1"))
    (fp_line (start -3 2) (end 3 2) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l2"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "VCC") (uuid "p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "SIG") (uuid "p2")))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], clip: "" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(l) { ctx.selection = new Set(l); }, setHighlight() {},
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});

console.log("board tools: KiCad parity fixes");

test("GuessSelectionCandidates: the active layer's track wins over another layer's track within the slop (fit zoom)", () => {
  const doc = board(); P.state.layer = "F.Cu";
  // ~0.9 px/mm: a pixel is 1.1 mm, so the B.Cu track 0.73 mm away is inside the slop as well
  assert.deepEqual(P.guessCandidates(doc, ["top", "bot"], [20, 10], { px: 1 / 0.9, activeLayer: "F.Cu" }), ["top"]);
  assert.deepEqual(P.guessCandidates(doc, ["top", "bot"], [20, 10.73], { px: 1 / 0.9, activeLayer: "B.Cu" }), ["bot"]);
});

test("GuessSelectionCandidates: an exact hit beats a sloppy one on the same layer", () => {
  const doc = board();
  // 10 px/mm: the neighbour 0.35 mm away is 0.1 mm beyond its copper edge, more than a pixel past the exact hit
  assert.deepEqual(P.guessCandidates(doc, ["top", "near"], [20, 10], { px: 0.1, activeLayer: "F.Cu" }), ["top"]);
  assert.equal(P.hitTestDistance({ item: doc.items.get("top"), geoms: doc.items.get("top").geom, pad: false }, 20, 10, 0.5), 0);
  // at a zoom where both are within one pixel of each other, both stay (a real overlap: Clarify Selection asks)
  assert.deepEqual(P.guessCandidates(doc, ["top", "near"], [20, 10.175], { px: 0.1, activeLayer: "F.Cu" }).sort(), ["near", "top"]);
});

test("GuessSelectionCandidates: a via on a track is the much smaller item; a pad beats its footprint", () => {
  const doc = board();
  assert.deepEqual(P.guessCandidates(doc, ["under", "v"], [20, 20], { px: 0.1, activeLayer: "F.Cu" }), ["v"]);
  assert.deepEqual(P.guessCandidates(doc, ["fp#0", "fp"], [49, 50], { px: 0.1, activeLayer: "F.Cu" }), ["fp#0"]);
  assert.deepEqual(P.guessCandidates(doc, ["fp"], [49, 50], { px: 0.1 }), ["fp"], "one candidate stays as it is");
});

test("NextLineMode (Shift+Space): DIRECT -> DEG45 -> DEG90 -> DIRECT", () => {
  assert.equal(P.nextLineMode("free"), "45"); assert.equal(P.nextLineMode("45"), "90"); assert.equal(P.nextLineMode("90"), "free");
});

test("grid helper: Ctrl (TOOL_EVENT::DisableGridSnapping) frees the grid, Alt does not", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); ctx.pxPerMm = 100;
  assert.deepEqual(P.snapCursor(ctx, [70.13, 70.06], null, {}).p, [70.25, 70]);
  assert.deepEqual(P.snapCursor(ctx, [70.13, 70.06], null, { ctrlKey: true }).p, [70.13, 70.06]);
  assert.deepEqual(P.snapCursor(ctx, [70.13, 70.06], null, { altKey: true }).p, [70.25, 70]);
});

test("Undo / Redo with a move in flight: Undo cancels it (\"Perform undo locally\"), Redo does nothing; idle: the global list", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  assert.equal(pcb.undoRedo(ctx, "undo"), false); assert.equal(pcb.undoRedo(ctx, "redo"), false);
  ctx.selection = new Set(["top"]); ctx.cursor = [20, 10]; pcb.runAction("move", ctx); assert.ok(P.state.move, "moving");
  P.selectMoveTo(ctx, [22, 12]);
  assert.equal(pcb.undoRedo(ctx, "redo"), true); assert.ok(P.state.move, "redo leaves the move alone");
  assert.equal(pcb.undoRedo(ctx, "undo"), true); assert.equal(P.state.move, null, "undo cancels the move");
  assert.deepEqual(P.pt(doc.items.get("top").node, "start"), [10, 10], "the track is back"); assert.equal(log.commits.length, 0);
});

test("Paste and Duplicate commit a tentative step (a cancel gives the redo list back); Escape takes the items out", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  log.clip = P.clipboardText(doc, ["top"], [20, 10]); ctx.cursor = [40, 40];
  pcb.runAction("paste", ctx); const c = log.commits.at(-1); assert.equal(c.label, "paste"); assert.deepEqual(c.opts, { tentative: true });
  assert.ok(P.state.move && P.state.move.placing, "the pasted track follows the cursor");
  pcb.cancel(); const back = log.commits.at(-1); assert.deepEqual([back.opts.amend, back.opts.discard], [true, true], "the cancel discards the tentative step");
  ctx.selection = new Set(["top"]); pcb.runAction("duplicate", ctx); assert.deepEqual(log.commits.at(-1).opts, { tentative: true });
  pcb.cancel();
});

test("Paste Special: KiCad's per-option tooltips on Reference Designators", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.runAction("pasteSpecial", ctx); pcb.setForm(null);
  const f = spec.fields.find((x) => x.k === "annotations");
  assert.equal(f.options[0][2], "Finds the next available reference designator for any designators that already exist in the design.");
  assert.equal(f.options[1][2], undefined, "keep: self explanatory");
  assert.equal(f.options[2][2], "Replaces reference designators with 'REF**'.");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
