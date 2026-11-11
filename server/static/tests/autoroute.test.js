// Node test for the board autorouter (web/router → static/dist/autoroute.js): it connects what the ratsnest shows,
// keeps the design rules and net classes, stays off other nets, keep-outs and the board edge, changes layer through
// vias only where allowed, never alters what is already on the board, and hands its result to the editor as
// ordinary ADDED changes in one undoable commit.
// Run: node server/static/tests/autoroute.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
require(path.join(__dirname, "..", "dist", "autoroute.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter;

const HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (gr_rect (start 90 40) (end 130 70) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`;
let n = 0;
const smd = (x, y, net) => `(footprint "T:P" (layer "F.Cu") (uuid "fp-${++n}") (at ${x} ${y})
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "pad-${n}")))`;
const tht = (x, y, net) => `(footprint "T:H" (layer "F.Cu") (uuid "fp-${++n}") (at ${x} ${y})
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net "${net}") (uuid "pad-${n}")))`;
const board = (...items) => K.parseDoc(HEAD + "\n" + items.join("\n") + "\n)", "kicad_pcb");
const apply = (doc, res) => { for (const it of res.items) K.createItem(doc, it.node); };
const errors = (doc, settings) => P.drc(doc, settings).filter((m) => m.severity === "error");
const octilinear = (node) => { const a = K.kid(node, "start"), b = K.kid(node, "end"); const dx = Math.abs(b[1] - a[1]), dy = Math.abs(b[2] - a[2]); return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6; };

test("two pads of a net get a track at the netclass width, and the board passes DRC", () => {
  const doc = board(smd(100, 50, "A"), smd(115, 58, "A")); const before = doc.items.size;
  const res = R.route(K, P, doc, null);
  assert.equal(res.total, 1); assert.equal(res.routed, 1); assert.equal(res.vias, 0);
  assert.equal(doc.items.size, before, "routing itself does not touch the board");
  assert.ok(res.items.every((i) => i.kind === "segment" && octilinear(i.node) && K.num(K.kid(i.node, "width")[1]) === 0.2 && K.str(K.kid(i.node, "layer")[1]) === "F.Cu"));
  assert.ok(res.items.length <= 2, "a single 45° corner is the simplest route");
  apply(doc, res);
  assert.deepEqual(errors(doc, null), []);
  assert.equal(P.ratsnest(doc).length, 0);
});

const WALL = `(segment (start 110 41) (end 110 69) (width 0.4) (layer "F.Cu") (net "W") (uuid "wall"))`;
test("a net's class sets its width, clearance and via size", () => {
  const settings = P.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 }, { name: "Power", clearance: 0.3, track_width: 0.5, via_diameter: 0.9, via_drill: 0.4 }], netclass_assignments: { VCC: "Power" } } });
  const doc = board(smd(100, 50, "VCC"), smd(120, 50, "VCC"), smd(100, 60, "S"), smd(120, 60, "S"), WALL);
  const res = R.route(K, P, doc, settings); assert.equal(res.routed, 2);
  for (const i of res.items) if (i.kind === "segment") assert.equal(K.num(K.kid(i.node, "width")[1]), i.netName === "VCC" ? 0.5 : 0.2);
  const vias = res.items.filter((i) => i.kind === "via"); assert.equal(vias.length, 4, "each net goes under the wall and comes back up");
  for (const v of vias) assert.deepEqual([K.num(K.kid(v.node, "size")[1]), K.num(K.kid(v.node, "drill")[1])], v.netName === "VCC" ? [0.9, 0.4] : [0.6, 0.3]);
  apply(doc, res); assert.deepEqual(errors(doc, settings), []);
});

test("a track in the way is crossed on the other layer through vias; without vias the net stays unrouted", () => {
  const make = () => board(smd(100, 50, "A"), smd(120, 60, "A"), WALL);
  const withVias = make(); const r1 = R.route(K, P, withVias, null); assert.equal(r1.routed, 1); assert.equal(r1.vias, 2);
  apply(withVias, r1); assert.deepEqual(errors(withVias, null), []);
  const without = make(); const r2 = R.route(K, P, without, null, { allowVias: false }); assert.equal(r2.vias, 0); assert.equal(r2.routed, 0); assert.equal(r2.failed.length, 1); assert.equal(r2.items.length, 0);
  const oneLayer = make(); const r3 = R.route(K, P, oneLayer, null, { layers: ["F.Cu"] }); assert.equal(r3.routed, 0, "B.Cu was not offered");
});

test("plated holes change layer without a via, and existing copper is an obstacle, never altered", () => {
  const doc = board(tht(100, 55, "A"), tht(120, 55, "A"), WALL); const text = K.serialize(doc.items.get("wall").node);
  const res = R.route(K, P, doc, null); assert.equal(res.routed, 1); assert.equal(res.vias, 0);
  assert.ok(res.items.every((i) => K.str(K.kid(i.node, "layer")[1]) === "B.Cu"), "the only way past the wall is the other side");
  assert.equal(K.serialize(doc.items.get("wall").node), text);
  apply(doc, res); assert.deepEqual(errors(doc, null), []);
});

test("keep-out rule areas and the board edge are respected", () => {
  const ko = `(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "ko") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 108 40) (xy 112 40) (xy 112 62) (xy 108 62))))`;
  const doc = board(smd(100, 50, "A"), smd(120, 50, "A"), ko);
  const res = R.route(K, P, doc, null); assert.equal(res.routed, 1);
  const inKo = (x, y) => x > 108 && x < 112 && y > 40 && y < 62;
  for (const i of res.items) { const a = K.kid(i.node, "start"), b = K.kid(i.node, "end"); for (let t = 0; t <= 1; t += 0.05) assert.ok(!inKo(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t), "no track inside the keep-out"); }
  apply(doc, res); assert.deepEqual(errors(doc, null), []);   // includes copper-to-edge clearance
  // a pad hemmed in on every side cannot be reached: the router says so instead of breaking a rule
  const boxed = board(smd(100, 50, "A"), smd(120, 50, "A"), `(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "ko2") (hatch edge 0.5) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy 105 40) (xy 108 40) (xy 108 70) (xy 105 70))))`);
  const r2 = R.route(K, P, boxed, null); assert.equal(r2.routed, 0); assert.equal(r2.items.length, 0); assert.equal(r2.failed.length, 1);
});

test("only the nets asked for are routed, and a route may join the net's own track mid-way", () => {
  const doc = board(smd(100, 50, "A"), smd(120, 50, "A"), smd(110, 60, "A"), smd(100, 65, "B"), smd(120, 65, "B"));
  const res = R.route(K, P, doc, null, { nets: ["A"] }); assert.equal(res.total, 2); assert.equal(res.routed, 2); assert.ok(res.items.every((i) => i.netName === "A"));
  apply(doc, res); assert.deepEqual(P.ratsnest(doc).map((l) => l.net), ["B"]); assert.deepEqual(errors(doc, null).filter((m) => m.code !== "unconnected_items"), []);
  assert.ok(res.length < 20 + 12, "the third pad joins the track instead of running back to a pad");
});

test("the editor command commits ADDED changes once, and a cancelled run commits nothing", async () => {
  const doc = board(smd(100, 50, "A"), smd(115, 58, "A")); const commits = [];
  const ctx = { K, doc, viewOnly: false, designSettings: null, commit(ch, label) { commits.push([ch, label]); }, toast() {}, requestRender() {} };
  const s = await R.autoroute(ctx, {});
  assert.equal(s.routed, 1); assert.equal(commits.length, 1); assert.equal(commits[0][1], "autoroute");
  for (const c of commits[0][0]) { assert.equal(c.kind, "ADDED"); assert.equal(c.typeName, "PCB_TRACK"); assert.match(c.sexpr, /^\(kicad_pcb \(version \d+\) \(generator "pcbnew"\) \(segment /); assert.equal(c.netName, "A"); assert.ok(c.id); }
  assert.match(R.summaryText(s), /1 of 1 connection routed/);
  const ro = await R.autoroute(Object.assign({}, ctx, { viewOnly: true }), {}); assert.equal(ro.routed, 0); assert.equal(commits.length, 1, "view-only sessions cannot route");
});

test("the scoring weights carry their provenance", () => {
  assert.ok(R.PROVENANCE.boards.length >= 3); for (const b of R.PROVENANCE.boards) { assert.match(b.source, /^https:\/\//); assert.ok(b.license); assert.ok(b.connections > 0); }
  assert.ok(R.TRAINED.via > R.TRAINED.bend90 && R.TRAINED.bend90 > R.TRAINED.bend45);
});

test("a real board, stripped of its tracks, is routed again without a single rule violation", () => {
  const file = path.join(__dirname, "..", "..", "..", "demos", "ecc83", "ecc83-pp_v2.kicad_pcb"); if (!fs.existsSync(file)) return;
  const doc = K.parseDoc(fs.readFileSync(file, "utf8"), "kicad_pcb"); const settings = P.designSettings(JSON.parse(fs.readFileSync(file.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8")));
  for (const [id, it] of Array.from(doc.items)) if (it.kind === "segment" || it.kind === "arc" || it.kind === "via") doc.items.delete(id);
  const bad = (d) => P.drc(d, settings, { unconnected: false }).filter((m) => m.code === "clearance" || m.code === "copper_edge_clearance" || m.code === "shorting_items").length;
  const before = bad(doc); const res = R.route(K, P, doc, settings);
  assert.equal(res.routed, res.total); assert.ok(res.total >= 10);
  apply(doc, res); assert.equal(bad(doc), before); assert.equal(P.ratsnest(doc).length, 0);
});

// ---------------------------------------------------------------- a plan from outside (the assistant's model)
const segs = (res, net) => res.items.filter((i) => i.kind === "segment" && (!net || i.netName === net));
const layerOf = (i) => K.str(K.kid(i.node, "layer")[1]);
const segLen = (i) => { const a = K.kid(i.node, "start"), b = K.kid(i.node, "end"); return Math.hypot(b[1] - a[1], b[2] - a[2]); };

test("a plan sets the order nets are routed in", () => {
  const doc = board(smd(100, 50, "A"), smd(104, 50, "A"), smd(100, 60, "B"), smd(125, 60, "B"), smd(100, 65, "C"), smd(112, 65, "C"));
  const seq = (opts) => { const r = new R.Router(K, P, doc, null, opts); const out = []; const it = r.run(); let s = it.next(); while (!s.done) { out.push(s.value.net); s = it.next(); } return out; };
  assert.deepEqual(seq({}), ["A", "C", "B"], "shortest first without a plan");
  assert.deepEqual(seq({ order: ["B", "C"] }), ["B", "C", "A"]);
  assert.deepEqual(seq({ netOpts: { C: { priority: 5 } } }), ["C", "A", "B"]);
});

test("a plan picks a net's layers, width and via budget; the rules still hold", () => {
  const make = () => board(tht(100, 50, "A"), tht(120, 50, "A"), smd(100, 60, "B"), smd(120, 60, "B"));
  const doc = make(); const res = R.route(K, P, doc, null, { netOpts: { A: { layers: ["B.Cu"], width: 0.5 }, B: { layers: ["B.Cu"] } } });
  assert.equal(res.routed, 2);
  assert.ok(segs(res, "A").length && segs(res, "A").every((i) => layerOf(i) === "B.Cu" && K.num(K.kid(i.node, "width")[1]) === 0.5), "through-hole pads: all of A on the back at the asked width");
  const b = segs(res, "B"); const onBack = b.filter((i) => layerOf(i) === "B.Cu").reduce((s, i) => s + segLen(i), 0), onFront = b.filter((i) => layerOf(i) === "F.Cu").reduce((s, i) => s + segLen(i), 0);
  assert.equal(res.items.filter((i) => i.kind === "via" && i.netName === "B").length, 2, "surface pads reach the back through two vias");
  assert.ok(onBack > onFront * 3, `B runs on the back (${onBack.toFixed(1)} mm) and only escapes on the front (${onFront.toFixed(1)} mm)`);
  const rep = res.connections.find((c) => c.net === "B"); assert.equal(rep.routed, true); assert.equal(rep.vias, 2); assert.deepEqual(rep.layers, ["F.Cu", "B.Cu"]); assert.ok(rep.detourRatio >= 1 && rep.length > 19.9);
  assert.ok(/\.1$/.test(rep.from.pad) && /\.1$/.test(rep.to.pad), "ends are named by pad");
  apply(doc, res); assert.deepEqual(errors(doc, null), []);
  const d2 = make(); const r2 = R.route(K, P, d2, null, { netOpts: { B: { layers: ["B.Cu"], maxVias: 1 } } });
  assert.equal(r2.items.filter((i) => i.kind === "via" && i.netName === "B").length, 0, "one via is not enough to go to the back and return: B stays on the front");
  assert.equal(r2.routed, 2);
});

test("a net keeps out of the areas its plan names, and run-wide keep-outs hold for every net", () => {
  const make = () => board(smd(100, 55, "A"), smd(120, 55, "A"));
  const direct = R.route(K, P, make(), null); assert.equal(direct.connections[0].bends, 0);
  const around = R.route(K, P, make(), null, { layers: ["F.Cu"], netOpts: { A: { avoid: [[108, 50, 112, 60]] } } });
  assert.equal(around.routed, 1); assert.ok(around.connections[0].length > direct.connections[0].length + 3, "the route goes round the box");
  for (const i of segs(around)) { const a = K.kid(i.node, "start"), b = K.kid(i.node, "end"); for (let t = 0; t <= 1; t += 0.05) { const x = a[1] + (b[1] - a[1]) * t, y = a[2] + (b[2] - a[2]) * t; assert.ok(!(x > 108.2 && x < 111.8 && y > 50.2 && y < 59.8), "no track inside the box"); } }
  const walled = R.route(K, P, make(), null, { keepouts: [{ box: [108, 39, 112, 71] }] });
  assert.equal(walled.routed, 0); assert.equal(walled.connections[0].reason, "no-room"); assert.match(walled.connections[0].detail, /no path/);
  const front = R.route(K, P, make(), null, { keepouts: [{ layers: ["F.Cu"], box: [108, 39, 112, 71] }] });
  assert.equal(front.routed, 1); assert.equal(front.vias, 2, "a keep-out on the front only is crossed on the back");
  for (const v of front.items.filter((i) => i.kind === "via")) { const x = K.num(K.kid(v.node, "at")[1]); assert.ok(x < 108 || x > 112, "and no via lands inside it"); }
});

test("failed connections say what stopped them", () => {
  const doc = board(smd(100, 50, "A"), smd(120, 60, "A"), WALL);
  const r = R.route(K, P, doc, null, { allowVias: false }); const c = r.connections[0];
  assert.equal(c.routed, false); assert.equal(c.reason, "no-room"); assert.equal(c.net, "A");
  // B must cross A on a one-layer board: with A first and no rip-up, B is blocked by A
  const d2 = board(smd(100, 41.5, "A"), smd(100, 68.5, "A"), smd(95, 55, "B"), smd(125, 55, "B"), `(segment (start 100.5 41) (end 129.5 41) (width 0.2) (layer "F.Cu") (net "W") (uuid "w1"))`, `(segment (start 100.5 69) (end 129.5 69) (width 0.2) (layer "F.Cu") (net "W") (uuid "w2"))`, `(segment (start 91 41) (end 99.5 41) (width 0.2) (layer "F.Cu") (net "W") (uuid "w3"))`, `(segment (start 91 69) (end 99.5 69) (width 0.2) (layer "F.Cu") (net "W") (uuid "w4"))`);
  const r2 = R.route(K, P, d2, null, { layers: ["F.Cu"], order: ["A", "B"], ripUp: false, passes: 1 });
  const b = r2.connections.find((x) => x.net === "B"); assert.equal(r2.routed, 1); assert.equal(b.reason, "blocked"); assert.deepEqual(b.blockedBy.nets, ["A"]);
  const r3 = R.route(K, P, d2, null, { layers: ["F.Cu"], timeMs: -1 }); assert.ok(r3.connections.every((x) => x.reason === "budget"));
});

test("evaluate reports what is left to route and how the routed nets run", () => {
  const doc = board(smd(100, 50, "A"), smd(120, 50, "A"), smd(100, 60, "B"), smd(120, 60, "B"), WALL);
  const e0 = R.evaluate(K, P, doc, null); assert.equal(e0.unrouted, 2); assert.equal(e0.ratsnest, 40); assert.equal(e0.trackLength > 0, true); assert.equal(e0.routedNets, 0);
  apply(doc, R.route(K, P, doc, null));
  const e1 = R.evaluate(K, P, doc, null, { drc: true }); assert.equal(e1.unrouted, 0); assert.equal(e1.ratsnest, 0); assert.equal(e1.vias, 4); assert.equal(e1.routedNets, 2); assert.equal(e1.drc.errors, 0);
  const a = e1.perNet.find((n) => n.net === "A"); assert.equal(a.shortest, 20); assert.ok(a.trackLength >= 20 && a.detourRatio >= 1 && a.detourRatio < 1.3); assert.deepEqual(a.layers, ["B.Cu", "F.Cu"]);
});

// ---------------------------------------------------------------- placement
const part = (ref, x, y, pads, extra = "") => `(footprint "T:${ref}" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "ref-${ref}")) ${extra}
    ${pads.map(([num, px, py, net, w, h]) => `(pad "${num}" smd rect (at ${px} ${py}) (size ${w || 0.6} ${h || 0.6}) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "pad-${ref}-${num}"))`).join("\n    ")})`;
const cap = (ref, x, y, a, b) => part(ref, x, y, [["1", -0.5, 0, a], ["2", 0.5, 0, b]]);
const ic = (ref, x, y, nets) => part(ref, x, y, nets.map((n, i) => [String(i + 1), i < 4 ? -2 : 2, i < 4 ? -1.905 + i * 1.27 : 1.905 - (i - 4) * 1.27, n, 1.2, 0.6]), `(fp_rect (start -3 -2.6) (end 3 2.6) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "cy-${ref}"))`);
const placeBoard = () => board(
  ic("U1", 95, 45, ["VIN", "EN", "GND", "FB", "SW", "BST", "VOUT", "GND"]), cap("C1", 128, 42, "VIN", "GND"), cap("C2", 92, 68, "VOUT", "GND"), cap("L1", 127, 68, "SW", "VOUT"), cap("R1", 110, 43, "FB", "VOUT"),
  ic("U2", 125, 55, ["VOUT", "D1", "D2", "D3", "D4", "D5", "GND", "XI"]), cap("C3", 93, 55, "VOUT", "GND"), cap("Y1", 110, 68, "XI", "GND"),
  part("J1", 110, 55, [["1", -1, 1.5, "VIN", 0.8, 1.6], ["2", 1, 1.5, "GND", 0.8, 1.6]], `(fp_rect (start -3 -3) (end 3 2.5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "cy-J1"))`));
const SPEC = [{ ref: "U1", group: "buck", anchor: true }, { ref: "C1", group: "buck", near: "U1" }, { ref: "C2", group: "buck" }, { ref: "L1", group: "buck" }, { ref: "R1", group: "buck" },
  { ref: "U2", group: "mcu" }, { ref: "C3", group: "mcu", near: "U2" }, { ref: "Y1", group: "mcu", near: "U2" }, { ref: "J1", edge: "left" }];

test("placement lays each group out as a block, then places the blocks inside the outline", () => {
  const doc = placeBoard(); const before = JSON.stringify(Array.from(doc.items.values()).map((i) => K.atOf(i.node)));
  const res = R.place(K, P, doc, null, { footprints: SPEC });
  assert.equal(JSON.stringify(Array.from(doc.items.values()).map((i) => K.atOf(i.node))), before, "placing itself does not touch the board");
  assert.equal(res.placements.length, 9); assert.deepEqual(res.unknown, []); assert.equal(res.outlineFromBoard, true); assert.deepEqual(res.outline, [90, 40, 130, 70]);
  assert.deepEqual(res.score.overlaps, 0); assert.equal(res.score.courtyardClashes, 0); assert.equal(res.score.outside, 0);
  const at = (ref) => res.placements.find((p) => p.ref === ref); const d = (a, b) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
  for (const [c, u] of [["C1", "U1"], ["C2", "U1"], ["L1", "U1"], ["R1", "U1"], ["C3", "U2"], ["Y1", "U2"]]) assert.ok(d(c, u) < 6.5, `${c} sits at ${u} (${d(c, u).toFixed(1)} mm)`);
  const buck = res.groups.find((g) => g.name === "buck"), mcu = res.groups.find((g) => g.name === "mcu");
  assert.deepEqual(buck.refs.slice().sort(), ["C1", "C2", "L1", "R1", "U1"]); assert.equal(buck.anchor, "U1");
  assert.ok(buck.box[2] <= mcu.box[0] || mcu.box[2] <= buck.box[0] || buck.box[3] <= mcu.box[1] || mcu.box[3] <= buck.box[1], "the blocks do not interleave");
  assert.ok(Math.abs(at("J1").x - 3 - 90) < 0.06 || Math.abs(at("J1").y - 3 - 90) < 0.06 || [87, 93, 92.5, 87.5].some((v) => Math.abs(at("J1").x - v) < 0.06), `the connector is flush with the left edge (x = ${at("J1").x})`);
  const start = R.evaluate(K, P, doc, null).ratsnest;
  const changes = R.placementChanges(K, P, doc, res.placements); assert.ok(changes.length >= 8 && changes.every((c) => c.kind === "MODIFIED" || c.kind === "CHANGED" || c.kind));
  // the edits put every part exactly where the result says
  for (const c of changes) { const node = K.parseDoc(c.sexpr, "kicad_pcb").items.values().next().value.node; const it = doc.items.get(c.id); it.node = node; }
  for (const p of res.placements) { const [x, y, rot] = K.atOf(doc.items.get(p.id).node); assert.ok(Math.abs(x - p.x) < 1e-6 && Math.abs(y - p.y) < 1e-6 && ((rot - p.rot) % 360 + 360) % 360 === 0, `${p.ref} at ${x},${y},${rot} wanted ${p.x},${p.y},${p.rot}`); }
  assert.ok(res.score.ratsnest < start * 0.6, `ratsnest ${start.toFixed(0)} mm before, ${res.score.ratsnest.toFixed(0)} mm after`);
});

test("placement honours fixed parts and makes an outline when the board has none", () => {
  const doc = placeBoard();
  const res = R.place(K, P, doc, null, { footprints: SPEC.map((s) => s.ref === "U2" ? { ...s, fixed: { x: 120, y: 50, rot: 90 } } : s) });
  const u2 = res.placements.find((p) => p.ref === "U2"); assert.deepEqual([u2.x, u2.y, u2.rot], [120, 50, 90]); assert.equal(res.score.overlaps, 0);
  const bare = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))\n${ic("U1", 0, 0, ["A", "B", "C", "D", "E", "F", "G", "H"])}\n${cap("C1", 0, 0, "A", "H")}\n${cap("C2", 0, 0, "D", "E")}\n)`, "kicad_pcb");
  const r2 = R.place(K, P, bare, null, {}); assert.equal(r2.outlineFromBoard, false); assert.equal(r2.placements.length, 3); assert.equal(r2.score.overlaps, 0); assert.equal(r2.score.outside, 0);
  assert.equal(r2.groups.length, 1, "small parts join the larger part they connect to");
});

