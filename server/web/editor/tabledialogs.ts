// tabledialogs — the table dialogs the cell editing needs, besides the board's Table Properties (pcbdialogs/table.ts):
//
//  - Table Cell Properties on a board (pcbnew/dialogs/dialog_tablecell_properties.cpp): cell contents, font, bold /
//    italic, the alignment buttons, knockout, text width / height / thickness with the auto-thickness link, the four
//    cell margins and "Edit Table...".
//  - Table Cell Properties on a schematic (eeschema/dialogs/dialog_tablecell_properties.cpp): contents, font, bold /
//    italic, size, text colour, background fill, alignment, margins and "Edit Table...".
//  - Table Properties on a schematic (eeschema/dialogs/dialog_table_properties.cpp): the cell grid, then External /
//    Header border and Row / Column lines with width, style and colour.  Draw Table opens it on the new table.
//
// Several cells at once: a value the cells disagree on shows "-- mixed values --" (INDETERMINATE_STATE) and is left
// alone unless it is edited; bold / italic only change when toggled, an alignment only when one of its buttons is
// down.  A cell whose values do not change keeps its bytes.  Each OK is one change of the table node.
import { LINE_STYLES, tableDialog } from "./pcbdialogs/table";
import { fontField } from "../dialogs/font-picker";
import { box, checkField, errorMessage, fmtLen, form, h, lenField, messageBox, openDialog, parseLen, selectField, unitLabel, unitName, type Field } from "./pcbdialogs/ui";
import { syntaxHelp } from "./syntax-help";
import { boardXref } from "./pcbdialogs/xref";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const M = () => KiCadCanvas.tableModel;
const kid = (n: SNode | null | undefined, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const f6 = (v: number): number => +(+v).toFixed(6);
const f4 = (v: number): number => +(+v).toFixed(4);
export const MIXED = "-- mixed values --";

function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
/** Replace / insert / remove the child `key` of node (inserted before the first of `before` present, else at the end). */
function put(node: SNode, key: string, child: SNode | null, before: string[] = []): void {
  const i = idxOf(node, key);
  if (child === null) { if (i > 0) node.splice(i, 1); return; }
  if (i > 0) { node[i] = child; return; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, child);
}
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");
const flag = (font: SNode | null, f: string): boolean => !!font && (yes(kid(font, f)) || font.includes(f));

// ---------------------------------------------------------------- one cell's values
export interface CellValues {
  text: string; face: string; bold: boolean; italic: boolean; knockout: boolean;
  w: number; h: number; thick: number;   // thick NaN: auto thickness
  hAlign: string; vAlign: string;        // left | center | right, top | center | bottom
  ml: number; mt: number; mr: number; mb: number;
  color: string; fill: string;           // schematic: "" (unspecified / no fill) or "r g b a"
}
const colorStr = (n: SNode | null): string => (n ? [nval(n, 1), nval(n, 2), nval(n, 3), nval(n, 4, 1)].join(" ") : "");
export function cellValues(cell: SNode, isPcb: boolean): CellValues {
  const ef = kid(cell, "effects"), font = kid(ef, "font"), sz = kid(font, "size"), th = kid(font, "thickness"), j = kid(ef, "justify");
  const just = j ? j.slice(1).map(String) : [];
  const mg = kid(cell, "margins"); const h0 = sz ? nval(sz, 1, 1.27) : 1.27;
  const fl = kid(cell, "fill"); const ft = kid(fl, "type");
  return {
    text: String(cell[1] ?? ""), face: String((kid(font, "face") || [])[1] ?? ""), bold: flag(font, "bold"), italic: flag(font, "italic"),
    knockout: yes(kid(cell, "knockout")), w: sz ? nval(sz, 2, h0) : 1.27, h: h0, thick: th ? nval(th) : NaN,
    hAlign: just.includes("left") ? "left" : just.includes("right") ? "right" : "center",
    vAlign: just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "center",
    ml: nval(mg, 1), mt: nval(mg, 2), mr: nval(mg, 3), mb: nval(mg, 4),
    color: colorStr(kid(font, "color")), fill: isPcb ? "" : (ft && String(ft[1]) === "color" ? colorStr(kid(fl, "color")) : ""),
  };
}
type Patch = Partial<CellValues>;
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === "number" && typeof b === "number" && (Math.abs(a - b) < 1e-9 || (isNaN(a) && isNaN(b))));
/** Write the patch's fields into the cell (in the file writer's token order); fields already equal are not touched. */
export function writeCell(cell: SNode, isPcb: boolean, patch: Patch): void {
  const cur = cellValues(cell, isPcb); const diff = (k: keyof CellValues): boolean => k in patch && !same(patch[k], cur[k]);
  const r = isPcb ? f6 : f4;
  if (diff("text")) cell[1] = String(patch.text).replace(/\r/g, "");
  const fontKeys: (keyof CellValues)[] = ["face", "bold", "italic", "w", "h", "thick", "color"];
  if (fontKeys.some(diff) || diff("hAlign") || diff("vAlign")) {
    let ef = kid(cell, "effects"); if (!ef) { ef = ["effects", ["font", ["size", 1.27, 1.27]]]; put(cell, "effects", ef, isPcb ? ["knockout"] : ["uuid"]); }
    let font = kid(ef, "font"); if (!font) { font = ["font"]; ef.splice(1, 0, font); }
    const v = { ...cur, ...patch };
    if (diff("face")) put(font, "face", v.face ? ["face", v.face] : null, ["size"]);
    if (diff("w") || diff("h")) put(font, "size", ["size", r(v.h), r(v.w)], ["line_spacing", "thickness", "bold", "italic", "color"]);
    if (diff("thick")) put(font, "thickness", isNaN(v.thick) ? null : ["thickness", r(v.thick)], ["bold", "italic", "color"]);
    for (const f of ["bold", "italic"] as const) {
      if (!diff(f)) continue;
      const bare = font.indexOf(f); if (bare > 0) font.splice(bare, 1);
      put(font, f, v[f] ? [f, "yes"] : null, f === "bold" ? ["italic", "color"] : ["color"]);
    }
    if (diff("color")) put(font, "color", v.color ? ["color", ...v.color.split(" ").map(Number)] : null);
    if (diff("hAlign") || diff("vAlign")) {
      const j0 = kid(ef, "justify"); const mirror = !!j0 && j0.includes("mirror");
      const jj = [...(v.hAlign !== "center" ? [v.hAlign] : []), ...(v.vAlign !== "center" ? [v.vAlign] : []), ...(mirror ? ["mirror"] : [])];
      put(ef, "justify", jj.length ? ["justify", ...jj] : null, ["hide", "href"]);
    }
  }
  if (diff("knockout") && isPcb) put(cell, "knockout", ["knockout", patch.knockout ? "yes" : "no"]);
  if (diff("ml") || diff("mt") || diff("mr") || diff("mb")) {
    const v = { ...cur, ...patch }; const mg = kid(cell, "margins");
    if (mg) { mg[1] = r(v.ml); mg[2] = r(v.mt); mg[3] = r(v.mr); mg[4] = r(v.mb); }
    else put(cell, "margins", ["margins", r(v.ml), r(v.mt), r(v.mr), r(v.mb)], ["span"]);
  }
  if (!isPcb && diff("fill")) put(cell, "fill", patch.fill ? ["fill", ["type", "color"], ["color", ...String(patch.fill).split(" ").map(Number)]] : ["fill", ["type", "none"]], ["effects", "uuid"]);
}

