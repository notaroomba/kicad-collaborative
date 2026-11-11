// pcbrouting.ts — the board editor's routing controls on the editor side: pcbnew's aux-toolbar size
// selectors, the layer pair and the origins.
//
// The numbers themselves live in KiCadCanvas.pcbSizes.state (web/canvas/pcb-sizes.ts), which
// pcb-tools.js routes with.  This module
//   · feeds it the project file (.kicad_pro) of the open project and the open board's origins,
//   · publishes what the chrome draws to the store's `routing` slice (the choice labels follow the units),
//   · answers the chrome's setTrackWidth / setViaSize intents and the + / - layer keys,
//   · owns the two dialogs — Board Setup's "Pre-defined Sizes" page and "Select Copper Layer Pair" —
//     and registers them, with their KiCad action ids, on CollabTools.pcb.actions,
//   · writes edited lists back into the project file (see saveProjectFile).
import type { DiffPairDim, LayerPairPreset, PcbSizes, SizeUnits, ViaDim } from "../canvas/pcb-sizes";
import type { RoutingState } from "../store";
import { setToggles, state, store } from "./appstore";
import { E } from "./state";
import { runModuleAction } from "./tools";
import { api, esc, toast } from "./util";
import { isSch, requestRender } from "./view";

const PS = () => KiCadCanvas.pcbSizes;
const R = (): PcbSizes => KiCadCanvas.pcbSizes.state;

/** The imperial unit shown second in the size choices while the editor is metric (COMMON_TOOLS::GetLastImperialUnits). */
let lastImperial: SizeUnits = "mil";
let seenDoc: unknown = null;
let seenProject: string | null = null;
let published = "";
let lastToggles = "";
/** The origins as the open board's file has them: a difference is what this browser remembers. */
let docOrigins: { grid: [number, number]; aux: [number, number] } = { grid: [0, 0], aux: [0, 0] };

interface ProjectDoc { docId: string; docType: string; path: string }
const projectDocs = (): ProjectDoc[] => (state.project && Array.isArray((state.project as { docs?: ProjectDoc[] }).docs) ? (state.project as { docs: ProjectDoc[] }).docs : []);
const projectId = (): string | null => (state.project ? String((state.project as { projectId: string }).projectId) : null);
const proDoc = (): ProjectDoc | null => projectDocs().find((d) => d.docType === "kicad_pro") || null;
const isBoard = (): boolean => !!E.kdoc && !isSch() && state.view === "editor";
const units = (): SizeUnits => (E.units === "in" || E.units === "mil" ? E.units : "mm");

const layerColor = (l: string): string => (KiCadCanvas as unknown as { pcbColor(l: string): string }).pcbColor(l);

// ---------------------------------------------------------------- store
function publish(): void {
  const st = R(), u = units();
  if (u !== "mm") lastImperial = u;
  const board = isBoard();
  const slice: RoutingState = {
    trackLabels: board ? PS().trackWidthLabels(st.sizes, u, lastImperial) : [], trackIndex: st.trackIndex,
    viaLabels: board ? PS().viaSizeLabels(st.sizes, u, lastImperial) : [], viaIndex: st.viaIndex,
    layers: board ? PS().enabledLayers(E.kdoc, layerColor).map((l) => ({ name: l.name, label: l.label, color: l.color, copper: l.copper })) : [],
    layerPair: [st.layerPair[0], st.layerPair[1]],
  };
  const sig = JSON.stringify(slice);
  if (sig !== published) { published = sig; store.slice("routing", slice); }
  const toggles = { autoTrackWidth: st.useConnectedWidth, ratsnestLineMode: st.curvedRatsnest };
  const tsig = JSON.stringify(toggles);
  if (tsig !== lastToggles) { lastToggles = tsig; setToggles(toggles); }
}

const originKey = (): string | null => (state.docId ? "kc.pcbOrigins." + state.docId : null);
function rememberOrigins(): void {
  const key = originKey(); if (!key || !isBoard()) return;
  const st = R(); const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  try {
    if (same(st.gridOrigin, docOrigins.grid) && same(st.auxOrigin, docOrigins.aux)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ grid: st.gridOrigin, aux: st.auxOrigin }));
  } catch (e) { /* private mode: the origins last for the session */ }
}

