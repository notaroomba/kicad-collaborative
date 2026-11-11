// node server/static/tests/themes.test.js — the schematic colour themes (web/canvas/colors.ts): KiCad's built-in
// palettes, the lazy geometry rebuild after a switch, and exports that stay in KiCad Default.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "11111111-1111-1111-1111-111111111111") (paper "A4")
  (wire (pts (xy 10 10) (xy 30 10)) (stroke (width 0) (type default)) (uuid "22222222-2222-2222-2222-222222222222"))
  (label "NET" (at 12 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "33333333-3333-3333-3333-333333333333"))
  (junction (at 30 10) (diameter 0) (color 0 0 0 0) (uuid "44444444-4444-4444-4444-444444444444")))`;
const wireColor = (doc) => doc.items.get("22222222-2222-2222-2222-222222222222").geom[0].color;
const labelColor = (doc) => doc.items.get("33333333-3333-3333-3333-333333333333").geom.find((g) => g.t === "text").color;
function stubCtx() {
  const ctx = { canvas: { width: 200, height: 100 }, fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "" };
  for (const n of ["setTransform", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash", "drawImage", "ellipse", "quadraticCurveTo", "bezierCurveTo", "clip"]) ctx[n] = () => {};
  ctx.measureText = (t) => ({ width: t.length * 0.7 });
  return ctx;
}
const view = { ppm: 4, zoom: 1, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 };

test("KiCad Default is the starting theme, with builtin_color_themes.h's colours", () => {
  assert.strictEqual(K.schTheme(), "default");
  assert.strictEqual(K.SCH.bg, "#F5F4EF"); assert.strictEqual(K.SCH.wire, "#009600"); assert.strictEqual(K.SCH.label, "#0F0F0F");
});
test("KiCad Classic resolves COLOR4D names through color4d.cpp's B, G, R table", () => {
  const c = K.schThemeColors("classic");
  assert.strictEqual(c.bg, "#FFFFFF");          // WHITE
  assert.strictEqual(c.wire, "#008400");        // GREEN
  assert.strictEqual(c.pinName, "#008484");     // CYAN = (B132, G132, R0)
  assert.strictEqual(c.hlabel, "#848400");      // BROWN = (B0, G132, R132)
  assert.strictEqual(c.body, "#FFFFC2");        // LIGHTYELLOW = (B194, G255, R255)
  assert.strictEqual(c.notes, "#0000C2");       // LIGHTBLUE
  assert.strictEqual(c.sheet, "#840084");       // MAGENTA
  assert.strictEqual(c.pageLimits, K.SCH_DEFAULT.pageLimits, "a layer classic leaves out keeps KiCad Default's colour");
});
test("every theme defines every palette key and the dark sheet is dark", () => {
  for (const id of Object.keys(K.SCH_THEMES)) { const c = K.schThemeColors(id); for (const k of Object.keys(K.SCH_DEFAULT)) assert(c[k], `${id}.${k}`); }
  const lum = (hex) => { const v = parseInt(hex.slice(1), 16); const ch = [v >> 16, (v >> 8) & 255, v & 255].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
  const d = K.schThemeColors("dark"), bg = lum(d.bg);
  assert(bg < 0.03, "dark background");
  for (const k of ["wire", "bus", "outline", "pin", "pinName", "pinNum", "ref", "value", "field", "label", "glabel", "hlabel", "sheet", "noconnect", "notes", "netclass"]) {
    const ratio = (lum(d[k]) + 0.05) / (bg + 0.05); assert(ratio >= 4.5, `${k} contrast ${ratio.toFixed(2)}`);
  }
});
test("a theme switch rebuilds stale geometry when painted, and only then", () => {
  const doc = K.parseDoc(SHEET, "kicad_sch");
  assert.strictEqual(wireColor(doc), "#009600");
  assert.strictEqual(K.setSchTheme("dark"), true);
  assert.strictEqual(K.setSchTheme("dark"), false, "no change, no work");
  assert.strictEqual(K.SCH.bg, K.schThemeColors("dark").bg, "the live palette is switched in place");
  assert.strictEqual(wireColor(doc), "#009600", "geometry is rebuilt lazily");
  K.render(doc, stubCtx(), view, {});
  assert.strictEqual(wireColor(doc), K.schThemeColors("dark").wire);
  assert.strictEqual(labelColor(doc), K.schThemeColors("dark").label);
  const parsedNow = K.parseDoc(SHEET, "kicad_sch");
  assert.strictEqual(wireColor(parsedNow), K.schThemeColors("dark").wire, "a sheet parsed under a theme is built in it");
  K.setSchTheme("default");
});
test("exports use KiCad Default whatever the screen shows, unless a theme is named", () => {
  const doc = K.parseDoc(SHEET, "kicad_sch");
  K.setSchTheme("dark"); K.render(doc, stubCtx(), view, {});
  const svg = K.renderSvg(doc, {});
  assert(svg.includes('fill="#F5F4EF"'), "default paper"); assert(svg.includes("#009600"), "default wire colour");
  assert(!svg.includes(K.schThemeColors("dark").wire), "no dark colour leaks into the export");
  assert.strictEqual(K.schTheme(), "dark", "the screen's theme is restored");
  assert.strictEqual(wireColor(doc), K.schThemeColors("dark").wire, "the document's own geometry is untouched");
  const dark = K.renderSvg(doc, { colorTheme: "dark" });
  assert(dark.includes(K.schThemeColors("dark").bg) && dark.includes(K.schThemeColors("dark").wire));
  K.setSchTheme("default");
  const classic = K.renderSvg(doc, { colorTheme: "classic" });
  assert(classic.includes('fill="#FFFFFF"') && classic.includes("#008400"));
  assert.strictEqual(K.schTheme(), "default");
});
test("the schematic layer list takes its colours from the live palette", () => {
  const doc = K.parseDoc(SHEET, "kicad_sch");
  K.setSchTheme("classic");
  const wires = K.layerList(doc).find((l) => l.name === "Wires");
  assert.strictEqual(wires.color, "#008400");
  K.setSchTheme("default");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
