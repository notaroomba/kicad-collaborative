// dialogs/preferences.ts — Preferences → Preferences… (Ctrl+,) in both editors: KiCad's paged dialog with the panels
// that mean something in a browser.  Common > Mouse and Touchpad (common/dialogs/panel_mouse_settings), Hotkeys
// (panel_hotkeys_editor, read-only here); Schematic Editor > Display Options, Grids, Editing Options, Colors;
// PCB Editor > Display Options, Grids, Origins & Axes, Editing Options.  Everything is kept in localStorage (prefs.ts) and applied on OK.
import { trapTab } from "../tools/kicad-dialogs/shell";
import { E, toast } from "./editor";
import { IS_MAC, keyName, modName } from "../keys";
import { hotkeysPanel } from "./hotkeys-panel";
import type { UserHotkeys } from "../menuspec";
import { KD, checkbox, h, select, textInput } from "./dom";
import { lenField, messageBox } from "../editor/pcbdialogs/ui";
import { loadUnits, messageText, unitName } from "../units";
import { COLOR_THEMES, DEFAULT_PREFS, clonePrefs, editorId, gridLabel, savePrefs, scaleOf, type EditorId, type Prefs, type SchThemeId } from "./prefs";
import type { Units } from "../store";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme";
import { getInactiveMode, setInactiveMode } from "../editor/panels/appearance";
import { wakatimePage, type WakaPage } from "./wakatime";
import { assignScrollMod, type ScrollMod } from "../editor/wheel-model";

const MIL = 0.0254;

const units = (): Units => (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
/** A length typed in a grid field: a number in the user units, or with its own unit ("25 mil", "0.5mm", "0.1 in"). */
function parseUserLen(text: string): number | null {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(mm|mils?|in|"|th)?\s*$/i.exec(text); if (!m) return null;
  const v = parseFloat(m[1].replace(",", ".")), u = (m[2] || units()).toLowerCase();
  return u === "mm" ? v : u === "in" || u === '"' ? v * 25.4 : v * MIL;
}
/**
 * DIALOG_GRID_SETTINGS ("Grid Settings"): Name (optional), X and Y in the user units, Linked.  It opens over the
 * Preferences dialog; OK checks the range (0.001 to 1000 mm).  The web editor's grids are square, so Y follows X.
 */
export function gridSettingsDialog(grid: { mm: number; name: string } | null, ed: EditorId): Promise<{ mm: number; name: string } | null> {
  return new Promise((resolve) => {
    const u = units(), show = (mm: number): string => messageText(mm, u, scaleOf(ed), false).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    const name = h("input", { type: "text", id: "kd-grid-name", value: grid ? grid.name : "" });
    const x = h("input", { type: "text", id: "kd-grid-x", value: grid ? show(grid.mm) : "" }), y = h("input", { type: "text", id: "kd-grid-y", value: grid ? show(grid.mm) : "", disabled: true });
    const linked = h("input", { type: "checkbox", id: "kd-grid-linked", checked: true, disabled: true });
    x.addEventListener("input", () => { y.value = x.value; });
    const unit = (): HTMLElement => h("span", { class: "ro" }, u === "mil" ? "mils" : u);
    const body = h("div", { class: "kd-body" }, h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content;align-items:center" },
      h("label", { for: "kd-grid-name" }, "Name:"), name, h("span", { class: "ro" }, "(optional)"),
      h("label", { for: "kd-grid-x" }, "X:"), x, unit(),
      h("span"), h("label", { class: "kd-chk", title: "The web editor's grids are square: Y is always X" }, linked, "Linked"), h("span"),
      h("label", { for: "kd-grid-y" }, "Y:"), y, unit()));
    const done = (ok: boolean): void => {
      if (!ok) { ov.remove(); resolve(null); return; }
      const mm = parseUserLen(x.value);
      if (mm === null || mm < 0.001 || mm > 1000) { messageBox("Error", "Grid size X out of range."); x.focus(); return; }
      ov.remove(); resolve({ mm: +mm.toFixed(6), name: name.value.trim() });
    };
    const okB = h("button", { class: "btn primary", type: "button", onclick: () => done(true) }, "OK"), cancel = h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", role: "dialog", "aria-label": "Grid Settings", style: "width:360px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, "Grid Settings")), body, h("div", { class: "kd-foot" }, cancel, okB));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); name.focus();
  });
}

/** pcb-tools.js's arc editing mode (APP_SETTINGS m_ArcEditMode, also switched from the Arc toolbar group and Ctrl+Space). */
type ArcEditTools = { arcEditMode(): number; setArcEditMode(m: number): void; angleSnapMode?(): string; setAngleSnap?(ctx: null, mode: string): string };
/** The board's curved ratsnest flag (PCB_DISPLAY_OPTIONS m_DisplayRatsnestLinesCurved, also View > Curved Ratsnest Lines). */
const ratsnestState = (): { curvedRatsnest: boolean; setCurvedRatsnest(on: boolean): void } | null => { const k = (window as unknown as { KiCadCanvas?: { pcbSizes?: { state?: { curvedRatsnest: boolean; setCurvedRatsnest(on: boolean): void } } } }).KiCadCanvas; return (k && k.pcbSizes && k.pcbSizes.state) || null; };
const pcbTools = (): ArcEditTools | null => { const t = (window as unknown as { PcbTools?: Partial<ArcEditTools> }).PcbTools; return t && t.arcEditMode && t.setArcEditMode ? (t as ArcEditTools) : null; };

