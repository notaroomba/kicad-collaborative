// diffpair.test.js — Route Differential Pair (pcb-tools.js, after pcbnew/router/pns_diff_pair_placer.cpp):
// BOARD::MatchDpSuffix, FindDpPrimitivePair and its failure messages, the coupled lines at the pair's gap, walk around,
// Highlight collisions, the via pair, Backspace, landing on the target pair as one "Route Track" commit, the pair's
// sizes (BOARD_DESIGN_SETTINGS / pcb-sizes.ts routeDiffPair), DIFF_PAIR_MENU and the Differential Pair Dimensions
// dialog's logic (web/editor/routersettings.ts), and the router menu's diffPairCond (web/editor/ctxmenus.ts).
// Run: node server/static/tests/diffpair.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const CM = load(["editor", "ctxmenus.ts"]);
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }

// a connector pair (USB_D+ / USB_D-) at (10, 10), the target pair at (20, 30), a GND pad in the way at (12, 20)
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (footprint "T:J" (layer "F.Cu") (uuid "j1") (at 10 10)
    (pad "1" smd rect (at 0 0) (size 0.4 1) (layers "F.Cu") (net "USB_D+") (uuid "p1"))
    (pad "2" smd rect (at 0.65 0) (size 0.4 1) (layers "F.Cu") (net "USB_D-") (uuid "p2")))
  (footprint "T:U" (layer "F.Cu") (uuid "u1") (at 20 30)
    (pad "1" smd rect (at 0 0) (size 0.4 1) (layers "F.Cu") (net "USB_D+") (uuid "q1"))
    (pad "2" smd rect (at 0.65 0) (size 0.4 1) (layers "F.Cu") (net "USB_D-") (uuid "q2")))
  (footprint "T:G" (layer "F.Cu") (uuid "g1") (at 12 20)
    (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net "GND") (uuid "g")))
  (segment (start 30 10) (end 30 14) (width 0.2) (layer "F.Cu") (net "CLK_P") (uuid "sp"))
  (segment (start 30.45 10) (end 30.45 14) (width 0.2) (layer "F.Cu") (net "CLK_N") (uuid "sn"))
)`;
function fakeCtx(text) {
  const doc = K.parseDoc(text || BOARD, "kicad_pcb");
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.05, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.05) * 0.05), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx); pcb.setLayer(ctx, "F.Cu");   // a via pair leaves the active layer on the far side
  return { ctx, log, doc };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
function reset() { try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ } P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); K.pcbSizes.state.reset(); }
const segs = (doc, net) => [...doc.items.values()].filter((it) => it.kind === "segment" && K.str(K.kid(it.node, "net")[1]) === net);
const vias = (doc) => [...doc.items.values()].filter((it) => it.kind === "via");
const ends = (it) => [P.pt(it.node, "start"), P.pt(it.node, "end")];
/** The perpendicular distance between two parallel segments (NaN when they are not parallel). */
function parallelGap(a, b) {
  const u = [a[1][0] - a[0][0], a[1][1] - a[0][1]], v = [b[1][0] - b[0][0], b[1][1] - b[0][1]]; const lu = Math.hypot(...u), lv = Math.hypot(...v);
  if (lu < 1e-9 || lv < 1e-9 || Math.abs(u[0] * v[1] - u[1] * v[0]) / (lu * lv) > 1e-6) return NaN;
  return Math.abs((b[0][0] - a[0][0]) * u[1] - (b[0][1] - a[0][1]) * u[0]) / lu;
}
const startPair = (ctx, at) => { ctx.setTool("routediff"); pcb.onPointerDown(ev(), at, ctx); };

console.log("route differential pair");

test("BOARD::MatchDpSuffix: the last of + - P N after trailing digits and '_' names the complement", () => {
  const m = (n) => { const r = P.matchDpSuffix(n); return [r.rv, r.complement]; };
  assert.deepEqual(m("USB_D+"), [1, "USB_D-"]); assert.deepEqual(m("USB_D-"), [-1, "USB_D+"]);
  assert.deepEqual(m("CLK_P"), [1, "CLK_N"]); assert.deepEqual(m("CLK_N"), [-1, "CLK_P"]);
  assert.deepEqual(m("D1P2"), [1, "D1N2"]); assert.deepEqual(m("LVDS_N_3"), [-1, "LVDS_P_3"]);
  assert.deepEqual(m("VCC"), [0, ""]); assert.deepEqual(m("GND"), [0, ""]); assert.deepEqual(m(""), [0, ""]);
});

test("DpNetPair: both nets must exist; P is the + / P net whichever was clicked", () => {
  const { doc } = fakeCtx();
  const r = P.dpNetPair(doc, { code: -1, name: "USB_D-" }); assert.equal(r.P.name, "USB_D+"); assert.equal(r.N.name, "USB_D-");
  assert.equal(P.dpNetPair(doc, { code: -1, name: "GND" }), null);
  assert.equal(P.dpNetPair(doc, { code: -1, name: "SDA_P" }), null, "no SDA_N on the board");
});

test("FindDpPrimitivePair: a pad and the nearest pad of the partner net; a track end only when it dangles", () => {
  const { doc } = fakeCtx();
  const r = P.findDpPrimitivePair(doc, { kind: "pad", x: 10.65, y: 10, net: { code: -1, name: "USB_D-" } }, [10.65, 10], "F.Cu", { code: -1, name: "USB_D-" });
  assert.ok(r.pair); assert.deepEqual(r.pair.P.p, [10, 10]); assert.deepEqual(r.pair.N.p, [10.65, 10]);
  const t = P.findDpPrimitivePair(doc, null, [30, 14], "F.Cu", { code: -1, name: "CLK_P" });
  assert.ok(t.pair, "the open ends of the CLK pair"); assert.deepEqual(t.pair.N.p, [30.45, 14]); assert.deepEqual(t.pair.P.dir, [0, 1]);
  const mid = P.findDpPrimitivePair(doc, null, [30, 12], "F.Cu", { code: -1, name: "CLK_P" });
  assert.equal(mid.error, P.DP_MSG_START, "mid-track is not an end");
  assert.equal(P.findDpPrimitivePair(doc, null, [30, 12], "F.Cu", { code: -1, name: "GND" }).error, P.DP_MSG_NETS);
});

test("start refusals: KiCad's messages for a net with no partner, nowhere, and a gap below the board minimum clearance", () => {
  const { ctx, log } = fakeCtx();
  startPair(ctx, [12, 20]); assert.equal(log.toasts.pop(), P.DP_MSG_NETS); assert.equal(P.state.route, null);
  startPair(ctx, [5, 5]); assert.equal(log.toasts.pop(), P.DP_MSG_NOWHERE);
  pcb.setDesignSettings({ board: { design_settings: { rules: { min_clearance: 0.3 } } } });
  try { startPair(ctx, [10, 10]); assert.equal(log.toasts.pop(), P.DP_MSG_GAP); assert.equal(P.state.route, null); }
  finally { pcb.setDesignSettings(null); }
});

test("the pair leaves its pads converging at 45° into two lines coupled at width + gap", () => {
  const { ctx } = fakeCtx(); startPair(ctx, [10, 10]);
  const rt = P.state.route; assert.ok(rt && rt.dp); assert.equal(rt.netKey, "USB_D+"); assert.equal(rt.netKeyN, "USB_D-");
  pcb.onPointerMove(ev(), [10.3, 15], ctx);
  const L = rt.dpLines; assert.ok(rt.dpFit);
  assert.deepEqual(L.P[0], [10, 10]); assert.deepEqual(L.N[0], [10.65, 10]);
  assert.ok(Math.abs(parallelGap([L.P[1], L.P[2]], [L.N[1], L.N[2]]) - 0.45) < 1e-6, "coupled at 0.2 + 0.25");
});

test("a cursor beside the gateway's line keeps the straight run (routeHead's lead_dist <= snapThreshold)", () => {
  const { ctx } = fakeCtx(); startPair(ctx, [10, 10]); const rt = P.state.route;
  pcb.onPointerMove(ev(), [10.4, 16], ctx);
  assert.equal(rt.dpLines.centre.length, 2); assert.equal(rt.dpLines.centre[1][0], rt.dpLines.centre[0][0]);
});

test("walk around: the coupled pair goes round a pad of another net; every line keeps its clearance", () => {
  const { ctx, doc } = fakeCtx(); startPair(ctx, [10, 10]); const rt = P.state.route;
  pcb.onPointerMove(ev(), [10.3, 15], ctx); pcb.onPointerDown(ev(), [10.3, 15], ctx); assert.equal(rt.stages.length, 1);
  pcb.onPointerMove(ev(), [12, 24], ctx);
  assert.ok(rt.dpFit, "a clean fit");
  const O = P.routeObstacles(doc, P.designSettings(null), "USB_D+", "F.Cu", null);
  const gnd = (pts) => P.pathHits(O, pts, 0.1).filter((o) => o.net === "GND");
  assert.equal(gnd(rt.dpLines.P).length, 0); assert.equal(gnd(rt.dpLines.N).length, 0);
  assert.ok(rt.reached, "the pair reaches the cursor below the pad");
});

test("landing on the partner pads finishes: both nets, one 'Route Track' commit, pads connected", () => {
  const { ctx, log, doc } = fakeCtx(); startPair(ctx, [10, 10]); const rt = P.state.route;
  pcb.onPointerMove(ev(), [10.3, 15], ctx); pcb.onPointerDown(ev(), [10.3, 15], ctx);
  pcb.onPointerMove(ev(), [20, 30], ctx); assert.ok(rt.dpTargetPair, "snapped onto the target pair");
  pcb.onPointerDown(ev(), [20, 30], ctx);
  assert.equal(P.state.route, null); assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Route Track");
  const sp = segs(doc, "USB_D+"), sn = segs(doc, "USB_D-"); assert.ok(sp.length >= 3 && sn.length >= 3);
  const hasEnd = (list, p) => list.some((s) => ends(s).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6));
  assert.ok(hasEnd(sp, [10, 10]) && hasEnd(sp, [20, 30])); assert.ok(hasEnd(sn, [10.65, 10]) && hasEnd(sn, [20.65, 30]));
  const nl = P.netlist(doc); assert.equal(nl.nets.get("USB_D+").unconnected, 0); assert.equal(nl.nets.get("USB_D-").unconnected, 0);
});

test("Highlight collisions: the lines go straight, the obstacle is marked and the click does not fix", () => {
  const { ctx } = fakeCtx(); P.setRouterSettings({ mode: 0 }); startPair(ctx, [10, 10]); const rt = P.state.route;
  pcb.onPointerMove(ev(), [12.3, 22], ctx); assert.ok(rt.collisions && rt.collisions.some((o) => o.net === "GND")); assert.equal(rt.dpFit, false);
  pcb.onPointerDown(ev(), [12.3, 22], ctx); assert.equal(rt.stages.length, 0);
});

test("V: a via pair at the via gap ends both lines; routing goes on on the other layer; Backspace takes it back", () => {
  const { ctx, doc } = fakeCtx(); startPair(ctx, [10, 10]); const rt = P.state.route;
  pcb.onPointerMove(ev(), [10.3, 15], ctx); pcb.onKey("v", ev(), ctx); assert.ok(rt.placingVia);
  const V = rt.dpLines.vias; assert.ok(V); assert.ok(Math.abs(Math.hypot(V.P[0] - V.N[0], V.P[1] - V.N[1]) - (0.25 + 0.6)) < 1e-6, "centres at via gap + diameter");
  pcb.onPointerDown(ev(), [10.3, 15], ctx);
  assert.equal(rt.layer, "B.Cu"); assert.equal(rt.stages.length, 1); assert.equal(rt.dpStart.P.kind, "via");
  pcb.onKey("Backspace", ev(), ctx); assert.equal(rt.stages.length, 0); assert.equal(rt.layer, "F.Cu");
  pcb.onPointerMove(ev(), [10.3, 15], ctx); pcb.onKey("v", ev(), ctx); pcb.onPointerDown(ev(), [10.3, 15], ctx);
  pcb.onKey("End", ev(), ctx); assert.equal(vias(doc).length, 2);
  assert.deepEqual(vias(doc).map((v) => K.str(K.kid(v.node, "net")[1])).sort(), ["USB_D+", "USB_D-"]);
});

test("a pair of track ends carries on in the tracks' direction", () => {
  const { ctx } = fakeCtx(); startPair(ctx, [30, 14]); const rt = P.state.route; assert.ok(rt, "started on the CLK ends");
  pcb.onPointerMove(ev(), [30.2, 20], ctx);
  assert.deepEqual(rt.dpLines.P[0], [30, 14]); assert.deepEqual(rt.dpLines.N[0], [30.45, 14]);
  assert.equal(rt.dpLines.P[1][0], 30); assert.equal(rt.dpLines.N[1][0], 30.45);
});

test("offsetPts: a mitred 45° line offset either side keeps the spacing on every run", () => {
  const c = [[0, 0], [0, 5], [5, 10], [12, 10]];
  const a = P.offsetPts(c, 0.3, [0, 1]), b = P.offsetPts(c, -0.3, [0, 1]);
  for (let i = 0; i + 1 < c.length; i++) assert.ok(Math.abs(parallelGap([a[i], a[i + 1]], [b[i], b[i + 1]]) - 0.6) < 1e-6);
});

test("sizes: the net class pair values, then a list entry, then custom values; floored at the board minimums", () => {
  const R = K.pcbSizes.state;
  R.load(JSON.stringify({ board: { design_settings: { diff_pair_dimensions: [{ width: 0, gap: 0, via_gap: 0 }, { width: 0.15, gap: 0.2, via_gap: 0 }, { width: 0.3, gap: 0, via_gap: 0 }], rules: { min_track_width: 0.1, min_clearance: 0.18 } } },
    net_settings: { classes: [{ name: "Default", clearance: 0.2, diff_pair_width: 0.12, diff_pair_gap: 0.1, diff_pair_via_gap: 0.3 }, { name: "USB", priority: 0, diff_pair_width: 0.22, diff_pair_gap: 0.2 }], netclass_patterns: [{ pattern: "USB_*", netclass: "USB" }] } }));
  let d = R.routeDiffPair("USB_D+"); assert.deepEqual([d.width, d.gap, d.viaGap, d.widthSource], [0.22, 0.2, 0.3, "netclass 'USB'"]);
  d = R.routeDiffPair("X_P"); assert.deepEqual([d.width, d.gap, d.gapSource], [0.12, 0.18, "board minimum clearance"]);
  R.setDiffPairIndex(1); d = R.routeDiffPair("USB_D+"); assert.deepEqual([d.width, d.gap, d.viaGap, d.widthSource], [0.15, 0.2, 0.2, "user choice"]);
  R.setDiffPairIndex(2); d = R.routeDiffPair("USB_D+"); assert.deepEqual([d.width, d.gap], [0.3, 0.2], "a list entry without a gap keeps the class gap");
  R.setCustomDiffPair({ width: 0.25, gap: 0.3, via_gap: 0.5 }, true); d = R.routeDiffPair("USB_D+"); assert.deepEqual([d.width, d.gap, d.viaGap], [0.25, 0.3, 0.3]);
  R.setCustomDiffPair({ width: 0.25, gap: 0.3, via_gap: 0.5 }, false); assert.equal(R.routeDiffPair("USB_D+").viaGap, 0.5);
  assert.equal(R.useNetclassDiffPair, false); R.setDiffPairIndex(0); assert.equal(R.useNetclassDiffPair, true);
  assert.deepEqual(R.diffPairLabels((v) => v + " mm"), ["Width 0.15 mm, gap 0.2 mm", "Width 0.3 mm"]);
});

test("DIFF_PAIR_MENU: Use Net Class Values / Use Custom Values... checks, the list's entries, picking one", () => {
  const { ctx } = fakeCtx(); const R = K.pcbSizes.state;
  R.load(JSON.stringify({ board: { design_settings: { diff_pair_dimensions: [{ width: 0, gap: 0, via_gap: 0 }, { width: 0.15, gap: 0.2, via_gap: 0.3 }] } } }));
  let rows = pcb.diffPairMenu(ctx);
  assert.deepEqual(rows.map((r) => r.sep ? "-" : r.label), ["Use Net Class Values", "Use Custom Values...", "-", "Width 0.1500 mm, gap 0.2000 mm, via gap 0.3000 mm"]);
  assert.equal(rows[0].checked, true); rows[3].run(); rows = pcb.diffPairMenu(ctx); assert.equal(rows[0].checked, false); assert.equal(rows[3].checked, true);
  let opened = 0; pcb.setRoutingDialogs({ diffPair: () => { opened++; } }); rows[1].run(); assert.equal(opened, 1); assert.equal(pcb.diffPairMenu(ctx)[1].checked, true);
});

test("the router's menu shows Select Differential Pair Dimensions only while routing pairs", () => {
  const c = (tool) => ({ editor: "pcb", kinds: [], tool, busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: false, hasItems: true, checks: {} });
  const titles = (tool) => CM.evaluate(CM.menuFor(c(tool), true), c(tool)).filter((e) => e.menu).map((e) => e.menu.title);
  assert.ok(titles("routediff").includes("Select Differential Pair Dimensions"));
  assert.ok(!titles("route").includes("Select Differential Pair Dimensions"));
  assert.ok(titles("route").includes("Select Track/Via Width"));
});

test("Differential Pair Dimensions dialog: via gap follows the track gap when ticked; a track gap of 0 is refused", () => {
  const RS = load(["editor", "routersettings.ts"]);
  const f = RS.dpDimsForm({ width: 0.2, gap: 0.25, via_gap: 0.4 }, true);
  assert.equal(f.viaGapEnabled(), false); assert.deepEqual(f.result().dims, { width: 0.2, gap: 0.25, via_gap: 0.25 });
  f.values.same = false; assert.equal(f.viaGapEnabled(), true); assert.equal(f.result().dims.via_gap, 0.4);
  f.values.gap = 0; assert.equal(f.validate(), "Track gap must be greater than 0.");
  assert.equal(RS.parseLength("10", "mil"), 0.254); assert.equal(RS.parseLength("0.5mm", "mil"), 0.5); assert.ok(isNaN(RS.parseLength("abc", "mm")));
});

test("message panel while routing a pair: KiCad's rows", () => {
  const { ctx, doc } = fakeCtx(); startPair(ctx, [10, 10]);
  const rows = P.msgPanelInfo(doc, [], { route: P.state.route });
  assert.deepEqual(rows.map((r) => r.title), ["Routing Diff Pair: USB_D+, USB_D-", "Corner Style", "Mode", "Track Width: 0.2000 mm", "Min Clearance: 0.2000 mm", "Diff Pair Gap: 0.2500 mm"]);
  assert.equal(rows[0].value, "Resolved Netclass: Default"); assert.equal(rows[5].value, "(from netclass 'Default')");
});

// a coupled CLK pair (0.45 mm apart) between two kinks, plus a lone SIG track
const DRAG = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (segment (start 5 5) (end 10 10) (width 0.2) (layer "F.Cu") (net "CLK_P") (uuid "pa"))
  (segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net "CLK_P") (uuid "pb"))
  (segment (start 30 10) (end 35 5) (width 0.2) (layer "F.Cu") (net "CLK_P") (uuid "pc"))
  (segment (start 4.6818 5.3182) (end 9.8136 10.45) (width 0.2) (layer "F.Cu") (net "CLK_N") (uuid "na"))
  (segment (start 9.8136 10.45) (end 30.1864 10.45) (width 0.2) (layer "F.Cu") (net "CLK_N") (uuid "nb"))
  (segment (start 30.1864 10.45) (end 35.3182 5.3182) (width 0.2) (layer "F.Cu") (net "CLK_N") (uuid "nc"))
)`;
function dragPair(keep) {
  const f = fakeCtx(DRAG); const { ctx, log, doc } = f;
  P.setRouterSettings({ keep_diff_pair_coupling_when_dragging: keep });
  ctx.snapOn = false; ctx.snap = (m) => m;
  P.state.sel = new Set(["pb"]); ctx.cursor = [20, 10];
  pcb.onKey("d", ev(), ctx);
  const subs = P.state.drag ? P.state.drag.subs.length : 0;
  pcb.onPointerMove(ev(), [20, 12], ctx); pcb.onPointerDown(ev(), [20, 12], ctx);
  const ys = (net) => segs(doc, net).filter((it) => { const [a, b] = ends(it); return Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 5; }).map((it) => ends(it)[0][1]);
  return { subs, log, P_y: ys("CLK_P"), N_y: ys("CLK_N") };
}

