// dialogs/annotate-logic.ts — the Annotate dialog's sheet walk (Recurse into subsheets), kept free of the editor.

/** The sheet files a sheet's (sheet …) items name (Sheetfile), as project paths next to the sheet that holds them. */
export function subsheetFiles(doc: KDoc, dir: string, only?: Set<string> | null): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet" || (only && !only.has(it.id))) continue;
    const p = (it.node as SNode[]).find((c) => Array.isArray(c) && c[0] === "property" && (c[1] === "Sheetfile" || c[1] === "Sheet file"));
    const f = p ? String(p[2]) : ""; if (!f) continue;
    const parts = (dir ? dir + "/" + f : f).split("/"), norm: string[] = [];
    for (const x of parts) { if (x === "..") norm.pop(); else if (x && x !== ".") norm.push(x); }
    out.push(norm.join("/"));
  }
  return out;
}
