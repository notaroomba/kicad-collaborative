// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
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
export function lineOffsets(n, vjust) {
  const k = vjust === "top" ? 0 : vjust === "bottom" ? n - 1 : (n - 1) / 2;
  const out = []; for (let i = 0; i < n; i++) out.push(i - k);
  return out;
}

export function textWidth(text, size, thick) {
  let w = 0;
  for (const ch of text) { const c = ch.charCodeAt(0) - 32; w += (c >= 0 && c < 95 ? STROKE_ADV[c] : 21) / 21; }
  return text.length ? Math.max(0, w - 0.2) * size + 3 * (thick || 0) : 0;
}

/** Strip KiCad text markup; overbar spans (~{...}) are kept as [start, end) indices of the shown text. */
export function parseMarkup(s) {
  if (s.indexOf("{") < 0) return { text: s, bars: null };
  let out = "", bars = null; const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], d = s[i + 1];
    if ((c === "~" || c === "_" || c === "^") && d === "{") { stack.push({ kind: c, start: out.length }); i++; continue; }
    if (c === "}" && stack.length) { const o = stack.pop(); if (o.kind === "~") (bars = bars || []).push([o.start, out.length]); continue; }
    out += c;
  }
  return { text: out, bars };
}

export const INTERLINE = 1.68 * 0.9583;
   // stroke font line pitch (font_metrics.h × STROKE_FONT legacy factor)
export const SCH_PEN = 0.1524;
             // DEFAULT_LINE_WIDTH_MILS (6 mil)
export const MIL = 0.0254;

export function textPen(ef, size) {
  // EDA_TEXT::GetEffectiveTextPenWidth with the schematic default pen (0): size/8, bold size/5, clamped to size/4
  let pen = ef.thick > 0.001 ? ef.thick : (ef.bold ? size / 5 : size / 8);
  return Math.min(pen, size * 0.25);
}
