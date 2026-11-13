// dialogs/erc-report.ts — ERC_REPORT::GetTextReport (eeschema/erc/erc_report.cpp), the text the ERC dialog's
// "Save..." writes, and the severity filter the dialog's list and the report share.
import { messageText } from "../units";
import type { Units } from "../store";

export interface ReportMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; base?: string }
/** The rule's own severity of a marker (an exclusion keeps it as base). */
export const sevOf = (m: ReportMarker): string => (m.severity === "exclusion" ? m.base || "warning" : m.severity);
/** RC_TREE_MODEL's filter: an exclusion shows only under Exclusions, the others by their severity. */
export function shownBy(m: ReportMarker, f: { errors: boolean; warnings: boolean; exclusions: boolean }): boolean {
  return m.severity === "exclusion" ? f.exclusions : m.severity === "error" ? f.errors : f.warnings;
}
/**
 * ERC_REPORT::GetTextReport for the markers the dialog shows (its provider's severities): the header, every marker
 * as RC_ITEM::ShowReport ("[key]: message\n    ; severity\n    @(x, y): item"), the counts and the ignored checks.
 */
export function ercTextReport(list: ReportMarker[], o: { errors: boolean; warnings: boolean; exclusions: boolean; units: Units; date: string; ignored: string[]; sheet?: string; title(m: ReportMarker): string; text?(s: string): string }): string {
  const inc = [o.errors && "Errors", o.warnings && "Warnings", o.exclusions && "Exclusions"].filter(Boolean).join(", ") || "None";
  let msg = `ERC report (${o.date}, Encoding UTF8)\nReport includes: ${inc}\n`;
  msg += `\n***** Sheet ${o.sheet || "/"}\n`;
  let err = 0, warn = 0, total = 0;
  const coord = (v: number): string => messageText(v, o.units, "sch");
  for (const m of list.filter((x) => shownBy(x, o))) {
    const sev = sevOf(m); total++; if (sev === "error") err++; else if (sev === "warning") warn++;
    msg += `[${m.code}]: ${o.title(m)}\n    ; ${sev}${m.severity === "exclusion" ? " (excluded)" : ""}\n`;
    if (m.ids.length) msg += `    @(${coord(m.x)}, ${coord(m.y)}): ${o.text ? o.text(m.text) : m.text}\n`;
  }
  msg += `\n ** ERC messages: ${total}  Errors ${err}  Warnings ${warn}\n\n ** Ignored checks:\n`;
  msg += o.ignored.length ? o.ignored.map((t) => `    - ${t}\n`).join("") : "    - None\n";
  return msg;
}
