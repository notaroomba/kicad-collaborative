// router.test.js — the interactive router's modes and settings (pcb-tools.js, after KiCad's PNS router):
// ROUTING_SETTINGS, the corner modes of DIRECTION_45::BuildInitialTrace, the route as one transaction, Highlight
// collisions / Shove / Walk around while routing and dragging, the via commands and their hotkeys, and the
// Interactive Router Settings dialog's form (web/editor/routersettings.ts).
// Run: node server/static/tests/router.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "editor", "routersettings.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent" });
const RS = { exports: {} }; new Function("module", "exports", built.outputFiles[0].text)(RS, RS.exports);
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 5).join("\n       ")); } }

// net A ends at (20, 10); net B runs along y = 12 underneath it; a pad of net C sits at (40, 10)
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net "A") (uuid "sa"))
  (segment (start 5 12) (end 30 12) (width 0.25) (layer "F.Cu") (net "B") (uuid "sb"))
  (footprint "T:P" (layer "F.Cu") (uuid "fp") (at 40 10)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "C") (uuid "pc")))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
function reset() { try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ } P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); }
const segsOf = (doc, net) => [...doc.items.values()].filter((it) => it.kind === "segment" && K.str(K.kid(it.node, "net")[1]) === net);
const startRoute = (ctx, at) => { pcb.onKey("x", ev(), ctx); assert.equal(pcb.onPointerDown(ev(), at, ctx), true); assert.ok(P.state.route, "a route started"); };

console.log("interactive router");

test("ROUTING_SETTINGS: KiCad's defaults; stored values of the wrong type or out of range keep the default", () => {
  const d = P.parseRouterSettings(null);
  assert.equal(d.mode, 2); assert.equal(d.corner_mode, 0); assert.equal(d.shove_vias, true); assert.equal(d.fix_all_segments, true); assert.equal(d.can_violate_drc, false);
  const s = P.parseRouterSettings(JSON.stringify({ mode: 1, corner_mode: 9, shove_vias: "yes", free_angle_mode: true }));
  assert.equal(s.mode, 1); assert.equal(s.corner_mode, 0); assert.equal(s.shove_vias, true); assert.equal(s.free_angle_mode, true);
  assert.equal(P.parseRouterSettings("{not json").mode, 2);
  assert.equal(P.parseRouterSettings(JSON.stringify({ mode: 7 })).mode, 2);
});

test("message panel names: Corner Style and Mode follow the settings", () => {
  assert.equal(P.cornerStyleName({ corner_mode: 0 }), "45-degree"); assert.equal(P.cornerStyleName({ corner_mode: 1 }), "45-degree rounded");
  assert.equal(P.cornerStyleName({ corner_mode: 2 }), "90-degree"); assert.equal(P.cornerStyleName({ corner_mode: 3 }), "90-degree rounded");
  assert.equal(P.cornerStyleName({ corner_mode: 0, free_angle_mode: true }), "Free-angle");
});

test("BuildInitialTrace, 90° modes: startDiagonal == ( h >= w ) runs E first, otherwise N first", () => {
  assert.deepEqual(P.cornerLeg([0, 0], [10, 4], false, 2), [[0, 0], [10, 0], [10, 4]]);   // w > h, straight posture: the long axis first
  assert.deepEqual(P.cornerLeg([0, 0], [10, 4], true, 2), [[0, 0], [0, 4], [10, 4]]);
  assert.deepEqual(P.cornerLeg([0, 0], [3, 8], false, 2), [[0, 0], [0, 8], [3, 8]]);
  assert.deepEqual(P.cornerLeg([0, 0], [3, 8], true, 2), [[0, 0], [3, 0], [3, 8]]);
  assert.deepEqual(P.cornerLeg([0, 0], [10, 0], false, 2), [[0, 0], [10, 0]]);
  assert.deepEqual(P.cornerLeg([0, 0], [7, 3], false, 0, true), [[0, 0], [7, 3]], "free angle: one segment");
  assert.deepEqual(P.cornerLeg([0, 0], [10, 4], false, 0), [[0, 0], [6, 0], [10, 4]], "45°: straight then diagonal");
});

