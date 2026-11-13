// ercview.ts — View > Show ERC Errors / Warnings / Exclusions (SCH_EDITOR_CONTROL::ToggleERCErrors …): the
// EESCHEMA_SETTINGS appearance.show_erc_errors / show_erc_warnings (default on) and show_erc_exclusions (default off)
// switch the markers' layers on the canvas (LAYER_ERC_ERR, LAYER_ERC_WARN; excluded markers are drawn only with
// show_erc_exclusions).  The ERC dialog's own Show checkboxes filter its list only.  The board's DRC markers are
// not affected.
import { setToggles, store } from "./appstore";
import { E } from "./state";
import { isSch, requestRender } from "./view";

export interface ErcShow { errors: boolean; warnings: boolean; exclusions: boolean }
const KEY = "kc.eeschema.appearance.erc";
function load(): ErcShow {
  const d: ErcShow = { errors: true, warnings: true, exclusions: false };
  try { const j = typeof localStorage !== "undefined" ? JSON.parse(localStorage.getItem(KEY) || "null") : null; if (j && typeof j === "object") for (const k of Object.keys(d) as (keyof ErcShow)[]) if (typeof j[k] === "boolean") d[k] = j[k]; } catch { /* storage blocked */ }
  return d;
}
export const ercShow: ErcShow = load();

type MarkerLike = { severity?: string; excluded?: boolean } | null;
/** The markers the canvas draws: on a schematic, those whose severity layer is shown. */
export function visibleMarkers<T extends MarkerLike>(list: T[]): T[] {
  if (!isSch()) return list;
  return list.filter((m) => {
    if (!m) return false;
    if (m.excluded || m.severity === "exclusion") return ercShow.exclusions;
    if (m.severity === "error") return ercShow.errors;
    if (m.severity === "warning") return ercShow.warnings;
    return true;
  });
}
/** E.renderOpts.markers from E.markers. */
export function applyMarkers(): void {
  const v = visibleMarkers((E.markers || []) as MarkerLike[]);
  E.renderOpts.markers = v.length ? v : undefined;
  store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender();
}
export function syncErcToggles(): void { setToggles({ toggleERCErrors: ercShow.errors, toggleERCWarnings: ercShow.warnings, toggleERCExclusions: ercShow.exclusions }); }
export function toggleErc(k: keyof ErcShow): void {
  ercShow[k] = !ercShow[k];
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(ercShow)); } catch { /* storage blocked */ }
  syncErcToggles(); applyMarkers();
}
