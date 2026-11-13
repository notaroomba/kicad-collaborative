// pcbdialogs/board-setup-pages — the Board Setup pages KiCad 10 added beside the older ones (dialog_board_setup.cpp):
//   Board Stackup > Drill Chart          PANEL_SETUP_DRILL_CHART      (setup (drill_symbol_profile …)) in the board file
//   Design Rules > Microvia Stacks       PANEL_SETUP_VIA_STACKS       board.design_settings.via_stack_presets
//   Design Rules > Zones                 PANEL_SETUP_ZONES            board.design_settings.defaults.zones
//   Design Rules > Length-tuning Patterns PANEL_SETUP_TUNING_PATTERNS board.design_settings.tuning_pattern_settings
//   Design Rules > Tuning Profiles       PANEL_SETUP_TUNING_PROFILES  tuning_profiles.tuning_profiles_impedance_geometric
//   Design Rules > Component Classes     PANEL_ASSIGN_COMPONENT_CLASSES component_class_settings
//   Board Data > Embedded Files          PANEL_EMBEDDED_FILES         (embedded_files …) of the board file (listed)
import type { Plain, ProjectEdit } from "../../canvas/project-file";
import type { BoardHeader, DrillProfile, LayerRow } from "../../canvas/board-setup";
import { BS } from "./canvas";
import { E } from "../state";
import { box, checkField, form, grid, gridButtons, h, iconButton, lenField, note, numField, openDialog, put, selectField, spinField, textEntryBox, textField, unitLabel, unitName, fmtLen, errorMessage, type CellValue, type Field } from "./ui";

type Obj = { [key: string]: Plain };
const isObj = (v: Plain | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: Plain | undefined): Obj => (isObj(v) ? v : {});
const arr = (v: Plain | undefined): Plain[] => (Array.isArray(v) ? v : []);
const numOr = (v: Plain | undefined, d: number): number => (typeof v === "number" ? v : d);
const boolOr = (v: Plain | undefined, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strOr = (v: Plain | undefined, d: string): string => (typeof v === "string" ? v : d);

export interface PageError { msg: string; ctrl?: HTMLElement | null; row?: number; col?: number }
export interface SetupCtx {
  pro: Obj; ds: Obj; header: BoardHeader | null; roPro: boolean; roBoard: boolean;
  register(label: string, edits: () => ProjectEdit[]): void;
  validate(label: string, fn: () => PageError | null): void;
  layerRows(): LayerRow[];
  /** the board-file edit of the Drill Chart page */
  setDrillProfile(p: DrillProfile | null): void;
  /** the full text of the board file, for the embedded files */
  boardText: string;
}
const DS = ["board", "design_settings"];
const copperNames = (ctx: SetupCtx): [string, string][] => ctx.layerRows().filter((r) => r.copper).map((r): [string, string] => [r.name, r.userName || r.name]);

// ------------------------------------------------------------ Board Stackup > Drill Chart
export function drillChartPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const p = BS().drillProfile(ctx.header ? ctx.header.setup : null);
    const LABELS = ["Hole size", "Slot shape", "Plating", "Layer span", "Drill operation", "Hole function", "IPC-4761 protection", "Post-machining"];
    const checks = BS().DRILL_GROUP_KEYS.map((k, i) => ({ k, f: checkField(p.groupBy.includes(k), LABELS[i], { ro: ctx.roBoard, key: "group-" + k }) }));
    const marks = selectField<string>(p.markPolicy, [["shapes", "Curated shapes"], ["letters", "Letters"], ["shapes_then_letters", "Curated shapes, then letters"], ["size_text", "Hole size text"]], { ro: ctx.roBoard, key: "defaultMarks" });
    const size = lenField(p.size, { ro: ctx.roBoard, key: "symbolSize" }), width = lenField(p.width, { ro: ctx.roBoard, key: "symbolWidth" });
    const freeze = checkField(p.freeze, "Keep existing symbol assignments when holes change", { ro: ctx.roBoard, key: "freeze" });
    const edit = h("button", { type: "button", class: "btn", disabled: true, title: "The drill groups are edited in the desktop application." }, "Close and Edit Drill Groups...");
    put(el, box("Symbols", form([["Group holes by:", h("div", { class: "pd-list", style: "padding:4px 8px" }, ...checks.map((c) => c.f.el))], ["Default marks:", marks.el],
      ["Symbol size:", size.el, unitLabel()], ["Symbol line width:", width.el, unitLabel()]], true), freeze.el, h("div", { class: "pd-row", style: "margin-top:8px" }, edit)));
    ctx.validate("Drill Chart", () => {
      const now: DrillProfile = { groupBy: checks.filter((c) => c.f.get()).map((c) => c.k), markPolicy: marks.get(), size: size.get(), width: width.get(), freeze: freeze.get() };
      const was = JSON.stringify({ ...p, groupBy: BS().DRILL_GROUP_KEYS.filter((k) => p.groupBy.includes(k)) });
      ctx.setDrillProfile(JSON.stringify(now) === was ? null : now);
      return null;
    });
  };
}

