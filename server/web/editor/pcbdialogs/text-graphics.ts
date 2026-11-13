// pcbdialogs/text-graphics — Edit > Edit Text & Graphic Properties... (GLOBAL_EDIT_TOOL::EditTextAndGraphics,
// DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS, dialog_global_edit_text_and_graphics_base.fbp): Scope, Filter Items and
// Action ("Set to specified values" with every value starting at "-- leave unchanged --", or "Set to layer default
// values" from the Board Setup defaults shown in the grid).  Apply and Close stores one "Edit Text and Graphics" step.
import { E } from "../state";
import { boardSelection } from "./exchange";
import { checkField, errorMessage, fmtLen, h, openDialog, parseLen, unitName, type Field } from "./ui";

type Tri = boolean | null;
interface Style { line: number; w: number; h: number; thick: number; italic: boolean; upright: boolean }
interface TGApi { editTextAndGraphics(doc: KDoc, job: unknown): [string, SNode][] }
interface PcbToolsApi { textGraphics: TGApi; layerStyle(layer: string): Style; boardLayerName(doc: KDoc, name: string): string }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const LEAVE = "-- leave unchanged --";

const SCOPE: [string, string, string?][] = [["references", "Reference designators"], ["boardGraphics", "PCB graphic items"], ["values", "Values"], ["boardText", "PCB text items"],
  ["otherFootprintFields", "Other footprint fields", "Footprint fields that are not the reference designator or value field"], ["boardDimensions", "PCB dimensions"],
  ["footprintGraphics", "Footprint graphic items"], ["", ""], ["footprintTexts", "Footprint text items", "Footprint text items not associated with a field"], ["", ""], ["footprintDimensions", "Footprint dimensions"]];
// DIALOG_SHIM keeps the controls' state for the session; g_referenceFilter / g_footprintFilter are the dialog's own statics
const memory: { checks: Record<string, boolean>; reference: string; footprint: string; layer: string; defaults: boolean } = { checks: {}, reference: "", footprint: "", layer: "", defaults: false };

/** A wxCHK_3STATE check box the user can set to undetermined: undetermined -> checked -> unchecked -> undetermined. */
function triField(label: string, key: string, tip?: string): { el: HTMLElement; get(): Tri; setEnabled(on: boolean): void } {
  const input = h("input", { type: "checkbox", "data-k": key }) as HTMLInputElement;
  let v: Tri = null;
  const show = (): void => { input.indeterminate = v === null; input.checked = v === true; };
  input.addEventListener("click", () => { v = v === null ? true : v ? false : null; show(); });
  show();
  const el = h("label", { class: "pd-check", title: tip || "" }, input, " " + label);
  return { el, get: () => v, setEnabled(on) { input.disabled = !on; el.classList.toggle("dim", !on); } };
}

/** The faces the font choice offers besides KiCad Font: those the board's text uses, and the common system faces. */
export function boardFontFaces(doc: KDoc | null): string[] {
  const used = new Set<string>();
  const walk = (n: unknown): void => { if (!Array.isArray(n)) return; if (n[0] === "face" && typeof n[1] === "string" && n[1]) used.add(n[1]); for (const c of n) walk(c); };
  if (doc) for (const it of doc.items.values()) walk(it.node);
  const common = ["Arial", "Courier New", "DejaVu Sans", "DejaVu Sans Mono", "Georgia", "Helvetica", "Liberation Sans", "Noto Sans", "Times New Roman", "Verdana"];
  return Array.from(new Set([...used, ...common])).sort((a, b) => a.localeCompare(b));
}

