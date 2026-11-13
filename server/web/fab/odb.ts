// web/fab/odb — the ODB++ job of a board (File > Fabrication Outputs > ODB++ in KiCad, PCB_IO_ODBPP in pcbnew/pcb_io/odbpp).
//
// The tree is KiCad's: matrix/matrix (+ stackup.xml), misc/info (+ userattr, metadata.xml), fonts/standard, and one step
// "pcb" with its header, profile, eda/data (nets, subnets and packages), netlists/cadnet/netlist and one folder per layer
// (attrlist, features, and components or tools where the layer has them).  Records, symbol names, attribute tables and
// number formatting follow odb_entity.cpp, odb_feature.cpp, odb_eda_data.cpp, odb_component.cpp, odb_netlist.cpp and
// odb_util.cpp.  The layer features are made from the same primitives the Gerber writer plots (plot.ts), so a pad is the
// same shape in both outputs: a seg is an L record, an arc an A, a flash a P with a standard symbol (r, rect, oval,
// rect…xr…) and a region or a free polygon an S surface.
//
// What differs from the desktop: outline arcs on the rout layer and in the profile are polylines (the web outline is
// chained from polygonised Edge.Cuts), a package's outline is its courtyard or else the box of its pads (KiCad takes the
// convex hull of the footprint), and backdrills, post-machining and net-tie shorts are not written.
import { stackupRows, boardFinish } from "../canvas/board-setup";
import { atOf, has, kid, str } from "../canvas/sexpr";
import { boardShape } from "../viewer3d/outline";
import { type BoardModel, type Footprint, type Node, type Pad, type Track, type Via, type ZoneFill, isCopper, padShapeOn } from "./model";
import { ODB_STANDARD_FONT } from "./odb-font";
import { Connections, PlotLog, padPrims, plotLayer } from "./plot";
import { courtyardLoops } from "./pnp";
import { primPolys } from "./poly";
import { type Prim, type Pt, area, norm360, rot } from "./prims";

export interface OdbOptions {
  /** inches instead of millimetres (the "units" property of PCB_IO_ODBPP::SaveBoard) */
  inch?: boolean;
  /** decimal places ("sigfig"): 6 by default, at least 3 (4 in inches), at most 16 */
  precision?: number;
  /** where coordinates are measured from: the page corner, the drill/place file origin or the grid origin */
  origin?: "absolute" | "aux" | "grid";
  /** PRODUCT_MODEL_NAME of misc/info, when one is given */
  productModelName?: string;
  /** the board's enabled layers, in KiCad's order */
  layers: string[];
  /** BOARD::GetLayerName */
  nameOf: (layer: string) => string;
  /** GetBuildVersion */
  version: string;
  date: Date;
}
export interface OdbResult { files: { path: string; text: string }[]; dirs: string[]; warnings: string[] }

// ---------------------------------------------------------------- names (odb_util.cpp)
/** ODB::GenLegalEntityName: lower case letters, digits and - _ + . only, at most 64, no leading . - + and no trailing dot. */
export function legalEntityName(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || ch === "-" || ch === "_" || ch === "+" || ch === ".") out += ch;
    else out += "_";
  }
  if (out.length > 64) out = out.slice(0, 64);
  out = out.replace(/^[.\-+]+/, "").replace(/\.+$/, "");
  return out;
}
/** ODB::GenLegalNetName / GenLegalComponentName: printable ASCII without the semicolon. */
export function legalName(s: string): string {
  let out = "";
  for (const ch of s) { const c = ch.codePointAt(0)!; out += c >= 33 && c <= 126 && ch !== ";" ? ch : "_"; }
  return out;
}
/** ODB::UniqueNames: a name already taken gets _2, _3 … (never one of the original names). */
export function uniqueNames(bases: string[], reserved: string[], maxLen: number): string[] {
  const cut = bases.map((b) => b.slice(0, maxLen)); const original = new Set(cut); const used = new Set(reserved);
  const next = new Map<string, number>(); const out: string[] = [];
  for (const base of cut) {
    let legal = base;
    if (used.has(legal)) {
      let n = next.get(base) || 2;
      for (;; n++) { const suffix = "_" + n; legal = base.slice(0, maxLen - suffix.length) + suffix; if (!original.has(legal) && !used.has(legal)) break; }
      next.set(base, n);
    }
    out.push(legal); used.add(legal);
  }
  return out;
}
const noSpace = (s: string): string => s.trim().replace(/\s/g, "_");

// ---------------------------------------------------------------- attributes (odb_attribute.cpp)
type Rec = Map<number, string>;
class Attrs {
  private readonly names: string[] = []; private readonly nmap = new Map<string, number>();
  private readonly texts: string[] = []; private readonly tmap = new Map<string, number>();
  private idOf(n: string): number { const k = n.toLowerCase(); let i = this.nmap.get(k); if (i === undefined) { i = this.names.length; this.nmap.set(k, i); this.names.push(k); } return i; }
  private textOf(t: string): number { let i = this.tmap.get(t); if (i === undefined) { i = this.texts.length; this.tmap.set(t, i); this.texts.push(t); } return i; }
  /** a system attribute (.name): a flag, a number or an option's index */
  sys(r: Rec, name: string, value = ""): void { r.set(this.idOf("." + name), value); }
  /** a system TEXT attribute: its value goes to the text table, upper case; an empty text is the default and is not written */
  text(r: Rec, name: string, value: string): void { if (value) r.set(this.idOf("." + name), String(this.textOf(value.replace(/[\r\n]+/g, " ").toUpperCase()))); }
  /** ATTR_MANAGER::WriteAttributes */
  tables(): string {
    return "\n#\n#Feature attribute names\n#\n" + this.names.map((n, i) => `@${i} ${n}\n`).join("") + "\n#\n#Feature attribute text strings\n#\n" + this.texts.map((t, i) => `&${i} ${t}\n`).join("");
  }
}
/** ATTR_RECORD_WRITER::WriteAttributes */
function recAttrs(r: Rec): string {
  if (!r.size) return " ;;";
  return " ;" + [...r.entries()].sort((a, b) => a[0] - b[0]).map(([id, v]) => (v.length ? `${id}=${v}` : String(id))).join(",");
}

// ---------------------------------------------------------------- the writer
interface Subnet { head: string; fids: string[]; index: number }
interface Net { index: number; name: string; subnets: Subnet[] }
interface Row {
  name: string; type: string; context: string; polarity: string; uid: number;
  /** the board layer of a row that has one */
  layer?: string;
  role: "board" | "dielectric" | "drill" | "rout" | "aux" | "comp";
  span?: [string, string]; spanLayers?: [string, string];
  diType?: string; diName?: string; cuTop?: number; cuBottom?: number; ref?: number;
  /** stackup values of the row */
  thickness?: number; copper?: boolean; mask?: boolean; epsilonR?: number | null; lossTangent?: number | null; material?: string;
  drill?: { plated: boolean; from: string; to: string };
  aux?: { kind: string; layer: string; to?: string };
  side?: string;
}
interface DrillHit { x: number; y: number; d: number; slot: { w: number; h: number; rot: number } | null; plated: boolean; from: string; to: string; pad?: Pad; via?: Via }

