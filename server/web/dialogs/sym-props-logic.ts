// dialogs/sym-props-logic.ts — the pure s-expression logic behind DIALOG_SYMBOL_PROPERTIES that is not shared with
// the other item dialogs: the passthrough mode, local power (LIB_SYMBOL::SetLocalPowerProp), body style names,
// the composed reference suffix, SCH_SYMBOL::SyncOtherUnits / CollectOtherUnits and the pin-to-pad maps
// (PANEL_SYMBOL_PIN_MAP, file version 20260629).
import { clone, drop, fieldName, fieldValue, instanceEntry, kid, kids, num, put, qnode, str } from "./sch-items-logic";

const isList = Array.isArray;
const parse = (s: string): SNode => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas.parse(s) as SNode;
const q = (s: string): string => JSON.stringify(s);

// ---------------------------------------------------------------- passthrough (sch_io_kicad_sexpr.cpp:1117-1125)
export type Passthrough = "default" | "block" | "force";
export const PASSTHROUGH_CHOICES: [Passthrough, string][] = [["default", "Default"], ["block", "Block"], ["force", "Force"]];
export function passthroughOf(n: SNode): Passthrough { const c = kid(n, "passthrough"); const v = c ? str(c[1]) : ""; return v === "block" || v === "force" ? v : "default"; }
/** Written after (dnp …) and (pin_map_override …); omitted for Default. */
export function setPassthrough(n: SNode, mode: Passthrough): void {
  if (mode === "default") { drop(n, "passthrough"); return; }
  if (kid(n, "passthrough")) { put(n, "passthrough", [mode]); return; }
  let at = -1; for (const k of ["pin_map_override", "dnp", "in_pos_files", "on_board", "in_bom", "exclude_from_sim"]) { at = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === k); if (at > 0) break; }
  const node = ["passthrough", mode] as unknown as SNode;
  if (at > 0) n.splice(at + 1, 0, node); else put(n, "passthrough", [mode], ["locked", "fields_autoplaced", "uuid", "property"]);
}

// ---------------------------------------------------------------- power symbols (sch_io_kicad_sexpr_lib_cache.cpp:390-394)
export const isPowerLib = (lib: SNode | null): boolean => !!lib && !!kid(lib, "power");
export const isLocalPower = (lib: SNode | null): boolean => { const p = lib && kid(lib, "power"); return !!p && str(p[1]) === "local"; };
/** SetLocalPowerProp: (power local) vs (power global); a symbol that is not a power symbol is left alone. */
export function setLocalPower(lib: SNode, local: boolean): boolean {
  const i = lib.findIndex((c, j) => j > 0 && isList(c) && c[0] === "power"); if (i < 0) return false;
  if (isLocalPower(lib) === local) return false;
  lib[i] = ["power", local ? "local" : "global"] as unknown as SNode; return true;
}
/** The file version that introduced (power local). */
export const LOCAL_POWER_VERSION = 20250227;

// ---------------------------------------------------------------- body styles
/** The number of body styles of a library symbol: the (body_styles …) names, De Morgan, or the highest _u_b unit. */
export function bodyStyleCount(lib: SNode | null): number {
  if (!lib) return 1;
  const bs = kid(lib, "body_styles"); if (bs) { const names = bs.slice(1).filter((v) => !isList(v)); return names.length === 1 && names[0] === "demorgan" ? 2 : Math.max(1, names.length); }
  let n = 1; for (const s of kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (m) n = Math.max(n, +m[2]); }
  return n;
}
/** The Body style: choice (TransferDataToWindow): Standard / Alternate for De Morgan, else the lib's custom names. */
export function bodyStyleNames(lib: SNode | null): string[] {
  const n = bodyStyleCount(lib); if (n < 2) return ["Standard"];
  const bs = lib && kid(lib, "body_styles"); const names = bs ? bs.slice(1).filter((v) => !isList(v)).map(str) : [];
  if (!bs || (names.length === 1 && names[0] === "demorgan")) return ["Standard", "Alternate"];
  const out: string[] = []; for (let i = 0; i < n; i++) out.push(names[i] !== undefined ? names[i] : "???");
  return out;
}
export const NO_PIN_FUNCTIONS_WITH_MULTIPLE_BODY_STYLES = "Alternate pin functions are not available on symbols with multiple body styles.";