// ------------------------------------------------------------ Design Rules > Microvia Stacks
interface ViaStackPreset { name: string; start_layer: string; end_layer: string; staggered: boolean; via_size: number; via_drill: number; use_netclass: boolean; filled: boolean; capped: boolean; pitch: number }
/** DIALOG_MICROVIA_STACK over a preset. */
function microviaStackDialog(ctx: SetupCtx, p: ViaStackPreset, done: (p: ViaStackPreset) => void): void {
  const cu = copperNames(ctx);
  const start = selectField<string>(p.start_layer, cu, { key: "startLayer" }), end = selectField<string>(p.end_layer, cu, { key: "endLayer" });
  const type = selectField<number>(p.staggered ? 1 : 0, [[0, "Stacked"], [1, "Staggered"]], { key: "type" });
  const dia = lenField(p.via_size, { key: "viaDiameter" }), hole = lenField(p.via_drill, { key: "viaHole" });
  const nc = checkField(p.use_netclass, "Use netclass values", { key: "useNetclass", onChange: (v) => { dia.input.disabled = v; hole.input.disabled = v; } });
  const filled = checkField(p.filled, "Copper-filled", { key: "filled" }), capped = checkField(p.capped, "Capped", { key: "capped" });
  const pitch = lenField(p.pitch, { key: "pitch" });
  const sync = (): void => { pitch.input.disabled = type.get() !== 1; };
  type.input.addEventListener("change", sync);
  openDialog({ title: "Microvia Stack", width: 420,
    build(body) { body.append(form([["Start layer:", start.el], ["End layer:", end.el], ["Type:", type.el], ["Via diameter:", dia.el, unitLabel()], ["Via hole:", hole.el, unitLabel()], nc.el, filled.el, capped.el, ["Pitch:", pitch.el, unitLabel()]])); dia.input.disabled = hole.input.disabled = p.use_netclass; sync(); },
    ok() {
      if (start.get() === end.get()) { errorMessage("The start and end layers must be different."); return false; }
      if (!nc.get()) { const err = BS().validateViaParameters(dia.get(), hole.get()); if (err) { errorMessage(err.message); return false; } }
      done({ ...p, start_layer: start.get(), end_layer: end.get(), staggered: type.get() === 1, via_size: dia.get(), via_drill: hole.get(), use_netclass: nc.get(), filled: filled.get(), capped: capped.get(), pitch: pitch.get() });
      return true;
    } });
}
export function viaStacksPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const presets: ViaStackPreset[] = arr(ctx.ds.via_stack_presets).map(obj).map((o) => ({ name: strOr(o.name, ""), start_layer: strOr(o.start_layer, "F.Cu"), end_layer: strOr(o.end_layer, "In1.Cu"), staggered: boolOr(o.staggered, false),
      via_size: numOr(o.via_size, 0.3), via_drill: numOr(o.via_drill, 0.1), use_netclass: boolOr(o.use_netclass, false), filled: boolOr(o.filled, true), capped: boolOr(o.capped, false), pitch: numOr(o.pitch, 0) }));
    const label = (n: string): string => { const r = ctx.layerRows().find((x) => x.name === n); return (r && r.userName) || n; };
    const toRows = (): Record<string, CellValue>[] => presets.map((p) => ({ name: p.name, type: p.staggered ? "Staggered" : "Stacked", layers: label(p.start_layer) + " -> " + label(p.end_layer),
      size: p.use_netclass ? "netclass" : fmtLen(p.via_size) + " / " + fmtLen(p.via_drill) + " " + unitName(), fill: p.filled ? "yes" : "no", pitch: p.staggered ? fmtLen(p.pitch) + " " + unitName() : "-" }));
    const g = grid([{ label: "Name", key: "name" }, { label: "Type", key: "type", type: "ro" }, { label: "Layers", key: "layers", type: "ro" }, { label: "Diameter / Hole", key: "size", type: "ro" }, { label: "Fill", key: "fill", type: "ro" }, { label: "Pitch", key: "pitch", type: "ro" }],
      toRows(), { ro: ctx.roPro, height: "360px", key: "viaStacks", onChange: () => { g.rows().forEach((r, i) => { if (presets[i]) presets[i].name = String(r.name).trim(); }); } });
    const refresh = (): void => { const s = g.selected(); g.setRows(toRows()); if (s >= 0) g.select(Math.min(s, presets.length - 1)); };
    const nameFree = (n: string, skip: number): boolean => !presets.some((p, i) => i !== skip && p.name === n);
    const add = (): void => {
      const ask = (initial: string): void => { textEntryBox("New Microvia Stack Preset", "Preset name:", initial, false, (t) => {
        const n = t.trim(); if (!n) return;
        if (!nameFree(n, -1)) { errorMessage(`A preset named '${n}' already exists.`, () => ask(n)); return; }
        const cu = copperNames(ctx);
        microviaStackDialog(ctx, { name: n, start_layer: cu[0] ? cu[0][0] : "F.Cu", end_layer: cu[1] ? cu[1][0] : "In1.Cu", staggered: false, via_size: 0.3, via_drill: 0.1, use_netclass: false, filled: true, capped: false, pitch: 0 }, (p) => { presets.push(p); refresh(); g.select(presets.length - 1); });
      }); };
      ask("");
    };
    const editSel = (): void => { const i = g.selected(); if (i < 0 || !presets[i]) return; microviaStackDialog(ctx, presets[i], (p) => { presets[i] = p; refresh(); }); };
    const remove = (): void => { const i = g.selected(); if (i < 0) return; presets.splice(i, 1); refresh(); };
    put(el, g.el, h("div", { class: "pd-gridbar" }, h("button", { type: "button", class: "btn", disabled: ctx.roPro, onclick: add }, "Add..."), h("button", { type: "button", class: "btn", disabled: ctx.roPro, onclick: editSel }, "Edit..."),
      h("button", { type: "button", class: "btn", disabled: ctx.roPro, onclick: remove }, "Remove")));
    g.el.addEventListener("dblclick", editSel);
    ctx.register("Microvia Stacks", () => [{ path: [...DS, "via_stack_presets"], value: presets.map((p) => ({ ...p })) as unknown as Plain }]);
    ctx.validate("Microvia Stacks", () => {
      for (let i = 0; i < presets.length; i++) {
        if (!presets[i].name) return { msg: "Preset names cannot be empty.", ctrl: g.el, row: i, col: 0 };
        if (!nameFree(presets[i].name, i)) return { msg: `A preset named '${presets[i].name}' already exists.`, ctrl: g.el, row: i, col: 0 };
      }
      return null;
    });
  };
}

