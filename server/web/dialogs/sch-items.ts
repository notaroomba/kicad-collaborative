// dialogs/sch-items.ts — eeschema's item property dialogs and SCH_EDIT_TOOL::Properties' choice among them.
//
//   DIALOG_LABEL_PROPERTIES     labels, global / hierarchical / directive labels (also the creation dialog of the
//                               label tools, with the "Multiple label input" list)
//   DIALOG_TEXT_PROPERTIES      text and text boxes (also their creation dialog)
//   DIALOG_FIELD_PROPERTIES     a symbol, sheet or label field ("Edit Reference Designator Field", "Edit 'MPN' Field")
//   DIALOG_LINE_PROPERTIES      graphic lines, several at once
//   DIALOG_WIRE_BUS_PROPERTIES  wires, buses, bus entries and junctions, several at once
//   DIALOG_JUNCTION_PROPS       junctions, several at once
//   DIALOG_SHAPE_PROPERTIES     rectangles, circles, arcs, curves, polygons and rule areas
//   DIALOG_IMAGE_PROPERTIES     bitmaps
//
// kicad-dialogs.js asks KDialogs.schItemDialog / schFieldDialog first (openItem / openNew / openField), so the
// double-click, E and the tools' creation paths all reach these.  The document edits are in sch-items-logic.ts.
import { schTableDialog } from "../editor/tabledialogs";
import { keyName } from "../keys";
import { E, toast, toolCtx } from "./editor";
import { KD, popupMenu, checkbox, confirmBox, h, select, textInput } from "./dom";
import { facesUsed, fontPicker, type FontPickerEl } from "./font-picker";
import * as L from "./sch-items-logic";
import { commitWithOtherUnits } from "./sync-units";
import { HL, netMap } from "../editor/schnets";
import { fmtLen, parseLen, unitName } from "../editor/pcbdialogs/ui";
import { openSheetProperties, openSymbolProperties, sheetPathNow } from "./sch-symbol-sheet";
import { openPageSettings } from "./page-settings";

type Ctx = ToolCtx & { doc: KDoc };
interface ItemOpts { onCreate?(node: SNode, more?: SNode[]): boolean | void; cancel?(): void; title?: string; label?: string; generic?: boolean; isNew?: boolean; symbolEditor?: SymEditorTextOpts }
/** DIALOG_TEXT_PROPERTIES in the Symbol Editor (m_isSymbolEditor): no hyperlink, syntax help or simulation exclusion; Private
 *  to symbol editor and Common to all units / body styles instead, and the result goes back to the editor. */
export interface SymEditorTextOpts {
  private: boolean; multiUnit: boolean; allUnits: boolean; multiBody: boolean; allBodies: boolean;
  apply(node: SNode, o: { private: boolean; allUnits: boolean; allBodies: boolean }): void;
}
interface SchHelpers { autoplaceNode(doc: KDoc, item: KItem, opts?: unknown): SNode | null; selectedItems(ctx: ToolCtx): KItem[]; isPowerSymbol(doc: KDoc, libId: string): boolean }
const schH = (): SchHelpers | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchHelpers : null; };

export type Swatch = ReturnType<typeof swatch>;
// ---------------------------------------------------------------- shared widgets
/** A modal message with one OK button (DisplayError / DisplayInfoMessage), on top of the open dialog. */
export function messageBox(message: string, title = "Error"): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { ov.remove(); resolve(); };
    const ok = h("button", { class: "btn primary", onclick: done }, "OK");
    const dlg = h("div", { class: "kd-dialog", style: "width:380px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)), h("div", { class: "kd-body" }, h("p", { id: "kd-msgbox-text", style: "margin:4px 0;white-space:pre-wrap" }, message)), h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), ok));
    const ov = h("div", { class: "kd-overlay kd-prompt kd-msgbox", style: "z-index:80" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); done(); } });
    document.body.append(ov); ok.focus();
  });
}
/** COLOR_SWATCH: the colour or the checkered "unspecified"; a click picks, × resets to unspecified. */
export function swatch(initial: L.Color, id: string, onPick?: (c: L.Color) => void, disabled = false): { el: HTMLElement; get(): L.Color; set(c: L.Color): void; enable(on: boolean): void; pick(): void } {
  let color: L.Color = initial;
  const input = h("input", { type: "color", id, value: L.colorToHex(color), style: "position:absolute;opacity:0;width:0;height:0;pointer-events:none" });
  const face = h("span", { style: "display:inline-block;width:26px;height:16px;border:1px solid var(--line);border-radius:2px;vertical-align:middle" });
  const paint = (): void => { face.style.background = color ? `rgba(${color[0]},${color[1]},${color[2]},${color[3]})` : "repeating-conic-gradient(var(--ink-3) 0 25%, var(--panel) 0 50%) 0 0 / 8px 8px"; face.title = color ? L.colorToHex(color) : "Unspecified"; };
  input.addEventListener("input", () => { color = L.hexToColor(input.value, color ? color[3] || 1 : 1); paint(); if (onPick) onPick(color); });
  const btn = h("button", { type: "button", class: "btn", style: "padding:1px 4px;position:relative", title: "Choose color", disabled, onclick: () => { input.value = L.colorToHex(color); input.click(); } }, face, input);
  const clear = h("button", { type: "button", class: "btn", style: "padding:0 5px", title: "Unspecified (use the default color)", disabled, onclick: () => { color = null; paint(); if (onPick) onPick(color); } }, "×");
  paint();
  return { el: h("span", { style: "display:inline-flex;gap:2px;align-items:center", "data-swatch": id }, btn, clear), get: () => color, set: (c) => { color = c; paint(); }, enable: (on) => { btn.disabled = !on; clear.disabled = !on; },
    // COLOR_SWATCH::GetNewSwatchColor: open the picker on the current colour
    pick: () => { if (!btn.disabled) btn.click(); } };
}
/** Faces a grid's font column offers: the stroke font and the faces the sheet already uses (the dialogs' own font
 *  choice, font-picker.ts, adds every Google Font). */
export function fontFaces(doc: KDoc | null): string[] { return [L.KICAD_FONT, ...facesUsed(doc)]; }
/** A BITMAP_BUTTON toggle (bold / italic / alignment); `group` makes it a radio among its siblings. */
function toggle(label: string, title: string, on: boolean, id: string, style = ""): HTMLButtonElement {
  const b = h("button", { type: "button", class: "btn kd-tog" + (on ? " on" : ""), title, id, "aria-pressed": on ? "true" : "false", style: "min-width:28px;padding:1px 6px;" + style }, label);
  b.addEventListener("click", () => { if (b.dataset.group) { for (const s of Array.from(b.parentElement ? b.parentElement.querySelectorAll(`[data-group="${b.dataset.group}"]`) : [])) { s.classList.remove("on"); s.setAttribute("aria-pressed", "false"); } b.classList.add("on"); b.setAttribute("aria-pressed", "true"); } else { const now = !b.classList.contains("on"); b.classList.toggle("on", now); b.setAttribute("aria-pressed", now ? "true" : "false"); } });
  return b;
}
/** SetInitialFocus: a dialog opened by a click keeps its first control focused once the click's pointerup lands. */
function initialFocus(el: HTMLInputElement | HTMLTextAreaElement | null): void {
  if (!el) return;
  const f = (): void => { const act = document.activeElement as HTMLElement | null; if (document.contains(el) && act !== el && !(act && act.closest && act.closest(".kd-font-pop")) && !(act && act.closest && act.closest(".kd-dialog") && act.closest(".kd-dialog") !== el.closest(".kd-dialog"))) { el.focus(); el.select(); } };
  setTimeout(f, 0);
  const up = (): void => { setTimeout(f, 0); };
  window.addEventListener("pointerup", up, { once: true, capture: true });
  setTimeout(() => window.removeEventListener("pointerup", up, { capture: true }), 1500);
}
const isOn = (b: HTMLElement): boolean => b.classList.contains("on");
function radioGroup(name: string, opts: [string, string][], value: string, onPick?: (v: string) => void): HTMLElement {
  const box = h("div", { style: "display:grid;grid-template-columns:repeat(2,max-content);gap:3px 18px" });
  for (const [v, label] of opts) {
    const r = h("input", { type: "radio", name, value: v, checked: v === value, id: name + "-" + v, style: "width:auto;margin:0" });
    if (onPick) r.addEventListener("change", () => { if ((r as HTMLInputElement).checked) onPick(v); });
    box.append(h("label", { class: "kd-chk" }, r, label));
  }
  return box;
}
const radioValue = (root: HTMLElement, name: string): string => { const r = root.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null; return r ? r.value : ""; };
/** A UNIT_BINDER text box: shows the length in the user's units; read back with lenValue. */
function lenBox(mm: number | undefined, id: string, width = 90): HTMLInputElement {
  const i = textInput(mm === undefined ? "" : fmtLen(mm), undefined, { id, style: `width:${width}px` });
  i.addEventListener("change", () => { const v = parseLen(i.value); if (Number.isFinite(v)) i.value = fmtLen(v); });
  return i;
}
/** include/widgets/ui_common.h INDETERMINATE_ACTION: what a value box shows when the selected items differ. */
const INDETERMINATE_ACTION = "-- leave unchanged --";
const lenValue = (i: HTMLInputElement): number | undefined => { const t = i.value.trim(); if (!t) return undefined; const v = parseLen(t); return Number.isFinite(v) ? v : undefined; };
const units = () => h("span", { class: "kd-note" }, unitName());
const ensureCss = (() => { let done = false; return () => { if (done) return; done = true; document.head.append(h("style", { id: "kd-schitems-css" }, `
.kd-tog.on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.kd-fmt { display: grid; grid-template-columns: max-content auto max-content; gap: 5px 8px; align-items: center; }
.kd-sep { display: inline-block; width: 1px; height: 18px; background: var(--line); margin: 0 4px; vertical-align: middle; }
.kd-help { font-size: 12px; color: var(--ink-2); }
.kd-help code { background: var(--panel); padding: 0 3px; border-radius: 2px; }
`)); }; })();
const commitItem = (ctx: Ctx, item: KItem, node: SNode, label: string): void => {
  if (JSON.stringify(node) === JSON.stringify(item.node)) return;
  ctx.commit([KiCadCanvas.replaceChange(ctx.doc, Object.assign({}, item, { node, geom: [], bbox: null }) as KItem)], label);
};

