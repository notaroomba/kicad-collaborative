// dialogs/change-symbols-logic.ts — the document half of Edit > Change Symbols… and Tools > Update Symbols from
// Library… (eeschema/dialogs/dialog_change_symbols.cpp, DIALOG_CHANGE_SYMBOLS::processSymbols): which symbols a
// scope matches, the field list the dialog offers, and what one symbol becomes when its library symbol is laid
// over it with the dialog's options.  Pure functions over s-expression nodes (the canvas reader's helpers), so the
// node tests load this file directly; the dialog (change-symbols.ts) fetches the library symbols and commits.

/** MANDATORY_FIELDS, in the order the dialog lists them (GetDefaultFieldName). */
export const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const META = /^ki_/;

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const isList = Array.isArray;
const clone = (n: SNode): SNode => (K().cloneNode as (x: SNode) => SNode)(n);
const kid = (n: SNode, k: string): SNode | null => K().kid(n, k) as SNode | null;
const kids = (n: SNode, k: string): SNode[] => K().kids(n, k) as SNode[];
const str = (v: unknown): string => K().str(v as SNode);

export interface UpdateOptions {
  mode: "update" | "change";
  /** checked names in Update/Reset Fields (mandatory fields by their untranslated name) */
  fields: Set<string>;
  removeExtras: boolean; resetEmpty: boolean; resetText: boolean; resetVisibility: boolean; resetEffects: boolean; resetPositions: boolean;
  resetAttributes: boolean; resetPinTextVisibility: boolean; resetAlternates: boolean; resetPinMaps: boolean; resetCustomPower: boolean;
}
export function defaultOptions(mode: "update" | "change"): UpdateOptions {
  const c = mode === "change";
  return { mode, fields: new Set(["Footprint", "Datasheet", "Description"]), removeExtras: false, resetEmpty: false, resetText: true, resetVisibility: c, resetEffects: c,
    resetPositions: c, resetAttributes: c, resetPinTextVisibility: c, resetAlternates: c, resetPinMaps: c, resetCustomPower: false };
}

// ---------------------------------------------------------------- fields
/** A property's name: KiCad 10 writes a private field as (property private "Name" "Value" …). */
export function propName(p: SNode): string { return str(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3]) ? str(p[2]) : str(p[1]); }
export function isPrivate(p: SNode): boolean { return str(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3]); }
const valueIdx = (p: SNode): number => (isPrivate(p) ? 3 : 2);
export function propValue(p: SNode): string { return str(p[valueIdx(p)]); }
/** The user fields of a node (placed or library symbol): no ki_ metadata. */
export function fieldsOf(n: SNode): SNode[] { return kids(n, "property").filter((p) => !META.test(propName(p))); }
export function fieldOf(n: SNode, name: string): SNode | null { return fieldsOf(n).find((p) => propName(p) === name) || null; }
function hidden(p: SNode): boolean {
  const hk = kid(p, "hide"); if (hk) return str(hk[1]) !== "no";
  if (p.includes("hide")) return true;
  const e = kid(p, "effects"); if (!e) return false;
  const eh = kid(e, "hide"); return eh ? str(eh[1]) !== "no" : e.includes("hide");
}
function setHidden(p: SNode, hide: boolean): void {
  for (let i = p.length - 1; i >= 1; i--) if (p[i] === "hide" || (isList(p[i]) && (p[i] as SNode)[0] === "hide")) p.splice(i, 1);
  const e = kid(p, "effects"); if (e) for (let i = e.length - 1; i >= 1; i--) if (e[i] === "hide" || (isList(e[i]) && (e[i] as SNode)[0] === "hide")) e.splice(i, 1);
  if (hide) { const at = p.findIndex((c) => isList(c) && c[0] === "at"); p.splice(at > 0 ? at + 1 : p.length, 0, ["hide", "yes"]); }
}
function setKid(p: SNode, node: SNode, after: string[]): void {
  const i = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === node[0]);
  if (i > 0) { p[i] = node; return; }
  let at = -1; for (const a of after) { const j = p.findIndex((c, k) => k > 0 && isList(c) && c[0] === a); if (j > at) at = j; }
  p.splice(at > 0 ? at + 1 : p.length, 0, node);
}
const yesNo = (n: SNode | null, def: boolean): boolean => { if (!n) return def; const v = str(n[1]); return v === "" ? true : v !== "no"; };
/** (at x y rot) of a library field placed on a symbol at `pos`: library Y points up (the file flips it). */
function libFieldAt(lib: SNode, pos: number[], rot?: number): SNode {
  const a = kid(lib, "at"); const lx = a ? K().num(a[1]) : 0, ly = a ? K().num(a[2]) : 0, lr = a ? K().num(a[3]) : 0;
  const r4 = (v: number) => +v.toFixed(4);
  return ["at", r4(pos[0] + lx), r4(pos[1] - ly), rot === undefined ? lr : rot];
}

