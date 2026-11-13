import type { SchCtx, Pt } from "./types";
import { S } from "./state";
import { r4 } from "./util";

// ================================================================ commands (CollabTools.sch.actions)
// Everything below is KiCad's non-tool command set: clipboard, select connection, repeat, type
// conversions, autoplace fields, annotation, ERC, swap / align / move exactly, group rotate and
// mirror, the symbol fields table and bus unfolding.  app.js binds menus and keys to the `actions`
// map at the bottom; every run(ctx) returns true when it handled the request.  The pure helpers are
// exported on `_` for the tests.
S.markers = [];                    // ERC findings [{ x, y, severity, text, ids, code }] (app.js renders them)
S.markersDoc = null;
S.lastPlaced = null;               // { kind, node } of the last item placed, for Insert
S.repeatOffset = [0, 2.54];        // eeschema's default_repeat_offset (0 mil, 100 mil)
S.repeatIncrement = 1;             // repeat_label_increment
S.annotateAuto = true;             // annotation.automatic (KiCad's default on): pasted / repeated symbols get the next free number
S.unfold = null;                   // { labelId } while a bus unfold's wire is being drawn
S.docRef = null;

// ---------------------------------------------------------------- selection, cursor and clipboard plumbing
// ctx carries `selection` (Set of ids), `selected` (primary), `setSelection(ids)`, `clipboard` ({ get(), set(text) })
// and `cursor` (mm); each has a fallback so the module also runs against today's ctx.
export function selectedItems(ctx: SchCtx) {
  const doc = ctx.doc, out: KItem[] = [], seen = new Set<string>();
  const take = (id: string | null) => { if (!id || seen.has(id)) return; const it = doc.items.get(id); if (it) { seen.add(id); out.push(it); } };
  // the multi-selection when there is one, else the app's primary item, else this module's own pick (selectedItem's precedence)
  if (ctx.selection && typeof ctx.selection.forEach === "function" && ctx.selection.size) { ctx.selection.forEach((id: string) => take(id)); if (ctx.selected) take(ctx.selected.id); }
  else if (ctx.selected) take(ctx.selected.id);
  else take(S.sel);
  return out;
}
export function setSelectionIds(ctx: SchCtx, ids: Iterable<string> | null) {
  ids = Array.from(ids || []).filter((id) => ctx.doc.items.has(id));
  S.sel = null; S.hover = null; S.pending = null; S.selEnds = null;
  if (typeof ctx.setSelection === "function") ctx.setSelection(ids);
  else {
    if (ctx.selection && typeof ctx.selection.clear === "function") { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); }
    const prim = (ids as string[]).map((id: string) => ctx.doc.items.get(id)!).find((it: KItem) => it.kind === "symbol" || it.kind === "sheet");
    if (prim) ctx.setSelected({ id: prim.id }); else { ctx.setSelected(null); S.sel = (ids as string[])[0] || null; }
  }
  ctx.requestRender();
}
export function cursorOf(ctx: SchCtx): Pt { return ctx.cursor || S.cursor || [ctx.doc.page[0] / 2, ctx.doc.page[1] / 2]; }
export function snapCursor(ctx: SchCtx) { const c = cursorOf(ctx); return ctx.snap([c[0], c[1]]).map(r4); }
export function editable(ctx: SchCtx) { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; }
export const CLIP = { text: "" };         // internal buffer when the page has no clipboard access
export function clipWrite(ctx: SchCtx, text: string) {
  CLIP.text = text;
  if (ctx.clipboard && typeof ctx.clipboard.set === "function") { try { ctx.clipboard.set(text); } catch (e) { /* buffer only */ } }
  else if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}
export function clipRead(ctx: SchCtx): string | Promise<string> {           // a string, or a Promise of one when the browser clipboard must be asked
  // the system clipboard first: what was copied in another tab, by another person's session on this machine or
  // by the desktop application is what Ctrl+V pastes; the editor's own buffer is the fallback when it is denied
  if (ctx.clipboard && typeof ctx.clipboard.read === "function") { try { const v = ctx.clipboard.read(); if (v && typeof v.then === "function") return v.then((t) => t || CLIP.text, () => CLIP.text); } catch (e) { /* fall through */ } }
  if (ctx.clipboard && typeof ctx.clipboard.get === "function") { try { const v = ctx.clipboard.get(); if (v !== undefined && v !== null) return v; } catch (e) { /* fall through */ } }
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText().then((t) => t || CLIP.text, () => CLIP.text);
  return CLIP.text;
}
export const PASTE_KINDS = new Set(["symbol", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label",
  "text", "text_box", "rectangle", "circle", "arc", "bezier", "rule_area", "sheet", "table", "image"]);
