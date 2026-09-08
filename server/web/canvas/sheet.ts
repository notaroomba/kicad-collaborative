// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — matches the rest of the canvas package; typing is being tightened module by module
//
// ---------------------------------------------------------------- the drawing sheet
//
// KiCad's page is not a rectangle: it is the (kicad_wks …) drawing sheet, drawn by
// common/drawing_sheet/.  This module transcribes KiCad's built-in sheet verbatim
// (common/drawing_sheet/drawing_sheet_default_description.cpp `defaultDrawingSheet`)
// and interprets it the way DS_DATA_ITEM / DS_DRAW_ITEM_LIST do, so the repeats,
// the tick labels and the title-block text all fall out of the same description
// instead of being hand-unrolled here.
//
// Coordinates.  Every point in a wks description is measured from a page CORNER of
// the *framed* area — the paper inset by the (setup …) margins — and grows towards
// the opposite corner (DS_DATA_ITEM::GetStartPos, ds_data_item.cpp:263-291):
//     LT = (leftMargin, topMargin)                              (ds_data_model.cpp:88-105)
//     RB = (pageWidth - rightMargin, pageHeight - bottomMargin)
//     rbcorner (the default): RB - p      rtcorner: (RB.x - p.x, LT.y + p.y)
//     lbcorner: (LT.x + p.x, RB.y - p.y)  ltcorner: LT + p
// (repeat N) (incrx dx) (incry dy) emit N copies at p + (dx, dy)·j — the increment is
// applied to start and end alike, which is how one (rect … (repeat 2) (incrx 2) (incry 2))
// draws both frame rectangles.  A copy is dropped when it walks off the framed area
// (DS_DATA_ITEM::IsInsidePage, :338-358); copy 0 is always kept.  Repeated text steps its
// label from the base text by an absolute delta each time (DS_DATA_ITEM_TEXT::IncrementLabel,
// :621-633, via STRING_INCREMENTER, common/increment.cpp:83-243) — "1" 2 3 …, "A" B C … Z AA AB.
//
// Text.  Sizes and pen widths follow DS_DATA_ITEM_TEXT::SyncDrawItems (:521-606) and
// EDA_TEXT::GetEffectiveTextPenWidth: 1.5 mm / 0.15 mm by default, and bold text feeds
// pen 0 so the auto-bold width (size/5) applies — 0.30 mm for the bold 1.5 mm fields,
// 0.40 mm for the 2 mm bold-italic title.  Justification defaults to left / vertically
// centred, and `(justify center)` sets BOTH axes (drawing_sheet_parser.cpp:820-845), which
// is why only the A/B/C row labels are centred and the 1/2/3 column labels are not.
//
// Nothing here touches a canvas: buildDrawingSheet() returns plain records so render()
// (canvas) and renderSvg() (export) can paint the same geometry.
import { num, parse, str } from "./sexpr";
import { textWidth } from "./text";

/** common/drawing_sheet/drawing_sheet_default_description.cpp:117-151, verbatim. */
export const DEFAULT_DRAWING_SHEET = `(kicad_wks (version 20210606) (generator pl_editor)
(setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
(left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
(rect (name "") (start 110 34) (end 2 2) (comment "rect around the title block"))
(rect (name "") (start 0 0 ltcorner) (end 0 0) (repeat 2) (incrx 2) (incry 2))
(line (name "") (start 50 2 ltcorner) (end 50 0 ltcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 ltcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 50 2 lbcorner) (end 50 0 lbcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 lbcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 0 50 ltcorner) (end 2 50 ltcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 ltcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(line (name "") (start 0 50 rtcorner) (end 2 50 rtcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 rtcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(tbtext "Date: \${ISSUE_DATE}" (name "") (pos 87 6.9))
(line (name "") (start 110 5.5) (end 2 5.5))
(tbtext "\${KICAD_VERSION}" (name "") (pos 109 4.1) (comment "Kicad version"))
(line (name "") (start 110 8.5) (end 2 8.5))
(tbtext "Rev: \${REVISION}" (name "") (pos 24 6.9) (font bold))
(tbtext "Size: \${PAPER}" (name "") (pos 109 6.9) (comment "Paper format name"))
(tbtext "Id: \${#}/\${##}" (name "") (pos 24 4.1) (comment "Sheet id"))
(line (name "") (start 110 12.5) (end 2 12.5))
(tbtext "Title: \${TITLE}" (name "") (pos 109 10.7) (font (size 2 2) bold italic))
(tbtext "File: \${FILENAME}" (name "") (pos 109 14.3))
(line (name "") (start 110 18.5) (end 2 18.5))
(tbtext "Sheet: \${SHEETPATH}" (name "") (pos 109 17))
(tbtext "\${COMPANY}" (name "") (pos 109 20) (font bold) (comment "Company name"))
(tbtext "\${COMMENT1}" (name "") (pos 109 23) (comment "Comment 0"))
(tbtext "\${COMMENT2}" (name "") (pos 109 26) (comment "Comment 1"))
(tbtext "\${COMMENT3}" (name "") (pos 109 29) (comment "Comment 2"))
(tbtext "\${COMMENT4}" (name "") (pos 109 32) (comment "Comment 3"))
(line (name "") (start 90 8.5) (end 90 5.5))
(line (name "") (start 26 8.5) (end 26 2))
)`;

