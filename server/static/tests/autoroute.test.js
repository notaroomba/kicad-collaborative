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
