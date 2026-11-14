// sch-text-outline.test.js — schematic text colours and text set in an outline (TrueType) face.
//  - SCH_PAINTER::getRenderColor: a text's colour is (effects (font (color r g b a))), for every text kind (text,
//    text box, table cell, labels and their shapes, symbol / sheet / label fields, sheet pins, symbol body text, the
//    Symbol Editor); 0 0 0 0 is unspecified (the layer colour); a label's own colour beats the bus colour.
//  - OUTLINE_FONT layout (outline-text.ts): em 1.4 x height, getLinePositions, SCH_TEXT::GetOffsetToMatchSCH_FIELD,
//    EDA_TEXT::GetTextBox from the face's ascender / descender (hit test and item box), fields centred on their box,
//    no synthetic bold, the 12 degree slant, and the selection halo drawn from the very same glyph layout.
// Run: node server/static/tests/sch-text-outline.test.js
"use strict";
const assert = require("assert");
const path = require("path");

// ---- a page with a canvas that knows one face, "Test Face" (0.6 em advances), so faceAvailable says yes
function fakeCtx(log) {
  const st = { font: "10px sans-serif", lineWidth: 1, fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1 };
  let m = [1, 0, 0, 1, 0, 0]; const stack = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const xf = { setTransform: (...a) => { m = a.slice(0, 6); }, transform: (...a) => { m = mul(m, a); }, translate: (x, y) => { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale: (x, y) => { m = mul(m, [x, 0, 0, y, 0, 0]); }, rotate: (r) => { const c = Math.cos(r), s = Math.sin(r); m = mul(m, [c, s, -s, c, 0, 0]); },
    save: () => { stack.push([m.slice(), Object.assign({}, st)]); }, restore: () => { const p = stack.pop(); if (p) { m = p[0]; Object.assign(st, p[1]); } } };
  const px = () => { const m = /([\d.]+)px/.exec(st.font); return m ? +m[1] : 10; };
  const ctx = new Proxy(st, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (s) => ({ width: [...String(s)].length * px() * (/Test Face/.test(t.font) ? 0.6 : 0.5), fontBoundingBoxAscent: px() * 0.8, fontBoundingBoxDescent: px() * 0.2 });
      if (k === "getTransform") return () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
      if (k in xf) return (...a) => { xf[k](...a); if (log) log.push([k, ...a]); };
      if (k === "canvas") return { width: 400, height: 300 };
      return (...a) => { if (log) log.push([k, ...a, k === "fillText" || k === "strokeText" ? { font: t.font, lineWidth: t.lineWidth, fill: t.fillStyle, stroke: t.strokeStyle, m: m.map((v) => +v.toFixed(9)) } : undefined]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return ctx;
}
globalThis.document = { createElement: () => ({ getContext: () => fakeCtx(null) }) };
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
K.textMode = "native";
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), `${msg || ""} ${a} != ${b}`);
const rgb = (c) => { let m = /^#([0-9a-f]{6})$/i.exec(c); if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, 1]; } m = /rgba?\(([^)]+)\)/.exec(c); const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
const same = (c, want, msg) => assert.deepStrictEqual(rgb(c), want, msg);
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const FONT = (extra) => `(effects (font (size 1.27 1.27) ${extra || ""}))`;
const RED = "(color 255 0 0 1)";
const doc = (body) => K.parseDoc(HEAD + body + ")");
const item = (d, kind) => [...d.items.values()].find((it) => it.kind === kind);
const texts = (it) => it.geom.filter((g) => g.t === "text");

// ---------------------------------------------------------------- colours
test("a text's own colour is (effects (font (color …))): text, text box, labels, flags", () => {
  const d = doc(`(text "T" (at 10 10 0) ${FONT(RED)} (uuid "t1"))
    (text_box "B" (at 20 20 0) (size 10 5) (stroke (width 0) (type default)) (fill (type none)) ${FONT(RED)} (uuid "b1"))
    (label "L" (at 30 30 0) ${FONT(RED)} (uuid "l1"))
    (global_label "G" (shape input) (at 40 40 0) ${FONT(RED)} (uuid "g1"))
    (hierarchical_label "H" (shape input) (at 50 50 0) ${FONT(RED)} (uuid "h1"))
    (netclass_flag "" (length 2.54) (shape round) (at 60 60 0) ${FONT(RED)} (uuid "n1"))`);
  for (const k of ["text", "text_box", "label", "global_label", "hierarchical_label"]) same(texts(item(d, k))[0].color, [255, 0, 0, 1], k);
  // the label shapes take it too (SCH_PAINTER draws them with the same getRenderColor)
  for (const k of ["global_label", "hierarchical_label", "netclass_flag"]) for (const g of item(d, k).geom.filter((g) => g.t !== "text" && g.layer === "Labels")) same(g.color, [255, 0, 0, 1], k + " shape");
});

test("(color 0 0 0 0) is unspecified and a text without colour keeps its layer colour; opaque black stays black", () => {
  const d = doc(`(text "U" (at 10 10 0) ${FONT("(color 0 0 0 0)")} (uuid "t1")) (text "K" (at 20 10 0) ${FONT("(color 0 0 0 1)")} (uuid "t2")) (text "N" (at 30 10 0) ${FONT()} (uuid "t3"))`);
  const by = (id) => texts(d.items.get(id))[0].color;
  same(by("t1"), rgb(K.SCH.notes)); same(by("t3"), rgb(K.SCH.notes)); same(by("t2"), [0, 0, 0, 1]);
  assert.strictEqual(K.effectsOf(K.parse('(text "x" (effects (font (color 0 0 0 0))))')).color, undefined);
  assert.strictEqual(K.fieldColor({}, "#123456"), "#123456");
});

test("a zero alpha on any other colour is the text's own (transparent: KiCad draws no glyphs), not the layer colour", () => {
  assert.strictEqual(K.effectsOf(K.parse('(text "x" (effects (font (color 255 0 0 0))))')).color, "rgba(255,0,0,0)");
  const d = doc(`(text "T" (at 10 10 0) ${FONT("(color 255 0 0 0)")} (uuid "t1")) (label "L" (at 30 30 0) ${FONT("(color 0 0 255 0)")} (uuid "l1"))
    (global_label "G" (shape input) (at 40 40 0) ${FONT("(color 0 0 0 0)")} (uuid "g1"))`);
  same(texts(d.items.get("t1"))[0].color, [255, 0, 0, 0]); same(texts(d.items.get("l1"))[0].color, [0, 0, 255, 0]);
  same(texts(d.items.get("g1"))[0].color, rgb(K.SCH.glabel), "0 0 0 0 alone is unspecified");
});

test("fields: symbol, sheet and label fields take their own colour (SCH_FIELD::GetFieldColor), hidden ones too", () => {
  const lib = `(lib_symbols (symbol "x:R" (symbol "R_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none))) (text "body" (at 0 0 0) ${FONT("(color 0 0 255 1)")}))))`;
  const d = doc(`${lib}
    (symbol (lib_id "x:R") (at 50 50 0) (unit 1) (uuid "s1")
      (property "Reference" "R1" (at 50 45 0) ${FONT(RED)})
      (property "Value" "10k" (at 50 55 0) ${FONT()})
      (property "Note" "n" (at 50 60 0) (effects (font (size 1.27 1.27) (color 0 255 0 1)) (hide yes))))
    (sheet (at 100 100) (size 20 20) (stroke (width 0) (type default)) (fill (color 0 0 0 0)) (uuid "sh1")
      (property "Sheetname" "S" (at 100 99 0) ${FONT(RED)}) (property "Sheetfile" "s.kicad_sch" (at 100 121 0) ${FONT()})
      (pin "P" input (at 120 105 0) ${FONT(RED)} (uuid "p1")))
    (label "L" (at 30 30 0) ${FONT()} (uuid "l1") (property "Netclass" "fast" (at 30 33 0) ${FONT(RED)}))`);
  const sym = d.items.get("s1"), ref = texts(sym).find((g) => g.field === "Reference"), val = texts(sym).find((g) => g.field === "Value");
  same(ref.color, [255, 0, 0, 1]); same(val.color, rgb(K.SCH.ref));
  same(texts(sym).find((g) => g.text === "body").color, [0, 0, 255, 1], "a symbol's own text keeps its colour (isSymbolChild)");
  const hid = (sym.hiddenGeom || []).find((g) => g.field === "Note"); same(hid.color, [0, 255, 0, 1], "a hidden field shown keeps its colour");
  const sh = d.items.get("sh1"); same(texts(sh).find((g) => g.text === "S").color, [255, 0, 0, 1]); same(texts(sh).find((g) => /File/.test(g.text)).color, rgb(K.SCH.sheetFile));
  for (const g of sh.geom.filter((g) => g.pinNo === "P")) same(g.color, [255, 0, 0, 1], "sheet pin " + g.t);
  same(texts(d.items.get("l1")).find((g) => g.field === "Netclass").color, [255, 0, 0, 1]);
});

test("table cells and the Symbol Editor read the font colour too", () => {
  const d = doc(`(table (column_count 1) (border (external yes) (header yes) (stroke (width 0.1) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid)))
    (column_widths 10) (row_heights 5) (cells (table_cell "C" (exclude_from_sim no) (at 10 10 0) (size 10 5) (margins 1 1 1 1) (span 1 1) (fill (type none)) ${FONT(RED)} (uuid "c1")))) `);
  same(texts(item(d, "table"))[0].color, [255, 0, 0, 1]);
  const sym = K.parse(`(symbol "R" (property "Reference" "R" (at 0 2 0) ${FONT(RED)}) (property "Value" "R" (at 0 -2 0) ${FONT()}) (symbol "R_0_1" (text "t" (at 0 0 0) ${FONT("(color 0 0 255 1)")}) (text "u" (at 0 1 0) ${FONT()})))`);
  const ld = K.parseLibSymbol(sym, {});
  const all = [...ld.items.values()].flatMap((it) => texts(it));
  same(all.find((g) => g.field === "Reference").color, [255, 0, 0, 1]); same(all.find((g) => g.text === "t").color, [0, 0, 255, 1]);
  same(all.find((g) => g.text === "u").color, rgb(K.SCH.outline));
});

test("a bus label with its own colour is not tinted in the bus colour (getRenderColor( LAYER_BUS ) keeps it)", () => {
  const d = doc(`(label "D[0..3]" (at 10 10 0) ${FONT(RED)} (uuid "l1")) (label "E[0..3]" (at 10 20 0) ${FONT()} (uuid "l2"))`);
  const g1 = texts(d.items.get("l1"))[0], g2 = texts(d.items.get("l2"))[0];
  assert.strictEqual(K.busPinTint(d.items.get("l1"), g1), false); assert.strictEqual(K.busPinTint(d.items.get("l2"), g2), true);
});

test("colours survive a round trip through the writer", () => {
  const src = `(text "QFP\\n" (exclude_from_sim no) (at 259.842 155.956 0) (effects (font (face "Blender Pro Bold") (size 10.16 10.16) (color 0 0 0 1))) (uuid "q1"))`;
  const d = doc(src); const out = K.serialize(d.items.get("q1").node);
  assert.ok(/\(color 0 0 0 1\)/.test(out) && /\(face "Blender Pro Bold"\)/.test(out), out);
});

// ---------------------------------------------------------------- an outline face, as a font file
/** A minimal TrueType file: head, hhea, OS/2, hmtx, cmap (format 4); 'A'..'Z' and ' ' map to glyphs of the given advance. */
function makeFont({ upm = 1000, asc = 800, desc = -200, adv = 600, typoAsc = 0, typoDesc = 0, useTypo = false } = {}) {
  const tables = {};
  const u16 = (v) => [(v >> 8) & 255, v & 255], i16 = (v) => u16(v & 0xffff), u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  tables.head = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0x5f0f3cf5), ...u16(0), ...u16(upm), ...new Array(36).fill(0)];
  tables.hhea = [...u32(0x10000), ...i16(asc), ...i16(desc), ...i16(0), ...new Array(24).fill(0), ...u16(28)];
  tables["OS/2"] = new Array(96).fill(0);
  tables["OS/2"].splice(62, 2, ...u16(useTypo ? 0x80 : 0)); tables["OS/2"].splice(68, 4, ...i16(typoAsc), ...i16(typoDesc));
  const hm = []; for (let g = 0; g < 28; g++) hm.push(...u16(g ? adv : 500), ...i16(0)); tables.hmtx = hm;
  // cmap: segments ' ' (gid 27), 'A'-'Z' (gid 1..26), 0xFFFF
  const segs = [[32, 32, 27 - 32], [65, 90, 1 - 65], [0xffff, 0xffff, 1]], n = segs.length;
  const sub = [...u16(4), ...u16(16 + 8 * n), ...u16(0), ...u16(2 * n), ...u16(0), ...u16(0), ...u16(0)];
  for (const s of segs) sub.push(...u16(s[1])); sub.push(...u16(0)); for (const s of segs) sub.push(...u16(s[0])); for (const s of segs) sub.push(...i16(s[2])); for (let i = 0; i < n; i++) sub.push(...u16(0));
  tables.cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];
  const names = Object.keys(tables).sort(); let off = 12 + 16 * names.length; const dir = [...u32(0x10000), ...u16(names.length), 0, 0, 0, 0, 0, 0], body = [];
  for (const nm of names) { const t = tables[nm]; while (t.length % 4) t.push(0); dir.push(...[...nm.padEnd(4)].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(off), ...u32(t.length)); body.push(...t); off += t.length; }
  return new Uint8Array([...dir, ...body]).buffer;
}

