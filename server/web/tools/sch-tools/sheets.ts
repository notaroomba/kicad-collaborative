import type { SchCtx, Pt, SAtom, SheetJob } from "./types";
import { root } from "../root";
import { promptImpl } from "./dom";
import { sheetNode, sheetPinNode } from "./nodes";
import { rememberPlaced } from "./repeat";
import { mmPerPx } from "./snap";
import { K, S, atOf, kid, kids, num, str } from "./state";
import { addNode, deep, modChange, r4, segDist } from "./util";

// ---------------------------------------------------------------- hierarchical sheets (the sheet file lives on the server first)
export const SHEET_EXT = ".kicad_sch";
export const baseName = (p: SAtom | undefined) => str(p).split("/").pop()!;   // split always yields one part
export const dirName = (p: SAtom | undefined) => { const s = str(p).split("/"); s.pop(); return s.join("/"); };
export const joinPath = (dir: string, file: string) => dir ? dir + "/" + file : file;
// Relative path from directory `dir` to `path` (both project-relative, "/" separated) — what Sheetfile holds.
export function relPath(dir: string, path: string) {
  const a = dir ? dir.split("/") : [], b = path.split("/"); let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
export function schDocs(ctx: SchCtx) { return (ctx.docs || []).filter((d) => d && d.docType === "kicad_sch"); }
// The schematic doc being edited: ctx.docId when the app says, else the project's root sheet.
export function currentDoc(ctx: SchCtx) {
  const docs = schDocs(ctx);
  if (ctx.docId) { const d = docs.find((x) => x.docId === ctx.docId); if (d) return d; }
  if (ctx.docPath) return { path: ctx.docPath };
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro"), stem = pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : null;
  return (stem && docs.find((d) => baseName(d.path) === stem + SHEET_EXT)) || docs.slice().sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.length - y.path.length)[0] || null;
}
export function normSheetFile(file: string) { file = str(file).trim().replace(/\\/g, "/").replace(/^\/+/, ""); if (!file) return ""; if (!/\.kicad_sch$/i.test(file)) file += SHEET_EXT; return file; }
export function sheetFileFor(name: string) { return normSheetFile(str(name).trim().replace(/[\\/:*?"<>|]+/g, "_")); }
export function emptySheetDoc() { return `(kicad_sch (version 20250114) (generator "kicad-collab-web") (generator_version "9.0") (uuid "${K.newUuid()}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))\n`; }
// Reference the project doc for a sheet file, creating it (POST …/docs, then snapshot 0) when there is none.
export async function ensureSheetDoc(ctx: SchCtx, file: string) {
  file = normSheetFile(file); if (!file) throw new Error("no sheet file name");
  const cur = currentDoc(ctx), dir = cur ? dirName(cur.path) : "", target = joinPath(dir, file);
  const found = schDocs(ctx).find((d) => d.path === target || d.path === file) || schDocs(ctx).find((d) => baseName(d.path) === baseName(file));
  if (found) return { file: relPath(dir, found.path), docId: found.docId, created: false };
  if (typeof ctx.api !== "function" || !ctx.project || !ctx.project.projectId) throw new Error("this session cannot create sheet files");
  // the server's reply: the new (or existing) document's id and path
  const res = (await ctx.api(`/api/projects/${ctx.project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: target, docType: "kicad_sch" }) })) as { docId?: string; path?: string; existing?: boolean } | null;
  if (!res || !res.docId) throw new Error("no document id returned");
  if (!res.existing) await ctx.api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" }, body: emptySheetDoc() });
  const entry = { docId: res.docId as string, path: res.path || target, docType: "kicad_sch" };
  if (Array.isArray(ctx.docs) && !ctx.docs.some((d) => d && d.docId === entry.docId)) ctx.docs.push(entry);
  return { file, docId: entry.docId, created: !res.existing };
}
// The sheet path and project name this screen's symbols and sheets record in their instance data:
// a sheet's instance path is the path of the sheet *containing* it, the same path its symbols use.
export function sheetPathHere(doc: KDoc) {
  const paths = new Map<string, number>(), names = new Map<string, number>(), vote = (m: Map<string, number>, k: string) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) { vote(names, str(pr[1])); for (const pa of kids(pr, "path")) vote(paths, str(pa[1])); }
  }
  const top = (m: Map<string, number>) => { let best: string | null = null, bn = 0; for (const [k, n] of m) if (n > bn) { bn = n; best = k; } return best; };
  return { path: top(paths), project: top(names) };
}
// Next free page: the project's sheet count (root is page 1), bumped past the pages used on this screen.
export function nextPage(ctx: SchCtx, doc: KDoc) {
  const used = new Set(["1"]);
  for (const it of doc.items.values()) if (it.kind === "sheet") for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const pg = kid(pa, "page"); if (pg) used.add(str(pg[1])); }
  let n = Math.max(2, schDocs(ctx).length);
  while (used.has(String(n))) n++;
  return n;
}
export function sheetInstance(ctx: SchCtx, doc: KDoc, page: number) {
  const { path, project } = sheetPathHere(doc);
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro");
  const name = project || (pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : "") || (ctx.project && ctx.project.name) || "";
  if (!path || !name) return null;
  return ["instances", ["project", name, ["path", path, ["page", String(page)]]]];
}
// Place a sheet: make sure its file is a project doc, then commit the sheet node.  One at a time;
// clicks are ignored while the request is out, and a document switch drops the result.
export function placeSheet(ctx: SchCtx, a: Pt, b: Pt, name: string, file: string) {
  if (S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return S.sheetJob.promise; }
  const doc = ctx.doc, job: SheetJob = { doc, promise: null }; S.sheetJob = job;
  job.promise = (async () => {
    try {
      const ref = await ensureSheetDoc(ctx, normSheetFile(file));
      if (S.sheetJob !== job || ctx.doc !== doc) return null;
      const node = sheetNode(a, b, name, ref.file);
      const inst = sheetInstance(ctx, doc, nextPage(ctx, doc)); if (inst) node.push(inst);
      const { item, change } = addNode(doc, node);
      ctx.commit([change], "sheet");
      rememberPlaced(item.kind, item.node);
      ctx.setSelected({ id: item.id });
      return item;
    } catch (e) { ctx.toast("Could not create the sheet: " + ((e && (e as Error).message) || e), 4000); return null; }
    finally { if (S.sheetJob === job) S.sheetJob = null; ctx.requestRender(); }
  })();
  return job.promise;
}
// The sheet from DIALOG_SHEET_PROPERTIES: its file is linked (after asking, when it exists) or created, then the sheet is added.
export function placeSheetNode(ctx: SchCtx, node: SNode, file: string) {
  if (S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return S.sheetJob.promise; }
  const doc = ctx.doc, job: SheetJob = { doc, promise: null }; S.sheetJob = job;
  job.promise = (async () => {
    try {
      file = normSheetFile(file);
      const cur = currentDoc(ctx), dir = cur ? dirName(cur.path) : "", target = joinPath(dir, file);
      const exists = schDocs(ctx).find((x) => x.path === target || x.path === file);
      if (exists && root.KDialogs && root.KDialogs.confirm && !(await root.KDialogs.confirm("Confirmation", `'${baseName(file)}' already exists.\n\nLink '${target}' to this file?`))) return null;
      const ref = await ensureSheetDoc(ctx, file);
      if (S.sheetJob !== job || ctx.doc !== doc) return null;
      const fp = kids(node, "property").find((q) => /^Sheet ?file$/i.test(str(q[1]))); if (fp) fp[2] = ref.file;
      const { item, change } = addNode(doc, node);
      ctx.commit([change], "sheet");
      rememberPlaced(item.kind, item.node);
      ctx.setSelected({ id: item.id });
      return item;
    } catch (e) { ctx.toast("Could not create the sheet: " + ((e && (e as Error).message) || e), 4000); return null; }
    finally { if (S.sheetJob === job) S.sheetJob = null; ctx.requestRender(); }
  })();
  return job.promise;
}
/** A sheet border near a point: the sheet, the side, the distance and the sheet's box. */
export interface SheetEdge { item: KItem; side: string; d: number; x: number; y: number; w: number; h: number }
// The sheet border within tol of p and its nearest side (SCH_SHEET_PIN::ConstrainOnEdge's NearestSegment).
export function sheetEdgeAt(doc: KDoc, p: Pt, tol: number) {
  let best: SheetEdge | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const [x, y] = atOf(it.node), s = kid(it.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
    const edges: Record<string, Pt[]> = { top: [[x, y], [x + w, y]], right: [[x + w, y], [x + w, y + h]], bottom: [[x, y + h], [x + w, y + h]], left: [[x, y], [x, y + h]] };
    for (const side of ["top", "right", "bottom", "left"]) { const d = segDist(p, edges[side][0], edges[side][1]); if (d <= tol && (!best || d < best.d)) best = { item: it, side, d, x, y, w, h }; }
  }
  return best;
}
// The pin sits on the edge, its free coordinate grid-snapped and clamped to the edge (ConstrainOnEdge).
export function sheetPinPoint(ctx: SchCtx, edge: SheetEdge, p: Pt) {
  const g = ctx.snap([p[0], p[1]]), clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (edge.side === "left") return [r4(edge.x), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "right") return [r4(edge.x + edge.w), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "top") return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y)];
  return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y + edge.h)];
}
export function sheetPinClick(ctx: SchCtx, mm: Pt) {
  const edge = sheetEdgeAt(ctx.doc, mm, Math.max(1.27, 8 * mmPerPx(ctx)));
  if (!edge) { ctx.toast("Click on the border of a sheet"); return null; }
  const p = sheetPinPoint(ctx, edge, mm);
  promptImpl("Sheet pin", "", S.cursorClient, (name) => { if (name) placeSheetPin(ctx, edge.item, name, p, edge.side); });
  return edge;
}
// The pin goes into a clone of the sheet node after the fields (before instance data), committed as a whole-item change.
export function placeSheetPin(ctx: SchCtx, sheet: KItem, name: string, p: Pt, side: string) {
  const node = deep(sheet.node), pin = sheetPinNode(name, p, side);
  const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances");
  if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "sheet pin");
  ctx.requestRender();
  return pin;
}