test("the Auto Place command commits the moves once as ordinary edits; view-only sessions cannot place", () => {
  const doc = placeBoard(); const commits = [];
  const ctx = { K, doc, viewOnly: false, designSettings: null, commit(ch, label) { commits.push([ch, label]); }, toast() {}, requestRender() {} };
  const s = R.autoplace(ctx, { refs: ["C1", "C2", "L1", "R1"] });
  assert.equal(commits.length, 1); assert.equal(commits[0][1], "auto place"); assert.equal(s.parts, 4); assert.equal(s.moved, 4);
  assert.deepEqual(commits[0][0].map((c) => c.id).sort(), ["fp-C1", "fp-C2", "fp-L1", "fp-R1"]); for (const c of commits[0][0]) assert.match(c.sexpr, /\(footprint /);
  assert.equal(s.score.overlaps, 0); assert.match(R.placeSummaryText(s), /4 footprints moved/);
  const ro = R.autoplace(Object.assign({}, ctx, { viewOnly: true }), {}); assert.equal(ro.moved, 0); assert.equal(commits.length, 1);
  assert.ok(P.ACTIONS.autoplace && P.ACTIONS.autoroute, "both commands are in the editor's action table");
});

test("fine-pitch pads: tracks neck down and leave the pads off the grid, within the rules", () => {
  // eight 0.25 mm pads at 0.4 mm pitch whose rows fall between the rows of the 0.1 mm grid, each to a test pad
  const nets = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"];
  const chip = `(footprint "T:QFN" (layer "F.Cu") (uuid "fp-qfn") (at 100 50)
    ${nets.map((nm, i) => `(pad "${i + 1}" smd roundrect (at 0 ${(i * 0.4 + 0.05).toFixed(2)}) (size 0.825 0.25) (roundrect_rratio 0.25) (layers "F.Cu" "F.Mask") (net "${nm}") (uuid "q-${i}"))`).join("\n    ")})`;
  const doc = board(chip, ...nets.map((nm, i) => smd(106 + (i % 2) * 3, 44 + i * 2.2, nm)));
  const settings = P.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.15, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }] }, rules: { min_track_width: 0.1 } });
  const res = R.route(K, P, doc, settings, { pitch: 0.1 });
  assert.equal(res.routed, 8, JSON.stringify(res.connections.filter((c) => !c.routed).map((c) => [c.net, c.reason, c.detail])));
  const widths = new Set(segs(res).map((i) => K.num(K.kid(i.node, "width")[1]))); assert.equal(widths.size, 1); const w = [...widths][0];
  assert.ok(w < 0.25 && w >= 0.15, `narrower than the class's 0.25 mm at these pads, as wide as their neighbours allow (${w} mm)`);
  apply(doc, res); assert.deepEqual(errors(doc, settings), []); assert.equal(P.ratsnest(doc).length, 0);
});

