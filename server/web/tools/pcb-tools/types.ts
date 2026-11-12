// pcb-tools/types.ts — the shapes the board tools work with: points and boxes in mm, the editor context
// app.js hands every hook (its toolCtx() seam, plus what some callers add), the router's, dragger's and
// drawing tools' in-flight state, and the module state S that holds them.

/** A point (or a vector) in mm, [x, y]. */
export type Pt = number[];
/** A box in mm, [x0, y0, x1, y1]. */
export type Box = number[];
/** One atom or child list of an s-expression node. */
export type SAtom = SNode[number];

/** A net as an item references it: (net 3 "GND") gives { code: 3, name: "GND" }, (net "GND") code -1, none code 0. */
export interface NetRef { code: number; name: string }

/** What the tools read from a pointer event; a test (or a synthetic call) may hand over only some of it. */
export type PtrEvent = Partial<Pick<PointerEvent, "clientX" | "clientY" | "button" | "buttons" | "detail" | "pointerId" | "timeStamp" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "pointerType">>;

/** A board document; a route's branch (branchDoc) carries its own caches under __bc, and the board it branched from. */
export type BoardDoc = KDoc & { __bc?: BranchCache; __base?: BoardDoc; __stale?: number };
/** A branch's caches (the router's world, the dragger's joints, the netlist, the shove worlds by key). */
export interface BranchCache { rworld?: RouterWorld; joints?: Joints; nl?: Netlist; [shoveKey: string]: ShoveWorld | RouterWorld | Joints | Netlist | undefined }

/** The context app.js hands every hook: its toolCtx(), with a board loaded, plus what some callers add. */
export interface PcbCtx extends ToolCtx {
  doc: BoardDoc;
  /** PCB_TOOL_BASE::m_isFootprintEditor: the document is one footprint (canvas/footprint-doc.ts) */
  fpEditor?: boolean;
  /** grid snap of a point (any [x, y] the tools hold) */
  snap(mm: Pt): [number, number];
  /** the project's design settings (.kicad_pro as text or parsed, a legacy board's (setup …), or our shape) */
  designSettings?: string | DesignSource | DesignSettings | null;
  /** the project's .kicad_dru text (custom rules) */
  customRules?: string | null;
  /** where the pointer is (paste, the array tool) */
  cursor?: Pt | null;
  /** the clipboard bridge app.js may hand over */
  /** commit with the editor's options (tentative: a paste or duplicate that rides the cursor until placed; discard: an amend that drops it again) */
  commit(changes: KChange[], label?: string, opts?: { amend?: boolean; tentative?: boolean; discard?: boolean }): void;
  clipboard?: { set?(text: string): void; get?(): string | null | undefined | Promise<string | null | undefined> };
  /** the editor's selection seam (app.js owns the whole selection when it hands this over) */
  setSelection?(ids: Iterable<string>): void;
  /** the items under a point, for the selection clarification */
  candidatesAt?(mm: Pt): string[] | null;
  /** the clarification menu: picks one of the candidates, then calls back with a context for it (or null) */
  clarify?(cands: string[], done: (fresh: PcbCtx | null) => void): void;
  /** hand a drag the editor started to the module's move session */
  handoffDrag?(): unknown;
  /** the toolbar group's shown action (the Arc group follows the arc drawing mode) */
  setGroupCurrent?(group: string, action: string): void;
}

/** A pad as kicad-canvas' padAt reports it: the footprint, the pad's index among its (pad …) children, its node and net. */
export interface CanvasPadHit { item: KItem; index: number; pad: SNode | null; number: string; net: number; netName: string; x: number; y: number }

/** kicad-canvas.js as the board tools use it: the tools' view plus the board helpers it exports. */
export interface PcbCanvasApi extends ToolsCanvasApi {
  /** the (members …) of a group or generator */
  groupMemberIds(node: SNode): string[];
  /** whether a geometry primitive is within tol of (x, y) */
  geomHit(g: KGeom, x: number, y: number, tol: number): boolean;
  /** a geometry primitive's box, null for one without extent */
  geomBox(g: KGeom): Box | null;
  /** the smallest pad under (x, y) */
  padAt(doc: KDoc, x: number, y: number): CanvasPadHit | null;
  /** the geometry of an item (sets item.geom and item.bbox) */
  buildGeom(doc: Pick<KDoc, "type" | "items" | "layers" | "copper">, item: KItem): void;
  drawTextStroke(c: CanvasRenderingContext2D, g: KGeom, minW: number, color: string | CanvasGradient | CanvasPattern, base: number[], flip: boolean, bgColor?: string): void;
  drawMarkers(c: CanvasRenderingContext2D, markers: unknown[], docType: string, scale: number, bg: string): void;
  markerScale(docType: string, view: KView): number;
  /** moves a table's cells by (dx, dy) */
  shiftTable(node: SNode, dx: number, dy: number): void;
  PCB_BG: string;
}

