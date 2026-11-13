// search-model.ts — the Search pane's Groups and Drills handlers as plain functions over the parsed s-expression
// nodes (no DOM, no globals), so the node tests can run them:
//
//   GROUP_SEARCH_HANDLER (pcbnew/widgets/search_handlers.cpp:387-450, eeschema/widgets/search_handlers.cpp:510-570):
//     every group (a board's generators are skipped), placed at its bounding box's centre (PCB_GROUP / SCH_GROUP
//     ::GetPosition).
//   DRILL_SEARCH_HANDLER (pcbnew/widgets/search_handlers.cpp:626-938): one row per distinct DRILL_LINE_ITEM (size,
//     shape, plated, pad or via, start and stop copper layer) with its count, most numerous first.
type N = unknown[];
const isList = (v: unknown): v is N => Array.isArray(v);
const head = (n: N) => String(n[0]);
const kid = (n: N, k: string): N | null => { for (const c of n) if (isList(c) && head(c) === k) return c; return null; };
const kids = (n: N, k: string): N[] => n.filter((c): c is N => isList(c) && head(c) === k);
const num = (v: unknown, d = 0): number => { const x = Number(v); return isFinite(x) ? x : d; };
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export interface DrillLine { xSize: number; ySize: number; slot: boolean; plated: boolean; pad: boolean; start: string | null; stop: string | null; qty: number; ids: string[] }

/** PCB layer order for a copper stack: F.Cu, In1.Cu … InN.Cu, B.Cu. */
function cuRank(l: string): number { return l === "F.Cu" ? 0 : l === "B.Cu" ? 1e6 : num((/^In(\d+)\.Cu$/.exec(l) || [])[1], -1); }
/** LSET::CuStack().front() / back() of a pad's layer list ("*.Cu" and "F&B.Cu" span the board's copper). */
export function padCuSpan(layers: string[], boardCopper: string[]): [string, string] | null {
  const cu = boardCopper.length ? boardCopper : ["F.Cu", "B.Cu"];
  let on: string[];
  if (layers.includes("*.Cu") || layers.includes("F&B.Cu")) on = cu.slice();
  else on = layers.filter((l) => /\.Cu$/.test(l) && cuRank(l) >= 0);
  if (!on.length) return null;
  on.sort((a, b) => cuRank(a) - cuRank(b));
  return [on[0], on[on.length - 1]];
}

/** The board's drills grouped as KiCad's Drills tab lists them. `items` are the board's top-level items. */
export function drillLines(items: Iterable<{ id: string; kind: string; node: N }>, boardCopper: string[]): DrillLine[] {
  const out: DrillLine[] = [];
  const add = (d: Omit<DrillLine, "qty" | "ids">, id: string) => {
    for (const g of out) if (g.xSize === d.xSize && g.ySize === d.ySize && g.slot === d.slot && g.plated === d.plated && g.pad === d.pad && g.start === d.start && g.stop === d.stop) { g.qty++; if (!g.ids.includes(id)) g.ids.push(id); return; }
    out.push(Object.assign({ qty: 1, ids: [id] }, d));
  };
  const list = Array.from(items);
  // pads first, then vias, as KiCad collects them
  for (const it of list) {
    if (it.kind !== "footprint") continue;
    for (const p of kids(it.node, "pad")) {
      const dr = kid(p, "drill"); if (!dr) continue;
      const oval = dr[1] === "oval";
      const vals = dr.slice(oval ? 2 : 1).filter((v) => !isList(v)).map((v) => num(v, NaN)).filter((v) => isFinite(v));
      const xs = vals[0] || 0, ys = oval ? vals[1] || xs : xs;
      if (xs <= 0 || ys <= 0) continue;
      const ls = kid(p, "layers"); const span = padCuSpan(ls ? ls.slice(1).map(str) : [], boardCopper);
      add({ xSize: xs, ySize: ys, slot: oval, plated: str(p[2]) !== "np_thru_hole", pad: true, start: span ? span[0] : null, stop: span ? span[1] : null }, it.id);
    }
  }
  for (const it of list) {
    if (it.kind !== "via") continue;
    const d = num((kid(it.node, "drill") || [])[1], 0); if (d <= 0) continue;
    const ls = kid(it.node, "layers"); const l = ls ? ls.slice(1).map(str) : ["F.Cu", "B.Cu"];
    const sorted = l.filter((x) => cuRank(x) >= 0).sort((a, b) => cuRank(a) - cuRank(b));
    add({ xSize: d, ySize: d, slot: false, plated: true, pad: false, start: sorted[0] || "F.Cu", stop: sorted[sorted.length - 1] || "B.Cu" }, it.id);
  }
  // DRILL_LINE_ITEM::COMPARE( COL_COUNT, false ): the largest count first
  return out.sort((a, b) => b.qty - a.qty);
}

/** One Drills row's cells (DRILL_SEARCH_HANDLER::cellText): Count, Shape, X Size, Y Size, Plated, Via/Pad, Start / Stop Layer. */
export function drillCells(d: DrillLine, len: (mm: number) => string, layerName: (l: string) => string): string[] {
  return [String(d.qty), d.slot ? "Slot" : "Round", len(d.xSize), len(d.ySize), d.plated ? "PTH" : "NPTH", d.pad ? "Pad" : "Via",
    d.start === null ? "N/A" : layerName(d.start), d.stop === null ? "N/A" : layerName(d.stop)];
}

/** The ids a group holds, its nested groups' members included (for its bounding box). */
export function groupLeafIds(node: N, groupsById: Map<string, N>, seen = new Set<string>()): string[] {
  const m = kid(node, "members"); const out: string[] = [];
  for (const id of m ? m.slice(1).map(str) : []) {
    const g = groupsById.get(id);
    if (g) { if (!seen.has(id)) { seen.add(id); out.push(...groupLeafIds(g, groupsById, seen)); } } else out.push(id);
  }
  return [...new Set(out)];
}
/** A group's name ((group "name" …)). */
export const groupName = (node: N): string => str(node[1]);
