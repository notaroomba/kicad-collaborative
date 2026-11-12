// redundant.test.js — "Remove redundant tracks" (pcb-tools.js, after PLACEMENT_ALGO::removeLoops and
// LINE_PLACER::removeAntennas in pcbnew/router/pns_line_placer.cpp): rerouting a connection erases the old line
// between the same two joints (locked lines stay, the setting off keeps everything), and the dangling half of a track
// the route started on is removed once the new route is anchored.
// Run: node server/static/tests/redundant.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }

const pad = (ref, x, y, net) => `(footprint "T:P" (layer "F.Cu") (uuid "fp${ref}") (at ${x} ${y})
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "${net}") (uuid "p${ref}")))`;
// pads A (10, 10) and B (20, 10) joined by a detour through (15, 15); pad C (40, 20); a stub from pad D (10, 30) to (30, 30)
const BOARD = (lock) => `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  ${pad("A", 10, 10, "S")} ${pad("B", 20, 10, "S")} ${pad("C", 40, 20, "T")} ${pad("D", 10, 30, "T")} ${pad("E", 20, 40, "T")}
  (segment (start 10 10) (end 15 15) (width 0.25) (layer "F.Cu") (net "S") ${lock ? "(locked yes) " : ""}(uuid "o1"))
  (segment (start 15 15) (end 20 10) (width 0.25) (layer "F.Cu") (net "S") (uuid "o2"))
  (segment (start 10 30) (end 30 30) (width 0.25) (layer "F.Cu") (net "T") (uuid "st"))
)`;
function fakeCtx(lock) {
  const doc = K.parseDoc(BOARD(lock), "kicad_pcb");
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx); pcb.setLayer(ctx, "F.Cu");
  return { ctx, log, doc };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
function reset() { try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ } P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); }
function route(ctx, pts) {
  pcb.onKey("x", ev(), ctx);
  pcb.onPointerDown(ev(), pts[0], ctx);
  for (const p of pts.slice(1)) { pcb.onPointerMove(ev(), p, ctx); pcb.onPointerDown(ev(), p, ctx); }
  if (P.state.route) pcb.onKey("End", ev(), ctx);
}
const tracks = (doc, net) => [...doc.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && P.netOf(it.node).name === net);

console.log("remove redundant tracks");

test("a new route between the same two pads erases the old line, in the same 'Route Track' commit", () => {
  const { ctx, log, doc } = fakeCtx();
  route(ctx, [[10, 10], [20, 10]]);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  assert.ok(!doc.items.has("o1") && !doc.items.has("o2"), "the detour is gone");
  const t = tracks(doc, "S"); assert.ok(t.length >= 1);
  assert.ok(t.every((it) => P.pt(it.node, "start")[1] === 10 && P.pt(it.node, "end")[1] === 10), "only the straight route is left");
});

test("a locked track keeps its line", () => {
  const { ctx, doc } = fakeCtx(true);
  route(ctx, [[10, 10], [20, 10]]);
  assert.ok(doc.items.has("o1") && doc.items.has("o2"));
});

test("Remove redundant tracks off: the old line stays", () => {
  const { ctx, doc } = fakeCtx();
  P.setRouterSettings({ remove_loops: false });
  route(ctx, [[10, 10], [20, 10]]);
  assert.ok(doc.items.has("o1") && doc.items.has("o2"));
});

test("removeAntennas: starting mid-way on a stub from pad D, the dangling half beyond the split is removed", () => {
  const { ctx, doc } = fakeCtx();
  route(ctx, [[20, 30], [20, 40]]);
  const t = tracks(doc, "T");
  assert.ok(!t.some((it) => P.pt(it.node, "start")[0] > 20.001 || P.pt(it.node, "end")[0] > 20.001), "nothing right of the split is left: " + t.map((it) => K.serialize(it.node)).join("\n"));
  assert.ok(t.some((it) => P.pt(it.node, "start")[0] === 10 && P.pt(it.node, "end")[0] === 20), "the anchored half stays");
});

test("loopRemovals on a branch: nothing is removed when the route does not close a loop", () => {
  const { ctx, doc } = fakeCtx();
  route(ctx, [[40, 20], [40, 25]]);
  assert.ok(doc.items.has("st") && doc.items.has("o1"));
});

test("the preview hides the old line as soon as the head lands on the far pad (LINE_PLACER::Move)", () => {
  const { ctx } = fakeCtx();
  pcb.onKey("x", ev(), ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerMove(ev(), [20, 10], ctx);
  const hidden = pcb.hiddenIds(); assert.ok(hidden && hidden.has("o1") && hidden.has("o2"), "both old tracks are hidden");
  pcb.onPointerMove(ev(), [18, 14], ctx);
  const h2 = pcb.hiddenIds(); assert.ok(!h2 || !h2.has("o1"), "away from the pad they come back");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
