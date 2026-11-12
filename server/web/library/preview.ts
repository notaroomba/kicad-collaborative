// library/preview.ts — the chooser's preview panes: one library symbol unit or one footprint
// drawn with the document renderer (KiCadCanvas.render) on its own canvas, fitted to the pane.
import { embedSymbol, footprintInstance, symbolInfo, symbolInstance } from "./core";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
type Render = (doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>) => void;

/** Board layers a lone footprint is drawn against (the stack KiCad's footprint preview uses). */
const PREVIEW_LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user) (11 "B.Adhes" user) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user)
  (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user) (19 "Cmts.User" user) (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (33 "B.Fab" user))`;

function sizeToBox(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1, w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  return { w, h, dpr };
}

function boundsOf(doc: KDoc): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const it of doc.items.values()) {
    const ib = it.bbox; if (!ib) continue;
    b = b ? [Math.min(b[0], ib[0]), Math.min(b[1], ib[1]), Math.max(b[2], ib[2]), Math.max(b[3], ib[3])] : [ib[0], ib[1], ib[2], ib[3]];
  }
  return b;
}

function draw(canvas: HTMLCanvasElement, doc: KDoc, opts: Record<string, unknown>, maxPpm: number, zoom = 1): void {
  const g = canvas.getContext("2d"); if (!g) return;
  const { w, h, dpr } = sizeToBox(canvas);
  const b = boundsOf(doc) || [-5, -5, 5, 5];
  const bw = Math.max(0.5, b[2] - b[0]), bh = Math.max(0.5, b[3] - b[1]);
  const ppm = Math.min(maxPpm, (w * 0.84) / bw, (h * 0.84) / bh) * zoom;
  const view: KView = { ppm, zoom: 1, panX: 0, panY: 0, x0: (b[0] + b[2]) / 2 - w / 2 / ppm, y0: (b[1] + b[3]) / 2 - h / 2 / ppm, dpr };
  (K().render as unknown as Render)(doc, g, view, Object.assign({ frame: false, grid: 0 }, opts));
}

/** Blank the pane (the editor's own background). */
export function clearPreview(canvas: HTMLCanvasElement, kind: "symbol" | "footprint"): void {
  const doc = K().parseDoc(kind === "symbol" ? '(kicad_sch (version 20260101) (generator "eeschema") (paper "A4"))' : `(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS})`);
  draw(canvas, doc, { hidden: new Set<string>() }, 20);
}

/** One unit of a library symbol (flattened text), with its visible fields as a new instance would show them. */
export function renderSymbolPreview(canvas: HTMLCanvasElement, libId: string, symbol: string, unit: number): void {
  const lib = embedSymbol(libId, symbol);
  const inst = symbolInstance({ libId, symbol: lib, at: [0, 0], unit, reference: symbolInfo(lib).reference || "U", uuid: "00000000-0000-4000-8000-000000000001" });
  const doc = K().parseDoc(`(kicad_sch (version 20260101) (generator "eeschema") (paper "A4") (lib_symbols ${K().serialize(lib)}) ${K().serialize(inst)})`);
  draw(canvas, doc, {}, 24);
}

/** A library footprint (.kicad_mod text), every layer shown. */
export function renderFootprintPreview(canvas: HTMLCanvasElement, fpid: string, footprint: string, zoom = 1): void {
  const node = footprintInstance({ fpid, footprint, at: [0, 0], uuid: "00000000-0000-4000-8000-000000000002" });
  const doc = K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS} ${K().serialize(node)})`);
  draw(canvas, doc, { hidden: new Set<string>() }, 60, zoom);
}
