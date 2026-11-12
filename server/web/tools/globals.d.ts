// tools/globals.d.ts — the global object as the classic tool scripts built from web/tools/<name>/ see it
// (static/kicad-dialogs.js, props.js, ...): window in the browser, globalThis under node.  The scripts
// talk to each other and to the chrome only through these globals; web/globals.d.ts holds the chrome's
// (consumer-side) view of the same objects.

/** kicad-canvas.js as the tool scripts use it: the chrome's contract plus the helpers it does not name. */
interface ToolsCanvasApi extends KiCadCanvasApi {
  /** Deep copy of a node that keeps the reader's record of which atoms were quoted (JSON would drop it). */
  cloneNode<T>(node: T): T;
  /** KiCad's symbol transform [x1, y1, x2, y2] for (at … rot) + (mirror …) (web/canvas/geom-sch.ts) */
  symbolTransform(rot: number, mirror: string): number[];
  /** A node's text effects (web/canvas/sexpr.ts). */
  effectsOf(node: SNode): { size: number; sizeX: number; thick: number; hide: boolean; just: string[]; mirror: boolean; bold: boolean; italic: boolean; face?: string };
  /** The circle arc through three points; null when they are collinear. */
  arcFrom3(p0: readonly number[], pm: readonly number[], p1: readonly number[]): { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean } | null;
  /** A cubic bezier flattened into points. */
  bezierPts(p: number[][], segs?: number): number[][];
  /** Stroke-font text width (mm). */
  textWidth(text: string, size: number, thick: number): number;
}

/** window.CollabTools as the tool scripts fill it: one entry per script. */
interface ToolsCollab {
  props?: import("./props/index").PropsApi;
  sch?: SchToolModule;
  pcb?: PcbToolModule;
}

interface ToolsRoot {
  KiCadCanvas: ToolsCanvasApi;
  CollabTools: ToolsCollab;
  KDialogs: import("./kicad-dialogs/index").KDialogsModule & {
    /** a yes / no question as a KiCad dialog, where the chrome provides one */
    confirm?(title: string, text: string): Promise<boolean>;
  };
  /** web/editor/library.ts: the Choose Symbol dialogs the place tools hand over to, and its after-placement hook. */
  KiCadLibrary?: { toolChooser?(ctx: ToolCtx, which: "place" | "power"): boolean; afterPlace?(ctx: ToolCtx, item: KItem | null, which?: string): void; chooseAndPlace?(kind: "symbol" | "footprint", opts?: Record<string, unknown>): unknown };
  /** web/editor: the editor state; the tools ask its Selection Filter whether an item may be picked, and the board
   *  tools read the live editor state (the former app.js script-scope lets) through it. */
  CollabEditor?: {
    pickAllowed?(item: KItem): boolean;
    /** SCH_PIN::HitTest with no slop (m_PinSymbolSize / 4): a pin the Selection Filter takes is exactly under mm. */
    pinExactAt?(mm: [number, number]): boolean;
    /** dialogs/sync-units.ts toggleAttribute: SetAttribute over the items and the other units of multi-unit parts. */
    toggleAttribute?(ctx: unknown, items: KItem[], isOn: (node: SNode) => boolean, set: (node: SNode, on: boolean) => SNode): boolean;
    tool?: string; DOC_TYPE?: string; kdoc?: KDoc | null; zoom?: number; selected?: { id: string; x: number; y: number; rot?: number } | null;
    selection?: Set<string> | null; hiddenLayers?: Set<string> | null; overrideLocks?: boolean; units?: string;
    /** the editor's own footprint drag (a group drag carries every footprint) */
    drag?: { moved?: boolean; group?: { fp: { id: string } }[] | null; fp?: { id: string } | null } | null;
  };
  /** web/editor: the chrome's store (the board tools read the view and whether a context menu is up). */
  CollabApp?: { getState(): { view?: string; contextMenu?: unknown } };
  /** web/router (static/dist/autoroute.js): the autorouter and placer dialogs. */
  PcbAutoRouter?: { open?(ctx: ToolCtx): boolean; openPlace?(ctx: ToolCtx): boolean };
  /** web/editor/pcbdialogs: the zone filler. */
  PcbZoneFill?: { fillAll(ctx: ToolCtx): boolean; fillSelected(ctx: ToolCtx): boolean };
  /** pcb-tools.js' geometry and node builders, for the node tests. */
  PcbTools?: unknown;
  localStorage?: Storage;
  dispatchEvent?(ev: Event): boolean;
}
