// pcb-tools/dru-eval.ts — what a custom rule condition reads: the item properties PROPERTY_MANAGER registers for each
// board item type (A.Pad_Type, A.Via_Type, A.Library_Link …, names compared without underscores, spaces or case as
// PCBEXPR_UCODE::CreateVarRef does) and the PCBEXPR_BUILTIN_FUNCTIONS (pcbnew/pcbexpr_functions.cpp).
import type { BoardDoc, CopperShape, DesignSettings, Pt, SAtom } from "./types";
import { arcPoints, dPS, padShape, polyPolyDist, segSegDist, shapeBBox, shapeGap, shapeOffset, shapeSegs, rectCore } from "./distances";
import { pointInPoly } from "./hit";
import { matchDpSuffix } from "./diffpair";
import { courtyards, netclassName } from "./drc";
import { boardNets } from "./changes";
import { netOf } from "./nets";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { isList, layerOf, pt } from "./util";

/** A value of the condition language: a number (mm for lengths), a string (with wildcards when a literal holds * or ?) or undefined. */
/** A LIBEVAL::VALUE: numeric, string, undefined (no such property on the item) or null (an unset optional, or `null`). */
export type Val = { t: "n"; v: number } | { t: "s"; v: string; wild: boolean } | { t: "u" } | { t: "null" };
/** The board item an expression's A / B stands for: its kind, node, the layer the rule is evaluated on and, for a pad or footprint child, its footprint. */
export interface RuleItem { kind: string; node: SNode; layer?: string | null; parent?: KItem | null; item?: KItem | null; shape?: CopperShape | null; id?: string }