// TB_DEFAULT_TEXTSIZE / the DS_DATA_MODEL constructor's defaults (include/drawing_sheet/ds_data_item.h:31,
// common/drawing_sheet/ds_data_model.cpp:44-69).
export const WKS_DEFAULTS = { textSizeX: 1.5, textSizeY: 1.5, lineWidth: 0.15, textLineWidth: 0.15, left: 10, right: 10, top: 10, bottom: 10 };

/** DS_MAX_REPEAT_COUNT (include/drawing_sheet/ds_data_item.h:63). */
export const DS_MAX_REPEAT_COUNT = 100;

const CORNERS = { ltcorner: "lt", lbcorner: "lb", rbcorner: "rb", rtcorner: "rt" };

function coordOf(node, from) {
  // (start x y [corner]) / (end …) / (pos …); the anchor defaults to rbcorner (drawing_sheet_parser.cpp:866-882)
  const c = { x: num(node[from], 0), y: num(node[from + 1], 0), anchor: "rb" };
  for (let j = from + 2; j < node.length; j++) { const a = CORNERS[str(node[j])]; if (a) c.anchor = a; }
  return c;
}

/**
 * A (kicad_wks …) description → { setup, items }.  Only the tokens the default sheet and the
 * common custom sheets use are honoured (rect / line / tbtext with repeat, incrx/incry, incrlabel,
 * linewidth, font, justify, rotate, maxlen, maxheight, option); bitmaps and polygons are skipped.
 */
