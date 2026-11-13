// pcb-tools/repair.ts — Tools > Repair Board (BOARD_EDITOR_CONTROL::RepairBoard, BOARD::RepairDuplicateItemUuids):
// every item that shares its uuid with one claimed before it gets a new one.  Footprints claim first, then pads,
// then tracks, then everything else a footprint owns, then the rest of the board.
import type { BoardDoc, PcbChange } from "./types";
import { addedChange, removedChange, replacedChange } from "./changes";
import { K } from "./state";
import { clone } from "./util";

export interface RepairResult { changes: PcbChange[]; duplicates: number; details: string[] }

const TRACKS = new Set(["segment", "arc", "via"]);
const uuidKid = (n: SNode): SNode | null => (K.kid(n, "uuid") || K.kid(n, "tstamp")) as SNode | null;

export function repairBoard(doc: BoardDoc): RepairResult {
  const ids = new Set<string>();
  let duplicates = 0;
  const work = new Map<string, SNode>(), retag = new Map<string, SNode>();   // footprints edited in place / top-level items that need a new id
  const nodeOf = (it: KItem): SNode => { let n = work.get(it.id); if (!n) { n = clone(it.node); work.set(it.id, n); } return n; };
  // processItem: a uuid seen before is replaced (RebindItemUuid( *aItem, KIID() ))
  const claim = (n: SNode, onDup: (u: SNode) => void): void => {
    const u = uuidKid(n); if (!u) return;
    const v = K.str(u[1]);
    if (ids.has(v)) { duplicates++; onDup(u); return; }
    ids.add(v);
  };
  const items = Array.from(doc.items.values());
  const fps = items.filter((it) => it.kind === "footprint");
  const inFp = (it: KItem, pick: (c: SNode) => boolean): void => {
    const orig = it.node;
    orig.forEach((c, i) => {
      if (i === 0 || !Array.isArray(c) || !pick(c as SNode)) return;
      claim(c as SNode, () => { const n = nodeOf(it); const u = uuidKid(n[i] as SNode); if (u) u[1] = K.newUuid(); });
    });
  };
  for (const fp of fps) claim(fp.node, () => { const n = nodeOf(fp); const u = uuidKid(n); if (u) u[1] = K.newUuid(); });
  for (const fp of fps) inFp(fp, (c) => c[0] === "pad");
  for (const it of items) if (TRACKS.has(it.kind)) claim(it.node, () => { const n = clone(it.node); const u = uuidKid(n); if (u) u[1] = K.newUuid(); retag.set(it.id, n); });
  for (const fp of fps) inFp(fp, (c) => c[0] !== "pad" && !!uuidKid(c));   // fields, graphics, zones, groups
  for (const it of items) if (it.kind !== "footprint" && !TRACKS.has(it.kind)) claim(it.node, () => { const n = clone(it.node); const u = uuidKid(n); if (u) u[1] = K.newUuid(); retag.set(it.id, n); });
  const changes: PcbChange[] = [];
  for (const [id, n] of work) { const it = doc.items.get(id); if (it) changes.push(replacedChange(it, n)); }
  // a top-level item's uuid is its id: it goes and comes back under the new one
  for (const [id, n] of retag) { const it = doc.items.get(id); if (it) { changes.push(removedChange(it)); changes.push(addedChange(doc, n)); } }
  return { changes, duplicates, details: duplicates ? [`${duplicates} duplicate IDs replaced.`] : [] };
}
