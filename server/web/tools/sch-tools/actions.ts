import type { SchCtx } from "./types";
import { annotate, clearAnnotation, cycleBodyStyle, editFieldPrompt, placeNextUnit, showDatasheet, stepUnit, toggleSymbolFlag } from "./annotate";
import { autoplaceSelection } from "./autoplace";
import { copyAsText, copySelection, cutSelection, duplicateSelection, pasteSelection, pasteSpecial } from "./clipboard";
import { convertSelection } from "./convert";
import { installDom } from "./dom";
import { cleanupSheetPins, runERC, syncSheetPins } from "./erc";
import { openFieldsTable } from "./fields-table";
import { clearHighlight, highlightNetNow } from "./highlight";
import { selectConnection, selectNode, stepNetItem, unselectAll } from "./netwalk";
import { incrementSelection, repeatLast } from "./repeat";
import { orientSelected } from "./selection-edits";
import { S } from "./state";
import { ARC_MODE_ACTIONS } from "../arc-geom";
import { schArcDrawMode, schArcPosture, setSchArcDrawMode, showSchArcMode, switchSchArcMode } from "./arcs";
/** SCH_ACTIONS::drawArcCenter … FriendlyName. */
const ARC_MODE_LABELS = ["Draw Arc: Center, Start, End", "Draw Arc: Start, End, Midpoint", "Draw Arc: Start, End, Center", "Draw Arc: Tangent", "Draw Arc: Start, Direction, End"];
import { alignEdges, alignToGrid, breakWire, moveExactly, swapSelection } from "./transforms";
import { unfoldAction } from "./unfold";