// ------------------------------------------------------------ Design Rules > Zones (PANEL_SETUP_ZONES: PANEL_ZONE_PROPERTIES with the board defaults)
export interface ZoneDefaults { clearance: number; minWidth: number; padConnection: number; thermalGap: number; spokeWidth: number; outline: number; hatchPitch: number; fillMode: number;
  hatchOrientation: number; hatchWidth: number; hatchGap: number; smoothLevel: number; smoothValue: number; cornerSmoothing: number; cornerRadius: number; islands: number; islandArea: number }
export function zonesPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const z = obj(obj(ctx.ds.defaults).zones);
    const v: ZoneDefaults = { clearance: numOr(z.min_clearance, 0.5), minWidth: numOr(z.min_thickness, 0.25), padConnection: numOr(z.pad_connection, 1), thermalGap: numOr(z.thermal_relief_gap, 0.5), spokeWidth: numOr(z.thermal_relief_spoke_width, 0.5),
      outline: numOr(z.border_display_style, 2), hatchPitch: numOr(z.border_hatch_pitch, 0.5), fillMode: numOr(z.fill_mode, 0), hatchOrientation: numOr(z.hatch_orientation, 0), hatchWidth: numOr(z.hatch_thickness, 1), hatchGap: numOr(z.hatch_gap, 1.5),
      smoothLevel: numOr(z.hatch_smoothing_level, 0), smoothValue: numOr(z.hatch_smoothing_value, 0.1), cornerSmoothing: numOr(z.corner_smoothing, 0), cornerRadius: numOr(z.corner_radius, 0), islands: numOr(z.remove_islands, 0), islandArea: numOr(z.min_island_area, 10) };
    const ro = ctx.roPro;
    const panel = zoneSettingsPanel(v, ro);
    put(el, box("Default Properties for New Zones", panel.el));
    ctx.register("Zones", () => {
      const n = panel.get(), P = [...DS, "defaults", "zones"];
      const m: [string, number, boolean?][] = [["min_clearance", n.clearance], ["min_thickness", n.minWidth], ["pad_connection", n.padConnection, true], ["thermal_relief_gap", n.thermalGap], ["thermal_relief_spoke_width", n.spokeWidth],
        ["border_display_style", n.outline, true], ["border_hatch_pitch", n.hatchPitch], ["fill_mode", n.fillMode, true], ["hatch_orientation", n.hatchOrientation], ["hatch_thickness", n.hatchWidth], ["hatch_gap", n.hatchGap],
        ["hatch_smoothing_level", n.smoothLevel, true], ["hatch_smoothing_value", n.smoothValue], ["corner_smoothing", n.cornerSmoothing, true], ["corner_radius", n.cornerRadius], ["remove_islands", n.islands, true], ["min_island_area", n.islandArea]];
      return m.map(([k, val, int]) => ({ path: [...P, k], value: val, ints: int }));
    });
    ctx.validate("Zones", () => panel.validate());
  };
}
/** PANEL_ZONE_PROPERTIES's controls (the notebook of Clearances & Pad Connections / Display Overrides / Hatched Fill, then corner smoothing and islands). */
export function zoneSettingsPanel(v: ZoneDefaults, ro: boolean): { el: HTMLElement; get(): ZoneDefaults; validate(): PageError | null } {
  const clearance = lenField(v.clearance, { ro, key: "clearance" }), minW = lenField(v.minWidth, { ro, key: "minWidth" });
  const conn = selectField<number>(v.padConnection, [[2, "Solid"], [1, "Thermal reliefs"], [3, "Reliefs for PTH"], [0, "None"]], { ro, key: "padConnections" });
  const gap = lenField(v.thermalGap, { ro, key: "thermalGap" }), spoke = lenField(v.spokeWidth, { ro, key: "spokeWidth" });
  const outline = selectField<number>(v.outline, [[0, "Line"], [2, "Hatched"], [1, "Fully hatched"]], { ro, key: "outline" });
  const pitch = lenField(v.hatchPitch, { ro, key: "hatchPitch" });
  const hatched = checkField(v.fillMode === 1, "Hatched fill", { ro, key: "hatched" });
  const orient = numField(v.hatchOrientation, { ro, key: "hatchOrientation", digits: 1 }), hw = lenField(v.hatchWidth, { ro, key: "hatchWidth" }), hg = lenField(v.hatchGap, { ro, key: "hatchGap" });
  const level = spinField(v.smoothLevel, { min: 0, max: 3, ro, key: "smoothLevel" }), amount = spinField(v.smoothValue, { min: 0, max: 1, step: 0.1, digits: 1, ro, key: "smoothValue" });
  const smooth = selectField<number>(v.cornerSmoothing, [[0, "None"], [1, "Chamfer"], [2, "Fillet"]], { ro, key: "smoothing" });
  const radius = lenField(v.cornerRadius, { ro, key: "radius" });
  const islands = selectField<number>(v.islands, [[0, "Always"], [1, "Never"], [2, "Below area limit"]], { ro, key: "islands" });
  islands.input.title = "Choose what to do with unconnected copper islands";
  const area = numField(v.islandArea, { ro, key: "islandArea" });
  const radiusRow = [h("label", null, "Radius:"), radius.el, unitLabel()], areaRow = [h("label", null, "Area limit:"), area.el, unitLabel("mm²")];
  const sync = (): void => {
    // PANEL_ZONE_PROPERTIES::OnUpdateUI: m_cornerRadius.Show( smoothing != NONE ), m_islandThreshold.Show( mode == AREA ), the hatch controls enabled with Hatched fill
    for (const e of radiusRow) (e as HTMLElement).style.display = smooth.get() === 0 ? "none" : "";
    for (const e of areaRow) (e as HTMLElement).style.display = islands.get() === 2 ? "" : "none";
    const on = hatched.get() && !ro; for (const f of [orient, hw, hg]) f.input.disabled = !on; level.enable(on); amount.enable(on && level.get() > 0);
    const thermal = conn.get() === 1 || conn.get() === 3; gap.input.disabled = ro || !thermal; spoke.input.disabled = ro || !thermal;
  };
  for (const f of [smooth, islands, conn]) f.input.addEventListener("change", sync);
  hatched.input.addEventListener("change", sync); level.input.addEventListener("change", sync);
  const tabs = h("div");
  // the notebook
  const pages: [string, HTMLElement][] = [
    ["Clearances & Pad Connections", form([["Clearance:", clearance.el, unitLabel()], ["Minimum width:", minW.el, unitLabel(), "Minimum thickness of filled areas."], ["Pad connections:", conn.el],
      ["Thermal relief gap:", gap.el, unitLabel(), "Clearance between pads in the same net and filled areas."], ["Thermal spoke width:", spoke.el, unitLabel(), "Width of copper in thermal reliefs."]])],
    ["Display Overrides", form([["Outline display:", outline.el], ["Outline hatch pitch:", pitch.el, unitLabel()]])],
    ["Hatched Fill", h("div", null, hatched.el, form([["Orientation:", orient.el, unitLabel("deg")], ["Hatch width:", hw.el, unitLabel()], ["Hatch gap:", hg.el, unitLabel()], ["Smoothing effort:", level.el], ["Smoothing amount:", amount.el]]))]];
  const bar = h("div", { class: "pd-tabs" }), host = h("div", { style: "padding:4px 2px 8px" });
  const show = (i: number): void => { Array.from(bar.children).forEach((b, k) => b.classList.toggle("on", k === i)); host.replaceChildren(pages[i][1]); };
  pages.forEach(([label], i) => { const b = h("button", { type: "button", class: "pd-tab", "data-k": "tab-" + i }, label); b.addEventListener("click", () => show(i)); bar.append(b); });
  show(0); tabs.append(bar, host);
  const lower = h("div", { class: "pd-form" }, h("label", null, "Corner smoothing:"), smooth.el, h("span"), ...radiusRow, h("label", null, "Remove islands:"), islands.el, h("span"), ...areaRow);
  const el = h("div", { class: "pd-zonepanel" }, tabs, lower);
  sync();
  return { el,
    get: () => ({ clearance: clearance.get(), minWidth: minW.get(), padConnection: conn.get(), thermalGap: gap.get(), spokeWidth: spoke.get(), outline: outline.get(), hatchPitch: pitch.get(), fillMode: hatched.get() ? 1 : 0,
      hatchOrientation: orient.get(), hatchWidth: hw.get(), hatchGap: hg.get(), smoothLevel: level.get(), smoothValue: amount.get(), cornerSmoothing: smooth.get(), cornerRadius: radius.get(), islands: islands.get(), islandArea: area.get() }),
    validate() {
      // UNIT_BINDER::Validate( ZONE_BORDER_HATCH_MINDIST_MM, ZONE_BORDER_HATCH_MAXDIST_MM ) and the panel's own checks
      const range = (f: Field<number>, lo: number, hi: number): PageError | null => { const x = f.get(); return x < lo - 1e-9 || x > hi + 1e-9 ? { msg: `${x < lo ? "Minimum" : "Maximum"} value is ${fmtLen(x < lo ? lo : hi)} ${unitName()}.`, ctrl: f.input } : null; };
      return range(pitch, 0.1, 2) || (minW.get() < 0.001 ? { msg: `Minimum width must be at least ${fmtLen(0.001)} ${unitName()}.`, ctrl: minW.input } : null)
        || ((conn.get() === 1 || conn.get() === 3) && spoke.get() < minW.get() ? { msg: "Thermal spoke width cannot be smaller than the minimum width.", ctrl: spoke.input } : null);
    } };
}

