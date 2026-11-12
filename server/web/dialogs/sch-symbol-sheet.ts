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
import { E, api, toast } from "./editor";
import { KD, checkbox, confirmBox, h, select, textInput } from "./dom";
import * as L from "./sch-items-logic";
import { fieldsGrid, messageBox, swatch, type Swatch } from "./sch-items";
import { openChangeSymbols } from "./change-symbols";
import { docBase, projectDocs, readDoc, submitDocOp } from "./project";
import { currentInstance, loadSheets, netMap } from "../editor/schnets";
import { fmtLen, parseLen, unitName } from "../editor/pcbdialogs/ui";

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
export function openSymbolProperties(ctx: Ctx, item: KItem): void {
  const doc = ctx.doc, ro = !!ctx.viewOnly, staged = L.clone(item.node), [ax, ay, rot] = L.atOf(staged), origin: [number, number] = [ax, ay];
  const libIdN = L.kid(staged, "lib_id"), libId = libIdN ? L.str(libIdN[1]) : "", libNameN = L.kid(staged, "lib_name"), libName = libNameN ? L.str(libNameN[1]) : libId;
  const lib = (KiCadCanvas.resolveLib(doc, libName) || KiCadCanvas.resolveLib(doc, libId)) as SNode | null;
  const unitN = L.kid(staged, "unit"), unit = unitN ? L.num(unitN[1], 1) : 1, bsN = L.kid(staged, "body_style") || L.kid(staged, "convert"), body = bsN ? L.num(bsN[1], 1) : 1;
  const nUnits = PH().libUnitCount(doc, staged), nBodies = bodyStyles(lib), mirror = PH().mirrorOf(staged) || "";
  const pins = libPins(lib, unit, body);
  const alt0 = new Map<string, string>(); for (const p of L.kids(staged, "pin")) { const a = L.kid(p, "alternate"); if (a) alt0.set(L.str(p[1]), L.str(a[1])); }
  const pinRows = pins.map((p) => ({ number: p.number, name: p.name, alt: alt0.get(p.number) || "", type: TYPE_NAMES[p.type] || p.type, style: STYLE_NAMES[p.style] || p.style, alts: p.alternates }));
  const els: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  let grid: { rows(): L.FieldRow[] } | null = null;
  const angle = ((Math.round(rot) % 360) + 360) % 360;
  const refOf = (): string => { const r = L.kids(staged, "property").find((p) => L.fieldName(p) === "Reference"); return r ? L.fieldValue(r) : ""; };
  const unitName = (u: number): string => (u <= 26 ? String.fromCharCode(64 + u) : String(u));
  KD().open({
    title: "Symbol Properties", width: 980, readOnly: ro, cls: "kd-wide",
    extra: ro ? [] : [
      { label: "Update Symbol from Library...", fn: () => { (KDialogs as KDialogsApi).close(); openChangeSymbols("update"); } },
      { label: "Change Symbol...", fn: () => { (KDialogs as KDialogsApi).close(); openChangeSymbols("change"); } },
    ],
    build(b) {
      KD().notebook(b, [
        { label: "General", build(pg) {
          const fh = h("div"); pg.append(fh);
          grid = fieldsGrid(fh, L.fieldRows(staged, origin, MANDATORY_SYMBOL).sort((a, c) => { const i = MANDATORY_SYMBOL.indexOf(a.name), j = MANDATORY_SYMBOL.indexOf(c.name); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); }),
            { readOnly: ro, doc, newName: nextName, height: 200 });
          const row = h("div", { style: "display:flex;gap:12px;margin-top:6px;align-items:flex-start" });
          const gen = h("div", { style: "flex:1" }); const gb = KD().staticBox(gen, "General");
          const g = h("div", { class: "kd-fmt" });
          const us: [string, string][] = []; for (let u = 1; u <= nUnits; u++) us.push([String(u), unitName(u)]);
          els.unit = select(us, String(unit), undefined, { id: "kd-sym-unit", disabled: ro || nUnits < 2 });
          const bs: [string, string][] = [["1", "Standard"]]; if (nBodies > 1) bs.push(["2", "Alternate"]); for (let i = 3; i <= nBodies; i++) bs.push([String(i), "Body style " + i]);
          els.body = select(bs, String(body), undefined, { id: "kd-sym-body", disabled: ro || nBodies < 2 });
          els.angle = select([["0", "0"], ["90", "+90"], ["270", "-90"], ["180", "180"]], String(angle === 90 || angle === 180 || angle === 270 ? angle : 0), undefined, { id: "kd-sym-angle", disabled: ro });
          els.mirror = select([["", "Not mirrored"], ["x", "Around X axis"], ["y", "Around Y axis"]], mirror, undefined, { id: "kd-sym-mirror", disabled: ro });
          g.append(h("label", null, "Unit:"), els.unit, h("span"), h("label", null, "Body style:"), els.body, h("span"), h("label", null, "Angle:"), els.angle, h("span"), h("label", null, "Mirror:"), els.mirror, h("span"));
          g.append(h("label", null, "Library link:"), h("span", { id: "kd-sym-lib", class: "kd-note" }, libId), h("span"));
          g.append(h("label", null, "Composed reference:"), h("span", { id: "kd-sym-ref", class: "kd-note" }, refOf() + (nUnits > 1 ? unitName(unit) : "")), h("span"));
          gb.append(g);
          const att = h("div"); const ab = KD().staticBox(att, "Attributes");
          const cb = (k: string, label: string, on: boolean) => { const c = checkbox(label, on, undefined, { id: "kd-sym-" + k, disabled: ro }); els[k] = c.querySelector("input") as HTMLInputElement; return c; };
          ab.append(cb("exsim", "Exclude from simulation", flag(staged, "exclude_from_sim", false)), cb("exbom", "Exclude from bill of materials", !flag(staged, "in_bom", true)),
            cb("exboard", "Exclude from board", !flag(staged, "on_board", true)), cb("expos", "Exclude from position files", !flag(staged, "in_pos_files", true)), cb("dnp", "Do not populate", flag(staged, "dnp", false)));
          const pv = h("div"); const pb = KD().staticBox(pv, "Pin Text Options");
          pb.append(cb("pinnum", "Show pin numbers", !pinHidden(lib, "pin_numbers")), cb("pinname", "Show pin names", !pinHidden(lib, "pin_names")));
          row.append(gen, att, pv); pg.append(row);
        } },
        { label: "Pin Functions", build(pg) {
          if (!pinRows.length) { pg.append(h("p", { class: "kd-note" }, "This symbol has no pins.")); return; }
          KD().grid(pg, [
            { key: "number", label: "Number", type: "ro", width: 80 }, { key: "name", label: "Base Name", type: "ro", width: 140 },
            { key: "alt", label: "Alternate Assignment", type: "choice", width: 160, options: (r: typeof pinRows[number]) => [["", r.name], ...r.alts.map((a): [string, string] => [a, a])], ro: (r: typeof pinRows[number]) => !r.alts.length },
            { key: "type", label: "Electrical Type", type: "ro", width: 120 }, { key: "style", label: "Graphic Style", type: "ro", width: 120 },
          ], pinRows, { readOnly: ro, height: 360 });
        } },
      ]);
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
      const nb = Number(els.body.value); if (nb !== body) { const k = L.kid(n, "body_style") ? "body_style" : L.kid(n, "convert") ? "convert" : "body_style"; L.put(n, k, [nb], ["exclude_from_sim", "in_bom", "uuid", "property"]); }
      const na = Number(els.angle.value), nm = els.mirror.value;
      if (na !== angle || nm !== mirror) { PH().setSymbolRotation(n, na); PH().setSymbolMirror(n, nm); }
      setFlag(n, "exclude_from_sim", (els.exsim as HTMLInputElement).checked); setFlag(n, "in_bom", !(els.exbom as HTMLInputElement).checked);
      setFlag(n, "on_board", !(els.exboard as HTMLInputElement).checked);
      if (L.kid(n, "in_pos_files") || (els.expos as HTMLInputElement).checked) setFlag(n, "in_pos_files", !(els.expos as HTMLInputElement).checked);
      setFlag(n, "dnp", (els.dnp as HTMLInputElement).checked);
      for (const p of pinRows) if ((alt0.get(p.number) || "") !== p.alt) L.setPinAlternate(n, p.number, p.alt);
      let out = n;
      if (moved) L.drop(out, "fields_autoplaced");
      else if (L.yes(out, "fields_autoplaced")) { const H = SH(); const a = H && H.autoplaceNode(doc, Object.assign({}, item, { node: out }) as KItem); if (a) out = a; }
      // pin text visibility lives on the library copy (a symbol sharing it with others gets its own, as KiCad's lib_name)
      const showNum = (els.pinnum as HTMLInputElement).checked, showName = (els.pinname as HTMLInputElement).checked;
      let sexpr: string | null = null;
      if (lib && (showNum === pinHidden(lib, "pin_numbers") || showName === pinHidden(lib, "pin_names"))) {
        const copy = L.clone(lib); L.setPinVisibility(copy, "pin_numbers", showNum); L.setPinVisibility(copy, "pin_names", showName);
        const shared = Array.from(doc.items.values()).some((o) => o.id !== item.id && o.kind === "symbol" && L.str(((L.kid(o.node, "lib_name") || L.kid(o.node, "lib_id")) || [])[1]) === libName);
        if (shared) {
          // SCH_SCREEN::Append: an existing variant equal to the edited copy is reused, else a new "<name>_<n>"
          const v = L.libVariantName(doc.lib, libId, copy);
          copy[1] = v.name as unknown as SNode; L.drop(out, "lib_name");
          if (v.name !== libId) { const at = out.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "lib_id"); out.splice(at > 0 ? at : 1, 0, L.qnode("lib_name", v.name)); }
        }
        sexpr = "(lib_symbols " + KiCadCanvas.serialize(copy) + ") " + KiCadCanvas.serialize(out);
      }
      if (!sexpr && JSON.stringify(out) === JSON.stringify(item.node)) return undefined;
      const ch = KiCadCanvas.replaceChange(doc, Object.assign({}, item, { node: out, geom: [], bbox: null }) as KItem);
      if (sexpr) (ch as KChange & { sexpr: string }).sexpr = sexpr;
      ctx.commit([ch], "Edit Symbol Properties");
      return undefined;
    },
  });
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
      grid = fieldsGrid(fh, L.fieldRows(staged, origin, ["Sheetname", "Sheetfile", "Sheet name", "Sheet file"]), { readOnly: ro, doc, newName: nextName, height: 150 });
      const row = h("div", { style: "display:flex;gap:12px;margin-top:6px;align-items:flex-start" });
      const left = h("div", { style: "flex:1" }); const g = h("div", { class: "kd-fmt" });
      els.bwidth = lenBox(st.width, "kd-sh-bwidth"); bc = swatch(st.color, "kd-sh-bcolor", undefined, ro); fc = swatch(bg, "kd-sh-bg", undefined, ro);
      g.append(h("label", null, "Border width:"), h("span", { style: "display:flex;gap:6px;align-items:center" }, els.bwidth, units()), h("span"), h("label", null, "Border color:"), bc.el, h("span"), h("label", null, "Background fill:"), fc.el, h("span"));
      els.page = textInput(pg ? L.str(pg[1]) : "", undefined, { id: "kd-sh-page", style: "width:90px", disabled: ro || (!pg && !opts.onCreate) });
      g.append(h("label", null, "Page number:"), els.page, h("span"), h("label", null, "Hierarchical path:"), pathEl, h("span"));
      left.append(g);
      const att = h("div"); const ab = KD().staticBox(att, "Attributes");
      const cb = (k: string, label: string, on: boolean) => { const x = checkbox(label, on, undefined, { id: "kd-sh-" + k, disabled: ro }); els[k] = x.querySelector("input") as HTMLInputElement; return x; };
      ab.append(cb("exsim", "Exclude from simulation", flag(staged, "exclude_from_sim", false)), cb("exbom", "Exclude from bill of materials", !flag(staged, "in_bom", true)),
        cb("exboard", "Exclude from board", !flag(staged, "on_board", true)), cb("dnp", "Do not populate", flag(staged, "dnp", false)));
      row.append(left, att); b.append(row);
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
      void changeSheetFile(ctx, item, n, oldFile, file).then((ok) => { if (ok) commit(n); });
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
async function changeSheetFile(ctx: Ctx, item: KItem, node: SNode, oldFile: string, newFile: string): Promise<boolean> {
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
    return true;
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
void E; void toast;
