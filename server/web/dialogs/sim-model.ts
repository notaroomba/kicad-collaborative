// dialogs/sim-model.ts — DIALOG_SIM_MODEL (eeschema/dialogs/dialog_sim_model.cpp, dialog_sim_model_base.cpp): the
// "Simulation Model Editor" both Symbol Properties and Library Symbol Properties open with "Simulation Model...".
// It works on a copy of the parent dialog's staged field rows (never the document) and hands back the complete,
// merged row list (DIALOG_SYMBOL_PROPERTIES::OnEditSpiceModel), so the parent's OK still commits one change and
// collaboration / undo see an ordinary field edit.  window.KiCadSimModel.open(rows, ctx, done).
import { trapTab } from "../tools/kicad-dialogs/shell";
import * as S from "./sim-model-logic";
import { KD, h, popupMenu } from "./dom";
import type { NgspiceModelInfo } from "./sim-model-ngspice";

/** A project or embedded file the "Browse Models" picker offers: `path` is what Sim.Library stores. */
export interface SimFile { path: string; label?: string; load(): Promise<string | null> }
export interface SimModelCtx<R> {
  /** The symbol's reference prefix (GetPrefix: the Reference field's leading letters). */
  prefix: string;
  /** Every graphical pin of every unit (body style 1 only on a De Morgan symbol). */
  pins: S.SymbolPin[];
  unitCount: number;
  projectPath?: string;
  /** The project's SPICE model documents and the symbol's / schematic's embedded files. */
  files?: SimFile[];
  /** The inductors of the schematic (SPICE_CIRCUIT_MODEL items of device L), for the K l1 / l2 choices. */
  inductors?: string[];
  readOnly?: boolean;
  /** A new field row (SetFieldValue: a USER field, aIsVisible). */
  newRow(name: string, value: string, visible: boolean): R;
  clone?(row: R): R;
}

// ---------------------------------------------------------------- the ngspice tables (static/dist/sim-ngspice.js)
let ngLoad: Promise<void> | null = null;
/** KiCad's small_folder bitmap, drawn in the button's text colour (the menu icon pack does not carry it). */
function folderIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", "M1.5 3.5h4.5l1.5 1.5h7v8h-13z"); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.2"); p.setAttribute("stroke-linejoin", "round");
  svg.append(p); return svg;
}
export function loadNgspice(): Promise<void> {
  if (S.hasNgspiceData()) return Promise.resolve();
  const w = window as unknown as { KiCadSimNgspice?: Record<string, NgspiceModelInfo> };
  if (w.KiCadSimNgspice) { S.setNgspiceData(w.KiCadSimNgspice); return Promise.resolve(); }
  if (!ngLoad) ngLoad = new Promise<void>((resolve) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
    const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const sc = document.createElement("script"); sc.src = "/static/dist/sim-ngspice.js" + (query ? "?" + query : "");
    sc.onload = () => { if (w.KiCadSimNgspice) S.setNgspiceData(w.KiCadSimNgspice); resolve(); };
    sc.onerror = () => { ngLoad = null; resolve(); };
    document.head.appendChild(sc);
  });
  return ngLoad;
}

const CATEGORIES: [S.Category, string][] = [["GEOMETRY", "Geometry"], ["AC", "AC"], ["DC", "DC"], ["S_PARAM", "S-Parameters"], ["CAPACITANCE", "Capacitance"], ["TEMPERATURE", "Temperature"],
  ["NOISE", "Noise"], ["DISTRIBUTED_QUANTITIES", "Distributed Quantities"], ["WAVEFORM", "Waveform"], ["LIMITING_VALUES", "Limiting Values"], ["ADVANCED", "Advanced"], ["FLAGS", "Flags"]];
const TYPE_LABEL: Record<string, string> = { BOOL: "Bool", INT: "Int", FLOAT: "Float", COMPLEX: "Complex", STRING: "String", BOOL_VECTOR: "Bool Vector", INT_VECTOR: "Int Vector", FLOAT_VECTOR: "Float Vector", COMPLEX_VECTOR: "Complex Vector" };

