// dialogs/erc-exclusions.ts — ERC_SETTINGS' erc_exclusions in the .kicad_pro: which violations are excluded and
// their comments.  A project whose "erc" section is still at schema 0 keeps KiCad's legacy entries ([ "code|x|y|main|aux",
// "comment" ], SCH_MARKER::SerializeToString with the position in schematic IU); schema 1 keeps ERC_EXCLUSION's
// ProtoJSON ({ "marker": { "error_type", "position", "items" }, "comment" }).  Entries are written in the form the
// project already uses, so the file's schema version is never changed.

export interface ErcMarkerLike { code: string; severity: string; x: number; y: number; ids: string[] }
export interface Exclusion { code: string; x: number; y: number; ids: string[]; comment: string }
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObj = { [k: string]: Json };

/** ERCE_T settings keys (ERC_ITEM::GetSettingsKey) and their ErcErrorType names (ToProtoEnum<ERCE_T>). */
const ERCET: Record<string, string> = {
  duplicate_sheet_names: "DUPLICATE_SHEET_NAME", endpoint_off_grid: "ENDPOINT_OFF_GRID", pin_not_connected: "PIN_NOT_CONNECTED", pin_not_driven: "PIN_NOT_DRIVEN",
  power_pin_not_driven: "POWERPIN_NOT_DRIVEN", duplicate_pins: "DUPLICATE_PIN_ERROR", wired_implicit_power: "WIRED_IMPLICIT_POWER", hier_label_mismatch: "HIERARCHICAL_LABEL",
  four_way_junction: "FOUR_WAY_JUNCTION", label_multiple_wires: "LABEL_MULTIPLE_WIRES", no_connect_connected: "NOCONNECT_CONNECTED", no_connect_dangling: "NOCONNECT_NOT_CONNECTED",
  label_dangling: "LABEL_NOT_CONNECTED", isolated_pin_label: "LABEL_SINGLE_PIN", similar_labels: "SIMILAR_LABELS", similar_power: "SIMILAR_POWER",
  similar_label_and_power: "SIMILAR_LABEL_AND_POWER", single_global_label: "SINGLE_GLOBAL_LABEL", same_local_global_label: "SAME_LOCAL_GLOBAL_LABEL",
  same_local_global_power: "SAME_LOCAL_GLOBAL_POWER", different_unit_footprint: "DIFFERENT_UNIT_FP", different_unit_net: "DIFFERENT_UNIT_NET",
  bus_definition_conflict: "BUS_ALIAS_CONFLICT", multiple_net_names: "DRIVER_CONFLICT", net_not_bus_member: "BUS_ENTRY_CONFLICT", bus_to_bus_conflict: "BUS_TO_BUS_CONFLICT",
  bus_to_net_conflict: "BUS_TO_NET_CONFLICT", ground_pin_not_ground: "GROUND_PIN_NOT_GROUND", stacked_pin_name: "STACKED_PIN_SYNTAX", field_name_whitespace: "FIELD_NAME_WHITESPACE",
  empty_label_name: "EMPTY_LABEL_NAME", empty_power_value: "EMPTY_POWER_VALUE", duplicate_sheet_suffix: "DUPLICATE_SHEET_SUFFIX", ref_suffix_mismatch: "REF_SUFFIX_MISMATCH",
  pin_map_bad_pad: "PIN_MAP_BAD_PAD", pin_map_unmapped_pin: "PIN_MAP_UNMAPPED_PIN", pin_map_duplicate_pad: "PIN_MAP_DUPLICATE_PAD", pin_map_stale_pin: "PIN_MAP_STALE_PIN",
  unresolved_variable: "UNRESOLVED_VARIABLE", undefined_netclass: "UNDEFINED_NETCLASS", simulation_model_issue: "SIMULATION_MODEL", wire_dangling: "WIRE_DANGLING",
  lib_symbol_issues: "LIB_SYMBOL_ISSUES", lib_symbol_mismatch: "LIB_SYMBOL_MISMATCH", footprint_link_issues: "FOOTPRINT_LINK_ISSUES", footprint_filter: "FOOTPRINT_FILTERS",
  unannotated: "UNANNOTATED", extra_units: "EXTRA_UNITS", missing_unit: "MISSING_UNIT", missing_input_pin: "MISSING_INPUT_PIN", missing_bidi_pin: "MISSING_BIDI_PIN",
  missing_power_pin: "MISSING_POWER_INPUT_PIN", unit_value_mismatch: "DIFFERENT_UNIT_VALUE", duplicate_reference: "DUPLICATE_REFERENCE", bus_entry_needed: "BUS_ENTRY_NEEDED",
  unconnected_wire_endpoint: "UNCONNECTED_WIRE_ENDPOINT", variant_symbol_invalid: "VARIANT_SYMBOL_INVALID", variant_symbol_incompatible: "VARIANT_SYMBOL_INCOMPATIBLE",
};
/** The proto enum name of a marker; pin_to_pin is ERCE_PIN_TO_PIN_WARNING or _ERROR by its severity. */
export function protoErrorType(code: string, severity: string): string {
  if (code === "pin_to_pin") return severity === "error" ? "ERCET_PIN_TO_PIN_ERROR" : "ERCET_PIN_TO_PIN_WARNING";
  return "ERCET_" + (ERCET[code] || "UNKNOWN");
}
const CODE_OF = new Map<string, string>(Object.entries(ERCET).map(([k, v]) => ["ERCET_" + v, k]));
CODE_OF.set("ERCET_PIN_TO_PIN_ERROR", "pin_to_pin"); CODE_OF.set("ERCET_PIN_TO_PIN_WARNING", "pin_to_pin");

