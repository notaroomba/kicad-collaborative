// kicad-canvas — the shapes the canvas modules share: points and boxes in mm, the text effects of a node,
// the geometry primitives buildGeom produces and the painters draw, and the document / item records.
// Type-only: nothing here exists at run time.

/** A point in mm, [x, y] (a copy of a node's (at x y rot) may carry the angle as a third entry). */
export type Pt = number[];
/** A box in mm, [x0, y0, x1, y1]. */
export type Box = number[];
/** One atom or child list of an s-expression node. */
export type SAtom = SNode[number];

/** (effects (font (size h w) (thickness t) bold italic (face …)) (justify …) hide) as effectsOf reads it. */
export interface TextEffects {
  size: number; sizeX: number; thick: number; hide: boolean; just: string[]; mirror: boolean; bold: boolean; italic: boolean;
  /** an outline (TrueType) font by name */
  face?: string;
}

/** A centre / radius / start and end angle arc through three points (arcFrom3). */
export interface Arc3 { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean }

/** strokeOf: the width, colour and dash of a (stroke …). */
export interface StrokeInfo { w: number; color: string | null; dash: boolean; type: string | null }

/** fillOf: none | outline | background | color | solid, and the colour of a (fill (color …)). */
export interface FillInfo { type: string; color: string | null }

/** boxOf: an axis-aligned box and its angle. */
export interface BoxRot { x0: number; y0: number; x1: number; y1: number; rot: number }

// ---------------------------------------------------------------- geometry
// One primitive of an item's geometry (item.geom): what buildGeom produces and render / hit / export read.
// The shape fields depend on `t`; the flags in GeomFlags say what the primitive belongs to (a track, a
// pad, a zone fill …) and how it is painted.  Type aliases, not interfaces, so a primitive still fits the
// chrome's loose KGeom view (globals.d.ts).

/** The flags and paint attributes any primitive may carry. */
export type GeomFlags = {
  layer: string;
  /** stroke width (line, poly, circle, arc), pen width (text) or width (rect, pad, image) */
  w: number;
  z?: number;
  color?: string | null;
  fill?: string | null;
  noStroke?: boolean;
  /** a filled sector (arcs: the via hole halves); read off circles too */
  pie?: boolean;
  cap?: string;
  dash?: boolean; dashType?: string;
  /** opacity the painters multiply in */
  alpha?: number;
  net?: number;
  track?: boolean; via?: boolean; hole?: boolean; npth?: boolean; point?: boolean;
  /** a via's ring: its size, type, layer pair, and whether it carries the net label; a via hole's plating ring (circles only) */
  viaSize?: number; viaType?: string; viaLayers?: string[]; viaLabel?: boolean; wallR?: number; wallColor?: string;
  /** a primitive of a footprint pad, its index among the footprint's pads, number, type and net name */
  pad?: boolean; padIndex?: number; padNumber?: string; padType?: string; netName?: string;
  /** a board graphic that also opens the solder mask, and its margin (plotting) */
  maskLayer?: string; maskMargin?: number;
  /** a label that is not selectable geometry and stays out of the item's box (pad numbers / net names) */
  noBox?: boolean;
  /** a pad label, and which one: the net name or the number */
  padText?: boolean; padNet?: boolean; padNum?: boolean;
  /** the points of a polygon (PolyGeom; optional on the others, which some readers probe for) */
  pts?: Pt[];
  zoneFill?: boolean; zoneOutline?: boolean; teardrop?: boolean; zoneUnfilled?: boolean; zoneClearance?: number; zoneHatch?: boolean;
  /** a field of a symbol / footprint, by name */
  field?: string;
  /** a hidden field kept for the showHiddenText option */
  hiddenText?: boolean;
  /** pcbnew group membership (render's group numbers) */
  group?: number[] | number;
  fp?: string;
  id?: string;
  /** painter caches on the record, rebuilt with the geometry: its Path2D, its box (render's per-geometry cull) */
  _p?: Path2D | null; _bb?: Box | null;
  /** the pin (number, or sheet pin name) a primitive of a symbol / sheet draws: a net highlight brightens single pins */
  pinNo?: string;
  /** a schematic's excluded-from-simulation marker (drawn under markSimExclusions) */
  simMarker?: boolean;
  /** hatch fill lines: no selection shadow of their own */
  noShadow?: boolean;
};

