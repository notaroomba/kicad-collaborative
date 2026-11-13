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

const RETRY_MS = [4000, 15000, 60000, 180000];
let project: string | null = null;
const registered = new Map<string, FontFace>();   // face|b|i -> the FontFace on the page
const timers = new Set<number>();

function forget(): void {
  for (const f of registered.values()) { try { document.fonts.delete(f); } catch (e) { /* not there */ } }
  registered.clear();
  for (const t of timers) clearTimeout(t); timers.clear();
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
  if (!registered.has(key)) {
    try {
      const ff = new FontFace(face, await r.arrayBuffer(), { weight: b ? "700" : "400", style: i ? "italic" : "normal" });
      await ff.load();
      if (project !== pid) return;
      document.fonts.add(ff); registered.set(key, ff);
    } catch (e) { return; }   // not a font the browser can use
  }
  KiCadCanvas.fontChanged(face); requestRender();
}

export function initFonts(): void {
  KiCadCanvas.onFontWanted = (face, bold, italic) => { void load(face, bold, italic, 0); };
}
/** Called when a project opens or closes. */
export function fontsForProject(id: string | null): void { useProject(id); }
