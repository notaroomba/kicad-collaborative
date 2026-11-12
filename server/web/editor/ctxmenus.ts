// ctxmenus.ts — KiCad's right-click menus, transcribed from the tools' Init() functions.
//
// A CONDITIONAL_MENU (common/tool/conditional_menu.cpp) is an ordered list of entries, each with
// a SELECTION_CONDITION.  addEntry() files an entry behind every entry whose order is <= its own
// (an entry added without an order takes the list's current length), and Evaluate() keeps the
// entries whose condition holds for the selection, dropping a separator that has nothing before
// it.  CondMenu below does exactly that, so the tables read like the C++ and come out in the
// C++'s order: the entries are added tool by tool in the order the frames register their tools
// (eeschema/sch_edit_frame.cpp setupTools, pcbnew/pcb_edit_frame.cpp setupTools).
//
// Actions are named as in the C++ ("SCH_ACTIONS::rotateCCW"); the label, icon and hotkey come from
// the generated spec (server/scripts/gen_kicad_context.py scans this file for the names).
// Entries that only exist for features the web editor has no notion of at all (design blocks,
// net chains, variants, the symbol / footprint editor frames) are left out.
import type { Editor } from "../store";

/** What a condition can ask about: the selection and the state of the active tool. */
export interface MenuCtx {
  editor: Editor;
  /** kind of every selected item (kicad-canvas item kinds; "field" for a selected field) */
  kinds: string[];
  /** the web tool id ("select", "wire", "route", …) */
  tool: string;
  /** an interactive operation is in flight: a wire / track / shape being drawn, an item being carried or dragged */
  busy: boolean;
  /** a wire, bus or graphic line is being drawn (SCH_LINE_WIRE_BUS_TOOL::IsDrawingLineWireOrBus) */
  drawingLine: boolean;
  /** a track is being routed */
  routing: boolean;
  /** a shape with an outline is being drawn and has enough corners to close / a corner to take back */
  canClose: boolean; canUndoPoint: boolean;
  /** PCB_POINT_EDITOR::addCornerCondition / removeCornerCondition for the single selected item at the cursor */
  canAddCorner?: boolean; canRemoveCorner?: boolean;
  highlight: boolean;
  /** the one selected pin has alternate functions (SCH_CONDITIONS::SingleMultiFunctionPin) */
  pinAlts?: boolean;
  belowRoot: boolean;
  hasLocked: boolean; hasUnlocked: boolean;
  /** board is not empty (EDIT_TOOL's noItemsCondition) */
  hasItems: boolean;
  /** check marks of the attribute entries, by action name */
  checks: Record<string, boolean>;
  /** a table cell selection (kinds are all "table_cell"): EDIT_TABLE_TOOL_BASE::addMenus' conditions */
  cells?: { block: boolean; merged: boolean; structure: boolean } | null;
}
export type Cond = (c: MenuCtx) => boolean;

export interface MenuDef {
  title: string;
  /** BITMAPS:: name of the submenu's icon */
  icon?: string;
  entries: Entry[];
  /** filled in by the editor: the zoom presets, the grid list */
  dynamic?: "zoom" | "grid" | "diffpair" | "pinfunction" | "pinhelpers";
}
export type Entry =
  | { order: number; cond: Cond; act: string; check?: boolean }
  | { order: number; cond: Cond; sep: true }
  | { order: number; cond: Cond; menu: MenuDef };

const always: Cond = () => true;

export class CondMenu implements MenuDef {
  title: string; icon?: string; entries: Entry[] = []; dynamic?: "zoom" | "grid" | "diffpair" | "pinfunction" | "pinhelpers";
  constructor(title = "", icon?: string) { this.title = title; this.icon = icon; }
  private add(e: Entry, order: number | undefined): this {
    e.order = order === undefined || order < 0 ? this.entries.length : order;
    let i = 0; while (i < this.entries.length && this.entries[i].order <= e.order) i++;
    this.entries.splice(i, 0, e); return this;
  }
  item(act: string, cond: Cond = always, order?: number): this { return this.add({ order: 0, cond, act }, order); }
  check(act: string, cond: Cond = always, order?: number): this { return this.add({ order: 0, cond, act, check: true }, order); }
  sep(cond: Cond | number = always, order?: number): this { return typeof cond === "number" ? this.add({ order: 0, cond: always, sep: true }, cond) : this.add({ order: 0, cond, sep: true }, order); }
  sub(menu: MenuDef, cond: Cond = always, order?: number): this { return this.add({ order: 0, cond, menu }, order); }
}

// ---------------------------------------------------------------- SELECTION_CONDITIONS
const and = (...cs: Cond[]): Cond => (c) => cs.every((f) => f(c));
const or = (...cs: Cond[]): Cond => (c) => cs.some((f) => f(c));
const not = (f: Cond): Cond => (c) => !f(c);
const empty: Cond = (c) => c.kinds.length === 0;
const notEmpty: Cond = (c) => c.kinds.length > 0;
const count = (n: number): Cond => (c) => c.kinds.length === n;
const moreThan = (n: number): Cond => (c) => c.kinds.length > n;
const hasTypes = (types: Set<string>): Cond => (c) => c.kinds.some((k) => types.has(k));
const onlyTypes = (types: Set<string>): Cond => (c) => c.kinds.length > 0 && c.kinds.every((k) => types.has(k));
/** SCH_CONDITIONS::Idle / the PCB "not moving" conditions: nothing is being edited interactively. */
const idle: Cond = (c) => !c.busy;
const tool = (...ids: string[]): Cond => (c) => ids.includes(c.tool);
const set = (...k: string[]) => new Set(k);

