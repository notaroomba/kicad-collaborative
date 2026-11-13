// panels/propgrid.ts — KiCad's Properties panel (PROPERTIES_PANEL over PROPERTY_MANAGER): the property grid of
// the selection, with the category and property names the C++ registers (eeschema/sch_symbol.cpp, sch_line.cpp,
// sch_label.cpp, …; pcbnew/footprint.cpp, pcb_track.cpp, pad.cpp, zone.cpp, pcb_shape.cpp, pcb_text.cpp,
// pcb_dimension.cpp; common/eda_shape.cpp, eda_text.cpp).  A property is a getter over an item's s-expression
// node and a setter that edits a clone of it; committing a value replaces every selected item that has the
// property in ONE op (the same whole-item replace change props.js commits), so it syncs and undoes as a unit.
// Multi-selection shows the properties the items share; values that differ show as mixed.
import type { PropGrid, PropGroup, PropRow, PropType } from "../../panels-api";
import { E } from "../state";
import { fromDisplayAbsAxis, toDisplayAbsAxis } from "../userorigin";
import { setNet } from "../pcbdialogs/item-props";
import { layerDisplayName, netClassOf } from "./appearance";
import { KC, isSchDoc, kdoc, panelStore, pcbTools, tctx } from "./core";
import { commitWithOtherUnits } from "../../dialogs/sync-units";

type Raw = string | number | boolean | null;
interface PropDef {
  group: string; name: string; type: PropType;
  get(it: KItem): Raw;
  /** edit a CLONE of the item's node; false = nothing to change */
  set?(node: SNode, v: Raw, it: KItem): boolean | void;
  /** a view-only control (the pad picker): runs instead of a commit */
  local?(v: Raw, it: KItem): void;
  choices?: [string, string][];
  /** PROPERTY_BASE::Available: the row is shown only when every selected item has it */
  avail?(it: KItem): boolean;
  /** PROPERTY_BASE::Writeable: the row is greyed out when one selected item cannot take it */
  canWrite?(it: KItem): boolean;
  /** a tuning pattern's property that lives on its member tracks: edit each member's (cloned) node */
  member?(node: SNode, v: Raw): boolean | void;
  /** a name the user may rename in the grid's label column (PCB_PROPERTIES_PANEL::isKeyEditable) */
  key?: "field" | "custom";
  /** PROPERTY<…, std::optional<T>>: an empty cell is "no value" (the setter gets null), and 0 is a value */
  optional?: boolean;
}

/** props.js's node editors (static/props.js `helpers`). */
interface Helpers {
  evalExpr(text: string, unit: string): number; formatLength(mm: number, unit: string): string;
  kid(n: SNode, k: string): SNode | null; kids(n: SNode, k: string): SNode[]; num(v: unknown, d?: number): number; str(v: unknown): string;
  setKid(n: SNode, k: string, values: (string | number | SNode)[], before?: string[]): SNode; delKid(n: SNode, k: string): void;
  yes(n: SNode, k: string, def: boolean): boolean; setYesNo(n: SNode, k: string, on: boolean): void;
  fieldList(n: SNode): SNode[]; setField(n: SNode, name: string, v: string): SNode;
  mirrorOf(n: SNode): string; setSymbolTransform(n: SNode, rot: number, mirror: string): void; setSymbolPosition(n: SNode, x: number, y: number): void;
  setSymbolUnit(n: SNode, u: number): void; setSymbolFlag(n: SNode, key: string, on: boolean): void; libUnitCount(doc: KDoc, n: SNode): number;
  setFootprintPosition(n: SNode, x: number, y: number): void; setFootprintRotation(n: SNode, deg: number): boolean; setFootprintSide(n: SNode, side: string): boolean;
  footprintAttrs(n: SNode): Record<string, unknown>; setFootprintAttrs(n: SNode, patch: Record<string, unknown>): void;
  netNameOf(doc: KDoc, n: SNode): string; boardNetNames(doc: KDoc): string[]; boardLayers(doc: KDoc, copperOnly: boolean): string[];
  padNode(n: SNode, i: number): SNode | null; padInfo(doc: KDoc, pad: SNode): { number: string; type: string; shape: string; w: number; h: number; rot: number; drill: string; net: string; maskMargin: number | null; pasteMargin: number | null; rratio: number | null };
  setPad(n: SNode, i: number, patch: Record<string, unknown>, doc: KDoc): boolean;
  strokeWidth(n: SNode): number; setStrokeWidth(n: SNode, w: number): void; setWidth(n: SNode, w: number): void; setLayer(n: SNode, l: string): void;
  setText(n: SNode, t: string): void; textSize(n: SNode): number; setTextSize(n: SNode, s: number): void; setShape(n: SNode, s: string): void; setDiameter(n: SNode, d: number): void;
  setViaSize(n: SNode, s: number): void; setViaDrill(n: SNode, d: number): void; setViaLayers(n: SNode, a: string, b: string): void;
  setZoneName(n: SNode, name: string): void; setZonePriority(n: SNode, p: number): void; normDeg(a: number): number; deg360(a: number): number;
}
const H = (): Helpers => (window.CollabTools.props as unknown as { helpers: Helpers }).helpers;
const K = KC;
const r6 = (v: number) => +(+v).toFixed(6);

// ---------------------------------------------------------------- selection
/** Every selected item: the app's selection, the tool module's own picks, else the item of a selected field. */
export function selectedItems(): KItem[] {
  const doc = kdoc(); if (!doc) return [];
  const ids = new Set<string>(E.selection as Set<string>);
  if (E.selected && E.selected.id) ids.add(E.selected.id as string);
  if (isSchDoc()) { const s = window.CollabTools.sch ? window.CollabTools.sch.state.sel : null; if (typeof s === "string" && s) ids.add(s); }
  else { const P = pcbTools(); if (P) for (const id of P.state.sel) ids.add(id); }
  if (!ids.size && E.selField && E.selField.id) ids.add(E.selField.id as string);
  const out: KItem[] = [];
  for (const id of ids) { const it = doc.items.get(id); if (it) out.push(it); }
  return out;
}
export function selectionSignature(): string { return selectedItems().map((it) => it.id).sort().join(",") + selectedPads().map((p) => "|pad:" + p.key).join("") + E.selPins.map((p: { id: string; number: string }) => "|pin:" + p.id + ":" + p.number).join("") + "|" + String(E.units) + "|" + (E.viewOnly ? 1 : 0); }

