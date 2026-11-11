// dialogs/schematic-setup.ts — File → Schematic Setup… (eeschema/dialogs/dialog_schematic_setup.cpp): KiCad's paged
// dialog over the project file.  General > Formatting / Field Name Templates / BOM Presets, Electrical Rules >
// Violation Severity / Pin Conflicts Map, Project > Net Classes / Bus Alias Definitions / Text Variables.
// OK writes the .kicad_pro (project.ts saveProject) — schematic.drawing, schematic.bom_*presets, schematic.bus_aliases,
// erc.rule_severities, erc.pin_map, net_settings.classes / netclass_patterns and text_variables — keeping every key the
// dialog does not show.  The web editor itself honours the text variables, the junction dot size, the dash / gap
// ratios, the rule severities and the pin conflicts map; the other values are stored for the desktop.
import { E, toast } from "./editor";
import { KD, checkbox, h, select, textInput, type GridApi } from "./dom";
import { DEFAULT_PIN_MAP, ERC_RULES, PIN_TYPE_NAMES, defaultSeverity, type Severity } from "./erc-rules";
import { str } from "./logic";
import { loadProject, obj, proDoc, saveProject, sub, type Json, type JsonObj } from "./project";

const MIL = 0.0254;
const JUNCTION_SIZES = ["None", "Smallest", "Small", "Default", "Large", "Largest"], HOP_SIZES = ["None", "Smallest", "Small", "Medium", "Large", "Largest"];
/** EESCHEMA_SETTINGS::m_Drawing.junction_size_mult_list: the dot's diameter as a multiple of the default wire width. */
export const JUNCTION_MULT = [0, 1.7, 4, 6, 9, 12];
const LINE_STYLES = ["Solid", "Dashed", "Dotted", "Dash-Dot", "Dash-Dot-Dot"];
const V_RANGES = ["Auto", "fV", "pV", "nV", "uV", "mV", "V", "KV", "MV", "GV", "TV", "PV"], I_RANGES = ["Auto", "fA", "pA", "nA", "uA", "mA", "A", "KA", "MA", "GA", "TA", "PA"];
const DRAWING_DEFAULTS: Record<string, Json> = { default_text_size: 50, overbar_offset_ratio: 1.23, text_offset_ratio: 0.15, label_size_ratio: 0.375, default_line_thickness: 6, pin_symbol_size: 25, show_dnp_markers: true,
  junction_size_choice: 3, hop_over_size_choice: 0, intersheets_ref_show: false, intersheets_ref_own_page: true, intersheets_ref_short: false, intersheets_ref_prefix: "[", intersheets_ref_suffix: "]",
  dashed_lines_dash_length_ratio: 12, dashed_lines_gap_length_ratio: 3, operating_point_overlay_v_precision: 3, operating_point_overlay_v_range: "~V", operating_point_overlay_i_precision: 3, operating_point_overlay_i_range: "~A" };
const numOf = (v: Json | undefined, d: number): number => (typeof v === "number" ? v : d);

/** The values the renderer takes from the project (SCHEMATIC_SETTINGS): junction diameter in mm, dash / gap ratios. */
export function schRenderSettings(pro: JsonObj): { junctionDiameter: number; dash: number; gap: number } {
  const s = obj(pro.schematic), d = obj(s.drawing), classes = obj(pro.net_settings).classes;
  const dflt = Array.isArray(classes) ? (classes as JsonObj[]).find((c) => c && c.name === "Default") : undefined;
  const wire = numOf(dflt ? dflt.wire_width : undefined, numOf(d.default_wire_thickness, 6));
  const choice = Math.max(0, Math.min(5, Math.round(numOf(d.junction_size_choice, 3))));
  return { junctionDiameter: +(wire * JUNCTION_MULT[choice] * MIL).toFixed(4), dash: numOf(d.dashed_lines_dash_length_ratio, 12), gap: numOf(d.dashed_lines_gap_length_ratio, 3) };
}