test("readSfnt: units per em, FreeType's ascender / descender and advance widths from the file", () => {
  const f = K.readSfnt(makeFont({ upm: 2048, asc: 1950, desc: -550, adv: 1200 }));
  assert.strictEqual(f.upm, 2048); assert.strictEqual(f.asc, 1950); assert.strictEqual(f.desc, -550);
  assert.strictEqual(f.advance("Q".codePointAt(0)), 1200); assert.strictEqual(f.advance(32), 1200);
});

test("readSfnt: OS/2 USE_TYPO_METRICS (fsSelection bit 7) makes FreeType take the typographic ascender / descender", () => {
  const o = { upm: 2048, asc: 1854, desc: -434, typoAsc: 1491, typoDesc: -431 };
  const plain = K.readSfnt(makeFont(o)), typo = K.readSfnt(makeFont(Object.assign({ useTypo: true }, o)));
  assert.deepStrictEqual([plain.asc, plain.desc], [1854, -434], "bit clear: hhea");
  assert.deepStrictEqual([typo.asc, typo.desc], [1491, -431], "bit set: sTypoAscender / sTypoDescender");
  const z = K.readSfnt(makeFont({ asc: 0, desc: 0, typoAsc: 700, typoDesc: -300 }));
  assert.deepStrictEqual([z.asc, z.desc], [700, -300], "hhea zero: the typographic ones");
});

