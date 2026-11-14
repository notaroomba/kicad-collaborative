// pcbdialogs/item-props — the board items' Properties dialogs in KiCad's layout:
//   Track & Via Properties (DIALOG_TRACK_VIA_PROPERTIES), Copper Zone Properties (DIALOG_COPPER_ZONE /
//   PANEL_ZONE_PROPERTIES), Text Properties (DIALOG_TEXT_PROPERTIES), "<Shape> Properties"
//   (DIALOG_SHAPE_PROPERTIES) and Footprint Properties (DIALOG_FOOTPRINT_PROPERTIES).
// Each edits a copy of the item's node and stores it as one MODIFIED change on OK.  KDialogs.openItem asks
// pcbItemDialog first and falls back to the generic property sheet for the kinds not handled here (pads
// keep pcb-tools' Pad Properties; dimensions open Dimension Properties from ./dimension).
import { KICAD_FONT, faceOfFont, fontField, setFaceOfFont } from "../../dialogs/font-picker";
import { trackViaDialog } from "./track-via";
import { box, checkField, errorMessage, fmtLenU, form, grid, gridButtons, h, coordField, iconToggle, lenField, messageBox, notebook, numField, openDialog, selectField, textField, unitLabel, type CellValue, type Field } from "./ui";
import { comboBox } from "../../components/kcombo";
import { E } from "../state";
import { kicadActionAvailable, runKicadAction } from "../hotkeys";
import { dimensionDialog } from "./dimension";
import { textBoxDialog } from "./textbox";
import { tableDialog } from "./table";
import { boardXref } from "./xref";
import * as VM from "../../canvas/variant-model";
import { syntaxHelpLink } from "../syntax-help";
import { refImageDialog } from "./refimage";
import { zoneSettingsPanel, type ZoneDefaults } from "./board-setup-pages";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode, key: string): SNode | null => K().kid(n, key) as SNode | null;
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const f6 = (v: number): string => String(+(+v).toFixed(6));
function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
/** Replace (key …) with the parsed `text`, insert it before the first of `before` (else append); null removes it. */
function put(node: SNode, key: string, text: string | null, before: string[] = []): void {
  const i = idxOf(node, key);
  if (text === null) { if (i > 0) node.splice(i, 1); return; }
  const n = K().parse(text) as SNode;
  if (i > 0) { node[i] = n; return; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, n);
}

interface PropsHelpers {
  setFootprintPosition(node: SNode, x: number, y: number): void; setFootprintRotation(node: SNode, deg: number): boolean; setFootprintSide(node: SNode, side: string): boolean;
  footprintAttrs(node: SNode): Record<string, unknown> & { type: string }; setFootprintAttrs(node: SNode, attrs: Record<string, unknown>): void;
  netNameOf(doc: KDoc, node: SNode): string; boardNetNames(doc: KDoc): string[]; netCodeOf(doc: KDoc, name: string): number;
}
interface FieldFx { size: number; thick: number; bold: boolean; italic: boolean; h: string; v: string; mirror: boolean }
interface FieldHelpers { fieldNode(node: SNode, name: string): SNode | null; fieldUnlocked(p: SNode): boolean; setFieldUnlocked(p: SNode, on: boolean): void; fieldEffects(p: SNode): FieldFx; setFieldEffects(p: SNode, fx: Partial<FieldFx>): void; fieldAt(p: SNode): [number, number, number]; setFieldAt(p: SNode, x: number, y: number, rot: number): void;
  fieldHidden(p: SNode): boolean; setFieldHidden(node: SNode, p: SNode, hidden: boolean): void; fieldLayer(p: SNode): string; setFieldLayer(p: SNode, layer: string): void }
const PH = (): PropsHelpers => (CollabTools as unknown as { props: { helpers: PropsHelpers } }).props.helpers;
const FH = (): FieldHelpers => (KDialogs as unknown as { _: FieldHelpers })._;
interface LayerStyle { line: number; w: number; h: number; thick: number; italic: boolean; upright: boolean }
type PcbToolsLite = { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode; layerStyle(layer: string): LayerStyle };
const PT = (): PcbToolsLite => (window as unknown as { PcbTools: PcbToolsLite }).PcbTools;

const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };
const allLayers = (doc: KDoc): [string, string][] => Array.from(doc.layers.keys()).map((n): [string, string] => [n, layerLabel(doc, n)]);
const copperLayers = (doc: KDoc): [string, string][] => doc.copper.map((n): [string, string] => [n, layerLabel(doc, n)]);
const withCurrent = (opts: [string, string][], cur: string): [string, string][] => (cur && !opts.some((o) => o[0] === cur) ? [[cur, cur], ...opts] : opts);

/** The net of a track, via or zone, written in the form the board uses (a name, or the legacy code). */
export function setNet(doc: KDoc, node: SNode, name: string): void {
  const cur = kid(node, "net"), coded = cur ? typeof cur[1] === "number" : Array.from(doc.items.values()).some((it) => { const n = kid(it.node, "net"); return !!n && typeof n[1] === "number"; });
  const before = ["uuid", "tstamp", "name", "locked", "hatch"];
  if (!coded) { if (name) put(node, "net", `(net ${quote(name)})`, before); else put(node, "net", null); if (kid(node, "net_name")) put(node, "net_name", null); return; }
  const code = name ? PH().netCodeOf(doc, name) : 0;
  put(node, "net", `(net ${code})`, before);
  if (node[0] === "zone") put(node, "net_name", `(net_name ${quote(name)})`, ["layer", "layers", "uuid", "tstamp"]);
}
function netField(doc: KDoc, node: SNode, ro: boolean): Field<string> {
  const cur = PH().netNameOf(doc, node), names = PH().boardNetNames(doc).filter((n) => n);
  return selectField<string>(cur, [["", "<no net>"], ...withCurrent(names.map((n): [string, string] => [n, n]), cur)], { ro, key: "net" });
}

/** A failed TransferDataFromWindow: the message DisplayError shows, and the control that gets the focus after it. */
export interface ApplyError { msg: string; focus?: { input: HTMLElement } | HTMLElement | null }
type Apply = (node: SNode) => string | ApplyError | void;
/** DisplayError over the dialog, then (as KiCad's SelectAll(); SetFocus()) the bad field focused with its text selected. */
export function showApplyError(err: string | ApplyError): void {
  const e: ApplyError = typeof err === "string" ? { msg: err } : err;
  const target = e.focus ? ("input" in e.focus ? e.focus.input : e.focus) as HTMLElement : null;
  errorMessage(e.msg, () => { if (target && document.contains(target)) { target.focus(); if (target instanceof HTMLInputElement && target.type === "text") target.select(); } });
}
/** The shell: a copy of the node, a builder that returns how to lay the controls into it, one change on OK. */
/**
 * One item's properties dialog.  `create` makes it the dialog of a new item a drawing tool is about to place
 * (DRAWING_TOOL::PlaceText): OK hands the edited node over instead of committing, Cancel hands over null.
 */
function itemDialog(ctx: ToolCtx, item: KItem, title: string, width: number, build: (node: SNode, body: HTMLElement, ro: boolean) => Apply, create: ((node: SNode | null) => void) | undefined, undo: string): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const staged = (K().cloneNode as (n: SNode) => SNode)(item.node);
  let apply: Apply = () => undefined;
  const before = K().serialize(staged);
  return !!openDialog({ title, width, readOnly: !!ctx.viewOnly,
    build(body) { apply = build(staged, body, !!ctx.viewOnly); },
    cancel: create ? () => create(null) : undefined,
    ok() {
      if (ctx.viewOnly) return true;
      const err = apply(staged);
      if (err) { if (typeof err === "string" || err.msg) showApplyError(err); return false; }   // an empty message: the builder already said why
      if (create) { create(staged); return true; }
      if (K().serialize(staged) === before) return true;
      ctx.commit([K().replaceChange(doc, { ...item, node: staged, geom: [], bbox: null })], undo);
      return true;
    } });
}
const xyRow = (lx: string, x: Field<number>, y: Field<number>): [string, HTMLElement, HTMLElement] => [lx, h("span", { class: "pd-xy" }, x.el, h("label", null, "Y:"), y.el), unitLabel()];

