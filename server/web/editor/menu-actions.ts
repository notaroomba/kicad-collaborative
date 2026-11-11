// menu-actions.ts — the menu-bar commands that are trivial in a browser, registered into HANDLERS
// (editor/actions.ts) under KiCad's action ids so the menu entries, toolbar buttons and hotkeys light up:
//
//   File     Save a Copy / Save Current Sheet Copy As (download the document), Export > Netlist and
//            Drawing to Clipboard, Plot (SVG / PNG / PDF of the whole sheet or board, with the layer list)
//   Edit     Properties, Move / Drag (schematic)
//   View     Zoom to Selected Objects, zoom at cursor, centre on cursor, pan, grid next / previous,
//            units (remembered), reset local coordinates, Show Hidden Fields, sheet navigation
//   Route    layer switching (board)
//   Help     List Hotkeys, About (help-dialogs.ts)
import { GRID_CHOICES, navigateDocs, openDoc, rootSchematic, setActiveLayer, setGridPitch } from "./doc";
import { HANDLERS, gridMenu, toggleRenderOpt } from "./actions";
import { setToggle, state, store } from "./appstore";
import { openAbout, openHotkeyList } from "./help-dialogs";
import { setCrosshair, setUnitsAction } from "./panes";
import { openSelectionProperties } from "./pointer";
import { E } from "./state";
import { schKey } from "./tools";
import { esc, toast } from "./util";
import { applyView, fitBox, isSch, mmW, mmX0, mmY0, stage, world, zoomBy } from "./view";

