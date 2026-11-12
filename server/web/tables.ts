// tables.ts — the static tables that used to live in kicad-ui.js: which KiCad draw actions
// map to which module tool ids, the radio groups, the menus (eeschema/menubar.cpp,
// pcbnew/menubar_pcb_editor.cpp), the labels of our own entries, the pane ↔ action map
// and the selection-filter categories (panel_*selection_filter_base).
import type { Editor } from "./store";

/** KiCad action id → web tool id (app.js's own tools or a sch-tools / pcb-tools tool). */
export const TOOL_MAP: Record<Editor, Record<string, string>> = {
  sch: { selectSetRect: "select", selectSetLasso: "select", highlightNetTool: "highlight", placeSymbol: "place", placePower: "power", drawWire: "wire", drawBus: "bus", placeBusWireEntry: "busentry",
    placeNoConnect: "noconnect", placeJunction: "junction", placeLabel: "label", placeClassLabel: "classlabel", placeGlobalLabel: "glabel",
    placeHierLabel: "hlabel", drawRuleArea: "rulearea", drawSheet: "sheet", placeSheetPin: "sheetpin", placeSchematicText: "text", drawTextBox: "textbox", drawTable: "table",
    drawRectangle: "rect", drawCircle: "circle", drawArc: "arc", drawBezier: "bezier", drawPolygon: "polygon", drawLines: "lines", placeImage: "image",
    deleteTool: "delete", zoomTool: "zoomtool", measureTool: "measure" },
  pcb: { selectSetRect: "select", selectSetLasso: "select", routeSingleTrack: "route", routeDiffPair: "routediff", tuneSingleTrack: "tunesingle", tuneSkew: "tuneskew", drawVia: "via", drawZone: "zone", drawRuleArea: "rulearea", drawLine: "gline", drawArc: "garc", drawArcCenter: "garc", drawArcStartEndMid: "garc", drawArcStartEndCenter: "garc", drawArcTangent: "garc", drawArcStartDirEnd: "garc", drawRectangle: "grect",
    drawCircle: "gcircle", drawPolygon: "gpoly", drawBezier: "gcurve", placeReferenceImage: "image", placeText: "gtext", drawTextBox: "gtextbox", drawTable: "table",
    drawAlignedDimension: "dimaligned", drawOrthogonalDimension: "dimortho", drawCenterDimension: "dimcenter", drawRadialDimension: "dimradial", drawLeader: "leader",
    deleteTool: "delete", measureTool: "measure", zoomTool: "zoomtool", gridSetOrigin: "gridorigin", drillOrigin: "drillorigin" },
};
/** The collab tools app.js keeps at the foot of the draw toolbar. */
export const EXTRA_TOOLS: { id: string; tool: string; name: string; key: string; glyph: string }[] = [
  { id: "collabComment", tool: "comment", name: "Add comment", key: "Alt+C", glyph: "<path d='M4 5h16v11H9l-5 4z'/>" },
  { id: "collabFollow", tool: "follow", name: "Follow a collaborator", key: "", glyph: "<circle cx='12' cy='8' r='4'/><path d='M4 21a8 8 0 0116 0'/>" },
  { id: "pan", tool: "pan", name: "Pan the view", key: "", glyph: "<path d='M8 13V6a1.5 1.5 0 013 0v5M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8a5 5 0 01-10 0v-2a1.5 1.5 0 013 0'/>" },
];
export function toolFor(editor: Editor | null, actionId: string): string | null {
  const extra = EXTRA_TOOLS.find((e) => e.id === actionId); if (extra) return extra.tool;
  return editor ? TOOL_MAP[editor][actionId] || null : null;
}

/** Toolbar radio groups whose "on" state app.js owns. */
export const RADIO: Record<string, string[]> = {
  Units: ["millimetersUnits", "inchesUnits", "milsUnits"],
  "Crosshair modes": ["cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs"],
  "Line modes": ["lineModeFree", "lineMode90", "lineMode45"],
  "Selection modes": ["selectSetRect", "selectSetLasso"],
};

/**
 * A menu entry: "-" a separator, an action id ("save"), an action with KiCad's menu-specific label
 * ("exportNetlist|Netlist..."), a module-only command ("module:clearAnnotation") or a sub-menu [title, entries].
 * A "&" in a title marks its mnemonic, as in the wxWidgets labels these are copied from.
 */
