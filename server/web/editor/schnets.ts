// editor/schnets — the schematic net highlight across the whole hierarchy (SCH_EDITOR_CONTROL::HighlightNet /
// UpdateNetHighlighting) and the model behind the Net Navigator.
//
// eeschema keeps the highlighted connection as a net NAME, not as a set of items: on every sheet change and every
// edit the items of that net are collected again on the sheet on screen (NAVIGATION_QUERY::CollectNetItems), so the
// highlight follows the net into sub-sheets and back up through sheet pins, hierarchical labels, global labels and
// power nets.  The browser has one sheet open, so the project's other sheets are read (live: snapshot + ops) and
// kept; the net map is rebuilt from them and the sheet on screen (canvas/pcb-netlist.ts buildNetlist, the
// CONNECTION_GRAPH naming rules) whenever someone needs it.
//
// sch-tools.js hands its picks here through CollabTools.sch.setNetHighlighter (see highlightClick there).
import type { NetEntry, SheetFile, SheetInstance } from "../canvas/pcb-netlist";
import type { schNets } from "../canvas/sch-nets";
import { setStatusBar, state } from "./appstore";
import { centerOn } from "./comments";
import { openDoc, rootSchematic } from "./doc";
import { NL } from "./pcbdialogs/canvas";
import { liveDocument, projectDocs, type ProjectDocInfo } from "./projectfile";
import { E } from "./state";
import { toolCtx } from "./tools";

const SN = (): typeof schNets => (KiCadCanvas as unknown as { schNets: typeof schNets }).schNets;
const SCH_IU = 10000;

interface SchHelpers {
  symbolPins(doc: KDoc, item: KItem): { x: number; y: number; number: string; name: string; type: string; hidden: boolean }[];
  isPowerSymbol(doc: KDoc, libId: string): boolean;
  setHighlight(ctx: ToolCtx, ids: Set<string> | null): void;
}
const schMod = (): (SchToolModule & { setNetHighlighter?(h: unknown): void }) | undefined => CollabTools.sch as (SchToolModule & { setNetHighlighter?(h: unknown): void }) | undefined;
const helpers = (): SchHelpers | null => { const m = schMod(); return m && m._ ? m._ as unknown as SchHelpers : null; };
interface Pick { item: KItem; at?: [number, number]; pin?: string }

/** The highlight: the net's name, the bus-members toggle and the item the navigator should show selected. */
export const HL = { name: null as string | null, busMembers: false, nav: null as { inst: number; id: string; pin?: string } | null };
/** The sheet instance to show a file as when it is opened from the navigator (a file used twice has two). */
let preferHuman: string | null = null;

// ---------------------------------------------------------------- the project's sheets
interface Cached { file: SheetFile; at: number }
const sheets = new Map<string, Cached>();   // docId -> the sheet as last read (the open one is always taken live)
let sheetsProject = "", loading: Promise<void> | null = null, loadedVer = 0, lastLive: { docId: string; doc: KDoc } | null = null;
const STALE_MS = 30000;
const projectKey = (): string => { const p = state.project as { projectId?: string } | null; return (p && p.projectId) || ""; };
const schDocs = (): ProjectDocInfo[] => projectDocs().filter((d) => d.docType === "kicad_sch");
const curEntry = (): ProjectDocInfo | null => ((state as { doc?: ProjectDocInfo | null }).doc) || null;

