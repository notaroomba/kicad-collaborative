// panels/netinsp.ts — the board's Net Inspector pane (pcbnew/widgets/pcb_net_inspector_panel.cpp with its
// data model pcb_net_inspector_panel_data_model.h): a docked panel (View > Panels > Net Inspector, bottom dock)
// with a "Filter" box, the configure button's menu (filters, grouping, custom groups, zero-pad and unconnected
// nets, time domain, report, Show / Hide Columns), sortable columns (groups first, ties by net name), a header
// menu and a row menu (highlight, clear, rename, delete, add net, remove custom group).  The per-net figures
// come from PcbTools.netLengths (LENGTH_DELAY_CALCULATION).  The settings are kept per project as KiCad keeps
// PANEL_NET_INSPECTOR_SETTINGS in the project's local settings.
import { messageText } from "../../units";
import { unescapeString } from "../../dialogs/sch-items-logic";
import { confirmBox } from "../../dialogs/dom";
import { E } from "../state";
import { download, errorMessage } from "../pcbdialogs/ui";
import { setNet } from "../pcbdialogs/item-props";
import { layerDisplayName, netClassOf, netCommand } from "./appearance";
import { KC, kdoc, loadJson, panelStore, pcbTools, projectId, saveJson, tctx, textEntry } from "./core";

export interface NetInspColumn { id: number; label: string; csv: string; units: boolean; quote: boolean; hidden: boolean; center: boolean }
export interface NetInspRow { key: string; group: boolean; level: number; expanded?: boolean; cells: string[]; zero: boolean[]; nets: string[] }
export interface NetInspSettings {
  filter_by_net_name: boolean; filter_by_netclass: boolean; group_by_netclass: boolean; group_by_net_chain: boolean;
  custom_group_rules: string[]; show_zero_pad_nets: boolean; show_unconnected_nets: boolean; show_time_domain_details: boolean;
  sorting_column: number; sort_order_asc: boolean; col_hidden: Record<string, boolean>; expanded_rows: string[];
}
export interface NetInspModel { columns: NetInspColumn[]; rows: NetInspRow[]; settings: NetInspSettings; highlighted: boolean }

const DEFAULTS: NetInspSettings = { filter_by_net_name: true, filter_by_netclass: true, group_by_netclass: false, group_by_net_chain: false, custom_group_rules: [],
  show_zero_pad_nets: false, show_unconnected_nets: false, show_time_domain_details: false, sorting_column: -1, sort_order_asc: true, col_hidden: {}, expanded_rows: [] };
const key = (): string => "kui.netinsp." + (projectId() || "x");
let cfg: NetInspSettings | null = null;
let filterText = "";
/** Nets added with Add Net... that nothing uses yet (a NETINFO_ITEM with no items: shown with Show Zero Pad Nets). */
const addedNets = new Set<string>();
export function settings(): NetInspSettings { if (!cfg) cfg = Object.assign({}, DEFAULTS, loadJson<Partial<NetInspSettings>>(key(), {})); return cfg; }
function save(): void { saveJson(key(), settings()); bump(); }
function bump(): void { panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); }

// ---------------------------------------------------------------- columns (buildColumns)
const C = { NAME: 0, CHAIN: 1, NETCLASS: 2, TOTAL: 3, CHAIN_LEN: 4, VIA_COUNT: 5, VIA_LEN: 6, TRACK_LEN: 7, DIE_LEN: 8, UNROUTED: 9, PAD_COUNT: 10 };
export const LAST_STATIC_COL = 10;
function columns(doc: KDoc | null, td: boolean): NetInspColumn[] {
  const s = settings(), P = PT();
  const base: [string, string, boolean, boolean][] = [["Name", "Net Name", false, true], ["Net Chain", "Net Chain", false, true], ["Netclass", "Netclass", false, true],
    td ? ["Total Delay", "Net Delay", true, false] : ["Total Length", "Net Length", true, false], td ? ["Net Chain Delay", "Net Chain Delay", true, false] : ["Net Chain Length", "Net Chain Length", true, false],
    ["Via Count", "Via Count", false, false], td ? ["Via Delay", "Via Delay", true, false] : ["Via Length", "Via Length", true, false],
    td ? ["Track Delay", "Track Delay", true, false] : ["Track Length", "Track Length", true, false], td ? ["Die Delay", "Die Delay", true, false] : ["Die Length", "Die Length", true, false],
    ["Unrouted Length", "Unrouted Length", true, false], ["Pad Count", "Pad Count", false, false]];
  const cols: NetInspColumn[] = base.map(([label, csv, units, quote], id) => ({ id, label, csv, units, quote, hidden: id > 0 && !!s.col_hidden[id], center: id > C.NETCLASS }));
  // one column per copper layer, named as the board names it
  const stack: string[] = doc && P ? P.copperStack(doc.copper || []) : ["F.Cu", "B.Cu"];
  stack.forEach((l, i) => { const id = LAST_STATIC_COL + 1 + i, nm = doc ? layerDisplayName(doc, l) : l; cols.push({ id, label: nm, csv: nm, units: true, quote: false, hidden: !!s.col_hidden[id], center: true }); });
  return cols;
}
interface LengthRow { name: string; code: number; padCount: number; viaCount: number; trackLength: number; viaLength: number; dieLength: number; unroutedLength: number; totalLength: number; layerLengths: Record<string, number> }
interface PT { netLengths(doc: KDoc, header: null, opts: { includeZeroPadNets?: boolean }): LengthRow[]; copperStack(copper: string[]): string[] }
const PT = (): PT | null => (window as unknown as { PcbTools?: PT }).PcbTools || null;

