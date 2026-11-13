// panels/hierarchy.ts — the Schematic Hierarchy navigator's model (eeschema/widgets/hierarchy_pane.cpp): the
// tree of sheets with their names and page numbers.  eeschema has every sheet loaded; the browser has one
// document open, so the other sheet files are read (and cached, parsed) to follow their (sheet …) symbols.
// The same cache gives the Search pane its other sheets.  Rename / Edit Page Number edit the sheet symbol in
// the PARENT sheet — where KiCad keeps the Sheetname field and the instance's page — as an ordinary op.
import type { HierNode, PanelAction } from "../../panels-api";
import { store } from "../appstore";
import { openDoc, rootSchematic } from "../doc";
import { E } from "../state";
import { toast } from "../util";
import { selectionIds } from "../gestures";
import { KC, currentDocId, isSchDoc, kdoc, openDocs, panelStore, projectId, projectName, textEntry, type DocEntryLite, tctx } from "./core";

interface SheetRef { id: string; name: string; file: string; page: string }
interface SheetDoc { doc: KDoc; sheets: SheetRef[]; page: string }

const cache = new Map<string, SheetDoc>();   // docId -> parsed sheet (not the open one: that is always read live)
let cacheProject = "";
let loading: Promise<void> | null = null;
let live: { docId: string; doc: KDoc } | null = null;   // the sheet on screen, as last read: kept when another sheet opens

function sheetsOf(doc: KDoc): SheetRef[] {
  const out: SheetRef[] = [];
  for (const m of KC().movableItems(doc)) if (m.kind === "sheet" && m.file) out.push({ id: m.id, name: m.name || "", file: m.file, page: String((m as { page?: string }).page || "") });
  return out;
}
function entry(docId: string): SheetDoc | null {
  if (docId === currentDocId()) { const d = kdoc(); if (!d || !isSchDoc()) return null; live = { docId, doc: d }; return { doc: d, sheets: sheetsOf(d), page: String((d as unknown as { pageNumber?: string }).pageNumber || "1") }; }
  return cache.get(docId) || null;
}
/** A parsed sheet of the project by document id (the open one live, the others from the cache). */
export function sheetDoc(docId: string): KDoc | null { const e = entry(docId); return e ? e.doc : null; }
export function schDocs(): DocEntryLite[] { return openDocs().filter((d) => d.docType === "kicad_sch"); }