const FACE = "Test Face";
K.setFontData(FACE, false, false, { data: makeFont(), bold: false, italic: false });
const M = K.kicadAscDesc({ asc: 0.8, desc: 0.2 });
const lineH = (s) => (M.asc + M.desc) * 1.4 * s;

test("SCH_TEXT in an outline face: getLinePositions baseline, the field-matching lift, a trailing \\n is no line", () => {
  const s = 10.16;
  const d = doc(`(text "QFP\\n" (at 100 50 0) (effects (font (face "${FACE}") (size ${s} ${s}) (color 0 0 0 1))) (uuid "q1"))`);
  const tg = texts(d.items.get("q1")); assert.strictEqual(tg.length, 1, "QFP\\n is one line"); assert.strictEqual(tg[0].text, "QFP");
  const L = K.outlineLayout(tg[0]);
  near(L.ox, 100); near(L.oy, 50 - 0.25, 1e-9, "the schematic text offset");
  near(L.width, 3 * 0.6 * 1.4 * s, 1e-6, "advance: 1.4 x height per em");
  near(L.x, -L.width / 2, 1e-9, "centred");
  // FONT::getLinePositions: size - 1.17 size / 2; GetOffsetToMatchSCH_FIELD: - 0.4 (box height - size)
  near(L.baseline, s - 1.17 * s / 2 - 0.4 * (lineH(s) - s), 1e-3, "baseline");
  // the box KiCad hit-tests (GetTextBox at the item position, without the text offset): centred on it
  near(L.box[1] - 0.25, -lineH(s) / 2, 1e-6); near(L.box[3] - L.box[1], lineH(s), 1e-6); near(L.box[2] - L.box[0], L.width, 1e-9);
  // the item's box and hit test follow the face's box, not the stroke font's
  const it = d.items.get("q1"); assert.ok(it.bbox[1] <= 50 - lineH(s) / 2 + 1e-6 && it.bbox[3] >= 50 + lineH(s) / 2 - 1e-6, JSON.stringify(it.bbox));
  assert.ok(K.geomHit(tg[0], 100, 50 - 0.45 * lineH(s), 0), "the top of the box hits"); assert.ok(!K.geomHit(tg[0], 100, 50 - 0.55 * lineH(s), 0));
  { const px = 100 + L.width * 0.45, py = 50 - 0.4 * lineH(s), b = it.bbox; assert.ok(px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3], "the item box (what the schematic editor picks texts by) holds the glyph top"); }
});