// ---------------------------------------------------------------- matching (netFilterMatches, EDA_COMBINED_MATCHER CTX_NET)
/** EDA_COMBINED_MATCHER( pattern, CTX_NET ): an explicit regex (/…/ or ^…$), else a wildcard, else a substring; case-insensitive. */
export function combinedMatch(pattern: string, text: string): boolean {
  const T = text.toUpperCase();
  let rx: string | null = null;
  if (pattern.startsWith("^") && pattern.endsWith("$")) rx = pattern;
  else if (pattern.startsWith("/")) rx = pattern.slice(1).replace(/\/$/, "");
  if (rx !== null) { try { if (new RegExp(rx, "i").test(text)) return true; } catch (e) { /* not a regex: the next matchers try */ } }
  if (/[*?]/.test(pattern)) {
    const re = new RegExp(pattern.toUpperCase().replace(/[.+^${}()|[\]/\\]/g, "\\$&").replace(/\?/g, ".").replace(/\*/g, ".*"));
    if (re.test(T)) return true;
  }
  return T.includes(pattern.toUpperCase());
}
function filterMatches(name: string, netclass: string, s: NetInspSettings): boolean {
  const f = unescapeString(filterText).toUpperCase(), n = unescapeString(name).toUpperCase(), c = unescapeString(netclass).toUpperCase();
  let matched = !f.length;
  if (!matched && s.filter_by_netclass && c.includes(f)) matched = true;
  if (!matched && s.filter_by_net_name && n.includes(f)) matched = true;
  if (matched && !s.show_unconnected_nets) matched = !n.startsWith("UNCONNECTED-(");
  return matched;
}

// ---------------------------------------------------------------- the model (buildNetsList / DATA_MODEL)
interface Item { key: string; name: string; netclass: string; group: "" | "netclass" | "chain" | "custom"; children: Item[]; padCount: number; viaCount: number;
  viaLength: number; trackLength: number; dieLength: number; unrouted: number; layers: Record<string, number>; nets: string[]; code: number }
const total = (i: Item) => i.trackLength + i.viaLength + i.dieLength;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export function setFilter(text: string): void { filterText = text; bump(); }
export function filterValue(): string { return filterText; }