/** The sizes object changed (a hotkey, the router, a dialog): mirror the active layer and the grid origin, then republish. */
function onSizesChanged(): void {
  const st = R();
  if (isBoard()) {
    if (st.activeLayer && st.activeLayer !== E.activeLayer) { E.activeLayer = st.activeLayer; E.renderOpts.activeLayer = st.activeLayer; store.slice("viewport", { activeLayer: st.activeLayer }); }
    const go = st.gridOrigin[0] || st.gridOrigin[1] ? [st.gridOrigin[0], st.gridOrigin[1]] : undefined;
    if (JSON.stringify(E.renderOpts.gridOrigin) !== JSON.stringify(go)) { E.renderOpts.gridOrigin = go; requestRender(); }
    rememberOrigins();
  }
  publish();
}

const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" ? [v[0], v[1]] : null);
/** PCB_LAYER_ID of a copper layer name and back (F.Cu 0, B.Cu 2, InN.Cu 2N+2) — what board.layer_pairs stores. */
const layerId = (name: string): number => (name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : 2 * Number((/^In(\d+)\.Cu$/.exec(name) || [0, 0])[1]) + 2);
const layerName = (id: number): string => (id === 0 ? "F.Cu" : id === 2 ? "B.Cu" : `In${(id - 2) / 2}.Cu`);
function presetsFromProject(text: string): LayerPairPreset[] {
  try {
    const j = JSON.parse(text); const list = j && j.board && j.board.layer_pairs; if (!Array.isArray(list)) return [];
    return list.filter((p) => p && typeof p.topLayer === "number" && typeof p.bottomLayer === "number")
      .map((p) => { const out: LayerPairPreset = { top: layerName(p.topLayer), bottom: layerName(p.bottomLayer), enabled: p.enabled !== false }; if (typeof p.name === "string") out.name = p.name; return out; });
  } catch (e) { return []; }
}