/** The item's net name: the node may carry only the net number, which the board's net table names. */
export const netName = (doc: BoardDoc | null, n: SNode) => { const r = netOf(n); return r.name || (r.code > 0 && doc && doc.nets ? String(doc.nets.get(r.code) || "") : ""); };
/** BOARD::FindNet: a net the board declares (its net table) or one an item carries. */
const netExists = (doc: BoardDoc, name: string) => boardNets(doc).some((x) => x.name === name) || (!!doc.nets && [...doc.nets.values()].some((v) => String(v) === name));
const norm = (s: string) => s.replace(/[\s_-]/g, "").toLowerCase();
/** The item property names PROPERTY_MANAGER knows (pcbnew's AddProperty calls), normalised. A name outside them is "Unrecognized property". */
export const KNOWN_PROPS = new Set([
  "Type", "Layer", "Locked", "Parent", "Position X", "Position Y", "Net", "NetName", "Net Name", "Net Code", "NetClass", "Net Class", "Width", "Start X", "Start Y", "End X", "End Y",
  "Diameter", "Hole", "Hole Size", "Layer Top", "Layer Bottom", "Via Type", "Front Tenting", "Back Tenting", "Soldermask", "Soldermask Margin Override", "Automatically Update Net",
  "Pad Type", "Pad Shape", "Pad Number", "Pin Name", "Pin Type", "Size X", "Size Y", "Hole Size X", "Hole Size Y", "Hole Shape", "Fabrication Property", "Orientation", "Corner Radius Ratio",
  "Corner Radius Size", "Clearance Override", "Zone Connection Style", "Thermal Relief Gap", "Thermal Relief Spoke Width", "Thermal Relief Spoke Angle", "Pad To Die Length", "Pad To Die Delay",
  "Copper Layers", "Solderpaste Margin Override", "Solderpaste Margin Ratio Override", "Backdrill Mode",
  "Reference", "Value", "Library Link", "Library Description", "Keywords", "Footprint Type", "Do not Populate", "Exclude From Bill of Materials", "Exclude From Position Files",
  "Exclude From Simulation", "Not in Schematic", "Exempt From Courtyard Requirement", "Component Class", "Height", "Scale X", "Scale Y",
  "Name", "Priority", "Clearance", "Minimum Width", "Pad Connections", "Fill Mode", "Remove Islands", "Minimum Island Area", "Keep Out Tracks", "Keep Out Vias", "Keep Out Pads",
  "Keep Out Zone Fills", "Keep Out Footprints", "Hatch Width", "Hatch Gap", "Hatch Orientation", "Enable",
  "Text", "Thickness", "Bold", "Italic", "Mirrored", "Visible", "Horizontal Justification", "Vertical Justification", "Keep Upright", "Knockout", "Font", "Hyperlink",
  "Shape", "Line Width", "Line Style", "Line Color", "Fill", "Fill Color", "Radius", "Angle", "Center X", "Center Y", "Corner Radius",
  "Max Length", "Max Width", "Best Length Ratio", "Max Width Ratio", "Best Width Ratio", "Enable Teardrops", "Allow Teardrops To Span Two Tracks", "Prefer Zone Connections", "Curved Teardrops",
  "Units", "Precision", "Prefix", "Suffix", "Override Text", "Size",
].map(norm));
/** PCBEXPR_BUILTIN_FUNCTIONS::RegisterAllFunctions (the deprecated aliases included) with how many arguments each takes. */
export const FUNCS: Record<string, number> = {
  existsOnLayer: 1, isPlated: 0, insideCourtyard: 1, insideFrontCourtyard: 1, insideBackCourtyard: 1, intersectsCourtyard: 1, intersectsFrontCourtyard: 1, intersectsBackCourtyard: 1,
  insideArea: 1, intersectsArea: 1, intersectsKeepout: 1, enclosedByArea: 1, isMicroVia: 0, isBlindVia: 0, isBuriedVia: 0, isBlindBuriedVia: 0, isStackedVia: 0,
  memberOf: 1, memberOfGroup: 1, memberOfFootprint: 1, memberOfSheet: 1, memberOfSheetOrChildren: 1, fromTo: 2, isCoupledDiffPair: 0, inDiffPair: 1, inNetChain: 1, hasNetChain: 0,
  inNetChainClass: 1, getField: 1, hasNetclass: 1, hasExactNetclass: 1, hasComponentClass: 1, customProperty: 1, hasCustomProperty: 1,
};
/** The "Missing … argument" message a function reports for an empty argument (PCBEXPR functions' ReportError). */
export const MISSING_ARG: Record<string, string> = {
  existsOnLayer: "Missing layer name argument to existsOnLayer().",
  memberOfGroup: "Missing group name argument to memberOfGroup().", memberOf: "Missing group name argument to memberOfGroup().",
  memberOfFootprint: "Missing footprint argument (reference designator) to memberOfFootprint().",
  memberOfSheet: "Missing sheet name argument to memberOfSheet().", memberOfSheetOrChildren: "Missing sheet name argument to memberOfSheetOrChildren().",
  getField: "Missing field name argument to getField().", inDiffPair: "Missing diff-pair name argument to inDiffPair().",
  hasNetclass: "Missing netclass name argument to hasNetclass().", hasExactNetclass: "Missing netclass name argument to hasExactNetclass().",
  hasComponentClass: "Missing component class name argument to hasComponentClass().",
  intersectsCourtyard: "Missing footprint argument (A, B, or reference designator) to intersectsCourtyard().",
  intersectsFrontCourtyard: "Missing footprint argument (A, B, or reference designator) to intersectsFrontCourtyard().",
  intersectsBackCourtyard: "Missing footprint argument (A, B, or reference designator) to intersectsBackCourtyard().",
  intersectsArea: "Missing rule-area argument (A, B, or rule-area name) to intersectsArea().", enclosedByArea: "Missing rule-area argument (A, B, or rule-area name) to enclosedByArea().",
  intersectsKeepout: "Missing rule-area argument (A, B, or rule-area name) to intersectsKeepout().",
};
/** The lowercase function name to its registered spelling: LIBEVAL looks functions up case-insensitively. */
export const FUNC_BY_LOWER = new Map(Object.keys(FUNCS).map((f) => [f.toLowerCase(), f]));
export const isKnownProp = (name: string) => KNOWN_PROPS.has(norm(name));

const str = (v: string): Val => ({ t: "s", v, wild: false });
const numv = (v: number): Val => ({ t: "n", v });
const U: Val = { t: "u" };
const NUL: Val = { t: "null" };
const bool = (b: boolean): Val => numv(b ? 1 : 0);
const kidv = (n: SNode, k: string, i = 1) => { const c = K.kid(n, k); return c && c[i] !== undefined ? c[i] : undefined; };
const kidStr = (n: SNode, k: string) => { const v = kidv(n, k); return v === undefined ? "" : K.str(v); };
const kidNum = (n: SNode, k: string, i = 1): Val => { const v = kidv(n, k, i); return v === undefined ? U : numv(K.num(v)); };
const yes = (n: SNode, k: string) => { const c = K.kid(n, k); return !!c && (c.length === 1 || K.str(c[1]) === "yes"); };
const fieldOf = (fp: SNode, name: string) => { const ps = (fp as SNode[]).filter((c) => isList(c) && c[0] === "property"); const p = ps.find((c) => K.str(c[1]) === name) || ps.find((c) => K.str(c[1]).toLowerCase() === name.toLowerCase()); return p ? K.str(p[2]) : null; };
/** PCBEXPR_NAV_STEP::PARENT: the item's parent as a rule item (a footprint's children have the footprint; anything
 *  on the board itself, and the footprint, have none). */
