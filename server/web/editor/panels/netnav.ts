// panels/netnav.ts — the schematic Net Navigator (eeschema/net_navigator.cpp): the highlighted net — or the
// net of the selected item — as a tree of the sheet and the items on it, each described the way KiCad words
// them ("Wire from (x, y) to (x, y)", "Label 'NAME' at (x, y)", …).  With nothing highlighted it lists the
// sheet's named nets; picking one highlights it.  Connectivity is the schematic tool module's (this sheet).
import type { NetNavNode, PanelAction } from "../../panels-api";
import { centerOn } from "../comments";
import { E } from "../state";
import { KC, isSchDoc, kdoc, panelStore, tctx } from "./core";
import { selectedItems } from "./propgrid";

interface PropsHelpers { formatLength(mm: number, unit: string): string }
const fmt = (v: number) => (window.CollabTools.props as unknown as { helpers: PropsHelpers }).helpers.formatLength(v, String(E.units || "mm"));
const pt = (p: [number, number] | number[]) => `(${fmt(p[0])}, ${fmt(p[1])})`;
const CONNECTABLE = new Set(["wire", "bus", "junction", "label", "global_label", "hierarchical_label", "bus_entry", "no_connect", "symbol", "sheet"]);

function describe(it: KItem): string {
  const K = KC(), n = it.node;
  switch (it.kind) {
    case "wire": { const p = K.ptsOf(n); return `Wire from ${pt(p[0])} to ${pt(p[p.length - 1])}`; }
    case "bus": { const p = K.ptsOf(n); return `Bus from ${pt(p[0])} to ${pt(p[p.length - 1])}`; }
    case "polyline": return "Graphic line not connectable";
    case "symbol": return `Symbol '${it.ref || "?"}'`;
    case "sheet": return `Sheet '${it.name || ""}'`;
    case "label": return `Label '${K.str(n[1])}' at ${pt(K.atOf(n))}`;
    case "global_label": return `Global label '${K.str(n[1])}' at ${pt(K.atOf(n))}`;
    case "hierarchical_label": return `Hierarchical label '${K.str(n[1])}' at ${pt(K.atOf(n))}`;
    case "junction": return `Junction at ${pt(K.atOf(n))}`;
    case "no_connect": return `No-Connect at ${pt(K.atOf(n))}`;
    case "bus_entry": { const [x, y] = K.atOf(n), s = K.kid(n, "size"); return `Bus to wire entry from ${pt([x, y])} to ${pt([x + K.num(s ? s[1] : 0), y + K.num(s ? s[2] : 0)])}`; }
    case "netclass_flag": case "directive_label": return `Netclass label '${K.str(n[1])}' at ${pt(K.atOf(n))}`;
    default: return it.kind;
  }
}
const RANK: Record<string, number> = { symbol: 0, sheet: 1, global_label: 2, hierarchical_label: 3, label: 4, junction: 5, wire: 6, bus: 7, bus_entry: 8, no_connect: 9 };
/** A net's name as KiCad derives it, as far as one sheet tells: a global label, then a hierarchical one, then a local one. */
function netName(items: KItem[]): string {
  const K = KC();
  for (const kind of ["global_label", "hierarchical_label", "label"]) { const l = items.find((it) => it.kind === kind); if (l) return (kind === "global_label" ? "" : "/") + K.str(l.node[1]); }
  const sym = items.find((it) => it.kind === "symbol" && it.ref && !it.ref.startsWith("#")) || items.find((it) => it.kind === "symbol");
  return sym ? `Net-(${sym.ref || "?"})` : "<unnamed>";
}
function netOf(item: KItem): Set<string> {
  const doc = kdoc(), m = window.CollabTools.sch; if (!doc || !m) return new Set([item.id]);
  try { return new Set(m.netItems(doc, item) as unknown as Iterable<string>); } catch (e) { return new Set([item.id]); }
}

function build(): NetNavNode | null {
  const doc = kdoc(); if (!doc || !isSchDoc()) return null;
  let ids: Set<string> | null = E.highlightIds && (E.highlightIds as Set<string>).size ? (E.highlightIds as Set<string>) : null;
  if (!ids) { const sel = selectedItems().find((it) => CONNECTABLE.has(it.kind) && it.kind !== "symbol" && it.kind !== "sheet"); if (sel) ids = netOf(sel); }
  if (ids) {
    const items = Array.from(ids).map((id) => doc.items.get(id)).filter((x): x is KItem => !!x).sort((a, b) => (RANK[a.kind] ?? 20) - (RANK[b.kind] ?? 20) || describe(a).localeCompare(b ? describe(b) : "", undefined, { numeric: true }));
    const sheet = String((doc as unknown as { sheetPath?: string }).sheetPath || "/");
    return { key: "net", label: netName(items), bold: true, ids: items.map((x) => x.id), children: [{ key: "sheet", label: sheet, ids: items.map((x) => x.id), children: items.map((it) => ({ key: it.id, label: describe(it), ids: [it.id] })) }] };
  }
  // nothing highlighted: the named nets of this sheet (one node per label text; picking it highlights that net)
  const K = KC(), byName = new Map<string, string[]>();
  for (const it of doc.items.values()) if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") { const name = (it.kind === "global_label" ? "" : "/") + K.str(it.node[1]); const l = byName.get(name); if (l) l.push(it.id); else byName.set(name, [it.id]); }
  const names = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { key: "nets", label: "Nets", bold: true, children: names.map((name) => ({ key: "name:" + name, label: name, ids: byName.get(name) })) };
}

export function publishNetNav(): void {
  let root: NetNavNode | null = null;
  try { root = build(); } catch (e) { console.warn(e); }
  panelStore.set({ netNav: { root, version: panelStore.get().netNav.version + 1 } });
}
export function netNavSignature(): string { const h = E.highlightIds as Set<string> | null; return h && h.size ? "h" + h.size + ":" + h.values().next().value : "-"; }

export function netNavDispatch(a: PanelAction): boolean {
  if (a.t === "netNavRefresh") { publishNetNav(); return true; }
  if (a.t !== "netNavSelect") return false;
  const doc = kdoc(); if (!doc || !a.ids.length) return true;
  const root = panelStore.get().netNav.root;
  if (root && root.key === "nets") {   // a net name: highlight the whole net
    const first = doc.items.get(a.ids[0]); if (!first) return true;
    const ids = netOf(first); for (const id of a.ids) for (const x of netOf(doc.items.get(id) || first)) ids.add(x);
    tctx().setHighlight(ids); publishNetNav();
    return true;
  }
  if (window.CollabTools.sch) window.CollabTools.sch.select(null);
  tctx().setSelection(a.ids);
  const b = KC().bboxOf(doc, a.ids); if (b) centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  return true;
}
