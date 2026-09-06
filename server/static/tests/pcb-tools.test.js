// Node test for the board editing tools: routing legs, via/graphic node shapes,
// footprint rotate/flip invariants, hit testing, connected-run selection, a
// DOM-free drive of the module hooks, and the writer-exact fragments of the
// curve, text box, table, image, zone, rule area and dimension tools.
// Run: node server/static/tests/pcb-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

const FIXTURE = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (49 "F.Fab" user))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (transform (translate 100 50) (rotate -90) (scale 1 1))
    (property "Reference" "R1" (at 0 -1.5 -90) (layer "F.SilkS") (uuid "p-1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.5 -90) (layer "F.Fab") (uuid "p-2") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -1 -0.5) (end 1 -0.5) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l-1"))
    (pad "1" smd roundrect (at -0.9 0 -90) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "GND") (uuid "pad-1"))
    (pad "2" smd roundrect (at 0.9 0 -90) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "/SIG") (uuid "pad-2")))
  (segment (start 110 50) (end 115 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-1"))
  (segment (start 115 50) (end 118 53) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-2"))
  (via (at 118 53) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v-1"))
  (segment (start 118 53) (end 118 60) (width 0.25) (layer "B.Cu") (net "GND") (uuid "s-3"))
  (segment (start 130 50) (end 135 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-4"))
  (arc (start 140 50) (mid 141 51) (end 142 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "a-1"))
  (gr_line (start 90 40) (end 140 40) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "g-1"))
)`;
const CODE_STYLE = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 2 "GND")
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 2) (uuid "cs-1"))
)`;
const SAMPLE = "/private/tmp/claude-502/-Users-roomba-Documents-GitHub-kicad-collaborative/dbbcf49c-094f-41fc-be3a-cd8a1023d083/scratchpad/shape-test/orig/StickHub.kicad_pcb";

const fixture = () => K.parseDoc(FIXTURE, "kicad_pcb");
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const rot90 = (fx, fy, x, y) => [fx + (y - fy), fy - (x - fx)];   // +90° with Y down: CCW on screen, same as the renderer's rotator
const absPads = (node) => P.padsOf({ node }).map((p) => [p.x, p.y]);
const angleDiff = (a, b) => ((a - b) % 360 + 360) % 360;
// file round trip compared as text: the serializer writes numeric-looking strings (pad "1") bare, which KiCad reads the same
const roundTrips = (node) => K.serialize(K.parse(K.serialize(node))) === K.serialize(node);
// angles compared modulo 360 (real boards carry unnormalized 360 / 225 text angles), a zero angle dropped
function canon(node) {
  if (!Array.isArray(node)) return node;
  const out = node.map(canon);
  if (out[0] === "at" && out.length >= 4) { const a = angleDiff(out[3], 0); if (a === 0) out.length = 3; else out[3] = a; }
  if (out[0] === "rotate") out[1] = angleDiff(out[1], 0);
  return out;
}

test("a routed leg is a 45° diagonal plus an orthogonal run, in either posture", () => {
  const diag = P.routeLeg([100, 49.1], [110, 52], true);
  assert.equal(diag.length, 2);
  assert.deepEqual(diag[0], [[100, 49.1], [102.9, 52]]);       // |dx| == |dy| on the diagonal
  assert.deepEqual(diag[1], [[102.9, 52], [110, 52]]);         // then horizontal
  const orth = P.routeLeg([100, 49.1], [110, 52], false);
  assert.deepEqual(orth[0], [[100, 49.1], [107.1, 49.1]]);     // horizontal first
  assert.deepEqual(orth[1], [[107.1, 49.1], [110, 52]]);
  assert.equal(P.routeLeg([0, 0], [5, 0], true).length, 1);    // pure orthogonal
  assert.equal(P.routeLeg([0, 0], [3, 3], false).length, 1);   // pure diagonal
  assert.equal(P.routeLeg([1, 1], [1, 1], true).length, 0);
});

test("routed segments become well-formed, wrapped segment fragments that re-parse", () => {
  const doc = fixture();
  const net = { code: -1, name: "GND" };
  const changes = P.routeLeg([100, 49.1], [110, 52], true).map(([a, b]) => P.addedChange(doc, P.segmentNode(doc, a, b, 0.25, "F.Cu", net), net));
  assert.equal(changes.length, 2);
  for (const c of changes) {
    assert.equal(c.kind, "ADDED"); assert.equal(c.typeName, "PCB_TRACK"); assert.equal(c.netName, "GND");
    const tree = K.parse(c.sexpr);
    assert.equal(tree[0], "kicad_pcb"); assert.equal(K.kid(tree, "version")[1], P.BOARD_VERSION);
    const seg = K.kid(tree, "segment"); assert.ok(seg, "segment inside the kicad_pcb wrapper");
    assert.equal(K.kid(seg, "layer")[1], "F.Cu"); assert.equal(K.kid(seg, "width")[1], 0.25);
    assert.deepEqual(K.kid(seg, "net"), ["net", "GND"]);       // the document's name-based net style
    assert.equal(K.uuidOf(seg), c.id); assert.ok(K.kid(seg, "start") && K.kid(seg, "end"));
    // the same fragment applies to another copy of the document through the canvas's own applier
    const other = fixture(); assert.ok(K.applyChange(other, c, IU));
    const it = other.items.get(c.id); assert.equal(it.kind, "segment"); assert.equal(it.geom[0].t, "line");
  }
  assert.deepEqual([K.kid(K.kid(K.parse(changes[0].sexpr), "segment"), "end").slice(1), K.kid(K.kid(K.parse(changes[1].sexpr), "segment"), "start").slice(1)], [[102.9, 52], [102.9, 52]]);
});

test("via node shape follows the KiCad file format in both net styles", () => {
  const doc = fixture();
  assert.deepEqual(P.viaNode(doc, 105, 55, 0.8, 0.4, { code: 0, name: "" }), ["via", ["at", 105, 55], ["size", 0.8], ["drill", 0.4], ["layers", "F.Cu", "B.Cu"], ["net", ""]]);
  const legacy = K.parseDoc(CODE_STYLE, "kicad_pcb");
  assert.equal(P.netStyle(legacy), "code");
  assert.deepEqual(P.viaNode(legacy, 1, 2, 0.8, 0.4, { code: 0, name: "" }), ["via", ["at", 1, 2], ["size", 0.8], ["drill", 0.4], ["layers", "F.Cu", "B.Cu"], ["net", 0]]);
  assert.deepEqual(K.kid(P.segmentNode(legacy, [0, 0], [1, 1], 0.25, "F.Cu", { code: 2, name: "GND" }), "net"), ["net", 2]);
  const c = P.addedChange(doc, P.viaNode(doc, 105, 55, 0.8, 0.4, { code: -1, name: "GND" }), { code: -1, name: "GND" });
  assert.equal(c.typeName, "PCB_VIA"); assert.equal(c.netName, "GND");
  const it = doc.items.get(c.id); assert.equal(it.kind, "via"); assert.equal(it.geom[0].t, "circle"); assert.equal(it.geom[0].r, 0.4);
});

test("graphic and text nodes re-parse into geometry on their layers", () => {
  const doc = fixture();
  const line = doc.items.get(P.addedChange(doc, P.lineNode([90, 40], [90, 80], "Edge.Cuts")).id);
  assert.equal(line.kind, "gr_line"); assert.equal(line.edge, true); assert.equal(line.geom[0].w, 0.05);
  const rect = doc.items.get(P.addedChange(doc, P.rectNode([1, 1], [4, 3], "F.SilkS")).id);
  assert.equal(rect.geom[0].t, "poly"); assert.equal(rect.geom[0].fill, null); assert.equal(rect.geom[0].layer, "F.SilkS");
  const circ = doc.items.get(P.addedChange(doc, P.circleNode([10, 10], [13, 10], "F.SilkS")).id);
  assert.equal(circ.geom[0].t, "circle"); assert.equal(circ.geom[0].r, 3);
  const text = doc.items.get(P.addedChange(doc, P.textNode("hello", 5, 5, "B.SilkS")).id);
  assert.equal(text.kind, "gr_text"); assert.equal(text.geom[0].text, "hello"); assert.equal(text.geom[0].mirror, true);
  assert.equal(P.addedChange(doc, P.lineNode([0, 0], [1, 1], "F.SilkS")).typeName, "PCB_SHAPE");
});

test("rotating a footprint keeps every pad's angle relative to the footprint and turns the pads about its origin", () => {
  const doc = fixture(); const fp = doc.items.get("fp-1");
  const before = absPads(fp.node); const [fx, fy, a0] = K.atOf(fp.node);
  const node = P.rotateFootprintNode(JSON.parse(JSON.stringify(fp.node)), 90);
  const a1 = K.atOf(node)[2]; assert.equal(a1, 0);
  const pads0 = K.kids(fp.node, "pad"), pads1 = K.kids(node, "pad");
  pads0.forEach((p, i) => assert.equal(angleDiff(K.atOf(pads1[i])[2], a1), angleDiff(K.atOf(p)[2], a0), "pad " + p[1]));
  K.kids(fp.node, "property").forEach((p, i) => { if (K.kid(p, "at")) assert.equal(angleDiff(K.atOf(K.kids(node, "property")[i])[2], a1), angleDiff(K.atOf(p)[2], a0)); });
  absPads(node).forEach(([x, y], i) => { const [ex, ey] = rot90(fx, fy, before[i][0], before[i][1]); assert.ok(near(x, ex) && near(y, ey), `pad ${i} at ${x},${y} expected ${ex},${ey}`); });
  assert.ok(roundTrips(node));   // survives the file round trip unchanged
  const change = P.replacedChange(fp, node);
  assert.equal(change.kind, "MODIFIED"); assert.equal(change.typeName, "FOOTPRINT"); assert.deepEqual(change.padNets, { 1: "GND", 2: "/SIG" });
  assert.ok(K.applyChange(doc, change, IU)); assert.equal(doc.items.get("fp-1").rot, 0);
});

test("flipping a footprint swaps F./B. layers, mirrors local pad X and negates angles", () => {
  const doc = fixture(); const fp = doc.items.get("fp-1");
  const before = absPads(fp.node); const [fx] = K.atOf(fp.node);
  const node = P.flipFootprintNode(JSON.parse(JSON.stringify(fp.node)));
  assert.equal(K.kid(node, "layer")[1], "B.Cu"); assert.equal(K.atOf(node)[2], 90);
  const pad1 = K.kids(node, "pad")[0];
  assert.deepEqual(K.kid(pad1, "layers").slice(1), ["B.Cu", "B.Mask", "B.Paste"]);
  assert.equal(K.atOf(pad1)[0], 0.9); assert.equal(K.atOf(pad1)[2], 90);
  absPads(node).forEach(([x, y], i) => assert.ok(near(x, 2 * fx - before[i][0]) && near(y, before[i][1]), `pad ${i} mirrored about the origin`));
  const ref = K.kids(node, "property")[0];
  assert.equal(K.kid(ref, "layer")[1], "B.SilkS"); assert.ok(K.kid(K.kid(ref, "effects"), "justify").includes("mirror")); assert.equal(K.atOf(ref)[2], 90);
  assert.equal(K.kid(K.kids(node, "property")[1], "layer")[1], "B.Fab");
  const l = K.kid(node, "fp_line"); assert.equal(K.kid(l, "layer")[1], "B.SilkS"); assert.equal(K.kid(l, "start")[1], 1); assert.equal(K.kid(l, "end")[1], -1);
  assert.ok(roundTrips(node));
  // flipping back restores the original file content
  assert.deepEqual(P.flipFootprintNode(JSON.parse(JSON.stringify(node))), fp.node);
  assert.ok(K.applyChange(doc, P.replacedChange(fp, node), IU)); assert.equal(doc.items.get("fp-1").layer, "B.Cu");
});

test("connected-run selection follows shared endpoints through vias, hit testing picks tracks and vias", () => {
  const doc = fixture();
  assert.deepEqual([...P.connectedRun(doc, ["s-1"])].sort(), ["s-1", "s-2", "s-3", "v-1"]);
  assert.deepEqual([...P.connectedRun(doc, ["s-4"])], ["s-4"]);
  assert.equal(P.connectedRun(doc, ["g-1"]).size, 0);
  assert.equal(P.hitTestItem(doc, 112, 50.05, 0.2).id, "s-1");
  assert.equal(P.hitTestItem(doc, 112, 50.5, 0.2), null);           // 0.125 + 0.2 mm is the reach
  assert.equal(P.hitTestItem(doc, 118, 53, 0.2).id, "v-1");          // the via wins over the tracks meeting under it
  assert.equal(P.hitTestItem(doc, 120, 40.02, 0.2).id, "g-1");
  assert.equal(P.hitTestItem(doc, 141, 51.05, 0.2).id, "a-1");
  assert.equal(P.removedChange(doc.items.get("a-1")).typeName, "PCB_ARC");
});

test("magnetic snapping finds pads on the active layer and their nets", () => {
  const doc = fixture();
  const s = P.snapTarget(doc, 100.3, 49.2, 0.5, "F.Cu", null);
  assert.ok(s && s.kind === "pad"); assert.ok(near(s.x, 100) && near(s.y, 49.1)); assert.equal(s.net.name, "GND");
  assert.equal(P.snapTarget(doc, 100.3, 49.2, 0.5, "B.Cu", null), null);                       // SMD pad is front-only
  assert.equal(P.snapTarget(doc, 100.3, 49.2, 0.5, "F.Cu", { code: -1, name: "/SIG" }), null);   // never onto another net
  assert.equal(P.snapTarget(doc, 115.1, 50.1, 0.5, "F.Cu", null).kind, "track");
  assert.equal(P.netUnder(doc, 112, 50, "F.Cu").name, "GND");
  assert.equal(P.netUnder(doc, 100, 50.9, "F.Cu").name, "/SIG");
});

test("dragging a segment moves it along its normal and carries the attached ends", () => {
  const doc = fixture(); const plan = P.dragPlan(doc, doc.items.get("s-1"));
  assert.deepEqual(plan.n, [0, 1]); assert.deepEqual(plan.nb.map((n) => n.item.id + ":" + n.key), ["s-2:start"]);
  const nodes = P.dragNodes(plan, 2);
  assert.deepEqual(K.kid(nodes[0].node, "start").slice(1), [110, 52]); assert.deepEqual(K.kid(nodes[0].node, "end").slice(1), [115, 52]);
  assert.deepEqual(K.kid(nodes[1].node, "start").slice(1), [115, 52]); assert.deepEqual(K.kid(nodes[1].node, "end").slice(1), [118, 53]);
  const viaPlan = P.dragPlan(doc, doc.items.get("s-3"));   // a via at the joint drags the front-side track too
  assert.deepEqual(viaPlan.nb.map((n) => n.item.id).sort(), ["s-2", "v-1"]);
  assert.deepEqual([P.nextWidth(0.25), P.nextWidth(1.0), P.nextWidth(0.15)], [0.3, 0.2, 0.2]);
});

// ---- the module driven through fake hooks (no DOM: stage/document are absent under node)
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    // like app.js: apply, then tell the module the document changed (it must not treat that as a reload)
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});

test("module: route from a pad, add a via with V, finish with Enter", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  assert.ok(pcb.tools.some((t) => t.id === "route" && t.key === "X"));
  pcb.onDocChanged(ctx);
  assert.equal(pcb.onKey("x", ev(), ctx), true); assert.equal(log.tool, "route");
  assert.equal(pcb.onPointerDown(ev(), [100.2, 49.3], ctx), true);   // snaps onto pad 1 (GND)
  assert.deepEqual(P.state.route.last, [100, 49.1]); assert.equal(P.state.route.net.name, "GND");
  pcb.onPointerMove(ev(), [110.1, 52.1], ctx);
  assert.equal(pcb.onKey("/", ev(), ctx), true); assert.equal(P.state.route.diagFirst, false);
  pcb.onPointerDown(ev(), [110.1, 52.1], ctx);                          // fixes the leg (grid-snapped to 110, 52)
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].changes.length, 2);
  for (const c of log.commits[0].changes) { assert.equal(c.typeName, "PCB_TRACK"); assert.equal(c.netName, "GND"); assert.equal(doc.items.get(c.id).kind, "segment"); }
  assert.equal(K.kid(doc.items.get(log.commits[0].changes[0].id).node, "layer")[1], "F.Cu");
  pcb.onPointerMove(ev(), [120, 52], ctx);
  assert.equal(pcb.onKey("v", ev(), ctx), true);                        // leg + via, then B.Cu
  const viaCommit = log.commits[1]; assert.equal(viaCommit.changes.length, 2);
  assert.equal(viaCommit.changes[1].typeName, "PCB_VIA"); assert.equal(doc.items.get(viaCommit.changes[1].id).kind, "via");
  assert.equal(P.state.route.layer, "B.Cu"); assert.equal(P.state.layer, "B.Cu");
  pcb.onPointerMove(ev(), [120, 60], ctx);
  assert.equal(pcb.onKey("Enter", ev(), ctx), true);
  assert.equal(P.state.route, null);
  assert.equal(K.kid(doc.items.get(log.commits[2].changes[0].id).node, "layer")[1], "B.Cu");
  assert.equal(pcb.onKey("PageUp", ev(), ctx), true); assert.equal(P.state.layer, "F.Cu");
  assert.ok(log.toasts.some((m) => /Active layer: F\.Cu/.test(m)));
  // a change applied mid-route (own commit or a peer's) keeps the route; a new document object resets it
  pcb.onPointerDown(ev(), [130, 60], ctx); assert.ok(P.state.route);
  P.state.sel = new Set(["s-4"]); pcb.onDocChanged(ctx); assert.ok(P.state.route); assert.equal(P.state.sel.size, 1);
  pcb.onDocChanged(Object.assign({}, ctx, { doc: fixture() })); assert.equal(P.state.route, null); assert.equal(P.state.sel.size, 0);
});

