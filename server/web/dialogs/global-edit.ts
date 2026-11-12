// dialogs/global-edit.ts — Edit > Edit Text & Graphics Properties… (SCH_EDIT_TOOL::GlobalEdit,
// eeschema/dialogs/dialog_global_edit_text_and_graphics.cpp).
//
// The three boxes of DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS_BASE: Scope (Reference designators … Schematic text &
// graphics), Filter Items (field name, parent reference, parent library id, parent symbol type, net — the
// highlighted net when the net filter is empty —, selected items only; typing in a filter ticks it) and Set To
// (font, text colour, size, bold / italic as three-state boxes, label orientation, field H / V align, field
// visibility and field-name display, line width / colour / style, fill colour, junction size and colour; every one
// starts at "-- leave unchanged --").  OK walks every sheet instance of the hierarchy (visitItem) and changes only
// effects, strokes, fills and junction dots: the sheet on screen is one "Edit Text and Graphics" step, each other
// sheet one step on its own undo list.
import { E, appState, pushUndoFor, toolCtx, undoStack } from "./editor";
import { KD, checkbox, h, select, textInput } from "./dom";
import { messageBox } from "./sch-items";
import { projectDocs, readDoc, submitDocOp } from "./project";
import * as L from "./global-edit-logic";
import { HL, loadSheets, netMap } from "../editor/schnets";
import { fmtLen, parseLen, unitName } from "../editor/pcbdialogs/ui";

const LEAVE = "-- leave unchanged --";
interface SchHelpers { isPowerSymbol(doc: KDoc, libId: string): boolean }
const schH = (): SchHelpers | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchHelpers : null; };

/** What the dialog keeps between openings: the scope and the filters (DIALOG_SHIM's saved control state, the g_ filter strings). */
const mem = {
  scope: L.emptyScope(),
  on: { fieldName: false, reference: false, libId: false, power: false, net: false, selectedOnly: false },
  text: { fieldName: "", reference: "", libId: "", net: "" },
  power: 0,
};

function selectedIds(): Set<string> {
  const ids = new Set<string>(E.selection); if (E.selected) ids.add(E.selected.id);
  const S = CollabTools.sch ? CollabTools.sch.state as { sel?: string | null; multi?: Iterable<string> | null } : null;
  if (S && S.sel) ids.add(S.sel); if (S && S.multi) for (const i of S.multi) ids.add(i);
  return ids;
}

/** Faces the font choice offers: the stroke font, the faces the project's text already uses, common system faces. */
function fontFaces(doc: KDoc): string[] {
  const used = new Set<string>();
  const walk = (n: unknown): void => { if (!Array.isArray(n)) return; if (n[0] === "face" && typeof n[1] === "string") used.add(n[1]); for (const c of n) walk(c); };
  for (const it of doc.items.values()) walk(it.node);
  const common = ["Arial", "Courier New", "DejaVu Sans", "DejaVu Sans Mono", "Georgia", "Helvetica", "Liberation Sans", "Noto Sans", "Times New Roman", "Verdana"];
  return [L.KICAD_FONT, ...Array.from(new Set([...used, ...common])).sort((a, b) => a.localeCompare(b))];
}

/** A COLOR_SWATCH: the colour, or the checkered "unspecified" (COLOR4D::UNSPECIFIED, the default here). */
function swatch(id: string, onPick: () => void): { el: HTMLElement; get(): L.Color } {
  let color: L.Color = null;
  const input = h("input", { type: "color", id, value: "#000000", style: "position:absolute;opacity:0;width:0;height:0;pointer-events:none" });
  const face = h("span", { style: "display:inline-block;width:26px;height:16px;border:1px solid var(--line);border-radius:2px;vertical-align:middle" });
  const paint = (): void => { face.style.background = color ? L.colorToHex(color) : "repeating-conic-gradient(var(--ink-3) 0 25%, var(--panel) 0 50%) 0 0 / 8px 8px"; face.title = color ? L.colorToHex(color) : "Unspecified"; };
  input.addEventListener("input", () => { color = L.hexToColor(input.value, 1); paint(); onPick(); });
  const btn = h("button", { type: "button", class: "btn", style: "padding:1px 4px;position:relative", title: "Choose color", onclick: () => { input.value = L.colorToHex(color); input.click(); } }, face, input);
  const clear = h("button", { type: "button", class: "btn", style: "padding:0 5px", title: "Unspecified (use the default color)", onclick: () => { color = null; paint(); onPick(); } }, "×");
  paint();
  return { el: h("span", { style: "display:inline-flex;gap:2px;align-items:center" }, btn, clear), get: () => color };
}

