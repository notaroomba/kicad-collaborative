// kicad-dialogs/sexpr.ts — the small s-expression and formatting helpers the dialogs share.
import type { PropsApi } from "../props/index";
import type { PropsHelpers } from "../props/helpers";
import { root } from "../root";

/** props.js as the dialogs use it: each helper is checked before use, the dialogs fall back to their own. */
type PropsView = Omit<PropsApi, "helpers"> & { helpers: Partial<PropsHelpers> };

export const K = (): ToolsCanvasApi => root.KiCadCanvas;
export const PROPS = (): PropsView | undefined => root.CollabTools && root.CollabTools.props;
export const clone = (n: SNode): SNode => K().cloneNode(n);   // not JSON: that drops the reader's record of which atoms were quoted
export const str = (v: unknown): string => v === undefined || v === null ? "" : String(v);
export const num = (v: unknown, d = 0): number => { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; };
export const r4 = (v: unknown): number => +(+(v as number)).toFixed(4);
export const isList = Array.isArray as (v: unknown) => v is SNode;
export const esc = (s: unknown): string => str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function kid(node: SNode, key: string): SNode | null { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
export function kids(node: SNode, key: string): SNode[] { const out: SNode[] = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
export function has(node: SNode, tok: string): boolean { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
export function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) if (isList(node[j]) && (node[j] as SNode)[0] === key) return j; return -1; }
export function delKid(node: SNode, key: string): void { const i = idxOf(node, key); if (i > 0) node.splice(i, 1); }
export function yesKid(node: SNode, key: string): boolean { const k = kid(node, key); return !!k && str(k[1]) !== "no"; }
/** Set (key …values), replacing an existing child or inserting before the first of `before`. */
export function setKid(node: SNode, key: string, values: SNode[number][], before?: string[]): SNode {
  const i = idxOf(node, key);
  if (i > 0) { node[i] = [key, ...values]; return node[i] as SNode; }
  let at = node.length;
  for (const b of before || []) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  const c: SNode = [key, ...values]; node.splice(at, 0, c); return c;
}