// ---------------------------------------------------------------- Copper Zone Properties
const PAD_CONN: [string, number][] = [["yes", 2], ["thermal", 1], ["thru_hole_only", 3], ["no", 0]];
const OUTLINE: [string, number][] = [["none", 0], ["edge", 2], ["full", 1]];
const SMOOTH: [string, number][] = [["none", 0], ["chamfer", 1], ["fillet", 2]];
const toNum = (m: [string, number][], v: string, d: number): number => { const e = m.find((x) => x[0] === v); return e ? e[1] : d; };
const toTok = (m: [string, number][], v: number): string => (m.find((x) => x[1] === v) || m[0])[0];
/** PANEL_ZONE_PROPERTIES::TransferZoneSettingsToWindow's values, read off a zone node. */
function zoneValues(node: SNode): ZoneDefaults {
  const cp = kid(node, "connect_pads") || ["connect_pads"], fill = kid(node, "fill") || ["fill"], hatch = kid(node, "hatch");
  const mode0 = typeof cp[1] === "string" ? String(cp[1]) : "thermal";
  return { clearance: nval(kid(cp, "clearance"), 1, 0.5), minWidth: nval(kid(node, "min_thickness"), 1, 0.25), padConnection: toNum(PAD_CONN, mode0, 1),
    thermalGap: nval(kid(fill, "thermal_gap"), 1, 0.5), spokeWidth: nval(kid(fill, "thermal_bridge_width"), 1, 0.5), outline: toNum(OUTLINE, sval(hatch) || "edge", 2), hatchPitch: nval(hatch, 2, 0.5),
    fillMode: sval(kid(fill, "mode")) === "hatch" ? 1 : 0, hatchOrientation: nval(kid(fill, "hatch_orientation")), hatchWidth: nval(kid(fill, "hatch_thickness"), 1, 1), hatchGap: nval(kid(fill, "hatch_gap"), 1, 1.5),
    smoothLevel: nval(kid(fill, "hatch_smoothing_level")), smoothValue: nval(kid(fill, "hatch_smoothing_value"), 1, 0.1), cornerSmoothing: toNum(SMOOTH, sval(kid(fill, "smoothing")) || "none", 0),
    cornerRadius: nval(kid(fill, "radius")), islands: nval(kid(fill, "island_removal_mode")), islandArea: nval(kid(fill, "island_area_min"), 1, 10) };
}
/** TransferZoneSettingsFromWindow onto a zone node: what the panel shows, the children it does not show kept. */
function writeZone(n: SNode, v: ZoneDefaults, v0: ZoneDefaults): void {
      put(n, "hatch", `(hatch ${toTok(OUTLINE, v.outline)} ${f6(v.hatchPitch)})`, ["priority", "connect_pads"]);
      // connect_pads and fill keep the children this dialog does not show
      let c = kid(n, "connect_pads"); if (!c) { put(n, "connect_pads", "(connect_pads)", ["min_thickness", "filled_areas_thickness", "fill", "polygon"]); c = kid(n, "connect_pads") as SNode; }
      const tok = toTok(PAD_CONN, v.padConnection);
      if (typeof c[1] === "string") c.splice(1, 1);
      if (tok !== "thermal") c.splice(1, 0, tok);
      put(c, "clearance", `(clearance ${f6(v.clearance)})`);
      put(n, "min_thickness", `(min_thickness ${f6(v.minWidth)})`, ["filled_areas_thickness", "fill", "polygon"]);
      let f = kid(n, "fill"); if (!f) { put(n, "fill", "(fill)", ["polygon", "filled_polygon"]); f = kid(n, "fill") as SNode; }
      // the fill mode changes only when Hatched fill was switched (a thieving zone stays one)
      if ((v.fillMode === 1) !== (v0.fillMode === 1)) put(f, "mode", v.fillMode === 1 ? "(mode hatch)" : null, ["thermal_gap", "thermal_bridge_width", "smoothing", "radius", "island_removal_mode"]);
      put(f, "thermal_gap", `(thermal_gap ${f6(v.thermalGap)})`, ["thermal_bridge_width", "smoothing", "radius", "island_removal_mode"]);
      put(f, "thermal_bridge_width", `(thermal_bridge_width ${f6(v.spokeWidth)})`, ["smoothing", "radius", "island_removal_mode"]);
      if (v.cornerSmoothing === 0) { put(f, "smoothing", null); put(f, "radius", null); }
      else { put(f, "smoothing", `(smoothing ${toTok(SMOOTH, v.cornerSmoothing)})`, ["radius", "island_removal_mode", "island_area_min"]); if (v.cornerRadius) put(f, "radius", `(radius ${f6(v.cornerRadius)})`, ["island_removal_mode", "island_area_min"]); else put(f, "radius", null); }
      const im = v.islands;
      if (im || kid(f, "island_removal_mode")) put(f, "island_removal_mode", `(island_removal_mode ${im})`, ["island_area_min", "hatch_thickness"]);
      if (im === 2) put(f, "island_area_min", `(island_area_min ${f6(v.islandArea)})`, ["hatch_thickness"]); else put(f, "island_area_min", null);
      if (v.fillMode === 1) {
        const H = ["hatch_border_algorithm", "hatch_min_hole_area"];
        put(f, "hatch_thickness", `(hatch_thickness ${f6(v.hatchWidth)})`, ["hatch_gap", "hatch_orientation", "hatch_smoothing_level", ...H]);
        put(f, "hatch_gap", `(hatch_gap ${f6(v.hatchGap)})`, ["hatch_orientation", "hatch_smoothing_level", ...H]);
        put(f, "hatch_orientation", `(hatch_orientation ${f6(v.hatchOrientation)})`, ["hatch_smoothing_level", ...H]);
        if (v.smoothLevel > 0) { put(f, "hatch_smoothing_level", `(hatch_smoothing_level ${Math.round(v.smoothLevel)})`, ["hatch_smoothing_value", ...H]); put(f, "hatch_smoothing_value", `(hatch_smoothing_value ${f6(v.smoothValue)})`, H); }
        else { put(f, "hatch_smoothing_level", null); put(f, "hatch_smoothing_value", null); }
        if (!kid(f, "hatch_border_algorithm")) put(f, "hatch_border_algorithm", "(hatch_border_algorithm hatch_thickness)", ["hatch_min_hole_area"]);
        if (!kid(f, "hatch_min_hole_area")) put(f, "hatch_min_hole_area", "(hatch_min_hole_area 0.3)");
      } else if (v0.fillMode === 1) for (const k of ["hatch_thickness", "hatch_gap", "hatch_orientation", "hatch_smoothing_level", "hatch_smoothing_value", "hatch_border_algorithm", "hatch_min_hole_area"]) put(f, k, null);
}
/** DIALOG_COPPER_ZONE: the layers, then PANEL_ZONE_PROPERTIES (name, net, locked, the notebook, corner smoothing, islands) and Open Zone Manager... */
function zoneDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Copper Zone Properties", 780, (node, body, ro) => {
    const l1 = kid(node, "layer"), ln = kid(node, "layers");
    const cur = new Set<string>(l1 ? [sval(l1)] : ln ? ln.slice(1).map(String) : []);
    const layerChecks = withCurrent(copperLayers(doc), "").map(([name, label]) => ({ name, f: checkField(cur.has(name), label, { ro, key: "layer-" + name }) }));
    const name = textField(sval(kid(node, "name")), { ro, key: "name" });
    name.input.title = "A unique name for this zone, used to identify it in DRC rules";
    const net = netField(doc, node, ro), locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const v0 = zoneValues(node);
    const panel = zoneSettingsPanel(v0, ro);
    const zm = h("button", { type: "button", class: "btn", "data-k": "openZoneManager" }, "Open Zone Manager...");
    zm.addEventListener("click", () => { const dlg = zm.closest(".kd-overlay, .kd-dialog"); const esc = dlg && dlg.querySelector<HTMLButtonElement>(".kd-foot button"); if (esc) esc.click(); setTimeout(() => runKicadAction("zonesManager"), 0); });
    body.append(h("div", { class: "pd-zone" },
      h("div", { class: "pd-zonelayers" }, h("div", { class: "pd-colhead" }, "Layers:"), h("div", { class: "pd-list", style: "padding:4px 8px;max-height:330px" }, ...layerChecks.map((l) => l.f.el)), h("div", { class: "pd-row", style: "margin-top:8px" }, zm)),
      h("div", null, form([["Zone name:", name.el, null, "A unique name for this zone, used to identify it in DRC rules"], ["Net name:", net.el]], true), locked.el, panel.el)));
    return (n) => {
      const on = layerChecks.filter((l) => l.f.get()).map((l) => l.name);
      if (!on.length) return "No layer selected.";
      const bad = panel.validate(); if (bad) return { msg: bad.msg, focus: bad.ctrl || null };
      const v = panel.get();
      if (net.get() !== PH().netNameOf(doc, n)) setNet(doc, n, net.get());
      if (on.join(" ") !== Array.from(cur).join(" ")) {
        put(n, "layer", null); put(n, "layers", null);
        put(n, on.length === 1 ? "layer" : "layers", on.length === 1 ? `(layer ${quote(on[0])})` : `(layers ${on.map(quote).join(" ")})`, ["uuid", "tstamp", "name", "hatch"]);
      }
      if (name.get().trim()) put(n, "name", `(name ${quote(name.get().trim())})`, ["hatch", "priority", "connect_pads"]); else put(n, "name", null);
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      writeZone(n, v, v0);
      return undefined;
    };
  }, create, "Edit Zone Properties");
}

/** The layers a zone names, its wildcards ("*.Cu", "F&B.Cu", "*.Mask" …) spelled out over the board's layers. */
function zoneLayerSet(doc: KDoc, node: SNode): Set<string> {
  const l1 = kid(node, "layer"), ln = kid(node, "layers");
  const raw = l1 ? [sval(l1)] : ln ? ln.slice(1).map(String) : [];
  const out = new Set<string>(); const all = Array.from(doc.layers.keys());
  for (const r of raw) {
    if (r === "*.Cu") doc.copper.forEach((c) => out.add(c));
    else if (r === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); }
    else if (r.startsWith("*.")) { const suf = r.slice(1); all.filter((n) => n.endsWith(suf)).forEach((n) => out.add(n)); }
    else if (r.startsWith("F&B.")) { out.add("F." + r.slice(4)); out.add("B." + r.slice(4)); }
    else out.add(r);
  }
  return out;
}
/** The layers list on the left of the zone dialogs; apply writes (layer …) or (layers …) when the ticks changed. */
function zoneLayerList(doc: KDoc, node: SNode, opts: [string, string][], ro: boolean): { el: HTMLElement; checked(): string[]; apply(n: SNode): string | void } {
  const cur = zoneLayerSet(doc, node);
  const checks = opts.map(([name, label]) => ({ name, f: checkField(cur.has(name), label, { ro, key: "layer-" + name }) }));
  const el = h("div", { class: "pd-zonelayers" }, h("div", { class: "pd-colhead" }, "Layers:"), h("div", { class: "pd-list", style: "padding:4px 8px;max-height:330px" }, ...checks.map((l) => l.f.el)));
  const checked = (): string[] => checks.filter((l) => l.f.get()).map((l) => l.name);
  return { el, checked, apply(n) {
    const on = checked(); if (!on.length) return "No layer selected.";
    const was = opts.map((o) => o[0]).filter((x) => cur.has(x));
    if (on.join(" ") === was.join(" ")) return undefined;   // untouched: a wildcard stays as written
    put(n, "layer", null); put(n, "layers", null);
    put(n, on.length === 1 ? "layer" : "layers", on.length === 1 ? `(layer ${quote(on[0])})` : `(layers ${on.map(quote).join(" ")})`, ["uuid", "tstamp", "name", "hatch"]);
    return undefined;
  } };
}
function outlineFields(node: SNode, ro: boolean): { outline: Field<string>; pitch: Field<number>; apply(n: SNode): void } {
  const hatch = kid(node, "hatch");
  const outline = selectField<string>(sval(hatch) || "edge", [["none", "Line"], ["edge", "Hatched"], ["full", "Fully hatched"]], { ro, key: "outline" });
  const pitch = lenField(nval(hatch, 2, 0.5), { ro, key: "hatchPitch" });
  pitch.input.title = "Distance between parallel lines used for hatching the area";
  return { outline, pitch, apply(n) {
    if (outline.get() !== (sval(hatch) || "edge") || Math.abs(pitch.get() - nval(hatch, 2, 0.5)) > 1e-9 || !hatch) put(n, "hatch", `(hatch ${outline.get()} ${f6(pitch.get())})`, ["priority", "connect_pads", "min_thickness"]);
  } };
}

