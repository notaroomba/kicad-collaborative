// pcbdialogs — the board editor's dialogs that are more than one item's properties: Board Setup,
// Update PCB from Schematic, Edit Footprint Fields, the DRC dialog, Board Statistics, Net Inspector and
// Clearance Resolution.  Each is a module action on CollabTools.pcb, so the menus (web/actions/tables.ts)
// and hotkeys find it the way they find every other board command.
import { installTransformDialogs } from "./transform-dialogs";
import { openBoardSetup } from "./board-setup";
import "./find";   // Edit > Find (DIALOG_FIND): registers E.hooks.boardFind / boardFindNext
import { openFootprintFields } from "./fp-fields";
import { clearDrcMarkers, drcReport, excludeMarker, nextMarker, openBoardStatistics, openClearance, openDrc, prevMarker } from "./inspect";
import { showPane } from "../panes";
import { newTextDialog, newZoneDialog, openZoneManager, pcbItemDialog } from "./item-props";
import { tracksOnly, trackViaDialog } from "./track-via";
import { newTextBoxDialog } from "./textbox";
import { newTableDialog } from "./table";
import { createArrayDialog } from "./array";
import { padPropertiesDialog } from "./pad-props";
import { openExchangeFootprints } from "./exchange";
import { openGlobalDeletions } from "./global-delete";
import { openTextAndGraphics } from "./text-graphics";
import { openUnusedPads } from "./unused-pads";
import { openCleanupGraphics } from "./cleanup-graphics";
import { openEditTeardrops } from "./teardrops";
import { openUpdatePcb, projectNetlist, updatePcbFromSchematicEditor } from "./update-pcb";
import { noteCommit, runZoneFill, zoneFillAll, zoneFillSelected } from "./zonefill";
import { commitObservers, toolCtx } from "../tools";

type Run = (ctx: ToolCtx) => void | boolean;
function action(id: string, label: string, key: string, run: Run): void {
  const pcb = CollabTools.pcb as ToolModule | undefined; if (!pcb) return;
  pcb.actions = { ...(pcb.actions || {}) };          // the module's own table is frozen: ours is a copy with these added
  pcb.actions[id] = { label, key: key || null, run: (ctx) => { run(ctx); } };
}

