// pcbdialogs/array — Create Array (DIALOG_CREATE_ARRAY) for the board editor, run by ARRAY_TOOL::CreateArray.
// The layout follows dialog_create_array_base: a Grid Array page (Grid Array Size, Items Spacing, Stagger Settings,
// Grid Position) and a Circular Array page (Center position with Select Point... / Select Item..., Duplication
// Settings), then Item Source (Duplicate / Arrange selection) and Footprint Annotation (hidden when arranging).  The
// pad numbering panels belong to the footprint editor and stay hidden here, as in pcbnew.  The settings outlive the
// dialog for the session (s_arrayOptions) and are kept only on a successful OK.  OK runs TransferDataFromWindow: the
// counts and stagger must be whole numbers ("Bad numeric value for %s: %s"), and an array that would stack copies on
// one another asks "Confirm Array" first.  The copies themselves are PcbTools.arrayChanges (ARRAY_TOOL::onDialogClosed).
import { checkField, form, h, lenField, messageBox, notebook, numField, openDialog, textField, unitLabel, type Field } from "./ui";

/** The dialog's settings (mm, degrees; counts as typed). */
export interface ArrayEntries {
  gridNx: string; gridNy: string; gridDx: number; gridDy: number; gridOffsetX: number; gridOffsetY: number; gridStagger: string; gridStaggerRows: boolean;
  gridCentred: boolean; circCentreX: number; circCentreY: number; circAngle: number; circClockwise: boolean; circOffsetAngle: number; circCount: string;
  circFullCircle: boolean; circRotate: boolean; tab: number; arrange: boolean; reannotate: boolean;
}

/** CREATE_ARRAY_DIALOG_ENTRIES' defaults. */
export const ARRAY_DEFAULTS: ArrayEntries = {
  gridNx: "5", gridNy: "5", gridDx: 2.54, gridDy: 2.54, gridOffsetX: 0, gridOffsetY: 0, gridStagger: "1", gridStaggerRows: true, gridCentred: true,
  circCentreX: 0, circCentreY: 0, circAngle: 90, circClockwise: true, circOffsetAngle: 0, circCount: "4", circFullCircle: false, circRotate: false,
  tab: 0, arrange: false, reannotate: true,
};
let saved: ArrayEntries = { ...ARRAY_DEFAULTS };   // s_arrayOptions: the session's last accepted settings
export const resetArrayEntries = (): void => { saved = { ...ARRAY_DEFAULTS }; };

/** wxString::ToLong: the whole text an integer. */
function toLong(text: string): number | null { return /^\s*[+-]?\d+$/.test(text) ? parseInt(text, 10) : null; }

export interface ArrayOpts {
  type: "grid" | "circular"; nx?: number; ny?: number; dx?: number; dy?: number; offX?: number; offY?: number; stagger?: number; staggerRows?: boolean;
  centred?: boolean; hThenV?: boolean; reverseAlt?: boolean; centre?: [number, number]; angle?: number; angleOffset?: number; clockwise?: boolean;
  count?: number; rotateItems?: boolean; arrange?: boolean; keepRefs?: boolean;
}

/** TransferDataFromWindow's settings: the ARRAY_OPTIONS, or the errors wxMessageBox shows. */
export function arrayOptions(v: ArrayEntries): { opts: ArrayOpts | null; errors: string[] } {
  const errors: string[] = [];
  const long = (text: string, what: string): number | null => { const n = toLong(text); if (n === null) errors.push(`Bad numeric value for ${what}: ${text}`); return n; };
  let opts: ArrayOpts | null = null;
  if (v.tab === 0) {
    const nx = long(v.gridNx, "horizontal count"), ny = long(v.gridNy, "vertical count"), st = long(v.gridStagger, "stagger");
    if (nx !== null && ny !== null && st !== null)
      opts = { type: "grid", nx, ny, dx: v.gridDx, dy: v.gridDy, offX: v.gridOffsetX, offY: v.gridOffsetY, stagger: st, staggerRows: v.gridStaggerRows, centred: v.gridCentred, hThenV: true, reverseAlt: false };
  } else {
    const n = long(v.circCount, "point count");
    if (n !== null) opts = { type: "circular", centre: [v.circCentreX, v.circCentreY], angle: v.circAngle, angleOffset: v.circOffsetAngle, clockwise: v.circClockwise, count: n, rotateItems: v.circRotate };
  }
  if (opts) { opts.arrange = v.arrange; opts.keepRefs = !v.reannotate; }
  return { opts, errors };
}

