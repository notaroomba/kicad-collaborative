// kicad-canvas / pcb-netlist — "Update PCB from Schematic" without the desktop: the netlist of a schematic
// hierarchy (eeschema/connection_graph.cpp's naming rules) and the board changes that bring a board in line
// with it (pcbnew/netlist_reader/board_netlist_updater.cpp's rules and report wording).
//
// Pure functions over parsed documents; the dialog (web/editor/pcbdialogs/update-pcb.ts) loads the sheets,
// shows the report and commits the staged nodes.  Exposed for the node tests as KiCadCanvas.pcbNetlist.
import { atOf, kid, kids, num, parse, ptsOf, str } from "./sexpr";
import { resolveLib } from "./geom-sch";
import { footprintVariant, footprintVariantNode, setFootprintVariant, symbolFlags, symbolFlagsForVariant, symbolInstance, symbolVariant, type FpFlags } from "./variant-model";

type Pt = [number, number];

// ---------------------------------------------------------------- inputs
/** A pin of a placed symbol as sch-tools.js's symbolPins gives it. */
export interface SymPin { x: number; y: number; number: string; name: string; type: string; hidden: boolean }
export interface NetlistHelpers {
  /** the pins of a placed symbol (its unit and body style), in sheet coordinates */
  symbolPins(doc: KDoc, item: KItem): SymPin[];
  /** true for power symbols (#PWR, #FLG) */
  isPower(doc: KDoc, item: KItem): boolean;
  /** true for a (power local) symbol: its net is limited to the sheet, like a local label (KiCad 10) */
  isLocalPower?(doc: KDoc, item: KItem): boolean;
}
/** One schematic file: its parsed document, the file's own (uuid …) and its path in the project. */
export interface SheetFile { doc: KDoc; uuid: string; file: string }

// ---------------------------------------------------------------- outputs
export interface NetPin { net: string; name: string; type: string }
export interface NetComponent {
  ref: string; value: string; footprint: string; libId: string;
  /** every unit's symbol path ("/<sheet uuid>…/<symbol uuid>"), the first unit's first */
  paths: string[];
  /** every field of the symbol except Reference / Value / Footprint */
  fields: Record<string, string>;
  sheetName: string; sheetFile: string;
  dnp: boolean; excludeFromBom: boolean; excludeFromBoard: boolean;
  /** pad number -> net / pin name / electrical type */
  pins: Map<string, NetPin>;
  /** COMPONENT::GetVariants: the symbol instance's design variants that differ from the symbol (as the KiCad
   *  netlist's (variants …) carries them), in the CASE_INSENSITIVE_MAP's order */
  variants?: NetVariant[];
  /** COMPONENT::GetGroup: the schematic group the symbol belongs to (its uuid and name) */
  group?: { uuid: string; name: string };
}
/** COMPONENT_VARIANT: a flag only when the variant changes it, the fields whose text the variant changes. */
export interface NetVariant { name: string; dnp?: boolean; excludedFromBOM?: boolean; excludedFromSim?: boolean; excludedFromPosFiles?: boolean; fields: Map<string, string> }
export interface Netlist {
  components: NetComponent[]; nets: Map<string, { ref: string; pin: string }[]>; warnings: string[];
  /** every named net (and bus) of the hierarchy with the items on it, sheet instance by sheet instance (CONNECTION_GRAPH's net map) */
  netMap?: Map<string, NetEntry>;
  /** the sheet instances the hierarchy walk found, root first ("/" then "/Sub/") */
  instances?: SheetInstance[];
}
/** An item of a net on one sheet instance: a wire, label, junction, no-connect, bus entry, a symbol pin or a sheet pin. */
export interface NetMember {
  inst: number; id: string; kind: string;
  /** symbol pin number / sheet pin name (kind "pin" / "sheet_pin") */
  pin?: string; pinName?: string; ref?: string; power?: boolean; text?: string;
}
export interface NetEntry { name: string; bus: boolean; members: NetMember[]; busMembers: string[] }
export interface SheetInstance { index: number; human: string; file: string; uuidPath: string[]; sheetName: string }

// ---------------------------------------------------------------- small s-expression helpers
const isList = Array.isArray;
const r4 = (v: number): number => +(+v).toFixed(4);
const pkey = (p: Pt): string => r4(p[0]) + "," + r4(p[1]);
function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/**
 * (key v…) as the file writer spells it: strings quoted, numbers bare.  Built through the reader so the
 * node carries its quoting marks — serialize() would otherwise write an identifier-shaped string bare, and
 * KiCad's parser wants a string where the format says string (a net called `front` is a keyword otherwise).
 */
export function qnode(key: string, values: (string | number)[]): SNode {
  return parse("(" + key + values.map((v) => " " + (typeof v === "number" ? String(v) : quote(v))).join("") + ")") as SNode;
}
/** Set (key …values), replacing an existing child or inserting before the first of `before`; `bare` keeps keywords unquoted. */
function setKid(node: SNode, key: string, values: (string | number)[], before: string[], bare = false): SNode {
  const c: SNode = bare ? [key, ...values] : qnode(key, values);
  const i = idxOf(node, key);
  if (i > 0) { node[i] = c; return c; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, c); return c;
}
function delKid(node: SNode, key: string): boolean { const i = idxOf(node, key); if (i > 0) { node.splice(i, 1); return true; } return false; }
const kidStr = (node: SNode, key: string): string => { const k = kid(node, key) as SNode | null; return k ? str(k[1]) : ""; };
const yes = (node: SNode, key: string, def: boolean): boolean => { const k = kid(node, key) as SNode | null; return k ? str(k[1]) !== "no" : def; };
function prop(node: SNode, name: string): SNode | null { for (const p of kids(node, "property") as SNode[]) if (str(p[1]) === name) return p; return null; }
const propVal = (node: SNode, name: string): string => { const p = prop(node, name); return p ? str(p[2]) : ""; };

/** EscapeString( …, CTX_NETNAME ): '/' is spelled {slash}, line breaks are dropped. */
export function escapeNetName(s: string): string { return s.replace(/\//g, "{slash}").replace(/[\r\n]/g, ""); }
/** UnescapeString for the report (the names a person reads). */
export function unescapeNetName(s: string): string { return s.replace(/\{slash\}/g, "/").replace(/\{backslash\}/g, "\\").replace(/\{lt\}/g, "<").replace(/\{gt\}/g, ">").replace(/\{colon\}/g, ":").replace(/\{dquote\}/g, '"').replace(/\{space\}/g, " "); }

/** Members of a bus vector label "D[0..7]" -> ["D0", … "D7"]; null when the text is no bus. */
export function busVector(text: string): string[] | null {
  const m = /^(.*?)\[(\d+)\.\.(\d+)\](.*)$/.exec(text);
  if (!m) return null;
  const a = Number(m[2]), b = Number(m[3]), out: string[] = [];
  const step = a <= b ? 1 : -1;
  for (let i = a; step > 0 ? i <= b : i >= b; i += step) { out.push(m[1] + i + m[4]); if (out.length > 4096) break; }
  return out;
}
const isBusText = (t: string): boolean => /\[\d+\.\.\d+\]/.test(t) || /\{[^}]*\s[^}]*\}/.test(t);

// ---------------------------------------------------------------- the schematic's nets
// CONNECTION_SUBGRAPH::PRIORITY
/** LIB_SYMBOL::IsLocalPower: the library copy the symbol draws from carries (power local). */
function libIsLocalPower(doc: KDoc, n: SNode): boolean { const l = resolveLib(doc, str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1])); const p = l && kid(l, "power"); return !!p && str(p[1]) === "local"; }
const P_PIN = 1, P_SHEET_PIN = 2, P_HIER = 3, P_LOCAL = 4, P_LOCAL_POWER = 4.5, P_BUS_MEMBER = 5, P_POWER = 6, P_GLOBAL = 7;
interface Driver { prio: number; name: string; depth: number }
interface PinRef { comp: string | null; ref: string; unitRef: string; pin: SymPin; pins: SymPin[]; uuid: string; power: boolean; inNetlist: boolean }
interface Instance { sheet: SheetFile; uuidPath: string[]; human: string; depth: number; index: number; sheetUuids: string[]; name: string }

class UnionFind {
  parent: number[] = [];
  add(): number { this.parent.push(this.parent.length); return this.parent.length - 1; }
  find(i: number): number { const p = this.parent; while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }
  union(a: number, b: number): void { a = this.find(a); b = this.find(b); if (a !== b) this.parent[b] = a; }
}

function distSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** A symbol's reference and unit on one sheet instance: its (instances …) entry for that path, else the field. */
function instanceRef(node: SNode, path: string, project: string | undefined): { ref: string; unit: number } {
  const unitN = kid(node, "unit") as SNode | null;
  let ref = propVal(node, "Reference"), unit = unitN ? num(unitN[1], 1) : 1, found = false;
  const inst = kid(node, "instances") as SNode | null;
  if (inst) {
    const projects = kids(inst, "project") as SNode[];
    projects.sort((a, b) => Number(str(b[1]) === project) - Number(str(a[1]) === project));
    for (const pr of projects) {
      for (const p of kids(pr, "path") as SNode[]) {
        if (str(p[1]) !== path) continue;
        const r = kid(p, "reference") as SNode | null, u = kid(p, "unit") as SNode | null;
        if (r) ref = str(r[1]); if (u) unit = num(u[1], unit);
        found = true; break;
      }
      if (found) break;
    }
  }
  return { ref, unit };
}

/** How many units the library symbol of a placed symbol has. */
function unitCount(doc: KDoc, node: SNode): number {
  const id = kidStr(node, "lib_name") || kidStr(node, "lib_id");
  const lib = doc.lib.get(id) || doc.lib.get(kidStr(node, "lib_id"));
  if (!lib) return 1;
  let n = 1;
  for (const sub of kids(lib, "symbol") as SNode[]) { const m = /_(\d+)_(\d+)$/.exec(str(sub[1])); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}
/** SCH_SYMBOL::SubReference: A, B, … Z, AA, … */
function unitLetter(unit: number): string { let s = "", u = unit; while (u > 0) { u--; s = String.fromCharCode(65 + (u % 26)) + s; u = Math.floor(u / 26); } return s; }

/** SCH_PIN::GetDefaultNetName. */
function defaultPinNet(p: PinRef, forceNoConnect: boolean): string {
  const nc = forceNoConnect || p.pin.type === "no_connect";
  let name = nc ? "unconnected-(" : "Net-(";
  const shownName = p.pin.name === "~" ? "" : p.pin.name, number = p.pin.number;
  const multiple = p.pins.some((q) => (q.name === "~" ? "" : q.name) === shownName && q.number !== number && nc === (q.type === "no_connect"));
  if (p.ref.endsWith("?")) return name + p.uuid + "-Pad" + number + ")";
  if (shownName && shownName !== number) {
    name += p.unitRef + "-" + escapeNetName(shownName);
    if (nc || multiple) name += "-Pad" + escapeNetName(number);
    return name + ")";
  }
  return name + p.ref + "-Pad" + escapeNetName(number) + ")";
}

/**
 * The netlist of a schematic hierarchy.  `loadSheet( file, parent )` resolves a sheet symbol's Sheetfile
 * (null when the project has no such document).
 */
const lowerCmp = (a: string, b: string): number => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
/** NETLIST_EXPORTER_KICAD's per-component (variants …) as KICAD_NETLIST_PARSER reads them back: for each variant
 *  of the symbol's instance, the flags whose value differs from the symbol's and the fields whose text differs. */
export function componentVariants(sym: SNode, path: string, ref: string, ver?: number | null): NetVariant[] {
  const inst = symbolInstance(sym, path); if (!inst || str(inst[1]) !== path) return [];
  const base = symbolFlags(sym), out: NetVariant[] = [];
  const fieldText = (k: string): string => { if (k === "Reference") return ref; const p = (kids(sym, "property") as SNode[]).find((q) => str(q[1]) === k); return p ? str(p[2]) : ""; };
  for (const v of kids(inst, "variant") as SNode[]) {
    const name = str(((kid(v, "name") as SNode | null) || [])[1]); if (!name || out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
    const eff = symbolFlagsForVariant(sym, name, path, ver), st = symbolVariant(sym, name, path, ver);
    const nv: NetVariant = { name, fields: new Map() };
    if (eff.dnp !== base.dnp) nv.dnp = eff.dnp;
    if (eff.excludedFromBOM !== base.excludedFromBOM) nv.excludedFromBOM = eff.excludedFromBOM;
    if (eff.excludedFromSim !== base.excludedFromSim) nv.excludedFromSim = eff.excludedFromSim;
    if (eff.excludedFromPosFiles !== base.excludedFromPosFiles) nv.excludedFromPosFiles = eff.excludedFromPosFiles;
    if (st) for (const [k, val] of st.fields) if (val !== fieldText(k)) nv.fields.set(k, val);
    if (nv.dnp !== undefined || nv.excludedFromBOM !== undefined || nv.excludedFromSim !== undefined || nv.excludedFromPosFiles !== undefined || nv.fields.size) out.push(nv);
  }
  return out.sort((a, b) => lowerCmp(a.name, b.name));
}

export function buildNetlist(root: SheetFile, loadSheet: (file: string, parent: SheetFile) => SheetFile | null, h: NetlistHelpers, project?: string): Netlist {
  const warnings: string[] = [];
  const uf = new UnionFind();
  const keyNodes = new Map<string, number>();
  const keyNode = (k: string): number => { let n = keyNodes.get(k); if (n === undefined) { n = uf.add(); keyNodes.set(k, n); } return n; };
  const drivers = new Map<number, Driver[]>();          // node -> drivers attached to it
  const pinsAt = new Map<number, PinRef[]>();
  const sheetPinNodes = new Set<number>(), ncNodes = new Set<number>();
  const busLabels = new Map<number, { text: string; prio: number; inst: Instance }[]>();
  const addDriver = (n: number, d: Driver): void => { const l = drivers.get(n); if (l) l.push(d); else drivers.set(n, [d]); };
  const components = new Map<string, NetComponent>();
  const compPins = new Map<string, PinRef[]>();

  // ---- the sheet instances, breadth first
  const instances: Instance[] = [{ sheet: root, uuidPath: [root.uuid], human: "/", depth: 0, index: 0, sheetUuids: [], name: "" }];
  const mem = new Map<number, NetMember[]>();           // node -> the items attached to it (the net map's members)
  const addMem = (n: number, m: NetMember): void => { const l = mem.get(n); if (l) l.push(m); else mem.set(n, [m]); };
  const childOf = new Map<string, number>();            // "<instance index>|<sheet item id>" -> child instance index
  for (let q = 0; q < instances.length && instances.length < 2000; q++) {
    const inst = instances[q];
    for (const it of inst.sheet.doc.items.values()) {
      if (it.kind !== "sheet") continue;
      const file = propVal(it.node, "Sheetfile") || propVal(it.node, "Sheet file"), name = propVal(it.node, "Sheetname") || propVal(it.node, "Sheet name");
      if (inst.depth > 24) { warnings.push(`Sheet ${name} is nested too deeply.`); continue; }
      const sub = file ? loadSheet(file, inst.sheet) : null;
      if (!sub) { warnings.push(`Sheet file '${file}' of sheet '${name}' is not in the project.`); continue; }
      childOf.set(inst.index + "|" + it.id, instances.length);
      instances.push({ sheet: sub, uuidPath: [...inst.uuidPath, it.id], human: inst.human + name + "/", depth: inst.depth + 1, index: instances.length, sheetUuids: [...inst.sheetUuids, it.id], name });
    }
  }

  // ---- connectivity of each instance
  for (const inst of instances) {
    const doc = inst.sheet.doc, I = inst.index;
    // the sheet's groups by member (SCH_ITEM::GetParentGroup)
    const symGroup = new Map<string, { uuid: string; name: string }>();
    for (const it of doc.items.values()) if (it.kind === "group") { const m = kid(it.node, "members") as SNode | null; const g = { uuid: kidStr(it.node, "uuid") || it.id, name: typeof it.node[1] === "string" ? str(it.node[1]) : "" }; if (m) for (const id of m.slice(1)) symGroup.set(str(id), g); }
    interface Line { a: Pt; b: Pt; node: number; bus: boolean }
    const lines: Line[] = [];
    const ends = new Map<string, number[]>();           // point -> line indices ending there
    for (const it of doc.items.values()) {
      if (it.kind !== "wire" && it.kind !== "bus") continue;
      const pts = ptsOf(it.node) as Pt[]; if (pts.length < 2) continue;
      const node = uf.add();
      addMem(node, { inst: I, id: it.id, kind: it.kind });
      for (let k = 1; k < pts.length; k++) {
        const li = lines.length; lines.push({ a: pts[k - 1], b: pts[k], node, bus: it.kind === "bus" });
        for (const p of [pts[k - 1], pts[k]]) { const key = pkey(p); const l = ends.get(key); if (l) l.push(li); else ends.set(key, [li]); }
      }
    }
    /** nodes of the lines of one kind that pass through p (ends and middles) */
    const linesAt = (p: Pt, bus: boolean): number[] => {
      const out: number[] = [];
      for (const li of ends.get(pkey(p)) || []) if (lines[li].bus === bus) out.push(lines[li].node);
      for (const l of lines) if (l.bus === bus && distSeg(p, l.a, l.b) <= 1e-3) out.push(l.node);
      return out;
    };
    // line ends meet line ends, and a line end resting on the middle of another line joins it
    for (const l of lines) for (const p of [l.a, l.b]) for (const n of linesAt(p, l.bus)) uf.union(l.node, n);
    const junctions: { id: string; p: Pt }[] = [];
    for (const it of doc.items.values()) {
      if (it.kind !== "junction") continue;
      const p = (atOf(it.node) as number[]).slice(0, 2) as Pt;
      for (const bus of [false, true]) { const ns = linesAt(p, bus); for (let k = 1; k < ns.length; k++) uf.union(ns[0], ns[k]); }
      junctions.push({ id: it.id, p });
    }
    // point terminals: a node each, joined to the line under them and to one another
    const points = new Map<string, number[]>();
    const terminal = (p: Pt, bus: boolean): number => {
      const n = uf.add();
      for (const ln of linesAt(p, bus)) uf.union(n, ln);
      const key = (bus ? "b" : "w") + pkey(p); const l = points.get(key);
      if (l) { uf.union(l[0], n); l.push(n); } else points.set(key, [n]);
      return n;
    };
    for (const it of doc.items.values()) {
      const n = it.node, k = it.kind;
      if (k === "label" || k === "global_label" || k === "hierarchical_label") {
        const text = str(n[1]), p = (atOf(n) as number[]).slice(0, 2) as Pt, bus = isBusText(text);
        const t = terminal(p, bus);
        addMem(t, { inst: I, id: it.id, kind: k, text });
        if (bus) {
          const l = busLabels.get(t) || []; busLabels.set(t, l);
          l.push({ text, prio: k === "label" ? P_LOCAL : k === "global_label" ? P_GLOBAL : P_HIER, inst });
          uf.union(t, keyNode(k === "global_label" ? "gbus:" + text : k === "label" ? `${I}|lbus:${text}` : `${I}|hbus:${text}`));
        } else if (k === "label") { uf.union(t, keyNode(`${I}|local:${text}`)); addDriver(t, { prio: P_LOCAL, name: inst.human + escapeNetName(text), depth: inst.depth }); }
        else if (k === "global_label") { uf.union(t, keyNode("global:" + text)); addDriver(t, { prio: P_GLOBAL, name: escapeNetName(text), depth: inst.depth }); }
        // a hierarchical label also names the net on its own sheet: it joins the local labels of that name
        else { uf.union(t, keyNode(`${I}|hier:${text}`)); uf.union(t, keyNode(`${I}|local:${text}`)); addDriver(t, { prio: P_HIER, name: inst.human + escapeNetName(text), depth: inst.depth }); }
      } else if (k === "netclass_flag" || k === "directive_label") {
        // a directive label sits on a net without naming it
        addMem(terminal((atOf(n) as number[]).slice(0, 2) as Pt, false), { inst: I, id: it.id, kind: k, text: str(n[1]) });
      } else if (k === "sheet") {
        const child = childOf.get(I + "|" + it.id);
        for (const pin of kids(n, "pin") as SNode[]) {
          const text = str(pin[1]), p = (atOf(pin) as number[]).slice(0, 2) as Pt, bus = isBusText(text);
          const t = terminal(p, bus);
          addMem(t, { inst: I, id: it.id, kind: "sheet_pin", pin: text, text: propVal(n, "Sheetname") || propVal(n, "Sheet name") });
          if (bus) {
            const l = busLabels.get(t) || []; busLabels.set(t, l); l.push({ text, prio: P_SHEET_PIN, inst });
            if (child !== undefined) uf.union(t, keyNode(`${child}|hbus:${text}`));
          } else {
            sheetPinNodes.add(t); addDriver(t, { prio: P_SHEET_PIN, name: inst.human + escapeNetName(text), depth: inst.depth });
            if (child !== undefined) uf.union(t, keyNode(`${child}|hier:${text}`));
          }
        }
      } else if (k === "symbol") {
        const power = h.isPower(doc, it), value = propVal(n, "Value"), localPower = power && (h.isLocalPower ? h.isLocalPower(doc, it) : libIsLocalPower(doc, n));
        const { ref, unit } = instanceRef(n, "/" + inst.uuidPath.join("/"), project);
        const inNetlist = !ref.startsWith("#") && !power, onBoard = yes(n, "on_board", true);
        const pins = h.symbolPins(doc, it);
        const units = unitCount(doc, n), unitRef = units > 1 ? ref + unitLetter(unit) : ref;
        let comp: NetComponent | undefined;
        if (inNetlist && onBoard) {
          const path = "/" + [...inst.sheetUuids, it.id].join("/");
          comp = components.get(ref);
          if (!comp) {
            const fields: Record<string, string> = {};
            for (const p of kids(n, "property") as SNode[]) { const name = str(p[1]); if (name !== "Reference" && name !== "Value" && name !== "Footprint") fields[name] = str(p[2]); }
            comp = { ref, value, footprint: propVal(n, "Footprint"), libId: kidStr(n, "lib_id"), paths: [path], fields, sheetName: inst.human, sheetFile: inst.sheet.file.split("/").pop() || inst.sheet.file,
              dnp: yes(n, "dnp", false), excludeFromBom: !yes(n, "in_bom", true), excludeFromBoard: false, pins: new Map() };
            const variants = componentVariants(n, "/" + inst.uuidPath.join("/"), ref, (doc as KDoc).version); if (variants.length) comp.variants = variants;
            const grp = symGroup.get(it.id); if (grp) comp.group = grp;
            components.set(ref, comp); compPins.set(ref, []);
          } else { if (unit === 1) comp.paths.unshift(path); else comp.paths.push(path); if (!comp.footprint) comp.footprint = propVal(n, "Footprint"); }
        }
        for (const pin of pins) {
          const t = terminal([pin.x, pin.y], false);
          addMem(t, { inst: I, id: it.id, kind: "pin", pin: pin.number, pinName: pin.name, ref: unitRef, power });
          // CONNECTION_GRAPH: a local power pin joins the sheet's local label cache (sheet, name), not the global one
          if (localPower && value && pin.type === "power_in") { uf.union(t, keyNode(`${I}|local:${value}`)); addDriver(t, { prio: P_LOCAL_POWER, name: inst.human + escapeNetName(value), depth: inst.depth }); continue; }
          if (power && value && pin.type === "power_in") { uf.union(t, keyNode("global:" + value)); addDriver(t, { prio: P_POWER, name: escapeNetName(value), depth: inst.depth }); continue; }
          if (power) continue;                                   // a PWR_FLAG's pin drives nothing by name
          if (pin.hidden && pin.type === "power_in") { uf.union(t, keyNode("global:" + pin.name)); addDriver(t, { prio: P_POWER, name: escapeNetName(pin.name), depth: inst.depth }); }
          if (pin.type === "no_connect") ncNodes.add(t);
          const pr: PinRef = { comp: comp ? ref : null, ref, unitRef, pin, pins, uuid: it.id, power, inNetlist };
          const l = pinsAt.get(t); if (l) l.push(pr); else pinsAt.set(t, [pr]);
          if (comp) (compPins.get(ref) as PinRef[]).push(pr);
        }
      }
    }
    for (const it of doc.items.values()) {
      if (it.kind !== "no_connect") continue;
      const p = (atOf(it.node) as number[]).slice(0, 2) as Pt;
      const l = points.get("w" + pkey(p)); if (l) ncNodes.add(l[0]); else for (const ln of linesAt(p, false)) ncNodes.add(ln);
      const on = l ? l[0] : linesAt(p, false)[0]; addMem(on !== undefined ? on : terminal(p, false), { inst: I, id: it.id, kind: "no_connect" });
    }
    // a junction belongs to the net of the lines it joins (wires first); a bus-wire entry to the wire at its free end
    for (const j of junctions) { const w = linesAt(j.p, false), b = linesAt(j.p, true); addMem(w.length ? w[0] : b.length ? b[0] : terminal(j.p, false), { inst: I, id: j.id, kind: "junction" }); }
    for (const it of doc.items.values()) {
      if (it.kind !== "bus_entry") continue;
      const [x, y] = atOf(it.node) as number[], sz = kid(it.node, "size") as SNode | null;
      const p1: Pt = [x, y], p2: Pt = [x + (sz ? num(sz[1]) : 0), y + (sz ? num(sz[2]) : 0)];
      const wireEnd = linesAt(p1, true).length ? p2 : linesAt(p2, true).length ? p1 : p2;
      addMem(terminal(wireEnd, false), { inst: I, id: it.id, kind: "bus_entry" });
    }
  }

  // ---- buses: each bus group names its members after its best label and hands the names to the member wires
  const busGroups = new Map<number, { text: string; prio: number; inst: Instance }[]>();
  for (const [n, l] of busLabels) { const r = uf.find(n); const g = busGroups.get(r); if (g) g.push(...l); else busGroups.set(r, l.slice()); }
  const better = (a: { prio: number; depth: number; name: string }, b: { prio: number; depth: number; name: string }): number => {
    const sa = a.prio >= P_HIER, sb = b.prio >= P_HIER;
    if (sa !== sb) return sa ? -1 : 1;
    if (a.prio !== b.prio) return b.prio - a.prio;
    if (sa && a.depth !== b.depth) return a.depth - b.depth;
    const la = a.name.includes("-Pad"), lb = b.name.includes("-Pad");
    if (la !== lb) return la ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  let groupN = 0;
  const busInfo: { rep: number; name: string; members: number[] }[] = [];
  for (const [rep, labels] of busGroups) {
    const best = labels.slice().sort((a, b) => better({ prio: a.prio, depth: a.inst.depth, name: a.text }, { prio: b.prio, depth: b.inst.depth, name: b.text }))[0];
    const busPrefix = best.prio === P_GLOBAL ? "" : best.inst.human;
    const info = { rep, name: busPrefix + escapeNetName(best.text), members: [] as number[] }; busInfo.push(info);
    const members = busVector(best.text); if (!members) continue;
    const prefix = busPrefix;
    const g = groupN++;
    for (let k = 0; k < members.length; k++) info.members.push(keyNode(`busmember:${g}:${k}`));
    for (const l of labels) {
      const local = busVector(l.text); if (!local) continue;
      for (let k = 0; k < local.length && k < members.length; k++) {
        const m = keyNode(`busmember:${g}:${k}`);
        if (!drivers.has(m)) addDriver(m, { prio: P_BUS_MEMBER, name: prefix + escapeNetName(members[k]), depth: best.inst.depth });
        uf.union(m, keyNode(`${l.inst.index}|local:${local[k]}`));
      }
    }
  }

  // ---- names
  interface Group { drivers: Driver[]; pins: PinRef[]; nc: boolean; sheetPin: boolean }
  const groups = new Map<number, Group>();
  const groupOf = (n: number): Group => { const r = uf.find(n); let g = groups.get(r); if (!g) { g = { drivers: [], pins: [], nc: false, sheetPin: false }; groups.set(r, g); } return g; };
  for (const [n, l] of drivers) groupOf(n).drivers.push(...l);
  for (const [n, l] of pinsAt) groupOf(n).pins.push(...l);
  for (const n of ncNodes) groupOf(n).nc = true;
  for (const n of sheetPinNodes) groupOf(n).sheetPin = true;
  const nets = new Map<string, { ref: string; pin: string }[]>();
  const nameOf = (g: Group): string => {
    const strong = g.drivers.filter((d) => d.prio >= P_HIER);
    if (strong.length) return strong.sort(better)[0].name;
    if (g.drivers.length) return g.drivers.sort(better)[0].name;        // a sheet pin with nothing behind it
    const cands = g.pins.filter((p) => p.inNetlist);
    const force = g.nc || cands.length === 1;
    return cands.map((p) => defaultPinNet(p, force)).sort((a, b) => better({ prio: P_PIN, depth: 0, name: a }, { prio: P_PIN, depth: 0, name: b }))[0] || "";
  };
  for (const g of groups.values()) {
    const netPins = g.pins.filter((p) => p.comp);
    if (!netPins.length) continue;
    const name = nameOf(g);
    for (const p of netPins) {
      const comp = components.get(p.comp as string) as NetComponent;
      if (!p.pin.number) continue;
      // netlist_exporter_xml.cpp: pinfunction is "<name>_<number>", the type gains "+no_connect" on a flagged lone pin
      const shown = p.pin.name === "~" ? "" : p.pin.name;
      const type = p.pin.type + (g.nc && netPins.length === 1 ? "+no_connect" : "");
      if (!comp.pins.has(p.pin.number)) comp.pins.set(p.pin.number, { net: name, name: shown ? shown + "_" + p.pin.number : "", type });
      const l = nets.get(name); if (l) l.push({ ref: comp.ref, pin: p.pin.number }); else nets.set(name, [{ ref: comp.ref, pin: p.pin.number }]);
    }
  }
  // ---- the net map: every named net and bus with its items (a net with no name, a lone wire, is left out as KiCad does)
  const netMap = new Map<string, NetEntry>();
  const busRoots = new Map<number, { name: string; members: number[] }>();
  for (const b of busInfo) busRoots.set(uf.find(b.rep), b);
  const memberRoots = new Map<number, NetMember[]>();
  for (const [n, l] of mem) { const r = uf.find(n); const x = memberRoots.get(r); if (x) x.push(...l); else memberRoots.set(r, l.slice()); }
  const groupName = (r: number): string => { const g = groups.get(r); return g ? nameOf(g) : ""; };
  for (const [r, members] of memberRoots) {
    const bus = busRoots.get(r);
    const name = bus ? bus.name : groupName(r); if (!name) continue;
    let e = netMap.get(name);
    if (!e) { e = { name, bus: !!bus, members: [], busMembers: [] }; netMap.set(name, e); }
    e.members.push(...members);
    if (bus) for (const m of bus.members) { const mn = groupName(uf.find(m)); if (mn && !e.busMembers.includes(mn)) e.busMembers.push(mn); }
  }
  const instOut: SheetInstance[] = instances.map((i) => ({ index: i.index, human: i.human, file: i.sheet.file, uuidPath: i.uuidPath, sheetName: i.name }));
  return { components: Array.from(components.values()), nets, warnings, netMap, instances: instOut };
}

// ---------------------------------------------------------------- the board update
export interface UpdateOptions {
  /** "Re-link footprints to schematic symbols based on their reference designators" */
  relinkByRef?: boolean;
  /** "Replace footprints with those specified by symbols" */
  replaceFootprints?: boolean;
  /** "Delete footprints with no symbols" */
  deleteUnused?: boolean;
  /** "Override locks" */
  overrideLocks?: boolean;
  /** "Update footprint fields from symbols" */
  updateFields?: boolean;
  /** "Remove footprint fields not found in symbols" */
  removeExtraFields?: boolean;
  /** "Group footprints based on symbol group" (BOARD_NETLIST_UPDATER::SetTransferGroups) */
  transferGroups?: boolean;
  /** "Apply design block layouts to new groups": the board has no design block links here, so it changes nothing yet */
  applyDesignBlockLayouts?: boolean;
  /** the board footprint for a library id, or null when the library is not available (or has no such footprint) */
  footprintFor?(fpid: string): SNode | null | "missing";
  /** text size / thickness of new fields (the board's Fab-layer defaults) */
  fieldSize?: number; fieldThickness?: number;
  newUuid?(): string;
}
export type Severity = "action" | "warning" | "error" | "info";
export interface ReportLine { severity: Severity; text: string }
export interface UpdatePlan {
  report: ReportLine[];
  /** footprints, tracks, vias and zones to replace: item id -> new node */
  modified: Map<string, SNode>;
  removed: string[];
  /** new footprint nodes, positioned below the board */
  added: SNode[];
  warnings: number; errors: number;
}

const MANDATORY = new Set(["Reference", "Value", "Datasheet", "Description"]);
const PAD_AFTER_NET = ["pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "custom", "primitives", "tenting", "teardrops", "padstack", "uuid", "tstamp"];
const clone = (n: SNode): SNode => (typeof KiCadCanvas !== "undefined" && KiCadCanvas.cloneNode ? (KiCadCanvas.cloneNode as (x: SNode) => SNode)(n) : JSON.parse(JSON.stringify(n)) as SNode);

/** (net "name") or the legacy (net code "name") of a pad / track. */
function netNameOf(doc: KDoc, node: SNode): string {
  const n = kid(node, "net") as SNode | null; if (!n) return "";
  if (typeof n[1] === "number") return n.length > 2 ? str(n[2]) : (doc.nets.get(n[1]) || "");
  return str(n[1]);
}
function usesNetCodes(doc: KDoc): boolean {
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? (kid(it.node, "pad") as SNode | null) : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && (kid(probe, "net") as SNode | null); if (!n) continue;
    return typeof n[1] === "number";
  }
  return false;
}
function fpRef(node: SNode): string {
  const p = prop(node, "Reference"); if (p) return str(p[2]);
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === "reference") return str(t[2]);
  return "";
}
function fpValue(node: SNode): string {
  const p = prop(node, "Value"); if (p) return str(p[2]);
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === "value") return str(t[2]);
  return "";
}
function setFpText(node: SNode, name: "Reference" | "Value", text: string): void {
  const p = prop(node, name); if (p) { p[2] = text; return; }
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === name.toLowerCase()) t[2] = text;
}
const codeCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** BOARD_NETLIST_UPDATER::fpidsEquivalent: a schematic id with no library nickname compares the item names. */
function fpidsEquivalent(board: string, sch: string): boolean {
  const i = sch.indexOf(":");
  if (i < 0 || i === 0) return board.slice(board.indexOf(":") + 1) === sch.slice(i + 1);
  return board === sch;
}
function attrFlags(node: SNode): Set<string> { const a = kid(node, "attr") as SNode | null; return new Set(a ? a.slice(1).map(str) : []); }
const ATTR_ORDER = ["smd", "through_hole", "board_only", "exclude_from_pos_files", "exclude_from_bom", "allow_missing_courtyard", "allow_soldermask_bridges", "dnp"];
function setAttrFlag(node: SNode, flag: string, on: boolean): void {
  const flags = attrFlags(node); if (on) flags.add(flag); else flags.delete(flag);
  const list = [...ATTR_ORDER.filter((f) => flags.has(f)), ...Array.from(flags).filter((f) => !ATTR_ORDER.includes(f))];
  if (!list.length) { delKid(node, "attr"); return; }
  setKid(node, "attr", list, ["duplicate_pad_numbers_are_jumpers", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "dimension", "pad", "zone", "group", "embedded_fonts", "model"], true);
}
const isLocked = (node: SNode): boolean => node.includes("locked") || yes(node, "locked", false);
const fpSide = (node: SNode): string => kidStr(node, "layer") || "F.Cu";
const fpRot = (node: SNode): number => { const a = atOf(node) as number[]; return a[2] || 0; };

