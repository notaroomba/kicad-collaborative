// canvas/outline-text.ts — text set in an outline (TrueType / OpenType) face, laid out as KiCad's OUTLINE_FONT does.
//
// The glyphs themselves are the browser's (the face is registered with the page by web/editor/fonts.ts and drawn
// with fillText); where they go is KiCad's:
//   - an em of 1.4 x the text height (OUTLINE_FONT::m_outlineFontSizeCompensation);
//   - lines 1.68 x the height apart (METRICS::m_InterlinePitch; OUTLINE_FONT::GetInterline has no stroke factor);
//   - each line placed by FONT::getLinePositions: the first baseline one height below the top of a block that is
//     1.17 x the height plus the interlines tall, the block hung from, centred on or stood on the anchor, and every
//     line shifted by its own advance for centre / right justification;
//   - the text box (EDA_TEXT::GetTextBox, what hit tests, the selection box and SCH_TEXT's field-matching offset
//     use) from the face's ascender and descender (FreeType size metrics, OUTLINE_FONT::getTextAsGlyphsUnlocked);
//   - a schematic text (SCH_TEXT) lifted by SCH_TEXT::GetOffsetToMatchSCH_FIELD, 0.4 x (box height - text height);
//   - a schematic field (SCH_FIELD) drawn centred on the centre of its text box (SCH_PAINTER::draw( SCH_FIELD )).
// The face's metrics come from its font file when the page holds it (KiCadCanvas.setFontData), else from what the
// browser reports for the registered face.  A face that is neither held nor on the page is drawn in the stroke font.

/** OUTLINE_FONT::m_outlineFontSizeCompensation: the em is this many text heights. */
export const OUTLINE_EM = 1.4;
/** METRICS::m_InterlinePitch, in text heights. */
export const OUTLINE_INTERLINE = 1.68;
/** FONT::getLinePositions' "fudge to match 6.0 positioning": the first line counts 1.17 heights. */
export const FIRST_LINE = 1.17;
/** ITALIC_TILT (eda_text.h): GetTextBox moves an italic text's box by size / 8. */
const ITALIC_TILT = 1 / 8;
/** OUTLINE_FONT::LoadGlyphContours: a family without an italic is slanted 12 degrees. */
export const FAKE_ITALIC_SLANT = Math.tan(12 * Math.PI / 180);

// ---------------------------------------------------------------- the faces on the page and their files

