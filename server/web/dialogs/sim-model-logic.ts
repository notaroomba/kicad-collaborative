// dialogs/sim-model-logic.ts — the model side of DIALOG_SIM_MODEL, ported from eeschema/sim: SIM_VALUE (sim_value.cpp),
// SIM_MODEL and its subclasses (sim_model*.cpp), SIM_MODEL_SERIALIZER (sim_model_serializer.cpp), SPICE_GENERATOR::Preview
// (spice_generator.cpp and the per-model overrides), the SPICE library reader (spice_library_parser.cpp,
// spice_model_parser.cpp) and the dialog's own field handling (TransferDataToWindow / TransferDataFromWindow,
// RestoreInferredValue, DIALOG_SYMBOL_PROPERTIES::OnEditSpiceModel).  Pure: no DOM, so it runs under node.
import { DEVICES, MODEL_CLASS, NGSPICE_MODEL_OF, PARAMS, PIN_NAMES, SPICE_INFO, TYPES, type ParamTuple } from "./sim-model-data";
import type { NgspiceModelInfo } from "./sim-model-ngspice";

// ---------------------------------------------------------------- field names (sim_model.h, sim_library*.h)
export const F = {
  REFERENCE: "Reference", VALUE: "Value", DEVICE: "Sim.Device", TYPE: "Sim.Type", PINS: "Sim.Pins", DECOMPOSITION: "Sim.Decomposition",
  PARAMS: "Sim.Params", LIBRARY: "Sim.Library", NAME: "Sim.Name", ENABLE: "Sim.Enable",
  IBIS_PIN: "Sim.Ibis.Pin", IBIS_MODEL: "Sim.Ibis.Model", IBIS_DIFF: "Sim.Ibis.Diff",
} as const;

// ---------------------------------------------------------------- the tables
export type Category = "PRINCIPAL" | "GEOMETRY" | "AC" | "DC" | "CAPACITANCE" | "TEMPERATURE" | "NOISE" | "DISTRIBUTED_QUANTITIES" | "LIMITING_VALUES" | "S_PARAM" | "ADVANCED" | "FLAGS" | "WAVEFORM" | "INITIAL_CONDITIONS" | "SUPERFLUOUS";
export interface ParamInfo { name: string; id: number; dir: string; type: string; unit: string; category: Category; defaultValue: string; description: string; isSpiceInstanceParam: boolean; isInstanceParam: boolean; spiceModelName: string; spiceInstanceName: string; enumValues: string[] }
export function infoOf(t: ParamTuple): ParamInfo {
  const g = (i: number, d: unknown) => (t.length > i ? t[i] : d);
  return { name: g(0, "") as string, id: g(1, 0) as number, dir: g(2, "INOUT") as string, type: g(3, "FLOAT") as string, unit: g(4, "") as string, category: g(5, "PRINCIPAL") as Category,
    defaultValue: g(6, "") as string, description: g(7, "") as string, isSpiceInstanceParam: !!g(8, false), isInstanceParam: !!g(9, false), spiceModelName: g(10, "") as string,
    spiceInstanceName: g(11, "") as string, enumValues: ((g(12, []) as string[]) || []).slice() };
}
export const newInfo = (o: Partial<ParamInfo> = {}): ParamInfo => Object.assign(infoOf([]), o);
let NG: Record<string, NgspiceModelInfo> | null = null;
/** The ngspice tables (sim-model-ngspice.ts) live in a bundle of their own, loaded the first time they are needed. */
export function setNgspiceData(d: Record<string, NgspiceModelInfo>): void { NG = d; }
export const hasNgspiceData = (): boolean => !!NG;

export const DEVICE_IDS = DEVICES.map((d) => d[0]);
export const TYPE_IDS = TYPES.map((t) => t[0]);
const devRow = new Map(DEVICES.map((d) => [d[0], d]));
const typeRow = new Map(TYPES.map((t) => [t[0], t]));
export const deviceInfo = (d: string) => { const r = devRow.get(d) || ["", "", "", false]; return { fieldValue: r[1], description: r[2], showInMenu: r[3] }; };
export const typeInfo = (t: string) => { const r = typeRow.get(t) || ["", "NONE", "", ""]; return { deviceType: r[1], fieldValue: r[2], description: r[3] }; };
export const spiceInfo = (t: string) => { const r = SPICE_INFO[t] || []; return { itemType: (r[0] as string) || "", modelType: (r[1] as string) || "", functionName: (r[2] as string) || "", level: (r[3] as string) || "", isDefaultLevel: !!r[4], hasExpression: !!r[5], version: (r[6] as string) || "" }; };
/** equivalent() in dialog_sim_model.cpp: E/H are voltage sources and F/G current sources too. */
export const equivalentDevice = (a: string, b: string): boolean => a === b || deviceInfo(a).description === deviceInfo(b).description;
export const isKibis = (t: string): boolean => /^KIBIS_/.test(t);
export const modelClass = (t: string): string => MODEL_CLASS[t] || "none";
export function needsNgspice(t: string): boolean { return modelClass(t) === "ngspice"; }

