// sim/spice-netlist — NETLIST_EXPORTER_SPICE (eeschema/netlist_exporters/netlist_exporter_spice.cpp), pure.
//
// DoWriteNetlist writes, in order:
//   .title KiCad schematic
//   .include "<path>"            each SPICE library a symbol's Sim.Library names (path order), then raw includes
//   <ModelLine>…                 each enabled item's .model (SPICE_GENERATOR::ModelLine)
//   .save all / .probe alli / .probe p(<item>)…   (Save all voltages / currents / power dissipations; only when there
//                                 are items), then the schematic's directive texts (simulation commands only with
//                                 OPTION_SIM_COMMAND)
//   <ItemLine>…                  each enabled item (name, pin nets, model name, instance parameters)
//   .end
// Net names go through ConvertToSpiceMarkup; an unconnected pin is NC-<n> (one counter for the netlist).  Model names
// KiCad defines with a .model line are made unique with NAME_GENERATOR ("name", "name#1", …).
import * as S from "../dialogs/sim-model-logic";
import { ruleAreasAround } from "./netlist-kicad";

export const OPTION_SAVE_ALL_VOLTAGES = 0x0040, OPTION_SAVE_ALL_CURRENTS = 0x0080, OPTION_SAVE_ALL_DISSIPATIONS = 0x0100,
  OPTION_CUR_SHEET_AS_ROOT = 0x0200, OPTION_SIM_COMMAND = 0x0400, OPTION_SAVE_ALL_EVENTS = 0x0800;

/** One symbol as the exporter reads it (first unit; pins of every unit, CreatePinList order). */
export interface SpiceSymbol {
  ref: string;
  /** every field: name and shown value (Reference is the instance's) */
  fields: S.FieldLike[];
  /** the symbol's pin numbers and, for each, its net's name ("" when the pin is on no net) */
  pins: { number: string; net: string }[];
}
export interface SpiceLibraryRef { path: string; lib: S.SpiceLibrary }
export interface SpiceNetlistInput {
  symbols: SpiceSymbol[];
  /** the text of each schematic text / text box not excluded from simulation */
  texts: string[];
  options: number;
  /** a library by its Sim.Library path (as the field holds it); null when it cannot be read */
  library(path: string): S.SpiceLibrary | null;
  report?(message: string, severity: "error" | "warning"): void;
  /** NETLIST_EXPORTER_SPICE_MODEL: the .subckt's name (the project's) and its ports (readHierarchy's ports) */
  subckt?: { name: string; ports: Map<string, SpicePort> };
}
/** A hierarchical label as a .subckt port: its text and LABEL_FLAG_SHAPE. */
export interface SpicePort { name: string; shape: string }
const PORT_DIR: Record<string, string> = { input: "input", output: "output", bidirectional: "inout", tri_state: "tristate", passive: "passive" };

/** NETLIST_EXPORTER_SPICE::ConvertToSpiceMarkup. */
export function convertToSpiceMarkup(netName: string): string {
  const unescape = (s: string): string => s.replace(/\{slash\}/g, "/").replace(/\{backslash\}/g, "\\").replace(/\{lt\}/g, "<").replace(/\{gt\}/g, ">").replace(/\{colon\}/g, ":").replace(/\{dquote\}/g, '"').replace(/\{space\}/g, " ");
  const lastSeg = netName.lastIndexOf("/") >= 0 ? netName.slice(netName.lastIndexOf("/") + 1) : netName;
  const literalSlash = unescape(lastSeg).includes("/");
  let name = unescape(netName);
  // MARKUP_PARSER: ~{x} → "~x", _{x} / ^{x} → "x"
  let out = "", i = 0;
  const walk = (stop: boolean): void => {
    while (i < name.length) {
      const c = name[i];
      if ((c === "~" || c === "_" || c === "^") && name[i + 1] === "{") {
        let depth = 1, j = i + 2;
        while (j < name.length && depth) { if (name[j] === "{") depth++; else if (name[j] === "}") depth--; if (depth) j++; }
        if (j >= name.length) { out += c; i++; continue; }   // unterminated: literal
        if (c === "~") out += "~";
        const inner = name.slice(i + 2, j); const saved = name; const savedI = j + 1;
        name = inner; i = 0; walk(true); name = saved; i = savedI; continue;
      }
      out += c; i++;
    }
    void stop;
  };
  walk(false);
  name = out;
  name = name.replace(/[%(),\[\]<>~ ]/g, "_");
  const localName = name.lastIndexOf("/") >= 0 ? name.slice(name.lastIndexOf("/") + 1) : name;
  if (!literalSlash && (localName === "0" || localName.toLowerCase() === "gnd") && !name.endsWith("//" + localName)) name = localName;
  if (name.startsWith("//")) name = name.split("//").join("/root/");
  return name;
}

