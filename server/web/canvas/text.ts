// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
import { strokeAdvance } from "./stroke-font";
import type { TextEffects } from "./types";
// ---------------------------------------------------------------- text metrics
// Newstroke advance widths (units of 1/21 of the text size) for ASCII 32..126, read
// from common/newstroke_font.cpp; KiCad's string width = Σadvance·size − 0.2·size + 3·thickness.
export const STROKE_ADV = [16, 10, 16, 21, 20, 24, 26, 10, 14, 14, 16, 26, 10, 26, 10, 22, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 26, 26, 26, 18, 27, 18, 21, 21, 21, 19, 18, 21, 22, 10, 16, 21, 17, 24, 22, 22, 21, 22, 21, 20, 16, 22, 18, 24, 20, 18, 20, 14, 14, 14, 12, 16, 8, 19, 19, 18, 19, 18, 12, 19, 19, 10, 10, 17, 11, 28, 19, 19, 19, 19, 13, 17, 12, 19, 16, 22, 17, 16, 17, 14, 20, 14, 15];

/**
 * Baseline-to-baseline pitch of a multiline run, in units of the text size:
 * STROKE_FONT::GetInterline = METRICS::GetInterline(h) * LEGACY_FACTOR = h * 1.68 * 0.9583
 * (common/font/stroke_font.cpp:190-195, include/font/font_metrics.h:52-72).
 */
export const TEXT_INTERLINE = 1.68 * 0.9583;

/**
 * Where each line of a multiline run sits, as a multiple of TEXT_INTERLINE·size away from where a
 * single line would sit: EDA_TEXT::GetLinePositions (common/eda_text.cpp:937-978) shifts the block
 * up by (n-1)·interline/2 when the text is vertically centred and by (n-1)·interline when it is
 * bottom-aligned, so a one-line run never moves.
 */
export function lineOffsets(n: number, vjust: string): number[] {
  const k = vjust === "top" ? 0 : vjust === "bottom" ? n - 1 : (n - 1) / 2;
  const out: number[] = []; for (let i = 0; i < n; i++) out.push(i - k);
  return out;
}

export function textWidth(text: string, size: number, thick?: number): number {
  // Σ glyph advances from KiCad's own font table (web/canvas/stroke-font.ts), so non-ASCII text measures right too
  let w = 0;
  for (const ch of text) w += strokeAdvance(ch);
  return text.length ? Math.max(0, w - 0.2) * size + 3 * (thick || 0) : 0;
}

/** Strip KiCad text markup; overbar spans (~{...}) are kept as [start, end) indices of the shown text. */
export function parseMarkup(s: string): { text: string; bars: [number, number][] | null } {
  if (s.indexOf("{") < 0) return { text: s, bars: null };
  let out = "", bars: [number, number][] | null = null; const stack: { kind: string; start: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], d = s[i + 1];
    if ((c === "~" || c === "_" || c === "^") && d === "{") { stack.push({ kind: c, start: out.length }); i++; continue; }
    if (c === "}" && stack.length) { const o = stack.pop()!; if (o.kind === "~") (bars = bars || []).push([o.start, out.length]); continue; }
    out += c;
  }
  return { text: out, bars };
}

export const INTERLINE = 1.68 * 0.9583;
   // stroke font line pitch (font_metrics.h × STROKE_FONT legacy factor)
/** The schematic's default line width (Schematic Setup > Formatting: default_line_thickness, 6 mil unless set). */
export let SCH_PEN = 0.1524;
export function setSchPen(w: number): void { if (w > 0) SCH_PEN = w; }
             // DEFAULT_LINE_WIDTH_MILS (6 mil)
export const MIL = 0.0254;

export function textPen(ef: Pick<TextEffects, "sizeX" | "thick" | "bold">, size: number): number {
  // EDA_TEXT::GetEffectiveTextPenWidth( default pen ): SCH_PAINTER::getTextThickness passes the schematic's
  // default line width (6 mil), so plain text is drawn with that pen whatever its size; bold text is
  // size/5 (GetPenSizeForBold of the smaller glyph dimension), an explicit thickness is kept (×1.6 when
  // bold, BOLD_STROKE_MULTIPLIER); everything is clamped to a quarter of the size (ClampTextPenSize).
  const minSize = Math.min(size, ef.sizeX > 0 ? ef.sizeX : size);
  let pen = ef.thick > 0.001 ? (ef.bold ? ef.thick * 1.6 : ef.thick) : (ef.bold ? minSize / 5 : SCH_PEN);
  return Math.min(pen, minSize * 0.25);
}

