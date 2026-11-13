// symedit/props.ts — the Symbol Editor's Properties panel model: SCH_PROPERTIES_PANEL over PROPERTY_MANAGER's
// registrations for the library items (eeschema/sch_item.cpp SCH_ITEM_DESC, sch_pin.cpp SCH_PIN_DESC,
// sch_shape.cpp / common/eda_shape.cpp SCH_SHAPE_DESC / EDA_SHAPE_DESC, sch_text.cpp, sch_textbox.cpp,
// sch_field.cpp, common/eda_text.cpp EDA_TEXT_DESC) and LIB_SYMBOL_DESC (lib_symbol.cpp) for the symbol itself,
// which the panel shows when nothing is selected (SCH_PROPERTIES_PANEL::UpdateData falls back to GetCurSymbol).
// DOM-free: the node tests run it.  Values are canonical strings: lengths in mm, coordinates in eeschema's
// internal axes (Y down, the file's library Y negated), booleans "1" / "0", enums by their choice key.
import { isList, kid, kids, num, str } from "../canvas/sexpr";
import * as M from "./model";
import * as L from "../dialogs/sch-items-logic";

type Node = M.Node;
export type SPType = "text" | "length" | "coord" | "int" | "bool" | "enum";
export interface SPRow { group: string; name: string; type: SPType; value: string; choices?: [string, string][]; readOnly?: boolean }
export interface SPItem { node: Node; unit: number; body: number }

export const BASIC = "Basic Properties";
export const SHAPE_PROPS = "Shape Properties";
export const TEXT_PROPS = "Text Properties";

const b = (v: boolean): string => (v ? "1" : "0");
const n4 = (v: number): string => M.fmt(v);
const fy = (y: number): number => (y ? -y : 0);   // file Y up <-> internal Y down

