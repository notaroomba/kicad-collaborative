// globals.d.ts — ambient types for the imperative libraries the chrome consumes.
// They are classic scripts registered on window (static/kicad-canvas.js, sch-tools.js,
// pcb-tools.js, props.js, kicad-dialogs.js); the contracts are documented at the top of
// each file (props.js and kicad-dialogs.js are built from web/tools/<name>/, whose own view
// of these globals is web/tools/globals.d.ts).  S-expression trees are dynamic nested arrays,
// so they stay `SNode`.

/** A parsed s-expression: a list whose head is the keyword, e.g. ["at", 10, 20, 90]. */
type SNode = (string | number | SNode)[];

/** One geometry primitive produced by kicad-canvas.js buildGeom (shape-specific fields are dynamic). */
interface KGeom { t: string; layer: string; [k: string]: unknown }

interface KItem {
  id: string;
  kind: string;
  node: SNode;
  geom: KGeom[];
  bbox: [number, number, number, number] | null;
  movable: boolean;
  docType: "sch" | "pcb";
  x?: number; y?: number; rot?: number; ref?: string; value?: string; lib?: string; layer?: string;
  name?: string; file?: string; w?: number; h?: number;
  hiddenGeom?: KGeom[] | null;
}

interface KDoc {
  type: "sch" | "pcb";
  items: Map<string, KItem>;
  lib: Map<string, SNode>;
  layers: Map<string, { id: number; type: string; userName: string }>;
  copper: string[];
  nets: Map<number, string>;
  page: [number, number];
  bbox: [number, number, number, number];
  /** (general (thickness …)) of a board, mm */
  thickness?: number;
}

/** A collaboration op change (the item-level LWW protocol shared with the desktop). */
interface KChange {
  id: string;
  kind: "ADDED" | "MODIFIED" | "REMOVED";
  typeName?: string;
  sexpr?: string;
  properties?: { name: string; before?: { type?: string; v: unknown }; after?: { type?: string; v: unknown } }[];
}

interface KView { ppm: number; zoom: number; panX: number; panY: number; x0: number; y0: number; dpr?: number }

interface KRenderOpts {
  hidden?: Set<string>; grid?: number; selected?: Set<string> | null; highlight?: Set<string> | null;
  showHiddenPins?: boolean; highContrast?: boolean; outlinePads?: boolean; outlineVias?: boolean; outlineTracks?: boolean;
  zoneOutline?: boolean; activeLayer?: string;
}

