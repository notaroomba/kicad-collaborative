// pcbdialogs/pad-props — Pad Properties (pcbnew/dialogs/dialog_pad_properties): the General, Connections and
// Clearance Overrides pages with the pad preview beside them, editing one pad of a footprint on the board.
//
// The dialog works on a copy of the footprint node and stores it as one MODIFIED change on OK, like every board
// item dialog.  Only what the user changed is written, and each child goes where PCB_IO_KICAD_SEXPR::format(PAD)
// puts it (PAD_ORDER below), in the writer's number format, so the desktop reads back exactly what it would have
// written itself.  Pads with a front/inner/back or custom padstack show their front-layer values (the mode is shown,
// not editable here); the Backdrill page, teardrop overrides, custom primitives and pad-to-die delay are kept as
// stored.
import { box, checkField, form, h, lenField, notebook, openDialog, selectField, textField, unitLabel, unitName, fmtLen, parseLen, type Field } from "./ui";
import type { DlgShape, DlgType, PadModel, padModel as PadModelApi } from "../../canvas/pad-model";

const PM = (): typeof PadModelApi => (KiCadCanvas as unknown as { padModel: typeof PadModelApi }).padModel;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const norm180 = (a: number): number => { let r = a % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return Math.round(r * 1e6) / 1e6; };
const f6 = (v: number): string => PM().f6(v);