const DIRECTIVES = [".AC", ".CONTROL", ".CSPARAM", ".DISTO", ".DC", ".ELSE", ".ELSEIF", ".END", ".ENDC", ".ENDIF", ".ENDS", ".FOUR", ".FUNC", ".GLOBAL", ".IC", ".IF", ".INCLUDE",
  ".LIB", ".MEAS", ".MODEL", ".NODESET", ".NOISE", ".OP", ".OPTIONS", ".PARAM", ".PLOT", ".PRINT", ".PROBE", ".PZ", ".SAVE", ".SENS", ".SP", ".SUBCKT", ".TEMP", ".TF", ".TITLE", ".TRAN", ".WIDTH"];
const SIM_COMMANDS = [".AC", ".DC", ".TRAN", ".OP", ".DISTO", ".NOISE", ".PZ", ".SENS", ".TF"];
const isDir = (line: string, d: string): boolean => line === d || line.startsWith(d + " ");

/** ReadDirectives: the texts that hold a SPICE directive (or a mutual-inductor K line). */
export function readDirectives(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    let found = false;
    for (const raw of text.split(/[\r\n]+/).filter(Boolean)) {
      const line = raw.toUpperCase();
      if (line.startsWith(".")) { if (DIRECTIVES.some((d) => isDir(line, d))) { found = true; break; } }
      else if (line.startsWith("K")) {
        const t = line.split(/[ \t]+/).filter(Boolean);
        if (t.length < 3 || !t[0].startsWith("K") || !t[1].startsWith("L") || !t[2].startsWith("L")) continue;
        if (t.length > 3) { found = true; break; }
      }
    }
    if (found) out.push(text);
  }
  return out;
}

const SIM_FIELDS = [S.F.DEVICE, S.F.TYPE, S.F.PINS, S.F.PARAMS, S.F.LIBRARY, S.F.NAME];

interface Item { ref: string; model: S.SimModel; modelName: string; baseModelName: string; pinNumbers: string[]; pinNetNames: string[] }