/** A face name as a CSS font-family entry. */
export const cssFamily = (face: string): string => '"' + String(face).replace(/["'\\<>&;]/g, "") + '"';

/** Bumped whenever a face arrives or leaves: geometry laid out with older metrics is rebuilt (ensureFontGeom). */
export let FONT_GEN = 0;
const FACES = new Map<string, boolean>();
let measureCtx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  try {
    if (typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
    else if (typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(8, 8).getContext("2d") as unknown as CanvasRenderingContext2D;
  } catch (e) { measureCtx = null; }
  return measureCtx;
}
/**
 * Whether the browser can draw text in the named face.  KiCad falls back to its stroke font when fontconfig
 * has no such face; here a face is taken to exist when text set in it measures differently from both generic
 * fallbacks it would otherwise land on.  No canvas (Node) → false.  "KiCad Font" is the stroke font itself.
 */
export function faceAvailable(face: string): boolean {
  let ok = FACES.get(face);
  if (ok !== undefined) return ok;
  ok = false;
  if (face && !/^kicad font$/i.test(face) && typeof document !== "undefined") {
    try {
      const c = ctx2d()!;
      const probe = "mmmmmmmmmmlliWW0123@#", fam = cssFamily(face);
      const w = (f: string) => { c.font = "40px " + f; return c.measureText(probe).width; };   // a 2d context, or the throw below
      ok = w(fam + ", monospace") !== w("monospace") || w(fam + ", serif") !== w("serif");
    } catch (e) { ok = false; }
  }
  FACES.set(face, ok);
  return ok;
}
/** A font arrived on (or left) the page: look again whether the face can be drawn.  No face: every face. */
export function fontChanged(face?: string): void {
  FONT_GEN++; METRICS.clear();
  if (face === undefined) { FACES.clear(); FONT_DATA.clear(); return; }
  FACES.delete(face);
}

/** A font file held for plotting: the bytes, and the style the file really is (a family without a bold answers with its regular). */
export interface FontBytes { data: ArrayBuffer; bold: boolean; italic: boolean }
const FONT_DATA = new Map<string, FontBytes>();
const fontKey = (face: string, bold: boolean, italic: boolean): string => face.toLowerCase() + "|" + (bold ? "b" : "") + "|" + (italic ? "i" : "");
/**
 * The file of a face in the style asked for, kept so that a plot can draw the text's real outlines (web/fab
 * reads the glyphs out of it) and the screen can take the face's ascender and descender from it.  null forgets it.
 */
export function setFontData(face: string, bold: boolean, italic: boolean, font: FontBytes | null): void {
  if (font) FONT_DATA.set(fontKey(face, bold, italic), font); else FONT_DATA.delete(fontKey(face, bold, italic));
  FONT_GEN++; METRICS.clear();
}
export function fontData(face: string, bold: boolean, italic: boolean): FontBytes | null { return FONT_DATA.get(fontKey(face, bold, italic)) || null; }
/** Every file held, as [face, bold, italic, font] of the style it was asked in (to hand them to a worker). */
export function allFontData(): [string, boolean, boolean, FontBytes][] {
  return [...FONT_DATA].map(([k, f]) => { const [face, b, i] = k.split("|"); return [face, b === "b", i === "i", f] as [string, boolean, boolean, FontBytes]; });
}

// ---------------------------------------------------------------- the font file's own numbers

/** What KiCad's layout needs of a font file: units per em, FreeType's face ascender / descender, advance widths. */
export interface SfntInfo { upm: number; asc: number; desc: number; advance(cp: number): number }

/** head / hhea / OS/2 / cmap / hmtx of a TrueType or OpenType file (the first face of a collection); null when unreadable. */
export function readSfnt(buf: ArrayBuffer): SfntInfo | null {
  try {
    const dv = new DataView(buf);
    let base = 0;
    if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12);   // 'ttcf': the first face
    const n = dv.getUint16(base + 4); const T = new Map<string, number>();
    for (let i = 0; i < n; i++) { const r = base + 12 + 16 * i; T.set(String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1), dv.getUint8(r + 2), dv.getUint8(r + 3)), dv.getUint32(r + 8)); }
    const head = T.get("head"), hhea = T.get("hhea"), hmtx = T.get("hmtx"), cmap = T.get("cmap"), os2 = T.get("OS/2");
    if (head === undefined || hhea === undefined) return null;
    const upm = dv.getUint16(head + 18) || 1000;
    // FreeType (sfnt_load_face): OS/2's typographic ascender / descender when its fsSelection sets USE_TYPO_METRICS
    // (bit 7), else the hhea ones, else (both zero) the typographic ones, else the Windows ones
    const os2ok = os2 !== undefined && dv.getUint16(os2) !== 0xffff;
    let asc = dv.getInt16(hhea + 4), desc = dv.getInt16(hhea + 6);
    if (os2ok && dv.getUint16(os2 + 62) & 0x80) { asc = dv.getInt16(os2 + 68); desc = dv.getInt16(os2 + 70); }
    else if (!asc && !desc && os2ok) {
      const ta = dv.getInt16(os2 + 68), td = dv.getInt16(os2 + 70);
      if (ta || td) { asc = ta; desc = td; } else { asc = dv.getUint16(os2 + 74); desc = -dv.getUint16(os2 + 76); }
    }
    const nh = dv.getUint16(hhea + 34);
    const adv = (gid: number): number => hmtx === undefined || !nh ? 0 : dv.getUint16(hmtx + 4 * Math.min(gid, nh - 1));
    const glyph = cmapLookup(dv, cmap);
    return { upm, asc, desc, advance: (cp: number) => adv(glyph(cp)) };
  } catch (e) { return null; }
}
function cmapLookup(dv: DataView, cmap: number | undefined): (cp: number) => number {
  if (cmap === undefined) return () => 0;
  const n = dv.getUint16(cmap + 2); let f4 = -1, f12 = -1;
  for (let i = 0; i < n; i++) {
    const r = cmap + 4 + 8 * i, pid = dv.getUint16(r), eid = dv.getUint16(r + 2), off = cmap + dv.getUint32(r + 4), fmt = dv.getUint16(off);
    if (fmt === 12 && (pid === 0 || (pid === 3 && eid === 10))) f12 = off;
    else if (fmt === 4 && (pid === 0 || (pid === 3 && (eid === 1 || eid === 0)))) { if (f4 < 0 || pid === 3) f4 = off; }
  }
  const cache = new Map<number, number>();
  return (cp: number): number => {
    let g = cache.get(cp); if (g !== undefined) return g; g = 0;
    if (f12 >= 0) {
      const groups = dv.getUint32(f12 + 12);
      for (let i = 0; i < groups; i++) { const r = f12 + 16 + 12 * i, s = dv.getUint32(r), e = dv.getUint32(r + 4); if (cp >= s && cp <= e) { g = dv.getUint32(r + 8) + cp - s; break; } }
    } else if (f4 >= 0 && cp <= 0xffff) {
      const segX2 = dv.getUint16(f4 + 6), ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        if (cp > dv.getUint16(ends + 2 * i)) continue;
        const s = dv.getUint16(starts + 2 * i); if (cp < s) break;
        const ro = dv.getUint16(ranges + 2 * i), d = dv.getInt16(deltas + 2 * i);
        if (!ro) g = (cp + d) & 0xffff;
        else { const gi = dv.getUint16(ranges + 2 * i + ro + 2 * (cp - s)); g = gi ? (gi + d) & 0xffff : 0; }
        break;
      }
    }
    cache.set(cp, g); return g;
  };
}

