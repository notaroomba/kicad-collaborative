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
// View only: the Physical Stackup table and Teardrops.
// Only pages that were opened are written back, as in KiCad (its pages are created lazily too).
import { E } from "../state";
import { state } from "../appstore";
import { api, toast } from "../util";
import { sendOp } from "../net";
import { applyChanges } from "../doc";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { DEFAULTS_DEFAULTS, LAYER_CLASSES, NETCLASS_DEFAULTS, NETCLASS_INT_KEYS, RULE_DEFAULTS, editProject, parseProject, toPlain, type Plain, type ProjectEdit } from "../../canvas/project-file";
import type { BoardHeader, LayerRow } from "../../canvas/board-setup";
import { adoptProjectFile, canWriteProject, liveDocument, loadProjectFile, projectDoc, saveProjectFile, saveTextDocument } from "../projectfile";
import { BS } from "./canvas";
import { put, box, checkField, form, grid, gridButtons, h, lenField, note, numField, openDialog, selectField, textField, unitLabel, type CellValue, type Field, type GridApi, type TreeGroup, treeBook } from "./ui";

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

export async function openBoardSetup(ctx: ToolCtx, startPage?: string): Promise<void> {
  if (!E.kdoc || E.kdoc.type !== "pcb") { toast("Board Setup needs a board"); return; }
  const [proText, header] = await Promise.all([loadProjectFile(), loadBoardHeader()]);
  const dru = projectDoc("design_rules");
  let druText = "";
  if (dru) { try { druText = (await liveDocument(dru.docId)).file; } catch (e) { druText = ""; } }
  const root = proText ? toPlain(parseProject(proText)) : null;
  const pro = obj(root);
  const ds = obj(obj(pro.board).design_settings), rules = obj(ds.rules), defaults = obj(ds.defaults), net = obj(pro.net_settings);
  const canPro = !!proText && canWriteProject(), canBoard = !!header && canWriteProject();
  const roPro = !canPro, roBoard = !canBoard;
  const DS = ["board", "design_settings"];
  const pages = new Map<string, PageState>();
  // a page writes only what was changed on it: the values it showed when it was built are remembered here
  const initial = new Map<string, string>();
  const pathKey = (e: ProjectEdit): string => e.path.join("\u0000");
  const register = (label: string, p: PageState): void => { pages.set(label, p); for (const e of p.edits()) initial.set(pathKey(e), JSON.stringify(e.value)); };
  // board-file state shared between the layer and stackup pages
  let layerRows: LayerRow[] = BS().layerRows(header ? header.layers : null);
  const layers0 = BS().layersText(layerRows);
  let layersTouched = false, refreshLayers: (() => void) | null = null, refreshStackup: (() => void) | null = null;
  const setupEdit: Parameters<ReturnType<typeof BS>["editSetup"]>[1] = {};
  const boardGetters: (() => string | null)[] = [];   // validation of board pages: an error text keeps the dialog open
  let druField: HTMLTextAreaElement | null = null;

  const proNote = (): HTMLElement | null => (proText ? null : note("This project has no project file (.kicad_pro): KiCad's defaults are shown and cannot be changed here."));

  // ------------------------------------------------------------ Board Stackup
  const layersPage = (el: HTMLElement): void => {
    const host = h("div", { class: "pd-layers" });
    const draw = (): void => {
      host.replaceChildren();
      const table = h("table", { class: "pd-layertable" });
      for (const r of layerRows) {
        const cb = h("input", { type: "checkbox", checked: r.enabled, disabled: roBoard || r.mandatory || r.copper, title: r.copper ? "Use the Physical Stackup page to change the number of copper layers." : r.mandatory ? "This layer is required and cannot be disabled" : "If you want this layer in your board, check this box" });
        cb.addEventListener("change", () => { r.enabled = cb.checked; layersTouched = true; });
        const shown = r.userName || (r.copper || r.userDefined ? r.name : BS().defaultLayerName(r.name));
        const name = h("input", { type: "text", value: shown, readOnly: roBoard, "data-layer": r.name, title: "Layer Name" });
        name.addEventListener("change", () => {
          const v = name.value.trim(), err = BS().layerNameError(layerRows, r, v);
          if (err) { toast(err); name.value = shown; return; }
          r.userName = v === r.name || (!r.copper && !r.userDefined && v === BS().defaultLayerName(r.name)) ? "" : v; layersTouched = true;
        });
        let type: HTMLElement;
        if (r.copper || r.userDefined) {
          const opts = r.copper ? BS().COPPER_TYPES : BS().USER_TYPES;
          const s = h("select", { disabled: roBoard, title: r.copper ? "Copper layer type for Freerouter and other external routers.\nPower plane layers are removed from Freerouter's layer menus." : "Layer type" });
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
      if (n > 45) { toast("All user defined layers are in use"); return; }
      layerRows.push({ name: `User.${n}`, id: 39 + 2 * (n - 1), type: "user", userName: "", enabled: true, copper: false, mandatory: false, description: "", userDefined: true });
      layerRows.sort((a, b) => (a.userDefined && b.userDefined ? a.id - b.id : 0));
      layersTouched = true; draw();
    });
    put(el, h("div", { class: "pd-row" }, add), host, roBoard ? null : note(BOARD_NOTE));
    boardGetters.push(() => {
      // a layer that still carries items is not switched off here: Board Setup does not delete design content
      const used = new Map<string, number>();
      if (E.kdoc) for (const it of E.kdoc.items.values()) { const seen = new Set<string>(); for (const g of it.geom || []) if (g.layer && !seen.has(g.layer)) { seen.add(g.layer); used.set(g.layer, (used.get(g.layer) || 0) + 1); } }
      for (const r of layerRows) if (!r.enabled && (used.get(r.name) || 0) > 0) return `Layer ${r.userName || r.name} still carries ${used.get(r.name)} item(s) and cannot be removed here. Move or delete them first.`;
      return null;
    });
  };

  const stackupPage = (el: HTMLElement): void => {
    const counts: [number, string][] = []; for (let n = 2; n <= 32; n += 2) counts.push([n, String(n)]);
    const cuNow = (): number => layerRows.filter((r) => r.copper).length;
    const count = selectField<number>(cuNow(), counts, { ro: roBoard, key: "copperCount", onChange: (n) => {
      const inner = layerRows.filter((r) => r.copper).map((r) => r.name).slice(n - 1, -1);   // the inner layers that go away
      const busy = inner.filter((name) => E.kdoc && Array.from((E.kdoc as KDoc).items.values()).some((it) => (it.geom || []).some((g) => g.layer === name)));
      if (busy.length) { toast(`Items have been found on ${busy.join(", ")}: move or delete them before removing the layer.`, 5000); count.set(cuNow()); return; }
      layerRows = BS().setCopperCount(layerRows, n); layersTouched = true;
      setupEdit.copper = layerRows.filter((r) => r.copper).map((r) => r.name);
      setupEdit.boardThickness = header && header.general ? Number((KiCadCanvas.kid(header.general, "thickness") as SNode | null)?.[1]) || 1.6 : 1.6;
      if (refreshLayers) refreshLayers(); if (refreshStackup) refreshStackup();
    } });
    count.input.title = "Select the number of copper layers in the stackup";
    const impedance = checkField(header && header.setup ? String(((KiCadCanvas.kid((KiCadCanvas.kid(header.setup, "stackup") as SNode | null) || [], "dielectric_constraints") as SNode | null) || [])[1]) === "yes" : false, "Impedance controlled", { ro: true, tip: "If Impedance Controlled option is set,\nLoss tangent and EpsilonR will be added to constraints." });
    const host = h("div"), total = h("span", { class: "pd-value" });
    const draw = (): void => {
      const names = new Map<string, string>(); for (const r of layerRows) if (r.userName) names.set(r.name, r.userName);
      const setup = header ? BS().editSetup(header.setup, setupEdit.copper ? { copper: setupEdit.copper, boardThickness: setupEdit.boardThickness } : {}) : null;
      const rows = BS().stackupRows(setup, names);
      const cells: Record<string, CellValue>[] = rows.map((r) => ({ layer: r.layer, id: r.id, type: r.type, material: r.material, thickness: r.thickness === null ? NaN : r.thickness, color: r.color, er: r.epsilonR === null ? "" : String(r.epsilonR), lt: r.lossTangent === null ? "" : String(r.lossTangent) }));
      host.replaceChildren(rows.length
        ? grid([{ label: "Layer", key: "layer" }, { label: "Id", key: "id", width: "36px" }, { label: "Type", key: "type" }, { label: "Material", key: "material" }, { label: "Thickness", key: "thickness", type: "len" }, { label: "Color", key: "color" }, { label: "Epsilon R", key: "er", width: "72px" }, { label: "Loss Tan", key: "lt", width: "72px" }], cells, { ro: true, height: "330px" }).el
        : note("This board has no physical stackup: KiCad builds one when the stackup is first edited in the desktop application."));
      total.textContent = rows.length ? BS().stackupThickness(rows).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") + " mm" : "";
    };
    refreshStackup = draw; draw();
    put(el, h("div", { class: "pd-row" }, h("label", null, "Copper layers:"), count.el, impedance.el), host,
      h("div", { class: "pd-row" }, h("label", null, "Board thickness from stackup:"), total),
      note("The stackup table is shown for reference: materials and thicknesses are edited in the desktop application. The number of copper layers can be changed here." + (roBoard ? "" : " " + BOARD_NOTE)));
  };

  const finishPage = (el: HTMLElement): void => {
    const f = BS().boardFinish(header ? header.setup : null);
    const plated = checkField(f.edgePlating, "Plated board edge", { ro: roBoard, key: "edgePlating" });
    const finish = selectField<string>(f.copperFinish, (BS().COPPER_FINISHES.includes(f.copperFinish) ? BS().COPPER_FINISHES : [f.copperFinish, ...BS().COPPER_FINISHES]).map((x): [string, string] => [x, x]), { ro: roBoard, key: "copperFinish" });
    const edge = selectField<string>(f.edgeConnector, [["no", "None"], ["yes", "Yes"], ["bevelled", "Yes, bevelled"]], { ro: roBoard, key: "edgeConnector" });
    edge.input.title = "Options for edge card connectors.";
    put(el, plated.el, form([["Copper finish:", finish.el], ["Edge card connectors:", edge.el]]), roBoard ? null : note(BOARD_NOTE));
    boardGetters.push(() => {
      const now = { copperFinish: finish.get(), edgeConnector: edge.get() as "no" | "yes" | "bevelled", edgePlating: plated.get(), hasStackup: f.hasStackup };
      if (now.copperFinish !== f.copperFinish || now.edgeConnector !== f.edgeConnector || now.edgePlating !== f.edgePlating) setupEdit.finish = now;
      return null;
    });
  };

  const maskPage = (el: HTMLElement): void => {
    const m = BS().maskPaste(header ? header.setup : null);
    const exp = lenField(m.maskExpansion, { ro: roBoard, key: "maskExpansion" }), web = lenField(m.maskMinWidth, { ro: roBoard, key: "maskMinWidth" });
    const toCu = lenField(numOr(rules.solder_mask_to_copper_clearance, 0), { ro: roPro, key: "maskToCopper" });
    const bridges = checkField(m.allowBridges, "Allow bridged solder mask apertures between pads within footprints", { ro: roBoard, key: "allowBridges", tip: "Disable DRC error checking for solder mask aperture bridging between pads in the same footprint." });
    const tf = checkField(m.tentFront, "Front", { ro: roBoard, key: "tentFront", tip: "Tented: vias are covered with solder mask.\nNot tented: vias are not covered with solder mask." }), tb = checkField(m.tentBack, "Back", { ro: roBoard, key: "tentBack" });
    const paste = lenField(m.pasteClearance, { ro: roBoard, key: "pasteClearance" }), ratio = numField(+(m.pasteRatio * 100).toFixed(4), { ro: roBoard, key: "pasteRatio" });
    put(el, 
      note("Consult your PCB manufacturer's specifications for solder mask expansion, web width, and clearance settings."),
      note("If no specifications are provided, setting these values to zero is recommended."),
      box("Solder Mask Settings", form([["Solder mask expansion:", exp.el, unitLabel()], ["Solder mask minimum web width:", web.el, unitLabel()], ["Solder mask to copper clearance:", toCu.el, unitLabel()], bridges.el,
        ["Tent vias:", h("span", { class: "pd-inline" }, tf.el, tb.el)]])),
      box("Solder Paste Settings", form([["Solder paste clearance:", paste.el, unitLabel()], ["Solder paste relative clearance:", ratio.el, unitLabel("%")]])),
      roBoard ? null : note("The solder mask to copper clearance is stored in the project file. The other values: " + BOARD_NOTE.replace("Stored", "stored")));
    boardGetters.push(() => {
      const now = { maskExpansion: exp.get(), maskMinWidth: web.get(), pasteClearance: paste.get(), pasteRatio: +(ratio.get() / 100).toFixed(6), allowBridges: bridges.get(), tentFront: tf.get(), tentBack: tb.get() };
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
      { label: "Text Height", key: "ht", type: "len", readOnly: noText }, { label: "Text Thickness", key: "th", type: "len", readOnly: noText }, { label: "Italic", key: "italic", type: "check", readOnly: noText }, { label: "Keep Upright", key: "upright", type: "check", readOnly: noText }], rows, { ro: roPro });
    put(el, box("Default Properties for New Graphics and Text", g.el), proNote());
    register("Defaults", { edits: () => {
      const out: ProjectEdit[] = [], P = [...DS, "defaults"];
      for (const r of g.rows()) {
        const stem = String(r.stem);
        if (isFinite(Number(r.line))) out.push({ path: [...P, `${stem}_line_width`], value: Number(r.line) });
        if (!r.text) continue;
        for (const [k, key] of [["w", "text_size_h"], ["ht", "text_size_v"], ["th", "text_thickness"]]) if (isFinite(Number(r[k]))) out.push({ path: [...P, `${stem}_${key}`], value: Number(r[k]) });
        out.push({ path: [...P, `${stem}_text_italic`], value: !!r.italic }, { path: [...P, `${stem}_text_upright`], value: !!r.upright });
      }
      return out;
    } });
  };

  const formattingPage = (el: HTMLElement): void => {
    const d = BS().dashRatios(header ? header.setup : null);
    const dash = numField(d.dash, { ro: roBoard, key: "dash" }), gap = numField(d.gap, { ro: roBoard, key: "gap" });
    const FP: [string, string][] = [["apply_defaults_to_fp_fields", "Apply board defaults to footprint fields"], ["apply_defaults_to_fp_text", "Apply board defaults to footprint text"],
      ["apply_defaults_to_fp_shapes", "Apply board defaults to non-copper footprint shapes"], ["apply_defaults_to_fp_dimensions", "Apply board defaults to footprint dimensions"], ["apply_defaults_to_fp_barcodes", "Apply board defaults to footprint barcodes"]];
    const checks = FP.map(([k, label]) => ({ k, f: checkField(boolOr(defaults[k], false), label, { ro: roPro, key: k }) }));
    put(el, box("Dashed Lines", form([["Dash length:", dash.el], ["Gap length:", gap.el]]), note("Dash and dot lengths are ratios of the line width.")),
      box("When Adding Footprints to Board", ...checks.map((c) => c.f.el)), proNote());
    boardGetters.push(() => { const now = { dash: dash.get(), gap: gap.get() }; if (now.dash !== d.dash || now.gap !== d.gap) setupEdit.dash = now; return null; });
    register("Formatting", { edits: () => checks.map((c) => ({ path: [...DS, "defaults", c.k], value: c.f.get() })) });
  };

  const variablesPage = (el: HTMLElement): void => {
    const vars = obj(pro.text_variables);
    const rows: Record<string, CellValue>[] = Object.keys(vars).map((k) => ({ name: k, value: String(vars[k] ?? "") }));
    const g = grid([{ label: "Variable Name", key: "name", width: "40%" }, { label: "Text Substitution", key: "value" }], rows, { ro: roPro, height: "380px" });
    put(el, g.el, gridButtons(g, () => ({ name: "", value: "" }), { ro: roPro }), proNote());
    register("Text Variables", { edits: () => {
      const out: Obj = {};
      for (const r of g.rows()) { const k = String(r.name).trim(); if (k) out[k] = String(r.value); }
      return [{ path: ["text_variables"], value: out }];
    } });
  };

  // ------------------------------------------------------------ Design Rules
  const constraintsPage = (el: HTMLElement): void => {
    const fields: { key: string; f: Field<number> | Field<boolean>; int?: boolean }[] = [];
    const len = (key: string, label: string, tip: string): [string, HTMLElement, HTMLElement, string] => { const f = lenField(numOr(rules[key], Number(RULE_DEFAULTS[key])), { ro: roPro, key }); fields.push({ key, f }); return [label, f.el, unitLabel(), tip]; };
    const chk = (key: string, label: string, tip: string, where: "rules" | "top"): HTMLElement => { const src = where === "rules" ? rules[key] : ds[key]; const f = checkField(boolOr(src, where === "rules" ? !!RULE_DEFAULTS[key] : false), label, { ro: roPro, key, tip }); fields.push({ key: where === "top" ? "^" + key : key, f }); return f.el; };
    const spokes = numField(numOr(rules.min_resolved_spokes, 2), { ro: roPro, key: "min_resolved_spokes", digits: 0 }); fields.push({ key: "min_resolved_spokes", f: spokes, int: true });
    const R = "If set, this can only be reduced by custom rules.";
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
        box("Arc/Circle Approximations", form([len("max_error", "Maximum allowed deviation:", "The maximum allowed deviation between a true arc or circle and segments used to approximate it.  Smaller values produce smoother graphics at the expense of performance.")])),
        box("Zone Fill Strategy", chk("zones_allow_external_fillets", "Allow fillets/chamfers outside zone outline", "", "top"), form([["Minimum thermal relief spoke count:", spokes.el]])),
        box("Length Tuning", chk("use_height_for_length_calcs", "Include stackup height in track length calculations", "When enabled, the distance between copper layers will be included in track length calculations for tracks with vias.  When disabled, via stackup height is ignored.", "rules")))),
      proNote());
    register("Constraints", { edits: () => fields.map((x) => (x.key[0] === "^" ? { path: [...DS, x.key.slice(1)], value: x.f.get() } : { path: [...DS, "rules", x.key], value: x.f.get(), ints: x.int })) });
  };

  const sizesPage = (el: HTMLElement): void => {
    // the first entry of each list stands for "use the netclass value" (KiCad keeps it there): it is not shown
    const tw = arr(ds.track_widths).slice(1).map((v): Record<string, CellValue> => ({ width: numOr(v, 0) }));
    const vd = arr(ds.via_dimensions).slice(1).map((v): Record<string, CellValue> => ({ diameter: numOr(obj(v).diameter, 0), drill: numOr(obj(v).drill, 0) }));
    const dp = arr(ds.diff_pair_dimensions).slice(1).map((v): Record<string, CellValue> => ({ width: numOr(obj(v).width, 0), gap: numOr(obj(v).gap, 0), via_gap: numOr(obj(v).via_gap, 0) }));
    const gt = grid([{ label: "Width", key: "width", type: "len" }], tw, { ro: roPro, height: "330px" });
    const gv = grid([{ label: "Diameter", key: "diameter", type: "len" }, { label: "Hole", key: "drill", type: "len" }], vd, { ro: roPro, height: "330px" });
    const gd = grid([{ label: "Width", key: "width", type: "len" }, { label: "Gap", key: "gap", type: "len" }, { label: "Via Gap", key: "via_gap", type: "len" }], dp, { ro: roPro, height: "330px" });
    put(el, h("div", { class: "pd-cols3" },
      h("div", { "data-list": "tracks" }, h("div", { class: "pd-colhead" }, "Tracks"), gt.el, gridButtons(gt, () => ({ width: NaN }), { ro: roPro })),
      h("div", { "data-list": "vias" }, h("div", { class: "pd-colhead" }, "Vias"), gv.el, gridButtons(gv, () => ({ diameter: NaN, drill: NaN }), { ro: roPro })),
      h("div", { "data-list": "diffpairs" }, h("div", { class: "pd-colhead" }, "Differential Pairs"), gd.el, gridButtons(gd, () => ({ width: NaN, gap: NaN, via_gap: NaN }), { ro: roPro }))), proNote());
    const fin = (v: CellValue): boolean => typeof v === "number" && isFinite(v) && v > 0;
    register("Pre-defined Sizes", { edits: () => {
      const widths = gt.rows().filter((r) => fin(r.width)).map((r) => Number(r.width)).sort((a, b) => a - b);
      const vias = gv.rows().filter((r) => fin(r.diameter) && fin(r.drill)).map((r) => ({ diameter: Number(r.diameter), drill: Number(r.drill) })).sort((a, b) => a.diameter - b.diameter || a.drill - b.drill);
      const pairs = gd.rows().filter((r) => fin(r.width)).map((r) => ({ gap: Number(r.gap) || 0, via_gap: Number(r.via_gap) || 0, width: Number(r.width) })).sort((a, b) => a.width - b.width || a.gap - b.gap);
      const head = (key: string, zero: Plain): Plain => { const l = arr(ds[key]); return l.length ? l[0] : zero; };   // the placeholder stays as the file has it
      return [{ path: [...DS, "track_widths"], value: [head("track_widths", 0), ...widths] }, { path: [...DS, "via_dimensions"], value: [head("via_dimensions", { diameter: 0, drill: 0 }), ...vias] },
        { path: [...DS, "diff_pair_dimensions"], value: [head("diff_pair_dimensions", { gap: 0, via_gap: 0, width: 0 }), ...pairs] }];
    } });
  };

  const teardropsPage = (el: HTMLElement): void => {
    const params = arr(ds.teardrop_parameters).map(obj);
    const find = (target: string): Obj => params.find((p) => p.td_target_name === target) || {};
    const one = (title: string, target: string, span: string, sizeTip: string): HTMLElement => {
      const p = find(target), pct = (k: string, d: number): HTMLElement => numField(+(numOr(p[k], d) * 100).toFixed(2), { ro: true }).el;
      return box(title, form([
        ["Best length (L):", pct("td_length_ratio", 0.5), unitLabel("%(d)")], ["Maximum length (L):", lenField(numOr(p.td_maxlen, 1), { ro: true }).el, unitLabel()],
        ["Best width (W):", pct("td_height_ratio", 1), unitLabel("%(d)")], ["Maximum width (W):", lenField(numOr(p.td_maxheight, 2), { ro: true }).el, unitLabel()],
        checkField(boolOr(p.td_on_pad_in_zone, false) === false, "Prefer zone connection", { ro: true, tip: "Do not create teardrops on tracks connected to pads that are also connected to a copper zone." }).el,
        ["Track width limit:", pct("td_width_to_size_filter_ratio", 0.9), unitLabel("%(d)"), sizeTip],
        checkField(boolOr(p.td_allow_use_two_tracks, true), span, { ro: true, tip: "Allows a teardrop to extend over the first 2 connected track segments if the first track segment is too short to accommodate the best length." }).el,
        checkField(p.td_curve_segcount === true || numOr(p.td_curve_segcount, 0) > 0, "Curved edges", { ro: true }).el]));
    };
    put(el, one("Default Properties for Round Shapes", "td_round_shape", "Allow teardrop to span two track segments", "Max pad/via size to track width ratio to create a teardrop.\n100 always creates a teardrop."),
      one("Default Properties for Rectangular Shapes", "td_rect_shape", "Allow teardrop to span track segments", "Max pad/via size to track width ratio to create a teardrop.\n100 always creates a teardrop."),
      one("Properties for Track-to-Track Teardrops", "td_track_end", "Allow teardrop to span track segments", "Max track width ratio to create a teardrop.\n100 always creates a teardrop."),
      note("Teardrop defaults are shown for reference; they are edited in the desktop application."));
  };

  const netClassesPage = (el: HTMLElement): void => {
    const classes = arr(net.classes).map(obj);
    if (!classes.some((c) => c.name === "Default")) classes.unshift({ ...NETCLASS_DEFAULTS });
    const LEN = ["clearance", "track_width", "via_diameter", "via_drill", "microvia_diameter", "microvia_drill", "diff_pair_width", "diff_pair_gap"];
    const rows: Record<string, CellValue>[] = classes.map((c, i) => {
      const r: Record<string, CellValue> = { name: String(c.name || ""), orig: i, pcb_color: String(c.pcb_color || ""), wire_width: typeof c.wire_width === "number" ? c.wire_width : NaN, bus_width: typeof c.bus_width === "number" ? c.bus_width : NaN, line_style: typeof c.line_style === "number" ? c.line_style : -1 };
      for (const k of LEN) r[k] = typeof c[k] === "number" ? (c[k] as number) : NaN;
      return r;
    });
    const isDefault = (r: Record<string, CellValue>): boolean => r.name === "Default" && r.orig !== -1;
    const g = grid([{ label: "Name", key: "name", width: "110px", readOnly: isDefault }, { label: "Clearance", key: "clearance", type: "len" }, { label: "Track Width", key: "track_width", type: "len" }, { label: "Via Size", key: "via_diameter", type: "len" },
      { label: "Via Hole", key: "via_drill", type: "len" }, { label: "uVia Size", key: "microvia_diameter", type: "len" }, { label: "uVia Hole", key: "microvia_drill", type: "len" }, { label: "DP Width", key: "diff_pair_width", type: "len" }, { label: "DP Gap", key: "diff_pair_gap", type: "len" },
      { label: "PCB Color", key: "pcb_color", width: "110px" }, { label: "Wire Thickness", key: "wire_width", type: "num" }, { label: "Bus Thickness", key: "bus_width", type: "num" },
      { label: "Line Style", key: "line_style", type: "select", options: [[-1, "<Not defined>"], [0, "Solid"], [1, "Dashed"], [2, "Dotted"], [3, "Dash-Dot"], [4, "Dash-Dot-Dot"]] }], rows, { ro: roPro, height: "190px" });
    const patterns: Record<string, CellValue>[] = arr(net.netclass_patterns).map(obj).map((p) => ({ pattern: String(p.pattern || ""), netclass: String(p.netclass || "") }));
    const gp = grid([{ label: "Pattern", key: "pattern" }, { label: "Net Class", key: "netclass", width: "40%" }], patterns, { ro: roPro, height: "130px" });
    put(el, box("Netclasses", g.el, gridButtons(g, () => ({ name: "", orig: -1, clearance: NaN, track_width: NaN, via_diameter: NaN, via_drill: NaN, microvia_diameter: NaN, microvia_drill: NaN, diff_pair_width: NaN, diff_pair_gap: NaN, pcb_color: "", wire_width: NaN, bus_width: NaN, line_style: -1 }),
      { ro: roPro, move: true, canDelete: (r) => { if (isDefault(r)) { toast("The default net class is required."); return false; } return true; } }), note("Set color to transparent to use KiCad default color. Wire and bus thickness are in mils.")),
      box("Netclass Assignments", gp.el, gridButtons(gp, () => ({ pattern: "", netclass: "Default" }), { ro: roPro })), proNote());
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
        out.push(base);
      });
      const pats: Plain[] = gp.rows().filter((r) => String(r.pattern).trim() && seen.has(String(r.netclass))).map((r) => ({ netclass: String(r.netclass), pattern: String(r.pattern).trim() }));
      return [{ path: ["net_settings", "classes"], value: out }, { path: ["net_settings", "netclass_patterns"], value: pats }];
    } });
    boardGetters.push(() => {
      const names = g.rows().map((r) => String(r.name).trim());
      if (names.some((n) => !n)) return "Netclass must have a name.";
      if (new Set(names).size !== names.length) return "Netclass name already in use.";
      return null;
    });
  };

  const rulesPage = (el: HTMLElement): void => {
    const ta = h("textarea", { class: "pd-text", spellcheck: "false", readOnly: !dru || !canWriteProject(), "data-key": "customRules" }); ta.value = druText; druField = ta;
    const status = h("span", { class: "pd-status" });
    const check = h("button", { type: "button" }, "Check rule syntax");
    check.addEventListener("click", () => { const err = ruleSyntaxError(ta.value); status.textContent = err || "No errors found."; status.className = "pd-status " + (err ? "err" : "ok"); });
    put(el, h("div", { class: "pd-row" }, h("label", null, "DRC Rules"), h("span", { style: "flex:1" }), check, status), ta,
      note(dru ? "Custom rules are stored in the project's .kicad_dru file. DRC, the interactive router and the length tuner evaluate them." : "This project has no custom rules file (.kicad_dru)."));
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
    put(el, h("div", { class: "pd-scroll" }, table), proNote());
    register("Violation Severity", { edits: () => Array.from(pick, ([code, v]) => ({ path: [...DS, "rule_severities", code], value: v })) });
  };

  const groups: TreeGroup[] = [
    { label: "Board Stackup", pages: [{ label: "Board Editor Layers", build: layersPage }, { label: "Physical Stackup", build: stackupPage }, { label: "Board Finish", build: finishPage }, { label: "Solder Mask/Paste", build: maskPage }] },
    { label: "Text & Graphics", pages: [{ label: "Defaults", build: defaultsPage }, { label: "Formatting", build: formattingPage }, { label: "Text Variables", build: variablesPage }] },
    { label: "Design Rules", pages: [{ label: "Constraints", build: constraintsPage }, { label: "Pre-defined Sizes", build: sizesPage }, { label: "Teardrops", build: teardropsPage }, { label: "Net Classes", build: netClassesPage }, { label: "Custom Rules", build: rulesPage }, { label: "Violation Severity", build: severityPage }] }];

  openDialog({ title: "Board Setup", width: 980, height: 620, noEnter: true, readOnly: !canPro && !canBoard,
    build(body) { const book = treeBook(groups, startPage || lastPage); body.append(book.el); body.addEventListener("click", () => { lastPage = book.current(); }); },
    ok() {
      for (const get of boardGetters) { const err = get(); if (err) { toast(err, 5000); return false; } }
      const edits: ProjectEdit[] = [];
      if (canPro) for (const p of pages.values()) edits.push(...p.edits().filter((e) => initial.get(pathKey(e)) !== JSON.stringify(e.value)));
      const sections: { layers?: string; setup?: string } = {};
      if (canBoard && header) {
        if (layersTouched) { const text = BS().layersText(layerRows); if (text !== layers0) sections.layers = text; }
        if (setupEdit.maskPaste || setupEdit.finish || setupEdit.dash || setupEdit.copper) sections.setup = BS().sectionText(BS().editSetup(header.setup, setupEdit));
      }
      const rulesText = druField && dru && canWriteProject() && druField.value !== druText ? druField.value : null;
      void save(ctx, proText, edits, sections, dru ? dru.docId : null, rulesText);
      return true;
    } });
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

