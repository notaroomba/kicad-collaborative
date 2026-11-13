// msgpanel.ts — feeds KiCad's message panel (EDA_MSG_PANEL, the two-row strip above the status bar).
//
// pcbnew refreshes it on every selection change (PCB_BASE_FRAME::UpdateMsgPanel): the one selected item's
// GetMsgPanelInfo, the board summary (BOARD::GetMsgPanelInfo) otherwise, and the router's net / width /
// clearance while a track is being routed (ROUTER_TOOL::UpdateMessagePanel).  The columns are computed by the
// board module (pcb-tools.js msgPanelInfo); this file only decides when to ask again and publishes the result.
import { state, store } from "./appstore";
import { E } from "./state";
import { isSch } from "./view";
import { selectionIds } from "./gestures";
import { nameOfPick, netMap } from "./schnets";

export interface MsgItem { title: string; value: string }
type PcbApi = { msgPanelInfo?: (doc: KDoc, ids: string[], opts: Record<string, unknown>) => MsgItem[]; designSettings?: (src: unknown) => unknown };
type RouteState = { net?: { name?: string }; netKey?: string; width?: number; layer?: string; connected?: number | null } | null;

/**
 * Sub-item panels registered by other modules (tablecells.ts: a single selected table cell's
 * PCB_TABLECELL / SCH_TABLECELL::GetMsgPanelInfo).  The first hook that answers wins; null passes.
 */
export const msgHooks: Array<(units: string) => MsgItem[] | null> = [];

let lastKey = "", settingsSrc: unknown = undefined, settings: unknown = null;

/** Recompute the panel when the document, the selection, the units or the route changed (called every frame: cheap). */
export function updateMsgPanel(): void {
  const doc = E.kdoc as KDoc | null;
  const P = (window as unknown as { PcbTools?: PcbApi }).PcbTools;
  if (doc) for (const h of msgHooks) {
    let hi: MsgItem[] | null = null; try { hi = h(E.units); } catch (e) { console.warn(e); }
    if (!hi) continue;
    const k = "hook§" + JSON.stringify(hi); if (k !== lastKey) { lastKey = k; store.set({ msgPanel: { items: hi } }); }
    return;
  }
  if (doc && isSch()) { updateSchMsgPanel(doc); return; }
  if (!doc || !P || !P.msgPanelInfo) { if (lastKey) { lastKey = ""; store.set({ msgPanel: { items: [] } }); } return; }
  const pcb = CollabTools.pcb && (CollabTools.pcb.state as unknown as { route?: RouteState; sel?: Set<string>; padSel?: string | null; highlightNet?: string | null });
  const rt = pcb ? pcb.route || null : null;
  const pad = pcb && pcb.padSel ? pcb.padSel : null;
  const ids = pad ? [pad] : selectionIds();
  const ver = (store.get() as { document: { version: number } }).document.version;
  const key = [ver, E.units, ids.join(","), rt ? `${rt.netKey}|${rt.width}|${rt.layer}` : "", doc.items.size, pcb && pcb.highlightNet ? pcb.highlightNet : ""].join("§");
  if (key === lastKey) return; lastKey = key;
  const src = E.proSettings;
  if (src !== settingsSrc) { settingsSrc = src; settings = P.designSettings ? P.designSettings(src || null) : null; }
  let items: MsgItem[] = [];
  if (doc.fpEditor && !ids.length && !rt) { store.set({ msgPanel: { items: footprintMsgPanel(doc) } }); return; }
  try { items = P.msgPanelInfo(doc, ids, { settings, units: E.units, route: rt && rt.width ? rt : null, net: pcb && pcb.highlightNet && E.highlightIds ? pcb.highlightNet : null }); } catch (e) { console.warn(e); }
  if (doc.fpEditor && !items.length) items = footprintMsgPanel(doc);
  store.set({ msgPanel: { items } });
}

type SchSel = { id: string; pin?: string; field?: string };
type SchMsgApi = { msgPanelInfo?: (doc: KDoc, sel: SchSel, o: Record<string, unknown>) => MsgItem[] };

/** The one selected schematic item (a pin, a field or an item), or null when nothing or several are selected. */
function schSingleSelection(): SchSel | null {
  const pins = E.selPins as { id: string; number: string }[];
  if (pins.length) return pins.length === 1 ? { id: pins[0].id, pin: pins[0].number } : null;
  const f = E.selField as { id: string; name: string } | null;
  if (f) return { id: f.id, field: f.name };
  const ids = selectionIds();
  return ids.length === 1 ? { id: ids[0] } : null;
}