// ---------------------------------------------------------------- SIM_VALUE (sim_value.cpp)
export type Notation = "SI" | "SPICE";
interface Parse { ok: boolean; empty: boolean; significand: string; exponent: number | null; prefixExp: number | null; intPart: number | null; fracPart: number | null }
const SI_FLOAT = /^(?:([+-]?\d+)\.(\d+)|([+-]?\d+)\.|([+-]?\d+)|\.(\d+)|\.|-)?(?:[eE]([+-]?\d*))?([afpnumkKMGTPE])?$/;
const SI_INT = /^([+-]?\d+)?(?:[eE]([+-]?\d*))?([kKMGTPE])?$/;
const SPICE_FLOAT = /^(?:([+-]?\d+)\.(\d+)|([+-]?\d+)\.|([+-]?\d+)|\.(\d+)|\.|-)?(?:[eE]([+-]?\d*))?(meg|[fpnumkgt])?[a-z]*$/i;
const SPICE_INT = /^([+-]?\d+)?(?:[eE]([+-]?\d*))?(meg|[kgt])?[a-z]*$/i;
function prefixExp(p: string, n: Notation): number {
  if (n === "SI") return ({ a: -18, f: -15, p: -12, n: -9, u: -6, m: -3, k: 3, K: 3, M: 6, G: 9, T: 12, P: 15, E: 18 } as Record<string, number>)[p[0]] ?? 0;
  return ({ f: -15, p: -12, n: -9, u: -6, m: -3, "": 0, k: 3, meg: 6, g: 9, t: 12 } as Record<string, number>)[p.toLowerCase()] ?? 0;
}
/** SIM_VALUE_PARSER::Parse (numberGrammar<TYPE, NOTATION>). */
export function parseValue(s: string, n: Notation = "SI", type: "FLOAT" | "INT" = "FLOAT"): Parse {
  const r: Parse = { ok: false, empty: true, significand: "", exponent: null, prefixExp: null, intPart: null, fracPart: null };
  if (type === "INT") {
    const m = (n === "SI" ? SI_INT : SPICE_INT).exec(s); if (!m) return r; r.ok = true;
    if (m[1] !== undefined) { r.significand = m[1]; r.intPart = Number(m[1]); r.empty = false; }
    if (m[2] !== undefined) { r.exponent = parseInt(m[2] || "0", 10) || 0; r.empty = false; }
    if (m[3] !== undefined) { r.prefixExp = prefixExp(m[3], n); r.empty = false; }
    return r;
  }
  const m = (n === "SI" ? SI_FLOAT : SPICE_FLOAT).exec(s); if (!m) return r; r.ok = true;
  const sig = /^(?:[+-]?\d+\.\d+|[+-]?\d+\.|[+-]?\d+|\.\d+|\.|-)/.exec(s);
  if (sig && (m[1] !== undefined || m[3] !== undefined || m[4] !== undefined || m[5] !== undefined || /^[.-]/.test(s))) {
    r.significand = sig[0]; r.empty = false;
    const ip = m[1] ?? m[3] ?? m[4]; if (ip !== undefined) r.intPart = Number(ip);
    const fp = m[2] ?? m[5]; if (fp !== undefined) r.fracPart = Number(fp);
  }
  if (m[6] !== undefined) { r.exponent = parseInt(m[6] || "0", 10) || 0; r.empty = false; }
  if (m[7] !== undefined) { r.prefixExp = prefixExp(m[7], n); r.empty = false; }
  return r;
}
/** SIM_VALUE_GRAMMAR::IsValid. */
export const isValidValue = (s: string, type: "FLOAT" | "INT" = "FLOAT", n: Notation = "SI"): boolean => parseValue(s, n, type).ok;
/** SIM_VALUE_PARSER::ExponentToUnitPrefix. */
function exponentToPrefix(e: number, n: Notation): [string, number] {
  if (n === "SI" && e >= -18 && e <= -15) return ["a", -18];
  if (e >= -15 && e < -12) return ["f", -15];
  if (e >= -12 && e < -9) return ["p", -12];
  if (e >= -9 && e < -6) return ["n", -9];
  if (e >= -6 && e < -3) return ["u", -6];
  if (e >= -3 && e < 0) return ["m", -3];
  if (e >= 0 && e < 3) return ["", 0];
  if (e >= 3 && e < 6) return ["k", 3];
  if (e >= 6 && e < 9) return [n === "SI" ? "M" : "Meg", 6];
  if (e >= 9 && e < 12) return ["G", 9];
  if (e >= 12 && e < 15) return ["T", 12];
  if (n === "SI" && e >= 15 && e < 18) return ["P", 15];
  if (n === "SI" && e >= 18 && e <= 21) return ["E", 18];
  return ["", 0];
}
/** fmt "{:g}" (printf %g, precision 6). */
export function fmtG(x: number): string {
  if (!isFinite(x)) return isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const e = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (e < -4 || e >= 6) {
    let [m, ex] = x.toExponential(5).split("e"); m = m.replace(/\.?0+$/, "");
    const n = Number(ex); return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  let s = x.toFixed(Math.max(0, 5 - e)); if (s.includes(".")) s = s.replace(/\.?0+$/, ""); return s;
}
const pow10 = (e: number): number => Number("1e" + e);
/** SIM_VALUE::ConvertNotation. */
export function convertNotation(s: string, from: Notation, to: Notation): string {
  const r = parseValue(s.replace(/,/g, "."), from);
  if (r.ok && !r.empty && r.significand) {
    let e = (r.exponent || 0) + (r.prefixExp || 0);
    const [prefix, red] = exponentToPrefix(e, to);
    const sig = parseFloat(r.significand) || 0;
    e -= red;
    return fmtG(sig * Math.pow(10, e)) + prefix;
  }
  return s;
}
const plainNumber = (s: string): boolean => /^[0-9.]*$/.test(s);
/** SIM_VALUE::ToSpice. */
export const toSpice = (s: string): string => (plainNumber(s) ? s : convertNotation(s, "SI", "SPICE"));
/** SIM_VALUE::ToDouble. */
export function toDouble(s: string, dflt = NaN): number {
  const r = parseValue(s, "SI");
  if (r.ok && !r.empty && r.significand) return (parseFloat(r.significand) || 0) * pow10((r.exponent || 0) + (r.prefixExp || 0));
  return dflt;
}
/** SIM_VALUE::Normalize. */
export function normalize(v: number): string {
  const [prefix, red] = exponentToPrefix(Math.log10(Math.abs(v)), "SI");
  return fmtG(v / Math.pow(10, red)) + prefix;
}

// ---------------------------------------------------------------- StrNumCmp (common/string_utils.cpp)
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
export function strNumCmp(a: string, b: string, ignoreCase = true): number {
  const s1 = Array.from(a), s2 = Array.from(b); let i = 0, j = 0;
  while (i < s1.length && j < s2.length) {
    let c1 = s1[i], c2 = s2[j];
    if (isDigit(c1) && isDigit(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (s1[i].charCodeAt(0) - 48); i++; } while (i < s1.length && isDigit(s1[i]));
      do { n2 = n2 * 10 + (s2[j].charCodeAt(0) - 48); j++; } while (j < s2.length && isDigit(s2[j]));
      if (n1 < n2) return -1; if (n1 > n2) return 1;
      c1 = i < s1.length ? s1[i] : "\0"; c2 = j < s2.length ? s2[j] : "\0";
    }
    if (ignoreCase) { if (c1 !== c2) { const u1 = c1.toUpperCase(), u2 = c2.toUpperCase(); if (u1 !== u2) return u1 < u2 ? -1 : 1; } }
    else { if (c1 < c2) return -1; if (c1 > c2) return 1; }
    if (i < s1.length) i++; if (j < s2.length) j++;
  }
  if (i >= s1.length && j < s2.length) return -1;
  if (i < s1.length && j >= s2.length) return 1;
  return 0;
}
/** std::sort over wxString (operator<: code-point order). */
export const byteSort = (a: string[]): string[] => a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

// ---------------------------------------------------------------- SIM_MODEL
export interface Param { info: ParamInfo; value: string }
export interface ModelPin { name: string; symbolPinNumber: string }
export class SimModel {
  type: string; cls: string; params: Param[] = []; pins: ModelPin[] = []; base: SimModel | null = null;
  storedInValue = false; enabled = true; spiceCode = ""; fallback = false; readError = "";
  constructor(type: string, cls?: string) { this.type = type; this.cls = cls || modelClass(type); }
  get deviceType(): string { return typeInfo(this.type).deviceType; }
  hasPrimaryValue(): boolean { const c = this.cls; return !this.fallback && (c === "ideal" || c === "r_pot" || (c === "source" && (this.type === "V" || this.type === "I"))); }
  hasAutofill(): boolean { return !this.fallback && this.cls === "source"; }
  pinNames(): string[] { return PIN_NAMES[this.type] || []; }
  addParam(info: ParamInfo): void { this.params.push({ info, value: info.enumValues.length >= 1 ? info.defaultValue : "" }); }
  /** GetParam: an empty override reads through to the base (library) model. */
  getParam(i: number): Param { const p = this.params[i]; if (this.base && p.value === "" && this.base.params[i]) return this.base.getParam(i); return p; }
  getParamOverride(i: number): Param { return this.params[i]; }
  findParamIndex(name: string): number {
    const l = name.toLowerCase();
    for (let i = 0; i < this.params.length; i++) if (this.getParam(i).info.name.toLowerCase() === l) return i;
    if (this.cls === "ngspice" || this.fallback) for (let i = 0; i < this.params.length; i++) { const n = this.getParam(i).info.name; if (n.endsWith("_") && n.toLowerCase() === l + "_") return i; }
    return -1;
  }
  findParam(name: string): Param | null { const i = this.findParamIndex(name); return i >= 0 ? this.getParam(i) : null; }
  setParamValue(idx: number | string, value: string, notation: Notation = "SI"): void {
    let i = idx as number;
    if (typeof idx === "string") { i = this.findParamIndex(idx); if (i < 0) throw new Error(`Unknown simulation model parameter '${idx}'`); }
    if (value.includes(",")) this.doSetParamValue(i, convertNotation(value, notation, "SI"));
    else if (notation !== "SI" && !plainNumber(value)) this.doSetParamValue(i, convertNotation(value, notation, "SI"));
    else this.doSetParamValue(i, value);
  }
  doSetParamValue(i: number, value: string): void {
    if (this.cls === "source" && !this.fallback) {
      // SIM_MODEL_SOURCE::doSetParamValue: preceding values are filled in; a nulled value empties itself
      if (!value) { this.params[i].value = ""; }
      else for (let k = 0; k < i; k++) if (this.getParam(k).value === "") {
        let dv = this.params[i].info.defaultValue; if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(dv)) dv = "0";
        this.params[i].value = dv; this.setParamValue(k, dv);
      }
    }
    this.params[i].value = value;
  }
  /** SIM_MODEL::createPins: model pin i takes symbol pin i (the symbol pins in StrNumCmp order). */
  createPins(symbolPins: string[]): void {
    const names = this.pinNames();
    names.forEach((n, i) => { const optional = n.startsWith("<") && n.endsWith(">"); if (i < symbolPins.length) this.pins.push({ name: n, symbolPinNumber: symbolPins[i] }); else if (!optional) this.pins.push({ name: n, symbolPinNumber: "" }); });
  }
  assignByIndex(i: number, symbolPin: string): void { if (i >= 0 && i < this.pins.length) this.pins[i].symbolPinNumber = symbolPin; }
  assignByName(modelPin: string, symbolPin: string): void {
    if (this.cls === "rawspice") {
      const idx = parseInt(modelPin, 10) || 0;
      if (idx > 0) { while (this.pins.length < idx) this.pins.push({ name: String(this.pins.length + 1), symbolPinNumber: "" }); this.pins[idx - 1].symbolPinNumber = symbolPin; }
      return;
    }
    const p = this.pins.find((x) => x.name === modelPin); if (p) { p.symbolPinNumber = symbolPin; return; }
    const idx = parseInt(modelPin, 10);
    if (!(idx >= 1 && idx <= this.pins.length)) {
      if (this.fallback) { this.pins.push({ name: modelPin, symbolPinNumber: symbolPin }); return; }
      throw new Error(`Unknown simulation model pin '${modelPin}'`);
    }
    this.pins[idx - 1].symbolPinNumber = symbolPin;
  }
  findModelPinIndex(symbolPin: string): number { return this.pins.findIndex((p) => p.symbolPinNumber === symbolPin); }
}

