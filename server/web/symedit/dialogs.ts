// symedit/dialogs.ts — the Symbol Editor's dialogs in the shared kicad-dialogs shell: Pin Properties
// (DIALOG_PIN_PROPERTIES), Symbol Properties (DIALOG_LIB_SYMBOL_PROPERTIES), New Symbol (DIALOG_LIB_NEW_SYMBOL),
// Save As, New Library, Rename, Pin Table (DIALOG_LIB_EDIT_PIN_TABLE), the Symbol Checker report, the field / text /
// shape properties and the import / export commands.
import * as M from "./model";
import { KD, h, checkbox, select, textInput, form, promptText, confirmBox, download, type GridColumn, type GridApi, type NotebookApi } from "../dialogs/dom";
import { messageBox, fieldsGrid, openFieldDialog, openTextDialog, swatch } from "../dialogs/sch-items";
import * as L from "../dialogs/sch-items-logic";
import { E, appState, api } from "../dialogs/editor";
import { saveTextDocument } from "../editor/projectfile";
import { UNITS, unitName } from "../units";   // a dialog's unit label (EDA_UNIT_UTILS::GetLabel: "mm", "in", "mils")
import { hotkeyRows } from "../menuspec";
import { keyName } from "../keys";
import type { SymbolEditor, Lib } from "./editor";
import { nodeOf } from "./editor";
import { icon } from "./ui";
import { pinMapPage, pinMapState, harvestPinMaps } from "./pinmap";
import * as FF from "./fpfilters";
import { openSimModel } from "../dialogs/sim-model";
import { embeddedModelFiles, projectModelFiles, refPrefix, simPinsOfLib } from "../dialogs/sim-files";
import { libDocFor } from "./libdoc";
import type { Units } from "../store";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
export const typeLabel = (t: string): string => (M.PIN_TYPES.find((p) => p[0] === t) || [t, t])[1];
export const shapeLabel = (t: string): string => (M.PIN_SHAPES.find((p) => p[0] === t) || [t, t])[1];
export const orientLabel = (a: number): string => (M.PIN_ORIENTATIONS.find((p) => p[0] === a) || [a, "Right"])[1];
export const kindLabel = (k: string): string => ({ rectangle: "Rectangle", circle: "Circle", arc: "Arc", polyline: "Polyline", bezier: "Bezier Curve", text: "Text", text_box: "Text Box", ellipse: "Ellipse", ellipse_arc: "Elliptical Arc" } as Record<string, string>)[k] || k;

// ---------------------------------------------------------------- lengths in the user's units
const units = (): Units => (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
const toUser = (mm: number): string => { const u = UNITS[units()]; return String(+u.f(mm).toFixed(u.d)); };
/** A length typed in the user's units, or with its own suffix (mm, mil, mils, in, "). */
export function parseLen(s: string): number | null {
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(mm|mils?|in|"|th)?\s*$/i.exec(s); if (!m) return null;
  const v = Number(m[1]); const suf = (m[2] || "").toLowerCase();
  const u = suf ? (suf === "mm" ? "mm" : suf === "in" || suf === '"' ? "in" : "mil") : units();
  return u === "mm" ? v : u === "in" ? v * 25.4 : v * 0.0254;
}
function lenInput(mm: number, id: string): HTMLInputElement { return textInput(toUser(mm), undefined, { id, style: "width:110px" }); }
const lenOf = (i: HTMLInputElement, fallback: number): number => { const v = parseLen(i.value); return v === null ? fallback : +M.fmt(v); };

// ---------------------------------------------------------------- Pin Properties
/** s_alternatesTurndownOpen: the alternates pane stays open for the next dialog once opened. */
let altPaneOpen = false;
/** DIALOG_PIN_PROPERTIES for a new pin (pin = null) or an existing one; resolves with the edited pin, or null. */
export function pinDialog(se: SymbolEditor, p: M.PinInfo, existing: M.Node | null): Promise<M.PinInfo | null> {
  return new Promise((resolve) => {
    const sym = se.symbol()!; const root = se.rootSym(sym);
    const multiUnit = M.unitCount(root) > 1, multiBody = M.bodyStyles(root).count > 1;
    const out: M.PinInfo = { ...p, alternates: p.alternates.map((a) => ({ ...a })) };
    const name = textInput(p.name, undefined, { id: "pin-name" }), number = textInput(p.number, undefined, { id: "pin-number" });
    const px = lenInput(p.x, "pin-x"), py = lenInput(-p.y, "pin-y"), len = lenInput(p.length, "pin-length"), ns = lenInput(p.nameSize, "pin-name-size"), nus = lenInput(p.numSize, "pin-num-size");
    const orient = select(M.PIN_ORIENTATIONS.map(([a, l]) => [String(a), l] as [string, string]), String(p.orient), undefined, { id: "pin-orient" });
    const type = select(M.PIN_TYPES.map(([a, l]) => [a, l] as [string, string]), p.type, undefined, { id: "pin-type" });
    const shape = select(M.PIN_SHAPES.map(([a, l]) => [a, l] as [string, string]), p.shape, undefined, { id: "pin-shape" });
    const allUnits = checkbox("Common to all units in symbol", multiUnit && p.unit === 0, () => { syncMsg(); preview(); }, { disabled: !multiUnit, id: "pin-all-units",
      title: se.synchronizePins() ? "Synchronized pins mode is enabled.\nSimilar pins will be edited regardless of this option." : multiUnit ? "If checked, this pin will exist in all units." : "This symbol only has one unit. This control has no effect." });
    if (!multiUnit) allUnits.title = "This symbol only has one unit. This control has no effect.";
    const allBodies = checkbox("Common to all body styles", p.body === 0, undefined, { disabled: !multiBody, id: "pin-all-bodies" });
    const visible = checkbox("Visible", p.visible, () => preview(), { id: "pin-visible" });
    const cbOf = (l: HTMLLabelElement) => l.querySelector("input") as HTMLInputElement;
    const info = h("div", { class: "kd-infobar", id: "pin-sync-info", style: "display:none;padding:4px 8px;margin-bottom:6px;background:color-mix(in srgb,var(--blue) 14%,var(--panel));border-radius:3px" });
    const syncMsg = () => {
      if (!se.synchronizePins()) return; info.style.display = "flex"; info.innerHTML = "";
      const m = cbOf(allUnits).checked ? "Synchronized Pins Mode." : !existing ? "Synchronized Pins Mode.  New pin will be added to all units." : "Synchronized Pins Mode.  Matching pins in other units will be updated.";
      info.append(h("span", null, m), h("a", { style: "margin-left:auto;color:var(--blue);cursor:pointer", onclick: () => { se.syncPins = false; se.renderToolbars(); info.style.display = "none"; } }, "Exit sync pins mode"));
    };
    const cv = h("canvas", { class: "se-pinprev", id: "pin-preview" }) as HTMLCanvasElement;
    const read = (): M.PinInfo => ({ ...out, name: name.value, number: number.value, x: lenOf(px, p.x), y: -lenOf(py, -p.y), orient: Number(orient.value), type: type.value, shape: shape.value, visible: cbOf(visible).checked,
      nameSize: lenOf(ns, p.nameSize), numSize: lenOf(nus, p.numSize), unit: cbOf(allUnits).checked ? 0 : se.tab!.unit, body: cbOf(allBodies).checked ? 0 : se.tab!.body, length: lenOf(len, p.length) });
    const preview = () => {
      const r = read(); const one = M.node(`(symbol "pin_preview" (symbol "pin_preview_1_1" ${M.text(M.pinNode({ ...r, x: 0, y: 0, unit: 1, body: 1 }))}))`);
      const doc = K().parseLibSymbol(one as unknown as SNode, { showHiddenPins: true, showElectricalTypes: true, fileVersion: se.fileVersion() });
      const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth || 300, H = cv.clientHeight || 160; cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext("2d"); if (!ctx) return; const bb = doc.bbox || [-3, -3, 3, 3];
      const s = Math.min(W / ((bb[2] - bb[0]) * 1.6 || 1), H / ((bb[3] - bb[1]) * 1.6 || 1), 40);
      K().render(doc, ctx, { ppm: 1, zoom: s, panX: W / 2 - (bb[0] + bb[2]) / 2 * s, panY: H / 2 - (bb[1] + bb[3]) / 2 * s, x0: 0, y0: 0, dpr }, { frame: false } as KRenderOpts);
    };
    for (const el of [name, number, px, py, len, ns, nus]) el.addEventListener("input", preview);
    for (const el of [orient, type, shape]) el.addEventListener("change", preview);
    // the alternates (only for a symbol with one body style, as KiCad)
    const alts = out.alternates; let altGrid: { refresh(): void } | null = null;
    KD().open({
      title: "Pin Properties", width: 720,
      build(body) {
        body.append(info); syncMsg();
        // dialog_pin_properties_base.cpp: one grid on the left (name, number, type, style, X, Y, orientation, length,
        // text sizes); on the right the checkboxes (Visible after a gap), "Preview:" and the preview panel
        number.title = "Pin number: 1 to 4 ASCII letters and/or digits"; type.title = "Used by the ERC.";
        const u = unitName(units());
        const left = form([["Pin name:", name, ""], ["Pin number:", number, ""], ["Electrical type:", type, ""], ["Graphic style:", shape, ""], ["X position:", px, u], ["Y position:", py, u],
          ["Orientation:", orient, ""], ["Pin length:", len, u], ["Name text size:", ns, u], ["Number text size:", nus, u]], 3);
        left.id = "pin-left";
        const flags = h("div", { id: "pin-flags", style: "display:flex;flex-direction:column;gap:3px" }, allUnits, allBodies, h("div", { style: "height:10px" }), visible);
        cv.style.flex = "1"; cv.style.minHeight = "160px";
        body.append(h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 10px" }, left,
          h("div", { style: "display:flex;flex-direction:column" }, flags, h("div", { style: "margin-top:8px;color:var(--ink-2)" }, "Preview:"), cv)));
        if (multiBody) {
          // multiple body styles are a superclass of alternate pin assignments
          body.append(h("div", { id: "pin-alt-hint", style: "font-style:italic;margin:8px" }, "  (Alternate pin functions are not available on symbols with multiple body styles.)"));
        } else {
          // WX_COLLAPSIBLE_PANE "Alternate Pin Function Definitions": collapsed when the pin has none and it was not left open
          let open = alts.length > 0 || altPaneOpen;
          const pane = h("div", { id: "pin-alt-pane", style: "margin:6px 10px 0" });
          const tw = h("span", { class: "tw", style: "display:inline-block;width:14px" });
          const head = h("div", { id: "pin-alt-toggle", style: "cursor:pointer;user-select:none;display:flex;align-items:center;gap:2px;margin:8px 10px 0" }, tw, "Alternate Pin Function Definitions");
          const sync = () => { tw.textContent = open ? "▾" : "▸"; pane.style.display = open ? "" : "none"; };
          head.addEventListener("click", () => { open = !open; altPaneOpen = open; sync(); if (open) altGrid && altGrid.refresh(); });
          body.append(head, pane); sync();
          altGrid = KD().grid(pane, [
            { key: "name", label: "Alternate Pin Name", width: 200 },
            { key: "type", label: "Electrical Type", type: "choice", options: M.PIN_TYPES.map(([a, l]) => [a, l] as [string, string]), width: 160 },
            { key: "shape", label: "Graphic Style", type: "choice", options: M.PIN_SHAPES.map(([a, l]) => [a, l] as [string, string]), width: 160 },
          ], alts, { height: 120, buttons: { add: () => ({ name: "", type: type.value, shape: shape.value }), remove: true } });
        }
        requestAnimationFrame(() => { preview(); name.focus(); name.select(); });
      },
      ok() {
        void altGrid;
        if (alts.some((a) => !a.name)) { void messageBox("Alternate pin definitions must have a name."); return false; }
        const r = read();
        const moved = Math.abs(r.x - p.x) > 1e-9 || Math.abs(r.y - p.y) > 1e-9;
        const offGrid = (v: number) => Math.round(v / M.MIL) % 50 !== 0 || Math.abs(v / M.MIL - Math.round(v / M.MIL)) > 1e-6;
        if (moved && (offGrid(r.x) || offGrid(r.y))) {
          void confirmBox("Confirmation", "This pin is not on a 50 mils grid which will make it difficult to connect to in the schematic.\nDo you wish to continue?", "Yes").then((yes) => { if (yes) { KD().close(); resolve(r); } });
          return false;
        }
        resolve(r); return true;
      },
      cancel() { resolve(null); },
    });
  });
}
/** Edit an existing pin (EditPinProperties + SynchronizeOtherUnits). */
export async function editPin(se: SymbolEditor, id: string): Promise<void> {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const n = nodeOf(sym, id); if (!n) return; const ref = M.findRef(sym, n)!;
  const before = M.pinInfo(n, ref.unit, ref.body);
  const res = await pinDialog(se, before, n); if (!res || se.readOnly()) return;
  M.rememberPin(se.lastPin, res);
  se.edit("Edit Pin Properties", (s) => {
    let pin = nodeOf(s, id); if (!pin) return false;
    M.setPin(pin, res); pin = M.relocatePin(s, pin, res.unit, res.body);
    if (se.synchronizePins(s)) M.synchronizeOtherUnits(s, pin, before);
    return [pin];
  });
}

// ---------------------------------------------------------------- fields / texts / shapes
/**
 * A library item's node in the schematic dialogs' terms: internal coordinates (Y down, as the frame's units provider
 * shows them) and, for a library text, its angle in degrees (the file keeps tenths).  schToLib undoes it.
 */
const neg = (v: unknown): number => { const n = Number(v) || 0; return n === 0 ? 0 : -n; };
export function libToSch(n: M.Node, tenths = false): SNode {
  const c = M.clone(n) as unknown as SNode; const a = K().kid(c, "at");
  if (a) { a[2] = neg(a[2]); if (tenths && a.length > 3) a[3] = (Number(a[3]) || 0) / 10; }
  return c;
}
export function schToLib(n: SNode, tenths = false): M.Node {
  const c = M.clone(n as unknown as M.Node); const a = K().kid(c as unknown as SNode, "at");
  if (a) { a[2] = neg(a[2]); if (tenths && a.length > 3) a[3] = Math.round((Number(a[3]) || 0) * 10); }
  return c;
}
const ROW_KEYS: (keyof L.FieldRow)[] = ["name", "value", "show", "showName", "h", "v", "italic", "bold", "size", "orient", "x", "y", "font", "color", "autoplace"];
const sameRow = (a: L.FieldRow, b: L.FieldRow): boolean => ROW_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
/** The schematic dialogs' context for the Symbol Editor: its canvas document (font faces), read-only state, no commit. */
const dlgCtx = (se: SymbolEditor) => ({ doc: se.kdoc(), viewOnly: se.readOnly(), commit() { /* the editor commits (se.edit) */ } }) as unknown as Parameters<typeof openTextDialog>[0];
/** SYMBOL_EDITOR_EDIT_TOOL::editFieldProperties: DIALOG_FIELD_PROPERTIES on a library field. */
export async function editField(se: SymbolEditor, id: string): Promise<void> {
  const sym = se.symbol(); if (!sym) return; const f = nodeOf(sym, id); if (!f) return;
  const name = L.fieldName(f as unknown as SNode);
  const item = { id: "lib", kind: "lib_symbol", node: ["lib_symbol", libToSch(f)] } as unknown as KItem;
  openFieldDialog(dlgCtx(se) as never, item, name, (np) => {
    if (se.readOnly()) return;
    const label = M.MANDATORY_FIELDS.includes(name) ? `Edit ${name} Field` : `Edit '${name}' Field`;
    se.edit(label, (s) => {
      const g = M.fieldOf(s, name); if (!g) return false;
      const next = schToLib(np); if (M.text(next) === M.text(g)) return false;
      g.splice(0, g.length, ...next); return [g];
    });
  });
}
/** A library text / text box: "private" moves out of the node for the dialog, which edits (text "…" …). */
function textForDialog(n: M.Node): { node: SNode; priv: boolean } {
  const priv = n[1] === "private" && n.length > 2 && !Array.isArray(n[2]);
  const c = M.clone(n); if (priv) c.splice(1, 1);
  return { node: libToSch(c, c[0] === "text"), priv };
}
function textFromDialog(n: SNode, priv: boolean): M.Node {
  const c = schToLib(n, n[0] === "text"); if (priv) c.splice(1, 0, "private"); return c;
}
function textDialogFor(se: SymbolEditor, n: M.Node, unit: number, body: number, title: string | undefined, apply: (node: M.Node, o: { allUnits: boolean; allBodies: boolean }) => void, cancel?: () => void): void {
  const sym = se.symbol()!; const root = se.rootSym(sym);
  const { node, priv } = textForDialog(n);
  const item = { id: "lib-text", kind: String(node[0]), node } as unknown as KItem;
  openTextDialog(dlgCtx(se) as never, item, { title, cancel, symbolEditor: {
    private: priv, multiUnit: M.unitCount(root) > 1, allUnits: unit === 0, multiBody: M.bodyStyles(root).count > 1, allBodies: body === 0,
    apply: (out, o) => apply(textFromDialog(out, o.private), o),
  } });
}
/** SYMBOL_EDITOR_DRAWING_TOOLS::TwoClickPlace for text: DIALOG_TEXT_PROPERTIES, then the text follows the cursor. */
export async function newText(se: SymbolEditor, x: number, y: number): Promise<void> {
  const t = se.tab; if (!t) return;
  const n = M.textNode("", x, y, M.DEFAULTS.textSize, se.lastTextAngle);
  // GetDrawSpecificUnit() is off and GetDrawSpecificBodyStyle() on: all units, this body style
  textDialogFor(se, n, 0, t.body, "Text Properties", (out, o) => {
    if (!L.str(out[1] === "private" ? out[2] : out[1]).trim()) return;   // NoPrintableChars: nothing is placed
    const a = K().kid(out as unknown as SNode, "at"); se.lastTextAngle = a ? (Number(a[3]) || 0) / 10 : 0;
    se.startFloating({ kind: "text", node: out, body: o.allBodies ? 0 : t.body, unit: o.allUnits ? 0 : t.unit });
  });
}
export async function newTextBox(se: SymbolEditor, a: number[], b: number[]): Promise<void> {
  const t = se.tab; if (!t) return;
  const x0 = Math.min(a[0], b[0]), yTop = Math.max(a[1], b[1]);
  const n = M.textBoxNode("", x0, yTop, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), M.DEFAULTS.textSize);
  textDialogFor(se, n, 0, t.body, "Text Box Properties", (out, o) => {
    se.edit("Draw Text Box", (s) => { M.addDrawItem(s, o.allUnits ? 0 : t.unit, o.allBodies ? 0 : t.body, out); return [out]; });
  });
}
/** SYMBOL_EDITOR_EDIT_TOOL::editTextProperties / editTextBoxProperties. */
export async function editText(se: SymbolEditor, id: string): Promise<void> {
  const sym = se.symbol(); if (!sym) return; const n = nodeOf(sym, id); if (!n) return; const t = se.tab!;
  const ref = M.findRef(sym, n)!; const isText = n[0] === "text";
  textDialogFor(se, n, ref.unit, ref.body, undefined, (out, o) => {
    if (se.readOnly()) return;
    se.edit(isText ? "Edit Text" : "Edit Text Box", (s) => {
      const m = nodeOf(s, id); if (!m) return false;
      const changed = M.text(out) !== M.text(m); m.splice(0, m.length, ...out);
      const r2 = M.findRef(s, m)!; const u = o.allUnits ? 0 : t.unit, b = o.allBodies ? 0 : t.body;
      if (r2.unit !== u || r2.body !== b) { M.removeDrawItem(s, r2); M.addDrawItem(s, u, b, m); }
      else if (!changed) return false;
      return [m];
    });
  });
}
const setBool = M.setBool, setHide = M.setHide;
export const isHidden = M.isHidden;
/**
 * DIALOG_SHAPE_PROPERTIES in the Symbol Editor: Border (Width, Color, Style), the "Fill Style" box (Do not fill / Fill
 * with body outline color / Fill with body background color / Fill with: <color>), Private to Symbol Editor, and Common
 * to all units / body styles (enabled only for a multi-unit / multi-body-style symbol).
 */