test("justification, the 0.17 fudge of a hung / stood box, line spacing 1.68 and every line placed in its block", () => {
  const s = 5;
  const d = doc(`(text "AB\\nC" (at 10 10 0) (effects (font (face "${FACE}") (size ${s} ${s})) (justify left top)) (uuid "a"))
    (text "AB" (at 10 40 0) (effects (font (face "${FACE}") (size ${s} ${s})) (justify right bottom)) (uuid "b"))`);
  const [l0, l1] = texts(d.items.get("a")).map((g) => K.outlineLayout(g));
  near(l1.baseline - l0.baseline, 1.68 * s, 1e-9, "interline"); near(l0.x, 0); near(l1.x, 0);
  const lift = 0.4 * (lineH(s) - s);
  near(l0.baseline, s - lift, 1e-3, "top: one height below the anchor");
  near(l0.box[1] - 0.25, -0.17 * lineH(s), 1e-6, "a top box starts 0.17 x its height above the position");
  const b = K.outlineLayout(texts(d.items.get("b"))[0]);
  near(b.x, -b.width, 1e-9); near(b.baseline, s - 1.17 * s - lift, 1e-3);
  near(b.box[3] - 0.25, 0.17 * lineH(s), 1e-6, "a bottom box ends 0.17 x its height below");
});

