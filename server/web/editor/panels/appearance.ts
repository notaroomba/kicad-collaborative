// panels/appearance.ts — the board editor's Appearance panel model (pcbnew/widgets/appearance_controls.cpp):
// layers (KiCad's names, order and tooltips; visibility, colour and the active layer), the Objects rows
// (visibility + opacity), nets and net classes (colour + ratsnest visibility), the layer / net display
// options, layer presets and viewports.  Everything is per user and lives in localStorage — KiCad keeps the
// colours (with their opacity) in the user's colour theme and the rest in the project's local settings
// (.kicad_prl) — and reaches the canvas through E.renderOpts (web/canvas/render.ts) and the pcb tool module's
// ratsnest state.  Nothing here is written into the board file.
import type { AppearanceState, InactiveMode, LayerInfo, LayerMenuCmd, NetClassRow, NetCmd, NetColorMode, NetRow, ObjectRow, PanelAction, RatsnestMode } from "../../panels-api";
import { parseColor, rgba } from "../../canvas/colors";
import { confirmBox } from "../../dialogs/dom";
import { setToggles, store } from "../appstore";
import { hotkeyCyclePopup } from "../hotkey-popup";
import { setActiveLayer } from "../doc";
import { E } from "../state";
import { toast } from "../util";
import { fitBox, requestRender, visibleRectNm } from "../view";
import { KC, isSchDoc, kdoc, listPick, loadJson, panelStore, pcbTools, projectId, saveJson, textEntry, tctx } from "./core";