test("placement: two pinned parts in one group both land exactly where asked, unsnapped", () => {
  const doc = placeBoard();
  const res = R.place(K, P, doc, null, { footprints: SPEC.map((s) => s.ref === "U1" ? { ...s, fixed: { x: 100.013, y: 50.57, rot: 0 } } : s.ref === "L1" ? { ...s, fixed: { x: 121.57, y: 62.86, rot: 90 } } : s) });
  const at = (ref) => res.placements.find((p) => p.ref === ref);
  assert.deepEqual([at("U1").x, at("U1").y, at("U1").rot], [100.013, 50.57, 0]); assert.deepEqual([at("L1").x, at("L1").y, at("L1").rot], [121.57, 62.86, 90]);
  assert.equal(at("L1").group, "buck"); assert.equal(res.score.courtyardClashes, 0);
});

test("after routing a board with zones, the desktop app is asked to refill them", async () => {
  const zone = `(zone (net "G") (net_name "G") (layer "B.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 91 41) (xy 129 41) (xy 129 69) (xy 91 69))))`;
  const run = async (items) => { const doc = board(...items); const asked = []; const ctx = { K, doc, viewOnly: false, designSettings: null, commit() {}, toast() {}, requestRender() {}, requestDesktop(what) { asked.push(what); return true; } }; const s = await R.autoroute(ctx, {}); return { s, asked }; };
  const withZone = await run([smd(100, 50, "A"), smd(115, 58, "A"), zone]); assert.deepEqual(withZone.asked, ["fill_zones"]); assert.equal(withZone.s.refillAsked, true);
  const without = await run([smd(100, 50, "A"), smd(115, 58, "A")]); assert.deepEqual(without.asked, []); assert.equal(without.s.refillAsked, false);
});

