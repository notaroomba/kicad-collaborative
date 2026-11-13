// dialogs/intersheet-refs.ts — SCHEMATIC::RecomputeIntersheetRefs for the browser: the page references the open sheet's
// global labels show when Schematic Setup > Formatting > "Show inter-sheet references" is on.  The page refs map
// (each global label text → the virtual page numbers of the sheets it is on) is built over the whole hierarchy
// (sheetList), with the sheets' page numbers (GetVirtualPageToSheetPagesMap) and the open sheet's own virtual page;
// the canvas resolves ${INTERSHEET_REFS} from it (canvas/geom-sch.ts intersheetRefsText).
import { E, appState, requestRender } from "./editor";
import { obj, projectJson } from "./project";
import { sheetList } from "./sch-hierarchy";
import * as tools from "../editor/tools";

/** SCHEMATIC_SETTINGS' intersheets_ref_* (the defaults: hidden, own page listed, long form, "[" … "]"). */
export function intersheetSettings(pro: ReturnType<typeof projectJson> = projectJson()): { show: boolean; ownPage: boolean; short: boolean; prefix: string; suffix: string } {
  const d = obj(obj(obj(pro).schematic).drawing) as Record<string, unknown>;
  const b = (k: string, dflt: boolean): boolean => (typeof d[k] === "boolean" ? d[k] as boolean : dflt);
  const s = (k: string, dflt: string): string => (typeof d[k] === "string" ? d[k] as string : dflt);
  return { show: b("intersheets_ref_show", false), ownPage: b("intersheets_ref_own_page", true), short: b("intersheets_ref_short", false), prefix: s("intersheets_ref_prefix", "["), suffix: s("intersheets_ref_suffix", "]") };
}

let seq = 0;
/** Recompute the open sheet's intersheet references and redraw its global labels. */
export async function refreshIntersheetRefs(): Promise<void> {
  const doc = E.kdoc; if (!doc || doc.type !== "sch") return;
  const set = intersheetSettings(), my = ++seq;
  if (!set.show) { KiCadCanvas.setIntersheetRefs({ ...set, pages: {}, names: {}, current: 0 }, doc); requestRender(); return; }
  let list: Awaited<ReturnType<typeof sheetList>> = [];
  try { list = await sheetList(); } catch (e) { list = []; }
  if (my !== seq || E.kdoc !== doc) return;
  const pages: Record<string, number[]> = {}, names: Record<number, string> = {};
  const st = appState as unknown as { docId: string | null };
  let current = 0;
  list.forEach((s, i) => {
    const vpn = i + 1; names[vpn] = s.page;
    if (!current && s.docId === st.docId) current = vpn;
    for (const it of s.doc.items.values()) if (it.kind === "global_label") { const t = KiCadCanvas.str(it.node[1] as SNode); (pages[t] = pages[t] || []).push(vpn); }
  });
  KiCadCanvas.setIntersheetRefs({ ...set, pages, names, current }, doc); requestRender();
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** A local edit that adds, removes or renames a global label recomputes the refs (debounced). */
export function installIntersheetRefs(): void {
  tools.commitObservers.push((phase, changes) => {
    if (phase !== "after" || !intersheetSettings().show) return;
    if (!(changes as { typeName?: string; sexpr?: string }[]).some((c) => c.typeName === "SCH_GLOBALLABEL" || /global_label/.test(String(c.sexpr || "")))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refreshIntersheetRefs(); }, 600);
  });
}