// ---------------------------------------------------------------- Zoom / Grid (EDA_DRAW_FRAME::AddStandardSubMenus)
export const ZOOM_MENU: MenuDef = { title: "Zoom", icon: "zoom_selection", entries: [], dynamic: "zoom" };
export const GRID_MENU: MenuDef = { title: "Grid", icon: "grid_select", entries: [], dynamic: "grid" };
/** ROUTER_TOOL's DIFF_PAIR_MENU: Use Net Class Values, Use Custom Values... and the pre-defined pair dimensions (filled in by the board module). */
export const DIFF_PAIR_MENU: MenuDef = { title: "Select Differential Pair Dimensions", icon: "width_track_via", entries: [], dynamic: "diffpair" };
/** GRID_MENU::update() puts this above the grid list. */
export const GRID_ORIGIN = "ACTIONS::gridOrigin";
function standardSubMenus(m: CondMenu): CondMenu { return m.sep(1000).sub(ZOOM_MENU, always, 1000).sub(GRID_MENU, always, 1000); }

/** GROUP_CONTEXT_MENU (common/tool/group_tool.cpp). */
const GROUP_MENU = new CondMenu("Grouping", "group").item("ACTIONS::group").item("ACTIONS::ungroup").item("ACTIONS::addToGroup").item("ACTIONS::removeFromGroup");

// ================================================================ eeschema
// kicad-canvas kinds per KICAD_T.  A (polyline …) is the file's graphic line / polygon (SCH_LINE on
// LAYER_NOTES when it has two points, SCH_SHAPE otherwise); the caller reports a two-point one as "gline".
const SCH_LABELS = set("label", "global_label", "hierarchical_label", "netclass_flag", "directive_label");
const SCH_SHAPES = set("polyline", "rectangle", "circle", "arc", "bezier");
const SCH_LINES = set("wire", "bus", "gline");
const SCH_WIRE_BUS = set("wire", "bus");
const SCH_SHEET = set("sheet");
const SCH_ROTATABLE = set(...SCH_SHAPES, "rule_area", "text", "text_box", "table", ...SCH_LABELS, "group", "field", "symbol", "sheet", "image", "bus_entry", ...SCH_LINES, "junction", "no_connect");
const SCH_SWAPPABLE = set(...SCH_SHAPES, "rule_area", "text", "text_box", ...SCH_LABELS, "field", "symbol", "sheet", "image", "junction", "no_connect");
const SCH_ATTRIB = set("symbol", "sheet", "rule_area");
const SCH_FIELD_OWNERS = set("symbol", "sheet", ...SCH_LABELS);
const SCH_ALL_TEXT = set("label", "netclass_flag", "directive_label", "global_label", "hierarchical_label", "text", "text_box");
const SCH_EXPANDABLE = set("no_connect", "symbol", "wire", "bus", "bus_entry", "junction", ...SCH_LABELS);
const SCH_CONNECTED = set("wire", "bus", "bus_entry", "junction", ...SCH_LABELS);
const SCH_CAN_COPY_TEXT = set("text", "text_box", "field", ...SCH_LABELS, "table");
const SCH_PROPS_SINGLE = set("symbol", "sheet", "text", "text_box", "table", ...SCH_LABELS, "rule_area", "field", ...SCH_SHAPES, "image", "group");

const drawingLine: Cond = (c) => c.drawingLine;
const haveHighlight: Cond = (c) => c.highlight;
const belowRoot: Cond = (c) => c.belowRoot;
const schSheetSel = and(count(1), onlyTypes(SCH_SHEET));
const schWireOrBusSel = and(count(1), onlyTypes(SCH_WIRE_BUS));
const schLinesSel = onlyTypes(SCH_LINES);
const schSingleSymbol = and(count(1), onlyTypes(set("symbol")));
const schMultipleSymbols = and(moreThan(1), onlyTypes(set("symbol")));
/** SCH_EDIT_TOOL::Init orientCondition. */
const schOrient: Cond = (c) => !c.drawingLine && c.kinds.some((k) => SCH_ROTATABLE.has(k));
/** SCH_EDIT_TOOL::Init propertiesCondition (the drawing-sheet case of an empty selection is not offered). */
const schProperties: Cond = (c) => {
  const first = c.kinds[0]; if (!first) return false;
  if (first === "table_cell") return c.kinds.every((k) => k === "table_cell");   // SCH_EDIT_TOOL::Properties: DIALOG_TABLECELL_PROPERTIES
  if (SCH_PROPS_SINGLE.has(first)) return c.kinds.length === 1;
  if (first === "gline" || first === "wire" || first === "bus" || first === "bus_entry" || first === "junction") {
    if (c.kinds.every((k) => k === "gline")) return true;
    if (c.kinds.every((k) => k === "junction")) return true;
    return c.kinds.every((k) => k === "wire" || k === "bus" || k === "bus_entry" || k === "gline" || k === "junction");
  }
  return false;
};
const convertTo = (except: string): Cond => (c) => c.kinds.length === 1 ? SCH_ALL_TEXT.has(c.kinds[0]) && c.kinds[0] !== except && !(except === "netclass_flag" && c.kinds[0] === "directive_label") : onlyTypes(SCH_ALL_TEXT)(c);
/** SCH_MOVE_TOOL::Init moveCondition. */
const schMove: Cond = (c) => c.kinds.length > 0 && !c.drawingLine;
const idleSelection = and(notEmpty, idle);
// ---------------------------------------------------------------- tables (EDIT_TABLE_TOOL_BASE::addMenus, the selection tools' Init)
const tableCellSelection: Cond = (c) => c.kinds.length > 0 && c.kinds.every((k) => k === "table_cell");
const structureSelection: Cond = (c) => tableCellSelection(c) && !!c.cells && c.cells.structure;
const cellBlockSelection: Cond = (c) => c.kinds.length >= 2 && !!c.cells && c.cells.block;
const mergedCellsSelection: Cond = (c) => !!c.cells && c.cells.merged;
/** The selection tool menu's Select Column(s) / Row(s) / Table (order 2). */
function addTableSelectItems(m: CondMenu, cond: Cond): void {
  m.item("ACTIONS::selectColumns", cond, 2).item("ACTIONS::selectRows", cond, 2).item("ACTIONS::selectTable", cond, 2);
}
/** EDIT_TABLE_TOOL_BASE::addMenus, order 100. */
function addTableMenus(m: CondMenu): void {
  const ss = and(structureSelection, idle);
  m.sep(100);
  m.item("ACTIONS::addRowAbove", ss, 100).item("ACTIONS::addRowBelow", ss, 100).item("ACTIONS::addColBefore", ss, 100).item("ACTIONS::addColAfter", ss, 100);
  m.sep(100);
  m.item("ACTIONS::deleteRows", ss, 100).item("ACTIONS::deleteColumns", ss, 100);
  m.sep(100);
  m.item("ACTIONS::mergeCells", and(structureSelection, cellBlockSelection), 100).item("ACTIONS::unmergeCells", and(structureSelection, mergedCellsSelection), 100);
  m.sep(100);
  m.item("ACTIONS::editTable", and(tableCellSelection, idle), 100);
  m.sep(100);
  m.item("ACTIONS::exportTableCSV", and(tableCellSelection, idle), 100);
  m.sep(100);
}

