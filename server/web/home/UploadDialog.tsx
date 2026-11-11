// UploadDialog.tsx — put a KiCad project online from the browser: pick or drop a project folder,
// its files, or a .zip.  Only KiCad project files are sent; everything else is listed as left out.
import { useEffect, useMemo, useRef, useState } from "react";
import { createBlank, isLocalState, isProjectFile, uploadProject, type UploadFile, type UploadResult } from "./api";
import { Ic, Modal, PHONE, useMedia } from "./ui";

/** Files of a drop, walking dropped folders (DataTransferItem.webkitGetAsEntry). */
export async function filesFromDrop(dt: DataTransfer): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  const entries = Array.from(dt.items || []).map((it) => (it.kind === "file" && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files || []).map((file) => ({ path: file.name, file }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 2000) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      if (isLocalState(entry.name) || entry.name === "node_modules") return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back batches; an empty batch ends the directory.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      }
    }
  };
  for (const e of entries) await walk(e, "").catch(() => {});
  return out;
}

export const filesFromInput = (list: FileList | null): UploadFile[] =>
  Array.from(list || []).map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));

const stem = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
const MAX_TOTAL = 50 * 1024 * 1024;   // the server's request body limit (main.rs DefaultBodyLimit)

export function UploadDialog({ initial, onClose, onDone, onBlank, onBusy }: { initial?: UploadFile[]; onClose: () => void; onDone: (r: UploadResult) => void; onBlank: (r: UploadResult) => void; onBusy?: (busy: boolean) => void }) {
  const [mode, setMode] = useState<"upload" | "blank">("upload");
  // A phone has no drag and drop, and iOS cannot pick a folder: one "choose files" button, worded for that.
  const touch = useMedia(PHONE) || !("webkitdirectory" in HTMLInputElement.prototype);
  const [blankName, setBlankName] = useState("");
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>(initial || []);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const abort = useRef<(() => void) | null>(null);
  const pickFiles = useRef<HTMLInputElement>(null);
  const pickFolder = useRef<HTMLInputElement>(null);

  const zip = files.length === 1 && /\.zip$/i.test(files[0].path) ? files[0] : null;
  const { kept, skipped } = useMemo(() => {
    if (zip) return { kept: [zip], skipped: [] as UploadFile[] };
    const usable = files.filter((f) => !isLocalState(f.path));
    return { kept: usable.filter((f) => isProjectFile(f.path)), skipped: usable.filter((f) => !isProjectFile(f.path)) };
  }, [files, zip]);
  const total = kept.reduce((n, f) => n + f.file.size, 0);
  const count = (re: RegExp) => kept.filter((f) => re.test(f.path)).length;

  // A sensible default name: the .kicad_pro, else the dropped folder, else the zip.
  useEffect(() => {
    if (named) return;
    const pro = kept.find((f) => /\.kicad_pro$/i.test(f.path));
    const dir = kept[0] && kept[0].path.includes("/") ? kept[0].path.split("/")[0] : "";
    setName(zip ? stem(zip.path) : pro ? stem(pro.path) : dir || (kept[0] ? stem(kept[0].path) : ""));
  }, [kept, zip, named]);

  const busy = progress !== null;
  const take = (list: UploadFile[]) => { if (list.length && !busy) { setMode("upload"); setFiles(list); setError(null); setNamed(false); } };
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy]);   // eslint-disable-line
  // A file dropped beside the dashed box would otherwise make the browser leave the page for it.
  useEffect(() => {
    const over = (ev: DragEvent) => { ev.preventDefault(); };
    const drop = async (ev: DragEvent) => { ev.preventDefault(); if (ev.dataTransfer) take(await filesFromDrop(ev.dataTransfer)); };
    window.addEventListener("dragover", over); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  });
  const tooBig = total > MAX_TOTAL;
  const problem = !files.length ? null
    : !kept.length ? "None of these are KiCad project files. Choose a project folder, its .kicad_pro / .kicad_sch / .kicad_pcb files, or a .zip of them."
    : tooBig ? `That is ${fmtSize(total)}; the limit is ${fmtSize(MAX_TOTAL)}. Leave out 3D models or split the project.`
    : !zip && !kept.some((f) => /\.kicad_(pro|sch|pcb)$/i.test(f.path)) ? "There is no schematic or board among these files." : null;

  const createEmpty = async () => {
    if (creating || !blankName.trim()) return;
    setCreating(true); setError(null);
    try { onBlank(await createBlank(blankName.trim())); } catch (e) { setCreating(false); setError(e instanceof Error ? e.message : String(e)); }
  };
  const go = () => {
    if (mode === "blank") { createEmpty(); return; }
    if (busy || problem || !kept.length) return;
    setError(null); setProgress(0);
    const up = uploadProject(name, kept, setProgress);
    abort.current = up.abort;
    up.promise.then(onDone).catch((e) => { setProgress(null); setError(e instanceof Error ? e.message : String(e)); });
  };

  return (
    <Modal title="New online project" onClose={onClose} width={520} busy={busy || creating}
      footer={<><button type="button" className="btn" disabled={creating} onClick={() => { if (busy) abort.current?.(); else onClose(); }}>{busy ? "Cancel upload" : "Cancel"}</button>
        {mode === "blank" ? <button type="button" className="btn primary" onClick={go} disabled={creating || !blankName.trim()}>{creating ? "Creating…" : "Create and open"}</button>
          : <button type="button" className="btn primary" onClick={go} disabled={busy || !kept.length || !!problem || !name.trim()}>{busy ? ((progress || 0) >= 1 ? "Saving…" : "Uploading…") : "Upload"}</button>}</>}>
      <div className="hp-seg hp-modes" role="tablist" aria-label="How to start">
        <button type="button" role="tab" aria-selected={mode === "upload"} className={mode === "upload" ? "on" : undefined} onClick={() => { setMode("upload"); setError(null); }} disabled={busy || creating}>Upload a KiCad project</button>
        <button type="button" role="tab" aria-selected={mode === "blank"} className={mode === "blank" ? "on" : undefined} onClick={() => { setMode("blank"); setError(null); }} disabled={busy || creating}>Blank project</button>
      </div>
      {mode === "blank" ? (
        <>
          <label className="hp-field"><span>Project name</span>
            <input className="hp-input" autoFocus value={blankName} maxLength={120} placeholder="My board" disabled={creating} onChange={(ev) => setBlankName(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter") createEmpty(); }} /></label>
          <p className="hp-note">Starts an empty schematic and board, the same files KiCad makes for File → New Project, and opens it in the editor. You can share it straight away.</p>
        </>
      ) : (<>
      <div className={"hp-drop" + (over ? " over" : "") + (files.length ? " has" : "")}
        onDragOver={(ev) => { ev.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={async (ev) => { ev.preventDefault(); ev.stopPropagation(); setOver(false); take(await filesFromDrop(ev.dataTransfer)); }}>
        <Ic name="upload" size={26} />
        {touch ? <p><b>Choose your KiCad project files</b><br /><span className="hp-dim">the .kicad_pro, .kicad_sch and .kicad_pcb files together, or a .zip of the project folder</span></p>
          : <p><b>Drop a KiCad project here</b><br /><span className="hp-dim">a project folder, its files, or a .zip</span></p>}
        <div className="hp-drop-btns">
          {touch ? null : <button type="button" className="btn" onClick={() => pickFolder.current?.click()} disabled={busy}>Choose folder…</button>}
          <button type="button" className={"btn" + (touch ? " primary" : "")} onClick={() => pickFiles.current?.click()} disabled={busy}>Choose files or .zip…</button>
        </div>
        <input ref={pickFiles} type="file" multiple hidden onChange={(ev) => { take(filesFromInput(ev.target.files)); ev.target.value = ""; }} />
        <input ref={pickFolder} type="file" hidden multiple {...({ webkitdirectory: "", directory: "" } as object)} onChange={(ev) => { take(filesFromInput(ev.target.files)); ev.target.value = ""; }} />
      </div>

      {files.length ? (
        <>
          <label className="hp-field"><span>Project name</span>
            <input className="hp-input" value={name} maxLength={120} disabled={busy} onChange={(ev) => { setName(ev.target.value); setNamed(true); }}
              onKeyDown={(ev) => { if (ev.key === "Enter") go(); }} /></label>
          {kept.length ? (
            <p className="hp-summary">
              {zip ? <><Ic name="file" /> {zip.path} · {fmtSize(zip.file.size)}</> : (
                <><Ic name="file" /> {kept.length} file{kept.length === 1 ? "" : "s"} · {fmtSize(total)}
                  {count(/\.kicad_sch$/i) ? ` · ${count(/\.kicad_sch$/i)} schematic sheet${count(/\.kicad_sch$/i) === 1 ? "" : "s"}` : ""}
                  {count(/\.kicad_pcb$/i) ? ` · ${count(/\.kicad_pcb$/i)} board${count(/\.kicad_pcb$/i) === 1 ? "" : "s"}` : ""}</>
              )}
            </p>
          ) : null}
          {skipped.length ? (
            <details className="hp-skipped"><summary>{skipped.length} other file{skipped.length === 1 ? "" : "s"} will be left out</summary>
              <ul>{skipped.slice(0, 40).map((f) => <li key={f.path}>{f.path}</li>)}{skipped.length > 40 ? <li>…and {skipped.length - 40} more</li> : null}</ul></details>
          ) : null}
        </>
      ) : <p className="hp-note">Your files are copied to the server; nothing on your {touch ? "device" : "computer"} changes. You can also publish straight from the desktop app with File → Publish Project Online, or <a href="/github">import a repository from GitHub</a>.</p>}
      </>)}
      {mode === "upload" && problem ? <p className="hp-note err" role="alert">{problem}</p> : null}
      {error ? <p className="hp-note err" role="alert">{error}</p> : null}
      {busy ? <div className="hp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress || 0) * 100)}><i style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div> : null}
    </Modal>
  );
}
