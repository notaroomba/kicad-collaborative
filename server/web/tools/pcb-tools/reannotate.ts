// pcb-tools/reannotate.ts — Tools > Geographical Reannotate... (DIALOG_BOARD_REANNOTATE::ReannotateBoard): the
// footprints of each side sorted by their (grid-rounded) location in one of eight directions, then renumbered per
// reference prefix, with the change log and the problems the dialog's report shows.  Sheet-suffix sharing (reused
// sheets) is off, as it is in a project without schematic.annotation.reused_sheet_suffixes.
import type { BoardDoc, PcbChange } from "./types";
import { replacedChange } from "./changes";
import { K } from "./state";
import { clone } from "./util";

export interface ReannotateOpts {
  /** 0..7: the direction radio buttons in the dialog's order (m_sortButtons) */
  sortCode: number;
  /** "Based on location of:" Footprint (true) or Reference */
  useFootprintLocation: boolean;
  /** "Round locations to:" grid, mm */
  grid: number;
  scope: "all" | "front" | "back" | "selection";
  selected?: Set<string> | null;
  excludeLocked: boolean;
  /** "Exclude references:" (R means R*; R* matches like wxString::Matches) */
  exclude: string;
  frontStart: string; backStart: string; frontPrefix: string; backPrefix: string; removeFrontPrefix: boolean; removeBackPrefix: boolean;
  /** MessageTextFromValue for the report's coordinates */
  fmt?(mm: number): string;
}
export type ReportSeverity = "info" | "action" | "warning" | "error";
export interface ReannotatePlan {
  ok: boolean;
  /** footprints with an empty or invalid reference (ReannotateBoard asks "Reannotate anyway?") */
  bad: { ref: string; fpid: string; x: number; y: number }[];
  report: { severity: ReportSeverity; text: string }[];
  changes: PcbChange[];
  /** old -> new for the footprints that change */
  renames: { id: string; from: string; to: string }[];
}

const SORTYFIRST = 0x100, DESCENDINGFIRST = 0x10, DESCENDINGSECOND = 0x1, SORTXFIRST = 0, ASCENDINGFIRST = 0, ASCENDINGSECOND = 0;
const FRONT_DIRS = [SORTYFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + DESCENDINGSECOND,
  SORTXFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + DESCENDINGSECOND];
const BACK_DIRS = [SORTYFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + ASCENDINGSECOND,
  SORTXFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + DESCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + DESCENDINGSECOND];
const MINGRID = 1000, MAXERROR = 10;
enum Action { UPDATE, EMPTY, INVALID, EXCLUDE }
const ACTION_MESSAGE = ["", "(not updated)", "(unannotated; not updated)", "(excluded)"];

interface Info { id: string; ref: string; fpid: string; x: number; y: number; rx: number; ry: number; front: boolean; action: Action; prefix: string }
interface PrefixInfo { prefix: string; last: number; unavailable: Set<number> }

const nm = (mm: number): number => Math.round(mm * 1e6);
/** RoundToGrid, in nm like the board's internal units. */
function roundToGrid(c: number, grid: number): number {
  if (!grid) grid = MINGRID;
  const r = c % grid; c -= r;
  if (Math.abs(r) > grid / 2) c += c < 0 ? -grid : grid;
  return c;
}
/** StrNumCmp: digit runs compare as numbers. */
export function strNumCmp(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g, xa = a.match(re) || [], xb = b.match(re) || [];
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const p = xa[i], q = xb[i], np = /^\d/.test(p), nq = /^\d/.test(q);
    if (np && nq) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1; }
    else { const d = p.toUpperCase().localeCompare(q.toUpperCase()); if (d) return d < 0 ? -1 : 1; }
  }
  return xa.length - xb.length;
}
/** wxString::Matches: * and ? wildcards over the whole string. */
const matches = (s: string, pat: string): boolean => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(s);
const refDesNumber = (r: string): number => { const m = /\d+/.exec(r); return m ? Number(m[0]) : -1; };
function refField(n: SNode): SNode | null {
  for (const c of n) if (Array.isArray(c) && ((c[0] === "property" && K.str(c[1]) === "Reference") || (c[0] === "fp_text" && K.str(c[1]) === "reference"))) return c as SNode;
  return null;
}
const isLocked = (n: SNode): boolean => n.includes("locked") || (() => { const l = K.kid(n, "locked"); return !!l && K.str(l[1]) !== "no"; })();

