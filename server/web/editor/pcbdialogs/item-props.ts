// pcbdialogs/item-props — the board items' Properties dialogs in KiCad's layout:
//   Track & Via Properties (DIALOG_TRACK_VIA_PROPERTIES), Copper Zone Properties (DIALOG_COPPER_ZONE /
//   PANEL_ZONE_PROPERTIES), Text Properties (DIALOG_TEXT_PROPERTIES), "<Shape> Properties"
//   (DIALOG_SHAPE_PROPERTIES) and Footprint Properties (DIALOG_FOOTPRINT_PROPERTIES).
// Each edits a copy of the item's node and stores it as one MODIFIED change on OK.  KDialogs.openItem asks
// pcbItemDialog first and falls back to the generic property sheet for the kinds not handled here (pads
// keep pcb-tools' Pad Properties; dimensions open Dimension Properties from ./dimension).
import { faceOfFont, fontField, setFaceOfFont } from "../../dialogs/font-picker";
import { trackViaDialog } from "./track-via";
import { box, checkField, errorMessage, fmtLenU, form, grid, h, coordField, lenField, notebook, numField, openDialog, selectField, textField, unitLabel, type CellValue, type Field } from "./ui";
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
interface FieldHelpers { fieldEffects(p: SNode): FieldFx; setFieldEffects(p: SNode, fx: Partial<FieldFx>): void; fieldAt(p: SNode): [number, number, number]; setFieldAt(p: SNode, x: number, y: number, rot: number): void;
  fieldHidden(p: SNode): boolean; setFieldHidden(node: SNode, p: SNode, hidden: boolean): void; fieldLayer(p: SNode): string; setFieldLayer(p: SNode, layer: string): void }