// ---------------------------------------------------------------- layers
// APPEARANCE_CONTROLS::rebuildLayers: copper front → back, then this technical / user sequence.
const NON_CU: [string, string, string][] = [
  ["F.Adhes", "F.Adhesive", "Adhesive on board's front"], ["B.Adhes", "B.Adhesive", "Adhesive on board's back"],
  ["F.Paste", "F.Paste", "Solder paste on board's front"], ["B.Paste", "B.Paste", "Solder paste on board's back"],
  ["F.SilkS", "F.Silkscreen", "Silkscreen on board's front"], ["B.SilkS", "B.Silkscreen", "Silkscreen on board's back"],
  ["F.Mask", "F.Mask", "Solder mask on board's front"], ["B.Mask", "B.Mask", "Solder mask on board's back"],
  ["Dwgs.User", "User.Drawings", "Explanatory drawings"], ["Cmts.User", "User.Comments", "Explanatory comments"],
  ["Eco1.User", "User.Eco1", "User defined meaning"], ["Eco2.User", "User.Eco2", "User defined meaning"],
  ["Edge.Cuts", "Edge.Cuts", "Board's perimeter definition"], ["Margin", "Margin", "Board's edge setback outline"],
  ["F.CrtYd", "F.Courtyard", "Footprint courtyards on board's front"], ["B.CrtYd", "B.Courtyard", "Footprint courtyards on board's back"],
  ["F.Fab", "F.Fab", "Footprint assembly on board's front"], ["B.Fab", "B.Fab", "Footprint assembly on board's back"],
];
const NON_CU_RANK = new Map(NON_CU.map((l, i) => [l[0], i]));
const isCu = (l: string) => /\.Cu$/.test(l);
function layerRank(l: string): number {
  if (l === "F.Cu") return 0; if (l === "B.Cu") return 99;
  const inner = /^In(\d+)\.Cu$/.exec(l); if (inner) return +inner[1];
  const r = NON_CU_RANK.get(l); if (r !== undefined) return 100 + r;
  const u = /^User\.(\d+)$/.exec(l); if (u) return 200 + +u[1];
  return 400;
}
/** BOARD::GetLayerName: the user's name when the board gives one, else LayerName() (common/layer_id.cpp). */
export function layerDisplayName(doc: KDoc | null, key: string): string {
  const row = doc ? doc.layers.get(key) : undefined;
  if (row && row.userName && row.userName !== key) return row.userName;
  const std = NON_CU.find((l) => l[0] === key);
  return std ? std[1] : key;
}
function layerTip(key: string): string {
  if (key === "F.Cu") return "Front copper layer"; if (key === "B.Cu") return "Back copper layer"; if (isCu(key)) return "Inner copper layer";
  const std = NON_CU.find((l) => l[0] === key); if (std) return std[2];
  const u = /^User\.(\d+)$/.exec(key); return u ? `User defined layer ${u[1]}` : key;
}
function boardLayerKeys(doc: KDoc): string[] {
  const names = new Set<string>();
  for (const [k, row] of doc.layers) if (typeof k === "string" && (k.includes(".") || k === "Margin") && row) names.add(k);
  for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && g.layer !== "holes" && (g.layer.includes(".") || g.layer === "Margin")) names.add(g.layer);
  if (!names.size) for (const l of ["F.Cu", "B.Cu"]) names.add(l);
  return Array.from(names).sort((a, b) => layerRank(a) - layerRank(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------- objects (s_objectSettings)
interface ObjectDef { id: string; label: string; tip: string; opacity?: boolean; canHide?: boolean; spacer?: boolean; defaultHidden?: boolean; defaultOpacity?: number }
const OBJECTS: ObjectDef[] = [
  { id: "tracks", label: "Tracks", tip: "Show tracks", opacity: true },
  { id: "vias", label: "Vias", tip: "Show all vias", opacity: true },
  { id: "pads", label: "Pads", tip: "Show all pads", opacity: true },
  { id: "zones", label: "Zones", tip: "Show copper zones", opacity: true, defaultOpacity: 0.6 },   // "board.opacity.zones" 0.6
  { id: "filledShapes", label: "Filled Shapes", tip: "Opacity of filled shapes", opacity: true, canHide: false },
  { id: "images", label: "Images", tip: "Show user images", opacity: true, defaultOpacity: 0.6 },   // "board.opacity.images" 0.6
  { id: "outsideGroup", label: "Outside Group", tip: "Opacity of items outside the entered group", opacity: true, canHide: false, defaultOpacity: 0.2 },   // "board.opacity.outside_group" 0.2
  { id: "sp1", label: "", tip: "", spacer: true },
  { id: "fpFront", label: "Footprints Front", tip: "Show footprints that are on board's front" },
  { id: "fpBack", label: "Footprints Back", tip: "Show footprints that are on board's back" },
  { id: "values", label: "Values", tip: "Show footprint values" },
  { id: "references", label: "References", tip: "Show footprint references" },
  { id: "fpText", label: "Footprint Text", tip: "Show all footprint text" },
  { id: "sp2", label: "", tip: "", spacer: true },
  { id: "sp3", label: "", tip: "", spacer: true },
  { id: "ratsnest", label: "Ratsnest", tip: "Show unconnected nets as a ratsnest" },
  { id: "drcWarnings", label: "DRC Warnings", tip: "DRC violations with a Warning severity" },
  { id: "drcErrors", label: "DRC Errors", tip: "DRC violations with an Error severity" },
  { id: "drcExclusions", label: "DRC Exclusions", tip: "DRC violations which have been individually excluded", defaultHidden: true },
  { id: "anchors", label: "Anchors", tip: "Show footprint and text origins as a cross" },
  { id: "points", label: "Points", tip: "Show explicit snap points as crosses" },
  { id: "subgrids", label: "Grids", tip: "Show custom routing/placement grids" },
  { id: "viaStitching", label: "Via Stitching", tip: "Show via stitching generator outlines" },
  { id: "lockedShadow", label: "Locked Item Shadow", tip: "Show a shadow on locked items" },
  { id: "conflicts", label: "Colliding Courtyards", tip: "Show colliding footprint courtyards" },
  { id: "constraintShadow", label: "Constrained Item Shadow", tip: "Show a shadow on constrained items" },
  { id: "boardArea", label: "Board Area Shadow", tip: "Show board area shadow", defaultHidden: true },   // LAYER_BOARD_OUTLINE_AREA: hidden by default (lset.cpp)
  { id: "drawingSheet", label: "Drawing Sheet", tip: "Show drawing sheet borders and title block" },
  { id: "grid", label: "Grid", tip: "Show the (x,y) grid dots" },
];
/** An Objects row's opacity: the user's, else KiCad's default (PROJECT_LOCAL_SETTINGS: zones and images 0.6, the rest 1). */
function objOpacity(o: ObjectDef): number { const v = user.objOpacity[o.id]; return typeof v === "number" && v >= 0 && v <= 1 ? v : o.defaultOpacity === undefined ? 1 : o.defaultOpacity; }
const SEVERITY: Record<string, string> = { drcWarnings: "warning", drcErrors: "error", drcExclusions: "exclusion" };

// ---------------------------------------------------------------- presets (LAYER_PRESET)
interface Preset { name: string; layers: string[]; hiddenObjects?: string[]; flip: boolean; active?: string }
const FRONT_TECH = ["F.SilkS", "F.Mask", "F.Adhes", "F.Paste", "F.CrtYd", "F.Fab"], BACK_TECH = FRONT_TECH.map((l) => "B" + l.slice(1));
/** The built-in presets that cannot be deleted, evaluated against the board's layers. */
function builtinPresets(all: string[]): Preset[] {
  const cu = all.filter(isCu), has = (ls: string[]) => all.filter((l) => ls.includes(l));
  const edge = (ls: string[]) => Array.from(new Set(ls.concat(all.includes("Edge.Cuts") ? ["Edge.Cuts"] : [])));
  const out: Preset[] = [
    { name: "All Layers", layers: all.slice(), flip: false },
    { name: "No Layers", layers: [], flip: false },
    { name: "All Copper Layers", layers: edge(cu), flip: false },
    { name: "Inner Copper Layers", layers: edge(cu.filter((l) => l !== "F.Cu" && l !== "B.Cu")), flip: false },
    { name: "Front Layers", layers: edge(has(["F.Cu", ...FRONT_TECH])), flip: false },
    { name: "Front Assembly View", layers: edge(has(["F.SilkS", "F.Mask", "F.Fab", "F.CrtYd"])), hiddenObjects: [], flip: false, active: "F.SilkS" },
    { name: "Back Layers", layers: edge(has(["B.Cu", ...BACK_TECH])), flip: true },
    { name: "Back Assembly View", layers: edge(has(["B.SilkS", "B.Mask", "B.Fab", "B.CrtYd"])), hiddenObjects: [], flip: true, active: "B.SilkS" },
  ];
  return out;
}

// ---------------------------------------------------------------- persisted state
interface UserPrefs { colors: Record<string, string>; objHidden: string[]; objOpacity: Record<string, number>; netColorMode: NetColorMode; ratsnestMode: RatsnestMode; opacityAbs?: boolean; rowsV2?: boolean }
interface Viewport { name: string; rect: [number, number, number, number] }
interface ProjectPrefs { hidden: string[] | null; netColors: Record<string, string>; classColors: Record<string, string>; hiddenNets: string[]; hiddenClasses: string[]; presets: Preset[]; viewports: Viewport[]; viewport: string | null; contrastMode?: InactiveMode }

const USER_KEY = "kui.appearance";
const projKey = () => "kui.appearance." + (projectId() || "x");
let user: UserPrefs = Object.assign({ colors: {}, objHidden: OBJECTS.filter((o) => o.defaultHidden).map((o) => o.id), objOpacity: {}, netColorMode: "ratsnest" as NetColorMode, ratsnestMode: "all" as RatsnestMode },
  loadJson<Partial<UserPrefs>>(USER_KEY, {}));
// rows added after a user's prefs were saved start as KiCad has them (Board Area Shadow hidden)
if (!user.rowsV2) { if (!user.objHidden.includes("boardArea")) user.objHidden.push("boardArea"); user.rowsV2 = true; }
// the Zones slider used to scale the fixed 0.6 zone opacity; it is the opacity itself now (as KiCad's): keep the look
if (!user.opacityAbs) { if (typeof user.objOpacity.zones === "number") user.objOpacity.zones = Math.round(user.objOpacity.zones * 60) / 100; user.opacityAbs = true; }
let proj: ProjectPrefs = emptyProj(); let projFor = "";
function emptyProj(): ProjectPrefs { return { hidden: null, netColors: {}, classColors: {}, hiddenNets: [], hiddenClasses: [], presets: [], viewports: [], viewport: null }; }
function loadProj(): void { const k = projKey(); if (k === projFor) return; projFor = k; proj = Object.assign(emptyProj(), loadJson<Partial<ProjectPrefs>>(k, {})); }
const saveUser = () => saveJson(USER_KEY, user);
const saveProj = () => saveJson(projKey(), proj);

// ---------------------------------------------------------------- nets and net classes
interface NetInfo { name: string; code: number; netclass: string }
let netCache: { doc: KDoc | null; version: number; pro: unknown; nets: NetInfo[]; classes: string[] } = { doc: null, version: -1, pro: null, nets: [], classes: [] };

interface ProNetSettings { classes?: { name?: string }[]; netclass_assignments?: Record<string, string | string[]> | null; netclass_patterns?: { netclass?: string; pattern?: string }[] }
function netSettings(): ProNetSettings {
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) : null; return (j && j.net_settings) || {}; } catch (e) { return {}; }
}
function wildcard(p: string): RegExp { return new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); }
function nets(): { nets: NetInfo[]; classes: string[] } {
  const doc = kdoc(), P = pcbTools(), version = store.get().document.version;
  if (!doc || !P || isSchDoc()) return { nets: [], classes: [] };
  if (netCache.doc === doc && netCache.version === version && netCache.pro === E.proSettings) return netCache;
  const ns = netSettings(); const classes = ["Default"];
  for (const c of ns.classes || []) if (c && c.name && !classes.includes(c.name)) classes.push(c.name);
  const pats = (ns.netclass_patterns || []).filter((p) => p && p.pattern && p.netclass).map((p) => ({ re: wildcard(String(p.pattern)), cls: String(p.netclass) }));
  const assigned = ns.netclass_assignments || {};
  const classOf = (name: string): string => {
    const a = assigned[name]; const direct = Array.isArray(a) ? a[0] : a;
    const cls = direct || (pats.find((p) => p.re.test(name)) || { cls: "" }).cls;
    return cls && classes.includes(cls) ? cls : "Default";
  };
  let list: { name: string; code: number }[] = [];
  try { list = P.boardNets(doc); } catch (e) { list = []; }
  netCache = { doc, version, pro: E.proSettings, nets: list.map((n) => ({ name: n.name, code: n.code > 0 ? n.code : 0, netclass: classOf(n.name) })), classes };
  return netCache;
}

