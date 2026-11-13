// pcbdialogs/fp-editor — the Footprint Editor's own dialogs, in KiCad's layout:
//   Footprint Properties   DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR (General, Layers, Clearance Overrides, Pad
//                          Connections, 3D Models)
//   Pad Table              DIALOG_FP_EDIT_PAD_TABLE (grid, pad numbers summary, CSV export / import)
//   Push Pad Properties    DIALOG_PUSH_PAD_PROPERTIES
//   Renumber Pads          DIALOG_ENUM_PADS (the parameters; the clicking is the pad tool's)
//   Footprint Checker      DIALOG_FOOTPRINT_CHECKER (markers list, Run Checks, Delete All Markers)
// The logic is pcb-tools' (fp-props.ts, fp-pads.ts, fp-check.ts); these build the controls and commit the changes.
import { box, checkField, download, errorMessage, fmtLenU, form, grid, gridButtons, h, lenField, messageBox, note, notebook, numField, openDialog, parseLen, selectField, textField, unitLabel, type CellValue, type Field } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const PT = (): Any => (window as unknown as { PcbTools: Any }).PcbTools;
const FPP = () => PT().fpProps, PADS = () => PT().fpPads, CHK = () => PT().fpCheck;
const layerLabel = (doc: KDoc, n: string): string => { const l = doc.layers.get(n); return l && l.userName ? l.userName : n; };
const userLayers = (): string[] => Array.from({ length: 45 }, (_, i) => `User.${i + 1}`);
/** LAYERS_GRID_TABLE for private layers: every layer that is not copper, technical, Edge.Cuts or Margin. */
const privateLayerChoices = (): string[] => ["Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", ...userLayers()];