/** The SPICE netlist text. */
export function spiceNetlist(inp: SpiceNetlistInput): string {
  const report = inp.report || (() => {});
  const items: Item[] = []; const libsUsed = new Set<string>(); const names = new Set<string>();
  const generate = (proposed: string): string => { let name = proposed, ii = 1; while (names.has(name)) name = `${proposed}#${ii++}`; names.add(name); return name; };
  let nc = 1;
  for (const sym of inp.symbols) {
    let rows = sym.fields.map((f) => ({ name: f.name, value: f.value }));
    const pinNumbers = sym.pins.map((p) => p.number);
    // SIM_LIB_MGR::CreateModel: a symbol without simulation fields is inferred from its reference and value
    if (!SIM_FIELDS.some((k) => S.getFieldValue(rows, k) !== "")) {
      const inf = S.inferSimModel(sym.ref.replace(/[^A-Za-z].*$/, ""), pinNumbers, rows);
      if (inf.ok) {
        rows = rows.concat([{ name: S.F.DEVICE, value: inf.deviceType }, ...(inf.modelType ? [{ name: S.F.TYPE, value: inf.modelType }] : []), { name: S.F.PARAMS, value: inf.params }, { name: S.F.PINS, value: inf.pinMap }]);
      }
    }
    let model: S.SimModel, baseModelName = "";
    const libPath = S.getFieldValue(rows, S.F.LIBRARY);
    if (libPath) {
      const lib = inp.library(libPath);
      if (!lib) { report(`Simulation model library not found at '${libPath}'`, "error"); continue; }
      if (lib.ibis) { report(`IBIS models are not available in the web netlist exporter ('${sym.ref}')`, "error"); continue; }
      const name = S.getFieldValue(rows, S.F.NAME);
      const lm = lib.models.find((m) => m.name === name) || lib.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (!lm) { report(`No model named '${name}' in library.`, "error"); continue; }
      model = S.createFromBase(lm.model, pinNumbers, rows); baseModelName = lm.name; libsUsed.add(libPath);
    } else {
      const r = S.createFromFields(rows, pinNumbers); model = r.model;
      if (r.error) report(r.error, "error");
    }
    // GenerateItemPinNetName (the model exporter names a port's net after the port first)
    const ports = inp.subckt ? inp.subckt.ports : null;
    const pinNetNames = sym.pins.map((p) => { const n = convertToSpiceMarkup(ports && ports.has(p.net) ? (ports.get(p.net) as SpicePort).name : p.net); return n === "" ? `NC-${nc++}` : n; });
    const probe: S.SpiceItem = { refName: sym.ref, modelName: "", baseModelName, pinNumbers, pinNetNames };
    // SPICE_GENERATOR::ModelName, uniquified only for names KiCad itself defines with a .model line
    const proposed = baseModelName === "" ? `__${sym.ref}` : `${sym.ref}.${baseModelName}`;
    const needsLine = S.modelLine(model, { ...probe, modelName: proposed }) !== "";
    const modelName = baseModelName === "" ? generate(proposed) : needsLine ? generate(proposed) : baseModelName;
    items.push({ ref: sym.ref, model, modelName, baseModelName, pinNumbers, pinNetNames });
  }
  const directives = readDirectives(inp.texts);
  let out = ".title KiCad schematic\n";
  if (inp.subckt) {
    // NETLIST_EXPORTER_SPICE_MODEL::WriteHead
    out = `*\n\n.subckt ${inp.subckt.name}\n`;
    for (const [, port] of [...inp.subckt.ports.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out += `+       ${port.name} ; ${PORT_DIR[port.shape] || "passive"}\n`;
    out += "\n\n";
  }
  for (const p of [...libsUsed].sort()) out += `.include "${p.replace(/\\/g, "/")}"\n`;
  const spiceItem = (it: Item): S.SpiceItem => ({ refName: it.ref, modelName: it.modelName, baseModelName: it.baseModelName, pinNumbers: it.pinNumbers, pinNetNames: it.pinNetNames });
  for (const it of items) if (it.model.enabled) out += S.modelLine(it.model, spiceItem(it));
  if (items.length) {
    if (inp.options & OPTION_SAVE_ALL_VOLTAGES) out += ".save all\n";
    if (inp.options & OPTION_SAVE_ALL_CURRENTS) out += ".probe alli\n";
    if (inp.options & OPTION_SAVE_ALL_DISSIPATIONS) for (const it of items) {
      const nm = S.itemName(it.model, spiceItem(it));
      if (it.model.pins.length >= 2 && nm.length > 0 && nm[0] !== "A") out += `.probe p(${nm})\n`;
    }
    for (const d of directives) {
      const sim = d.startsWith(".") && SIM_COMMANDS.some((c) => isDir(d.toUpperCase(), c));
      if (!sim || (inp.options & OPTION_SIM_COMMAND)) out += d + "\n";
    }
  }
  for (const it of items) if (it.model.enabled) out += S.itemLine(it.model, spiceItem(it));
  out += inp.subckt ? "\n.ends\n" : ".end\n";
  return out;
}

// ---------------------------------------------------------------- the hierarchy as the exporter reads it
type N = SNode;
const isList = Array.isArray;
const kidOf = (n: N | null | undefined, key: string): N | null => { if (!n) return null; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return c as N; } return null; };
const kidsOf = (n: N | null | undefined, key: string): N[] => (n ? (n.filter((c) => isList(c) && c[0] === key) as N[]) : []);
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const yesOf = (n: N, key: string, dflt: boolean): boolean => { const k = kidOf(n, key); return k ? (k.length < 2 || /^(yes|true)$/.test(sv(k[1]))) : dflt; };

export interface HierarchySheet {
  index: number; uuidPath: string[]; doc: KDoc;
  /** the (sheet …) that instantiates this sheet, in its parent's file (null / absent for the root) */
  sheetNode?: N | null;
  /** the parent file's (version …): the variant in_bom meaning of the sheet symbol */
  parentVersion?: number;
}
export interface HierarchyNetMember { inst: number; id: string; kind: string; pin?: string }
export interface HierarchyInput {
  sheets: HierarchySheet[];
  /** the net map of the hierarchy (pcb-netlist buildNetlist().netMap) */
  netMap: Map<string, { name: string; bus: boolean; members: HierarchyNetMember[] }>;
  symbolPins(doc: KDoc, item: KItem): { number: string }[];
  isPower(doc: KDoc, item: KItem): boolean;
  project?: string;
  /** the current variant (field values and exclude-from-simulation through it) */
  variant?: string;
  /** the project's text variables (.kicad_pro text_variables), for the fields' GetShownText */
  textVars?: Record<string, string>;
}

/** StrNumCmp, case-insensitive (CreatePinList's pin order). */
function strNumCmpI(a: string, b: string): number { return S.strNumCmp(a, b, true); }

/** ReadSchematicAndLibraries' walk: each sheet instance, its symbols by uuid, the first unit of each reference with
 *  the pins of all its units (CreatePinList: by number, duplicates dropped), net names from the net map; and the
 *  texts for ReadDirectives. */
export function readHierarchy(h: HierarchyInput): { symbols: SpiceSymbol[]; texts: string[]; ports: Map<string, SpicePort> } {
  const netOf = new Map<string, string>(), labelNet = new Map<string, string>();
  for (const e of h.netMap.values()) {
    if (e.bus) continue;
    for (const m of e.members) {
      if (m.kind === "pin" && m.pin !== undefined) netOf.set(`${m.inst}|${m.id}|${m.pin}`, e.name);
      else if (m.kind === "hierarchical_label") labelNet.set(`${m.inst}|${m.id}`, e.name);
    }
  }
  // NETLIST_EXPORTER_SPICE_MODEL::readPorts: each hierarchical label of the exported sheets, by its net (first wins)
  const ports = new Map<string, SpicePort>();
  for (const sh of h.sheets) for (const it of sh.doc.items.values()) {
    if (it.kind !== "hierarchical_label") continue;
    const net = labelNet.get(`${sh.index}|${it.id}`); if (net === undefined || ports.has(net)) continue;
    ports.set(net, { name: sv(it.node[1]), shape: sv((kidOf(it.node, "shape") || [])[1]) || "input" });
  }
  const symbols: SpiceSymbol[] = [], texts: string[] = [], seen = new Set<string>();
  const refOf = (n: N, path: string): string => {
    let ref = sv((kidsOf(n, "property").find((p) => sv(p[1]) === "Reference") || [])[2]);
    for (const pr of kidsOf(kidOf(n, "instances"), "project")) for (const p of kidsOf(pr, "path")) if (sv(p[1]) === path) { const r = kidOf(p, "reference"); if (r) ref = sv(r[1]); }
    return ref;
  };
  const viewOf = (n: N, path: string, ver?: number): N => (h.variant ? symbolViewForVariantAny(n, h.variant, path, ver) : n);
  // BuildSheetList: a sheet path any of whose sheets is excluded from simulation (for the current variant, on the
  // instance it is placed on) is not exported
  const excludedSheet = (sh: HierarchySheet): boolean => h.sheets.some((a) => a.sheetNode && a.uuidPath.length <= sh.uuidPath.length && a.uuidPath.every((u, i) => sh.uuidPath[i] === u)
    && yesOf(viewOf(a.sheetNode, "/" + a.uuidPath.slice(0, -1).join("/"), a.parentVersion), "exclude_from_sim", false));
  const sheets = h.sheets.filter((sh) => !excludedSheet(sh));
  // GetShownText( &sheet, FOR_NETNAME, variant ) of a field: the symbol's fields, ${REFERENCE} / ${UNIT}, the sheet's
  // fields, the project's text variables and ${REF:FIELD} cross-references (a name nothing defines stays as written)
  const crossRef = (ref: string, field: string, depth: number): string | undefined => {
    for (const s2 of sheets) {
      const p2 = "/" + s2.uuidPath.join("/");
      for (const u of s2.doc.items.values()) {
        if (u.kind !== "symbol" || refOf(u.node, p2) !== ref) continue;
        return fieldShown(viewOf(u.node, p2, s2.doc.version), ref, s2, field, depth + 1);
      }
    }
    return undefined;
  };
  const fieldShown = (node: N, ref: string, sh: HierarchySheet, field: string, depth: number): string | undefined => {
    const up = field.toUpperCase();
    if (up === "REFERENCE") return ref;
    const p = kidsOf(node, "property").find((q) => sv(q[1]).toUpperCase() === up);
    return p ? resolveText(node, ref, sh, sv(p[2]), depth) : undefined;
  };
  const resolveText = (node: N, ref: string, sh: HierarchySheet, text: string, depth: number): string => {
    if (depth > 10 || text.indexOf("${") < 0) return text;
    const tv = h.textVars || {};
    return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
      const up = name.toUpperCase();
      let v: string | undefined;
      if (up === "UNIT") v = "";
      const colon = name.indexOf(":");
      if (v === undefined && colon > 0) v = crossRef(name.slice(0, colon), name.slice(colon + 1), depth);
      if (v === undefined && colon < 0) v = fieldShown(node, ref, sh, name, depth + 1);
      if (v === undefined && sh.sheetNode && colon < 0) { const q = kidsOf(sh.sheetNode, "property").find((x) => sv(x[1]).toUpperCase() === up); if (q) v = sv(q[2]); }
      if (v === undefined && Object.prototype.hasOwnProperty.call(tv, name)) v = tv[name];
      return v === undefined ? m : resolveText(node, ref, sh, v, depth + 1);
    });
  };
  for (const sh of sheets) {
    const path = "/" + sh.uuidPath.join("/");
    const items = [...sh.doc.items.values()];
    for (const it of items) {
      if ((it.kind === "text" || it.kind === "text_box") && !yesOf(it.node, "exclude_from_sim", false)) texts.push(sv(it.node[1]));
    }
    const syms = items.filter((it) => it.kind === "symbol").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of syms) {
      if (h.isPower(sh.doc, it)) continue;
      const ref = refOf(it.node, path);
      if (!ref || ref.startsWith("#") || seen.has(ref)) continue;
      const node = viewOf(it.node, path, sh.doc.version);
      // ResolveExcludedFromSim: the symbol's own flag, or a rule area around it excluded from simulation
      if (yesOf(node, "exclude_from_sim", false)) continue;
      if (ruleAreasAround(sh.doc, it).some((ra) => yesOf(ra.node, "exclude_from_sim", false))) continue;
      seen.add(ref);
      // every unit of the reference on every sheet instance
      const pins: { number: string; net: string }[] = []; const have = new Set<string>();
      for (const s2 of sheets) {
        const p2 = "/" + s2.uuidPath.join("/");
        for (const u of s2.doc.items.values()) {
          if (u.kind !== "symbol" || refOf(u.node, p2) !== ref) continue;
          for (const p of h.symbolPins(s2.doc, u)) { if (have.has(p.number)) continue; have.add(p.number); pins.push({ number: p.number, net: netOf.get(`${s2.index}|${u.id}|${p.number}`) || "" }); }
        }
      }
      pins.sort((a, b) => strNumCmpI(a.number, b.number));
      const fields: S.FieldLike[] = kidsOf(node, "property").map((p) => ({ name: sv(p[1]), value: sv(p[1]) === "Reference" ? ref : resolveText(node, ref, sh, sv(p[2]), 0) }));
      symbols.push({ ref, fields, pins });
    }
  }
  return { symbols, texts, ports };
}
let symbolViewForVariantAny: (n: N, v: string, path: string, ver?: number) => N = (n) => n;
/** The variant view the reader uses (canvas/variant-model symbolViewForVariant), set by the caller's bundle. */
export function setVariantView(fn: (n: N, v: string, path: string, ver?: number) => N): void { symbolViewForVariantAny = fn; }
