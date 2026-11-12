// pcb-tools/drc-exclusions.ts — DRC exclusions as KiCad 10 keeps them: board.design_settings.drc_exclusions in the
// .kicad_pro, each entry DRC_EXCLUSION's ProtoJSON (pcbnew/drc/drc_exclusion.cpp): { marker: { error_type, position,
// items, layer, marker_type }, comment }, compared by DRC_EXCLUSION::GetSortKey (the canonical marker: the rule,
// the position in nanometres, the items' KIIDs, the layer only where it is part of the identity).  Legacy
// pipe-delimited strings (schema 2) are read through PCB_MARKER::FromLegacyString's layout.
import type { BoardDoc } from "./types";
import { K } from "./state";

/** settings key → DrcErrorType (api_pcb_enums.cpp ToProtoEnum<PCB_DRC_CODE>), without the DRCET_ prefix. */
export const DRCET: Record<string, string> = { unconnected_items: "UNCONNECTED_ITEMS", shorting_items: "SHORTING_ITEMS", items_not_allowed: "ALLOWED_ITEMS", text_on_edge_cuts: "TEXT_ON_EDGECUTS", clearance: "CLEARANCE", creepage: "CREEPAGE", tracks_crossing: "TRACKS_CROSSING", copper_edge_clearance: "EDGE_CLEARANCE", copper_outside_board: "COPPER_OUTSIDE_BOARD", isolated_copper: "ISOLATED_COPPER", starved_thermal: "STARVED_THERMAL", via_dangling: "DANGLING_VIA", track_dangling: "DANGLING_TRACK", hole_clearance: "HOLE_CLEARANCE", hole_to_hole: "DRILLED_HOLES_TOO_CLOSE", holes_co_located: "DRILLED_HOLES_COLOCATED", connection_width: "CONNECTION_WIDTH", track_width: "TRACK_WIDTH", track_angle: "TRACK_ANGLE", track_segment_length: "TRACK_SEGMENT_LENGTH", annular_width: "ANNULAR_WIDTH", drill_out_of_range: "DRILL_OUT_OF_RANGE", via_diameter: "VIA_DIAMETER", padstack: "PADSTACK", padstack_invalid: "PADSTACK_INVALID", microvia_drill_out_of_range: "MICROVIA_DRILL_OUT_OF_RANGE", malformed_microvia_stack_span: "MALFORMED_MICROVIA_STACK_SPAN", microvia_stack_not_filled: "MICROVIA_STACK_NOT_FILLED", microvia_stack_depth: "MICROVIA_STACK_DEPTH", hole_aspect_ratio: "HOLE_ASPECT_RATIO", microvia_crosses_core: "MICROVIA_CROSSES_CORE", courtyards_overlap: "OVERLAPPING_FOOTPRINTS", missing_courtyard: "MISSING_COURTYARD", malformed_courtyard: "MALFORMED_COURTYARD", pth_inside_courtyard: "PTH_IN_COURTYARD", npth_inside_courtyard: "NPTH_IN_COURTYARD", item_on_disabled_layer: "DISABLED_LAYER_ITEM", invalid_outline: "INVALID_OUTLINE", duplicate_footprints: "DUPLICATE_FOOTPRINT", missing_footprint: "MISSING_FOOTPRINT", extra_footprint: "EXTRA_FOOTPRINT", net_conflict: "NET_CONFLICT", footprint_symbol_mismatch: "SCHEMATIC_PARITY", footprint_filters_mismatch: "FOOTPRINT_FILTERS", footprint_symbol_field_mismatch: "SCHEMATIC_FIELDS_PARITY", lib_footprint_issues: "LIB_FOOTPRINT_ISSUES", lib_footprint_mismatch: "LIB_FOOTPRINT_MISMATCH", unresolved_variable: "UNRESOLVED_VARIABLE", assertion_failure: "ASSERTION_FAILURE", generic_warning: "GENERIC_WARNING", generic_error: "GENERIC_ERROR", copper_sliver: "COPPER_SLIVER", solder_mask_bridge: "SOLDERMASK_BRIDGE", silk_over_copper: "SILK_MASK_CLEARANCE", silk_edge_clearance: "SILK_EDGE_CLEARANCE", silk_overlap: "SILK_CLEARANCE", text_height: "TEXT_HEIGHT", text_thickness: "TEXT_THICKNESS", length_out_of_range: "LENGTH_OUT_OF_RANGE", net_chain_stub_length: "NET_CHAIN_STUB_TOO_LONG", net_chain_return_path: "NET_CHAIN_RETURN_PATH_BREAK", net_chain_tuning_profiles: "NET_CHAIN_TUNING_PROFILES", skew_out_of_range: "SKEW_OUT_OF_RANGE", too_many_vias: "VIA_COUNT_OUT_OF_RANGE", diff_pair_gap_out_of_range: "DIFF_PAIR_GAP_OUT_OF_RANGE", diff_pair_uncoupled_length_too_long: "DIFF_PAIR_UNCOUPLED_LENGTH_TOO_LONG", footprint: "FOOTPRINT", footprint_type_mismatch: "FOOTPRINT_TYPE_MISMATCH", through_hole_pad_without_hole: "PAD_TH_WITH_NO_HOLE", footprint_scaled_with_pads: "FOOTPRINT_SCALED_WITH_PADS", mirrored_text_on_front_layer: "MIRRORED_TEXT_ON_FRONT_LAYER", nonmirrored_text_on_back_layer: "NONMIRRORED_TEXT_ON_BACK_LAYER", missing_tuning_profile: "MISSING_TUNING_PROFILE", tuning_profile_track_geometries: "TUNING_PROFILE_IMPLICIT_RULES", track_on_post_machined_layer: "TRACK_ON_POST_MACHINED_LAYER", track_not_centered_on_via: "TRACK_NOT_CENTERED_ON_VIA" };
/** PCB_MARKER::ToProto stores the layer only for these (it is part of their identity). */
const LAYER_STORED = new Set(["copper_sliver", "generic_warning", "generic_error", "unconnected_items", "starved_thermal"]);
const LEGACY_LAYER_FIELD = new Set(["copper_sliver", "generic_warning", "generic_error"]);
export interface ExMarker { code: string; x: number; y: number; ids: string[]; layer?: string; excluded?: boolean; comment?: string; severity?: string }
export interface DrcExclusionJson { marker: { error_type: string; position?: { x_nm?: string; y_nm?: string }; items?: { value: string }[]; layer?: string; marker_type?: string }; comment?: string }