// ---------------------------------------------------------------- the preview (m_padPreviewGAL)
function drawPreview(cv: HTMLCanvasElement, m: PadModel, sketch: boolean, copper: string[]): void {
  const g = cv.getContext("2d"); if (!g) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 280, H = cv.clientHeight || 280;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const KC = KiCadCanvas as unknown as { PCB_BG?: string; pcbColor?(l: string): string };
  const color = (l: string): string => (KC.pcbColor ? KC.pcbColor(l) : "#C83434");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = KC.PCB_BG || "#001023"; g.fillRect(0, 0, W, H);
  const layers = PM().modelLayers(m, copper);
  const cuLayer = layers.has("F.Cu") ? "F.Cu" : layers.has("B.Cu") ? "B.Cu" : Array.from(layers).find((l) => /\.Cu$/.test(l)) || (m.tech["F.Paste"] ? "F.Paste" : m.tech["B.Paste"] ? "B.Paste" : "F.Cu");
  const hh = m.shape === "circle" ? m.w : m.h;
  const ext = Math.max(m.w, hh, m.hx + 2 * Math.abs(m.ox), (m.holeOblong ? m.hy : m.hx) + 2 * Math.abs(m.oy)) + 2 * Math.max(0, isNaN(m.clearance) ? 0 : m.clearance);
  const s = ext > 0 ? Math.min(W, H) * 0.7 / ext : 10;
  g.save(); g.translate(W / 2, H / 2);
  // axes through the pad's position, as KiCad's preview shows its origin
  g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 1; g.beginPath(); g.moveTo(-W / 2, 0); g.lineTo(W / 2, 0); g.moveTo(0, -H / 2); g.lineTo(0, H / 2); g.stroke();
  g.rotate(-m.angle * Math.PI / 180);
  const ox = m.offset ? m.ox * s : 0, oy = m.offset ? m.oy * s : 0;
  const path = (grow: number): void => {
    const w = m.w * s + 2 * grow, h2 = hh * s + 2 * grow; g.beginPath();
    if (m.shape === "circle" || m.shape === "custom_circle") { g.arc(ox, oy, w / 2, 0, Math.PI * 2); return; }
    if (m.shape === "oval") { const r = Math.min(w, h2) / 2; g.roundRect(ox - w / 2, oy - h2 / 2, w, h2, r); return; }
    if (m.shape === "trapezoid") { const d = m.delta * s / 2; const dx = m.deltaAxis === 1 ? d : 0, dy = m.deltaAxis === 0 ? d : 0;
      g.moveTo(ox - w / 2 - dx, oy + h2 / 2 + dy); g.lineTo(ox - w / 2 + dx, oy - h2 / 2 - dy); g.lineTo(ox + w / 2 - dx, oy - h2 / 2 + dy); g.lineTo(ox + w / 2 + dx, oy + h2 / 2 - dy); g.closePath(); return; }
    if (m.shape === "chamfer" || m.shape === "mixed") {
      const c = Math.min(w, h2) * m.cratio, r = m.shape === "mixed" ? Math.min(w, h2) * m.rratio : 0; const x0 = ox - w / 2, y0 = oy - h2 / 2, x1 = ox + w / 2, y1 = oy + h2 / 2;
      const [tl, tr, bl, br] = m.corners;
      g.moveTo(x0 + (tl ? c : r), y0); g.lineTo(x1 - (tr ? c : r), y0); if (tr) g.lineTo(x1, y0 + c); else g.arcTo(x1, y0, x1, y0 + r, r);
      g.lineTo(x1, y1 - (br ? c : r)); if (br) g.lineTo(x1 - c, y1); else g.arcTo(x1, y1, x1 - r, y1, r);
      g.lineTo(x0 + (bl ? c : r), y1); if (bl) g.lineTo(x0, y1 - c); else g.arcTo(x0, y1, x0, y1 - r, r);
      g.lineTo(x0, y0 + (tl ? c : r)); if (tl) g.lineTo(x0 + c, y0); else g.arcTo(x0, y0, x0 + r, y0, r); g.closePath(); return;
    }
    const r = m.shape === "roundrect" ? Math.min(w, h2) * m.rratio + (grow > 0 ? 0 : 0) : 0;
    g.roundRect(ox - w / 2, oy - h2 / 2, w, h2, Math.max(0, r));
  };
  if (!isNaN(m.clearance) && m.clearance > 0) { g.setLineDash([4, 3]); g.strokeStyle = "rgba(255,255,255,0.6)"; path(m.clearance * s); g.stroke(); g.setLineDash([]); }
  const hasCopper = Array.from(layers).some((l) => /\.Cu$/.test(l));
  if (hasCopper || m.type === "aperture") {
    g.fillStyle = color(cuLayer); g.strokeStyle = color(cuLayer); g.lineWidth = 1.5; path(0); if (sketch) g.stroke(); else g.fill();
  }
  if ((m.type === "pth" || m.type === "npth") && m.hx > 0) {
    const hw = m.hx * s, hh2 = (m.holeOblong ? m.hy : m.hx) * s; g.beginPath(); g.roundRect(-hw / 2, -hh2 / 2, hw, hh2, Math.min(hw, hh2) / 2);
    g.fillStyle = m.type === "npth" ? "#1AC4D2" : KC.PCB_BG || "#001023"; g.strokeStyle = m.type === "npth" ? "#1AC4D2" : "#E3B72E"; g.lineWidth = 1.5;
    if (sketch) g.stroke(); else { g.fill(); if (m.type === "pth") g.stroke(); }
  }
  g.restore();
}

// ---------------------------------------------------------------- the dialog
interface NetHelpers { netNameOf(doc: KDoc, node: SNode): string; boardNetNames(doc: KDoc): string[]; netCodeOf(doc: KDoc, name: string): number }
const PH = (): NetHelpers => (CollabTools as unknown as { props: { helpers: NetHelpers } }).props.helpers;

