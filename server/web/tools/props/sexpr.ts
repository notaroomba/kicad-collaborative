// props/sexpr.ts — s-expression helpers: the node editors only touch the raw s-expression array, so
// they also run under node for the tests.
import { root } from "../root";

export const isList = Array.isArray as (v: unknown) => v is SNode;
export function kid(node: SNode, key: string): SNode | null { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
export function kids(node: SNode, key: string): SNode[] { const out: SNode[] = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
export function num(v: unknown, d = 0): number { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }
export function str(v: unknown): string { return v === undefined || v === null ? "" : String(v); }
export function has(node: SNode, tok: string): boolean { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
export function r6(v: unknown): number { return +(+(v as number)).toFixed(6); }          // the file's precision; also turns -0 into 0
export function clone(node: SNode): SNode { return root.KiCadCanvas.cloneNode(node); }   // not JSON: that drops the reader's record of which atoms were quoted
export function deg360(a: number): number { return ((Math.round(a) % 360) + 360) % 360; }
export function normDeg(a: number): number { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; }   // KiCad keeps board angles in (-180, 180]
export function atOf(node: SNode): [number, number, number] { return root.KiCadCanvas.atOf(node); }
/** x / y / rot left undefined keep the node's current value (kicad-canvas.js setAt). */
export function setAt(node: SNode, x: number | undefined, y: number | undefined, rot?: number): void { root.KiCadCanvas.setAt(node, x as number, y as number, rot); }
export function layerOf(node: SNode, def: string): string { const l = kid(node, "layer"); return l ? str(l[1]) : def; }
export function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) if (isList(node[j]) && (node[j] as SNode)[0] === key) return j; return -1; }
/** Replace the first (key …) child or insert one before the first of `before` (else append). */
export function setKid(node: SNode, key: string, values: SNode[number][], before?: string[]): SNode {
  const k = kid(node, key);
  if (k) { k.length = 1; k.push(...values); return k; }
  const n: SNode = [key, ...values];
  let at = node.length;
  for (const b of before || []) { const i = idxOf(node, b); if (i > 0) { at = i; break; } }
  node.splice(at, 0, n);
  return n;
}
export function delKid(node: SNode, key: string): void { const i = idxOf(node, key); if (i > 0) node.splice(i, 1); }
/** (key yes|no) children; a bare token (older files) counts as yes. */
export function yes(node: SNode, key: string, def: boolean): boolean { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key) ? true : def; }
export function setYesNo(node: SNode, key: string, on: boolean): void {
  const k = kid(node, key); if (k) { k[1] = on ? "yes" : "no"; return; }
  setKid(node, key, [on ? "yes" : "no"], ["fields_autoplaced", "uuid", "property"]);
}