/** SIM_MODEL::Create( TYPE ): the model with its parameters at their defaults (enums) or empty. */
export function createModel(type: string): SimModel {
  const m = new SimModel(type);
  if (m.cls === "ngspice") {
    const mi = NG && NG[NGSPICE_MODEL_OF[type]]; if (!mi) return m;   // the tables are not loaded: pins only
    for (const t of mi.instanceParams) { const i = infoOf(t); if (i.category === "PRINCIPAL" || i.category === "GEOMETRY" || i.category === "FLAGS") m.addParam(i); }
    for (const t of mi.modelParams) m.addParam(infoOf(t));
  } else for (const t of PARAMS[type] || []) m.addParam(infoOf(t));
  return m;
}
function ngspicePins(type: string): string[] { return NG && NGSPICE_MODEL_OF[type] ? NG[NGSPICE_MODEL_OF[type]].pins : PIN_NAMES[type] || []; }
/** SIM_MODEL_SPICE_FALLBACK( type, code ): no parameters, the pins of the type it stands in for. */
export function createFallback(type: string, code = ""): SimModel {
  const m = new SimModel(type); m.fallback = true; m.spiceCode = code; m.pinNames = () => (m.cls === "ngspice" ? ngspicePins(type) : PIN_NAMES[type] || []);
  return m;
}
/** SIM_MODEL::Create( aBaseModel, pins, … ): a library model's instance, reading through to the base. */
export function createFromBase(base: SimModel | null, symbolPins: string[], rows?: FieldLike[]): SimModel {
  let m: SimModel;
  if (!base) { m = createFallback(rows ? readTypeFromFields(rows).type : "NONE"); }
  else {
    m = base.fallback ? createFallback(base.type) : base.cls === "rawspice" ? createModel("RAWSPICE") : createModel(base.type);
    m.base = base;
    if (m.cls === "subckt" && !m.fallback) { for (const p of base.pins) m.pins.push({ ...p }); for (const p of base.params) m.params.push({ info: p.info, value: "" }); }
  }
  try { readDataFields(m, rows || null, symbolPins); } catch (e) { m.readError = (e as Error).message; }
  return m;
}

// ---------------------------------------------------------------- fields
export interface FieldLike { name: string; value: string; show?: boolean }
export const getField = <R extends FieldLike>(rows: R[] | null, name: string): R | null => (rows ? rows.find((r) => r.name === name) || null : null);
export const getFieldValue = (rows: FieldLike[] | null, name: string): string => { const f = getField(rows, name); return f ? f.value : ""; };
/** SetFieldValue (sch_field.h): empty erases every field of that name; a new field is appended (USER, aIsVisible). */
export function setFieldValue<R extends FieldLike>(rows: R[], name: string, value: string, visible: boolean, mk: (name: string, value: string, visible: boolean) => R): void {
  if (value === "") { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].name === name) rows.splice(i, 1); return; }
  const f = getField(rows, name); if (f) { f.value = value; return; }
  rows.push(mk(name, value, visible));
}

/** SIM_MODEL::ReadTypeFromFields. */
export function readTypeFromFields(rows: FieldLike[]): { type: string; error?: string } {
  const dev = getFieldValue(rows, F.DEVICE), sub = getFieldValue(rows, F.TYPE);
  if (dev) for (const t of TYPE_IDS) { const ti = typeInfo(t); if (sub === ti.fieldValue && dev === deviceInfo(ti.deviceType).fieldValue) return { type: t }; }
  if (!sub) return { type: "NONE" };
  const ref = getFieldValue(rows, F.REFERENCE);
  return { type: "NONE", error: ref ? `No simulation model definition found for symbol '${ref}'.` : "No simulation model definition found." };
}