// ---------------------------------------------------------------- Footprint Properties
export interface FpPropsHost { libHas?(name: string): boolean; overwrite?(name: string): Promise<boolean>; activeLayer?: string; textStyle?(layer: string): { w: number; h: number; thick: number; italic: boolean } }
export function footprintPropertiesDialog(ctx: ToolCtx, host: FpPropsHost = {}): boolean {
  const doc = ctx.doc as KDoc | null; if (!doc) return false;
  const ro = !!ctx.viewOnly;
  const m = FPP().readFpProps(doc);
  const layerOpts: [string, string][] = Array.from(doc.layers.keys()).filter((l) => !/\.Cu$/.test(l)).map((l): [string, string] => [l, layerLabel(doc, l)]);
  const toRow = (f: Any): Record<string, CellValue> => ({ ...f });
  let fieldsGrid: ReturnType<typeof grid> | null = null;
  const fieldRows = m.fields.map(toRow);
  // General
  const name = textField(m.name, { ro, key: "fpName" }), descr = textField(m.descr, { ro, key: "descr" }), tags = textField(m.tags, { ro, key: "keywords" });
  const height = lenField(m.height, { ro, key: "height", allowEmpty: true });
  const type = selectField<string>(m.type, [["through_hole", "Through hole"], ["smd", "SMD"], ["", "Unspecified"]], { ro, key: "componentType" });
  const exSim = checkField(m.excludeFromSim, "Exclude from simulation", { ro, key: "excludeFromSim" }), boardOnly = checkField(m.boardOnly, "Not in schematic", { ro, key: "boardOnly" });
  const dnp = checkField(m.dnp, "Do not populate", { ro, key: "dnp" }), exBom = checkField(m.excludeFromBom, "Exclude from bill of materials", { ro, key: "excludeFromBom" });
  const exPos = checkField(m.excludeFromPos, "Exclude from position files", { ro, key: "excludeFromPos" });
  // Layers
  const privRows: Record<string, CellValue>[] = m.privateLayers.map((l: string) => ({ layer: l }));
  const privGrid = grid([{ label: "Private Layers", key: "layer", type: "select", options: privateLayerChoices().map((l): [string, string] => [l, layerLabel(doc, l)]) }], privRows, { ro, height: "200px" });
  const custom = checkField(m.customStackup, "Use custom stackup", { ro, key: "customStackup", onChange: () => enableCustom() });
  const cuCount = selectField<number>(m.copperCount, FPP().COPPER_COUNTS.map((n: number): [number, string] => [n, String(n)]), { ro, key: "copperLayers" });
  const userRows: Record<string, CellValue>[] = m.userLayers.map((l: string) => ({ layer: l }));
  const userGrid = grid([{ label: "User Layers", key: "layer", type: "select", options: userLayers().map((l): [string, string] => [l, layerLabel(doc, l)]) }], userRows, { ro, height: "150px" });
  const enableCustom = (): void => { const on = custom.get() && !ro; cuCount.input.disabled = !on; userGrid.el.style.opacity = on ? "1" : "0.5"; userGrid.el.style.pointerEvents = on ? "" : "none"; };
  // Clearance Overrides
  const clr = lenField(m.clearance, { ro, key: "padClearance", allowEmpty: true }), mask = lenField(m.maskMargin, { ro, key: "maskMargin", allowEmpty: true });
  const pasteT = textField(FPP().formatPaste(m.pasteMargin, m.pasteRatio, fmtLenU), { ro, key: "pasteClearance" });
  const bridges = checkField(m.allowBridges, "Allow bridged solder mask apertures between pads", { ro, key: "allowBridges" });
  const noCrt = checkField(m.noCourtyard, "Exempt from courtyard requirement", { ro, key: "noCourtyard", tip: "Will not generate \"missing courtyard\" DRC violations" });
  // Pad Connections
  const zone = selectField<string>(m.zoneConnect, FPP().ZONE_CHOICES, { ro, key: "zoneConnect" });
  const ntRows: Record<string, CellValue>[] = m.netTieGroups.map((g: string) => ({ g }));
  const ntGrid = grid([{ label: "Pad groups allowed to short different nets:", key: "g" }], ntRows, { ro, height: "120px" });
  const dupJ = checkField(m.dupPadsAreJumpers, "All pads with duplicate numbers are jumpers", { ro, key: "dupJumpers", tip: "When enabled, this footprint can have more than one pad with the same number, and pads with the same number will be considered to be jumpered together internally." });
  const jgRows: Record<string, CellValue>[] = m.jumperGroups.map((g: string) => ({ g }));
  const jgGrid = grid([{ label: "Explicit jumper pad groups:", key: "g" }], jgRows, { ro, height: "120px" });
  // 3D Models
  const models = m.models.map((x: Any) => ({ ...x, offset: x.offset.slice(), scale: x.scale.slice(), rotate: x.rotate.slice() }));
  const modelRows: Record<string, CellValue>[] = models.map((x: Any, i: number) => ({ i, file: x.file, show: x.show }));
  let modelSel = -1;
  const mf: Record<string, Field<number>> = {};
  for (const k of ["sx", "sy", "sz", "rx", "ry", "rz", "ox", "oy", "oz"]) mf[k] = numField(k[0] === "s" ? 1 : 0, { ro, key: "model-" + k, digits: 4 });
  const opacity = h("input", { type: "range", min: "0", max: "100", value: "100", disabled: ro, "data-k": "model-opacity" }) as HTMLInputElement;
  const saveModel = (): void => {
    const x = models[modelSel]; if (!x) return;
    x.scale = [mf.sx.get(), mf.sy.get(), mf.sz.get()]; x.rotate = [mf.rx.get(), mf.ry.get(), mf.rz.get()]; x.offset = [mf.ox.get(), mf.oy.get(), mf.oz.get()]; x.opacity = Number(opacity.value) / 100;
  };
  const showModel = (i: number): void => {
    saveModel(); modelSel = i; const x = models[i];
    const vals = x ? [...x.scale, ...x.rotate, ...x.offset] : [1, 1, 1, 0, 0, 0, 0, 0, 0];
    ["sx", "sy", "sz", "rx", "ry", "rz", "ox", "oy", "oz"].forEach((k, j) => mf[k].set(vals[j]));
    opacity.value = String(Math.round((x ? x.opacity : 1) * 100));
  };
  const modelGrid = grid([{ label: "3D Model(s)", key: "file" }, { label: "Show", key: "show", type: "check", width: "50px" }], modelRows, { ro, height: "150px", onSelect: (i) => showModel(i) });
  const syncModels = (): void => {   // the grid's file / show cells and row order back into the model list
    saveModel();
    const next = modelGrid.rows().map((r) => { const x = typeof r.i === "number" && models[r.i as number] ? models[r.i as number] : { file: "", show: true, opacity: 1, offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] }; return { ...x, file: String(r.file || ""), show: !!r.show }; });
    models.splice(0, models.length, ...next); modelGrid.rows().forEach((r, i) => { r.i = i; });
  };

  let api: Any = null;
  const tabs = notebook([
    { label: "General", build(el) {
      const fg = fieldsGrid = grid([{ label: "", key: "name", width: "120px", readOnly: (r) => FPP().isMandatoryName(String(r.name)) && !!r.id }, { label: "Text Items", key: "value" }, { label: "Show", key: "show", type: "check" },
        { label: "Width", key: "w", type: "len" }, { label: "Height", key: "h", type: "len" }, { label: "Thickness", key: "thick", type: "len" }, { label: "Italic", key: "italic", type: "check" },
        { label: "Layer", key: "layer", type: "select", options: layerOpts, width: "110px" }, { label: "Orientation", key: "rot", type: "num" }, { label: "Unconstrained", key: "unconstrained", type: "check" },
        { label: "X Offset", key: "x", type: "len" }, { label: "Y Offset", key: "y", type: "len" }], fieldRows, { ro, height: "180px" });
      const bar = gridButtons(fg, () => toRow(FPP().newFieldRow({ fields: fg.rows() }, host.activeLayer || "F.Fab", host.textStyle || (() => ({ w: 1, h: 1, thick: 0.15, italic: false })))),
        { ro, addTip: "Add field", delTip: "Delete field", canDelete: (r) => { if (FPP().isMandatoryName(String(r.name)) && r.id) { const n = fg.rows().filter((x) => FPP().isMandatoryName(String(x.name)) && x.id).length; errorMessage(`The first ${n} fields are mandatory.`); return false; } return true; } });
      el.append(box("Fields", fg.el, bar),
        h("div", { class: "pd-cols2" },
          box("Metadata", form([["Footprint name:", name.el], ["Description:", descr.el], ["Keywords:", tags.el], ["Height:", height.el, unitLabel(), "Optional overall height specification for the footprint, independent from any 3D models."]])),
          box("Fabrication Attributes", form([["Component type:", type.el]], true), exSim.el, boardOnly.el, dnp.el, exBom.el, exPos.el)));
    } },
    { label: "Layers", build(el) {
      el.append(h("div", { class: "pd-cols2" },
        box("Custom Layers", custom.el, form([["Copper layers", cuCount.el]]), box("User Layers", userGrid.el, gridButtons(userGrid, () => ({ layer: userLayers().find((l) => !userGrid.rows().some((r) => r.layer === l)) || "User.1" }), { ro }))),
        box("Private Layers", privGrid.el, gridButtons(privGrid, () => ({ layer: privateLayerChoices().find((l) => !privGrid.rows().some((r) => r.layer === l)) || "Dwgs.User" }), { ro }))));
      enableCustom();
    } },
    { label: "Clearance Overrides", build(el) {
      el.append(box("Clearances", note("Leave values blank to use netclass values."),
        form([["Pad clearance:", clr.el, unitLabel(), "This is the local net clearance for all pads of this footprint.\nIf 0, the Netclass values are used.\nThis value can be overridden on a pad-by-pad basis in the Local\nClearance and Settings tab of Pad Properties."],
          ["Solder mask expansion:", mask.el, unitLabel(), "This is the local clearance between pads and the solder mask for \nthis footprint.\nIf 0, the global value is used.\nThis value can be overridden on a pad-by-pad basis in the Local\nClearance and Settings tab of Pad Properties."]]),
        bridges.el,
        form([["Solder paste clearance:", pasteT.el, unitLabel(""), "Local solder paste clearance for this footprint.\nEnter an absolute value (e.g., -0.1mm), a percentage (e.g., -5%), or both (e.g., -0.1mm - 5%).\nIf blank, the global value is used."]]),
        note("Note: solder mask and paste values are used only for pads on copper layers.")),
      box("Courtyards", noCrt.el));
    } },
    { label: "Pad Connections", build(el) {
      el.append(box("Connection to Copper Zones", form([["Pad connection to zones:", zone.el]], true)),
        box("Net Ties", ntGrid.el, gridButtons(ntGrid, () => ({ g: "" }), { ro })),
        box("Jumpers", dupJ.el, jgGrid.el, gridButtons(jgGrid, () => ({ g: "" }), { ro })));
    } },
    { label: "3D Models", build(el) {
      const xyz = (label: string, a: string, b: string, c: string, unit: string) => box(label, form([["X:", mf[a].el, unitLabel(unit)], ["Y:", mf[b].el, unitLabel(unit)], ["Z:", mf[c].el, unitLabel(unit)]]));
      const browse = h("button", { type: "button", class: "kbtn", disabled: ro }, "Browse...");
      browse.addEventListener("click", () => {
        const W = window as unknown as { KiCadLibrary?: Any };
        const pick = (path: string) => { modelGrid.rows().push({ i: -1, file: path, show: true }); modelGrid.refresh(); modelGrid.select(modelGrid.rows().length - 1); syncModels(); };
        if (W.KiCadLibrary && W.KiCadLibrary.pick3DModel) W.KiCadLibrary.pick3DModel().then((p: string) => { if (p) pick(p); }).catch(() => {});
        else pick("${KICAD10_3DMODEL_DIR}/");
      });
      el.append(modelGrid.el, h("div", { class: "pd-row" }, gridButtons(modelGrid, () => ({ i: -1, file: "", show: true }), { ro, addTip: "Add 3D model", delTip: "Remove 3D model", onChange: syncModels }), browse),
        h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:0 12px" }, xyz("Scale", "sx", "sy", "sz", ""), xyz("Rotation", "rx", "ry", "rz", "deg"), xyz("Offset", "ox", "oy", "oz", "mm")),
        form([["Opacity:", opacity]]));
      modelGrid.el.addEventListener("change", () => syncModels());
      if (models.length) { modelGrid.select(0); }
    } },
  ]);
  const collect = (): Any => {
    syncModels();
    const out = { ...m };
    out.name = name.get().trim(); out.descr = descr.get(); out.tags = tags.get(); out.height = height.get();
    out.type = type.get(); out.excludeFromSim = exSim.get(); out.boardOnly = boardOnly.get(); out.dnp = dnp.get(); out.excludeFromBom = exBom.get(); out.excludeFromPos = exPos.get();
    out.privateLayers = privGrid.rows().map((r) => String(r.layer)); out.customStackup = custom.get(); out.copperCount = Number(cuCount.get()); out.userLayers = userGrid.rows().map((r) => String(r.layer));
    out.clearance = clr.get(); out.maskMargin = mask.get(); out.allowBridges = bridges.get(); out.noCourtyard = noCrt.get(); out.zoneConnect = zone.get();
    const p = FPP().parsePaste(pasteT.get(), parseLen); if (p) { out.pasteMargin = p.offset; out.pasteRatio = p.ratio; }
    out.netTieGroups = ntGrid.rows().map((r) => String(r.g || "")); out.dupPadsAreJumpers = dupJ.get(); out.jumperGroups = jgGrid.rows().map((r) => String(r.g || "")).filter((g) => g.trim());
    out.models = models.filter((x: Any) => x.file);
    out.fields = (fieldsGrid ? fieldsGrid.rows() : fieldRows).map((r: Record<string, CellValue>) => ({ ...r, w: Number(r.w), h: Number(r.h), thick: Number(r.thick), rot: Number(r.rot) || 0, x: Number(r.x) || 0, y: Number(r.y) || 0, show: !!r.show, italic: !!r.italic, unconstrained: !!r.unconstrained, name: String(r.name), value: String(r.value), layer: String(r.layer), id: String(r.id || "") }));
    return out;
  };
  const commit = (v: Any): void => { const ch = FPP().fpPropsChanges(doc, v); if (ch.length) ctx.commit(ch, "Edit Footprint Properties"); api && api.close(); };
  api = openDialog({ title: "Footprint Properties", width: 900, readOnly: ro, noEnter: true,
    build(body) { body.append(tabs.el); },
    ok() {
      if (ro) return true;
      const v = collect();
      const err = FPP().validateFpProps(doc, v, { fmt: fmtLenU, libHas: host.libHas });
      if (err && err.overwrite) {
        messageBox("Confirmation", `Footprint '${err.overwrite}' already exists in library '${(host as Any).libName || ""}'.`, [{ label: "Cancel" }, { label: "Overwrite", fn: () => { void (host.overwrite ? host.overwrite(err.overwrite) : Promise.resolve(true)).then((ok) => { if (ok) commit(v); }); } }], 0);
        return false;
      }
      if (err) { tabs.show(err.page); if (err.fix) { err.fix(); if (fieldsGrid) { fieldsGrid.setRows(v.fields.map(toRow)); } } errorMessage(err.msg); return false; }
      const ch = FPP().fpPropsChanges(doc, v); if (ch.length) ctx.commit(ch, "Edit Footprint Properties");
      return true;
    } });
  return !!api;
}