const schTransformMenu = () => new CondMenu("Transform Selection")
  .item("SCH_ACTIONS::rotateCCW", schOrient).item("SCH_ACTIONS::rotateCW", schOrient).item("SCH_ACTIONS::mirrorV", schOrient).item("SCH_ACTIONS::mirrorH", schOrient);
const schAttributesMenu = () => new CondMenu("Attributes")
  .check("SCH_ACTIONS::setExcludeFromSim").check("SCH_ACTIONS::setExcludeFromBOM").check("SCH_ACTIONS::setExcludeFromBoard")
  .check("SCH_ACTIONS::setExcludeFromPosFiles", hasTypes(set("symbol"))).check("SCH_ACTIONS::setDNP");
const schEditFieldsMenu = () => new CondMenu("Edit Main Fields")
  .item("SCH_ACTIONS::editReference", schSingleSymbol, 200).item("SCH_ACTIONS::editValue", schSingleSymbol, 200).item("SCH_ACTIONS::editFootprint", schSingleSymbol, 200);
const schConvertMenu = () => new CondMenu("Change To", "right")
  .item("SCH_ACTIONS::toLabel", convertTo("label")).item("SCH_ACTIONS::toDLabel", convertTo("netclass_flag")).item("SCH_ACTIONS::toHLabel", convertTo("hierarchical_label"))
  .item("SCH_ACTIONS::toGLabel", convertTo("global_label")).item("SCH_ACTIONS::toText", convertTo("text")).item("SCH_ACTIONS::toTextBox", convertTo("text_box"));
const schLockMenu = () => new CondMenu("Locking", "locked")
  .item("SCH_ACTIONS::lock", (c) => c.hasUnlocked).item("SCH_ACTIONS::unlock", (c) => c.hasLocked).item("SCH_ACTIONS::toggleLock");
const schAlignMenu = () => new CondMenu("Align", "align_items")
  .item("SCH_ACTIONS::alignLeft", moreThan(1)).item("SCH_ACTIONS::alignCenterX", moreThan(1)).item("SCH_ACTIONS::alignRight", moreThan(1))
  .sep(moreThan(1)).item("SCH_ACTIONS::alignTop", moreThan(1)).item("SCH_ACTIONS::alignCenterY", moreThan(1)).item("SCH_ACTIONS::alignBottom", moreThan(1));
/** BUS_UNFOLD_MENU (sch_line_wire_bus_tool.cpp): the members are filled in by the desktop from the bus's labels. */
const schUnfoldMenu = () => new CondMenu("Unfold from Bus", "add_line2bus").item("SCH_ACTIONS::unfoldBus");

