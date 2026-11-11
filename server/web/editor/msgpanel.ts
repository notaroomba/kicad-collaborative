// msgpanel.ts — feeds KiCad's message panel (EDA_MSG_PANEL, the two-row strip above the status bar).
//
// pcbnew refreshes it on every selection change (PCB_BASE_FRAME::UpdateMsgPanel): the one selected item's
// GetMsgPanelInfo, the board summary (BOARD::GetMsgPanelInfo) otherwise, and the router's net / width /
// clearance while a track is being routed (ROUTER_TOOL::UpdateMessagePanel).  The columns are computed by the
// board module (pcb-tools.js msgPanelInfo); this file only decides when to ask again and publishes the result.
import { store } from "./appstore";
import { E } from "./state";
import { isSch } from "./view";
import { selectionIds } from "./gestures";

export interface MsgItem { title: string; value: string }
type PcbApi = { msgPanelInfo?: (doc: KDoc, ids: string[], opts: Record<string, unknown>) => MsgItem[]; designSettings?: (src: unknown) => unknown };
type RouteState = { net?: { name?: string }; netKey?: string; width?: number; layer?: string; connected?: number | null } | null;

let lastKey = "", settingsSrc: unknown = undefined, settings: unknown = null;

/** Recompute the panel when the document, the selection, the units or the route changed (called every frame: cheap). */
export function updateMsgPanel(): void {
  const doc = E.kdoc as KDoc | null;
  const P = (window as unknown as { PcbTools?: PcbApi }).PcbTools;
  if (!doc || isSch() || !P || !P.msgPanelInfo) { if (lastKey) { lastKey = ""; store.set({ msgPanel: { items: [] } }); } return; }
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
  try { items = P.msgPanelInfo(doc, ids, { settings, units: E.units, route: rt && rt.width ? rt : null, net: pcb && pcb.highlightNet && E.highlightIds ? pcb.highlightNet : null }); } catch (e) { console.warn(e); }
  store.set({ msgPanel: { items } });
}
