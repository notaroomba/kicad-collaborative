// sch-tools/types.ts — the shapes the schematic tools work with: points and boxes in mm, the editor
// context app.js hands every hook (its toolCtx() seam, plus the optional extras some callers add), and
// the module state S with the in-flight operations it holds.

/** A point in mm, [x, y] (a copy of a node's (at x y rot) may carry the angle as a third entry). */
export type Pt = number[];
/** A box in mm, [x0, y0, x1, y1]. */
export type Box = number[];
/** One atom or child list of an s-expression node. */
export type SAtom = SNode[number];
/** A node a builder makes: the keyword, then atoms and child lists. */
export type NodeOrNull = SNode | null;

/** A project document as the chrome lists it (ctx.docs). */
export interface SchDocEntry { docId: string; path: string; docType: string; [k: string]: unknown }

/** The clipboard bridge app.js may hand over: the system clipboard, read sync or async. */
export interface SchClipboard { set?(text: string): void; get?(): string | null | undefined; read?(): Promise<string | null | undefined> | null | undefined }

/** An ERC finding (app.js renders the markers). */
export interface ErcMarker { x: number; y: number; severity: string; text: string; ids: string[]; code: string; [k: string]: unknown }

/** The net-highlight engine the chrome registers (web/editor/schnets.ts). */
export interface NetHighlighter {
  highlightPick(ctx: SchCtx, pick: unknown): void;
  clear(ctx: SchCtx): void;
  active(): boolean;
  docChanged(ctx: SchCtx, sameDoc: boolean): void;
  wireDriverName?(wireId: string): string;
  labelDefaults?(): { textSize: number; intersheetRefsShow: boolean };
}

/** The context app.js hands every hook: its toolCtx(), with a document loaded, plus what some callers add. */
export interface SchCtx extends ToolCtx {
  doc: KDoc;
  /** grid snap of a point (any [x, y] the tools hold) */
  snap(mm: Pt): [number, number];
  /** the document's movable items (K.movableItems) */
  items: { id: string }[];
  docs: SchDocEntry[];
  project: { projectId?: string; name?: string } | null;
  api(path: string, opts?: RequestInit): Promise<Record<string, unknown>>;
  setSelection?(ids: Iterable<string>): void;
  clipboard?: SchClipboard;
  setMarkers?(markers: ErcMarker[]): void;
  /** Sheetfile (or docId / path) -> parsed doc or its text, for ERC and sheet pins. */
  sheetDocs?: Map<string, KDoc | string> | Record<string, KDoc | string>;
  parentSheetPins?: unknown;
  pageNumber?: number;
  docPath?: string;
  cursor?: Pt;
  warpCursor?(p: Pt): void;
}

/** One end of a net line that follows a drag: the line, which point, and its points before the drag. */
export interface LineEnd { item: KItem; index: number; orig: Pt[] }
/** An item riding on a dragged line (label, junction, entry, no-connect) and its position before the drag. */
export interface Rider { item: KItem; orig: Pt }
/** A connection point of the moved items: the line ends it stretches, the stub wire it grows, the no-connects it carries. */
export interface Anchor { p: Pt; ends: LineEnd[]; stub: { from: Pt; kind: string; split?: KItem } | null; followers: Rider[] }
/** A wire cut by Break / Slice: the part that keeps the start, the copy that runs on, and the cut point. */
export interface BreakCut { head: KItem; tail: KItem; p: Pt }
/** A Break / Slice in flight: the items it split on this client only, until the click that commits. */
export interface BreakJob { mode: string; label: string; orig: Map<string, SNode | null>; local: Set<string>; clicks: number }
/** S.drag: a connected drag (or move) of one item or a multi-selection. */
/**
 * A line selected by one end (SCH_MOVE_TOOL): that end moves; `attach` is what holds its other end (the
 * m_lineConnectionCache orthoLineDrag reads): the lines ending there, a junction, a pin or anything else.
 */
export interface PartialLine {
  item: KItem; index: number; orig: Pt[];
  attach?: { lines: LineEnd[]; junction: boolean; pin: boolean; any: boolean };
}
export interface SchDrag {
  items: { item: KItem; kind: string; orig: SNode }[];
  item: KItem; kind: string; orig: SNode | null;
  anchor0: Pt; grab: Pt; last: Pt; applied: Pt; moved: boolean; byPointer: boolean;
  riders: Rider[]; anchors: Anchor[]; preview: { kind: string; pts: Pt[] }[];
  /** "free" for a break's stretch */
  mode?: string;
  brk?: BreakJob;
  restoreMode?: string;
  /** SCH_DRAG_NET_COLLISION_MONITOR's state for this move */
  collision?: import("./collision").NetCollision | null;
  /** "undo" when Ctrl+Z ended it */
  cancel?: string;
  /** a paste / duplicate in flight: the ids of the items that only exist on this client */
  local?: Set<string>;
  pasted?: boolean; libs?: string[]; label?: string;
  /** the lines selected by one end only: SCH_MOVE_TOOL moves that end alone (index into the point list) */
  ends?: PartialLine[];
}
/** S.wire: the wire / bus / line being drawn. */
export interface SchWire { kind: string; segs: Pt[][]; cur: Pt; quitOnDraw: boolean; stroke: SNode | null }
/** S.carry: an item riding on the cursor until a click places it. */
export interface SchCarry { kind: string; node: SNode; item: KItem | null; pos: Pt | null; size?: Pt }
/** S.draw: a graphic shape being drawn (pts are the fixed clicks, cur the cursor); await while a dialog is up. */
export interface SchDraw {
  shape: string; pts: Pt[]; cur: Pt; await?: boolean;
  /** an arc: its ARC_GEOM_MANAGER, whether the first click happened, whether its start came from a tangent seed, the last click (nm) */
  arc?: import("../arc-geom").ArcGeom; started?: boolean; chainSeeded?: boolean; clickSeeded?: boolean; lastClick?: Pt;
}
/** The editable points of an item (point editor) and the segments between them. */
export interface EditPoints { pts: Pt[]; lines: number[][]; guides: number[][]; circles?: number[] }
/** An item that follows a point edit: a connected line end, a label or a no-connect on the edited point. */
export interface EditFollower { item: KItem; orig: SNode; end?: number; at?: Pt; index?: number }
/** S.pedit: a point-editor drag in flight. */
export interface PointEdit { item: KItem; ep: EditPoints; idx: number; orig: SNode; followers: EditFollower[]; start: Pt; moved: boolean; last: Pt;
  /** a reference image's transform origin offset when the edit began (REFERENCE_IMAGE::m_transformOriginOffset) */
  imgOrigin0?: Pt;
  /** the image's unrotated size (mm) when the edit began */
  imgSize0?: Pt }