// ---------------------------------------------------------------- Pad Table
export function padTableDialog(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc | null; if (!doc) return false;
  const ro = !!ctx.viewOnly; const cmp = PT().pad.strNumCmp;
  const rows: Record<string, CellValue>[] = PADS().padTableRows(doc, cmp);
  const summary = h("span", { class: "pd-value", "data-k": "padNumbers" }), count = h("span", { class: "pd-value", "data-k": "padCount" }), dups = h("span", { class: "pd-value", "data-k": "duplicatePads" });
  const refresh = (): void => { const s = PADS().padNumberSummary(g.rows().map((r) => String(r.number)), cmp); summary.textContent = s.summary; summary.title = s.summary; count.textContent = String(g.rows().length); dups.textContent = s.duplicates; };
  const g = grid([{ label: "Number", key: "number", width: "70px" }, { label: "Type", key: "type", type: "select", options: PADS().PAD_TYPES }, { label: "Shape", key: "shape", type: "select", options: PADS().PAD_SHAPES },
    { label: "X Position", key: "x", type: "len" }, { label: "Y Position", key: "y", type: "len" }, { label: "Size X", key: "w", type: "len" }, { label: "Size Y", key: "h", type: "len" },
    { label: "Drill X", key: "dx", type: "len", readOnly: (r) => !PADS().drillsEditable(String(r.type)) }, { label: "Drill Y", key: "dy", type: "len", readOnly: (r) => !PADS().drillsEditable(String(r.type)) },
    { label: "Pad->Die Length", key: "dieLen", type: "len" }, { label: "Pad->Die Delay", key: "dieDelay", type: "num" }], rows, { ro, height: "360px", onChange: () => { refresh(); g.refresh(); } });
  refresh();
  const fmtCell = (r: Record<string, CellValue>, k: string): string => { const v = r[k]; if (k === "type") return (PADS().PAD_TYPES.find((t: [string, string]) => t[0] === v) || [0, String(v)])[1]; if (k === "shape") return (PADS().PAD_SHAPES.find((t: [string, string]) => t[0] === v) || [0, String(v)])[1]; if (typeof v === "number") return isFinite(v) ? (k === "dieDelay" ? String(v) : fmtLenU(v)) : ""; return String(v ?? ""); };
  const exportTable = async (toFile: boolean): Promise<void> => {
    const pads = g.rows().filter((r) => !r.complex);
    const go = (): void => {
      const table = [PADS().PAD_TABLE_COLS.map((c: [string, string]) => c[1]), ...pads.map((r) => PADS().PAD_TABLE_COLS.map((c: [string, string]) => fmtCell(r, c[0])))];
      const text = PADS().toCsv(table);
      if (toFile) download(String(FPP().readFpProps(doc).name || "pads") + ".csv", text, "text/csv");
      else { try { void navigator.clipboard.writeText(text); } catch { /* no clipboard */ } }
    };
    if (pads.length < g.rows().length) messageBox("Export Pad Table", "Complex padstacks cannot be exported via CSV.\n\nThey will be skipped.", [{ label: "Cancel" }, { label: "OK", fn: go }], 0); else go();
  };
  const replaceAll = h("input", { type: "radio", name: "padtbl-import", checked: true, "data-k": "replaceExisting" }) as HTMLInputElement;
  const appendTo = h("input", { type: "radio", name: "padtbl-import", "data-k": "appendExisting" }) as HTMLInputElement;
  const importTable = (text: string): void => {
    const csv = PADS().parseCsv(text); if (csv.length < 2) return;
    const cols = csv[0].map((l: string) => PADS().colForLabel(l));
    const unknown = csv[0].filter((_: string, i: number) => !cols[i]);
    const replace = replaceAll.checked;
    if (replace && !cols.includes("number")) { messageBox("Import error", "Imported pad data must include pad numbers."); return; }
    const run = (): void => {
      const byNum = new Map<string, Record<string, CellValue>[]>(); for (const r of g.rows()) { const l = byNum.get(String(r.number)) || []; l.push(r); byNum.set(String(r.number), l); }
      const kept: Record<string, CellValue>[] = [];
      for (const line of csv.slice(1)) {
        const vals: Record<string, string> = {}; cols.forEach((c: string | null, i: number) => { if (c) vals[c] = line[i] ?? ""; });
        const match = replace && vals.number !== undefined ? (byNum.get(vals.number) || []).shift() : undefined;
        const r: Record<string, CellValue> = match ? match : { id: "", number: "", type: "smd", shape: "roundrect", x: 0, y: 0, w: 1, h: 1, dx: NaN, dy: NaN, dieLen: NaN, dieDelay: NaN };
        for (const [k, v] of Object.entries(vals)) {
          if (k === "type") { const t = PADS().PAD_TYPES.find((p: [string, string]) => p[1].toLowerCase() === v.toLowerCase() || p[0] === v); if (t) r.type = t[0]; }
          else if (k === "shape") { const s = PADS().PAD_SHAPES.find((p: [string, string]) => p[1].toLowerCase() === v.toLowerCase() || p[0] === v); if (s) r.shape = s[0]; }
          else if (k === "number") r.number = v;
          else if (k === "dieDelay") r.dieDelay = v.trim() ? Number(v) : NaN;
          else r[k] = v.trim() ? parseLen(v) : NaN;
        }
        kept.push(r);
      }
      g.setRows(replace ? kept : g.rows().concat(kept)); refresh();
    };
    if (unknown.length) messageBox("Errors", `Unknown columns in data: ${unknown.join(", ")}. These columns will be ignored.`, [{ label: "Cancel" }, { label: "OK", fn: run }], 0); else run();
  };
  const fileInput = h("input", { type: "file", accept: ".csv,.tsv,.txt", style: "display:none" }) as HTMLInputElement;
  fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; if (f) void f.text().then(importTable); fileInput.value = ""; });
  const btn = (label: string, k: string, fn: () => void) => { const b = h("button", { type: "button", class: "kbtn", "data-k": k }, label); b.addEventListener("click", fn); return b; };
  return !!openDialog({ title: "Pad Table", width: 1100, readOnly: ro, noEnter: true,
    build(body) {
      body.append(form([["Pad numbers:", summary], ["Pad count:", count], ["Duplicate pads:", dups]], true), g.el,
        h("div", { class: "pd-cols2" },
          box("Export", h("div", { class: "pd-row" }, btn("To File...", "exportFile", () => void exportTable(true)), btn("To Clipboard", "exportClipboard", () => void exportTable(false)))),
          box("Import", h("div", { class: "pd-row" }, h("label", { class: "pd-check" }, replaceAll, "Replace all existing pads"), h("label", { class: "pd-check" }, appendTo, "Append to existing pads")),
            h("div", { class: "pd-row" }, btn("From File...", "importFile", () => fileInput.click()), btn("From Clipboard", "importClipboard", () => { try { void navigator.clipboard.readText().then(importTable); } catch { /* no clipboard */ } }), fileInput))));
    },
    ok() {
      if (ro) return true;
      const out = g.rows().map((r) => ({ ...r, x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h), dx: Number(r.dx), dy: Number(r.dy), dieLen: Number(r.dieLen), dieDelay: Number(r.dieDelay), number: String(r.number), type: String(r.type), shape: String(r.shape), id: String(r.id || "") }));
      const ch = PADS().padTableChanges(doc, out, () => PT().pad.masterPad(doc, "smd", null));
      if (ch.length) ctx.commit(ch, "Edit Pads");
      return true;
    } });
}