export function parentRuleItem(it: RuleItem | null): RuleItem | null {
  if (!it || it.kind === "footprint" || !it.parent) return null;
  const fp = it.parent; return { kind: "footprint", node: fp.node, item: fp, id: fp.id, layer: layerOf(fp.node) || null };
}
const fpOf = (it: RuleItem): KItem | null => it.kind === "footprint" ? (it.item || { id: kidStr(it.node, "uuid"), kind: "footprint", node: it.node } as KItem) : it.parent || null;
const PAD_TYPE: Record<string, string> = { thru_hole: "Through-hole", smd: "SMD", connect: "Edge connector", np_thru_hole: "NPTH, mechanical" };
const PAD_SHAPE: Record<string, string> = { circle: "Circle", rect: "Rectangle", oval: "Oval", trapezoid: "Trapezoid", roundrect: "Rounded rectangle", custom: "Custom" };
const PAD_PROP: Record<string, string> = { pad_prop_bga: "BGA pad", pad_prop_fiducial_glob: "Fiducial, global to board", pad_prop_fiducial_loc: "Fiducial, local to footprint", pad_prop_testpoint: "Test point pad", pad_prop_heatsink: "Heatsink pad", pad_prop_castellated: "Castellated pad", pad_prop_mechanical: "Mechanical pad", pad_prop_pressfit: "Press-fit pad" };
const VIA_TYPE: Record<string, string> = { blind: "Blind", buried: "Buried", micro: "Micro" };
/** The via's type word (PCB_IO_KICAD_SEXPR writes blind / buried / micro after "via"; through is not written). */
export const viaTypeOf = (n: SNode) => { const w = n.slice(1).find((c) => !isList(c)); const s = w === undefined ? "" : K.str(w as SAtom); return VIA_TYPE[s] ? s : (kidStr(n, "type") || "through"); };
const FP_TYPE = (n: SNode) => { const a = K.kid(n, "attr"); const w = a ? a.slice(1).map((x) => K.str(x as SAtom)) : []; return w.includes("smd") ? "SMD" : w.includes("through_hole") ? "Through hole" : "Unspecified"; };
const attrHas = (n: SNode, w: string) => { const a = K.kid(n, "attr"); return !!a && a.slice(1).some((x) => K.str(x as SAtom) === w); };

