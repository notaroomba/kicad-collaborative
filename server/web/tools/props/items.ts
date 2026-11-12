// props/items.ts — other items: stroke / track widths, layers, texts, labels, junctions, vias, zones,
// and the board's layer names.
import { delKid, deg360, kid, num, r6, setAt, setKid, str } from "./sexpr";

export function strokeWidth(node: SNode): number { const s = kid(node, "stroke"); const w = s && kid(s, "width"); return w ? num(w[1]) : 0; }
export function setStrokeWidth(node: SNode, w: number): void { let s = kid(node, "stroke"); if (!s) s = setKid(node, "stroke", [], ["uuid", "tstamp"]); setKid(s, "width", [r6(w)]); }
export function setWidth(node: SNode, w: number): void { setKid(node, "width", [r6(w)], ["layer", "net", "uuid", "tstamp"]); }
export function setLayer(node: SNode, layer: string): void { setKid(node, "layer", [layer], ["net", "uuid", "tstamp", "effects"]); }
export function setText(node: SNode, text: unknown): void { node[1] = str(text); }
export function textSize(node: SNode): number { const e = kid(node, "effects"); const f = e && kid(e, "font"); const s = f && kid(f, "size"); return s ? num(s[2], num(s[1], 1.27)) : 1.27; }
export function setTextSize(node: SNode, size: number): void {
  let e = kid(node, "effects"); if (!e) e = setKid(node, "effects", [], ["uuid", "tstamp"]);
  let f = kid(e, "font"); if (!f) f = setKid(e, "font", [], ["justify", "hide"]);
  setKid(f, "size", [r6(size), r6(size)], ["thickness", "bold", "italic"]);
}
export function setRotation(node: SNode, deg: number): void { setAt(node, undefined, undefined, deg360(deg)); }
export function setShape(node: SNode, shape: string): void { setKid(node, "shape", [shape], ["at", "fields_autoplaced", "effects", "uuid"]); }
export function setDiameter(node: SNode, d: number): void { setKid(node, "diameter", [r6(d)], ["color", "uuid"]); }
export function setViaSize(node: SNode, s: number): void { setKid(node, "size", [r6(s)], ["drill", "layers", "net", "uuid", "tstamp"]); }
export function setViaDrill(node: SNode, d: number): void { setKid(node, "drill", [r6(d)], ["layers", "net", "uuid", "tstamp"]); }
export function setViaLayers(node: SNode, a: string, b: string): void { setKid(node, "layers", [a, b], ["net", "uuid", "tstamp"]); }
export function setZoneName(node: SNode, name: unknown): void { if (str(name)) setKid(node, "name", [str(name)], ["hatch", "priority", "connect_pads"]); else delKid(node, "name"); }
export function setZonePriority(node: SNode, p: unknown): void { p = Math.max(0, Math.round(num(p))); if (p) setKid(node, "priority", [p as number], ["connect_pads", "min_thickness"]); else delKid(node, "priority"); }

const STD_LAYERS = ["F.Cu", "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
/** Layer names to offer: the parsed table where it holds names, the ones in use, and the standard set. */
export function boardLayers(doc: KDoc, copperOnly: boolean): string[] {
  const names = new Set(STD_LAYERS);
  for (const k of doc.layers.keys()) if (k.includes(".")) names.add(k);
  for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && g.layer !== "holes" && g.layer.includes(".")) names.add(g.layer);
  const rank = (l: string) => l === "F.Cu" ? 0 : /^In\d+\.Cu$/.test(l) ? +l.slice(2) : l === "B.Cu" ? 500 : 1000 + STD_LAYERS.indexOf(l);
  return [...names].filter((l) => !copperOnly || /\.Cu$/.test(l)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