export function parseDrawingSheet(text) {
  const tree = typeof text === "string" ? parse(text) : text;
  const setup = Object.assign({}, WKS_DEFAULTS);
  const items = [];
  if (!tree || tree[0] !== "kicad_wks") return { setup, items };
  for (let j = 1; j < tree.length; j++) {
    const node = tree[j]; if (!Array.isArray(node)) continue;
    if (node[0] === "setup") {
      for (const s of node.slice(1)) {
        if (!Array.isArray(s)) continue;
        if (s[0] === "textsize") { setup.textSizeX = num(s[1], setup.textSizeX); setup.textSizeY = num(s[2], setup.textSizeY); }
        else if (s[0] === "linewidth") setup.lineWidth = num(s[1], setup.lineWidth);
        else if (s[0] === "textlinewidth") setup.textLineWidth = num(s[1], setup.textLineWidth);
        else if (s[0] === "left_margin") setup.left = num(s[1], setup.left);
        else if (s[0] === "right_margin") setup.right = num(s[1], setup.right);
        else if (s[0] === "top_margin") setup.top = num(s[1], setup.top);
        else if (s[0] === "bottom_margin") setup.bottom = num(s[1], setup.bottom);
      }
      continue;
    }
    const kind = node[0];
    if (kind !== "rect" && kind !== "line" && kind !== "tbtext") continue;
    const it = { kind, repeat: 1, incr: [0, 0], incrLabel: 1, lineWidth: 0, option: "", rot: 0,
      bold: false, italic: false, sizeX: 0, sizeY: 0, color: null, hjust: "left", vjust: "middle",
      maxlen: 0, maxheight: 0, text: kind === "tbtext" ? str(node[1]) : "" };
    for (const c of node.slice(1)) {
      if (!Array.isArray(c)) continue;
      switch (c[0]) {
        case "start": it.start = coordOf(c, 1); break;
        case "end": it.end = coordOf(c, 1); break;
        case "pos": it.start = coordOf(c, 1); break;
        case "repeat": it.repeat = Math.min(Math.max(Math.round(num(c[1], 1)), 1), DS_MAX_REPEAT_COUNT); break;
        case "incrx": it.incr[0] = num(c[1], 0); break;
        case "incry": it.incr[1] = num(c[1], 0); break;
        case "incrlabel": it.incrLabel = Math.round(num(c[1], 1)); break;
        case "linewidth": it.lineWidth = num(c[1], 0); break;
        case "maxlen": it.maxlen = num(c[1], 0); break;
        case "maxheight": it.maxheight = num(c[1], 0); break;
        case "rotate": it.rot = num(c[1], 0); break;
        case "option": it.option = str(c[1]); break;
        case "justify":
          for (const t of c.slice(1)) {
            const v = str(t);
            if (v === "center") { it.hjust = "center"; it.vjust = "middle"; }   // sets BOTH axes
            else if (v === "left") it.hjust = "left";
            else if (v === "right") it.hjust = "right";
            else if (v === "top") it.vjust = "top";
            else if (v === "bottom") it.vjust = "bottom";
          }
          break;
        case "font":
          for (const f of c.slice(1)) {
            if (f === "bold") it.bold = true;
            else if (f === "italic") it.italic = true;
            else if (Array.isArray(f)) {
              if (f[0] === "size") { it.sizeX = num(f[1], 0); it.sizeY = num(f[2], 0); }
              else if (f[0] === "linewidth") it.lineWidth = num(f[1], 0);
              else if (f[0] === "color") { const a = num(f[4], 1); if (a > 0) it.color = `rgba(${num(f[1])},${num(f[2])},${num(f[3])},${+a.toFixed(3)})`; }
            }
          }
          break;
      }
    }
    if (!it.start) it.start = { x: 0, y: 0, anchor: "rb" };
    if (!it.end) it.end = { x: it.start.x, y: it.start.y, anchor: it.start.anchor };
    items.push(it);
  }
  return { setup, items };
}

/** The built-in sheet, parsed once. */
let DEFAULT_SHEET = null;
export function defaultDrawingSheet() { if (!DEFAULT_SHEET) DEFAULT_SHEET = parseDrawingSheet(DEFAULT_DRAWING_SHEET); return DEFAULT_SHEET; }

// ---------------------------------------------------------------- label increment
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** IndexFromAlphabetic (common/increment.cpp:249-268): A→0 … Z→25, AA→26, BA→52. */
export function indexFromAlphabetic(s, alphabet) {
  const alpha = alphabet || ALPHABET, radix = alpha.length; let index = 0;
  for (let i = 0; i < s.length; i++) {
    let k = alpha.indexOf(s[i]); if (k < 0) return -1;
    if (i !== s.length - 1) k++;
    index += k * Math.pow(radix, s.length - 1 - i);
  }
  return index;
}

/** AlphabeticFromIndex(n, alpha, zeroBasedNonUnitCols = true) (common/increment.cpp:270-291). */
export function alphabeticFromIndex(n, alphabet) {
  const alpha = alphabet || ALPHABET, radix = alpha.length;
  let out = "", first = true;
  do {
    let mod = n % radix;
    if (!first) mod--;
    out = alpha[mod] + out;
    n = Math.floor(n / radix);
    first = false;
  } while (n);
  return out;
}

/**
 * STRING_INCREMENTER::Increment(str, delta, 0) with SkipIOSQXZ off and no alphabetic bound —
 * the settings DS_DATA_ITEM_TEXT::IncrementLabel uses (common/increment.cpp:83-243).  Walks in
 * from the right, chunking \d+$ (integer), ([a-z]+|[A-Z]+)$ (single-case run) and [^a-zA-Z0-9]+$
 * (skipped), and steps the first incrementable chunk in place.  null when there is none.
 */
