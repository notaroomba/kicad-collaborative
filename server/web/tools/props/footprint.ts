// props/footprint.ts — footprints (board): position, rotation, side, attributes, and net names.
import { atOf, delKid, has, isList, kid, kids, layerOf, normDeg, num, r6, setAt, setKid, str } from "./sexpr";

export function flipLayer(name: string): string { return /^F\./.test(name) ? "B." + name.slice(2) : /^B\./.test(name) ? "F." + name.slice(2) : name; }
export function setFootprintPosition(node: SNode, x: number, y: number): void { setAt(node, r6(x), r6(y)); }
/** Pad and text angles are absolute in the file, so they follow the body. */
export function setFootprintRotation(node: SNode, deg: number): boolean {
  const d = deg - atOf(node)[2]; if (!d) return false;
  setAt(node, undefined, undefined, normDeg(deg));
  for (const c of node) if (isList(c) && (c[0] === "pad" || c[0] === "fp_text" || c[0] === "property")) { const at = kid(c, "at"); if (at) at[3] = normDeg(num(at[3]) + d); }
  return true;
}
/** Negate the local Y of a graphic (line/rect/circle/arc/poly and pad primitives). */
function mirrorYGraphic(g: SNode): void {
  for (const key of ["start", "end", "center", "mid"]) { const k = kid(g, key); if (k) k[2] = r6(-num(k[2])); }
  const pts = kid(g, "pts"); if (pts) for (const xy of pts) if (isList(xy) && xy[0] === "xy") xy[2] = r6(-num(xy[2]));
}
function setMirrored(textNode: SNode, on: boolean): void {
  let e = kid(textNode, "effects"); if (!e) e = setKid(textNode, "effects", []);
  const j = kid(e, "justify");
  if (on) { if (!j) setKid(e, "justify", ["mirror"]); else if (!has(j, "mirror")) j.push("mirror"); }
  else if (j) { const i = j.indexOf("mirror"); if (i > 0) j.splice(i, 1); if (j.length === 1) delKid(e, "justify"); }
}
/**
 * Put a footprint on the other side the way KiCad's Flip does (about the X axis
 * through its anchor): back-side files hold the library shape with local Y
 * negated, the orientation and every absolute angle negate, F.* / B.* layers
 * swap and texts toggle their mirror flag.  leftRight picks KiCad's other flip
 * direction, which instead maps the orientation to 180 − θ.
 */
export function setFootprintSide(node: SNode, side: string, leftRight?: boolean): boolean {
  if (layerOf(node, "F.Cu") === side) return false;
  const ang = (a: number) => normDeg(leftRight ? 180 - a : -a);
  const flipAt = (c: SNode) => { const at = kid(c, "at"); if (!at) return; at[2] = r6(-num(at[2])); const a = ang(num(at[3])); if (a || at.length > 3) at[3] = a; };
  const flipLayers = (c: SNode) => { const l = kid(c, "layer"); if (l) l[1] = flipLayer(str(l[1])); const ls = kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayer(str(ls[i])); };
  setKid(node, "layer", [side], ["uuid", "tstamp", "at", "transform"]);
  setAt(node, undefined, undefined, ang(atOf(node)[2]));
  for (const c of node) {
    if (!isList(c)) continue;
    const k = c[0] as string;
    if (k === "pad") {
      flipAt(c); flipLayers(c);
      const dr = kid(c, "drill"); const off = dr && kid(dr, "offset"); if (off) off[2] = r6(-num(off[2]));
      const prims = kid(c, "primitives"); if (prims) for (const g of prims) if (isList(g)) mirrorYGraphic(g);
    } else if (k === "property" || k === "fp_text") {
      if (!kid(c, "at")) continue;
      flipAt(c); flipLayers(c);
      setMirrored(c, /^B\./.test(layerOf(c, side)));
    } else if (/^fp_/.test(k)) {
      mirrorYGraphic(c); flipLayers(c);
    }
  }
  return true;
}
const ATTR_TYPES = ["smd", "through_hole"];
// the writer's order (pcb_io_kicad_sexpr.cpp:1924-1951)
const ATTR_FLAGS = ["board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges"] as const;
/** The (attr …) tokens of a footprint: its type, the flags we know and the tokens we don't. */
export type FootprintAttrs = { type: string; other?: string[] } & { [F in (typeof ATTR_FLAGS)[number]]?: boolean };
export function footprintAttrs(node: SNode): FootprintAttrs {
  const a = kid(node, "attr"); const toks = a ? a.slice(1).map(str) : [];
  const out: FootprintAttrs = { type: toks.find((t) => ATTR_TYPES.includes(t)) || "" };
  for (const f of ATTR_FLAGS) out[f] = toks.includes(f);
  out.other = toks.filter((t) => !ATTR_TYPES.includes(t) && !(ATTR_FLAGS as readonly string[]).includes(t));   // tokens we don't know survive untouched
  return out;
}
export function setFootprintAttrs(node: SNode, attrs: Partial<FootprintAttrs>): void {
  const cur = Object.assign(footprintAttrs(node), attrs);
  const toks: string[] = []; if (cur.type) toks.push(cur.type);
  for (const f of ATTR_FLAGS) if (cur[f]) toks.push(f);
  toks.push(...(cur.other || []));
  if (toks.length) setKid(node, "attr", toks, ["fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "model"]);
  else delKid(node, "attr");
}
/** Net name of a track/via/zone/pad: inline in new files, else from the pads' (net n "name") table. */
export function netNameOf(doc: KDoc | null | undefined, node: SNode): string {
  const nn = kid(node, "net_name"); if (nn) return str(nn[1]);
  const n = kid(node, "net"); if (!n || n.length < 2) return "";
  if (typeof n[1] !== "number") return str(n[1]);
  if (n.length > 2) return str(n[2]);
  const code = n[1]; if (code === 0) return "";
  if (doc) for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const p of kids(it.node, "pad")) { const pn = kid(p, "net"); if (pn && pn.length > 2 && num(pn[1], -1) === code) return str(pn[2]); }
  }
  return "#" + code;
}