export function openTextAndGraphics(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("This needs a board"); return; }
  const ro = !!E.viewOnly;
  const checks = new Map<string, Field<boolean>>();
  const layers = Array.from(doc.layers.keys()) as string[];
  const layerSelect = (withLeave: boolean, key: string, value: string): HTMLSelectElement => {
    const s = h("select", { "data-k": key }) as HTMLSelectElement;
    if (withLeave) s.append(h("option", { value: "" }, LEAVE));
    for (const l of layers) s.append(h("option", { value: l }, PT().boardLayerName(doc, l)));
    s.value = value; return s;
  };
  const lenInput = (key: string): HTMLInputElement => h("input", { type: "text", "data-k": key, placeholder: LEAVE, style: "width:150px" }) as HTMLInputElement;
  let specified: HTMLInputElement, defaultsRb: HTMLInputElement;
  const enables: ((on: boolean) => void)[] = [];
  let grid: HTMLElement;
  let read: () => { job: unknown } | string = () => "";
  openDialog({ title: "Edit Text and Graphic Properties", width: 860, okLabel: "Apply and Close", cancelLabel: "Close", readOnly: ro,
    build(body) {
      // Scope
      const scope = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:2px 24px" });
      for (const [k, label, tip] of SCOPE) {
        if (!k) { scope.append(h("span")); continue; }
        const f = checkField(!!memory.checks[k], label, { key: k, tip, onChange: (on) => { memory.checks[k] = on; if (k === "footprintDimensions" || k === "boardDimensions") relabel(); } }); checks.set(k, f); scope.append(f.el);
      }
      // Filter Items
      const byLayer = checkField(!!memory.checks.layerFilterOpt, "By layer:", { key: "layerFilterOpt", onChange: (on) => { memory.checks.layerFilterOpt = on; } }); checks.set("layerFilterOpt", byLayer);
      const layerFilter = layerSelect(false, "layerFilter", memory.layer || layers[0] || "F.Cu");
      layerFilter.addEventListener("change", () => { memory.layer = layerFilter.value; byLayer.set(true); memory.checks.layerFilterOpt = true; });
      const byRef = checkField(!!memory.checks.referenceFilterOpt, "By parent reference designator:", { key: "referenceFilterOpt", onChange: (on) => { memory.checks.referenceFilterOpt = on; } }); checks.set("referenceFilterOpt", byRef);
      const refText = h("input", { type: "text", "data-k": "referenceFilter", value: memory.reference }) as HTMLInputElement;
      refText.addEventListener("input", () => { memory.reference = refText.value; byRef.set(true); memory.checks.referenceFilterOpt = true; });
      const byFp = checkField(!!memory.checks.footprintFilterOpt, "By parent footprint library link:", { key: "footprintFilterOpt", onChange: (on) => { memory.checks.footprintFilterOpt = on; } }); checks.set("footprintFilterOpt", byFp);
      const fpText = h("input", { type: "text", "data-k": "footprintFilter", value: memory.footprint }) as HTMLInputElement;
      fpText.addEventListener("input", () => { memory.footprint = fpText.value; byFp.set(true); memory.checks.footprintFilterOpt = true; });
      const selOnly = checkField(!!memory.checks.selectedItemsFilter, "Selected items only", { key: "selectedItemsFilter", onChange: (on) => { memory.checks.selectedItemsFilter = on; } }); checks.set("selectedItemsFilter", selOnly);
      const filters = h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center" }, byLayer.el, layerFilter, byRef.el, refText, byFp.el, fpText, selOnly.el, h("span"));
      // Action: specified values
      specified = h("input", { type: "radio", name: "tg-action", "data-k": "setToSpecifiedValues" }) as HTMLInputElement;
      defaultsRb = h("input", { type: "radio", name: "tg-action", "data-k": "setToLayerDefaults" }) as HTMLInputElement;
      specified.checked = !memory.defaults; defaultsRb.checked = memory.defaults;
      const layerCtrl = layerSelect(true, "layer", "");
      const visible = triField("Visible  (fields only)", "visible");
      const lineW = lenInput("lineWidth");
      // FONT_CHOICE: KiCad Font, then the faces (those the board's text already uses and the common system faces)
      const fontSel = h("select", { "data-k": "font" }, h("option", { value: "" }, LEAVE), h("option", { value: "kicad" }, "KiCad Font"),
        ...boardFontFaces(doc).map((f) => h("option", { value: "face:" + f }, f))) as HTMLSelectElement;
      const bold = triField("Bold", "bold"), italic = triField("Italic", "italic"), upright = triField("Keep upright", "keepUpright");
      const textW = lenInput("textWidth"), textH = lenInput("textHeight"), thick = lenInput("thickness");
      const auto = h("button", { type: "button", class: "btn", "data-k": "autoThickness", title: "Adjust the text thickness", "aria-pressed": "false" }, "Auto") as HTMLButtonElement;
      let autoOn = false;
      // onTextSize: GetPenSizeForNormal( min( width, height ) ) = size / 8
      const autoValue = (): void => { if (!autoOn) return; const w = parseLen(textW.value), hh = parseLen(textH.value); if (textW.value.trim() && textH.value.trim() && isFinite(w) && isFinite(hh)) thick.value = fmtLen(Math.min(w, hh) / 8); else thick.value = "(auto)"; };
      auto.addEventListener("click", () => { autoOn = !autoOn; auto.setAttribute("aria-pressed", String(autoOn)); auto.classList.toggle("on", autoOn); if (autoOn) { autoValue(); thick.disabled = true; } else { thick.disabled = !specified.checked; thick.value = ""; } });
      textW.addEventListener("input", autoValue); textH.addEventListener("input", autoValue);
      const center = checkField(false, "Center on footprint", { key: "centerOnFP", tip: "Move footprint texts to the center of their parent" });
      const u = (): HTMLElement => h("span", { class: "unit" }, unitName());
      const spec = h("div", { style: "display:grid;grid-template-columns:auto auto auto 24px auto;gap:4px 8px;align-items:center;margin:4px 0 8px 22px" },
        h("span", { class: "pd-lbl" }, "Layer:"), layerCtrl, h("span"), h("span"), visible.el,
        h("span", { class: "pd-lbl" }, "Line thickness:"), lineW, u(), h("span"), h("span"),
        h("span", { class: "pd-lbl" }, "Font:"), fontSel, h("span"), h("span"), bold.el,
        h("span", { class: "pd-lbl" }, "Text width:"), textW, u(), h("span"), italic.el,
        h("span", { class: "pd-lbl" }, "Text height:"), textH, u(), h("span"), upright.el,
        h("span", { class: "pd-lbl" }, "Text thickness:"), h("span", { style: "display:flex;gap:4px" }, thick, auto), u(), h("span"), center.el);
      enables.push((on) => {
        for (const el of [layerCtrl, lineW, fontSel, textW, textH] as (HTMLInputElement | HTMLSelectElement)[]) el.disabled = !on;
        thick.disabled = !on || autoOn; auto.disabled = !on;
        for (const t of [visible, bold, italic, upright]) t.setEnabled(on);
        (center.input as HTMLInputElement).disabled = !on;
        grid.classList.toggle("dim", on);
      });
      // Action: layer defaults (the Board Setup values, read-only)
      const cell = (t: string, head = false): HTMLElement => h(head ? "th" : "td", { style: "padding:2px 8px;border:1px solid var(--line);text-align:" + (head ? "center" : "right") }, t);
      const ROWS: [string, string, boolean][] = [["Silk Layers", "F.SilkS", true], ["Copper Layers", "F.Cu", true], ["Edge Cuts", "Edge.Cuts", false], ["Courtyards", "F.CrtYd", false], ["Fab Layers", "F.Fab", true], ["Other Layers", "User.1", true]];
      const tbl = h("table", { style: "border-collapse:collapse;font-size:12px;margin:4px 0 0 22px" },
        h("tr", null, cell("", true), cell("Line Thickness", true), cell("Text Width", true), cell("Text Height", true), cell("Text Thickness", true), cell("Italic", true), cell("Keep Upright", true)));
      for (const [name, layer, text] of ROWS) {
        const s = PT().layerStyle(layer); const L = (v: number): string => `${fmtLen(v)} ${unitName()}`;
        tbl.append(h("tr", null, h("td", { style: "padding:2px 8px;border:1px solid var(--line)" }, name), cell(L(s.line)), cell(text ? L(s.w) : ""), cell(text ? L(s.h) : ""), cell(text ? L(s.thick) : ""),
          cell(text ? (s.italic ? "✓" : "") : ""), cell(text ? (s.upright ? "✓" : "") : "")));
      }
      grid = tbl;
      const defLabel = h("span", null, "Set to layer default values:");
      const relabel = (): void => { defLabel.textContent = checks.get("footprintDimensions")?.get() || checks.get("boardDimensions")?.get() ? "Set to layer and dimension default values:" : "Set to layer default values:"; };
      const onAction = (): void => { memory.defaults = defaultsRb.checked; for (const fn of enables) fn(specified.checked); };
      specified.addEventListener("change", onAction); defaultsRb.addEventListener("change", onAction);
      body.append(
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0 16px" },
          h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Scope"), scope),
          h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Filter Items"), filters)),
        h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Action"),
          h("label", { style: "display:flex;gap:6px;align-items:center" }, specified, "Set to specified values:"), spec,
          h("label", { style: "display:flex;gap:6px;align-items:center" }, defaultsRb, defLabel), tbl));
      relabel(); onAction();
      // the values the OK handler reads
      read = (): { job: unknown } | string => {
        const len = (inp: HTMLInputElement, label: string, minMax?: [number, number]): number | null | string => {
          const t = inp.value.trim(); if (!t || t === LEAVE || t === "(auto)") return null;
          const v = parseLen(t); if (!isFinite(v)) return `${label} must be a number.`;
          if (minMax && v < minMax[0]) return `${label} must be at least ${fmtLen(minMax[0])} ${unitName()}.`;
          if (minMax && v > minMax[1]) return `${label} must be less than ${fmtLen(minMax[1])} ${unitName()}.`;
          return v;
        };
        const tw = len(textW, "Text width", [0.001, 250]), th = len(textH, "Text height", [0.001, 250]), lw = len(lineW, "Line thickness"), tk = len(thick, "Text thickness");
        for (const v of [tw, th, lw, tk]) if (typeof v === "string") return v;
        const scopeOut: Record<string, boolean> = {}; for (const [k] of SCOPE) if (k) scopeOut[k] = !!checks.get(k)?.get();
        return { job: {
          scope: scopeOut,
          filter: { layer: byLayer.get() ? layerFilter.value : null, reference: byRef.get() && refText.value ? refText.value : null, footprint: byFp.get() && fpText.value ? fpText.value : null, selectedOnly: selOnly.get() },
          specified: specified.checked,
          values: { layer: layerCtrl.value || null, visible: visible.get(), lineWidth: lw, kicadFont: fontSel.value === "kicad", font: fontSel.value === "kicad" ? "" : fontSel.value.startsWith("face:") ? fontSel.value.slice(5) : null, textWidth: tw, textHeight: th, thickness: tk, autoThickness: autoOn,
            bold: bold.get(), italic: italic.get(), keepUpright: upright.get(), centerOnFootprint: center.get() },
          selection: boardSelection(ctx) } };
      };
    },
    ok() {
      if (ro) return true;
      const r = read(); if (typeof r === "string") { errorMessage(r); return false; }
      const mods = PT().textGraphics.editTextAndGraphics(doc, r.job);
      const changes: KChange[] = [];
      for (const [id, node] of mods) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node })); }
      if (changes.length) ctx.commit(changes, "Edit Text and Graphics");
      ctx.requestRender();
      return true;
    } });
}