/** ALT_PIN_FUNCTION_MENU and PIN_TRICKS_MENU (sch_edit_tool.cpp): filled in by the editor from the selected pin. */
const PIN_FUNCTION_MENU: MenuDef = { title: "Pin Function", icon: "component_select_unit", entries: [], dynamic: "pinfunction" };
const PIN_TRICKS_MENU: MenuDef = { title: "Pin Helpers", icon: "pin", entries: [], dynamic: "pinhelpers" };
/** SCH_CONDITIONS::AllPinsOrSheetPins */
const allPins: Cond = (c) => c.kinds.length > 0 && c.kinds.every((k) => k === "pin" || k === "sheet_pin");
/** The schematic selection tool's menu (m_selectionTool->GetToolMenu()). */
function schSelectionMenu(): CondMenu {
  const m = new CondMenu();
  // SCH_SELECTION_TOOL::Init
  m.item("SCH_ACTIONS::clearHighlight", and(haveHighlight, idle), 1).sep(and(haveHighlight, idle), 1);
  m.item("SCH_ACTIONS::selectConnection", and(hasTypes(SCH_EXPANDABLE), idle), 2);
  addTableSelectItems(m, and(tableCellSelection, idle));
  m.sep(100).item("SCH_ACTIONS::drawWire", empty, 100).item("SCH_ACTIONS::drawBus", empty, 100);
  m.sep(100).item("ACTIONS::finishInteractive", drawingLine, 100);
  m.item("SCH_ACTIONS::enterSheet", and(schSheetSel, idle), 150).item("SCH_ACTIONS::selectOnPCB", and(hasTypes(set("symbol", "sheet")), idle), 150).item("SCH_ACTIONS::leaveSheet", belowRoot, 150);
  m.sep(200);
  for (const a of ["SCH_ACTIONS::placeJunction", "SCH_ACTIONS::placeLabel", "SCH_ACTIONS::placeClassLabel", "SCH_ACTIONS::placeGlobalLabel", "SCH_ACTIONS::placeHierLabel"]) m.item(a, and(schWireOrBusSel, idle), 250);
  m.item("SCH_ACTIONS::breakWire", and(schLinesSel, idle), 250).item("SCH_ACTIONS::slice", and(schLinesSel, idle), 250);
  m.item("SCH_ACTIONS::placeSheetPin", and(schSheetSel, idle), 250).item("SCH_ACTIONS::autoplaceAllSheetPins", and(schSheetSel, idle), 250).item("SCH_ACTIONS::syncSheetPins", and(schSheetSel, idle), 250);
  // multiplePinsSelection && schEditCondition && Idle (swapPins also needs eeschema's input.allow_unconstrained_pin_swaps,
  // off by default and not offered here)
  m.item("SCH_ACTIONS::swapPinLabels", and(moreThan(1), onlyTypes(set("pin")), idle), 250);
  m.item("SCH_ACTIONS::assignNetclass", and(onlyTypes(SCH_CONNECTED), idle), 250).item("SCH_ACTIONS::findNetInInspector", and(onlyTypes(SCH_CONNECTED), idle), 250);
  m.item("SCH_ACTIONS::editPageNumber", schSheetSel, 250);
  m.sep(400);
  m.sep(1000); standardSubMenus(m);
  // SCH_LINE_WIRE_BUS_TOOL::Init
  m.sub(schUnfoldMenu(), and(count(1), onlyTypes(set("bus")), idle), 100);
  // SCH_MOVE_TOOL::Init
  m.item("SCH_ACTIONS::move", schMove, 150).item("SCH_ACTIONS::drag", schMove, 150).item("SCH_ACTIONS::alignToGrid", schMove, 150);
  // SCH_ALIGN_TOOL::Init
  m.sub(schAlignMenu(), moreThan(1), 100);
  // SCH_EDIT_TOOL::Init
  m.sub(PIN_FUNCTION_MENU, (c) => c.kinds.length === 1 && c.kinds[0] === "pin" && !!c.pinAlts, 1).sub(PIN_TRICKS_MENU, allPins, 1);
  m.sub(schTransformMenu(), schOrient, 200).sub(schAttributesMenu(), hasTypes(SCH_ATTRIB), 200);
  m.item("SCH_ACTIONS::swap", and(onlyTypes(SCH_SWAPPABLE), moreThan(1)), 200).item("SCH_ACTIONS::properties", schProperties, 200);
  m.sub(schEditFieldsMenu(), schSingleSymbol, 200).item("SCH_ACTIONS::autoplaceFields", hasTypes(SCH_FIELD_OWNERS), 200);
  m.item("SCH_ACTIONS::editWithLibEdit", and(schSingleSymbol, idle), 200);
  m.item("SCH_ACTIONS::changeSymbol", schSingleSymbol, 200).item("SCH_ACTIONS::updateSymbol", schSingleSymbol, 200);
  m.item("SCH_ACTIONS::changeSymbols", schMultipleSymbols, 200).item("SCH_ACTIONS::updateSymbols", schMultipleSymbols, 200);
  m.sub(schConvertMenu(), onlyTypes(SCH_ALL_TEXT), 200);
  m.sub(schLockMenu(), notEmpty, 250);
  m.sep(300).item("ACTIONS::cut", idleSelection, 300).item("ACTIONS::copy", idleSelection, 300).item("ACTIONS::copyAsText", and(onlyTypes(SCH_CAN_COPY_TEXT), idle), 300);
  m.item("ACTIONS::paste", idle, 300).item("ACTIONS::pasteSpecial", idle, 300).item("ACTIONS::doDelete", notEmpty, 300).item("ACTIONS::duplicate", not(drawingLine), 300);
  m.sep(400).item("ACTIONS::selectAll", always, 400).item("ACTIONS::unselectAll", always, 400);
  // SCH_GROUP_TOOL::Init (GROUP_TOOL)
  m.sub(GROUP_MENU, notEmpty, 100);
  // SCH_INSPECTION_TOOL::Init
  m.item("ACTIONS::showDatasheet", and(schSingleSymbol, idle), 220);
  // SCH_EDIT_TABLE_TOOL::Init
  addTableMenus(m);
  return m;
}

const SCH_WIRE_TOOLS = ["wire", "bus"];
/** SCH_LINE_WIRE_BUS_TOOL's own menu, shown while Add Wire / Add Bus / Draw Lines is the active tool. */
function schWireToolMenu(): CondMenu {
  const m = new CondMenu(); const wireOrBus = tool(...SCH_WIRE_TOOLS), line = tool("lines");
  m.item("ACTIONS::cancelInteractive", always, 1).sep(1);                       // SCH_TOOL_BASE::Init
  standardSubMenus(m);
  m.item("SCH_ACTIONS::clearHighlight", and(haveHighlight, idle), 1).sep(and(haveHighlight, idle), 1);
  m.sep(10).item("SCH_ACTIONS::drawWire", and(wireOrBus, idle), 10).item("SCH_ACTIONS::drawBus", and(wireOrBus, idle), 10).item("SCH_ACTIONS::drawLines", and(line, idle), 10);
  m.item("SCH_ACTIONS::undoLastSegment", always, 10).item("SCH_ACTIONS::switchSegmentPosture", always, 10).item("ACTIONS::finishInteractive", drawingLine, 10);
  m.sub(schUnfoldMenu(), idle, 10);
  m.sep(100);
  for (const a of ["SCH_ACTIONS::placeJunction", "SCH_ACTIONS::placeLabel", "SCH_ACTIONS::placeClassLabel", "SCH_ACTIONS::placeGlobalLabel", "SCH_ACTIONS::placeHierLabel", "SCH_ACTIONS::breakWire"]) m.item(a, and(wireOrBus, idle), 100);
  m.item("SCH_ACTIONS::slice", and(or(wireOrBus, line), idle), 100).item("SCH_ACTIONS::leaveSheet", belowRoot, 150);
  m.sep(200).item("SCH_ACTIONS::selectNode", and(wireOrBus, idle), 200).item("SCH_ACTIONS::selectConnection", and(wireOrBus, idle), 200);
  return m;
}