type Sx = (string | number | Sx)[];
interface DocEntry { docId: string; path: string; docType: string }
interface Item { id: string; kind: string; node: Sx; bbox: number[] | null; ref?: string }
interface Canvas {
  renderSvg(doc: unknown, opts: Record<string, unknown>): string;
  renderPng(doc: unknown, opts: Record<string, unknown>): Promise<Blob>;
  kid(n: Sx, k: string): Sx | null; kids(n: Sx, k: string): Sx[]; str(v: unknown): string;
}
interface Dialogs { open(spec: { title: string; width?: number; build(body: HTMLElement): void; okLabel?: string; ok?(): boolean | void }): void }
const W = window as unknown as { KiCadCanvas: Canvas; KDialogs?: Dialogs; CollabTools: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
const st = state as unknown as { docs?: DocEntry[]; docId?: string | null; project?: { name?: string } | null };

// ---------------------------------------------------------------- files
function currentDoc(): DocEntry | null { return (st.docs || []).find((d) => d.docId === st.docId) || null; }
function fileStem(): { name: string; stem: string } {
  const d = currentDoc(); const name = d ? d.path.split("/").pop() || d.path : (isSch() ? "sheet.kicad_sch" : "board.kicad_pcb");
  return { name, stem: name.replace(/\.kicad_(sch|pcb)$/, "") };
}
export function download(data: Blob | string, name: string, type = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = "none";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** File > Save a Copy... / Save Current Sheet Copy As...: the document as the server holds it, every edit applied. */
async function saveDocCopy(): Promise<void> {
  const d = currentDoc(); if (!d) { toast("No document open"); return; }
  try {
    const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`);
    if (!r.ok) throw new Error(String(r.status));
    const { name } = fileStem();
    download(await r.text(), name); toast("Saved a copy as " + name);
  } catch (e) { toast("Save failed: " + (e as Error).message, 4000); }
}

// ---------------------------------------------------------------- netlist (eeschema/netlist_exporters/netlist_exporter_kicad.cpp)
const q = (s: unknown) => '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/**
 * The open sheet's netlist in KiCad's s-expression format (export (version "E") (design …) (components …) (nets …)),
 * from the tool module's net computation (sch-tools ercNets).  Net names follow CONNECTION_GRAPH: a global label or
 * power symbol, else a hierarchical or local label ("/NAME"), else "Net-(REF-PIN)"; a single unlabelled pin is
 * "unconnected-(REF-PIN-PadN)".  Sub-sheets are not flattened: this is the sheet that is open.
 */
export function netlistText(doc: { items: Map<string, Item> }, source: string): string | null {
  const K = W.KiCadCanvas, sch = W.CollabTools && W.CollabTools.sch;
  if (!sch || !sch._ || !sch._.ercNets) return null;
  const prop = (n: Sx, name: string) => { const p = K.kids(n, "property").find((x) => K.str(x[1]) === name); return p ? K.str(p[2]) : ""; };
  const comps: { ref: string; item: Item }[] = [];
  const seen = new Set<string>();
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const ref = prop(it.node, "Reference"); if (!ref || ref.startsWith("#") || seen.has(ref)) continue;   // power symbols and flags are not components
    const ob = K.kid(it.node, "on_board"); if (ob && K.str(ob[1]) === "no") continue;
    seen.add(ref); comps.push({ ref, item: it });
  }
  const refKey = (r: string) => { const m = /^(.*?)(\d+)$/.exec(r); return m ? [m[1], +m[2]] as const : [r, 0] as const; };
  const byRef = (a: string, b: string) => { const x = refKey(a), y = refKey(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; };
  comps.sort((a, b) => byRef(a.ref, b.ref));
  const out: string[] = ['(export (version "E")', "  (design", `    (source ${q(source)})`, `    (date ${q(new Date().toISOString().slice(0, 19))})`, '    (tool "KiCad Collaborative web editor"))', "  (components"];
  for (const c of comps) {
    const n = c.item.node, lib = K.str((K.kid(n, "lib_id") || [])[1]), [libName, part] = lib.includes(":") ? [lib.slice(0, lib.indexOf(":")), lib.slice(lib.indexOf(":") + 1)] : ["", lib];
    const uuid = K.str((K.kid(n, "uuid") || [])[1]);
    out.push(`    (comp (ref ${q(c.ref)})`, `      (value ${q(prop(n, "Value"))})`);
    if (prop(n, "Footprint")) out.push(`      (footprint ${q(prop(n, "Footprint"))})`);
    if (prop(n, "Datasheet") && prop(n, "Datasheet") !== "~") out.push(`      (datasheet ${q(prop(n, "Datasheet"))})`);
    if (prop(n, "Description")) out.push(`      (description ${q(prop(n, "Description"))})`);
    out.push(`      (libsource (lib ${q(libName)}) (part ${q(part)}) (description ${q(prop(n, "Description"))}))`, '      (sheetpath (names "/") (tstamps "/"))', `      (tstamps ${q(uuid)}))`);
  }
  out.push("  )", "  (nets");
  interface Term { item: Item; pin?: { number: string; name: string; type: string }; key?: string; power?: boolean }
  const nets: { name: string; nodes: { ref: string; pin: string; fn: string; type: string }[] }[] = [];
  const { nets: raw } = sch._.ercNets(doc) as { nets: { terms: Term[] }[] };
  for (const net of raw) {
    const nodes: { ref: string; pin: string; fn: string; type: string }[] = []; const dup = new Set<string>();
    for (const t of net.terms) {
      if (!t.pin || t.power || t.item.kind !== "symbol") continue;
      const ref = prop(t.item.node, "Reference"); if (!seen.has(ref)) continue;
      const k = ref + "\u0000" + t.pin.number; if (dup.has(k)) continue; dup.add(k);
      nodes.push({ ref, pin: t.pin.number, fn: t.pin.name && t.pin.name !== "~" ? t.pin.name : "", type: t.pin.type });
    }
    if (!nodes.length) continue;
    nodes.sort((a, b) => byRef(a.ref, b.ref) || (a.pin < b.pin ? -1 : a.pin > b.pin ? 1 : 0));
    const keys = net.terms.map((t) => t.key).filter((k): k is string => !!k);
    const pick = (p: string) => keys.filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)).sort()[0];
    const g = pick("global:"), h = pick("hier:"), l = pick("local:"), first = nodes[0];
    const name = g !== undefined ? g : h !== undefined ? "/" + h : l !== undefined ? "/" + l
      : nodes.length === 1 ? `unconnected-(${first.ref}-${first.fn ? first.fn + "-" : ""}Pad${first.pin})` : `Net-(${first.ref}-${first.fn || "Pad" + first.pin})`;
    nets.push({ name, nodes });
  }
  nets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  nets.forEach((net, i) => {
    out.push(`    (net (code ${q(i + 1)}) (name ${q(net.name)})`);
    net.nodes.forEach((nd, j) => out.push(`      (node (ref ${q(nd.ref)}) (pin ${q(nd.pin)})${nd.fn ? ` (pinfunction ${q(nd.fn)})` : ""} (pintype ${q(nd.type)}))${j === net.nodes.length - 1 ? ")" : ""}`));
  });
  out.push("  ))", "");
  return out.join("\n");
}

function exportNetlist(): void {
  if (!E.kdoc || !isSch()) return;
  const { name, stem } = fileStem();
  let text: string | null = null;
  try { text = netlistText(E.kdoc, name); } catch (e) { console.warn(e); }
  if (!text) { toast("Netlist export failed"); return; }
  download(text, stem + ".net"); toast("Exported " + stem + ".net (this sheet)");
}

// ---------------------------------------------------------------- plot
/** A one-page PDF holding a JPEG (DCTDecode) at the given physical size. */
export function pdfFromJpeg(jpeg: Uint8Array, wPx: number, hPx: number, wMm: number, hMm: number): Blob {
  const pt = (mm: number) => (mm * 72 / 25.4).toFixed(2);
  const enc = new TextEncoder(); const parts: Uint8Array[] = []; const offsets: number[] = []; let len = 0;
  const push = (d: Uint8Array | string) => { const b = typeof d === "string" ? enc.encode(d) : d; parts.push(b); len += b.length; };
  const obj = (n: number, body: string) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };
  push("%PDF-1.4\n%âãÏÓ\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(wMm)} ${pt(hMm)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len; push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); push("\nendstream\nendobj\n");
  const content = `q ${pt(wMm)} 0 0 ${pt(hMm)} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

interface LayerRow { key: string; name: string; color: string }
/** File > Plot: the whole sheet / board (or the selection) as SVG, PNG or PDF, with KiCad's "Include Layers" list on a board. */
export function plotDialog(): void {
  const K = W.KiCadCanvas, D = W.KDialogs;
  if (!E.kdoc || !D) return;
  const sch = isSch(); const { stem } = fileStem();
  const layers = (store.get().document.layers || []) as LayerRow[];
  D.open({ title: "Plot", width: sch ? 460 : 620,
    build(body) {
      const layerList = sch ? "" : `<div><h3>Include Layers</h3><div id="kd-layers" style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);padding:4px 6px;background:var(--panel)">
        ${layers.map((l) => `<label style="display:flex;gap:6px;align-items:center;padding:1px 0;color:var(--ink)"><input type="checkbox" data-layer="${esc(l.key)}" style="width:auto;margin:0"${E.hiddenLayers.has(l.key) ? "" : " checked"}><i style="width:10px;height:10px;border-radius:var(--r-1);display:inline-block;background:${esc(l.color)}"></i>${esc(l.name)}</label>`).join("")}</div>
        <div class="actions" style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn sm" id="kd-all">Select All</button><button type="button" class="btn sm" id="kd-none">Deselect All</button></div></div>`;
      const check = (id: string, label: string, on: boolean, off?: boolean) => `<label></label><label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="${id}" type="checkbox" style="width:auto;margin:0"${on ? " checked" : ""}${off ? " disabled" : ""}> ${label}</label>`;
      body.innerHTML = `<div style="display:grid;grid-template-columns:${sch ? "1fr" : "220px 1fr"};gap:6px 18px">${layerList}<div><h3>${sch ? "Options" : "General Options"}</h3><div class="kv">
        <label>Plot format</label><select id="kd-fmt"><option value="svg">SVG</option><option value="pdf">PDF</option><option value="png">PNG</option></select>
        <label>Content</label><select id="kd-scope"><option value="all">${sch ? "Whole sheet" : "Whole board"}</option>${sch ? "" : '<option value="page">Whole page</option>'}<option value="sel"${E.selection.size ? "" : " disabled"}>Selection only</option></select>
        <label>Resolution (PNG, PDF)</label><input id="kd-dpi" type="number" value="${sch ? 300 : 600}" min="72" max="2400" step="1">
        ${check("kd-frame", "Plot drawing sheet", sch)}
        ${check("kd-bg", sch ? "Plot background color" : "Plot background color", false)}
        ${sch ? check("kd-hid", "Show hidden pins", !!E.renderOpts.showHiddenPins) : ""}</div>
        <p class="kd-note" style="margin-top:10px">Output: ${esc(stem)}.svg / .pdf / .png, downloaded by the browser.</p></div></div>`;
      const boxes = () => Array.from(body.querySelectorAll<HTMLInputElement>("[data-layer]"));
      const all = body.querySelector("#kd-all"), none = body.querySelector("#kd-none");
      if (all) all.addEventListener("click", () => boxes().forEach((b) => { b.checked = true; }));
      if (none) none.addEventListener("click", () => boxes().forEach((b) => { b.checked = false; }));
    },
    okLabel: "Plot",
    ok() {
      const g = <T extends HTMLElement>(id: string) => document.querySelector<T>("#" + id);
      const fmt = g<HTMLSelectElement>("kd-fmt")!.value, scope = g<HTMLSelectElement>("kd-scope")!.value;
      const dpi = Math.max(72, Math.min(2400, +g<HTMLInputElement>("kd-dpi")!.value || 300));
      const withBg = g<HTMLInputElement>("kd-bg")!.checked, frame = g<HTMLInputElement>("kd-frame")!.checked;
      const hidden = sch ? new Set(E.hiddenLayers) : new Set(Array.from(document.querySelectorAll<HTMLInputElement>("#kd-layers [data-layer]")).filter((b) => !b.checked).map((b) => b.dataset.layer || ""));
      if (!sch && hidden.size >= layers.length) { toast("Select at least one layer to plot"); return false; }
      const hid = g<HTMLInputElement>("kd-hid");
      const opts: Record<string, unknown> = { hidden, showHiddenPins: !!(hid && hid.checked), zoneOutline: !!E.renderOpts.zoneOutline };
      if (scope === "sel" && E.selection.size) opts.ids = [...E.selection];
      else if (scope === "page" || (sch && scope === "all")) { opts.bbox = [0, 0, E.kdoc.page[0], E.kdoc.page[1]]; opts.margin = 0; }
      opts.frame = frame && scope !== "sel";
      const page = E.kdoc.page as number[], box = E.kdoc.bbox as number[];
      // the physical size of the plotted area, for the PDF page
      const area = opts.ids ? null : opts.bbox ? [page[0], page[1]] : [box[2] - box[0] + 2, box[3] - box[1] + 2];
      try {
        if (fmt === "svg") {
          download(new Blob([K.renderSvg(E.kdoc, Object.assign({ background: withBg ? undefined : false }, opts))], { type: "image/svg+xml" }), stem + ".svg");
          toast("Plotted " + stem + ".svg");
        } else if (fmt === "png") {
          toast("Rendering PNG…");
          K.renderPng(E.kdoc, Object.assign({}, E.renderOpts, { dpi, background: withBg ? undefined : false }, opts)).then((blob) => { download(blob, stem + ".png"); toast("Plotted " + stem + ".png"); })
            .catch((e: Error) => { console.warn(e); toast("Plot failed: " + e.message, 4000); });
        } else {
          toast("Rendering PDF…");
          // a PDF page is opaque: paper white unless the editor background is asked for
          K.renderPng(E.kdoc, Object.assign({}, E.renderOpts, { dpi, background: withBg ? undefined : "#ffffff", type: "image/jpeg", quality: 0.92 }, opts)).then(async (blob) => {
            const bmp = await createImageBitmap(blob); const wPx = bmp.width, hPx = bmp.height; bmp.close();
            const wMm = area ? area[0] : wPx / dpi * 25.4, hMm = area ? area[1] : hPx / dpi * 25.4;
            download(pdfFromJpeg(new Uint8Array(await blob.arrayBuffer()), wPx, hPx, wMm, hMm), stem + ".pdf"); toast("Plotted " + stem + ".pdf");
          }).catch((e: Error) => { console.warn(e); toast("Plot failed: " + e.message, 4000); });
        }
      } catch (e) { console.warn(e); toast("Plot failed: " + (e as Error).message, 4000); }
      return undefined;
    } });
}

/** File > Export > Drawing to Clipboard: the sheet as a PNG image on the system clipboard. */
async function drawingToClipboard(): Promise<void> {
  if (!E.kdoc) return;
  try {
    const blob = await W.KiCadCanvas.renderPng(E.kdoc, Object.assign({}, E.renderOpts, { dpi: 200, hidden: E.hiddenLayers }));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Drawing copied to the clipboard");
  } catch (e) { toast("Couldn't copy the drawing: " + (e as Error).message, 4000); }
}

// ---------------------------------------------------------------- view
/** The cursor's position in stage pixels (zoom-at-cursor and centre-on-cursor work from it). */
function cursorPx(): [number, number] {
  const r = world.getBoundingClientRect(), s = stage.getBoundingClientRect(); const mm = E.lastCursorMm as number[];
  return [r.left - s.left + ((mm[0] - mmX0()) / mmW()) * r.width, r.top - s.top + ((mm[1] - mmY0()) / mmW()) * r.width];
}
function zoomAtCursor(f: number): void { const [x, y] = cursorPx(); zoomBy(f, x, y); }
function centreOnCursor(): void { const [x, y] = cursorPx(); E.viewTouched = true; E.panX += stage.clientWidth / 2 - x; E.panY += stage.clientHeight / 2 - y; applyView(); }
function pan(dx: number, dy: number): void { E.viewTouched = true; E.panX += dx * stage.clientWidth * 0.1; E.panY += dy * stage.clientHeight * 0.1; applyView(); }

/** Ids of everything selected: the app's selection, a selected field's owner and the tool module's own pick. */
export function selectedIds(): string[] {
  const ids = new Set<string>(E.selection as Set<string>);
  if (E.selected) ids.add(E.selected.id);
  if (E.selField) ids.add(E.selField.id);
  const mod = W.CollabTools && (isSch() ? W.CollabTools.sch : W.CollabTools.pcb), sel = mod && mod.state && mod.state.sel;
  if (typeof sel === "string") ids.add(sel); else if (sel && typeof sel.forEach === "function") sel.forEach((id: string) => ids.add(id));
  return [...ids];
}
function zoomFitSelection(): void {
  if (!E.kdoc) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of selectedIds()) { const b = (E.kdoc.items.get(id) as Item | undefined)?.bbox; if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); } }
  if (x0 === Infinity) { toast("Nothing selected"); return; }
  E.viewTouched = true; fitBox([x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1)], 0.8);
}

function stepGrid(dir: number): void {
  const choices = ((GRID_CHOICES as unknown as Record<string, [number, string][]>)[E.DOC_TYPE] || []).map((c) => c[0]).sort((a, b) => b - a);   // coarse → fine, KiCad's list order
  if (!choices.length) return;
  let i = choices.indexOf(E.gridPitch); if (i < 0) i = 0;
  const next = choices[Math.min(choices.length - 1, Math.max(0, i + dir))];
  setGridPitch(next);
}

const UNIT_ACTION: Record<string, string> = { mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" };
function setUnits(u: "mm" | "in" | "mil"): void {
  if (u !== "mm") E.lastImperial = u;
  setUnitsAction(u, UNIT_ACTION[u]);
  try { localStorage.setItem("kui.units", u); } catch (e) { /* no storage */ }
}
/** Ctrl+U: between millimetres and the imperial unit last used (EDA_BASE_FRAME::ToggleUserUnits). */
function toggleUnits(): void { setUnits(E.units === "mm" ? (E.lastImperial || "mil") : "mm"); }
try { const u = localStorage.getItem("kui.units"); if (u === "in" || u === "mil" || u === "mm") { E.units = u; if (u !== "mm") E.lastImperial = u; } } catch (e) { /* no storage */ }

function resetLocalCoords(): void { E.localOrigin = (E.lastCursorMm as number[]).slice(); store.slice("viewport", { origin: E.localOrigin.slice() }); }

function stepSheet(dir: number): void {
  const sheets = (st.docs || []).filter((d) => d.docType === "kicad_sch"); if (sheets.length < 2) { toast("This schematic has one sheet"); return; }
  const i = sheets.findIndex((d) => d.docId === st.docId);
  openDoc(sheets[(i + dir + sheets.length) % sheets.length]);
}

function stepLayer(dir: number): void {
  const cu = (store.get().document.copperLayers || []) as LayerRow[]; if (!cu.length) return;
  const i = Math.max(0, cu.findIndex((l) => l.name === E.activeLayer));
  setActiveLayer(cu[(i + dir + cu.length) % cu.length].name);
}
function copperLayer(name: string): void { const cu = (store.get().document.copperLayers || []) as LayerRow[]; if (cu.some((l) => l.name === name)) setActiveLayer(name); }

const leaveSheet = () => { const r = rootSchematic(); if (r && (state as unknown as { doc?: unknown }).doc !== r) openDoc(r); else toast("Already at the root sheet"); };

export const MENU_HANDLERS: Record<string, (anchor?: unknown) => unknown> = {
  saveCopy: () => saveDocCopy(), saveCurrSheetCopyAs: () => saveDocCopy(),
  exportNetlist: () => exportNetlist(), drawSheetOnClipboard: () => drawingToClipboard(),
  plot: () => plotDialog(),
  properties: () => { if (!openSelectionProperties()) toast("Select an item first"); },
  zoomFitSelection, zoomIn: () => zoomAtCursor(1.25), zoomOut: () => zoomAtCursor(0.8), zoomCenter: centreOnCursor,
  panUp: () => pan(0, 1), panDown: () => pan(0, -1), panLeft: () => pan(1, 0), panRight: () => pan(-1, 0),
  gridNext: () => stepGrid(1), gridPrev: () => stepGrid(-1), gridProperties: (a) => gridMenu(a),
  millimetersUnits: () => setUnits("mm"), inchesUnits: () => setUnits("in"), milsUnits: () => setUnits("mil"), toggleUnits,
  resetLocalCoords,
  // the menu entry is a checkbox: a second click goes back to the small crosshairs
  cursorFullCrosshairs: () => (E.crosshairMode === "full" ? setCrosshair("small", "cursorSmallCrosshairs") : setCrosshair("full", "cursorFullCrosshairs")),
  toggleHiddenFields: () => { toggleRenderOpt("showHiddenText", "toggleHiddenFields"); setToggle("showHiddenText", !!E.renderOpts.showHiddenText); },
  showHiddenText: () => { toggleRenderOpt("showHiddenText", "showHiddenText"); setToggle("toggleHiddenFields", !!E.renderOpts.showHiddenText); },
  highContrastModeCycle: () => toggleRenderOpt("highContrast", "highContrastMode"),
  navigatePrevious: () => stepSheet(-1), navigateNext: () => stepSheet(1), leaveSheet,
  layerNext: () => stepLayer(1), layerPrev: () => stepLayer(-1), layerTop: () => copperLayer("F.Cu"), layerBottom: () => copperLayer("B.Cu"),
  listHotKeys: () => openHotkeyList(), about: () => openAbout(),
  languageEnglish: () => {},
};
Object.assign(HANDLERS, MENU_HANDLERS, {
  // schematic only (tables.ts EDITOR_ONLY): Move / Drag start the module's connected drag exactly as its M / G keys do
  move: () => { if (!schKey("m")) toast("Select an item first"); },
  drag: () => { if (!schKey("g")) toast("Select an item first"); },
});
setToggle("languageEnglish", true);

/** Exposed for the chrome (window.CollabApp.selectionCount) so menus can grey out what needs a selection. */
export function selectionCount(): number { return E.kdoc ? selectedIds().length : 0; }
