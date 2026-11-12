// web/fab/drilljob — what DIALOG_GENDRILL's Generate and Generate Report File… make
// (pcbnew/exporters/gendrill_writer_base.cpp, gendrill_excellon_writer.cpp, gendrill_gerber_writer.cpp):
//
//   Excellon      <board>-PTH.drl / -NPTH.drl (or <board>.drl merged), one per blind / buried pair
//   Gerber X2     <board>-PTH-drl.gbr / -NPTH-drl.gbr …: each hole a flash (a slot a routed stroke) with its
//                 aperture function (ViaDrill, ComponentDrill, CastellatedDrill, ComponentDrill,PressFit) and
//                 the component reference of a pad hole, FileFunction Plated|NonPlated,1,N,PTH|NPTH,Drill|Rout|Mixed
//   drill map     <drill file>-drl_map.<ext> in Postscript, Gerber X2, DXF, SVG or PDF: the board outline, each
//                 hole as its tool's marker (PLOTTER::Marker's patterns) and the legend of tools under the board
//   report        <board>-drl.rpt: the copper stackup and the tools of each file (GenDrillReportFile)
import { type Hole, boardHoles, drillFiles } from "./drill";
import { writeDxf } from "./dxf";
import { projectGuid, writeGerber } from "./gerber";
import { type FabContext, VERSION_SUFFIX, layerDisplayName, modelOf, projectNameOf } from "./index";
import type { BoardModel } from "./model";
import { primItems } from "./pageplot";
import { PlotLog, plotFile } from "./plot";
import { writePdf } from "./pdf";
import type { PlotItem, PlotPage } from "./plotter";
import { isoDateTime } from "./plotter";
import type { Prim } from "./prims";
import { writePs } from "./ps";
import { outputPath, type PlotFile, type ReportLine } from "./plotjob";
import { writeSvg } from "./svg";

export interface DrillJobRequest {
  format: "excellon" | "gerber";
  metric: boolean;
  zeros: "decimal" | "suppress_leading" | "suppress_trailing" | "keep";
  merge: boolean; minimalHeader: boolean; mirrorY: boolean;
  /** "route" (G00 … M15 G01 … M16) or the alternate G85 mode */
  ovalMode: "route" | "g85";
  useAuxOrigin: boolean;
  genDrill: boolean; genMap: boolean;
  /** the map format: PLOT_FORMAT ids 2 PS, 1 Gerber, 3 DXF, 5 SVG, 4 PDF */
  mapFormat: number;
  gerberPrecision: 5 | 6;
  outputDir: string; boardDir?: string;
}
export interface DrillJobResult { files: PlotFile[]; report: ReportLine[] }

const MAP_EXT: Record<number, string> = { 2: "ps", 1: "gbr", 3: "dxf", 5: "svg", 4: "pdf" };
const version = (ctx: FabContext): string => String((ctx.doc as unknown as { kicadVersion?: string }).kicadVersion || "10.99") + VERSION_SUFFIX;

/** A drill span: the through holes (plated or not) or a blind / buried pair. */
interface Span { name: string; holes: Hole[]; npth: boolean; mixed: boolean; from: string; to: string }
function spans(m: BoardModel, base: string, merge: boolean, gerber: boolean): Span[] {
  const holes = boardHoles(m);
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  const through = holes.filter((h) => h.from === first && h.to === last);
  const suffix = gerber ? "-drl.gbr" : ".drl";
  const pairName = (l: string): string => (l === "F.Cu" ? "front" : l === "B.Cu" ? "back" : "in" + (/^In(\d+)\.Cu$/.exec(l) || ["", "?"])[1]);
  const out: Span[] = [];
  if (merge && !gerber) out.push({ name: base + suffix, holes: through, npth: false, mixed: true, from: first, to: last });
  else out.push({ name: `${base}-PTH${suffix}`, holes: through.filter((h) => h.plated), npth: false, mixed: false, from: first, to: last });
  const pairs = new Map<string, Hole[]>();
  for (const h of holes) { if (h.from === first && h.to === last) continue; const k = h.from + "|" + h.to; const l = pairs.get(k); if (l) l.push(h); else pairs.set(k, [h]); }
  for (const [k, hs] of pairs) { const [a, b] = k.split("|"); out.push({ name: `${base}-${pairName(a)}-${pairName(b)}${suffix}`, holes: hs, npth: false, mixed: false, from: a, to: b }); }
  if (!(merge && !gerber)) out.push({ name: `${base}-NPTH${suffix}`, holes: through.filter((h) => !h.plated), npth: true, mixed: false, from: first, to: last });
  return out;
}

