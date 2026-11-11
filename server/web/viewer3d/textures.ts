// viewer3d/textures.ts — the board's two faces as images.  Each face is composed from the document's
// own 2D geometry, one technical layer at a time, drawn by the editor's canvas painter
// (KiCadCanvas.render, server/web/canvas/render.ts) as a white stencil and tinted with KiCad's 3D
// colours: board body, copper (surface finish), solder mask with its openings, silkscreen, solder paste.  The stack order is the 3D viewer's: body, copper, mask, silk, paste.
import { BOARD_BODY, HOLE_SHADE, RGBA, SILKSCREEN, SOLDER_MASK, SOLDER_PASTE, SURFACE_FINISH, css } from "./colors";
import type { Hole } from "./outline";

export type Side = "F" | "B";

/** What is drawn on a face (the Appearance panel's rows). */
export interface FaceLayers { body: boolean; copper: boolean; mask: boolean; silk: boolean; paste: boolean }

/** The part of the board a face texture covers and its resolution. */
export interface TextureExtent { x0: number; y0: number; w: number; h: number; pxPerMm: number; width: number; height: number }

const WHITE = "#ffffff";
type Canvas2D = HTMLCanvasElement;

/** Texture size for a board of w × h mm: as sharp as the GPU's texture limit and a pixel budget allow. */
export function textureExtent(bbox: [number, number, number, number], maxDim: number, budget = 12e6, margin = 0.2): TextureExtent {
  const x0 = bbox[0] - margin, y0 = bbox[1] - margin;
  const w = Math.max(1, bbox[2] - bbox[0] + 2 * margin), h = Math.max(1, bbox[3] - bbox[1] + 2 * margin);
  const pxPerMm = Math.max(1, Math.min(40, maxDim / w, maxDim / h, Math.sqrt(budget / (w * h))));
  return { x0, y0, w, h, pxPerMm, width: Math.max(2, Math.round(w * pxPerMm)), height: Math.max(2, Math.round(h * pxPerMm)) };
}

/** Whether a geometry primitive belongs on a layer's stencil. */
export function stencilGeom(g: KGeom, layer: string, itemKind: string): boolean {
  if (g.layer !== layer) return false;
  // pad numbers / net names, holes, zone outlines and their hatch are editor display aids, not artwork
  if (g.padText || g.hole || g.zoneOutline || g.hiddenText) return false;
  if (itemKind === "zone" && !g.zoneFill) return false;
  if ((g.t === "line" || g.t === "poly" || g.t === "circle" || g.t === "arc") && !(typeof g.w === "number" && g.w > 0) && !g.fill) return false;
  return true;
}

/** The geometry of each wanted layer, recoloured white, as one pseudo-document per layer for KiCadCanvas.render. */
export function layerStencils(doc: KDoc, layers: string[]): Map<string, KDoc> {
  const lists = new Map<string, KGeom[]>(); for (const l of layers) lists.set(l, []);
  for (const it of doc.items.values()) {
    for (const g of it.geom) {
      const list = lists.get(g.layer); if (!list || !stencilGeom(g, g.layer, it.kind)) continue;
      list.push(Object.assign({}, g, { color: WHITE, fill: g.fill ? WHITE : g.fill, alpha: 1 }));
    }
  }
  const out = new Map<string, KDoc>();
  for (const [layer, geom] of lists) {
    const item = { id: "v3d-" + layer, kind: "stencil", node: [] as SNode, geom, bbox: null, movable: false, docType: "pcb" as const, hiddenGeom: null };
    const items = new Map<string, KItem>([[item.id, item]]);
    out.set(layer, { type: "pcb", items, lib: new Map(), layers: doc.layers, copper: doc.copper, nets: doc.nets, page: doc.page, bbox: doc.bbox });
  }
  return out;
}

const LAYERS: Record<Side, { cu: string; mask: string; silk: string; paste: string }> = {
  F: { cu: "F.Cu", mask: "F.Mask", silk: "F.SilkS", paste: "F.Paste" },
  B: { cu: "B.Cu", mask: "B.Mask", silk: "B.SilkS", paste: "B.Paste" },
};

export class FaceComposer {
  readonly extent: TextureExtent;
  private stencils: Map<string, KDoc>;
  private a: Canvas2D; private b: Canvas2D;

