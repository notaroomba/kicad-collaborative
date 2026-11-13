/**
 * The app's own preview items, painted on the canvas over the document (KiCad draws them on the GAL
 * overlay layers): the measure tool's RULER_ITEM and the SELECTION_AREA of a box / lasso selection and
 * of the zoom-to-area tool.  Called by drawCanvas with the context already in document space (mm).
 */

import { rulerOps, shadowColor, type RulerUnits } from "./ruler";
import { areaFill } from "./selmodes";
import { E } from "./state";

/** More app overlays, painted first (the table cell selection and its handles, editor/tablecells.ts). */
export const overlayHooks: ((ctx: CanvasRenderingContext2D) => void)[] = [];

type Pt = [number, number];
interface OverlayView { ppm: number; zoom: number; panX: number; panY: number; x0: number; y0: number; dpr?: number }
interface StrokeApi {
  drawStrokeText(ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number): void;
  strokeLineWidth(text: string, italic?: boolean): number;
}

const IU = 1e6;   // the ruler works in pcbIUScale nanometres

/** SELECTION_AREA's two colour schemes (dark / bright background). */
const SCHEMES = [
  { normal: "rgba(77,77,179,0.3)", additive: "rgba(77,179,77,0.3)", subtract: "rgba(179,77,77,0.3)", exclusiveOr: "rgba(179,77,77,0.3)", l2r: "rgb(255,255,102)", r2l: "rgb(102,102,255)" },
  { normal: "rgba(128,77,255,0.5)", additive: "rgba(128,255,128,0.5)", subtract: "rgba(255,128,128,0.5)", exclusiveOr: "rgba(255,128,128,0.5)", l2r: "rgb(179,179,0)", r2l: "rgb(26,26,255)" },
];

/** RENDER_SETTINGS::IsBackgroundDark: the background's COLOR4D::GetBrightness (r .299, g .587, b .117) under 0.5. */
export function backgroundDark(bg: string): boolean {
  const m = /^#?([0-9a-f]{6})/i.exec(bg); if (!m) return true;
  const v = parseInt(m[1], 16), r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return r * 0.299 + g * 0.587 + b * 0.117 < 0.5;
}
/** The active colour theme's background: LAYER_SCHEMATIC_BACKGROUND or LAYER_PCB_BACKGROUND. */
function themeBackground(sch: boolean): string {
  const K = KiCadCanvas as unknown as { SCH?: Record<string, string>; PCB_BG?: string };
  return sch ? (K.SCH && K.SCH.bg) || "#F5F4EF" : K.PCB_BG || "#001023";
}
/** LAYER_SCHEMATIC_AUX_ITEMS / LAYER_AUX_ITEMS of the active theme (the ruler's colour). */
function auxColor(sch: boolean): string {
  if (!sch) return "#FFFFFF";
  const K = KiCadCanvas as unknown as { schTheme?: () => string };
  return K.schTheme && K.schTheme() === "dark" ? "#FFFFFF" : "#000000";
}

/** SHAPE_LINE_CHAIN::Area( false ) of the closed lasso: > 0 when it is drawn clockwise on screen. */
export function lassoArea(pts: Pt[]): number {
  let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return -a * 0.5;
}

/** SELECTION_AREA::ViewDraw: a one-pixel outline, then the translucent fill. */
function drawSelectionArea(ctx: CanvasRenderingContext2D, px: number, dark: boolean, area: { rect?: [Pt, Pt]; poly?: Pt[]; inside: boolean; additive?: boolean; subtractive?: boolean; exclusiveOr?: boolean }): void {
  const sc = SCHEMES[dark ? 0 : 1];
  const shape = (): boolean => {
    ctx.beginPath();
    if (area.rect) { const [a, b] = area.rect; ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); return true; }
    if (!area.poly || area.poly.length < 2) return false;
    area.poly.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); return true;
  };
  if (!shape()) return;
  ctx.strokeStyle = area.inside ? sc.l2r : sc.r2l; ctx.lineWidth = px; ctx.setLineDash([]); ctx.stroke();
  ctx.fillStyle = area.additive ? sc.additive : area.subtractive ? sc.subtract : area.exclusiveOr ? sc.exclusiveOr : sc.normal; ctx.fill();
}