/** The confirmation for an array that stacks copies (arrayHasStackedPositions). */
export const stackedMessage = (n: number): string =>
  `The array configuration would place ${n} items at the same position and rotation, stacking them on top of one another.\n\nProceed anyway?`;

interface ArrayApi {
  arrayChanges(doc: KDoc, ids: string[], o: ArrayOpts): { changes: KChange[]; ids: string[]; label: string };
  arraySize(o: ArrayOpts): number; arrayStacked(o: ArrayOpts, pos: [number, number]): boolean; arrayOrigin(doc: KDoc, ids: string[]): [number, number];
  applySelection(ctx: ToolCtx, ids: string[]): void; anchorOf(item: KItem): [number, number];
  pickInteractively(ctx: ToolCtx, mode: "point" | "item", prompt: string, done: (r: [number, number] | KItem | null) => void): void;
  requestSelection(ctx: ToolCtx, opts: { rerun(c: ToolCtx): void }): { ids: string[] } | null;
}
const PT = (): ArrayApi => (window as unknown as { PcbTools: ArrayApi }).PcbTools;

/** The ids Create Array works on: PCB_SELECTION_TOOL::RequestSelection (the selection, else the item under the cursor). */
function selectedIds(ctx: ToolCtx): string[] | null {
  const sel = PT().requestSelection(ctx, { rerun: (c: ToolCtx) => { createArrayDialog(c); } });
  return sel && sel.ids.length ? sel.ids : null;
}

