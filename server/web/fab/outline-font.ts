// fab/outline-font.ts — text set in an outline (TrueType / OpenType) font, as the polygons a plot fills.
//
// pcbnew plots such a text from the glyph outlines of the font file (OUTLINE_FONT::getTextAsGlyphs) and stores
// them in the board as (render_cache …).  A text edited here has no such cache, so the outlines are drawn from
// the same font file: the editor holds the files of the project's fonts (KiCadCanvas.setFontData — Google Fonts
// and the fonts collaborators uploaded) and this module reads the glyphs out of them.
//
// The layout is KiCad's: an em of 1.4 × the text height (m_outlineFontSizeCompensation), lines 1.68 × the height
// apart, the block placed by FONT::getLinePositions, sub/superscripts at 0.64 and an overbar 1.23 heights up.
import opentype from "opentype.js";
import { gposKerning } from "./gpos-kern";
import { fracture, union } from "./poly";
import { type Pt } from "./prims";

interface FontBytes { data: ArrayBuffer; bold: boolean; italic: boolean }
interface CanvasFonts { fontData?(face: string, bold: boolean, italic: boolean): FontBytes | null }
interface PathCmd { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
interface OtGlyph { index: number; advanceWidth?: number; getPath(x: number, y: number, size: number): { commands: PathCmd[] } }
interface OtFont { unitsPerEm: number; stringToGlyphs(s: string): OtGlyph[]; charToGlyph(c: string): OtGlyph; getKerningValue(a: OtGlyph, b: OtGlyph): number }
interface Held { font: OtFont; data: ArrayBuffer; kern: Map<string, (l: number, r: number) => number> }

const EM = 1.4;            // OUTLINE_FONT::m_outlineFontSizeCompensation
const INTERLINE = 1.68;    // METRICS::m_InterlinePitch
const SUPERSUB = 0.64;     // m_subscriptSuperscriptSize
const SUB_DROP = 0.25 * EM, SUPER_RISE = 0.45 * EM;   // GetSuperSubBaselineOffset, in sizes of the run
const OVERBAR = 1.23;      // METRICS::m_OverbarHeight
const SLANT = Math.sin(12 * Math.PI / 180), SQUEEZE = Math.cos(12 * Math.PI / 180);   // the 12° shear of a family without an italic
const CURVE_STEPS = 8;

const PARSED = new WeakMap<ArrayBuffer, Held | null>();
function parsed(data: ArrayBuffer): Held | null {
  let f = PARSED.get(data);
  if (f === undefined) {
    try { f = { font: (opentype as unknown as { parse(b: ArrayBuffer): OtFont }).parse(data), data, kern: new Map() }; } catch (e) { f = null; }
    PARSED.set(data, f);
  }
  return f;
}

/** The script HarfBuzz would shape a run in, as far as kerning tables differ by it. */
function scriptOf(text: string): string {
  for (const ch of text) { const c = ch.codePointAt(0)!; if (c >= 0x400 && c <= 0x52f) return "cyrl"; if (c >= 0x370 && c <= 0x3ff) return "grek"; if (c > 0x40 && c < 0x250) return "latn"; }
  return "latn";
}
/** The glyphs of a run: ligatures applied where opentype.js can read the font's substitutions, else letter by letter. */
function glyphsOf(font: OtFont, text: string): OtGlyph[] {
  try { return font.stringToGlyphs(text); } catch (e) { return [...text].map((c) => font.charToGlyph(c)); }
}
/** The advance adjustment between two glyphs, font units: GPOS pair kerning, else the old 'kern' table. */
function kerning(h: Held, script: string, a: OtGlyph, b: OtGlyph): number {
  let k = h.kern.get(script); if (!k) { k = gposKerning(h.data, script); h.kern.set(script, k); }
  const v = k(a.index, b.index); if (v) return v;
  try { return h.font.getKerningValue(a, b) || 0; } catch (e) { return 0; }
}

/** The font a text is drawn with: the file held for the face in that style, and whether it has to be slanted. */
function fontFor(face: string, bold: boolean, italic: boolean): { font: Held; slant: boolean } | null {
  const K = (globalThis as unknown as { KiCadCanvas?: CanvasFonts }).KiCadCanvas;
  if (!K || typeof K.fontData !== "function") return null;
  // the style asked for; failing that whatever of the family is held (a text made bold after its font was loaded)
  for (const [b, i] of [[bold, italic], [false, italic], [bold, false], [false, false]] as [boolean, boolean][]) {
    const held = K.fontData(face, b, i); if (!held) continue;
    const font = parsed(held.data); if (!font) continue;
    return { font, slant: italic && !held.italic };
  }
  return null;
}
/** Whether a text in this face can be plotted from its font file. */
export function outlineFontHeld(face: string, bold: boolean, italic: boolean): boolean { return !!fontFor(face, bold, italic); }

interface Run { text: string; sup: boolean; sub: boolean; over: boolean }
/** KiCad's markup (MARKUP_PARSER): ^{…} superscript, _{…} subscript, ~{…} overbar; nested runs inherit. */
function runs(line: string): Run[] {
  const out: Run[] = [];
  const walk = (s: string, sup: boolean, sub: boolean, over: boolean): void => {
    let plain = "";
    const flush = (): void => { if (plain) { out.push({ text: plain, sup, sub, over }); plain = ""; } };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if ((c === "^" || c === "_" || c === "~") && s[i + 1] === "{") {
        let depth = 1, j = i + 2;
        for (; j < s.length && depth; j++) { if (s[j] === "{") depth++; else if (s[j] === "}") depth--; }
        if (!depth) {
          flush();
          walk(s.slice(i + 2, j - 1), sup || c === "^", sub || c === "_", over || c === "~");
          i = j - 1; continue;
        }
      }
      plain += c;
    }
    flush();
  };
  walk(line, false, false, false);
  return out;
}

