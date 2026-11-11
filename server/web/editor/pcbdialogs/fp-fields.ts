// pcbdialogs/fp-fields — Tools > Bulk Edit Footprint Fields… (DIALOG_FOOTPRINT_FIELDS_TABLE, "Footprint
// Fields Table"): every footprint of the board against its fields, edited in place; OK / Apply store the
// edited footprints as one undoable change.  Fields are edited where they exist; adding a field to a
// footprint is done in its Footprint Properties.
import { E } from "../state";
import { checkField, grid, h, openDialog, textField, type CellValue, type GridColumn } from "./ui";

const isList = Array.isArray;
export interface FpField { name: string; value: string; node: SNode; slot: number }
/** The fields of a footprint node: (property "Name" "value" …) and, on older boards, (fp_text reference|value …). */
export function footprintFields(fp: SNode): FpField[] {
  const out: FpField[] = [];
  for (const c of fp) {
    if (!isList(c)) continue;
    if (c[0] === "property" && typeof c[1] === "string" && c.some((x) => isList(x))) out.push({ name: c[1], value: String(c[2] ?? ""), node: c, slot: 2 });
    else if (c[0] === "fp_text" && (c[1] === "reference" || c[1] === "value")) out.push({ name: c[1] === "reference" ? "Reference" : "Value", value: String(c[2] ?? ""), node: c, slot: 2 });
  }
  return out;
}
const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The changes that store edited field values: one MODIFIED per footprint that differs. */
export function fieldChanges(doc: KDoc, edits: Map<string, Record<string, string>>): KChange[] {
  const changes: KChange[] = [];
  for (const [id, values] of edits) {
    const it = doc.items.get(id); if (!it) continue;
    const node = (KiCadCanvas.cloneNode as (n: SNode) => SNode)(it.node); let any = false;
    for (const f of footprintFields(node)) if (f.name in values && values[f.name] !== f.value) { f.node[f.slot] = values[f.name]; any = true; }
    if (any) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node }));
  }
  return changes;
}

export function openFootprintFields(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("The Footprint Fields Table needs a board"); return; }
  const ro = !!E.viewOnly;
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint");
  const names: string[] = [];
  const data = fps.map((it) => {
    const row: Record<string, CellValue> = { id: it.id, Footprint: String(it.node[1] ?? "") };
    for (const f of footprintFields(it.node)) { if (!(f.name in row)) row[f.name] = f.value; if (f.name !== "Footprint" && !names.includes(f.name)) names.push(f.name); }
    return row;
  }).sort((a, b) => natural(String(a.Reference || ""), String(b.Reference || "")));
  const order = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
  const all = [...order.filter((n) => n === "Footprint" || names.includes(n)), ...names.filter((n) => !order.includes(n))];
  const shown = new Set(all.filter((n) => n !== "Datasheet" || data.some((r) => r.Datasheet)));
  const original = new Map(data.map((r) => [String(r.id), { ...r }]));
  let filter = "";
  const host = h("div", { style: "flex:1 1 auto;min-width:0" });
  const visible = (): Record<string, CellValue>[] => (filter ? data.filter((r) => all.some((n) => String(r[n] ?? "").toLowerCase().includes(filter))) : data);
  const draw = (): void => {
    const cols: GridColumn[] = all.filter((n) => shown.has(n)).map((n) => ({ label: n, key: n, type: n === "Footprint" ? "ro" : "text", readOnly: (row) => !(n in (original.get(String(row.id)) || {})) }));
    host.replaceChildren(grid(cols, visible(), { ro, height: "420px", onSelect: (i) => { const r = visible()[i]; if (r) { ctx.setHighlight(new Set([String(r.id)])); ctx.requestRender(); } } }).el);
  };
  const collect = (): KChange[] => {
    const edits = new Map<string, Record<string, string>>();
    for (const r of data) { const o = original.get(String(r.id)) || {}; const v: Record<string, string> = {}; let any = false; for (const n of all) if (n !== "Footprint" && n in o && String(r[n]) !== String(o[n])) { v[n] = String(r[n]); any = true; } if (any) edits.set(String(r.id), v); }
    return fieldChanges(doc, edits);
  };
  const apply = (): void => {
    const changes = collect();
    if (!changes.length) return;
    ctx.commit(changes, "Footprint Fields Table Edit");
    for (const r of data) original.set(String(r.id), { ...r });
    ctx.toast(`${changes.length} footprint${changes.length === 1 ? "" : "s"} updated`);
  };
  openDialog({ title: "Footprint Fields Table", width: 940, noEnter: true, readOnly: ro, extra: ro ? [] : [{ label: "Apply", fn: apply }],
    build(body) {
      const list = h("div", { class: "pd-fieldlist" }, h("div", { class: "pd-colhead" }, "Fields"));
      for (const n of all) list.append(checkField(shown.has(n), n, { key: "show-" + n, tip: "Show", onChange: (v) => { if (v) shown.add(n); else shown.delete(n); draw(); } }).el);
      const search = textField("", { placeholder: "Filter", key: "filter" });
      search.input.addEventListener("input", () => { filter = search.get().trim().toLowerCase(); draw(); });
      draw();
      body.append(h("div", { style: "display:flex;gap:12px;align-items:flex-start" }, h("div", { style: "flex:0 0 170px" }, search.el, list), host));
    },
    ok() { apply(); ctx.setHighlight(null); },
    cancel() { ctx.setHighlight(null); } });
}