/** The tool list of a hole set: by diameter, plated before not, as buildHolesList sorts it. */
interface Tool { d: number; plated: boolean; count: number; slots: number; attr: number }
function toolsOf(holes: Hole[]): { tools: Tool[]; toolOf: number[]; sorted: Hole[] } {
  const sorted = holes.slice().sort((a, b) => a.d - b.d || (a.plated === b.plated ? 0 : a.plated ? -1 : 1) || a.attr - b.attr || a.x - b.x || a.y - b.y);
  const tools: Tool[] = [], toolOf: number[] = [];
  for (const h of sorted) {
    let i = tools.findIndex((t) => Math.abs(t.d - h.d) < 1e-6 && t.plated === h.plated && t.attr === h.attr);
    if (i < 0) { tools.push({ d: h.d, plated: h.plated, count: 0, slots: 0, attr: h.attr }); i = tools.length - 1; }
    tools[i].count++; if (h.slot) tools[i].slots++; toolOf.push(i);
  }
  return { tools, toolOf, sorted };
}

const fileFunction = (s: Span, m: BoardModel): string => {
  const a = m.copper.indexOf(s.from) + 1, b = m.copper.indexOf(s.to) + 1, n = m.copper.length;
  let t = (s.npth ? "NonPlated," : s.mixed ? "MixedPlating," : "Plated,") + `${a},${b}`;
  if (s.npth) t += ",NPTH"; else if (!s.mixed) t += a === 1 && b === n ? ",PTH" : a === 1 || b === n ? ",Blind" : ",Buried";
  const oblong = s.holes.some((h) => h.slot), round = s.holes.some((h) => !h.slot);
  return t + (oblong && round ? ",Mixed" : oblong ? ",Rout" : ",Drill");
};