/** A hidden field for a footprint, the way BOARD_NETLIST_UPDATER creates one (on the Fab layer, board text defaults). */
function newField(fp: SNode, name: string, value: string, o: UpdateOptions): SNode {
  const size = o.fieldSize || 1, thick = o.fieldThickness || 0.15, rot = fpRot(fp), back = fpSide(fp) === "B.Cu";
  const uuid = o.newUuid ? o.newUuid() : "";
  return parse(`(property ${quote(name)} ${quote(value)} (at 0 0${rot ? " " + rot : ""}) (layer "${back ? "B.Fab" : "F.Fab"}") (hide yes)${uuid ? ` (uuid "${uuid}")` : ""} (effects (font (size ${size} ${size}) (thickness ${thick}))${back ? " (justify mirror)" : ""}))`) as SNode;
}
function insertField(fp: SNode, field: SNode): void {
  let at = -1;
  for (let j = 1; j < fp.length; j++) { const c = fp[j]; if (isList(c) && c[0] === "property" && !str(c[1]).startsWith("ki_")) at = j; }
  if (at < 0) at = Math.max(idxOf(fp, "tags"), idxOf(fp, "descr"), idxOf(fp, "at"), 1);
  fp.splice(at + 1, 0, field);
}

/**
 * What "Update PCB" would do to `doc` for `netlist`: the report (in the dry-run wording of the desktop's
 * dialog) and the staged nodes.  Nothing is modified; the caller commits `modified` / `removed` / `added`.
 */