test("module: selection keys — U expands the run, W changes width, Delete removes, R rotates the app's footprint", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onDocChanged(ctx);
  P.state.sel = new Set(["s-1"]);
  assert.equal(pcb.onKey("u", ev(), ctx), true); assert.equal(P.state.sel.size, 4);
  P.state.sel = new Set(["s-1"]);
  assert.equal(pcb.onKey("w", ev(), ctx), true);
  assert.equal(K.kid(doc.items.get("s-1").node, "width")[1], 0.3); assert.equal(log.commits.at(-1).changes[0].typeName, "PCB_TRACK");
  assert.equal(pcb.onKey("Delete", ev(), ctx), true);
  assert.equal(doc.items.has("s-1"), false); assert.equal(log.commits.at(-1).changes[0].kind, "REMOVED");
  assert.equal(pcb.onKey("Delete", ev(), ctx), false);                  // nothing of ours selected: app.js's turn
  ctx.selected = { id: "fp-1" };
  assert.equal(pcb.onKey("r", ev(), ctx), true); assert.equal(doc.items.get("fp-1").rot, 0);
  assert.equal(pcb.onKey("Flip", ev(), ctx), true); assert.equal(doc.items.get("fp-1").layer, "B.Cu");
  assert.equal(pcb.onKey("R", ev({ shiftKey: true }), ctx), true); assert.equal(log.tool, "grect");
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 15], ctx);
  assert.equal(log.commits.at(-1).label, "rectangle"); assert.equal(doc.items.get(log.commits.at(-1).changes[0].id).kind, "gr_rect");
});

test("module: D drags the selected segment, click commits the moved run", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onDocChanged(ctx);
  P.state.sel = new Set(["s-1"]);
  assert.equal(pcb.onKey("d", ev(), ctx), true); assert.equal(log.tool, "drag"); assert.ok(P.state.drag);
  pcb.onPointerMove(ev(), [112, 50], ctx); pcb.onPointerMove(ev(), [112, 52], ctx);
  assert.equal(P.state.drag.off, 2);
  pcb.onPointerDown(ev(), [112, 52], ctx);
  assert.equal(log.tool, "select"); assert.equal(log.commits.at(-1).label, "drag track"); assert.equal(log.commits.at(-1).changes.length, 2);
  assert.deepEqual(K.kid(doc.items.get("s-1").node, "start").slice(1), [110, 52]);
  assert.deepEqual(K.kid(doc.items.get("s-2").node, "start").slice(1), [115, 52]);
});

test("module: graphic arc (Ctrl+Shift+A) takes the start, the end, then a point on the arc", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.ok(pcb.tools.some((t) => t.id === "garc" && t.key === "Ctrl+Shift+A"));
  assert.equal(pcb.onKey("Arc", ev(), ctx), true); assert.equal(log.tool, "garc");
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 10], ctx);
  assert.deepEqual(P.state.draw.pts, [[10, 10], [20, 10]]);
  pcb.onPointerDown(ev(), [15, 10], ctx);                                  // on the chord: refused
  assert.ok(P.state.draw && P.state.draw.pts.length === 2); assert.ok(log.toasts.at(-1).includes("off the line"));
  pcb.onPointerMove(ev(), [15, 15], ctx); assert.deepEqual(P.state.draw.cur, [15, 15]);
  pcb.onPointerDown(ev(), [15, 15], ctx);
  const c = log.commits.at(-1); assert.equal(c.label, "arc"); assert.equal(c.changes[0].kind, "ADDED"); assert.equal(c.changes[0].typeName, "PCB_SHAPE");
  const node = K.kid(K.parse(c.changes[0].sexpr), "gr_arc");
  assert.deepEqual(node.slice(0, 6), ["gr_arc", ["start", 10, 10], ["mid", 15, 15], ["end", 20, 10], ["stroke", ["width", 0.1], ["type", "default"]], ["layer", "F.SilkS"]]);
  assert.equal(node[6][0], "uuid"); assert.equal(node.length, 7);
  const it = doc.items.get(c.changes[0].id); assert.equal(it.kind, "gr_arc"); assert.equal(it.geom[0].t, "arc"); assert.ok(near(it.geom[0].r, 5) && near(it.geom[0].x, 15) && near(it.geom[0].y, 10));
  assert.equal(P.state.draw, null); assert.equal(log.tool, "garc");
  assert.deepEqual(K.kid(P.arcNode([0, 0], [1, 1], [2, 0], "Edge.Cuts"), "stroke"), ["stroke", ["width", 0.05], ["type", "default"]], "outline layer takes the edge width");
});

test("module: graphic polygon (Ctrl+Shift+P) closes on the first corner or Enter; fewer than three corners is refused", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.equal(pcb.onKey("Polygon", ev(), ctx), true); assert.equal(log.tool, "gpoly");
  for (const p of [[10, 10], [20, 10], [20, 20], [10, 20]]) pcb.onPointerDown(ev(), p, ctx);
  assert.equal(pcb.onKey("Backspace", ev(), ctx), true); assert.equal(P.state.draw.pts.length, 3, "Backspace drops the last corner");
  pcb.onPointerDown(ev(), [10, 20], ctx);
  pcb.onPointerDown(ev(), [10, 10], ctx);                                   // back on the first corner: closed
  let c = log.commits.at(-1); assert.equal(c.label, "polygon"); assert.equal(c.changes[0].typeName, "PCB_SHAPE");
  const node = K.kid(K.parse(c.changes[0].sexpr), "gr_poly");
  assert.deepEqual(node.slice(0, 5), ["gr_poly", ["pts", ["xy", 10, 10], ["xy", 20, 10], ["xy", 20, 20], ["xy", 10, 20]], ["stroke", ["width", 0.1], ["type", "default"]], ["fill", "no"], ["layer", "F.SilkS"]]);
  assert.equal(node[5][0], "uuid"); assert.equal(node.length, 6);
  const it = doc.items.get(c.changes[0].id); assert.equal(it.kind, "gr_poly"); assert.equal(it.geom[0].t, "poly"); assert.equal(it.geom[0].close, true); assert.equal(it.geom[0].fill, null);
  assert.equal(P.state.draw, null);
  pcb.onPointerDown(ev(), [30, 30], ctx); pcb.onPointerDown(ev(), [40, 30], ctx); pcb.onPointerDown(ev(), [40, 40], ctx);
  assert.equal(pcb.onKey("Enter", ev(), ctx), true);
  c = log.commits.at(-1); assert.equal(K.ptsOf(K.kid(K.parse(c.changes[0].sexpr), "gr_poly")).length, 3, "Enter closes too");
  const n = log.commits.length;
  pcb.onPointerDown(ev(), [50, 50], ctx); pcb.onPointerDown(ev(), [60, 50], ctx); assert.equal(pcb.onKey("Enter", ev(), ctx), true);
  assert.equal(log.commits.length, n); assert.ok(log.toasts.at(-1).includes("three corners")); assert.equal(P.state.draw, null);
});

test("module: the delete tool removes tracks, graphics and footprints under the click and stays armed", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.ok(pcb.tools.find((t) => t.id === "delete").cursor.startsWith("url("), "KiCad's delete cursor");
  ctx.setTool("delete"); assert.equal(P.state.modTool, "delete");
  pcb.onPointerMove(ev(), [112, 50.05], ctx); assert.equal(P.state.hover.del.id, "s-1", "hover shows what the click removes");
  assert.equal(pcb.onPointerDown(ev(), [112, 50.05], ctx), true);
  let c = log.commits.at(-1); assert.equal(c.label, "delete"); assert.deepEqual(c.changes.map((x) => [x.kind, x.id, x.typeName]), [["REMOVED", "s-1", "PCB_TRACK"]]);
  assert.equal(doc.items.has("s-1"), false);
  pcb.onPointerDown(ev(), [120, 40.02], ctx); assert.equal(log.commits.at(-1).changes[0].id, "g-1");
  ctx.selected = { id: "fp-1" }; let cleared = false; ctx.setSelected = (sel) => { cleared = sel === null; };
  pcb.onPointerDown(ev(), [100, 50], ctx);                                   // the footprint body, through K.hitTest
  c = log.commits.at(-1); assert.deepEqual(c.changes.map((x) => [x.kind, x.id, x.typeName]), [["REMOVED", "fp-1", "FOOTPRINT"]]); assert.ok(cleared, "app.js's selection is dropped with the item");
  assert.equal(doc.items.has("fp-1"), false);
  const n = log.commits.length; assert.equal(pcb.onPointerDown(ev(), [200, 200], ctx), true, "an empty click is still the tool's"); assert.equal(log.commits.length, n);
  assert.equal(log.tool, "delete");
});