/** The edits of an open Preferences dialog, kept when a page is reset (the dialog is rebuilt around them). */
interface Staged { p: Prefs; uiMode: ThemeMode; arcEdit: number; hv45?: boolean; curved?: boolean; contrast: ReturnType<typeof getInactiveMode>; hotkeys?: UserHotkeys }
/** PAGED_DIALOG's g_lastPage: the page the dialog was last closed on, for the next opening in this session. */
let lastPage: string | null = null;
/** The defaults a page's Reset to Defaults puts back (RESETTABLE_PANEL::ResetPanel of that page only). */
export function resetPage(key: string, st: Staged): void {
  const d = JSON.parse(JSON.stringify(DEFAULT_PREFS)) as Prefs;
  switch (key) {
    case "Common/Common": st.uiMode = "system"; st.p.common = d.common; break;
    case "Common/Mouse and Touchpad": st.p.mouse = d.mouse; break;
    case "Symbol Editor/Grids": st.p.grids.sym = d.grids.sym; break;
    case "Schematic Editor/Display Options": st.p.schDisplay = d.schDisplay; break;
    case "Schematic Editor/Grids": st.p.grids.sch = d.grids.sch; break;
    case "Schematic Editor/Editing Options": st.p.schEditing = d.schEditing; break;
    case "Schematic Editor/Colors": st.p.schColors = d.schColors; break;
    case "Footprint Editor/Grids": st.p.grids.fp = d.grids.fp; break;
    case "Footprint Editor/Editing Options": st.p.fpEditing = d.fpEditing; break;
    case "PCB Editor/Display Options": st.p.pcbDisplay = d.pcbDisplay; break;
    case "PCB Editor/Grids": st.p.grids.pcb = d.grids.pcb; break;
    case "PCB Editor/Origins & Axes": st.p.pcbOrigin = d.pcbOrigin; break;
    case "PCB Editor/Editing Options": st.p.pcbEditing = d.pcbEditing; st.p.pcbDisplay.showPageLimits = d.pcbDisplay.showPageLimits; st.arcEdit = 0; st.hv45 = true; st.curved = false; break;
    default: break;
  }
}

