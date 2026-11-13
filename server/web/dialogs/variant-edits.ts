// dialogs/variant-edits — writing a dialog's edits into the current design variant (pure): DIALOG_SYMBOL_PROPERTIES'
// TransferDataFromWindow and the Symbol Fields Table's data model with a current variant send the field texts (but
// the Reference) and the attribute flags to the symbol instance's (variant …) through SCH_SYMBOL::SetFieldText(
// …, variant ) / SetDNP( …, variant ) …; the symbol keeps its own texts and flags.
import * as VM from "../canvas/variant-model";
import * as L from "./sch-items-logic";

/** The symbol flags as (key, inverted) pairs, the order SCH_IO writes them. */
export const FLAG_KEYS: [string, keyof VM.SymFlags, boolean][] = [["exclude_from_sim", "excludedFromSim", false], ["in_bom", "excludedFromBOM", true], ["on_board", "excludedFromBoard", true], ["in_pos_files", "excludedFromPosFiles", true], ["dnp", "dnp", false]];

/** DIALOG_SYMBOL_PROPERTIES::TransferDataFromWindow with a current variant: the fields' texts (but the Reference)
 *  and the attribute flags go to the symbol instance's variant (SCH_FIELD::SetText( text, path, variant ),
 *  SetDNP( …, variant ) …); the symbol keeps its own (default) texts and flags.  `edited` is the symbol as the dialog
 *  wrote it (its fields and flags holding what the user saw), `base` the symbol before the dialog. */
export function writeSymbolVariant(edited: SNode, base: SNode, variant: string, path: string | null): SNode {
  const n = L.clone(edited), fields: Record<string, string> = {};
  for (const p of L.kids(n, "property")) {
    const name = L.fieldName(p); if (name === "Reference") continue;
    const old = L.kids(base, "property").find((q) => L.fieldName(q) === name); if (!old) continue;   // a new field is the symbol's own
    fields[name] = L.fieldValue(p);
    const vi = p.findIndex((c, j) => j > 0 && !Array.isArray(c) && L.str(c) !== "private") + 1;   // the value after the name
    const oi = old.findIndex((c, j) => j > 0 && !Array.isArray(c) && L.str(c) !== "private") + 1;
    if (vi > 0 && oi > 0) p[vi] = old[oi];
  }
  const shown = VM.symbolFlags(n), flags: Partial<VM.SymFlags> = {};
  for (const [key, f] of FLAG_KEYS) {
    flags[f] = shown[f];
    const b = L.kid(base, key), i = n.findIndex((c) => Array.isArray(c) && c[0] === key);
    if (b && i > 0) n[i] = L.clone(b); else if (b) L.put(n, key, [L.str(b[1])], ["fields_autoplaced", "stroke", "uuid", "property"]); else if (i > 0) n.splice(i, 1);
  }
  return VM.setSymbolVariant(n, variant, { flags, fields }, path);
}

/** The SymRow flag names as SCH_SYMBOL's variant flags. */
const VARIANT_FLAG: Record<string, keyof VM.SymFlags> = { dnp: "dnp", excludeBom: "excludedFromBOM", excludeBoard: "excludedFromBoard", excludeSim: "excludedFromSim", excludePos: "excludedFromPosFiles" };
/** A document whose symbols show as `variant` has them (FIELDS_EDITOR_GRID_DATA_MODEL with a current variant). */
export function variantDocView(d: Pick<KDoc, "items">, variant: string): Pick<KDoc, "items"> {
  if (!variant) return d;
  const items = new Map<string, KItem>();
  for (const [id, it] of d.items) items.set(id, it.kind === "symbol" ? Object.assign({}, it, { node: VM.symbolViewForVariant(it.node, variant, null) }) : it);
  return { items };
}
/** The edits of one symbol written into its instance's variant: field texts (but the Reference, which is not variant
 *  data) and flags.  Returns the new node, or null when nothing changes. */
export function variantEditNode(node: SNode, variant: string, values: Record<string, string>, flags: Record<string, boolean>): SNode | null {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (k !== "Reference" && L.kids(node, "property").some((p) => L.fieldName(p) === k)) fields[k] = v;
  const f: Partial<VM.SymFlags> = {}; for (const [k, v] of Object.entries(flags)) if (VARIANT_FLAG[k]) f[VARIANT_FLAG[k]] = v;
  if (!Object.keys(fields).length && !Object.keys(f).length) return null;
  const out = VM.setSymbolVariant(node, variant, { fields, flags: f }, null);
  return JSON.stringify(out) === JSON.stringify(node) ? null : out;
}