/** Board Setup > Text & Graphics > Defaults as the project file stores it (board.design_settings.defaults). */
export interface DesignDefaults {
  dimension_units?: unknown; dimension_precision?: unknown;
  dimensions?: { units_format?: unknown; text_position?: unknown; suppress_zeroes?: unknown; keep_text_aligned?: unknown; arrow_length?: unknown; extension_offset?: unknown };
  /** <class>_line_width, <class>_text_size_h, <class>_text_thickness */
  [k: string]: unknown;
}

/** A change as the board tools send it: the canvas' item change plus what the desktop needs to re-resolve nets and groups. */
export interface PcbChange extends KChange { netName?: string; groupMembers?: string[]; padNets?: Record<string, string> }

/** A footprint's pad with its absolute centre (padsOf). */
export interface PadInfo { x: number; y: number; rot: number; w: number; h: number; off: number[]; net: NetRef; layers: string[]; number: string; type: string; shape: string; node: SNode; index: number }

/** The fields of a canvas geometry primitive the tools read (KGeom keeps them untyped). */
export interface PcbGeom extends KGeom {
  x1: number; y1: number; x2: number; y2: number; pts: Pt[]; close?: boolean; fill?: boolean | string;
  x: number; y: number; r: number; w: number; h: number; a0: number; a1: number; anticlockwise?: boolean; rot?: number;
  pad?: boolean; hole?: boolean; padIndex?: number; net?: number; netName?: string; text?: string; size?: number;
}

/** A magnetic target under the cursor (snapTarget): a pad, via, track end or the body of a routed-net track. */
export interface SnapHit { x: number; y: number; net: NetRef; kind: string; fp?: string; padIndex?: number; id?: string; layers?: string[] | null }

/** One element of a track line: a straight segment or a three-point arc. */
export type TrackElem = { t: "seg"; a: Pt; b: Pt; m?: undefined } | { t: "arc"; a: Pt; m: Pt; b: Pt };

