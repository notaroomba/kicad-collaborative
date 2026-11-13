// canvas/variant-model — design variants of board footprints and schematic symbols, as KiCad 10 reads and writes
// them (pure: no DOM, used by the editor, the tool bundles and the tests).
//
// Board: FOOTPRINT keeps a CASE_INSENSITIVE_MAP of FOOTPRINT_VARIANT (footprint.h:177).  The writer
// (pcb_io_kicad_sexpr.cpp:2058-2096) puts each variant after the footprint's groups and constraints and before
// (embedded_fonts …): (variant (name N) [(dnp yes|no)] [(exclude_from_bom …)] [(exclude_from_sim …)]
// [(exclude_from_pos_files …)] (field (name F) (value V))…) — a flag only when it differs from the footprint's own,
// a field only when it differs from the footprint field's text, fields by name (std::map order).  A new variant
// copies the footprint's flags (FOOTPRINT::AddVariant).
//
// Schematic: each symbol instance (instances (project P (path "/…" (reference …) (unit …) (variant …)…))) holds
// SCH_SYMBOL_VARIANTs; the writer (sch_io_kicad_sexpr.cpp:1281-1322) writes (variant (name N) [(dnp …)]
// [(exclude_from_sim …)] [(in_bom …)] [(on_board …)] [(in_pos_files …)] (field (name F) (value V))…
// [(symbol_override …)] [pin map]) and leaves out a variant with no differentials.

type N = SNode;
const isList = Array.isArray;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kid = (n: N | null | undefined, key: string): N | null => { if (!n) return null; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return c as N; } return null; };
const kids = (n: N | null | undefined, key: string): N[] => (n ? (n.filter((c) => isList(c) && c[0] === key) as N[]) : []);
const clone = (n: N): N => JSON.parse(JSON.stringify(n)) as N;
const boolOf = (k: N | null, dflt: boolean): boolean => (k ? (k.length < 2 || /^(yes|true)$/.test(str(k[1]))) : dflt);
/** wxString operator< (code-point order), std::map<wxString, …>'s order. */
const cmpCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lower = (s: string): string => s.toLowerCase();

export const DEFAULT_VARIANT_NAME = "< Default >";
/** An empty name or "< Default >" (any case) is the default variant. */
export const isDefaultVariant = (v: string | null | undefined): boolean => !v || lower(v) === lower(DEFAULT_VARIANT_NAME);

// ---------------------------------------------------------------- board footprints
export interface FpFlags { dnp: boolean; exclude_from_bom: boolean; exclude_from_sim: boolean; exclude_from_pos_files: boolean }
export const FP_FLAG_KEYS: (keyof FpFlags)[] = ["dnp", "exclude_from_bom", "exclude_from_sim", "exclude_from_pos_files"];

/** The footprint's own flags (its (attr …) tokens). */
export function footprintFlags(fp: N): FpFlags {
  const a = kid(fp, "attr"); const toks = a ? a.slice(1).map(str) : [];
  return { dnp: toks.includes("dnp"), exclude_from_bom: toks.includes("exclude_from_bom"), exclude_from_sim: toks.includes("exclude_from_sim"), exclude_from_pos_files: toks.includes("exclude_from_pos_files") };
}
const fpField = (fp: N, name: string): N | null => kids(fp, "property").find((p) => str(p[1]) === name) || null;

/** The footprint's (variant …) for `name` (matched without case, as the map does). */
export function footprintVariantNode(fp: N, name: string): N | null {
  if (isDefaultVariant(name)) return null;
  return kids(fp, "variant").find((v) => lower(str((kid(v, "name") || [])[1])) === lower(name)) || null;
}

export interface FpVariantState { name: string; flags: FpFlags; fields: Map<string, string> }
/** FOOTPRINT_VARIANT as the parser builds it from the node (absent flags take the footprint's). */
export function footprintVariant(fp: N, name: string): FpVariantState | null {
  const v = footprintVariantNode(fp, name); if (!v) return null;
  const base = footprintFlags(fp), flags = { ...base };
  for (const k of FP_FLAG_KEYS) flags[k] = boolOf(kid(v, k), base[k]);
  const fields = new Map<string, string>();
  for (const f of kids(v, "field")) { const nm = str((kid(f, "name") || [])[1]); if (nm) fields.set(nm, str((kid(f, "value") || [])[1])); }
  return { name: str((kid(v, "name") || [])[1]), flags, fields };
}