// ---------------------------------------------------------------- shared property builders
const BASIC = "Basic Properties";
const ORIENT4: [string, string][] = [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]];
const LINE_STYLES: [string, string][] = [["default", "Default"], ["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
const H_JUST: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
const V_JUST: [string, string][] = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];

function xyProp(group: string, name: string, key: string, index: 1 | 2, type: PropType = "coord"): PropDef {
  return { group, name, type, get: (it) => { const k = H().kid(it.node, key); return k ? H().num(k[index]) : null; },
    set: (n, v) => { const k = H().kid(n, key); if (!k) return false; k[index] = r6(v as number); } };
}
function atProp(name: string, index: 1 | 2): PropDef {
  return { group: BASIC, name, type: "coord", get: (it) => K().atOf(it.node)[index - 1],
    set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, index === 1 ? r6(v as number) : x, index === 2 ? r6(v as number) : y); } };
}
function strokeOf(n: SNode): SNode | null { return H().kid(n, "stroke"); }
function strokeProps(group: string, styleName: string, withColor: boolean): PropDef[] {
  const out: PropDef[] = [
    { group, name: styleName, type: "enum", choices: LINE_STYLES, get: (it) => { const s = strokeOf(it.node), t = s && H().kid(s, "type"); return t ? H().str(t[1]) : "default"; },
      set: (n, v) => { let s = strokeOf(n); if (!s) s = H().setKid(n, "stroke", [["width", 0]], ["fill", "uuid", "tstamp"]); H().setKid(s, "type", [String(v)], ["color"]); } },
    { group, name: "Line Width", type: "length", get: (it) => H().strokeWidth(it.node), set: (n, v) => { H().setStrokeWidth(n, Math.max(0, v as number)); } },
  ];
  if (withColor) out.push({ group, name: "Color", type: "color",
    get: (it) => { const s = strokeOf(it.node), c = s && H().kid(s, "color"); if (!c || (!H().num(c[4]) && !H().num(c[1]) && !H().num(c[2]) && !H().num(c[3]))) return ""; return "#" + [1, 2, 3].map((i) => Math.round(H().num(c[i])).toString(16).padStart(2, "0")).join(""); },
    set: (n, v) => { let s = strokeOf(n); if (!s) s = H().setKid(n, "stroke", [["width", 0], ["type", "default"]], ["fill", "uuid", "tstamp"]); const m = /^#([0-9a-f]{6})$/i.exec(String(v || "")); const x = m ? parseInt(m[1], 16) : 0; H().setKid(s, "color", m ? [x >> 16, (x >> 8) & 255, x & 255, 1] : [0, 0, 0, 0]); } });
  return out;
}
function fontOf(n: SNode, create: boolean): SNode | null {
  let e = H().kid(n, "effects"); if (!e) { if (!create) return null; e = H().setKid(n, "effects", [], ["uuid", "tstamp"]); }
  let f = H().kid(e, "font"); if (!f) { if (!create) return null; f = H().setKid(e, "font", [["size", 1.27, 1.27]], ["justify", "hide", "href"]); }
  return f;
}
function fontFlag(group: string, name: string, key: string): PropDef {
  return { group, name, type: "bool", get: (it) => { const f = fontOf(it.node, false); return !!f && (H().yes(f, key, false)); },
    set: (n, v) => { const f = fontOf(n, true)!; const i = f.indexOf(key); if (i > 0) f.splice(i, 1); H().delKid(f, key); if (v) H().setKid(f, key, ["yes"], key === "bold" ? ["italic", "color", "line_spacing"] : ["color", "line_spacing"]); } };
}
function justifyOf(n: SNode): { h: string; v: string; mirror: boolean } {
  const e = H().kid(n, "effects"), j = e && H().kid(e, "justify"); const toks = j ? j.slice(1).map((x) => H().str(x)) : [];
  return { h: toks.includes("left") ? "left" : toks.includes("right") ? "right" : "center", v: toks.includes("top") ? "top" : toks.includes("bottom") ? "bottom" : "center", mirror: toks.includes("mirror") };
}
function setJustify(n: SNode, patch: Partial<{ h: string; v: string; mirror: boolean }>): void {
  const cur = Object.assign(justifyOf(n), patch);
  let e = H().kid(n, "effects"); if (!e) e = H().setKid(n, "effects", [["font", ["size", 1.27, 1.27]]], ["uuid", "tstamp"]);
  const toks: string[] = []; if (cur.h !== "center") toks.push(cur.h); if (cur.v !== "center") toks.push(cur.v); if (cur.mirror) toks.push("mirror");
  if (toks.length) H().setKid(e, "justify", toks, ["hide", "href"]); else H().delKid(e, "justify");
}
function justifyProps(group: string): PropDef[] {
  return [
    { group, name: "Horizontal Justification", type: "enum", choices: H_JUST, get: (it) => justifyOf(it.node).h, set: (n, v) => setJustify(n, { h: String(v) }) },
    { group, name: "Vertical Justification", type: "enum", choices: V_JUST, get: (it) => justifyOf(it.node).v, set: (n, v) => setJustify(n, { v: String(v) }) },
  ];
}
function fieldProps(it: KItem): PropDef[] {
  return H().fieldList(it.node).map((p): PropDef => {
    const name = H().str(p[1]);
    return { group: "Fields", name, type: "text", get: (x) => { const f = H().fieldList(x.node).find((q) => H().str(q[1]) === name); return f ? H().str(f[2]) : null; }, set: (n, v) => { H().setField(n, name, String(v)); } };
  });
}
const flag = (group: string, name: string, key: string, def: boolean, invert: boolean): PropDef => ({ group, name, type: "bool",
  get: (it) => { const on = H().yes(it.node, key, def); return invert ? !on : on; }, set: (n, v) => { H().setSymbolFlag(n, key, invert ? !v : !!v); } });

// ---------------------------------------------------------------- schematic items
function symbolProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H();
  const mirrorSet = (axis: "x" | "y") => (n: SNode, v: Raw) => {
    const rot = K().atOf(n)[2], m = h.mirrorOf(n), on = !!v, has = m === axis;
    if (on === has) return false;
    if (!on) h.setSymbolTransform(n, rot, "");
    else if (!m) h.setSymbolTransform(n, rot, axis);
    else h.setSymbolTransform(n, (rot + 180) % 360, "");     // mirrored about both axes is a half turn
  };
  const out: PropDef[] = [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => K().atOf(x.node)[0], set: (n, v) => { h.setSymbolPosition(n, v as number, K().atOf(n)[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => K().atOf(x.node)[1], set: (n, v) => { h.setSymbolPosition(n, K().atOf(n)[0], v as number); } },
    { group: BASIC, name: "Orientation", type: "enum", choices: ORIENT4, get: (x) => String(h.deg360(K().atOf(x.node)[2])), set: (n, v) => { h.setSymbolTransform(n, +(v as string), h.mirrorOf(n)); } },
    { group: BASIC, name: "Mirror X", type: "bool", get: (x) => h.mirrorOf(x.node) === "x", set: mirrorSet("x") },
    { group: BASIC, name: "Mirror Y", type: "bool", get: (x) => h.mirrorOf(x.node) === "y", set: mirrorSet("y") },
  ];
  const units = h.libUnitCount(doc, it.node);
  const unitChoices: [string, string][] = []; for (let u = 1; u <= Math.max(1, units); u++) unitChoices.push([String(u), u <= 26 ? String.fromCharCode(64 + u) : String(u)]);
  out.push({ group: BASIC, name: "Unit", type: "enum", choices: unitChoices, get: (x) => { const k = h.kid(x.node, "unit"); return String(k ? h.num(k[1], 1) : 1); }, set: (n, v) => { h.setSymbolUnit(n, +(v as string)); } });
  out.push(...fieldProps(it).map((d) => (SYM_MANDATORY.includes(d.name) ? d : Object.assign(d, { key: "field" as const }))));
  out.push({ group: "Fields", name: "Library Link", type: "text", get: (x) => h.str((h.kid(x.node, "lib_id") || [])[1]) });
  out.push(flag("Attributes", "Exclude From Simulation", "exclude_from_sim", false, false), flag("Attributes", "Exclude From Bill of Materials", "in_bom", true, true),
    flag("Attributes", "Exclude From Board", "on_board", true, true), flag("Attributes", "Exclude From Position Files", "in_pos_files", true, true), flag("Attributes", "Do not Populate", "dnp", false, false));
  return out;
}
function schLineProps(it: KItem): PropDef[] {
  const pt = (name: string, end: boolean, i: 0 | 1): PropDef => ({ group: BASIC, name, type: "coord",
    get: (x) => { const p = K().ptsOf(x.node); const q = end ? p[p.length - 1] : p[0]; return q ? q[i] : null; },
    set: (n, v) => { const p = K().ptsOf(n).map((q) => q.slice() as [number, number]); const q = end ? p[p.length - 1] : p[0]; if (!q) return false; q[i] = r6(v as number); K().setPts(n, p); } });
  return [pt("Start X", false, 0), pt("Start Y", false, 1), pt("End X", true, 0), pt("End Y", true, 1),
    { group: BASIC, name: "Length", type: "length", get: (x) => { const p = K().ptsOf(x.node); let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; } },
    ...strokeProps(BASIC, it.kind === "polyline" ? "Line Style" : "Wire Style", true)];
}
const LABEL_SHAPES: [string, string][] = [["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"]];
function schTextProps(it: KItem): PropDef[] {
  const h = H(), k = it.kind, T = "Text Properties";
  const out: PropDef[] = [atProp("Position X", 1), atProp("Position Y", 2)];
  if (k === "global_label" || k === "hierarchical_label") out.push({ group: BASIC, name: "Shape", type: "enum", choices: LABEL_SHAPES, get: (x) => h.str((h.kid(x.node, "shape") || [])[1] || "input"), set: (n, v) => { h.setShape(n, String(v)); } });
  out.push({ group: BASIC, name: "Text", type: k === "text" || k === "text_box" ? "longtext" : "text", get: (x) => h.str(x.node[1]), set: (n, v) => { h.setText(n, String(v)); } });
  out.push({ group: BASIC, name: "Orientation", type: "enum", choices: ORIENT4, get: (x) => String(h.deg360(K().atOf(x.node)[2])), set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, x, y, +(v as string)); } });
  out.push({ group: T, name: "Text Size", type: "length", get: (x) => h.textSize(x.node), set: (n, v) => { if (!((v as number) > 0)) return false; h.setTextSize(n, v as number); } });
  out.push(fontFlag(T, "Bold", "bold"), fontFlag(T, "Italic", "italic"));
  if (k === "text") out.push(...justifyProps(T));
  return out;
}
function schShapeProps(it: KItem): PropDef[] {
  const S = "Shape Properties", out: PropDef[] = [];
  if (it.kind === "rectangle") out.push(xyProp(S, "Start X", "start", 1), xyProp(S, "Start Y", "start", 2), xyProp(S, "End X", "end", 1), xyProp(S, "End Y", "end", 2));
  if (it.kind === "circle") out.push(xyProp(S, "Center X", "center", 1), xyProp(S, "Center Y", "center", 2), xyProp(S, "Radius", "radius", 1, "length"));
  out.push(...strokeProps(S, "Line Style", true));
  return out;
}
function schProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H();
  switch (it.kind) {
    case "symbol": return symbolProps(it, doc);
    case "wire": case "bus": case "polyline": return schLineProps(it);
    case "label": case "global_label": case "hierarchical_label": case "netclass_flag": case "directive_label": case "text": case "text_box": return schTextProps(it);
    case "junction": return [atProp("Position X", 1), atProp("Position Y", 2),
      { group: BASIC, name: "Diameter", type: "length", get: (x) => h.num((h.kid(x.node, "diameter") || [])[1], 0), set: (n, v) => { h.setDiameter(n, Math.max(0, v as number)); } }];
    case "no_connect": return [atProp("Position X", 1), atProp("Position Y", 2)];
    case "bus_entry": return [atProp("Position X", 1), atProp("Position Y", 2), ...strokeProps(BASIC, "Wire Style", true)];
    case "sheet": {
      const fld = (name: string, label: string, ro: boolean): PropDef => ({ group: "Fields", name: label, type: "text", get: (x) => { const p = h.kids(x.node, "property").find((q) => h.str(q[1]) === name); return p ? h.str(p[2]) : null; }, set: ro ? undefined : (n, v) => { h.setField(n, name, String(v)); } });
      const user = h.kids(it.node, "property").map((p) => h.str(p[1])).filter((nm) => !SHEET_MANDATORY.includes(nm))
        .map((nm): PropDef => Object.assign(fld(nm, nm, false), { key: "field" as const }));
      return [atProp("Position X", 1), atProp("Position Y", 2), fld("Sheetname", "Sheet Name", false), fld("Sheetfile", "Sheet File", true), ...user,
        { group: BASIC, name: "Border Width", type: "length", get: (x) => h.strokeWidth(x.node), set: (n, v) => { h.setStrokeWidth(n, Math.max(0, v as number)); } },
        flag("Attributes", "Exclude From Simulation", "exclude_from_sim", false, false), flag("Attributes", "Exclude From Bill of Materials", "in_bom", true, true),
        flag("Attributes", "Exclude From Board", "on_board", true, true), flag("Attributes", "Do not Populate", "dnp", false, false)];
    }
    case "rectangle": case "circle": case "arc": case "bezier": case "rule_area": return schShapeProps(it);
    default: {
      const out: PropDef[] = [];
      if (h.kid(it.node, "at")) out.push(atProp("Position X", 1), atProp("Position Y", 2));
      if (h.kid(it.node, "stroke")) out.push(...strokeProps(BASIC, "Line Style", false));
      return out;
    }
  }
}

// ---------------------------------------------------------------- board items
function layerChoices(doc: KDoc, copperOnly: boolean): [string, string][] { return H().boardLayers(doc, copperOnly).map((l) => [l, layerDisplayName(doc, l)]); }
function lockedProp(): PropDef {
  return { group: BASIC, name: "Locked", type: "bool", get: (it) => { const P = pcbTools(); return P ? P.isLocked(it.node) : false; },
    set: (n, v) => { const P = pcbTools(); if (!P || P.isLocked(n) === !!v) return false; P.setLocked(n, !!v); } };
}
function layerProp(doc: KDoc, copperOnly: boolean, def: string): PropDef {
  return { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, copperOnly), get: (it) => H().str((H().kid(it.node, "layer") || [])[1] || def), set: (n, v) => { H().setLayer(n, String(v)); } };
}
function netProps(doc: KDoc): PropDef[] {
  // BOARD_CONNECTED_ITEM's "Net" is a net selector: the board's nets, <no net> first
  const nets: [string, string][] = [["", "<no net>"], ...H().boardNetNames(doc).filter(Boolean).map((n): [string, string] => [n, n])];
  return [{ group: "Net", name: "Net", type: "enum", choices: nets, get: (it) => H().netNameOf(doc, it.node) || "",
    set: (n, v) => { if (H().netNameOf(doc, n) === String(v || "")) return false; setNet(doc, n, String(v || "")); } },
    { group: "Net", name: "Net Class", type: "text", get: (it) => { const n = H().netNameOf(doc, it.node); return n ? netClassOf(n) : "Default"; } }];
}
const FP_TYPES: [string, string][] = [["through_hole", "Through hole"], ["smd", "SMD"], ["", "Unspecified"]];
const PAD_TYPES: [string, string][] = [["thru_hole", "Through-hole"], ["smd", "SMD"], ["connect", "Edge connector"], ["np_thru_hole", "NPTH, mechanical"]];
const PAD_DRILL_SHAPES: [string, string][] = [["circle", "Round"], ["oval", "Oblong"]];
const PAD_SIM_TYPES: [string, string][] = [["", "None"], ["source", "Source"], ["sink", "Sink"]];
const PAD_FAB_PROPS: [string, string][] = [["", "None"], ["pad_prop_bga", "BGA pad"], ["pad_prop_fiducial_glob", "Fiducial, global to board"], ["pad_prop_fiducial_loc", "Fiducial, local to footprint"], ["pad_prop_testpoint", "Test point pad"], ["pad_prop_heatsink", "Heatsink pad"], ["pad_prop_castellated", "Castellated pad"], ["pad_prop_mechanical", "Mechanical pad"], ["pad_prop_pressfit", "Press-fit pad"]];
const PAD_ZONE_CONNECT: [string, string][] = [["", "Inherited"], ["0", "None"], ["1", "Thermal reliefs"], ["2", "Solid"], ["3", "Thermal reliefs for PTH"]];
const PAD_SHAPES: [string, string][] = [["circle", "Circle"], ["rect", "Rectangle"], ["oval", "Oval"], ["trapezoid", "Trapezoid"], ["roundrect", "Rounded rectangle"], ["custom", "Custom"]];
const PIN_TYPES: [string, string][] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"].map((t): [string, string] => [t, t]);   // GetCanonicalElectricalTypeName
const PAD_UNCONNECTED: [string, string][] = [["keep_all", "All copper layers"], ["remove_all", "Connected layers only"], ["remove_except_start_end", "Front, back and connected layers"], ["start_end_only", "Start and end layers only"]];
const PAD_POST_MACHINING: [string, string][] = [["none", "Not post-machined"], ["counterbore", "Counterbore"], ["countersink", "Countersink"]];
const PAD_BACKDRILL: [string, string][] = [["none", "No backdrill"], ["bottom", "Backdrill bottom"], ["top", "Backdrill top"], ["both", "Backdrill both"]];
const PM = "Post-machining Properties", BD = "Backdrill Properties";
const padIndexOf = new Map<string, number>();   // footprint id -> the pad the Pad Properties rows show

/** FIELD_T's mandatory footprint fields (PCB_FIELD::IsMandatory): never renamed or removed from the panel. */
const FP_MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
/** SCH_FIELD::IsMandatory of a symbol (the same five FIELD_Ts) and of a sheet (SHEET_NAME, SHEET_FILENAME). */
const SYM_MANDATORY = FP_MANDATORY, SHEET_MANDATORY = ["Sheetname", "Sheetfile"];
/** The fields of a footprint / symbol / sheet node the panel may rename or remove (isKeyEditable), or null for an item without them. */
function mandatoryOf(n: SNode): string[] | null { return n[0] === "footprint" ? FP_MANDATORY : n[0] === "symbol" ? SYM_MANDATORY : n[0] === "sheet" ? SHEET_MANDATORY : null; }
/** A field written (property private "Name" …) (PCB_FIELD::IsPrivate). */
function privateField(n: SNode, name: string): boolean { const h = H(); return h.kids(n, "property").some((p) => p[1] === "private" && h.str(p[2]) === name); }

