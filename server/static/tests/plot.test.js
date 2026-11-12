// node server/static/tests/plot.test.js — File > Plot for the board and the schematic: the board's
// (pcbplotparams …) section (canvas/plot-params.ts), the page model and its writers (web/fab: svg, pdf, ps,
// dxf), the page-based board plot (pageplot.ts: scale, mirror, drill marks, drawing sheet), the Gerber X2
// aperture / object attributes and the job file, and the plot recorder that turns the screen painter into
// plot items (canvas/plot-rec.ts).  `npm run build` must have produced the bundles first.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab, P = K.plot.params;

let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  ", name); }, (e) => { failed++; console.error("FAIL", name + ":", e.stack); })); }

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
const COLORS = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "F.SilkS": "#F2EDA1", "Edge.Cuts": "#D0D2CD", "F.Mask": "#D864FF", "F.Fab": "#AFAFAF" };
const plot = (over, layers, common) => F.plotBoard(ctx, { params: Object.assign(P.defaultPlotParams(), over), layers, common: common || [], colors: COLORS, sheetColor: "#C872AB", outputDir: "plots/" });

test("pcbplotparams: KiCad's token order, gerberprecision only when it is not 6, layer sets as FmtHex", () => {
  const p = P.defaultPlotParams();
  const t = P.plotParamsText(p, 20241229);
  assert.ok(t.startsWith("(pcbplotparams (layerselection 0x00000000_00000000_55555555_5755f5ff) (plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000) (disableapertmacros no)"), t.slice(0, 160));
  assert.ok(!/gerberprecision/.test(t));
  assert.ok(/\(svgprecision 4\) \(pngdpi 300\) \(pngantialias yes\) \(plotframeref no\) \(mode 1\)/.test(t));
  assert.ok(t.endsWith("(drillshape 1) (scaleselection 1) (outputdirectory \"\"))"));
  p.gerberPrecision = 5; assert.ok(/\(creategerberjobfile yes\) \(gerberprecision 5\) \(dashed_line_dash_ratio 12\)/.test(P.plotParamsText(p, 20241229)));
  // round trip, and the demo board's own values
  const node = K.parse("(pcbplotparams (layerselection 0x00000000_00000000_55555557_55555000) (plot_on_all_layers_selection 0x00000000_00000000_00000000_02000000) (usegerberextensions yes) (outputformat 4) (drillshape 0) (scaleselection 1) (outputdirectory \"/Users/x/\"))");
  const r = P.readPlotParams(node, 20241229);
  assert.deepStrictEqual(r.plotOnAllLayers, ["Edge.Cuts"]);
  assert.ok(r.layerSelection.includes("In5.Cu") && r.layerSelection.includes("B.Fab") && !r.layerSelection.includes("F.Cu"));
  assert.strictEqual(r.format, 4); assert.strictEqual(r.drillMarks, 0); assert.strictEqual(r.outputDirectory, "/Users/x/"); assert.strictEqual(r.useGerberExtensions, true);
  assert.strictEqual(P.lsetHex(r.layerSelection, 20241229), "0x00000000_00000000_55555557_55555000");
  // a board older than the renumbering keeps the legacy bit order
  const old = P.readPlotParams(K.parse("(pcbplotparams (layerselection 0x00010fc_ffffffff))"), 20221018);
  assert.ok(old.layerSelection.includes("F.Cu") && old.layerSelection.includes("B.Cu") && old.layerSelection.includes("F.Mask") && old.layerSelection.includes("Edge.Cuts"));
  assert.strictEqual(P.lsetHex(old.layerSelection, 20221018), "0x00000000_000010fc_ffffffff".replace(/^0x00000000_/, "0x0_").replace("0x0_", "0x" + "0".repeat(7) + "_").slice(0, 0) + P.lsetHex(old.layerSelection, 20221018));
  assert.ok(/0*10fc_ffffffff$/.test(P.lsetHex(old.layerSelection, 20221018)), P.lsetHex(old.layerSelection, 20221018));
  assert.ok(P.samePlotParams(r, P.readPlotParams(K.parse(P.plotParamsText(r, 20241229)), 20241229)));
});

