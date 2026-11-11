// web/fab/presets — what each fabricator wants in the package, as one named set of options.
//
//   KiCad      pcbnew's own defaults (Plot dialog, Generate Drill Files, Generate Placement Files): every
//              plottable layer the board uses, X2 attributes, separate PTH / NPTH drill files.
//   JLCPCB     the layers JLCPCB's ordering page reads, Protel extensions, X1-compatible attributes, drill and
//              placement relative to the drill / place origin, the solder mask cleared out of the legend, and
//              the BOM and CPL column layouts of their assembly service (Designator / Mid X / Mid Y /
//              Rotation / Layer, with their rotation convention for the bottom side and common packages).
//   PCBWay     the same Gerber and drill conventions, and the BOM and centroid columns of PCBWay's assembly
//              templates.
//
// The JLCPCB conventions follow the open-source Fabrication Toolkit plugin (bennymeg/Fabrication-Toolkit,
// Apache-2.0), which JLCPCB recommends for KiCad; its package rotation table is reproduced in JLC_ROTATIONS.
import { type BoardModel, type Footprint } from "./model";
import { type BomLine, type Placement, bomCsv, csvField, fieldOf, padsCentre, placementCsv } from "./parts";
import { type Pt } from "./prims";

export interface FabPreset {
  id: string; name: string; blurb: string;
  /** Which layers go into the package (canonical names), given the board's enabled layers. */
  layers(enabled: string[], copper: string[]): string[];
  protelExtensions: boolean; x2: boolean; useAuxOrigin: boolean; subtractMaskFromSilk: boolean;
  plotReference: boolean; plotValue: boolean;
  drill: { merge: boolean; zeros: "decimal" | "suppress_leading" | "suppress_trailing" | "keep"; metric: boolean; ovalMode: "route" | "g85"; minimalHeader: boolean };
  /** Leave "do not populate" parts out of the BOM and the placement file. */
  excludeDnp: boolean;
  /** Placement and BOM writers; file names are relative to the package. */
  placementName: string; bomName: string;
  placementCsv(rows: Placement[], m: BoardModel, origin: Pt): string;
  bomCsv(lines: BomLine[], m: BoardModel): string;
  /** Gerbers and drill files go into an inner archive of this name when set (what the upload form takes). */
  gerberArchive: string | null;
  /** Where the package is uploaded. */
  orderUrl: string;
}