// ---------------------------------------------------------------- SIM_MODEL_SERIALIZER
const SEP = /\s/;
/** Sim.Pins: 'symbolPin=modelPin' pairs separated by whitespace (pinSequenceGrammar). */
export function parsePinsField(s: string): [string, string][] {
  const out: [string, string][] = []; const toks = s.split(/\s+/).filter(Boolean);
  for (const t of toks) { const eq = t.indexOf("="); if (eq <= 0 || eq === t.length - 1) throw new Error(`Sim.Pins field: expected '='`); out.push([t.slice(0, eq), t.slice(eq + 1)]); }
  return out;
}
export function parsePins(m: SimModel, s: string): void { if (s === "") return; for (const [sym, mp] of parsePinsField(s)) m.assignByName(mp, sym); }
/** Sim.Params: name=value pairs (fieldParamValuePairsGrammar), values optionally quoted with \" and \\ escapes. */
export function parseParamsField(s: string): { name: string; value: string; flag?: boolean }[] {
  const out: { name: string; value: string; flag?: boolean }[] = []; let i = 0; const n = s.length;
  const skip = () => { while (i < n && SEP.test(s[i])) i++; };
  skip();
  while (i < n) {
    const flag = /^(off|thermal|xpart)(?![A-Za-z0-9])/i.exec(s.slice(i));
    if (flag) { out.push({ name: flag[1], value: "1", flag: true }); i += flag[1].length; }
    else {
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)); if (!id) throw new Error("Sim.Params field: expected parameter=value pairs");
      i += id[0].length; skip(); if (s[i] !== "=") throw new Error("Sim.Params field: expected '='"); i++; skip();
      let v = "";
      if (s[i] === '"') {
        i++; while (i < n && s[i] !== '"') { if (s[i] === "\\" && i + 1 < n && (s[i + 1] === '"' || s[i + 1] === "\\")) { v += s[i + 1]; i += 2; } else v += s[i++]; }
        if (s[i] !== '"') throw new Error("Sim.Params field: expected quoted or unquoted string"); i++;
      } else { while (i < n && !SEP.test(s[i])) v += s[i++]; if (!v) throw new Error("Sim.Params field: expected quoted or unquoted string"); }
      out.push({ name: id[0], value: v });
    }
    const before = i; skip(); if (i < n && i === before) throw new Error("Sim.Params field: expected end of string");
  }
  return out;
}
/** ParseParams: true when the primary value came from the field (else Value is read with ParseValue). */
export function parseParams(m: SimModel, s: string): boolean {
  let primary = false;
  for (const p of parseParamsField(s)) {
    m.setParamValue(p.name, p.value, "SI");
    if (!p.flag && m.params.length && m.getParam(0).info.name.toLowerCase() === p.name.toLowerCase()) primary = true;
  }
  return !m.hasPrimaryValue() || m.hasAutofill() || primary;
}
/** ParseValue (fieldInferValueGrammar): a bare 'R'/'C'/'L'/'V'/'I' or an SI number becomes param 0. */
export function parseValueField(m: SimModel, v: string): void {
  const t = v.trim();
  if (!/^[RCLVI]$/.test(t)) { const r = parseValue(t, "SI"); if (!r.ok) throw new Error("Value field: expected 'R', 'C', 'L', 'V', 'I' or a number"); if (t !== "") m.setParamValue(0, t); }
  m.storedInValue = m.hasPrimaryValue() ? true : m.storedInValue;
}
/** SIM_MODEL::ReadDataFields. */
export function readDataFields(m: SimModel, rows: FieldLike[] | null, symbolPins: string[]): void {
  const en = getFieldValue(rows, F.ENABLE); if (en && /^[nf0]/i.test(en)) m.enabled = false;
  m.createPins(symbolPins);
  parsePins(m, getFieldValue(rows, F.PINS));
  if (!parseParams(m, getFieldValue(rows, F.PARAMS))) parseValueField(m, getFieldValue(rows, F.VALUE));
}
/** SIM_MODEL::Create( fields, … , aAllowRawFallback ). */
export function createFromFields(rows: FieldLike[], symbolPins: string[]): { model: SimModel; error?: string } {
  const t = readTypeFromFields(rows); let m = createModel(t.type);
  try { readDataFields(m, rows, symbolPins); }
  catch (e) {
    let code = getFieldValue(rows, F.PARAMS); if (!code) code = getFieldValue(rows, F.VALUE);
    m = createModel("RAWSPICE"); m.setParamValue("model", code); m.spiceCode = code;
    try { m.createPins(symbolPins); parsePins(m, getFieldValue(rows, F.PINS)); }
    catch (e2) { return { model: m, error: `Error reading simulation model from symbol '${getFieldValue(rows, F.REFERENCE)}':\n${(e2 as Error).message}` }; }
  }
  return { model: m, error: t.error };
}
function paramValuePair(p: Param): string {
  let name = p.info.name; if (name.endsWith("_")) name = name.slice(0, -1);
  let v = p.value;
  if (p.info.category === "FLAGS") return v === "1" ? name : "";
  if (v === "" || v.includes(" ") || v.includes('"') || v.includes("\\")) v = '"' + v.replace(/[\\"]/g, (c) => "\\" + c) + '"';
  return `${name}=${v}`;
}
export const generateDevice = (m: SimModel): string => deviceInfo(m.deviceType).fieldValue;
export const generateDeviceSubtype = (m: SimModel): string => typeInfo(m.type).fieldValue;
export const generateEnable = (m: SimModel): string => (m.enabled ? "" : "0");
export function generateValue(m: SimModel): string { const v = m.params.length ? m.getParamOverride(0).value : ""; return v === "" ? deviceInfo(m.deviceType).fieldValue : v; }
export function generateParams(m: SimModel): string {
  const out: string[] = [];
  for (let i = 0; i < m.params.length; i++) {
    if (i === 0 && m.storedInValue) continue;
    const p = m.getParamOverride(i);
    if (p.value === "" && !(i === 0 && m.hasPrimaryValue() && !m.storedInValue)) continue;
    if (m.base && m.base.getParam(i) && m.base.getParam(i).value === p.value) continue;
    if (p.info.enumValues.length >= 1 && p.value === p.info.defaultValue) continue;
    const pair = paramValuePair(p); if (pair) out.push(pair);
  }
  return out.join(" ");
}
export function generatePins(m: SimModel): string {
  return m.pins.slice().sort((a, b) => strNumCmp(a.symbolPinNumber, b.symbolPinNumber)).filter((p) => p.symbolPinNumber !== "").map((p) => `${p.symbolPinNumber}=${p.name}`).join(" ");
}
/** SIM_MODEL::WriteFields: duplicates dropped, then Device / Type / Enable / Pins / Params (+ Value when stored there). */
export function writeFields<R extends FieldLike>(m: SimModel, rows: R[], mk: (name: string, value: string, visible: boolean) => R): void {
  for (let ii = rows.length - 1; ii > 0; ii--) { const name = rows[ii].name; for (let k = 0; k < ii - 1; k++) if (rows[k].name === name) { rows.splice(ii, 1); break; } }
  setFieldValue(rows, F.DEVICE, generateDevice(m), false, mk);
  setFieldValue(rows, F.TYPE, generateDeviceSubtype(m), false, mk);
  setFieldValue(rows, F.ENABLE, generateEnable(m), false, mk);
  setFieldValue(rows, F.PINS, generatePins(m), false, mk);
  setFieldValue(rows, F.PARAMS, generateParams(m), false, mk);
  if (m.storedInValue) setFieldValue(rows, F.VALUE, generateValue(m), false, mk);
}

// ---------------------------------------------------------------- SIM_MODEL::InferSimModel
export interface Inferred { ok: boolean; deviceType: string; modelType: string; params: string; pinMap: string }
const SI_EXP = "([fFpPnNuUmMkKgGtTμµ𝛍𝜇𝝁 ]|M(?:e|E)(?:g|G))?";
const IDEAL_RE = new RegExp("^([0-9,. ]+)" + SI_EXP + "([fFhHΩΩ𝛀𝛺𝝮rR]|ohm)?([-1-9 ]*)([fFhHΩΩ𝛀𝛺𝝮rR]|ohm)?$", "u");
const SOURCE_RE = new RegExp("^([0-9,. ]+)" + SI_EXP + "([vVaA])?([-1-9 ]*)([vVaA])?$", "u");
function convertSeparators(mant: string): string | null {
  mant = mant.replace(/ /g, "");
  let amb = "?", thou = "?", thouFound = false, dec = "?", decFound = false, digits = 0;
  for (let ii = mant.length - 1; ii >= 0; --ii) {
    const c = mant[ii];
    if (c >= "0" && c <= "9") digits += 1;
    else if (c === "." || c === ",") {
      if (dec !== "?" || thou !== "?") {
        if (c === dec) { if (thouFound) return null; if (decFound) return null; decFound = true; }
        else if (c === thou) { if (digits !== 3) return null; thouFound = true; }
      } else if (amb !== "?") {
        if (c === amb) { thou = amb; thouFound = true; dec = c === "." ? "," : "."; }
        else { dec = amb; decFound = true; thou = c; thouFound = true; }
      } else if ((ii === 1 && mant[0] === "0") || digits !== 3) { dec = c; decFound = true; thou = c === "." ? "," : "."; }
      else amb = c;
      digits = 0;
    } else digits = 0;
  }
  if (dec === "?" && thou === "?") { dec = "."; thou = ","; }
  return mant.split(thou).join("").split(dec).join(".");
}
function convertUnits(u: string, n: Notation): string {
  if (u === "µ" || u === "μ") return "u";
  if (n === "SPICE") { if (u === "M") return "Meg"; } else if (u.length === 3 && u[0].toUpperCase() + u.slice(1).toLowerCase() === "Meg") return "M";
  return u;
}
export function inferSimModel(prefix: string, pins: string[], rows: FieldLike[], notation: Notation = "SI"): Inferred {
  const library = getFieldValue(rows, F.LIBRARY), modelName = getFieldValue(rows, F.NAME); let value = getFieldValue(rows, F.VALUE);
  const r: Inferred = { ok: false, deviceType: getFieldValue(rows, F.DEVICE), modelType: getFieldValue(rows, F.TYPE), params: getFieldValue(rows, F.PARAMS), pinMap: getFieldValue(rows, F.PINS) };
  if (pins.length !== 2) return r;
  const p1 = prefix.slice(0, 1);
  if (((r.deviceType === "R" || r.deviceType === "L" || r.deviceType === "C") && !r.modelType)
      || (!library && !modelName && !r.deviceType && !r.modelType && value && /^[RLC]/.test(prefix))) {
    if (!r.params) {
      const m = IDEAL_RE.exec(value);
      if (m) {
        const mant = convertSeparators(m[1]); if (mant === null) return r;
        const exp = m[2] || "", frac = m[4] || "";
        r.params = mant.includes(".") || !frac ? `${p1.toLowerCase()}="${mant}${convertUnits(exp, notation)}"` : `${p1.toLowerCase()}="${mant}.${frac}${convertUnits(exp, notation)}"`;
      } else { r.modelType = "="; r.params = `${p1.toLowerCase()}="${value}"`; }
    }
    if (!r.deviceType) r.deviceType = p1;
    if (!r.pinMap) r.pinMap = `${pins[0]}=+ ${pins[1]}=-`;
    r.ok = true; return r;
  }
  if (((r.deviceType === "V" || r.deviceType === "I") && (!r.modelType || r.modelType === "DC"))
      || (!r.deviceType && !r.modelType && value && /^[VI]/.test(prefix))) {
    if (value) {
      let param = "dc";
      if (value.startsWith("DC ")) value = value.slice(3);
      else if (value.startsWith("AC ")) { value = value.slice(3); param = "ac"; }
      const m = SOURCE_RE.exec(value);
      if (m) {
        const mant = convertSeparators(m[1]); if (mant === null) return r;
        const exp = m[2] || "", frac = m[4] || "";
        r.params = mant.includes(".") || !frac ? `${param}="${mant}${convertUnits(exp, notation)}" ${r.params}` : `${param}="${mant}.${frac}${convertUnits(exp, notation)}" ${r.params}`;
      } else r.params = `${param}="${value}" ${r.params}`;
    }
    if (!r.deviceType) r.deviceType = p1;
    if (!r.modelType) r.modelType = "DC";
    if (!r.pinMap) r.pinMap = `${pins[0]}=+ ${pins[1]}=-`;
    r.ok = true; return r;
  }
  return r;
}

// ---------------------------------------------------------------- SIM_DECOMPOSITION (sim_model_multiunit.cpp)
export function parseDecomposition(s: string): { repeat: boolean; shared: string[] } {
  let repeat = false; const shared: string[] = [];
  for (const t of s.split(/[ \t\r\n]+/).filter(Boolean)) {
    if (t.startsWith("mode=")) { if (t.slice(5).toLowerCase() === "repeat") repeat = true; }
    else if (t.startsWith("shared=")) shared.push(...t.slice(7).split(",").filter(Boolean));
  }
  return repeat ? { repeat, shared } : { repeat: false, shared: [] };
}
export const formatDecomposition = (repeat: boolean, shared: string[]): string => (!repeat ? "" : "mode=repeat" + (shared.length ? " shared=" + shared.join(",") : ""));

// ---------------------------------------------------------------- SPICE_GENERATOR::Preview
export interface SpiceItem { refName: string; modelName: string; baseModelName: string }
function modelLine(m: SimModel, item: SpiceItem): string {
  const c = m.cls;
  if (!m.fallback && (c === "ideal" || c === "source" || c === "behavioral" || c === "rawspice" || c === "subckt")) return "";
  if (!m.fallback && c === "tline") {
    let r = "0", l = "0", g = "0", cc = "0", len = "1";
    if (m.type === "TLINE_Z0") {
      const z0 = toDouble(m.findParam("z0")!.value), td = toDouble(m.findParam("td")!.value);
      if (isNaN(z0) || isNaN(td)) return `.model ${item.modelName} LTRA()\n`;
      l = fmtG(td * z0); cc = fmtG(td / z0);
    } else { const v = (n: string, d: string) => { const p = m.findParam(n); return p ? toSpice(p.value) : d; }; r = v("r", r); l = v("l", l); g = v("g", g); cc = v("c", cc); len = v("len", len); }
    return `.model ${item.modelName} LTRA( r=${r} l=${l} g=${g} c=${cc} len=${len} )\n`;
  }
  if (!m.fallback && c === "r_pot") {
    const rp = m.findParam("r"), pp = m.findParam("pos"); const r = rp ? toSpice(rp.value) : "0", pos = pp ? toSpice(pp.value) : "";
    return pos ? `.model ${item.modelName} potentiometer( r=${r} position=${pos} )\n` : `.model ${item.modelName} potentiometer( r=${r} )\n`;
  }
  // SIM_MODEL::requiresSpiceModelLine
  if (m.type === "SUBCKT") return "";
  if (m.base && item.baseModelName !== "") {
    let need = false;
    for (let i = 0; i < m.params.length && !need; i++) { const p = m.params[i]; if (p.info.isSpiceInstanceParam || p.value === "") continue; if (p.value !== m.base.params[i]?.value && p.value !== normalize(toDouble(m.base.params[i]?.value || ""))) need = true; }
    if (!need) return "";
  }
  const si = spiceInfo(m.type);
  let out = `.model ${item.modelName} `; const indent = out.length;
  out += si.modelType;
  if (!si.isDefaultLevel && si.level) out += ` level=${si.level}`;
  if (si.version) out += ` version=${si.version}`;
  out += "\n";
  for (let i = 0; i < m.params.length; i++) {
    const p = m.getParam(i); if (p.info.isSpiceInstanceParam) continue;
    const name = p.info.spiceModelName || (p.info.name.endsWith("_") ? p.info.name.slice(0, -1) : p.info.name);
    const value = toSpice(p.value); if (value === "") continue;
    if (p.info.category === "FLAGS") { if (value === "1") out += `+${name}\n`; }
    else out += `+${" ".repeat(indent - 1)}${name}=${value}\n`;
  }
  if (out.length === indent + 1) return "";
  return out;
}
function itemName(m: SimModel, item: SpiceItem): string {
  const t = m.cls === "rawspice" ? m.getParam(0).value : spiceInfo(m.type).itemType;
  return item.refName !== "" && item.refName.startsWith(t) ? item.refName : t + item.refName;
}
function itemPins(m: SimModel, item: SpiceItem): string {
  // the dialog's SPICE_ITEM carries no pin numbers, so every model pin is printed as NC-<ref>-<n>
  let out = "", nc = 0;
  for (let i = 0; i < m.pins.length; i++) out += ` NC-${item.refName}-${nc++}`;
  return out;
}
function itemParams(m: SimModel): string {
  let out = "";
  for (let i = 0; i < m.params.length; i++) {
    const p = m.getParam(i); if (!p.info.isSpiceInstanceParam) continue;
    if (m.cls === "rawspice") { if (p.info.name === "model") out += " " + toSpice(p.value); continue; }
    if (m.cls === "l_mutual") { out += " " + toSpice(p.value); continue; }
    if (m.cls === "switch") { if (p.value !== "none") out += " " + p.value; continue; }
    const name = p.info.spiceInstanceName || p.info.name, value = toSpice(p.value);
    if (p.info.category === "FLAGS") { if (value === "1") out += ` ${name}`; } else if (value !== "") out += ` ${name}=${value}`;
  }
  return out;
}
function baseItemLine(m: SimModel, item: SpiceItem): string { return itemName(m, item) + itemPins(m, item) + (m.cls === "rawspice" ? "" : ` ${item.modelName}`) + itemParams(m) + "\n"; }
function sourceParamString(m: SimModel, n: string, d: string): string { const p = m.findParam(n); const r = p ? toSpice(p.value) : ""; return r === "" ? d : r; }
function itemLine(m: SimModel, item: SpiceItem): string {
  const c = m.fallback ? "spice" : m.cls;
  if (c === "ideal") { const mn = toSpice(m.getParam(0).value); return mn !== "" ? baseItemLine(m, { ...item, modelName: mn }) : ""; }
  if (c === "behavioral") {
    const v = toSpice(m.getParam(0).value);
    return baseItemLine(m, { ...item, modelName: m.type === "V_BEHAVIORAL" ? `V=${v}` : m.type === "I_BEHAVIORAL" ? `I=${v}` : v });
  }
  if (c === "switch" && m.type === "SW_I") return "";
  if (c === "source") {
    const acP = m.findParam("ac"), dcP = m.findParam("dc"); const ac = acP ? toSpice(acP.value) : "", dc = dcP ? toSpice(dcP.value) : "";
    let empty = true, mn = "";
    if (dc !== "") { empty = false; mn += `DC ${dc} `; }
    const si = spiceInfo(m.type);
    if (si.functionName !== "" && m.type !== "V" && m.type !== "I") {
      let args = ""; const g = (n: string, d: string) => sourceParamString(m, n, d) + " ";
      const k = m.type.slice(2);
      if (k === "PWL") args = formatPwl(m.getParam(0).value);
      else if (k === "WHITENOISE") args = g("rms", "0") + g("dt", "0") + "0 0 0 0 0 ";
      else if (k === "PINKNOISE") args = "0 " + g("dt", "0") + g("slope", "0") + g("rms", "0") + "0 0 0 ";
      else if (k === "BURSTNOISE") args = "0 0 0 0 " + g("ampl", "0") + g("tcapt", "0") + g("temit", "0");
      else if (k === "RANDUNIFORM") args = "1 " + g("ts", "0") + g("td", "0") + g("range", "1") + g("offset", "0");
      else if (k === "RANDGAUSSIAN") args = "2 " + g("ts", "0") + g("td", "0") + g("stddev", "1") + g("mean", "0");
      else if (k === "RANDEXP") args = "3 " + g("ts", "0") + g("td", "0") + g("mean", "1") + g("offset", "0");
      else if (k === "RANDPOISSON") args = "4 " + g("ts", "0") + g("td", "0") + g("lambda", "1") + g("offset", "0");
      else {
        for (let i = 0; i < m.params.length; i++) { const p = m.getParam(i); const nm = p.info.name.toLowerCase(); if (ac !== "" && (nm === "ac" || nm === "ph")) continue; const a = toSpice(p.value); if (a !== "") args += a + " "; }
        if (k === "PULSE") { const per = m.findParam("per"), np = m.findParam("np"); if (!(per && toSpice(per.value) !== "") && !(np && toSpice(np.value) !== "")) args += "0 1 "; }
      }
      empty = false; mn += `${si.functionName}( ${args}) `;
    } else if (m.type === "V_VCL" || m.type === "I_VCL") { mn += `${sourceParamString(m, "gain", "1.0")} `; empty = false; }
    else if (m.type === "V_CCL" || m.type === "I_CCL") { mn += `${sourceParamString(m, "control", "V?")} ${sourceParamString(m, "gain", "1.0")} `; empty = false; }
    if (ac !== "") { const ph = m.findParam("ph"); empty = false; mn += `AC ${ac} ${ph ? toSpice(ph.value) : ""} `; }
    const pn = m.findParam("portnum"); const portnum = pn ? toSpice(pn.value) : "";
    if (portnum !== "") { mn += `portnum ${portnum} `; const z = m.findParam("z0"); const z0 = z ? toSpice(z.value) : ""; if (z0 !== "") mn += `z0 ${z0} `; }
    if (empty) mn = toSpice(m.getParam(0).value);
    return baseItemLine(m, { ...item, modelName: mn });
  }
  return baseItemLine(m, item);
}
/** SPICE_GENERATOR_SOURCE::formatPwlValues: the time/value pairs, numbers to SPICE notation. */
function formatPwl(v: string): string {
  let out = "";
  for (const tok of v.split(/[\s,()]+/).filter(Boolean)) out += (/^\{.*\}$/.test(tok) ? tok : toSpice(tok)) + " ";
  return out;
}
/** SPICE_GENERATOR::Preview (and the SPICE_GENERATOR_SPICE / _RAW_SPICE overrides). */
export function preview(m: SimModel, item: SpiceItem): string {
  if (!m.fallback && m.cls === "rawspice") return itemParams(m).trim();
  const spiceLike = m.fallback || m.cls === "ngspice" || m.cls === "subckt";
  if (spiceLike) {
    let code = m.fallback ? "" : modelLine(m, item);
    if (code === "") code = m.spiceCode;
    if (code === "" && m.base) code = m.base.spiceCode;
    const il = itemLine(m, { ...item, refName: "" });
    if (code !== "" && il !== "") code += "\n\n";
    return (code + il).trim();
  }
  let code = modelLine(m, item); const il = itemLine(m, item);
  if (code !== "") code += "\n";
  return (code + il).trim();
}

// ---------------------------------------------------------------- SPICE library (.lib / .sub / .cir / .mod)
export interface LibModel { name: string; model: SimModel; code: string }
export interface SpiceLibrary { models: LibModel[]; errors: string[] }
interface Unit { kind: "model" | "subckt"; name: string; code: string; head: string[]; body: string[] }
/** Logical lines: '*' comment lines dropped, ';' '$' '//' tail comments cut, '+' and '\\' continuations joined. */
function logicalLines(text: string): { text: string; raw: string }[] {
  const phys = text.replace(/\r\n?/g, "\n").split("\n"); const out: { text: string; raw: string }[] = [];
  const cut = (l: string) => { const m = /(;|\$|\/\/)/.exec(l); return m ? l.slice(0, m.index) : l; };
  for (let i = 0; i < phys.length; i++) {
    const l = phys[i];
    if (/^[\s,=()]*\*/.test(l)) { out.push({ text: "", raw: l }); continue; }
    let t = cut(l);
    if (/^\s*\+/.test(t) && out.length) { let k = out.length - 1; while (k > 0 && out[k].text === "" && /^[\s,=()]*\*/.test(out[k].raw)) k--; out[k].text += " " + t.replace(/^\s*\+/, ""); out[k].raw += "\n" + l; continue; }
    while (/\\\\\s*$/.test(t) && i + 1 < phys.length) { t = t.replace(/\\\\\s*$/, " ") + cut(phys[++i]); }
    out.push({ text: t, raw: l });
  }
  return out;
}
function tokens(s: string): string[] {
  const out: string[] = []; const re = /\{[^}]*\}|\[[^\]]*\]|[^\s=(),]+/g; let m;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}