/** Read the sheets that are not open (again after `stale`), then rebuild the tree. */
export function loadSheets(stale?: string | null): Promise<void> {
  if (cacheProject !== projectId()) { cache.clear(); cacheProject = projectId(); }
  if (stale) {   // the sheet that was just left: what was on screen is newer than what the server would send back right now
    if (live && live.docId === stale && stale !== currentDocId()) cache.set(stale, { doc: live.doc, sheets: sheetsOf(live.doc), page: String((live.doc as unknown as { pageNumber?: string }).pageNumber || "1") });
    else cache.delete(stale);
  }
  const want = schDocs().filter((d) => d.docId !== currentDocId() && !cache.has(d.docId));
  if (!want.length) { publishHierarchy(); return Promise.resolve(); }
  if (loading) return loading;
  const pid = projectId();
  loading = Promise.all(want.map(async (d) => {
    try {
      const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`); if (!r.ok) return;
      const doc = KC().parseDoc(await r.text(), "kicad_sch");
      if (pid === projectId()) cache.set(d.docId, { doc, sheets: sheetsOf(doc), page: String((doc as unknown as { pageNumber?: string }).pageNumber || "1") });
    } catch (e) { /* unreadable sheet: it shows without children */ }
  })).then(() => { loading = null; publishHierarchy(); });
  return loading;
}

function resolveChild(parent: DocEntryLite, file: string): DocEntryLite | null {
  const dir = parent.path.split("/").slice(0, -1).join("/"), rel = dir ? `${dir}/${file}` : file, base = file.split("/").pop();
  const docs = schDocs();
  return docs.find((d) => d.path === rel || d.path === file) || docs.find((d) => d.path.split("/").pop() === base) || null;
}

function build(): HierNode | null {
  const root = (store.get().project ? rootSchematic() : null) as DocEntryLite | null; if (!root) return null;
  const cur = currentDocId();
  const rootEntry = entry(root.docId);
  const stem = root.path.split("/").pop()!.replace(/\.kicad_sch$/, "");
  const walk = (doc: DocEntryLite, path: string, depth: number): HierNode[] => {
    const e = entry(doc.docId); if (!e || depth > 8) return [];
    return e.sheets.map((sh) => {
      const child = resolveChild(doc, sh.file); const p = path + sh.id + "/";
      return { path: p, name: sh.name || sh.file.replace(/\.kicad_sch$/, ""), page: sh.page, docId: child ? child.docId : null, file: sh.file, parentDocId: doc.docId, sheetId: sh.id,
        current: !!child && child.docId === cur, children: child ? walk(child, p, depth + 1) : [] };
    });
  };
  // the project root itself is hidden (wxTR_HIDE_ROOT): the tree starts at the top-level sheet, named by its file
  // when it has no sheet name (HIERARCHY_PANE::UpdateHierarchyTree)
  return { path: "/", name: stem || projectName() || "Schematic", page: rootEntry ? rootEntry.page : "1", docId: root.docId, file: root.path.split("/").pop() || "", parentDocId: null, sheetId: null,
    current: root.docId === cur, children: walk(root, "/", 0) };
}

export function publishHierarchy(): void {
  let root: HierNode | null = null;
  try { root = build(); } catch (e) { console.warn(e); }
  panelStore.set({ hierarchy: { root, version: panelStore.get().hierarchy.version + 1 } });
}

function find(path: string): HierNode | null {
  const walk = (n: HierNode | null): HierNode | null => { if (!n) return null; if (n.path === path) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
  return walk(panelStore.get().hierarchy.root);
}

/** The page number each hierarchy path carries, by document id (the Search pane's Page column). */
export function pageOfDoc(docId: string): string {
  const walk = (n: HierNode | null): string | null => { if (!n) return null; if (n.docId === docId) return n.page; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
  return walk(panelStore.get().hierarchy.root) || "";
}

/** Edit a sheet symbol where it lives: open its parent sheet if another one is on screen, then commit. */
async function editSheetSymbol(node: HierNode, label: string, edit: (n: SNode) => boolean | void): Promise<void> {
  if (!node.parentDocId || !node.sheetId) return;
  if (E.viewOnly) { toast("View-only access"); return; }
  if (currentDocId() !== node.parentDocId) {
    const parent = schDocs().find((d) => d.docId === node.parentDocId); if (!parent) return;
    await openDoc(parent);
  }
  const doc = kdoc(), it = doc ? doc.items.get(node.sheetId) : null;
  if (!doc || !it) { toast("That sheet is not on this page any more"); return; }
  const n = KC().cloneNode(it.node);
  if (edit(n) === false) return;
  tctx().commit([KC().replaceChange(doc, Object.assign({}, it, { node: n, geom: [], bbox: null }))], label);
  publishHierarchy();
}

function setSheetName(n: SNode, name: string): boolean {
  const K = KC();
  for (const p of K.kids(n, "property")) if (K.str(p[1]) === "Sheetname" || K.str(p[1]) === "Sheet name") { if (K.str(p[2]) === name) return false; p[2] = name; return true; }
  return false;
}
function setSheetPage(n: SNode, page: string): boolean {
  const K = KC(); const inst = K.kid(n, "instances"); if (!inst) return false;
  let changed = false;
  for (const proj of K.kids(inst, "project")) for (const path of K.kids(proj, "path")) {
    const pg = K.kid(path, "page");
    if (pg) { if (K.str(pg[1]) !== page) { pg[1] = page; changed = true; } } else { path.push(["page", page]); changed = true; }
  }
  return changed;
}

async function rename(path: string): Promise<void> {
  const node = find(path); if (!node || !node.sheetId) return;
  const name = await textEntry("Rename", "Change name of this sheet", node.name); if (name === null) return;
  const nm = name.trim(); if (!nm || nm === node.name) return;
  await editSheetSymbol(node, "renaming sheet", (n) => setSheetName(n, nm));
}
async function editPage(path: string): Promise<void> {
  const node = find(path); if (!node) return;
  if (!node.sheetId) { toast("The root sheet's page number is set in the desktop app"); return; }
  // SCH_SHEET_PATH::PathHumanReadable( false ): the root file's stem, then each sheet name, each closed by '/'
  const root = panelStore.get().hierarchy.root, stem = root ? root.file.replace(/\.kicad_sch$/, "") : "";
  const human = stem + "/" + namesTo(path).map((n) => n + "/").join("");
  const page = await textEntry("Edit Sheet Page Number", `Enter page number for sheet path${human.length > 20 ? "\n" + human : " " + human}`, node.page); if (page === null) return;
  const pg = page.trim(); if (!pg || pg === node.page) return;
  await editSheetSymbol(node, "change sheet page number", (n) => setSheetPage(n, pg));
}
/**
 * SCH_EDIT_TOOL::EditPageNumber (Edit > Edit Sheet Page Number..., the sheet context menu): the selected sheet's
 * instance under the sheet on screen, else the sheet on screen itself; nothing for more than one selected item.
 */
export function editPageNumber(): boolean {
  const doc = kdoc(); if (!doc || !isSchDoc()) return false;
  const ids = new Set<string>(selectionIds());
  if (ids.size > 1) return true;
  const cur = currentDocId(), sel = [...ids].map((id) => doc.items.get(id)).find((it) => it && it.kind === "sheet");
  if (ids.size === 1 && !sel) return true;
  const walk = (n: HierNode | null, ok: (x: HierNode) => boolean): HierNode | null => { if (!n) return null; if (ok(n)) return n; for (const c of n.children) { const r = walk(c, ok); if (r) return r; } return null; };
  const root = panelStore.get().hierarchy.root;
  const node = sel ? walk(root, (x) => x.sheetId === sel.id && x.parentDocId === cur) : walk(root, (x) => x.current);
  if (node) void editPage(node.path);
  return true;
}
function namesTo(path: string): string[] {
  const out: string[] = [];
  const walk = (n: HierNode, acc: string[]): boolean => { if (n.path === path) { out.push(...acc); return true; } for (const c of n.children) if (walk(c, acc.concat(c.name))) return true; return false; };
  const root = panelStore.get().hierarchy.root; if (root) walk(root, []);
  return out;
}

export function hierarchyDispatch(a: PanelAction): boolean {
  switch (a.t) {
    case "hierOpen": { const n = find(a.path); if (!n) return true; if (!n.docId) { toast("That sheet isn't in the shared project yet"); return true; } if (n.docId !== currentDocId()) { const d = schDocs().find((x) => x.docId === n.docId); if (d) void openDoc(d); } return true; }
    case "hierRename": void rename(a.path); return true;
    case "hierPage": void editPage(a.path); return true;
    default: return false;
  }
}