// ---- render options (kicad-canvas.js), driven with a recording 2D-context stub like render.test.js
function stubCtx(w, h) {
  const calls = {}, alphas = new Set(); const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
  const c = { canvas: { width: w, height: h }, calls, alphas, font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", lineJoin: "" };
  let alpha = 1; Object.defineProperty(c, "globalAlpha", { configurable: true, get: () => alpha, set: (v) => { alpha = v; alphas.add(+v.toFixed(3)); } });
  for (const n of ["setTransform", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash"]) c[n] = () => rec(n);
  c.measureText = (t) => ({ width: t.length * 0.7 });
  return c;
}
const ZONED = FIXTURE.replace(/\)\s*$/, "") + ' (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z-1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))'
  + ' (polygon (pts (xy 90 60) (xy 120 60) (xy 120 80) (xy 90 80))) (filled_polygon (layer "F.Cu") (pts (xy 91 61) (xy 119 61) (xy 119 79) (xy 91 79)))))';
const VIEW = { ppm: 8, zoom: 1, panX: 0, panY: 0, x0: 85, y0: 35, dpr: 1 };
const renderWith = (doc, opts) => { const c = stubCtx(800, 600); K.render(doc, c, VIEW, opts); return c; };

test("render options: geometry carries the tags the sketch modes need", () => {
  const doc = K.parseDoc(ZONED, "kicad_pcb");
  assert.ok(doc.items.get("z-1").geom.some((g) => g.zoneFill && g.fill), "zone fill tagged");
  assert.ok(doc.items.get("z-1").geom.some((g) => !g.zoneFill && g.t === "poly" && !g.fill), "…its outline is not");
  assert.ok(doc.items.get("v-1").geom.every((g) => g.via) && doc.items.get("v-1").geom.length === 3);
  assert.ok(doc.items.get("s-1").geom[0].track && doc.items.get("a-1").geom[0].track && doc.items.get("a-1").geom[0].t === "arc");
  const pads = doc.items.get("fp-1").geom.filter((g) => g.pad); assert.equal(pads.length, 6, "two pads on F.Cu/F.Mask/F.Paste");
  assert.ok(!doc.items.get("fp-1").geom.some((g) => g.t === "line" && g.pad), "footprint drawings are not pads");
  assert.ok(!doc.items.get("g-1").geom[0].track && !doc.items.get("g-1").geom[0].pad);
});

test("render options: zoneOutline drops the copper fill, the outline hatch stays", () => {
  const doc = K.parseDoc(ZONED, "kicad_pcb");
  const plain = renderWith(doc, {}), outline = renderWith(doc, { zoneOutline: true });
  assert.equal(plain.calls.fill - outline.calls.fill, 1, "exactly the filled polygon is skipped");
  assert.equal(plain.calls.stroke, outline.calls.stroke, "outline and hatch ticks still stroked");
});

test("render options: outlinePads / outlineTracks / outlineVias stroke instead of fill", () => {
  const doc = K.parseDoc(ZONED, "kicad_pcb");
  const plain = renderWith(doc, {});
  const pads = renderWith(doc, { outlinePads: true });
  assert.equal(plain.calls.fill - pads.calls.fill, 6, "six pad shapes no longer filled"); assert.equal(pads.calls.stroke - plain.calls.stroke, 6, "…but stroked");
  const vias = renderWith(doc, { outlineVias: true });
  assert.equal(plain.calls.fill - vias.calls.fill, 3, "two copper rings and the hole become outlines"); assert.equal(vias.calls.stroke - plain.calls.stroke, 3);
  const tracks = renderWith(doc, { outlineTracks: true });
  assert.equal(tracks.calls.stroke, plain.calls.stroke, "every track still one stroke");
  assert.ok(tracks.calls.arc - plain.calls.arc >= 2 * 4 + 3, "stadium end caps and arc band caps are traced");
  assert.equal(tracks.calls.fill, plain.calls.fill, "tracks were never filled");
  const all = renderWith(doc, { outlinePads: true, outlineTracks: true, outlineVias: true });
  assert.equal(plain.calls.fill - all.calls.fill, 9);
  const sch = K.parseDoc('(kicad_sch (version 20250114) (generator "t") (paper "A4") (junction (at 2 2) (diameter 0) (color 0 0 0 0) (uuid "j")))');
  const sview = { ppm: 2, zoom: 1, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 };
  const a = stubCtx(600, 400); K.render(sch, a, sview, {}); const b = stubCtx(600, 400); K.render(sch, b, sview, { outlinePads: true, outlineVias: true, outlineTracks: true, zoneOutline: true, highContrast: true, activeLayer: "F.Cu" });
  assert.deepEqual(b.calls, a.calls, "board options are ignored on a schematic");
});

test("render options: highContrast dims everything off the active layer, holes stay", () => {
  const doc = K.parseDoc(ZONED, "kicad_pcb");
  const plain = renderWith(doc, {});
  assert.ok(!plain.alphas.has(0.2), "nothing dimmed by default");
  const hc = renderWith(doc, { highContrast: true, activeLayer: "B.Cu" });
  assert.ok(hc.alphas.has(0.2) && hc.alphas.has(1), "inactive layers at 0.2 alpha, B.Cu at full");
  assert.equal(hc.calls.fill, plain.calls.fill, "dimming does not drop anything");
  const only = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (via (at 100 50) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 0) (uuid "v")))', "kicad_pcb");
  const alphas = []; const c = stubCtx(800, 600); Object.defineProperty(c, "globalAlpha", { set: (v) => alphas.push(+v.toFixed(3)), get: () => 1 });
  K.render(only, c, VIEW, { highContrast: true, activeLayer: "F.Cu" });
  assert.deepEqual(alphas.filter((v) => v !== 1).length, 1, "only the B.Cu ring is dimmed: the F.Cu ring and the hole are drawn at full alpha");
  const off = renderWith(doc, { highContrast: true });
  assert.ok(!off.alphas.has(0.2), "no active layer: nothing to contrast against");
});

test("sample board: rotate/flip invariants hold for every footprint, tracks snap and chain", { skip: !fs.existsSync(SAMPLE) && "sample board not present" }, () => {
  const doc = K.parseDoc(fs.readFileSync(SAMPLE, "utf8"), "kicad_pcb");
  assert.equal(P.netStyle(doc), "name");
  let fps = 0;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue; fps++;
    const [fx, fy, a0] = K.atOf(it.node); const before = absPads(it.node);
    const rot = P.rotateFootprintNode(JSON.parse(JSON.stringify(it.node)), 90); const a1 = K.atOf(rot)[2];
    K.kids(it.node, "pad").forEach((p, i) => assert.equal(angleDiff(K.atOf(K.kids(rot, "pad")[i])[2], a1), angleDiff(K.atOf(p)[2], a0), `${it.ref} pad ${p[1]} angle`));
    absPads(rot).forEach(([x, y], i) => { const [ex, ey] = rot90(fx, fy, before[i][0], before[i][1]); assert.ok(near(x, ex, 1e-5) && near(y, ey, 1e-5), `${it.ref} rotated pad ${i}`); });
    const flip = P.flipFootprintNode(JSON.parse(JSON.stringify(it.node)));
    assert.equal(K.kid(flip, "layer")[1], P.flipLayerName(it.layer));
    absPads(flip).forEach(([x, y], i) => assert.ok(near(x, 2 * fx - before[i][0], 1e-5) && near(y, before[i][1], 1e-5), `${it.ref} flipped pad ${i}`));
    assert.deepEqual(canon(P.flipFootprintNode(JSON.parse(JSON.stringify(flip)))), canon(it.node), `${it.ref} flip is an involution`);
    let four = rot; for (let i = 0; i < 3; i++) four = P.rotateFootprintNode(four, 90);
    assert.deepEqual(canon(four), canon(it.node), `${it.ref} four turns return`);
    assert.ok(roundTrips(rot) && roundTrips(flip));
  }
  assert.ok(fps > 10);
  const seg = [...doc.items.values()].find((it) => it.kind === "segment");
  const s = K.kid(seg.node, "start"), e = K.kid(seg.node, "end");
  assert.equal(P.hitTestItem(doc, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2, 0.05).id, seg.id);
  assert.ok(P.connectedRun(doc, [seg.id]).has(seg.id));
  const snap = P.snapTarget(doc, s[1] + 0.1, s[2] + 0.1, 0.5, K.kid(seg.node, "layer")[1], null);
  assert.ok(snap && near(snap.x, s[1]) && near(snap.y, s[2]));
  const fp = [...doc.items.values()].find((it) => it.kind === "footprint" && P.padsOf(it).some((p) => p.net.name));
  const pad = P.padsOf(fp).find((p) => p.net.name);
  const cu = pad.layers.find((l) => /\.Cu$/.test(l)); const layer = cu === "*.Cu" || cu === "F&B.Cu" ? "F.Cu" : cu;
  const ps = P.snapTarget(doc, pad.x + 0.2, pad.y - 0.2, 0.5, layer, null);   // nearest same-net target: the pad, or a track end on it
  assert.ok(ps && ps.net.name === pad.net.name);
  const pc = P.snapTarget(doc, pad.x, pad.y, 0.5, layer, null);
  assert.ok(pc && pc.kind === "pad" && near(pc.x, pad.x) && near(pc.y, pad.y));
});

// ---- the new board tools: node shapes against pcb_io_kicad_sexpr.cpp, previews, commits, undo safety
/** An ADDED change re-applies to a fresh copy of the board, the item there re-serialises unchanged, and its inverse removes it. */
function checkFragment(c, kind) {
  assert.equal(c.kind, "ADDED");
  const other = fixture(); assert.ok(K.applyChange(other, c, IU), "re-applies elsewhere");
  const it = other.items.get(c.id); assert.equal(it.kind, kind); assert.ok(roundTrips(it.node), "file round trip");
  assert.ok(K.applyChange(other, { id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] }, IU)); assert.equal(other.items.has(c.id), false, "the undo inverse removes it");
  return K.kid(K.parse(c.sexpr), kind);
}
const lastNode = (log, kind) => checkFragment(log.commits.at(-1).changes[0], kind);
// the serializer writes a numeric-looking dimension value ("10") bare and the parser hands it back as a number; KiCad's
// NeedSYMBOLorNUMBER reads it as the text either way, so the value is compared as text
const withText = (node) => { const gt = K.kid(node, "gr_text"); if (gt) gt[1] = String(gt[1]); return node; };

test("new items take BOARD_DESIGN_SETTINGS' layer-class defaults: line widths, text sizes and thicknesses", () => {
  assert.deepEqual(["F.SilkS", "F.Cu", "In1.Cu", "Edge.Cuts", "F.CrtYd", "B.Fab", "Dwgs.User"].map(P.gfxWidth), [0.1, 0.2, 0.2, 0.05, 0.05, 0.1, 0.1]);
  assert.deepEqual(P.textStyle("F.Cu"), { size: 1.5, thick: 0.3 }); assert.deepEqual(P.textStyle("B.SilkS"), { size: 1, thick: 0.1 }); assert.deepEqual(P.textStyle("Dwgs.User"), { size: 1, thick: 0.15 });
  assert.deepEqual(P.effectsNode("B.SilkS", ["left", "top"]), ["effects", ["font", ["size", 1, 1], ["thickness", 0.1]], ["justify", "left", "top", "mirror"]]);
  assert.deepEqual(P.effectsNode("Dwgs.User"), ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]]);
  assert.deepEqual(K.kid(P.curveNode([[0, 0], [1, 1], [2, 1], [3, 0]], "F.Cu"), "stroke"), ["stroke", ["width", 0.2], ["type", "default"]], "copper graphics take the copper line width");
});

test("module: Bezier (Ctrl+Shift+B) takes the start, two control points and the end; the node is a gr_curve", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.equal(pcb.onKey("Bezier", ev(), ctx), true); assert.equal(log.tool, "gcurve");
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [12, 4], ctx); pcb.onPointerDown(ev(), [18, 4], ctx);
  assert.equal(pcb.onKey("Backspace", ev(), ctx), true); assert.equal(P.state.draw.pts.length, 2, "Backspace drops the last point");
  pcb.onPointerDown(ev(), [18, 4], ctx);
  const n = log.commits.length; pcb.onPointerDown(ev(), [18, 4], ctx); assert.equal(log.commits.length, n, "a repeated point is refused");
  pcb.onPointerMove(ev(), [20, 10], ctx); assert.deepEqual(P.state.draw.cur, [20, 10]);
  pcb.onPointerDown(ev(), [20, 10], ctx);
  const c = log.commits.at(-1); assert.equal(c.label, "curve"); assert.equal(c.changes[0].typeName, "PCB_SHAPE");
  const node = lastNode(log, "gr_curve");
  assert.deepEqual(node.slice(0, 4), ["gr_curve", ["pts", ["xy", 10, 10], ["xy", 12, 4], ["xy", 18, 4], ["xy", 20, 10]], ["stroke", ["width", 0.1], ["type", "default"]], ["layer", "F.SilkS"]]);
  assert.equal(node[4][0], "uuid"); assert.equal(node.length, 5);
  const it = doc.items.get(c.changes[0].id); assert.equal(it.kind, "gr_curve"); assert.equal(it.geom[0].t, "poly"); assert.equal(it.geom[0].close, false); assert.ok(it.geom[0].pts.length > 4, "flattened curve");
  assert.equal(P.state.draw, null); assert.equal(log.tool, "gcurve");
});

test("module: text box takes two corners and the prompt; the node follows the writer's child order", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  let title = null; pcb.setPrompt((t, initial, client, done) => { title = t; done("Hello\nworld"); });
  ctx.setTool("gtextbox"); pcb.onPointerDown(ev(), [30, 20], ctx); assert.ok(P.state.draw); pcb.onPointerDown(ev(), [10, 12], ctx);
  assert.equal(title, "Text box");
  const c = log.commits.at(-1); assert.equal(c.label, "text box"); assert.equal(c.changes[0].typeName, "PCB_TEXTBOX");
  const node = lastNode(log, "gr_text_box");
  assert.deepEqual(node.slice(0, 6), ["gr_text_box", "Hello\nworld", ["start", 10, 12], ["end", 30, 20], ["margins", 1.0025, 1.0025, 1.0025, 1.0025], ["layer", "F.SilkS"]]);
  assert.deepEqual(node[6], ["uuid", c.changes[0].id]);
  assert.deepEqual(node.slice(7), [["effects", ["font", ["size", 1, 1], ["thickness", 0.1]], ["justify", "left", "top"]], ["border", "yes"], ["stroke", ["width", 0.1], ["type", "default"]], ["knockout", "no"]]);
  const it = doc.items.get(c.changes[0].id); assert.equal(it.kind, "gr_text_box"); assert.ok(it.geom.some((g) => g.t === "poly") && it.geom.some((g) => g.t === "text"), "border and text");
  // a cancelled prompt leaves nothing behind; a back layer mirrors the text
  const n = log.commits.length; pcb.setPrompt((t, i, cl, done) => done(null));
  pcb.onPointerDown(ev(), [40, 40], ctx); pcb.onPointerDown(ev(), [50, 45], ctx); assert.equal(log.commits.length, n); assert.equal(P.state.draw, null);
  assert.deepEqual(K.kid(K.kid(P.textBoxNode("x", [0, 0], [5, 5], "B.SilkS"), "effects"), "justify"), ["justify", "left", "top", "mirror"]);
});