export function editShape(se: SymbolEditor, id: string): void {
  const sym = se.symbol(); if (!sym) return; const n = nodeOf(sym, id); if (!n) return;
  const root = se.rootSym(sym); const multiUnit = M.unitCount(root) > 1, multiBody = M.bodyStyles(root).count > 1;
  const sn = n as unknown as SNode;
  const st = L.readStroke(sn); const fl = K().kid(sn, "fill"); const ft = fl ? K().kid(fl, "type") : null; const fmode = ft ? K().str(ft[1]) : "none";
  const fcol = L.readFill(sn).color;
  const ref = M.findRef(sym, n)!;
  const ro = se.readOnly();
  const width = lenInput(Math.max(0, st.width), "shape-width");
  const style = select(L.LINE_STYLES.map(([v, l]) => [v, l] as [string, string]), st.style, undefined, { id: "shape-style" });
  // the fill swatch follows the radios (TransferDataToWindow / onFillRadioButton / onBorderSwatch): the border colour or
  // LAYER_DEVICE for an outline fill, LAYER_DEVICE_BACKGROUND for a background fill, unspecified for no fill
  const layer = (k: "outline" | "body"): L.Color => L.hexToColor(K().SCH[k] || (k === "outline" ? "#840000" : "#FFFFC2"));
  const fillRadio = (v: string) => document.getElementById("shape-fill-" + v) as HTMLInputElement | null;
  const bc = swatch(st.color, "shape-bcolor", (c) => { if (fillRadio("outline")?.checked) fc.set(c || layer("outline")); }, ro);
  const cbIn = (l: HTMLLabelElement) => l.querySelector("input") as HTMLInputElement;
  const enableBorder = (on: boolean) => { width.disabled = !on; style.disabled = !on; bc.enable(on && !ro); };
  const border = checkbox("Border", st.width >= 0, (on) => { enableBorder(on); if (on && !(parseLen(width.value) ?? 0)) width.value = toUser(0); }, { id: "shape-border" });
  // the fill radios (FILL_T: NO_FILL / FILLED_SHAPE / FILLED_WITH_BG_BODYCOLOR / FILLED_WITH_COLOR)
  const cur = fmode === "outline" ? "outline" : fmode === "background" ? "background" : fmode === "color" ? "color" : "none";
  const radio = (v: string, label: string, extra?: Node) => {
    const i = h("input", { type: "radio", name: "shape-fill", value: v, id: "shape-fill-" + v, style: "width:auto;margin:0" }) as HTMLInputElement; i.checked = cur === v; i.disabled = ro;
    i.addEventListener("change", () => { if (!i.checked) return; if (v === "none") fc.set(null); else if (v === "outline") fc.set(bc.get() || layer("outline")); else if (v === "background") fc.set(layer("body")); else fc.pick(); });
    return h("label", { style: "display:flex;gap:6px;align-items:center" }, i, label, ...(extra ? [extra] : []));
  };
  const fc = swatch(cur === "color" ? fcol : cur === "outline" ? st.color || layer("outline") : cur === "background" ? layer("body") : null, "shape-fcolor", () => { (document.getElementById("shape-fill-color") as HTMLInputElement).checked = true; }, ro);
  const priv = checkbox("Private to Symbol Editor", n[1] === "private", undefined, { id: "shape-private" });
  const allUnits = checkbox("Common to all units in symbol", multiUnit && ref.unit === 0, undefined, { id: "shape-all-units", disabled: !multiUnit });
  const allBodies = checkbox("Common to all body styles", multiBody && ref.body === 0, undefined, { id: "shape-all-bodies", disabled: !multiBody });
  KD().open({
    title: `${kindLabel(String(n[0]))} Properties`, width: 440, readOnly: ro,
    build(body) {
      const u = unitName(units());
      body.append(border, form([["Width:", width, u], ["Color:", bc.el, ""], ["Style:", style, ""]], 3),
        h("div", { style: "font-size:11px;color:var(--ink-3);margin:4px 0 8px" }, "Set border width to 0 to use schematic's default line width."));
      const box = KD().staticBox(body, "Fill Style");
      box.append(h("div", { style: "display:flex;flex-direction:column;gap:4px" }, radio("none", "Do not fill"), radio("outline", "Fill with body outline color"), radio("background", "Fill with body background color"),
        radio("color", "Fill with:", h("span", { style: "margin-left:6px" }, fc.el))));
      body.append(h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:10px" }, priv, h("div", { style: "height:6px" }), allUnits, allBodies));
      enableBorder(st.width >= 0);
    },
    ok() {
      const t = se.tab!;
      const on = cbIn(border).checked;
      const mode = (document.querySelector('input[name="shape-fill"]:checked') as HTMLInputElement | null)?.value || "none";
      se.edit("Edit Shape Properties", (s) => {
        const m = nodeOf(s, id); if (!m) return false;
        const ms = m as unknown as SNode; const was = M.text(m);
        // only what the dialog changed is rewritten, so an untouched shape keeps its text
        const wNew = on ? Math.max(0, lenOf(width, 0)) : -1;
        if (wNew !== st.width) { if (wNew >= 0) L.writeStroke(ms, { width: wNew }); else { L.writeStroke(ms, {}); const sk = K().kid(ms, "stroke"); const wd = sk && K().kid(sk, "width"); if (wd) wd[1] = -1 as unknown as SNode; } }
        if (style.value !== st.style) L.writeStroke(ms, { style: style.value });
        if (JSON.stringify(bc.get()) !== JSON.stringify(st.color)) L.writeStroke(ms, { color: bc.get() });
        // the library writer keeps a fill colour only for FILLED_WITH_COLOR
        if (mode === "color") { if (cur !== "color" || JSON.stringify(fc.get()) !== JSON.stringify(fcol)) L.writeFill(ms, "solid", fc.get()); }
        else if (mode !== cur) L.put(ms, "fill", [["type", mode]], ["effects", "uuid"]);
        const isPriv = m[1] === "private"; const want = cbIn(priv).checked;
        if (want !== isPriv) { if (want) m.splice(1, 0, "private"); else m.splice(1, 1); }
        const r2 = M.findRef(s, m)!;
        // a disabled box (one unit / one body style) leaves the item where it is
        const uu = !multiUnit ? r2.unit : cbIn(allUnits).checked ? 0 : t.unit, bb = !multiBody ? r2.body : cbIn(allBodies).checked ? 0 : t.body;
        if (r2.unit !== uu || r2.body !== bb) { M.removeDrawItem(s, r2); M.addDrawItem(s, uu, bb, m); }
        else if (M.text(m) === was) return false;
        return [m];
      });
    },
  });
}

// ---------------------------------------------------------------- Footprint Filters page
/** PANEL_FOOTPRINT_FILTERS: the filter list with Add / Edit / Delete, and the footprints the filters match. */
function fpFiltersPage(pg: HTMLElement, get: () => string[], set: (f: string[]) => void, ro: boolean, inheritedFrom: string): void {
  const sel = new Set<number>(); let anchor = -1;
  const list = h("div", { id: "sp-fpfilters", class: "kd-listbox", tabindex: "0", style: "flex:1;min-height:220px;overflow:auto;border:1px solid var(--line);background:var(--paper);padding:2px 0" });
  if (inheritedFrom) list.title = `These filters are inherited from '${inheritedFrom}'.`;
  const label = h("div", { id: "sp-fpmatch-label", style: "margin-bottom:4px" }, "Matching footprints:");
  const matches = h("div", { id: "sp-fpmatches", style: "flex:1;min-height:220px;overflow:auto;border:1px solid var(--line);background:var(--paper);padding:2px 0" });
  const changed = (f: string[]) => { set(f.map(FF.sanitizeFpFilter)); list.removeAttribute("title"); draw(); update(); };
  const draw = () => {
    list.replaceChildren();
    get().forEach((f, i) => {
      const row = h("div", { class: "kd-lbrow" + (sel.has(i) ? " sel" : ""), "data-i": String(i), style: "padding:1px 6px;cursor:default;white-space:nowrap" + (sel.has(i) ? ";background:var(--sel)" : "") }, f);
      row.addEventListener("click", (ev) => {
        if (ev.shiftKey && anchor >= 0) { sel.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k); }
        else if (ev.ctrlKey || ev.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); anchor = i; }
        else { sel.clear(); sel.add(i); anchor = i; }
        draw(); update();
      });
      row.addEventListener("dblclick", (ev) => { ev.stopPropagation(); sel.clear(); sel.add(i); void edit(); });
      list.append(row);
    });
  };
  // OnFpFilterDClick: a double-click on empty space adds a filter
  list.addEventListener("dblclick", () => { void add(); });
  list.addEventListener("click", (ev) => { if (ev.target === list) { sel.clear(); draw(); update(); } });
  const add = async () => {
    if (ro) return; const v = await promptText("Add Footprint Filter", "Filter:", "");
    if (v === null || !v) { update(); return; }
    const f = get().concat([FF.sanitizeFpFilter(v)]); sel.clear(); sel.add(f.length - 1); changed(f);
  };
  const edit = async () => {
    if (ro || !sel.size) return; const i = Math.min(...sel); const v = await promptText("Edit Footprint Filter", "Filter:", get()[i]);
    if (v !== null && v) { const f = get().slice(); f[i] = FF.sanitizeFpFilter(v); changed(f); } else update();
  };
  const del = () => { if (ro || !sel.size) return; const f = get().filter((_x, i) => !sel.has(i)); sel.clear(); changed(f); };
  let token = 0;
  const update = () => {
    const filters = get(); const pats = sel.size ? filters.filter((_x, i) => sel.has(i)) : filters; const my = ++token;
    const show = () => {
      if (my !== token) return;
      const idx = FF.footprintIndex();
      if (pats.length && !idx) { label.textContent = "Matching footprints:"; matches.replaceChildren(h("div", { style: "padding:1px 6px;color:var(--ink-3)" }, `Loading footprint libraries (${Math.floor(FF.footprintIndexProgress() * 100)}%)...`)); setTimeout(show, 250); return; }
      const r = FF.matchFootprints(pats, idx || []);
      label.textContent = `Matching footprints (${r.names.length}${r.limited ? "+" : ""}):`;
      matches.replaceChildren(...r.names.map((n) => h("div", { class: "kd-lbrow", style: "padding:1px 6px;white-space:nowrap" }, n)));
    };
    if (pats.length) void FF.loadFootprintIndex();
    show();
  };
  const btn = (txt: string, title: string, fn: () => void, id: string) => { const b = h("button", { type: "button", class: "btn", title, id, disabled: ro }, txt); b.addEventListener("click", fn); return b; };
  const bar = h("div", { style: "display:flex;gap:5px;margin-top:5px" }, btn("+", "Add footprint filter", () => void add(), "sp-fpf-add"), btn("✎", "Edit footprint filter", () => void edit(), "sp-fpf-edit"), h("span", { style: "width:20px" }), btn("🗑", "Delete footprint filter", del, "sp-fpf-del"));
  pg.append(h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:14px;height:100%" },
    h("div", { style: "display:flex;flex-direction:column" }, h("div", { style: "margin-bottom:4px" }, "Footprint filters:"), list, bar),
    h("div", { style: "display:flex;flex-direction:column" }, label, matches)));
  draw(); update();
}