export type MenuEntry = string | [string, MenuEntry[]];
// The menus of eeschema/menubar.cpp and pcbnew/menubar_pcb_editor.cpp (project mode), entry for entry.  The web's
// own entries sit beside the collaboration block of File, at the end of View > Panels and in a last group of View;
// the commands KiCad only offers from its context menus follow KiCad's own entries of Edit / Inspect / Route in the
// sub-menus the context menus use (Select, Align/Distribute, Positioning Tools, Grouping, Locking, Zones, …).
const COLLAB_FILE: MenuEntry[] = ["share", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "-", "archive", "clone", "github", "openInKicad"];
const UNITS_MENU: MenuEntry = ["&Units", ["inchesUnits", "milsUnits", "millimetersUnits", "-", "toggleUnits"]];
const VIEW_WEB: MenuEntry[] = ["toggleGrid", "gridProperties", "gridNext", "gridPrev", UNITS_MENU, "cursorFullCrosshairs", "togglePolarCoords", "resetLocalCoords"];
const HELP_MENU: MenuEntry[] = ["help", "gettingStarted", "listHotKeys", "getInvolved", "donate", "reportBug", "-", "downloadDesktop", "sourceCode", "-", "about"];
const LANG_MENU: MenuEntry = ["Set Language", ["languageEnglish"]];
// the UI theme (web/theme.ts): KiCad's Preferences > Common > "Appearance" choice, as a sub-menu
const THEME_MENU: MenuEntry = ["&Appearance", ["themeLight", "themeDark", "themeSystem"]];
export const MENUS: Record<Editor, [string, MenuEntry[]][]> = {
  sch: [
    ["&File", ["save", "saveCurrSheetCopyAs", "revert", "-",
      ["Import", ["importNonKicadSchematic|Non-KiCad Schematic...", "importFPAssignments|Footprint Assignments...", "importGraphics|Graphics..."]],
      ["Export", ["drawSheetOnClipboard|Drawing to Clipboard", "exportNetlist|Netlist...", "exportSymbolsToLibrary|Symbols..."]],
      "-", ...COLLAB_FILE, "-", "compareSchematicWithFile", "compareSchematicWithHistory|Compare Schematic with History...", "-", "schematicSetup", "-", "pageSettings", "print", "plot", "-", "home"]],
    ["&Edit", ["undo", "redo", "-", "cut", "copy", "copyAsText", "paste", "pasteSpecial", "doDelete", "-",
      "selectAll", "unselectAll", ["&Select", ["selectConnection", "selectNode", "-", "nextNetItem", "previousNetItem"]], "-",
      "find", "findAndReplace", "-", "deleteTool", "editTextAndGraphics", "changeSymbols", "editPageNumber",
      ["Attributes", ["setExcludeFromSim", "setExcludeFromBOM", "setExcludeFromBoard", "setExcludeFromPosFiles", "setDNP"]],
      "-", "duplicate", "repeatDrawItem", "increment", "decrement",
      "-", "move", "drag", "rotateCCW", "rotateCW", "mirrorV", "mirrorH", "swap",
      ["Align", ["alignLeft", "alignCenterX", "alignRight", "-", "alignTop", "alignCenterY", "alignBottom", "-", "alignToGrid"]], "module:moveExactly",
      "-", "properties", "editReference", "editValue", "editFootprint", "autoplaceFields", "showDatasheet",
      ["Symbol Unit", ["previousUnit", "nextUnit", "placeNextSymbolUnit", "-", "cycleBodyStyle"]],
      ["Change To", ["toLabel", "toDLabel", "toHLabel", "toGLabel", "toText", "toTextBox"]],
      "-", "breakWire", "slice", "unfoldBus", "syncSheetPins", "cleanupSheetPins"]],
    ["&View", [["Panels", ["showProperties", "showSearch", "showHierarchy", "showNetNavigator", "showDesignBlockPanel|Design Blocks", "showRemoteSymbolPanel|Remote Symbols", "-", "showSelectionFilter", "showHistory", "showPeers", "showComments", "showAppearance", "showAssistant"]],
      "-", "showSymbolBrowser", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomFitSelection", "zoomTool", "zoomRedraw",
      "-", "navigateBack", "navigateUp", "navigateForward", "navigatePrevious", "navigateNext",
      "-", "toggleHiddenPins", "toggleHiddenFields", "toggleDirectiveLabels", "toggleERCErrors", "toggleERCWarnings", "toggleERCExclusions", "markSimExclusions", "toggleOPVoltages", "toggleOPCurrents", "togglePinAltIcons",
      "-", ...VIEW_WEB]],
    ["&Place", ["placeSymbol", "placePower", "drawWire", "drawBus", "placeBusWireEntry", "placeNoConnect", "placeJunction", "placeLabel", "placeGlobalLabel", "placeClassLabel", "drawRuleArea",
      "-", "placeHierLabel", "drawSheet", "placeSheetPin", "syncAllSheetsPins", "importSheet",
      "-", "placeSchematicText", "drawTextBox", "drawTable", "drawRectangle", "drawCircle", "drawEllipse", "drawEllipseArc", "drawArc", "drawBezier", "drawPolygon", "drawLines", "placeImage"]],
    ["&Inspect", ["showBusSyntaxHelp", "-", "runERC", "prevMarker", "nextMarker", "excludeMarker", "clearMarkers", "-", "diffSymbol", "-", "showSimulator",
      "-", "highlightNetTool", "clearHighlight", "measureTool"]],
    ["&Tools", ["updatePcbFromSchematic", "showPcbNew", "showProjectManager", "showCalculatorTools", "-", "showSymbolEditor", "updateSymbols", "-", "rescueSymbols", "remapSymbols",
      "-", "editSymbolFields", "editSymbolLibraryLinks", "-", "annotate", "module:clearAnnotation", "toggleAnnotateAuto", "incrementAnnotations", "-", "assignFootprints", "generateBOM", "generateBOMLegacy",
      "-", "updateSchematicFromPcb", "-", "createNetChain", "-",
      ["Variants", ["addVariant", "removeVariant", "editVariantDescription", "renameVariant", "copyVariant"]]]],
    ["P&references", ["configurePaths", "showSymbolLibTable", "showDesignBlockLibTable", "openPreferences", "-", LANG_MENU, "-", THEME_MENU]],
    ["&Help", HELP_MENU],
  ],
  pcb: [
    ["&File", ["appendBoard", "compareBoardWithFile", "compareBoardWithHistory|Compare Board with History...", "-", "save", "saveCopy", "revert", "-", "rescueAutosave", "-",
      ["Import", ["importNetlist|Netlist...", "importSpecctraSession|Specctra Session...", "placeImportedGraphics|Graphics...", "openNonKicadBoard"]],
      ["Export", ["exportSpecctraDSN|Specctra DSN...", "exportGenCAD|GenCAD...", "exportVRML|VRML...", "exportIDF|IDFv3...", "exportSTEP|STEP/GLB/BREP/XAO/PLY/STL...", "exportCmpFile|Footprint Association (.cmp) File...", "exportHyperlynx|Hyperlynx...",
        "-", "exportFootprints|Footprints..."]],
      ["Fabrication Outputs", ["generateGerbers", "generateDrillFiles", "generateIPC2581File", "generateODBPPFile", "generatePosFile", "generateReportFile", "generateD356File", "generateBOM", "generateBOMLegacy"]],
      "-", ...COLLAB_FILE, "-", "boardSetup", "-", "pageSettings", "print", "plot", "-", "home"]],
    ["&Edit", ["undo", "redo", "-", "cut", "copy", "paste", "pasteSpecial", "doDelete", "-",
      ["&Select", ["selectAll", "unselectAll", "-", "filterSelection", "-", "selectConnection", "selectNet", "deselectNet", "selectNetChain", "selectSameSheet", "selectOnSchematic", "module:selectAllOnLayer", "-", "selectUnconnected", "grabUnconnected"]],
      "-", "find", "findByProperties", "-", "extendGraphic", "trimGraphic", "editTracksAndVias", "editTextAndGraphics", "editTeardrops", "changeFootprints", "swapLayers", "gridOrigin",
      "-", "zoneFillAll", "zoneUnfillAll", "regenerateAllTuning", "-", "deleteTool", "globalDeletions",
      "-", "duplicate", "copyAsText", "createArray",
      "-", "move", "drag45Degree", "dragFreeAngle", "rotateCcw", "rotateCw", "flip", "mirrorH", "mirrorV", "swap", "packAndMoveFootprints",
      ["Positioning Tools", ["moveExact", "moveWithReference", "moveIndividually", "positionRelative", "interactiveOffsetTool"]],
      ["Align/Distribute", ["alignLeft", "alignCenterX", "alignRight", "-", "alignTop", "alignCenterY", "alignBottom", "-", "distributeHorizontallyCenters", "distributeHorizontallyGaps", "distributeVerticallyCenters", "distributeVerticallyGaps"]],
      "-", "properties",
      ["Routing", ["changeTrackWidth", "module:setTrackWidthFromNetclass", "-", "changeTrackLayerNext", "changeTrackLayerPrev", "-", "breakTrack", "unrouteSelected", "deleteFull"]],
      ["Grouping", ["group", "ungroup", "addToGroup", "removeFromGroup"]],
      ["Locking", ["toggleLock", "lock", "unlock"]],
      ["Create from Selection", ["convertToPoly", "convertToZone", "convertToKeepout", "convertToLines", "convertToTracks"]],
      ["Zones", ["zoneDuplicate", "-", ["Zone Priority", ["zonePriorityMoveToTop", "zonePriorityRaise", "zonePriorityLower", "zonePriorityMoveToBottom"]]]],
      ["Attributes", ["toggleExcludeFromBOM", "toggleExcludeFromPosFiles", "module:toggleDNP"]],
      ["Text Justification", ["leftJustify", "centerJustify", "rightJustify"]]]],
    ["&View", [["Panels", ["showProperties", "showSearch", "showLayersManager", "showNetInspector", "showConstraintsPanel", "-", "showSelectionFilter", "showHistory", "showPeers", "showComments", "showAssistant"]],
      "-", "showFootprintBrowser", "show3DViewer", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomFitSelection", "zoomTool", "zoomRedraw", "-",
      ["&Drawing Mode", ["zoneDisplayFilled", "zoneDisplayOutline", "-", "padDisplayMode", "viaDisplayMode", "trackDisplayMode", "-", "graphicsOutlines", "textOutlines"]],
      ["&Contrast Mode", ["highContrastMode", "layerAlphaDec", "layerAlphaInc"]],
      "flipBoard",
      "-", ...VIEW_WEB, "-", "showRatsnest", "module:ratsnestLineMode", "showNetNames", "showPadNumbers", "showHiddenText", "zoneFillPreview"]],
    ["&Place", ["placeFootprint", "drawVia", "placeViaStack", "makeViaStack", "drawZone", "drawCopperThievingZone", "drawRuleArea",
      ["Draw Microwave Shapes", ["microwaveCreateLine", "microwaveCreateGap", "microwaveCreateStub", "microwaveCreateStubArc", "microwaveCreateFunctionShape"]],
      "-", "drawLine", "drawArc", "drawRectangle", "drawCircle", "drawEllipse", "drawEllipseArc", "drawPolygon", "drawBezier", "placeReferenceImage", "placeText", "drawTextBox", "drawTable", "placePoint", "placeBarcode", "-",
      ["Draw Dimensions", ["drawOrthogonalDimension", "drawAlignedDimension", "drawCenterDimension", "drawRadialDimension", "drawLeader"]],
      ["Geometric Constraints", ["removeConstraints"]],
      "-", "placeCharacteristics", "placeStackup", "-", "drillOrigin", "drillResetOrigin", "gridSetOrigin", "gridResetOrigin", "-", "placeSubGrid", "-",
      ["Auto-Place Footprints", ["autoplaceOffboardComponents", "autoplaceSelectedComponents"]]]],
    ["Ro&ute", ["selectLayerPair", "-", "routeSingleTrack", "routeDiffPair", "-", "tuneSingleTrack", "tuneDiffPair", "tuneSkew", "-", "module:autoroute", "module:autoplace", "-", "routerSettingsDialog",
      "-", "trackWidthInc", "trackWidthDec", "viaSizeInc", "viaSizeDec", "module:autoTrackWidth", "module:editPredefinedSizes", "-", "layerTop", "layerBottom", "layerNext", "layerPrev", "module:layerToggle"]],
    ["&Inspect", ["boardStatistics", "measureTool", "-", "runDRC", "prevMarker", "nextMarker", "excludeMarker", "clearMarkers", "-", "inspectClearance", "inspectConstraints", "showFootprintAssociations", "diffFootprint", "-",
      ["Net Inspection Tools", ["highlightNet", "clearHighlight", "toggleNetHighlight", "-", "localRatsnestTool", "hideNetInRatsnest", "showNetInRatsnest"]]]],
    ["&Tools", ["updatePcbFromSchematic", "showEeschema", "showProjectManager", "showCalculatorTools", "-", "drcRuleEditor", "-", "showFootprintEditor", "updateFootprints", "migrate3DModels", "editFootprintFields",
      "-", "zonesManager", "-", "cleanupTracksAndVias", "removeUnusedPads", "cleanupGraphics", "repairBoard", "-", "collect3DModels", "-", "boardReannotate", "updateSchematicFromPcb",
      ["Multi-Channel", ["generatePlacementRuleAreas", "repeatLayout"]]]],
    ["P&references", ["configurePaths", "showFootprintLibTable", "openPreferences", "-", LANG_MENU, "-", THEME_MENU]],
    ["&Help", HELP_MENU],
  ],
};
/** The icon KiCad gives a sub-menu (ACTION_MENU::SetIcon in the menubars and the tools' context menus), by its title. */
export const SUBMENU_ICONS: Record<string, string> = { Import: "import", Export: "export_file", "Fabrication Outputs": "fabrication", "Set Language": "language", "Drawing Mode": "add_zone", "Contrast Mode": "contrast_mode",
  "Draw Microwave Shapes": "mw_add_line", "Draw Dimensions": "add_aligned_dimension", "Geometric Constraints": "measurement", "Auto-Place Footprints": "mode_module", "Multi-Channel": "mode_module",
  "External Plugins": "puzzle_piece", "Zone Priority": "swap", Zones: "add_zone", Locking: "locked", "Net Inspection Tools": "show_ratsnest", Grouping: "group", "Symbol Unit": "component_select_unit",
  "Positioning Tools": "special_tools", Routing: "special_tools", "Align/Distribute": "align_items", Align: "align_items", "Create from Selection": "convert", Units: "unit_mm", "Text Justification": "text_align_left" };
