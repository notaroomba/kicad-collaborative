// fpedit-tools.test.js — the Footprint Editor's tools under node (web/tools/pcb-tools/pad-tool.ts, exchange.ts):
// FOOTPRINT::GetNextPadNumber, PAD_MASTER_PROVIDER, PlacePad (one "Place pad" step), Duplicate and Increment, the
// anchor move, pad rotate / mirror, the editable copy of a board footprint and BOARD::ExchangeFootprint.
// Run: node server/static/tests/fpedit-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const PT = P.pad, X = P.exchange, IU = 1e6;

const FP = `(footprint "R_0603"
	(version 20241229)
	(generator "pcbnew")
	(layer "F.Cu")
	(property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (uuid "11111111-1111-4111-8111-111111111111") (effects (font (size 1 1) (thickness 0.15))))
	(property "Value" "R_0603" (at 0 1.43 0) (layer "F.Fab") (uuid "22222222-2222-4222-8222-222222222222") (effects (font (size 1 1) (thickness 0.15))))
	(fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "33333333-3333-4333-8333-333333333333"))
	(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "44444444-4444-4444-8444-444444444444"))
	(pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "55555555-5555-4555-8555-555555555555"))
)
`;
const fpDoc = () => K.parseDoc(FP, "footprint");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, fpEditor: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  return { ctx, log };
}
const pads = (doc) => [...doc.items.values()].filter((i) => i.kind === "pad");
test.beforeEach(() => { PT.padMemory.lastType = "auto"; PT.padMemory.lastByType = {}; PT.padMemory.lastNumber = "1"; P.state.padTemplate = null; });

test("GetNextPadNumber: prefix + trailing integer, counting past numbers in use", () => {
  const doc = fpDoc();
  assert.equal(PT.nextPadNumber(doc, "1"), "3");
  assert.equal(PT.nextPadNumber(doc, "A1"), "A1");
  assert.equal(PT.nextPadNumber(doc, "2", ["3", "4"]), "5");
  assert.equal(PT.refDesPrefix("AB12"), "AB"); assert.equal(PT.trailingInt("AB12"), 12); assert.equal(PT.trailingInt("X"), 0);
  assert.ok(PT.strNumCmp("A10", "A9") > 0); assert.ok(PT.strNumCmp("2", "10") < 0);
});

test("PAD_MASTER_PROVIDER: the footprint's own SMD pad for Add Pad, KiCad's defaults for an unused type", () => {
  const doc = fpDoc();
  const m = PT.masterPad(doc, "auto", null);
  assert.equal(m[2], "smd"); assert.deepEqual(K.kid(m, "size").slice(1), [0.8, 0.95]); assert.equal(K.kid(m, "uuid"), null);
  const tht = PT.masterPad(doc, "tht", null);
  assert.deepEqual(tht.slice(0, 4), ["pad", "", "thru_hole", "oval"]); assert.deepEqual(K.kid(tht, "drill"), ["drill", 0.8]);
  const npth = PT.masterPad(doc, "npth", null); assert.equal(npth[2], "np_thru_hole"); assert.equal(PT.canHaveNumber(npth), false);
  assert.equal(PT.typeFromPad(PT.defaultPad("paste")), "paste");
  assert.equal(PT.ipcRoundingRatio(2, 1), 0.25); assert.equal(PT.ipcRoundingRatio(0.4, 0.4), 0.25);
});