// ---------------------------------------------------------------- reference suffixes (SCH_SHEET_PATH::ComposeRefSuffix)
export const REF_SUFFIX_FIELD = "Reference Suffix";
/** The suffix each sheet on the path contributes, root first: the sheets' "Reference Suffix" fields joined. */
export function composeRefSuffix(sheetNodes: (SNode | null)[]): string {
  let s = ""; for (const n of sheetNodes) { if (!n) continue; const p = kids(n, "property").find((q) => fieldName(q) === REF_SUFFIX_FIELD); if (p) s += fieldValue(p); }
  return s;
}
/** The Composed reference: label: the reference (unannotated ones are never suffixed) plus the path's suffix. */
export function composedReference(ref: string, suffix: string): string { return ref.endsWith("?") ? ref : ref + suffix; }

// ---------------------------------------------------------------- SyncOtherUnits (sch_symbol.cpp:2643)
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
export interface SyncWhat { field?: string; value: boolean; otherFields: boolean; exclBOM: boolean; exclBoard: boolean; exclPos: boolean; dnp: boolean; pins: boolean; pinMap: boolean }
export const SYNC_ALL: SyncWhat = { value: true, otherFields: true, exclBOM: true, exclBoard: true, exclPos: true, dnp: true, pins: true, pinMap: true };
/** SyncOtherUnits' aProperty filter: a single property edit only syncs that property. */
export function syncFor(property: string | null): SyncWhat {
  if (!property) return SYNC_ALL;
  // DIALOG_FIELD_PROPERTIES: the Value, Footprint or Datasheet text alone
  const f = /^field:(.+)$/.exec(property); if (f) return { field: f[1], value: false, otherFields: false, exclBOM: false, exclBoard: false, exclPos: false, dnp: false, pins: false, pinMap: false };
  return { value: property === "Value", otherFields: false, pins: false, exclBoard: property === "Exclude From Board", exclBOM: property === "Exclude From Bill of Materials",
    exclPos: property === "Exclude From Position Files", dnp: property === "Do not Populate", pinMap: property === "Pin Map Mode" || property === "Pin Map Name" };
}
const atXY = (n: SNode): [number, number] => { const a = kid(n, "at"); return a ? [num(a[1]), num(a[2])] : [0, 0]; };
const flagOf = (n: SNode, k: string, dflt: boolean): boolean => { const c = kid(n, k); return c ? str(c[1]) !== "no" : dflt; };
function setFlagTo(n: SNode, k: string, on: boolean): void { const c = kid(n, k); if (c) c[1] = (on ? "yes" : "no") as unknown as SNode; else put(n, k, [on ? "yes" : "no"], ["passthrough", "locked", "fields_autoplaced", "uuid", "property"]); }
function setPropValue(p: SNode, v: string): void { if (str(p[1]) === "private" && p.length > 3 && !isList(p[2])) p[3] = v as unknown as SNode; else p[2] = v as unknown as SNode; }
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/**
 * One other unit brought in line with `src` (a clone of `dst` is returned; null when nothing changed): Value, the
 * other non-reference fields (added at the same offset from the symbol, extra non-mandatory ones removed), the
 * exclude / DNP flags, the pin map override and the alternate pin assignments.
 */
