// KiCad's stroke font (Newstroke) for the canvas painter: glyph decoding, markup layout and drawing.
//
// This is a port of common/font/stroke_font.cpp (glyph table, advance widths, sub/superscript,
// italic tilt), common/font/font.cpp (markup runs, overbar, the getLinePositions alignment fudges)
// and common/markup_parser.cpp (~{overbar}, _{subscript}, ^{superscript}).  A line is laid out once
// in "unit" space — glyph size 1, baseline at y = 0, Y down — and cached; drawing scales it by the
// text size, so the pen is the only thing that depends on the item.
import { NEWSTROKE_RANGES } from "./newstroke-data";

const STROKE_FONT_SCALE = 1 / 21;      // stroke_font.cpp
const FONT_OFFSET = -8;
export const ITALIC_TILT = 1 / 8;      // include/font/font.h
const INTER_CHAR = 0.2;
const SUPER_SUB_SIZE_MULTIPLIER = 0.8, SUPER_HEIGHT_OFFSET = 0.35, SUB_HEIGHT_OFFSET = 0.15;
const TAB_WIDTH = 4;
export const OVERBAR_HEIGHT = 1.23;    // font_metrics.h m_OverbarHeight
const R = "R".charCodeAt(0);

export interface StrokeGlyph {
  /** advance width in units of the glyph size */
  adv: number;
  /** pen-down runs: flat x, y pairs in units of the glyph size (baseline 0, Y down) */
  strokes: number[][];
}

const GLYPHS = new Map<number, StrokeGlyph | null>();

function decode(code: string): StrokeGlyph {
  const startX = (code.charCodeAt(0) - R) * STROKE_FONT_SCALE, endX = (code.charCodeAt(1) - R) * STROKE_FONT_SCALE;
  const strokes: number[][] = []; let cur: number[] | null = null;
  for (let i = 2; i + 1 < code.length; i += 2) {
    const a = code.charCodeAt(i), b = code.charCodeAt(i + 1);
    if (a === 32 && b === R) { cur = null; continue; }   // " R": raise the pen
    if (!cur) { cur = []; strokes.push(cur); }
    cur.push((a - R) * STROKE_FONT_SCALE - startX, (b - R + FONT_OFFSET) * STROKE_FONT_SCALE);
  }
  return { adv: endX - startX, strokes };
}

/** The glyph of a code point, or null when the font has none (KiCad then draws '?'). */
export function strokeGlyph(cp: number): StrokeGlyph | null {
  let g = GLYPHS.get(cp);
  if (g !== undefined) return g;
  g = null;
  for (const [a, b, table] of NEWSTROKE_RANGES) if (cp >= a && cp <= b) { const code = table[cp - a]; if (code && code.length >= 2) g = decode(code); break; }
  GLYPHS.set(cp, g);
  return g;
}

const QUESTION = "?".codePointAt(0) as number;
const glyphOrQuestion = (cp: number): StrokeGlyph => strokeGlyph(cp) || (strokeGlyph(QUESTION) as StrokeGlyph);

// ---------------------------------------------------------------- markup
export interface MarkupNode { kind: "" | "~" | "_" | "^"; text: string; children: MarkupNode[] }

/**
 * KiCad text markup: ~{…} overbar, _{…} subscript, ^{…} superscript, nestable.  A marker that is
 * never closed is literal text, as in MARKUP_PARSER.  The root's children are the line's runs.
 */