/** One closed contour of a glyph, curves flattened; (x, y) in ems, y down, from the glyph's origin. */
function contours(glyph: OtGlyph): Pt[][] {
  const out: Pt[][] = []; let cur: Pt[] = []; let px = 0, py = 0;
  const close = (): void => { if (cur.length >= 3) out.push(cur); cur = []; };
  for (const c of glyph.getPath(0, 0, 1).commands) {
    if (c.type === "M") { close(); cur.push([c.x!, c.y!]); px = c.x!; py = c.y!; }
    else if (c.type === "L") { cur.push([c.x!, c.y!]); px = c.x!; py = c.y!; }
    else if (c.type === "Q") {
      for (let k = 1; k <= CURVE_STEPS; k++) { const t = k / CURVE_STEPS, u = 1 - t; cur.push([u * u * px + 2 * u * t * c.x1! + t * t * c.x!, u * u * py + 2 * u * t * c.y1! + t * t * c.y!]); }
      px = c.x!; py = c.y!;
    } else if (c.type === "C") {
      for (let k = 1; k <= CURVE_STEPS + 4; k++) {
        const t = k / (CURVE_STEPS + 4), u = 1 - t;
        cur.push([u * u * u * px + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t * t * t * c.x!, u * u * u * py + 3 * u * u * t * c.y1! + 3 * u * t * t * c.y2! + t * t * t * c.y!]);
      }
      px = c.x!; py = c.y!;
    } else if (c.type === "Z") close();
  }
  close();
  return out;
}

interface Laid { contours: Pt[][]; bars: [number, number, number, number][]; width: number }
/** One line laid out from x = 0 on its baseline, in mm before the text's own transform (y down). */
function layLine(held: Held, slant: boolean, line: string, size: number, sizeX: number): Laid {
  const font = held.font;
  const laid: Laid = { contours: [], bars: [], width: 0 };
  let x = 0;
  for (const run of runs(line)) {
    const small = run.sup || run.sub, k = small ? SUPERSUB : 1;
    const sx = sizeX * EM * k, sy = size * EM * k;
    const dy = run.sub ? size * SUPERSUB * SUB_DROP : run.sup ? -size * SUPERSUB * SUPER_RISE : 0;
    const glyphs = glyphsOf(font, run.text), start = x, script = scriptOf(run.text);
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      for (const c of contours(g)) laid.contours.push(c.map(([gx, gy]) => [x + (slant ? SQUEEZE * gx - SLANT * gy : gx) * sx, dy + gy * sy] as Pt));
      let adv = (g.advanceWidth || 0) / font.unitsPerEm;
      if (i + 1 < glyphs.length) adv += kerning(held, script, g, glyphs[i + 1]) / font.unitsPerEm;
      x += adv * sx;
    }
    // drawMarkup: the bar a tenth of the width short at each end
    if (run.over && x > start) laid.bars.push([start + sizeX * 0.1, -size * OVERBAR, x - sizeX * 0.1, -size * OVERBAR]);
  }
  laid.width = x;
  return laid;
}

export interface OutlineBlock { face: string; bold: boolean; italic: boolean; text: string; x: number; y: number; rot: number; size: number; sizeX: number; h: string; v: string; mirror: boolean }
export interface OutlineText {
  /** the filled outlines, holes cut in (SHAPE_POLY_SET::Fracture), board mm */
  polys: Pt[][];
  /** overbars: pen strokes [x1, y1, x2, y2] */
  bars: [number, number, number, number][];
}

/**
 * FONT::Draw for an outline font: every line of the text as polygons in board coordinates, or null when the
 * font file is not held (the caller then falls back to the stroke font and says so).
 */
export function outlineText(b: OutlineBlock): OutlineText | null {
  const use = fontFor(b.face, b.bold, b.italic); if (!use) return null;
  const lines = b.text.split("\n"), interline = b.size * INTERLINE;
  const laid = lines.map((l) => layLine(use.font, use.slant, l, b.size, b.sizeX));
  // FONT::getLinePositions
  const height = b.size * 1.17 + (lines.length - 1) * interline;
  let oy = b.size;
  if (b.v === "middle" || b.v === "center") oy -= height / 2; else if (b.v === "bottom") oy -= height;
  const a = -b.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = b.mirror ? -1 : 1;
  const P = (lx: number, ly: number): Pt => { const X = lx * mx; return [b.x + X * c - ly * sn, b.y + X * sn + ly * c]; };
  const flat: Pt[][] = []; const bars: [number, number, number, number][] = [];
  laid.forEach((l, i) => {
    const ox = b.h === "center" ? -l.width / 2 : b.h === "right" ? -l.width : 0, y0 = oy + i * interline;
    for (const k of l.contours) flat.push(k.map(([px, py]) => P(ox + px, y0 + py)));
    for (const [x1, y1, x2, y2] of l.bars) { const p = P(ox + x1, y0 + y1), q = P(ox + x2, y0 + y2); bars.push([p[0], p[1], q[0], q[1]]); }
  });
  if (!flat.length && !bars.length) return { polys: [], bars };
  // a glyph's contours fill by winding; glyphs that touch (a script face) become one shape, as on the board
  const merged = union(flat);
  return { polys: merged.length > 1 ? fracture(merged) : merged, bars };
}
