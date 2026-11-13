// pcbdialogs/track-via — DIALOG_TRACK_VIA_PROPERTIES over one track, one via or a whole selection of them
// (EDIT_TOOL::Properties hands it the selection): Common (Net, Automatically update via nets, Locked), Tracks
// (Start / End, Pre-defined sizes, Track width, Layer, Technical Layers: Solder mask + Expansion) and Vias
// (Position, Pre-defined sizes, Padstack mode / Edit layer, Via diameter / hole, Via type, Start / End layer,
// Annular rings, Protection features, Backdrill, Hole Post-machining, Teardrops).  A value the selected items do
// not share shows "-- mixed values --" and is left alone unless edited; a check box they do not share is in its
// third state.  OK validates as TransferDataFromWindow does (DisplayError and the bad field focused) and stores
// one "Edit Track/Via Properties" commit.
import { box, checkField, coordField, errorMessage, fmtLen, fmtLenU, form, h, openDialog, parseLen, selectField, unitLabel, unitName, type Field } from "./ui";
import * as M from "./track-via-model";
import { setNet } from "./item-props";

const K = (): KiCadCanvasApi => KiCadCanvas;
const parse: M.Parse = (t) => K().parse(t) as SNode;
/** include/widgets/ui_common.h */
export const INDETERMINATE_STATE = "-- mixed values --";
interface PropsHelpers { netNameOf(doc: KDoc, node: SNode): string; boardNetNames(doc: KDoc): string[] }
const PH = (): PropsHelpers => (CollabTools as unknown as { props: { helpers: PropsHelpers } }).props.helpers;
const PT = (): { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode } => (window as unknown as { PcbTools: { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode } }).PcbTools;
const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/** The value every item shares, or undefined when they differ. */
export function common<T>(values: T[], eq: (a: T, b: T) => boolean = (a, b) => a === b): T | undefined {
  if (!values.length) return undefined; const v = values[0]; return values.every((x) => eq(x, v)) ? v : undefined;
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------- controls with an indeterminate state
/** UNIT_BINDER over several items: get() is undefined while it still shows INDETERMINATE_STATE, null when empty. */
interface MixLen { el: HTMLInputElement; input: HTMLInputElement; get(): number | null | undefined; set(v: number | null | undefined): void; enable(on: boolean): void }
function mixLen(v: number | null | undefined, key: string, opts?: { coord?: "x" | "y"; unitless?: boolean; digits?: number }): MixLen {
  if (opts && opts.coord) {
    const f = coordField(typeof v === "number" ? v : 0, opts.coord, { key });
    const input = f.input as HTMLInputElement; if (v === undefined) input.value = INDETERMINATE_STATE;
    return { el: input, input, get: () => (input.value === INDETERMINATE_STATE ? undefined : f.get()), set: (x) => { if (x === undefined) input.value = INDETERMINATE_STATE; else f.set(x ?? 0); }, enable: (on) => { input.disabled = !on; } };
  }
  const show = (x: number | null | undefined): string => (x === undefined ? INDETERMINATE_STATE : x === null ? "" : opts && opts.unitless ? String(+x.toFixed(opts.digits ?? 4)) : fmtLen(x));
  let cur = v;
  const input = h("input", { type: "text", value: show(v), "data-k": key });
  input.addEventListener("focus", () => { if (input.value === INDETERMINATE_STATE) input.select(); });
  input.addEventListener("change", () => {
    const t = input.value.trim(); if (t === INDETERMINATE_STATE) return;
    if (!t) { cur = null; return; }
    const x = opts && opts.unitless ? Number(t.replace(",", ".")) : parseLen(t);
    if (isNaN(x)) { input.value = show(cur); return; }
    cur = x; input.value = show(x);
  });
  return { el: input, input, enable: (on) => { input.disabled = !on; },
    get: () => { const t = input.value.trim(); if (t === INDETERMINATE_STATE) return undefined; if (!t) return null; if (input.value === show(cur) && typeof cur === "number") return cur; const x = opts && opts.unitless ? Number(t.replace(",", ".")) : parseLen(t); return isNaN(x) ? (cur ?? null) : x; },
    set: (x) => { cur = x; input.value = show(x); } };
}
/** wxCHK_3STATE | wxCHK_ALLOW_3RD_STATE_FOR_USER: get() is undefined in the third state. */
interface Tri { el: HTMLElement; input: HTMLInputElement; get(): boolean | undefined; set(v: boolean | undefined): void; enable(on: boolean): void }
function tri(v: boolean | undefined, label: string, key: string, title?: string, onChange?: (v: boolean | undefined) => void): Tri {
  const input = h("input", { type: "checkbox", "data-k": key }) as HTMLInputElement;
  const allow3 = v === undefined;   // the third state is offered where the items disagree
  const set = (x: boolean | undefined): void => { input.indeterminate = x === undefined; input.checked = !!x; };
  set(v);
  input.addEventListener("click", () => {
    // unchecked -> checked -> (third state) -> unchecked
    if (allow3 && !input.checked && !input.indeterminate) { const was = input.dataset.was; if (was === "1") { input.indeterminate = true; input.checked = false; } }
    input.dataset.was = input.indeterminate ? "u" : input.checked ? "1" : "0";
    if (onChange) onChange(input.indeterminate ? undefined : input.checked);
  });
  input.dataset.was = v === undefined ? "u" : v ? "1" : "0";
  const el = h("label", { class: "pd-check", title }, input, label);
  return { el, input, get: () => (input.indeterminate ? undefined : input.checked), set, enable: (on) => { input.disabled = !on; el.classList.toggle("disabled", !on); } };
}
/** A choice that may show INDETERMINATE_STATE (wxNOT_FOUND / an appended "-- mixed values --"). */
function mixChoice<T extends string | number>(v: T | undefined, options: [T, string][], key: string, onChange?: (v: T | undefined) => void): Field<T | undefined> & { enable(on: boolean): void } {
  const MIX = "__mixed__";
  const opts: [string, string][] = options.map(([o, l]) => [String(o), l]);
  if (v === undefined) opts.push([MIX, INDETERMINATE_STATE]);
  const f = selectField<string>(v === undefined ? MIX : String(v), opts, { key, onChange: onChange ? (s) => onChange(s === MIX ? undefined : options.find((o) => String(o[0]) === s)![0]) : undefined });
  const get = (): T | undefined => { const s = f.get(); if (s === MIX) return undefined; const o = options.find((x) => String(x[0]) === s); return o ? o[0] : undefined; };
  return { el: f.el, input: f.input, get, set: (x) => f.set(x === undefined ? MIX : String(x)), enable: (on) => { (f.input as HTMLElement).toggleAttribute("disabled", !on); } };
}
const disable = (el: Element, on: boolean): void => { el.classList.toggle("pd-dim", !on); };
/** form() with element labels (labels that dim with their control). */
function lgrid(rows: [HTMLElement, HTMLElement, HTMLElement?][]): HTMLElement {
  const f = h("div", { class: "pd-form wide" });
  for (const [l, c, u] of rows) f.append(l, c, u || h("span"));
  return f;
}

// ---------------------------------------------------------------- the dialog
const VIA_TYPES: [string, string][] = [["through", "Through"], ["micro", "Micro"], ["blind", "Blind"], ["buried", "Buried"]];
const viaType = (n: SNode): string => (typeof n[1] === "string" && ["blind", "buried", "micro"].includes(String(n[1])) ? String(n[1]) : "through");
const viaLayers = (n: SNode, doc: KDoc): [string, string] => { const ls = M.kid(n, "layers"); return [ls && ls[1] !== undefined ? String(ls[1]) : doc.copper[0] || "F.Cu", ls && ls[2] !== undefined ? String(ls[2]) : doc.copper[doc.copper.length - 1] || "B.Cu"]; };
const isTrack = (it: KItem): boolean => (it.kind === "segment" || it.kind === "arc") && !!M.kid(it.node, "width");

/** SELECTION_CONDITIONS::OnlyTypes( GENERAL_COLLECTOR::Tracks ): a selection EDIT_TOOL::Properties gives this dialog. */
export const tracksOnly = (items: KItem[]): boolean => items.length > 0 && items.every((i) => i.kind === "via" || isTrack(i));
/** Track & Via Properties over the items (tracks, arcs and vias); false when none of them is one. */
export function trackViaDialog(ctx: ToolCtx, items: KItem[]): boolean {
  const doc = ctx.doc as KDoc | null; if (!doc) return false;
  const tracks = items.filter(isTrack), vias = items.filter((i) => i.kind === "via");
  if (!tracks.length && !vias.length) return false;
  const all = [...tracks, ...vias], ro = !!ctx.viewOnly;
  const copper = doc.copper.slice(), F = copper[0] || "F.Cu", B = copper[copper.length - 1] || "B.Cu";
  const layerOpts = (extra?: [string, string]): [string, string][] => [...(extra ? [extra] : []), ...copper.map((n): [string, string] => [n, layerLabel(doc, n)])];
  const sizes = K().pcbSizes && K().pcbSizes.state ? K().pcbSizes.state.sizes : { trackWidths: [0], vias: [{ diameter: 0, drill: 0 }] };
  let api: ReturnType<typeof openDialog> = null;
  const fields: Record<string, { input: HTMLElement }> = {};
  let applyItems: (n: SNode, it: KItem) => void = () => undefined;
  let apply: () => M.Backdrill | string | { msg: string; focus?: { input: HTMLElement } } | void = () => undefined;

  api = openDialog({ title: "Track & Via Properties", width: 800, readOnly: ro,
    build(body) {
      body.style.maxHeight = "86vh"; body.style.overflow = "auto";
      // ---- Common
      const netNames = PH().boardNetNames(doc).filter((n) => n);
      const net0 = common(all.map((i) => PH().netNameOf(doc, i.node)));
      const net = mixChoice<string>(net0, [["", "<no net>"], ...netNames.map((n): [string, string] => [n, n]), ...(net0 && !netNames.includes(net0) ? [[net0, net0] as [string, string]] : [])], "net",
        () => { if (vias.length) notFree.set(false); });   // onNetSelector: a picked net is not updated automatically any more
      const free0 = common(vias.map((v) => !M.kid(v.node, "free") || String((M.kid(v.node, "free") as SNode)[1]) === "no"));
      const notFree = tri(free0, "Automatically update via nets", "viaNotFree", "Automatically change the net of this via when the pads or zones it touches are changed",
        (v) => { if (!tracks.length) { (net.input as HTMLElement).toggleAttribute("disabled", !!v); netLabel.classList.toggle("pd-dim", !!v); } });
      const lockedVals = all.map((i) => PT().isLocked(i.node));
      const locked = tri(common(lockedVals), "Locked", "locked");
      const netLabel = h("label", null, "Net:");
      if (vias.length && !tracks.length && free0) { (net.input as HTMLElement).setAttribute("disabled", ""); netLabel.classList.add("pd-dim"); }
      body.append(box("Common", h("div", { class: "pd-row", style: "justify-content:space-between" }, h("span", { class: "pd-inline" }, netLabel, net.el), vias.length ? notFree.el : null),
        h("hr", { style: "border:none;border-top:1px solid var(--line);margin:4px 0" }), locked.el));
      fields.net = net;

      // ---- Tracks
      let trackApply: (n: SNode) => void = () => undefined;
      let trackWidth: MixLen | null = null;
      if (tracks.length) {
        const st = (k: "start" | "end", i: 1 | 2): (number | undefined) => common(tracks.map((t) => { const p = M.kid(t.node, k); return p ? +p[i] : 0; }), near);
        const sx = mixLen(st("start", 1), "sx", { coord: "x" }), sy = mixLen(st("start", 2), "sy", { coord: "y" }), ex = mixLen(st("end", 1), "ex", { coord: "x" }), ey = mixLen(st("end", 2), "ey", { coord: "y" });
        if (tracks.some((t) => t.kind === "arc")) for (const f of [sx, sy, ex, ey]) f.enable(false);
        const w0 = common(tracks.map((t) => { const w = M.kid(t.node, "width"); return w ? +w[1] : 0; }), near);
        const width = mixLen(w0, "width"); trackWidth = width; fields.width = width;
        const tw = sizes.trackWidths.slice(1);
        const predef = selectField<string>(w0 !== undefined ? String(tw.findIndex((w) => near(w, w0))) : "-1", [["-1", ""], ...tw.map((w, i): [string, string] => [String(i), fmtLen(w)])], { key: "predefTrack",
          onChange: (s) => { const i = +s; if (i >= 0) { width.set(tw[i]); width.input.focus(); width.input.select(); } } });
        width.input.addEventListener("input", () => { const v = width.get(); const i = typeof v === "number" ? tw.findIndex((w) => near(w, v)) : -1; predef.set(String(i)); });   // onWidthEdit
        const l0 = common(tracks.map((t) => M.trackLayer(t.node)));
        const layer = mixChoice<string>(l0, layerOpts(), "layer", () => onTrackEdit());
        const mask = tri(common(tracks.map((t) => M.trackHasMask(t.node))), "Solder mask", "trackMask", undefined, () => onTrackEdit());
        const mm0 = common(tracks.map((t) => M.trackMaskMargin(t.node)), (a, b) => a === b || (a !== null && b !== null && near(a, b)));
        const margin = mixLen(mm0 === undefined ? undefined : mm0, "maskMargin");
        margin.input.style.width = "90px";
        margin.input.title = "This is the local clearance between the track and the solder mask opening.\nLeave blank to use the value defined in the Board Setup.";
        const techLabel = h("span", { class: "pd-note", style: "margin:0" }, "Technical Layers"), marginLabel = h("label", null, "Expansion:"), marginUnit = unitLabel();
        // onTrackEdit: the solder mask is only for the outer copper layers
        const onTrackEdit = (): void => {
          const l = layer.get(), external = l === F || l === B;
          mask.enable(external && !ro); disable(techLabel, external);
          const show = external && mask.get() === true;
          margin.enable(show && !ro); disable(marginLabel, show); disable(marginUnit, show);
        };
        const xy = (lx: string, x: MixLen, y: MixLen): [string, HTMLElement, HTMLElement] => [lx, h("span", { class: "pd-xy" }, x.el, h("label", null, "Y:"), y.el), unitLabel()];
        body.append(box("Tracks", h("div", { class: "pd-cols2" },
          form([xy("Start X:", sx, sy), xy("End X:", ex, ey), ["Pre-defined sizes:", predef.el, unitLabel()], ["Track width:", width.el, unitLabel()]], true),
          h("div", null, form([["Layer:", layer.el]], true),
            h("div", { class: "pd-row", style: "margin-top:10px;gap:6px" }, techLabel, h("span", { style: "flex:1;border-top:1px solid var(--line)" })),
            h("div", { class: "pd-row", style: "flex-wrap:nowrap" }, mask.el, marginLabel, margin.el, marginUnit)))));
        onTrackEdit();
        trackApply = (n) => {
          const isArc = n[0] === "arc";
          const setPt = (k: "start" | "end", x: MixLen, y: MixLen): void => { if (isArc) return; const p = M.kid(n, k); if (!p) return; const nx = x.get(), ny = y.get(); const vx = typeof nx === "number" ? nx : +p[1], vy = typeof ny === "number" ? ny : +p[2]; if (!near(vx, +p[1]) || !near(vy, +p[2])) M.setChild(n, k, `(${k} ${M.f6(vx)} ${M.f6(vy)})`, M.TRACK_ORDER, parse); };
          setPt("start", sx, sy); setPt("end", ex, ey);
          const w = width.get(); if (typeof w === "number" && !near(w, +(M.kid(n, "width") || [0, 0])[1])) M.setChild(n, "width", `(width ${M.f6(w)})`, M.TRACK_ORDER, parse);
          const l = layer.get() ?? M.trackLayer(n), mk = mask.get() ?? M.trackHasMask(n);
          const mg = margin.get(); const m = mg === undefined ? M.trackMaskMargin(n) : mg;
          M.setTrackLayerAndMask(n, l, mk, m, parse);
        };
      }

      // ---- Vias
      let viaApply: (n: SNode) => void = () => undefined;
      let viaCheck: () => { msg: string; focus?: { input: HTMLElement } } | null = () => null;
      if (vias.length) {
        const first = vias[0].node;
        const pos = (i: 1 | 2): number | undefined => common(vias.map((v) => +(M.kid(v.node, "at") || [0, 0, 0])[i]), near);
        const vx = mixLen(pos(1), "x", { coord: "x" }), vy = mixLen(pos(2), "y", { coord: "y" });
        // the padstack of the first via is the one the mode / edit layer controls edit (m_viaStack)
        const stack = M.padstack(first); let stackDirty = false;
        let editLayer = "all";
        const dia0 = common(vias.map((v) => M.padstackSize(M.padstack(v.node), "F.Cu")), near);
        const dia = mixLen(dia0, "size"), drill = mixLen(common(vias.map((v) => +(M.kid(v.node, "drill") || [0, 0])[1]), near), "drill");
        fields.size = dia; fields.drill = drill;
        const vd = sizes.vias.slice(1);
        const predefVia = selectField<string>(String(vd.findIndex((v) => dia0 !== undefined && near(v.diameter, dia0) && near(v.drill, +((M.kid(first, "drill") || [0, 0])[1])))),
          [["-1", ""], ...vd.map((v, i): [string, string] => [String(i), `${fmtLen(v.diameter)} / ${fmtLen(v.drill)}`])], { key: "predefVia",
            onChange: (s) => { const i = +s; if (i >= 0) { dia.set(vd[i].diameter); drill.set(vd[i].drill); } } });
        for (const f of [dia, drill]) f.input.addEventListener("input", () => predefVia.set("-1"));   // onViaEdit
        const modeSel = selectField<string>(stack.mode, [["normal", "Normal"], ["front_inner_back", "Front/Inner/Back"], ["custom", "Custom"]], { key: "padstackMode", onChange: (m) => { syncDia(); stack.mode = m as M.PadstackMode; stackDirty = true; afterMode(); } });
        const editSel = h("k-select", { "data-k": "editLayer" }) as HTMLSelectElement;
        /** onEditLayerChanged: the shown diameter goes into the stack before the new layer's is shown. */
        const syncDia = (): void => { const d = dia.get(); if (typeof d === "number") { const key = editLayer === "all" ? "F.Cu" : editLayer; if (!near(M.padstackSize(stack, key), d)) { stack.sizes[key] = d; stackDirty = true; } } };
        const afterMode = (): void => {
          const choices: [string, string][] = stack.mode === "normal" ? [["all", "All layers"]] : stack.mode === "front_inner_back" ? [["F.Cu", layerLabel(doc, F)], ["Inner", "Inner Layers"], ["B.Cu", layerLabel(doc, B)]] : copper.map((l): [string, string] => [l, layerLabel(doc, l)]);
          if (stack.mode === "normal") editLayer = "all";
          else if (stack.mode === "front_inner_back" && editLayer !== "F.Cu" && editLayer !== "B.Cu") editLayer = "Inner";
          else if (stack.mode === "custom" && !copper.includes(editLayer)) editLayer = "F.Cu";
          editSel.replaceChildren(...choices.map(([v, l]) => h("option", { value: v }, l)));
          editSel.value = editLayer; editSel.toggleAttribute("disabled", stack.mode === "normal" || ro);
        };
        editSel.addEventListener("change", () => { syncDia(); editLayer = editSel.value; dia.set(M.padstackSize(stack, editLayer === "all" ? "F.Cu" : editLayer)); });
        afterMode();
        const t0 = common(vias.map((v) => viaType(v.node)));
        const lay = vias.map((v) => viaLayers(v.node, doc));
        const s0 = common(lay.map((l) => l[0])), e0 = common(lay.map((l) => l[1]));
        const vtype = mixChoice<string>(t0, VIA_TYPES, "viaType", () => onViaEdit());
        const l0 = mixChoice<string>(s0, layerOpts(), "startLayer", () => onViaEdit()), l1 = mixChoice<string>(e0, layerOpts(), "endLayer", () => onViaEdit());
        const ringLabel = h("label", null, "Annular rings:"), ringPad = h("span");
        const ring = mixChoice<number>(common(vias.map((v) => M.annularMode(v.node))), [[0, "All copper layers"], [1, "Start, end, and connected layers"], [2, "Connected layers only"], [3, "Start and end layers only"]], "annularRings");
        const prot0 = common(vias.map((v) => M.protectionPreset(v.node)));
        const protOpts: [number, string][] = M.IPC4761.map(([name], i): [number, string] => [i, name]);
        if (prot0 === M.IPC4761_CUSTOM) protOpts.push([M.IPC4761_CUSTOM, "-- leave unchanged --"]);   // INDETERMINATE_ACTION for a custom feature list
        const prot = mixChoice<number>(prot0, protOpts, "protection");
        for (const c of [prot.el, ring.el]) { c.style.width = "100%"; c.style.minWidth = "0"; }
        prot.input.title = "Select which protection feature according to IPC-4761 the via should have.";
        // backdrill
        const bds = vias.map((v) => M.backdrills(v.node));
        const bdMode = mixChoice<number>(common(vias.map((v) => M.backdrillMode(v.node))), [[0, "None"], [1, "Bottom"], [2, "Top"], [3, "Both"]], "backdrill", () => syncBackdrill(true));
        const bfSize = mixLen(common(bds.map((b) => (b.front ? b.front.size : null)), (a, b) => a === b || (a !== null && b !== null && near(a, b))), "backdrillFrontSize");
        const bbSize = mixLen(common(bds.map((b) => (b.back ? b.back.size : null)), (a, b) => a === b || (a !== null && b !== null && near(a, b))), "backdrillBackSize");
        const bfL = common(bds.map((b) => (b.front ? b.front.end : ""))), bbL = common(bds.map((b) => (b.back ? b.back.end : "")));
        const bfLayer = mixChoice<string>(bfL, layerOpts(["", "None"]), "backdrillFrontLayer"), bbLayer = mixChoice<string>(bbL, layerOpts(["", "None"]), "backdrillBackLayer");
        bbLayer.input.title = "The backdrill must pass through this layer";
        const bfLabels = [h("label", null, "Front backdrill size:"), h("label", null, "Front backdrill must-cut:")], bbLabels = [h("label", null, "Back backdrill size:"), h("label", null, "Back backdrill must-cut:")];
        const bdLabel = h("label", null, "Backdrill:");
        /** syncBackdrillControls: a side switched on starts on its outer layer, 1.1 × the hole. */
        const syncBackdrill = (user: boolean): void => {
          const m = bdMode.get(), top = m === 2 || m === 3, bottom = m === 1 || m === 3;
          bfSize.enable(top && !ro); bfLayer.enable(top && !ro); bfLabels.forEach((l) => disable(l, top));
          bbSize.enable(bottom && !ro); bbLayer.enable(bottom && !ro); bbLabels.forEach((l) => disable(l, bottom));
          if (!user) return;
          const d = drill.get(), auto = typeof d === "number" ? Math.round(d * 1.1 * 1e6) / 1e6 : 0;
          if (top) { if (!bfLayer.get()) bfLayer.set(F); const s = bfSize.get(); if (!s) bfSize.set(auto); }
          if (bottom) { if (!bbLayer.get()) bbLayer.set(B); const s = bbSize.get(); if (!s) bbSize.set(auto); }
        };
        // post-machining
        const pmCtl = (front: boolean) => {
          const pms = vias.map((v) => M.postMachining(v.node, front));
          const mode = mixChoice<string>(common(pms.map((p) => p.mode)), [["none", "None"], ["countersink", "Countersink"], ["counterbore", "Counterbore"]], front ? "topPostMachine" : "bottomPostMachine", () => sync(true));
          const m0 = common(pms.map((p) => p.mode));
          const size = mixLen(m0 === "none" ? null : common(pms.map((p) => p.size), near), front ? "topPostSize" : "bottomPostSize");
          const second0 = m0 === "countersink" ? common(pms.map((p) => p.angle), near) : m0 === "counterbore" ? common(pms.map((p) => p.depth), near) : null;
          const second = mixLen(second0, front ? "topPostSecond" : "bottomPostSecond", { unitless: m0 === "countersink", digits: 1 });
          const label = h("label", null, front ? "Front:" : "Back:"), sizeLabel = h("label", null, "Size:"), secondLabel = h("label", null, "Angle:"), secondUnit = unitLabel("deg");
          let isAngle = m0 !== "counterbore";
          /** syncPostMachineControls: Depth in the user units for a counterbore, Angle in degrees (82 to start) for a countersink. */
          const sync = (user: boolean): void => {
            const m = mode.get(), on = m !== "none";
            size.enable(on && !ro); second.enable(on && !ro); disable(sizeLabel, on); disable(secondLabel, on);
            const wasAngle = isAngle;
            if (m === "counterbore") { secondLabel.textContent = "Depth:"; secondUnit.textContent = unitName(); isAngle = false; if (wasAngle && user) second.set(null); }
            else { secondLabel.textContent = "Angle:"; secondUnit.textContent = "deg"; isAngle = true; }
            if (user && m === "countersink") { const v = second.get(); if (!wasAngle || v === undefined || !v) second.set(82); }
            if (isAngle !== wasAngle) { const v = second.get(); second.set(v); }
          };
          const get = (cur: M.PostMachining): M.PostMachining | null => {
            const m = mode.get(); if (m === undefined) return null;
            const out: M.PostMachining = { ...cur, mode: m as M.PostMachining["mode"] };
            const s = size.get(); if (s !== undefined) out.size = s || 0;
            const v = second.get(); if (v !== undefined) { if (m === "countersink") { out.angle = v || 0; } else out.depth = v || 0; }
            return out;
          };
          // a countersink's angle is a plain number of degrees, not a length
          const parseAngle = (): void => { if (!isAngle) return; const t = second.input.value.trim(); const x = Number(t.replace(",", ".")); if (t && !isNaN(x) && t !== INDETERMINATE_STATE) second.set(x); };
          second.input.addEventListener("change", parseAngle, true);
          return { mode, size, second, label, sizeLabel, secondLabel, secondUnit, sync, get, isAngle: () => isAngle };
        };
        const pmF = pmCtl(true), pmB = pmCtl(false);
        /** viaSpan / updateViaMachiningControls: backdrills need a through via, a cut needs the outer surface the via reaches. */
        const onViaEdit = (): void => {
          const t = vtype.get(), thru = t === "through" || t === undefined;
          if (t === "through") { l0.set(F); l1.set(B); }
          l0.enable(!thru && !ro); l1.enable(!thru && !ro);
          const a = l0.get(), b = l1.get();
          const ia = a ? copper.indexOf(a) : 0, ib = b ? copper.indexOf(b) : copper.length - 1;
          const top = Math.min(ia, ib), bot = Math.max(ia, ib), reachF = thru || top === 0, reachB = thru || bot === copper.length - 1;
          if ((t === "blind" || t === "buried") && a && b) { if (reachF !== reachB) vtype.set("blind"); else if (!reachF && !reachB) vtype.set("buried"); }
          const depth = thru ? copper.length - 1 : bot - top;
          ring.el.style.display = ringLabel.style.display = ringPad.style.display = depth > 1 ? "" : "none";
          syncBackdrill(false); pmF.sync(false); pmB.sync(false);
          bdMode.enable(thru && !ro); disable(bdLabel, thru);
          if (!thru) { bfSize.enable(false); bbSize.enable(false); bfLayer.enable(false); bbLayer.enable(false); [...bfLabels, ...bbLabels].forEach((l) => disable(l, false)); }
          for (const [pm, reaches] of [[pmF, reachF], [pmB, reachB]] as const) {
            pm.mode.enable(reaches && !ro); disable(pm.label, reaches);
            if (!reaches) { pm.size.enable(false); pm.second.enable(false); disable(pm.sizeLabel, false); disable(pm.secondLabel, false); }
          }
        };
        // teardrops
        const tds = vias.map((v) => M.teardrops(v.node));
        const tc = <K extends keyof M.Teardrops>(k: K): M.Teardrops[K] | undefined => common(tds.map((t) => t[k]), (a, b) => (typeof a === "number" ? near(a as number, b as number) : a === b)) as M.Teardrops[K] | undefined;
        const tdOn = tri(tc("enabled"), "Add teardrops on via's track connections", "teardrops"), tdTwo = tri(tc("allowTwo"), "Allow teardrops to span two track segments", "teardropsTwo",
          "Allows a teardrop to extend over the first 2 connected track segments if the first track segment is too short to accommodate the best length.");
        const pct = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * 100);
        const hd = mixLen(pct(tc("filter")), "tdMaxTrackWidth", { unitless: true }), lenP = mixLen(pct(tc("bestLength")), "tdBestLength", { unitless: true }), widP = mixLen(pct(tc("bestWidth")), "tdBestWidth", { unitless: true });
        const maxL = mixLen(tc("maxLen"), "tdMaxLength"), maxW = mixLen(tc("maxWidth"), "tdMaxWidth");
        hd.input.title = "Max pad/via size to track width ratio to create a teardrop.\n100 always creates a teardrop.";
        const curved = tri(tc("curved"), "Curved edges", "tdCurved");
        const legacy = !!(doc as unknown as { legacyTeardrops?: boolean }).legacyTeardrops;
        if (legacy || ro) for (const c of [tdOn, tdTwo, curved]) c.enable(false);
        if (legacy || ro) for (const c of [hd, lenP, widP, maxL, maxW]) c.enable(false);
        const xy = (lx: string, x: MixLen, y: MixLen): [string, HTMLElement, HTMLElement] => [lx, h("span", { class: "pd-xy" }, x.el, h("label", null, "Y:"), y.el), unitLabel()];
        const section = (title: string): HTMLElement => h("div", { class: "pd-row", style: "margin:10px 0 4px;gap:6px" }, h("span", { class: "pd-note", style: "margin:0" }, title), h("span", { style: "flex:1;border-top:1px solid var(--line)" }));
        const pmRow = (pm: ReturnType<typeof pmCtl>): HTMLElement => h("div", { class: "pd-row" }, pm.label, pm.mode.el, pm.sizeLabel, pm.size.el, unitLabel(), pm.secondLabel, pm.second.el, pm.secondUnit);
        const left = h("div", null, form([xy("Position X:", vx, vy), ["Pre-defined sizes:", predefVia.el, unitLabel()],
          // m_sbPadstackSettings: one horizontal row spanning the grid
          h("div", { class: "pd-row", style: "flex-wrap:nowrap;gap:6px;margin:0" }, h("label", { style: "white-space:nowrap" }, "Padstack mode:"), modeSel.el, h("label", { style: "white-space:nowrap" }, "Edit layer:"), editSel),
          ["Via diameter:", dia.el, unitLabel()], ["Via hole:", drill.el, unitLabel()]], true));
        const ringForm = form([["Via type:", vtype.el], ["Start layer:", l0.el], ["End layer:", l1.el]], true);
        ringForm.style.gridTemplateColumns = "max-content minmax(0, 1fr) max-content";
        ringForm.append(ringLabel, ring.el, ringPad, h("label", null, "Protection features:"), prot.el, h("span"));
        // the choices fill their grid cell (wxEXPAND in gbSizer4) instead of shrinking to their arrow
        for (const c of [vtype.el, l0.el, l1.el]) { c.style.width = "100%"; c.style.minWidth = "0"; }
        modeSel.el.style.flex = "0 1 auto"; editSel.style.flex = "0 0 auto"; editSel.style.minWidth = "104px";
        const viaBox = box("Vias", h("div", { class: "pd-cols2" }, left, ringForm),
          section("Backdrill"),
          h("div", { class: "pd-row" }, bdLabel, bdMode.el),
          h("div", { class: "pd-cols2" }, lgrid([[bfLabels[0], bfSize.el, unitLabel()], [bfLabels[1], bfLayer.el]]), lgrid([[bbLabels[0], bbSize.el, unitLabel()], [bbLabels[1], bbLayer.el]])),
          section("Hole Post-machining"), pmRow(pmF), pmRow(pmB),
          h("hr", { style: "border:none;border-top:1px solid var(--line);margin:8px 0" }),
          legacy ? h("div", { class: "pd-info" }, "Board contains legacy teardrops.", h("br"), "Use Edit > Edit Teardrops to apply automatic teardrops.") : null,
          h("div", { class: "pd-cols2" },
            h("div", null, tdOn.el, tdTwo.el, h("div", { class: "pd-row" }, h("label", null, "Maximum track width:"), hd.el, h("span", { class: "unit" }, "%")),
              h("p", { class: "pd-note", style: "font-style:italic" }, "(as a percentage of pad/via/track size)")),
            h("div", null, form([["Best length (L):", lenP.el, h("span", { class: "unit" }, "%( d )")], ["Maximum length (L):", maxL.el, unitLabel()],
              ["Best width (W):", widP.el, h("span", { class: "unit" }, "%( d )")], ["Maximum width (W):", maxW.el, unitLabel()]], true), curved.el)));
        body.append(viaBox);
        onViaEdit();
        viaCheck = () => {
          syncDia();
          // PCB_VIA::ValidateViaParameters
          const d = dia.get(), dr = drill.get();
          const minSize = 0.001;
          if (typeof d === "number" && d < minSize) return { msg: "Via diameter is too small.", focus: dia };
          if (typeof dr === "number" && dr < minSize) return { msg: "Via drill is too small.", focus: drill };
          if (typeof d === "number" && dr === null) return { msg: "No via hole size defined.", focus: drill };
          if (typeof dr === "number" && d === null) return { msg: "No via diameter defined.", focus: dia };
          if (typeof d === "number" && typeof dr === "number" && d <= dr) return { msg: "Via hole size must be smaller than via diameter", focus: drill };
          const a = l0.get(), b = l1.get();
          if (a && b && a === b) return { msg: "Via start layer and end layer cannot be the same", focus: l0 };
          const m = bdMode.get();
          if (m === 2 || m === 3) { const s = bfSize.get(); if (typeof s === "number" && typeof dr === "number" && s < dr) return { msg: "Backdrill diameter is too small.", focus: bfSize }; }
          if (m === 1 || m === 3) { const s = bbSize.get(); if (typeof s === "number" && typeof dr === "number" && s < dr) return { msg: "Tertiary backdrill diameter is too small.", focus: bbSize }; }
          return null;
        };
        viaApply = (n) => {
          const at = M.kid(n, "at"); const px = vx.get(), py = vy.get();
          if (at) { const nx = typeof px === "number" ? px : +at[1], ny = typeof py === "number" ? py : +at[2]; if (!near(nx, +at[1]) || !near(ny, +at[2])) K().setAt(n, +M.f6(nx), +M.f6(ny)); }
          const nf = notFree.get(); if (nf !== undefined) M.setChild(n, "free", nf ? null : "(free yes)", M.VIA_ORDER, parse);
          // the padstack: a mode change replaces each via's stack with the edited one, else only the shown diameter
          const own = M.padstack(n);
          if (stackDirty) M.setPadstack(n, { mode: stack.mode, sizes: { ...stack.sizes } }, copper, parse);
          else { const d = dia.get(); if (typeof d === "number") { const key = editLayer === "all" ? "F.Cu" : editLayer; if (!near(M.padstackSize(own, key), d)) { own.sizes[key] = d; M.setPadstack(n, own, copper, parse); } } }
          const dr = drill.get(); if (typeof dr === "number" && !near(dr, +(M.kid(n, "drill") || [0, 0])[1])) M.setChild(n, "drill", `(drill ${M.f6(dr)})`, M.VIA_ORDER, parse);
          // backdrill
          const cur = M.backdrills(n), m = bdMode.get();
          let front = cur.front, back = cur.back;
          const fs = bfSize.get(), bs = bbSize.get(), fl = bfLayer.get(), bl = bbLayer.get();
          const side = (was: M.Backdrill | null, s: number | null | undefined, l: string | undefined, dflt: string): M.Backdrill => ({ size: typeof s === "number" && s > 0 ? s : was ? was.size : 0, end: l ? l : l === "" ? "" : was ? was.end : dflt });
          if (m === 0) { front = null; back = null; }
          else if (m === 1) { front = null; back = side(cur.back, bs, bl, B); }
          else if (m === 2) { back = null; front = side(cur.front, fs, fl, F); }
          else if (m === 3) { front = side(cur.front, fs, fl, F); back = side(cur.back, bs, bl, B); }
          else { if (front && typeof fs === "number" && fs > 0) front = { ...front, size: fs }; if (back && typeof bs === "number" && bs > 0) back = { ...back, size: bs }; }
          M.setBackdrills(n, front && front.size > 0 && front.end ? front : null, back && back.size > 0 && back.end ? back : null, parse);
          for (const [pm, isFront] of [[pmF, true], [pmB, false]] as const) { const v = pm.get(M.postMachining(n, isFront)); if (v) M.setPostMachining(n, isFront, v, parse); }
          // type and layers
          const t = vtype.get();
          if (t !== undefined && t !== viaType(n)) { if (typeof n[1] === "string" && ["blind", "buried", "micro"].includes(String(n[1]))) n.splice(1, 1); if (t !== "through") n.splice(1, 0, t); }
          const [ca, cb] = viaLayers(n, doc), a = l0.get() ?? ca, b = l1.get() ?? cb;
          if (a !== ca || b !== cb || !M.kid(n, "layers")) M.setChild(n, "layers", `(layers ${quote(a)} ${quote(b)})`, M.VIA_ORDER, parse);
          const rm = ring.get(); if (rm !== undefined) M.setAnnularMode(n, rm, parse);
          // teardrops
          const td = M.teardrops(n), on = tdOn.get(), two = tdTwo.get(), cv = curved.get();
          if (on !== undefined) td.enabled = on; if (two !== undefined) td.allowTwo = two; if (cv !== undefined) td.curved = cv;
          const ml = maxL.get(), mw = maxW.get(), bl2 = lenP.get(), bw = widP.get(), fr = hd.get();
          if (typeof ml === "number") td.maxLen = ml; if (typeof mw === "number") td.maxWidth = mw;
          if (typeof bl2 === "number") td.bestLength = bl2 / 100; if (typeof bw === "number") td.bestWidth = bw / 100; if (typeof fr === "number") td.filter = fr / 100;
          M.setTeardrops(n, td, M.VIA_ORDER, parse);
          const pr = prot.get(); if (pr !== undefined) M.setProtectionPreset(n, pr, parse);
        };
      }

      apply = () => {
        const err = viaCheck(); if (err) return err;
        // m_trackWidth.Validate( GEOMETRY_MIN_SIZE, INT_MAX )
        if (trackWidth) { const w = trackWidth.get(); if (w === null || (typeof w === "number" && w < 0.001)) return { msg: `Track width must be at least ${fmtLenU(0.001)}.`, focus: trackWidth }; }
        return undefined;
      };
      applyItems = (n: SNode, it: KItem) => {
        if (isTrack(it)) trackApply(n); else viaApply(n);
        const nn = net.get(); if (nn !== undefined && nn !== PH().netNameOf(doc, n)) setNet(doc, n, nn);
        const lk = locked.get(); if (lk !== undefined && lk !== PT().isLocked(n)) { const r = PT().setLocked(n, lk); if (r && r !== n) n.splice(0, n.length, ...r); }
      };
      // SetInitialFocus: the track width, else the net, else the via diameter
      setTimeout(() => { const f = (trackWidth ? trackWidth.input : !(net.input as HTMLElement).hasAttribute("disabled") ? net.input : fields.size ? fields.size.input : null) as HTMLInputElement | null; if (f) { f.focus(); if (f.select) f.select(); } }, 0);
    },
    ok() {
      if (ro) return true;
      const err = apply();
      if (err && typeof err === "object" && "msg" in err) {
        const target = err.focus ? err.focus.input : null;
        errorMessage(err.msg, () => { if (target && document.contains(target)) { (target as HTMLElement).focus(); if (target instanceof HTMLInputElement && target.type === "text") target.select(); } });
        return false;
      }
      const changes: unknown[] = [];
      for (const it of all) {
        const staged = (K().cloneNode as (n: SNode) => SNode)(it.node), before = K().serialize(staged);
        applyItems(staged, it);
        if (K().serialize(staged) !== before) changes.push(K().replaceChange(doc, { ...it, node: staged, geom: [], bbox: null }));
      }
      if (changes.length) ctx.commit(changes as never[], "Edit Track/Via Properties");
      return true;
    } });
  return !!api;
}
