// symedit/merge.ts — item-level three-way merge of one library symbol, so that a symbol edited by two people at once
// keeps both edits and an undo takes back only the undoing user's own change.
//
// KiCad's library editor works on a private copy of a LIB_SYMBOL and its undo list holds copies of that symbol;
// the schematic and board editors here sync item by item.  A library symbol travels as one whole (symbol …) text,
// so every edit carries the text it was made against (`base`) beside its result (`sexpr`), and whoever applies it
// to a symbol that has moved on since (someone else's edit sequenced first) carries over only what changed between
// base and result:
//   - keyed children (a (property "Name" …), a sub-symbol (symbol "Name_u_b" …), a single header token such as
//     (pin_names …) or (in_bom …), the atoms of a node) are merged recursively; a value both sides changed takes
//     the later edit's value;
//   - the drawn items of a unit (pins, rectangles, texts, …) are a multiset: what the edit removed goes, what it
//     added comes in next to its neighbours in the edit's own order.  A pin the edit changed but someone else
//     changed (or removed) first is matched by its number, so the later edit's version replaces it instead of
//     leaving two copies.
// Every client applies the server's ops in the same order to the same buffer, so the deterministic merge converges.
import { cloneNode, isList, QUOTED, quotedMask } from "../canvas/sexpr";
import { serialize } from "../canvas/export";

type N = SNode;
type A = SNode[number];

/** The drawn items of a (sub-)symbol: unkeyed, compared by their whole text. */
const ITEMS = new Set(["pin", "rectangle", "polyline", "bezier", "circle", "arc", "ellipse", "ellipse_arc", "text", "text_box", "alternate", "custom_property"]);

const txt = (a: A): string => (isList(a) ? serialize(a) : typeof a === "string" ? "s:" + a : "a:" + String(a));
const same = (a: A, b: A): boolean => a === b || txt(a) === txt(b);

interface Kid { key: string | null; t: string; a: A; q: boolean }
function kidsOf(n: N): Kid[] {
  const mask = quotedMask(n);
  const seen = new Map<string, number>(); const out: Kid[] = [];
  n.forEach((a, i) => {
    let key: string | null;
    if (!isList(a)) key = "@" + i;
    else {
      const h = String(a[0]);
      if (ITEMS.has(h)) key = null;
      else {
        const base = (h === "property" || h === "symbol") && a.length > 1 && !isList(a[1]) ? h + "\u0000" + String(a[1]) : h;
        const c = seen.get(base) || 0; seen.set(base, c + 1); key = base + "#" + c;
      }
    }
    out.push({ key, t: txt(a), a, q: !isList(a) && i < 30 && !!(mask & (1 << i)) });
  });
  return out;
}
const pinNumber = (a: A): string | null => {
  if (!isList(a) || a[0] !== "pin") return null;
  for (const c of a) if (isList(c) && c[0] === "number") return String(c[1]);
  return null;
};

