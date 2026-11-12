// props/panel.ts — the Properties panel (DOM from here on): only reached from render() / renderInto().
// Every edit works on a clone of the item's node and commits one whole-item replace change, so app.js
// can record the untouched original as the undo step.
import { field, fieldList, isHidden, setField, setFieldHidden } from "./fields";
import { footprintAttrs, netNameOf, setFootprintAttrs, setFootprintPosition, setFootprintRotation, setFootprintSide, type FootprintAttrs } from "./footprint";
import { boardLayers, setDiameter, setLayer, setRotation, setShape, setStrokeWidth, setText, setTextSize, setViaDrill, setViaLayers, setViaSize, setWidth, setZoneName, setZonePriority, strokeWidth, textSize } from "./items";
import { PAD_LAYER_PRESETS, type PadPatch, type PadRow, boardNetNames, padInfo, padList, padNode, setPad } from "./pads";
import { atOf, clone, deg360, isList, kid, layerOf, normDeg, num, str, yes } from "./sexpr";
import { libUnitCount, mirrorOf, setSymbolFlag, setSymbolMirror, setSymbolPosition, setSymbolRotation, setSymbolUnit } from "./symbol";

/** The editor context the panel works in (the chrome's toolCtx(), or a dialog's staging copy of it). */
export interface PropsCtx {
  K: KiCadCanvasApi;
  doc: KDoc | null;
  isSch: boolean;
  viewOnly?: boolean;
  live?: boolean;
  items?: { id: string }[];
  commit(changes: KChange[], label?: string): void;
  setSelected(fp: { id: string } | null): void;
}
/** A context with a document: what the per-kind rows are drawn with. */
export type PanelCtx = PropsCtx & { doc: KDoc };
/** The item the panel shows: a doc item, or a dialog's staged copy of one. */
export type PanelItem = Pick<KItem, "id" | "kind" | "node"> & Partial<KItem>;
/** An edit: change the cloned node; false means "nothing to do". */
export type EditFn = (node: SNode) => unknown;
/** renderInto's options: quiet (no banner), creating (an item not placed yet), stage (a dialog collects the edits). */
export interface RenderOpts { quiet?: boolean; creating?: boolean; stage?(label: string, fn: EditFn): void }
type SelectOption = string | number | [string | number, string];
// A row's change handler: the input's value (or a checkbox's state) and the control.  Declared as a method
// so a handler that takes only the string (or only the boolean) its control gives fits the map.
type Handler = { h(v: string | boolean, c: HTMLInputElement): void }["h"];

/** The row builder render functions draw with: accumulates rows and their change handlers, then writes the DOM once. */
export interface Panel {
  ctx: PanelCtx; item: PanelItem;
  h3(t: string): void; open(): void; close(): void; raw(h: string): void;
  row(label: string, html: string): void;
  ro(label: string, value: unknown): void;
  text(label: string, value: string, on: (v: string) => void, multi?: boolean): void;
  num(label: string, value: number, on: (v: number) => void, opts?: { step?: string; min?: number; digits?: number }): void;
  select(label: string, value: unknown, options: SelectOption[], on: (v: string) => void): void;
  check(label: string, checked: boolean | undefined, on: (on: boolean) => void): void;
  field(name: string, value: string, hidden: boolean, onText: (v: string) => void, onHide?: (shown: boolean) => void): void;
  actions(list: [string, () => void, string?][]): void;
  edit(label: string, fn: EditFn): void;
  remove(): void;
  flush(): void;
}

