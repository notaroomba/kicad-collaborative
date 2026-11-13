// dialogs/preferences.ts — Preferences → Preferences… (Ctrl+,) in both editors: KiCad's paged dialog with the panels
// that mean something in a browser.  Common > Mouse and Touchpad (common/dialogs/panel_mouse_settings), Hotkeys
// (panel_hotkeys_editor, read-only here); Schematic Editor > Display Options, Grids, Editing Options, Colors;
// PCB Editor > Display Options, Grids, Origins & Axes, Editing Options.  Everything is kept in localStorage (prefs.ts) and applied on OK.
import { E, toast } from "./editor";
import { keyName } from "../keys";
import { actions as SPEC_ACTIONS } from "../generated/kicad-ui-spec.json";
import { KD, checkbox, h, select, textInput } from "./dom";
import { messageBox } from "../editor/pcbdialogs/ui";
import { messageText } from "../units";
import { COLOR_THEMES, DEFAULT_PREFS, clonePrefs, editorId, gridLabel, savePrefs, scaleOf, type EditorId, type Prefs, type SchThemeId } from "./prefs";
import type { Units } from "../store";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme";
import { getInactiveMode, setInactiveMode } from "../editor/panels/appearance";

interface ActionMeta { id: string; label: string; key: string | null }
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
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); name.focus();
  });
}

/** pcb-tools.js's arc editing mode (APP_SETTINGS m_ArcEditMode, also switched from the Arc toolbar group and Ctrl+Space). */
type ArcEditTools = { arcEditMode(): number; setArcEditMode(m: number): void };
const pcbTools = (): ArcEditTools | null => { const t = (window as unknown as { PcbTools?: Partial<ArcEditTools> }).PcbTools; return t && t.arcEditMode && t.setArcEditMode ? (t as ArcEditTools) : null; };

