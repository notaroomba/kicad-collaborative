// importgfx/dialog.ts — File > Import > Graphics...: the schematic editor's DIALOG_IMPORT_GFX (Placement, Import
// Parameters, DXF Parameters) and the board editor's DIALOG_IMPORT_GRAPHICS (scale and size, DXF line width and units,
// Place at, target layer, group, Fix discontinuities).  OK reads the file (SVG or DXF), builds the editor's shapes
// and hands them to EE_GRAPHIC_TOOL::ImportGraphics / DRAWING_TOOL::PlaceImportedGraphics: placed where they are, or
// interactively on the cursor.  The dialogs remember their settings for the session, as DIALOG_SHIM does.
import { box, checkField, errorMessage, fmtLen, h, messageBox, openDialog, parseLen, selectField, unitLabel } from "../editor/pcbdialogs/ui";
import { E } from "../editor/state";
import { store } from "../editor/appstore";
import { toolCtx } from "../editor/tools";
import { DXF_UNIT_CHOICES, bboxOf, fixDiscontinuities, importDxf, importSvg, importerFor, toPrims, type ImportResult, type Prim, type V } from "./model";

type Editor = "sch" | "pcb";
interface Remembered { scale: string; lock: boolean; lineWidth: number; dxfUnit: number; interactive: boolean; x: number; y: number; origin: number; group: boolean; layerMode: "current" | "map" | "single"; layer: string; fix: boolean; tol: number }
const remembered: Record<Editor, Remembered> = {
  sch: { scale: "1.0", lock: true, lineWidth: 0, dxfUnit: 0, interactive: true, x: 0, y: 0, origin: 0, group: true, layerMode: "current", layer: "", fix: false, tol: 1 },
  pcb: { scale: "1.0", lock: false, lineWidth: 0.2, dxfUnit: 0, interactive: true, x: 0, y: 0, origin: 0, group: true, layerMode: "current", layer: "", fix: true, tol: 1 },
};
let lastFile: { name: string; text: string } | null = null;

const r6 = (v: number): number => +v.toFixed(6);
const xy = (p: V): SNode => ["xy", r6(p[0]), r6(p[1])];
const DASH: Record<string, string> = { solid: "solid", dash: "dash", dot: "dot", dash_dot: "dash_dot", dash_dot_dot: "dash_dot_dot" };
const strokeOf = (w: number, dash: string): SNode => ["stroke", ["width", r6(w)], ["type", DASH[dash] || "solid"]];