// ------------------------------------------------------------ Design Rules > Length-tuning Patterns
export function tuningPatternsPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const t = obj(ctx.ds.tuning_pattern_settings), ro = ctx.roPro;
    const sets: { key: string; title: string; f: { min: Field<number>; max: Field<number>; spacing: Field<number>; corner: Field<number>; radius: Field<number>; single: Field<boolean> } }[] = [];
    const one = (key: string, title: string, d: { min: number; max: number; spacing: number }): HTMLElement => {
      const s = obj(t[key]);
      const f = { min: lenField(numOr(s.min_amplitude, d.min), { ro, key: key + "-min" }), max: lenField(numOr(s.max_amplitude, d.max), { ro, key: key + "-max" }), spacing: lenField(numOr(s.spacing, d.spacing), { ro, key: key + "-spacing" }),
        corner: selectField<number>(numOr(s.corner_style, 1), [[0, "Chamfer"], [1, "Fillet"]], { ro, key: key + "-corner" }), radius: numField(numOr(s.corner_radius_percentage, 80), { ro, key: key + "-radius", digits: 0 }),
        single: checkField(boolOr(s.single_sided, false), "Single-sided", { ro, key: key + "-single" }) };
      sets.push({ key, title, f });
      return box(title, form([["Minimum amplitude (A):", f.min.el, unitLabel()], ["Maximum amplitude (A):", f.max.el, unitLabel()],
        ["Spacing (s):", f.spacing.el, unitLabel(), "Minimum spacing between adjacent tuning segments. The resulting spacing may be greater based on design rules."], ["Corner style:", f.corner.el], ["Radius (r):", f.radius.el, unitLabel("%")], f.single.el]));
    };
    put(el, h("div", { class: "pd-cols3" }, one("single_track_defaults", "Default Properties for Single Track Tuning", { min: 0.1, max: 1, spacing: 0.6 }),
      one("diff_pair_defaults", "Default Properties for Differential Pairs", { min: 0.1, max: 1, spacing: 0.6 }), one("diff_pair_skew_defaults", "Default Properties for Differential Pair Skews", { min: 0.1, max: 1, spacing: 0.6 })));
    ctx.register("Length-tuning Patterns", () => {
      const out: Obj = {};
      for (const s of sets) out[s.key] = { corner_radius_percentage: Math.round(s.f.radius.get()), corner_style: s.f.corner.get(), max_amplitude: s.f.max.get(), min_amplitude: s.f.min.get(), single_sided: s.f.single.get(), spacing: s.f.spacing.get() };
      return [{ path: [...DS, "tuning_pattern_settings"], value: out }];
    });
  };
}