const FAB_LAYERS = ["F.Cu", "B.Cu", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts"];
/** Copper (all of it), paste, legend, mask and the outline: what a fabricator builds from. */
function fabLayers(enabled: string[], copper: string[]): string[] {
  const inner = copper.filter((l) => l !== "F.Cu" && l !== "B.Cu");
  const want = ["F.Cu", ...inner, ...FAB_LAYERS.slice(1)];
  return want.filter((l) => enabled.includes(l) || copper.includes(l));
}
/** Every layer KiCad's Plot dialog ticks by default: copper and the technical layers, not the user drawing layers. */
function kicadLayers(enabled: string[], copper: string[]): string[] {
  const inner = copper.filter((l) => l !== "F.Cu" && l !== "B.Cu");
  const want = ["F.Cu", ...inner, "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
  return want.filter((l) => enabled.includes(l) || copper.includes(l));
}

// ---------------------------------------------------------------- JLCPCB
/** Package-name patterns and the rotation JLCPCB's library adds to KiCad's (Fabrication Toolkit's transformations.csv). */
export const JLC_ROTATIONS: [RegExp, number][] = ([
  ["^Bosch_LGA-", 90], ["^CP_EIA-", 180], ["^CP_Elec_", 180], ["^C_Elec_", 180], ["^DFN-", 270], ["^D_SOT-23", 180], ["^HTSSOP-", 270], ["^JST_GH_SM", 180], ["^JST_PH_S", 180],
  ["^LQFP-", 270], ["^MSOP-", 270], ["^PowerPAK_SO-8_Single", 270], ["^QFN-", 90], ["^R_Array_Concave_", 90], ["^R_Array_Convex_", 90], ["^SC-74-6", 180], ["^SOIC-", 270],
  ["^SOIC127P798X216-8N", -90], ["^SOP-(?!18_)", 270], ["^SOP-18_", 0], ["^SOP-4_", 0], ["^SOT-143", 180], ["^SOT-223", 180], ["^SOT-23", 180], ["^SOT-353", 180], ["^SOT-363", 180],
  ["^SOT-89", 180], ["^SSOP-", 270], ["^SW_SPST_B3", 90], ["^TDSON-8-1", 270], ["^TO-277", 90], ["^TQFP-", 270], ["^TSOT-23", 180], ["^TSSOP-", 270], ["^UDFN-10", 270], ["^USON-10", 270],
  ["^VSON-8_", 270], ["^VSSOP-10_-", 270], ["^VSSOP-8_", 180], ["^qfn-", 90]] as [string, number][]).map(([re, r]) => [new RegExp(re), r]);

const ROT_FIELDS = ["FT Rotation Offset", "JLCPCB Rotation Offset", "JLC Rotation Offset", "Rotation Offset", "RotOffset"];
const POS_FIELDS = ["FT Position Offset", "JLCPCB Position Offset", "Position Offset", "PosOffset"];
const ORIGIN_FIELDS = ["FT Origin", "Origin"];
const LAYER_FIELDS = ["FT Layer Override", "Layer Override", "LayerOverride"];

const f4 = (v: number): string => { const s = v.toFixed(4); return s === "-0.0000" ? "0.0000" : s; };

/** One JLCPCB placement row: position (anchor for SMD, pad centre for through-hole), their rotation, the side. */
export function jlcPlacement(fp: Footprint, origin: Pt): { x: number; y: number; rot: number; layer: string } {
  const side = fieldOf(fp, LAYER_FIELDS).toLowerCase();
  const layer = side === "top" || side === "bottom" ? side : fp.side === "B.Cu" ? "bottom" : "top";
  const o = fieldOf(fp, ORIGIN_FIELDS).toLowerCase();
  const centre = o === "center" || o === "centre" ? true : o === "anchor" ? false : !fp.smd;
  const p = centre ? padsCentre(fp) : [fp.x, fp.y] as Pt;
  let x = p[0] - origin[0], y = -(p[1] - origin[1]);
  const off = fieldOf(fp, POS_FIELDS).split(",").map(Number);
  if (off.length === 2 && isFinite(off[0]) && isFinite(off[1])) {
    const r = fp.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    if (layer === "bottom") { x += off[0] * c + off[1] * s; y += off[0] * s - off[1] * c; } else { x += off[0] * c - off[1] * s; y += off[0] * s + off[1] * c; }
  }
  // JLCPCB reads the rotation as seen from above the part: a bottom-side part is mirrored and half a turn out
  let r = fp.rot; if (layer === "bottom") r = 180 - r;
  for (const [re, add] of JLC_ROTATIONS) if (re.test(fp.name)) { r += add; break; }
  const manual = Number(fieldOf(fp, ROT_FIELDS)); if (isFinite(manual)) r += manual;
  return { x, y, rot: ((r % 360) + 360) % 360, layer };
}

/** Duplicate designators get _2, _3 … so every row stays addressable (the toolkit does the same). */
function uniqueRefs(fps: Footprint[]): Map<Footprint, string> {
  const count = new Map<string, number>(); for (const fp of fps) count.set(fp.ref.toUpperCase(), (count.get(fp.ref.toUpperCase()) || 0) + 1);
  const out = new Map<Footprint, string>();
  for (const fp of fps) { const k = fp.ref.toUpperCase(); const n = count.get(k) || 1; if (n > 1) { out.set(fp, k + "_" + n); count.set(k, n - 1); } else out.set(fp, k); }
  return out;
}

function jlcCpl(rows: Placement[], _m: BoardModel, origin: Pt): string {
  const names = uniqueRefs(rows.map((r) => r.fp));
  const L = ["Designator,Mid X,Mid Y,Rotation,Layer"];
  for (const r of rows) { const p = jlcPlacement(r.fp, origin); L.push([csvField(names.get(r.fp) || r.ref), f4(p.x), f4(p.y), f4(p.rot), p.layer].join(",")); }
  return "﻿" + L.join("\r\n") + "\r\n";
}
function jlcBom(lines: BomLine[]): string {
  const L = ["Designator,Footprint,Quantity,Value,LCSC Part #"];
  for (const l of lines) L.push([csvField(l.refs.map((r) => r.toUpperCase()).join(", ")), csvField(l.footprint), String(l.qty), csvField(l.value), csvField(l.dnp ? "DNP" : l.lcsc || l.mpn)].join(","));
  return "﻿" + L.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- PCBWay
function pcbwayCentroid(rows: Placement[]): string {
  // PCBWay's centroid template: Designator, Footprint, Mid X, Mid Y, Layer (T / B), Rotation, Comment
  const L = ["Designator,Footprint,Mid X,Mid Y,Layer,Rotation,Comment"];
  for (const r of rows) L.push([csvField(r.ref), csvField(r.pkg), f4(r.x) + "mm", f4(r.y) + "mm", r.side === "top" ? "T" : "B", f4(((r.rot % 360) + 360) % 360), csvField(r.value)].join(","));
  return "﻿" + L.join("\r\n") + "\r\n";
}
function pcbwayBom(lines: BomLine[]): string {
  // PCBWay's BOM template columns
  const L = ["Item #,Designator,Qty,Manufacturer,Mfg Part #,Description / Value,Package/Footprint,Type,Your Instructions / Notes"];
  lines.forEach((l, i) => L.push([String(i + 1), csvField(l.refs.join(", ")), String(l.qty), csvField(l.manufacturer), csvField(l.mpn || l.lcsc), csvField(l.description ? l.value + " " + l.description : l.value),
    csvField(l.footprint), l.throughHole && !l.smd ? "Thru-Hole" : "SMD", l.dnp ? "DNP" : ""].join(",")));
  return "﻿" + L.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- the presets

export const PRESETS: FabPreset[] = [
  { id: "jlcpcb", name: "JLCPCB", blurb: "Gerbers and drill files as JLCPCB's order page reads them, with the BOM and CPL files for their assembly service.",
    layers: fabLayers, protelExtensions: true, x2: false, useAuxOrigin: true, subtractMaskFromSilk: true, plotReference: true, plotValue: true,
    drill: { merge: false, zeros: "decimal", metric: true, ovalMode: "route", minimalHeader: false }, excludeDnp: true,
    placementName: "positions.csv", bomName: "bom.csv", placementCsv: jlcCpl, bomCsv: jlcBom, gerberArchive: "gerbers.zip", orderUrl: "https://cart.jlcpcb.com/quote" },
  { id: "pcbway", name: "PCBWay", blurb: "Gerbers and drill files for PCBWay's quote page, with the BOM and centroid files in their assembly templates' columns.",
    layers: fabLayers, protelExtensions: true, x2: false, useAuxOrigin: true, subtractMaskFromSilk: true, plotReference: true, plotValue: true,
    drill: { merge: false, zeros: "decimal", metric: true, ovalMode: "route", minimalHeader: false }, excludeDnp: true,
    placementName: "centroid.csv", bomName: "bom.csv", placementCsv: pcbwayCentroid, bomCsv: pcbwayBom, gerberArchive: "gerbers.zip", orderUrl: "https://www.pcbway.com/orderonline.aspx" },
  { id: "kicad", name: "KiCad defaults", blurb: "What KiCad's Plot, Generate Drill Files and Generate Placement Files dialogs write with their default settings.",
    layers: kicadLayers, protelExtensions: false, x2: true, useAuxOrigin: false, subtractMaskFromSilk: false, plotReference: true, plotValue: true,
    drill: { merge: false, zeros: "decimal", metric: true, ovalMode: "route", minimalHeader: false }, excludeDnp: false,
    placementName: "all-pos.csv", bomName: "bom.csv", placementCsv: (rows) => placementCsv(rows), bomCsv: (lines) => bomCsv(lines), gerberArchive: null, orderUrl: "" },
];
export const presetById = (id: string): FabPreset => PRESETS.find((p) => p.id === id) || PRESETS[0];