  constructor(doc: KDoc, extent: TextureExtent) {
    this.extent = extent;
    this.stencils = layerStencils(doc, ["F.Cu", "B.Cu", "F.Mask", "B.Mask", "F.SilkS", "B.SilkS", "F.Paste", "B.Paste"]);
    this.a = document.createElement("canvas"); this.b = document.createElement("canvas");
  }

  private canvas(): Canvas2D { const c = document.createElement("canvas"); c.width = this.extent.width; c.height = this.extent.height; return c; }
  /** The two scratch canvases are full-size only while a face is being composed. */
  private scratch(on: boolean): void { for (const c of [this.a, this.b]) { c.width = on ? this.extent.width : 1; c.height = on ? this.extent.height : 1; } }

  /** Draw one layer as a white stencil into `target`; false when the layer is empty. */
  private stencil(target: Canvas2D, layer: string): boolean {
    const ctx = target.getContext("2d"); if (!ctx) return false;
    const d = this.stencils.get(layer);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    if (!d || !d.items.values().next().value?.geom.length) { ctx.clearRect(0, 0, target.width, target.height); return false; }
    const e = this.extent;
    const view: KView = { ppm: e.pxPerMm, zoom: 1, panX: 0, panY: 0, x0: e.x0, y0: e.y0, dpr: 1 };
    const opts = { hidden: new Set<string>(), grid: 0, background: "", frame: false } as KRenderOpts;
    window.KiCadCanvas.render(d, ctx, view, opts);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    return true;
  }

  private tint(target: Canvas2D, color: RGBA): void {
    const ctx = target.getContext("2d"); if (!ctx) return;
    ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = css(color, 1);
    ctx.fillRect(0, 0, target.width, target.height); ctx.globalCompositeOperation = "source-over";
  }

  /** Compose one face into `out` (created on first use); `painted` holes are shaded, since the mesh has no hole there. */
  compose(side: Side, show: FaceLayers, painted: Hole[], out?: Canvas2D): Canvas2D {
    const target = out || this.canvas(); const L = LAYERS[side]; const e = this.extent;
    const ctx = target.getContext("2d"); if (!ctx) return target;
    const W = target.width, H = target.height;
    this.scratch(true);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (show.body) { ctx.fillStyle = css(BOARD_BODY, 1); ctx.fillRect(0, 0, W, H); }
    if (show.copper && this.stencil(this.a, L.cu)) { this.tint(this.a, SURFACE_FINISH); ctx.drawImage(this.a, 0, 0); }
    const openings = show.mask ? this.stencil(this.b, L.mask) : false;
    if (show.mask) {
      const actx = this.a.getContext("2d");
      if (actx) {
        actx.globalCompositeOperation = "source-over"; actx.clearRect(0, 0, W, H);
        actx.fillStyle = css(SOLDER_MASK, 1); actx.fillRect(0, 0, W, H);
        if (openings) { actx.globalCompositeOperation = "destination-out"; actx.drawImage(this.b, 0, 0); actx.globalCompositeOperation = "source-over"; }
        ctx.globalAlpha = SOLDER_MASK[3]; ctx.drawImage(this.a, 0, 0); ctx.globalAlpha = 1;
      }
    }
    // silkscreen is not clipped at the mask openings: KiCad's default (render.subtract_mask_from_silk = false)
    if (show.silk && this.stencil(this.a, L.silk)) { this.tint(this.a, SILKSCREEN); ctx.drawImage(this.a, 0, 0); }
    if (show.paste && this.stencil(this.a, L.paste)) { this.tint(this.a, SOLDER_PASTE); ctx.drawImage(this.a, 0, 0); }
    if (painted.length) {
      ctx.setTransform(e.pxPerMm, 0, 0, e.pxPerMm, -e.x0 * e.pxPerMm, -e.y0 * e.pxPerMm);
      ctx.fillStyle = css(HOLE_SHADE, 1); ctx.beginPath();
      for (const h of painted) { ctx.moveTo(h.pts[0][0], h.pts[0][1]); for (let i = 1; i < h.pts.length; i++) ctx.lineTo(h.pts[i][0], h.pts[i][1]); ctx.closePath(); }
      ctx.fill(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.scratch(false);
    return target;
  }

  /** Release the scratch canvases (the composed faces belong to the caller). */
  dispose(): void { this.scratch(false); this.stencils.clear(); }
}