// ------------------------------------------------------------ Design Rules > Tuning Profiles
const PS_PER_CM = (iu: number): number => +(iu / 1e6 * 10).toFixed(6);
const IU_FROM_PS_PER_CM = (v: number): number => Math.round(v / 10 * 1e6);
export function tuningProfilesPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const ro = ctx.roPro;
    const profiles: Obj[] = arr(obj(ctx.pro.tuning_profiles).tuning_profiles_impedance_geometric).map((p) => JSON.parse(JSON.stringify(obj(p))) as Obj);
    const bar = h("div", { class: "pd-tabs" }), host = h("div");
    let cur = -1;
    const commits: (() => void)[] = [];
    const cu = (): string[] => copperNames(ctx).map((c) => c[0]);
    const showProfile = (i: number): void => {
      for (const c of commits.splice(0)) c();
      cur = i; Array.from(bar.children).forEach((b, k) => b.classList.toggle("on", k === i));
      host.replaceChildren(); const p = profiles[i]; if (!p) { host.append(note("No tuning profiles. Use the + button to add one.")); return; }
      const name = textField(strOr(p.profile_name, ""), { ro, key: "profileName" });
      const type = selectField<number>(numOr(p.type, 0), [[0, "Single"], [1, "Differential"]], { ro, key: "profileType" });
      const imp = numField(numOr(p.target_impedance, 0), { ro, key: "targetImpedance" });
      const freqHz = numOr(p.frequency, 1e9); const unit = freqHz >= 1e9 ? 1e9 : freqHz >= 1e6 ? 1e6 : freqHz >= 1e3 ? 1e3 : 1;
      const freq = numField(freqHz / unit, { ro, key: "frequency" }), freqU = selectField<number>(unit, [[1, "Hz"], [1e3, "kHz"], [1e6, "MHz"], [1e9, "GHz"]], { ro, key: "frequencyUnit" });
      const td = checkField(boolOr(p.enable_time_domain_tuning, false), "Enable time domain tuning", { ro, key: "timeDomain" }), mask = checkField(boolOr(p.model_solder_mask, false), "Model solder mask", { ro, key: "modelMask" });
      const bridge = numField(PS_PER_CM(numOr(p.net_chain_bridge_prop_delay, 0)), { ro, key: "bridgeDelay" }), via = numField(PS_PER_CM(numOr(p.via_prop_delay, 0)), { ro, key: "viaDelay" });
      const layers: Record<string, CellValue>[] = arr(p.layer_entries).map(obj).map((l) => ({ signal: strOr(l.signal_layer, "F.Cu"), top: strOr(l.top_reference_layer, ""), bottom: strOr(l.bottom_reference_layer, ""), width: numOr(l.width, 0) / 1e6, gap: numOr(l.diff_pair_gap, 0) / 1e6, delay: PS_PER_CM(numOr(l.delay, 0)) }));
      const lopts: [string, string][] = [["", ""], ...cu().map((n): [string, string] => [n, n])];
      const gl = grid([{ label: "Signal Layer", key: "signal", type: "select", options: lopts }, { label: "Top Reference", key: "top", type: "select", options: lopts }, { label: "Bottom Reference", key: "bottom", type: "select", options: lopts },
        { label: "Track Width", key: "width", type: "len" }, { label: "Diff Pair Gap", key: "gap", type: "len" }, { label: "Unit Delay", key: "delay", type: "num" }], layers, { ro, height: "150px" });
      const vias: Record<string, CellValue>[] = arr(p.via_overrides).map(obj).map((v) => ({ sf: strOr(v.signal_layer_from, ""), st: strOr(v.signal_layer_to, ""), vf: strOr(v.via_layer_from, ""), vt: strOr(v.via_layer_to, ""), delay: numOr(v.delay, 0) / 1e6 }));
      const gv = grid([{ label: "Signal Layer From", key: "sf", type: "select", options: lopts }, { label: "Signal Layer To", key: "st", type: "select", options: lopts }, { label: "Via Layer From", key: "vf", type: "select", options: lopts }, { label: "Via Layer To", key: "vt", type: "select", options: lopts }, { label: "Delay", key: "delay", type: "num" }], vias, { ro, height: "110px" });
      const unitTxt = unitLabel("ps/cm");
      host.append(form([["Name:", name.el], ["Type:", type.el], ["Target impedance:", imp.el, unitLabel("ohms")], ["Frequency:", h("span", { class: "pd-inline" }, freq.el, freqU.el)]]), td.el, mask.el,
        box("Net Chain Bridge Propagation", form([["Global unit delay:", bridge.el, unitLabel("ps/cm")]])),
        box("Track Propagation", gl.el, gridButtons(gl, () => ({ signal: cu()[0] || "F.Cu", top: "", bottom: "", width: NaN, gap: NaN, delay: NaN }), { ro })),
        box("Via Propagation", form([["Global unit delay:", via.el, unitTxt]]), h("div", { class: "pd-lbl" }, "Via delay overrides:"), gv.el, gridButtons(gv, () => ({ sf: "", st: "", vf: "", vt: "", delay: NaN }), { ro })));
      name.input.addEventListener("change", () => { (bar.children[i] as HTMLElement).textContent = name.get() || "(unnamed)"; });
      commits.push(() => {
        p.profile_name = name.get(); p.type = type.get(); p.target_impedance = imp.get(); p.frequency = freq.get() * freqU.get(); p.enable_time_domain_tuning = td.get(); p.model_solder_mask = mask.get();
        p.net_chain_bridge_prop_delay = IU_FROM_PS_PER_CM(bridge.get()); p.via_prop_delay = IU_FROM_PS_PER_CM(via.get());
        p.layer_entries = gl.rows().map((r) => ({ bottom_reference_layer: String(r.bottom), delay: IU_FROM_PS_PER_CM(Number(r.delay) || 0), diff_pair_gap: Math.round((Number(r.gap) || 0) * 1e6), signal_layer: String(r.signal), top_reference_layer: String(r.top), width: Math.round((Number(r.width) || 0) * 1e6) }));
        p.via_overrides = gv.rows().map((r) => ({ delay: Math.round((Number(r.delay) || 0) * 1e6), signal_layer_from: String(r.sf), signal_layer_to: String(r.st), via_layer_from: String(r.vf), via_layer_to: String(r.vt) }));
      });
    };
    const tabs = (): void => { bar.replaceChildren(); profiles.forEach((p, i) => { const b = h("button", { type: "button", class: "pd-tab" }, strOr(p.profile_name, "") || "(unnamed)"); b.addEventListener("click", () => showProfile(i)); bar.append(b); }); };
    const addP = (): void => { for (const c of commits.splice(0)) c(); let n = 1; while (profiles.some((p) => p.profile_name === `Profile ${n}`)) n++;
      profiles.push({ profile_name: `Profile ${n}`, type: 0, target_impedance: 0, frequency: 1e9, model_solder_mask: false, enable_time_domain_tuning: false, via_prop_delay: 0, net_chain_bridge_prop_delay: 0, layer_entries: [], via_overrides: [] }); tabs(); showProfile(profiles.length - 1); };
    const delP = (): void => { if (cur < 0) return; commits.splice(0); profiles.splice(cur, 1); tabs(); showProfile(Math.min(cur, profiles.length - 1)); };
    tabs(); showProfile(profiles.length ? 0 : -1);
    put(el, bar, host, h("div", { class: "pd-gridbar" }, iconButton("plus", "Add tuning profile", addP, ro), h("span", { style: "flex:1" }), iconButton("trash", "Remove tuning profile", delP, ro)));
    ctx.register("Tuning Profiles", () => { for (const c of commits) c(); return [{ path: ["tuning_profiles", "tuning_profiles_impedance_geometric"], value: profiles }]; });
    ctx.validate("Tuning Profiles", () => {
      for (const c of commits) c();
      const names = profiles.map((p) => strOr(p.profile_name, "").trim());
      const i = names.findIndex((n, k) => !n || names.indexOf(n) !== k);
      if (i >= 0) { showProfile(i); return { msg: names[i] ? `Tuning profile name '${names[i]}' already in use.` : "Tuning profile must have a name.", ctrl: host.querySelector("[data-k=profileName]") as HTMLElement }; }
      return null;
    });
  };
}