interface KiCadCanvasApi {
  boardItemBox(item: KItem, IU?: number): [number, number, number, number] | null;
  presenceSelection(doc: KDoc | null, selection: Iterable<string> | null, IU: number, moving: boolean, max?: number): { selection: string[]; boxes?: [number, number, number, number][] } | null;
  parse(text: string): SNode | null;
  parseAll(text: string): SNode[];
  serialize(node: SNode): string;
  /** only the item's kind and node are read */
  serializeItem(doc: KDoc, item: Pick<KItem, "kind" | "node">): string;
  parseDoc(text: string, docType?: string): KDoc;
  addItem(doc: KDoc, node: SNode): KItem | null;
  createItem(doc: KDoc, node: SNode): KItem | null;
  applyChange(doc: KDoc, change: KChange, IU: number): boolean;
  moveItem(doc: KDoc, item: KItem, x: number, y: number, IU: number): void;
  replaceChange(doc: KDoc, item: KItem): KChange;
  addChange(doc: KDoc, item: KItem): KChange;
  removeChange(item: KItem): KChange;
  typeNameOf(item: Pick<KItem, "kind"> & Partial<Pick<KItem, "docType">>): string;
  render(doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts?: KRenderOpts): void;
  setViewTransform(ctx: CanvasRenderingContext2D, view: KView): number;
  drawSelectionHalo(ctx: CanvasRenderingContext2D, doc: KDoc, ids: Set<string>, s: number, dpr: number, hidden?: Set<string>): void;
  movableItems(doc: KDoc): { id: string; kind: string; x: number; y: number; rot: number; ref: string; value: string; lib: string; layer: string; bbox: KItem["bbox"]; name?: string; file?: string; page?: string; w?: number; h?: number }[];
  hitTest(doc: KDoc, x: number, y: number, slopMm?: number): string | null;
  layerList(doc: KDoc): { key: string; name: string; color: string; count: number; z?: number }[];
  snap(v: number, pitch: number): number;
  computeBBox(doc: KDoc): void;
  fieldBoxes(item: KItem, hidden?: Set<string> | null): { name: string; pts: [number, number][] }[];
  /** the item under (x, y) mm with what was hit on it (web/canvas/hit.ts) */
  hitTestDetail(doc: KDoc, x: number, y: number, slopMm?: number, opts?: { hidden?: Set<string> | null; side?: string | null } | null): { id: string; onGeom?: boolean; [k: string]: unknown } | null;
  itemVisible(item: KItem, hidden?: Set<string> | null): boolean;
  itemTouchesRect(item: KItem, x0: number, y0: number, x1: number, y1: number, hidden?: Set<string> | null): boolean;
  renderSvg(doc: KDoc, opts?: Record<string, unknown> | null): string;
  renderPng(doc: KDoc, opts?: Record<string, unknown> | null): Promise<Blob>;
  applyDocProps(doc: KDoc | null | undefined, props: { paper?: unknown; titleBlock?: unknown } | null | undefined): boolean;
  cloneNode(node: SNode): SNode;
  fieldAt(doc: KDoc, x: number, y: number, hidden?: Set<string> | null): { item: KItem; name: string } | null;
  /** the pad under (x, y) mm (web/canvas/hit.ts) */
  padAt?(doc: KDoc, x: number, y: number): { item: KItem; index: number } | null;
  /** a symbol's pins on the sheet (mm), with their number and name */
  pinPoints(doc: KDoc, item: Pick<KItem, "kind" | "node">): { x: number; y: number; number: string; name: string }[];
  /** the wire / bus ends at a point: the line and the index of the end point */
  wireEndsAt(doc: KDoc, x: number, y: number, tol?: number): { item: KItem; index: number }[];
  newUuid(): string;
  setPts(node: SNode, pts: readonly (readonly number[])[]): void;
  /** x / y / rot left undefined keep the node's current value */
  setAt(node: SNode, x: number | undefined, y: number | undefined, rot?: number): void;
  atOf(node: SNode): [number, number, number];
  ptsOf(node: SNode): [number, number][];
  kid(node: SNode, key: string): SNode | null;
  kids(node: SNode, key: string): SNode[];
  num(v: unknown, d?: number): number;
  str(v: unknown): string;
  uuidOf(node: SNode): string;
  resolveLib(doc: KDoc, name: string, depth?: number): SNode | null;
  PCB_HIDDEN_DEFAULT: Set<string>;
  PCB_COLORS: Record<string, string>;
  SCH: Record<string, string>;
  /** schematic colour themes (web/canvas/colors.ts) */
  SCH_DEFAULT: Readonly<Record<string, string>>;
  SCH_THEMES: Record<string, { name: string; dark: boolean; colors: Record<string, string> }>;
  schTheme(): string;
  schThemeColors(id: string): Record<string, string>;
  setSchTheme(id: string): boolean;
  withSchTheme<T>(id: string, fn: () => T): T;
  ORIENT: unknown;
  onAssetLoaded: ((info: { id: string; kind: string; ok: boolean }) => void) | null;
  /** the board editor's track / via sizes and routing controls (web/canvas/pcb-sizes.ts) */
  pcbSizes: typeof import("./canvas/pcb-sizes").pcbSizes;
  /** a library symbol (lib_symbols / .kicad_sym entry) as a drawable document in library space (web/canvas/libsym.ts) */
  parseLibSymbol(sym: SNode, opts?: import("./canvas/libsym").LibSymbolOpts): KDoc;
  PIN_TYPE_NAMES: Record<string, string>;
  /** the board's own settings sections (web/canvas/board-setup.ts) */
  boardSetup?: { applyBoardSetup(doc: KDoc, change: KChange): boolean };
  [extra: string]: unknown;
}

/** The context app.js hands every tool hook (its toolCtx() seam). */
interface ToolCtx {
  K: KiCadCanvasApi; doc: KDoc | null; IU: number; isSch: boolean; zoom: number; pxPerMm: number; gridPitch: number; snapOn: boolean;
  snap(mm: [number, number]): [number, number];
  tool: string; selFilter: Record<string, boolean>; activeLayer: string;
  selected: { id: string; x: number; y: number; rot?: number } | null; items: unknown[]; sheets: unknown[]; viewOnly: boolean; live: boolean;
  stage: HTMLElement; worldMm(ev: { clientX: number; clientY: number }): [number, number]; selection: Set<string>;
  docs: unknown[]; project: unknown; api(path: string, opts?: RequestInit): Promise<unknown>; docId: string | null;
  setHighlight(ids: Set<string> | null): void;
  setSelected(fp: { id: string } | null): void;
  commit(changes: KChange[], label?: string, opts?: { amend?: boolean }): void;
  undo?(): void;
  applyLocal(changes: KChange[]): void;
  requestRender(): void; toast(msg: string, ms?: number): void; enterSheet(file: string): void; setTool(t: string): void; setStatus(text: string): void;
}

interface ToolModuleTool { id: string; label: string; key?: string; icon?: string; cursor?: string }
/** run() answering false declines the action (the chrome then tries its own); anything else counts as handled */
interface ToolModuleAction { label: string; key?: string | null; menu?: string | null; run(ctx: ToolCtx): unknown }