/** The net class a net belongs to (project net settings: assignments, then patterns, else Default). */
export function netClassOf(name: string): string { const n = nets().nets.find((x) => x.name === name); return n ? n.netclass : "Default"; }

// ---------------------------------------------------------------- reading the editor's own toggles
const pcbState = () => { const P = pcbTools(); return P ? P.state : null; };
function inactiveMode(): InactiveMode { return !E.renderOpts.highContrast ? "normal" : E.renderOpts.inactiveHide ? "hide" : "dim"; }
function objectVisible(id: string): boolean {
  if (id === "grid") return !!E.gridOn;
  if (id === "ratsnest") { const s = pcbState(); return s ? !!s.showRatsnest : !user.objHidden.includes(id); }
  return !user.objHidden.includes(id);
}

function layerRows(doc: KDoc): LayerInfo[] {
  const pcbColor = KC().pcbColor;
  const hidden = E.hiddenLayers as Set<string>;
  return boardLayerKeys(doc).map((key) => {
    const def = pcbColor(key);
    return { key, name: layerDisplayName(doc, key), color: user.colors[key] || def, defaultColor: def, visible: !hidden.has(key), copper: isCu(key), tip: layerTip(key) };
  });
}
function allPresets(layers: string[]): Preset[] { return builtinPresets(layers).concat(proj.presets); }
function sameSet(a: string[], b: string[]): boolean { if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
function currentPreset(layers: LayerInfo[]): string | null {
  const vis = layers.filter((l) => l.visible).map((l) => l.key), flip = !!E.renderOpts.flip;
  const hiddenObjs = OBJECTS.filter((o) => !o.spacer && o.canHide !== false && !objectVisible(o.id)).map((o) => o.id);
  for (const p of allPresets(layers.map((l) => l.key))) {
    if (!sameSet(p.layers, vis) || p.flip !== flip) continue;
    if (p.hiddenObjects && !sameSet(p.hiddenObjects, hiddenObjs.filter((o) => !OBJECTS.find((d) => d.id === o)!.defaultHidden))) continue;
    return p.name;
  }
  return null;
}

/** Recompute the published Appearance state from the document, the editor's toggles and the saved prefs. */
export function publishAppearance(): void {
  const doc = kdoc();
  if (!doc || isSchDoc()) { panelStore.set({ appearance: Object.assign({}, panelStore.get().appearance, { layers: [], nets: [], netClasses: [], objects: [] }) }); return; }
  loadProj();
  const layers = layerRows(doc);
  const objects: ObjectRow[] = OBJECTS.map((o) => o.spacer ? { id: o.id, label: "", tip: "", spacer: true }
    : { id: o.id, label: o.label, tip: o.tip, canHide: o.canHide !== false, visible: o.canHide === false ? undefined : objectVisible(o.id), opacity: o.opacity ? objOpacity(o) : undefined });
  const n = nets(); const s = pcbState();
  const hiddenNets = s ? s.hiddenNets : new Set(proj.hiddenNets);
  const netRows: NetRow[] = n.nets.map((x) => ({ name: x.name, code: x.code, color: proj.netColors[x.name] || null, visible: !hiddenNets.has(x.name), netclass: x.netclass }));
  const classRows: NetClassRow[] = n.classes.map((name) => ({ name, color: proj.classColors[name] || null, visible: !proj.hiddenClasses.includes(name) }));
  const names = layers.map((l) => l.key);
  const ap: AppearanceState = {
    layers, active: E.activeLayer || "", objects, nets: netRows, netClasses: classRows,
    inactive: inactiveMode(), flip: !!E.renderOpts.flip, netColorMode: user.netColorMode, ratsnestMode: user.ratsnestMode,
    presets: allPresets(names).map((p) => p.name), builtinPresets: builtinPresets(names).map((p) => p.name), preset: currentPreset(layers),
    viewports: proj.viewports.map((v) => v.name), viewport: proj.viewport,
  };
  panelStore.set({ appearance: ap });
}

/** Push the saved prefs into the renderer options and the pcb module's ratsnest state, then repaint. */
export function applyAppearance(): void {
  const doc = kdoc(); if (!doc || isSchDoc()) return;
  loadProj();
  const ro = E.renderOpts as Record<string, unknown>;
  const colors = new Map(Object.entries(user.colors));
  ro.layerColors = colors.size ? colors : undefined;
  const hide = new Set(user.objHidden.filter((id) => !["grid", "ratsnest", "anchors", "lockedShadow", "drawingSheet", "drcWarnings", "drcErrors", "drcExclusions", "conflicts", "boardArea", "subgrids", "viaStitching", "constraintShadow"].includes(id)));
  const show = new Set<string>(); for (const id of ["anchors", "lockedShadow", "boardArea"]) if (!user.objHidden.includes(id)) show.add(id);
  // every opacity row goes to the renderer: zones and images default to 0.6, which is not the renderer's own default
  const opacity: Record<string, number> = {}; for (const o of OBJECTS) if (o.opacity) opacity[o.id] = objOpacity(o);
  ro.objects = { hide, show, opacity };
  const P = pcbTools();
  if (show.has("lockedShadow") && P) { const ids = new Set<string>(); for (const it of doc.items.values()) { try { if (P.isLocked(it.node)) ids.add(it.id); } catch (e) { /* not lockable */ } } ro.lockedIds = ids; }
  else ro.lockedIds = undefined;
  ro.frame = user.objHidden.includes("drawingSheet") ? false : undefined;
  // LAYER_BOARD_OUTLINE_AREA: the board outline filled under everything (PCB_PAINTER::draw( PCB_BOARD_OUTLINE ))
  if (show.has("boardArea") && P && (P as unknown as { boardOutline?: (d: KDoc) => { outline: number[][] | null } }).boardOutline) {
    try { const o = (P as unknown as { boardOutline: (d: KDoc) => { outline: number[][] | null } }).boardOutline(doc).outline; ro.boardArea = o && o.length > 2 ? [o] : undefined; } catch (e) { ro.boardArea = undefined; }
  } else ro.boardArea = undefined;
  // net colours: a net's own colour wins over its class colour (NET_GRID_TABLE / netclass colours)
  const n = nets(); const byName = new Map<string, string>(), byCode = new Map<number, string>();
  for (const x of n.nets) { const c = proj.netColors[x.name] || proj.classColors[x.netclass]; if (c) { byName.set(x.name, c); if (x.code > 0) byCode.set(x.code, c); } }
  ro.netColors = user.netColorMode === "all" && byCode.size ? byCode : undefined;
  // boards that name nets inline carry no net codes: colour by item (pads by their index in the footprint)
  let itemColors: Map<string, string | (string | undefined)[]> | undefined;
  if (user.netColorMode === "all" && byName.size) {
    const h = (window.CollabTools.props as unknown as { helpers: { netNameOf(doc: KDoc, n: SNode): string } }).helpers, K = KC();
    itemColors = new Map();
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") { let any = false; const arr = K.kids(it.node, "pad").map((p) => { const c = byName.get(h.netNameOf(doc, p)); if (c) any = true; return c; }); if (any) itemColors.set(it.id, arr); }
      else if (K.kid(it.node, "net")) { const c = byName.get(h.netNameOf(doc, it.node)); if (c) itemColors.set(it.id, c); }
    }
  }
  ro.itemColors = itemColors && itemColors.size ? itemColors : undefined;
  const s = pcbState();
  if (s) {
    const hiddenNets = new Set(proj.hiddenNets);
    for (const x of n.nets) if (proj.hiddenClasses.includes(x.netclass)) hiddenNets.add(x.name);
    s.hiddenNets = hiddenNets;
    s.ratsnestColors = user.netColorMode !== "off" && byName.size ? byName : null;
    s.netColorMode = user.netColorMode;
    s.showCourtyardConflicts = !user.objHidden.includes("conflicts");   // LAYER_CONFLICTS_SHADOW   // the router preview takes net colours only in the "all" mode (ROUTER_PREVIEW_ITEM::getLayerColor)
    const sev = new Set<string>(); for (const [id, name] of Object.entries(SEVERITY)) if (user.objHidden.includes(id)) sev.add(name);
    s.hiddenSeverities = sev.size ? sev : null;
  }
  const markers = (E.markers as { severity?: string }[]) || [];
  const shown = markers.filter((m) => !(m.severity === "warning" && user.objHidden.includes("drcWarnings")) && !(m.severity === "error" && user.objHidden.includes("drcErrors")) && !(m.severity === "exclusion" && user.objHidden.includes("drcExclusions")));
  ro.markers = shown.length ? shown : undefined;
  store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) });
  requestRender();
}