test("rounded corners: each corner becomes a tangent arc whose tangent length is the shorter leg", () => {
  const els = P.roundCorners([[0, 0], [10, 0], [10, 4]]);
  assert.deepEqual(els.map((e) => e.t), ["seg", "arc"]);
  assert.deepEqual(els[0].a, [0, 0]); assert.deepEqual(els[0].b, [6, 0]); assert.deepEqual(els[1].a, [6, 0]); assert.deepEqual(els[1].b, [10, 4]);
  const arc = K.arcFrom3(els[1].a, els[1].m, els[1].b); assert.ok(Math.abs(arc.r - 4) < 1e-6, "radius = the shorter run (ROUNDED_90)");
  const pts = P.elemsPts(els); assert.deepEqual(pts[0], [0, 0]); assert.deepEqual(pts[pts.length - 1], [10, 4]);
  // headElems keeps the mitred corner when the fillet would not be clear
  assert.equal(P.headElems([[0, 0], [10, 0], [10, 4]], 3, () => false).every((e) => e.t === "seg"), true);
  assert.equal(P.headElems([[0, 0], [10, 0], [10, 4]], 3, () => true).some((e) => e.t === "arc"), true);
  assert.equal(P.headElems([[0, 0], [10, 0], [10, 4]], 2).every((e) => e.t === "seg"), true);
});

test("no micro segments: a sliver under 10 µm folds into its neighbour", () => {
  const els = [{ t: "seg", a: [0, 0], b: [5, 0] }, { t: "seg", a: [5, 0], b: [5.002, 0] }, { t: "seg", a: [5.002, 0], b: [8, 3] }];
  const f = P.foldMicro(els); assert.equal(f.length, 2); assert.deepEqual(f[0].b, [5.002, 0]); assert.deepEqual(f[1].a, [5.002, 0]);
  const lead = P.foldMicro([{ t: "seg", a: [0, 0], b: [0.001, 0] }, { t: "seg", a: [0.001, 0], b: [4, 0] }]); assert.equal(lead.length, 1); assert.deepEqual(lead[0].a, [0, 0]);
  assert.deepEqual(P.foldMicro([{ t: "seg", a: [5, 0], b: [5.002, 0] }]), [], "a lone sliver adds nothing");
});

test("LINE::Walkaround on a convex hull: round either way, never inside", () => {
  const H = P.octagon([[5, -1], [5, 1]], 1);
  assert.equal(P.insideConvex(H, [5, 0]), true); assert.equal(P.insideConvex(H, [0, 0]), false);
  for (const dir of [1, -1]) {
    const w = P.walkAroundHull([[0, 0], [10, 0]], H, dir); assert.ok(w && w.length > 2);
    assert.deepEqual(w[0], [0, 0]); assert.deepEqual(w[w.length - 1], [10, 0]);
    for (let i = 0; i + 1 < w.length; i++) assert.equal(P.insideConvex(H, [(w[i][0] + w[i + 1][0]) / 2, (w[i][1] + w[i + 1][1]) / 2]), false);
    assert.equal(P.selfIntersecting(w), false);
  }
  assert.equal(P.walkAroundHull([[5, 0], [10, 0]], H, 1), null, "a path that starts inside cannot walk round");
});

