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
//  · zoom animation: on a document whose pass is slow, the frames of a wheel zoom are drawn from zoom
//    levels — the document rendered at a scale at or above the frame's, over the area the zoom will show —
//    always scaled down, never up, so they stay sharp, and shown as a composited plate under the canvas (no copy); the
//    full pass that ends the zoom is rendered in bands in idle time while the level still shows;
//  · anything else (an explicit requestRender, a document edit, other options, another size) renders
//    the layer in full.
//
// "Unchanged" is checked, not trusted: every item's geometry array (geometry is rebuilt into a new array,
// web/canvas/geom.ts) and every render option are compared with the ones of the cached pass.

export interface PaintStats {
  full: number; strips: number; blits: number; scaled: number; lastFullMs: number;
  /** zoom frames drawn from a level (scaled down), level renders made for a frame, prefetch chunks rendered in idle time */
  down: number; levels: number; prefetch: number;
  /** zoom frames of those shown as a composited plate (no copy) */
  plates: number;
  /** the largest frame-to-level scale ratio a zoom frame was drawn with (≤ 1: never scaled up) */
  maxDownK: number;
  /** what the last painted frame was: "full" | "strip" | "blit" | "scaled" | "down", and its view */
  last: string; view: KView | null;
}

interface Layer {
  cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  view: KView | null; opts: Record<string, unknown> | null; doc: KDoc | null;
  geoms: unknown[]; ms: number;
}

let layer: Layer | null = null;
let restTimer = 0;
// KiCad's GAL redraws every zoom frame at full resolution, so a wheel zoom stays sharp.  A scaled-up copy of the cached
// pass is only a stand-in for the first frame of a zoom on a slow document when no zoom level covers it (so the wheel
// answers at once); the level for the frames that follow is rendered on the next frame, so the picture never blurs.
const SCALED_MIN_MS = 33;
// A pass slower than this (render plus its raster, or the measured interval of consecutive full-pass frames) makes the
// zoom frames come from zoom levels; a faster one is simply redone every frame.
const SLOW_MS = 12;
let wasScaling = false;
export const stats: PaintStats = { full: 0, strips: 0, blits: 0, scaled: 0, lastFullMs: 0, down: 0, levels: 0, prefetch: 0, plates: 0, maxDownK: 0, last: "", view: null };
/**
 * Paint tuning the perf probes flip: plate — zoom frames composited from a plate (false: copied into the target);
 * bitmap — complete levels kept as bitmap canvases (false: as the 2D canvases they were rendered in).
 */
export const paintConfig = { plate: true, bitmap: true };

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
export function invalidateLayer(): void { if (layer) layer.view = null; dropLevels(); }

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
/** Device px per mm, and the device px of the document's x = 0 / y = 0 (render's own transform, before a board flip). */
const scaleOf = (v: KView): number => v.ppm * v.zoom * (v.dpr || 1);
const txOf = (v: KView): number => v.panX * (v.dpr || 1) - v.x0 * scaleOf(v);
const tyOf = (v: KView): number => v.panY * (v.dpr || 1) - v.y0 * scaleOf(v);

function backgroundOf(doc: KDoc, opts: Record<string, unknown>): string | false {
  if (opts.background !== undefined) return opts.background as string | false;
  const K = KiCadCanvas as unknown as { SCH: Record<string, string>; PCB_BG?: string };
  return doc.type === "sch" ? K.SCH.bg : (K.PCB_BG || "#001023");
}

function full(l: Layer, doc: KDoc, view: KView, opts: Record<string, unknown>): void {
  restJob = null;   // a banded pass under way is overtaken
  KiCadCanvas.render(doc, l.ctx, view, opts as KRenderOpts);
  l.view = Object.assign({}, view); l.opts = snapshot(opts); l.doc = doc; geomsOf(doc, l.geoms);
  stats.full++;
}

// ---------------------------------------------------------------- zoom levels
// A level is the document pass rendered at scale `s` (device px per mm, ≥ the frame's) into its own canvas, whose pixel
// p shows the document's x = (p - tx) / s.  A zoom frame at scale s' takes the level with the smallest s ≥ s' that covers
// the whole frame and draws it scaled by s' / s ≤ 1.  Levels are made for a frame that none covers (sized for where the
// zoom is heading), ahead of the zoom in idle time (the next level in its direction), and around the view once it rests
// (one level in, one level out), so a notch of the wheel usually finds its frames ready.
//
// Supersampled and scaled down, a level looks like a true pass (strokes keep their weight within the ratio), while a
// pass scaled up — the old stand-in — blurs.  The frame at rest is always a true full pass.

