// editor/types.ts — shapes the editor modules share: the presence protocol (ws.rs / the desktop's
// collab tools), as this client sends it and reads it back from peers.  Type-only: no runtime code.

/** One peer's presence state; coordinates are internal units (nm). */
export interface PresenceState {
  cursor?: number[];
  /** [x, y, w, h] of what the peer is looking at */
  viewport?: number[];
  /** in-flight wire segments: x1, y1, x2, y2, width */
  ghost?: number[][];
  selection?: string[];
  /** BOX2I(origin, size) per selected id */
  boxes?: number[][];
  /** each selected item's anchor, paired with `selection` */
  at?: (number[] | null)[];
  sheetFile?: string;
  /** a schematic drag's stretched wires: uuid, x1, y1, x2, y2, width, layer */
  dragLines?: [string, number, number, number, number, number?, string?][];
  dragAdded?: string[];
}

export interface PeerUser { name?: string; login?: string; color?: string }

/** An entry of the presence map (E.peerState), keyed by client id. */
export interface PeerEntry { user?: PeerUser | null; state?: PresenceState | null }

/** Items a peer is dragging, drawn translucent where the peer holds them (drawCanvas). */
export interface PeerGhost { ids: Set<string>; dx: number; dy: number; hideOnly?: boolean }

/** A symbol / footprint as the editor lists it (E.items): positions in internal units. */
export type { ItemSummary } from "../store";
/** A hierarchical sheet on the open schematic (E.sheets): positions and size in internal units. */
export type SheetEntry = import("../store").SheetSummary & { page?: string };

/** A box / lasso selection in progress (E.boxSel). */
export interface BoxSel { start: number[]; cur: number[]; startClient: number[]; lasso?: boolean; pts: number[][]; add?: boolean; mode?: string }

/** One step on the undo / redo lists (tools.ts): what was applied and how to take it back. */
export interface UndoEntry {
  label: string; changes: KChange[]; inverse: KChange[];
  /** a tentative step's redo list, kept aside until it is placed or cancelled */
  heldRedo?: UndoEntry[];
  /** one commit over several sheets: the other sheets' undo / redo */
  undoOthers?(): void; redoOthers?(): void;
}

/** A change commit's options (tools.ts commitChanges). */
export interface CommitOpts { amend?: boolean; discard?: boolean; tentative?: boolean }

/** An op of ours the server has not acknowledged yet (E.pendingOps, keyed by clientOpId). */
export interface PendingOp { docId: string | null; changes: KChange[] }

/** A server `error` frame (ws.rs): its code, and for a refused op the op's id and our role. */
export interface ServerError { code?: string; clientOpId?: string; role?: string; docId?: string }

/** A change as it travels (net.ts / doc.ts applyChanges): an item change, or a document-level one (Page Settings). */
export type WireChange = KChange & { docProps?: { paper?: unknown; titleBlock?: unknown }; itemSexpr?: string };

/** One plot colour of the desktop-pushed SVG render (E.layers, keyed by the colour's hex). */
export interface SvgLayer { name: string; nodes: (HTMLElement | SVGElement)[]; visible: boolean }

/** What a menu entry or button hands its action: the clicked control, or its rectangle. */
export type ActionAnchor = Element | import("../store").Anchor | null | undefined;
/** A chrome action handler (actions.ts HANDLERS): the chrome passes the clicked control's rectangle; hotkeys pass nothing. */
export type ActionHandler = (anchor?: import("../store").Anchor | null) => unknown;
