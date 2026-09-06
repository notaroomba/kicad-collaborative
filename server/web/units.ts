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
export function unitName(units: Units): string { return (UNITS[units] || UNITS.mm).name; }
