// editor/library.ts — KiCad library access for the web editor, published as window.KiCadLibrary.
//
// The Choose Symbol / Choose Footprint dialogs, the library browsers and the placement of what
// they return are built on this API; other modules (vendor part import) use the same calls.
//
//   KiCadLibrary.placeSymbol({ libId: "Lib:Name", symbol: "(symbol \"Name\" …)", fields?, unit? }): Promise<void>
//       `symbol` is a KiCad library symbol s-expression with its parents flattened (no "extends").
//       It is embedded in the sheet's lib_symbols under `libId` as KiCad does when a symbol is first
//       used (a copy the sheet already holds wins), and a new instance — reference prefix + "?",
//       the library's fields with `fields` ({ Value, Footprint, Datasheet, …any other name })
//       laid over them, a uuid per pin, the sheet's (instances …) path — rides on the cursor with
//       the Place Symbols tool until a click drops it.  Options `keep` / `allUnits` behave like the
//       dialog's "Place repeated copies" / "Place all units".
//   KiCadLibrary.placeFootprint({ fpid: "Lib:Name", footprint: "(footprint \"Name\" …)", fields? }): Promise<void>
//       `footprint` is .kicad_mod text.  A board footprint with fresh uuids and reference "REF**"
//       rides on the cursor (R rotates, F flips, Esc cancels) and lands on the active side.
//   KiCadLibrary.registerSource({ id, label, kinds: ["symbol", "footprint"],
//                                 search(query, kind): Promise<Array<{ id, name, description?, keywords?, library? }>>,
//                                 fetch(item, kind): Promise<{ libId | fpid, symbol | footprint, fields? }> }): void
//       The source appears as one more top-level group of the chooser dialogs; search() runs on
//       every filter change (also with an empty query) next to the official libraries, and choosing
//       one of its items calls fetch() and then the placement above.  unregisterSource(id) removes it.
//   KiCadLibrary.openChooser(kind: "symbol" | "footprint", opts?: { power?, browser?, title?, filter? }): Promise<chosen | null>
//       The dialog alone: resolves with { kind, item, libId | fpid, symbol | footprint, fields?, unit,
//       keep, allUnits } or null on Cancel, placing nothing.
//   KiCadLibrary.chooseAndPlace(kind, opts?)   the dialog followed by the placement (what the tools call)
//   KiCadLibrary.libraries(kind) / .index(kind, lib) / .fetch(kind, "Lib:Name")
//       The official libraries (server routes /api/libs/*): names + descriptions, one library's rows,
//       one item's s-expression (symbols flattened).
//   KiCadLibrary.core   the pure helpers (flattenSymbol, embedSymbol, symbolInstance, footprintInstance, …)
//
// The schematic tool module calls toolChooser() where it used to open its own picker and
// afterPlace() once a carried symbol is dropped; the board has no place tool of its own, so the
// footprint carry lives here and placeFootprint / the two browsers are published as module actions.
import { setCursorOverride } from "./cursors";
import { state } from "./appstore";
import { snapMm } from "./doc";
import { E } from "./state";
import { setTool, toolCtx } from "./tools";
import { toast } from "./util";
import { isSch, mmW, mmX0, mmY0, stage, worldMm } from "./view";
import { chooserOpen, closeChooser, openChooser } from "../library/chooser";
import type { ChooserOptions, Chosen } from "../library/chooser";
import * as core from "../library/core";
import { fetchItem, officialIndex, officialLibraries, projectFootprintByLibId, projectLibraries, registerSource, rememberRecent, unregisterSource } from "../library/sources";
import type { FetchedItem, LibItem, LibKind, LibrarySource, SourceContext } from "../library/sources";

export interface PlaceSymbolRequest { libId: string; symbol: string; fields?: Record<string, string>; unit?: number; keep?: boolean; allUnits?: boolean }
export interface PlaceFootprintRequest { fpid: string; footprint: string; fields?: Record<string, string> }

