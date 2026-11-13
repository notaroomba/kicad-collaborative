// pcbdialogs/odbpp — File > Fabrication Outputs > ODB++ Output File… (pcbnew/dialogs/dialog_export_odbpp.cpp,
// DIALOG_EXPORT_ODBPP): File, then under File Format: Units (Millimeters / Inches), Precision, Version (8.1),
// Compression format (None / ZIP / TGZ), Product name and Origin; Export / Close.  The job itself is web/fab/odb.ts, PCB_IO_ODBPP's files.  A browser cannot write a
// folder, so "None" downloads the job folder packed in a ZIP of the folder's name.
import type { KiCadFabApi } from "../../fab/index";
import { E } from "../state";
import { toolCtx } from "../tools";
import { fabContext, loadFab } from "../fab-outputs";
import { loadPrefs, saveBlob, savePrefs } from "./plot-out";
import { ensureCss, h, messageBox, numField, selectField, textField } from "./ui";

interface OdbPrefs { inch: boolean; precision: number; compress: number; origin: number; product: string }
const KEY = "kicad.odbpp";
const DEFAULTS: OdbPrefs = { inch: false, precision: 6, compress: 1, origin: 0, product: "" };
const ORIGINS = ["absolute", "aux", "grid"] as const;
/** PCB_IO_ODBPP::MinPrecision / MaxPrecision */
const minPrecision = (inch: boolean): number => (inch ? 4 : 3), MAX_PRECISION = 16;
const EXT = ["", ".zip", ".tgz"];

/** BOARD_EDITOR_CONTROL::GenerateODBPPFiles. */
export async function openOdbpp(): Promise<void> {
  const ctx = toolCtx() as ToolCtx;
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("An ODB++ job is made from a board: open the PCB editor first"); return; }
  let fab: KiCadFabApi;
  try { fab = await loadFab(); } catch (e) { console.warn(e); ctx.toast("The ODB++ writer could not be loaded"); return; }
  const first = await fabContext(); if (!first) return;
  const board = first.projectName || "board";
  const pref = loadPrefs(KEY, DEFAULTS);
  const out = textField(`${board}-odb${EXT[pref.compress] || ""}`, { key: "outputFile" });
  const withExt = (c: number): void => { out.set(out.get().replace(/\.(zip|tgz)$/i, "") + EXT[c]); };
  const clamp = (): number => Math.min(MAX_PRECISION, Math.max(minPrecision(units.get() === 1), Math.round(precision.get()) || 0));
  const units = selectField<number>(pref.inch ? 1 : 0, [[0, "Millimeters"], [1, "Inches"]], { key: "units", onChange: () => precision.set(clamp()) });   // updatePrecisionRange
  const precision = numField(pref.precision, { key: "precision", digits: 0 });
  precision.input.title = "The number of values following the decimal separator";
  precision.input.addEventListener("change", () => precision.set(clamp()));
  const version = selectField<number>(0, [[0, "8.1"]], { key: "version" });
  const compress = selectField<number>(pref.compress, [[0, "None"], [1, "ZIP"], [2, "TGZ"]], { key: "compress", onChange: (c) => withExt(c) });
  compress.input.title = "Select the format to compress the output ODB++ files";
  const product = textField(pref.product, { key: "productName" });
  product.input.title = "Product model name in ODB++";
  const origin = selectField<number>(pref.origin, [[0, "Absolute coordinates"], [1, "Drill/place file origin"], [2, "Grid origin"]], { key: "origin" });
  out.input.title = "Output archive or directory";
  const read = (): OdbPrefs => ({ inch: units.get() === 1, precision: clamp(), compress: compress.get(), origin: origin.get(), product: product.get().trim() });

  async function run(close: () => void): Promise<void> {
    const p = read(); savePrefs(KEY, p);
    const name = (out.get().trim().replace(/\\/g, "/").split("/").pop() || `${board}-odb`);
    const fctx = await fabContext(); if (!fctx) return;
    let job: ReturnType<KiCadFabApi["odb"]>;
    try { job = fab.odb(fctx, { inch: p.inch, precision: p.precision, origin: ORIGINS[p.origin] || "absolute", productName: p.product }); }
    catch (e) { console.warn(e); messageBox("Error", `Error generating ODBPP files '${name}'.\n${e instanceof Error ? e.message : String(e)}`); return; }
    const folder = p.compress === 0 ? name.replace(/\.(zip|tgz)$/i, "") + "/" : "";
    const enc = new TextEncoder();
    if (p.compress === 2) {
      const entries = job.dirs.map((d) => ({ name: d + "/", data: new Uint8Array(0) })).concat(job.files.map((f) => ({ name: f.path, data: enc.encode(f.text) })));
      saveBlob(await fab.gzip(fab.tar(entries)), /\.tgz$/i.test(name) ? name : name + ".tgz");
    } else {
      const data = await fab.zip(job.files.map((f) => ({ name: folder + f.path, data: f.text })));
      saveBlob(data, /\.zip$/i.test(name) ? name : name + ".zip");
    }
    close();
    ctx.toast(job.warnings.length ? `ODB++ job written with ${job.warnings.length} warning${job.warnings.length === 1 ? "" : "s"}: ${job.warnings[0]}` : `ODB++ job written to '${name}'`);
  }

  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  const closeDlg = (): void => { KDialogs!.close(); };
  KDialogs!.open({ title: "Export ODB++", width: 520,
    buttons: [
      { label: "Close", close: true, id: "close" },
      { label: "Export", primary: true, isDefault: true, id: "export", fn: () => { void run(closeDlg); } },
    ],
    cancel: () => savePrefs(KEY, read()),
    build(body: HTMLElement) {
      ensureCss();
      body.append(
        h("div", { class: "pd-row", style: "margin-bottom:10px" }, lbl("File:"), (out.el.style.flex = "1", out.el)),
        h("div", { class: "pd-box" }, h("div", { class: "hd" }, "File Format"),
          h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:6px 8px;align-items:center" }, lbl("Units:"), units.el, lbl("Precision:"), precision.el, lbl("Version:"), version.el, lbl("Compression format:"), compress.el, lbl("Product name:"), product.el, lbl("Origin:"), origin.el)));
    } } as unknown as Parameters<NonNullable<typeof KDialogs>["open"]>[0]);
}
