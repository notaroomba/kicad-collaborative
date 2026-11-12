// web/fab/drill — Excellon drill files, as EXCELLON_WRITER (pcbnew/exporters/gendrill_excellon_writer.cpp)
// writes them: one file for plated holes and one for non-plated (or one merged file), plus one per layer
// pair for blind and buried vias.  Tools are numbered by rising diameter, vias before pad holes; an oblong
// hole is routed (G00 … M15 G01 … M16) or drilled as a slot (G85).  Y is negated like the Gerbers, so the
// two always register.
import { type BoardModel, type Via } from "./model";
import { type Pt, rot } from "./prims";

export interface DrillOptions {
  metric: boolean;
  /** decimal (KiCad's default) | suppress_leading | suppress_trailing | keep */
  zeros: "decimal" | "suppress_leading" | "suppress_trailing" | "keep";
  /** One file for plated and non-plated holes (PCBWay and most fabs accept either; JLCPCB wants them split). */
  merge: boolean;
  minimalHeader: boolean;
  /** Mirror the Y axis (KiCad's option of the same name: Y is then not negated). */
  mirrorY: boolean;
  ovalMode: "route" | "g85";
  origin: Pt;
  /** "KiCad 10.99" for the header comment, "Kicad,Pcbnew,10.99" for the TF attribute */
  software: string; softwareAttr: string; date: string;
}

/** HOLE_ATTRIBUTE, in the enum's order (it is the sort key between holes of one diameter). */
const ATTR = { viaThrough: 1, viaBuried: 2, pad: 4, padCastellated: 5, padPressfit: 6, mechanical: 8 } as const;
const ATTR_TEXT: { [k: number]: string } = {
  1: "; #@! TA.AperFunction,Plated,PTH,ViaDrill", 2: "; #@! TA.AperFunction,Plated,Buried,ViaDrill", 4: "; #@! TA.AperFunction,Plated,PTH,ComponentDrill",
  5: "; #@! TA.AperFunction,Plated,PTH,CastelletedDrill", 6: "; #@! TA.AperFunction,Plated,PTH,ComponentDrill,PressFit", 8: "; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill" };

export interface Hole {
  x: number; y: number;
  /** tool diameter: the hole's, or the shorter side of a slot */
  d: number;
  /** slot size and orientation; null for a round hole */
  slot: { w: number; h: number; rot: number } | null;
  plated: boolean; attr: number;
  /** the copper layers the hole runs between */
  from: string; to: string;
  /** the via a via hole comes from (the IPC-4761 protection files read its covering, plugging … modes) */
  via?: Via;
}

/** Every hole of the board: pad holes and vias. */
export function boardHoles(m: BoardModel): Hole[] {
  const out: Hole[] = [];
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  for (const fp of m.footprints) for (const p of fp.pads) {
    if (!p.drill || (p.type !== "thru_hole" && p.type !== "np_thru_hole")) continue;
    const plated = p.type === "thru_hole";
    const attr = !plated ? ATTR.mechanical : p.property === "pad_prop_castellated" ? ATTR.padCastellated : p.property === "pad_prop_pressfit" ? ATTR.padPressfit : ATTR.pad;
    const slot = p.drill.oval ? { w: p.drill.w, h: p.drill.h, rot: p.rot } : null;
    out.push({ x: p.x, y: p.y, d: Math.min(p.drill.w, p.drill.h), slot, plated, attr, from: first, to: last });
  }
  for (const v of m.vias) {
    if (!(v.drill > 0)) continue;
    const through = v.type === "through";
    out.push({ x: v.x, y: v.y, d: v.drill, slot: null, plated: true, attr: through ? ATTR.viaThrough : ATTR.viaBuried, from: through ? first : v.layers[0], to: through ? last : v.layers[v.layers.length - 1], via: v });
  }
  return out;
}

const nm = (v: number): number => Math.round(v * 1e6);

/**
 * printf("%.*f"): Number.toFixed, except that a value exactly half way between two results goes to the even
 * one (C rounds the binary value to even, JavaScript rounds it up) — 164.0625 is "164.062" in a drill file.
 */
export function cFixed(v: number, digits: number): string {
  const m = v * Math.pow(10, digits), lo = Math.floor(m);
  if (Number.isInteger(v * 16384) && m - lo === 0.5) return ((lo % 2 === 0 ? lo : lo + 1) / Math.pow(10, digits)).toFixed(digits);
  return v.toFixed(digits);
}
/** cmpHoleSorting: plated first, then diameter, attribute, X, Y. */
function sortHoles(hs: Hole[]): Hole[] {
  return hs.slice().sort((a, b) => (a.plated === b.plated ? 0 : a.plated ? -1 : 1) || nm(a.d) - nm(b.d) || a.attr - b.attr || nm(a.x) - nm(b.x) || nm(a.y) - nm(b.y));
}

export interface DrillFile { name: string; text: string; holes: number; tools: { d: number; count: number; plated: boolean }[] }