/** Entries KiCad adds with ACTION_MENU::CHECK (plus the web's own toggles): they carry a checkmark when on. */
export const MENU_CHECKS = new Set(["showProperties", "showSearch", "showHierarchy", "showNetNavigator", "showDesignBlockPanel", "showRemoteSymbolPanel", "showLayersManager", "showNetInspector", "showConstraintsPanel",
  "showSelectionFilter", "showHistory", "showPeers", "showComments", "showAppearance",
  "toggleHiddenPins", "toggleHiddenFields", "toggleDirectiveLabels", "toggleERCErrors", "toggleERCWarnings", "toggleERCExclusions", "markSimExclusions", "toggleOPVoltages", "toggleOPCurrents", "togglePinAltIcons",
  "setExcludeFromSim", "setExcludeFromBOM", "setExcludeFromBoard", "setExcludeFromPosFiles", "setDNP", "toggleAnnotateAuto",
  "zoneDisplayFilled", "zoneDisplayOutline", "padDisplayMode", "viaDisplayMode", "trackDisplayMode", "graphicsOutlines", "textOutlines", "highContrastMode", "flipBoard",
  "toggleGrid", "inchesUnits", "milsUnits", "millimetersUnits", "cursorFullCrosshairs", "togglePolarCoords", "showRatsnest", "showNetNames", "showPadNumbers", "showHiddenText", "zoneFillPreview", "languageEnglish", "themeLight", "themeDark", "themeSystem"]);