export function syncUnit(src: SNode, dst: SNode, what: SyncWhat = SYNC_ALL): SNode | null {
  const out = clone(dst);
  const props = (n: SNode) => kids(n, "property");
  const find = (n: SNode, name: string) => props(n).find((p) => fieldName(p) === name) || null;
  if (what.value) { const s = find(src, "Value"), d = find(out, "Value"); if (s && d) setPropValue(d, fieldValue(s)); }
  if (what.field) { const s = find(src, what.field), d = find(out, what.field); if (s && d) setPropValue(d, fieldValue(s)); }
  if (what.otherFields) {
    const [sx, sy] = atXY(src), [dx, dy] = atXY(out);
    for (const f of props(src)) {
      const name = fieldName(f); if (name === "Reference" || name === "Value") continue;
      const o = find(out, name);
      if (o) setPropValue(o, fieldValue(f));
      else {
        const nf = clone(f); const a = kid(nf, "at"); if (a) { a[1] = r4(num(a[1]) - sx + dx) as unknown as SNode; a[2] = r4(num(a[2]) - sy + dy) as unknown as SNode; }
        const last = out.reduce((acc: number, c, j) => (j > 0 && isList(c) && c[0] === "property" ? j : acc), -1);
        out.splice(last > 0 ? last + 1 : out.length, 0, nf);
      }
    }
    for (let j = out.length - 1; j > 0; j--) { const c = out[j]; if (isList(c) && c[0] === "property") { const name = fieldName(c as SNode); if (!MANDATORY.includes(name) && !find(src, name)) out.splice(j, 1); } }
  }
  if (what.exclBOM) setFlagTo(out, "in_bom", flagOf(src, "in_bom", true));
  if (what.exclBoard) setFlagTo(out, "on_board", flagOf(src, "on_board", true));
  if (what.exclPos && (kid(src, "in_pos_files") || kid(out, "in_pos_files"))) setFlagTo(out, "in_pos_files", flagOf(src, "in_pos_files", true));
  if (what.dnp) setFlagTo(out, "dnp", flagOf(src, "dnp", false));
  if (what.pinMap) {
    const s = kid(src, "pin_map_override");
    drop(out, "pin_map_override");
    if (s) { const at = out.findIndex((c, j) => j > 0 && isList(c) && c[0] === "dnp"); if (at > 0) out.splice(at + 1, 0, clone(s)); else put(out, "pin_map_override", s.slice(1), ["passthrough", "locked", "fields_autoplaced", "uuid", "property"]); }
  }
  if (what.pins) {
    const altOf = new Map<string, string>(); for (const p of kids(src, "pin")) { const a = kid(p, "alternate"); altOf.set(str(p[1]), a ? str(a[1]) : ""); }
    for (const p of kids(out, "pin")) {
      if (!altOf.has(str(p[1]))) continue;
      const want = altOf.get(str(p[1])) || ""; drop(p, "alternate");
      if (want) { const u = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === "uuid"); p.splice(u > 0 ? u + 1 : p.length, 0, qnode("alternate", want)); }
    }
  }
  return JSON.stringify(out) === JSON.stringify(dst) ? null : out;
}
export interface UnitInstance { path: string; project: string | null }
export interface OtherUnitHit<T> { sheet: T; item: KItem }
/**
 * CollectOtherUnits over the hierarchy: on each sheet instance, the (non-power) symbols whose reference on that
 * path is `ref`, with the same lib_id and a different unit.
 */
export function collectOtherUnits<T extends { path: string; doc: KDoc }>(sheets: T[], self: KItem, ref: string, unit: number, libId: string, project: string | null, isPower: (doc: KDoc, it: KItem) => boolean): OtherUnitHit<T>[] {
  const out: OtherUnitHit<T>[] = [];
  for (const sh of sheets) for (const it of sh.doc.items.values()) {
    if (it.kind !== "symbol" || it.id === self.id) continue;
    const li = kid(it.node, "lib_id"); if (!li || str(li[1]) !== libId || isPower(sh.doc, it)) continue;
    const e = instanceEntry(it.node, sh.path, project);
    const r = e && kid(e, "reference") ? str((kid(e, "reference") as SNode)[1]) : (() => { const p = kids(it.node, "property").find((q) => fieldName(q) === "Reference"); return p ? fieldValue(p) : ""; })();
    const u = e && kid(e, "unit") ? num((kid(e, "unit") as SNode)[1], 1) : num((kid(it.node, "unit") || [0, 1])[1], 1);
    if (r === ref && u !== unit) out.push({ sheet: sh, item: it });
  }
  return out;
}
export const isAnnotated = (ref: string): boolean => !!ref && !ref.endsWith("?");