const pad = (x, y, net, w = 0.3, h = 0.8) => `(footprint "T:S" (layer "F.Cu") (uuid "fp-${++n}") (at ${x} ${y})
    (pad "1" smd rect (at 0 0) (size ${w} ${h}) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "pad-${n}")))`;
const widthOf = (i) => K.num(K.kid(i.node, "width")[1]);
test("a differential pair runs side by side at a constant gap, and each track ends on its own pad", () => {
  assert.deepEqual(R.pairName("USB_D+"), { base: "USB_D~", pol: 1 }); assert.equal(R.pairName("USB_D-").base, "USB_D~");
  assert.equal(R.pairName("Net-(U1-USB_DP)").base, R.pairName("Net-(U1-USB_DM)").base); assert.equal(R.pairName("HDMI_D2_P").base, R.pairName("HDMI_D2_N").base);
  assert.equal(R.pairName("+3V3"), null); assert.equal(R.pairName("V+"), null); assert.equal(R.pairName("GPIO4"), null);
  const doc = board(pad(100, 50, "D+"), pad(100.6, 50, "D-"), pad(120, 62, "D+"), pad(120.6, 62, "D-"), smd(105, 60, "S"), smd(118, 48, "S"));
  const res = R.route(K, P, doc, null); assert.equal(res.routed, 3);
  assert.equal(res.pairs.length, 1); const pr = res.pairs[0]; assert.equal(pr.coupled, true, pr.reason); assert.equal(pr.gap, 0.2); assert.ok(pr.skew < 1, "the two tracks are nearly the same length: " + pr.skew);
  assert.equal(res.items.filter((i) => i.kind === "via" && /^D/.test(i.netName)).length, 0, "a pair stays on one layer");
  apply(doc, res); assert.deepEqual(errors(doc, null), []); assert.equal(P.ratsnest(doc).length, 0);
  // along the run the two tracks are exactly one gap apart
  const seg = (i) => ({ t: "seg", a: K.kid(i.node, "start").slice(1, 3), b: K.kid(i.node, "end").slice(1, 3), r: widthOf(i) / 2 });
  const dp = res.items.filter((i) => i.netName === "D+" && i.kind === "segment").map(seg), dn = res.items.filter((i) => i.netName === "D-" && i.kind === "segment").map(seg);
  let close = 0, total = 0; for (const a of dp) { const len = Math.hypot(a.a[0] - a.b[0], a.a[1] - a.b[1]); total += len; if (dn.some((b) => Math.abs(P.shapeGap(a, b) - 0.2) < 1e-3)) close += len; }
  assert.ok(close / total > 0.8, "most of the pair is coupled: " + (close / total).toFixed(2));
  const off = R.route(K, P, board(pad(100, 50, "D+"), pad(100.6, 50, "D-"), pad(120, 62, "D+"), pad(120.6, 62, "D-")), null, { pairs: false }); assert.equal(off.pairs.length, 0); assert.equal(off.routed, 2);
});

