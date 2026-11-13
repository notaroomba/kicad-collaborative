// web/fab — fabrication outputs from the browser.
//
// prims: the plot primitives every layer is reduced to before a writer sees it.  Millimetres, board frame
// (Y down, as in the file); angles in degrees, counter-clockwise positive on screen, as KiCad stores them.
// A flash is one aperture hit (a pad, a via); a draw is a round pen dragged along a segment or an arc; a
// region is a filled outline.  `clear` primitives erase what was plotted before them (Gerber %LPC%).
export type Pt = [number, number];

export type Prim = (
  | { k: "seg"; x1: number; y1: number; x2: number; y2: number; w: number }
  /** Arc about (cx, cy): from angle a0 to a1 (radians, canvas convention: x + r·cos a, y + r·sin a), `acw` as CanvasPath.arc. */
  | { k: "arc"; cx: number; cy: number; r: number; a0: number; a1: number; acw: boolean; w: number }
  | { k: "circle"; x: number; y: number; d: number }
  | { k: "rect"; x: number; y: number; w: number; h: number; rot: number }
  | { k: "oval"; x: number; y: number; w: number; h: number; rot: number }
  /** A rectangle w × h (outer size) with corners of radius r. */
  | { k: "roundrect"; x: number; y: number; w: number; h: number; r: number; rot: number }
  /** A flashed polygon: points relative to (x, y), board frame, already rotated. */
  | { k: "poly"; x: number; y: number; pts: Pt[] }
  | { k: "region"; pts: Pt[] }
  /** FlashRegularPolygon: an n-cornered regular polygon of circumscribed diameter d (Gerber's P aperture). */
  | { k: "rpoly"; x: number; y: number; d: number; n: number; rot: number }
  /** ClearAllAttributes: %TD*% and an empty object attribute dictionary. */
  | { k: "td" }
) & { clear?: boolean; meta?: GbrMeta; text?: PlotText };

/**
 * The text a primitive was drawn for, shared by every primitive of that text: what DXF_PLOTTER::PlotText needs
 * to write it as one TEXT entity when the plot does not use the KiCad font.  Board frame, mm, degrees.
 */
export interface PlotText { text: string; x: number; y: number; size: number; sizeX: number; rot: number; h: string; v: string; italic: boolean; bold: boolean; mirror: boolean }

/**
 * GBR_METADATA of a plotted item: the aperture function (%TA.AperFunction) and the object attributes
 * (%TO.P / %TO.N / %TO.C) a Gerber with netlist attributes carries.  `info` is GBR_NETLIST_METADATA's
 * attribute mask: 1 pad (.P), 2 net (.N), 4 component (.C).
 */
export interface GbrMeta {
  af?: string; info?: number; net?: string; ref?: string; pad?: string; pinFn?: string; notInNet?: boolean;
  /** pad and pin function already in their Gerber form (GBR_DATA_FIELD with UTF-8 allowed): not escaped again */
  rawPad?: boolean;
  /** m_TryKeepPreviousAttributes: a dropped attribute is cleared alone (%TO.C*%) instead of the whole dictionary */
  keep?: boolean;
  /** m_ExtraData: lines written after the object attributes of this item (the P&P %TO.CRot … records) */
  extra?: string[];
  /** the board item the primitive was plotted for (a Pad, Via, Track or ZoneFill of the model): the ODB++ writer links features to nets by it */
  src?: unknown;
}

export const rad = (deg: number): number => deg * Math.PI / 180;

/** KiCad's RotatePoint for a positive angle: counter-clockwise on screen (Y down). */
export function rot(x: number, y: number, deg: number): Pt {
  if (!deg) return [x, y];
  const r = rad(deg), c = Math.cos(r), s = Math.sin(r);
  return [x * c + y * s, -x * s + y * c];
}

/** Angle folded into [0, 360). */
export const norm360 = (a: number): number => { const r = a % 360; return r < 0 ? r + 360 : r; };

/** Points along an arc (canvas convention), the ends included; `maxErr` is the chord error in mm. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, acw: boolean, maxErr = 0.005): Pt[] {
  const TAU = 2 * Math.PI;
  let sweep = acw ? a0 - a1 : a1 - a0;
  sweep = ((sweep % TAU) + TAU) % TAU;
  if (sweep < 1e-12 && Math.abs(a1 - a0) > 1e-9) sweep = TAU;
  const step = r > maxErr ? 2 * Math.acos(1 - maxErr / r) : Math.PI / 2;
  const n = Math.max(2, Math.ceil(sweep / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (acw ? -1 : 1) * sweep * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** A circle as a polygon (counted so the chord error stays under `maxErr`). */
export function circlePoints(cx: number, cy: number, r: number, maxErr = 0.005): Pt[] {
  const step = r > maxErr ? 2 * Math.acos(1 - maxErr / r) : Math.PI / 2;
  const n = Math.max(8, Math.ceil(2 * Math.PI / step));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** Signed area (positive when the points run clockwise on screen, Y down). */
export function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}