const SCH_TEXT_TOOLS = ["label", "classlabel", "glabel", "hlabel", "text"];
/** SCH_DRAWING_TOOLS' menu: every other schematic placement / drawing tool. */
function schDrawingToolMenu(): CondMenu {
  const m = new CondMenu(); const anyText = tool(...SCH_TEXT_TOOLS);
  m.item("ACTIONS::cancelInteractive", always, 1).sep(1);                       // SCH_TOOL_BASE::Init
  standardSubMenus(m);
  // SCH_DRAWING_TOOLS::Init
  m.item("SCH_ACTIONS::leaveSheet", belowRoot, 150).item("SCH_ACTIONS::closeOutline", (c) => c.canClose, 200).item("ACTIONS::deleteLastPoint", (c) => c.canUndoPoint, 200);
  // EE_GRAPHIC_TOOL::Init: while Draw Arcs runs, its posture, the five modes, Cycle Arc Drawing Mode, then Delete Last
  // Point and Finish for the managed shapes (an arc, a bezier)
  const inDrawingArc = tool("arc"), inManagedShape = tool("arc", "bezier");
  m.item("ACTIONS::arcPosture", inDrawingArc, 200);
  for (const a of ["drawArcCenter", "drawArcStartEndMid", "drawArcStartEndCenter", "drawArcTangent", "drawArcStartDirEnd"]) m.check("SCH_ACTIONS::" + a, inDrawingArc, 200);
  m.item("ACTIONS::cycleArcDrawMode", inDrawingArc, 200).item("ACTIONS::deleteLastPoint", and(inManagedShape, (c) => !c.canUndoPoint), 200).item("ACTIONS::finishInteractive", inManagedShape, 200);
  // SCH_EDIT_TOOL::Init (the drawing tools' menu)
  m.item("SCH_ACTIONS::clearHighlight", and(haveHighlight, idle), 1).sep(and(haveHighlight, idle), 1);
  m.item("SCH_ACTIONS::enterSheet", and(schSheetSel, idle), 1).sep(and(schSheetSel, idle), 1);
  m.sub(schTransformMenu(), schOrient, 200).sub(schAttributesMenu(), hasTypes(SCH_ATTRIB), 200).item("SCH_ACTIONS::properties", schProperties, 200);
  m.sub(schEditFieldsMenu(), schSingleSymbol, 200).item("SCH_ACTIONS::autoplaceFields", hasTypes(SCH_FIELD_OWNERS), 200);
  m.item("SCH_ACTIONS::editWithLibEdit", and(schSingleSymbol, idle), 200);
  for (const a of ["SCH_ACTIONS::toLabel", "SCH_ACTIONS::toHLabel", "SCH_ACTIONS::toGLabel", "SCH_ACTIONS::toText", "SCH_ACTIONS::toTextBox"]) m.item(a, and(anyText, idle), 200);
  return m;
}

// ================================================================ pcbnew
const PCB_FOOTPRINT = set("footprint");
const PCB_TRACKS = set("segment", "arc", "via");
const PCB_DRAGGABLE = set("segment", "via", "footprint", "arc");
const PCB_ROUTABLE = set("segment", "arc", "via", "footprint");
const PCB_CONNECTED = set("segment", "arc", "via", "zone");
const PCB_SHAPES = set("gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve");
const PCB_MIRRORABLE = set(...PCB_SHAPES, "field", "gr_text", "gr_text_box", "zone", "segment", "arc", "via", "group", "table", "image");
const PCB_ZONE = set("zone");
const PCB_COPY_TEXT = set("field", "gr_text", "gr_text_box", "dimension", "table");
const PCB_POLY = set("zone", "gr_poly", "gr_rect");
const PCB_TO_TRACK = set("gr_line", "gr_arc");

const pcbCanMirror = or(hasTypes(PCB_MIRRORABLE));
const pcbSingleFootprint = and(count(1), onlyTypes(PCB_FOOTPRINT));
const pcbMultipleFootprints = and(moreThan(1), onlyTypes(PCB_FOOTPRINT));
const pcbRoutable = and(hasTypes(PCB_ROUTABLE), idle);
/** EDIT_TOOL::Init propertiesCondition: one item, or nothing but tracks. */
const pcbProperties: Cond = (c) => c.kinds.length === 1 || (c.kinds.length > 1 && (c.kinds.every((k) => PCB_TRACKS.has(k)) || c.kinds.every((k) => k === "table_cell")));
const noActiveTool = tool("select");

/** SELECT_MENU (pcb_selection_tool.cpp). */
const pcbSelectMenu = () => new CondMenu("Select")
  .item("PCB_ACTIONS::filterSelection").sep()
  .item("PCB_ACTIONS::selectConnection").item("PCB_ACTIONS::selectNet").sep()
  .item("PCB_ACTIONS::selectSameSheet").item("PCB_ACTIONS::selectOnSchematic").sep()
  .item("PCB_ACTIONS::selectUnconnected").item("PCB_ACTIONS::grabUnconnected");
