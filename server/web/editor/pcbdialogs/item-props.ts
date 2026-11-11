// pcbdialogs/item-props — the board items' Properties dialogs in KiCad's layout:
//   Track & Via Properties (DIALOG_TRACK_VIA_PROPERTIES), Copper Zone Properties (DIALOG_COPPER_ZONE /
//   PANEL_ZONE_PROPERTIES), Text Properties (DIALOG_TEXT_PROPERTIES), "<Shape> Properties"
//   (DIALOG_SHAPE_PROPERTIES) and Footprint Properties (DIALOG_FOOTPRINT_PROPERTIES).
// Each edits a copy of the item's node and stores it as one MODIFIED change on OK.  KDialogs.openItem asks
// pcbItemDialog first and falls back to the generic property sheet for the kinds not handled here (pads
// keep pcb-tools' Pad Properties, dimensions and rule areas the property sheet).
import { box, checkField, form, grid, h, lenField, notebook, numField, openDialog, selectField, textField, unitLabel, type CellValue, type Field } from "./ui";

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
function setNet(doc: KDoc, node: SNode, name: string): void {
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

type Apply = (node: SNode) => string | void;
/** The shell: a copy of the node, a builder that returns how to lay the controls into it, one change on OK. */
function itemDialog(ctx: ToolCtx, item: KItem, title: string, width: number, build: (node: SNode, body: HTMLElement, ro: boolean) => Apply): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const staged = (K().cloneNode as (n: SNode) => SNode)(item.node);
  let apply: Apply = () => undefined;
  const before = K().serialize(staged);
  return !!openDialog({ title, width, readOnly: !!ctx.viewOnly,
    build(body) { apply = build(staged, body, !!ctx.viewOnly); },
    ok() {
      if (ctx.viewOnly) return true;
      const err = apply(staged);
      if (typeof err === "string" && err) { ctx.toast(err, 4000); return false; }
      if (K().serialize(staged) === before) return true;
      ctx.commit([K().replaceChange(doc, { ...item, node: staged, geom: [], bbox: null })], "properties");
      return true;
    } });
}
const xyRow = (lx: string, x: Field<number>, y: Field<number>): [string, HTMLElement, HTMLElement] => [lx, h("span", { class: "pd-xy" }, x.el, h("label", null, "Y:"), y.el), unitLabel()];

// ---------------------------------------------------------------- Track & Via Properties
function trackViaDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Track & Via Properties", 520, (node, body, ro) => {
    const net = netField(doc, node, ro), locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    body.append(box("Common", form([["Net:", net.el]], true), locked.el));
    const common = (n: SNode): void => { if (net.get() !== PH().netNameOf(doc, n)) setNet(doc, n, net.get()); if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get()); };
    if (item.kind === "via") {
      const at = K().atOf(node), type = typeof node[1] === "string" ? String(node[1]) : "through";
      const ls = kid(node, "layers"), top = doc.copper[0] || "F.Cu", bottom = doc.copper[doc.copper.length - 1] || "B.Cu";
      const x = lenField(at[0], { ro, key: "x" }), y = lenField(at[1], { ro, key: "y" });
      const size = lenField(nval(kid(node, "size")), { ro, key: "size" }), drill = lenField(nval(kid(node, "drill")), { ro, key: "drill" });
      const vtype = selectField<string>(type, [["through", "Through"], ["micro", "Micro"], ["blind", "Blind"], ["buried", "Buried"]], { ro, key: "viaType", onChange: (v) => { const thru = v === "through"; l0.input.disabled = l1.input.disabled = ro || thru; if (thru) { l0.set(top); l1.set(bottom); } } });
      const l0 = selectField<string>(sval(ls, 1) || top, withCurrent(copperLayers(doc), sval(ls, 1)), { ro: ro || type === "through", key: "startLayer" });
      const l1 = selectField<string>(sval(ls, 2) || bottom, withCurrent(copperLayers(doc), sval(ls, 2)), { ro: ro || type === "through", key: "endLayer" });
      body.append(box("Vias", form([xyRow("Position X:", x, y), ["Via diameter:", size.el, unitLabel()], ["Via hole:", drill.el, unitLabel()], ["Via type:", vtype.el], ["Start layer:", l0.el], ["End layer:", l1.el]], true)));
      return (n) => {
        if (!(size.get() > 0) || !(drill.get() > 0)) return "Via diameter and hole must be greater than zero.";
        if (drill.get() >= size.get()) return "Via hole size must be smaller than via diameter";
        if (vtype.get() !== "through" && l0.get() === l1.get()) return "Via start layer and end layer cannot be the same";
        common(n);
        K().setAt(n, +f6(x.get()), +f6(y.get()));
        put(n, "size", `(size ${f6(size.get())})`, ["drill", "layers"]); put(n, "drill", `(drill ${f6(drill.get())})`, ["layers"]);
        if (typeof n[1] === "string") n.splice(1, 1);
        if (vtype.get() !== "through") n.splice(1, 0, vtype.get());
        put(n, "layers", `(layers ${quote(l0.get())} ${quote(l1.get())})`, ["net", "uuid"]);
        return undefined;
      };
    }
    const arc = item.kind === "arc";
    const s = kid(node, "start"), e = kid(node, "end");
    const sx = lenField(nval(s, 1), { ro: ro || arc, key: "sx" }), sy = lenField(nval(s, 2), { ro: ro || arc, key: "sy" }), ex = lenField(nval(e, 1), { ro: ro || arc, key: "ex" }), ey = lenField(nval(e, 2), { ro: ro || arc, key: "ey" });
    const width = lenField(nval(kid(node, "width")), { ro, key: "width" });
    const cur = sval(kid(node, "layer")), layer = selectField<string>(cur, withCurrent(copperLayers(doc), cur), { ro, key: "layer" });
    body.append(box("Tracks", form([xyRow("Start X:", sx, sy), xyRow("End X:", ex, ey), ["Track width:", width.el, unitLabel()], ["Layer:", layer.el]], true)));
    return (n) => {
      if (!(width.get() > 0)) return "Track width must be greater than zero.";
      common(n);
      if (!arc) { put(n, "start", `(start ${f6(sx.get())} ${f6(sy.get())})`); put(n, "end", `(end ${f6(ex.get())} ${f6(ey.get())})`); }
      put(n, "width", `(width ${f6(width.get())})`, ["layer"]);
      if (layer.get() !== cur) put(n, "layer", `(layer ${quote(layer.get())})`, ["net", "uuid"]);
      return undefined;
    };
  });
}

