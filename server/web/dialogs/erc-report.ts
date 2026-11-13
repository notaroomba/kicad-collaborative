// dialogs/erc-report.ts — ERC_REPORT::GetTextReport (eeschema/erc/erc_report.cpp), the text the ERC dialog's
// "Save..." writes, and the severity filter the dialog's list and the report share.
import { messageText } from "../units";
import type { Units } from "../store";

/** An item line of ShowReport: the item's own position and description ("%L" is a length, `len` mm, in the report units). */
export interface ReportItem { x: number; y: number; desc: string; len?: number }
export interface ReportMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; base?: string; comment?: string; items?: ReportItem[] }
/** The rule's own severity of a marker (an exclusion keeps it as base). */
export const sevOf = (m: ReportMarker): string => (m.severity === "exclusion" ? m.base || "warning" : m.severity);
/** RC_TREE_MODEL's filter: an exclusion shows only under Exclusions, the others by their severity. */
export function shownBy(m: ReportMarker, f: { errors: boolean; warnings: boolean; exclusions: boolean }): boolean {
  return m.severity === "exclusion" ? f.exclusions : m.severity === "error" ? f.errors : f.warnings;
}
/**
 * ERC_REPORT::GetTextReport for the markers the dialog shows (its provider's severities): the header, a
 * "***** Sheet <path>" block for every sheet in page order (`sheets`) holding the markers of its main item
 * (`sheetOf`, else the first sheet), each as RC_ITEM::ShowReport ("[key]: message\n    ; severity\n" then
 * "    @(x, y): description" for the main and the aux item, and an exclusion's comment), the counts and the ignored checks.
 */
export function ercTextReport(list: ReportMarker[], o: { errors: boolean; warnings: boolean; exclusions: boolean; units: Units; date: string; ignored: string[]; sheet?: string; sheets?: string[]; sheetOf?(m: ReportMarker): string | null; title(m: ReportMarker): string; text?(s: string): string }): string {
  const inc = [o.errors && "Errors", o.warnings && "Warnings", o.exclusions && "Exclusions"].filter(Boolean).join(", ") || "None";
  let msg = `ERC report (${o.date}, Encoding UTF8)\nReport includes: ${inc}\n`;
  let err = 0, warn = 0, total = 0;
  const coord = (v: number): string => messageText(v, o.units, "sch");
  const sheets = o.sheets && o.sheets.length ? o.sheets : [o.sheet || "/"];
  const bySheet = new Map<string, ReportMarker[]>(sheets.map((p) => [p, []]));
  for (const m of list.filter((x) => shownBy(x, o))) {
    const p = o.sheetOf ? o.sheetOf(m) : null;
    bySheet.get(p && bySheet.has(p) ? p : sheets[0])!.push(m);
  }
  for (const path of sheets) {
    msg += `\n***** Sheet ${path}\n`;
    for (const m of bySheet.get(path)!) {
      const sev = sevOf(m), excluded = m.severity === "exclusion"; total++; if (sev === "error") err++; else if (sev === "warning") warn++;
      msg += `[${m.code}]: ${o.title(m)}\n    ; ${sev}${excluded ? " (excluded)" : ""}\n`;
      const items: ReportItem[] = m.items && m.items.length ? m.items.slice(0, 2) : m.ids.length ? [{ x: m.x, y: m.y, desc: m.text }] : [];
      for (const it of items) {
        const desc = it.len !== undefined ? it.desc.replace("%L", messageText(it.len, o.units, "sch")) : it.desc;
        msg += `    @(${coord(it.x)}, ${coord(it.y)}): ${o.text ? o.text(desc) : desc}\n`;
      }
      if (excluded && m.comment) msg += `    ${m.comment}\n`;
    }
  }
  msg += `\n ** ERC messages: ${total}  Errors ${err}  Warnings ${warn}\n\n ** Ignored checks:\n`;
  msg += o.ignored.length ? o.ignored.map((t) => `    - ${t}\n`).join("") : "    - None\n";
  return msg;
}