// ---------------------------------------------------------------- layer visibility
function setHidden(hidden: Set<string>): void {
  E.hiddenLayers = hidden; proj.hidden = Array.from(hidden); saveProj();
  store.slice("document", { hiddenLayers: Array.from(hidden) });
  requestRender();
}
function layerKeys(): string[] { const doc = kdoc(); return doc ? boardLayerKeys(doc) : []; }
function setVisibleLayers(visible: string[]): void { const v = new Set(visible); setHidden(new Set(layerKeys().filter((l) => !v.has(l)))); }

function setFlip(on: boolean): void { E.renderOpts.flip = !!on; setToggles({ flipBoard: !!on }); }
function setInactive(mode: InactiveMode, save = true): void {
  E.renderOpts.highContrast = mode !== "normal"; E.renderOpts.inactiveHide = mode === "hide";
  setToggles({ highContrastMode: mode !== "normal" });
  // PCB_DISPLAY_OPTIONS::m_ContrastModeDisplay is the project's local setting ("board.high_contrast_mode" in the
  // .kicad_prl, PROJECT_LOCAL_SETTINGS), kept with the other .kicad_prl items of this project, not in the board file
  if (save && (proj.contrastMode || "normal") !== mode) { if (mode === "normal") delete proj.contrastMode; else proj.contrastMode = mode; saveProj(); }
}
/** The board's inactive layer display mode (Preferences ▸ PCB Editor ▸ Display Options reads and sets it too). */
export function getInactiveMode(): InactiveMode { return inactiveMode(); }
export function setInactiveMode(mode: InactiveMode): void { if (isSchDoc() || !kdoc()) return; setInactive(mode); applyAppearance(); publishAppearance(); }
const CONTRAST_LABELS: [InactiveMode, string][] = [["normal", "Normal"], ["dim", "Dimmed"], ["hide", "Hidden"]];
/** View ▸ Inactive Layer View Mode (ACTIONS::highContrastMode, PCB_CONTROL::HighContrastMode): normal ⇄ dimmed. */
export function toggleInactiveMode(): void {
  if (isSchDoc()) return;
  setInactive(inactiveMode() === "normal" ? "dim" : "normal"); applyAppearance(); publishAppearance();
}
/**
 * H — Inactive Layer View Mode (3-state) (ACTIONS::highContrastModeCycle, PCB_CONTROL::HighContrastModeCycle):
 * normal → dimmed → hidden → normal, with the HOTKEY_CYCLE_POPUP feedback of ContrastModeFeedback.
 */
