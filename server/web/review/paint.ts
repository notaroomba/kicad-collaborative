// review/paint.ts — draws two versions of a document and the difference between them.
//
// The documents are drawn by the editor's own painter (KiCadCanvas.render), so a compared sheet looks
// exactly as it does in the editor.  What changed is drawn on top in KiCad's diff colours (green added,
// red removed, amber modified — DIFF_COLOR_THEME, include/diff_merge/diff_scene.h): the changed items
// are rendered alone on a scratch canvas, washed in their category's colour, and laid over the rest of
// the sheet, which is dimmed so the changes carry the picture.  Every change also gets its outline box,
// as in KiCad's dialog, so that a moved via or a one-letter edit can still be found.
import type { Category, Change, DocDiff } from "./diff";

export type Mode = "overlay" | "side" | "swipe";
/** px per mm (css) and the document point at the middle of the canvas */
export interface DiffView { scale: number; cx: number; cy: number }

export interface PaintInput {
  a: KDoc; b: KDoc; diff: DocDiff;
  /** categories switched off in the legend */
  show: Record<Category, boolean>;
  /** rows hidden one by one (KiCad's "Hide Change") */
  hiddenRows: Set<string>;
  /** rows the filter box leaves out */
  rows: Change[];
  selected: Change | null;
  hiddenLayers: Set<string>;
  dpr: number;
}

// KiCad's theme is made for a near-white sheet; a board is drawn on a dark ground, where the same
// hues are used a step lighter so they do not sink into the copper colours.
export const DIFF_COLORS: Record<"sch" | "pcb", Record<Category, string>> = {
  sch: { added: "rgb(51,166,51)", removed: "rgb(204,51,51)", modified: "rgb(217,166,26)" },
  pcb: { added: "rgb(80,220,90)", removed: "rgb(255,82,82)", modified: "rgb(255,196,46)" },
};

const K = (): KiCadCanvasApi => window.KiCadCanvas;
type RenderOpts = KRenderOpts & Record<string, unknown>;

const scratch: Record<string, HTMLCanvasElement> = {};
function scratchCtx(name: string, w: number, h: number): CanvasRenderingContext2D | null {
  const cv = scratch[name] || (scratch[name] = document.createElement("canvas"));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv.getContext("2d");
}

function kview(view: DiffView, wCss: number, hCss: number, dpr: number): KView {
  return { ppm: 1, zoom: view.scale, panX: wCss / 2 - view.cx * view.scale, panY: hCss / 2 - view.cy * view.scale, x0: 0, y0: 0, dpr };
}
function background(doc: KDoc): string {
  const k = K() as unknown as { SCH: Record<string, string>; PCB_BG?: string };
  return doc.type === "sch" ? k.SCH.bg : k.PCB_BG || "#001023";
}

/** Render `ids` of `doc` alone and wash them in `color`; the result is drawn onto `ctx` at `alpha`. */
function layer(ctx: CanvasRenderingContext2D, doc: KDoc, ids: Set<string>, color: string | null, alpha: number, kv: KView, hidden: Set<string>): void {
  if (!ids.size) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const s = scratchCtx("tint", W, H); if (!s) return;
  const opts: RenderOpts = { hidden, grid: 0, frame: false, background: false, ids, markers: null, ratsnest: null, highlight: null, selected: null, netNames: false };
  K().render(doc, s, kv, opts);
  s.setTransform(1, 0, 0, 1, 0, 0);
  if (color) { s.globalCompositeOperation = "source-atop"; s.globalAlpha = 0.78; s.fillStyle = color; s.fillRect(0, 0, W, H); s.globalAlpha = 1; s.globalCompositeOperation = "source-over"; }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(s.canvas, 0, 0); ctx.restore();
}

/** A whole document, dimmed toward its background when `dim` > 0, leaving out `skip`. */
function sheet(ctx: CanvasRenderingContext2D, doc: KDoc, kv: KView, hidden: Set<string>, skip: Set<string> | null, dim: number): void {
  const opts: RenderOpts = { hidden, grid: 0, markers: null, ratsnest: null, highlight: null, selected: null };
  if (skip && skip.size) opts.skip = skip;
  K().render(doc, ctx, kv, opts);
  if (dim > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = dim; ctx.fillStyle = background(doc); ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore(); }
}

function visibleIds(input: PaintInput): { added: Set<string>; removed: Set<string>; modified: Set<string>; modifiedOld: Set<string>; rows: Change[] } {
  const out = { added: new Set<string>(), removed: new Set<string>(), modified: new Set<string>(), modifiedOld: new Set<string>(), rows: [] as Change[] };
  for (const c of input.rows) {
    if (!input.show[c.category] || input.hiddenRows.has(c.key)) continue;
    out.rows.push(c);
    if (c.category === "added") for (const id of c.ids) out.added.add(id);
    else if (c.category === "removed") for (const id of c.oldIds) out.removed.add(id);
    else { for (const id of c.ids) out.modified.add(id); for (const id of c.oldIds) out.modifiedOld.add(id); }
  }
  return out;
}

