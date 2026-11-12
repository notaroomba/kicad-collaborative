// web/fab/pdf — PDF_PLOTTER (common/plotters/PDF_plotter.cpp): a vector PDF, one page per PlotPage, in
// points (Y up).  The document info carries the title, author and subject (pdf_metadata), Creator
// "PCBNEW-PDF" / "Eeschema-PDF" and Producer "KiCad PDF"; bookmarks become the outline (PageMode
// UseOutlines), links become /Link annotations (a URI, a page of the document, or a popup menu run by the
// document-level ShM() script KiCad embeds).  Content streams are written uncompressed.
import { type PlotDocument, rgbOf } from "./plotter";

const PT = 72 / 25.4;
const num = (v: number): string => { const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; };
/** encodeStringForPlotter: a literal string, ASCII with \\, ( and ) escaped; anything else as a UTF-16BE hex string. */
export function pdfString(s: string): string {
  if (/^[\x20-\x7e\n\r\t]*$/.test(s)) return "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + ")";
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return "<" + hex + ">";
}
const pdfDate = (d: Date): string => { const p = (n: number): string => String(n).padStart(2, "0"); return `D:${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())}:${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

const SHM_JS = `
function ShM(aEntries) {
    var aParams = [];
    for (var i = 0; i < aEntries.length; ++i) {
        aParams.push({
            cName: aEntries[i][0],
            cReturn: aEntries[i].length > 1 ? aEntries[i][1] : ''
        })
    }

    var cChoice = app.popUpMenuEx.apply(app, aParams);
    if (cChoice == null || cChoice == '') return;

    if (cChoice.substring(0, 1) == '#') {
        this.pageNum = parseInt(cChoice.slice(1));
        return;
    }

    // Fallback: some viewers return cName instead of cReturn
    var url = cChoice;
    if (url.substring(0, 4) != 'http' && url.substring(0, 4) != 'file') {
        var idx = url.indexOf('http');
        if (idx < 0) idx = url.indexOf('file:');
        if (idx >= 0) url = url.substring(idx);
        else return;
    }

    if (url.substring(0, 8) == 'file:///') app.openDoc(url.substring(7));
    else if (url.substring(0, 7) == 'file://') app.openDoc('//' + url.substring(7));
    else app.launchURL(url);
}
`;
const jsStr = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function writePdf(doc: PlotDocument): Uint8Array {
  const enc = new TextEncoder();
  const objs: string[] = [];                       // index = object number - 1
  const alloc = (): number => { objs.push(""); return objs.length; };
  const set = (n: number, body: string): void => { objs[n - 1] = body; };
  const catalog = alloc(), pagesN = alloc(), info = alloc(), names = alloc();
  const pageNs: number[] = [];
  const outlineEntries: { group: string; title: string; page: number }[] = [];
  const annotsAll: number[][] = [];
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi]; const H = page.h;
    const X = (x: number): string => num(x * PT), Y = (y: number): string => num((H - y) * PT);
    const c: string[] = [];
    const gs = new Map<string, string>();
    const alphaGs = (a: number | undefined, stroke: boolean): string => {
      if (a === undefined || a >= 1) return "";
      const key = (stroke ? "S" : "F") + a.toFixed(3); let name = gs.get(key);
      if (!name) { name = "GS" + gs.size; gs.set(key, name); }
      return `/${name} gs\n`;
    };
    c.push("1 J 1 j");
    if (page.background) { const [r, g, b] = rgbOf(page.background); c.push(`${num(r / 255)} ${num(g / 255)} ${num(b / 255)} rg`, `0 0 ${num(page.w * PT)} ${num(page.h * PT)} re f`); }
    for (const it of page.items) {
      const [r, g, b] = rgbOf(it.color); const col = `${num(r / 255)} ${num(g / 255)} ${num(b / 255)}`;
      const a = it.alpha;
      const wrap = a !== undefined && a < 1;
      if (wrap) c.push("q");
      if (it.k === "line") {
        if (it.pts.length < 2) { if (wrap) c.push("Q"); continue; }
        c.push(alphaGs(a, true) + `${col} RG ${num(it.w * PT)} w` + (it.cap === "butt" ? " 0 J" : it.cap === "square" ? " 2 J" : ""));
        let d = `${X(it.pts[0][0])} ${Y(it.pts[0][1])} m`;
        for (let i = 1; i < it.pts.length; i++) d += `\n${X(it.pts[i][0])} ${Y(it.pts[i][1])} l`;
        c.push(d + (it.closed ? " h S" : " S"));
        if (it.cap === "butt" || it.cap === "square") c.push("1 J");
      } else if (it.k === "fill") {
        c.push(alphaGs(a, false) + `${col} rg`);
        let d = "";
        for (const poly of it.polys) { if (poly.length < 3) continue; d += `${X(poly[0][0])} ${Y(poly[0][1])} m\n`; for (let i = 1; i < poly.length; i++) d += `${X(poly[i][0])} ${Y(poly[i][1])} l\n`; d += "h\n"; }
        if (d) c.push(d + (it.evenOdd ? "f*" : "f"));
      } else {
        // four Bézier quarters (PDF_PLOTTER::Circle)
        const k = 0.5522847498 * it.r, x = it.x, y = it.y, rr = it.r;
        const curve = `${X(x - rr)} ${Y(y)} m\n${X(x - rr)} ${Y(y - k)} ${X(x - k)} ${Y(y - rr)} ${X(x)} ${Y(y - rr)} c\n${X(x + k)} ${Y(y - rr)} ${X(x + rr)} ${Y(y - k)} ${X(x + rr)} ${Y(y)} c\n${X(x + rr)} ${Y(y + k)} ${X(x + k)} ${Y(y + rr)} ${X(x)} ${Y(y + rr)} c\n${X(x - k)} ${Y(y + rr)} ${X(x - rr)} ${Y(y + k)} ${X(x - rr)} ${Y(y)} c`;
        if (it.fill) c.push(alphaGs(a, false) + `${col} rg`, curve + " f");
        else c.push(alphaGs(a, true) + `${col} RG ${num(it.w * PT)} w`, curve + " S");
      }
      if (wrap) c.push("Q");
    }
    const content = c.join("\n") + "\n";
    const contentN = alloc(); set(contentN, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);
    const pageN = alloc(); pageNs.push(pageN);
    const annots: number[] = []; annotsAll.push(annots);
    for (const ln of page.links || []) {
      const rect = `[${X(ln.box[0])} ${Y(ln.box[3])} ${X(ln.box[2])} ${Y(ln.box[1])}]`;
      const n = alloc(); annots.push(n);
      if (ln.menu && ln.menu.length) {
        const js = "ShM([\n" + ln.menu.map(([label, target]) => (target ? `["${jsStr(label)}", "${jsStr(target)}"],\n` : `["${jsStr(label)}"],\n`)).join("") + "]);";
        set(n, `<<\n/Type /Annot\n/Subtype /Link\n/Rect ${rect}\n/Border [16 16 0]\n/A << /Type /Action /S /JavaScript /JS ${pdfString(js)} >>\n>>`);
      } else if (ln.url && /^#\d+$/.test(ln.url)) {
        set(n, `<<\n/Type /Annot\n/Subtype /Link\n/Rect ${rect}\n/Border [16 16 0]\n/Dest [@PAGE${+ln.url.slice(1) - 1}@ /FitB]\n>>`);
      } else {
        set(n, `<<\n/Type /Annot\n/Subtype /Link\n/Rect ${rect}\n/Border [16 16 0]\n/A << /Type /Action /S /URI /URI ${pdfString(ln.url || "")} >>\n>>`);
      }
    }
    const gsDict = gs.size ? ` /ExtGState << ${[...gs].map(([k, name]) => `/${name} << /${k[0] === "S" ? "CA" : "ca"} ${k.slice(1)} >>`).join(" ")} >>` : "";
    set(pageN, `<<\n/Type /Page\n/Parent ${pagesN} 0 R\n/Resources << /ProcSet [/PDF /Text]${gsDict} >>\n/MediaBox [0 0 ${num(page.w * PT)} ${num(page.h * PT)}]\n/Contents ${contentN} 0 R\n${annots.length ? `/Annots [${annots.map((a) => a + " 0 R").join(" ")}]\n` : ""}>>`);
    for (const b of page.bookmarks || []) outlineEntries.push({ group: b.group, title: b.title, page: pi });
  }
  // page destinations of the internal links
  for (let i = 0; i < objs.length; i++) objs[i] = objs[i].replace(/@PAGE(\d+)@/g, (_m, p) => `${pageNs[Math.min(+p, pageNs.length - 1)] || pageNs[0]} 0 R`);
  set(pagesN, `<<\n/Type /Pages\n/Kids [\n${pageNs.map((n) => n + " 0 R").join("\n")}\n]\n/Count ${pageNs.length}\n>>`);
  let title = doc.title || ""; if (!title) title = (doc.fileName || "").split(/[\\/]/).pop() || "";
  set(info, `<<\n/Producer (KiCad PDF)\n/CreationDate (${pdfDate(doc.date || new Date())})\n/Creator ${pdfString(doc.creator + "-PDF")}\n/Title ${pdfString(title)}\n/Author ${pdfString(doc.author || "")}\n/Subject ${pdfString(doc.subject || "")}\n>>`);
  set(names, `<< /JavaScript\n << /Names\n    [ (JSInit) << /Type /Action /S /JavaScript /JS ${pdfString(SHM_JS)} >> ]\n >>\n>>`);
  // the outline: one entry per group, its bookmarks under it
  let outlines = 0;
  if (outlineEntries.length) {
    outlines = alloc();
    const groups = new Map<string, { page: number; title: string }[]>();
    for (const e of outlineEntries) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group)!.push(e); }
    const groupNs: number[] = [];
    for (const [g, list] of groups) {
      const gn = alloc(); groupNs.push(gn);
      const kidsN = list.map(() => alloc());
      list.forEach((e, i) => set(kidsN[i], `<<\n/Title ${pdfString(e.title)}\n/Parent ${gn} 0 R\n/Dest [${pageNs[e.page]} 0 R /FitB]\n${i > 0 ? `/Prev ${kidsN[i - 1]} 0 R\n` : ""}${i < kidsN.length - 1 ? `/Next ${kidsN[i + 1]} 0 R\n` : ""}>>`));
      set(gn, `<<\n/Title ${pdfString(g)}\n/Parent ${outlines} 0 R\n/Count -${list.length}\n/First ${kidsN[0]} 0 R\n/Last ${kidsN[kidsN.length - 1]} 0 R\n@PREVNEXT${gn}@>>`);
    }
    for (let i = 0; i < groupNs.length; i++) {
      const pn = (i > 0 ? `/Prev ${groupNs[i - 1]} 0 R\n` : "") + (i < groupNs.length - 1 ? `/Next ${groupNs[i + 1]} 0 R\n` : "");
      objs[groupNs[i] - 1] = objs[groupNs[i] - 1].replace(`@PREVNEXT${groupNs[i]}@`, pn);
    }
    set(outlines, `<<\n/Type /Outlines\n/Count ${groupNs.length}\n/First ${groupNs[0]} 0 R\n/Last ${groupNs[groupNs.length - 1]} 0 R\n>>`);
  }
  set(catalog, outlines
    ? `<<\n/Type /Catalog\n/Pages ${pagesN} 0 R\n/Version /1.5\n/PageMode /UseOutlines\n/Outlines ${outlines} 0 R\n/Names ${names} 0 R\n/PageLayout /SinglePage\n>>`
    : `<<\n/Type /Catalog\n/Pages ${pagesN} 0 R\n/Version /1.5\n/PageMode /UseNone\n/Names ${names} 0 R\n/PageLayout /SinglePage\n>>`);
  // serialise with the cross-reference table
  const parts: Uint8Array[] = []; let len = 0; const offsets: number[] = [];
  const push = (s: string | Uint8Array): void => { const b = typeof s === "string" ? enc.encode(s) : s; parts.push(b); len += b.length; };
  push("%PDF-1.5\n"); push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  objs.forEach((body, i) => { offsets[i] = len; push(`${i + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = len;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