// ---------------------------------------------------------------- Push Pad Properties
export function pushPadDialog(ctx: ToolCtx, srcId: string): boolean {
  const doc = ctx.doc as KDoc | null; if (!doc || ctx.viewOnly) return false;
  const st = (window as unknown as { __kcPushPad?: Record<string, boolean> }).__kcPushPad || { shape: false, size: false, layers: false, orient: false, type: false };
  const f = { shape: checkField(st.shape, "Do not modify pads having a different shape", { key: "shape" }), size: checkField(st.size, "Do not modify pads having a different size", { key: "size" }),
    layers: checkField(st.layers, "Do not modify pads having different layers", { key: "layers" }), orient: checkField(st.orient, "Do not modify pads having a different orientation", { key: "orient" }),
    type: checkField(st.type, "Do not modify pads having a different type", { key: "type" }) };
  const run = (): void => {
    const filters = { shape: f.shape.get(), size: f.size.get(), layers: f.layers.get(), orient: f.orient.get(), type: f.type.get() };
    (window as unknown as { __kcPushPad?: Record<string, boolean> }).__kcPushPad = filters;
    const ch = PADS().pushPadChanges(doc, srcId, filters); if (ch.length) ctx.commit(ch, "Push Pad Settings");
  };
  let api: Any = null;
  api = openDialog({ title: "Push Pad Properties", width: 620, okLabel: "Change Pads on Current Footprint",
    extra: [{ label: "Change Pads on Identical Footprints", fn: () => { run(); if (api) api.close(); } }],
    build(body) { body.append(box("Options", f.shape.el, f.size.el, f.layers.el, f.orient.el, f.type.el)); },
    ok() { run(); return true; } });
  return !!api;
}

