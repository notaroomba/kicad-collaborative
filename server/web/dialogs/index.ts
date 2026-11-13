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
import { ercCrossProbe, ercExcludeMarker, ercNextMarker, ercPrevMarker, findNextMarker, openErc, selectMarker, type ErcViolation, withExclusions } from "./erc";
import { syntaxHelp } from "../editor/syntax-help";
import { openImportGraphics } from "../importgfx/dialog";
import { applySeverities } from "./erc-rules";
import { openFieldsTable } from "./fields-table";
import { findNext as schFindNext, openFind } from "./find";
import { installGroups } from "./groups";
import * as logic from "./logic";
import { commitPageSettings, openPageSettings } from "./page-settings";
import { openPreferences } from "./preferences";
import { GRID_PAGE, applyPrefs, defaultGrid, editorId, fastGrid, gridLabel, prefs, rememberGrid, toggleGridOverrides } from "./prefs";
import { obj, onProjectChanged, projectJson, readDoc, saveProject, submitDocOp } from "./project";
import { openSchematicSetup, schRenderSettings } from "./schematic-setup";
import { autoplaceAllSheetPins, openSyncSheetPins } from "./sync-pins";
import { openFabOutputs } from "../editor/fab-outputs";
import { editPageNumber } from "../editor/panels/hierarchy";
import { findNetInNavigator } from "../editor/panels/netnav";
import { assignNetclass } from "./assign-netclass";
import { installSubSheets } from "./subsheets";
import { installIntersheetRefs, refreshIntersheetRefs } from "./intersheet-refs";
import { onSheetOpened } from "./erc-hier";
import { selectionIds } from "../editor/gestures";

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
    const wrapped = Object.assign({}, ctx, { setMarkers(list: Marker[]) { const kept = withExclusions(applySeverities(list, sev) as unknown as ErcViolation[]) as unknown as Marker[]; sch.state.markers = kept; (ctx as ToolCtx & { setMarkers(l: Marker[]): void }).setMarkers(kept); },
      toast(msg: string, ms?: number) { const m = (sch.state.markers as Marker[] | undefined) || []; if (/^ERC: /.test(msg)) { const e = m.filter((x) => x.severity === "error").length, w = m.filter((x) => x.severity === "warning").length; ctx.toast(m.length ? `ERC: ${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}` : "ERC: no problems found", ms); } else ctx.toast(msg, ms); } });
    return run(wrapped as ToolCtx, Object.assign({ pinMap: Array.isArray(erc.pin_map) ? erc.pin_map : undefined }, opts || {}));
  };
}

// the board editor's Find (editor/pcbdialogs/find.ts) registers itself on E.hooks: importing it here would pull the
// editor's view modules in ahead of their DOM setup
const openBoardFind = (): void => { const f = (E as unknown as { hooks: { boardFind?: () => void } }).hooks.boardFind; if (f) f(); };
const boardFindNext = (reverse: boolean): void => { const f = (E as unknown as { hooks: { boardFindNext?: (r: boolean) => void } }).hooks.boardFindNext; if (f) f(reverse); };

