// sim/netlist-formats — the board netlist formats of File > Export > Netlist (eeschema/netlist_exporters), pure:
//   OrcadPCB2  NETLIST_EXPORTER_ORCADPCB2   "( { EESchema Netlist Version 1.1 created  <ISO 8601> }" …
//   CadStar    NETLIST_EXPORTER_CADSTAR     .HEA / .TIM / .APP, .ADD_COM lines, .ADD_TER / .TER nets, .END
//   PADS       NETLIST_EXPORTER_PADS        *PADS-PCB* *PART* … *NET* *SIGNAL* … *END*
// Symbols go sheet instance by sheet instance, by uuid on each sheet; a reference is written once, from the first
// unit met (findNextSymbol); symbols excluded from the board and "#" references are left out.  Nets by name
// (wxString order), their pins by reference then pin number, duplicates dropped.
import type { Netlist, NetComponent } from "../canvas/pcb-netlist";

export const NETLIST_HEAD_STRING = "EESchema Netlist Version 1.1";

/** GetISO8601CurrentDateTime: local time, "%Y-%m-%dT%H:%M:%S" and the offset as "+hhmm" (kicad-cli's files: "2024-12-19T18:53:31+0000"). */
export function iso8601(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0"), off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** StrNumCmp, case-insensitive (CreatePinList's pin order). */
function strNumCmp(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g, ta = a.toUpperCase().match(re) || [], tb = b.toUpperCase().match(re) || [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i], dx = /^\d/.test(x), dy = /^\d/.test(y);
    if (dx && dy) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d < 0 ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

/** The components in the exporters' walk order, each with the symbol path of the unit the walk meets first. */
export function exportOrder(nl: Netlist): { comp: NetComponent; path: string }[] {
  const instIndex = new Map<string, number>();
  for (const i of nl.instances || []) instIndex.set("/" + i.uuidPath.slice(1).map((u) => u + "/").join(""), i.index);
  const keyOf = (p: string): [number, string] => { const k = p.lastIndexOf("/"), sheet = p.slice(0, k + 1); return [instIndex.has(sheet) ? instIndex.get(sheet)! : 1e9, p.slice(k + 1)]; };
  const rows = nl.components.filter((c) => !c.ref.startsWith("#") && !c.excludeFromBoard).map((comp) => {
    let best = comp.paths[0], bk = keyOf(best);
    for (const p of comp.paths) { const k = keyOf(p); if (k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) { best = p; bk = k; } }
    return { comp, path: best, k: bk };
  });
  rows.sort((a, b) => a.k[0] - b.k[0] || cmp(a.k[1], b.k[1]));
  return rows.map(({ comp, path }) => ({ comp, path }));
}

/** GetValue / GetFootprintFieldText( RESOLVED ): the symbol's own field references (${FIELD}, ${REFERENCE}, ${VALUE},
 *  ${FOOTPRINT}) resolved, a reference nothing defines left as written. */
export function resolveField(comp: NetComponent, text: string, depth = 0): string {
  if (depth > 10 || text.indexOf("${") < 0) return text;
  return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
    const up = name.toUpperCase();
    const v = up === "REFERENCE" ? comp.ref : up === "VALUE" ? comp.value : up === "FOOTPRINT" ? comp.footprint
      : Object.prototype.hasOwnProperty.call(comp.fields, name) ? comp.fields[name] : undefined;
    return v === undefined ? m : resolveField(comp, v, depth + 1);
  });
}
const valueOf = (c: NetComponent): string => resolveField(c, c.value), footprintOf = (c: NetComponent): string => resolveField(c, c.footprint);

/** m_exportNets with each net's pins sorted and de-duplicated, nets by name. */
function sortedNets(nl: Netlist): [string, { ref: string; pin: string }[]][] {
  const out: [string, { ref: string; pin: string }[]][] = [];
  for (const [name, pins] of nl.nets) {
    const s = pins.slice().sort((a, b) => cmp(a.ref, b.ref) || cmp(a.pin, b.pin));
    out.push([name, s.filter((p, i) => i === 0 || p.ref !== s[i - 1].ref || p.pin !== s[i - 1].pin)]);
  }
  return out.sort((a, b) => cmp(a[0], b[0]));
}

export function orcadPcb2(nl: Netlist, now: Date): string {
  let f = `( { ${NETLIST_HEAD_STRING} created  ${iso8601(now)} }\n`;
  for (const { comp, path } of exportOrder(nl)) {
    let fp = footprintOf(comp).replace(/ /g, "_"); if (fp === "") fp = "$noname";
    f += ` ( ${path} ${fp}  ${comp.ref} ${valueOf(comp).replace(/ /g, "_")}\n`;
    const pins = [...comp.pins.entries()].sort((a, b) => strNumCmp(a[0], b[0]));
    for (const [num, p] of pins) { if (num === "") continue; f += `  ( ${num.padStart(4)} ${p.net.replace(/ /g, "_")} )\n`; }
    f += " )\n";
  }
  return f + ")\n*\n";
}

export function cadstar(nl: Netlist, now: Date, buildVersion: string): string {
  let f = `.HEA\n.TIM ${iso8601(now)}\n.APP "Eeschema ${buildVersion}"\n.TYP FULL\n\n`;
  for (const { comp } of exportOrder(nl)) {
    const fp = footprintOf(comp) === "" ? "$noname" : footprintOf(comp);
    f += `.ADD_COM     ${comp.ref}     "${valueOf(comp).replace(/ /g, "_")}"     "${fp}"\n`;
  }
  f += "\n";
  for (const [name, pins] of sortedNets(nl).map(([n, p]) => [`"${n}"`, p] as [string, { ref: string; pin: string }[]]).sort((a, b) => cmp(a[0], b[0]))) {
    let ter = 0, init = "";
    for (const p of pins) {
      if (p.ref.startsWith("#")) continue;
      if (ter === 0) { init = `\n.ADD_TER   ${p.ref}   ${p.pin}     ${name}`; ter++; }
      else if (ter === 1) { f += `${init}\n.TER       ${p.ref}   ${p.pin}\n`; ter++; }
      else f += `            ${p.ref}   ${p.pin}\n`;
    }
  }
  return f + "\n.END\n";
}

export function pads(nl: Netlist): string {
  let f = "*PADS-PCB*\n*PART*\n";
  for (const { comp } of exportOrder(nl)) {
    let fp = footprintOf(comp).trim().replace(/ /g, "_");
    if (fp === "") fp = valueOf(comp).replace(/ /g, "_").trim();
    f += `${comp.ref.padEnd(16)} ${fp}\n`;
  }
  f += "\n*NET*\n";
  for (const [name, pins] of sortedNets(nl)) {
    const conns = pins.filter((p) => !p.ref.startsWith("#")).map((p) => `${p.ref}.${p.pin}`);
    if (conns.length <= 1) continue;
    f += `*SIGNAL* ${name}\n`;
    conns.forEach((c, cnt) => { f += c + (cnt !== 0 && cnt % 6 === 0 ? "\n" : " "); });
    f += "\n";
  }
  return f + "*END*\n";
}
