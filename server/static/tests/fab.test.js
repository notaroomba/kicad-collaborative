// node server/static/tests/fab.test.js — the fabrication output writers (server/web/fab: Gerber, Excellon drill,
// placement, BOM, the manufacturer presets and the zip writer), reached through the bundle's KiCadFab.
// `npm run build` must have produced static/dist/fab.js and static/kicad-canvas.js first.  How the same
// output compares with kicad-cli on real boards is scripts/fab-verify.mjs.
"use strict";
const assert = require("assert");
const path = require("path");
const zlib = require("zlib");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  ", name); }, (e) => { failed++; console.error("FAIL", name + ":", e.message); })); }

// a 40 x 30 mm two-layer board: two 0603 resistors (one turned), a part on the back, a part that is not populated,
// a header with a round hole, a slot and a mounting hole, a track, a tented and an untented via, a legend text
const fp = (ref, value, lib, at, side, body, extra) => `(footprint "${lib}" (layer "${side}") (uuid "f-${ref}") (at ${at})
  (property "Reference" "${ref}" (at 0 -1.5) (layer "${side === "B.Cu" ? "B.SilkS" : "F.SilkS"}") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))${side === "B.Cu" ? " (justify mirror)" : ""}))
  (property "Value" "${value}" (at 0 1.5) (layer "${side === "B.Cu" ? "B.Fab" : "F.Fab"}") (uuid "v-${ref}") (effects (font (size 1 1) (thickness 0.15))${side === "B.Cu" ? " (justify mirror)" : ""}))
  ${extra || ""}
  ${body})`;