/** A board was opened (or reloaded from a fresh snapshot): its origins, layers and the routing pair. */
function onDocument(): void {
  const st = R();
  if (!isBoard()) { publish(); return; }
  const doc = E.kdoc as { gridOrigin?: unknown; auxOrigin?: unknown; copper?: string[] };
  docOrigins = { grid: pair(doc.gridOrigin) || [0, 0], aux: pair(doc.auxOrigin) || [0, 0] };
  let grid = docOrigins.grid, aux = docOrigins.aux;
  try { const key = originKey(); const saved = key ? JSON.parse(localStorage.getItem(key) || "null") : null; if (saved) { grid = pair(saved.grid) || grid; aux = pair(saved.aux) || aux; } } catch (e) { /* no storage */ }
  st.gridOrigin = [grid[0], grid[1]]; st.auxOrigin = [aux[0], aux[1]];
  const cu = PS().copperStack(doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
  if (!cu.includes(st.layerPair[0]) || !cu.includes(st.layerPair[1])) st.layerPair = [cu[0], cu[cu.length - 1]];
  st.activeLayer = E.activeLayer || cu[0];
  st.load(E.proSettings || undefined);
  st.emit();
}

/** The project file of the open project, fetched once per project (the sizes, the netclasses and the stored layer pairs). */
function ensureProject(): void {
  const pid = projectId(); if (pid === seenProject) return;
  seenProject = pid; const pro = proDoc(); const st = R();
  if (!pid || !pro) { st.layerPairPresets = []; st.load(undefined); return; }
  api(`/api/docs/${pro.docId}/content?v=${Date.now()}`).then((t: unknown) => {
    if (projectId() !== pid) return;
    const text = typeof t === "string" ? t : JSON.stringify(t);
    E.proSettings = text; st.layerPairPresets = presetsFromProject(text);
    if (!st.load(text)) st.emit();
    const pcb = CollabTools.pcb as (PcbToolModule & { setDesignSettings?(src: unknown): void }) | undefined;
    if (pcb && pcb.setDesignSettings) { try { pcb.setDesignSettings(text); } catch (e) { /* module without rules */ } }
  }).catch(() => { /* no project file: KiCad's defaults */ });
}

let seenInputs = "";
/** Every store update lands here (pointer moves included), so only a new project, document, view or unit does any work. */
function onStore(): void {
  ensureProject();
  if (E.kdoc !== seenDoc) { seenDoc = E.kdoc; seenInputs = ""; onDocument(); }
  const inputs = `${E.units}|${state.view}|${E.DOC_TYPE}|${E.kdoc ? 1 : 0}`;
  if (inputs !== seenInputs) { seenInputs = inputs; publish(); }   // the labels follow the units
}

// ---------------------------------------------------------------- the chrome's intents
/** The track width choice: an index into the list (0 = use netclass), or its "Edit Pre-defined Sizes..." entry. */
export function chooseTrackWidth(index: number | "edit"): void {
  if (index === "edit") { openPredefinedSizes(); return; }
  R().setTrackIndex(Number(index));
  const rt = CollabTools.pcb && (CollabTools.pcb.state as { route?: { width: number; net?: { name?: string }; connected?: number | null } | null }).route;
  if (rt) { const st = R(); st.tempOverride = true; rt.width = st.routeWidth((rt.net && rt.net.name) || "", null); st.emit(); requestRender(); }   // a width picked mid-route applies to the leg being drawn
}
export function chooseViaSize(index: number | "edit"): void {
  if (index === "edit") { openPredefinedSizes(); return; }
  R().setViaIndex(Number(index));
}
/** + / - in the board editor (PCB_ACTIONS::layerNext / layerPrev); anything else, or a schematic, is not ours. */
export function pcbLayerKey(ev: KeyboardEvent): boolean {
  if (!isBoard() || ev.ctrlKey || ev.metaKey || ev.altKey || (ev.key !== "+" && ev.key !== "-")) return false;
  return runModuleAction(ev.key === "+" ? "layerNext" : "layerPrev");
}

// ---------------------------------------------------------------- the project file on the server
let saveSeq = 0;
/**
 * Store a new .kicad_pro.  A document's content on the server is its newest snapshot, and a snapshot can only
 * be added above the newest one — so the edit goes the way every edit does: an op on the project-file
 * document (journalled, attributed, and what moves its head), followed by the new file as the snapshot at
 * that op's sequence number.  The desktop reads the same snapshot when it next syncs the project.
 */
export function saveProjectFile(text: string, what: Record<string, unknown>): Promise<boolean> {
  const pro = proDoc();
  if (!pro || E.viewOnly || !state.me) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false, sock: WebSocket | null = null;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); try { if (sock) sock.close(); } catch (e) { /* closed */ } resolve(ok); };
    const timer = setTimeout(() => finish(false), 10000);
    (api("/api/ws-ticket") as Promise<{ token?: string }>).then((ticket) => {
      sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      const clientOpId = `web-pro:${Date.now().toString(36)}:${++saveSeq}`;
      sock.onopen = () => { if (sock) sock.send(JSON.stringify({ type: "hello", proto: 1, token: ticket.token || "", clientId: "web-pro-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "web" })); };
      sock.onerror = () => finish(false);
      sock.onclose = () => finish(false);
      sock.onmessage = (ev) => {
        let msg: { type?: string; role?: string; clientOpId?: string; seq?: number; docId?: string };
        try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
        if (!sock) return;
        if (msg.type === "hello_ok") sock.send(JSON.stringify({ type: "join_doc", docId: pro.docId }));
        else if (msg.type === "doc_info") {
          if (msg.role !== "editor") { finish(false); return; }
          sock.send(JSON.stringify({ type: "op", docId: pro.docId, clientOpId, baseSeq: null,
            changes: [{ id: "project", kind: "MODIFIED", typeName: "PROJECT_FILE", properties: Object.entries(what).map(([name, v]) => ({ name, after: { type: "json", v } })) }] }));
        } else if (msg.type === "ack" && msg.clientOpId === clientOpId) {
          fetch(`/api/docs/${pro.docId}/snapshots?seq=${Number(msg.seq) || 0}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text })
            .then((r) => finish(r.ok)).catch(() => finish(false));
        } else if (msg.type === "error") finish(false);
      };
    }).catch(() => finish(false));
  });
}

// ---------------------------------------------------------------- dialogs
interface DialogSpec { title: string; width?: number; build(body: HTMLElement): void; ok?(): boolean | void; okLabel?: string; readOnly?: boolean }
const openDialog = (spec: DialogSpec): void => { if (typeof KDialogs !== "undefined" && KDialogs) KDialogs.open(spec); };
const SVG = (inner: string, vb = 16) => `<svg viewBox="0 0 ${vb} ${vb}" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// KiCad's small_plus / small_sort_desc / small_trash / right bitmaps, redrawn in the current text colour
const ICON_PLUS = SVG('<path d="M8 2v12M14 8H2"/>');
const ICON_SORT = SVG('<path d="M12 10V2M14.5 7.5L12 10 9.5 7.5" /><path d="M4 2H1M5 6H1M7 10H1M10 14H1" stroke-width="1.4"/>');
const ICON_TRASH = SVG('<path d="M4 13.2L3.5 5.5h9l-.5 7.7c-.05.7-.6 1.3-1.3 1.3H5.3c-.7 0-1.2-.6-1.3-1.3z" fill="currentColor" stroke-width="1"/><path d="M13.6 2h-3.2l-.25-.65A.65.65 0 009.6 1H6.5a.65.65 0 00-.58.35L5.67 2H2.43A.43.43 0 002 2.43v1.14c0 .24.2.43.43.43h11.2c.24 0 .43-.19.43-.43V2.43A.43.43 0 0013.6 2z" fill="currentColor" stroke="none"/>');
const ICON_RIGHT = SVG('<path d="M23 12L14 1v6.9H1v8.2h13V23z" fill="currentColor" stroke="none"/>', 24);

/** A length cell as KiCad's unit grids show it: the value in the editor's units with the unit name. */
function cellText(mm: number): string {
  const u = units(); if (!(mm > 0)) return "";
  return u === "mil" ? `${+(mm / 0.0254).toFixed(4)} mils` : u === "in" ? `${+(mm / 25.4).toFixed(6)} in` : `${+mm.toFixed(6)} mm`;
}
/** Parse a length cell: a bare number is in the editor's units; mm / mils / mil / thou / in / " are understood. NaN = not a length, 0 = empty. */
function cellValue(text: string): number {
  const t = text.trim().toLowerCase(); if (!t) return 0;
  const m = /^(-?\d*\.?\d+)\s*(mm|mils?|thou|in|inch|")?$/.exec(t.replace(",", ".")); if (!m) return NaN;
  const v = parseFloat(m[1]); const unit = m[2] || (units() === "mil" ? "mil" : units() === "in" ? "in" : "mm");
  return +(unit === "mm" ? v : unit === "in" || unit === "inch" || unit === '"' ? v * 25.4 : v * 0.0254).toFixed(6);
}

interface GridSpec { title: string; cols: string[]; rows: number[][] }
/** One of the page's three grids with its add / sort / delete buttons below (PANEL_SETUP_TRACKS_AND_VIAS). */
function sizeGrid(spec: GridSpec, key: string): { el: HTMLElement; values(): number[][] | null } {
  const wrap = document.createElement("div"); wrap.className = "ps-col"; wrap.dataset.grid = key;
  wrap.innerHTML = `<div class="ps-title">${esc(spec.title)}</div><div class="ps-grid"><div class="ps-head" style="grid-template-columns:repeat(${spec.cols.length},1fr)">${spec.cols.map((c) => `<span>${esc(c)}</span>`).join("")}</div><div class="ps-rows"></div></div>`
    + `<div class="ps-btns"><button type="button" class="btn" data-act="add" title="Add">${ICON_PLUS}</button><button type="button" class="btn" data-act="sort" title="Sort">${ICON_SORT}</button><span style="flex:1"></span><button type="button" class="btn" data-act="del" title="Delete">${ICON_TRASH}</button></div>`;
  const rowsEl = wrap.querySelector(".ps-rows") as HTMLElement; let current: HTMLElement | null = null;
  const addRow = (vals: number[], focus?: boolean) => {
    const row = document.createElement("div"); row.className = "ps-row"; row.style.gridTemplateColumns = `repeat(${spec.cols.length},1fr)`;
    spec.cols.forEach((c, i) => { const inp = document.createElement("input"); inp.type = "text"; inp.value = cellText(vals[i] || 0); inp.setAttribute("aria-label", `${spec.title} ${c}`);
      inp.addEventListener("focus", () => { current = row; }); inp.addEventListener("change", () => { const v = cellValue(inp.value); inp.classList.toggle("bad", isNaN(v) || v < 0); if (!isNaN(v) && v >= 0) inp.value = cellText(v); }); row.appendChild(inp); });
    rowsEl.appendChild(row); if (focus) (row.firstChild as HTMLInputElement).focus();
  };
  spec.rows.forEach((r) => addRow(r));
  const read = (): number[][] | null => {
    const out: number[][] = []; let bad = false;
    rowsEl.querySelectorAll<HTMLElement>(".ps-row").forEach((row) => { const vals = Array.from(row.querySelectorAll("input"), (i) => cellValue(i.value)); if (vals.some((v) => isNaN(v) || v < 0)) bad = true; else if (vals[0] > 0) out.push(vals); });
    return bad ? null : out;
  };
  (wrap.querySelector(".ps-btns") as HTMLElement).addEventListener("click", (ev) => {
    const b = (ev.target as Element).closest("button"); if (!b) return;
    if (b.dataset.act === "add") addRow([], true);
    else if (b.dataset.act === "del") { const row = current && current.parentElement === rowsEl ? current : (rowsEl.lastElementChild as HTMLElement | null); if (row) { const next = (row.nextElementSibling || row.previousElementSibling) as HTMLElement | null; row.remove(); current = next; } }
    else if (b.dataset.act === "sort") { const vals = read(); if (!vals) return; vals.sort((a, c) => { for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) return a[i] - c[i]; return 0; }); rowsEl.replaceChildren(); vals.forEach((r) => addRow(r)); }
  });
  return { el: wrap, values: read };
}

const DIALOG_CSS = `.ps-cols{display:grid;grid-template-columns:1fr 1.5fr 2fr;gap:14px}.ps-title{margin:0 0 4px;color:var(--ink)}.ps-grid{border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);height:230px;overflow:auto}
.ps-head{display:grid;position:sticky;top:0;background:var(--panel-2);border-bottom:1px solid var(--line);font-weight:600;text-align:center}.ps-head span{padding:3px 4px;border-right:1px solid var(--line)}.ps-head span:last-child{border-right:0}
.ps-row{display:grid;border-bottom:1px solid var(--line)}.ps-row input{border:0!important;border-right:1px solid var(--line)!important;border-radius:0!important;background:transparent!important;padding:3px 6px!important;min-width:0}.ps-row input:last-child{border-right:0!important}
.ps-row input:focus{outline:2px solid var(--blue);outline-offset:-2px}.ps-row input.bad{background:color-mix(in srgb,var(--err) 22%,var(--panel))!important}.ps-btns{display:flex;gap:4px;margin-top:5px}.ps-btns .btn{padding:3px 6px;display:inline-flex;align-items:center}
.lp-wrap{display:flex;gap:12px;align-items:stretch}.lp-list{border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);min-width:150px;max-height:260px;overflow:auto;margin-top:4px}
.lp-row{display:grid;grid-template-columns:24px 20px 1fr;align-items:center;padding:2px 4px;cursor:pointer;white-space:nowrap}.lp-row:hover{background:var(--panel-2)}.lp-row.on{background:var(--on)}
.lp-sw{width:14px;height:14px;border:1px solid var(--line-2);border-radius:var(--r-1);display:inline-block}.lp-mark{font-weight:700;text-align:center}.lp-add{align-self:center}.lp-presets{flex:1;min-width:260px;border:1px solid var(--line);border-radius:var(--r-3);padding:6px 8px;display:flex;flex-direction:column}
.lp-presets legend{padding:0 4px;color:var(--ink-2)}.lp-pgrid{border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);flex:1;min-height:120px;overflow:auto}.lp-prow,.lp-phead{display:grid;grid-template-columns:58px 26px 96px 1fr;align-items:center;border-bottom:1px solid var(--line)}
.lp-phead{background:var(--panel-2);font-weight:600;text-align:center;position:sticky;top:0}.lp-phead span,.lp-prow>*{padding:2px 4px}.lp-prow.cur{background:var(--on)}.lp-prow input[type=checkbox]{width:auto;margin:0 auto;display:block}.lp-prow input[type=text]{border:0!important;background:transparent!important;padding:2px 4px!important}`;
function dialogStyles(): void {
  if (document.getElementById("pcbRoutingCss")) return;
  const s = document.createElement("style"); s.id = "pcbRoutingCss"; s.textContent = DIALOG_CSS; document.head.appendChild(s);
}

/** Board Setup › Pre-defined Sizes: the three lists the size selectors and W / ' / \ step through. */
export function openPredefinedSizes(): void {
  if (!isBoard()) return;
  dialogStyles();
  const st = R(); const canSave = !!proDoc() && !E.viewOnly && !!E.proSettings;
  let tracks: ReturnType<typeof sizeGrid>, vias: ReturnType<typeof sizeGrid>, pairs: ReturnType<typeof sizeGrid>;
  let note: HTMLElement;
  openDialog({ title: "Board Setup — Pre-defined Sizes", width: 720, readOnly: !!E.viewOnly,
    build(body) {
      const cols = document.createElement("div"); cols.className = "ps-cols";
      tracks = sizeGrid({ title: "Tracks", cols: ["Width"], rows: st.sizes.trackWidths.slice(1).map((w) => [w]) }, "tracks");
      vias = sizeGrid({ title: "Vias", cols: ["Diameter", "Hole"], rows: st.sizes.vias.slice(1).map((v) => [v.diameter, v.drill]) }, "vias");
      pairs = sizeGrid({ title: "Differential Pairs", cols: ["Width", "Gap", "Via Gap"], rows: st.sizes.diffPairs.slice(1).map((d) => [d.width, d.gap, d.via_gap]) }, "diffpairs");
      cols.append(tracks.el, vias.el, pairs.el); body.appendChild(cols);
      note = document.createElement("p"); note.className = "kd-note"; note.style.margin = "10px 0 0";
      note.textContent = canSave ? "These sizes are stored in the project file." : "This project has no project file you can write: the sizes are kept for this session only.";
      body.appendChild(note);
    },
    ok() {
      const t = tracks.values(), v = vias.values(), d = pairs.values();
      const fail = (msg: string) => { note.textContent = msg; note.style.color = "#E05A5A"; return false; };
      if (!t || !v || !d) return fail("Enter each size as a length, for example 0.25 mm or 10 mils.");
      for (const [dia, hole] of v) if (hole >= dia) return fail("Via hole size must be smaller than via diameter.");   // PCB_VIA::ValidateViaParameters
      const viaList: ViaDim[] = v.map(([diameter, drill]) => ({ diameter, drill: drill || 0 }));
      const dpList: DiffPairDim[] = d.map(([width, gap, via_gap]) => ({ width, gap: gap || 0, via_gap: via_gap || 0 }));
      st.setLists(t.map((r) => r[0]), viaList, dpList);
      if (!canSave) { toast("Pre-defined sizes changed for this session"); return true; }
      const text = PS().sizesToProject(String(E.proSettings), st.sizes);
      saveProjectFile(text, { "board.design_settings.track_widths": st.sizes.trackWidths, "board.design_settings.via_dimensions": st.sizes.vias, "board.design_settings.diff_pair_dimensions": st.sizes.diffPairs })
        .then((ok) => { if (ok) { E.proSettings = text; st.src = text; toast("Pre-defined sizes saved to the project file"); } else toast("Could not write the project file — the sizes are kept for this session", 4000); });
      return true;
    } });
}

/** ROUTER_TOOL::SelectCopperLayerPair — "Select Copper Layer Pair": the top and bottom routing layers, and the stored pairs. */
export function openLayerPair(): void {
  if (!isBoard()) return;
  dialogStyles();
  const st = R(); const layers = PS().enabledLayers(E.kdoc, layerColor).filter((l) => l.copper);
  const byName = new Map(layers.map((l) => [l.name, l]));
  let top = byName.has(st.layerPair[0]) ? st.layerPair[0] : layers[0].name, bottom = byName.has(st.layerPair[1]) ? st.layerPair[1] : layers[layers.length - 1].name;
  let presets: LayerPairPreset[] = st.layerPairPresets.map((p) => ({ ...p })); let picked = -1;
  const before = JSON.stringify(presets);
  const color = (n: string) => (byName.get(n) || { color: "#888" }).color, label = (n: string) => (byName.get(n) || { label: n }).label;
  openDialog({ title: "Select Copper Layer Pair", width: 720,
    build(body) {
      const wrap = document.createElement("div"); wrap.className = "lp-wrap";
      const column = (title: string, side: "top" | "bottom") => {
        const col = document.createElement("div"); col.innerHTML = `<div>${title}</div><div class="lp-list" data-side="${side}"></div>`;
        const list = col.querySelector(".lp-list") as HTMLElement;
        const draw = () => { const cur = side === "top" ? top : bottom; list.innerHTML = layers.map((l) => `<div class="lp-row${l.name === cur ? " on" : ""}" data-layer="${esc(l.name)}"><span><i class="lp-sw" style="background:${l.color}"></i></span><span class="lp-mark">${l.name === cur ? "✓" : ""}</span><span>${esc(l.label)}</span></div>`).join(""); };
        list.addEventListener("click", (ev) => { const row = (ev.target as Element).closest<HTMLElement>(".lp-row"); if (!row || !row.dataset.layer) return; if (side === "top") top = row.dataset.layer; else bottom = row.dataset.layer; picked = -1; redraw(); });
        return { col, draw };
      };
      const left = column("Top/Front layer:", "top"), right = column("Bottom/Back layer:", "bottom");
      const add = document.createElement("button"); add.type = "button"; add.className = "btn lp-add"; add.title = "Add the selected pair to the presets"; add.innerHTML = ICON_RIGHT;
      const box = document.createElement("fieldset"); box.className = "lp-presets"; box.innerHTML = `<legend>Copper Layer Pair Presets</legend><div class="lp-pgrid"><div class="lp-phead"><span>Enabled</span><span></span><span>Layers</span><span>Label</span></div><div class="lp-prows"></div></div><div class="ps-btns"><button type="button" class="btn" data-act="del" title="Delete">${ICON_TRASH}</button></div>`;
      const prows = box.querySelector(".lp-prows") as HTMLElement;
      const drawPresets = () => {
        prows.replaceChildren();
        presets.forEach((p, i) => {
          const row = document.createElement("div"); row.className = "lp-prow" + (i === picked ? " cur" : ""); row.dataset.i = String(i);
          row.innerHTML = `<span><input type="checkbox"${p.enabled ? " checked" : ""}></span><span><i class="lp-sw" style="background:linear-gradient(135deg,${color(p.top)} 50%,${color(p.bottom)} 50%)"></i></span><span>${esc(label(p.top))} / ${esc(label(p.bottom))}</span><input type="text" value="${esc(p.name || "")}">`;
          (row.querySelector("input[type=checkbox]") as HTMLInputElement).addEventListener("change", (ev) => { p.enabled = (ev.target as HTMLInputElement).checked; });
          (row.querySelector("input[type=text]") as HTMLInputElement).addEventListener("change", (ev) => { const v = (ev.target as HTMLInputElement).value.trim(); if (v) p.name = v; else delete p.name; });
          row.addEventListener("click", (ev) => { if ((ev.target as Element).closest("input")) { picked = i; return; } picked = i; top = p.top; bottom = p.bottom; redraw(); });
          prows.appendChild(row);
        });
      };
      const redraw = () => { left.draw(); right.draw(); drawPresets(); };
      add.addEventListener("click", () => { if (!presets.some((p) => p.top === top && p.bottom === bottom)) presets.push({ top, bottom, enabled: true }); picked = presets.findIndex((p) => p.top === top && p.bottom === bottom); drawPresets(); });
      (box.querySelector("[data-act=del]") as HTMLElement).addEventListener("click", () => { if (picked >= 0) { presets.splice(picked, 1); picked = -1; drawPresets(); } });
      wrap.append(left.col, right.col, add, box); body.appendChild(wrap); redraw();
    },
    ok() {
      st.layerPairPresets = presets; st.setLayerPair(top, bottom);
      // "select the same layer for both layers is allowed (normal in some boards) but could be a mistake"
      if (top === bottom) toast("Warning: top and bottom layers are same.", 4000);
      if (JSON.stringify(presets) !== before && proDoc() && !E.viewOnly && E.proSettings) {
        const stored = presets.map((p) => { const o: Record<string, unknown> = { bottomLayer: layerId(p.bottom), enabled: p.enabled, topLayer: layerId(p.top) }; if (p.name) o.name = p.name; return o; });
        const text = PS().setProjectValue(String(E.proSettings), ["board", "layer_pairs"], stored, false);
        saveProjectFile(text, { "board.layer_pairs": stored }).then((ok) => { if (ok) { E.proSettings = text; st.src = text; } else toast("Could not write the project file — the layer pair presets are kept for this session", 4000); });
      }
      return true;
    } });
}

// ---------------------------------------------------------------- install
export function installPcbRouting(): void {
  // the dialogs need the page, so pcb-tools.js publishes their KiCad action ids and calls back into this module
  const pcb = CollabTools.pcb as (PcbToolModule & { setRoutingDialogs?(d: { layerPair(): void; sizes(): void }): void }) | undefined;
  if (pcb && pcb.setRoutingDialogs) pcb.setRoutingDialogs({ layerPair: openLayerPair, sizes: openPredefinedSizes });
  R().subscribe(onSizesChanged);
  store.subscribe(onStore);
}