/** The modifier keys a pointer step carries. */
export interface Mods { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
/** What the cursor resolves to (hoverPoint): the snapped point, and the anchor / pad / via / track end it snapped to. */
export interface Hover { x: number; y: number; snap: SnapHit | { x: number; y: number; kind: string; net?: undefined } | null; del?: KItem | null }

/** The module state: one in-progress operation at a time, plus a selection of our own. */
// a type alias rather than an interface: it is handed over as ToolModule.state, a Record<string, unknown>
export type PcbState = {
  layer: string; gfxLayer: string;
  sel: Set<string>;
  /** a pad picked on its own, "footprintId#padIndex" (PCB_SELECTION_TOOL selects PCB_PAD_T) */
  padSel: string | null;
  /** Pads picked with Shift before the one in padSel (KiCad adds to the selection); they count while `anchor` is still padSel. */
  padAlso: { anchor: string; keys: string[] } | null;
  /** the Footprint Editor's Add Pad tools: the pad type being placed and its turn (R), and the pad selected when the tool started */
  padPlace?: { type: import("./pad-tool").PadType; angle: number } | null; padTemplate?: SNode | null;
  pedit: PointEdit | null; mmPerPx: number;
  route: Route | null; drag: TrackDrag | null; draw: DrawState | null; hover: Hover | null;
  text: { box: HTMLElement } | null; modTool: string | null; doc: BoardDoc | null;
  /** the picked reference image riding the cursor */
  image: RefImage | null;
  /** last pointer position in client px, where prompts open */
  client: Pt | null;
  /** the last DRC run's markers */
  markers: DrcMarker[];
  showRatsnest: boolean; localRatsnest: boolean; hiddenNets: Set<string>; rats: { doc: BoardDoc; lines: RatsnestLine[] } | null; ratsDirty: boolean;
  settings: DesignSettings | null; settingsSrc: unknown; settingsCache: DesignSettings | null; druSrc?: string | null; highlightNet: string | null;
  /** the router's caches (per document change) and the obstacles shown in violation */
  docVer: number; rworld: RouterWorld | null; nlc: { doc: BoardDoc; ver: number; nl: Netlist } | null; violations: { obs: Obstacle[]; at: Pt } | null;
  /** the length tuner: the pattern being placed, the track under the cursor */
  tune: { pattern: TunePattern | null; picker: TunePicker | null; cursor: Pt | null };
  // set by the later sections
  rs: import("./router-settings").RouterSettings; tuneSettings: { single: MeanderSettings; diffpair: MeanderSettings; skew: MeanderSettings };
  genEdit?: import("./tuning-edit").GenEdit | null;
  /** the board's custom rules for the tuner: a length / skew constraint on the pattern's tracks ({ text, name, min, opt, max } in mm) */
  ruleConstraint?: ((doc: BoardDoc, what: string, a: KItem | null, b: KItem | null) => { text: string; name: string; min: number | null; opt: number | null; max: number | null; severity?: string | null } | null) | null;
  /** the project's custom rules (.kicad_dru), parsed */
  dru?: { rules: import("./dru").DruRule[]; errors: string[] } | null;
  /** rule-resolver: the rules with a clearance-type constraint, for the parsed dru they came from */
  routerRulesFor?: unknown; routerRulesList?: import("./dru").DruRule[] | null;
  /** the board the shove world was last built for (its clearance queries resolve rules against it) */
  shoveDoc?: BoardDoc | null;
  move?: SelectMove | null; pending?: PendingDrag | null; sworld?: { doc: BoardDoc; ver: number; key: string; w: ShoveWorld } | null;
  joints?: Joints; strokeW?: number | null; pick?: { done: (res: Pt | KItem | null) => void; prompt: string } | null; popup?: { text: string; at: Pt; until: number } | null;
  drawRaw?: Pt; drawCtrl?: boolean; cursorBefore?: string; ratsnestColors?: Map<string, string> | null; hiddenSeverities?: Set<string> | null;
  arcMode?: number; arcEditMode?: number; angleSnap?: string; stickyUp?: boolean; startWithVia?: { from: string } | null;
  forceHover?: boolean; dragFree?: boolean; downHandled?: unknown;
};

/** A copper shape: a core (point, segment, polyline, turned rectangle or polygon) plus an outward offset r. */
export type CopperShape =
  | { t: "circle"; x: number; y: number; r: number }
  | { t: "seg"; a: Pt; b: Pt; r: number }
  | { t: "path"; pts: Pt[]; r: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; rot: number; rr: number }
  | { t: "poly"; pts: Pt[] };
/** A rectangle shape's fields (padShape, rectCore). */
export type RectShape = Extract<CopperShape, { t: "rect" }>;
/** A segment shape (a track) and a disc (a via, a round pad). */
export type SegShape = Extract<CopperShape, { t: "seg" }>;
export type CircleShape = Extract<CopperShape, { t: "circle" }>;
/** A polygon shape (a zone fill), or the polyline the other cores are walked as. */
export type PolyShape = Extract<CopperShape, { t: "poly" }>;
/** kicad-canvas' arcFrom3: the circle through three points and the canvas sweep from a0 to a1. */
export type Arc3 = NonNullable<ReturnType<ToolsCanvasApi["arcFrom3"]>>;

/** One piece of copper on a layer set with a net (conductors): a pad, track, arc, via or zone fill. */
export type Conductor = { id: string; item: KItem; net: string; netObj: NetRef; layers: Set<string>; shape: CopperShape; anchors: Pt[]; bbox: Box } & (
  | { kind: "pad"; pad: PadInfo; index: number }
  | { kind: "segment" | "arc"; length: number; width: number }
  | { kind: "via"; size: number; drill: number }
  | { kind: "zone" });
/** A conductor before its box is computed. */
export type ConductorInit = Conductor extends infer C ? C extends unknown ? Omit<C, "bbox"> : never : never;
/** A ratsnest anchor of a cluster: a point and the conductor it belongs to. */
export interface Anchor { p: Pt; id: string }
/** An island of touching copper and the nets on it. */
export interface Cluster { items: Conductor[]; nets: Set<string>; net: string; anchors: Anchor[] }
/** A net of the netlist: its conductors by kind, its clusters, and the clusters shorting it to another net. */
export interface NetEntry { key: string; name: string; code: number; pads: Conductor[]; tracks: Conductor[]; vias: Conductor[]; zones: Conductor[]; clusters: Cluster[]; shorts: Cluster[]; unconnected?: number }
/** The board's connectivity (netlist). */
export type Netlist = ReturnType<typeof import("./netlist").netlist>;
/** A ratsnest line between the nearest anchors of two clusters of a net. */
export type RatsnestLine = ReturnType<typeof import("./netlist").ratsnest>[number];

/** A netclass' rules as the project stores them (mm). */
export interface NetclassRules { clearance: number; track_width: number; via_diameter: number; via_drill: number; [k: string]: number }
/** BOARD_DESIGN_SETTINGS / NETCLASS: what the DRC and the router check against (designSettings). */
export interface DesignSettings {
  clearance: number; edgeClearance: number; trackWidth: number; viaDiameter: number; viaDrill: number; minTrackWidth: number; minViaDiameter: number; minThroughDrill: number;
  minClearance?: number; minConn?: number; minViaAnnular?: number; minMicroViaDiameter?: number; minMicroViaDrill?: number; holeClearance?: number; minHoleToHole?: number; minTextHeight?: number; minTextThickness?: number;
  netclasses: Record<string, NetclassRules>; netclassOf: Record<string, string>; patterns: { re: RegExp; netclass: string }[]; severities: Record<string, string>;
  [k: string]: unknown;
}
/** The .kicad_pro fields designSettings reads (parsed JSON), or design settings already in our shape. */
export interface DesignSource {
  netclasses?: unknown; clearance?: unknown;
  board?: { design_settings?: { rules?: Record<string, number | undefined>; rule_severities?: Record<string, unknown>; defaults?: DesignDefaults } };
  net_settings?: { classes?: unknown; netclass_assignments?: Record<string, string>; netclass_patterns?: unknown };
}
/** A DRC finding (drc): where, how bad, the message, the items, the rule. */
export interface DrcMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; layer?: string; rule?: string }