const KIND_NAMES: Record<string, string> = { symbol: "Symbol", footprint: "Footprint", wire: "Wire", bus: "Bus", polyline: "Line", segment: "Track", via: "Via", label: "Label", global_label: "Global label", hierarchical_label: "Hierarchical label", netclass_flag: "Netclass directive", directive_label: "Directive label", text: "Text", gr_text: "Text", text_box: "Text box", gr_text_box: "Text box", junction: "Junction", zone: "Zone", no_connect: "No connect", bus_entry: "Bus entry", sheet: "Sheet", gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", rectangle: "Rectangle", circle: "Circle", dimension: "Dimension", group: "Group" };
export { KIND_NAMES };
const LABEL_SHAPES = ["input", "output", "bidirectional", "tri_state", "passive"];
const CTRL = "background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:4px 6px;color:var(--ink);font-family:var(--mono);width:100%";
function esc(s: unknown): string { return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function mm(v: unknown, d?: number): string { return (+(v as number) || 0).toFixed(d === undefined ? 3 : d); }

let last: { el: HTMLElement; selected: { id: string } | null; ctx: PropsCtx } | null = null;        // {el, selected, ctx} of the latest render, for refresh()
let inspected: { id: string } | null = null;   // raw doc item handed over by a tool module (shown when app.js has no selection)
let busy = false;       // a commit of our own is re-rendering: never defer that
let deferred = false;   // a render was skipped to protect an edit in progress

function dirtyFocus(el: HTMLElement): boolean {
  const a = typeof document !== "undefined" && document.activeElement as HTMLInputElement | null;
  if (!a || !el.contains(a)) return false;
  if (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && (a.type === "text" || a.type === "number"))) return a.value !== a.defaultValue;
  return false;
}

export function render(el: HTMLElement, selected: { id: string } | null, ctx: PropsCtx): void {
  last = { el, selected, ctx };
  if (!busy && dirtyFocus(el)) { deferred = true; return; }   // a peer's edit must not eat what the user is typing
  deferred = false;
  if (!el.dataset.propsBound) {
    el.dataset.propsBound = "1";
    el.addEventListener("focusout", () => { if (deferred) setTimeout(() => { if (deferred && last) render(last.el, last.selected, last.ctx); }, 0); });
  }
  const doc = ctx && ctx.doc;
  if (!doc) { el.innerHTML = `<p class="note">No document loaded.</p>`; return; }
  let item = selected ? doc.items.get(selected.id) || null : null;
  if (selected) inspected = null;
  else if (inspected) { item = doc.items.get(inspected.id) || null; if (!item) inspected = null; }
  if (!item) { renderFacts(el, ctx as PanelCtx); return; }
  const P = panel(el, ctx as PanelCtx, item, !!selected);
  if (ctx.isSch && item.kind === "symbol") renderSymbol(P, item);
  else if (!ctx.isSch && item.kind === "footprint") renderFootprint(P, item);
  else renderOther(P, item);
  P.flush();
}
export function refresh(): void { if (last) render(last.el, last.selected, last.ctx); }
/** Tool modules hand over a raw doc item (or null to clear); it shows while app.js has nothing selected. */
export function inspect(item: { id: string } | null | undefined): void { inspected = item || null; if (last) render(last.el, last.selected, last.ctx); }

function renderFacts(el: HTMLElement, ctx: PanelCtx): void {
  const doc = ctx.doc; const counts = new Map<string, number>();
  for (const it of doc.items.values()) counts.set(it.kind, (counts.get(it.kind) || 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<label>${esc(KIND_NAMES[k] || k)}</label><div class="ro">${n}</div>`).join("");
  const b = doc.bbox;
  const size = ctx.isSch ? `${mm(doc.page[0], 1)} × ${mm(doc.page[1], 1)} mm` : b ? `${mm(b[2] - b[0], 2)} × ${mm(b[3] - b[1], 2)} mm` : "—";
  el.innerHTML = `<p class="note">${ctx.isSch ? "Select a symbol on the sheet to edit its fields and placement." : "Select a footprint on the board to edit its fields, placement and attributes."}</p>
    <h3>${ctx.isSch ? "Sheet" : "Board"}</h3><div class="kv"><label>${ctx.isSch ? "Page" : "Size"}</label><div class="ro">${size}</div>
    ${!ctx.isSch && b ? `<label>Origin</label><div class="ro">${mm(b[0], 2)}, ${mm(b[1], 2)} mm</div>` : ""}
    <label>Items</label><div class="ro">${doc.items.size}</div></div>
    <h3>By kind</h3><div class="kv">${rows}</div>`;
}

/** Accumulates rows and their change handlers, then writes the DOM once. */
function panel(el: HTMLElement, ctx: PanelCtx, item: PanelItem, appSelected: boolean, opts?: RenderOpts): Panel {
  const parts: string[] = [], handlers = new Map<string, Handler>(); let n = 0; opts = opts || {};
  const ro = !!ctx.viewOnly;
  const key = (fn: Handler) => { const k = "k" + n++; handlers.set(k, fn); return k; };
  // (the JS original also listed `ro` as a property here; the ro() method below overwrote it, so it is left out)
  const P: Panel = {
    ctx, item,
    h3(t) { parts.push(`<h3>${esc(t)}</h3>`); },
    open() { parts.push('<div class="kv">'); },
    close() { parts.push("</div>"); },
    raw(h) { parts.push(h); },
    row(label, html) { parts.push(`<label title="${esc(label)}">${esc(label)}</label>${html}`); },
    ro(label, value) { if (opts.creating && label === "UUID") return; P.row(label, `<div class="ro" title="${esc(value)}">${esc(value) || "—"}</div>`); },
    text(label, value, on, multi) {
      if (ro) return P.ro(label, value);
      if (multi) P.row(label, `<textarea data-k="${key(on)}" rows="3" style="${CTRL};resize:vertical">${esc(value)}</textarea>`);
      else P.row(label, `<input data-k="${key(on)}" type="text" value="${esc(value)}">`);
    },
    num(label, value, on, opts) {
      opts = opts || {};
      if (ro) return P.ro(label, mm(value, opts.digits));
      P.row(label, `<input data-k="${key((v: string) => { const x = parseFloat(v); if (!isNaN(x)) on(x); })}" type="number" step="${opts.step || "0.01"}"${opts.min !== undefined ? ` min="${opts.min}"` : ""} value="${mm(value, opts.digits)}">`);
    },
    select(label, value, options, on) {   // options: [value, text] pairs or plain strings
      const opts = options.map((o): [string | number, string] => isList(o) ? o as [string | number, string] : [o, o as string]);
      if (ro) { const hit = opts.find((o) => String(o[0]) === String(value)); return P.ro(label, hit ? hit[1] : value); }
      P.row(label, `<select data-k="${key(on)}" style="${CTRL}">${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(value) ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`);
    },
    check(label, checked, on) {   // box then text across the row, as in KiCad's dialogs
      if (ro) return P.ro(label, checked ? "yes" : "no");
      parts.push(`<label style="grid-column:1/-1;display:flex;gap:8px;align-items:center;color:var(--ink)"><input data-k="${key(on)}" type="checkbox" style="width:auto;margin:0"${checked ? " checked" : ""}>${esc(label)}</label>`);
    },
    /** A property row: text plus a "shown" toggle (omit onHide for fields without one). */
    field(name, value, hidden, onText, onHide) {
      if (ro) return P.row(name, `<div class="ro"${hidden ? ' style="opacity:.55"' : ""} title="${esc(value)}">${esc(value) || "—"}</div>`);
      const box = onHide ? `<input data-k="${key(onHide)}" type="checkbox" title="Show ${ctx.isSch ? "on sheet" : "on board"}" style="width:auto;margin:0"${hidden ? "" : " checked"}>` : "";
      P.row(name, `<div style="display:flex;gap:6px;align-items:center"><input data-k="${key(onText)}" type="text" value="${esc(value)}" style="flex:1;min-width:0">${box}</div>`);
    },
    actions(list) {   // [[label, fn, cls]]
      if (ro || opts.creating) return;   // an item still being created (the label dialog before placement) has nothing to delete
      parts.push(`<div class="actions">${list.map(([label, fn, cls]) => `<button class="btn sm${cls ? " " + cls : ""}" data-k="${key(fn)}">${esc(label)}</button>`).join("")}</div>`);
    },
    /** Apply fn to a clone of the node and commit the whole item; fn may return false for "nothing to do". */
    edit(label, fn) {
      if (opts.stage) { opts.stage(label, fn); return; }   // a dialog stages edits and commits once on OK
      const K = ctx.K; const node = clone(item.node);
      if (fn(node) === false) return;
      const change = K.replaceChange(ctx.doc, Object.assign({}, item, { node, geom: [], bbox: null }) as KItem);
      busy = true;
      try {
        ctx.commit([change], label);
        // the doc now holds a fresh item object: point the app's selection (or our inspect) at it
        if (appSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
        else { inspected = ctx.doc.items.get(item.id) || inspected; render(el, null, ctx); }
      } finally { busy = false; }
    },
    remove() {
      busy = true;
      try {
        ctx.commit([ctx.K.removeChange(item as KItem)], "delete");
        if (appSelected) ctx.setSelected(null); else { inspected = null; render(el, null, ctx); }
      } finally { busy = false; }
    },
    flush() {
      el.innerHTML = parts.join("");
      // inputs, selects, textareas and buttons; they all carry the .value / .type / .checked read here
      el.querySelectorAll<HTMLInputElement>("[data-k]").forEach((c) => {
        const fn = handlers.get(c.dataset.k!); if (!fn) return;
        if (c.tagName === "BUTTON") c.addEventListener("click", () => (fn as () => void)());
        else c.addEventListener("change", () => { c.defaultValue = c.value; fn(c.type === "checkbox" ? c.checked : c.value, c); });
      });
    },
  };
  if (opts.quiet) return P;
  if (ro) P.raw(`<p class="note">View-only access — properties are read-only.</p>`);
  else if (!ctx.live) P.raw(`<p class="note">Not connected — edits stay local until you rejoin.</p>`);
  return P;
}
/** Render an item's property rows into any element; opts.stage(label, fn) receives edits instead of committing them. */
export function renderInto(el: HTMLElement, ctx: PanelCtx, item: PanelItem, opts?: RenderOpts): Panel {
  const P = panel(el, ctx, item, false, opts);
  if (ctx.isSch && item.kind === "symbol") renderSymbol(P, item);
  else if (!ctx.isSch && item.kind === "footprint") renderFootprint(P, item);
  else renderOther(P, item);
  P.flush();
  return P;
}

function renderFields(P: Panel, node: SNode): void {
  for (const p of fieldList(node)) {
    const name = str(p[1]);
    P.field(name, str(p[2]), isHidden(p),
      (v) => P.edit(name.toLowerCase(), (n) => setField(n, name, v)),
      (shown) => P.edit((shown ? "show " : "hide ") + name, (n) => setFieldHidden(n, name, !shown)));
  }
}

function renderSymbol(P: Panel, item: PanelItem): void {
  const n = item.node, ctx = P.ctx;
  const [x, y, rot] = atOf(n); const mirror = mirrorOf(n);
  P.h3("Symbol " + (item.ref || ""));
  P.open();
  P.ro("Library", str((kid(n, "lib_id") || [])[1]));
  renderFields(P, n);
  P.close();
  P.h3("Placement");
  P.open();
  P.num("X (mm)", x, (v) => P.edit("position", (m) => setSymbolPosition(m, v, y)));
  P.num("Y (mm)", y, (v) => P.edit("position", (m) => setSymbolPosition(m, x, v)));
  P.select("Rotation", deg360(rot), [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], (v) => P.edit("rotation", (m) => setSymbolRotation(m, +v)));
  P.select("Mirror", mirror, [["", "Not mirrored"], ["x", "Around X axis"], ["y", "Around Y axis"]], (v) => P.edit("mirror", (m) => setSymbolMirror(m, v)));
  const units = libUnitCount(ctx.doc, n);
  if (units > 1) {
    const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1;
    const opts: SelectOption[] = []; for (let u = 1; u <= units; u++) opts.push([u, u + (u <= 26 ? " (" + String.fromCharCode(64 + u) + ")" : "")]);
    P.select("Unit", unit, opts, (v) => P.edit("unit", (m) => setSymbolUnit(m, +v)));
  }
  P.close();
  P.h3("Attributes");
  P.open();
  P.check("Do not populate", yes(n, "dnp", false), (on) => P.edit("dnp", (m) => setSymbolFlag(m, "dnp", on)));
  P.check("Exclude from BOM", !yes(n, "in_bom", true), (on) => P.edit("bom", (m) => setSymbolFlag(m, "in_bom", !on)));
  P.check("Exclude from board", !yes(n, "on_board", true), (on) => P.edit("board", (m) => setSymbolFlag(m, "on_board", !on)));
  if (kid(n, "exclude_from_sim")) P.check("Exclude from simulation", yes(n, "exclude_from_sim", false), (on) => P.edit("simulation", (m) => setSymbolFlag(m, "exclude_from_sim", on)));
  if (kid(n, "in_pos_files")) P.check("Exclude from position files", !yes(n, "in_pos_files", true), (on) => P.edit("position files", (m) => setSymbolFlag(m, "in_pos_files", !on)));
  P.close();
  P.open(); P.ro("UUID", item.id); P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}

function renderFootprint(P: Panel, item: PanelItem): void {
  const n = item.node, ctx = P.ctx, doc = ctx.doc;
  const [x, y, rot] = atOf(n); const side = layerOf(n, "F.Cu");
  P.h3("Footprint " + (item.ref || ""));
  P.open();
  P.ro("Footprint", str(n[1]));
  renderFields(P, n);
  P.close();
  P.h3("Placement");
  P.open();
  P.num("X (mm)", x, (v) => P.edit("position", (m) => setFootprintPosition(m, v, y)));
  P.num("Y (mm)", y, (v) => P.edit("position", (m) => setFootprintPosition(m, x, v)));
  P.num("Rotation (°)", rot, (v) => P.edit("rotation", (m) => setFootprintRotation(m, v)), { step: "any", digits: 1 });
  P.select("Side", side, [["F.Cu", "Front"], ["B.Cu", "Back"]], (v) => P.edit("side", (m) => setFootprintSide(m, v)));
  P.close();
  P.h3("Attributes");
  P.open();
  const a = footprintAttrs(n); const attr = (patch: Partial<FootprintAttrs>, label?: string) => P.edit(label || "attributes", (m) => setFootprintAttrs(m, patch));
  P.select("Type", a.type, [["", "Unspecified"], ["smd", "SMD"], ["through_hole", "Through hole"]], (v) => attr({ type: v }, "type"));
  P.check("Not in schematic", a.board_only, (on) => attr({ board_only: on }));
  P.check("Exclude from position files", a.exclude_from_pos_files, (on) => attr({ exclude_from_pos_files: on }));
  P.check("Exclude from BOM", a.exclude_from_bom, (on) => attr({ exclude_from_bom: on }));
  P.check("Do not populate", a.dnp, (on) => attr({ dnp: on }, "dnp"));
  P.close();
  const pads = padList(doc, n);
  P.h3(`Pads (${pads.length})`);
  P.raw(`<div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:2px 10px;font:11px var(--mono);max-height:200px;overflow:auto">
    <span class="muted">#</span><span class="muted">net</span><span class="muted">shape</span><span class="muted">size</span>
    ${pads.slice(0, 400).map((p) => `<span>${esc(p.number)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.net)}">${esc(p.net) || "<span class=muted>–</span>"}</span><span>${esc(p.shape)}</span><span title="${esc(p.type)}${p.drill ? " drill " + esc(p.drill) : ""}">${mm(p.w, 2)}×${mm(p.h, 2)}</span>`).join("")}</div>`);
  if (pads.length) renderPadEditor(P, item, pads);
  P.open(); P.ro("UUID", item.id); P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}
const padEditIndex = new Map<string, number>();   // footprint id -> the pad the editor shows
/** KiCad's pad properties for one pad of the footprint: every row commits the whole footprint through setPad. */
function renderPadEditor(P: Panel, item: PanelItem, pads: PadRow[]): void {
  const n = item.node, doc = P.ctx.doc; let idx = padEditIndex.get(item.id) || 0; if (idx >= pads.length) idx = 0;
  const pad = padNode(n, idx); if (!pad) return; const info = padInfo(doc, pad); const frot = atOf(n)[2];
  const edit = (label: string, patch: PadPatch) => P.edit("pad " + label, (m) => setPad(m, idx, patch, doc));
  P.h3("Pad properties");
  P.open();
  P.select("Pad", idx, pads.map((p, i): SelectOption => [i, `${p.number}${p.net ? " · " + p.net : ""}`]), (v) => { padEditIndex.set(item.id, +v); refresh(); });
  P.text("Number", info.number, (v) => edit("number", { number: v }));
  P.select("Type", info.type, [["smd", "SMD"], ["thru_hole", "Through-hole"], ["np_thru_hole", "NPTH, mechanical"], ["connect", "Edge connector"]], (v) => edit("type", { type: v }));
  P.select("Shape", info.shape, [["circle", "Circular"], ["oval", "Oval"], ["rect", "Rectangular"], ["roundrect", "Rounded rectangle"], ["trapezoid", "Trapezoid"], ["custom", "Custom"]], (v) => edit("shape", { shape: v }));
  P.num("Size X (mm)", info.w, (v) => edit("size", { w: v }), { min: 0 });
  P.num("Size Y (mm)", info.h, (v) => edit("size", { h: v }), { min: 0 });
  P.num("Orientation (°)", normDeg(info.rot - frot), (v) => edit("orientation", { rot: v + frot }), { step: "any", digits: 1 });
  P.text("Hole (mm or WxH)", info.drill, (v) => edit("drill", { drill: v }));
  const layerSet = info.layers.join(" ");
  P.select("Layers", layerSet, (PAD_LAYER_PRESETS.includes(layerSet) ? [] : [layerSet]).concat(PAD_LAYER_PRESETS), (v) => edit("layers", { layers: v.split(/\s+/) }));
  const nets = boardNetNames(doc);
  P.select("Net", info.net, ([["", "<no net>"]] as SelectOption[]).concat(info.net && !nets.includes(info.net) ? [[info.net, info.net]] : []).concat(nets.map((x): SelectOption => [x, x])), (v) => edit("net", { net: v }));
  P.num("Mask margin (mm)", info.maskMargin === null ? 0 : info.maskMargin, (v) => edit("mask margin", { maskMargin: v || null }), { step: "0.01" });
  if (info.shape === "roundrect") P.num("Corner ratio", info.rratio === null ? 0.25 : info.rratio, (v) => edit("corner ratio", { rratio: v }), { step: "0.05", min: 0 });
  P.close();
}

function renderOther(P: Panel, item: PanelItem): void {
  const n = item.node, k = item.kind, ctx = P.ctx, doc = ctx.doc, K = ctx.K;
  const sch = !!ctx.isSch;
  const pt = (p: [number, number] | undefined) => p ? `${mm(p[0])}, ${mm(p[1])}` : "—";
  P.h3(KIND_NAMES[k] || k);
  P.open();
  if (sch && (k === "wire" || k === "bus" || k === "polyline")) {
    const pts = K.ptsOf(n);
    P.ro("Start", pt(pts[0])); P.ro("End", pt(pts[pts.length - 1]));
    P.num("Width (mm)", strokeWidth(n), (v) => P.edit("width", (m) => setStrokeWidth(m, v)), { min: 0 });
    P.raw(`<span></span><span class="note" style="margin:0">0 = default width</span>`);
  } else if (!sch && (k === "segment" || k === "arc")) {
    const s = kid(n, "start"), e = kid(n, "end");
    P.ro("Net", netNameOf(doc, n));
    P.num("Width (mm)", num((kid(n, "width") || [])[1], 0.25), (v) => P.edit("width", (m) => setWidth(m, v)), { min: 0 });
    P.select("Layer", layerOf(n, "F.Cu"), boardLayers(doc, true), (v) => P.edit("layer", (m) => setLayer(m, v)));
    P.ro("Start", s ? `${mm(s[1])}, ${mm(s[2])}` : "—"); P.ro("End", e ? `${mm(e[1])}, ${mm(e[2])}` : "—");
    if (k === "segment" && s && e) P.ro("Length", mm(Math.hypot(num(e[1]) - num(s[1]), num(e[2]) - num(s[2]))) + " mm");
  } else if (!sch && k === "via") {
    const [x, y] = atOf(n); const ls = kid(n, "layers"); const copper = boardLayers(doc, true);
    P.ro("Net", netNameOf(doc, n));
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
    if (n.includes("blind") || n.includes("micro")) P.ro("Type", n.includes("micro") ? "micro" : "blind/buried");
    P.num("Size (mm)", num((kid(n, "size") || [])[1], 0.8), (v) => P.edit("via size", (m) => setViaSize(m, v)), { min: 0 });
    P.num("Drill (mm)", num((kid(n, "drill") || [])[1], 0.4), (v) => P.edit("via drill", (m) => setViaDrill(m, v)), { min: 0 });
    const a = ls ? str(ls[1]) : "F.Cu", b = ls ? str(ls[2]) : "B.Cu";
    P.select("From layer", a, copper, (v) => P.edit("via layers", (m) => setViaLayers(m, v, b)));
    P.select("To layer", b, copper, (v) => P.edit("via layers", (m) => setViaLayers(m, a, v)));
  } else if (sch && /label|netclass_flag/.test(k)) {
    const [x, y, rot] = atOf(n);
    P.text("Text", str(n[1]), (v) => P.edit("label", (m) => setText(m, v)));
    if (k === "global_label" || k === "hierarchical_label") P.select("Shape", str((kid(n, "shape") || [])[1] || "input"), LABEL_SHAPES.map((s): SelectOption => [s, s.replace("_", "-")]), (v) => P.edit("shape", (m) => setShape(m, v)));
    P.select("Rotation", deg360(rot), [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], (v) => P.edit("rotation", (m) => setRotation(m, +v)));
    P.num("Size (mm)", textSize(n), (v) => P.edit("text size", (m) => setTextSize(m, v)), { min: 0.01 });
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else if (k === "text" || k === "gr_text") {
    const [x, y, rot] = atOf(n);
    P.text("Text", str(n[1]), (v) => P.edit("text", (m) => setText(m, v)), true);
    P.num("Size (mm)", textSize(n), (v) => P.edit("text size", (m) => setTextSize(m, v)), { min: 0.01 });
    P.num("Rotation (°)", rot, (v) => P.edit("rotation", (m) => setRotation(m, v)), { step: "any", digits: 1 });
    if (!sch) P.select("Layer", layerOf(n, "Dwgs.User"), boardLayers(doc, false), (v) => P.edit("layer", (m) => setLayer(m, v)));
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else if (sch && k === "junction") {
    const [x, y] = atOf(n);
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
    P.num("Diameter (mm)", num((kid(n, "diameter") || [])[1], 0), (v) => P.edit("diameter", (m) => setDiameter(m, v)), { min: 0 });
    P.raw(`<span></span><span class="note" style="margin:0">0 = default diameter</span>`);
  } else if (!sch && k === "zone") {
    const single = kid(n, "layer"), multi = kid(n, "layers");
    P.text("Name", str((kid(n, "name") || [])[1]), (v) => P.edit("zone name", (m) => setZoneName(m, v)));
    P.ro("Net", netNameOf(doc, n));
    P.num("Priority", num((kid(n, "priority") || [])[1], 0), (v) => P.edit("zone priority", (m) => setZonePriority(m, v)), { step: "1", min: 0, digits: 0 });
    P.ro("Layers", single ? str(single[1]) : multi ? multi.slice(1).map(str).join(" ") : "—");
    if (kid(n, "keepout")) P.ro("Keepout", "yes");
  } else if (k === "sheet") {
    for (const name of ["Sheetname", "Sheetfile"]) { const p = field(n, name); if (p) P.field(name, str(p[2]), false, (v) => P.edit(name.toLowerCase(), (m) => setField(m, name, v))); }
    const [x, y] = atOf(n); P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else {
    if (kid(n, "at") || kid(n, "transform")) { const [x, y, rot] = atOf(n); P.ro("Position", `${mm(x)}, ${mm(y)}`); if (rot) P.ro("Rotation", mm(rot, 1) + "°"); }
    if (kid(n, "layer")) P.ro("Layer", layerOf(n, ""));
    if (kid(n, "stroke")) P.num("Width (mm)", strokeWidth(n), (v) => P.edit("width", (m) => setStrokeWidth(m, v)), { min: 0 });
    if (!sch && kid(n, "net")) P.ro("Net", netNameOf(doc, n));
  }
  P.ro("UUID", item.id);
  P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}