async function readSheet(d: ProjectDocInfo): Promise<SheetFile | null> {
  let text: string | null = null, ops: { changes?: KChange[] }[] = [];
  if ((state as { me?: unknown }).me) { try { const live = await liveDocument(d.docId); text = live.file; ops = live.ops; } catch (e) { text = null; } }
  if (text === null) { try { const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`); if (!r.ok) return null; text = await r.text(); } catch (e) { return null; } }
  const doc = KiCadCanvas.parseDoc(text, "kicad_sch");
  for (const op of ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(doc, c, SCH_IU); } catch (e) { /* an op this reader cannot take */ } }
  return { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || ""), file: d.path };
}
/** Read the sheets that are not on screen (again when older than STALE_MS); resolves when they are in. */
export function loadSheets(force = false): Promise<void> {
  if (sheetsProject !== projectKey()) { sheets.clear(); sheetsProject = projectKey(); }
  const now = Date.now(), cur = state.docId as string | null;
  const want = schDocs().filter((d) => d.docId !== cur && (force || !sheets.has(d.docId) || now - (sheets.get(d.docId) as Cached).at > STALE_MS));
  if (!want.length) return Promise.resolve();
  if (loading) return loading;
  const pid = projectKey();
  loading = Promise.all(want.map(async (d) => { const f = await readSheet(d); if (f && pid === projectKey()) sheets.set(d.docId, { file: f, at: Date.now() }); }))
    .then(() => { loading = null; loadedVer++; computed = null; changed(); }, () => { loading = null; });
  return loading;
}

// ---------------------------------------------------------------- the net map
interface Computed { map: Map<string, NetEntry>; instances: SheetInstance[]; index: Map<string, string>; rootName: string; docs: Map<string, KDoc>; key: string }
let computed: Computed | null = null, docGen = 0;
function compute(): Computed | null {
  const h = helpers(); const cur = curEntry(), doc = E.kdoc as KDoc | null;
  if (!h || !cur || !doc || doc.type !== "sch") return null;
  const key = `${projectKey()}|${cur.docId}|${docGen}|${loadedVer}`;
  if (computed && computed.key === key) return computed;
  const files = new Map<string, SheetFile>(), docs = new Map<string, KDoc>();
  for (const d of schDocs()) {
    if (d.docId === cur.docId) { const c = sheets.get(d.docId); files.set(d.path, { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || (c ? c.file.uuid : "")), file: d.path }); }
    else { const c = sheets.get(d.docId); if (c) files.set(d.path, c.file); }
  }
  if (!files.has(cur.path)) files.set(cur.path, { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || ""), file: cur.path });
  for (const [p, f] of files) docs.set(p, f.doc);
  const root = (state.project ? rootSchematic() : null) as ProjectDocInfo | null;
  const rootFile = (root && files.get(root.path)) || files.get(cur.path) as SheetFile;
  const resolve = (file: string, parent: SheetFile): SheetFile | null => {
    const dir = parent.file.split("/").slice(0, -1);
    const parts = [...dir, ...file.split("/")].filter((p) => p && p !== ".");
    const out: string[] = []; for (const p of parts) { if (p === "..") out.pop(); else out.push(p); }
    return files.get(out.join("/")) || files.get(file) || Array.from(files.values()).find((f) => f.file.split("/").pop() === file.split("/").pop()) || null;
  };
  const stem = rootFile.file.split("/").pop()!.replace(/\.kicad_sch$/, "");
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : stem;
  const nl = NL().buildNetlist(rootFile, resolve, { symbolPins: h.symbolPins, isPower: (d, it) => h.isPowerSymbol(d, String(((KiCadCanvas.kid(it.node, "lib_id") as SNode | null) || [])[1])) }, project);
  const map = nl.netMap || new Map<string, NetEntry>(), instances = nl.instances || [];
  computed = { map, instances, index: SN().nameIndex(map), rootName: stem, docs, key };
  return computed;
}
/** The net map of the whole hierarchy as it stands (null outside a schematic). */
export function netMap(): Computed | null { try { return compute(); } catch (e) { console.warn(e); return null; } }
/** The sheet instance on screen. */
export function currentInstance(c: Computed | null = netMap()): SheetInstance | null {
  const cur = curEntry(); if (!c || !cur) return null;
  // the instance asked for (the navigator, the hierarchy pane) when it is one of this file's, else the sheet's own path
  const asked = preferHuman && c.instances.some((i) => i.file === cur.path && i.human === preferHuman) ? preferHuman : null;
  return SN().instanceFor(c.instances, cur.path, asked || (E.kdoc as KDoc & { sheetPath?: string } | null)?.sheetPath || null);
}
export function docOfInstance(c: Computed, inst: SheetInstance): KDoc | null { return c.docs.get(inst.file) || null; }

// ---------------------------------------------------------------- the highlight
const listeners = new Set<() => void>();
/** Called when the highlight or the net map changes (the Net Navigator rebuilds). */
export function onNetsChanged(fn: () => void): void { listeners.add(fn); }
function changed(): void { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

/** UpdateNetHighlighting: brighten the items of the highlighted net on this sheet; the status bar names the net. */
export function applyHighlight(ctx: ToolCtx = (toolCtx as unknown as () => ToolCtx)()): void {
  const h = helpers(); if (!h) return;
  if (!HL.name) { h.setHighlight(ctx, null); setStatusBar({ message: "" }); changed(); return; }
  const c = netMap(), inst = currentInstance(c);
  const keys = c && inst ? SN().collectKeys(c.map, HL.name, inst.index, HL.busMembers) : new Set<string>();
  h.setHighlight(ctx, keys.size ? keys : null);
  setStatusBar({ message: SN().highlightStatus(HL.name) });
  changed();
}
/** SetHighlightedConnection( name ): highlight a net by name (the Search pane, a cross-probe, a test). */
export function highlightName(name: string | null, ctx?: ToolCtx): void { HL.name = name || null; HL.busMembers = false; HL.nav = null; applyHighlight(ctx); }
export function clearHighlight(ctx?: ToolCtx): void { HL.name = null; HL.busMembers = false; HL.nav = null; applyHighlight(ctx); }

/** GetConnectionName of the picked item on this sheet: a pin by its number, a sheet pin by its name. */
export function nameOfPick(pick: Pick | null): { name: string | null; inst: number; id: string; pin?: string } | null {
  if (!pick || !pick.item) return null;
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return null;
  const it = pick.item, K = KiCadCanvas; let pin: string | undefined;
  if (it.kind === "symbol") {
    pin = pick.pin;
    if (!pin) { const h = helpers(); const pins = h ? h.symbolPins(E.kdoc as KDoc, it) : []; let bd = Infinity; const at = pick.at || [0, 0]; for (const p of pins) { const d = Math.hypot(p.x - at[0], p.y - at[1]); if (d < bd) { bd = d; pin = p.number; } } }
  } else if (it.kind === "sheet") {
    const at = pick.at || [0, 0]; let bd = Infinity;
    for (const p of K.kids(it.node, "pin") as SNode[]) { const a = K.atOf(p) as number[]; const d = Math.hypot(a[0] - at[0], a[1] - at[1]); if (d < bd) { bd = d; pin = K.str(p[1]); } }
  }
  const key = inst.index + "|" + it.id + (pin !== undefined ? "#pin:" + pin : "");
  return { name: c.index.get(key) || null, inst: inst.index, id: it.id, pin };
}

/**
 * highlightNet(): a new net replaces the highlight (and the bus-members toggle is reset); the same net again
 * toggles SetHighlightBusMembers and selects the item in the Net Navigator; nothing named there clears it.
 */
export function highlightPick(ctx: ToolCtx, pick: Pick | null): void {
  const r = nameOfPick(pick);
  if (!r || !r.name) { clearHighlight(ctx); return; }
  if (r.name !== HL.name) { HL.busMembers = false; HL.name = r.name; }
  else HL.busMembers = !HL.busMembers;
  HL.nav = { inst: r.inst, id: r.id, pin: r.pin };
  applyHighlight(ctx);
}

/** The sheet on screen changed (an edit: the same sheet; a switch: another one). */
function docChanged(ctx: ToolCtx, sameDoc: boolean): void {
  docGen++;
  const cur = state.docId as string | null;
  if (!sameDoc) {
    // the sheet just left: what was on screen is newer than the server's copy for a moment
    const left = lastLive && lastLive.docId !== cur ? schDocs().find((d) => d.docId === lastLive!.docId) : null;
    if (left && lastLive) sheets.set(left.docId, { file: { doc: lastLive.doc, uuid: String((lastLive.doc as KDoc & { uuid?: string }).uuid || ""), file: left.path }, at: Date.now() });
    void loadSheets().then(() => { if (HL.name) applyHighlight(); else changed(); });
  }
  if (cur && E.kdoc) lastLive = { docId: cur, doc: E.kdoc as KDoc };
  if (HL.name) applyHighlight(ctx); else changed();
}

/** Open the sheet instance `inst` (a file shown under that hierarchy path) and centre on `at` once it is up. */
export async function goTo(instIndex: number, at: [number, number] | null): Promise<void> {
  const c = netMap(); if (!c) return;
  const inst = c.instances[instIndex]; if (!inst) return;
  const cur = currentInstance(c);
  if (!cur || cur.index !== inst.index) {
    const entry = schDocs().find((d) => d.path === inst.file);
    if (!entry) return;
    preferHuman = inst.human;
    if (!curEntry() || curEntry()!.docId !== entry.docId) { await openDoc(entry); await new Promise((r) => setTimeout(r, 40)); }   // after the opening fit
    else { docGen++; applyHighlight(); }
  }
  if (at) centerOn(at[0], at[1]);
}
export function preferInstance(human: string | null): void { preferHuman = human; }

/**
 * SCH_DRAWING_TOOLS::findWireLabelDriverName: the name of the wire's net when its driver on this sheet is a local or
 * global label (CONNECTION_SUBGRAPH priority: global label, then power pin, then local label), else "".
 */
export function wireDriverName(wireId: string): string {
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return "";
  const name = c.index.get(inst.index + "|" + wireId); const e = name ? c.map.get(name) : null; if (!e || e.bus) return "";
  const here = e.members.filter((m) => m.inst === inst.index);
  const g = here.find((m) => m.kind === "global_label"); if (g) return g.text || "";
  if (here.some((m) => m.kind === "pin" && m.power)) return "";
  const l = here.find((m) => m.kind === "label"); return l ? l.text || "" : "";
}
/** The schematic's default text size (Schematic Setup > Formatting, mils) and the intersheet-refs visibility. */
export function labelDefaults(): { textSize: number; intersheetRefsShow: boolean } {
  let d: Record<string, unknown> = {};
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) : null; d = (j && j.schematic && j.schematic.drawing) || {}; } catch (e) { d = {}; }
  const mils = Number(d.default_text_size);
  return { textSize: Number.isFinite(mils) && mils > 0 ? Math.round(mils * 0.0254 * 10000) / 10000 : 1.27, intersheetRefsShow: !!d.intersheets_ref_show };
}

/** Hook the module into the schematic tools (called once from editor/index.ts). */
export function installSchNets(): void {
  const m = schMod(); if (!m || !m.setNetHighlighter) return;
  m.setNetHighlighter({ highlightPick, clear: (ctx: ToolCtx) => clearHighlight(ctx), active: () => !!HL.name, docChanged, wireDriverName, labelDefaults });
}

/** DIALOG_ASSIGN_NETCLASS's previewer: the items of these nets on the sheet on screen brightened (the highlight stays its own). */
export function previewNets(names: string[], ctx: ToolCtx = (toolCtx as unknown as () => ToolCtx)()): void {
  const h = helpers(); if (!h) return;
  const c = netMap(), inst = currentInstance(c), keys = new Set<string>();
  if (c && inst) for (const n of names) for (const k of SN().collectKeys(c.map, n, inst.index, false)) keys.add(k);
  h.setHighlight(ctx, keys.size ? keys : null);
}
/** The net entries of items on the sheet on screen, by id (SCH_CONNECTION of each), in the order given. */
export function netsOfItems(ids: string[]): (NetEntry | null)[] {
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return ids.map(() => null);
  return ids.map((id) => { const n = c.index.get(inst.index + "|" + id); return n ? c.map.get(n) || null : null; });
}
/** Every net name of the schematic (GetNetClassAssignmentCandidates). */
export function allNetNames(): string[] { const c = netMap(); return c ? SN().netNames(c.map) : []; }
