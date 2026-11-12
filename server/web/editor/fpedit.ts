// editor/fpedit.ts — the Footprint Editor (pcbnew/footprint_edit_frame.cpp) on the board editor's machinery.
//
// A footprint opens at /p/{project}/edit?fp=<docId> (a .kicad_mod of the project, joined over the socket like any
// document: every edit is an item op, the undo list is the document's) or ?fp=board:<boardDocId>:<fpUuid> (Edit
// Footprint, Ctrl+E on the board: a private copy, FOOTPRINT_EDIT_FRAME::LoadFootprintFromBoard, that only Save
// writes back, through BOARD::ExchangeFootprint, as one "Update Footprint" step of the board).
//
//   modified ('*')   a library footprint differs from its newest snapshot; a board copy from what it was loaded as
//   Save             library: the file through KiCad's writer (canvas/footprint-doc.ts) becomes the newest
//                    snapshot (POST /api/docs/{id}/snapshots?seq=<head>); board copy: SaveFootprintToBoard
//   Revert           the newest snapshot (or the board's footprint) back, as one undoable step
//   New Footprint    CreateNewFootprint ("Untitled", REF** / value / ${REFERENCE}) as a new .kicad_mod document
//   Save As          the footprint under another name / library, as a new document
//   New Library      a <name>.pretty row in the project's fp-lib-table
//   Insert into PCB  the board tab (BroadcastChannel "kc-fpedit") carries it on the cursor, as KiCad's placement
import { setStatusBar, state, store } from "./appstore";
import { E } from "./state";
import { showPane } from "./panes";
import { commitObservers, setTool, toolCtx, undoStack } from "./tools";
import { api, toast } from "./util";
import { liveDocument, saveTextDocument, sendDocOps } from "./projectfile";
import { confirmBox, promptText } from "../dialogs/dom";
import { listDialog, messageBox } from "./pcbdialogs/ui";
import { enumPadsDialog, footprintCheckerDialog, footprintUsersDialog, footprintPropertiesDialog, padTableDialog, pushPadDialog } from "./pcbdialogs/fp-editor";
import type { DocEntry, ProjectInfo } from "../store";
import type { ActionHandler } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const W = window as unknown as { PcbTools: Any; KDialogs?: Any; KiCadLibrary?: Any };
const FD = (): Any => KiCadCanvas.footprintDoc;
const PT = () => W.PcbTools;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
/** The file version the web writes new footprints with (pcb-tools BOARD_VERSION): never newer than the board writer. */
const NEW_FILE_VERSION = 20260728;

interface BoardCopy { boardDocId: string; fpUuid: string; uuidMap: Record<string, string>; link: string; reference: string; boardPath: string; text: string }
export const FP: { board: BoardCopy | null; snapSeq: number; title: string; timer: number; padEdit: string | null; framed: boolean } = { board: null, snapSeq: 0, title: "", timer: 0, padEdit: null, framed: false };

export const isFpEdit = (): boolean => E.DOC_TYPE === "footprint";
/** The open footprint is a private copy of a board footprint (nothing goes over the socket until Save). */
export const isFpPrivate = (): boolean => isFpEdit() && !!state.docId && state.docId.startsWith("board:");
export const boardCopyId = (boardDocId: string, fpUuid: string) => `board:${boardDocId}:${fpUuid}`;

// ---------------------------------------------------------------- libraries of the project
export interface FpLib { name: string; uri: string; footprints: { name: string; docId: string; path: string }[] }
/** "Lib:Name" of a footprint document: its .pretty folder is the library, the file name the footprint. */
export function fpLibIdOf(path: string): { lib: string; name: string } {
  const parts = path.split("/"); const file = parts.pop() || ""; const dir = parts.pop() || "";
  return { lib: dir.replace(/\.pretty$/i, ""), name: file.replace(/\.kicad_mod$/i, "") };
}
/** fp-lib-table rows: (lib (name "X")(type "KiCad")(uri "${KIPRJMOD}/X.pretty")(options "")(descr "")). */
export function parseLibTable(text: string): { name: string; uri: string; type: string; descr: string }[] {
  const t = text ? KiCadCanvas.parse(text) : null; if (!t) return [];
  return (KiCadCanvas.kids(t, "lib") as SNode[]).map((l) => ({ name: str((KiCadCanvas.kid(l, "name") || [])[1]), uri: str((KiCadCanvas.kid(l, "uri") || [])[1]), type: str((KiCadCanvas.kid(l, "type") || [])[1]), descr: str((KiCadCanvas.kid(l, "descr") || [])[1]) }))
    .filter((r) => r.name);
}
let libTableCache: { docId: string; rows: ReturnType<typeof parseLibTable> } | null = null;
const libTableDoc = (): DocEntry | undefined => (state.project ? state.project.docs.find((d) => d.path === "fp-lib-table") : undefined);
async function libTableRows(fresh = false): Promise<ReturnType<typeof parseLibTable>> {
  const d = libTableDoc(); if (!d) return [];
  if (!fresh && libTableCache && libTableCache.docId === d.docId) return libTableCache.rows;
  try { const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); const rows = r.ok ? parseLibTable(await r.text()) : []; libTableCache = { docId: d.docId, rows }; return rows; } catch { return []; }
}
/** The libraries the Libraries pane lists: every .pretty folder of the project and every project row of fp-lib-table. */
export function projectFpLibs(): FpLib[] {
  const out = new Map<string, FpLib>();
  for (const r of libTableCache ? libTableCache.rows : []) if (/\$\{KIPRJMOD\}/.test(r.uri)) out.set(r.name, { name: r.name, uri: r.uri, footprints: [] });
  for (const d of state.project ? state.project.docs : []) {
    if (d.docType !== "footprint") continue;
    const { lib, name } = fpLibIdOf(d.path); if (!lib) continue;
    let l = out.get(lib); if (!l) { l = { name: lib, uri: "${KIPRJMOD}/" + d.path.split("/").slice(0, -1).join("/"), footprints: [] }; out.set(lib, l); }
    l.footprints.push({ name, docId: d.docId, path: d.path });
  }
  for (const l of out.values()) l.footprints.sort((a, b) => a.name.localeCompare(b.name));
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}
/** The folder a library's footprints are written to (its fp-lib-table uri under ${KIPRJMOD}). */
function libFolder(lib: FpLib): string { return lib.uri.replace(/^\$\{KIPRJMOD\}\/?/, "") || lib.name + ".pretty"; }
/** Publish the library list to the chrome (the Libraries pane). */
export function publishLibs(): void { store.set({ fpLibs: { libs: projectFpLibs(), current: state.docId || null, version: Date.now() } }); }

// ---------------------------------------------------------------- opening
/** The ?fp= value of the address bar. */
export const fpParam = (): string | null => new URLSearchParams(location.search).get("fp");