export function cycleInactiveMode(): void {
  if (isSchDoc()) return;
  const cur = inactiveMode(), next: InactiveMode = cur === "normal" ? "dim" : cur === "dim" ? "hide" : "normal";
  setInactive(next); applyAppearance(); publishAppearance();
  hotkeyCyclePopup("Inactive Layer Display", CONTRAST_LABELS.map((l) => l[1]), CONTRAST_LABELS.findIndex((l) => l[0] === next));
}
// PCB_CONTROL::LayerAlphaInc / LayerAlphaDec: the active layer's colour alpha in steps of 0.05, kept within 0.2 .. 1
const ALPHA_MIN = 0.2, ALPHA_MAX = 1, ALPHA_STEP = 0.05;
/** { and } — Decrease / Increase Layer Opacity: the active layer's colour in the user's colour theme. */
export function layerAlphaStep(dir: 1 | -1): boolean {
  const doc = kdoc(), key = E.activeLayer as string; if (!doc || isSchDoc() || !key) return false;
  const K = KC(), cur = user.colors[key] || K.pcbColor(key), [r, g, b, a] = parseColor(cur);
  const want = Math.round((a + dir * ALPHA_STEP) * 100) / 100;
  if (dir > 0 ? a > ALPHA_MAX - ALPHA_STEP + 1e-6 : a < ALPHA_MIN + ALPHA_STEP - 1e-6) return false;   // KiCad rings the bell
  // from below the floor (the picker's Opacity slider goes to 0) } steps up from there, as KiCad does; the
  // renderer draws anything under 0.2 at 0.2 (PCB_RENDER_SETTINGS::LoadColors)
  const c = rgba(r, g, b, Math.max(0, Math.min(ALPHA_MAX, want)));
  if (c.toLowerCase() === K.pcbColor(key).toLowerCase()) delete user.colors[key]; else user.colors[key] = c;
  saveUser(); applyAppearance(); publishAppearance();
  return true;
}
function applyPreset(p: Preset): void {
  setVisibleLayers(p.layers);
  if (p.hiddenObjects) { user.objHidden = OBJECTS.filter((o) => o.defaultHidden).map((o) => o.id).concat(p.hiddenObjects.filter((o) => !OBJECTS.find((d) => d.id === o)?.defaultHidden)); saveUser(); setGridAndRatsnest(); }
  setFlip(p.flip);
  if (p.active && layerKeys().includes(p.active)) setActiveLayer(p.active);
}
function setGridAndRatsnest(): void {
  const wantGrid = !user.objHidden.includes("grid");
  if (!!E.gridOn !== wantGrid) { E.gridOn = wantGrid; setToggles({ toggleGrid: wantGrid }); store.slice("viewport", { gridOn: wantGrid }); }
}