/** A routing obstacle that is not copper: an NPTH hole, a rule area keeping tracks out, a board edge. */
export interface WorldItem { id: string | null; kind: string; shape: CopperShape; bbox: Box; layers?: Set<string>; pad?: PadInfo }
/** The board's copper and other routing obstacles (routerWorld), rebuilt when the document changes. */
export interface RouterWorld { doc: BoardDoc; ver: number; conds: Conductor[]; holes: WorldItem[]; keepouts: WorldItem[]; edges: WorldItem[]; copper: string[] }
/** An obstacle of a route on one layer, with the clearance the rules give it against the routed net. */
export interface Obstacle {
  id: string | null; kind: string; net: string; shape: CopperShape; bbox: Box; src?: Conductor | WorldItem; clr: number;
  /** its 45° hull for the track half width hullKey (hullOf's cache) */
  hullKey?: string; hull?: Pt[];
  /** shove: the item the obstacle stands for while it is pushed */
  [extra: string]: unknown;
}
/** Obstacles with a coarse grid (indexObstacles), tagged with what they were built for. */
export interface ObstacleIndex { list: Obstacle[]; grid: Map<string, number[]>; CELL: number; maxClr: number; stamp: Uint32Array; tick: number; key?: string; doc?: BoardDoc }
/** A polyline builder for one leg (legPts45, cornerLeg in the router's corner mode). */
export type LegFn = (a: Pt, b: Pt, diagFirst: boolean) => Pt[];

