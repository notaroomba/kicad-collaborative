// props/fields.ts — fields (symbols, footprints, sheets).
import { atOf, delKid, has, kid, kids, layerOf, setKid, str } from "./sexpr";

const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
export function field(node: SNode, name: string): SNode | null { for (const p of kids(node, "property")) if (str(p[1]) === name) return p; return null; }
export function fieldList(node: SNode): SNode[] {
  const all = kids(node, "property").filter((p) => !str(p[1]).startsWith("ki_"));
  const rank = (p: SNode) => { const i = MANDATORY.indexOf(str(p[1])); return i < 0 ? MANDATORY.length : i; };
  return all.map((p, i) => [p, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}
/** Set a field's text; a missing field is created hidden at the anchor. */
export function setField(node: SNode, name: string, value: unknown): SNode {
  let p = field(node, name);
  if (!p) {
    const fp = node[0] === "footprint";
    const [x, y] = fp ? [0, 0] : atOf(node);
    p = ["property", name, "", ["at", x, y, 0]];
    if (fp) p.push(["layer", layerOf(node, "F.Cu") === "B.Cu" ? "B.Fab" : "F.Fab"]);
    p.push(["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]);
    const last = kids(node, "property").pop();
    node.splice(last ? node.indexOf(last) + 1 : node.length, 0, p);
  }
  p[2] = str(value);
  return p;
}
export function isHidden(p: SNode): boolean {
  const h = kid(p, "hide"); if (h) return str(h[1]) !== "no";
  if (has(p, "hide")) return true;
  const e = kid(p, "effects"); if (!e) return false;
  const eh = kid(e, "hide"); return has(e, "hide") || !!(eh && str(eh[1]) !== "no");
}
/** (hide yes) as KiCad 8+ writes it; older files carried a bare `hide` inside effects, which we drop. */
export function setFieldHidden(node: SNode, name: string, hidden: boolean): boolean {
  const p = field(node, name); if (!p) return false;
  const e = kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); delKid(e, "hide"); }
  const i = p.indexOf("hide"); if (i > 2) p.splice(i, 1);
  delKid(p, "hide");
  if (hidden) setKid(p, "hide", ["yes"], ["show_name", "do_not_autoplace", "uuid", "effects"]);
  return true;
}
