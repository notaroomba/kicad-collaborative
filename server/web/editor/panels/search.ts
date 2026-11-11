// panels/search.ts — KiCad's Search pane (common/widgets/search_pane.cpp with the handlers in
// pcbnew/widgets/search_handlers.cpp and eeschema/widgets/search_handlers.cpp): one tab per handler with
// the handler's columns, a filter box matching any cell, and rows that select and zoom to their item.
// The schematic tabs cover every sheet of the project (the sheets that are not open come from the
// hierarchy's cache); a row on another sheet opens that sheet first.
import type { PanelAction, SearchResult, SearchRow, SearchTab } from "../../panels-api";
import { centerOn } from "../comments";
import { openDoc } from "../doc";
import { E } from "../state";
import { fitBox } from "../view";
import { layerDisplayName, netClassOf } from "./appearance";
import { KC, currentDocId, isSchDoc, kdoc, pcbTools, tctx } from "./core";
import { pageOfDoc, schDocs, sheetDoc } from "./hierarchy";

interface PropsHelpers { formatLength(mm: number, unit: string): string; netNameOf(doc: KDoc, n: SNode): string; yes(n: SNode, k: string, d: boolean): boolean }
const H = (): PropsHelpers => (window.CollabTools.props as unknown as { helpers: PropsHelpers }).helpers;
const len = (v: number) => H().formatLength(v, String(E.units || "mm"));

const PCB_TABS: SearchTab[] = [
  { id: "footprints", label: "Footprints", columns: ["Reference", "Value", "Layer", "X", "Y", "Library Link", "Library Description"] },
  { id: "zones", label: "Zones", columns: ["Name", "Net", "Layer", "Priority", "X", "Y", "Area"] },
  { id: "nets", label: "Nets", columns: ["Name", "Class"] },
  { id: "ratsnest", label: "Ratsnest", columns: ["Name", "Class"] },
  { id: "text", label: "Text", columns: ["Type", "Text", "Layer", "X", "Y"] },
];
const SCH_TABS: SearchTab[] = [
  { id: "symbols", label: "Symbols", columns: ["Reference", "Value", "Footprint", "Page", "X", "Y", "Excl. Sim", "Excl. BOM", "Excl. Board", "Excl. Pos Files", "DNP", "Library Link", "Library Description"] },
  { id: "power", label: "Power", columns: ["Reference", "Value", "Page", "X", "Y"] },
  { id: "text", label: "Text", columns: ["Type", "Text", "Page", "X", "Y"] },
  { id: "labels", label: "Labels", columns: ["Type", "Name", "Page", "X", "Y"] },
];
export function searchTabs(): SearchTab[] { return isSchDoc() ? SCH_TABS : PCB_TABS; }

/** EDA_SEARCH_MATCH_MODE::PERMISSIVE, near enough: a case-insensitive substring, or a * / ? wildcard over the whole cell. */
function matcher(query: string): (cells: string[]) => boolean {
  const q = query.trim().toLowerCase(); if (!q) return () => true;
  if (/[*?]/.test(q)) { const re = new RegExp("^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); return (cells) => cells.some((c) => re.test(c)); }
  return (cells) => cells.some((c) => c.toLowerCase().includes(q));
}
const field = (n: SNode, name: string): string => { const K = KC(); const p = K.kids(n, "property").find((q) => K.str(q[1]) === name); return p ? K.str(p[2]) : ""; };
function polyArea(pts: [number, number][]): number { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a) / 2; }

function pcbRows(tab: string, doc: KDoc): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  if (tab === "footprints") {
    for (const it of doc.items.values()) { if (it.kind !== "footprint") continue; const [x, y] = K.atOf(it.node);
      rows.push({ key: it.id, ids: [it.id], cells: [it.ref || field(it.node, "Reference"), it.value || field(it.node, "Value"), layerDisplayName(doc, it.layer || "F.Cu"), len(x), len(y), K.str(it.node[1]), K.str((K.kid(it.node, "descr") || [])[1])] }); }
    rows.sort((a, b) => a.cells[0].localeCompare(b.cells[0], undefined, { numeric: true }));
  } else if (tab === "zones") {
    for (const it of doc.items.values()) { if (it.kind !== "zone") continue; const n = it.node;
      const poly = K.kid(n, "polygon"), pts = poly ? K.ptsOf(poly) : []; const s = K.kid(n, "layer"), m = K.kid(n, "layers");
      const layers = s ? layerDisplayName(doc, K.str(s[1])) : m ? m.slice(1).map((l) => layerDisplayName(doc, K.str(l))).join(", ") : "";
      rows.push({ key: it.id, ids: [it.id], cells: [K.str((K.kid(n, "name") || [])[1]), H().netNameOf(doc, n), layers, String(K.num((K.kid(n, "priority") || [])[1], 0)), pts[0] ? len(pts[0][0]) : "", pts[0] ? len(pts[0][1]) : "", (polyArea(pts)).toFixed(4).replace(/\.?0+$/, "") + " mm²"] }); }
  } else if (tab === "nets" || tab === "ratsnest") {
    const P = pcbTools(); if (!P) return rows;
    let names = P.boardNets(doc).map((n) => n.name);
    if (tab === "ratsnest") { const rat = (window.CollabTools.pcb as unknown as { ratsnest?(d: KDoc): { net: string }[] }).ratsnest; const open = new Set((rat ? rat(doc) : []).map((l) => l.net)); names = names.filter((n) => open.has(n)); }
    for (const name of names) rows.push({ key: "net:" + name, ids: [], cells: [name, netClassOf(name)] });
  } else if (tab === "text") {
    for (const it of doc.items.values()) {
      if (it.kind !== "gr_text" && it.kind !== "gr_text_box" && it.kind !== "dimension") continue; const n = it.node;
      const t = it.kind === "dimension" ? K.kid(n, "gr_text") : n; const at = it.kind === "dimension" ? (t ? K.atOf(t) : [0, 0, 0]) : K.atOf(n);
      const b = it.bbox; const x = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[0] : b ? (b[0] + b[2]) / 2 : 0, y = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[1] : b ? (b[1] + b[3]) / 2 : 0;
      rows.push({ key: it.id, ids: [it.id], cells: [it.kind === "gr_text" ? "Text" : it.kind === "gr_text_box" ? "Textbox" : "Dimension", t ? K.str(t[1]) : "", layerDisplayName(doc, K.str((K.kid(n, "layer") || [])[1])), len(x), len(y)] });
    }
  }
  return rows;
}