/** …ForVariant getters: the flags and field values the variant shows (the footprint's own without one). */
export function footprintFlagsForVariant(fp: N, variant: string | null | undefined): FpFlags {
  const st = variant ? footprintVariant(fp, variant) : null; return st ? st.flags : footprintFlags(fp);
}
export function footprintFieldForVariant(fp: N, variant: string | null | undefined, field: string): string {
  const st = variant ? footprintVariant(fp, variant) : null;
  if (st && st.fields.has(field)) return st.fields.get(field) as string;
  const p = fpField(fp, field); return p ? str(p[2]) : "";
}

/** A copy of the footprint as the variant shows it: the (attr …) flags and the property texts replaced.  The
 *  same node when the variant changes nothing. */
export function footprintViewForVariant(fp: N, variant: string | null | undefined): N {
  const st = variant ? footprintVariant(fp, variant) : null; if (!st) return fp;
  const base = footprintFlags(fp);
  const flagsDiffer = FP_FLAG_KEYS.some((k) => st.flags[k] !== base[k]);
  const fieldsDiffer = [...st.fields].some(([k, v]) => { const p = fpField(fp, k); return !!p && str(p[2]) !== v; });
  if (!flagsDiffer && !fieldsDiffer) return fp;
  const out = clone(fp);
  if (flagsDiffer) {
    let a = kid(out, "attr"); if (!a) { a = ["attr"]; out.splice(out.length, 0, a); }
    const toks = a.slice(1).map(str).filter((t) => !(FP_FLAG_KEYS as string[]).includes(t));
    for (const k of FP_FLAG_KEYS) if (st.flags[k]) toks.push(k);
    a.splice(1, a.length - 1, ...toks);
  }
  for (const [k, v] of st.fields) { const p = fpField(out, k); if (p) p[2] = v; }
  return out;
}

export interface FpVariantPatch { flags?: Partial<FpFlags>; fields?: Record<string, string> }
const VARIANT_BEFORE = ["embedded_fonts", "embedded_files", "model", "extruded"];
/** The footprint with its variant `name` edited (created from the footprint's flags when missing, as AddVariant
 *  does), written as the KiCad writer writes it.  Returns a copy. */
export function setFootprintVariant(fp: N, name: string, patch: FpVariantPatch): N {
  if (isDefaultVariant(name)) throw new Error("Variant name cannot be empty or default.");
  const out = clone(fp), base = footprintFlags(out);
  const cur = footprintVariant(out, name) || { name, flags: { ...base }, fields: new Map<string, string>() };
  for (const k of FP_FLAG_KEYS) if (patch.flags && patch.flags[k] !== undefined) cur.flags[k] = !!patch.flags[k];
  if (patch.fields) for (const [k, v] of Object.entries(patch.fields)) cur.fields.set(k, v);
  const node: N = ["variant", ["name", cur.name]];
  for (const k of FP_FLAG_KEYS) if (cur.flags[k] !== base[k]) node.push([k, cur.flags[k] ? "yes" : "no"]);
  for (const k of [...cur.fields.keys()].sort(cmpCode)) {
    const p = fpField(out, k), v = cur.fields.get(k) as string;
    if ((p ? str(p[2]) : "") === v) continue;
    node.push(["field", ["name", k], ["value", v]]);
  }
  const old = footprintVariantNode(out, name);
  if (old) { out[out.indexOf(old)] = node; return out; }
  // a new variant goes in the map's order (names without case) among the others, else before (embedded_fonts …)
  const others = kids(out, "variant");
  const after = others.filter((v) => lower(str((kid(v, "name") || [])[1])) < lower(name)).pop();
  if (after) { out.splice(out.indexOf(after) + 1, 0, node); return out; }
  if (others.length) { out.splice(out.indexOf(others[0]), 0, node); return out; }
  const at = out.findIndex((c, i) => i > 0 && isList(c) && VARIANT_BEFORE.includes(str(c[0])));
  out.splice(at > 0 ? at : out.length, 0, node);
  return out;
}