/**
 * A KiCad menu id whose command the tool module publishes under another name (CollabTools.<editor>.actions): the
 * entry keeps KiCad's id, label, icon and hotkey and runs the module's action.
 */
export const MODULE_ALIAS: Record<Editor, Record<string, string>> = {
  sch: { rotateCCW: "rotateSelection", rotateCW: "rotateSelectionCW", mirrorH: "mirrorSelectionX", mirrorV: "mirrorSelectionY", repeatDrawItem: "repeatLast", autoplaceFields: "autoplace",
    editSymbolFields: "fieldsTable" },   // syncAllSheetsPins is the dialog (dialogs/sync-pins.ts), not the module's quick sync of the selected sheet
  pcb: { flip: "flipSelection", rotateCcw: "rotateSelection", rotateCw: "rotateSelectionCw", mirrorH: "mirrorH", mirrorV: "mirrorV", moveExact: "moveExactly", editTracksAndVias: "changeTrackWidth", showNetInspector: "netInspector",
    distributeHorizontallyGaps: "distributeH", distributeVerticallyGaps: "distributeV", distributeHorizontallyCenters: "distributeHCenters", distributeVerticallyCenters: "distributeVCenters" },
};
/** Module action ids that only repeat another one (the same command under a second name), or that KiCad offers only in a context menu: never listed on their own. */
export const MODULE_DUPLICATES: Record<Editor, string[]> = {
  sch: ["highlightNet"],
  pcb: ["highlightNetSelection", "cleanupTracks", "pack", "zoneFill", "zoneUnfill", "pointEditorAddCorner", "pointEditorRemoveCorner",
    // the interactive router's own commands: KiCad offers them in the router's context menu and the route tool's toolbar menu only
    "routerHighlightMode", "routerShoveMode", "routerWalkaroundMode", "cycleRouterMode", "routerUndoLastSegment", "routerDiffPairDialog",
    // the length tuner's commands: the drawing tool's context menu while a tuning tool runs (drawing_tool.cpp tuningToolActive), hotkeys 1-4 and Ctrl+L
    "spacingIncrease", "spacingDecrease", "amplIncrease", "amplDecrease", "lengthTunerSettings",
    // Tools > Rebuild All / Selected Generators: pcbnew lists them only with the EnableGenerators advanced setting
    "regenerateAll", "regenerateSelected",
    "ACT_SwitchCornerModeToNext", "ACT_SwitchCornerMode45", "ACT_SwitchCornerModeArc45", "ACT_SwitchCornerMode90", "ACT_SwitchCornerModeArc90",
    "ACT_PlaceThroughVia", "ACT_PlaceBlindVia", "ACT_PlaceMicroVia", "ACT_SelLayerAndPlaceThroughVia", "ACT_SelLayerAndPlaceBlindVia", "ACT_SelLayerAndPlaceMicroVia",
    // Line Modes live on the left toolbar's radio group and Shift+Space; Ctrl++ / Ctrl+- (incWidth / decWidth) are the drawing tools' context menu
    "lineModeFree", "lineModeNext", "incWidth", "decWidth",
    // the arc tool's modes: the Arc toolbar group and DRAWING_TOOL's context menu while Draw Arcs runs; / and Alt+/ act on the arc in progress
    "drawArcCenter", "drawArcStartEndMid", "drawArcStartEndCenter", "drawArcTangent", "drawArcStartDirEnd", "arcPosture", "cycleArcDrawMode"],
};
/** What an entry needs before it can run (KiCad's SELECTION_CONDITIONS / the read-only frame): greyed out otherwise. */
export const NEEDS_SELECTION = new Set(["cut", "copy", "copyAsText", "doDelete", "duplicate", "increment", "decrement", "move", "drag", "drag45Degree", "dragFreeAngle", "rotateCCW", "rotateCW", "rotateCcw", "rotateCw",
  "mirrorH", "mirrorV", "flip", "swap", "packAndMoveFootprints", "properties", "editReference", "editValue", "editFootprint", "autoplaceFields", "showDatasheet", "zoomFitSelection",
  "alignLeft", "alignCenterX", "alignRight", "alignTop", "alignCenterY", "alignBottom", "alignToGrid", "module:moveExactly", "moveExact", "moveWithReference", "moveIndividually", "positionRelative", "interactiveOffsetTool",
  "distributeHorizontallyCenters", "distributeHorizontallyGaps", "distributeVerticallyCenters", "distributeVerticallyGaps", "previousUnit", "nextUnit", "placeNextSymbolUnit", "cycleBodyStyle",
  "toLabel", "toDLabel", "toHLabel", "toGLabel", "toText", "toTextBox", "breakWire", "slice", "unfoldBus", "syncSheetPins", "cleanupSheetPins", "selectConnection", "selectNode", "nextNetItem", "previousNetItem",
  "setExcludeFromSim", "setExcludeFromBOM", "setExcludeFromBoard", "setExcludeFromPosFiles", "setDNP", "selectNet", "deselectNet", "selectSameSheet", "filterSelection", "createArray",
  "changeTrackWidth", "module:setTrackWidthFromNetclass", "changeTrackLayerNext", "changeTrackLayerPrev", "breakTrack", "unrouteSelected", "deleteFull", "group", "ungroup", "addToGroup", "removeFromGroup",
  "toggleLock", "lock", "unlock", "convertToPoly", "convertToZone", "convertToKeepout", "convertToLines", "convertToTracks", "zoneDuplicate", "zonePriorityMoveToTop", "zonePriorityRaise", "zonePriorityLower",
  "zonePriorityMoveToBottom", "toggleExcludeFromBOM", "toggleExcludeFromPosFiles", "module:toggleDNP", "leftJustify", "centerJustify", "rightJustify", "hideNetInRatsnest", "showNetInRatsnest"]);