test("router mode actions: the three modes, their check marks, Cycle Router Mode", () => {
  const { ctx } = fakeCtx(board());
  pcb.actions.routerHighlightMode.run(ctx); assert.equal(pcb.routerSettings().mode, 0);
  let c = pcb.routerChecks(); assert.equal(c["PCB_ACTIONS::routerHighlightMode"], true); assert.equal(c.routerShoveMode, false);
  pcb.actions.cycleRouterMode.run(ctx); assert.equal(pcb.routerSettings().mode, 1);
  pcb.actions.cycleRouterMode.run(ctx); assert.equal(pcb.routerSettings().mode, 2);
  pcb.actions.cycleRouterMode.run(ctx); assert.equal(pcb.routerSettings().mode, 0);
  pcb.actions.routerShoveMode.run(ctx); c = pcb.routerChecks(); assert.equal(c.routerShoveMode, true); assert.equal(c.routerWalkaroundMode, false);
});

test("corner mode hotkeys belong to the route tool: Ctrl+/ cycles, Ctrl+W, Ctrl+Shift+W, Ctrl+Alt+W, Alt+W", () => {
  const K_ = (key, o) => P.routerKeyAction(Object.assign({ key, code: /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : "" }, o));
  assert.equal(K_("/", { ctrlKey: true }), "ACT_SwitchCornerModeToNext");
  assert.equal(K_("w", { ctrlKey: true }), "ACT_SwitchCornerMode45");
  assert.equal(K_("W", { ctrlKey: true, shiftKey: true }), "ACT_SwitchCornerModeArc45");
  assert.equal(K_("w", { ctrlKey: true, altKey: true }), "ACT_SwitchCornerMode90");
  assert.equal(K_("w", { altKey: true }), "ACT_SwitchCornerModeArc90");
  assert.equal(K_("w", {}), null, "plain W steps the track width");
  const { ctx } = fakeCtx(board());
  for (const want of [1, 2, 3, 0]) { pcb.actions.ACT_SwitchCornerModeToNext.run(ctx); assert.equal(pcb.routerSettings().corner_mode, want); }
  pcb.actions.ACT_SwitchCornerModeArc90.run(ctx); assert.equal(pcb.routerChecks().ACT_SwitchCornerModeArc90, true);
});

test("routing hotkeys only while routing: Ctrl+Z takes a segment back, Ctrl+V a microvia, Alt+Shift+V a blind via", () => {
  const ctrlZ = { key: "z", code: "KeyZ", ctrlKey: true };
  assert.equal(P.routerKeyAction(ctrlZ), null, "no route: Ctrl+Z is the editor's undo");
  const { ctx } = fakeCtx(board()); startRoute(ctx, [20, 10]);
  assert.equal(P.routerKeyAction(ctrlZ), "routerUndoLastSegment");
  assert.equal(P.routerKeyAction({ key: "v", code: "KeyV", ctrlKey: true }), "ACT_PlaceMicroVia");
  assert.equal(P.routerKeyAction({ key: "V", code: "KeyV", altKey: true, shiftKey: true }), "ACT_PlaceBlindVia");
});

test("the route is one transaction: Backspace / Ctrl+Z undo a segment silently, Escape discards everything", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 2 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [25, 7], ctx); pcb.onPointerDown(ev(), [25, 7], ctx);
  pcb.onPointerMove(ev(), [30, 7], ctx); pcb.onPointerDown(ev(), [30, 7], ctx);
  assert.equal(P.state.route.stages.length, 2); assert.equal(log.commits.length, 0);
  assert.equal(pcb.actions.routerUndoLastSegment.run(ctx) !== false, true); assert.equal(P.state.route.stages.length, 1);
  assert.deepEqual(P.state.route.last, [25, 7]); assert.equal(log.toasts.length, 0, "silently");
  pcb.cancel(); assert.equal(P.state.route, null);   // Escape (onCaptureKey -> the operation is cancelled)
  assert.equal(log.commits.length, 0, "Escape leaves the board as it was"); assert.equal(segsOf(doc, "A").length, 1);
});