/** BOARD::GetVariantNamesForUI: the default first, then (variants (variant (name …))) by StrNumCmp. */
export function boardVariantNamesForUI(variants: N | null | undefined): string[] {
  const names: string[] = [];
  for (const v of kids(variants, "variant")) { const s = str((kid(v, "name") || [])[1]); if (s && !names.includes(s)) names.push(s); }
  return [DEFAULT_VARIANT_NAME, ...names.sort(strNumCmp)];
}
/** BOARD::GetVariantDescription. */
export function boardVariantDescription(variants: N | null | undefined, name: string): string {
  const v = kids(variants, "variant").find((x) => lower(str((kid(x, "name") || [])[1])) === lower(name));
  return v ? str((kid(v, "description") || [])[1]) : "";
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

// ---------------------------------------------------------------- schematic symbols
/** The symbol's flags as SCH_SYMBOL holds them ("excluded" senses, as the variant does). */
export interface SymFlags { dnp: boolean; excludedFromSim: boolean; excludedFromBOM: boolean; excludedFromBoard: boolean; excludedFromPosFiles: boolean }
/** [variant key, SymFlags key, inverted] in the writer's order */
const SYM_KEYS: [string, keyof SymFlags, boolean][] = [["dnp", "dnp", false], ["exclude_from_sim", "excludedFromSim", false], ["in_bom", "excludedFromBOM", true], ["on_board", "excludedFromBoard", true], ["in_pos_files", "excludedFromPosFiles", true]];

/** The first schematic file version whose variant (in_bom …) is positive (sch_file_versions.h "Variant in_bom
 *  semantics corrected").  Older files (and the parser reading them, sch_io_kicad_sexpr_parser.cpp:3934-3939) take
 *  a variant's in_bom value as "excluded from BOM"; the web never bumps the version, so it reads and writes the
 *  token with the meaning the file's version gives it. */
export const VARIANT_IN_BOM_POSITIVE_VERSION = 20260306;
/** True when a variant's (in_bom …) is the positive "in the BOM" in a file of version `ver` (0 / unknown: current). */
export const variantInBomPositive = (ver?: number | null): boolean => !ver || ver >= VARIANT_IN_BOM_POSITIVE_VERSION;
/** SYM_KEYS as a variant of a file of version `ver` holds them. */
const variantKeys = (ver?: number | null): [string, keyof SymFlags, boolean][] => (variantInBomPositive(ver) ? SYM_KEYS : SYM_KEYS.map(([k, f, inv]) => [k, f, k === "in_bom" ? false : inv] as [string, keyof SymFlags, boolean]));

export function symbolFlags(sym: N): SymFlags {
  const out = {} as SymFlags;
  for (const [key, f, inv] of SYM_KEYS) { const k = kid(sym, key); out[f] = inv ? !boolOf(k, true) : boolOf(k, false); }
  return out;
}

/** The (path …) entries of the symbol's instances. */
export function symbolInstancePaths(sym: N): N[] {
  const out: N[] = [];
  for (const proj of kids(kid(sym, "instances"), "project")) for (const p of kids(proj, "path")) out.push(p);
  return out;
}
/** The instance entry for `path` ("/uuid/…"), or the first one when `path` is empty or not found. */
export function symbolInstance(sym: N, path?: string | null): N | null {
  const all = symbolInstancePaths(sym);
  return (path ? all.find((p) => str(p[1]) === path) : null) || all[0] || null;
}
const symVariantIn = (inst: N | null, name: string): N | null => kids(inst, "variant").find((v) => str((kid(v, "name") || [])[1]) === name) || null;

export interface SymVariantState { flags: SymFlags; fields: Map<string, string> }
export function symbolVariant(sym: N, name: string, path?: string | null, ver?: number | null): SymVariantState | null {
  if (isDefaultVariant(name)) return null;
  const v = symVariantIn(symbolInstance(sym, path), name); if (!v) return null;
  const base = symbolFlags(sym), flags = { ...base };
  for (const [key, f, inv] of variantKeys(ver)) { const k = kid(v, key); if (k) flags[f] = inv ? !boolOf(k, true) : boolOf(k, false); }
  const fields = new Map<string, string>();
  for (const f of kids(v, "field")) { const nm = str((kid(f, "name") || [])[1]); if (nm) fields.set(nm, str((kid(f, "value") || [])[1])); }
  return { flags, fields };
}
export function symbolFlagsForVariant(sym: N, variant: string | null | undefined, path?: string | null, ver?: number | null): SymFlags {
  const st = variant ? symbolVariant(sym, variant, path, ver) : null; return st ? st.flags : symbolFlags(sym);
}

export interface SymVariantPatch { flags?: Partial<SymFlags>; fields?: Record<string, string> }
/** The symbol with its instance's variant `name` edited (created when missing, from the symbol's flags), written in
 *  the writer's order; a variant left with no differentials is removed.  Children the web does not edit
 *  ((symbol_override …), pin maps) are kept.  Returns a copy. */
export function setSymbolVariant(sym: N, name: string, patch: SymVariantPatch, path?: string | null, ver?: number | null): N {
  if (isDefaultVariant(name)) throw new Error("Variant name cannot be empty or default.");
  const out = clone(sym), inst = symbolInstance(out, path);
  if (!inst) return out;
  // a sheet's variant holds dnp, exclude_from_sim and in_bom only (sch_io_kicad_sexpr.cpp:1556-1580; SCH_SHEET's
  // board exclusion is the sheet's own whatever the variant)
  const keys = out[0] === "sheet" ? variantKeys(ver).filter(([k]) => k !== "on_board" && k !== "in_pos_files") : variantKeys(ver);
  const base = symbolFlags(out), st = symbolVariant(out, name, str(inst[1]), ver) || { flags: { ...base }, fields: new Map<string, string>() };
  for (const [, f] of SYM_KEYS) if (patch.flags && patch.flags[f] !== undefined) st.flags[f] = !!patch.flags[f];
  const baseField = (k: string): string => { const p = kids(out, "property").find((q) => str(q[1]) === k); return p ? str(p[2]) : ""; };
  // SCH_SYMBOL::SetFieldText( …, variant ): a text equal to the symbol's own is no override (erased)
  if (patch.fields) for (const [k, v] of Object.entries(patch.fields)) { if (v === baseField(k) && kids(out, "property").some((q) => str(q[1]) === k)) st.fields.delete(k); else st.fields.set(k, v); }
  const old = symVariantIn(inst, name);
  const node: N = ["variant", ["name", name]];
  for (const [key, f, inv] of keys) if (st.flags[f] !== base[f]) node.push([key, (inv ? !st.flags[f] : st.flags[f]) ? "yes" : "no"]);
  for (const k of [...st.fields.keys()].sort(cmpCode)) node.push(["field", ["name", k], ["value", st.fields.get(k) as string]]);
  if (old) for (const c of old.slice(1)) if (isList(c) && !["name", "dnp", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "field"].includes(str(c[0]))) node.push(c);
  // HasDifferentials: a flag differs, a field differs from the symbol's, or an override is held
  const differs = node.length > 2 && (keys.some(([, f]) => st.flags[f] !== base[f]) || [...st.fields].some(([k, v]) => baseField(k) !== v) || node.slice(2).some((c) => isList(c) && !["field"].includes(str(c[0]))));
  if (old) { if (differs) inst[inst.indexOf(old)] = node; else inst.splice(inst.indexOf(old), 1); }
  else if (differs) {
    const others = kids(inst, "variant"); const after = others.filter((v) => cmpCode(str((kid(v, "name") || [])[1]), name) < 0).pop();
    inst.splice(after ? inst.indexOf(after) + 1 : others.length ? inst.indexOf(others[0]) : inst.length, 0, node);
  }
  return out;
}

/** The variant's (symbol_override "lib:id") on the instance, or "" (SCH_SYMBOL_VARIANT::m_SymbolOverride). */
export function symbolVariantOverride(sym: N, name: string, path?: string | null): string {
  if (isDefaultVariant(name)) return "";
  const v = symVariantIn(symbolInstance(sym, path), name), o = v ? kid(v, "symbol_override") : null;
  return o ? str(o[1]) : "";
}
/** SCH_SYMBOL::ClearVariantSymbolOverride: the override dropped (and the variant with it when nothing else differs). */
export function clearSymbolVariantOverride(sym: N, name: string, path?: string | null, ver?: number | null): N {
  const out = clone(sym), inst = symbolInstance(out, path), v = inst ? symVariantIn(inst, name) : null;
  if (!v) return out;
  for (let i = v.length - 1; i > 0; i--) { const c = v[i]; if (isList(c) && c[0] === "symbol_override") v.splice(i, 1); }
  return setSymbolVariant(out, name, {}, inst ? str(inst[1]) : path, ver);
}

/** A copy of the symbol as the variant shows it on its instance: flags and field texts replaced.  Same node when
 *  nothing changes. */
export function symbolViewForVariant(sym: N, variant: string | null | undefined, path?: string | null, ver?: number | null): N {
  const st = variant ? symbolVariant(sym, variant, path, ver) : null; if (!st) return sym;
  const base = symbolFlags(sym);
  if (!SYM_KEYS.some(([, f]) => st.flags[f] !== base[f]) && ![...st.fields].some(([k, v]) => { const p = kids(sym, "property").find((q) => str(q[1]) === k); return !!p && str(p[2]) !== v; })) return sym;
  const out = clone(sym);
  for (const [key, f, inv] of SYM_KEYS) {
    if (st.flags[f] === base[f]) continue;
    const val = (inv ? !st.flags[f] : st.flags[f]) ? "yes" : "no"; const k = kid(out, key);
    if (k) k[1] = val; else out.splice(2, 0, [key, val]);
  }
  for (const [k, v] of st.fields) { const p = kids(out, "property").find((q) => str(q[1]) === k); if (p) p[2] = v; }
  return out;
}

// ---------------------------------------------------------------- the variant registry operations (SCHEMATIC)
/** SCH_EDIT_FRAME::ValidateNewVariantName's message, or "" when the name may be used (`exclude`: the name being
 *  renamed). */
export function newVariantNameError(name: string, existing: string[], exclude = ""): string {
  if (!name) return "Variant name cannot be empty.";
  if (lower(name) === lower(DEFAULT_VARIANT_NAME)) return `'${DEFAULT_VARIANT_NAME}' is a reserved variant name.`;
  for (const e of existing) if (lower(e) === lower(name) && lower(e) !== lower(exclude)) return `Variant '${e}' already exists.`;
  return "";
}

/** The .kicad_pro registry (SCHEMATIC_SETTINGS::m_VariantDescriptions) as name → description. */
export function variantRegistry(pro: Record<string, unknown>): Map<string, string> {
  const sch = pro.schematic; const list = sch && typeof sch === "object" && !isList(sch) ? (sch as Record<string, unknown>).variants : undefined;
  const out = new Map<string, string>();
  if (isList(list)) for (const e of list as unknown[]) {
    if (!e || typeof e !== "object" || isList(e)) continue;
    const o = e as Record<string, unknown>; if (typeof o.name === "string") out.set(o.name, typeof o.description === "string" ? o.description : "");
  }
  return out;
}
/** Write the registry as SCHEMATIC_SETTINGS does: entries in name order, keys sorted (nlohmann), "description" only
 *  when not empty; a new "variants" key goes where the sorted keys put it. */
export function writeVariantRegistry(pro: Record<string, unknown>, reg: Map<string, string>): void {
  const arr = [...reg.keys()].sort(cmpCode).map((name) => { const d = reg.get(name) || ""; return d ? { description: d, name } : { name }; });
  let sch = pro.schematic as Record<string, unknown> | undefined;
  if (!sch || typeof sch !== "object" || isList(sch)) { sch = {}; pro.schematic = sch; }
  if ("variants" in sch) { sch.variants = arr; return; }
  const keys = Object.keys(sch); const rebuilt: Record<string, unknown> = {}; let placed = false;
  for (const k of keys) { if (!placed && k > "variants") { rebuilt.variants = arr; placed = true; } rebuilt[k] = sch[k]; }
  if (!placed) rebuilt.variants = arr;
  for (const k of keys) delete sch[k];
  Object.assign(sch, rebuilt);
}

/** Rename / copy / delete one variant in every instance of a symbol (or sheet).  Returns the copy, or the same node
 *  when nothing changed. */
export function renameSymbolVariants(sym: N, from: string, to: string | null, copy = false): N {
  let changed = false; const out = clone(sym);
  for (const inst of symbolInstancePaths(out)) {
    const v = symVariantIn(inst, from); if (!v) continue;
    changed = true;
    if (to === null) { inst.splice(inst.indexOf(v), 1); continue; }
    const nv = copy ? clone(v) : v; const nm = kid(nv, "name"); if (nm) nm[1] = to;
    if (copy) {
      const others = kids(inst, "variant"); const after = others.filter((x) => cmpCode(str((kid(x, "name") || [])[1]), to) < 0).pop();
      inst.splice(after ? inst.indexOf(after) + 1 : inst.indexOf(others[0]), 0, nv);
    } else {
      // std::map order after the rename
      inst.splice(inst.indexOf(nv), 1);
      const others = kids(inst, "variant"); const after = others.filter((x) => cmpCode(str((kid(x, "name") || [])[1]), to) < 0).pop();
      inst.splice(after ? inst.indexOf(after) + 1 : others.length ? inst.indexOf(others[0]) : inst.length, 0, nv);
    }
  }
  return changed ? out : sym;
}

const variantName = (v: N): string => str((kid(v, "name") || [])[1]);
/** Put `node` among the instance's variants in std::map order (by name). */
function insertVariantSorted(inst: N, node: N): void {
  const others = kids(inst, "variant"), name = variantName(node);
  const after = others.filter((x) => cmpCode(variantName(x), name) < 0).pop();
  inst.splice(after ? inst.indexOf(after) + 1 : others.length ? inst.indexOf(others[0]) : inst.length, 0, node);
}

/** The symbol (or sheet) `cur` with its instances' variants named in `names` put back as `snap` holds them (matched
 *  by instance path); every other variant, field and flag stays as `cur` has it, so a peer's edits made since the
 *  snapshot survive an undo / redo of a variant command (VARIANT_PROXY_UNDO_ITEM swaps only the variant data).
 *  The same node when nothing changes. */
export function restoreSymbolVariants(cur: N, snap: N, names: string[]): N {
  if (!names.length) return cur;
  const want = new Set(names), out = clone(cur); let changed = false;
  const snapInst = new Map<string, N>(); for (const p of symbolInstancePaths(snap)) snapInst.set(str(p[1]), p);
  for (const inst of symbolInstancePaths(out)) {
    const src = snapInst.get(str(inst[1]));
    const wanted = src ? kids(src, "variant").filter((v) => want.has(variantName(v))) : [];
    const have = kids(inst, "variant").filter((v) => want.has(variantName(v)));
    if (JSON.stringify(wanted) === JSON.stringify(have)) continue;
    changed = true;
    for (const v of have) inst.splice(inst.indexOf(v), 1);
    for (const v of wanted) insertVariantSorted(inst, clone(v));
  }
  return changed ? out : cur;
}

/** One registry entry before and after a command (undefined: absent). */
export interface RegistryDelta { name: string; before?: string; after?: string }
/** The entries a command changed in the registry. */
export function registryDelta(before: Map<string, string>, after: Map<string, string>): RegistryDelta[] {
  const out: RegistryDelta[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k) || before.has(k) !== after.has(k)) out.push({ name: k, before: before.get(k), after: after.get(k) });
  return out;
}
/** Apply the command's entries (`which` side) to the registry as it stands now; the other entries (a peer's) stay. */
export function applyRegistryDelta(reg: Map<string, string>, delta: RegistryDelta[], which: "before" | "after"): void {
  for (const d of delta) { const v = d[which]; if (v === undefined) reg.delete(d.name); else reg.set(d.name, v); }
}