/** A board footprint as the editor gets it: the live board (snapshot + journal) normalised by editableCopy. */
async function loadBoardCopy(boardDocId: string, fpUuid: string, info: ProjectInfo): Promise<BoardCopy | null> {
  const board = info.docs.find((d) => d.docId === boardDocId); if (!board) return null;
  let file = "", ops: { changes: KChange[] }[] = [];
  try { const live = await liveDocument(boardDocId); file = live.file; ops = live.ops; }
  catch { try { const r = await fetch(`/api/docs/${boardDocId}/content?v=${Date.now()}`, { credentials: "same-origin" }); if (r.ok) file = await r.text(); } catch { /* reported below */ } }
  if (!file) return null;
  const bd = KiCadCanvas.parseDoc(file, "kicad_pcb");
  for (const op of ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(bd, c, 1e6); } catch { /* a change the board no longer takes */ } }
  const it = bd.items.get(fpUuid); if (!it || it.kind !== "footprint") return null;
  const m = /\(version (\d+)\)/.exec(file.slice(0, 200));
  const e = PT().exchange.editableCopy(it.node, m ? Number(m[1]) : NEW_FILE_VERSION);
  // the editor names it by its FPID item name (a .kicad_mod has no library part)
  const name = str(e.node[1]); const colon = name.indexOf(":"); if (colon >= 0) e.node[1] = name.slice(colon + 1);
  const text = FD().prettify(KiCadCanvas.serialize(e.node));
  return { boardDocId, fpUuid, uuidMap: e.uuidMap, link: e.link, reference: e.reference, boardPath: board.path, text };
}

/** openEditor: the document ?fp= names (a library footprint, or a board footprint's private copy). */
export async function fpEntryFor(info: ProjectInfo, param: string): Promise<DocEntry | null> {
  if (param.startsWith("board:")) {
    const [, b, u] = param.split(":");
    const copy = await loadBoardCopy(b, u, info);
    if (!copy) { toast("Unable to find the footprint on the main board.", 4000); return null; }
    FP.board = copy;
    return { docId: boardCopyId(b, u), path: copy.reference + " [" + copy.boardPath + "]", docType: "footprint" };
  }
  FP.board = null;
  return info.docs.find((d) => d.docId === param && d.docType === "footprint") || null;
}

/** openDoc: the text of a private board copy (null for a document the server holds). */
export function privateText(doc: DocEntry): string | null { return doc.docType === "footprint" && doc.docId.startsWith("board:") && FP.board && boardCopyId(FP.board.boardDocId, FP.board.fpUuid) === doc.docId ? FP.board.text : null; }

/** After the text loaded: the snapshot seq it came from, the title, the pad dialog for pads, the libraries. */
export function onFootprintOpened(snapSeq: number): void {
  FP.snapSeq = snapSeq;
  // FOOTPRINT_EDITOR_SETTINGS' design settings for new graphics and text, never the project board's
  if (PT() && PT().useFootprintEditorDefaults) PT().useFootprintEditorDefaults(true);
  if (!FP.framed) {
    // FOOTPRINT_EDIT_FRAME's constructor: SetActiveLayer( F_SilkS )
    FP.framed = true;
    E.activeLayer = "F.SilkS"; E.renderOpts.activeLayer = "F.SilkS"; store.slice("viewport", { activeLayer: "F.SilkS" });
    const mod = CollabTools.pcb as Any; if (mod && mod.setLayer) { try { mod.setLayer(toolCtx(), "F.SilkS"); } catch { /* module without layer API */ } }
  }
  hookPadDialog();
  libTableRows().then(publishLibs).catch(() => publishLibs());
  refreshTitle();
  clearInterval(FP.timer);
  FP.timer = window.setInterval(() => { if (!isFpEdit()) { clearInterval(FP.timer); FP.timer = 0; document.title = FP.title = ""; return; } refreshTitle(); }, 700);
  if (isFpPrivate() && FP.board) setStatusBar({ message: `Footprint ${FP.board.reference} from ${FP.board.boardPath}` });
}

/** The window title: KiCad's "Footprint Editor", after the footprint (lib:name, '*' when modified). */
export function refreshTitle(): void {
  if (!isFpEdit() || !E.kdoc) return;
  const name = FD().footprintName(E.kdoc);
  const lib = isFpPrivate() ? "" : state.doc ? fpLibIdOf(state.doc.path).lib : "";
  const mod = FD().footprintModified(E.kdoc);
  const t = `${isFpPrivate() && FP.board ? FP.board.reference : (lib ? lib + ":" : "") + name}${mod ? " *" : ""} — Footprint Editor`;
  if (t !== FP.title) { FP.title = t; document.title = t; store.set({ fpTitle: { label: (lib ? lib + ":" : "") + name, modified: mod, fromBoard: isFpPrivate() } }); }
}
commitObservers.push((phase) => { if (phase === "after" && isFpEdit()) refreshTitle(); });

// ---------------------------------------------------------------- Pad Properties on a pad of the footprint itself
/** DIALOG_PAD_PROPERTIES works on a footprint's pad: the pad goes in a footprint at the origin, the commit comes back as the pad's own change. */
export function fpPadProperties(ctx: ToolCtx, pad: KItem): boolean {
  const mod = CollabTools.pcb as Any; if (!mod || !mod.padProperties) return false;
  const host: KItem = { id: "__fpedit_host", kind: "footprint", node: ["footprint", "", ["layer", "F.Cu"], ["at", 0, 0], KiCadCanvas.cloneNode(pad.node)] } as Any;
  const proxy = Object.assign({}, ctx, {
    commit(changes: KChange[], label?: string) {
      const c = changes.find((x) => x.id === host.id); if (!c || !c.sexpr) return;
      const t = KiCadCanvas.parse(c.sexpr); const fp = t && (t[0] === "footprint" ? t : KiCadCanvas.kid(t, "footprint")); const np = fp && KiCadCanvas.kid(fp, "pad");
      if (!np) return;
      ctx.commit([PT().replacedChange(pad, np)], label);
    },
  });
  return mod.padProperties(proxy, host, 0) !== false;
}
function hookPadDialog(): void {
  const KD = W.KDialogs; if (!KD || KD.__fpHooked) return;
  const orig = KD.openItem;
  KD.openItem = (ctx: ToolCtx, it: KItem, opts?: unknown) => (it && it.kind === "pad" && ctx.doc && (ctx.doc as Any).fpEditor ? fpPadProperties(ctx, it) : orig(ctx, it, opts));
  KD.__fpHooked = true;
}

// ---------------------------------------------------------------- save / revert
async function waitPending(ms: number): Promise<void> { const t0 = Date.now(); while (E.pendingOps.size && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); }

