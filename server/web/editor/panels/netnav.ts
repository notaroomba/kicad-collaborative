// panels/netnav.ts — the schematic Net Navigator (eeschema/net_navigator.cpp, SCH_EDIT_FRAME::RefreshNetNavigator).
//
// With nothing highlighted the root is "Nets" and lists every net of the schematic (unnamed Net-(…) nets too),
// narrowed by the filter box (wildcard by default: a pattern without * or ? matches as a substring).  With a net
// highlighted the root is that net's name and the box is disabled.  Under a net, one node per sheet path that holds
// it ("project/Sub"), and under that the net's pins, sheet pins, labels and no-connects in KiCad's wording ("Symbol
// 'U1' pin '3' (VCC)", "Sheet 'X' pin 'Y'", "Label 'NAME' at (x, y)").  Picking an item changes to its sheet and
// centres on it (onNetNavigatorSelection); a sheet node only changes sheet; a net name does nothing.  A canvas
// highlight selects its item here (SelectNetNavigatorItem).  The nets come from editor/schnets.ts: the whole
// hierarchy, kept as names.
import type { NetNavNode, PanelAction } from "../../panels-api";
import type { schNets } from "../../canvas/sch-nets";
import { HL, currentInstance, docOfInstance, goTo, netMap, onNetsChanged } from "../schnets";
import { store } from "../appstore";
import { E } from "../state";
import { isSchDoc, kdoc, loadJson, panelStore, saveJson } from "./core";

interface PropsHelpers { formatLength(mm: number, unit: string): string }
const SN = (): typeof schNets => (KiCadCanvas as unknown as { schNets: typeof schNets }).schNets;
const fmt = (v: number): string => (window.CollabTools.props as unknown as { helpers: PropsHelpers }).helpers.formatLength(v, String(E.units || "mm"));
const unescape = (s: string): string => (KiCadCanvas as unknown as { pcbNetlist: { unescapeNetName(s: string): string } }).pcbNetlist.unescapeNetName(s);

/** The filter text and mode (eeschema settings: net_nav_search_mode_wildcard). */
const filterState = loadJson<{ text: string; wildcard: boolean }>("kc.netnav.filter", { text: "", wildcard: true });
interface NavTarget { inst: number; at: [number, number] | null; item: boolean }
const targets = new Map<string, NavTarget>();

function netNode(name: string, collapsed: boolean): NetNavNode {
  const c = netMap(); if (!c) return { key: "net:" + name, label: unescape(name) };
  const sheets = SN().navSheets(c.map, name, c.instances, c.rootName, (inst) => docOfInstance(c, inst), fmt);
  const sel = HL.nav ? `item:${name}|${HL.nav.inst}|${HL.nav.id}|${HL.nav.pin || ""}` : null;
  return {
    key: "net:" + name, label: unescape(name), collapsed,
    children: sheets.map((s) => {
      const sk = `sheet:${name}|${s.inst}`; targets.set(sk, { inst: s.inst, at: null, item: false });
      const items = s.items.map((it) => { const k = `item:${name}|${it.inst}|${it.id}|${it.pin || ""}`; targets.set(k, { inst: it.inst, at: it.at, item: true }); return { key: k, label: it.label, ids: [it.id] }; });
      return { key: sk, label: s.label, children: items, collapsed: !(sel && items.some((i) => i.key === sel)) };
    }),
  };
}

function build(): { root: NetNavNode | null; selected: string | null } {
  targets.clear();
  const doc = kdoc(); if (!doc || !isSchDoc()) return { root: null, selected: null };
  const c = netMap(); if (!c) return { root: null, selected: null };
  if (HL.name) {
    const root = netNode(HL.name, false); root.bold = true;
    const sel = HL.nav ? `item:${HL.name}|${HL.nav.inst}|${HL.nav.id}|${HL.nav.pin || ""}` : null;
    return { root, selected: sel && targets.has(sel) ? sel : null };
  }
  const match = SN().netFilter(filterState.text, filterState.wildcard);
  const names = SN().netNames(c.map).filter((n) => match(unescape(n)));
  return { root: { key: "nets", label: "Nets", bold: true, children: names.map((n) => netNode(n, true)) }, selected: null };
}

const shown = (): boolean => !!((store.get() as { panes?: Record<string, boolean> }).panes || {}).netnav;
// wxEVT_SHOW: a navigator that went stale while hidden rebuilds when it is shown again
let wasShown = false;
store.subscribe(() => { const on = shown(); if (on && !wasShown && stale) setTimeout(publishNetNav, 0); wasShown = on; });
let stale = true, userSel: string | null = null, lastNav: unknown = null;
/** RefreshNetNavigator: rebuilt when shown (a hidden navigator is only marked stale, as KiCad does). */
export function publishNetNav(): void {
  if (!shown()) { stale = true; return; }
  stale = false;
  let r: { root: NetNavNode | null; selected: string | null } = { root: null, selected: null };
  try { r = build(); } catch (e) { console.warn(e); }
  if (HL.nav !== lastNav) { lastNav = HL.nav; userSel = null; }   // a canvas highlight selects its own node
  const selected = userSel && targets.has(userSel) ? userSel : r.selected;
  const cur = panelStore.get().netNav;
  panelStore.set({ netNav: { root: r.root, version: cur.version + 1, selected, filter: filterState.text, filterEnabled: !HL.name, wildcard: filterState.wildcard } });
}
onNetsChanged(() => publishNetNav());
export function netNavSignature(): string { return (HL.name || "-") + (HL.busMembers ? "+" : "") + (HL.nav ? HL.nav.id + (HL.nav.pin || "") : ""); }

export function netNavDispatch(a: PanelAction): boolean {
  if (a.t === "netNavRefresh") { publishNetNav(); return true; }
  if (a.t === "netNavFilter") {
    if (a.text !== undefined) filterState.text = a.text;
    if (a.wildcard !== undefined) filterState.wildcard = a.wildcard;
    saveJson("kc.netnav.filter", filterState); publishNetNav(); return true;
  }
  if (a.t !== "netNavSelect") return false;
  const key = a.key || "", t = targets.get(key);
  userSel = key || null;
  const cur = panelStore.get().netNav; panelStore.set({ netNav: Object.assign({}, cur, { selected: key || null }) });
  if (!t) return true;                       // the root, or a net name while every net is listed: nothing happens
  void goTo(t.inst, t.item ? t.at : null).then(() => { const now = currentInstance(); if (now && now.index === t.inst) publishNetNav(); });
  return true;
}
