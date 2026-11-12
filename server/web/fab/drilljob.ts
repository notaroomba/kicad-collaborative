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
import { primPolys } from "./poly";
import { PlotLog, plotFile, strokeTextPrims } from "./plot";
import { writePdf } from "./pdf";
import type { PlotItem, PlotPage } from "./plotter";
import { isoDateTime, toPage } from "./plotter";
import type { Prim, Pt } from "./prims";
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
  /** "Generate tenting layers" (Gerber X2 only): the -tenting-front / -tenting-back protection files */
  genTenting?: boolean;
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

// ---------------------------------------------------------------- IPC-4761 via protection files
/** IPC4761_FEATURES, as GERBER_WRITER::createProtectionFile names and filters them. */
type Feature = "filled" | "capped" | "coverBack" | "coverFront" | "plugBack" | "plugFront" | "tentBack" | "tentFront";
const FEATURE: Record<Feature, { func: string; af: string; file: string; side: 0 | 1 | 2 }> = {
  capped: { func: "Capping", af: "Capping", file: "capping", side: 0 }, filled: { func: "Filling", af: "Filling", file: "filling", side: 0 },
  coverBack: { func: "Covering-Back", af: "Covering", file: "covering", side: 2 }, coverFront: { func: "Covering-Front", af: "Covering", file: "covering", side: 1 },
  plugBack: { func: "Plugging-Back", af: "Plugging", file: "plugging", side: 2 }, plugFront: { func: "Plugging-Front", af: "Plugging", file: "plugging", side: 1 },
  tentBack: { func: "Tenting-Back", af: "Tenting", file: "tenting", side: 2 }, tentFront: { func: "Tenting-Front", af: "Tenting", file: "tenting", side: 1 },
};
/** The resolved mode of one via (PCB_VIA::Resolve…Mode): its own value, else the board's setup.  A front / back
 *  mode only counts when the via reaches that outer layer (drill_enumerator.cpp's m_TopCovered … flags). */