/** FOOTPRINT_EDIT_FRAME::SaveFootprint: the file KiCad would write becomes the newest snapshot. */
export async function saveFootprint(): Promise<boolean> {
  if (!E.kdoc || !isFpEdit()) return false;
  // PAD_TOOL::InPadEditMode: the pad is recombined first (PCB_ACTIONS::recombinePad), so the file holds the custom pad
  if (FP.padEdit && !E.viewOnly) exitPadEditMode();
  if (isFpPrivate()) return saveToBoard();
  if (E.viewOnly) { toast("You can view this project but not change it"); return false; }
  const text = FD().serializeFootprintDoc(E.kdoc);
  await waitPending(4000);
  if (E.pendingOps.size) { toast("Not connected — the footprint is saved once the connection is back", 4000); return false; }
  const docId = state.docId!; const seq = Math.max(E.lastSeq, FP.snapSeq);
  const r = await fetch(`/api/docs/${docId}/snapshots?seq=${seq}&saved=1`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
  const { lib, name } = fpLibIdOf(state.doc!.path);
  if (!r.ok) { toast(`Footprint '${name}' could not be saved to library '${lib}'.`, 5000); return false; }
  FD().markFootprintSaved(E.kdoc, text); FP.snapSeq = seq;
  // a .pretty footprint's name is its file name: a renamed footprint is saved under the new name and the old entry
  // goes (SaveFootprintInLibrary, then DeleteFootprintFromLibrary of the name it was loaded with)
  const newName = FD().footprintName(E.kdoc);
  if (newName && newName !== name && !/[\\/:"*?<>|]/.test(newName)) {
    const path = state.doc!.path.split("/").slice(0, -1).concat(newName + ".kicad_mod").join("/");
    const pr = await fetch(`/api/docs/${docId}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }).catch(() => null);
    if (pr && pr.ok) {
      const d = state.project && state.project.docs.find((x) => x.docId === docId); if (d) d.path = path;
      if (state.doc) state.doc.path = path;
      if (state.project) store.set({ project: Object.assign({}, state.project) });
      publishLibs(); refreshTitle();
      setStatusBar({ message: `Footprint '${newName}' saved in library '${lib}'.` });
      return true;
    }
    toast(pr && (pr.status === 404 || pr.status === 405) ? "This server cannot rename files yet" : `Footprint '${name}' could not be renamed to '${newName}'.`, 5000);
  }
  refreshTitle();
  setStatusBar({ message: `Footprint '${name}' saved in library '${lib}'.` });
  return true;
}

/** Changes that take the open footprint to `text` (a saved version): one step, so Undo brings the edits back. */
function changesTo(text: string): KChange[] {
  const doc = E.kdoc!; const target = KiCadCanvas.parseDoc(text, "footprint");
  const out: KChange[] = [];
  const wrap = (n: SNode) => PT().wrapBoard(n);
  for (const [id, it] of target.items) {
    const cur = doc.items.get(id);
    if (!cur) out.push({ id, kind: "ADDED", typeName: PT().typeNameOf(it), sexpr: wrap(it.node) });
    else if (KiCadCanvas.serialize(cur.node) !== KiCadCanvas.serialize(it.node)) out.push({ id, kind: "MODIFIED", typeName: PT().typeNameOf(it), sexpr: wrap(it.node) });
  }
  for (const [id, it] of doc.items) if (!target.items.has(id)) out.push({ id, kind: "REMOVED", typeName: PT().typeNameOf(it), properties: [] });
  const h = FD().footprintHeaderSexpr(target); if (h !== FD().footprintHeaderSexpr(doc)) out.push({ id: "footprint", kind: "MODIFIED", typeName: "FOOTPRINT", sexpr: h });
  return out;
}

/** FOOTPRINT_EDIT_FRAME::RevertFootprint. */
export async function revertFootprint(): Promise<void> {
  if (!E.kdoc || !isFpEdit() || !FD().footprintModified(E.kdoc)) return;
  const name = FD().footprintName(E.kdoc);
  const msg = isFpPrivate() && FP.board ? `Revert '${FP.board.reference}' to version from board?` : `Revert '${name}' to last version saved?`;
  if (!(await confirmBox("Confirmation", msg + "\n\nYour current changes will be permanently lost.", "Revert"))) return;
  let text: string | null = null;
  if (isFpPrivate() && FP.board) text = FP.board.text;
  else { try { const r = await fetch(`/api/docs/${state.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); if (r.ok) text = await r.text(); } catch { /* below */ } }
  if (!text) { toast("The saved footprint could not be read"); return; }
  const ch = changesTo(text); if (!ch.length) return;
  toolCtx().commit(ch, "Revert");
  FD().markFootprintSaved(E.kdoc, FD().serializeFootprintDoc(E.kdoc)); refreshTitle();
}

// ---------------------------------------------------------------- write back to the board
const bc: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kc-fpedit") : null;
/** This tab, as the board side of the channel names itself. */
const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let reqN = 0;
const waiting = new Map<string, { offer: (tab: string, ok: boolean, msg?: string) => void; reply: (ok: boolean, msg?: string) => void }>();
/**
 * A request to the board tabs: every board tab that could take it offers, the first that can is told to go, and only
 * that one applies it (KiCad has one board frame: two tabs of the same board must not both commit the update).
 */
function ask(msg: Record<string, unknown>, timeoutMs = 1200): Promise<{ ok: boolean; msg?: string } | null> {
  if (!bc) return Promise.resolve(null);
  const reqId = `${Date.now().toString(36)}-${++reqN}-${tabId}`;
  return new Promise((resolve) => {
    let chosen = false; let refusal: { ok: boolean; msg?: string } | null = null;
    const done = (r: { ok: boolean; msg?: string } | null) => { clearTimeout(t); waiting.delete(reqId); resolve(r); };
    const t = setTimeout(() => done(chosen ? { ok: false, msg: "The board did not answer." } : refusal), timeoutMs);
    waiting.set(reqId, {
      offer: (tab, ok, m) => { if (chosen) return; if (!ok) { refusal = { ok, msg: m }; return; } chosen = true; bc.postMessage({ type: "go", reqId, tabId: tab }); },
      reply: (ok, m) => done({ ok, msg: m }),
    });
    bc.postMessage(Object.assign({ reqId }, msg));
  });
}
/** Requests this board tab offered to take, until the footprint editor picks one tab. */
const offered = new Map<string, Record<string, unknown>>();

/** FOOTPRINT_EDIT_FRAME::SaveFootprintToBoard: ExchangeFootprint on the board, one "Update Footprint" step there. */
export async function saveToBoard(): Promise<boolean> {
  const cp = FP.board; if (!E.kdoc || !cp) return false;
  const text = FD().serializeFootprintDoc(E.kdoc);
  const msg = { type: "update", projectId: state.project!.projectId, boardDocId: cp.boardDocId, fpUuid: cp.fpUuid, text, uuidMap: cp.uuidMap };
  // a board tab that has the board open applies it there (its undo list gets the step)
  const r = await ask(msg);
  let ok = !!(r && r.ok);
  if (r && !r.ok) { toast(r.msg || "Unable to find the footprint on the main board.\nCannot save.", 5000); return false; }
  if (!r) {
    // nobody has the board open here: the same exchange against the live board, sent as one op
    try {
      const live = await liveDocument(cp.boardDocId);
      const bd = KiCadCanvas.parseDoc(live.file, "kicad_pcb");
      for (const op of live.ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(bd, c, 1e6); } catch { /* skip */ } }
      const ch = exchangeChange(bd, cp.fpUuid, text, cp.uuidMap);
      if (!ch) { toast("Unable to find the footprint on the main board.\nCannot save.", 5000); return false; }
      await sendDocOps(cp.boardDocId, [ch]); ok = true;
    } catch (e) { toast("The board could not be updated: " + ((e as Error).message || e), 5000); return false; }
  }
  if (ok) { cp.text = text; FD().markFootprintSaved(E.kdoc, text); refreshTitle(); setStatusBar({ message: `Footprint ${cp.reference} updated on the board` }); }
  return ok;
}

/** The board change ExchangeFootprint makes: the edited copy in place of the board's footprint. */
export function exchangeChange(board: KDoc, fpUuid: string, text: string, uuidMap: Record<string, string> | null): KChange | null {
  const it = board.items.get(fpUuid); if (!it || it.kind !== "footprint") return null;
  const ed = KiCadCanvas.parse(text); if (!ed) return null;
  const back = PT().exchange.boardCopyFromEditor(ed, uuidMap);
  // the board's footprint keeps its library id ("Lib:Name"): the editor only knew the item name
  const libId = str(it.node[1]); const colon = libId.indexOf(":"); const edName = str(back[1]);
  if (colon >= 0 && edName.indexOf(":") < 0) back[1] = libId.slice(0, colon + 1) + edName;
  const { node } = PT().exchange.exchangeFootprint(it.node, back);
  return PT().replacedChange(it, node);
}

/** The board tab's side: requests from footprint editor tabs of the same project (offer, then apply on "go"). */
if (bc) bc.onmessage = (ev: MessageEvent) => {
  const m = ev.data as Any; if (!m || typeof m !== "object") return;
  if (m.type === "offer") { const w = waiting.get(m.reqId); if (w) w.offer(String(m.tabId), !!m.ok, m.msg); return; }
  if (m.type === "reply") { const w = waiting.get(m.reqId); if (w) w.reply(!!m.ok, m.msg); return; }
  if (m.type === "go") {
    const req = offered.get(m.reqId); offered.delete(m.reqId);
    if (!req || m.tabId !== tabId) return;
    const reply = (ok: boolean, msg?: string) => bc.postMessage({ type: "reply", reqId: m.reqId, ok, msg });
    const r = req as Any;
    if (!E.kdoc) { reply(false, "No board currently open."); return; }
    if (r.type === "update") {
      const ch = exchangeChange(E.kdoc, r.fpUuid, r.text, r.uuidMap);
      if (!ch) { reply(false, "Unable to find the footprint on the main board.\nCannot save."); return; }
      toolCtx().commit([ch], "Update Footprint"); reply(true); return;
    }
    if (r.type === "insert") {
      reply(true); window.focus();
      W.KiCadLibrary.placeFootprint({ fpid: r.fpid, footprint: r.text }).catch(() => {});
    }
    return;
  }
  if (isFpEdit() || !E.kdoc || !state.project || m.projectId !== state.project.projectId) return;
  const offer = (ok: boolean, msg?: string) => { if (ok) { offered.set(m.reqId, m); setTimeout(() => offered.delete(m.reqId), 5000); } bc.postMessage({ type: "offer", reqId: m.reqId, tabId, ok, msg }); };
  if (m.type === "update" && state.docId === m.boardDocId) {
    if (E.viewOnly) { offer(false, "You can view this board but not change it"); return; }
    if (!E.kdoc.items.has(m.fpUuid)) { offer(false, "Unable to find the footprint on the main board.\nCannot save."); return; }
    offer(true); return;
  }
  if (m.type === "insert" && E.DOC_TYPE === "kicad_pcb") {
    if (E.viewOnly) { offer(false, "You can view this board but not change it"); return; }
    if (!W.KiCadLibrary || !W.KiCadLibrary.placeFootprint) { offer(false, "No board currently open."); return; }
    offer(true);
  }
};

/** PCB_ACTIONS::saveFpToBoard outside a board copy: "Insert footprint into PCB" in the open board. */
async function insertIntoBoard(): Promise<void> {
  if (!E.kdoc) return;
  if (isFpPrivate()) { await saveToBoard(); return; }
  const text = FD().serializeFootprintDoc(E.kdoc); const { lib, name } = fpLibIdOf(state.doc!.path);
  const r = await ask({ type: "insert", projectId: state.project!.projectId, fpid: `${lib}:${name}`, text });
  if (!r) { toast("No board currently open.", 3500); return; }
  if (!r.ok) toast(r.msg || "No board currently open.", 3500);
}

// ---------------------------------------------------------------- new footprint / save as / new library
function nowUuid(): string { return KiCadCanvas.newUuid(); }
/** CreateNewFootprint with BOARD_DESIGN_SETTINGS' defaults (REF** on F.SilkS, the value on F.Fab, ${REFERENCE} on F.Fab), as the file is written. */
export function newFootprintText(name: string, attr: string): string {
  const q = (s: string) => JSON.stringify(s);
  const eff = (t: number) => `(effects (font (size 1 1) (thickness ${t})))`;
  const field = (n: string, v: string, y: number, layer: string, t: number, hide: boolean) => `(property ${q(n)} ${q(v)} (at 0 ${y} 0) (layer ${q(layer)})${hide ? " (hide yes)" : ""} (uuid ${q(nowUuid())}) ${eff(t)})`;
  const src = `(footprint ${q(name)} (version ${NEW_FILE_VERSION}) (generator "pcbnew") (generator_version "10.0") (layer "F.Cu")`
    + ` ${field("Reference", "REF**", -0.5, "F.SilkS", 0.1, false)} ${field("Value", name, 1, "F.Fab", 0.15, false)}`
    + ` ${field("Datasheet", "", 0, "F.Fab", 0.15, true)} ${field("Description", "", 0, "F.Fab", 0.15, true)}`
    + (attr ? ` (attr ${attr})` : "")
    + ` (fp_text user "\${REFERENCE}" (at 0 2.5 0) (layer "F.Fab") (uuid ${q(nowUuid())}) ${eff(0.15)}) (embedded_fonts no))`;
  return FD().prettify(src);
}
/** A new .kicad_mod document holding `text` (snapshot 0), then opened. */
async function createFootprintDoc(lib: FpLib, name: string, text: string): Promise<DocEntry | null> {
  const project = state.project!; const path = `${libFolder(lib)}/${name}.kicad_mod`;
  if (lib.footprints.some((f) => f.name === name)) { toast(`Footprint '${name}' already exists in library '${lib.name}'.`, 4000); return null; }
  let res: { docId?: string; path?: string; existing?: boolean };
  try { res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path, docType: "footprint" }) }); }
  catch (e) { toast("The footprint could not be created: " + ((e as Error).message || e), 4000); return null; }
  if (!res.docId) return null;
  if (res.existing) { toast(`Footprint '${name}' already exists in library '${lib.name}'.`, 4000); return null; }
  const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
  if (!r.ok) { toast("The footprint could not be saved", 4000); return null; }
  const entry: DocEntry = { docId: res.docId, path: res.path || path, docType: "footprint" };
  project.docs.push(entry); store.set({ project: Object.assign({}, project) });
  return entry;
}
function openFootprintDoc(docId: string): void {
  const url = `/p/${state.project!.projectId}/edit?fp=${encodeURIComponent(docId)}`;
  if (location.pathname + location.search === url) return;
  history.pushState(null, "", url);
  window.dispatchEvent(new CustomEvent("kc-fpedit-open", { detail: { docId } }));
}
/** PCB_BASE_FRAME::GetLibraryItemsForListDialog: Library / Description rows, by StrNumCmp. */
function libraryRows(): string[][] {
  const descr = new Map((libTableCache ? libTableCache.rows : []).map((r) => [r.name, r.descr]));
  return projectFpLibs().map((l) => [l.name, descr.get(l.name) || ""]).sort((a, b) => PT().pad.strNumCmp(a[0], b[0]));
}
/** Characters a footprint name cannot hold (FOOTPRINT::StringLibNameInvalidChars( false )). */
const FP_NAME_INVALID = "\\/:\"*?<>|\t\n\r";
/**
 * PCB_BASE_EDIT_FRAME::SelectLibrary: EDA_LIST_DIALOG of the libraries (Library / Description) with "New Library...",
 * which makes one and shows the list again with it selected.
 */
