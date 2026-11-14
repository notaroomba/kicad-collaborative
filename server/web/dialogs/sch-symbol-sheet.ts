// dialogs/sch-symbol-sheet.ts — DIALOG_SYMBOL_PROPERTIES and DIALOG_SHEET_PROPERTIES.
//
// Symbol Properties: a General tab (the fields grid, Unit:, Body style:, Angle:, Mirror:, Library link:,
// Composed reference:, the Attributes box and Show pin numbers / Show pin names) and a Pin Functions tab (alternate
// pin assignments, written as (pin "n" (alternate "…"))), with Update Symbol from Library... and Change Symbol...
// buttons into DIALOG_CHANGE_SYMBOLS.  OK autoplaces the fields when the symbol has fields_autoplaced.
//
// Sheet Properties: the fields grid (Sheetname, Sheetfile and user fields), Border width / color, Background fill,
// Page number:, Hierarchical path:, the Attributes box, and SCH_EDIT_FRAME::ChangeSheetFile's rules for a new file
// name (link an existing file, or copy this sheet's contents to the new file).  Drawing a sheet opens it first.
import { E, api, appState, rootSchematic, toast } from "./editor";
import { KD, checkbox, confirmBox, h, popupMenu, promptText, select, textInput, type PopItem } from "./dom";
import * as P from "./sym-props-logic";
import { commitWithOtherUnits } from "./sync-units";
import * as L from "./sch-items-logic";
import { fieldsGrid, messageBox, swatch, type Swatch } from "./sch-items";
import { openChangeSymbols } from "./change-symbols";
import { openSimModel } from "./sim-model";
import { embeddedModelFiles, projectModelFiles, refPrefix, simPinsOfLib } from "./sim-files";
import { docBase, projectDocs, readDoc, submitDocOp } from "./project";
import { currentInstance, loadSheets, netMap } from "../editor/schnets";
import { fmtLen, parseLen, unitName } from "../editor/pcbdialogs/ui";
import * as VM from "../canvas/variant-model";
import { writeSymbolVariant } from "./variant-edits";
import { chooserFilters } from "../library/fpchoice";
import { docFiles, relativePath } from "./browse-cells";

type Ctx = ToolCtx & { doc: KDoc };
interface PropsHelpers {
  setSymbolRotation(n: SNode, deg: number): void; setSymbolMirror(n: SNode, m: string): void; setSymbolUnit(n: SNode, u: number): void;
  libUnitCount(doc: KDoc, n: SNode): number; mirrorOf(n: SNode): string;
}
interface SchHelpers { autoplaceNode(doc: KDoc, item: KItem, opts?: unknown): SNode | null; symbolPins(doc: KDoc, item: KItem): { number: string; name: string; type: string }[] }
const PH = (): PropsHelpers => (CollabTools as unknown as { props: { helpers: PropsHelpers } }).props.helpers;
const SH = (): SchHelpers | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchHelpers : null; };
const MANDATORY_SYMBOL = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const nextName = (rows: L.FieldRow[]): string => { let n = 1; const s = new Set(rows.map((r) => r.name)); while (s.has("Field" + n)) n++; return "Field" + n; };
const units = () => h("span", { class: "kd-note" }, unitName());
const lenBox = (mm: number, id: string): HTMLInputElement => { const i = textInput(fmtLen(mm), undefined, { id, style: "width:90px" }); i.addEventListener("change", () => { const v = parseLen(i.value); if (Number.isFinite(v)) i.value = fmtLen(v); }); return i; };
const lenOf = (i: HTMLInputElement, d: number): number => { const v = parseLen(i.value); return Number.isFinite(v) ? v : d; };
const flag = (n: SNode, k: string, dflt: boolean): boolean => (L.kid(n, k) ? L.yes(n, k) : dflt);
function setFlag(n: SNode, k: string, on: boolean): void { const c = L.kid(n, k); if (c) c[1] = (on ? "yes" : "no") as unknown as SNode; else L.put(n, k, [on ? "yes" : "no"], ["fields_autoplaced", "stroke", "uuid", "property"]); }

/** The sheet path on screen ("/<root uuid>/<sheet uuid>…") and the project name its instance data is filed under. */
export function sheetPathNow(doc: KDoc): { path: string | null; project: string | null } {
  const inst = currentInstance(netMap());
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  let project: string | null = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  let path: string | null = inst && inst.uuidPath.length ? "/" + inst.uuidPath.join("/") : null;
  if (!path || !project) { const H = SH() as (SchHelpers & { sheetPathHere?(d: KDoc): { path: string | null; project: string | null } }) | null; const f = H && H.sheetPathHere ? H.sheetPathHere(doc) : null; if (f) { path = path || f.path; project = project || f.project; } }
  return { path, project };
}

// ---------------------------------------------------------------- the library symbol's pins and options
interface LibPin { number: string; name: string; type: string; style: string; alternates: string[] }
function libPins(lib: SNode | null, unit: number, body: number): LibPin[] {
  const out: LibPin[] = []; if (!lib) return out;
  const seen = new Set<string>();
  for (const s of L.kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(L.str(s[1])); const u = m ? +m[1] : 0, b = m ? +m[2] : 0;
    if ((u && u !== unit) || (b && b !== body)) continue;
    for (const p of L.kids(s, "pin")) {
      const num = L.kid(p, "number"), nm = L.kid(p, "name"), n = num ? L.str(num[1]) : ""; if (seen.has(n)) continue; seen.add(n);
      out.push({ number: n, name: nm ? L.str(nm[1]) : "", type: L.str(p[1]), style: L.str(p[2]), alternates: L.kids(p, "alternate").map((a) => L.str(a[1])) });
    }
  }
  return out.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}
const bodyStyles = (lib: SNode | null): number => { let n = 1; if (lib) for (const s of L.kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(L.str(s[1])); if (m) n = Math.max(n, +m[2]); } return n; };
const pinHidden = (lib: SNode | null, key: "pin_numbers" | "pin_names"): boolean => { const c = lib && L.kid(lib, key); return !!c && ((c as unknown[]).includes("hide") || (!!L.kid(c, "hide") && L.str((L.kid(c, "hide") as SNode)[1]) !== "no")); };
const TYPE_NAMES: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
const STYLE_NAMES: Record<string, string> = { line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low", clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic" };

