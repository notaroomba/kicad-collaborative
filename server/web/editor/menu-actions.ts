// menu-actions.ts — the menu-bar commands that are trivial in a browser, registered into HANDLERS
// (editor/actions.ts) under KiCad's action ids so the menu entries, toolbar buttons and hotkeys light up:
//
//   File     Save a Copy / Save Current Sheet Copy As (download the document), Export > Netlist and
//            Drawing to Clipboard (File > Plot is pcbdialogs/plot.ts and dialogs/plot-schematic.ts)
//   Edit     Properties, Move / Drag (schematic)
//   View     Zoom to Selected Objects, zoom at cursor, centre on cursor, pan, grid next / previous,
//            units (remembered), reset local coordinates, Show Hidden Fields, sheet navigation
//   Route    layer switching (board)
//   Help     List Hotkeys, About (help-dialogs.ts)
import type { ActionHandler } from "./types";
import { cursorStep, panStep } from "./crosshair";
import { gridIndex, gridList, navigateDocs, openDoc, rootSchematic, setActiveLayer, setGridIndex } from "./doc";
import { HANDLERS, toggleRenderOpt } from "./actions";
import { setToggle, state, store } from "./appstore";
import { openAbout, openHotkeyList } from "./help-dialogs";
import { setCrosshair, setUnitsAction } from "./panes";
import { cycleInactiveMode, layerAlphaStep, toggleInactiveMode } from "./panels/appearance";
import { openSelectionProperties } from "./pointer";
import { E } from "./state";
import { startMove } from "./gestures";
import { schKey } from "./tools";
import { esc, toast } from "./util";
import { applyView, fitBox, isSch, mmW, mmX0, mmY0, requestRender, stage, world, zoomBy, zoomStep } from "./view";
import { fitMargin } from "./zoomlist";

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
export function fileStem(): { name: string; stem: string } {
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
  const out: string[] = ['(export (version "E")', "  (design", `    (source ${q(source)})`, `    (date ${q(new Date().toISOString().slice(0, 19))})`, '    (tool "Junction web editor"))', "  (components"];
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

/** File > Export > Drawing to Clipboard: the sheet as a PNG image on the system clipboard. */
async function drawingToClipboard(): Promise<void> {
  if (!E.kdoc) return;
  try {
    const blob = await W.KiCadCanvas.renderPng(E.kdoc, Object.assign({}, E.renderOpts, { dpi: 200, hidden: E.hiddenLayers }));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Drawing copied to the clipboard");
  } catch (e) { toast("Couldn't copy the drawing: " + (e as Error).message, 4000); }
}

interface LayerRow { key: string; name: string; color: string }
// ---------------------------------------------------------------- view
/** The cursor's position in stage pixels (zoom-at-cursor and centre-on-cursor work from it). */
function cursorPx(): [number, number] {
  const r = world.getBoundingClientRect(), s = stage.getBoundingClientRect(); const mm = E.lastCursorMm as number[];
  return [r.left - s.left + ((mm[0] - mmX0()) / mmW()) * r.width, r.top - s.top + ((mm[1] - mmY0()) / mmW()) * r.width];
}
function zoomAtCursor(zoomIn: boolean): void { const [x, y] = cursorPx(); zoomStep(zoomIn, x, y); }   // doZoomInOut( dir, aCenterOnCursor ); the browser cannot warp the mouse, so the cursor point stays put
function centreOnCursor(): void { const [x, y] = cursorPx(); E.viewTouched = true; E.panX += stage.clientWidth / 2 - x; E.panY += stage.clientHeight / 2 - y; applyView(); }
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
  E.viewTouched = true; fitBox([x0, y0, Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3)], fitMargin(stage.clientHeight, false));
}

/** COMMON_TOOLS::GridNext / GridPrev (N, Shift+N): the next or previous grid of the list, wrapping round. */
function stepGrid(dir: number): void {
  const n = gridList().length; if (!n) return;
  const i = gridIndex(); setGridIndex(i < 0 ? 0 : (i + dir + n) % n);
}