/** KIUI::EllipsizeStatusText: 30% of the first 800 px of the panel plus 60% of the rest, cut in the middle. */
let measureCtx: CanvasRenderingContext2D | null = null;
function ellipsize(s: string): string {
  const el = typeof document !== "undefined" ? document.getElementById("msgpanel") : null;
  const w = el ? el.clientWidth : (typeof window !== "undefined" ? window.innerWidth : 1200);
  const limit = Math.min(w, 800) * 0.3 + Math.max(w - 800, 0) * 0.6;
  if (!measureCtx && typeof document !== "undefined") { const c = document.createElement("canvas"); measureCtx = c.getContext("2d"); }
  if (!measureCtx) return s;
  measureCtx.font = el ? getComputedStyle(el).font : "12px sans-serif";
  if (measureCtx.measureText(s).width <= limit) return s;
  // wxControl::Ellipsize( wxELLIPSIZE_MIDDLE )
  let lo = 0, hi = s.length;
  while (lo < hi) { const k = Math.ceil((lo + hi) / 2), t = s.slice(0, Math.ceil(k / 2)) + "..." + s.slice(s.length - Math.floor(k / 2)); if (measureCtx.measureText(t).width <= limit) lo = k; else hi = k - 1; }
  return s.slice(0, Math.ceil(lo / 2)) + "..." + s.slice(s.length - Math.floor(lo / 2));
}

/**
 * SCH_INSPECTION_TOOL::UpdateMessagePanel: on every selection change, the one selected item's GetMsgPanelInfo
 * (sch-tools msgpanel.ts), else ClearMsgPanel.  The connection rows come from the hierarchy's net map.
 */
function updateSchMsgPanel(doc: KDoc): void {
  const M = CollabTools.sch as unknown as SchMsgApi | undefined;
  const sel = schSingleSelection();
  const ver = (store.get() as { document: { version: number } }).document.version;
  const sheetPath = ((doc as KDoc & { sheetPath?: string }).sheetPath) || "/";
  const key = ["sch", ver, E.units, sel ? `${sel.id}|${sel.pin ?? ""}|${sel.field ?? ""}` : "", sheetPath, E.proSettings ? E.proSettings.length : 0].join("§");
  if (key === lastKey) return; lastKey = key;
  let items: MsgItem[] = [];
  if (sel && M && M.msgPanelInfo) {
    try {
      items = M.msgPanelInfo(doc, sel, { units: E.units, sheetPath, ellipsize, connection: (it: KItem, pin?: string) => connectionOf(it, pin) });
    } catch (e) { console.warn(e); }
  }
  store.set({ msgPanel: { items } });
}

/** SCH_CONNECTIVITY::AppendConnectionInfo's data: the connection's name, bus or net, and the net's resolved netclass. */
function connectionOf(it: KItem, pin?: string): { name: string; bus: boolean; netclass: string } | null {
  const r = nameOfPick({ item: it, pin }); if (!r || !r.name) return null;
  const c = netMap(); const e = c ? c.map.get(r.name) : null;
  const bus = !!(e && e.bus);
  let netclass = "Default";
  if (!bus) {
    const PS = (KiCadCanvas as unknown as { pcbSizes?: { boardSizes(src: unknown): unknown; effectiveNetclass(s: unknown, net: string): { name?: string } } }).pcbSizes;
    if (PS) { try { if (sizesSrc !== E.proSettings) { sizesSrc = E.proSettings; sizes = PS.boardSizes(E.proSettings || null); } netclass = PS.effectiveNetclass(sizes, r.name).name || "Default"; } catch (e2) { /* no project */ } }
  }
  return { name: r.name, bus, netclass };
}
let sizesSrc: unknown = undefined, sizes: unknown = null;

/**
 * FOOTPRINT::GetMsgPanelInfo in the Footprint Editor (nothing selected: the frame shows the footprint): reference /
 * value, Library, Footprint Name, Pads (GetNumberedPadCount: distinct numbers of pads that can have one), Doc / Keywords.
 */
export function footprintMsgPanel(doc: KDoc): MsgItem[] {
  const FD = KiCadCanvas.footprintDoc as unknown as { footprintFields(d: KDoc): Record<string, string>; footprintHeaderSexpr(d: KDoc): string }; const f = FD.footprintFields(doc);
  const header = KiCadCanvas.parse(FD.footprintHeaderSexpr(doc)) || ["footprint", ""];
  const kidText = (k: string) => { const c = KiCadCanvas.kid(header, k); return c ? String(c[1] ?? "") : ""; };
  const path = state.doc && state.doc.docId && !state.doc.docId.startsWith("board:") ? state.doc.path : "";
  const lib = path ? (path.split("/").slice(-2, -1)[0] || "").replace(/\.pretty$/i, "") : "";
  const nums = new Set<string>();
  for (const it of doc.items.values()) if (it.kind === "pad") { const t = String(it.node[2]); const n = String(it.node[1] ?? ""); const ls = (KiCadCanvas.kid(it.node, "layers") || []).slice(1).map(String); const aperture = t === "smd" && !ls.some((l) => /\.Cu$/.test(l)); if (n && t !== "np_thru_hole" && !aperture) nums.add(n); }
  return [{ title: f.Reference || "", value: f.Value || "" }, { title: "Library", value: lib }, { title: "Footprint Name", value: String(header[1] ?? "") },
    { title: "Pads", value: String(nums.size) }, { title: `Doc: ${kidText("descr")}`, value: `Keywords: ${kidText("tags")}` }];
}