/** A wxCheckBox with wxCHK_3STATE: undetermined (null), off, on; a click cycles through them as wx does. */
function tristate(label: string, id: string): { el: HTMLElement; get(): boolean | undefined } {
  const cb = h("input", { type: "checkbox", id });
  let state: boolean | null = null; cb.indeterminate = true;
  cb.addEventListener("click", () => { state = state === null ? true : state ? false : null; cb.checked = !!state; cb.indeterminate = state === null; });
  return { el: h("label", { class: "kd-chk" }, cb, label), get: () => (state === null ? undefined : state) };
}

export function openGlobalEdit(): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  const doc = E.kdoc as KDoc, sel = selectedIds();
  void loadSheets(true);
  // TransferDataToWindow: an empty net filter takes the highlighted net
  if (!mem.text.net && HL.name) mem.text.net = HL.name;
  const scopeBoxes = new Map<keyof L.Scope, HTMLInputElement>();
  const filterOn = new Map<keyof typeof mem.on, HTMLInputElement>();
  const filterText = new Map<keyof typeof mem.text, HTMLInputElement>();
  let powerSel: HTMLSelectElement | null = null;
  let fontSel: HTMLSelectElement | null = null, orient: HTMLSelectElement | null = null, hAl: HTMLSelectElement | null = null, vAl: HTMLSelectElement | null = null, lstyle: HTMLSelectElement | null = null;
  let size: HTMLInputElement | null = null, lwidth: HTMLInputElement | null = null, jsize: HTMLInputElement | null = null;
  const setColor = { text: null as HTMLInputElement | null, line: null as HTMLInputElement | null, fill: null as HTMLInputElement | null, dot: null as HTMLInputElement | null };
  let sw: Record<"text" | "line" | "fill" | "dot", { get(): L.Color }> | null = null;
  let tri: Record<"bold" | "italic" | "visible" | "showName", { el: HTMLElement; get(): boolean | undefined }> | null = null;

  const scopeRow = (key: keyof L.Scope, label: string) => {
    const row = checkbox(label, mem.scope[key], undefined, { id: "kd-ge-s-" + key });
    scopeBoxes.set(key, row.querySelector("input") as HTMLInputElement); return row;
  };
  const filterRow = (key: keyof typeof mem.text, label: string) => {
    const row = checkbox(label, mem.on[key], undefined, { id: "kd-ge-f-" + key }), cb = row.querySelector("input") as HTMLInputElement;
    filterOn.set(key, cb);
    const t = textInput(mem.text[key], () => { cb.checked = true; }, { id: "kd-ge-t-" + key });   // OnXxxFilterText ticks the filter
    filterText.set(key, t);
    return [row, t];
  };
  const lenInput = (id: string) => textInput(LEAVE, undefined, { id, style: "width:170px" });
  const units = () => h("span", { class: "kd-note" }, unitName());
  const hint = (t: string) => h("span", { style: "font-size:11px;font-style:italic;color:var(--ink-3)" }, t);
  const lenOf = (i: HTMLInputElement | null): number | undefined => {
    if (!i) return undefined; const t = i.value.trim(); if (!t || t === LEAVE) return undefined;
    const v = parseLen(t); return Number.isFinite(v) ? v : undefined;
  };

  const settings = (): { scope: L.Scope; f: L.Filters; s: L.SetTo } | null => {
    for (const [k, cb] of scopeBoxes) mem.scope[k] = cb.checked;
    for (const [k, cb] of filterOn) mem.on[k] = cb.checked;
    for (const [k, t] of filterText) mem.text[k] = t.value;
    mem.on.power = !!(document.getElementById("kd-ge-f-power") as HTMLInputElement | null)?.checked;
    mem.on.selectedOnly = !!(document.getElementById("kd-ge-f-selectedOnly") as HTMLInputElement | null)?.checked;
    mem.power = powerSel ? Number(powerSel.value) : 0;
    const f: L.Filters = {
      fieldName: mem.on.fieldName ? mem.text.fieldName : null, reference: mem.on.reference ? mem.text.reference : null,
      libId: mem.on.libId ? mem.text.libId : null, power: mem.on.power ? mem.power === 1 : null,
      net: mem.on.net ? mem.text.net : null, selectedOnly: mem.on.selectedOnly,
    };
    const s: L.SetTo = {};
    if (fontSel && fontSel.value !== LEAVE) s.font = fontSel.value;
    if (setColor.text?.checked && sw) s.textColor = sw.text.get();
    const ts = lenOf(size);
    if (size && size.value.trim() !== LEAVE && size.value.trim() !== "") {
      // m_textSize.Validate( 1.0, 10000.0, MILS )
      if (ts === undefined || ts < 0.0254 || ts > 254) { size.focus(); size.style.outline = "2px solid var(--err)"; return null; }
      s.textSize = ts;
    }
    if (tri) { const b = tri.bold.get(), i = tri.italic.get(), v = tri.visible.get(), n = tri.showName.get(); if (b !== undefined) s.bold = b; if (i !== undefined) s.italic = i; if (v !== undefined) s.visible = v; if (n !== undefined) s.showName = n; }
    if (orient && orient.value !== LEAVE) s.orientation = Number(orient.value) as 0 | 1 | 2 | 3;
    if (hAl && hAl.value !== LEAVE) s.hAlign = hAl.value as L.SetTo["hAlign"];
    if (vAl && vAl.value !== LEAVE) s.vAlign = vAl.value as L.SetTo["vAlign"];
    const lw = lenOf(lwidth); if (lw !== undefined) s.lineWidth = Math.max(0, lw);
    if (setColor.line?.checked && sw) s.lineColor = sw.line.get();
    if (lstyle && lstyle.value !== LEAVE) s.lineStyle = lstyle.value as L.LineStyle;
    if (setColor.fill?.checked && sw) s.fillColor = sw.fill.get();
    const js = lenOf(jsize); if (js !== undefined) s.junctionSize = Math.max(0, js);
    if (setColor.dot?.checked && sw) s.junctionColor = sw.dot.get();
    return { scope: Object.assign({}, mem.scope), f, s };
  };

  const run = async (scope: L.Scope, f: L.Filters, s: L.SetTo): Promise<void> => {
    if (E.viewOnly) return;
    try { await loadSheets(true); } catch (e) { /* the sheets as last read */ }
    const c = netMap();
    const curPath = String(((appState as unknown as { doc?: { path?: string } }).doc || {}).path || "");
    const entries = projectDocs().filter((d) => d.docType === "kicad_sch");
    // the documents to edit: the one on screen as it is, the others read fresh
    const docs = new Map<string, { docId: string; doc: KDoc; current: boolean }>();
    docs.set(curPath, { docId: String(appState.docId || ""), doc, current: true });
    const instances = c && c.instances.length ? c.instances : [{ index: 0, human: "/", file: curPath, uuidPath: [], sheetName: "" }];
    for (const inst of instances) {
      if (docs.has(inst.file)) continue;
      const d = entries.find((x) => x.path === inst.file); if (!d) continue;
      try { docs.set(inst.file, { docId: d.docId, doc: await readDoc(d.docId, "kicad_sch"), current: false }); } catch (e) { /* unreadable: left alone */ }
    }
    const edited = new Map<string, Map<string, SNode>>();   // file -> item id -> new node
    for (const inst of instances) {
      const sheet = docs.get(inst.file); if (!sheet) continue;
      const busIds = new Set<string>(), wireNet = new Map<string, boolean>();
      if (c) for (const e of c.map.values()) {
        const here = e.members.filter((m) => m.inst === inst.index);
        if (e.bus || here.some((m) => m.kind === "bus")) for (const m of here) busIds.add(m.id);
        const wired = here.some((m) => m.kind === "wire" || m.kind === "pin");
        for (const m of here) if (!e.bus) wireNet.set(m.id, wired);
      }
      const ctx: L.SheetCtx = {
        netOf: (id) => (c ? c.index.get(inst.index + "|" + id) || null : null),
        attached: (id) => ({ wire: !!wireNet.get(id), bus: busIds.has(id) }),
        refOf: (node) => L.refOnInstance(node, inst.uuidPath),
        isPower: (node) => { const l = KiCadCanvas.kid(node, "lib_id") as SNode | null; const H = schH(); return !!H && !!l && H.isPowerSymbol(sheet.doc, KiCadCanvas.str(l[1] as SNode)); },
        selected: (id) => sheet.current && sel.has(id),
      };
      const acc = edited.get(inst.file) || new Map<string, SNode>(); edited.set(inst.file, acc);
      for (const it of sheet.doc.items.values()) {
        const node = acc.get(it.id) || it.node;
        const out = L.visitItem({ id: it.id, kind: it.kind, node }, scope, f, s, ctx);
        if (out) acc.set(it.id, out);
      }
    }
    // one SCH_COMMIT over the whole hierarchy, pushed once: a single Ctrl+Z undoes every sheet
    const label = "Edit Text and Graphics";
    let here: { changes: KChange[]; inverse: KChange[] } = { changes: [], inverse: [] };
    const others: { docId: string; file: string; changes: KChange[]; inverse: KChange[] }[] = [];
    for (const [file, acc] of edited) {
      if (!acc.size) continue;
      const sheet = docs.get(file) as { docId: string; doc: KDoc; current: boolean };
      const changes: KChange[] = [], inverse: KChange[] = [];
      for (const [id, node] of acc) {
        const it = sheet.doc.items.get(id); if (!it) continue;
        inverse.push(KiCadCanvas.replaceChange(sheet.doc, it));
        changes.push(KiCadCanvas.replaceChange(sheet.doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem));
      }
      if (!changes.length) continue;
      if (sheet.current) here = { changes, inverse }; else others.push({ docId: sheet.docId, file, changes, inverse });
    }
    const failed: string[] = [], done: typeof others = [];
    for (const o of others) { try { await submitDocOp(o.docId, o.changes); done.push(o); } catch (e) { failed.push(o.file); } }
    const replay = (which: "changes" | "inverse") => () => { for (const o of done) submitDocOp(o.docId, o[which]).catch(() => { void messageBox(`Could not update '${o.file}'.`); }); };
    const hooks = done.length ? { undoOthers: replay("inverse"), redoOthers: replay("changes") } : {};
    if (here.changes.length) { toolCtx().commit(here.changes, label); const top = undoStack[undoStack.length - 1]; if (top && done.length) Object.assign(top, hooks); }
    else if (done.length) pushUndoFor(String(appState.docId || ""), Object.assign({ label, changes: [], inverse: [] }, hooks));
    if (failed.length) void messageBox(`Could not update ${failed.map((f) => `'${f}'`).join(", ")}.`);
  };

  KD().open({
    title: "Edit Text and Graphics Properties", width: 860, readOnly: !!E.viewOnly,
    build(body) {
      const col = (...c: Node[]) => h("div", { style: "display:flex;flex-direction:column" }, ...c);
      // Scope
      const scopeHost = h("div");
      const sb = KD().staticBox(scopeHost, "Scope");
      sb.append(h("div", { style: "display:flex;gap:18px" },
        col(scopeRow("references", "Reference designators"), scopeRow("values", "Values"), scopeRow("otherFields", "Other symbol fields"), h("div", { style: "height:8px" }),
          scopeRow("wires", "Wires & wire labels"), scopeRow("buses", "Buses & bus labels"), scopeRow("globalLabels", "Global labels"), scopeRow("hierLabels", "Hierarchical labels"), scopeRow("labelFields", "Label fields")),
        col(scopeRow("sheetTitles", "Sheet titles"), scopeRow("sheetFields", "Other sheet fields"), scopeRow("sheetPins", "Sheet pins"), scopeRow("sheetBorders", "Sheet borders & backgrounds"), h("div", { style: "height:8px" }),
          scopeRow("schTextAndGraphics", "Schematic text & graphics"))));
      // Filter Items
      const filtHost = h("div", { style: "flex:1;min-width:0" });
      const fb = KD().staticBox(filtHost, "Filter Items");
      const g = h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:3px 8px;align-items:center" });
      g.append(...filterRow("fieldName", "By field name:"), ...filterRow("reference", "By parent reference designator:"), ...filterRow("libId", "By parent symbol library id:"));
      const prow = checkbox("By parent symbol type:", mem.on.power, undefined, { id: "kd-ge-f-power" });
      powerSel = select([["0", "Non-power symbols"], ["1", "Power symbols"]], String(mem.power), () => { (prow.querySelector("input") as HTMLInputElement).checked = true; }, { id: "kd-ge-power", style: "width:100%" });
      g.append(prow, powerSel, ...filterRow("net", "By net:"));
      fb.append(g, h("div", { style: "height:6px" }), checkbox("Selected items only", mem.on.selectedOnly, undefined, { id: "kd-ge-f-selectedOnly" }));
      body.append(h("div", { style: "display:flex;gap:12px;align-items:flex-start" }, scopeHost, filtHost));
      // Set To
      const setHost = h("div");
      const tb = KD().staticBox(setHost, "Set To");
      fontSel = select([LEAVE, ...fontFaces(doc)], LEAVE, undefined, { id: "kd-ge-font", style: "width:180px" });
      const tc = swatch("kd-ge-textcolor", () => { (setColor.text as HTMLInputElement).checked = true; });
      const lc = swatch("kd-ge-linecolor", () => { (setColor.line as HTMLInputElement).checked = true; });
      const fc = swatch("kd-ge-fillcolor", () => { (setColor.fill as HTMLInputElement).checked = true; });
      const dc = swatch("kd-ge-dotcolor", () => { (setColor.dot as HTMLInputElement).checked = true; });
      sw = { text: tc, line: lc, fill: fc, dot: dc };
      const colorRow = (key: "text" | "line" | "fill" | "dot", label: string, s: { el: HTMLElement }) => {
        const row = checkbox(label, false, undefined, { id: "kd-ge-c-" + key }); setColor[key] = row.querySelector("input") as HTMLInputElement;
        return [row, s.el, h("span")];
      };
      size = lenInput("kd-ge-size"); lwidth = lenInput("kd-ge-lwidth"); jsize = lenInput("kd-ge-jsize");
      for (const i of [size, lwidth, jsize]) {
        i.addEventListener("focus", () => { if (i.value === LEAVE) i.select(); });
        i.addEventListener("change", () => { i.style.outline = ""; const t = i.value.trim(); if (!t) { i.value = LEAVE; return; } if (t === LEAVE) return; const v = parseLen(t); i.value = Number.isFinite(v) ? fmtLen(v) : LEAVE; });
      }
      tri = { bold: tristate("Bold", "kd-ge-bold"), italic: tristate("Italic", "kd-ge-italic"), visible: tristate("Visible", "kd-ge-visible"), showName: tristate("Show field name", "kd-ge-showname") };
      orient = select([["0", "Right"], ["1", "Up"], ["2", "Left"], ["3", "Down"], [LEAVE, LEAVE]], LEAVE, undefined, { id: "kd-ge-orient" });
      hAl = select([["left", "Left"], ["center", "Center"], ["right", "Right"], [LEAVE, LEAVE]], LEAVE, undefined, { id: "kd-ge-halign" });
      vAl = select([["top", "Top"], ["center", "Center"], ["bottom", "Bottom"], [LEAVE, LEAVE]], LEAVE, undefined, { id: "kd-ge-valign" });
      lstyle = select([["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"], [LEAVE, LEAVE]], LEAVE, undefined, { id: "kd-ge-lstyle" });
      const lab = (t: string) => h("label", null, t);
      const left = h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:4px 8px;align-items:center" },
        lab("Font:"), fontSel, h("span"),
        ...colorRow("text", "Text color:", tc),
        lab("Text size:"), size, units(),
        h("span"), h("span", { style: "display:flex;gap:14px" }, tri.bold.el, tri.italic.el), h("span"),
        lab("Orientation:"), orient, hint("(labels only)"),
        lab("H Align:"), hAl, hint("(fields only)"),
        lab("V Align:"), vAl, hint("(fields only)"),
        h("span"), h("span", { style: "display:flex;gap:8px;align-items:center" }, tri.visible.el, hint("(fields only)")), h("span"),
        h("span"), h("span", { style: "display:flex;gap:8px;align-items:center" }, tri.showName.el, hint("(fields only)")), h("span"));
      const right = h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:4px 8px;align-items:center;align-content:start" },
        lab("Line width:"), lwidth, units(),
        ...colorRow("line", "Line color:", lc),
        lab("Line style:"), lstyle, h("span"),
        ...colorRow("fill", "Fill color:", fc),
        h("span", { style: "height:8px" }), h("span"), h("span"),
        lab("Junction size:"), jsize, units(),
        ...colorRow("dot", "Junction color:", dc));
      tb.append(h("div", { style: "display:flex;gap:28px" }, left, right));
      body.append(setHost);
    },
    ok() {
      const got = settings(); if (!got) return false;
      void run(got.scope, got.f, got.s);
      return undefined;
    },
  });
}
