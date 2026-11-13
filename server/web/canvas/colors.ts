// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// ---------------------------------------------------------------- colours
export function rgba(r: number, g: number, b: number, a?: number): string { return a === undefined || a >= 1 ? "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("") : `rgba(${r},${g},${b},${+a.toFixed(3)})`; }

export function parseColor(c: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(c); if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, 1]; }
  const n = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c); if (n) return [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  return [0, 0, 0, 1];
}

/** KiCad's "dimmed" item colour: desaturate then mix 50/50 with the sheet background. */
export function dimColor(c: string, bg: string): string {
  const [r, g, b, a] = parseColor(c), [br, bgc, bb] = parseColor(bg);
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;   // HSL lightness = desaturated grey
  return rgba(Math.round((l + br) / 2), Math.round((l + bgc) / 2), Math.round((l + bb) / 2), a);
}

/** "KiCad Default" (builtin_color_themes.h s_defaultTheme): the schematic colours of a fresh KiCad, and of every export. */
/** The browser runs on macOS (KiCad's __WXMAC__ colour and pen choices). */
export const IS_MAC_PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const SCH_DEFAULT = Object.freeze({
  bg: "#F5F4EF", grid: "#B5B5B5", gridAxes: "#000084", wire: "#009600", bus: "#000084", junction: "#009600", outline: "#840000",
  body: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", ref: "#006464", value: "#006464",
  field: "#840084", label: "#0F0F0F", glabel: "#840000", hlabel: "#725600", sheet: "#840000", sheetName: "#006464",
  sheetFile: "#725600", sheetFields: "#840084", sheetLabel: "#006464", noconnect: "#000084", notes: "#0000C2",
  busEntry: "#009600", dnp: "rgba(220,9,13,0.85)", netclass: "#484848", ruleArea: "#FF0000", excluded: "rgba(194,194,194,0.95)",
  hidden: "#C2C2C2", privateNotes: "#4848FF", frame: "#840000",
  // LAYER_SCHEMATIC_DRAWINGSHEET ("schematic.worksheet") is `frame`; the page outline is a separate,
  // lighter layer — DS_PAINTER::DrawBorder paints it in LAYER_SCHEMATIC_PAGE_LIMITS, not the sheet ink
  // (common/settings/builtin_color_themes.h:78-79, eeschema/sch_view.cpp:137-138).
  pageLimits: "#B5B5B5",
  brightened: "#FF00FF",   // LAYER_BRIGHTENED: net highlighting / selection disambiguation
  // LAYER_SELECTION_SHADOWS: KiCad Default is (.3, .7, 1.0, .6) on macOS, which "looks better with a lighter
  // shadow", (.4, .7, 1.0, .8) elsewhere (builtin_color_themes.h)
  selection: IS_MAC_PLATFORM ? "rgba(77,179,255,0.6)" : "rgba(102,179,255,0.8)",
});

// ---------------------------------------------------------------- schematic colour themes
// KiCad's two built-in themes (common/settings/builtin_color_themes.h; COLOR4D names resolved through
// common/gal/color4d.cpp, whose table is B, G, R) plus a dark sheet.  A key a theme leaves out keeps KiCad
// Default's colour, as COLOR_SETTINGS falls back to s_defaultTheme.
/** A schematic colour theme: its name, whether the sheet is dark, and the palette keys it overrides. */
export interface SchThemeDef { name: string; dark: boolean; colors: Partial<Record<keyof typeof SCH_DEFAULT, string>> }

