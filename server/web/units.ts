// units.ts — EDA_DRAW_FRAME::UpdateStatusBar's number formatting for the status bar.
//
// EDA_UNIT_UTILS::UI::MessageTextFromValue (common/eda_units.cpp): the board prints "%.4f" mm, "%.4f" in,
// "%.2f" mils; the schematic (IU_PER_MM == SCH_IU_PER_MM, the "short form") "%.3f" mm, "%.3f" in, "%.0f" mils.
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
/** MessageTextFromValue( EDA_ANGLE ): "%.1f°". */
export function angleText(deg: number): string { return `${deg.toFixed(1)}°`; }
/**
 * A coordinate the way the status bar prints it (MessageTextFromValue without the unit text).  `short` is the
 * schematic editors' short form.
 */
export function fmtCoord(mm: number, units: Units, short = false): string { return messageText(mm, units, short ? "sch" : "pcb", false); }
/** The unit text of a dialog's value ("mm", "in", "mils"); the status bar's units field is unitsMsg. */
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
 * that would print as zeros is printed in scientific notation.  The value is first held to the editor's internal
 * units (SCH_IU_PER_MM 1e4, pcbnew's 1e6) as KiCad's integers are, so a value below one IU is zero, never "-0".
 * `label` appends " mm", " mils" or " in".
 */
export function messageText(mm: number, units: Units, scale: IuScale, label = true): string {
  const u = UNITS[units] ? units : "mm", short = scale === "sch", iu = short ? 1e4 : 1e6;
  const v = UNITS[u].f(Math.round(mm * iu) / iu);
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
/**
 * GRID::MessageText (common/settings/grid_settings.cpp): one value when X == Y, otherwise "X x Y", each by
 * MessageTextFromValue in the editor's scale, with the unit text when `label`.
 */
export function gridMessageText(x: number, y: number, units: Units, scale: IuScale, label = false): string {
  const xs = messageText(x, units, scale, label), ys = messageText(y, units, scale, label);
  return xs === ys ? xs : `${xs} x ${ys}`;
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

// ---------------------------------------------------------------- where the units are kept (APP_SETTINGS_BASE)
/**
 * The KiCad application whose settings file keeps the units: each has its own "system.units" and
 * "system.last_imperial_units" (common/settings/app_settings.cpp), so switching units in one editor leaves the others.
 */
export type UnitsApp = "eeschema" | "pcbnew" | "footprint_editor" | "symbol_editor";
export interface UnitsSettings { units: Units; lastImperial: Units }
const unitsKey = (app: UnitsApp): string => "kui.units." + app;
/** The application of a document type: the schematic is eeschema, a board pcbnew, a footprint the footprint editor. */
export function unitsAppFor(docType: string): UnitsApp { return docType === "kicad_sch" ? "eeschema" : docType === "footprint" ? "footprint_editor" : "pcbnew"; }
/** system.units and system.last_imperial_units: eeschema and the symbol editor start in mils, the board editors in mm. */
export function loadUnits(app: UnitsApp): UnitsSettings {
  const def: UnitsSettings = { units: app === "eeschema" || app === "symbol_editor" ? "mil" : "mm", lastImperial: "mil" };
  try {
    const raw = JSON.parse(localStorage.getItem(unitsKey(app)) || "null") as { units?: unknown; last_imperial_units?: unknown } | null;
    if (!raw || typeof raw !== "object") return def;
    const u = raw.units, li = raw.last_imperial_units;
    return { units: u === "mm" || u === "mil" || u === "in" ? u : def.units, lastImperial: li === "in" || li === "mil" ? li : u === "in" ? "in" : "mil" };
  } catch (e) { return def; }
}
/** Save both, as KiCad writes system.units and system.last_imperial_units when the frame's units change. */
export function saveUnits(app: UnitsApp, s: UnitsSettings): void {
  try { localStorage.setItem(unitsKey(app), JSON.stringify({ units: s.units, last_imperial_units: s.lastImperial === "in" ? "in" : "mil" })); } catch (e) { /* no storage */ }
}