export function incrementString(s, delta) {
  if (!s) return null;
  let remaining = s; const parts = []; let good = 0;
  while (good <= 0 && remaining) {
    let m = /\d+$/.exec(remaining);
    if (m) { parts.push({ s: m[0], type: "int" }); good++; }
    else if ((m = /([a-z]+|[A-Z]+)$/.exec(remaining))) { parts.push({ s: m[0], type: "alpha" }); good++; }
    else if ((m = /[^a-zA-Z0-9]+$/.exec(remaining))) parts.push({ s: m[0], type: "skip" });
    else break;
    remaining = remaining.slice(0, remaining.length - m[0].length);
  }
  if (good <= 0) return null;
  const last = parts[parts.length - 1];
  let stepped;
  if (last.type === "int") {
    const oldLen = last.s.length, padded = last.s[0] === "0";
    const n = parseInt(last.s, 10) + delta;
    if (!isFinite(n) || n < 0) return null;
    stepped = String(n);
    if (padded && stepped.length < oldLen) stepped = "0".repeat(oldLen - stepped.length) + stepped;
  } else {
    const upper = last.s.toUpperCase(), wasUpper = last.s === upper;
    const index = indexFromAlphabetic(upper, ALPHABET);
    if (index < 0) return null;
    const next = index + delta;
    if (next < 0) return null;
    stepped = alphabeticFromIndex(next, ALPHABET);
    if (!wasUpper) stepped = stepped.toLowerCase();
  }
  last.s = stepped;
  let out = remaining;
  for (let i = parts.length - 1; i >= 0; i--) out += parts[i].s;
  return out;
}

/** DS_DATA_ITEM_TEXT::IncrementLabel: always steps the BASE text by an absolute delta. */
export function incrementLabel(base, delta) { const s = incrementString(base, delta); return s === null ? base : s; }

// ---------------------------------------------------------------- text variables
/**
 * ExpandTextVars (common/common.cpp:240-325): ${TOKEN} through the resolver, innermost first,
 * and an unresolved reference is left in the text verbatim.
 */
export function expandTextVars(text, resolve, depth) {
  const src = str(text); if (src.indexOf("${") < 0) return src;
  const d = depth || 0; let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "$" && src[i + 1] === "{") {
      let j = i + 2, level = 1;
      for (; j < src.length && level; j++) { if (src[j] === "{") level++; else if (src[j] === "}") level--; }
      if (level) { out += src.slice(i); break; }          // unbalanced: copy the rest through
      let token = src.slice(i + 2, j - 1);
      if (token.indexOf("${") >= 0 && d < 10) token = expandTextVars(token, resolve, d + 1);
      const v = resolve(token);
      // KiCad's resolver takes the token by reference and may rewrite it even when it goes on to
      // report failure, and `newbuf.append( "${" + token + "}" )` then wraps whatever is left in it
      // (common/common.cpp:311-315).  `{ ref }` is that case; null is an untouched miss.
      if (v === null || v === undefined) out += "${" + token + "}";
      else if (typeof v === "object" && typeof v.ref === "string") out += "${" + v.ref + "}";
      else out += v;
      i = j - 1;
    } else out += src[i];
  }
  return out;
}

const TWO = (n) => (n < 10 ? "0" : "") + n;
const joinPath = (dir, name) => (dir ? dir.replace(/\/+$/, "") + "/" + name.replace(/^\/+/, "") : name);

/** ds_painter.cpp:40 — `static const wxString productName = wxT( "KiCad E.D.A." )`. */
export const PRODUCT_NAME = "KiCad E.D.A.";

/**
 * The tokens DS_DRAW_ITEM_LIST::BuildFullText's own lambda answers, before it ever looks at the
 * title block (ds_painter.cpp:112-172).
 */
export const WS_TOKENS = new Set(["KICAD_VERSION", "#", "##", "SHEETNAME", "SHEETPATH", "FILENAME", "FILEPATH",
  "PAPER", "LAYER", "VARIANT", "VARIANT_DESC"]);

/** The tokens TITLE_BLOCK::TextVarResolver answers (title_block.cpp:122-190). */
export const TB_TOKENS = new Set(["ISSUE_DATE", "CURRENT_DATE", "CURRENT_TIME_HH_MM_SS", "CURRENT_TIME_LOCALE",
  "REVISION", "TITLE", "COMPANY", "COMMENT1", "COMMENT2", "COMMENT3", "COMMENT4", "COMMENT5", "COMMENT6",
  "COMMENT7", "COMMENT8", "COMMENT9"]);