interface FieldTpl { name: string; visible: boolean; url: boolean }
interface NameRow { name: string }
interface NetClassRow { name: string; wire: string; bus: string; color: string; style: string; src: JsonObj }
interface PatternRow { pattern: string; netclass: string }
interface VarRow { name: string; value: string }

export function openSchematicSetup(page?: string): void {
  if (!proDoc()) { toast("This project has no .kicad_pro file"); return; }
  void loadProject().then((pro0) => build(JSON.parse(JSON.stringify(pro0)) as JsonObj, page));
}
function build(pro: JsonObj, page?: string): void {
  const ro = !!E.viewOnly;
  const sch = sub(pro, "schematic"), drawing = sub(pro, "schematic", "drawing"), erc = sub(pro, "erc"), net = sub(pro, "net_settings");
  const dv = (k: string): Json => (drawing[k] !== undefined ? drawing[k] : DRAWING_DEFAULTS[k]);
  const units: string = E.units === "mil" ? "mils" : E.units === "in" ? "in" : "mm";
  const toUser = (mils: number) => (units === "mils" ? mils : units === "in" ? mils / 1000 : mils * MIL), fromUser = (v: number) => (units === "mils" ? v : units === "in" ? v * 1000 : v / MIL);
  const fmt = (v: number) => String(+v.toFixed(units === "mm" ? 4 : units === "in" ? 5 : 2));
  // ---- working copies
  const templates: FieldTpl[] = (Array.isArray(drawing.field_names) ? drawing.field_names as JsonObj[] : []).map((f) => ({ name: str(f.name), visible: !!f.visible, url: !!f.url }));
  const bomPresets: NameRow[] = (Array.isArray(sch.bom_presets) ? sch.bom_presets as JsonObj[] : []).map((p) => ({ name: str(p.name) }));
  const bomFmts: NameRow[] = (Array.isArray(sch.bom_fmt_presets) ? sch.bom_fmt_presets as JsonObj[] : []).map((p) => ({ name: str(p.name) }));
  const sev: Record<string, Severity> = {}; const stored = obj(erc.rule_severities);
  for (const r of ERC_RULES) if (r[1]) { const s = stored[r[1]]; sev[r[1]] = s === "error" || s === "warning" || s === "ignore" ? s : defaultSeverity(r[1]); }
  const pinMap: number[][] = DEFAULT_PIN_MAP.map((row, i) => row.map((v, j) => { const pm = erc.pin_map as number[][] | undefined; const x = Array.isArray(pm) && Array.isArray(pm[i]) ? pm[i][j] : undefined; return x === 0 || x === 1 || x === 2 ? x : v; }));
  const classes: NetClassRow[] = (Array.isArray(net.classes) ? net.classes as JsonObj[] : [{ name: "Default", wire_width: 6, bus_width: 12, line_style: 0, schematic_color: "rgba(0, 0, 0, 0.000)" }]).map((c) => ({ name: str(c.name), wire: numOf(c.wire_width, 6) + " mils", bus: numOf(c.bus_width, 12) + " mils", color: str(c.schematic_color || "rgba(0, 0, 0, 0.000)"), style: LINE_STYLES[numOf(c.line_style, 0)] || "Solid", src: c }));
  const patterns: PatternRow[] = (Array.isArray(net.netclass_patterns) ? net.netclass_patterns as JsonObj[] : []).map((p) => ({ pattern: str(p.pattern), netclass: str(p.netclass) }));
  const aliases: { name: string; members: NameRow[] }[] = Object.entries(obj(sch.bus_aliases)).map(([name, m]) => ({ name, members: (Array.isArray(m) ? m : []).map((x) => ({ name: str(x) })) }));
  const vars: VarRow[] = Object.entries(obj(pro.text_variables)).map(([name, value]) => ({ name, value: str(value) }));

  const numField = (key: string, id: string, scale: "len" | "pct" | "raw", width = 90) => {
    const cur = numOf(dv(key), 0), shown = scale === "len" ? fmt(toUser(cur)) : scale === "pct" ? String(+(cur * 100).toFixed(2)) : String(cur);
    return textInput(shown, (v) => { const x = parseFloat(v); if (isNaN(x)) return; drawing[key] = scale === "len" ? +fromUser(x).toFixed(4) : scale === "pct" ? +(x / 100).toFixed(4) : x; }, { id, disabled: ro, style: `width:${width}px` });
  };
  const row3 = (host: HTMLElement, label: string, ctl: HTMLElement, unit: string, title?: string) => host.append(h("label", { title }, label), ctl, h("span", { class: "ro" }, unit));
  const flex = (host: HTMLElement, title: string) => { const b = KD().staticBox(host, title); const g = h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 10px;align-items:center" }); b.append(g); return { box: b, grid: g }; };

  KD().open({ title: "Schematic Setup", width: 980, cls: "kd-wide kd-flush", readOnly: ro,
    build(body) {
      KD().treebook(body, [
        { label: "General", pages: [
          { label: "Formatting", build(pg) {
            const cols = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0 20px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
            const text = flex(L, "Text");
            row3(text.grid, "Default text size:", numField("default_text_size", "kd-ss-textsize", "len"), units);
            row3(text.grid, "Overbar offset ratio:", numField("overbar_offset_ratio", "kd-ss-overbar", "pct"), "%");
            row3(text.grid, "Label offset ratio:", numField("text_offset_ratio", "kd-ss-labeloffset", "pct"), "%", "Percentage of the text size to offset labels above (or below) a wire, bus, or pin");
            row3(text.grid, "Global label margin ratio:", numField("label_size_ratio", "kd-ss-glabel", "pct"), "%", "Percentage of the text size to use as space around a global label");
            const sym = flex(L, "Symbols");
            row3(sym.grid, "Default line width:", numField("default_line_thickness", "kd-ss-linewidth", "len"), units);
            row3(sym.grid, "Pin symbol size:", numField("pin_symbol_size", "kd-ss-pinsize", "len"), units);
            sym.box.append(checkbox("Show 'Do not populate' markers", dv("show_dnp_markers") !== false, (on) => { drawing.show_dnp_markers = on; }, { disabled: ro, title: "Draw a cross over symbols marked 'Do not populate'" }));
            const conn = flex(L, "Connections");
            row3(conn.grid, "Junction dot size:", select(JUNCTION_SIZES, JUNCTION_SIZES[numOf(dv("junction_size_choice"), 3)] || "Default", (v) => { drawing.junction_size_choice = JUNCTION_SIZES.indexOf(v); }, { id: "kd-ss-junction", disabled: ro }), "");
            row3(conn.grid, "Hop-over size:", select(HOP_SIZES, HOP_SIZES[numOf(dv("hop_over_size_choice"), 0)] || "None", (v) => { drawing.hop_over_size_choice = HOP_SIZES.indexOf(v); }, { id: "kd-ss-hop", disabled: ro }), "");
            const cg = numOf(sch.connection_grid_size, 50);
            row3(conn.grid, "Connection grid:", textInput(fmt(toUser(cg)), (v) => { const x = parseFloat(v); if (!isNaN(x)) sch.connection_grid_size = +fromUser(x).toFixed(4); }, { id: "kd-ss-conngrid", disabled: ro, style: "width:90px" }), units);
            const isr = KD().staticBox(R, "Inter-sheet References");
            const radio = (label: string, short: boolean) => { const r = h("input", { type: "radio", name: "kd-ss-isr", checked: !!dv("intersheets_ref_short") === short, disabled: ro }); r.addEventListener("change", () => { if ((r as HTMLInputElement).checked) drawing.intersheets_ref_short = short; }); return h("label", { class: "kd-chk", style: "margin-left:18px" }, r, label); };
            isr.append(checkbox("Show inter-sheet references", !!dv("intersheets_ref_show"), (on) => { drawing.intersheets_ref_show = on; }, { disabled: ro, id: "kd-ss-isr-show" }), h("div", { style: "margin-left:18px" }, checkbox("Show own page reference", !!dv("intersheets_ref_own_page"), (on) => { drawing.intersheets_ref_own_page = on; }, { disabled: ro })),
              radio("Standard (1,2,3)", false), radio("Abbreviated (1..3)", true),
              h("div", { class: "kv", style: "margin:6px 0 0 18px;grid-template-columns:max-content 90px" }, h("label", null, "Prefix:"), textInput(str(dv("intersheets_ref_prefix")), (v) => { drawing.intersheets_ref_prefix = v; }, { disabled: ro }), h("label", null, "Suffix:"), textInput(str(dv("intersheets_ref_suffix")), (v) => { drawing.intersheets_ref_suffix = v; }, { disabled: ro })));
            const dash = flex(R, "Dashed Lines");
            row3(dash.grid, "Dash length:", numField("dashed_lines_dash_length_ratio", "kd-ss-dash", "raw"), "");
            row3(dash.grid, "Gap length:", numField("dashed_lines_gap_length_ratio", "kd-ss-gap", "raw"), "");
            dash.box.append(h("p", { class: "kd-note", style: "margin:8px 0 0" }, "Dash and dot lengths are ratios of the line width."));
            const opo = flex(R, "Operating-point Overlay");
            const range = (key: string, list: string[]) => { const cur = str(dv(key)); const shown = cur.startsWith("~") ? "Auto" : cur; return select(list, list.includes(shown) ? shown : "Auto", (v) => { drawing[key] = v === "Auto" ? "~" + list[6] : v; }, { disabled: ro }); };
            row3(opo.grid, "Significant digits (voltages):", numField("operating_point_overlay_v_precision", "kd-ss-vprec", "raw", 60), "");
            row3(opo.grid, "Range (voltages):", range("operating_point_overlay_v_range", V_RANGES), "");
            row3(opo.grid, "Significant digits (currents):", numField("operating_point_overlay_i_precision", "kd-ss-iprec", "raw", 60), "");
            row3(opo.grid, "Range (currents):", range("operating_point_overlay_i_range", I_RANGES), "");
          } },
          { label: "Field Name Templates", build(pg) {
            pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Field Name Templates"));
            KD().grid<FieldTpl>(pg, [{ key: "name", label: "Name", type: "text" }, { key: "visible", label: "Visible", type: "bool", width: 70 }, { key: "url", label: "URL", type: "bool", width: 60 }], templates,
              { readOnly: ro, height: 330, buttons: { add: () => ({ name: "", visible: false, url: false }), move: true, remove: true } });
          } },
          { label: "BOM Presets", build(pg) {
            pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Bill of Materials Presets"));
            KD().grid<NameRow>(pg, [{ key: "name", label: "Name", type: "ro" }], bomPresets, { readOnly: ro, height: 150, buttons: { remove: true } });
            pg.append(h("div", { style: "font-weight:600;margin:14px 0 6px" }, "Bill of Materials Formatting Presets"));
            KD().grid<NameRow>(pg, [{ key: "name", label: "Name", type: "ro" }], bomFmts, { readOnly: ro, height: 150, buttons: { remove: true } });
          } },
        ] },
        { label: "Electrical Rules", pages: [
          { label: "Violation Severity", build(pg) {
            const g = h("div", { id: "kd-ss-severities", style: "display:grid;grid-template-columns:1fr max-content max-content max-content;gap:3px 16px;align-items:center" });
            for (const r of ERC_RULES) {
              if (!r[1]) { g.append(h("div", { style: "grid-column:1/-1;font-weight:600;margin-top:8px" }, r[0])); continue; }
              const code = r[1]; g.append(h("label", null, r[0]));
              const opts: [Severity, string][] = code === "pin_to_pin" ? [["error", "From Pin Conflicts Map"], ["warning", ""], ["ignore", "Ignore"]] : [["error", "Error"], ["warning", "Warning"], ["ignore", "Ignore"]];
              for (const [val, label] of opts) {
                if (!label) { g.append(h("span")); continue; }
                const rb = h("input", { type: "radio", name: "kd-sev-" + code, value: val, checked: sev[code] === val || (code === "pin_to_pin" && val === "error" && sev[code] !== "ignore"), disabled: ro });
                rb.addEventListener("change", () => { if ((rb as HTMLInputElement).checked) sev[code] = val; }); g.append(h("label", { class: "kd-chk", style: "margin:0" }, rb, label));
              }
            }
            pg.append(g);
          } },
          { label: "Pin Conflicts Map", build(pg) {
            const COL = ["var(--wire)", "var(--warn)", "var(--err)"], TIP = ["No error or warning", "Generate warning", "Generate error"], GLYPH = ["", "!", "✕"];
            const g = h("div", { id: "kd-ss-pinmap", style: "display:grid;grid-template-columns:max-content repeat(12, 26px);gap:3px;align-items:center" });
            const paint = (b: HTMLElement, v: number) => { b.style.background = COL[v]; b.textContent = GLYPH[v]; b.title = TIP[v]; };
            for (let i = 0; i < 12; i++) {
              g.append(h("div", { style: "text-align:right;padding-right:8px;white-space:nowrap" }, PIN_TYPE_NAMES[i]));
              for (let j = 0; j < 12; j++) {
                if (j > i) { g.append(j === i + 1 ? h("div", { style: "grid-column:span " + (11 - i) + ";padding-left:6px;white-space:nowrap;color:var(--ink-2);font-size:11px" }, PIN_TYPE_NAMES[i]) : h("span", { style: "display:none" })); continue; }
                const b = h("button", { type: "button", disabled: ro, style: "width:24px;height:22px;border:1px solid var(--line);border-radius:var(--r-2);color:#fff;font-weight:700;font-size:12px;padding:0;cursor:pointer" }); b.dataset.cell = `${i},${j}`; paint(b, pinMap[i][j]);
                b.addEventListener("click", () => { const v = (pinMap[i][j] + 1) % 3; pinMap[i][j] = pinMap[j][i] = v; paint(b, v); }); g.append(b);
              }
            }
            pg.append(g, h("div", { class: "kd-row", style: "margin-top:12px;gap:16px;color:var(--ink-2)" }, ...[0, 1, 2].map((v) => h("span", { class: "kd-row", style: "gap:5px" }, h("span", { style: `display:inline-block;width:14px;height:14px;border-radius:var(--r-1);background:${COL[v]}` }), TIP[v])),
              h("button", { class: "btn sm", type: "button", disabled: ro, style: "margin-left:auto", onclick: () => { for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) pinMap[i][j] = DEFAULT_PIN_MAP[i][j]; g.querySelectorAll<HTMLElement>("button[data-cell]").forEach((b) => { const [i, j] = b.dataset.cell!.split(",").map(Number); paint(b, pinMap[i][j]); }); } }, "Reset to Defaults")));
          } },
        ] },
        { label: "Project", pages: [
          { label: "Net Classes", build(pg) {
            pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Netclasses"));
            KD().grid<NetClassRow>(pg, [{ key: "name", label: "Name", type: "text", ro: (r) => r.name === "Default" && r.src.name === "Default" }, { key: "wire", label: "Wire Thickness", type: "text", width: 120 }, { key: "bus", label: "Bus Thickness", type: "text", width: 120 }, { key: "color", label: "Color", type: "text", width: 170 }, { key: "style", label: "Line Style", type: "choice", options: LINE_STYLES, width: 120 }], classes,
              { readOnly: ro, height: 170, buttons: { add: () => ({ name: "NewClass", wire: classes[0] ? classes[0].wire : "6 mils", bus: classes[0] ? classes[0].bus : "12 mils", color: "rgba(0, 0, 0, 0.000)", style: "Solid", src: Object.assign({}, classes[0] ? classes[0].src : {}, { name: "NewClass", priority: classes.length - 1 }) }), remove: true, canRemove: (r) => { if (r.name === "Default") { toast("The default net class is required."); return false; } return true; } } });
            pg.append(h("p", { class: "kd-note", style: "margin:6px 0 12px" }, "Set color to transparent to use KiCad default color."), h("div", { style: "font-weight:600;margin-bottom:6px" }, "Netclass Assignments"));
            KD().grid<PatternRow>(pg, [{ key: "pattern", label: "Pattern", type: "text" }, { key: "netclass", label: "Net Class", type: "choice", options: () => classes.map((c) => c.name), width: 200 }], patterns,
              { readOnly: ro, height: 150, buttons: { add: () => ({ pattern: "", netclass: classes[0] ? classes[0].name : "Default" }), remove: true } });
          } },
          { label: "Bus Alias Definitions", build(pg) {
            const cols = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:16px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
            const rtitle = h("div", { style: "font-weight:600;margin-bottom:6px" }, "Members of ''"); let mg: GridApi<NameRow> | null = null; const mhost = h("div");
            const show = (a: { name: string; members: NameRow[] } | null) => { rtitle.textContent = `Members of '${a ? a.name : ""}'`; mhost.replaceChildren(); mg = a ? KD().grid<NameRow>(mhost, [{ key: "name", label: "Net or Nested Bus Name", type: "text" }], a.members, { readOnly: ro, height: 280, buttons: { add: () => ({ name: "" }), remove: true } }) : null; void mg; };
            L.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Bus Definitions"));
            const ag = KD().grid<{ name: string; members: NameRow[] }>(L, [{ key: "name", label: "Alias", type: "text" }], aliases, { readOnly: ro, height: 280, onSelect: (r) => show(r), onChange: (r, key) => { if (key === "name" && r) rtitle.textContent = `Members of '${r.name}'`; }, buttons: { add: () => ({ name: "", members: [] }), remove: true } });
            R.append(rtitle, mhost); if (aliases.length) ag.select(0); else show(null);
          } },
          { label: "Text Variables", build(pg) {
            KD().grid<VarRow>(pg, [{ key: "name", label: "Variable Name", type: "text", width: 260 }, { key: "value", label: "Text Substitution", type: "text" }], vars, { readOnly: ro, height: 330, buttons: { add: () => ({ name: "", value: "" }), remove: true } });
          } },
        ] },
      ], { selected: page });
    },
    ok() {
      if (ro) return;
      const bad = vars.find((v) => v.name && !/^[^\s${}:]+$/.test(v.name)); if (bad) { toast(`Text variable name '${bad.name}' may not contain spaces, $, {, } or :`, 4000); return false; }
      saveProject((p) => {
        const s = sub(p, "schematic"), d = sub(p, "schematic", "drawing"), e = sub(p, "erc"), n = sub(p, "net_settings");
        Object.assign(d, drawing); d.field_names = templates.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), url: t.url, visible: t.visible }));
        if (sch.connection_grid_size !== undefined) s.connection_grid_size = sch.connection_grid_size;
        if (Array.isArray(s.bom_presets)) s.bom_presets = (s.bom_presets as JsonObj[]).filter((x) => bomPresets.some((b) => b.name === str(x.name)));
        if (Array.isArray(s.bom_fmt_presets)) s.bom_fmt_presets = (s.bom_fmt_presets as JsonObj[]).filter((x) => bomFmts.some((b) => b.name === str(x.name)));
        const ba: JsonObj = {}; for (const a of aliases) if (a.name.trim()) ba[a.name.trim()] = a.members.map((m) => m.name.trim()).filter(Boolean); s.bus_aliases = ba;
        e.rule_severities = Object.assign({}, obj(e.rule_severities), sev); e.pin_map = pinMap;
        n.classes = classes.filter((c) => c.name.trim()).map((c) => Object.assign({}, c.src, { name: c.name.trim(), wire_width: parseFloat(c.wire) || 6, bus_width: parseFloat(c.bus) || 12, schematic_color: c.color || "rgba(0, 0, 0, 0.000)", line_style: Math.max(0, LINE_STYLES.indexOf(c.style)) }));
        n.netclass_patterns = patterns.filter((x) => x.pattern.trim()).map((x) => ({ netclass: x.netclass, pattern: x.pattern.trim() }));
        const tv: JsonObj = {}; for (const v of vars) if (v.name.trim()) tv[v.name.trim()] = v.value; p.text_variables = tv;
      }, "schematic setup").then(() => toast("Schematic setup saved to the project"), (err: Error) => toast("Could not save the project settings: " + err.message, 5000));
    } });
}