test("module: table takes two corners and 'rows x cols'; the node carries the writer's border, separators, widths and cells", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  let initial = null; pcb.setPrompt((t, i, client, done) => { initial = i; done(t === "Table rows x cols" ? "2 x 3" : null); });
  ctx.setTool("table"); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [40, 16], ctx);
  assert.equal(initial, "2 x 2", "KiCad's own sizing of a 30 × 6 mm drag: 15 and 3 text sizes per cell");
  const c = log.commits.at(-1); assert.equal(c.label, "table"); assert.equal(c.changes[0].typeName, "PCB_TABLE");
  const node = lastNode(log, "table");
  assert.deepEqual(node[1], ["column_count", 3]); assert.deepEqual(node[2], ["uuid", c.changes[0].id]);
  assert.deepEqual(node.slice(3, 8), [["layer", "F.SilkS"], ["border", ["external", "yes"], ["header", "yes"], ["stroke", ["width", 0.1], ["type", "default"]]],
    ["separators", ["rows", "yes"], ["cols", "yes"], ["stroke", ["width", 0.1], ["type", "default"]]], ["column_widths", 10, 10, 10], ["row_heights", 3, 3]]);
  const cells = node[8]; assert.equal(cells[0], "cells"); assert.equal(cells.length, 7); assert.equal(node.length, 9);
  const uuids = new Set();
  cells.slice(1).forEach((cell, i) => {
    const r = Math.floor(i / 3), col = i % 3;
    assert.deepEqual(cell.slice(0, 6), ["table_cell", "", ["start", 10 + col * 10, 10 + r * 3], ["end", 20 + col * 10, 13 + r * 3], ["margins", 1.0025, 1.0025, 1.0025, 1.0025], ["span", 1, 1]]);
    assert.deepEqual(cell[6], ["layer", "F.SilkS"]); assert.equal(cell[7][0], "uuid"); uuids.add(cell[7][1]);
    assert.deepEqual(cell.slice(8), [["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left"]], ["knockout", "no"]]);
  });
  assert.equal(uuids.size, 6, "every cell has its own uuid");
  assert.equal(doc.items.get(c.changes[0].id).kind, "table");
  // nonsense sizes are refused and the box dropped; the grid rounds the cell size like KiCad; back layers mirror the cells
  const n = log.commits.length; pcb.setPrompt((t, i, cl, done) => done("lots"));
  pcb.onPointerDown(ev(), [50, 50], ctx); pcb.onPointerDown(ev(), [60, 55], ctx); assert.equal(log.commits.length, n); assert.ok(log.toasts.at(-1).includes("rows x cols"));
  assert.deepEqual(P.tableLayout([0, 0], [10.3, 4.1], 1, 1, "F.SilkS", 0.5), { x: 0, y: 0, cw: 10.5, ch: 4, rows: 1, cols: 1 });
  assert.deepEqual(K.kid(K.kid(P.tableNode([0, 0], [10, 3], 1, 1, "B.SilkS", 0)[8][1], "effects"), "justify"), ["justify", "left", "mirror"]);
});

// a PNG built from its chunks: 8-bit RGB, a pHYs of 3937 px/m (100 ppi), proper CRCs
function crc32(buf) { let crc = 0xFFFFFFFF; for (const b of buf) { let c = (crc ^ b) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function makePng(w, h, ppm) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const phys = Buffer.alloc(9); phys.writeUInt32BE(ppm, 0); phys.writeUInt32BE(ppm, 4); phys[8] = 1;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngChunk("IHDR", ihdr), pngChunk("pHYs", phys), pngChunk("IDAT", zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h))), pngChunk("IEND", Buffer.alloc(0))]);
}

test("module: a reference image comes from the picker, rides the cursor and lands centred with 76-column data rows", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  const png = makePng(20, 10, 3937); const b64 = png.toString("base64");
  let opened = 0; pcb.setImagePicker((done) => { opened++; done({ base64: b64, name: "logo.png" }); });
  ctx.setTool("image");
  assert.equal(opened, 1, "the file dialog opens with the tool");
  const img = P.state.image; assert.ok(img); assert.deepEqual([img.info.type, img.info.w, img.info.h, img.info.ppi], ["png", 20, 10, 100]);
  assert.ok(near(img.w, 5.08) && near(img.h, 2.54), "1000 mils per ppi, so 100 ppi is 0.254 mm a pixel");
  pcb.onPointerMove(ev(), [50, 50], ctx);
  assert.equal(pcb.onPointerDown(ev(), [50, 50], ctx), true);
  const c = log.commits.at(-1); assert.equal(c.label, "image"); assert.equal(c.changes[0].typeName, "PCB_REFERENCE_IMAGE"); assert.equal(P.state.image, null);
  const node = lastNode(log, "image");
  assert.deepEqual(node.slice(0, 3), ["image", ["at", 50, 50], ["layer", "F.SilkS"]]);
  const data = node[3]; assert.equal(data[0], "data"); assert.equal(node[4][0], "uuid"); assert.equal(node.length, 5, "no (scale) at 1");
  const rows = data.slice(1).map(String); assert.ok(rows.length > 1 && rows.every((r) => r.length <= 76) && rows.slice(0, -1).every((r) => r.length === 76)); assert.equal(rows.join(""), b64);
  assert.equal(doc.items.get(c.changes[0].id).kind, "image");
  assert.equal(pcb.onPointerDown(ev(), [60, 60], ctx), true); assert.equal(opened, 2, "the next click asks for a file again");
  // JPEG headers: JFIF density in dpi, SOF0 size; anything else is refused
  const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0]);
  assert.deepEqual(P.imageInfo(new Uint8Array(jpg)), { type: "jpeg", w: 40, h: 30, ppi: 72 });
  assert.equal(P.imageInfo(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(P.imageInfo(P.base64Bytes(b64)).ppi, 100);
  ctx.setTool("select"); assert.equal(P.state.image, null, "leaving the tool drops the image");
  pcb.setImagePicker((done) => done({ base64: Buffer.from("GIF89a").toString("base64"), name: "x.gif" }));
  ctx.setTool("image"); assert.equal(P.state.image, null); assert.ok(log.toasts.at(-1).includes("PNG"));
});

test("module: zone (Alt+Z) closes on the first corner, asks for the net and writes ZONE_SETTINGS' defaults unfilled", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  let asked = null; pcb.setPrompt((t, initial, client, done, options) => { asked = { t, initial, options }; done("GND"); });
  assert.equal(pcb.onKey("Zone", ev(), ctx), true); assert.equal(log.tool, "zone");
  for (const p of [[112, 50], [130, 45], [130, 70], [95, 70]]) pcb.onPointerDown(ev(), p, ctx);
  pcb.onPointerDown(ev(), [112, 50], ctx);
  assert.equal(asked.t, "Zone net"); assert.equal(asked.initial, "GND", "the copper under the first corner"); assert.deepEqual(asked.options, ["/SIG", "GND"]);
  const c = log.commits.at(-1); assert.equal(c.label, "zone"); assert.equal(c.changes[0].typeName, "ZONE"); assert.equal(c.changes[0].netName, "GND");
  const node = lastNode(log, "zone");
  assert.deepEqual(node.slice(0, 3), ["zone", ["net", "GND"], ["layer", "F.Cu"]]); assert.deepEqual(node[3], ["uuid", c.changes[0].id]);
  assert.deepEqual(node.slice(4), [["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25],
    ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5], ["island_removal_mode", 0]],
    ["polygon", ["pts", ["xy", 112, 50], ["xy", 130, 45], ["xy", 130, 70], ["xy", 95, 70]]]]);
  const it = doc.items.get(c.changes[0].id); assert.equal(it.kind, "zone"); assert.ok(it.geom.some((g) => g.t === "poly" && !g.fill) && !it.geom.some((g) => g.zoneFill), "outline and hatch, no fill");
  // the next copper zone takes the next free priority; an empty net means no (net); Enter closes too; B.Cu when active
  pcb.setPrompt((t, i, cl, done) => done(""));
  assert.equal(pcb.onKey("PageDown", ev(), ctx), true);
  for (const p of [[10, 10], [20, 10], [20, 20]]) pcb.onPointerDown(ev(), p, ctx);
  assert.equal(pcb.onKey("Enter", ev(), ctx), true);
  const z2 = lastNode(log, "zone");
  assert.deepEqual(z2[1], ["layer", "B.Cu"]); assert.deepEqual(z2[4], ["priority", 1]); assert.equal(log.commits.at(-1).changes[0].netName, undefined);
  // a cancelled prompt drops the outline; fewer than three corners is refused
  const n = log.commits.length; pcb.setPrompt((t, i, cl, done) => done(null));
  for (const p of [[30, 30], [40, 30], [40, 40]]) pcb.onPointerDown(ev(), p, ctx); pcb.onPointerDown(ev(), [30, 30], ctx);
  assert.equal(log.commits.length, n); assert.equal(P.state.draw, null);
  pcb.onPointerDown(ev(), [50, 50], ctx); pcb.onPointerDown(ev(), [60, 50], ctx); assert.equal(pcb.onKey("Enter", ev(), ctx), true); assert.equal(log.commits.length, n);
  // the legacy net style writes the code
  const legacy = K.parseDoc(CODE_STYLE, "kicad_pcb");
  assert.deepEqual(P.zoneNode(legacy, [[0, 0], [1, 0], [1, 1]], "B.Cu", { code: 2, name: "GND" })[1], ["net", 2]);
  assert.equal(P.zoneNode(legacy, [[0, 0], [1, 0], [1, 1]], "B.Cu", { code: 0, name: "" })[1][0], "layer");
  P.state.layer = "F.Cu";
});

test("module: rule area (Ctrl+Shift+K) is a keepout on both outer copper layers with KiCad's default rules", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.equal(pcb.onKey("RuleArea", ev(), ctx), true); assert.equal(log.tool, "rulearea");
  for (const p of [[10, 10], [20, 10], [20, 20], [10, 20]]) pcb.onPointerDown(ev(), p, ctx);
  pcb.onPointerDown(ev(), [10, 20], ctx);   // the last corner again closes
  const c = log.commits.at(-1); assert.equal(c.label, "rule area"); assert.equal(c.changes[0].typeName, "ZONE"); assert.equal(c.changes[0].netName, undefined);
  const node = lastNode(log, "zone");
  assert.deepEqual(node[1], ["layers", "F.Cu", "B.Cu"]); assert.deepEqual(node[2], ["uuid", c.changes[0].id]);
  assert.deepEqual(node.slice(3), [["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25],
    ["keepout", ["tracks", "not_allowed"], ["vias", "not_allowed"], ["pads", "not_allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
    ["placement", ["enabled", "no"], ["sheetname", ""]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5], ["island_removal_mode", 0]],
    ["polygon", ["pts", ["xy", 10, 10], ["xy", 20, 10], ["xy", 20, 20], ["xy", 10, 20]]]]);
  const it = doc.items.get(c.changes[0].id); assert.ok(it.geom.some((g) => g.layer === "F.Cu") && it.geom.some((g) => g.layer === "B.Cu"));
  assert.equal(P.zonePriority(doc), 0, "rule areas hold no priority");
  assert.deepEqual(P.ruleAreaNode([[0, 0], [1, 0], [1, 1]], ["In1.Cu"])[1], ["layer", "In1.Cu"]);
});

test("dimension text: GetValueText in mm at four places with zeroes suppressed; aligned text angles; 45° snapping", () => {
  assert.deepEqual([10, 2.5, 3.14159, 0, 12.34567, 0.00004, 100.5].map(P.dimValueText), ["10", "2.5", "3.1416", "0", "12.3457", "0", "100.5"]);
  assert.deepEqual([[5, 0], [0, 5], [5, 5], [-5, 5], [0, -5], [-5, 0], [-5, -5]].map(P.readableAngle), [0, 90, 315, 45, 90, 0, -45]);
  assert.deepEqual([[10, 3], [3, 10], [10, 6], [-6, 10], [6, -10], [0, 0]].map(P.snap45), [[10, 0], [0, 10], [10, 10], [-10, 10], [10, -10], [0, 0]]);
  assert.deepEqual(P.DIM_CLASS, { aligned: "PCB_DIM_ALIGNED", orthogonal: "PCB_DIM_ORTHOGONAL", center: "PCB_DIM_CENTER", radial: "PCB_DIM_RADIAL", leader: "PCB_DIM_LEADER" });
  assert.equal(P.EXT_HEIGHT, 0.58642, "int(1.27 mm × sin 27.5°) in nanometres");
});

test("module: aligned dimension takes two points and the offset; the node carries the writer's format, style and KiCad's text placement", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  ctx.setTool("dimaligned");
  pcb.onPointerDown(ev(), [10, 10], ctx);
  const n0 = log.commits.length; pcb.onPointerDown(ev(), [10, 10], ctx); assert.equal(P.state.draw.pts.length, 1, "a zero-length dimension is refused");
  pcb.onPointerDown(ev(), [20, 10], ctx); assert.deepEqual(P.state.draw.end, [20, 10]);
  pcb.onPointerMove(ev(), [15, 7], ctx); assert.ok(near(P.state.draw.height, -3), "the cursor's signed distance from the line");
  pcb.onPointerDown(ev(), [15, 7], ctx);
  assert.equal(log.commits.length, n0 + 1);
  const c = log.commits.at(-1); assert.equal(c.label, "dimension"); assert.equal(c.changes[0].typeName, "PCB_DIM_ALIGNED"); const id = c.changes[0].id;
  assert.deepEqual(withText(lastNode(log, "dimension")), ["dimension", ["type", "aligned"], ["layer", "F.SilkS"], ["uuid", id], ["pts", ["xy", 10, 10], ["xy", 20, 10]], ["height", -3],
    ["format", ["prefix", ""], ["suffix", ""], ["units", 3], ["units_format", 0], ["precision", 4], ["suppress_zeroes", "yes"]],
    ["style", ["thickness", 0.1], ["arrow_length", 1.27], ["text_position_mode", 0], ["extension_height", 0.58642], ["extension_offset", 0.5], ["keep_text_aligned", "yes"]],
    ["gr_text", "10", ["at", 15, 5.9, 0], ["layer", "F.SilkS"], ["uuid", id], ["effects", ["font", ["size", 1, 1], ["thickness", 0.1]]]]]);
  const it = doc.items.get(id); assert.equal(it.kind, "dimension"); assert.ok(it.geom.filter((g) => g.t === "line").length >= 7, "extension lines, crossbar and arrow barbs");
  assert.equal(P.state.draw, null); assert.equal(log.tool, "dimaligned");
  // a slanted one on Dwgs.User: the crossbar sits on the cursor's side, the text turns with it into the readable half
  P.state.gfxLayer = "Dwgs.User";
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerMove(ev(), [10, 0], ctx); pcb.onPointerDown(ev(), [10, 0], ctx);
  const d2 = withText(lastNode(log, "dimension")); const gt = K.kid(d2, "gr_text");
  assert.ok(near(K.kid(d2, "height")[1], -7.071068, 1e-5));
  assert.equal(gt[1], "14.1421"); assert.equal(K.kid(gt, "at")[3], 315);
  assert.ok(near(K.kid(gt, "at")[1], 10.813173, 1e-5) && near(K.kid(gt, "at")[2], -0.813173, 1e-5), "1.15 mm off the crossbar's middle");
  assert.deepEqual(K.kid(gt, "effects"), ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]]);
  assert.deepEqual(K.kid(d2, "style")[1], ["thickness", 0.1]);
  const g = P.dimGeometry("aligned", { start: [0, 0], end: [10, 10], height: -7.071068 }, "Dwgs.User");
  assert.ok(near(g.lines[2][0][0], 5, 1e-5) && near(g.lines[2][0][1], -5, 1e-5), "crossbar start on the extension side");
  P.state.gfxLayer = "F.SilkS";
});

