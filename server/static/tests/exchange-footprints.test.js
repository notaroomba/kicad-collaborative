// exchange-footprints.test.js — BOARD::ExchangeFootprint with DIALOG_EXCHANGE_FOOTPRINTS' options and the dialog's
// processMatchingFootprints (web/tools/pcb-tools/exchange.ts: exchangeFootprint, planExchange, wildCompare).
// Run: node server/static/tests/exchange-footprints.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, X = globalThis.PcbTools.exchange;

const BOARD = () => K.parse(`(footprint "Lib:R_0603" (layer "F.Cu") (uuid "fp-1") (at 50 40 0)
  (property "Reference" "R7" (at 0 -2 0) (layer "F.SilkS") (uuid "ref-1") (effects (font (size 1.5 1.5) (thickness 0.2))))
  (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (hide yes) (uuid "val-1") (effects (font (size 1 1) (thickness 0.15))))
  (property "MPN" "RC0603" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "mpn-1") (effects (font (size 1 1) (thickness 0.15))))
  (path "/abc") (sheetname "/") (sheetfile "a.kicad_sch")
  (clearance 0.3)
  (attr smd exclude_from_bom)
  (fp_text user "\${REFERENCE}" (at 0 0.5 0) (layer "F.Fab") (uuid "txt-1") (effects (font (size 0.8 0.8) (thickness 0.1))))
  (fp_text user "extra" (at 3 3 0) (layer "F.SilkS") (uuid "txt-2") (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "ln-1"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "GND") (solder_mask_margin 0.05) (uuid "pad-1"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "/SIG") (uuid "pad-2"))
  (model "\${KICAD10_3DMODEL_DIR}/old.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`);
const LIB = () => K.parse(`(footprint "Lib:R_0603" (layer "F.Cu") (uuid "n-fp") (at 0 0)
  (property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (uuid "n-ref") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R_0603" (at 0 1.43 0) (layer "F.Fab") (uuid "n-val") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (uuid "n-txt") (effects (font (size 0.6 0.6) (thickness 0.09))))
  (fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "n-ln"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "n-p1"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "n-p2"))
  (model "\${KICAD10_3DMODEL_DIR}/new.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`);
const prop = (n, name) => K.kids(n, "property").find((p) => p[1] === name);
const texts = (n) => K.kids(n, "fp_text");
const UPDATE = { deleteExtraTexts: false, resetTextLayers: false, resetTextEffects: false, resetTextPositions: false, resetTextContent: false, resetFabricationAttrs: false, resetClearanceOverrides: true, reset3DModels: true, resetTransform: false, matchPadPositions: true };

test("defaults (every reset): the library's texts, attributes, clearances and model; the board's reference, value, nets, uuids", () => {
  const { node, updated } = X.exchangeFootprint(BOARD(), LIB());
  assert.equal(K.kid(node, "uuid")[1], "fp-1");
  assert.equal(prop(node, "Reference")[2], "R7"); assert.equal(K.kid(prop(node, "Reference"), "uuid")[1], "ref-1");
  assert.deepEqual(K.kid(prop(node, "Reference"), "at").slice(1, 3), [0, -1.43], "reset position: the library's");
  assert.equal(prop(node, "Value")[2], "10k"); assert.equal(K.kid(prop(node, "Value"), "hide"), null, "reset visibility: the library's");
  assert.equal(prop(node, "MPN"), undefined, "Remove text items: the extra field is gone");
  assert.equal(texts(node).length, 1, "the extra user text is gone"); assert.equal(K.kid(texts(node)[0], "uuid")[1], "txt-1", "the matched text keeps its uuid");
  assert.deepEqual(K.kid(node, "attr").slice(1), ["smd"]); assert.equal(K.kid(node, "clearance"), null);
  assert.match(K.serialize(K.kid(node, "model")), /new\.wrl/);
  assert.equal(K.kid(K.kids(node, "pad")[0], "solder_mask_margin"), null);
  assert.deepEqual(K.kid(K.kids(node, "pad")[0], "net"), ["net", "GND"]);
  assert.equal(K.kid(node, "path")[1], "/abc", "the schematic link stays");
  assert.equal(K.kid(K.kids(node, "fp_line")[0], "uuid")[1], "ln-1");
  assert.equal(updated, true);
});