// ------------------------------------------------------------ Design Rules > Component Classes
const COND_TYPES: [string, string, string?][] = [["REFERENCE", "Reference:"], ["SIDE", "Side:"], ["ROTATION", "Rotation:", "deg"], ["FOOTPRINT", "Footprint:"], ["FOOTPRINT_FIELD", "Footprint field:"], ["CUSTOM", "Custom:"], ["SHEET_NAME", "Sheet name:"]];
export function componentClassesPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const ro = ctx.roPro, cc = obj(ctx.pro.component_class_settings);
    const sheet = checkField(boolOr(obj(cc.sheet_component_classes).enabled, false), "Assign component class per sheet", { ro, key: "sheetClasses" });
    interface Cond { type: string; primary: string; secondary: string }
    interface Assign { cls: string; op: string; conds: Cond[] }
    const assigns: Assign[] = arr(cc.assignments).map(obj).map((a) => ({ cls: strOr(a.component_class, ""), op: strOr(a.conditions_operator, "ALL"), conds: Object.entries(obj(a.conditions)).map(([k, v]) => ({ type: k.replace(/-\d+$/, ""), primary: strOr(obj(v).primary, ""), secondary: strOr(obj(v).secondary, "") })) }));
    const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
    const draw = (): void => {
      list.replaceChildren();
      assigns.forEach((a, ai) => {
        const cls = textField(a.cls, { ro, key: `cc-${ai}-class` }); cls.input.addEventListener("input", () => { a.cls = cls.get(); });
        const op = selectField<string>(a.op, [["ALL", "Match all"], ["ANY", "Match any"]], { ro, key: `cc-${ai}-op`, onChange: (v) => { a.op = v; } });
        const addCond = h("k-select", { disabled: ro, "data-k": `cc-${ai}-add` }); addCond.append(h("option", { value: "" }, "Add Condition"), ...COND_TYPES.map(([t, l]) => h("option", { value: t }, l.replace(/:$/, ""))));
        addCond.addEventListener("change", () => { const t = (addCond as unknown as { value: string }).value; if (t) { a.conds.push({ type: t, primary: t === "SIDE" ? "Any" : "", secondary: "" }); draw(); } });
        const rows = a.conds.map((c, ci) => {
          const spec = COND_TYPES.find((x) => x[0] === c.type) || [c.type, c.type + ":"];
          const p = c.type === "SIDE" ? selectField<string>(c.primary || "Any", [["Any", "Any"], ["Front", "Front"], ["Back", "Back"]], { ro, onChange: (v) => { c.primary = v; } }) : textField(c.primary, { ro });
          if (c.type !== "SIDE") p.input.addEventListener("input", () => { c.primary = String(p.get()); });
          const extra = c.type === "FOOTPRINT_FIELD" ? (() => { const s = textField(c.secondary, { ro }); s.input.addEventListener("input", () => { c.secondary = s.get(); }); return [h("label", null, "Field value:"), s.el]; })() : [];
          return h("div", { class: "pd-row" }, h("label", { style: "min-width:110px" }, c.type === "FOOTPRINT_FIELD" ? "Footprint field:" : spec[1]), p.el, spec[2] ? unitLabel(spec[2]) : null, ...extra, iconButton("trash", "Delete row", () => { a.conds.splice(ci, 1); draw(); }, ro));
        });
        list.append(h("div", { class: "pd-box", style: "border:1px solid var(--line);border-radius:var(--r-2);padding:8px" },
          h("div", { class: "pd-row" }, h("label", null, "Component class:"), cls.el, op.el, addCond, h("button", { type: "button", class: "btn", disabled: true, title: "Highlights the footprints this assignment matches on the board" }, "Highlight matching footprints"), h("span", { style: "flex:1" }), iconButton("trash", "Delete row", () => { assigns.splice(ai, 1); draw(); }, ro)),
          ...rows));
      });
    };
    draw();
    put(el, sheet.el, h("div", { class: "pd-row", style: "margin-top:8px" }, h("label", null, "Custom Assignments:"), h("span", { style: "flex:1" }), h("button", { type: "button", class: "btn", disabled: ro, onclick: () => { assigns.push({ cls: "", op: "ALL", conds: [] }); draw(); } }, "Add Custom Assignment")), list);
    ctx.register("Component Classes", () => [{ path: ["component_class_settings", "sheet_component_classes", "enabled"], value: sheet.get() },
      { path: ["component_class_settings", "assignments"], value: assigns.map((a) => { const conds: Obj = {}; for (const c of a.conds) { let k = c.type, n = 1; while (k in conds) k = `${c.type}-${n++}`; const o: Obj = {}; if (c.primary) o.primary = c.primary; if (c.secondary) o.secondary = c.secondary; conds[k] = o; } return { component_class: a.cls, conditions_operator: a.op, conditions: conds }; }) }]);
    ctx.validate("Component Classes", () => { const i = assigns.findIndex((a) => !a.cls.trim()); return i >= 0 ? { msg: "Component class must have a name.", ctrl: list.querySelector(`[data-k="cc-${i}-class"]`) as HTMLElement } : null; });
  };
}