/** Entries that never change the document: everything else is greyed out for a view-only visitor, as in a read-only frame. */
export const READ_ONLY_OK = new Set(["compareSchematicWithFile", "compareSchematicWithHistory", "compareBoardWithFile", "compareBoardWithHistory", "saveCurrSheetCopyAs", "saveCopy", "drawSheetOnClipboard", "exportNetlist", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "archive", "clone",
  "openInKicad", "print", "plot", "home", "copy", "copyAsText", "selectAll", "unselectAll", "selectConnection", "selectNode", "nextNetItem", "previousNetItem", "find", "showDatasheet",
  "selectNet", "deselectNet", "selectSameSheet", "module:selectAllOnLayer", "selectUnconnected", "filterSelection", "runERC", "runDRC", "clearMarkers", "boardStatistics", "measureTool", "inspectClearance",
  "highlightNetTool", "highlightNet", "clearHighlight", "toggleNetHighlight", "localRatsnestTool", "hideNetInRatsnest", "showNetInRatsnest", "showPcbNew", "showEeschema", "theme", "themeLight", "themeDark", "themeSystem", "languageEnglish",
  "layerTop", "layerBottom", "layerNext", "layerPrev", "showNetInspector", "showBusSyntaxHelp"]);
/**
 * Keys a tool module binds to something other than KiCad's default, taken before the module sees them
 * (editor/hotkeys.ts preemptKey): "spec" runs KiCad's action for the key — and swallows the key when the web has
 * none, so the module's other meaning never fires; "key:<k>" hands the module the key it does listen on for that
 * command ("key:Shift+L"); "none" only swallows.
 */