// ---------------------------------------------------------------- the fields grid (FIELDS_GRID_TABLE)
interface GRow extends L.FieldRow { sizeT: string; xT: string; yT: string; hT: string; vT: string; orientT: string; colorT: string }
const toG = (r: L.FieldRow): GRow => Object.assign(r, { sizeT: fmtLen(r.size), xT: fmtLen(r.x), yT: fmtLen(r.y), hT: r.h, vT: r.v, orientT: r.orient === 90 ? "Vertical" : "Horizontal", colorT: r.color ? L.colorToHex(r.color) : "" });
function fromG(r: GRow): L.FieldRow {
  const len = (t: string, d: number): number => { const v = parseLen(t); return Number.isFinite(v) ? v : d; };
  r.size = Math.max(0.01, len(r.sizeT, r.size)); r.x = len(r.xT, r.x); r.y = len(r.yT, r.y);
  r.h = r.hT as L.HAlign; r.v = r.vT as L.VAlign; r.orient = r.orientT === "Vertical" ? 90 : 0;
  r.color = r.colorT.trim() ? (L.hexToColor(r.colorT, r.color ? r.color[3] : 1) || r.color) : null;
  return r;
}
/** The grid with its Add field / Delete field / Move up / Move down buttons.  -> rows() for TransferDataFromWindow */
export function fieldsGrid(host: HTMLElement, rows0: L.FieldRow[], opts: { readOnly?: boolean; doc: KDoc | null; newName(rows: L.FieldRow[]): string; height?: number; shown?: number[] }): { rows(): L.FieldRow[]; setRows(rows: L.FieldRow[]): void } {
  const rows: GRow[] = rows0.map(toG);
  const faces = fontFaces(opts.doc);
  const cols = [
    { key: "name", label: "Name", width: 110, ro: (r: GRow) => r.mandatory },
    { key: "value", label: "Value", width: 170 },
    { key: "show", label: "Show", type: "bool" as const, width: 42 },
    { key: "showName", label: "Show Name", type: "bool" as const, width: 42 },
    { key: "hT", label: "H Align", type: "choice" as const, options: [["left", "Left"], ["center", "Center"], ["right", "Right"]] as [string, string][], width: 70 },
    { key: "vT", label: "V Align", type: "choice" as const, options: [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]] as [string, string][], width: 70 },
    { key: "italic", label: "Italic", type: "bool" as const, width: 42 },
    { key: "bold", label: "Bold", type: "bool" as const, width: 42 },
    { key: "sizeT", label: "Text Size", width: 64 },
    { key: "orientT", label: "Orientation", type: "choice" as const, options: ["Horizontal", "Vertical"], width: 86 },
    { key: "xT", label: "X Position", width: 64 },
    { key: "yT", label: "Y Position", width: 64 },
    { key: "font", label: "Font", type: "choice" as const, options: faces, width: 110 },
    { key: "colorT", label: "Color", width: 70 },
    { key: "autoplace", label: "Allow Autoplacement", type: "bool" as const, width: 60 },
  ];
  // WX_GRID::ShowHideColumns: a dialog may start with only some columns; the header's right-click menu
  // (one check item per column) shows or hides the others
  const shown = new Set(opts.shown || cols.map((_c, i) => i));
  const visible = () => cols.filter((_c, i) => shown.has(i));
  const g = KD().grid<GRow>(host, visible(), rows, {
    readOnly: opts.readOnly, height: opts.height || 170,
    onChange(row, key) { if (key === "sizeT" || key === "xT" || key === "yT") { fromG(row); toG(row); g.refresh(); } },
    buttons: { add: () => toG(L.newRow(opts.newName(rows), [0, 0])), addTitle: "Add field", remove: true, removeTitle: "Delete field", move: true, canRemove: (r) => { if (r.mandatory) { toast(`The first ${rows.filter((x) => x.mandatory).length} fields are mandatory.`); return false; } return true; } },
  });
  g.el.style.maxWidth = "100%";
  if (opts.shown) g.el.addEventListener("contextmenu", (ev) => {
    const t = ev.target as Element | null; if (!t || !t.closest || !t.closest("thead")) return;
    ev.preventDefault();
    popupMenu(ev.clientX, ev.clientY, cols.map((c, i) => ({ label: c.label, check: true, checked: shown.has(i), disabled: i < 2, run: () => { if (shown.has(i)) shown.delete(i); else shown.add(i); g.columns = visible(); g.refresh(); } })));
  });
  return { rows: () => rows.map(fromG), setRows(next: L.FieldRow[]) { rows.splice(0, rows.length, ...next.map(toG)); g.refresh(); } };
}
const nextFieldName = (rows: L.FieldRow[]): string => { let n = 1; const names = new Set(rows.map((r) => r.name)); while (names.has("Field" + n)) n++; return "Field" + n; };

