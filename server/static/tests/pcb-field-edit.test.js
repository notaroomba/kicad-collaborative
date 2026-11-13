// pcb-field-edit.test.js — EDIT_TOOL's Rotate / Flip / Delete on a board footprint field (PCB_FIELD_T):
// PCB_TEXT::Rotate and ::Flip about the field's own position, DeleteItems hiding the field, and the field the
// hover selection takes (requestField).
// Run: node server/static/tests/pcb-field-edit.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, F = globalThis.PcbTools.fieldEdit;

const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (36 "B.SilkS" user) (49 "F.Fab" user) (48 "B.Fab" user))
  (footprint "Test:C" (layer "F.Cu") (uuid "fp-1") (at 100 50 180)
    (property "Reference" "C1" (at 12.5 -4.37 180) (layer "F.SilkS") (uuid "p-1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "100n" (at 0 1.5 90) (layer "F.Fab") (hide yes) (uuid "p-2") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0 180) (size 1 1.2) (layers "F.Cu") (uuid "pad-1")))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-2") (at 120 50)
    (property "Reference" "R1" (at 0 -1.5 0) (layer "F.SilkS") (uuid "p-3") (effects (font (size 1 1) (thickness 0.15)) (justify left)))
    (pad "1" smd rect (at 0 0) (size 1 1.2) (layers "F.Cu") (uuid "pad-2")))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const fpOf = (c) => K.kid(K.parse(c.sexpr), "footprint");
const field = (node, name) => K.serialize(F.footprintFieldNode(node, name));
const rest = (a, b, name) => { const strip = (n) => K.serialize(n.filter((c) => !(Array.isArray(c) && c[0] === "property" && K.str(c[1]) === name))); assert.equal(strip(a), strip(b)); };

test("rotate: angle + 90 normalised to [0, 360), position and everything else kept", () => {
  const d = doc(), it = d.items.get("fp-1");
  const ch = F.rotateFieldChange(d, { id: "fp-1", name: "Reference" }, 90);
  assert.equal(ch.kind, "MODIFIED");
  assert.match(field(fpOf(ch), "Reference"), /\(at 12\.5 -4\.37 270\)/);
  rest(fpOf(ch), it.node, "Reference");
  const ch2 = F.rotateFieldChange(d, { id: "fp-1", name: "Reference" }, 270);
  assert.match(field(fpOf(ch2), "Reference"), /\(at 12\.5 -4\.37 90\)/);
  const ch3 = F.rotateFieldChange(d, { id: "fp-1", name: "Reference" }, -90);
  assert.match(field(fpOf(ch3), "Reference"), /\(at 12\.5 -4\.37 90\)/);
});

test("flip: other side, mirrored, board angle 2*fpAngle - angle, position kept", () => {
  const d = doc();
  const ch = F.flipFieldChange(d, { id: "fp-1", name: "Reference" });
  const s = field(fpOf(ch), "Reference");
  assert.match(s, /\(at 12\.5 -4\.37 180\)/); assert.match(s, /\(layer "B\.SilkS"\)/); assert.match(s, /\(justify mirror\)/);
  rest(fpOf(ch), d.items.get("fp-1").node, "Reference");
  const ch2 = F.flipFieldChange(d, { id: "fp-2", name: "Reference" });
  const s2 = field(fpOf(ch2), "Reference");
  assert.match(s2, /\(layer "B\.SilkS"\)/); assert.match(s2, /\(justify left mirror\)/);
  // flipping back gives the original field
  const d2 = doc(); const it = d2.items.get("fp-2"); it.node = fpOf(ch2);
  const back = F.flipFieldChange(d2, { id: "fp-2", name: "Reference" });
  assert.equal(field(fpOf(back), "Reference"), field(doc().items.get("fp-2").node, "Reference"));
});

test("delete hides a visible field; a hidden one gives the infobar message", () => {
  const d = doc();
  const ch = F.hideFieldChanges(d, { id: "fp-1", name: "Reference" });
  assert.equal(ch.length, 1); assert.equal(ch.hideLabel, "Hide Field");
  assert.match(field(fpOf(ch[0]), "Reference"), /\(hide yes\)/);
  rest(fpOf(ch[0]), d.items.get("fp-1").node, "Reference");
  const no = F.hideFieldChanges(d, { id: "fp-1", name: "Value" });
  assert.equal(no.length, 0); assert.equal(no.infoError, "Use the Footprint Properties dialog to remove fields.");
});

test("requestField: the selected field, else the hover field when nothing else is under the cursor", () => {
  const d = doc(); const S = globalThis.PcbTools.state; S.sel.clear(); S.padSel = null;
  const base = { doc: d, selection: new Set(), commit() {}, toast() {}, requestRender() {} };
  assert.deepEqual(F.requestField(Object.assign({}, base, { selectedField: () => ({ id: "fp-2", name: "Reference" }) }), [0, 0]), { id: "fp-2", name: "Reference", hover: false });
  const hover = Object.assign({}, base, { selectedField: () => null, fieldAt: () => ({ id: "fp-1", name: "Reference" }) });
  assert.deepEqual(F.requestField(Object.assign({}, hover, { candidatesAt: () => ["fp-1"] }), [1, 1]), { id: "fp-1", name: "Reference", hover: true });
  assert.equal(F.requestField(Object.assign({}, hover, { candidatesAt: () => ["track-9"] }), [1, 1]), null);
  assert.equal(F.requestField(Object.assign({}, hover, { fieldAt: () => null }), [1, 1]), null);
  S.sel.add("fp-2"); assert.equal(F.requestField(hover, [1, 1]), null); S.sel.clear();
});