export function viaHasFeature(h: Hole, f: Feature, m: BoardModel): boolean {
  const v = h.via; if (!v) return false;
  const s = m.settings, top = h.from === m.copper[0], bot = h.to === m.copper[m.copper.length - 1];
  const r = (own: boolean | null, dflt: boolean): boolean => (own !== null ? own : dflt);
  switch (f) {
    case "filled": return r(v.filled, s.fillVias);
    case "capped": return r(v.capped, s.capVias);
    case "coverFront": return top && r(v.coverFront, s.coverFront);
    case "coverBack": return bot && r(v.coverBack, s.coverBack);
    case "plugFront": return top && r(v.plugFront, s.plugFront);
    case "plugBack": return bot && r(v.plugBack, s.plugBack);
    case "tentFront": return top && r(v.tentFront, s.tentFront);
    case "tentBack": return bot && r(v.tentBack, s.tentBack);
  }
}
const generic = (l: string, m: BoardModel): string => (l === m.copper[0] ? "front" : l === m.copper[m.copper.length - 1] ? "back" : "in" + m.copper.indexOf(l));
/** getProtectionFileName: <board>-filling-front-back.gbr, <board>-tenting-front.gbr … */
function protectionName(base: string, f: Feature, from: string, to: string, m: BoardModel): string {
  const d = FEATURE[f];
  const tail = d.side === 0 ? `${generic(from, m)}-${generic(to, m)}` : generic(d.side === 1 ? from : to, m);
  return `${base}-${d.file}-${tail}.gbr`;
}
/** createProtectionFile: one flash per via with the feature, the via's pad on that side for covering and tenting. */
function protectionFile(holes: Hole[], f: Feature, m: BoardModel, ctx: FabContext, req: DrillJobRequest, date: string): string {
  const d = FEATURE[f], prims: Prim[] = [];
  for (const h of holes) {
    if (!h.via || !viaHasFeature(h, f, m)) continue;
    const v = h.via;
    const padOn = (l: string): number => (v.sizes && v.sizes.get(l)) || v.size;
    const dia = f === "coverBack" || f === "tentBack" ? padOn(v.layers[v.layers.length - 1]) : f === "coverFront" || f === "tentFront" ? padOn(v.layers[0]) : h.d;
    prims.push({ k: "circle", x: h.x, y: h.y, d: dia, meta: { af: d.af } } as Prim);
  }
  const board = projectNameOf(ctx);
  return writeGerber(prims, { fileFunction: "", polarity: "Positive", fileFunctionLine: `%TF,FileFunction,Other,${d.func}*%` }, { x2: true, origin: req.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad,Pcbnew,${version(ctx)}`, date,
    project: { name: board, guid: projectGuid(board + ".kicad_pcb"), rev: (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?" }, precision: req.gerberPrecision, netAttributes: true });
}

// ---------------------------------------------------------------- the drill map
/** DRILL_MARKERS::marker_patterns (common/plotters/drill_markers.cpp): bits / \\ | - lozenge square circle. */
export const MARKER_PATTERNS = [0o003, 0o100, 0o014, 0o040, 0o020, 0o103, 0o017, 0o043, 0o023, 0o114, 0o140, 0o120, 0o054, 0o034, 0o060,
  0o117, 0o143, 0o123, 0o057, 0o037, 0o063, 0o154, 0o134, 0o074, 0o174, 0o163, 0o157, 0o137, 0o077, 0o177,
  0o110, 0o104, 0o101, 0o050, 0o044, 0o041, 0o030, 0o024, 0o021, 0o150, 0o144, 0o141, 0o130, 0o124, 0o121, 0o070, 0o064, 0o061, 0o170, 0o164, 0o161,
  0o102, 0o042, 0o022, 0o142, 0o122, 0o062, 0o162];
/** DRILL_MARKERS::BuildMarker: the parts of marker `id` of radius r at (x, y), board frame; past the table a plain circle. */
export function markerParts(x: number, y: number, r: number, id: number): ({ k: "line"; pts: Pt[] } | { k: "circle"; r: number })[] {
  if (id >= MARKER_PATTERNS.length) return [{ k: "circle", r }];
  const pat = MARKER_PATTERNS[id], out: ({ k: "line"; pts: Pt[] } | { k: "circle"; r: number })[] = [];
  if (pat & 0o001) out.push({ k: "line", pts: [[x - r, y - r], [x + r, y + r]] });
  if (pat & 0o002) out.push({ k: "line", pts: [[x + r, y - r], [x - r, y + r]] });
  if (pat & 0o004) out.push({ k: "line", pts: [[x, y - r], [x, y + r]] });
  if (pat & 0o010) out.push({ k: "line", pts: [[x - r, y], [x + r, y]] });
  if (pat & 0o020) out.push({ k: "line", pts: [[x, y + r], [x + r, y], [x, y - r], [x - r, y], [x, y + r]] });
  if (pat & 0o040) { const q = Math.round(r / 1.4142 * 1e6) / 1e6; out.push({ k: "line", pts: [[x + q, y + q], [x + q, y - q], [x - q, y - q], [x - q, y + q], [x + q, y + q]] }); }
  if (pat & 0o100) out.push({ k: "circle", r });
  return out;
}
/** getMarkerBestPenSize: a tenth of the marker, at least 0.1 mm. */
const markerPen = (d: number): number => Math.max(d / 10, 0.1);
const nmRound = (v: number): number => Math.round(v * 1e6) / 1e6;

/** GENDRILL_WRITER_BASE::genDrillMapFile: the board outline, a marker per hole (and the outline of each slot) and
 *  the legend of tools under the board.  PS / PDF / SVG fit the board in the top 60 % of the page (10 mm margins,
 *  at most 3:1) and wrap the legend into columns above the bottom margin; Gerber and DXF are 1:1 from the drill origin. */
export function mapPage(m: BoardModel, s: Span, ctx: FabContext, log: PlotLog, format: number, offset: Pt): PlotPage {
  const doc = ctx.doc as unknown as { page: number[]; bbox?: number[] };
  const W = doc.page[0], H = doc.page[1];
  const edge = plotFile(m, "Edge.Cuts", { plotReference: false, plotValue: false, subtractMaskFromSilk: false }, log);
  // GetBoardEdgesBoundingBox
  let bb: number[] | null = null;
  for (const p of edge) for (const poly of primPolys(p)) for (const q of poly) bb = bb ? [Math.min(bb[0], q[0]), Math.min(bb[1], q[1]), Math.max(bb[2], q[0]), Math.max(bb[3], q[1])] : [q[0], q[1], q[0], q[1]];
  if (!bb) bb = doc.bbox && doc.bbox.length === 4 ? doc.bbox : [0, 0, W, H];
  const bw = Math.max(bb[2] - bb[0], 1e-6), bh = Math.max(bb[3] - bb[1], 1e-6), cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  let scale = 1, off: Pt = offset, bottomLimit = 0;
  if (format === 2 || format === 4 || format === 5) {
    const margin = 10, ypage = Math.round(H * 0.6 * 1e6) / 1e6;
    scale = Math.min((W - 2 * margin) / bw, (ypage - margin) / bh, 3);
    off = [nmRound(cx - W / 2 / scale), nmRound(cy - ypage / 2 / scale)];
    bottomLimit = (H - margin) / Math.min(scale, 1);
  }
  const vp = { offset: off, scale, mirror: false, pageW: W };
  const items: PlotItem[] = [];
  const P = (q: Pt): Pt => toPage(vp, q[0], q[1]);
  const black = "#000000";
  const marker = (x: number, y: number, d: number, id: number, pen: number): void => {
    for (const part of markerParts(x, y, d / 2, id)) {
      if (part.k === "line") items.push({ k: "line", pts: part.pts.map(P), w: pen * scale, color: black, cap: "round" } as PlotItem);
      else { const c = P([x, y]); items.push({ k: "circle", x: c[0], y: c[1], r: part.r * scale, w: pen * scale, fill: false, color: black } as PlotItem); }
    }
  };
  // the outline, drawn as Dwgs.User items with their own widths
  primItems(edge.map((p) => Object.assign({}, p, { clear: undefined })), vp, black, "#FFFFFF", items);
  // plotDrillMarks
  const { tools, toolOf, sorted } = toolsOf(s.holes);
  sorted.forEach((h, i) => {
    marker(h.x, h.y, h.d, toolOf[i], markerPen(h.d));
    if (h.slot) {
      const ring = primPolys({ k: "oval", x: h.x, y: h.y, w: h.slot.w, h: h.slot.h, rot: h.slot.rot } as Prim)[0];
      if (ring) items.push({ k: "line", pts: ring.concat([ring[0]]).map(P), w: 0.1 * scale, color: black, cap: "round" } as PlotItem);
    }
  });
  // the list of symbols used
  const charSize = 2, charScale = Math.min(1, 1 / scale), textMargin = 2;
  const csz = nmRound(charSize * charScale), textW = nmRound(csz / 10);
  let interval = csz + textW;
  let plotX = nmRound(bb[0] + textMargin * charScale), plotY = bb[3] + interval;
  const text = (t: string, x: number, y: number): void => primItems(strokeTextPrims(t, x, y, csz, textW, "left", "middle"), vp, black, "#FFFFFF", items);
  text("Drill Map:", plotX, plotY);
  let maxLineLen = 0;
  tools.forEach((t, i) => {
    if (!t.count) return;
    plotY += interval;
    if (bottomLimit && plotY + interval > bottomLimit) { plotY = bb![3] + interval; plotX += maxLineLen + 10; maxLineLen = 0; }
    const plotDiam = Math.min(t.d, csz);
    const x = plotX - textMargin * charScale - plotDiam / 2, y = plotY + csz;
    marker(x, y, plotDiam, i, markerPen(plotDiam));
    let msg = `${t.d.toFixed(3)}mm / ${(t.d / 25.4).toFixed(4)}" `;
    const extra = t.attr === 5 ? ", castellated" : t.attr === 6 ? ", press-fit" : "";
    const holes = t.count - t.slots;
    msg += t.count === 1 && !t.slots ? `(1 hole${extra})` : t.count === 1 ? `(1 slot${extra})` : !t.slots ? `(${t.count} holes${extra})`
      : t.slots === 1 ? `(${holes} holes + 1 slot${extra})` : `(${holes} holes + ${t.slots} slots${extra})`;
    if (!t.plated) msg += " (not plated)";
    text(msg, plotX, y);
    interval = nmRound((csz + textW) * 1.2);
    if (interval < plotDiam + 1 / scale + textW) interval = plotDiam + 1 / scale + textW;
    maxLineLen = Math.max(maxLineLen, msg.length * (csz + textW) + plotDiam);
  });
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
    if (!gerber) {
      const set = drillFiles(m, board, { metric: req.metric, zeros: req.zeros, merge: req.merge, minimalHeader: req.minimalHeader, mirrorY: req.mirrorY, ovalMode: req.ovalMode,
        origin: req.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad ${version(ctx)}`, softwareAttr: `Kicad,Pcbnew,${version(ctx)}`, date });
      for (const f of set) { files.push({ name: f.name, path: path(f.name), data: f.text }); report.push({ severity: "action", text: `Created file '${path(f.name)}'` }); }
    }
  }
  if (gerber) {
    // GERBER_WRITER::CreateDrillandMapFilesSet: per span the drill file, then (plated spans) the filling and capping
    // files; then the covering, plugging (and, asked for, tenting) files of every via reaching an outer layer
    const writeProtection = (f: Feature, holes: Hole[], from: string, to: string): void => {
      if (!holes.some((h) => viaHasFeature(h, f, m))) return;
      const n = protectionName(board, f, from, to, m);
      files.push({ name: n, path: path(n), data: protectionFile(holes, f, m, ctx, req, date) });
      report.push({ severity: "action", text: `Created file '${path(n)}'.` });
    };
    const side: Hole[] = [];
    for (const s of sp) {
      if (!s.holes.length) continue;
      if (req.genDrill) {
        const n = s.name; files.push({ name: n, path: path(n), data: gerberDrill(s, m, ctx, req, date, refOf) });
        report.push({ severity: "action", text: `Created file '${path(n)}'.` });
      }
      if (s.npth) continue;
      for (const h of toolsOf(s.holes).sorted) if (h.via) side.push(h);
      writeProtection("filled", toolsOf(s.holes).sorted, s.from, s.to);
      writeProtection("capped", toolsOf(s.holes).sorted, s.from, s.to);
    }
    const feats: Feature[] = ["coverBack", "coverFront", "plugBack", "plugFront"];
    if (req.genTenting) feats.push("tentBack", "tentFront");
    for (const f of feats) writeProtection(f, side, m.copper[0], m.copper[m.copper.length - 1]);
  }
  if (req.genMap) {
    for (const s of sp) {
      if (!s.holes.length && !s.npth && !(s.from === m.copper[0] && s.to === m.copper[m.copper.length - 1])) continue;
      const ext = MAP_EXT[req.mapFormat] || "pdf";
      const n = s.name.replace(/(-drl)?\.(drl|gbr)$/, "") + "-drl_map." + ext;
      const page = mapPage(m, s, ctx, log, req.mapFormat, req.useAuxOrigin ? m.settings.auxOrigin : [0, 0]);
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
