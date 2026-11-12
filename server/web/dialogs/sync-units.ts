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
  const doc = ctx.doc, c = netMap(), here = currentInstance(c);
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const path = here && here.uuidPath.length ? "/" + here.uuidPath.join("/") : null;
  const e = L.instanceEntry(out, path, project);
  const refP = L.kids(out, "property").find((p) => L.fieldName(p) === "Reference");
  const ref = e && L.kid(e, "reference") ? L.str((L.kid(e, "reference") as SNode)[1]) : refP ? L.fieldValue(refP) : "";
  const unit = e && L.kid(e, "unit") ? L.num((L.kid(e, "unit") as SNode)[1], 1) : L.num((L.kid(out, "unit") || [0, 1])[1], 1);
  const libId = L.str((L.kid(out, "lib_id") || [])[1]);
  const what = P.syncFor(property);
  if (libUnits(doc, out) < 2 || !P.isAnnotated(ref)) { ctx.commit(changes, label); return; }
  const cur = curPath();
  const sheets: { path: string; doc: KDoc; file: string }[] = [];
  if (c && c.instances.length) for (const inst of c.instances) { const d = inst.file === cur ? doc : c.docs.get(inst.file); if (d) sheets.push({ path: "/" + inst.uuidPath.join("/"), doc: d, file: inst.file }); }
  else sheets.push({ path: path || "", doc, file: cur });
  const H = SH(); const isPower = (d: KDoc, it: KItem): boolean => !!H && H.isPowerSymbol(d, L.str((L.kid(it.node, "lib_id") || [])[1]));
  const hits = P.collectOtherUnits(sheets, item, ref, unit, libId, project, isPower);
  const mine = new Map<string, SNode>(); const theirs = new Map<string, Set<string>>();
  for (const h of hits) {
    if (h.sheet.file === cur || h.sheet.doc === doc) { if (!mine.has(h.item.id)) { const n = P.syncUnit(out, h.item.node, what); if (n) mine.set(h.item.id, n); } }
    else { const s = theirs.get(h.sheet.file) || new Set<string>(); s.add(h.item.id); theirs.set(h.sheet.file, s); }
  }
  const all = changes.slice();
  for (const [id, node] of mine) { const it = doc.items.get(id); if (it) all.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem)); }
  ctx.commit(all, label);
  if (!theirs.size || E.viewOnly) return;
  const entry = undoStack[undoStack.length - 1];
  void (async () => {
    const done: { docId: string; file: string; changes: KChange[]; inverse: KChange[] }[] = [], failed: string[] = [];
    for (const [file, ids] of theirs) {
      const de = projectDocs().find((d) => d.path === file); if (!de) continue;
      try {
        const fresh = await readDoc(de.docId, "kicad_sch");
        const ch: KChange[] = [], inv: KChange[] = [];
        for (const id of ids) { const it = fresh.items.get(id); if (!it) continue; const n = P.syncUnit(out, it.node, what); if (!n) continue; inv.push(KiCadCanvas.replaceChange(fresh, it)); ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem)); }
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
