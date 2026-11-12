// web/fab/plotter — the page model every vector writer (svg.ts, pdf.ts, ps.ts, dxf.ts) and the PNG
// rasteriser draw from: KiCad's PLOTTER calls (common/plotters/plotter.h) reduced to what the board and
// schematic plots actually emit — thick polylines with round ends, filled polygons and circles — on a page
// in millimetres (origin top left, Y down).  The bookmarks, links and property menus are the PDF extras
// (PDF_PLOTTER::Bookmark / HyperlinkBox / HyperlinkMenu).
import type { PlotItem } from "../canvas/plot-rec";
import type { Pt } from "./prims";

export type { PlotItem };

export interface PlotBookmark { group: string; title: string }
/** A clickable area: a URL, a page of the same document (#n, 1-based), or a menu of entries ([label, target]). */
export interface PlotLink { box: [number, number, number, number]; url?: string; menu?: [string, string][] }

export interface PlotPage {
  /** page size, mm */
  w: number; h: number;
  /** page label (layer name, sheet path) */
  name: string;
  items: PlotItem[];
  /** filled behind everything (PDF / PNG "Background Color") */
  background?: string | null;
  bookmarks?: PlotBookmark[];
  links?: PlotLink[];
  /** SVG "Fit page to board": the viewBox in page mm */
  viewBox?: [number, number, number, number] | null;
}

export interface PlotDocument {
  pages: PlotPage[];
  /** "PCBNEW" / "Eeschema" (SetCreator) */
  creator: string;
  title?: string; author?: string; subject?: string;
  date?: Date;
  fileName?: string;
}

/** A colour as KiCad writes it: #RRGGBB (alpha dropped), black for anything unreadable. */
export function rgbOf(c: string): [number, number, number] {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (m) { let h = m[1]; if (h.length === 3) h = h.replace(/./g, "$&$&"); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(c);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  return [0, 0, 0];
}
export const hexOf = (c: string): string => "#" + rgbOf(c).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

/** GetISO8601CurrentDateTime: 2024-05-01T12:00:00+02:00 */
export function isoDateTime(d: Date): string {
  const p = (n: number): string => String(Math.abs(n)).padStart(2, "0"); const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** A circle as a polygon, for writers without a circle primitive. */
export function circlePoly(x: number, y: number, r: number, n = 0): Pt[] {
  const k = n || Math.max(16, Math.min(360, Math.ceil(2 * Math.PI / (2 * Math.acos(Math.max(-1, 1 - 0.002 / Math.max(r, 1e-6)))))));
  const out: Pt[] = []; for (let i = 0; i < k; i++) { const a = 2 * Math.PI * i / k; out.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
  return out;
}

/** The PLOTTER viewport of pcbnew's initializePlotter: board mm → page mm. */
export interface Viewport { offset: Pt; scale: number; mirror: boolean; pageW: number }
export function toPage(v: Viewport, x: number, y: number): Pt {
  const px = (x - v.offset[0]) * v.scale, py = (y - v.offset[1]) * v.scale;
  return [v.mirror ? v.pageW - px : px, py];
}