function splitUnits(text: string): Unit[] {
  const lines = logicalLines(text); const units: Unit[] = []; let comments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], t = L.text.trim();
    if (!t) { if (L.raw.trim()) comments.push(L.raw); else comments = []; continue; }
    const low = t.toLowerCase();
    if (low.startsWith(".model")) {
      const tk = tokens(t.slice(6)); if (!tk.length) { comments = []; continue; }
      units.push({ kind: "model", name: tk[0], code: [...comments, L.raw].join("\n"), head: tk, body: [] }); comments = [];
    } else if (low.startsWith(".subckt")) {
      const raw = [...comments, L.raw]; comments = []; let depth = 1; const body: string[] = []; let j = i + 1;
      for (; j < lines.length; j++) {
        const lt = lines[j].text.trim().toLowerCase(); raw.push(lines[j].raw);
        if (lt.startsWith(".subckt")) depth++;
        if (lt.startsWith(".ends")) { depth--; if (!depth) break; }
        body.push(lines[j].text);
      }
      i = j;
      units.push({ kind: "subckt", name: tokens(t.slice(7))[0] || "", code: raw.join("\n"), head: [t], body });
    } else comments = [];
  }
  return units;
}
/** SPICE_MODEL_PARSER::ReadTypeFromSpiceStrings. */
export function typeFromSpiceStrings(typeString: string, level = "", version = "", skipDefaultLevel = true): string {
  const inLevel = level.split(".")[0]; const it = typeString.toUpperCase(); let vdmos = false, pchan = false;
  if (it.startsWith("VDMOS")) { vdmos = true; pchan = it.includes("PCHAN"); }
  for (const t of TYPE_IDS) {
    const si = spiceInfo(t); const ct = si.modelType; if (!ct) continue;
    if (ct.startsWith("VDMOS") && vdmos) { if (pchan && ct.endsWith("PCHAN")) return t; if (!pchan && ct.endsWith("NCHAN")) return t; }
    else if (it.startsWith(ct)) {
      if (si.version !== version) continue;
      if (si.level === inLevel) return t;
      if (skipDefaultLevel) continue;
      if (si.isDefaultLevel && level === "") return t;
    }
  }
  return "RAWSPICE";
}
function canSilentlyIgnore(m: SimModel, n: string): boolean {
  const l = n.toLowerCase();
  if (l === "mfg" || l === "type") return true;
  if (m.deviceType === "D" && ["perim", "isw", "ns", "rsw", "cjsw", "vjsw", "mjsw", "fcs"].includes(l)) return true;
  if ((m.deviceType === "NPN" || m.deviceType === "PNP") && (l === "icrating" || l === "vceo")) return true;
  if ((m.type === "NPN_GUMMELPOON" || m.type === "PNP_GUMMELPOON") && ["bvcbo", "nbvcbo", "tbvcbo1", "tbvcbo2", "bvbe", "ibvbe", "nbvbe"].includes(l)) return true;
  if ((m.type === "NMOS_VDMOS" || m.type === "PMOS_VDMOS") && ["vds", "ron", "qg"].includes(l)) return true;
  return false;
}
/** SIM_MODEL_NGSPICE::SetParamFromSpiceCode. */
function setFromSpice(m: SimModel, name: string, value: string): void {
  const l = name.toLowerCase(); if (l === "level" || l === "version") return;
  const usable = (i: number) => !m.params[i].info.isSpiceInstanceParam && m.params[i].info.category !== "SUPERFLUOUS";
  for (let i = 0; i < m.params.length; i++) if (usable(i) && m.params[i].info.name.toLowerCase() === l) { m.setParamValue(i, value, "SPICE"); return; }
  for (let i = 0; i < m.params.length; i++) if (usable(i) && m.params[i].info.name.endsWith("_") && m.params[i].info.name.toLowerCase() === l + "_") { m.setParamValue(i, value, "SPICE"); return; }
  const mi = NG && NG[NGSPICE_MODEL_OF[m.type]];
  if (mi) for (const t of mi.modelParams) if (String(t[0]).toLowerCase() === l) {
    for (let i = 0; i < m.params.length; i++) if (m.params[i].info.category !== "SUPERFLUOUS" && m.params[i].info.id === t[1]) { m.setParamValue(i, value, "SPICE"); return; }
    break;
  }
  if (!canSilentlyIgnore(m, name)) throw new Error(`Unknown simulation model parameter '${name}'`);
}
function paramPairs(toks: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < toks.length; i++) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(toks[i])) { out.push([toks[i], toks[i + 1]]); i++; }
  return out;
}
/** SIM_LIBRARY_SPICE: every .model and .subckt of the file, in file order (SIM_MODEL_SPICE::Create per unit). */
export function parseSpiceLibrary(text: string): SpiceLibrary {
  const lib: SpiceLibrary = { models: [], errors: [] };
  const units = splitUnits(text);
  const make = (u: Unit): SimModel => {
    if (u.kind === "subckt") {
      const m = new SimModel("SUBCKT", "subckt"); m.spiceCode = u.code;
      const t = u.head[0].replace(/^\s*\.subckt\s+/i, ""); const m1 = /^(\S+)\s*(.*)$/.exec(t) || ["", "", ""];
      let rest = m1[2]; let params = "";
      const pm = /(?:^|\s)params:\s*(.*)$/i.exec(rest); if (pm) { params = pm[1]; rest = rest.slice(0, pm.index); }
      else { const firstEq = /(\s|^)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(rest); if (firstEq) { params = rest.slice(firstEq.index); rest = rest.slice(0, firstEq.index); } }
      rest.split(/\s+/).filter(Boolean).forEach((p) => m.pins.push({ name: p, symbolPinNumber: String(m.pins.length + 1) }));
      for (const [n, v] of paramPairs(tokens(params))) { const info = newInfo({ name: n, isInstanceParam: true, isSpiceInstanceParam: true, defaultValue: v }); m.params.push({ info, value: "" }); }
      return m;
    }
    const tk = u.head; const name = tk[0];
    if (tk[1] && tk[1].toLowerCase() === "ako:") {
      const parent = lib.models.find((x) => x.name.toLowerCase() === (tk[2] || "").toLowerCase());
      if (!parent) throw new Error(`Could not find parent model '${tk[2] || ""}' for "A Kind Of" model '${name}'`);
      const m = createModel(parent.model.type); m.spiceCode = u.code;
      for (let i = 0; i < m.params.length; i++) m.setParamValue(i, parent.model.getParam(i).value);
      for (const [n, v] of paramPairs(tk.slice(4))) setFromSpice(m, n, v);
      return m;
    }
    let typeStr = tk[1] || ""; let rest = tk.slice(2);
    if (/^vdmos$/i.test(typeStr) && rest[0] && /^[np]chan$/i.test(rest[0])) { typeStr += " " + rest[0]; rest = rest.slice(1); }
    if (/^cpl$/i.test(typeStr)) { const f = createFallback("RAWSPICE", u.code); return f; }
    let type = typeFromSpiceStrings(typeStr);
    if (type === "RAWSPICE") { const pp = paramPairs(rest); const lv = pp.find((p) => p[0].toLowerCase() === "level"), vr = pp.find((p) => p[0].toLowerCase() === "version"); type = typeFromSpiceStrings(typeStr, lv ? lv[1] : "", vr ? vr[1] : "", false); }
    if (modelClass(type) !== "ngspice") return createFallback(type, u.code);
    const m = createModel(type); m.spiceCode = u.code;
    try { for (const [n, v] of paramPairs(rest)) setFromSpice(m, n, v); } catch (e) { return createFallback(type, u.code); }
    return m;
  };
  for (const u of units) {
    try { lib.models.push({ name: u.name, model: make(u), code: u.code }); }
    catch (e) { lib.errors.push((e as Error).message); }
  }
  return lib;
}