/**
 * The document's text-variable values, in DS_DRAW_ITEM_LIST::BuildFullText's order
 * (ds_painter.cpp:112-226) followed by TITLE_BLOCK::TextVarResolver (title_block.cpp:122-190).
 * A field the document does not carry resolves to the empty string, exactly as KiCad's
 * resolver does — "Rev: ${REVISION}" on a schematic with no revision reads "Rev: ".
 *
 * ${KICAD_VERSION} is `productName + " " + GetBaseVersion()` (ds_painter.cpp:40,119-121); the base
 * version is the KiCad this tree builds, baked in by scripts/gen-version.js (canvas/version.ts) and
 * carried on doc.kicadVersion, so the web's title block reads the same string the desktop's does.
 */
export function sheetTextVars(doc) {
  const tb = (doc && doc.titleBlock) || {};
  const now = new Date();
  const vars = {
    KICAD_VERSION: PRODUCT_NAME + " " + str(doc && doc.kicadVersion),
    "#": str(doc && doc.pageNumber) || "1",
    "##": String((doc && doc.sheetCount) || 1),
    SHEETNAME: str(doc && doc.sheetName),
    SHEETPATH: str(doc && doc.sheetPath),
    FILENAME: str(doc && doc.fileName),
    // wxFileName( m_fileName ).GetFullPath() (ds_painter.cpp:149-153): the directory and the name.
    // KiCad's m_fileName is the absolute path the program opened; the browser has only the document's
    // path inside the shared project — every peer's local copy sits somewhere different, so there is
    // no one filesystem path to quote.  doc.fileRoot is the hook for a host that does know one.
    FILEPATH: joinPath(str(doc && doc.fileRoot), str(doc && doc.filePath) || str(doc && doc.fileName)),
    PROJECTNAME: str(doc && doc.projectName),
    PAPER: str(doc && doc.paper) || "A4",
    LAYER: str(doc && doc.sheetLayer),
    VARIANT: "", VARIANT_DESC: "",
    ISSUE_DATE: str(tb.date),
    CURRENT_DATE: `${now.getFullYear()}-${TWO(now.getMonth() + 1)}-${TWO(now.getDate())}`,
    CURRENT_TIME_HH_MM_SS: `${TWO(now.getHours())}:${TWO(now.getMinutes())}:${TWO(now.getSeconds())}`,
    CURRENT_TIME_LOCALE: now.toLocaleTimeString(),
    REVISION: str(tb.rev),
    TITLE: str(tb.title),
    COMPANY: str(tb.company),
  };
  for (let i = 1; i <= 9; i++) vars["COMMENT" + i] = str(tb["comment" + i]);
  if (doc && doc.sheetVars) Object.assign(vars, doc.sheetVars);
  return vars;
}

/**
 * BuildFullText's `wsResolver` over a plain {token: value} map (ds_painter.cpp:112-226).  Its three
 * layers are not interchangeable, and KiCad's differences between them are visible in a title block:
 *
 *  - A worksheet token (WS_TOKENS) resolves to its value, expanded against the PROJECT's text
 *    variables only — never against the title block.  ${FILEPATH} returns straight out and skips
 *    even that (`return true` at ds_painter.cpp:149-153).
 *  - A title-block token resolves through TITLE_BLOCK::TextVarResolver, and BuildFullText then
 *    re-runs *this* resolver over the value with `m_titleBlock = nullptr` (ds_painter.cpp:174-186),
 *    so a title-block token nested inside a title-block field is deliberately left unresolved:
 *    (company "A ${TITLE} B") draws "A ${TITLE} B", not the title.
 *  - A field holding exactly its own reference — (rev "${REVISION}") — trips TITLE_BLOCK's "this is
 *    the default fallback, so don't claim we resolved it" test (title_block.cpp:186-188) *after* it
 *    has already rewritten the token to "${REVISION}", and ExpandTextVars wraps what it finds in the
 *    token: KiCad draws "Rev: ${${REVISION}}".  `{ ref }` reproduces that.
 *  - Anything none of them claims falls through to the project's text variables (:222-223).
 *
 * opts: { titleBlock: false } is the inner pass with the title block switched off; { project } is
 * the .kicad_pro's text_variables map.
 */