export function planUpdate(doc: KDoc, netlist: Netlist, o: UpdateOptions = {}): UpdatePlan {
  const report: ReportLine[] = [];
  let warnings = 0, errors = 0;
  const say = (severity: Severity, text: string): void => { report.push({ severity, text }); if (severity === "warning") warnings++; if (severity === "error") errors++; };
  const modified = new Map<string, SNode>(), removed: string[] = [], added: SNode[] = [];
  const byCode = usesNetCodes(doc);
  const codeOf = new Map<string, number>(); let maxCode = 0;
  for (const [code, name] of doc.nets) { codeOf.set(name, code); maxCode = Math.max(maxCode, code); }
  const boardNets = new Set<string>();
  const fps: KItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { fps.push(it); for (const p of kids(it.node, "pad") as SNode[]) { const n = netNameOf(doc, p); if (n) boardNets.add(n); } }
    else if (it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") { const n = netNameOf(doc, it.node); if (n) boardNets.add(n); }
  }
  const addedNets = new Set<string>();
  const oldToNew = new Map<string, string>();
  const netValues = (name: string): (string | number)[] => {
    if (!byCode) return [name];
    let code = codeOf.get(name); if (code === undefined) { code = ++maxCode; codeOf.set(name, code); }
    return [code, name];
  };

  // ---- match footprints to components
  const byPath = new Map<string, KItem>(), byRef = new Map<string, KItem[]>();
  for (const fp of fps) {
    const path = kidStr(fp.node, "path"); if (path && !byPath.has(path)) byPath.set(path, fp);
    const ref = fpRef(fp.node); const l = byRef.get(ref); if (l) l.push(fp); else byRef.set(ref, [fp]);
  }
  const claimed = new Map<string, NetComponent>();      // footprint id -> component
  const fpOf = new Map<NetComponent, KItem>();
  const comps = netlist.components.slice().sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  if (!o.relinkByRef) for (const c of comps) for (const p of c.paths) { const fp = byPath.get(p); if (fp && !claimed.has(fp.id)) { claimed.set(fp.id, c); fpOf.set(c, fp); break; } }
  // by reference: everything when re-linking, otherwise only footprints that carry no (known) symbol link
  const allPaths = new Set<string>(); for (const c of comps) for (const p of c.paths) allPaths.add(p);
  for (const c of comps) {
    if (fpOf.has(c)) continue;
    for (const fp of byRef.get(c.ref) || []) {
      if (claimed.has(fp.id)) continue;
      if (!o.relinkByRef && allPaths.has(kidStr(fp.node, "path"))) continue;
      claimed.set(fp.id, c); fpOf.set(c, fp); break;
    }
  }

  const padsOf = (fp: SNode): SNode[] => kids(fp, "pad") as SNode[];
  const applyNets = (ref: string, fp: SNode, c: NetComponent): boolean => {
    let changed = false;
    for (const pad of padsOf(fp)) {
      const number = str(pad[1]), pin = number ? c.pins.get(number) : undefined, cur = netNameOf(doc, pad);
      const layers = kid(pad, "layers") as SNode | null, onCopper = !layers || layers.slice(1).some((l) => /\.Cu$/.test(str(l)));
      if (!pin || !onCopper) {
        if (cur) { say("action", `Disconnect ${ref} pin ${number}.`); delKid(pad, "net"); delKid(pad, "pinfunction"); delKid(pad, "pintype"); changed = true; }
        else if (onCopper && number && str(pad[2]) !== "np_thru_hole") say("warning", `No net found for component ${ref} pad ${number} (no pin ${number} in symbol).`);
        continue;
      }
      if (cur !== pin.net) {
        if (!boardNets.has(pin.net) && !addedNets.has(pin.net)) { addedNets.add(pin.net); say("action", `Add net ${unescapeNetName(pin.net)}.`); }
        if (cur) { oldToNew.set(cur, pin.net); say("action", `Reconnect ${ref} pin ${number} from ${unescapeNetName(cur)} to ${unescapeNetName(pin.net)}.`); }
        else say("action", `Connect ${ref} pin ${number} to ${unescapeNetName(pin.net)}.`);
        setKid(pad, "net", netValues(pin.net), PAD_AFTER_NET); changed = true;
      }
      if (kidStr(pad, "pinfunction") !== pin.name) { if (pin.name) setKid(pad, "pinfunction", [pin.name], PAD_AFTER_NET.slice(1)); else delKid(pad, "pinfunction"); changed = true; }
      if (kidStr(pad, "pintype") !== pin.type) { if (pin.type) setKid(pad, "pintype", [pin.type], PAD_AFTER_NET.slice(2)); else delKid(pad, "pintype"); changed = true; }
    }
    return changed;
  };
  // BOARD_NETLIST_UPDATER::applyComponentVariants for the component's one footprint (dry-run wording, like the rest
  // of the report).  `orig` is the footprint as it was before this update: its FOOTPRINT_VARIANTs hold their own
  // flags.  `isBase` forces the footprint to count as the component's base footprint.
  const applyVariants = (fp: SNode, c: NetComponent, orig: SNode, isBaseOverride: boolean): boolean => {
    if (!c.footprint) return false;
    const ref = c.ref, fpid = str(fp[1]);
    let changed = false;
    const isBase = isBaseOverride || fpidsEquivalent(fpid, c.footprint);
    const baseDnp = attrFlags(fp).has("dnp");
    let effDnp = baseDnp;
    if (!isBase && !effDnp) { say("action", `Add ${ref} 'Do not place' fabrication attribute.`); setAttrFlag(fp, "dnp", true); effDnp = true; changed = true; }
    const excess = new Map<string, string>();      // lower-case name -> the footprint's own spelling
    for (const v of kids(orig, "variant") as SNode[]) { const n = str(((kid(v, "name") as SNode | null) || [])[1]); if (n) excess.set(n.toLowerCase(), n); }
    const writes: { name: string; flags: FpFlags; fields: Map<string, string> }[] = [];
    for (const v of c.variants || []) {
      const vFpid = v.fields.get("Footprint") || c.footprint;
      if (!fpidsEquivalent(fpid, vFpid)) continue;   // not this variant's footprint (one footprint per reference)
      excess.delete(v.name.toLowerCase());
      const cur = footprintVariant(orig, v.name), flagsNow = (): FpFlags => { const f = attrFlags(fp); return { dnp: f.has("dnp"), exclude_from_bom: f.has("exclude_from_bom"), exclude_from_sim: f.has("exclude_from_sim"), exclude_from_pos_files: f.has("exclude_from_pos_files") }; };
      let st: { name: string; flags: FpFlags; fields: Map<string, string> } | null = cur ? { name: cur.name, flags: { ...cur.flags }, fields: new Map(cur.fields) } : null;
      let touched = false;
      const add = (): { name: string; flags: FpFlags; fields: Map<string, string> } => { if (!st) st = { name: v.name, flags: flagsNow(), fields: new Map() }; touched = true; return st; };
      const attr = (key: keyof FpFlags, label: string, target: boolean, current: boolean): void => {
        if (current === target) return;
        say("action", target ? `Add ${ref} '${label}' attribute to variant ${v.name}.` : `Remove ${ref} '${label}' attribute from variant ${v.name}.`);
        add().flags[key] = target; changed = true;
      };
      const now = flagsNow();
      attr("dnp", "Do not place", v.dnp ?? baseDnp, cur ? cur.flags.dnp : effDnp);
      attr("exclude_from_bom", "exclude from BOM", v.excludedFromBOM ?? now.exclude_from_bom, cur ? cur.flags.exclude_from_bom : now.exclude_from_bom);
      attr("exclude_from_sim", "exclude from simulation", v.excludedFromSim ?? now.exclude_from_sim, cur ? cur.flags.exclude_from_sim : now.exclude_from_sim);
      attr("exclude_from_pos_files", "exclude from position files", v.excludedFromPosFiles ?? now.exclude_from_pos_files, cur ? cur.flags.exclude_from_pos_files : now.exclude_from_pos_files);
      if (o.updateFields !== false) {
        const fpFields = new Map<string, string>();
        for (const p of kids(fp, "property") as SNode[]) fpFields.set(str(p[1]), str(p[2]));
        for (const k of [...v.fields.keys()].sort(codeCmp)) {
          if (k.toLowerCase() === "footprint") continue;
          const val = v.fields.get(k) as string;
          const s2 = st as { fields: Map<string, string> } | null;
          const current = s2 && s2.fields.has(k) ? s2.fields.get(k) as string : (fpFields.get(k) ?? "");
          fpFields.delete(k);
          if (current !== val) { say("action", `Change ${ref} field '${k}' to '${val}' on variant ${v.name}.`); add().fields.set(k, val); changed = true; }
        }
        for (const k of [...fpFields.keys()].sort(codeCmp)) {
          if (k.toLowerCase() === "footprint") continue;
          const s2 = st as { fields: Map<string, string> } | null;
          if (cur && s2 && s2.fields.has(k)) { say("action", `Remove ${ref} field '${k}' override on variant ${v.name}.`); s2.fields.delete(k); touched = true; changed = true; }
        }
      }
      if (touched && st) writes.push(st);
    }
    for (const w of writes) {
      const old = footprintVariantNode(fp, w.name); if (old) fp.splice(fp.indexOf(old), 1);
      const fields: Record<string, string> = {}; for (const [k, v] of w.fields) fields[k] = v;
      const out = setFootprintVariant(fp, w.name, { flags: w.flags, fields });
      fp.length = 0; fp.push(...out);
    }
    for (const lowerName of [...excess.keys()].sort((a, b) => codeCmp(excess.get(a) as string, excess.get(b) as string))) {
      const name = excess.get(lowerName) as string;
      say("action", `Remove variant ${ref}:${name} no longer associated with footprint ${fpid}.`);
      const node = footprintVariantNode(fp, name); if (node) fp.splice(fp.indexOf(node), 1);
      changed = true;
    }
    return changed;
  };
  const applyComponent = (fp: SNode, c: NetComponent, fresh: boolean, isBase = false): boolean => {
    let changed = false;
    const orig = clone(fp);
    const oldRef = fpRef(fp);
    if (oldRef !== c.ref) { if (!fresh) say("action", `Change ${oldRef} reference designator to ${c.ref}.`); setFpText(fp, "Reference", c.ref); changed = true; }
    const oldVal = fpValue(fp);
    if (oldVal !== c.value) { if (!fresh) say("action", `Change ${c.ref} value from ${oldVal} to ${c.value}.`); setFpText(fp, "Value", c.value); changed = true; }
    const path = kidStr(fp, "path");
    if (!c.paths.includes(path)) {
      if (!fresh) say("action", `Update ${c.ref} symbol association from ${path} to ${c.paths[0]}.`);
      setKid(fp, "path", [c.paths[0]], ["sheetname", "sheetfile", "units", "solder_mask_margin", "solder_paste_margin", "clearance", "zone_connect", "attr", "duplicate_pad_numbers_are_jumpers", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]); changed = true;
    }
    if (o.updateFields !== false) {
      let touched = false;
      for (const [name, value] of Object.entries(c.fields)) {
        if (name.startsWith("ki_")) continue;
        const p = prop(fp, name);
        if (p) { if (str(p[2]) !== value) { p[2] = value; touched = true; } }
        else if (prop(fp, "Reference")) { insertField(fp, newField(fp, name, value, o)); touched = true; }   // legacy fp_text footprints carry no fields
      }
      if (touched) { if (!fresh) say("action", `Update ${c.ref} fields.`); changed = true; }
    }
    if (o.removeExtraFields) {
      let dropped = false;
      for (let j = fp.length - 1; j > 0; j--) {
        const p = fp[j]; if (!isList(p) || p[0] !== "property") continue;
        const name = str(p[1]); if (MANDATORY.has(name) || name === "Footprint" || name.startsWith("ki_") || name in c.fields) continue;
        fp.splice(j, 1); dropped = true;
      }
      if (dropped) { if (!fresh) say("action", `Remove ${c.ref} footprint fields not in symbol.`); changed = true; }
    }
    if (kidStr(fp, "sheetname") !== c.sheetName) { if (!fresh) say("action", `Update ${c.ref} sheetname to '${c.sheetName}'.`); setKid(fp, "sheetname", [c.sheetName], ["sheetfile", "units", "attr", "fp_text", "fp_line", "pad", "embedded_fonts", "model"]); changed = true; }
    if (kidStr(fp, "sheetfile") !== c.sheetFile) { if (!fresh) say("action", `Update ${c.ref} sheetfile to '${c.sheetFile}'.`); setKid(fp, "sheetfile", [c.sheetFile], ["units", "attr", "fp_text", "fp_line", "pad", "embedded_fonts", "model"]); changed = true; }
    const flags = attrFlags(fp);
    if (flags.has("exclude_from_bom") !== c.excludeFromBom) { if (!fresh) say("action", `${c.excludeFromBom ? "Add" : "Remove"} ${c.ref} 'exclude from BOM' fabrication attribute.`); setAttrFlag(fp, "exclude_from_bom", c.excludeFromBom); changed = true; }
    if (flags.has("dnp") !== c.dnp) { if (!fresh) say("action", `${c.dnp ? "Add" : "Remove"} ${c.ref} 'Do not place' fabrication attribute.`); setAttrFlag(fp, "dnp", c.dnp); changed = true; }
    if (applyNets(c.ref, fp, c)) changed = true;
    if (applyVariants(fp, c, orig, isBase)) changed = true;
    return changed;
  };

  // ---- new footprints go in a row below the board, like the desktop's "spread out" placement
  const bb = doc.bbox || [0, 0, 0, 0];
  let nextX = bb[0], rowY = bb[3] + 10;
  const place = (fp: SNode): void => {
    let w = 10, hgt = 10;
    try {
      const probe = { id: "probe", kind: "footprint", node: clone(fp), geom: [], bbox: null, movable: false, docType: "pcb" } as unknown as KItem;
      (KiCadCanvas.buildGeom as (d: KDoc, i: KItem) => void)(doc, probe);
      if (probe.bbox) { const a = atOf(fp) as number[]; w = probe.bbox[2] - probe.bbox[0]; hgt = probe.bbox[3] - probe.bbox[1]; const dx = a[0] - probe.bbox[0], dy = a[1] - probe.bbox[1]; setKid(fp, "at", [r4(nextX + dx), r4(rowY + dy)], ["descr", "tags", "property"]); }
      else setKid(fp, "at", [r4(nextX), r4(rowY)], ["descr", "tags", "property"]);
    } catch (e) { setKid(fp, "at", [r4(nextX), r4(rowY)], ["descr", "tags", "property"]); }
    nextX += w + 2.54;
    if (nextX - bb[0] > Math.max(120, bb[2] - bb[0])) { nextX = bb[0]; rowY += hgt + 5; }
  };

  const addedFor = new Map<NetComponent, SNode>();
  for (const c of comps) {
    const fp = fpOf.get(c);
    if (!fp) {
      if (!c.footprint) { say("error", `Cannot add ${c.ref} (no footprint assigned).`); continue; }
      const lib = o.footprintFor ? o.footprintFor(c.footprint) : null;
      if (lib === "missing") { say("error", `Cannot add ${c.ref} (footprint '${c.footprint}' not found).`); continue; }
      if (!lib) { say("error", `Cannot add ${c.ref} (footprint '${c.footprint}': library not available).`); continue; }
      const node = clone(lib);
      say("action", `Add ${c.ref} (footprint '${c.footprint}').`);
      applyComponent(node, c, true); place(node); added.push(node); addedFor.set(c, node);
      continue;
    }
    let node = clone(fp.node), noLibrary = false;
    const curId = str(node[1]);
    if (o.replaceFootprints !== false && c.footprint && curId !== c.footprint) {
      const lib = o.footprintFor ? o.footprintFor(c.footprint) : null;
      if (!lib) noLibrary = true;   // the web has no library to swap from: the footprint stands as the base (KiCad would have replaced it)
      if (!lib || lib === "missing") say("error", `Cannot update ${c.ref} (footprint '${c.footprint}' ${lib === "missing" ? "not found" : "not available: no footprint library"}).`);
      else if (isLocked(node) && !o.overrideLocks) say("warning", `Cannot change ${c.ref} footprint from '${curId}' to '${c.footprint}' (footprint is locked).`);
      else {
        say("action", `Change ${c.ref} footprint from '${curId}' to '${c.footprint}'.`);
        const fresh = clone(lib), a = atOf(node) as number[];
        const at: (string | number)[] = [a[0], a[1]]; if (a[2]) at.push(a[2]);
        setKid(fresh, "at", at, ["descr", "tags", "property"], true);
        setKid(fresh, "uuid", [fp.id], ["at"]);
        for (const name of ["Reference", "Value"]) { const from = prop(node, name), to = prop(fresh, name); if (from && to) { const keep = to[2]; to.length = 0; to.push(...clone(from)); if (name === "Value" && !c.value) to[2] = keep; } }
        for (const pad of padsOf(fresh)) { const old = padsOf(node).find((q) => str(q[1]) === str(pad[1])); const n = old && (kid(old, "net") as SNode | null); if (n) { const i = idxOf(pad, "net"); if (i > 0) pad[i] = clone(n); else setKid(pad, "net", n.slice(1) as (string | number)[], PAD_AFTER_NET); } }
        node = fresh;
      }
    }
    if (applyComponent(node, c, false, noLibrary) || node !== fp.node && JSON.stringify(node) !== JSON.stringify(fp.node)) modified.set(fp.id, node);
  }

  // ---- BOARD_NETLIST_UPDATER::updateFootprintGroup: each footprint goes to the board group of its symbol's group
  if (o.transferGroups) {
    interface BGroup { id: string | null; node: SNode; members: string[]; dirty: boolean }
    const groups = new Map<string, BGroup>();
    for (const it of doc.items.values()) if (it.kind === "group") { const node = clone(it.node), m = kid(node, "members") as SNode | null; groups.set(kidStr(node, "uuid") || it.id, { id: it.id, node, members: m ? m.slice(1).map(str) : [], dirty: false }); }
    const nameOf = (g: BGroup): string => (typeof g.node[1] === "string" ? str(g.node[1]) : "");
    for (const c of comps) {
      const fp = fpOf.get(c), fresh = addedFor.get(c);
      const fpId = fp ? fp.id : fresh ? kidStr(fresh, "uuid") : ""; if (!fpId) continue;
      const want = c.group ? c.group.uuid : "";
      const cur = Array.from(groups.entries()).find(([, g]) => g.members.includes(fpId));
      if ((cur ? cur[0] : "") === want) continue;
      if (cur) { say("action", `Remove ${c.ref} from group '${nameOf(cur[1])}'.`); cur[1].members = cur[1].members.filter((m) => m !== fpId); cur[1].dirty = true; }
      if (c.group) {
        say("action", `Add ${c.ref} to group '${c.group.name}'.`);
        let g = groups.get(want);
        if (!g) { g = { id: null, node: c.group.name ? ["group", c.group.name, ["uuid", want], ["members"]] : ["group", "", ["uuid", want], ["members"]], members: [], dirty: true }; groups.set(want, g); }
        g.members.push(fpId); g.dirty = true;
      }
    }
    for (const g of groups.values()) {
      if (!g.dirty) continue;
      if (g.id && g.members.length < 2) { removed.push(g.id); continue; }   // a group of fewer than two items goes
      if (!g.members.length) continue;
      const i = g.node.findIndex((x, k) => k > 0 && Array.isArray(x) && x[0] === "members");
      const m: SNode = ["members", ...g.members]; if (i > 0) g.node[i] = m; else g.node.push(m);
      if (g.id) modified.set(g.id, g.node); else added.push(g.node);
    }
  }

  // ---- footprints with no symbol
  for (const fp of fps) {
    if (claimed.has(fp.id)) continue;
    const ref = fpRef(fp.node);
    if (attrFlags(fp.node).has("board_only")) continue;
    if (o.deleteUnused) {
      if (isLocked(fp.node) && !o.overrideLocks) { say("warning", `Cannot remove unused footprint ${ref} (footprint is locked).`); continue; }
      say("action", `Remove unused footprint ${ref}.`); removed.push(fp.id);
    } else if (padsOf(fp.node).some((p) => netNameOf(doc, p))) {
      // KiCad leaves the footprint but its pads no longer belong to any net of the schematic
      const node = clone(fp.node); let changed = false;
      for (const pad of padsOf(node)) if (netNameOf(doc, pad)) { say("action", `Disconnect ${ref} pin ${str(pad[1])}.`); delKid(pad, "net"); delKid(pad, "pinfunction"); delKid(pad, "pintype"); changed = true; }
      if (changed) modified.set(fp.id, node);
    }
  }

  // ---- copper that sat on a renamed net follows it (vias and zones are reported, tracks follow silently)
  const still = new Set<string>(); for (const c of comps) for (const p of c.pins.values()) still.add(p.net);
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via" && it.kind !== "zone") continue;
    const cur = netNameOf(doc, it.node); if (!cur || still.has(cur)) continue;
    const to = oldToNew.get(cur); if (!to) continue;
    const node = clone(it.node);
    if (it.kind === "zone") {
      const zn = kidStr(node, "name");
      say("action", zn ? `Reconnect copper zone '${zn}' from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.` : `Reconnect copper zone from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`);
      if (byCode) { setKid(node, "net", [codeOf.get(to) as number], ["net_name", "layer", "layers"]); setKid(node, "net_name", [to], ["layer", "layers"]); }
      else { setKid(node, "net", [to], ["net_name", "layer", "layers"]); if (kid(node, "net_name")) setKid(node, "net_name", [to], ["layer", "layers"]); }
    } else {
      if (it.kind === "via") say("action", `Reconnect via from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`);
      setKid(node, "net", byCode ? [codeOf.get(to) as number] : [to], ["uuid", "tstamp"]);
    }
    modified.set(it.id, node);
  }
  for (const n of Array.from(boardNets).sort()) if (!still.has(n) && netGone(n)) say("action", `Removed unused net ${unescapeNetName(n)}.`);
  function netGone(n: string): boolean {
    for (const fp of fps) { if (removed.includes(fp.id)) continue; const node = modified.get(fp.id) || fp.node; for (const p of kids(node, "pad") as SNode[]) if (netNameOf(doc, p) === n) return false; }
    return true;
  }
  for (const w of netlist.warnings) say("warning", w);
  say("info", `Total warnings: ${warnings}, errors: ${errors}.`);
  return { report, modified, removed, added, warnings, errors };
}