export type LineGeom = GeomFlags & { t: "line"; x1: number; y1: number; x2: number; y2: number };
export type PolyGeom = GeomFlags & { t: "poly"; pts: Pt[]; close?: boolean };
export type RectGeom = GeomFlags & { t: "rect"; x: number; y: number; h: number; wd?: number; rot?: number };
export type CircleGeom = GeomFlags & { t: "circle"; x: number; y: number; r: number };
export type ArcGeom = GeomFlags & { t: "arc"; x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean };
export type PadGeom = GeomFlags & { t: "pad"; x: number; y: number; h: number; rot: number; shape: string; rr: number;
  pts?: Pt[]; chamfer?: number; chamferCorners?: string[] };
export type TextGeom = GeomFlags & {
  t: "text"; x: number; y: number; text: string; bars?: [number, number][] | null; size: number; rot: number; h: string; v: string;
  sizeX?: number; bold?: boolean; italic?: boolean; mirror?: boolean; face?: string;
  /** the marked-up source: the stroke painter lays out ~{} _{} ^{} itself */
  raw?: string;
  multiline?: boolean; knockout?: boolean | number[]; layoutW?: number;
  padMin?: number; padLayers?: string[]; minPx?: number;
  /** an outline-font text's stored render cache (board coordinates) and where the text was when it was noted */
  outline?: { node: SNode; x: number; y: number; rot: number; shown: string; upright?: boolean };
  /** the first line of a text set in an outline font: the one its outlines (stored, or drawn from the font file) go out with */
  outlineFirst?: boolean;
  /** an outline-font text as a whole (every line, its anchor): what a plot lays out from the font file */
  block?: { x: number; y: number; rot: number; text: string; upright?: boolean };
  /** a board text (PCB_TEXT / PCB_FIELD) a DXF plot may write as a TEXT entity (DXF_PLOTTER::plotOneLineOfText): its bold flag */
  dxfText?: { bold: boolean };
  /** a footprint text's own position (EDA_TEXT::GetTextPos, board coordinates): where its umbilical line starts */
  textPos?: Pt;
};
export type ImageGeom = GeomFlags & { t: "image"; x: number; y: number; h: number; rot?: number;
  entry: ImageEntry; pxMm: number; scale: number; opacity?: number };

/** A decoded image (tables-images imageEntry): its data URL, pixel size and PPI, and the bitmap once it loads. */
export interface ImageEntry { key: string; id: string; url: string; mime: string; w: number; h: number; ppi: number; img: HTMLImageElement | null; loaded: boolean; failed: boolean }

/** One primitive of an item's geometry. */
export type Geom = LineGeom | PolyGeom | RectGeom | CircleGeom | ArcGeom | PadGeom | TextGeom | ImageGeom;

// ---------------------------------------------------------------- documents
/** One item of a document (doc.items): the chrome's KItem with the canvas's geometry and the fields the builders set. */
export interface Item extends Omit<KItem, "geom" | "hiddenGeom" | "bbox"> {
  geom: Geom[];
  /** hidden fields / text, drawn only under the showHiddenText option */
  hiddenGeom?: Geom[] | null;
  bbox: Box | null;
  /** the schematic theme its geometry was built under */
  schTheme?: string;
  /** a board outline item (Edge.Cuts) */
  edge?: boolean;
  unit?: number; page?: string; net?: number; scale?: number; viaType?: string;
}

/** The drawing-sheet context the title block resolves (sheet.ts sheetTextVars). */
export interface SheetContext {
  page: Pt; paper?: string; portrait?: boolean; titleBlock?: Record<string, string>; pageNumber?: string; sheetCount?: number;
  fileName?: string; filePath?: string; fileRoot?: string; sheetName?: string; sheetPath?: string; projectName?: string;
  projectVars?: Record<string, string> | null; kicadVersion?: string; sheetLayer?: string; sheetVars?: Record<string, string> | null;
  isFirstPage?: boolean;
  /** the session's current design variant (${VARIANT}, empty for the default) and its description (${VARIANT_DESC}) */
  variantName?: string; variantDesc?: string;
  /** the document's own (kicad_wks …), parsed; null for KiCad's built-in sheet */
  drawingSheet?: import("./sheet").DrawingSheet | null;
}