function typing(ev: KeyboardEvent): boolean { const t = ev.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT" || t.isContentEditable); }

/** Register everything; called once from editor/index.ts before the handled ids are published. */
export function installDialogs(HANDLERS: Record<string, Handler>): void {
  installSubSheets(); installIntersheetRefs();
  const needDoc = (fn: () => void, schOnly = false): Handler => () => { if (!E.kdoc) { toast("Open a document first"); return; } if (schOnly && !isSch()) { toast("This command belongs to the schematic editor"); return; } fn(); };
  const find = HANDLERS.find;
  Object.assign(HANDLERS, {
    pageSettings: needDoc(openPageSettings),
    find: ((a?: Parameters<Handler>[0]) => { if (E.kdoc && isSch()) openFind(false); else if (E.kdoc && !(E.kdoc as KDoc).fpEditor) openBoardFind(); else if (find) find(a); }) as Handler,   // the footprint editor has no Find (FOOTPRINT_EDIT_FRAME)
    // ACTIONS::findNext / findPrevious (F3 / Shift+F3)
    findNext: (() => { if (E.kdoc && isSch()) void schFindNext(false); else if (E.kdoc && !(E.kdoc as KDoc).fpEditor) boardFindNext(false); }) as Handler,
    findPrevious: (() => { if (E.kdoc && isSch()) void schFindNext(true); else if (E.kdoc && !(E.kdoc as KDoc).fpEditor) boardFindNext(true); }) as Handler,
    // ACTIONS::findNextMarker (Ctrl+Shift+F3): SCH_FIND_REPLACE_TOOL::FindNext with markersOnly
    findNextMarker: (() => { if (E.kdoc && isSch()) findNextMarker(); }) as Handler,
    // SCH_INSPECTION_TOOL::ShowBusSyntaxHelp: SCH_TEXT::ShowSyntaxHelp's HTML box
    showBusSyntaxHelp: (() => syntaxHelp(false)) as Handler,
    findAndReplace: needDoc(() => openFind(true), true),
    editSymbolFields: needDoc(() => openFieldsTable(false), true),
    // the board editor's File > Fabrication Outputs > Bill of Materials is the fabrication package; the schematic's is the fields table
    generateBOM: (() => { if (E.kdoc && !isSch()) openFabOutputs("bom"); else needDoc(() => openFieldsTable(true), true)(); }) as Handler,
    assignFootprints: needDoc(openAssignFootprints, true),
    schematicSetup: needDoc(() => openSchematicSetup(), true),
    syncAllSheetsPins: needDoc(openSyncSheetPins, true),
    autoplaceAllSheetPins: needDoc(() => { void autoplaceAllSheetPins(); }, true),
    runERC: needDoc(openErc, true),
    // File > Import > Graphics... (EE_GRAPHIC_TOOL::ImportGraphics, DRAWING_TOOL::PlaceImportedGraphics)
    importGraphics: needDoc(() => openImportGraphics("sch"), true),
    placeImportedGraphics: needDoc(() => { if (!isSch() && !(E.kdoc as KDoc).fpEditor) openImportGraphics("pcb"); }),
    prevMarker: ercPrevMarker as Handler, nextMarker: ercNextMarker as Handler,   // the schematic's; the board's are the module's (EDITOR_ONLY)
    excludeMarker: (() => { if (E.kdoc && isSch()) ercExcludeMarker(); }) as Handler,
    editPageNumber: needDoc(() => { editPageNumber(); }, true),   // SCH_EDIT_TOOL::EditPageNumber
    assignNetclass: needDoc(assignNetclass, true),   // SCH_EDITOR_CONTROL::AssignNetclass
    // SCH_EDITOR_CONTROL::FindNetInInspector
    findNetInInspector: (() => { if (!E.kdoc || !isSch()) return; if (!findNetInNavigator(selectionIds())) toast("No connected net selected."); }) as Handler,
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
  // the canvas side of a selected ERC marker (SCH_INSPECTION_TOOL::CrossProbe): gestures.ts / index.ts ask here
  Object.assign((E as unknown as { hooks: Record<string, unknown> }).hooks, {
    ercSelectMarker: (m: ErcViolation | null) => { selectMarker(m); if (m) ercCrossProbe(m, false); },
    ercOpenMarker: (m: ErcViolation) => { selectMarker(m); ercCrossProbe(m, true); },
  });
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
    else if (mod && !ev.shiftKey && !ev.altKey && k === "f" && !(E.kdoc as KDoc).fpEditor) run = () => openBoardFind();
    else if (ev.key === "F3" && !mod && !ev.altKey && !isSch() && !(E.kdoc as KDoc).fpEditor) run = () => boardFindNext(ev.shiftKey);
    // ACTIONS::findNext (F3), findPrevious (Shift+F3), findNextMarker (Ctrl+Shift+F3): SCH_FIND_REPLACE_TOOL::FindNext
    else if (ev.key === "F3" && !mod && !ev.altKey && isSch()) run = () => { void schFindNext(ev.shiftKey); };
    else if (ev.key === "F3" && mod && ev.shiftKey && !ev.altKey && isSch()) run = () => { findNextMarker(); };
    else if (mod && !ev.altKey && !ev.shiftKey && ev.key === ",") run = () => openPreferences();
    else if (mod && ev.shiftKey && !ev.altKey && k === "g") run = () => HANDLERS.toggleGridOverrides();
    else if (ev.altKey && !mod && !ev.shiftKey && (ev.key === "1" || ev.key === "2")) run = () => { const mm = fastGrid(ev.key === "1" ? 1 : 2); if (mm) toast("Grid: " + gridLabel(mm)); };
    if (!run) return;
    if (KD().isOpen() && !(mod && k === "f") && ev.key !== "F3") return;
    if (typing(ev) && !mod) return;
    ev.preventDefault(); ev.stopPropagation(); run();
  }, true);

  // a newly opened document takes the preferences (grids, colours, display) and the project's schematic settings
  let lastDoc: unknown = null, lastPro: unknown = null, first = true;
  store.subscribe(() => {
    if (E.kdoc && E.kdoc !== lastDoc) { lastDoc = E.kdoc; lastPro = E.proSettings; applyPrefs(first); first = false; applyProjectSettings(); void refreshOtherRefs(); void refreshIntersheetRefs(); onSheetOpened(); }
    else if (E.kdoc && E.proSettings !== lastPro) { lastPro = E.proSettings; applyProjectSettings(); void refreshIntersheetRefs(); }   // the .kicad_pro arrives after the first sheet
  });
  onProjectChanged(applyProjectSettings);
  E.gridDefault = () => defaultGrid();
  E.gridPicked = (mm: number) => rememberGrid(mm);
  applyPrefs(true);
  setToggle("toggleGridOverrides", prefs().grids[editorId()].overrides.enabled);
  // for tests and other modules
  E.dialogs = { logic, openPageSettings, commitPageSettings, openFind, openFieldsTable, openAssignFootprints, openSchematicSetup, openSyncSheetPins, openPreferences, prefs, readDoc, submitDocOp, saveProject, applyProjectSettings, toolCtx };
}
