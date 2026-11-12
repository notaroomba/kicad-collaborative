// zone-damage.ts — which zones an edit makes stale: BOARD_COMMIT::propagateDamage (pcbnew/board_commit.cpp) feeding
// ZONE_FILLER_TOOL::ZoneFillDirty.  Pure: no editor state, so the node tests load it directly.

export type Box = [number, number, number, number];
/** One changed item's damage: its bounding box and the layers it lives on (children included). */
export interface Damage { box: Box; layers: Set<string> }

type Node = (string | number | Node)[];
const isList = (x: unknown): x is Node => Array.isArray(x);
const nameOf = (x: unknown): string => String(x);

/** A (layers …) / (layer …) list expanded the way LSET reads it: *.Cu → every copper layer, F&B.Cu → both sides. */
function expand(names: string[], copper: string[], out: Set<string>): void {
  for (const n of names) {
    if (n === "*.Cu") for (const c of copper) out.add(c);
    else if (n === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); }
    else if (n.startsWith("*.")) { out.add("F" + n.slice(1)); out.add("B" + n.slice(1)); }
    else out.add(n);
  }
}

/**
 * The layer set of an item and of its children (RunOnChildren recursion): every (layer …) and (layers …) in the
 * node, a via's (layers top bottom) being the span between them.  Fill data ((filled_polygon (layer …))) is not a
 * child item and is skipped.
 */
export function itemLayers(node: Node, copper: string[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node, head: string): void => {
    for (const c of n) {
      if (!isList(c)) continue;
      const k = c[0];
      if (k === "filled_polygon" || k === "fill_segments") continue;
      if (k === "layer" && c.length > 1) expand([nameOf(c[1])], copper, out);
      else if (k === "layers") {
        const names = c.slice(1).filter((x) => !isList(x)).map(nameOf);
        if (head === "via" && names.length === 2 && copper.includes(names[0]) && copper.includes(names[1])) {
          const a = copper.indexOf(names[0]), b = copper.indexOf(names[1]);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(copper[i]);
        } else expand(names, copper, out);
      } else if (typeof k === "string") walk(c, k);
    }
  };
  walk(node, nameOf(node[0]));
  return out;
}

/** propagateDamage's layer test: Edge.Cuts / Margin damage every physical layer, anything else only copper. */
export function damageLayers(layers: Set<string>, copper: string[]): Set<string> {
  const out = new Set<string>();
  if (layers.has("Edge.Cuts") || layers.has("Margin")) {
    for (const c of copper) out.add(c);
    for (const l of ["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Adhes", "B.Adhes"]) out.add(l);
    return out;
  }
  for (const l of layers) if (copper.includes(l)) out.add(l);
  return out;
}

const overlaps = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

export interface ZoneInfo { id: string; node: Node; bbox: Box | null }
/**
 * The zones to refill: a changed zone itself, every non-rule-area zone whose layer set meets an item's damage
 * layers and whose box meets its box (before and after the edit), and any zone that is not filled yet.
 */
export function staleZones(zones: ZoneInfo[], damage: Damage[], changedIds: Set<string>, copper: string[]): string[] {
  const dmg = damage.map((d) => ({ box: d.box, layers: damageLayers(d.layers, copper) })).filter((d) => d.layers.size);
  const out: string[] = [];
  for (const z of zones) {
    if (z.node.some((c) => isList(c) && c[0] === "keepout")) continue;
    const fill = z.node.find((c) => isList(c) && c[0] === "fill") as Node | undefined;
    const filled = !!fill && fill[1] === "yes";
    if (!filled || changedIds.has(z.id)) { out.push(z.id); continue; }
    const zl = new Set<string>();
    for (const c of z.node) if (isList(c) && (c[0] === "layer" || c[0] === "layers")) expand(c.slice(1).filter((x) => !isList(x)).map(nameOf), copper, zl);
    const zb = z.bbox; if (!zb) continue;
    if (dmg.some((d) => overlaps(d.box, zb) && [...d.layers].some((l) => zl.has(l)))) out.push(z.id);
  }
  return out;
}