function drawRuler(ctx: CanvasRenderingContext2D, view: OverlayView, sch: boolean, origin: Pt, end: Pt): void {
  const K = (globalThis as unknown as { KiCadCanvas: StrokeApi }).KiCadCanvas;
  const dpr = view.dpr || 1, s = view.ppm * view.zoom;   // CSS pixels per mm
  const cv = ctx.canvas, W = cv.width / dpr, H = cv.height / dpr;
  const toMm = (p: Pt): Pt => [p[0] / IU, p[1] / IU];
  const rv = {
    scale: s / IU,
    toScreen: (p: Pt): Pt => [(p[0] / IU - view.x0) * s + view.panX, (p[1] / IU - view.y0) * s + view.panY],
    screen: [W, H] as Pt,
    viewport: [(view.x0 - view.panX / s) * IU, (view.y0 - view.panY / s) * IU, (view.x0 + (W - view.panX) / s) * IU, (view.y0 + (H - view.panY) / s) * IU] as [number, number, number, number],
    textWidth: (t: string, size: number, pen: number) => K.strokeLineWidth(t) * size + pen,
  };
  const units = (E.units === "in" || E.units === "mil" ? E.units : "mm") as RulerUnits;
  const ops = rulerOps(origin, end, units, rv);
  const color = auxColor(sch);            // LAYER_AUX_ITEMS / LAYER_SCHEMATIC_AUX_ITEMS
  const shadow = shadowColor(color);
  const m = ctx.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f], minPen = 1 / (s * dpr);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const op of ops) {
    const c = op.shadow ? shadow : color;
    if (op.kind === "line") {
      const a = toMm(op.a), b = toMm(op.b);
      ctx.strokeStyle = c; ctx.lineWidth = Math.max(op.w / IU, minPen); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    } else {
      const at = toMm(op.at);
      K.drawStrokeText(ctx, base, { x: at[0], y: at[1], text: op.text, size: op.size / IU, rot: op.rot, mirror: false, h: op.h, v: "center", pen: op.pen / IU, italic: false, dy: 0 }, c, minPen);
    }
  }
}

/** Everything the app (not a tool module) previews on the canvas. */
export function drawAppOverlays(ctx: CanvasRenderingContext2D, view: OverlayView, sch: boolean): void {
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
  const dark = backgroundDark(themeBackground(sch));   // selectionColorScheme[ IsBackgroundDark() ? 0 : 1 ]
  for (const f of overlayHooks) { try { f(ctx); } catch (e) { console.warn(e); } }   // the selected table cells and their COL_WIDTH / ROW_HEIGHT handles
  if (sch) drawFieldUmbilical(ctx, px);
  const ms = E.measure as { a: Pt; b?: Pt } | null;
  if (ms && ms.b) drawRuler(ctx, view, sch, ms.a, ms.b);
  const bs = E.boxSel as { start: Pt; cur: Pt; pts: Pt[]; lasso: boolean; add?: boolean; mode?: string | null } | null;
  if (bs) {
    const { additive, subtractive } = areaFill(bs, sch);   // SELECTION_AREA::ViewDraw
    if (bs.lasso) drawSelectionArea(ctx, px, dark, { poly: bs.pts, inside: lassoArea(bs.pts) > 0, additive, subtractive });
    else drawSelectionArea(ctx, px, dark, { rect: [bs.start, bs.cur], inside: bs.cur[0] >= bs.start[0], additive, subtractive });
  }
  const zr = E.zoomRect as { a?: Pt; b?: Pt } | null;
  if (zr && zr.a && zr.b) drawSelectionArea(ctx, px, dark, { rect: [zr.a, zr.b], inside: true });
}

/**
 * SCH_PAINTER::draw( SCH_FIELD ): a field moving on its own (IsMoving, parent not moving) draws the umbilical line
 * from its position to its parent's, GetOutlineWidth() (one pixel) in LAYER_SCHEMATIC_ANCHOR.
 */
export function drawFieldUmbilical(ctx: CanvasRenderingContext2D, px: number): void {
  const fd = E.fdrag as { id: string; name: string; moved: boolean } | null;
  if (!fd || !fd.moved || !E.kdoc) return;
  const it = E.kdoc.items.get(fd.id); if (!it) return;
  const K = KiCadCanvas;
  const prop = K.kids(it.node, "property").find((p: SNode) => K.str(p[1]) === fd.name); if (!prop) return;
  const fa = K.kid(prop, "at"), pa = K.kid(it.node, "at"); if (!fa || !pa) return;
  ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.strokeStyle = "#0000FF"; ctx.lineWidth = px; ctx.lineCap = "butt";
  ctx.beginPath(); ctx.moveTo(K.num(fa[1]), K.num(fa[2])); ctx.lineTo(K.num(pa[1]), K.num(pa[2])); ctx.stroke(); ctx.restore();
}