// ---------------------------------------------------------------- Copper Zone Properties
function zoneDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Copper Zone Properties", 760, (node, body, ro) => {
    const l1 = kid(node, "layer"), ln = kid(node, "layers");
    const cur = new Set<string>(l1 ? [sval(l1)] : ln ? ln.slice(1).map(String) : []);
    const layerChecks = withCurrent(copperLayers(doc), "").map(([name, label]) => ({ name, f: checkField(cur.has(name), label, { ro, key: "layer-" + name }) }));
    const name = textField(sval(kid(node, "name")), { ro, key: "name" });
    name.input.title = "A unique name for this zone, used to identify it in DRC rules";
    const net = netField(doc, node, ro), locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const prio = numField(nval(kid(node, "priority")), { ro, key: "priority", digits: 0 });
    const cp = kid(node, "connect_pads") || ["connect_pads"], fill = kid(node, "fill") || ["fill"], hatch = kid(node, "hatch");
    const mode0 = typeof cp[1] === "string" ? String(cp[1]) : "thermal";
    const clearance = lenField(nval(kid(cp, "clearance"), 1, 0.5), { ro, key: "clearance" }), minW = lenField(nval(kid(node, "min_thickness"), 1, 0.25), { ro, key: "minWidth" });
    const conn = selectField<string>(mode0, [["yes", "Solid"], ["thermal", "Thermal reliefs"], ["thru_hole_only", "Reliefs for PTH"], ["no", "None"]], { ro, key: "padConnections" });
    const gap = lenField(nval(kid(fill, "thermal_gap"), 1, 0.5), { ro, key: "thermalGap" }), spoke = lenField(nval(kid(fill, "thermal_bridge_width"), 1, 0.5), { ro, key: "spokeWidth" });
    const outline = selectField<string>(sval(hatch) || "edge", [["none", "Line"], ["edge", "Hatched"], ["full", "Fully hatched"]], { ro, key: "outline" });
    const pitch = lenField(nval(hatch, 2, 0.5), { ro, key: "hatchPitch" });
    const smooth = selectField<string>(sval(kid(fill, "smoothing")) || "none", [["none", "None"], ["chamfer", "Chamfer"], ["fillet", "Fillet"]], { ro, key: "smoothing" });
    const radius = lenField(nval(kid(fill, "radius")), { ro, key: "radius" });
    const islands = selectField<number>(nval(kid(fill, "island_removal_mode")), [[0, "Always"], [1, "Never"], [2, "Below area limit"]], { ro, key: "islands" });
    islands.input.title = "Choose what to do with unconnected copper islands";
    const area = numField(nval(kid(fill, "island_area_min"), 1, 10), { ro, key: "islandArea" });
    body.append(h("div", { class: "pd-zone" },
      h("div", { class: "pd-zonelayers" }, h("div", { class: "pd-colhead" }, "Layers:"), h("div", { class: "pd-list", style: "padding:4px 8px;max-height:330px" }, ...layerChecks.map((l) => l.f.el))),
      h("div", null,
        box("General", form([["Zone name:", name.el], ["Net name:", net.el], ["Zone priority level:", prio.el]], true), locked.el),
        h("div", { class: "pd-cols2" },
          box("Clearances & Pad Connections", form([["Clearance:", clearance.el, unitLabel()], ["Minimum width:", minW.el, unitLabel(), "Minimum thickness of filled areas."], ["Pad connections:", conn.el],
            ["Thermal relief gap:", gap.el, unitLabel(), "Clearance between pads in the same net and filled areas."], ["Thermal spoke width:", spoke.el, unitLabel(), "Width of copper in thermal reliefs."]])),
          h("div", null,
            box("Display Overrides", form([["Outline display:", outline.el], ["Outline hatch pitch:", pitch.el, unitLabel()]])),
            box("Fill", form([["Corner smoothing:", smooth.el], ["Radius:", radius.el, unitLabel()], ["Remove islands:", islands.el], ["Area limit:", area.el, unitLabel("mm²"), "Isolated islands smaller than this will be removed"]])))))));
    return (n) => {
      const on = layerChecks.filter((l) => l.f.get()).map((l) => l.name);
      if (!on.length) return "No layer selected.";
      if (minW.get() < 0.001) return "Minimum width must be at least 0.001 mm.";
      if ((conn.get() === "thermal" || conn.get() === "thru_hole_only") && spoke.get() < minW.get()) return "Thermal spoke width cannot be smaller than the minimum width.";
      if (net.get() !== PH().netNameOf(doc, n)) setNet(doc, n, net.get());
      if (on.join(" ") !== Array.from(cur).join(" ")) {
        put(n, "layer", null); put(n, "layers", null);
        put(n, on.length === 1 ? "layer" : "layers", on.length === 1 ? `(layer ${quote(on[0])})` : `(layers ${on.map(quote).join(" ")})`, ["uuid", "tstamp", "name", "hatch"]);
      }
      if (name.get().trim()) put(n, "name", `(name ${quote(name.get().trim())})`, ["hatch", "priority", "connect_pads"]); else put(n, "name", null);
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      put(n, "hatch", `(hatch ${outline.get()} ${f6(pitch.get())})`, ["priority", "connect_pads"]);
      const p = Math.max(0, Math.round(prio.get() || 0)); if (p) put(n, "priority", `(priority ${p})`, ["connect_pads", "min_thickness"]); else put(n, "priority", null);
      // connect_pads and fill keep the children this dialog does not show
      let c = kid(n, "connect_pads"); if (!c) { put(n, "connect_pads", "(connect_pads)", ["min_thickness", "filled_areas_thickness", "fill", "polygon"]); c = kid(n, "connect_pads") as SNode; }
      if (typeof c[1] === "string") c.splice(1, 1);
      if (conn.get() !== "thermal") c.splice(1, 0, conn.get());
      put(c, "clearance", `(clearance ${f6(clearance.get())})`);
      put(n, "min_thickness", `(min_thickness ${f6(minW.get())})`, ["filled_areas_thickness", "fill", "polygon"]);
      let f = kid(n, "fill"); if (!f) { put(n, "fill", "(fill)", ["polygon", "filled_polygon"]); f = kid(n, "fill") as SNode; }
      put(f, "thermal_gap", `(thermal_gap ${f6(gap.get())})`, ["thermal_bridge_width", "smoothing", "radius", "island_removal_mode"]);
      put(f, "thermal_bridge_width", `(thermal_bridge_width ${f6(spoke.get())})`, ["smoothing", "radius", "island_removal_mode"]);
      if (smooth.get() === "none") { put(f, "smoothing", null); put(f, "radius", null); }
      else { put(f, "smoothing", `(smoothing ${smooth.get()})`, ["radius", "island_removal_mode", "island_area_min"]); put(f, "radius", `(radius ${f6(radius.get())})`, ["island_removal_mode", "island_area_min"]); }
      const im = islands.get();
      if (im || kid(f, "island_removal_mode")) put(f, "island_removal_mode", `(island_removal_mode ${im})`, ["island_area_min", "hatch_thickness"]);
      if (im === 2) put(f, "island_area_min", `(island_area_min ${f6(area.get())})`, ["hatch_thickness"]); else put(f, "island_area_min", null);
      return undefined;
    };
  });
}