export const SCH_THEMES: Record<string, SchThemeDef> & { default: SchThemeDef } = {
  default: { name: "KiCad Default", dark: false, colors: {} },
  classic: { name: "KiCad Classic", dark: false, colors: {
    bg: "#FFFFFF", grid: "#848484", wire: "#008400", bus: "#000084", junction: "#008400", outline: "#840000", body: "#FFFFC2", pin: "#840000",
    pinName: "#008484", pinNum: "#840000", ref: "#008484", value: "#008484", field: "#840084", label: "#000000", glabel: "#840000", hlabel: "#848400",
    sheet: "#840084", sheetName: "#008484", sheetFile: "#848400", sheetFields: "#840084", sheetLabel: "#008484", noconnect: "#000084", notes: "#0000C2",
    busEntry: "#008400", dnp: "rgba(255,0,0,0.85)", netclass: "#000000", ruleArea: "#840000", excluded: "rgba(194,194,194,0.95)", hidden: "#C2C2C2",
    privateNotes: "#0000C2", frame: "#840000", brightened: "#FF00FF",
    selection: IS_MAC_PLATFORM ? "rgba(199,235,255,0.8)" : "rgba(102,179,255,0.8)",   // KiCad Classic's shadow
  } },
  // A dark sheet in the manner of the popular community dark themes: near-black paper, KiCad's hues lifted so
  // every layer keeps at least 4.5:1 against the background, the same layer-to-hue mapping as KiCad Default.
  dark: { name: "Dark", dark: true, colors: {
    bg: "#1C1D20", grid: "#4A4D53", gridAxes: "#6E8EFF", wire: "#4CC864", bus: "#6E8EFF", junction: "#4CC864", outline: "#E46F6F", body: "#2B2A22", pin: "#E46F6F",
    pinName: "#3CC6C6", pinNum: "#F09090", ref: "#3CC6C6", value: "#3CC6C6", field: "#D684D6", label: "#E8E8E8", glabel: "#F2885A", hlabel: "#DDBB4C",
    sheet: "#E46F6F", sheetName: "#3CC6C6", sheetFile: "#DDBB4C", sheetFields: "#D684D6", sheetLabel: "#3CC6C6", noconnect: "#7F9BFF", notes: "#86A6FF",
    busEntry: "#4CC864", dnp: "rgba(255,72,76,0.85)", netclass: "#B4B4B4", ruleArea: "#FF5C5C", excluded: "rgba(120,120,120,0.95)", hidden: "#6C6E73",
    privateNotes: "#A0A0FF", frame: "#C46A6A", pageLimits: "#55585E", brightened: "#FF4DFF",
  } },
};

/** The live palette every painter reads (geometry takes its colours from here when it is built). */
export const SCH: Record<keyof typeof SCH_DEFAULT, string> = Object.assign({}, SCH_DEFAULT);
let schThemeId = "default";

/** The schematic theme the palette holds now. */
export function schTheme(): string { return schThemeId; }

/** The palette of a theme (KiCad Default for an unknown id). */
export function schThemeColors(id: string): Record<keyof typeof SCH_DEFAULT, string> { const t = SCH_THEMES[id] || SCH_THEMES.default; return Object.assign({}, SCH_DEFAULT, t.colors); }

/**
 * Switch the live palette.  Geometry built under another theme is rebuilt lazily by the painters (geom.ts
 * ensureSchTheme), so a switch costs nothing until the next paint.  Returns whether anything changed.
 */
export function setSchTheme(id: string): boolean {
  if (!SCH_THEMES[id]) id = "default";
  if (id === schThemeId) return false;
  Object.assign(SCH, schThemeColors(id)); schThemeId = id;
  return true;
}

/** Run fn with the palette switched to theme `id` (an export in KiCad Default while the screen shows another). */
export function withSchTheme<T>(id: string, fn: () => T): T {
  const was = schThemeId; setSchTheme(id);
  try { return fn(); } finally { setSchTheme(was); }
}

// draw order (eeschema SCH_VIEW layer order, bottom first)
export const SCH_Z: Record<string, number> = { bitmap: -7, sheetBg: -6, sheetFields: -5, sheet: -4, notesBg: -3, deviceBg: -2, notes: -1, device: 0, pinName: 1, pinNum: 2, pin: 3,
  wire: 4, bus: 5, junction: 6, noconnect: 7, loclabel: 8, globlabel: 9, hierlabel: 10, ruleArea: 11, netclass: 12, fields: 13, value: 14, ref: 15, marker: 16 };

// [layer name, palette key]: the colour is read from the live palette, so it follows the theme
export const SCH_LAYERS: [string, keyof typeof SCH_DEFAULT][] = [
  ["Wires", "wire"], ["Buses", "bus"], ["Junctions", "junction"], ["Symbols", "outline"], ["Pins", "pin"],
  ["Pin names", "pinName"], ["Pin numbers", "pinNum"], ["Reference & value", "ref"], ["Fields", "field"],
  ["Labels", "label"], ["Sheets", "sheet"], ["Notes", "notes"], ["No-connects", "noconnect"], ["Rule areas", "ruleArea"],
  ["Images", "hidden"],
];