// ---------------------------------------------------------------- DIALOG_LABEL_PROPERTIES
/** Every label text of this type across the project (and power nets for local / global labels): the Label: combo. */
function existingLabels(kind: string, doc: KDoc): string[] {
  const out = new Set<string>(); const docs: KDoc[] = [doc];
  const c = netMap(); if (c) for (const d of c.docs.values()) if (d !== doc) docs.push(d);
  const H = schH();
  for (const d of docs) for (const it of d.items.values()) {
    if (it.kind === kind) out.add(L.unescapeString(L.str(it.node[1])));
    if ((kind === "global_label" || kind === "label") && it.kind === "symbol" && H) {
      const lib = L.kid(it.node, "lib_id"); if (!lib || !H.isPowerSymbol(d, L.str(lib[1]))) continue;
      const v = L.kids(it.node, "property").find((p) => L.fieldName(p) === "Value"); if (v && kind === "global_label") out.add(L.unescapeString(L.fieldValue(v)));
    }
  }
  out.delete("");
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}
/** Remembered between openings (DIALOG_SHIM saved control state): the multiple-label checkbox. */
const labelMem = { multi: false };
export function openLabelDialog(ctx: Ctx, item: KItem, opts: ItemOpts): void {
  ensureCss();
  const kind = item.kind, doc = ctx.doc, isNew = !!opts.onCreate, dir = L.isDirective(kind);
  const staged = L.clone(item.node), st = L.readLabel(kind, staged), [ox, oy] = L.atOf(staged), origin: [number, number] = [ox, oy];
  st.text = L.unescapeString(st.text);   // TransferDataToWindow shows control characters in a human-readable format
  const AR = (): { autoRotateOf(id: string): boolean; setAutoRotate(id: string, on: boolean): void; labelOrientationForPoint(d: KDoc, p: [number, number], dflt: number, skip?: string): 0 | 1 | 2 | 3 } | null => {
    const m = CollabTools.sch; return m && m._ && (m._ as Record<string, unknown>).labelOrientationForPoint ? m._ as never : null; };
  if (!isNew && (kind === "global_label" || kind === "hierarchical_label")) { const ar = AR(); st.autoRotate = !!ar && ar.autoRotateOf(item.id); }
  const mandatory = kind === "global_label" ? ["Intersheetrefs"] : [];
  const ro = !!ctx.viewOnly;
  let textEl: HTMLInputElement | HTMLTextAreaElement | null = null, multiCb: HTMLInputElement | null = null, grid: { rows(): L.FieldRow[] } | null = null;
  let fontSel: FontPickerEl | null = null, sizeIn: HTMLInputElement | null = null, boldB: HTMLButtonElement | null = null, italB: HTMLButtonElement | null = null, autoCb: HTMLInputElement | null = null;
  const spins: HTMLButtonElement[] = [];
  let color: Swatch | null = null, body: HTMLElement | null = null;
  const help = (): void => {
    KD().open({ title: "Syntax Help", width: 520, modeless: true, okLabel: "Close", build(b) {
      b.append(h("div", { class: "kd-help" },
        h("p", null, "Net names may contain any characters but ", h("code", null, "{"), " and ", h("code", null, "}"), " which are used for bus syntax, and spaces, which are replaced by underscores."),
        h("p", null, "Bus definitions: ", h("code", null, "D[0..7]"), " (vector bus) or ", h("code", null, "{SCL SDA}"), " / ", h("code", null, "USB{DP DM}"), " (group bus)."),
        h("p", null, "Overbar: ", h("code", null, "~{RESET}"), "   Subscript: ", h("code", null, "V_{CC}"), "   Superscript: ", h("code", null, "x^{2}")),
        h("p", null, "Text variables: ", h("code", null, "${PROJECTNAME}"), ", ", h("code", null, "${SHEETNAME}"), ", ", h("code", null, "${R1:VALUE}"))));
    } });
  };
  KD().open({
    title: opts.title || L.labelTitle(kind), width: 820, readOnly: ro, cancel: opts.cancel,
    build(b) {
      body = b;
      // Label: (a combo of the existing names for local and global labels, a single line for hierarchical ones)
      if (!dir) {
        const listId = "kd-lbl-names";
        const dl = h("datalist", { id: listId }); for (const n of (kind === "label" || kind === "global_label") ? existingLabels(kind, doc) : []) dl.append(h("option", { value: n }));
        const single = textInput(st.text, undefined, { id: "kd-lbl-text", disabled: ro, style: "width:100%" }); single.setAttribute("list", listId); single.autocomplete = "off";
        const area = h("textarea", { id: "kd-lbl-multi", rows: 5, style: "width:100%;font-family:inherit", disabled: ro }) as HTMLTextAreaElement; area.value = st.text;
        const host = h("div", { style: "flex:1;min-width:0" }, single, dl);
        textEl = single;
        const showMulti = (on: boolean): void => { host.replaceChildren(on ? area : single, dl); if (on) area.value = single.value; else single.value = area.value.split("\n")[0] || ""; textEl = on ? area : single; textEl.focus(); };
        const row = h("div", { style: "display:flex;gap:8px;align-items:flex-start" }, h("label", { style: "padding-top:4px" }, "Label:"), host,
          h("a", { href: "#", class: "kd-note", style: "padding-top:4px;white-space:nowrap", onclick: (ev: Event) => { ev.preventDefault(); help(); } }, "Syntax help"));
        b.append(row);
        if (isNew && kind !== "hierarchical_label" || (isNew && kind === "hierarchical_label")) {
          const cbRow = checkbox("Multiple label input", labelMem.multi, (on) => { labelMem.multi = on; showMulti(on); }, { id: "kd-lbl-multicb" });
          multiCb = cbRow.querySelector("input") as HTMLInputElement; b.append(h("div", { style: "margin:4px 0 0 46px" }, cbRow));
          if (labelMem.multi) showMulti(true);
        }
      }
      // Fields
      const fHost = h("div", { style: "margin-top:8px" }); b.append(fHost);
      grid = fieldsGrid(fHost, L.fieldRows(staged, origin, mandatory), { readOnly: ro, doc, newName: nextFieldName, height: 150, shown: [0, 1, 2, 3, 4, 5, 6, 7] });
      // Shape + Formatting
      const bottom = h("div", { style: "display:flex;gap:12px;align-items:stretch;margin-top:4px" });
      const shapes = L.labelShapes(kind);
      if (shapes.length) { const sh = h("div"); const box = KD().staticBox(sh, "Shape"); box.append(radioGroup("kd-lbl-shape", shapes, st.shape)); bottom.append(sh); }
      const fm = h("div", { style: "flex:1" }); const fbox = KD().staticBox(fm, "Formatting");
      const grd = h("div", { class: "kd-fmt" });
      boldB = toggle("B", "Bold", st.bold, "kd-lbl-bold", "font-weight:700"); italB = toggle("I", "Italic", st.italic, "kd-lbl-italic", "font-style:italic");
      const spinNames = dir ? ["Down", "Up", "Right", "Left"] : ["Align right", "Align left", "Align bottom", "Align top"];
      const spinGlyph = ["→", "←", "↑", "↓"];
      // m_spin0..3: RIGHT, LEFT, UP, BOTTOM (SPIN_STYLE 0, 2, 1, 3)
      const spinVal = [0, 2, 1, 3] as const;
      const bar = h("span", { style: "display:inline-flex;gap:2px;align-items:center" });
      if (!dir) bar.append(boldB, italB, h("span", { class: "kd-sep" }));
      spinVal.forEach((sv, i) => { const btn = toggle(spinGlyph[i], spinNames[i], st.spin === sv, "kd-lbl-spin" + i); btn.dataset.group = "spin"; btn.dataset.spin = String(sv); spins.push(btn); bar.append(btn); });
      color = swatch(st.color, "kd-lbl-color", undefined, ro);
      if (dir) grd.append(h("label", null, "Orientation:"), bar, h("span"));
      else { fontSel = fontPicker(doc, st.font, { id: "kd-lbl-font", style: "width:200px", disabled: ro }); grd.append(h("label", null, "Font:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, fontSel, bar), h("span")); }
      sizeIn = lenBox(st.size, "kd-lbl-size");
      grd.append(h("label", null, dir ? "Pin length:" : "Text size:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, sizeIn, units()), h("span"));
      grd.append(h("label", null, "Color:"), color.el, h("span"));
      fbox.append(grd);
      if (kind === "global_label" || kind === "hierarchical_label") {
        const S = CollabTools.sch ? CollabTools.sch.state as { lastAutoRotate?: boolean } : {};
        const a = checkbox("Auto", isNew ? !!S.lastAutoRotate : st.autoRotate, undefined, { id: "kd-lbl-auto", title: "Automatically rotate the label to face away from the wire or pin it is placed on" });
        autoCb = a.querySelector("input") as HTMLInputElement; fbox.append(a);
      }
      bottom.append(fm); b.append(bottom);
      // a directive label starts in the first field's value (SetInitialFocus( m_grid ), m_delayedFocusRow 0)
      initialFocus(dir ? b.querySelector(".kd-grid tbody tr input[data-col=value]") as HTMLInputElement | null : textEl);
    },
    ok() {
      if (ro || !body || !grid) return;
      const size = sizeIn ? lenValue(sizeIn) : st.size;
      if (size === undefined || size < 0.01 || size > 1000) { void messageBox(`The value must be between ${fmtLen(0.01)} and ${fmtLen(1000)} ${unitName()}.`); return false; }
      const raw = textEl ? textEl.value : "";
      const multi = !!(multiCb && multiCb.checked);
      if (!dir && !raw.trim()) { void messageBox("Label can not be empty."); return false; }
      const rows = L.tidyRows(grid.rows());
      const dup = L.duplicateFieldName(rows); if (dup) { void messageBox(dup); return false; }
      const spinBtn = spins.find(isOn);
      const next: L.LabelState = { text: raw, shape: radioValue(body, "kd-lbl-shape") || st.shape, font: fontSel ? fontSel.value : st.font, size,
        bold: boldB ? isOn(boldB) : st.bold, italic: italB ? isOn(italB) : st.italic, color: color ? color.get() : st.color,
        spin: spinBtn ? Number(spinBtn.dataset.spin) as 0 | 1 | 2 | 3 : st.spin, autoRotate: !!(autoCb && autoCb.checked) };
      // "Auto": the label takes its spin from what it sits on (GetLabelOrientationForPoint) and the spin buttons are skipped
      const ar = AR();
      if (!isNew && next.autoRotate && ar) next.spin = ar.labelOrientationForPoint(doc, origin, st.spin, item.id);
      const moved = rows.some((r) => L.rowMoved(r, origin));
      const lines = dir ? [""] : L.labelLines(raw, multi, isNew);
      if (!lines.length) { void messageBox("Label can not be empty."); return false; }
      const build = (text: string): SNode => {
        const n = L.clone(staged); L.writeLabel(kind, n, Object.assign({}, next, { text }));
        L.writeFields(n, rows, origin);
        if (moved) L.drop(n, "fields_autoplaced");
        return n;
      };
      const S = CollabTools.sch ? CollabTools.sch.state as Record<string, unknown> : {};
      // createNewLabel remembers bold / italic / orientation / shape / auto-rotate for the next label
      if (!dir) { S.lastTextBold = next.bold; S.lastTextItalic = next.italic; }
      if (isNew) {
        S.lastTextSpin = next.spin;
        if (kind === "global_label" || kind === "hierarchical_label") { S.lastLabelShape = next.shape; S.lastAutoRotate = next.autoRotate; }
        if (dir) S.lastFlagShape = next.shape;
        const nodes = lines.map((t) => build(dir ? "" : t));
        for (let i = 1; i < nodes.length; i++) { const u = L.kid(nodes[i], "uuid"); if (u) u[1] = KiCadCanvas.newUuid() as unknown as SNode; }
        return opts.onCreate ? opts.onCreate(nodes[0], nodes.slice(1)) as boolean | undefined : undefined;
      }
      if (ar && (kind === "global_label" || kind === "hierarchical_label")) ar.setAutoRotate(item.id, next.autoRotate);
      commitItem(ctx, item, build(dir ? "" : lines[0]), "Edit Label Properties");
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- DIALOG_TEXT_PROPERTIES (text and text box)
export function openTextDialog(ctx: Ctx, item: KItem, opts: ItemOpts): void {
  ensureCss();
  const kind = item.kind, doc = ctx.doc, box = kind === "text_box", ro = !!ctx.viewOnly;
  const staged = L.clone(item.node), fx = L.readFx(staged), rot = L.atOf(staged)[2], vertical = Math.round(rot) % 180 !== 0;
  const stroke = L.readStroke(staged), fill = L.readFill(staged), exclude = L.yes(staged, "exclude_from_sim");
  let body: HTMLElement | null = null;
  const els: Record<string, HTMLElement> = {};
  let tcol: Swatch | null = null, bcol: Swatch | null = null, fcol: Swatch | null = null;
  KD().open({
    title: opts.title || (box ? "Text Box Properties" : "Text Properties"), width: 640, readOnly: ro, cancel: opts.cancel,
    build(b) {
      body = b;
      const ta = h("textarea", { id: "kd-txt-text", rows: 5, style: "width:100%;font-family:var(--mono, monospace)", disabled: ro }) as HTMLTextAreaElement; ta.value = L.str(staged[1]); els.text = ta;
      b.append(h("div", { style: "display:flex;gap:8px;align-items:flex-start" }, h("label", { style: "padding-top:4px" }, "Text:"), ta));
      b.append(h("div", { style: "text-align:right" }, h("span", { class: "kd-note" }, `${keyName("Ctrl+Enter")} or Shift+Enter: OK`)));
      const g = h("div", { class: "kd-fmt", style: "margin-top:6px" });
      const fontSel = fontPicker(doc, fx.font, { id: "kd-txt-font", style: "width:200px", disabled: ro }); els.font = fontSel;
      const bold = toggle("B", "Bold", fx.bold, "kd-txt-bold", "font-weight:700"), ital = toggle("I", "Italic", fx.italic, "kd-txt-italic", "font-style:italic"); els.bold = bold; els.italic = ital;
      const hb = (["left", "center", "right"] as const).map((v, i) => { const t = toggle(["⇤", "↔", "⇥"][i], ["Align left", "Align horizontal center", "Align right"][i], fx.h === v, "kd-txt-h-" + v); t.dataset.group = "h"; t.dataset.v = v; return t; });
      const vb = (["top", "center", "bottom"] as const).map((v, i) => { const t = toggle(["⤒", "↕", "⤓"][i], ["Align top", "Align vertical center", "Align bottom"][i], fx.v === v, "kd-txt-v-" + v); t.dataset.group = "v"; t.dataset.v = v; return t; });
      const hz = toggle("A", "Horizontal text", !vertical, "kd-txt-horiz"), vt = toggle("A↑", "Vertical text", vertical, "kd-txt-vert"); hz.dataset.group = "o"; vt.dataset.group = "o";
      hb.forEach((t, i) => { els["h" + i] = t; }); vb.forEach((t, i) => { els["v" + i] = t; }); els.horiz = hz; els.vert = vt;
      const bar = h("span", { style: "display:inline-flex;gap:2px;align-items:center;flex-wrap:wrap" }, bold, ital, h("span", { class: "kd-sep" }), ...hb, h("span", { class: "kd-sep" }), ...vb, h("span", { class: "kd-sep" }), hz, vt);
      g.append(h("label", null, "Font:"), h("span", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, fontSel, bar), h("span"));
      const size = lenBox(fx.size, "kd-txt-size"); els.size = size;
      g.append(h("label", null, "Text size:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, size, units()), h("span"));
      tcol = swatch(fx.color, "kd-txt-color", undefined, ro);
      g.append(h("label", null, "Text color:"), tcol.el, h("span"));
      if (box) {
        const bw = lenBox(stroke.width, "kd-txt-bwidth"); els.bwidth = bw; bcol = swatch(stroke.color, "kd-txt-bcolor", undefined, ro);
        const bst = select(L.LINE_STYLES, stroke.style, undefined, { id: "kd-txt-bstyle", disabled: ro }); els.bstyle = bst;
        const border = checkbox("Border", stroke.width >= 0, undefined, { id: "kd-txt-border" }); els.border = border.querySelector("input") as HTMLInputElement;
        g.append(h("span"), border, h("span"), h("label", null, "Width:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, bw, units()), h("span"),
          h("label", null, "Color:"), bcol.el, h("span"), h("label", null, "Style:"), bst, h("span"));
        const fillCb = checkbox("Background fill", fill.mode !== "none", (on) => fcol && fcol.enable(on), { id: "kd-txt-fill" }); els.fill = fillCb.querySelector("input") as HTMLInputElement;
        fcol = swatch(fill.color, "kd-txt-fcolor", undefined, ro || fill.mode === "none");
        g.append(h("span"), fillCb, h("span"), h("label", null, "Fill color:"), fcol.el, h("span"));
      }
      const se = opts.symbolEditor;
      if (se) {
        // m_fgSymbolEditor: Private to Symbol Editor, Common to all units / body styles
        const priv = checkbox("Private to Symbol Editor", se.private, undefined, { id: "kd-txt-private" }); els.private = priv.querySelector("input") as HTMLInputElement;
        const au = checkbox("Common to all units", se.multiUnit && se.allUnits, undefined, { id: "kd-txt-allunits", disabled: !se.multiUnit }); els.allUnits = au.querySelector("input") as HTMLInputElement;
        const ab = checkbox("Common to all body styles", se.multiBody && se.allBodies, undefined, { id: "kd-txt-allbodies", disabled: !se.multiBody }); els.allBodies = ab.querySelector("input") as HTMLInputElement;
        g.append(h("span"), h("span", { style: "display:flex;flex-direction:column;gap:3px;margin-top:6px" }, priv, au, ab), h("span"));
      } else {
        const href = textInput(fx.href, undefined, { id: "kd-txt-link", style: "width:100%", disabled: ro }); els.link = href;
        g.append(h("label", null, "Link:"), href, h("span"));
        const hyper = checkbox("Make this text item a clickable hyperlink", !!fx.href, (on) => { if (!on) (href as HTMLInputElement).value = ""; }, { id: "kd-txt-hyper" });
        g.append(h("span"), hyper, h("span"));
        const ex = checkbox("Exclude from simulation", exclude, undefined, { id: "kd-txt-exsim" }); els.exsim = ex.querySelector("input") as HTMLInputElement;
        g.append(h("span"), ex, h("span"));
      }
      b.append(g);
      initialFocus(ta);
    },
    ok() {
      if (ro || !body) return;
      const text = (els.text as HTMLTextAreaElement).value.replace(/\r/g, "\n");
      const size = lenValue(els.size as HTMLInputElement);
      if (size === undefined || size < 0.01 || size > 1000) { void messageBox(`The value must be between ${fmtLen(0.01)} and ${fmtLen(1000)} ${unitName()}.`); return false; }
      const link = els.link ? (els.link as HTMLInputElement).value.trim() : fx.href;
      if (!L.validHyperlink(link)) { void messageBox(L.BAD_LINK); return false; }
      const n = L.clone(staged); n[1] = text as unknown as SNode;
      const hv = (["left", "center", "right"] as const).find((v, i) => isOn(els["h" + i])) || fx.h;
      const vv = (["top", "center", "bottom"] as const).find((v, i) => isOn(els["v" + i])) || fx.v;
      L.writeFx(n, { font: (els.font as FontPickerEl).value, size: Math.abs(size - fx.size) > 1e-9 ? size : undefined, bold: isOn(els.bold), italic: isOn(els.italic),
        color: tcol ? tcol.get() : fx.color, h: hv, v: vv, href: link });
      const vert = isOn(els.vert), [x, y] = L.atOf(n);
      if (vert !== vertical) L.setAt(n, x, y, vert ? 90 : 0);
      if (els.exsim) L.setYes(n, "exclude_from_sim", (els.exsim as HTMLInputElement).checked, ["at"], true);
      if (box) {
        const on = (els.border as HTMLInputElement).checked, w = lenValue(els.bwidth as HTMLInputElement);
        L.writeStroke(n, { width: on ? Math.max(0, w ?? 0) : -1, style: (els.bstyle as HTMLSelectElement).value, color: bcol ? bcol.get() : stroke.color });
        if (!on) { const s = L.kid(n, "stroke"); const wd = s && L.kid(s, "width"); if (wd) wd[1] = -1 as unknown as SNode; }
        const filled = (els.fill as HTMLInputElement).checked;
        L.writeFill(n, filled ? "solid" : "none", filled ? (fcol ? fcol.get() : fill.color) : null);
      }
      if (opts.symbolEditor) { opts.symbolEditor.apply(n, { private: (els.private as HTMLInputElement).checked, allUnits: (els.allUnits as HTMLInputElement).checked, allBodies: (els.allBodies as HTMLInputElement).checked }); return undefined; }
      const S = CollabTools.sch ? CollabTools.sch.state as Record<string, unknown> : {};
      if (opts.onCreate) { S.lastTextBold = isOn(els.bold); S.lastTextItalic = isOn(els.italic); S.lastTextH = hv; S.lastTextV = vv; S.lastTextVertical = vert; return opts.onCreate(n) as boolean | undefined; }
      commitItem(ctx, item, n, box ? "Edit Text Box" : "Edit Text");
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- DIALOG_FIELD_PROPERTIES
/**
 * `apply`: the Symbol Editor's own commit (SYMBOL_EDITOR_EDIT_TOOL::editFieldProperties) of the edited field node; the
 * item is then a "lib_symbol" holding the field in schematic coordinates.
 */
export function openFieldDialog(ctx: Ctx, item: KItem, name: string, apply?: (field: SNode) => void): boolean {
  ensureCss();
  const p0 = L.kids(item.node, "property").find((p) => L.fieldName(p) === name); if (!p0) return false;
  const doc = ctx.doc, ro = !!ctx.viewOnly, fx = L.readFx(p0), [x0, y0, r0] = L.atOf(p0), isFile = item.kind === "sheet" && (name === "Sheetfile" || name === "Sheet file");
  const els: Record<string, HTMLElement> = {}; let col: Swatch | null = null;
  KD().open({
    title: L.fieldDialogTitle(name, item.kind), width: 560, readOnly: ro,
    build(b) {
      const g = h("div", { class: "kd-fmt" });
      const text = textInput(L.fieldValue(p0), undefined, { id: "kd-fld-text", style: "width:100%", disabled: ro || isFile }); els.text = text;
      g.append(h("label", null, "Text:"), text, h("span"));
      if (isFile) g.append(h("span"), h("span", { class: "kd-note", id: "kd-fld-note" }, "Sheet filename can only be modified in Sheet Properties dialog."), h("span"));
      const vis = checkbox("Visible", !fx.hidden, undefined, { id: "kd-fld-visible" }), sn = checkbox("Show field name", L.yes(p0, "show_name"), undefined, { id: "kd-fld-showname" }), ap = checkbox("Allow automatic placement", !L.yes(p0, "do_not_autoplace"), undefined, { id: "kd-fld-autoplace" });
      els.visible = vis.querySelector("input") as HTMLInputElement; els.showName = sn.querySelector("input") as HTMLInputElement; els.autoplace = ap.querySelector("input") as HTMLInputElement;
      g.append(h("span"), h("span", { style: "display:flex;gap:14px;flex-wrap:wrap" }, vis, sn, ap), h("span"));
      const font = fontPicker(doc, fx.font, { id: "kd-fld-font", style: "width:200px", disabled: ro }); els.font = font;
      const bold = toggle("B", "Bold", fx.bold, "kd-fld-bold", "font-weight:700"), ital = toggle("I", "Italic", fx.italic, "kd-fld-italic", "font-style:italic"); els.bold = bold; els.italic = ital;
      const vertical = Math.round(r0) % 180 !== 0;
      const hz = toggle("A", "Horizontal text", !vertical, "kd-fld-horiz"), vt = toggle("A↑", "Vertical text", vertical, "kd-fld-vert"); hz.dataset.group = "o"; vt.dataset.group = "o"; els.vert = vt;
      const hb = (["left", "center", "right"] as const).map((v, i) => { const t = toggle(["⇤", "↔", "⇥"][i], ["Align left", "Align horizontal center", "Align right"][i], fx.h === v, "kd-fld-h-" + v); t.dataset.group = "h"; els["h" + i] = t; return t; });
      const vb = (["top", "center", "bottom"] as const).map((v, i) => { const t = toggle(["⤒", "↕", "⤓"][i], ["Align top", "Align vertical center", "Align bottom"][i], fx.v === v, "kd-fld-v-" + v); t.dataset.group = "v"; els["v" + i] = t; return t; });
      g.append(h("label", null, "Font:"), h("span", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, font, bold, ital, h("span", { class: "kd-sep" }), hz, vt), h("span"));
      const size = lenBox(fx.size, "kd-fld-size"); els.size = size;
      g.append(h("label", null, "Text size:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, size, units()), h("span"));
      col = swatch(fx.color, "kd-fld-color", undefined, ro);
      g.append(h("label", null, "Color:"), col.el, h("span"));
      g.append(h("label", null, "Alignment:"), h("span", { style: "display:inline-flex;gap:2px;align-items:center" }, ...hb, h("span", { class: "kd-sep" }), ...vb), h("span"));
      const px = lenBox(x0, "kd-fld-x"), py = lenBox(y0, "kd-fld-y"); els.x = px; els.y = py;
      g.append(h("label", null, "Position X:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, px, units()), h("span"), h("label", null, "Position Y:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, py, units()), h("span"));
      b.append(g);
    },
    ok() {
      if (ro) return;
      const size = lenValue(els.size as HTMLInputElement);
      if (size === undefined || size < 0.01 || size > 1000) { void messageBox(`The value must be between ${fmtLen(0.01)} and ${fmtLen(1000)} ${unitName()}.`); return false; }
      // FIELD_VALIDATOR on the text of a Reference, Footprint, Datasheet, Sheetname or Sheetfile field
      const fid: L.FieldId | null = item.kind === "symbol" || item.kind === "lib_symbol" ? (name === "Reference" ? "REFERENCE" : name === "Footprint" ? "FOOTPRINT" : name === "Datasheet" ? "DATASHEET" : null)
        : item.kind === "sheet" ? (/^Sheet ?name$/i.test(name) ? "SHEET_NAME" : isFile ? "SHEET_FILENAME" : null) : null;
      const verr = fid && !isFile ? L.fieldValidationError(fid, (els.text as HTMLInputElement).value) : "";
      if (verr) { void messageBox(verr, "Field Validation Error"); (els.text as HTMLInputElement).focus(); return false; }
      const staged = L.clone(item.node); const p = L.kids(staged, "property").find((q) => L.fieldName(q) === name) as SNode;
      const hv = (["left", "center", "right"] as const).find((v, i) => isOn(els["h" + i])) || fx.h, vv = (["top", "center", "bottom"] as const).find((v, i) => isOn(els["v" + i])) || fx.v;
      const row = L.rowFromField(p, [0, 0], false);
      Object.assign(row, { value: isFile ? row.value : (els.text as HTMLInputElement).value, show: (els.visible as HTMLInputElement).checked, showName: (els.showName as HTMLInputElement).checked,
        autoplace: (els.autoplace as HTMLInputElement).checked, font: (els.font as FontPickerEl).value, size, bold: isOn(els.bold), italic: isOn(els.italic), color: col ? col.get() : fx.color,
        h: hv, v: vv, orient: isOn(els.vert) ? 90 : 0, x: lenValue(els.x as HTMLInputElement) ?? x0, y: lenValue(els.y as HTMLInputElement) ?? y0 });
      const moved = L.rowMoved(row, [0, 0]);
      const np = L.fieldFromRow(row, [0, 0]);
      if (apply) { apply(np); return undefined; }
      for (let j = 1; j < staged.length; j++) if (staged[j] === p) staged[j] = np;
      // a symbol's reference also lives in its instance data (SCH_SYMBOL::SetRef)
      if (name === "Reference" && item.kind === "symbol") { const here = sheetPathNow(doc); L.setInstanceData(staged, here.path, here.project, { reference: row.value }); }   // SetUserRef( *aSheetPath, m_text )
      let out = staged;
      if (moved) L.drop(out, "fields_autoplaced");
      else if (L.yes(out, "fields_autoplaced") && item.kind === "symbol") {   // the parent is autoplaced again (editFieldText)
        const H = schH(); const a = H && H.autoplaceNode(doc, Object.assign({}, item, { node: out }) as KItem); if (a) out = a;
      }
      if (item.kind === "symbol" && (name === "Value" || name === "Footprint" || name === "Datasheet")) {
        // the value, footprint and datasheet fields are kept in sync in (annotated) multi-unit parts
        if (JSON.stringify(out) !== JSON.stringify(item.node)) commitWithOtherUnits(ctx, item, out, [KiCadCanvas.replaceChange(ctx.doc, Object.assign({}, item, { node: out, geom: [], bbox: null }) as KItem)], `Edit ${name}`, "field:" + name);
      } else commitItem(ctx, item, out, `Edit ${name}`);
      return undefined;
    },
  });
  return true;
}


// ---------------------------------------------------------------- line endings (createLineEndingControls)
/** MakeLineEndingBitmap as a small canvas glyph: a short line ending in the chosen shape (pointing left for the start). */
function endingGlyph(style: L.EndingStyle, atEnd: boolean): HTMLCanvasElement {
  const c = h("canvas", { width: 36, height: 14, class: "kd-ending-glyph", style: "width:36px;height:14px;vertical-align:middle" }) as HTMLCanvasElement;
  const g = c.getContext && c.getContext("2d"); if (!g) return c;
  const fg = getComputedStyle(document.body).getPropertyValue("--ink").trim() || "#222"; g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = 1.5;
  const y = 7, tip = atEnd ? 33 : 3, back = atEnd ? -1 : 1, L0 = 9, W = 8;
  const body0 = atEnd ? 3 : 33, body1 = style === "arrow" ? tip + back * L0 : style === "circle" || style === "square" ? tip + back * L0 / 2 : tip;
  g.beginPath(); g.moveTo(body0, y); g.lineTo(body1, y); g.stroke();
  g.beginPath();
  if (style === "arrow") { g.moveTo(tip, y); g.lineTo(tip + back * L0, y - W / 2); g.lineTo(tip + back * L0, y + W / 2); g.closePath(); g.fill(); }
  else if (style === "arrow_open") { g.moveTo(tip + back * L0, y - W / 2); g.lineTo(tip, y); g.lineTo(tip + back * L0, y + W / 2); g.stroke(); }
  else if (style === "circle") { g.ellipse(tip + back * L0 / 2, y, L0 / 2, W / 2, 0, 0, Math.PI * 2); g.fill(); }
  else if (style === "square") { g.rect(tip + back * L0 - (atEnd ? 0 : L0), y - W / 2, L0, W); g.fill(); }
  return c;
}
interface EndingsBlock { el: HTMLElement; apply(n: SNode): void; reset(): void }
/** The Start Shape / End Shape columns with Length / Width / Thickness and the help line, over one or more nodes. */
function endingsBlock(nodes: SNode[], ro: boolean, version: number): EndingsBlock {
  const off = ro || version < L.LINE_ENDING_VERSION;
  const side = (key: "start_shape" | "end_shape", label: string) => {
    const sts = nodes.map((n) => L.readEndingState(n, key));
    const sty = L.common(sts.map((x) => x.style)), len = L.common(sts.map((x) => x.length)), wid = L.common(sts.map((x) => x.width)), thk = L.common(sts.map((x) => x.thickness));
    const opts: [string, string][] = L.ENDING_CHOICES.map(([v, t]) => [v, t]); if (sty === undefined) opts.push(["", "Leave unchanged"]);
    const glyphHost = h("span", { style: "display:inline-flex;align-items:center;min-width:38px" });
    const showGlyph = (v: string): void => { glyphHost.innerHTML = ""; if (v) glyphHost.append(endingGlyph(v as L.EndingStyle, key === "end_shape")); };
    const sel = select(opts, sty === undefined ? "" : sty, (v) => showGlyph(v), { id: "kd-ln-" + key, disabled: off }); showGlyph(sel.value);
    const box = (v: number | undefined, id: string): HTMLInputElement => { const i = lenBox(v, id); if (v === undefined) i.value = INDETERMINATE_ACTION; i.disabled = off; return i; };
    const l = box(len, `kd-ln-${key}-length`), w = box(wid, `kd-ln-${key}-width`), t = box(thk, `kd-ln-${key}-thickness`);
    const col = h("div", { class: "kd-fmt", style: "display:grid;grid-template-columns:max-content auto max-content;gap:3px 6px;align-items:center" },
      h("label", null, label), h("span", { style: "display:flex;gap:4px;align-items:center" }, glyphHost, sel), h("span"),
      h("label", { style: "padding-left:15px" }, "Length:"), l, units(), h("label", { style: "padding-left:15px" }, "Width:"), w, units(), h("label", { style: "padding-left:15px" }, "Thickness:"), t, units());
    const apply = (n: SNode): void => {
      const cur = L.readEndingState(n, key);
      if (sel.value) cur.style = sel.value as L.EndingStyle;
      const lv = lenValue(l), wv = lenValue(w), tv = lenValue(t);
      if (lv !== undefined) cur.length = Math.max(0, lv); if (wv !== undefined) cur.width = Math.max(0, wv); if (tv !== undefined) cur.thickness = Math.max(0, tv);
      if (cur.style === "none") { if (L.kid(n, key)) L.writeEndingState(n, key, cur); return; }
      const before = L.kid(n, key) ? KiCadCanvas.serialize(L.kid(n, key) as SNode) : "";
      const probe = L.clone(n); L.writeEndingState(probe, key, cur);
      if (KiCadCanvas.serialize(L.kid(probe, key) as SNode) !== before) L.writeEndingState(n, key, cur);
    };
    const reset = (): void => { if (off) return; sel.value = "none"; showGlyph("none"); for (const i of [l, w, t]) i.value = fmtLen(0); };
    return { col, apply, reset };
  };
  const a = side("start_shape", "Start Shape:"), b = side("end_shape", "End Shape:");
  const el = h("div", { id: "kd-ln-endings", style: "margin-top:10px" }, h("div", { style: "display:flex;gap:20px" }, a.col, b.col), h("p", { class: "kd-note", style: "font-style:italic;margin:8px 0 0" }, L.ENDINGS_HELP));
  if (version < L.LINE_ENDING_VERSION) el.title = "Line endings need a schematic saved by KiCad 10 or later";
  return { el, apply: (n) => { if (off) return; a.apply(n); b.apply(n); }, reset: () => { a.reset(); b.reset(); } };
}

// ---------------------------------------------------------------- lines, wires & buses, junctions (several at once)
function strokeDialog(ctx: Ctx, items: KItem[], kind: "lines" | "wires"): void {
  ensureCss();
  const ro = !!ctx.viewOnly, strokes = items.filter((i) => i.kind !== "junction").map((i) => L.readStroke(i.node)), juncs = items.filter((i) => i.kind === "junction");
  const w = L.common(strokes.map((s) => s.width)), sty = L.common(strokes.map((s) => s.style)), c = L.common(strokes.map((s) => s.color));
  const jd = L.common(juncs.map((j) => L.readJunction(j.node).diameter));
  let width: HTMLInputElement, style: HTMLSelectElement, jsize: HTMLInputElement | null = null, col: Swatch | null = null, colTouched = false, ends: EndingsBlock | null = null;
  // lineTypeNames (Solid … Dash-Dot-Dot); the wire & bus list ends with DEFAULT_WIRE_STYLE_LABEL, the line list has no
  // Default entry (a default-styled line shows DEFAULT_LINE_STYLE_LABEL, "Solid"); mixed styles add INDETERMINATE_STYLE
  const named = L.LINE_STYLES.filter(([v]) => v !== "default");
  const styles: [string, string][] = kind === "wires" ? [...named, ["default", "Default"]] : named;
  if (sty === undefined) styles.push(["", "Leave unchanged"]);
  const sty0 = sty === undefined ? "" : kind === "lines" && sty === "default" ? "solid" : sty;
  KD().open({
    title: kind === "lines" ? "Line Properties" : "Wire & Bus Properties", width: kind === "lines" ? 620 : 420, readOnly: ro,
    // DIALOG_WIRE_BUS_PROPERTIES::resetDefaults
    // DIALOG_WIRE_BUS_PROPERTIES::resetDefaults / DIALOG_LINE_PROPERTIES::resetDefaults (width 0, colour unspecified,
    // DEFAULT_LINE_STYLE_LABEL; both ending shapes None and their six sizes 0)
    extra: !ro ? [{ label: "Default", fn: () => { width.value = fmtLen(0); if (col) { col.set(null); colTouched = true; } style.value = kind === "wires" ? "default" : "solid"; if (jsize && !jsize.disabled) jsize.value = fmtLen(0); if (ends) ends.reset(); } }] : [],
    build(b) {
      const g = h("div", { class: "kd-fmt" });
      width = lenBox(w, "kd-ln-width"); if (w === undefined) width.value = INDETERMINATE_ACTION;
      g.append(h("label", null, kind === "lines" ? "Width:" : "Wire/bus width:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, width, units()), h("span"));
      col = swatch(c === undefined ? null : c, "kd-ln-color", () => { colTouched = true; }, ro);
      g.append(h("label", null, "Color:"), col.el, h("span"));
      style = select(styles, sty0, undefined, { id: "kd-ln-style", disabled: ro });
      g.append(h("label", null, "Style:"), style, h("span"));
      if (kind === "wires") {
        jsize = lenBox(jd, "kd-ln-jsize"); jsize.disabled = ro || !juncs.length; if (juncs.length && jd === undefined) jsize.value = INDETERMINATE_ACTION;
        g.append(h("label", null, "Junction size:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, jsize, units()), h("span"));
      }
      b.append(g);
      if (kind === "lines") { ends = endingsBlock(items.map((i) => i.node), ro, Number((ctx.doc as KDoc & { version?: number }).version) || 0); b.append(ends.el); }
    },
    ok() {
      if (ro) return;
      const nw = lenValue(width), ns = style.value && style.value !== sty0 ? style.value : undefined, nj = jsize ? lenValue(jsize) : undefined;
      const changes: KChange[] = [];
      for (const it of items) {
        const n = L.clone(it.node);
        if (it.kind === "junction") { if (nj !== undefined) L.writeJunction(n, { diameter: nj }); if (colTouched && col) L.writeJunction(n, { color: col.get() }); }
        else { L.writeStroke(n, { width: nw, style: ns, color: colTouched && col ? col.get() : undefined }); if (ends) ends.apply(n); }
        if (JSON.stringify(n) !== JSON.stringify(it.node)) changes.push(KiCadCanvas.replaceChange(ctx.doc, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
      }
      if (changes.length) ctx.commit(changes, kind === "lines" ? "Edit Line Properties" : "Edit Wire/Bus Properties");
      return undefined;
    },
  });
}
function junctionDialog(ctx: Ctx, items: KItem[]): void {
  ensureCss();
  const ro = !!ctx.viewOnly, vals = items.map((i) => L.readJunction(i.node));
  const d = L.common(vals.map((v) => v.diameter)), c = L.common(vals.map((v) => v.color));
  let dia: HTMLInputElement, col: Swatch | null = null, colTouched = false;
  KD().open({
    title: "Junction Properties", width: 400, readOnly: ro,
    build(b) {
      const g = h("div", { class: "kd-fmt" });
      dia = lenBox(d, "kd-jn-diameter"); if (d === undefined) dia.value = INDETERMINATE_ACTION;
      g.append(h("label", null, "Diameter:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, dia, units()), h("span"));
      col = swatch(c === undefined ? null : c, "kd-jn-color", () => { colTouched = true; }, ro);
      g.append(h("label", null, "Color:"), col.el, h("span"));
      b.append(g, h("p", { class: "kd-note", style: "margin-top:8px" }, "Set diameter to 0 to use schematic's junction dot size."));
    },
    ok() {
      if (ro) return;
      const nd = lenValue(dia); const changes: KChange[] = [];
      for (const it of items) {
        const n = L.clone(it.node); L.writeJunction(n, { diameter: nd, color: colTouched && col ? col.get() : undefined });
        if (JSON.stringify(n) !== JSON.stringify(it.node)) changes.push(KiCadCanvas.replaceChange(ctx.doc, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem));
      }
      if (changes.length) ctx.commit(changes, "Edit Junction Properties");
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- DIALOG_SHAPE_PROPERTIES / DIALOG_IMAGE_PROPERTIES
/** EDA_SHAPE::GetFriendlyName (the title is "%s Properties"). */
const SHAPE_NAMES: Record<string, string> = { rectangle: "Rectangle", circle: "Circle", arc: "Arc", bezier: "Curve", polyline: "Polygon", rule_area: "Rule Area" };
function shapeDialog(ctx: Ctx, item: KItem): void {
  ensureCss();
  const ro = !!ctx.viewOnly, st = L.readStroke(item.node), fl = L.readFill(item.node), name = SHAPE_NAMES[item.kind] || "Shape", rule = item.kind === "rule_area";
  const els: Record<string, HTMLInputElement | HTMLSelectElement> = {}; let bc: Swatch | null = null, fc: Swatch | null = null;
  const withEnds = L.supportsEndings(item.kind, item.node); let ends: EndingsBlock | null = null;
  KD().open({
    title: `${name} Properties`, width: withEnds ? 620 : 440, readOnly: ro,
    build(b) {
      const g = h("div", { class: "kd-fmt" });
      const bw = lenBox(st.width >= 0 ? st.width : 0, "kd-sh-width"); els.width = bw;
      const style = select(L.LINE_STYLES, st.style, undefined, { id: "kd-sh-style", disabled: ro }); els.style = style;
      bc = swatch(st.color, "kd-sh-bcolor", undefined, ro);
      const border = checkbox("Border", st.width >= 0, (on) => { bw.disabled = !on; style.disabled = !on; if (bc) bc.enable(on); if (on && !lenValue(bw)) bw.value = fmtLen(0); }, { id: "kd-sh-border" });
      els.border = border.querySelector("input") as HTMLInputElement;
      g.append(h("span"), border, h("span"), h("label", null, "Border width:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, bw, units()), h("span"),
        h("label", null, "Border color:"), bc.el, h("span"), h("label", null, "Border style:"), style, h("span"));
      const fill = select(L.FILL_MODES, fl.mode, (v) => { if (fc) fc.enable(v !== "none"); }, { id: "kd-sh-fill", disabled: ro }); els.fill = fill;
      fc = swatch(fl.color, "kd-sh-fcolor", undefined, ro || fl.mode === "none");
      g.append(h("label", null, "Fill:"), fill, h("span"), h("label", null, "Fill color:"), fc.el, h("span"));
      b.append(g);
      if (withEnds) { ends = endingsBlock([item.node], ro, Number((ctx.doc as KDoc & { version?: number }).version) || 0); b.append(ends.el); }
      if (rule) {
        const a = h("div", { style: "margin-top:6px" });
        for (const [k, label] of [["exclude_from_sim", "Exclude from simulation"], ["in_bom", "Exclude from bill of materials"], ["on_board", "Exclude from board"], ["dnp", "Do not populate"]] as [string, string][]) {
          const inv = k === "in_bom" || k === "on_board"; const on = L.kid(item.node, k) ? (inv ? !L.yes(item.node, k) : L.yes(item.node, k)) : false;
          const c = checkbox(label, on, undefined, { id: "kd-sh-" + k }); els[k] = c.querySelector("input") as HTMLInputElement; a.append(c);
        }
        b.append(a);
      }
    },
    ok() {
      if (ro) return;
      const n = L.clone(item.node), on = (els.border as HTMLInputElement).checked;
      L.writeStroke(n, { width: on ? Math.max(0, lenValue(els.width as HTMLInputElement) ?? 0) : undefined, style: els.style.value, color: bc ? bc.get() : st.color });
      if (!on) { const s = L.kid(n, "stroke"); const wd = s && L.kid(s, "width"); if (wd) wd[1] = -1 as unknown as SNode; }
      L.writeFill(n, els.fill.value, fc ? fc.get() : fl.color);
      if (ends) ends.apply(n);
      if (rule) for (const k of ["exclude_from_sim", "in_bom", "on_board", "dnp"]) { const e = els[k] as HTMLInputElement | undefined; if (!e) continue; const inv = k === "in_bom" || k === "on_board"; if (L.kid(n, k) || e.checked) L.setYes(n, k, inv ? !e.checked : e.checked, ["stroke"], true); }
      commitItem(ctx, item, n, `Edit ${name}`);
      return undefined;
    },
  });
}
function imageDialog(ctx: Ctx, item: KItem): void {
  const ro = !!ctx.viewOnly, [x, y] = L.atOf(item.node), sc = L.kid(item.node, "scale"), scale = sc ? L.num(sc[1], 1) : 1;
  let px: HTMLInputElement, py: HTMLInputElement, s: HTMLInputElement;
  KD().open({
    title: "Image Properties", width: 400, readOnly: ro,
    build(b) {
      const g = h("div", { class: "kd-fmt" });
      px = lenBox(x, "kd-img-x"); py = lenBox(y, "kd-img-y"); s = textInput(String(scale), undefined, { id: "kd-img-scale", style: "width:90px", disabled: ro });
      g.append(h("label", null, "Position X:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, px, units()), h("span"), h("label", null, "Position Y:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, py, units()), h("span"),
        h("label", null, "Scale:"), s, h("span"));
      b.append(g);
    },
    ok() {
      if (ro) return;
      const v = Number(s.value); if (!Number.isFinite(v) || v <= 0) { void messageBox("Image scale must be greater than 0."); return false; }
      const n = L.clone(item.node); L.setAt(n, lenValue(px) ?? x, lenValue(py) ?? y);
      if (Math.abs(v - scale) > 1e-9) L.put(n, "scale", [L.r4(v)], ["uuid", "data"]);
      commitItem(ctx, item, n, "Edit Image");
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- dispatch
const SHAPE_KINDS = new Set(["rectangle", "circle", "arc", "bezier", "rule_area"]);
/** kicad-dialogs.js openItem asks this first; true when an eeschema dialog took the item. */
export function schItemDialog(ctx: ToolCtx, item: KItem, opts: ItemOpts = {}): boolean {
  if (!ctx.doc || ctx.doc.type !== "sch" || !item) return false;
  const c = ctx as Ctx, k = item.kind;
  if (L.LABEL_KINDS.has(k)) { openLabelDialog(c, item, opts); return true; }
  if (k === "text" || k === "text_box") { openTextDialog(c, item, opts); return true; }
  if (opts.onCreate && k !== "sheet") return false;   // other new items keep the generic sheet
  if (k === "polyline" && L.isGraphicLine(k, item.node)) { strokeDialog(c, [item], "lines"); return true; }
  if (k === "polyline") { shapeDialog(c, item); return true; }   // a polygon (SCH_SHAPE): DIALOG_SHAPE_PROPERTIES
  if (k === "wire" || k === "bus" || k === "bus_entry") { strokeDialog(c, [item], "wires"); return true; }
  if (k === "junction") { junctionDialog(c, [item]); return true; }
  if (SHAPE_KINDS.has(k)) { shapeDialog(c, item); return true; }
  if (k === "image") { imageDialog(c, item); return true; }
  if (k === "no_connect") return true;              // SCH_NO_CONNECT_T: nothing happens
  if (k === "sheet") { openSheetProperties(c, item, opts); return true; }
  if (k === "symbol") { openSymbolProperties(c, item); return true; }
  if (k === "table") { schTableDialog(ctx, item); return true; }   // SCH_EDIT_TOOL::Properties, SCH_TABLE_T: DIALOG_TABLE_PROPERTIES
  return false;
}
export function schFieldDialog(ctx: ToolCtx, item: KItem, name: string): boolean {
  if (!ctx.doc || ctx.doc.type !== "sch" || !item) return false;
  return openFieldDialog(ctx as Ctx, item, name);
}
function selectedIds(): Set<string> {
  const ids = new Set<string>(E.selection); if (E.selected) ids.add(E.selected.id);
  const S = CollabTools.sch ? CollabTools.sch.state as { sel?: string | null; multi?: Iterable<string> | null } : null;
  if (S && S.sel) ids.add(S.sel); if (S && S.multi) for (const i of S.multi) ids.add(i);
  return ids;
}
/**
 * SCH_EDIT_TOOL::Properties for the schematic (E / double-click with a selection): true when handled.  With
 * nothing selected and the cursor over the title block, Page Settings.
 */
export function schProperties(): boolean {
  if (!E.kdoc || E.kdoc.type !== "sch") return false;
  const ctx = toolCtx() as Ctx;
  const items = Array.from(selectedIds()).map((id) => (E.kdoc as KDoc).items.get(id)).filter((x): x is KItem => !!x);
  const t = L.propertiesTarget(items.map((i) => ({ id: i.id, kind: i.kind, node: i.node })));
  if (t.dialog === "lines") { strokeDialog(ctx, items, "lines"); return true; }
  if (t.dialog === "junctions") { junctionDialog(ctx, items); return true; }
  if (t.dialog === "wires") { strokeDialog(ctx, items, "wires"); return true; }
  if (t.dialog === "mixed") { toast("Use Properties panel to edit properties common to selected items."); return true; }
  if (t.dialog === "item") { (KDialogs as KDialogsApi).openItem(ctx, items[0]); return true; }
  if (t.dialog === "none" && items.length) return true;   // a no-connect
  // nothing selected, the cursor over the title block: Page Settings
  const S = CollabTools.sch ? CollabTools.sch.state as { cursor?: [number, number] } : null, cur = S && S.cursor, page = (E.kdoc as KDoc & { page?: [number, number] }).page;
  if (!items.length && cur && page && overDrawingSheet(cur)) { openPageSettings(); return true; }
  return false;
}
/** SCH_EDIT_TOOL propertiesCondition's empty-selection case: the drawing sheet shows and an item of it lies within five pixels. */
export function overDrawingSheet(p: [number, number]): boolean {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.type !== "sch") return false;
  const ppm = (toolCtx() as Ctx).pxPerMm || 1;
  return KiCadCanvas.hitTestDrawingSheet(doc, p[0], p[1], 5 / ppm);
}
/** Hook the dialogs into kicad-dialogs.js (called once from dialogs/index.ts). */
export function installSchItemDialogs(): void {
  const kd = (window as unknown as { KDialogs?: Record<string, unknown> }).KDialogs; if (!kd) return;
  kd.schItemDialog = schItemDialog; kd.schFieldDialog = schFieldDialog; kd.confirm = confirmBox; kd.schProperties = schProperties; kd.overDrawingSheet = overDrawingSheet;
  void HL;
}
