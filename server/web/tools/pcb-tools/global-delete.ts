// pcb-tools/global-delete.ts — DIALOG_GLOBAL_DELETION::DoGlobalDeletions (dialog_global_deletion.cpp): which board
// items Edit > Global Deletions... removes for the dialog's check boxes, filters and layer choice.  Plain item
// selection (no DOM), so the node tests drive it; the dialog lives in pcb-tools/dialogs.ts.
import { isLocked } from "./groups";
import { itemOnLayer } from "./snap-pairs";
import { K } from "./state";

export interface GlobalDeletionOptions {
  zones?: boolean; texts?: boolean; boardOutlines?: boolean; graphics?: boolean; footprints?: boolean; tracks?: boolean; teardrops?: boolean; markers?: boolean; all?: boolean;
  lockedGraphics?: boolean; unlockedGraphics?: boolean; lockedFootprints?: boolean; unlockedFootprints?: boolean;
  lockedTracks?: boolean; unlockedTracks?: boolean; lockedVias?: boolean; unlockedVias?: boolean;
  /** m_rbLayersOption: false = All layers, true = Current layer only */
  currentLayerOnly?: boolean;
}
/** The dialog's initial state: nothing to delete, the "unlocked" filters on, all layers (it never saves its state). */
export const GLOBAL_DELETION_DEFAULTS: GlobalDeletionOptions = { unlockedGraphics: true, unlockedFootprints: true, unlockedTracks: true, unlockedVias: true };

const SHAPE = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_bbox"]);
const DRAWING = new Set([...SHAPE, "gr_text", "gr_text_box", "dimension", "target", "image", "table"]);
const isTeardrop = (n: SNode) => { const a = K.kid(n, "attr"); return !!(a && K.kid(a, "teardrop")); };
/** LSET::AllNonCuMask(): every layer that is not copper. */
const nonCopper = (l: string) => !/\.Cu$/.test(l) && l !== "*.Cu";

/** The ids DoGlobalDeletions removes (zones, drawings, footprints, tracks and vias, empty tuning patterns), in board order. */
export function globalDeletionIds(doc: KDoc, o: GlobalDeletionOptions, currentLayer: string): string[] {
  const all = !!o.all;
  const onFilter = (it: KItem) => !o.currentLayerOnly || itemOnLayer(it, currentLayer);
  const out: string[] = [];
  const items = Array.from(doc.items.values());
  // zones
  for (const it of items) {
    if (it.kind !== "zone") continue;
    if (all) out.push(it.id);
    else if (isTeardrop(it.node)) { if (o.teardrops && onFilter(it)) out.push(it.id); }
    else if (o.zones && onFilter(it)) out.push(it.id);
  }
  // drawings: shapes by the graphics / board outline layers and the lock filters; texts only when no shapes are deleted
  const shapes = !!(o.graphics || o.boardOutlines), texts = !!o.texts;
  if (all || shapes || texts) {
    const drawingLayer = (l: string) => (o.graphics && nonCopper(l) && l !== "Edge.Cuts") || (o.boardOutlines && l === "Edge.Cuts");
    const drawingOk = (it: KItem) => {
      const layers = it.layer ? [it.layer] : Array.from(new Set(it.geom.map((g) => g.layer).filter(Boolean) as string[]));
      return layers.some((l) => drawingLayer(l) && (!o.currentLayerOnly || l === currentLayer));
    };
    for (const it of items) {
      if (!DRAWING.has(it.kind)) continue;
      if (all) out.push(it.id);
      else if (shapes) {
        if (!SHAPE.has(it.kind)) continue;
        if (isLocked(it.node) ? o.lockedGraphics : o.unlockedGraphics) { if (drawingOk(it)) out.push(it.id); }
      } else if (texts) { if ((it.kind === "gr_text" || it.kind === "gr_text_box") && onFilter(it)) out.push(it.id); }
    }
  }
  // footprints
  if (all || o.footprints) for (const it of items) {
    if (it.kind !== "footprint") continue;
    if (all) out.push(it.id);
    else if (isLocked(it.node) ? o.lockedFootprints : o.unlockedFootprints) { if (onFilter(it)) out.push(it.id); }
  }
  // tracks and vias, then the tuning patterns left with no items
  if (all || o.tracks) {
    for (const it of items) {
      if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via") continue;
      if (all) out.push(it.id);
      else if (it.kind === "via") { if (isLocked(it.node) ? o.lockedVias : o.unlockedVias) { if (onFilter(it)) out.push(it.id); } }
      else if (isLocked(it.node) ? o.lockedTracks : o.unlockedTracks) { if (onFilter(it)) out.push(it.id); }
    }
    for (const it of items) {
      if (it.kind !== "generated") continue;
      const m = K.kid(it.node, "members");
      if (!m || m.length <= 1) out.push(it.id);
    }
  }
  return out;
}

export const globalDeletionApi = { globalDeletionIds, GLOBAL_DELETION_DEFAULTS };
