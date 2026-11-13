// editor/fab-outputs.ts — File → Fabrication Outputs for the board editor: Gerbers, drill files, the
// component placement file and the bill of materials, packaged the way a manufacturer's order form takes
// them (JLCPCB, PCBWay, or KiCad's own defaults) and downloaded as one archive.
//
// The writers are a bundle of their own (static/dist/fab.js, server/web/fab) fetched on first use; this
// module loads it, hands it the live board and its (setup …) section, and shows what it made: the file
// list, a drawing of each layer as plotted, the checks an order form would bounce, and the downloads.
import type { FabContext, FabPackage, KiCadFabApi, PackageFile, PackageOptions } from "../fab/index";
import { store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import { download, fileStem } from "./menu-actions";
import { loadBoardHeader } from "./pcbdialogs/board-setup";
import { box, checkField, h, note, openDialog, reportPanel, selectField, type Field, type ReportLine } from "./pcbdialogs/ui";

export type FabFocus = "gerber" | "drill" | "placement" | "bom";

interface LayerRow { key: string; name: string; color: string }
interface AppStore { get(): { document: { layers?: LayerRow[] } } }
const app = store as unknown as AppStore;

let loading: Promise<KiCadFabApi> | null = null;
function fabGlobal(): KiCadFabApi | undefined { return (window as unknown as { KiCadFab?: KiCadFabApi }).KiCadFab; }

/** Fetch the writers once; the URL carries the same cache-busting version as the editor's own script. */
export function loadFab(): Promise<KiCadFabApi> {
  // every plot starts here: the fonts of the open document's text are fetched first, so it is plotted in them
  return Promise.all([loadFabScript(), (KiCadCanvas.loadFontsFor ? KiCadCanvas.loadFontsFor(E.kdoc).catch(() => undefined) : Promise.resolve())]).then(([fab]) => fab);
}
function loadFabScript(): Promise<KiCadFabApi> {
  const ready = fabGlobal(); if (ready && typeof ready.buildPackage === "function") return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<KiCadFabApi>((resolve, reject) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
    const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const s = document.createElement("script"); s.src = "/static/dist/fab.js" + (query ? "?" + query : "");
    s.onload = () => { const g = fabGlobal(); if (g && typeof g.buildPackage === "function") resolve(g); else reject(new Error("fab.js did not register")); };
    s.onerror = () => reject(new Error("could not load fab.js"));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

function boardDoc(): KDoc | null { const d = E.kdoc as KDoc | null; return d && d.type === "pcb" ? d : null; }

/** The live board and its setup section, as the writers take them. */
export async function fabContext(): Promise<FabContext | null> {
  const doc = boardDoc(); if (!doc) return null;
  let setup: FabContext["setup"] = null;
  try { const header = await loadBoardHeader(); setup = (header && header.setup) as FabContext["setup"]; } catch (e) { setup = null; }
  return { doc: doc as unknown as FabContext["doc"], setup, projectName: fileStem().stem };
}

const PRESET_KEY = "kicad.fab.preset";
function rememberedPreset(): string { try { return localStorage.getItem(PRESET_KEY) || "jlcpcb"; } catch (e) { return "jlcpcb"; } }
function rememberPreset(id: string): void { try { localStorage.setItem(PRESET_KEY, id); } catch (e) { /* private window */ } }

const KIND_LABEL: Record<PackageFile["kind"], string> = { gerber: "Gerber", drill: "Drill", placement: "Placement", bom: "BOM", archive: "Archive" };
const size = (d: Uint8Array | string): string => { const n = typeof d === "string" ? new Blob([d]).size : d.length; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`; };
const blobOf = (d: Uint8Array | string, type: string): Blob => (typeof d === "string" ? new Blob([d], { type }) : new Blob([d as BlobPart], { type }));

const CSS = `
.fab-cols { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 0 16px; flex: 1 1 auto; min-height: 0; }
.fab-side { overflow: auto; min-height: 0; }
.fab-main { display: flex; flex-direction: column; min-height: 0; gap: 8px; }
.fab-files { flex: 0 0 auto; max-height: 150px; }
.fab-files .it { align-items: center; }
.fab-files .it .nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.fab-files .it .meta { color: var(--ink-2); font-size: 12px; white-space: nowrap; }
.fab-files .it .pill { flex: 0 0 auto; }
.fab-view { flex: 1 1 auto; min-height: 160px; position: relative; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: hidden; }
.fab-view canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.fab-view pre { position: absolute; inset: 0; margin: 0; padding: 6px 8px; overflow: auto; font-family: var(--mono); font-size: 12px; color: var(--ink); white-space: pre; }
.fab-view .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-2); gap: 8px; }
.fab-sum { color: var(--ink-2); font-size: 12px; }
.fab-layers { max-height: 170px; overflow: auto; }
.fab-layers label { display: flex; gap: 6px; align-items: center; padding: 1px 0; color: var(--ink); }
.fab-layers input { width: auto; margin: 0; }
.fab-layers i { width: 10px; height: 10px; border-radius: var(--r-1); display: inline-block; }
@media (max-width: 820px) { .fab-cols { grid-template-columns: 1fr; overflow: auto; } .fab-side { overflow: visible; } }
`;
let cssDone = false;
function ensureCss(): void { if (cssDone) return; cssDone = true; const st = document.createElement("style"); st.id = "fab-css"; st.textContent = CSS; document.head.appendChild(st); }

/** A plotted layer on a canvas: dark shapes in the layer's colour, clear ones cut out again, in plot order. */
function drawLayer(cv: HTMLCanvasElement, fab: KiCadFabApi, pkg: FabPackage, layer: string, color: string): void {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
  cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(hgt * dpr));
  const g = cv.getContext("2d"); if (!g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  // one frame for every layer of the package, so flipping through the files does not jump
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const polysOf = new Map<string, { pts: [number, number][]; clear: boolean }[]>();
  for (const [name, prims] of pkg.prims) {
    const list: { pts: [number, number][]; clear: boolean }[] = [];
    for (const p of prims) for (const pts of fab.primPolys(p)) {
      list.push({ pts, clear: !!p.clear });
      for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1]; }
    }
    polysOf.set(name, list);
  }
  if (!(x1 > x0) || !(y1 > y0)) return;
  const pad = 12 * dpr, s = Math.min((cv.width - 2 * pad) / (x1 - x0), (cv.height - 2 * pad) / (y1 - y0));
  const ox = (cv.width - s * (x1 - x0)) / 2 - s * x0, oy = (cv.height - s * (y1 - y0)) / 2 - s * y0;
  const paint = (list: { pts: [number, number][]; clear: boolean }[], fill: string): void => {
    g.fillStyle = fill;
    for (const { pts, clear } of list) {
      g.globalCompositeOperation = clear ? "destination-out" : "source-over";
      g.beginPath();
      for (let i = 0; i < pts.length; i++) { const x = ox + s * pts[i][0], y = oy + s * pts[i][1]; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation = "source-over";
  };
  paint(polysOf.get(layer) || [], color);
  // the outline under every other layer, so a silkscreen or a paste layer reads against the board
  if (layer !== "Edge.Cuts" && polysOf.has("Edge.Cuts")) { g.globalAlpha = 0.45; paint(polysOf.get("Edge.Cuts") || [], getComputedStyle(cv).color); g.globalAlpha = 1; }
}

/** File → Fabrication Outputs → Gerbers / Drill Files / Component Placement / Bill of Materials. */
export function openFabOutputs(focus: FabFocus = "gerber"): void {
  if (!boardDoc()) { toast("Fabrication outputs are made from a board: open the PCB editor first"); return; }
  Promise.all([loadFab(), fabContext()]).then(([fab, ctx]) => { if (ctx) show(fab, ctx, focus); })
    .catch((e: unknown) => { console.warn(e); toast("The fabrication output writers could not be loaded"); });
}

function show(fab: KiCadFabApi, ctx: FabContext, focus: FabFocus): void {
  ensureCss();
  const doc = ctx.doc; const all = fab.plottableLayers(doc);
  const colors = new Map<string, string>(); for (const l of app.get().document.layers || []) colors.set(l.key, l.color);
  let pkg: FabPackage | null = null, selected = "", run = 0, timer = 0;
  let preset = fab.presetById(rememberedPreset());
  const copper = (doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]) as string[];
  let layers = new Set(preset.layers(all, copper));

  const presetField = selectField<string>(preset.id, fab.PRESETS.map((p) => [p.id, p.name] as [string, string]), { key: "fab-preset", onChange: (id) => { preset = fab.presetById(id); rememberPreset(id); applyPreset(); schedule(); } });
  const blurb = note(""), order = h("a", { class: "btn sm", target: "_blank", rel: "noopener" }, "Open the order page") as HTMLAnchorElement;
  const opt = {
    aux: checkField(false, "Use drill/place file origin", { key: "fab-aux", onChange: schedule, tip: "Coordinates are measured from the origin set with Place > Drill/Place File Origin" }),
    silk: checkField(false, "Subtract soldermask from silkscreen", { key: "fab-silk", onChange: schedule, tip: "Legend ink is removed where the solder mask is open, so no ink lands on a pad" }),
    tent: checkField(false, "Tent all vias", { key: "fab-tent", onChange: schedule, tip: "Cover every via with solder mask, whatever the board's own setting says" }),
    ref: checkField(true, "Plot reference designators", { key: "fab-ref", onChange: schedule }),
    val: checkField(true, "Plot footprint values", { key: "fab-val", onChange: schedule }),
    merge: checkField(false, "PTH and NPTH in a single drill file", { key: "fab-merge", onChange: schedule }),
    dnp: checkField(true, "Leave out parts marked Do not populate", { key: "fab-dnp", onChange: schedule }),
    place: checkField(true, "Component placement file", { key: "fab-place", onChange: schedule }),
    bom: checkField(true, "Bill of materials", { key: "fab-bom", onChange: schedule }),
  } satisfies Record<string, Field<boolean>>;
  const layerBox = h("div", { class: "fab-layers" });
  const files = h("div", { class: "pd-list fab-files" });
  const view = h("div", { class: "fab-view" });
  const summary = h("div", { class: "fab-sum" });
  const report = reportPanel("92px");

  function drawLayerList(): void {
    layerBox.replaceChildren();
    for (const l of all) {
      const cb = h("input", { type: "checkbox" }) as HTMLInputElement; cb.checked = layers.has(l); cb.dataset.layer = l;
      cb.addEventListener("change", () => { if (cb.checked) layers.add(l); else layers.delete(l); schedule(); });
      const sw = h("i"); sw.style.background = colors.get(l) || "var(--ink-2)";
      layerBox.append(h("label", null, cb, sw, fab.layerDisplayName(doc, l)));
    }
  }
  function applyPreset(): void {
    layers = new Set(preset.layers(all, copper));
    opt.aux.set(preset.useAuxOrigin); opt.silk.set(preset.subtractMaskFromSilk); opt.ref.set(preset.plotReference); opt.val.set(preset.plotValue);
    opt.merge.set(preset.drill.merge); opt.dnp.set(preset.excludeDnp); opt.tent.set(false);
    blurb.textContent = preset.blurb;
    order.style.display = preset.orderUrl ? "" : "none"; if (preset.orderUrl) order.href = preset.orderUrl;
    drawLayerList();
  }
  function options(): PackageOptions {
    return { preset: preset.id, layers: all.filter((l) => layers.has(l)), useAuxOrigin: opt.aux.get(), subtractMaskFromSilk: opt.silk.get(), plotReference: opt.ref.get(), plotValue: opt.val.get(),
      forceTentVias: opt.tent.get() ? true : undefined, mergeDrill: opt.merge.get(), excludeDnp: opt.dnp.get(), includeBom: opt.bom.get(), includePlacement: opt.place.get() };
  }
  function schedule(): void { window.clearTimeout(timer); timer = window.setTimeout(() => { void generate(); }, 120); }

  async function generate(): Promise<void> {
    const mine = ++run;
    view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spinner" }), "Generating the files"));
    await new Promise((r) => setTimeout(r, 0));   // let the spinner paint before the plot holds the thread
    let made: FabPackage;
    try { made = await fab.buildPackage(ctx, options()); }
    catch (e) { if (mine !== run) return; pkg = null; files.replaceChildren(); view.replaceChildren(h("div", { class: "empty" }, "The files could not be generated")); report.set([{ severity: "error", text: String((e as Error).message || e) }]); console.warn(e); return; }
    if (mine !== run) return;
    pkg = made;
    if (!pkg.files.some((f) => f.name === selected)) { const first = pkg.files.find((f) => f.kind === focus) || pkg.files[0]; selected = first ? first.name : ""; }
    drawFiles(); drawView();
    const s = pkg.summary;
    summary.textContent = `${s.width.toFixed(2)} × ${s.height.toFixed(2)} mm, ${s.copperLayers} copper layer${s.copperLayers === 1 ? "" : "s"}, ${s.holes} hole${s.holes === 1 ? "" : "s"}${s.slots ? ` (${s.slots} slot${s.slots === 1 ? "" : "s"})` : ""}, ${s.placed} of ${s.parts} part${s.parts === 1 ? "" : "s"} placed, ${s.bomLines} BOM line${s.bomLines === 1 ? "" : "s"}`;
    const lines: ReportLine[] = pkg.warnings.map((text) => ({ severity: "warning", text }));
    if (!lines.length) lines.push({ severity: "info", text: "No problems found. Check the layers in the list above before ordering, as you would in a Gerber viewer." });
    report.set(lines);
  }
  function drawFiles(): void {
    files.replaceChildren();
    if (!pkg) return;
    for (const f of pkg.files) {
      const it = h("div", { class: "it" + (f.name === selected ? " sel" : "") },
        h("span", { class: "pill" }, KIND_LABEL[f.kind]), h("span", { class: "nm", title: f.name }, f.name),
        h("span", { class: "meta" }, f.note ? f.note + ", " + size(f.data) : size(f.data)));
      it.dataset.file = f.name;
      const save = h("button", { type: "button", class: "btn sm", title: "Download this file" }, "Save");
      save.addEventListener("click", (ev) => { ev.stopPropagation(); download(blobOf(f.data, "text/plain"), f.name); });
      it.append(save);
      it.addEventListener("click", () => { selected = f.name; drawFiles(); drawView(); });
      files.append(it);
    }
  }
  function drawView(): void {
    view.replaceChildren();
    const f = pkg && pkg.files.find((x) => x.name === selected);
    if (!pkg || !f) { view.append(h("div", { class: "empty" }, "No file selected")); return; }
    if (f.kind === "gerber" && f.layer) {
      const cv = h("canvas"); view.append(cv); cv.dataset.layer = f.layer;
      drawLayer(cv, fab, pkg, f.layer, colors.get(f.layer) || getComputedStyle(view).color);
    } else view.append(h("pre", null, typeof f.data === "string" ? f.data : ""));
  }

  openDialog({ title: "Fabrication Outputs", width: 1000, height: 680, okLabel: "Download ZIP", cancelLabel: "Close", noEnter: true,
    build(body) {
      applyPreset();
      const side = h("div", { class: "fab-side" },
        box("Manufacturer", presetField.el, blurb, order),
        box("Gerber options", opt.aux.el, opt.silk.el, opt.tent.el, opt.ref.el, opt.val.el),
        box("Drill, placement and BOM", opt.merge.el, opt.place.el, opt.bom.el, opt.dnp.el),
        box("Layers", layerBox));
      const main = h("div", { class: "fab-main" }, files, view, summary, report.el);
      body.append(h("div", { class: "fab-cols" }, side, main));
      void generate();
    },
    ok() {
      if (!pkg) return false;
      const p = pkg;
      void fab.packageZip(p).then((z) => { download(new Blob([z.data as BlobPart], { type: "application/zip" }), z.name); toast("Saved " + z.name); });
      return false;
    } });
}