test("update mode options: text layers, sizes, positions, content, extra texts, fabrication attrs, clearances and 3D models kept", () => {
  const { node } = X.exchangeFootprint(BOARD(), LIB(), Object.assign({}, UPDATE, { resetClearanceOverrides: false, reset3DModels: false }));
  const ref = prop(node, "Reference");
  assert.deepEqual(K.kid(ref, "at").slice(1, 3), [0, -2]); assert.equal(K.kid(K.kid(K.kid(ref, "effects"), "font"), "size")[1], 1.5);
  assert.ok(K.kid(prop(node, "Value"), "hide"), "the value stays hidden");
  assert.equal(prop(node, "MPN")[2], "RC0603", "the extra field is carried over"); assert.notEqual(K.kid(prop(node, "MPN"), "uuid")[1], "mpn-1", "with a fresh uuid");
  assert.equal(texts(node).length, 2); assert.ok(texts(node).some((t) => t[2] === "extra" && K.kid(t, "uuid")[1] === "txt-2"));
  const r = texts(node).find((t) => t[2] === "${REFERENCE}"); assert.deepEqual(K.kid(r, "at").slice(1, 3), [0, 0.5]);
  assert.deepEqual(K.kid(node, "attr").slice(1), ["smd", "exclude_from_bom"]);
  assert.equal(K.kid(node, "clearance")[1], 0.3); assert.equal(K.kid(K.kids(node, "pad")[0], "solder_mask_margin")[1], 0.05);
  assert.match(K.serialize(K.kid(node, "model")), /old\.wrl/);
});

test("no changes: an update from an identical library footprint reports '(no changes)'", () => {
  const b = BOARD();
  const plan = X.planExchange([{ id: "fp-1", node: b }], { updateMode: true, match: () => true, opts: { deleteExtraTexts: false, resetTextLayers: false, resetTextEffects: false, resetTextPositions: false, resetTextContent: false, resetFabricationAttrs: false, resetClearanceOverrides: false, reset3DModels: false },
    library: () => { const n = K.cloneNode(b); return n; } });
  assert.equal(plan.report.length, 1); assert.equal(plan.report[0].severity, "info");
  assert.equal(plan.report[0].text, "Updated footprint R7 (Lib:R_0603): : (no changes)");
  assert.equal(plan.modified.length, 0);
});

test("planExchange: change mode, the matching footprints from the last, missing library footprint, invalid id", () => {
  const a = BOARD(), b = BOARD(); K.kid(b, "uuid")[1] = "fp-2"; prop(b, "Reference")[2] = "C3";
  const fps = [{ id: "fp-1", node: a }, { id: "fp-2", node: b }];
  const match = (fp) => X.wildCompare("R*", prop(fp, "Reference")[2]);
  const plan = X.planExchange(fps, { updateMode: false, newFpid: "Lib:R_0805", match, opts: {}, library: (id) => { const n = LIB(); n[1] = id; return n; } });
  assert.deepEqual(plan.ids, ["fp-1"]); assert.equal(plan.modified[0][1][1], "Lib:R_0805");
  assert.equal(plan.report[0].text, "Changed footprint R7 from 'Lib:R_0603' to 'Lib:R_0805': : OK"); assert.equal(plan.report[0].severity, "action");
  const miss = X.planExchange(fps, { updateMode: true, match: () => true, opts: {}, library: () => null });
  assert.deepEqual(miss.report.map((l) => l.text), ["Updated footprint C3 (Lib:R_0603): *** library footprint not found ***", "Updated footprint R7 (Lib:R_0603): *** library footprint not found ***"]);
  assert.equal(X.planExchange(fps, { updateMode: false, newFpid: "Lib:", match: () => true, opts: {}, library: LIB }).report.length, 0);
});

test("WildCompareString: * and ?, case-insensitive", () => {
  assert.ok(X.wildCompare("r*", "R12")); assert.ok(X.wildCompare("R?", "r1")); assert.ok(!X.wildCompare("R?", "R12")); assert.ok(X.wildCompare("U1.2", "u1.2")); assert.ok(!X.wildCompare("U1.2", "U1x2"));
});

test("reset scale off keeps the board footprint's transform scale", () => {
  const b = BOARD(); const at = K.kid(b, "at"); b.splice(b.indexOf(at), 1, ["transform", ["translate", 50, 40], ["rotate", 0], ["scale", 2, 2]]);
  const keep = X.exchangeFootprint(b, LIB(), { resetTransform: false }).node; assert.deepEqual(K.kid(K.kid(keep, "transform"), "scale").slice(1), [2, 2]);
  const reset = X.exchangeFootprint(b, LIB(), { resetTransform: true }).node; assert.equal(K.kid(reset, "transform"), null);
});