/**
 * A board footprint from library text (.kicad_mod): fresh uuids everywhere, the library id as the footprint
 * name, front side at the origin.  The updater then lays the component's fields and nets over it.
 */
export function footprintFromLibrary(mod: SNode, fpid: string, newUuid: () => string): SNode {
  const fp = clone(mod);
  fp[0] = "footprint"; fp[1] = fpid;
  for (const k of ["version", "generator", "generator_version", "tedit", "uuid", "at", "locked", "placed"]) while (delKid(fp, k)) { /* drop every copy */ }
  const stamp = (n: SNode): void => {
    for (let j = 1; j < n.length; j++) { const c = n[j]; if (!isList(c)) continue; if (c[0] === "uuid" || c[0] === "tstamp") { n[j] = qnode("uuid", [newUuid()]); continue; } stamp(c); }
    if (["property", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "pad", "zone", "dimension"].includes(str(n[0])) && idxOf(n, "uuid") < 0) {
      const e = idxOf(n, "effects"); n.splice(e > 0 ? e : n.length, 0, qnode("uuid", [newUuid()]));
    }
  };
  stamp(fp);
  const layer = idxOf(fp, "layer");
  fp.splice(layer > 0 ? layer + 1 : 2, 0, qnode("uuid", [newUuid()]), ["at", 0, 0]);
  return fp;
}