export function netInspectorModel(expandAll = false): NetInspModel {
  const doc = kdoc(), P = PT(), s = settings(), td = s.show_time_domain_details;
  const cols = columns(doc, td);
  const model: NetInspModel = { columns: cols, rows: [], settings: s, highlighted: !!E.highlightIds };
  if (!doc || doc.type !== "pcb" || !P) return model;
  const stack = P.copperStack(doc.copper || []);
  const rows = P.netLengths(doc, null, { includeZeroPadNets: s.show_zero_pad_nets }).filter((r) => !!r.name);   // netFilterMatches: never the unconnected net (code 0, no name)
  if (s.show_zero_pad_nets) for (const n of addedNets) if (!rows.some((r) => r.name === n)) rows.push({ name: n, code: 1e9, padCount: 0, viaCount: 0, trackLength: 0, viaLength: 0, dieLength: 0, unroutedLength: 0, totalLength: 0, layerLengths: {} });
  const items: Item[] = [];
  for (const r of rows) {
    const netclass = netClassOf(r.name);
    if (!filterMatches(r.name, netclass, s)) continue;
    items.push({ key: r.name, name: unescapeString(r.name), netclass: unescapeString(netclass), group: "", children: [], padCount: r.padCount, viaCount: r.viaCount, viaLength: r.viaLength,
      trackLength: r.trackLength, dieLength: r.dieLength, unrouted: r.unroutedLength, layers: r.layerLengths, nets: [r.name], code: r.code });
  }
  // addCustomGroups, then addItem: custom rule, else net chain, else netclass
  const groups: Item[] = [];
  const mk = (type: Item["group"], name: string): Item => ({ key: `${type}:${name}`, name, netclass: "", group: type, children: [], padCount: 0, viaCount: 0, viaLength: 0, trackLength: 0, dieLength: 0, unrouted: 0, layers: {}, nets: [], code: -1 });
  const custom = s.custom_group_rules.map((rule) => { const g = mk("custom", rule); groups.push(g); return g; });
  const byName = new Map<string, Item>();
  const top: Item[] = [];
  for (const it of items) {
    let parent: Item | null = null;
    const ci = s.custom_group_rules.findIndex((rule) => combinedMatch(rule, it.name));
    if (ci >= 0) parent = custom[ci];
    else if (s.group_by_net_chain) { const k = "chain:"; parent = byName.get(k) || null; if (!parent) { parent = mk("chain", ""); byName.set(k, parent); groups.push(parent); } }
    else if (s.group_by_netclass) { const k = "netclass:" + it.netclass; parent = byName.get(k) || null; if (!parent) { parent = mk("netclass", it.netclass); byName.set(k, parent); groups.push(parent); } }
    if (parent) {
      parent.children.push(it); parent.nets.push(...it.nets);
      parent.padCount += it.padCount; parent.viaCount += it.viaCount; parent.viaLength += it.viaLength; parent.trackLength += it.trackLength; parent.dieLength += it.dieLength; parent.unrouted += it.unrouted;
      for (const [l, v] of Object.entries(it.layers)) parent.layers[l] = (parent.layers[l] || 0) + v;
    } else top.push(it);
  }
  // DATA_MODEL::Compare: groups before nets; the column's value, then the net name
  const col = s.sorting_column >= 0 ? s.sorting_column : C.NAME, asc = s.sort_order_asc;
  const num = (i: Item): number | null => {
    switch (col) {
      case C.PAD_COUNT: return i.padCount; case C.VIA_COUNT: return i.viaCount; case C.VIA_LEN: return i.viaLength; case C.TRACK_LEN: return i.trackLength;
      case C.DIE_LEN: return i.dieLength; case C.UNROUTED: return i.unrouted; case C.TOTAL: return total(i); case C.CHAIN_LEN: return 0;
      default: return col > LAST_STATIC_COL ? i.layers[stack[col - LAST_STATIC_COL - 1]] || 0 : null;
    }
  };
  const cmp = (a: Item, b: Item): number => {
    if (!!a.group !== !!b.group) return a.group ? -1 : 1;
    const nameA = a.group ? groupLabel(a) : a.name, nameB = b.group ? groupLabel(b) : b.name;
    if (col === C.NETCLASS && a.netclass !== b.netclass) return asc ? natural(a.netclass, b.netclass) : natural(b.netclass, a.netclass);
    const va = num(a), vb = num(b);
    if (va !== null && vb !== null && Math.abs(va - vb) > 1e-9) return asc ? va - vb : vb - va;
    return asc ? natural(nameA, nameB) : natural(nameB, nameA);
  };
  const L = (mm: number): string => td ? "0.00 ps" : messageText(mm, (E.units as "mm" | "mil" | "in") || "mm", "pcb", true);
  const out: NetInspRow[] = [];
  const emit = (i: Item, level: number): void => {
    const cells: string[] = [], zero: boolean[] = [];
    for (const c of cols) {
      let v = "", z = false;
      switch (c.id) {
        case C.NAME: v = i.group ? groupLabel(i) : i.name; break;
        case C.CHAIN: v = ""; break;
        case C.NETCLASS: v = i.netclass; break;
        case C.PAD_COUNT: v = String(i.padCount); z = !i.padCount; break;
        case C.VIA_COUNT: v = String(i.viaCount); z = !i.viaCount; break;
        case C.VIA_LEN: v = L(i.viaLength); z = !i.viaLength; break;
        case C.TRACK_LEN: v = L(i.trackLength); z = !i.trackLength; break;
        case C.DIE_LEN: v = L(i.dieLength); z = !i.dieLength; break;
        case C.UNROUTED: v = messageText(i.unrouted, (E.units as "mm" | "mil" | "in") || "mm", "pcb", true); z = !i.unrouted; break;
        case C.TOTAL: v = L(total(i)); z = !total(i); break;
        case C.CHAIN_LEN: v = ""; break;
        default: { const lv = i.layers[stack[c.id - LAST_STATIC_COL - 1]] || 0; v = L(lv); z = !lv; }
      }
      cells.push(v); zero.push(z);
    }
    const expanded = i.group ? expandAll || s.expanded_rows.includes(i.key) : undefined;
    out.push({ key: i.key, group: !!i.group, level, expanded, cells, zero, nets: i.nets.slice() });
    if (i.group && expanded) for (const ch of i.children.slice().sort(cmp)) emit(ch, level + 1);
  };
  for (const i of [...groups, ...top].sort(cmp)) emit(i, 0);
  model.rows = out;
  return model;
}
function groupLabel(i: Item): string { return i.group === "netclass" ? `Netclass: ${i.name}` : i.group === "custom" ? `Custom: ${i.name}` : i.name; }

