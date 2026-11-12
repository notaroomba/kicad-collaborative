// pcbdialogs/update-pcb — Tools > Update PCB from Schematic… (F8, DIALOG_UPDATE_PCB).
//
// The netlist is computed in the browser from the project's schematic sheets in their current state
// (canvas/pcb-netlist.ts, the hierarchy walked from the root sheet), the changes are listed as a dry run the
// way BOARD_NETLIST_UPDATER reports them, and Update PCB applies them as one undoable edit.
// New footprints come from the footprint library service (GET /api/libs/footprints/{lib}/{name}) when the
// server has one; without it the report says the footprint cannot be added.
import { E } from "../state";
import { state } from "../appstore";
import type { Netlist, SheetFile, UpdateOptions, UpdatePlan } from "../../canvas/pcb-netlist";
import { liveDocument, projectDocs, type ProjectDocInfo } from "../projectfile";
import { NL } from "./canvas";
import { box, checkField, confirmBox, h, openDialog, reportPanel, type Field } from "./ui";

interface SchModuleInternals { _?: { symbolPins(doc: KDoc, item: KItem): { x: number; y: number; number: string; name: string; type: string; hidden: boolean }[]; isPowerSymbol(doc: KDoc, libId: string): boolean } }
const SCH_IU = 10000;

function rootSchematicOf(docs: ProjectDocInfo[]): ProjectDocInfo | null {
  const sch = docs.filter((d) => d.docType === "kicad_sch"); if (!sch.length) return null;
  const pro = docs.find((d) => d.docType === "kicad_pro");
  const stem = (p: string): string => p.replace(/\.[^./]+$/, "");
  const board = docs.find((d) => d.docId === state.docId);
  return (pro && sch.find((d) => stem(d.path) === stem(pro.path))) || (board && sch.find((d) => stem(d.path) === stem(board.path)))
    || sch.slice().sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}

/** Every schematic sheet of the project as it is now, and the netlist of the hierarchy under the root sheet. */
export async function projectNetlist(): Promise<{ netlist: Netlist; root: string } | { error: string }> {
  const docs = projectDocs(), root = rootSchematicOf(docs);
  if (!root) return { error: "This project has no schematic." };
  const sch = (CollabTools.sch as (SchToolModule & SchModuleInternals) | undefined);
  const helpers = sch && sch._;
  if (!helpers || !helpers.symbolPins) return { error: "The schematic tools are not loaded." };
  const files = new Map<string, SheetFile>();
  await Promise.all(docs.filter((d) => d.docType === "kicad_sch").map(async (d) => {
    try {
      const live = await liveDocument(d.docId);
      const doc = KiCadCanvas.parseDoc(live.file, "kicad_sch");
      for (const op of live.ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(doc, c, SCH_IU); } catch (e) { /* an op this reader cannot take */ } }
      const m = /\(uuid\s+"?([0-9a-fA-F-]{36})"?\s*\)/.exec(live.file.slice(0, 4000));
      files.set(d.path, { doc, uuid: m ? m[1] : "", file: d.path });
    } catch (e) { /* reported below as a missing sheet */ }
  }));
  const rootFile = files.get(root.path);
  if (!rootFile) return { error: "The root schematic could not be read." };
  const resolve = (file: string, parent: SheetFile): SheetFile | null => {
    const dir = parent.file.split("/").slice(0, -1);
    const parts = [...dir, ...file.split("/")].filter((p) => p && p !== ".");
    const out: string[] = []; for (const p of parts) { if (p === "..") out.pop(); else out.push(p); }
    return files.get(out.join("/")) || files.get(file) || null;
  };
  const netlist = NL().buildNetlist(rootFile, resolve, { symbolPins: helpers.symbolPins, isPower: (d, it) => helpers.isPowerSymbol(d, String(((KiCadCanvas.kid(it.node, "lib_id") as SNode | null) || [])[1])) }, root.path.split("/").pop()!.replace(/\.kicad_sch$/, ""));
  return { netlist, root: root.path };
}

