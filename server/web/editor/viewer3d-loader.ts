// editor/viewer3d-loader.ts — View → 3D Viewer (ACTIONS::show3DViewer, Alt+3) for the board editor.
// The viewer is a bundle of its own (static/dist/viewer3d.js, server/web/viewer3d) fetched on first
// use; this module loads it, hands it the live board document and tells it when the document changes.
import { state, store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";

interface Viewer3DOpenOptions {
  getDoc(): KDoc | null;
  getName?(): string;
  subscribe?(onChange: () => void): () => void;
  toast?(text: string, ms?: number): void;
}
interface Viewer3DGlobal { open(opts: Viewer3DOpenOptions): unknown; close(): void; isOpen(): boolean }

interface EditorState { kdoc: KDoc | null }
interface AppStore {
  get(): { document: { version: number; docId: string | null }; undo: { undo: number; redo: number }; connection: { edits: number }; view: string };
  subscribe(fn: () => void): () => void;
}
interface DocEntry { docId: string; path?: string }

const editor = E as unknown as EditorState;
const app = store as unknown as AppStore;

let loading: Promise<Viewer3DGlobal> | null = null;

function viewerGlobal(): Viewer3DGlobal | undefined { return (window as unknown as { KiCadViewer3D?: Viewer3DGlobal }).KiCadViewer3D; }

/** Fetch the viewer bundle once; its URL carries the same cache-busting version as the editor's own script. */
function loadViewer(): Promise<Viewer3DGlobal> {
  const ready = viewerGlobal(); if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<Viewer3DGlobal>((resolve, reject) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
    const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const s = document.createElement("script"); s.src = "/static/dist/viewer3d.js" + (query ? "?" + query : "");
    s.onload = () => { const g = viewerGlobal(); if (g) resolve(g); else reject(new Error("viewer3d.js did not register")); };
    s.onerror = () => reject(new Error("could not load viewer3d.js"));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

function boardDoc(): KDoc | null { const d = editor.kdoc; return d && d.type === "pcb" ? d : null; }

function boardName(): string {
  const docs = ((state as unknown as { docs?: DocEntry[] }).docs) || [];
  const id = (state as unknown as { docId: string | null }).docId;
  const d = docs.find((x) => x.docId === id);
  return d && d.path ? String(d.path).split("/").pop() || "" : "";
}

/** Open (or focus) the 3D viewer on the board being edited. */
export function show3DViewer(): void {
  if (!boardDoc()) { toast("The 3D viewer shows a board: open the PCB editor first"); return; }
  loadViewer().then((viewer) => {
    viewer.open({
      getDoc: boardDoc, getName: boardName, toast,
      // An applied change — local or a collaborator's — bumps document.version (doc.ts bumpDoc); the board
      // editor's own footprint drag commits without it but records an undo step, and a remote op counts
      // in connection.edits: any of them moving means the board may have changed.
      subscribe(onChange) {
        const stamp = () => { const s = app.get(); return [s.document.docId, s.document.version, s.undo.undo, s.undo.redo, s.connection.edits].join("|"); };
        let last = stamp(); const docId = app.get().document.docId;
        return app.subscribe(() => {
          // left the board editor (home, another project, a schematic sheet, another board): the window goes with it, as
          // KiCad's 3D viewer closes with its PCB frame
          const s = app.get(), d = editor.kdoc;
          if (s.view !== "editor" || (s.document.docId && s.document.docId !== docId) || (d && d.type !== "pcb")) { viewer.close(); return; }
          const now = stamp(); if (now !== last) { last = now; onChange(); }
        });
      },
    });
  }).catch((e: unknown) => { console.warn(e); toast("The 3D viewer could not be loaded"); });
}

// Alt+3, KiCad's hotkey for show3DViewer (matched on the physical key: Alt+3 types a symbol on some layouts)
document.addEventListener("keydown", (ev) => {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.code !== "Digit3") return;
  const t = ev.target as HTMLElement | null;
  if ((t && /^(INPUT|TEXTAREA|SELECT|K-SELECT)$/.test(t.tagName)) || app.get().view !== "editor" || !boardDoc()) return;
  ev.preventDefault(); show3DViewer();
});