/** Preferences…; `page` is a page label or "Section/Page" ("PCB Editor/Grids"); without one, the page last used. */
export function openPreferences(page?: string, staged?: Staged): void {
  const p: Prefs = staged ? staged.p : clonePrefs();
  let uiMode: ThemeMode = staged ? staged.uiMode : getThemeMode();
  let arcEdit = staged ? staged.arcEdit : pcbTools() ? pcbTools()!.arcEditMode() : 0;
  // m_AngleSnapMode != LEADER_MODE::DIRECT, and the curved ratsnest: the board tools' live state, written back on OK when changed
  const snap0 = pcbTools() && pcbTools()!.angleSnapMode ? pcbTools()!.angleSnapMode!() : "45";
  let hv45 = staged && staged.hv45 !== undefined ? staged.hv45 : snap0 !== "free";
  const curved0 = !!(ratsnestState() && ratsnestState()!.curvedRatsnest);
  let curved = staged && staged.curved !== undefined ? staged.curved : curved0;
  // the inactive layer mode is the open board's project setting (.kicad_prl "board.high_contrast_mode"), not a user preference
  let contrast = staged ? staged.contrast : getInactiveMode();
  let waka: WakaPage | null = null;
  let hk: ReturnType<typeof hotkeysPanel> | null = null, body0: HTMLElement | null = null;
  const pageKey = (): string => { const n = body0 && body0.querySelector<HTMLElement>(".kd-tb-node.child.on"); return (n && n.dataset.page) || ""; };
  // the frame it was opened from: its grid list's selection is the grid in use (the Symbol Editor keeps its own)
  const here: EditorId | null = document.getElementById("symedit") ? null : E.kdoc ? editorId() : null;
  // PANEL_GRID_SETTINGS: the grid list (its selection is the current grid, grid.last_size), Add / Edit / Move / Remove
  // through DIALOG_GRID_SETTINGS, the fast grids, the overrides and the axes.  Every list shows the grids as
  // GRID_MENU::BuildChoiceList does, in the user units with the other system in brackets.
  const gridsPage = (ed: EditorId) => (pg: HTMLElement) => {
    const g = p.grids[ed], o = g.overrides, pre = `kd-pref-${ed}`;
    g.names = g.sizes.map((_, i) => (g.names && g.names[i]) || "");
    if (ed === here) { const at = g.sizes.findIndex((mm) => Math.abs(mm - E.gridPitch) < 1e-9); if (at >= 0) g.last = at; }
    const cols = h("div", { style: "display:grid;grid-template-columns:260px 1fr;gap:20px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
    const list = h("k-select", { size: 12, id: `${pre}-gridlist`, style: "width:100%;height:230px" });
    const text = (i: number): string => gridLabel({ mm: g.sizes[i], name: g.names![i] }, ed);
    const choices = () => g.sizes.map((_, i) => [String(i), text(i)] as [string, string]);
    const fast1 = select(choices(), String(g.fast1), (v) => { g.fast1 = +v; }, { id: `${pre}-fast1` }), fast2 = select(choices(), String(g.fast2), (v) => { g.fast2 = +v; }, { id: `${pre}-fast2` });
    const ovSel: Record<string, HTMLSelectElement> = {};
    const fill = (sel?: number) => {
      const cur = sel ?? Math.max(0, Math.min(g.sizes.length - 1, g.last ?? 0));
      list.replaceChildren(...g.sizes.map((_, i) => h("option", { value: String(i) }, text(i)))); list.selectedIndex = cur; g.last = cur;
      for (const [sel2, idx] of [[fast1, g.fast1], [fast2, g.fast2]] as [HTMLSelectElement, number][]) { sel2.replaceChildren(...choices().map(([v, l]) => h("option", { value: v }, l))); sel2.value = String(Math.max(0, Math.min(idx, g.sizes.length - 1))); }
      for (const [k, s2] of Object.entries(ovSel)) { const mm = (o as unknown as Record<string, number>)[k + "Mm"]; const at = g.sizes.findIndex((x) => Math.abs(x - mm) < 1e-6); s2.replaceChildren(...g.sizes.map((x, i) => h("option", { value: String(x) }, text(i)))); s2.value = String(g.sizes[at >= 0 ? at : 0]); (o as unknown as Record<string, number>)[k + "Mm"] = g.sizes[at >= 0 ? at : 0]; }
    };
    list.addEventListener("change", () => { g.last = list.selectedIndex; });
    const exists = (mm: number, skip: number): boolean => g.sizes.some((x, i) => i !== skip && Math.abs(x - mm) < 1e-6);
    const dup = (mm: number): void => { messageBox("Error", `Grid size '${messageText(mm, units(), scaleOf(ed))}' already exists.`); };
    const add = (): void => { void gridSettingsDialog(null, ed).then((r) => { if (!r) return; if (exists(r.mm, -1)) { dup(r.mm); return; }
      const row = list.selectedIndex < 0 ? g.sizes.length : list.selectedIndex; g.sizes.splice(row, 0, r.mm); g.names!.splice(row, 0, r.name);
      if (g.fast1 >= row) g.fast1++; if (g.fast2 >= row) g.fast2++; fill(row); }); };
    const edit = (): void => { const row = list.selectedIndex; if (row < 0) return;
      void gridSettingsDialog({ mm: g.sizes[row], name: g.names![row] }, ed).then((r) => { if (!r) return; if (exists(r.mm, row)) { dup(r.mm); return; } g.sizes[row] = r.mm; g.names![row] = r.name; fill(row); }); };
    const swap = (i: number, j: number): void => { [g.sizes[i], g.sizes[j]] = [g.sizes[j], g.sizes[i]]; [g.names![i], g.names![j]] = [g.names![j], g.names![i]]; };
    list.addEventListener("dblclick", edit);
    const btn = (icon: string, title: string, id: string, fn: () => void) => h("button", { class: "btn kd-bmp", type: "button", title, "aria-label": title, id, onclick: fn }, icon);
    L.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Grids"), list, h("div", { class: "kd-grid-btns" },
      btn("+", "Add", `${pre}-gridadd`, add),
      btn("✎", "Edit", `${pre}-gridedit`, edit),
      btn("↑", "Move up", `${pre}-gridup`, () => { const i = list.selectedIndex; if (i > 0) { swap(i - 1, i); fill(i - 1); } }),
      btn("↓", "Move down", `${pre}-griddown`, () => { const i = list.selectedIndex; if (i >= 0 && i < g.sizes.length - 1) { swap(i + 1, i); fill(i + 1); } }),
      btn("🗑", "Remove", `${pre}-griddel`, () => { const i = list.selectedIndex; if (i < 0 || g.sizes.length <= 1) return; g.sizes.splice(i, 1); g.names!.splice(i, 1);
        g.fast1 = Math.min(g.fast1 > i ? g.fast1 - 1 : g.fast1, g.sizes.length - 1); g.fast2 = Math.min(g.fast2 > i ? g.fast2 - 1 : g.fast2, g.sizes.length - 1); fill(i !== 0 ? i - 1 : 0); })));
    const fb = KD().staticBox(R, "Fast Grid Switching");
    fb.append(h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,240px) max-content;gap:6px 10px;align-items:center" }, h("label", null, "Grid 1:"), fast1, h("span", { class: "ro" }, `(${keyName("Alt+1")})`), h("label", null, "Grid 2:"), fast2, h("span", { class: "ro" }, `(${keyName("Alt+2")})`)));
    const ob = KD().staticBox(R, "Grid Overrides"), og = h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,240px);gap:6px 10px;align-items:center" });
    const ov = (key: "connected" | "wires" | "vias" | "text" | "graphics", label: string) => { const s2 = select([], "", (v) => { (o as unknown as Record<string, number>)[key + "Mm"] = +v; }, { id: `${pre}-ov-${key}` }); ovSel[key] = s2;
      og.append(checkbox(label, o[key], (on) => { o[key] = on; }, { id: `${pre}-ovon-${key}` }), s2); };
    // PANEL_GRID_SETTINGS relabels the overrides for the board editor, and the footprint editor has no wires or vias
    if (ed === "fp") ov("connected", "Pads:");
    else { ov("connected", ed === "pcb" ? "Footprints/pads:" : "Connected items:"); ov("wires", ed === "pcb" ? "Tracks:" : "Wires:"); }
    if (ed === "pcb") ov("vias", "Vias:");
    ov("text", "Text:"); ov("graphics", "Graphics:");
    ob.append(og); KD().staticBox(R, "Grid Display").append(checkbox("Show grid axes", !!g.axes, (on) => { g.axes = on; }, { id: `${pre}-gridaxes` })); fill();
  };
  KD().open({ title: "Preferences", width: 900, cls: "kd-wide kd-flush",
    // PAGED_DIALOG::onResetButton: only the page on show goes back to its defaults, and nothing is saved before OK
    extra: [{ label: "Reset to Defaults", fn: () => {
      const key = pageKey();
      if (key === "Common/Hotkeys") { if (hk) hk.resetToDefaults(); return; }
      if (key === "Common/WakaTime") return;   // nothing local to reset: the key is removed with Remove Key
      const st: Staged = { p, uiMode, arcEdit, hv45, curved, contrast, hotkeys: hk ? hk.staged() : undefined };
      resetPage(key, st); KD().close(); openPreferences(key, st);
    } }],
    cancel() { lastPage = pageKey() || lastPage; },
    build(body) {
      body0 = body;
      KD().treebook(body, [
        { label: "Common", pages: [
          { label: "Common", build(pg) {
            // panel_common_settings' "User Interface" box: the web's light / dark chrome (web/theme.ts)
            const ui = KD().staticBox(pg, "User Interface");
            ui.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "Appearance:"),
              select([["light", "Light"], ["dark", "Dark"], ["system", "System"]], uiMode, (v) => { uiMode = v as ThemeMode; }, { id: "kd-pref-uitheme", style: "width:160px" })),
              h("p", { class: "kd-note", style: "margin:8px 0 0" }, "System follows the light or dark setting of your computer.  Also in Preferences > Appearance."));
            // panel_common_settings' Appearance box: m_highContrastCtrl (0..1, step 0.1)
            const ap = KD().staticBox(pg, "Appearance");
            const dim = h("input", { type: "number", min: "0", max: "1", step: "0.1", value: String(p.common.hcDimming), id: "kd-pref-hcdim", style: "width:80px" }) as HTMLInputElement;
            dim.addEventListener("change", () => { const v = Math.max(0, Math.min(1, +dim.value)); if (isFinite(v)) { p.common.hcDimming = v; dim.value = String(v); } });
            ap.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "High-contrast mode dimming factor:"), dim));
          } },
          { label: "Mouse and Touchpad", build(pg) { mousePage(pg, p); } },
          { label: "Hotkeys", build(pg) { hk = hotkeysPanel(pg, staged && staged.hotkeys); } },
          // not a KiCad panel: Junction's WakaTime heartbeats (the desktop app has the same page)
          { label: "WakaTime", build(pg) { waka = wakatimePage(pg, (host, title) => KD().staticBox(host, title)); } },
        ] },
        // PANEL_SYM_EDIT_GRIDS: the Symbol Editor's own window settings
        { label: "Symbol Editor", pages: [
          { label: "Grids", build: gridsPage("sym") },
        ] },
        { label: "Schematic Editor", pages: [
          { label: "Display Options", build(pg) {
            const ap = KD().staticBox(pg, "Appearance");
            ap.append(checkbox("Show hidden pins", p.schDisplay.showHiddenPins, (on) => { p.schDisplay.showHiddenPins = on; }, { id: "kd-pref-hiddenpins" }), checkbox("Show hidden fields", p.schDisplay.showHiddenFields, (on) => { p.schDisplay.showHiddenFields = on; }, { id: "kd-pref-hiddenfields" }));
          } },
          { label: "Grids", build: gridsPage("sch") },
          { label: "Editing Options", build(pg) {
            // PANEL_EESCHEMA_EDITING_OPTIONS
            const se = p.schEditing, ed = KD().staticBox(pg, "Editing");
            ed.append(h("div", { class: "kd-row", style: "margin-bottom:6px" }, h("label", { style: "color:var(--ink-2)" }, "Line drawing mode:"), select([["free", "Free Angle"], ["90", "90 deg Angle"], ["45", "45 deg Angle"]], se.lineMode, (v) => { se.lineMode = v as "free" | "90" | "45"; }, { id: "kd-pref-linemode", style: "width:160px" })),
              checkbox("Mouse drag performs Drag (G) operation", se.mouseDragIsDrag, (on) => { se.mouseDragIsDrag = on; }, { id: "kd-pref-dragmode", title: "If unchecked, mouse drag will perform move (M) operation" }),
              checkbox("Automatically start wires on unconnected pins", se.autoStartWires, (on) => { se.autoStartWires = on; }, { id: "kd-pref-autowires", title: "When enabled, you can start wiring by clicking on unconnected pins even when the wire tool is not active" }),
              checkbox("<ESC> clears net highlighting", se.escClearsNetHighlight, (on) => { se.escClearsNetHighlight = on; }, { id: "kd-pref-escnet", title: "First <ESC> in selection tool clears selection, next clears net highlighting" }),
              checkbox("Automatically annotate symbols", se.autoAnnotate, (on) => { se.autoAnnotate = on; }, { id: "kd-pref-autoannotate" }));
            // Repeated Items: the pitches through UNIT_BINDER in the schematic editor's units, the label step a spin control
            const su = loadUnits("eeschema").units, uname = unitName(su);
            const pitch = (id: string, mm: number, set: (v: number) => void): HTMLInputElement => {
              const f = lenField(mm, { units: su, onChange: set }); f.input.id = id; f.input.style.width = "90px";
              return f.input as HTMLInputElement;
            };
            const inc = h("input", { type: "number", id: "kd-pref-repeatinc", min: "-100000", max: "100000", step: "1", value: String(se.repeatIncrement), style: "width:90px" }) as HTMLInputElement;
            inc.addEventListener("change", () => { const v = Math.round(+inc.value); if (isFinite(v)) { se.repeatIncrement = Math.max(-100000, Math.min(100000, v)); inc.value = String(se.repeatIncrement); } });
            const ri = KD().staticBox(pg, "Repeated Items");
            ri.append(h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 8px;align-items:center" },
              h("label", null, "Horizontal pitch:"), pitch("kd-pref-repeatx", se.repeatX, (v) => { se.repeatX = v; }), h("span", { class: "ro" }, uname),
              h("label", null, "Vertical pitch:"), pitch("kd-pref-repeaty", se.repeatY, (v) => { se.repeatY = v; }), h("span", { class: "ro" }, uname),
              h("label", null, "Label increment:"), inc, h("span", null)));
          } },
          { label: "Colors", build(pg) {
            const sw = h("div", { id: "kd-pref-swatches", style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:12px" });
            const names: [string, string][] = [["bg", "Background"], ["wire", "Wires"], ["bus", "Buses"], ["junction", "Junctions"], ["outline", "Symbol body outlines"], ["body", "Symbol body fills"], ["pin", "Pins"], ["pinName", "Pin names"], ["pinNum", "Pin numbers"], ["ref", "References"], ["value", "Values"], ["field", "Fields"], ["label", "Labels"], ["glabel", "Global labels"], ["hlabel", "Hierarchical labels"], ["sheet", "Sheet borders"], ["notes", "Schematic text && graphics"], ["frame", "Drawing sheet"]];
            // the swatches preview the theme picked in the dialog; the canvas changes on OK
            const paint = () => { const C = KiCadCanvas.schThemeColors(p.schColors.theme); sw.replaceChildren(...names.map(([k, n]) => h("div", { class: "kd-row", style: "width:240px;gap:6px" }, h("span", { style: `display:inline-block;width:26px;height:14px;border:1px solid var(--line);background:${C[k] || "transparent"}` }), n.replace("&&", "&")))); };
            pg.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "Theme:"), select(COLOR_THEMES, p.schColors.theme, (v) => { p.schColors.theme = v as SchThemeId; paint(); }, { id: "kd-pref-theme", style: "width:220px" })),
              h("div", { style: "margin-top:8px" }, checkbox("Follow the app's dark mode for the schematic sheet", p.schColors.followDark, (on) => { p.schColors.followDark = on; }, { id: "kd-pref-followdark", title: "While the user interface is dark, draw the schematic with the Dark theme" })), sw,
              h("p", { class: "kd-note", style: "margin-top:10px" }, "A new theme is applied when the dialog is closed with OK.  Plots and exports always use KiCad Default."));
            paint();
          } },
        ] },
        // PANEL_FP_GRIDS: the Footprint Editor's own window settings
        { label: "Footprint Editor", pages: [
          { label: "Grids", build: gridsPage("fp") },
          { label: "Editing Options", build(pg) {
            // PANEL_EDIT_OPTIONS( isFootprintEditor ): FOOTPRINT_EDITOR_SETTINGS' own rotation step, m_sizerBoardEdit
            // hidden, and Ctrl only toggles the selection (m_rbHighlightNet hidden); the options book shows the empty fpPage
            const e = p.fpEditing;
            const ed = KD().staticBox(pg, "Editing Options");
            const rot = textInput(String(e.rotationAngle), (v) => { const n = parseFloat(v); if (isFinite(n) && n > 0 && n <= 360) e.rotationAngle = n; }, { id: "kd-pref-fp-rotstep", style: "width:80px" });
            rot.title = "Set increment (in degrees) for context menu and hotkey rotation.";
            ed.append(h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 8px;align-items:center" },
              h("label", { style: "color:var(--ink-2);white-space:nowrap" }, "Step for rotate commands:"), h("div", { class: "kd-row", style: "gap:6px" }, rot, h("span", null, "deg"))));
            KD().staticBox(pg, "Left Click Mouse Commands").append(...leftClickCommands("Toggle selection"));
          } },
        ] },
        { label: "PCB Editor", pages: [
          { label: "Display Options", build(pg) {
            const ap = KD().staticBox(pg, "Annotations");
            ap.append(checkbox("Show pad numbers", p.pcbDisplay.showPadNumbers, (on) => { p.pcbDisplay.showPadNumbers = on; }, { id: "kd-pref-padnumbers" }), checkbox("Show net names", p.pcbDisplay.showNetNames, (on) => { p.pcbDisplay.showNetNames = on; }, { id: "kd-pref-netnames" }),
              checkbox("High-contrast display mode", contrast !== "normal", (on) => { contrast = on ? (contrast === "normal" ? "dim" : contrast) : "normal"; }, { id: "kd-pref-contrast" }));
            // panel_display_options: Clearance Outlines ▸ Tracks (clearanceModeMap: the choice index is the mode)
            const cl = KD().staticBox(pg, "Clearance Outlines");
            cl.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "Tracks:"),
              select([["0", "Do not show clearances"], ["1", "Show when routing"], ["2", "Show when routing w/ via clearance at end"], ["3", "Show when routing and editing"], ["4", "Show always"]], String(p.pcbDisplay.trackClearance), (v) => { p.pcbDisplay.trackClearance = +v; }, { id: "kd-pref-trackclearance", style: "width:320px" })),
              checkbox("Show pad clearance", p.pcbDisplay.padClearance !== false, (on) => { p.pcbDisplay.padClearance = on; }, { id: "kd-pref-padclearance" }));
          } },
          { label: "Grids", build: gridsPage("pcb") },
          { label: "Origins & Axes", build(pg) {
            // panel_pcbnew_display_origin: where the status bar counts from, and which way each axis increases
            const o = p.pcbOrigin;
            const group = (title: string, name: string, rows: [string, string][], value: string, set: (v: string) => void) => {
              const box = h("div", { style: "margin-bottom:12px" }, h("div", { style: "margin-bottom:4px" }, title));
              for (const [v, label] of rows) {
                const r = h("input", { type: "radio", name, value: v, id: `kd-pref-${name}-${v}` }) as HTMLInputElement; r.checked = v === value;
                r.addEventListener("change", () => { if (r.checked) set(v); });
                box.append(h("label", { class: "kd-row", style: "margin-left:16px;gap:6px" }, r, label));
              }
              pg.append(box);
            };
            group("Display Origin", "origin", [["page", "Page origin"], ["aux", "Drill/place file origin"], ["grid", "Grid origin"]], o.origin, (v) => { o.origin = v as "page" | "aux" | "grid"; });
            group("X Axis", "xaxis", [["right", "Increases right"], ["left", "Increases left"]], o.invertX ? "left" : "right", (v) => { o.invertX = v === "left"; });
            group("Y Axis", "yaxis", [["up", "Increases up"], ["down", "Increases down"]], o.invertY ? "up" : "down", (v) => { o.invertY = v === "up"; });
          } },
          { label: "Editing Options", build(pg) {
            // panel_edit_options (PCB): Editing Options and Left Click Mouse Commands on the left, Ratsnest and
            // Miscellaneous on the right (the board page of m_optionsBook)
            const e = p.pcbEditing;
            const L = h("div", { style: "flex:1 1 360px;min-width:0" }), R = h("div", { style: "flex:1 1 260px;min-width:0" });
            pg.append(h("div", { style: "display:flex;gap:16px;flex-wrap:wrap" }, L, R));
            const row = (label: string, ...ctl: Node[]) => h("div", { class: "kd-row", style: "margin-bottom:6px;gap:6px" }, h("label", { style: "color:var(--ink-2)" }, label), ...ctl);
            const ed = KD().staticBox(L, "Editing Options");
            const rot = textInput(String(e.rotationAngle), (v) => { const n = parseFloat(v); if (isFinite(n) && n > 0 && n <= 360) e.rotationAngle = n; }, { id: "kd-pref-rotstep", style: "width:80px" });
            rot.title = "Set increment (in degrees) for context menu and hotkey rotation.";
            const grid = (...rows: [string, Node][]) => h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 8px;align-items:center;margin-top:6px" },
              ...rows.flatMap(([l, c]) => [h("label", { style: "color:var(--ink-2);white-space:nowrap" }, l), c]));
            ed.append(checkbox("Constrain actions to H, V, 45 degrees", hv45, (on) => { hv45 = on; }, { id: "kd-pref-hv45" }),
              grid(["Step for rotate commands:", h("div", { class: "kd-row", style: "gap:6px" }, rot, h("span", null, "deg"))],
                ["Arc editing mode:", select([["0", "Keep center, adjust radius"], ["1", "Keep endpoints or direction of starting point"], ["2", "Keep center and radius, adjust endpoints"]], String(arcEdit), (v) => { arcEdit = +v; }, { id: "kd-pref-arcedit", style: "width:100%" })],
                ["Track mouse-drag mode:", select([["move", "Move"], ["drag", "Drag (45 degree mode)"], ["dragFree", "Drag (free angle)"]], e.trackDragAction, (v) => { e.trackDragAction = v as typeof e.trackDragAction; }, { id: "kd-pref-trackdrag", style: "width:100%" })]));
            // Left Click Mouse Commands (m_mouseCmdsWinLin / m_mouseCmdsOSX): fixed rows, and Ctrl's choice
            const lc = KD().staticBox(L, "Left Click Mouse Commands");
            const radio = (v: boolean, label: string) => { const r = h("input", { type: "radio", name: "kd-pref-ctrlclick", id: `kd-pref-ctrlclick-${v ? "hl" : "toggle"}` }) as HTMLInputElement; r.checked = e.ctrlClickHighlight === v; r.addEventListener("change", () => { if (r.checked) e.ctrlClickHighlight = v; }); return h("label", { class: "kd-row", style: "gap:6px" }, r, label); };
            lc.append(...leftClickCommands(h("div", null, radio(false, "Toggle selection"), radio(true, "Highlight net (for pads/tracks)"))));
            const rb = KD().staticBox(R, "Ratsnest");
                        // wxSpinCtrlDouble( 0.5, 10, 0.5, 0.5 ) with 1 digit: a typed value is clamped to the range and rounded
            const thick = h("input", { type: "number", min: "0.5", max: "10", step: "0.5", value: String(e.ratsnestThickness), id: "kd-pref-ratsthick", style: "width:80px" }) as HTMLInputElement;
            thick.addEventListener("change", () => { const n = parseFloat(thick.value); if (!isFinite(n)) { thick.value = String(e.ratsnestThickness); return; }
              e.ratsnestThickness = Math.round(Math.max(0.5, Math.min(10, n)) * 10) / 10; thick.value = String(e.ratsnestThickness); });
            rb.append(checkbox("Show ratsnest with curved lines", curved, (on) => { curved = on; }, { id: "kd-pref-curvedrats" }), row("Ratsnest line thickness:", thick));
            const misc = KD().staticBox(R, "Miscellaneous");
            misc.append(checkbox("<ESC> clears net highlighting", e.escClearsNetHighlight, (on) => { e.escClearsNetHighlight = on; }, { id: "kd-pref-escclears" }),
              checkbox("Show page limits", p.pcbDisplay.showPageLimits, (on) => { p.pcbDisplay.showPageLimits = on; }, { id: "kd-pref-pagelimits", title: "Draw an outline to show the sheet size." }),
              checkbox("Show courtyard collisions when moving/dragging", e.showCourtyardCollisions, (on) => { e.showCourtyardCollisions = on; }, { id: "kd-pref-courtyard" }),
              checkbox("Automatically refill zones", e.autoRefillZones, (on) => { e.autoRefillZones = on; }, { id: "kd-pref-autorefill", title: "If checked, zones will be re-filled after each edit operation" }));
          } },
        ] },
      ], { selected: page || lastPage || "Mouse and Touchpad" });
    },
    ok() {
      // PANEL_MOUSE_SETTINGS::TransferDataFromWindow: one modifier per vertical scroll action
      if (!scrollModsValid(p.mouse)) { toast("Only one action can be assigned to each vertical scroll setting", 4000); return false; }
      lastPage = pageKey() || lastPage; if (hk) hk.apply(); if (uiMode !== getThemeMode()) setThemeMode(uiMode); savePrefs(p); if (contrast !== getInactiveMode()) setInactiveMode(contrast); if (pcbTools() && arcEdit !== pcbTools()!.arcEditMode()) pcbTools()!.setArcEditMode(arcEdit);
      // PANEL_EDIT_OPTIONS::TransferDataFromWindow: m_AngleSnapMode = checked ? DEG45 : DIRECT (only when the box changed, so a 90 degree mode stays)
      const t = pcbTools(); if (t && t.setAngleSnap && hv45 !== (snap0 !== "free")) t.setAngleSnap(null, hv45 ? "45" : "free");
      const rs = ratsnestState(); if (rs && curved !== curved0) rs.setCurvedRatsnest(curved); toast("Preferences saved");
      if (waka) waka.apply().catch((e) => toast(`WakaTime settings were not saved: ${e instanceof Error ? e.message : String(e)}`)); } });
}