// ---------------------------------------------------------------- Symbol Properties
export function symbolProperties(se: SymbolEditor, opts: { pinMaps?: boolean } = {}): void {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const pinMaps = pinMapState(sym, M.flatten(se.libMap(se.libs.get(t.lib) || null), sym));
  const derived = M.isDerived(sym); const root = se.rootSym(sym);
  const hd = M.symHeader(root);
  // FIELDS_GRID_TABLE over the library fields, in internal coordinates (Y down) as the frame's units provider shows them
  const fieldSrc = new Map<SNode, M.Node>();
  const rows: L.FieldRow[] = K().kids(sym as unknown as SNode, "property").filter((p) => !K().str(p[1]).startsWith("ki_")).map((p) => {
    const flipped = libToSch(p as unknown as M.Node); fieldSrc.set(flipped, p as unknown as M.Node);
    return L.rowFromField(flipped, [0, 0], M.MANDATORY_FIELDS.includes(K().str(p[1])));
  });
  let fgrid: { rows(): L.FieldRow[]; setRows(r: L.FieldRow[]): void } | null = null;
  const curRows = (): L.FieldRow[] => (fgrid ? fgrid.rows() : rows);
  const name = textInput(M.unescapeLibId(M.symName(sym)), undefined, { id: "sp-name" });
  const keywords = textInput(M.fieldValue(sym, "ki_keywords"), undefined, { id: "sp-keywords" });
  // footprint filters: a derived symbol with none of its own shows the nearest ancestor's (ancestorDefining) and saves
  // nothing while they stay the inherited ones
  const splitF = (v: string) => v.split(/\s+/).filter(Boolean);
  let fpFilters = splitF(M.fieldValue(sym, "ki_fp_filters")); let inheritedFrom = ""; let inheritedFilters: string[] | null = null;
  if (!fpFilters.length && derived) {
    const lm = se.libMap(se.libs.get(t.lib) || null); let cur: M.Node | null = sym; const seen = new Set<string>();
    while (cur && M.parentNameOf(cur) && lm) { const pn: string = M.parentNameOf(cur)!; if (seen.has(pn)) break; seen.add(pn); cur = lm.symbols.get(pn) || null; const f = cur ? splitF(M.fieldValue(cur, "ki_fp_filters")) : []; if (f.length) { fpFilters = f; inheritedFilters = f.slice(); inheritedFrom = M.unescapeLibId(pn); break; } }
  }
  const unitsIn = textInput(String(M.unitCount(root)), undefined, { id: "sp-units", type: "number", min: "1", max: "64", style: "width:70px" });
  const interchange = checkbox("All units are interchangeable", !M.unitsLocked(root), undefined, { id: "sp-interchangeable" });
  const bs = M.bodyStyles(root);
  // Units & Body Styles: the unit names grid follows the unit count; body styles are single, De Morgan or custom names
  const unitRows: { letter: string; name: string }[] = [];
  const uNames = M.unitNames(root);
  const syncUnitRows = () => { const n = Math.max(1, Math.min(64, Math.round(Number(unitsIn.value) || 1))); while (unitRows.length > n) unitRows.pop(); while (unitRows.length < n) { const u = unitRows.length + 1; unitRows.push({ letter: M.unitLetter(u), name: uNames.get(u) || "" }); } unitGrid && unitGrid.refresh(); };
  let unitGrid: { refresh(): void } | null = null;
  let mode: M.BodyMode = M.bodyMode(root);
  const bodyRows: { name: string }[] = mode === "custom" ? bs.names.map((name) => ({ name })) : [];
  let bodyGridHost: HTMLElement | null = null; let bodyGrid: { refresh(): void } | null = null;
  const radio = (v: M.BodyMode, label: string) => { const i = h("input", { type: "radio", name: "sp-bodystyle", value: v, id: "sp-bs-" + v, style: "width:auto;margin:0" }) as HTMLInputElement; i.checked = mode === v; i.disabled = derived;
    i.addEventListener("change", () => { if (!i.checked) return;
      if (v !== "single") { const alts = M.allPins(root).filter((d) => M.pinInfo(d.node).alternates.length).map((d) => M.pinInfo(d.node).number); if (alts.length) { void messageBox(`Multiple body styles are not supported on symbols with alternate pin functions.\n\n(Pins ${M.pinNumberSummary(alts.map((number) => ({ number }) as M.PinRow)).numbers}.)`); (document.getElementById("sp-bs-single") as HTMLInputElement).checked = true; mode = "single"; syncBody(); return; } }
      mode = v; syncBody(); });
    return h("label", { style: "display:flex;gap:6px;align-items:center" }, i, label); };
  const syncBody = () => { if (bodyGridHost) { bodyGridHost.style.opacity = mode === "custom" ? "1" : ".5"; bodyGridHost.style.pointerEvents = mode === "custom" ? "" : "none"; } };
  const jumperRows: { group: string }[] = M.jumperGroups(root).map((g) => ({ group: g.join(", ") }));
  const power = checkbox("Define as power symbol", !!hd.power, undefined, { id: "sp-power" }), local = checkbox("Define as local power symbol", hd.power === "local", undefined, { id: "sp-local" });
  const exSim = checkbox("Exclude from simulation", hd.excludeFromSim, undefined, { id: "sp-exsim" }), exBom = checkbox("Exclude from bill of materials", !hd.inBom, undefined, { id: "sp-exbom" }), exBoard = checkbox("Exclude from board", !hd.onBoard, undefined, { id: "sp-exboard" }), exPos = checkbox("Exclude from position files", !hd.inPosFiles, undefined, { id: "sp-expos" });
  const showNum = checkbox("Show pin number", hd.showPinNumbers, undefined, { id: "sp-pinnum" }), showName = checkbox("Show pin name", hd.showPinNames, undefined, { id: "sp-pinname" }), inside = checkbox("Place pin names inside", hd.pinNameOffset > 0, undefined, { id: "sp-inside" });
  const offset = lenInput(hd.pinNameOffset || M.DEFAULT_PIN_NAME_OFFSET, "sp-offset");
  const jumpers = checkbox("All pins with duplicate numbers are jumpers", hd.jumpers, undefined, { id: "sp-jumpers" });
  const cb = (l: HTMLLabelElement) => (l.querySelector("input") as HTMLInputElement).checked;
  const ro = se.readOnly();
  // m_inheritanceSelectCombo: a derived symbol picks its parent among the library's symbols (not itself or its descendants); a root symbol shows "<None>" greyed (syncControlStates)
  const parentName = M.parentNameOf(sym) || "";
  const parentOpts = derived ? M.parentChoices(se.libMap(se.libs.get(t.lib) || null), M.symName(sym)) : [];
  if (parentName && !parentOpts.includes(parentName)) parentOpts.unshift(parentName);
  const inherit = derived ? select(parentOpts.map((n) => [n, M.unescapeLibId(n)] as [string, string]), parentName, undefined, { id: "sp-parent", disabled: ro })
    : select([["", "<None>"]], "", undefined, { id: "sp-parent", disabled: true });
  let confirmed = false; let api: { finish(apply: boolean): void } | null = null;
  KD().open({
    title: `Library Symbol Properties`, width: 1000, readOnly: ro,
    build(body, a) {
      api = a;
      KD().notebook(body, [
        { label: "General", build(pg) {
          const box = KD().staticBox(pg, "Fields");
          // dialog_lib_symbol_properties_base.cpp: Name … Font (the table's Color and Allow Autoplacement columns hidden), Add / Move up / Move down / Delete
          fgrid = fieldsGrid(box, rows, { readOnly: ro, doc: se.kdoc(), height: 190, shown: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            newName: (rs) => { let n = 1; const names = new Set(rs.map((r) => r.name)); while (names.has("Field" + n)) n++; return "Field" + n; } });
          pg.append(form([["Symbol name:", name], ["Keywords:", keywords], ["Derive from symbol:", inherit]]));
          // bSizerLowerBasicPanel: the General box (power, local power indented), Pin Text Options, then Attributes
          // (simulation, a gap, board, bill of materials, position files)
          if (!derived) {
            const row = h("div", { id: "sp-lower", style: "display:grid;grid-template-columns:1fr 1.2fr 1.2fr;gap:12px;margin-top:8px" }); pg.append(row);
            const col = () => { const c = h("div"); row.append(c); return c; };
            local.style.marginLeft = "20px";
            KD().staticBox(col(), "General").append(h("div", { style: "display:flex;flex-direction:column;gap:3px" }, power, local));
            KD().staticBox(col(), "Pin Text Options").append(h("div", { style: "display:flex;flex-direction:column;gap:3px" }, showNum, showName, h("div", { style: "height:8px" }), inside, form([["Position offset:", offset, unitName(units())]], 3)));
            KD().staticBox(col(), "Attributes").append(h("div", { style: "display:flex;flex-direction:column;gap:3px" }, exSim, h("div", { style: "height:8px" }), exBoard, exBom, exPos));
          }
        } },
        ...(derived ? [] : [{ label: "Units & Body Styles", build(pg: HTMLElement) {
          const ub = KD().staticBox(pg, "Symbol Units");
          ub.append(form([["Number of units:", unitsIn]]), h("div", { style: "margin:4px 0" }, interchange), h("div", { style: "margin-top:4px" }, "Unit display names (optional):"));
          unitsIn.addEventListener("input", syncUnitRows); syncUnitRows();
          const ugHost = h("div", { id: "sp-unitnames" }); ub.append(ugHost);
          unitGrid = KD().grid(ugHost, [{ key: "letter", label: "", type: "ro", width: 36 }, { key: "name", label: "", width: 300 }], unitRows, { readOnly: ro, height: 130 });
          const bb = KD().staticBox(pg, "Body Styles");
          bb.append(radio("single", "Single body style"), radio("demorgan", "‘Standard’ and ‘Alternate’ De Morgan body styles"), radio("custom", "Custom body styles:"));
          bodyGridHost = h("div", { id: "sp-bodynames", style: "margin-left:22px" }); bb.append(bodyGridHost);
          bodyGrid = KD().grid(bodyGridHost, [{ key: "name", label: "", width: 320 }], bodyRows, { readOnly: ro, height: 100, buttons: { add: () => ({ name: "" }), addTitle: "Add field", remove: true, removeTitle: "Delete field", move: true } });
          syncBody();
        } }]),
        { label: "Footprint Filters", build(pg: HTMLElement) { fpFiltersPage(pg, () => fpFilters, (f) => { fpFilters = f; inheritedFrom = ""; }, ro, inheritedFrom); } },
        ...(derived ? [] : [{ label: "Pin Connections", build(pg: HTMLElement) {
          const jgHost = h("div", { id: "sp-jumpergroups" });
          pg.append(jumpers, h("div", { style: "margin-top:8px" }, "Explicit jumper pin groups:"), jgHost);
          KD().grid(jgHost, [{ key: "group", label: "", width: 420 }], jumperRows, { readOnly: ro, height: 150, buttons: { add: () => ({ group: "" }), remove: true } });
        } }]),
        { label: "Pin Map", build(pg) { pinMapPage(pg, pinMaps, ro); } },
      ], { selected: opts.pinMaps ? (derived ? 2 : 4) : 0 });
      // DIALOG_LIB_SYMBOL_PROPERTIES::OnEditSpiceModel: the "Edit Simulation Model..." button at the left of the bottom bar
      const simBtn = h("button", { type: "button", class: "btn", id: "sp-sim", disabled: ro, style: "margin-right:auto" }, "Edit Simulation Model...") as HTMLButtonElement;
      simBtn.addEventListener("click", () => {
        const flat = M.flatten(se.libMap(se.libs.get(t.lib) || null), sym);
        openSimModel<L.FieldRow>(curRows(), {
          prefix: refPrefix(M.fieldValue(sym, "Reference")), pins: simPinsOfLib(flat as unknown as SNode), unitCount: M.unitCount(root), readOnly: ro,
          files: [...projectModelFiles((appState.project && appState.project.docs) || []), ...embeddedModelFiles([sym, root === sym ? null : root])],
          newRow: (n, v, vis) => Object.assign(L.newRow(n, [0, 0]), { value: v, show: vis }),
          clone: (r) => ({ ...r }),
        }, (next) => { if (fgrid) fgrid.setRows(next); });
      });
      a.foot.insertBefore(simBtn, a.foot.firstChild);
    },
    ok() {
      const newName = M.escapeLibId(name.value.trim());   // EscapeString( m_SymbolNameCtrl->GetValue(), CTX_LIBID )
      if (!newName) { void messageBox("Symbol must have a name."); return false; }
      const lib = se.libs.get(t.lib);
      const oldName = M.symName(sym);
      if (newName !== oldName && !t.origin && lib && lib.doc && lib.doc.lib.symbols.has(newName)) { void messageBox(`Symbol name '${M.unescapeLibId(newName)}' already in use in library '${lib.nick}'.`); return false; }
      const nu = Math.max(1, Math.min(64, Math.round(Number(unitsIn.value) || 1)));
      void bodyGrid;
      const finalRows = curRows();
      const dup = L.duplicateFieldName(finalRows); if (dup) { void messageBox(dup); return false; }
      if (derived && !inherit.value) { void messageBox("Derived symbol must have a parent selected"); return false; }
      if (!derived) {
        // DIALOG_LIB_SYMBOL_PROPERTIES::Validate
        const seen = new Set<string>();
        for (let r = 0; r < unitRows.length && r < nu; r++) { const sub = unitRows[r].name || M.unitLetter(r + 1); if (seen.has(sub.toUpperCase())) { void messageBox(`The unit name '${sub}' is already in use.`); return false; } seen.add(sub.toUpperCase()); }
        const names = bodyRows.map((r) => r.name).filter(Boolean);
        if (mode === "custom" && names.length < 2) { void messageBox("Custom body styles must have at least 2 entries"); return false; }
        const jg = M.parseJumperGroups(jumperRows.map((r) => r.group), (n) => M.hasPinNumber(root, n));
        if ("error" in jg) { void messageBox(jg.error); return false; }
        const newBodies = mode === "single" ? 1 : mode === "demorgan" ? 2 : names.length;
        const asks: string[] = [];
        if (nu < M.unitCount(root)) asks.push("Delete extra units from symbol?");
        if (newBodies < bs.count) asks.push("Delete extra body styles from symbol?");
        if (asks.length && !confirmed) {
          void (async () => { for (const q of asks) if (!(await confirmBox("Confirmation", q, "OK"))) return; confirmed = true; api && api.finish(true); })();
          return false;
        }
      }
      const apply = (s: M.Node) => {
        // fields: the grid's order, existing nodes keep their effects
        const keepMeta = (s.filter((c, j) => j > 0 && Array.isArray(c) && c[0] === "property" && String(c[1]).startsWith("ki_")) as M.Node[]);
        let at = s.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "property"); if (at < 0) at = s.findIndex((c, j) => j > 1 && Array.isArray(c) && c[0] === "symbol"); if (at < 0) at = s.length;
        for (let j = s.length - 1; j >= 1; j--) if (Array.isArray(s[j]) && (s[j] as M.Node)[0] === "property") { s.splice(j, 1); if (j < at) at--; }
        const fresh: M.Node[] = finalRows.map((r) => {
          const orig = r.src ? fieldSrc.get(r.src) : null;
          // an untouched row keeps its node as it is in the file
          if (orig && r.src && sameRow(L.rowFromField(r.src, [0, 0], r.mandatory), r)) return M.clone(orig);
          if (!r.src) { const n = M.fieldNode(r.name, r.value, r.x, -r.y, !r.show); return schToLib(L.fieldFromRow(Object.assign({}, r, { src: libToSch(n) }), [0, 0])); }
          return schToLib(L.fieldFromRow(r, [0, 0]));
        });
        s.splice(at, 0, ...fresh, ...keepMeta);
        M.setMetaField(s, "ki_keywords", keywords.value.trim());
        { const own = inheritedFilters && fpFilters.join(" ") === inheritedFilters.join(" ") ? [] : fpFilters; if (own.join(" ") !== splitF(M.fieldValue(s, "ki_fp_filters")).join(" ")) M.setMetaField(s, "ki_fp_filters", own.join(" ")); }
        // PANEL_SYMBOL_PIN_MAP::ApplyToSymbol (only when the page was edited, so an untouched symbol keeps its text)
        if (pinMaps.dirty) M.setPinMapData(s, harvestPinMaps(pinMaps), pinMaps.assocs);
        if (derived && inherit.value && inherit.value !== parentName) M.setParentName(s, inherit.value);
        if (!derived) {
          const pw = cb(power) ? (cb(local) ? "local" : "global") : "";
          M.setSymHeader(s, { power: pw as M.SymHeader["power"], showPinNumbers: cb(showNum), showPinNames: cb(showName), pinNameOffset: cb(inside) ? lenOf(offset, M.DEFAULT_PIN_NAME_OFFSET) || 0.0001 : 0,
            excludeFromSim: cb(exSim), inBom: !cb(exBom), onBoard: !cb(exBoard), inPosFiles: !cb(exPos), jumpers: cb(jumpers) });
          if (nu !== M.unitCount(s)) M.setUnitCount(s, nu);
          M.setBodyStyles(s, mode, bodyRows.map((r) => r.name).filter(Boolean));
          const un = new Map<number, string>(); unitRows.forEach((r, i) => { if (r.name && i < nu) un.set(i + 1, r.name); }); M.setUnitNames(s, un);
          const jg = M.parseJumperGroups(jumperRows.map((r) => r.group), (n) => M.hasPinNumber(s, n)); if (!("error" in jg)) M.setJumperGroups(s, jg.groups);
          const locked = !cb(interchange) && nu > 1;
          if (locked !== M.unitsLocked(s)) { if (locked) M.setMetaField(s, "ki_locked", " "); else { const l = M.fieldOf(s, "ki_locked"); if (l) s.splice(s.indexOf(l), 1); } const l2 = M.fieldOf(s, "ki_locked"); if (l2) l2[2] = ""; }
        }
      };
      if (newName !== oldName && !t.origin && lib && lib.doc) {
        // a rename is one op: the old symbol removed, the renamed one and its derived symbols rewritten
        const tmp: M.SymLib = { head: [] as unknown as M.SymLib["head"], version: 0, symbols: new Map([...lib.doc.lib.symbols].map(([k, v]) => [k, M.node(M.text(v))])) };
        const s = tmp.symbols.get(oldName)!; apply(s);
        const touched = M.renameSymbol(tmp, oldName, newName);
        const undoText = M.text(sym), afterText = M.text(tmp.symbols.get(newName)!);
        void lib.doc.commit([[oldName, null], ...touched.filter((n) => n !== oldName).map((n): [string, string] => [n, M.text(tmp.symbols.get(n)!)])]).then(() => { t.name = newName; t.undo.push({ label: "Edit Symbol Properties", before: undoText, after: afterText }); lib.rows = null; se.renderAll(); });
        t.name = newName; return true;
      }
      se.edit("Edit Symbol Properties", (s) => { apply(s); if (t.origin && newName !== oldName) { s[1] = newName; } });
      return true;
    },
  });
}