function layerMenu(cmd: LayerMenuCmd): void {
  const all = layerKeys(), hidden = new Set(E.hiddenLayers as Set<string>);
  const cu = all.filter(isCu), nonCu = all.filter((l) => !isCu(l));
  const preset = (name: string) => { const p = builtinPresets(all).find((x) => x.name === name); if (p) applyPreset(p); };
  switch (cmd) {
    case "showAllCu": for (const l of cu) hidden.delete(l); setHidden(hidden); break;
    case "hideAllCu": for (const l of cu) hidden.add(l); setHidden(hidden); break;
    case "hideAllButActive": setHidden(new Set(all.filter((l) => l !== E.activeLayer))); break;
    case "showAllNonCu": for (const l of nonCu) hidden.delete(l); setHidden(hidden); break;
    case "hideAllNonCu": for (const l of nonCu) hidden.add(l); setHidden(hidden); break;
    case "showAll": preset("All Layers"); break;
    case "hideAll": preset("No Layers"); break;
    case "frontAssembly": preset("Front Assembly View"); break;
    case "front": preset("Front Layers"); break;
    case "inner": preset("Inner Copper Layers"); break;
    case "back": preset("Back Layers"); break;
    case "backAssembly": preset("Back Assembly View"); break;
  }
}

// ---------------------------------------------------------------- nets
function netIds(names: string[], kinds?: string[]): Set<string> {
  const doc = kdoc(), P = pcbTools(), out = new Set<string>(); if (!doc || !P) return out;
  for (const name of names) for (const id of P.netItemIds(doc, name)) { const it = doc.items.get(id); if (it && (!kinds || kinds.includes(it.kind))) out.add(id); }
  return out;
}
function netCommand(cmd: NetCmd, names: string[], label: string): void {
  const ctx = tctx();
  if (cmd === "highlight") { const ids = netIds(names); ctx.setHighlight(ids.size ? ids : null); const s = pcbState(); if (s) s.highlightNet = names[0] || null; if (!ids.size) toast(`Nothing on ${label}`); return; }
  if (cmd === "select" || cmd === "unselect") {
    const ids = netIds(names, ["segment", "arc", "via"]);
    const cur = new Set<string>(E.selection as Set<string>); const s = pcbState(); if (s) for (const id of s.sel) cur.add(id);
    if (cmd === "select") for (const id of ids) cur.add(id); else for (const id of ids) cur.delete(id);
    if (s) s.sel.clear();
    (ctx as unknown as { setSelection(ids: string[]): void }).setSelection(Array.from(cur));
    return;
  }
}