// ---------------------------------------------------------------- references (UTIL::GetRefDes*)
export function refPrefix(ref: string): string { return ref.replace(/[0-9?]+$/, ""); }
export function refNumber(ref: string): number { const m = /(\d+)$/.exec(ref); return m && !/\?$/.test(ref) ? Number(m[1]) : -1; }

export interface RefContext { used: Set<string>; renamed: Map<string, string> }
/** The (instances (project …) (path "…" (reference "R1") (unit 1))) entries of a placed symbol. */
export function instancePaths(n: SNode): SNode[] { const inst = kid(n, "instances"); const out: SNode[] = []; if (inst) for (const pr of kids(inst, "project")) out.push(...kids(pr, "path")); return out; }
/** Every reference a sheet's symbols use (base references, as SCH_SYMBOL::GetBaseRef returns them). */
export function sheetRefs(doc: KDoc): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const paths = instancePaths(it.node);
    if (paths.length) for (const p of paths) { const r = kid(p, "reference"); if (r) out.push(str(r[1])); }
    else { const f = fieldOf(it.node, "Reference"); if (f) out.push(propValue(f)); }
  }
  return out;
}

// ---------------------------------------------------------------- matching
export type Scope = "all" | "selected" | "reference" | "value" | "libid";
/** WildCompareString( pattern, text, false ): * and ?, case-insensitive. */
export function wild(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(text);
}
export function symbolRefs(n: SNode): string[] {
  const r = instancePaths(n).map((p) => { const x = kid(p, "reference"); return x ? str(x[1]) : ""; }).filter(Boolean);
  if (r.length) return r;
  const f = fieldOf(n, "Reference"); return f ? [propValue(f)] : [];
}
export const libIdOf = (n: SNode): string => { const l = kid(n, "lib_id"); return l ? str(l[1]) : ""; };
/** DIALOG_CHANGE_SYMBOLS::isMatch. */
export function isMatch(n: SNode, scope: Scope, arg: string, selected: boolean): boolean {
  switch (scope) {
    case "all": return true;
    case "selected": return selected;
    case "reference": return symbolRefs(n).some((r) => wild(arg, r));
    case "value": { const v = fieldOf(n, "Value"); return wild(arg, v ? propValue(v) : ""); }
    case "libid": return libIdOf(n) === arg;
    default: return false;
  }
}
/** The non-mandatory, non-private field names of the matching symbols (and of their library symbols). */
export function fieldNames(nodes: SNode[], libs: SNode[]): string[] {
  const set = new Set<string>();
  for (const n of nodes.concat(libs)) for (const p of fieldsOf(n)) { const name = propName(p); if (!MANDATORY.includes(name) && !isPrivate(p)) set.add(name); }
  return Array.from(set).sort();
}

