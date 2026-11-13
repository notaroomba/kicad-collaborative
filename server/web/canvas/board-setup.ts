// kicad-canvas / board-setup — the board-level sections of a .kicad_pcb that Board Setup edits:
// (general …), (layers …) and (setup …) with its (stackup …).  Reading them out of the file text, the
// layer table of PANEL_SETUP_LAYERS, the physical stackup rows, solder mask / paste and board finish
// values, and writing the sections back the way PCB_IO_KICAD_SEXPR::formatBoardLayers / formatSetup and
// BOARD_STACKUP::FormatBoardStackup do.
//
// These sections are not items, so they do not travel in item ops.  The web carries them in one change
// of its own — { id: "board-setup", kind: "MODIFIED", typeName: "BOARD_SETUP", properties: [{ name:
// "layers" | "setup" | "general", after: { type: "sexpr", v: "(layers …)" } }] } — which every web client
// applies (applyBoardSetup) and the desktop skips as an unknown item.
// Pure functions; KiCadCanvas.boardSetup for the node tests.
import { kid, kids, num, parse, quotedMask, str } from "./sexpr";
import { type PlotParams, plotParamsText, readPlotParams } from "./plot-params";

const isList = Array.isArray;
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
const kidStr = (node: SNode | null, key: string): string => { const k = node ? (kid(node, key) as SNode | null) : null; return k ? str(k[1]) : ""; };
const kidNum = (node: SNode | null, key: string, def = 0): number => { const k = node ? (kid(node, key) as SNode | null) : null; return k ? num(k[1], def) : def; };
const yes = (node: SNode | null, key: string, def: boolean): boolean => { const k = node ? (kid(node, key) as SNode | null) : null; return k ? str(k[1]) !== "no" : def; };
const fmt = (v: number): string => String(+(+v).toFixed(6));

// ---------------------------------------------------------------- the sections in a file
export interface BoardHeader { general: SNode | null; layers: SNode | null; setup: SNode | null; version: number; variants?: SNode | null }
const HEADER_KEYS = new Set(["general", "layers", "setup", "version", "variants"]);
/**
 * The header sections of a board file, without parsing the whole board: the top level is walked by
 * parentheses and only the wanted lists go through the reader.
 */
export function boardHeader(text: string): BoardHeader {
  const out: BoardHeader = { general: null, layers: null, setup: null, version: 0 };
  const n = text.length;
  let i = text.indexOf("(kicad_pcb"); if (i < 0) return out;
  i += 10;
  let found = 0;
  while (i < n && found < 5) {
    const c = text[i];
    if (c === "(") {
      // the keyword
      let j = i + 1; while (j < n && /[A-Za-z_0-9]/.test(text[j])) j++;
      const key = text.slice(i + 1, j);
      // the matching parenthesis
      let depth = 0, k = i;
      for (; k < n; k++) {
        const ch = text[k];
        if (ch === '"') { k++; while (k < n && text[k] !== '"') { if (text[k] === "\\") k++; k++; } }
        else if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (!depth) break; }
      }
      if (HEADER_KEYS.has(key)) {
        const node = parse(text.slice(i, k + 1)) as SNode | null;
        if (node) { if (key === "version") out.version = num(node[1], 0); else if (key === "general") out.general = node; else if (key === "layers") out.layers = node; else if (key === "variants") out.variants = node; else out.setup = node; found++; }
      } else if (key === "footprint" || key === "segment" || key === "via" || key === "zone" || key === "gr_line") break;   // the header is over
      i = k + 1;
    } else if (c === ")") break;
    else i++;
  }
  return out;
}

// ---------------------------------------------------------------- layers (PANEL_SETUP_LAYERS)
export interface LayerRow {
  /** the canonical name ("F.Cu", "User.1") */
  name: string; id: number;
  /** signal | power | mixed | jumper for copper; user | front | back for the rest */
  type: string;
  /** the user's name for it, "" when it is the canonical one */
  userName: string;
  enabled: boolean; copper: boolean;
  /** required layers cannot be switched off */
  mandatory: boolean;
  /** the panel's description column */
  description: string;
  userDefined: boolean;
}
const D_ON = "On-board, non-copper", D_AUX = "Auxiliary";
/** [canonical name, id, default user name, description, mandatory] in the panel's row order around the copper stack. */
const FRONT_TECH: [string, number, string, string, boolean][] = [
  ["F.CrtYd", 31, "F.Courtyard", "Off-board, testing", true], ["F.Fab", 35, "F.Fab", "Off-board, manufacturing", false], ["F.Adhes", 9, "F.Adhesive", D_ON, false],
  ["F.Paste", 13, "F.Paste", D_ON, false], ["F.SilkS", 5, "F.Silkscreen", D_ON, false], ["F.Mask", 1, "F.Mask", D_ON, false]];
const BACK_TECH: [string, number, string, string, boolean][] = [
  ["B.Mask", 3, "B.Mask", D_ON, false], ["B.SilkS", 7, "B.Silkscreen", D_ON, false], ["B.Paste", 15, "B.Paste", D_ON, false],
  ["B.Adhes", 11, "B.Adhesive", D_ON, false], ["B.Fab", 33, "B.Fab", "Off-board, manufacturing", false], ["B.CrtYd", 29, "B.Courtyard", "Off-board, testing", true]];