export const PCB_COLORS: Record<string, string> = {
  "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "In1.Cu": "#7FC87F", "In2.Cu": "#CE7D2C", "In3.Cu": "#4FCBCB", "In4.Cu": "#DB628B",
  "In5.Cu": "#A7A5C6", "In6.Cu": "#28CCD9", "In7.Cu": "#E8B2A7", "In8.Cu": "#F2EDA1", "In9.Cu": "#8DCB81", "In10.Cu": "#ED7C33",
  "In11.Cu": "#5BC3EB", "In12.Cu": "#F76F8E", "In13.Cu": "#A7A5C6", "In14.Cu": "#28CCD9", "In15.Cu": "#E8B2A7", "In16.Cu": "#F2EDA1",
  "In17.Cu": "#ED7C33", "In18.Cu": "#5BC3EB", "In19.Cu": "#F76F8E", "In20.Cu": "#A7A5C6", "In21.Cu": "#28CCD9", "In22.Cu": "#E8B2A7",
  "In23.Cu": "#F2EDA1", "In24.Cu": "#ED7C33", "In25.Cu": "#5BC3EB", "In26.Cu": "#F76F8E", "In27.Cu": "#A7A5C6", "In28.Cu": "#28CCD9",
  "In29.Cu": "#E8B2A7", "In30.Cu": "#F2EDA1",
  "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Mask": "rgba(216,100,255,0.4)", "B.Mask": "rgba(2,255,238,0.4)",
  "F.Paste": "rgba(180,160,154,0.9)", "B.Paste": "rgba(0,194,194,0.9)", "F.Adhes": "#840084", "B.Adhes": "#000084",
  "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2", "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF", "F.Fab": "#AFAFAF", "B.Fab": "#585D84",
  "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC", "Eco1.User": "#B4DBD2", "Eco2.User": "#D8C852",
};

export const USER_COLORS = ["#C2C2C2", "#5994DC", "#B4DBD2", "#D8C852"];
   // User.1.. cycle (User.9 = B.SilkS colour in the theme)
export const PCB_BG = "#001023", PCB_GRID = "#848484", PCB_GRID_AXES = "#C2C2C2", VIA_HOLE = "#E3B72E", HOLE_WALL = "#ECECEC", NPTH = "#1AC4D2",
  // pad labels: PCB_RENDER_SETTINGS::LoadColors overwrites LAYER_PAD_NETNAMES with NETNAMES_LAYER_ID_START (white @ 0.7), inverted on bright copper
  PAD_TEXT = "rgba(255,255,255,0.7)", PAD_TEXT_DARK = "rgba(0,0,0,0.7)";

// The board's drawing sheet and page outline: LAYER_DRAWINGSHEET / LAYER_PAGE_LIMITS
// (builtin_color_themes.h:178-179).  pcbnew draws the same sheet as eeschema, in these colours.
export const PCB_SHEET = "#C872AB", PCB_PAGE_LIMITS = "#848484";

export const PCB_HIDDEN_DEFAULT = new Set(["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Margin", "Eco1.User", "Eco2.User"]);

export function pcbColor(layer: string): string {
  if (PCB_COLORS[layer]) return PCB_COLORS[layer];
  const u = /^User\.(\d+)$/.exec(layer); if (u) return +u[1] === 9 ? "#E8B2A7" : USER_COLORS[(+u[1] - 1) % 4];
  if (/\.Cu$/.test(layer)) return "#7FC87F"; return "#C2C2C2";
}

// pcbnew GAL_LAYER_ORDER, bottom first; copper groups carry fill/track/pad/via sub-orders
export const PCB_ORDER = ["B.Fab", "B.CrtYd", "B.Adhes", "B.Paste", "B.SilkS", "B.Mask", "B.Cu"];

for (let i = 30; i >= 1; i--) PCB_ORDER.push("In" + i + ".Cu");

PCB_ORDER.push("F.Fab", "F.CrtYd", "F.Adhes", "F.Paste", "F.SilkS", "F.Mask", "F.Cu", "holes");

for (let i = 45; i >= 1; i--) PCB_ORDER.push("User." + i);

PCB_ORDER.push("Margin", "Edge.Cuts", "Eco2.User", "Eco1.User", "Cmts.User", "Dwgs.User");

export const PCB_ZMAP = new Map(PCB_ORDER.map((l, i) => [l, i * 10]));

export function pcbZ(layer: string): number { const z = PCB_ZMAP.get(layer); return z === undefined ? 5 : z; }

export const Z_PAD = 2, Z_VIA = 1, Z_TEXT = 4, Z_ZONE = -1, Z_BITMAP = -20;
   // BITMAP_LAYER_FOR(…) sits below every board layer
export function padLayers(doc: Pick<KDoc, "copper">, names: Iterable<string>): string[] {
  // expand *.Cu / F&B.Cu etc. against the board's copper layers (front→back order)
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const out: string[] = [];
  for (const n of names) {
    if (n === "*.Cu") out.push(...copper);
    else if (n === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (n.startsWith("*.")) out.push("F" + n.slice(1), "B" + n.slice(1));
    else out.push(n);
  }
  return out.filter((l, i) => out.indexOf(l) === i);
}