export function varResolver(vars, opts) {
  const o = opts || {};
  const withTb = o.titleBlock !== false;
  const project = o.project || null;
  const fromProject = (token) => { const v = project ? project[token] : undefined; return v === undefined || v === null ? null : String(v); };
  const expandProject = (text) => (project ? expandTextVars(text, fromProject) : text);
  return (token) => {
    if (WS_TOKENS.has(token)) {
      const v = vars[token];
      if (v === undefined || v === null) return null;
      return token === "FILEPATH" ? String(v) : expandProject(String(v));
    }
    if (withTb && TB_TOKENS.has(token)) {
      const raw = vars[token];
      if (raw !== undefined && raw !== null) {
        const value = token === "CURRENT_DATE" ? String(raw) : expandProject(String(raw));
        if (value === "${" + token + "}") { const p = fromProject(value); return p === null ? { ref: value } : p; }
        return expandTextVars(value, varResolver(vars, { titleBlock: false, project }));
      }
    }
    return fromProject(token);
  };
}

/** DS_DATA_ITEM_TEXT::ReplaceAntiSlashSequence (ds_data_item.cpp:639-671): \\ → \, \n → newline. */
export function replaceAntiSlash(s) {
  let out = "", multiline = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "\\") { out += "\\"; i++; continue; }
    if (s[i] === "\\" && s[i + 1] === "n") { out += "\n"; multiline = true; i++; continue; }
    out += s[i];
  }
  return { text: out, multiline };
}

// ---------------------------------------------------------------- geometry
/**
 * EDA_TEXT::GetEffectiveTextPenWidth with DS_DATA_ITEM_TEXT's bold rule (ds_data_item.cpp:546-551,
 * common/gr_text.cpp:33-74): bold text is fed pen 0 so it picks up the auto-bold width size/5;
 * everything is clamped to a quarter of the glyph size.
 */
export function sheetTextPen(pen, size, bold) {
  let t = bold ? 0 : pen;
  if (t <= 0) t = bold ? size / 5 : size / 8;
  return Math.min(t, size * 0.25);
}

/**
 * The drawing sheet for one page as flat draw records, in KiCad's own item order:
 *   { t: "line", x1, y1, x2, y2, w }
 *   { t: "rect", x, y, w, h, lw }
 *   { t: "text", x, y, text, size, w, bold, italic, h, v, rot, color }
 * `page` is [width, height] in mm; `vars` is the resolver map (sheetTextVars); `wks` is a parsed
 * description (the built-in sheet by default); `firstPage` filters (option page1only|notonpage1);
 * `project` is the project's text_variables map (the .kicad_pro's), KiCad's last resolver.
 */