type Pt = [number, number];
interface SchCarry { kind: string; node: SNode; item: KItem | null; pos: Pt | null }
interface SchHelpers {
  placeCarry(ctx: ToolCtx, mm: Pt): void;
  autoplaceNode(doc: KDoc, item: KItem, opts?: unknown): SNode | null;
  sheetPathHere(doc: KDoc): { path: string | null; project: string | null };
}
interface PcbHelpers {
  addedChange(doc: KDoc, node: SNode): KChange;
  flipFootprintNode(node: SNode): SNode;
  rotateFootprintNode(node: SNode, deg: number): SNode;
}
type RenderFn = (doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>) => void;

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const ctxNow = (): ToolCtx => (toolCtx as unknown as () => ToolCtx)();
interface AppStateLike { docs?: { docId: string; path: string; docType: string }[]; project?: { name?: string; docs?: { docId: string; path: string; docType: string }[] } | null }
const appState = (): AppStateLike => state as unknown as AppStateLike;
// every document of the project (its .kicad_sym / .pretty libraries and fp-lib-table among them): appState().docs keeps
// only the schematics and boards the editor opens (bootpick.ts editorDocs)
const docsNow = (): { docId: string; path: string; docType: string }[] => { const s = appState(); return (s.project && s.project.docs) || s.docs || []; };
const sourceCtx = (): SourceContext => ({ docs: docsNow(), doc: (E.kdoc as KDoc | null) || null });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const cursorMm = (): Pt => { const c = (E.lastCursorMm as Pt) || [0, 0]; const s = snapMm([c[0], c[1]]) as Pt; return [s[0], s[1]]; };

// ---------------------------------------------------------------- schematic: a library symbol on the cursor

interface SymbolSession { libId: string; lib: SNode; fields?: Record<string, string>; unit: number; units: number; keep: boolean; allUnits: boolean; reference: string; nodeId: string; doc: KDoc }
let session: SymbolSession | null = null;

function schReady(): { ctx: ToolCtx; doc: KDoc; sch: SchToolModule; h: SchHelpers } {
  const ctx = ctxNow(), sch = window.CollabTools.sch;
  if (!ctx.doc || !isSch() || !sch) throw new Error("Open a schematic sheet to place a symbol");
  if (ctx.viewOnly) throw new Error("This sheet is read-only");
  return { ctx, doc: ctx.doc, sch, h: sch._ as unknown as SchHelpers };
}

/** Project name and sheet path for a new symbol's (instances …): what the sheet's other items say, else the file's own. */
function instanceHome(doc: KDoc, h: SchHelpers): { project: string; path: string } {
  let found: { path: string | null; project: string | null } = { path: null, project: null };
  try { found = h.sheetPathHere(doc); } catch { /* module without the helper */ }
  const pro = docsNow().find((d) => d.docType === "kicad_pro");
  const project = found.project || (pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : "") || String((appState().project || {}).name || "");
  const uuid = (doc as KDoc & { uuid?: string }).uuid;
  return { project, path: found.path || (uuid ? "/" + uuid : "") };
}

function carrySymbol(s: SymbolSession, sameReference: boolean): void {
  const { ctx, doc, sch, h } = schReady();
  const at = cursorMm();
  const used: string[] = [...((sch.state as { otherRefs?: Set<string> }).otherRefs || [])];   // the other sheets' references are taken too
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref) used.push(it.ref);
  if (!sameReference) s.reference = core.nextReference(core.symbolInfo(s.lib).reference, used, !!sch.state.annotateAuto);
  const home = instanceHome(doc, h);
  let node = core.symbolInstance({ libId: s.libId, symbol: s.lib, at, unit: s.unit, fields: s.fields, reference: s.reference, project: home.project, path: home.path });
  // SCH_DRAWING_TOOLS::PlaceSymbol autoplaces the fields of a new symbol
  try {
    const ghost = K().addItem(doc, node);
    if (ghost) { doc.items.delete(ghost.id); const placed = h.autoplaceNode(doc, ghost); if (placed) node = placed; }
  } catch (e) { console.warn("autoplace failed", e); }
  s.nodeId = K().uuidOf(node); s.doc = doc;
  const carry: SchCarry = { kind: "symbol", node, item: null, pos: null };
  (sch.state as Record<string, unknown>).carry = carry;                  // onActivate sees the carry and opens no chooser
  // the carry is set first so onActivate opens no chooser; the switch is ours, so the module's veto (a placement
  // in flight refuses another tool) does not apply to it
  if (E.tool !== "place" && E.tool !== "power") {
    const st = sch.state as Record<string, unknown>; const was = st.internalSwitch;
    st.internalSwitch = true;
    try { setTool("place"); } finally { st.internalSwitch = was; }
  }
  h.placeCarry(ctxNow(), at);
  ctx.requestRender();
}