/** A parsed document (parseDoc): the chrome's KDoc with the canvas's items and the fields parseDoc and the app fill in. */
/** SCHEMATIC_SETTINGS' intersheet reference options and SCHEMATIC::GetPageRefsMap for the open sheet (the editor fills it). */
export interface IntersheetRefs { show: boolean; ownPage: boolean; short: boolean; prefix: string; suffix: string;
  /** global label text -> the virtual page numbers it is on */ pages: Record<string, number[]>;
  /** virtual page number -> the page number shown (GetVirtualPageToSheetPagesMap) */ names: Record<number, string>;
  /** the open sheet's virtual page number */ current: number }
export interface Doc extends Omit<KDoc, "items" | "bbox" | "page">, SheetContext {
  items: Map<string, Item>;
  intersheetRefs?: IntersheetRefs | null;
  bbox: Box | null;
  page: Pt;
  schTheme?: string;
  version: number;
  uuid?: string;
  auxOrigin?: [number, number]; gridOrigin?: [number, number];
  stackup?: SNode | null;
  /** the board file's (setup …) and (general …) sections as they stand (a stackup edit starts from them) */
  setupNode?: SNode | null; generalNode?: SNode | null;
  /** board net name -> code (geom-pcb netCode), and the last code handed out */
  netCodes?: Map<string, number>; netSeq?: number;
  /** schematic settings the app reads from the project (junction size …) */
  schSettings?: { junctionDiameter?: number; [k: string]: unknown } | null;
  path?: string;
  /** the file's top-level (embedded_files …), as read */
  embeddedFiles?: SNode | null;
  /** a library footprint open in the Footprint Editor (footprint-doc.ts): its header and what it was read from */
  fpEditor?: boolean; fpState?: import("./footprint-doc").FpDocState;
}

/** Where the builders put geometry: an item, or a scratch record whose primitives go elsewhere (hidden pins …). */
export type GeomSink = { geom: Geom[]; bbox: Box | null };

/** Maps a node's own coordinates to the sheet / board (mm). */
export type Tf = (x: number, y: number) => Pt;

/** The options textGeom / textLines / transformedText take: fields copied onto the text, plus the layout switches. */
export type TextExtra = Partial<Omit<TextGeom, "t">> & {
  /** default justification when the node names none */
  defH?: string; defV?: string;
  /** keep the angle as given (pcbnew draws any angle) */
  pcb?: boolean;
  /** the footprint keep-upright rule */
  upright?: boolean;
};

/** One wire-format change as applyChange reads it: the chrome's KChange, or a peer's with the item text under itemSexpr. */
export interface WireChange { id: string; kind: string; typeName?: string; sexpr?: string; itemSexpr?: string; properties?: KChange["properties"] }

/** A change the tools layer sends: a KChange plus the board extras boardChangeExtras adds (net names, group members). */
export type OutChange = KChange & { netName?: string; padNets?: Record<string, string>; groupMembers?: string[] };

