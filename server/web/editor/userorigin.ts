// userorigin.ts — PCB_BASE_FRAME::GetUserOrigin and ORIGIN_TRANSFORMS for the board's status bar: the coordinates
// count from the page origin, the drill / place file origin or the grid origin (Preferences > PCB Editor > Origins &
// Axes), with X increasing right or left and Y down or up.  The preference is E.pcbOrigin (dialogs/prefs.ts); the two
// origins are E.pcbOrigins, as pcbrouting.ts has them for the open board.
import { store } from "./appstore";
import { E } from "./state";
import { isSch } from "./view";
export { toDisplayAbs, toDisplayRel } from "../units";

export type DisplayOrigin = "page" | "aux" | "grid";
export interface OriginPref { origin: DisplayOrigin; invertX: boolean; invertY: boolean }

/** The user origin a preference picks from the board's origins (the page origin: 0, 0). */
export function userOriginOf(pref: OriginPref, origins: { grid?: [number, number] | null; aux?: [number, number] | null }): [number, number] {
  const pt = pref.origin === "aux" ? origins.aux : pref.origin === "grid" ? origins.grid : null;
  return pt ? [pt[0], pt[1]] : [0, 0];
}
/** Put the user origin and the axis senses into the viewport slice (on a preference change or a moved origin). */
export function publishUserOrigin(): void {
  const o = (E.pcbOrigin || { origin: "page", invertX: false, invertY: false }) as OriginPref;
  const userOrigin = userOriginOf(o, (E.pcbOrigins || {}) as { grid?: [number, number]; aux?: [number, number] });
  const cur = store.get().viewport;
  if (cur.userOrigin && cur.userOrigin[0] === userOrigin[0] && cur.userOrigin[1] === userOrigin[1] && !!cur.invertX === o.invertX && !!cur.invertY === o.invertY) return;
  store.slice("viewport", { userOrigin, invertX: o.invertX, invertY: o.invertY });
}

/**
 * ORIGIN_TRANSFORMS::ToDisplay( aValue, ABS_X_COORD / ABS_Y_COORD ) for one board coordinate, as the dialogs'
 * position fields (UNIT_BINDER::SetCoordType) and the Properties panel's coordinate rows show it; the schematic has
 * no transform.  fromDisplayAbs is FromDisplay, the value typed back in board coordinates.
 */
export function toDisplayAbsAxis(v: number, axis: "x" | "y"): number {
  if (isSch()) return v;
  const vp = store.get().viewport; const o = vp.userOrigin || [0, 0];
  const inv = axis === "x" ? !!vp.invertX : !!vp.invertY; const d = v - o[axis === "x" ? 0 : 1];
  return inv ? (d === 0 ? 0 : -d) : d;
}
export function fromDisplayAbsAxis(v: number, axis: "x" | "y"): number {
  if (isSch()) return v;
  const vp = store.get().viewport; const o = vp.userOrigin || [0, 0];
  const inv = axis === "x" ? !!vp.invertX : !!vp.invertY;
  return (inv ? -v : v) + o[axis === "x" ? 0 : 1];
}