/** The values the selected cells share; a key they disagree on is in `mixed`. */
export function mergedValues(cells: SNode[], isPcb: boolean): { v: CellValues; mixed: Set<keyof CellValues> } {
  const all = cells.map((c) => cellValues(c, isPcb)); const v = { ...all[0] }; const mixed = new Set<keyof CellValues>();
  for (const k of Object.keys(v) as (keyof CellValues)[]) if (all.some((o) => !same(o[k], v[k]))) mixed.add(k);
  return { v, mixed };
}

/**
 * The fields of a dialog's patch the user changed: a value the cells shared (not in `mixed`) that still equals what
 * the dialog showed is left out, so the commit, made on the table as it is when OK is pressed, keeps what a peer
 * wrote there meanwhile.  Without a peer's edit the result is the same, as the cells already hold those values.
 */
export function changedFields(patch: Patch, shown: CellValues, mixed: Set<keyof CellValues>): Patch {
  const out: Patch = {};
  for (const k of Object.keys(patch) as (keyof CellValues)[]) if (mixed.has(k) || !same(patch[k], shown[k])) (out as Record<string, unknown>)[k] = patch[k];
  return out;
}

/** The new table node after writing `patch` into the given cells (a copy; the original is untouched). */
export function applyCellPatch(table: SNode, isPcb: boolean, cells: number[], patch: Patch): SNode {
  const node = K().cloneNode(table); const list = M().tableInfo(node).cells;
  for (const i of cells) if (list[i]) writeCell(list[i], isPcb, patch);
  return node;
}