// ---------------------------------------------------------------- New Symbol / Save As / Rename / New Library
/**
 * SYMBOL_EDIT_FRAME::CreateNewSymbol: DIALOG_LIB_NEW_SYMBOL for the target library (getTargetLib: the tree's library,
 * else the current symbol's).  With no target library the symbol opens in an unsaved tab and its first save asks for
 * a library (CreateUnsavedSymbolTab).
 */
/** DIALOG_LIB_NEW_SYMBOL; `parentName`: Derive from Existing Symbol (CreateNewSymbol( aInheritFrom )) presets the parent. */
export function newSymbol(se: SymbolEditor, parentName?: string): void {
  if (E.viewOnly) { void messageBox("You have view-only access to this project."); return; }
  const cand = se.currentLib();
  const target = cand && cand.kind === "project" && cand.doc && cand.doc.canEdit ? cand : null;
  const p = M.defaultNewSymbolProps();
  const name = textInput("", undefined, { id: "ns-name" }); name.title = "The symbol name in library and also the default\nsymbol value when loaded in the schematic.";
  const parents = () => (target && target.doc ? [...target.doc.lib.symbols.keys()].sort(M.numCompare) : []);
  const parent = select([["", ""], ...parents().map((n) => [n, M.unescapeLibId(n)] as [string, string])], "", undefined, { id: "ns-parent" });
  const ref = textInput("U", undefined, { id: "ns-ref" }); const unitsIn = textInput("1", undefined, { id: "ns-units", type: "number", min: "1", max: "64", style: "width:70px" });
  const inter = checkbox("All units are interchangeable", false, undefined, { id: "ns-inter" }); inter.title = "Check this option when all symbol units are identical except\nfor pin numbers.";
  const demorgan = checkbox("Create symbol with alternate body style (De Morgan)", false, undefined, { id: "ns-demorgan" });
  const power = checkbox("Create symbol as power symbol", false, undefined, { id: "ns-power" });
  const exBom = checkbox("Exclude from bill of materials", false, undefined, { id: "ns-exbom" }), exBoard = checkbox("Exclude from board", false, undefined, { id: "ns-exboard" });
  const inside = checkbox("Pin name inside", true, undefined, { id: "ns-inside" }); const offset = lenInput(M.DEFAULT_PIN_NAME_OFFSET, "ns-offset");
  const showNum = checkbox("Show pin number text", true, undefined, { id: "ns-shownum" }), showName = checkbox("Show pin name text", true, undefined, { id: "ns-showname" });
  const keepFp = checkbox("Keep linked footprint", true, undefined, { id: "ns-keepfp" }), keepDs = checkbox("Keep linked datasheet", true, undefined, { id: "ns-keepds" }), xfer = checkbox("Transfer user-defined fields", true, undefined, { id: "ns-xfer" }), keepUser = checkbox("Keep content of user-defined fields", false, undefined, { id: "ns-keepuser" });
  const cb = (l: HTMLLabelElement) => (l.querySelector("input") as HTMLInputElement).checked;
  const info = h("div", { style: "display:none;padding:4px 8px;margin-bottom:6px;background:color-mix(in srgb,var(--blue) 14%,var(--panel));border-radius:3px", id: "ns-info" });
  parent.addEventListener("change", () => { info.style.display = parent.value ? "block" : "none"; info.textContent = `Deriving from symbol '${parent.value}'.`; if (parent.value && !name.value) name.value = M.unescapeLibId(parent.value); });
  if (parentName && parents().includes(parentName)) { parent.value = parentName; parent.dispatchEvent(new Event("change")); }
  KD().open({
    title: "New Symbol", width: 560,
    build(body) {
      body.append(info, form([["Symbol name:", name], ["Derive from existing symbol:", parent], ["Default reference designator:", ref], ["Number of units per package:", unitsIn]]),
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px" }, inter, demorgan, power, exBom, exBoard, h("span"), inside, form([["Pin name position offset:", offset, unitName(units())]], 3), showNum, showName),
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px" }, keepFp, keepDs, xfer, keepUser));
      name.focus();
    },
    ok() {
      const nm = M.escapeLibId(name.value);   // DIALOG_LIB_NEW_SYMBOL::GetName: EscapeString( …, CTX_LIBID )
      const l = target;
      if (!nm) { void messageBox("Symbol must have a name.", "Message"); return false; }
      Object.assign(p, { name: nm, parent: parent.value || null, reference: ref.value.trim() || "U", unitCount: Math.max(1, Math.round(Number(unitsIn.value) || 1)), unitsInterchangeable: cb(inter), alternateBodyStyle: cb(demorgan),
        power: cb(power), pinNameInside: cb(inside), pinTextPosition: lenOf(offset, M.DEFAULT_PIN_NAME_OFFSET), showPinNumber: cb(showNum), showPinName: cb(showName), includeInBom: !cb(exBom), includeOnBoard: !cb(exBoard),
        keepFootprint: cb(keepFp), keepDatasheet: cb(keepDs), transferUserFields: cb(xfer), keepContentUserFields: cb(keepUser) });
      const create = () => {
        const par = p.parent && l && l.doc ? l.doc.lib.symbols.get(p.parent) || null : null;
        const s = M.createSymbol(p, par);
        if (!l) { se.openUnsaved(s); return; }
        void l.doc!.commit([[nm, M.text(s)]]).then(() => { l.rows = null; void se.loadSymbol(l.nick, nm); });
        l.rows = null; void se.loadSymbol(l.nick, nm);
      };
      if (l && l.doc && l.doc.lib.symbols.has(nm)) {
        void confirmBox("Confirmation", `Symbol '${M.unescapeLibId(nm)}' already exists in library '${l.nick}'.`, "Overwrite").then((ok) => { if (ok) { KD().close(); create(); } });
        return false;
      }
      create(); return true;
    },
  });
}
/** Save As / Save Copy As: the current symbol (flattened when its parent stays behind) into a project library under a name. */
export function saveSymbolAs(se: SymbolEditor, copy: boolean): void {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const libs = se.projectLibs().filter((l) => l.doc && l.doc.canEdit);
  const lib0 = se.libs.get(t.lib); const start = lib0 && libs.includes(lib0) ? lib0.nick : libs.length ? libs[0].nick : "";
  const libSel = select(libs.map((l) => l.nick), start, undefined, { id: "sa-lib" }); const name = textInput(M.unescapeLibId(M.symName(sym)), undefined, { id: "sa-name" });
  KD().open({
    title: copy ? "Save Symbol Copy As" : "Save Symbol As", width: 460,
    build(body) { body.append(form([["Library:", libSel], ["Name:", name]])); name.focus(); name.select(); },
    ok() {
      // SAVE_AS_DIALOG::getSymbolName: trimmed, spaces to '_', EscapeString( …, CTX_LIBID )
      const nm = M.escapeLibId(name.value.trim().replace(/ /g, "_")); const l = se.libs.get(libSel.value);
      if (!l || !libSel.value) { void messageBox("A library must be specified.", "Message"); return false; }
      if (!nm) { void messageBox("Symbol must have a name.", "Message"); return false; }
      const go = () => {
        const srcLib = se.libMap(se.libs.get(t.lib) || null);
        let s = M.node(M.text(sym));
        const parent = M.parentNameOf(s);
        if (parent && (t.origin || !srcLib || l.nick !== t.lib)) s = M.flatten(srcLib, s);
        const tmp = { symbols: new Map([[M.symName(s), s]]) } as unknown as M.SymLib; M.renameSymbol(tmp, M.symName(s), nm); s = tmp.symbols.get(nm)!;
        void l.doc!.commit([[nm, M.text(s)]]).then(() => { l.rows = null; se.renderTree(); });
        l.rows = null;
        // an unsaved symbol's tab is promoted: it becomes the library symbol's tab
        if (t.scratch && !t.origin) { const i = se.tabs.indexOf(t); if (i >= 0) se.tabs.splice(i, 1); if (se.cur >= se.tabs.length) se.cur = se.tabs.length - 1; }
        if (!copy || (t.scratch && !t.origin)) { void se.loadSymbol(l.nick, nm); }
        else se.renderTree();
      };
      if (l.doc && l.doc.lib.symbols.has(nm)) { void confirmBox("Confirmation", `Symbol '${M.unescapeLibId(nm)}' already exists in library '${l.nick}'. Do you want to overwrite it?`, "Overwrite").then((ok) => { if (ok) { KD().close(); go(); } }); return false; }
      go(); return true;
    },
  });
}
/** SYMBOL_EDITOR_CONTROL::RenameSymbol: "Change Symbol Name" (LIBRARY_EDITOR_CONTROL's RENAME_DIALOG validates in place). */
export async function renameSymbol(se: SymbolEditor, lib: Lib, name: string): Promise<void> {
  if (!lib.doc) return;
  const doc = lib.doc;
  let newName = "";
  const nn = await promptText("Change Symbol Name", "New name:", M.unescapeLibId(name), async (typed) => {
    newName = M.escapeLibId(typed.trim());
    if (!newName) { await messageBox("Symbol must have a name.", "Message"); return false; }
    // no change: accepted without prompting
    if (newName !== name && doc.lib.symbols.has(newName))
      return confirmBox("Confirmation", `Symbol '${M.unescapeLibId(newName)}' already exists in library '${lib.nick}'.`, "Overwrite");
    return true;
  });
  if (nn === null || newName === name) return;
  const tmp: M.SymLib = { head: [] as unknown as M.SymLib["head"], version: 0, symbols: new Map([...doc.lib.symbols].map(([k, s]) => [k, M.node(M.text(s))])) };
  const overwritten = tmp.symbols.has(newName);
  if (overwritten) tmp.symbols.delete(newName);   // libMgr.RemoveSymbol( newName, libName )
  const touched = M.renameSymbol(tmp, name, newName);
  // the overwritten symbol's tab goes; the renamed symbol's tab follows it
  if (overwritten) for (let i = se.tabs.length - 1; i >= 0; i--) { const t = se.tabs[i]; if (!t.origin && t.lib === lib.nick && t.name === newName) await se.closeTab(i, true); }
  for (const t of se.tabs) if (!t.origin && t.lib === lib.nick && t.name === name) t.name = newName;
  await doc.commit([[name, null], ...touched.filter((n) => n !== name).map((n): [string, string] => [n, M.text(tmp.symbols.get(n)!)])]).catch(() => 0);
  if (se.treeSel && se.treeSel.lib === lib.nick && se.treeSel.name === name) se.treeSel = { lib: lib.nick, name: newName };
  lib.rows = null; se.renderAll();
}
/** New Library: a .kicad_sym document in the project, its first snapshot, and a sym-lib-table row. */
export async function newLibrary(se: SymbolEditor, seed?: string): Promise<Lib | null> {
  const proj = appState.project; if (!proj || E.viewOnly) { await messageBox("You need edit access to the project to add a library."); return null; }
  const nm = await promptText("New Library", "Library name:", ""); if (nm === null) return null;
  const nick = nm.trim().replace(/\.kicad_sym$/i, ""); if (!nick || /[\\/:]/.test(nick)) { await messageBox("Illegal character found in library name."); return null; }
  if (se.libs.has(nick)) { await messageBox(`Library '${nick}' already exists.`); return null; }
  return createProjectLibrary(se, nick, seed);
}
/** File > Add Library... (SYMBOL_EDIT_FRAME::AddLibraryFile( false )): an existing .kicad_sym joins the project as it is, with a sym-lib-table row. */
export async function addLibrary(se: SymbolEditor): Promise<Lib | null> {
  const proj = appState.project; if (!proj || E.viewOnly) { await messageBox("You need edit access to the project to add a library."); return null; }
  const f = await pickFile(".kicad_sym"); if (!f) return null;
  const nick = f.name.replace(/\.kicad_sym$/i, ""); if (!nick) return null;
  if (se.libs.has(nick)) { await messageBox(`Library '${nick}' already exists.`); return null; }
  const text = await f.text();
  try { M.parseLibrary(text); if (!/^\s*\(kicad_symbol_lib\b/.test(text)) throw new Error("not a library"); } catch (e) { await messageBox("Could not open the library file."); return null; }
  return createProjectLibrary(se, nick, text);   // the file's own bytes: nothing is rewritten
}
async function createProjectLibrary(se: SymbolEditor, nick: string, seed?: string): Promise<Lib | null> {
  const proj = appState.project; if (!proj) return null;
  const path = nick + ".kicad_sym";
  let doc: { docId: string; path: string; docType: string };
  try { doc = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, docType: "symbol_lib" }) }) as { docId: string; path: string; docType: string }; }
  catch (e) { await messageBox(`Could not create '${path}': ${(e as Error).message}`); return null; }
  const text = seed || M.NEW_LIBRARY_TEXT;
  if (!(await firstSnapshot(doc.docId, text))) { await messageBox(`Could not write '${path}'.`); return null; }
  if (!proj.docs.some((d) => d.docId === doc.docId)) proj.docs.push({ docId: doc.docId, path: doc.path, docType: doc.docType || "symbol_lib" });
  await addToLibTable(nick, path);
  se.noteTableRow(doc.path, nick);
  const ld = libDocFor(doc.docId, doc.path, nick);
  const lib: Lib = { nick, kind: "project", doc: ld, rows: null, syms: new Map(), open: true, loading: true };
  se.libs.set(nick, lib); ld.on((why, names) => (se as unknown as { onLibEvent(l: Lib, w: string, n?: string[]): void }).onLibEvent(lib, why, names)); ld.connect();
  se.treeSel = { lib: nick }; se.renderAll();
  return lib;
}
/**
 * Symbol libraries made outside the editors (a plugin's part import): each `<name>.kicad_sym` becomes a project
 * library (an existing file takes the new content), with its row in the project's sym-lib-table.
 */