/** PROPERTY_BASE getters for A.<name> / B.<name>: numbers in mm, enums as their ENUM_MAP names. */
export function propOf(doc: BoardDoc, s: DesignSettings, it: RuleItem | null, name: string, typeName: (it: RuleItem) => string): Val {
  if (!it) return U;
  const key = norm(name), n = it.node; const net = () => netName(doc, n);
  const isPad = it.kind === "pad", isVia = it.kind === "via", isFp = it.kind === "footprint", isZone = it.kind === "zone";
  switch (key) {
  case "type": return str(typeName(it));
  case "net": case "netname": return str(net());
  case "netcode": return numv(netOf(n).code || 0);
  case "netclass": return str(netclassName(s, net()));
  case "layer": return str(it.layer || layerOf(n) || "");
  case "locked": return bool(yes(n, "locked") || n.slice(1).some((c) => !isList(c) && K.str(c as SAtom) === "locked"));
  case "parent": { const fp = fpOf(it); return fp && !isFp ? str(fieldOf(fp.node, "Reference") || "") : U; }
  case "positionx": case "positiony": { const p = pt(n, "at") || pt(n, "start") || pt(n, "center"); if (!p) return U; if (isPad && it.parent) { const q = padsOf(it.parent).find((x) => x.node === n); if (q) return numv(key === "positionx" ? q.x : q.y); } return numv(key === "positionx" ? p[0] : p[1]); }
  case "startx": case "starty": { const p = pt(n, "start"); return p ? numv(p[key === "startx" ? 0 : 1]) : U; }
  case "endx": case "endy": { const p = pt(n, "end"); return p ? numv(p[key === "endx" ? 0 : 1]) : U; }
  case "width": case "linewidth": { if (it.kind === "segment" || it.kind === "arc") return kidNum(n, "width"); const st = K.kid(n, "stroke"); if (st) return kidNum(st, "width"); return kidNum(n, "width"); }
  case "diameter": return isVia ? kidNum(n, "size") : U;
  case "hole": return isVia ? kidNum(n, "drill") : U;
  case "holesize": case "holesizex": case "holesizey": {
    if (isVia) return kidNum(n, "drill");
    if (!isPad) return U; const d = K.kid(n, "drill"); if (!d) return numv(0);
    const oval = K.str(d[1]) === "oval"; const a = oval ? K.num(d[2]) : K.num(d[1]); const b = oval ? K.num(d[3], a) : a; return numv(key === "holesizey" ? b : a);
  }
  case "holeshape": { if (!isPad) return U; const d = K.kid(n, "drill"); return str(!d ? "Undefined" : K.str(d[1]) === "oval" ? "Oblong" : "Round"); }
  case "layertop": case "layerbottom": { if (!isVia) return U; const ls = K.kid(n, "layers"); return ls ? str(K.str(ls[key === "layertop" ? 1 : 2])) : U; }
  case "viatype": return isVia ? str(VIA_TYPE[viaTypeOf(n)] || "Through") : U;
  case "padtype": return isPad ? str(PAD_TYPE[K.str((n as SAtom[])[2])] || K.str((n as SAtom[])[2])) : U;
  case "padshape": return isPad ? str(PAD_SHAPE[K.str((n as SAtom[])[3])] || K.str((n as SAtom[])[3])) : U;
  case "padnumber": return isPad ? str(K.str((n as SAtom[])[1])) : U;
  case "pinname": return isPad ? str(kidStr(n, "pinfunction")) : U;
  case "pintype": return isPad ? str(kidStr(n, "pintype")) : U;
  case "fabricationproperty": { if (!isPad) return U; const p = kidStr(n, "property"); return str(PAD_PROP[p] || "None"); }
  case "sizex": case "sizey": return isPad ? kidNum(n, "size", key === "sizex" ? 1 : 2) : U;
  case "size": return isVia ? kidNum(n, "size") : U;
  case "orientation": { const a = K.kid(n, "at"); return a ? numv(a[3] !== undefined ? K.num(a[3]) : 0) : U; }
  case "cornerradiusratio": return isPad ? kidNum(n, "roundrect_rratio") : U;
  case "clearanceoverride": { if (!isPad && !isFp) return U; const v = kidNum(n, "clearance"); return v.t === "u" ? NUL : v; }   // std::optional<int>: unset is null
  case "padtodielength": return isPad ? kidNum(n, "die_length") : U;
  case "reference": { const fp = isFp ? it : null; return fp ? str(fieldOf(n, "Reference") || "") : U; }
  case "value": { if (isFp) return str(fieldOf(n, "Value") || ""); return U; }
  case "librarylink": return isFp ? str(K.str((n as SAtom[])[1])) : U;
  case "librarydescription": return isFp ? str(kidStr(n, "descr")) : U;
  case "keywords": return isFp ? str(kidStr(n, "tags")) : U;
  case "footprinttype": return isFp ? str(FP_TYPE(n)) : U;
  case "donotpopulate": return isFp ? bool(attrHas(n, "dnp")) : U;
  case "excludefrombillofmaterials": return isFp ? bool(attrHas(n, "exclude_from_bom")) : U;
  case "excludefrompositionfiles": return isFp ? bool(attrHas(n, "exclude_from_pos_files")) : U;
  case "notinschematic": return isFp ? bool(attrHas(n, "board_only")) : U;
  case "exemptfromcourtyardrequirement": return isFp ? bool(attrHas(n, "allow_missing_courtyard")) : U;
  case "componentclass": { if (!isFp) return U; const cc = K.kid(n, "component_classes"); return str(cc ? K.kids(cc, "class").map((c) => K.str(c[1])).join(",") : ""); }
  case "name": return isZone ? str(kidStr(n, "name")) : it.kind === "group" ? str(K.str((n as SAtom[])[1])) : U;
  case "priority": return isZone ? numv(K.num(kidv(n, "priority") ?? 0)) : U;
  case "clearance": { if (!isZone) return U; const c = K.kid(n, "connect_pads"); const v = c && K.kid(c, "clearance"); return v ? numv(K.num(v[1])) : U; }
  case "minimumwidth": return isZone ? kidNum(n, "min_thickness") : U;
  case "text": { const t = (n as SAtom[])[1]; return it.kind === "property" ? str(K.str((n as SAtom[])[2])) : t !== undefined && !isList(t) ? str(K.str(t)) : U; }
  case "height": case "thickness": { const ef = K.kid(n, "effects"), f = ef && K.kid(ef, "font"); if (!f) return U; return key === "height" ? kidNum(f, "size", 2) : kidNum(f, "thickness"); }
  case "visible": return bool(!yes(n, "hide"));
  default: return U;
  }
}

