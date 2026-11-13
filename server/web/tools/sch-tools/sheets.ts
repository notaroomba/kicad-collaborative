import type { SchCtx, Pt, SAtom, SheetJob } from "./types";
import { root } from "../root";
import { labelDefaults } from "./dom";
import { sheetNode, sheetPinNode } from "./nodes";
import { rememberPlaced } from "./repeat";
import { mmPerPx } from "./snap";
import { K, S, atOf, kid, kids, num, str } from "./state";
import { addNode, deep, ghost, modChange, r4, segDist } from "./util";
import { strNumCmp, subsheetDoc } from "./erc";
import { switchTool } from "./junction";

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
/** The sheet under a point (SCH_SELECTION_TOOL::SelectPoint for SCH_SHEET_T: anywhere over its body or border). */
export function sheetAt(doc: KDoc, p: Pt, tol: number): KItem | null {
  let best: KItem | null = null, area = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const [x, y] = atOf(it.node), s = kid(it.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
    if (p[0] < x - tol || p[0] > x + w + tol || p[1] < y - tol || p[1] > y + h + tol) continue;
    if (w * h < area) { best = it; area = w * h; }   // the smallest of nested boxes
  }
  return best;
}
/** SCH_SHEET_PIN::ConstrainOnEdge( pos, true ): the nearest side of this sheet and the point on it. */
export function constrainOnEdge(ctx: SchCtx, sheet: KItem, p: Pt): { p: Pt; side: string } {
  const [x, y] = atOf(sheet.node), s = kid(sheet.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
  const edges: Record<string, Pt[]> = { top: [[x, y], [x + w, y]], right: [[x + w, y], [x + w, y + h]], bottom: [[x, y + h], [x + w, y + h]], left: [[x, y], [x, y + h]] };
  let side = "left", d = Infinity;
  for (const k of ["left", "right", "top", "bottom"]) { const e = segDist(p, edges[k][0], edges[k][1]); if (e < d) { d = e; side = k; } }
  const edge: SheetEdge = { item: sheet, side, d, x, y, w, h };
  return { p: sheetPinPoint(ctx, edge, p) as Pt, side };
}
/**
 * SCH_DRAWING_TOOLS::importHierLabel: the sub-sheet's hierarchical labels by StrNumCmp (ignoring case), the first
 * one the sheet has no pin for; null when every label has one.
 */
export function importHierLabel(sheet: KItem, sub: KDoc): { name: string; shape: string } | null {
  const have = new Set<string>(kids(sheet.node, "pin").map((p) => str(p[1])));
  const labels = Array.from(sub.items.values()).filter((o) => o.kind === "hierarchical_label").map((o) => { const sh = kid(o.node, "shape"); return { name: str(o.node[1]), shape: sh ? str(sh[1]) : "input" }; });
  labels.sort((a, b) => strNumCmp(a.name.toUpperCase(), b.name.toUpperCase()));
  return labels.find((l) => !have.has(l.name)) || null;
}
/** The sheet's sub-sheet document: from ctx.sheetDocs at once, else read through ctx.loadSheetDoc. */
function sheetDocOf(ctx: SchCtx, sheet: KItem): KDoc | Promise<KDoc | null> | null {
  const d = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, sheet) : null; if (d) return d;
  return ctx.loadSheetDoc ? ctx.loadSheetDoc(sheet) : null;
}
/**
 * Place Sheet Pins (SCH_DRAWING_TOOLS::TwoClickPlace, isSheetPin): the first click over a sheet (or the selected
 * sheet) takes its next unplaced hierarchical label and a pin of that name and shape rides the sheet's edge with the
 * cursor; the next click places it and the following label comes up, until "No new hierarchical labels found.".
 */