// ---------------------------------------------------------------- Rule Area Properties (DIALOG_RULE_AREA_PROPERTIES)
type PlacementKind = "none" | "sheetname" | "component_class" | "group";
function ruleAreaDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Rule Area Properties", 708, (node, body, ro) => {
    const layers = zoneLayerList(doc, node, withCurrent(copperLayers(doc), ""), ro);
    const name = textField(sval(kid(node, "name")), { ro, key: "name" }); name.input.title = "A unique name for this rule area for use in DRC rules";
    const ko = kid(node, "keepout") || ["keepout"];
    const notAllowed = (k: string, dflt: boolean): boolean => { const c = kid(ko, k); return c ? sval(c) === "not_allowed" : dflt; };
    const tracks = checkField(notAllowed("tracks", true), "Keep out tracks", { ro, key: "koTracks", tip: "Prevent tracks from routing into this area" });
    const vias = checkField(notAllowed("vias", true), "Keep out vias", { ro, key: "koVias", tip: "Prevent vias from being placed in this area" });
    const pads = checkField(notAllowed("pads", true), "Keep out pads", { ro, key: "koPads", tip: "Raise a DRC error if a pad overlaps this area" });
    const pour = checkField(notAllowed("copperpour", false), "Keep out zone fills", { ro, key: "koPour", tip: "Zones will not fill copper into this area" });
    const fps = checkField(notAllowed("footprints", false), "Keep out footprints", { ro, key: "koFootprints", tip: "Raise a DRC error if a footprint courtyard overlaps this area" });
    // Placement: the multichannel tool's source, a sheet, a component class or a group (PANEL_RULE_AREA_PROPERTIES_PLACEMENT)
    const pl = kid(node, "placement"), plOn = !!pl && sval(kid(pl, "enabled")) === "yes";
    const plKind0: PlacementKind = !plOn ? "none" : kid(pl as SNode, "component_class") ? "component_class" : kid(pl as SNode, "group") ? "group" : "sheetname";
    const plSrc0 = plOn ? sval(kid(pl as SNode, plKind0)) : "";
    const sheets = new Set<string>(), classes = new Set<string>(), groups = new Set<string>();
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") {
        const sn = kid(it.node, "sheetname"); if (sn && sval(sn)) sheets.add(sval(sn));
        const cc = kid(it.node, "component_classes"); if (cc) for (const c of cc.slice(1)) if (isList(c) && c[0] === "class") classes.add(String(c[1]));
      } else if (it.kind === "group" && typeof it.node[1] === "string" && it.node[1]) groups.add(String(it.node[1]));
    }
    let plKind: PlacementKind = plKind0;
    const radios: HTMLInputElement[] = [];
    const radio = (k: PlacementKind, label: string, control?: Field<string>): HTMLElement => {
      const r = h("input", { type: "radio", name: "pd-placement", checked: plKind0 === k, disabled: ro, "data-k": "placement-" + k }) as HTMLInputElement;
      r.addEventListener("change", () => { if (r.checked) plKind = k; });
      radios.push(r);
      return h("div", { class: "kd-row" }, h("label", { class: "pd-check" }, r, label), control ? control.el : null);
    };
    const pick = (set: Set<string>, kind: PlacementKind, key: string): Field<string> => selectField<string>(plKind0 === kind ? plSrc0 : "", withCurrent([["", ""], ...Array.from(set).sort().map((x): [string, string] => [x, x])], plKind0 === kind ? plSrc0 : ""), { ro, key });
    const sheet = pick(sheets, "sheetname", "placementSheet"), cls = pick(classes, "component_class", "placementClass"), grp = pick(groups, "group", "placementGroup");
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const out = outlineFields(node, ro);
    const keepPage = h("div", { style: "padding:6px 8px;display:grid;gap:4px" }, tracks.el, vias.el, pads.el, pour.el, fps.el);
    const placePage = h("div", { style: "padding:6px 8px;display:grid;gap:4px" }, radio("none", "No placement"), radio("sheetname", "Place items from sheet:", sheet),
      radio("component_class", "Place items matching component class:", cls), radio("group", "Place items in group:", grp));
    body.append(h("div", { class: "pd-zone" }, layers.el,
      h("div", null,
        form([["Area name:", name.el]], true),
        notebook([
          { label: "Keepouts", build(el) { el.append(keepPage); } },
          { label: "Placement", build(el) { el.append(placePage); } },
        ]).el,
        h("div", { style: "padding:6px 0" }, form([["Outline display:", out.outline.el], ["Outline hatch pitch:", out.pitch.el, unitLabel()]]), locked.el))));
    return (n) => {
      const err = layers.apply(n); if (err) return err;
      if (name.get().trim()) put(n, "name", `(name ${quote(name.get().trim())})`, ["hatch", "priority", "connect_pads"]); else put(n, "name", null);
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      out.apply(n);
      const v = (f: Field<boolean>): string => (f.get() ? "not_allowed" : "allowed");
      put(n, "keepout", `(keepout (tracks ${v(tracks)}) (vias ${v(vias)}) (pads ${v(pads)}) (copperpour ${v(pour)}) (footprints ${v(fps)}))`, ["placement", "fill", "polygon"]);
      const src = plKind === "sheetname" ? sheet.get() : plKind === "component_class" ? cls.get() : plKind === "group" ? grp.get() : "";
      if (plKind !== plKind0 || src !== plSrc0) {
        const kindTok = plKind === "none" ? (plKind0 === "none" ? "sheetname" : plKind0) : plKind;
        put(n, "placement", `(placement (enabled ${plKind === "none" ? "no" : "yes"}) (${kindTok} ${quote(plKind === "none" ? "" : src)}))`, ["fill", "polygon"]);
      }
      void radios;
      return undefined;
    };
  }, create, "Edit Zone Properties");
}

// ---------------------------------------------------------------- Non Copper Zone Properties (DIALOG_NONCOPPER_ZONES_EDITOR)
function nonCopperZoneDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Non Copper Zone Properties", 640, (node, body, ro) => {
    const layers = zoneLayerList(doc, node, allLayers(doc).filter(([n]) => !/\.Cu$/.test(n)), ro);
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const out = outlineFields(node, ro);
    const fill = kid(node, "fill") || ["fill"];
    const minW = lenField(nval(kid(node, "min_thickness"), 1, 0.25), { ro, key: "minWidth" });
    const smooth = selectField<string>(sval(kid(fill, "smoothing")) || "none", [["none", "None"], ["chamfer", "Chamfer"], ["fillet", "Fillet"]], { ro, key: "smoothing" });
    const radius = lenField(nval(kid(fill, "radius")), { ro, key: "radius" });
    const hatchMode = sval(kid(fill, "mode")) === "hatch";
    const ftype = selectField<string>(hatchMode ? "hatch" : "solid", [["solid", "Solid fill"], ["hatch", "Hatch pattern"]], { ro, key: "fillType" });
    const orient = numField(nval(kid(fill, "hatch_orientation")), { ro, key: "hatchOrientation", digits: 1 });
    const hw = lenField(nval(kid(fill, "hatch_thickness"), 1, 1), { ro, key: "hatchWidth" }), hg = lenField(nval(kid(fill, "hatch_gap"), 1, 1.5), { ro, key: "hatchGap" });
    const effort = numField(nval(kid(fill, "hatch_smoothing_level")), { ro, key: "smoothingEffort", digits: 0 });
    effort.input.title = "Value of smoothing effort\n0 = no smoothing\n1 = chamfer\n2 = round corners\n3 = round corners (finer shape)";
    const amount = numField(nval(kid(fill, "hatch_smoothing_value"), 1, 0.1), { ro, key: "smoothingAmount", digits: 2 });
    amount.input.title = "Ratio between smoothed corners size and the gap between lines\n0 = no smoothing\n1.0 = max radius/chamfer size (half gap value)";
    body.append(h("div", { class: "pd-zone" }, layers.el,
      h("div", null,
        box("Shape", form([["Outline style:", out.outline.el], ["Outline hatch pitch:", out.pitch.el, unitLabel()], ["Minimum width:", minW.el, unitLabel()],
          ["Corner smoothing:", smooth.el], ["Chamfer distance:", radius.el, unitLabel()]]), locked.el),
        box("Fill", form([["Fill type:", ftype.el], ["Orientation:", orient.el, unitLabel("degree")], ["Hatch width:", hw.el, unitLabel()], ["Hatch gap:", hg.el, unitLabel()],
          ["Smoothing effort:", effort.el], ["Smoothing amount:", amount.el]])))));
    return (n) => {
      const err = layers.apply(n); if (err) return err;
      if (minW.get() < 0.001) return { msg: `Minimum width must be at least ${fmtLenU(0.001)}.`, focus: minW };
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      out.apply(n);
      put(n, "min_thickness", `(min_thickness ${f6(minW.get())})`, ["filled_areas_thickness", "fill", "polygon"]);
      let f = kid(n, "fill"); if (!f) { put(n, "fill", "(fill)", ["polygon", "filled_polygon"]); f = kid(n, "fill") as SNode; }
      if (smooth.get() === "none") { put(f, "smoothing", null); put(f, "radius", null); }
      else { put(f, "smoothing", `(smoothing ${smooth.get()})`, ["radius", "hatch_thickness"]); put(f, "radius", `(radius ${f6(radius.get())})`, ["hatch_thickness"]); }
      if (ftype.get() === "hatch") {
        put(f, "mode", "(mode hatch)", ["thermal_gap", "thermal_bridge_width", "smoothing", "radius", "island_removal_mode", "hatch_thickness"]);
        put(f, "hatch_thickness", `(hatch_thickness ${f6(hw.get())})`); put(f, "hatch_gap", `(hatch_gap ${f6(hg.get())})`); put(f, "hatch_orientation", `(hatch_orientation ${f6(orient.get())})`);
        put(f, "hatch_smoothing_level", `(hatch_smoothing_level ${Math.max(0, Math.min(3, Math.round(effort.get())))})`); put(f, "hatch_smoothing_value", `(hatch_smoothing_value ${f6(amount.get())})`);
      } else if (hatchMode) { put(f, "mode", null); }
      return undefined;
    };
  }, create, "Edit Zone Properties");
}
/** InvokeCopperZonesEditor / InvokeRuleAreaEditor / InvokeNonCopperZonesEditor on the template of a zone about to be drawn. */
// ---------------------------------------------------------------- Zone Manager
/**
 * DIALOG_ZONE_MANAGER (Edit > Zone Manager..., the zone dialog's Open Zone Manager...): the copper zones in priority
 * order (top = highest) with the name / net filter and the layer filter, Move Top / Up / Down / Bottom, and the zone
 * properties of the highlighted zone; OK writes every zone that changed as one "Zone Manager" commit, then refills
 * when Refill zones is ticked.
 */