/** The outline box of every visible change; the selected one is filled and drawn heavier. */
function boxes(ctx: CanvasRenderingContext2D, input: PaintInput, rows: Change[], view: DiffView, only: Category[] | null): void {
  const W = ctx.canvas.width, H = ctx.canvas.height, dpr = input.dpr, s = view.scale * dpr;
  const colors = DIFF_COLORS[input.diff.type];
  const pad = (input.diff.type === "sch" ? 0.8 : 0.35) * s;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const c of rows) {
    if (!c.bbox || (only && !only.includes(c.category))) continue;
    const x0 = (c.bbox[0] - view.cx) * s + W / 2 - pad, y0 = (c.bbox[1] - view.cy) * s + H / 2 - pad;
    const w = (c.bbox[2] - c.bbox[0]) * s + 2 * pad, h = (c.bbox[3] - c.bbox[1]) * s + 2 * pad;
    if (x0 > W || y0 > H || x0 + w < 0 || y0 + h < 0) continue;
    const sel = input.selected === c;
    ctx.strokeStyle = colors[c.category]; ctx.lineWidth = (sel ? 2.5 : 1) * dpr; ctx.globalAlpha = sel ? 1 : 0.75;
    // a change too small to see at this zoom still shows as a box of a few pixels
    const mw = Math.max(w, 7 * dpr), mh = Math.max(h, 7 * dpr), mx = x0 - (mw - w) / 2, my = y0 - (mh - h) / 2;
    if (sel) { ctx.fillStyle = colors[c.category]; ctx.globalAlpha = 0.14; ctx.fillRect(mx, my, mw, mh); ctx.globalAlpha = 1; }
    ctx.strokeRect(Math.round(mx) + 0.5, Math.round(my) + 0.5, Math.round(mw), Math.round(mh));
  }
  ctx.restore();
}

/**
 * Paint one canvas.  `side` picks what it shows: "both" (the overlay), "before" or "after" (the halves
 * of side by side), or "swipe" with the divider at `split` (0–1 of the width): the older version left
 * of it, the newer one right of it, both in their own colours.
 */
export function paint(ctx: CanvasRenderingContext2D, wCss: number, hCss: number, view: DiffView, input: PaintInput, side: "both" | "before" | "after" | "swipe", split = 0.5): void {
  const dpr = input.dpr, kv = kview(view, wCss, hCss, dpr), hidden = input.hiddenLayers;
  const colors = DIFF_COLORS[input.diff.type];
  const v = visibleIds(input);
  const dim = input.diff.type === "sch" ? 0.62 : 0.68;
  if (side === "swipe") {
    const W = ctx.canvas.width, H = ctx.canvas.height, x = Math.round(W * split);
    sheet(ctx, input.b, kv, hidden, null, 0);
    const s = scratchCtx("half", W, H);
    if (s) {
      sheet(s, input.a, kv, hidden, null, 0);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(s.canvas, 0, 0, x, H, 0, 0, x, H); ctx.restore();
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(0, 0, x, H); ctx.clip(); boxes(ctx, input, v.rows, view, ["removed", "modified"]); ctx.restore();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(x, 0, W - x, H); ctx.clip(); boxes(ctx, input, v.rows, view, ["added", "modified"]); ctx.restore();
    return;
  }
  if (side === "before") {
    const changed = new Set([...v.removed, ...v.modifiedOld]);
    sheet(ctx, input.a, kv, hidden, changed, dim);
    layer(ctx, input.a, v.removed, colors.removed, 1, kv, hidden);
    layer(ctx, input.a, v.modifiedOld, colors.modified, 1, kv, hidden);
    boxes(ctx, input, v.rows, view, ["removed", "modified"]);
    return;
  }
  const changed = new Set([...v.added, ...v.modified]);
  sheet(ctx, input.b, kv, hidden, changed, dim);
  if (side === "both") {
    // what was there before, under what is there now
    layer(ctx, input.a, v.modifiedOld, colors.removed, 0.45, kv, hidden);
    layer(ctx, input.a, v.removed, colors.removed, 1, kv, hidden);
  }
  layer(ctx, input.b, v.modified, colors.modified, 1, kv, hidden);
  layer(ctx, input.b, v.added, colors.added, 1, kv, hidden);
  boxes(ctx, input, v.rows, view, side === "both" ? null : ["added", "modified"]);
}

/** The view that shows `box` (mm) with a margin in a canvas of the given css size. */
export function fitBox(box: [number, number, number, number], wCss: number, hCss: number, margin = 0.9): DiffView {
  const bw = Math.max(box[2] - box[0], 0.5), bh = Math.max(box[3] - box[1], 0.5);
  const scale = Math.max(0.05, Math.min(wCss / bw, hCss / bh) * margin);
  return { scale, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2 };
}
/** What "fit" means for a pair of versions: the sheet for a schematic, both boards' extents otherwise. */
export function extent(a: KDoc, b: KDoc): [number, number, number, number] {
  if (b.type === "sch") return [0, 0, Math.max(a.page[0], b.page[0]), Math.max(a.page[1], b.page[1])];
  const x = a.bbox, y = b.bbox;
  return [Math.min(x[0], y[0]), Math.min(x[1], y[1]), Math.max(x[2], y[2]), Math.max(x[3], y[3])];
}

/** The visible change under a document point: the smallest box that contains it. */
export function changeAt(input: PaintInput, x: number, y: number, slop: number): Change | null {
  let best: Change | null = null, area = Infinity;
  for (const c of input.rows) {
    if (!c.bbox || !input.show[c.category] || input.hiddenRows.has(c.key)) continue;
    const b = c.bbox; if (x < b[0] - slop || x > b[2] + slop || y < b[1] - slop || y > b[3] + slop) continue;
    const a = (b[2] - b[0] + 2 * slop) * (b[3] - b[1] + 2 * slop);
    if (a < area) { area = a; best = c; }
  }
  return best;
}