export const KICAD_KEY_WINS: Record<Editor, Record<string, string>> = {
  sch: {
    H: "key:H",                 // Add Hierarchical Label (H was the web's pan tool, the module used Shift+H)
    "Ctrl+L": "key:Shift+L",    // Add Global Label (the module arms it, with its prompt, on Shift+L)
    "Shift+L": "none",          // unbound in KiCad
    D: "spec",                  // Show Datasheet (the module duplicated on D: that is Ctrl+D)
  },
  pcb: {
    T: "spec",                                   // Get and Move Footprint (the module had Add Text here: that is Ctrl+Shift+T)
    "Shift+L": "spec", "Shift+C": "spec",        // the module's draw line / circle: KiCad has them on Ctrl+Shift+L / Ctrl+Shift+C
    "Shift+R": "spec",                           // Rotate Clockwise (the module's draw rectangle has no default hotkey)
    "'": "spec", "\\": "spec", "|": "spec",        // Increase / Decrease Via Size are ' and \ (the module had \ and |)
    "+": "spec", "-": "spec",                    // Switch to Next / Previous Layer (the web zoomed on these)
    "Ctrl+Shift+L": "spec", "Ctrl+Shift+T": "spec",
    PgUp: "spec", PgDn: "spec",                  // Switch to Component (F.Cu) / Copper (B.Cu) layer, through the layer state the chrome shows
  },
};
/** Handled ids that only one editor implements: the other editor's entry and hotkey stay desktop-only. */
export const EDITOR_ONLY: Record<string, Editor> = { move: "sch", drag: "sch", exportNetlist: "sch", saveCurrSheetCopyAs: "sch", drawSheetOnClipboard: "sch", saveCopy: "pcb",
  navigatePrevious: "sch", navigateNext: "sch", navigateBack: "sch", navigateForward: "sch", navigateUp: "sch", leaveSheet: "sch", toggleHiddenPins: "sch", toggleHiddenFields: "sch",
  layerNext: "pcb", layerPrev: "pcb", layerTop: "pcb", layerBottom: "pcb", highContrastModeCycle: "pcb", highContrastMode: "pcb", showPcbNew: "sch", showEeschema: "pcb" };