export function openZoneManager(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const ro = !!ctx.viewOnly;
  const isCopperZone = (it: KItem): boolean => it.kind === "zone" && !kid(it.node, "keepout") && Array.from(zoneLayerSet(doc, it.node)).some((l) => /\.Cu$/.test(l));
  interface Row { item: KItem; name: string; net: string; layers: string[]; v0: ZoneDefaults; v: ZoneDefaults; prio0: number }
  const rows: Row[] = Array.from(doc.items.values()).filter(isCopperZone).map((it) => ({ item: it, name: sval(kid(it.node, "name")), net: PH().netNameOf(doc, it.node) || "", layers: Array.from(zoneLayerSet(doc, it.node)).filter((l) => /\.Cu$/.test(l)),
    v0: zoneValues(it.node), v: zoneValues(it.node), prio0: nval(kid(it.node, "priority")) }));
  rows.sort((a, b) => b.prio0 - a.prio0);   // ZONE_SETTINGS_BAG: the highest priority first
  if (!rows.length) { errorMessage("No copper zones on this board."); return true; }
  let sel = 0, panel: ReturnType<typeof zoneSettingsPanel> | null = null;
  const filter = h("input", { type: "search", class: "kd-input", placeholder: "Filter", "data-k": "zoneFilter", style: "width:100%" });
  const byName = checkField(true, "Name", { key: "filterName" }), byNet = checkField(true, "Net", { key: "filterNet" });
  const layerFilter = selectField<string>("", [["", "All Layers"], ...doc.copper.map((l): [string, string] => [l, layerLabel(doc, l)])], { key: "layerFilter" });
  const table = h("tbody"), right = h("div", { style: "min-width:0" });
  const visible = (r: Row): boolean => {
    const t = filter.value.trim().toLowerCase();
    if (t && !((byName.get() && r.name.toLowerCase().includes(t)) || (byNet.get() && r.net.toLowerCase().includes(t)))) return false;
    return !layerFilter.get() || r.layers.includes(layerFilter.get());
  };
  const keep = (): void => { if (panel && rows[sel]) rows[sel].v = panel.get(); };
  const selectOnCanvas = checkField(false, "Select on canvas", { key: "autoSelect", tip: "Select and focus the highlighted zone on the board canvas" });
  const showPanel = (): void => {
    const r = rows[sel]; if (!r) { right.replaceChildren(); panel = null; return; }
    panel = zoneSettingsPanel(r.v, ro);
    right.replaceChildren(h("div", { class: "pd-colhead" }, r.name || "(unnamed zone)", r.net ? `  [${r.net}]` : ""), panel.el);
    if (selectOnCanvas.get() && CollabTools.pcb) { (CollabTools.pcb.state as unknown as { sel: Set<string> }).sel = new Set([r.item.id]); ctx.requestRender(); }
  };
  const draw = (): void => {
    table.replaceChildren();
    rows.forEach((r, i) => {
      if (!visible(r)) return;
      const tr = h("tr", { class: i === sel ? "sel" : "", "data-row": i }, h("td", null, r.name), h("td", null, r.net), h("td", null, r.layers.map((l) => layerLabel(doc, l)).join(",")));
      tr.addEventListener("click", () => { keep(); sel = i; draw(); showPanel(); });
      table.append(tr);
    });
  };
  const move = (to: (i: number) => number): void => {
    keep(); const j = Math.max(0, Math.min(rows.length - 1, to(sel))); if (j === sel) return;
    const [r] = rows.splice(sel, 1); rows.splice(j, 0, r); sel = j; draw();
  };
  const TIP = "Top zone has the highest priority. When a zone is inside another zone, if its priority is higher, its outlines are removed from the other zone.";
  const mv = (label: string, fn: (i: number) => number): HTMLButtonElement => { const b = h("button", { type: "button", class: "btn", title: TIP, disabled: ro }, label); b.addEventListener("click", () => move(fn)); return b; };
  filter.addEventListener("input", draw); byName.input.addEventListener("change", draw); byNet.input.addEventListener("change", draw); layerFilter.input.addEventListener("change", draw);
  const refill = checkField(true, "Refill zones", { key: "repour", tip: "Refill zones after changes made on board" });
  openDialog({ title: "Zone Manager", width: 1000, readOnly: ro, persist: true,
    build(body) {
      const list = h("div", { class: "pd-grid", style: "max-height:360px" }, h("table", null, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Net"), h("th", null, "Layers"))), table));
      body.append(h("div", { class: "pd-cols2", style: "grid-template-columns:2fr 3fr;gap:12px" },
        h("div", null, filter, h("div", { class: "pd-row" }, byName.el, byNet.el, h("label", { style: "margin-left:auto" }, "Layer:"), layerFilter.el), list,
          h("div", { class: "pd-row", style: "margin-top:6px;flex-wrap:wrap" }, mv("Move to Top", () => 0), mv("Move Up", (i) => i - 1), mv("Move Down", (i) => i + 1), mv("Move to Bottom", () => rows.length - 1))),
        right), h("div", { class: "pd-row", style: "margin-top:8px" }, refill.el, selectOnCanvas.el));
      draw(); showPanel();
    },
    ok() {
      if (ro) return true;
      keep();
      const bad = panel ? panel.validate() : null; if (bad) { showApplyError({ msg: bad.msg, focus: bad.ctrl || null }); return false; }
      const changes: KChange[] = [];
      rows.forEach((r, i) => {
        const node = (K().cloneNode as (n: SNode) => SNode)(r.item.node), before = K().serialize(node);
        writeZone(node, r.v, r.v0);
        const prio = rows.length - 1 - i;   // the top of the list is the highest priority
        if (prio !== r.prio0) { if (prio) put(node, "priority", `(priority ${prio})`, ["connect_pads", "min_thickness"]); else put(node, "priority", null); }
        if (K().serialize(node) !== before) changes.push(K().replaceChange(doc, { ...r.item, node, geom: [], bbox: null }));
      });
      if (changes.length) ctx.commit(changes, "Zone Manager");
      if (refill.get() && changes.length) setTimeout(() => runKicadAction("zoneFillAll"), 0);
      return true;
    } });
  return true;
}
export function newZoneDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const item = { id: "", kind: "zone", node, geom: [], bbox: null } as unknown as KItem;
  const keepout = !!kid(node, "keepout"), copper = Array.from(zoneLayerSet(ctx.doc as KDoc, node)).some((l) => /\.Cu$/.test(l));
  const ok = keepout ? ruleAreaDialog(ctx, item, done) : copper ? zoneDialog(ctx, item, done) : nonCopperZoneDialog(ctx, item, done);
  if (!ok) done(null);
  return ok;
}

// ---------------------------------------------------------------- Text Properties
function fontFlags(doc: KDoc, font: SNode, flag: "bold" | "italic", on: boolean): void {
  const bare = font.indexOf(flag); if (bare > 0) font.splice(bare, 1);
  const modern = ((doc as KDoc & { version?: number }).version || 20240108) >= 20230000;
  put(font, flag, null);
  if (!on) return;
  if (modern) put(font, flag, `(${flag} yes)`, flag === "bold" ? ["italic", "color"] : ["color"]); else font.push(flag);
}
// EDA_TEXT: TEXT_MIN_SIZE_MM / TEXT_MAX_SIZE_MM; GetPenSizeForNormal; ClampTextPenSize (not strict)
const TEXT_MIN_SIZE = 0.001, TEXT_MAX_SIZE = 250;
const penForNormal = (size: number): number => +(size / 8).toFixed(6);
/** UNIT_BINDER::Validate's message ("Width must be at least 0.001 mm."), or null. */
function sizeError(label: string, v: number): string | null {
  if (v < TEXT_MIN_SIZE) return `${label} must be at least ${fmtLenU(TEXT_MIN_SIZE)}.`;
  if (v > TEXT_MAX_SIZE) return `${label} must be less than ${fmtLenU(TEXT_MAX_SIZE)}.`;
  return null;
}
/** EDA_ANGLE::Normalize180 / Normalize, to the angle binder's three decimals. */
const norm180 = (a: number): number => { let r = a % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return +r.toFixed(3); };
const norm360 = (a: number): number => { let r = a % 360; if (r < 0) r += 360; return +r.toFixed(3); };
/** The orientation combo: a degrees field with the text dialogs' 0.0 / 90.0 / -90.0 / 180.0 presets, or the ones
 *  given (dialog_footprint_properties_base.cpp m_orientationCtrl: 0 / 90 / -90 / 180). */
function orientationField(deg: number, ro: boolean, key: string, presets = ["0.0", "90.0", "-90.0", "180.0"]): Field<number> {
  const f = numField(norm180(deg), { ro, key, digits: 3 });
  comboBox(f.input as HTMLInputElement, () => presets);
  return f;
}
/** DIALOG_TEXT_PROPERTIES' shared controls over one text node (gr_text, fp_text or a footprint property):
 *  layer, knockout, font, the toggle row, size, thickness with auto, position and orientation.  apply writes
 *  them back to a text node and returns an error to block OK. */
function textControls(doc: KDoc, node: SNode, ro: boolean, posLabels: [string, string]) {
  const at = K().atOf(node), ly = kid(node, "layer"), fx = FH().fieldEffects(node);
  const eff = kid(node, "effects"), font = eff ? kid(eff, "font") : null, sz = font ? kid(font, "size") : null;
  const layer = selectField<string>(sval(ly), withCurrent(allLayers(doc), sval(ly)), { ro, key: "layer" });
  const knockout = checkField(!!ly && ly.includes("knockout"), "Knockout", { ro, key: "knockout" });
  // the BITMAP_BUTTONs: bold, italic | left, center, right | top, center, bottom | mirrored
  const bold = iconToggle("bold", "Bold", fx.bold, { ro, key: "bold" }), italic = iconToggle("italic", "Italic", fx.italic, { ro, key: "italic" });
  const hBtn = (v: string, icon: "alignLeft" | "alignCenter" | "alignRight", tip: string) => iconToggle(icon, tip, fx.h === v, { ro, key: "align-" + v, group: "h" });
  const vBtn = (v: string, icon: "valignTop" | "valignCenter" | "valignBottom", tip: string) => iconToggle(icon, tip, fx.v === v, { ro, key: "valign-" + v, group: "v" });
  const hl = hBtn("left", "alignLeft", "Align left"), hc = hBtn("center", "alignCenter", "Align horizontal center"), hr = hBtn("right", "alignRight", "Align right");
  const vt = vBtn("top", "valignTop", "Align top"), vc = vBtn("center", "valignCenter", "Align vertical center"), vb = vBtn("bottom", "valignBottom", "Align bottom");
  const mirror = iconToggle("mirror", "Mirrored", fx.mirror, { ro, key: "mirror" });
  const sep = () => h("span", { class: "vsep" });
  const toggles = h("div", { class: "pd-togrow" }, bold.el, italic.el, sep(), hl.el, hc.el, hr.el, sep(), vt.el, vc.el, vb.el, sep(), mirror.el);
  const w = lenField(nval(sz, 2, 1), { ro, key: "width" }), ht = lenField(nval(sz, 1, 1), { ro, key: "height" });
  // GetAutoThickness: no (thickness) in the file; the field shows the base width, frozen
  const auto0 = !!font && !kid(font, "thickness");
  const th = lenField(auto0 ? penForNormal(nval(sz, 2, 1)) : fx.thick, { ro: ro || auto0, key: "thickness" });
  const autoTh = iconToggle("link", "Adjust the text thickness", auto0, { ro, key: "autoThickness", onChange: (on) => { (th.input as HTMLInputElement).disabled = ro || on; if (on) th.set(penForNormal(w.get())); } });
  w.input.addEventListener("change", () => { if (autoTh.get()) th.set(penForNormal(w.get())); });   // onTextSize
  const face0 = faceOfFont(font);
  const thRow = h("div", { class: "pd-form", style: "grid-column:1/-1" }, h("label", null, "Thickness:"), h("span", { style: "display:flex;gap:4px;align-items:center" }, th.el, autoTh.el), unitLabel());
  // onFontSelected: the thickness only for the stroke font
  const strokeOnly = (face: string): void => { const stroke = !face || face === KICAD_FONT; thRow.style.display = stroke ? "" : "none"; };
  const face = fontField(doc, face0, { ro, key: "face", onChange: (v) => strokeOnly(v) });
  const x = coordField(at[0], "x", { ro, key: "x" }), y = coordField(at[1], "y", { ro, key: "y" }), rot = orientationField(at[2] || 0, ro, "orientation");
  strokeOnly(face0);
  const left = form([["Layer:", layer.el], knockout.el, ["Font:", face.el], toggles], true);
  const sizes = form([["Width:", w.el, unitLabel(), "Text width"], ["Height:", ht.el, unitLabel(), "Text height"]]);
  const place = form([[posLabels[0], x.el, unitLabel(), "Text pos X"], [posLabels[1], y.el, unitLabel(), "Text pos Y"], ["Orientation:", rot.el, unitLabel("deg"), "Text orientation"]]);
  const apply = (n: SNode): ApplyError | undefined => {
    const ew = sizeError("Width", w.get()); if (ew) return { msg: ew, focus: w };
    const eh = sizeError("Height", ht.get()); if (eh) return { msg: eh, focus: ht };
    const a = kid(n, "at"), r = norm360(rot.get());
    if (a && a.length > 3 && typeof a[3] !== "number") { a[1] = +f6(x.get()); a[2] = +f6(y.get()); if (r) a.splice(3, 0, r); }   // (at x y unlocked)
    else K().setAt(n, +f6(x.get()), +f6(y.get()), a && a.length < 4 && !r ? undefined : r);
    put(n, "layer", `(layer ${quote(layer.get())}${knockout.get() ? " knockout" : ""})`, ["hide", "uuid", "tstamp", "effects"]);
    let e = kid(n, "effects"); if (!e) { put(n, "effects", "(effects (font (size 1 1) (thickness 0.15)))"); e = kid(n, "effects") as SNode; }
    let f = kid(e, "font"); if (!f) { e.splice(1, 0, K().parse("(font)") as SNode); f = kid(e, "font") as SNode; }
    if (face.get() !== face0) setFaceOfFont(f, face.get());
    put(f, "size", `(size ${f6(ht.get())} ${f6(w.get())})`, ["thickness", "bold", "italic"]);
    let clamped = false;
    if (autoTh.get()) { if (!auto0) put(f, "thickness", null); }
    else {
      let tv = th.get();
      const maxPen = +(Math.min(Math.abs(w.get()), Math.abs(ht.get())) * 0.25).toFixed(6);
      if (tv > maxPen) { tv = maxPen; clamped = true; }
      if (auto0 || Math.abs(tv - fx.thick) > 1e-9) put(f, "thickness", `(thickness ${f6(tv)})`, ["bold", "italic", "color"]);
    }
    if (bold.get() !== fx.bold) fontFlags(doc, f, "bold", bold.get());
    if (italic.get() !== fx.italic) fontFlags(doc, f, "italic", italic.get());
    const hj = hl.get() ? "left" : hc.get() ? "center" : "right", vj = vb.get() ? "bottom" : vc.get() ? "center" : "top";
    if (hj !== fx.h || vj !== fx.v || mirror.get() !== fx.mirror) {
      const j: string[] = []; if (hj !== "center") j.push(hj); if (vj !== "center") j.push(vj); if (mirror.get()) j.push("mirror");
      put(e, "justify", j.length ? `(justify ${j.join(" ")})` : null, ["hide", "href"]);
    }
    if (clamped) messageBox("Error", "The text thickness is too large for the text size.\nIt will be clamped.");
    return undefined;
  };
  return { left, sizes, thRow, place, apply };
}
function textDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Text Properties", 600, (node, body, ro) => {
    const text = h("textarea", { class: "pd-text", style: "min-height:90px", readOnly: ro, "data-key": "text" }); const xref = boardXref(doc), shownText = xref.toRefs(sval(node)); text.value = shownText;   // the reader already turned the file's "\\n" into new lines; cross-references shown as ${REF:FIELD}
    text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); if (ev.shiftKey) { ev.preventDefault(); const ok = (body.parentElement as HTMLElement).querySelector<HTMLButtonElement>(".kd-foot > button:last-child"); if (ok) ok.click(); } } });   // SCINTILLA_TRICKS: Shift+Enter accepts, Enter is a new line
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const c = textControls(doc, node, ro, ["Position X:", "Position Y:"]);
    const help = syntaxHelpLink(true); help.style.margin = "3px";
    body.append(h("label", { class: "pd-lbl" }, "Text:"), text, h("div", null, help), h("div", { class: "pd-row", style: "margin-top:8px" }, locked.el),
      h("div", { class: "pd-cols2" }, c.left, h("div", null, c.sizes, c.thRow, c.place)));
    return (n) => {
      const err = c.apply(n); if (err) return err;
      const t = text.value.replace(/\r/g, "");   // new lines stay new lines: the writer escapes them as "\\n"
      if (t && t !== shownText) { const stored = xref.toKiids(t); if (stored !== sval(n)) n[1] = stored; }   // an emptied text keeps its old one
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      return undefined;
    };
  }, create, "Edit Text Properties");
}
/** A footprint text's (locked yes): right after its name and text, before (at). */
function setTextLocked(n: SNode, on: boolean): void {
  const bare = n.indexOf("locked"); if (bare > 0) n.splice(bare, 1);
  put(n, "locked", null);
  if (!on) return;
  const a = kid(n, "at"); n.splice(a ? n.indexOf(a) : n.length, 0, ["locked", "yes"]);
}
/** KIUI::SelectReferenceNumber: the number part of "R12" (or the "?" of "R?"), else everything. */
function selectReferenceNumber(input: HTMLInputElement): void {
  const v = input.value; let i = v.length;
  while (i > 0 && /[0-9?]/.test(v[i - 1])) i--;
  if (i < v.length && i > 0) input.setSelectionRange(i, v.length); else input.select();
}
/** DIALOG_TEXT_PROPERTIES on a footprint's field: "Footprint Reference / Value / Field Properties", a single-line
 *  text, Show and Keep upright, Offset X / Y and the "Footprint R1 (10k), front side, rotated 90.0 deg" status line. */