// ---------------------------------------------------------------- DIALOG_SYMBOL_PROPERTIES::OnEditSpiceModel
/** Edited fields merged back into the parent grid by name: SetText on existing rows, new rows appended, missing rows removed. */
export function mergeEditedFields<R extends FieldLike>(existing: R[], edited: R[]): R[] {
  const out = existing.slice();
  for (const e of edited) { const f = out.find((x) => x.name === e.name); if (f) f.value = e.value; else out.push(e); }
  for (let i = out.length - 1; i >= 0; i--) if (!edited.some((e) => e.name === out[i].name)) out.splice(i, 1);
  return out;
}

// ---------------------------------------------------------------- the dialog's state (DIALOG_SIM_MODEL<T>)
export interface SymbolPin { number: string; name: string }
export interface SessionCtx { prefix: string; pins: SymbolPin[]; unitCount: number }
export type MkRow<R> = (name: string, value: string, visible: boolean) => R;
/** One run of the dialog over a copy of the symbol's fields: TransferDataToWindow … TransferDataFromWindow. */
export class SimSession<R extends FieldLike> {
  fields: R[]; ctx: SessionCtx; mk: MkRow<R>; pins: SymbolPin[]; pinNumbers: string[];
  source: "library" | "builtin" | null = null;
  curType = "NONE"; curTypeOfDevice = new Map<string, string>();
  builtin = new Map<string, SimModel>(); private fieldsType: string | null = null;
  library: { path: string; lib: SpiceLibrary } | null = null; libModels = new Map<string, SimModel>(); libraryPath = ""; modelName = ""; unknownModel = false;
  storeInValue = false; inferredRestore = ""; inferredOverwritten = false; messages: string[] = [];
  decompositionRepeat = false; sharedPins = "";
  constructor(rows: R[], ctx: SessionCtx, mk: MkRow<R>, clone: (r: R) => R) {
    this.fields = rows.map(clone); this.ctx = ctx; this.mk = mk;
    this.pins = ctx.pins.slice().sort((a, b) => strNumCmp(a.number, b.number));
    this.pinNumbers = this.pins.map((p) => p.number);
  }
  /** TransferDataToWindow, before any library is read: inference, then the source and type from the fields. */
  begin(): { libraryPath: string } {
    const inf = inferSimModel(this.ctx.prefix, byteSort(this.pinNumbers), this.fields);
    if (inf.ok) {
      setFieldValue(this.fields, F.DEVICE, inf.deviceType, true, this.mk);
      if (inf.modelType) setFieldValue(this.fields, F.TYPE, inf.modelType, true, this.mk);
      setFieldValue(this.fields, F.PARAMS, inf.params, true, this.mk);
      setFieldValue(this.fields, F.PINS, inf.pinMap, true, this.mk);
      this.storeInValue = true;
      const v = getField(this.fields, F.VALUE); this.inferredRestore = v ? v.value : ""; this.inferredOverwritten = true; if (v) v.value = "${SIM.PARAMS}";
    }
    const lp = getFieldValue(this.fields, F.LIBRARY);
    if (lp.replace(/^.*[\\/]/, "")) { this.source = "library"; return { libraryPath: lp }; }
    if (getFieldValue(this.fields, F.DEVICE) || getFieldValue(this.fields, F.TYPE)) {
      this.source = "builtin"; const t = readTypeFromFields(this.fields); this.curType = t.type; if (t.error) this.messages.push(t.error); this.fieldsType = t.type;
    }
    return { libraryPath: "" };
  }
  /** The rest of TransferDataToWindow once the library text (or null when unreadable) is in hand. */
  finishBegin(libText: string | null): void {
    if (this.source === "library") {
      const lp = getFieldValue(this.fields, F.LIBRARY);
      if (libText === null || !this.loadLibrary(lp, libText)) {
        this.libraryPath = lp;
        this.curType = readTypeFromFields(this.fields).type;
        this.library = null; this.unknownModel = true;
        this.libModels.set("<unknown>", createFromBase(null, this.pinNumbers, this.fields)); this.modelName = "<unknown>";
      } else {
        const mn = getFieldValue(this.fields, F.NAME); const names = this.modelNames();
        if (!names.includes(mn)) { this.messages.push(`No model named '${mn}' in library.`); if (names.length) this.modelName = names[0]; }
        else this.modelName = mn;
        this.curType = this.curModel().type;
      }
    }
    for (const t of TYPE_IDS) { const d = typeInfo(t).deviceType; if (!this.curTypeOfDevice.has(d)) this.curTypeOfDevice.set(d, t); }
    if (this.storeInValue) { const m = this.curModel(); if (m.hasPrimaryValue()) m.storedInValue = true; }
    this.storeInValue = this.curModel().storedInValue;
    const dec = parseDecomposition(getFieldValue(this.fields, F.DECOMPOSITION)); this.decompositionRepeat = dec.repeat; this.sharedPins = dec.shared.join(", ");
  }
  /** loadLibrary: the library's models, the one named in Sim.Name read with the symbol's overrides. */
  loadLibrary(path: string, text: string): boolean {
    const lib = parseSpiceLibrary(text); this.libraryPath = path;
    if (lib.errors.length && !lib.models.length) { this.messages.push(...lib.errors); this.library = null; this.libModels.clear(); return false; }
    this.library = { path, lib }; this.libModels.clear(); this.unknownModel = false;
    const mn = getFieldValue(this.fields, F.NAME);
    for (const lm of lib.models) this.libModels.set(lm.name, lm.name === mn ? createFromBase(lm.model, this.pinNumbers, this.fields) : createFromBase(lm.model, this.pinNumbers));
    this.source = "library";
    const names = this.modelNames();
    if (!lib.models.some((x) => x.name.toLowerCase() === mn.toLowerCase())) { this.messages.push(`No model named '${mn}' in '${path}'.`); this.modelName = ""; void names; return false; }
    this.modelName = names.find((n) => n === mn) || names.find((n) => n.toLowerCase() === mn.toLowerCase()) || names[0] || "";
    this.curType = this.curModel().type;
    return true;
  }
  /** wxArrayString::Sort: the model list in case-sensitive code-point order. */
  modelNames(filter = ""): string[] {
    if (!this.library) return this.unknownModel ? ["<unknown>"] : [];
    const re = filter ? new RegExp("^" + ("*" + filter + "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
    return byteSort(this.library.lib.models.map((m) => m.name).filter((n) => !re || re.test(n)));
  }
  builtinModel(t: string): SimModel {
    let m = this.builtin.get(t);
    if (!m) {
      if (t === this.fieldsType) { const r = createFromFields(this.fields, this.pinNumbers); m = r.model; if (r.error) this.messages.push("Failed to read simulation model from fields.\n\n" + r.error); }
      else { m = createModel(t); try { readDataFields(m, null, this.pinNumbers); } catch (e) { /* empty fields never throw */ } }
      this.builtin.set(t, m);
    }
    return m;
  }
  curModel(): SimModel {
    if (this.source === "library") { const m = this.libModels.get(this.modelName); if (m) return m; return this.builtinModel("NONE"); }
    return this.builtinModel(this.curType);
  }
  selectDevice(description: string): void {
    this.source = "builtin";
    for (const d of DEVICE_IDS) if (deviceInfo(d).description === description) { this.curType = this.curTypeOfDevice.get(d) || this.curType; break; }
  }
  selectType(description: string): void {
    const dev = this.curModel().deviceType;
    for (const t of TYPE_IDS) if (equivalentDevice(dev, typeInfo(t).deviceType) && typeInfo(t).description === description) { this.curType = t; break; }
    this.curTypeOfDevice.set(dev, this.curType);
  }
  /** The Device: choice (DEVICE_T order, showInMenu) and the Device type: choice for the current model. */
  deviceChoices(): { items: string[]; sel: number } {
    const m = this.curModel(); const items: string[] = []; let sel = -1;
    for (const d of DEVICE_IDS) { const di = deviceInfo(d); if (!di.showInMenu) continue; items.push(di.description); if (equivalentDevice(d, m.deviceType)) sel = items.length - 1; }
    return { items, sel };
  }
  typeChoices(): { items: string[]; sel: number } {
    const m = this.curModel(); const items: string[] = []; let sel = -1;
    for (const t of TYPE_IDS) { if (isKibis(t)) continue; const d = typeInfo(t).deviceType; if (d === m.deviceType || deviceInfo(d).description === deviceInfo(m.deviceType).description) { items.push(typeInfo(t).description); if (t === m.type) sel = items.length - 1; } }
    return { items, sel };
  }
  saveInValueLabel(): { label: string; enabled: boolean } {
    const m = this.curModel();
    if (m.hasPrimaryValue()) { const p = m.getParam(0); return { label: `Save parameter '${p.info.description} (${p.info.name})' in Value field`, enabled: true }; }
    return { label: "Save primary parameter in Value field", enabled: false };
  }
  // ---- the Pin Assignments grid
  symbolPinString(i: number): string { const p = this.pins[i]; return p.name && p.name !== p.number ? `${p.number} ("${p.name}")` : p.number; }
  modelPinString(m: SimModel, i: number): string { const n = i >= 0 && i < m.pins.length ? m.pins[i].name : ""; const num = String(i + 1); return n && n !== num ? `${num} ("${n}")` : num; }
  modelPinIndex(s: string): number { if (s === "Not Connected") return -1; const sp = s.indexOf(" "); return (parseInt(sp < 0 ? s : s.slice(0, sp), 10) || 0) - 1; }
  pinRows(): { symbol: string; model: string; choices: string[] }[] {
    const m = this.curModel(); const choices = m.pins.map((_p, j) => this.modelPinString(m, j)).concat(["Not Connected"]);
    return this.pins.map((p, i) => { const j = m.findModelPinIndex(p.number); return { symbol: this.symbolPinString(i), model: j >= 0 ? this.modelPinString(m, j) : "Not Connected", choices }; });
  }
  /** onPinAssignmentsGridCellChange. */
  setPinAssignment(row: number, modelPinString: string): void {
    const m = this.curModel(); const old = m.findModelPinIndex(this.pins[row].number); const idx = this.modelPinIndex(modelPinString);
    if (old >= 0) m.assignByIndex(old, "");
    if (idx >= 0) m.assignByIndex(idx, this.pins[row].number);
  }
  /** TransferDataFromWindow: the edited fields (rawCode: the Code page text for a Raw SPICE Element). */
  finish(opts: { rawCode?: string } = {}): R[] {
    const m = this.curModel(); let path = "", name = "";
    if (this.source === "library") {
      path = this.libraryPath;
      name = this.modelName && !this.unknownModel ? this.modelName : m.fallback ? getFieldValue(this.fields, F.NAME) : this.modelName;
    }
    setFieldValue(this.fields, F.LIBRARY, path, false, this.mk);
    setFieldValue(this.fields, F.NAME, name, false, this.mk);
    if (m.type === "RAWSPICE" && opts.rawCode !== undefined) m.setParamValue("model", opts.rawCode.trim());
    if (m.hasPrimaryValue()) m.storedInValue = this.storeInValue;
    for (let i = 0; i < m.pins.length; i++) if (!this.pinNumbers.includes(m.pins[i].symbolPinNumber)) m.assignByIndex(i, "");
    writeFields(m, this.fields, this.mk);
    if (this.inferredOverwritten && !m.storedInValue) { const v = getField(this.fields, F.VALUE); if (v) v.value = this.inferredRestore; }
    if (this.ctx.unitCount > 1) setFieldValue(this.fields, F.DECOMPOSITION, formatDecomposition(this.decompositionRepeat, this.decompositionRepeat ? this.sharedPins.split(/[, \t]+/).filter(Boolean) : []), false, this.mk);
    return this.fields;
  }
  previewText(): string {
    const m = this.curModel(); if (m.fallback) return m.spiceCode;
    let modelName = this.source === "library" ? this.modelName : "";
    if (this.source !== "library" || !modelName) modelName = getFieldValue(this.fields, F.REFERENCE);
    return preview(m, { refName: "", modelName, baseModelName: "" });
  }
}
