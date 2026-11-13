// editor/fonts.ts — the outline fonts a design's text is set in, loaded from the server.
//
// The canvas asks (KiCadCanvas.onFontWanted) for a face the first time it has to draw text in it.  The file comes
// from the project (GET /api/projects/{id}/fonts/file): a font somebody uploaded from their computer, or a Google
// Font the server fetched.  Once it is registered with the page the canvas is told (fontChanged) and repaints, so
// text that was drawn in the stroke font a moment ago is redrawn in its own font, for everybody alike.
//
// A face the server does not have yet is asked for again a few times: the desktop app that set the text may still
// be uploading the file.

import { state } from "./appstore";
import { requestRender } from "./view";
import { setFontProject } from "../dialogs/font-picker";
import { textFaces } from "../fonts-used";

const RETRY_MS = [4000, 15000, 60000, 180000];
let project: string | null = null;
const registered = new Map<string, FontFace>();   // face|b|i -> the FontFace on the page
const timers = new Set<number>();

function forget(): void {
  for (const f of registered.values()) { try { document.fonts.delete(f); } catch (e) { /* not there */ } }
  registered.clear();
  for (const t of timers) clearTimeout(t); timers.clear(); owed.clear();
  KiCadCanvas.fontChanged();
}

/** The project whose fonts are in force; another project's uploaded fonts must not linger under the same names. */
function useProject(id: string | null): void {
  if (id === project) return;
  project = id; setFontProject(id);
  if (typeof document !== "undefined" && document.fonts) forget();
}

async function load(face: string, bold: boolean, italic: boolean, attempt: number): Promise<void> {
  const pid = state.project ? state.project.projectId : null;
  useProject(pid);
  if (!pid || typeof FontFace === "undefined") { KiCadCanvas.fontChanged(face); return; }   // nothing to ask yet: let the canvas ask again
  const again = (): void => {
    if (attempt >= RETRY_MS.length) return;
    const t = window.setTimeout(() => { timers.delete(t); if (project === pid) void load(face, bold, italic, attempt + 1); }, RETRY_MS[attempt]); timers.add(t);
  };
  let r: Response;
  try { r = await fetch(`/api/projects/${pid}/fonts/file?family=${encodeURIComponent(face)}&bold=${bold ? 1 : 0}&italic=${italic ? 1 : 0}`, { credentials: "same-origin" }); }
  catch (e) { again(); return; }
  if (project !== pid) return;
  if (!r.ok) { again(); return; }
  // the style the file really is: a family without a bold or an italic answers with what it has, and the browser
  // then thickens or slants it, as KiCad does
  const b = r.headers.get("x-font-bold") === "1", i = r.headers.get("x-font-italic") === "1";
  const key = `${face}|${b ? "b" : ""}|${i ? "i" : ""}`;
  let bytes: ArrayBuffer; try { bytes = await r.arrayBuffer(); } catch (e) { again(); return; }
  if (project !== pid) return;
  // the file itself is kept too: a plot draws the text's outlines from it (web/fab/outline-font.ts)
  KiCadCanvas.setFontData(face, bold, italic, { data: bytes, bold: b, italic: i });
  { const d = host ? host.doc() as { type?: string } | null : null; if (d && d.type === "pcb") loadWriters().catch(() => undefined); }
  if (!registered.has(key)) {
    try {
      const ff = new FontFace(face, bytes.slice(0), { weight: b ? "700" : "400", style: i ? "italic" : "normal" });
      await ff.load();
      if (project !== pid) return;
      document.fonts.add(ff); registered.set(key, ff);
    } catch (e) { return; }   // not a font the browser can use
  }
  KiCadCanvas.fontChanged(face); requestRender();
  void storeOutlines();
}

// ---------------------------------------------------------------- outlines stored with board text
//
// pcbnew stores the outlines of a text set in an outline font in the board, so that a KiCad without the font
// still draws and plots it.  The canvas writes them whenever it writes such a text (canvas/export.ts), once the
// plot writers are loaded and the font file is here.  A text set in a font a moment before its file arrived went
// out without them: those are sent again, with their outlines, when the file is in.

interface Change { id: string; kind: string; typeName?: string; sexpr?: string }
let host: { doc(): unknown; send(changes: Change[]): void } | null = null;
const owed = new Map<string, string>();   // item id -> the type name its change carried
const count = (s: string, what: string): number => s.split(what).length - 1;
const short = (sexpr: string): boolean => count(sexpr, '(face "') > count(sexpr, "(render_cache ");

let writers: Promise<void> | null = null;
/** The plot writers hold the glyph reader; they are fetched the first time a board has text in a font. */
function loadWriters(): Promise<void> {
  const W = window as unknown as { KiCadFab?: { buildPackage?: unknown } };
  if (W.KiCadFab && typeof W.KiCadFab.buildPackage === "function") return Promise.resolve();
  if (writers) return writers;
  writers = new Promise<void>((resolve, reject) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
    const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const s = document.createElement("script"); s.src = "/static/dist/fab.js" + (query ? "?" + query : "");
    s.onload = () => resolve(); s.onerror = () => reject(new Error("could not load fab.js"));
    document.head.appendChild(s);
  });
  writers.catch(() => { writers = null; });
  return writers;
}

/** After an edit of this editor: remember the board texts that went out in a font but without outlines. */
export function fontCommitObserver(phase: "before" | "after", changes: unknown[]): void {
  if (phase !== "after" || !host) return;
  const doc = host.doc() as { type?: string } | null; if (!doc || doc.type !== "pcb") return;
  for (const c of changes as Change[]) {
    if (c.kind === "REMOVED") { owed.delete(c.id); continue; }
    if (typeof c.sexpr === "string" && short(c.sexpr)) owed.set(c.id, c.typeName || "");
  }
  if (owed.size) void storeOutlines();
}

async function storeOutlines(): Promise<void> {
  if (!host) return;
  const doc = host.doc() as { type?: string; items?: Map<string, { kind: string; node: unknown }> } | null;
  if (!doc || doc.type !== "pcb" || !doc.items) return;
  try { await loadWriters(); } catch (e) { return; }
  if (!owed.size || host.doc() !== doc) return;
  const out: Change[] = [];
  for (const [id, typeName] of [...owed]) {
    const it = doc.items.get(id); if (!it) { owed.delete(id); continue; }
    const sexpr = KiCadCanvas.serializeItem(doc as never, it as never);
    if (short(sexpr)) continue;   // its font is not here yet: asked for again when the next file arrives
    owed.delete(id); out.push({ id, kind: "MODIFIED", typeName, sexpr });
  }
  // the items already stand as written here (the outlines were added to them): only the others need to hear
  if (out.length) host.send(out);
}

/**
 * Before a plot: the font files of every text in the document, so that text on a layer that was never drawn
 * (hidden, or off screen since the board opened) is plotted in its own font as well.  One attempt each; a font
 * the project does not have is reported by the plot itself.
 */
export async function fontsForPlot(doc: unknown): Promise<void> {
  const want = textFaces(doc).filter(([face, bold, italic]) => !KiCadCanvas.fontData(face, bold, italic));
  await Promise.all(want.map(([face, bold, italic]) => load(face, bold, italic, RETRY_MS.length).catch(() => undefined)));
}

export function initFonts(h?: { doc(): unknown; send(changes: Change[]): void }): void {
  host = h || null;
  KiCadCanvas.onFontWanted = (face, bold, italic) => { void load(face, bold, italic, 0); };
  KiCadCanvas.loadFontsFor = fontsForPlot;
}
/** Called when a project opens or closes. */
export function fontsForProject(id: string | null): void { useProject(id); }