// ---------------------------------------------------------------- pin-to-pad maps (PANEL_SYMBOL_PIN_MAP, 20260629)
export const PIN_MAP_VERSION = 20260629;
export interface PinMap { name: string; entries: Map<string, string> }
export interface PinMapState { maps: PinMap[]; footprints: Map<string, string> /* map name -> footprint */; unmapped: string[] }
/** (pin_maps (pin_map "NAME" (entry "pin" "pad")…)…) and (associated_footprints (footprint "lib:fp" (map "NAME"))…). */
export function readPinMaps(lib: SNode | null): PinMapState {
  const st: PinMapState = { maps: [], footprints: new Map(), unmapped: [] }; if (!lib) return st;
  const pm = kid(lib, "pin_maps");
  if (pm) for (const m of kids(pm, "pin_map")) { const e = new Map<string, string>(); for (const en of kids(m, "entry")) e.set(str(en[1]), str(en[2])); st.maps.push({ name: str(m[1]), entries: e }); }
  const af = kid(lib, "associated_footprints");
  if (af) for (const f of kids(af, "footprint")) { const m = kid(f, "map"); if (m) st.footprints.set(str(m[1]), str(f[1])); else st.unmapped.push(str(f[1])); }
  return st;
}
/** Writes the maps back onto a copy of the library symbol, placed before the first unit (symbol "…_u_b"). */
export function writePinMaps(lib: SNode, st: PinMapState): void {
  const first = lib.findIndex((c, j) => j > 1 && isList(c) && (c[0] === "associated_footprints" || c[0] === "pin_maps"));
  drop(lib, "pin_maps"); drop(lib, "associated_footprints");
  const nodes: SNode[] = [];
  // savePinMapData: (associated_footprints …) first, then (pin_maps …)
  const fps = st.maps.filter((m) => st.footprints.get(m.name));
  if (fps.length || st.unmapped.length) nodes.push(parse("(associated_footprints " + fps.map((m) => "(footprint " + q(st.footprints.get(m.name) as string) + " (map " + q(m.name) + "))").concat(st.unmapped.map((f) => "(footprint " + q(f) + ")")).join(" ") + ")"));
  if (st.maps.length) nodes.push(parse("(pin_maps " + st.maps.map((m) => "(pin_map " + q(m.name) + Array.from(m.entries).filter(([pin, pad]) => pad !== "" && pad !== pin).map(([pin, pad]) => " (entry " + q(pin) + " " + q(pad) + ")").join("") + ")").join(" ") + ")"));
  if (!nodes.length) return;
  let at = first > 0 && first <= lib.length ? first : -1;
  if (at < 0) at = lib.findIndex((c, j) => j > 1 && isList(c) && c[0] === "symbol"); if (at < 0) at = lib.findIndex((c, j) => j > 1 && isList(c) && c[0] === "embedded_fonts"); if (at < 0) at = lib.length;
  lib.splice(at, 0, ...nodes);
}
export const pinMapCell = (m: PinMap, pin: string): string => m.entries.get(pin) || pin;
/** A cell equal to the pin number is the identity mapping and is not stored. */
export function setPinMapCell(m: PinMap, pin: string, pad: string): void { pad = pad.trim(); if (!pad || pad === pin) m.entries.delete(pin); else m.entries.set(pin, pad); }
export function newMapName(maps: PinMap[]): string { let n = 1; const s = new Set(maps.map((m) => m.name)); while (s.has("map" + n)) n++; return "map" + n; }
export const PIN_MAP_MSG = {
  pickColumn: "Click a pin map column to choose which map to remove.",
  removeAsk: (name: string): string => `Remove pin map '${name}' and its footprint association?`,
  exists: (name: string): string => `A pin map named '${name}' already exists.`,
  badFootprint: "Invalid footprint identifier.",
  fpTaken: "That footprint is already assigned to another pin map.",
  reset: (name: string): string => `Reset '${name}' to 1:1`,
};
/** LIB_ID::Parse as the footprint cell's validator: "lib:item", neither part empty, no illegal characters. */
export function validFootprintId(s: string): boolean { const m = /^([^:]+):(.+)$/.exec(s.trim()); return !!m && !/[\s"]/.test(m[1]) && !/["]/.test(m[2]); }
/** (pin_map_override (mode library_default|named_map|identity|delegate) (map "NAME") (edit "pin" "pad")…) */
export type PinMapMode = "library_default" | "named_map" | "identity" | "delegate";
export function readOverride(n: SNode): { mode: PinMapMode; map: string; edits: Map<string, string> } | null {
  const o = kid(n, "pin_map_override"); if (!o) return null;
  const m = kid(o, "mode"), mp = kid(o, "map"); const edits = new Map<string, string>(); for (const e of kids(o, "edit")) edits.set(str(e[1]), str(e[2]));
  return { mode: (m ? str(m[1]) : "library_default") as PinMapMode, map: mp ? str(mp[1]) : "", edits };
}