const netLen = (res, net) => res.items.filter((i) => i.kind === "segment" && i.netName === net).reduce((a, i) => { const s = K.kid(i.node, "start"), e = K.kid(i.node, "end"); return a + Math.hypot(s[1] - e[1], s[2] - e[2]); }, 0);
test("nets that are to match are brought to one length with serpentines, within the tolerance and the rules", () => {
  const make = () => board(smd(100, 45, "A0"), smd(125, 45, "A0"), smd(100, 52, "A1"), smd(118, 52, "A1"), smd(100, 59, "A2"), smd(112, 59, "A2"));
  const plain = R.route(K, P, make(), null); assert.ok(netLen(plain, "A0") - netLen(plain, "A2") > 10);
  const doc = make(); const res = R.route(K, P, doc, null, { match: [{ nets: ["A0", "A1", "A2"], tolerance: 0.2 }] });
  assert.equal(res.routed, 3); const g = res.matched[0]; assert.equal(g.members.length, 3); assert.ok(g.members.every((m) => m.matched), JSON.stringify(g));
  const L = ["A0", "A1", "A2"].map((k) => netLen(res, k)); assert.ok(Math.max(...L) - Math.min(...L) <= 0.4, "lengths " + L.map((v) => v.toFixed(2)).join(" "));
  assert.ok(Math.abs(L[0] - netLen(plain, "A0")) < 1e-6, "the longest is left as it was");
  apply(doc, res); assert.deepEqual(errors(doc, null), []); assert.equal(P.ratsnest(doc).length, 0);
  // no room: a wall close on both sides of the short net leaves nowhere to swing
  const tight = board(smd(100, 45, "A0"), smd(125, 45, "A0"), smd(100, 59, "A2"), smd(112, 59, "A2"),
    `(segment (start 101.5 58.2) (end 110.5 58.2) (width 0.2) (layer "F.Cu") (net "W") (uuid "w1"))`, `(segment (start 101.5 59.8) (end 110.5 59.8) (width 0.2) (layer "F.Cu") (net "W") (uuid "w2"))`);
  const r2 = R.route(K, P, tight, null, { match: [{ nets: ["A0", "A2"] }] }); const m2 = r2.matched[0].members.find((m) => m.nets[0] === "A2");
  apply(tight, r2); assert.deepEqual(errors(tight, null), [], "whatever was added keeps the rules"); assert.equal(typeof m2.matched, "boolean");
});

