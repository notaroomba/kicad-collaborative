/**
 * Project thumbnails from the browser editor.
 *
 * The server draws nothing itself, and the file it stores for a document is only as new as the last
 * snapshot a desktop editor uploaded: a project made and edited here (a blank project, an AI-built
 * board) stays at its empty first file there, so its card on the projects page had nothing to show.
 * This editor has the document as it really is, so it sends a small picture of it to the same place
 * the desktop sends its plot (POST /api/docs/{id}/preview): shortly after the document opens and,
 * debounced, after it changes.  Only the board and the root schematic sheet are sent, and only by
 * someone who may edit (the server refuses anyone else).
 */
import { state } from "./appstore";
import { E } from "./state";
import { historyActive } from "./versions";

const LONG_SIDE = 960;        // px on the long side: sharp on a 2x card and on the project page
const QUIET_MS = 5000;        // wait this long after the last change
const MIN_GAP_MS = 20000;     // and never send more often than this
let timer = 0, lastSent = 0, sending = false, again = false;
const sentAt = new Map<string, string>();   // docId -> "seq/version" already sent

interface PreviewCanvas { renderPng(doc: unknown, opts: Record<string, unknown>): Promise<Blob> }

function wanted(): boolean {
  if (!E.kdoc || !state.docId || state.role !== "editor" || historyActive()) return false;
  const docs = state.docs || [];
  const me = docs.find((d) => d.docId === state.docId);
  if (!me) return false;
  if (me.docType === "kicad_pcb") return true;
  if (me.docType !== "kicad_sch") return false;
  const root = (window as unknown as { CollabApp?: { getState(): { document: { rootDocId: string | null } } } }).CollabApp?.getState().document.rootDocId;
  return !root || root === state.docId;
}

const toBase64 = (blob: Blob): Promise<string> => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function send(): Promise<void> {
  if (sending) { again = true; return; }
  if (!wanted()) return;
  const doc = E.kdoc!, docId = state.docId!, seq = E.lastSeq || 0;
  const isPcb = doc.type === "pcb";
  const box = isPcb ? doc.bbox : [0, 0, doc.page[0], doc.page[1]];
  // an empty board has no extent: nothing to show, and the root sheet's picture stands in for it
  if (!box || !(box[2] - box[0] > 0.5) || !(box[3] - box[1] > 0.5)) return;
  if (!doc.items || doc.items.size === 0) return;
  const key = `${seq}/${doc.version}`;
  if (sentAt.get(docId) === key) return;
  sending = true;
  try {
    const K = KiCadCanvas as unknown as PreviewCanvas;
    const w = box[2] - box[0], h = box[3] - box[1], long = Math.max(w, h);
    const png = await K.renderPng(doc, { dpi: (LONG_SIDE / long) * 25.4, padNumbers: false });
    const pw = Math.round((w / long) * LONG_SIDE), ph = Math.round((h / long) * LONG_SIDE);
    // the preview store holds SVG documents; this one carries the picture
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw} ${ph}" width="${pw}" height="${ph}">`
      + `<image width="${pw}" height="${ph}" href="data:image/png;base64,${await toBase64(png)}"/></svg>`;
    if (state.docId !== docId) return;   // another document was opened meanwhile
    const r = await fetch(`/api/docs/${docId}/preview?seq=${seq}&fit=true`, { method: "POST", credentials: "same-origin", headers: { "content-type": "image/svg+xml" }, body: svg });
    if (r.ok) { sentAt.set(docId, key); lastSent = Date.now(); }
  } catch (e) { console.warn("thumbnail not sent", e); }
  finally { sending = false; if (again) { again = false; notePreviewDirty(); } }
}

/** The document on screen changed (or was just opened): send its picture once things are quiet. */
export function notePreviewDirty(): void {
  if (timer) clearTimeout(timer);
  const wait = Math.max(QUIET_MS, MIN_GAP_MS - (Date.now() - lastSent));
  timer = window.setTimeout(() => { timer = 0; void send(); }, lastSent ? wait : 2500);
}