const pcbRoutingMenu = () => new CondMenu("Routing", "special_tools")
  .item("PCB_ACTIONS::routerRouteSelected", pcbRoutable).item("PCB_ACTIONS::routerRouteSelectedFromEnd", pcbRoutable).item("PCB_ACTIONS::unrouteSelected", pcbRoutable)
  .item("PCB_ACTIONS::unrouteSegment", pcbRoutable).item("PCB_ACTIONS::routerAutorouteSelected", pcbRoutable).item("PCB_ACTIONS::routerOptimizeSelected", and(hasTypes(set("segment", "arc")), idle));
const pcbMirrorRotateMenu = () => new CondMenu("Mirror / Rotate", "special_tools")
  .item("PCB_ACTIONS::rotateCcw", notEmpty).item("PCB_ACTIONS::rotateCw", notEmpty).item("PCB_ACTIONS::mirrorH", pcbCanMirror).item("PCB_ACTIONS::mirrorV", pcbCanMirror);
const pcbPositionMenu = () => new CondMenu("Position", "special_tools")
  .item("PCB_ACTIONS::moveExact", idleSelection).item("PCB_ACTIONS::moveWithReference", idleSelection).item("PCB_ACTIONS::moveIndividually", and(moreThan(1), idle))
  .item("PCB_ACTIONS::positionRelative", idleSelection).item("PCB_ACTIONS::interactiveOffsetTool", idleSelection);
const pcbFpAttributesMenu = () => new CondMenu("Attributes")
  .check("PCB_ACTIONS::toggleExcludeFromBOM").check("PCB_ACTIONS::toggleExcludeFromSim").check("PCB_ACTIONS::toggleExcludeFromPosFiles");
/** LOCK_CONTEXT_MENU, ZONE_CONTEXT_MENU (board_editor_control.cpp). */
const pcbLockMenu = () => new CondMenu("Locking", "locked")
  .item("PCB_ACTIONS::lock", (c) => c.hasUnlocked).item("PCB_ACTIONS::unlock", (c) => c.hasLocked).item("PCB_ACTIONS::toggleLock");
const pcbZoneMenu = () => new CondMenu("Zones", "add_zone")
  .item("PCB_ACTIONS::zoneFill").item("PCB_ACTIONS::zoneFillAll").item("PCB_ACTIONS::zoneUnfill").item("PCB_ACTIONS::zoneUnfillAll").sep()
  .item("PCB_ACTIONS::zoneMerge").item("PCB_ACTIONS::zoneDuplicate").item("PCB_ACTIONS::drawZoneCutout").item("PCB_ACTIONS::drawSimilarZone").sep()
  .item("PCB_ACTIONS::zonesManager");
/** NET_CONTEXT_MENU (board_inspection_tool.cpp). */
const pcbNetMenu = () => new CondMenu("Net Inspection Tools", "show_ratsnest")
  .item("PCB_ACTIONS::showNetInRatsnest").item("PCB_ACTIONS::hideNetInRatsnest").sep().item("PCB_ACTIONS::highlightNetSelection").item("PCB_ACTIONS::clearHighlight");
/** ALIGN_DISTRIBUTE_TOOL's placement menu. */
const pcbAlignMenu = () => new CondMenu("Align/Distribute", "align_items")
  .item("PCB_ACTIONS::alignLeft", moreThan(1)).item("PCB_ACTIONS::alignCenterX", moreThan(1)).item("PCB_ACTIONS::alignRight", moreThan(1)).sep(moreThan(1))
  .item("PCB_ACTIONS::alignTop", moreThan(1)).item("PCB_ACTIONS::alignCenterY", moreThan(1)).item("PCB_ACTIONS::alignBottom", moreThan(1)).sep(moreThan(2))
  .item("PCB_ACTIONS::distributeHorizontallyCenters", moreThan(2)).item("PCB_ACTIONS::distributeHorizontallyGaps", moreThan(2))
  .item("PCB_ACTIONS::distributeVerticallyCenters", moreThan(2)).item("PCB_ACTIONS::distributeVerticallyGaps", moreThan(2));
/** CONVERT_TOOL's menu. */
const pcbConvertMenu = () => new CondMenu("Create from Selection", "convert")
  .item("PCB_ACTIONS::convertToPoly", hasTypes(set(...PCB_SHAPES, "segment", "arc", "zone")))
  .item("PCB_ACTIONS::convertToZone", hasTypes(set(...PCB_SHAPES, "segment", "arc", "zone"))).item("PCB_ACTIONS::convertToKeepout", hasTypes(set(...PCB_SHAPES, "segment", "arc", "zone")))
  .item("PCB_ACTIONS::convertToLines", hasTypes(PCB_POLY)).item("PCB_ACTIONS::outsetItems", hasTypes(PCB_SHAPES)).sep()
  .item("PCB_ACTIONS::convertToTracks", hasTypes(PCB_TO_TRACK)).item("PCB_ACTIONS::convertToArc", onlyTypes(set("gr_line", "segment"))).sep()
  .item("PCB_ACTIONS::createArray", notEmpty);
/** CONSTRAINT_EDIT_TOOL's menu. */
const pcbConstraintMenu = () => new CondMenu("Constraints", "measurement").item("PCB_ACTIONS::manageConstraints");