/** cur with the change base → mine laid over it.  The arguments are not changed; the result shares no nodes with them. */
export function merge3(base: A, mine: A, cur: A): A {
  if (same(cur, base)) return cloneNode(mine);
  if (same(mine, base) || same(mine, cur)) return cloneNode(cur);
  if (!isList(base) || !isList(mine) || !isList(cur) || !mine.length || !cur.length || !same(mine[0], cur[0])) return cloneNode(mine);
  const bk = kidsOf(base), mk = kidsOf(mine), ck = kidsOf(cur);
  const bMap = new Map<string, Kid>(), mMap = new Map<string, Kid>(), cMap = new Map<string, Kid>();
  for (const k of bk) if (k.key) bMap.set(k.key, k);
  for (const k of mk) if (k.key) mMap.set(k.key, k);
  for (const k of ck) if (k.key) cMap.set(k.key, k);
  // unkeyed items: what the edit removed and what it added (multisets of texts)
  const count = (ks: Kid[]) => { const m = new Map<string, number>(); for (const k of ks) if (!k.key) m.set(k.t, (m.get(k.t) || 0) + 1); return m; };
  const bc = count(bk), mc = count(mk);
  const removed = new Map<string, number>(), added = new Map<string, number>();
  for (const [t, n] of bc) { const d = n - (mc.get(t) || 0); if (d > 0) removed.set(t, d); }
  for (const [t, n] of mc) { const d = n - (bc.get(t) || 0); if (d > 0) added.set(t, d); }

  // 1. cur's children, in cur's order, with the edit's removals and changes
  interface R { key: string | null; t: string; a: A; q: boolean; fresh?: boolean }
  const out: R[] = [];
  for (const c of ck) {
    if (c.key) {
      const b = bMap.get(c.key), m = mMap.get(c.key);
      if (b && !m) continue;                                  // the edit removed it
      if (!b && !m) { out.push({ ...c }); continue; }         // only cur has it
      if (!b && m) { out.push({ key: c.key, t: m.t, a: cloneNode(m.a), q: m.q }); continue; }   // both added: the later edit wins
      const v = same(b!.a, m!.a) ? cloneNode(c.a) : merge3(b!.a, m!.a, c.a);
      out.push({ key: c.key, t: txt(v), a: v, q: same(v, m!.a) ? m!.q : c.q });
    } else {
      const r = removed.get(c.t) || 0;
      if (r > 0) { removed.set(c.t, r - 1); continue; }
      out.push({ key: null, t: c.t, a: cloneNode(c.a), q: c.q });
    }
  }
  // a changed pin that someone else changed first: the edit's version replaces theirs (matched by number)
  const addedPins = new Set<string>();
  for (const k of mk) if (!k.key && added.has(k.t)) { const p = pinNumber(k.a); if (p !== null) addedPins.add(p); }
  for (const k of bk) {
    if (k.key || !(removed.get(k.t)! > 0)) continue;
    removed.set(k.t, removed.get(k.t)! - 1);
    const p = pinNumber(k.a); if (p === null || !addedPins.has(p)) continue;
    const i = out.findIndex((r) => !r.key && pinNumber(r.a) === p && !mc.has(r.t)); if (i >= 0) out.splice(i, 1);
  }
  // 2. what the edit added (or changed where cur no longer has it), next to its neighbour in the edit's order
  let anchor = -1;
  const used = new Set<number>();
  for (const m of mk) {
    let at = -1;
    if (m.key) at = out.findIndex((r) => r.key === m.key);
    else { at = out.findIndex((r, i) => !r.key && !used.has(i) && r.t === m.t && !r.fresh); }
    if (at >= 0) { used.add(at); anchor = at; continue; }
    let insert = false;
    if (m.key) { const b = bMap.get(m.key); insert = !b || !same(b.a, m.a); }   // new, or changed while cur removed it
    else { const n = added.get(m.t) || 0; if (n > 0) { added.set(m.t, n - 1); insert = true; } }
    if (!insert) continue;
    // after what only cur added at the same place (the other user's edit came first)
    let at2 = anchor + 1;
    while (at2 < out.length && !out[at2].fresh && !(out[at2].key ? mMap.has(out[at2].key!) : mc.has(out[at2].t))) at2++;
    out.splice(at2, 0, { key: m.key, t: m.t, a: cloneNode(m.a), q: m.q, fresh: true });
    // indexes after the insertion point moved by one
    const moved = [...used].map((i) => (i >= at2 ? i + 1 : i)); used.clear(); for (const i of moved) used.add(i);
    anchor = at2; used.add(anchor);
  }
  const res: N = out.map((r) => r.a);
  let q = 0; out.forEach((r, i) => { if (r.q && i < 30) q |= 1 << i; }); if (q) QUOTED.set(res, q);
  return res;
}

/** The symbol text `cur` with the edit `base` → `mine` carried over (texts in, text out). */
export function mergeSymbolText(base: string, mine: string, cur: string, parse: (s: string) => N): string {
  if (cur === base) return mine;
  if (mine === base) return cur;
  return serialize(merge3(parse(base), parse(mine), parse(cur)));
}
