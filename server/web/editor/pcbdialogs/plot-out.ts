// pcbdialogs/plot-out — what the plot, drill and position dialogs share: the output files handed to the
// browser (one file downloads as itself, several as one zip laid out under the output directory), the
// per-user dialog state kept in localStorage, the board's folder in the project, and a hook that reopens a
// dialog once another one it opened (DRC, Board Setup, a progress reporter) has closed — KDialogs holds one
// dialog at a time, where KiCad stacks a modal over its parent.
import type { KiCadFabApi } from "../../fab/index";
import { state } from "../appstore";

export interface OutputFile { name: string; path: string; data: string | Uint8Array }

const typeOf = (name: string): string => {
  const ext = (/\.([^.]+)$/.exec(name) || ["", ""])[1].toLowerCase();
  return ({ pdf: "application/pdf", svg: "image/svg+xml", png: "image/png", ps: "application/postscript", zip: "application/zip", json: "application/json", gbrjob: "application/json", csv: "text/csv" } as Record<string, string>)[ext] || "text/plain";
};

export function saveBlob(data: string | Uint8Array, name: string): void {
  const blob = new Blob([typeof data === "string" ? data : (data as BlobPart)], { type: typeOf(name) });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = "none";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/** One file: itself.  Several: one zip (fab/zip.ts) holding each at its path under the output directory. */
export async function deliver(fab: KiCadFabApi, files: OutputFile[], zipName: string): Promise<string | null> {
  if (!files.length) return null;
  if (files.length === 1) { saveBlob(files[0].data, files[0].name); return files[0].name; }
  const data = await fab.zip(files.map((f) => ({ name: f.path.replace(/^\/+/, ""), data: f.data })));
  saveBlob(data, zipName); return zipName;
}

/** The folder of the open document inside the project ("" at the top). */
export function docDir(): string {
  const s = state as unknown as { doc?: { path: string } | null };
  return s.doc ? s.doc.path.split("/").slice(0, -1).join("/") : "";
}

export function loadPrefs<T extends object>(key: string, defaults: T): T {
  try { const t = localStorage.getItem(key); if (t) return Object.assign({}, defaults, JSON.parse(t)); } catch (e) { /* private window */ }
  return Object.assign({}, defaults);
}
export function savePrefs(key: string, v: object): void { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private window */ } }

/** Call fn once no KDialogs overlay is open any more (the dialog the caller opened has been closed). */
export function whenDialogsClosed(fn: () => void): void {
  const initial = document.querySelector(".kd-overlay");
  let seen = false;
  const check = (): void => {
    const cur = document.querySelector(".kd-overlay");
    if (cur && cur !== initial) { seen = true; return; }
    if (!cur && seen) { obs.disconnect(); clearTimeout(t); setTimeout(fn, 0); }
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true });
  // the caller opens its dialog right after this call (or after a load); give up if none ever appears
  const t = setTimeout(() => { if (!seen) obs.disconnect(); }, 15000);
  setTimeout(check, 0);
}
