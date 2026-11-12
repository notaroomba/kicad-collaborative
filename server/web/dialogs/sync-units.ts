// dialogs/sync-units.ts — SCH_SYMBOL::SyncOtherUnits as a commit: the edit of one unit of an annotated multi-unit
// symbol carries its Value, other fields, exclude / DNP flags, pin map override and alternate pin assignments to
// every other unit with the same reference and lib_id on every sheet of the hierarchy, in the same undo step
// (DIALOG_SYMBOL_PROPERTIES::TransferDataFromWindow, DIALOG_FIELD_PROPERTIES and the properties panel).
import { E, appState, pushUndoFor, undoStack } from "./editor";
import { messageBox } from "./sch-items";
import { projectDocs, readDoc, submitDocOp } from "./project";
import * as L from "./sch-items-logic";
import * as P from "./sym-props-logic";
import { netMap, currentInstance } from "../editor/schnets";

interface SchH { isPowerSymbol(d: KDoc, name: string): boolean }
const SH = (): SchH | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchH : null; };
const libUnits = (doc: KDoc, node: SNode): number => { const H = (CollabTools as unknown as { props?: { helpers?: { libUnitCount(d: KDoc, n: SNode): number } } }).props; return H && H.helpers ? H.helpers.libUnitCount(doc, node) : 1; };
const curPath = (): string => { const s = appState.docs.find((d) => d.docId === appState.docId); return s ? s.path : ""; };

/**
 * Commit `changes` (which hold the edited symbol's new node `out`) together with the other units' updates.  `property`
 * is the single property a properties-panel edit changed (SyncOtherUnits' aProperty), null for a dialog OK.
 */
export function commitWithOtherUnits(ctx: ToolCtx & { doc: KDoc }, item: KItem, out: SNode, changes: KChange[], label: string, property: string | null = null): void {
  const doc = ctx.doc, what = P.syncFor(property);
  const units = otherUnitsOf(doc, item, out); if (!units) { ctx.commit(changes, label); return; }
  const all = changes.slice();
  for (const it of units.here) { const node = P.syncUnit(out, it.node, what); if (node) all.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem)); }
  ctx.commit(all, label);
  commitOtherSheets(label, units.there, (n) => P.syncUnit(out, n, what));
}

/**
 * CollectOtherUnits( ref, unit, libId, sheet ) over Schematic().Hierarchy() for the annotated multi-unit symbol `item`
 * (its node as `node`): the other units on the open sheet (`here`) and, per other sheet file, their ids with that
 * file's document as the net map holds it (`there`).  Null when the symbol is single-unit or not annotated.
 */
export function otherUnitsOf(doc: KDoc, item: KItem, node: SNode = item.node): { here: KItem[]; there: { file: string; doc: KDoc; ids: string[] }[] } | null {
  if (item.kind !== "symbol") return null;
  const c = netMap(), here = currentInstance(c);
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const path = here && here.uuidPath.length ? "/" + here.uuidPath.join("/") : null;
  const e = L.instanceEntry(node, path, project);
  const refP = L.kids(node, "property").find((p) => L.fieldName(p) === "Reference");
  const ref = e && L.kid(e, "reference") ? L.str((L.kid(e, "reference") as SNode)[1]) : refP ? L.fieldValue(refP) : "";
  const unit = e && L.kid(e, "unit") ? L.num((L.kid(e, "unit") as SNode)[1], 1) : L.num((L.kid(node, "unit") || [0, 1])[1], 1);
  const libId = L.str((L.kid(node, "lib_id") || [])[1]);
  if (libUnits(doc, node) < 2 || !P.isAnnotated(ref)) return null;
  const cur = curPath();
  const sheets: { path: string; doc: KDoc; file: string }[] = [];
  if (c && c.instances.length) for (const inst of c.instances) { const d = inst.file === cur ? doc : c.docs.get(inst.file); if (d) sheets.push({ path: "/" + inst.uuidPath.join("/"), doc: d, file: inst.file }); }
  else sheets.push({ path: path || "", doc, file: cur });
  const H = SH(); const isPower = (d: KDoc, it: KItem): boolean => !!H && H.isPowerSymbol(d, L.str((L.kid(it.node, "lib_id") || [])[1]));
  const hits = P.collectOtherUnits(sheets, item, ref, unit, libId, project, isPower);
  const mine = new Map<string, KItem>(); const theirs = new Map<string, { file: string; doc: KDoc; ids: string[] }>();
  for (const h of hits) {
    if (h.sheet.file === cur || h.sheet.doc === doc) { const it = doc.items.get(h.item.id); if (it) mine.set(it.id, it); }
    else { const t = theirs.get(h.sheet.file) || { file: h.sheet.file, doc: h.sheet.doc, ids: [] }; if (!t.ids.includes(h.item.id)) t.ids.push(h.item.id); theirs.set(h.sheet.file, t); }
  }
  return { here: [...mine.values()], there: [...theirs.values()] };
}