const NIL = "00000000-0000-0000-0000-000000000000";
/** schIUScale: 10000 IU per mm; the ProtoJSON position is in nanometres. */
const iu = (mm: number): number => Math.round(mm * 10000);

/** erc.meta.version: 0 (or absent) keeps the legacy strings. */
export function exclusionSchema(erc: JsonObj): number {
  const m = erc.meta; const v = m && typeof m === "object" && !Array.isArray(m) ? (m as JsonObj).version : undefined;
  return typeof v === "number" ? v : 0;
}
/** SCH_MARKER::SerializeToString (the five-field form, sheet paths left out for the root sheet). */
export function legacyKey(m: ErcMarkerLike): string { return `${m.code}|${iu(m.x)}|${iu(m.y)}|${m.ids[0] || NIL}|${m.ids[1] || NIL}`; }
export function protoExclusion(m: ErcMarkerLike, comment: string): JsonObj {
  const marker: JsonObj = { error_type: protoErrorType(m.code, m.severity), position: { x_nm: String(iu(m.x) * 100), y_nm: String(iu(m.y) * 100) } };
  if (m.ids.length) marker.items = m.ids.slice(0, 2).map((id) => ({ value: id }));
  const out: JsonObj = { marker }; if (comment) out.comment = comment;
  return out;
}

/** Every exclusion the project holds, in either form. */
export function readExclusions(erc: JsonObj): Exclusion[] {
  const list = Array.isArray(erc.erc_exclusions) ? erc.erc_exclusions : [];
  const out: Exclusion[] = [];
  for (const e of list) {
    if (typeof e === "string" || (Array.isArray(e) && typeof e[0] === "string")) {
      const s = typeof e === "string" ? e : String(e[0]), comment = Array.isArray(e) && typeof e[1] === "string" ? e[1] : "";
      const p = s.split("|"); if (p.length !== 5 && p.length !== 8) continue;
      out.push({ code: p[0], x: Number(p[1]) / 10000, y: Number(p[2]) / 10000, ids: [p[3], p[4]].filter((id) => id && id !== NIL), comment });
    } else if (e && typeof e === "object" && !Array.isArray(e)) {
      const mk = e.marker; if (!mk || typeof mk !== "object" || Array.isArray(mk)) continue;
      const pos = (mk.position && typeof mk.position === "object" && !Array.isArray(mk.position) ? mk.position : {}) as JsonObj;
      const items = Array.isArray(mk.items) ? mk.items : [];
      out.push({ code: CODE_OF.get(String(mk.error_type)) || String(mk.error_type), x: Number(pos.x_nm || 0) / 1e6, y: Number(pos.y_nm || 0) / 1e6,
        ids: items.map((i) => (i && typeof i === "object" && !Array.isArray(i) ? String(i.value || "") : "")).filter((id) => id && id !== NIL), comment: typeof e.comment === "string" ? e.comment : "" });
    }
  }
  return out;
}
/** SCHEMATIC::ResolveERCExclusions: the same rule, position and main item. */
export function sameViolation(m: ErcMarkerLike, ex: Exclusion): boolean {
  return m.code === ex.code && iu(m.x) === iu(ex.x) && iu(m.y) === iu(ex.y) && (m.ids[0] || "") === (ex.ids[0] || "");
}
export function findExclusion(m: ErcMarkerLike, list: Exclusion[]): Exclusion | null { return list.find((ex) => sameViolation(m, ex)) || null; }

/** setMarkerExcluded: add (or re-comment) the violation's exclusion, or remove it. */
export function setExcluded(erc: JsonObj, m: ErcMarkerLike, excluded: boolean, comment = ""): void {
  const list: Json[] = Array.isArray(erc.erc_exclusions) ? erc.erc_exclusions.slice() : [];
  const kept = list.filter((e) => { const r = readExclusions({ erc_exclusions: [e] }); return !(r.length && sameViolation(m, r[0])); });
  if (excluded) kept.push(exclusionSchema(erc) >= 1 ? protoExclusion(m, comment) : [legacyKey(m), comment]);
  erc.erc_exclusions = kept;
}
/** ClearUnresolvedERCExclusions for one rule (Ignore all '…' violations). */
export function dropRule(erc: JsonObj, code: string): void {
  if (!Array.isArray(erc.erc_exclusions)) return;
  erc.erc_exclusions = erc.erc_exclusions.filter((e) => { const r = readExclusions({ erc_exclusions: [e] }); return !(r.length && r[0].code === code); });
}

/** The marker list with exclusions applied: an excluded violation shows as an exclusion (its rule's severity kept as base). */
export function markExcluded<T extends ErcMarkerLike>(markers: T[], list: Exclusion[]): (T & { base?: string; comment?: string })[] {
  return markers.map((m) => {
    const base = (m as T & { base?: string }).base || m.severity;
    const ex = findExclusion({ ...m, severity: base }, list);
    return ex ? Object.assign({}, m, { base, severity: "exclusion", comment: ex.comment }) : Object.assign({}, m, { severity: base, base: undefined, comment: undefined });
  });
}
