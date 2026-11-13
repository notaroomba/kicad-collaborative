import type { SchCtx } from "./types";
import { root } from "../root";
import { insertField } from "./annotate";
import { setReference } from "./clipboard";
import { fontNode } from "./nodes";
import { atOf, kids, str } from "./state";
import { deep, modChange } from "./util";

// ---------------------------------------------------------------- symbol fields table (Tools → Symbol Fields Table)
// the pattern matches every string (both groups may be empty), hence the non-null assertions
export const refCmp = (a: unknown, b: unknown) => { const ma = str(a).match(/^(.*?)(\d*)$/)!, mb = str(b).match(/^(.*?)(\d*)$/)!; return ma[1].localeCompare(mb[1]) || ((+ma[2] || 0) - (+mb[2] || 0)) || str(a).localeCompare(str(b)); };
/** A row of the fields table: a symbol and its field values by name. */
export interface FieldsRow { id: string; ref: string; values: Record<string, string> }
/** An edit of the table: new field values (by name) for one symbol. */
export interface FieldsEdit { id: string; values?: Record<string, unknown> }
export function fieldsTableRows(doc: KDoc) {
  const fields = ["Reference", "Value", "Footprint", "Datasheet"], rows: FieldsRow[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const values: Record<string, string> = {};
    for (const p of kids(it.node, "property")) { const nm = str(p[1]); if (nm.startsWith("ki_")) continue; values[nm] = str(p[2]); if (!fields.includes(nm)) fields.push(nm); }
    rows.push({ id: it.id, ref: values.Reference || "", values });
  }
  rows.sort((a, b) => refCmp(a.ref, b.ref));
  return { fields, rows };
}
// edits: [{ id, values: { name: text } }] -> one MODIFIED change per symbol that actually changed
export function fieldsTableChanges(doc: KDoc, edits: FieldsEdit[] | null | undefined) {
  const out: KChange[] = [];
  for (const e of edits || []) {
    const it = doc.items.get(e.id); if (!it || it.kind !== "symbol") continue;
    const n = deep(it.node); let changed = false;
    for (const [name, text] of Object.entries(e.values || {})) {
      let p = kids(n, "property").find((q) => str(q[1]) === name);
      if (!p) { if (str(text) === "") continue; p = ["property", name, "", ["at", ...atOf(n).slice(0, 2), 0], ["hide", "yes"], ["effects", fontNode(1.27)]]; insertField(n, p); }
      if (str(p[2]) === str(text)) continue;
      if (name === "Reference") setReference(n, str(text)); else p[2] = str(text);
      changed = true;
    }
    if (changed) out.push(modChange(doc, it, n));
  }
  return out;
}
export function openFieldsTable(ctx: SchCtx) {
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null; if (!KD) return false;
  const doc = ctx.doc, table = fieldsTableRows(doc); if (!table.rows.length) { ctx.toast("No symbols on this sheet"); return false; }
  const escapeHtml = (s: unknown) => str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let fields = table.fields.slice(), body: HTMLElement | null = null;
  const render = () => {
    const ro = ctx.viewOnly ? " disabled" : "";
    body!.innerHTML = `<div style="overflow:auto;max-height:60vh"><table class="kd-table" style="border-collapse:collapse;font:12px var(--mono,ui-monospace,monospace)"><thead><tr>${fields.map((f) => `<th style="text-align:left;padding:2px 6px;border-bottom:1px solid var(--line,#ccc)">${escapeHtml(f)}</th>`).join("")}</tr></thead><tbody>${
      table.rows.map((r) => `<tr>${fields.map((f) => `<td style="padding:1px 3px"><input data-id="${escapeHtml(r.id)}" data-field="${escapeHtml(f)}" value="${escapeHtml(r.values[f] || "")}" style="width:${f === "Reference" ? 60 : 130}px"${ro}></td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="kd-note" style="margin-top:8px">Edit any cell; OK commits every changed symbol as one change.${ctx.viewOnly ? "" : ' <button class="btn sm" id="kd-addfield">Add field…</button>'}</p>`;
    const add = body!.querySelector("#kd-addfield");
    if (add) add.addEventListener("click", () => addField());
  };
  // DIALOG_FIELDS_TABLE::OnAddField: a wxTextEntryDialog in the themed dialog shell (never the browser's prompt)
  const addField = () => {
    let inp: HTMLInputElement | null = null;
    KD.open({ title: "Add Field", width: 340,
      build(b: HTMLElement) { b.innerHTML = '<p style="margin:0 0 8px">New field name:</p><input type="text" data-kd-newfield style="width:100%">'; inp = b.querySelector("input"); setTimeout(() => inp && inp.focus(), 0); },
      ok() {
        const name = inp ? inp.value : "";
        if (!name) { ctx.toast("Field must have a name."); return; }
        if (fields.some((f) => f.toLowerCase() === name.toLowerCase())) { ctx.toast(`Field name '${name}' already in use.`); return; }
        collect(); fields.push(name); render();
      } });
  };
  const collect = () => { for (const inp of body!.querySelectorAll<HTMLInputElement>("input[data-id]")) { const r = table.rows.find((x) => x.id === inp.dataset.id); if (r) r.values[inp.dataset.field!] = inp.value; } };
  const original = new Map(table.rows.map((r) => [r.id, Object.assign({}, r.values)]));
  KD.open({ title: "Symbol Fields Table", width: Math.min(960, 80 + fields.length * 150), readOnly: !!ctx.viewOnly,
    build(b: HTMLElement) { body = b; render(); },
    ok() {
      if (ctx.viewOnly) return; collect();
      const edits: FieldsEdit[] = [];
      for (const r of table.rows) { const o = original.get(r.id)!, values: Record<string, string> = {}; let any = false; for (const [k, v] of Object.entries(r.values)) if (str(o[k] || "") !== str(v)) { values[k] = v; any = true; } if (any) edits.push({ id: r.id, values }); }
      const changes = fieldsTableChanges(doc, edits); if (changes.length) ctx.commit(changes, "symbol fields");
    } });
  return true;
}
