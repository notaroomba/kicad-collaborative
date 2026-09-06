// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
// KiCad's default colour theme, so plotted colours map back to layer names.
export const KICAD_LAYERS = {
  C83434: "F.Cu", "4D7FC4": "B.Cu", C2C200: "In1.Cu", C200C2: "In2.Cu", C20000: "In3.Cu", "00C2C2": "In4.Cu",
  F2EDA1: "F.SilkS", E8B2A7: "B.SilkS", D864FF: "F.Mask", "02FFEE": "B.Mask", A4A4A4: "F.Paste", "00C2C2 ": "B.Paste",
  AFAFAF: "F.Fab", "585D84": "B.Fab", FF26E2: "F.CrtYd", "26E9FF": "B.CrtYd", D0D2CD: "Edge.Cuts",
  C2C2C2: "Dwgs.User", "5959C9": "Cmts.User", B2B2B2: "Eco1.User", "6A6A6A": "Eco2.User", FFC000: "Pads (TH)",
  ECECEC: "Vias", "000000": "Background", FFFFFF: "Page",
};


export const SCH_LAYERS = {
  "009600": "Wires", "0000C2": "Buses & no-connects", "000084": "Junctions", "840000": "Symbol outlines & pins",
  A90000: "Pin numbers", "006464": "Pin names & fields", "840084": "Hierarchical labels", C80000: "Global labels",
  "000000": "Text & local labels", "0F0F0F": "Notes", FFFFC2: "Symbol fills", F5F4EF: "Sheet background",
  "808080": "Drawing sheet", "8A0000": "Sheet outlines", "00C000": "Wires", "0000FF": "Buses", "008080": "Fields",
  "800000": "Symbol outlines", "800080": "Sheets", FFFFFF: "Background",
};


export const state = {
  me: null,            // {id, login, name, avatarUrl}
  view: "home",
  homeTab: "recent",
  project: null,       // /info payload
  docId: null,
  role: null,
};


// ---------- observable store: what the React chrome renders from ----------
// Slices are replaced, never mutated, so subscribers can compare by identity.  The
// shape is typed in server/web/store.ts (AppState) — keep the two in step.
export const APP_TOOLS = ["select", "pan", "comment", "follow", "zoomtool", "measure"];

export const store = (() => {
  let S = {
    view: "home", me: null, project: null, role: null, canJoin: false, viewOnly: true,
    connection: { status: "offline", text: "offline", edits: 0 },
    viewport: { zoom: 1, cursor: [0, 0], origin: [0, 0], polar: false, units: "mm", gridOn: true, gridPitch: 1.27, gridChoices: [], snapOn: true,
      crosshair: "small", selMode: "rect", lineMode: null, dragMode: null, renderOpts: {}, activeLayer: "" },
    document: { editor: null, docType: null, docId: null, doc: null, docs: [], rootDocId: null, sheets: [], layers: [], hiddenLayers: [], copperLayers: [], items: [], hasDoc: false, notice: null, version: 0 },
    selection: { ids: [], primary: null, field: null, version: 0 },
    peers: { list: [], follow: null }, comments: [], history: { groups: [], loading: false, error: null },
    tool: { current: "select", appTools: APP_TOOLS, moduleTools: [], moduleActions: [], handled: [] },
    toggles: {}, groupCurrent: {}, filter: {}, panes: {}, undo: { undo: 0, redo: 0 }, status: { message: "", mode: "" }, toast: null, popover: null,
  };
  const subs = new Set();
  const notify = () => { for (const fn of Array.from(subs)) { try { fn(S); } catch (e) { console.warn(e); } } };
  return {
    get: () => S,
    set(patch) { S = Object.assign({}, S, patch); notify(); },
    slice(key, patch) { S = Object.assign({}, S, { [key]: Object.assign({}, S[key], patch) }); notify(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
})();

export const setStatusBar = (f) => store.slice("status", f);
                      // { message, mode }
export const setToggles = (map) => store.set({ toggles: Object.assign({}, store.get().toggles, map) });

export const setToggle = (id, on) => setToggles({ [id]: !!on });

export const setGroupCurrent = (group, id) => store.set({ groupCurrent: Object.assign({}, store.get().groupCurrent, { [group]: id }) });

export const RADIO = { Units: ["millimetersUnits", "inchesUnits", "milsUnits"], "Crosshair modes": ["cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs"],
  "Line modes": ["lineModeFree", "lineMode90", "lineMode45"], "Selection modes": ["selectSetRect", "selectSetLasso"] };
