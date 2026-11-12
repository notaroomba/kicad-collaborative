// kicad-dialogs/items.ts — the item properties dialog (props.js rows, staged) and the field properties
// dialog ("Edit Text and Field Properties").
import type { DlgApi } from "../../dialogs/dom";
import type { PanelCtx, PropsCtx } from "../props/panel";
import { type FieldFx, fieldAt, fieldEffects, fieldHidden, fieldLayer, fieldNode, fieldText, fieldUnlocked, setFieldAt, setFieldEffects, setFieldHidden, setFieldLayer, setFieldText, setFieldUnlocked } from "./fields";
import { root } from "../root";
import { K, PROPS, clone, esc, kids, num, str } from "./sexpr";
import { close, el, open } from "./shell";

/** An item the dialogs edit: a doc item, or (openNew) one that is not on the sheet yet. */
export type DialogItem = Pick<KItem, "id" | "kind" | "node" | "geom" | "bbox"> & Partial<KItem>;
/** The editor context the dialogs are opened with (the chrome's toolCtx()). */
export type DialogCtx = Omit<PropsCtx, "setSelected"> & { setSelected?(fp: { id: string } | null): void; toast?(msg: string, ms?: number): void; enterSheet?(file: string): void };
/** openItem's options: a title / width override, the undo label, a new item's placement, or the generic sheet. */
export interface ItemOpts { title?: string; width?: number; label?: string; generic?: boolean; onCreate?(node: SNode): boolean | void }

export const TITLES: Record<string, string> = { symbol: "Symbol Properties", footprint: "Footprint Properties", wire: "Wire & Bus Line Properties", bus: "Wire & Bus Line Properties", polyline: "Line Properties",
  label: "Label Properties", global_label: "Global Label Properties", hierarchical_label: "Hierarchical Label Properties", netclass_flag: "Directive Label Properties", directive_label: "Directive Label Properties",
  text: "Text Properties", gr_text: "Text Properties", text_box: "Text Box Properties", gr_text_box: "Text Box Properties", junction: "Junction Properties", no_connect: "No Connect Properties",
  bus_entry: "Bus Entry Properties", sheet: "Sheet Properties", segment: "Track & Via Properties", arc: "Track & Via Properties", via: "Track & Via Properties", zone: "Zone Properties",
  dimension: "Dimension Properties", image: "Image Properties", table: "Table Properties", rectangle: "Graphic Item Properties", circle: "Graphic Item Properties", bezier: "Graphic Item Properties",
  gr_line: "Graphic Item Properties", gr_rect: "Graphic Item Properties", gr_circle: "Graphic Item Properties", gr_arc: "Graphic Item Properties", gr_poly: "Graphic Item Properties", gr_curve: "Graphic Item Properties", rule_area: "Rule Area Properties" };