/** One Gerber X2 drill file. */
function gerberDrill(s: Span, m: BoardModel, ctx: FabContext, req: DrillJobRequest, date: string, refOf: (h: Hole) => string): string {
  const prims: Prim[] = [];
  for (const h of toolsOf(s.holes).sorted) {
    const via = h.attr === 1 || h.attr === 2;
    const af = via ? "ViaDrill" : h.attr === 5 ? "CastellatedDrill" : h.attr === 6 ? "ComponentDrill,PressFit" : "ComponentDrill";
    const meta = via ? { af } : { af, info: 4, ref: refOf(h) };
    if (h.slot) {
      const half = Math.abs(h.slot.w - h.slot.h) / 2, r = h.slot.rot * Math.PI / 180, along = h.slot.w >= h.slot.h ? 0 : Math.PI / 2;
      const c = Math.cos(along - r) * half, sn = Math.sin(along - r) * half;
      prims.push({ k: "seg", x1: h.x - c, y1: h.y - sn, x2: h.x + c, y2: h.y + sn, w: h.d, meta } as Prim);
    } else prims.push({ k: "circle", x: h.x, y: h.y, d: h.d, meta } as Prim);
  }
  const board = projectNameOf(ctx);
  return writeGerber(prims, { fileFunction: fileFunction(s, m), polarity: "Positive" }, { x2: true, origin: req.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad,Pcbnew,${version(ctx)}`, date,
    project: { name: board, guid: projectGuid(board + ".kicad_pcb"), rev: (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?" }, precision: req.gerberPrecision, netAttributes: true });
}

// ---------------------------------------------------------------- the drill map
/** PLOTTER::Marker's patterns: bits / \ | - lozenge square circle (plotter.cpp marker_patterns). */
const MARKERS = [0o003, 0o100, 0o014, 0o040, 0o020, 0o103, 0o017, 0o043, 0o023, 0o114, 0o140, 0o120, 0o054, 0o034, 0o060, 0o117, 0o143, 0o123, 0o057, 0o037, 0o063, 0o154, 0o134, 0o160, 0o074, 0o157, 0o137, 0o163, 0o077, 0o174, 0o177];
function marker(x: number, y: number, d: number, idx: number, color: string, out: PlotItem[]): void {
  const r = d / 2, w = Math.max(0.05, d / 10), bits = MARKERS[idx % MARKERS.length];
  const line = (pts: number[][]): void => { out.push({ k: "line", pts, w, color, cap: "round" } as PlotItem); };
  if (bits & 0o001) line([[x - r, y + r], [x + r, y - r]]);
  if (bits & 0o002) line([[x - r, y - r], [x + r, y + r]]);
  if (bits & 0o004) line([[x, y - r], [x, y + r]]);
  if (bits & 0o010) line([[x - r, y], [x + r, y]]);
  if (bits & 0o020) line([[x, y - r], [x + r, y], [x, y + r], [x - r, y], [x, y - r]]);
  if (bits & 0o040) line([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r]]);
  if (bits & 0o100) out.push({ k: "circle", x, y, r, w, fill: false, color } as PlotItem);
}
interface RecLike { items: PlotItem[]; font: string; fillStyle: string; fillText(t: string, x: number, y: number): void }
const recorder = (w: number, hgt: number): RecLike | null => {
  const K = (globalThis as unknown as { KiCadCanvas?: { plot?: { PlotRecorder: new (w: number, h: number, m: number[]) => RecLike } } }).KiCadCanvas;
  return K && K.plot ? new K.plot.PlotRecorder(w, hgt, [1, 0, 0, 1, 0, 0]) : null;
};
/** genDrillMapFile: the page at 1:1 (centred when the board is off the page), outline, markers and the tool legend. */
function mapPage(m: BoardModel, s: Span, ctx: FabContext, log: PlotLog): PlotPage {
  const doc = ctx.doc as unknown as { page: number[]; bbox?: number[] };
  const W = doc.page[0], H = doc.page[1];
  const edge = plotFile(m, "Edge.Cuts", { plotReference: false, plotValue: false, subtractMaskFromSilk: false }, log);
  const items: PlotItem[] = [];
  primItems(edge, { offset: [0, 0], scale: 1, mirror: false, pageW: W }, "#000000", "#FFFFFF", items);
  const { tools, toolOf, sorted } = toolsOf(s.holes);
  sorted.forEach((h, i) => {
    marker(h.x, h.y, h.d, toolOf[i], "#000000", items);
    if (h.slot) {
      const half = Math.abs(h.slot.w - h.slot.h) / 2, r = h.slot.rot * Math.PI / 180, along = h.slot.w >= h.slot.h ? 0 : Math.PI / 2;
      const c = Math.cos(along - r) * half, sn = Math.sin(along - r) * half;
      items.push({ k: "line", pts: [[h.x - c, h.y - sn], [h.x + c, h.y + sn]], w: 0.1, color: "#000000", cap: "round" } as PlotItem);
    }
  });
  // the legend under the board's outline: one line per tool, its marker then "<d>mm <d>" <n> holes"
  const bb = doc.bbox && doc.bbox.length === 4 ? doc.bbox : [0, 0, W, H];
  const rec = recorder(W, H);
  let y = bb[3] + 5;
  const text = (t: string, x: number, yy: number): void => { if (rec) { rec.font = "2.5px sans-serif"; rec.fillStyle = "#000000"; rec.fillText(t, x, yy); } };
  text("Drill Map:", bb[0], y); y += 4;
  tools.forEach((t, i) => {
    marker(bb[0] + 2, y - 1, 2, i, "#000000", items);
    const holes = t.count === 1 ? "1 hole" : `${t.count} holes`;
    text(`${t.d.toFixed(3)}mm  ${(t.d / 25.4).toFixed(4)}"  (${holes}${t.slots ? `, with ${t.slots} slot${t.slots > 1 ? "s" : ""}` : ""})${t.plated ? "" : " (not plated)"}`, bb[0] + 5, y);
    y += 4;
  });
  if (rec) items.push(...rec.items);
  return { w: W, h: H, name: s.name, items };
}