/** A kicad-canvas geometry primitive with the fields the board tools read, by its shape t (buildGeom's output). */
export interface GeomPrim extends KGeom {
  x1: number; y1: number; x2: number; y2: number; x: number; y: number; r: number; w: number; h: number;
  a0: number; a1: number; anticlockwise: boolean; pts: Pt[]; close?: boolean; fill?: boolean;
}
/** The net names of a board for both file styles (netTable). */
export type NetTable = ReturnType<typeof import("./netlist").netTable>;
/** Track endpoints by layer and point, vias and pad centres by point (jointIndex): what NODE::FindJoint looks up. */
export interface Joints {
  doc: BoardDoc; ver: number; ends: Map<string, KItem[]>;
  vias: Map<string, { item: KItem; layers: Set<string>; net: string }[]>;
  pads: Map<string, { item: KItem; pad: PadInfo; layers: Set<string> }[]>;
  NT: NetTable;
}

/** One edit of a route's branch: { add: node } | { del: id } | { set: id, node }, stamped with the item it was computed from. */
export interface BranchOp { add?: SNode; del?: string; set?: string; node?: SNode; base?: string; grp?: object }

/** A line of tracks as NODE::AssembleLine finds it (assembleLine), or an arc's stub on a dragged via. */
export interface TrackLine {
  ids: string[]; pts: Pt[]; index: number; width: number; layer: string; net: NetRef; netKey: string;
  /** the dragged vertex */
  vertex?: number;
  /** an arc ending on a dragged via, its tangent posture, and the item new segments copy */
  arc?: KItem; arcDiag?: boolean; tmpl?: KItem;
}
/** One drag step's geometry: each line rebuilt for the cursor, and where the via goes. */
export interface DragSolution { lines: { l: TrackLine; pts: Pt[] }[]; viaAt?: Pt }

/** The shove engine's results (pcb-tools/shove.ts). */
export type ShoveWorld = import("./shove").ShoveWorld;
export type ShoveResult = import("./shove").ShoveResult;

/** DRAGGER: the drag of one item (dragStart). */
export interface DragSub {
  id: string; free: boolean; start: Pt; cursor: Pt; forceMark: boolean; first: boolean; status: boolean; sol: DragSolution | null; last: Pt | null; lastValid: Pt;
  obs: Map<string, ObstacleIndex>; mode: string; lines: TrackLine[]; netKey: string; ids: Set<string>;
  via?: KItem; viaAt?: Pt; excl?: Set<string>; shove?: Pick<ShoveResult, "ops" | "preview"> | null; hits?: Obstacle[];
  [extra: string]: unknown;
}
/** S.drag: ROUTER_TOOL::InlineDrag of one or more tracks / vias. */
export interface TrackDrag { subs: DragSub[]; tool: boolean; bySelect: boolean; moved: boolean; cursor: Pt; appSel: boolean; [extra: string]: unknown }

/** S.pedit: a point-editor drag in flight. */
export interface PointEdit { id: string; kind: string; key: string; orig: SNode; start: Pt; moved: boolean; node?: SNode; ignoreGrid?: boolean; [extra: string]: unknown }

/** S.draw: a graphic, zone or dimension being drawn (pts are the fixed clicks, cur the cursor); arcs keep their ARC_GEOM_MANAGER. */
export interface DrawState {
  shape: string; start: Pt; cur: Pt; pts: Pt[];
  chain?: { id: string; start: Pt; end: Pt }[]; orientation?: string;
  arc?: import("./arcs").ArcGeom; chainSeeded?: boolean; clickSeeded?: boolean; started?: boolean; lastClick?: Pt | null;
  /** a zone / rule area: its layer, the properties dialog still open, the node it set up */
  layer?: string; pending?: boolean; template?: SNode | null;
  /** a polygon: the snap mode, the leader to the cursor and the closing loop */
  mode?: string; leader?: Pt[] | null; loop?: Pt[] | null;
  /** a dimension: its end once placed, the height, the text position and the arrows */
  end?: Pt | null; height?: number; textPos?: Pt | null; arrowInward?: boolean;
  [extra: string]: unknown;
}

/** S.image: a reference image riding the cursor. */
export interface RefImage { base64: string; info: import("./images").ImageInfo; w: number; h: number; name: string; el: HTMLImageElement | null }

