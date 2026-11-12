// web/fab/parts — the two component tables an assembly house asks for beside the Gerbers:
//
//   placement (pick-and-place, "CPL", "centroid")  one row per footprint: where it sits, how it is turned and
//       on which side.  KiCad's own table is PLACE_FILE_EXPORTER's (Ref, Val, Package, PosX, PosY, Rot,
//       Side; Y up, relative to the drill / place origin when asked).
//   bill of materials  the board's footprints grouped by value, footprint and part number.
//
// Both are read from the board, so they describe exactly what the Gerbers describe.  A footprint marked
// "exclude from position files" or "exclude from BOM" is left out of that table, and "do not populate"
// parts are left out of both unless asked for.
import { type BoardModel, type Footprint } from "./model";
import { type Pt, rot } from "./prims";

/** StrNumCmp on reference designators: C2 before C10. */
export function refCompare(a: string, b: string): number {
  // StrNumCmp, case sensitive: runs of digits compare as numbers, everything else character by character
  let i = 0, j = 0; const digit = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (digit(c1) && digit(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && digit(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && digit(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  if (i >= a.length && j < b.length) return -1;
  if (i < a.length && j >= b.length) return 1;
  return 0;
}

/** An angle folded into (-180, 180], as EDA_ANGLE::Normalize180 leaves a footprint's orientation. */
export const norm180 = (a: number): number => { let r = a % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return r === 0 ? 0 : r; };

/** A CSV field: quoted when it holds a comma, a quote or a line break (or always, where KiCad always quotes). */
export function csvField(s: string, always = false): string {
  return always || /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------- placement
export interface PlacementOptions {
  side: "both" | "front" | "back";
  /** Only footprints with the SMD attribute. */
  smdOnly: boolean;
  /** Leave out footprints that have a through-hole pad. */
  excludeThroughHole: boolean;
  excludeDnp: boolean;
  /** Positions relative to the drill / place origin. */
  useAuxOrigin: boolean;
  negateBottomX: boolean;
}
export interface Placement { ref: string; value: string; pkg: string; x: number; y: number; rot: number; side: "top" | "bottom"; fp: Footprint }

/** PLACE_FILE_EXPORTER::GenPositionData's rows: mm, Y up, the back side first and each side by reference. */
export function placements(m: BoardModel, opt: PlacementOptions): Placement[] {
  const out: Placement[] = []; const o: Pt = opt.useAuxOrigin ? m.settings.auxOrigin : [0, 0];
  for (const fp of m.footprints) {
    const back = fp.side === "B.Cu";
    if (opt.side === "front" && back) continue;
    if (opt.side === "back" && !back) continue;
    if (fp.excludeFromPos) continue;
    if (opt.smdOnly && !fp.smd) continue;
    if (opt.excludeThroughHole && fp.pads.some((p) => p.type === "thru_hole")) continue;
    if (opt.excludeDnp && fp.dnp) continue;
    let x = fp.x - o[0]; if (back && opt.negateBottomX) x = -x;
    out.push({ ref: fp.ref, value: fp.value, pkg: fp.name, x, y: -(fp.y - o[1]) || 0, rot: norm180(fp.rot), side: back ? "bottom" : "top", fp });
  }
  // sortFPlist: the back side first, each side by reference
  return out.sort((a, b) => (a.side === b.side ? refCompare(a.ref, b.ref) : a.side === "bottom" ? -1 : 1));
}

/** KiCad's CSV placement file. */
export function placementCsv(rows: Placement[], inch = false): string {
  const L = ["Ref,Val,Package,PosX,PosY,Rot,Side"]; const k = inch ? 1 / 25.4 : 1;
  for (const r of rows) L.push([csvField(r.ref, true), csvField(r.value, true), csvField(r.pkg, true), (r.x * k).toFixed(6), (r.y * k).toFixed(6), r.rot.toFixed(6), r.side].join(","));
  return L.join("\n") + "\n";
}

/** KiCad's plain-text (.pos) placement file. */
export function placementAscii(rows: Placement[], side: string, date: string, software: string, inch = false): string {
  const k = inch ? 1 / 25.4 : 1;
  const u = (s: string): string => s.replace(/ /g, "_");
  const lr = Math.max(8, ...rows.map((r) => r.ref.length)), lv = Math.max(8, ...rows.map((r) => r.value.length)), lp = Math.max(16, ...rows.map((r) => r.pkg.length));
  const L = [`### Footprint positions - created on ${date} ###`, `### Printed by ${software}`, inch ? "## Unit = inches, Angle = deg." : "## Unit = mm, Angle = deg.", `## Side : ${side === "front" ? "top" : side === "back" ? "bottom" : "All"}`,
    `${"# Ref".padEnd(lr)}  ${"Val".padEnd(lv)}  ${"Package".padEnd(lp)}  ${"PosX".padStart(9)}  ${"PosY".padStart(9)}  ${"Rot".padStart(8)}  Side`];
  for (const r of rows) L.push(`${u(r.ref).padEnd(lr)}  ${u(r.value).padEnd(lv)}  ${u(r.pkg).padEnd(lp)}  ${(r.x * k).toFixed(4).padStart(9)}  ${(r.y * k).toFixed(4).padStart(9)}  ${r.rot.toFixed(4).padStart(8)}  ${r.side}`);
  L.push("## End");
  return L.join("\n") + "\n";
}

/** The centre of a footprint's pads on the board (an assembly house places a through-hole part by its body, not its anchor). */
export function padsCentre(fp: Footprint): Pt {
  if (!fp.pads.length) return [fp.x, fp.y];
  // the box is taken in the footprint's own frame, so a part at 30° reports the same centre as at 0°
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of fp.pads) {
    const [lx, ly] = rot(p.x - fp.x, p.y - fp.y, -fp.rot); const [hw, hh] = (() => { const a = Math.abs(Math.round((p.rot - fp.rot) / 90)) % 2 === 1; return a ? [p.base.h / 2, p.base.w / 2] : [p.base.w / 2, p.base.h / 2]; })();
    x0 = Math.min(x0, lx - hw); x1 = Math.max(x1, lx + hw); y0 = Math.min(y0, ly - hh); y1 = Math.max(y1, ly + hh);
  }
  const [dx, dy] = rot((x0 + x1) / 2, (y0 + y1) / 2, fp.rot);
  return [fp.x + dx, fp.y + dy];
}

// ---------------------------------------------------------------- bill of materials
/** The field names a supplier part number is kept under, most specific first. */
export const LCSC_FIELDS = ["LCSC Part #", "LCSC Part", "LCSC PN", "LCSC P/N", "LCSC Part No.", "LCSC Part Number", "JLCPCB Part #", "JLCPCB Part", "JLCPCB PN", "JLCPCB P/N", "JLCPCB Part No.", "JLCPCB Part Number", "LCSC", "JLC", "JLCPCB"];
export const MPN_FIELDS = ["MPN", "Mpn", "mpn", "Mfr. Part #", "Mfg Part #", "Manufacturer Part Number", "Manufacturer_Part_Number", "Part Number", "PartNumber", "PN", "P/N"];
export const MFR_FIELDS = ["Manufacturer", "Mfr", "Mfr.", "MFR", "Mfg", "Manufacturer_Name"];

/** The first non-empty field of a footprint among `names` (case-insensitive on a second pass). */
export function fieldOf(fp: Footprint, names: string[]): string {
  for (const n of names) { const v = fp.props.get(n); if (v && v.trim() && v.trim() !== "~") return v.trim(); }
  const lower = new Map<string, string>(); for (const [k, v] of fp.props) lower.set(k.toLowerCase(), v);
  for (const n of names) { const v = lower.get(n.toLowerCase()); if (v && v.trim() && v.trim() !== "~") return v.trim(); }
  return "";
}

export interface BomOptions { excludeDnp: boolean }
export interface BomLine { refs: string[]; value: string; footprint: string; qty: number; lcsc: string; mpn: string; manufacturer: string; description: string; dnp: boolean; smd: boolean; throughHole: boolean }

/** The board's parts grouped by value, footprint and part number; references in natural order. */
export function bom(m: BoardModel, opt: BomOptions): BomLine[] {
  const groups = new Map<string, BomLine>();
  for (const fp of m.footprints) {
    if (fp.excludeFromBom || fp.boardOnly && !fp.ref) continue;
    if (!fp.ref || /^#/.test(fp.ref)) continue;
    if (opt.excludeDnp && fp.dnp) continue;
    const lcsc = fieldOf(fp, LCSC_FIELDS), mpn = fieldOf(fp, MPN_FIELDS);
    const key = [fp.value.toUpperCase(), fp.name, lcsc, mpn, fp.dnp ? "dnp" : ""].join("\u0001");
    let g = groups.get(key);
    if (!g) { g = { refs: [], value: fp.value, footprint: fp.name, qty: 0, lcsc, mpn, manufacturer: fieldOf(fp, MFR_FIELDS), description: fieldOf(fp, ["Description", "ki_description"]), dnp: fp.dnp, smd: fp.smd, throughHole: fp.throughHole || fp.pads.some((p) => p.type === "thru_hole") }; groups.set(key, g); }
    g.refs.push(fp.ref); g.qty++;
  }
  const lines = [...groups.values()];
  for (const l of lines) l.refs.sort(refCompare);
  return lines.sort((a, b) => refCompare(a.refs[0], b.refs[0]));
}

/** KiCad's default BOM export: Refs, Value, Footprint, Qty, DNP. */
export function bomCsv(lines: BomLine[]): string {
  const L = ['"Refs","Value","Footprint","Qty","DNP"'];
  for (const l of lines) L.push([csvField(l.refs.join(","), true), csvField(l.value, true), csvField(l.footprint, true), csvField(String(l.qty), true), csvField(l.dnp ? "DNP" : "", true)].join(","));
  return L.join("\n") + "\n";
}
