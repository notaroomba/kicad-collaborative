// editor/fpwizard-model.ts — what a footprint wizard answers (see fpwizard.ts for the requests), checked and shown.
import { evalExpr, formatLength } from "../tools/props/numeric";

export interface WizardParam { name: string; value: string; units: string; hint: string; designator: string; error: string }
export interface WizardPage { name: string; params: WizardParam[] }
export interface WizardState { name: string; description: string; pages: WizardPage[]; messages: string; footprint: string | null }

const s = (v: unknown, max = 4000): string => (v === undefined || v === null ? "" : String(v)).slice(0, max);
/** A wizard's answer, checked: what a plugin sends is never trusted to have the right shape. */
export function wizardState(out: unknown): WizardState {
  const o = (out && typeof out === "object" ? out : {}) as Record<string, unknown>;
  const pages: WizardPage[] = (Array.isArray(o.pages) ? o.pages : []).slice(0, 40).map((pg) => {
    const p = (pg && typeof pg === "object" ? pg : {}) as Record<string, unknown>;
    return { name: s(p.name, 120), params: (Array.isArray(p.params) ? p.params : []).slice(0, 200).map((x) => {
      const q = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { name: s(q.name, 200), value: s(q.value, 2000), units: s(q.units, 2000), hint: s(q.hint, 2000), designator: s(q.designator, 40), error: s(q.error, 4000) };
    }) };
  });
  return { name: s(o.name, 200), description: s(o.description, 2000), pages, messages: s(o.messages, 20000), footprint: typeof o.footprint === "string" && o.footprint.trim() ? o.footprint : null };
}
/**
 * The property a parameter is shown as (FOOTPRINT_WIZARD_PROPERTIES_PANEL::createPGProperty): a length in the
 * caller's user units (WPDT_DISTANCE, PGPROPERTY_SIZE + PG_UNIT_EDITOR), an angle in degrees (WPDT_ANGLE), an int,
 * a real, a checkbox, a choice (wxEnumProperty) or a string.
 */
export type ParamKind = "distance" | "angle" | "int" | "real" | "bool" | "enum" | "string";
export function paramKind(units: string): ParamKind {
  if (units.includes(",")) return "enum";
  switch (units) {
    case "mm": case "mils": return "distance";
    case "degrees": case "radians": return "angle";
    case "integer": return "int";
    case "float": case "%": return "real";
    case "bool": return "bool";
    default: return "string";
  }
}
const trim = (v: number, digits: number): string => { let t = v.toFixed(digits); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, ""); return t === "-0" ? "0" : t; };
/** A bool parameter's state (the Python wizards' "1"/"True"/"yes"). */
export const boolValue = (v: string): boolean => /^(1|true|t|y|yes|on)$/i.test(v.trim());
/** The wizard's value as its property shows it; `userUnits` is the frame's ("mm" | "mil" | "in"). */
export function paramDisplay(q: WizardParam, userUnits: string): string {
  const k = paramKind(q.units); const v = parseFloat(q.value);
  switch (k) {
    case "distance": return isFinite(v) ? formatLength(q.units === "mils" ? v * 0.0254 : v, userUnits) : q.value;
    case "angle": return isFinite(v) ? trim(q.units === "radians" ? v * 180 / Math.PI : v, 4) + "°" : q.value;
    case "int": return isFinite(v) ? String(Math.round(v)) : q.value;
    case "real": return isFinite(v) ? trim(v, 6) : q.value;
    case "bool": return boolValue(q.value) ? "1" : "0";
    default: return q.value;
  }
}
/** wxPropertyGrid's message for text a property cannot take (wxPG_VFB_SHOW_MESSAGE). */
export const INVALID_VALUE = "You have entered invalid value. Press ESC to cancel editing.";
/** Text typed into a property, as the wizard's own value (in its own units); null when the property cannot take it. */
export function paramParse(q: WizardParam, text: string, userUnits: string): string | null {
  const t = text.trim();
  switch (paramKind(q.units)) {
    case "distance": { const mm = evalExpr(t, userUnits); if (Number.isNaN(mm)) return null; return trim(q.units === "mils" ? mm / 0.0254 : mm, 6); }
    case "angle": { const d = evalExpr(t.replace(/°|deg/gi, ""), ""); if (Number.isNaN(d)) return null; return trim(q.units === "radians" ? d * Math.PI / 180 : d, 9); }
    case "int": return /^[-+]?\d+$/.test(t) ? String(parseInt(t, 10)) : null;
    case "real": { if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t.replace(",", "."))) return null; return trim(parseFloat(t.replace(",", ".")), 9); }
    case "bool": return boolValue(t) ? "1" : "0";
    case "enum": return q.units.split(",").map((c) => c.trim()).includes(t) ? t : null;
    default: return text;
  }
}
/** The property grid's categories (one wxPropertyCategory per WizardParameterCategory; a legacy wizard's pages). */
export function paramCategories(st: WizardState): { name: string; page: number; params: WizardParam[] }[] {
  return st.pages.map((p, i) => ({ name: p.name || `Page ${i + 1}`, page: i, params: p.params }));
}
/** The values of every page, in order: what a "build" request carries. */
export const pageValues = (st: WizardState): string[][] => st.pages.map((p) => p.params.map((q) => q.value));
/** The build message box (RegenerateFootprint): the wizard's description when it built a footprint, else why not. */
export const buildMessage = (st: WizardState): string => (st.footprint ? st.description || st.messages : st.messages || "The wizard did not build a footprint.");


