// pcbdialogs/teardrops — Edit > Edit Teardrops... (GLOBAL_EDIT_TOOL::EditTeardrops, DIALOG_GLOBAL_EDIT_TEARDROPS,
// dialog_global_edit_teardrops_base.fbp): Scope (PTH pads, SMD pads, Vias, Track to track), Filter Items (net, net
// class, layer, round pads, existing teardrops, selection) and the Action: remove them, remove all of them, add them
// with the board's defaults for the shape, or add them with the values given (each starting at "leave unchanged").
// "Apply and Close" writes the pads' and vias' (teardrops …) as one "Edit Teardrops" commit and the scope into the
// project's teardrop_options.
import { E } from "../state";
import { pcbState } from "../gestures";
import { editProject, parseProject, toPlain, type ProjectEdit } from "../../canvas/project-file";
import { adoptProjectFile, canWriteProject, saveProjectFile } from "../projectfile";
import { openBoardSetup } from "./board-setup";
import { effectiveTheme } from "../../theme";
import { TEARDROP_SIZES } from "./teardrop-bitmap";
import { box, checkField, form, h, openDialog, parseLen, selectField, unitLabel, type Field } from "./ui";

type Obj = Record<string, unknown>;
interface Td { enabled: boolean; twoSegments: boolean; preferZone: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean }
interface Opts {
  vias: boolean; pthPads: boolean; smdPads: boolean; trackToTrack: boolean; action: "remove" | "removeAll" | "default" | "specified";
  defaults: { round: Td; rect: Td }; specified?: Partial<Td>; roundOnly?: boolean; existingOnly?: boolean; selected?: Set<string> | null; skip?(i: { net: string; layer: string }): boolean;
}
interface Settings { netclasses: Record<string, unknown> }
interface PcbToolsApi {
  teardropEditChanges(doc: KDoc, o: Opts): KChange[]; designSettings(src: unknown): Settings; netclassName(s: Settings, net: string): string;
  boardLayerName(doc: KDoc, name: string): string; applySelection?(ctx: ToolCtx, ids: string[]): void; expandGroups?(doc: KDoc, ids: string[]): string[];
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const LEAVE = "-- leave unchanged --";
const DS = ["board", "design_settings"];
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const numOr = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
// g_netclassFilter / g_netFilter: the dialog's statics
const memory = { net: "", netclass: "" };

/** TEARDROP_PARAMETERS from the project's teardrop_parameters entry for a target (td_round_shape, td_rect_shape). */
function paramsFor(ds: Obj, target: string): Td {
  const p = (Array.isArray(ds.teardrop_parameters) ? ds.teardrop_parameters as unknown[] : []).map(obj).find((x) => x.td_target_name === target) || {};
  return { enabled: true, twoSegments: p.td_allow_use_two_tracks === undefined ? true : !!p.td_allow_use_two_tracks, preferZone: !p.td_on_pad_in_zone,
    maxLen: numOr(p.td_maxlen, 1), maxWidth: numOr(p.td_maxheight, 2), lenRatio: numOr(p.td_length_ratio, 0.5), widthRatio: numOr(p.td_height_ratio, 1),
    filterRatio: numOr(p.td_width_to_size_filter_ratio, 0.9), curved: p.td_curve_segcount === true || numOr(p.td_curve_segcount, 0) > 0 };
}
/** wxCHK_3STATE | wxCHK_ALLOW_3RD_STATE_FOR_USER, starting undetermined: undetermined -> checked -> unchecked -> … */
function tri(label: string, key: string, tip?: string): { el: HTMLElement; input: HTMLInputElement; get(): boolean | undefined } {
  const input = h("input", { type: "checkbox", "data-k": key, "data-nopersist": "" }) as HTMLInputElement;
  let v: boolean | undefined;
  const show = (): void => { input.indeterminate = v === undefined; input.checked = v === true; };
  input.addEventListener("click", () => { v = v === undefined ? true : v ? false : undefined; show(); });
  show();
  return { el: h("label", { class: "pd-check", title: tip || "" }, input, label), input, get: () => v };
}
/** UNIT_BINDER at INDETERMINATE_ACTION: blank is "leave unchanged". */
function leaveField(key: string, len: boolean): { el: HTMLInputElement; get(): number | undefined; bad(): boolean } {
  const el = h("input", { type: "text", "data-k": key, "data-nopersist": "", placeholder: LEAVE, style: "width:150px" }) as HTMLInputElement;
  const read = (): number => (len ? parseLen(el.value) : Number(el.value.trim().replace(",", ".")));
  return { el, get: () => (el.value.trim() ? read() : undefined), bad: () => !!el.value.trim() && !isFinite(read()) };
}

export function openEditTeardrops(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Edit Teardrops needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const pro = E.proSettings ? obj(toPlain(parseProject(E.proSettings))) : {};
  const ds = obj(obj(pro.board).design_settings);
  const topts = obj(Array.isArray(ds.teardrop_options) ? (ds.teardrop_options as unknown[])[0] : null);
  const flag = (k: string, d: boolean): boolean => (typeof topts[k] === "boolean" ? topts[k] as boolean : d);
  const settings = PT().designSettings(E.proSettings || null);
  const st = pcbState();
  const selection = new Set(st && st.sel ? (PT().expandGroups ? PT().expandGroups!(doc, Array.from(st.sel)) : Array.from(st.sel)) : []);

  // TransferDataToWindow: the scope from the board's settings, every specified value undetermined
  const pth = checkField(flag("td_onpthpad", true), "PTH pads", { key: "pthPads" });
  const smd = checkField(flag("td_onsmdpad", true), "SMD pads", { key: "smdPads" });
  const vias = checkField(flag("td_onvia", true), "Vias", { key: "vias" });
  const t2t = checkField(flag("td_ontrackend", false), "Track to track", { key: "trackToTrack" });
  for (const f of [pth, smd, vias, t2t]) f.input.setAttribute("data-nopersist", "");

  const nets = Array.from(new Set(Array.from((doc as unknown as { nets?: Map<number, string> }).nets?.values() || []).filter((n) => n))).sort();
  const netOpt = checkField(false, "Filter items by net:", { key: "netFilterOpt" });
  const net = selectField<string>(memory.net && nets.includes(memory.net) ? memory.net : (typeof (st as { highlightNet?: unknown } | null)?.highlightNet === "string" ? (st as unknown as { highlightNet: string }).highlightNet : nets[0] || ""), nets.map((n): [string, string] => [n, n]), { key: "netFilter", onChange: (v) => { memory.net = v; netOpt.set(true); } });
  const classes = ["Default", ...Object.keys(settings.netclasses).filter((n) => n !== "Default")];
  const ncOpt = checkField(false, "Filter items by net class:", { key: "netclassFilterOpt" });
  const nc = selectField<string>(memory.netclass && classes.includes(memory.netclass) ? memory.netclass : "Default", classes.map((n): [string, string] => [n, n]), { key: "netclassFilter", onChange: (v) => { memory.netclass = v; ncOpt.set(true); } });
  const copper = (doc as unknown as { copper?: string[] }).copper || ["F.Cu", "B.Cu"];
  const layerOpt = checkField(false, "Filter items by layer:", { key: "layerFilterOpt" });
  const layer = selectField<string>(copper.includes(ctx.activeLayer || "") ? ctx.activeLayer! : copper[0], copper.map((l): [string, string] => [l, PT().boardLayerName(doc, l)]), { key: "layerFilter", onChange: () => layerOpt.set(true) });
  for (const s of [net, nc, layer]) s.input.setAttribute("data-nopersist", "");
  const roundOnly = checkField(flag("td_onroundshapesonly", false), "Round pads only", { key: "roundPadsFilter" });
  roundOnly.input.setAttribute("data-nopersist", "");
  const existing = checkField(false, "Existing teardrops only", { key: "existingFilter" });
  const selOnly = checkField(false, "Selected items only", { key: "selectedItemsFilter" });

  const radio = (label: string, key: string, tip?: string): Field<boolean> => {
    const input = h("input", { type: "radio", name: "td-action", "data-k": key }) as HTMLInputElement;
    const el = h("label", { class: "pd-check", title: tip || "" }, input, label);
    return { el, input, get: () => input.checked, set: (v) => { input.checked = v; } };
  };
  const rmSome = radio("Remove teardrops", "removeTeardrops", "Remove teardrops according to filtering options");
  const rmAll = radio("Remove all teardrops", "removeAllTeardrops", "Remove all teardrops, regardless of filtering options");
  const addDef = radio("Add teardrops with default values for shape", "addTeardrops");
  const addSpec = radio("Add teardrops with specified values:", "specifiedValues");
  addDef.set(true);
  const setupLink = h("button", { class: "pd-link", type: "button" }, "Edit default values in Board Setup");
  setupLink.addEventListener("click", () => { void openBoardSetup(ctx, "Teardrops"); });
  const preferZone = tri("Prefer zone connection", "preferZone", "Do not create teardrops on tracks connected to pads that are also connected to a copper zone.");
  const useNext = tri("Allow teardrops to span two track segments", "useNextTrack", "Allows a teardrop to extend over the first 2 connected track segments if the first track segment is too short to accommodate the best length.");
  const hd = leaveField("hdRatio", false); hd.el.title = "Tracks which are similar in size to the pad or via do not need teardrops.";
  const lenPct = leaveField("lenPercent", false), maxLen = leaveField("maxLen", true), widthPct = leaveField("widthPercent", false), maxWidth = leaveField("maxWidth", true);
  for (const f of [lenPct, maxLen, widthPct, maxWidth]) f.el.style.width = "120px";
  const curved = tri("Curved edges", "curvedEdges");

  // OnExistingFilterSelect: no "add" when only existing teardrops are touched
  const relabel = (): void => {
    (addDef.el.lastChild as Text).textContent = existing.get() ? "Set teardrops to default values for shape" : "Add teardrops with default values for shape";
    (addSpec.el.lastChild as Text).textContent = existing.get() ? "Set teardrops to specified values:" : "Add teardrops with specified values:";
  };
  existing.input.addEventListener("change", relabel);
  // onTrackToTrack: track-to-track teardrops follow the board settings only, so checking it moves "specified values"
  // to "default values" (the radio itself stays enabled)
  t2t.input.addEventListener("change", () => { if (t2t.get() && addSpec.get()) addDef.set(true); sync(); });
  const bitmap = h("img", { src: TEARDROP_SIZES[effectiveTheme() === "dark" ? 1 : 0], width: "275", height: "130", alt: "", "data-bitmap": "teardrop_sizes", style: "display:block;margin:0 auto" }) as HTMLImageElement;
  const specCtrls: (HTMLInputElement)[] = [preferZone.input, useNext.input, hd.el, lenPct.el, maxLen.el, widthPct.el, maxWidth.el, curved.input];
  const filterCtrls: Field<boolean>[] = [netOpt, ncOpt, layerOpt, roundOnly, existing, selOnly];
  const sync = (): void => {
    // onSpecifiedValuesUpdateUi (the value controls and the picture), onFilterUpdateUi (the filters only)
    const spec = addSpec.get();
    for (const c of specCtrls) { c.disabled = !spec; const l = c.closest("label"); if (l) l.classList.toggle("dim", !spec); }
    bitmap.style.opacity = spec ? "" : "0.5";
    for (const f of filterCtrls) { (f.input as HTMLInputElement).disabled = t2t.get(); f.el.classList.toggle("dim", t2t.get()); }
    for (const s of [net, nc, layer]) (s.input as HTMLElement & { disabled: boolean }).disabled = t2t.get();
  };

  openDialog({ title: "Set Teardrops", width: 1000, okLabel: "Apply and Close", cancelLabel: "Close", persist: true,
    build(body) {
      const filters = h("div", { class: "pd-form" });
      filters.append(netOpt.el, net.el, h("span"), ncOpt.el, nc.el, h("span"), layerOpt.el, layer.el, h("span"));
      // bSizerSpecifiedValues: the two checkboxes beside the width limit, then m_bitmapTeardrop beside the sizes
      const spec = h("div", null,
        h("div", { style: "display:grid;grid-template-columns:auto auto;gap:0 25px;align-items:start" },
          h("div", { style: "display:flex;flex-direction:column;gap:2px" }, preferZone.el, useNext.el),
          h("div", null, form([["Track width limit:", hd.el, unitLabel("%"), "Max pad/via size to track width ratio to create a teardrop.\n100 always creates a teardrop."]]),
            h("div", { class: "pd-note", style: "font-style:italic;margin:0" }, "(as a percentage of pad/via minor dimension)"))),
        h("div", { style: "display:grid;grid-template-columns:275px max-content;gap:0 25px;align-items:center;margin-top:5px" }, bitmap,
          h("div", null, form([["Best length (L):", lenPct.el, unitLabel("%( d )")], ["Maximum length (L):", maxLen.el, unitLabel()],
            ["Best width (W):", widthPct.el, unitLabel("%( d )")], ["Maximum width (W):", maxWidth.el, unitLabel()]]), h("div", { style: "height:8px" }), curved.el)));
      const action = box("Action", rmSome.el, rmAll.el, h("div", { style: "height:6px" }), addDef.el, h("div", { style: "margin:0 0 6px 24px" }, setupLink), addSpec.el, h("div", { style: "margin-left:24px" }, spec));
      body.append(h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:0 16px;align-items:start" },
        h("div", null, box("Scope", pth.el, smd.el, vias.el, t2t.el), box("Filter Items", filters, roundOnly.el, existing.el, selOnly.el)), action));
      body.addEventListener("change", sync);
      relabel(); sync();
    },
    restored() { relabel(); sync(); },
    ok() {
      for (const f of [hd, lenPct, maxLen, widthPct, maxWidth]) if (f.bad()) { ctx.toast("Value must be a number."); f.el.focus(); return false; }
      const action: Opts["action"] = rmSome.get() ? "remove" : rmAll.get() ? "removeAll" : addSpec.get() ? "specified" : "default";
      const specified: Partial<Td> = {};
      const pz = preferZone.get(), un = useNext.get(), cv = curved.get();
      if (pz !== undefined) specified.preferZone = pz;
      if (un !== undefined) specified.twoSegments = un;
      const pct = (f: { get(): number | undefined }): number | undefined => { const v = f.get(); return v === undefined ? undefined : +(v / 100).toFixed(6); };
      const fr = pct(hd), lr = pct(lenPct), wr = pct(widthPct), ml = maxLen.get(), mw = maxWidth.get();
      if (fr !== undefined) specified.filterRatio = fr; if (lr !== undefined) specified.lenRatio = lr; if (wr !== undefined) specified.widthRatio = wr;
      if (ml !== undefined) specified.maxLen = ml; if (mw !== undefined) specified.maxWidth = mw; if (cv !== undefined) specified.curved = cv;
      const netF = netOpt.get() ? net.get() : null, ncF = ncOpt.get() ? nc.get() : null, layerF = layerOpt.get() ? layer.get() : null;
      const o: Opts = { vias: vias.get(), pthPads: pth.get(), smdPads: smd.get(), trackToTrack: t2t.get(), action,
        defaults: { round: paramsFor(ds, "td_round_shape"), rect: paramsFor(ds, "td_rect_shape") }, specified,
        roundOnly: roundOnly.get(), existingOnly: existing.get(), selected: selOnly.get() ? selection : null,
        skip: (i) => (netF !== null && i.net !== netF) || (ncF !== null && PT().netclassName(settings, i.net) !== ncF) || (layerF !== null && i.layer !== layerF) };
      const changes = PT().teardropEditChanges(doc, o);
      if (changes.length) ctx.commit(changes, "Edit Teardrops");
      ctx.requestRender();
      // bds.m_TeardropParamsList's targets go to the project file
      const next = { ...topts, td_onvia: o.vias, td_onpthpad: o.pthPads, td_onsmdpad: o.smdPads, td_ontrackend: o.trackToTrack, td_onroundshapesonly: !!o.roundOnly };
      const edits: ProjectEdit[] = [];
      if (JSON.stringify(next) !== JSON.stringify(topts)) edits.push({ path: [...DS, "teardrop_options"], value: [next] as ProjectEdit["value"] });
      // Track to track: TARGET_TRACK's m_Enabled (td_enabled of the td_track_end entry) is cleared by a removal and set
      // by "default values"; "specified values" leaves it
      const tdEnable = o.trackToTrack || action === "removeAll" ? (action === "remove" || action === "removeAll" ? false : action === "default" ? true : null) : null;
      if (tdEnable !== null) {
        const list = (Array.isArray(ds.teardrop_parameters) ? ds.teardrop_parameters as unknown[] : []).map(obj);
        const i = list.findIndex((x) => x.td_target_name === "td_track_end");
        if (i >= 0 && list[i].td_enabled !== tdEnable) edits.push({ path: [...DS, "teardrop_parameters"], value: list.map((x, j) => (j === i ? { ...x, td_enabled: tdEnable } : x)) as ProjectEdit["value"] });
      }
      if (E.proSettings && canWriteProject() && edits.length) {
        try { const res = editProject(E.proSettings, edits); void saveProjectFile(res.text, res.changed).then((ok) => { if (ok) adoptProjectFile(res.text); }); } catch (e) { /* the project file stays as it was */ }
      }
      return true;
    } });
}