// ---------------------------------------------------------------- Renumber Pads (the parameters)
export function enumPadsDialog(done: (p: { start: number; step: number; prefix: string }) => void): boolean {
  const mem = (window as unknown as { __kcEnum?: { start: number; step: number; prefix: string } }).__kcEnum || { start: 1, step: 1, prefix: "" };
  const start = numField(mem.start, { key: "start", digits: 0 }), step = numField(mem.step, { key: "step", digits: 0 }), prefix = textField(mem.prefix, { key: "prefix" });
  return !!openDialog({ title: "Renumber Pads", width: 420,
    build(body) {
      body.append(form([["First pad number:", start.el], ["Numbering step:", step.el], ["Pad name prefix:", prefix.el, null, "Optional prefix (e.g. A for A1, A2, etc)"]]),
        note("Pad numbers are assigned in the order you click on pads.  Double-click to finish, or press Esc to cancel."));
    },
    ok() { const p = { start: Math.max(0, Math.round(start.get())), step: Math.max(1, Math.round(step.get())), prefix: prefix.get() }; (window as unknown as { __kcEnum?: unknown }).__kcEnum = p; done(p); return true; } });
}

// ---------------------------------------------------------------- Footprint Checker
let checkerMarkers: Any[] = [];
/** The markers the checker drew (the canvas overlay asks for them). */
export const fpCheckerMarkers = (): Any[] => checkerMarkers;
/**
 * DIALOG_FOOTPRINT_CHECKER: the markers list (a click selects and highlights a marker), Show: All / Errors /
 * Warnings / Exclusions with their counts (OnSeverity: All checks Errors and sets Warnings and Exclusions to
 * itself), Delete Marker (the selected one), Delete All Markers, and Run Checks / Close (SetupStandardButtons).
 */