type Node = unknown[];
/**
 * FOOTPRINT::GetMsgPanelInfo in the wizard frame (not a library frame, so the board editor's rows): reference /
 * value, Board Side, Rotation, Status / Attributes, Footprint / 3D-Shape, Doc / Keywords.
 */
export function wizardMsgPanel(t: Node | null): { title: string; value: string }[] {
  if (!Array.isArray(t) || t[0] !== "footprint") return [];
  const kids = (k: string) => t.filter((c): c is Node => Array.isArray(c) && c[0] === k);
  const kid = (k: string) => kids(k)[0] || null;
  const sv = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const prop = (n: string) => { const p = kids("property").find((c) => sv(c[1]) === n); return p ? sv(p[2]) : ""; };
  const out: { title: string; value: string }[] = [{ title: prop("Reference"), value: prop("Value") }];
  // GetSide: the footprint's layer when anything is on a side-specific layer (F.* / B.*), else unsided
  const layerList = (c: Node): string[] => { const l = c.find((x): x is Node => Array.isArray(x) && (x[0] === "layer" || x[0] === "layers")); return l ? l.slice(1).map(sv) : []; };
  // LSET::SideSpecificMask: the front and back copper and technical layers ("*.Cu", "*.Mask" hold both)
  const sided = (ls: string[]) => ls.some((l) => /^[FB*]\./.test(l));
  const items = t.filter((c): c is Node => Array.isArray(c) && /^(pad|fp_|zone)/.test(sv(c[0])));
  const fl = sv((kid("layer") || [])[1]) || "F.Cu";
  if (items.some((c) => sided(layerList(c)))) out.push({ title: "Board Side", value: fl === "B.Cu" ? "Back (Flipped)" : "Front" });
  const at = kid("at"); const rot = at && at.length > 3 ? parseFloat(sv(at[3])) || 0 : 0;
  out.push({ title: "Rotation", value: String(parseFloat(rot.toPrecision(4))) });
  const status: string[] = []; const attrs: string[] = []; const attr = (kid("attr") || []).slice(1).map(sv);
  const flag = (k: string) => { const c = kid(k); return !!c && (c.length < 2 || sv(c[1]) === "yes"); };
  if (flag("locked") || t.slice(1).some((x) => sv(x) === "locked")) status.push("Locked");
  if (flag("placed")) status.push("autoplaced");
  if (attr.includes("board_only")) attrs.push("not in schematic");
  if (attr.includes("exclude_from_pos_files")) attrs.push("exclude from pos files");
  if (attr.includes("exclude_from_bom")) attrs.push("exclude from BOM");
  if (flag("exclude_from_sim") || attr.includes("exclude_from_sim")) attrs.push("exclude from simulation");
  if (attr.includes("dnp") || flag("dnp")) attrs.push("DNP");
  out.push({ title: "Status: " + status.join(", "), value: "Attributes: " + attrs.join(", ") });
  const model = kid("model");
  out.push({ title: `Footprint: ${sv(t[1])}`, value: `3D-Shape: ${model ? sv(model[1]) : "<none>"}` });
  out.push({ title: `Doc: ${sv((kid("descr") || [])[1])}`, value: `Keywords: ${sv((kid("tags") || [])[1])}` });
  return out;
}
/** A wizard's footprint as a new library footprint: at the origin (BeginNewFootprint, SetPosition( 0, 0 ): no
 *  position, orientation, lock or placement), with the header a new footprint is written with.  Changed in place,
 *  so the parser's record of which atoms were quoted stays with the node. */
export function wizardFootprintTree(t: Node, version: number, parse: (s: string) => unknown): Node {
  const drop = new Set(["at", "uuid", "path", "sheetname", "sheetfile", "locked", "placed", "version", "generator", "generator_version"]);
  for (let i = t.length - 1; i >= 2; i--) { const c = t[i]; if (Array.isArray(c) && drop.has(String(c[0]))) t.splice(i, 1); }
  t.splice(2, 0, parse(`(version ${version})`), parse('(generator "pcbnew")'), parse('(generator_version "10.0")'));
  return t;
}