// ---------------------------------------------------------------- custom properties (EDA_ITEM::m_customProperties)
// (custom_property "key" "value") children, last in the item (KICAD_FORMAT::FormatCustomProperties), in key order
// (std::map); EDA_CUSTOM_PROPERTY puts each in the "Custom Properties" group.
export const CUSTOM_GROUP = "Custom Properties";
export function customProps(n: SNode): [string, string][] { const h = H(); return h.kids(n, "custom_property").map((p): [string, string] => [h.str(p[1]), h.str(p[2])]); }
/** EDA_ITEM::SetCustomProperty: replace the value of `key`, or insert it in key order after the item's other children. */
export function setCustomProp(n: SNode, key: string, value: string): void {
  const h = H(); const all = h.kids(n, "custom_property");
  const at = all.find((p) => h.str(p[1]) === key); if (at) { at[2] = value; return; }
  const next = all.find((p) => h.str(p[1]) > key);
  const node: SNode = ["custom_property", key, value];
  if (next) n.splice(n.indexOf(next), 0, node);
  else if (all.length) n.splice(n.indexOf(all[all.length - 1]!) + 1, 0, node);
  else n.push(node);
}
/** EDA_ITEM::RemoveCustomProperty. */
export function removeCustomProp(n: SNode, key: string): boolean {
  const h = H(); const i = n.findIndex((c) => Array.isArray(c) && c[0] === "custom_property" && h.str(c[1]) === key);
  if (i < 0) return false; n.splice(i, 1); return true;
}
function customPropDefs(it: KItem): PropDef[] {
  return customProps(it.node).map(([key]): PropDef => ({ group: CUSTOM_GROUP, name: key, type: "text", key: "custom",
    get: (x) => { const kv = customProps(x.node).find((q) => q[0] === key); return kv ? kv[1] : null; },
    set: (n, v) => { setCustomProp(n, key, String(v)); } }));
}

