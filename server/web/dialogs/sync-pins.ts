// dialogs/sync-pins.ts — Place → Sync All Sheet Pins… (eeschema/sync_sheet_pin/dialog_sync_sheet_pins.cpp): one tab
// per hierarchical sheet on this page, the sheet's unmatched hierarchical labels on the left and the unmatched sheet
// pins on the right.  As on the desktop the changes happen at once: sheet pins change the sheet symbol here, labels
// change the sub-sheet's own document.
import { E, appState, pushUndoFor, toast, toolCtx, cloneNode } from "./editor";
import { KD, h } from "./dom";
import { kids, str } from "./logic";
import { projectDocs, readDoc, submitDocOp } from "./project";
import { selectionIds } from "../editor/gestures";
import { labelDefaults } from "../editor/schnets";

interface SchInternals { sheetPinNode(name: string, p: [number, number], side: string): SNode; labelNode(kind: string, text: string, p: [number, number], rot: number): SNode; modChange(doc: KDoc, item: KItem, node: SNode): KChange; itemSexpr(doc: KDoc, kind: string, node: SNode): string; typeNameFor(item: { kind: string }): string; autoPlaceSheetPinsNode(sheet: SNode, sub: KDoc, textSize?: number): SNode | null }
const S = appState;
const r4 = (v: number) => +v.toFixed(4);