/** ARRAY_TOOL::CreateArray: the dialog over the selection, then the array. */
export function createArrayDialog(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc; if (!doc || ctx.viewOnly) return false;
  const ids = selectedIds(ctx); if (!ids) return true;   // nothing to array: RequestSelection came back empty
  const origin = PT().arrayOrigin(doc, ids);
  const v0 = { ...saved };
  const f: Record<string, Field<string | number | boolean>> = {};
  const reg = <T extends string | number | boolean>(k: string, x: Field<T>): Field<T> => { f[k] = x as unknown as Field<string | number | boolean>; return x; };
  const radios: Record<string, HTMLInputElement> = {};
  const radio = (name: string, key: string, label: string, on: boolean, tip?: string): HTMLElement => {
    const input = h("input", { type: "radio", name: "kd-arr-" + name, checked: on, "data-k": key }); radios[key] = input;
    return h("label", { class: "pd-check", title: tip }, input, label);
  };
  let book: { show(i: number): void; current(): number } | null = null;
  let annotBox: HTMLElement | null = null;
  const current = (): ArrayEntries => ({
    gridNx: String(f.gridNx.get()), gridNy: String(f.gridNy.get()), gridDx: Number(f.gridDx.get()), gridDy: Number(f.gridDy.get()), gridOffsetX: Number(f.gridOffsetX.get()), gridOffsetY: Number(f.gridOffsetY.get()),
    gridStagger: String(f.gridStagger.get()), gridStaggerRows: radios.staggerRows.checked, gridCentred: radios.centred.checked,
    circCentreX: Number(f.circCentreX.get()), circCentreY: Number(f.circCentreY.get()), circAngle: Number(f.circAngle.get()), circClockwise: radios.clockwise.checked,
    circOffsetAngle: Number(f.circOffsetAngle.get()), circCount: String(f.circCount.get()), circFullCircle: !!f.circFullCircle.get(), circRotate: !!f.circRotate.get(),
    tab: book ? book.current() : v0.tab, arrange: radios.arrange.checked, reannotate: radios.unique.checked,
  });
  // setControlEnablement + calculateCircularArrayProperties
  const update = (): void => {
    const full = !!f.circFullCircle.get();
    f.circAngle.input.disabled = full;
    if (full) { const n = toLong(String(f.circCount.get())); if (n) f.circAngle.set(360 / n); }
    if (annotBox) annotBox.style.display = radios.arrange.checked ? "none" : "";
  };
  let api: { close(): void; dialog: HTMLElement } | null = null;
  const pick = (mode: "point" | "item"): void => {   // OnSelectCenterButton: the dialog steps aside while the canvas is clicked
    if (!api) return; const ov = api.dialog.parentElement as HTMLElement; ov.style.display = "none";
    PT().pickInteractively(ctx, mode, mode === "item" ? "Select center item..." : "Select center point...", (r) => {
      ov.style.display = "";
      if (r) { const p = Array.isArray(r) ? r : PT().anchorOf(r); f.circCentreX.set(p[0]); f.circCentreY.set(p[1]); }   // UpdatePickedItem: the item's position
    });
  };
  api = openDialog({ title: "Create Array", width: 640,
    build(body) {
      reg("gridNx", textField(v0.gridNx, { key: "gridNx" })); reg("gridNy", textField(v0.gridNy, { key: "gridNy" }));
      reg("gridDx", lenField(v0.gridDx, { key: "gridDx" })); reg("gridDy", lenField(v0.gridDy, { key: "gridDy" }));
      reg("gridOffsetX", lenField(v0.gridOffsetX, { key: "gridOffsetX" })); reg("gridOffsetY", lenField(v0.gridOffsetY, { key: "gridOffsetY" }));
      reg("gridStagger", textField(v0.gridStagger, { key: "gridStagger" }));
      reg("circCentreX", lenField(v0.circCentreX, { key: "circCentreX" })); reg("circCentreY", lenField(v0.circCentreY, { key: "circCentreY" }));
      reg("circAngle", numField(v0.circAngle, { key: "circAngle", digits: 4 })); reg("circOffsetAngle", numField(v0.circOffsetAngle, { key: "circOffsetAngle", digits: 4 }));
      reg("circCount", textField(v0.circCount, { key: "circCount" }));
      reg("circFullCircle", checkField(v0.circFullCircle, "Full circle", { key: "circFullCircle", onChange: update }));
      reg("circRotate", checkField(v0.circRotate, "Rotate items", { key: "circRotate", tip: "Rotate the item as well as move it - multi-selections will be rotated together" }));
      f.circCount.input.addEventListener("input", update);
      f.circAngle.input.title = "Positive angles represent an anti-clockwise rotation. An angle of 0 will produce a full circle divided evenly into \"Count\" portions.";
      f.circCount.input.title = "How many items in the array."; f.circOffsetAngle.input.title = "Angle offset of the first item in the array";
      f.gridStagger.input.title = "Value -1,  0 or 1 disable this option.";
      const ptBtn = h("button", { type: "button", class: "btn", "data-k": "selectPoint" }, "Select Point..."); ptBtn.addEventListener("click", () => pick("point"));
      const itBtn = h("button", { type: "button", class: "btn", "data-k": "selectItem" }, "Select Item..."); itBtn.addEventListener("click", () => pick("item"));
      const rStRows = radio("stagger", "staggerRows", "Rows", v0.gridStaggerRows), rStCols = radio("stagger", "staggerCols", "Columns", !v0.gridStaggerRows);
      const rInPlace = radio("gridpos", "inPlace", "Source items remain in place", !v0.gridCentred), rCentred = radio("gridpos", "centred", "Centre on source items", v0.gridCentred);
      const rCw = radio("dir", "clockwise", "Clockwise", v0.circClockwise), rCcw = radio("dir", "anticlockwise", "Anti-clockwise", !v0.circClockwise);
      const B = (title: string, ...kids: (HTMLElement | null)[]): HTMLElement => h("div", { class: "pd-box" }, h("div", { class: "hd" }, title), ...kids.filter((k): k is HTMLElement => !!k));
      const nb = notebook([
        { label: "Grid Array", build(el) {
          el.append(h("div", { class: "pd-cols2" },
            h("div", null,
              B("Grid Array Size", form([["Horizontal count:", f.gridNx.el, null, "Number of columns"], ["Vertical count:", f.gridNy.el, null, "Number of rows"]], true)),
              B("Stagger Settings", form([["Stagger:", f.gridStagger.el, null, "Value -1,  0 or 1 disable this option."]], true),
                h("div", { class: "pd-inline", style: "gap:12px;margin-top:4px" }, rStRows, rStCols))),
            h("div", null,
              B("Items Spacing", form([["Horizontal spacing:", f.gridDx.el, unitLabel(), "Distance between columns"], ["Vertical spacing:", f.gridDy.el, unitLabel(), "Distance between rows"],
                ["Horizontal offset:", f.gridOffsetX.el, unitLabel(), "Offset added to the next row position."], ["Vertical offset:", f.gridOffsetY.el, unitLabel(), "Offset added to the next column position"]], true)),
              B("Grid Position", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
                rInPlace, rCentred)))));
        } },
        { label: "Circular Array", build(el) {
          el.append(h("div", { class: "pd-cols2" },
            B("Center position", form([["Center pos X:", f.circCentreX.el, unitLabel()], ["Center pos Y:", f.circCentreY.el, unitLabel()]], true),
              h("div", { class: "pd-inline", style: "gap:8px;margin-top:6px" }, ptBtn, itBtn)),
            B("Duplication Settings", f.circFullCircle.el,
              h("div", { class: "pd-inline", style: "gap:12px;margin:4px 0" }, h("span", null, "Direction"), rCw, rCcw),
              form([["Angle between items:", f.circAngle.el, unitLabel("deg")], ["Item count:", f.circCount.el, null, "How many items in the array."],
                ["First item angle:", f.circOffsetAngle.el, unitLabel("deg"), "Angle offset of the first item in the array"]], true),
              f.circRotate.el)));
        } },
      ], { start: v0.tab });
      book = nb;
      const tip = "This can conflict with reference designators in the schematic that have not yet been synchronized with the board.";
      const src = B("Item Source", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        radio("src", "duplicate", "Duplicate selection", !v0.arrange), radio("src", "arrange", "Arrange selection", v0.arrange, tip)));
      annotBox = B("Footprint Annotation", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        radio("annot", "keep", "Keep existing reference designators", !v0.reannotate), radio("annot", "unique", "Assign unique reference designators", v0.reannotate, tip)));
      radios.duplicate.addEventListener("change", update); radios.arrange.addEventListener("change", update);
      body.append(nb.el, h("div", { class: "pd-cols2", style: "margin-top:8px" }, src, annotBox));
      update();
    },
    ok() {
      const v = current();
      const { opts, errors } = arrayOptions(v);
      if (!opts) { messageBox("Message", errors.length ? errors.join("\n") : "Bad parameters"); return false; }
      const run = (): void => {
        saved = v;   // m_cfg_persister.ReadConfigFromControls
        const r = PT().arrayChanges(doc, ids, opts);
        if (r.changes.length) ctx.commit(r.changes, r.label);
        if (!opts.arrange) PT().applySelection(ctx, r.ids);
      };
      const n = PT().arraySize(opts);
      if (n > 1 && PT().arrayStacked(opts, origin)) {
        messageBox("Confirm Array", stackedMessage(n), [{ label: "No" }, { label: "Yes", fn: () => { run(); if (api) api.close(); } }]);
        return false;
      }
      run(); return true;
    } });
  return !!api;
}