function footprintProps(it: KItem, doc: KDoc, single: boolean): PropDef[] {
  const h = H();
  const attr = (name: string, key: string): PropDef => ({ group: "Attributes", name, type: "bool", get: (x) => !!h.footprintAttrs(x.node)[key], set: (n, v) => { h.setFootprintAttrs(n, { [key]: !!v }); } });
  // PROPERTY<FOOTPRINT, std::optional<int>>: empty is no override, 0 an override of 0 (the writer prints it)
  const over = (name: string, key: string, before: string[]): PropDef => ({ group: "Overrides", name, type: "length", optional: true, get: (x) => { const k = h.kid(x.node, key); return k ? h.num(k[1]) : null; },
    set: (n, v) => { if (v !== null && v !== undefined) h.setKid(n, key, [r6(v as number)], before); else h.delKid(n, key); } });
  const out: PropDef[] = [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => K().atOf(x.node)[0], set: (n, v) => { h.setFootprintPosition(n, v as number, K().atOf(n)[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => K().atOf(x.node)[1], set: (n, v) => { h.setFootprintPosition(n, K().atOf(n)[0], v as number); } },
    { group: BASIC, name: "Orientation", type: "angle", get: (x) => K().atOf(x.node)[2], set: (n, v) => h.setFootprintRotation(n, v as number) },
    { group: BASIC, name: "Layer", type: "enum", choices: [["F.Cu", layerDisplayName(doc, "F.Cu")], ["B.Cu", layerDisplayName(doc, "B.Cu")]], get: (x) => h.str((h.kid(x.node, "layer") || [])[1] || "F.Cu"), set: (n, v) => h.setFootprintSide(n, String(v)) },
    lockedProp(),
    ...fieldProps(it).map((d) => (FP_MANDATORY.includes(d.name) || privateField(it.node, d.name) ? d : Object.assign(d, { key: "field" as const }))),
    { group: "Footprint Properties", name: "Library Link", type: "text", get: (x) => h.str(x.node[1]) },
    { group: "Footprint Properties", name: "Library Description", type: "text", get: (x) => h.str((h.kid(x.node, "descr") || [])[1]) },
    { group: "Footprint Properties", name: "Keywords", type: "text", get: (x) => h.str((h.kid(x.node, "tags") || [])[1]) },
    { group: "Attributes", name: "Footprint Type", type: "enum", choices: FP_TYPES, get: (x) => String(h.footprintAttrs(x.node).type || ""), set: (n, v) => { h.setFootprintAttrs(n, { type: String(v) }); } },
    attr("Not in Schematic", "board_only"), attr("Exclude From Position Files", "exclude_from_pos_files"), attr("Exclude From Bill of Materials", "exclude_from_bom"), attr("Do not Populate", "dnp"),
    attr("Exempt From Courtyard Requirement", "allow_missing_courtyard"),
    over("Clearance Override", "clearance", ["zone_connect", "thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]),
    over("Solderpaste Margin Override", "solder_paste_margin", ["solder_paste_margin_ratio", "solder_paste_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]),
  ];
  // the Overrides entries registered with the Attributes group stay where KiCad lists them
  for (const d of out) if (d.name === "Exempt From Courtyard Requirement") d.group = "Overrides";
  if (single) out.push(...padProps(it, doc));
  return out;
}
/** One pad of a single selected footprint (PAD's properties); the "Pad" row picks which. */
function padProps(fp: KItem, doc: KDoc): PropDef[] {
  const h = H(), G = "Pad Properties"; const pads = h.kids(fp.node, "pad"); if (!pads.length) return [];
  let idx = padIndexOf.get(fp.id) || 0; if (idx >= pads.length) idx = 0;
  const picker: PropDef = { group: G, name: "Pad", type: "enum", choices: pads.map((p, i): [string, string] => { const net = h.netNameOf(doc, p); return [String(i), h.str(p[1]) + (net ? " · " + net : "")]; }), get: () => String(idx), local: (v, x) => { padIndexOf.set(x.id, +(v as string) || 0); } };
  const own = padDefs(doc, idx).filter((d) => (d.group === G || d.group === "Overrides" || d.group === PM || d.group === BD) && (!d.avail || d.avail(fp))).map((d) => d.group === "Overrides" ? Object.assign(d, { group: "Pad Overrides" }) : d);
  return [picker, ...own];
}
/** PAD's registered properties (pad.cpp PAD_DESC) for pad `idx` of a footprint item: Basic (position, orientation),
 *  Net, Pad Properties and the clearance / mask / paste Overrides; every setter edits the footprint's (cloned) node. */
function padDefs(doc: KDoc, idx: number): PropDef[] {
  const h = H(), G = "Pad Properties";
  const info = (x: KItem) => { const p = h.padNode(x.node, idx); return p ? h.padInfo(doc, p) : null; };
  const edit = (patch: (v: Raw, n: SNode) => Record<string, unknown>) => (n: SNode, v: Raw) => h.setPad(n, idx, patch(v, n), doc);
  const drillOf = (x: KItem): [number, number] => { const i = info(x); if (!i || !i.drill) return [0, 0]; const p = i.drill.split(/x/i).map(Number); return [p[0] || 0, p.length > 1 ? p[1] || 0 : p[0] || 0]; };
  const nets: [string, string][] = [["", "<no net>"], ...h.boardNetNames(doc).map((n): [string, string] => [n, n])];
  const tail = ["zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
  // the writer's order of a pad's children after (layers …) (PCB_IO_KICAD_SEXPR::format( PAD ))
  const ORDER = ["property", "sim_electrical_type", "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", ...tail];
  const after = (key: string) => ORDER.slice(ORDER.indexOf(key) + 1);
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const padType = (x: KItem) => { const p = pad(x); return p ? h.str(p[2]) : ""; };
  const isCopper = (x: KItem) => padType(x) !== "np_thru_hole";                           // isCopperPad: not NPTH
  const canHole = (x: KItem) => padType(x) === "thru_hole" || padType(x) === "np_thru_hole";   // padCanHaveHole
  // PAD::SetSizeXProp / SetSizeYProp: not 0 or less; a circle pad takes the value on both axes
  const sizeProp = (n: SNode, v: Raw, axis: "w" | "h") => { if (!((v as number) > 0)) return false; const p = h.padNode(n, idx); if (!p) return false; return h.setPad(n, idx, h.str(p[3]) === "circle" ? { w: v, h: v } : { [axis]: v }, doc); };
  // hasNormalPadstack: no (padstack (mode front_inner_back|custom) …)
  const normalStack = (x: KItem) => { const p = pad(x), ps = p && h.kid(p, "padstack"), m = ps && h.kid(ps, "mode"); return !m || h.str(m[1]) === "normal"; };
  const drillKid = (x: KItem) => { const p = pad(x); return p ? h.kid(p, "drill") : null; };
  const oblong = (x: KItem) => { const d = drillKid(x); return !!d && d.includes("oval"); };
  // PAD_UTILS::PadHasMeaningfulRoundingRadius on the front layer: a rounded (or chamfered) rectangle
  const rounded = (x: KItem) => { const p = pad(x); return !!p && normalStack(x) && h.str(p[3]) === "roundrect"; };
  const rratio = (x: KItem) => { const p = pad(x), k = p && h.kid(p, "roundrect_rratio"); return k ? h.num(k[1]) : 0; };
  const minSide = (x: KItem) => { const i = info(x); return i ? Math.min(i.w, i.h) : 0; };
  const setRatio = (n: SNode, v: number) => { const p = h.padNode(n, idx); if (!p) return false; h.setKid(p, "roundrect_rratio", [r6(Math.max(0, Math.min(0.5, v)))], after("roundrect_rratio")); return true; };
  /** A plain int the writer prints only when it is not 0 (die_length, die_delay): 0 drops (key value). */
  const intKid = (group: string, name: string, key: string, type: PropType, extra?: Partial<PropDef>): PropDef => Object.assign({ group, name, type,
    get: (x: KItem) => { const p = pad(x), k = p && h.kid(p, key); return k ? h.num(k[1]) : 0; },
    set: (n: SNode, v: Raw) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, key, [r6(v as number)], after(key)); else h.delKid(p, key); } }, extra || {});
  /** PROPERTY<PAD, std::optional<…>>: an empty cell is no override (no (key …)); 0 is an override of 0, written. */
  const optKid = (group: string, name: string, key: string, type: PropType, extra?: Partial<PropDef>): PropDef => Object.assign({ group, name, type, optional: true,
    get: (x: KItem) => { const p = pad(x), k = p && h.kid(p, key); return k ? h.num(k[1]) : null; },
    set: (n: SNode, v: Raw) => { const p = h.padNode(n, idx); if (!p) return false; if (v !== null && v !== undefined) h.setKid(p, key, [r6(v as number)], after(key)); else h.delKid(p, key); } }, extra || {});
  // PAD::GetPosition is the board position: the footprint's position plus the pad's local offset rotated by the footprint
  const padPos = (n: SNode): [number, number] | null => { const p = h.padNode(n, idx); if (!p) return null; const [fx, fy, fr] = K().atOf(n), [lx, ly] = K().atOf(p); const [rx, ry] = padRot(lx, ly, fr); return [fx + rx, fy + ry]; };
  const setPos = (n: SNode, x: number, y: number): boolean => { const p = h.padNode(n, idx), at = p && h.kid(p, "at"); if (!at) return false; const [fx, fy, fr] = K().atOf(n); const [lx, ly] = padRot(x - fx, y - fy, -fr); at[1] = r6(lx); at[2] = r6(ly); return true; };
  return [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => padPos(x.node)?.[0] ?? null, set: (n, v) => { const c = padPos(n); return !!c && setPos(n, v as number, c[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => padPos(x.node)?.[1] ?? null, set: (n, v) => { const c = padPos(n); return !!c && setPos(n, c[0], v as number); } },
    // PAD::GetOrientationDegrees: the board (absolute) angle, the one the pad's (at x y angle) stores
    { group: BASIC, name: "Orientation", type: "angle", get: (x) => { const i = info(x); return i ? h.normDeg(i.rot) : null; }, set: edit((v) => ({ rot: v as number })) },
    { group: "Net", name: "Net", type: "enum", choices: nets, avail: isCopper, get: (x) => info(x)?.net ?? null, set: edit((v) => ({ net: String(v) })) },
    { group: "Net", name: "Net Class", type: "text", avail: isCopper, get: (x) => { const n = info(x)?.net; return n ? netClassOf(n) : "Default"; } },
    { group: G, name: "Pad Type", type: "enum", choices: PAD_TYPES, get: (x) => info(x)?.type ?? null, set: edit((v) => ({ type: String(v) })) },
    { group: G, name: "Pad Shape", type: "enum", choices: PAD_SHAPES, avail: normalStack, get: (x) => info(x)?.shape ?? null, set: edit((v) => ({ shape: String(v) })) },
    { group: G, name: "Pad Number", type: "text", avail: isCopper, get: (x) => info(x)?.number ?? null, set: edit((v) => ({ number: String(v) })) },
    { group: G, name: "Pin Name", type: "text", get: (x) => { const p = h.padNode(x.node, idx), k = p && h.kid(p, "pinfunction"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "pinfunction", [String(v)], after("pinfunction")); else h.delKid(p, "pinfunction"); } },
    { group: G, name: "Pin Type", type: "enum", choices: PIN_TYPES, get: (x) => { const p = h.padNode(x.node, idx), k = p && h.kid(p, "pintype"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "pintype", [String(v)], after("pintype")); else h.delKid(p, "pintype"); } },
    { group: G, name: "Simulation Electrical Type", type: "enum", choices: PAD_SIM_TYPES, get: (x) => { const p = pad(x), k = p && h.kid(p, "sim_electrical_type"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "sim_electrical_type", [String(v)], after("sim_electrical_type")); else h.delKid(p, "sim_electrical_type"); } },
    { group: G, name: "Size X", type: "length", avail: normalStack, get: (x) => info(x)?.w ?? null, set: (n, v) => sizeProp(n, v, "w") },
    // circle pads have no usable Y size
    { group: G, name: "Size Y", type: "length", avail: (x) => normalStack(x) && h.str(pad(x)?.[3]) !== "circle", get: (x) => info(x)?.h ?? null, set: (n, v) => sizeProp(n, v, "h") },
    { group: G, name: "Corner Radius Ratio", type: "number", avail: rounded, get: (x) => rratio(x), set: (n, v) => setRatio(n, v as number) },
    { group: G, name: "Corner Radius Size", type: "length", avail: rounded, get: (x) => r6(rratio(x) * minSide(x)),
      set: (n, v, it) => { const m = minSide(Object.assign({}, it, { node: n })); return m > 0 && setRatio(n, (v as number) / m); } },
    // PAD::SetDrillShape: (drill oval x y) for an oblong hole, (drill d) for a round one
    { group: G, name: "Hole Shape", type: "enum", choices: PAD_DRILL_SHAPES, canWrite: canHole, get: (x) => (oblong(x) ? "oval" : "circle"),
      set: (n, v) => { const p = h.padNode(n, idx), d = p && h.kid(p, "drill"); if (!d) return false; const i = d.indexOf("oval"); if (v === "oval") { if (i < 0) d.splice(1, 0, "oval"); } else if (i > 0) { d.splice(i, 1); const sz = d.slice(1).filter((t) => typeof t === "number"); if (sz.length > 1) d.splice(d.indexOf(sz[1]), 1); } } },
    { group: G, name: "Hole Size X", type: "length", canWrite: canHole, get: (x) => drillOf(x)[0], set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const d = h.padInfo(doc, p).drill.split(/x/i).map(Number); return h.setPad(n, idx, { drill: [v as number, d.length > 1 ? d[1] : (v as number)] }, doc); } },
    { group: G, name: "Hole Size Y", type: "length", canWrite: canHole, avail: oblong, get: (x) => drillOf(x)[1], set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const d = h.padInfo(doc, p).drill.split(/x/i).map(Number); return h.setPad(n, idx, { drill: [d[0] || (v as number), v as number] }, doc); } },
    { group: G, name: "Fabrication Property", type: "enum", choices: PAD_FAB_PROPS, get: (x) => { const p = pad(x), k = p && h.kid(p, "property"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "property", [String(v)], after("property")); else h.delKid(p, "property"); } },
    // UNCONNECTED_LAYER_MODE: the writer keeps (remove_unused_layers) / (keep_end_layers) for a PTH pad only
    { group: G, name: "Copper Layers", type: "enum", choices: PAD_UNCONNECTED, get: (x) => { const p = pad(x); return p ? unconnectedMode(p) : null; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p || h.str(p[2]) !== "thru_hole") return false; setUnconnectedMode(p, String(v)); } },
    intKid(G, "Pad To Die Length", "die_length", "length", { avail: isCopper }),
    intKid(G, "Pad To Die Delay", "die_delay", "time", { avail: isCopper }),
    ...postMachiningDefs(doc, idx, "Top", "front_post_machining"),
    ...postMachiningDefs(doc, idx, "Bottom", "back_post_machining"),
    ...backdrillDefs(doc, idx),
    optKid("Overrides", "Clearance Override", "clearance", "length"),
    { group: "Overrides", name: "Soldermask Margin Override", type: "length", optional: true, get: (x) => info(x)?.maskMargin ?? null, set: edit((v) => ({ maskMargin: v === undefined ? null : v })) },
    { group: "Overrides", name: "Solderpaste Margin Override", type: "length", optional: true, get: (x) => info(x)?.pasteMargin ?? null, set: edit((v) => ({ pasteMargin: v === undefined ? null : v })) },
    optKid("Overrides", "Solderpaste Margin Ratio Override", "solder_paste_margin_ratio", "number"),
    // ZONE_CONNECTION: INHERITED is no (zone_connect), the others its number
    { group: "Overrides", name: "Zone Connection Style", type: "enum", choices: PAD_ZONE_CONNECT, get: (x) => { const p = pad(x), k = p && h.kid(p, "zone_connect"); return k ? String(h.num(k[1])) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v === "" || v === null) h.delKid(p, "zone_connect"); else h.setKid(p, "zone_connect", [+(v as string)], after("zone_connect")); } },
    optKid("Overrides", "Thermal Relief Spoke Width", "thermal_bridge_width", "length"),
    // PADSTACK::ThermalSpokeAngle: the stored angle, else DefaultThermalSpokeAngleForShape (45° for a circle, else 90°);
    // the writer leaves the default out
    { group: "Overrides", name: "Thermal Relief Spoke Angle", type: "angle", get: (x) => { const p = pad(x), k = p && h.kid(p, "thermal_bridge_angle"); return k ? h.num(k[1]) : (p && h.str(p[3]) === "circle" ? 45 : 90); },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const def = h.str(p[3]) === "circle" ? 45 : 90; const a = h.deg360(v as number); if (a === def) h.delKid(p, "thermal_bridge_angle"); else h.setKid(p, "thermal_bridge_angle", [r6(a)], after("thermal_bridge_angle")); } },
    optKid("Overrides", "Thermal Relief Gap", "thermal_gap", "length"),
  ];
}
// the children of (pad …) in the writer's order (PCB_IO_KICAD_SEXPR::format( PAD )), so a new one lands in its place
const PAD_CHILD_ORDER = ["at", "size", "rect_delta", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "property", "sim_electrical_type",
  "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length",
  "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap",
  "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
const padAfter = (key: string) => PAD_CHILD_ORDER.slice(PAD_CHILD_ORDER.indexOf(key) + 1);
/** PAD::GetUnconnectedLayerMode from (remove_unused_layers) and (keep_end_layers). */
function unconnectedMode(p: SNode): string {
  const h = H(); const flag = (key: string) => { const k = h.kid(p, key); return k ? h.str(k[1]) !== "no" : p.includes(key); };
  if (!flag("remove_unused_layers")) return "keep_all";
  return flag("keep_end_layers") ? "remove_except_start_end" : "remove_all";
}
/** PAD::SetUnconnectedLayerMode as the writer saves it: START_END_ONLY has no token of its own for a pad and is
 *  written like REMOVE_ALL (GetRemoveUnconnected true, GetKeepTopBottom false). */
function setUnconnectedMode(p: SNode, mode: string): void {
  const h = H(); const remove = mode !== "keep_all";
  h.setKid(p, "remove_unused_layers", [remove ? "yes" : "no"], padAfter("remove_unused_layers"));
  if (!remove) { h.delKid(p, "keep_end_layers"); h.delKid(p, "zone_layer_connections"); return; }
  h.setKid(p, "keep_end_layers", [mode === "remove_except_start_end" ? "yes" : "no"], padAfter("keep_end_layers"));
  if (!h.kid(p, "zone_layer_connections")) h.setKid(p, "zone_layer_connections", [], padAfter("zone_layer_connections"));
}
const isRoundDrill = (p: SNode | null) => { const d = p && H().kid(p, "drill"); return !d || !d.includes("oval"); };   // GetDrillShape() == CIRCLE
/** The "Post-machining Properties" rows of one side (PADSTACK::FrontPostMachining / BackPostMachining):
 *  (front_post_machining counterbore|countersink (size s) (depth d) (angle a)), left out when not post-machined. */
function postMachiningDefs(doc: KDoc, idx: number, side: "Top" | "Bottom", key: string): PropDef[] {
  const h = H(); void doc;
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const canHole = (x: KItem) => { const p = pad(x), t = p ? h.str(p[2]) : ""; return t === "thru_hole" || t === "np_thru_hole"; };
  const node = (p: SNode | null) => (p ? h.kid(p, key) : null);
  const mode = (x: KItem) => { const k = node(pad(x)); return k ? h.str(k[1]) : "none"; };
  const round = (x: KItem) => isRoundDrill(pad(x));
  const sub = (name: string, sk: string, type: PropType, show: (m: string) => boolean, before: string[]): PropDef => ({ group: PM, name, type, canWrite: canHole,
    avail: (x) => round(x) && show(mode(x)),
    get: (x) => { const k = node(pad(x)), v = k && h.kid(k, sk); return v ? h.num(v[1]) : 0; },
    // the writer prints each only when it is above 0
    set: (n, v) => { const k = node(h.padNode(n, idx)); if (!k) return false; if ((v as number) > 0) h.setKid(k, sk, [r6(v as number)], before); else h.delKid(k, sk); } });
  return [
    { group: PM, name: `${side} Post-machining`, type: "enum", choices: PAD_POST_MACHINING, canWrite: canHole, avail: round, get: mode,
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const k = node(p);
        if (v === "none") { if (!k) return false; h.delKid(p, key); return; }
        if (k) k[1] = String(v); else h.setKid(p, key, [String(v)], padAfter(key)); } },
    sub(`${side} Post-machining Size`, "size", "length", (m) => m === "counterbore" || m === "countersink", ["depth", "angle"]),
    sub(`${side} Counterbore Depth`, "depth", "length", (m) => m === "counterbore", ["angle"]),
    sub(`${side} Countersink Angle`, "angle", "angle", (m) => m === "countersink", []),
  ];
}
/** The "Backdrill Properties" rows (PADSTACK::GetBackdrillMode & co.): a backdrill is a (backdrill …) or
 *  (tertiary_drill …) child, (size s) (layers start must-cut), whose start layer is its side (F.Cu top, B.Cu bottom). */
function backdrillDefs(doc: KDoc, idx: number): PropDef[] {
  const h = H(); const cu = layerChoices(doc, true);
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const SLOTS = ["backdrill", "tertiary_drill"];
  const sizeOf = (k: SNode) => { const z = h.kid(k, "size"); return z ? h.num(z[1]) : 0; };
  const startOf = (k: SNode) => { const l = h.kid(k, "layers"); return l ? h.str(l[1]) : ""; };
  const endOf = (k: SNode) => { const l = h.kid(k, "layers"); return l && l.length > 2 ? h.str(l[2]) : ""; };
  const sideLayer = (top: boolean) => (top ? "F.Cu" : "B.Cu");
  /** findBackdrillDrill */
  const find = (p: SNode | null, top: boolean): SNode | null => { if (!p) return null; for (const key of SLOTS) { const k = h.kid(p, key); if (k && sizeOf(k) > 0 && startOf(k) === sideLayer(top)) return k; } return null; };
  /** backdrillWriteSlot: the side's drill, else its home slot (backdrill for the top, tertiary_drill for the bottom)
   *  unless the other side holds it */
  const slotKey = (p: SNode, top: boolean): string => {
    const home = top ? "backdrill" : "tertiary_drill", other = top ? "tertiary_drill" : "backdrill", k = h.kid(p, home);
    return k && sizeOf(k) > 0 && startOf(k) === sideLayer(!top) ? other : home;
  };
  const write = (p: SNode, top: boolean, size: number, end: string) => {
    const k = find(p, top), key = k ? (k[0] as string) : slotKey(p, top);
    h.setKid(p, key, [["size", r6(size)], ["layers", sideLayer(top), end || sideLayer(top)]], padAfter(key));
  };
  /** clearBackdrillSide: the writer leaves out a drill of size 0 */
  const clear = (p: SNode, top: boolean) => { for (const key of SLOTS) { const k = h.kid(p, key); if (k && startOf(k) === sideLayer(top)) h.delKid(p, key); } };
  const drill = (p: SNode) => { const d = h.kid(p, "drill"); if (!d) return 0; const v = d.slice(1).find((t) => typeof t === "number"); return typeof v === "number" ? v : 0; };
  const mode = (x: KItem) => { const p = pad(x), t = !!find(p, true), b = !!find(p, false); return t && b ? "both" : t ? "top" : b ? "bottom" : "none"; };
  const has = (top: boolean) => (x: KItem) => { if (!isRoundDrill(pad(x))) return false; const m = mode(x); return m === "both" || m === (top ? "top" : "bottom"); };
  const sizeRow = (top: boolean): PropDef => ({ group: BD, name: `${top ? "Top" : "Bottom"} Backdrill Size`, type: "length", optional: true, avail: has(top),
    get: (x) => { const k = find(pad(x), top); return k ? sizeOf(k) : null; },
    set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v === null || v === undefined || !((v as number) > 0)) { clear(p, top); return; } const k = find(p, top); write(p, top, v as number, k ? endOf(k) : ""); } });
  const cutRow = (top: boolean): PropDef => ({ group: BD, name: `${top ? "Top" : "Bottom"} Backdrill Must-Cut`, type: "enum", choices: cu, avail: has(top),
    get: (x) => { const k = find(pad(x), top); return k ? endOf(k) : null; },
    set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const k = find(p, top); if (!k) return false; write(p, top, sizeOf(k), String(v)); } });
  return [
    { group: BD, name: "Backdrill Mode", type: "enum", choices: PAD_BACKDRILL, get: mode,
      // PADSTACK::SetBackdrillMode: a new side starts on its own copper layer, 1.1 × the hole
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false;
        for (const top of [true, false]) {
          const want = v === "both" || v === (top ? "top" : "bottom"), k = find(p, top);
          if (!want) { clear(p, top); continue; }
          if (k) continue;
          const size = r6(drill(p) * 1.1); if (size > 0) write(p, top, size, "");
        } } },
    sizeRow(false), cutRow(false), sizeRow(true), cutRow(true),
  ];
}
/** RotatePoint (trigo.cpp) with KiCad's Y-down board axes. */
function padRot(x: number, y: number, deg: number): [number, number] { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; }