export function footprintCheckerDialog(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc | null; if (!doc) return false;
  const list = h("div", { class: "pd-report", style: "height:300px", "data-k": "markers" });
  let current = -1;
  const showAll = checkField(false, "All", { key: "show-all", onChange: (v) => { showErr.set(true); showWarn.set(v); showExcl.set(v); draw(); } });
  const showErr = checkField(true, "Errors", { key: "show-errors", onChange: () => draw() }), showWarn = checkField(true, "Warnings", { key: "show-warnings", onChange: () => draw() });
  const showExcl = checkField(false, "Exclusions", { key: "show-exclusions", onChange: () => draw() });
  const visible = (mk: Any): boolean => (mk.excluded ? showExcl.get() : mk.severity === "error" ? showErr.get() : showWarn.get());
  const draw = (): void => {
    list.replaceChildren();
    const shown = checkerMarkers.filter(visible);
    for (const mk of shown) {
      const sevLabel = mk.excluded ? "Excluded" : mk.severity === "error" ? "Error" : "Warning";
      const i = checkerMarkers.indexOf(mk);
      const row = h("div", { class: "ln " + mk.severity + (i === current ? " sel" : ""), style: "cursor:pointer" + (i === current ? ";background:var(--sel)" : ""), "data-k": "marker" }, `[${mk.code}]: ${mk.title}${mk.detail ? " " + mk.detail : ""}  ; ${sevLabel}`);
      row.addEventListener("click", () => { current = i; ctx.setHighlight(new Set(mk.ids)); ctx.requestRender(); draw(); });
      list.append(row);
    }
    if (!shown.length) list.append(h("div", { class: "ln info" }, checkerMarkers.length ? "" : "No footprint problems found."));
    const n = (f: (x: Any) => boolean) => checkerMarkers.filter(f).length;
    (showErr.el.lastChild as Text).textContent = `Errors (${n((x) => !x.excluded && x.severity === "error")})`;
    (showWarn.el.lastChild as Text).textContent = `Warnings (${n((x) => !x.excluded && x.severity === "warning")})`;
    (showExcl.el.lastChild as Text).textContent = `Exclusions (${n((x) => !!x.excluded)})`;
  };
  const show = (): void => { const c = ctx as Any; if (c.setMarkers) c.setMarkers(checkerMarkers.map((mk) => ({ code: mk.code, severity: mk.severity, x: mk.at[0], y: mk.at[1], text: mk.title + (mk.detail ? " " + mk.detail : ""), ids: mk.ids }))); };
  const run = (): void => { checkerMarkers = CHK().checkFootprint(doc); current = -1; draw(); show(); ctx.requestRender(); };
  const deleteOne = (): void => { if (current < 0 || current >= checkerMarkers.length) return; checkerMarkers.splice(current, 1); current = -1; ctx.setHighlight(null); draw(); show(); ctx.requestRender(); };
  const deleteAll = (): void => { checkerMarkers = []; current = -1; draw(); show(); ctx.setHighlight(null); ctx.requestRender(); };
  run();
  return !!openDialog({ title: "Footprint Checker", width: 680, modeless: true, okLabel: "Run Checks", cancelLabel: "Close",
    extra: [{ label: "Delete Marker", fn: deleteOne }, { label: "Delete All Markers", fn: deleteAll }],
    build(body) { body.append(list, h("div", { class: "pd-row", style: "margin-top:6px;gap:10px" }, h("span", { class: "pd-lbl" }, "Show:"), showAll.el, h("span", { style: "width:25px" }), showErr.el, showWarn.el, showExcl.el)); },
    ok() { run(); return false; },
    cancel() { ctx.setHighlight(null); } });
}

