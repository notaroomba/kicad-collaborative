// dialogs/browse-cells.ts — the browse buttons of KiCad's text cell editors (common/widgets/grid_text_button_helpers.cpp
// and common/properties/pg_editors.cpp), for the fields grids and the Properties panel:
//
//   GRID_CELL_FPID_EDITOR / PG_FPID_EDITOR   BITMAPS::small_library; opens FOOTPRINT_CHOOSER_FRAME with the symbol's
//                                            pin count and footprint filters (SelectFootprintFromChooser) on the cell's
//                                            footprint, and an accepted choice ("Lib:Name") is the cell's new value,
//                                            committed at once (WX_GRID::CommitPendingChanges)
//   GRID_CELL_URL_EDITOR / PG_URL_EDITOR     BITMAPS::small_folder while the cell is empty, BITMAPS::www once it holds
//                                            something; with a value, GetAssociatedDocument opens it (a web or mail link
//                                            in a new tab, a kicad-embed:// file decoded from the embedded-files stack),
//                                            and with none KiCad's file dialog would pick a local file, which a web page
//                                            cannot browse to.  The fields grids give it to the Datasheet and to any
//                                            field whose value is a link or whose template name is flagged URL
//   GRID_CELL_PATH_EDITOR                    a sheet's Sheetfile: BITMAPS::small_folder, the project's schematic files
import type { GridCellButton } from "./dom";
import { popupMenu } from "./dom";
import type { FpChooserFilters } from "../library/fpchoice";
import { datasheetLink } from "../library/fpchoice";
import { messageBox } from "./sch-items";
import { E } from "./editor";
import { zstdDecompress } from "./zstd";

interface LibApi { openChooser(kind: "footprint", opts?: { title?: string; preselect?: string; fpFilters?: FpChooserFilters | null; noSources?: boolean; history?: boolean }): Promise<{ fpid?: string; item?: { id: string } } | null> }
const libApi = (): LibApi | null => (window as unknown as { KiCadLibrary?: LibApi }).KiCadLibrary || null;

let busy = false;   // m_buttonFpChooserLock: a second click while the chooser is loading does nothing
/** SelectFootprintFromChooser: the chooser on `current`, filtered by the symbol's netlist; the chosen "Lib:Name" or null. */
export async function chooseFootprint(current: string, filters: FpChooserFilters | null): Promise<string | null> {
  const L = libApi(); if (!L || busy) return null;
  busy = true;
  try {
    const got = await L.openChooser("footprint", { title: "Footprint Chooser", preselect: current.trim(), fpFilters: filters, noSources: true, history: true });
    return got ? got.fpid || (got.item && got.item.id) || null : null;
  } finally { busy = false; }
}

/** What GetAssociatedDocument resolves a value with: the project (its text variables, ResolveUriByEnvVars) and the
 *  embedded-files stack, searched from the back (e.g. the schematic's files, then the symbol's). */
export interface DocContext { vars?: Record<string, string> | null; files?: (SNode | null | undefined)[] }
/** The project's text variables (.kicad_pro text_variables), when a project is open. */
export function projectVars(): Record<string, string> | null {
  try { const j = E.proSettings ? JSON.parse(E.proSettings) as { text_variables?: unknown } : null; const v = j && j.text_variables; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, string> : null; } catch { return null; }
}
/** The schematic's own (embedded_files …) as a stack entry. */
export const docFiles = (doc: KDoc | null | undefined): SNode | null => (doc ? (doc as KDoc & { embeddedFiles?: SNode | null }).embeddedFiles || null : null);

const MIME: Record<string, string> = { pdf: "application/pdf", htm: "text/html", html: "text/html", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
const isList = (v: unknown): v is SNode => Array.isArray(v);
const kidOf = (n: SNode, k: string): SNode | null => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === k) return c; } return null; };
/** EMBEDDED_FILES::GetTemporaryFileName over the stack: the named file's data (base64 of a zstd frame), from the back. */
function embeddedData(files: (SNode | null | undefined)[], name: string): string | null {
  for (let i = files.length - 1; i >= 0; i--) {
    const o = files[i]; if (!o) continue;
    const ef = o[0] === "embedded_files" ? o : kidOf(o, "embedded_files"); if (!ef) continue;
    for (const f of ef.slice(1)) {
      if (!isList(f) || f[0] !== "file") continue;
      const n = kidOf(f, "name"); if (!n || String(n[1]) !== name) continue;
      const d = kidOf(f, "data"); return d ? d.slice(1).map((x) => String(x)).join("").replace(/[|\s]/g, "") : "";
    }
  }
  return null;
}
/** The bytes of an embedded file, decoded here so the new tab opens within the click (a pop-up is allowed only then). */
function embeddedBytes(b64: string): Uint8Array | null {
  try { const bin = atob(b64), z = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) z[i] = bin.charCodeAt(i); return zstdDecompress(z); } catch { return null; }
}