async function savePreset(): Promise<void> {
  const st = panelStore.get().appearance; const builtin = st.builtinPresets;
  const name = await textEntry("Save Layer Preset", "Layer preset name:", st.preset && !builtin.includes(st.preset) ? st.preset : "");
  if (name === null) return; const nm = name.trim(); if (!nm) return;
  if (builtin.includes(nm)) { toast("Default presets cannot be modified. Please use a different name.", 3500); return; }
  const p: Preset = { name: nm, layers: st.layers.filter((l) => l.visible).map((l) => l.key), hiddenObjects: OBJECTS.filter((o) => !o.spacer && o.canHide !== false && !o.defaultHidden && !objectVisible(o.id)).map((o) => o.id), flip: st.flip, active: st.active };
  const i = proj.presets.findIndex((x) => x.name === nm);
  if (i >= 0) { if (!await confirmBox("Save Layer Preset", "Overwrite existing preset?", "Overwrite")) return; proj.presets[i] = p; } else proj.presets.push(p);
  saveProj(); publishAppearance();
}
async function deletePreset(): Promise<void> {
  if (!proj.presets.length) { toast("No user presets to delete"); return; }
  const name = await listPick("Delete Preset", "Select preset:", "Presets", proj.presets.map((p) => p.name));
  if (!name) return;
  proj.presets = proj.presets.filter((p) => p.name !== name); saveProj(); publishAppearance();
}
async function saveViewport(): Promise<void> {
  const name = await textEntry("Save Viewport", "Viewport name:", ""); if (name === null) return; const nm = name.trim(); if (!nm) return;
  const r = visibleRectNm() as number[] | null; if (!r) return;
  const rect = r.map((v) => v / (E.IU as number)) as [number, number, number, number];
  const i = proj.viewports.findIndex((v) => v.name === nm);
  if (i >= 0) proj.viewports[i] = { name: nm, rect }; else proj.viewports.push({ name: nm, rect });
  proj.viewport = nm; saveProj(); publishAppearance();
}
async function deleteViewport(): Promise<void> {
  if (!proj.viewports.length) { toast("No viewports to delete"); return; }
  const name = await listPick("Delete Viewport", "Select viewport:", "Viewports", proj.viewports.map((v) => v.name));
  if (!name) return;
  proj.viewports = proj.viewports.filter((v) => v.name !== name); if (proj.viewport === name) proj.viewport = null; saveProj(); publishAppearance();
}