// ---------------------------------------------------------------- selected pads (PCB_PAD_T in the selection)
interface PadPick { key: string; fp: KItem; idx: number }
/** The pads picked on their own (CollabTools.pcb.selectedPadKeys(): "footprintId#padIndex"), when no item is selected. */
export function selectedPads(): PadPick[] {
  const doc = kdoc(); if (!doc || isSchDoc()) return [];
  const P = window.CollabTools && window.CollabTools.pcb; const keys: string[] = P && P.selectedPadKeys ? P.selectedPadKeys() : [];
  const out: PadPick[] = [];
  for (const key of keys) { const i = key.lastIndexOf("#"); const fp = doc.items.get(key.slice(0, i)); const idx = +key.slice(i + 1); if (fp && H().padNode(fp.node, idx)) out.push({ key, fp, idx }); }
  return out;
}
function padGrid(doc: KDoc, pads: PadPick[], ro: boolean): PropGrid {
  const defs = pads.map((p) => new Map(padDefs(doc, p.idx).map((d): [string, PropDef] => [defId(d), d])));
  const groups: PropGroup[] = [];
  for (const d of defs[0].values()) {
    const id = defId(d); let value = "", mixed = false, writable = true;
    if (pads.some((p, i) => { const own = defs[i].get(id)!; try { return !!own.avail && !own.avail(p.fp); } catch (e) { return true; } })) continue;   // PROPERTIES_PANEL: only what every item has
    pads.forEach((p, i) => { const own = defs[i].get(id)!; if (!own.set || (own.canWrite && !own.canWrite(p.fp))) writable = false; let raw: Raw = null; try { raw = own.get(p.fp); } catch (e) { raw = null; } const text = show(own, raw); if (i === 0) value = text; else if (text !== value) mixed = true; });
    const row: PropRow = { id, name: d.name, type: d.type, value: mixed ? "" : value, mixed, readOnly: ro || !writable, choices: d.choices };
    let g = groups.find((x) => x.name === d.group); if (!g) { g = { name: d.group, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }
  return { title: pads.length === 1 ? "Pad" : `${pads.length} objects selected`, count: pads.length, groups, readOnly: ro };
}
/** Commit one property to every selected pad: one whole-footprint replace per footprint, all in one undo step. */
function setPadProp(doc: KDoc, pads: PadPick[], id: string, text: string): string | null {
  const head = padDefs(doc, pads[0].idx).find((d) => defId(d) === id); if (!head || !head.set) return "No such property";
  const parsed = parse(head, text); if (typeof parsed === "string") return parsed;
  const byFp = new Map<string, PadPick[]>(); for (const p of pads) { const l = byFp.get(p.fp.id) || []; l.push(p); byFp.set(p.fp.id, l); }
  const changes: KChange[] = [];
  for (const list of byFp.values()) {
    const fp = list[0].fp; const node = K().cloneNode(fp.node); let touched = false;
    for (const p of list) {
      const d = padDefs(doc, p.idx).find((x) => defId(x) === id); if (!d || !d.set || (d.canWrite && !d.canWrite(fp))) continue;
      let cur: Raw = null; try { cur = d.get(Object.assign({}, fp, { node })); } catch (e) { cur = null; }
      if (show(d, cur) === show(d, parsed.v)) continue;
      try { if (d.set(node, parsed.v, fp) !== false) touched = true; } catch (e) { console.warn(e); }
    }
    if (touched) changes.push(K().replaceChange(doc, Object.assign({}, fp, { node, geom: [], bbox: null })));
  }
  if (!changes.length) return null;
  tctx().commit(changes, head.name.toLowerCase());
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return null;
}
const VIA_TYPES: [string, string][] = [["through", "Through"], ["blind", "Blind"], ["buried", "Buried"], ["micro", "Micro"]];
function viaProps(doc: KDoc): PropDef[] {
  const h = H(), V = "Via Properties"; const cu = layerChoices(doc, true);
  const layer = (name: string, i: 1 | 2): PropDef => ({ group: V, name, type: "enum", choices: cu, get: (x) => { const l = h.kid(x.node, "layers"); return l ? h.str(l[i]) : i === 1 ? "F.Cu" : "B.Cu"; },
    set: (n, v) => { const l = h.kid(n, "layers"); const a = l ? h.str(l[1]) : "F.Cu", b = l ? h.str(l[2]) : "B.Cu"; h.setViaLayers(n, i === 1 ? String(v) : a, i === 2 ? String(v) : b); } });
  const typeOf = (n: SNode) => VIA_TYPES.map((t) => t[0]).find((t) => t !== "through" && n.indexOf(t) > 0) || "through";
  return [atProp("Position X", 1), atProp("Position Y", 2), lockedProp(),
    { group: V, name: "Diameter", type: "length", get: (x) => h.num((h.kid(x.node, "size") || [])[1], 0.8), set: (n, v) => { if (!((v as number) > 0)) return false; h.setViaSize(n, v as number); } },
    { group: V, name: "Hole", type: "length", get: (x) => h.num((h.kid(x.node, "drill") || [])[1], 0.4), set: (n, v) => { if (!((v as number) > 0)) return false; h.setViaDrill(n, v as number); } },
    layer("Layer Top", 1), layer("Layer Bottom", 2),
    { group: V, name: "Via Type", type: "enum", choices: VIA_TYPES, get: (x) => typeOf(x.node), set: (n, v) => { for (const t of ["blind", "buried", "micro"]) { const i = n.indexOf(t); if (i > 0) n.splice(i, 1); } if (v !== "through") n.splice(1, 0, String(v)); } },
    ...netProps(doc)];
}
const ZONE_CONNECT: [string, string][] = [["", "Thermal reliefs"], ["no", "None"], ["yes", "Solid"], ["thru_hole_only", "Thermal reliefs for PTH"]];
const FILL_MODES: [string, string][] = [["solid", "Solid fill"], ["hatch", "Hatch pattern"], ["thieving", "Copper thieving"]];
const THIEVING_PATTERNS: [string, string][] = [["dots", "Dots"], ["squares", "Squares"], ["hatch", "Hatch"]];
function zoneProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), El = "Electrical";
  const cp = (n: SNode) => h.kid(n, "connect_pads");
  const fillKid = (name: string, key: string): PropDef => ({ group: El, name, type: "length", get: (x) => { const f = h.kid(x.node, "fill"), k = f && h.kid(f, key); return k ? h.num(k[1]) : 0.5; },
    set: (n, v) => { let f = h.kid(n, "fill"); if (!f) f = h.setKid(n, "fill", [], ["polygon", "filled_polygon"]); h.setKid(f, key, [r6(Math.max(0, v as number))], key === "thermal_gap" ? ["thermal_bridge_width", "smoothing", "radius", "island_removal_mode"] : ["smoothing", "radius", "island_removal_mode"]); } });
  const out: PropDef[] = [
    { group: BASIC, name: "Layer", type: "text", get: (x) => { const s = h.kid(x.node, "layer"), m = h.kid(x.node, "layers"); return s ? layerDisplayName(doc, h.str(s[1])) : m ? m.slice(1).map((l) => layerDisplayName(doc, h.str(l))).join(", ") : ""; } },
    lockedProp(),
    { group: BASIC, name: "Name", type: "text", get: (x) => h.str((h.kid(x.node, "name") || [])[1]), set: (n, v) => { h.setZoneName(n, String(v)); } },
    { group: BASIC, name: "Priority", type: "int", get: (x) => h.num((h.kid(x.node, "priority") || [])[1], 0), set: (n, v) => { h.setZonePriority(n, v as number); } },
  ];
  if (h.kid(it.node, "keepout")) return out;
  // ZONE_DESC: Fill Mode on copper zones; a copper-thieving zone hides its net, pad connections and thermal rows
  // and shows its THIEVING_SETTINGS (Element Size writable for dots and squares, Line Width for hatch)
  type ZT = { zoneFillMode(n: SNode): string; setZoneFillMode(n: SNode, m: string): SNode; thievingOf(n: SNode): Record<string, number | string | boolean>; setThieving(n: SNode, p: Record<string, unknown>): SNode; thievingAllowed?(d: KDoc): boolean };
  const Z = pcbTools() as unknown as ZT | null;
  const copper = (x: KItem) => { const s = h.kid(x.node, "layer"), m = h.kid(x.node, "layers"); const l = s ? h.str(s[1]) : m ? h.str(m[1]) : ""; return /\.Cu$/.test(l) || /^\*\.Cu$|^F&B\.Cu$/.test(l); };
  if (!Z || !copper(it)) return out;
  const FS = "Fill Style";
  const thieving = Z.zoneFillMode(it.node) === "thieving";
  if (thieving) out.splice(1, 0, layerProp(doc, true, "F.Cu"));
  const tv = (key: string, type: PropType, writable?: (x: KItem) => boolean): PropDef => ({ group: FS, name: "", type, get: (x) => Z.thievingOf(x.node)[key] as Raw,
    set: (n, v, x) => { if (writable && !writable(x)) return false; if ((type === "length") && !((v as number) > 0)) return false; Z.setThieving(n, { [key]: type === "bool" ? !!v : type === "enum" ? String(v) : +(v as number) }); } });
  const named = (d: PropDef, name: string): PropDef => Object.assign(d, { name });
  const isHatch = (x: KItem) => Z.thievingOf(x.node).type === "hatch";
  // copper thieving needs the KiCad 11 board format (20260513): a board in an older format is not offered it, so its
  // file format version is never raised by a fill mode edit
  const canThieve = thieving || !Z.thievingAllowed || Z.thievingAllowed(doc);
  const modes = canThieve ? FILL_MODES : FILL_MODES.filter((m) => m[0] !== "thieving");
  out.push({ group: FS, name: "Fill Mode", type: "enum", choices: modes, get: (x) => Z.zoneFillMode(x.node), set: (n, v) => { if (Z.zoneFillMode(n) === String(v)) return false; if (String(v) === "thieving" && !canThieve) return false; Z.setZoneFillMode(n, String(v)); } });
  if (thieving) {
    out.push(named(Object.assign(tv("type", "enum"), { choices: THIEVING_PATTERNS }), "Thieving Pattern"),
      named(tv("size", "length", (x) => !isHatch(x)), "Thieving Element Size"), named(tv("gap", "length"), "Thieving Gap"),
      named(tv("width", "length", isHatch), "Thieving Line Width"), named(tv("stagger", "bool"), "Thieving Stagger"), named(tv("orientation", "angle"), "Thieving Orientation"),
      { group: El, name: "Clearance", type: "length", get: (x) => { const c = cp(x.node), k = c && h.kid(c, "clearance"); return k ? h.num(k[1]) : 0; }, set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); h.setKid(c, "clearance", [r6(Math.max(0, v as number))]); } },
      { group: El, name: "Minimum Width", type: "length", get: (x) => h.num((h.kid(x.node, "min_thickness") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setKid(n, "min_thickness", [r6(v as number)], ["filled_areas_thickness", "keepout", "fill"]); } });
    return out;
  }
  out.push(...netProps(doc),
    { group: El, name: "Clearance", type: "length", get: (x) => { const c = cp(x.node), k = c && h.kid(c, "clearance"); return k ? h.num(k[1]) : 0; }, set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); h.setKid(c, "clearance", [r6(Math.max(0, v as number))]); } },
    { group: El, name: "Minimum Width", type: "length", get: (x) => h.num((h.kid(x.node, "min_thickness") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setKid(n, "min_thickness", [r6(v as number)], ["filled_areas_thickness", "keepout", "fill"]); } },
    { group: El, name: "Pad Connections", type: "enum", choices: ZONE_CONNECT, get: (x) => { const c = cp(x.node); return c && typeof c[1] === "string" ? c[1] : ""; },
      set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [["clearance", 0.5]], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); if (typeof c[1] === "string") c.splice(1, 1); if (v) c.splice(1, 0, String(v)); } },
    fillKid("Thermal Relief Gap", "thermal_gap"), fillKid("Thermal Relief Spoke Width", "thermal_bridge_width"));
  return out;
}
function fillOfShape(n: SNode): boolean { const f = H().kid(n, "fill"); if (!f) return false; const v = H().str(f[1]); return v === "yes" || v === "solid"; }
function boardShapeProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), S = "Shape Properties", k = it.kind;
  const out: PropDef[] = [layerProp(doc, false, "Dwgs.User"), lockedProp()];
  if (k === "gr_line" || k === "gr_rect" || k === "gr_arc") out.push(xyProp(S, "Start X", "start", 1), xyProp(S, "Start Y", "start", 2), xyProp(S, "End X", "end", 1), xyProp(S, "End Y", "end", 2));
  if (k === "gr_circle") {
    const centre = (name: string, i: 1 | 2): PropDef => ({ group: S, name, type: "coord", get: (x) => { const c = h.kid(x.node, "center"); return c ? h.num(c[i]) : null; },
      set: (n, v) => { const c = h.kid(n, "center"), e = h.kid(n, "end"); if (!c || !e) return false; const d = (v as number) - h.num(c[i]); c[i] = r6(v as number); e[i] = r6(h.num(e[i]) + d); } });
    out.push(centre("Center X", 1), centre("Center Y", 2), { group: S, name: "Radius", type: "length",
      get: (x) => { const c = h.kid(x.node, "center"), e = h.kid(x.node, "end"); return c && e ? Math.hypot(h.num(e[1]) - h.num(c[1]), h.num(e[2]) - h.num(c[2])) : null; },
      set: (n, v) => { const c = h.kid(n, "center"), e = h.kid(n, "end"); if (!c || !e || !((v as number) > 0)) return false; e[1] = r6(h.num(c[1]) + (v as number)); e[2] = r6(h.num(c[2])); } });
  }
  out.push({ group: S, name: "Line Width", type: "length", get: (x) => h.strokeWidth(x.node) || h.num((h.kid(x.node, "width") || [])[1], 0), set: (n, v) => { if (h.kid(n, "stroke") || !h.kid(n, "width")) h.setStrokeWidth(n, Math.max(0, v as number)); else h.setWidth(n, Math.max(0, v as number)); } });
  if (h.kid(it.node, "stroke")) out.push(strokeProps(S, "Line Style", false)[0]);
  if (k === "gr_rect" || k === "gr_circle" || k === "gr_poly") out.push({ group: S, name: "Filled", type: "bool", get: (x) => fillOfShape(x.node),
    set: (n, v) => { const f = h.kid(n, "fill"); const old = f ? h.str(f[1]) : ""; const legacy = old === "solid" || old === "none"; h.setKid(n, "fill", [v ? (legacy ? "solid" : "yes") : (legacy ? "none" : "no")], ["layer", "net", "uuid", "tstamp"]); } });
  return out;
}
/** PCB_TEXTBOX::SetTextAngle through the board module: the box slides about its start, the angle is the text's. */
function slideTextBox(n: SNode, deg: number) {
  const P = pcbTools() as unknown as { setTextBoxAngleSliding?(n: SNode, d: number): SNode } | null;
  if (P && P.setTextBoxAngleSliding) P.setTextBoxAngleSliding(n, deg);
}
function boardTextBoxProps(doc: KDoc): PropDef[] {
  const h = H(), T = "Text Properties";
  const base = boardTextProps(doc).filter((d) => d.name !== "Position X" && d.name !== "Position Y" && d.name !== "Orientation" && d.name !== "Knockout");
  // PCB_SHAPE::GetPosition is the box's start; SetPosition moves the whole box
  const pos = (name: string, i: 1 | 2): PropDef => ({ group: BASIC, name, type: "coord", get: (x) => h.num((h.kid(x.node, "start") || [])[i], 0),
    set: (n, v) => { const s = h.kid(n, "start"), e = h.kid(n, "end"); if (!s) return false; const d = (v as number) - h.num(s[i]); s[i] = r6(h.num(s[i]) + d); if (e) e[i] = r6(h.num(e[i]) + d); } });
  const margin = (name: string, i: number): PropDef => ({ group: T, name, type: "length", get: (x) => { const m = h.kid(x.node, "margins"); return m ? h.num(m[i], 0) : 0; },
    set: (n, v) => { const m = h.kid(n, "margins"); if (!m || !((v as number) >= 0)) return false; m[i] = r6(v as number); } });
  const orient: PropDef = { group: T, name: "Orientation", type: "angle", get: (x) => { const a = h.kid(x.node, "angle"); return h.normDeg(a ? h.num(a[1]) : 0); }, set: (n, v) => { slideTextBox(n, v as number); } };
  const out = [pos("Position X", 1), pos("Position Y", 2), ...base];
  out.splice(out.findIndex((d) => d.name === "Text") + 1, 0, orient);
  out.push(
    { group: T, name: "Knockout", type: "bool", get: (x) => { const l = h.kid(x.node, "layer"); return !!l && l.indexOf("knockout") > 0; }, set: (n, v) => { const l = h.kid(n, "layer"); if (!l) return false; const i = l.indexOf("knockout"); if (i > 0) l.splice(i, 1); if (v) l.push("knockout"); } },
    { group: T, name: "Border", type: "bool", get: (x) => h.yes(x.node, "border", false), set: (n, v) => { h.setKid(n, "border", [v ? "yes" : "no"], ["stroke", "knockout", "uuid"]); } },
    { group: T, name: "Border Style", type: "enum", choices: LINE_STYLES.slice(1), get: (x) => { const st = h.kid(x.node, "stroke"), t = st && h.kid(st, "type"); return t ? h.str(t[1]) : "solid"; },
      set: (n, v) => { const st = h.kid(n, "stroke") || h.setKid(n, "stroke", [["width", 0.1]], ["knockout", "uuid"]); h.setKid(st, "type", [String(v)]); } },
    { group: T, name: "Border Width", type: "length", get: (x) => h.strokeWidth(x.node), set: (n, v) => { h.setStrokeWidth(n, Math.max(0, v as number)); } },
    margin("Margin Left", 1), margin("Margin Top", 2), margin("Margin Right", 3), margin("Margin Bottom", 4));
  return out;
}
function boardTextProps(doc: KDoc): PropDef[] {
  const h = H(), T = "Text Properties";
  const size = (name: string, i: 1 | 2): PropDef => ({ group: T, name, type: "length", get: (x) => { const f = fontOf(x.node, false), s = f && h.kid(f, "size"); return s ? h.num(s[i], 1) : 1; },
    set: (n, v) => { if (!((v as number) > 0)) return false; const f = fontOf(n, true)!; const s = h.kid(f, "size") || h.setKid(f, "size", [1, 1], ["thickness", "bold", "italic"]); s[i] = r6(v as number); } });
  return [atProp("Position X", 1), atProp("Position Y", 2), layerProp(doc, false, "F.SilkS"), lockedProp(),
    { group: T, name: "Text", type: "longtext", get: (x) => h.str(x.node[1]), set: (n, v) => { h.setText(n, String(v)); } },
    { group: T, name: "Orientation", type: "angle", get: (x) => K().atOf(x.node)[2], set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, x, y, r6(h.normDeg(v as number))); } },
    size("Width", 2), size("Height", 1),
    { group: T, name: "Thickness", type: "length", get: (x) => { const f = fontOf(x.node, false), t = f && h.kid(f, "thickness"); return t ? h.num(t[1]) : 0; }, set: (n, v) => { const f = fontOf(n, true)!; if ((v as number) > 0) h.setKid(f, "thickness", [r6(v as number)], ["bold", "italic", "color"]); else h.delKid(f, "thickness"); } },
    fontFlag(T, "Bold", "bold"), fontFlag(T, "Italic", "italic"),
    { group: T, name: "Mirrored", type: "bool", get: (x) => justifyOf(x.node).mirror, set: (n, v) => setJustify(n, { mirror: !!v }) },
    ...justifyProps(T),
    { group: T, name: "Knockout", type: "bool", get: (x) => { const l = h.kid(x.node, "layer"); return !!l && l.indexOf("knockout") > 0; }, set: (n, v) => { const l = h.kid(n, "layer"); if (!l) return false; const i = l.indexOf("knockout"); if (i > 0) l.splice(i, 1); if (v) l.push("knockout"); } },
  ];
}
// PCB_TUNING_PATTERN_DESC (pcbnew/generators/pcb_tuning_pattern.cpp): BOARD_ITEM's rows with its own Layer, Width and
// Net, the Technical Layers group, and "Pattern Properties"; the target rows follow the tuning mode
const TUNING_MODES: [string, string][] = [["single", "Single track"], ["diff_pair", "Differential pair"], ["diff_pair_skew", "Diff pair skew"]];
const MEANDER_SIDES: [string, string][] = [["left", "Left"], ["right", "Right"], ["default", "Default"]];
function tuningPatternProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), PT = "Pattern Properties", TL = "Technical Layers";
  const members = (x: KItem) => ((window.KiCadCanvas as unknown as { groupMemberIds(n: SNode): string[] }).groupMemberIds(x.node)).map((id) => doc.items.get(id)).filter((m): m is KItem => !!m && (m.kind === "segment" || m.kind === "arc"));
  const firstTrack = (x: KItem) => members(x)[0] || null;
  const numKid = (n: SNode, k: string, d: number | null = null) => { const c = h.kid(n, k); return c ? h.num(c[1]) : d; };
  const setNum = (n: SNode, k: string, v: number) => { const c = h.kid(n, k); if (c) c.splice(1, c.length - 1, r6(v)); else h.setKid(n, k, [r6(v)], ["members"]); };
  const strKid = (n: SNode, k: string) => h.str((h.kid(n, k) || [])[1] || "");
  const yn = (n: SNode, k: string, d: boolean) => { const c = h.kid(n, k); return c ? h.str(c[1]) === "yes" : d; };
  const setYn = (n: SNode, k: string, v: boolean) => { const c = h.kid(n, k); if (c) c.splice(1, c.length - 1, v ? "yes" : "no"); else h.setKid(n, k, [v ? "yes" : "no"], ["members"]); };
  const xyOf = (n: SNode, k: string): [number, number] | null => { const c = h.kid(n, k), q = c && h.kid(c, "xy"); return q ? [h.num(q[1]), h.num(q[2])] : null; };
  const setXy = (n: SNode, k: string, i: 1 | 2, v: number) => { const c = h.kid(n, k), q = c && h.kid(c, "xy"); if (!q) return false; q[i] = r6(v); };
  const mode = (x: KItem) => strKid(x.node, "tuning_mode") || "single";
  const timeDomain = (x: KItem) => yn(x.node, "is_time_domain", false);
  const nets: [string, string][] = [["", "<no net>"], ...h.boardNetNames(doc).filter(Boolean).map((n): [string, string] => [n, n])];
  const pos = (name: string, i: 1 | 2): PropDef => ({ group: BASIC, name, type: "coord", get: (x) => (xyOf(x.node, "origin") || [0, 0])[i - 1],
    // PCB_GENERATOR::SetPosition moves the pattern: its origin and end shift, Update re-tunes it on the track there
    set: (n, v) => { const o = xyOf(n, "origin"); if (!o) return false; const d = (v as number) - o[i - 1]; setXy(n, "origin", i, o[i - 1] + d); const e = xyOf(n, "end"); if (e) setXy(n, "end", i, e[i - 1] + d); } });
  const layers = (n: SNode): string[] => { const l = h.kid(n, "layers"); if (l) return l.slice(1).map((x) => h.str(x)); const s = h.kid(n, "layer"); return s ? [h.str(s[1])] : []; };
  const defs: PropDef[] = [
    pos("Position X", 1), pos("Position Y", 2),
    { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, true), get: (x) => strKid(x.node, "layer") || "F.Cu", set: (n, v) => { h.setLayer(n, String(v)); },
      member: (n, v) => { const l = h.kid(n, "layers"); if (l) { const rest = l.slice(2); l.splice(1, l.length - 1, String(v), ...rest); return; } h.setLayer(n, String(v)); } },
    lockedProp(),
    { group: BASIC, name: "Width", type: "length", get: (x) => { const t = firstTrack(x); return t ? h.num((h.kid(t.node, "width") || [])[1], 0.25) : numKid(x.node, "last_track_width", 0.25); },
      set: (n, v) => { if (!((v as number) > 0)) return false; setNum(n, "last_track_width", v as number); }, member: (n, v) => { if (!((v as number) > 0)) return false; h.setWidth(n, v as number); } },
    { group: BASIC, name: "Net", type: "enum", choices: nets, get: (x) => { const t = firstTrack(x); return t ? h.netNameOf(doc, t.node) || "" : ""; },
      set: (n, v) => { const c = h.kid(n, "last_netname"); if (c) c.splice(1, c.length - 1, String(v || "")); }, member: (n, v) => { if (h.netNameOf(doc, n) === String(v || "")) return false; setNet(doc, n, String(v || "")); } },
    { group: TL, name: "Soldermask", type: "bool", get: (x) => { const t = firstTrack(x); return t ? layers(t.node).some((l) => /\.Mask$/.test(l)) : true; }, set: () => true,
      member: (n, v) => { const ls = layers(n); const cu = ls.find((l) => /\.Cu$/.test(l)) || ls[0]; if (!cu) return false; const mask = cu === "F.Cu" ? "F.Mask" : cu === "B.Cu" ? "B.Mask" : ""; if (!mask) return false;
        h.delKid(n, "layer"); h.delKid(n, "layers"); h.setKid(n, v ? "layers" : "layer", v ? [cu, mask] : [cu], ["solder_mask_margin", "net", "uuid", "tstamp"]); } },
    { group: TL, name: "Soldermask Margin Override", type: "length", get: (x) => { const t = firstTrack(x), c = t && h.kid(t.node, "solder_mask_margin"); return c ? h.num(c[1]) : null; }, set: () => true,
      member: (n, v) => { if (v === null || v === "" || Number.isNaN(v as number)) h.delKid(n, "solder_mask_margin"); else h.setKid(n, "solder_mask_margin", [r6(v as number)], ["net", "uuid", "tstamp"]); } },
    { group: PT, name: "End X", type: "coord", get: (x) => (xyOf(x.node, "end") || [0, 0])[0], set: (n, v) => setXy(n, "end", 1, v as number) },
    { group: PT, name: "End Y", type: "coord", get: (x) => (xyOf(x.node, "end") || [0, 0])[1], set: (n, v) => setXy(n, "end", 2, v as number) },
    { group: PT, name: "Tuning Mode", type: "enum", choices: TUNING_MODES, get: (x) => mode(x) },   // NO_SETTER
    { group: PT, name: "Min Amplitude", type: "length", get: (x) => numKid(x.node, "min_amplitude", 0.2), set: (n, v) => setNum(n, "min_amplitude", v as number) },
    { group: PT, name: "Max Amplitude", type: "length", get: (x) => numKid(x.node, "max_amplitude", 1), set: (n, v) => setNum(n, "max_amplitude", v as number) },
    { group: PT, name: "Initial Side", type: "enum", choices: MEANDER_SIDES, get: (x) => strKid(x.node, "initial_side") || "default", set: (n, v) => { const c = h.kid(n, "initial_side"); if (c) c.splice(1, c.length - 1, String(v)); else h.setKid(n, "initial_side", [String(v)], ["members"]); } },
    { group: PT, name: "Min Spacing", type: "length", get: (x) => numKid(x.node, "min_spacing", 0.6), set: (n, v) => setNum(n, "min_spacing", v as number) },
    { group: PT, name: "Corner Radius %", type: "int", get: (x) => numKid(x.node, "corner_radius_percent", 80), set: (n, v) => setNum(n, "corner_radius_percent", Math.round(v as number)) },
  ];
  // SetAvailableFunc: Target Length (length, space domain), Target Delay (time domain), Target Skew / Target Skew Delay (skew)
  const skew = mode(it) === "diff_pair_skew", td = timeDomain(it);
  const target = (name: string, key: string, type: PropType): PropDef => ({ group: PT, name, type, get: (x) => numKid(x.node, key, null),
    set: (n, v) => { const o = v as number; setNum(n, key, o); setNum(n, key + "_min", o - 0.1); setNum(n, key + "_max", o + 0.1); } });   // DEFAULT_LENGTH_TOLERANCE
  if (!skew && !td) defs.push(target("Target Length", "target_length", "length"));
  if (!skew && td) defs.push(target("Target Delay", "target_delay", "number"));
  if (skew && !td) defs.push(target("Target Skew", "target_skew", "coord"));
  if (skew && td) defs.push(target("Target Skew Delay", "target_skew_delay", "number"));
  defs.push(
    { group: PT, name: "Override Custom Rules", type: "bool", get: (x) => yn(x.node, "override_custom_rules", false), set: (n, v) => setYn(n, "override_custom_rules", !!v) },
    { group: PT, name: "Single-sided", type: "bool", get: (x) => yn(x.node, "single_sided", false), set: (n, v) => setYn(n, "single_sided", !!v) },
    { group: PT, name: "Rounded", type: "bool", get: (x) => yn(x.node, "rounded", true), set: (n, v) => setYn(n, "rounded", !!v) });
  return defs;
}
function pcbProps(it: KItem, doc: KDoc, single: boolean): PropDef[] {
  const h = H();
  if (it.kind === "generated" && h.str((h.kid(it.node, "type") || [])[1]) === "tuning_pattern") return tuningPatternProps(it, doc);
  switch (it.kind) {
    case "footprint": return footprintProps(it, doc, single);
    case "segment": case "arc": return [xyProp(BASIC, "Start X", "start", 1), xyProp(BASIC, "Start Y", "start", 2), xyProp(BASIC, "End X", "end", 1), xyProp(BASIC, "End Y", "end", 2),
      { group: BASIC, name: "Width", type: "length", get: (x) => h.num((h.kid(x.node, "width") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setWidth(n, v as number); } },
      layerProp(doc, true, "F.Cu"), lockedProp(), ...netProps(doc)];
    case "via": return viaProps(doc);
    case "zone": return zoneProps(it, doc);
    case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": return boardShapeProps(it, doc);
    case "gr_text": return boardTextProps(doc);
    case "gr_text_box": return h.kid(it.node, "start") ? boardTextBoxProps(doc) : boardTextProps(doc).filter((d) => !/^Position|^Orientation/.test(d.name));
    case "dimension": return [layerProp(doc, false, "Dwgs.User"), lockedProp(),
      { group: "Dimension Properties", name: "Value", type: "text", get: (x) => { const t = h.kid(x.node, "gr_text"); return t ? h.str(t[1]) : ""; } }];
    default: {
      const out: PropDef[] = [];
      if (h.kid(it.node, "at")) out.push(atProp("Position X", 1), atProp("Position Y", 2));
      if (h.kid(it.node, "layer")) out.push(layerProp(doc, false, "Dwgs.User"));
      out.push(lockedProp());
      return out;
    }
  }
}

// ---------------------------------------------------------------- the grid
const FRIENDLY: Record<string, string> = { symbol: "Symbol", footprint: "Footprint", wire: "Wire", bus: "Bus", polyline: "Graphic Line", segment: "Track", arc: "Arc", via: "Via", label: "Label", global_label: "Global Label",
  hierarchical_label: "Hierarchical Label", netclass_flag: "Directive Label", directive_label: "Directive Label", text: "Text", gr_text: "Text", text_box: "Text Box", gr_text_box: "Text Box", junction: "Junction", zone: "Zone",
  no_connect: "No-Connect", bus_entry: "Bus Entry", sheet: "Sheet", gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", gr_curve: "Bezier", rectangle: "Rectangle", circle: "Circle",
  bezier: "Bezier", rule_area: "Rule Area", dimension: "Dimension", group: "Group", image: "Image", table: "Table" };
const friendly = (it: KItem) => (it.kind === "arc" && it.docType === "pcb" ? "Track" : it.kind === "generated" ? "Tuning Pattern" : FRIENDLY[it.kind] || it.kind);

function trimNum(v: number, digits: number): string { let t = v.toFixed(digits); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, ""); return t === "-0" ? "0" : t; }
/** A coordinate row's axis (PROPERTY::SetCoordType ABS_X_COORD / ABS_Y_COORD): "Position X", "Start Y", "End X" … */
function coordAxis(def: PropDef): "x" | "y" | null { return def.type !== "coord" ? null : / X$/.test(def.name) ? "x" : / Y$/.test(def.name) ? "y" : null; }
function show(def: PropDef, raw: Raw): string {
  if (raw === null || raw === undefined) return "";
  const ax = coordAxis(def);   // PGPropertyFactory: board coordinates through the frame's ORIGIN_TRANSFORMS
  if (ax) return H().formatLength(toDisplayAbsAxis(raw as number, ax), String(E.units || "mm"));
  switch (def.type) {
    case "length": case "coord": return H().formatLength(raw as number, String(E.units || "mm"));
    case "angle": return trimNum(raw as number, 4) + "°";
    case "time": return trimNum(raw as number, 4) + " ps";   // PGPROPERTY_TIME in the frame's time unit
    case "number": return trimNum(raw as number, 6);
    case "int": return String(Math.round(raw as number));
    case "bool": return raw ? "1" : "0";
    default: return String(raw);
  }
}
function defsOf(it: KItem, doc: KDoc, single: boolean): PropDef[] { try { return isSchDoc() ? schProps(it, doc).concat(customPropDefs(it)) : pcbProps(it, doc, single).concat(it.kind === "generated" ? [] : customPropDefs(it)); } catch (e) { console.warn(e); return []; } }
const defId = (d: PropDef) => d.group + "/" + d.name;