/** S.move: a select-tool move (EDIT_TOOL::doMoveSelection) of footprints and other items. */
export interface SelectMove {
  ids: string[]; start: Pt; orig: Map<string, SNode>; ends: { id: string; key: string }[]; last: Pt; moved: boolean;
  sticky?: boolean; placing?: string[] | null; restore?: { id: string; node: SNode }[] | null; hover?: boolean; skip?: Set<string>; conns?: { l: TrackLine; vertex: number }[];
  /** the nodes as they were before a turn / flip / mirror during the move, and whether one happened */
  base?: Map<string, SNode>; xformed?: boolean;
  mods?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }; snapAt?: Pt | null;
  /** a lone tuning pattern being moved: its generator's id (the move re-tunes it rather than carrying its copper) */
  gen?: string;
  [extra: string]: unknown;
}
/** S.pending: a press on a selected item that becomes a move once the pointer travels. */
export interface PendingDrag { ids: string[]; item: KItem | undefined; mm: Pt; client: Pt; app?: boolean }

/** The router's via while it is carried (viaPlan). */
export interface ViaPlan { type: string; toLayer: string; span: string[]; diameter: number; drill: number }
/** A track the route started on, split where the route meets it. */
export interface RouteSplit { id: string; point: Pt; node: SNode }
/** A track the route split at its start or end: removeAntennas looks at its two halves when the route is committed. */
export interface Antenna { p: Pt; layer: string; ids: string[] }
/** A fixed stage of a route: its branch edits and what the route was when it was fixed (UnfixRoute pops it). */
export interface RouteStage {
  ops: BranchOp[]; from: Pt; layer: string; net: NetRef; netKey: string; placingVia: ViaPlan | null; startIds: string[]; split: RouteSplit | null; dir: number;
  antennas?: Antenna[]; dpStart?: import("./diffpair").DpPair;
}
/** S.route: LINE_PLACER (and DIFF_PAIR_PLACER) while a track or a pair is routed. */
export interface Route {
  start: Pt; startLayer: string; startKind: string | null; startSpan?: string[] | null;
  last: Pt; target: Pt; cursor: Pt; head: Pt[]; els: TrackElem[]; reached: boolean;
  net: NetRef; netKey: string; layer: string; width: number; connected?: number | null; diagFirst: boolean; clickT: number; clickAt: Pt;
  stages: RouteStage[]; split: RouteSplit | null; startIds: string[]; /** the leading ratline (a pair: one per net) */
  ratline: import("./route-fix").Ratline | import("./route-fix").Ratline[] | null; placingVia: ViaPlan | null; chained: boolean;
  collisions: Obstacle[] | null; shove: ShoveResult | null; tracer: import("./tracer").Tracer; keepHighlight: boolean;
  obs?: ObstacleIndex | null; sobs?: ObstacleIndex | null; bdoc?: BoardDoc | null; bdocVer?: number; viaBad?: Obstacle[] | null;
  ratAnchor?: { p: Pt; layers: string[]; through: boolean } | null; loopHidden?: Set<string> | null;
  // DIFF_PAIR_PLACER
  dp?: boolean; netN?: NetRef; netKeyN?: string; dpSizes?: import("./diffpair").DpSizes; dpStart?: import("./diffpair").DpPair;
  dpLines?: import("./diffpair").DpLines | null; dpFit?: boolean; dpObs?: ObstacleIndex | null; dpGw?: import("./diffpair").DpGateway | null; dpTargetPair?: import("./diffpair").DpPair | null;
}

/** The meander settings of the length tuner (meanderDefaults). */
export type MeanderSettings = import("./meander").MeanderSettings;
/** S.tune.pattern / S.tune.picker: the tuning pattern being placed and the track under the cursor. */
export type TunePattern = import("./tuning-tool").TunePattern;
export type TunePicker = import("./tuning-tool").TunePicker;

/** One field of a form (the dialogs the board commands open): its key, label, kind and value. */
export interface FormField {
  k?: string; label?: string; type: string; value?: unknown; tip?: string; step?: string;
  /** select / radio: [value, label(, tooltip)] pairs or plain values */
  options?: (string | (string | number)[])[];
  /** table: the columns, the rows of cells, a click on a row, the text of an empty table */
  columns?: { label: string; width?: string }[]; rows?: unknown[][]; onRow?(i: number, row: HTMLElement): void; empty?: string;
}
/** A form: the fields, and apply(values) on OK (false keeps it open); V is what the fields hand back by key. */
export interface FormSpec<V = Record<string, unknown>> { title: string; width?: number; readOnly?: boolean; fields: FormField[]; apply?(v: V): boolean | void }
