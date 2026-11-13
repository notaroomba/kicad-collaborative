// pcb-tools/repair.ts — Tools > Repair Board (BOARD_EDITOR_CONTROL::RepairBoard, BOARD::RepairDuplicateItemUuids):
// every item that shares its uuid with one claimed before it gets a new one.  Footprints claim first, then pads,
// then tracks, then everything else a footprint owns, then the rest of the board.
import type { BoardDoc, PcbChange } from "./types";
import { addedChange, removedChange, replacedChange, upsertChange } from "./changes";
import { K } from "./state";
import { clone } from "./util";

export interface RepairResult {
  changes: PcbChange[]; duplicates: number; details: string[];
  /**
   * The changes as the two ops they must go out as: the removals first, then the rest.  A board-level item has no
   * address but its uuid, so the copies of a duplicated one are taken off (each removal takes the next copy, as on
   * the desktop) and come back as the one that keeps the id and the ones with new ids.  In one op the desktop folds
   * a removal and an add of the same id into the add alone (PCB_COLLAB), which would leave the extra copy.
   */
  steps: PcbChange[][];
}

const TRACKS = new Set(["segment", "arc", "via"]);
const uuidKid = (n: SNode): SNode | null => (K.kid(n, "uuid") || K.kid(n, "tstamp")) as SNode | null;

/** A board-level item of the file: the one its id names in doc.items, or a later copy (parseDoc dupItems). */
interface Top { id: string; kind: string; node: SNode; work: SNode | null; newId: string | null }

export function repairBoard(doc: BoardDoc): RepairResult {
  const ids = new Set<string>();
  let duplicates = 0;
  const tops: Top[] = [];
  for (const it of doc.items.values()) tops.push({ id: it.id, kind: it.kind, node: it.node, work: null, newId: null });
  for (const d of doc.dupItems || []) tops.push({ id: d.id, kind: String(d.node[0]), node: d.node, work: null, newId: null });
  const nodeOf = (t: Top): SNode => t.work || (t.work = clone(t.node));
  // processItem: a uuid seen before is replaced (RebindItemUuid( *aItem, KIID() ))
  const claim = (n: SNode, onDup: () => void): void => {
    const u = uuidKid(n); if (!u) return;
    const v = K.str(u[1]);
    if (ids.has(v)) { duplicates++; onDup(); return; }
    ids.add(v);
  };
  const fps = tops.filter((t) => t.kind === "footprint");
  const inFp = (t: Top, pick: (c: SNode) => boolean): void => {
    t.node.forEach((c, i) => {
      if (i === 0 || !Array.isArray(c) || !pick(c as SNode)) return;
      claim(c as SNode, () => { const u = uuidKid(nodeOf(t)[i] as SNode); if (u) u[1] = K.newUuid(); });
    });
  };
  const retag = (t: Top) => () => { t.newId = K.newUuid(); const u = uuidKid(nodeOf(t)); if (u) u[1] = t.newId; };
  for (const t of fps) claim(t.node, retag(t));
  for (const t of fps) inFp(t, (c) => c[0] === "pad");
  for (const t of tops) if (TRACKS.has(t.kind)) claim(t.node, retag(t));
  for (const t of fps) inFp(t, (c) => c[0] !== "pad" && !!uuidKid(c));   // fields, graphics, zones, groups
  for (const t of tops) if (t.kind !== "footprint" && !TRACKS.has(t.kind)) claim(t.node, retag(t));

  const removals: PcbChange[] = [], rest: PcbChange[] = [];
  const byId = new Map<string, Top[]>(); for (const t of tops) { const l = byId.get(t.id); if (l) l.push(t); else byId.set(t.id, [t]); }
  for (const [id, copies] of byId) {
    const it = doc.items.get(id); if (!it) continue;
    const keeper = copies.find((t) => !t.newId) || null, moved = copies.filter((t) => t.newId);
    if (!moved.length) {   // one item, at most its children re-id'd: edited in place
      if (keeper && keeper.work) rest.push(replacedChange(it, keeper.work));
      continue;
    }
    // every copy but the one that keeps the id goes; the one left is given the keeper's text (an upsert, in place)
    for (let i = keeper ? 1 : 0; i < copies.length; i++) removals.push(removedChange(it));
    if (keeper) rest.push(upsertChange({ id, kind: keeper.kind, node: keeper.work || keeper.node }, "ADDED"));
    // the item the id named, given a new one: written back where it was, not after the last item
    for (const t of moved) { const c = addedChange(doc, nodeOf(t)); if (!keeper && t === copies[0]) c.replaces = id; rest.push(c); }
  }
  const steps = [removals, rest].filter((s) => s.length);
  return { changes: removals.concat(rest), steps, duplicates, details: duplicates ? [`${duplicates} duplicate IDs replaced.`] : [] };
}