/** Embed the symbol in the sheet's library and carry a new instance of it on the cursor. */
export async function placeSymbol(req: PlaceSymbolRequest): Promise<void> {
  const { doc } = schReady();
  if (!req || typeof req.libId !== "string" || !req.libId.includes(":")) throw new Error('placeSymbol needs libId "Library:Name"');
  if (typeof req.symbol !== "string" || !req.symbol.trim()) throw new Error("placeSymbol needs the symbol's s-expression");
  let lib = doc.lib.has(req.libId) ? K().resolveLib(doc, req.libId) : null;      // the sheet's own copy wins, as on paste
  if (!lib) { lib = core.embedSymbol(req.libId, core.flattenSymbol(core.symbolNodeOf(req.symbol, core.parseLibId(req.libId).name))); doc.lib.set(req.libId, lib); }
  const units = core.symbolInfo(lib).units;
  const unit = Math.min(units, Math.max(1, Math.round(req.unit || 1)));
  session = { libId: req.libId, lib, fields: req.fields, unit, units, keep: !!req.keep, allUnits: !!req.allUnits && units > 1, reference: "", nodeId: "", doc };
  carrySymbol(session, false);
}

/** sch-tools reports a dropped carry: the next unit, or the next copy, follows the cursor. */
function afterPlace(_ctx: ToolCtx, item: KItem | null): void {
  const s = session;
  if (!s || !item || item.id !== s.nodeId || E.kdoc !== s.doc) { session = null; return; }
  try {
    if (s.allUnits && s.unit < s.units) { s.unit++; carrySymbol(s, true); return; }
    if (s.keep) { if (s.allUnits) s.unit = 1; carrySymbol(s, false); return; }
  } catch (e) { toast(message(e), 3500); }
  session = null;
}

// ---------------------------------------------------------------- board: a library footprint on the cursor

interface FootprintCarry { node: SNode; ghost: KDoc; canvas: HTMLCanvasElement; raf: number; drawn: string; doc: KDoc; pos: Pt; resolve(): void }
let fpCarry: FootprintCarry | null = null;

const pcbHelpers = (): PcbHelpers | null => (window as unknown as { PcbTools?: PcbHelpers }).PcbTools || null;

/** The carried footprint as its own little board about the origin: the view is shifted instead of the item. */
function ghostBoard(node: SNode, main: KDoc): KDoc {
  const copy = (K().cloneNode as (n: SNode) => SNode)(node);
  const [, , rot] = K().atOf(copy);
  K().setAt(copy, 0, 0, rot);
  const ver = (main as KDoc & { version?: number }).version || 20260206;
  return K().parseDoc(`(kicad_pcb (version ${ver}) (generator "pcbnew") ${K().serialize(copy)})`);
}

function drawFootprintCarry(): void {
  const c = fpCarry; if (!c) return;
  if (E.kdoc !== c.doc || isSch()) { endFootprintCarry(); return; }
  c.raf = requestAnimationFrame(drawFootprintCarry);
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  const flip = !!(E.renderOpts && E.renderOpts.flip);
  const key = [w, h, dpr, E.zoom, E.panX, E.panY, mmX0(), mmY0(), mmW(), c.pos[0], c.pos[1], flip, K().serialize(K().kid(c.node, "at") || [])].join(",");
  if (key === c.drawn) return; c.drawn = key;
  if (c.canvas.width !== Math.round(w * dpr) || c.canvas.height !== Math.round(h * dpr)) { c.canvas.width = Math.round(w * dpr); c.canvas.height = Math.round(h * dpr); }
  const g = c.canvas.getContext("2d"); if (!g) return;
  const view: KView = { ppm: w / mmW(), zoom: E.zoom, panX: E.panX, panY: E.panY, x0: mmX0() - c.pos[0], y0: mmY0() - c.pos[1], dpr };
  if (flip && c.doc.bbox) { const cx = (c.doc.bbox[0] + c.doc.bbox[2]) / 2 - c.pos[0]; c.ghost.bbox = [cx, 0, cx, 0]; }   // mirror about the board's centre, not the ghost's
  g.save(); g.globalAlpha = 1;
  (K().render as unknown as RenderFn)(c.ghost, g, view, { background: false, frame: false, grid: 0, hidden: E.hiddenLayers, flip });
  g.restore();
}