const PH = (): PropsHelpers => (CollabTools as unknown as { props: { helpers: PropsHelpers } }).props.helpers;
const FH = (): FieldHelpers => (KDialogs as unknown as { _: FieldHelpers })._;
const PT = (): { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode } => (window as unknown as { PcbTools: { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode } }).PcbTools;

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
      if (err && (typeof err === "string" || err.msg)) { showApplyError(err); return false; }
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
    zm.addEventListener("click", () => { const dlg = zm.closest(".kd-overlay, .kd-dialog"); const esc = dlg && dlg.querySelector<HTMLButtonElement>(".kd-foot button"); if (esc) esc.click(); setTimeout(() => runKicadAction("zoneManager"), 0); });
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
function textDialog(ctx: ToolCtx, item: KItem, create?: (node: SNode | null) => void): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Text Properties", 560, (node, body, ro) => {
    const at = K().atOf(node), ly = kid(node, "layer"), fx = FH().fieldEffects(node);
    const eff = kid(node, "effects"), font = eff ? kid(eff, "font") : null, sz = font ? kid(font, "size") : null;
    const text = h("textarea", { class: "pd-text", style: "min-height:90px", readOnly: ro, "data-key": "text" }); const xref = boardXref(doc), shownText = xref.toRefs(sval(node)); text.value = shownText;   // the reader already turned the file's "\\n" into new lines; cross-references shown as ${REF:FIELD}
    text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); if (ev.shiftKey) { ev.preventDefault(); const ok = (body.parentElement as HTMLElement).querySelector<HTMLButtonElement>(".kd-foot > button:last-child"); if (ok) ok.click(); } } });   // SCINTILLA_TRICKS: Shift+Enter accepts, Enter is a new line
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const layer = selectField<string>(sval(ly), withCurrent(allLayers(doc), sval(ly)), { ro, key: "layer" });
    const knockout = checkField(!!ly && ly.includes("knockout"), "Knockout", { ro, key: "knockout" });
    const bold = checkField(fx.bold, "Bold", { ro, key: "bold" }), italic = checkField(fx.italic, "Italic", { ro, key: "italic" }), mirror = checkField(fx.mirror, "Mirrored", { ro, key: "mirror" });
    const face0 = faceOfFont(font), face = fontField(doc, face0, { ro, key: "face" });
    const w = lenField(nval(sz, 2, 1), { ro, key: "width" }), ht = lenField(nval(sz, 1, 1), { ro, key: "height" }), th = lenField(fx.thick || 0.15, { ro, key: "thickness" });
    const x = coordField(at[0], "x", { ro, key: "x" }), y = coordField(at[1], "y", { ro, key: "y" }), rot = numField(at[2] || 0, { ro, key: "orientation" });
    const hj = selectField<string>(fx.h, [["left", "Left"], ["center", "Center"], ["right", "Right"]], { ro, key: "hjustify" }), vj = selectField<string>(fx.v, [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]], { ro, key: "vjustify" });
    const help = syntaxHelpLink(true); help.style.margin = "3px";
    body.append(h("label", { class: "pd-lbl" }, "Text:"), text, h("div", null, help), h("div", { class: "pd-row", style: "margin-top:8px" }, locked.el),
      h("div", { class: "pd-cols2" },
        form([["Layer:", layer.el], knockout.el, ["Font:", face.el], h("span", { class: "pd-inline" }, bold.el, italic.el, mirror.el), ["Horizontal:", hj.el], ["Vertical:", vj.el]], true),
        form([["Width:", w.el, unitLabel()], ["Height:", ht.el, unitLabel()], ["Thickness:", th.el, unitLabel()], ["Position X:", x.el, unitLabel()], ["Position Y:", y.el, unitLabel()], ["Orientation:", rot.el, unitLabel("deg")]])));
    return (n) => {
      if (!(w.get() > 0) || !(ht.get() > 0)) return { msg: "Text width and height must be greater than zero.", focus: !(w.get() > 0) ? w : ht };
      const t = text.value.replace(/\r/g, "");   // new lines stay new lines: the writer escapes them as "\\n"
      if (t !== shownText) { const stored = xref.toKiids(t); if (stored !== sval(n)) n[1] = stored; }
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      K().setAt(n, +f6(x.get()), +f6(y.get()), +f6(rot.get()));
      put(n, "layer", `(layer ${quote(layer.get())}${knockout.get() ? " knockout" : ""})`, ["uuid", "tstamp", "effects"]);
      let e = kid(n, "effects"); if (!e) { put(n, "effects", "(effects (font (size 1 1) (thickness 0.15)))"); e = kid(n, "effects") as SNode; }
      let f = kid(e, "font"); if (!f) { e.splice(1, 0, K().parse("(font)") as SNode); f = kid(e, "font") as SNode; }
      if (face.get() !== face0) setFaceOfFont(f, face.get());
      put(f, "size", `(size ${f6(ht.get())} ${f6(w.get())})`, ["thickness", "bold", "italic"]);
      put(f, "thickness", `(thickness ${f6(th.get())})`, ["bold", "italic", "color"]);
      if (bold.get() !== fx.bold) fontFlags(doc, f, "bold", bold.get());
      if (italic.get() !== fx.italic) fontFlags(doc, f, "italic", italic.get());
      const j: string[] = []; if (hj.get() !== "center") j.push(hj.get()); if (vj.get() !== "center") j.push(vj.get()); if (mirror.get()) j.push("mirror");
      put(e, "justify", j.length ? `(justify ${j.join(" ")})` : null, ["hide", "href"]);
      return undefined;
    };
  }, create, "Edit Text Properties");
}
/** DIALOG_TEXT_PROPERTIES on a new text (DRAWING_TOOL::PlaceText): done gets the edited node, or null on Cancel. */
export function newTextDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = textDialog(ctx, { id: "", kind: "gr_text", node, geom: [], bbox: null } as unknown as KItem, done);
  if (!ok) done(null);
  return ok;
}