/** The Appearance pane's intents; returns false for an action that is not ours. */
export function appearanceDispatch(a: PanelAction): boolean {
  loadProj();
  switch (a.t) {
    case "layerVisible": { const h = new Set(E.hiddenLayers as Set<string>); if (a.on) h.delete(a.key); else h.add(a.key); setHidden(h); break; }
    case "layerActive": setActiveLayer(a.key); break;
    case "layerColor": if (a.color) user.colors[a.key] = a.color; else delete user.colors[a.key]; saveUser(); break;
    case "layerMenu": layerMenu(a.cmd); break;
    case "objVisible": {
      const set = new Set(user.objHidden); if (a.on) set.delete(a.id); else set.add(a.id); user.objHidden = Array.from(set); saveUser();
      if (a.id === "grid") setGridAndRatsnest();
      if (a.id === "ratsnest") { const s = pcbState(); if (s) s.showRatsnest = a.on; }
      break;
    }
    case "objOpacity": user.objOpacity[a.id] = Math.max(0, Math.min(1, a.value)); saveUser(); break;
    case "inactive": setInactive(a.mode); break;
    case "flip": setFlip(a.on); break;
    case "netVisible": { const s = new Set(proj.hiddenNets); if (a.on) s.delete(a.name); else s.add(a.name); proj.hiddenNets = Array.from(s); saveProj(); break; }
    case "netColor": if (a.color) proj.netColors[a.name] = a.color; else delete proj.netColors[a.name]; saveProj(); break;
    case "netCmd":
      if (a.cmd === "showAll") { proj.hiddenNets = []; saveProj(); }
      else if (a.cmd === "hideOthers") { proj.hiddenNets = nets().nets.map((n) => n.name).filter((n) => n !== a.name); saveProj(); }
      else netCommand(a.cmd, [a.name], a.name);
      break;
    case "classVisible": { const s = new Set(proj.hiddenClasses); if (a.on) s.delete(a.name); else s.add(a.name); proj.hiddenClasses = Array.from(s); saveProj(); break; }
    case "classColor": if (a.color) proj.classColors[a.name] = a.color; else delete proj.classColors[a.name]; saveProj(); break;
    case "classCmd":
      if (a.cmd === "showAll") { proj.hiddenClasses = []; saveProj(); }
      else if (a.cmd === "hideOthers") { proj.hiddenClasses = nets().classes.filter((c) => c !== a.name); saveProj(); }
      else netCommand(a.cmd, nets().nets.filter((n) => n.netclass === a.name).map((n) => n.name), a.name);
      break;
    case "netColorMode": user.netColorMode = a.mode; saveUser(); break;
    case "ratsnestMode": { user.ratsnestMode = a.mode; saveUser(); const s = pcbState(); if (s) s.showRatsnest = a.mode !== "none"; user.objHidden = user.objHidden.filter((o) => o !== "ratsnest").concat(a.mode === "none" ? ["ratsnest"] : []); break; }
    case "preset": { const p = allPresets(layerKeys()).find((x) => x.name === a.name); if (p) applyPreset(p); break; }
    case "presetSave": void savePreset(); return true;
    case "presetDelete": void deletePreset(); return true;
    case "viewport": { const v = proj.viewports.find((x) => x.name === a.name); if (v) { E.viewTouched = true; fitBox(v.rect, 1); proj.viewport = v.name; saveProj(); } break; }
    case "viewportSave": void saveViewport(); return true;
    case "viewportDelete": void deleteViewport(); return true;
    default: return false;
  }
  applyAppearance(); publishAppearance();
  return true;
}

/** A board was opened: bring back this project's layer visibility, then apply and publish everything. */
export function appearanceDocOpened(): void {
  if (isSchDoc() || !kdoc()) { publishAppearance(); return; }
  loadProj();
  if (proj.hidden) { const keys = new Set(layerKeys()); E.hiddenLayers = new Set(proj.hidden.filter((l) => keys.has(l))); store.slice("document", { hiddenLayers: Array.from(E.hiddenLayers as Set<string>) }); }
  if (user.objHidden.includes("grid") && E.gridOn) setGridAndRatsnest();
  const m = proj.contrastMode, mode: InactiveMode = m === "dim" || m === "hide" ? m : "normal";
  if (mode !== inactiveMode()) setInactive(mode, false);
  applyAppearance(); publishAppearance();
}

/** The object class a board item is drawn under (Appearance ▸ Objects), for hit-test gating: a hidden class is not pickable. */
export function itemObjectHidden(it: KItem): boolean {
  if (isSchDoc()) return false;
  const h = user.objHidden;
  if (!h.length) return false;
  switch (it.kind) {
    case "segment": case "arc": return h.includes("tracks");
    case "via": return h.includes("vias");
    case "zone": return h.includes("zones");
    case "image": return h.includes("images");
    case "footprint": return h.includes(it.layer && /^B\./.test(it.layer) ? "fpBack" : "fpFront");
    default: return false;
  }
}
