// web/fab/raster — PNG_PLOTTER: a page rasterised at the requested DPI (anti-aliased or not), through an
// OffscreenCanvas (or a <canvas> where there is none).  The canvas is a stand-in for KiCad's Cairo surface;
// the page items are the same ones the vector writers draw.
import type { PlotPage } from "./plotter";
import { hexOf } from "./plotter";

interface Canvas2D { width: number; height: number; getContext(k: "2d"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; convertToBlob?(o?: { type?: string }): Promise<Blob>; toBlob?(cb: (b: Blob | null) => void, type?: string): void }

function makeCanvas(w: number, h: number): Canvas2D | null {
  const G = globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => Canvas2D; document?: Document };
  if (G.OffscreenCanvas) return new G.OffscreenCanvas(w, h);
  if (G.document) { const c = G.document.createElement("canvas"); c.width = w; c.height = h; return c as unknown as Canvas2D; }
  return null;
}

/** Draw a page onto a 2D context already scaled to page millimetres. */
export function paintPage(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, page: PlotPage, white = true): void {
  if (page.background || white) { g.fillStyle = page.background ? hexOf(page.background) : "#FFFFFF"; g.fillRect(0, 0, page.w, page.h); }
  g.lineCap = "round"; g.lineJoin = "round";
  for (const it of page.items) {
    g.globalAlpha = it.alpha !== undefined ? it.alpha : 1;
    if (it.k === "line") {
      if (it.pts.length < 2) continue;
      g.strokeStyle = hexOf(it.color); g.lineWidth = Math.max(it.w, 1e-3); g.lineCap = (it.cap as CanvasLineCap) || "round";
      g.beginPath(); g.moveTo(it.pts[0][0], it.pts[0][1]); for (let i = 1; i < it.pts.length; i++) g.lineTo(it.pts[i][0], it.pts[i][1]); if (it.closed) g.closePath(); g.stroke();
    } else if (it.k === "fill") {
      g.fillStyle = hexOf(it.color); g.beginPath();
      for (const p of it.polys) { if (p.length < 3) continue; g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]); g.closePath(); }
      g.fill(it.evenOdd ? "evenodd" : "nonzero");
    } else {
      g.beginPath(); g.arc(it.x, it.y, it.r, 0, 2 * Math.PI);
      if (it.fill) { g.fillStyle = hexOf(it.color); g.fill(); } else { g.strokeStyle = hexOf(it.color); g.lineWidth = it.w; g.stroke(); }
    }
  }
  g.globalAlpha = 1;
}

export async function writePng(page: PlotPage, dpi = 300, antialias = true): Promise<Uint8Array> {
  const k = dpi / 25.4, W = Math.max(1, Math.round(page.w * k)), H = Math.max(1, Math.round(page.h * k));
  const cv = makeCanvas(W, H); if (!cv) throw new Error("no canvas to draw the PNG on");
  const g = cv.getContext("2d"); if (!g) throw new Error("no 2D context");
  (g as CanvasRenderingContext2D).imageSmoothingEnabled = antialias;
  g.setTransform(k, 0, 0, k, 0, 0);
  paintPage(g, page, true);
  let blob: Blob | null = null;
  if (cv.convertToBlob) blob = await cv.convertToBlob({ type: "image/png" });
  else if (cv.toBlob) blob = await new Promise<Blob | null>((res) => cv.toBlob!(res, "image/png"));
  if (!blob) throw new Error("the canvas did not encode a PNG");
  return new Uint8Array(await blob.arrayBuffer());
}