export function parseStrokeMarkup(s: string): MarkupNode {
  const root: MarkupNode = { kind: "", text: "", children: [] };
  if (s.indexOf("{") < 0) { if (s) root.children.push({ kind: "", text: s, children: [] }); return root; }
  // find the matching close brace for the group opened at `open` (index of '{'), or -1
  const closeOf = (open: number): number => {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === "{" && i > 0 && (s[i - 1] === "~" || s[i - 1] === "_" || s[i - 1] === "^" || i === open)) depth++;
      else if (c === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  const walk = (from: number, to: number, into: MarkupNode) => {
    let buf = "";
    const flush = () => { if (buf) { into.children.push({ kind: "", text: buf, children: [] }); buf = ""; } };
    for (let i = from; i < to; i++) {
      const c = s[i];
      if ((c === "~" || c === "_" || c === "^") && s[i + 1] === "{") {
        const end = closeOf(i + 1);
        if (end > 0 && end < to) {
          flush();
          const node: MarkupNode = { kind: c, text: "", children: [] };
          walk(i + 2, end, node); into.children.push(node); i = end; continue;
        }
      }
      buf += c;
    }
    flush();
  };
  walk(0, s.length, root);
  return root;
}

// ---------------------------------------------------------------- layout
export interface StrokeLine {
  /** pen-down runs in unit space (glyph size 1, baseline y = 0, Y down, x from the line start) */
  strokes: number[][];
  /** KiCad's bounding-box width of the line in units of the glyph width: cursor − INTER_CHAR */
  width: number;
  /** where the cursor ends, in the same units: what FONT::getLinePositions centres and right-aligns a line by (boundingBoxSingleLine returns it, trailing gap included) */
  advance: number;
  /** cached Path2D of `strokes` (browser only) */
  path: Path2D | null;
}

const LINES = new Map<string, StrokeLine>();
const LINE_CACHE_MAX = 6000;

function layout(text: string, italic: boolean): StrokeLine {
  const strokes: number[][] = []; const tilt = italic ? ITALIC_TILT : 0;
  let cursor = 0;
  // FONT::drawMarkup → STROKE_FONT::GetTextAsGlyphs for one run
  const run = (str: string, sub: boolean, sup: boolean) => {
    const k = sub || sup ? SUPER_SUB_SIZE_MULTIPLIER : 1;
    const dy = sub ? k * SUB_HEIGHT_OFFSET : sup ? -k * SUPER_HEIGHT_OFFSET : 0;
    const x0 = cursor; let count = 0;
    const space = (strokeGlyph(32) as StrokeGlyph).adv;
    for (const ch of str) {
      const cp = ch.codePointAt(0) as number;
      if (cp === 9) {
        // tabs lock to the next 4th column (in base widths)
        count = (Math.floor(count / TAB_WIDTH) + 1) * TAB_WIDTH - 1;
        let nc = x0 + count + space;
        while (nc <= cursor) { count += TAB_WIDTH; nc += TAB_WIDTH; }
        cursor = nc;
      } else if (cp === 32) cursor += k * space;
      else {
        const g = cp < 32 ? glyphOrQuestion(QUESTION) : glyphOrQuestion(cp);
        for (const st of g.strokes) {
          const o: number[] = [];
          for (let i = 0; i < st.length; i += 2) { const y = st[i + 1] * k; o.push(st[i] * k - y * tilt + cursor, y + dy); }
          strokes.push(o);
        }
        cursor += g.adv * k;
      }
      count++;
    }
  };
  const node = (n: MarkupNode, sub: boolean, sup: boolean) => {
    const start = cursor;
    const s2 = sub || n.kind === "_", p2 = sup || n.kind === "^";
    if (n.text) run(n.text, s2, p2);
    for (const c of n.children) node(c, s2, p2);
    if (n.kind === "~") strokes.push([start + 0.1, -OVERBAR_HEIGHT, cursor - 0.1, -OVERBAR_HEIGHT]);   // bar trimmed by 0.1 × size each end
  };
  node(parseStrokeMarkup(text), false, false);
  return { strokes, width: Math.max(0, cursor - INTER_CHAR), advance: cursor, path: null };
}

/** One line of text laid out in unit space (cached). */
export function strokeLine(text: string, italic?: boolean): StrokeLine {
  const key = italic ? "i" + text : "n" + text;
  let l = LINES.get(key);
  if (!l) { if (LINES.size >= LINE_CACHE_MAX) LINES.clear(); l = layout(text, !!italic); LINES.set(key, l); }
  return l;
}

/** KiCad's line width (bounding box, no pen) of a marked-up string, in units of the glyph width. */
export function strokeLineWidth(text: string, italic?: boolean): number { return text ? strokeLine(text, italic).width : 0; }

/** Advance width of one character in units of the glyph size ('?' for glyphs the font lacks). */
export function strokeAdvance(ch: string): number { const cp = ch.codePointAt(0) as number; return cp < 32 ? 0 : glyphOrQuestion(cp).adv; }

// ---------------------------------------------------------------- drawing
/** The 2D-context surface the stroke painter needs (a CanvasRenderingContext2D or a recording stub). */
export interface StrokeCtx {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  stroke(path?: Path2D): void;
  lineWidth: number; lineCap: string; lineJoin: string; strokeStyle: unknown;
}

export interface StrokeTextSpec {
  x: number; y: number; text: string;
  /** glyph height (KiCad's text size Y) and width (size X; defaults to the height), document units */
  size: number; sizeX?: number;
  /** degrees, counter-clockwise positive (KiCad's text angle) */
  rot?: number; mirror?: boolean;
  h: string; v: string;
  /** pen width, document units */
  pen: number; italic?: boolean;
  /** extra offset down the text's own Y axis, document units (line n of a multi-line run) */
  dy?: number;
}

const HAS_PATH2D = typeof Path2D !== "undefined";

/** FONT::getLinePositions: where the baseline start sits relative to the anchor, in unit space. */
export function strokeOrigin(width: number, h: string, v: string, penX: number, penY: number): [number, number] {
  const fx = penX / 1.52;                               // "fudge factors to match 6.0 positioning"
  const x = h === "left" ? fx : h === "right" ? -(width + fx) : -width / 2;
  const y = 1 - penY * 0.052 - (v === "top" ? 0 : v === "bottom" ? 1.17 : 1.17 / 2);
  return [x, y];
}

/**
 * Stroke one line of text.  `base` is the document → device matrix [a, 0, 0, d, e, f] (a < 0 for the
 * flipped board view); the text's own frame (anchor, angle, mirror, glyph size) is composed with it
 * into one setTransform, the cached unit path is stroked with the pen divided by the glyph height,
 * and the context is left on `base`.  minPen is the thinnest pen to draw (one device pixel, document units).
 */
export function drawStrokeText(ctx: StrokeCtx, base: number[], t: StrokeTextSpec, color: unknown, minPen: number): void {
  if (!t.text) return;
  const line = strokeLine(t.text, t.italic);
  const sy = t.size, sx = t.sizeX && t.sizeX > 0 ? t.sizeX : t.size;
  const pen = Math.max(t.pen, minPen);
  const o = strokeOrigin(line.advance, t.h, t.v, t.pen / sx, t.pen / sy);
  const ox = o[0], oy = o[1] + (t.dy || 0) / sy;
  const a = -(t.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), mx = t.mirror ? -1 : 1;
  // device = base · T(x, y) · Rot(a) · MirrorX · Scale(sx, sy) · T(ox, oy)
  const m0 = base[0] * c * mx * sx, m1 = base[3] * sn * mx * sx, m2 = -base[0] * sn * sy, m3 = base[3] * c * sy;
  const e = base[0] * t.x + base[4], f = base[3] * t.y + base[5];
  ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (Math.abs(sx - sy) < 1e-9) {
    ctx.setTransform(m0, m1, m2, m3, e + m0 * ox + m2 * oy, f + m1 * ox + m3 * oy);
    ctx.lineWidth = pen / sy;
    if (HAS_PATH2D) {
      if (!line.path) { const p = new Path2D(); for (const st of line.strokes) { p.moveTo(st[0], st[1]); for (let i = 2; i < st.length; i += 2) p.lineTo(st[i], st[i + 1]); } line.path = p; }
      ctx.stroke(line.path);
    } else {
      ctx.beginPath();
      for (const st of line.strokes) { ctx.moveTo(st[0], st[1]); for (let i = 2; i < st.length; i += 2) ctx.lineTo(st[i], st[i + 1]); }
      ctx.stroke();
    }
  } else {
    // unequal glyph width / height: build the path in the scaled frame, stroke it in the unscaled one so the pen stays round
    ctx.setTransform(m0, m1, m2, m3, e + m0 * ox + m2 * oy, f + m1 * ox + m3 * oy);
    ctx.beginPath();
    for (const st of line.strokes) { ctx.moveTo(st[0], st[1]); for (let i = 2; i < st.length; i += 2) ctx.lineTo(st[i], st[i + 1]); }
    ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
    ctx.lineWidth = pen;
    ctx.stroke();
  }
  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
}

/**
 * FONT::LinebreakText: word-wrap a (possibly multi-line) string to a column.  Words are split at spaces; a
 * line breaks before the word that would pass `colWidth − thickness`, and the spaces at the break are dropped.
 * A single word wider than the column is left whole, as in KiCad.
 */
export function linebreakText(text: string, colWidth: number, sizeX: number, thickness: number, italic?: boolean): string {
  if (!(colWidth > 0) || !text) return text;
  const space = (strokeGlyph(32) as StrokeGlyph).adv * sizeX;
  const out: string[] = [];
  for (const src of text.split("\n")) {
    let cur = "", width = 0, pending = 0;
    for (const tok of src.split(/( )/)) {
      if (tok === "") continue;
      if (tok === " ") { pending++; continue; }
      const w = (strokeLine(tok, italic).width + INTER_CHAR) * sizeX;   // the cursor advance of the word
      if (pending > 0 && width + pending * space + w > colWidth - thickness) { out.push(cur); cur = tok; width = w; }
      else { cur += " ".repeat(pending) + tok; width += pending * space + w; }
      pending = 0;
    }
    out.push(cur);
  }
  return out.join("\n");
}