// ------------------------------------------------------------ Board Data > Embedded Files
export function embeddedFilesPage(ctx: SetupCtx) {
  return (el: HTMLElement): void => {
    const files: Record<string, CellValue>[] = [];
    const text = ctx.boardText || "";
    const at = text.indexOf("(embedded_files");
    if (at >= 0) { const re = /\(file\s*\(name\s+"((?:[^"\\]|\\.)*)"\)/g; re.lastIndex = at; let m: RegExpExecArray | null; while ((m = re.exec(text))) { if (text.lastIndexOf("(embedded_files", m.index) !== at) break; files.push({ name: m[1], ref: "kicad-embed://" + m[1] }); } }
    const fonts = /\(embedded_fonts\s+yes\)/.test(text);
    const g = grid([{ label: "Filename", key: "name", type: "ro" }, { label: "Embedded Reference", key: "ref", type: "ro" }], files, { height: "340px" });
    const embed = checkField(fonts, "Embed fonts", { ro: true, key: "embedFonts", tip: "Store a copy of all fonts used" });
    put(el, g.el, h("div", { class: "pd-gridbar" }, iconButton("plus", "Add embedded file", () => undefined, true), iconButton("trash", "Remove embedded file", () => undefined, true), h("span", { style: "flex:1" }), embed.el,
      h("button", { type: "button", class: "btn", disabled: true }, "Export...")), note("Files are embedded in the board file; adding and removing them is done in the desktop application."));
    void E;
  };
}

/** DIALOG_IMPORT_SETTINGS's options, in its order. */
export const IMPORT_OPTIONS: [string, string][] = [["layers", "Board layers and physical stackup"], ["mask", "Solder mask/paste defaults"], ["hatchOffsets", "Zone hatched fill offsets"], ["textDefaults", "Text & graphics default properties"],
  ["formatting", "Text & graphics formatting"], ["constraints", "Design rule constraints"], ["sizes", "Predefined track & via dimensions"], ["zones", "Zone defaults"], ["teardrops", "Teardrop defaults"],
  ["tuning", "Length-tuning pattern defaults"], ["netclasses", "Net classes"], ["componentClasses", "Component classes"], ["tuningProfiles", "Tuning Profiles"], ["rules", "Custom rules"], ["severities", "Violation severities"]];