/** S.sheetJob: a sheet file being created on the server. */
export interface SheetJob { doc: KDoc; promise: Promise<KItem | null> | null }
/** S.unfold: the label and entry a bus unfold placed while its wire is drawn. */
export interface UnfoldJob { labelId: string; entryId: string; origin: Pt; placed: boolean }
/** An item placed last, for Insert (repeat). */
export interface Placed { kind: string; node: SNode }

/** The module state: one in-progress operation at a time, plus a selection of our own. */
// a type alias rather than an interface: it is handed over as ToolModule.state, a Record<string, unknown>
export type SchState = {
  ctx: SchCtx | null; tool: string; wire: SchWire | null; carry: SchCarry | null; drag: SchDrag | null;
  pending: { item: KItem; mm: Pt } | null; sel: string | null; hover: string | null;
  cursor: Pt | null; cursorClient: Pt | null; prompt: HTMLElement | null; picker: HTMLElement | null; dom: boolean;
  draw: SchDraw | null; highlight: Set<string> | null; sheetJob: SheetJob | null; imageWait: boolean;
  pedit?: PointEdit | null;
  netHL?: NetHighlighter | null;
  dragMode: string; lineMode: string; posture: boolean;
  autoStartWires: boolean; autoPress?: { mm: Pt; client: Pt; mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } } | null; autoCursor?: string | null;
  dragEndedAt?: number; forceFollow?: boolean; internalSwitch?: boolean; multi?: Set<string> | null; otherRefs?: Iterable<string> | null;
  showDangling?: boolean; docGen: number;
  /** the lines selected by one end only (STARTPOINT / ENDPOINT): id -> that end's index, 0 start, 1 end */
  selEnds?: Map<string, number> | null;
  /** each reference image's transform origin offset from its centre (mm): REFERENCE_IMAGE keeps it in memory only */
  imgOrigin?: Map<string, Pt>;
  /** the modifier keys of the last pointer move (Shift turns the magnetic snap and its indicator off) */
  mods?: Mods | null;
  /** the stage cursor the drag-collision WARNING cursor replaced */
  collisionCursor?: string | null;
  labelQueue?: SNode[] | null;
  lastLabelShape?: string; lastFlagShape?: string; lastAutoRotate?: boolean; autoRotateIds?: Set<string>;
  lastTextH?: string; lastTextV?: string; lastTextBold?: boolean; lastTextItalic?: boolean; lastTextVertical?: boolean; lastTextSpin?: number;
  // commands
  markers: ErcMarker[]; markersDoc: KDoc | null; lastPlaced: Placed[] | null; repeatOffset: Pt; repeatIncrement: number;
  annotateAuto: boolean; unfold: UnfoldJob | null; docRef: KDoc | null;
};

/** The modifier keys of a pointer or key event (a synthetic one may carry only some). */
export interface Mods { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

/** The fields of a canvas geometry primitive the hit tests read (KGeom keeps them untyped). */
export interface SchGeom extends KGeom {
  x1: number; y1: number; x2: number; y2: number; pts: Pt[]; close?: boolean;
  x: number; y: number; r: number; w: number; h: number; a0: number; a1: number; anticlockwise?: boolean; noStroke?: boolean;
}

/** A line that is not in the document yet (a wire being drawn), for the junction analysis. */
export interface PreviewLine { kind: string; a: Pt; b: Pt }

/** What the tools read from a pointer event; a test (or a synthetic call) may hand over only some of it. */
export type PtrEvent = Partial<Pick<PointerEvent, "clientX" | "clientY" | "button" | "buttons" | "detail" | "pointerId" | "timeStamp" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">>;

/** The canvas geometry primitives the overlay repaints (KGeom keeps their fields untyped), by kind. */
interface PaintBase { w?: number; wd?: number; color: string; fill?: string; layer: string }
export type PaintGeom =
  | PaintBase & { t: "line"; x1: number; y1: number; x2: number; y2: number }
  | PaintBase & { t: "poly"; pts: Pt[]; close?: boolean }
  | PaintBase & { t: "circle"; x: number; y: number; r: number }
  | PaintBase & { t: "arc"; x: number; y: number; r: number; a0: number; a1: number; anticlockwise?: boolean }
  | PaintBase & { t: "rect"; x: number; y: number; w: number; h: number }
  | PaintBase & { t: "text"; x: number; y: number; rot?: number; size: number; h: CanvasTextAlign; v: string; text: string };