export function buildDrawingSheet(page, vars, wks, firstPage, project) {
  const sheet = wks || defaultDrawingSheet();
  const setup = sheet.setup;
  const LT = [setup.left, setup.top];
  const RB = [page[0] - setup.right, page[1] - setup.bottom];
  const resolve = varResolver(vars || {}, { project: project || null });
  const isFirst = firstPage !== false;
  const at = (c, i, incr) => {
    const px = c.x + incr[0] * i, py = c.y + incr[1] * i;
    if (c.anchor === "lt") return [LT[0] + px, LT[1] + py];
    if (c.anchor === "lb") return [LT[0] + px, RB[1] - py];
    if (c.anchor === "rt") return [RB[0] - px, LT[1] + py];
    return [RB[0] - px, RB[1] - py];                            // rbcorner, the default
  };
  const out = [];
  for (const it of sheet.items) {
    if (it.option === "page1only" && !isFirst) continue;
    if (it.option === "notonpage1" && isFirst) continue;
    const isText = it.kind === "tbtext";
    // DS_DATA_ITEM::IsInsidePage: the framed area, grown to take in the run's own seed positions
    const s0 = at(it.start, 0, it.incr), e0 = at(it.end, 0, it.incr);
    let bx0 = Math.min(LT[0], s0[0]), by0 = Math.min(LT[1], s0[1]);
    let bx1 = Math.max(RB[0], s0[0]), by1 = Math.max(RB[1], s0[1]);
    if (!isText) { bx0 = Math.min(bx0, e0[0]); by0 = Math.min(by0, e0[1]); bx1 = Math.max(bx1, e0[0]); by1 = Math.max(by1, e0[1]); }
    const inside = (p) => p[0] >= bx0 - 1e-9 && p[0] <= bx1 + 1e-9 && p[1] >= by0 - 1e-9 && p[1] <= by1 + 1e-9;

    let full = null, multiline = false, escaped = false, size = 0, pen = 0;
    if (isText) {
      const expanded = expandTextVars(it.text, resolve);
      const r = replaceAntiSlash(expanded);
      full = r.text;
      escaped = r.multiline;                        // ReplaceAntiSlashSequence's own answer: it guards IncrementLabel
      // …but the layout keys on the newline itself.  DSNLEXER already turns a `\n` written in the
      // file into a real newline (common/dsnlexer.cpp:667), so a title-block field can arrive with
      // one without ReplaceAntiSlashSequence ever firing — and FONT::Draw splits on '\n' either way
      // (common/font/font.cpp:175-180), which is what actually puts the lines on the page.
      multiline = full.indexOf("\n") >= 0;
      size = it.sizeY || setup.textSizeY;
      const sizeX = it.sizeX || setup.textSizeX;
      pen = sheetTextPen(it.lineWidth || setup.textLineWidth, size, it.bold);
      // SetConstrainedTextSize (ds_data_item.cpp:674-714): shrink, never grow, to fit maxlen/maxheight
      if (it.maxlen > 0) { const w = textWidth(full, sizeX, pen); if (w > it.maxlen) size *= it.maxlen / w; }
      if (it.maxheight > 0 && size > it.maxheight) size = it.maxheight;
    }
    const lw = it.lineWidth || setup.lineWidth;
    let label = full;
    for (let j = 0; j < it.repeat; j++) {
      if (j > 0) {
        const sp = at(it.start, j, it.incr);
        if (!isText && !inside(at(it.end, j, it.incr))) continue;
        if (!inside(sp)) continue;
      }
      const [sx, sy] = at(it.start, j, it.incr);
      if (isText) {
        if (label) out.push({ t: "text", x: sx, y: sy, text: label, size, w: pen, bold: it.bold, italic: it.italic,
          h: it.hjust, v: it.vjust, rot: it.rot, color: it.color, multiline });
        if (it.repeat > 1 && !escaped) label = incrementLabel(it.text, (j + 1) * it.incrLabel);
      } else {
        const [ex, ey] = at(it.end, j, it.incr);
        if (it.kind === "line") out.push({ t: "line", x1: sx, y1: sy, x2: ex, y2: ey, w: lw });
        else out.push({ t: "rect", x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy), lw });
      }
    }
  }
  return out;
}

/**
 * The sheet for a parsed document — page size and text variables come off the doc.  render() calls
 * this every frame, so the result is cached per document and rebuilt only when something it depends
 * on changes (the page, the title block, the sheet identity or the description itself).
 */
const SHEET_CACHE = new WeakMap();
export function documentDrawingSheet(doc) {
  const wks = doc.drawingSheet || null;
  // Keyed on the document's own inputs rather than on the resolved variables, so the wall clock
  // (${CURRENT_TIME_*}, which the built-in sheet never shows) does not invalidate it every frame.
  const key = [doc.page[0], doc.page[1], doc.isFirstPage, doc.paper, doc.pageNumber, doc.sheetCount,
    doc.fileName, doc.filePath, doc.fileRoot, doc.sheetName, doc.sheetPath, doc.projectName, doc.kicadVersion].join("\u0000")
    + "\u0000" + JSON.stringify(doc.titleBlock || null) + "\u0000" + JSON.stringify(doc.sheetVars || null)
    + "\u0000" + JSON.stringify(doc.projectVars || null);
  const hit = SHEET_CACHE.get(doc);
  if (hit && hit.key === key && hit.wks === wks) return hit.items;
  const items = buildDrawingSheet(doc.page, sheetTextVars(doc), wks, doc.isFirstPage !== false, doc.projectVars || null);
  SHEET_CACHE.set(doc, { key, wks, items });
  return items;
}
