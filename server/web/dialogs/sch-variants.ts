// dialogs/sch-variants — design variants of a schematic as the plot needs them (SCHEMATIC::GetVariantNamesForUI and
// SCH_SYMBOL's …ForVariant getters): the names the sheets' symbol instances and the project's schematic.variants
// carry, and a symbol node rewritten as one variant shows it on one sheet instance.  Pure: nothing is edited.
import { kid, kids, str } from "../canvas/sexpr";

export const DEFAULT_VARIANT = "< Default >";
const sexprKids = (n: unknown, key: string): unknown[][] => (Array.isArray(n) ? kids(n as SNode, key) : []) as unknown as unknown[][];
const sexprKid = (n: unknown, key: string): unknown[] | null => (Array.isArray(n) ? (kid(n as SNode, key) as unknown as unknown[] | null) : null) || null;
const sstr = (v: unknown): string => str(v as never);
/** The (variant …) lists of a symbol's (instances (project … (path …))) entries. */
function instanceVariants(node: unknown): { path: string; variant: unknown[] }[] {
  const out: { path: string; variant: unknown[] }[] = [];
  const inst = sexprKid(node, "instances"); if (!inst) return out;
  for (const proj of sexprKids(inst, "project")) for (const path of sexprKids(proj, "path")) for (const v of sexprKids(path, "variant")) out.push({ path: sstr(path[1]), variant: v });
  return out;
}
/** SCHEMATIC::GetVariantNamesForUI: the default, then every variant the sheets' symbols and the project's
 *  schematic.variants name, by StrNumCmp. */
export function schVariantNames(docs: { items: Map<string, { kind: string; node: unknown }> }[], pro: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const d of docs) for (const it of d.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    for (const { variant } of instanceVariants(it.node)) { const nm = sexprKid(variant, "name"); if (nm && sstr(nm[1])) names.add(sstr(nm[1])); }
  }
  const sch = pro.schematic; const listed = sch && typeof sch === "object" ? (sch as { variants?: unknown }).variants : undefined;
  if (Array.isArray(listed)) for (const e of listed) if (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" && (e as { name: string }).name) names.add((e as { name: string }).name);
  return [DEFAULT_VARIANT, ...[...names].sort(strNumCmp)];
}
/** StrNumCmp (case sensitive): runs of digits compare by value. */
export function strNumCmp(a: string, b: string): number {
  let i = 0, j = 0; const dig = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (dig(c1) && dig(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && dig(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && dig(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  return i >= a.length && j < b.length ? -1 : i < a.length && j >= b.length ? 1 : 0;
}

/** A symbol node as the variant shows it on the sheet instance `uuidPath`: its (dnp …), (exclude_from_sim …),
 *  (in_bom …) and the variant's field values (SCH_SYMBOL's …ForVariant getters).  Null when nothing changes. */
export function symbolNodeForVariant(node: unknown[], uuidPath: string[], variant: string): unknown[] | null {
  if (!variant) return null;
  const here = (p: string): boolean => { const segs = p.split("/").filter(Boolean); return segs.length === uuidPath.length + 1 && uuidPath.every((u, i) => segs[i + 1] === u); };
  const hit = instanceVariants(node).find((e) => here(e.path) && (() => { const nm = sexprKid(e.variant, "name"); return !!nm && sstr(nm[1]) === variant; })());
  if (!hit) return null;
  const copy = JSON.parse(JSON.stringify(node)) as unknown[];
  const setFlag = (key: string, on: boolean): void => {
    const val = on ? "yes" : "no", i = copy.findIndex((x) => Array.isArray(x) && x[0] === key);
    if (i >= 0) copy[i] = [key, val]; else copy.splice(1, 0, [key, val]);
  };
  for (const [key, out] of [["dnp", "dnp"], ["exclude_from_sim", "exclude_from_sim"], ["in_bom", "in_bom"], ["on_board", "on_board"]] as const) {
    const k = sexprKid(hit.variant, key); if (k) setFlag(out, /^(yes|true)$/.test(sstr(k[1])));
  }
  for (const f of sexprKids(hit.variant, "field")) {
    const nm = sexprKid(f, "name"), val = sexprKid(f, "value"); if (!nm) continue;
    const prop = copy.find((x) => Array.isArray(x) && x[0] === "property" && sstr(x[1]) === sstr(nm[1])) as unknown[] | undefined;
    if (prop) prop[2] = val ? sstr(val[1]) : "";
  }
  return copy;
}