test("a field in an outline face is drawn centred on its text box (SCH_PAINTER::draw( SCH_FIELD ))", () => {
  const s = 2;
  const lib = '(lib_symbols (symbol "x:R" (symbol "R_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none))))))';
  const d = doc(`${lib} (symbol (lib_id "x:R") (at 50 50 0) (unit 1) (uuid "s1")
    (property "Reference" "AB" (at 50 45 0) (effects (font (face "${FACE}") (size ${s} ${s})) (justify left top))))`);
  const g = texts(d.items.get("s1")).find((x) => x.field === "Reference"); const L = K.outlineLayout(g);
  const cy = (L.box[1] + L.box[3]) / 2;
  near(L.baseline, cy + s - 1.17 * s / 2, 1e-9, "vertically centred on the box"); near(L.x, L.box[0], 1e-9);
  near(cy, -0.17 * lineH(s) + lineH(s) / 2, 1e-5);
});

test("a multi-line left / right field centres every line on its whole box (GetTextBox width = the widest line)", () => {
  const s = 2, em = 0.6 * 1.4 * s;
  const lib = '(lib_symbols (symbol "x:R" (symbol "R_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none))) (text "AB\\nABCDEF" (at 0 0 0) (effects (font (face "${FACE}") (size ${s} ${s})) (justify left))))))'.replace("${FACE}", FACE).replace(/\$\{s\}/g, s);
  for (const [just, x0] of [["left", 0], ["right", -6 * em]]) {
    const d = doc(`${lib} (symbol (lib_id "x:R") (at 50 50 0) (unit 1) (uuid "s1")
      (property "Value" "AB\\nABCDEF" (at 50 45 0) (effects (font (face "${FACE}") (size ${s} ${s})) (justify ${just}))))`);
    const [a, b] = texts(d.items.get("s1")).filter((x) => x.field === "Value").map((g) => K.outlineLayout(g));
    near(a.width, 2 * em, 1e-9); near(b.width, 6 * em, 1e-9);
    near(b.x, x0, 1e-9, just + ": the long line fills the box");
    near(a.x + a.width / 2, b.x + b.width / 2, 1e-9, just + ": the short line centred over it");
    near(a.box[0], a.x, 1e-9); near(a.box[2], a.x + a.width, 1e-9);
    // a symbol's own text keeps its justification line by line (SCH_PAINTER::draw( SCH_TEXT ) on LAYER_DEVICE)
    const [ta, tb] = texts(d.items.get("s1")).filter((x) => !x.field && x.text.startsWith("AB")).map((g) => K.outlineLayout(g));
    near(ta.x, tb.x, 1e-9, "symbol text: flush left");
  }
});

