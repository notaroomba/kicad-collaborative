// dialogs/index.ts — wires the schematic-editor dialogs into the app: the handlers behind the KiCad action ids
// (pageSettings, findAndReplace, editSymbolFields, generateBOM, assignFootprints, schematicSetup, syncAllSheetsPins,
// toggleGridOverrides, openPreferences), the group commands on the schematic module, their hotkeys, the project
// settings the renderer and the ERC honour, and the preferences applied when a document opens.
import { E, isSch, requestRender, setToggle, store, toast, toolCtx } from "./editor";
import { openAssignFootprints } from "./assign-footprints";
import { openChangeSymbols } from "./change-symbols";
import { openGlobalEdit } from "./global-edit";
import { installSchItemDialogs } from "./sch-items";
import { installSimModel } from "./sim-model";
import { KD } from "./dom";
import { openAnnotate, refreshOtherRefs } from "./annotate";
import { openErc } from "./erc";
import { applySeverities } from "./erc-rules";
import { openFieldsTable } from "./fields-table";
import { openFind } from "./find";
import { installGroups } from "./groups";
import * as logic from "./logic";
import { openPageSettings } from "./page-settings";
import { openPreferences } from "./preferences";
import { GRID_PAGE, applyPrefs, defaultGrid, editorId, fastGrid, gridLabel, prefs, rememberGrid, toggleGridOverrides } from "./prefs";
import { obj, onProjectChanged, projectJson, readDoc, saveProject, submitDocOp } from "./project";
import { openSchematicSetup, schRenderSettings } from "./schematic-setup";
import { openSyncSheetPins } from "./sync-pins";
import { openFabOutputs } from "../editor/fab-outputs";

type Handler = import("../editor/types").ActionHandler;
interface Marker { code: string; severity: string }

/** Push the project's schematic settings into the open document and the renderer. */
function applyProjectSettings(): void {
  const doc = E.kdoc as (KDoc & { schSettings?: { junctionDiameter: number } }) | null; if (!doc || doc.type !== "sch") return;
  const s = schRenderSettings(projectJson());
  const ratios = KiCadCanvas.DASH_RATIOS as { dash: number; gap: number }; ratios.dash = s.dash; ratios.gap = s.gap;
  const before = doc.schSettings ? doc.schSettings.junctionDiameter : 0.9144; doc.schSettings = { junctionDiameter: s.junctionDiameter };
  if (Math.abs(before - s.junctionDiameter) > 1e-6) for (const it of doc.items.values()) if (it.kind === "junction") KiCadCanvas.replaceChange(doc, it);   // rebuilds the dot at its new size
  KiCadCanvas.setSchFormatting({ textOffsetRatio: s.textOffsetRatio, labelSizeRatio: s.labelSizeRatio, pinSymbolSize: s.pinSymbolSize, showDnpMarkers: s.showDnpMarkers, lineWidth: s.lineWidth, overbarHeight: s.overbarHeight, hopOverChoice: s.hopOverChoice }, doc);   // Formatting page
  requestRender();
}
/** The ERC takes the project's rule severities and pin conflicts map (Schematic Setup > Electrical Rules). */
function wrapErc(): void {
  const sch = CollabTools.sch;
  const a = sch && sch.actions ? (sch.actions.runERC as unknown as { run(ctx: ToolCtx, opts?: Record<string, unknown>): unknown } | undefined) : undefined; if (!sch || !a) return;
  const run = a.run;
  a.run = (ctx, opts) => {
    const erc = obj(projectJson().erc), sev = obj(erc.rule_severities) as Record<string, unknown>;
    const wrapped = Object.assign({}, ctx, { setMarkers(list: Marker[]) { const kept = applySeverities(list, sev); sch.state.markers = kept; (ctx as ToolCtx & { setMarkers(l: Marker[]): void }).setMarkers(kept); },
      toast(msg: string, ms?: number) { const m = (sch.state.markers as Marker[] | undefined) || []; if (/^ERC: /.test(msg)) { const e = m.filter((x) => x.severity === "error").length, w = m.length - e; ctx.toast(m.length ? `ERC: ${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}` : "ERC: no problems found", ms); } else ctx.toast(msg, ms); } });
    return run(wrapped as ToolCtx, Object.assign({ pinMap: Array.isArray(erc.pin_map) ? erc.pin_map : undefined }, opts || {}));
  };
}