export function fpFieldDialog(ctx: ToolCtx, item: KItem, name: string): boolean {
  const doc = ctx.doc as KDoc; if (!doc || doc.type !== "pcb" || item.kind !== "footprint") return false;
  const p0 = FH().fieldNode(item.node, name); if (!p0) return false;
  const isRef = name === "Reference", isVal = name === "Value";
  const title = isRef ? "Footprint Reference Properties" : isVal ? "Footprint Value Properties" : "Footprint Field Properties";
  return itemDialog(ctx, item, title, 600, (fp, body, ro) => {
    const p = FH().fieldNode(fp, name) as SNode;
    const xref = boardXref(doc), shown = xref.toRefs(sval(p, 2));
    const text = h("input", { type: "text", class: "pd-text", readOnly: ro, "data-k": "text", value: shown }) as HTMLInputElement;
    text.value = shown;
    const locked = checkField(PT().isLocked(p), "Locked", { ro, key: "locked" });
    const c = textControls(doc, p, ro, ["Offset X:", "Offset Y:"]);
    const visible = checkField(!FH().fieldHidden(p), "Visible", { ro, key: "visible" });
    const upright = checkField(!FH().fieldUnlocked(p), "Keep upright", { ro, key: "keepUpright" });
    const fa = K().atOf(fp), fref = sval(FH().fieldNode(fp, "Reference"), 2), fval = sval(FH().fieldNode(fp, "Value"), 2);
    const back = sval(kid(fp, "layer")) === "B.Cu";
    const status = h("div", { class: "pd-status", "data-key": "status" }, `Footprint ${fref} (${fval}), ${back ? "back side (mirrored)" : "front side"}, rotated ${(fa[2] || 0).toFixed(1)} deg`);
    body.append(h("div", { class: "pd-form" }, h("label", null, isRef ? "Reference:" : isVal ? "Value:" : "Text:"), text),
      h("div", { class: "pd-row", style: "margin-top:8px" }, locked.el),
      h("div", { class: "pd-cols2" }, h("div", null, c.left, h("div", { class: "pd-row" }, visible.el), h("div", { class: "pd-row" }, upright.el)), h("div", null, c.sizes, c.thRow, c.place)),
      status);
    requestAnimationFrame(() => { text.focus(); if (isRef) selectReferenceNumber(text); else text.select(); });
    return (n) => {
      const q = FH().fieldNode(n, name); if (!q) return undefined;
      const err = c.apply(q); if (err) return err;
      const t = text.value;
      if (t && t !== shown) { const stored = xref.toKiids(t); if (stored !== sval(q, 2)) q[2] = stored; }   // an empty text keeps its old one
      if (locked.get() !== PT().isLocked(q)) setTextLocked(q, locked.get());
      if (visible.get() === FH().fieldHidden(q)) FH().setFieldHidden(n, q, !visible.get());
      if (upright.get() === FH().fieldUnlocked(q)) FH().setFieldUnlocked(q, !upright.get());
      return undefined;
    };
  }, undefined, "Edit " + name + " Field");
}
/** DIALOG_TEXT_PROPERTIES on a new text (DRAWING_TOOL::PlaceText): done gets the edited node, or null on Cancel. */
export function newTextDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = textDialog(ctx, { id: "", kind: "gr_text", node, geom: [], bbox: null } as unknown as KItem, done);
  if (!ok) done(null);
  return ok;
}