/** The menus that take a module action no entry above places (kept reachable in a trailing "Other Commands" sub-menu). */
export const MODULE_ACTION_MENUS = ["Edit", "Tools", "Inspect"];

/** The project manager's bar (home view): the same entries the old markup carried. */
// The projects home has no menu bar of its own: everything it offered (new project, join, import, Trash,
// log out, the desktop app) is one click away in the sidebar, and a File menu over a list of projects only
// repeated it.  The top bar there carries the product name and the account.
export const HOME_MENUS: [string, MenuEntry[]][] = [];

/** Labels for entries that are ours rather than KiCad TOOL_ACTIONs. */
export const LOCAL_LABELS: Record<string, string> = {
  github: "GitHub Sync...", showAssistant: "Assistant", drillResetOrigin: "Reset Drill Origin", gridResetOrigin: "Reset Grid Origin",
  collabCopyLink: "Copy Share Link", collabComments: "Comments...", collabFollow: "Follow Next Peer", collabHistory: "History",
  collabLeave: "Leave Session", archive: "Download Project (.zip)", clone: "Clone to My Account", openInKicad: "Open in KiCad Collaborative...", home: "Back to Projects",
  showSelectionFilter: "Selection Filter", showHistory: "History", showPeers: "Collaborators", showComments: "Comments", showAppearance: "Appearance",
  showNetNames: "Show Net Names", showPadNumbers: "Show Pad Numbers", showHiddenText: "Show Hidden Text", zoneFillPreview: "Zone Fill Preview", flipBoard: "Flip Board View", clearMarkers: "Clear Markers",
  theme: "Toggle Dark Theme", themeLight: "Light", themeDark: "Dark", themeSystem: "System", downloadDesktop: "Download Desktop App", sourceCode: "Source on GitHub", about: "About KiCad Collaborative",
  languageEnglish: "English", showSearch: "Search", toDLabel: "Change to Directive Label", decrement: "Decrement", netInspector: "Net Inspector",
  // home-view menu entries
  share: "Share…", newProject: "New Project…", joinLink: "Join with Link…", importGithub: "Import from GitHub…", openTrash: "Trash", signOut: "Log Out", checkpoint: "Create checkpoint…", kicad: "Open in KiCad Collaborative…", zoomin: "Zoom in", zoomout: "Zoom out", fit: "Zoom to fit",
  "tab-appearance": "Layers", "tab-props": "Properties", "tab-peers": "Collaborators", "tab-comments": "Comments", "tab-history": "History",
};
export const LOCAL_KEYS: Record<string, string> = { zoomin: "+", zoomout: "−", fit: "Home", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", selectAll: "Ctrl+A" };
/** External links among the menu entries (rendered as anchors). */
export const LINKS: Record<string, string> = {
  downloadDesktop: "https://github.com/notaroomba/kicad-collaborative/releases", sourceCode: "https://github.com/notaroomba/kicad-collaborative",
  help: "https://docs.kicad.org/", gettingStarted: "https://docs.kicad.org/master/en/getting_started_in_kicad/getting_started_in_kicad.html",
  getInvolved: "https://go.kicad.org/contribute/", donate: "https://go.kicad.org/app-donate", reportBug: "https://github.com/notaroomba/kicad-collaborative/issues/new",
};

/** Docked pane ids and the KiCad "show …" action that toggles each. */
export const PANE_ACTION: Record<string, string> = { props: "showProperties", hier: "showHierarchy", filter: "showSelectionFilter", history: "showHistory", peers: "showPeers", comments: "showComments", appearance: "showLayersManager", search: "showSearch", netnav: "showNetNavigator" };
export const PANE_TITLES: Record<string, string> = { props: "Properties", hier: "Schematic Hierarchy", filter: "Selection Filter", history: "History", peers: "Collaborators", comments: "Comments", appearance: "Appearance", search: "Search", netnav: "Net Navigator" };
/** Dock layout per editor: Properties · Hierarchy · Selection Filter · History left; the board keeps Appearance (with the filter below it) on the right. */
export const DOCKS: Record<Editor, { left: string[]; right: string[]; bottom?: string[] }> = {
  sch: { left: ["props", "hier", "netnav", "filter", "history", "peers", "comments", "appearance"], right: [], bottom: ["search"] },
  pcb: { left: ["props", "history", "peers", "comments"], right: ["appearance", "filter"], bottom: ["search"] },
};
/** Panes hidden until the user opens them (per editor). */
export const PANE_DEFAULT_HIDDEN: Record<Editor, string[]> = { sch: ["peers", "comments", "appearance", "search", "netnav"], pcb: ["peers", "comments", "search"] };

export const FILTERS: Record<Editor, [string, string][]> = {
  sch: [["symbols", "Symbols"], ["pins", "Pins"], ["wires", "Wires"], ["labels", "Labels"], ["graphics", "Graphics"], ["images", "Images"], ["text", "Text"], ["other", "Other items"], ["ruleAreas", "Rule Areas"]],
  pcb: [["footprints", "Footprints"], ["text", "Text"], ["tracks", "Tracks"], ["vias", "Vias"], ["pads", "Pads"], ["graphics", "Graphics"], ["zones", "Zones"], ["keepouts", "Rule Areas"], ["dimensions", "Dimensions"], ["gridItems", "Grid Items"], ["points", "Points"], ["other", "Other items"]],
};

export const ZOOM_PRESETS = [10, 25, 50, 75, 100, 150, 200, 300, 500, 1000];