const smd = (n, x, net, side) => `(pad "${n}" smd roundrect (at ${x} 0) (size 0.9 0.95) (layers "${side}" "${side[0]}.Mask" "${side[0]}.Paste") (roundrect_rratio 0.25) (net ${net}) (uuid "p-${side}-${n}-${x}"))`;
const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6))
 (paper "A4") (title_block (title "Fab test") (rev "B"))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen")
  (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))
 (setup (pad_to_mask_clearance 0.05) (allow_soldermask_bridges_in_footprints no) (tenting (front yes) (back yes)) (aux_axis_origin 100 80))
 (net 0 "") (net 1 "GND") (net 2 "VCC")
 (gr_rect (start 100 50) (end 140 80) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 (gr_text "REV B" (at 120 76) (layer "F.SilkS") (uuid "txt") (effects (font (size 1.5 1.5) (thickness 0.2))))
 ${fp("R1", "10k", "Resistor_SMD:R_0603_1608Metric", "110 60", "F.Cu", smd(1, -0.825, 1, "F.Cu") + smd(2, 0.825, 2, "F.Cu"), `(property "LCSC Part #" "C25804" (at 0 0) (layer "F.Fab") (hide yes) (uuid "l-R1") (effects (font (size 1 1) (thickness 0.15)))) (attr smd)
   (fp_rect (start -1.5 -0.75) (end 1.5 0.75) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c-R1"))`)}
 ${fp("R2", "10k", "Resistor_SMD:R_0603_1608Metric", "120 60 90", "F.Cu", smd(1, -0.825, 1, "F.Cu") + smd(2, 0.825, 2, "F.Cu"), `(property "LCSC Part #" "C25804" (at 0 0) (layer "F.Fab") (hide yes) (uuid "l-R2") (effects (font (size 1 1) (thickness 0.15)))) (attr smd)`)}
 ${fp("U1", "NE555", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "130 60 180", "B.Cu", smd(1, -2.5, 1, "B.Cu") + smd(2, 2.5, 2, "B.Cu"), `(property "MPN" "NE555DR" (at 0 0) (layer "B.Fab") (hide yes) (uuid "m-U1") (effects (font (size 1 1) (thickness 0.15)))) (attr smd)`)}
 ${fp("C1", "100n", "Capacitor_SMD:C_0603_1608Metric", "110 70", "F.Cu", smd(1, -0.825, 1, "F.Cu") + smd(2, 0.825, 2, "F.Cu"), `(attr smd dnp)
   (fp_rect (start -1.5 -0.75) (end 1.5 0.75) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c-C1"))
   (fp_rect (start -0.8 -0.4) (end 0.8 0.4) (stroke (width 0.1) (type default)) (fill yes) (layer "F.Fab") (uuid "b-C1"))`)}
 ${fp("J1", "Conn", "Connector:PinHeader_1x02", "125 70", "F.Cu",
   `(pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 1) (uuid "j1"))
    (pad "2" thru_hole oval (at 2.54 0) (size 1.7 2.4) (drill oval 1 1.6) (layers "*.Cu" "*.Mask") (net 2) (uuid "j2"))
    (pad "" np_thru_hole circle (at -3 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask") (uuid "j3"))`, `(attr through_hole)`)}
 (segment (start 110.825 60) (end 120 60) (width 0.25) (layer "F.Cu") (net 2) (uuid "s1"))
 (via (at 115 65) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
 (via (at 118 65) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (tenting (front no) (back no)) (net 1) (uuid "v2"))
)`;

const doc = K.parseDoc(BOARD, "kicad_pcb");
const ctx = { doc, setup: BOARD, projectName: "t", date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) };
const lines = (f) => String(f.data !== undefined ? f.data : f.text).split(/\r?\n/);
const file = (pkg, re) => { const f = pkg.files.find((x) => re.test(x.name)); assert(f, "no file matching " + re); return f; };
const flashes = (f, aperture) => { const out = []; let cur = ""; for (const l of lines(f)) { const d = /^(D\d+)\*$/.exec(l); if (d) cur = d[1]; else if (cur === aperture && /D03\*$/.test(l)) out.push(l); } return out; };
const apertures = (f) => lines(f).filter((l) => /^%ADD/.test(l));

test("a JLCPCB package has the nine fabrication layers, two drill files, the BOM and the CPL", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" });
  assert.deepStrictEqual(p.files.map((f) => f.name), ["t-F_Cu.gtl", "t-B_Cu.gbl", "t-F_Paste.gtp", "t-B_Paste.gbp", "t-F_Silkscreen.gto", "t-B_Silkscreen.gbo", "t-F_Mask.gts", "t-B_Mask.gbs", "t-Edge_Cuts.gm1",
    "t-PTH.drl", "t-NPTH.drl", "bom.csv", "positions.csv"]);
  assert.deepStrictEqual(p.bundle.map((f) => f.name), ["gerbers.zip", "bom.csv", "positions.csv"]);
  assert.deepStrictEqual(p.summary, { layers: 9, copperLayers: 2, holes: 5, platedHoles: 4, slots: 1, parts: 5, placed: 4, bomLines: 3, width: 40, height: 30 });
  assert(p.warnings.some((w) => /2 BOM line\(s\) have no LCSC part number/.test(w)), p.warnings.join(" | "));
});

test("a Gerber file states its format, its function and the drill/place origin", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const cu = file(p, /F_Cu/), L = lines(cu);
  assert(L.includes("%FSLAX46Y46*%") && L.includes("%MOMM*%") && L[L.length - 2] === "M02*", "format lines");
  assert(L.includes("G04 #@! TF.FileFunction,Copper,L1,Top*"), "X2 attributes are comments for a fabricator that reads X1");
  assert(L.includes("G04 #@! TF.CreationDate,2026-01-02T03:04:05+00:00*"));
  assert(lines(file(p, /B_Cu/)).includes("G04 #@! TF.FileFunction,Copper,L2,Bot*"));
  assert(lines(file(p, /Edge_Cuts/)).includes("G04 #@! TF.FileFunction,Profile,NP*"));
  // (aux_axis_origin 100 80): R1's pad 1 at (109.175, 60) is 9.175 right of and 20 above the origin
  const rr = apertures(cu).find((l) => /RoundRect/.test(l)); assert(rr, "round rectangle pads use KiCad's aperture macro");
  assert(flashes(cu, /ADD(\d+)/.exec(rr)[0].replace("ADD", "D")).includes("X9175000Y20000000D03*"));
  // KiCad's own defaults keep the page origin and write X2 attributes as such
  const k = await F.buildPackage(ctx, { preset: "kicad" }); const kc = lines(file(k, /F_Cu/));
  assert(kc.includes("%TF.FileFunction,Copper,L1,Top*%") && kc.some((l) => l === "X109175000Y-60000000D03*"), "page coordinates, Y up");
});

test("copper: pads by shape, the track drawn with its width, vias flashed", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const cu = file(p, /F_Cu/), A = apertures(cu).join("\n");
  assert(/R,1\.700000X1\.700000\*%/.test(A) && /O,1\.700000X2\.400000\*%/.test(A) && /C,0\.600000\*%/.test(A) && /C,0\.250000\*%/.test(A), A);
  const L = lines(cu), i = L.indexOf("X10825000Y20000000D02*");
  assert(i > 0 && L[i + 1] === "X20000000Y20000000D01*", "the track from R1 to R2");
  assert(!L.includes("X22000000Y10000000D03*"), "a mounting hole no larger than its pad has no copper");
  assert(lines(file(p, /B_Cu/)).some((l) => /^X2[57]\d{6}Y10000000D03\*$/.test(l)), "through-hole pads are on the back too");
});

test("solder mask: pads grown by the board's clearance, tented vias left covered", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const m = file(p, /F_Mask/), A = apertures(m).join("\n");
  assert(/O,1\.800000X2\.500000\*%/.test(A) && /C,2\.300000\*%/.test(A), "0.05 mm on every side: " + A);
  const via = apertures(m).find((l) => /C,0\.700000\*%/.test(l));
  assert(via, "the via with (tenting none) is open");
  const d = via.replace(/^%ADD(\d+).*/, "D$1");
  assert.deepStrictEqual(flashes(m, d), ["X18000000Y15000000D03*"], "…and only that one");
  const t = await F.buildPackage(ctx, { preset: "jlcpcb", forceTentVias: true });
  assert(!apertures(file(t, /F_Mask/)).some((l) => /C,0\.700000\*%/.test(l)), "Tent all vias covers it");
});

test("silkscreen: text as strokes, cleared where the mask is open when asked", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const s = lines(file(p, /F_Silkscreen/));
  assert(s.includes("%LPC*%"), "the JLCPCB preset subtracts the mask");
  const k = await F.buildPackage(ctx, { preset: "kicad" }); const ks = lines(file(k, /F_Silkscreen/));
  assert(!ks.includes("%LPC*%"), "KiCad's default does not");
  assert(apertures(file(k, /F_Silkscreen/)).some((l) => /C,0\.200000\*%/.test(l)), "REV B is drawn with its 0.2 mm pen");
  const none = await F.buildPackage(ctx, { preset: "kicad", plotReference: false });
  assert(lines(file(none, /F_Silkscreen/)).length < ks.length, "reference designators can be left out");
});

test("a part that is not populated is outlined and crossed out on its Fab layer", async () => {
  const k = await F.buildPackage(ctx, { preset: "kicad" }); const fab = file(k, /F_Fab/), L = lines(fab);
  assert(!L.includes("G36*"), "its filled body is drawn as an outline");
  // the diagonals of C1's courtyard (108.5, 69.25) to (111.5, 70.75)
  const a = L.indexOf("X108500000Y-69250000D02*"), b = L.indexOf("X111500000Y-69250000D02*");
  assert(a > 0 && L[a + 1] === "X111500000Y-70750000D01*" && b > 0 && L[b + 1] === "X108500000Y-70750000D01*", "the cross");
  const plain = F.plotGerbers(ctx, { layers: ["F.Fab"], sketchDnpOnFab: false, crossoutDnpOnFab: false }).files[0];
  assert(lines(plain).includes("G36*") && !lines(plain).includes("X108500000Y-69250000D02*"), "both can be switched off");
});

test("drill files: tools by size, plated and not plated apart, slots routed", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const pth = lines(file(p, /-PTH/)), npth = lines(file(p, /-NPTH/));
  assert.deepStrictEqual(pth.filter((l) => /^T\d+C/.test(l)), ["T1C0.300", "T2C1.000"]);
  assert(pth.includes("METRIC") && pth.includes("; #@! TF.FileFunction,Plated,1,2,PTH") && pth[pth.length - 2] === "M30");
  assert(pth.includes("X15.0Y15.0") && pth.includes("X18.0Y15.0") && pth.includes("X25.0Y10.0"), "vias and the header pin, from the drill origin");
  const i = pth.indexOf("G00X27.54Y10.3");
  assert(i > 0 && pth[i + 1] === "M15" && pth[i + 2] === "G01X27.54Y9.7" && pth[i + 3] === "M16", "the 1 x 1.6 slot is a routed move of its tool");
  assert.deepStrictEqual(npth.filter((l) => /^T\d+C|^X/.test(l)), ["T1C2.200", "X22.0Y10.0"]);
  const merged = await F.buildPackage(ctx, { preset: "jlcpcb", mergeDrill: true });
  assert.deepStrictEqual(merged.files.filter((f) => f.kind === "drill").map((f) => f.name), ["t.drl"]);
});

test("placement: JLCPCB's CPL columns, bottom rotation and package corrections; DNP parts left out", async () => {
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const L = lines(file(p, /positions/));
  assert.strictEqual(L[0].replace(/^\uFEFF/, ""), "Designator,Mid X,Mid Y,Rotation,Layer");
  assert(L.includes("R1,10.0000,20.0000,0.0000,top") && L.includes("R2,20.0000,20.0000,90.0000,top"));
  assert(L.includes("U1,30.0000,20.0000,270.0000,bottom"), "SOIC on the back at 180: mirrored to 0, plus the library's 270");
  assert(L.some((l) => /^J1,24\.6450,10\.0000/.test(l)), "a through-hole part is placed at the middle of its pads");
  assert(!L.some((l) => /^C1,/.test(l)), "C1 is marked Do not populate");
  const all = await F.buildPackage(ctx, { preset: "jlcpcb", excludeDnp: false });
  assert(lines(file(all, /positions/)).some((l) => /^C1,/.test(l)), "…unless asked for");
});

test("placement and BOM as KiCad writes them, and in PCBWay's templates", async () => {
  const k = await F.buildPackage(ctx, { preset: "kicad" }); const pos = lines(file(k, /all-pos/));
  assert.strictEqual(pos[0], "Ref,Val,Package,PosX,PosY,Rot,Side");
  assert(pos.includes('"U1","NE555","SOIC-8_3.9x4.9mm_P1.27mm",130.000000,-60.000000,180.000000,bottom'));
  assert(lines(file(k, /bom/)).includes('"R1,R2","10k","R_0603_1608Metric","2",""'));
  const w = await F.buildPackage(ctx, { preset: "pcbway" });
  assert(lines(file(w, /centroid/)).includes("U1,SOIC-8_3.9x4.9mm_P1.27mm,30.0000mm,20.0000mm,B,180.0000,NE555"));
  assert(lines(file(w, /bom/)).includes("3,U1,1,,NE555DR,NE555,SOIC-8_3.9x4.9mm_P1.27mm,SMD,"));
  const j = await F.buildPackage(ctx, { preset: "jlcpcb" });
  assert(lines(file(j, /bom/)).includes('"R1, R2",R_0603_1608Metric,2,10k,C25804'), "parts of one value and footprint share a line");
});

test("the archive is a zip any tool opens", async () => {
  assert.strictEqual(F.crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
  const p = await F.buildPackage(ctx, { preset: "jlcpcb" }); const z = await F.packageZip(p, ctx.date);
  assert.strictEqual(z.name, "t-jlcpcb.zip");
  const outer = unzip(Buffer.from(z.data));
  assert.deepStrictEqual([...outer.keys()], ["gerbers.zip", "bom.csv", "positions.csv"]);
  const inner = unzip(outer.get("gerbers.zip"));
  assert.strictEqual(inner.size, 11);
  assert.strictEqual(inner.get("t-F_Cu.gtl").toString("utf8"), file(p, /F_Cu/).data);
});

test("only the layers asked for are plotted, under the board's own layer names", () => {
  assert.deepStrictEqual(F.plottableLayers(doc), ["F.Cu", "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"]);
  const g = F.plotGerbers(ctx, { layers: ["B.SilkS", "Edge.Cuts"] });
  assert.deepStrictEqual(g.files.map((f) => f.name), ["t-B_Silkscreen.gbr", "t-Edge_Cuts.gbr"]);
  assert.strictEqual(F.protelExtension("In2.Cu", ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]), "g3");
});

const mini = (version, items) => `(kicad_pcb (version ${version}) (generator "pcbnew") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0)) (net 0 "") (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e")) ${items})`;

test("bold stroke text: 1.6 x the stored width, and a knockout laid out with the stored one", () => {
  const txt = `(gr_text "BOLD" (at 10 10) (layer "F.SilkS" knockout) (uuid "b") (effects (font (size 2 2) (thickness 0.32) (bold yes)) (justify left)))`;
  const geomOf = (version) => K.parseDoc(mini(version, txt), "kicad_pcb").items.get("b").geom.find((g) => g.t === "text");
  const now = geomOf(20261031), old = geomOf(20241229);
  assert(Math.abs(now.w - 0.512) < 1e-9 && Math.abs(now.layoutW - 0.32) < 1e-9, `current format: pen ${now.w}, layout ${now.layoutW}`);
  assert(Math.abs(old.w - 0.32) < 1e-9 && Math.abs(old.layoutW - 0.2) < 1e-9, `before 20260826 the file held the bold width: pen ${old.w}, layout ${old.layoutW}`);
  // the knockout box starts at the anchor, less the first glyph's side bearing, the pen and the margin: 0.2 / 1.52 of layout offset, not 0.32 / 1.52
  const d = K.parseDoc(mini(20241229, txt), "kicad_pcb"); const g = F.plotGerbers({ doc: d, setup: mini(20241229, ""), projectName: "b" }, { layers: ["F.SilkS"] });
  const xs = [...g.files[0].text.matchAll(/X(-?\d+)Y-?\d+D0[12]\*/g)].map((m) => +m[1] / 1e6);
  const plain = K.parseDoc(mini(20241229, txt.replace(" (bold yes)", "").replace("0.32", "0.2")), "kicad_pcb"); const gp = F.plotGerbers({ doc: plain, setup: mini(20241229, ""), projectName: "b" }, { layers: ["F.SilkS"] });
  const xp = [...gp.files[0].text.matchAll(/X(-?\d+)Y-?\d+D0[12]\*/g)].map((m) => +m[1] / 1e6);
  // same layout width, so the glyphs start at the same place; the box is wider by the pen difference (0.06 a side) and its margin (max(pen/2, size/9) is size/9 for both)
  assert(Math.abs((Math.min(...xp) - Math.min(...xs)) - 0.06) < 2e-3, `box left edges ${Math.min(...xs)} and ${Math.min(...xp)}`);
});

test("text in an outline font is plotted from the outlines KiCad stored, which follow a move and go when the text changes", () => {
  const txt = `(gr_text "Hi" (at 10 10) (layer "F.SilkS") (uuid "o") (effects (font (face "Some Face") (size 2 2) (thickness 0.3)) (justify left bottom))
    (render_cache "Hi" 0 (polygon (pts (xy 10.2 8) (xy 11.2 8) (xy 11.2 10) (xy 10.2 10))) (polygon (pts (xy 11.6 8) (xy 12 8) (xy 12 10) (xy 11.6 10)))))`;
  const d = K.parseDoc(mini(20261031, txt), "kicad_pcb"), c = { doc: d, setup: mini(20261031, ""), projectName: "o" };
  const plot = () => { const g = F.plotGerbers(c, { layers: ["F.SilkS"] }); return { text: g.files[0].text, warnings: g.warnings }; };
  let r = plot();
  assert(/G36\*\s*X10200000Y-8000000D02\*/.test(r.text) && /X12000000Y-10000000D01\*/.test(r.text), "the stored polygons are the plot");
  assert(!r.warnings.some((w) => /Some Face/.test(w)), r.warnings.join(" | "));
  const it = d.items.get("o"); K.moveItem(d, it, 15, 12, 1e6);
  assert(/\(xy 15\.2 10\)/.test(K.serializeItem(d, it)), "the outlines moved with the text: " + K.serializeItem(d, it));
  r = plot();
  assert(/G36\*\s*X15200000Y-10000000D02\*/.test(r.text), "and are plotted where the text now is");
  it.node[1] = "Ho"; K.buildGeom(d, it);
  assert(!/render_cache/.test(K.serializeItem(d, it)), "outlines of another string are dropped");
  r = plot();
  assert(!/G36/.test(r.text) && r.warnings.some((w) => /Some Face/.test(w) && /stroke font/.test(w)), "then the stroke font, with a warning: " + r.warnings.join(" | "));
});

test("text in an outline font with no stored outlines is plotted from the font file the project holds", () => {
  const fs = require("fs"), file = path.join(__dirname, "..", "..", "..", "qa", "resources", "fonts", "NotoSans-Regular.ttf");
  if (!fs.existsSync(file)) { console.log("  skip (no font file beside the server)"); return; }
  const raw = fs.readFileSync(file), data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
  const txt = (extra, just) => `(gr_text "Hot" (at 10 10) (layer "F.SilkS"${extra || ""}) (uuid "o") (effects (font (face "Noto Sans") (size 2 2) (thickness 0.3)) (justify ${just || "left bottom"})))`;
  const plot = (t) => { const d = K.parseDoc(mini(20261031, t), "kicad_pcb"); const g = F.plotGerbers({ doc: d, setup: mini(20261031, ""), projectName: "o" }, { layers: ["F.SilkS"] }); return { text: g.files[0].text, warnings: g.warnings }; };
  const box = (text) => { const xs = [], ys = []; for (const m of text.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)) { xs.push(+m[1] / 1e6); ys.push(-m[2] / 1e6); } return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  K.fontChanged();
  let r = plot(txt());
  assert(!/G36/.test(r.text) && r.warnings.some((w) => /Noto Sans/.test(w)), "without the file: the stroke font and a warning");
  K.setFontData("Noto Sans", false, false, { data, bold: false, italic: false });
  r = plot(txt());
  assert(/G36/.test(r.text) && !r.warnings.some((w) => /Noto Sans/.test(w)), "with it: filled outlines and no warning: " + r.warnings.join(" | "));
  // KiCad's layout: an em of 1.4 text heights, the baseline one height below the top of the block, the block 1.17 heights
  // tall and sitting on the anchor (justify bottom): baseline at 10 + 2 - 2.34 = 9.66; "H" is 0.714 em tall in Noto Sans
  let b = box(r.text);
  assert(Math.abs(b[3] - 9.66) < 0.06, `the baseline: ${b[3]}`);
  assert(Math.abs((b[3] - b[1]) - 0.714 * 2.8) < 0.08, `the cap height: ${b[3] - b[1]}`);
  assert(b[0] > 10 && b[0] < 10.5 && b[2] - b[0] > 4.4 && b[2] - b[0] < 5.4, `starts at the anchor and is as wide as the glyphs: ${b}`);
  const regions = (r.text.match(/G36\*/g) || []).length;
  assert.strictEqual(regions, 3, "one region per letter, the hole of the o cut in (no hole is filled): " + regions);
  // right justified: the same shape ending at the anchor; turned a quarter: the box turned with it
  const br = box(plot(txt("", "right bottom")).text);
  assert(Math.abs(br[2] - 10) < 0.25 && Math.abs((br[2] - br[0]) - (b[2] - b[0])) < 1e-3, `right justified: ${br}`);
  const bq = box(plot(txt().replace("(at 10 10)", "(at 10 10 90)")).text);
  assert(Math.abs((bq[3] - bq[1]) - (b[2] - b[0])) < 1e-3 && Math.abs((bq[2] - bq[0]) - (b[3] - b[1])) < 1e-3, `rotated: ${bq}`);
  // a knockout text: its box as a region, the glyphs cleared out of it
  const k = plot(txt(" knockout"));
  assert(/%LPC\*%/.test(k.text) && /G36/.test(k.text), "knockout: the letters are cleared out of the box");
  // two lines are 1.68 heights apart; an overbar is a stroke above the letters
  const two = box(plot(txt().replace('"Hot"', '"Hot\\nHot"')).text);
  assert(Math.abs((two[3] - two[1]) - (b[3] - b[1]) - 3.36) < 0.02, `two lines: ${two}`);
  const over = plot(txt().replace('"Hot"', '"~{Hot}"'));
  assert(/G36/.test(over.text) && /D01\*/.test(over.text.split("G37*").pop()), "the overbar is drawn after the letters");
  assert(F.outlineText({ face: "No Such Face", bold: false, italic: false, text: "x", x: 0, y: 0, rot: 0, size: 1, sizeX: 1, h: "left", v: "bottom", mirror: false }) === null, "a font that is not held answers null");
  K.fontChanged();
});

Promise.all(pending).then(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); });

/** The entries of a zip archive (stored or deflated). */
function unzip(buf) {
  const out = new Map(); let end = buf.length - 22; while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl), lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nl + el + cl;
  }
  return out;
}