const OTHER: [string, number, string, string, boolean][] = [
  ["Edge.Cuts", 25, "Edge.Cuts", "Board contour", true], ["Margin", 27, "Margin", "Board contour setback", true], ["Eco1.User", 21, "User.Eco1", D_AUX, false],
  ["Eco2.User", 23, "User.Eco2", D_AUX, false], ["Cmts.User", 19, "User.Comments", D_AUX, false], ["Dwgs.User", 17, "User.Drawings", D_AUX, false]];
/** LSET::TechAndUserUIOrder — the order formatBoardLayers writes the non-copper layers in. */
const FILE_ORDER = ["F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
export const MAX_USER_LAYERS = 45;
export const copperLayerId = (name: string): number => (name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : 2 * (Number(/^In(\d+)\.Cu$/.exec(name)?.[1] || 0) + 1));
export const userLayerId = (n: number): number => 39 + 2 * (n - 1);
/** The copper stack for a layer count: F.Cu, In1.Cu … In(n-2).Cu, B.Cu. */
export function copperNames(count: number): string[] { const out = ["F.Cu"]; for (let i = 1; i <= count - 2; i++) out.push(`In${i}.Cu`); out.push("B.Cu"); return out; }
export const COPPER_TYPES: [string, string][] = [["signal", "signal"], ["power", "power plane"], ["mixed", "mixed"], ["jumper", "jumper"]];
export const USER_TYPES: [string, string][] = [["user", "Auxiliary"], ["front", "Off-board, front"], ["back", "Off-board, back"]];

/** True when the file numbers its layers the way KiCad 9 and later do (B.Cu is 2, not 31). */
export function modernLayerIds(layers: SNode | null): boolean {
  if (!layers) return true;
  for (const l of layers.slice(1)) if (isList(l) && str(l[1]) === "B.Cu") return num(l[0], 2) === 2;
  return true;
}

/** The panel's rows for a (layers …) section: every layer KiCad offers, enabled or not. */
export function layerRows(layers: SNode | null): LayerRow[] {
  const have = new Map<string, { type: string; userName: string; id: number }>();
  const cu: string[] = [];
  for (const l of (layers || []).slice(1)) {
    if (!isList(l)) continue;
    const name = str(l[1]), type = str(l[2]);
    have.set(name, { type, userName: l[3] !== undefined ? str(l[3]) : "", id: num(l[0], 0) });
    if (/\.Cu$/.test(name)) cu.push(name);
  }
  const stack = cu.length >= 2 ? copperNames(cu.length) : copperNames(2);
  const rows: LayerRow[] = [];
  const tech = (t: [string, number, string, string, boolean]): void => {
    const h = have.get(t[0]);
    rows.push({ name: t[0], id: t[1], type: "user", userName: h && h.userName ? h.userName : "", enabled: !!h || !layers, copper: false, mandatory: t[4], description: t[3], userDefined: false });
  };
  FRONT_TECH.forEach(tech);
  for (const name of stack) { const h = have.get(name); rows.push({ name, id: copperLayerId(name), type: h ? h.type : "signal", userName: h ? h.userName : "", enabled: true, copper: true, mandatory: true, description: "", userDefined: false }); }
  BACK_TECH.forEach(tech);
  OTHER.forEach(tech);
  for (let n = 1; n <= MAX_USER_LAYERS; n++) {
    const name = `User.${n}`, h = have.get(name); if (!h) continue;
    rows.push({ name, id: userLayerId(n), type: h.type === "front" || h.type === "back" ? h.type : "user", userName: h.userName, enabled: true, copper: false, mandatory: false, description: "", userDefined: true });
  }
  return rows;
}
/** The default (KiCad UI) name of a layer: what the name box shows when the user gave none. */
export function defaultLayerName(name: string): string {
  for (const t of [...FRONT_TECH, ...BACK_TECH, ...OTHER]) if (t[0] === name) return t[2];
  return name;
}
/** Why a layer name is not acceptable, or "" (PANEL_SETUP_LAYERS::testLayerNames). */
export function layerNameError(rows: LayerRow[], row: LayerRow, name: string): string {
  if (!name) return "Layer must have a name.";
  if (/[ %$"\\/]/.test(name)) return `%, $, \", \\, / and spaces are forbidden in layer names.`.replace("%, ", "%, ");
  const shown = (r: LayerRow): string => r.userName || (r.copper || r.userDefined ? r.name : defaultLayerName(r.name));
  for (const r of rows) if (r !== row && r.enabled && (shown(r) === name || r.name === name)) return `Layer name '${name}' already in use.`;
  return "";
}

/** (layers …) for the rows, in formatBoardLayers' order: the copper stack, then the technical and user layers. */
export function layersText(rows: LayerRow[]): string {
  const on = rows.filter((r) => r.enabled);
  const line = (r: LayerRow): string => `(${r.id} ${quote(r.name)} ${r.type}${r.userName && r.userName !== r.name ? " " + quote(r.userName) : ""})`;
  const out: string[] = [];
  for (const r of on) if (r.copper) out.push(line(r));
  for (const name of FILE_ORDER) { const r = on.find((x) => x.name === name); if (r) out.push(line(r)); }
  for (const r of on) if (r.userDefined) out.push(line(r));
  return "(layers " + out.join(" ") + ")";
}
/** Set the copper layer count of the rows (2, 4 … 32): inner layers appear as signal layers or go away. */
export function setCopperCount(rows: LayerRow[], count: number): LayerRow[] {
  const n = Math.max(2, Math.min(32, count)), stack = copperNames(n);
  const old = new Map(rows.filter((r) => r.copper).map((r) => [r.name, r]));
  const cu: LayerRow[] = stack.map((name) => old.get(name) || { name, id: copperLayerId(name), type: "signal", userName: "", enabled: true, copper: true, mandatory: true, description: "", userDefined: false });
  const first = rows.findIndex((r) => r.copper), rest = rows.filter((r) => !r.copper);
  return [...rest.slice(0, first), ...cu, ...rest.slice(first)];
}

// ---------------------------------------------------------------- physical stackup (PANEL_SETUP_BOARD_STACKUP)
export interface StackupRow { layer: string; id: string; type: string; material: string; thickness: number | null; locked: boolean; color: string; epsilonR: number | null; lossTangent: number | null; sub: boolean }
/** The rows of the Physical Stackup table for a (setup (stackup …)); [] when the board has no stackup. */
export function stackupRows(setup: SNode | null, userNames?: Map<string, string>): StackupRow[] {
  const st = setup ? (kid(setup, "stackup") as SNode | null) : null; if (!st) return [];
  const rows: StackupRow[] = [];
  for (const l of kids(st, "layer") as SNode[]) {
    const name = str(l[1]), diel = /^dielectric (\d+)$/.exec(name);
    // sub-layers of a dielectric follow an `addsublayer` atom: split the children there
    const groups: SNode[] = [["layer", name]];
    for (let j = 2; j < l.length; j++) { const c = l[j]; if (c === "addsublayer") groups.push(["layer", name]); else if (isList(c)) (groups[groups.length - 1] as SNode).push(c); }
    const type = kidStr(groups[0], "type");
    groups.forEach((g, gi) => {
      const th = kid(g, "thickness") as SNode | null;
      rows.push({ layer: diel ? `Dielectric ${diel[1]}${groups.length > 1 ? ` (${gi + 1}/${groups.length})` : ""}` : (userNames && userNames.get(name)) || name, id: diel ? diel[1] : "",
        type: type === "copper" ? "Copper" : type === "core" ? "Core" : type === "prepreg" ? "PrePreg" : type, material: kidStr(g, "material"),
        thickness: th ? num(th[1], 0) : null, locked: !!th && th.includes("locked"), color: kidStr(g, "color"),
        epsilonR: kid(g, "epsilon_r") ? kidNum(g, "epsilon_r") : null, lossTangent: kid(g, "loss_tangent") ? kidNum(g, "loss_tangent") : null, sub: gi > 0 });
    });
  }
  return rows;
}
/** "Board thickness from stackup": copper and dielectric thicknesses plus the solder masks. */
export function stackupThickness(rows: StackupRow[]): number {
  let t = 0; for (const r of rows) if (r.thickness !== null && (r.type === "Copper" || r.type === "Core" || r.type === "PrePreg" || /Solder Mask/.test(r.type))) t += r.thickness;
  return +t.toFixed(6);
}

export const COPPER_FINISHES = ["None", "ENIG", "ENEPIG", "HAL SnPb", "HAL lead-free", "Hard gold", "Immersion tin", "Immersion nickel", "Immersion silver", "Immersion gold", "HT_OSP", "OSP", "User defined"];
export interface BoardFinish { copperFinish: string; edgeConnector: "no" | "yes" | "bevelled"; edgePlating: boolean; hasStackup: boolean }
export function boardFinish(setup: SNode | null): BoardFinish {
  const st = setup ? (kid(setup, "stackup") as SNode | null) : null;
  const ec = kidStr(st, "edge_connector");
  return { copperFinish: kidStr(st, "copper_finish") || "None", edgeConnector: ec === "bevelled" ? "bevelled" : ec === "yes" ? "yes" : "no", edgePlating: yes(st, "edge_plating", false), hasStackup: !!st };
}

export interface MaskPaste { maskExpansion: number; maskMinWidth: number; pasteClearance: number; pasteRatio: number; allowBridges: boolean; tentFront: boolean; tentBack: boolean }
export function maskPaste(setup: SNode | null): MaskPaste {
  const tent = setup ? (kid(setup, "tenting") as SNode | null) : null;
  // KiCad 8 wrote (tenting front back); 9 and later (tenting (front yes) (back yes))
  const legacy = tent && tent.slice(1).some((x) => !isList(x));
  return { maskExpansion: kidNum(setup, "pad_to_mask_clearance"), maskMinWidth: kidNum(setup, "solder_mask_min_width"), pasteClearance: kidNum(setup, "pad_to_paste_clearance"),
    pasteRatio: kidNum(setup, "pad_to_paste_clearance_ratio"), allowBridges: yes(setup, "allow_soldermask_bridges_in_footprints", false),
    tentFront: tent ? (legacy ? tent.includes("front") : yes(tent, "front", true)) : true, tentBack: tent ? (legacy ? tent.includes("back") : yes(tent, "back", true)) : true };
}
export interface DashRatios { dash: number; gap: number }
export function dashRatios(setup: SNode | null): DashRatios {
  const pp = setup ? (kid(setup, "pcbplotparams") as SNode | null) : null;
  return { dash: kidNum(pp, "dashed_line_dash_ratio", 12), gap: kidNum(pp, "dashed_line_gap_ratio", 3) };
}

// ---------------------------------------------------------------- the drill chart (PANEL_SETUP_DRILL_CHART, DRILL_SYMBOL_PROFILE)
export const DRILL_GROUP_KEYS = ["size", "slot", "plating", "span", "operation", "hole_function", "protection", "post_machining"];
export const DRILL_MARK_POLICIES = ["shapes", "letters", "shapes_then_letters", "size_text"];
export interface DrillProfile { groupBy: string[]; markPolicy: string; size: number; width: number; freeze: boolean }
export const DRILL_PROFILE_DEFAULT: DrillProfile = { groupBy: ["size", "slot", "plating", "span", "operation", "post_machining"], markPolicy: "shapes_then_letters", size: 1.5, width: 0.15, freeze: true };
export function drillProfile(setup: SNode | null): DrillProfile {
  const p = setup ? (kid(setup, "drill_symbol_profile") as SNode | null) : null;
  if (!p) return { ...DRILL_PROFILE_DEFAULT, groupBy: DRILL_PROFILE_DEFAULT.groupBy.slice() };
  const g = kid(p, "group_by") as SNode | null;
  return { groupBy: g ? g.slice(1).map((x) => str(x)) : [], markPolicy: kidStr(p, "default_marks") || "shapes_then_letters", size: kidNum(p, "size", 1.5), width: kidNum(p, "width", 0.15), freeze: yes(p, "freeze_assignments", true) };
}
/** formatDrillSymbolProfile; null for the default profile (nothing is written).  The old node's name and assignments stay. */
function drillProfileText(d: DrillProfile, old: SNode | null): string | null {
  const keys = DRILL_GROUP_KEYS.filter((k) => d.groupBy.includes(k));
  const def = DRILL_PROFILE_DEFAULT;
  const rest = old ? old.slice(1).filter((c) => isList(c) && (c[0] === "name" || c[0] === "assignment")) as SNode[] : [];
  if (!rest.length && keys.join() === def.groupBy.join() && d.markPolicy === def.markPolicy && Math.abs(d.size - def.size) < 1e-9 && Math.abs(d.width - def.width) < 1e-9 && d.freeze === def.freeze) return null;
  const name = rest.filter((c) => c[0] === "name").map((c) => ser(c)).join("");
  return `(drill_symbol_profile${name}(group_by${keys.map((k) => " " + k).join("")})(default_marks ${d.markPolicy})(size ${fmt(d.size)})(width ${fmt(d.width)})(freeze_assignments ${d.freeze ? "yes" : "no"})${rest.filter((c) => c[0] === "assignment").map((c) => ser(c)).join("")})`;
}

// ---------------------------------------------------------------- writing the (setup …) section
/** Serialize a header node the way the reader marked it (strings quoted where the file had them quoted). */
function ser(node: SNode | string | number, quotedSlot = false): string {
  if (!isList(node)) return typeof node === "number" ? fmt(node) : quotedSlot || !(/^[A-Za-z_][\w.:*+-]*$/.test(node) || /^0x[0-9a-fA-F_]+$/.test(node)) ? quote(node) : node;
  const q = quotedMask(node) as number;
  return "(" + node.map((c, j) => ser(c as SNode | string | number, j > 0 && j < 30 && ((q >> j) & 1) === 1)).join(" ") + ")";
}
function replaceOrInsert(setup: SNode, key: string, text: string | null, before: string[]): void {
  const i = idxOf(setup, key);
  if (text === null) { if (i > 0) setup.splice(i, 1); return; }
  const node = parse(text) as SNode;
  if (i > 0) { setup[i] = node; return; }
  let at = setup.length;
  for (const b of before) { const j = idxOf(setup, b); if (j > 0) { at = j; break; } }
  setup.splice(at, 0, node);
}
const AFTER_MASK = ["solder_mask_min_width", "pad_to_paste_clearance", "pad_to_paste_clearance_ratio", "allow_soldermask_bridges_in_footprints", "tenting", "covering", "plugging", "capping", "filling", "zone_defaults", "aux_axis_origin", "grid_origin", "pcbplotparams"];
export interface SetupEdit { maskPaste?: MaskPaste; finish?: BoardFinish; dash?: DashRatios; copper?: string[]; boardThickness?: number; drillProfile?: DrillProfile; stackup?: string }
/**
 * A copy of the (setup …) node with the edits laid in, in formatSetup's order and omission rules (a zero
 * minimum web width, paste clearance or ratio is not written).  `copper` re-syncs the stackup's copper and
 * dielectric layers with a new copper stack (BOARD_STACKUP::SynchronizeWithBoard: existing layers keep
 * their values, new dielectrics get BuildDefaultStackupList's).
 */
export function editSetup(setup: SNode | null, e: SetupEdit): SNode {
  const out = (setup ? parse(ser(setup)) : parse("(setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no))")) as SNode;
  if (e.maskPaste) {
    const m = e.maskPaste;
    replaceOrInsert(out, "pad_to_mask_clearance", `(pad_to_mask_clearance ${fmt(m.maskExpansion)})`, AFTER_MASK);
    replaceOrInsert(out, "solder_mask_min_width", m.maskMinWidth ? `(solder_mask_min_width ${fmt(m.maskMinWidth)})` : null, AFTER_MASK.slice(1));
    replaceOrInsert(out, "pad_to_paste_clearance", m.pasteClearance ? `(pad_to_paste_clearance ${fmt(m.pasteClearance)})` : null, AFTER_MASK.slice(2));
    replaceOrInsert(out, "pad_to_paste_clearance_ratio", m.pasteRatio ? `(pad_to_paste_clearance_ratio ${fmt(m.pasteRatio)})` : null, AFTER_MASK.slice(3));
    replaceOrInsert(out, "allow_soldermask_bridges_in_footprints", `(allow_soldermask_bridges_in_footprints ${m.allowBridges ? "yes" : "no"})`, AFTER_MASK.slice(4));
    replaceOrInsert(out, "tenting", `(tenting (front ${m.tentFront ? "yes" : "no"}) (back ${m.tentBack ? "yes" : "no"}))`, AFTER_MASK.slice(5));
  }
  if (e.drillProfile) {
    // formatDrillSymbolProfile: written after grid_origin, before the plot parameters; a default profile writes nothing
    const old = kid(out, "drill_symbol_profile") as SNode | null;
    replaceOrInsert(out, "drill_symbol_profile", drillProfileText(e.drillProfile, old), ["pcbplotparams"]);
  }
  if (e.stackup) { const node = parse(e.stackup) as SNode, i = idxOf(out, "stackup"); if (i > 0) out[i] = node; else out.splice(1, 0, node); }
  if (e.dash) {
    const pp = kid(out, "pcbplotparams") as SNode | null;
    if (pp) { replaceOrInsert(pp, "dashed_line_dash_ratio", `(dashed_line_dash_ratio ${fmt(e.dash.dash)})`, ["dashed_line_gap_ratio", "svgprecision"]); replaceOrInsert(pp, "dashed_line_gap_ratio", `(dashed_line_gap_ratio ${fmt(e.dash.gap)})`, ["svgprecision"]); }
  }
  let st = kid(out, "stackup") as SNode | null;
  if (e.copper && st) {
    const thickness = e.boardThickness || 1.6, cuT = 0.035, n = e.copper.length;
    const masks = (kids(st, "layer") as SNode[]).filter((l) => /Solder Mask/.test(kidStr(l, "type"))).length;
    const dielT = +Math.max(0.01, (thickness - cuT * n - 0.01 * masks) / Math.max(1, n - 1)).toFixed(6);
    const oldCu = new Map<string, SNode>(), oldDiel = new Map<number, SNode>();
    let firstCu = -1, lastCu = -1;
    for (let j = 1; j < st.length; j++) {
      const l = st[j]; if (!isList(l) || l[0] !== "layer") continue;
      const name = str(l[1]), d = /^dielectric (\d+)$/.exec(name);
      if (d) oldDiel.set(Number(d[1]), l); else if (/\.Cu$/.test(name)) oldCu.set(name, l); else continue;
      if (firstCu < 0) firstCu = j; lastCu = j;
    }
    const mid: SNode[] = [];
    e.copper.forEach((name, k) => {
      mid.push(oldCu.get(name) || (parse(`(layer ${quote(name)} (type "copper") (thickness ${fmt(cuT)}))`) as SNode));
      if (k < n - 1) mid.push(oldDiel.get(k + 1) || (parse(`(layer "dielectric ${k + 1}" (type ${k % 2 === 0 ? '"core"' : '"prepreg"'}) (thickness ${fmt(dielT)}) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))`) as SNode));
    });
    if (firstCu > 0) st.splice(firstCu, lastCu - firstCu + 1, ...mid);
  }
  if (e.finish) {
    if (!st && (e.finish.copperFinish !== "None" || e.finish.edgeConnector !== "no" || e.finish.edgePlating)) { st = parse("(stackup (dielectric_constraints no))") as SNode; out.splice(1, 0, st); }
    if (st) {
      const f = e.finish, tail = ["dielectric_constraints", "edge_connector", "edge_plating"];
      replaceOrInsert(st, "copper_finish", `(copper_finish ${quote(f.copperFinish)})`, tail);
      replaceOrInsert(st, "edge_connector", f.edgeConnector === "no" ? null : `(edge_connector ${f.edgeConnector})`, ["edge_plating"]);
      replaceOrInsert(st, "edge_plating", f.edgePlating ? "(edge_plating yes)" : null, []);
    }
  }
  return out;
}
export const sectionText = (node: SNode): string => ser(node);

/** A copy of the (setup …) node with its (pcbplotparams …) replaced (appended when it has none: it is the section's last token). */
export function setupWithPlotParams(setup: SNode | null, p: PlotParams, version: number): SNode {
  const out = (setup ? parse(ser(setup)) : parse("(setup)")) as SNode;
  const node = parse(plotParamsText(p, version)) as SNode;
  for (let j = 1; j < out.length; j++) { const c = out[j]; if (isList(c) && c[0] === "pcbplotparams") { out[j] = node; return out; } }
  out.push(node);
  return out;
}

// ---------------------------------------------------------------- the BOARD_SETUP change
export const BOARD_SETUP_TYPE = "BOARD_SETUP";
export function boardSetupChange(sections: { layers?: string; setup?: string; general?: string }): KChange {
  const properties: NonNullable<KChange["properties"]> = [];
  for (const name of ["general", "layers", "setup"] as const) { const v = sections[name]; if (v) properties.push({ name, after: { type: "sexpr", v } }); }
  return { id: "board-setup", kind: "MODIFIED", typeName: BOARD_SETUP_TYPE, properties };
}
/** Lay a BOARD_SETUP change over header sections (a journal replay). */
export function applyHeaderChange(header: BoardHeader, change: KChange): BoardHeader {
  const out = { ...header };
  if (change.typeName !== BOARD_SETUP_TYPE) return out;
  for (const p of change.properties || []) {
    const v = p.after && typeof p.after.v === "string" ? (parse(p.after.v) as SNode | null) : null; if (!v) continue;
    if (p.name === "layers") out.layers = v; else if (p.name === "setup") out.setup = v; else if (p.name === "general") out.general = v; else if (p.name === "variants") out.variants = v;
  }
  return out;
}
/** Apply a BOARD_SETUP change to an open board document: its layer table and copper stack.  True when it was one. */
export function applyBoardSetup(doc: KDoc, change: KChange): boolean {
  if (!change || change.typeName !== BOARD_SETUP_TYPE || doc.type !== "pcb") return false;
  for (const p of change.properties || []) {
    if (p.name !== "layers" || !p.after || typeof p.after.v !== "string") continue;
    const node = parse(p.after.v) as SNode | null; if (!node) continue;
    doc.layers.clear(); doc.copper.length = 0;
    for (const l of node.slice(1)) {
      if (!isList(l)) continue;
      const name = str(l[1]), type = str(l[2]);
      doc.layers.set(name, { id: num(l[0], 0), type, userName: l[3] !== undefined ? str(l[3]) : "" });
      if (/\.Cu$/.test(name) && type !== "user") doc.copper.push(name);
    }
  }
  const d = doc as KDoc & { boardSetup?: BoardHeader; setupNode?: SNode | null; generalNode?: SNode | null; stackup?: SNode | null };
  d.boardSetup = applyHeaderChange(d.boardSetup || { general: null, layers: null, setup: null, version: 0 }, change);
  for (const p of change.properties || []) {
    // the physical stackup and the board thickness follow the sections (impedance work and the 3D view read them)
    if (p.name === "setup" && d.boardSetup.setup) { d.setupNode = d.boardSetup.setup; d.stackup = (kid(d.boardSetup.setup, "stackup") as SNode | null) || null; }
    if (p.name === "general" && d.boardSetup.general) { d.generalNode = d.boardSetup.general; const t = kid(d.boardSetup.general, "thickness") as SNode | null; if (t) doc.thickness = num(t[1], 1.6); }
  }
  return true;
}


// ---------------------------------------------------------------- design rule validation (BOARD_DESIGN_SETTINGS)
export interface RuleIssue { setting: string; message: string }
/** A millimetre value as StringFromValue( units, aAddUnitsText = true ) writes it in an error message. */
export function unitText(mm: number, units: "mm" | "in" | "mil"): string {
  const per = units === "in" ? 25.4 : units === "mil" ? 0.0254 : 1, digits = units === "in" ? 4 : units === "mil" ? 2 : 4;
  let t = (mm / per).toFixed(digits); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (t === "-0") t = "0";
  return t + " " + (units === "mil" ? "mils" : units);
}
const RANGES: [string, number, number][] = [
  ["min_clearance", 0, 25], ["min_connection", 0, 100], ["min_track_width", 0, 25], ["min_via_annular_width", 0, 25], ["min_via_diameter", 0, 25],
  ["min_through_hole_diameter", 0, 25], ["min_microvia_diameter", 0, 10], ["min_microvia_drill", 0, 10], ["min_hole_to_hole", 0, 10], ["min_hole_clearance", 0, 100],
  ["min_silk_clearance", -10, 100], ["min_groove_width", 0, 25], ["min_text_height", 0, 100], ["min_text_thickness", 0, 25], ["min_copper_edge_clearance", -0.01, 25]];
/** BOARD_DESIGN_SETTINGS::ValidateDesignRules over the project's (board.design_settings.rules) values (millimetres). */
export function validateDesignRules(rules: Record<string, number>, units: "mm" | "in" | "mil" = "mm", extra?: { maskExpansion?: number; maskMinWidth?: number; maskToCopper?: number; pasteMargin?: number; pasteRatio?: number }): RuleIssue[] {
  const out: RuleIssue[] = [];
  const range = (k: string, v: number | undefined, lo: number, hi: number): void => { if (v === undefined || !isFinite(v)) return; const iu = Math.round(v * 1e6); if (iu < Math.round(lo * 1e6) || iu > Math.round(hi * 1e6)) out.push({ setting: k, message: `Value must be between ${unitText(lo, units)} and ${unitText(hi, units)}.` }); };
  for (const [k, lo, hi] of RANGES) range(k, rules[k], lo, hi);
  const spokes = rules.min_resolved_spokes; if (spokes !== undefined && (spokes < 0 || spokes > 99)) out.push({ setting: "min_resolved_spokes", message: "Value must be between 0 and 99." });
  range("max_error", rules.max_error, 0.001, 0.1);
  if (extra) {
    range("solder_mask_expansion", extra.maskExpansion, -25, 25); range("solder_mask_min_width", extra.maskMinWidth, 0, 25); range("solder_mask_to_copper_clearance", extra.maskToCopper, 0, 25); range("solder_paste_margin", extra.pasteMargin, -25, 25);
    if (extra.pasteRatio !== undefined && (!isFinite(extra.pasteRatio) || extra.pasteRatio < -1 || extra.pasteRatio > 1)) out.push({ setting: "solder_paste_margin_ratio", message: "Value must be between -1.000 and 1.000." });
  }
  return out;
}
/** BOARD_DESIGN_SETTINGS::GetDesignRuleWarnings: the minimum via diameter below drill + 2 × annulus has no effect. */
export function designRuleWarnings(rules: Record<string, number>, units: "mm" | "in" | "mil" = "mm"): RuleIssue[] {
  const via = rules.min_via_diameter, drill = rules.min_through_hole_diameter, ring = rules.min_via_annular_width;
  if ([via, drill, ring].some((x) => x === undefined || !isFinite(x))) return [];
  const implied = +(drill + 2 * ring).toFixed(6);
  if (Math.round(via * 1e6) >= Math.round(implied * 1e6)) return [];
  return [{ setting: "min_via_diameter", message: `Minimum via diameter (${unitText(via, units)}) is smaller than the minimum drill size (${unitText(drill, units)}) plus twice the minimum annular width (${unitText(ring, units)}), so it has no effect. The effective minimum via diameter is ${unitText(implied, units)}.` }];
}
/** PCB_VIA::ValidateViaParameters for a Pre-defined Sizes row (NaN = the cell is empty). */
export function validateViaParameters(diameter: number, drill: number): { message: string; field: "diameter" | "drill" } | null {
  const has = (v: number): boolean => typeof v === "number" && isFinite(v);
  if (has(diameter) && diameter < 0.001) return { message: "Via diameter is too small.", field: "diameter" };
  if (has(drill) && drill < 0.001) return { message: "Via drill is too small.", field: "drill" };
  if (has(diameter) && !has(drill)) return { message: "No via hole size defined.", field: "drill" };
  if (has(drill) && !has(diameter)) return { message: "No via diameter defined.", field: "diameter" };
  if (has(diameter) && has(drill) && Math.round(diameter * 1e6) <= Math.round(drill * 1e6)) return { message: "Via hole size must be smaller than via diameter", field: "drill" };
  return null;
}

// ---------------------------------------------------------------- the physical stackup, edited (PANEL_SETUP_BOARD_STACKUP)
/** One stackup item as PANEL_SETUP_BOARD_STACKUP edits it: a board layer, or a dielectric with its sub-layers. */
export interface StackupLayer { name: string; type: string; color?: string; thickness?: number; locked?: boolean; material?: string; epsilonR?: number; lossTangent?: number; subs?: StackupSub[] }
export interface StackupSub { thickness: number; locked?: boolean; material: string; epsilonR: number; lossTangent: number; color?: string }
/** The (stackup …) node's layers as editable items. */
export function stackupLayers(setup: SNode | null): StackupLayer[] {
  const st = setup ? (kid(setup, "stackup") as SNode | null) : null; if (!st) return [];
  const out: StackupLayer[] = [];
  for (const l of kids(st, "layer") as SNode[]) {
    const name = str(l[1]);
    const groups: SNode[] = [["layer", name]];
    for (let j = 2; j < l.length; j++) { const c = l[j]; if (c === "addsublayer") groups.push(["layer", name]); else if (isList(c)) (groups[groups.length - 1] as SNode).push(c); }
    const g0 = groups[0], th = kid(g0, "thickness") as SNode | null;
    const item: StackupLayer = { name, type: kidStr(g0, "type"), color: kidStr(g0, "color") || undefined, thickness: th ? num(th[1], 0) : undefined, locked: !!th && th.includes("locked"),
      material: kidStr(g0, "material") || undefined, epsilonR: kid(g0, "epsilon_r") ? kidNum(g0, "epsilon_r") : undefined, lossTangent: kid(g0, "loss_tangent") ? kidNum(g0, "loss_tangent") : undefined };
    if (/^dielectric \d+$/.test(name)) item.subs = groups.slice(1).map((g) => { const t = kid(g, "thickness") as SNode | null; return { thickness: t ? num(t[1], 0) : 0, locked: !!t && t.includes("locked"), material: kidStr(g, "material"), epsilonR: kidNum(g, "epsilon_r", 1), lossTangent: kidNum(g, "loss_tangent", 0), color: kidStr(g, "color") || undefined }; });
    out.push(item);
  }
  return out;
}
/** BOARD_STACKUP::FormatBoardStackup: the (stackup …) text for edited layers, with the finish and impedance flags. */
export function stackupText(layers: StackupLayer[], finish: BoardFinish, impedanceControlled: boolean, castellated = false): string {
  const parts: string[] = ["(stackup"];
  const f = (v: number): string => fmt(v);
  for (const l of layers) {
    let t = `(layer ${quote(l.name)} (type ${quote(l.type)})`;
    if (l.color) t += ` (color ${quote(l.color)})`;
    if (l.thickness !== undefined) t += ` (thickness ${f(l.thickness)}${l.locked ? " locked" : ""})`;
    if (l.material) t += ` (material ${quote(l.material)})`;
    if (l.epsilonR !== undefined) t += ` (epsilon_r ${f(l.epsilonR)})`;
    if (l.lossTangent !== undefined) t += ` (loss_tangent ${f(l.lossTangent)})`;
    for (const s of l.subs || []) t += ` addsublayer${s.color ? ` (color ${quote(s.color)})` : ""} (thickness ${f(s.thickness)}${s.locked ? " locked" : ""}) (material ${quote(s.material)}) (epsilon_r ${f(s.epsilonR)}) (loss_tangent ${f(s.lossTangent)})`;
    parts.push(t + ")");
  }
  if (finish.copperFinish && finish.copperFinish !== "None") parts.push(`(copper_finish ${quote(finish.copperFinish)})`);
  parts.push(`(dielectric_constraints ${impedanceControlled ? "yes" : "no"})`);
  if (finish.edgeConnector !== "no") parts.push(`(edge_connector ${finish.edgeConnector})`);
  if (castellated) parts.push("(castellated_pads yes)");
  if (finish.edgePlating) parts.push("(edge_plating yes)");
  return parts.join(" ") + ")";
}
/** A copy of (setup …) whose (stackup …) is replaced by `text` (inserted first when the board had none). */
export function setupWithStackup(setup: SNode | null, text: string): SNode {
  const out = (setup ? parse(ser(setup)) : parse("(setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no))")) as SNode;
  const node = parse(text) as SNode, i = idxOf(out, "stackup");
  if (i > 0) out[i] = node; else out.splice(1, 0, node);
  return out;
}
/** Board thickness of edited stackup items: every thickness (dielectric sub-layers included). */
export function stackupLayersThickness(layers: StackupLayer[]): number {
  let t = 0; for (const l of layers) { if (l.thickness !== undefined && !/Silk|Paste/.test(l.type)) t += l.thickness; for (const s of l.subs || []) t += s.thickness; }
  return +t.toFixed(6);
}
/** onAdjustDielectricThickness's minimum: the thickness of everything that will not be adjusted (copper, masks, locked and secondary dielectrics). */
export function stackupFixedThickness(layers: StackupLayer[]): number {
  let t = 0;
  for (const l of layers) {
    if (/Silk|Paste/.test(l.type)) continue;
    if (!((l.type === "core" || l.type === "prepreg") && !l.locked)) t += l.thickness || 0;
    for (const s of l.subs || []) t += s.thickness;
  }
  return +t.toFixed(6);
}
/**
 * PANEL_SETUP_BOARD_STACKUP::setDefaultLayerWidths: the unlocked main dielectrics take what is left of `target`;
 * prepregs get 0.1 mm and the cores share the rest, unless a core would be thinner than a prepreg, when all of
 * them share it equally.  KiCad's message when nothing can be adjusted ("All dielectric  thickness layers are locked").
 */
export function adjustDielectrics(layers: StackupLayer[], target: number): string | null {
  const free = layers.filter((l) => (l.type === "core" || l.type === "prepreg") && !l.locked);
  if (!free.length) return "All dielectric  thickness layers are locked";
  const left = target - stackupFixedThickness(layers), PREPREG = 0.1;
  const cores = free.filter((l) => l.type === "core"), pre = free.filter((l) => l.type !== "core");
  let core = cores.length ? (left - PREPREG * pre.length) / cores.length : 0;
  if (!cores.length || core < PREPREG) { const each = left / free.length; for (const l of free) l.thickness = +Math.max(0, each).toFixed(6); return null; }
  for (const l of pre) l.thickness = PREPREG;
  for (const l of cores) l.thickness = +core.toFixed(6);
  return null;
}

export const boardSetup = { boardHeader, layerRows, layersText, setCopperCount, copperNames, layerNameError, defaultLayerName, modernLayerIds, stackupRows, stackupThickness, boardFinish, maskPaste, dashRatios,
  editSetup, sectionText, setupWithPlotParams, validateDesignRules, designRuleWarnings, validateViaParameters, unitText, stackupLayers, stackupText, setupWithStackup, stackupLayersThickness, stackupFixedThickness, adjustDielectrics, drillProfile, DRILL_GROUP_KEYS, DRILL_MARK_POLICIES, DRILL_PROFILE_DEFAULT, readPlotParams, plotParamsText, boardSetupChange, applyHeaderChange, applyBoardSetup, COPPER_FINISHES, COPPER_TYPES, USER_TYPES, BOARD_SETUP_TYPE };