// ---------------------------------------------------------------- Text Properties
function fontFlags(doc: KDoc, font: SNode, flag: "bold" | "italic", on: boolean): void {
  const bare = font.indexOf(flag); if (bare > 0) font.splice(bare, 1);
  const modern = ((doc as KDoc & { version?: number }).version || 20240108) >= 20230000;
  put(font, flag, null);
  if (!on) return;
  if (modern) put(font, flag, `(${flag} yes)`, flag === "bold" ? ["italic", "color"] : ["color"]); else font.push(flag);
}
function textDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Text Properties", 560, (node, body, ro) => {
    const at = K().atOf(node), ly = kid(node, "layer"), fx = FH().fieldEffects(node);
    const eff = kid(node, "effects"), font = eff ? kid(eff, "font") : null, sz = font ? kid(font, "size") : null;
    const text = h("textarea", { class: "pd-text", style: "min-height:90px", readOnly: ro, "data-key": "text" }); text.value = sval(node).replace(/\\n/g, "\n");
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const layer = selectField<string>(sval(ly), withCurrent(allLayers(doc), sval(ly)), { ro, key: "layer" });
    const knockout = checkField(!!ly && ly.includes("knockout"), "Knockout", { ro, key: "knockout" });
    const bold = checkField(fx.bold, "Bold", { ro, key: "bold" }), italic = checkField(fx.italic, "Italic", { ro, key: "italic" }), mirror = checkField(fx.mirror, "Mirrored", { ro, key: "mirror" });
    const w = lenField(nval(sz, 2, 1), { ro, key: "width" }), ht = lenField(nval(sz, 1, 1), { ro, key: "height" }), th = lenField(fx.thick || 0.15, { ro, key: "thickness" });
    const x = lenField(at[0], { ro, key: "x" }), y = lenField(at[1], { ro, key: "y" }), rot = numField(at[2] || 0, { ro, key: "orientation" });
    const hj = selectField<string>(fx.h, [["left", "Left"], ["center", "Center"], ["right", "Right"]], { ro, key: "hjustify" }), vj = selectField<string>(fx.v, [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]], { ro, key: "vjustify" });
    body.append(h("label", { class: "pd-lbl" }, "Text:"), text, h("div", { class: "pd-row", style: "margin-top:8px" }, locked.el),
      h("div", { class: "pd-cols2" },
        form([["Layer:", layer.el], knockout.el, ["Font:", h("span", null, "KiCad Font")], h("span", { class: "pd-inline" }, bold.el, italic.el, mirror.el), ["Horizontal:", hj.el], ["Vertical:", vj.el]], true),
        form([["Width:", w.el, unitLabel()], ["Height:", ht.el, unitLabel()], ["Thickness:", th.el, unitLabel()], ["Position X:", x.el, unitLabel()], ["Position Y:", y.el, unitLabel()], ["Orientation:", rot.el, unitLabel("deg")]])));
    return (n) => {
      if (!(w.get() > 0) || !(ht.get() > 0)) return "Text width and height must be greater than zero.";
      const t = text.value.replace(/\r/g, "").replace(/\n/g, "\\n");
      if (t !== sval(n)) n[1] = t;
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      K().setAt(n, +f6(x.get()), +f6(y.get()), +f6(rot.get()));
      put(n, "layer", `(layer ${quote(layer.get())}${knockout.get() ? " knockout" : ""})`, ["uuid", "tstamp", "effects"]);
      let e = kid(n, "effects"); if (!e) { put(n, "effects", "(effects (font (size 1 1) (thickness 0.15)))"); e = kid(n, "effects") as SNode; }
      let f = kid(e, "font"); if (!f) { e.splice(1, 0, K().parse("(font)") as SNode); f = kid(e, "font") as SNode; }
      put(f, "size", `(size ${f6(ht.get())} ${f6(w.get())})`, ["thickness", "bold", "italic"]);
      put(f, "thickness", `(thickness ${f6(th.get())})`, ["bold", "italic", "color"]);
      if (bold.get() !== fx.bold) fontFlags(doc, f, "bold", bold.get());
      if (italic.get() !== fx.italic) fontFlags(doc, f, "italic", italic.get());
      const j: string[] = []; if (hj.get() !== "center") j.push(hj.get()); if (vj.get() !== "center") j.push(vj.get()); if (mirror.get()) j.push("mirror");
      put(e, "justify", j.length ? `(justify ${j.join(" ")})` : null, ["hide", "href"]);
      return undefined;
    };
  });
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
      const x = lenField(nval(p, 1), { ro: ro || fixed, key: key + "X" }), y = lenField(nval(p, 2), { ro: ro || fixed, key: key + "Y" });
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
      if (width.get() < 0) return "Line width may not be negative.";
      if (!closed && !(width.get() > 0)) return "Line width must be greater than zero.";
      for (const p of pts) if (p && kind !== "gr_arc") put(n, p.key, `(${p.key} ${f6(p.x.get())} ${f6(p.y.get())})`);
      if (radius && pts[0]) { if (!(radius.get() > 0)) return "Radius must be greater than zero."; put(n, "end", `(end ${f6(pts[0].x.get() + radius.get())} ${f6(pts[0].y.get())})`); }
      if (locked.get() !== PT().isLocked(n)) PT().setLocked(n, locked.get());
      const s = kid(n, "stroke");
      if (s) { put(s, "width", `(width ${f6(width.get())})`, ["type"]); if (style.get() !== (sval(kid(s, "type")) || "default")) put(s, "type", `(type ${style.get()})`); }
      else put(n, "width", `(width ${f6(width.get())})`, ["layer"]);
      if (closed && (fill.get() === "solid") !== filled) { const yn = fv === "yes" || fv === "no" || (!fk && ((doc as KDoc & { version?: number }).version || 0) >= 20240000); put(n, "fill", `(fill ${fill.get() === "solid" ? (yn ? "yes" : "solid") : yn ? "no" : "none"})`, ["layer", "uuid"]); }
      if (layer.get() !== ly) put(n, "layer", `(layer ${quote(layer.get())})`, ["net", "uuid", "tstamp"]);
      return undefined;
    };
  });
}

