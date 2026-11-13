// panels-api.ts — the contract between the docked panels (React, web/components/panes) and the
// editor bundle's panel models (web/editor/panels/*).  The editor publishes `window.CollabPanels`:
// a small observable store with the Appearance state, the hierarchy tree and the net navigator,
// plus on-demand models (the property grid of the selection, search rows) and one dispatch() for
// every panel intent.  Types only: both bundles import this file, neither imports the other.

// ---------------------------------------------------------------- Appearance (pcbnew/widgets/appearance_controls.cpp)
export interface LayerInfo { key: string; name: string; color: string; defaultColor: string; visible: boolean; copper: boolean; tip: string }

/** One row of the Objects tab (APPEARANCE_SETTING); a spacer row has only `spacer`. */
export interface ObjectRow { id: string; label: string; tip: string; spacer?: boolean; visible?: boolean; opacity?: number; canHide?: boolean }

export interface NetRow { name: string; code: number; color: string | null; visible: boolean; netclass: string }
export interface NetClassRow { name: string; color: string | null; visible: boolean }

export type InactiveMode = "normal" | "dim" | "hide";
export type NetColorMode = "all" | "ratsnest" | "off";
export type RatsnestMode = "all" | "visible" | "none";

export interface AppearanceState {
  layers: LayerInfo[]; active: string;
  objects: ObjectRow[];
  nets: NetRow[]; netClasses: NetClassRow[];
  inactive: InactiveMode; flip: boolean; netColorMode: NetColorMode; ratsnestMode: RatsnestMode;
  /** built-in presets first, then the user's; `preset` is the one the current visibility matches (null = unsaved) */
  presets: string[]; builtinPresets: string[]; preset: string | null;
  viewports: string[]; viewport: string | null;
}

export type LayerMenuCmd = "showAllCu" | "hideAllCu" | "hideAllButActive" | "showAllNonCu" | "hideAllNonCu" | "showAll" | "hideAll"
  | "frontAssembly" | "front" | "inner" | "back" | "backAssembly";
export type NetCmd = "highlight" | "select" | "unselect" | "showAll" | "hideOthers";

// ---------------------------------------------------------------- Properties (PROPERTIES_PANEL / PROPERTY_MANAGER)
export type PropType = "text" | "longtext" | "length" | "coord" | "angle" | "time" | "number" | "int" | "bool" | "enum" | "color";
export interface PropRow {
  /** stable id: "<group>/<name>" */
  id: string; name: string; type: PropType;
  /** display text in the current units ("" when mixed); booleans are "1" / "0" */
  value: string; mixed: boolean; readOnly: boolean;
  choices?: [string, string][];
  /** the name may be edited in the label column (a footprint's own field, a custom property) */
  keyEditable?: boolean;
}
/** add: the category's "+" button and context-menu entry ("Add Field", "Add Custom Property") */
export interface PropGroup { name: string; rows: PropRow[]; add?: "Add Field" | "Add Custom Property" }
export interface PropGrid {
  /** the caption line: "Footprint R1", "3 items selected", "No objects selected" */
  title: string; count: number; groups: PropGroup[]; readOnly: boolean; note?: string;
}

// ---------------------------------------------------------------- Search (SEARCH_PANE and its handlers)
export interface SearchTab { id: string; label: string; columns: string[] }
export interface SearchRow { key: string; ids: string[]; cells: string[]; docId?: string }
export interface SearchResult { tab: string; rows: SearchRow[]; total: number }

// ---------------------------------------------------------------- Hierarchy (HIERARCHY_PANE)
export interface HierNode {
  /** sheet path of uuids ("/" for the root) */
  path: string; name: string; page: string; docId: string | null; file: string;
  /** the document holding this sheet's (sheet …) symbol and that symbol's uuid (null for the root) */
  parentDocId: string | null; sheetId: string | null;
  current: boolean; children: HierNode[];
}

// ---------------------------------------------------------------- Net navigator (eeschema/net_navigator.cpp)
export interface NetNavNode { key: string; label: string; ids?: string[]; children?: NetNavNode[]; bold?: boolean; /** starts folded (wxTreeCtrl nodes are collapsed until expanded) */ collapsed?: boolean }
export interface NetNavState { root: NetNavNode | null; version: number; selected?: string | null; filter?: string; filterEnabled?: boolean; wildcard?: boolean }

// ---------------------------------------------------------------- the store
export interface PanelsState {
  appearance: AppearanceState;
  hierarchy: { root: HierNode | null; version: number };
  netNav: NetNavState;
  /** bumped when the selection (the app's or a tool module's) or the units change: the Properties pane re-reads */
  selVersion: number;
}

export type PanelAction =
  | { t: "layerVisible"; key: string; on: boolean }
  | { t: "layerActive"; key: string }
  | { t: "layerColor"; key: string; color: string | null }
  | { t: "layerMenu"; cmd: LayerMenuCmd }
  | { t: "objVisible"; id: string; on: boolean }
  | { t: "objOpacity"; id: string; value: number }
  | { t: "inactive"; mode: InactiveMode }
  | { t: "flip"; on: boolean }
  | { t: "netVisible"; name: string; on: boolean }
  | { t: "netColor"; name: string; color: string | null }
  | { t: "netCmd"; cmd: NetCmd; name: string }
  | { t: "classVisible"; name: string; on: boolean }
  | { t: "classColor"; name: string; color: string | null }
  | { t: "classCmd"; cmd: NetCmd; name: string }
  | { t: "netColorMode"; mode: NetColorMode }
  | { t: "ratsnestMode"; mode: RatsnestMode }
  | { t: "preset"; name: string }
  | { t: "presetSave" } | { t: "presetDelete" }
  | { t: "viewport"; name: string }
  | { t: "viewportSave" } | { t: "viewportDelete" }
  | { t: "hierOpen"; path: string }
  | { t: "hierRename"; path: string }
  | { t: "hierPage"; path: string }
  | { t: "searchSelect"; row: SearchRow; zoom: boolean }
  | { t: "netNavSelect"; ids: string[]; key?: string }
  | { t: "netNavFilter"; text?: string; wildcard?: boolean }
  | { t: "netNavRefresh" };

export interface PanelsApi {
  getState(): PanelsState;
  subscribe(fn: () => void): () => void;
  dispatch(a: PanelAction): void;
  /** The property grid of the current selection. */
  propGrid(): PropGrid;
  /** Commit one property for every selected item; returns an error text (shown under the row) or null. */
  setProp(id: string, text: string): string | null;
  /** Rename a row's property (label column edit); `pending`: the row was just added and goes again if left blank. */
  renamePropKey(id: string, name: string, pending: boolean): boolean;
  /** Add a blank field / custom property to the selection; the new row's id. */
  addPropKey(kind: "field" | "custom"): string | null;
  /** Remove a footprint field or a custom property from the selection. */
  removePropKey(id: string): boolean;
  searchTabs(): SearchTab[];
  search(tab: string, query: string): SearchResult;
}

declare global {
  interface Window { CollabPanels?: PanelsApi }
}