/** GRAPHICS_IMPORTER_PCBNEW: PCB_SHAPEs as PCB_IO_KICAD_SEXPR::format writes them. */
export function pcbNodes(prims: Prim[], layerOf: (p: Prim) => string): SNode[] {
  return prims.map((p): SNode => {
    const L: SNode = ["layer", layerOf(p)], st = strokeOf(p.width, p.dash);
    switch (p.t) {
      case "segment": return ["gr_line", ["start", r6(p.a[0]), r6(p.a[1])], ["end", r6(p.b[0]), r6(p.b[1])], st, L];
      case "circle": return ["gr_circle", ["center", r6(p.c[0]), r6(p.c[1])], ["end", r6(p.c[0] + p.r), r6(p.c[1])], st, ["fill", p.filled ? "yes" : "no"], L];
      case "arc": { let a = p.a, b = p.b; const m = p.m; if ((m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) < 0) [a, b] = [b, a]; return ["gr_arc", ["start", r6(a[0]), r6(a[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(b[0]), r6(b[1])], st, L]; }
      case "poly": return ["gr_poly", ["pts", ...p.pts.map(xy)], st, ["fill", p.filled ? "yes" : "no"], L];
      default: return ["gr_curve", ["pts", xy(p.a), xy(p.c1), xy(p.c2), xy(p.b)], st, L];
    }
  });
}
/** GRAPHICS_IMPORTER_SCH: SCH_LINEs and SCH_SHAPEs (a polygon closed on its first point, as AddPolygon does). */
export function schNodes(prims: Prim[]): SNode[] {
  const fill = (on: boolean): SNode => ["fill", ["type", on ? "outline" : "none"]];
  return prims.map((p): SNode => {
    const st = strokeOf(p.width, p.dash);
    switch (p.t) {
      case "segment": return ["polyline", ["pts", xy(p.a), xy(p.b)], st];
      case "circle": return ["circle", ["center", r6(p.c[0]), r6(p.c[1])], ["radius", r6(p.r)], st, fill(p.filled)];
      case "arc": return ["arc", ["start", r6(p.a[0]), r6(p.a[1])], ["mid", r6(p.m[0]), r6(p.m[1])], ["end", r6(p.b[0]), r6(p.b[1])], st, fill(false)];
      case "poly": return ["polyline", ["pts", ...p.pts.map(xy), xy(p.pts[0])], st, fill(p.filled)];
      default: return ["bezier", ["pts", xy(p.a), xy(p.c1), xy(p.c2), xy(p.b)], st, fill(false)];
    }
  });
}

function load(name: string, text: string, dxfUnit: number, lineWidth: number): ImportResult | null {
  const kind = importerFor(name);
  if (kind === "svg") return importSvg(text);
  if (kind === "dxf") return importDxf(text, dxfUnit, lineWidth);
  return null;
}

/** File > Import > Graphics... in the schematic (sch) or board (pcb) editor. */
export function openImportGraphics(editor: Editor): void {
  const ctx = toolCtx(); const doc = ctx.doc as KDoc | null;
  if (!doc || ctx.viewOnly) return;
  const st = remembered[editor];
  let file = lastFile, xScale = Number(st.scale) > 0 ? Number(st.scale) : 1, yScale = xScale, sourceSize: V = [0, 0];
  const fileInput = h("input", { type: "text", "data-k": "file", style: "flex:1;min-width:300px" }) as HTMLInputElement;
  fileInput.value = file ? file.name : "";
  const picker = h("input", { type: "file", accept: ".svg,.dxf,.SVG,.DXF", style: "display:none", "data-k": "file-picker" }) as HTMLInputElement;
  const browse = h("button", { class: "btn sm", type: "button", title: "Browse", "data-k": "browse" }, "...");
  browse.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const f = picker.files && picker.files[0]; if (!f) return;
    void f.text().then((text) => { file = { name: f.name, text }; fileInput.value = f.name; onFilenameChanged(); });
  });
  fileInput.addEventListener("change", () => onFilenameChanged());
  const num = (v: string, key: string, w = 120): HTMLInputElement => { const i = h("input", { type: "text", value: v, "data-k": key, style: `width:${w}px` }) as HTMLInputElement; return i; };
  const scale = num(st.scale, "scale"), width = num("", "importWidth"), height = num("", "importHeight");
  const lock = checkField(st.lock, "Lock height / width ratio", { key: "lockRatio" });
  const lineWidth = num(fmtLen(st.lineWidth), "lineWidth"), lineWidthLabel = h("label", { title: "Used when the DXF items in file have no line thickness set" }, editor === "pcb" ? "DXF default line width:" : "Default line width:"), lineWidthUnit = unitLabel();
  const dxfUnits = selectField<string>(String(st.dxfUnit), DXF_UNIT_CHOICES.map(([n], i): [string, string] => [String(i), n]), { key: "dxfUnits", onChange: () => { onFilenameChanged(); } });
  const dxfUnitsLabel = h("label", { title: "Used when the DXF file has no unit set" }, editor === "pcb" ? "DXF default units:" : "Default units:");
  const xCtl = num(fmtLen(st.x), "x", 90), yCtl = num(fmtLen(st.y), "y", 90);
  xCtl.title = "DXF origin on PCB Grid, X Coordinate"; yCtl.title = "DXF origin on PCB Grid, Y Coordinate";
  const group = checkField(st.group, "Group imported items", { key: "group", tip: "Add all imported items to a new group" });
  const dim = (els: Element[], on: boolean): void => { for (const e of els) { (e as HTMLInputElement).disabled = !on; e.classList.toggle("pd-dim", !on); } };

  /** sizeFromScale / scaleFromSize. */
  const sizeFromScale = (): void => {
    if (sourceSize[0] <= 0 || sourceSize[1] <= 0) { width.value = ""; height.value = ""; return; }
    width.value = fmtLen(sourceSize[0] * xScale); height.value = fmtLen(sourceSize[1] * yScale);
  };
  const scaleFromSize = (fromWidth: boolean): void => {
    if (sourceSize[0] <= 0 || sourceSize[1] <= 0) return;
    const w = parseLen(width.value), ht = parseLen(height.value), locked = lock.get();
    if (fromWidth && w > 0) xScale = w / sourceSize[0]; else if (!fromWidth && ht > 0) yScale = ht / sourceSize[1]; else return;
    if (locked) { if (fromWidth) yScale = xScale; else xScale = yScale; }
    scale.value = String(+xScale.toPrecision(6));
    if (locked && fromWidth) height.value = fmtLen(sourceSize[1] * yScale); else if (locked) width.value = fmtLen(sourceSize[0] * xScale);
  };
  scale.addEventListener("input", () => { const s = Number(scale.value.replace(",", ".")); if (!(s > 0)) return; xScale = yScale = s; sizeFromScale(); });
  width.addEventListener("input", () => scaleFromSize(true)); height.addEventListener("input", () => scaleFromSize(false));
  lock.input.addEventListener("change", () => { if (lock.get()) { yScale = xScale; sizeFromScale(); } });

  // ---- board-only controls
  const layers = Array.from(doc.layers.keys()).filter((l) => !/^(Rescue)$/.test(l));
  const layerName = (n: string): string => { const l = doc.layers.get(n); return l && l.userName ? l.userName : n; };
  const placeAt = checkField(!st.interactive, "Place at:", { key: "placeAt", tip: "If not checked: use interactive placement." });
  const origin = selectField<string>(String(st.origin), [["0", "Page origin"], ["1", "Drill/place file origin"], ["2", "Grid origin"], ["3", "User defined origin"]], { key: "origin" });
  const originLabel = h("label", null, "From:");
  const mode = (m: Remembered["layerMode"], key: string): HTMLInputElement => { const r = h("input", { type: "radio", name: "kd-ig-layer", "data-k": key }) as HTMLInputElement; r.checked = st.layerMode === m; return r; };
  const rbCurrent = mode("current", "currentLayer"), rbMap = mode("map", "mapLayers"), rbSingle = mode("single", "singleLayer");
  const singleLayer = selectField<string>(st.layer && layers.includes(st.layer) ? st.layer : (layers.includes("Dwgs.User") ? "Dwgs.User" : layers[0] || ""), layers.map((l): [string, string] => [l, layerName(l)]), { key: "layer" });
  const fix = checkField(st.fix, "Fix discontinuities", { key: "fixDiscontinuities", tip: "Trim/extend open shapes or add segments to make vertices of shapes coincide" });
  const tol = num(fmtLen(st.tol), "tolerance", 80), tolLabel = h("label", { style: "margin-left:30px" }, "Tolerance:"), tolUnit = unitLabel();
  // ---- schematic-only controls
  const rbInteractive = h("input", { type: "radio", name: "kd-ig-place", "data-k": "interactive" }) as HTMLInputElement, rbAt = h("input", { type: "radio", name: "kd-ig-place", "data-k": "at" }) as HTMLInputElement;
  rbInteractive.checked = st.interactive; rbAt.checked = !st.interactive;

  /** onUpdateUI / originOptionOnUpdateUI. */
  const sync = (): void => {
    const at = editor === "pcb" ? placeAt.get() : rbAt.checked;
    dim([xCtl, yCtl], at);
    if (editor === "pcb") { (origin.input as HTMLElement).toggleAttribute("disabled", !at); originLabel.classList.toggle("pd-dim", !at); dim([tol], fix.get()); tolLabel.classList.toggle("pd-dim", !fix.get()); (singleLayer.input as HTMLElement).toggleAttribute("disabled", !rbSingle.checked); }
  };
  /** onFilenameChanged: the DXF controls only for a DXF file; the source size for the size fields. */
  const onFilenameChanged = (): void => {
    const name = fileInput.value.trim(), kind = importerFor(name), dxf = kind ? kind === "dxf" : true;
    dim([lineWidth], dxf); lineWidthLabel.classList.toggle("pd-dim", !dxf); dxfUnitsLabel.classList.toggle("pd-dim", !dxf); (dxfUnits.input as HTMLElement).toggleAttribute("disabled", !dxf);
    if (editor === "pcb") { rbMap.disabled = !dxf; if (!dxf && rbMap.checked) rbSingle.checked = true; }
    sourceSize = [0, 0];
    if (file && file.name === name) { const r = load(name, file.text, Number(dxfUnits.get()), 0.2); if (r && r.width > 0 && r.height > 0 && isFinite(r.width) && isFinite(r.height)) sourceSize = [r.width, r.height]; }
    const known = sourceSize[0] > 0 && sourceSize[1] > 0; dim([width, height], known);
    lock.input.disabled = true; lock.el.classList.add("disabled"); lock.set(true);   // only a traced image may be stretched
    if (lock.get()) yScale = xScale;
    sizeFromScale(); sync();
  };
  for (const c of [rbCurrent, rbMap, rbSingle, rbInteractive, rbAt]) c.addEventListener("change", sync);
  placeAt.input.addEventListener("change", sync); fix.input.addEventListener("change", sync);

  const radio = (r: HTMLInputElement, label: string): HTMLElement => h("label", { class: "pd-check" }, r, label);
  const fileRow = h("div", { class: "pd-row", style: "flex-wrap:nowrap;margin:2px 0 10px" }, h("label", null, "File:"), fileInput, browse, picker);
  const grid3 = (rows: [HTMLElement | string, HTMLElement, HTMLElement | null][]): HTMLElement => {
    const g = h("div", { class: "pd-form", style: "grid-template-columns:max-content 140px max-content" });
    for (const [l, c, u] of rows) g.append(typeof l === "string" ? h("label", null, l) : l, c, u || h("span"));
    return g;
  };

  openDialog({ title: "Import Graphics File", width: editor === "pcb" ? 600 : 520,
    build(body) {
      body.append(fileRow);
      if (editor === "sch") {
        body.append(box("Placement", radio(rbInteractive, "Interactive placement"),
          h("div", { class: "pd-row", style: "flex-wrap:nowrap" }, radio(rbAt, "At"), h("label", null, "X:"), xCtl, unitLabel(), h("label", null, "Y:"), yCtl, unitLabel())));
        body.append(box("Import Parameters", grid3([["Import scale:", scale, null], ["Imported width:", width, unitLabel()], ["Imported height:", height, unitLabel()], ["", lock.el, null]]), group.el));
        body.append(box("DXF Parameters", grid3([[lineWidthLabel, lineWidth, lineWidthUnit], [dxfUnitsLabel, dxfUnits.el, null]])));
      } else {
        body.append(grid3([["Import scale:", scale, null], ["Imported width:", width, unitLabel()], ["Imported height:", height, unitLabel()], ["", lock.el, null],
          [lineWidthLabel, lineWidth, lineWidthUnit], [dxfUnitsLabel, dxfUnits.el, null]]));
        body.append(h("hr", { style: "border:none;border-top:1px solid var(--line);margin:8px 0" }),
          h("div", { class: "pd-row", style: "flex-wrap:nowrap;white-space:nowrap" }, placeAt.el, h("label", null, "X:"), xCtl, h("label", null, "Y:"), yCtl, unitLabel(), originLabel, origin.el),
          h("div", { class: "pd-row", style: "flex-wrap:nowrap;gap:18px" }, radio(rbCurrent, "Current layer"), radio(rbMap, "Map layers"), h("span", { class: "pd-inline", style: "gap:6px" }, radio(rbSingle, "Single layer:"), singleLayer.el)),
          group.el,
          h("hr", { style: "border:none;border-top:1px solid var(--line);margin:8px 0" }),
          h("div", { class: "pd-row", style: "flex-wrap:nowrap" }, fix.el, tolLabel, tol, tolUnit));
      }
      onFilenameChanged();
      setTimeout(() => fileInput.focus(), 0);
    },
    ok() {
      // TransferDataFromWindow
      const name = fileInput.value.trim();
      if (!name) { messageBox("Message", editor === "pcb" ? "Please select a file to import." : "No file selected!"); return false; }
      const kind = importerFor(name);
      if (!kind) { messageBox("Message", "There is no plugin to handle this file type."); return false; }
      if (!file || file.name !== name) { errorMessage(`Unable to read file '${name}'.`, () => browse.focus()); return false; }
      const s = Number(scale.value.replace(",", "."));
      if (!(s > 0)) { messageBox("Message", "Import scale must be a positive number."); return false; }
      const useSingle = editor === "pcb" && rbSingle.checked, useMap = editor === "pcb" && rbMap.checked && !rbMap.disabled;
      if (useSingle && !singleLayer.get()) { messageBox("Message", "Please select a valid layer."); return false; }
      const lw = kind === "dxf" ? parseLen(lineWidth.value) || 0 : 0;
      const interactive = editor === "pcb" ? !placeAt.get() : rbInteractive.checked;
      // remembered for the session
      Object.assign(st, { scale: scale.value, lock: lock.get(), lineWidth: parseLen(lineWidth.value) || 0, dxfUnit: Number(dxfUnits.get()), interactive, x: parseLen(xCtl.value) || 0, y: parseLen(yCtl.value) || 0,
        origin: Number(origin.get()), group: group.get(), layerMode: rbSingle.checked ? "single" : rbMap.checked ? "map" : "current", layer: editor === "pcb" ? singleLayer.get() : st.layer, fix: fix.get(), tol: parseLen(tol.value) || 0 });
      lastFile = file;
      const res = load(name, file.text, Number(dxfUnits.get()), lw);
      if (!res) { messageBox("Message", "There is no plugin to handle this file type."); return false; }
      // the origin: X / Y from the chosen board origin (the importer's offset is in file units, so divided by the scale)
      let off: V = [0, 0];
      if (!interactive) {
        off = [st.x, st.y];
        if (editor === "pcb") {
          const o = (E as unknown as { pcbOrigins?: { grid?: V; aux?: V } }).pcbOrigins || {}, vp = store.get().viewport as { userOrigin?: V };
          const add = st.origin === 1 ? o.aux : st.origin === 2 ? o.grid : st.origin === 3 ? vp.userOrigin : null;
          if (add) off = [off[0] + add[0], off[1] + add[1]];
        }
      }
      const activeLayer = (E as unknown as { activeLayer?: string }).activeLayer || "F.SilkS";
      const permitted = new Set(layers);
      const prims = toPrims(res.shapes, { scale: [xScale, yScale], offset: off, lineWidth: lw, iu: editor === "pcb" ? 1e-6 : 1e-4, noStroke: editor === "pcb" ? 0 : -0.0001 });
      const finish = (): void => {
        if (!prims.length) { messageBox("Message", "No graphic items found in file."); return; }
        if (editor === "pcb" && st.fix) fixDiscontinuities(prims, st.tol);
        const layerOf = (p: Prim): string => (useSingle ? singleLayer.get() : useMap && permitted.has(p.layer) ? p.layer : activeLayer);
        const nodes = editor === "pcb" ? pcbNodes(prims, layerOf) : schNodes(prims);
        const mod = (CollabTools as unknown as Record<string, { placeImported?(c: unknown, n: SNode[], o: unknown): boolean } | undefined>)[editor];
        if (mod && mod.placeImported) mod.placeImported(toolCtx(), nodes, { interactive, group: st.group });
      };
      // HTML_MESSAGE_BOX: not a fatal error, the import goes on after it
      if (res.messages.length) setTimeout(() => messageBox("Warning", "Items in the imported file could not be handled properly.\n\n" + res.messages.join("\n"), [{ label: "OK", fn: finish }]), 0);
      else setTimeout(finish, 0);
      return true;
    } });
}
/** The size an import would take, for tests: the bounding box of the shapes once scaled. */
export function importedSize(res: ImportResult, scaleBy: number): V { const b = bboxOf(res.shapes); return b ? [(b[2] - b[0]) * scaleBy, (b[3] - b[1]) * scaleBy] : [0, 0]; }
