// fab/gpos-kern.ts — pair kerning read from a font's GPOS table.
//
// KiCad shapes outline-font text with HarfBuzz, which kerns from the GPOS 'kern' feature.  Most current fonts
// keep their pair adjustments in extension lookups (type 9), which opentype.js does not follow, so the table is
// read here: the 'kern' feature of the text's script, pair adjustment lookups in both formats (glyph pairs and
// class pairs), the first glyph's advance adjustment.  Values are font units.

type Kern = (left: number, right: number) => number;

const NONE: Kern = () => 0;
const bits = (v: number): number => { let n = 0; for (let b = v & 0xff; b; b >>= 1) n += b & 1; return n; };

/** The kerning of a font file for a script ("latn", "cyrl", "grek" …; the font's default when it has no such script). */
export function gposKerning(data: ArrayBuffer, script: string): Kern {
  try { return read(new DataView(data), script); } catch (e) { return NONE; }
}

function read(d: DataView, script: string): Kern {
  // the sfnt table directory (a collection's first face is not looked into: the server hands out single faces)
  const tag = (o: number): string => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
  const n = d.getUint16(4); let gpos = 0;
  for (let i = 0; i < n; i++) if (tag(12 + 16 * i) === "GPOS") gpos = d.getUint32(12 + 16 * i + 8);
  if (!gpos) return NONE;
  const u16 = (o: number): number => d.getUint16(o), i16 = (o: number): number => d.getInt16(o);
  const scripts = gpos + u16(gpos + 4), features = gpos + u16(gpos + 6), lookups = gpos + u16(gpos + 8);

  // script -> default language system -> its features named 'kern' -> lookup indices
  const scriptOf = new Map<string, number>();
  for (let i = 0, c = u16(scripts); i < c; i++) scriptOf.set(tag(scripts + 2 + 6 * i), scripts + u16(scripts + 2 + 6 * i + 4));
  const st = scriptOf.get(script) ?? scriptOf.get("DFLT") ?? scriptOf.get("latn") ?? [...scriptOf.values()][0];
  if (st === undefined) return NONE;
  let lang = u16(st) ? st + u16(st) : 0;
  if (!lang && u16(st + 2)) lang = st + u16(st + 2 + 4);   // no default: the first language system
  if (!lang) return NONE;
  const wanted: number[] = [];
  for (let i = 0, c = u16(lang + 4); i < c; i++) {
    const fi = u16(lang + 6 + 2 * i); if (fi >= u16(features) || tag(features + 2 + 6 * fi) !== "kern") continue;
    const ft = features + u16(features + 2 + 6 * fi + 4);
    for (let k = 0, lc = u16(ft + 2); k < lc; k++) { const li = u16(ft + 4 + 2 * k); if (!wanted.includes(li)) wanted.push(li); }
  }
  wanted.sort((a, b) => a - b);

  const coverage = (o: number): Map<number, number> => {
    const m = new Map<number, number>();
    if (u16(o) === 1) for (let i = 0, c = u16(o + 2); i < c; i++) m.set(u16(o + 4 + 2 * i), i);
    else if (u16(o) === 2) for (let i = 0, c = u16(o + 2); i < c; i++) { const s = u16(o + 4 + 6 * i), e = u16(o + 6 + 6 * i), ci = u16(o + 8 + 6 * i); for (let g = s; g <= e; g++) m.set(g, ci + g - s); }
    return m;
  };
  const classes = (o: number): Map<number, number> => {
    const m = new Map<number, number>();
    if (u16(o) === 1) { const s = u16(o + 2); for (let i = 0, c = u16(o + 4); i < c; i++) { const cl = u16(o + 6 + 2 * i); if (cl) m.set(s + i, cl); } }
    else if (u16(o) === 2) for (let i = 0, c = u16(o + 2); i < c; i++) { const s = u16(o + 4 + 6 * i), e = u16(o + 6 + 6 * i), cl = u16(o + 8 + 6 * i); if (cl) for (let g = s; g <= e; g++) m.set(g, cl); }
    return m;
  };

  // one pair-adjustment subtable: undefined = does not apply to the pair, a number = its advance adjustment
  type Sub = (l: number, r: number) => number | undefined;
  const subtable = (o: number): Sub | null => {
    const format = u16(o), cov = coverage(o + u16(o + 2)), vf1 = u16(o + 4), vf2 = u16(o + 6);
    const s1 = 2 * bits(vf1), s2 = 2 * bits(vf2), adv = vf1 & 4 ? 2 * bits(vf1 & 3) : -1;
    if (format === 1) {
      const sets = new Map<number, Map<number, number>>();
      return (l, r) => {
        const ci = cov.get(l); if (ci === undefined || ci >= u16(o + 8)) return undefined;
        let set = sets.get(l);
        if (!set) {
          set = new Map(); const ps = o + u16(o + 10 + 2 * ci);
          for (let i = 0, c = u16(ps); i < c; i++) { const rec = ps + 2 + i * (2 + s1 + s2); set.set(u16(rec), adv < 0 ? 0 : i16(rec + 2 + adv)); }
          sets.set(l, set);
        }
        return set.get(r);   // a pair this set does not list is left to the next subtable
      };
    }
    if (format === 2) {
      const c1 = classes(o + u16(o + 8)), c2 = classes(o + u16(o + 10)), n1 = u16(o + 12), n2 = u16(o + 14);
      return (l, r) => {
        if (!cov.has(l)) return undefined;
        const a = c1.get(l) || 0, b = c2.get(r) || 0; if (a >= n1 || b >= n2) return 0;
        return adv < 0 ? 0 : i16(o + 16 + (a * n2 + b) * (s1 + s2) + adv);
      };
    }
    return null;
  };

  const tables: Sub[][] = [];
  for (const li of wanted) {
    if (li >= u16(lookups)) continue;
    const lk = lookups + u16(lookups + 2 + 2 * li); let type = u16(lk); const subs: Sub[] = [];
    for (let i = 0, c = u16(lk + 4); i < c; i++) {
      let so = lk + u16(lk + 6 + 2 * i), t = type;
      if (t === 9) { t = u16(so + 2); so += d.getUint32(so + 4); }   // an extension: the real subtable is elsewhere
      if (t !== 2) continue;
      const s = subtable(so); if (s) subs.push(s);
    }
    if (subs.length) tables.push(subs);
    type = 0;
  }
  if (!tables.length) return NONE;
  const memo = new Map<number, number>();
  return (l, r) => {
    const key = l * 65536 + r; let v = memo.get(key);
    if (v === undefined) {
      v = 0;
      for (const subs of tables) for (const s of subs) { const k = s(l, r); if (k !== undefined) { v += k; break; } }
      memo.set(key, v);
    }
    return v;
  };
}