/** A modal on top of the open dialog (the parent Symbol Properties stays open underneath, as a wxDialog child). */
function stacked(title: string, width: number): { ov: HTMLElement; dlg: HTMLElement; body: HTMLElement; foot: HTMLElement; close(): void } {
  const body = h("div", { class: "kd-body", style: "max-height:calc(100vh - 140px);overflow:auto" }), foot = h("div", { class: "kd-foot" });
  const x = h("span", { class: "kd-x", title: "Close (Esc)" }, "×");
  const tt = h("div", { class: "kd-title" }, h("span", null, title), x);
  const dlg = h("div", { class: "kd-dialog", style: `width:${width}px;max-width:calc(100vw - 32px);min-width:0`, tabindex: -1 }, tt, body, foot);
  const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:60" }, dlg);
  document.body.append(ov);
  let drag: [number, number] | null = null;
  tt.addEventListener("pointerdown", (ev) => { if (ev.target === x) return; const r = dlg.getBoundingClientRect(); drag = [ev.clientX - r.left, ev.clientY - r.top]; dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px"; tt.setPointerCapture(ev.pointerId); });
  tt.addEventListener("pointermove", (ev) => { if (drag) { dlg.style.left = Math.max(0, ev.clientX - drag[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - drag[1]) + "px"; } });
  tt.addEventListener("pointerup", () => { drag = null; });
  return { ov, dlg, body, foot, close: () => ov.remove() };
}

/** "Browse Models": the project's SPICE model files and the embedded files, in place of an OS file dialog. */
function browseModels(files: SimFile[], current: string): Promise<SimFile | null> {
  return new Promise((resolve) => {
    const d = stacked("Browse Models", 460); d.ov.style.zIndex = "70";
    const list = h("k-select", { size: 12, id: "kd-sim-browse-list", style: "width:100%;font-family:var(--mono);font-size:12px" }) as HTMLSelectElement;
    const sorted = files.slice().sort((a, b) => S.strNumCmp(a.path, b.path));
    for (const f of sorted) { const o = h("option", { value: f.path }, f.label || f.path) as HTMLOptionElement; if (f.path === current) o.selected = true; list.append(o); }
    if (!sorted.length) d.body.append(h("p", { class: "kd-note", style: "margin:2px 0 6px" }, "This project has no SPICE model files (*.lib, *.sub, *.cir, *.mod, *.spice or *.ibs). Add one to the project, then browse again."));
    d.body.append(h("div", { style: "margin-bottom:4px" }, "Simulation model files:"), list);
    const done = (f: SimFile | null) => { d.close(); resolve(f); };
    const pick = () => { const f = sorted.find((x) => x.path === list.value); if (f) done(f); };
    const cancel = h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), ok = h("button", { class: "btn primary", id: "kd-sim-browse-ok", onclick: pick }, "Open");
    d.foot.append(h("span", { class: "spacer" }), cancel, ok);
    list.addEventListener("dblclick", pick);
    d.ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, d.ov); if (ev.key === "Escape") { ev.preventDefault(); done(null); } else if (ev.key === "Enter") { ev.preventDefault(); pick(); } });
    (d.dlg.querySelector(".kd-x") as HTMLElement).addEventListener("click", () => done(null));
    list.focus();
  });
}