// ---------------------------------------------------------------- DIALOG_SYMBOL_PROPERTIES
/** Every pin of the library symbol across its units (GetLogicalPins( 0, 0 )): number, name and unit, first seen wins. */
function logicalPins(lib: SNode | null): { number: string; name: string; unit: number }[] {
  const out: { number: string; name: string; unit: number }[] = []; if (!lib) return out; const seen = new Set<string>();
  for (const s of L.kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(L.str(s[1])); const u = m ? +m[1] : 0;
    for (const p of L.kids(s, "pin")) { const num = L.kid(p, "number"), nm = L.kid(p, "name"), n = num ? L.str(num[1]) : ""; if (seen.has(n)) continue; seen.add(n); out.push({ number: n, name: nm ? L.str(nm[1]) : "", unit: u }); } }
  return out;
}
/** The current sheet path's composed reference suffix (the sheets' "Reference Suffix" fields, root first). */
function pathRefSuffix(): string {
  const c = netMap(), here = currentInstance(c); if (!c || !here) return "";
  const nodes: (SNode | null)[] = [];
  for (const id of here.uuidPath.slice(1)) { let hit: SNode | null = null; for (const d of c.docs.values()) { const it = d.items.get(id); if (it && it.kind === "sheet") { hit = it.node; break; } } nodes.push(hit); }
  return P.composeRefSuffix(nodes);
}
interface PinRow { number: string; name: string; alt: string; type: string; style: string; alts: string[] }
interface SymPropsOpts { pinMapPage?: boolean }
/** The schematic's current design variant (the toolbar's; "" for the default). */
const currentVariantName = (): string => String((E as { currentVariant?: string }).currentVariant || "");
export function openSymbolProperties(ctx: Ctx, item: KItem, opts: SymPropsOpts = {}): void {
  const variant = currentVariantName(), vpath = variant ? sheetPathNow(ctx.doc).path : null;
  // TransferDataToWindow: the fields show GetFieldText( name, sheet, variant ), the attributes the variant's flags
  const doc = ctx.doc, ro = !!ctx.viewOnly, staged = L.clone(variant ? VM.symbolViewForVariant(item.node, variant, vpath, ctx.doc.version) : item.node), [ax, ay, rot] = L.atOf(staged), origin: [number, number] = [ax, ay];
  const libIdN = L.kid(staged, "lib_id"), libId = libIdN ? L.str(libIdN[1]) : "", libNameN = L.kid(staged, "lib_name"), libName = libNameN ? L.str(libNameN[1]) : libId;
  const lib = (KiCadCanvas.resolveLib(doc, libName) || KiCadCanvas.resolveLib(doc, libId)) as SNode | null;
  const ownLib = (doc.lib.get(libName) || doc.lib.get(libId) || null) as SNode | null;   // the (lib_symbols) entry itself (not merged with a parent)
  const unitN = L.kid(staged, "unit"), unit = unitN ? L.num(unitN[1], 1) : 1, bsN = L.kid(staged, "body_style") || L.kid(staged, "convert"), body = bsN ? L.num(bsN[1], 1) : 1;
  const nUnits = PH().libUnitCount(doc, staged), bodyNames = P.bodyStyleNames(lib), nBodies = bodyNames.length, mirror = PH().mirrorOf(staged) || "";
  const isPower = P.isPowerLib(lib), version = Number((doc as KDoc & { version?: number }).version) || 0;
  const pins = libPins(lib, unit, body);
  const alt0 = new Map<string, string>(); for (const p of L.kids(staged, "pin")) { const a = L.kid(p, "alternate"); if (a) alt0.set(L.str(p[1]), L.str(a[1])); }
  const pinRows: PinRow[] = pins.map((p) => ({ number: p.number, name: p.name, alt: alt0.get(p.number) || "", type: TYPE_NAMES[p.type] || p.type, style: STYLE_NAMES[p.style] || p.style, alts: p.alternates }));
  const els: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  let grid: { rows(): L.FieldRow[]; setRows(rows: L.FieldRow[]): void } | null = null;
  const angle = ((Math.round(rot) % 360) + 360) % 360;
  const refOf = (): string => { const r = L.kids(staged, "property").find((p) => L.fieldName(p) === "Reference"); return r ? L.fieldValue(r) : ""; };
  const suffix = pathRefSuffix();
  const pinMapOn = version >= P.PIN_MAP_VERSION;
  const pm = P.readPinMaps(ownLib), pm0 = JSON.stringify([pm.maps.map((m) => [m.name, Array.from(m.entries)]), Array.from(pm.footprints), pm.unmapped]);
  const embedded = lib ? L.kid(lib, "embedded_files") : null;
  let nb: { select(i: number): void } | null = null;
  const apply = (): boolean => { const a = document.querySelector(".kd-dialog .kd-foot .btn.primary") as HTMLButtonElement | null; if (!a) return false; a.click(); return !(KDialogs as KDialogsApi).isOpen || !(KDialogs as KDialogsApi).isOpen(); };
  KD().open({
    // "Remind user that they are editing the current variant."
    title: "Symbol Properties" + (variant ? ` - ${variant} Design Variant` : ""), width: 1000, readOnly: ro, cls: "kd-wide",
    build(b, api) {
      const tabs = [
        { label: "General", build(pg: HTMLElement) {
          const fh = h("div"); const fb = KD().staticBox(fh, "Fields"); pg.append(fh);
          grid = fieldsGrid(fb, L.fieldRows(staged, origin, MANDATORY_SYMBOL).sort((a, c) => { const i = MANDATORY_SYMBOL.indexOf(a.name), j = MANDATORY_SYMBOL.indexOf(c.name); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); }),
            { readOnly: ro, doc, newName: nextName, height: 200, shown: [0, 1, 2, 3, 4, 5, 6, 7], browse: { footprint: () => chooserFilters(lib), footprintReadOnly: isPower, files: () => [docFiles(doc), lib] } });
          const row = h("div", { style: "display:flex;gap:10px;margin-top:2px;align-items:stretch" });
          // General: Unit / Body style / Composed reference / Angle / Mirror, then Show pin numbers / Show pin names and Local power
          const gen = h("div", { style: "flex:7;min-width:0" }); const gb = KD().staticBox(gen, "General");
          const g = h("div", { class: "kd-fmt", style: "display:grid;grid-template-columns:max-content 1fr;gap:3px 8px;align-items:center" });
          const us: [string, string][] = []; for (let u = 1; u <= nUnits; u++) us.push([String(u), unitLetter(u)]);
          els.unit = select(us, String(unit), undefined, { id: "kd-sym-unit", disabled: ro || nUnits < 2 });
          els.body = select(bodyNames.map((n, i): [string, string] => [String(i + 1), n]), String(Math.min(body, nBodies)), undefined, { id: "kd-sym-body", disabled: ro || nBodies < 2 });
          els.angle = select([["0", "0"], ["90", "+90"], ["270", "-90"], ["180", "180"]], String(angle === 90 || angle === 180 || angle === 270 ? angle : 0), undefined, { id: "kd-sym-angle", disabled: ro });
          els.mirror = select([["", "Not mirrored"], ["x", "Around X axis"], ["y", "Around Y axis"]], mirror, undefined, { id: "kd-sym-mirror", disabled: ro });
          // OnUpdateUI: the composed reference follows the Reference cell
          const curRef = (): string => { const r = grid && grid.rows().find((x) => x.name === "Reference"); return r ? r.value : refOf(); };
          const compRef = h("span", { id: "kd-sym-ref" }, P.composedReference(curRef(), suffix));
          fh.addEventListener("input", () => { compRef.textContent = P.composedReference(curRef(), suffix); }); fh.addEventListener("change", () => { compRef.textContent = P.composedReference(curRef(), suffix); });
          g.append(h("label", { style: nUnits < 2 ? "opacity:.5" : "" }, "Unit:"), els.unit, h("label", { style: nBodies < 2 ? "opacity:.5" : "" }, "Body style:"), els.body);
          if (suffix) g.append(h("label", null, "Composed reference:"), compRef);
          g.append(h("label", null, "Angle:"), els.angle, h("label", null, "Mirror:"), els.mirror);
          gb.append(g);
          const cb = (k: string, label: string, on: boolean, o: { title?: string; disabled?: boolean } = {}) => { const c = checkbox(label, on, undefined, { id: "kd-sym-" + k, disabled: ro || o.disabled, title: o.title }); els[k] = c.querySelector("input") as HTMLInputElement; return c; };
          gb.append(h("div", { style: "display:flex;gap:15px;margin-top:13px" }, cb("pinnum", "Show pin numbers", !pinHidden(lib, "pin_numbers"), { title: "Show or hide pin numbers" }), cb("pinname", "Show pin names", !pinHidden(lib, "pin_names"), { title: "Show or hide pin names" })));
          gb.append(cb("localpower", "Local power", P.isLocalPower(lib), { title: "Local power symbols create labels that are limited to the sheet in which they are used", disabled: !isPower || version < P.LOCAL_POWER_VERSION }));
          // Attributes, in KiCad's order, with Passthrough: at the bottom
          const att = h("div", { style: "flex:6;min-width:0;display:flex;flex-direction:column" }); const ab = KD().staticBox(att, "Attributes"); ab.style.flex = "1";
          ab.append(cb("exsim", "Exclude from simulation", flag(staged, "exclude_from_sim", false)), h("div", { style: "height:10px" }),
            cb("exboard", "Exclude from board", !flag(staged, "on_board", true), { title: "This is useful for adding symbols that only get exported to the bill of materials but\nnot required to layout the board such as mechanical fasteners and enclosures" }),
            cb("dnp", "Do not populate", flag(staged, "dnp", false)),
            cb("exbom", "Exclude from bill of materials", !flag(staged, "in_bom", true), { title: "This is useful for adding symbols for board footprints such as fiducials\nand logos that you do not want to appear in the bill of materials export" }),
            cb("expos", "Exclude from position files", !flag(staged, "in_pos_files", true), { title: "This is useful for adding symbols that should not be included in the \nexported position files used for pick and place machines" }));
          els.passthrough = select(P.PASSTHROUGH_CHOICES, P.passthroughOf(staged), undefined, { id: "kd-sym-passthrough", disabled: ro, style: "flex:1" });
          ab.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" }, h("label", null, "Passthrough:"), els.passthrough));
          // the button column: Update Symbol from Library... / Change Symbol... / Edit Symbol... / Edit Library Symbol...
          const btns = h("div", { style: "flex:6;min-width:0;display:flex;flex-direction:column;gap:6px;padding-top:12px" });
          const button = (label: string, id: string, fn: (() => void) | null, why?: string) => { const x = h("button", { type: "button", class: "btn", id, disabled: ro || !fn, title: why }, label); if (fn) x.addEventListener("click", fn); btns.append(x); return x; };
          button("Update Symbol from Library...", "kd-sym-update", () => { (KDialogs as KDialogsApi).close(); openChangeSymbols("update"); });
          button("Change Symbol...", "kd-sym-change", () => { (KDialogs as KDialogsApi).close(); openChangeSymbols("change"); });
          // OnClearVariantSymbol (shown only for a variant that holds a symbol override): apply the dialog, then clearVariantSymbol
          if (variant && VM.symbolVariantOverride(item.node, variant, vpath)) button("Clear Variant Symbol", "kd-sym-clearvariant", () => {
            if (!apply()) return;
            const it = ctx.doc.items.get(item.id); if (!it) return;
            const node = VM.clearSymbolVariantOverride(it.node, variant, vpath, ctx.doc.version);
            if (JSON.stringify(node) !== JSON.stringify(it.node)) ctx.commit([KiCadCanvas.replaceChange(ctx.doc, { ...it, node, geom: [], bbox: null })], "Clear Variant Symbol");
          });
          const ed = editors();
          button("Edit Symbol...", "kd-sym-editsch", ed ? () => { if (apply()) ed.editSchematicSymbol(item.id); } : null, ed ? undefined : "The Symbol Editor runs in the desktop app");
          btns.append(h("div", { style: "height:14px" }));
          button("Edit Library Symbol...", "kd-sym-editlib", ed ? () => { if (apply()) ed.editLibrarySymbol(libId); } : null, ed ? undefined : "The Symbol Editor runs in the desktop app");
          row.append(gen, att, btns); pg.append(row);
        } },
        { label: "Pin Functions", build(pg: HTMLElement) {
          if (nBodies > 1) { pg.append(h("div", { style: "display:flex;align-items:center;justify-content:center;min-height:300px" }, h("i", { id: "kd-sym-nopinfn" }, P.NO_PIN_FUNCTIONS_WITH_MULTIPLE_BODY_STYLES))); return; }
          let sortKey = "number", asc = true;
          const cmp = (a: PinRow, c: PinRow): number => { const x = String((a as unknown as Record<string, unknown>)[sortKey] ?? ""), y = String((c as unknown as Record<string, unknown>)[sortKey] ?? ""); return (asc ? 1 : -1) * x.localeCompare(y, undefined, { numeric: true }); };
          const cols = [
            { key: "number", label: "Pin Number", type: "ro" as const, width: 90 }, { key: "name", label: "Base Pin Name", type: "ro" as const, width: 150 },
            { key: "alt", label: "Alternate Assignment", type: "choice" as const, width: 170, options: (r: PinRow) => [["", r.name], ...r.alts.map((a): [string, string] => [a, a])] as [string, string][], ro: (r: PinRow) => !r.alts.length },
            { key: "type", label: "Electrical Type", type: "ro" as const, width: 130 }, { key: "style", label: "Graphic Style", type: "ro" as const, width: 130 },
          ];
          const pg2 = KD().grid(pg, cols, pinRows, { readOnly: ro, height: 360, onHeader(c) { if (sortKey === c.key) asc = !asc; else { sortKey = c.key; asc = true; } pinRows.sort(cmp); pg2.refresh(); } });
          pinRows.sort(cmp); pg2.refresh();
        } },
      ];
      if (pinMapOn) tabs.push({ label: "Pin Map", build(pg: HTMLElement) { pinMapPanel(pg, pm, logicalPins(lib), ro); } });
      if (embedded) tabs.push({ label: "Embedded Files", build(pg: HTMLElement) {
        const rows = L.kids(embedded, "file").map((f) => { const n = L.str((L.kid(f, "name") || [])[1]); return { name: n, ref: "kicad-embed://" + n }; });
        KD().grid(pg, [{ key: "name", label: "File name", type: "ro", width: 260 }, { key: "ref", label: "Internal Reference", type: "ro", width: 360 }], rows, { readOnly: true, height: 300 });
      } });
      nb = KD().notebook(b, tabs);
      if (opts.pinMapPage && pinMapOn) nb.select(2);
      // the bottom bar: Library link: <read-only text>   Simulation Model...   (then Cancel / OK)
      const foot = api.foot, first = foot.firstChild;
      const link = h("input", { type: "text", id: "kd-sym-lib", value: libId, readonly: true, style: "width:220px;font-size:11px;background:var(--bench);border:1px solid var(--line)" });
      foot.insertBefore(h("label", { style: "font-size:11px;color:var(--ink-2);margin-right:4px" }, "Library link:"), first); foot.insertBefore(link, first);
      if (!isPower) { const sim = h("button", { type: "button", class: "btn", id: "kd-sym-sim", style: "margin-left:10px", disabled: ro }, "Simulation Model..."); sim.addEventListener("click", () => { const g = grid; if (!g) return; openSimModelFor(g, doc, staged, lib, nUnits, ro); }); foot.insertBefore(sim, first); }
    },
    ok() {
      if (ro || !grid) return;
      const rows = grid.rows(); const dup = L.duplicateFieldName(rows); if (dup) { void messageBox(dup); return false; }
      const bad = L.validateFieldRows("symbol", rows); if (bad) { void messageBox(bad.message, bad.title); return false; }
      const ref = rows.find((r) => r.name === "Reference");
      const n = L.clone(staged);
      const moved = rows.some((r) => L.rowMoved(r, origin));
      L.writeFields(n, rows, origin);
      // SetUserRef( currentSheet, base ) / SetUnitSelection( &GetCurrentSheet(), … ): only this sheet path's instance data
      const here = sheetPathNow(doc);
      if (ref) L.setInstanceData(n, here.path, here.project, { reference: ref.value });
      const nu = Number(els.unit.value); if (nu !== unit) { PH().setSymbolUnit(n, nu); L.setInstanceData(n, here.path, here.project, { unit: nu }); }
      const nbs = Number(els.body.value); if (nBodies > 1 && nbs !== body) { const k = L.kid(n, "body_style") ? "body_style" : L.kid(n, "convert") ? "convert" : "body_style"; L.put(n, k, [nbs], ["exclude_from_sim", "in_bom", "uuid", "property"]); }
      const na = Number(els.angle.value), nm = els.mirror.value;
      if (na !== angle || nm !== mirror) { PH().setSymbolRotation(n, na); PH().setSymbolMirror(n, nm); }
      setFlag(n, "exclude_from_sim", (els.exsim as HTMLInputElement).checked); setFlag(n, "in_bom", !(els.exbom as HTMLInputElement).checked);
      setFlag(n, "on_board", !(els.exboard as HTMLInputElement).checked);
      if (L.kid(n, "in_pos_files") || (els.expos as HTMLInputElement).checked) setFlag(n, "in_pos_files", !(els.expos as HTMLInputElement).checked);
      setFlag(n, "dnp", (els.dnp as HTMLInputElement).checked);
      P.setPassthrough(n, els.passthrough.value as P.Passthrough);
      if (nBodies < 2) for (const p of pinRows) if ((alt0.get(p.number) || "") !== p.alt) L.setPinAlternate(n, p.number, p.alt);
      let out = variant ? writeSymbolVariant(n, item.node, variant, here.path, doc.version) : n;
      if (moved) L.drop(out, "fields_autoplaced");
      else if (L.yes(out, "fields_autoplaced")) { const H = SH(); const a = H && H.autoplaceNode(doc, Object.assign({}, item, { node: out }) as KItem); if (a) out = a; }
      // the library copy: the pin maps go onto the shared entry (SyncLibSymbolPinMaps: every symbol using it); pin
      // text visibility and local power make this symbol's own copy when others share it (KiCad's lib_name variant)
      const libs: SNode[] = [];
      let base = ownLib;
      if (ownLib && pinMapOn && JSON.stringify([pm.maps.map((m) => [m.name, Array.from(m.entries)]), Array.from(pm.footprints), pm.unmapped]) !== pm0) { base = L.clone(ownLib); P.writePinMaps(base, pm); libs.push(base); }
      const showNum = (els.pinnum as HTMLInputElement).checked, showName = (els.pinname as HTMLInputElement).checked, local = (els.localpower as HTMLInputElement).checked;
      if (base && (showNum === pinHidden(lib, "pin_numbers") || showName === pinHidden(lib, "pin_names") || (isPower && local !== P.isLocalPower(lib)))) {
        const copy = L.clone(base); L.setPinVisibility(copy, "pin_numbers", showNum); L.setPinVisibility(copy, "pin_names", showName); if (isPower) P.setLocalPower(copy, local);
        const shared = Array.from(doc.items.values()).some((o) => o.id !== item.id && o.kind === "symbol" && L.str(((L.kid(o.node, "lib_name") || L.kid(o.node, "lib_id")) || [])[1]) === libName);
        if (shared) {
          // SCH_SCREEN::Append: an existing variant equal to the edited copy is reused, else a new "<name>_<n>"
          const v = L.libVariantName(doc.lib, libId, copy);
          copy[1] = v.name as unknown as SNode; L.drop(out, "lib_name");
          if (v.name !== libId) { const at = out.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "lib_id"); out.splice(at > 0 ? at : 1, 0, L.qnode("lib_name", v.name)); }
          libs.push(copy);
        } else { if (libs.length) libs.pop(); libs.push(copy); }
      }
      const sexpr = libs.length ? "(lib_symbols " + libs.map((x) => KiCadCanvas.serialize(x)).join(" ") + ") " + KiCadCanvas.serialize(out) : null;
      if (!sexpr && JSON.stringify(out) === JSON.stringify(item.node)) return undefined;
      const ch = KiCadCanvas.replaceChange(doc, Object.assign({}, item, { node: out, geom: [], bbox: null }) as KItem);
      if (sexpr) (ch as KChange & { sexpr: string }).sexpr = sexpr;
      commitWithOtherUnits(ctx, item, out, [ch], "Edit Symbol Properties");
      return undefined;
    },
  });
}
const unitLetter = (u: number): string => { let s = ""; let n = u; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
/** The symbol editor, when this build has one (SYMBOL_PROPS_EDIT_SCHEMATIC_SYMBOL / _LIBRARY_SYMBOL). */
function editors(): { editSchematicSymbol(id: string): void; editLibrarySymbol(libId: string): void } | null {
  const w = window as unknown as { KiCadSymbolEditor?: { editSchematicSymbol(id: string): void; editLibrarySymbol(libId: string): void } };
  return w.KiCadSymbolEditor || null;
}

// ---------------------------------------------------------------- PANEL_SYMBOL_PIN_MAP
function pinMapPanel(host: HTMLElement, st: P.PinMapState, pins: { number: string; name: string; unit: number }[], ro: boolean): void {
  const wrap = h("div", { class: "kd-grid-wrap", style: "height:330px" }); const table = h("table", { class: "kd-grid", id: "kd-pinmap" }); wrap.append(table); host.append(wrap);
  let curCol = -1;
  const render = (): void => {
    table.innerHTML = "";
    const hr = h("tr", null, h("th", { style: "width:46px" }, "Unit"), h("th", { style: "width:90px" }, "Symbol Pin"), h("th", { style: "width:120px" }, "Name"));
    st.maps.forEach((m, i) => { const th = h("th", { "data-map": i, style: "min-width:84px;text-align:center" + (i === curCol ? ";background:color-mix(in srgb, var(--blue) 18%, var(--bench))" : "") }, m.name);
      th.addEventListener("click", () => { curCol = i; render(); }); th.addEventListener("dblclick", () => { if (!ro) void rename(i); });
      th.addEventListener("contextmenu", (ev) => { ev.preventDefault(); curCol = i; render(); menu(ev as MouseEvent, i); }); hr.append(th); });
    table.append(h("thead", null, hr));
    const tb = h("tbody");
    const fr = h("tr", null, h("td", { colspan: 3, class: "ro" }, "Footprint"));
    st.maps.forEach((m, i) => { const inp = h("input", { type: "text", value: st.footprints.get(m.name) || "", disabled: ro, "data-fp": i }) as HTMLInputElement;
      inp.addEventListener("focus", () => { curCol = i; markCol(); });
      inp.addEventListener("change", () => { void applyFootprint(i, inp); }); fr.append(h("td", null, inp)); });
    tb.append(fr);
    for (const p of pins) {
      const tr = h("tr", null, h("td", { class: "ro" }, p.unit > 0 ? String(p.unit) : "-"), h("td", { class: "ro" }, p.number), h("td", { class: "ro" }, p.name));
      st.maps.forEach((m, i) => { const inp = h("input", { type: "text", value: P.pinMapCell(m, p.number), disabled: ro, "data-col": i, "data-pin": p.number }) as HTMLInputElement;
        inp.addEventListener("focus", () => { curCol = i; markCol(); });
        inp.addEventListener("change", () => { P.setPinMapCell(m, p.number, inp.value); if (!inp.value.trim()) inp.value = p.number; });
        const td = h("td", null, inp); td.addEventListener("contextmenu", (ev) => { ev.preventDefault(); curCol = i; markCol(); menu(ev as MouseEvent, i); }); tr.append(td); });
      tb.append(tr);
    }
    table.append(tb);
    rm.disabled = ro || !st.maps.length;
  };
  const markCol = (): void => { for (const th of Array.from(table.querySelectorAll<HTMLElement>("th[data-map]"))) th.style.background = Number(th.dataset.map) === curCol ? "color-mix(in srgb, var(--blue) 18%, var(--bench))" : ""; };
  const rename = async (i: number): Promise<void> => {
    const old = st.maps[i].name; const v = await promptText("Rename Map", "Map name:", old); if (v === null) return;
    const nn = v.trim(); if (!nn || nn === old) return;
    if (st.maps.some((m) => m.name === nn)) { await messageBox(P.PIN_MAP_MSG.exists(nn), "Rename Map"); return; }
    st.maps[i].name = nn; const fp = st.footprints.get(old); if (fp !== undefined) { st.footprints.delete(old); st.footprints.set(nn, fp); }
    render();
  };
  const menu = (ev: MouseEvent, i: number): void => {
    const others = st.maps.map((m, j) => ({ m, j })).filter((x) => x.j !== i);
    const items: PopItem[] = [{ label: "Rename Map...", disabled: ro, run: () => { void rename(i); } }, { label: P.PIN_MAP_MSG.reset(st.maps[i].name), disabled: ro, run: () => { st.maps[i].entries.clear(); render(); } }];
    if (others.length) items.push({ label: "Copy From...", disabled: ro, sub: others.map((o) => ({ label: o.m.name, run: () => { st.maps[i].entries = new Map(o.m.entries); render(); } })) });
    items.push({ sep: true }, { label: "Copy", run: () => { const sel = document.activeElement as HTMLInputElement | null; if (sel && sel.value !== undefined) void navigator.clipboard?.writeText(sel.value).catch(() => undefined); } });
    popupMenu(ev.clientX, ev.clientY, items);
  };
  const applyFootprint = async (i: number, inp: HTMLInputElement): Promise<void> => {
    const name = st.maps[i].name, fpid = inp.value.trim(), cur = st.footprints.get(name) || "";
    if (fpid && !P.validFootprintId(fpid)) { await messageBox(P.PIN_MAP_MSG.badFootprint, "Assign Footprint"); inp.value = cur; return; }
    for (const [mn, fp] of st.footprints) if (mn !== name && fpid && fp === fpid) { await messageBox(P.PIN_MAP_MSG.fpTaken, "Assign Footprint"); inp.value = cur; return; }
    if (fpid) st.footprints.set(name, fpid); else st.footprints.delete(name);
    inp.value = fpid;
  };
  const bar = h("div", { class: "kd-grid-btns" });
  const add = h("button", { type: "button", class: "btn", title: "Add pin map", id: "kd-pinmap-add", disabled: ro }, "+");
  const rm = h("button", { type: "button", class: "btn", title: "Remove pin map", id: "kd-pinmap-remove", disabled: ro }, "🗑");
  add.addEventListener("click", () => { st.maps.push({ name: P.newMapName(st.maps), entries: new Map() }); curCol = st.maps.length - 1; render(); });
  rm.addEventListener("click", () => { void (async () => {
    if (!st.maps.length) return;
    let col = curCol;
    if (col < 0 || col >= st.maps.length) { if (st.maps.length > 1) { await messageBox(P.PIN_MAP_MSG.pickColumn, "Remove Pin Map"); return; } col = 0; }
    const name = st.maps[col].name;
    if (st.footprints.has(name) && !(await confirmBox("Confirmation", P.PIN_MAP_MSG.removeAsk(name)))) return;
    st.maps.splice(col, 1); st.footprints.delete(name); curCol = -1; render();
  })(); });
  bar.append(add, rm); host.append(bar);
  render();
}

// ---------------------------------------------------------------- Simulation Model... (DIALOG_SYMBOL_PROPERTIES::OnEditSpiceModel)
function openSimModelFor(grid: { rows(): L.FieldRow[]; setRows?(rows: L.FieldRow[]): void }, doc: KDoc, staged: SNode, lib: SNode | null, nUnits: number, ro: boolean): void {
  const S = (window as unknown as { KiCadSimModel?: { open: typeof openSimModel } }).KiCadSimModel || { open: openSimModel };
  const refN = L.kids(staged, "property").find((p) => L.fieldName(p) === "Reference");
  const owner = (d: KDoc): SNode | null => { const ef = (d as KDoc & { embeddedFiles?: SNode | null }).embeddedFiles; return ef ? (["kicad_sch", ef] as unknown as SNode) : null; };
  const open = (schOwner: SNode | null): void => {
    const files = [...projectModelFiles((appState.project && appState.project.docs) || []), ...embeddedModelFiles([schOwner, lib])];
    S.open(grid.rows(), {
      prefix: refPrefix(refN ? L.fieldValue(refN) : ""), pins: simPinsOfLib(lib), unitCount: nUnits, files, readOnly: ro,
      newRow: (name, value, visible) => { const r = L.newRow(name, [0, 0]); r.value = value; r.show = visible; return r; },
      clone: (r) => ({ ...r }),
    }, (next) => { if (grid.setRows) grid.setRows(next); });
  };
  // SIM_LIB_MGR's embedded files are the schematic's (the root sheet's, whichever sheet the symbol is on) and the symbol's
  const root = appState.project ? rootSchematic() : undefined;
  if (root && appState.docId && root.docId !== appState.docId) void readDoc(root.docId).then(owner, () => null).then(open);
  else open(owner(doc));
}

// ---------------------------------------------------------------- DIALOG_SHEET_PROPERTIES
const instPage = (n: SNode): SNode | null => { for (const inst of L.kids(n, "instances")) for (const pr of L.kids(inst, "project")) for (const pa of L.kids(pr, "path")) { const pg = L.kid(pa, "page"); if (pg) return pg; } return null; };
const normFile = (f: string): string => { f = f.trim().replace(/\\/g, "/").replace(/^\/+/, ""); if (f && !/\.kicad_sch$/i.test(f)) f += ".kicad_sch"; return f; };
interface SheetOpts { onCreate?(node: SNode): boolean | void; isNew?: boolean; cancel?(): void }
export function openSheetProperties(ctx: Ctx, item: KItem, opts: SheetOpts = {}): void {
  const doc = ctx.doc, ro = !!ctx.viewOnly, staged = L.clone(item.node), [ax, ay] = L.atOf(staged), origin: [number, number] = [ax, ay];
  const st = L.readStroke(staged), fillN = L.kid(staged, "fill"), bg = fillN ? L.colorOf(L.kid(fillN, "color")) : null, pg = instPage(staged);
  const fileOf = (n: SNode): string => { const p = L.kids(n, "property").find((q) => /^Sheet ?file$/i.test(L.fieldName(q))); return p ? L.fieldValue(p) : ""; };
  const nameOf = (rows: L.FieldRow[]): string => { const r = rows.find((x) => /^Sheet ?name$/i.test(x.name)); return r ? r.value : ""; };
  const oldFile = fileOf(staged);
  const c = netMap(), here = currentInstance(c);
  const els: Record<string, HTMLInputElement> = {}; let grid: { rows(): L.FieldRow[] } | null = null, bc: Swatch | null = null, fc: Swatch | null = null;
  const pathEl = h("span", { id: "kd-sh-path", class: "kd-note" });
  const showPath = (name: string) => { pathEl.textContent = (here ? here.human : "/") + name + "/"; };
  KD().open({
    title: "Sheet Properties", width: 900, readOnly: ro, cls: "kd-wide", cancel: opts.cancel,
    build(b) {
      const fh = h("div"); b.append(fh);
      // the Sheetfile cell's GRID_CELL_PATH_EDITOR: the project's other schematic files, relative to this sheet's folder
      const sheetFiles = (): { path: string; here: string }[] => {
        const here = projectDocs().find((d) => d.docId === appState.docId), dir = here && here.path.includes("/") ? here.path.slice(0, here.path.lastIndexOf("/")) : "";
        return projectDocs().filter((d) => d.docType === "kicad_sch" && (!here || d.docId !== here.docId)).map((d) => ({ path: relativePath(dir, d.path), here: dir })).sort((a, b) => a.path.localeCompare(b.path));
      };
      grid = fieldsGrid(fh, L.fieldRows(staged, origin, ["Sheetname", "Sheetfile", "Sheet name", "Sheet file"]), { readOnly: ro, doc, newName: nextName, height: 150, shown: [0, 1, 2, 3, 4, 5, 6, 7], browse: { sheetFiles } });
      // bSizer5: Attributes (Page number, Full reference suffix, the flags) beside Style (Border width / color | Fill color)
      const row = h("div", { style: "display:flex;gap:10px;margin-top:6px;align-items:stretch" });
      const att = h("div", { style: "flex:0 0 auto;display:flex;flex-direction:column" }); const ab = KD().staticBox(att, "Attributes"); ab.style.flex = "1";
      els.page = textInput(pg ? L.str(pg[1]) : "", undefined, { id: "kd-sh-page", style: "width:90px", disabled: ro || (!pg && !opts.onCreate) });
      // OnUpdateUI: the current path's suffix and this sheet's own, "None" when both are empty (read-only)
      const sufEl = h("input", { id: "kd-sh-fullsuffix", readOnly: true, tabIndex: -1, style: "width:110px" }) as HTMLInputElement;
      const suffixOf = (rows: L.FieldRow[]): string => { const r = rows.find((x) => x.name === P.REF_SUFFIX_FIELD); return r ? r.value : ""; };
      const showSuffix = (rows: L.FieldRow[]): void => { const f = pathRefSuffix() + suffixOf(rows); sufEl.value = f || "None"; };
      const cb = (k: string, label: string, on: boolean, tip?: string) => { const x = checkbox(label, on, undefined, { id: "kd-sh-" + k, disabled: ro, title: tip }); els[k] = x.querySelector("input") as HTMLInputElement; return x; };
      ab.append(
        h("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:8px" }, h("label", null, "Page number:"), els.page),
        h("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:8px" }, h("label", null, "Full reference suffix:"), sufEl),
        cb("exsim", "Exclude from simulation", flag(staged, "exclude_from_sim", false)), h("div", { style: "height:10px" }),
        cb("exboard", "Exclude from board", !flag(staged, "on_board", true), "This is useful for adding symbols that only get exported to the bill of materials but\nnot required to layout the board such as mechanical fasteners and enclosures"),
        cb("dnp", "Do not populate", flag(staged, "dnp", false)),
        cb("exbom", "Exclude from bill of materials", !flag(staged, "in_bom", true), "This is useful for adding symbols for board footprints such as fiducials\nand logos that you do not want to appear in the bill of materials export"));
      const sty = h("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column" }); const sb = KD().staticBox(sty, "Style"); sb.style.flex = "1";
      els.bwidth = lenBox(st.width, "kd-sh-bwidth"); bc = swatch(st.color, "kd-sh-bcolor", undefined, ro); fc = swatch(bg, "kd-sh-bg", undefined, ro);
      sb.append(h("div", { style: "display:flex;gap:10px" },
        h("div", { style: "flex:2;min-width:0" }, h("div", { style: "margin-bottom:5px" }, "Border"),
          h("div", { style: "display:flex;gap:6px;align-items:center" }, h("label", null, "Width:"), els.bwidth, units(), h("span", { style: "width:20px" }), h("label", null, "Color:"), bc.el)),
        h("div", { style: "flex:1;min-width:0" }, h("div", { style: "margin-bottom:5px" }, "Fill"),
          h("div", { style: "display:flex;gap:6px;align-items:center" }, h("label", null, "Color:"), fc.el))));
      row.append(att, sty); b.append(row);
      // m_sizerBottom: Hierarchical path: beside the buttons
      b.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" }, h("label", null, "Hierarchical path:"), pathEl));
      showSuffix(L.fieldRows(staged, origin));
      fh.addEventListener("input", () => { if (grid) showSuffix(grid.rows()); }); fh.addEventListener("change", () => { if (grid) showSuffix(grid.rows()); });
      showPath(nameOf(L.fieldRows(staged, origin)));
      fh.addEventListener("change", () => { if (grid) showPath(nameOf(grid.rows())); });
    },
    ok() {
      if (ro || !grid) return;
      const rows = grid.rows(); const dup = L.duplicateFieldName(rows); if (dup) { void messageBox(dup); return false; }
      // the grid's FIELD_VALIDATORs (an emptied Sheetname cell is vetoed: "A sheet must have a name.") and Validate()
      const bad = L.validateFieldRows("sheet", rows); if (bad) { void messageBox(bad.message, bad.title); return false; }
      const nr = rows.find((x) => /^Sheet ?name$/i.test(x.name));
      if (nr && !nr.value) nr.value = "Untitled Sheet";   // unedited data from a file can still be empty
      const fr = rows.find((x) => /^Sheet ?file$/i.test(x.name));
      let file = fr ? normFile(fr.value) : "";
      if (!file) { void messageBox("A sheet must have a valid file name."); return false; }
      if (fr) fr.value = file;
      const n = L.clone(staged);
      L.writeFields(n, rows, origin);
      L.writeStroke(n, { width: lenOf(els.bwidth, st.width), color: bc ? bc.get() : st.color });
      L.put(n, "fill", [["color", ...L.colorVals((fc ? fc.get() : bg) || [0, 0, 0, 0])]], ["uuid"]);
      setFlag(n, "exclude_from_sim", els.exsim.checked); setFlag(n, "in_bom", !els.exbom.checked); setFlag(n, "on_board", !els.exboard.checked); setFlag(n, "dnp", els.dnp.checked);
      const npg = instPage(n); if (npg && els.page.value.trim()) npg[1] = els.page.value.trim() as unknown as SNode;
      if (rows.some((r) => L.rowMoved(r, origin))) L.drop(n, "fields_autoplaced");
      if (opts.onCreate) return opts.onCreate(n) as boolean | undefined;
      if (file === oldFile) { commit(n); return undefined; }
      void changeSheetFile(ctx, item, n, oldFile, file).then((linked) => {
        if (!linked) return;
        commit(n);
        // a file already in the project now loads under this sheet: its symbols are new on these sheet paths
        if (linked !== true) void annotateNewSheetPaths(ctx, n, linked);
      });
      return undefined;
    },
  });
  function commit(n: SNode): void {
    if (JSON.stringify(n) === JSON.stringify(item.node)) return;
    ctx.commit([KiCadCanvas.replaceChange(doc, Object.assign({}, item, { node: n, geom: [], bbox: null }) as KItem)], "Edit Sheet Properties");
  }
}
/** The hierarchy's sheet paths as file names from the root down (SCH_SHEET_LIST of the schematic). */
async function hierarchyPaths(): Promise<string[][]> {
  try { await loadSheets(true); } catch (e) { /* the sheets as last read */ }
  const c = netMap(); if (!c) return [];
  const byPath = new Map<string, string>(); for (const i of c.instances) byPath.set(i.uuidPath.join("/"), i.file);
  return c.instances.map((i) => i.uuidPath.map((_, k) => byPath.get(i.uuidPath.slice(0, k + 1).join("/")) || ""));
}
/** A sheet file and every file under it (SCH_SHEET_LIST( aSheet ) of the loaded file), read from the project. */
async function subFiles(file: string): Promise<string[]> {
  const c = netMap(), docs = projectDocs().filter((d) => d.docType === "kicad_sch");
  const out: string[] = [], seen = new Set<string>(), todo = [file];
  while (todo.length && out.length < 500) {
    const f = todo.shift() as string; if (seen.has(f)) continue; seen.add(f); out.push(f);
    let d: KDoc | null = c ? c.docs.get(f) || null : null;
    const entry = docs.find((x) => x.path === f);
    if (!d && entry) { try { d = await readDoc(entry.docId, "kicad_sch"); } catch (e) { d = null; } }
    if (!d) continue;
    const dir = f.split("/").slice(0, -1);
    for (const it of d.items.values()) {
      if (it.kind !== "sheet") continue;
      const p = L.kids(it.node, "property").find((q) => /^Sheet ?file$/i.test(L.fieldName(q))); if (!p) continue;
      const parts: string[] = []; for (const s of [...dir, ...normFile(L.fieldValue(p)).split("/")]) { if (!s || s === ".") continue; if (s === "..") parts.pop(); else parts.push(s); }
      todo.push(parts.join("/"));
    }
  }
  return out;
}
/** SCH_EDIT_FRAME::ChangeSheetFile for an existing sheet: link an existing file, or copy this sheet's contents to a new one. */
async function changeSheetFile(ctx: Ctx, item: KItem, node: SNode, oldFile: string, newFile: string): Promise<boolean | string> {
  const cur = (ctx.docs as { docId: string; path: string; docType: string }[] || []).find((d) => d.docId === ctx.docId) || null;
  const dir = cur ? cur.path.split("/").slice(0, -1).join("/") : "";
  const abs = (f: string): string => { const out: string[] = []; for (const p of [...(dir ? dir.split("/") : []), ...f.split("/")]) { if (!p || p === ".") continue; if (p === "..") out.pop(); else out.push(p); } return out.join("/"); };
  const docs = projectDocs().filter((d) => d.docType === "kicad_sch");
  const target = docs.find((d) => d.path === abs(newFile)), source = docs.find((d) => d.path === abs(oldFile));
  if (target) {
    if (!(await confirmBox("Confirmation", `Change '${abs(newFile)}' link from '${oldFile}' to '${newFile}'?\n\nThis action cannot be undone.`))) return false;
    // CheckSheetForRecursion with a temporary sheet on the linked screen
    const dest = cur ? cur.path : "";
    if (dest && L.sheetRecursion(await hierarchyPaths(), await subFiles(target.path), dest)) { await messageBox(L.RECURSION_MSG(dest)); return false; }
    return target.path;                                  // clearAnnotation: the linked file's contents are new here
  }
  // the sheet's contents are saved under the new name (a sheet used more than once asks first)
  const uses = Array.from(ctx.doc.items.values()).filter((o) => o.kind === "sheet" && o.id !== item.id && L.kids(o.node, "property").some((p) => /^Sheet ?file$/i.test(L.fieldName(p)) && normFile(L.fieldValue(p)) === normFile(oldFile))).length;
  if (uses && !(await confirmBox("Confirmation", `Create new file '${newFile}' with contents of '${oldFile}'?\n\nThis action cannot be undone.`))) return false;
  const project = ctx.project as { projectId?: string } | null;
  if (!project || !project.projectId) { void messageBox(`Failed to save schematic '${abs(newFile)}'`); return false; }
  try {
    const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: abs(newFile), docType: "kicad_sch" }) }) as { docId?: string; existing?: boolean; path?: string };
    if (!res || !res.docId) throw new Error("no document id");
    if (source) {
      const base = await docBase(source.docId);
      if (!res.existing && base.file !== null) await api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" }, body: base.file });
      const changes = base.ops.flatMap((o) => (Array.isArray(o.changes) ? o.changes : []));
      if (changes.length) await submitDocOp(res.docId, changes);
    }
    const entry = { docId: res.docId, path: res.path || abs(newFile), docType: "kicad_sch" };
    if (Array.isArray(ctx.docs) && !(ctx.docs as { docId: string }[]).some((d) => d.docId === entry.docId)) (ctx.docs as unknown[]).push(entry);
    return true;
  } catch (e) {
    void messageBox(`Error occurred saving schematic file '${abs(newFile)}'.`); return false;
  }
}
/**
 * SCH_EDIT_TOOL's doClearAnnotation after ChangeSheetFile linked `file`: AddNewSymbolInstances / AddNewSheetInstances
 * for every new sheet path under the sheet (one per instance of the sheet's parent, and down through the linked
 * file's own sub-sheets), then ClearAnnotationOfNewSheetPaths — the symbols there read 'R?' on those paths.  The file
 * change cannot be undone in KiCad either (ClearUndoRedoList), so the other files' edits carry no undo step.
 */