export function geographicalReannotate(doc: BoardDoc, o: ReannotateOpts): ReannotatePlan {
  const report: ReannotatePlan["report"] = [], show = (severity: ReportSeverity, text: string): void => { for (const t of text.split("\n")) report.push({ severity, text: t }); };
  const fmt = o.fmt || ((v: number) => v.toFixed(4) + " mm");
  const coord = (x: number, y: number): string => `${fmt(x / 1e6)}, ${fmt(y / 1e6)}`;
  const excludes = o.exclude.split(/[,\s]+/).filter(Boolean);
  const grid = nm(o.grid);
  const front: Info[] = [], back: Info[] = [];
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint");
  // BuildFootprintList
  for (const fp of fps) {
    const n = fp.node, at = K.kid(n, "at"), fx = at ? K.num(at[1]) : 0, fy = at ? K.num(at[2]) : 0, rot = at && at.length > 3 ? K.num(at[3]) : 0;
    const rf = refField(n), ref = rf && !Array.isArray(rf[2]) ? K.str(rf[2]) : "";
    let x = fx, y = fy;
    if (!o.useFootprintLocation && rf) {
      const ra = K.kid(rf, "at"); if (ra) { const r = rot * Math.PI / 180, lx = K.num(ra[1]), ly = K.num(ra[2]); x = fx + lx * Math.cos(r) + ly * Math.sin(r); y = fy - lx * Math.sin(r) + ly * Math.cos(r); }
    }
    const layer = K.kid(n, "layer"), isFront = !layer || K.str(layer[1]) === "F.Cu";
    const info: Info = { id: fp.id, ref, fpid: K.str(n[1]), x: nm(x), y: nm(y), rx: roundToGrid(nm(x), grid), ry: roundToGrid(nm(y), grid), front: isFront, action: Action.UPDATE, prefix: "" };
    let firstnum = -1;
    if (!ref) info.action = Action.EMPTY;
    else { firstnum = ref.search(/\d/); if (firstnum < 0) info.action = Action.INVALID; }
    info.prefix = firstnum < 0 ? ref : ref.slice(0, firstnum);
    for (const ex of excludes) {
      if (ex.endsWith("*") ? matches(ref, ex) : ex === info.prefix) { info.action = Action.EXCLUDE; break; }
    }
    const outOfScope = (isLocked(n) && o.excludeLocked) || (o.scope === "selection" && !(o.selected && o.selected.has(fp.id))) || (o.scope === "front" && !isFront) || (o.scope === "back" && isFront);
    if (info.action === Action.UPDATE && outOfScope) info.action = Action.EXCLUDE;
    (isFront ? front : back).push(info);
  }
  const sorter = (dirs: number[]) => {
    const code = dirs[o.sortCode >= 0 && o.sortCode < 8 ? o.sortCode : 0];
    const yFirst = !!(code & SORTYFIRST), descFirst = !!(code & DESCENDINGFIRST), descSecond = !!(code & DESCENDINGSECOND);
    // FootprintCompare as a three-way comparison
    return (a: Info, b: Info): number => {
      let x0 = a.rx, x1 = b.rx, y0 = a.ry, y1 = b.ry;
      if (yFirst) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
      if (descFirst) [x0, x1] = [x1, x0];
      if (descSecond) [y0, y1] = [y1, y0];
      return x0 !== x1 ? (x0 < x1 ? -1 : 1) : y0 !== y1 ? (y0 < y1 ? -1 : 1) : 0;
    };
  };
  front.sort(sorter(FRONT_DIRS)); back.sort(sorter(BACK_DIRS));
  const prefixes: PrefixInfo[] = [];
  const prefixInfo = (p: string, start = 1): PrefixInfo => { let f = prefixes.find((x) => x.prefix === p); if (!f) { f = { prefix: p, last: Math.max(start - 1, 0), unavailable: new Set() }; prefixes.push(f); } return f; };
  // BuildUnavailableRefsList
  for (const side of [front, back]) for (const f of side) {
    if (f.action === Action.UPDATE) continue;
    if (f.action === Action.EXCLUDE) prefixInfo(f.prefix).unavailable.add(refDesNumber(f.ref));
  }
  type Change = { id: string; action: Action; from: string; to: string };
  const changes: Change[] = [], bad: ReannotatePlan["bad"] = [];
  const build = (side: Info[], startText: string, prefix: string, remove: boolean): void => {
    const start = Math.max(0, parseInt(startText, 10) || 0);
    const have = prefix.length > 0, add = have && !remove; remove = remove && have;
    // LogFootprints
    let msg = (side[0].front ? "Front Footprints" : "Back Footprints") + " " + (o.useFootprintLocation ? "(sorted by footprint location)" : "(sorted by reference designator location)");
    msg += "\n-------------------------------------------------------------";
    side.forEach((f, i) => { msg += `\n${i + 1} ${f.ref || "unannotated footprint"} at ${coord(f.x, f.y)} (rounded to ${coord(f.rx, f.ry)})`; });
    show("info", msg);
    if (start !== 0) for (const p of prefixes) p.last = start - 1;
    for (const f of side) {
      const c: Change = { id: f.id, action: f.action, from: f.ref, to: f.ref };
      if (c.action === Action.EMPTY || c.action === Action.INVALID) { changes.push(c); bad.push({ ref: f.ref, fpid: f.fpid, x: f.x / 1e6, y: f.y / 1e6 }); continue; }
      if (c.action === Action.UPDATE) {
        let p = f.prefix; const present = p.indexOf(prefix) === 0;
        if (add && !present) p = prefix + p;
        if (remove && present) p = p.slice(prefix.length);
        const info = prefixInfo(p, start);
        let num = info.last + 1;
        // clashes() looks only at suffixed references, which a board without reused sheet suffixes has none of
        while (info.unavailable.has(num)) num++;
        const base = info.prefix + num;
        c.to = base; info.last = num;
      }
      changes.push(c);
    }
  };
  if (front.length) build(front, o.frontStart, o.frontPrefix, o.removeFrontPrefix);
  if (back.length) build(back, o.backStart, o.backPrefix, o.removeBackPrefix);
  changes.sort((a, b) => strNumCmp(a.from, b.from));
  // LogChangePlan
  let plan = "Reference Designator Prefixes in Use\n-------------------------------------------------------------\n";
  plan += prefixes.map((p, i) => p.prefix + ((i + 1) % 16 === 0 ? "\n" : " ")).join("");
  if (excludes.length) plan += `\n(Excluding ${excludes.join(" ")} from reannotation.)`;
  show("info", plan);
  let log = "Change Log\n-------------------------------------------------------------";
  for (const c of changes) log += c.action !== Action.UPDATE ? `\n${c.from || "unannotated footprint"}  ${ACTION_MESSAGE[c.action]}` : `\n${c.from || "unannotated footprint"} -> ${c.to || "unannotated footprint"}`;
  show("action", log);
  let errors = 0;
  for (let i = 0; i < changes.length && errors <= MAXERROR; i++) {
    if (changes[i].action === Action.EMPTY || changes[i].action === Action.INVALID) continue;
    for (let j = i + 1; j < changes.length; j++) {
      if (changes[i].to === changes[j].to) { show("error", `Duplicate instances of ${changes[j].to}`); if (errors++ > MAXERROR) { show("error", "Aborted: too many errors"); break; } }
    }
  }
  const ok = errors === 0;
  if (!ok) show("error", "Selected options resulted in errors! Change them and try again.");
  else if (bad.length) {
    let m = `PCB has ${bad.length} empty or invalid reference designations.\nYou may wish to run DRC with 'Test for parity between PCB and schematic' checked.`;
    for (const b of bad) m += `\n    RefDes: ${b.ref || "unannotated footprint"}; footprint: ${b.fpid || "unknown"} at ${coord(nm(b.x), nm(b.y))} on PCB.`;
    show("warning", m);
  }
  const out: PcbChange[] = [], renames: ReannotatePlan["renames"] = [];
  if (ok) for (const c of changes) {
    if (c.to === c.from) continue;
    const it = doc.items.get(c.id); if (!it) continue;
    const n = clone(it.node), rf = refField(n); if (!rf) continue;
    rf[2] = c.to; out.push(replacedChange(it, n)); renames.push({ id: c.id, from: c.from, to: c.to });
  }
  return { ok, bad, report, changes: out, renames };
}

/** The order the front side's sort visits points in, for the direction buttons' pictures (BITMAPS::reannotate_*). */
export function reannotateOrder(sortCode: number, pts: [number, number][]): number[] {
  const infos = pts.map((p, i) => ({ i, rx: p[0], ry: p[1] }));
  const code = FRONT_DIRS[sortCode] ?? FRONT_DIRS[0];
  const yFirst = !!(code & SORTYFIRST), descFirst = !!(code & DESCENDINGFIRST), descSecond = !!(code & DESCENDINGSECOND);
  infos.sort((a, b) => {
    let x0 = a.rx, x1 = b.rx, y0 = a.ry, y1 = b.ry;
    if (yFirst) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    if (descFirst) [x0, x1] = [x1, x0];
    if (descSecond) [y0, y1] = [y1, y0];
    return x0 !== x1 ? (x0 < x1 ? -1 : 1) : y0 !== y1 ? (y0 < y1 ? -1 : 1) : 0;
  });
  return infos.map((x) => x.i);
}
