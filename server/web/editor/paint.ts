// paint.ts — the document pass of the editor's canvas, kept in an offscreen layer.
//
// KiCad's GAL keeps its layers in cached targets and only redraws what changed; the web editor's
// equivalent is one bitmap of the whole document pass (KiCadCanvas.render) that the frame loop
// reuses whenever the document, the display options and the view are unchanged — a hover halo, a
// tool preview, the field selection or the crosshair only blit it and draw themselves on top.
//
//  · pan: the layer is shifted by the (whole device-pixel) offset and only the strips that came into
//    view are rendered (render's `region` option: same transform, same pixels, culled to the strip);
//    a full render follows once the view has rested, so the picture at rest is always a full pass;
//  · zoom animation: while a wheel zoom eases (gestures.ts) and the last full pass was slow, the frames
//    in between scale the layer instead of re-rendering it; the final frame is a full pass;
//  · anything else (an explicit requestRender, a document edit, other options, another size) renders
//    the layer in full.
//
// "Unchanged" is checked, not trusted: every item's geometry array (geometry is rebuilt into a new array,
// web/canvas/geom.ts) and every render option are compared with the ones of the cached pass.

export interface PaintStats { full: number; strips: number; blits: number; scaled: number; lastFullMs: number }

interface Layer {
  cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  view: KView | null; opts: Record<string, unknown> | null; doc: KDoc | null;
  geoms: unknown[]; ms: number;
}

let layer: Layer | null = null;
let restTimer = 0;
export const stats: PaintStats = { full: 0, strips: 0, blits: 0, scaled: 0, lastFullMs: 0 };

function ensureLayer(w: number, h: number): Layer | null {
  if (!layer) {
    const cv = document.createElement("canvas"); const ctx = cv.getContext("2d");
    if (!ctx) return null;
    layer = { cv, ctx, view: null, opts: null, doc: null, geoms: [], ms: 0 };
  }
  if (layer.cv.width !== w || layer.cv.height !== h) { layer.cv.width = w; layer.cv.height = h; layer.view = null; }
  return layer;
}

/** Forget the cached pass (a new document, a theme change …): the next frame renders in full. */
export function invalidateLayer(): void { if (layer) layer.view = null; }

function sameSet(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Set && b instanceof Set) return sameSet(a, b);
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b) && Object.getPrototypeOf(a) === Object.prototype && Object.getPrototypeOf(b) === Object.prototype) return sameOpts(a as Record<string, unknown>, b as Record<string, unknown>);
  return false;
}
function sameOpts(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameValue(a[k], b[k])) return false;
  return true;
}
/** A shallow snapshot of the options: Sets / Maps copied, so later in-place changes are seen. */
function snapshot(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    out[k] = v instanceof Set ? new Set(v) : v instanceof Map ? new Map(v) : v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype ? snapshot(v as Record<string, unknown>) : v;
  }
  return out;
}
function geomsOf(doc: KDoc, into: unknown[]): unknown[] {
  into.length = 0;
  for (const it of doc.items.values()) { const x = it as unknown as { geom: unknown; hiddenGeom?: unknown }; into.push(x.geom, x.hiddenGeom); }
  return into;
}
function sameGeoms(doc: KDoc, prev: unknown[]): boolean {
  if (prev.length !== doc.items.size * 2) return false;
  let i = 0;
  for (const it of doc.items.values()) { const x = it as unknown as { geom: unknown; hiddenGeom?: unknown }; if (prev[i++] !== x.geom || prev[i++] !== x.hiddenGeom) return false; }
  return true;
}
const sameScale = (a: KView, b: KView): boolean => a.ppm === b.ppm && a.zoom === b.zoom && a.x0 === b.x0 && a.y0 === b.y0 && (a.dpr || 1) === (b.dpr || 1);
const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;

function backgroundOf(doc: KDoc, opts: Record<string, unknown>): string | false {
  if (opts.background !== undefined) return opts.background as string | false;
  const K = KiCadCanvas as unknown as { SCH: Record<string, string>; PCB_BG?: string };
  return doc.type === "sch" ? K.SCH.bg : (K.PCB_BG || "#001023");
}

