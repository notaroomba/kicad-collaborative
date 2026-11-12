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
export type DocType = "kicad_pcb" | "kicad_sch" | "footprint";
export type Units = "mm" | "in" | "mil";
export type ConnStatus = "offline" | "connecting" | "live" | "error" | "idle";

export interface User { id: number; login: string; name?: string | null; avatarUrl?: string | null }

export interface DocEntry { docId: string; path: string; docType: string; hasPreview?: boolean }

/** What a person may do on a project; `join` is the role an opened share link offers someone who is not a member yet. */
export interface ProjectCan { edit: boolean; comment: boolean; copy: boolean; share: boolean; manage: boolean; join?: string | null }
export interface ProjectInfo {
  projectId: string; name: string; ownerLogin: string; ownerId?: number;
  role?: string | null; docs: DocEntry[]; isPublic?: boolean;
  can?: ProjectCan; isOwner?: boolean; isMember?: boolean;
}

/** A movable item (footprint / symbol) as app.js tracks it: positions in internal units. */
export interface ItemSummary {
  id: string; ref?: string; value?: string; lib?: string; layer?: string;
  x: number; y: number; rot?: number; bbox?: number[] | null;
}
export interface SheetSummary { id: string; name?: string; file: string; x: number; y: number; w: number; h: number }

export interface LayerRow { key: string; name: string; color: string; count: number }

export interface Peer { cid: string; name: string; color: string }

/** What a comment thread is pinned to: a part or other item (by uuid) or a net (by name). */
export interface CommentAnchor { kind: "item" | "net"; id: string; label: string; item?: string | null }
export interface Comment {
  id: number; docId?: string; parentId?: number | null; body: string; authorId?: number; authorLogin: string; createdAt: string; editedAt?: string | null;
  resolved?: boolean; x: number; y: number; anchor?: CommentAnchor | null;
}
/** The threads of another document of the project (the Comments pane lists them under the open document's). */
export interface DocComments { docId: string; path: string; comments: Comment[] }

export interface CheckpointGroup { name: string; at: string; docs: number }

// ---- version history and branches (web/editor/versions.ts, server/src/versions.rs) ----
/** A document inside a kept version: its snapshot and the last op laid over it. */
export interface VersionDoc { docId: string; path: string; snapSeq: number; seq: number }
/** A point of the project's history that is kept for good.  `auto` ones the server kept by itself before a restore or a merge. */
export interface VersionInfo { id: string; name: string | null; description: string; kind: "named" | "auto"; createdAt: string; author: User | null; docs: VersionDoc[] }
/** One person working on one file without a long pause (or a restore / merge that rewrote it). */
export interface HistoryRun { docId: string; path: string; from: number; to: number; count: number; kind: "edit" | "restore" | "merge"; author: User; startedAt: string; endedAt: string }
export interface BranchInfo {
  projectId: string; name: string; description: string; createdAt: string; updatedAt: string; mergedAt: string | null;
  createdBy: User | null; ahead: number; behind: number; docs: DocEntry[];
}
/** A point in one document's history. */
export interface HistoryAt { docId: string; seq: number }
/** The earlier state on screen while the timeline is open. */
export interface HistoryView {
  docId: string; seq: number; head: number; floor: number; loading: boolean; playing: boolean; error: string | null;
  /** when that edit was made (ms) and by whom, once the document's edit index has loaded */
  at: number | null; who: string | null;
  /** the kept version that sits exactly here, if any */
  versionId: string | null;
  /** kept versions of this document, for the ticks on the scrubber */
  marks: { seq: number; name: string; named: boolean }[];
}
export type VersionDialog =
  | { kind: "save"; at?: HistoryAt }
  | { kind: "rename"; versionId: string; name: string; description: string }
  | { kind: "restore"; versionId?: string; at?: HistoryAt; label: string }
  | { kind: "deleteVersion"; versionId: string; label: string }
  | { kind: "branches" }
  | { kind: "newBranch"; versionId?: string; at?: HistoryAt; from: string }
  | { kind: "renameBranch"; projectId: string; name: string; description: string }
  | { kind: "deleteBranch"; projectId: string; name: string }
  | { kind: "merge"; projectId: string; name: string; direction: "into_main" | "from_main" };
