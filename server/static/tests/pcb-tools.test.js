// Node test for the board editing tools: routing legs, via/graphic node shapes,
// footprint rotate/flip invariants, hit testing, connected-run selection and a
// DOM-free drive of the module hooks.   Run: node server/static/tests/pcb-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
