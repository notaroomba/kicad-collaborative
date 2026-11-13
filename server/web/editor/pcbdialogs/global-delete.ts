// pcbdialogs/global-delete — Edit > Global Deletions... (GLOBAL_EDIT_TOOL::GlobalDeletions, DIALOG_GLOBAL_DELETION,
// dialog_global_deletion_base.fbp): Items to Delete, Filter Settings and the Layer Filter; OK removes what
// PcbTools.globalDeletion.globalDeletionIds picks as one "Global Delete" step, then the markers when asked.
// A destructive dialog: it never remembers its state (OptOut), it always opens benign.
import { E } from "../state";
import { clearDrcMarkers } from "./inspect";
import { checkField, h, openDialog, type Field } from "./ui";

interface Opts { [k: string]: boolean | undefined }
interface GlobalDeletionApi { globalDeletionIds(doc: KDoc, o: Opts, currentLayer: string): string[]; GLOBAL_DELETION_DEFAULTS: Opts }
interface PcbToolsApi { globalDeletion: GlobalDeletionApi; boardLayerName(doc: KDoc, name: string): string; applySelection?(ctx: ToolCtx, ids: string[]): void }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

const ITEMS: [string, string][] = [["zones", "Zones"], ["texts", "Text"], ["boardOutlines", "Board outlines"], ["graphics", "Graphics"], ["footprints", "Footprints"],
  ["tracks", "Tracks & vias"], ["teardrops", "Teardrops"], ["markers", "Markers"], ["all", "Clear board"]];
const FILTERS: [string, string][] = [["lockedGraphics", "Locked graphics"], ["unlockedGraphics", "Unlocked graphics"], ["lockedFootprints", "Locked footprints"], ["unlockedFootprints", "Unlocked footprints"],
  ["lockedTracks", "Locked tracks"], ["unlockedTracks", "Unlocked tracks"], ["lockedVias", "Locked vias"], ["unlockedVias", "Unlocked vias"]];

export function openGlobalDeletions(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Global Deletions needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const layer = ctx.activeLayer || "F.Cu";
  const fields = new Map<string, Field<boolean>>();
  let current: HTMLInputElement | null = null;
  const enable = (): void => {
    const v = (k: string): boolean => !!fields.get(k)?.get();
    const set = (k: string, on: boolean): void => { const f = fields.get(k); if (f) { (f.input as HTMLInputElement).disabled = !on; f.el.classList.toggle("dim", !on); } };
    for (const k of ["lockedTracks", "unlockedTracks", "lockedVias", "unlockedVias"]) set(k, v("tracks"));
    for (const k of ["lockedFootprints", "unlockedFootprints"]) set(k, v("footprints"));
    for (const k of ["lockedGraphics", "unlockedGraphics"]) set(k, v("graphics") || v("boardOutlines"));
  };
  const defaults = PT().globalDeletion.GLOBAL_DELETION_DEFAULTS;
  openDialog({ title: "Delete Items", width: 520,
    build(body) {
      const left = h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Items to Delete"));
      for (const [k, label] of ITEMS) { const f = checkField(!!defaults[k], label, { key: k, onChange: enable }); fields.set(k, f); left.append(f.el); }
      const right = h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Filter Settings"));
      FILTERS.forEach(([k, label], i) => { const f = checkField(!!defaults[k], label, { key: k }); fields.set(k, f); if (i && i % 2 === 0) right.append(h("div", { style: "height:6px" })); right.append(f.el); });
      const all = h("input", { type: "radio", name: "gd-layers", "data-k": "allLayers" }) as HTMLInputElement; all.checked = true;
      current = h("input", { type: "radio", name: "gd-layers", "data-k": "currentLayer" }) as HTMLInputElement;
      const layers = h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Layer Filter"),
        h("label", { style: "display:flex;gap:6px;align-items:center" }, all, "All layers"),
        h("label", { style: "display:flex;gap:6px;align-items:center" }, current, `Current layer (${PT().boardLayerName(doc, layer)}) only`));
      body.append(h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:0 16px" }, left, right), layers);
      enable();
    },
    ok() {
      const o: Opts = {}; for (const [k, f] of fields) o[k] = f.get();
      o.currentLayerOnly = !!(current && current.checked);
      // ACTIONS::selectionClear before anything goes
      const sel = PT().applySelection; if (sel) sel(ctx, []);
      const ids = PT().globalDeletion.globalDeletionIds(doc, o, layer);
      const changes: KChange[] = [];
      for (const id of ids) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.removeChange(it)); }
      if (changes.length) ctx.commit(changes, "Global Delete");
      if (o.markers) clearDrcMarkers(ctx);
      ctx.requestRender();
      return true;
    } });
}