// ---------------------------------------------------------------- the metrics a layout uses

/** A face as the layout sees it, in ems: ascender and descender (both positive), the advance of a run, and how it is drawn. */
export interface FaceMetrics {
  asc: number; desc: number;
  /** the advance of a run of text, ems */
  advance(text: string): number;
  /** the CSS font for a 1px em (scale the size): the style the file really is, so the browser synthesises nothing */
  css: string;
  /** a family without an italic: KiCad slants the regular 12 degrees */
  slant: boolean;
}
const METRICS = new Map<string, FaceMetrics | null>();
/** The file held for a face in a style: the style asked, else whatever of the family is held (OUTLINE_FONT via fontconfig). */
function heldFile(face: string, bold: boolean, italic: boolean): FontBytes | null {
  for (const [b, i] of [[bold, italic], [false, italic], [bold, false], [false, false]] as [boolean, boolean][]) { const f = fontData(face, b, i); if (f) return f; }
  return null;
}
/**
 * The metrics of an outline face in a style, or null when the face can be neither read nor drawn here (the text is
 * then drawn and measured in the stroke font).  A face on the page is measured as the browser draws it (shaping and
 * kerning included, as HarfBuzz does for KiCad); the ascender and descender come from the file when it is held.
 */
export function faceMetrics(face: string | undefined, bold: boolean, italic: boolean): FaceMetrics | null {
  if (!face || /^kicad font$/i.test(face)) return null;
  const key = fontKey(face, bold, italic);
  if (METRICS.has(key)) return METRICS.get(key)!;
  const file = heldFile(face, bold, italic), info = file ? readSfnt(file.data) : null;
  const onPage = faceAvailable(face);
  let m: FaceMetrics | null = null;
  if (info || onPage) {
    // the file's own style: a bold asked of a regular-only family is KiCad's 1/64 px FT_Outline_Embolden (nothing to see),
    // an italic asked of an upright-only family the 12 degree slant, never the browser's synthetic bold or oblique
    const fileBold = file ? file.bold : bold, fileItalic = file ? file.italic : italic;
    const css = `${fileItalic ? "italic " : ""}${fileBold ? "bold " : ""}1px ${cssFamily(face)}`;
    const c = onPage ? ctx2d() : null;
    let asc = 0.8, desc = 0.2;
    if (info) { asc = info.asc / info.upm; desc = -info.desc / info.upm; }
    else if (c) {
      c.font = css.replace("1px", "100px"); const tm = c.measureText("Hg") as TextMetrics & { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
      if (tm.fontBoundingBoxAscent) { asc = tm.fontBoundingBoxAscent / 100; desc = (tm.fontBoundingBoxDescent || 0) / 100; }
    }
    const widths = new Map<string, number>();
    const advance = (text: string): number => {
      let w = widths.get(text); if (w !== undefined) return w;
      if (c) { c.font = css.replace("1px", "100px"); w = c.measureText(text).width / 100; }
      else { w = 0; for (const ch of text) w += info!.advance(ch.codePointAt(0)!) / info!.upm; }
      if (widths.size < 4096) widths.set(text, w);
      return w;
    };
    m = { asc, desc, advance, css, slant: italic && !fileItalic };
  }
  METRICS.set(key, m);
  return m;
}

/**
 * FreeType's size metrics as OUTLINE_FONT sees them: the face set to 16 x 1.4 points at 1152 dpi (faceSize(),
 * GLYPH_RESOLUTION), the ascender rounded up and the descender down to whole 26.6 pixels, then scaled back to ems.
 */
export function kicadAscDesc(m: Pick<FaceMetrics, "asc" | "desc">): { asc: number; desc: number } {
  const faceSize = Math.trunc(16 * 64 * OUTLINE_EM), ppem = faceSize * 1152 / 72;   // 26.6 pixels per em
  return { asc: Math.ceil(m.asc * ppem / 64) * 64 / ppem, desc: Math.ceil(m.desc * ppem / 64) * 64 / ppem };
}

// ---------------------------------------------------------------- layout

/**
 * Where a line of an outline-font text sits within its whole text (set by textLines): the block's anchor, which line
 * this is of how many, the first line (its overbar grows the text box) and how KiCad positions the item:
 * "text" = SCH_TEXT (lifted by GetOffsetToMatchSCH_FIELD; `lift` is the schematic text offset already in the anchor),
 * "field" = SCH_FIELD (centred on its text box), otherwise FONT::Draw at the anchor.
 */
export interface OutlineBlock {
  x: number; y: number; line: number; lines: number; first: string; kind?: "text" | "field"; lift?: number;
  /** a multi-line field: the shown text of every line (its box is as wide as the widest, every line centred on it) */
  all?: string[];
}
/** What the layout needs of a text geometry. */
export interface OutlineTextG { x: number; y: number; text: string; raw?: string; size: number; sizeX?: number; rot?: number; h: string; v: string; mirror?: boolean; bold?: boolean; italic?: boolean; face?: string; olBlock?: OutlineBlock }
/** One laid-out line in the text's own frame (origin at `ox, oy`, x along the reading direction, y down): its left end on the baseline, and its box. */
export interface OutlineLayout {
  ox: number; oy: number; rot: number; mirror: boolean; size: number; sizeX: number; em: number; emX: number;
  metrics: FaceMetrics; text: string; x: number; baseline: number; width: number;
  /** EDA_TEXT::GetTextBox of this line, local frame */
  box: [number, number, number, number];
}

/** The KiCad layout of one outline-font text geometry, or null when its face is not available (stroke font). */
export function outlineLayout(g: OutlineTextG): OutlineLayout | null {
  if (!g.face) return null;
  const m = faceMetrics(g.face, !!g.bold, !!g.italic); if (!m) return null;
  const size = g.size || 1.27, sizeX = g.sizeX && g.sizeX > 0 ? g.sizeX : size;
  const em = size * OUTLINE_EM, emX = sizeX * OUTLINE_EM;
  const blk = g.olBlock, n = blk ? Math.max(1, blk.lines) : 1, i = blk ? Math.min(blk.line, n - 1) : 0;
  const ox = blk ? blk.x : g.x, oy = blk ? blk.y : g.y, rot = g.rot || 0, mirror = !!g.mirror;
  const text = g.text || "", width = m.advance(text) * emX;
  const { asc, desc } = kicadAscDesc(m);
  const interline = size * OUTLINE_INTERLINE;
  // the text box (EDA_TEXT::GetTextBox): ascender + descender of the face tall (the first line a sixth more with an
  // overbar), the lines an interline apart, hung from / centred on / stood on the item's position (no 0.17 fudge
  // inside an outline box, but the top / bottom offset by it all the same)
  const lineH = (asc + desc) * em, firstH = lineH * (/~\{/.test(blk ? blk.first : g.raw || text) ? 7 / 6 : 1);
  const boxH = firstH + (n - 1) * interline, fudge = Math.round(lineH * 0.17 * 1e6) / 1e6;
  const italicOff = g.italic ? size * ITALIC_TILT : 0;
  // the box's own anchor in the local frame: the item position (an SCH_TEXT's box ignores its schematic text offset)
  let ax = 0, ay = 0;
  if (blk && blk.kind === "text" && blk.lift) { const [lx, ly] = toLocal(0, blk.lift, rot, mirror); ax = lx; ay = ly; }
  const lineW = (s: number) => (g.h === "left" ? s : g.h === "right" ? s - width : s - width / 2);
  // a field's box is GetTextBox( -1 ): as wide as its widest line; any other text's line box is that line's own
  const field = !!blk && blk.kind === "field";
  const boxW = field && blk!.all && blk!.all.length > 1 ? Math.max(width, ...blk!.all.map((t) => m.advance(t) * emX)) : width;
  const bx0 = ax + (g.h === "left" ? 0 : g.h === "right" ? -(boxW - italicOff) : -(boxW - italicOff) / 2);
  const by0 = ay + (g.v === "top" ? -fudge : g.v === "bottom" ? -boxH + fudge : -boxH / 2);
  const lineTop = by0 + (i ? firstH + (i - 1) * interline + (interline - lineH) : 0);
  // SCH_PAINTER::draw( SCH_FIELD ) centres every line on the field's box (FONT::getLinePositions, -lineSize.x / 2)
  const lx0 = field ? bx0 + (boxW - width) / 2 : bx0;
  const box: [number, number, number, number] = [lx0, lineTop, lx0 + width, lineTop + (i ? lineH : firstH)];
  // FONT::getLinePositions: the baselines (single line: one height below the top of a 1.17-height block)
  const blockH = size * FIRST_LINE + (n - 1) * interline;
  const firstBase = (v: string) => size - (v === "top" ? 0 : v === "bottom" ? blockH : blockH / 2);
  let x: number, baseline: number;
  if (field) {
    // SCH_PAINTER::draw( SCH_FIELD ): centred, horizontally and vertically, on the centre of the field's text box
    const cx = bx0 + boxW / 2, cy = by0 + boxH / 2;
    x = cx - width / 2; baseline = cy + firstBase("middle") + i * interline;
  } else {
    x = lineW(0); baseline = firstBase(g.v) + i * interline;
    // SCH_TEXT::GetOffsetToMatchSCH_FIELD: up by 0.4 x (first line box height - text height), rounded to the IU
    if (blk && blk.kind === "text") baseline -= Math.round(0.4 * (firstH - size) * 1e4) / 1e4;
  }
  return { ox, oy, rot, mirror, size, sizeX, em, emX, metrics: m, text, x, baseline, width, box };
}

/** A vector in the document turned into a text's own frame (the inverse of its rotation and mirror). */
function toLocal(dx: number, dy: number, rot: number, mirror: boolean): [number, number] {
  const a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // the frame turns by -rot on screen (y down): local x = (c, -s), local y = (s, c)
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return [mirror ? -lx : lx, ly];
}
/** A point of a text's own frame in the document. */
export function fromLocal(L: Pick<OutlineLayout, "ox" | "oy" | "rot" | "mirror">, lx: number, ly: number): [number, number] {
  const a = -L.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), x = L.mirror ? -lx : lx;
  return [L.ox + x * c - ly * s, L.oy + x * s + ly * c];
}
/** The four corners of an outline-font text's box in the document, or null when it is drawn in the stroke font. */
export function outlineBoxCorners(g: OutlineTextG): [number, number][] | null {
  const L = outlineLayout(g); if (!L) return null;
  const [x0, y0, x1, y1] = L.box;
  return [fromLocal(L, x0, y0), fromLocal(L, x1, y0), fromLocal(L, x1, y1), fromLocal(L, x0, y1)];
}
