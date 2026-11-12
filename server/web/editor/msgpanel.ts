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
  if (doc.fpEditor && !ids.length && !rt) { store.set({ msgPanel: { items: footprintMsgPanel(doc) } }); return; }
  try { items = P.msgPanelInfo(doc, ids, { settings, units: E.units, route: rt && rt.width ? rt : null, net: pcb && pcb.highlightNet && E.highlightIds ? pcb.highlightNet : null }); } catch (e) { console.warn(e); }
  if (doc.fpEditor && !items.length) items = footprintMsgPanel(doc);
  store.set({ msgPanel: { items } });
}

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