test("module: orthogonal dimension (Ctrl+Shift+H) measures X or Y by where the third click falls", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  assert.equal(pcb.onKey("Ortho", ev(), ctx), true); assert.equal(log.tool, "dimortho");
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 14], ctx);
  assert.equal(P.state.draw.orientation, "h", "the longer side to start with");
  pcb.onPointerMove(ev(), [15, 20], ctx); assert.equal(P.state.draw.orientation, "h"); assert.equal(P.state.draw.height, 10);
  pcb.onPointerMove(ev(), [25, 12], ctx); assert.equal(P.state.draw.orientation, "v", "beside the points: Y"); assert.equal(P.state.draw.height, 15);
  pcb.onPointerMove(ev(), [15, 12], ctx); assert.equal(P.state.draw.orientation, "v", "inside the points' box the axis stays"); assert.equal(P.state.draw.height, 5);
  pcb.onPointerMove(ev(), [15, 20], ctx); pcb.onPointerDown(ev(), [15, 20], ctx);
  const c = log.commits.at(-1); assert.equal(c.changes[0].typeName, "PCB_DIM_ORTHOGONAL");
  const node = withText(lastNode(log, "dimension"));
  assert.deepEqual(node.slice(4, 7), [["pts", ["xy", 10, 10], ["xy", 20, 14]], ["height", 10], ["orientation", 0]]);
  const gt = K.kid(node, "gr_text"); assert.equal(gt[1], "10"); assert.deepEqual(K.kid(gt, "at"), ["at", 15, 18.9, 0]);
  assert.deepEqual(K.kid(node, "style"), ["style", ["thickness", 0.1], ["arrow_length", 1.27], ["text_position_mode", 0], ["extension_height", 0.58642], ["extension_offset", 0.5], ["keep_text_aligned", "yes"]]);
  // vertical: the text stands up beside the crossbar
  pcb.onPointerDown(ev(), [30, 10], ctx); pcb.onPointerDown(ev(), [32, 30], ctx); pcb.onPointerMove(ev(), [40, 20], ctx); pcb.onPointerDown(ev(), [40, 20], ctx);
  const n2 = withText(lastNode(log, "dimension")); const t2 = K.kid(n2, "gr_text");
  assert.deepEqual([K.kid(n2, "height")[1], K.kid(n2, "orientation")[1], t2[1]], [10, 1, "20"]); assert.deepEqual(K.kid(t2, "at"), ["at", 38.9, 20, 90]);
});

test("module: centre, radial and leader dimensions — a 45° cross, an R-prefixed radius with turned text, leader text from the prompt", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  ctx.setTool("dimcenter"); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [13, 11], ctx);
  let c = log.commits.at(-1); assert.equal(c.changes[0].typeName, "PCB_DIM_CENTER"); let id = c.changes[0].id;
  assert.deepEqual(lastNode(log, "dimension"), ["dimension", ["type", "center"], ["layer", "F.SilkS"], ["uuid", id], ["pts", ["xy", 10, 10], ["xy", 13, 10]],
    ["style", ["thickness", 0.1], ["arrow_length", 1.27], ["text_position_mode", 0], ["extension_offset", 0.5], ["keep_text_aligned", "yes"]]]);
  assert.equal(doc.items.get(id).geom.length, 2, "two arms");
  ctx.setTool("dimradial"); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [15, 10], ctx);
  pcb.onPointerMove(ev(), [20, 8], ctx); assert.deepEqual(P.state.draw.textPos, [20, 8]);
  pcb.onPointerDown(ev(), [20, 8], ctx);
  c = log.commits.at(-1); assert.equal(c.changes[0].typeName, "PCB_DIM_RADIAL"); id = c.changes[0].id;
  assert.deepEqual(lastNode(log, "dimension"), ["dimension", ["type", "radial"], ["layer", "F.SilkS"], ["uuid", id], ["pts", ["xy", 10, 10], ["xy", 15, 10]], ["leader_length", 3.81],
    ["format", ["prefix", "R "], ["suffix", ""], ["units", 3], ["units_format", 0], ["precision", 4], ["suppress_zeroes", "yes"]],
    ["style", ["thickness", 0.1], ["arrow_length", 1.27], ["text_position_mode", 0], ["extension_offset", 0.5], ["keep_text_aligned", "yes"]],
    ["gr_text", "R 5", ["at", 20, 8, 59], ["layer", "F.SilkS"], ["uuid", id], ["effects", ["font", ["size", 1, 1], ["thickness", 0.1]]]]]);
  // without a third point the text sits ten arrow lengths past the knee, where the drawing tool first puts it
  const g = P.dimGeometry("radial", { start: [10, 10], end: [5, 10] }, "Dwgs.User"); assert.deepEqual(g.tpos, [5 - 3.81 - 12.7, 10]); assert.equal(g.tang, 0); assert.equal(g.text, "R 5");
  ctx.setTool("leader");
  let asked = null; pcb.setPrompt((t, initial, client, done) => { asked = [t, initial]; done("Fiducial"); });
  pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 15], ctx);
  assert.deepEqual(asked, ["Leader text", "Leader"]);
  c = log.commits.at(-1); assert.equal(c.changes[0].typeName, "PCB_DIM_LEADER"); id = c.changes[0].id;
  assert.deepEqual(lastNode(log, "dimension"), ["dimension", ["type", "leader"], ["layer", "F.SilkS"], ["uuid", id], ["pts", ["xy", 10, 10], ["xy", 20, 15]],
    ["format", ["prefix", ""], ["suffix", ""], ["units", 0], ["units_format", 0], ["precision", 4], ["override_value", "Fiducial"]],
    ["style", ["thickness", 0.1], ["arrow_length", 1.27], ["text_position_mode", 0], ["text_frame", 0], ["extension_offset", 0.5]],
    ["gr_text", "Fiducial", ["at", 32.7, 15, 0], ["layer", "F.SilkS"], ["uuid", id], ["effects", ["font", ["size", 1, 1], ["thickness", 0.1]]]]]);
  const n = log.commits.length; pcb.setPrompt((t, i, cl, done) => done(null));
  pcb.onPointerDown(ev(), [30, 30], ctx); pcb.onPointerDown(ev(), [40, 30], ctx); assert.equal(log.commits.length, n, "no text, no leader");
  // Enter drops a dimension in progress; a back layer mirrors the value text
  ctx.setTool("dimaligned"); pcb.onPointerDown(ev(), [1, 1], ctx); pcb.onPointerDown(ev(), [5, 1], ctx);
  assert.equal(pcb.onKey("Enter", ev(), ctx), true); assert.equal(P.state.draw, null); assert.equal(log.commits.length, n);
  assert.deepEqual(K.kid(K.kid(P.dimensionNode("aligned", { start: [0, 0], end: [4, 0], height: 2 }, "B.SilkS"), "gr_text"), "effects")[2], ["justify", "mirror"]);
});

test("deleteChanges returns REMOVED changes for a mixed multi-selection; every new tool is registered with KiCad's hotkey or none", () => {
  const doc = fixture();
  const ch = P.deleteChanges(doc, [doc.items.get("s-1"), "v-1", doc.items.get("fp-1"), "g-1", "nope"]);
  assert.deepEqual(ch.map((c) => [c.kind, c.id, c.typeName]), [["REMOVED", "s-1", "PCB_TRACK"], ["REMOVED", "v-1", "PCB_VIA"], ["REMOVED", "fp-1", "FOOTPRINT"], ["REMOVED", "g-1", "PCB_SHAPE"]]);
  assert.equal(pcb.deleteChanges, P.deleteChanges); assert.deepEqual(P.deleteChanges(doc, []), []);
  const keys = Object.fromEntries(pcb.tools.map((t) => [t.id, t.key]));
  assert.deepEqual(["gcurve", "gtextbox", "table", "image", "zone", "rulearea", "dimaligned", "dimortho", "dimcenter", "dimradial", "leader"].map((id) => keys[id]),
    ["Ctrl+Shift+B", "", "", "", "Alt+Z", "Ctrl+Shift+K", "", "Ctrl+Shift+H", "", "", ""]);
  for (const t of pcb.tools) assert.ok(t.label && t.icon && t.cursor, t.id);
  assert.equal(typeof pcb.setPrompt, "function"); assert.equal(typeof pcb.setImagePicker, "function");
});

// ================================================================ parity pass: connectivity, DRC, clipboard, placement, cleanup, pads, groups, actions
require(path.join(__dirname, "..", "props.js"));   // the pad dialog edits pads through props.js's setPad
const T = (v) => +v.toFixed(5);
const tn = (a, b, tol) => assert.ok(near(a, b, tol || 1e-5), `${a} ≈ ${b}`);
const ids = (changes) => changes.map((c) => c.id);
const kinds = (changes) => changes.map((c) => c.kind);
const node = (c) => K.parse(c.sexpr)[0] === "kicad_pcb" ? K.parse(c.sexpr).find((x, i) => i > 0 && Array.isArray(x) && x[0] !== "version" && x[0] !== "generator") : K.parse(c.sexpr);
// a fuller fake ctx: app.js's multi-selection, setSelection, a clipboard and the snapped cursor
function fullCtx(doc) {
  const { ctx, log } = fakeCtx(doc); log.clip = ""; log.selection = null; log.highlight = null;
  Object.assign(ctx, { selection: new Set(), cursor: null, activeLayer: "F.Cu",
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    setHighlight(s) { log.highlight = s ? new Set(s) : null; },
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } } });
  pcb.onDocChanged(ctx); return { ctx, log };
}
const A = pcb.actions;

test("netlist clusters touching copper per net; the ratsnest spans the clusters with a minimum tree", () => {
  const doc = fixture(); const nl = P.netlist(doc);
  const gnd = nl.nets.get("GND"), sig = nl.nets.get("/SIG");
  assert.equal(gnd.pads.length, 1); assert.equal(gnd.vias.length, 1); assert.equal(gnd.tracks.length, 5, "four segments and an arc");
  assert.equal(gnd.clusters.length, 4, "pad, the via run, the lone segment, the arc"); assert.equal(gnd.unconnected, 3); assert.equal(sig.unconnected, 0);
  assert.ok(gnd.clusters.some((c) => c.items.map((i) => i.id).sort().join() === "s-1,s-2,s-3,v-1"), "the via bridges F.Cu and B.Cu");
  const lines = P.ratsnest(doc, nl);
  assert.equal(lines.length, 3); assert.ok(lines.every((l) => l.net === "GND" && l.name === "GND"));
  const padLine = lines.find((l) => l.ids.includes("fp-1")); assert.deepEqual([padLine.a, padLine.b], [[100, 49.1], [110, 50]]); assert.deepEqual(padLine.ids, ["fp-1", "s-1"]);
  assert.ok(lines.some((l) => near(l.length, 5) && l.ids.includes("s-4") && l.ids.includes("a-1")), "nearest anchors: the segment's end to the arc's start");
  assert.equal(P.localRatsnest(doc, "fp-1", nl).length, 1); assert.equal(P.localRatsnest(doc, "s-4", nl).length, 2); assert.equal(P.localRatsnest(doc, "a-1", nl).length, 1);
  // a track from the pad to the run joins their clusters; a filled zone joins whatever sits in its copper
  P.addedChange(doc, P.segmentNode(doc, [100, 49.1], [110, 50], 0.25, "F.Cu", { code: -1, name: "GND" }));
  assert.equal(P.ratsnest(doc).length, 2);
  const z = ["zone", ["net", "GND"], ["layer", "F.Cu"], ["hatch", "edge", 0.5], ["connect_pads", ["clearance", 0.5]], ["min_thickness", 0.25], ["fill", "yes"],
    ["polygon", ["pts", ["xy", 128, 48], ["xy", 144, 48], ["xy", 144, 52], ["xy", 128, 52]]], ["filled_polygon", ["layer", "F.Cu"], ["pts", ["xy", 128, 48], ["xy", 144, 48], ["xy", 144, 52], ["xy", 128, 52]]]];
  P.addedChange(doc, z); const nl2 = P.netlist(doc);
  assert.equal(nl2.nets.get("GND").clusters.length, 2); assert.equal(P.ratsnest(doc, nl2).length, 1);
  assert.equal(P.netItemIds(doc, "GND", nl2).size, 9, "footprint, six tracks, via and zone");
  // a net-less track takes the net of what it touches (KiCad's propagation); one touching two nets is a short
  const doc2 = fixture(); P.addedChange(doc2, P.segmentNode(doc2, [100, 49.1], [100, 50.9], 0.25, "F.Cu", { code: 0, name: "" }));
  const nl3 = P.netlist(doc2); assert.equal(nl3.nets.get("GND").shorts.length + nl3.nets.get("/SIG").shorts.length, 1, "the bridge shorts GND to /SIG");
});

test("netInspector counts pads, vias, routed length (arcs by arc length) and missing connections per net", () => {
  const rows = P.netInspector(fixture());
  assert.deepEqual(rows.map((r) => r.name), ["/SIG", "GND"]);
  const gnd = rows[1]; assert.equal(gnd.padCount, 1); assert.equal(gnd.viaCount, 1); assert.equal(gnd.unconnected, 3);
  tn(gnd.trackLength, 5 + Math.hypot(3, 3) + 7 + 5 + Math.PI, 1e-4);
  assert.deepEqual(rows[0], { name: "/SIG", code: 0, padCount: 1, viaCount: 0, trackLength: 0, zoneCount: 0, unconnected: 0 });
});