interface Resolved { items: KItem[]; defs: Map<string, PropDef>[]; shared: PropDef[] }
/** A selected tuning pattern is its generator with its members: KiCad's selection holds the one PCB_GENERATOR. */
function patternSelection(items: KItem[]): KItem | null {
  const P = pcbTools(); if (isSchDoc() || !P || !P.selectedTuningPattern || items.length < 1) return null;
  try { return P.selectedTuningPattern(tctx(), items.map((it) => it.id)); } catch (e) { return null; }
}
function resolve(): Resolved {
  const doc = kdoc(); let items = selectedItems(); if (!doc || !items.length) return { items: [], defs: [], shared: [] };
  const gen = patternSelection(items); if (gen) items = [gen];
  const defs = items.map((it) => new Map(defsOf(it, doc, items.length === 1).map((d): [string, PropDef] => [defId(d), d])));
  const shared: PropDef[] = [];
  for (const d of defs[0].values()) if (defs.every((m) => { const o = m.get(defId(d)); return !!o && o.type === d.type; })) shared.push(d);
  return { items, defs, shared };
}

export function propGrid(): PropGrid {
  const doc = kdoc();
  if (!doc) return { title: "No objects selected", count: 0, groups: [], readOnly: true };
  const { items, defs, shared } = resolve(); const ro = !!E.viewOnly;
  if (!items.length && E.selPins.length && isSchDoc()) { const g = pinGrid(doc); if (g) return g; }
  if (!items.length) { const pads = selectedPads(); if (pads.length) return padGrid(doc, pads, ro); }
  if (!items.length) return { title: "No objects selected", count: 0, groups: [], readOnly: ro };
  const groups: PropGroup[] = [];
  for (const d of shared) {
    const id = defId(d); let value = "", mixed = false, first = true, writable = true;
    items.forEach((it, i) => {
      const own = defs[i].get(id)!; if ((!own.set && !own.local) || (own.canWrite && !own.canWrite(it))) writable = false;
      let raw: Raw = null; try { raw = own.get(it); } catch (e) { raw = null; }
      const text = show(own, raw);
      if (first) { value = text; first = false; } else if (text !== value) mixed = true;
    });
    const row: PropRow = { id, name: d.name, type: d.type, value: mixed ? "" : value, mixed, readOnly: ro || !writable, choices: d.choices };
    if (d.key && !ro && items.length === 1) row.keyEditable = true;   // isKeyEditable looks at the front item
    let g = groups.find((x) => x.name === d.group); if (!g) { g = { name: d.group, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }
  // PROPERTIES_PANEL::rebuildProperties: the Custom Properties group always shows (its "+" button is the way to add
  // one); the category buttons are PCB_PROPERTIES_PANEL's / SCH_PROPERTIES_PANEL's "Add Custom Property" and "Add
  // Field" (a field goes on the selected footprints, or the selected symbols and sheets)
  if (!(items.length === 1 && items[0]!.kind === "generated")) {
    if (!groups.some((g) => g.name === CUSTOM_GROUP)) groups.push({ name: CUSTOM_GROUP, rows: [] });
    const fieldKinds = isSchDoc() ? ["symbol", "sheet"] : ["footprint"];
    for (const g of groups) {
      if (ro) break;
      if (g.name === CUSTOM_GROUP) g.add = "Add Custom Property";
      else if (g.name === "Fields" && items.some((it) => fieldKinds.includes(it.kind))) g.add = "Add Field";
    }
  }
  const kinds = new Set(items.map(friendly));
  const title = items.length === 1 ? friendly(items[0]) : `${items.length} objects selected`;
  return { title, count: items.length, groups, readOnly: ro, note: items.length > 1 && kinds.size > 1 ? Array.from(kinds).join(", ") : undefined };
}

/** Selected bare pins (SCH_PIN_T): SCH_PIN's rows, all read-only in the schematic editor; a row whose value differs
 *  between the pins shows blank (mixed), as PROPERTIES_PANEL does for a multiple selection. */
function pinGrid(doc: KDoc): PropGrid | null {
  const T = window.CollabTools.sch && window.CollabTools.sch._ as unknown as { pinProperties?(d: KDoc, r: unknown): { name: string; type: PropType; value: string | number; choices?: [string, string][] }[] | null };
  if (!T || !T.pinProperties) return null;
  const all = (E.selPins as unknown[]).map((p) => T.pinProperties!(doc, p)).filter((r): r is NonNullable<typeof r> => !!r); if (!all.length) return null;
  const text = (r: { type: PropType; value: string | number }) => (r.type === "length" ? H().formatLength(r.value as number, String(E.units || "mm")) : String(r.value));
  const out: PropRow[] = all[0].filter((r) => all.every((rows) => rows.some((q) => q.name === r.name))).map((r) => {
    const vals = all.map((rows) => text(rows.find((q) => q.name === r.name)!)); const mixed = vals.some((v) => v !== vals[0]);
    return { id: BASIC + "/" + r.name, name: r.name, type: r.type, mixed, readOnly: true, choices: r.choices, value: mixed ? "" : vals[0] };
  });
  return { title: all.length === 1 ? "Pin" : `${all.length} objects selected`, count: all.length, groups: [{ name: BASIC, rows: out }], readOnly: true };
}

/** Parse the text of a row into the raw value its setter takes; a string return is the error to show. */
function parse(def: PropDef, text: string): { v: Raw } | string {
  const t = String(text);
  if (def.optional && !t.trim()) return { v: null };   // std::optional: an empty cell clears the value
  switch (def.type) {
    case "length": case "coord": { const v = H().evalExpr(t, String(E.units || "mm")); if (Number.isNaN(v)) return "Not a valid length"; if (def.type === "length" && v < 0) return "Must not be negative"; const ax = coordAxis(def); return { v: ax ? r6(fromDisplayAbsAxis(v, ax)) : v }; }
    case "angle": { const v = H().evalExpr(t.replace(/°|deg/gi, ""), ""); if (Number.isNaN(v)) return "Not a valid angle"; return { v }; }
    case "number": { const v = H().evalExpr(t, ""); if (Number.isNaN(v)) return "Not a valid number"; return { v }; }
    case "time": { const m = /^\s*(.*?)\s*(fs|ps|ns)?\s*$/i.exec(t)!; const v = H().evalExpr(m[1], ""); if (Number.isNaN(v)) return "Not a valid time"; const u = (m[2] || "ps").toLowerCase(); return { v: u === "fs" ? v / 1000 : u === "ns" ? v * 1000 : v }; }
    case "int": { const v = H().evalExpr(t, ""); if (Number.isNaN(v)) return "Not a valid number"; return { v: Math.round(v) }; }
    case "bool": return { v: t === "1" || t === "true" };
    case "enum": if (def.choices && !def.choices.some((c) => c[0] === t)) return "Not one of the choices"; return { v: t };
    case "color": if (t && !/^#[0-9a-f]{6}$/i.test(t)) return "Not a colour"; return { v: t };
    default: return { v: t };
  }
}

const SYNCED = new Set(["Value", "Exclude From Board", "Exclude From Bill of Materials", "Exclude From Position Files", "Do not Populate", "Pin Map Mode", "Pin Map Name"]);
export function setProp(id: string, text: string): string | null {
  const doc = kdoc(); if (!doc) return "No document";
  if (E.viewOnly) return "View-only access";
  const { items, defs } = resolve();
  if (!items.length) { const pads = selectedPads(); if (pads.length) return setPadProp(doc, pads, id, text); }
  if (!items.length) return "Nothing selected";
  const head = defs[0].get(id); if (!head) return "No such property";
  const parsed = parse(head, text); if (typeof parsed === "string") return parsed;
  if (head.local) { items.forEach((it, i) => { const d = defs[i].get(id); if (d && d.local) d.local(parsed.v, it); }); panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); return null; }
  const gen = items.length === 1 && items[0].kind === "generated" ? items[0] : null; const P = pcbTools();
  if (gen && P && P.editTuningPattern) {   // PCB_TUNING_PATTERN: the property, then EditStart / Update / EditFinish in one commit
    const d = defs[0].get(id); if (!d || !d.set) return null;
    let cur: Raw = null; try { cur = d.get(gen); } catch (e) { cur = null; }
    if (show(d, cur) === show(d, parsed.v) && d.type !== "bool") return null;
    const node = K().cloneNode(gen.node); if (d.set(node, parsed.v, gen) === false) return null;
    P.editTuningPattern(tctx(), gen, node, d.member ? (n: SNode) => d.member!(n, parsed.v) : null);
    panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
    return null;
  }
  const changes: KChange[] = [], nodes: SNode[] = [];
  items.forEach((it, i) => {
    const d = defs[i].get(id); if (!d || !d.set) return;
    let cur: Raw = null; try { cur = d.get(it); } catch (e) { cur = null; }
    if (show(d, cur) === show(d, parsed.v) && d.type !== "bool") return;                 // unchanged: no op for this item
    if (d.type === "bool" && !!cur === !!parsed.v) return;
    const node = K().cloneNode(it.node);
    let res: boolean | void;
    try { res = d.set(node, parsed.v, it); } catch (e) { console.warn(e); return; }
    if (res === false) return;
    changes.push(K().replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }))); nodes.push(node);
  });
  if (!changes.length) return null;
  // SCH_SYMBOL::SyncOtherUnits( …, aProperty ): these properties follow to the other units of a multi-unit part
  if (items.length === 1 && items[0].kind === "symbol" && SYNCED.has(head.name)) {
    const node = nodes[0], ctx = tctx() as unknown as ToolCtx & { doc: KDoc };
    if (node) { commitWithOtherUnits(Object.assign(ctx, { doc }), items[0], node, changes, head.name.toLowerCase(), head.name); panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); return null; }
  }
  tctx().commit(changes, head.name.toLowerCase());
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return null;
}


