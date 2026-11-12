// dialogs/sch-hierarchy — SCH_SHEET_LIST for the browser: every sheet instance of the project's schematic,
// from the root through each (sheet …) symbol, with the human-readable path ("/", "/Power/"), the page number
// its parent's instance data gives it, and the document, read once and given the drawing-sheet context
// (${SHEETPATH}, ${SHEETNAME}, ${#}, ${##}) eeschema would show on that page.  Sorted by page number like
// SCH_SHEET_LIST::SortByPageNumbers.  The open sheet is the live document, unsaved edits included.
import { E, appState, type DocEntry } from "./editor";
import { readDoc } from "./project";
import * as docMod from "../editor/doc";

export interface SheetInstance { docId: string; path: string; name: string; sheetPath: string; page: string; doc: KDoc; uuidPath: string[]; sheetItemId: string | null; parentDocId: string | null }

const rootSchematic = docMod.rootSchematic as () => DocEntry | undefined;
const projectTextVars = docMod.projectTextVars as () => Record<string, string> | null;
const ROOT_SHEET_NAME = docMod.ROOT_SHEET_NAME as string;

/** The sheet list (root first, then by page number). */
export async function sheetList(): Promise<SheetInstance[]> {
  const S = appState as unknown as { docs: DocEntry[]; docId: string | null; project: { name: string } | null };
  const root = rootSchematic(); if (!root) return [];
  const cache = new Map<string, KDoc>();
  const load = async (d: DocEntry): Promise<KDoc> => {
    if (d.docId === S.docId && E.kdoc) return E.kdoc;
    let doc = cache.get(d.docId); if (!doc) { doc = await readDoc(d.docId, "kicad_sch"); cache.set(d.docId, doc); }
    return doc;
  };
  const out: SheetInstance[] = [];
  const walk = async (d: DocEntry, name: string, sheetPath: string, page: string, uuidPath: string[], sheetItemId: string | null, parentDocId: string | null, depth: number): Promise<void> => {
    if (depth > 32) return;   // a recursive hierarchy: KiCad refuses it, we stop
    let doc: KDoc; try { doc = await load(d); } catch (e) { return; }
    out.push({ docId: d.docId, path: d.path, name, sheetPath, page, doc, uuidPath, sheetItemId, parentDocId });
    const dir = d.path.split("/").slice(0, -1).join("/");
    for (const m of KiCadCanvas.movableItems(doc)) {
      if (m.kind !== "sheet" || !m.file) continue;
      const rel = dir ? `${dir}/${m.file}` : m.file;
      const child = S.docs.find((x) => x.docType === "kicad_sch" && x.path === rel) || S.docs.find((x) => x.docType === "kicad_sch" && x.path.split("/").pop() === m.file!.split("/").pop());
      if (!child) continue;
      const nm = m.name || m.file.replace(/\.kicad_sch$/, "");
      await walk(child, nm, sheetPath + nm + "/", m.page || "", uuidPath.concat(m.id), m.id, d.docId, depth + 1);
    }
  };
  await walk(root, ROOT_SHEET_NAME, "/", String((E.kdoc && S.docId === root.docId ? (E.kdoc as KDoc & { pageNumber?: string }).pageNumber : "") || "1"), [], null, null, 0);
  // pages without a number keep their place after the numbered ones
  const num = (p: string): number => { const n = parseInt(p, 10); return isFinite(n) ? n : Infinity; };
  const rest = out.slice(1).map((s, i) => ({ s, i })).sort((a, b) => num(a.s.page) - num(b.s.page) || a.i - b.i).map((x) => x.s);
  const list = [out[0], ...rest];
  list.forEach((s, i) => { if (!s.page) s.page = String(i + 1); });
  return list;
}

/** A copy of an instance's document with the drawing-sheet context of that page (the live one is not touched). */
export function withSheetContext(s: SheetInstance, count: number): KDoc {
  const S = appState as unknown as { project: { name: string } | null };
  const d = Object.create(s.doc) as KDoc & Record<string, unknown>;
  d.fileName = s.path.split("/").pop(); d.filePath = s.path; d.projectName = S.project ? S.project.name : "";
  d.projectVars = projectTextVars(); d.sheetName = s.name; d.sheetPath = s.sheetPath; d.sheetCount = count; d.pageNumber = s.page;
  return d;
}
