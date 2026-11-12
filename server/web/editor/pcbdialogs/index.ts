// pcbdialogs — the board editor's dialogs that are more than one item's properties: Board Setup,
// Update PCB from Schematic, Edit Footprint Fields, the DRC dialog, Board Statistics, Net Inspector and
// Clearance Resolution.  Each is a module action on CollabTools.pcb, so the menus (web/actions/tables.ts)
// and hotkeys find it the way they find every other board command.
import { openBoardSetup } from "./board-setup";
import { openFootprintFields } from "./fp-fields";
import { clearDrcMarkers, drcReport, openBoardStatistics, openClearance, openDrc, openNetInspector } from "./inspect";
import { newTextDialog, newZoneDialog, pcbItemDialog } from "./item-props";
import { padPropertiesDialog } from "./pad-props";
import { openUpdatePcb, projectNetlist } from "./update-pcb";
import { noteCommit, runZoneFill, zoneFillAll, zoneFillSelected } from "./zonefill";
import { commitObservers, toolCtx } from "../tools";

type Run = (ctx: ToolCtx) => void | boolean;
function action(id: string, label: string, key: string, run: Run): void {
  const pcb = CollabTools.pcb as ToolModule | undefined; if (!pcb) return;
  pcb.actions = { ...(pcb.actions || {}) };          // the module's own table is frozen: ours is a copy with these added
  pcb.actions[id] = { label, key: key || null, run: (ctx) => { run(ctx); } };
}

export function installPcbDialogs(): void {
  if (typeof CollabTools === "undefined" || !CollabTools.pcb) return;
  if (typeof KDialogs !== "undefined" && KDialogs) (KDialogs as KDialogsApi & { pcbItemDialog?: typeof pcbItemDialog }).pcbItemDialog = pcbItemDialog;   // KDialogs.openItem asks it first
  (CollabTools.pcb as ToolModule & { padProperties?: unknown }).padProperties = padPropertiesDialog;   // DIALOG_PAD_PROPERTIES in place of the module's short form
  Object.assign(CollabTools.pcb as object, { drcReport, projectNetlist });   // the DRC dialog's run and the project's netlist as data (plugins' kicad-cli)
  const nd = (CollabTools.pcb as ToolModule & { setNewItemDialogs?(d: Record<string, unknown>): void }).setNewItemDialogs;
  if (nd) nd({ gr_text: newTextDialog, zone: newZoneDialog });   // Add Text and Draw Zone / Rule Area open their properties dialog first
  action("boardSetup", "Board Setup...", "", (ctx) => { void openBoardSetup(ctx); });
  action("updatePcbFromSchematic", "Update PCB from Schematic...", "F8", (ctx) => { void openUpdatePcb(ctx); });
  action("editFootprintFields", "Bulk Edit Footprint Fields...", "", openFootprintFields);
  action("runDRC", "Design Rules Checker", "", openDrc);
  action("clearMarkers", "Clear DRC Markers", "", clearDrcMarkers);
  action("netInspector", "Net Inspector", "", openNetInspector);
  action("showNetInspector", "Net Inspector", "", openNetInspector);
  action("boardStatistics", "Board Statistics", "", openBoardStatistics);
  action("inspectClearance", "Clearance Resolution", "", openClearance);
  // ZONE_FILLER_TOOL: the browser's own filler (web/fab/zonefill.ts)
  action("zoneFillAll", "Fill All Zones", "B", zoneFillAll);
  action("zoneFill", "Draft Fill Selected Zone(s)", "", zoneFillSelected);
  (window as unknown as { PcbZoneFill: unknown }).PcbZoneFill = { fillAll: zoneFillAll, fillSelected: zoneFillSelected, run: runZoneFill };
  commitObservers.push((phase, changes, label) => noteCommit(phase, changes as KChange[], label, () => toolCtx({}) as ToolCtx));
}
installPcbDialogs();
