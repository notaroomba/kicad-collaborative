// pcbdialogs/board-setup — File > Board Setup… (DIALOG_BOARD_SETUP, a PAGED_DIALOG).
//
// Where each page's values live, and so how they are stored:
//   .kicad_pro  (board.design_settings, net_settings, text_variables) — Text & Graphics > Defaults,
//               the footprint options of Formatting, Text Variables, Constraints, Pre-defined Sizes,
//               Net Classes, Violation Severity, the solder mask to copper clearance.  Written as a new
//               project file (editor/projectfile.ts), which the desktop reads like any other.
//   .kicad_pcb  ((layers …) and (setup …)) — Board Editor Layers, Physical Stackup's copper layer count,
//               Board Finish, Solder Mask/Paste, the dashed line ratios.  These sections are not items,
//               so they travel in a BOARD_SETUP change (canvas/board-setup.ts) that web editors apply and
//               replay; the desktop application does not read it.
//   .kicad_dru  — Custom Rules, the file's text.
// The pages KiCad 10 added (Drill Chart, Microvia Stacks, Zones, Length-tuning Patterns, Tuning Profiles, Component
// Classes, Embedded Files) are in ./board-setup-pages.  Embedded Files is a list: the files live in the board file.
// Only pages that were opened are written back, as in KiCad (its pages are created lazily too).  A page that does not
// validate keeps the focus (PAGED_DIALOG::onPageChanging); OK checks every opened page and SetError shows the first
// problem in the info bar, switches to its page and focuses the control or grid cell.
import { E } from "../state";
import { state } from "../appstore";
import { api, toast } from "../util";
import { sendOp } from "../net";
import { applyChanges } from "../doc";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { DEFAULTS_DEFAULTS, DIMENSION_DEFAULTS, LAYER_CLASSES, NETCLASS_DEFAULTS, NETCLASS_INT_KEYS, RULE_DEFAULTS, editProject, parseProject, toPlain, type Plain, type ProjectEdit } from "../../canvas/project-file";
import type { BoardHeader, LayerRow } from "../../canvas/board-setup";
import { adoptProjectFile, canWriteProject, liveDocument, loadProjectFile, projectDoc, saveProjectFile, saveTextDocument } from "../projectfile";
import { BS } from "./canvas";
import { put, box, checkField, currentUnits, focusError, form, grid, gridButtons, h, iconButton, infoBar, lenField, messageBox, note, numField, openDialog, selectField, spinField, textEntryBox, unitLabel, unitName, fmtLen, fmtLenU, parseLen, swatch, type CellValue, type Field, type TreeGroup, treeBook } from "./ui";
import { colorPicker, fromHex, toHex, type RGBA } from "./color-picker";
import { drillChartPage, viaStacksPage, zonesPage, tuningPatternsPage, tuningProfilesPage, componentClassesPage, embeddedFilesPage, IMPORT_OPTIONS, type PageError, type SetupCtx } from "./board-setup-pages";
import { ruleAtLine, ruleErrors, rulesEditor } from "./rules-editor";
import { markdownToHtml } from "../markdown";
import { RULES_HELP_MD } from "../../generated/rules-help";
import { IS_MAC } from "../../keys";
import type { DrillProfile, StackupLayer } from "../../canvas/board-setup";

type Obj = { [key: string]: Plain };
const isObj = (v: Plain | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: Plain | undefined): Obj => (isObj(v) ? v : {});
const arr = (v: Plain | undefined): Plain[] => (Array.isArray(v) ? v : []);
const numOr = (v: Plain | undefined, d: number): number => (typeof v === "number" ? v : d);
const boolOr = (v: Plain | undefined, d: boolean): boolean => (typeof v === "boolean" ? v : d);

/** The board file's header sections as the server has them now (snapshot plus journalled BOARD_SETUP changes). */
export async function loadBoardHeader(): Promise<BoardHeader | null> {
  const docId = state.docId as string | null; if (!docId) return null;
  const cached = (E.kdoc as (KDoc & { boardSetup?: BoardHeader }) | null)?.boardSetup;
  let file = "", ops: { changes: KChange[] }[] = [];
  try { const live = await liveDocument(docId); file = live.file; ops = live.ops; }
  catch (e) { try { const t = await (api(`/api/docs/${docId}/content`) as Promise<unknown>); file = typeof t === "string" ? t : ""; } catch (e2) { file = ""; } }
  if (!file) return cached || null;
  let header = BS().boardHeader(file);
  for (const op of ops) for (const c of op.changes || []) header = BS().applyHeaderChange(header, c);
  return header;
}

const BOARD_NOTE = "Stored in the board file. Web editors of this board share the change; the desktop application keeps the values of its own copy.";

interface PageState { edits(): ProjectEdit[] }