export interface VersionsState {
  loading: boolean; error: string | null; busy: boolean;
  list: VersionInfo[]; runs: HistoryRun[];
  docs: { docId: string; path: string; docType: string; head: number; floor: number }[];
  branches: BranchInfo[]; main: { projectId: string; name: string } | null;
  /** set when the open project is a branch */
  parentId: string | null; branchName: string | null;
  view: HistoryView | null; dialog: VersionDialog | null;
}
export type VersionsCmd =
  | { cmd: "refresh" }
  | { cmd: "dialog"; dialog: VersionDialog | null }
  | { cmd: "view"; docId: string; seq: number }
  | { cmd: "viewVersion"; versionId: string }
  | { cmd: "step"; by: number }
  | { cmd: "play"; on: boolean }
  | { cmd: "exit" }
  | { cmd: "save"; name: string; description: string; at?: HistoryAt }
  | { cmd: "rename"; versionId: string; name: string; description: string }
  | { cmd: "delete"; versionId: string }
  | { cmd: "restore"; versionId?: string; at?: HistoryAt; label: string }
  | { cmd: "newBranch"; name: string; description: string; versionId?: string; at?: HistoryAt; open: boolean }
  | { cmd: "openBranch"; projectId: string }
  | { cmd: "renameBranch"; projectId: string; name: string; description: string }
  | { cmd: "deleteBranch"; projectId: string }
  | { cmd: "merge"; projectId: string; direction: "into_main" | "from_main"; replace: boolean; prefer: "incoming" | "current" }
  | { cmd: "compare" };

/** A tool a module (CollabTools.sch / .pcb) registers: icon is inline SVG markup for a 24×24 stroke glyph. */
export interface ModuleTool { id: string; label: string; key?: string; icon?: string; cursor?: string }

/** A menu action a module publishes (CollabTools.<m>.actions); app.js runs it with the tool context. */
export interface ModuleAction { id: string; label: string; key?: string | null; menu?: string | null }

export interface RenderOpts {
  showHiddenPins?: boolean; highContrast?: boolean; outlinePads?: boolean; outlineVias?: boolean;
  outlineTracks?: boolean; zoneOutline?: boolean; activeLayer?: string;
}

/** One enabled board layer for the active-layer selector: KiCad's name, the board's own label and the theme colour. */
export interface RoutingLayer { name: string; label: string; color: string; copper: boolean }
/** The board editor's routing controls (pcbnew's aux toolbar): the size choices, what is selected and the layer pair. */
export interface RoutingState {
  /** "Track: use netclass width", then one entry per pre-defined width — index = BOARD_DESIGN_SETTINGS::m_trackWidthIndex */
  trackLabels: string[]; trackIndex: number;
  viaLabels: string[]; viaIndex: number;
  layers: RoutingLayer[]; layerPair: [string, string];
}

export type PopoverKind = "desktop" | "about" | "share" | "kicad" | "find" | "grid";
export interface Anchor { left: number; top: number; right: number; bottom: number }
export interface PopoverState {
  kind: PopoverKind; anchor?: Anchor | null;
  title?: string; why?: string;          // desktop
  url?: string;                          // share
  hits?: number | null; query?: string;  // find
}

/**
 * One row of the right-click menu.  The editor (web/editor/contextmenu.ts) decides which rows KiCad would show
 * and whether each runs here; the chrome (components/ContextMenu.tsx) takes label, icon and hotkey from the
 * generated spec by the action's C++ name unless the row carries its own.
 */
export interface CtxItem {
  sep?: boolean;
  /** TOOL_ACTION name as in the C++ ("SCH_ACTIONS::rotateCCW") */
  act?: string;
  label?: string; icon?: string; key?: string;
  /** a check item, and whether it is ticked */
  check?: boolean; checked?: boolean;
  /** why the row is dimmed; absent when it runs here */
  why?: string;
  /** dispatch({ type: "contextMenu", run }) runs the row */
  run?: number;
  /** document item the row stands for: hovering the row brightens it (Clarify Selection) */
  hover?: string;
  sub?: CtxItem[];
}
export interface ContextMenuState { id: number; x: number; y: number; title?: string; items: CtxItem[] }