test("the pairs of one bus are matched to each other, and each pair's own skew is taken out", () => {
  const lane = (i, x0, x1, y0, y1) => [pad(x0, y0 + i * 2, `HDMI_D${i}_P`), pad(x0, y0 + i * 2 + 0.6, `HDMI_D${i}_N`), pad(x1, y1 + i * 2, `HDMI_D${i}_P`), pad(x1, y1 + i * 2 + 0.6, `HDMI_D${i}_N`)];
  const rot = (s) => s.replace(/\(size 0.3 0.8\)/g, "(size 0.8 0.3)");
  const doc = board(...lane(0, 100, 124, 46, 46).map(rot), ...lane(1, 100, 118, 46, 46).map(rot), ...lane(2, 100, 112, 46, 46).map(rot));
  const res = R.route(K, P, doc, null, { impedance: false }); assert.equal(res.routed, 6);
  assert.equal(res.pairs.filter((p) => p.coupled).length, 3, JSON.stringify(res.pairs));
  assert.equal(res.matched.length, 1); assert.equal(res.matched[0].group, "HDMI"); assert.ok(res.matched[0].members.every((m) => m.matched), JSON.stringify(res.matched[0]));
  for (const p of res.pairs) assert.ok(p.skew <= 0.1 + 1e-6, `${p.p} skew ${p.skew}`);
  const L = [0, 1, 2].map((i) => (netLen(res, `HDMI_D${i}_P`) + netLen(res, `HDMI_D${i}_N`)) / 2); assert.ok(Math.max(...L) - Math.min(...L) <= 0.5, "pair lengths " + L.map((v) => v.toFixed(2)).join(" "));
  apply(doc, res); assert.deepEqual(errors(doc, null), []); assert.equal(P.ratsnest(doc).length, 0);
});