/**
 * The part of a commit that lands on other sheet files: each one's units (`there`) re-read and changed by `edit`
 * (null leaves a unit alone), submitted to that document and folded into the undo step the open sheet's commit just
 * pushed, so one Undo puts every sheet back.
 */
export function commitOtherSheets(label: string, there: { file: string; ids: string[] }[], edit: (node: SNode) => SNode | null, attach = true): void {
  if (!there.length || E.viewOnly) return;
  const entry = attach ? undoStack[undoStack.length - 1] : null;
  void (async () => {
    const done: { docId: string; file: string; changes: KChange[]; inverse: KChange[] }[] = [], failed: string[] = [];
    for (const { file, ids } of there) {
      const de = projectDocs().find((d) => d.path === file); if (!de) continue;
      try {
        const fresh = await readDoc(de.docId, "kicad_sch");
        const ch: KChange[] = [], inv: KChange[] = [];
        for (const id of ids) { const it = fresh.items.get(id); if (!it) continue; const n = edit(it.node); if (!n) continue; inv.push(KiCadCanvas.replaceChange(fresh, it)); ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem)); }
        if (!ch.length) continue;
        await submitDocOp(de.docId, ch); done.push({ docId: de.docId, file, changes: ch, inverse: inv });
      } catch (err) { failed.push(file); }
    }
    if (done.length) {
      const replay = (which: "changes" | "inverse") => () => { for (const o of done) submitDocOp(o.docId, o[which]).catch(() => { void messageBox(`Could not update '${o.file}'.`); }); };
      if (entry && undoStack.includes(entry)) Object.assign(entry, { undoOthers: replay("inverse"), redoOthers: replay("changes") });
      else pushUndoFor(String(appState.docId || ""), { label, changes: [], inverse: [], undoOthers: replay("inverse"), redoOthers: replay("changes") });
    }
    if (failed.length) void messageBox(`Could not update ${failed.map((f) => `'${f}'`).join(", ")}.`);
  })();
}

/**
 * SCH_EDIT_TOOL::SetAttribute (the Attributes menu: Exclude from Simulation / Bill of Materials / Board / Position
 * Files, Do not Populate): the flag `key` is turned on for every item when any of them (the selection plus, for an
 * annotated multi-unit symbol, its other units on every sheet) has it off, otherwise turned off for all, in one
 * "Toggle Attribute" commit.  `set` writes the state into a copy of a node.  False when there is nothing to toggle.
 */
export function toggleAttribute(ctx: ToolCtx & { doc: KDoc }, items: KItem[], isOn: (node: SNode) => boolean, set: (node: SNode, on: boolean) => SNode): boolean {
  const doc = ctx.doc; if (!items.length) return false;
  const here = new Map<string, KItem>(); const there = new Map<string, { file: string; doc: KDoc; ids: string[] }>();
  for (const it of items) {
    here.set(it.id, it);
    const u = it.kind === "symbol" ? otherUnitsOf(doc, it) : null; if (!u) continue;
    for (const o of u.here) here.set(o.id, o);
    for (const t of u.there) { const m = there.get(t.file) || { file: t.file, doc: t.doc, ids: [] }; for (const id of t.ids) if (!m.ids.includes(id)) m.ids.push(id); there.set(t.file, m); }
  }
  let on = false;
  for (const it of here.values()) if (!isOn(it.node)) { on = true; break; }
  if (!on) for (const t of there.values()) for (const id of t.ids) { const it = t.doc.items.get(id); if (it && !isOn(it.node)) { on = true; break; } }
  const changes: KChange[] = [];
  for (const it of here.values()) { const node = set(it.node, on); if (JSON.stringify(node) !== JSON.stringify(it.node)) changes.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem)); }
  const label = "Toggle Attribute";
  if (changes.length) ctx.commit(changes, label);
  commitOtherSheets(label, [...there.values()], (n) => { const out = set(n, on); return JSON.stringify(out) === JSON.stringify(n) ? null : out; }, changes.length > 0);
  return true;
}
