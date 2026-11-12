// dialogs/preferences.ts — Preferences → Preferences… (Ctrl+,) in both editors: KiCad's paged dialog with the panels
// that mean something in a browser.  Common > Mouse and Touchpad (common/dialogs/panel_mouse_settings), Hotkeys
// (panel_hotkeys_editor, read-only here); Schematic Editor > Display Options, Grids, Editing Options, Colors;
// PCB Editor > Display Options, Grids.  Everything is kept in localStorage (prefs.ts) and applied on OK.
import { E, toast } from "./editor";
import { actions as SPEC_ACTIONS } from "../generated/kicad-ui-spec.json";
import { KD, checkbox, h, promptText, select, textInput } from "./dom";
import { COLOR_THEMES, DEFAULT_PREFS, clonePrefs, gridLabel, savePrefs, type EditorId, type Prefs, type SchThemeId } from "./prefs";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme";

interface ActionMeta { id: string; label: string; key: string | null }
const MIL = 0.0254;
/** "50 mil", "0.5 mm", "1.27" (mm) -> mm; null when it is not a size. */
export function parseGrid(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(mm|mil|mils|in|")?\s*$/i.exec(text); if (!m) return null;
  const v = parseFloat(m[1]), u = (m[2] || "mm").toLowerCase(); const mm = u === "mm" ? v : u === "in" || u === '"' ? v * 25.4 : v * MIL;
  return mm > 0 ? +mm.toFixed(6) : null;
}

export function openPreferences(page?: string): void {
  const p: Prefs = clonePrefs();
  let uiMode: ThemeMode = getThemeMode();
  const here: EditorId = E.DOC_TYPE === "kicad_sch" ? "sch" : "pcb";
  const gridsPage = (ed: EditorId) => (pg: HTMLElement) => {
    const g = p.grids[ed], o = g.overrides, pre = `kd-pref-${ed}`;
    const cols = h("div", { style: "display:grid;grid-template-columns:220px 1fr;gap:20px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
    const list = h("select", { size: 12, id: `${pre}-gridlist`, style: "width:100%;height:230px" });
    const choices = () => g.sizes.map((mm, i) => [String(i), gridLabel(mm)] as [string, string]);
    const fast1 = select(choices(), String(g.fast1), (v) => { g.fast1 = +v; }, { id: `${pre}-fast1` }), fast2 = select(choices(), String(g.fast2), (v) => { g.fast2 = +v; }, { id: `${pre}-fast2` });
    const ovSel: Record<string, HTMLSelectElement> = {};
    const fill = () => {
      list.replaceChildren(...g.sizes.map((mm, i) => h("option", { value: String(i) }, gridLabel(mm))));
      for (const [sel, idx] of [[fast1, g.fast1], [fast2, g.fast2]] as [HTMLSelectElement, number][]) { sel.replaceChildren(...choices().map(([v, l]) => h("option", { value: v }, l))); sel.value = String(Math.min(idx, g.sizes.length - 1)); }
      for (const [k, s] of Object.entries(ovSel)) { const mm = (o as unknown as Record<string, number>)[k + "Mm"]; const opts = g.sizes.some((x) => Math.abs(x - mm) < 1e-6) ? g.sizes : [...g.sizes, mm]; s.replaceChildren(...opts.map((x) => h("option", { value: String(x) }, gridLabel(x)))); s.value = String(opts.find((x) => Math.abs(x - mm) < 1e-6)); }
    };
    const btn = (txt: string, title: string, id: string, fn: () => void) => h("button", { class: "btn", type: "button", title, id, onclick: fn }, txt);
    L.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Grids"), list, h("div", { class: "kd-grid-btns" },
      btn("+", "Add", `${pre}-gridadd`, () => { void promptText("Add Grid", "Grid size (for example 0.5 mm or 25 mil):").then((t) => { if (t === null) return; const mm = parseGrid(t); if (!mm) { toast("Grid size must be a positive length"); return; } if (g.sizes.some((x) => Math.abs(x - mm) < 1e-6)) { toast("Grid size already exists"); return; } g.sizes.push(mm); fill(); }); }),
      btn("↑", "Move up", `${pre}-gridup`, () => { const i = list.selectedIndex; if (i > 0) { [g.sizes[i - 1], g.sizes[i]] = [g.sizes[i], g.sizes[i - 1]]; fill(); list.selectedIndex = i - 1; } }),
      btn("↓", "Move down", `${pre}-griddown`, () => { const i = list.selectedIndex; if (i >= 0 && i < g.sizes.length - 1) { [g.sizes[i + 1], g.sizes[i]] = [g.sizes[i], g.sizes[i + 1]]; fill(); list.selectedIndex = i + 1; } }),
      btn("🗑", "Delete", `${pre}-griddel`, () => { const i = list.selectedIndex; if (i < 0) return; if (g.sizes.length <= 1) { toast("At least one grid size is required"); return; } g.sizes.splice(i, 1); g.fast1 = Math.min(g.fast1, g.sizes.length - 1); g.fast2 = Math.min(g.fast2, g.sizes.length - 1); fill(); })));
    const fb = KD().staticBox(R, "Fast Grid Switching");
    fb.append(h("div", { style: "display:grid;grid-template-columns:max-content 160px max-content;gap:6px 10px;align-items:center" }, h("label", null, "Grid 1:"), fast1, h("span", { class: "ro" }, "(Alt+1)"), h("label", null, "Grid 2:"), fast2, h("span", { class: "ro" }, "(Alt+2)")));
    const ob = KD().staticBox(R, "Grid Overrides"), og = h("div", { style: "display:grid;grid-template-columns:max-content 160px;gap:6px 10px;align-items:center" });
    const ov = (key: "connected" | "wires" | "vias" | "text" | "graphics", label: string) => { const s = h("select", { id: `${pre}-ov-${key}` }); s.addEventListener("change", () => { (o as unknown as Record<string, number>)[key + "Mm"] = +s.value; }); ovSel[key] = s;
      og.append(checkbox(label, o[key], (on) => { o[key] = on; }, { id: `${pre}-ovon-${key}` }), s); };
    ov("connected", "Connected items:"); ov("wires", "Wires:"); if (ed === "pcb") ov("vias", "Vias:"); ov("text", "Text:"); ov("graphics", "Graphics:");
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
        { label: "PCB Editor", pages: [
          { label: "Display Options", build(pg) {
            const ap = KD().staticBox(pg, "Annotations");
            ap.append(checkbox("Show pad numbers", p.pcbDisplay.showPadNumbers, (on) => { p.pcbDisplay.showPadNumbers = on; }, { id: "kd-pref-padnumbers" }), checkbox("Show net names", p.pcbDisplay.showNetNames, (on) => { p.pcbDisplay.showNetNames = on; }, { id: "kd-pref-netnames" }),
              checkbox("High-contrast display mode", p.pcbDisplay.highContrast, (on) => { p.pcbDisplay.highContrast = on; }, { id: "kd-pref-contrast" }));
          } },
          { label: "Grids", build: gridsPage("pcb") },
          { label: "Editing Options", build(pg) {
            // panel_edit_options (PCB): the Miscellaneous box's zone refill
            const misc = KD().staticBox(pg, "Miscellaneous");
            misc.append(checkbox("Automatically refill zones", p.pcbEditing.autoRefillZones, (on) => { p.pcbEditing.autoRefillZones = on; }, { id: "kd-pref-autorefill", title: "If checked, zones will be re-filled after each edit operation" }));
          } },
        ] },
      ], { selected: page || (here === "sch" ? "Mouse and Touchpad" : "Mouse and Touchpad") });
    },
    ok() { if (uiMode !== getThemeMode()) setThemeMode(uiMode); savePrefs(p); toast("Preferences saved"); } });
}
