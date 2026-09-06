// globals.d.ts — ambient types for the imperative libraries the chrome consumes.
// They are classic scripts registered on window (static/kicad-canvas.js, sch-tools.js,
// pcb-tools.js, props.js, kicad-dialogs.js); the contracts are documented at the top of
// each file.  S-expression trees are dynamic nested arrays, so they stay `SNode`.

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
  parse(text: string): SNode | null;
  parseAll(text: string): SNode[];
  serialize(node: SNode): string;
  serializeItem(doc: KDoc, item: KItem): string;
  parseDoc(text: string, docType?: string): KDoc;
  addItem(doc: KDoc, node: SNode): KItem | null;
  createItem(doc: KDoc, node: SNode): KItem | null;
  applyChange(doc: KDoc, change: KChange, IU: number): boolean;
  moveItem(doc: KDoc, item: KItem, x: number, y: number, IU: number): void;
  replaceChange(doc: KDoc, item: KItem): KChange;
  addChange(doc: KDoc, item: KItem): KChange;
  removeChange(item: KItem): KChange;
  typeNameOf(item: KItem): string;
  render(doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts?: KRenderOpts): void;
  setViewTransform(ctx: CanvasRenderingContext2D, view: KView): void;
  drawSelectionHalo(ctx: CanvasRenderingContext2D, doc: KDoc, ids: Set<string>, s: number, dpr: number, hidden?: Set<string>): void;
  movableItems(doc: KDoc): { id: string; kind: string; x: number; y: number; rot: number; ref: string; value: string; lib: string; layer: string; bbox: KItem["bbox"]; name?: string; file?: string; w?: number; h?: number }[];
  hitTest(doc: KDoc, x: number, y: number, slopMm?: number): string | null;
  layerList(doc: KDoc): { key: string; name: string; color: string; count: number; z?: number }[];
  snap(v: number, pitch: number): number;
  computeBBox(doc: KDoc): void;
  fieldBoxes(item: KItem): { name: string; pts: [number, number][] }[];
  fieldAt(doc: KDoc, x: number, y: number): { item: KItem; name: string } | null;
  pinPoints(doc: KDoc, item: KItem): [number, number][];
  wireEndsAt(doc: KDoc, x: number, y: number, tol?: number): KItem[];
  newUuid(): string;
  setPts(node: SNode, pts: [number, number][]): void;
  setAt(node: SNode, x: number, y: number, rot?: number): void;
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
  ORIENT: unknown;
  onAssetLoaded: ((info: { id: string; kind: string; ok: boolean }) => void) | null;
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
  commit(changes: KChange[], label?: string): void;
  applyLocal(changes: KChange[]): void;
  requestRender(): void; toast(msg: string, ms?: number): void; enterSheet(file: string): void; setTool(t: string): void; setStatus(text: string): void;
}

interface ToolModuleTool { id: string; label: string; key?: string; icon?: string; cursor?: string }
interface ToolModuleAction { label: string; key?: string | null; menu?: string | null; run(ctx: ToolCtx): void }

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
  onSelectDown?(ev: PointerEvent, mm: [number, number], ctx: ToolCtx): boolean;
  onKey?(key: string, ev: KeyboardEvent | Record<string, never>, ctx: ToolCtx): boolean;
  drawOverlay?(ctx2d: CanvasRenderingContext2D, view: KView, ctx: ToolCtx): void;
  onDocChanged?(ctx: ToolCtx): void;
  deleteChanges?(doc: KDoc, items: KItem[]): KChange[] | null;
  setPrompt?(fn: unknown): void;
  setImagePicker?(fn: unknown): void;
}

interface SchToolModule extends ToolModule {
  select(id: string | null): void;
  beginDrag(ctx: ToolCtx, item: KItem | KItem[], mm: [number, number], byPointer?: boolean): unknown;
  moveDrag(ctx: ToolCtx, mm: [number, number]): void;
  endDrag(ctx: ToolCtx, apply: boolean): void;
  cancelDrag?(ctx: ToolCtx): void;
  setDragMode(ctx: ToolCtx, mode: string): void;
  setLineMode(ctx: ToolCtx, mode: string): void;
  cycleLineMode(ctx: ToolCtx): void;
  modeText(): string;
  netItems(doc: KDoc, item: KItem, near?: unknown): KItem[];
  _: Record<string, unknown>;
}

interface PcbToolModule extends ToolModule {
  setLayer?(ctx: ToolCtx, layer: string): void;
}

interface PropsModule {
  /** Draw the Properties panel for `selected` (or the module-inspected item when null) into `el`. */
  render(el: HTMLElement, selected: { id: string } | null, ctx: ToolCtx): void;
  refresh(): void;
  inspect(item: KItem | null): void;
  renderInto(el: HTMLElement, item: KItem, ctx: ToolCtx, opts?: unknown): unknown;
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
}

declare const KiCadCanvas: KiCadCanvasApi;
declare const CollabTools: CollabToolsApi;
declare const KDialogs: KDialogsApi | undefined;

interface Window {
  KiCadCanvas: KiCadCanvasApi;
  CollabTools: CollabToolsApi;
  KDialogs?: KDialogsApi;
}