export function openSyncSheetPins(): void {
  const doc = E.kdoc as KDoc | null; if (!doc) return;
  const sheets = [...doc.items.values()].filter((it) => it.kind === "sheet");
  if (!sheets.length) { toast("No hierarchical sheets on this page"); return; }
  const ro = !!E.viewOnly, I = CollabTools.sch!._ as unknown as SchInternals;
  const here = projectDocs().find((d) => d.docId === S.docId), dir = here ? here.path.split("/").slice(0, -1).join("/") : "";
  const subEntry = (it: KItem) => { const f = it.file || ""; const path = dir ? `${dir}/${f}` : f; const all = projectDocs().filter((d) => d.docType === "kicad_sch"); return all.find((d) => d.path === path) || all.find((d) => d.path.split("/").pop() === f.split("/").pop()) || null; };
  const subs = new Map<string, KDoc>();
  const labelsOf = (d: KDoc) => [...d.items.values()].filter((o) => o.kind === "hierarchical_label");
  const live = (id: string) => (E.kdoc as KDoc).items.get(id) || null;

  KD().open({ title: "Synchronize sheet pins and hierarchical labels", width: 720, buttons: [{ label: "Close", close: true, isDefault: true }],
    build(body) {
      body.append(h("p", { class: "kd-note" }, "Changes made in this dialog occur immediately, use Undo in each affected document to undo them"));
      KD().notebook(body, sheets.map((sh) => ({ label: sh.name || sh.file || "Sheet", build(page: HTMLElement) {
        const entry = subEntry(sh);
        const render = () => {
          const it = live(sh.id), sub = entry ? subs.get(entry.docId) : undefined; page.replaceChildren();
          if (!it) { page.append(h("p", { class: "kd-note" }, "This sheet has been deleted.")); return; }
          if (!entry) { page.append(h("p", { class: "kd-note" }, `The sheet file ${sh.file || ""} is not part of the shared project yet.`)); return; }
          if (!sub) { page.append(h("p", { class: "kd-note" }, "Loading the sheet…")); return; }
          const pins = kids(it.node, "pin"), pinNames = new Set(pins.map((p) => str(p[1]))), labels = labelsOf(sub), labelNames = new Set(labels.map((l) => str(l.node[1])));
          const missingPins = [...labelNames].filter((n) => !pinNames.has(n)), orphanPins = [...pinNames].filter((n) => !labelNames.has(n));
          const list = (names: string[], id: string) => h("div", { id, style: "border:1px solid var(--line);background:var(--panel);height:200px;overflow:auto;padding:4px 8px" }, ...(names.length ? names.map((n) => h("div", null, n)) : [h("div", { style: "color:var(--ink-3)" }, "(none)")]));
          const btn = (label: string, id: string, disabled: boolean, fn: () => void) => h("button", { class: "btn", type: "button", id, disabled: ro || disabled, onclick: fn }, label);
          const addPins = () => {
            const cur = live(sh.id); if (!cur) return; const node = cloneNode(cur.node) as SNode; const [x, y] = KiCadCanvas.atOf(node), size = KiCadCanvas.kid(node, "size"), hh = size ? KiCadCanvas.num(size[2]) : 20;
            const used = new Set(kids(node, "pin").map((p) => { const a = KiCadCanvas.kid(p, "at"); return a ? r4(KiCadCanvas.num(a[2])) : 0; })); let row = 0;
            for (const name of missingPins) { let py = y; do { py = r4(y + 2.54 * (++row)); } while (used.has(py) && py < y + hh); py = Math.min(r4(y + hh), py); used.add(py);
              const pin = I.sheetPinNode(name, [x, py], "left"); const lab = labels.find((l) => str(l.node[1]) === name), shape = lab ? KiCadCanvas.kid(lab.node, "shape") : null; if (shape) pin[2] = str(shape[1]);
              const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (at >= 0) node.splice(at, 0, pin); else node.push(pin); }
            toolCtx().commit([I.modChange(E.kdoc as KDoc, cur, node)], "sync sheet pins"); render();
          };
          const rmPins = () => { const cur = live(sh.id); if (!cur) return; const node = cloneNode(cur.node) as SNode; for (let i = node.length - 1; i > 0; i--) { const c = node[i]; if (Array.isArray(c) && c[0] === "pin" && orphanPins.includes(str(c[1]))) node.splice(i, 1); } toolCtx().commit([I.modChange(E.kdoc as KDoc, cur, node)], "delete sheet pins"); render(); };
          const addLabels = () => {
            let ymax = 20; for (const o of sub.items.values()) if (o.bbox) ymax = Math.max(ymax, o.bbox[3]);
            const changes: KChange[] = orphanPins.map((name, i) => { const node = I.labelNode("hierarchical_label", name, [25.4, r4(Math.ceil((ymax + 5.08) / 2.54) * 2.54 + i * 2.54)], 0);
              const pin = pins.find((p) => str(p[1]) === name), sh2 = KiCadCanvas.kid(node, "shape"); if (pin && sh2) sh2[1] = str(pin[2]);
              return { id: KiCadCanvas.uuidOf(node), kind: "ADDED", typeName: I.typeNameFor({ kind: "hierarchical_label" }), sexpr: I.itemSexpr(sub, "hierarchical_label", node) }; });
            pushUndoFor(entry.docId, { label: "add hierarchical labels", changes, inverse: changes.map((c) => ({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] })) });
            void submitDocOp(entry.docId, changes).then(() => readDoc(entry.docId, "kicad_sch")).then((d) => { subs.set(entry.docId, d); render(); toast(`Added ${changes.length} hierarchical label${changes.length === 1 ? "" : "s"} to ${entry.path}`); }, (e: Error) => toast("Could not add the labels: " + e.message, 4000));
          };
          const rmLabels = () => { const gone = labels.filter((l) => missingPins.includes(str(l.node[1]))); const changes: KChange[] = gone.map((l) => KiCadCanvas.removeChange(l));
            pushUndoFor(entry.docId, { label: "delete hierarchical labels", changes, inverse: gone.map((l) => ({ id: l.id, kind: "ADDED", typeName: I.typeNameFor(l), sexpr: I.itemSexpr(sub, l.kind, l.node) })) });
            void submitDocOp(entry.docId, changes).then(() => readDoc(entry.docId, "kicad_sch")).then((d) => { subs.set(entry.docId, d); render(); }, (e: Error) => toast("Could not delete the labels: " + e.message, 4000)); };
          const head = (t: string, sub2: string) => h("div", { style: "text-align:center;margin-bottom:4px" }, h("div", { style: "color:var(--ink-2);font-size:11px" }, t), h("div", { style: "font-weight:600" }, sub2));
          page.append(h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:14px" },
            h("div", null, head("Symbol name", sh.name || ""), h("div", { style: "color:var(--ink-2);margin:4px 0" }, "Hierarchical labels without a sheet pin:"), list(missingPins, "kd-sync-labels"),
              h("div", { class: "kd-row", style: "margin-top:6px" }, btn("Add Sheet Pins", "kd-sync-addpins", !missingPins.length, addPins), btn("Delete Hierarchical Labels", "kd-sync-rmlabels", !missingPins.length, rmLabels))),
            h("div", null, head("Sheet name", sh.file || ""), h("div", { style: "color:var(--ink-2);margin:4px 0" }, "Sheet pins without a hierarchical label:"), list(orphanPins, "kd-sync-pins"),
              h("div", { class: "kd-row", style: "margin-top:6px" }, btn("Add Hierarchical Labels", "kd-sync-addlabels", !orphanPins.length, addLabels), btn("Delete Sheet Pins", "kd-sync-rmpins", !orphanPins.length, rmPins)))),
            h("p", { class: "kd-note", style: "margin-top:8px" }, !missingPins.length && !orphanPins.length ? "The sheet pins and hierarchical labels are synchronized." : ""));
        };
        render();
        if (entry && !subs.has(entry.docId)) void readDoc(entry.docId, "kicad_sch").then((d) => { subs.set(entry.docId, d); render(); }, () => { page.replaceChildren(h("p", { class: "kd-note" }, "The sheet's file could not be read.")); });
      } })));
    } });
}

