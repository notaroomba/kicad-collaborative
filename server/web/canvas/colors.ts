// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
// ---------------------------------------------------------------- colours
export function rgba(r, g, b, a) { return a === undefined || a >= 1 ? "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("") : `rgba(${r},${g},${b},${+a.toFixed(3)})`; }

export function parseColor(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(c); if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, 1]; }
  const n = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c); if (n) return [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  return [0, 0, 0, 1];
}

/** KiCad's "dimmed" item colour: desaturate then mix 50/50 with the sheet background. */
export function dimColor(c, bg) {
  const [r, g, b, a] = parseColor(c), [br, bgc, bb] = parseColor(bg);
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;   // HSL lightness = desaturated grey
  return rgba(Math.round((l + br) / 2), Math.round((l + bgc) / 2), Math.round((l + bb) / 2), a);
}

export const SCH = {
  bg: "#F5F4EF", grid: "#B5B5B5", wire: "#009600", bus: "#000084", junction: "#009600", outline: "#840000",
  body: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", ref: "#006464", value: "#006464",
  field: "#840084", label: "#0F0F0F", glabel: "#840000", hlabel: "#725600", sheet: "#840000", sheetName: "#006464",
  sheetFile: "#725600", sheetFields: "#840084", sheetLabel: "#006464", noconnect: "#000084", notes: "#0000C2",
  busEntry: "#009600", dnp: "rgba(220,9,13,0.85)", netclass: "#484848", ruleArea: "#FF0000", excluded: "rgba(194,194,194,0.95)",
  hidden: "#C2C2C2", privateNotes: "#4848FF", frame: "#840000",
  brightened: "#FF00FF",   // LAYER_BRIGHTENED: net highlighting / selection disambiguation
};

// draw order (eeschema SCH_VIEW layer order, bottom first)
export const SCH_Z = { bitmap: -7, sheetBg: -6, sheetFields: -5, sheet: -4, notesBg: -3, deviceBg: -2, notes: -1, device: 0, pinName: 1, pinNum: 2, pin: 3,
  wire: 4, bus: 5, junction: 6, noconnect: 7, loclabel: 8, globlabel: 9, hierlabel: 10, ruleArea: 11, netclass: 12, fields: 13, value: 14, ref: 15, marker: 16 };

export const SCH_LAYERS = [
  ["Wires", SCH.wire], ["Buses", SCH.bus], ["Junctions", SCH.junction], ["Symbols", SCH.outline], ["Pins", SCH.pin],
  ["Pin names", SCH.pinName], ["Pin numbers", SCH.pinNum], ["Reference & value", SCH.ref], ["Fields", SCH.field],
  ["Labels", SCH.label], ["Sheets", SCH.sheet], ["Notes", SCH.notes], ["No-connects", SCH.noconnect], ["Rule areas", SCH.ruleArea],
  ["Images", SCH.hidden],
];

export const PCB_COLORS = {
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
export const PCB_BG = "#001023", PCB_GRID = "#848484", VIA_HOLE = "#E3B72E", HOLE_WALL = "#ECECEC", NPTH = "#1AC4D2", PAD_TEXT = "rgba(255,255,255,0.9)";

export const PCB_HIDDEN_DEFAULT = new Set(["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Margin", "Eco1.User", "Eco2.User"]);

export function pcbColor(layer) {
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

export function pcbZ(layer) { const z = PCB_ZMAP.get(layer); return z === undefined ? 5 : z; }

export const Z_PAD = 2, Z_VIA = 3, Z_TEXT = 4, Z_ZONE = -1, Z_BITMAP = -20;
   // BITMAP_LAYER_FOR(…) sits below every board layer
export function padLayers(doc, names) {
  // expand *.Cu / F&B.Cu etc. against the board's copper layers (front→back order)
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const out = [];
  for (const n of names) {
    if (n === "*.Cu") out.push(...copper);
    else if (n === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (n.startsWith("*.")) out.push("F" + n.slice(1), "B" + n.slice(1));
    else out.push(n);
  }
  return out.filter((l, i) => out.indexOf(l) === i);
}
