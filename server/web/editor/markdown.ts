// markdown — ConvertMarkdown2Html (common/string_utils.cpp, which runs the markdown parser over KiCad's help text):
// the subset KiCad's help files use.  Headings, paragraphs, indented and fenced code blocks, pipe tables, bullet and
// numbered lists, inline code, bold, italic, links and the raw <br> / entities the files carry.
const escHtml = (s: string): string => s.replace(/&(?![a-z]+;|#\d+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Inline markup.  Raw <br> in the source stays a line break; other HTML is shown as text. */
export function mdInline(s: string): string {
  const parts = s.split(/(`[^`]*`)/);
  return parts.map((p) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return "<code>" + escHtml(p.slice(1, -1)) + "</code>";
    let t = escHtml(p).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, href: string) => `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">${txt}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>").replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:)]|$)/g, "$1<i>$2</i>");
    return t;
  }).join("");
}
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n"), out: string[] = [];
  let i = 0, para: string[] = [];
  const flush = (): void => { if (para.length) { out.push("<p>" + mdInline(para.join(" ")) + "</p>"); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const code: string[] = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push("<pre>" + escHtml(code.join("\n")) + "</pre>"); continue; }
    if (/^( {4}|\t)/.test(l) && !para.length) { const code: string[] = []; while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && /^( {4}|\t)/.test(lines[i + 1])))) code.push(lines[i++].replace(/^( {4}|\t)/, "")); out.push("<pre>" + escHtml(code.join("\n")) + "</pre>"); continue; }
    const hm = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hm) { flush(); out.push(`<h${hm[1].length}>${mdInline(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const head = cells(l); i += 2;
      const rows: string[][] = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push("<table><tr>" + head.map((c) => "<th align=left>" + mdInline(c) + "</th>").join("") + "</tr>" + rows.map((r) => "<tr>" + r.map((c) => "<td valign=top>" + mdInline(c) + "</td>").join("") + "</tr>").join("") + "</table>");
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      flush(); const ordered = /^\s*\d+\./.test(l); const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { let item = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""); while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) item += " " + lines[i++].trim(); items.push("<li>" + mdInline(item) + "</li>"); }
      out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>")); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    if (/^<br\s*\/?>\s*$/i.test(l.trim())) { flush(); out.push("<br>"); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join("\n");
}