test("PlacePad: one 'Place pad' step per click, numbered 3, 4, … and rotated by R", () => {
  const doc = fpDoc(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("pad", ctx); assert.ok(P.state.padPlace);
  PT.placePad(ctx, "auto", [2, 0], 0); PT.placePad(ctx, "auto", [3, 0], 90);
  assert.equal(log.commits.length, 2); assert.deepEqual(log.commits.map((c) => c.label), ["Place pad", "Place pad"]);
  const ps = pads(doc).map((i) => i.node); assert.equal(ps.length, 4);
  const p3 = ps.find((p) => p[1] === "3"), p4 = ps.find((p) => p[1] === "4");
  assert.ok(p3 && p4); assert.deepEqual(K.kid(p3, "at").slice(1), [2, 0]); assert.deepEqual(K.kid(p4, "at").slice(1), [3, 0, 90]);
  assert.ok(K.kid(p3, "uuid"), "a placed pad has a uuid");
  // written back: the new pads go in the pads section, and the unedited children keep their text
  const out = K.footprintDoc.serializeFootprintDoc(doc);
  assert.ok(/\(pad "3" smd roundrect/.test(out)); assert.ok(out.indexOf('(pad "2"') < out.indexOf('(pad "3"'));
});

test("Duplicate and Increment: the copy takes the next free number; fields are not duplicated", () => {
  const doc = fpDoc();
  const pid = [...doc.items.values()].find((i) => i.kind === "pad" && i.node[1] === "2").id;
  const fid = [...doc.items.values()].find((i) => i.kind === "property").id;
  const r = P.duplicateChanges(doc, [pid, fid], null, { increment: true });
  assert.equal(r.changes.length, 1);
  for (const c of r.changes) K.applyChange(doc, c, IU);
  assert.deepEqual(pads(doc).map((i) => i.node[1]).sort(), ["1", "2", "3"]);
  const plain = P.duplicateChanges(doc, [pid], null, null); for (const c of plain.changes) K.applyChange(doc, c, IU);
  assert.equal(pads(doc).filter((i) => i.node[1] === "2").length, 2, "plain Duplicate keeps the number");
});

test("Place the Footprint Anchor: every child moves so the point becomes the origin", () => {
  const doc = fpDoc();
  const ch = PT.moveAnchorChanges(doc, [-0.825, 0]);
  assert.equal(ch.length, doc.items.size);
  for (const c of ch) K.applyChange(doc, c, IU);
  const p1 = pads(doc).find((i) => i.node[1] === "1").node; assert.deepEqual(K.kid(p1, "at").slice(1), [0, 0]);
  const p2 = pads(doc).find((i) => i.node[1] === "2").node; assert.deepEqual(K.kid(p2, "at").slice(1), [1.65, 0]);
  assert.deepEqual(PT.moveAnchorChanges(doc, [0, 0]), []);
});

test("pads rotate, flip and mirror with their own geometry", () => {
  const pad = ["pad", "1", "thru_hole", "oval", ["at", 1, 0], ["size", 2, 1], ["drill", 0.8, ["offset", 0.2, 0.1]], ["layers", "*.Cu", "F.Mask"]];
  const r = K.cloneNode(pad); P.rotateNode(r, 0, 0, 90); assert.equal(K.kid(r, "at")[3], 90);
  const m = K.cloneNode(pad); P.mirrorNode(m, 0, 0, "h"); assert.equal(K.kid(m, "at")[1], -1); assert.equal(K.kid(K.kid(m, "drill"), "offset")[1], -0.2);
  const f = K.cloneNode(pad); P.flipNode(f, 0, { copper: ["F.Cu", "B.Cu"] }); assert.deepEqual(K.kid(f, "layers").slice(1), ["*.Cu", "B.Mask"]);
});

const BOARD_FP = ["footprint", "Lib:R_0603", ["layer", "B.Cu"], ["uuid", "fp-board"], ["at", 50, 40, 90], ["locked", "yes"],
  ["property", "Reference", "R7", ["at", 50, 38.57, 90], ["layer", "B.SilkS"], ["uuid", "ref-board"], ["effects", ["font", ["size", 1, 1]], ["justify", "mirror"]]],
  ["property", "Value", "10k", ["at", 50, 41.43, 90], ["layer", "B.Fab"], ["uuid", "val-board"], ["effects", ["font", ["size", 1, 1]], ["justify", "mirror"]]],
  ["pad", "1", "smd", "roundrect", ["at", 50, 40.825, 90], ["size", 0.8, 0.95], ["layers", "B.Cu", "B.Mask", "B.Paste"], ["net", "GND"], ["pinfunction", "A"], ["uuid", "pad1-board"]],
  ["pad", "2", "smd", "roundrect", ["at", 50, 39.175, 90], ["size", 0.8, 0.95], ["layers", "B.Cu", "B.Mask", "B.Paste"], ["net", "/SIG"], ["uuid", "pad2-board"]]];

test("editableCopy: fresh uuids mapped back, unlocked, no nets, at the origin on the front at 0°", () => {
  const e = X.editableCopy(BOARD_FP, 20241229);
  assert.equal(e.link, "fp-board"); assert.equal(e.reference, "R7");
  const n = e.node;
  assert.deepEqual(K.atOf(n), [0, 0, 0]); assert.equal(K.kid(n, "layer")[1], "F.Cu"); assert.equal(K.kid(n, "locked"), null);
  const ps = K.kids(n, "pad"); assert.ok(ps.every((p) => !K.kid(p, "net")));
  assert.ok(ps.every((p) => K.kid(p, "layers").slice(1).includes("F.Cu")));
  const u = K.kid(ps[0], "uuid")[1]; assert.notEqual(u, "pad1-board"); assert.equal(e.uuidMap[u], "pad1-board");
});

test("ExchangeFootprint: the edited copy goes back in place, keeping side, angle, lock, uuids, reference and nets", () => {
  const e = X.editableCopy(BOARD_FP, 20241229);
  // the user widens pad 2 in the editor
  K.kid(K.kids(e.node, "pad")[1], "size")[1] = 1.2;
  const back = X.boardCopyFromEditor(e.node, e.uuidMap);
  const { node } = X.exchangeFootprint(BOARD_FP, back);
  assert.equal(K.kid(node, "uuid")[1], "fp-board"); assert.equal(K.kid(node, "layer")[1], "B.Cu");
  const [x, y, a] = K.atOf(node); assert.ok(Math.abs(x - 50) < 1e-6 && Math.abs(y - 40) < 1e-6); assert.equal(((a % 360) + 360) % 360, 90);
  assert.ok(K.kid(node, "locked"));
  const ps = K.kids(node, "pad");
  const p1 = ps.find((p) => p[1] === "1"), p2 = ps.find((p) => p[1] === "2");
  assert.equal(K.kid(p1, "uuid")[1], "pad1-board"); assert.deepEqual(K.kid(p1, "net"), ["net", "GND"]); assert.deepEqual(K.kid(p1, "pinfunction"), ["pinfunction", "A"]);
  assert.deepEqual(K.kid(p2, "net"), ["net", "/SIG"]); assert.equal(K.kid(p2, "size")[1], 1.2);
  const near = (p, q) => Math.abs(K.kid(p, "at")[1] - K.kid(q, "at")[1]) < 1e-6 && Math.abs(K.kid(p, "at")[2] - K.kid(q, "at")[2]) < 1e-6;
  assert.ok(near(p1, BOARD_FP[8]), "pad 1 lands where it was");
  assert.equal(K.kids(node, "property").find((p) => p[1] === "Reference")[2], "R7");
  assert.equal(K.kids(node, "property").find((p) => p[1] === "Value")[2], "10k");
});