// ---------------------------------------------------------------- <Shape> Properties
const SHAPE_NAMES: Record<string, string> = { gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", gr_curve: "Bezier" };
// lineTypeNames (stroke_params.cpp): no "Default" entry, a default stroke (LINE_STYLE::DEFAULT, -1) shows as Solid
const LINE_STYLES: [string, string][] = [["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
// SEXPR_BOARD_FILE_VERSION: what an older board can't hold without a format bump
const SHAPE_HATCH_VERSION = 20250222, ROUNDRECT_VERSION = 20250829, SHAPE_MASK_VERSION = 20241010;
type Geom = { kind: string } & Record<string, unknown>;
interface GeomGroup { title: string; x?: string; y?: string; size?: boolean; field?: string; kind?: "len" | "angle" }
interface GeomPage { title: string; groups: GeomGroup[]; get(g: Geom): Record<string, number>; set(v: Record<string, number>, g: Geom): Geom | null; validate?(v: Record<string, number>): string | null }
interface GeomApi { geomPages(kind: string): GeomPage[]; shapeGeomOf(n: SNode): Geom | null; setShapeGeom(n: SNode, g: Geom): void }
const GT = (): GeomApi => (window as unknown as { PcbTools: GeomApi }).PcbTools;
/** s_lastTabForShape */
const lastShapeTab = new Map<string, number>();
const isExtCopper = (l: string): boolean => l === "F.Cu" || l === "B.Cu";
function shapeDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc, kind = item.kind, version = (doc as KDoc & { version?: number }).version || 0;
  return itemDialog(ctx, item, `${SHAPE_NAMES[kind]} Properties`, 620, (node, body, ro) => {
    // the geometry notebook: every page's fields, kept in step with one working geometry
    let geom = GT().shapeGeomOf(node);
    const pages = geom ? GT().geomPages(geom.kind) : [];
    const fields = pages.map((pg, pi) => {
      const v = pg.get(geom as Geom), out: Record<string, Field<number>> = {};
      for (const g of pg.groups) {
        if (g.field) out[g.field] = g.kind === "angle" ? numField(+(v[g.field] || 0).toFixed(6), { ro, key: `g${pi}-${g.field}`, digits: 3 }) : lenField(v[g.field] || 0, { ro, key: `g${pi}-${g.field}` });
        else if (g.x && g.y) {
          out[g.x] = g.size ? lenField(v[g.x], { ro, key: `g${pi}-${g.x}` }) : coordField(v[g.x], "x", { ro, key: `g${pi}-${g.x}` });
          out[g.y] = g.size ? lenField(v[g.y], { ro, key: `g${pi}-${g.y}` }) : coordField(v[g.y], "y", { ro, key: `g${pi}-${g.y}` });
        }
      }
      return out;
    });
    const read = (pi: number): Record<string, number> => { const o: Record<string, number> = {}; for (const [k, f] of Object.entries(fields[pi])) o[k] = f.get(); return o; };
    const refresh = (except: number): void => { pages.forEach((pg, pi) => { if (pi === except) return; const v = pg.get(geom as Geom); for (const [k, f] of Object.entries(fields[pi])) f.set(+(+v[k]).toFixed(6)); }); };
    const pageEl = (pi: number): HTMLElement => {
      const wrap = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;padding:6px 2px" });
      for (const g of pages[pi].groups) {
        if (g.field) { const f = fields[pi][g.field]; wrap.append(h("div", null, form([[g.title + ":", f.el, g.kind === "angle" ? unitLabel("deg") : unitLabel()]]))); continue; }
        const fx = fields[pi][g.x as string], fy = fields[pi][g.y as string];
        wrap.append(h("div", null, h("div", { class: "pd-lbl", style: "font-weight:600;margin-bottom:2px" }, g.title),
          form([[g.size ? "Width:" : "X:", fx.el, unitLabel()], [g.size ? "Height:" : "Y:", fy.el, unitLabel()]])));
      }
      wrap.addEventListener("change", () => { const ng = pages[pi].set(read(pi), geom as Geom); if (ng) { geom = ng; refresh(pi); } });
      return wrap;
    };
    const nb = pages.length ? notebook(pages.map((pg, pi) => ({ label: pg.title, build: (el: HTMLElement) => { el.append(pageEl(pi)); } })),
      { start: Math.min(lastShapeTab.get(kind) || 0, pages.length - 1) }) : null;
    // the polygon has no syncer: its points are edited on the canvas
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const r0 = kind === "gr_rect" ? nval(kid(node, "radius"), 1, 0) : 0;
    const rrOk = version >= ROUNDRECT_VERSION || r0 > 0;
    const roundRect = checkField(r0 > 0, "Rounded rectangle", { ro: ro || !rrOk, key: "roundRect" });
    const cornerR = lenField(r0 > 0 ? r0 : NaN, { ro: ro || !rrOk, key: "cornerRadius", allowEmpty: true });
    roundRect.input.addEventListener("change", () => { if (!roundRect.get()) (cornerR.input as HTMLInputElement).value = ""; });   // onRoundedRectChanged
    cornerR.input.addEventListener("input", () => roundRect.set(true));   // onCornerRadius
    if (!rrOk) roundRect.el.title = cornerR.input.title = "This board's file format has no rounded rectangles.";
    const stroke = kid(node, "stroke"), legacyW = kid(node, "width");
    const width = lenField(stroke ? nval(kid(stroke, "width")) : nval(legacyW), { ro, key: "lineWidth" });
    const style0 = ((t: string) => (LINE_STYLES.some(([k]) => k === t) ? t : "solid"))(sval(stroke ? kid(stroke, "type") : null));
    const style = selectField<string>(style0, LINE_STYLES, { ro: ro || !stroke, key: "lineStyle" });
    const closed = kind === "gr_rect" || kind === "gr_circle" || kind === "gr_poly";
    const fk = kid(node, "fill"), fv = sval(fk);
    const fill0 = fv === "solid" || fv === "yes" ? "solid" : fv === "hatch" || fv === "reverse_hatch" || fv === "cross_hatch" ? fv : "none";
    const hatchOk = version >= SHAPE_HATCH_VERSION || fill0 !== "none" && fill0 !== "solid";
    const fillOpts: [string, string][] = [["none", "None"], ["solid", "Solid"], ...(hatchOk ? [["hatch", "Hatch"], ["reverse_hatch", "Reverse Hatch"], ["cross_hatch", "Cross-hatch"]] as [string, string][] : [])];
    const fill = selectField<string>(fill0, fillOpts, { ro: ro || !closed, key: "fill" });
    const ly = sval(kid(node, "layer")) || (() => { const ls = kid(node, "layers"); return ls ? sval(ls) : ""; })();
    const layer = selectField<string>(ly, withCurrent(allLayers(doc), ly), { ro, key: "layer" });
    const net = netField(doc, node, ro);
    const lsNode = kid(node, "layers"), mask0 = !!lsNode && lsNode.slice(1).some((x) => /\.Mask$/.test(String(x)));
    const mm0 = kid(node, "solder_mask_margin");
    const maskOk = version >= SHAPE_MASK_VERSION || mask0;
    const hasMask = checkField(mask0, "Solder mask", { ro: ro || !maskOk, key: "solderMask" });
    const maskMargin = lenField(mm0 ? nval(mm0) : NaN, { ro: ro || !maskOk, key: "maskMargin", allowEmpty: true });
    maskMargin.input.title = "This is the local clearance between the shape and the solder mask opening.\nLeave blank to use the value defined in the Board Setup.";
    const nowrap = "display:flex;align-items:center;gap:10px;white-space:nowrap";
    const techEl = h("div", null, h("div", { class: "pd-lbl", style: "font-weight:600;margin:8px 0 2px" }, "Technical Layers"), h("hr", { class: "pd-sep" }),
      h("div", { style: nowrap }, hasMask.el, h("label", null, "Expansion:"), h("span", { style: "flex:1" }, maskMargin.el), unitLabel()));
    const netLabel = h("label", null, "Net:");
    // enableNetInfo / enableTechLayers
    const enable = (): void => {
      const l = layer.get(), copper = doc.copper.includes(l), ext = isExtCopper(l);
      (net.input as HTMLElement & { disabled: boolean }).disabled = ro || !copper; netLabel.classList.toggle("dim", !copper);
      (hasMask.input as HTMLInputElement).disabled = ro || !ext || !maskOk; techEl.classList.toggle("dim", !ext);
      (maskMargin.input as HTMLInputElement).disabled = ro || !ext || !hasMask.get() || !maskOk;
    };
    layer.input.addEventListener("change", enable); hasMask.input.addEventListener("change", enable);
    const f = h("div", { class: "pd-form wide" });
    const row = (label: HTMLElement | string, ctrl: HTMLElement, unit?: HTMLElement): void => { f.append(typeof label === "string" ? h("label", null, label) : label, ctrl, unit || h("span")); };
    if (kind === "gr_rect") f.append(h("div", { class: "span", style: nowrap }, roundRect.el, h("label", { style: "margin-left:12px" }, "Corner radius:"), h("span", { style: "flex:1" }, cornerR.el), unitLabel()));
    row("Line width:", width.el, unitLabel()); row("Line style:", style.el);
    if (closed) row("Fill:", fill.el);
    row(netLabel, net.el); row("Layer:", layer.el);
    body.append(...(nb ? [nb.el] : []), h("div", { class: "pd-row", style: "margin:8px 0" }, locked.el), f, techEl);
    enable();
    return (n) => {
      const errors: string[] = [];
      if (nb) { const pi = nb.current(), pg = pages[pi], e = pg.validate ? pg.validate(read(pi)) : null; if (e) errors.push(e); }
      const solid = fill.get() === "solid", w = width.get();
      if ((kind === "gr_line" || kind === "gr_arc") && !(w > 0)) errors.push("Line width must be greater than zero.");
      else if (kind === "gr_circle" && !solid && !(w > 0)) errors.push("Line width must be greater than zero for an unfilled circle.");
      else if (kind === "gr_rect" && !solid && !(w > 0)) errors.push("Line width must be greater than zero for an unfilled rectangle.");
      else if (kind === "gr_poly" && !solid && !(w > 0)) errors.push("Line width must be greater than zero for an unfilled polygon.");
      else if (kind === "gr_curve" && !(w > 0)) errors.push("Line width must be greater than zero for an unfilled curve.");
      if (kind === "gr_rect" && roundRect.get() && geom && geom.kind === "rect") {
        const g = geom as unknown as { start: number[]; end: number[] }, shortSide = Math.min(Math.abs(g.end[0] - g.start[0]), Math.abs(g.end[1] - g.start[1]));
        if (cornerR.get() * 2 > shortSide + 1e-9) { errors.push("Corner radius must be less than or equal to half the smaller side."); cornerR.set(+(shortSide / 2).toFixed(6)); }
      }
      if (errors.length) { messageBox("Error List", errors.join("\n")); return { msg: "" }; }
      if (nb) lastShapeTab.set(kind, nb.current());
      if (geom) GT().setShapeGeom(n, geom);
      if (kind === "gr_rect") {
        const r = roundRect.get() && isFinite(cornerR.get()) ? cornerR.get() : 0;
        if (Math.abs(r - r0) > 1e-9) put(n, "radius", r > 0 ? `(radius ${f6(r)})` : null, ["stroke", "width", "fill", "layer"]);
      }
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      const s = kid(n, "stroke");
      if (s) { put(s, "width", `(width ${f6(w)})`, ["type"]); if (style.get() !== style0) put(s, "type", `(type ${style.get()})`); }
      else put(n, "width", `(width ${f6(w)})`, ["layer"]);
      if (closed && fill.get() !== fill0) {
        const yn = fv === "yes" || fv === "no" || (!fk && version >= 20240000);
        const tok = fill.get() === "solid" ? (yn ? "yes" : "solid") : fill.get() === "none" ? (yn ? "no" : "none") : fill.get();
        put(n, "fill", `(fill ${tok})`, ["locked", "layer", "layers", "uuid"]);
      }
      const L = layer.get(), ext = isExtCopper(L), mask = ext && hasMask.get();
      if (L !== ly || mask !== mask0) {
        put(n, "layer", null); put(n, "layers", null);
        const maskLayer = L === "F.Cu" ? "F.Mask" : "B.Mask";
        if (mask) put(n, "layers", `(layers ${quote(L)} ${quote(maskLayer)})`, ["solder_mask_margin", "net", "uuid", "tstamp"]);
        else put(n, "layer", `(layer ${quote(L)})`, ["solder_mask_margin", "net", "uuid", "tstamp"]);
      }
      const mmv = maskMargin.get(), m0 = mm0 ? nval(mm0) : NaN;
      if (!mask) { if (mm0) put(n, "solder_mask_margin", null); }
      else if (!(isFinite(mmv) && isFinite(m0) && Math.abs(mmv - m0) < 1e-9)) put(n, "solder_mask_margin", isFinite(mmv) ? `(solder_mask_margin ${f6(mmv)})` : null, ["net", "uuid", "tstamp"]);
      // SetNetCode: the net on copper, none elsewhere
      const netName = doc.copper.includes(L) ? net.get() : "";
      if (netName !== PH().netNameOf(doc, n)) setNet(doc, n, netName);
      return undefined;
    };
  }, undefined, "Edit Shape Properties");
}

// ---------------------------------------------------------------- Footprint Properties
/**
 * The General page's Update Footprint from Library… / Change Footprint… / Edit Footprint… / Edit Library Footprint…
 * buttons: TransferDataFromWindow (the dialog's edits stored, as OK does), Close, then PCB_EDIT_FRAME::OnEditItemRequest
 * runs the exchange dialog (FP_PROPS_UPDATE_FP / FP_PROPS_CHANGE_FP) or opens the Footprint Editor.
 */
function fpButtons(ctx: ToolCtx, item: KItem, body: HTMLElement): HTMLElement {
  const go = (action: string): void => {
    const dlg = body.parentElement as HTMLElement | null;
    const btns = dlg ? Array.from(dlg.querySelectorAll<HTMLButtonElement>(".kd-foot > button")) : [];
    const ok = btns[btns.length - 1];
    if (ok) ok.click();
    if (dlg && dlg.isConnected) return;                 // the edits did not validate: the dialog stays
    setTimeout(() => {
      const P = PT() as unknown as { applySelection?(c: ToolCtx, ids: string[]): void };
      if (P.applySelection && ctx.doc && ctx.doc.items.has(item.id)) P.applySelection(ctx, [item.id]);
      runKicadAction(action);
    }, 0);
  };
  const b = (label: string, action: string): HTMLButtonElement => { const el = h("button", { type: "button", class: "btn", "data-k": action }, label) as HTMLButtonElement; el.disabled = (!!ctx.viewOnly && /^(update|change)/.test(action)) || !kicadActionAvailable(action); el.addEventListener("click", () => go(action)); return el; };
  return h("div", { class: "pd-row", style: "margin-top:8px;justify-content:flex-end" },
    b("Update Footprint from Library...", "updateFootprint"), b("Change Footprint...", "changeFootprint"),
    b("Edit Footprint...", "editFpInFpEditor"), b("Edit Library Footprint...", "editLibFpInFpEditor_board"));
}
function footprintDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Footprint Properties", 900, (node, body, ro) => {
    const props = (n: SNode): SNode[] => (K().kids(n, "property") as SNode[]).filter((p) => p.some((c) => isList(c)) && !String(p[1]).startsWith("ki_"));
    const MAND = ["Reference", "Value", "Datasheet", "Description"];
    // MANDATORY_FIELDS (template_fieldnames.h): the parser folds these names case-insensitively, so FieldNamesAreDuplicates
    // takes any case of one of them for that field (Footprint is read and dropped: a field by that name would be lost)
    const RESERVED = ["Reference", "Value", "Footprint", "Datasheet", "Description"].map((m) => m.toLowerCase());
    const duplicates = (a: string, b: string): boolean => a === b || (a.toLowerCase() === b.toLowerCase() && RESERVED.includes(a.toLowerCase()));
    const label = (n: string): string => (n === "Reference" ? "Reference designator" : n);
    const xref = boardXref(doc);   // field text shows cross-references as ${REF:FIELD} (dialog_footprint_properties.cpp:272, 603)
    // the board's current variant (the toolbar's): fields and the DNP / BOM / position-file / simulation flags show
    // and write the footprint's (variant …) (dialog_footprint_properties.cpp:263-312, 586-715)
    const variant = String((E as { currentVariant?: string }).currentVariant || "");
    const fieldText = (p: SNode): string => (variant ? VM.footprintFieldForVariant(node, variant, String(p[1])) : sval(p, 2));
    const fpRot0 = K().atOf(node)[2] || 0;
    const relRot = (abs: number): number => +(abs - fpRot0).toFixed(3);
    const rows: Record<string, CellValue>[] = props(node).map((p) => {
      const fx = FH().fieldEffects(p), a = FH().fieldAt(p), e = kid(p, "effects"), f = e ? kid(e, "font") : null, sz = f ? kid(f, "size") : null;
      return { name: String(p[1]), label: MAND.includes(String(p[1])) ? label(String(p[1])) : String(p[1]), value: xref.toRefs(fieldText(p)), show: !FH().fieldHidden(p), w: nval(sz, 2, fx.size), ht: nval(sz, 1, fx.size), th: fx.thick || 0.15, italic: fx.italic, layer: FH().fieldLayer(p), rot: relRot(a[2] || 0), x: a[0], y: a[1] };
    });
    const mandRow = (r: Record<string, CellValue>): boolean => MAND.includes(String(r.name));
    const g = grid([{ label: "Name", key: "label", width: "130px", readOnly: (r) => mandRow(r) }, { label: "Value", key: "value" }, { label: "Show", key: "show", type: "check" }, { label: "Width", key: "w", type: "len" }, { label: "Height", key: "ht", type: "len" }, { label: "Thickness", key: "th", type: "len" },
      { label: "Italic", key: "italic", type: "check" }, { label: "Layer", key: "layer", type: "select", options: allLayers(doc), width: "120px" }, { label: "Orientation", key: "rot", type: "num" }, { label: "X Offset", key: "x", type: "len" }, { label: "Y Offset", key: "y", type: "len" }], rows, { ro, height: "170px" });
    const at = K().atOf(node), side0 = sval(kid(node, "layer")) || "F.Cu";
    // OnAddField: "Field<n>", hidden, on the side's Fab layer at the footprint origin, styled by StyleFromSettings (the
    // board's Fab text size, thickness, italic, keep upright; mirrored on the back); OnDeleteField keeps the mandatory four
    const fab = side0 === "B.Cu" ? "B.Fab" : "F.Fab", fabStyle = PT().layerStyle(fab);
    const gbar = gridButtons(g, () => ({ name: "", label: "Field" + (g.rows().length + MAND.filter((m) => !g.rows().some((r) => r.name === m)).length), value: "", show: false, w: fabStyle.w, ht: fabStyle.h, th: fabStyle.thick, italic: fabStyle.italic, layer: fab, rot: 0, x: 0, y: 0 }),
      { ro, addTip: "Add field", delTip: "Delete field", canDelete: (r) => { if (!mandRow(r)) return true; messageBox("Error", `The first ${MAND.length} fields are mandatory.`); return false; } });
    const x = coordField(at[0], "x", { ro, key: "x" }), y = coordField(at[1], "y", { ro, key: "y" }), rot = orientationField(at[2] || 0, ro, "orientation", ["0", "90", "-90", "180"]);
    const side = selectField<string>(side0, [["F.Cu", "Front"], ["B.Cu", "Back"]], { ro, key: "side" });
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const attrs = PH().footprintAttrs(node);
    const type = selectField<string>(attrs.type, [["through_hole", "Through hole"], ["smd", "SMD"], ["", "Unspecified"]], { ro, key: "fpType" });
    const FLAGS: [string, string][] = [["exclude_from_sim", "Exclude from simulation"], ["board_only", "Not in schematic"], ["dnp", "Do not populate"], ["exclude_from_bom", "Exclude from bill of materials"], ["exclude_from_pos_files", "Exclude from position files"]];
    const vflags = variant ? VM.footprintFlagsForVariant(node, variant) : null;
    const flagOf = (k: string): boolean => (vflags && k in vflags ? vflags[k as keyof VM.FpFlags] : !!attrs[k]);
    const flags = FLAGS.map(([k, l]) => ({ k, f: checkField(flagOf(k), l, { ro, key: k }) }));
    // clearance overrides: blank means "use the Board Setup value"
    const ov = (key: string, k: string): Field<number> => lenField(kid(node, key) ? nval(kid(node, key)) : NaN, { ro, key: k, allowEmpty: true });
    const clr = ov("clearance", "padClearance"), mask = ov("solder_mask_margin", "maskExpansion"), paste = ov("solder_paste_margin", "pasteClearance");
    const zc = kid(node, "zone_connect"), zone = selectField<string>(zc ? String(zc[1]) : "", [["", "Use zone setting"], ["2", "Solid"], ["1", "Thermal relief"], ["0", "None"]], { ro, key: "zoneConnect" });
    const general = h("div", null, box("Fields", g.el, gbar),
      h("div", { class: "pd-cols2" },
        box("Position", form([["X:", x.el, unitLabel()], ["Y:", y.el, unitLabel()], ["Orientation:", rot.el, unitLabel("deg")], ["Side:", side.el]]), locked.el),
        box("Fabrication Attributes", form([["Footprint type:", type.el]], true), ...flags.map((f) => f.f.el))),
      form([["Library link:", h("span", { class: "pd-value" }, String(node[1] ?? ""))]], true), fpButtons(ctx, item, body));
    const clearances = h("div", null, h("p", { class: "pd-note" }, "Leave values blank to use Board Setup values."),
      box("Clearances", form([["Pad clearance:", clr.el, unitLabel()], ["Solder mask expansion:", mask.el, unitLabel()], ["Solder paste clearance:", paste.el, unitLabel()]])),
      box("Pad Connections", form([["Pad connection to zones:", zone.el]], true)));
    body.append(notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Clearance Overrides & Pad Connections", build: (el) => el.append(clearances) }]).el);
    return (n) => {
      const variantFields: Record<string, string> = {};
      // field names: none empty, none twice (TransferDataFromWindow / OnGridCellChanging)
      const names: string[] = [];
      for (const r of g.rows()) {
        const nm = mandRow(r) ? String(r.name) : String(r.label).trim();
        if (!nm) return "Fields must have a name.";
        if (names.some((o) => duplicates(nm, o)) || (!mandRow(r) && RESERVED.includes(nm.toLowerCase()))) return `Field name '${nm}' already in use.`;
        names.push(nm);
      }
      // deleted user fields go, renamed ones take their new name, added ones are written after the last field
      for (const p of props(n)) if (!MAND.includes(String(p[1])) && !g.rows().some((r) => r.name === String(p[1]))) n.splice(n.indexOf(p), 1);
      for (const r of g.rows()) {
        if (mandRow(r)) continue;
        const nm = String(r.label).trim();
        if (!r.name) {
          const all = K().kids(n, "property") as SNode[], last = all[all.length - 1];
          // PCB_FIELD( m_footprint, USER ): its text angle is the footprint's orientation (GetTextAngle, normalised), keep
          // upright unless the Fab class says otherwise ((unlocked yes)), the Fab text style (italic below, with the row),
          // mirrored on a back layer
          const ly = String(r.layer), st = PT().layerStyle(ly), back = /^B\./.test(ly);
          const fresh = K().parse(`(property ${quote(nm)} "" (at 0 0 ${f6(norm360(fpRot0))})${st.upright ? "" : " (unlocked yes)"} (layer ${quote(ly)}) (hide yes) (uuid ${quote(K().newUuid())}) (effects (font (size ${f6(st.h)} ${f6(st.w)}) (thickness ${f6(st.thick)}))${back ? " (justify mirror)" : ""}))`) as SNode;
          n.splice(last ? n.indexOf(last) + 1 : 1, 0, fresh); r.name = nm;
        } else if (nm !== r.name) { const p = props(n).find((q) => String(q[1]) === r.name); if (p) p[1] = nm; r.name = nm; }
      }
      const list = props(n);
      for (const r of g.rows()) {
        const p = list.find((q) => String(q[1]) === r.name); if (!p) continue;
        if (MAND.slice(0, 1).includes(String(r.name)) && !String(r.value).trim()) return "Reference designator cannot be empty.";
        const fx = FH().fieldEffects(p), a = FH().fieldAt(p), e = kid(p, "effects"), f = e ? kid(e, "font") : null, sz = f ? kid(f, "size") : null;
        if (variant) { if (String(r.value) !== xref.toRefs(fieldText(p))) variantFields[String(r.name)] = xref.toKiids(String(r.value)); }
        else if (String(r.value) !== xref.toRefs(sval(p, 2))) { const v = xref.toKiids(String(r.value)); if (v !== sval(p, 2)) p[2] = v; }
        if (!!r.show === FH().fieldHidden(p)) FH().setFieldHidden(n, p, !r.show);
        const w = Number(r.w), ht = Number(r.ht), th = Number(r.th);
        if (isFinite(w) && isFinite(ht) && f && (w !== nval(sz, 2, fx.size) || ht !== nval(sz, 1, fx.size))) put(f, "size", `(size ${f6(ht)} ${f6(w)})`, ["thickness", "bold", "italic"]);
        if (isFinite(th) && f && th !== (fx.thick || 0.15)) put(f, "thickness", `(thickness ${f6(th)})`, ["bold", "italic", "color"]);
        if (f && !!r.italic !== fx.italic) fontFlags(doc, f, "italic", !!r.italic);
        if (String(r.layer) && String(r.layer) !== FH().fieldLayer(p)) put(p, "layer", `(layer ${quote(String(r.layer))})`, ["hide", "uuid", "effects"]);
        // PFC_ORIENTATION: SetTextAngle( value + the footprint's orientation ), written normalised
        if (Number(r.x) !== a[0] || Number(r.y) !== a[1] || Number(r.rot) !== relRot(a[2] || 0)) FH().setFieldAt(p, Number(r.x) || 0, Number(r.y) || 0, norm360((Number(r.rot) || 0) + fpRot0));
      }
      if (side.get() !== side0) PH().setFootprintSide(n, side.get());
      const now = K().atOf(n);
      if (norm180(rot.get()) !== norm180(side.get() !== side0 ? now[2] || 0 : at[2] || 0)) PH().setFootprintRotation(n, norm180(rot.get()));
      if (x.get() !== at[0] || y.get() !== at[1]) PH().setFootprintPosition(n, x.get(), y.get());
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      const next: Record<string, unknown> = { type: type.get() };
      if (variant) {
        // the variant takes the flags and the field values; the footprint keeps its own (board_only stays the footprint's)
        for (const f of flags) next[f.k] = f.k in (vflags || {}) ? !!attrs[f.k] : f.f.get();
        const vpatch: Partial<VM.FpFlags> = {}; let vchanged = Object.keys(variantFields).length > 0;
        for (const f of flags) if (vflags && f.k in vflags && f.f.get() !== vflags[f.k as keyof VM.FpFlags]) { vpatch[f.k as keyof VM.FpFlags] = f.f.get(); vchanged = true; }
        if (vchanged) { const out = VM.setFootprintVariant(n, variant, { flags: vpatch, fields: variantFields }); n.splice(0, n.length, ...out); }
      } else for (const f of flags) next[f.k] = f.f.get();
      if (next.type !== attrs.type || flags.some((f) => !!next[f.k] !== !!attrs[f.k])) PH().setFootprintAttrs(n, next);
      const AFTER = ["solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"];
      const setOv = (key: string, f: Field<number>, before: string[]): void => { const v = f.get(); if (isFinite(v)) { if (!kid(n, key) || nval(kid(n, key)) !== v) put(n, key, `(${key} ${f6(v)})`, before); } else put(n, key, null); };
      setOv("solder_mask_margin", mask, AFTER); setOv("solder_paste_margin", paste, AFTER.slice(1)); setOv("clearance", clr, AFTER.slice(3));
      if (zone.get() !== (zc ? String(zc[1]) : "")) put(n, "zone_connect", zone.get() === "" ? null : `(zone_connect ${zone.get()})`, AFTER.slice(4));
      return undefined;
    };
  }, undefined, "Edit Footprint Properties");
}