async function pickLibrary(title: string, listLabel = "Save in library:", preselect?: string): Promise<FpLib | null> {
  const cur = preselect || (state.doc && state.doc.docType === "footprint" && !isFpPrivate() ? fpLibIdOf(state.doc.path).lib : "");
  if (!projectFpLibs().length) { toast("Please create a library first (File > New Library...)", 4000); return null; }
  return new Promise((resolve) => {
    let api: Any = null;
    api = listDialog(title, ["Library", "Description"], libraryRows(), (row) => resolve(projectFpLibs().find((l) => l.name === row[0]) || null), {
      select: cur, width: 520, listLabel,
      extra: [{ label: "New Library...", fn: () => { if (api) api.close(); newLibrary().then((nick) => pickLibrary(title, listLabel, nick || cur).then(resolve)); } }],
    });
    if (!api) resolve(null);
  });
}
async function newFootprint(): Promise<void> {
  if (E.viewOnly || !state.project) { toast("You can view this project but not change it"); return; }
  await libTableRows();
  const lib = await pickLibrary("New Footprint"); if (!lib) return;
  let name = "Untitled"; const base = name; let i = 1; while (lib.footprints.some((f) => f.name === name)) name = `${base}_${i++}`;
  // attributes from the library's last footprint, as CreateNewFootprint infers them (else SMD)
  let attr = "smd";
  const last = lib.footprints[lib.footprints.length - 1];
  if (last) { try { const r = await fetch(`/api/docs/${last.docId}/content`, { credentials: "same-origin" }); const t = r.ok ? KiCadCanvas.parse(await r.text()) : null; const a = t && KiCadCanvas.kid(t, "attr"); attr = a ? a.slice(1).map(str).join(" ") : ""; } catch { /* SMD */ } }
  const d = await createFootprintDoc(lib, name, newFootprintText(name, attr)); if (!d) return;
  publishLibs(); openFootprintDoc(d.docId);
}
/** FOOTPRINT_EDIT_FRAME::SaveFootprintAs: SAVE_AS_DIALOG (Name, "Save in library:", New Library..., Save). */
async function saveAs(preselect?: string): Promise<void> {
  if (!E.kdoc || E.viewOnly || !state.project) return;
  await libTableRows();
  if (FP.padEdit) exitPadEditMode();
  const cur = FD().footprintName(E.kdoc);
  const curLib = preselect || (!isFpPrivate() && state.doc ? fpLibIdOf(state.doc.path).lib : "");
  let api: Any = null;
  api = listDialog("Save Footprint As", ["Library", "Description"], libraryRows(), () => { /* onOk below */ }, {
    select: curLib, width: 520, listLabel: "Save in library:", okLabel: "Save",
    name: { label: "Name:", value: cur, invalidChars: FP_NAME_INVALID },
    extra: [{ label: "New Library...", fn: () => { if (api) api.close(); newLibrary().then((nick) => saveAs(nick || curLib)); } }],
    validate: async (row, name) => {
      if (!row) { await messageBoxAsync("A library must be specified."); return false; }
      if (!name) { await messageBoxAsync("Footprint must have a name."); return false; }
      const lib = projectFpLibs().find((l) => l.name === row[0]); if (!lib) return false;
      const existing = lib.footprints.find((f) => f.name === name);
      if (existing) {
        if (!(await confirmBox("Confirmation", `Footprint ${name} already exists in ${lib.name}.`, "Overwrite"))) return false;
        if (existing.docId === state.docId) return true;
        return deleteFootprintDoc(existing.docId, true);
      }
      return true;
    },
    onOk: (row, name) => { void saveAsTo(row ? row[0] : "", name, cur); },
  });
}
/** wxMessageBox: the themed message box over the dialog, resolved when it is dismissed. */
function messageBoxAsync(msg: string): Promise<void> { return new Promise((r) => { if (!messageBox("Message", msg, [{ label: "OK", fn: () => r() }])) { toast(msg, 4000); r(); } }); }
async function saveAsTo(libName: string, name: string, oldName: string): Promise<void> {
  const lib = projectFpLibs().find((l) => l.name === libName); if (!lib || !E.kdoc) return;
  const tree = KiCadCanvas.parse(FD().serializeFootprintDoc(E.kdoc))!; tree[1] = name;
  // SaveFootprintAs: a value that named the footprint follows the new name
  for (const c of tree) if (Array.isArray(c) && c[0] === "property" && c[1] === "Value" && c[2] === oldName) c[2] = name;
  const same = lib.footprints.find((f) => f.name === name && f.docId === state.docId);
  if (same) { await saveFootprint(); return; }
  // uuids stay the footprint's own: KiCad's Save As writes the same footprint under the new name
  const d = await createFootprintDoc(lib, name, FD().prettify(KiCadCanvas.serialize(tree))); if (!d) return;
  setStatusBar({ message: `Footprint '${name}' saved in library '${lib.name}'.` });
  publishLibs(); openFootprintDoc(d.docId);
}
/** ACTIONS::newLibrary: a <name>.pretty row in the project's fp-lib-table (the folder appears with its first footprint). */
async function newLibrary(): Promise<string | null> {
  if (E.viewOnly || !state.project) { toast("You can view this project but not change it"); return null; }
  const name = await promptText("New Footprint Library", "Library name:", ""); if (!name) return null;
  const nick = name.trim().replace(/\.pretty$/i, "");
  if (!nick || /[\\/:"*?<>|]/.test(nick)) { toast("Library name contains illegal characters", 4000); return null; }
  const rows = await libTableRows(true);
  if (rows.some((r) => r.name === nick) || projectFpLibs().some((l) => l.name === nick)) { toast(`Library '${nick}' already exists.`, 4000); return null; }
  let d = libTableDoc(); let text = "";
  if (d) { try { const live = await liveDocument(d.docId); text = live.file; } catch { const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); text = r.ok ? await r.text() : ""; } }
  else {
    const res = await api(`/api/projects/${state.project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: "fp-lib-table" }) }) as { docId?: string; path?: string; docType?: string };
    if (!res.docId) { toast("The library table could not be created"); return null; }
    d = { docId: res.docId, path: res.path || "fp-lib-table", docType: res.docType || "lib_table" }; state.project.docs.push(d);
  }
  // FP_LIB_TABLE::Format through Prettify's library-table mode: one row per line, the existing rows untouched
  const row = `(lib (name ${JSON.stringify(nick)}) (type "KiCad") (uri ${JSON.stringify("${KIPRJMOD}/" + nick + ".pretty")}) (options "") (descr ""))`;
  let out: string;
  if (text.trim()) {
    const at = text.lastIndexOf(")"); const m = /\n([ \t]*)\(lib /.exec(text); const indent = m ? m[1] : "\t";
    out = text.slice(0, at).replace(/\s*$/, "") + "\n" + indent + row + "\n)\n";
  } else out = FD().prettify(`(fp_lib_table (version 7) ${row})`, "libraryTable");
  // a new table has no snapshot to join yet: its first content is snapshot 0
  const ok = text.trim() ? await saveTextDocument(d.docId, out, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE_FILE", properties: [{ name: "text", after: { type: "string", v: out } }] })
    : (await fetch(`/api/docs/${d.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: out })).ok;
  if (!ok) { toast("The library table could not be saved", 4000); return null; }
  libTableCache = { docId: d.docId, rows: parseLibTable(out) }; publishLibs();
  setStatusBar({ message: `Library '${nick}' added to the project library table` });
  return nick;
}

/** FOOTPRINT_EDIT_FRAME::DeleteFootprintFromLibrary: the document goes (DELETE /api/docs/{id}) after a themed confirmation. */
async function deleteFootprint(docId: string): Promise<void> { await deleteFootprintDoc(docId, false); }
/** The document goes; `confirmed` skips the question (Footprint Properties' Overwrite already asked). */
async function deleteFootprintDoc(docId: string, confirmed: boolean): Promise<boolean> {
  const project = state.project; if (!project || E.viewOnly) return false;
  const d = project.docs.find((x) => x.docId === docId); if (!d) return false;
  const { lib, name } = fpLibIdOf(d.path);
  if (!confirmed && !(await confirmBox("Confirmation", `Delete footprint '${name}' from library '${lib}'?`, "Delete"))) return false;
  const r = await fetch(`/api/docs/${docId}`, { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) { toast(r.status === 404 || r.status === 405 ? "This server cannot delete files yet" : `Footprint '${name}' could not be deleted`, 4000); return false; }
  project.docs = project.docs.filter((x) => x.docId !== docId); store.set({ project: Object.assign({}, project) });
  publishLibs(); setStatusBar({ message: `Footprint '${name}' deleted from library '${lib}'` });
  if (state.docId === docId) { const next = projectFpLibs().flatMap((l) => l.footprints)[0]; if (next) openFootprintDoc(next.docId); else location.href = `/p/${project.projectId}/edit`; }
  return true;
}
/** PCB_ACTIONS::renameFootprint: the file moves (PATCH /api/docs/{id} {path}) and the footprint takes the name. */
async function renameFootprint(docId: string): Promise<void> {
  const project = state.project; if (!project || E.viewOnly) return;
  const d = project.docs.find((x) => x.docId === docId); if (!d) return;
  const { lib, name } = fpLibIdOf(d.path);
  const next = await promptText("Rename Footprint", "New name:", name); if (!next || next.trim() === name) return;
  const clean = next.trim(); if (/[\\/:"*?<>|]/.test(clean)) { toast("Footprint name contains illegal characters", 4000); return; }
  if (projectFpLibs().some((l) => l.name === lib && l.footprints.some((f) => f.name === clean))) { toast(`Footprint '${clean}' already exists in library '${lib}'.`, 4000); return; }
  const path = d.path.split("/").slice(0, -1).concat(clean + ".kicad_mod").join("/");
  const r = await fetch(`/api/docs/${docId}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  if (!r.ok) { toast(r.status === 404 || r.status === 405 ? "This server cannot rename files yet" : `Footprint '${name}' could not be renamed`, 4000); return; }
  d.path = path; store.set({ project: Object.assign({}, project) });
  // the name inside the file follows: a header op on the open footprint (one undo step), else on the document itself
  if (state.docId === docId && E.kdoc) {
    const h = KiCadCanvas.parse(FD().footprintHeaderSexpr(E.kdoc))!; h[1] = clean;
    toolCtx().commit([{ id: "footprint", kind: "MODIFIED", typeName: "FOOTPRINT", sexpr: KiCadCanvas.serialize(h) }], "Rename Footprint");
    if (state.doc) state.doc.path = path; refreshTitle();
  } else {
    try { const live = await liveDocument(docId); const fd = KiCadCanvas.parseDoc(live.file, "footprint"); for (const op of live.ops) for (const c of op.changes || []) KiCadCanvas.applyChange(fd, c, 1e6);
      const h = KiCadCanvas.parse(FD().footprintHeaderSexpr(fd))!; h[1] = clean; await sendDocOps(docId, [{ id: "footprint", kind: "MODIFIED", typeName: "FOOTPRINT", sexpr: KiCadCanvas.serialize(h) }]); } catch (e) { console.warn(e); }
  }
  publishLibs();
}
/** The Libraries pane's context menu. */
window.addEventListener("kc-fpedit-lib", ((ev: CustomEvent) => {
  const m = ev.detail || {}; if (!isFpEdit()) return;
  if (m.cmd === "delete" && m.docId) deleteFootprint(m.docId);
  else if (m.cmd === "rename" && m.docId) renameFootprint(m.docId);
  else if (m.cmd === "new") newFootprint();
  else if (m.cmd === "newLibrary") newLibrary();
}) as EventListener);

// ---------------------------------------------------------------- properties, pads, anchor
/** DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR (pcbdialogs/fp-editor.ts): every page; a rename onto an existing footprint asks to overwrite it. */
function footprintProperties(): void {
  const doc = E.kdoc as KDoc | null; if (!doc || !isFpEdit()) return;
  const lib = !isFpPrivate() && state.doc ? fpLibIdOf(state.doc.path).lib : "";
  const libFps = projectFpLibs().find((l) => l.name === lib);
  footprintPropertiesDialog(toolCtx() as unknown as ToolCtx, {
    libHas: (name: string) => !!libFps && libFps.footprints.some((f) => f.name === name && f.docId !== state.docId),
    overwrite: async (name: string) => { const f = libFps && libFps.footprints.find((x) => x.name === name); if (!f) return true; return deleteFootprintDoc(f.docId, true); },
    activeLayer: E.activeLayer || "F.Fab",
    textStyle: (layer: string) => { const st = (PT().TEXT_STYLE || {})[/^[FB]\.SilkS$/.test(layer) ? "silk" : /\.Cu$/.test(layer) ? "copper" : layer === "Edge.Cuts" ? "edges" : /^[FB]\.CrtYd$/.test(layer) ? "courtyard" : /^[FB]\.Fab$/.test(layer) ? "fab" : "others"] || [1, 0.15]; return { w: st[0], h: st[0], thick: st[1], italic: false }; },
    libName: lib,
  } as unknown as Parameters<typeof footprintPropertiesDialog>[1]);
}

/** PAD_TOOL::EnumeratePads: DIALOG_ENUM_PADS, then the click-each-pad tool (pcb-tools fp-enum-tool.ts). */
function enumeratePads(): void {
  const doc = E.kdoc as KDoc | null; if (!doc || !isFpEdit() || FP.padEdit) return;
  if (!Array.from(doc.items.values()).some((i) => i.kind === "pad")) return;
  if (E.viewOnly) { toast("You can view this project but not change it"); return; }
  enumPadsDialog((p) => { PT().setEnumParams(p); setTool("enumpads"); });
}

/** FOOTPRINT_EDITOR_CONTROL::CheckFootprint: the modeless Footprint Checker. */
function checkFootprint(): void { if (E.kdoc) footprintCheckerDialog(toolCtx() as unknown as ToolCtx); }

/** PAD_TOOL::PadTable. */
function padTable(): void { if (E.kdoc && !FP.padEdit) padTableDialog(toolCtx() as unknown as ToolCtx); }

/** The one selected pad (a pad item of the footprint), else null. */
function selectedPadId(): string | null {
  const doc = E.kdoc as KDoc | null; if (!doc) return null;
  const pcbSel = CollabTools.pcb && (CollabTools.pcb.state as unknown as { sel?: Set<string> }).sel;
  const ids = new Set<string>([...(E.selection as Set<string>), ...(pcbSel ? Array.from(pcbSel) : [])]);
  const pads = Array.from(ids).filter((id) => { const it = doc.items.get(id); return it && it.kind === "pad"; });
  return pads.length === 1 && ids.size === 1 ? pads[0] : null;
}
/** PAD_TOOL::pushPadSettings. */
function pushPadSettings(): void {
  const id = selectedPadId(); if (!id) { toast("Select a pad first"); return; }
  setStatusBar({ message: "" }); pushPadDialog(toolCtx() as unknown as ToolCtx, id);
}

/** PAD_TOOL::EditPad: Ctrl+E on a selected pad explodes it (pad edit mode); Ctrl+E again recombines it ("Edit Pad"). */
/** PAD_TOOL::ExitPadEditMode / RecombinePad: the shapes drawn on the pad's layer go back into the custom pad. */
function exitPadEditMode(): void {
  const doc = E.kdoc as KDoc | null; const id = FP.padEdit; if (!doc || !id) return;
  const ctx = toolCtx(); FP.padEdit = null;
  if (doc.items.has(id)) { const r = PT().fpPads.recombinePadChanges(doc, id); ctx.setSelection([]); if (r.changes.length) ctx.commit(r.changes, "Edit Pad"); }
  toast("", 1);
}
function editPad(): void {
  const doc = E.kdoc as KDoc | null; if (!doc || !isFpEdit() || E.viewOnly) return;
  const ctx = toolCtx();
  if (FP.padEdit) { exitPadEditMode(); return; }
  const id = selectedPadId(); if (!id) return;
  const it0 = doc.items.get(id);
  const ch = (PT().fpPads.explodePadChanges(doc, id) as KChange[]).filter((c) => !(c.kind === "MODIFIED" && c.id === id && it0 && c.sexpr === PT().wrapBoard(it0.node)));   // an unchanged pad is no step (an empty BOARD_COMMIT)
  if (ch.length) ctx.commit(ch, "Edit Pad");
  ctx.setSelection([]); const pcbSel = CollabTools.pcb && (CollabTools.pcb.state as unknown as { sel?: Set<string> }).sel; if (pcbSel) pcbSel.clear();
  FP.padEdit = id;
  const it = doc.items.get(id); if (it) E.activeLayer = PT().fpPads.principalLayer(it.node);
  toast("Pad Edit Mode.  Press Ctrl+E again to exit.", 24 * 3600 * 1000);
}
/** Somebody saved this footprint (the server's "saved" notice): the saved file is what this copy compares against,
 *  so the '*' goes when the copy here is that file (KiCad's library cache follows the file in the same way). */
window.addEventListener("kc-doc-saved", ((ev: CustomEvent) => {
  const m = ev.detail as { savedDocId?: string; seq?: number } | null;
  if (!m || !m.savedDocId || m.savedDocId !== state.docId || !isFpEdit() || isFpPrivate() || typeof m.seq !== "number") return;
  const seq = m.seq; if (seq < FP.snapSeq) return;
  void (async () => {
    let text = ""; try { const r = await fetch(`/api/docs/${m.savedDocId}/snapshots/${seq}`, { credentials: "same-origin" }); if (r.ok) text = await r.text(); } catch { return; }
    if (!text || !E.kdoc || state.docId !== m.savedDocId) return;
    FD().markFootprintSaved(E.kdoc, text); FP.snapSeq = Math.max(FP.snapSeq, seq); refreshTitle();
  })();
}) as EventListener);
commitObservers.push((phase) => { if (phase === "after" && FP.padEdit && E.kdoc && !E.kdoc.items.has(FP.padEdit)) { FP.padEdit = null; toast("", 1); } });

/** FOOTPRINT_EDIT_FRAME::ExportFootprint: the .kicad_mod as KiCad writes it (PCB_IO_KICAD_SEXPR, Prettify). */
function exportFootprint(): void {
  if (!E.kdoc) return;
  const text = FD().serializeFootprintDoc(E.kdoc); const name = FD().footprintName(E.kdoc) || "footprint";
  saveBlob(new Blob([text], { type: "text/plain" }), `${name}.kicad_mod`);
  setStatusBar({ message: `Footprint exported to file '${name}.kicad_mod'.` });
}
/** FOOTPRINT_EDITOR_CONTROL::ExportFootprintAsSVG: every layer of the footprint, 1:1, in the editor's colours. */
function exportFootprintAsSVG(): void {
  if (!E.kdoc) return; const name = FD().footprintName(E.kdoc) || "footprint";
  const svg = KiCadCanvas.renderSvg(E.kdoc, { hidden: new Set<string>(), background: false, margin: 1 } as unknown as Record<string, unknown>);
  saveBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
}
/** EDA_DRAW_FRAME's "View as PNG" (SaveCanvasImageToFile): the canvas as it is on screen. */
function exportFootprintAsPNG(): void {
  if (!E.kdoc) return; const name = FD().footprintName(E.kdoc) || "footprint";
  const cv = document.querySelector("#stage canvas") as HTMLCanvasElement | null;
  if (cv && cv.toBlob) { cv.toBlob((b) => { if (b) saveBlob(b, `${name}.png`); else toast("Can't save file"); }, "image/png"); return; }
  KiCadCanvas.renderPng(E.kdoc, Object.assign({ hidden: E.hiddenLayers }, E.renderOpts) as unknown as Record<string, unknown>).then((b: Blob) => saveBlob(b, `${name}.png`)).catch(() => toast("Can't save file"));
}
function saveBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** FOOTPRINT_EDIT_FRAME::ImportFootprint: a .kicad_mod file into a library of the project (then opened). */
function importFootprint(): void {
  if (E.viewOnly || !state.project) { toast("You can view this project but not change it"); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".kicad_mod,.mod";
  inp.addEventListener("change", async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const text = await f.text(); const t = KiCadCanvas.parse(text);
    if (!t || (t[0] !== "footprint" && t[0] !== "module")) { toast(`File '${f.name}' is not a KiCad footprint file.`, 4000); return; }
    await libTableRows();
    const lib = await pickLibrary("Import Footprint"); if (!lib) return;
    const name = str(t[1]).split(":").pop() || f.name.replace(/\.kicad_mod$/i, "");
    const d = await createFootprintDoc(lib, name, text); if (!d) return;
    publishLibs(); openFootprintDoc(d.docId);
  });
  inp.click();
}

/** DIALOG_FOOTPRINT_USERS: the symbols of the project's symbol libraries (its *.kicad_sym documents, nicknamed by
 *  file name as the sym-lib-table rows of a project library are) that use this footprint. */
function showFootprintUsers(): void {
  if (!E.kdoc || !state.project) return;
  const name = FD().footprintName(E.kdoc); const lib = !isFpPrivate() && state.doc ? fpLibIdOf(state.doc.path).lib : "";
  const pads = new Set<string>(); let padCount = 0;
  for (const it of E.kdoc.items.values()) if (it.kind === "pad") { const n = str(it.node[1]); if (n && !pads.has(n)) { pads.add(n); padCount++; } }
  const project = state.project;
  footprintUsersDialog({ lib, name, padCount }, async () => {
    const docs = project.docs.filter((d) => /\.kicad_sym$/i.test(d.path));
    const out: { nickname: string; tree: SNode }[] = [];
    await Promise.all(docs.map(async (d) => {
      try { const r = await fetch(`/api/docs/${d.docId}/content`, { credentials: "same-origin" }); if (!r.ok) return; const t = KiCadCanvas.parse(await r.text()); if (t) out.push({ nickname: d.path.split("/").pop()!.replace(/\.kicad_sym$/i, ""), tree: t }); } catch { /* skipped */ }
    }));
    return out;
  });
}

/** PCB_ACTIONS::loadFpFromBoard: a board footprint (by reference) into the editor. */
let lastBoardPick = "";
async function loadFromBoard(): Promise<void> {
  const project = state.project; if (!project) return;
  const board = project.docs.find((d) => d.docType === "kicad_pcb"); if (!board) { toast("No board currently open.", 3500); return; }
  let file = "";
  try { file = (await liveDocument(board.docId)).file; } catch { const r = await fetch(`/api/docs/${board.docId}/content`, { credentials: "same-origin" }); file = r.ok ? await r.text() : ""; }
  if (!file) { toast("No board currently open.", 3500); return; }
  const bd = KiCadCanvas.parseDoc(file, "kicad_pcb");
  const fps = Array.from(bd.items.values()).filter((i) => i.kind === "footprint").map((i) => ({ id: i.id, ref: i.ref || "?" })).sort((a, b) => PT().pad.strNumCmp(a.ref, b.ref));
  if (!fps.length) { toast("The board has no footprints", 3500); return; }
  // FOOTPRINT_EDIT_FRAME::SelectFootprintFromBoard: EDA_LIST_DIALOG "Footprints [N items]", one "Footprint" column of references
  listDialog(`Footprints [${fps.length} items]`, ["Footprint"], fps.map((f) => [f.ref]), (row) => {
    const f = fps.find((x) => x.ref === row[0]); if (!f) return; lastBoardPick = f.ref;
    location.href = `/p/${project.projectId}/edit?fp=${encodeURIComponent(boardCopyId(board.docId, f.id))}`;
  }, { select: lastBoardPick });
}

/** PCB_ACTIONS::editFpInFpEditor (Ctrl+E on the board): the selected footprint in a Footprint Editor window. */
function editFpInFpEditor(): void {
  if (!E.kdoc || isFpEdit() || !state.project || !state.docId) return;
  let id = E.selected ? E.selected.id : null;
  if (!id) for (const s of E.selection) { const it = E.kdoc.items.get(s); if (it && it.kind === "footprint") { id = s; break; } }
  if (!id && E.lastCursorMm) { const mod = CollabTools.pcb as Any; const sel = mod && mod.requestSelection ? mod.requestSelection(toolCtx(), { locks: false }) : null; const f = sel && sel.items && sel.items.find((i: KItem) => i.kind === "footprint"); if (f) id = f.id; }
  const it = id ? E.kdoc.items.get(id) : null;
  if (!it || it.kind !== "footprint") { toast("Select a footprint first"); return; }
  window.open(`/p/${state.project.projectId}/edit?fp=${encodeURIComponent(boardCopyId(state.docId, it.id))}`, "_blank");
}

/** FOOTPRINT_EDIT_FRAME::OnCloseWindow: leaving a modified footprint asks first (themed, never the browser's). */
export async function canLeaveFootprint(): Promise<boolean> {
  if (!isFpEdit() || !E.kdoc || !FD().footprintModified(E.kdoc)) return true;
  if (!isFpPrivate()) return true;   // a library footprint's edits are already in its document for everyone; only Save makes the snapshot
  return confirmBox("Footprint Editor", `Save changes to '${FP.board ? FP.board.reference : ""}' before closing?`, "Discard Changes");
}

// ---------------------------------------------------------------- the handlers
const fpOnly = (fn: () => unknown): ActionHandler => () => { if (isFpEdit()) fn(); };
let installed = false;
/** Called once from editor/index.ts after every module has loaded (actions.ts and doc.ts import each other). */
let handlersRef: Record<string, ActionHandler> | null = null;
export function installFpEditHandlers(HANDLERS: Record<string, ActionHandler>): void {
  if (installed) return; installed = true; handlersRef = HANDLERS;
  const prevSave = HANDLERS.save; const prevRevert = HANDLERS.revert;
  Object.assign(HANDLERS, {
  save: ((a) => { if (isFpEdit()) { saveFootprint(); return; } prevSave(a); }) as ActionHandler,
  revert: ((a) => { if (isFpEdit()) { revertFootprint(); return; } if (prevRevert) prevRevert(a); }) as ActionHandler,
  saveAs: fpOnly(saveAs), newFootprint: fpOnly(newFootprint), newLibrary: fpOnly(newLibrary), footprintProperties: fpOnly(footprintProperties),
  enumeratePads: fpOnly(enumeratePads), checkFootprint: fpOnly(checkFootprint), padTable: fpOnly(padTable), pushPadSettings: fpOnly(pushPadSettings),
  explodePad: fpOnly(editPad), recombinePad: fpOnly(editPad), exportFootprint: fpOnly(exportFootprint), exportFootprintAsSVG: fpOnly(exportFootprintAsSVG), exportFootprintAsPNG: fpOnly(exportFootprintAsPNG),
  importFootprint: fpOnly(importFootprint), showFootprintUsers: fpOnly(showFootprintUsers), loadFpFromBoard: fpOnly(loadFromBoard), saveFpToBoard: fpOnly(insertIntoBoard),
  setAnchor: fpOnly(() => setTool("anchor")),
  showLibraryTree: fpOnly(() => showPane("libtree")),
  editFpInFpEditor: () => { if (!isFpEdit()) editFpInFpEditor(); },
  deleteFootprint: fpOnly(() => { if (state.docId && !isFpPrivate()) deleteFootprint(state.docId); }),
  renameFootprint: fpOnly(() => { if (state.docId && !isFpPrivate()) renameFootprint(state.docId); }),
  } as Record<string, ActionHandler>);
}

window.addEventListener("kc-fpedit-pick", ((ev: CustomEvent) => { const id = ev.detail && ev.detail.docId; if (id && isFpEdit() && id !== state.docId) openFootprintDoc(id); }) as EventListener);
/** The Libraries pane's click (and New Footprint / Save As) opens a footprint in place. */
window.addEventListener("kc-fpedit-open", ((ev: CustomEvent) => {
  const docId = ev.detail && ev.detail.docId; if (!docId || !state.project) return;
  const d = state.project.docs.find((x) => x.docId === docId); if (!d) return;
  import("./doc").then((m) => m.openDoc(d)).catch((e) => console.warn(e));
}) as EventListener);

export const fpEditApi = { doc: () => E.kdoc, ctx: () => toolCtx(), commit: (changes: KChange[], label?: string) => toolCtx().commit(changes, label), isFpEdit, isFpPrivate, saveFootprint, revertFootprint, saveToBoard, newFootprintText, parseLibTable, projectFpLibs, fpLibIdOf, exchangeChange, refreshTitle, FP,
  /** Run an editor action by id (as a menu item does). */
  undoLabels: () => undoStack.map((e) => e.label),
  action: (id: string) => { const h = handlersRef && handlersRef[id]; if (h) h(null); return !!h; } };
(window as unknown as { KiCadFpEdit?: typeof fpEditApi }).KiCadFpEdit = fpEditApi;