// ---------------------------------------------------------------- the label column (PCB_PROPERTIES_PANEL key editing)
/** isKeyNameInUse: the front item already has a property of that name (a built-in one, a field or a custom one). */
function keyNameInUse(name: string): boolean {
  const doc = kdoc(); const { items } = resolve(); if (!doc || !items.length) return false;
  return defsOf(items[0]!, doc, items.length === 1).some((d) => d.name === name);
}
/** The commit of an edit that applies `fn` to a clone of every selected item it changes. */
function commitEach(label: string, fn: (node: SNode, it: KItem) => boolean): boolean {
  const doc = kdoc(); if (!doc || E.viewOnly) return false;
  const { items } = resolve(); const changes: KChange[] = [];
  for (const it of items) { const node = K().cloneNode(it.node); if (!fn(node, it)) continue; changes.push(K().replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }))); }
  if (!changes.length) return false;
  tctx().commit(changes, label);
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return true;
}
/**
 * onLabelEditEnding / onKeyRenamed: rename a footprint field or a custom property on every selected item ("Rename
 * Property").  An empty name, or one the item already uses, is refused (the label goes back); a property that was
 * just added and is left so is removed again (onNewItemLeftBlank).  Returns whether the rename happened.
 */
export function renamePropKey(id: string, newName: string, pending: boolean): boolean {
  const slash = id.indexOf("/"); const group = id.slice(0, slash), oldName = id.slice(slash + 1);
  const name = newName.trim() === "" ? "" : newName;
  if (name === oldName && !pending) return false;
  if (!name || (name !== oldName && keyNameInUse(name))) { if (pending) removePropKey(id); return false; }
  if (name === oldName) return false;
  const h = H();
  return commitEach("Rename Property", (n) => {
    if (group === "Fields") {
      const mand = mandatoryOf(n); if (!mand || mand.includes(oldName)) return false;
      const f = h.kids(n, "property").find((p) => h.str(p[1]) === oldName); if (!f) return false; f[1] = name; return true;
    }
    const kv = customProps(n).find((q) => q[0] === oldName); if (!kv) return false;
    removeCustomProp(n, oldName); setCustomProp(n, name, kv[1]); return true;
  });
}
/** removeField / removeCustomProperty ("Remove Field" deletes the field outright, not just hides it). */
export function removePropKey(id: string): boolean {
  const slash = id.indexOf("/"); const group = id.slice(0, slash), name = id.slice(slash + 1); const h = H();
  if (group === "Fields") return commitEach("Remove Field", (n) => {
    const mand = mandatoryOf(n); if (!mand || mand.includes(name)) return false;
    const i = n.findIndex((c) => Array.isArray(c) && c[0] === "property" && h.str(c[1]) === name); if (i < 0) return false; n.splice(i, 1); return true;
  });
  return commitEach("Remove Custom Property", (n) => removeCustomProp(n, name));
}
/** A new field goes after the item's last field (m_fields.push_back), else ahead of its pins, instances and custom properties. */
function insertSchField(n: SNode, f: SNode): void {
  const props = H().kids(n, "property"); const last = props[props.length - 1];
  if (last) { n.splice(n.indexOf(last) + 1, 0, f); return; }
  const at = n.findIndex((c, i) => i > 0 && Array.isArray(c) && (c[0] === "pin" || c[0] === "instances" || c[0] === "custom_property"));
  if (at > 0) n.splice(at, 0, f); else n.push(f);
}
/** The first free placeholder: GetUserFieldName( n ) = "Field<n>" for a field, "Property<n>" for a custom property. */
export function freeKeyName(taken: (name: string) => boolean, kind: "field" | "custom"): string {
  for (let n = 0; ; n++) { const name = (kind === "field" ? "Field" : "Property") + n; if (!taken(name)) return name; }
}
/**
 * addBlankField / addBlankCustomProperty: a hidden empty field on every selected footprint (PCB_FIELD( footprint,
 * USER, name ): on the silkscreen of the footprint's side at its anchor), or an empty custom property on every
 * selected item; returns the new row's id, whose label the panel then edits from blank.
 */
