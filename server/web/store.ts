// store.ts — the contract between the editor core (static/app.js) and the React chrome.
//
// app.js owns the document, the websocket, the canvas and pointer handling; it
// publishes what the chrome needs on `window.CollabApp` as a small observable
// store ({ getState, subscribe, dispatch }).  The chrome never mutates state:
// every user intent goes back through dispatch(action) and app.js updates the
// store, which re-renders whichever components selected the changed slice.
import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------- state slices
export type Editor = "sch" | "pcb";
export type DocType = "kicad_pcb" | "kicad_sch";
export type Units = "mm" | "in" | "mil";
export type ConnStatus = "offline" | "connecting" | "live" | "error" | "idle";

export interface User { id: number; login: string; name?: string | null; avatarUrl?: string | null }

export interface DocEntry { docId: string; path: string; docType: string; hasPreview?: boolean }

export interface ProjectInfo {
  projectId: string; name: string; ownerLogin: string; ownerId?: number;
  role?: string | null; docs: DocEntry[]; isPublic?: boolean;
}

/** A movable item (footprint / symbol) as app.js tracks it: positions in internal units. */
export interface ItemSummary {
  id: string; ref?: string; value?: string; lib?: string; layer?: string;
  x: number; y: number; rot?: number; bbox?: number[] | null;
}
export interface SheetSummary { id: string; name?: string; file: string; x: number; y: number; w: number; h: number }

export interface LayerRow { key: string; name: string; color: string; count: number }

export interface Peer { cid: string; name: string; color: string }

export interface Comment {
  id: number; parentId?: number | null; body: string; authorLogin: string; createdAt: string;
  resolved?: boolean; x: number; y: number;
}

export interface CheckpointGroup { name: string; at: string; docs: number }

/** A tool a module (CollabTools.sch / .pcb) registers: icon is inline SVG markup for a 24×24 stroke glyph. */
export interface ModuleTool { id: string; label: string; key?: string; icon?: string; cursor?: string }

/** A menu action a module publishes (CollabTools.<m>.actions); app.js runs it with the tool context. */
export interface ModuleAction { id: string; label: string; key?: string | null; menu?: string | null }

export interface RenderOpts {
  showHiddenPins?: boolean; highContrast?: boolean; outlinePads?: boolean; outlineVias?: boolean;
  outlineTracks?: boolean; zoneOutline?: boolean; activeLayer?: string;
}

export type PopoverKind = "desktop" | "about" | "share" | "kicad" | "find" | "grid";
export interface Anchor { left: number; top: number; right: number; bottom: number }
export interface PopoverState {
  kind: PopoverKind; anchor?: Anchor | null;
  title?: string; why?: string;          // desktop
  url?: string;                          // share
  hits?: number | null; query?: string;  // find
}

export interface AppState {
  view: "home" | "editor";
  me: User | null;
  project: ProjectInfo | null;
  role: string | null;
  canJoin: boolean;
  viewOnly: boolean;
  connection: { status: ConnStatus; text: string; edits: number };
  viewport: {
    zoom: number; cursor: [number, number]; origin: [number, number]; polar: boolean; units: Units;
    gridOn: boolean; gridPitch: number; gridChoices: [number, string][]; snapOn: boolean;
    crosshair: "small" | "full" | "45"; selMode: "rect" | "lasso";
    lineMode: "free" | "90" | "45" | null; dragMode: "drag" | "move" | null;
    renderOpts: RenderOpts; activeLayer: string;
  };
  document: {
    editor: Editor | null; docType: DocType | null; docId: string | null; doc: DocEntry | null;
    docs: DocEntry[]; rootDocId: string | null; sheets: SheetSummary[];
    layers: LayerRow[]; hiddenLayers: string[]; copperLayers: LayerRow[];
    items: ItemSummary[]; hasDoc: boolean; notice: string | null;
    /** bumped on every applied change (the Properties island and the Objects tab re-read on it) */
    version: number;
  };
  selection: { ids: string[]; primary: ItemSummary | null; field: { id: string; name: string } | null; version: number };
  peers: { list: Peer[]; follow: string | null };
  comments: Comment[];
  history: { groups: CheckpointGroup[]; loading: boolean; error: string | null };
  tool: { current: string; appTools: string[]; moduleTools: ModuleTool[]; moduleActions: ModuleAction[]; handled: string[] };
  /** KiCad toggle actions that are "on" (toggleGrid, togglePolarCoords, showProperties, …) */
  toggles: Record<string, boolean>;
  /** the current item of each split-button group ("Units" → "millimetersUnits") */
  groupCurrent: Record<string, string>;
  /** selection-filter categories that are enabled (missing = enabled) */
  filter: Record<string, boolean>;
  panes: Record<string, boolean>;
  undo: { undo: number; redo: number };
  status: { message: string; mode: string };
  toast: { id: number; text: string; ms: number } | null;
  popover: PopoverState | null;
}