/** GetEffectiveTextPenWidth() with no default pen — what the label shapes and offsets are computed with (SCH_LABEL_BASE::GetPenWidth): size/8, bold size/5, clamped to size/4. */
export function layoutPen(ef: Pick<TextEffects, "thick" | "bold">, size: number): number {
  const pen = ef.thick > 0.001 ? ef.thick : (ef.bold ? size / 5 : size / 8);
  return Math.min(pen, size * 0.25);
}

const UNESCAPE: Record<string, string> = { dblquote: '"', quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{" };
const UNESCAPE_RE = /\{(dblquote|quote|lt|gt|backslash|slash|bar|comma|colon|space|dollar|tab|return|brace)\}/g;
/** UnescapeString (common/string_utils.cpp): {slash} → /, {colon} → :, … as every GetShownText does before drawing. */
export function unescapeText(s: string): string { return s && s.indexOf("{") >= 0 ? s.replace(UNESCAPE_RE, (m: string, k: string) => UNESCAPE[k]) : s; }

// ---------------------------------------------------------------- hypertext (MARKUP::url, IsURL)
/**
 * The url nodes of one line as MARKUP_PARSER finds them (include/markup_parser.h): "http://" or "https://" and then
 * every character up to a space.  [start, end) index the marked-up source.
 */
export function urlRuns(line: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = []; const re = /https?:\/\/[^ ]+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
  return out;
}
/** string_utils IsURL: the text holds a URL anywhere ((https?|ftp|file)://… not ending in . , : ; < >). */
export function isUrlText(s: string): boolean { return /(https?|ftp|file):\/\/[-\w+&@#/%?=~|!:,.;]*[^.,:;<>\s¶]/i.test(s); }
/**
 * Where the url run [start, end) of a one-line text geometry sits in the text's own frame (origin at its anchor,
 * x along the baseline, y down): FONT::drawMarkup's glyph box of that node, from the cap height to the descenders.
 */
export function urlRunBox(g: { text: string; raw?: string; size: number; sizeX?: number; w?: number; h: string; v: string }, start: number, end: number): { x0: number; x1: number; y0: number; y1: number; base: number } {
  const src = g.raw || g.text; const sx = g.sizeX && g.sizeX > 0 ? g.sizeX : g.size;
  const shown = (s: string) => parseMarkup(s).text;
  const W = textWidth(shown(src), sx, 0), lead = shown(src.slice(0, start)), run = shown(src.slice(0, end));
  const left = g.h === "left" ? 0 : g.h === "right" ? -W : -W / 2;
  const x0 = left + (lead ? textWidth(lead, sx, 0) + 0.2 * sx : 0), x1 = left + textWidth(run, sx, 0);
  const base = g.v === "top" ? g.size : g.v === "bottom" ? 0 : g.size / 2;
  return { x0, x1, y0: base - g.size * 1.05, y1: base + g.size * 0.3, base };
}
/** A document point in a text geometry's own frame (the inverse of the painter's anchor / rotation / mirror). */
export function textLocal(g: { x: number; y: number; rot?: number; mirror?: boolean }, p: readonly number[]): [number, number] {
  const a = -(g.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), dx = p[0]! - g.x, dy = p[1]! - g.y;
  return [(g.mirror ? -1 : 1) * (c * dx + sn * dy), -sn * dx + c * dy];
}
/** The url run of a text geometry under the point p (SCH_PAINTER's rollover position), or null. */
export function urlRunAt(g: { x: number; y: number; rot?: number; mirror?: boolean; text: string; raw?: string; size: number; sizeX?: number; h: string; v: string }, p: readonly number[]): { start: number; end: number; url: string } | null {
  const src = g.raw || g.text; const runs = urlRuns(src); if (!runs.length) return null;
  const [lx, ly] = textLocal(g, p);
  for (const r of runs) { const b = urlRunBox(g, r.start, r.end); if (lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1) return r; }
  return null;
}