// ---------------------------------------------------------------- item properties (props.js rows, staged)
export function openItem(ctx: DialogCtx, item: DialogItem, opts?: ItemOpts): DlgApi | null {
  // board items with a KiCad dialog of their own (web/editor/pcbdialogs/item-props.ts); opts.generic asks for this sheet
  if (item && root.KDialogs.pcbItemDialog && !(opts && opts.generic) && root.KDialogs.pcbItemDialog(ctx, item)) return null;
  // eeschema's own dialogs (web/dialogs/sch-items.ts): labels, text, lines, junctions, shapes, images, sheets, symbols
  if (item && root.KDialogs.schItemDialog && ctx.doc && ctx.doc.type === "sch" && root.KDialogs.schItemDialog(ctx, item, opts || {})) return null;
  const P = PROPS(); if (!P || !P.renderInto || !item) return null;
  const doc = ctx.doc, Kc = K();
  const staged = clone(item.node); let dirty = false;
  const work = () => Object.assign({}, item, { node: staged });
  const sctx = Object.assign({}, ctx, { commit() {}, setSelected() {} }) as PanelCtx;   // the dialogs open on a loaded document
  const title = (opts && opts.title) || TITLES[item.kind] || ((P.KIND_NAMES && P.KIND_NAMES[item.kind]) || item.kind) + " Properties";
  const extra: { label: string; fn: () => void }[] = [];
  if (item.kind === "sheet" && ctx.enterSheet) { const file = str((kids(item.node, "property").find((p) => str(p[1]) === "Sheetfile") || [])[2]); if (file) extra.push({ label: "Enter Sheet", fn: () => { close(); ctx.enterSheet!(file); } }); }
  const fieldNames = (item.kind === "symbol" || item.kind === "footprint") ? kids(item.node, "property").map((p) => str(p[1])).filter((n) => !n.startsWith("ki_")) : [];
  let api: DlgApi | null = null;
  const render = (focusKey?: string): void => {
    api!.body.innerHTML = "";
    const host = el("div"); api!.body.appendChild(host);
    P.renderInto(host, sctx, work(), { quiet: true, creating: !!(opts && opts.onCreate), stage(label, fn) { const a = document.activeElement as HTMLElement | null; const key = a && a.dataset ? a.dataset.k : undefined; if (fn(staged) !== false) dirty = true; render(key); } });
    if (fieldNames.length) {
      const row = el("div", "kd-note"); row.style.marginTop = "10px"; row.textContent = "Field properties: ";
      for (const n of fieldNames) { const b = el("button", "btn sm", esc(n) + "…"); b.style.marginRight = "4px"; b.addEventListener("click", () => { commitStaged(); openField(ctx, doc!.items.get(item.id) || item, n); }); row.appendChild(b); }
      api!.body.appendChild(row);
    }
    if (focusKey !== undefined) api!.refocus(focusKey);
  };
  const commitStaged = (): boolean | void => {
    if (opts && opts.onCreate) return opts.onCreate(staged);   // a new item: the caller places it (false keeps the dialog open)
    if (!dirty || ctx.viewOnly) return;
    const change = Kc.replaceChange(doc!, Object.assign({}, item, { node: staged, geom: [], bbox: null }) as KItem);
    ctx.commit([change], (opts && opts.label) || "properties"); dirty = false;
    if (ctx.setSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
  };
  api = open({ title, width: opts && opts.width, extra, readOnly: !!ctx.viewOnly, build(body, a) { api = a; render(); }, ok() { return commitStaged(); } });   // build runs inside open(): take the api from it
  return api;
}

/** The properties dialog of an item that is not on the sheet yet (KiCad's label tools open their dialog first):
 *  OK hands the edited node to onCreate, Cancel drops it. */
export function openNew(ctx: DialogCtx, kind: string, node: SNode, onCreate: (node: SNode) => boolean | void): DlgApi | null {
  return openItem(ctx, { id: "", kind, node, geom: [], bbox: null }, { generic: true, onCreate });
}

// ---------------------------------------------------------------- field properties ("Edit Text and Field Properties")
type Opt = [string | number, string];
const H_OPTS: Opt[] = [["left", "Left"], ["center", "Center"], ["right", "Right"]], V_OPTS: Opt[] = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];
export function openField(ctx: DialogCtx, item: DialogItem, name: string): DlgApi | null {
  if (root.KDialogs.schFieldDialog && ctx.doc && ctx.doc.type === "sch" && root.KDialogs.schFieldDialog(ctx, item, name)) return null;   // DIALOG_FIELD_PROPERTIES
  const p0 = fieldNode(item.node, name); if (!p0) { if (ctx.toast) ctx.toast("No field named " + name); return null; }
  const isPcb = !ctx.isSch, Kc = K(), doc = ctx.doc;
  const fx = fieldEffects(p0), [x, y, rot] = fieldAt(p0), hidden = fieldHidden(p0), text = fieldText(p0);
  const layers = isPcb && PROPS() && PROPS()!.helpers.boardLayers ? PROPS()!.helpers.boardLayers!(doc!, false) : [];
  const ro = ctx.viewOnly ? " disabled" : "";
  const sel = (id: string, value: unknown, opts: Opt[]) => `<select id="${id}"${ro}>${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(value) ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const numIn = (id: string, v: unknown, step?: number) => `<input id="${id}" type="number" step="${step || 0.01}" value="${(+(v as number) || 0).toFixed(4).replace(/\.?0+$/, "") || 0}"${ro}>`;
  const cb = (id: string, on: boolean, label: string) => `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="${id}" type="checkbox" style="width:auto;margin:0"${on ? " checked" : ""}${ro}>${esc(label)}</label>`;
  const orient = isPcb ? numIn("kd-rot", rot, 1) : sel("kd-rot", ((Math.round(rot) % 360) + 360) % 360 === 90 || ((Math.round(rot) % 360) + 360) % 360 === 270 ? 90 : 0, [[0, "Horizontal"], [90, "Vertical"]]);
  let api: DlgApi | null = null;
  api = open({ title: "Edit Text and Field Properties", width: 520, readOnly: !!ctx.viewOnly,
    build(body) {
      body.innerHTML = `<p class="kd-note">${esc(name)} of ${esc(item.ref || item.kind)}</p>
        <div class="kv" style="margin-bottom:10px"><label>Text</label><input id="kd-text" type="text" value="${esc(text)}"${ro}>
        <label></label>${cb("kd-show", !hidden, isPcb ? "Show on board" : "Show on sheet")}</div>
        <h3>Font</h3><div class="kd-cols">
          <div class="kv"><label>Size (mm)</label>${numIn("kd-size", fx.size)}${isPcb ? `<label>Thickness (mm)</label>${numIn("kd-thick", fx.thick)}` : ""}</div>
          <div class="kv"><label></label>${cb("kd-bold", fx.bold, "Bold")}<label></label>${cb("kd-italic", fx.italic, "Italic")}${isPcb ? `<label></label>${cb("kd-mirror", fx.mirror, "Mirrored")}` : ""}</div>
        </div>
        <h3>Orientation and justification</h3><div class="kd-cols">
          <div class="kv"><label>${isPcb ? "Rotation (°)" : "Orientation"}</label>${orient}${isPcb ? `<label></label>${cb("kd-upright", fieldUnlocked(p0), "Keep upright")}` : ""}</div>
          <div class="kv"><label>Horizontal</label>${sel("kd-h", fx.h, H_OPTS)}<label>Vertical</label>${sel("kd-v", fx.v, V_OPTS)}</div>
        </div>
        <h3>Position</h3><div class="kd-cols">
          <div class="kv"><label>${isPcb ? "Offset X (mm)" : "X (mm)"}</label>${numIn("kd-x", x)}<label>${isPcb ? "Offset Y (mm)" : "Y (mm)"}</label>${numIn("kd-y", y)}</div>
          ${isPcb ? `<div class="kv"><label>Layer</label>${sel("kd-layer", fieldLayer(p0), layers.map((l) => [l, l]))}</div>` : ""}
        </div>`;
    },
    ok() {
      if (ctx.viewOnly) return;
      // the form's inputs and selects, by id (both carry .value; the checkboxes .checked)
      const g = (id: string) => api!.body.querySelector("#" + id) as HTMLInputElement;
      const staged = clone(item.node); const p = fieldNode(staged, name); if (!p) return;
      const newText = g("kd-text").value;
      if (p[0] === "property" && PROPS() && PROPS()!.helpers.setField) PROPS()!.helpers.setField!(staged, name, newText); else setFieldText(p, newText);
      setFieldHidden(staged, p, !g("kd-show").checked);
      const nfx: FieldFx = { size: Math.max(0.01, num(g("kd-size").value, fx.size)), bold: g("kd-bold").checked, italic: g("kd-italic").checked, h: g("kd-h").value, v: g("kd-v").value, mirror: isPcb ? g("kd-mirror").checked : fx.mirror };
      if (isPcb) nfx.thick = num(g("kd-thick").value, 0);
      setFieldEffects(p, nfx);
      const nrot = isPcb ? num(g("kd-rot").value, rot) : num(g("kd-rot").value, 0);
      setFieldAt(p, num(g("kd-x").value, x), num(g("kd-y").value, y), nrot);
      if (isPcb) { setFieldLayer(p, g("kd-layer").value); setFieldUnlocked(p, g("kd-upright").checked); }
      if (JSON.stringify(staged) === JSON.stringify(item.node)) return;
      ctx.commit([Kc.replaceChange(doc!, Object.assign({}, item, { node: staged, geom: [], bbox: null }) as KItem)], name.toLowerCase() + " field");
      if (ctx.setSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
    } });
  return api;
}