/** CreateDrillandMapFilesSet. */
export function drillJob(ctx: FabContext, req: DrillJobRequest): DrillJobResult {
  const m = modelOf(ctx), board = projectNameOf(ctx), log = new PlotLog();
  const files: PlotFile[] = [], report: ReportLine[] = [];
  const date = isoDateTime(ctx.date || new Date());
  const path = (n: string): string => outputPath(req.outputDir, req.boardDir, n);
  const gerber = req.format === "gerber";
  const refs = new Map<string, string>();
  for (const fp of m.footprints) for (const p of fp.pads) refs.set(`${p.x.toFixed(4)},${p.y.toFixed(4)}`, fp.ref);
  const refOf = (h: Hole): string => refs.get(`${h.x.toFixed(4)},${h.y.toFixed(4)}`) || "";
  const sp = spans(m, board, req.merge, gerber);
  if (req.genDrill) {
    if (gerber) {
      for (const s of sp) {
        if (!s.holes.length && !s.npth && s.from !== m.copper[0]) continue;
        const n = s.name; files.push({ name: n, path: path(n), data: gerberDrill(s, m, ctx, req, date, refOf) });
        report.push({ severity: "action", text: `Created file '${path(n)}'` });
      }
    } else {
      const set = drillFiles(m, board, { metric: req.metric, zeros: req.zeros, merge: req.merge, minimalHeader: req.minimalHeader, mirrorY: req.mirrorY, ovalMode: req.ovalMode,
        origin: req.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad ${version(ctx)}`, softwareAttr: `Kicad,Pcbnew,${version(ctx)}`, date });
      for (const f of set) { files.push({ name: f.name, path: path(f.name), data: f.text }); report.push({ severity: "action", text: `Created file '${path(f.name)}'` }); }
    }
  }
  if (req.genMap) {
    for (const s of sp) {
      if (!s.holes.length && !s.npth && !(s.from === m.copper[0] && s.to === m.copper[m.copper.length - 1])) continue;
      const ext = MAP_EXT[req.mapFormat] || "pdf";
      const n = s.name.replace(/(-drl)?\.(drl|gbr)$/, "") + "-drl_map." + ext;
      const page = mapPage(m, s, ctx, log);
      let data: string | Uint8Array;
      if (req.mapFormat === 1) {
        const prims: Prim[] = [];
        for (const it of page.items) {
          if (it.k === "line") for (let i = 0; i + 1 < it.pts.length; i++) prims.push({ k: "seg", x1: it.pts[i][0], y1: it.pts[i][1], x2: it.pts[i + 1][0], y2: it.pts[i + 1][1], w: it.w || 0.1 } as Prim);
          else if (it.k === "circle") prims.push({ k: "arc", cx: it.x, cy: it.y, r: it.r, a0: 0, a1: 2 * Math.PI, acw: false, w: it.w || 0.1 } as Prim);
        }
        data = writeGerber(prims, { fileFunction: `Drillmap`, polarity: "Positive" }, { x2: true, origin: [0, 0], software: `KiCad,Pcbnew,${version(ctx)}`, date, precision: req.gerberPrecision,
          project: { name: board, guid: projectGuid(board + ".kicad_pcb"), rev: (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?" } });
      } else if (req.mapFormat === 3) data = writeDxf([{ name: "0", color: "#000000", page }], { polygonMode: false });
      else if (req.mapFormat === 5) data = writeSvg(page, { precision: 4, creator: "PCBNEW", fileName: n, date: ctx.date || new Date() });
      else if (req.mapFormat === 2) data = writePs({ pages: [page], creator: "PCBNEW", date: ctx.date || new Date() }, { scaleX: 1, scaleY: 1, fileName: n, date: ctx.date || new Date() });
      else data = writePdf({ pages: [page], creator: "PCBNEW", date: ctx.date || new Date(), fileName: n, title: (ctx.doc.titleBlock && ctx.doc.titleBlock.title) || "" });
      files.push({ name: n, path: path(n), data });
      report.push({ severity: "action", text: `Created file '${path(n)}'.` });
    }
  }
  report.push({ severity: "info", text: "Done." });
  return { files, report };
}

/** GenDrillReportFile: <board>-drl.rpt. */
export function drillReport(ctx: FabContext, o: { merge: boolean; gerber: boolean }): string {
  const m = modelOf(ctx), board = projectNameOf(ctx);
  const sep = "    =============================================================\n";
  const L: string[] = [`Drill report for ${board}.kicad_pcb\n`, `Created on ${isoDateTime(ctx.date || new Date())}\n\n`, "Copper Layer Stackup:\n", sep];
  const generic = (l: string, i: number): string => (i === 0 ? "front" : i === m.copper.length - 1 ? "back" : "in" + i);
  m.copper.forEach((l, i) => L.push(`    L${String(i + 1).padEnd(2)}:  ${layerDisplayName(ctx.doc, l).padEnd(25)} ${generic(l, i)}\n`));
  L.push("\n\n");
  const summary = (holes: Hole[], plated: boolean | null): number => {
    const { tools } = toolsOf(holes); let total = 0;
    tools.forEach((t, i) => {
      if (plated !== null && t.plated !== plated) return;
      let s = `    T${i + 1}  ${t.d.toFixed(3)}mm  ${(t.d / 25.4).toFixed(4)}"  `;
      if (t.count === 1 && !t.slots) s += "(1 hole";
      else if (t.count === 1) s += "(1 hole)  (with 1 slot";
      else if (!t.slots) s += `(${t.count} holes)`;
      else if (t.slots === 1) s += `(${t.count} holes)  (with 1 slot`;
      else s += `(${t.count} holes)  (with ${t.slots} slots`;
      if (t.attr === 5) s += ", castellated"; if (t.attr === 6) s += ", press-fit";
      L.push(s + ")\n"); total += t.count;
    });
    L.push("\n"); return total;
  };
  const sp = spans(m, board, o.merge, o.gerber);
  for (const s of sp.filter((x) => !x.npth)) {
    L.push(`Drill file '${s.name}' contains\n`);
    const through = s.from === m.copper[0] && s.to === m.copper[m.copper.length - 1];
    if (through) L.push("    plated through holes:\n");
    else L.push(`    holes connecting layer pair: '${layerDisplayName(ctx.doc, s.from)} and ${layerDisplayName(ctx.doc, s.to)}' (${s.from === m.copper[0] || s.to === m.copper[m.copper.length - 1] ? "blind" : "buried"} vias):\n`);
    L.push(sep);
    L.push(`    Total plated holes count ${summary(s.holes, true)}\n`, "\n\n");
  }
  const npth = sp.find((x) => x.npth);
  if (o.merge && !o.gerber) L.push("Not plated through holes are merged with plated holes\n");
  else L.push(`Drill file '${npth ? npth.name : board + "-NPTH.drl"}' contains\n`);
  L.push("    unplated through holes:\n", sep);
  const all = o.merge && !o.gerber ? sp[0].holes : npth ? npth.holes : [];
  L.push(`    Total unplated holes count ${summary(all, false)}\n`);
  return L.join("");
}