// ---------------------------------------------------------------- Footprint Properties
function footprintDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc;
  return itemDialog(ctx, item, "Footprint Properties", 900, (node, body, ro) => {
    const props = (n: SNode): SNode[] => (K().kids(n, "property") as SNode[]).filter((p) => p.some((c) => isList(c)) && !String(p[1]).startsWith("ki_"));
    const MAND = ["Reference", "Value", "Datasheet", "Description"];
    const label = (n: string): string => (n === "Reference" ? "Reference designator" : n);
    const rows: Record<string, CellValue>[] = props(node).map((p) => {
      const fx = FH().fieldEffects(p), a = FH().fieldAt(p), e = kid(p, "effects"), f = e ? kid(e, "font") : null, sz = f ? kid(f, "size") : null;
      return { name: String(p[1]), label: label(String(p[1])), value: sval(p, 2), show: !FH().fieldHidden(p), w: nval(sz, 2, fx.size), ht: nval(sz, 1, fx.size), th: fx.thick || 0.15, italic: fx.italic, layer: FH().fieldLayer(p), rot: a[2] || 0, x: a[0], y: a[1] };
    });
    const g = grid([{ label: "Name", key: "label", type: "ro", width: "130px" }, { label: "Value", key: "value" }, { label: "Show", key: "show", type: "check" }, { label: "Width", key: "w", type: "len" }, { label: "Height", key: "ht", type: "len" }, { label: "Thickness", key: "th", type: "len" },
      { label: "Italic", key: "italic", type: "check" }, { label: "Layer", key: "layer", type: "select", options: allLayers(doc), width: "120px" }, { label: "Orientation", key: "rot", type: "num" }, { label: "X Offset", key: "x", type: "len" }, { label: "Y Offset", key: "y", type: "len" }], rows, { ro, height: "170px" });
    const at = K().atOf(node), side0 = sval(kid(node, "layer")) || "F.Cu";
    const x = lenField(at[0], { ro, key: "x" }), y = lenField(at[1], { ro, key: "y" }), rot = numField(at[2] || 0, { ro, key: "orientation" });
    const side = selectField<string>(side0, [["F.Cu", "Front"], ["B.Cu", "Back"]], { ro, key: "side" });
    const locked = checkField(PT().isLocked(node), "Locked", { ro, key: "locked" });
    const attrs = PH().footprintAttrs(node);
    const type = selectField<string>(attrs.type, [["through_hole", "Through hole"], ["smd", "SMD"], ["", "Unspecified"]], { ro, key: "fpType" });
    const FLAGS: [string, string][] = [["board_only", "Not in schematic"], ["dnp", "Do not populate"], ["exclude_from_bom", "Exclude from bill of materials"], ["exclude_from_pos_files", "Exclude from position files"]];
    const flags = FLAGS.map(([k, l]) => ({ k, f: checkField(!!attrs[k], l, { ro, key: k }) }));
    // clearance overrides: blank means "use the Board Setup value"
    const ov = (key: string, k: string): Field<number> => lenField(kid(node, key) ? nval(kid(node, key)) : NaN, { ro, key: k, allowEmpty: true });
    const clr = ov("clearance", "padClearance"), mask = ov("solder_mask_margin", "maskExpansion"), paste = ov("solder_paste_margin", "pasteClearance");
    const zc = kid(node, "zone_connect"), zone = selectField<string>(zc ? String(zc[1]) : "", [["", "Use zone setting"], ["2", "Solid"], ["1", "Thermal relief"], ["0", "None"]], { ro, key: "zoneConnect" });
    const general = h("div", null, box("Fields", g.el),
      h("div", { class: "pd-cols2" },
        box("Position", form([["X:", x.el, unitLabel()], ["Y:", y.el, unitLabel()], ["Orientation:", rot.el, unitLabel("deg")], ["Side:", side.el]]), locked.el),
        box("Fabrication Attributes", form([["Footprint type:", type.el]], true), ...flags.map((f) => f.f.el))),
      form([["Library link:", h("span", { class: "pd-value" }, String(node[1] ?? ""))]], true));
    const clearances = h("div", null, h("p", { class: "pd-note" }, "Leave values blank to use Board Setup values."),
      box("Clearances", form([["Pad clearance:", clr.el, unitLabel()], ["Solder mask expansion:", mask.el, unitLabel()], ["Solder paste clearance:", paste.el, unitLabel()]])),
      box("Pad Connections", form([["Pad connection to zones:", zone.el]], true)));
    body.append(notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Clearance Overrides & Pad Connections", build: (el) => el.append(clearances) }]).el);
    return (n) => {
      const list = props(n);
      for (const r of g.rows()) {
        const p = list.find((q) => String(q[1]) === r.name); if (!p) continue;
        if (MAND.slice(0, 1).includes(String(r.name)) && !String(r.value).trim()) return "Reference designator cannot be empty.";
        const fx = FH().fieldEffects(p), a = FH().fieldAt(p), e = kid(p, "effects"), f = e ? kid(e, "font") : null, sz = f ? kid(f, "size") : null;
        if (String(r.value) !== sval(p, 2)) p[2] = String(r.value);
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
      const next: Record<string, unknown> = { type: type.get() }; for (const f of flags) next[f.k] = f.f.get();
      if (next.type !== attrs.type || flags.some((f) => f.f.get() !== !!attrs[f.k])) PH().setFootprintAttrs(n, next);
      const AFTER = ["solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"];
      const setOv = (key: string, f: Field<number>, before: string[]): void => { const v = f.get(); if (isFinite(v)) { if (!kid(n, key) || nval(kid(n, key)) !== v) put(n, key, `(${key} ${f6(v)})`, before); } else put(n, key, null); };
      setOv("solder_mask_margin", mask, AFTER); setOv("solder_paste_margin", paste, AFTER.slice(1)); setOv("clearance", clr, AFTER.slice(3));
      if (zone.get() !== (zc ? String(zc[1]) : "")) put(n, "zone_connect", zone.get() === "" ? null : `(zone_connect ${zone.get()})`, AFTER.slice(4));
      return undefined;
    };
  });
}

/** The KiCad dialog for a board item; false when this module has none for it (the caller falls back). */
export function pcbItemDialog(ctx: ToolCtx, item: KItem): boolean {
  if (!ctx.doc || ctx.doc.type !== "pcb" || !item) return false;
  if (typeof KDialogs === "undefined" || !KDialogs) return false;
  switch (item.kind) {
    case "segment": case "arc": return item.docType === "pcb" && !!kid(item.node, "width") ? trackViaDialog(ctx, item) : false;
    case "via": return trackViaDialog(ctx, item);
    case "zone": return kid(item.node, "keepout") ? false : zoneDialog(ctx, item);
    case "gr_text": return textDialog(ctx, item);
    case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": return shapeDialog(ctx, item);
    case "footprint": return footprintDialog(ctx, item);
    default: return false;
  }
}
