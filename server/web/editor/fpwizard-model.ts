// editor/fpwizard-model.ts — what a footprint wizard answers (see fpwizard.ts for the requests), checked and shown.

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
/** What the Units column shows for a parameter's unit (nothing for a choice, a checkbox or a plain number). */
export function unitsLabel(units: string): string {
  if (units.includes(",")) return "";
  return ({ mm: "mm", mils: "mils", degrees: "deg", radians: "rad", "%": "%" } as Record<string, string>)[units] || "";
}
/** The values of every page, in order: what a "build" request carries. */
export const pageValues = (st: WizardState): string[][] => st.pages.map((p) => p.params.map((q) => q.value));
/** The build message box (RegenerateFootprint): the wizard's description when it built a footprint, else why not. */
export const buildMessage = (st: WizardState): string => (st.footprint ? st.description || st.messages : st.messages || "The wizard did not build a footprint.");


type Node = unknown[];
/** A wizard's footprint as a new library footprint: at the origin (BeginNewFootprint, SetPosition( 0, 0 ): no
 *  position, orientation, lock or placement), with the header a new footprint is written with.  Changed in place,
 *  so the parser's record of which atoms were quoted stays with the node. */
export function wizardFootprintTree(t: Node, version: number, parse: (s: string) => unknown): Node {
  const drop = new Set(["at", "uuid", "path", "sheetname", "sheetfile", "locked", "placed", "version", "generator", "generator_version"]);
  for (let i = t.length - 1; i >= 2; i--) { const c = t[i]; if (Array.isArray(c) && drop.has(String(c[0]))) t.splice(i, 1); }
  t.splice(2, 0, parse(`(version ${version})`), parse('(generator "pcbnew")'), parse('(generator_version "10.0")'));
  return t;
}