export function sheetPinClick(ctx: SchCtx, mm: Pt) {
  if (S.pinPlace) { placePinPlace(ctx, mm); return null; }
  let sheet = S.pinSheet ? ctx.doc.items.get(S.pinSheet) || null : null;
  if (!sheet) sheet = sheetAt(ctx.doc, mm, Math.max(0.5, 4 * mmPerPx(ctx)));
  if (!sheet) { ctx.toast("Click over a sheet.", 2000); return null; }
  S.pinSheet = sheet.id;
  beginPinPlace(ctx, sheet, mm);
  return sheet;
}
export function beginPinPlace(ctx: SchCtx, sheet: KItem, mm: Pt): void {
  const got = sheetDocOf(ctx, sheet);
  const go = (sub: KDoc | null): void => {
    if (S.tool !== "sheetpin" || S.pinPlace) return;
    const cur = ctx.doc.items.get(sheet.id); if (!cur) return;
    if (!sub) { ctx.toast("The sheet's file is not loaded", 2000); return; }
    const label = importHierLabel(cur, sub);
    // the message, then `break` out of TwoClickPlace's event loop: the tool ends and selection resumes
    if (!label) { ctx.toast("No new hierarchical labels found.", 2000); S.pinSheet = null; switchTool(ctx, "select"); ctx.requestRender(); return; }
    S.pinPlace = { sheetId: cur.id, name: label.name, shape: label.shape, node: cur.node, item: null, p: [0, 0], side: "left" };
    movePinPlace(ctx, S.cursor || mm);
  };
  if (got && typeof (got as Promise<KDoc | null>).then === "function") (got as Promise<KDoc | null>).then(go, () => go(null)); else go(got as KDoc | null);
}
/** The pin follows the cursor along the sheet's edge (SCH_SHEET_PIN::ConstrainOnEdge); its ghost is the sheet with it. */
export function movePinPlace(ctx: SchCtx, mm: Pt): void {
  const pp = S.pinPlace; if (!pp) return;
  const sheet = ctx.doc.items.get(pp.sheetId); if (!sheet) { S.pinPlace = null; ctx.requestRender(); return; }
  const at = constrainOnEdge(ctx, sheet, mm);
  if (pp.item && pp.p[0] === at.p[0] && pp.p[1] === at.p[1] && pp.side === at.side) return;
  const ts = labelDefaults().textSize;   // createNewSheetPin: m_DefaultTextSize
  const node = deep(sheet.node), pin = sheetPinNode(pp.name, at.p, at.side, ts); pin[2] = pp.shape;
  const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin);
  // the ghost is the sheet with the new pin, under a uuid of its own so it never stands in for the real sheet
  const g = deep(node); const u = g.findIndex((c) => Array.isArray(c) && c[0] === "uuid"); if (u >= 0) g.splice(u, 1);
  pp.node = node; pp.p = at.p; pp.side = at.side; pp.item = ghost(ctx.doc, g);
  ctx.requestRender();
}
export function cancelPinPlace(ctx: SchCtx): void { S.pinPlace = null; ctx.requestRender(); }
function placePinPlace(ctx: SchCtx, mm: Pt): void {
  const pp = S.pinPlace; if (!pp) return;
  movePinPlace(ctx, mm);
  const sheet = ctx.doc.items.get(pp.sheetId); S.pinPlace = null; if (!sheet) return;
  // commit.Modify( sheet ); sheet->AddPin( pin )
  const node = deep(sheet.node), pin = deep(kids(pp.node, "pin").find((q) => str(q[1]) === pp.name && !kids(sheet.node, "pin").some((o) => str(o[1]) === pp.name && uuidOfNode(o) === uuidOfNode(q)))!);
  const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "Add Sheet Pin");
  // the next unplaced label follows the cursor
  const cur = ctx.doc.items.get(pp.sheetId); if (cur) beginPinPlace(ctx, cur, S.cursor || mm);
  ctx.requestRender();
}
const uuidOfNode = (n: SNode): string => { const u = kid(n, "uuid"); return u ? str(u[1]) : ""; };
// The pin goes into a clone of the sheet node after the fields (before instance data), committed as a whole-item change.
export function placeSheetPin(ctx: SchCtx, sheet: KItem, name: string, p: Pt, side: string) {
  const node = deep(sheet.node), pin = sheetPinNode(name, p, side);
  const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances");
  if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "sheet pin");
  ctx.requestRender();
  return pin;
}
