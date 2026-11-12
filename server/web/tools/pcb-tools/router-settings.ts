// pcb-tools/router-settings.ts — ROUTING_SETTINGS (pns_routing_settings.cpp), persisted per viewer.
import { root } from "../root";
import { ARC_MODE_ACTIONS, arcDrawMode } from "./arcs";
import { updateHead } from "./branch";
import { refreshChip } from "./dom";
import { ARC_EDIT_ACTIONS, arcEditMode } from "./point-editor";
import { K, S, lastCtx } from "./state";

// ================================================================ ROUTING_SETTINGS (pcbnew/router/pns_routing_settings.cpp)
// The interactive router's settings, kept per viewer under KiCad's own parameter names ("pns" in pcbnew.json).
export const RM_MARK: number = 0, RM_SHOVE: number = 1, RM_WALK: number = 2;                 // PNS_MODE: RM_MarkObstacles, RM_Shove, RM_Walkaround
export const CM_M45: number = 0, CM_R45: number = 1, CM_M90: number = 2, CM_R90: number = 3;         // DIRECTION_45::CORNER_MODE
export const RS_KEY = "kc.pcbnew.pns";
export const RS_DEFAULTS = Object.freeze({ mode: RM_WALK, effort: 1, remove_loops: true, smart_pads: true, shove_vias: true, suggest_finish: false, follow_mouse: true, start_diagonal: false,
  shove_iteration_limit: 250, via_force_prop_iteration_limit: 40, spread_tracks_distance: 0, shove_time_limit: 1000, walkaround_iteration_limit: 40, jump_over_obstacles: false,
  smooth_dragged_segments: true, can_violate_drc: false, free_angle_mode: false, snap_to_tracks: false, snap_to_pads: false, optimize_dragged_track: false, auto_posture: true,
  fix_all_segments: true, restrict_angles: false, keep_diff_pair_coupling_when_dragging: true, corner_mode: CM_M45, walkaround_hug_length_threshold: 1.5, diff_pair_width_to_miter_ratio: 3.0 });
/** ROUTING_SETTINGS by the parameter names KiCad stores in pcbnew.json's "tools.pns". */
export type RouterSettings = { -readonly [k in keyof typeof RS_DEFAULTS]: (typeof RS_DEFAULTS)[k] };
export const MODE_NAMES = ["Highlight collisions", "Shove", "Walk around"];
export const CORNER_NAMES = ["45-degree", "45-degree rounded", "90-degree", "90-degree rounded"];
export function lsGet(key: string) { try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (e) { return null; } }
export function lsSet(key: string, v: string) { try { if (root.localStorage) root.localStorage.setItem(key, v); } catch (e) { /* private mode: the settings last for the session */ } }
/** The stored settings over the defaults; a value of the wrong type (or out of range) keeps the default. */
export function parseRouterSettings(text: string | null) {
  const out: RouterSettings = Object.assign({}, RS_DEFAULTS); let j: Record<string, unknown> | null = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
  if (j && typeof j === "object") for (const k of Object.keys(RS_DEFAULTS) as (keyof RouterSettings)[]) if (typeof j[k] === typeof RS_DEFAULTS[k]) (out as Record<string, unknown>)[k] = j[k];
  if (![RM_MARK, RM_SHOVE, RM_WALK].includes(out.mode)) out.mode = RM_WALK;
  if (![CM_M45, CM_R45, CM_M90, CM_R90].includes(out.corner_mode)) out.corner_mode = CM_M45;
  return out;
}
S.rs = parseRouterSettings(lsGet(RS_KEY));
/** Change router settings (ROUTER_TOOL::ChangeRouterMode, the corner mode actions, DIALOG_PNS_SETTINGS::TransferDataFromWindow). */
export function setRouterSettings(patch: Partial<RouterSettings>) {
  Object.assign(S.rs, patch); S.rs = parseRouterSettings(JSON.stringify(S.rs)); lsSet(RS_KEY, JSON.stringify(S.rs));
  const ctx = lastCtx;
  if (ctx && ctx.doc && S.route) { S.route.collisions = null; updateHead(ctx); }
  if (ctx && ctx.requestRender) ctx.requestRender();
  if (ctx) refreshChip(ctx);
  try { if (K && K.pcbSizes) K.pcbSizes.state.emit(); } catch (e) { /* the chrome republishes its checks on the next change */ }
}
/** ROUTER_TOOL::UpdateMessagePanel's "Corner Style". */
export const cornerStyleName = (rs: RouterSettings) => (rs.free_angle_mode ? "Free-angle" : CORNER_NAMES[rs.corner_mode]);
export const is90 = (cm: number) => cm === CM_M90 || cm === CM_R90;
export const isRounded = (cm: number) => cm === CM_R45 || cm === CM_R90;
/** The check marks of the router's mode and corner-mode actions (menus, the toolbar group's context menu). */
export function routerChecks() {
  const rs = S.rs; return {
    "PCB_ACTIONS::routerHighlightMode": rs.mode === RM_MARK, "PCB_ACTIONS::routerShoveMode": rs.mode === RM_SHOVE, "PCB_ACTIONS::routerWalkaroundMode": rs.mode === RM_WALK,
    routerHighlightMode: rs.mode === RM_MARK, routerShoveMode: rs.mode === RM_SHOVE, routerWalkaroundMode: rs.mode === RM_WALK,
    ...Object.fromEntries(ARC_MODE_ACTIONS.map((id, m) => ["PCB_ACTIONS::" + id, arcDrawMode() === m])),
    ...Object.fromEntries(ARC_EDIT_ACTIONS.map((id, m) => ["ACTIONS::" + id, arcEditMode() === m])),
    ACT_SwitchCornerMode45: rs.corner_mode === CM_M45, ACT_SwitchCornerModeArc45: rs.corner_mode === CM_R45, ACT_SwitchCornerMode90: rs.corner_mode === CM_M90, ACT_SwitchCornerModeArc90: rs.corner_mode === CM_R90,
  };
}