/** The board selection tool's menu. */
function pcbSelectionMenu(): CondMenu {
  const m = new CondMenu();
  // PCB_SELECTION_TOOL::Init
  m.sub(pcbSelectMenu(), notEmpty); m.sep(1000);
  m.item("ACTIONS::cancelInteractive", not(noActiveTool), 1);
  m.item("PCB_ACTIONS::clearHighlight", haveHighlight, 1).sep(haveHighlight, 1);
  addTableSelectItems(m, tableCellSelection);
  m.sep(1); standardSubMenus(m);
  // EDIT_TOOL::Init
  m.item("ACTIONS::selectAll", (c) => c.hasItems).item("ACTIONS::unselectAll", (c) => c.hasItems).sep();
  m.item("PCB_ACTIONS::move", idleSelection);
  m.item("PCB_ACTIONS::drag45Degree", and(count(1), onlyTypes(PCB_DRAGGABLE))).item("PCB_ACTIONS::dragFreeAngle", and(count(1), onlyTypes(PCB_DRAGGABLE), not(onlyTypes(PCB_FOOTPRINT))));
  m.item("PCB_ACTIONS::flip", notEmpty).item("PCB_ACTIONS::swap", moreThan(1)).sep();
  m.item("PCB_ACTIONS::breakTrack", and(count(1), onlyTypes(PCB_TRACKS))).item("PCB_ACTIONS::filletTracks", onlyTypes(PCB_TRACKS)).sep();
  // PCB_POINT_EDITOR::Init
  m.item("PCB_ACTIONS::pointEditorAddCorner", and(count(1), (c) => !!c.canAddCorner)).item("PCB_ACTIONS::pointEditorRemoveCorner", and(count(1), (c) => !!c.canRemoveCorner));
  m.item("ACTIONS::cycleArcEditMode", and(count(1), onlyTypes(set("gr_arc")))).sep();
  m.item("PCB_ACTIONS::packAndMoveFootprints", and(moreThan(1), hasTypes(PCB_FOOTPRINT))).item("PCB_ACTIONS::assignNetClass", onlyTypes(PCB_CONNECTED)).item("PCB_ACTIONS::inspectClearance", count(2));
  m.sep();
  m.item("PCB_ACTIONS::editFpInFpEditor", pcbSingleFootprint).item("PCB_ACTIONS::updateFootprint", pcbSingleFootprint).item("PCB_ACTIONS::updateFootprints", pcbMultipleFootprints);
  m.item("PCB_ACTIONS::changeFootprint", pcbSingleFootprint).item("PCB_ACTIONS::changeFootprints", pcbMultipleFootprints).sub(pcbFpAttributesMenu(), or(pcbSingleFootprint, pcbMultipleFootprints));
  m.sep(100).sub(pcbRoutingMenu(), pcbRoutable, 100).sub(pcbMirrorRotateMenu(), pcbCanMirror, 100).sub(pcbPositionMenu(), idleSelection, 100);
  m.sep(150).item("ACTIONS::cut", notEmpty, 150).item("ACTIONS::copy", notEmpty, 150).item("PCB_ACTIONS::copyWithReference", idleSelection, 150).item("ACTIONS::copyAsText", onlyTypes(PCB_COPY_TEXT), 150);
  m.item("ACTIONS::paste", noActiveTool, 150).item("ACTIONS::pasteSpecial", noActiveTool, 150).item("ACTIONS::duplicate", notEmpty, 150).item("ACTIONS::doDelete", notEmpty, 150);
  m.sep(2000).item("PCB_ACTIONS::properties", pcbProperties, 2000);
  // PAD_TOOL::Init
  m.sep(400);
  // BOARD_EDITOR_CONTROL::Init
  m.item("PCB_ACTIONS::getAndPlace", and(noActiveTool, empty)).sep();
  m.sub(pcbLockMenu(), notEmpty, 100).sub(pcbZoneMenu(), onlyTypes(PCB_ZONE), 100).sub(pcbZoneMenu(), tool("zone"), 300);
  // BOARD_INSPECTION_TOOL::Init
  m.sub(pcbNetMenu(), onlyTypes(PCB_CONNECTED), 100);
  // ALIGN_DISTRIBUTE_TOOL::Init, CONVERT_TOOL::Init, PCB_GROUP_TOOL::Init, CONSTRAINT_EDIT_TOOL::Init
  m.sub(pcbAlignMenu(), moreThan(1), 100).sub(pcbConvertMenu(), hasTypes(set(...PCB_SHAPES, "segment", "arc", "zone")), 100);
  m.sub(GROUP_MENU, notEmpty, 100).sub(pcbConstraintMenu(), always, 100);
  // MATCH_PROPERTIES_TOOL::Init
  m.item("PCB_ACTIONS::matchProperties", count(1), 950);
  // PCB_EDIT_TABLE_TOOL::Init
  addTableMenus(m);
  return m;
}

/** ROUTER_TOOL's menu (pcbnew/router/router_tool.cpp), shown while Route Single Track is the active tool. */
function pcbRouterMenu(): CondMenu {
  const m = new CondMenu(); const notRouting: Cond = (c) => !c.routing;
  m.item("ACTIONS::cancelInteractive", always, 1).sep(1);
  m.item("PCB_ACTIONS::clearHighlight", haveHighlight, 2).sep(haveHighlight, 2);
  m.item("PCB_ACTIONS::routeSingleTrack", notRouting).item("PCB_ACTIONS::routeDiffPair", notRouting);
  m.item("ACTIONS::finishInteractive").item("PCB_ACTIONS::routerUndoLastSegment");
  m.item("PCB_ACTIONS::breakTrack", notRouting).item("PCB_ACTIONS::drag45Degree", notRouting).item("PCB_ACTIONS::dragFreeAngle", notRouting);
  m.item("ACT_PlaceThroughVia").item("ACT_PlaceBlindVia").item("ACT_PlaceMicroVia").item("ACT_SelLayerAndPlaceThroughVia").item("ACT_SelLayerAndPlaceBlindVia").item("ACT_SelLayerAndPlaceMicroVia");
  m.item("ACT_SwitchPosture");
  m.sub(new CondMenu("Track Corner Mode", "switch_corner_rounding_shape").item("ACT_SwitchCornerModeToNext", always, 1).sep(1)
    .check("ACT_SwitchCornerMode45").check("ACT_SwitchCornerModeArc45").check("ACT_SwitchCornerMode90").check("ACT_SwitchCornerModeArc90"));
  m.sep();
  m.sub(new CondMenu("Select Track/Via Width", "width_track_via").item("ACT_CustomTrackWidth"));
  m.sub(DIFF_PAIR_MENU, (c) => c.tool === "routediff");   // diffPairCond: the router is in PNS_MODE_ROUTE_DIFF_PAIR
  m.item("PCB_ACTIONS::routerSettingsDialog").sep();
  standardSubMenus(m);
  return m;
}