/** A footprint library of the project as the Libraries pane lists it. */
export interface FpLibRow { name: string; uri: string; footprints: { name: string; docId: string; path: string }[] }
export interface AppState {
  view: "home" | "editor";
  /** which page of the home view is showing, and a counter bumped on every visit (web/home) */
  homeTab?: "projects" | "explore" | "trash";
  homeTick?: number;
  me: User | null;
  project: ProjectInfo | null;
  role: string | null;
  canJoin: boolean;
  viewOnly: boolean;
  /** May write comments: the commenter role or more, signed in. */
  canComment: boolean;
  /** Not signed in: looking at a public project or through a share link. */
  guest: boolean;
  /** What the server says this person may do on the open project (server/src/access.rs). */
  can: ProjectCan | null;
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
  /** the comments on the project's other documents, and the thread whose card is open on the canvas */
  otherComments?: DocComments[];
  openThread?: number | null;
  history: { groups: CheckpointGroup[]; loading: boolean; error: string | null };
  versions: VersionsState;
  tool: { current: string; appTools: string[]; moduleTools: ModuleTool[]; moduleActions: ModuleAction[]; handled: string[] };
  /** KiCad toggle actions that are "on" (toggleGrid, togglePolarCoords, showProperties, …) */
  toggles: Record<string, boolean>;
  /** the current item of each split-button group ("Units" → "millimetersUnits") */
  groupCurrent: Record<string, string>;
  /** selection-filter categories that are enabled (missing = enabled) */
  filter: Record<string, boolean>;
  panes: Record<string, boolean>;
  undo: { undo: number; redo: number };
  /** the Footprint Editor (web/editor/fpedit.ts): the project's footprint libraries and the open footprint's title */
  fpLibs?: { libs: FpLibRow[]; current: string | null; version: number };
  fpTitle?: { label: string; modified: boolean; fromBoard: boolean };
  status: { message: string; mode: string };
  /** EDA_MSG_PANEL: the columns (title over value) of the selection's GetMsgPanelInfo, the board summary or the router */
  msgPanel: { items: { title: string; value: string }[] };
  toast: { id: number; text: string; ms: number } | null;
  popover: PopoverState | null;
  contextMenu: ContextMenuState | null;
  routing: RoutingState;
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
  | { type: "setTrackWidth"; index: number | "edit" }
  | { type: "setViaSize"; index: number | "edit" }
  | { type: "setGrid"; pitch: number }
  | { type: "setZoom"; zoom: number | "auto" }
  | { type: "setFilter"; key: string; on: boolean }
  | { type: "follow"; cid: string | null }
  | { type: "openThread"; id: number; docId?: string }
  /** start a comment thread on an item of the open document, or at a place (mm) */
  | { type: "commentOn"; itemId?: string; at?: [number, number]; body?: string }
  /** open the Compare window (web/review); a and b are VersionRefs, see web/review/sources.ts */
  | { type: "compare"; a?: unknown; b?: unknown; docId?: string }
  | { type: "selectItem"; id: string }
  | { type: "restore"; name: string }
  | ({ type: "versions" } & VersionsCmd)
  | { type: "find"; query: string }
  | { type: "popover"; popover: PopoverState | null }
  /** the right-click menu: run a row (then it closes), brighten a row's item, or just close */
  | { type: "contextMenu"; run?: number; hover?: string | null }
  | { type: "toastDone"; id: number };

export interface CollabAppApi {
  getState(): AppState;
  subscribe(fn: (state: AppState) => void): () => void;
  dispatch(action: AppAction): void;
  /** Imperative island: draws the Properties panel (props.js) into `el` for the current selection. */
  renderProps(el: HTMLElement): void;
  /** How many items are selected right now (the app's selection plus the tool module's own): menus grey out on 0. */
  selectionCount?(): number;
}

declare global {
  interface Window { CollabApp?: CollabAppApi }
}

// ---------------------------------------------------------------- React binding
const EMPTY: AppState = {
  view: "home", me: null, project: null, role: null, canJoin: false, viewOnly: true, canComment: false, guest: false, can: null,
  connection: { status: "offline", text: "offline", edits: 0 },
  viewport: { zoom: 1, cursor: [0, 0], origin: [0, 0], polar: false, units: "mm", gridOn: true, gridPitch: 1.27, gridChoices: [], snapOn: true,
    crosshair: "small", selMode: "rect", lineMode: null, dragMode: null, renderOpts: {}, activeLayer: "" },
  document: { editor: null, docType: null, docId: null, doc: null, docs: [], rootDocId: null, sheets: [], layers: [], hiddenLayers: [], copperLayers: [], items: [], hasDoc: false, notice: null, version: 0 },
  selection: { ids: [], primary: null, field: null, version: 0 },
  peers: { list: [], follow: null }, comments: [], history: { groups: [], loading: false, error: null },
  versions: { loading: false, error: null, busy: false, list: [], runs: [], docs: [], branches: [], main: null, parentId: null, branchName: null, view: null, dialog: null },
  tool: { current: "select", appTools: [], moduleTools: [], moduleActions: [], handled: [] },
  toggles: {}, groupCurrent: {}, filter: {}, panes: {}, undo: { undo: 0, redo: 0 }, status: { message: "", mode: "" }, msgPanel: { items: [] }, toast: null, popover: null, contextMenu: null,
  routing: { trackLabels: [], trackIndex: 0, viaLabels: [], viaIndex: 0, layers: [], layerPair: ["F.Cu", "B.Cu"] },
};

function app(): CollabAppApi | undefined { return window.CollabApp; }
function subscribe(fn: () => void): () => void { const a = app(); return a ? a.subscribe(fn) : () => {}; }
function getState(): AppState { const a = app(); return a ? a.getState() : EMPTY; }
/** The state right now, for a read that needs no subscription of its own. */
export const appState = getState;

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
