// dialogs/erc-rules.ts — ERC_ITEM::allItemTypes (eeschema/erc/erc_item.cpp): the rule titles in dialog order with their
// .kicad_pro keys (erc.rule_severities), headings as one-element rows, and ERC_SETTINGS' default severities.
export type Severity = "error" | "warning" | "ignore";
export const ERC_RULES: ([string] | [string, string])[] = [["Connections"], ["Pin not connected", "pin_not_connected"], ["Input pin not driven by any Output pins", "pin_not_driven"], ["Input Power pin not driven by any Output Power pins", "power_pin_not_driven"],
  ["A pin with a \"no connection\" flag is connected", "no_connect_connected"], ["Unconnected \"no connection\" flag", "no_connect_dangling"], ["Label not connected", "label_dangling"], ["Label connected to only one pin", "isolated_pin_label"],
  ["Global label only appears once in the schematic", "single_global_label"], ["Local and global labels have same name", "same_local_global_label"], ["Local and global power symbols have same name", "same_local_global_power"],
  ["Wires not connected to anything", "wire_dangling"], ["Bus Entry needed", "bus_entry_needed"], ["Symbol pin or wire end off connection grid", "endpoint_off_grid"], ["Four connection points are joined together", "four_way_junction"],
  ["Label connects more than one wire", "label_multiple_wires"], ["Unconnected wire endpoint", "unconnected_wire_endpoint"], ["Label has an empty name", "empty_label_name"],
  ["Conflicts"], ["Duplicate reference designators", "duplicate_reference"], ["Conflict problem between pins", "pin_to_pin"], ["Units of same symbol have different values", "unit_value_mismatch"],
  ["Different footprint assigned in another unit of the symbol", "different_unit_footprint"], ["Different net assigned to a shared pin in another unit of the symbol", "different_unit_net"], ["Duplicate sheet names within a given sheet", "duplicate_sheet_names"],
  ["Mismatch between hierarchical labels and sheet pins", "hier_label_mismatch"], ["More than one name given to this bus or net", "multiple_net_names"], ["Conflict between bus alias definitions across schematic sheets", "bus_definition_conflict"],
  ["Buses are graphically connected but share no bus members", "bus_to_bus_conflict"], ["Invalid connection between bus and net items", "bus_to_net_conflict"], ["Net is graphically connected to a bus but not a bus member", "net_not_bus_member"],
  ["Ground pin not connected to ground net", "ground_pin_not_ground"],
  ["Miscellaneous"], ["Pin name resembles stacked pin", "stacked_pin_name"], ["Field name has leading or trailing whitespace", "field_name_whitespace"], ["Pin map references a pad that does not exist on the footprint", "pin_map_bad_pad"],
  ["Connected pin is not mapped to any footprint pad", "pin_map_unmapped_pin"], ["Two symbol pins are mapped to the same footprint pad", "pin_map_duplicate_pad"], ["Pin map references a pin number that no longer exists on the symbol", "pin_map_stale_pin"],
  ["Symbol is not annotated", "unannotated"], ["Unresolved text variable", "unresolved_variable"], ["Undefined netclass", "undefined_netclass"], ["SPICE model issue", "simulation_model_issue"], ["Labels are similar", "similar_labels"],
  ["Power pins are similar", "similar_power"], ["Power pin and label are similar", "similar_label_and_power"], ["Library symbol issue", "lib_symbol_issues"], ["Symbol doesn't match copy in library", "lib_symbol_mismatch"],
  ["Footprint link issue", "footprint_link_issues"], ["Assigned footprint doesn't match footprint filters", "footprint_filter"], ["Symbol has more units than are defined", "extra_units"], ["Symbol has units that are not placed", "missing_unit"],
  ["Symbol has input pins that are not placed", "missing_input_pin"], ["Symbol has bidirectional pins that are not placed", "missing_bidi_pin"], ["Symbol has power input pins that are not placed", "missing_power_pin"],
  ["Variant symbol not found in libraries", "variant_symbol_invalid"], ["Variant symbol is not pin-compatible", "variant_symbol_incompatible"]];
const WARN = ["endpoint_off_grid", "similar_labels", "similar_power", "similar_label_and_power", "same_local_global_label", "same_local_global_power", "ground_pin_not_ground", "isolated_pin_label", "multiple_net_names", "net_not_bus_member",
  "lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues", "no_connect_connected", "no_connect_dangling", "missing_unit", "missing_input_pin", "missing_bidi_pin", "label_multiple_wires", "unconnected_wire_endpoint",
  "stacked_pin_name", "field_name_whitespace", "pin_map_unmapped_pin", "pin_map_stale_pin", "variant_symbol_incompatible"];
const IGNORE = ["single_global_label", "footprint_filter", "simulation_model_issue", "four_way_junction"];
export function defaultSeverity(code: string): Severity { return IGNORE.includes(code) ? "ignore" : WARN.includes(code) ? "warning" : "error"; }
/** ERC_SETTINGS::m_defaultPinMap: 0 ok, 1 warning, 2 error (rows / columns in PIN_TYPE_NAMES order). */
export const DEFAULT_PIN_MAP: number[][] = [
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2], [0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
  [0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2], [0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]];
export const PIN_TYPE_NAMES = ["Input Pin", "Output Pin", "Bidirectional Pin", "Tri-State Pin", "Passive Pin", "Free Pin", "Unspecified Pin", "Power Input Pin", "Power Output Pin", "Open Collector", "Open Emitter", "No Connection"];
export interface ErcMarker { code: string; severity: string }
/** Apply the project's rule severities to a marker list: ignored rules drop out, the rest take the configured level. pin_to_pin keeps the level the conflicts map gave it unless ignored. */
export function applySeverities<T extends ErcMarker>(markers: T[], severities: Record<string, unknown> | null | undefined): T[] {
  const out: T[] = [];
  for (const m of markers) {
    const s = severities && typeof severities[m.code] === "string" ? String(severities[m.code]) : defaultSeverity(m.code);
    if (s === "ignore") continue;
    out.push(m.code === "pin_to_pin" || (s !== "error" && s !== "warning") ? m : Object.assign({}, m, { severity: s }));
  }
  return out;
}

/**
 * RC_TREE_MODEL::PrevMarker / NextMarker over the listed rows: Next with nothing picked takes the first, Prev the last;
 * at either end nothing changes.  Returns the row to pick, or null.
 */
export function stepMarker(shown: number[], current: number, dir: 1 | -1): number | null {
  const pos = shown.indexOf(current);
  if (dir > 0) { const n = pos < 0 ? shown[0] : shown[pos + 1]; return n === undefined ? null : n; }
  const p = pos < 0 ? shown[shown.length - 1] : shown[pos - 1]; return p === undefined ? null : p;
}