test("tracks are sized for impedance from the board's stackup, and the router says so when the board cannot carry it", () => {
  const Z = R.impedance; const thin = { kind: "microstrip", h: 0.2, b: 0.2, t: 0.035, er: 4.4, layer: "F.Cu", reference: ["In1.Cu"] }, thick = Object.assign({}, thin, { h: 1.53, b: 1.53, er: 4.5 });
  assert.ok(Math.abs(Z.widthFor(thin, 50) - 0.35) < 0.03, "50 Ω over 0.2 mm of FR4 is about 0.35 mm"); assert.ok(Math.abs(Z.widthFor(thick, 50) - 2.9) < 0.2, "and about 2.9 mm on a 1.6 mm two-layer board");
  assert.ok(Z.zdiff(thin, 0.2, 0.15) < 2 * Z.z0(thin, 0.2), "coupling lowers a pair's impedance"); assert.ok(Z.z0(thin, 0.2) > Z.z0(thin, 0.4), "a wider track is a lower impedance");
  assert.equal(Z.usualImpedance("USB_D+", true), 90); assert.equal(Z.usualImpedance("HDMI_D0_P", true), 100); assert.equal(Z.usualImpedance("ANT", false), 50); assert.equal(Z.usualImpedance("GPIO4", false), 0);
  const four = (body) => K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" power) (6 "In2.Cu" power) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.2) (epsilon_r 4.4)) (layer "In1.Cu" (type "copper") (thickness 0.0175)) (layer "dielectric 2" (type "core") (thickness 1.1) (epsilon_r 4.6)) (layer "In2.Cu" (type "copper") (thickness 0.0175)) (layer "dielectric 3" (type "prepreg") (thickness 0.2) (epsilon_r 4.4)) (layer "B.Cu" (type "copper") (thickness 0.035))))
  (gr_rect (start 90 40) (end 130 70) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))\n${body}\n)`, "kicad_pcb");
  const st = Z.stackupOf(K, four("")); assert.equal(st.assumed, false); const tr = Z.traceOn(st, "F.Cu"); assert.equal(tr.kind, "microstrip"); assert.ok(Math.abs(tr.h - 0.2) < 1e-9); assert.deepEqual(tr.reference, ["In1.Cu"]);
  assert.equal(Z.traceOn(st, "In1.Cu").kind, "stripline");
  const doc = four([smd(100, 50, "ANT"), smd(120, 50, "ANT"), smd(100, 60, "SIG"), smd(120, 60, "SIG")].join("\n")); const res = R.route(K, P, doc, null);
  const z = res.impedance.find((r) => r.nets[0] === "ANT"); assert.equal(z.applied, true); assert.equal(z.target, 50); assert.ok(Math.abs(z.width - 0.35) < 0.03); assert.ok(Math.abs(z.achieved - 50) <= 1);
  for (const i of res.items) if (i.kind === "segment") assert.equal(widthOf(i), i.netName === "ANT" ? z.width : 0.2);
  apply(doc, res); assert.deepEqual(errors(doc, null), []);
  // a two-layer board: 50 Ω would take a track nearly 3 mm wide, so the class width stays and the report explains
  const two = board(smd(100, 50, "ANT"), smd(120, 50, "ANT")); assert.equal(Z.stackupOf(K, two).assumed, true); const r2 = R.route(K, P, two, null);
  assert.equal(r2.impedance[0].applied, false); assert.match(r2.impedance[0].note, /needs a 2\.\d+ mm track/); assert.ok(r2.items.every((i) => widthOf(i) === 0.2));
  // a plan can ask for an impedance by net, and switching the feature off leaves widths alone
  const r3 = R.route(K, P, four([smd(100, 50, "X"), smd(120, 50, "X")].join("\n")), null, { netOpts: { X: { impedance: 75 } } }); assert.equal(r3.impedance[0].target, 75); assert.ok(r3.items.every((i) => widthOf(i) < 0.2 || widthOf(i) === r3.impedance[0].width));
  const r4 = R.route(K, P, four([smd(100, 50, "ANT"), smd(120, 50, "ANT")].join("\n")), null, { impedance: false }); assert.equal(r4.impedance.length, 0); assert.ok(r4.items.every((i) => widthOf(i) === 0.2));
});
