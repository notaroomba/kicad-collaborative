// The outline fonts a document's text is set in, as the canvas built it: [face, bold, italic] once each.
// Shared by the editor (web/editor/fonts.ts) and the headless editor (web/mcp/host.ts), which both fetch the
// files before a plot or a zone fill draws the text's outlines.
export function textFaces(docIn: unknown): [string, boolean, boolean][] {
  const doc = docIn as { items?: Map<string, { geom?: unknown[]; hiddenGeom?: unknown[] }> } | null;
  const want = new Map<string, [string, boolean, boolean]>();
  if (!doc || !doc.items) return [];
  const note = (list: unknown[] | undefined): void => {
    for (const g of (list || []) as { t?: string; face?: string; bold?: boolean; italic?: boolean }[]) {
      if (!g || g.t !== "text" || !g.face || /^kicad font$/i.test(g.face)) continue;
      want.set(`${g.face}|${g.bold ? "b" : ""}|${g.italic ? "i" : ""}`, [g.face, !!g.bold, !!g.italic]);
    }
  };
  for (const it of doc.items.values()) { note(it.geom); note(it.hiddenGeom); }
  return [...want.values()];
}