async function annotateNewSheetPaths(ctx: Ctx, sheetNode: SNode, file: string): Promise<void> {
  const uuid = L.str((L.kid(sheetNode, "uuid") || [])[1]); if (!uuid || E.viewOnly) return;
  const c = netMap(), here = currentInstance(c);
  const cur = ((ctx.docs as { docId: string; path: string }[] | undefined) || []).find((d) => d.docId === ctx.docId);
  const parents = c && cur ? c.instances.filter((i) => i.file === cur.path).map((i) => "/" + i.uuidPath.join("/")) : [];
  if (!parents.length && here) parents.push("/" + here.uuidPath.join("/"));
  if (!parents.length) return;
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : "";
  let page = c ? c.instances.length : 1;                // SCH_SHEET_LIST::GetLastVirtualPageNumber
  const docs = projectDocs().filter((d) => d.docType === "kicad_sch"), loaded = new Map<string, { docId: string; doc: KDoc; before: Map<string, KItem>; touched: Set<string> }>();
  const todo = parents.map((p) => ({ file, path: `${p}/${uuid}` })), failed: string[] = [];
  for (let guard = 0; todo.length && guard < 256; guard++) {
    const t = todo.shift()!;
    const de = docs.find((d) => d.path === t.file); if (!de) continue;
    let e = loaded.get(t.file);
    if (!e) { try { const d = await readDoc(de.docId, "kicad_sch"); e = { docId: de.docId, doc: d, before: new Map(d.items), touched: new Set() }; loaded.set(t.file, e); } catch { failed.push(t.file); continue; } }
    const r = L.newSheetPathNodes(e.doc, t.path, project, () => ++page);
    for (const [id, n] of r.nodes) { const it = e.doc.items.get(id); if (it) { e.doc.items.set(id, Object.assign({}, it, { node: n })); e.touched.add(id); } }
    const dir = t.file.split("/").slice(0, -1);
    for (const s of r.subs) { const parts = dir.slice(); for (const x of normFile(s.file).split("/")) { if (!x || x === ".") continue; if (x === "..") parts.pop(); else parts.push(x); } todo.push({ file: parts.join("/"), path: s.path }); }
  }
  for (const [f, e] of loaded) {
    const ch: KChange[] = [];
    for (const id of e.touched) { const was = e.before.get(id), now = e.doc.items.get(id); if (was && now) { e.doc.items.set(id, was); ch.push(KiCadCanvas.replaceChange(e.doc, Object.assign({}, was, { node: now.node, geom: [], bbox: null }) as KItem)); } }
    if (!ch.length) continue;
    try { await submitDocOp(e.docId, ch); } catch { failed.push(f); }
  }
  if (failed.length) void messageBox(`Could not update ${failed.map((f) => `'${f}'`).join(", ")}.`);
}
void E; void toast;