// ---- geometry the area / courtyard functions test
/** The item's outline as a copper shape: its own shape when the caller gave one, else built from its node. */
export function itemShape(it: RuleItem): CopperShape | null {
  if (it.shape) return it.shape;
  const n = it.node;
  if (it.kind === "segment") { const a = pt(n, "start"), b = pt(n, "end"); const w = K.num(kidv(n, "width") ?? 0.25); return a && b ? { t: "seg", a: a as Pt, b: b as Pt, r: w / 2 } : null; }
  if (it.kind === "arc") { const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); const w = K.num(kidv(n, "width") ?? 0.25); if (!a || !m || !b) return null; const c = K.arcFrom3(a, m, b); return { t: "path", pts: c ? arcPoints(c, a as Pt, b as Pt) : [a as Pt, b as Pt], r: w / 2 }; }
  if (it.kind === "via") { const a = pt(n, "at"); return a ? { t: "circle", x: a[0], y: a[1], r: K.num(kidv(n, "size") ?? 0.6) / 2 } : null; }
  if (it.kind === "pad" && it.parent) { const p = padsOf(it.parent).find((q) => q.node === n); return p ? padShape(p) : null; }
  if (it.kind === "zone") { const poly = K.kid(n, "polygon"); const pts = poly ? K.ptsOf(poly) : []; return pts.length > 2 ? { t: "poly", pts } : null; }
  const b = it.item && it.item.bbox; if (b) return { t: "poly", pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]] };
  return null;
}
/** Does the shape touch the closed polygon (overlap or one inside the other)? */
export function shapeHitsPoly(sh: CopperShape, P: Pt[]) {
  if (sh.t === "poly") return polyPolyDist(sh.pts, P) <= 1e-9;
  return shapeGap(sh, { t: "poly", pts: P }) <= 1e-9;
}
/** Is the whole shape inside the polygon (enclosedByArea)? */
export function shapeInsidePoly(sh: CopperShape, P: Pt[]) {
  const core: Pt[] = sh.t === "circle" ? [[sh.x, sh.y]] : sh.t === "seg" ? [sh.a, sh.b] : sh.t === "rect" ? rectCore(sh) : sh.pts;
  if (!core.every((p) => pointInPoly(P, p[0], p[1]))) return false;
  const off = shapeOffset(sh); if (off <= 0 && sh.t !== "poly" && sh.t !== "rect") return true;
  const segs: Pt[][] = sh.t === "circle" ? [] : sh.t === "rect" || sh.t === "poly" ? core.map((p, i) => [p, core[(i + 1) % core.length]]) : shapeSegs(sh);
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (sh.t === "circle") { if (dPS([sh.x, sh.y], a, b) < off - 1e-9) return false; continue; }
    for (const [c, d] of segs) if (segSegDist(c, d, a, b) < off - 1e-9) return false;
  }
  return true;
}
const zonePolys = (z: SNode) => K.kids(z, "polygon").map((p) => K.ptsOf(p)).filter((p) => p.length > 2);
const zoneLayersOf = (z: SNode) => { const l = K.kid(z, "layers") || K.kid(z, "layer"); return l ? l.slice(1).map((x) => K.str(x as SAtom)) : []; };
const onLayer = (ls: string[], layer: string | null | undefined) => !layer || ls.some((l) => l === layer || (l === "*.Cu" && /\.Cu$/.test(layer)) || (l === "F&B.Cu" && /^[FB]\.Cu$/.test(layer)) || (l.startsWith("*.") && layer.endsWith(l.slice(1))));
/** The rule areas (and zones) of the board and its footprints, by name or uuid: searchAreas. */
function areasMatching(doc: BoardDoc, arg: string, A: RuleItem | null, B: RuleItem | null) {
  if (arg === "A" || arg === "B") { const it = arg === "A" ? A : B; return it && it.kind === "zone" ? [{ node: it.node, parent: it.parent || null }] : []; }
  const out: { node: SNode; parent: KItem | null }[] = [];
  const test = (z: SNode, parent: KItem | null) => { const name = kidStr(z, "name"), id = kidStr(z, "uuid"); if ((name && wxMatchesLocal(arg, name)) || id === arg) out.push({ node: z, parent }); };
  for (const it of doc.items.values()) {
    if (it.kind === "zone") test(it.node, null);
    else if (it.kind === "footprint") for (const z of K.kids(it.node, "zone")) test(z, it);
  }
  return out;
}
/** A footprint's zone polygons are stored in board coordinates (KiCad writes them transformed), so they need no transform. */
function wxMatchesLocal(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); return re.test(s); }
/** testFootprintSelector: ${CLASS:x}, the reference with wildcards, or the lib id when the selector holds ':'. */
export function footprintSelector(fp: SNode, sel: string) {
  if (!sel) return false;
  if (/^\$\{CLASS:.*\}$/i.test(sel)) { const name = sel.slice(8, -1); const cc = K.kid(fp, "component_classes"); return !!cc && K.kids(cc, "class").some((c) => K.str(c[1]) === name); }
  if (wxMatchesLocal(sel, fieldOf(fp, "Reference") || "")) return true;
  return sel.includes(":") && wxMatchesLocal(sel, K.str((fp as SAtom[])[1]));
}
/** The groups each uuid belongs to (member uuid → group nodes), per document version. */
const GROUPS = new WeakMap<BoardDoc, { ver: unknown; map: Map<string, SNode> }>();
function groupOfMap(doc: BoardDoc, ver: unknown) {
  const c = GROUPS.get(doc); if (c && c.ver === ver) return c.map;
  const map = new Map<string, SNode>();
  for (const it of doc.items.values()) if (it.kind === "group") { const m = K.kid(it.node, "members"); if (m) for (const id of m.slice(1)) map.set(K.str(id as SAtom), it.node); }
  GROUPS.set(doc, { ver, map }); return map;
}
const uuidOf = (n: SNode) => kidStr(n, "uuid");