test("Highlight collisions: the head goes straight through, a click in violation is refused unless DRC violations are allowed", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 0 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [20, 14], ctx);
  const rt = P.state.route; assert.ok(rt.collisions && rt.collisions.length, "the crossing is marked"); assert.deepEqual(rt.head[rt.head.length - 1], [20, 14]);
  pcb.onPointerDown(ev(), [20, 14], ctx); assert.equal(P.state.route.stages.length, 0, "refused");
  P.setRouterSettings({ can_violate_drc: true });
  P.state.route.clickT = 0;   // not a double click (which would finish the route)
  pcb.onPointerMove(ev(), [20, 14.25], ctx); pcb.onPointerMove(ev(), [20, 14], ctx); pcb.onPointerDown(ev(), [20, 14], ctx);
  assert.equal(P.state.route.stages.length, 1, "allowed");
  pcb.onKey("End", ev(), ctx); assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  assert.equal(segsOf(doc, "B").length, 1, "nothing of net B moved");
});

test("Shove: the head pushes net B's track aside, it springs back when the cursor leaves, End commits both", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 1 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [20, 11.75], ctx);
  const rt = P.state.route; assert.ok(rt.shove, "a shove is in progress"); assert.ok(rt.shove.preview.hidden.has("sb"));
  const moved = rt.shove.preview.lines[0].pts; assert.ok(moved.some((p) => p[1] > 12 + 1e-6), "pushed down: " + JSON.stringify(moved));
  assert.deepEqual(pcb.hiddenIds && [...(pcb.hiddenIds() || [])].includes("sb"), true);
  pcb.onPointerMove(ev(), [25, 9], ctx); assert.equal(P.state.route.shove ? P.state.route.shove.ops.length : 0, 0, "springback");
  pcb.onPointerMove(ev(), [20, 11.75], ctx); pcb.onPointerDown(ev(), [20, 11.75], ctx);
  pcb.onKey("End", ev(), ctx);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  const b = segsOf(doc, "B"); assert.ok(b.length > 1, "net B's track bent round the new one");
  const ends = b.flatMap((it) => [P.pt(it.node, "start"), P.pt(it.node, "end")]);
  assert.ok(ends.some((p) => p[0] === 5 && p[1] === 12) && ends.some((p) => p[0] === 30 && p[1] === 12), "its ends stay where they were");
  // clearance holds: no B segment comes within 0.2 mm + half widths of the new A end
  const end = [20, 11.75];
  for (const it of b) { const a = P.pt(it.node, "start"), c = P.pt(it.node, "end"); const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 ? Math.max(0, Math.min(1, ((end[0] - a[0]) * dx + (end[1] - a[1]) * dy) / l2)) : 0; assert.ok(Math.hypot(a[0] + k * dx - end[0], a[1] + k * dy - end[1]) >= 0.25 + 0.2 - 1e-3); }
});

// a collaborator's edit while the route is open (applied to the board, not through ctx.commit)
const remote = (ctx, change) => { K.applyChange(ctx.doc, change, IU); pcb.onDocChanged(ctx); };

test("Shove, collaboration: a track a peer deletes while the route is open stays deleted when the route is committed", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 1 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [20, 11.75], ctx); pcb.onPointerDown(ev(), [20, 11.75], ctx);
  const ops = P.state.route.stages[0].ops; assert.ok(ops.some((o) => o.set === "sb" && typeof o.base === "string"), "the shove op records what it was computed from");
  remote(ctx, P.removedChange(doc.items.get("sb")));
  assert.equal(segsOf(doc, "B").length, 0);
  pcb.onKey("End", ev(), ctx);
  assert.equal(log.commits.length, 1); const ch = log.commits[0].changes;
  assert.equal(segsOf(doc, "B").length, 0, "net B's track is not brought back");
  assert.ok(!ch.some((c) => c.id === "sb"), "no change for the deleted track");
  assert.ok(segsOf(doc, "A").length > 1, "the route itself is committed");
});