/** NUMERIC_EVALUATOR as SIM_STRING_PROPERTY uses it: arithmetic is evaluated and Normalize()d, plain values kept. */
function evalParam(text: string): string {
  if (!/[*/()]|.[+-]/.test(text.replace(/[eE][+-]/g, "e"))) return text;
  const expr = text.replace(/(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?\s*(Meg|[afpnumkKMGTPE])?/g, (_m, n: string, e: string | undefined, p: string | undefined) => {
    const v = S.toDouble(n + (e ? "e" + e : "") + (p === "Meg" ? "M" : p || "")); return "(" + String(v) + ")"; });
  if (!/^[\d\s.()+\-*/eE]+$/.test(expr)) return text;
  try { const v = Function(`"use strict"; return (${expr});`)() as number; if (typeof v !== "number" || !isFinite(v)) return text; return Math.abs(v - S.toDouble(text)) <= Number.EPSILON ? text : S.normalize(v); }
  catch (e) { return text; }
}

export function openSimModel<R extends S.FieldLike>(rows: R[], ctx: SimModelCtx<R>, done: (rows: R[]) => void): void {
  void loadNgspice().then(() => build(rows, ctx, done));
}

function build<R extends S.FieldLike>(rows0: R[], ctx: SimModelCtx<R>, done: (rows: R[]) => void): void {
  const clone = ctx.clone || ((r: R) => ({ ...r }));
  const ses = new S.SimSession<R>(rows0, { prefix: ctx.prefix, pins: ctx.pins, unitCount: ctx.unitCount }, (n, v, vis) => ctx.newRow(n, v, vis), clone);
  const files = ctx.files || [];
  const ro = !!ctx.readOnly;
  const d = stacked("Simulation Model Editor", 900); d.dlg.id = "kd-sim-dialog";
  // ---- the infobar (WX_INFOBAR with a close button)
  const infoText = h("span", { id: "kd-sim-info-text", style: "flex:1;white-space:pre-wrap" });
  const info = h("div", { id: "kd-sim-info", style: "display:none;align-items:flex-start;gap:8px;padding:6px 10px;margin:-4px -4px 8px;background:color-mix(in srgb, var(--warn) 18%, var(--panel));border:1px solid color-mix(in srgb, var(--warn) 45%, var(--line));border-radius:var(--r-1);font-size:12px;color:var(--ink)" },
    infoText, h("span", { class: "kd-x", style: "cursor:pointer", title: "Close", onclick: () => { info.style.display = "none"; } }, "×"));
  const showInfo = (msg: string) => { if (!msg) { info.style.display = "none"; return; } infoText.textContent = msg; info.style.display = "flex"; };
  d.body.append(info);

  // ---- Model page widgets
  const rbLib = h("input", { type: "radio", name: "kd-sim-src", id: "kd-sim-rb-lib", style: "width:auto;margin:0", disabled: ro }) as HTMLInputElement;
  const rbBuiltin = h("input", { type: "radio", name: "kd-sim-src", id: "kd-sim-rb-builtin", style: "width:auto;margin:0", disabled: ro }) as HTMLInputElement;
  const pathText = h("input", { type: "text", id: "kd-sim-file", style: "flex:1", disabled: ro }) as HTMLInputElement;
  const browseBtn = h("button", { type: "button", class: "btn", id: "kd-sim-browse", title: "Browse", style: "padding:2px 6px;display:inline-flex;align-items:center", disabled: ro }, folderIcon());
  const filter = h("input", { type: "text", id: "kd-sim-filter", placeholder: "Filter", style: "width:100%", disabled: ro }) as HTMLInputElement;
  const modelList = h("k-select", { size: 6, id: "kd-sim-models", style: "width:100%;font-size:12px", disabled: ro }) as HTMLSelectElement;
  // the IBIS rows (shown only when the library is an IBIS file)
  const ibisPinSel = h("k-select", { id: "kd-sim-ibis-pin", style: "width:100%", disabled: ro }) as HTMLSelectElement;
  const ibisDiffCb = h("input", { type: "checkbox", id: "kd-sim-ibis-diff", style: "width:auto;margin:0", disabled: ro }) as HTMLInputElement;
  const ibisDiffRow = h("label", { style: "display:flex;gap:6px;align-items:center" }, ibisDiffCb, "Differential");
  const ibisModelSel = h("k-select", { id: "kd-sim-ibis-model", style: "width:100%", disabled: ro }) as HTMLSelectElement;
  const waveformSel = h("k-select", { id: "kd-sim-waveform", style: "width:100%", disabled: ro }) as HTMLSelectElement;
  const deviceSel = h("k-select", { id: "kd-sim-device", disabled: ro }) as HTMLSelectElement;
  const typeSel = h("k-select", { id: "kd-sim-type", disabled: ro }) as HTMLSelectElement;
  const typeLabel = h("label", null, "Device type:");
  const saveCb = h("input", { type: "checkbox", id: "kd-sim-save-in-value", style: "width:auto;margin:0", disabled: ro }) as HTMLInputElement;
  const saveLabel = h("span", null, "");
  const paramWrap = h("div", { class: "kd-grid-wrap", style: "height:300px;overflow:auto" });
  const paramTable = h("table", { class: "kd-grid", id: "kd-sim-params", style: "width:100%;table-layout:fixed" }); paramWrap.append(paramTable);
  const code = h("textarea", { id: "kd-sim-code", spellcheck: false, readonly: true, style: "width:100%;height:300px;font-family:var(--mono);font-size:12px;white-space:pre;resize:vertical" }) as HTMLTextAreaElement;
  const libLabels: HTMLElement[] = []; const builtinLabels: HTMLElement[] = [];
  const lbl = (t: string, list: HTMLElement[]) => { const l = h("label", null, t); list.push(l); return l; };

  // ---- Pin Assignments page widgets
  const decompSel = h("k-select", { id: "kd-sim-decomposition", disabled: ro }, h("option", { value: "0" }, "Whole device"), h("option", { value: "1" }, "Repeat per unit")) as HTMLSelectElement;
  const sharedText = h("input", { type: "text", id: "kd-sim-shared", disabled: ro }) as HTMLInputElement;
  const pinWrap = h("div", { class: "kd-grid-wrap", style: "height:260px;overflow:auto" });
  const pinTable = h("table", { class: "kd-grid", id: "kd-sim-pins", style: "width:100%;table-layout:fixed" }); pinWrap.append(pinTable);
  const subcktLabel = h("div", { style: "font-size:11px;color:var(--ink-2);margin-top:8px", id: "kd-sim-subckt-label" }, "Reference");
  const subckt = h("pre", { id: "kd-sim-subckt", style: "margin:2px 0 0;height:150px;overflow:auto;background:var(--bench);border:1px solid var(--line);padding:4px 6px;font-family:var(--mono);font-size:12px" });

  let prevModel: S.SimModel | null = null;
  let modelNb: { select(i: number): void; index(): number } | null = null;
  const collapsed = new Set<string>();
  let rawCode: string | undefined;

  // ---------------------------------------------------------------- updateWidgets
  const fillSelect = (sel: HTMLSelectElement, items: string[], idx: number) => { sel.innerHTML = ""; items.forEach((t, i) => { const o = h("option", { value: String(i) }, t) as HTMLOptionElement; if (i === idx) o.selected = true; sel.append(o); }); if (idx < 0) sel.selectedIndex = -1; };
  const fillModelList = (names: string[]) => { modelList.innerHTML = ""; for (const n of names) { const o = h("option", { value: n }, n) as HTMLOptionElement; if (n === ses.modelName) o.selected = true; modelList.append(o); } if (!names.includes(ses.modelName)) modelList.selectedIndex = -1; };
  const updateWidgets = (): void => {
    const undetermined = ses.source === null, libOn = ses.source === "library" || undetermined, builtinOn = ses.source === "builtin" || undetermined;
    rbLib.checked = ses.source === "library"; rbBuiltin.checked = ses.source === "builtin";
    for (const e of [pathText, filter, modelList]) (e as HTMLInputElement).disabled = ro || !libOn;
    for (const e of [deviceSel, typeSel]) e.disabled = ro || !builtinOn;
    for (const l of libLabels) l.style.opacity = libOn ? "1" : ".5";
    for (const l of builtinLabels) l.style.opacity = builtinOn ? "1" : ".5";
    const m = ses.curModel();
    // updateBuiltinModelWidgets
    if (m !== prevModel) {
      if (ses.source !== "library") { const dc = ses.deviceChoices(); fillSelect(deviceSel, dc.items, dc.sel); const tc = ses.typeChoices(); fillSelect(typeSel, tc.items, tc.sel); }
      else { fillSelect(deviceSel, [], -1); fillSelect(typeSel, [], -1); }
      const show = typeSel.options.length > 1; typeSel.style.visibility = typeLabel.style.visibility = show ? "visible" : "hidden";
    }
    updateIbisWidgets(m);
    if (modelNb) modelNb.select(!m.fallback && m.cls === "rawspice" ? 1 : 0);
    const sv = ses.saveInValueLabel(); saveLabel.textContent = sv.label; saveCb.disabled = ro || !sv.enabled; if (!sv.enabled) ses.storeInValue = false; saveCb.checked = ses.storeInValue;
    if (m !== prevModel) buildParams(m); else refreshParams(m);
    updateCode(m);
    updatePins(m);
    prevModel = m;
  };

  // ---------------------------------------------------------------- updateIbisWidgets
  const ibisRows: HTMLElement[] = [];
  const modelLabel = lbl("Model:", libLabels);
  const updateIbisWidgets = (m: S.SimModel): void => {
    const on = ses.ibisLoaded() && ses.source === "library";
    for (const r of ibisRows) r.style.display = on ? "" : "none";
    modelLabel.textContent = ses.ibisLoaded() ? "Component:" : "Model:";
    filter.disabled = ro || ses.ibisLoaded() || !(ses.source === "library" || ses.source === null);
    if (!on || !m.ibis) return;
    fillSelect(ibisPinSel, ses.ibisPinLabels(), ses.ibisPinSel);
    const models = ses.ibisModelChoices(); ibisModelSel.innerHTML = "";
    for (const n of models) { const o = h("option", { value: n }, n) as HTMLOptionElement; if (n === ses.ibisModelValue) o.selected = true; ibisModelSel.append(o); }
    if (!models.includes(ses.ibisModelValue)) ibisModelSel.selectedIndex = -1;
    ibisDiffRow.style.display = ses.ibisCanDiff() ? "flex" : "none"; ibisDiffCb.checked = ses.ibisDiff;
    const wc = ses.waveformChoices(); fillSelect(waveformSel, wc.items, wc.sel);
  };

  // ---------------------------------------------------------------- updateModelParamsTab (a wxPropertyGrid as a table)
  const paramInputs: { idx: number; input: HTMLInputElement | HTMLSelectElement }[] = [];
  const buildParams = (m: S.SimModel): void => {
    paramTable.innerHTML = ""; paramInputs.length = 0;
    collapsed.clear(); for (const [c] of CATEGORIES) if (c !== "AC" && c !== "WAVEFORM") collapsed.add(c);
    paramTable.append(h("colgroup", null, h("col", { style: "width:38%" }), h("col", { style: "width:20%" }), h("col", { style: "width:12%" }), h("col", { style: "width:18%" }), h("col", { style: "width:12%" })));
    paramTable.append(h("thead", null, h("tr", null, h("th", null, "Parameter"), h("th", null, "Value"), h("th", null, "Unit"), h("th", null, "Default"), h("th", null, "Type"))));
    const groups = new Map<string, number[]>(); const principal: number[] = [];
    for (let i = 0; i < m.params.length; i++) {
      const info = m.getParam(i).info; if (info.dir === "OUT") continue;
      if (info.category === "SUPERFLUOUS" || info.category === "INITIAL_CONDITIONS") continue;
      if (CATEGORIES.some((c) => c[0] === info.category)) { const g = groups.get(info.category) || []; g.push(i); groups.set(info.category, g); } else principal.push(i);
    }
    const tb = h("tbody"); paramTable.append(tb);
    for (const i of principal) tb.append(paramRow(m, i, ""));
    for (const [cat, label] of CATEGORIES) {
      const list = groups.get(cat); if (!list) continue;
      const tw = h("span", { style: "display:inline-block;width:12px" }, collapsed.has(cat) ? "▸" : "▾");
      const hr = h("tr", { class: "kd-sim-cat", "data-cat": cat, style: "cursor:pointer;background:var(--bench);font-weight:600" }, h("td", { colspan: 5 }, tw, label));
      hr.addEventListener("click", () => { if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat); tw.textContent = collapsed.has(cat) ? "▸" : "▾"; for (const r of Array.from(tb.querySelectorAll<HTMLElement>(`tr[data-in="${cat}"]`))) r.style.display = collapsed.has(cat) ? "none" : ""; });
      tb.append(hr);
      for (const i of list) { const r = paramRow(m, i, cat); if (collapsed.has(cat)) r.style.display = "none"; tb.append(r); }
    }
  };
  const paramRow = (m: S.SimModel, i: number, cat: string): HTMLElement => {
    const p = m.getParam(i), info = p.info;
    const desc = info.description ? `${info.description} (${info.name})` : info.name;
    let input: HTMLInputElement | HTMLSelectElement;
    const kInductors = m.cls === "l_mutual" && (info.name === "l1" || info.name === "l2") && (ctx.inductors || []).length;
    if (info.type === "BOOL") { input = h("input", { type: "checkbox", style: "width:auto;margin:0", disabled: ro }) as HTMLInputElement; (input as HTMLInputElement).checked = p.value === "1"; input.addEventListener("change", () => { m.setParamValue(i, (input as HTMLInputElement).checked ? "1" : "0"); afterEdit(m); }); }
    else if (info.type === "STRING" && (kInductors || info.enumValues.length)) {
      const vals = kInductors ? (ctx.inductors || []).slice().sort((a, b) => S.strNumCmp(a, b)) : info.enumValues;
      input = h("k-select", { disabled: ro, style: "width:100%" }) as HTMLSelectElement;
      for (const v of vals) input.append(h("option", { value: v }, v));
      (input as HTMLSelectElement).value = p.value; if (!vals.includes(p.value)) (input as HTMLSelectElement).selectedIndex = -1;
      input.addEventListener("change", () => { m.setParamValue(i, input.value); afterEdit(m); });
    } else {
      input = h("input", { type: "text", value: p.value, disabled: ro, style: "width:100%;border:0;background:transparent", spellcheck: false }) as HTMLInputElement;
      const commit = () => { const t = info.type === "FLOAT" || info.type === "INT" ? evalParam(input.value) : input.value; if (t === m.getParam(i).value && t === input.value) return; m.setParamValue(i, t); input.value = t; afterEdit(m); };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (ev) => {
        const kev = ev as KeyboardEvent;
        if (kev.key === "Enter" || kev.key === "ArrowDown" || kev.key === "ArrowUp") {
          kev.preventDefault(); kev.stopPropagation(); commit();
          const vis = paramInputs.filter((x) => (x.input.closest("tr") as HTMLElement).style.display !== "none");
          const k = vis.findIndex((x) => x.input === input); const n = vis[k + (kev.key === "ArrowUp" ? -1 : 1)];
          if (n) { n.input.focus(); if (n.input instanceof HTMLInputElement && n.input.type === "text") n.input.select(); }
        }
      });
    }
    input.dataset.param = info.name; paramInputs.push({ idx: i, input });
    return h("tr", { "data-in": cat, "data-param": info.name }, h("td", { class: "ro", style: cat ? "padding-left:18px" : "" , title: desc }, desc), h("td", null, input), h("td", { class: "ro" }, info.unit), h("td", { class: "ro" }, info.defaultValue), h("td", { class: "ro" }, TYPE_LABEL[info.type] || info.type));
  };
  const refreshParams = (m: S.SimModel): void => {
    if (!m.hasAutofill()) return;
    for (const { idx, input } of paramInputs) { const v = m.getParam(idx).value; if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = v === "1"; else if (document.activeElement !== input) input.value = v; }
  };
  const afterEdit = (m: S.SimModel): void => { refreshParams(m); updateCode(m); };

  // ---------------------------------------------------------------- updateModelCodeTab
  const updateCode = (m: S.SimModel): void => {
    const raw = !m.fallback && m.cls === "rawspice";
    code.readOnly = ro || !raw;
    if (m.fallback) return;
    if (raw && rawCode !== undefined && prevModel === m) return;
    code.value = ses.previewText(); if (raw) rawCode = code.value;
  };
  code.addEventListener("input", () => { rawCode = code.value; });

  // ---------------------------------------------------------------- updatePinAssignments
  const updatePins = (m: S.SimModel): void => {
    pinTable.innerHTML = "";
    pinTable.append(h("thead", null, h("tr", null, h("th", null, "Symbol Pin"), h("th", null, "Model Pin"))));
    const tb = h("tbody");
    ses.pinRows().forEach((r, i) => {
      const sel = h("k-select", { disabled: ro, style: "width:100%", "data-row": i }) as HTMLSelectElement;
      for (const c of r.choices) sel.append(h("option", { value: c }, c));
      sel.value = r.model;
      sel.addEventListener("change", () => { ses.setPinAssignment(i, sel.value); updatePins(ses.curModel()); updateCode(ses.curModel()); });
      tb.append(h("tr", null, h("td", { class: "ro" }, r.symbol), h("td", null, sel)));
    });
    pinTable.append(tb);
    const isSub = !m.fallback && m.type === "SUBCKT";
    subcktLabel.style.display = subckt.style.display = isSub ? "" : "none";
    if (isSub) { let c = m.spiceCode; for (let b = m.base; !c && b; b = b.base) c = b.spiceCode; subckt.textContent = c; }
  };

  // ---------------------------------------------------------------- the library
  const resolveFile = (p: string): SimFile | null => {
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\$\{KIPRJMOD\}\//, "").replace(/^\.\//, "");
    const n = norm(p); let f = files.find((x) => norm(x.path) === n); if (f) return f;
    const tail = files.filter((x) => n.endsWith("/" + norm(x.path))); return tail.length === 1 ? tail[0] : null;
  };
  const readLibrary = async (p: string): Promise<string | null> => {
    const f = resolveFile(p);
    if (!f) { ses.messages.push(`Simulation model library not found at '${p}'`); return null; }
    let t: string | null;
    try { t = await f.load(); if (t === null) ses.messages.push(`Cannot open file '${p}'.`); } catch (e) { ses.messages.push(`Cannot open file '${p}'.`); return null; }
    if (t === null || S.isIbisPath(p)) return t;
    // .include: the included files' models where the line is
    return S.expandSpiceIncludes(t, p, async (cands) => {
      for (const c of cands) { const g = resolveFile(c); if (!g) continue; try { const x = await g.load(); if (x !== null) return x; } catch (e) { /* the next candidate */ } }
      return null;
    }, ses.messages);
  };
  const flushMessages = (): void => { const m = ses.messages.splice(0); showInfo(m.join("\n")); };
  const loadPath = async (p: string, force = false): Promise<void> => {
    if (!force && p === ses.libraryPath && ses.library) return;
    ses.source = "library";
    const text = p ? await readLibrary(p) : null;
    if (text !== null) ses.loadLibrary(p, text);
    else { ses.library = null; ses.libModels.clear(); ses.libraryPath = p; ses.modelName = ""; }
    fillModelList(ses.modelNames(filter.value));
    // the reader's messages (a missing model, an unreadable .include) in the infobar
    if (!p) { ses.messages.length = 0; showInfo(""); } else flushMessages();
    updateWidgets();
  };
  const onModelChoice = (): void => {
    ses.source = "library"; ses.modelName = modelList.value;
    if (ses.ibisLoaded()) ses.resetIbis();
    const m = ses.curModel();
    if (m.fallback && ses.library) showInfo(`Failed to parse:\n\n${m.spiceCode.split("\n").filter((l) => !l.startsWith("*")).join("\n")}\nUsing generic SPICE model.`);
    else showInfo("");
    updateWidgets();
  };

  // ---------------------------------------------------------------- layout
  const libBox = h("div", { style: "margin-left:22px;display:grid;grid-template-columns:max-content 1fr;gap:4px 8px;align-items:start" },
    lbl("File:", libLabels), h("div", { style: "display:flex;gap:4px" }, pathText, browseBtn),
    modelLabel, h("div", { style: "display:flex;flex-direction:column;gap:3px" }, filter, modelList));
  {
    const row = (l: HTMLElement | null, w: HTMLElement) => { const a = l || h("span"); ibisRows.push(a, w); libBox.append(a, w); };
    row(lbl("Pin:", libLabels), ibisPinSel); row(null, ibisDiffRow); row(lbl("Model:", libLabels), ibisModelSel); row(lbl("Waveform:", libLabels), waveformSel);
    for (const r of ibisRows) r.style.display = "none";
  }
  const builtinBox = h("div", { style: "margin-left:22px;display:grid;grid-template-columns:max-content 1fr;gap:4px 8px;align-items:center" },
    lbl("Device:", builtinLabels), deviceSel, typeLabel, typeSel);
  builtinLabels.push(typeLabel);
  KD().notebook(d.body, [
    { label: "Model", build(pg) {
      pg.append(h("label", { style: "display:flex;gap:6px;align-items:center;margin:2px 0 4px" }, rbLib, "SPICE model from file (*.lib, *.sub or *.ibs)"), libBox,
        h("label", { style: "display:flex;gap:6px;align-items:center;margin:10px 0 4px" }, rbBuiltin, "Built-in SPICE model"), builtinBox);
      const nbHost = h("div", { style: "margin-top:10px" }); pg.append(nbHost);
      modelNb = KD().notebook(nbHost, [{ label: "Parameters", build(p2) { p2.append(paramWrap); } }, { label: "Code", build(p2) { p2.append(code); } }], { onSelect: () => updateCode(ses.curModel()) });
      pg.append(h("label", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" }, saveCb, saveLabel));
    } },
    { label: "Pin Assignments", build(pg) {
      if (ctx.unitCount > 1) pg.append(h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:4px 8px;align-items:center;margin-bottom:8px" }, h("label", null, "Decomposition:"), decompSel, h("label", null, "Shared model pins:"), sharedText));
      pg.append(pinWrap, subcktLabel, subckt);
    } },
  ]);

  // ---------------------------------------------------------------- events
  rbLib.addEventListener("change", () => { if (rbLib.checked) { ses.source = "library"; prevModel = null; updateWidgets(); } });
  rbBuiltin.addEventListener("change", () => { if (rbBuiltin.checked) { ses.source = "builtin"; prevModel = null; updateWidgets(); } });
  pathText.addEventListener("input", () => { ses.source = "library"; rbLib.checked = true; });
  pathText.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); void loadPath(pathText.value.trim(), true); } });
  pathText.addEventListener("blur", () => { if (pathText.value.trim() !== ses.libraryPath) void loadPath(pathText.value.trim(), true); });
  browseBtn.addEventListener("click", () => { void browseModels(files, pathText.value).then((f) => { if (!f) return; pathText.value = f.path; void loadPath(f.path, true); }); });
  filter.addEventListener("input", () => {
    if (!ses.library) return;
    const cur = modelList.value; const names = ses.modelNames(filter.value); fillModelList(names);
    if (names.length) { if (names.includes(cur)) modelList.value = cur; else { modelList.selectedIndex = 0; onModelChoice(); } }
  });
  filter.addEventListener("keydown", (ev) => {
    const n = modelList.options.length; if (!n) return;
    let sel = modelList.selectedIndex;
    if (ev.key === "ArrowUp") sel = sel < 0 ? n - 1 : Math.max(sel - 1, 0);
    else if (ev.key === "ArrowDown") sel = sel < 0 ? 0 : Math.min(sel + 1, n - 1);
    else if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); okBtn.click(); return; }
    else return;
    ev.preventDefault(); modelList.selectedIndex = sel; onModelChoice();
  });
  modelList.addEventListener("change", onModelChoice);
  ibisPinSel.addEventListener("change", () => { ses.selectIbisPin(ibisPinSel.selectedIndex); updateWidgets(); });
  ibisModelSel.addEventListener("change", () => { ses.selectIbisModel(ibisModelSel.value); updateWidgets(); });
  ibisDiffCb.addEventListener("change", () => { ses.setIbisDiff(ibisDiffCb.checked); updateWidgets(); });
  waveformSel.addEventListener("change", () => { const o = waveformSel.options[waveformSel.selectedIndex]; if (o) ses.selectWaveform(o.textContent || ""); updateWidgets(); });
  deviceSel.addEventListener("change", () => { ses.selectDevice(deviceSel.options[deviceSel.selectedIndex]?.text || ""); updateWidgets(); });
  typeSel.addEventListener("change", () => { ses.selectType(typeSel.options[typeSel.selectedIndex]?.text || ""); updateWidgets(); });
  saveCb.addEventListener("change", () => { ses.storeInValue = saveCb.checked; });
  decompSel.addEventListener("change", () => { ses.decompositionRepeat = decompSel.value === "1"; sharedText.disabled = ro || !ses.decompositionRepeat; });
  sharedText.addEventListener("input", () => { ses.sharedPins = sharedText.value; });
  paramWrap.addEventListener("contextmenu", (ev) => {
    const tr = (ev.target as Element).closest && (ev.target as Element).closest("tr[data-param]"); if (!tr) return;
    ev.preventDefault(); const inp = tr.querySelector("input[type=text]") as HTMLInputElement | null;
    popupMenu(ev.clientX, ev.clientY, [{ label: "Copy", disabled: !inp, run: () => { if (inp) void navigator.clipboard?.writeText(inp.value).catch(() => undefined); } }]);
  });

  const cancelBtn = h("button", { class: "btn", id: "kd-sim-cancel" }, "Cancel"), okBtn = h("button", { class: "btn primary", id: "kd-sim-ok", disabled: ro }, "OK");
  d.foot.append(h("span", { class: "spacer" }), cancelBtn, okBtn);
  const finish = (apply: boolean): void => {
    if (apply) {
      const a = document.activeElement as HTMLElement | null; if (a && d.dlg.contains(a)) a.blur();
      const m = ses.curModel();
      const edited = ses.finish({ rawCode: !m.fallback && m.type === "RAWSPICE" ? (modelNb && modelNb.index() === 0 ? ses.previewText() : code.value) : undefined });
      d.close(); done(S.mergeEditedFields(rows0.map(clone), edited));
      return;
    }
    d.close();
  };
  cancelBtn.addEventListener("click", () => finish(false)); okBtn.addEventListener("click", () => finish(true));
  (d.dlg.querySelector(".kd-x") as HTMLElement).addEventListener("click", () => finish(false));
  d.ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, d.ov);
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Enter" && !ro) { const t = ev.target as HTMLElement; if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.closest("#kd-sim-params") || t === pathText || t === filter) return; ev.preventDefault(); finish(true); }
  });

  // ---------------------------------------------------------------- TransferDataToWindow
  const { libraryPath } = ses.begin();
  const start = async (): Promise<void> => {
    const text = libraryPath ? await readLibrary(libraryPath) : null;
    ses.finishBegin(text);
    pathText.value = ses.libraryPath || libraryPath;
    fillModelList(ses.modelNames());
    decompSel.value = ses.decompositionRepeat ? "1" : "0"; sharedText.value = ses.sharedPins; sharedText.disabled = ro || !ses.decompositionRepeat;
    flushMessages();
    prevModel = null; updateWidgets();
    d.dlg.focus();
  };
  void start();
}

/** window.KiCadSimModel (installed with the schematic dialogs). */
export function installSimModel(): void {
  (window as unknown as { KiCadSimModel: { open: typeof openSimModel } }).KiCadSimModel = { open: openSimModel };
}