function endFootprintCarry(): void {
  const c = fpCarry; if (!c) return; fpCarry = null;
  cancelAnimationFrame(c.raf); c.canvas.remove();
  window.removeEventListener("pointermove", onCarryMove, true); window.removeEventListener("pointerdown", onCarryDown, true); window.removeEventListener("keydown", onCarryKey, true);
  setCursorOverride(null);
  c.resolve();
}
const onStage = (ev: Event): boolean => ev.target instanceof Node && stage.contains(ev.target) && !(ev.target instanceof Element && ev.target.closest("input, select, k-select, textarea, button, .kd-overlay"));
function onCarryMove(ev: PointerEvent): void {
  const c = fpCarry; if (!c || !onStage(ev)) return;
  const p = snapMm(worldMm(ev)) as Pt; c.pos = [p[0], p[1]];
}
function onCarryDown(ev: PointerEvent): void {
  const c = fpCarry; if (!c || ev.button !== 0 || !onStage(ev)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  const p = snapMm(worldMm(ev)) as Pt; c.pos = [p[0], p[1]];
  const ctx = ctxNow(), P = pcbHelpers();
  const [, , rot] = K().atOf(c.node);
  K().setAt(c.node, +c.pos[0].toFixed(6), +c.pos[1].toFixed(6), rot);
  const node = c.node; endFootprintCarry();
  if (!ctx.doc || !P || ctx.viewOnly) return;
  const change = P.addedChange(ctx.doc, node);
  ctx.commit([change], "place footprint");
  ctx.setSelected({ id: change.id });
  ctx.requestRender();
}
function onCarryKey(ev: KeyboardEvent): void {
  const c = fpCarry; if (!c) return;
  const t = ev.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT")) return;
  const P = pcbHelpers(); let took = true;
  if (ev.key === "Escape") endFootprintCarry();
  else if ((ev.key === "r" || ev.key === "R") && !ev.ctrlKey && !ev.metaKey && P) { P.rotateFootprintNode(c.node, ev.shiftKey ? -90 : 90); c.ghost = ghostBoard(c.node, c.doc); c.drawn = ""; }
  else if ((ev.key === "f" || ev.key === "F") && !ev.ctrlKey && !ev.metaKey && P) { P.flipFootprintNode(c.node); c.ghost = ghostBoard(c.node, c.doc); c.drawn = ""; }
  else took = false;
  if (took) { ev.stopImmediatePropagation(); ev.preventDefault(); }
}

/** Carry a library footprint on the cursor; the click places it on the active side. */
export function placeFootprint(req: PlaceFootprintRequest): Promise<void> {
  const ctx = ctxNow(), P = pcbHelpers();
  if (!ctx.doc || isSch() || !P) return Promise.reject(new Error("Open a board to place a footprint"));
  if (ctx.viewOnly) return Promise.reject(new Error("This board is read-only"));
  if (!req || typeof req.fpid !== "string" || !req.fpid) return Promise.reject(new Error('placeFootprint needs fpid "Library:Name"'));
  if (typeof req.footprint !== "string" || !req.footprint.trim()) return Promise.reject(new Error("placeFootprint needs the footprint's .kicad_mod text"));
  endFootprintCarry();
  const pos = cursorMm();
  const node = core.footprintInstance({ fpid: req.fpid, footprint: req.footprint, at: pos, fields: req.fields });
  if (/^B\./.test(String(ctx.activeLayer || ""))) P.flipFootprintNode(node);          // the active side
  if (E.tool !== "select") setTool("select");
  const canvas = document.createElement("canvas");
  canvas.className = "klib-carry"; canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5";
  stage.appendChild(canvas); setCursorOverride("MOVING");   // PlaceFootprint: MOVING while a footprint rides the cursor
  return new Promise<void>((resolve) => {
    fpCarry = { node, ghost: ghostBoard(node, ctx.doc!), canvas, raf: 0, drawn: "", doc: ctx.doc!, pos, resolve };
    window.addEventListener("pointermove", onCarryMove, true); window.addEventListener("pointerdown", onCarryDown, true); window.addEventListener("keydown", onCarryKey, true);
    drawFootprintCarry();
  });
}

// ---------------------------------------------------------------- the dialogs

function chooser(kind: LibKind, opts?: ChooserOptions): Promise<Chosen | null> {
  return openChooser(kind, sourceCtx(), Object.assign({ viewOnly: !!E.viewOnly }, opts || {}));
}

/** The dialog, then the chosen item on the cursor. */
export async function chooseAndPlace(kind: LibKind, opts?: ChooserOptions): Promise<void> {
  if (chooserOpen()) return;
  if (!E.kdoc) { toast("Open a document first"); return; }
  if (E.viewOnly && !(opts && opts.browser)) { toast(kind === "symbol" ? "This sheet is read-only" : "This board is read-only"); return; }
  if ((kind === "symbol") !== isSch()) { toast(kind === "symbol" ? "Symbols are placed on a schematic sheet" : "Footprints are placed on a board"); return; }
  const chosen = await chooser(kind, opts);
  if (!chosen) return;
  try {
    rememberRecent(kind, chosen.item);
    if (kind === "symbol") await placeSymbol({ libId: chosen.libId || chosen.item.id, symbol: chosen.symbol || "", fields: chosen.fields, unit: chosen.unit, keep: chosen.keep, allUnits: chosen.allUnits });
    else void placeFootprint({ fpid: chosen.fpid || chosen.item.id, footprint: chosen.footprint || "", fields: chosen.fields }).catch((e) => toast(message(e), 3500));
  } catch (e) { toast(message(e), 4000); }
}

/** sch-tools' place / power tool asks for a symbol (activation, or a click with nothing on the cursor). */
function toolChooser(_ctx: ToolCtx, which: "place" | "power"): boolean {
  void chooseAndPlace("symbol", { power: which === "power" }).catch((e) => toast(message(e), 4000));
  return true;
}

function fetchOfficial(kind: LibKind, id: string): Promise<FetchedItem> {
  const { lib, name } = core.parseLibId(id);
  const item: LibItem = { id, name, library: lib, source: "official" };
  return fetchItem(kind, item, sourceCtx());
}

/**
 * PCB_BASE_FRAME::LoadFootprint( aFootprintId ): the .kicad_mod text of "Lib:Name" from the library table — a library
 * of the project (its own .pretty) before a global one of the same nickname; null when no library has it.
 */
export async function loadLibraryFootprint(fpid: string): Promise<string | null> {
  const { lib, name } = core.parseLibId(fpid.trim()); if (!lib || !name) return null;
  const ctx = sourceCtx();
  // the project's fp-lib-table nickname (or its .pretty folder) first, as FP_LIB_TABLE resolves it; then the official libraries
  try { const own = await projectFootprintByLibId(lib, name, ctx.docs); if (own) return own; } catch { /* fall through */ }
  if (projectLibraries("footprint", ctx.docs).some((l) => l.name === lib)) return null;
  try { const got = await fetchItem("footprint", { id: `${lib}:${name}`, name, library: lib, source: "official" }, ctx); return got.footprint || null; }
  catch { return null; }
}

export const KiCadLibrary = {
  placeSymbol, placeFootprint, openChooser: chooser, chooseAndPlace, closeChooser, loadFootprint: loadLibraryFootprint,
  registerSource: (source: LibrarySource) => registerSource(source), unregisterSource,
  libraries: (kind: LibKind) => officialLibraries(kind), index: (kind: LibKind, lib: string) => officialIndex(kind, lib), fetch: fetchOfficial,
  core,
  // the tool module's seam
  toolChooser, afterPlace,
};
export type KiCadLibraryApi = typeof KiCadLibrary;

declare global { interface Window { KiCadLibrary: KiCadLibraryApi } }

/** Publish the API and the actions the menus / toolbars look for (placeFootprint and the two library browsers). */
export function installLibrary(): void {
  window.KiCadLibrary = KiCadLibrary;
  const guard = (fn: () => Promise<void>) => (): boolean => { void fn().catch((e) => toast(message(e), 4000)); return true; };
  const act = (id: string, label: string, key: string, run: () => boolean) => ({ id, label, key, run });
  const sch = window.CollabTools && window.CollabTools.sch;   // the board's placeFootprint / showFootprintBrowser live in pcb-tools.js (its action table is frozen)
  if (sch && sch.actions) (sch.actions as Record<string, unknown>).showSymbolBrowser = act("showSymbolBrowser", "Symbol Library Browser", "", guard(() => chooseAndPlace("symbol", { browser: true })));
}
