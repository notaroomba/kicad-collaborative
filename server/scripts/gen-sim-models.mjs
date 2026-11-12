#!/usr/bin/env node
// gen-sim-models.mjs — generates the Simulation Model Editor's tables from KiCad's own C++:
//   web/dialogs/sim-model-data.ts     DEVICE_T / TYPE (sim_model.h), DeviceInfo / TypeInfo / SpiceInfo (sim_model.cpp),
//                                     the pins and PARAM::INFO lists of the hand-written models (sim_model_ideal,
//                                     _behavioral, _r_pot, _l_mutual, _tline, _switch, _source, _raw_spice)
//   web/dialogs/sim-model-ngspice.ts  NGSPICE_MODEL_INFO_MAP (sim_model_ngspice_data_*.cpp), loaded on demand
// Run: node server/scripts/gen-sim-models.mjs [<kicad source root>]   (defaults to this repository's root)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || path.resolve(here, "..", "..");
const SIM = path.join(root, "eeschema", "sim");
const OUT = path.resolve(here, "..", "web", "dialogs");
const read = (f) => fs.readFileSync(path.join(SIM, f), "utf8");

// ------------------------------------------------------------------ enums (DEFINE_ENUM_CLASS_WITH_ITERATOR)
const H = read("sim_model.h");
function enumOf(name) {
  const m = new RegExp(`DEFINE_ENUM_CLASS_WITH_ITERATOR\\(\\s*${name},([\\s\\S]*?)\\)`).exec(H);
  if (!m) throw new Error("enum " + name);
  return m[1].split("\n").map((l) => l.replace(/\/\/.*$/, "").trim().replace(/,$/, "")).filter(Boolean);
}
const DEVICE_T = enumOf("DEVICE_T"), TYPE = enumOf("TYPE");