// ---------------------------------------------------------------- the actions map (ids stable: app.js binds menus and keys to them)
/** One of the module's commands: app.js binds menus and keys to it; run returns whether it was handled. */
export interface SchAction { id: string; label: string; key: string; run(ctx: SchCtx, opts?: unknown): unknown }
// Each command's opts are the options of the function it calls (named below per command); run is declared as a
// method so those narrower option types are accepted.
export function act(id: string, label: string, key: string, run: SchAction["run"]): SchAction { return { id, label, key, run }; }
export const ACTION_LIST = [
  act("cut", "Cut", "Ctrl+X", (ctx: SchCtx) => cutSelection(ctx)),
  act("copy", "Copy", "Ctrl+C", (ctx: SchCtx) => copySelection(ctx)),
  act("copyAsText", "Copy as Text", "Ctrl+Shift+C", (ctx: SchCtx) => copyAsText(ctx)),
  act("paste", "Paste", "Ctrl+V", (ctx: SchCtx, opts?: Parameters<typeof pasteSelection>[1]) => pasteSelection(ctx, opts)),
  act("pasteSpecial", "Paste Special...", "Ctrl+Shift+V", (ctx: SchCtx, opts?: Parameters<typeof pasteSpecial>[1]) => pasteSpecial(ctx, opts)),
  act("duplicate", "Duplicate", "Ctrl+D", (ctx: SchCtx) => duplicateSelection(ctx)),
  act("unselectAll", "Unselect All", "Ctrl+Shift+A", (ctx: SchCtx) => unselectAll(ctx)),
  act("selectConnection", "Select/Expand Connection", "Ctrl+4", (ctx: SchCtx) => selectConnection(ctx)),
  act("selectNode", "Select Node", "Alt+3", (ctx: SchCtx) => selectNode(ctx)),
  act("nextNetItem", "Next Net Item", "Tab", (ctx: SchCtx) => stepNetItem(ctx, 1)),
  act("previousNetItem", "Previous Net Item", "Shift+Tab", (ctx: SchCtx) => stepNetItem(ctx, -1)),
  act("repeatLast", "Repeat Last Item", "Insert", (ctx: SchCtx) => repeatLast(ctx)),
  act("increment", "Increment", "", (ctx: SchCtx) => incrementSelection(ctx, 1)),
  act("decrement", "Decrement", "", (ctx: SchCtx) => incrementSelection(ctx, -1)),
  act("toLabel", "Change to Label", "", (ctx: SchCtx) => convertSelection(ctx, "label")),
  act("toGLabel", "Change to Global Label", "", (ctx: SchCtx) => convertSelection(ctx, "global_label")),
  act("toHLabel", "Change to Hierarchical Label", "", (ctx: SchCtx) => convertSelection(ctx, "hierarchical_label")),
  act("toDLabel", "Change to Directive Label", "", (ctx: SchCtx) => convertSelection(ctx, "netclass_flag")),
  act("toText", "Change to Text", "", (ctx: SchCtx) => convertSelection(ctx, "text")),
  act("toTextBox", "Change to Text Box", "", (ctx: SchCtx) => convertSelection(ctx, "text_box")),
  act("autoplace", "Autoplace Fields", "O", (ctx: SchCtx, opts?: Parameters<typeof autoplaceSelection>[1]) => autoplaceSelection(ctx, opts)),
  act("editReference", "Edit Reference Designator...", "U", (ctx: SchCtx) => editFieldPrompt(ctx, "Reference", "Reference", false)),
  act("editValue", "Edit Value...", "V", (ctx: SchCtx) => editFieldPrompt(ctx, "Value", "Value", false)),
  act("editFootprint", "Edit Footprint...", "F", (ctx: SchCtx) => editFieldPrompt(ctx, "Footprint", "Footprint", false)),
  act("setDNP", "Do not Populate", "", (ctx: SchCtx) => toggleSymbolFlag(ctx, "setDNP")),
  act("setExcludeFromBOM", "Exclude from Bill of Materials", "", (ctx: SchCtx) => toggleSymbolFlag(ctx, "setExcludeFromBOM")),
  act("setExcludeFromSim", "Exclude from Simulation", "", (ctx: SchCtx) => toggleSymbolFlag(ctx, "setExcludeFromSim")),
  act("setExcludeFromBoard", "Exclude from Board", "", (ctx: SchCtx) => toggleSymbolFlag(ctx, "setExcludeFromBoard")),
  act("setExcludeFromPosFiles", "Exclude from Position Files", "", (ctx: SchCtx) => toggleSymbolFlag(ctx, "setExcludeFromPosFiles")),
  act("nextUnit", "Next Symbol Unit", "", (ctx: SchCtx) => stepUnit(ctx, 1)),
  act("previousUnit", "Previous Symbol Unit", "", (ctx: SchCtx) => stepUnit(ctx, -1)),
  act("placeNextSymbolUnit", "Place Next Symbol Unit", "", (ctx: SchCtx) => placeNextUnit(ctx)),
  act("cycleBodyStyle", "Cycle Body Style", "", (ctx: SchCtx) => cycleBodyStyle(ctx)),
  act("showDatasheet", "Show Datasheet", "D", (ctx: SchCtx) => showDatasheet(ctx)),
  act("annotate", "Annotate Schematic...", "", (ctx: SchCtx, opts?: Parameters<typeof annotate>[1]) => annotate(ctx, opts)),
  act("clearAnnotation", "Clear Annotation", "", (ctx: SchCtx, opts?: Parameters<typeof clearAnnotation>[1]) => clearAnnotation(ctx, opts)),
  act("toggleAnnotateAuto", "Annotate Automatically", "", (ctx: SchCtx) => { S.annotateAuto = !S.annotateAuto; if (ctx && ctx.toast) ctx.toast("Automatic annotation " + (S.annotateAuto ? "on" : "off")); return true; }),
  act("runERC", "Electrical Rules Checker", "", (ctx: SchCtx, opts?: Parameters<typeof runERC>[1]) => runERC(ctx, opts)),
  act("clearMarkers", "Clear ERC Markers", "", (ctx: SchCtx) => { S.markers = []; if (typeof ctx.setMarkers === "function") ctx.setMarkers([]); ctx.requestRender(); return true; }),
  act("swap", "Swap", "Alt+S", (ctx: SchCtx) => swapSelection(ctx)),
  act("alignToGrid", "Align Items to Grid", "", (ctx: SchCtx) => alignToGrid(ctx)),
  act("alignTop", "Align to Top", "", (ctx: SchCtx) => alignEdges(ctx, "top")),
  act("alignBottom", "Align to Bottom", "", (ctx: SchCtx) => alignEdges(ctx, "bottom")),
  act("alignLeft", "Align to Left", "", (ctx: SchCtx) => alignEdges(ctx, "left")),
  act("alignRight", "Align to Right", "", (ctx: SchCtx) => alignEdges(ctx, "right")),
  act("alignCenterX", "Align to Horizontal Center", "", (ctx: SchCtx) => alignEdges(ctx, "centerX")),
  act("alignCenterY", "Align to Vertical Center", "", (ctx: SchCtx) => alignEdges(ctx, "centerY")),
  act("moveExactly", "Move Exactly...", "", (ctx: SchCtx, opts?: Parameters<typeof moveExactly>[1]) => moveExactly(ctx, opts)),
  act("rotateSelection", "Rotate Counterclockwise", "R", (ctx: SchCtx) => orientSelected(ctx, "ccw")),
  act("rotateSelectionCW", "Rotate Clockwise", "Shift+R", (ctx: SchCtx) => orientSelected(ctx, "cw")),
  act("mirrorSelectionX", "Mirror Horizontally", "X", (ctx: SchCtx) => orientSelected(ctx, "y")),
  act("mirrorSelectionY", "Mirror Vertically", "Y", (ctx: SchCtx) => orientSelected(ctx, "x")),
  act("breakWire", "Break", "", (ctx: SchCtx) => breakWire(ctx, "break")),
  act("slice", "Slice", "", (ctx: SchCtx) => breakWire(ctx, "slice")),
  act("fieldsTable", "Symbol Fields Table...", "", (ctx: SchCtx) => openFieldsTable(ctx)),
  act("unfoldBus", "Unfold from Bus", "C", (ctx: SchCtx, opts?: Parameters<typeof unfoldAction>[1]) => unfoldAction(ctx, opts)),
  act("syncSheetPins", "Sync Sheet Pins...", "", (ctx: SchCtx) => syncSheetPins(ctx)),
  act("cleanupSheetPins", "Cleanup Sheet Pins", "", (ctx: SchCtx) => cleanupSheetPins(ctx)),
  act("highlightNet", "Highlight Net", "`", (ctx: SchCtx) => highlightNetNow(ctx)),
  act("clearHighlight", "Clear Net Highlighting", "~", (ctx: SchCtx) => { clearHighlight(ctx); return true; }),
  // EE_GRAPHIC_TOOL::DrawArc's modes (SCH_ACTIONS::drawArcCenter …): each starts Draw Arcs in its mode, or switches the
  // arc being drawn to it (ARC_MODE_SESSION::HandleModeEvent); the Arc toolbar group then shows that mode's button
  ...ARC_MODE_ACTIONS.map((id, m) => act(id, ARC_MODE_LABELS[m], "", (ctx: SchCtx) => {
    if (S.tool === "arc") switchSchArcMode(ctx, m); else { setSchArcDrawMode(m); ctx.setTool("arc"); showSchArcMode(ctx); }
    return true;
  })),
  act("arcPosture", "Switch Arc Posture", "/", (ctx: SchCtx) => S.tool === "arc" && schArcPosture(ctx)),
  act("cycleArcDrawMode", "Cycle Arc Drawing Mode", "Alt+/", (ctx: SchCtx) => { if (S.tool !== "arc") return false; switchSchArcMode(ctx, (schArcDrawMode() + 1) % 5); return true; }),
];
export const actions: Record<string, SchAction> = {}; for (const a of ACTION_LIST) actions[a.id] = a;
export function runAction(id: string, ctx: SchCtx, opts?: unknown) { const a = actions[id]; if (!a) return false; S.ctx = ctx; installDom(ctx); try { return !!a.run(ctx, opts); } catch (e) { console.warn(e); if (ctx && ctx.toast) ctx.toast(a.label + " failed: " + (e && (e as Error).message)); return false; } }