/** isScrollModSetValid: zoom, pan left / right and pan up / down each on a different modifier. */
export function scrollModsValid(m: Prefs["mouse"]): boolean { return m.zoomMod !== m.panHMod && m.panHMod !== m.panVMod && m.panVMod !== m.zoomMod; }

/**
 * PANEL_MOUSE_SETTINGS (common/dialogs/panel_mouse_settings_base.cpp): Pan and Zoom, Drag Gestures and Scroll
 * Gestures, with the radio grid of modifiers per vertical-scroll action and the two reset buttons.
 */
/**
 * PANEL_EDIT_OPTIONS' Left Click Mouse Commands (m_mouseCmdsWinLin / m_mouseCmdsOSX): the note and the fixed rows, the
 * Ctrl row showing `ctrl` (the board editor's Toggle selection / Highlight net choice).  The modifier names come from
 * keys.ts, in the order each of KiCad's two panels writes them ("Ctrl+Shift", "Shift+Cmd").
 */
function leftClickCommands(ctrl: Node | string): HTMLElement[] {
  const ctrlK = modName("Ctrl"), shiftK = modName("Shift"), altK = modName("Alt");
  const cmds: [string, Node | string][] = [["Click:", "Select item(s)"], ["Long Click:", "Clarify selection from menu"], [`${shiftK}:`, "Add item(s) to selection"],
    [IS_MAC ? `${shiftK}+${ctrlK}:` : `${ctrlK}+${shiftK}:`, "Remove item(s) from selection"], [`${ctrlK}:`, ctrl]];
  if (IS_MAC) cmds.push([`${altK}:`, "Clarify selection from menu"]);
  const note = IS_MAC ? `Left click (and drag) actions depend on 3 modifier keys:\n${altK}, ${shiftK} and ${ctrlK}` : `Left click (and drag) actions depend on 2 modifier keys:\n${shiftK} and ${ctrlK}`;
  return [h("div", { style: "font-style:italic;color:var(--ink-3);font-size:var(--fs-sm);margin-bottom:6px;white-space:pre-line" }, note),
    h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;align-items:start" }, ...cmds.flatMap(([k, v]) => [h("span", null, k), typeof v === "string" ? h("span", null, v) : v]))];
}

function mousePage(pg: HTMLElement, p: Prefs): void {
  const m = p.mouse;
  const pz = KD().staticBox(pg, "Pan and Zoom");
  const zoomSlider = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(m.zoomSpeed), id: "kd-pref-zoomspeed", disabled: m.autoZoomSpeed, style: "width:160px" }) as HTMLInputElement;
  zoomSlider.addEventListener("input", () => { m.zoomSpeed = +zoomSlider.value; });
  const panSlider = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(m.autoPanSpeed), id: "kd-pref-autopanspeed", style: "width:160px" }) as HTMLInputElement;
  panSlider.addEventListener("input", () => { m.autoPanSpeed = +panSlider.value; });
  // wxGridBagSizer: (0,0) center, (0,2) auto pan, (1,0..2) acceleration, (2,0) zoom speed, (2,2) auto pan speed
  pz.append(h("div", { style: "display:grid;grid-template-columns:max-content 30px max-content;gap:4px 0;align-items:center" },
    checkbox("Center and warp cursor on zoom", m.centerOnZoom, (on) => { m.centerOnZoom = on; }, { id: "kd-pref-centerzoom" }), h("span"),
    checkbox("Automatically pan while moving object", m.autoPan, (on) => { m.autoPan = on; }, { id: "kd-pref-autopan" }),
    h("div", { style: "grid-column:1 / span 3" }, checkbox("Use zoom acceleration", m.zoomAccel, (on) => { m.zoomAccel = on; }, { id: "kd-pref-zoomaccel" })),
    h("div", { class: "kd-row", style: "margin-top:6px" }, h("label", { style: "color:var(--ink-2)" }, "Zoom speed:"), zoomSlider,
      checkbox("Automatic", m.autoZoomSpeed, (on) => { m.autoZoomSpeed = on; zoomSlider.disabled = on; }, { id: "kd-pref-zoomauto" })), h("span"),
    h("div", { class: "kd-row", style: "margin-top:6px" }, h("label", { style: "color:var(--ink-2)" }, "Auto pan speed:"), panSlider)));
  const dg = KD().staticBox(pg, "Drag Gestures");
  const drag3: [string, string][] = [["pan", "Pan"], ["zoom", "Zoom"], ["none", "None"]];
  dg.append(h("div", { style: "display:grid;grid-template-columns:max-content 340px;gap:6px 10px;align-items:center" },
    h("label", null, "Left button drag:"), select([["select", "Draw selection rectangle"], ["dragSelected", "Drag selected objects; otherwise draw selection rectangle"], ["dragAny", "Drag any object (selected or not)"]],
      m.leftDrag, (v) => { m.leftDrag = v as Prefs["mouse"]["leftDrag"]; }, { id: "kd-pref-left" }),
    h("label", null, "Middle button drag:"), select(drag3, m.middleDrag, (v) => { m.middleDrag = v as Prefs["mouse"]["middleDrag"]; }, { id: "kd-pref-middle" }),
    h("label", null, "Right button drag:"), select(drag3, m.rightDrag, (v) => { m.rightDrag = v as Prefs["mouse"]["rightDrag"]; }, { id: "kd-pref-right" }),
    h("label", null, "Pan on mouse movement with key:"), select([["", "None"], ["alt", modName("Alt")], ["ctrl", modName("Ctrl")], ["shift", modName("Shift")]], m.motionPanMod, (v) => { m.motionPanMod = v as ScrollMod; }, { id: "kd-pref-motionpan" })));
  const sg = KD().staticBox(pg, "Scroll Gestures");
  const touch = select([["native", "Native gestures (recommended)"], ["scroll", "Configurable scroll gestures"]], m.touchpadMode, (v) => { m.touchpadMode = v as "native" | "scroll"; }, { id: "kd-pref-touchpad" });
  sg.append(h("div", { class: "kd-row" }, h("label", { style: "white-space:nowrap" }, "Touchpad navigation:"), touch),
    h("p", { class: "kd-note", style: "margin:4px 0 8px" }, "Native gestures use two-finger movement to pan and pinch to zoom. Mouse wheel mappings remain active in both modes."),
    h("div", { style: "margin-bottom:4px" }, "Vertical touchpad or scroll wheel movement:"));
  const warn = h("div", { class: "kd-note", id: "kd-pref-scrollwarn", style: "color:var(--err);display:none" }, "Only one action can be assigned to each column");
  const grid = h("div", { id: "kd-pref-scrollgrid", style: "display:grid;grid-template-columns:max-content repeat(4, 42px) max-content;gap:4px 0;align-items:center;justify-items:center" });
  // panel_mouse_settings.cpp: the column labels are Cmd and Option on macOS
  const MODS: [ScrollMod, string][] = [["", "--"], ["ctrl", modName("Ctrl")], ["shift", modName("Shift")], ["alt", modName("Alt")]];
  const radios: Record<string, HTMLInputElement[]> = {};
  const reverse: Record<string, HTMLInputElement> = {};
  const rowKey = { zoom: "zoomMod", panv: "panVMod", panh: "panHMod" } as const;
  const sync = () => {
    for (const [row, key] of Object.entries(rowKey)) radios[row]!.forEach((r, i) => { r.checked = m[key] === MODS[i]![0]; });
    reverse.zoom!.checked = m.reverseZoom; reverse.panh!.checked = m.reversePanH; hzPan.checked = m.horizontalPan;
    warn.style.display = scrollModsValid(m) ? "none" : "";
  };
  grid.append(h("span"), ...MODS.map(([, l]) => h("label", { style: "color:var(--ink-2)" }, l)), h("span"));
  for (const [row, label] of [["zoom", "Zoom:"], ["panv", "Pan up/down:"], ["panh", "Pan left/right:"]] as const) {
    radios[row] = MODS.map(([mod]) => {
      const r = h("input", { type: "radio", name: `kd-pref-scroll-${row}`, "data-mod": mod || "none", id: `kd-pref-${row}-${mod || "none"}` }) as HTMLInputElement;
      r.addEventListener("change", () => {
        const cur = { zoom: m.zoomMod, panh: m.panHMod, panv: m.panVMod }; const next = assignScrollMod(cur, row, mod);
        m.zoomMod = next.zoom; m.panHMod = next.panh; m.panVMod = next.panv; sync();
      });
      return r;
    });
    let rev: Node = h("span");
    if (row !== "panv") { const cb = h("input", { type: "checkbox", id: `kd-pref-${row}-reverse` }) as HTMLInputElement; reverse[row] = cb;
      cb.addEventListener("change", () => { if (row === "zoom") m.reverseZoom = cb.checked; else m.reversePanH = cb.checked; }); rev = h("label", { class: "kd-chk", style: "justify-self:start;margin-left:8px" }, cb, "Reverse"); }
    grid.append(h("label", { style: "justify-self:end;padding-right:8px" }, label), ...radios[row]!, rev);
  }
  const hzPan = h("input", { type: "checkbox", id: "kd-pref-hpan" }) as HTMLInputElement;
  hzPan.addEventListener("change", () => { m.horizontalPan = hzPan.checked; });
  // onMouseDefaults / onTrackpadDefaults
  const setMods = (zoom: ScrollMod, panh: ScrollMod, panv: ScrollMod, hpan: boolean) => { m.zoomMod = zoom; m.panHMod = panh; m.panVMod = panv; m.reverseZoom = false; m.reversePanH = false; m.horizontalPan = hpan; sync(); };
  sg.append(grid, warn, h("label", { class: "kd-chk", style: "margin-top:8px" }, hzPan, "Pan left/right with horizontal movement"),
    h("div", { class: "kd-row", style: "margin-top:10px;gap:8px" },
      h("button", { class: "btn", type: "button", id: "kd-pref-mousedefaults", onclick: () => setMods("", "ctrl", "shift", false) }, "Reset to Mouse Defaults"),
      h("button", { class: "btn", type: "button", id: "kd-pref-trackpaddefaults", onclick: () => { m.touchpadMode = "scroll"; touch.value = "scroll"; setMods("ctrl", "shift", "", true); } }, "Reset to Configurable Touchpad Defaults")));
  sync();
}