/** The whole ODB++ tree of a board, as text files by their path under the job's root. */
export function writeOdb(m: BoardModel, setup: Node | null, o: OdbOptions): OdbResult {
  const inch = !!o.inch, units = inch ? "INCH" : "MM";
  const floor = inch ? 4 : 3, asked = o.precision === undefined || !isFinite(o.precision) ? 6 : Math.round(o.precision), prec = Math.max(floor, Math.min(16, asked));
  const warnings: string[] = [];
  if (asked < floor) warnings.push(`ODB++ precision ${asked} is below the minimum of ${floor} for these units; using ${prec}.`);
  else if (asked > 16) warnings.push(`ODB++ precision ${asked} is above the maximum of 16; using ${prec}.`);
  const scale = inch ? 1 / 25.4 : 1;
  /** FormatTrimmedDecimal: fixed decimals, trailing zeros dropped down to one, no minus sign on a rounded zero */
  const fix = (v: number): string => {
    let s = v.toFixed(prec); const dot = s.indexOf(".");
    while (dot >= 0 && s.length - dot > 2 && s.endsWith("00")) s = s.slice(0, -1);
    if (s[0] === "-" && !/[1-9]/.test(s)) s = s.slice(1);
    return s;
  };
  // KiCad counts in nanometres: a length is rounded to one before it is scaled, so 0.95 never prints as 0.949999
  const nm = (mm: number): number => Math.round(mm * 1e6);
  const data = (mm: number): string => fix(nm(mm) * scale / 1e6);
  /** symbol and drill sizes: thousandths of the output unit (microns or mils) */
  const sym = (mm: number): string => fix(nm(mm) * scale / 1e3);
  const [ox, oy] = o.origin === "aux" ? m.settings.auxOrigin : o.origin === "grid" ? m.settings.gridOrigin : [0, 0];
  const X = (x: number): string => data(x - ox), Y = (y: number): string => data(oy - y);
  let maxUid = 0; const uid = (): number => ++maxUid;
  const files: { path: string; text: string }[] = [];
  const put = (path: string, text: string): void => { files.push({ path, text }); };
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  const enabled = new Set(o.layers.length ? o.layers : [...m.copper, "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Paste", "B.Paste"]);
  for (const l of m.copper) enabled.add(l);

  // ---- surfaces: an island runs clockwise as seen (Y down here, so a positive shoelace area), a hole the other way
  const contour = (ptsIn: Pt[], hole: boolean, tag: string): string => {
    let pts = ptsIn.slice();
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) return "";
    const a = area(pts); if (a === 0) return "";
    if (hole ? a > 0 : a < 0) pts = pts.reverse();
    const end = pts[pts.length - 1];
    return `OB ${X(end[0])} ${Y(end[1])} ${tag}\n` + pts.map((p) => `OS ${X(p[0])} ${Y(p[1])}\n`).join("") + "OE\n";
  };
  const surfaceData = (island: Pt[], holes: Pt[][]): string => { const head = contour(island, false, "I"); return head ? head + holes.map((h) => contour(h, true, "H")).join("") : ""; };

  // ---- features of one layer (FEATURES_MANAGER)
  class Features {
    readonly attrs = new Attrs();
    private readonly syms: string[] = []; private readonly smap = new Map<string, number>();
    readonly recs: { text: string; attrs: Rec; tail: string }[] = [];
    private symbol(name: string): number { let i = this.smap.get(name); if (i === undefined) { i = this.syms.length; this.smap.set(name, i); this.syms.push(name); } return i; }
    private add(text: string, tail = ""): number { this.recs.push({ text, attrs: new Map(), tail }); return this.recs.length - 1; }
    line(x1: number, y1: number, x2: number, y2: number, w: number, pol = "P"): number { return this.add(`L ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${this.symbol("r" + sym(w))} ${pol} 0`); }
    arc(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, w: number, cw: boolean, pol = "P"): number {
      return this.add(`A ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(cx)} ${Y(cy)} ${this.symbol("r" + sym(w))} ${pol} 0 ${cw ? "Y" : "N"}`);
    }
    /** a flash: `deg` is the pad's orientation as KiCad stores it; ODB++ turns clockwise */
    pad(x: number, y: number, symbol: string, deg: number, pol = "P"): number { return this.add(`P ${X(x)} ${Y(y)} ${this.symbol(symbol)} ${pol} 0 8 ${fix(norm360(360 - deg))}`); }
    surface(island: Pt[], holes: Pt[][], pol = "P"): number { const d = surfaceData(island, holes); return d ? this.add(`S ${pol} 0`, "\n" + d + "SE") : -1; }
    /** one plot primitive; the indices of the features it made */
    prim(p: Prim): number[] {
      const pol = p.clear ? "N" : "P";
      switch (p.k) {
        case "seg": return p.w > 0 ? [this.line(p.x1, p.y1, p.x2, p.y2, p.w, pol)] : [];
        case "arc": {
          if (!(p.w > 0)) return [];
          const x1 = p.cx + p.r * Math.cos(p.a0), y1 = p.cy + p.r * Math.sin(p.a0), x2 = p.cx + p.r * Math.cos(p.a1), y2 = p.cy + p.r * Math.sin(p.a1);
          // a clockwise turn on screen stays clockwise once Y points up: the picture is the same
          return [this.arc(x1, y1, x2, y2, p.cx, p.cy, p.w, !p.acw, pol)];
        }
        case "circle": return p.d > 0 ? [this.pad(p.x, p.y, "r" + sym(p.d), 0, pol)] : [];
        case "rect": return p.w > 0 && p.h > 0 ? [this.pad(p.x, p.y, `rect${sym(p.w)}x${sym(p.h)}`, p.rot, pol)] : [];
        case "oval": return p.w > 0 && p.h > 0 ? [this.pad(p.x, p.y, `oval${sym(p.w)}x${sym(p.h)}`, p.rot, pol)] : [];
        case "roundrect": return p.w > 0 && p.h > 0 ? [this.pad(p.x, p.y, `rect${sym(p.w)}x${sym(p.h)}xr${sym(p.r)}`, p.rot, pol)] : [];
        case "td": return [];
        default: { const out: number[] = []; for (const poly of primPolys(p)) { const i = this.surface(poly, [], pol); if (i >= 0) out.push(i); } return out; }
      }
    }
    private body(): string { return this.recs.map((r) => r.text + recAttrs(r.attrs) + r.tail + "\n").join(""); }
    /** FEATURES_MANAGER::GenerateFeatureFile */
    file(): string {
      let s = `UNITS=${units}\n#\n#Num Features\n#\nF ${this.recs.length}\n\n`;
      if (!this.recs.length) return s;
      s += "#\n#Feature symbol names\n#\n" + this.syms.map((n, i) => `$${i} ${n}\n`).join("");
      return s + this.attrs.tables() + "#\n#Layer features\n#\n" + this.body();
    }
    /** FEATURES_MANAGER::GenerateProfileFeatures */
    profile(): string {
      let s = `UNITS=${units}\n#\n#Num Features\n#\nF ${this.recs.length}\n`;
      if (this.recs.length) s += "#\n#Layer features\n#\n" + this.body();
      return s;
    }
  }

  // ---- stackup (FAB_STACKUP): the board's own, or KiCad's default for its layer count
  interface StackItem { name: string; kind: "copper" | "dielectric" | "other"; core: boolean; id: number; thickness: number; material: string; epsilonR: number | null; lossTangent: number | null; mask: boolean }
  const stack: StackItem[] = [];
  const rows0 = stackupRows(setup as unknown as SNode | null);
  if (rows0.length) {
    for (const r of rows0) {
      const diel = r.type === "Core" || r.type === "PrePreg" || /^Dielectric /.test(r.layer);
      const mask = /Solder Mask/i.test(r.type);
      stack.push({ name: diel ? "" : r.layer, kind: r.type === "Copper" ? "copper" : diel ? "dielectric" : "other", core: r.type === "Core", id: diel ? Number(r.id) || 0 : 0, thickness: r.thickness || 0,
        material: r.material, epsilonR: diel || mask ? r.epsilonR : null, lossTangent: diel || mask ? r.lossTangent : null, mask });
    }
  } else {
    const n = m.copper.length, total = m.doc.thickness && m.doc.thickness > 0 ? m.doc.thickness : 1.6, cu = 0.035, diel = Math.max(0.01, (total - n * cu) / Math.max(1, n - 1));
    const other = (name: string, mask: boolean): void => { if (enabled.has(name)) stack.push({ name, kind: "other", core: false, id: 0, thickness: mask ? 0.01 : 0, material: "", epsilonR: mask ? 3.3 : null, lossTangent: mask ? 0 : null, mask }); };
    other("F.SilkS", false); other("F.Paste", false); other("F.Mask", true);
    m.copper.forEach((l, i) => {
      stack.push({ name: l, kind: "copper", core: false, id: 0, thickness: cu, material: "", epsilonR: null, lossTangent: null, mask: false });
      if (i < n - 1) stack.push({ name: "", kind: "dielectric", core: (i & 1) === 0, id: i + 1, thickness: diel, material: "FR4", epsilonR: 4.5, lossTangent: 0.02, mask: false });
    });
    other("B.Mask", true); other("B.Paste", false); other("B.SilkS", false);
  }
  const boardThickness = stack.reduce((t, s) => t + (s.kind !== "other" || s.mask ? s.thickness : 0), 0) || m.doc.thickness || 1.6;

  // ---- holes (FAB_DRILL_MODEL, without backdrills)
  const hits: DrillHit[] = [];
  for (const fp of m.footprints) for (const p of fp.pads) {
    if (!p.drill || (p.type !== "thru_hole" && p.type !== "np_thru_hole")) continue;
    hits.push({ x: p.x, y: p.y, d: Math.min(p.drill.w, p.drill.h), slot: p.drill.oval ? { w: p.drill.w, h: p.drill.h, rot: p.rot } : null, plated: p.type === "thru_hole", from: first, to: last, pad: p });
  }
  for (const v of m.vias) {
    if (!(v.drill > 0)) continue;
    const through = v.type === "through";
    hits.push({ x: v.x, y: v.y, d: v.drill, slot: null, plated: true, from: through ? first : v.layers[0], to: through ? last : v.layers[v.layers.length - 1], via: v });
  }
  const viaFlag = (v: Via, own: boolean | null, dflt: boolean): boolean => (own !== null ? own : dflt);
  const S = m.settings;
  const viaTop = (v: Via): boolean => v.layers[0] === first, viaBottom = (v: Via): boolean => v.layers[v.layers.length - 1] === last;
  const protection = (v: Via): { filled: boolean; capped: boolean; tentF: boolean; tentB: boolean; covF: boolean; covB: boolean; plugF: boolean; plugB: boolean } => ({
    filled: viaFlag(v, v.filled, S.fillVias), capped: viaFlag(v, v.capped, S.capVias),
    tentF: viaTop(v) && viaFlag(v, v.tentFront, S.tentFront), tentB: viaBottom(v) && viaFlag(v, v.tentBack, S.tentBack),
    covF: viaTop(v) && viaFlag(v, v.coverFront, S.coverFront), covB: viaBottom(v) && viaFlag(v, v.coverBack, S.coverBack),
    plugF: viaTop(v) && viaFlag(v, v.plugFront, S.plugFront), plugB: viaBottom(v) && viaFlag(v, v.plugBack, S.plugBack) });
  /** ODB::IpcViaType */
  const ipcType = (filled: boolean, capped: boolean, plugged: boolean, covered: boolean, tented: boolean): number =>
    filled ? (capped ? 7 : tented || covered ? 6 : 5) : plugged ? (tented || covered ? 4 : 3) : covered ? 2 : tented ? 1 : 0;

  // ---- the matrix (ODB_MATRIX_ENTITY::InitMatrixLayerData)
  const rows: Row[] = [];
  const stepUid = uid();
  const hasTop = m.footprints.some((fp) => fp.side !== "B.Cu"), hasBot = m.footprints.some((fp) => fp.side === "B.Cu");
  const boardRow = (layer: string): Row | null => {
    const name = legalEntityName(o.nameOf(layer));
    if (/\.Paste$/.test(layer)) return { name, type: "SOLDER_PASTE", context: "BOARD", polarity: "POSITIVE", uid: 0, layer, role: "board" };
    if (/\.SilkS$/.test(layer)) return { name, type: "SILK_SCREEN", context: "BOARD", polarity: "POSITIVE", uid: 0, layer, role: "board" };
    if (/\.Mask$/.test(layer)) return { name, type: "SOLDER_MASK", context: "BOARD", polarity: "POSITIVE", uid: 0, layer, role: "board" };
    if (isCopper(layer)) { const t = (m.doc.layers.get(layer) || { type: "signal" }).type; return { name, type: t === "power" ? "POWER_GROUND" : t === "mixed" ? "MIXED" : "SIGNAL", context: "BOARD", polarity: "POSITIVE", uid: 0, layer, role: "board" }; }
    if (/\.(CrtYd|Fab|Adhes)$/.test(layer) || /^(Dwgs|Cmts|Eco1|Eco2)\.User$/.test(layer) || layer === "Margin" || /^User\.\d+$/.test(layer)) return { name, type: "DOCUMENT", context: "MISC", polarity: "POSITIVE", uid: 0, layer, role: "board" };
    return null;   // Edge.Cuts is the profile and the rout layer
  };
  if (hasTop) rows.push({ name: legalEntityName("COMP_+_TOP"), type: "COMPONENT", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "comp", side: "F.Cu" });
  const added = new Set<string>();
  for (const s of stack) {
    if (s.kind === "dielectric") {
      rows.push({ name: legalEntityName(`DIELECTRIC_${s.id}`), type: "DIELECTRIC", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "dielectric", diType: s.core ? "CORE" : "PREPREG", diName: s.material,
        thickness: s.thickness, epsilonR: s.epsilonR, lossTangent: s.lossTangent, material: s.material });
      continue;
    }
    if (!enabled.has(s.name) || added.has(s.name)) continue;
    const r = boardRow(s.name); if (!r) continue;
    added.add(s.name);
    rows.push(Object.assign(r, { thickness: s.thickness, copper: s.kind === "copper", mask: s.mask, epsilonR: s.epsilonR, lossTangent: s.lossTangent, material: s.material }));
  }
  // drill layers: one per span and plating, the through ones always when the board has such pads
  const drillKey = (h: { plated: boolean; from: string; to: string }): string => `${h.plated ? "p" : "n"}|${h.from}|${h.to}`;
  const drillSpans = new Map<string, { plated: boolean; from: string; to: string }>();
  if (hits.some((h) => !h.plated)) drillSpans.set(drillKey({ plated: false, from: first, to: last }), { plated: false, from: first, to: last });
  if (hits.some((h) => h.plated)) drillSpans.set(drillKey({ plated: true, from: first, to: last }), { plated: true, from: first, to: last });
  for (const h of hits) if (!drillSpans.has(drillKey(h))) drillSpans.set(drillKey(h), { plated: h.plated, from: h.from, to: h.to });
  for (const d of drillSpans.values())
    rows.push({ name: legalEntityName(`drill_${d.plated ? "plated" : "non-plated"}_${o.nameOf(d.from)}-${o.nameOf(d.to)}`), type: "DRILL", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "drill", drill: d, spanLayers: [d.from, d.to] });
  rows.push({ name: "rout", type: "ROUT", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "rout", spanLayers: [first, last] });
  for (const l of o.layers) { if (added.has(l)) continue; const r = boardRow(l); if (r) { added.add(l); rows.push(r); } }
  // IPC-4761 via protection layers (AddAuxilliaryMatrixLayer)
  const auxItems = new Map<string, { kind: string; layer: string; to?: string; vias: Via[] }>();
  const auxAdd = (kind: string, layer: string, to: string | undefined, v: Via): void => { const k = `${kind}|${layer}|${to || ""}`; let e = auxItems.get(k); if (!e) { e = { kind, layer, to, vias: [] }; auxItems.set(k, e); } e.vias.push(v); };
  for (const v of m.vias) {
    if (!(v.drill > 0)) continue;
    const pr = protection(v), top = v.layers[0], bot = v.layers[v.layers.length - 1];
    if (pr.filled) auxAdd("filling", top, bot, v);
    if (pr.capped) auxAdd("capping", top, bot, v);
    if (pr.plugF) auxAdd("plugging", top, undefined, v); if (pr.plugB) auxAdd("plugging", bot, undefined, v);
    if (pr.covF) auxAdd("covering", top, undefined, v); if (pr.covB) auxAdd("covering", bot, undefined, v);
    if (pr.tentF) auxAdd("tenting", top, undefined, v); if (pr.tentB) auxAdd("tenting", bot, undefined, v);
  }
  const auxVias = new Map<Row, Via[]>();
  for (const e of [...auxItems.values()].sort((a, b) => ["tenting", "covering", "plugging", "filling", "capping"].indexOf(a.kind) - ["tenting", "covering", "plugging", "filling", "capping"].indexOf(b.kind))) {
    const name = e.to ? `${e.kind}_${o.nameOf(e.layer)}-${o.nameOf(e.to)}` : `${e.kind}_${e.layer === first ? "front" : "back"}`;
    const r: Row = { name: legalEntityName(name), type: "DOCUMENT", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "aux", aux: { kind: e.kind, layer: e.layer, to: e.to }, spanLayers: e.to ? [e.layer, e.to] : undefined };
    rows.push(r); auxVias.set(r, e.vias);
  }
  if (hasBot) rows.push({ name: legalEntityName("COMP_+_BOT"), type: "COMPONENT", context: "BOARD", polarity: "POSITIVE", uid: 0, role: "comp", side: "B.Cu" });
  uniqueNames(rows.map((r) => r.name), [], 64).forEach((n, i) => { rows[i].name = n; });
  const nameByLayer = new Map<string, string>();
  for (const r of rows) if (r.role === "board" && r.layer) nameByLayer.set(r.layer, r.name);
  for (const r of rows) if (r.spanLayers) r.span = [nameByLayer.get(r.spanLayers[0]) || "", nameByLayer.get(r.spanLayers[1]) || ""];
  const isCu = (r: Row): boolean => r.type === "SIGNAL" || r.type === "POWER_GROUND" || r.type === "MIXED";
  for (const r of rows) r.uid = uid();
  const cuUid = new Map<string, number>(); for (const r of rows) if (isCu(r) && r.layer) cuUid.set(r.layer, r.uid);
  rows.forEach((r, i) => {
    if (r.context === "BOARD" && r.layer && (r.type === "SOLDER_MASK" || r.type === "SOLDER_PASTE" || r.type === "SILK_SCREEN")) { const u = cuUid.get(/^B\./.test(r.layer) ? "B.Cu" : "F.Cu"); if (u !== undefined) r.ref = u; }
    if (r.diType !== "CORE") return;
    for (let t = i - 1; t >= 0; t--) if (isCu(rows[t])) { r.cuTop = rows[t].uid; break; }
    for (let b = i + 1; b < rows.length; b++) if (isCu(rows[b])) { r.cuBottom = rows[b].uid; break; }
  });

  // ---- EDA data (ODB_STEP_ENTITY::InitEdaData)
  const nets: Net[] = [{ index: 0, name: "$NONE$", subnets: [] }]; const netByName = new Map<string, Net>();
  const usedNetNames = new Set<string>(["$NONE$"]);
  const netOf = (name: string | undefined): Net => {
    if (!name) return nets[0];
    let n = netByName.get(name);
    if (!n) {
      let legal = legalName(name) || "_";
      if (usedNetNames.has(legal)) { let k = 2; while (usedNetNames.has(`${legal}_${k}`)) k++; legal = `${legal}_${k}`; }
      usedNetNames.add(legal);
      n = { index: nets.length, name: legal, subnets: [] }; nets.push(n); netByName.set(name, n);
    }
    return n;
  };
  for (const code of [...m.doc.nets.keys()].sort((a, b) => a - b)) if (code > 0) netOf(m.doc.nets.get(code));
  const subnet = (n: Net, head: string): Subnet => { const s: Subnet = { head, fids: [], index: n.subnets.length }; n.subnets.push(s); return s; };
  const edaLayers: string[] = []; const edaLayerIdx = new Map<string, number>();
  const lyr = (name: string): number => { let i = edaLayerIdx.get(name); if (i === undefined) { i = edaLayers.length; edaLayerIdx.set(name, i); edaLayers.push(name); } return i; };
  const fid = (s: Subnet, type: "C" | "H", layerName: string, feature: number): void => { s.fids.push(`FID ${type} ${lyr(layerName)} ${feature}`); };

  // packages: the footprint at the origin, orientation 0, as its file holds it
  interface Pkg { index: number; text: string; pins: string[] }
  const pkgs: Pkg[] = []; const pkgByKey = new Map<string, Pkg>(); const pkgOf = new Map<Footprint, Pkg>();
  const local = (fp: Footprint, p: Pt): Pt => rot(p[0] - fp.x, p[1] - fp.y, -fp.rot);
  const pinName = (pad: Pad, i: number): string => noSpace(pad.number) || `PAD${i}`;
  const pkgData = (island: Pt[]): string => { const d = surfaceData(island, []); return d ? "CT\n" + d + "CE\n" : ""; };
  for (const fp of m.footprints) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (pts: Pt[]): void => { for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; } };
    const pinLines: string[] = []; const pins: string[] = []; const centres: Pt[] = [];
    fp.pads.forEach((pad, i) => {
      const [px, py] = atOf(pad.node) as [number, number, number];
      centres.push([px, py]);
      const mount = pad.layers.has("F.Cu") ? "F.Cu" : pad.layers.has("B.Cu") ? "B.Cu" : [...pad.layers].find(isCopper) || "";
      let outline = "";
      if (mount) {
        const ps: Prim[] = []; padPrims(pad, mount, m, ps);
        const poly = ps.length ? primPolys(ps[0])[0] : undefined;
        if (poly) { const lp = poly.map((q) => local(fp, q)); grow(lp); outline = pkgData(lp); }
      }
      if (!outline) grow([[px, py]]);
      const name = pinName(pad, i); pins.push(name);
      const hole = !!pad.drill && (pad.type === "thru_hole" || pad.type === "np_thru_hole");
      const etype = pad.type === "np_thru_hole" ? "M" : pad.number ? "E" : "U";
      const mtype = pad.property === "pad_prop_pressfit" ? "P" : pad.type === "thru_hole" ? "T" : pad.type === "np_thru_hole" ? "H" : pad.type === "smd" ? "S" : "U";
      pinLines.push(`PIN ${name} ${hole ? "T" : "S"} ${data(px)} ${data(-py)} 0 ${etype} ${mtype}\n${outline}`);
    });
    let outlines: Pt[][] = [];
    for (const side of ["F.CrtYd", "B.CrtYd"]) { const loops = courtyardLoops(fp, side); if (loops && loops.length) outlines = loops.map((l) => l.map((q) => local(fp, q))); }
    for (const l of outlines) grow(l);
    if (!(x1 >= x0)) { x0 = y0 = -0.5; x1 = y1 = 0.5; }
    if (!outlines.length) outlines = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
    let pitch = Infinity;
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) pitch = Math.min(pitch, Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]));
    if (centres.length < 2 || !isFinite(pitch)) pitch = 1;
    const name = noSpace(fp.name) || "__";
    const body = `${name} ${data(pitch)} ${data(x0)} ${data(-y1)} ${data(x1)} ${data(-y0)} ;;\n` + outlines.map(pkgData).join("") + pinLines.join("");
    let pkg = pkgByKey.get(body);
    if (!pkg) { pkg = { index: pkgs.length, text: "PKG " + body, pins }; pkgs.push(pkg); pkgByKey.set(body, pkg); }
    pkgOf.set(fp, pkg);
  }

  // components and their toeprints
  const compAttrs: { [side: string]: Attrs } = { "F.Cu": new Attrs(), "B.Cu": new Attrs() };
  const compText: { [side: string]: string[] } = { "F.Cu": [], "B.Cu": [] };
  const usedRefs: { [side: string]: Set<string> } = { "F.Cu": new Set(), "B.Cu": new Set() };
  const padSub = new Map<Pad, Subnet>();
  for (const fp of m.footprints) {
    const side = fp.side === "B.Cu" ? "B.Cu" : "F.Cu", list = compText[side], pkg = pkgOf.get(fp)!;
    const hasCourtyard = (fp.node as unknown[]).some((g) => Array.isArray(g) && /^fp_/.test(String(g[0])) && /\.CrtYd$/.test(str((kid(g as Node, "layer") || [])[1])));
    const hasModel = (fp.node as unknown[]).some((g) => Array.isArray(g) && g[0] === "model" && !has(g as Node, "hide"));
    const isComp = !!fp.pads.length || hasCourtyard || hasModel;
    const index = list.length;
    const toeps: string[] = [];
    fp.pads.forEach((pad, i) => {
      const net = netOf(pad.net);
      const s = subnet(net, `TOP ${side === "B.Cu" ? "B" : "T"} ${isComp ? index : 0} ${i}`);
      padSub.set(pad, s);
      toeps.push(`TOP ${i} ${X(pad.x)} ${Y(pad.y)} ${fix(norm360(360 - pad.rot))} ${side === "B.Cu" ? "M" : "N"} ${net.index} ${s.index} ${pkg.pins[i]}\n`);
    });
    if (!isComp) continue;
    const A = compAttrs[side], rec: Rec = new Map();
    let ref = legalName(fp.ref);
    if (!ref) ref = `UNNAMED${index + 1}`;
    if (ref !== fp.ref) warnings.push(`Component '${fp.ref}' has non-ASCII characters in its designator; converted to '${ref}' for ODB++ export.`);
    if (usedRefs[side].has(ref)) { let k = 1; while (usedRefs[side].has(`${ref}_${k}`)) k++; warnings.push(`Component '${fp.ref}' has an ambiguous designator after conversion; renamed to '${ref}_${k}' for ODB++ export.`); ref = `${ref}_${k}`; }
    usedRefs[side].add(ref);
    const colon = fp.lib.indexOf(":");
    const part = legalName(noSpace(`${colon >= 0 ? fp.lib.slice(0, colon) : ""}_${fp.name}`));
    const height = parseFloat(fp.props.get("Height") || "");
    if (isFinite(height) && height > 0) A.sys(rec, "comp_height", (inch ? height / 25.4 : height).toFixed(6));
    if (fp.dnp) A.sys(rec, "no_pop");
    A.sys(rec, "comp_mount_type", String(fp.pads.some((p) => p.property === "pad_prop_pressfit") ? 3 : fp.smd ? 1 : fp.throughHole ? 2 : 0));
    let text = `# CMP ${index}\nCMP ${pkg.index} ${X(fp.x)} ${Y(fp.y)} ${fp.rot ? fix(norm360(360 - fp.rot)) : "0"} ${side === "B.Cu" ? "M" : "N"} ${ref} ${part}${recAttrs(rec)}\n`;
    const props = [...fp.props.entries()].filter(([k]) => k !== "Reference").map(([k, v]) => [noSpace(k), v] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [k, v] of props) if (k) text += `PRP ${k} '${v.replace(/\r/g, "").replace(/\n/g, " ")}'\n`;
    list.push(text + toeps.join("") + "#\n");
  }
  const trackSub = new Map<Track | Via, Subnet>();
  for (const t of m.tracks) trackSub.set(t, subnet(netOf(t.net), "TRC"));
  for (const v of m.vias) trackSub.set(v, subnet(netOf(v.net), "VIA"));
  const planeSub = new Map<Node, Map<string, Subnet>>();
  const planeOf = (f: ZoneFill): Subnet | null => {
    if (!f.zone) return null;
    let byLayer = planeSub.get(f.zone); if (!byLayer) { byLayer = new Map(); planeSub.set(f.zone, byLayer); }
    let s = byLayer.get(f.layer); if (!s) { s = subnet(netOf(f.net), "PLN S E 0"); byLayer.set(f.layer, s); }
    return s;
  };
  const viaSet = new Set<unknown>(m.vias), trackSet = new Set<unknown>(m.tracks), fillSet = new Set<unknown>(m.fills);

  // ---- layers
  const log = new PlotLog(); const conn = new Connections(m);
  const plotOpt = { plotReference: true, plotValue: true, subtractMaskFromSilk: false };
  const geometry = (v: Via, layer: string): string => "VIA_RoundD" + Math.round(((v.sizes && v.sizes.get(layer)) || v.size) * 1e6);
  const layerDir = (r: Row): string => `steps/pcb/layers/${r.name}/`;
  const attrlist = (r: Row): string => {
    let s = `UNITS=${units}\n`;
    if (r.thickness && r.thickness > 0) s += `.layer_dielectric=${data(r.thickness)}\n`;
    if (r.copper) s += `.copper_weight=${fix(inch ? (r.thickness || 0) / 0.035 : (r.thickness || 0) * 1000)}\n`;
    if (r.epsilonR && r.epsilonR > 0) s += `.dielectric_constant=${fix(r.epsilonR)}\n`;
    if (r.lossTangent && r.lossTangent > 0) s += `.loss_tangent=${fix(r.lossTangent)}\n`;
    if (r.material) s += `material=${legalEntityName(r.material)}\n`;
    return s;
  };
  const shape = boardShape(m.doc);
  const edgePlating = boardFinish(setup as unknown as SNode | null).edgePlating;
  for (const r of rows) {
    const F = new Features(); const A = F.attrs; const dir = layerDir(r);
    put(dir + "attrlist", attrlist(r));
    if (r.role === "board" && r.layer) {
      const layer = r.layer, cu = isCopper(layer);
      for (const p of plotLayer(m, layer, plotOpt, log, conn)) {
        const made = F.prim(p); if (!made.length) continue;
        const src = p.meta ? p.meta.src : undefined;
        for (const i of made) {
          const rec = F.recs[i].attrs;
          if (src && padSub.has(src as Pad)) {
            const pad = src as Pad;
            if (cu) fid(padSub.get(pad)!, "C", r.name, i);
            A.sys(rec, "pad_usage", pad.property === "pad_prop_fiducial_glob" ? "2" : pad.property === "pad_prop_fiducial_loc" ? "3" : "0");
            if (pad.property === "pad_prop_testpoint") A.sys(rec, "test_point");
            if (!pad.drill) A.sys(rec, "smd");
          } else if (src && viaSet.has(src)) {
            const v = src as Via;
            if (cu) fid(trackSub.get(v)!, "C", r.name, i);
            A.sys(rec, "pad_usage", "1"); A.text(rec, "geometry", geometry(v, cu ? layer : /^B\./.test(layer) ? last : first));
          } else if (src && trackSet.has(src)) { if (cu) fid(trackSub.get(src as Track)!, "C", r.name, i); }
          else if (src && fillSet.has(src)) {
            const f = src as ZoneFill;
            if (cu) { const s = planeOf(f); if (s) fid(s, "C", r.name, i); }
            const at = f.zone ? (kid(f.zone, "attr") as Node | null) : null;
            if (at && kid(at, "teardrop")) A.sys(rec, "tear_drop");
          } else if (p.text && p.text.text) A.text(rec, "string", p.text.text);
        }
      }
      put(dir + "features", F.file());
    } else if (r.role === "drill" && r.drill) {
      const key = drillKey(r.drill);
      const tools: { type: string; type2: string; size: string }[] = [];
      const tool = (type: string, type2: string, d: number): void => { const size = sym(d); if (!tools.some((t) => t.type === type && t.type2 === type2 && t.size === size)) tools.push({ type, type2, size }); };
      // slots first, then the round holes, as InitDrillData collects them
      const mine = hits.filter((h) => drillKey(h) === key);
      for (const h of mine.filter((x) => x.slot).concat(mine.filter((x) => !x.slot))) {
        let i: number;
        if (h.slot) {
          const delta = Math.abs(h.slot.w - h.slot.h) / 2, half = rot(h.slot.w > h.slot.h ? delta : 0, h.slot.w > h.slot.h ? 0 : delta, h.slot.rot);
          i = F.line(h.x - half[0], h.y - half[1], h.x + half[0], h.y + half[1], h.d);
        } else i = F.pad(h.x, h.y, "r" + sym(h.d), 0);
        const rec = F.recs[i].attrs;
        if (h.via) {
          const v = h.via, pr = protection(v);
          tool("VIA", v.type === "micro" ? "LASER" : "STANDARD", h.d);
          fid(trackSub.get(v)!, "H", r.name, i);
          A.sys(rec, "drill", "2");
          const t = ipcType(pr.filled, pr.capped, pr.plugF, pr.covF, pr.tentF), b = ipcType(pr.filled, pr.capped, pr.plugB, pr.covB, pr.tentB);
          if (t) A.text(rec, "ipc_via_type_top", String(t)); if (b) A.text(rec, "ipc_via_type_bottom", String(b));
          if (v.type === "micro") A.sys(rec, "via_type", "1");
          A.text(rec, "geometry", geometry(v, v.layers[0]));
        } else if (h.pad) {
          const press = h.pad.property === "pad_prop_pressfit";
          tool(h.plated ? "PLATED" : "NON_PLATED", h.plated && press ? "PRESS_FIT" : "STANDARD", h.d);
          if (h.plated) { fid(padSub.get(h.pad)!, "H", r.name, i); A.sys(rec, "drill", "0"); if (press) A.sys(rec, "plated_type", "1"); }
          else { A.sys(rec, "drill", "1"); if (!h.pad.number) A.sys(rec, "pad_usage", "4"); }
        }
      }
      put(dir + "features", F.file());
      put(dir + "tools", `UNITS=${units}\nTHICKNESS=0\nUSER_PARAMS=\n` + tools.map((t, i) => `TOOLS {\n    NUM=${i + 1}\n    TYPE=${t.type}\n    TYPE2=${t.type2}\n    MIN_TOL=0\n    MAX_TOL=0\n    BIT=\n    FINISH_SIZE=${t.size}\n    DRILL_SIZE=${t.size}\n}\n\n`).join(""));
    } else if (r.role === "rout") {
      let chain = 1;
      const loop = (pts: Pt[]): void => {
        const at = F.recs.length;
        for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (a[0] !== b[0] || a[1] !== b[1]) F.line(a[0], a[1], b[0], b[1], 0); }
        for (let i = at; i < F.recs.length; i++) { A.sys(F.recs[i].attrs, "rout_chain", String(chain)); if (edgePlating) A.sys(F.recs[i].attrs, "rout_plated"); }
        chain++;
      };
      if (shape.fallback) warnings.push("Board outline is not closed; ODB++ rout layer has no board contour.");
      else for (const ol of shape.outlines) { loop(ol.contour); for (const c of ol.cutouts) loop(c); }
      for (const h of hits) {
        if (!h.slot || !h.pad) continue;
        const delta = Math.abs(h.slot.w - h.slot.h) / 2, half = rot(h.slot.w > h.slot.h ? delta : 0, h.slot.w > h.slot.h ? 0 : delta, h.slot.rot);
        const i = F.line(h.x - half[0], h.y - half[1], h.x + half[0], h.y + half[1], h.d);
        A.sys(F.recs[i].attrs, "rout_chain", String(chain++)); if (h.plated) A.sys(F.recs[i].attrs, "rout_plated");
      }
      put(dir + "features", F.file());
    } else if (r.role === "aux" && r.aux) {
      const hole = r.aux.kind === "plugging" || r.aux.kind === "filling" || r.aux.kind === "capping";
      for (const v of auxVias.get(r) || []) {
        const i = F.pad(v.x, v.y, "r" + sym(hole ? v.drill : (v.sizes && v.sizes.get(r.aux.layer)) || v.size), 0);
        const rec = F.recs[i].attrs;
        if (hole) { fid(trackSub.get(v)!, "H", r.name, i); A.sys(rec, "drill", "2"); } else A.sys(rec, "pad_usage", "1");
        A.text(rec, "geometry", geometry(v, r.aux.layer));
      }
      put(dir + "features", F.file());
    } else {
      put(dir + "features", F.file());
      if (r.role === "comp" && r.side) put(dir + "components", `UNITS=${units}\n` + compAttrs[r.side].tables() + compText[r.side].join(""));
    }
  }
  for (const w of log.messages) warnings.push(w);

  // ---- matrix/matrix
  let matrix = `STEP {\n    COL=1\n    ID=${stepUid}\n    NAME=pcb\n}\n\n`;
  rows.forEach((r, i) => {
    matrix += `LAYER {\n    ROW=${i + 1}\n    ID=${r.uid}\n    CONTEXT=${r.context}\n    TYPE=${r.type}\n    NAME=${r.name}\n    OLD_NAME=\n    POLARITY=${r.polarity}\n`;
    if (r.diType) {
      matrix += `    DIELECTRIC_TYPE=${r.diType}\n`;
      if (r.diName) matrix += `    DIELECTRIC_NAME=${r.diName}\n`;
      if (r.cuTop) matrix += `    CU_TOP=${r.cuTop}\n`;
      if (r.cuBottom) matrix += `    CU_BOTTOM=${r.cuBottom}\n`;
    }
    if (r.ref) matrix += `    REF=${r.ref}\n`;
    if (r.span) matrix += `    START_NAME=${r.span[0]}\n    END_NAME=${r.span[1]}\n`;
    matrix += "    COLOR=0\n}\n\n";
  });
  put("matrix/matrix", matrix);

  // ---- matrix/stackup.xml (GenerateStackupFile)
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const el = (name: string, attrs: [string, string][], kids: string[] = [], depth = 0): string => {
    const pad = "  ".repeat(depth), a = attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    return kids.length ? `${pad}<${name}${a}>\n${kids.join("")}${pad}</${name}>\n` : `${pad}<${name}${a}/>\n`;
  };
  {
    const materials: string[] = [], layers: string[] = [];
    for (const r of rows) {
      if (r.context !== "BOARD") continue;
      const at: [string, string][] = [["LayerName", r.name], ["LayerType", r.type]];
      if (r.type === "DIELECTRIC") at.push(["Side", "INNER"]);
      else if (r.layer && /^F\./.test(r.layer)) at.push(["Side", "TOP"]);
      else if (r.layer && /^B\./.test(r.layer)) at.push(["Side", "BOTTOM"]);
      else if (r.layer && isCopper(r.layer)) at.push(["Side", "INNER"]);
      if (r.span && (r.type === "DRILL" || r.type === "ROUT")) { if (r.span[0]) at.push(["MechStartLayerName", r.span[0]]); if (r.span[1]) at.push(["MechEndLayerName", r.span[1]]); }
      const hasItem = (r.role === "dielectric" || r.copper || r.mask) && (r.thickness || 0) > 0;
      if (!hasItem) { layers.push(el("Layer", at, [], 4)); continue; }
      const inner: string[] = [];
      if (r.copper) inner.push(el("Conductor", [["ConductorType", "COPPER"], ["CopperWeight_oz_ft2", fix((r.thickness || 0) / 0.035)]], [], 5));
      else {
        const dat: [string, string][] = r.mask ? [["DielectricType", "OTHER"], ["OtherSubType", "SOLDER_MASK"]] : [["DielectricType", r.diType || "UNDEFINED"]];
        if (r.material && r.material !== "Not specified") dat.push(["MaterialReference", r.material]);
        const dk = !!r.epsilonR && r.epsilonR > 0, df = !!r.lossTangent && r.lossTangent > 0;
        const pat: [string, string][] = []; if (dk) pat.push(["DielectricConstant_Dk", fix(r.epsilonR!)]); if (df) pat.push(["LossTangent_Df", fix(r.lossTangent!)]);
        inner.push(el("Dielectric", dat, dk || df ? [el("Properties", [["PropertyName", "default"]], [el("Property", pat, [], 7)], 6)] : [], 5));
      }
      inner.push(el("Default_Thickness", [["Thickness", data(r.thickness || 0)], ["Units", units]], [], 5));
      materials.push(el("Material", [["MaterialName", r.name]], inner, 4));
      layers.push(el("Layer", at, [el("SpecRef", [["MaterialSpecName", "pcb"]], [el("Material", [["MaterialName", r.name]], [], 6)], 5)], 4));
    }
    const maskThick = rows.some((r) => r.mask && (r.thickness || 0) > 0);
    const company = (m.doc.titleBlock && m.doc.titleBlock.company) || "";
    put("matrix/stackup.xml", '<?xml version="1.0" encoding="UTF-8"?>\n' + el("StackupFile", [["Version", "8.1"], ["DefaultUnits", units]], [
      el("EdaData", [["CompanyName", company]], [
        el("Specs", [], [el("Spec", [["SpecName", "pcb"]], materials, 3)], 2),
        el("Stackup", [["StackupName", "pcb"], ["StackupThickness", data(boardThickness)], ["Units", units], ["WhereMeasured", maskThick ? "MASK" : "METAL"]], [el("Group", [["GroupName", "pcb"]], layers, 3)], 2),
      ], 1)]));
  }

  // ---- the step
  put("steps/pcb/stephdr", `UNITS=${units}\nX_DATUM=0\nY_DATUM=0\nX_ORIGIN=0\nY_ORIGIN=0\nTOP_ACTIVE=0\nBOTTOM_ACTIVE=0\nRIGHT_ACTIVE=0\nLEFT_ACTIVE=0\nAFFECTING_BOM=\nAFFECTING_BOM_CHANGED=0\n`);
  put("steps/pcb/attrlist", `UNITS=${units}\n.board_thickness=${fix(scale * boardThickness * 1000)}\n`);
  {
    const P = new Features();
    // the largest outline, with its cut-outs
    let best = -1, bestArea = 0;
    shape.outlines.forEach((ol, i) => { const a = Math.abs(area(ol.contour)); if (best < 0 || a > bestArea) { best = i; bestArea = a; } });
    if (best >= 0) P.surface(shape.outlines[best].contour, shape.outlines[best].cutouts);
    put("steps/pcb/profile", P.profile());
  }
  // eda/data
  const pad2 = (n: number): string => String(n).padStart(2, "0"); const d = o.date;
  let eda = `# ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}\nHDR KiCad EDA ${o.version}\nUNITS=${units}\nLYR${edaLayers.map((l) => " " + l).join("")}\n` + new Attrs().tables();
  for (const n of nets) { eda += `#NET ${n.index}\nNET ${n.name} ;;\n`; for (const s of n.subnets) eda += `SNT ${s.head}\n` + s.fids.map((f) => f + "\n").join(""); }
  pkgs.forEach((p, i) => { eda += `# PKG ${i}\n${p.text}#\n`; });
  put("steps/pcb/eda/data", eda);
  // netlists/cadnet/netlist (ODB_NET_LIST)
  {
    const recs = new Map<number, string[]>();
    const add = (net: Net, line: string): void => { const l = recs.get(net.index); if (l) l.push(line); else recs.set(net.index, [line]); };
    const maskOf = (front: boolean, back: boolean): string => { let s = 3; if (front) s &= ~1; if (back) s &= ~2; return s === 3 ? "c" : s === 2 ? "s" : s === 1 ? "p" : "e"; };
    for (const v of m.vias) {
      const top = viaTop(v), bot = viaBottom(v); if (!top && !bot) continue;
      const net = netOf(v.net);
      let ends = 0; for (const t of m.tracks) if ((Math.abs(t.x1 - v.x) < 1e-6 && Math.abs(t.y1 - v.y) < 1e-6) || (Math.abs(t.x2 - v.x) < 1e-6 && Math.abs(t.y2 - v.y) < 1e-6)) ends++;
      const openF = top && !viaFlag(v, v.tentFront, S.tentFront), openB = bot && !viaFlag(v, v.tentBack, S.tentBack);
      add(net, `${net.index} ${data(v.drill / 2)} ${X(v.x)} ${Y(v.y)} ${top && bot ? "B" : top ? "T" : "D"} ${ends < 2 ? "e" : "m"} ${maskOf(openF, openB)} staggered 0 0 0 v`);
    }
    for (const fp of m.footprints) for (const pad of fp.pads) {
      const front = pad.layers.has("F.Cu"), back = pad.layers.has("B.Cu"); if (!front && !back) continue;
      const net = netOf(pad.net); const hole = !!pad.drill;
      const sh = padShapeOn(pad, front ? "F.Cu" : "B.Cu", m.copper);
      const size = hole ? "" : `${data(sh.w)} ${data(sh.shape === "circle" ? sh.w : sh.h)} `;
      add(net, `${net.index} ${hole ? data(Math.min(pad.drill!.w, pad.drill!.h) / 2) : "0.002"} ${X(pad.x)} ${Y(pad.y)} ${front && back ? "B" : front ? "T" : "D"} ${size}e ${maskOf(pad.layers.has("F.Mask"), pad.layers.has("B.Mask"))}${hole ? " staggered 0 0 0" : ""}${pad.property === "pad_prop_testpoint" ? " t" : ""}`);
    }
    const keys = [...recs.keys()].sort((a, b) => a - b);
    put("steps/pcb/netlists/cadnet/netlist", `H optimize n staggered n\nUNITS=${units}\n` + keys.map((k) => `$${k} ${nets[k].name}\n`).join("") + "#\n#Netlist points\n#\n" + keys.map((k) => recs.get(k)!.map((l) => l + "\n").join("")).join(""));
  }

  // ---- misc
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  put("misc/info", `JOB_NAME=job\nUNITS=${units}\nODB_VERSION_MAJOR=8\nODB_VERSION_MINOR=1\nODB_SOURCE=KiCad EDA\nCREATION_DATE=${stamp}\nSAVE_DATE=${stamp}\nSAVE_APP=KiCad EDA ${o.version}\n${o.productModelName ? `PRODUCT_MODEL_NAME=${o.productModelName}\n` : ""}MAX_UID=${maxUid}\n`);
  {
    let ua = `UNITS=${units}\nTEXT {\nNAME=material\nENTITY=LAYER\nMIN_LEN=0\nMAX_LEN=64\nOPTIONS=\nGROUP=Product\n}\n`;
    for (const side of ["top", "bottom"]) {
      ua += `OPTION {\nNAME=post_machining_${side}\nENTITY=FEATURE\nOPTIONS=countersink;counterbore\nGROUP=Fabrication\n}\n`;
      for (const dim of ["diameter", "depth"]) ua += `FLOAT {\nNAME=post_machining_${side}_${dim}\nENTITY=FEATURE\nMIN_VAL=0.0\nMAX_VAL=100000.0\nUNITS=MIL_MICRON\nGROUP=Fabrication\n}\n`;
      ua += `FLOAT {\nNAME=post_machining_${side}_angle\nENTITY=FEATURE\nMIN_VAL=0.0\nMAX_VAL=180.0\nGROUP=Fabrication\n}\n`;
    }
    put("misc/userattr", ua);
  }
  {
    // GenerateMetadataFile: the values the board gives; counter bores and countersinks are not read by the web model
    const fin = boardFinish(setup as unknown as SNode | null);
    const yn = (b: boolean): string => (b ? "yes" : "no");
    const sides = (t: boolean, b: boolean, none: string): string => (t ? (b ? "Both" : "Top") : b ? "Bottom" : none);
    const hasItems = (layer: string): boolean => enabled.has(layer) && plotLayer(m, layer, plotOpt, new PlotLog(), conn).length > 0;
    const finishNames: { [k: string]: string } = { "HAL SnPb": "HASL", "HAL lead-free": "Lead-Free HASL", "Immersion silver": "Immersion Silver", "Immersion tin": "White Tin", OSP: "OSP (Entek)", None: "Bare Cu" };
    const node = (name: string, display: string, value: string, distance = false): string => el("node", ([["name", name], ["display", display], ["value", value]] as [string, string][]).concat(distance ? [["units", units]] : []), [], 2);
    const header = [node("layer_count", "Layer Count", String(m.copper.length))];
    const req = [node("board_thickness", "Board Thickness", data(boardThickness), true), node("legend_sides", "Legend Sides", sides(hasItems("F.SilkS"), hasItems("B.SilkS"), "none")),
      node("plated_edge", "Plated Edge", yn(fin.edgePlating)), node("plated_slots", "Plated Slots", yn(hits.some((h) => h.slot && h.plated))), node("soldermask_sides", "Soldermask Sides", sides(enabled.has("F.Mask"), enabled.has("B.Mask"), "None"))];
    header.unshift(node("edge_connectors", "Edge Connectors", yn(fin.edgeConnector !== "no")));
    const steps: string[] = [];
    const finish = finishNames[fin.copperFinish] || fin.copperFinish;
    if (fin.hasStackup && finish && finish !== "User defined" && /^[\x20-\x7e]*$/.test(finish)) steps.push(el("Manufacturing", [["description", "Manufacturing Process"]], [node("surface_finish_pads", "Surface Finish Pads", finish).replace(/^ {4}/, "        ")], 3));
    steps.push(el("Assembly", [["description", "Assembly"]], [node("pressfit_technology", "Pressfit Technology", yn(hits.some((h) => !!h.pad && h.pad.property === "pad_prop_pressfit"))).replace(/^ {4}/, "        ")], 3));
    put("misc/metadata.xml", '<?xml version="1.0" encoding="UTF-8"?>\n' + el("metadata", [], [el("Header", [["description", "General Information"]], header, 1), el("Requirements", [["description", "Board Requirements"]], req, 1),
      el("Steps", [["description", "Steps"]], [el("Step", [["name", "pcb"]], steps, 2)], 1)]));
  }
  put("fonts/standard", ODB_STANDARD_FONT + "\n");
  return { files, dirs: ["fonts", "input", "matrix", "misc", "steps/pcb/layers", "steps/pcb/eda", "steps/pcb/netlists/cadnet", "symbols", "user", "wheels"], warnings };
}
