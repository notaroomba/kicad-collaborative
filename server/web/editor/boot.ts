// boot.ts — the page's early loader (static/dist/boot.js, inlined into the page's <head> by src/pages.rs).
//
// Opening a project used to be a queue: the editor's scripts, then "who am I", then the project, then the
// document, each waiting for the one before.  None of the three requests needs the scripts, so they start
// here, the moment the page arrives, and run beside the script downloads; the editor (home.ts loadMe,
// doc.ts openEditor / openDoc) picks the answers up from window.__kcBoot instead of asking again.
// Each answer is used once: later navigation inside the app asks the server as before.
import type { BootDoc } from "./bootpick";

export interface BootContent { docId: string; text: string; seq: number }
export interface Boot {
  me?: Promise<unknown>;
  projectId?: string;
  info?: Promise<{ docs: BootDoc[] }>;
  content?: Promise<BootContent | null>;
}

const json = (url: string) => fetch(url, { headers: { "content-type": "application/json" } })
  .then((r) => (r.ok ? r.json() : r.text().catch(() => "").then((t) => { throw new Error(`${r.status} ${t || r.statusText}`); })));

const boot: Boot = { me: json("/api/me") };
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
  boot.content = q.get("fp") ? Promise.resolve(null)
    : fetch(`/api/projects/${m[1]}/first-doc${doc && /^[0-9a-f-]{36}$/i.test(doc) ? `?doc=${doc}` : ""}`).then((r) => (r.ok && r.headers.get("x-doc-id")
      ? r.text().then((text) => ({ docId: r.headers.get("x-doc-id")!, text, seq: Number(r.headers.get("x-snapshot-seq")) || 0 })) : null)).catch(() => null);
  boot.info.catch(() => {});
}
(window as unknown as { __kcBoot?: Boot }).__kcBoot = boot;
