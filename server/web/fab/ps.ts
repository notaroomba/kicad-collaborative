// web/fab/ps — PS_PLOTTER (common/plotters/PS_plotter.cpp): DSC-conforming PostScript, one %%Page per
// PlotPage, in points with the origin at the bottom left.  The prolog defines KiCad's short procedures
// (line, poly, circle …); "Negative plot" is drawn by the caller (a black field with the layer in white),
// the X / Y fine scale adjust is applied here (SetScaleAdjust).
import { type PlotDocument, rgbOf } from "./plotter";

const PT = 72 / 25.4;
const n = (v: number): string => { const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; };

const PROLOG = [
  "%%BeginProlog",
  "/line { newpath moveto lineto stroke } bind def",
  "/cir0 { newpath 0 360 arc stroke } bind def",
  "/cir1 { newpath 0 360 arc gsave fill grestore stroke } bind def",
  "/cir2 { newpath 0 360 arc gsave fill grestore stroke } bind def",
  "/arc0 { newpath arc stroke } bind def",
  "/arc1 { newpath 4 index 4 index moveto arc closepath gsave fill",
  "    grestore stroke } bind def",
  "/arc2 { newpath 4 index 4 index moveto arc closepath gsave fill",
  "    grestore stroke } bind def",
  "/poly0 { stroke } bind def",
  "/poly1 { closepath gsave fill grestore stroke } bind def",
  "/poly2 { closepath gsave fill grestore stroke } bind def",
  "/rect0 { rectstroke } bind def",
  "/rect1 { rectfill } bind def",
  "/rect2 { rectfill } bind def",
  "/linemode0 { 0 setlinecap 0 setlinejoin 0 setlinewidth } bind def",
  "/linemode1 { 1 setlinecap 1 setlinejoin } bind def",
  "/dashedline { [200] 100 setdash } bind def",
  "/solidline { [] 0 setdash } bind def",
  "/phantomshow { moveto",
  "    /KicadFont findfont exch scalefont setfont show } bind def",
  "/textshow { gsave",
  "    findfont exch scalefont setfont concat 1 scalefont show",
  "    grestore } bind def",
  "/reencodefont {",
  "     findfont dup length dict begin",
  "     { 1 index /FID ne",
  "       { def }",
  "       { pop pop } ifelse",
  "     } forall",
  "     /Encoding ISOLatin1Encoding def",
  "     currentdict",
  "     end } bind def",
  "/KicadFont /Helvetica reencodefont definefont pop",
  "/KicadFont-Bold /Helvetica-Bold reencodefont definefont pop",
  "/KicadFont-Oblique /Helvetica-Oblique reencodefont definefont pop",
  "/KicadFont-BoldOblique /Helvetica-BoldOblique reencodefont definefont pop",
  "%%EndProlog",
];

export interface PsOptions { scaleX?: number; scaleY?: number; fileName?: string; date?: Date }

export function writePs(doc: PlotDocument, o: PsOptions = {}): string {
  const sx = o.scaleX || 1, sy = o.scaleY || 1;
  const first = doc.pages[0] || { w: 297, h: 210 };
  const out: string[] = [];
  const wPt = Math.round(first.w * PT), hPt = Math.round(first.h * PT);
  const landscape = first.w > first.h;
  out.push("%!PS-Adobe-3.0", `%%Creator: ${doc.creator}`, `%%CreationDate: ${(o.date || doc.date || new Date()).toString()}`, `%%Title: ${o.fileName || doc.title || "plot"}`,
    `%%BoundingBox: 0 0 ${landscape ? hPt : wPt} ${landscape ? wPt : hPt}`, `%%DocumentMedia: Custom ${landscape ? hPt : wPt} ${landscape ? wPt : hPt} 0 () ()`,
    `%%Orientation: ${landscape ? "Landscape" : "Portrait"}`, `%%Pages: ${doc.pages.length}`, "%%PageOrder: Ascend", "%%EndComments");
  out.push(...PROLOG);
  doc.pages.forEach((page, i) => {
    const X = (x: number): string => n(x * PT * sx), Y = (y: number): string => n((page.h - y) * PT * sy);
    out.push(`%%Page: ${i + 1} ${i + 1}`, "%%BeginPageSetup", "gsave");
    if (page.w > page.h) out.push(`${Math.round(page.h * PT)} 0 translate 90 rotate`);
    out.push("linemode1", "%%EndPageSetup");
    if (page.background) { const [r, g, b] = rgbOf(page.background); out.push(`${n(r / 255)} ${n(g / 255)} ${n(b / 255)} setrgbcolor`, `0 0 ${n(page.w * PT)} ${n(page.h * PT)} rect2`); }
    for (const it of page.items) {
      const [r, g, b] = rgbOf(it.color);
      out.push(`${n(r / 255)} ${n(g / 255)} ${n(b / 255)} setrgbcolor`);
      if (it.k === "line") {
        if (it.pts.length < 2) continue;
        out.push(`${n(it.w * PT)} setlinewidth`);
        if (it.pts.length === 2) { out.push(`${X(it.pts[1][0])} ${Y(it.pts[1][1])} ${X(it.pts[0][0])} ${Y(it.pts[0][1])} line`); continue; }
        out.push(`newpath`, `${X(it.pts[0][0])} ${Y(it.pts[0][1])} moveto`);
        for (let k = 1; k < it.pts.length; k++) out.push(`${X(it.pts[k][0])} ${Y(it.pts[k][1])} lineto`);
        out.push(it.closed ? "closepath stroke" : "poly0");
      } else if (it.k === "fill") {
        out.push("0 setlinewidth", "newpath");
        for (const poly of it.polys) { if (poly.length < 3) continue; out.push(`${X(poly[0][0])} ${Y(poly[0][1])} moveto`); for (let k = 1; k < poly.length; k++) out.push(`${X(poly[k][0])} ${Y(poly[k][1])} lineto`); out.push("closepath"); }
        out.push(it.evenOdd ? "eofill" : "fill");
      } else {
        out.push(`${n(it.fill ? 0 : it.w * PT)} setlinewidth`, `${X(it.x)} ${Y(it.y)} ${n(it.r * PT * sx)} ${it.fill ? "cir1" : "cir0"}`);
      }
    }
    out.push("showpage", "grestore", "%%PageTrailer");
  });
  out.push("%%Trailer", "%%EOF", "");
  return out.join("\n");
}