// ---------------------------------------------------------------- actions (chrome → app.js)
export type AppAction =
  | { type: "action"; id: string; anchor?: Anchor | null }
  | { type: "setTool"; tool: string }
  | { type: "setGroupCurrent"; group: string; id: string }
  | { type: "showPane"; pane: string; show?: boolean }
  | { type: "openDoc"; docId: string }
  | { type: "enterSheet"; file: string }
  | { type: "setLayerVisible"; key: string; visible: boolean }
  | { type: "setActiveLayer"; layer: string }
  | { type: "setGrid"; pitch: number }
  | { type: "setZoom"; zoom: number | "auto" }
  | { type: "setFilter"; key: string; on: boolean }
  | { type: "follow"; cid: string | null }
  | { type: "openThread"; id: number }
  | { type: "selectItem"; id: string }
  | { type: "restore"; name: string }
  | { type: "find"; query: string }
  | { type: "popover"; popover: PopoverState | null }
  | { type: "toastDone"; id: number };

export interface CollabAppApi {
  getState(): AppState;
  subscribe(fn: (state: AppState) => void): () => void;
  dispatch(action: AppAction): void;
  /** Imperative island: draws the Properties panel (props.js) into `el` for the current selection. */
  renderProps(el: HTMLElement): void;
}

declare global {
  interface Window { CollabApp?: CollabAppApi }
}

// ---------------------------------------------------------------- React binding
const EMPTY: AppState = {
  view: "home", me: null, project: null, role: null, canJoin: false, viewOnly: true,
  connection: { status: "offline", text: "offline", edits: 0 },
  viewport: { zoom: 1, cursor: [0, 0], origin: [0, 0], polar: false, units: "mm", gridOn: true, gridPitch: 1.27, gridChoices: [], snapOn: true,
    crosshair: "small", selMode: "rect", lineMode: null, dragMode: null, renderOpts: {}, activeLayer: "" },
  document: { editor: null, docType: null, docId: null, doc: null, docs: [], rootDocId: null, sheets: [], layers: [], hiddenLayers: [], copperLayers: [], items: [], hasDoc: false, notice: null, version: 0 },
  selection: { ids: [], primary: null, field: null, version: 0 },
  peers: { list: [], follow: null }, comments: [], history: { groups: [], loading: false, error: null },
  tool: { current: "select", appTools: [], moduleTools: [], moduleActions: [], handled: [] },
  toggles: {}, groupCurrent: {}, filter: {}, panes: {}, undo: { undo: 0, redo: 0 }, status: { message: "", mode: "" }, toast: null, popover: null,
};

function app(): CollabAppApi | undefined { return window.CollabApp; }
function subscribe(fn: () => void): () => void { const a = app(); return a ? a.subscribe(fn) : () => {}; }
function getState(): AppState { const a = app(); return a ? a.getState() : EMPTY; }

/** Select a slice of the app state; the component re-renders when the selected value changes (Object.is). */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getState()), () => selector(EMPTY));
}
export function dispatch(action: AppAction): void { const a = app(); if (a) a.dispatch(action); }
export function anchorOf(el: Element | null | undefined): Anchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