/** Preferences…; `page` is a page label or "Section/Page" ("PCB Editor/Grids"). */
export function openPreferences(page?: string): void {
  const p: Prefs = clonePrefs();
  let uiMode: ThemeMode = getThemeMode();
  let arcEdit = pcbTools() ? pcbTools()!.arcEditMode() : 0;
  // the inactive layer mode is the open board's project setting (.kicad_prl "board.high_contrast_mode"), not a user preference
  let contrast = getInactiveMode();
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
    extra: [{ label: "Reset to Defaults", fn: () => { savePrefs(JSON.parse(JSON.stringify(DEFAULT_PREFS)) as Prefs); KD().close(); openPreferences(); } }],
    build(body) {
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
          { label: "Mouse and Touchpad", build(pg) {
            const pz = KD().staticBox(pg, "Pan and Zoom");
            const slider = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(p.mouse.zoomSpeed), id: "kd-pref-zoomspeed", disabled: p.mouse.autoZoomSpeed, style: "width:220px", title: "How far to zoom in for each rotation of the mouse wheel" });
            slider.addEventListener("input", () => { p.mouse.zoomSpeed = +slider.value; });
            pz.append(checkbox("Center and warp cursor on zoom", p.mouse.centerOnZoom, (on) => { p.mouse.centerOnZoom = on; }, { title: "Center the cursor on screen when zooming.", disabled: true }),
              h("div", { class: "kd-row", style: "margin-top:6px" }, h("label", { style: "color:var(--ink-2)" }, "Zoom speed:"), slider, checkbox("Automatic", p.mouse.autoZoomSpeed, (on) => { p.mouse.autoZoomSpeed = on; slider.disabled = on; }, { id: "kd-pref-zoomauto", title: "Pick the zoom speed automatically" })));
            const dg = KD().staticBox(pg, "Drag Gestures");
            dg.append(h("div", { style: "display:grid;grid-template-columns:max-content 200px;gap:6px 10px;align-items:center" },
              h("label", null, "Left button drag:"), select(["Draw selection rectangle"], "Draw selection rectangle", undefined, { disabled: true }),
              h("label", null, "Middle button drag:"), select([["pan", "Pan"], ["none", "None"]], p.mouse.middleDrag, (v) => { p.mouse.middleDrag = v as "pan" | "none"; }, { id: "kd-pref-middle" }),
              h("label", null, "Right button drag:"), select([["pan", "Pan"], ["none", "None"]], p.mouse.rightDrag, (v) => { p.mouse.rightDrag = v as "pan" | "none"; }, { id: "kd-pref-right" })));
            const sg = KD().staticBox(pg, "Scroll Gestures");
            sg.append(h("p", { class: "kd-note", style: "margin:0" }, "Vertical touchpad or scroll wheel movement zooms; the browser's own gestures pan with a middle or right button drag."));
          } },
          { label: "Hotkeys", build(pg) {
            const all = (Object.values(SPEC_ACTIONS) as ActionMeta[]).filter((a) => a.key);
            const seen = new Set<string>(), rows = all.filter((a) => { const k = a.label + "\u0000" + a.key; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.label.localeCompare(b.label));
            const tb = h("tbody", { id: "kd-pref-hotkeys" });
            const fill = (q: string) => { const t = q.trim().toLowerCase(); tb.replaceChildren(...rows.filter((a) => !t || a.label.toLowerCase().includes(t) || String(a.key).toLowerCase().includes(t)).map((a) => h("tr", null, h("td", { class: "ro" }, a.label.replace(/\.\.\.$/, "…")), h("td", { class: "ro", style: "width:170px;font-family:var(--mono)" }, String(a.key))))); };
            pg.append(textInput("", fill, { id: "kd-pref-hotkey-filter", placeholder: "Type filter text", style: "margin-bottom:8px" }),
              h("div", { class: "kd-grid-wrap", style: "height:340px" }, h("table", { class: "kd-grid" }, h("thead", null, h("tr", null, h("th", null, "Command"), h("th", null, "Hotkey"))), tb)),
              h("p", { class: "kd-note", style: "margin-top:6px" }, "Hotkeys are KiCad's defaults; they cannot be changed in the web editor."));
            fill("");
          } },
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
            const ed = KD().staticBox(pg, "Editing");
            ed.append(h("div", { class: "kd-row", style: "margin-bottom:6px" }, h("label", { style: "color:var(--ink-2)" }, "Line drawing mode:"), select([["free", "Free Angle"], ["90", "90 deg Angle"], ["45", "45 deg Angle"]], p.schEditing.lineMode, (v) => { p.schEditing.lineMode = v as "free" | "90" | "45"; }, { id: "kd-pref-linemode", style: "width:160px" })),
              checkbox("Mouse drag performs Drag (G) operation", p.schEditing.mouseDragIsDrag, (on) => { p.schEditing.mouseDragIsDrag = on; }, { id: "kd-pref-dragmode", title: "If unchecked, mouse drag will perform move (M) operation" }),
              checkbox("Automatically annotate symbols", p.schEditing.autoAnnotate, (on) => { p.schEditing.autoAnnotate = on; }, { id: "kd-pref-autoannotate" }));
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
            // panel_edit_options (PCB): the arc editing mode, and the Miscellaneous box's zone refill
            const ed = KD().staticBox(pg, "Editing Options");
            ed.append(h("div", { class: "kd-row", style: "margin-bottom:6px" }, h("label", { style: "color:var(--ink-2)" }, "Arc editing mode:"),
              select([["0", "Keep center, adjust radius"], ["1", "Keep endpoints or direction of starting point"], ["2", "Keep center and radius, adjust endpoints"]], String(arcEdit), (v) => { arcEdit = +v; }, { id: "kd-pref-arcedit", style: "width:300px" })));
            const misc = KD().staticBox(pg, "Miscellaneous");
            misc.append(checkbox("Automatically refill zones", p.pcbEditing.autoRefillZones, (on) => { p.pcbEditing.autoRefillZones = on; }, { id: "kd-pref-autorefill", title: "If checked, zones will be re-filled after each edit operation" }));
          } },
        ] },
      ], { selected: page || "Mouse and Touchpad" });
    },
    ok() { if (uiMode !== getThemeMode()) setThemeMode(uiMode); savePrefs(p); if (contrast !== getInactiveMode()) setInactiveMode(contrast); if (pcbTools() && arcEdit !== pcbTools()!.arcEditMode()) pcbTools()!.setArcEditMode(arcEdit); toast("Preferences saved"); } });
}