/** The scale range one level serves: from s / LEVEL_SPAN up to s. */
const LEVEL_SPAN = 1.4;
/** The prefetched levels around a view at rest: one in by REST_SPAN (a wheel notch is 1.24), one out by it from any anchor. */
const REST_SPAN = 1.25;
/** The levels kept, in screens' worth of pixels. */
const LEVEL_BUDGET = 8;
const LEVEL_MARGIN = 8;   // device px around a level's area

export interface ZoomHint { to: number; cx: number; cy: number }
type LevelCanvas = HTMLCanvasElement | OffscreenCanvas;
interface Level {
  /** where the level is rendered; once complete, its pixels move into `el` where an OffscreenCanvas can hand them over */
  cv: LevelCanvas; ctx: CanvasRenderingContext2D;
  /** the complete level as a bitmap canvas: what a frame shows (a plate) or copies */
  el: HTMLCanvasElement | null;
  s: number; tx: number; ty: number; w: number; h: number; dpr: number;
  view: KView;      // the view that renders it
  rows: number;     // device rows rendered from the top (h: complete)
  slice: SliceLog | null;   // its last idle slices
  used: number;
}
let levels: Level[] = [];
let levelKey: { doc: KDoc; opts: Record<string, unknown>; geoms: unknown[] } | null = null;
let queue: Level[] = [];
let idleHandle = 0, prefetchTimer = 0;
let flushCtx: CanvasRenderingContext2D | null = null;
// The cost of a full pass: what render and the blit that rasters it took on this thread (jsMs), and — where the raster
// runs elsewhere (a GPU) — the interval between consecutive zoom frames that were both full passes (frameMs, kept
// until measured again).
let jsMs = 0, frameMs = 0;
const costOf = (): number => Math.max(jsMs, frameMs);
let lastPaint = 0, lastWasFull = false;
// the full pass at the end of a zoom drawn from a level waits this long for another notch
const REST_DELAY_MS = 150;
let restPending = false;
/** The coming "rest" pass is the one that ends a zoom (not a pan's): it may be rendered in bands. */
let restFromZoom = false;

function dropLevels(): void {
  hidePlate(); restJob = null; restPending = false;
  for (const L of levels) freeLevel(L);
  levels = []; queue = []; levelKey = null;
}
/** Let go of the cached pass and the zoom levels (the document closed): their memory is freed at once. */
export function releaseLayers(): void {
  dropLevels();
  if (layer) { layer.cv.width = 0; layer.cv.height = 0; layer = null; }
}
function levelsValid(doc: KDoc, opts: Record<string, unknown>): boolean {
  return !!levelKey && levelKey.doc === doc && sameOpts(opts, levelKey.opts) && sameGeoms(doc, levelKey.geoms);
}
function keyLevels(doc: KDoc, opts: Record<string, unknown>): void {
  if (levelKey) return;
  levelKey = { doc, opts: snapshot(opts), geoms: geomsOf(doc, []) };
}

/** Where level L lands on a frame of `view`: the scale factor and the offset of its pixel 0, 0. */
function placement(L: Level, view: KView): { k: number; ox: number; oy: number } {
  const k = scaleOf(view) / L.s;
  return { k, ox: txOf(view) - k * L.tx, oy: tyOf(view) - k * L.ty };
}
function covers(L: Level, view: KView, W: number, H: number): boolean {
  const s = scaleOf(view);
  if (L.dpr !== (view.dpr || 1) || L.s < s * (1 - 1e-9) || L.s > s * LEVEL_SPAN * 1.02) return false;
  const { k, ox, oy } = placement(L, view), e = 0.01;
  return ox <= e && oy <= e && ox + k * L.w >= W - e && oy + k * L.h >= H - e;
}
function findLevel(view: KView, W: number, H: number, complete: boolean): Level | null {
  let best: Level | null = null;
  for (const L of levels) if ((!complete || L.rows >= L.h) && covers(L, view, W, H) && (!best || L.s < best.s || (L.s === best.s && L.rows > best.rows))) best = L;
  return best;
}

/**
 * A level at scale S (≥ the frame's s) over the frame-pixel rect [x0, x1] × [y0, y1] of `view` (its area at scale s).
 * Not rendered yet (rows 0).
 */
