// bom.ts — the bill of materials of the open sheet or board, grouped the way an order is placed:
// one line per distinct part, with the vendor reference its symbols or footprints carry.
import type { Part, PriceBreak } from "./api";

export interface BomLine {
  key: string; refs: string[]; ids: string[]; value: string; footprint: string;
  vendor: string | null; vendorId: string; mpn: string; manufacturer: string;
  part: Part | null; err: string; loading: boolean;
  /** Sheets other than the open one that hold some of this line's parts (they cannot be edited from here). */
  elsewhere: string[];
}

/** Field names people and tools use for a vendor's part number. */
const VENDOR_FIELDS: [string, RegExp][] = [
  ["lcsc", /^(lcsc|jlc|jlcpcb)(\s*(part|pn|p\/n))?\s*(#|no\.?|number)?$/i],
  ["mouser", /^mouser(\s*(part|pn|p\/n))?\s*(#|no\.?|number)?$/i],
  ["digikey", /^digi-?key(\s*(part|pn|p\/n))?\s*(#|no\.?|number)?$/i],
  ["farnell", /^(farnell|newark|element14)(\s*(part|pn|p\/n|order\s*code))?\s*(#|no\.?|number)?$/i],
];
const MPN_FIELD = /^(mpn|mfr\.?\s*(part|pn|p\/n)(\s*(#|no\.?|number))?|manufacturer\s*part(\s*(#|no\.?|number))?|part\s*number)$/i;
const MAKER_FIELD = /^(manufacturer|mfr\.?|mfg\.?)$/i;

export function fieldsOf(K: KiCadCanvasApi, node: SNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of K.kids(node, "property")) out[K.str(p[1])] = K.str(p[2]);
  return out;
}

/** Which vendor part a set of fields names, if any. */
export function vendorRef(f: Record<string, string>): { vendor: string | null; vendorId: string; mpn: string; manufacturer: string } {
  let vendor: string | null = null, vendorId = "", mpn = "", manufacturer = "";
  for (const [name, value] of Object.entries(f)) {
    const v = value.trim(); if (!v || v === "~") continue;
    if (!mpn && MPN_FIELD.test(name)) mpn = v;
    if (!manufacturer && MAKER_FIELD.test(name)) manufacturer = v;
    for (const [id, re] of VENDOR_FIELDS) if (re.test(name.trim()) && (!vendor || (id === "lcsc" && vendor !== "lcsc"))) { vendor = id; vendorId = v; }   // LCSC first: it has the drawings and the assembly stock
  }
  return { vendor, vendorId, mpn, manufacturer };
}

const flag = (K: KiCadCanvasApi, node: SNode, key: string, def: boolean) => { const k = K.kid(node, key); return k ? K.str(k[1]) !== "no" : def; };
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The parts of a document that belong on a BOM, grouped into lines. */
export function collect(K: KiCadCanvasApi, doc: KDoc, isSch: boolean, others: { name: string; doc: KDoc }[] = []): BomLine[] {
  const lines = new Map<string, BomLine>(); const seen = new Set<string>();
  for (const src of [{ name: "", doc }, ...others]) for (const it of src.doc.items.values()) {
    if (it.kind !== (isSch ? "symbol" : "footprint")) continue;
    const f = fieldsOf(K, it.node); const ref = f.Reference || it.ref || "";
    if (!ref || ref.startsWith("#")) continue;                                   // power symbols and flags
    if (isSch) {
      if (!flag(K, it.node, "in_bom", true) || flag(K, it.node, "dnp", false)) continue;
      if (seen.has(ref)) { const l = [...lines.values()].find((x) => x.refs.includes(ref)); if (l && !src.name) l.ids.push(it.id); continue; }   // another unit of the same part
    } else {
      const attr = K.kid(it.node, "attr");
      if (attr && (attr.includes("exclude_from_bom") || attr.includes("dnp") || attr.includes("board_only"))) continue;
    }
    seen.add(ref);
    const v = vendorRef(f); const value = f.Value || it.value || ""; const footprint = isSch ? f.Footprint || "" : K.str(it.node[1]);
    const key = v.vendor ? `${v.vendor}:${v.vendorId}` : `?${value}|${footprint}|${v.mpn}`;
    let line = lines.get(key);
    if (!line) { line = { key, refs: [], ids: [], value, footprint, ...v, part: null, err: "", loading: false, elsewhere: [] }; lines.set(key, line); }
    line.refs.push(ref);
    if (!src.name) line.ids.push(it.id); else if (!line.elsewhere.includes(src.name)) line.elsewhere.push(src.name);
  }
  const out = [...lines.values()];
  for (const l of out) l.refs.sort(natural);
  return out.sort((a, b) => natural(a.refs[0], b.refs[0]));
}

/** The unit price that applies when buying `qty`. */
export function priceAt(prices: PriceBreak[], qty: number): PriceBreak | null {
  let best: PriceBreak | null = null;
  for (const b of [...prices].sort((a, c) => a.qty - c.qty)) { if (b.qty <= qty || !best) best = b; }
  return best;
}

export function totals(lines: BomLine[], boards: number): { parts: number; lines: number; matched: number; cost: number; currency: string; short: number } {
  let parts = 0, matched = 0, cost = 0, short = 0, currency = "USD";
  for (const l of lines) {
    const need = l.refs.length * boards; parts += l.refs.length;
    if (!l.part) continue;
    matched++;
    const p = priceAt(l.part.prices, need); if (p) { cost += p.price * need; currency = p.currency || currency; }
    if (l.part.stock !== null && l.part.stock < need) short++;
  }
  return { parts, lines: lines.length, matched, cost, currency, short };
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

/** The BOM file JLCPCB's assembly order takes: Comment, Designator, Footprint, LCSC Part #. */
export function jlcCsv(lines: BomLine[]): string {
  const rows = [["Comment", "Designator", "Footprint", "LCSC Part #"]];
  for (const l of lines) rows.push([l.value, l.refs.join(","), l.footprint.includes(":") ? l.footprint.slice(l.footprint.indexOf(":") + 1) : l.footprint, l.vendor === "lcsc" ? l.vendorId : ""]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** A full BOM with what the vendors said, for a spreadsheet. */
export function fullCsv(lines: BomLine[], boards: number): string {
  const rows = [["References", "Qty", "Value", "Footprint", "Vendor", "Vendor Part #", "MPN", "Manufacturer", "Description", "Stock", "Unit Price", "Line Total", "Currency", "Datasheet"]];
  for (const l of lines) {
    const need = l.refs.length * boards; const p = l.part ? priceAt(l.part.prices, need) : null;
    rows.push([l.refs.join(" "), String(need), l.value, l.footprint, l.part ? l.part.vendor_name : l.vendor || "", l.vendorId, (l.part && l.part.mpn) || l.mpn, (l.part && l.part.manufacturer) || l.manufacturer,
      l.part ? l.part.description : "", l.part && l.part.stock !== null ? String(l.part.stock) : "", p ? String(p.price) : "", p ? (p.price * need).toFixed(4) : "", p ? p.currency : "", l.part ? l.part.datasheet : ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Write a vendor part's reference onto symbols or footprints: the vendor field, MPN and
 * Manufacturer, hidden, as a placed vendor part carries them.  Returns the changes to commit.
 */
export function assignChanges(K: KiCadCanvasApi, doc: KDoc, ids: string[], fields: Record<string, string>): KChange[] {
  const esc = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const changes: KChange[] = [];
  for (const id of ids) {
    const item = doc.items.get(id); if (!item) continue;
    const node = (K.cloneNode as (n: SNode) => SNode)(item.node); const fp = node[0] === "footprint";
    for (const [name, value] of Object.entries(fields)) {
      if (!value || name === "Datasheet") continue;
      const have = K.kids(node, "property").find((p) => K.str(p[1]) === name);
      if (have) { have[2] = value; continue; }
      const at = fp ? [0, 0] : (K.atOf(node) as number[]).slice(0, 2);
      // parsed rather than built, so the name and value keep their quotes when written out
      const prop = K.parse(`(property ${esc(name)} ${esc(value)} (at ${at[0]} ${at[1]} 0)${fp ? ' (layer "F.Fab")' : ""} (hide yes) ${fp ? ` (uuid "${K.newUuid()}")` : ""} (effects (font (size ${fp ? "1 1" : "1.27 1.27"})${fp ? " (thickness 0.15)" : ""})))`);
      if (!prop) continue;
      const last = K.kids(node, "property").pop();
      node.splice(last ? node.indexOf(last) + 1 : node.length, 0, prop);
    }
    changes.push(K.replaceChange(doc, Object.assign({}, item, { node, geom: [], bbox: null })));
  }
  return changes;
}