// ---------------------------------------------------------------- <Shape> Properties
const SHAPE_NAMES: Record<string, string> = { gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", gr_curve: "Bezier" };
const LINE_STYLES: [string, string][] = [["default", "Default"], ["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
function shapeDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc, kind = item.kind;
  return itemDialog(ctx, item, `${SHAPE_NAMES[kind]} Properties`, 500, (node, body, ro) => {
    const rows: ([string, HTMLElement, HTMLElement?] | HTMLElement)[] = [];
    const pt = (key: string, label: string, fixed: boolean): { x: Field<number>; y: Field<number>; key: string } | null => {
      const p = kid(node, key); if (!p) return null;
      const x = coordField(nval(p, 1), "x", { ro: ro || fixed, key: key + "X" }), y = coordField(nval(p, 2), "y", { ro: ro || fixed, key: key + "Y" });
      rows.push(xyRow(label, x, y)); return { x, y, key };
    };
    const pts: ({ x: Field<number>; y: Field<number>; key: string } | null)[] = [];
    let radius: Field<number> | null = null;
    if (kind === "gr_line") pts.push(pt("start", "Start X:", false), pt("end", "End X:", false));
    else if (kind === "gr_rect") pts.push(pt("start", "Start X:", false), pt("end", "End X:", false));
    else if (kind === "gr_circle") {
      pts.push(pt("center", "Center X:", false));
      const c = kid(node, "center"), e = kid(node, "end");
      radius = lenField(Math.hypot(nval(e, 1) - nval(c, 1), nval(e, 2) - nval(c, 2)), { ro, key: "radius" }); rows.push(["Radius:", radius.el, unitLabel()]);
    } else if (kind === "gr_arc") pts.push(pt("start", "Start X:", true), pt("mid", "Mid X:", true), pt("end", "End X:", true));
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const stroke = kid(node, "stroke"), legacyW = kid(node, "width");
    const width = lenField(stroke ? nval(kid(stroke, "width")) : nval(legacyW), { ro, key: "lineWidth" });
    const style = selectField<string>(sval(stroke ? kid(stroke, "type") : null) || "default", LINE_STYLES, { ro: ro || !stroke, key: "lineStyle" });
    const closed = kind === "gr_rect" || kind === "gr_circle" || kind === "gr_poly";
    const fk = kid(node, "fill"), fv = sval(fk), filled = fv === "solid" || fv === "yes";
    const fill = selectField<string>(filled ? "solid" : "none", [["none", "None"], ["solid", "Solid"]], { ro: ro || !closed, key: "fill" });
    const ly = sval(kid(node, "layer")), layer = selectField<string>(ly, withCurrent(allLayers(doc), ly), { ro, key: "layer" });
    body.append(form(rows, true), h("div", { class: "pd-row", style: "margin:8px 0" }, locked.el),
      form([["Line width:", width.el, unitLabel()], ["Line style:", style.el], ...(closed ? [["Fill:", fill.el] as [string, HTMLElement]] : []), ["Layer:", layer.el]], true));
    return (n) => {
      if (width.get() < 0) return { msg: "Line width may not be negative.", focus: width };
      if (!closed && !(width.get() > 0)) return { msg: "Line width must be greater than zero.", focus: width };
      for (const p of pts) if (p && kind !== "gr_arc") put(n, p.key, `(${p.key} ${f6(p.x.get())} ${f6(p.y.get())})`);
      if (radius && pts[0]) { if (!(radius.get() > 0)) return { msg: "Radius must be greater than zero.", focus: radius }; put(n, "end", `(end ${f6(pts[0].x.get() + radius.get())} ${f6(pts[0].y.get())})`); }
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      const s = kid(n, "stroke");
      if (s) { put(s, "width", `(width ${f6(width.get())})`, ["type"]); if (style.get() !== (sval(kid(s, "type")) || "default")) put(s, "type", `(type ${style.get()})`); }
      else put(n, "width", `(width ${f6(width.get())})`, ["layer"]);
      if (closed && (fill.get() === "solid") !== filled) { const yn = fv === "yes" || fv === "no" || (!fk && ((doc as KDoc & { version?: number }).version || 0) >= 20240000); put(n, "fill", `(fill ${fill.get() === "solid" ? (yn ? "yes" : "solid") : yn ? "no" : "none"})`, ["layer", "uuid"]); }
      if (layer.get() !== ly) put(n, "layer", `(layer ${quote(layer.get())})`, ["net", "uuid", "tstamp"]);
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
    const label = (n: string): string => (n === "Reference" ? "Reference designator" : n);
    const xref = boardXref(doc);   // field text shows cross-references as ${REF:FIELD} (dialog_footprint_properties.cpp:272, 603)
    // the board's current variant (the toolbar's): fields and the DNP / BOM / position-file / simulation flags show
    // and write the footprint's (variant …) (dialog_footprint_properties.cpp:263-312, 586-715)
    const variant = String((E as { currentVariant?: string }).currentVariant || "");
    const fieldText = (p: SNode): string => (variant ? VM.footprintFieldForVariant(node, variant, String(p[1])) : sval(p, 2));
    const rows: Record<string, CellValue>[] = props(node).map((p) => {
      const fx = FH().fieldEffects(p), a = FH().fieldAt(p), e = kid(p, "effects"), f = e ? kid(e, "font") : null, sz = f ? kid(f, "size") : null;
      return { name: String(p[1]), label: label(String(p[1])), value: xref.toRefs(fieldText(p)), show: !FH().fieldHidden(p), w: nval(sz, 2, fx.size), ht: nval(sz, 1, fx.size), th: fx.thick || 0.15, italic: fx.italic, layer: FH().fieldLayer(p), rot: a[2] || 0, x: a[0], y: a[1] };
    });
    const g = grid([{ label: "Name", key: "label", type: "ro", width: "130px" }, { label: "Value", key: "value" }, { label: "Show", key: "show", type: "check" }, { label: "Width", key: "w", type: "len" }, { label: "Height", key: "ht", type: "len" }, { label: "Thickness", key: "th", type: "len" },
      { label: "Italic", key: "italic", type: "check" }, { label: "Layer", key: "layer", type: "select", options: allLayers(doc), width: "120px" }, { label: "Orientation", key: "rot", type: "num" }, { label: "X Offset", key: "x", type: "len" }, { label: "Y Offset", key: "y", type: "len" }], rows, { ro, height: "170px" });
    const at = K().atOf(node), side0 = sval(kid(node, "layer")) || "F.Cu";
    const x = coordField(at[0], "x", { ro, key: "x" }), y = coordField(at[1], "y", { ro, key: "y" }), rot = numField(at[2] || 0, { ro, key: "orientation" });
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
    const general = h("div", null, box("Fields", g.el),
      h("div", { class: "pd-cols2" },
        box("Position", form([["X:", x.el, unitLabel()], ["Y:", y.el, unitLabel()], ["Orientation:", rot.el, unitLabel("deg")], ["Side:", side.el]]), locked.el),
        box("Fabrication Attributes", form([["Footprint type:", type.el]], true), ...flags.map((f) => f.f.el))),
      form([["Library link:", h("span", { class: "pd-value" }, String(node[1] ?? ""))]], true), fpButtons(ctx, item, body));
    const clearances = h("div", null, h("p", { class: "pd-note" }, "Leave values blank to use Board Setup values."),
      box("Clearances", form([["Pad clearance:", clr.el, unitLabel()], ["Solder mask expansion:", mask.el, unitLabel()], ["Solder paste clearance:", paste.el, unitLabel()]])),
      box("Pad Connections", form([["Pad connection to zones:", zone.el]], true)));
    body.append(notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Clearance Overrides & Pad Connections", build: (el) => el.append(clearances) }]).el);
    return (n) => {
      const list = props(n); const variantFields: Record<string, string> = {};
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
        if (Number(r.x) !== a[0] || Number(r.y) !== a[1] || Number(r.rot) !== (a[2] || 0)) FH().setFieldAt(p, Number(r.x) || 0, Number(r.y) || 0, Number(r.rot) || 0);
      }
      if (side.get() !== side0) PH().setFootprintSide(n, side.get());
      const now = K().atOf(n);
      if (rot.get() !== (side.get() !== side0 ? now[2] || 0 : at[2] || 0)) PH().setFootprintRotation(n, rot.get());
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