function newLevel(view: KView, S: number, x0: number, y0: number, x1: number, y1: number): Level | null {
  const dpr = view.dpr || 1, s = scaleOf(view), r = S / s, M = LEVEL_MARGIN;
  const w = Math.ceil((x1 - x0) * r) + 2 * M, h = Math.ceil((y1 - y0) * r) + 2 * M;
  if (w <= 0 || h <= 0 || w > 16000 || h > 16000) return null;
  // the level's own pixel M, M shows frame pixel x0, y0: frame = k·p + (tx_f − k·tx_L) with k = s / S
  const tx = M + (txOf(view) - x0) * r, ty = M + (tyOf(view) - y0) * r;
  const lv: KView = Object.assign({}, view, { zoom: S / (view.ppm * dpr), panX: (tx + view.x0 * S) / dpr, panY: (ty + view.y0 * S) / dpr });
  // an OffscreenCanvas where there is one, so the finished level can become a bitmap (sealLevel)
  let cv: LevelCanvas;
  if (paintConfig.bitmap && typeof OffscreenCanvas !== "undefined") cv = new OffscreenCanvas(w, h);
  else { cv = document.createElement("canvas"); cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d") as CanvasRenderingContext2D | null; if (!ctx) return null;
  const L: Level = { cv, ctx, el: null, s: S, tx, ty, w, h, dpr, view: lv, rows: 0, slice: null, used: performance.now() };
  levels.push(L);
  // keep the budget: the least recently used complete levels go first
  const budget = LEVEL_BUDGET * Math.max(1, (layer ? layer.cv.width * layer.cv.height : w * h));
  let total = 0; for (const x of levels) total += x.w * x.h;
  const byAge = levels.filter((x) => x !== L).sort((a, b) => a.used - b.used);
  for (const x of byAge) {
    if (total <= budget) break;
    total -= x.w * x.h; freeLevel(x);
    levels = levels.filter((y) => y !== x); queue = queue.filter((y) => y !== x);
  }
  return L;
}

/** Render what is left of level L (all of it, or the band of rows up to `upTo`), and push it through the raster. */
function renderLevel(L: Level, doc: KDoc, opts: Record<string, unknown>, upTo = L.h): void {
  if (L.rows >= upTo) return;
  const y0 = L.rows, y1 = Math.min(L.h, upTo);
  if (y0 === 0 && y1 === L.h) KiCadCanvas.render(doc, L.ctx, L.view, opts as KRenderOpts);
  else KiCadCanvas.render(doc, L.ctx, L.view, Object.assign({}, opts, { region: [0, y0, L.w, y1] }) as KRenderOpts);
  L.rows = y1;
  if (L.rows >= L.h && sealLevel(L)) return;
  // a canvas records its drawing and rasters it when it is first read: read one pixel's worth now, so the raster
  // happens in this slice of time and not in the frame that first shows the level
  if (!flushCtx) { const c = document.createElement("canvas"); c.width = 1; c.height = 1; flushCtx = c.getContext("2d"); }
  if (flushCtx) flushCtx.drawImage(L.cv, 0, 0, 1, 1, 0, 0, 1, 1);
}

/**
 * A complete level's pixels handed over (no copy) from its OffscreenCanvas to a bitmap canvas.  The compositor moves a
 * bitmap canvas under a CSS transform as it is, where a 2D canvas is re-sent to it on every frame that moves it (on a
 * CPU raster that is a copy of the whole level per frame).
 */
function sealLevel(L: Level): boolean {
  const oc = L.cv as OffscreenCanvas;
  if (typeof oc.transferToImageBitmap !== "function") return false;
  const el = document.createElement("canvas"); el.width = L.w; el.height = L.h;
  const bc = el.getContext("bitmaprenderer");
  if (!bc) return false;
  bc.transferFromImageBitmap(oc.transferToImageBitmap());
  oc.width = 1; oc.height = 1;   // the transfer left it a blank buffer of the level's size
  L.el = el;
  return true;
}
const levelImage = (L: Level): CanvasImageSource => (L.el || L.cv) as CanvasImageSource;
function freeLevel(L: Level): void {
  if (plate && plate === L.el) hidePlate();
  if (plate && plate === L.cv) hidePlate();
  try { L.cv.width = 0; L.cv.height = 0; } catch { /* an OffscreenCanvas that will not shrink is freed with the level */ }
  if (L.el) { const bc = L.el.getContext("bitmaprenderer"); if (bc) bc.transferFromImageBitmap(null); L.el.width = 0; L.el.height = 0; L.el = null; }
}

/**
 * The level a zoom frame with nothing ready renders now: a whole span in the zoom's direction (a burst of notches keeps
 * going, and a level made only up to where the zoom is heading would be outrun by the next notch at once).
 */
function levelFor(view: KView, hint: ZoomHint, W: number, H: number): Level | null {
  const dpr = view.dpr || 1, s = scaleOf(view), sT = view.ppm * hint.to * dpr;
  if (sT > s) return newLevel(view, s * LEVEL_SPAN, 0, 0, W, H);   // zooming in: the view now holds every later one
  // zooming out (or holding): this scale, over the view the zoom shows at s / LEVEL_SPAN about its anchor
  const r = LEVEL_SPAN, ax = hint.cx * dpr, ay = hint.cy * dpr;
  return newLevel(view, s, ax - ax * r, ay - ay * r, ax + (W - ax) * r, ay + (H - ay) * r);
}

/** Queue the level after L in the zoom's direction, to be rendered in idle time while the frames come from L. */
function prefetchAhead(L: Level, view: KView, hint: ZoomHint, W: number, H: number): void {
  const dpr = view.dpr || 1, s = scaleOf(view), sT = view.ppm * hint.to * dpr;
  if (Math.abs(sT / s - 1) < 1e-3) return;
  const ax = hint.cx * dpr, ay = hint.cy * dpr;
  // in: the next level starts where L ends (the view at scale L.s is the frame's shrunk about the anchor) and goes up a
  // span; out: it serves from L's lowest scale down a span (the view there is the frame's grown about the anchor)
  const S = sT > s ? L.s * LEVEL_SPAN : L.s / LEVEL_SPAN, r = sT > s ? s / L.s : s / (S / LEVEL_SPAN);
  if (levels.some((x) => x.dpr === dpr && Math.abs(x.s / S - 1) < 0.05)) return;
  const x0 = ax - ax * r, x1 = ax + (W - ax) * r, y0 = ay - ay * r, y1 = ay + (H - ay) * r;
  const N = newLevel(view, S, x0, y0, x1, y1);
  if (N) { queue.push(N); scheduleIdle(); }
}

/** After a pass at rest: one level in and one out around the view, rendered in idle time. */
function prefetchRest(view: KView, W: number, H: number): void {
  const s = scaleOf(view), dpr = view.dpr || 1;
  const want: [number, number, number, number, number][] = [
    [s * REST_SPAN, 0, 0, W, H],                                                                    // in, from any anchor
    [s, W * (1 - REST_SPAN), H * (1 - REST_SPAN), W * REST_SPAN, H * REST_SPAN],                     // out, from any anchor
  ];
  for (const [S, x0, y0, x1, y1] of want) {
    // already there (a level of the zoom that just ended)?
    const have = levels.some((L) => L.dpr === dpr && L.s >= S * 0.999 && L.s <= S * 1.1 && (S > s ? coversShrunk(L, view, W, H) : coversGrown(L, view, REST_SPAN, W, H)));
    if (have) continue;
    const N = newLevel(view, S, x0, y0, x1, y1);
    if (N) queue.push(N);
  }
  if (queue.length) scheduleIdle();
}
/** L covers the frame view as it is (the rect every zoom-in from here stays within). */
function coversShrunk(L: Level, view: KView, W: number, H: number): boolean {
  const k = scaleOf(view) / L.s, ox = txOf(view) - k * L.tx, oy = tyOf(view) - k * L.ty;
  return ox <= 0.01 && oy <= 0.01 && ox + k * L.w >= W - 0.01 && oy + k * L.h >= H - 0.01;
}
/** L covers the frame view grown by r on every side's anchor range ([W(1−r), W·r]). */
function coversGrown(L: Level, view: KView, r: number, W: number, H: number): boolean {
  const k = scaleOf(view) / L.s, ox = txOf(view) - k * L.tx, oy = tyOf(view) - k * L.ty;
  return ox <= W * (1 - r) + 0.01 && oy <= H * (1 - r) + 0.01 && ox + k * L.w >= W * r - 0.01 && oy + k * L.h >= H * r - 0.01;
}

type IdleDeadline = { timeRemaining(): number; didTimeout?: boolean };
type IdleFn = (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => number;
function scheduleIdle(): void {
  if (idleHandle) return;
  const ric = (window as unknown as { requestIdleCallback?: IdleFn }).requestIdleCallback;
  const run = (d?: IdleDeadline): void => { idleHandle = 0; idleStep(d || null); };
  idleHandle = ric ? ric(run, { timeout: 200 }) : window.setTimeout(run, 20);
}

// Idle work comes in slices sized to fit the idle period (at most SLICE_MAX_MS), from the measured cost of a device pixel
// of the pass (render plus raster), so a wheel notch or a pointer move that arrives meanwhile waits for one short slice.
const SLICE_MIN_MS = 6, SLICE_MAX_MS = 16;
let pxMs = 0;   // ms per device pixel of a pass slice, smoothed
const sliceBudget = (d: IdleDeadline | null): number => Math.max(SLICE_MIN_MS, Math.min(SLICE_MAX_MS, d && !d.didTimeout ? d.timeRemaining() - 1 : SLICE_MIN_MS));
/** A target's last idle slices: rows and ms of the last one and the one before. */
interface SliceLog { rows: number; ms: number; prev: { rows: number; ms: number } | null }
function logSlice(log: SliceLog | null, rows: number, ms: number): SliceLog { return { rows, ms, prev: log ? { rows: log.rows, ms: log.ms } : null }; }
/**
 * Rows of a w-px-wide target that one slice of `ms` renders.  A slice costs render's fixed cost per call plus a cost per
 * row: both are read off the target's last two slices; with one slice its rows are scaled by how far its time was from
 * the budget; with none, the smoothed cost of a pixel decides.  Where the fixed cost is most of the budget, a slice is made
 * about twice the fixed cost, so the band is never mostly overhead.
 */
function sliceRows(w: number, ms: number, log: SliceLog | null): number {
  const MIN = 32;
  if (log && log.rows > 0 && log.ms > 0) {
    const cap = log.rows * 2;   // content is not even down a level: grow a band step by step
    if (log.prev && log.prev.rows !== log.rows) {
      const per = Math.max((log.ms - log.prev.ms) / (log.rows - log.prev.rows), 0.1 * log.ms / log.rows), fixed = Math.max(0, log.ms - per * log.rows);
      return Math.round(Math.min(cap, Math.max(MIN, (ms - fixed) / per, fixed / per)));
    }
    // one slice to go by: scaled to the budget, and never the same rows again, so the next fit has two points
    let n = Math.round(Math.min(cap, Math.max(MIN, log.rows * Math.min(2, Math.max(0.5, ms / log.ms)))));
    if (n === log.rows) n = n > MIN ? Math.max(MIN, Math.round(n * 0.75)) : Math.round(n * 1.5);
    return n;
  }
  const per = (pxMs > 0 ? pxMs : (layer && layer.cv.width ? costOf() / (layer.cv.width * layer.cv.height) : 0)) * w;
  return per > 0 ? Math.max(MIN, Math.floor(ms / per)) : 64;
}
function notePxMs(ms: number, px: number): void { if (px > 0) { const v = ms / px; pxMs = pxMs ? pxMs * 0.6 + v * 0.4 : v; } }

/** Idle work: the banded rest pass first, then one slice of the oldest queued level. */
function idleStep(d: IdleDeadline | null): void {
  const budget = sliceBudget(d);
  if (restJob) { restStep(budget); if (restJob || queue.length) scheduleIdle(); return; }
  queue = queue.filter((L) => levels.indexOf(L) >= 0 && L.rows < L.h);
  const L = queue[0];
  if (!L || !levelKey) return;
  const t = performance.now(), r0 = L.rows;
  renderLevel(L, levelKey.doc, levelKey.opts, L.rows + sliceRows(L.w, budget, L.slice));
  const dt = performance.now() - t; L.slice = logSlice(L.slice, L.rows - r0, dt);
  notePxMs(dt, (L.rows - r0) * L.w);
  stats.prefetch++;
  if (L.rows >= L.h) queue.shift();
  if (queue.length) scheduleIdle();
}

// ---------------------------------------------------------------- the rest pass in bands
// The full pass that ends a zoom drawn from levels is rendered into the layer a band at a time in idle time, while the
// frames keep showing the level; when the last band is in, the next frame shows the layer: the full pass at the view the
// zoom ended on.  A band is render's own region pass (as a pan's strips are); within a few pixels of a band's edge Skia's
// clip leaves a faint difference from one unclipped pass (about 0.1% of the pixels, mean under 0.01/255).  Any change of
// view, document or options drops the job.
interface RestJob { doc: KDoc; view: KView; opts: Record<string, unknown>; geoms: unknown[]; W: number; H: number; rows: number; ms: number; slice: SliceLog | null; repaint: () => void }
let restJob: RestJob | null = null;
/** A completed banded rest pass not shown yet: the frame that blits it is that pass's frame. */
let restShown = true;
const sameView = (a: KView, b: KView): boolean => sameScale(a, b) && a.panX === b.panX && a.panY === b.panY;

function restStep(budget: number): void {
  const j = restJob!, l = layer;
  if (!l || l.cv.width !== j.W || l.cv.height !== j.H) { restJob = null; j.repaint(); return; }
  const t = performance.now(), y0 = j.rows, y1 = Math.min(j.H, y0 + sliceRows(j.W, budget, j.slice));
  KiCadCanvas.render(j.doc, l.ctx, j.view, Object.assign({}, j.opts, { region: [0, y0, j.W, y1] }) as KRenderOpts);
  if (!flushCtx) { const c = document.createElement("canvas"); c.width = 1; c.height = 1; flushCtx = c.getContext("2d"); }
  if (flushCtx) flushCtx.drawImage(l.cv, 0, 0, 1, 1, 0, 0, 1, 1);
  const dt = performance.now() - t; j.ms += dt; j.rows = y1; j.slice = logSlice(j.slice, y1 - y0, dt);
  notePxMs(dt, (y1 - y0) * j.W);
  if (j.rows < j.H) return;
  restJob = null;
  if (!sameGeoms(j.doc, j.geoms)) { j.repaint(); return; }   // edited meanwhile: the next frame renders afresh
  l.view = Object.assign({}, j.view); l.opts = j.opts; l.doc = j.doc; l.geoms = j.geoms; l.ms = j.ms;
  stats.full++; stats.lastFullMs = j.ms; jsMs = Math.max(jsMs * 0.7, j.ms);
  restPending = false; restShown = false;
  j.repaint();
}
function startRest(l: Layer, doc: KDoc, view: KView, opts: Record<string, unknown>, repaint: () => void): void {
  l.view = null;
  restJob = { doc, view: Object.assign({}, view), opts: snapshot(opts), geoms: geomsOf(doc, []), W: l.cv.width, H: l.cv.height, rows: 0, ms: 0, slice: null, repaint };
  restPending = true;
  if (restTimer) { clearTimeout(restTimer); restTimer = 0; }
  scheduleIdle();
}

// A zoom frame shows its level as a plate: the level's own canvas, placed under the (cleared) target canvas with a CSS
// transform, so the compositor scales it — on the GPU where there is one, and off the main thread where there is not —
// instead of a scaled copy into the target on every frame.  The overlays the frame draws next land on the cleared target,
// over the plate, as they would over the copy.  The plate goes as soon as a frame draws the document into the target.
let plate: HTMLCanvasElement | null = null;
function hidePlate(): void {
  if (!plate) return;
  if (plate.parentNode) plate.parentNode.removeChild(plate);
  plate = null;
}
function showPlate(target: CanvasRenderingContext2D, L: Level, k: number, ox: number, oy: number): boolean {
  const cv = target.canvas as HTMLCanvasElement, parent = cv.parentNode;
  if (!paintConfig.plate || !parent || typeof cv.getBoundingClientRect !== "function") return false;
  const pl = (L.el || L.cv) as HTMLCanvasElement;
  if (!pl.style) return false;   // an OffscreenCanvas not sealed
  const st = pl.style, dpr = L.dpr;
  if (plate !== pl) {
    hidePlate();
    st.position = "absolute"; st.left = "0"; st.top = "0"; st.margin = "0"; st.transformOrigin = "0 0"; st.pointerEvents = "none"; st.willChange = "transform";
    parent.insertBefore(pl, cv);
    plate = pl;
  }
  const wc = L.w / dpr + "px", hc = L.h / dpr + "px";
  if (st.width !== wc) st.width = wc;
  if (st.height !== hc) st.height = hc;
  st.transform = `translate(${ox / dpr}px, ${oy / dpr}px) scale(${k})`;
  target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, cv.width, cv.height); target.restore();
  return true;
}

function blitLevel(target: CanvasRenderingContext2D, L: Level, view: KView): void {
  const { k, ox, oy } = placement(L, view);
  L.used = performance.now();
  stats.down++; stats.maxDownK = Math.max(stats.maxDownK, k); stats.last = "down";
  if (showPlate(target, L, k, ox, oy)) { stats.plates++; return; }
  hidePlate();
  target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = "copy";
  // bilinear: a level is never more than LEVEL_SPAN above the frame, so every source pixel is sampled (mipmaps would
  // only soften it), and it is the cheapest filter where the canvas rasters on the CPU
  target.imageSmoothingEnabled = true; target.imageSmoothingQuality = "low";
  target.drawImage(levelImage(L), ox, oy, L.w * k, L.h * k);
  target.restore();
}

/**
 * Paint the document pass for `view` onto `target` (which is then ready for the overlays).  `forceIn` renders
 * in full (true: anything may have changed; "rest": only the view did, the zoom levels are kept), or marks the last
 * frame of a wheel zoom ("zoomEnd"); `zoom` (a zoom animation in flight: its target zoom and anchor) lets a slow
 * document draw this frame from a zoom level.
 * A frame that is a stand-in (scaled, or shifted with strips) calls `onRest` once the motion has stopped,
 * for the full pass.
 */
export function paintDocument(doc: KDoc, target: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>, forceIn: boolean | "rest" | "zoomEnd", zoom: ZoomHint | null, onRest: () => void, repaint: () => void = onRest): void {
  const W = target.canvas.width, H = target.canvas.height;
  stats.view = view;
  const now = performance.now(), sincePaint = now - lastPaint; lastPaint = now;
  const l = ensureLayer(W, H);
  if (!l) { hidePlate(); KiCadCanvas.render(doc, target, view, opts as KRenderOpts); wasScaling = !!zoom; return; }
  // the cost of a pass: what render and its raster took, or — where the raster runs elsewhere (a GPU) — the interval
  // between two frames that were both full passes
  if (lastWasFull && zoom && sincePaint < 250) frameMs = frameMs ? (frameMs + sincePaint - 2) / 2 : sincePaint - 2;
  const costMs = costOf();
  lastWasFull = false;
  // "zoomEnd": the last frame of a wheel zoom, drawn from a level when one is ready, with the full pass a moment later
  // (a notch that follows at once goes on from the levels); "rest": that full pass, or another one of an unchanged
  // document (a pan's), which keeps the levels; any other forced pass may show a changed document and drops them
  const zoomEnd = forceIn === "zoomEnd", force = zoomEnd ? false : forceIn;
  if (force && force !== "rest") dropLevels();
  // a banded rest pass goes on only while nothing but repaints happen
  if (restJob && (force || zoom || zoomEnd || W !== restJob.W || H !== restJob.H || restJob.doc !== doc || !sameView(view, restJob.view) || !sameOpts(opts, restJob.opts))) { restJob = null; restPending = false; }
  if (zoom || (force && !restJob)) restPending = false;
  const lv = l.view;
  // (walks every item: asked only where it matters)
  const isReusable = (): boolean => !force && !!lv && l.doc === doc && !!l.opts && sameOpts(opts, l.opts) && sameGeoms(doc, l.geoms);
  let stand = false;
  const fromZoom = restFromZoom; restFromZoom = false;
  if (force === "rest" && fromZoom && !restJob && costMs > SLOW_MS && levelKey && levelsValid(doc, opts)) {
    // the pass that ends a zoom drawn from levels: in bands, while this frame (and any repaint until it is done) shows the level
    const L = findLevel(view, W, H, true);
    if (L) { startRest(l, doc, view, opts, repaint); blitLevel(target, L, view); wasScaling = true; return; }
  }
  if ((zoom || zoomEnd || restPending) && !force && costMs > SLOW_MS && (!lv || !sameScale(view, lv))) {
    // a zoom frame on a slow document: drawn from a zoom level
    if (levelKey && !levelsValid(doc, opts)) dropLevels();
    keyLevels(doc, opts);
    let L = findLevel(view, W, H, true) || findLevel(view, W, H, false);
    if (!L && zoom && !wasScaling && lv && costMs > SCALED_MIN_MS && (view.dpr || 1) === (lv.dpr || 1) && view.ppm === lv.ppm && view.x0 === lv.x0 && view.y0 === lv.y0 && isReusable()) {
      // the first frame of a zoom and nothing ready: the cached pass scaled about the same document origin, at once
      const dpr = view.dpr || 1, k = view.zoom / lv.zoom;
      const ox = view.panX * dpr - lv.panX * dpr * k, oy = view.panY * dpr - lv.panY * dpr * k;
      const bg = backgroundOf(doc, opts);
      hidePlate(); target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1;
      if (bg) { target.fillStyle = bg; target.fillRect(0, 0, W, H); } else target.clearRect(0, 0, W, H);
      target.imageSmoothingEnabled = true; target.drawImage(l.cv, ox, oy, W * k, H * k); target.restore();
      stats.scaled++; stats.last = "scaled"; wasScaling = true;
      // the level for the frames that follow is made on the next frame; the full pass follows when the zoom ends
      return;
    }
    if (!L && zoom) { L = levelFor(view, zoom, W, H); if (L) stats.levels++; }
    if (L) {
      if (L.rows < L.h) { renderLevel(L, doc, opts); queue = queue.filter((x) => x !== L); }
      blitLevel(target, L, view);
      if (zoom) prefetchAhead(L, view, zoom, W, H);
      wasScaling = wasScaling || !!zoom;   // a zoom's last frame keeps it: a notch right after goes on from the levels
      if (zoom) { if (restTimer) { clearTimeout(restTimer); restTimer = 0; } }
      else if (zoomEnd) { restPending = true; scheduleRest(() => { restPending = false; restFromZoom = true; onRest(); }, REST_DELAY_MS); }
      return;
    }
  }
  if (lv && sameScale(view, lv) && isReusable()) {
    const dpr = view.dpr || 1, dx = (view.panX - lv.panX) * dpr, dy = (view.panY - lv.panY) * dpr;
    if (dx === 0 && dy === 0) {
      // the first showing of a banded rest pass is that full pass's frame
      if (!restShown) { restShown = true; stats.last = "full"; finishFull(doc, view, opts, zoom, W, H); }
      else { stats.blits++; stats.last = "blit"; }
    }
    else if (l.ms > 6 && whole(dx) && whole(dy) && Math.abs(dx) < W * 0.75 && Math.abs(dy) < H * 0.75) {   // a cheap pass is simply redone
      // shift what is already drawn and render only the strips that came into view
      const ix = Math.round(dx), iy = Math.round(dy), c = l.ctx;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "copy"; c.drawImage(l.cv, ix, iy); c.restore();
      const regions: number[][] = [];
      if (ix > 0) regions.push([0, 0, ix, H]); else if (ix < 0) regions.push([W + ix, 0, W, H]);
      if (iy > 0) regions.push([0, 0, W, iy]); else if (iy < 0) regions.push([0, H + iy, W, H]);
      for (const region of regions) KiCadCanvas.render(doc, c, view, Object.assign({}, opts, { region }) as KRenderOpts);
      l.view = Object.assign({}, view);
      stats.strips++; stats.last = "strip"; stand = true;
    } else { fullAndBlit(l, doc, view, opts, target, now); return finishFull(doc, view, opts, zoom, W, H); }
  } else { fullAndBlit(l, doc, view, opts, target, now); return finishFull(doc, view, opts, zoom, W, H); }
  wasScaling = !!zoom;
  hidePlate(); target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = "copy";
  target.drawImage(l.cv, 0, 0); target.restore();
  if (stand) scheduleRest(() => { invalidateLayerOnly(); onRest(); }, 160);
}

function invalidateLayerOnly(): void { if (layer) layer.view = null; }

/** A full pass into the layer and onto the target, timed with its raster (the blit reads the layer). */
function fullAndBlit(l: Layer, doc: KDoc, view: KView, opts: Record<string, unknown>, target: CanvasRenderingContext2D, t0: number): void {
  full(l, doc, view, opts);
  hidePlate(); target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = "copy";
  target.drawImage(l.cv, 0, 0); target.restore();
  l.ms = performance.now() - t0; stats.lastFullMs = l.ms; stats.last = "full"; restShown = true;
  jsMs = Math.max(jsMs * 0.7, l.ms);
  lastWasFull = true;
}
function finishFull(doc: KDoc, view: KView, opts: Record<string, unknown>, zoom: ZoomHint | null, W: number, H: number): void {
  wasScaling = !!zoom;
  if (zoom || costOf() <= SLOW_MS) return;
  // at rest on a slow document: the levels a next wheel notch needs, in idle time once the view has stayed a moment
  if (levelKey && !levelsValid(doc, opts)) dropLevels();
  if (prefetchTimer) clearTimeout(prefetchTimer);
  const v = Object.assign({}, view);
  prefetchTimer = window.setTimeout(() => {
    prefetchTimer = 0;
    if (!layer || !layer.view || layer.doc !== doc || !sameScale(layer.view, v) || layer.view.panX !== v.panX || layer.view.panY !== v.panY) return;   // moved on
    if (levelKey && !levelsValid(doc, opts)) dropLevels();
    keyLevels(doc, opts);
    prefetchRest(v, W, H);
  }, 400);
}

function scheduleRest(fn: () => void, ms: number): void {
  if (restTimer) clearTimeout(restTimer);
  restTimer = window.setTimeout(() => { restTimer = 0; fn(); }, ms);
}