// ---------------------------------------------------------------- the footprint library (optional service)
const libCache = new Map<string, SNode | "missing" | null>();
let libAvailable: boolean | null = null;
/** Fetch the library footprints a plan may need; null entries mean "no library service". */
async function fetchFootprints(fpids: string[]): Promise<void> {
  await Promise.all(fpids.filter((id) => !libCache.has(id)).map(async (fpid) => {
    const i = fpid.indexOf(":"); if (i <= 0) { libCache.set(fpid, "missing"); return; }
    if (libAvailable === false) { libCache.set(fpid, null); return; }
    try {
      const r = await fetch(`/api/libs/footprints/${encodeURIComponent(fpid.slice(0, i))}/${encodeURIComponent(fpid.slice(i + 1))}`, { headers: { accept: "application/json" } });
      const json = r.ok && /json/.test(r.headers.get("content-type") || "") ? (await r.json()) as { footprint?: string } : null;
      if (json && typeof json.footprint === "string") { libAvailable = true; const node = KiCadCanvas.parse(json.footprint); libCache.set(fpid, node || "missing"); }
      else if (r.status === 404 && libAvailable) libCache.set(fpid, "missing");
      else if (r.status === 404) {
        // a 404 is either "no such footprint" or "no such route": the library index tells the two apart
        if (libAvailable === null) { try { const p = await fetch("/api/libs/footprints", { headers: { accept: "application/json" } }); libAvailable = p.ok && /json/.test(p.headers.get("content-type") || ""); } catch (e) { libAvailable = false; } }
        libCache.set(fpid, libAvailable ? "missing" : null);
      } else libCache.set(fpid, null);
    } catch (e) { libCache.set(fpid, null); }
  }));
}

function boardFootprintIds(doc: KDoc): Set<string> {
  const out = new Set<string>();
  for (const it of doc.items.values()) if (it.kind === "footprint") out.add(String(it.node[1]));
  return out;
}

/** The plan as collaboration changes: one undo step. */
function planChanges(doc: KDoc, plan: UpdatePlan): KChange[] {
  const changes: KChange[] = [];
  for (const id of plan.removed) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.removeChange(it)); }
  for (const [id, node] of plan.modified) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node })); }
  for (const node of plan.added) { const it = KiCadCanvas.createItem(doc, node); if (it) changes.push(KiCadCanvas.addChange(doc, it)); }
  return changes;
}

const OPTIONS: { key: keyof UpdateOptions; group: number; label: string; tip?: string; def: boolean }[] = [
  { key: "relinkByRef", group: 0, label: "Re-link footprints to schematic symbols based on their reference designators", def: false,
    tip: "Normally footprints are linked to their symbols via their Unique IDs.  Select this option only if you want to reset the footprint linkages based on their reference designators." },
  { key: "replaceFootprints", group: 1, label: "Replace footprints with those specified by symbols", def: true,
    tip: "Normally footprints on the board should be changed to match footprint assignment changes made in the schematic. Uncheck this only if you don't want to change existing footprints on the board." },
  { key: "deleteUnused", group: 1, label: "Delete footprints with no symbols", def: false, tip: "Remove from the board unlocked footprints which are not linked to a schematic symbol." },
  { key: "overrideLocks", group: 1, label: "Override locks", def: false },
  { key: "updateFields", group: 2, label: "Update footprint fields from symbols", def: true },
  { key: "removeExtraFields", group: 2, label: "Remove footprint fields not found in symbols", def: false }];
const remembered: Partial<Record<keyof UpdateOptions, boolean>> = {};