/** The Arc toolbar group's own menu (toolbars_pcb_editor.cpp): the arc editing modes, as check items. */
export const ARC_EDIT_MODE_MENU = ["ACTIONS::pointEditorArcKeepCenter", "ACTIONS::pointEditorArcKeepEndpoint", "ACTIONS::pointEditorArcKeepRadius"];
const PCB_ARC_TOOLS = ["garc"];
const PCB_TUNING_TOOLS = ["tunesingle", "tunediff", "tuneskew"];
/** DRAWING_TOOL's menu (pcbnew/tools/drawing_tool.cpp): the board's graphic, zone, dimension, text and via tools. */
function pcbDrawingToolMenu(): CondMenu {
  const m = new CondMenu();
  m.item("ACTIONS::cancelInteractive", always, 1).sep(1);
  m.item("PCB_ACTIONS::clearHighlight", haveHighlight, 2).sep(haveHighlight, 2);
  const arcTool = tool(...PCB_ARC_TOOLS);
  m.item("PCB_ACTIONS::closeOutline", (c) => c.canClose, 200).item("ACTIONS::deleteLastPoint", (c) => c.canUndoPoint, 200).item("ACTIONS::arcPosture", arcTool, 200);
  m.check("PCB_ACTIONS::drawArcCenter", arcTool, 200).check("PCB_ACTIONS::drawArcStartEndMid", arcTool, 200).check("PCB_ACTIONS::drawArcStartEndCenter", arcTool, 200)
    .check("PCB_ACTIONS::drawArcTangent", arcTool, 200).check("PCB_ACTIONS::drawArcStartDirEnd", arcTool, 200).item("ACTIONS::cycleArcDrawMode", arcTool, 200);
  const tuning = tool(...PCB_TUNING_TOOLS);
  m.item("PCB_ACTIONS::spacingIncrease", tuning, 200).item("PCB_ACTIONS::spacingDecrease", tuning, 200).item("PCB_ACTIONS::amplIncrease", tuning, 200)
    .item("PCB_ACTIONS::amplDecrease", tuning, 200).item("PCB_ACTIONS::lengthTunerSettings", tuning, 200);
  m.item("PCB_ACTIONS::changeDimensionArrows", tool("dimaligned", "dimortho", "dimcenter", "dimradial", "leader"), 200);
  m.sep(500); m.sep(500);
  standardSubMenus(m);
  // BOARD_EDITOR_CONTROL::Init (the drawing tool's menu)
  m.sub(pcbZoneMenu(), tool("zone"), 300);
  return m;
}

/** The base menu of a tool that defines none of its own: Cancel, Zoom, Grid (SCH_TOOL_BASE::Init, PCB_TOOL_BASE). */
function basicToolMenu(): CondMenu { const m = new CondMenu(); m.item("ACTIONS::cancelInteractive", always, 1).sep(1); return standardSubMenus(m); }

const MENUS = { schSelection: schSelectionMenu(), schWire: schWireToolMenu(), schDrawing: schDrawingToolMenu(), pcbSelection: pcbSelectionMenu(), pcbRouter: pcbRouterMenu(), pcbDrawing: pcbDrawingToolMenu(), basic: basicToolMenu() };

/** The menu KiCad would show for the active tool: the tool's own while it runs, the selection tool's otherwise. */
export function menuFor(c: MenuCtx, moduleTool: boolean): MenuDef {
  if (c.tool === "select" || c.tool === "highlight") return c.editor === "sch" ? MENUS.schSelection : MENUS.pcbSelection;
  if (!moduleTool) return MENUS.basic;                       // pan, zoom-to-selection, measure, comment: Cancel + Zoom + Grid
  if (c.editor === "sch") return [...SCH_WIRE_TOOLS, "lines"].includes(c.tool) ? MENUS.schWire : c.tool === "delete" ? MENUS.basic : MENUS.schDrawing;
  return c.tool === "route" || c.tool === "routediff" ? MENUS.pcbRouter : c.tool === "delete" || c.tool === "drag" ? MENUS.basic : MENUS.pcbDrawing;
}

/** One evaluated entry: CONDITIONAL_MENU::Evaluate's output before labels and availability are attached. */
export type Resolved = { sep: true } | { act: string; check: boolean } | { menu: MenuDef; items: Resolved[] };

export function evaluate(menu: MenuDef, c: MenuCtx): Resolved[] {
  const out: Resolved[] = []; let since = 0;
  for (const e of menu.entries) {
    let ok = false; try { ok = e.cond(c); } catch { ok = false; }
    if (!ok) continue;
    if ("sep" in e) { if (since) out.push({ sep: true }); since = 0; continue; }
    if ("menu" in e) {
      const items = e.menu.dynamic ? [] : evaluate(e.menu, c);
      if (!e.menu.dynamic && !items.length) continue;       // wx hides nothing here, but an empty submenu is never what KiCad shows
      out.push({ menu: e.menu, items }); since++; continue;
    }
    out.push({ act: e.act, check: !!e.check }); since++;
  }
  while (out.length && "sep" in out[out.length - 1]) out.pop();
  return out;
}
