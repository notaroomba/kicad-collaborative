// fpedit-doc.test.js — the Footprint Editor's document (web/canvas/footprint-doc.ts) under node: a .kicad_mod's
// children as items, byte-exact write-back of an unedited file, KiCad's Prettify, edits written in format(FOOTPRINT)
// order, the header op, and every .kicad_mod in the repository round-tripping.
// Run: node server/static/tests/fpedit-doc.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas, F = K.footprintDoc;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("footprint editor document under node");

const REPO = path.join(__dirname, "..", "..", "..");
function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "build") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".kicad_mod")) out.push(p);
  }
  return out;
}
const FILES = walk(REPO, []);
const SAMPLE = `(footprint "R_0603"
	(version 20241229)
	(generator "pcbnew")
	(generator_version "9.0")
	(layer "F.Cu")
	(descr "Resistor SMD 0603")
	(tags "resistor")
	(property "Reference" "REF**"
		(at 0 -1.43 0)
		(layer "F.SilkS")
		(uuid "11111111-1111-4111-8111-111111111111")
		(effects
			(font
				(size 1 1)
				(thickness 0.15)
			)
		)
	)
	(property "Value" "R_0603"
		(at 0 1.43 0)
		(layer "F.Fab")
		(uuid "22222222-2222-4222-8222-222222222222")
		(effects
			(font
				(size 1 1)
				(thickness 0.15)
			)
		)
	)
	(attr smd)
	(fp_line
		(start -0.8 -0.4)
		(end 0.8 -0.4)
		(stroke
			(width 0.1)
			(type solid)
		)
		(layer "F.Fab")
	)
	(fp_text user "\${REFERENCE}"
		(at 0 0 0)
		(layer "F.Fab")
		(uuid "33333333-3333-4333-8333-333333333333")
		(effects
			(font
				(size 0.4 0.4)
				(thickness 0.06)
			)
		)
	)
	(pad "1" smd roundrect
		(at -0.825 0)
		(size 0.8 0.95)
		(layers "F.Cu" "F.Mask" "F.Paste")
		(roundrect_rratio 0.25)
		(uuid "44444444-4444-4444-8444-444444444444")
	)
	(pad "2" smd roundrect
		(at 0.825 0)
		(size 0.8 0.95)
		(layers "F.Cu" "F.Mask" "F.Paste")
		(roundrect_rratio 0.25)
		(uuid "55555555-5555-4555-8555-555555555555")
	)
	(embedded_fonts no)
	(model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl"
		(offset
			(xyz 0 0 0)
		)
		(scale
			(xyz 1 1 1)
		)
		(rotate
			(xyz 0 0 0)
		)
	)
)
`;