// ---------------------------------------------------------------- schematic parity (DRC_TEST_PROVIDER_SCHEMATIC_PARITY)
export interface ParityIssue { code: string; severity: "error" | "warning"; x: number; y: number; text: string; ids: string[] }
/** The board against the schematic's netlist: missing / extra / duplicate footprints, value and footprint mismatches, pad nets. */
export function schematicParity(doc: KDoc, netlist: Netlist): ParityIssue[] {
  const out: ParityIssue[] = [];
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint");
  const at = (fp: KItem): [number, number] => { const a = atOf(fp.node) as number[]; return [a[0] || 0, a[1] || 0]; };
  const say = (code: string, text: string, fp: KItem | null): void => { const p = fp ? at(fp) : [0, 0]; out.push({ code, severity: "warning", x: p[0], y: p[1], text, ids: fp ? [fp.id] : [] }); };
  const byPath = new Map<string, KItem>(), byRef = new Map<string, KItem[]>();
  for (const fp of fps) {
    const path = kidStr(fp.node, "path"); if (path && !byPath.has(path)) byPath.set(path, fp);
    const ref = fpRef(fp.node); const l = byRef.get(ref); if (l) l.push(fp); else byRef.set(ref, [fp]);
  }
  for (const [ref, list] of byRef) if (ref && list.length > 1) for (const fp of list.slice(1)) say("duplicate_footprints", `Duplicate footprints (${ref})`, fp);
  const pinNet = new Map<string, string>();
  for (const [name, pins] of netlist.nets) for (const p of pins) pinNet.set(p.ref + "|" + p.pin, name);
  const matched = new Set<string>();
  for (const c of netlist.components) {
    let fp: KItem | undefined;
    for (const p of c.paths) { fp = byPath.get(p); if (fp) break; }
    if (!fp) fp = (byRef.get(c.ref) || []).find((f) => !matched.has(f.id));
    if (!fp) { if (c.footprint) say("missing_footprint", `Missing footprint ${c.ref} (${c.value})`, null); continue; }
    matched.add(fp.id);
    const value = fpValue(fp.node);
    if (value !== c.value) say("footprint_symbol_mismatch", `Value (${value}) doesn't match symbol value (${c.value})`, fp);
    const fpid = str(fp.node[1]);
    if (c.footprint && fpid !== c.footprint) say("footprint_symbol_mismatch", `${fpid} doesn't match footprint given by symbol (${c.footprint})`, fp);
    const seen = new Set<string>();
    for (const pad of kids(fp.node, "pad") as SNode[]) {
      const number = str(pad[1]); if (!number) continue; seen.add(number);
      const want = pinNet.get(c.ref + "|" + number), n = kid(pad, "net") as SNode | null;
      const have = n ? (typeof n[1] === "number" ? (n.length > 2 ? str(n[2]) : str(doc.nets.get(n[1]) || "")) : str(n[1])) : "";
      if (want === undefined) { if (have && !/^unconnected-\(/.test(have)) say("net_conflict", `${c.ref} pad ${number}: No corresponding pin found in schematic`, fp); }
      else if (!have) say("net_conflict", `${c.ref} pad ${number}: Pad missing net given by schematic (${want})`, fp);
      else if (have !== want) say("net_conflict", `${c.ref} pad ${number}: Pad net (${have}) doesn't match net given by schematic (${want})`, fp);
    }
    for (const key of pinNet.keys()) if (key.startsWith(c.ref + "|") && !seen.has(key.slice(c.ref.length + 1))) say("net_conflict", `${c.ref}: No pad found for pin ${key.slice(c.ref.length + 1)} in schematic`, fp);
  }
  for (const fp of fps) {
    if (matched.has(fp.id)) continue;
    const attr = kid(fp.node, "attr") as SNode | null;
    if (attr && attr.includes("board_only")) continue;
    say("extra_footprint", `Extra footprint (${fpRef(fp.node) || str(fp.node[1])})`, fp);
  }
  return out;
}

/** A new, empty board as pcbnew creates it for a project that has none (two copper layers, the default layer set). */
const NEW_BOARD_LAYERS = '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments") (21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))';
export function newBoardText(version: number): string {
  return `(kicad_pcb (version ${version}) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6) (legacy_teardrops no)) (paper "A4") ${NEW_BOARD_LAYERS} (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no)) (net 0 ""))\n`;
}
/** The project's board: <project>.kicad_pcb next to the .kicad_pro (Prj().GetProjectFullName() with the board extension). */
export function projectBoardPath(docs: { docId: string; path: string; docType: string }[]): { path: string; doc: { docId: string; path: string; docType: string } | null } {
  const pro = docs.find((d) => d.docType === "kicad_pro");
  const path = pro ? pro.path.replace(/\.kicad_pro$/, ".kicad_pcb") : "";
  const doc = docs.find((d) => d.docType === "kicad_pcb" && d.path === path) || (pro ? null : docs.find((d) => d.docType === "kicad_pcb") || null);
  return { path: path || (doc ? doc.path : ""), doc };
}

export const pcbNetlist = { newBoardText, projectBoardPath, buildNetlist, planUpdate, componentVariants, schematicParity, footprintFromLibrary, escapeNetName, unescapeNetName, busVector };