// ---------------------------------------------------------------- Footprint users
/** DIALOG_FOOTPRINT_USERS: the symbols of the symbol libraries that use this footprint (pcb-tools fp-users.ts).
 *  "Match type" switches each way of using it; Pins is bold when it equals the footprint's pad count, a derived
 *  symbol is in italics.  `loadLibs` reads the libraries (the status line says so meanwhile). */
export function footprintUsersDialog(fp: { lib: string; name: string; padCount: number }, loadLibs: () => Promise<{ nickname: string; tree: SNode }[]>): boolean {
  const USERS = () => PT().fpUsers;
  const showFilter = checkField(true, "Show footprint filter matches", { key: "showFilter", onChange: () => update() });
  const showField = checkField(true, "Show footprint field matches", { key: "showField", onChange: () => update() });
  const showMaps = checkField(true, "Show pin map matches", { key: "showPinMaps", onChange: () => update() });
  const status = h("div", { class: "pd-lbl", "data-k": "status", style: "margin:6px 0" }, "");
  const table = h("table"); const list = h("div", { class: "pd-grid", style: "height:260px;overflow:auto", "data-k": "users" }, table);
  let libs: { nickname: string; tree: SNode }[] | null = null;
  const update = (): void => {
    table.replaceChildren();
    const head = h("tr"); for (const [label, w] of [["Library", "180px"], ["Symbol", "200px"], ["Pins", "60px"], ["Footprint filter", "160px"], ["Footprint field match", "120px"], ["Pin map match", "160px"]]) head.append(h("th", { style: `width:${w}` }, label));
    table.append(h("thead", null, head));
    if (!libs) return;
    const r = USERS().footprintUsers(libs, { lib: fp.lib, name: fp.name, filters: showFilter.get(), field: showField.get(), pinMaps: showMaps.get() });
    const body = h("tbody");
    for (const m of r.matches) {
      const cb = h("input", { type: "checkbox", checked: !!m.field, disabled: true });
      body.append(h("tr", null, h("td", { class: "ro" }, m.lib), h("td", { class: "ro", style: m.derived ? "font-style:italic" : null }, m.symbol),
        h("td", { class: "ro", style: m.pins === fp.padCount ? "font-weight:bold" : null }, String(m.pins)), h("td", { class: "ro" }, m.filter),
        h("td", { class: "chk" }, cb), h("td", { class: "ro" }, m.pinMaps.join(", "))));
    }
    table.append(body);
    status.textContent = USERS().usersStatus(r.matches.length, r.limited);
  };
  const api = openDialog({ title: "Footprint users", width: 750,
    build(body) {
      body.append(box("Match type", showFilter.el, showField.el, showMaps.el), status, list);
      update(); status.textContent = "Loading symbol libraries (0%)...";
      loadLibs().then((l) => { libs = l; update(); }).catch(() => { libs = []; update(); });
    },
    ok() { return true; } });
  return !!api;
}