/** The KiCad dialog for a board item; false when this module has none for it (the caller falls back). */
export function pcbItemDialog(ctx: ToolCtx, item: KItem): boolean {
  if (!ctx.doc || ctx.doc.type !== "pcb" || !item) return false;
  if (typeof KDialogs === "undefined" || !KDialogs) return false;
  switch (item.kind) {
    case "segment": case "arc": return item.docType === "pcb" && !!kid(item.node, "width") ? trackViaDialog(ctx, [item]) : false;
    case "via": return trackViaDialog(ctx, [item]);
    case "zone": return kid(item.node, "keepout") ? ruleAreaDialog(ctx, item) : Array.from(zoneLayerSet(ctx.doc, item.node)).some((l) => /\.Cu$/.test(l)) ? zoneDialog(ctx, item) : nonCopperZoneDialog(ctx, item);
    case "gr_text": return textDialog(ctx, item);
    case "gr_text_box": return textBoxDialog(ctx, item);
    case "table": return tableDialog(ctx, item);
    case "image": return (ctx.doc as KDoc).type === "pcb" ? refImageDialog(ctx, item) : false;
    case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": return shapeDialog(ctx, item);
    case "footprint": return footprintDialog(ctx, item);
    case "dimension": return dimensionDialog(ctx, item);
    default: return false;
  }
}
