// thumb.ts — a project's thumbnail when the server has no preview of it yet (a preview only exists
// once a desktop editor has pushed one, or where the server runs kicad-cli): draw the board, or the
// root schematic sheet, with the same canvas renderer the web editor uses.  One at a time, and only
// when the browser is idle — parsing a big board must not make the list stutter.
import { api } from "./api";

interface DocEntry { docId: string; path: string; docType: string }
interface CanvasApi {
  parseDoc(text: string, docType: string): { type: string; bbox: number[] | null; page: number[]; items?: { size: number } };
  renderPng(doc: unknown, opts: Record<string, unknown>): Promise<Blob>;
}

const done = new Map<string, string | null>();          // key → object URL, or null when there is nothing to draw
const waiting = new Map<string, Array<(url: string | null) => void>>();
const queue: Array<{ key: string; projectId: string; canKeep: boolean }> = [];
const latest = new Map<string, string>();               // projectId → the key whose picture is current
const failures = new Map<string, number>();             // key → tries that ended in an error
let running = false;
const MAX_BYTES = 8 * 1024 * 1024;
const LONG_SIDE = 520;   // px: a card is ~240 css px wide, so this is sharp on a 2× screen

/** What to try, in order: the board, then the root schematic sheet (a board with nothing on it yet draws nothing). */
function pickDocs(docs: DocEntry[]): DocEntry[] {
  const board = docs.find((d) => d.docType === "kicad_pcb");
  const sheets = docs.filter((d) => d.docType === "kicad_sch");
  const pro = docs.find((d) => d.docType === "kicad_pro");
  const stem = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const root = (stem && sheets.find((d) => d.path.split("/").pop() === `${stem}.kicad_sch`))
    || sheets.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0] || null;
  return [board, root].filter((d): d is DocEntry => !!d);
}

const canvasApi = () => (window as unknown as { KiCadCanvas?: CanvasApi }).KiCadCanvas;
/** The renderer is a script of its own and may land after the list does: wait for it rather than give up. */
async function renderer(): Promise<CanvasApi> {
  for (let i = 0; i < 100 && !canvasApi(); i++) await new Promise((r) => setTimeout(r, 100));
  const K = canvasApi();
  if (!K) throw new Error("renderer not loaded");
  return K;
}

const toBase64 = (blob: Blob): Promise<string> => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/**
 * Leave the picture just drawn with the server, so the next visit (and everyone else's) gets it in one
 * request instead of fetching and drawing the document again.  It is filed under the snapshot it was
 * drawn from, so a newer picture from an editor is never replaced by it.  Viewers are refused; ignored.
 */
async function keep(docId: string, seq: number, blob: Blob, w: number, h: number): Promise<void> {
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${await toBase64(blob)}"/></svg>`;
    await fetch(`/api/docs/${docId}/preview?seq=${seq}&fit=true`, { method: "POST", credentials: "same-origin", headers: { "content-type": "image/svg+xml" }, body: svg });
  } catch { /* only a convenience */ }
}

async function draw(projectId: string, canKeep: boolean): Promise<string | null> {
  const K = await renderer();
  const info = await api<{ docs: DocEntry[] }>(`/api/projects/${projectId}/info`);
  for (const doc of pickDocs(info.docs || [])) {
    const res = await fetch(`/api/docs/${doc.docId}/content`, { credentials: "same-origin" });
    if (res.status === 404) continue;   // a document with no file yet
    if (!res.ok) throw new Error(`content ${res.status}`);
    const text = await res.text();
    if (!text || text.length > MAX_BYTES) continue;
    const parsed = K.parseDoc(text, doc.docType);
    // Nothing placed yet: a picture of an empty board or sheet reads as a broken image.  Try the
    // next document; with nothing anywhere the card shows its placeholder.
    if (parsed.items && parsed.items.size === 0) continue;
    const box = parsed.type === "pcb" ? parsed.bbox : [0, 0, parsed.page[0], parsed.page[1]];
    if (!box || box[2] - box[0] < 0.5 || box[3] - box[1] < 0.5) continue;
    const long = Math.max(box[2] - box[0], box[3] - box[1], 1);
    const blob = await K.renderPng(parsed, { dpi: (LONG_SIDE / long) * 25.4, padNumbers: false });
    if (canKeep) void keep(doc.docId, Number(res.headers.get("x-snapshot-seq")) || 0, blob, Math.round(((box[2] - box[0]) / long) * LONG_SIDE), Math.round(((box[3] - box[1]) / long) * LONG_SIDE));
    return URL.createObjectURL(blob);
  }
  return null;
}

const idle = (fn: () => void) => { const w = window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => void }; if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 1500 }); else setTimeout(fn, 60); };

function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  idle(async () => {
    let url: string | null = null;
    let definite = true;
    try { url = await draw(next.projectId, next.canKeep); }
    catch {
      // A dropped connection or a renderer that is still loading says nothing about the project:
      // leave it unanswered so the next look tries again (three strikes, then it is "nothing to draw").
      const n = (failures.get(next.key) || 0) + 1; failures.set(next.key, n); definite = n >= 3;
    }
    if (definite) {
      done.set(next.key, url);
      // The picture of an older version of this project is of no more use.
      const old = latest.get(next.projectId);
      if (old && old !== next.key) { const u = done.get(old); done.delete(old); if (u) setTimeout(() => URL.revokeObjectURL(u), 30000); }
      latest.set(next.projectId, next.key);
    }
    // Not settled (a dropped connection): ask again shortly instead of telling the card there is nothing.
    if (!definite) { queue.push(next); running = false; setTimeout(pump, 1500); return; }
    for (const fn of waiting.get(next.key) || []) fn(url);
    waiting.delete(next.key);
    running = false; pump();
  });
}

/** A locally drawn thumbnail for the project (null when it has nothing drawable).  `stamp` keys the cache: pass updatedAt. */
export function localThumb(projectId: string, stamp: string, canKeep = false): Promise<string | null> {
  const key = projectId + "@" + stamp;
  if (done.has(key)) return Promise.resolve(done.get(key) ?? null);
  return new Promise((resolve) => {
    const list = waiting.get(key);
    if (list) { list.push(resolve); return; }
    waiting.set(key, [resolve]);
    queue.push({ key, projectId, canKeep }); pump();
  });
}
/** Synchronous look at the cache, so a re-mounted card paints its thumbnail in the first frame. */
export const cachedThumb = (projectId: string, stamp: string): string | null | undefined => done.get(projectId + "@" + stamp);