/** PROPERTY_ENUM maps (ElectricalPinTypeGetText, PinShapeGetText, PinOrientationName, SHAPE_T, LINE_STYLE, FILL_T). */
export const ORIENT_CHOICES: [string, string][] = M.PIN_ORIENTATIONS.map(([a, l]) => [String(a), l]);
export const SHAPE_NAMES: Record<string, string> = { rectangle: "Rectangle", circle: "Circle", arc: "Arc", polyline: "Polygon", bezier: "Bezier", ellipse: "Ellipse", ellipse_arc: "Elliptical Arc" };
export const LINE_STYLE_CHOICES: [string, string][] = [["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
export const FILL_MODE_CHOICES: [string, string][] = [["none", "None"], ["outline", "Body outline color"], ["background", "Body background color"], ["color", "Fill color"], ["hatch", "Hatch"], ["reverse_hatch", "Reverse hatch"], ["cross_hatch", "Cross hatch"]];
export const H_JUST: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
export const V_JUST: [string, string][] = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];

/** The caption PROPERTIES_PANEL shows for one item (GetFriendlyName). */
export function friendlyName(n: Node): string {
  const k = String(n[0]);
  if (k === "pin") return "Pin";
  if (k === "property") return "Field";
  if (k === "text") return "Text";
  if (k === "text_box") return "Text Box";
  return SHAPE_NAMES[k] || k;
}

// ---------------------------------------------------------------- SCH_ITEM: Unit, Body Style, Private
const isPrivate = (n: Node): boolean => n[1] === "private";
function setPrivate(n: Node, on: boolean): void { if (on === isPrivate(n)) return; if (on) n.splice(1, 0, "private"); else n.splice(1, 1); }
/** SCH_ITEM's Unit choices: "All units", then GetUnitDisplayName( ii, false ) (the unit name, else its letter). */
export function unitChoices(root: Node): [string, string][] {
  const names = M.unitNames(root); const out: [string, string][] = [["0", "All units"]];
  for (let u = 1; u <= M.unitCount(root); u++) out.push([String(u), names.get(u) || M.unitLetter(u)]);
  return out;
}
export function bodyChoices(root: Node): [string, string][] {
  const out: [string, string][] = [["0", "All body styles"]]; const bs = M.bodyStyles(root);
  for (let i = 1; i <= bs.count; i++) out.push([String(i), M.bodyStyleDescription(root, i)]);
  return out;
}
function itemRowsBase(root: Node, it: SPItem, withPrivate: boolean): SPRow[] {
  const out: SPRow[] = [];
  if (M.unitCount(root) > 1) out.push({ group: BASIC, name: "Unit", type: "enum", value: String(it.unit), choices: unitChoices(root) });
  if (M.bodyStyles(root).count > 1) out.push({ group: BASIC, name: "Body Style", type: "enum", value: String(it.body), choices: bodyChoices(root) });
  if (withPrivate) out.push({ group: BASIC, name: "Private", type: "bool", value: b(isPrivate(it.node)) });
  return out;
}

// ---------------------------------------------------------------- per kind
function pinRows(it: SPItem): SPRow[] {
  const i = M.pinInfo(it.node);
  return [
    { group: BASIC, name: "Pin Name", type: "text", value: i.name },
    { group: BASIC, name: "Pin Number", type: "text", value: i.number },
    { group: BASIC, name: "Electrical Type", type: "enum", value: i.type, choices: M.PIN_TYPES },
    { group: BASIC, name: "Graphic Style", type: "enum", value: i.shape, choices: M.PIN_SHAPES },
    { group: BASIC, name: "Position X", type: "coord", value: n4(i.x) },
    { group: BASIC, name: "Position Y", type: "coord", value: n4(fy(i.y)) },
    { group: BASIC, name: "Orientation", type: "enum", value: String(i.orient), choices: ORIENT_CHOICES },
    { group: BASIC, name: "Length", type: "length", value: n4(i.length) },
    { group: BASIC, name: "Name Text Size", type: "length", value: n4(i.nameSize) },
    { group: BASIC, name: "Number Text Size", type: "length", value: n4(i.numSize) },
    { group: BASIC, name: "Visible", type: "bool", value: b(i.visible) },
  ];
}
const pt = (n: Node, k: string): [number, number] | null => { const c = kid(n, k); return c ? [num(c[1]), num(c[2])] : null; };
function firstPt(n: Node): [number, number] | null { const p = kid(n, "pts"); const xy = p ? kids(p, "xy")[0] : null; return xy ? [num(xy[1]), num(xy[2])] : null; }
function strokeFill(n: Node, kind: string): SPRow[] {
  const st = L.readStroke(n as unknown as SNode); const f = kid(n, "fill"), ft = f && kid(f, "type");
  const out: SPRow[] = [
    { group: SHAPE_PROPS, name: "Line Width", type: "length", value: n4(st.width) },
    { group: SHAPE_PROPS, name: "Line Style", type: "enum", value: st.style === "default" ? "solid" : st.style, choices: LINE_STYLE_CHOICES },
  ];
  if (kind !== "text_box" || f) out.push({ group: SHAPE_PROPS, name: "Fill Mode", type: "enum", value: ft ? str(ft[1]) : "none", choices: FILL_MODE_CHOICES });
  return out;
}
function shapeRows(n: Node): SPRow[] {
  const k = String(n[0]); const out: SPRow[] = [];
  if (k !== "text_box") out.push({ group: SHAPE_PROPS, name: "Shape", type: "enum", value: k, choices: Object.entries(SHAPE_NAMES), readOnly: true });
  if (k === "polyline" || k === "bezier" || k === "ellipse" || k === "ellipse_arc") {
    const p = k.startsWith("ellipse") ? pt(n, "center") : firstPt(n);
    if (p) out.push({ group: SHAPE_PROPS, name: "Position X", type: "coord", value: n4(p[0]) }, { group: SHAPE_PROPS, name: "Position Y", type: "coord", value: n4(fy(p[1])) });
  }
  if (k === "rectangle" || k === "arc") {
    const s = pt(n, "start"), e = pt(n, "end");
    if (s && e) out.push({ group: SHAPE_PROPS, name: "Start X", type: "coord", value: n4(s[0]) }, { group: SHAPE_PROPS, name: "Start Y", type: "coord", value: n4(fy(s[1])) },
      { group: SHAPE_PROPS, name: "End X", type: "coord", value: n4(e[0]) }, { group: SHAPE_PROPS, name: "End Y", type: "coord", value: n4(fy(e[1])) });
    if (s && e && k === "rectangle") out.push({ group: SHAPE_PROPS, name: "Width", type: "coord", value: n4(e[0] - s[0]) }, { group: SHAPE_PROPS, name: "Height", type: "coord", value: n4(fy(e[1] - s[1])) });
  }
  if (k === "text_box") {
    const a = kid(n, "at"), sz = kid(n, "size");
    if (a && sz) out.push({ group: SHAPE_PROPS, name: "Start X", type: "coord", value: n4(num(a[1])) }, { group: SHAPE_PROPS, name: "Start Y", type: "coord", value: n4(fy(num(a[2]))) },
      { group: SHAPE_PROPS, name: "End X", type: "coord", value: n4(num(a[1]) + num(sz[1])) }, { group: SHAPE_PROPS, name: "End Y", type: "coord", value: n4(fy(num(a[2]) + num(sz[2]))) });
  }
  if (k === "circle") {
    const c = pt(n, "center"), r = kid(n, "radius");
    if (c) out.push({ group: SHAPE_PROPS, name: "Center X", type: "coord", value: n4(c[0]) }, { group: SHAPE_PROPS, name: "Center Y", type: "coord", value: n4(fy(c[1])) });
    if (r) out.push({ group: SHAPE_PROPS, name: "Radius", type: "length", value: n4(num(r[1])) });
  }
  return out.concat(strokeFill(n, k));
}
const textOf = (n: Node): string => (String(n[0]) === "property" ? L.fieldValue(n as unknown as SNode) : str(isPrivate(n) ? n[2] : n[1]));
function textRows(n: Node, field: boolean): SPRow[] {
  const fx = L.readFx(n as unknown as SNode);
  const out: SPRow[] = [
    { group: TEXT_PROPS, name: "Text", type: "text", value: textOf(n) },
    { group: TEXT_PROPS, name: "Italic", type: "bool", value: b(fx.italic) },
    { group: TEXT_PROPS, name: "Bold", type: "bool", value: b(fx.bold) },
  ];
  if (field) out.push({ group: TEXT_PROPS, name: "Visible", type: "bool", value: b(!L.isHidden(n as unknown as SNode)) });
  out.push({ group: TEXT_PROPS, name: "Horizontal Justification", type: "enum", value: fx.h, choices: H_JUST },
    { group: TEXT_PROPS, name: "Vertical Justification", type: "enum", value: fx.v, choices: V_JUST });
  if (field) {
    const sn = kid(n, "show_name"), na = kid(n, "do_not_autoplace");
    out.push({ group: TEXT_PROPS, name: "Show Field Name", type: "bool", value: b(!!sn && str(sn[1]) !== "no") },
      { group: TEXT_PROPS, name: "Allow Autoplacement", type: "bool", value: b(!(na && str(na[1]) !== "no")) });
  }
  out.push({ group: TEXT_PROPS, name: "Text Size", type: "length", value: n4(fx.size) });
  return out;
}

/** The rows of one selected item, in the panel's order: SCH_ITEM's, then the kind's own. */
export function itemRows(root: Node, it: SPItem): SPRow[] {
  const k = String(it.node[0]);
  if (k === "pin") return itemRowsBase(root, it, false).concat(pinRows(it));
  if (k === "property") {
    const name = L.fieldName(it.node as unknown as SNode);
    return (M.MANDATORY_FIELDS.includes(name) ? [] : [{ group: BASIC, name: "Private", type: "bool" as SPType, value: b(isPrivate(it.node)) }]).concat(textRows(it.node, true));
  }
  if (k === "text") return itemRowsBase(root, it, true).concat(textRows(it.node, false));
  if (k === "text_box") return itemRowsBase(root, it, true).concat(shapeRows(it.node), textRows(it.node, false));
  return itemRowsBase(root, it, true).concat(shapeRows(it.node));
}

/** LIB_SYMBOL_DESC's rows: Fields, Symbol Definition, Pin Display, Attributes, Units and Body Styles. */
export function symbolRows(sym: Node, root: Node): SPRow[] {
  const hd = M.symHeader(root); const derived = M.isDerived(sym); const bs = M.bodyStyles(root);
  const out: SPRow[] = [
    { group: "Fields", name: "Reference", type: "text", value: M.fieldValue(sym, "Reference") || M.fieldValue(root, "Reference") },
    { group: "Fields", name: "Value", type: "text", value: M.fieldValue(sym, "Value") },
    { group: "Fields", name: "Footprint", type: "text", value: M.fieldValue(sym, "Footprint") },
    { group: "Fields", name: "Datasheet", type: "text", value: M.fieldValue(sym, "Datasheet") },
    { group: "Fields", name: "Keywords", type: "text", value: M.fieldValue(sym, "ki_keywords") },
    { group: "Symbol Definition", name: "Define as Power Symbol", type: "bool", value: b(hd.power === "global"), readOnly: derived },
    { group: "Symbol Definition", name: "Define as Local Power Symbol", type: "bool", value: b(hd.power === "local"), readOnly: derived },
    { group: "Pin Display", name: "Show Pin Number", type: "bool", value: b(hd.showPinNumbers), readOnly: derived },
    { group: "Pin Display", name: "Show Pin Name", type: "bool", value: b(hd.showPinNames), readOnly: derived },
    { group: "Pin Display", name: "Place Pin Names Inside", type: "bool", value: b(hd.pinNameOffset !== 0), readOnly: derived },
    { group: "Pin Display", name: "Pin Name Position Offset", type: "length", value: n4(hd.pinNameOffset), readOnly: derived },
    { group: "Attributes", name: "Exclude from Simulation", type: "bool", value: b(hd.excludeFromSim), readOnly: derived },
    { group: "Attributes", name: "Exclude from Board", type: "bool", value: b(!hd.onBoard), readOnly: derived },
    { group: "Attributes", name: "Exclude from Bill of Materials", type: "bool", value: b(!hd.inBom), readOnly: derived },
    { group: "Attributes", name: "Exclude from Position Files", type: "bool", value: b(!hd.inPosFiles), readOnly: derived },
    { group: "Units and Body Styles", name: "Number of Symbol Units", type: "int", value: String(M.unitCount(root)), readOnly: derived },
    { group: "Units and Body Styles", name: "Units are Interchangeable", type: "bool", value: b(!M.unitsLocked(root)), readOnly: derived },
  ];
  if (bs.count > 1) out.push({ group: "Units and Body Styles", name: "Body Styles", type: "enum", value: "1", choices: Array.from({ length: bs.count }, (_, i) => [String(i + 1), M.bodyStyleDescription(root, i + 1)] as [string, string]), readOnly: true });
  return out;
}

/** The rows a multiple selection shares (same group, name and type); a value that differs is mixed (""). */
export function sharedRows(lists: SPRow[][]): (SPRow & { mixed: boolean })[] {
  if (!lists.length) return [];
  const key = (r: SPRow) => r.group + "/" + r.name + "/" + r.type;
  return lists[0].filter((r) => lists.every((l) => l.some((o) => key(o) === key(r)))).map((r) => {
    const vals = lists.map((l) => l.find((o) => key(o) === key(r))!.value); const mixed = vals.some((v) => v !== vals[0]);
    return { ...r, value: mixed ? "" : r.value, mixed, readOnly: r.readOnly || lists.some((l) => !!l.find((o) => key(o) === key(r))!.readOnly) };
  });
}

// ---------------------------------------------------------------- setters
const setPt = (n: Node, k: string, x: number | null, y: number | null): void => { const c = kid(n, k); if (!c) return; if (x !== null) c[1] = +n4(x); if (y !== null) c[2] = +n4(y); };
/** Change one property of a selected item in `sym` (a copy); returns the item's node (moved when its unit or body
 *  style changed), or null when the value is refused. */
export function setItemProp(sym: Node, it: SPItem, name: string, value: string): Node | null {
  const n = it.node; const k = String(n[0]); const v = Number(value); const on = value === "1";
  if (name === "Unit" || name === "Body Style") {
    const r = M.findRef(sym, n); if (!r) return null;
    const unit = name === "Unit" ? v : r.unit, body = name === "Body Style" ? v : r.body;
    if (unit === r.unit && body === r.body) return n;
    M.removeDrawItem(sym, r); M.addDrawItem(sym, unit, body, n); return n;
  }
  if (name === "Private") { setPrivate(n, on); return n; }
  if (k === "pin") {
    const i = M.pinInfo(n);
    switch (name) {
      case "Pin Name": i.name = value; break;
      case "Pin Number": i.number = value; break;
      case "Electrical Type": i.type = value; break;
      case "Graphic Style": i.shape = value; break;
      case "Position X": i.x = v; break;
      case "Position Y": i.y = fy(v); break;
      case "Orientation": i.orient = v; break;
      case "Length": if (v < 0) return null; M.changeLength(i, v); break;   // SCH_PIN::ChangeLength
      case "Name Text Size": if (v < 0) return null; i.nameSize = v; break;
      case "Number Text Size": if (v < 0) return null; i.numSize = v; break;
      case "Visible": i.visible = on; break;
      default: return null;
    }
    M.setPin(n, i); return n;
  }
  const sn = n as unknown as SNode;
  switch (name) {
    case "Line Width": if (v < 0) return null; L.writeStroke(sn, { width: v }); return n;
    case "Line Style": L.writeStroke(sn, { style: value }); return n;
    case "Fill Mode": { const f = kid(n, "fill"); if (f) L.put(f as unknown as SNode, "type", [value], ["color"]); else L.put(sn, "fill", [["type", value]], ["effects", "uuid"]); return n; }
    case "Text": if (k === "property") { const i = isPrivate(n) ? 3 : 2; n[i] = value; } else { const i = isPrivate(n) ? 2 : 1; n[i] = value; } return n;
    case "Italic": L.writeFx(sn, { italic: on }); return n;
    case "Bold": L.writeFx(sn, { bold: on }); return n;
    case "Text Size": if (v <= 0) return null; L.writeFx(sn, { size: v }); return n;
    case "Horizontal Justification": L.writeFx(sn, { h: value as "left" }); return n;
    case "Vertical Justification": L.writeFx(sn, { v: value as "top" }); return n;
    case "Visible": L.setHidden(sn, !on); return n;
    case "Show Field Name": L.put(sn, "show_name", [on ? "yes" : "no"], ["do_not_autoplace", "hide", "effects"]); return n;
    case "Allow Autoplacement": L.put(sn, "do_not_autoplace", [on ? "no" : "yes"], ["hide", "effects"]); return n;
  }
  if (k === "circle") {
    if (name === "Center X") setPt(n, "center", v, null); else if (name === "Center Y") setPt(n, "center", null, fy(v));
    else if (name === "Radius") { if (v < 0) return null; const r = kid(n, "radius"); if (r) r[1] = +n4(v); } else return null;
    return n;
  }
  if (k === "text_box") {
    const a = kid(n, "at"), sz = kid(n, "size"); if (!a || !sz) return null;
    const x0 = num(a[1]), y0 = num(a[2]), x1 = x0 + num(sz[1]), y1 = y0 + num(sz[2]);
    const [nx0, ny0, nx1, ny1] = name === "Start X" ? [v, y0, x1, y1] : name === "Start Y" ? [x0, fy(v), x1, y1] : name === "End X" ? [x0, y0, v, y1] : name === "End Y" ? [x0, y0, x1, fy(v)] : [NaN, 0, 0, 0];
    if (Number.isNaN(nx0)) return null;
    a[1] = +n4(nx0); a[2] = +n4(ny0); sz[1] = +n4(nx1 - nx0); sz[2] = +n4(ny1 - ny0); return n;
  }
  if (k === "rectangle" || k === "arc") {
    const s = pt(n, "start"), e = pt(n, "end"); if (!s || !e) return null;
    switch (name) {
      case "Start X": setPt(n, "start", v, null); return n;
      case "Start Y": setPt(n, "start", null, fy(v)); return n;
      case "End X": setPt(n, "end", v, null); return n;
      case "End Y": setPt(n, "end", null, fy(v)); return n;
      case "Width": if (k !== "rectangle") return null; setPt(n, "end", s[0] + v, null); return n;   // SetRectangleWidth
      case "Height": if (k !== "rectangle") return null; setPt(n, "end", null, s[1] - v); return n;
    }
    return null;
  }
  if (name === "Position X" || name === "Position Y") {   // SCH_SHAPE::SetPosition: the shape moves with its first point / centre
    const p = k.startsWith("ellipse") ? pt(n, "center") : firstPt(n); if (!p) return null;
    const dx = name === "Position X" ? v - p[0] : 0, dy = name === "Position Y" ? fy(v) - p[1] : 0;
    M.moveNode(n, dx, dy); return n;
  }
  return null;
}

/** Change one of LIB_SYMBOL's properties on `sym` (a copy); false when refused. */
export function setSymbolProp(sym: Node, name: string, value: string): boolean {
  const on = value === "1"; const v = Number(value);
  const fields: Record<string, string> = { Reference: "Reference", Value: "Value", Footprint: "Footprint", Datasheet: "Datasheet" };
  if (fields[name]) { const p = M.fieldOf(sym, fields[name]); if (!p) return false; p[L.fieldName(p as unknown as SNode) !== str(p[1]) ? 3 : 2] = value; return true; }
  if (name === "Keywords") { M.setMetaField(sym, "ki_keywords", value); return true; }
  if (M.isDerived(sym)) return false;
  const hd = M.symHeader(sym);
  switch (name) {
    case "Define as Power Symbol": hd.power = on ? "global" : hd.power === "global" ? "" : hd.power; break;
    case "Define as Local Power Symbol": hd.power = on ? "local" : hd.power === "local" ? "" : hd.power; break;
    case "Show Pin Number": hd.showPinNumbers = on; break;
    case "Show Pin Name": hd.showPinNames = on; break;
    case "Place Pin Names Inside": hd.pinNameOffset = on ? (hd.pinNameOffset || M.DEFAULT_PIN_NAME_OFFSET) : 0; break;   // SetPinNamesInsideProp
    case "Pin Name Position Offset": if (v < 0) return false; hd.pinNameOffset = v; break;
    case "Exclude from Simulation": hd.excludeFromSim = on; break;
    case "Exclude from Board": hd.onBoard = !on; break;
    case "Exclude from Bill of Materials": hd.inBom = !on; break;
    case "Exclude from Position Files": hd.inPosFiles = !on; break;
    case "Number of Symbol Units": if (!Number.isInteger(v) || v < 1) return false; M.setUnitCount(sym, v); return true;
    case "Units are Interchangeable": {
      const p = M.fieldOf(sym, "ki_locked");
      if (on && p) sym.splice(sym.indexOf(p), 1);
      else if (!on && !p) { let last = 1; for (let j = 1; j < sym.length; j++) if (isList(sym[j]) && (sym[j] as Node)[0] === "property") last = j; sym.splice(last + 1, 0, M.fieldNode("ki_locked", "", 0, 0, false)); }
      return true;
    }
    default: return false;
  }
  M.setSymHeader(sym, hd); return true;
}