const UNIT_ACTION: Record<string, string> = { mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" };
function setUnits(u: "mm" | "in" | "mil"): void { setUnitsAction(u, UNIT_ACTION[u]); }
/** Ctrl+U (ACTIONS::toggleUnits, COMMON_TOOLS::ToggleUnits): between millimetres and the imperial unit last used. */
function toggleUnits(): void { setUnits(E.units === "mm" ? (E.lastImperial || "mil") : "mm"); }

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

export const MENU_HANDLERS: Record<string, ActionHandler> = {
  saveCopy: () => saveDocCopy(), saveCurrSheetCopyAs: () => saveDocCopy(),
  exportNetlist: () => exportNetlist(), drawSheetOnClipboard: () => drawingToClipboard(),
  properties: () => { openSelectionProperties(); },
  zoomFitSelection, zoomIn: () => zoomAtCursor(true), zoomOut: () => zoomAtCursor(false), zoomCenter: centreOnCursor,
  panUp: () => panStep(0, 1), panDown: () => panStep(0, -1), panLeft: () => panStep(1, 0), panRight: () => panStep(-1, 0),
  cursorUp: () => cursorStep(0, -1, 1), cursorDown: () => cursorStep(0, 1, 1), cursorLeft: () => cursorStep(-1, 0, 1), cursorRight: () => cursorStep(1, 0, 1),
  cursorUpFast: () => cursorStep(0, -1, 10), cursorDownFast: () => cursorStep(0, 1, 10), cursorLeftFast: () => cursorStep(-1, 0, 10), cursorRightFast: () => cursorStep(1, 0, 10),
  gridNext: () => stepGrid(1), gridPrev: () => stepGrid(-1),
  millimetersUnits: () => setUnits("mm"), inchesUnits: () => setUnits("in"), milsUnits: () => setUnits("mil"), toggleUnits,
  resetLocalCoords,
  // the menu entry is a checkbox: a second click goes back to the small crosshairs
  cursorFullCrosshairs: () => (E.crosshairMode === "full" ? setCrosshair("small", "cursorSmallCrosshairs") : setCrosshair("full", "cursorFullCrosshairs")),
  // eeschema's Show Hidden Fields and pcbnew's Show Hidden Text are separate settings
  toggleHiddenFields: () => toggleRenderOpt("showHiddenFields", "toggleHiddenFields"),
  showHiddenText: () => toggleRenderOpt("showHiddenText", "showHiddenText"),
  // eeschema's View options (EESCHEMA_SETTINGS appearance), each a render option of the schematic painter
  toggleDirectiveLabels: () => schView("showDirectiveLabels", "toggleDirectiveLabels"),
  markSimExclusions: () => schView("markSimExclusions", "markSimExclusions"),
  toggleERCErrors: () => schView("showErcErrors", "toggleERCErrors"),
  toggleERCWarnings: () => schView("showErcWarnings", "toggleERCWarnings"),
  toggleERCExclusions: () => schView("showErcExclusions", "toggleERCExclusions", false),
  // no simulation results are kept here, so the operating-point labels have nothing to show either way
  toggleOPVoltages: () => schView("showOpVoltages", "toggleOPVoltages"),
  toggleOPCurrents: () => schView("showOpCurrents", "toggleOPCurrents"),
  togglePinAltIcons: () => {
    const on = !(E.renderOpts.showPinAltIcons !== false); E.renderOpts.showPinAltIcons = on; setToggle("togglePinAltIcons", on);
    KiCadCanvas.setSchDisplay({ pinAltIcons: on }, E.kdoc && isSch() ? E.kdoc : null); E.renderFull = true; requestRender();
  },
  highContrastModeCycle: () => { if (isSch()) return; cycleInactiveMode(); },
  highContrastMode: () => { if (isSch()) toggleRenderOpt("highContrast", "highContrastMode"); else toggleInactiveMode(); },
  layerAlphaInc: () => { if (!isSch()) layerAlphaStep(1); }, layerAlphaDec: () => { if (!isSch()) layerAlphaStep(-1); },
  navigatePrevious: () => stepSheet(-1), navigateNext: () => stepSheet(1), leaveSheet,
  layerNext: () => stepLayer(1), layerPrev: () => stepLayer(-1), layerTop: () => copperLayer("F.Cu"), layerBottom: () => copperLayer("B.Cu"),
  listHotKeys: () => openHotkeyList(), about: () => openAbout(),
  languageEnglish: () => {},
};
Object.assign(HANDLERS, MENU_HANDLERS, {
  // schematic only (tables.ts EDITOR_ONLY): Move / Drag start the module's connected drag exactly as its M / G keys do
  move: () => { startMove("move"); },
  drag: () => { startMove("drag"); },
});
setToggle("languageEnglish", true);
/** A schematic View option held in the render options; `dflt` is KiCad's default (EESCHEMA_SETTINGS). */
function schView(key: string, id: string, dflt = true): void {
  const on = !(E.renderOpts[key] === undefined ? dflt : !!E.renderOpts[key]);
  E.renderOpts[key] = on; setToggle(id, on); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender();
}
for (const id of ["toggleDirectiveLabels", "markSimExclusions", "toggleERCErrors", "toggleERCWarnings", "toggleOPVoltages", "toggleOPCurrents", "togglePinAltIcons"]) setToggle(id, true);
setToggle("toggleERCExclusions", false);

/** Exposed for the chrome (window.CollabApp.selectionCount) so menus can grey out what needs a selection. */
export function selectionCount(): number { return E.kdoc ? selectionKeys().length : 0; }
/** Everything selected, pads included: the item ids of selectedIds() plus the board's picked pads as
 *  "footprintId#padIndex" (PCB_PAD_T in KiCad's selection).  Also window.CollabEditor.hooks.selectionKeys(). */
export function selectionKeys(): string[] {
  const ids = selectedIds(); if (isSch()) return ids;
  const P = W.CollabTools && W.CollabTools.pcb; const pads: string[] = P && P.selectedPadKeys ? P.selectedPadKeys() : [];
  return [...ids, ...pads.filter((k) => !ids.includes(k))];
}
E.hooks.selectionKeys = selectionKeys;