export async function importSymbolLibraries(files: { path: string; text: string }[]): Promise<{ added: string[]; updated: string[]; failed: string[] }> {
  const out = { added: [] as string[], updated: [] as string[], failed: [] as string[] };
  const proj = appState.project;
  if (!proj || E.viewOnly) { out.failed = files.map((f) => f.path); return out; }
  for (const f of files) {
    const m = /^(?:[^/]+\/)*([^/]+)\.kicad_sym$/i.exec(f.path);
    let ok = !!m && /^\s*\(kicad_symbol_lib\b/.test(f.text);
    if (ok) { try { M.parseLibrary(f.text); } catch (e) { ok = false; } }
    if (!m || !ok) { out.failed.push(f.path); continue; }
    const have = proj.docs.find((d) => d.path === f.path);
    try {
      if (have) {
        if (!(await saveTextDocument(have.docId, f.text, { id: "lib", kind: "MODIFIED", typeName: "LIB_SAVED", properties: [] } as unknown as KChange))) throw new Error("not saved");
        out.updated.push(f.path);
      } else {
        const doc = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: f.path, docType: "symbol_lib" }) }) as { docId: string; path: string; docType: string };
        if (!(await firstSnapshot(doc.docId, f.text))) throw new Error("not written");
        if (!proj.docs.some((d) => d.docId === doc.docId)) proj.docs.push({ docId: doc.docId, path: doc.path, docType: doc.docType || "symbol_lib" });
        out.added.push(f.path);
      }
      const table = proj.docs.find((d) => d.path === "sym-lib-table"); let listed = false;
      if (table) { try { const r = await fetch(`/api/docs/${table.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); listed = r.ok && M.parseLibTable(await r.text()).some((row) => row.nickname === m[1]); } catch (e) { /* add the row */ } }
      if (!listed) await addToLibTable(m[1], f.path);
    } catch (e) { console.warn(e); out.failed.push(f.path); }
  }
  return out;
}
/** A document just created holds nothing the server can join yet: its first content is the snapshot at sequence 0. */
async function firstSnapshot(docId: string, text: string): Promise<boolean> {
  try { const r = await fetch(`/api/docs/${docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text }); if (r.ok) return true; } catch (e) { /* fall through */ }
  return saveTextDocument(docId, text, { id: "lib", kind: "MODIFIED", typeName: "LIB_SAVED", properties: [] } as unknown as KChange);
}
async function addToLibTable(nick: string, path: string): Promise<void> {
  const proj = appState.project; if (!proj) return;
  const table = proj.docs.find((d) => d.path === "sym-lib-table");
  let text: string;
  try {
    if (table) {
      const r = await fetch(`/api/docs/${table.docId}/content`, { credentials: "same-origin" }); const old = r.ok ? await r.text() : "(sym_lib_table\n\t(version 7)\n)\n";
      // the table as LIBRARY_TABLE::Save writes it (FORMAT_MODE::LIBRARY_TABLE), with the new row last
      const rows = M.parseLibTable(old); rows.push({ nickname: nick, type: "KiCad", uri: "${KIPRJMOD}/" + path, options: "", descr: "", enabled: true, visible: true });
      text = M.formatLibTable(rows, "sym_lib_table");
      await saveTextDocument(table.docId, text, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [] } as unknown as KChange);
    } else {
      const d = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sym-lib-table" }) }) as { docId: string; path: string; docType: string };
      text = M.formatLibTable([{ nickname: nick, type: "KiCad", uri: "${KIPRJMOD}/" + path, options: "", descr: "", enabled: true, visible: true }], "sym_lib_table");
      await firstSnapshot(d.docId, text);
      proj.docs.push({ docId: d.docId, path: d.path, docType: d.docType || "lib_table" });
    }
  } catch (e) { /* the library still works by its file name */ }
}
/** Save Library As: the whole library (official or project) into a new project library. */
export async function saveLibraryAs(se: SymbolEditor, lib: Lib): Promise<void> {
  let text = M.NEW_LIBRARY_TEXT;
  if (lib.doc) text = lib.doc.fileText();
  else {
    const r = await fetch(`/api/libs/symbols/${encodeURIComponent(lib.nick)}`, { credentials: "same-origin" }); if (!r.ok) { await messageBox(`Could not read library '${lib.nick}'.`); return; }
    const j = await r.json() as { symbols: { n: string }[] }; const out = M.emptyLibrary();
    for (const s of j.symbols) { const q2 = await fetch(`/api/libs/symbols/${encodeURIComponent(lib.nick)}/${encodeURIComponent(s.n)}`, { credentials: "same-origin" }); if (!q2.ok) continue; const jj = await q2.json() as { symbol: string }; const n = M.node(jj.symbol); out.symbols.set(M.symName(n), n); }
    text = M.serializeLibrary(out);
  }
  const nl = await newLibrary(se, text); if (nl) nl.open = true;
}
/** The read-only library's "Create an editable copy": the symbol or the whole library. */
export async function editableCopy(se: SymbolEditor): Promise<void> {
  const t = se.tab; if (!t) return; const lib = se.libs.get(t.lib); if (!lib) return;
  await new Promise<void>((resolve) => {
    KD().open({
      title: "Select type of item to save", width: 460,
      build(body) { body.append(h("p", null, `Create an editable copy of the symbol or the entire library (${lib.nick})?`)); },
      buttons: [
        { label: "Copy symbol", primary: true, isDefault: true, fn: () => { KD().close(); saveSymbolAs(se, false); resolve(); } },
        { label: "Cancel", close: true },
        { label: "Copy library", fn: () => { KD().close(); void saveLibraryAs(se, lib).then(() => resolve()); } },
      ],
      cancel() { resolve(); },
    });
  });
}