// ------------------------------------------------------------------ C++ literal lists -> JS values
const cats = "PRINCIPAL GEOMETRY AC DC CAPACITANCE TEMPERATURE NOISE DISTRIBUTED_QUANTITIES LIMITING_VALUES S_PARAM ADVANCED FLAGS WAVEFORM INITIAL_CONDITIONS SUPERFLUOUS".split(" ");
function cxxToJs(s) {
  return s
    .replace(/(?:SIM_MODEL::)?(?:SIM)?PARAM::CATEGORY::(\w+)/g, '"$1"')
    .replace(/SIM_VALUE::TYPE_(\w+)/g, '"$1"')
    .replace(/(?:SIM_MODEL::)?PARAM::DIR_(\w+)/g, '"$1"')
    .replace(/DEVICE_T::(\w+)/g, '"$1"')
    .replace(/!strcmp\(\s*(\w+)\.c_str\(\),\s*("[^"]*")\s*\)/g, "($1 === $2)")
    .replace(/\btrue\b/g, "true").replace(/\bfalse\b/g, "false");
}
/** Split a top-level comma list (strings and braces respected). */
function splitArgs(s) {
  const out = []; let depth = 0, cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") { cur += s[++i]; continue; } if (c === '"') q = false; continue; }
    if (c === '"') { q = true; cur += c; continue; }
    if (c === "{" || c === "(") depth++;
    if (c === "}" || c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const lit = (s) => (s === undefined || s === "" ? undefined : Function(`"use strict"; return (${cxxToJs(s).replace(/^\{(.*)\}$/s, "[$1]")});`)());

const P0 = () => ({ name: "", id: 0, dir: "INOUT", type: "FLOAT", unit: "", category: "PRINCIPAL", defaultValue: "", description: "", isSpiceInstanceParam: false, isInstanceParam: false, spiceModelName: "", spiceInstanceName: "", enumValues: [] });
/** PARAM::INFO( aName, aId, aDir, aType, aUnit, aCategory, aDefaultValue, legacy_unused_value, aDescription,
 *  aIsSpiceInstanceParam, aIsInstanceParam, aSpiceModelName, aSpiceInstanceName, aEnumValues ) */
function infoFromArgs(args) {
  const v = args.map(lit), p = P0();
  const keys = ["name", "id", "dir", "type", "unit", "category", "defaultValue", null, "description", "isSpiceInstanceParam", "isInstanceParam", "spiceModelName", "spiceInstanceName", "enumValues"];
  keys.forEach((k, i) => { if (k && v[i] !== undefined) p[k] = v[i]; });
  return p;
}

// ------------------------------------------------------------------ DeviceInfo / TypeInfo / SpiceInfo switch tables
const CPP = read("sim_model.cpp");
function switchTable(fn, enumName) {
  const start = CPP.indexOf(`SIM_MODEL::${fn}(`); const body = CPP.slice(start, CPP.indexOf("\n}\n", start));
  const out = {};
  const re = new RegExp(`^\\s*case ${enumName}::(\\w+):\\s*return\\s*\\{(.*)\\};`, "gm");
  let m; while ((m = re.exec(body))) out[m[1]] = splitArgs(m[2].replace(/,\s*$/, "")).map(lit);
  return out;
}
const devInfo = switchTable("DeviceInfo", "DEVICE_T"), typeInfo = switchTable("TypeInfo", "TYPE"), spiceInfo = switchTable("SpiceInfo", "TYPE");

// ------------------------------------------------------------------ hand-written models: transpile their make*ParamInfos
function functionBody(src, name) {
  const re = new RegExp(`\\b\\w+::${name}\\s*\\(([^)]*)\\)\\s*(?:const\\s*)?\\{`); const m = re.exec(src); if (!m) throw new Error("no " + name);
  let i = m.index + m[0].length, depth = 1; const s0 = i;
  while (depth) { const c = src[i++]; if (c === "{") depth++; else if (c === "}") depth--; else if (c === '"') { while (src[i] !== '"') { if (src[i] === "\\") i++; i++; } i++; } }
  const params = m[1].split(",").map((a) => (/(\w+)\s*$/.exec(a.trim()) || [])[1]).filter(Boolean);
  return { params, body: src.slice(s0, i - 1) };
}
function transpile(src, names) {
  let js = "";
  for (const n of names) {
    const { params, body } = functionBody(src, n);
    let b = body
      .replace(/std::vector<\s*(?:SIM_MODEL::|SIM)?PARAM::INFO\s*>\s+(\w+)\s*;/g, "let $1 = [];")
      .replace(/(?:SIM_MODEL::|SIM)?PARAM::INFO\s+(\w+)(\s*=\s*\{\s*\})?\s*;/g, "let $1 = P0();")
      .replace(/(\w+)\.push_back\(\s*(\w+)\s*\)/g, "$1.push({ ...$2, enumValues: [...$2.enumValues] })")
      .replace(/=\s*\{([^;{}]*)\}\s*;/g, "= [$1];");
    b = cxxToJs(b);
    js += `function ${n}(${params.join(", ")}) {${b}}\n`;
  }
  return js;
}
function runTranspiled(src, fns, entry) {
  // eslint-disable-next-line no-new-func
  return Function("P0", `"use strict";\n${transpile(src, fns)}\nreturn { ${entry.join(", ")} };`)(P0);
}

const params = {};   // TYPE -> PARAM::INFO[]
const pins = {};     // TYPE -> model pin names
const cls = {};      // TYPE -> model class

// SIM_MODEL_IDEAL / SIM_MODEL_BEHAVIORAL: one static PARAM::INFO per type
for (const [file, klass, ptype] of [["sim_model_ideal.cpp", "ideal", "FLOAT"], ["sim_model_behavioral.cpp", "behavioral", "STRING"]]) {
  const s = read(file); const vars = {};
  for (const m of s.matchAll(/static PARAM::INFO (\w+)\s*=\s*make\w+\(\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"\s*\)/g)) vars[m[1]] = Object.assign(P0(), { name: m[2], description: m[3], unit: m[4], type: ptype });
  for (const m of s.matchAll(/case TYPE::(\w+):\s*AddParam\(\s*(\w+)\s*\)/g)) { params[m[1]] = [vars[m[2]]]; pins[m[1]] = ["+", "-"]; cls[m[1]] = klass; }
}
{ // SIM_MODEL_R_POT
  const r = runTranspiled(read("sim_model_r_pot.cpp"), ["makeParamInfos"], ["makeParamInfos"]);
  params.R_POT = r.makeParamInfos(); pins.R_POT = ["r0", "wiper", "r1"]; cls.R_POT = "r_pot";
}
{ // SIM_MODEL_L_MUTUAL
  const r = runTranspiled(read("sim_model_l_mutual.cpp"), ["makeParamInfos"], ["makeParamInfos"]);
  params.K = r.makeParamInfos(); pins.K = []; cls.K = "l_mutual";
}
{ // SIM_MODEL_TLINE
  const r = runTranspiled(read("sim_model_tline.cpp"), ["makeZ0ParamInfos", "makeRlgcParamInfos"], ["makeZ0ParamInfos", "makeRlgcParamInfos"]);
  params.TLINE_Z0 = r.makeZ0ParamInfos(); params.TLINE_RLGC = r.makeRlgcParamInfos();
  for (const t of ["TLINE_Z0", "TLINE_RLGC"]) { pins[t] = ["1+", "1-", "2+", "2-"]; cls[t] = "tline"; }
}
{ // SIM_MODEL_SWITCH
  const r = runTranspiled(read("sim_model_switch.cpp"), ["makeSwVParamInfos", "makeSwIParamInfos"], ["makeSwVParamInfos", "makeSwIParamInfos"]);
  params.SW_V = r.makeSwVParamInfos(); params.SW_I = r.makeSwIParamInfos();
  for (const t of ["SW_V", "SW_I"]) { pins[t] = ["ctrl+", "ctrl-", "no+", "no-"]; cls[t] = "switch"; }
}
{ // SIM_MODEL_SOURCE::makeParamInfos( aType )
  const s = read("sim_model_source.cpp");
  const fnNames = [...new Set([...s.matchAll(/SIM_MODEL_SOURCE::(make\w+ParamInfos|append\w+ParamInfos)\s*\(/g)].map((m) => m[1]))].filter((n) => n !== "makeParamInfos");
  const r = runTranspiled(s, fnNames, fnNames);
  const { body } = functionBody(s, "makeParamInfos");
  const vars = {};
  for (const m of body.matchAll(/static std::vector<PARAM::INFO> (\w+)\s*=\s*(\w+)\(([^;]*)\);/g)) vars[m[1]] = r[m[2]](...splitArgs(m[3]).map(lit));
  for (const m of body.matchAll(/case TYPE::(\w+):\s*return (\w+);/g)) {
    params[m[1]] = vars[m[2]]; cls[m[1]] = "source";
    const dev = typeInfo[m[1]][0];
    pins[m[1]] = dev === "E" || dev === "G" ? ["+", "-", "C+", "C-"] : ["+", "-"];
  }
}
{ // SIM_MODEL_RAW_SPICE::makeParamInfos (a switch over SPICE_PARAM)
  const s = read("sim_model_raw_spice.cpp"); const { body } = functionBody(s, "makeParamInfos");
  const list = [];
  for (const m of body.matchAll(/case SPICE_PARAM::\w+:([\s\S]*?)break;/g)) {
    if (!/push_back/.test(m[1])) continue;
    const p = P0();
    for (const a of m[1].matchAll(/paramInfo\.(\w+)\s*=\s*([^;]+);/g)) p[a[1]] = lit(a[2]);
    list.push(p);
  }
  params.RAWSPICE = list; pins.RAWSPICE = []; cls.RAWSPICE = "rawspice";
}
for (const t of ["SUBCKT", "XSPICE", "KIBIS_DEVICE", "KIBIS_DRIVER_DC", "KIBIS_DRIVER_RECT", "KIBIS_DRIVER_PRBS", "NONE"]) { params[t] = params[t] || []; pins[t] = pins[t] || []; cls[t] = t === "SUBCKT" ? "subckt" : t === "XSPICE" ? "xspice" : t === "NONE" ? "none" : "ibis"; }

// ------------------------------------------------------------------ SIM_MODEL_NGSPICE
const NG = fs.readFileSync(path.join(SIM, "sim_model_ngspice.cpp"), "utf8");
const ngOf = {};
{
  const { body } = functionBody(NG, "getModelType");
  let pending = [];
  for (const line of body.split("\n")) {
    const c = /case TYPE::(\w+):/.exec(line); if (c) pending.push(c[1]);
    const r = /return MODEL_TYPE::(\w+);/.exec(line); if (r) { for (const t of pending) if (t !== "NONE") ngOf[t] = r[1]; pending = []; }
  }
}
const ngspice = {};
for (const f of fs.readdirSync(SIM).filter((x) => /^sim_model_ngspice_data_\w+\.cpp$/.test(x)).sort()) {
  const s = read(f);
  for (const m of s.matchAll(/modelInfos\[MODEL_TYPE::(\w+)\]\s*=\s*\{(.*)\};/g)) {
    const a = splitArgs(m[2]);
    ngspice[m[1]] = { name: lit(a[0]), variant1: lit(a[1]), variant2: lit(a[2]), pins: lit(a[3]) || [], description: lit(a[4]), modelParams: [], instanceParams: [] };
  }
  for (const m of s.matchAll(/modelInfos\[MODEL_TYPE::(\w+)\]\.(modelParams|instanceParams)\.emplace_back\(\s*(.*)\);\s*$/gm)) ngspice[m[1]][m[2]].push(infoFromArgs(splitArgs(m[3])));
}
for (const t of Object.keys(ngOf)) { cls[t] = "ngspice"; pins[t] = ngspice[ngOf[t]].pins; }

// ------------------------------------------------------------------ write
const PKEYS = ["name", "id", "dir", "type", "unit", "category", "defaultValue", "description", "isSpiceInstanceParam", "isInstanceParam", "spiceModelName", "spiceInstanceName", "enumValues"];
const tuple = (p) => { const t = PKEYS.map((k) => p[k]); while (t.length > 8) { const last = t[t.length - 1]; if (last === false || last === "" || (Array.isArray(last) && !last.length)) t.pop(); else break; } return t; };
const J = (x) => JSON.stringify(x);
const banner = "// GENERATED by server/scripts/gen-sim-models.mjs from eeschema/sim/*.cpp - edit the generator, not this file.\n";
let out = banner + `/* eslint-disable */
/** A PARAM::INFO as a tuple: [name, id, dir, type, unit, category, defaultValue, description, isSpiceInstanceParam?,
 *  isInstanceParam?, spiceModelName?, spiceInstanceName?, enumValues?] (trailing defaults left out). */
export type ParamTuple = (string | number | boolean | string[])[];
/** SIM_MODEL::DEVICE_T, in enum order: [id, fieldValue, description, showInMenu] (SIM_MODEL::DeviceInfo). */
export const DEVICES: [string, string, string, boolean][] = ${J(DEVICE_T.map((d) => [d, ...(devInfo[d] || ["", "", false])]))};
/** SIM_MODEL::TYPE, in enum order: [id, deviceType, fieldValue, description] (SIM_MODEL::TypeInfo). */
export const TYPES: [string, string, string, string][] = ${J(TYPE.map((t) => [t, ...(typeInfo[t] || ["NONE", "", ""])]))};
/** SIM_MODEL::SpiceInfo: [itemType, modelType, functionName, level, isDefaultLevel, hasExpression, version]. */
export const SPICE_INFO: Record<string, (string | boolean)[]> = ${J(Object.fromEntries(TYPE.map((t) => [t, spiceInfo[t] || []])))};
/** The model class behind each TYPE (SIM_MODEL::Create). */
export const MODEL_CLASS: Record<string, string> = ${J(cls)};
/** GetPinNames() per TYPE ('<name>' = optional pin). */
export const PIN_NAMES: Record<string, string[]> = ${J(pins)};
/** SIM_MODEL_NGSPICE::getModelType. */
export const NGSPICE_MODEL_OF: Record<string, string> = ${J(ngOf)};
/** The PARAM::INFO lists of the models that are not SIM_MODEL_NGSPICE. */
export const PARAMS: Record<string, ParamTuple[]> = {
${Object.keys(params).filter((t) => cls[t] !== "ngspice").map((t) => `  ${t}: ${J(params[t].map(tuple))},`).join("\n")}
};
`;
fs.writeFileSync(path.join(OUT, "sim-model-data.ts"), out);
let ng = banner + `/* eslint-disable */
import type { ParamTuple } from "./sim-model-data";
/** NGSPICE_MODEL_INFO_MAP: name, variant1, variant2, pinNames, description, modelParams, instanceParams. */
export interface NgspiceModelInfo { name: string; variant1: string; variant2: string; pins: string[]; description: string; modelParams: ParamTuple[]; instanceParams: ParamTuple[] }
export const NGSPICE: Record<string, NgspiceModelInfo> = {
${Object.entries(ngspice).map(([k, v]) => `  ${k}: { name: ${J(v.name)}, variant1: ${J(v.variant1)}, variant2: ${J(v.variant2)}, pins: ${J(v.pins)}, description: ${J(v.description)},\n    modelParams: ${J(v.modelParams.map(tuple))},\n    instanceParams: ${J(v.instanceParams.map(tuple))} },`).join("\n")}
};
`;
fs.writeFileSync(path.join(OUT, "sim-model-ngspice.ts"), ng);
console.log(`sim-model-data.ts: ${TYPE.length} types, ${DEVICE_T.length} devices; sim-model-ngspice.ts: ${Object.keys(ngspice).length} models, ${Object.values(ngspice).reduce((n, v) => n + v.modelParams.length + v.instanceParams.length, 0)} params`);
void cats;