/** The context a function sees: the doc, settings, A / B and the constraint being resolved (isCoupledDiffPair asks). */
export interface FnCtx { doc: BoardDoc; s: DesignSettings; A: RuleItem | null; B: RuleItem | null; constraint: string | null; ver: unknown }
/** PCBEXPR_BUILTIN_FUNCTIONS: `fn` called on `it` (A or B) with string arguments. */
export function callFunc(fn: string, it: RuleItem | null, args: string[], c: FnCtx, wild: (p: string, s: string) => boolean, wxm: (p: string, s: string) => boolean): Val {
  const as = args[0] || "", { doc, s } = c;
  switch (fn) {
  case "isPlated": return bool(!!it && (it.kind === "via" || (it.kind === "pad" && K.str((it.node as SAtom[])[2]) === "thru_hole")));
  case "existsOnLayer": {
    if (!it || !as) return bool(false);
    let ls: string[];
    if (it.kind === "via") { ls = (c.doc.copper && c.doc.copper.length ? c.doc.copper : ["F.Cu", "B.Cu"]).slice(); const L = K.kid(it.node, "layers"); if (L && viaTypeOf(it.node) !== "through") { const all = ls, i0 = all.indexOf(K.str(L[1] as SAtom)), i1 = all.indexOf(K.str(L[2] as SAtom)); if (i0 >= 0 && i1 >= 0) ls = all.slice(Math.min(i0, i1), Math.max(i0, i1) + 1); } }
    else if (it.kind === "zone") ls = zoneLayersOf(it.node);
    else { const L = K.kid(it.node, "layers"); ls = L ? L.slice(1).map((x) => K.str(x as SAtom)) : [layerOf(it.node)]; }
    const expand = (l: string) => l === "*.Cu" || l === "F&B.Cu" ? (l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : (c.doc.copper && c.doc.copper.length ? c.doc.copper : ["F.Cu", "B.Cu"])) : l.startsWith("*.") ? ["F" + l.slice(1), "B" + l.slice(1)] : [l];
    return bool(ls.flatMap(expand).some((l) => wild(as, l)));
  }
  case "isMicroVia": return bool(!!it && it.kind === "via" && viaTypeOf(it.node) === "micro");
  case "isBlindVia": return bool(!!it && it.kind === "via" && viaTypeOf(it.node) === "blind");
  case "isBuriedVia": return bool(!!it && it.kind === "via" && viaTypeOf(it.node) === "buried");
  case "isBlindBuriedVia": return bool(!!it && it.kind === "via" && (viaTypeOf(it.node) === "blind" || viaTypeOf(it.node) === "buried"));
  case "isStackedVia": {   // PCB_VIA::CollectMicroviaColumns: microvias sharing a centre on adjacent layers
    if (!it || it.kind !== "via" || viaTypeOf(it.node) !== "micro") return bool(false); const p = pt(it.node, "at"); if (!p) return bool(false);
    for (const o of doc.items.values()) { if (o.kind !== "via" || o.node === it.node || viaTypeOf(o.node) !== "micro") continue; const q = pt(o.node, "at"); if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) return bool(true); }
    return bool(false);
  }
  case "memberOf": case "memberOfGroup": {
    if (!it || !as) return bool(false); const map = groupOfMap(doc, c.ver);
    let g = map.get(uuidOf(it.node)) || (it.parent ? map.get(uuidOf(it.parent.node)) : undefined); let guard = 0;
    while (g && guard++ < 64) { if (wxm(as, K.str((g as SAtom[])[1]))) return bool(true); g = map.get(uuidOf(g)); }
    return bool(false);
  }
  case "memberOfFootprint": { const fp = it && it.parent; return bool(!!fp && footprintSelector(fp.node, as)); }
  case "memberOfSheet": case "memberOfSheetOrChildren": {
    const fp = it ? fpOf(it) : null; if (!fp || !as) return bool(false);
    let sheet = kidStr(fp.node, "sheetname") || fieldOf(fp.node, "Sheetname") || ""; let ref = as;
    if (sheet.endsWith("/")) sheet = sheet.slice(0, -1); if (ref.endsWith("/")) ref = ref.slice(0, -1);
    if ((wxm("/", ref) || !ref) && !sheet) return bool(true);
    if (fn === "memberOfSheet") return bool(wxm(ref, sheet));
    const sp = sheet.split("/"), rp = ref.split("/"); if (rp.length > sp.length) return bool(false);
    return bool(rp.every((r, i) => wxm(r, sp[i])));
  }
  case "getField": { if (!it || it.kind !== "footprint" || !as) return str(""); return str(fieldOf(it.node, as) || ""); }
  case "hasNetclass": return bool(!!it && !!as && wild(as, netclassName(s, netName(doc, it.node))));
  case "hasExactNetclass": return bool(!!it && !!as && netclassName(s, netName(doc, it.node)) === as);
  case "hasComponentClass": { const fp = it ? fpOf(it) : null; if (!fp || !as) return bool(false); const cc = K.kid(fp.node, "component_classes"); return bool(!!cc && K.kids(cc, "class").some((x) => wild(as, K.str(x[1])))); }
  case "customProperty": return str("");   // EDA_ITEM custom properties are not written to the board file
  case "hasCustomProperty": return bool(false);
  case "inNetChain": case "hasNetChain": case "inNetChainClass": return bool(false);   // the board defines no net chains
  case "inDiffPair": {   // the net's base name (suffix character out) matches, with or without a trailing '_'
    if (!it || !as) return bool(false); const name = netName(doc, it.node); const m = matchDpSuffix(name);
    if (!m.rv || !netExists(doc, m.complement)) return bool(false);
    const base = m.base; return bool(wxm(as, base) || (base.endsWith("_") && wxm(as, base.slice(0, base.lastIndexOf("_")))));
  }
  case "isCoupledDiffPair": {
    const a = c.A, b = c.B; const name = a ? netName(doc, a.node) : ""; if (!name) return bool(false); const m = matchDpSuffix(name); if (!m.rv) return bool(false);
    if (c.constraint && ["diff_pair_gap", "length", "skew", "net_chain_length"].includes(c.constraint) && netExists(doc, m.complement)) return bool(true);
    return bool(!!b && netName(doc, b.node) === m.complement);
  }
  case "insideCourtyard": case "intersectsCourtyard": case "insideFrontCourtyard": case "intersectsFrontCourtyard": case "insideBackCourtyard": case "intersectsBackCourtyard": {
    if (!it || !as) return bool(false); const sh = itemShape(it); if (!sh) return bool(false);
    const side = /Front/.test(fn) ? ["F.CrtYd"] : /Back/.test(fn) ? ["B.CrtYd"] : ["F.CrtYd", "B.CrtYd"];
    let fps: KItem[];
    if (as === "A" || as === "B") { const o = as === "A" ? c.A : c.B; const f = o ? fpOf(o) : null; fps = f ? [f] : []; }
    else fps = [...doc.items.values()].filter((f) => f.kind === "footprint" && footprintSelector(f.node, as));
    const bb = shapeBBox(sh);
    for (const f of fps) {
      if (f.bbox && (bb[0] > f.bbox[2] || bb[2] < f.bbox[0] || bb[1] > f.bbox[3] || bb[3] < f.bbox[1])) continue;
      const cy = courtyardLoops(f); for (const l of side) for (const P of cy[l] || []) if (shapeHitsPoly(sh, P)) return bool(true);
    }
    return bool(false);
  }
  case "insideArea": case "intersectsArea": case "intersectsKeepout": case "enclosedByArea": {
    if (!it || !as) return bool(false); const sh = itemShape(it); if (!sh) return bool(false);
    for (const z of areasMatching(doc, as, c.A, c.B)) {
      if (z.node === it.node) continue;
      const zl = zoneLayersOf(z.node); const layer = it.layer || (it.kind === "footprint" ? null : layerOf(it.node, ""));
      if (layer && !onLayer(zl, layer) && it.kind !== "via" && it.kind !== "pad") continue;
      if (it.kind === "footprint" && fn !== "enclosedByArea") {   // collidesWithArea: a footprint by its courtyard on the area's sides
        const cy = courtyardLoops(it.item || ({ id: "", kind: "footprint", node: it.node } as KItem)); const sides = [zl.some((l) => /^F\.|^\*\.|F&B/.test(l)) ? "F.CrtYd" : "", zl.some((l) => /^B\.|^\*\.|F&B/.test(l)) ? "B.CrtYd" : ""].filter(Boolean);
        for (const P of zonePolys(z.node)) for (const l of sides) for (const Q of cy[l] || []) if (polyPolyDist(Q, P) <= 1e-9) return bool(true);
        continue;
      }
      for (const P of zonePolys(z.node)) if (fn === "enclosedByArea" ? shapeInsidePoly(sh, P) : shapeHitsPoly(sh, P)) return bool(true);
    }
    return bool(false);
  }
  case "fromTo": return bool(!!it && onFromToPath(doc, it, args[0] || "", args[1] || "", c.ver, wxm));
  default: return U;
  }
}