test("Shove, collaboration: a peer's change to a shoved track is not overwritten by the copy the router saw", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 1 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [20, 11.75], ctx); pcb.onPointerDown(ev(), [20, 11.75], ctx);
  const node = K.clone ? K.clone(doc.items.get("sb").node) : JSON.parse(JSON.stringify(doc.items.get("sb").node)); K.kid(node, "width")[1] = 0.5;
  remote(ctx, P.replacedChange(doc.items.get("sb"), node));
  pcb.onKey("End", ev(), ctx);
  assert.equal(log.commits.length, 1);
  const sb = doc.items.get("sb"); assert.equal(K.num(K.kid(sb.node, "width")[1]), 0.5, "the peer's width stays");
  assert.deepEqual([P.pt(sb.node, "start"), P.pt(sb.node, "end")], [[5, 12], [30, 12]], "and its geometry is the peer's, not the stale shoved copy");
  assert.equal(segsOf(doc, "B").length, 1, "none of the stale shoved line's new pieces are added");
});

test("branchDoc: a stale edit drops its whole group (a split track's head and tail together)", () => {
  const doc = board();
  const ops = P.splitOps(doc, { id: "sa", point: [15, 10], node: doc.items.get("sa").node });
  assert.equal(ops.length, 2); assert.equal(ops[0].grp, ops[1].grp);
  assert.equal(P.branchChanges(doc, P.branchDoc(doc, ops)).length, 2, "fresh: the split applies");
  const n = JSON.parse(JSON.stringify(doc.items.get("sa").node)); K.kid(n, "width")[1] = 0.3; K.applyChange(doc, P.replacedChange(doc.items.get("sa"), n), IU);
  const b = P.branchDoc(doc, ops); assert.equal(b.__stale, 2); assert.equal(P.branchChanges(doc, b).length, 0, "the changed track is neither cut nor joined by a tail");
});

test("Edit > Undo / Redo while routing (menu, toolbar): Undo Last Segment, Redo blocked; the board's undo list is not reached", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 2 });
  assert.equal(pcb.undoRedo(ctx, "undo"), false, "nothing in flight: the global undo runs");
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [25, 7], ctx); pcb.onPointerDown(ev(), [25, 7], ctx);
  pcb.onPointerMove(ev(), [30, 7], ctx); pcb.onPointerDown(ev(), [30, 7], ctx);
  assert.equal(P.state.route.stages.length, 2);
  assert.equal(pcb.undoRedo(ctx, "redo"), true); assert.equal(P.state.route.stages.length, 2, "redo does nothing");
  assert.equal(pcb.undoRedo(ctx, "undo"), true); assert.equal(P.state.route.stages.length, 1, "undo takes the last segment back");
  assert.ok(P.state.route, "routing goes on"); assert.equal(log.commits.length, 0);
  assert.equal(pcb.undoRedo(ctx, "undo"), true); assert.equal(pcb.undoRedo(ctx, "undo"), true, "silent with nothing fixed"); assert.ok(P.state.route);
});

test("Walk around: the head walks round net B instead of pushing it", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 2 });
  startRoute(ctx, [20, 10]);
  pcb.onPointerMove(ev(), [20, 14], ctx);
  const rt = P.state.route; assert.ok(!rt.shove || !rt.shove.ops.length);
  pcb.onKey("End", ev(), ctx); assert.equal(segsOf(doc, "B").length, 1, "net B untouched");
  assert.ok(log.commits.length <= 1);
});

test("V: the via plan follows KiCad's rules (layer pair, blind needs two layers, micro to the neighbour)", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  startRoute(ctx, [20, 10]); const rt = P.state.route;
  const t = P.viaPlan(ctx, rt, "through"); assert.equal(t.type, "through"); assert.equal(t.toLayer, "B.Cu"); assert.deepEqual(t.span, ["F.Cu", "B.Cu"]);
  const b = P.viaPlan(ctx, rt, "blind", "In1.Cu"); assert.equal(b.type, "blind"); assert.equal(b.toLayer, "In1.Cu"); assert.deepEqual(b.span, ["F.Cu", "In1.Cu"]);
  const across = P.viaPlan(ctx, rt, "blind", "B.Cu"); assert.equal(across.type, "through", "a blind via across the whole board is a through via");
  const m = P.viaPlan(ctx, rt, "micro", "In1.Cu"); assert.equal(m.type, "micro"); assert.ok(m.diameter < t.diameter);
});