test("the children become items with board kinds; the header keeps the rest", () => {
  const d = K.parseDoc(SAMPLE, "footprint");
  assert.ok(d.fpEditor);
  const kinds = [...d.items.values()].map((it) => it.kind).sort();
  assert.deepEqual(kinds, ["gr_line", "gr_text", "pad", "pad", "property", "property"]);
  assert.equal(F.footprintName(d), "R_0603");
  assert.ok(K.kid(d.fpState.fp, "model") && K.kid(d.fpState.fp, "attr") && K.kid(d.fpState.fp, "descr"));
  assert.equal(d.version, 20241229);
  const pad = d.items.get("44444444-4444-4444-8444-444444444444"); assert.ok(pad.bbox && pad.geom.length);
  const ref = d.items.get("11111111-1111-4111-8111-111111111111"); assert.ok(ref.geom.some((g) => g.t === "text" && g.text === "REF**"));
  const txt = d.items.get("33333333-3333-4333-8333-333333333333"); assert.ok(txt.geom.some((g) => g.text === "REF**"), "${REFERENCE} shows the reference");
  assert.ok(d.layers.has("F.Cu") && d.layers.has("In1.Cu") && d.layers.has("F.CrtYd"));
});
test("an unedited document writes back byte for byte", () => {
  const d = K.parseDoc(SAMPLE, "footprint"); assert.equal(F.footprintModified(d), false); assert.equal(F.serializeFootprintDoc(d), SAMPLE);
});
test("Prettify of the compact form is the file KiCad wrote", () => {
  const tree = K.parse(SAMPLE); assert.equal(F.prettify(K.serialize(tree)), SAMPLE);
});
test("a child without a uuid gets the same derived id on every client and none in the file until edited", () => {
  const a = K.parseDoc(SAMPLE, "footprint"), b = K.parseDoc(SAMPLE, "footprint");
  const la = [...a.items.values()].find((it) => it.kind === "gr_line"), lb = [...b.items.values()].find((it) => it.kind === "gr_line");
  assert.equal(la.id, lb.id); assert.match(la.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // edit a pad: the line stays as it was (no uuid)
  const pad = a.items.get("55555555-5555-4555-8555-555555555555");
  K.kid(pad.node, "at")[1] = 1;
  const ch = K.replaceChange(a, pad); assert.equal(ch.typeName, "PAD");
  assert.ok(K.applyChange(b, ch, 1e6));
  const out = F.serializeFootprintDoc(b);
  assert.ok(out.includes("(at 1 0)")); assert.ok(!out.includes(la.id), "unedited child keeps no uuid");
  assert.equal(out.split("\n").length, SAMPLE.split("\n").length);
  assert.ok(/\(fp_line\n\t\t\(start -0\.8 -0\.4\)/.test(out));
  // the line edited: now it carries its id
  K.kid(la.node, "start")[1] = -0.9; const lc = K.replaceChange(a, la); K.applyChange(b, lc, 1e6);
  const out2 = F.serializeFootprintDoc(b); assert.ok(out2.includes(la.id)); assert.ok(out2.includes("(fp_line"));
  assert.ok(out2.includes('(fp_text user "${REFERENCE}"'));
});
test("new items land in their format(FOOTPRINT) section; the version never changes", () => {
  const d = K.parseDoc(SAMPLE, "footprint");
  const pad = K.parse(`(pad "3" smd rect (at 0 2) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "66666666-6666-4666-8666-666666666666"))`);
  K.applyChange(d, { id: "66666666-6666-4666-8666-666666666666", kind: "ADDED", typeName: "PAD", sexpr: K.serializeItem(d, { kind: "pad", node: pad }) }, 1e6);
  const line = K.parse(`(gr_line (start 0 0) (end 1 1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "77777777-7777-4777-8777-777777777777"))`);
  K.applyChange(d, { id: "77777777-7777-4777-8777-777777777777", kind: "ADDED", typeName: "PCB_SHAPE", sexpr: K.serializeItem(d, { kind: "gr_line", node: line }) }, 1e6);
  const out = F.serializeFootprintDoc(d);
  const iPad2 = out.indexOf('(pad "2"'), iPad3 = out.indexOf('(pad "3"'), iLine = out.indexOf("77777777"), iPad1 = out.indexOf('(pad "1"'), iModel = out.indexOf("(model");
  assert.ok(iLine < iPad1, "drawings before pads"); assert.ok(iPad2 < iPad3 && iPad3 < iModel, "new pad after the pads, before the model");
  assert.ok(out.includes("(version 20241229)"));
  assert.ok(!/gr_line/.test(out), "written as fp_line");
  // and the written file reads back to the same items
  const back = K.parseDoc(out, "footprint"); assert.equal(back.items.size, d.items.size); assert.equal(F.serializeFootprintDoc(back), out);
});
test("the header travels as id 'footprint' and a removed item leaves the file", () => {
  const d = K.parseDoc(SAMPLE, "footprint");
  const hdr = K.parse(F.footprintHeaderSexpr(d)); K.kid(hdr, "descr")[1] = "changed";
  assert.ok(K.applyChange(d, { id: "footprint", kind: "MODIFIED", typeName: "FOOTPRINT", sexpr: K.serialize(hdr) }, 1e6));
  K.applyChange(d, { id: "55555555-5555-4555-8555-555555555555", kind: "REMOVED", typeName: "PAD" }, 1e6);
  const out = F.serializeFootprintDoc(d);
  assert.ok(out.includes('(descr "changed")')); assert.ok(!out.includes('(pad "2"'));
  F.markFootprintSaved(d, out); assert.equal(F.footprintModified(d), false); assert.equal(F.serializeFootprintDoc(d), out);
});
test(`every .kicad_mod in the repository round-trips (${FILES.length} files)`, () => {
  assert.ok(FILES.length > 10);
  let pretty = 0;
  for (const f of FILES) {
    const text = fs.readFileSync(f, "utf8");
    let d; try { d = K.parseDoc(text, "footprint"); } catch (e) { throw new Error(path.relative(REPO, f) + ": " + e.message); }
    assert.equal(F.footprintModified(d), false, path.relative(REPO, f) + " reads as modified");
    assert.equal(F.serializeFootprintDoc(d), text, path.relative(REPO, f));
    // a file pcbnew wrote (tabs) is what Prettify makes of its compact form, and the children-by-children rebuild agrees
    if (/^\(footprint [^\n]*\n\t\(version/.test(text)) {
      const tree = K.parse(text);
      if (F.prettify(K.serialize(tree)) === text) pretty++;
    }
    // an edit-free re-emission through the item path reads back to the same items
    const it = [...d.items.values()][0]; if (!it) continue;
    const before = F.serializeFootprintDoc(d);
    K.applyChange(d, K.replaceChange(d, it), 1e6);
    const again = K.parseDoc(F.serializeFootprintDoc(d), "footprint");
    assert.equal(again.items.size, d.items.size, path.relative(REPO, f) + " item count after a no-op edit");
    void before;
  }
  console.log("       (" + pretty + " pcbnew-written files equal Prettify of their compact form)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