async function save(ctx: ToolCtx, proText: string | null, edits: ProjectEdit[], sections: { layers?: string; setup?: string }, druDocId: string | null, rulesText: string | null): Promise<void> {
  const done: string[] = [], failed: string[] = [];
  if (proText && edits.length) {
    let res: { text: string; changed: ProjectEdit[] } | null = null;
    try { res = editProject(proText, edits); } catch (e) { failed.push("project file"); }
    if (res && res.changed.length) {
      if (await saveProjectFile(res.text, res.changed)) { adoptProjectFile(res.text); done.push("project settings"); } else failed.push("project file");
    }
  }
  if (sections.layers || sections.setup) {
    const change = BS().boardSetupChange(sections);
    sendOp([change], false); applyChanges([change]);
    done.push(sections.layers ? "board layers" : "board settings");
  }
  if (druDocId && rulesText !== null) {
    const ok = await saveTextDocument(druDocId, rulesText, { id: "rules", kind: "MODIFIED", typeName: "DESIGN_RULES_FILE", properties: [{ name: "text", after: { type: "string", v: rulesText } }] });
    if (ok) { done.push("custom rules"); E.druText = rulesText; } else failed.push("custom rules");
  }
  if (failed.length) ctx.toast(`Board Setup: could not save the ${failed.join(" and ")}`, 5000);
  else if (done.length) ctx.toast(`Board Setup: ${done.join(", ")} saved`);
  ctx.requestRender();
}