test("MULTI_DRAGGER: dragging one segment of a pair takes its coupled partner along, the gap kept", () => {
  const { subs, log, P_y, N_y } = dragPair(true);
  assert.equal(subs, 2, "the partner segment joins the drag");
  assert.equal(log.commits.length, 1);
  assert.deepEqual(P_y, [12]); assert.ok(N_y.length === 1 && Math.abs(N_y[0] - 12.45) < 1e-6, "N moved by the same amount: " + N_y);
});

test("Keep coupling off: only the grabbed line moves", () => {
  const { subs, P_y, N_y } = dragPair(false);
  assert.equal(subs, 1); assert.deepEqual(P_y, [12]); assert.deepEqual(N_y, [10.45]);
});

test("dpCoupledSegment: the parallel partner at the pair's gap; nothing for a net without a partner", () => {
  const { ctx, doc } = fakeCtx(DRAG);
  const c = P.dpCoupledSegment(ctx, doc.items.get("pb")); assert.equal(c.item.id, "nb"); assert.deepEqual(c.grab, [20, 10.45]);
  assert.equal(P.dpCoupledSegment(ctx, doc.items.get("pa")).item.id, "na");
  const { ctx: c2, doc: d2 } = fakeCtx(); assert.equal(P.dpCoupledSegment(c2, d2.items.get("sp")).item.id, "sn");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
