// canvas/prettify.ts — KICAD_FORMAT::Prettify (common/io/kicad/kicad_io_utils.cpp:117), the pass every KiCad
// writer runs over its compact s-expression output: one tab of indent per list level, a list that holds lists
// opens a line per child, runs of (xy …) stay on one line up to column 99, and a list of bare tokens wraps once it
// passes column 72.  The footprint editor writes a .kicad_mod through this, so a file the web saves reads exactly
// like one pcbnew saved.

/** FORMAT_MODE: NORMAL (boards, footprints), COMPACT_TEXT_PROPERTIES (font / stroke / fill on one line), LIBRARY_TABLE. */
export type PrettifyMode = "normal" | "compactText" | "libraryTable";

export function prettify(source: string, mode: PrettifyMode = "normal"): string {
  const quoteChar = '"', indentChar = "\t", indentSize = 1;
  const xySpecialCaseColumnLimit = 99, consecutiveTokenWrapThreshold = 72;
  const textSpecialCase = mode === "compactText", libSpecialCase = mode === "libraryTable";
  const src = source, n = src.length;
  let out = "";
  let listDepth = 0, libDepth = 0, lastNonWhitespace = "", inQuote = false, hasInsertedSpace = false, inMultiLineList = false;
  let inXY = false, inShortForm = false, inLibRow = false, shortFormDepth = 0, column = 0, backslashCount = 0;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const nextNonWhitespace = (i: number): string => { while (i < n && isWs(src[i])) i++; return i < n ? src[i] : ""; };
  const isXY = (i: number): boolean => src[i + 1] === "x" && src[i + 2] === "y" && src[i + 3] === " ";
  const tokenAfter = (i: number): string => { let t = ""; let j = i + 1; while (j < n && /[A-Za-z]/.test(src[j])) t += src[j++]; return t; };
  const isShortForm = (i: number): boolean => { const t = tokenAfter(i); return t === "font" || t === "stroke" || t === "fill" || t === "teardrop" || t === "offset" || t === "rotate" || t === "scale"; };
  const isLib = (i: number): boolean => tokenAfter(i) === "lib";
  const indent = (d: number) => indentChar.repeat(d * indentSize);
  let i = 0;
  while (i < n) {
    const c = src[i];
    // a comment line is not s-expression syntax and keeps its spacing, quotes and parens
    if (listDepth === 0 && c === "#" && (out === "" || out[out.length - 1] === "\n")) {
      const e = src.indexOf("\n", i); const end = e < 0 ? n : e;
      out += src.slice(i, end) + "\n";
      if (e < 0) break;
      i = e + 1; continue;
    }
    const next = nextNonWhitespace(i);
    if (isWs(c) && !inQuote) {
      if (!hasInsertedSpace && listDepth > 0 && lastNonWhitespace !== "(" && next !== ")" && next !== "(") {
        if (inXY || column < consecutiveTokenWrapThreshold) { out += " "; column++; }
        else if (inShortForm || inLibRow) out += " ";
        else { out += "\n" + indent(listDepth); column = listDepth * indentSize; inMultiLineList = true; }
        hasInsertedSpace = true;
      }
    } else {
      hasInsertedSpace = false;
      if (c === "(" && !inQuote) {
        const currentIsXY = isXY(i), currentIsShortForm = textSpecialCase && isShortForm(i), currentIsLib = libSpecialCase && isLib(i);
        if (out === "" || out[out.length - 1] === "\n") { out += "("; column++; }
        else if (inXY && currentIsXY && column < xySpecialCaseColumnLimit) { out += " ("; column += 2; }
        else if (inShortForm || inLibRow) { out += " ("; column += 2; }
        else { out += "\n" + indent(listDepth) + "("; column = listDepth * indentSize + 1; }
        inXY = currentIsXY;
        if (currentIsShortForm) { inShortForm = true; shortFormDepth = listDepth; }
        else if (currentIsLib) { inLibRow = true; libDepth = listDepth; }
        listDepth++;
      } else if (c === ")" && !inQuote) {
        if (listDepth > 0) listDepth--;
        if (inShortForm) { out += ")"; column++; }
        else if (inLibRow && listDepth === libDepth) { out += ")"; inLibRow = false; }
        else if (lastNonWhitespace === ")" || inMultiLineList) { out += "\n" + indent(listDepth) + ")"; column = listDepth * indentSize + 1; inMultiLineList = false; }
        else { out += ")"; column++; }
        if (shortFormDepth === listDepth) { inShortForm = false; shortFormDepth = 0; }
      } else {
        // the output formatter escapes double quotes (\"), but \\" is a backslash and then the closing quote
        if (c === "\\") backslashCount++;
        else if (c === quoteChar && (backslashCount & 1) === 0) inQuote = !inQuote;
        if (c !== "\\") backslashCount = 0;
        out += c; column++;
      }
      lastNonWhitespace = c;
    }
    i++;
  }
  return out + "\n";   // newline at end of file: POSIX, and clean git diffs
}