/** The footprint's closed courtyard loops by layer (drc.ts courtyards, transformed to the board). */
const courtyardLoops = (fp: KItem) => courtyards(fp);

// ---- FROM_TO_CACHE: the items on the copper path from one pad to another
const FT = new WeakMap<BoardDoc, { ver: unknown; paths: Map<string, Set<SNode>> }>();
type FtNode = { node: SNode; shape: CopperShape; layers: string[]; name: string; net: string };
function onFromToPath(doc: BoardDoc, it: RuleItem, from: string, to: string, ver: unknown, wxm: (p: string, s: string) => boolean) {
  if (!from || !to) return false;
  let c = FT.get(doc); if (!c || c.ver !== ver) FT.set(doc, c = { ver, paths: new Map() });
  const key = from + "\u0000" + to; let set = c.paths.get(key);
  if (!set) { set = fromToItems(doc, from, to, wxm); c.paths.set(key, set); }
  return set.has(it.node);
}
function fromToItems(doc: BoardDoc, from: string, to: string, wxm: (p: string, s: string) => boolean) {
  const out = new Set<SNode>(); const nodes: FtNode[] = []; const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const expand = (ls: string[]) => ls.flatMap((l) => (l === "*.Cu" ? copper : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : /\.Cu$/.test(l) ? [l] : []));
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { const ref = fieldOf(it.node, "Reference") || ""; for (const p of padsOf(it)) nodes.push({ node: p.node, shape: padShape(p), layers: expand(p.layers), name: ref + "-" + p.number, net: p.net.name || netName(doc, p.node) }); }
    else if (it.kind === "segment" || it.kind === "arc" || it.kind === "via") {
      const sh = itemShape({ kind: it.kind, node: it.node }); if (!sh) continue;
      const ls = it.kind === "via" ? copper : [layerOf(it.node)];
      nodes.push({ node: it.node, shape: sh, layers: ls, name: "", net: netName(doc, it.node) });
    }
  }
  const starts = nodes.filter((n) => n.name && wxm(from, n.name)), ends = new Set(nodes.filter((n) => n.name && wxm(to, n.name)));
  for (const s0 of starts) {
    const prev = new Map<FtNode, FtNode | null>([[s0, null]]); const q = [s0]; let hit: FtNode | null = null;
    while (q.length && !hit) {
      const a = q.shift()!;
      for (const b of nodes) {
        if (prev.has(b) || b.net !== s0.net || (b.name && !ends.has(b))) continue;   // the path runs through tracks and vias, ending on a pad
        if (!b.layers.some((l) => a.layers.includes(l)) || shapeGap(a.shape, b.shape) > 1e-6) continue;
        prev.set(b, a); if (ends.has(b)) { hit = b; break; } q.push(b);
      }
    }
    for (let n: FtNode | null | undefined = hit; n; n = prev.get(n)) out.add(n.node);
  }
  return out;
}