/** BoardLayer enum name of a layer (BL_F_Cu, BL_In1_Cu, BL_B_Cu …). */
export const boardLayerEnum = (layer: string) => "BL_" + layer.replace(/\./g, "_");
/** The KIID of a marker item: the item's (uuid), else its id. */
function kiidOf(doc: BoardDoc | null, id: string) {
  const it = doc && doc.items.get(id); const u = it && (K.kid(it.node, "uuid") || K.kid(it.node, "tstamp"));
  return u ? K.str(u[1]) : id.replace(/#.*$/, "");
}
const nm = (mm: number) => String(Math.round(mm * 1e6));
/** DRC_EXCLUSION::FromMarker: the canonical marker (no rule, description, severity or excluded flag) and the comment. */
export function exclusionOf(doc: BoardDoc | null, m: ExMarker, comment?: string): DrcExclusionJson {
  const marker: DrcExclusionJson["marker"] = { error_type: "DRCET_" + (DRCET[m.code] || "UNKNOWN") };
  const x = nm(m.x), y = nm(m.y); const pos: { x_nm?: string; y_nm?: string } = {};
  if (x !== "0") pos.x_nm = x; if (y !== "0") pos.y_nm = y;   // proto3 JSON leaves zero fields out
  if (pos.x_nm || pos.y_nm) marker.position = pos;
  const items = m.ids.map((id) => kiidOf(doc, id)).filter((v) => v && v !== "00000000-0000-0000-0000-000000000000");
  if (items.length) marker.items = items.map((value) => ({ value }));
  if (LAYER_STORED.has(m.code)) marker.layer = boardLayerEnum(m.layer || "F.Cu");
  marker.marker_type = "MT_DRC";
  const out: DrcExclusionJson = { marker }; if (comment) out.comment = comment;
  return out;
}
/** DRC_EXCLUSION::GetSortKey as a string: an unconnected-items exclusion ignores its layer. */
export function exclusionKey(ex: DrcExclusionJson | null): string {
  if (!ex || !ex.marker) return "";
  const m = ex.marker; const p = m.position || {};
  const parts = [m.error_type || "", String(p.x_nm || "0"), String(p.y_nm || "0"), (m.items || []).map((i) => i.value).join(","), m.error_type === "DRCET_UNCONNECTED_ITEMS" ? "" : m.layer || "", m.marker_type || ""];
  return parts.join("|");
}
/** DRC_EXCLUSION::FromLegacyStrings: "settings_key|x|y|uuid|uuid" (nanometres). */
export function legacyExclusion(data: string, comment: string): DrcExclusionJson | null {
  const p = data.split("|"); if (p.length < 5 || !DRCET[p[0]]) return null;
  const code = p[0], x = parseInt(p[1], 10) || 0, y = parseInt(p[2], 10) || 0;
  let ids = [p[3], p[4]], layer = "F.Cu";
  if (LEGACY_LAYER_FIELD.has(code)) { ids = [p[3]]; layer = p[4] || "F.Cu"; }
  else if (code === "unconnected_items" && p.length > 6) ids = [p[5], p[6]];
  return exclusionOf(null, { code, x: x / 1e6, y: y / 1e6, ids: ids.filter(Boolean), layer }, comment);
}
/** One drc_exclusions entry, whatever its schema, as ProtoJSON (null when it cannot be read). */
export function readExclusion(entry: unknown): DrcExclusionJson | null {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return (entry as DrcExclusionJson).marker ? entry as DrcExclusionJson : null;
  if (Array.isArray(entry) && entry.length) return legacyExclusion(String(entry[0]), entry.length > 1 ? String(entry[1]) : "");
  if (typeof entry === "string") return legacyExclusion(entry, "");
  return null;
}
/** board.design_settings.drc_exclusions of a project file text (the raw entries). */
export function projectExclusions(proText: string | null | undefined): unknown[] {
  if (!proText) return [];
  try { const j = JSON.parse(proText); const a = j && j.board && j.board.design_settings && j.board.design_settings.drc_exclusions; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
/** Mark the markers the project excludes (BOARD::ResolveDRCExclusions): excluded, with the exclusion's comment. */
export function applyExclusions<M extends ExMarker>(doc: BoardDoc | null, markers: M[], entries: unknown[]): M[] {
  const byKey = new Map<string, DrcExclusionJson>();
  for (const e of entries) { const ex = readExclusion(e); const k = exclusionKey(ex); if (k && ex) byKey.set(k, ex); }
  for (const m of markers) {
    const ex = byKey.get(exclusionKey(exclusionOf(doc, m)));
    if (ex) { m.excluded = true; m.comment = ex.comment || ""; } else { delete m.excluded; delete m.comment; }
  }
  return markers;
}
/** The entries with one exclusion added (or its comment replaced: erase, then insert). */
export function withExclusion(entries: unknown[], ex: DrcExclusionJson): unknown[] {
  const k = exclusionKey(ex); return entries.filter((e) => exclusionKey(readExclusion(e)) !== k).concat([ex]);
}
/** The entries without the exclusions of these keys. */
export function withoutExclusions(entries: unknown[], keys: Set<string>): unknown[] {
  return entries.filter((e) => !keys.has(exclusionKey(readExclusion(e))));
}