// ---------------------------------------------------------------- one symbol
/** The library's unit count: Name_<unit>_<style> sub-symbols. */
export function libUnits(lib: SNode): number {
  let n = 1; for (const s of kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}
function libPins(lib: SNode): SNode[] {
  const out: SNode[] = [];
  for (const s of kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (m && Number(m[2]) > 1) continue; out.push(...kids(s, "pin")); }
  return out;
}
const isPowerLib = (lib: SNode): boolean => !!kid(lib, "power");

/**
 * processSymbols for one placed symbol: `node` (a copy, changed in place and returned) takes `lib` (the flattened
 * library symbol, already embedded under `libId`) with the dialog's options.  `refs` is shared by every symbol of
 * one run so a prefix change never reuses a reference another symbol has (usedRefs / renamedRefs).
 */
export function updateSymbolNode(node: SNode, lib: SNode, libId: string, o: UpdateOptions, refs: RefContext, newUuid: () => string): SNode {
  const n = node;
  // SetLibId and SetSchSymbolLibraryName( "" ): the symbol now points at the library copy by its id
  const li = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === "lib_id"); if (li > 0) n[li] = ["lib_id", libId];
  const ln = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === "lib_name"); if (ln > 0) n.splice(ln, 1);
  const pos = (kid(n, "at") || ["at", 0, 0]).slice(1, 3).map((v) => K().num(v as SNode));
  if (o.resetAttributes) {
    for (const [key, def] of [["exclude_from_sim", false], ["in_bom", true], ["on_board", true], ["in_pos_files", true]] as [string, boolean][]) {
      const v = yesNo(kid(lib, key), def) ? "yes" : "no";
      setKid(n, ["" + key, v], ["unit", "body_style", "convert", "mirror", "at", "lib_id"]);
    }
  }
  if (o.resetPinTextVisibility) for (const key of ["pin_names", "pin_numbers"]) {
    const l = kid(lib, key), mine = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === key);
    if (mine > 0) { if (l) n[mine] = clone(l); else n.splice(mine, 1); }
  }
  // the fields, last to first (removing as it goes)
  const props = n.map((c, j) => [c, j] as [SNode, number]).filter(([c, j]) => j > 0 && isList(c) && c[0] === "property" && !META.test(propName(c)));
  for (let k = props.length - 1; k >= 0; k--) {
    const [field] = props[k]; const name = propName(field);
    const doUpdate = isPrivate(field) || o.fields.has(name);
    if (!doUpdate) continue;
    const libField = fieldOf(lib, name);
    if (libField) {
      const lt = propValue(libField);
      const resetText = lt === "" ? o.resetEmpty : o.resetText;
      if (resetText) {
        if (name === "Reference") {
          const prefix = refPrefix(lt);
          let first = "";
          const setRef = (oldRef: string): string => {
            let number = refNumber(oldRef), ref: string; const renamed = refs.renamed.get(oldRef);
            if (number < 0) ref = prefix + "?";
            else if (renamed && refPrefix(renamed) === prefix) ref = renamed;          // keep the units of a multi-unit symbol together
            else {
              ref = prefix + number;
              if (ref !== oldRef) { while (refs.used.has(ref)) ref = prefix + (++number); refs.used.add(ref); refs.renamed.set(oldRef, ref); }
            }
            return ref;
          };
          const paths = instancePaths(n);
          if (paths.length) for (const p of paths) { const r = kid(p, "reference"); if (!r) continue; const nr = setRef(str(r[1])); r[1] = nr; if (!first) first = nr; }
          else first = setRef(propValue(field));
          field[valueIdx(field)] = first;
        } else if (name === "Value") {
          if (!isPowerLib(lib) || o.resetCustomPower) field[valueIdx(field)] = lt;
        } else field[valueIdx(field)] = lt;
      }
      if (o.resetVisibility) setHidden(field, hidden(libField));
      if (o.resetEffects) {
        const vis = !hidden(field), at = kid(field, "at");
        const le = kid(libField, "effects"); if (le) { const e = clone(le); for (let i = e.length - 1; i >= 1; i--) if (e[i] === "hide" || (isList(e[i]) && (e[i] as SNode)[0] === "hide")) e.splice(i, 1); setKid(field, e, ["at", "hide", "show_name", "do_not_autoplace"]); }
        // SetAttributes carries the text angle; the position and the visibility stay
        if (at) { const la = kid(libField, "at"); at[3] = la ? K().num(la[3]) : 0; }
        setHidden(field, !vis);
        for (const key of ["show_name", "do_not_autoplace"]) setKid(field, [key, yesNo(kid(libField, key), false) ? "yes" : "no"], ["at", "hide"]);
      }
      if (o.resetPositions) { const at = kid(field, "at"); const nat = libFieldAt(libField, pos, at ? K().num(at[3]) : undefined); if (at) { at[1] = nat[1]; at[2] = nat[2]; } else setKid(field, nat, []); }
    } else if (!MANDATORY.includes(name) && o.removeExtras) {
      const idx = n.indexOf(field); if (idx > 0) n.splice(idx, 1);
    }
  }
  // fields the library has and the symbol lacks
  for (const lf of fieldsOf(lib)) {
    const name = propName(lf); if (MANDATORY.includes(name) || !o.fields.has(name) || fieldOf(n, name)) continue;
    const f: SNode = ["property", name, propValue(lf), libFieldAt(lf, pos)];
    if (hidden(lf)) f.push(["hide", "yes"]);
    f.push(["show_name", yesNo(kid(lf, "show_name"), false) ? "yes" : "no"], ["do_not_autoplace", yesNo(kid(lf, "do_not_autoplace"), false) ? "yes" : "no"]);
    const le = kid(lf, "effects"); if (le) { const e = clone(le); for (let i = e.length - 1; i >= 1; i--) if (e[i] === "hide" || (isList(e[i]) && (e[i] as SNode)[0] === "hide")) e.splice(i, 1); f.push(e); }
    let at = -1; for (let j = 1; j < n.length; j++) if (isList(n[j]) && (n[j] as SNode)[0] === "property") at = j;
    n.splice(at > 0 ? at + 1 : n.length, 0, f);
  }
  // SetLibSymbol -> UpdatePins: one (pin …) per library pin, kept by number (uuid, alternate), new ones get a uuid
  const old = new Map<string, SNode>(); for (const p of kids(n, "pin")) old.set(str(p[1]), p);
  const pins: SNode[] = []; const seen = new Set<string>();
  for (const lp of libPins(lib)) {
    const num = kid(lp, "number"); const number = num ? str(num[1]) : ""; if (seen.has(number)) continue; seen.add(number);
    const mine = old.get(number); const p: SNode = mine ? clone(mine) : ["pin", number, ["uuid", newUuid()]];
    // alternates: cleared when asked, when set to the base name, or when the library has no such alternate any more
    const ai = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === "alternate");
    if (ai > 0) {
      const alt = str((p[ai] as SNode)[1]), base = kid(lp, "name"), alts = kids(lp, "alternate").map((a) => str(a[1]));
      if (o.resetAlternates || (base && alt === str(base[1])) || !alts.includes(alt)) p.splice(ai, 1);
    }
    pins.push(p);
  }
  for (let j = n.length - 1; j >= 1; j--) if (isList(n[j]) && (n[j] as SNode)[0] === "pin") n.splice(j, 1);
  let at = -1; for (let j = 1; j < n.length; j++) if (isList(n[j]) && ((n[j] as SNode)[0] === "property" || (n[j] as SNode)[0] === "uuid")) at = j;
  n.splice(at > 0 ? at + 1 : n.length, 0, ...pins);
  return n;
}

/** getSymbolReferences: "Update symbol R1 from 'Device:R' to 'Device:R'" (plural with several instances). */
export function reportLine(mode: "update" | "change", refs: string[], oldId: string, newId: string): string {
  const verb = mode === "update" ? "Update" : "Change";
  return `${verb} ${refs.length === 1 ? "symbol" : "symbols"} ${refs.join(" ")} from '${oldId}' to '${newId}'`;
}