export function addPropKey(kind: "field" | "custom"): string | null {
  const { items } = resolve(); if (!items.length || E.viewOnly) return null; const h = H();
  if (kind === "field") {
    const sch = isSchDoc(), kinds = sch ? ["symbol", "sheet"] : ["footprint"];
    const fps = items.filter((it) => kinds.includes(it.kind)); if (!fps.length) return null;
    const name = freeKeyName((nm) => fps.some((it) => h.kids(it.node, "property").some((p) => h.str(p[1]) === nm)), "field");
    const ok = commitEach("Add Field", (n) => {
      if (sch) {   // SCH_FIELD( parent, USER / SHEET_USER, name ) with SetVisible( false ): at the origin, the default text size
        if (n[0] !== "symbol" && n[0] !== "sheet") return false;
        insertSchField(n, ["property", name, "", ["at", 0, 0, 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]);
        return true;
      }
      if (n[0] !== "footprint") return false;
      const back = h.str((h.kid(n, "layer") || [])[1]) === "B.Cu";
      const font: SNode = ["font", ["size", 1.27, 1.27]];
      const eff: SNode = back ? ["effects", font, ["justify", "mirror"]] : ["effects", font];
      const f: SNode = ["property", name, "", ["at", 0, 0, 0], ["layer", back ? "B.SilkS" : "F.SilkS"], ["hide", "yes"], ["uuid", K().newUuid()], eff];
      const last = h.kids(n, "property").pop(); n.splice(last ? n.indexOf(last) + 1 : n.length, 0, f); return true;
    });
    return ok ? "Fields/" + name : null;
  }
  const name = freeKeyName((nm) => items.some((it) => customProps(it.node).some((q) => q[0] === nm)), "custom");
  const ok = commitEach("Add Custom Property", (n) => { setCustomProp(n, name, ""); return true; });
  return ok ? CUSTOM_GROUP + "/" + name : null;
}