function typing(ev: KeyboardEvent): boolean { const t = ev.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT" || t.isContentEditable); }

/** Register everything; called once from editor/index.ts before the handled ids are published. */
export function installDialogs(HANDLERS: Record<string, Handler>): void {
  const needDoc = (fn: () => void, schOnly = false): Handler => () => { if (!E.kdoc) { toast("Open a document first"); return; } if (schOnly && !isSch()) { toast("This command belongs to the schematic editor"); return; } fn(); };
  const find = HANDLERS.find;
  Object.assign(HANDLERS, {
    pageSettings: needDoc(openPageSettings),
    find: ((a?: Parameters<Handler>[0]) => { if (E.kdoc && isSch()) openFind(false); else if (find) find(a); }) as Handler,
    findAndReplace: needDoc(() => openFind(true), true),
    editSymbolFields: needDoc(() => openFieldsTable(false), true),
    // the board editor's File > Fabrication Outputs > Bill of Materials is the fabrication package; the schematic's is the fields table
    generateBOM: (() => { if (E.kdoc && !isSch()) openFabOutputs("bom"); else needDoc(() => openFieldsTable(true), true)(); }) as Handler,
    assignFootprints: needDoc(openAssignFootprints, true),
    schematicSetup: needDoc(() => openSchematicSetup(), true),
    syncAllSheetsPins: needDoc(openSyncSheetPins, true),
    runERC: needDoc(openErc, true),
    annotate: needDoc(openAnnotate, true),
    // DIALOG_CHANGE_SYMBOLS: Edit > Change Symbols…, Tools > Update Symbols from Library…, the symbol context menu
    changeSymbols: needDoc(() => openChangeSymbols("change"), true), changeSymbol: needDoc(() => openChangeSymbols("change"), true),
    updateSymbols: needDoc(() => openChangeSymbols("update"), true), updateSymbol: needDoc(() => openChangeSymbols("update"), true),
    toggleGridOverrides: (() => { const on = toggleGridOverrides(); toast(on ? "Grid overrides on" : "Grid overrides off"); }) as Handler,
    openPreferences: (() => openPreferences()) as Handler,
    // ACTIONS::gridProperties ("Edit Grids..."): COMMON_TOOLS::GridProperties opens Preferences on the editor's Grids page
    gridProperties: (() => openPreferences(GRID_PAGE[editorId()])) as Handler,
  });
  installGroups(); wrapErc(); installSchItemDialogs(); installSimModel();
  // the old one-sheet fields table action now opens the full dialog
  const sch = CollabTools.sch as (SchToolModule & { actions: Record<string, { run(ctx: ToolCtx): unknown }> }) | undefined;
  if (sch && sch.actions && sch.actions.fieldsTable) sch.actions.fieldsTable.run = () => { openFieldsTable(false); return true; };
  // SCH_EDIT_TOOL::GlobalEdit (Edit > Edit Text & Graphics Properties…)
  if (sch && sch.actions) (sch.actions as Record<string, unknown>).editTextAndGraphics = { id: "editTextAndGraphics", label: "Edit Text & Graphics Properties...", run: () => { openGlobalEdit(); return true; } };

  // KiCad's hotkeys for these commands; a dialog that is open keeps the keyboard
  window.addEventListener("keydown", (ev) => {
    if (store.get().view !== "editor" || !E.kdoc) return;
    if (document.getElementById("symedit")) return;   // the Symbol Editor frame is up: its own keys
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase(); let run: (() => void) | null = null;
    if (mod && !ev.shiftKey && k === "f" && isSch()) run = () => openFind(ev.altKey);
    else if (mod && !ev.altKey && !ev.shiftKey && ev.key === ",") run = () => openPreferences();
    else if (mod && ev.shiftKey && !ev.altKey && k === "g") run = () => HANDLERS.toggleGridOverrides();
    else if (ev.altKey && !mod && !ev.shiftKey && (ev.key === "1" || ev.key === "2")) run = () => { const mm = fastGrid(ev.key === "1" ? 1 : 2); if (mm) toast("Grid: " + gridLabel(mm)); };
    if (!run) return;
    if (KD().isOpen() && !(mod && k === "f")) return;
    if (typing(ev) && !mod) return;
    ev.preventDefault(); ev.stopPropagation(); run();
  }, true);

  // a newly opened document takes the preferences (grids, colours, display) and the project's schematic settings
  let lastDoc: unknown = null, lastPro: unknown = null, first = true;
  store.subscribe(() => {
    if (E.kdoc && E.kdoc !== lastDoc) { lastDoc = E.kdoc; lastPro = E.proSettings; applyPrefs(first); first = false; applyProjectSettings(); void refreshOtherRefs(); }
    else if (E.kdoc && E.proSettings !== lastPro) { lastPro = E.proSettings; applyProjectSettings(); }   // the .kicad_pro arrives after the first sheet
  });
  onProjectChanged(applyProjectSettings);
  E.gridDefault = () => defaultGrid();
  E.gridPicked = (mm: number) => rememberGrid(mm);
  applyPrefs(true);
  setToggle("toggleGridOverrides", prefs().grids[editorId()].overrides.enabled);
  // for tests and other modules
  E.dialogs = { logic, openPageSettings, openFind, openFieldsTable, openAssignFootprints, openSchematicSetup, openSyncSheetPins, openPreferences, prefs, readDoc, submitDocOp, saveProject, applyProjectSettings, toolCtx };
}