test("Shove drag: dragging net A's track onto net B pushes B, one commit carries both", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 1 });
  P.state.sel = new Set(["sa"]); ctx.cursor = [15, 10];
  assert.equal(pcb.onKey("d", ev(), ctx), true); assert.ok(P.state.drag);
  pcb.onPointerMove(ev(), [15, 11.75], ctx);
  const d = P.state.drag.subs[0]; assert.equal(d.status, true); assert.ok(d.shove && d.shove.ops.length, "B is pushed");
  assert.ok([...pcb.hiddenIds()].includes("sb"));
  pcb.onPointerDown(ev(), [15, 11.75], ctx);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "drag track");
  assert.ok(log.commits[0].changes.some((c) => c.id === "sb"), "the shoved track is in the same commit");
});

test("Highlight collisions drag: the step is shown with its collisions and cannot be fixed (unless violations are allowed)", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ mode: 0 });
  P.state.sel = new Set(["sa"]); ctx.cursor = [15, 10];
  pcb.onKey("d", ev(), ctx); pcb.onPointerMove(ev(), [15, 11.75], ctx);
  const d = P.state.drag.subs[0]; assert.equal(d.status, false); assert.ok(d.hits.length);
  pcb.onPointerDown(ev(), [15, 11.75], ctx); assert.equal(log.commits.length, 0);
  pcb.cancel();
  P.setRouterSettings({ can_violate_drc: true });
  P.state.sel = new Set(["sa"]); ctx.cursor = [15, 10];
  pcb.onKey("d", ev(), ctx); pcb.onPointerMove(ev(), [15, 11.75], ctx); assert.equal(P.state.drag.subs[0].status, true);
  pcb.onPointerDown(ev(), [15, 11.75], ctx); assert.equal(log.commits.length, 1);
});

test("Interactive Router Settings: KiCad's rows and tooltips, onModeChange enabling, TransferDataFromWindow", () => {
  assert.deepEqual(RS.exports.PNS_ROUTING_ROWS.map((r) => r[1]), ["Remove redundant tracks", "Optimize pad connections", "Use mouse path to set track posture", "Fix all segments on click"]);
  assert.deepEqual(RS.exports.PNS_DRAGGING_ROWS.map((r) => r[1]), ["Smooth dragged segments", "Optimize entire track being dragged", "Avoid sharp angles", "Keep coupling between differential pairs"]);
  const f = RS.exports.pnsForm(Object.assign({}, P.RS_DEFAULTS, { mode: 0 }));
  assert.equal(f.enabled("free_angle_mode"), true); assert.equal(f.enabled("can_violate_drc"), true); assert.equal(f.enabled("shove_vias"), false);
  f.set("mode", 1); assert.equal(f.enabled("free_angle_mode"), false); assert.equal(f.enabled("shove_vias"), true); assert.equal(f.enabled("jump_over_obstacles"), true);
  f.set("mode", 2); assert.equal(f.enabled("shove_vias"), false); assert.equal(f.enabled("remove_loops"), true);
  f.set("fix_all_segments", false);
  const out = f.result(); assert.equal(out.mode, 2); assert.equal(out.fix_all_segments, false); assert.equal(out.shove_vias, true);
  pcb.setRouterSettings(out); assert.equal(pcb.routerSettings().fix_all_segments, false); assert.equal(pcb.routerSettings().mode, 2);
});