// ---------------------------------------------------------------- painting
/** A 2D context the painters draw on: the screen's, or an offscreen one (zone previews, PNG export). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** A canvas the offscreen helpers make (KiCadCanvas.createCanvas): OffscreenCanvas, a <canvas>, or a test stub. */
export interface AnyCanvas {
  width: number; height: number; getContext(id: "2d"): Ctx2D | null;
  /** OffscreenCanvas's encoder */
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  /** a <canvas>'s encoder */
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}
/** What tracePath / tracePad draw into: a context, a Path2D, or export.ts's SvgPath. */
export type PathSink = Pick<CanvasPath, "moveTo" | "lineTo" | "closePath" | "rect" | "arc">;
/** The document → device matrix [a, b, c, d, e, f] of setTransform. */
export type Mat = number[];
/** The view render() draws: css px per mm at zoom 1, the zoom, the pan (css px), the mm origin and the device pixel ratio. */
export interface View { ppm: number; zoom: number; panX: number; panY: number; x0: number; y0: number; dpr?: number }
/** A DRC / ERC marker. */
export interface Marker { x: number; y: number; severity?: string; text?: string; selected?: boolean; brightened?: boolean; [k: string]: unknown }
/** One unrouted connection of the ratsnest (mm). */
export interface RatsLine { net: number; name?: string; a: number[] | null; b: number[] | null }
/** The Appearance ▸ Objects state: rows hidden, rows shown (anchors / locked shadow), per-row opacity. */
export interface ObjectsOpt { hide?: Set<string>; show?: Set<string>; opacity?: Record<string, number> }
/** render()'s options (see its comment for each). */
export interface RenderOpts {
  hidden?: Set<string>; grid?: number; gridStyle?: string; gridMinSpacing?: number; gridOrigin?: number[] | null; gridColor?: string;
  gridAxes?: boolean; gridAxesColor?: string; frame?: boolean;
  /** board: the grid items (PCB_GRID_ITEM, Appearance ▸ Grids, LAYER_SUBGRIDS); false hides them; their colour */
  subgrids?: boolean; gridItemColor?: string;
  selected?: Set<string> | null; highlight?: Set<string> | null; lockedIds?: Set<string> | null;
  showHiddenPins?: boolean; showHiddenText?: boolean; /** eeschema's View > Show Hidden Fields (not pcbnew's hidden text) */ showHiddenFields?: boolean; zoneOutline?: boolean; padNumbers?: boolean;
  outlinePads?: boolean; outlineTracks?: boolean; outlineVias?: boolean;
  highContrast?: boolean; activeLayer?: string | null; inactiveHide?: boolean;
  /** board: Preferences ▸ Display ▸ "dimming factor for high contrast mode" (appearance.hicontrast_dimming_factor, 0.8) */
  hcDimming?: number;
  /** board: items repainted brightened (EDA_ITEM::IsBrightened: Clarify Selection hover, the interactive delete tool) */
  brightened?: Set<string> | null;
  /** board: F.SilkS default line width (mm): the locked item shadow margin is 4× it */
  silkLineWidth?: number;
  /** board: the board outline loops filled in LAYER_BOARD_OUTLINE_AREA (Appearance ▸ Board Area Shadow) */
  boardArea?: number[][][] | null;
  /** board: the entered group's member ids; everything else is drawn at outsideGroupOpacity */
  enteredGroup?: Set<string> | null; outsideGroupOpacity?: number;
  ids?: Set<string> | string[] | null; skip?: Set<string> | null;
  netColors?: Map<number, string> | null; netNames?: boolean; zoneFill?: boolean; flip?: boolean;
  ratsnest?: RatsLine[] | null; ratsnestNets?: Set<number> | null; markers?: Marker[] | null;
  layerColors?: Map<string, string> | null; objects?: ObjectsOpt | null;
  itemColors?: Map<string, string | string[]> | null;
  /** the schematic item with a hyperlink under the cursor (SCH_ITEM::SetIsRollover): its text in LAYER_HOVERED, underlined */
  rollover?: string | null;
  /** with `rollover`: only this text geometry, and only this url run of it ([start, end) of its source), is hovered
   *  (FONT::drawMarkup with a mouse position: the url node under the cursor in LAYER_HOVERED, underlined) */
  rolloverGeom?: object | null; rolloverRun?: { start: number; end: number } | null;
  /** [x0, y0, x1, y1] device px: repaint only that part */
  region?: number[] | null;
  /** css colour under the drawing, or false for none */
  background?: string | false | null;
  /** drawn over what the canvas already holds (a tool preview): with background false nothing is cleared */
  overlay?: boolean;
  /** schematic: local labels whose connection point dangles (a selected one shows no anchor) */
  dangling?: Set<string> | null;
  /** schematic: items being moved whole ("parentMoving": their fields show no anchors) */
  moving?: Set<string> | null;
  /** schematic View-menu display options (EESCHEMA_SETTINGS appearance) */
  showDirectiveLabels?: boolean; markSimExclusions?: boolean; showErcErrors?: boolean; showErcWarnings?: boolean; showErcExclusions?: boolean;
}
/** renderSvg / renderPng options: render()'s, plus the export area and format. */
export interface ExportOpts extends RenderOpts {
  /** the schematic colour theme to export in (KiCad Default unless given) */
  colorTheme?: string;
  /** [x0, y0, x1, y1] mm: the export area */
  bbox?: number[] | null;
  /** mm around the area */
  margin?: number;
  /** mm: the width zero-width strokes get (SVG) */
  hairline?: number;
  dpi?: number; maxPixels?: number;
  /** the image MIME type and encoder quality (PNG) */
  type?: string; quality?: number;
}
/** A text record the text painters draw: item text, or a drawing-sheet field (which is on no layer). */
export type DrawTextG = Omit<TextGeom, "layer"> & { layer?: string };
/** A via's copper ring (buildViaGeom): a circle with the via's size, type and layer pair. */
export type ViaRingGeom = CircleGeom & { viaSize: number; viaType: string; viaLayers: string[] };
