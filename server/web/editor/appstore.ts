// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
import type { AppState, DocEntry, ProjectInfo, User } from "../store";

// KiCad's default colour theme, so plotted colours map back to layer names.
export const KICAD_LAYERS: Record<string, string> = {
  C83434: "F.Cu", "4D7FC4": "B.Cu", C2C200: "In1.Cu", C200C2: "In2.Cu", C20000: "In3.Cu", "00C2C2": "In4.Cu",
  F2EDA1: "F.SilkS", E8B2A7: "B.SilkS", D864FF: "F.Mask", "02FFEE": "B.Mask", A4A4A4: "F.Paste", "00C2C2 ": "B.Paste",
  AFAFAF: "F.Fab", "585D84": "B.Fab", FF26E2: "F.CrtYd", "26E9FF": "B.CrtYd", D0D2CD: "Edge.Cuts",
  C2C2C2: "Dwgs.User", "5959C9": "Cmts.User", B2B2B2: "Eco1.User", "6A6A6A": "Eco2.User", FFC000: "Pads (TH)",
  ECECEC: "Vias", "000000": "Background", FFFFFF: "Page",
};


export const SCH_LAYERS: Record<string, string> = {
  "009600": "Wires", "0000C2": "Buses & no-connects", "000084": "Junctions", "840000": "Symbol outlines & pins",
  A90000: "Pin numbers", "006464": "Pin names & fields", "840084": "Hierarchical labels", C80000: "Global labels",
  "000000": "Text & local labels", "0F0F0F": "Notes", FFFFC2: "Symbol fills", F5F4EF: "Sheet background",
  "808080": "Drawing sheet", "8A0000": "Sheet outlines", "00C000": "Wires", "0000FF": "Buses", "008080": "Fields",
  "800000": "Symbol outlines", "800080": "Sheets", FFFFFF: "Background",
};


/** The router's own state: who is signed in, the view and home tab, the open project and the caller's role on it. */
export interface RouterState {
  me: User | null; view: string; homeTab: NonNullable<AppState["homeTab"]>; project: ProjectInfo | null; docId: string | null; role?: string | null;
  /** the open project's documents and the open one (set by doc.ts once a project loads) */
  docs?: DocEntry[]; doc?: DocEntry | null;
  /** Never assigned on the router state: tools.ts setSelection reads it and so always starts the version from 0. */
  selection?: { version?: number };
}
export const state: RouterState = {
  me: null,            // {id, login, name, avatarUrl}
  view: "home",
  homeTab: "projects",
  project: null,       // /info payload
  docId: null,
  role: null,
};


// ---------- observable store: what the React chrome renders from ----------
// Slices are replaced, never mutated, so subscribers can compare by identity.  The
// shape is typed in server/web/store.ts (AppState) — keep the two in step.
export const APP_TOOLS = ["select", "pan", "comment", "follow", "zoomtool", "measure"];

export const store = (() => {
  let S: AppState = {
    view: "home", homeTab: "projects", homeTick: 0, me: null, project: null, role: null, canJoin: false, viewOnly: true, canComment: false, guest: false, can: null,
    connection: { status: "offline", text: "offline", edits: 0 },
    viewport: { zoom: 1, cursor: [0, 0], origin: [0, 0], polar: false, units: "mm", lastImperial: "mil", kzoom: 1, gridOn: true, gridPitch: 1.27, gridChoices: [], snapOn: true,
      crosshair: "small", selMode: "rect", lineMode: null, dragMode: null, renderOpts: {}, activeLayer: "" },
    document: { editor: null, docType: null, docId: null, doc: null, docs: [], rootDocId: null, sheets: [], layers: [], hiddenLayers: [], copperLayers: [], items: [], hasDoc: false, notice: null, version: 0 },
    selection: { ids: [], primary: null, field: null, version: 0 },
    peers: { list: [], follow: null }, comments: [], otherComments: [], openThread: null, history: { groups: [], loading: false, error: null },
    versions: { loading: false, error: null, busy: false, list: [], runs: [], docs: [], branches: [], main: null, parentId: null, branchName: null, view: null, dialog: null },   // version history and branches (editor/versions.ts)
    tool: { current: "select", appTools: APP_TOOLS, moduleTools: [], moduleActions: [], handled: [] },
    // the board's net names and pad numbers are on by default (pcbnew "pcb_display.net_names_mode" 3), so their checks start on
    toggles: { showNetNames: true, showPadNumbers: true }, groupCurrent: {}, filter: {}, panes: {}, undo: { undo: 0, redo: 0 }, status: { message: "", mode: "" }, msgPanel: { items: [] }, toast: null, popover: null, contextMenu: null,
    routing: { trackLabels: [], trackIndex: 0, viaLabels: [], viaIndex: 0, layers: [], layerPair: ["F.Cu", "B.Cu"] },   // the board's size selectors (editor/pcbrouting.ts)
  };
  const subs = new Set<(s: AppState) => void>();
  const notify = () => { for (const fn of Array.from(subs)) { try { fn(S); } catch (e) { console.warn(e); } } };
  return {
    get: () => S,
    set(patch: Partial<AppState>) { S = Object.assign({}, S, patch); notify(); },
    slice<K extends keyof AppState>(key: K, patch: Partial<AppState[K]>) { S = Object.assign({}, S, { [key]: Object.assign({}, S[key], patch) }); notify(); },
    subscribe(fn: (s: AppState) => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
})();

export const setStatusBar = (f: Partial<AppState["status"]>) => store.slice("status", f);
                      // { message, mode }
export const setToggles = (map: Record<string, boolean>) => store.set({ toggles: Object.assign({}, store.get().toggles, map) });

export const setToggle = (id: string, on: unknown) => setToggles({ [id]: !!on });

export const setGroupCurrent = (group: string, id: string) => store.set({ groupCurrent: Object.assign({}, store.get().groupCurrent, { [group]: id }) });

export const RADIO: Record<string, string[]> = { Units: ["millimetersUnits", "inchesUnits", "milsUnits"], "Crosshair modes": ["cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs"],
  "Line modes": ["lineModeFree", "lineMode90", "lineMode45"], "Selection modes": ["selectSetRect", "selectSetLasso"] };
