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
  pcb: { selectSetRect: "select", selectSetLasso: "select", routeSingleTrack: "route", drawVia: "via", drawZone: "zone", drawRuleArea: "rulearea", drawLine: "gline", drawArc: "garc", drawRectangle: "grect",
    drawCircle: "gcircle", drawPolygon: "gpoly", drawBezier: "gcurve", placeReferenceImage: "image", placeText: "gtext", drawTextBox: "gtextbox", drawTable: "table",
    drawAlignedDimension: "dimaligned", drawOrthogonalDimension: "dimortho", drawCenterDimension: "dimcenter", drawRadialDimension: "dimradial", drawLeader: "leader",
    deleteTool: "delete", measureTool: "measure", zoomTool: "zoomtool" },
};
/** The collab tools app.js keeps at the foot of the draw toolbar. */
export const EXTRA_TOOLS: { id: string; tool: string; name: string; key: string; glyph: string }[] = [
  { id: "collabComment", tool: "comment", name: "Add comment", key: "C", glyph: "<path d='M4 5h16v11H9l-5 4z'/>" },
  { id: "collabFollow", tool: "follow", name: "Follow a collaborator", key: "", glyph: "<circle cx='12' cy='8' r='4'/><path d='M4 21a8 8 0 0116 0'/>" },
  { id: "pan", tool: "pan", name: "Pan the view", key: "H", glyph: "<path d='M8 13V6a1.5 1.5 0 013 0v5M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8a5 5 0 01-10 0v-2a1.5 1.5 0 013 0'/>" },
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

export type MenuEntry = string | [string, MenuEntry[]];
export const MENUS: Record<Editor, [string, MenuEntry[]][]> = {
  sch: [
    ["File", ["save", "-", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "-", "schematicSetup", "-", "pageSettings", "print", "plot", "-", "archive", "clone", "-", "openInKicad", "home"]],
    ["Edit", ["undo", "redo", "-", "cut", "copy", "paste", "doDelete", "-", "selectAll", "-", "find", "findAndReplace", "-", "deleteTool"]],
    ["View", [["Panels", ["showProperties", "showHierarchy", "showSelectionFilter", "showHistory", "showPeers", "showComments", "showAppearance"]], "-", "showSymbolBrowser", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomTool", "zoomRedraw", "-", "navigateBack", "navigateUp", "navigateForward", "-", "toggleHiddenPins", "toggleGrid", "-", "showHiddenText"]],
    ["Place", ["placeSymbol", "placePower", "drawWire", "drawBus", "placeBusWireEntry", "placeNoConnect", "placeJunction", "placeLabel", "placeGlobalLabel", "placeClassLabel", "drawRuleArea", "-", "placeHierLabel", "drawSheet", "placeSheetPin", "syncAllSheetsPins", "-", "placeSchematicText", "drawTextBox", "drawTable", "drawRectangle", "drawCircle", "drawArc", "drawBezier", "drawPolygon", "drawLines", "placeImage"]],
    ["Inspect", ["runERC", "clearMarkers", "-", "showSimulator"]],
    ["Tools", ["updatePcbFromSchematic", "showPcbNew", "-", "showSymbolEditor", "showFootprintEditor", "-", "annotate", "assignFootprints", "editSymbolFields", "generateBOM"]],
    ["Preferences", ["theme", "-", "openPreferences"]],
    ["Help", ["help", "gettingStarted", "-", "downloadDesktop", "sourceCode", "-", "about"]],
  ],
  pcb: [
    ["File", ["save", "-", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "-", "boardSetup", "-", "pageSettings", "print", "plot", "-", "archive", "clone", "-", "openInKicad", "home"]],
    ["Edit", ["undo", "redo", "-", "cut", "copy", "paste", "doDelete", "-", "selectAll", "-", "find", "-", "deleteTool"]],
    ["View", [["Panels", ["showLayersManager", "showProperties", "showSelectionFilter", "showHistory", "showPeers", "showComments"]], "-", "showFootprintBrowser", "show3DViewer", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomTool", "zoomRedraw", "-", "toggleGrid", "togglePolarCoords", "-", "showRatsnest", "highContrastMode", "zoneDisplayFilled", "zoneDisplayOutline", "padDisplayMode", "viaDisplayMode", "trackDisplayMode", "-", "showNetNames", "showPadNumbers", "showHiddenText", "zoneFillPreview", "flipBoard"]],
    ["Place", ["placeFootprint", "drawVia", "drawZone", "drawRuleArea", "-", "drawLine", "drawArc", "drawRectangle", "drawCircle", "drawPolygon", "drawBezier", "placeText", "drawTextBox", "drawTable", "-", "drawAlignedDimension", "drawOrthogonalDimension", "drawCenterDimension", "drawRadialDimension", "drawLeader", "-", "placeReferenceImage", "-", "gridSetOrigin", "drillOrigin"]],
    ["Route", ["routeSingleTrack", "routeDiffPair", "-", "tuneSingleTrack", "tuneDiffPair", "tuneSkew"]],
    ["Inspect", ["runDRC", "clearMarkers", "-", "netInspector", "boardStatistics", "inspectClearance", "-", "measureTool"]],
    ["Tools", ["updatePcbFromSchematic", "showEeschema", "-", "showFootprintEditor", "-", "editFootprintFields"]],
    ["Preferences", ["theme", "-", "openPreferences"]],
    ["Help", ["help", "gettingStarted", "-", "downloadDesktop", "sourceCode", "-", "about"]],
  ],
};
/** The menus that take a module's `actions` map (a module action names one of these in `menu`, default Edit). */
export const MODULE_ACTION_MENUS = ["Edit", "Tools", "Inspect"];

/** The project manager's bar (home view): the same entries the old markup carried. */
export const HOME_MENUS: [string, MenuEntry[]][] = [
  ["File", ["home", "share", "checkpoint", "-", "archive", "clone", "-", "kicad"]],
  ["View", ["zoomin", "zoomout", "fit", "-", "tab-appearance", "tab-props", "tab-peers", "tab-comments", "tab-history"]],
  ["Help", ["downloadDesktop", "sourceCode", "-", "about"]],
];

/** Labels for entries that are ours rather than KiCad TOOL_ACTIONs. */
export const LOCAL_LABELS: Record<string, string> = {
  save: "Save Checkpoint…", collabCopyLink: "Copy Share Link", collabComments: "Comments…", collabFollow: "Follow Next Peer", collabHistory: "History",
  collabLeave: "Leave Session", archive: "Download Project (.zip)", clone: "Clone to My Account", openInKicad: "Open in KiCad Collaborative…", home: "Back to Projects",
  showSelectionFilter: "Selection Filter", showHistory: "History", showPeers: "Collaborators", showComments: "Comments", showAppearance: "Appearance",
  showNetNames: "Show Net Names", showPadNumbers: "Show Pad Numbers", showHiddenText: "Show Hidden Text", zoneFillPreview: "Zone Fill Preview", flipBoard: "Flip Board View", clearMarkers: "Clear Markers",
  theme: "Toggle Dark Theme", downloadDesktop: "Download Desktop App ↗", sourceCode: "Source on GitHub ↗", about: "About KiCad Collaborative", help: "Help ↗", gettingStarted: "Getting Started with KiCad ↗",
  // home-view menu entries
  share: "Copy share link…", checkpoint: "Create checkpoint…", kicad: "Open in KiCad Collaborative…", zoomin: "Zoom in", zoomout: "Zoom out", fit: "Zoom to fit",
  "tab-appearance": "Layers", "tab-props": "Properties", "tab-peers": "Collaborators", "tab-comments": "Comments", "tab-history": "History",
};
export const LOCAL_KEYS: Record<string, string> = { zoomin: "+", zoomout: "−", fit: "F", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", selectAll: "Ctrl+A" };
/** External links among the menu entries (rendered as anchors). */
export const LINKS: Record<string, string> = {
  downloadDesktop: "https://github.com/notaroomba/kicad-collaborative/releases", sourceCode: "https://github.com/notaroomba/kicad-collaborative",
  help: "https://docs.kicad.org/", gettingStarted: "https://docs.kicad.org/master/en/getting_started_in_kicad/getting_started_in_kicad.html",
};

/** Docked pane ids and the KiCad "show …" action that toggles each. */
export const PANE_ACTION: Record<string, string> = { props: "showProperties", hier: "showHierarchy", filter: "showSelectionFilter", history: "showHistory", peers: "showPeers", comments: "showComments", appearance: "showLayersManager" };
export const PANE_TITLES: Record<string, string> = { props: "Properties", hier: "Schematic Hierarchy", filter: "Selection Filter", history: "History", peers: "Collaborators", comments: "Comments", appearance: "Appearance" };
/** Dock layout per editor: Properties · Hierarchy · Selection Filter · History left; the board keeps Appearance (with the filter below it) on the right. */
export const DOCKS: Record<Editor, { left: string[]; right: string[] }> = {
  sch: { left: ["props", "hier", "filter", "history", "peers", "comments", "appearance"], right: [] },
  pcb: { left: ["props", "history", "peers", "comments"], right: ["appearance", "filter"] },
};
/** Panes hidden until the user opens them (per editor). */
export const PANE_DEFAULT_HIDDEN: Record<Editor, string[]> = { sch: ["peers", "comments", "appearance"], pcb: ["peers", "comments"] };

export const FILTERS: Record<Editor, [string, string][]> = {
  sch: [["symbols", "Symbols"], ["pins", "Pins"], ["wires", "Wires"], ["labels", "Labels"], ["graphics", "Graphics"], ["images", "Images"], ["text", "Text"], ["other", "Other items"]],
  pcb: [["footprints", "Footprints"], ["text", "Text"], ["tracks", "Tracks"], ["vias", "Vias"], ["pads", "Pads"], ["graphics", "Graphics"], ["zones", "Zones"], ["dimensions", "Dimensions"], ["other", "Other items"]],
};

export const ZOOM_PRESETS = [10, 25, 50, 75, 100, 150, 200, 300, 500, 1000];
export const TRACK_WIDTHS = [0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1, 1.5, 2];
export const VIA_SIZES = [0.6, 0.8, 1, 1.2, 1.6];