// ---------------------------------------------------------------- small widgets
const ICON: Record<string, string> = {
  left: "M2 3h12M2 6h8M2 9h12M2 12h8", center: "M2 3h12M4 6h8M2 9h12M4 12h8", right: "M2 3h12M6 6h8M2 9h12M6 12h8",
  top: "M2 2h12M5 5h6M5 8h6", vcenter: "M2 8h12M5 5h6M5 11h6", bottom: "M2 14h12M5 8h6M5 11h6",
};
function toggle(label: string, title: string, on: boolean, ro: boolean, key: string, path?: string): { el: HTMLButtonElement; get(): boolean; set(v: boolean): void } {
  const b = h("button", { type: "button", class: "btn tc-toggle", title, "data-k": key, disabled: ro, style: "min-width:28px;height:26px;padding:0 6px" }) as HTMLButtonElement;
  if (path) b.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="${path}"/></svg>`;
  else b.textContent = label;
  let cur = on; const paint = () => { b.classList.toggle("primary", cur); b.setAttribute("aria-pressed", String(cur)); };
  b.addEventListener("click", () => { cur = !cur; paint(); b.dispatchEvent(new Event("change")); }); paint();
  return { el: b, get: () => cur, set(v) { cur = v; paint(); } };
}
/** A radio group of toggles: none down = indeterminate. */
function alignGroup(values: [string, string, string][], cur: string | null, ro: boolean, key: string): { el: HTMLElement; get(): string | null } {
  const btns = values.map(([v, title, icon]) => ({ v, t: toggle("", title, cur === v, ro, `${key}-${v}`, ICON[icon]) }));
  for (const b of btns) b.t.el.addEventListener("change", () => { if (b.t.get()) for (const o of btns) if (o !== b) o.t.set(false); });
  return { el: h("span", { style: "display:inline-flex;gap:2px" }, ...btns.map((b) => b.t.el)), get: () => { const d = btns.find((b) => b.t.get()); return d ? d.v : null; } };
}
/** A length that may show "-- mixed values --" (UNIT_BINDER::SetIndeterminate); get() is null while it does. */
function mixedLen(v: number, mixed: boolean, ro: boolean, key: string): { el: HTMLInputElement; get(): number | null; set(x: number): void } {
  const input = h("input", { type: "text", "data-k": key, disabled: ro, value: mixed ? MIXED : fmtLen(v) }) as HTMLInputElement;
  let cur = v;
  input.addEventListener("change", () => { if (input.value === MIXED) return; const x = parseLen(input.value); if (isNaN(x)) input.value = mixed ? MIXED : fmtLen(cur); else { cur = x; input.value = fmtLen(x); } });
  return { el: input, get: () => (input.value === MIXED ? null : input.value === fmtLen(cur) ? cur : (isNaN(parseLen(input.value)) ? cur : parseLen(input.value))), set(x) { cur = x; input.value = fmtLen(x); } };
}
/** COLOR_SWATCH: a swatch that opens the colour picker; "" is the default (unspecified) colour. */
function swatch(rgba: string, mixed: boolean, ro: boolean, key: string): { el: HTMLElement; get(): string | null } {
  let cur: string | null = mixed ? null : rgba;
  const hex = (s: string) => { const p = s.split(" ").map(Number); return "#" + p.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""); };
  const sw = h("span", { class: "tc-swatch", "data-k": key, title: "Set Color...", style: "display:inline-block;width:34px;height:20px;border:1px solid var(--line);border-radius:var(--r-1);vertical-align:middle;cursor:pointer" });
  const pick = h("input", { type: "color", style: "position:absolute;opacity:0;width:0;height:0;pointer-events:none", disabled: ro }) as HTMLInputElement;
  const paint = (): void => {
    if (cur === null) { sw.style.background = "repeating-linear-gradient(45deg,var(--panel-2) 0 4px,var(--panel) 4px 8px)"; sw.title = MIXED; return; }
    if (!cur) { sw.style.background = "linear-gradient(to top left,transparent calc(50% - 1px),var(--err) 50%,transparent calc(50% + 1px)),var(--panel)"; sw.title = "Default"; return; }
    const p = cur.split(" ").map(Number); sw.style.background = `rgba(${p[0]},${p[1]},${p[2]},${p[3] ?? 1})`; sw.title = "Set Color...";
  };
  sw.addEventListener("click", () => { if (ro) return; pick.value = cur ? hex(cur) : "#000000"; pick.click(); });
  pick.addEventListener("input", () => { const v = pick.value; cur = [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1].join(" "); paint(); });
  const clear = h("button", { type: "button", class: "btn", title: "Default", disabled: ro, style: "height:22px;padding:0 6px;margin-left:4px", "data-k": key + "-default" }, "×");
  clear.addEventListener("click", () => { cur = ""; paint(); });
  paint();
  return { el: h("span", { style: "position:relative;display:inline-flex;align-items:center" }, sw, pick, clear), get: () => cur };
}


// ---------------------------------------------------------------- Table Cell Properties
export interface CellDialogOpts {
  /** "Edit Table...": the dialog has applied its changes (one commit) and closed; open the table's own dialog */
  editTable?(): void;
  /** a generated table: the text is the board's, only the formatting is the user's */
  generated?: boolean;
}

/** DIALOG_TABLECELL_PROPERTIES (board and schematic). */
export function cellPropsDialog(ctx: ToolCtx, item: KItem, cells: number[], isPcb: boolean, opts: CellDialogOpts = {}): boolean {
  const doc = ctx.doc as KDoc; if (!doc || !cells.length) return false;
  const table0 = item.node, list = M().tableInfo(table0).cells, sel = cells.filter((i) => list[i]);
  if (!sel.length) return false;
  const ro = !!ctx.viewOnly;
  const { v, mixed } = mergedValues(sel.map((i) => list[i]), isPcb);
  // a board cell shows text variable cross-references as ${REF:FIELD} (dialog_tablecell_properties.cpp:192, 414)
  const xref = isPcb ? boardXref(doc) : null;
  if (xref && !mixed.has("text")) v.text = xref.toRefs(v.text);
  const isMixed = (k: keyof CellValues) => mixed.has(k);
  let read: () => Patch = () => ({});
  let api: { close(): void } | null = null;
  const apply = (): boolean => {
    if (ro) return true;
    const patch = changedFields(read(), v, mixed);
    if (xref && patch.text !== undefined) patch.text = xref.toKiids(String(patch.text).replace(/\r/g, ""));
    // the table as it is now (a peer may have edited it while the dialog was open), its cells found by uuid
    const cur = item.id ? doc.items.get(item.id) : item;
    if (!cur || cur.kind !== "table") return true;
    const cellsNow = M().remapCells(table0, cur.node, sel);
    const node = applyCellPatch(cur.node, isPcb, cellsNow, patch);
    if (K().serialize(node) !== K().serialize(cur.node)) ctx.commit([K().replaceChange(doc, { ...cur, node, geom: [], bbox: null } as KItem)], "Edit Table Cell Properties");
    return true;
  };
  return !!openDialog({ title: "Table Cell Properties", width: isPcb ? 560 : 600, readOnly: ro, noEnter: true,
    extra: opts.editTable ? [{ label: "Edit Table...", fn: () => { apply(); api && api.close(); setTimeout(() => opts.editTable && opts.editTable(), 0); } }] : undefined,
    build(body, a) {
      api = a;
      const genText = !!opts.generated;
      const text = h("textarea", { "data-k": "cell-text", spellcheck: false, readOnly: ro || genText, style: "width:100%;min-height:72px;resize:vertical;white-space:pre-wrap;font:inherit" }) as HTMLTextAreaElement;
      text.value = isMixed("text") ? MIXED : v.text;
      text.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); a.okButton && a.okButton.click(); } });
      setTimeout(() => { text.focus(); text.select(); }, 0);
      const help = h("a", { href: "#", "data-k": "syntax-help", title: "Show syntax help window", style: "white-space:nowrap" }, "Syntax help");
      help.addEventListener("click", (ev) => { ev.preventDefault(); syntaxHelp(isPcb); });
      // the font choice: KiCad Font, the faces in use, and (several cells) the indeterminate entry
      const fontExtra: [string, string][] = isPcb ? [] : [["", "Default Font"]];
      if (isMixed("face")) fontExtra.unshift([MIXED, MIXED]);
      const font = fontField(doc, isMixed("face") ? MIXED : (v.face || ""), { ro, key: "font", extra: fontExtra, kicadValue: isPcb ? "" : "KiCad Font" });
      (font.el as HTMLElement).style.cssText = "width:auto;min-width:160px;max-width:240px";
      const bold = toggle("B", "Bold", !isMixed("bold") && v.bold, ro, "bold"), italic = toggle("I", "Italic", !isMixed("italic") && v.italic, ro, "italic");
      bold.el.style.fontWeight = "700"; italic.el.style.fontStyle = "italic";
      let boldTouched = false, italicTouched = false;
      bold.el.addEventListener("change", () => { boldTouched = true; }); italic.el.addEventListener("change", () => { italicTouched = true; });
      const hAlign = alignGroup([["left", "Align left", "left"], ["center", "Align horizontal center", "center"], ["right", "Align right", "right"]], isMixed("hAlign") ? null : v.hAlign, ro, "halign");
      const vAlign = alignGroup([["top", "Align top", "top"], ["center", "Align vertical center", "vcenter"], ["bottom", "Align bottom", "bottom"]], isMixed("vAlign") ? null : v.vAlign, ro, "valign");
      const ml = mixedLen(v.ml, isMixed("ml"), ro, "margin-left"), mt = mixedLen(v.mt, isMixed("mt"), ro, "margin-top"), mr = mixedLen(v.mr, isMixed("mr"), ro, "margin-right"), mb = mixedLen(v.mb, isMixed("mb"), ro, "margin-bottom");
      const margins = h("div", { style: "display:grid;grid-template-columns:repeat(3,minmax(60px,90px));gap:4px;align-items:center" },
        h("span"), mt.el, h("span"), ml.el, h("span", { style: "text-align:center;color:var(--ink-2)" }, unitName()), mr.el, h("span"), mb.el, h("span"));
      body.append(h("div", { style: "display:flex;justify-content:space-between;align-items:baseline" }, h("label", { class: "pd-lbl" }, "Cell contents:"), help), text);
      if (isPcb) {
        const knock = h("input", { type: "checkbox", "data-k": "knockout", disabled: ro }) as HTMLInputElement;
        knock.indeterminate = isMixed("knockout"); knock.checked = !isMixed("knockout") && v.knockout;
        const tw = mixedLen(v.w, isMixed("w"), ro, "text-width"), th = mixedLen(v.h, isMixed("h"), ro, "text-height");
        const autoMixed = isMixed("thick") && sel.some((i) => isNaN(cellValues(list[i], true).thick)) && sel.some((i) => !isNaN(cellValues(list[i], true).thick));
        let auto = !autoMixed && isNaN(v.thick);
        const pen = (w: number) => Math.round(w / 8 * 1e6) / 1e6;   // GetPenSizeForNormal
        const tk = mixedLen(isNaN(v.thick) ? pen(v.w) : v.thick, isMixed("thick") && !auto, ro || auto, "thickness");
        const autoBtn = toggle("", "Adjust the text thickness", auto, ro, "auto-thickness", "M6.5 9.5l3-3M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5L7.5 13a2.5 2.5 0 0 1-3.5-3.5L5.5 8");
        autoBtn.el.addEventListener("change", () => { auto = autoBtn.get(); tk.el.disabled = ro || auto; if (auto) { const w = tw.get(); if (w !== null) tk.set(pen(w)); } });
        tw.el.addEventListener("change", () => { if (auto) { const w = tw.get(); if (w !== null) tk.set(pen(w)); } });
        body.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin:8px 0;flex-wrap:wrap" },
          h("label", null, "Font:"), font.el, h("span", { style: "width:8px" }), hAlign.el, h("span", { style: "width:6px" }), vAlign.el, h("span", { style: "width:6px" }), bold.el, italic.el,
          h("label", { class: "pd-check", style: "margin-left:10px" }, knock, "Knockout")));
        body.append(h("div", { style: "display:flex;gap:18px;align-items:flex-start" },
          form([["Text width:", tw.el, unitLabel()], ["Text height:", th.el, unitLabel()], ["Thickness:", h("span", { style: "display:flex;gap:4px" }, tk.el, autoBtn.el), unitLabel()]]),
          h("div", null, h("label", { class: "pd-lbl" }, "Cell margins:"), margins)));
        read = () => {
          const p: Patch = {};
          if (!genText && text.value !== MIXED) p.text = text.value;
          if (boldTouched || !isMixed("bold")) p.bold = bold.get(); if (italicTouched || !isMixed("italic")) p.italic = italic.get();
          if (!knock.indeterminate) p.knockout = knock.checked;
          if (font.get() !== MIXED) p.face = font.get();
          const w = tw.get(), hh = th.get(); if (w !== null) p.w = w; if (hh !== null) p.h = hh;
          if (auto) p.thick = NaN; else { const t = tk.get(); if (t !== null) p.thick = t; }
          const ha = hAlign.get(), va = vAlign.get(); if (ha) p.hAlign = ha; if (va) p.vAlign = va;
          for (const [k, f] of [["ml", ml], ["mt", mt], ["mr", mr], ["mb", mb]] as const) { const x = f.get(); if (x !== null) p[k] = x; }
          return p;
        };
      } else {
        const size = mixedLen(v.h, isMixed("h") || isMixed("w"), ro, "text-size");
        const color = swatch(v.color, isMixed("color"), ro, "text-color"), fill = swatch(v.fill, isMixed("fill"), ro, "fill-color");
        body.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin:8px 0;flex-wrap:wrap" }, h("label", null, "Font:"), font.el, bold.el, italic.el));
        body.append(h("div", { style: "display:flex;gap:18px;align-items:flex-start" },
          form([["Size:", size.el, unitLabel()], ["Text color:", color.el], ["Background fill:", fill.el], ["Horizontal alignment:", hAlign.el], ["Vertical alignment:", vAlign.el]]),
          h("div", null, h("label", { class: "pd-lbl" }, "Cell margins:"), margins)));
        read = () => {
          const p: Patch = {};
          if (text.value !== MIXED) p.text = text.value;
          if (boldTouched || !isMixed("bold")) p.bold = bold.get(); if (italicTouched || !isMixed("italic")) p.italic = italic.get();
          const f = font.get(); if (f !== MIXED) p.face = f === "KiCad Font" ? "" : f;
          const s = size.get(); if (s !== null) { p.w = s; p.h = s; }
          const c = color.get(); if (c !== null) p.color = c; const fl = fill.get(); if (fl !== null) p.fill = fl;
          const ha = hAlign.get(), va = vAlign.get(); if (ha) p.hAlign = ha; if (va) p.vAlign = va;
          for (const [k, fld] of [["ml", ml], ["mt", mt], ["mr", mr], ["mb", mb]] as const) { const x = fld.get(); if (x !== null) p[k] = x; }
          return p;
        };
      }
    },
    ok: apply });
}

// ---------------------------------------------------------------- schematic Table Properties
interface SchStroke { width: number; style: string; color: string }
const schStroke = (n: SNode | null): SchStroke => {
  const st = kid(n, "stroke"); const t = String((kid(st, "type") || [])[1] ?? "");
  return { width: st && kid(st, "width") ? nval(kid(st, "width")) : 0, style: t && t !== "default" ? t : "solid", color: colorStr(kid(st, "color")) };
};
const strokeNode = (s: SchStroke): SNode => { const n: SNode = ["stroke", ["width", f4(Math.max(0, s.width))], ["type", s.style]]; if (s.color) n.push(["color", ...s.color.split(" ").map(Number)]); return n; };

/** DIALOG_TABLE_PROPERTIES (eeschema).  `create`: Draw Table's dialog on the new table (OK hands it over, Cancel null). */
export function schTableDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, ro = !!ctx.viewOnly, T = M().tableInfo(node0);
  const border = kid(node0, "border"), seps = kid(node0, "separators"); const bs = schStroke(border), ss = schStroke(seps);
  const inputs: (HTMLTextAreaElement | null)[][] = [];
  let f: Record<string, Field<string | number | boolean>> = {}; let bcol: { el: HTMLElement; get(): string | null } | null = null, scol: { el: HTMLElement; get(): string | null } | null = null;
  /** (border …) and (separators …) as the dialog's fields say */
  const strokes = (): { bn: SNode; sn: SNode } => {
    const b = !!f.external.get() || !!f.header.get(), s = !!f.rows.get() || !!f.cols.get();
    const bn: SNode = ["border", ["external", f.external.get() ? "yes" : "no"], ["header", f.header.get() ? "yes" : "no"]];
    if (b) bn.push(strokeNode({ width: Number(f.borderWidth.get()), style: String(f.borderStyle.get()), color: (bcol && bcol.get()) || "" }));
    const sn: SNode = ["separators", ["rows", f.rows.get() ? "yes" : "no"], ["cols", f.cols.get() ? "yes" : "no"]];
    if (s) sn.push(strokeNode({ width: Number(f.sepWidth.get()), style: String(f.sepStyle.get()), color: (scol && scol.get()) || "" }));
    return { bn, sn };
  };
  let shown: { bn: string; sn: string } | null = null;   // the strokes as the dialog opened
  return !!openDialog({ title: "Table Properties", width: 640, readOnly: ro, noEnter: true,
    build(body) {
      const tw = T.widths.reduce((a, b) => a + b, 0) || 1;
      const cols = Array.from({ length: T.cols }, (_, c) => `${Math.max(0.5, (T.widths[c] || tw / T.cols) / tw * T.cols)}fr`).join(" ");
      const gridEl = h("div", { "data-k": "cells", style: `display:grid;grid-template-columns:${cols};gap:1px;background:var(--line);border:1px solid var(--line);max-height:260px;overflow:auto` });
      let first: HTMLTextAreaElement | null = null;
      for (let r = 0; r < T.rows; r++) {
        const row: (HTMLTextAreaElement | null)[] = [];
        for (let c = 0; c < T.cols; c++) {
          const cell = T.cells[r * T.cols + c]; const [cs, rs] = M().spanOf(cell);
          const hgt = Math.max(28, Math.min(90, (T.heights[r] || 3) * 6));
          if (cs === 0 || rs === 0) { gridEl.append(h("div", { style: `min-height:${hgt}px;background:var(--panel-2)`, title: "Covered by a merged cell" })); row.push(null); continue; }
          const t = h("textarea", { "data-k": `cell-${r}-${c}`, readOnly: ro, spellcheck: false, style: `min-height:${hgt}px;resize:none;border:0;border-radius:0;padding:3px 4px;font:inherit;background:var(--bench);color:var(--ink)` }) as HTMLTextAreaElement;
          t.value = M().cellText(cell); if (!first) first = t; gridEl.append(t); row.push(t);
        }
        inputs.push(row);
      }
      if (first) { const fc = first; setTimeout(() => fc.focus(), 0); }
      const ext = yes(kid(border, "external")), hdr = yes(kid(border, "header")), rws = yes(kid(seps, "rows")), cls = yes(kid(seps, "cols"));
      const bw = lenField(bs.width, { ro, key: "borderWidth" }), bstyle = selectField<string>(bs.style, LINE_STYLES, { ro, key: "borderStyle" });
      const sw = lenField(ss.width, { ro, key: "sepWidth" }), sstyle = selectField<string>(ss.style, LINE_STYLES, { ro, key: "sepStyle" });
      bcol = swatch(bs.color, false, ro, "borderColor"); scol = swatch(ss.color, false, ro, "sepColor");
      const sync = (): void => {
        const b = !!f.external.get() || !!f.header.get(), s = !!f.rows.get() || !!f.cols.get();
        bw.input.disabled = bstyle.input.disabled = ro || !b; sw.input.disabled = sstyle.input.disabled = ro || !s;
      };
      const external = checkField(ext, "External border", { ro, key: "external", onChange: sync }), header = checkField(hdr, "Header border", { ro, key: "header", onChange: sync });
      const rows = checkField(rws, "Row lines", { ro, key: "rows", onChange: sync }), cols2 = checkField(cls, "Column lines", { ro, key: "cols", onChange: sync });
      f = { external, header, borderWidth: bw, borderStyle: bstyle, rows, cols: cols2, sepWidth: sw, sepStyle: sstyle } as unknown as Record<string, Field<string | number | boolean>>;
      body.append(h("label", { class: "pd-lbl" }, "Cell contents:"), gridEl,
        h("div", { class: "pd-cols2", style: "margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:12px" },
          box("", external.el, header.el, form([["Width:", bw.el, unitLabel()], ["Style:", bstyle.el], ["Color:", bcol.el]], true)),
          box("", rows.el, cols2.el, form([["Width:", sw.el, unitLabel()], ["Style:", sstyle.el], ["Color:", scol.el]], true))));
      for (const b of Array.from(body.querySelectorAll<HTMLElement>(".pd-box > .hd"))) if (!b.textContent) b.remove();
      sync();
      const st0 = strokes(); shown = { bn: K().serialize(st0.bn), sn: K().serialize(st0.sn) };
    },
    cancel: create ? () => create(null) : undefined,
    ok() {
      if (ro) return true;
      // Draw Table's new table is ours alone; an existing one is edited as it is now (a peer may have changed it
      // while the dialog was open): only what the user changed here is written, each cell found by its uuid
      const cur = create ? item : doc.items.get(item.id);
      if (!cur || cur.kind !== "table") return true;
      const base = cur.node, node = K().cloneNode(base); const list = M().tableInfo(node).cells;
      inputs.forEach((row, r) => row.forEach((t, c) => {
        const i = r * T.cols + c, text = t ? t.value.replace(/\r/g, "") : "";
        if (!t || !T.cells[i] || M().cellText(T.cells[i]) === text) return;
        const j = M().remapCells(node0, base, [i])[0]; const cell = j === undefined ? null : list[j];
        if (cell && String(cell[1] ?? "") !== text) cell[1] = text;
      }));
      const { bn, sn } = strokes();
      // keep the file's bytes when a part did not change
      const ob = kid(node, "border"), os = kid(node, "separators");
      const bChanged = !!create || !shown || K().serialize(bn) !== shown.bn, sChanged = !!create || !shown || K().serialize(sn) !== shown.sn;
      if (bChanged && (!ob || K().serialize(ob) !== K().serialize(bn))) put(node, "border", bn, ["separators", "column_widths"]);
      if (sChanged && (!os || K().serialize(os) !== K().serialize(sn))) put(node, "separators", sn, ["column_widths", "row_heights"]);
      if (create) { create(node); return true; }
      if (K().serialize(node) === K().serialize(base)) return true;
      ctx.commit([K().replaceChange(doc, { ...cur, node, geom: [], bbox: null } as KItem)], "Edit Table");
      return true;
    } });
}

/** Draw Table's second click on a schematic: the dialog on the new table; done gets the node, or null on Cancel. */
export function newSchTableDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = schTableDialog(ctx, { id: "", kind: "table", node, geom: [], bbox: null } as unknown as KItem, done);
  if (!ok) done(null);
  return ok;
}

/** The table's own dialog for either editor (OnEditItemRequest on a table). */
export function tablePropsDialog(ctx: ToolCtx, item: KItem, isPcb: boolean): boolean { return isPcb ? tableDialog(ctx, item) : schTableDialog(ctx, item); }

export { errorMessage };