// ---------------------------------------------------------------- commands
export type NetInspCmd =
  | { t: "toggle"; key: "filter_by_net_name" | "filter_by_netclass" | "group_by_netclass" | "group_by_net_chain" | "show_zero_pad_nets" | "show_unconnected_nets" | "show_time_domain_details" }
  | { t: "sort"; col: number } | { t: "column"; col: number } | { t: "expand"; key: string }
  | { t: "addGroup" } | { t: "removeGroup"; key: string } | { t: "removeGroups" }
  | { t: "highlight"; nets: string[] } | { t: "clearHighlight" }
  | { t: "rename"; net: string } | { t: "delete"; nets: string[]; group?: string } | { t: "addNet" } | { t: "report" };

export function netInspectorCmd(c: NetInspCmd): void {
  const s = settings();
  switch (c.t) {
    case "toggle": s[c.key] = !s[c.key]; save(); return;
    case "sort": if (s.sorting_column === c.col || (s.sorting_column < 0 && c.col === C.NAME)) s.sort_order_asc = !s.sort_order_asc; else { s.sorting_column = c.col; s.sort_order_asc = true; } save(); return;
    case "column": s.col_hidden = Object.assign({}, s.col_hidden, { [c.col]: !s.col_hidden[c.col] }); save(); return;
    case "expand": s.expanded_rows = s.expanded_rows.includes(c.key) ? s.expanded_rows.filter((k) => k !== c.key) : [...s.expanded_rows, c.key]; save(); return;
    case "addGroup": void addGroup(); return;
    case "removeGroup": { const rule = c.key.replace(/^custom:/, ""); s.custom_group_rules = s.custom_group_rules.filter((r) => r !== rule); save(); return; }
    case "removeGroups": s.custom_group_rules = []; save(); return;
    case "highlight": highlight(c.nets); return;
    case "clearHighlight": { tctx().setHighlight(null); const P = pcbTools(); if (P) P.state.highlightNet = null; bump(); return; }
    case "rename": void renameNet(c.net); return;
    case "delete": void deleteNets(c.nets, c.group); return;
    case "addNet": void addNet(); return;
    case "report": report(); return;
  }
}
/** highlightSelectedNets: every selected net (a group's children) highlighted on the board. */
function highlight(nets: string[]): void {
  if (!nets.length) { tctx().setHighlight(null); bump(); return; }
  netCommand("highlight", nets, unescapeString(nets[0])); bump();
}
async function addGroup(): Promise<void> {
  const v = await textEntry("New Group", "Group name / pattern:\n(Use /.../ to indicate a regular expression.)", "");
  if (v === null || !v.trim()) return;
  const s = settings(); if (!s.custom_group_rules.includes(v)) s.custom_group_rules = [...s.custom_group_rules, v]; save();
}
function boardNetNames(doc: KDoc): string[] { const P = pcbTools(); return P ? P.boardNets(doc).map((n) => n.name).filter(Boolean) : []; }
/** Nets stored as codes ((net 3) with a (net 3 "GND") table) cannot be renamed here: the table is the file header's. */
function codedNets(doc: KDoc): boolean { for (const it of doc.items.values()) { const n = KC().kid(it.node, "net"); if (n && typeof n[1] === "number") return true; } return false; }
/** Every item on a net: tracks, arcs, vias, zones (by node) and the pads of footprints. */
function retarget(doc: KDoc, from: Set<string>, to: string): unknown[] {
  const K = KC(), H = (window.CollabTools.props as unknown as { helpers: { netNameOf(d: KDoc, n: SNode): string } }).helpers, changes: unknown[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      let node: SNode | null = null;
      K.kids(it.node, "pad").forEach((p, i) => { if (from.has(H.netNameOf(doc, p))) { node = node || K.cloneNode(it.node); setNet(doc, K.kids(node, "pad")[i] as SNode, to); } });
      if (node) changes.push(K.replaceChange(doc, { ...it, node, geom: [], bbox: null }));
    } else if (K.kid(it.node, "net") && from.has(H.netNameOf(doc, it.node))) {
      const node = K.cloneNode(it.node); setNet(doc, node, to); changes.push(K.replaceChange(doc, { ...it, node, geom: [], bbox: null }));
    }
  }
  return changes;
}
/** onRenameSelectedNet: the net's short name in a text entry; "/" path prefixes stay. */
async function renameNet(net: string): Promise<void> {
  const doc = kdoc(); if (!doc) return;
  if (codedNets(doc)) { errorMessage("This board stores its nets by number; rename the net in the schematic and update the board."); return; }
  const full = unescapeString(net), slash = full.lastIndexOf("/"), prefix = slash >= 0 ? full.slice(0, slash + 1) : "", short = full.slice(slash + 1);
  for (;;) {
    const v = await textEntry("Rename Net", "Net name:", short);
    if (v === null || v === short) return;
    if (!v) { errorMessage("Net name cannot be empty."); continue; }
    const fullName = (prefix + v).replace(/\//g, "{slash}");
    if (boardNetNames(doc).includes(fullName)) { errorMessage(`Net name '${v}' is already in use.`); continue; }
    const ch = retarget(doc, new Set([net]), fullName);
    if (ch.length) tctx().commit(ch, "Rename Net");
    if (addedNets.delete(net)) addedNets.add(fullName);
    bump(); return;
  }
}
/** onDeleteSelectedNet: items of a deleted net keep their copper and lose the net. */
async function deleteNets(nets: string[], group?: string): Promise<void> {
  const doc = kdoc(); if (!doc || !nets.length) return;
  if (group && !await confirmBox("Delete Net", `Delete all nets in group '${group}'?`, "OK")) return;
  const used = new Set<string>();
  for (const n of nets) {
    const P = pcbTools(); const inUse = !!P && P.netItemIds(doc, n).size > 0;
    if (inUse && !group && !await confirmBox("Delete Net", `Net '${unescapeString(n)}' is in use.  Delete anyway?`, "OK")) continue;
    used.add(n); addedNets.delete(n);
  }
  if (codedNets(doc) && used.size) { errorMessage("This board stores its nets by number; delete the net in the schematic and update the board."); return; }
  const ch = retarget(doc, used, ""); if (ch.length) tctx().commit(ch, "Delete Net");
  bump();
}
/** onAddNet: a new, unused net (shown once Show Zero Pad Nets is on, as KiCad's empty NETINFO_ITEM). */
async function addNet(): Promise<void> {
  const doc = kdoc(); if (!doc) return;
  let name = "";
  for (;;) {
    const v = await textEntry("New Net", "Net name:", name);
    if (v === null || !v) return;
    name = v;
    const esc = v.replace(/\//g, "{slash}");
    if (boardNetNames(doc).includes(esc) || addedNets.has(esc)) { errorMessage(`Net name '${v}' is already in use.`); continue; }
    addedNets.add(esc); bump(); return;
  }
}
/** generateReport: a ';'-separated file, a header row with the unit after length columns, nets only, values without unit text. */
export function reportText(): string {
  const m = netInspectorModel(true), unit = E.units === "in" ? "in" : E.units === "mil" ? "mils" : "mm";
  const lines = [m.columns.map((c) => `"${c.units ? `${c.csv} (${unit})` : c.csv}";`).join("")];
  for (const r of m.rows) {
    if (r.group) continue;
    lines.push(m.columns.map((c, i) => { const v = c.units ? r.cells[i].replace(/ (mm|mils|in|ps)$/, "") : r.cells[i]; return c.quote ? `"${v}";` : `${v};`; }).join(""));
  }
  return lines.join("\n") + "\n";
}
function report(): void { download("net-inspector-report.csv", reportText()); }
