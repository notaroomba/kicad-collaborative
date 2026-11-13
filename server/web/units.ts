// units.ts — EDA_DRAW_FRAME::UpdateStatusBar's number formatting for the status bar.
import type { Units } from "./store";

export const UNITS: Record<Units, { name: string; f: (mm: number) => number; d: number }> = {
  mm: { name: "mm", f: (v) => v, d: 4 },
  in: { name: "in", f: (v) => v / 25.4, d: 4 },
  mil: { name: "mils", f: (v) => v / 0.0254, d: 2 },
};

/** Format a millimetre length in the given units, trailing zeros trimmed ("1.27", "0.05", "50"). */
export function fmtLen(mm: number, units: Units): string {
  const u = UNITS[units] || UNITS.mm;
  return u.f(mm).toFixed(u.d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
/** A coordinate the way the status bar prints it: fixed decimals per unit ("%.4f" mm and inches, "%.2f" mils), never "-0". */
export function fmtCoord(mm: number, units: Units): string {
  const u = UNITS[units] || UNITS.mm; const s = u.f(mm).toFixed(u.d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}
export function unitName(units: Units): string { return (UNITS[units] || UNITS.mm).name; }

// ---------------------------------------------------------------- KiCad's user-unit text (common/eda_units.cpp)
/** Which internal-unit scale a value comes from: eeschema's (SCH_IU_PER_MM, the "short form") or pcbnew's. */
export type IuScale = "sch" | "pcb";
const UNIT_TEXT: Record<Units, string> = { mm: " mm", mil: " mils", in: " in" };
/** C's "%.Ne": a mantissa with N decimals and a signed exponent of at least two digits ("1.000e-03"). */
function cExp(v: number, n: number): string { const [m, e] = v.toExponential(n).split("e"); const x = Number(e); return `${m}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`; }
/**
 * EDA_UNIT_UTILS::UI::MessageTextFromValue for a distance: "%.4f" mm, "%.2f" mils, "%.4f" in on a board; the
 * schematic's short form "%.3f" mm (trimmed to two decimals when the third is 0), "%.0f" mils, "%.3f" in.  A value
 * that would print as zeros is printed in scientific notation.  `label` appends " mm", " mils" or " in".
 */
export function messageText(mm: number, units: Units, scale: IuScale, label = true): string {
  const u = UNITS[units] ? units : "mm", short = scale === "sch", v = UNITS[u].f(mm);
  const digits = u === "mm" ? (short ? 3 : 4) : u === "mil" ? (short ? 0 : 2) : short ? 3 : 4;
  let text = v.toFixed(digits);
  if (v !== 0 && !/[1-9]/.test(text)) text = cExp(v, 3);
  if (short && u === "mm") { const n = text.length; if (n > 4 && text[n - 4] === "." && text[n - 1] === "0") text = text.slice(0, -1); }
  return label ? text + UNIT_TEXT[u] : text;
}
/** EDA_DRAW_FRAME::GetUnitPair: metric shows the last imperial unit second (mils at first), imperial shows mm. */
export function unitPair(units: Units, lastImperial: Units = "mil"): [Units, Units] {
  return units === "mm" ? ["mm", lastImperial === "in" ? "in" : "mil"] : [units, "mm"];
}
/** A grid as KiCad's settings keep it (GRID): an optional name and the size in mm (square grids only on the web). */
export interface GridDef { mm: number; name?: string }
/** One entry of GRID_MENU::BuildChoiceList: "Name: " when named, then the size in the user units and, in brackets, the other system. */
export function gridChoiceText(g: GridDef, units: Units, lastImperial: Units, scale: IuScale): string {
  const [pri, sec] = unitPair(units, lastImperial);
  return `${g.name ? g.name + ": " : ""}${messageText(g.mm, pri, scale)} (${messageText(g.mm, sec, scale)})`;
}
/** EDA_DRAW_FRAME::DisplayUnitsMsg: the status bar's units field. */
export function unitsMsg(units: Units): string { return units === "in" ? "inches" : units === "mil" ? "mils" : "mm"; }
