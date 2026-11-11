// markdown.tsx — the small subset of Markdown the assistant writes, rendered as React elements
// (never as HTML strings, so nothing in a reply or a fetched page can inject markup): paragraphs,
// headings, bullet and numbered lists, fenced code, tables, and inline code / bold / italic / links.
import type { ReactNode } from "react";

const INLINE_SRC = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(\*[^*\s][^*\n]*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.source;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0, n = 0;
  const re = new RegExp(INLINE_SRC, "g");   // one per call: bold and italic recurse, and a shared lastIndex would be clobbered
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`; const s = m[0];
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(s.slice(2, -2), k)}</strong>);
    else if (m[3]) { const cut = s.indexOf("]("); out.push(<a key={k} href={s.slice(cut + 2, -1)} target="_blank" rel="noopener noreferrer">{s.slice(1, cut)}</a>); }
    else if (m[4]) out.push(<em key={k}>{inline(s.slice(1, -1), k)}</em>);
    else out.push(<a key={k} href={s} target="_blank" rel="noopener noreferrer">{s}</a>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n"); const out: ReactNode[] = []; let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i]; const k = `b${key++}`;
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; out.push(<pre key={k}><code>{body.join("\n")}</code></pre>); continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const Tag = (h[1].length <= 2 ? "h3" : "h4") as "h3" | "h4"; out.push(<Tag key={k}>{inline(h[2], k)}</Tag>); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line); const rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div className="ai-table" key={k}><table>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] || "", `${k}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
        </table></div>);
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]); const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m && m[1].length <= li[1].length + 1 && /\d/.test(m[2]) === ordered) { items.push({ text: m[3], sub: [] }); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].sub.push(lines[i].replace(/^\s{2,4}/, "")); i++; }   // continuation or nested list
        else break;
      }
      const body = items.map((it, j) => <li key={j}>{inline(it.text, `${k}i${j}`)}{it.sub.length ? <Markdown text={it.sub.join("\n")} /> : null}</li>);
      out.push(ordered ? <ol key={k}>{body}</ol> : <ul key={k}>{body}</ul>); continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={k}><Markdown text={body.join("\n")} /></blockquote>); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !LIST.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);   // nothing above claimed the line: it is text
    out.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return <>{out}</>;
}