reset();
const SP_BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "T:P" (layer "F.Cu") (uuid "fa") (at 10 10) (pad "1" smd rect (at 0 0) (size 1 3) (layers "F.Cu") (net "S") (uuid "pa"))))`;
function spHead(on, extra) {
  const doc = K.parseDoc(SP_BOARD, "kicad_pcb"); const { ctx } = fakeCtx(doc); pcb.onDocChanged(ctx); pcb.setLayer(ctx, "F.Cu");
  P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS, { smart_pads: on }, extra || {}));
  startRoute(ctx, [10, 10]);
  for (const q of [[10.5, 10.5], [11, 11], [11.5, 11.5], [12, 12], [13, 12], [14, 12], [15, 12]]) pcb.onPointerMove(ev(), q, ctx);
  const h = P.state.route.head.map((p) => p.slice()); pcb.cancel(); return h;
}

test("SMART_PADS: Optimize pad connections replaces the pad exit with the cheapest clean breakout (ties: the longer exit)", () => {
  assert.deepEqual(spHead(false), [[10, 10], [12, 12], [15, 12]], "the head as walked");
  assert.deepEqual(spHead(true), [[10, 10], [13, 10], [15, 12]], "straight out of the pad's side, then 45°");
  assert.deepEqual(spHead(true, { corner_mode: 2 }), spHead(false, { corner_mode: 2 }), "90° modes are left alone");
  assert.deepEqual(spHead(true, { mode: 0 }), [[10, 10], [12, 12], [15, 12]], "not in Highlight collisions");
});

test("computeBreakouts: four straight and four diagonal exits of a rectangle, eight rays from a circle", () => {
  const rect = P.padBreakouts({ x: 0, y: 0, w: 1, h: 3, rot: 0, shape: "rect" }, 0.25);
  assert.equal(rect.length, 8); assert.deepEqual(rect[0], [[0, 0], [0.75, 0]]); assert.deepEqual(rect[2], [[0, 0], [0, 1.75]]);
  assert.deepEqual(rect[4], [[0, 0], [0, 1], [0.75, 1.75]], "a diagonal exit from the end of the long side");
  const circ = P.padBreakouts({ x: 0, y: 0, w: 1, h: 1, rot: 0, shape: "circle" }, 0.25); assert.equal(circ.length, 8);
  assert.ok(Math.abs(Math.hypot(...circ[1][1]) - 0.5 * Math.SQRT2) < 1e-9);
  assert.equal(P.cornerCost([[0, 0], [1, 0], [2, 1]]), 10); assert.equal(P.cornerCost([[0, 0], [1, 0], [1, 1]]), 30);
});

test("smartPadsSingle: no breakouts for an offset pad; a vertex p whose leg misses the pad shape is skipped", () => {
  const pad = { x: 10, y: 10, w: 1, h: 3, rot: 0, shape: "rect", off: [0, 0] };
  const line = [[10, 10], [12, 12], [15, 12]]; const clear = () => true;
  const r = P.smartPadsSingle(line, pad, 0.25, false, 3, clear);
  assert.ok(r, "a centred pad gets its breakout"); assert.deepEqual(r.pts, [[10, 10], [13, 10], [15, 12]]);
  assert.equal(P.smartPadsSingle(line, Object.assign({}, pad, { off: [0.5, 0] }), 0.25, false, 3, clear), null, "solid->Offset() != 0: -1");
  // the first vertex is off the pad (a line that does not start in it): SEG(line[0], line[p]) never meets the pad
  assert.equal(P.smartPadsSingle([[20, 10], [22, 12], [25, 12]], pad, 0.25, false, 3, clear), null);
  const sizes = K.parseDoc(`(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal)) (net 0 "") (footprint "T:X" (layer "F.Cu") (uuid "f") (at 0 0)
    (pad "1" thru_hole oval (at 1 2) (size 2 3) (drill 1 (offset 0.3 -0.2)) (layers "*.Cu") (uuid "p"))))`, "kicad_pcb");
  const fp = [...sizes.items.values()].find((i) => i.kind === "footprint");
  assert.deepEqual(P.padsOf(fp)[0].off, [0.3, -0.2], "padsOf reads (drill … (offset x y))");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