const yn = (b: boolean) => (b ? "X" : "");
const LABEL_TYPES: Record<string, string> = { label: "Local", global_label: "Global", hierarchical_label: "Hierarchical", netclass_flag: "Directive", directive_label: "Directive" };
function schRows(tab: string): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  for (const d of schDocs()) {
    const doc = sheetDoc(d.docId); if (!doc) continue; const page = pageOfDoc(d.docId); const here = d.docId === currentDocId();
    for (const it of doc.items.values()) {
      const n = it.node, at = () => K.atOf(n); const row = (cells: string[]) => rows.push({ key: d.docId + ":" + it.id, ids: [it.id], cells, docId: here ? undefined : d.docId });
      if (it.kind === "symbol") {
        const lib = K.str((K.kid(n, "lib_id") || [])[1]); const ref = field(n, "Reference"); const power = ref.startsWith("#") || /^power:/.test(lib);
        if (tab === "symbols" && !power) row([ref, field(n, "Value"), field(n, "Footprint"), page, len(at()[0]), len(at()[1]), yn(H().yes(n, "exclude_from_sim", false)), yn(!H().yes(n, "in_bom", true)), yn(!H().yes(n, "on_board", true)), yn(!H().yes(n, "in_pos_files", true)), yn(H().yes(n, "dnp", false)), lib, field(n, "Description")]);
        if (tab === "power" && power) row([ref, field(n, "Value"), page, len(at()[0]), len(at()[1])]);
      } else if (tab === "text" && (it.kind === "text" || it.kind === "text_box")) row([it.kind === "text" ? "Text" : "Text Box", K.str(n[1]), page, len(at()[0]), len(at()[1])]);
      else if (tab === "labels" && LABEL_TYPES[it.kind]) row([LABEL_TYPES[it.kind], K.str(n[1]), page, len(at()[0]), len(at()[1])]);
    }
  }
  const col = tab === "text" || tab === "labels" ? 1 : 0;
  rows.sort((a, b) => a.cells[col].localeCompare(b.cells[col], undefined, { numeric: true }));
  return rows;
}

const MAX_ROWS = 500;
export function search(tab: string, query: string): SearchResult {
  const doc = kdoc(); if (!doc) return { tab, rows: [], total: 0 };
  let rows: SearchRow[] = [];
  try { rows = isSchDoc() ? schRows(tab) : pcbRows(tab, doc); } catch (e) { console.warn(e); }
  const m = matcher(query); rows = rows.filter((r) => m(r.cells));
  return { tab, rows: rows.slice(0, MAX_ROWS), total: rows.length };
}

/** Select the row's items and bring them into view: zoom to their box (KiCad's "Zoom to Selection"), else just centre. */
function selectAndShow(ids: string[], zoom: boolean): void {
  const doc = kdoc(); if (!doc || !ids.length) return;
  const ctx = tctx() as unknown as { setSelection(ids: string[]): void };
  const P = pcbTools(); if (P) P.state.sel.clear();
  if (window.CollabTools.sch && isSchDoc()) window.CollabTools.sch.select(null);
  ctx.setSelection(ids);
  const b = KC().bboxOf(doc, ids); if (!b) return;
  const w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
  E.viewTouched = true;
  if (zoom) fitBox([b[0], b[1], w, h], isSchDoc() ? 0.25 : 0.35); else centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
}

export function searchDispatch(a: PanelAction): boolean {
  if (a.t !== "searchSelect") return false;
  const row = a.row;
  if (row.key.startsWith("net:")) {   // a net row highlights the net, as selecting it in KiCad's Nets tab does
    const doc = kdoc(), P = pcbTools(); if (!doc || !P) return true;
    const ids = P.netItemIds(doc, row.key.slice(4)); tctx().setHighlight(ids.size ? ids : null); P.state.highlightNet = row.key.slice(4);
    return true;
  }
  if (row.docId) {
    const d = schDocs().find((x) => x.docId === row.docId); if (!d) return true;
    void (openDoc(d) as Promise<void>).then(() => { setTimeout(() => selectAndShow(row.ids, a.zoom), 50); });
    return true;
  }
  selectAndShow(row.ids, a.zoom);
  return true;
}