function full(l: Layer, doc: KDoc, view: KView, opts: Record<string, unknown>): void {
  const t0 = performance.now();
  KiCadCanvas.render(doc, l.ctx, view, opts as KRenderOpts);
  l.ms = performance.now() - t0;
  l.view = Object.assign({}, view); l.opts = snapshot(opts); l.doc = doc; geomsOf(doc, l.geoms);
  stats.full++; stats.lastFullMs = l.ms;
}

/**
 * Paint the document pass for `view` onto `target` (which is then ready for the overlays).  `force` renders
 * in full; `scaling` (a zoom animation in flight) lets a slow board show the scaled layer for this frame.
 * A frame that is a stand-in (scaled, or shifted with strips) calls `onRest` once the motion has stopped,
 * for the full pass.
 */
export function paintDocument(doc: KDoc, target: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>, force: boolean, scaling: boolean, onRest: () => void): void {
  const W = target.canvas.width, H = target.canvas.height;
  const l = ensureLayer(W, H);
  if (!l) { KiCadCanvas.render(doc, target, view, opts as KRenderOpts); return; }
  const lv = l.view;
  const reusable = !force && !!lv && l.doc === doc && !!l.opts && sameOpts(opts, l.opts) && sameGeoms(doc, l.geoms);
  let stand = false;
  if (reusable && lv && sameScale(view, lv)) {
    const dpr = view.dpr || 1, dx = (view.panX - lv.panX) * dpr, dy = (view.panY - lv.panY) * dpr;
    if (dx === 0 && dy === 0) stats.blits++;
    else if (l.ms > 6 && whole(dx) && whole(dy) && Math.abs(dx) < W * 0.75 && Math.abs(dy) < H * 0.75) {   // a cheap pass is simply redone
      // shift what is already drawn and render only the strips that came into view
      const ix = Math.round(dx), iy = Math.round(dy), c = l.ctx;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "copy"; c.drawImage(l.cv, ix, iy); c.restore();
      const regions: number[][] = [];
      if (ix > 0) regions.push([0, 0, ix, H]); else if (ix < 0) regions.push([W + ix, 0, W, H]);
      if (iy > 0) regions.push([0, 0, W, iy]); else if (iy < 0) regions.push([0, H + iy, W, H]);
      for (const region of regions) KiCadCanvas.render(doc, c, view, Object.assign({}, opts, { region }) as KRenderOpts);
      l.view = Object.assign({}, view);
      stats.strips++; stand = true;
    } else { full(l, doc, view, opts); }
  } else if (reusable && lv && scaling && l.ms > 12 && (view.dpr || 1) === (lv.dpr || 1) && view.ppm === lv.ppm && view.x0 === lv.x0 && view.y0 === lv.y0) {
    // a zoom frame on a slow board: the cached pass scaled about the same document origin
    const dpr = view.dpr || 1, k = view.zoom / lv.zoom;
    const ox = view.panX * dpr - lv.panX * dpr * k, oy = view.panY * dpr - lv.panY * dpr * k;
    const bg = backgroundOf(doc, opts);
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1;
    if (bg) { target.fillStyle = bg; target.fillRect(0, 0, W, H); } else target.clearRect(0, 0, W, H);
    target.imageSmoothingEnabled = true; target.drawImage(l.cv, ox, oy, W * k, H * k); target.restore();
    stats.scaled++;
    scheduleRest(onRest, 90);
    return;
  } else full(l, doc, view, opts);
  target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = "copy";
  target.drawImage(l.cv, 0, 0); target.restore();
  if (stand) scheduleRest(() => { invalidateLayer(); onRest(); }, 160);
}

function scheduleRest(fn: () => void, ms: number): void {
  if (restTimer) clearTimeout(restTimer);
  restTimer = window.setTimeout(() => { restTimer = 0; fn(); }, ms);
}