export async function openUpdatePcb(ctx: ToolCtx): Promise<void> {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Update PCB from Schematic needs a board"); return; }
  const report = reportPanel("260px");
  const fields = new Map<keyof UpdateOptions, Field<boolean>>();
  let netlist: Netlist | null = null, plan: UpdatePlan | null = null, busy = false, okBtn: HTMLButtonElement | null = null;
  const options = (): UpdateOptions => {
    const o: UpdateOptions = { newUuid: () => KiCadCanvas.newUuid(), footprintFor: (fpid) => { const v = libCache.get(fpid); return v && v !== "missing" ? NL().footprintFromLibrary(v, fpid, () => KiCadCanvas.newUuid()) : v === undefined ? null : v; } };
    for (const [k, f] of fields) (o as Record<string, unknown>)[k] = f.get();
    return o;
  };
  const dryRun = async (): Promise<void> => {
    if (!netlist || busy) return;
    busy = true;
    try {
      const have = boardFootprintIds(doc);
      await fetchFootprints(Array.from(new Set(netlist.components.map((c) => c.footprint).filter((f) => f && !have.has(f)))));
      // planned against a copy of nothing: planUpdate reads the document and returns new nodes
      plan = NL().planUpdate(doc, netlist, options());
      report.set(plan.report);
      if (okBtn && !E.viewOnly) okBtn.disabled = false;
    } finally { busy = false; }
  };
  const dlg = openDialog({ title: "Update PCB from Schematic", width: 760, okLabel: "Update PCB", cancelLabel: "Close", readOnly: !!E.viewOnly, noEnter: true,
    build(body) {
      const groups = [box("Options"), box("Update Footprints"), box("Update Fields")];
      for (const o of OPTIONS) {
        const f = checkField(remembered[o.key] ?? o.def, o.label, { key: String(o.key), tip: o.tip, ro: !!E.viewOnly, onChange: (v) => { remembered[o.key] = v; void dryRun(); } });
        fields.set(o.key, f); groups[o.group].append(f.el);
      }
      body.append(groups[0], h("div", { class: "pd-cols2" }, groups[1], groups[2]), report.el);
      report.set([{ severity: "info", text: "Reading the schematic…" }]);
    },
    ok() {
      if (!plan || E.viewOnly) return false;
      const changes = planChanges(doc, plan);
      if (changes.length) { ctx.commit(changes, "update PCB from schematic"); ctx.toast(`Update PCB: ${changes.length} item${changes.length === 1 ? "" : "s"} changed`); }
      const done = plan.report.slice();
      done.push({ severity: "info", text: changes.length ? "Changes applied to the board." : "No changes to apply." });
      report.set(done);
      plan = null;
      if (okBtn) okBtn.disabled = true;
      return false;                       // KiCad keeps the dialog open with the report; Close dismisses it
    } });
  if (!dlg) return;
  okBtn = dlg.okButton; if (okBtn) okBtn.disabled = true;
  const res = await projectNetlist();
  if ("error" in res) { report.set([{ severity: "error", text: res.error }]); return; }
  netlist = res.netlist;
  await dryRun();
}

// ---------------------------------------------------------------- from the schematic editor (SCH_EDIT_FRAME::OnUpdatePCB)
/**
 * Tools > Update PCB from Schematic… (F8) in the schematic editor: open the project's board (creating it after
 * pcbnew's "PCB '%s' does not exist. Do you wish to create it?" when the project has none), then DIALOG_UPDATE_PCB
 * on it (MAIL_PCB_UPDATE).
 */
export async function updatePcbFromSchematicEditor(ctx: ToolCtx): Promise<void> {
  const { openDoc } = await import("../doc");
  const { toolCtx } = await import("../tools");
  const docs = projectDocs(); const target = NL().projectBoardPath(docs);
  const project = state.project as { projectId?: string } | null;
  const run = async (doc: ProjectDocInfo): Promise<void> => {
    const tabs = (state as { docs?: ProjectDocInfo[] }).docs || [];
    if (!tabs.some((d) => d.docId === doc.docId)) tabs.push(doc);
    await openDoc(doc);
    for (let i = 0; i < 100 && !(E.kdoc && (E.kdoc as KDoc).type === "pcb"); i++) await new Promise((r) => setTimeout(r, 50));
    if (!E.kdoc || (E.kdoc as KDoc).type !== "pcb") { ctx.toast("The board could not be opened"); return; }
    await openUpdatePcb((toolCtx as unknown as () => ToolCtx)());
  };
  if (target.doc) { await run(target.doc); return; }
  if (!target.path || !project || !project.projectId) {
    ctx.toast("Cannot update the PCB because the Schematic Editor is opened in stand-alone mode. In order to create/update PCBs from schematics, launch the main KiCad application and create a project.");
    return;
  }
  if (E.viewOnly) { ctx.toast("View-only access"); return; }
  confirmBox("Confirmation", `PCB '${target.path}' does not exist. Do you wish to create it?`, "OK", () => { void (async () => {
    try {
      const { api } = await import("../util");
      const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: target.path, docType: "kicad_pcb" }) }) as { docId?: string; path?: string; existing?: boolean };
      if (!res || !res.docId) throw new Error("no document id returned");
      const pt = (window as unknown as { PcbTools?: { BOARD_VERSION?: number } }).PcbTools;   // the version the board tools write
      if (!res.existing) await api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" }, body: NL().newBoardText((pt && pt.BOARD_VERSION) || 20260728) });
      const entry: ProjectDocInfo = { docId: res.docId, path: res.path || target.path, docType: "kicad_pcb" };
      const all = (state.project as { docs?: ProjectDocInfo[] } | null)?.docs; if (all && !all.some((d) => d.docId === entry.docId)) all.push(entry);
      await run(entry);
    } catch (e) { ctx.toast(`Could not create the board: ${(e as Error).message}`); }
  })(); });
}