/** DIALOG_PAD_PROPERTIES for pad `index` of a board footprint. */
export function padPropertiesDialog(ctx: ToolCtx, fpItem: KItem, index: number): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const item = doc.items.get(fpItem.id) || fpItem;
  const staged = (K().cloneNode as (n: SNode) => SNode)(item.node);
  const pads = K().kids(staged, "pad") as SNode[]; const pad = pads[index]; if (!pad) return false;
  const was = PM().readPad(doc, staged, pad, PH().netNameOf(doc, pad));
  const m: PadModel = structuredClone(was);   // NaN ("not set") must survive the copy
  const ro = !!ctx.viewOnly; const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const flipped = str((kid(staged, "layer") || [])[1]) === "B.Cu";
  const padstack = kid(pad, "padstack"); const psMode = str((kid(padstack, "mode") || [])[1]);
  let redraw = (): void => undefined, readAll = (): void => undefined;
  const ref = str((K().kids(staged, "property") as SNode[]).find((p) => str(p[1]) === "Reference")?.[2] || "");
  openDialog({
    title: "Pad Properties", width: 1060, readOnly: ro,
    build(body) {
      // ---- General
      const general = h("div", { class: "pp-general" });
      const type = selectField<DlgType>(m.type, [["pth", "Through-hole"], ["smd", "SMD"], ["conn", "Edge Connector"], ["npth", "NPTH, Mechanical"], ["aperture", "SMD Aperture"]], { ro, key: "padType", onChange: (v) => { m.type = v; onType(); } });
      const number = textField(m.number, { ro, key: "padNumber" });
      const netNames = PH().boardNetNames(doc).filter(Boolean); if (m.net && !netNames.includes(m.net)) netNames.unshift(m.net);
      const net = selectField<string>(m.net, [["", "<no net>"], ...netNames.map((n): [string, string] => [n, n])], { ro, key: "padNet", onChange: (v) => { m.net = v; } });
      const px = lenField(m.x, { ro, key: "posX" }), py = lenField(m.y, { ro, key: "posY" });
      const psModeSel = selectField<string>(psMode === "front_inner_back" ? "fib" : psMode === "custom" ? "custom" : "normal", [["normal", "Normal"], ["fib", "Front/Inner/Back"], ["custom", "Custom"]], { ro: true, key: "padstackMode" });
      psModeSel.input.title = padstack ? "This pad's padstack has per-layer shapes; the front layer is edited here" : "";
      const shape = selectField<DlgShape>(m.shape, [["circle", "Circular"], ["oval", "Oval"], ["rect", "Rectangular"], ["trapezoid", "Trapezoidal"], ["roundrect", "Rounded rectangle"], ["chamfer", "Chamfered rectangle"],
        ["mixed", "Chamfered with other corners rounded"], ["custom_circle", "Custom (circular base)"], ["custom_rect", "Custom (rectangular base)"]], { ro, key: "padShape", onChange: (v) => {
        // onPadShapeSelection( true ): a circle's default spoke angle is 45°, the others' 90°
        const wasCircle = m.shape === "circle"; m.shape = v; readAll();
        if (v === "circle" && !wasCircle && m.spokeAngle === 90) { m.spokeAngle = 45; spokeAngle.value = "45"; }
        else if (v !== "circle" && wasCircle && m.spokeAngle === 45) { m.spokeAngle = 90; spokeAngle.value = "90"; }
        onShape(); } });
      // the shape's own properties (m_shapePropsBook)
      const delta = lenField(m.delta, { ro, key: "trapDelta" }), axis = selectField<number>(m.deltaAxis, [[0, "Horizontal"], [1, "Vertical"]], { ro, key: "trapAxis" });
      const pct = (v: number): string => f6(v * 100);
      const ratio = h("input", { type: "text", value: pct(m.rratio), disabled: ro, "data-k": "cornerRatio", title: "Corner radius in percent  of the pad width.\nThe width is the smaller value between size X and size Y.\nThe max value is 50 percent." });
      const radius = lenField(m.rratio * Math.min(m.w, m.h), { ro, key: "cornerRadius" });
      const cratio = h("input", { type: "text", value: pct(m.cratio), disabled: ro, "data-k": "chamferRatio", title: "Chamfer size in percent of the pad width.\nThe width is the smaller value between size X and size Y.\nThe max value is 50 percent." });
      const corner = ["Top left", "Top right", "Bottom left", "Bottom right"].map((l, i) => checkField(m.corners[i], l, { ro, key: "chamfer" + i, onChange: (v) => { m.corners[i] = v; redraw(); } }));
      const shapeProps = h("div", { class: "pp-shapeprops" });
      const trapRows = form([["Trapezoid delta:", delta.el, unitLabel()], ["Trapezoid axis:", axis.el]]);
      const roundRows = form([["Corner size:", ratio, unitLabel("%")], ["Corner radius:", radius.el, unitLabel()]]);
      const chamferRows = form([["Chamfer size:", cratio, unitLabel("%")], ["Chamfer corners:", h("div", { class: "pp-corners" }, ...corner.map((c) => c.el))]]);
      shapeProps.append(trapRows, chamferRows, roundRows);
      const sx = lenField(m.w, { ro, key: "sizeX" }), sy = lenField(m.h, { ro, key: "sizeY" });
      const angle = h("input", { type: "text", value: f6(m.angle), list: "pp-angles", disabled: ro, "data-k": "angle", style: "width:100px" });
      const angles = h("datalist", { id: "pp-angles" }, ...["0", "90", "-90", "180"].map((a) => h("option", { value: a })));
      const offOn = checkField(m.offset, "Offset shape from hole", { ro, key: "offset", onChange: (v) => { m.offset = v; offX.input.disabled = offY.input.disabled = ro || !v; redraw(); } });
      const offX = lenField(m.ox, { ro: ro || !m.offset, key: "offsetX" }), offY = lenField(m.oy, { ro: ro || !m.offset, key: "offsetY" });
      const holeShape = selectField<number>(m.holeOblong ? 1 : 0, [[0, "Round"], [1, "Oblong"]], { ro, key: "holeShape", onChange: (v) => { m.holeOblong = v === 1; holeY.input.disabled = ro || !m.holeOblong || !holed(); redraw(); } });
      const holeX = lenField(m.hx, { ro, key: "holeX" }), holeY = lenField(m.holeOblong ? m.hy : m.hx, { ro: ro || !m.holeOblong, key: "holeY" });
      const dieOn = checkField(m.dieOn, "Specify pad to die length", { ro, key: "dieOn", onChange: (v) => { m.dieOn = v; die.input.disabled = ro || !v; } });
      const die = lenField(m.die, { ro: ro || !m.dieOn, key: "dieLength" });
      const xy = (a: Field<number>, b: Field<number>): HTMLElement => h("span", { class: "pd-xy" }, a.el, h("span", { class: "unit" }, unitName()), h("label", null, "Y:"), b.el);
      const left = h("div", { class: "pp-col" },
        form([["Pad type:", type.el], ["Pad number:", number.el], ["Net name:", net.el], ["Position X:", xy(px, py), unitLabel()]], true),
        h("hr", { class: "pp-hr" }),
        form([["Padstack mode:", psModeSel.el], ["Edit layer:", selectField<string>("F.Cu", [["F.Cu", padstack ? "F.Cu" : "All layers"]], { ro: true, key: "editLayer" }).el]], true),
        h("hr", { class: "pp-hr" }),
        form([["Pad shape:", shape.el]], true), shapeProps,
        form([["Pad size X:", xy(sx, sy), unitLabel()], ["Angle:", h("span", null, angle, angles), unitLabel("deg")]], true),
        h("div", { class: "pp-row" }, offOn.el), form([["X:", xy(offX, offY), unitLabel()]], true),
        h("hr", { class: "pp-hr" }),
        form([["Hole shape:", holeShape.el], ["Hole size X:", xy(holeX, holeY), unitLabel()]], true),
        h("hr", { class: "pp-hr" }),
        h("div", { class: "pp-row" }, dieOn.el, die.el, unitLabel()));
      // layers (the middle column)
      const copperSel = h("k-select", { disabled: ro, "data-k": "copperLayers" }) as HTMLSelectElement;
      const fillCopper = (): void => { copperSel.replaceChildren(...PM().copperChoices(m.type).map((l, i) => h("option", { value: String(i) }, l))); if (m.copper >= copperSel.options.length) m.copper = 0; copperSel.selectedIndex = m.copper; copperSel.disabled = ro || m.type === "aperture"; };
      copperSel.addEventListener("change", () => { m.copper = copperSel.selectedIndex; redraw(); });
      const techChecks = PM().TECH.map(([label, l]) => checkField(!!m.tech[l], label, { ro, key: "layer-" + l, onChange: (v) => { m.tech[l] = v; redraw(); } }));
      const prop = selectField<string>(m.property, PM().PROPS, { ro, key: "fabProperty", onChange: (v) => { m.property = v; } });
      prop.input.title = "Optional property to specify a special purpose or constraint in fabrication files:\nBGA attribute is for pads in BGA footprints\nFiducial local is a fiducial for the parent footprint\nFiducial global is a fiducial for the whole board\nTest Point specifies an electrical test point\nHeatsink specifies a thermal pad\nCastellated specifies a through hole pad on a board edge\nMechanical specifies a through-hole pad that is used for mechanical support";
      const middle = h("div", { class: "pp-col" },
        h("div", { class: "pd-box" },
          flipped ? h("div", { class: "pd-info" }, "Parent footprint on board is flipped.\nLayers will be reversed.") : null,
          form([["Copper layers:", copperSel]], true),
          h("div", { class: "pp-techhd" }, "Technical Layers"), h("div", { class: "pp-tech" }, ...techChecks.map((c) => c.el))),
        form([["Fabrication property:", prop.el]], true));
      // preview
      const cv = h("canvas", { class: "pp-preview" });
      const sketch = checkField(false, "Preview pad in sketch mode", { key: "sketch", onChange: () => redraw() });
      const right = h("div", { class: "pp-col pp-right" }, cv, sketch.el);
      general.append(left, middle);
      // ---- Connections
      const zc = selectField<number>(m.zoneConnect, [[-1, "From parent footprint"], [2, "Solid"], [1, "Thermal relief"], [0, "None"]], { ro, key: "zoneConnect", onChange: (v) => { m.zoneConnect = v; } });
      const knock = selectField<string>(m.knockout, [["outline", "Pad shape"], ["convexhull", "Pad convex hull"]], { ro: ro || !m.shape.startsWith("custom"), key: "zoneKnockout", onChange: (v) => { m.knockout = v as PadModel["knockout"]; } });
      const optLen = (v: number, key: string): Field<number> => lenField(v, { ro, key, allowEmpty: true });
      const gap = optLen(m.gap, "reliefGap"), spoke = optLen(m.spoke, "spokeWidth");
      const spokeAngle = h("input", { type: "text", value: f6(m.spokeAngle), disabled: ro, "data-k": "spokeAngle", style: "width:100px" });
      const connections = h("div", { class: "pp-page" },
        box("Connection to Copper Zones", form([["Pad connection:", zc.el], ["Zone knockout:", knock.el]], true)),
        box("Thermal Relief Overrides", form([["Relief gap:", gap.el, unitLabel()], ["Spoke width:", spoke.el, unitLabel()], ["Spoke angle:", spokeAngle, unitLabel("deg")]])));
      // ---- Clearance Overrides
      const clr = optLen(m.clearance, "padClearance"), mask = optLen(m.mask, "maskMargin");
      const pasteText = (): string => { const parts: string[] = []; if (!isNaN(m.paste)) parts.push(fmtLen(m.paste) + " " + unitName()); if (!isNaN(m.pasteRatio)) parts.push((parts.length && m.pasteRatio >= 0 ? "+ " : "") + f6(m.pasteRatio * 100) + "%"); return parts.join(" "); };
      const paste = h("input", { type: "text", value: pasteText(), disabled: ro, "data-k": "pasteMargin", title: "Local solder paste clearance for this pad.\nEnter an absolute value (e.g., -0.1mm), a percentage (e.g., -5%), or both (e.g., -0.1mm - 5%).\nIf blank, the footprint or global value is used." });
      const clearance = h("div", { class: "pp-page" },
        h("p", { class: "pd-note" }, "Leave values blank to use parent footprint or netclass values."),
        h("p", { class: "pd-note" }, "Positive clearance means area bigger than the pad (usual for mask clearance)."),
        h("p", { class: "pd-note" }, "Negative clearance means area smaller than the pad (usual for paste clearance)."),
        form([["Pad clearance:", clr.el, unitLabel(), "This is the local net clearance for this pad.\nIf 0, the footprint local value or the Netclass value is used."],
          ["Solder mask expansion:", mask.el, unitLabel(), "This is the local clearance between this pad and the solder mask.\nIf 0, the footprint local value or the global value is used."],
          ["Solder paste clearance:", paste, h("span")]]),
        h("p", { class: "pd-note" }, "Note: solder mask and paste values are used only for pads on copper layers."));
      const nb = notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Connections", build: (el) => el.append(connections) }, { label: "Clearance Overrides", build: (el) => el.append(clearance) }], { onShow: () => redraw() });
      body.append(h("style", null, PP_CSS), h("div", { class: "pp-wrap" }, h("div", { class: "pp-book" }, nb.el), right));
      // ---- behaviour (DIALOG_PAD_PROPERTIES::OnPadShapeSelection / PadTypeSelected / UpdateLayersDropdown)
      const holed = (): boolean => m.type === "pth" || m.type === "npth";
      function onShape(): void {
        trapRows.style.display = m.shape === "trapezoid" ? "" : "none";
        roundRows.style.display = m.shape === "roundrect" || m.shape === "mixed" ? "" : "none";
        chamferRows.style.display = m.shape === "chamfer" || m.shape === "mixed" ? "" : "none";
        sy.input.disabled = ro || m.shape === "circle" || m.shape === "custom_circle";
        if (m.shape === "circle") sy.set(sx.get());
        knock.input.disabled = ro || !m.shape.startsWith("custom");
        // KiCad's defaults on a shape change: the IPC corner radius, a 20% chamfer on the top-left corner
        const ipc = (): number => { const mn = Math.min(m.w, m.h); return mn > 0 ? Math.min(0.25, mn * 0.25) / mn : 0.25; };
        if ((m.shape === "roundrect" || m.shape === "mixed") && !(m.rratio > 0)) { m.rratio = ipc(); ratio.value = pct(m.rratio); radius.set(m.rratio * Math.min(m.w, m.h)); }
        if ((m.shape === "chamfer" || m.shape === "mixed") && !(m.cratio > 0)) { m.cratio = 0.2; cratio.value = pct(m.cratio); }
        if ((m.shape === "chamfer" || m.shape === "mixed") && !m.corners.some(Boolean)) { m.corners = [true, false, false, false]; corner.forEach((c, i) => c.set(i === 0)); }
        redraw();
      }
      function onType(): void {
        const conn = m.type !== "npth" && m.type !== "aperture";
        number.input.disabled = ro || !conn; net.input.disabled = ro || !conn;
        holeShape.input.disabled = ro || !holed(); holeX.input.disabled = ro || !holed(); holeY.input.disabled = ro || !holed() || !m.holeOblong;
        // KiCad's default technical layers per type (PAD::PTHMask etc.) when the type changes
        if (m.type !== was.type || type.input.dataset.touched) {
          type.input.dataset.touched = "1";
          const set = m.type === "pth" ? ["F.Mask", "B.Mask"] : m.type === "npth" ? ["F.Mask", "B.Mask"] : m.type === "conn" ? ["F.Mask"] : m.type === "aperture" ? ["F.Paste"] : ["F.Paste", "F.Mask"];
          for (const [, l] of PM().TECH) m.tech[l] = set.includes(l); techChecks.forEach((c, i) => c.set(!!m.tech[PM().TECH[i][1]]));
          if (m.type === "pth" || m.type === "npth") { if (!(m.hx > 0)) { m.hx = m.hy = Math.max(0.1, Math.min(m.w, m.h) / 2); holeX.set(m.hx); holeY.set(m.hy); } }
          m.copper = 0;
        }
        fillCopper(); redraw();
      }
      readAll = (): void => {
        m.number = number.get(); m.x = px.get(); m.y = py.get(); m.w = sx.get(); m.h = m.shape === "circle" ? m.w : sy.get();
        const a = Number(String(angle.value).replace(",", ".")); if (!isNaN(a)) m.angle = norm180(a);
        m.delta = delta.get(); m.deltaAxis = axis.get() === 1 ? 1 : 0;
        const r = Number(ratio.value.replace(",", ".")); if (!isNaN(r)) m.rratio = Math.max(0, Math.min(50, r)) / 100;
        const c = Number(cratio.value.replace(",", ".")); if (!isNaN(c)) m.cratio = Math.max(0, Math.min(50, c)) / 100;
        m.ox = offX.get(); m.oy = offY.get(); m.hx = holeX.get(); m.hy = m.holeOblong ? holeY.get() : m.hx; m.die = die.get();
        m.gap = gap.get(); m.spoke = spoke.get(); const sa = Number(spokeAngle.value.replace(",", ".")); if (!isNaN(sa)) m.spokeAngle = sa;
        m.clearance = clr.get(); m.mask = mask.get();
        const pt = paste.value.trim(); if (!pt) { m.paste = NaN; m.pasteRatio = NaN; }
        else { const pm = /^\s*([-+]?\s*[\d.,]+\s*(?:mm|mils?|in|")?)?\s*(?:([-+])?\s*([\d.,]+)\s*%)?\s*$/i.exec(pt);
          if (pm) { m.paste = pm[1] && !/%/.test(pm[1]) ? parseLen(pm[1].replace(/\s+/g, "")) : NaN; m.pasteRatio = pm[3] ? (pm[2] === "-" || (!pm[1] && /^-/.test(pt)) ? -1 : 1) * Number(pm[3].replace(",", ".")) / 100 : NaN; } }
      };
      // corner size and radius follow each other
      ratio.addEventListener("change", () => { readAll(); radius.set(m.rratio * Math.min(m.w, m.h)); ratio.value = pct(m.rratio); redraw(); });
      radius.input.addEventListener("change", () => { const mn = Math.min(sx.get(), sy.get()); if (mn > 0) { m.rratio = Math.max(0, Math.min(0.5, radius.get() / mn)); ratio.value = pct(m.rratio); } redraw(); });
      body.addEventListener("input", () => { readAll(); redraw(); });
      body.addEventListener("change", () => { readAll(); redraw(); });
      redraw = (): void => drawPreview(cv, m, sketch.get(), copper);
      onShape(); fillCopper(); onType();
      requestAnimationFrame(() => redraw());
    },
    ok() {
      if (ro) return true;
      readAll();
      const { errors, warnings } = PM().checkPad(m);
      if (errors.length) { messageList("Pad Properties Errors", errors.concat(warnings)); return false; }
      const commit = (): void => {
        PM().writePad(doc, staged, pad, m, was, (name) => PH().netCodeOf(doc, name));
        const before = K().serialize(item.node); if (K().serialize(staged) === before) return;
        ctx.commit([K().replaceChange(doc, { ...item, node: staged, geom: [], bbox: null })], `pad ${ref ? ref + " " : ""}${m.number || was.number}`.trim());
        ctx.requestRender();
      };
      if (warnings.length) { messageList("Pad Properties Warnings", warnings); }
      commit();
      return true;
    },
  });
  return true;
}

function messageList(title: string, lines: string[]): void {
  openDialog({ title, width: 480, noOk: true, cancelLabel: "OK", build(body) { body.append(h("ul", { class: "pp-msgs" }, ...lines.map((l) => h("li", null, l)))); } });
}

const PP_CSS = `
.pp-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; min-height: 610px; }
.pp-general { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 0 18px; }
.pp-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pp-right { align-items: stretch; padding-top: 34px; }
.pp-preview { width: 100%; height: 300px; border: 1px solid var(--line); border-radius: 3px; display: block; }
.pp-hr { border: none; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }
.pp-row { display: flex; gap: 8px; align-items: center; }
.pp-row input[type=text] { width: 110px; }
.pp-corners { display: grid; grid-template-columns: max-content max-content; gap: 2px 12px; }
.pp-tech { display: grid; grid-template-columns: 1fr; gap: 0; }
.pp-techhd { font-weight: 600; margin: 8px 0 2px; }
.pp-shapeprops .pd-form { margin: 2px 0; }
.pp-page { padding: 4px 2px; }
.pp-msgs { margin: 4px 0; padding-left: 18px; }
.pp-msgs li { margin: 3px 0; }
.pp-wrap .pd-xy { display: inline-flex; gap: 6px; align-items: center; }
.pp-wrap .pd-xy input { width: 92px; }
.pd-info { white-space: pre-line; }
`;