const DRC_BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (43 "F.CrtYd" user))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (at 100 50 -90)
    (property "Reference" "R1" (at 0 -1.5 -90) (layer "F.SilkS") (uuid "p-1") (effects (font (size 1 1) (thickness 0.15))))
    (fp_rect (start -1.5 -1) (end 1.5 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c-1"))
    (pad "1" smd roundrect (at -0.9 0 -90) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "GND") (uuid "pad-1"))
    (pad "2" smd roundrect (at 0.9 0 -90) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "/SIG") (uuid "pad-2")))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-2") (at 102.2 50)
    (property "Reference" "R2" (at 0 -1.5) (layer "F.SilkS") (uuid "p-2") (effects (font (size 1 1) (thickness 0.15))))
    (fp_rect (start -1.5 -1) (end 1.5 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c-2"))
    (pad "1" smd rect (at -0.9 0) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (net "GND") (uuid "pad-3")))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-3") (at 105.2 50)
    (property "Reference" "R3" (at 0 -1.5) (layer "F.SilkS") (uuid "p-3") (effects (font (size 1 1) (thickness 0.15))))
    (fp_rect (start -1.5 -1) (end 1.5 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c-3"))
    (pad "1" smd rect (at -0.9 0) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (net "/SIG") (uuid "pad-4")))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-4") (at 200 200)
    (property "Reference" "R4" (at 0 -1.5) (layer "F.SilkS") (uuid "p-4") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 1 1.2) (layers "F.Cu" "F.Mask" "F.Paste") (net "GND") (uuid "pad-5")))
  (segment (start 110 50) (end 115 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-1"))
  (segment (start 110 50.35) (end 115 50.35) (width 0.25) (layer "F.Cu") (net "/SIG") (uuid "s-2"))
  (segment (start 100 40.3) (end 105 40.3) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-3"))
  (segment (start 120 45) (end 120 45) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-0"))
  (via (at 125 60) (size 0.8) (drill 0.8) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v-bad"))
  (gr_rect (start 90 40) (end 150 90) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
)`;
test("DRC: clearance, board edge, missing connections, dangling and zero-length tracks, annular width, courtyards and the outline", () => {
  const doc = K.parseDoc(DRC_BOARD, "kicad_pcb"); const m = P.drc(doc);
  const by = (code) => m.filter((x) => x.code === code);
  const clr = by("clearance"); assert.equal(clr.length, 1); assert.equal(clr[0].text, "Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1000 mm)");
  assert.deepEqual(clr[0].ids.sort(), ["s-1", "s-2"]); assert.equal(clr[0].severity, "error"); assert.ok(clr[0].x > 110 && clr[0].x < 115 && near(clr[0].y, 50.175, 1e-3));
  const edge = by("copper_edge_clearance"); assert.equal(edge.length, 1); assert.deepEqual(edge[0].ids, ["s-3"]); assert.ok(/edge clearance 0\.5000 mm; actual 0\.1500 mm/.test(edge[0].text));
  assert.equal(by("unconnected_items").length, P.ratsnest(doc).length); assert.ok(by("unconnected_items").every((x) => x.severity === "error" && /Missing connection/.test(x.text)));
  assert.deepEqual(by("zero_length").map((x) => x.ids[0]), ["s-0"]);
  const dang = by("track_dangling"); assert.deepEqual(dang.map((x) => x.ids[0]).sort(), ["s-1", "s-2", "s-3"], "one marker per loose track"); assert.ok(dang.every((x) => x.severity === "warning"));
  const ann = by("annular_width"); assert.equal(ann.length, 1); assert.deepEqual([ann[0].ids[0], ann[0].x, ann[0].y], ["v-bad", 125, 60]);
  assert.deepEqual(by("via_dangling").map((x) => x.ids[0]), ["v-bad"]);
  const cy = by("courtyards_overlap"); assert.equal(cy.length, 1, "R1 and R2 overlap; R2 and R3 only share an edge"); assert.deepEqual(cy[0].ids, ["fp-1", "fp-2"]);
  const out = by("outside_outline"); assert.deepEqual(out.map((x) => x.ids[0]), ["fp-4"]); assert.equal(out[0].severity, "warning");
  assert.equal(by("invalid_outline").length, 0); assert.equal(by("shorting_items").length, 0);
  assert.ok(m.every((x) => typeof x.x === "number" && typeof x.y === "number" && x.text && Array.isArray(x.ids)));
  // a .kicad_pro's rules: a looser clearance and edge clearance pass, ignored rules vanish, severities follow the project
  const pro = { board: { design_settings: { rules: { min_clearance: 0.05, min_copper_edge_clearance: 0.1, min_track_width: 0.3 }, rule_severities: { courtyards_overlap: "ignore", track_dangling: "error" } } },
    net_settings: { classes: [{ name: "Default", clearance: 0.05, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 }, { name: "Power", clearance: 0.4, track_width: 0.5, via_diameter: 0.8, via_drill: 0.4 }], netclass_patterns: [{ pattern: "GND", netclass: "Power" }] } };
  const s = P.designSettings(pro); assert.equal(s.clearance, 0.05); assert.equal(s.edgeClearance, 0.1); assert.equal(P.netclassOf(s, "GND").track_width, 0.5); assert.equal(P.netClearance(s, "/SIG"), 0.05);
  const m2 = P.drc(doc, s);
  assert.equal(m2.filter((x) => x.code === "courtyards_overlap").length, 0); assert.ok(m2.filter((x) => x.code === "track_dangling").every((x) => x.severity === "error"));
  assert.equal(m2.filter((x) => x.code === "copper_edge_clearance").length, 0);
  const c2 = m2.filter((x) => x.code === "clearance"); assert.equal(c2.length, 2, "GND's 0.4 mm class now also catches R1's /SIG pad against R2's GND pad");
  assert.ok(c2.every((x) => /netclass 'Power' clearance 0\.4000 mm/.test(x.text)), "the stricter class of the pair names the rule"); assert.ok(c2.some((x) => /actual 0\.2028 mm/.test(x.text) && x.ids.join() === "fp-1,fp-2"));
  assert.equal(m2.filter((x) => x.code === "track_width").length, 3, "the 0.25 mm tracks under a 0.3 mm minimum (the zero-length one is reported as such)");
  // a legacy board's (setup …) block and a broken outline
  const legacy = P.designSettings('(kicad_pcb (version 20171130) (setup (trace_clearance 0.3) (edge_clearance 0.2)) (net_class Default "" (clearance 0.3) (trace_width 0.35) (via_dia 0.9) (via_drill 0.45) (add_net GND)))');
  assert.equal(legacy.clearance, 0.3); assert.equal(legacy.edgeClearance, 0.2); assert.equal(P.netclassOf(legacy, "GND").via_diameter, 0.9);
  const open = fixture(); assert.equal(P.boardOutline(open).outline, null); assert.ok(P.boardOutline(open).hasEdges);
  assert.ok(P.drc(open).some((x) => x.code === "invalid_outline"));
  assert.ok(P.boardOutline(doc).outline.length === 4 && near(P.boardOutline(doc).area, 3000));
  assert.deepEqual(P.inspectClearance(doc, "s-1", "s-2"), { gap: 0.1, required: 0.2, sameNet: false, nets: ["GND", "/SIG"] });
});

test("clipboard: copy writes KiCad's kicad_pcb clipboard document; paste lands at the cursor with fresh uuids, kept nets and unique references", () => {
  const doc = fixture(); const text = P.clipboardText(doc, ["fp-1", "s-1"], [100, 50]);
  const tree = K.parse(text); assert.equal(tree[0], "kicad_pcb"); assert.equal(K.kid(tree, "generator")[1], "kicad-collab-web"); assert.equal(K.kid(tree, "version")[1], P.BOARD_VERSION);
  assert.deepEqual(K.kid(tree, "layers").slice(1, 3), [[0, "F.Cu", "signal"], [2, "B.Cu", "signal"]], "copper first, in stack order");
  assert.deepEqual(K.kids(tree, "net"), [["net", 0, ""], ["net", 1, "GND"], ["net", 2, "/SIG"]]);
  const fp = K.kid(tree, "footprint"), seg = K.kid(tree, "segment"); assert.deepEqual(K.atOf(fp).slice(0, 2), [0, 0], "the reference point sits at the origin"); assert.deepEqual(K.kid(seg, "start").slice(1), [10, 0]);
  assert.equal(K.uuidOf(fp), "fp-1", "copies keep their ids; paste mints new ones");
  const r = P.pasteChanges(doc, text, [200, 100]);
  assert.equal(r.changes.length, 2); assert.ok(r.changes.every((c) => c.kind === "ADDED")); assert.ok(!r.ids.includes("fp-1") && !r.ids.includes("s-1"));
  const nfp = doc.items.get(r.ids[0]), nseg = doc.items.get(r.ids[1]);
  assert.equal(nfp.kind, "footprint"); assert.deepEqual([nfp.x, nfp.y, nfp.rot], [200, 100, -90]); assert.equal(nfp.ref, "R2", "R1 is taken");
  assert.ok(!K.kids(nfp.node, "pad").some((p) => K.uuidOf(p) === "pad-1" || K.uuidOf(p) === "pad-2"), "pads get fresh ids too");
  assert.deepEqual(K.kid(K.kids(nfp.node, "pad")[0], "net"), ["net", "GND"]); assert.equal(r.changes[0].padNets["1"], "GND");
  assert.deepEqual(K.kid(nseg.node, "start").slice(1), [210, 100]); assert.deepEqual(K.kid(nseg.node, "net"), ["net", "GND"]); assert.equal(r.changes[1].netName, "GND");
  assert.equal(P.pasteChanges(doc, text, [0, 0], { annotations: "keep" }).changes.length && [...doc.items.values()].filter((it) => it.ref === "R1").length, 2);
  const cleared = P.pasteChanges(doc, text, [0, 0], { annotations: "clear" }); assert.equal(doc.items.get(cleared.ids[0]).ref, "REF**");
  assert.deepEqual(P.pasteChanges(doc, "not a board", [0, 0]), { changes: [], ids: [] });
  // a group travels with its members and comes back pointing at the copies
  const g = P.groupChanges(doc, ["s-4", "a-1"], "pair"); const gid = g[0].id;
  const t2 = P.clipboardText(doc, ["s-4"], [0, 0]); assert.ok(/\(group pair/.test(t2) && /\(arc /.test(t2), "the group and its other member come along");
  const r2 = P.pasteChanges(doc, t2, [0, 0]); const ng = r2.ids.map((id) => doc.items.get(id)).find((it) => it.kind === "group");
  assert.ok(ng && ng.id !== gid); assert.deepEqual(P.groupMembers(ng.node).sort(), r2.ids.filter((id) => id !== ng.id).sort());
  // into a numbered-net board the names become that board's codes; unknown names go unconnected
  const coded = K.parseDoc(CODE_STYLE.replace("(segment", '(footprint "X" (layer "F.Cu") (uuid "cfp") (at 0 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "GND") (uuid "cpad")))\n  (segment'), "kicad_pcb");
  const r3 = P.pasteChanges(coded, text, [5, 5]); const cfp = coded.items.get(r3.ids[0]), cseg = coded.items.get(r3.ids[1]);
  assert.deepEqual(K.kid(K.kids(cfp.node, "pad")[0], "net"), ["net", 2, "GND"]); assert.deepEqual(K.kid(K.kids(cfp.node, "pad")[1], "net"), ["net", 0, ""]); assert.deepEqual(K.kid(cseg.node, "net"), ["net", 2]);
  // duplicate: same place, new ids
  const d = P.duplicateChanges(fixture(), ["s-1"]); assert.equal(d.ids.length, 1); assert.notEqual(d.ids[0], "s-1"); assert.deepEqual(K.kid(node(d.changes[0]), "start").slice(1), [110, 50]);
  const arr = P.arrayChanges(fixture(), ["s-1"], { nx: 3, ny: 2, dx: 10, dy: 5 }); assert.equal(arr.ids.length, 5);
  assert.equal(P.referencePoint(doc, ["s-1"], [114, 51])[0], 115, "the item anchor nearest the cursor");
});

test("align and distribute move by bounding boxes like ALIGN_DISTRIBUTE_TOOL; the delta math matches kimath", () => {
  assert.deepEqual(P.distributeDeltasGaps([[0, 2], [3, 5], [10, 12]]), [0, 2, 0]); assert.deepEqual(P.distributeDeltasPoints([0, 3, 10]), [0, 2, 0]); assert.deepEqual(P.distributeDeltasGaps([[0, 1], [5, 6]]), [0, 0]);
  const doc = fixture(); const a = P.addedChange(doc, P.rectNode([0, 0], [2, 2], "F.SilkS")).id, b = P.addedChange(doc, P.rectNode([3, 5], [5, 7], "F.SilkS")).id, c = P.addedChange(doc, P.rectNode([10, 1], [12, 3], "F.SilkS")).id;
  const start = (id) => pt(doc.items.get(id).node, "start");
  const apply = (ch) => { for (const x of ch) assert.ok(K.applyChange(doc, x, IU)); return ch; };
  assert.equal(apply(P.alignChanges(doc, [a, b, c], "left")).length, 2); assert.deepEqual([start(b)[0], start(c)[0]], [0, 0]);
  apply(P.alignChanges(doc, [a, b, c], "top")); assert.deepEqual([start(b)[1], start(c)[1]], [0, 0]);
  apply(P.alignChanges(doc, [a, b, c], "right")); assert.deepEqual(start(a), [0, 0], "all share the rightmost edge already: nothing moves");
  const doc2 = fixture(); const ids2 = [P.addedChange(doc2, P.rectNode([0, 0], [2, 2], "F.SilkS")).id, P.addedChange(doc2, P.rectNode([3, 5], [5, 7], "F.SilkS")).id, P.addedChange(doc2, P.rectNode([10, 1], [12, 3], "F.SilkS")).id];
  const ch = P.distributeChanges(doc2, ids2, "x", false); assert.equal(ch.length, 1); assert.equal(ch[0].id, ids2[1]); assert.deepEqual(K.kid(node(ch[0]), "start").slice(1), [5, 5]);
  assert.deepEqual(P.distributeChanges(doc2, ids2.slice(0, 2), "x", false), [], "three items at least");
  const cy = P.alignChanges(doc2, ids2, "centerY", [4, 6]); assert.equal(cy.length, 2, "the item under the cursor is the target"); assert.ok(cy.every((x) => x.id !== ids2[1]));
});
function pt(n, key) { const k = K.kid(n, key); return [k[1], k[2]]; }

test("move exactly, position relative, rotate / flip / mirror about the selection centre, swap and pack", () => {
  const doc = fixture();
  const me = P.moveExactChanges(doc, ["s-4"], { dx: 1, dy: 2, rotation: 0 }); assert.deepEqual([pt(node(me[0]), "start"), pt(node(me[0]), "end")], [[131, 52], [136, 52]]);
  const me2 = P.moveExactChanges(doc, ["s-4"], { dx: 1, dy: 2, rotation: 180, about: "center" }); assert.deepEqual([pt(node(me2[0]), "start"), pt(node(me2[0]), "end")], [[136, 52], [131, 52]]);
  const pr = P.positionRelativeChanges(doc, ["s-4", "a-1"], [0, 0], 10, 20); assert.equal(pr.length, 2); assert.deepEqual(pt(node(pr.find((c) => c.id === "s-4")), "start"), [10, 20]); assert.deepEqual(pt(node(pr.find((c) => c.id === "a-1")), "start"), [20, 20]);
  assert.deepEqual(P.selectionCenter([doc.items.get("s-1"), doc.items.get("s-4")]), [122.5, 50]); assert.deepEqual(P.selectionCenter([doc.items.get("fp-1")]), [100, 50], "a lone item turns about its anchor");
  const rot = P.rotateChanges(doc, ["s-1", "s-4"], 122.5, 50, 90); const r1 = node(rot.find((c) => c.id === "s-1"));
  assert.deepEqual([pt(r1, "start"), pt(r1, "end")], [[122.5, 62.5], [122.5, 57.5]], "+90 is counter-clockwise on screen");
  const rt = P.addedChange(doc, P.textNode("t", 10, 10, "F.SilkS")).id; const rr = node(P.rotateChanges(doc, [rt], 10, 10, 45)[0]); assert.deepEqual(K.kid(rr, "at"), ["at", 10, 10, 45]);
  const rect = P.addedChange(doc, P.rectNode([0, 0], [4, 2], "F.SilkS")).id; const rp = node(P.rotateChanges(doc, [rect], 2, 1, 30)[0]); assert.equal(rp[0], "gr_poly"); assert.equal(K.ptsOf(rp).length, 4, "an off-axis rectangle becomes a polygon");
  assert.equal(node(P.rotateChanges(doc, [rect], 2, 1, 90)[0])[0], "gr_rect");
  const fl = P.flipChanges(doc, ["fp-1", "s-1"], 105); const fs = node(fl.find((c) => c.id === "s-1")), ff = node(fl.find((c) => c.id === "fp-1"));
  assert.deepEqual([pt(fs, "start"), pt(fs, "end"), K.kid(fs, "layer")[1]], [[100, 50], [95, 50], "B.Cu"]); assert.deepEqual([K.atOf(ff)[0], K.atOf(ff)[1], K.kid(ff, "layer")[1]], [110, 50, "B.Cu"]);
  assert.deepEqual(P.mirrorChanges(doc, ["fp-1"], 100, 50, "h"), [], "footprints refuse to mirror");
  const mv = node(P.mirrorChanges(doc, ["s-4"], 132.5, 50, "v")[0]); assert.deepEqual(pt(mv, "start"), [130, 50]); const mh = node(P.mirrorChanges(doc, [rt], 10, 10, "h")[0]); assert.ok(K.kid(K.kid(mh, "effects"), "justify").includes("mirror"));
  const sw = P.swapChanges(doc, ["s-1", "s-4"]); assert.deepEqual(pt(node(sw.find((c) => c.id === "s-1")), "start"), [130, 50]); assert.deepEqual(pt(node(sw.find((c) => c.id === "s-4")), "start"), [110, 50]);
  const doc2 = K.parseDoc(DRC_BOARD, "kicad_pcb"); const pk = P.packChanges(doc2, ["fp-1", "fp-2", "fp-3", "fp-4"]); assert.ok(pk.length >= 3);
  const boxes = pk.map((c) => { K.applyChange(doc2, c, IU); return doc2.items.get(c.id).bbox; }); for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(boxes[i][2] <= boxes[j][0] + 1e-6 || boxes[j][2] <= boxes[i][0] + 1e-6 || boxes[i][3] <= boxes[j][1] + 1e-6 || boxes[j][3] <= boxes[i][1] + 1e-6, "packed footprints do not overlap");
});

test("cleanup tracks & vias plans KiCad's options: null, duplicate, contained and collinear segments, tracks in pads, shorts, dangling ends", () => {
  const doc = fixture(); const seg = (a, b, net) => P.addedChange(doc, P.segmentNode(doc, a, b, 0.25, "F.Cu", net || { code: -1, name: "GND" })).id;
  const z = seg([50, 50], [50, 50]), d1 = seg([60, 50], [65, 50]), d2 = seg([60, 50], [65, 50]), c1 = seg([70, 50], [75, 50]), c2 = seg([75, 50], [80, 50]), big = seg([90, 50], [100, 50]), inner = seg([92, 50], [95, 50]);
  const v = P.addedChange(doc, P.viaNode(doc, 75, 50, 0.8, 0.4, { code: -1, name: "GND" })).id;
  const inPad = seg([99.8, 49.1], [100.2, 49.1]); const short = seg([100, 49.1], [100, 50.9]); const stub = seg([100, 49.1], [100, 45]);
  const plan = P.cleanupPlan(doc, { dangling: false, danglingVias: false });
  const code = (id) => plan.items.filter((i) => i.ids.includes(id)).map((i) => i.code);
  assert.deepEqual(code(z), ["null_segment"]); assert.deepEqual(code(d2), ["duplicate_track"]); assert.deepEqual(code(inner), ["contained_track"]);
  assert.deepEqual(code(inPad), ["track_in_pad"]); assert.deepEqual(code(short), ["shorting_track"]);
  assert.ok(!plan.remove.has(c1) && !plan.remove.has(c2), "a via at the joint keeps the collinear pair apart");
  assert.ok(plan.remove.has(z) && plan.remove.has(d2) && plan.remove.has(inner) && !plan.remove.has(d1) && !plan.remove.has(big) && !plan.remove.has(stub));
  // without the via the pair merges into one segment; the lone stub then dangles
  K.applyChange(doc, P.removedChange(doc.items.get(v)), IU);
  const plan2 = P.cleanupPlan(doc, { dangling: false, danglingVias: false }); const merged = plan2.replace.find((r) => r.item.id === c1);
  assert.ok(merged && plan2.remove.has(c2)); assert.deepEqual([pt(merged.node, "start"), pt(merged.node, "end")], [[70, 50], [80, 50]]);
  assert.ok(plan2.items.some((i) => i.code === "merge_collinear" && i.ids.includes(c1) && i.ids.includes(c2)));
  const plan3 = P.cleanupPlan(doc, {});
  assert.ok(plan3.remove.has(stub) && plan3.items.some((i) => i.code === "dangling_track" && i.ids[0] === stub));
  assert.ok(plan3.remove.has(c1) && plan3.remove.has(d1), "the merged segment and the lone duplicate touch nothing and go with the dangling pass");
  assert.equal(plan3.replace.length, 0, "a merged segment that is then removed is not also replaced");
  const ch = P.cleanupChanges(doc, plan3); assert.ok(ch.every((c) => c.kind === "REMOVED" || c.kind === "MODIFIED")); for (const c of ch) assert.ok(K.applyChange(doc, c, IU));
  assert.equal(P.cleanupPlan(doc, {}).items.length, 0, "a second pass finds nothing");
  // width edits, netclass sizes, layer moves, breaking a track
  const w = P.trackEditChanges(fixture(), ["s-1", "v-1"], { width: 0.5, viaSize: 1, viaDrill: 0.5, viaType: "through" }); assert.equal(K.kid(node(w[0]), "width")[1], 0.5); assert.deepEqual([K.kid(node(w[1]), "size")[1], K.kid(node(w[1]), "drill")[1]], [1, 0.5]);
  const nc = P.trackEditChanges(fixture(), ["s-1", "v-1"], { netclass: true }, P.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.3, via_diameter: 0.7, via_drill: 0.35 }] } }));
  assert.equal(K.kid(node(nc[0]), "width")[1], 0.3); assert.equal(K.kid(node(nc[1]), "size")[1], 0.7);
  const bl = node(P.trackEditChanges(fixture(), ["v-1"], { viaType: "blind", viaLayers: ["F.Cu", "B.Cu"] })[0]); assert.equal(bl[1], "blind");
  assert.equal(K.kid(node(P.trackLayerChanges(fixture(), ["s-1"], 1)[0]), "layer")[1], "B.Cu");
  const br = P.breakTrackChanges(fixture(), [112, 50.05]); assert.deepEqual(kinds(br), ["MODIFIED", "ADDED"]); assert.deepEqual(pt(node(br[0]), "end"), [112, 50]); assert.deepEqual(pt(node(br[1]), "start"), [112, 50]); assert.notEqual(br[1].id, "s-1");
  assert.deepEqual(P.breakTrackChanges(fixture(), [110, 50]), [], "not at an end");
  const nl = P.netlist(fixture()); assert.deepEqual([...P.connectedCopperIds(nl, new Set(["s-1"]))].sort(), ["s-1", "s-2", "s-3", "v-1"], "unroute takes the whole run");
});

test("groups: KiCad's (group …) node, membership queries, ungroup and member edits; locks land where each writer puts them", () => {
  const doc = fixture(); const g = P.groupChanges(doc, ["v-1", "s-1"], ""); assert.equal(g.length, 1); assert.equal(g[0].kind, "ADDED"); assert.equal(g[0].typeName, "PCB_GROUP");
  const gn = K.kid(K.parse(g[0].sexpr), "group"); assert.deepEqual(gn, ["group", "", ["uuid", g[0].id], ["members", "s-1", "v-1"]], "members sorted, name first, then the uuid");
  assert.equal(P.groupOf(doc, "s-1").id, g[0].id); assert.equal(P.groupOf(doc, "s-2"), null);
  assert.deepEqual([...P.expandGroups(doc, ["s-1"])].sort(), [g[0].id, "s-1", "v-1"].sort()); assert.deepEqual([...P.expandGroups(doc, [g[0].id])].sort(), [g[0].id, "s-1", "v-1"].sort());
  const add = P.groupMembersChanges(doc, doc.items.get(g[0].id), ["s-2"], []); assert.deepEqual(K.kid(node(add[0]), "members").slice(1), ["s-1", "s-2", "v-1"]);
  assert.equal(P.groupMembersChanges(doc, doc.items.get(g[0].id), [], ["s-1", "v-1"])[0].kind, "REMOVED", "an emptied group goes");
  const un = P.ungroupChanges(doc, ["v-1"]); assert.deepEqual(un.map((c) => [c.kind, c.id, c.typeName]), [["REMOVED", g[0].id, "PCB_GROUP"]]);
  assert.deepEqual(P.groupChanges(doc, [g[0].id], ""), [], "a group of groups is refused");
  const at = (n) => n.findIndex((c) => Array.isArray(c) && c[0] === "locked");
  const seg = P.setLocked(clone(doc.items.get("s-1").node), true); assert.equal(at(seg), 4); assert.equal(seg[5][0], "layer"); assert.ok(P.isLocked(seg));
  const fp = P.setLocked(clone(doc.items.get("fp-1").node), true); assert.equal(at(fp), 2); assert.equal(fp[3][0], "layer");
  const gl = P.setLocked(clone(doc.items.get("g-1").node), true); assert.equal(gl[at(gl) - 1][0], "stroke"); assert.equal(gl[at(gl) + 1][0], "layer");
  const tx = P.setLocked(P.textNode("x", 1, 1, "F.SilkS"), true); assert.equal(at(tx), 2); assert.equal(tx[3][0], "at");
  const via = P.setLocked(clone(doc.items.get("v-1").node), true); assert.equal(via[at(via) + 1][0], "net");
  assert.equal(at(P.setLocked(seg, false)), -1); assert.equal(P.lockChanges(doc, ["s-1"], false).length, 0, "already unlocked");
  assert.equal(P.lockChanges(doc, ["s-1", "fp-1"], true).length, 2);
});
function clone(n) { return JSON.parse(JSON.stringify(n)); }

test("conversions, selection helpers, statistics and the small edits", () => {
  const doc = fixture(); const rect = P.addedChange(doc, P.rectNode([10, 10], [14, 12], "F.SilkS")).id;
  const lines = P.convertChanges(doc, [rect], "lines"); assert.deepEqual(kinds(lines), ["ADDED", "ADDED", "ADDED", "ADDED", "REMOVED"]); assert.ok(lines.slice(0, 4).every((c) => node(c)[0] === "gr_line"));
  const doc2 = fixture(); const r2 = P.addedChange(doc2, P.rectNode([10, 10], [14, 12], "F.SilkS")).id;
  const poly = P.convertChanges(doc2, [r2], "poly"); assert.equal(node(poly[0])[0], "gr_poly"); assert.deepEqual(K.ptsOf(node(poly[0])), [[10, 10], [14, 10], [14, 12], [10, 12]]); assert.equal(poly[1].kind, "REMOVED");
  const l = [P.lineNode([0, 0], [4, 0], "F.SilkS"), P.lineNode([4, 0], [2, 3], "F.SilkS"), P.lineNode([2, 3], [0, 0], "F.SilkS")].map((n) => P.addedChange(doc2, n).id);
  const tri = P.convertChanges(doc2, l, "poly"); assert.equal(K.ptsOf(node(tri[0])).length, 3, "a closed chain of lines becomes one polygon");
  const cu = P.addedChange(doc2, P.rectNode([20, 20], [30, 30], "F.Cu")).id; const zn = P.convertChanges(doc2, [cu], "zone", { net: { code: -1, name: "GND" } });
  assert.equal(node(zn[0])[0], "zone"); assert.deepEqual(K.kid(node(zn[0]), "net"), ["net", "GND"]); assert.deepEqual(K.kid(node(zn[0]), "layer"), ["layer", "F.Cu"]); assert.equal(K.ptsOf(K.kid(node(zn[0]), "polygon")).length, 4); assert.equal(zn[0].netName, "GND");
  const ko = P.convertChanges(doc2, [P.addedChange(doc2, P.rectNode([40, 40], [45, 45], "F.Cu")).id], "keepout"); assert.ok(K.kid(node(ko[0]), "keepout")); assert.deepEqual(K.kid(node(ko[0]), "layer"), ["layer", "F.Cu"]);
  const cl = P.addedChange(doc2, P.lineNode([110, 50], [110, 55], "F.Cu")).id; const tr = P.convertChanges(doc2, [cl], "tracks"); assert.equal(node(tr[0])[0], "segment"); assert.deepEqual(K.kid(node(tr[0]), "net"), ["net", "GND"], "the copper it starts on gives the net"); assert.equal(K.kid(node(tr[0]), "width")[1], 0.2, "the copper line width becomes the track width");
  assert.deepEqual([...P.idsOnLayer(fixture(), "B.Cu")].sort(), ["s-3", "v-1"]); assert.deepEqual([...P.idsOnLayer(fixture(), "F.SilkS")], ["fp-1"]);
  const all = [...fixture().items.keys()]; assert.ok(!P.filterIds(fixture(), all, { footprints: false }).includes("fp-1")); assert.deepEqual(P.filterIds(fixture(), all, { tracks: false, vias: false, graphics: false }), ["fp-1"]);
  const st = P.boardStatistics(fixture()); assert.equal(st.footprints.total, 1); assert.equal(st.pads.smd, 2); assert.equal(st.vias.through, 1); assert.equal(st.tracks.count, 5); tn(st.tracks.length, 21.242641 + Math.PI, 1e-4);
  const st2 = P.boardStatistics(K.parseDoc(DRC_BOARD, "kicad_pcb")); assert.deepEqual([st2.width, st2.height, st2.area, st2.drills], [60, 50, 3000, 1]);
  const t = P.addedChange(doc2, P.textNode("j", 1, 1, "B.SilkS")).id; assert.deepEqual(K.kid(K.kid(node(P.justifyChanges(doc2, [t], "right")[0]), "effects"), "justify"), ["justify", "right", "mirror"]);
  assert.deepEqual(K.kid(K.kid(node(P.justifyChanges(doc2, [t], "center")[0]), "effects"), "justify"), ["justify", "mirror"]);
  const z1 = P.addedChange(doc2, P.zoneNode(doc2, [[0, 0], [1, 0], [1, 1]], "F.Cu", { code: -1, name: "GND" })).id;
  assert.deepEqual(K.kid(doc2.items.get(z1).node, "priority"), ["priority", 1], "the zone from the rectangle took 0, so the new one gets the next free priority");
  assert.deepEqual(K.kid(node(P.zonePriorityChanges(doc2, [z1], "raise")[0]), "priority"), ["priority", 2]); assert.equal(K.kid(node(P.zonePriorityChanges(doc2, [z1], "bottom")[0]), "priority"), null); assert.equal(P.zonePriorityChanges(doc2, [zn[0].id], "lower").length, 0);
  assert.deepEqual(K.kid(node(P.footprintAttrChanges(doc2, ["fp-1"], "dnp")[0]), "attr"), ["attr", "dnp"]);
});

test("pads: padAt hit-tests pads in board space; the pad dialog commits a MODIFIED footprint through props.setPad", () => {
  const doc = fixture(); const hit = P.padAt(doc, 100, 49.1); assert.ok(hit && hit.item.id === "fp-1" && hit.index === 0 && hit.pad.number === "1");
  assert.equal(P.padAt(doc, 100.4, 51.2).index, 1); assert.equal(P.padAt(doc, 100, 50), null, "between the pads"); assert.equal(P.padAt(doc, 100, 49.1, "B.Cu"), null);
  const { ctx, log } = fullCtx(doc); let spec = null; pcb.setForm((s) => { spec = s; return true; });
  assert.ok(pcb.padProperties(ctx, doc.items.get("fp-1"), 0)); assert.ok(/Pad Properties — R1 pad 1/.test(spec.title));
  const f = Object.fromEntries(spec.fields.map((x) => [x.k, x.value])); assert.deepEqual([f.number, f.type, f.shape, f.w, f.h, f.rot, f.net, f.layers], ["1", "smd", "roundrect", 1, 1.2, 0, "GND", "F.Cu F.Mask F.Paste"]);
  spec.apply({ number: "1", type: "smd", shape: "oval", w: 1.2, h: 1.6, rot: 0, drill: "", layers: "F.Cu F.Paste F.Mask", net: "/SIG", maskMargin: 0.05, rratio: NaN });
  const c = log.commits.at(-1); assert.equal(c.label, "pad"); assert.deepEqual([c.changes[0].kind, c.changes[0].typeName, c.changes[0].padNets["1"]], ["MODIFIED", "FOOTPRINT", "/SIG"]);
  const pad = K.kids(doc.items.get("fp-1").node, "pad")[0];
  assert.deepEqual(pad.slice(0, 6), ["pad", "1", "smd", "oval", ["at", -0.9, 0, -90], ["size", 1.2, 1.6]]); assert.deepEqual(K.kid(pad, "layers").slice(1), ["F.Cu", "F.Paste", "F.Mask"]);
  assert.deepEqual(K.kid(pad, "net"), ["net", "/SIG"]); assert.deepEqual(K.kid(pad, "solder_mask_margin"), ["solder_mask_margin", 0.05]); assert.equal(K.kid(pad, "roundrect_rratio"), null, "no corner ratio on an oval");
  assert.equal(pad.indexOf(K.kid(pad, "solder_mask_margin")), pad.indexOf(K.kid(pad, "net")) + 1); assert.equal(pad[pad.length - 1][0], "uuid");
  assert.equal(P.padsOf(doc.items.get("fp-1"))[0].shape, "oval"); assert.equal(doc.items.get("fp-1").geom.filter((g) => g.pad && g.layer === "F.Cu")[0].w, 1.2);
  pcb.setForm(null);
});

test("actions: the map carries KiCad's ids and hotkeys; copy / paste / cut / duplicate / group / align / rotate / DRC / net inspector run through ctx", () => {
  const keys = Object.fromEntries(Object.values(A).map((a) => [a.id, a.key]));
  assert.deepEqual(["copy", "cut", "paste", "pasteSpecial", "duplicate", "selectConnection", "selectUnconnected", "grabUnconnected", "moveExactly", "positionRelative", "rotateSelection", "flipSelection", "toggleLock", "highlightNet", "clearHighlight", "swap", "pack", "trackWidthInc", "trackWidthDec", "viaSizeInc", "viaSizeDec", "deleteFull"].map((id) => keys[id]),
    ["Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Shift+V", "Ctrl+D", "U", "O", "Shift+O", "Shift+M", "Shift+P", "R", "F", "L", "`", "~", "Alt+S", "P", "W", "Shift+W", "\\", "|", "Shift+Delete"]);
  for (const id of ["selectNet", "alignLeft", "alignRight", "alignTop", "alignBottom", "alignCenterX", "alignCenterY", "distributeH", "distributeV", "swapLayers", "changeTrackWidth", "cleanupTracks", "runDRC", "netInspector", "showRatsnest", "group", "ungroup", "mirrorH", "mirrorV", "convertToPoly", "convertToTracks", "boardStatistics", "unrouteSelected", "breakTrack", "createArray", "filterSelection", "selectAllOnLayer", "lock", "unlock", "showNetInspector", "rotateCcw", "rotateCw", "flip", "moveExact", "localRatsnestTool"])
    assert.ok(A[id] && A[id].label && typeof A[id].run === "function" && typeof A[id].key === "string", id);
  assert.ok(Object.isFrozen(A));
  const doc = fixture(); const { ctx, log } = fullCtx(doc);
  // copy takes the anchor nearest the cursor as the reference; paste puts it under the cursor and selects the copies
  ctx.selection = new Set(["s-1"]); ctx.cursor = [110, 50];
  assert.equal(pcb.onKey("Copy", ev(), ctx), true); assert.ok(/^\(kicad_pcb \(version/.test(log.clip) && /\(segment \(start 0 0\) \(end 5 0\)/.test(log.clip));
  ctx.cursor = [200, 100]; assert.equal(pcb.onKey("Paste", ev(), ctx), true);
  let c = log.commits.at(-1); assert.equal(c.label, "paste"); assert.equal(c.changes[0].kind, "ADDED"); assert.deepEqual(log.selection, [c.changes[0].id]); assert.deepEqual(pt(doc.items.get(c.changes[0].id).node, "start"), [200, 100]);
  ctx.selection = new Set(["s-4"]); assert.equal(pcb.runAction("duplicate", ctx), true); c = log.commits.at(-1); assert.equal(c.label, "duplicate"); assert.notEqual(c.changes[0].id, "s-4"); assert.deepEqual(pt(doc.items.get(c.changes[0].id).node, "start"), [130, 50]);
  ctx.selection = new Set(["a-1"]); assert.equal(pcb.onKey("Cut", ev(), ctx), true); c = log.commits.at(-1); assert.deepEqual(c.changes.map((x) => [x.kind, x.id]), [["REMOVED", "a-1"]]); assert.ok(/\(arc /.test(log.clip)); assert.deepEqual(log.selection, []);
  ctx.selection = new Set(["s-1", "s-2"]); assert.equal(pcb.runAction("group", ctx), true); c = log.commits.at(-1); assert.equal(c.changes[0].typeName, "PCB_GROUP"); const gid = c.changes[0].id;
  ctx.selection = new Set(["s-1"]); assert.equal(pcb.runAction("ungroup", ctx), true); assert.deepEqual(log.commits.at(-1).changes.map((x) => [x.kind, x.id]), [["REMOVED", gid]]);
  // R turns a multi-selection about its centre, F flips it; Shift+M moves exactly through the (stubbed) dialog
  ctx.selection = new Set(["s-1", "s-4"]); assert.equal(pcb.onKey("r", ev(), ctx), true); assert.equal(log.commits.at(-1).label, "rotate"); assert.equal(log.commits.at(-1).changes.length, 2); assert.deepEqual(pt(doc.items.get("s-1").node, "start"), [122.5, 62.5]);
  assert.equal(pcb.onKey("Flip", ev(), ctx), true); assert.equal(K.kid(doc.items.get("s-4").node, "layer")[1], "B.Cu");
  pcb.setForm((spec) => { assert.equal(spec.title, "Move Item Exactly"); spec.apply({ dx: 1, dy: 0, rotation: 0, about: "center" }); return true; });
  ctx.selection = new Set(["s-3"]); assert.equal(pcb.onKey("M", ev({ shiftKey: true }), ctx), true); assert.equal(log.commits.at(-1).label, "move exactly"); assert.deepEqual(pt(doc.items.get("s-3").node, "start"), [119, 53]);
  pcb.setForm((spec) => { spec.apply({ ref: "origin", px: 0, py: 0, dx: 5, dy: 6 }); return true; }); assert.equal(pcb.onKey("P", ev({ shiftKey: true }), ctx), true); assert.deepEqual(pt(doc.items.get("s-3").node, "start"), [5, 6]);
  pcb.setForm((spec) => { spec.apply({ netclass: false, width: 0.4, viaSize: 0.9, viaDrill: 0.45, viaType: "through", l0: "F.Cu", l1: "B.Cu" }); return true; });
  ctx.selection = new Set(["s-3", "v-1"]); assert.equal(pcb.runAction("changeTrackWidth", ctx), true); assert.equal(K.kid(doc.items.get("s-3").node, "width")[1], 0.4); assert.equal(K.kid(doc.items.get("v-1").node, "size")[1], 0.9);
  // alignment needs two items; locks toggle; select net and connection grow the selection
  const rects = [P.addedChange(doc, P.rectNode([0, 0], [2, 2], "F.SilkS")).id, P.addedChange(doc, P.rectNode([3, 5], [5, 7], "F.SilkS")).id]; ctx.selection = new Set(rects);
  assert.equal(pcb.runAction("alignLeft", ctx), true); assert.equal(log.commits.at(-1).label, "align to left"); assert.deepEqual(pt(doc.items.get(rects[1]).node, "start"), [0, 5]);
  ctx.selection = new Set(["s-4"]); assert.equal(pcb.onKey("l", ev(), ctx), true); assert.ok(P.isLocked(doc.items.get("s-4").node)); assert.equal(pcb.onKey("l", ev(), ctx), true); assert.ok(!P.isLocked(doc.items.get("s-4").node));
  ctx.selection = new Set(["v-1"]); assert.equal(pcb.runAction("selectNet", ctx), true); assert.ok(log.selection.includes("s-4") && log.selection.includes("v-1") && !log.selection.includes("fp-1"), "the net's copper, not its footprints");
  ctx.selection = new Set(["v-1"]); assert.equal(pcb.runAction("selectConnection", ctx), true); assert.deepEqual(log.selection.sort(), ["s-2", "v-1"], "s-1 was turned and s-3 moved away above");
  ctx.selection = new Set(["s-2"]); assert.equal(pcb.runAction("highlightNet", ctx), true); assert.ok(log.highlight.has("fp-1") && log.highlight.has("s-2") && log.highlight.has("v-1"));
  assert.equal(pcb.onKey("~", ev(), ctx), true); assert.equal(log.highlight, null);
  // DRC keeps its markers on the module until the document changes; the net inspector is a dialog
  let title = null; pcb.setForm((spec) => { title = spec.title; return true; });
  assert.equal(pcb.runDRC(ctx), true); assert.equal(title, "DRC Control"); assert.ok(pcb.markers.length > 0 && pcb.markers.every((m) => m.code && m.text));
  assert.equal(pcb.runAction("netInspector", ctx), true); assert.equal(title, "Net Inspector");
  assert.equal(pcb.runAction("boardStatistics", ctx), true); assert.equal(title, "Board Statistics");
  pcb.onDocChanged(ctx); assert.ok(pcb.markers.length > 0, "an edit keeps the markers"); pcb.onDocChanged(Object.assign({}, ctx, { doc: fixture() })); assert.equal(pcb.markers.length, 0, "a new document clears them");
  // Shift+Delete removes the connected run; view-only refuses edits
  pcb.onDocChanged(ctx); P.state.sel = new Set(["s-2"]); ctx.selection = new Set(); assert.equal(pcb.onKey("Delete", ev({ shiftKey: true }), ctx), true); assert.equal(log.commits.at(-1).label, "delete full track"); assert.ok(!doc.items.has("s-2") && !doc.items.has("v-1"));
  ctx.viewOnly = true; ctx.selection = new Set(["s-4"]); const n = log.commits.length; assert.equal(pcb.runAction("duplicate", ctx), true); assert.equal(log.commits.length, n); assert.ok(log.toasts.at(-1).includes("View-only"));
  ctx.viewOnly = false; pcb.setForm(null);
  // the overlay draws the ratsnest and the markers without a DOM
  P.state.showRatsnest = true; pcb.runDRC(ctx); const c2 = stubCtx(800, 600); pcb.drawOverlay(c2, VIEW, ctx); assert.ok(c2.calls.stroke > 0 && c2.calls.arc > 0);
});