test("bold asked of a regular-only family is not synthesised; italic asked of an upright one is slanted 12 degrees", () => {
  const m = K.faceMetrics(FACE, true, true);
  assert.ok(!/bold|italic/.test(m.css), m.css); assert.strictEqual(m.slant, true);
  const r = K.faceMetrics(FACE, false, false); assert.strictEqual(r.slant, false);
  assert.strictEqual(K.faceMetrics("KiCad Font", false, false), null); assert.strictEqual(K.faceMetrics(undefined, false, false), null);
});

test("geometry built before the face arrived is laid out again once it does (ensureFontGeom)", () => {
  const d = doc(`(text "QFP" (at 100 50 0) (effects (font (face "Late Face") (size 10 10))) (uuid "q1"))`);
  const before = d.items.get("q1").bbox.slice();
  assert.strictEqual(K.outlineLayout(texts(d.items.get("q1"))[0]), null, "no metrics yet: the stroke font");
  K.setFontData("Late Face", false, false, { data: makeFont({ adv: 900 }), bold: false, italic: false });
  K.ensureFontGeom(d);
  const after = d.items.get("q1").bbox;
  near(after[2] - after[0], 3 * 0.9 * 1.4 * 10, 1e-6, "the face's own width"); assert.notDeepStrictEqual(after, before);
});

test("the selection halo is the drawn glyphs themselves: same face, size, transform and baseline, outline stroked", () => {
  const d = doc(`(text "QFP" (at 100 50 0) (effects (font (face "${FACE}") (size 10 10) (color 0 0 0 1))) (uuid "q1"))`);
  K.fontChanged(FACE);   // the fake page now has the face
  assert.ok(K.faceAvailable(FACE));
  const view = { ppm: 2, zoom: 1, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 };
  const drawLog = [], haloLog = [];
  K.render(d, fakeCtx(drawLog), view, { frame: false, grid: 0 });
  const g = texts(d.items.get("q1"))[0];
  const fill = (log) => { const i = log.findIndex((e) => e[0] === "fillText" && e[1] === "QFP"); assert.ok(i >= 0, "fillText QFP"); return { e: log[i], tf: log[i][4].m }; };
  const a = fill(drawLog);
  const hc = fakeCtx(haloLog); hc.setTransform(2, 0, 0, 2, 0, 0);   // the view render() drew under (ppm 2)
  K.drawHalo(hc, d, ["q1"], 2, 1, null, { color: "#00f", alpha: 1, extraPx: 3, strokesOnly: true });
  const b = fill(haloLog);
  assert.strictEqual(a.e[4].font, b.e[4].font, "same face and size");
  assert.ok(/Test Face/.test(a.e[4].font), a.e[4].font);
  assert.deepStrictEqual(b.e.slice(1, 4), a.e.slice(1, 4), "same position");
  assert.deepStrictEqual(b.tf, a.tf, "same transform");
  const st = haloLog.find((e) => e[0] === "strokeText" && e[1] === "QFP"); assert.ok(st && st[4].lineWidth > 0, "the glyph outlines stroked by the shadow width");
  assert.ok(!haloLog.some((e) => e[0] === "lineTo"), "no stroke-font copy");
  // and it sits on the glyphs: the anchor maps to the same device point in both
  const dev = (mm, x, y) => [mm[0] * x + mm[2] * y + mm[4], mm[1] * x + mm[3] * y + mm[5]];
  assert.deepStrictEqual(dev(b.tf, 0, 0), dev(a.tf, 0, 0));
  assert.ok(g.face === FACE);
});

console.log(`sch-text-outline: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