/** GetAssociatedDocument for a field value: ${VAR}s resolved first; a link opens in a new tab, a kicad-embed:// file
 *  of the embedded-files stack opens decoded in one (KiCad leaves a name the stack does not hold unopened, without a
 *  message); anything else is reported. */
export function openDatasheet(value: string, ctx: DocContext = {}): void {
  const d = datasheetLink(value, ctx.vars === undefined ? projectVars() : ctx.vars);
  if (d.kind === "url") { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
  if (d.kind === "embed") {
    const b64 = embeddedData(ctx.files || [], d.url), bytes = b64 ? embeddedBytes(b64) : null; if (!bytes) return;
    const ext = (d.url.split(".").pop() || "").toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: MIME[ext] || "application/octet-stream" }));
    window.open(url, "_blank", "noopener,noreferrer"); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  if (d.kind === "other") void messageBox(`Documentation file '${d.url}' not found.`);
}

/** In place of KiCad's "Open file" dialog for an empty Datasheet: a web page cannot browse the computer's files, so the
 *  value is a typed link. */
export function noFileBrowsing(where: "cell" | "property"): Promise<void> {
  return messageBox(`Local files cannot be browsed from the web editor.\nType the datasheet's web address (https://…) into the ${where}.`, "Open file");
}

/** The URL editor's bitmap (UpdateButtonBitmaps / PG_URL_EDITOR::CreateControls). */
export const urlIcon = (value: string): string => (datasheetLink(value).kind === "none" ? "small_folder" : "www");
/** The button's tooltip: FIELDS_GRID_TRICKS' "Select Footprint..." / "Show Datasheet" help strings. */
export const FP_BROWSE_TIP = "Browse for footprint";
export const urlTip = (value: string): string => (datasheetLink(value).kind === "none" ? "Open file" : "Show datasheet in browser");

/** A fields grid cell's footprint browse button. */
export function footprintButton(filters: () => FpChooserFilters | null): GridCellButton {
  return {
    icon: () => "small_library", title: () => FP_BROWSE_TIP,
    run(value, set) { void chooseFootprint(value, filters()).then((fp) => { if (fp) set(fp); }); },
  };
}
/** A fields grid cell's URL button (GRID_CELL_URL_EDITOR: the Datasheet value, and any field whose value is a link or
 *  whose template field name is flagged URL). */
export function datasheetButton(ctx: () => DocContext = () => ({})): GridCellButton {
  return {
    icon: urlIcon, title: urlTip,
    run(value, _set, input) {
      if (datasheetLink(value).kind !== "none") { openDatasheet(value, ctx()); return; }
      void noFileBrowsing("cell").then(() => { if (input) input.focus(); });
    },
  };
}

/** A sheet's Sheetfile cell (GRID_CELL_PATH_EDITOR: small_folder; a file dialog on the project folder for a schematic
 *  file).  The web editor's files are the project's documents: the button lists its schematic files, written relative
 *  to the sheet that holds the sheet symbol, and a pick is the cell's new value. */
export function sheetFileButton(files: () => { path: string; here: string }[]): GridCellButton {
  return {
    icon: () => "small_folder", title: () => "Browse for schematic file",
    run(value, set, input) {
      const list = files(); const r = input ? input.getBoundingClientRect() : { left: 0, bottom: 0 };
      if (!list.length) { void messageBox("The project has no other schematic files.", "Open file"); return; }
      popupMenu(r.left, r.bottom, list.map((f) => ({ label: f.path, check: true, checked: f.path === value.trim(), run: () => { if (f.path !== value) set(f.path); } })));
    },
  };
}
/** The path of `path` as seen from the folder `dir` (both project-relative, "/"-separated). */
export function relativePath(dir: string, path: string): string {
  const a = dir ? dir.split("/").filter(Boolean) : [], b = path.split("/").filter(Boolean);
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