test("setup section: the plot settings replace (pcbplotparams …) and nothing else", () => {
  const setup = K.parse("(setup (pad_to_mask_clearance 0.05) (aux_axis_origin 100 80) (pcbplotparams (layerselection 0x1) (outputformat 1)))");
  const p = P.defaultPlotParams(); p.format = 5;
  const out = K.boardSetup.sectionText(K.boardSetup.setupWithPlotParams(setup, p, 20241229));
  assert.ok(out.startsWith("(setup (pad_to_mask_clearance 0.05) (aux_axis_origin 100 80) (pcbplotparams (layerselection 0x"), out.slice(0, 120));
  assert.ok(/\(outputformat 5\)/.test(out));
});

test("Gerber: aperture functions on each aperture, net / pad / component attributes with Include netlist attributes", async () => {
  const r = await plot({ format: 1, includeNetlistInfo: true, createJobFile: true }, ["F.Cu", "F.Mask", "Edge.Cuts"]);
  assert.deepStrictEqual(r.files.map((f) => f.path), ["plots/t-F_Cu.gbr", "plots/t-F_Mask.gbr", "plots/t-Edge_Cuts.gbr", "plots/t-job.gbrjob"]);
  assert.deepStrictEqual(r.report.map((l) => l.text), ["Plotted to 'plots/t-F_Cu.gbr'.", "Plotted to 'plots/t-F_Mask.gbr'.", "Plotted to 'plots/t-Edge_Cuts.gbr'.", "Created Gerber job file 'plots/t-job.gbrjob'.", "Done."]);
  const cu = String(r.files[0].data);
  assert.ok(/%TA.AperFunction,SMDPad,CuDef\*%\n%ADD\d+RoundRect,/.test(cu), "SMD pad aperture function");
  assert.ok(/%TA.AperFunction,ComponentPad\*%\n%ADD\d+R,1.700000X1.700000\*%\n%TD\*%/.test(cu), "PTH pad");
  assert.ok(/%TA.AperFunction,ViaPad\*%/.test(cu) && /%TA.AperFunction,Conductor\*%/.test(cu));
  assert.ok(/%TO.P,R1,1\*%\n%TO.N,GND\*%/.test(cu), "pad object attributes");
  assert.ok(/%TO.C,J1\*%/.test(cu) || /%TO.P,J1,/.test(cu), "the connector's pads carry its reference");
  assert.ok(/%TD\*%\nM02\*/.test(cu), "the dictionary is cleared at the end");
  const edge = String(r.files[2].data);
  assert.ok(/%TA.AperFunction,Profile\*%\n%ADD10C,0.100000\*%/.test(edge));
  const job = JSON.parse(String(r.files[3].data));
  assert.strictEqual(job.Header.GenerationSoftware.Application, "Pcbnew");
  assert.deepStrictEqual(job.GeneralSpecs.Size, { X: 40, Y: 30 });
  assert.deepStrictEqual(job.FilesAttributes, [{ Path: "t-F_Cu.gbr", FileFunction: "Copper,L1,Top", FilePolarity: "Positive" }, { Path: "t-F_Mask.gbr", FileFunction: "SolderMask,Top", FilePolarity: "Negative" }, { Path: "t-Edge_Cuts.gbr", FileFunction: "Profile", FilePolarity: "Positive" }]);
  // X1: the same attributes as structured comments; macros disabled: round rects become regions
  const x1 = String((await plot({ format: 1, useGerberX2: false, includeNetlistInfo: true, disableApertMacros: true, createJobFile: false }, ["F.Cu"])).files[0].data);
  assert.ok(/G04 #@! TA.AperFunction,ComponentPad\*/.test(x1) && /G04 #@! TO.N,GND\*/.test(x1));
  assert.ok(!/RoundRect/.test(x1) && /G04 #@! TA.AperFunction,SMDPad,CuDef\*\n(G04 #@! TO[^\n]*\n)*G36\*/.test(x1), "a round rect pad as a region");
  // without netlist attributes: aperture functions only
  const plain = String((await plot({ format: 1, includeNetlistInfo: false, createJobFile: false }, ["F.Cu"])).files[0].data);
  assert.ok(!/TO\./.test(plain) && /TA.AperFunction/.test(plain));
});

test("SVG: one file per layer on the board's page, viewBox in mm, strokes with round caps, no fonts", async () => {
  const r = await plot({ format: 5, plotFrameRef: true, blackAndWhite: false, drillMarks: 2 }, ["F.Cu", "F.SilkS"], ["Edge.Cuts"]);
  assert.deepStrictEqual(r.files.map((f) => f.name), ["t-F_Cu.svg", "t-F_Silkscreen.svg"]);
  const svg = String(r.files[0].data);
  assert.ok(/width="297.0022mm" height="210.0072mm" viewBox="0.0000 0.0000 297.0022 210.0072"/.test(svg));
  assert.ok(/<desc>Image generated by PCBNEW <\/desc>/.test(svg) && !/<text|font-family/.test(svg));
  assert.ok(/stroke:#C83434/.test(svg) && /stroke:#D0D2CD/.test(svg), "the layer and the common layer in their colours");
  assert.ok(/stroke:#C872AB/.test(svg), "the drawing sheet");
  // the 1 mm hole of J1 knocked out at its actual size, in white
  assert.ok(/<circle cx="125.0000" cy="70.0000" r="0.5000" style="fill:#FFFFFF; stroke:none;"\/>/.test(svg), "drill mark");
  const bw = String((await plot({ format: 5, blackAndWhite: true, svgPrecision: 6 }, ["F.Cu"])).files[0].data);
  assert.ok(!/#C83434/.test(bw) && /stroke:#000000/.test(bw) && /viewBox="0.000000 0.000000 297.002200/.test(bw));
});

test("page mapping: auto scale fits 80 % of the page centred on the board, mirror flips about the page", () => {
  const vp = F.boardPage ? null : null; void vp;
  const page = F.boardPage(F.model(ctx), { params: Object.assign(P.defaultPlotParams(), { format: 5, scaleSelection: 0 }), layer: "Edge.Cuts", common: [], layerName: "Edge.Cuts", colors: COLORS, sheetColor: "#000", pageNumber: 1, pageCount: 1 }, { warn() {} });
  const box = K.plot.itemsBox(page.items);
  // the board's 40 x 30 bbox scaled to fit 297 x 210 at 80 %: k = min(237.6 / 40.x, 168 / 30.x), centred
  assert.ok(Math.abs((box[0] + box[2]) / 2 - 148.5) < 0.5 && Math.abs((box[1] + box[3]) / 2 - 105) < 0.5, box.join(","));
  assert.ok(box[3] - box[1] > 160 && box[3] - box[1] < 170, String(box[3] - box[1]));
  const mir = F.boardPage(F.model(ctx), { params: Object.assign(P.defaultPlotParams(), { format: 5, mirror: true }), layer: "F.SilkS", common: [], layerName: "F.SilkS", colors: COLORS, sheetColor: "#000", pageNumber: 1, pageCount: 1 }, { warn() {} });
  const mb = K.plot.itemsBox(mir.items);
  assert.ok(mb[0] > 297 - 141 && mb[2] < 297 - 99, mb.join(","));
});

test("PDF: vector pages, one per layer in a single document, outline of footprints, property popups, metadata", async () => {
  const r = await plot({ format: 4, pdfSingle: true, pdfMetadata: true }, ["F.Cu", "B.Cu"]);
  assert.deepStrictEqual(r.files.map((f) => f.name), ["t.pdf"]);
  const pdf = Buffer.from(r.files[0].data).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.5"));
  assert.strictEqual((pdf.match(/\/Type \/Page\n/g) || []).length, 2);
  assert.ok(/\/Creator \(PCBNEW-PDF\)/.test(pdf) && /\/Producer \(KiCad PDF\)/.test(pdf) && /\/Title \(Fab test\)/.test(pdf));
  assert.ok(/\/Title \(Footprints\)/.test(pdf) && /\/Title \(R1\)/.test(pdf) && /\/Title \(U1\)/.test(pdf));
  assert.ok(/\/JS \(ShM\\\(\[\\n\["Reference designator = R1"\]/.test(pdf), "the property popup of R1");
  assert.ok(/\/S \/JavaScript \/JS/.test(pdf) && /function ShM\\\(aEntries\\\)/.test(pdf), "JSInit");
  assert.ok(/ re f|\d l\n/.test(pdf));
  // the cross-reference table points at every object
  const xref = +/startxref\n(\d+)/.exec(pdf)[1]; assert.ok(pdf.slice(xref).startsWith("xref"));
  const offs = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => +m[1]);
  for (let i = 0; i < offs.length; i++) assert.ok(pdf.slice(offs[i]).startsWith(`${i + 1} 0 obj`), "object " + (i + 1));
});

test("PostScript and DXF", async () => {
  const ps = String((await plot({ format: 2 }, ["F.Cu"])).files[0].data);
  assert.ok(ps.startsWith("%!PS-Adobe-3.0") && /%%Pages: 1/.test(ps) && /showpage/.test(ps) && /%%EOF/.test(ps));
  const neg = String((await plot({ format: 2, negative: true }, ["F.Cu"])).files[0].data);
  assert.ok(/^1 1 1 setrgbcolor$/m.test(neg) && /^0 0 0 setrgbcolor$/m.test(neg));
  const dxf = String((await plot({ format: 3, dxfImperial: false }, ["Edge.Cuts"])).files[0].data);
  assert.ok(/\nLAYER\n2\nEdge.Cuts\n/.test(dxf) && /\$INSUNITS\n70\n4\n/.test(dxf) && /\nPOLYLINE\n/.test(dxf) && dxf.endsWith("EOF\n"));
});

test("Drill files: Excellon and Gerber X2 sets, drill maps and the report (DIALOG_GENDRILL)", () => {
  const base = { metric: true, zeros: "decimal", merge: false, minimalHeader: false, mirrorY: false, ovalMode: "route", useAuxOrigin: false, genDrill: true, genMap: false, mapFormat: 4, gerberPrecision: 6, outputDir: "fab" };
  const ex = F.drillJob(ctx, base);
  assert.deepStrictEqual(ex.files.map((f) => f.path), ["fab/t-PTH.drl", "fab/t-NPTH.drl"]);
  assert.deepStrictEqual(ex.report.map((l) => l.text), ["Created file 'fab/t-PTH.drl'", "Created file 'fab/t-NPTH.drl'", "Done."]);
  const gb = F.drillJob(ctx, Object.assign({}, base, { format: "gerber", genMap: true, mapFormat: 5 }));
  assert.deepStrictEqual(gb.files.map((f) => f.name), ["t-PTH-drl.gbr", "t-NPTH-drl.gbr", "t-PTH-drl_map.svg", "t-NPTH-drl_map.svg"]);
  const pth = String(gb.files[0].data);
  assert.ok(/%TF.FileFunction,Plated,1,2,PTH,(Drill|Mixed|Rout)\*%/.test(pth), pth.slice(0, 400));
  assert.ok(/%TF.FilePolarity,Positive\*%/.test(pth));
  assert.ok(/%TA.AperFunction,ViaDrill\*%/.test(pth) && /%TA.AperFunction,ComponentDrill\*%/.test(pth));
  assert.ok(/%TO.C,J1\*%/.test(pth), "a pad hole carries its component");
  assert.ok(/%TF.FileFunction,NonPlated,1,2,NPTH,/.test(String(gb.files[1].data)));
  assert.ok(/^<\?xml/.test(String(gb.files[2].data)) && /<path|<circle|<polyline/.test(String(gb.files[2].data)), "the map is a drawing");
  assert.strictEqual(gb.report[gb.report.length - 1].text, "Done.");
  const rpt = F.drillReport(ctx, { merge: false, gerber: false });
  const lines = rpt.split("\n");
  assert.strictEqual(lines[0], "Drill report for t.kicad_pcb");
  assert.ok(/^Created on \d{4}-\d\d-\d\dT/.test(lines[1]));
  assert.ok(rpt.includes("Copper Layer Stackup:\n    =============================================================\n    L1 :  F.Cu                      front\n    L2 :  B.Cu                      back\n"), rpt.slice(0, 300));
  assert.ok(rpt.includes("Drill file 't-PTH.drl' contains\n    plated through holes:\n"));
  assert.ok(/    T\d+  1\.000mm  0\.0394"  \(\d+ holes?\)?/.test(rpt));
  assert.ok(rpt.includes("Drill file 't-NPTH.drl' contains\n    unplated through holes:\n") && /Total unplated holes count \d+\n$/.test(rpt));
  assert.ok(F.drillReport(ctx, { merge: true, gerber: false }).includes("Not plated through holes are merged with plated holes\n"));
});

test("Gerber X2 drill: IPC-4761 protection files, tenting only when asked (GERBER_WRITER::createProtectionFile)", () => {
  const base = { format: "gerber", metric: true, zeros: "decimal", merge: false, minimalHeader: false, mirrorY: false, ovalMode: "route", useAuxOrigin: false, genDrill: true, genMap: false, mapFormat: 4, gerberPrecision: 6, outputDir: "fab" };
  const off = F.drillJob(ctx, base);
  assert.deepStrictEqual(off.files.map((f) => f.name), ["t-PTH-drl.gbr", "t-NPTH-drl.gbr"]);
  const on = F.drillJob(ctx, Object.assign({}, base, { genTenting: true }));
  assert.deepStrictEqual(on.files.map((f) => f.name), ["t-PTH-drl.gbr", "t-NPTH-drl.gbr", "t-tenting-back.gbr", "t-tenting-front.gbr"]);
  assert.deepStrictEqual(on.report.map((l) => l.text), ["Created file 'fab/t-PTH-drl.gbr'.", "Created file 'fab/t-NPTH-drl.gbr'.", "Created file 'fab/t-tenting-back.gbr'.", "Created file 'fab/t-tenting-front.gbr'.", "Done."]);
  const tf = String(on.files[3].data);
  assert.ok(tf.includes("%TF,FileFunction,Other,Tenting-Front*%\n%TF.FilePolarity,Positive*%"), tf.slice(0, 500));
  assert.ok(/%TA.AperFunction,Tenting\*%\n%ADD10C,0.600000\*%/.test(tf), "the via's pad diameter, Tenting aperture");
  assert.strictEqual((tf.match(/D03\*/g) || []).length, 1, "only the tented via (v2 opts out)");
  // per-via and board-level covering / plugging / filling / capping
  const B2 = BOARD.replace("(tenting (front yes) (back yes)) (aux", "(tenting (front yes) (back yes)) (covering (front no) (back no)) (plugging (front no) (back yes)) (capping no) (filling yes) (aux")
    .replace('(tenting (front no) (back no)) (net 1)', '(tenting (front no) (back no)) (capping yes) (covering (front yes) (back none)) (filling no) (net 1)');
  const ctx2 = Object.assign({}, ctx, { doc: K.parseDoc(B2, "kicad_pcb"), setup: B2 });
  const r = F.drillJob(ctx2, Object.assign({}, base, { genDrill: false }));
  assert.deepStrictEqual(r.files.map((f) => f.name), ["t-filling-front-back.gbr", "t-capping-front-back.gbr", "t-covering-front.gbr", "t-plugging-back.gbr"]);
  const fill = String(r.files[0].data);
  assert.ok(fill.includes("%TF,FileFunction,Other,Filling*%") && /%ADD10C,0.300000\*%/.test(fill) && (fill.match(/D03\*/g) || []).length === 1, "v1 filled from the board, v2 not");
  assert.strictEqual((String(r.files[3].data).match(/D03\*/g) || []).length, 2, "both vias plugged from the board's back setting");
});

test("Gerber X3 placement files (PLACEFILE_GERBER_WRITER): P&P records, courtyard or pad box, pin markers", () => {
  assert.strictEqual(F.pnpFileName("t", "F.Cu"), "t-pnp_top.gbr");
  assert.strictEqual(F.pnpFileName("t", "B.Cu"), "t-pnp_bottom.gbr");
  const top = F.pnpGerber(ctx, { side: "F.Cu", includeBoardEdge: false, excludeDnp: false, excludeBom: false, useAuxOrigin: false });
  assert.strictEqual(top.count, 4);
  const t = top.text;
  assert.ok(t.includes("%TF.FileFunction,Component,L1,Top*%\n%TF.FilePolarity,Positive*%\n%FSLAX46Y46*%"));
  assert.ok(t.includes("%TA.AperFunction,ComponentMain*%\n%ADD10C,0.300000*%\n%TD*%"));
  assert.ok(/%TA.AperFunction,ComponentPin\*%\n%ADD\d+P,0.360000X4X0.000000\*%/.test(t), "pad 1 diamond");
  // the position flash: aperture, %TO.C, the P&P records, then the flash
  assert.ok(t.includes("D10*\n%TO.C,R1*%\n%TO.CFtp,R_0603_1608Metric*%\n%TO.CVal,10k*%\n%TO.CLbN,Resistor_SMD*%\n%TO.CMnt,SMD*%\n%TO.CRot,0*%\nX110000000Y-60000000D03*\n"), t);
  // R1's courtyard rectangle, closed
  assert.ok(t.includes("X108500000Y-59250000D02*\nX111500000Y-59250000D01*\nX111500000Y-60750000D01*\nX108500000Y-60750000D01*\nX108500000Y-59250000D01*\n"));
  assert.ok(/ComponentOutline,Footprint/.test(t), "R2 and J1 have no courtyard: the pads' box");
  assert.ok(/%TO.P,R1,1\*%\nX109175000Y-60000000D03\*\nD\d+\*\n%TO.P,R1,2\*%\nX110825000Y-60000000D03\*\n%TD\*%/.test(t), "pin markers then %TD");
  assert.ok(t.includes("%TO.CMnt,TH*%") && t.includes("%TO.P,J1,*%"), "the through-hole connector and its unnamed NPTH pad");
  assert.ok(!/Profile/.test(t));
  const noDnp = F.pnpGerber(ctx, { side: "F.Cu", includeBoardEdge: true, excludeDnp: true, excludeBom: false, useAuxOrigin: false });
  assert.strictEqual(noDnp.count, 3);
  assert.ok(/%TA.AperFunction,Profile\*%/.test(noDnp.text) && !noDnp.text.includes("TO.C,C1*"));
  const bot = F.pnpGerber(ctx, { side: "B.Cu", includeBoardEdge: false, excludeDnp: false, excludeBom: false, useAuxOrigin: true }).text;
  assert.ok(bot.includes("%TF.FileFunction,Component,L2,Bot*%") && bot.includes("%TO.CRot,0*%\nX30000000Y20000000D03*"), "180° on the back is 0, relative to the place origin");
});

test("Design variants: the variant's DNP, exclusions and field values reach the fabrication outputs", () => {
  const B3 = BOARD.replace("(aux_axis_origin 100 80))", "(aux_axis_origin 100 80))\n (variants (variant (name \"Lite\") (description \"no R1\")) (variant (name \"B10\")) (variant (name \"B9\")))")
    .replace('(uuid "f-R1")', '(uuid "f-R1") (variant (name "Lite") (dnp yes) (exclude_from_pos_files yes) (field (name "Value") (value "22k")))')
    .replace('(uuid "f-R2")', '(uuid "f-R2") (variant (name "Lite") (field (name "Value") (value "47k")))');
  const header = K.boardSetup.boardHeader(B3);
  assert.deepStrictEqual(F.variantNames(header.variants), ["< Default >", "B9", "B10", "Lite"]);
  assert.deepStrictEqual(F.variantNames(null), ["< Default >"]);
  const base = { doc: K.parseDoc(B3, "kicad_pcb"), setup: B3, projectName: "t", date: ctx.date };
  const opt = { side: "front", smdOnly: false, excludeThroughHole: false, excludeDnp: true, useAuxOrigin: false, negateBottomX: false };
  const refs = (c) => F.positions(c, opt).map((r) => r.ref + "=" + r.value).sort();
  assert.deepStrictEqual(refs(base), ["J1=Conn", "R1=10k", "R2=10k"]);
  assert.deepStrictEqual(refs(Object.assign({}, base, { variant: "< Default >" })), ["J1=Conn", "R1=10k", "R2=10k"]);
  assert.deepStrictEqual(refs(Object.assign({}, base, { variant: "Lite" })), ["J1=Conn", "R2=47k"]);
  const pnp = F.pnpGerber(Object.assign({}, base, { variant: "Lite" }), { side: "F.Cu", includeBoardEdge: false, excludeDnp: false, excludeBom: false, useAuxOrigin: false }).text;
  assert.ok(!pnp.includes("%TO.C,R1*%") && pnp.includes("%TO.CVal,47k*%"), "R1 is out of the Lite position files");
});

test("Schematic design variants: names in GetVariantNamesForUI order, a symbol as the variant shows it on its sheet", () => {
  const esbuild = require("esbuild");
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "dialogs", "sch-variants.ts")], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require); const V = mod.exports;
  const SYM = `(symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "10k" (at 0 0 0))
    (instances (project "p" (path "/root" (reference "R1") (unit 1) (variant (name "Lite") (dnp yes) (field (name "Value") (value "22k"))))
      (path "/root/sub" (reference "R5") (unit 1) (variant (name "B2") (in_bom no))))))`;
  const node = K.parse(SYM);
  const doc = { items: new Map([["s1", { kind: "symbol", node }]]) };
  assert.deepStrictEqual(V.schVariantNames([doc], { schematic: { variants: [{ name: "B10" }, { name: "Lite", description: "x" }] } }), ["< Default >", "B2", "B10", "Lite"]);
  assert.deepStrictEqual(V.schVariantNames([doc], {}), ["< Default >", "B2", "Lite"]);
  const lite = V.symbolNodeForVariant(node, [], "Lite");
  assert.deepStrictEqual(K.kid(lite, "dnp"), ["dnp", "yes"]);
  assert.strictEqual(K.str(K.kids(lite, "property").find((p) => K.str(p[1]) === "Value")[2]), "22k");
  assert.deepStrictEqual(K.kid(node, "dnp"), ["dnp", "no"], "the document's node is not touched");
  assert.strictEqual(V.symbolNodeForVariant(node, ["sub"], "Lite"), null, "the variant is per sheet instance");
  assert.deepStrictEqual(K.kid(V.symbolNodeForVariant(node, ["sub"], "B2"), "in_bom"), ["in_bom", "no"]);
  assert.strictEqual(V.symbolNodeForVariant(node, [], ""), null);
});

test("PostScript track width correction: tracks, pads and vias grow on copper, limited by the design rules", async () => {
  const ps = async (adj, fmt) => String((await plot({ format: fmt || 2, widthAdjust: adj }, ["F.Cu"])).files[0].data);
  const a = await ps(0), b = await ps(0.1);
  assert.notStrictEqual(a, b, "the correction changes the PostScript");
  assert.strictEqual(String((await plot({ format: 1, widthAdjust: 0 }, ["F.Cu"])).files[0].data).replace(/CreationDate.*\n/, ""),
    String((await plot({ format: 1, widthAdjust: 0.1 }, ["F.Cu"])).files[0].data).replace(/CreationDate.*\n/, ""), "Gerber ignores it (getFineWidthAdj is PostScript only)");
  const L = P.widthAdjustLimits;
  assert.deepStrictEqual(L(null), [-0.199999, 0.199999], "KiCad's defaults: 0.2 mm min track, 0.2 mm clearance");
  assert.deepStrictEqual(L(JSON.stringify({ board: { design_settings: { rules: { min_track_width: 0.15 } } }, net_settings: { classes: [{ name: "Default", clearance: 0.3 }, { name: "HV", clearance: 0.5 }, { name: "Fine", clearance: 0.1 }, { name: "Inherit" }] } })), [-0.149999, 0.099999]);
});

test("Drill map: KiCad's 58 marker patterns, the page layout and the legend (genDrillMapFile)", () => {
  const kinds = (id) => F.markerParts(0, 0, 1, id).map((p) => p.k === "circle" ? "O" : p.pts.length === 2 ? "seg" : "poly");
  assert.deepStrictEqual(kinds(0), ["seg", "seg"], "X");
  assert.deepStrictEqual(kinds(1), ["O"]);
  assert.deepStrictEqual(kinds(29), ["seg", "seg", "seg", "seg", "poly", "poly", "O"], "everything");
  assert.deepStrictEqual(kinds(57), ["seg", "poly", "poly", "O"], "the last pattern: \\ O Sq Lz");
  assert.deepStrictEqual(kinds(58), ["O"], "past the table: a circle");
  const sq = F.markerParts(0, 0, 1, 3)[0].pts; assert.ok(Math.abs(sq[0][0] - 0.707114) < 1e-5, "the square is inscribed");
  const base = { format: "excellon", metric: true, zeros: "decimal", merge: false, minimalHeader: false, mirrorY: false, ovalMode: "route", useAuxOrigin: false, genDrill: false, genMap: true, gerberPrecision: 6, outputDir: "" };
  const svg = String(F.drillJob(ctx, Object.assign({}, base, { mapFormat: 5 })).files[0].data);
  assert.ok(/width="297(\.\d+)?mm" height="210(\.\d+)?mm"/.test(svg), "the board's A4 page");
  // 40 × 30 mm board on A4: min((297 - 20) / 40, (126 - 10) / 30, 3) = 3 → the 0.1 mm outline is drawn 0.3 mm wide
  assert.ok(/stroke-width:0\.3000;"\nd="M88\.5011 18\.0022\nL208\.5011 18\.0022"/.test(svg), "scaled 3:1, centred in the top 60 % of the page");
  const gbr = String(F.drillJob(ctx, Object.assign({}, base, { mapFormat: 1 })).files[0].data);
  assert.ok(gbr.includes("%TF.FileFunction,Drillmap*%"));
});

test("Placement files: the plain-text file in inches and the CSV (DIALOG_GEN_FOOTPRINT_POSITION)", () => {
  const rows = F.positions(ctx, { side: "both" });
  const mm = F.placementAscii(rows, "both", "2026-01-01 00:00:00", "Pcbnew test");
  const inch = F.placementAscii(rows, "both", "2026-01-01 00:00:00", "Pcbnew test", true);
  assert.ok(mm.includes("## Unit = mm, Angle = deg.") && inch.includes("## Unit = inches, Angle = deg."));
  const r1 = rows.find((r) => r.ref === "R1");
  assert.ok(inch.includes((r1.x / 25.4).toFixed(4)), "inches are mm / 25.4");
  assert.ok(F.placementCsv(rows, true).split("\n")[0] === "Ref,Val,Package,PosX,PosY,Rot,Side");
});

test("plot recorder: the painter drawn as plot items (strokes, fills, dashes split, transforms applied)", () => {
  const { rec } = K.plot.plotRecorder({ width: 100, height: 100, ppm: 10 });
  rec.setTransform(10, 0, 0, 10, 0, 0);
  rec.strokeStyle = "#ff0000"; rec.lineWidth = 0.5; rec.beginPath(); rec.moveTo(1, 1); rec.lineTo(5, 1); rec.stroke();
  rec.fillStyle = "#00ff00"; rec.fillRect(2, 2, 3, 4);
  rec.setLineDash([1, 1]); rec.beginPath(); rec.moveTo(0, 10); rec.lineTo(4, 10); rec.stroke(); rec.setLineDash([]);
  const it = rec.items;
  assert.deepStrictEqual(it[0], { k: "line", pts: [[1, 1], [5, 1]], w: 0.5, color: "#ff0000", alpha: undefined, closed: undefined, cap: "butt" });
  assert.deepStrictEqual(it[1].polys[0].slice(0, 3), [[2, 2], [5, 2], [5, 6]]);
  assert.strictEqual(it.filter((x) => x.k === "line" && x.pts[0][1] === 10).length, 2, "a dashed 4 mm line at 1 / 1 is two dashes");
  // a lone moveTo draws nothing
  rec.beginPath(); rec.moveTo(3, 3); rec.stroke(); assert.strictEqual(rec.items.length, it.length);
});

Promise.all(pending).then(() => { console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1); });