const MASK_TIPS = {
  exp: "Global clearance between pads and the solder mask.\nThis value can be superseded by local values for a footprint or a pad.\nPositive clearance means a solder mask opening bigger than the pad (typical for solder mask clearance).",
  web: "Minimum distance between openings in the solder mask.\nPad openings closer than this distance will be plotted as a single opening.",
  toCu: "Minimum distance between a solder mask opening and a copper item with a different net than the solder mask opening's parent.\nDistances smaller than this minimum will create a DRC error.",
  paste: "Solder paste clearance relative to pad size.\nEnter an absolute value (e.g., -0.1mm), a percentage (e.g., -5%), or both (e.g., -0.1mm - 5%).\nThis value can be superseded by local values for a footprint or a pad.",
  ratio: "Global clearance ratio between pads and the solder paste as a percentage of the pad size.\nA value of 10 means the clearance value is 10 percent of the pad size.\nThis value can be superseded by local values for a footprint or a pad.\nFinal clearance value is the sum of this value and the absolute clearance value.",
};
/** KiCad's CSS colour of a COLOR4D ("rgba(r, g, b, a)") from the picker's RGBA, and back. */
const cssOf = (c: RGBA): string => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a.toFixed(3)})`;
function rgbaOf(css: string): RGBA | null {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(css || "");
  if (m) return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
  return css ? fromHex(css) : null;
}
const pickColor = (current: string, done: (css: string) => void): void => colorPicker(rgbaOf(current), true, (c) => done(cssOf(c)), { r: 0, g: 0, b: 0, a: 0 });
void toHex;

export async function openBoardSetup(ctx: ToolCtx, startPage?: string): Promise<void> {
  if (!E.kdoc || E.kdoc.type !== "pcb") { toast("Board Setup needs a board"); return; }
  const [proText0, header0] = await Promise.all([loadProjectFile(), loadBoardHeader()]);
  let proText = proText0, header = header0;
  const dru = projectDoc("design_rules");
  let druText = "";
  if (dru) { try { druText = (await liveDocument(dru.docId)).file; } catch (e) { druText = ""; } }
  let boardText = "";
  try { const id = state.docId as string | null; if (id) boardText = (await liveDocument(id)).file; } catch (e) { boardText = ""; }
  let pro = obj(proText ? toPlain(parseProject(proText)) : null);
  let ds = obj(obj(pro.board).design_settings), rules = obj(ds.rules), defaults = obj(ds.defaults), net = obj(pro.net_settings);
  const canPro = !!proText && canWriteProject(), canBoard = !!header && canWriteProject();
  const roPro = !canPro, roBoard = !canBoard;
  const DS = ["board", "design_settings"];
  const pages = new Map<string, PageState>();
  // a page writes only what was changed on it: the values it showed when it was first built are remembered here
  // (an import rebuilds pages over the other board's values; those differ from these and so are written)
  const initial = new Map<string, string>();
  const pathKey = (e: ProjectEdit): string => e.path.join("\u0000");
  const register = (label: string, p: PageState): void => { pages.set(label, p); for (const e of p.edits()) if (!initial.has(pathKey(e))) initial.set(pathKey(e), JSON.stringify(e.value)); };
  /** Validate + TransferDataFromWindow of each page: the first problem, with the control SetError focuses */
  const validators = new Map<string, () => PageError | null>();
  const validate = (label: string, fn: () => PageError | null): void => { validators.set(label, fn); };
  // board-file state shared between the layer and stackup pages
  let layerRows: LayerRow[] = BS().layerRows(header ? header.layers : null);
  const layers0 = BS().layersText(layerRows);
  let layersTouched = false, refreshLayers: (() => void) | null = null, refreshStackup: (() => void) | null = null;
  const setupEdit: Parameters<ReturnType<typeof BS>["editSetup"]>[1] = {};
  if (!dru) druText = "(version 2)\n";     // PANEL_SETUP_RULES::TransferDataToWindow for a board without a rules file
  let rules0 = druText, rulesEd: ReturnType<typeof rulesEditor> | null = null;
  const bar = infoBar();
  let book: ReturnType<typeof treeBook> | null = null;
  /** PAGED_DIALOG::SetError: the info bar for 10 s, the page shown, the control (or grid cell) focused */
  const setError = (page: string, e: PageError): void => { if (book) book.show(page, true); bar.show(e.msg, 10000); focusError(e.ctrl, e.row, e.col); };

  // ------------------------------------------------------------ Board Stackup
  const layersPage = (el: HTMLElement): void => {
    const host = h("div", { class: "pd-layers" });
    const boxes = new Map<string, HTMLInputElement>();
    const draw = (): void => {
      host.replaceChildren(); boxes.clear();
      const table = h("table", { class: "pd-layertable" });
      for (const r of layerRows) {
        const cb = h("input", { type: "checkbox", checked: r.enabled, disabled: roBoard || r.mandatory || r.copper, title: r.copper ? "Use the Physical Stackup page to change the number of copper layers." : r.mandatory ? "This layer is required and cannot be disabled" : "If you want this layer in your board, check this box" });
        cb.addEventListener("change", () => { r.enabled = cb.checked; layersTouched = true; });
        boxes.set(r.name, cb);
        const shown = r.userName || (r.copper || r.userDefined ? r.name : BS().defaultLayerName(r.name));
        const name = h("input", { type: "text", value: shown, readOnly: roBoard, "data-layer": r.name, title: "Layer Name" });
        name.addEventListener("change", () => {
          const v = name.value.trim(), err = BS().layerNameError(layerRows, r, v);
          if (err) { setError("Board Editor Layers", { msg: err, ctrl: name }); name.value = shown; return; }
          r.userName = v === r.name || (!r.copper && !r.userDefined && v === BS().defaultLayerName(r.name)) ? "" : v; layersTouched = true;
        });
        let type: HTMLElement;
        if (r.copper || r.userDefined) {
          const opts = r.copper ? BS().COPPER_TYPES : BS().USER_TYPES;
          const s = h("k-select", { disabled: roBoard, title: r.copper ? "Copper layer type for Freerouter and other external routers.\nPower plane layers are removed from Freerouter's layer menus." : "Layer type" });
          for (const [v, label] of opts) { const o = h("option", { value: v }, label); if (v === r.type) o.selected = true; s.append(o); }
          s.addEventListener("change", () => { r.type = s.value; layersTouched = true; });
          type = s;
        } else type = h("span", { class: "desc" }, r.description);
        table.append(h("tr", { class: r.copper ? "cu" : "" }, h("td", { class: "chk" }, cb), h("td", null, name), h("td", null, type)));
      }
      put(host, table);
    };
    refreshLayers = draw; draw();
    const add = h("button", { type: "button", disabled: roBoard }, "Add User Defined Layer...");
    add.addEventListener("click", () => {
      const used = new Set(layerRows.filter((r) => r.userDefined).map((r) => r.name));
      let n = 1; while (n <= 45 && used.has(`User.${n}`)) n++;
      if (n > 45) { bar.show("All user defined layers are in use", 10000); return; }
      layerRows.push({ name: `User.${n}`, id: 39 + 2 * (n - 1), type: "user", userName: "", enabled: true, copper: false, mandatory: false, description: "", userDefined: true });
      layerRows.sort((a, b) => (a.userDefined && b.userDefined ? a.id - b.id : 0));
      layersTouched = true; draw();
    });
    put(el, h("div", { class: "pd-row" }, add), host, roBoard ? null : note(BOARD_NOTE));
    validate("Board Editor Layers", () => {
      // a layer that still carries items is not switched off here: Board Setup does not delete design content
      const used = new Map<string, number>();
      if (E.kdoc) for (const it of E.kdoc.items.values()) { const seen = new Set<string>(); for (const g of it.geom || []) if (g.layer && !seen.has(g.layer)) { seen.add(g.layer); used.set(g.layer, (used.get(g.layer) || 0) + 1); } }
      for (const r of layerRows) if (!r.enabled && (used.get(r.name) || 0) > 0) return { msg: `Layer ${r.userName || r.name} still carries ${used.get(r.name)} item(s) and cannot be removed here. Move or delete them first.`, ctrl: boxes.get(r.name) };
      return null;
    });
  };

  // stackup items as the Physical Stackup page edits them; null until the page is built
  let stack: StackupLayer[] | null = null, impedance: Field<boolean> | null = null;
  const stackupPage = (el: HTMLElement): void => {
    const counts: [number, string][] = []; for (let n = 2; n <= 32; n += 2) counts.push([n, String(n)]);
    const cuNow = (): number => layerRows.filter((r) => r.copper).length;
    const fromHeader = (): StackupLayer[] => BS().stackupLayers(header ? BS().editSetup(header.setup, setupEdit.copper ? { copper: setupEdit.copper, boardThickness: setupEdit.boardThickness } : {}) : null);
    stack = fromHeader();
    const count = selectField<number>(cuNow(), counts, { ro: roBoard, key: "copperCount", onChange: (n) => {
      const inner = layerRows.filter((r) => r.copper).map((r) => r.name).slice(n - 1, -1);   // the inner layers that go away
      const busy = inner.filter((name) => E.kdoc && Array.from((E.kdoc as KDoc).items.values()).some((it) => (it.geom || []).some((g) => g.layer === name)));
      if (busy.length) { setError("Physical Stackup", { msg: `Items have been found on ${busy.join(", ")}: move or delete them before removing the layer.`, ctrl: count.input }); count.set(cuNow()); return; }
      layerRows = BS().setCopperCount(layerRows, n); layersTouched = true;
      setupEdit.copper = layerRows.filter((r) => r.copper).map((r) => r.name);
      setupEdit.boardThickness = header && header.general ? Number((KiCadCanvas.kid(header.general, "thickness") as SNode | null)?.[1]) || 1.6 : 1.6;
      stack = fromHeader(); touched = false;
      if (refreshLayers) refreshLayers(); draw();
    } });
    count.input.title = "Select the number of copper layers in the stackup";
    const st0 = header && header.setup ? (KiCadCanvas.kid(header.setup, "stackup") as SNode | null) : null;
    impedance = checkField(st0 ? String(((KiCadCanvas.kid(st0, "dielectric_constraints") as SNode | null) || [])[1]) === "yes" : false, "Impedance controlled", { ro: roBoard, key: "impedance", tip: "If Impedance Controlled option is set,\nLoss tangent and EpsilonR will be added to constraints.", onChange: () => { touched = true; } });
    let touched = false, selRow = -1;
    const host = h("div"), total = h("span", { class: "pd-value", "data-k": "stackupThickness" });
    const userName = (n: string): string => { const r = layerRows.find((x) => x.name === n); return (r && r.userName) || n; };
    const MATERIALS: Record<string, [string, number, number][]> = {
      dielectric: [["FR4", 4.5, 0.02], ["FR408-HR", 3.69, 0.0091], ["Polyide", 3.2, 0.004], ["Kapton", 3.2, 0.004], ["Polyimide", 3.2, 0.004], ["Teflon", 2.1, 0.0004], ["PTFE", 2.1, 0.0004], ["Aluminum", 8.7, 0.001]],
      mask: [["Epoxy", 3.3, 0], ["Liquid Ink", 3.3, 0], ["Dry Film", 3.3, 0]], silk: [["Liquid Photo", 0, 0], ["Direct Printing", 0, 0]] };
    const COLORS: Record<string, string[]> = { mask: ["Green", "Red", "Blue", "Purple", "Black", "White", "Yellow", "Matte Green", "Matte Black", "Not specified"], silk: ["White", "Yellow", "Black", "Not specified"], dielectric: ["FR4 natural", "PTFE natural", "Polyimide", "Phenolic natural", "Aluminum", "Not specified"] };
    const kindOf = (l: StackupLayer): string => (l.type === "core" || l.type === "prepreg" ? "dielectric" : /Solder Mask/.test(l.type) ? "mask" : /Silk/.test(l.type) ? "silk" : /Paste/.test(l.type) ? "paste" : "copper");
    const draw = (): void => {
      host.replaceChildren();
      if (!stack || !stack.length) { host.append(note("This board has no physical stackup.")); total.textContent = ""; return; }
      const table = h("table");
      const head = h("tr"); for (const t of ["Layer", "Id", "Type", "Material", "Thickness", "", "Color", "Epsilon R", "Loss Tan"]) head.append(h("th", null, t));
      table.append(h("thead", null, head));
      const body = h("tbody");
      let row = 0;
      const mk = (l: StackupLayer, sub: { thickness: number; locked?: boolean; material: string; epsilonR: number; lossTangent: number; color?: string } | null, subIdx: number): void => {
        const o = (sub || l) as { thickness?: number; locked?: boolean; material?: string; epsilonR?: number; lossTangent?: number; color?: string };
        const k = kindOf(l), d = /^dielectric (\d+)$/.exec(l.name), r = row++;
        const tr = h("tr", { class: r === selRow ? "sel" : "", "data-row": r });
        tr.addEventListener("pointerdown", () => { selRow = r; Array.from(body.children).forEach((x, i) => x.classList.toggle("sel", i === r)); });
        const label = d ? `Dielectric ${d[1]}${l.subs && l.subs.length ? ` (${subIdx + 1}/${l.subs.length + 1})` : ""}` : userName(l.name);
        tr.append(h("td", { class: "txt" }, label), h("td", { class: "ro" }, d ? d[1] : ""));
        if (k === "dielectric" && !sub) { const s = selectField<string>(l.type, [["core", "Core"], ["prepreg", "PrePreg"]], { ro: roBoard, onChange: (v) => { l.type = v; touched = true; } }); tr.append(h("td", null, s.el)); }
        else tr.append(h("td", { class: "ro" }, l.type === "copper" ? "Copper" : l.type === "core" ? "Core" : l.type === "prepreg" ? "PrePreg" : l.type));
        // material: KiCad's "..." button opens DIALOG_DIELECTRIC_MATERIAL; here the material list of the kind, editable
        if (k === "dielectric" || k === "mask" || k === "silk") {
          const mat = h("input", { type: "text", value: o.material || "", disabled: roBoard, list: "" });
          mat.addEventListener("change", () => { o.material = mat.value; const m = (MATERIALS[k] || []).find((x) => x[0].toLowerCase() === mat.value.toLowerCase()); if (m && k !== "silk") { o.epsilonR = m[1]; o.lossTangent = m[2]; draw(); } touched = true; });
          const pick = h("button", { type: "button", class: "pd-iconbtn", disabled: roBoard, title: "Select a material" }, "...");
          pick.addEventListener("click", (ev) => { const r2 = (ev.target as HTMLElement).getBoundingClientRect(); void import("../../dialogs/dom").then((m) => m.popupMenu(r2.left, r2.bottom, (MATERIALS[k] || []).map(([name, er, lt]) => ({ label: k === "silk" ? name : `${name}  (Er ${er}, LT ${lt})`, run: () => { o.material = name; if (k !== "silk") { o.epsilonR = er; o.lossTangent = lt; } touched = true; draw(); } })))); });
          tr.append(h("td", null, h("span", { style: "display:flex" }, mat, pick)));
        } else tr.append(h("td", { class: "ro" }, o.material || ""));
        if (o.thickness !== undefined && k !== "paste") {
          const th = lenField(o.thickness, { ro: roBoard, onChange: (v) => { o.thickness = v; touched = true; total.textContent = fmtLenU(BS().stackupLayersThickness(stack || [])); } });
          tr.append(h("td", null, th.el));
          const lock = h("input", { type: "checkbox", checked: !!o.locked, disabled: roBoard || k !== "dielectric", title: "Lock the thickness of this layer when adjusting dielectric thickness" });
          lock.addEventListener("change", () => { o.locked = lock.checked; touched = true; });
          tr.append(h("td", { class: "chk" }, k === "dielectric" ? lock : null));
        } else tr.append(h("td", { class: "ro" }), h("td"));
        if (k === "mask" || k === "silk" || k === "dielectric") {
          const opts = (COLORS[k] || []).map((c): [string, string] => [c, c]); const cur = o.color || "Not specified";
          const c = selectField<string>(cur, opts.some((x) => x[0] === cur) ? opts : [[cur, cur], ...opts], { ro: roBoard, onChange: (v) => { o.color = v === "Not specified" ? undefined : v; touched = true; } });
          c.el.style.minWidth = "120px"; tr.append(h("td", null, c.el));
        } else tr.append(h("td", { class: "ro" }));
        if (k === "dielectric" || k === "mask") {
          const er = numField(o.epsilonR ?? 1, { ro: roBoard }); er.input.addEventListener("change", () => { o.epsilonR = er.get(); touched = true; });
          const lt = numField(o.lossTangent ?? 0, { ro: roBoard }); lt.input.addEventListener("change", () => { o.lossTangent = lt.get(); touched = true; });
          tr.append(h("td", null, er.el), h("td", null, lt.el));
        } else tr.append(h("td", { class: "ro" }), h("td", { class: "ro" }));
        body.append(tr);
      };
      for (const l of stack) { mk(l, null, 0); (l.subs || []).forEach((s, i) => mk(l, s, i + 1)); }
      table.append(body);
      host.append(h("div", { class: "pd-grid", style: "max-height:330px", "data-k": "stackupGrid" }, table));
      total.textContent = fmtLenU(BS().stackupLayersThickness(stack));
    };
    refreshStackup = draw; draw();
    const dielectrics = (): string[] => (stack || []).filter((l) => /^dielectric \d+$/.test(l.name)).map((l) => l.name.replace("dielectric", "Layer"));
    const addDiel = (): void => {
      const names = dielectrics(); if (!names.length) return;
      void import("../../dialogs/dom").then((m) => { const r = addBtn.getBoundingClientRect(); m.popupMenu(r.left, r.bottom, names.map((n) => ({ label: n, run: () => {
        const l = (stack || []).find((x) => x.name === n.replace("Layer", "dielectric")); if (!l) return;
        (l.subs = l.subs || []).push({ thickness: l.thickness || 0.1, material: l.material || "FR4", epsilonR: l.epsilonR ?? 4.5, lossTangent: l.lossTangent ?? 0.02 }); touched = true; draw(); } }))); });
    };
    const removeDiel = (): void => {
      const withSubs = (stack || []).filter((l) => l.subs && l.subs.length);
      if (!withSubs.length) { bar.show("No sub-layer to remove: a dielectric layer can only lose the sub-layers added to it.", 10000); return; }
      void import("../../dialogs/dom").then((m) => { const r = removeBtn.getBoundingClientRect(); m.popupMenu(r.left, r.bottom, withSubs.map((l) => ({ label: l.name.replace("dielectric", "Layer"), run: () => { (l.subs as unknown[]).pop(); touched = true; draw(); } }))); });
    };
    const adjust = (): void => {
      if (!stack) return;
      const min = BS().stackupFixedThickness(stack);
      const title = min === 0 ? `Enter board thickness in ${unitName()}:` : `Enter expected board thickness (min value ${fmtLenU(min)}):`;
      textEntryBox("Adjust Unlocked Dielectric Layers", title, "", false, (t) => {
        const v = parseLen(t); if (isNaN(v)) return;
        if (v < min) { messageBox("Message", `Value too small (min value ${fmtLenU(min)}).`); return; }
        const err = BS().adjustDielectrics(stack as StackupLayer[], v); if (err) messageBox("Message", err);
        touched = true; draw();
      });
    };
    const exportClip = (): void => {
      // PANEL_SETUP_BOARD_STACKUP::onExportToClipboard: the stackup as text, one item per line
      const lines = (stack || []).flatMap((l) => [l, ...(l.subs || []).map((s) => ({ ...l, ...s, subs: undefined, name: l.name }))]).map((l) => [l.name, l.type, l.material || "", l.thickness !== undefined ? fmtLenU(l.thickness) : "", l.color || "", l.epsilonR ?? "", l.lossTangent ?? ""].join("\t"));
      void navigator.clipboard?.writeText(lines.join("\n") + `\nBoard thickness: ${fmtLenU(BS().stackupLayersThickness(stack || []))}\n`);
    };
    const addBtn = h("button", { type: "button", class: "btn", disabled: roBoard, onclick: addDiel }, "Add Dielectric Layer..."), removeBtn = h("button", { type: "button", class: "btn", disabled: roBoard, onclick: removeDiel }, "Remove Dielectric Layer...");
    put(el, h("div", { class: "pd-row" }, h("label", null, "Copper layers:"), count.el, impedance.el, h("span", { style: "flex:1" }), addBtn, removeBtn), host,
      h("div", { class: "pd-row" }, h("label", null, "Board thickness from stackup:"), total, h("span", { style: "flex:1" }), h("button", { type: "button", class: "btn", disabled: roBoard, onclick: adjust }, "Adjust Dielectric Thickness"), h("button", { type: "button", class: "btn", onclick: exportClip }, "Export to Clipboard")),
      roBoard ? null : note(BOARD_NOTE));
    validate("Physical Stackup", () => {
      if (touched && stack && header) {
        const fin = finishNow ? finishNow() : BS().boardFinish(header.setup);
        setupEdit.stackup = BS().stackupText(stack, fin, !!(impedance && impedance.get()));
        setupEdit.boardThickness = BS().stackupLayersThickness(stack);
      }
      return null;
    });
  };

  let finishNow: (() => ReturnType<ReturnType<typeof BS>["boardFinish"]>) | null = null;
  const finishPage = (el: HTMLElement): void => {
    const f = BS().boardFinish(header ? header.setup : null);
    const plated = checkField(f.edgePlating, "Plated board edge", { ro: roBoard, key: "edgePlating" });
    const finish = selectField<string>(f.copperFinish, (BS().COPPER_FINISHES.includes(f.copperFinish) ? BS().COPPER_FINISHES : [f.copperFinish, ...BS().COPPER_FINISHES]).map((x): [string, string] => [x, x]), { ro: roBoard, key: "copperFinish" });
    const edge = selectField<string>(f.edgeConnector, [["no", "None"], ["yes", "Yes"], ["bevelled", "Yes, bevelled"]], { ro: roBoard, key: "edgeConnector" });
    edge.input.title = "Options for edge card connectors.";
    put(el, plated.el, form([["Copper finish:", finish.el], ["Edge card connectors:", edge.el]]), roBoard ? null : note(BOARD_NOTE));
    finishNow = () => ({ copperFinish: finish.get(), edgeConnector: edge.get() as "no" | "yes" | "bevelled", edgePlating: plated.get(), hasStackup: f.hasStackup });
    validate("Board Finish", () => {
      const now = (finishNow as () => ReturnType<ReturnType<typeof BS>["boardFinish"]>)();
      if (now.copperFinish !== f.copperFinish || now.edgeConnector !== f.edgeConnector || now.edgePlating !== f.edgePlating) setupEdit.finish = now;
      return null;
    });
  };

  const maskPage = (el: HTMLElement): void => {
    const m = BS().maskPaste(header ? header.setup : null);
    const exp = lenField(m.maskExpansion, { ro: roBoard, key: "maskExpansion" }), web = lenField(m.maskMinWidth, { ro: roBoard, key: "maskMinWidth" });
    const toCu = lenField(numOr(rules.solder_mask_to_copper_clearance, 0), { ro: roPro, key: "maskToCopper" });
    const bridges = checkField(m.allowBridges, "Allow bridged solder mask apertures between pads within footprints", { ro: roBoard, key: "allowBridges", tip: "Disable DRC error checking for solder mask aperture bridging between pads in the same footprint." });
    const paste = lenField(m.pasteClearance, { ro: roBoard, key: "pasteClearance" }), ratio = numField(+(m.pasteRatio * 100).toFixed(4), { ro: roBoard, key: "pasteRatio" });
    exp.input.title = MASK_TIPS.exp; web.input.title = MASK_TIPS.web; toCu.input.title = MASK_TIPS.toCu; paste.input.title = MASK_TIPS.paste; ratio.input.title = MASK_TIPS.ratio;
    put(el,
      note("Consult your PCB manufacturer's specifications for solder mask expansion, web width, and clearance settings."),
      note("If no specifications are provided, setting these values to zero is recommended."),
      box("Solder Mask Settings", form([["Solder mask expansion:", exp.el, unitLabel(), MASK_TIPS.exp], ["Solder mask minimum web width:", web.el, unitLabel(), MASK_TIPS.web], ["Solder mask to copper clearance:", toCu.el, unitLabel(), MASK_TIPS.toCu], bridges.el])),
      box("Solder Paste Settings", form([["Solder paste clearance:", paste.el, unitLabel(), MASK_TIPS.paste], ["Solder paste relative clearance:", ratio.el, unitLabel("%"), MASK_TIPS.ratio]])),
      roBoard ? null : note("The solder mask to copper clearance is stored in the project file. The other values: " + BOARD_NOTE.replace("Stored", "stored")));
    validate("Solder Mask/Paste", () => {
      const issues = BS().validateDesignRules({}, currentUnits(), { maskExpansion: exp.get(), maskMinWidth: web.get(), maskToCopper: toCu.get(), pasteMargin: paste.get(), pasteRatio: ratio.get() / 100 });
      const ctrl: Record<string, HTMLElement> = { solder_mask_expansion: exp.input, solder_mask_min_width: web.input, solder_mask_to_copper_clearance: toCu.input, solder_paste_margin: paste.input, solder_paste_margin_ratio: ratio.input };
      if (issues.length) return { msg: issues[0].message, ctrl: ctrl[issues[0].setting] };
      // the tenting flags are not on this page in KiCad 10 (they moved to the padstack); the file's values stay
      const now = { maskExpansion: exp.get(), maskMinWidth: web.get(), pasteClearance: paste.get(), pasteRatio: +(ratio.get() / 100).toFixed(6), allowBridges: bridges.get(), tentFront: m.tentFront, tentBack: m.tentBack };
      if ((Object.keys(now) as (keyof typeof now)[]).some((k) => now[k] !== m[k])) setupEdit.maskPaste = now;
      return null;
    });
    register("Solder Mask/Paste", { edits: () => [{ path: [...DS, "rules", "solder_mask_to_copper_clearance"], value: toCu.get() }] });
  };

  // ------------------------------------------------------------ Text & Graphics
  const defaultsPage = (el: HTMLElement): void => {
    const val = (k: string): number => numOr(defaults[k], Number(DEFAULTS_DEFAULTS[k]));
    const rows: Record<string, CellValue>[] = LAYER_CLASSES.map(([stem, label]) => {
      const text = `${stem}_text_size_h` in DEFAULTS_DEFAULTS;
      return { stem, label, line: val(`${stem}_line_width`), w: text ? val(`${stem}_text_size_h`) : NaN, ht: text ? val(`${stem}_text_size_v`) : NaN, th: text ? val(`${stem}_text_thickness`) : NaN,
        italic: text ? boolOr(defaults[`${stem}_text_italic`], false) : false, upright: text ? boolOr(defaults[`${stem}_text_upright`], false) : false, text };
    });
    const noText = (r: Record<string, CellValue>): boolean => !r.text;
    const g = grid([{ label: "", key: "label", type: "ro", width: "120px" }, { label: "Line Thickness", key: "line", type: "len" }, { label: "Text Width", key: "w", type: "len", readOnly: noText },
      { label: "Text Height", key: "ht", type: "len", readOnly: noText }, { label: "Text Thickness", key: "th", type: "len", readOnly: noText }, { label: "Italic", key: "italic", type: "check", readOnly: noText }, { label: "Keep Upright", key: "upright", type: "check", readOnly: noText }], rows, { ro: roPro, key: "defaultsGrid" });
    // PANEL_SETUP_DIMENSIONS
    const dim = obj(defaults.dimensions), dd = DIMENSION_DEFAULTS;
    const dUnits = selectField<number>(numOr(defaults.dimension_units, 3), [[0, "Inches"], [1, "Mils"], [2, "Millimeters"], [3, "Automatic"]], { ro: roPro, key: "dimensionUnits" });
    const dPos = selectField<number>(numOr(dim.text_position, Number(dd.text_position)), [[0, "Outside"], [1, "Inline"]], { ro: roPro, key: "dimensionTextPosition" });
    dPos.input.title = "Where to position the dimension text relative to the dimension line";
    const dFmt = selectField<number>(numOr(dim.units_format, Number(dd.units_format)), [[0, "1234"], [1, "1234 mm"], [2, "1234 (mm)"]], { ro: roPro, key: "dimensionUnitsFormat" });
    const dAligned = checkField(boolOr(dim.keep_text_aligned, !!dd.keep_text_aligned), "Keep text aligned", { ro: roPro, key: "dimensionKeepAligned", tip: "When checked, dimension text will be kept aligned with dimension lines" });
    const dPrec = selectField<number>(Math.min(5, numOr(defaults.dimension_precision, 4)), [[0, "0"], [1, "0.0"], [2, "0.00"], [3, "0.000"], [4, "0.0000"], [5, "0.00000"]], { ro: roPro, key: "dimensionPrecision" });
    dPrec.input.title = "How many digits of precision to show";
    const dArrow = lenField(numOr(dim.arrow_length, Number(dd.arrow_length)) / 1e6, { ro: roPro, key: "dimensionArrowLength" });
    const dZeroes = checkField(boolOr(dim.suppress_zeroes, !!dd.suppress_zeroes), "Suppress trailing zeroes", { ro: roPro, key: "dimensionSuppressZeroes" });
    const dExt = lenField(numOr(dim.extension_offset, Number(dd.extension_offset)) / 1e6, { ro: roPro, key: "dimensionExtensionOffset" });
    put(el, box("Default Properties for New Graphics and Text", g.el),
      box("Default Properties for New Dimension Objects", h("div", { class: "pd-cols3" },
        form([["Units:", dUnits.el], ["Text position:", dPos.el, null, "Where to position the dimension text relative to the dimension line"]]),
        form([["Units format:", dFmt.el], dAligned.el]),
        form([["Precision:", dPrec.el, null, "How many digits of precision to show"], ["Arrow length:", dArrow.el, unitLabel()], dZeroes.el, ["Extension line offset:", dExt.el, unitLabel()]]))));
    register("Defaults", { edits: () => {
      const out: ProjectEdit[] = [], P = [...DS, "defaults"];
      for (const r of g.rows()) {
        const stem = String(r.stem);
        if (isFinite(Number(r.line))) out.push({ path: [...P, `${stem}_line_width`], value: Number(r.line) });
        if (!r.text) continue;
        for (const [k, key] of [["w", "text_size_h"], ["ht", "text_size_v"], ["th", "text_thickness"]]) if (isFinite(Number(r[k]))) out.push({ path: [...P, `${stem}_${key}`], value: Number(r[k]) });
        out.push({ path: [...P, `${stem}_text_italic`], value: !!r.italic }, { path: [...P, `${stem}_text_upright`], value: !!r.upright });
      }
      out.push({ path: [...P, "dimension_units"], value: dUnits.get(), ints: true }, { path: [...P, "dimension_precision"], value: dPrec.get(), ints: true },
        { path: [...P, "dimensions", "units_format"], value: dFmt.get(), ints: true }, { path: [...P, "dimensions", "text_position"], value: dPos.get(), ints: true },
        { path: [...P, "dimensions", "keep_text_aligned"], value: dAligned.get() }, { path: [...P, "dimensions", "suppress_zeroes"], value: dZeroes.get() },
        { path: [...P, "dimensions", "arrow_length"], value: Math.round(dArrow.get() * 1e6), ints: true }, { path: [...P, "dimensions", "extension_offset"], value: Math.round(dExt.get() * 1e6), ints: true });
      return out;
    } });
    validate("Defaults", () => {
      // PANEL_SETUP_TEXT_AND_GRAPHICS::Validate: TEXT_MIN_SIZE_MM .. TEXT_MAX_SIZE_MM for the text sizes
      const rowsNow = g.rows();
      for (let i = 0; i < rowsNow.length; i++) {
        const r = rowsNow[i]; if (!r.text) continue;
        for (const [k, col] of [["w", 2], ["ht", 3]] as [string, number][]) { const v = Number(r[k]); if (isFinite(v) && (v < 0.001 || v > 250)) return { msg: `Text size must be between ${fmtLenU(0.001)} and ${fmtLenU(250)}.`, ctrl: g.el, row: i, col }; }
      }
      return null;
    });
  };

  const formattingPage = (el: HTMLElement): void => {
    const d = BS().dashRatios(header ? header.setup : null);
    const dash = numField(d.dash, { ro: roBoard, key: "dash" }), gap = numField(d.gap, { ro: roBoard, key: "gap" });
    const FP: [string, string][] = [["apply_defaults_to_fp_fields", "Apply board defaults to footprint fields"], ["apply_defaults_to_fp_text", "Apply board defaults to footprint text"],
      ["apply_defaults_to_fp_shapes", "Apply board defaults to non-copper footprint shapes"], ["apply_defaults_to_fp_dimensions", "Apply board defaults to footprint dimensions"], ["apply_defaults_to_fp_barcodes", "Apply board defaults to footprint barcodes"]];
    const checks = FP.map(([k, label]) => ({ k, f: checkField(boolOr(defaults[k], false), label, { ro: roPro, key: k }) }));
    put(el, box("Dashed Lines", form([["Dash length:", dash.el], ["Gap length:", gap.el]]), note("Dash and dot lengths are ratios of the line width.")),
      box("When Adding Footprints to Board", ...checks.map((c) => c.f.el)));
    validate("Formatting", () => { const now = { dash: dash.get(), gap: gap.get() }; if (now.dash !== d.dash || now.gap !== d.gap) setupEdit.dash = now; return null; });
    register("Formatting", { edits: () => checks.map((c) => ({ path: [...DS, "defaults", c.k], value: c.f.get() })) });
  };

  const variablesPage = (el: HTMLElement): void => {
    const vars = obj(pro.text_variables);
    const rows: Record<string, CellValue>[] = Object.keys(vars).map((k) => ({ name: k, value: String(vars[k] ?? "") }));
    const g = grid([{ label: "Variable Name", key: "name", width: "40%" }, { label: "Text Substitution", key: "value" }], rows, { ro: roPro, height: "380px", key: "textVars" });
    put(el, g.el, gridButtons(g, () => ({ name: "", value: "" }), { ro: roPro }));
    register("Text Variables", { edits: () => {
      const out: Obj = {};
      for (const r of g.rows()) { const k = String(r.name).trim(); if (k) out[k] = String(r.value); }
      return [{ path: ["text_variables"], value: out }];
    } });
    validate("Text Variables", () => {
      // PANEL_TEXT_VARIABLES::TransferDataFromWindow: a name is required, and unique
      const rs = g.rows(), seen = new Set<string>();
      for (let i = 0; i < rs.length; i++) { const n = String(rs[i].name).trim(); if (!n && !String(rs[i].value)) continue; if (!n) return { msg: "Text variable cannot be empty.", ctrl: g.el, row: i, col: 0 }; if (seen.has(n)) return { msg: `Variable name '${n}' already in use.`, ctrl: g.el, row: i, col: 0 }; seen.add(n); }
      return null;
    });
  };

  // ------------------------------------------------------------ Design Rules
  const constraintsPage = (el: HTMLElement): void => {
    const fields: { key: string; f: Field<number> | Field<boolean>; int?: boolean; warn?: { set(m: string | null): void } }[] = [];
    const len = (key: string, label: string, tip: string): [string, HTMLElement, HTMLElement, string] => {
      const f = lenField(numOr(rules[key], Number(RULE_DEFAULTS[key])), { ro: roPro, key }); fields.push({ key, f, warn: f.warn });
      f.input.title = tip;
      return [label, h("span", { style: "display:inline-flex;align-items:center;width:100%" }, f.el, f.warn.el), unitLabel(), tip];
    };
    const chk = (key: string, label: string, tip: string, where: "rules" | "top"): HTMLElement => { const src = where === "rules" ? rules[key] : ds[key]; const f = checkField(boolOr(src, where === "rules" ? !!RULE_DEFAULTS[key] : false), label, { ro: roPro, key, tip }); fields.push({ key: where === "top" ? "^" + key : key, f }); return f.el; };
    const spokes = spinField(numOr(rules.min_resolved_spokes, 2), { min: 0, max: 99, ro: roPro, key: "min_resolved_spokes" }); fields.push({ key: "min_resolved_spokes", f: spokes, int: true });
    spokes.el.style.width = "64px";
    const R = "If set, this can only be reduced by custom rules.";
    const slow = h("div", { class: "pd-small" }, `Note: zone filling can be slow when < ${fmtLenU(0.005)}.`);
    put(el, h("div", { class: "pd-cols2" },
      h("div", null,
        box("Copper", form([
          len("min_clearance", "Minimum clearance:", "The minimum clearance between copper items which do not belong to the same net. " + R),
          len("min_track_width", "Minimum track width:", "The minimum track width. " + R),
          len("min_connection", "Minimum connection width:", "The minimum copper width of connected copper items."),
          len("min_via_annular_width", "Minimum annular width:", "The minimum annular ring width. " + R),
          len("min_via_diameter", "Minimum via diameter:", "The minimum via diameter. " + R),
          len("min_hole_clearance", "Copper to hole clearance:", "The minimum clearance between a hole and an unassociated copper item. " + R),
          len("min_copper_edge_clearance", "Copper to edge clearance:", "The minimum clearance between the board edge and any copper item. " + R),
          len("min_groove_width", "Minimum groove for creepage:", "The minimum slot width from DRC creepage checks")])),
        box("Holes", form([
          len("min_through_hole_diameter", "Minimum drill size:", "The minimum drill size. " + R),
          len("min_hole_to_hole", "Hole to hole clearance:", "The minimum clearance between two drilled holes. " + R + " (Note: does not apply to milled holes.)")])),
        box("uVias", form([
          len("min_microvia_diameter", "Minimum uVia diameter:", "The minimum diameter for micro-vias. " + R),
          len("min_microvia_drill", "Minimum uVia hole:", "The minimum micro-via hole size. " + R)]))),
      h("div", null,
        box("Silk", form([
          len("min_silk_clearance", "Minimum item clearance:", "Minimum clearance between two items on the same silkscreen layer. If set this can improve legibility.  (Note: does not apply to multiple shapes within a single footprint.)"),
          len("min_text_height", "Minimum text height:", ""), len("min_text_thickness", "Minimum text thickness:", "")])),
        box("Arc/Circle Approximations", form([len("max_error", "Maximum allowed deviation:", "The maximum allowed deviation between a true arc or circle and segments used to approximate it.  Smaller values produce smoother graphics at the expense of performance."), slow])),
        box("Zone Fill Strategy", chk("zones_allow_external_fillets", "Allow fillets/chamfers outside zone outline", "", "top"), form([["Minimum thermal relief spoke count:", spokes.el]])),
        box("Length Tuning", chk("use_height_for_length_calcs", "Include stackup height in track length calculations", "When enabled, the distance between copper layers will be included in track length calculations for tracks with vias.  When disabled, via stackup height is ignored.", "rules")))));
    const values = (): Record<string, number> => { const o: Record<string, number> = {}; for (const x of fields) if (x.key[0] !== "^" && typeof x.f.get() === "number") o[x.key] = x.f.get() as number; return o; };
    // updateWarnings, debounced so a half-typed value does not flash a warning
    let timer = 0;
    const updateWarnings = (): void => {
      const v = values(), msgs = new Map<string, string>();
      for (const i of [...BS().validateDesignRules(v, currentUnits()), ...BS().designRuleWarnings(v, currentUnits())]) msgs.set(i.setting, (msgs.has(i.setting) ? msgs.get(i.setting) + "\n" : "") + i.message);
      for (const x of fields) if (x.warn) x.warn.set(msgs.get(x.key) || null);
    };
    el.addEventListener("input", () => { if (timer) clearTimeout(timer); timer = window.setTimeout(updateWarnings, 250); });
    el.addEventListener("change", updateWarnings);
    updateWarnings();
    register("Constraints", { edits: () => fields.map((x) => (x.key[0] === "^" ? { path: [...DS, x.key.slice(1)], value: x.f.get() } : { path: [...DS, "rules", x.key], value: x.f.get(), ints: x.int })) });
    validate("Constraints", () => {
      const errs = BS().validateDesignRules(values(), currentUnits());
      if (!errs.length) return null;
      const x = fields.find((f) => f.key === errs[0].setting);
      return { msg: errs[0].message, ctrl: x ? x.f.input : null };
    });
  };

  const sizesPage = (el: HTMLElement): void => {
    // the first entry of each list stands for "use the netclass value" (KiCad keeps it there): it is not shown
    const tw = arr(ds.track_widths).slice(1).map((v): Record<string, CellValue> => ({ width: numOr(v, 0) }));
    const vd = arr(ds.via_dimensions).slice(1).map((v): Record<string, CellValue> => ({ diameter: numOr(obj(v).diameter, 0), drill: numOr(obj(v).drill, 0) }));
    const dp = arr(ds.diff_pair_dimensions).slice(1).map((v): Record<string, CellValue> => ({ width: numOr(obj(v).width, 0), gap: numOr(obj(v).gap, 0), via_gap: numOr(obj(v).via_gap, 0) }));
    const gt = grid([{ label: "Width", key: "width", type: "len" }], tw, { ro: roPro, height: "330px", key: "trackWidths" });
    const gv = grid([{ label: "Diameter", key: "diameter", type: "len" }, { label: "Hole", key: "drill", type: "len" }], vd, { ro: roPro, height: "330px", key: "viaSizes" });
    const gd = grid([{ label: "Width", key: "width", type: "len" }, { label: "Gap", key: "gap", type: "len" }, { label: "Via Gap", key: "via_gap", type: "len" }], dp, { ro: roPro, height: "330px", key: "diffPairs" });
    const fin = (v: CellValue): boolean => typeof v === "number" && isFinite(v);
    // OnSort…Click: the empty rows go, the rest sorted by increasing value
    const sorter = (g: typeof gt, keys: string[]) => (): void => { const rows = g.rows().filter((r) => fin(r[keys[0]])); rows.sort((a, b) => { for (const k of keys) { const d = (Number(a[k]) || 0) - (Number(b[k]) || 0); if (d) return d; } return 0; }); g.setRows(rows); };
    const bar = (g: typeof gt, make: () => Record<string, CellValue>, keys: string[]): HTMLElement => { const b = gridButtons(g, make, { ro: roPro }); b.insertBefore(iconButton("sort", "Sort by increasing value", sorter(g, keys), roPro), b.lastChild); return b; };
    put(el, h("div", { class: "pd-cols3" },
      h("div", { "data-list": "tracks" }, h("div", { class: "pd-colhead" }, "Tracks"), gt.el, bar(gt, () => ({ width: NaN }), ["width"])),
      h("div", { "data-list": "vias" }, h("div", { class: "pd-colhead" }, "Vias"), gv.el, bar(gv, () => ({ diameter: NaN, drill: NaN }), ["diameter", "drill"])),
      h("div", { "data-list": "diffpairs" }, h("div", { class: "pd-colhead" }, "Differential Pairs"), gd.el, bar(gd, () => ({ width: NaN, gap: NaN, via_gap: NaN }), ["width", "gap"]))));
    register("Pre-defined Sizes", { edits: () => {
      const widths = gt.rows().filter((r) => fin(r.width) && Number(r.width) > 0).map((r) => Number(r.width)).sort((a, b) => a - b);
      const vias = gv.rows().filter((r) => fin(r.diameter) && fin(r.drill)).map((r) => ({ diameter: Number(r.diameter), drill: Number(r.drill) })).sort((a, b) => a.diameter - b.diameter || a.drill - b.drill);
      const pairs = gd.rows().filter((r) => fin(r.width)).map((r) => ({ gap: Number(r.gap) || 0, via_gap: Number(r.via_gap) || 0, width: Number(r.width) })).sort((a, b) => a.width - b.width || a.gap - b.gap);
      const head = (key: string, zero: Plain): Plain => { const l = arr(ds[key]); return l.length ? l[0] : zero; };   // the placeholder stays as the file has it
      return [{ path: [...DS, "track_widths"], value: [head("track_widths", 0), ...widths] }, { path: [...DS, "via_dimensions"], value: [head("via_dimensions", { diameter: 0, drill: 0 }), ...vias] },
        { path: [...DS, "diff_pair_dimensions"], value: [head("diff_pair_dimensions", { gap: 0, via_gap: 0, width: 0 }), ...pairs] }];
    } });
    validate("Pre-defined Sizes", () => {
      // PANEL_SETUP_TRACKS_AND_VIAS::Validate: every via row through ValidateViaParameters, then the diff pair gaps
      const vr = gv.rows();
      for (let i = 0; i < vr.length; i++) { const e = BS().validateViaParameters(Number(vr[i].diameter), Number(vr[i].drill)); if (e) return { msg: e.message, ctrl: gv.el, row: i, col: e.field === "drill" ? 1 : 0 }; }
      const dr = gd.rows();
      for (let i = 0; i < dr.length; i++) if (fin(dr[i].width) && Number(dr[i].width) > 0 && !(fin(dr[i].gap) && Number(dr[i].gap) > 0)) return { msg: "No differential pair gap defined.", ctrl: gd.el, row: i, col: 1 };
      return null;
    });
  };

  const teardropsPage = (el: HTMLElement): void => {
    const params = arr(ds.teardrop_parameters).map(obj);
    const find = (target: string): Obj => params.find((p) => p.td_target_name === target) || {};
    const sets: { target: string; get(): Obj; ratios: [Field<number>, string][] }[] = [];
    const one = (title: string, target: string, span: string, sizeTip: string, d: string): HTMLElement => {
      const p = find(target), ro = roPro;
      const pct = (k: string, def: number, key: string): Field<number> => numField(+(numOr(p[k], def) * 100).toFixed(2), { ro, key: target + "-" + key });
      const bestL = pct("td_length_ratio", 0.5, "bestLength"), maxL = lenField(numOr(p.td_maxlen, 1), { ro, key: target + "-maxLength" });
      const bestW = pct("td_height_ratio", 1, "bestWidth"), maxW = lenField(numOr(p.td_maxheight, 2), { ro, key: target + "-maxWidth" });
      const zone = checkField(boolOr(p.td_on_pad_in_zone, false) === false, "Prefer zone connection", { ro, key: target + "-preferZone", tip: "Do not create teardrops on tracks connected to pads that are also connected to a copper zone." });
      const limit = pct("td_width_to_size_filter_ratio", 0.9, "widthLimit"); limit.input.title = sizeTip;
      const two = checkField(boolOr(p.td_allow_use_two_tracks, true), span, { ro, key: target + "-twoTracks", tip: "Allows a teardrop to extend over the first 2 connected track segments if the first track segment is too short to accommodate the best length." });
      const curved = checkField(p.td_curve_segcount === true || numOr(p.td_curve_segcount, 0) > 0, "Curved edges", { ro, key: target + "-curved" });
      const ratio = unitLabel(`%( ${d} )`);
      sets.push({ target, ratios: [[bestL, "best_length_ratio"], [bestW, "best_width_ratio"], [limit, "width_to_size_filter_ratio"]], get: () => ({ ...p, td_target_name: target, td_maxlen: maxL.get(), td_maxheight: maxW.get(), td_length_ratio: +(bestL.get() / 100).toFixed(6), td_height_ratio: +(bestW.get() / 100).toFixed(6),
        td_curve_segcount: curved.get() ? 1 : 0, td_width_to_size_filter_ratio: +(limit.get() / 100).toFixed(6), td_allow_use_two_tracks: two.get(), td_on_pad_in_zone: !zone.get(), td_enabled: p.td_enabled === undefined ? true : p.td_enabled }) });
      return box(title, form([
        ["Best length (L):", bestL.el, ratio], ["Maximum length (L):", maxL.el, unitLabel()],
        ["Best width (W):", bestW.el, unitLabel(`%( ${d} )`)], ["Maximum width (W):", maxW.el, unitLabel()],
        zone.el, ["Track width limit:", limit.el, unitLabel(`%( ${d} )`), sizeTip], two.el, curved.el]));
    };
    const tdTip = (pad: boolean): string => `Max ${pad ? "pad/via size to track width" : "track width"} ratio to create a teardrop.\n100 always creates a teardrop.`;
    put(el, h("div", { class: "pd-cols3" }, one("Default Properties for Round Shapes", "td_round_shape", "Allow teardrop to span two track segments", tdTip(true), "d"),
      one("Default Properties for Rectangular Shapes", "td_rect_shape", "Allow teardrop to span track segments", tdTip(true), "w"),
      one("Properties for Track-to-Track Teardrops", "td_track_end", "Allow teardrop to span track segments", tdTip(false), "w")));
    register("Teardrops", { edits: () => {
      const names = ["td_round_shape", "td_rect_shape", "td_track_end"];
      const out = names.map((n) => { const s = sets.find((x) => x.target === n); return s ? s.get() : find(n); });
      return [{ path: [...DS, "teardrop_parameters"], value: out }];
    } });
    validate("Teardrops", () => {
      for (const s of sets) for (const [f] of s.ratios) { const v = f.get() / 100; if (!isFinite(v) || v < 0 || v > 1) return { msg: "Value must be between 0.000 and 1.000.", ctrl: f.input }; }
      return null;
    });
  };

  const netClassesPage = (el: HTMLElement): void => {
    const classes = arr(net.classes).map(obj);
    if (!classes.some((c) => c.name === "Default")) classes.unshift({ ...NETCLASS_DEFAULTS });
    const LEN = ["clearance", "track_width", "via_diameter", "via_drill", "microvia_diameter", "microvia_drill", "diff_pair_width", "diff_pair_gap"];
    const rows: Record<string, CellValue>[] = classes.map((c, i) => {
      const r: Record<string, CellValue> = { name: String(c.name || ""), orig: i, pcb_color: String(c.pcb_color || "rgba(0, 0, 0, 0.000)"), schematic_color: String(c.schematic_color || "rgba(0, 0, 0, 0.000)"), tuning_profile: String(c.tuning_profile || ""),
        wire_width: typeof c.wire_width === "number" ? c.wire_width : NaN, bus_width: typeof c.bus_width === "number" ? c.bus_width : NaN, line_style: typeof c.line_style === "number" ? c.line_style : -1 };
      for (const k of LEN) r[k] = typeof c[k] === "number" ? (c[k] as number) : NaN;
      return r;
    });
    const isDefault = (r: Record<string, CellValue>): boolean => r.name === "Default" && r.orig !== -1;
    const profiles = arr(obj(pro.tuning_profiles).tuning_profiles_impedance_geometric).map((p) => String(obj(p).profile_name || "")).filter(Boolean);
    const g = grid([{ label: "Name", key: "name", width: "110px", readOnly: isDefault }, { label: "Clearance", key: "clearance", type: "len", tip: "Minimum copper clearance" }, { label: "Track Width", key: "track_width", type: "len", tip: "Optimum track width" },
      { label: "Via Size", key: "via_diameter", type: "len", tip: "Via pad diameter" }, { label: "Via Hole", key: "via_drill", type: "len", tip: "Via plated hole diameter" }, { label: "uVia Size", key: "microvia_diameter", type: "len", tip: "Microvia pad diameter" },
      { label: "uVia Hole", key: "microvia_drill", type: "len", tip: "Microvia plated hole diameter" }, { label: "DP Width", key: "diff_pair_width", type: "len", tip: "Differential pair track width" }, { label: "DP Gap", key: "diff_pair_gap", type: "len", tip: "Differential pair gap" },
      { label: "Tuning Profile", key: "tuning_profile", type: "select", options: [["", ""], ...profiles.map((p): [string, string] => [p, p])] },
      { label: "PCB Color", key: "pcb_color", type: "color", tip: "PCB netclass color", pick: pickColor, readOnly: isDefault },
      // shown in the Schematic Setup; here hidden until the header's right-click menu shows them (ShowHideColumns)
      { label: "Wire Thickness", key: "wire_width", type: "num", tip: "Schematic wire thickness", hidden: true }, { label: "Bus Thickness", key: "bus_width", type: "num", tip: "Bus wire thickness", hidden: true },
      { label: "Color", key: "schematic_color", type: "color", tip: "Schematic wire color", hidden: true, pick: pickColor, readOnly: isDefault },
      { label: "Line Style", key: "line_style", type: "select", tip: "Schematic wire line style", hidden: true, readOnly: isDefault, options: [[-1, "<Not defined>"], [0, "Solid"], [1, "Dashed"], [2, "Dotted"], [3, "Dash-Dot"], [4, "Dash-Dot-Dot"]] }], rows, { ro: roPro, height: "190px", key: "netclassGrid" });
    const patterns: Record<string, CellValue>[] = arr(net.netclass_patterns).map(obj).map((p) => ({ pattern: String(p.pattern || ""), netclass: String(p.netclass || "") }));
    const classOpts = (): [string, string][] => g.rows().map((r) => String(r.name)).filter(Boolean).map((n): [string, string] => [n, n]);
    const matching = h("div", { class: "pd-report", style: "height:130px;min-height:0", "data-k": "matchingNets" });
    const netNames = (): string[] => { const d = E.kdoc as (KDoc & { nets?: Map<number, string> }) | null; const out = new Set<string>(); if (d && d.nets) for (const v of d.nets.values()) if (v) out.add(String(v)); return Array.from(out).sort(); };
    const wild = (pat: string): RegExp => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."));
    let lastPattern = "";
    const showMatches = (pattern: string): void => {
      if (pattern === lastPattern) return; lastPattern = pattern; matching.replaceChildren();
      if (!pattern) return;
      // EDA_COMBINED_MATCHER( pattern, CTX_NETCLASS ).StartsWith: a wildcard pattern, or a /regex/
      let test: (n: string) => boolean;
      const rx = /^\/(.*)\/$/.exec(pattern);
      try { test = rx ? ((re) => (n: string) => re.test(n))(new RegExp(rx[1])) : ((re) => (n: string) => re.test(n))(wild(pattern)); } catch (e) { test = () => false; }
      matching.append(h("div", { class: "ln hd" }, `Nets matching '${pattern}':`), ...netNames().filter(test).map((n) => h("div", { class: "ln" }, n)));
    };
    const gp = grid([{ label: "Pattern", key: "pattern" }, { label: "Net Class", key: "netclass", type: "select", width: "40%", options: classOpts() }], patterns, { ro: roPro, height: "130px", key: "assignmentGrid", onSelect: (i) => showMatches(i >= 0 && gp ? String(gp.rows()[i].pattern || "") : "") });
    gp.el.addEventListener("input", (ev) => { const t = ev.target as HTMLInputElement; if (t.dataset.col === "pattern") { lastPattern = ""; showMatches(t.value); } });
    const importColors = h("button", { type: "button", class: "btn", disabled: roPro, "data-k": "importColors" }, "Import colors from schematic");
    importColors.addEventListener("click", () => { for (const r of g.rows()) if (!isDefault(r)) { const c = classes[Number(r.orig)]; if (c && typeof c.schematic_color === "string") r.pcb_color = c.schematic_color; } g.refresh(); });
    g.el.addEventListener("change", () => { const opts = classOpts(); (gp.columns[1] as { options?: [string, string][] }).options = opts; });
    put(el, box("Netclasses", g.el, h("div", { class: "pd-gridbar" }, ...Array.from(gridButtons(g, () => ({ name: "", orig: -1, clearance: NaN, track_width: NaN, via_diameter: NaN, via_drill: NaN, microvia_diameter: NaN, microvia_drill: NaN, diff_pair_width: NaN, diff_pair_gap: NaN, tuning_profile: "", pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", wire_width: NaN, bus_width: NaN, line_style: -1 }),
      { ro: roPro, move: true, canDelete: (r) => { if (isDefault(r)) { setError("Net Classes", { msg: "The default net class is required." }); return false; } return true; } }).children), h("span", { class: "pd-small", style: "flex:1;margin:0 8px" }, "Set color to transparent to use layer default color."), importColors)),
      box("Netclass Assignments", h("div", { class: "pd-cols2", style: "grid-template-columns:3fr 2fr" }, h("div", null, gp.el, gridButtons(gp, () => ({ pattern: "", netclass: "Default" }), { ro: roPro, onChange: () => { (gp.columns[1] as { options?: [string, string][] }).options = classOpts(); gp.refresh(); } })), matching)));
    register("Net Classes", { edits: () => {
      const out: Plain[] = []; const seen = new Set<string>();
      g.rows().forEach((r, i) => {
        const name = String(r.name).trim(); if (!name || seen.has(name)) return; seen.add(name);
        const base: Obj = typeof r.orig === "number" && r.orig >= 0 ? { ...classes[r.orig] } : { bus_width: 12, line_style: 0, pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", wire_width: 6 };
        base.name = name;
        if (name !== "Default") base.priority = i - 1 < 0 ? 0 : i - 1; else if (base.priority === undefined) base.priority = 2147483647;
        for (const k of [...LEN, "wire_width", "bus_width"]) { const v = Number(r[k]); if (isFinite(v)) base[k] = NETCLASS_INT_KEYS.has(k) ? Math.round(v) : v; else if (name !== "Default") delete base[k]; }
        if (Number(r.line_style) >= 0) base.line_style = Number(r.line_style); else if (name !== "Default") delete base.line_style;
        if (String(r.pcb_color).trim()) base.pcb_color = String(r.pcb_color).trim();
        if (String(r.schematic_color).trim()) base.schematic_color = String(r.schematic_color).trim();
        if (r.tuning_profile || base.tuning_profile !== undefined) base.tuning_profile = String(r.tuning_profile || "");
        out.push(base);
      });
      const pats: Plain[] = gp.rows().filter((r) => String(r.pattern).trim() && seen.has(String(r.netclass))).map((r) => ({ netclass: String(r.netclass), pattern: String(r.pattern).trim() }));
      return [{ path: ["net_settings", "classes"], value: out }, { path: ["net_settings", "netclass_patterns"], value: pats }];
    } });
    validate("Net Classes", () => {
      const names = g.rows().map((r) => String(r.name).trim());
      for (let i = 0; i < names.length; i++) {
        if (!names[i]) return { msg: "Netclass must have a name.", ctrl: g.el, row: i, col: 0 };
        const j = names.findIndex((n, k) => k !== i && n.toLowerCase() === names[i].toLowerCase());
        if (j >= 0) return { msg: "Netclass name already in use.", ctrl: g.el, row: Math.max(i, j), col: 0 };
      }
      return null;
    });
  };

  const rulesPage = (el: HTMLElement): void => {
    const ro = !canWriteProject();
    const report = h("div", { class: "pd-errors", "data-k": "errorsReport" });
    const say = (lines: { severity: string; text: string; line?: number; col?: number }[]): void => {
      report.replaceChildren(...lines.map((l) => { const d = h("div", { class: "ln " + l.severity });
        if (l.line !== undefined) { const a = h("a", { href: "#", "data-k": "errorLink" }, `${l.line}:${l.col || 1} ${l.text}`); a.addEventListener("click", (ev) => { ev.preventDefault(); if (rulesEd) rulesEd.gotoLine(l.line as number, l.col); }); d.append(l.severity === "error" ? "ERROR: " : "", a); }
        else d.append(l.text);
        return d; }));
    };
    const compile = (t: string): { errors: string[] } | null => { const tools = (globalThis as { PcbTools?: { parseDru?: (t: string) => { errors: string[] } } }).PcbTools; return tools && tools.parseDru ? tools.parseDru(t) : null; };
    const check = (): void => { const errs = ruleErrors(rulesEd ? rulesEd.get() : "", compile); say(errs.length ? errs.map((e) => ({ severity: "error", text: e.message, line: e.line, col: e.col })) : []); };
    const showMatching = (): void => {
      const text = rulesEd ? rulesEd.get() : "", line = rulesEd ? rulesEd.caretLine() : 1;
      const name = ruleAtLine(text, line);
      if (name === null) { say([{ severity: "action", text: "Place the cursor inside a (rule ...) block to show matching items." }]); return; }
      if (!name) { say([{ severity: "action", text: "The rule under the cursor has no name; add a name to identify it." }]); return; }
      const errs = ruleErrors(text, compile); if (errs.length) { say(errs.map((e) => ({ severity: "error", text: e.message, line: e.line, col: e.col }))); return; }
      const tools = (globalThis as { PcbTools?: { ruleMatchingItems?: (d: KDoc, s: unknown, t: string, n: string) => string[] | null; designSettings?: (p: unknown) => unknown } }).PcbTools;
      const ids = tools && tools.ruleMatchingItems && E.kdoc ? tools.ruleMatchingItems(E.kdoc, tools.designSettings ? tools.designSettings(E.proSettings || null) : {}, text, name) : null;
      if (!ids) { say([{ severity: "error", text: `Rule '${name}' could not be located after parsing.` }]); return; }
      // FocusOnItems: the matching items are selected on the board
      const pcb = (CollabTools as unknown as { pcb?: { state?: { sel?: Set<string> } } }).pcb;
      if (pcb && pcb.state) { pcb.state.sel = new Set(ids); ctx.requestRender(); }
      say([{ severity: "info", text: `Rule '${name}': ${ids.length} matching item(s).` }]);
    };
    rulesEd = rulesEditor(druText, { ro, onShowMatching: showMatching });
    if (dru) setTimeout(check, 0);     // OnCompile once the file is loaded
    const help = h("a", { href: "#", "data-k": "syntax-help", title: "Show syntax help window" }, "Syntax help");
    help.addEventListener("click", (ev) => {
      ev.preventDefault();
      let md = RULES_HELP_MD; if (IS_MAC) md = md.replace(/Ctrl\+/g, "Cmd+");
      if (typeof KDialogs !== "undefined" && KDialogs) KDialogs.open({ title: "Syntax Help", width: 760, modeless: true, child: true, buttons: [], build(body: HTMLElement) { const d = h("div", { class: "kd-help", "data-k": "rules-help", style: "max-height:70vh;overflow:auto;font-size:12px;line-height:1.35" }); d.innerHTML = markdownToHtml(md); body.append(d); } });
    });
    const btn = h("button", { type: "button", class: "btn", "data-k": "checkSyntax" }, "Check rule syntax"); btn.addEventListener("click", check);
    el.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:420px";
    put(el, h("div", { class: "pd-row" }, h("span", { class: "pd-lbl", style: "font-weight:600" }, "DRC Rules"), h("span", { style: "flex:1" }), help), rulesEd.el, report, h("div", { class: "pd-row", style: "margin-top:6px" }, btn));
  };

  const severityPage = (el: HTMLElement): void => {
    const sev = obj(ds.rule_severities), table = h("table", { class: "pd-sevtable" });
    const pick = new Map<string, string>();
    for (const [title, code, def] of DRC_ITEMS) {
      if (!code) { table.append(h("tr", { class: "hd" }, h("td", { colspan: "4" }, title))); continue; }
      const cur = typeof sev[code] === "string" ? String(sev[code]) : def; pick.set(code, cur);
      const tr = h("tr", null, h("td", null, title));
      for (const [v, label] of [["error", "Error"], ["warning", "Warning"], ["ignore", "Ignore"]]) {
        const rb = h("input", { type: "radio", name: "sev-" + code, value: v, checked: cur === v, disabled: roPro }); rb.addEventListener("change", () => { if (rb.checked) pick.set(code, v); });
        tr.append(h("td", null, h("label", null, rb, " " + label)));
      }
      table.append(tr);
    }
    put(el, h("div", { class: "pd-scroll" }, table));
    register("Violation Severity", { edits: () => Array.from(pick, ([code, v]) => ({ path: [...DS, "rule_severities", code], value: v })) });
  };

  let drillEdit: DrillProfile | null = null;
  const sctx = (): SetupCtx => ({ pro, ds, header, roPro, roBoard, boardText, register: (label, edits) => register(label, { edits }), validate, layerRows: () => layerRows, setDrillProfile: (p) => { drillEdit = p; } });
  const groups: TreeGroup[] = [
    { label: "Board Stackup", pages: [{ label: "Board Editor Layers", build: layersPage }, { label: "Physical Stackup", build: stackupPage }, { label: "Board Finish", build: finishPage }, { label: "Solder Mask/Paste", build: maskPage }, { label: "Drill Chart", build: (el) => drillChartPage(sctx())(el) }] },
    { label: "Text & Graphics", pages: [{ label: "Defaults", build: defaultsPage }, { label: "Formatting", build: formattingPage }, { label: "Text Variables", build: variablesPage }] },
    { label: "Design Rules", pages: [{ label: "Constraints", build: constraintsPage }, { label: "Pre-defined Sizes", build: sizesPage }, { label: "Microvia Stacks", build: (el) => viaStacksPage(sctx())(el) }, { label: "Zones", build: (el) => zonesPage(sctx())(el) },
      { label: "Teardrops", build: teardropsPage }, { label: "Length-tuning Patterns", build: (el) => tuningPatternsPage(sctx())(el) }, { label: "Tuning Profiles", build: (el) => tuningProfilesPage(sctx())(el) },
      { label: "Net Classes", build: netClassesPage }, { label: "Component Classes", build: (el) => componentClassesPage(sctx())(el) }, { label: "Custom Rules", build: rulesPage }, { label: "Violation Severity", build: severityPage }] },
    { label: "Board Data", pages: [{ label: "Embedded Files", build: (el) => embeddedFilesPage(sctx())(el) }] }];
  const order = groups.flatMap((g) => g.pages.map((p) => p.label));

  let dlg: ReturnType<typeof openDialog> = null;
  /** DIALOG_BOARD_SETUP::canDiscardChanges */
  const rulesModified = (): boolean => (rulesEd ? rulesEd.get() : druText) !== rules0;
  const importSettings = (): void => importSettingsDialog(async (sel, src) => {
    // the other board's project file, header and rules stand in for this board's on the chosen pages, which are rebuilt
    const map: Record<string, string[]> = { layers: ["Board Editor Layers", "Physical Stackup", "Board Finish"], mask: ["Solder Mask/Paste"], textDefaults: ["Defaults"], formatting: ["Formatting"], constraints: ["Constraints"], sizes: ["Pre-defined Sizes", "Microvia Stacks"],
      zones: ["Zones"], teardrops: ["Teardrops"], tuning: ["Length-tuning Patterns"], netclasses: ["Net Classes"], componentClasses: ["Component Classes"], tuningProfiles: ["Tuning Profiles"], rules: ["Custom Rules"], severities: ["Violation Severity"] };
    if (src.pro) { pro = obj(toPlain(parseProject(src.pro))); ds = obj(obj(pro.board).design_settings); rules = obj(ds.rules); defaults = obj(ds.defaults); net = obj(pro.net_settings); }
    if (sel.includes("layers") && src.header) { header = { ...(header || src.header), layers: src.header.layers, setup: src.header.setup, general: src.header.general }; layerRows = BS().layerRows(header.layers); layersTouched = true; setupEdit.copper = layerRows.filter((r) => r.copper).map((r) => r.name); }
    if (sel.includes("rules") && src.rules !== null) druText = src.rules;
    const labels = sel.flatMap((k) => map[k] || []);
    if (book) for (const l of labels) book.rebuild(l);
  });
  dlg = openDialog({ title: "Board Setup", width: 980, height: 620, readOnly: !canPro && !canBoard,
    extra: [{ label: "Import Settings from Another Board...", fn: importSettings }],
    build(body) {
      book = treeBook(groups, startPage || lastPage, { canLeave: (from) => {
        // onPageChanging: the page being left must validate (the custom rules are written only on OK, so Cancel can still drop them)
        if (from === "Custom Rules") return true;
        const v = validators.get(from); const e = v ? v() : null; if (e) { setError(from, e); return false; } return true; } });
      body.append(bar.el, book.el);
      body.addEventListener("click", () => { if (book) lastPage = book.current(); });
      if (!proText || !canWriteProject()) bar.show("Project is missing or read-only. Some settings will not be editable.");
    },
    cancel() {
      if (!rulesModified()) return true;
      messageBox("Confirmation", "Discard changes to custom rules?", [{ label: "Cancel" }, { label: "Discard Changes", fn: () => { rulesEd = null; druText = rules0; if (dlg) dlg.close(); } }], 0);
      return false;
    },
    ok() {
      for (const label of order) { if (!book || !book.built(label)) continue; const v = validators.get(label); const e = v ? v() : null; if (e) { setError(label, e); return false; } }
      const edits: ProjectEdit[] = [];
      if (canPro) for (const p of pages.values()) edits.push(...p.edits().filter((e) => initial.get(pathKey(e)) !== JSON.stringify(e.value)));
      const sections: { layers?: string; setup?: string; general?: string } = {};
      if (canBoard && header) {
        if (layersTouched) { const text = BS().layersText(layerRows); if (text !== layers0) sections.layers = text; }
        if (drillEdit) setupEdit.drillProfile = drillEdit;
        if (setupEdit.maskPaste || setupEdit.finish || setupEdit.dash || setupEdit.copper || setupEdit.drillProfile || setupEdit.stackup) sections.setup = BS().sectionText(BS().editSetup(header.setup, setupEdit));
        if (setupEdit.stackup && header.general && setupEdit.boardThickness) {
          const g = BS().sectionText(header.general).replace(/\(thickness [^)]*\)/, `(thickness ${+setupEdit.boardThickness.toFixed(6)})`);
          if (g !== BS().sectionText(header.general)) sections.general = g;
        }
      }
      const rulesNow = rulesEd ? rulesEd.get() : druText;     // imported rules count even when the page was never shown
      const rulesText = canWriteProject() && rulesNow !== rules0 ? rulesNow : null;
      void save(ctx, proText, edits, sections, dru ? dru.docId : null, rulesText);
      rules0 = rulesText === null ? rules0 : rulesText;
      return true;
    } });
}
/** DIALOG_IMPORT_SETTINGS: "Import from:" another board of the person's projects, the options to import, Import Settings. */
function importSettingsDialog(onImport: (sel: string[], src: { pro: string | null; header: BoardHeader | null; rules: string | null }) => Promise<void>): void {
  const boards: [string, string][] = [];
  const from = h("k-select", { "data-k": "importFrom", style: "flex:1" });
  from.append(h("option", { value: "" }, "Loading boards..."));
  const checks = IMPORT_OPTIONS.map(([k, label]) => ({ k, f: checkField(false, label.replace("&", "&"), { key: "import-" + k }) }));
  let okBtn: HTMLButtonElement | null = null;
  const sync = (): void => { if (okBtn) okBtn.disabled = !checks.some((c) => c.f.get()) || !(from as unknown as { value: string }).value; };
  const all = h("button", { type: "button", class: "btn", "data-k": "selectAll" }, "Select All");
  all.addEventListener("click", () => { const on = !checks.every((c) => c.f.get()); for (const c of checks) c.f.set(on); all.textContent = on ? "Deselect All" : "Select All"; sync(); });
  for (const c of checks) c.f.input.addEventListener("change", sync);
  from.addEventListener("change", sync);
  void (async () => {
    try {
      const list = await api("/api/projects") as { projects: { projectId: string; name: string }[] };
      for (const p of list.projects || []) {
        if (state.project && p.projectId === (state.project as { projectId: string }).projectId) continue;
        const info = await api(`/api/projects/${p.projectId}/info`) as { docs: { docId: string; docType: string; path: string }[] };
        for (const d of info.docs || []) if (d.docType === "kicad_pcb") boards.push([`${p.projectId}|${d.docId}`, `${p.name} / ${d.path}`]);
      }
    } catch (e) { /* no list: nothing to pick */ }
    from.replaceChildren(h("option", { value: "" }, boards.length ? "" : "No other boards"), ...boards.map(([v, l]) => h("option", { value: v }, l)));
    sync();
  })();
  const api0 = openDialog({ title: "Import Settings", width: 520, okLabel: "Import Settings", persist: "Import Settings",
    build(body, a) { okBtn = a.okButton; body.append(h("div", { class: "pd-row" }, h("label", null, "Import from:"), from), h("div", { class: "pd-lbl", style: "margin:8px 0 4px" }, "Import:"), ...checks.map((c) => c.f.el), h("div", { class: "pd-row", style: "margin-top:8px" }, all)); sync(); },
    restored: sync,
    ok() {
      const v = (from as unknown as { value: string }).value; if (!v) return false;
      const [projectId, docId] = v.split("|"); const sel = checks.filter((c) => c.f.get()).map((c) => c.k);
      void (async () => {
        let board = "", proT: string | null = null, rulesT: string | null = null;
        try {
          const info = await api(`/api/projects/${projectId}/info`) as { docs: { docId: string; docType: string; path: string }[] };
          board = String(await api(`/api/docs/${docId}/content`));
          const proDoc = (info.docs || []).find((d) => d.docType === "kicad_pro"), druDoc = (info.docs || []).find((d) => d.docType === "design_rules");
          if (proDoc) proT = String(await api(`/api/docs/${proDoc.docId}/content`));
          if (druDoc) rulesT = String(await api(`/api/docs/${druDoc.docId}/content`));
        } catch (e) { messageBox("Error", "Error loading board file."); return; }
        if (!proT) { messageBox("Error", "Error importing settings from board:\nAssociated project file could not be loaded"); return; }
        await onImport(sel, { pro: proT, header: board ? BS().boardHeader(board) : null, rules: rulesT });
      })();
      return true;
    } });
  void api0;
}
let lastPage = "";

/** S-expression well-formedness of a rules file: the first problem found, or "". */
export function ruleSyntaxError(text: string): string {
  let depth = 0, line = 1, inStr = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; line++; continue; }
    if (c === '"') inStr = true;
    else if (c === "(") { depth++; any = true; }
    else if (c === ")") { depth--; if (depth < 0) return `ERROR: unexpected ')' at line ${line}.`; }
  }
  if (inStr) return "ERROR: unterminated string.";
  if (depth) return `ERROR: ${depth} unclosed '('.`;
  if (any && !/^\s*(#[^\n]*\n\s*)*\(version\s+\d+\)/.test(text)) return "ERROR: missing (version 1) header.";
  // DRC_RULES_PARSER compiles each condition: an unknown property or function, or a function missing its argument, is an error
  const tools = (globalThis as { PcbTools?: { parseDru?: (t: string) => { errors: string[] } } }).PcbTools;
  const res = tools && tools.parseDru ? tools.parseDru(text) : null;
  if (res && res.errors.length) return "ERROR: " + res.errors[0].replace(/^rule '/, "Rule '");
  return "";
}

async function save(ctx: ToolCtx, proText: string | null, edits: ProjectEdit[], sections: { layers?: string; setup?: string; general?: string }, druDocId: string | null, rulesText: string | null): Promise<void> {
  const done: string[] = [], failed: string[] = [];
  if (proText && edits.length) {
    let res: { text: string; changed: ProjectEdit[] } | null = null;
    try { res = editProject(proText, edits); } catch (e) { failed.push("project file"); }
    if (res && res.changed.length) {
      if (await saveProjectFile(res.text, res.changed)) { adoptProjectFile(res.text); done.push("project settings"); } else failed.push("project file");
    }
  }
  if (sections.layers || sections.setup || sections.general) {
    const change = BS().boardSetupChange(sections);
    sendOp([change], false); applyChanges([change]);
    done.push(sections.layers ? "board layers" : "board settings");
  }
  if (!druDocId && rulesText !== null) {
    // PANEL_SETUP_RULES::TransferDataFromWindow: a project without a rules file gets one beside the board
    const board = state.project ? (state.project as { docs: { docId: string; path: string }[] }).docs.find((d) => d.docId === state.docId) : null;
    const path = board ? board.path.replace(/\.kicad_pcb$/i, "") + ".kicad_dru" : "rules.kicad_dru";
    const ok = E.api && E.api.saveCustomRules ? await E.api.saveCustomRules(path, rulesText) : false;
    if (ok) done.push("custom rules"); else failed.push("custom rules");
  } else if (druDocId && rulesText !== null) {
    const ok = await saveTextDocument(druDocId, rulesText, { id: "rules", kind: "MODIFIED", typeName: "DESIGN_RULES_FILE", properties: [{ name: "text", after: { type: "string", v: rulesText } }] });
    if (ok) { done.push("custom rules"); E.druText = rulesText; } else failed.push("custom rules");
  }
  if (failed.length) ctx.toast(`Board Setup: could not save the ${failed.join(" and ")}`, 5000);
  else if (done.length) ctx.toast(`Board Setup: ${done.join(", ")} saved`);
  ctx.requestRender();
}