/** Wire the dialogs into the board tools.  Runs once they are loaded (pcbtools-loader.ts announces it): at start-up they are not. */
let installed = false;
export function installPcbDialogs(): void {
  if (installed || typeof CollabTools === "undefined" || !CollabTools.pcb) return;
  installed = true;
  if (typeof KDialogs !== "undefined" && KDialogs) (KDialogs as KDialogsApi & { pcbItemDialog?: typeof pcbItemDialog }).pcbItemDialog = pcbItemDialog;   // KDialogs.openItem asks it first
  if (typeof KDialogs !== "undefined" && KDialogs) KDialogs.pcbSelectionDialog = (ctx, items) => tracksOnly(items) && trackViaDialog(ctx, items);
  (CollabTools.pcb as ToolModule & { padProperties?: unknown }).padProperties = padPropertiesDialog;
  installTransformDialogs();   // Move Item, Position Relative, Swap Layers, Cleanup Tracks and Vias   // DIALOG_PAD_PROPERTIES in place of the module's short form
  Object.assign(CollabTools.pcb as object, { drcReport, projectNetlist });   // the DRC dialog's run and the project's netlist as data (plugins' kicad-cli)
  const nd = (CollabTools.pcb as ToolModule & { setNewItemDialogs?(d: Record<string, unknown>): void }).setNewItemDialogs;
  if (nd) nd({ gr_text: newTextDialog, gr_text_box: newTextBoxDialog, table: newTableDialog, zone: newZoneDialog });   // Add Text, Draw Text Box and Draw Zone / Rule Area open their properties dialog first
  action("createArray", "Create Array...", "", (ctx) => { createArrayDialog(ctx); });   // PCB_ACTIONS::createArray (ARRAY_TOOL)
  action("boardSetup", "Board Setup...", "", (ctx) => { void openBoardSetup(ctx); });
  action("zonesManager", "Zone Manager...", "", (ctx) => { openZoneManager(ctx); });   // GLOBAL_EDIT_TOOL::ZonesManager (Tools > Zone Manager...)
  action("zoneManager", "Zone Manager...", "", (ctx) => { openZoneManager(ctx); });
  action("cleanupGraphics", "Cleanup Graphics...", "", openCleanupGraphics);   // GLOBAL_EDIT_TOOL::CleanupGraphics
  action("editTeardrops", "Edit Teardrops...", "", openEditTeardrops);   // GLOBAL_EDIT_TOOL::EditTeardrops
  action("removeUnusedPads", "Remove Unused Pads...", "", openUnusedPads);   // GLOBAL_EDIT_TOOL::RemoveUnusedPads
  action("updatePcbFromSchematic", "Update PCB from Schematic...", "F8", (ctx) => { void openUpdatePcb(ctx); });
  // GLOBAL_EDIT_TOOL::ExchangeFootprints (DIALOG_EXCHANGE_FOOTPRINTS)
  action("updateFootprint", "Update Footprint...", "", (ctx) => { openExchangeFootprints(ctx, "updateFootprint"); });
  action("updateFootprints", "Update Footprints from Library...", "", (ctx) => { openExchangeFootprints(ctx, "updateFootprints"); });
  action("changeFootprint", "Change Footprint...", "", (ctx) => { openExchangeFootprints(ctx, "changeFootprint"); });
  action("changeFootprints", "Change Footprints...", "", (ctx) => { openExchangeFootprints(ctx, "changeFootprints"); });
  action("editTextAndGraphics", "Edit Text & Graphics Properties...", "", openTextAndGraphics);   // GLOBAL_EDIT_TOOL::EditTextAndGraphics
  action("globalDeletions", "Global Deletions...", "", openGlobalDeletions);   // GLOBAL_EDIT_TOOL::GlobalDeletions
  action("editFootprintFields", "Bulk Edit Footprint Fields...", "", openFootprintFields);
  action("runDRC", "Design Rules Checker", "", openDrc);
  action("clearMarkers", "Clear DRC Markers", "", clearDrcMarkers);
  action("prevMarker", "Previous Marker", "", prevMarker);
  action("nextMarker", "Next Marker", "", nextMarker);
  action("excludeMarker", "Exclude Marker", "", () => excludeMarker());
  // View > Panels > Net Inspector: the docked panel (PCB_EDIT_FRAME's m_netInspectorPanel), a check item
  action("netInspector", "Net Inspector", "", () => showPane("netinsp"));
  action("showNetInspector", "Net Inspector", "", () => showPane("netinsp"));
  action("boardStatistics", "Board Statistics", "", openBoardStatistics);
  action("inspectClearance", "Clearance Resolution", "", openClearance);
  // ZONE_FILLER_TOOL: the browser's own filler (web/fab/zonefill.ts)
  action("zoneFillAll", "Fill All Zones", "B", zoneFillAll);
  action("zoneFill", "Draft Fill Selected Zone(s)", "", zoneFillSelected);
  (window as unknown as { PcbZoneFill: unknown }).PcbZoneFill = { fillAll: zoneFillAll, fillSelected: zoneFillSelected, run: runZoneFill };
  commitObservers.push((phase, changes, label) => noteCommit(phase, changes as KChange[], label, () => toolCtx({}) as ToolCtx));
}
/** The schematic editor's Tools > Update PCB from Schematic… (F8) opens the board and runs the same dialog there. */
function installSchActions(): void {
  if (typeof CollabTools === "undefined") return;
  const sch = CollabTools.sch as (ToolModule & { actions?: Record<string, unknown> }) | undefined;
  if (sch && sch.actions) (sch.actions as Record<string, unknown>).updatePcbFromSchematic = { id: "updatePcbFromSchematic", label: "Update PCB from Schematic...", key: "F8", run: (ctx: ToolCtx) => { void updatePcbFromSchematicEditor(ctx); return true; } };
}
installPcbDialogs();
window.addEventListener("kc-pcb-tools", installPcbDialogs);
installSchActions();