interface ToolModule {
  id: string;
  tools: ToolModuleTool[];
  /** Menu entries + hotkeys the chrome binds generically; may be absent or empty. */
  actions?: Record<string, ToolModuleAction>;
  state: Record<string, unknown> & { sel?: unknown; lineMode?: string; dragMode?: string; drag?: unknown };
  onActivate?(toolId: string, ctx: ToolCtx): void;
  onPointerDown?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): boolean;
  onPointerMove?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): void;
  onPointerUp?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): void;
  onSelectDown?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): boolean | "box";
  /** Board: a click on a pad selects the pad ("box" when it was not selected yet, true when it was, false off a pad). */
  selectPadAt?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): boolean | "box";
  selectedPad?(doc: KDoc): { item: KItem; index: number } | null;
  padProperties?(ctx: ToolCtx, item: KItem, index: number): boolean;
  /** Board: with a length tuner active, PCB_ACTIONS::properties opens Tuning Pattern Properties (false otherwise). */
  tunerProperties?(ctx: ToolCtx): boolean;
  /** `ev` is the key event, or a stand-in for a key the chrome synthesises (a menu's Delete) */
  onKey?(key: string, ev: KeyboardEvent | Pick<KeyboardEvent, "shiftKey" | "preventDefault"> | Record<string, never>, ctx: ToolCtx): boolean;
  drawOverlay?(ctx2d: CanvasRenderingContext2D, view: KView, ctx: ToolCtx): void;
  onDocChanged?(ctx: ToolCtx): void;
  deleteChanges?(doc: KDoc, items: KItem[]): KChange[] | null;
  setPrompt?(fn: unknown): void;
  setImagePicker?(fn: unknown): void;
  /** the module's internals (the schematic module's helpers; the board module's are on window.PcbTools) */
  _?: Record<string, unknown>;
  /** board groups: the ids with every member of their groups */
  expandGroups?(doc: KDoc, ids: string[]): Iterable<string>;
  /** undo / redo of a step still in flight in the module (a route); falsy when it has none */
  undoRedo?(ctx: ToolCtx, which: string): unknown;
}

interface SchToolModule extends ToolModule {
  select(id: string | null): void;
  beginDrag(ctx: ToolCtx, item: KItem | KItem[], mm: [number, number], byPointer?: boolean): unknown;
  enterGroupAt?(ctx: ToolCtx, id: string): boolean;
  exitGroup?(): boolean;
  moveDrag(ctx: ToolCtx, mm: [number, number]): void;
  endDrag(ctx: ToolCtx, apply: boolean): void;
  cancelDrag?(ctx: ToolCtx): void;
  setDragMode(ctx: ToolCtx, mode: string): void;
  setLineMode(ctx: ToolCtx, mode: string): void;
  cycleLineMode(ctx: ToolCtx): void;
  modeText(): string;
  /** the ids of the items on the net of `item` (near: the pin or end it was picked at) */
  netItems(doc: KDoc, item: KItem, near?: unknown): Set<string>;
  _: Record<string, unknown>;
}

interface PcbToolModule extends ToolModule {
  setLayer?(ctx: ToolCtx, layer: string): void;
  state: ToolModule["state"] & { sel?: Set<string>; padSel?: string | null; move?: { moved?: boolean } | null; carry?: unknown };
  unlockedIds(ctx: ToolCtx, ids: string[], quiet?: boolean): string[];
  /** RequestSelection for an app-side action: the picked ids and items, or null (nothing picked, or all locked) */
  requestSelection(ctx: ToolCtx, opts?: { filter?(it: KItem): boolean; locks?: boolean; quiet?: boolean; rerun?(ctx: ToolCtx): unknown }): { ids: string[]; items: KItem[]; hover?: unknown } | null;
  beginMove(ctx: ToolCtx, at: [number, number], sticky: boolean): boolean;
  setDesignSettings(src: string | null): void;
  /** the pad under (x, y) mm (pcb-tools convert.ts); `layer` undefined takes any side */
  padAt?(doc: KDoc, x: number, y: number, layer?: string | null): { item: KItem; index: number; pad: unknown } | null;
}

interface PropsModule {
  /** Draw the Properties panel for `selected` (or the module-inspected item when null) into `el`. */
  render(el: HTMLElement, selected: { id: string } | null, ctx: ToolCtx): void;
  refresh(): void;
  inspect(item: KItem | null): void;
  renderInto(el: HTMLElement, ctx: ToolCtx, item: KItem, opts?: unknown): unknown;
  helpers: Record<string, (...args: never[]) => unknown> & { setFootprintSide?(ctx: ToolCtx, item: KItem, side: string): void };
  KIND_NAMES: Record<string, string>;
}

interface CollabToolsApi { sch?: SchToolModule; pcb?: PcbToolModule; props?: PropsModule }

interface KDialogsApi {
  open(spec: unknown): unknown;
  close(): void;
  openItem(ctx: ToolCtx, item: KItem, opts?: unknown): unknown;
  openField(ctx: ToolCtx, item: KItem, name: string): unknown;
  isOpen(): boolean;
  TITLES: Record<string, string>;
  _: Record<string, unknown>;
  schProperties?(): boolean;
}

declare const KiCadCanvas: KiCadCanvasApi;
declare const CollabTools: CollabToolsApi;
declare const KDialogs: KDialogsApi | undefined;

interface Window {
  KiCadCanvas: KiCadCanvasApi;
  CollabTools: CollabToolsApi;
  KDialogs?: KDialogsApi;
}

// The DOM converts an attribute value with ToString (WebIDL DOMString), and the editor passes
// numbers for SVG coordinates throughout; this overload says so instead of wrapping each in String().
interface Element { setAttribute(qualifiedName: string, value: string | number): void }