function writeExcellon(holes: Hole[], fileFunction: string, opt: DrillOptions): { text: string; tools: DrillFile["tools"] } {
  const sorted = sortHoles(holes);
  const tools: { d: number; plated: boolean; attr: number; count: number }[] = []; const toolOf: number[] = [];
  for (const h of sorted) {
    const t = tools[tools.length - 1];
    if (!t || nm(t.d) !== nm(h.d) || t.plated !== h.plated || t.attr !== h.attr) tools.push({ d: h.d, plated: h.plated, attr: h.attr, count: 0 });
    tools[tools.length - 1].count++; toolOf.push(tools.length);
  }
  const conv = opt.metric ? 1 / 1e6 : 0.001 / 25400;
  const mant = opt.metric ? 3 : 4, lhs = opt.metric ? 3 : 2;
  const trim = (s: string): string => { let r = s.replace(/0+$/, ""); if (r.endsWith(".")) r += "0"; return r; };
  const coord1 = (v: number): string => {
    if (opt.zeros === "decimal") return trim(cFixed(v, mant));
    const iv = Math.round(v * Math.pow(10, mant));
    if (opt.zeros === "suppress_leading") return String(iv);
    const neg = iv < 0; let s = String(Math.abs(iv)).padStart(lhs + mant, "0");
    if (opt.zeros === "suppress_trailing") { s = s.replace(/0+$/, ""); if (!s) s = "0"; }
    return (neg ? "-" : "") + s;
  };
  const xy = (x: number, y: number): string => {
    // as the Excellon writer: whole nanometres times its conversion factor, so the last digit rounds as its does
    const gx = (nm(x) - nm(opt.origin[0])) * conv, gy = (nm(y) - nm(opt.origin[1])) * (opt.mirrorY ? 1 : -1) * conv;
    return "X" + coord1(gx) + "Y" + coord1(gy === 0 ? 0 : gy);
  };
  const L: string[] = ["M48"];
  if (!opt.minimalHeader) {
    L.push(`; DRILL file {${opt.software}} date ${opt.date}`);
    const zf = { decimal: "decimal", suppress_leading: "suppress leading zeros", suppress_trailing: "suppress trailing zeros", keep: "keep zeros" }[opt.zeros];
    L.push(`; FORMAT={${opt.zeros === "decimal" ? "-:-" : lhs + ":" + mant}/ absolute / ${opt.metric ? "metric" : "inch"} / ${zf}}`);
    L.push(`; #@! TF.CreationDate,${opt.date}`);
    L.push(`; #@! TF.GenerationSoftware,${opt.softwareAttr}`);
    L.push(`; #@! TF.FileFunction,${fileFunction}`);
    L.push("FMAT,2");
  }
  L.push((opt.metric ? "METRIC" : "INCH") + (opt.zeros === "suppress_leading" ? ",TZ" : opt.zeros === "suppress_trailing" ? ",LZ" : ""));
  tools.forEach((t, i) => {
    if (!opt.minimalHeader) L.push(ATTR_TEXT[t.attr] || "; #@! TD");
    L.push(`T${i + 1}C${cFixed(nm(t.d) * conv, mant)}`);
  });
  L.push("%", "G90", "G05");
  let cur = -1;
  sorted.forEach((h, i) => {
    if (h.slot) return;
    if (toolOf[i] !== cur) { cur = toolOf[i]; L.push("T" + cur); }
    L.push(xy(h.x, h.y));
  });
  cur = -1;
  sorted.forEach((h, i) => {
    if (!h.slot) return;
    if (toolOf[i] !== cur) { cur = toolOf[i]; L.push("T" + cur); }
    // the slot's two end centres: along its longer side, turned by the pad's orientation
    const s = h.slot; const half = Math.abs(s.w - s.h) / 2;
    const a = s.w < s.h ? rot(0, -half, s.rot) : rot(-half, 0, s.rot), b = s.w < s.h ? rot(0, half, s.rot) : rot(half, 0, s.rot);
    const p0 = xy(h.x + a[0], h.y + a[1]), p1 = xy(h.x + b[0], h.y + b[1]);
    if (opt.ovalMode === "route") L.push("G00" + p0, "M15", "G01" + p1, "M16", "G05");
    else L.push(p0 + "G85" + p1, "G05");
  });
  L.push("M30");
  return { text: L.join("\n") + "\n", tools: tools.map((t) => ({ d: t.d, count: t.count, plated: t.plated })) };
}

/** GENDRILL_WRITER_BASE::layerName: front, back, inN. */
const pairName = (l: string): string => (l === "F.Cu" ? "front" : l === "B.Cu" ? "back" : "in" + (/^In(\d+)\.Cu$/.exec(l) || ["", "?"])[1]);

/** The board's drill files: <name>-PTH.drl and <name>-NPTH.drl (or <name>.drl merged), and <name>-front-in1.drl … for blind and buried vias. */
export function drillFiles(m: BoardModel, baseName: string, opt: DrillOptions, ext = "drl"): DrillFile[] {
  const holes = boardHoles(m);
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  const idx = (l: string): number => m.copper.indexOf(l) + 1;
  const through = holes.filter((h) => h.from === first && h.to === last);
  const out: DrillFile[] = [];
  const add = (name: string, hs: Hole[], fn: string): void => { const w = writeExcellon(hs, fn, opt); out.push({ name, text: w.text, holes: hs.length, tools: w.tools }); };
  const span = `${idx(first)},${idx(last)}`;
  if (opt.merge) add(`${baseName}.${ext}`, through, `MixedPlating,${span}`);
  else {
    // KiCad always writes both files, even when one is empty
    add(`${baseName}-PTH.${ext}`, through.filter((h) => h.plated), `Plated,${span},PTH`);
    add(`${baseName}-NPTH.${ext}`, through.filter((h) => !h.plated), `NonPlated,${span},NPTH`);
  }
  const pairs = new Map<string, Hole[]>();
  for (const h of holes) { if (h.from === first && h.to === last) continue; const k = h.from + "|" + h.to; const l = pairs.get(k); if (l) l.push(h); else pairs.set(k, [h]); }
  for (const [k, hs] of pairs) {
    const [a, b] = k.split("|");
    add(`${baseName}-${pairName(a)}-${pairName(b)}.${ext}`, hs, `Plated,${idx(a)},${idx(b)},Blind`);
  }
  return out;
}
