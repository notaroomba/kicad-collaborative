// prop-text.ts — the Properties grid's value as text (no React here, so node tests can load it).

/** wxPGProperty::GetValueAsString: what Ctrl+C copies from the selected row (wxBoolProperty: True / False, a choice's label). */
export function rowValueText(row: { type: string; value: string; mixed: boolean; choices?: [string, string][] }): string {
  if (row.mixed) return "";
  if (row.type === "bool") return row.value === "1" ? "True" : "False";
  if (row.type === "enum" && row.choices) { const c = row.choices.find(([v]) => v === row.value); return c ? c[1] : row.value; }
  return row.value;
}