// ---------------------------------------------------------------- import / export
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => { const i = h("input", { type: "file", accept, style: "display:none" }) as HTMLInputElement; i.addEventListener("change", () => { resolve(i.files && i.files[0] ? i.files[0] : null); i.remove(); }); document.body.append(i); i.click(); });
}
/** SYMBOL_EDIT_FRAME::ImportSymbol: pick a library file, choose its symbols (DIALOG_IMPORT_SYMBOL_SELECT), resolve conflicts. */
export async function importSymbol(se: SymbolEditor, lib: Lib): Promise<void> {
  if (!lib.doc || !lib.doc.canEdit) return;
  const f = await pickFile(".kicad_sym"); if (!f) return;
  let src: M.SymLib; try { src = M.parseLibrary(await f.text()); } catch (e) { await messageBox(`Cannot read symbol library '${f.name}'.`); return; }
  if (!src.symbols.size) { await messageBox(`Symbol library '${f.name}' is empty.`); return; }
  const dest = lib.doc.lib;
  const mgr = new M.SymbolImportManager(src, (n) => dest.symbols.has(n));
  const state = { filter: "", selected: "" };
  for (;;) {
    if (!(await importSelectDialog(f.name, src, mgr, state))) return;
    const res = await importConflictsDialog(mgr.conflicts());
    if (res) { await doImport(se, lib, src, mgr.toImport(), res); return; }
  }
}
async function doImport(se: SymbolEditor, lib: Lib, src: M.SymLib, names: string[], skip: Set<string>): Promise<void> {
  const out: [string, string][] = []; let skipped = 0;
  for (const n of names) { if (skip.has(n)) { skipped++; continue; } const s = M.clone(src.symbols.get(n)!); out.push([n, M.text(s)]); }   // LoadSymbol + UpdateSymbol: derived symbols stay derived
  if (!out.length || !lib.doc) return;
  await lib.doc.commit(out).catch(() => 0); lib.rows = null;
  await se.loadSymbol(lib.nick, out[0][0]);
  if (skipped > 0) await messageBox(`Imported ${out.length} symbol(s), skipped ${skipped}.`, "Information");
}
/** DIALOG_IMPORT_SYMBOL_SELECT: search, a checked list (derived symbols in italics, power and existing ones marked), preview with a unit choice. */
function importSelectDialog(file: string, src: M.SymLib, mgr: M.SymbolImportManager, state: { filter: string; selected: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false; const fin = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    const search = textInput(state.filter, undefined, { id: "imp-search", placeholder: "Search", style: "width:100%" });
    const list = h("div", { id: "imp-list", class: "kd-list", role: "listbox", style: "flex:1;min-height:260px;max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:3px;background:var(--field)" });
    const unit = select([], "", undefined, { id: "imp-unit", disabled: true, style: "min-width:100px" });
    const cv = h("canvas", { id: "imp-preview", style: "width:100%;height:300px;display:block;border:1px solid var(--line);border-radius:3px" }) as HTMLCanvasElement;
    const status = h("div", { id: "imp-status", style: "margin-top:8px" });
    let okBtn: HTMLButtonElement | null = null;
    const matches = (n: string) => M.SymbolImportManager.matches(n, state.filter);
    const refreshButtons = () => { status.textContent = mgr.status(); if (okBtn) okBtn.disabled = mgr.toImport().length === 0; };
    const preview = () => {
      const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth || 360, H = cv.clientHeight || 300; cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext("2d"); if (!ctx) return; ctx.fillStyle = K().SCH.bg; ctx.fillRect(0, 0, cv.width, cv.height);
      const s0 = state.selected ? src.symbols.get(state.selected) : null; if (!s0) return;
      const flat = M.isDerived(s0) ? M.flatten(src, s0) : s0;
      const doc = K().parseLibSymbol(flat as unknown as SNode, { unit: Number(unit.value) || 1, showHiddenPins: false, showHiddenFields: false, showElectricalTypes: false });
      const bb = doc.bbox; if (!bb) return;
      const sc = Math.min(W / ((bb[2] - bb[0]) * 1.15 || 1), H / ((bb[3] - bb[1]) * 1.15 || 1), 60);
      K().render(doc, ctx, { ppm: 1, zoom: sc, panX: W / 2 - (bb[0] + bb[2]) / 2 * sc, panY: H / 2 - (bb[1] + bb[3]) / 2 * sc, x0: 0, y0: 0, dpr }, { frame: false } as KRenderOpts);
    };
    const updatePreview = () => {
      unit.innerHTML = ""; const s0 = state.selected ? src.symbols.get(state.selected) : null;
      const root = s0 ? M.rootOf(src, s0) : null; const n = root ? Math.max(M.unitCount(root), 1) : 1;
      unit.disabled = !s0 || n < 2;
      if (root && n > 1) { const names = M.unitNames(root); for (let u = 1; u <= n; u++) unit.append(h("option", { value: String(u) }, names.get(u) || `Unit ${M.unitLetter(u)}`)); unit.value = "1"; }
      preview();
    };
    const renderList = () => {
      list.innerHTML = "";
      for (const n of mgr.names()) {
        if (!matches(n)) continue; const i = mgr.infos.get(n)!;
        const cb = h("input", { type: "checkbox", "data-name": n, style: "width:auto;margin:0 6px 0 0" }) as HTMLInputElement; cb.checked = i.checked || i.auto;
        cb.addEventListener("click", (ev) => { ev.stopPropagation(); if (cb.checked) mgr.setSelected(n, true); else mgr.deselectWithDescendants(n); syncChecks(); refreshButtons(); });
        const ic = i.power ? icon("add_power") : i.exists ? icon("small_warning") : h("span", { style: "display:inline-block;width:16px" });
        if (i.exists && !i.power) (ic as Element).setAttribute("aria-label", "exists in the destination library");
        const row = h("div", { class: "imp-row" + (n === state.selected ? " sel" : ""), role: "option", "data-name": n, style: `display:flex;align-items:center;gap:4px;padding:2px 6px;cursor:default;${n === state.selected ? "background:var(--sel);" : ""}` },
          cb, ic, h("span", { style: i.derived ? "font-style:italic" : "" }, n));
        row.addEventListener("click", () => { state.selected = n; renderList(); updatePreview(); });
        list.append(row);
      }
    };
    const syncChecks = () => { for (const cb of list.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) { const i = mgr.infos.get(cb.dataset.name!)!; cb.checked = i.checked || i.auto; } };
    search.addEventListener("input", () => { state.filter = search.value.toLowerCase(); renderList(); });
    unit.addEventListener("change", preview);
    KD().open({
      title: `Import Symbols from ${file}`, geomKey: "Import Symbols", width: 820, cls: "kd-wide", okLabel: "Import",
      build(body, api) {
        const allB = h("button", { class: "btn sm", id: "imp-all", onclick: () => { mgr.selectAll(matches); renderList(); refreshButtons(); } }, "Select All");
        const noneB = h("button", { class: "btn sm", id: "imp-none", onclick: () => { mgr.deselectAll(matches); renderList(); refreshButtons(); } }, "Select None");
        const left = h("div", { style: "flex:2;display:flex;flex-direction:column;gap:5px;min-width:0" }, search, list, h("div", { style: "display:flex;gap:6px;margin-top:5px" }, allB, noneB));
        const right = h("div", { style: "flex:3;display:flex;flex-direction:column;gap:5px;min-width:0" }, h("div", { style: "display:flex;align-items:center;gap:5px" }, h("span", null, "Unit:"), unit), cv);
        body.append(h("div", { style: "display:flex;gap:10px" }, left, right), status);
        okBtn = api.foot.querySelector<HTMLButtonElement>(".btn.primary");
        renderList(); refreshButtons();
        requestAnimationFrame(() => { updatePreview(); search.focus(); });
      },
      ok() { if (!mgr.toImport().length) return false; fin(true); return true; },
      cancel() { fin(false); },
    });
  });
}
/** DIALOG_IMPORT_SYMBOL_SELECT::resolveConflicts: Overwrite (default) or Skip for each symbol the library already has; null on Cancel. */
function importConflictsDialog(conflicts: string[]): Promise<Set<string> | null> {
  if (!conflicts.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const rows = conflicts.map((name) => ({ name, action: "Overwrite" }));
    let grid: { refresh(): void } | null = null; let done = false;
    KD().open({
      title: "Resolve Import Conflicts", width: 500, okLabel: "Import",
      build(body) {
        body.append(h("div", { style: "max-width:450px;margin-bottom:8px" }, "The following symbols already exist in the destination library. Choose how to handle each conflict:"));
        grid = KD().grid(body, [{ key: "name", label: "Symbol", type: "ro", width: 200 }, { key: "action", label: "Action", type: "choice", options: ["Overwrite", "Skip"], width: 100 }], rows, { height: 220 });
        const set = (a: string) => { for (const r of rows) r.action = a; grid && grid.refresh(); };
        body.append(h("div", { style: "display:flex;gap:5px;margin-top:8px" }, h("button", { class: "btn sm", id: "imp-skip-all", onclick: () => set("Skip") }, "Skip All"), h("button", { class: "btn sm", id: "imp-over-all", onclick: () => set("Overwrite") }, "Overwrite All")));
      },
      ok() { done = true; resolve(new Set(rows.filter((r) => r.action === "Skip").map((r) => r.name))); return true; },
      cancel() { if (!done) resolve(null); },
    });
  });
}
export function exportSymbol(se: SymbolEditor): void {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const lib = M.emptyLibrary(); const flat = M.flatten(se.libMap(se.libs.get(t.lib) || null), sym); lib.symbols.set(M.symName(flat), flat);
  download(M.symName(flat).replace(/[\\/:*?"<>|]/g, "_") + ".kicad_sym", M.serializeLibrary(lib), "text/plain;charset=utf-8");
}
export async function exportPng(se: SymbolEditor): Promise<void> {
  const doc = se.kdoc(); const sym = se.symbol(); if (!doc || !sym) return;
  const blob = await K().renderPng(doc, { frame: false, scale: 20, margin: 2 });
  const a = h("a", { href: URL.createObjectURL(blob), download: M.symName(sym) + ".png" }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function exportSvg(se: SymbolEditor): void {
  const doc = se.kdoc(); const sym = se.symbol(); if (!doc || !sym) return;
  download(M.symName(sym) + ".svg", K().renderSvg(doc, { frame: false, margin: 2 }), "image/svg+xml");
}

// ---------------------------------------------------------------- Symbol Checker
export function checker(se: SymbolEditor): void {
  const sym = se.symbol(); if (!sym) return;
  const flat = M.flatten(se.libMap(se.libs.get(se.tab!.lib) || null), sym);
  const u = units(); const f = (mm: number) => `${toUser(mm)} ${unitName(u)}`;
  const msgs = M.checkSymbol(flat, se.gridMm, f);
  if (!msgs.length) { void messageBox("No symbol issues found.", "Symbol Checker"); return; }
  KD().open({
    title: "Symbol Warnings", width: 640, okLabel: "Close",
    build(body) { const box = h("div", { class: "se-checker", id: "se-checker", style: "max-height:60vh;overflow:auto;padding:4px 8px;background:var(--bg);border:1px solid var(--line)" }); box.innerHTML = msgs.join(""); body.append(box); },
  });
}

// ---------------------------------------------------------------- Manage Symbol Libraries
/** Preferences > Manage Symbol Libraries... (DIALOG_EDIT_LIBRARY_TABLES with PANEL_SYM_LIB_TABLE).  The global table is
 *  the KiCad libraries the server provides (read-only here); the project table is the project's sym-lib-table. */
export async function manageSymbolLibraries(se: SymbolEditor): Promise<void> {
  const proj = appState.project; if (!proj) return;
  const table = proj.docs.find((d) => d.path === "sym-lib-table");
  let oldText = "";
  if (table) { try { const r = await fetch(`/api/docs/${table.docId}/content`, { credentials: "same-origin" }); if (r.ok) oldText = await r.text(); } catch (e) { /* empty table */ } }
  const projRows: M.LibTableRow[] = oldText ? M.parseLibTable(oldText) : [];
  const globalRows: M.LibTableRow[] = [...se.libs.values()].filter((l) => l.kind === "official").map((l) => ({ enabled: true, visible: true, nickname: l.nick, uri: "${KICAD10_SYMBOL_DIR}/" + l.nick + ".kicad_sym", type: "KiCad", options: "", descr: "" }));
  const ro = !!E.viewOnly;
  const cols = (readOnly: boolean): GridColumn<M.LibTableRow>[] => [
    { key: "enabled", label: "Enable", type: "bool", width: 50 }, { key: "visible", label: "Show", type: "bool", width: 46 },
    { key: "nickname", label: "Nickname", width: 140 }, { key: "uri", label: "Library Path", width: 300 },
    { key: "type", label: "Library Format", type: "choice", options: (r: M.LibTableRow) => { const o = ["KiCad", "Legacy", "Database", "Table"]; return o.includes(r.type) ? o : [...o, r.type]; }, width: 110 },
    { key: "options", label: "Options", width: 70 }, { key: "descr", label: "Description", width: 180 },
  ].map((c) => (readOnly ? { ...c, ro: () => true } : c)) as GridColumn<M.LibTableRow>[];
  let nb: NotebookApi | null = null; let projGrid: GridApi<M.LibTableRow> | null = null;
  KD().open({
    title: "Symbol Libraries", width: 960, cls: "kd-wide", readOnly: ro,
    build(body) {
      nb = KD().notebook(body, [
        { label: "Global Libraries (read-only)", build(pg) { KD().grid(pg, cols(true), globalRows, { readOnly: true, height: 300 }); } },
        { label: "Project Specific Libraries", build(pg) {
          projGrid = KD().grid(pg, cols(ro), projRows, { readOnly: ro, height: 300, buttons: ro ? undefined : { add: () => ({ enabled: true, visible: true, nickname: "", uri: "", type: "KiCad", options: "", descr: "" }), addTitle: "Add empty row to table", remove: true, removeTitle: "Remove library from table", move: true } });
        } },
      ], { selected: 1 });
      const subs = KD().staticBox(body, "Available path substitutions:");
      KD().grid(subs, [{ key: "name", label: "Name", type: "ro", width: 220 }, { key: "value", label: "Value", type: "ro", width: 520 }],
        [{ name: "KICAD10_SYMBOL_DIR", value: "(the KiCad symbol libraries this server provides)" }, { name: "KIPRJMOD", value: "(the project folder)" }], { readOnly: true, height: 70 });
    },
    ok() {
      if (ro) return true;
      const v = M.verifyLibTable(projRows);
      if (v.error) { nb && nb.select(1); if (projGrid && v.row !== undefined) projGrid.select(v.row); void messageBox(v.error, "Library Nickname Error"); return false; }
      projRows.splice(0, projRows.length, ...v.rows); projGrid && projGrid.refresh();
      const before = oldText ? M.parseLibTable(oldText) : [];
      if (JSON.stringify(before) === JSON.stringify(v.rows)) return true;
      const text = M.formatLibTable(v.rows);
      void (async () => {
        try {
          if (table) { if (!(await saveTextDocument(table.docId, text, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [] } as unknown as KChange))) throw new Error("not saved"); }
          else {
            const d = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sym-lib-table" }) }) as { docId: string; path: string; docType: string };
            if (!(await firstSnapshot(d.docId, text))) throw new Error("not saved");
            proj.docs.push({ docId: d.docId, path: d.path, docType: d.docType || "lib_table" });
          }
          se.reloadLibTable(v.rows);
        } catch (e) { await messageBox("Error saving project library table:\n\n" + (e as Error).message, "File Save Error"); }
      })();
      return true;
    },
  });
}

// ---------------------------------------------------------------- Update Symbol Fields
/** DIALOG_UPDATE_SYMBOL_FIELDS: reset a derived symbol's fields from its parent (LIB_SYMBOL::SyncFieldsFromParent). */
export function updateSymbolFields(se: SymbolEditor): void {
  const sym = se.symbol(); const t = se.tab; if (!sym || !t) return;
  const lib = se.libMap(se.libs.get(t.lib) || null);
  if (!M.isDerived(sym)) { se.infoBarError("Symbol is not derived from another symbol."); return; }
  const names = M.updatableFieldNames(lib, sym);
  const opt = { removeExtra: false, resetEmpty: false, resetText: true, resetVisibility: true, resetEffects: true, resetPositions: true };
  const boxes: HTMLInputElement[] = [];
  KD().open({
    title: "Update Symbol Fields", width: 560,
    build(body) {
      const ro = textInput(M.parentNameOf(sym) || "", undefined, { disabled: true, id: "usf-parent", style: "flex:1" });
      body.append(h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" }, h("span", null, "Parent symbol:"), ro));
      const fieldsBox = h("div", { style: "flex:1;min-width:0" }), optsBox = h("div", { style: "flex:1;min-width:0" });
      const left = KD().staticBox(fieldsBox, "Update/reset Fields");
      const list = h("div", { id: "usf-fields", style: "height:200px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:2px 4px" });
      for (const n of names) { const c = checkbox(n, true); boxes.push(c.querySelector("input")!); list.append(h("div", null, c)); }
      left.append(list, h("div", { style: "display:flex;gap:6px;margin-top:4px" },
        h("button", { class: "btn", type: "button", id: "usf-all", onclick: () => boxes.forEach((b) => (b.checked = true)) }, "Select All"),
        h("button", { class: "btn", type: "button", id: "usf-none", onclick: () => boxes.forEach((b) => (b.checked = false)) }, "Select None")));
      const right = KD().staticBox(optsBox, "Update Options");
      const opts: [keyof typeof opt, string][] = [["removeExtra", "Remove fields if not in parent symbol"], ["resetEmpty", "Reset fields if empty in parent symbol"], ["resetText", "Update/reset field text"], ["resetVisibility", "Update/reset field visibilities"], ["resetEffects", "Update/reset field sizes and styles"], ["resetPositions", "Update/reset field positions"]];
      right.append(h("div", { style: "display:flex;flex-direction:column;gap:2px" }, ...opts.map(([k, label]) => checkbox(label, opt[k], (on) => (opt[k] = on), { id: "usf-" + k }))));
      body.append(h("div", { style: "display:flex;gap:10px" }, fieldsBox, optsBox));
    },
    ok() {
      const fields = new Set<string>(); names.forEach((n, i) => { if (boxes[i].checked) fields.add(n); });
      se.edit("Update Symbol Fields", (s) => { if (!M.syncFieldsFromParent(lib, s, { fields, ...opt })) return false; });
      return true;
    },
  });
}

// ---------------------------------------------------------------- Pin Table
export function pinTable(se: SymbolEditor): void {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const root = se.rootSym(sym); const ro = se.readOnly() || M.isDerived(sym);
  const rows = M.pinRows(sym);
  const bodyNames = M.bodyStyles(root).names; const nUnits = M.unitCount(root);
  const unitOpts: [string, string][] = [["0", "ALL"], ...Array.from({ length: nUnits }, (_, i) => [String(i + 1), M.unitLetter(i + 1)] as [string, string])];
  const bodyOpts: [string, string][] = [["0", "ALL"], ...bodyNames.map((n, i) => [String(i + 1), n] as [string, string])];
  // DIALOG_LIB_EDIT_PIN_TABLE: Pin numbers / Pin count / Duplicate pins over every pin, whatever the filters show
  const summary = h("div", { id: "pt-summary", style: "display:flex;gap:16px;margin-bottom:6px;color:var(--ink-2)" });
  const sum = () => { const s = M.pinNumberSummary(rows); summary.innerHTML = "";
    summary.append(h("span", null, `Pin numbers: ${s.numbers}`), h("span", null, `Pin count: ${s.count}`), h("span", { id: "pt-dups", style: s.duplicates ? "color:var(--err)" : "" }, `Duplicate pins: ${s.duplicates || 0}`)); };
  let grid: { refresh(): void } | null = null;
  const len = (k: keyof M.PinRow) => ({ key: k as string, label: "", width: 76, format: (v: unknown) => toUser(Number(v)) });
  // the filters (RebuildRows: a pin common to all units / body styles always shows)
  const selNodes = new Set<M.Node>(se.selNodes(sym));
  const fUnit = checkbox("Filter by unit:", false, () => rebuild(), { id: "pt-filter-unit", disabled: nUnits < 2 });
  const fUnitSel = select(unitOpts, "0", () => { (fUnit.querySelector("input") as HTMLInputElement).checked = true; rebuild(); }, { id: "pt-unit", disabled: nUnits < 2 });
  const fBody = checkbox("Filter by body style:", false, () => rebuild(), { id: "pt-filter-body", disabled: bodyNames.length < 2 });
  const fBodySel = select(bodyOpts, "0", () => { (fBody.querySelector("input") as HTMLInputElement).checked = true; rebuild(); }, { id: "pt-body", disabled: bodyNames.length < 2 });
  const fSel = checkbox("Filter by selection", false, () => rebuild(), { id: "pt-filter-sel" });
  const on = (l: HTMLLabelElement) => (l.querySelector("input") as HTMLInputElement).checked;
  const shown: M.PinRow[] = [];
  const visible = (r: M.PinRow): boolean => {
    const u = on(fUnit) ? Number(fUnitSel.value) : 0, b = on(fBody) ? Number(fBodySel.value) : 0;
    return (u === 0 || r.unit === 0 || r.unit === u) && (b === 0 || r.body === 0 || r.body === b) && (!on(fSel) || (!!r.node && selNodes.has(r.node)));
  };
  const rebuild = () => { shown.length = 0; shown.push(...rows.filter(visible)); grid && grid.refresh(); sum(); };
  shown.push(...rows.filter(visible));
  KD().open({
    title: `Pin Table`, width: 1100, cls: "kd-wide", readOnly: ro,
    build(body) {
      sum(); body.append(summary);
      grid = KD().grid(body, [
        { key: "count", label: "Count", type: "ro", width: 46 },
        { key: "number", label: "Number", width: 70 }, { key: "name", label: "Name", width: 120 },
        { key: "type", label: "Electrical Type", type: "choice", options: M.PIN_TYPES.map(([a, l]) => [a, l] as [string, string]), width: 120 },
        { key: "shape", label: "Graphic Style", type: "choice", options: M.PIN_SHAPES.map(([a, l]) => [a, l] as [string, string]), width: 120 },
        { key: "orient", label: "Orientation", type: "choice", options: M.PIN_ORIENTATIONS.map(([a, l]) => [String(a), l] as [string, string]), width: 80 },
        { ...len("numSize"), label: "Number Text Size" }, { ...len("nameSize"), label: "Name Text Size" }, { ...len("length"), label: "Length" }, { ...len("x"), label: "X Position" }, { ...len("y"), label: "Y Position" },
        { key: "visible", label: "Visible", type: "bool", width: 50 },
        { key: "unit", label: "Unit", type: "choice", options: unitOpts, width: 56 }, { key: "body", label: "Body Style", type: "choice", options: bodyOpts, width: 90 },
      ], shown, {
        readOnly: ro, height: 380,
        onChange(r, key, v, sel) {
          const row = r as unknown as Record<string, unknown>;
          if (key && ["numSize", "nameSize", "length", "x", "y"].includes(key) && typeof v === "string") { const n = parseLen(v); row[key] = n === null ? 0 : +M.fmt(n); }
          if (key === "orient" || key === "unit" || key === "body") row[key] = Number(v);
          // the grid edits the shown rows: an added row joins the pins, a deleted one leaves them
          if (key === null && typeof sel === "number") { const pr = r as unknown as M.PinRow; const i = rows.indexOf(pr); if (sel < 0 && i >= 0) rows.splice(i, 1); else if (sel >= 0 && i < 0) rows.push(pr); }
          sum();
        },
        buttons: { add: () => { const last = rows[rows.length - 1]; const p = last ? M.repeatPin({ ...M.newPinInfo(last.x, last.y, se.lastPin, last.unit, last.body), name: last.name, number: last.number, orient: last.orient }) : M.newPinInfo(0, 0, se.lastPin, t.unit, t.body); return { count: 1, number: p.number, name: p.name, type: p.type, shape: p.shape, orient: p.orient, numSize: p.numSize, nameSize: p.nameSize, length: p.length, x: p.x, y: p.y, visible: p.visible, unit: p.unit, body: p.body, node: null }; }, remove: true },
      });
      for (const l of [fUnit, fBody, fSel]) l.style.whiteSpace = "nowrap";
      fUnitSel.style.width = fBodySel.style.width = "110px";
      body.append(h("div", { style: "display:flex;gap:14px;align-items:center;margin-top:6px;flex-wrap:wrap" },
        h("span", { style: "display:flex;gap:6px;align-items:center" }, fUnit, fUnitSel), h("span", { style: "display:flex;gap:6px;align-items:center" }, fBody, fBodySel), fSel));
      // the Export and Import boxes
      const radio = (name: string, id: string, label: string, checked: boolean) => { const i = h("input", { type: "radio", name, id, style: "width:auto;margin:0" }) as HTMLInputElement; i.checked = checked; return h("label", { style: "display:flex;gap:6px;align-items:center" }, i, label); };
      const expAll = radio("pt-exp", "pt-exp-all", "Export all pins", true), expShown = radio("pt-exp", "pt-exp-shown", "Export only shown pins", false);
      const impReplace = radio("pt-imp", "pt-imp-replace", "Replace all existing pins", true), impAppend = radio("pt-imp", "pt-imp-append", "Append to existing pins", false);
      const exp = (sep: string) => M.pinsToCsv((expShown.querySelector("input") as HTMLInputElement).checked ? shown : rows, sym, (mm) => toUser(mm), sep);
      const boxes = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px" });
      body.append(boxes);
      const eb = KD().staticBox(boxes, "Export"); const ib = KD().staticBox(boxes, "Import");
      eb.append(h("div", { style: "display:flex;gap:14px;align-items:center;flex-wrap:wrap" }, expAll, expShown, h("span", { style: "flex:1" }),
        h("button", { class: "btn sm", id: "pt-export", onclick: () => download(M.symName(sym) + ".csv", exp(",")) }, "To File..."),
        h("button", { class: "btn sm", id: "pt-export-clip", onclick: () => { try { void navigator.clipboard.writeText(exp("\t")); } catch (e) { /* no clipboard */ } } }, "To Clipboard")));
      ib.append(h("div", { style: "display:flex;gap:14px;align-items:center;flex-wrap:wrap" }, impReplace, impAppend, h("span", { style: "flex:1" }),
        h("button", { class: "btn sm", id: "pt-import", disabled: ro, onclick: () => void pickFile(".csv,.tsv,.txt").then(async (f) => {
          if (!f) return; const got = M.pinsFromCsv(await f.text(), sym, (s) => parseLen(s) || 0);
          // OnImportButtonClick: the reporter's messages in an Errors box that can cancel; nothing to import leaves the pins alone
          if (got.errors.length && !(await confirmBox("Errors", got.errors.join("\n")))) return;
          if (!got.rows.length) return;
          if ((impReplace.querySelector("input") as HTMLInputElement).checked) rows.length = 0;
          rows.push(...got.rows); rebuild(); }) }, "From File...")));
    },
    ok() { if (ro) return true; se.edit("Edit Pins", (s) => { M.applyPinRows(s, rows); }); return true; },
  });
}

// ---------------------------------------------------------------- misc
export async function addToSchematic(se: SymbolEditor): Promise<void> {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return;
  const flat = M.flatten(se.libMap(se.libs.get(t.lib) || null), sym);
  const libId = t.origin ? t.origin.libId : `${t.lib}:${t.name}`;
  await se.close();
  if (window.KiCadLibrary) await window.KiCadLibrary.placeSymbol({ libId, symbol: M.text(flat) }).catch((e: Error) => messageBox(e.message));
}
export function hotkeys(): void {
  const rows = hotkeyRows("sch").filter((r) => r.key);
  KD().open({ title: "Hotkey List", width: 560, okLabel: "Close", build(body) { const tb = h("table", { class: "kd-grid" }); for (const r of rows) tb.append(h("tr", null, h("td", null, r.label), h("td", null, keyName(r.key)))); body.append(h("div", { style: "max-height:60vh;overflow:auto" }, tb)); } });
}
