// boot.ts — the page's early loader (static/dist/boot.js, inlined into the page's <head> by src/pages.rs).
//
// Opening a project used to be a queue: the editor's scripts, then "who am I", then the project, then the
// document, each waiting for the one before.  None of the three requests needs the scripts, so they start
// here, the moment the page arrives, and run beside the script downloads; the editor (home.ts loadMe,
// doc.ts openEditor / openDoc) picks the answers up from window.__kcBoot instead of asking again.
// Each answer is used once: later navigation inside the app asks the server as before.
import { BOARD_HINT, type BootDoc } from "./bootpick";

export interface BootContent { docId: string; text: string; seq: number; head: number }
export interface Boot {
  me?: Promise<unknown>;
  projectId?: string;
  info?: Promise<{ docs: BootDoc[] }>;
  content?: Promise<BootContent | null>;
  /** Load the board tools (once); resolves when both scripts have run. */
  pcbTools?: () => Promise<void>;
}

const json = (url: string) => fetch(url, { headers: { "content-type": "application/json" } })
  .then((r) => (r.ok ? r.json() : r.text().catch(() => "").then((t) => { throw new Error(`${r.status} ${t || r.statusText}`); })));

/**
 * The board tools (static/pcb-tools.js and the autorouter), which the page does not load up front any more: a
 * schematic needs neither.  Called here as soon as a board is known to be coming (the server says what the first
 * document is; a board this browser has opened before is remembered, see BOARD_HINT), and by the editor before it
 * draws a board (pcbtools-loader.ts).  One download, whoever asks first.
 */
let boardTools: Promise<void> | null = null;
function loadBoardTools(): Promise<void> {
  if (!boardTools) {
    const v = (window as unknown as { __kcAssetV?: string }).__kcAssetV;
    boardTools = new Promise<void>((resolve, reject) => {
      const tags: HTMLScriptElement[] = []; let left = 2;
      for (const path of ["/static/pcb-tools.js", "/static/dist/autoroute.js"]) {
        const s = document.createElement("script"); s.src = path + (v ? "?v=" + v : ""); s.async = false;   // fetched together, run in this order
        s.onload = () => { if (!--left) resolve(); };
        s.onerror = () => { for (const t of tags) t.remove(); boardTools = null; reject(new Error(`could not load ${path}`)); };   // the next board tries again
        tags.push(s); document.head.appendChild(s);
      }
    });
    boardTools.catch(() => {});
  }
  return boardTools;
}
function knownBoard(id: string | null): boolean {
  if (!id) return false;
  try { return (localStorage.getItem(BOARD_HINT) || "").split(" ").indexOf(id) >= 0; } catch (e) { return false; }
}

const boot: Boot = { me: json("/api/me"), pcbTools: loadBoardTools };
boot.me!.catch(() => {});   // signed out is an answer, not an error to report
const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})(?:\/edit|\/live)?\/?$/i);
if (m) {
  const q = new URLSearchParams(location.search);
  boot.projectId = m[1];
  boot.info = json(`/api/projects/${m[1]}/info`);
  // The document the project opens on, asked for at the same moment: the server picks it the way the editor
  // will (bootpick.ts; ?doc= names it outright) and says which it sent, and the editor uses the text only when
  // that is the document it opens.  Not chained after the project's answer, because nothing here runs while the
  // editor's scripts execute.  ?fp= opens the Footprint Editor, which finds its own document.
  const doc = q.get("doc");
  if (q.get("fp") || knownBoard(doc || m[1])) loadBoardTools();   // known to open on a board or a footprint: no need to wait for the answer
  boot.content = q.get("fp") ? Promise.resolve(null)
    : fetch(`/api/projects/${m[1]}/first-doc${doc && /^[0-9a-f-]{36}$/i.test(doc) ? `?doc=${doc}` : ""}`).then((r) => (r.ok && r.headers.get("x-doc-id")
      ? (r.headers.get("x-doc-type") === "kicad_sch" || loadBoardTools(), r).text().then((text) => ({ docId: r.headers.get("x-doc-id")!, text, seq: Number(r.headers.get("x-snapshot-seq")) || 0, head: Number(r.headers.get("x-head-seq")) || 0 })) : null)).catch(() => null);
  boot.info.catch(() => {});
}
(window as unknown as { __kcBoot?: Boot }).__kcBoot = boot;