/** The project document a sheet symbol on the open page names (its Sheetfile beside this page, else by file name). */
function sheetFileEntry(it: KItem) {
  const here = projectDocs().find((d) => d.docId === S.docId), dir = here ? here.path.split("/").slice(0, -1).join("/") : "";
  const f = it.file || "", path = dir ? `${dir}/${f}` : f, all = projectDocs().filter((d) => d.docType === "kicad_sch");
  return all.find((d) => d.path === path) || all.find((d) => d.path.split("/").pop() === f.split("/").pop()) || null;
}

/**
 * SCH_DRAWING_TOOLS::AutoPlaceAllSheetPins (the sheet context menu's Autoplace All Sheet Pins): pins for every
 * hierarchical label of the selected sheet's file that has none, placed by AutoPlaceSheetPins in one commit;
 * "No new hierarchical labels found." when there is nothing to add.  The selection is cleared either way.
 */
export async function autoplaceAllSheetPins(): Promise<void> {
  const doc = E.kdoc as KDoc | null; if (!doc || E.viewOnly) return;
  const ids = selectionIds();
  const sheet = ids.map((id) => doc.items.get(id)).find((it) => it && it.kind === "sheet"); if (!sheet) return;
  const entry = sheetFileEntry(sheet); let sub: KDoc | null = null;
  if (entry) { try { sub = await readDoc(entry.docId, "kicad_sch"); } catch (e) { sub = null; } }
  const cur = (E.kdoc as KDoc).items.get(sheet.id); if (!cur) return;
  const I = CollabTools.sch!._ as unknown as SchInternals;
  const node = sub ? I.autoPlaceSheetPinsNode(cur.node, sub, labelDefaults().textSize) : null;   // Schematic().Settings().m_DefaultTextSize
  const ctx = toolCtx(); ctx.setSelection([]);
  if (!node) { toast("No new hierarchical labels found.", 2000); return; }
  ctx.commit([I.modChange(E.kdoc as KDoc, cur, node)], "Auto-place Sheet Pins");
}
