import type { SchCtx, Pt } from "./types";
import { root } from "../root";
import { PASTE_KINDS, clipRead, clipWrite, cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { junctionAt, needsJunction } from "./connect";
import { beginDrag, connPoints, isNetLine } from "./drag";
import { junctionNode } from "./nodes";
import { anchorOf, cloneNode, shiftNode } from "./orient";
import { deleteChanges } from "./selection-edits";
import { K, S, TEXT_KINDS, kid, kids, ptsOf, str } from "./state";
import { addNode, deep, dropKid, r4 } from "./util";

// ---------------------------------------------------------------- copy / cut / paste / duplicate
// What the desktop puts on the clipboard (SCH_IO_KICAD_SEXPR::Format for a selection): the library
// symbols used, then the items — no (kicad_sch …) wrapper, which its copyable-only parser rejects.
// opts.wrap gives the document form for anything that wants a whole sheet.
/** Paste options: the reference rule, the undo label, where the items land, and whether junctions are added. */
export interface PasteOpts { pasteMode?: string; keepAnnotations?: boolean; noJunctions?: boolean; label?: string; at?: Pt }
/** Clipboard content: the items and the library symbols they draw from. */
export interface Clip { nodes: SNode[]; libs: SNode[] }
export function clipboardText(doc: KDoc, items: KItem[], opts?: { wrap?: boolean }) {
  const libs = new Map<string, SNode>();
  for (const it of items) if (it.kind === "symbol") { const name = str((kid(it.node, "lib_id") || [])[1]); const lib = doc.lib.get(name); if (lib && !libs.has(name)) libs.set(name, lib); }
  const parts: string[] = [];
  if (libs.size) parts.push("(lib_symbols " + Array.from(libs.values()).map((l) => K.serialize(l)).join(" ") + ")");
  for (const it of items) {
    let node = it.node;
    if (it.kind === "rule_area" && kid(node, "uuid")) { node = deep(node); dropKid(node, "uuid"); }
    let s = K.serialize(node); if (it.kind === "sheet") s = s.replace(/\(page (\d+)\)/g, '(page "$1")');
    parts.push(s);
  }
  const body = parts.join("\n");
  return opts && opts.wrap ? `(kicad_sch (version 20250114) (generator "kicad-collab-web") (generator_version "9.0")\n${body}\n)` : body;
}
// Both clipboard forms: a bare item sequence (the desktop's) or a (kicad_sch …) document.
export function parseClipboard(text: string): Clip | null {
  let trees: SNode[]; try { trees = K.parseAll(str(text)); } catch (e) { return null; }
  const nodes: SNode[] = [], libs: SNode[] = [];
  const takeLibs = (ls: SNode) => { for (const s of kids(ls, "symbol")) libs.push(s); };
  for (const t of trees || []) {
    if (!Array.isArray(t)) continue;
    if (t[0] === "kicad_sch") { const ls = kid(t, "lib_symbols"); if (ls) takeLibs(ls); for (const c of t.slice(1)) if (Array.isArray(c) && PASTE_KINDS.has(c[0] as string)) nodes.push(c); }
    else if (t[0] === "lib_symbols") takeLibs(t);
    else if (PASTE_KINDS.has(t[0] as string)) nodes.push(t);
  }
  return nodes.length ? { nodes, libs } : null;
}
export const refPrefix = (ref: string) => str(ref).replace(/\?$/, "").replace(/\d+$/, "");
export const unannotated = (ref: string) => refPrefix(ref) + "?";
export const refNumber = (ref: string) => { const m = str(ref).match(/(\d+)$/); return m ? +m[1] : -1; };
// The references in use: this sheet's, plus the ones the project's other sheets hold (S.otherRefs, kept by the editor)
export function usedReferences(doc: KDoc, skip?: Set<string>) { const used = new Set(S.otherRefs || []); for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !(skip && skip.has(it.id))) used.add(it.ref); return used; }
export function refField(node: SNode) { return kids(node, "property").find((p) => str(p[1]) === "Reference") || null; }
// Set a symbol node's reference designator, keeping its instance data in step.
export function setReference(node: SNode, ref: string) {
  const p = refField(node); if (p) p[2] = ref;
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const r = kid(pa, "reference"); if (r) r[1] = ref; }
}
// Pasted / repeated symbols keep a reference that is still free on the sheet; anything else becomes "R?"
// (or, with automatic annotation on, the next free number for its prefix).
export function assignPastedRef(doc: KDoc, node: SNode, used: Set<string>) {
  const p = refField(node); if (!p) return;
  const ref = str(p[2]);
  if (!/\?$/.test(ref) && !used.has(ref)) { used.add(ref); return; }
  let next = unannotated(ref);
  if (S.annotateAuto) { const prefix = refPrefix(ref); let n = 1; while (used.has(prefix + n)) n++; next = prefix + n; used.add(next); }
  setReference(node, next);
}
// Junctions the new items need: every connection point of every new item (items must be in the doc).
export function junctionsForNew(doc: KDoc, items: KItem[]) {
  const out: KChange[] = [], seen = new Set<string>();
  for (const it of items) {
    const line = isNetLine(it.kind);
    for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) {
      const key = r4(p[0]) + "," + r4(p[1]); if (seen.has(key)) continue; seen.add(key);
      if (junctionAt(doc, p[0], p[1])) continue;
      const need = line ? needsJunction(doc, p[0], p[1], it.kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (need) out.push(addNode(doc, junctionNode(p)).change);
    }
  }
  return out;
}
// Fresh copies of clipboard nodes landed at `at` (mm): the first symbol's anchor (else the first
// item's) goes to the point, like the desktop's paste-then-move.  Returns { changes, ids }.
export function pasteChanges(doc: KDoc, parsed: Clip, at: Pt, opts?: PasteOpts | null) {
  const libs: string[] = [];
  for (const lib of parsed.libs) { const name = str(lib[1]); if (!doc.lib.has(name)) { doc.lib.set(name, lib); libs.push(name); } }   // the sheet's own copy wins (ChoosePasteLibSymbol)
  const fresh = parsed.nodes.map((n) => cloneNode({ kind: n[0] as string, node: deep(n) }));
  const used = usedReferences(doc);
  // PASTE_MODE: "keep" (keepAnnotations), "remove" (every reference becomes R?), "unique" (the next free number for a
  // reference already in use, whatever the automatic-annotation setting); default: assignPastedRef's own rule
  // SCH_EDITOR_CONTROL::Paste: UNIQUE_ANNOTATIONS when annotation is automatic (the default), else REMOVE_ANNOTATIONS
  const mode = (opts && (opts.pasteMode || (opts.keepAnnotations ? "keep" : null))) || (S.annotateAuto ? "unique" : "remove");
  for (const n of fresh) {
    if (n[0] !== "symbol" || mode === "keep") continue;
    if (mode === "remove") { const p = refField(n); if (p) setReference(n, unannotated(str(p[2]))); continue; }
    if (mode === "unique") { const auto = S.annotateAuto; S.annotateAuto = true; try { assignPastedRef(doc, n, used); } finally { S.annotateAuto = auto; } continue; }
    assignPastedRef(doc, n, used);
  }
  const lead = fresh.find((n) => n[0] === "symbol") || fresh[0], a = anchorOf(lead[0] as string, lead);
  const dx = r4(at[0] - a[0]), dy = r4(at[1] - a[1]);
  for (const n of fresh) shiftNode(n[0] as string, n, dx, dy);
  const changes: KChange[] = [], items: KItem[] = [];
  for (const n of fresh) { const { item, change } = addNode(doc, n); changes.push(change); items.push(item); }
  if (!(opts && opts.noJunctions)) changes.push(...junctionsForNew(doc, items));
  return { changes, ids: items.map((it) => it.id), libs };
}
export function copySelection(ctx: SchCtx) {
  const items = selectedItems(ctx); if (!items.length) return false;
  clipWrite(ctx, clipboardText(ctx.doc, items)); return true;
}
export function cutSelection(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  clipWrite(ctx, clipboardText(ctx.doc, items));
  const changes = deleteChanges(ctx.doc, items);
  setSelectionIds(ctx, []); ctx.commit(changes, "cut"); ctx.requestRender();
  return true;
}
export function pasteText(ctx: SchCtx, text: string, opts?: PasteOpts | null) {
  const parsed = parseClipboard(text);
  if (!parsed) { if (str(text).trim()) ctx.toast("Clipboard has no schematic items"); return false; }
  const label = (opts && opts.label) || "paste", live = canFollow(ctx);
  const { changes, ids, libs } = pasteChanges(ctx.doc, parsed, (opts && opts.at) || snapCursor(ctx), Object.assign({}, opts, { noJunctions: live }));
  if (!changes.length) return false;
  if (live && followPaste(ctx, ids, libs, (opts && opts.at) || cursorOf(ctx), label)) return true;
  if (live) changes.push(...junctionsForNew(ctx.doc, ids.map((id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]));
  ctx.commit(changes, label);
  setSelectionIds(ctx, ids);
  return true;
}
// Whether a paste / break can ride the cursor (a live stage with a pointer; tests switch it on with _.setFollow).
export function canFollow(ctx: SchCtx) { return S.forceFollow || (typeof document !== "undefined" && !!S.dom && !!ctx.stage); }
// KiCad's Paste / Duplicate (SCH_EDITOR_CONTROL::Paste -> SCH_MOVE_TOOL): the new items are IS_NEW, only on this
// client, and ride the cursor; the click commits them where they land, with the junctions they need there, as one
// undo step.  Esc, Ctrl+Z or Delete discards them without leaving anything behind (localCommit.Revert()).
export function followPaste(ctx: SchCtx, ids: string[], libs: string[], at: Pt, label: string) {
  const items = ids.map((id: string) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]; if (!items.length) return false;
  const mode = S.dragMode; S.dragMode = "move";
  const d = beginDrag(ctx, items, at, false, { plain: true });
  if (!d) { S.dragMode = mode; return false; }
  d.pasted = true; d.local = new Set(ids); d.libs = libs || []; d.label = label; d.restoreMode = mode; d.moved = true;
  setSelectionIds(ctx, ids);
  return true;
}
export function pasteSelection(ctx: SchCtx, opts?: PasteOpts | null) {
  if (!editable(ctx)) return false;
  const v = clipRead(ctx);
  if (v && typeof (v as Promise<string>).then === "function") { (v as Promise<string>).then((t) => pasteText(ctx, t, opts)); return true; }
  return pasteText(ctx, v as string, opts);
}
// DIALOG_PASTE_SPECIAL: Reference Designators — assign unique (the default with automatic annotation on), keep
// (even if duplicated), or clear (the default with it off); OK pastes, Cancel does nothing.
export function pasteSpecial(ctx: SchCtx, opts?: PasteOpts | null) {
  if (!editable(ctx)) return false;
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (opts && (opts.pasteMode || opts.keepAnnotations !== undefined) || !KD || !KD.open) return pasteSelection(ctx, Object.assign({ keepAnnotations: true }, opts || {}));
  const at = snapCursor(ctx); let mode = S.annotateAuto ? "unique" : "remove";
  const choices = [["unique", "Assign unique reference designators to pasted symbols", "Finds the next available reference designator for any designators that already exist in the design."],
    ["keep", "Keep existing reference designators, even if they are duplicated", ""], ["remove", "Clear reference designators on all pasted symbols", "Replaces reference designators with '?'."]];
  KD.open({ title: "Paste Special", width: 460,
    build(body) {
      body.innerHTML = `<div class="kd-note" style="margin-bottom:6px">Reference Designators</div>` + choices.map(([v, l, tip]) => `<label class="kd-chk" style="display:flex;gap:6px;align-items:center;margin:3px 0"${tip ? ` title="${tip}"` : ""}><input type="radio" name="kd-paste-mode" value="${v}" id="kd-paste-${v}"${v === mode ? " checked" : ""}>${l}</label>`).join("");
      for (const r of body.querySelectorAll<HTMLInputElement>("input[name=kd-paste-mode]")) r.addEventListener("change", () => { if (r.checked) mode = r.value; });
    },
    ok() { setTimeout(() => pasteSelection(ctx, Object.assign({}, opts || {}, { pasteMode: mode, at })), 0); } });
  return true;
}
export function duplicateSelection(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  // Duplicate goes through Paste like the desktop's (same reference rules), then the copy follows the cursor
  return pasteText(ctx, clipboardText(ctx.doc, items), { label: "duplicate" });
}
export function copyAsText(ctx: SchCtx) {
  const items = selectedItems(ctx); if (!items.length) return false;
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === "symbol") lines.push([it.ref, it.value].filter(Boolean).join(" "));
    else if (TEXT_KINDS.has(it.kind) || it.kind === "text_box") lines.push(str(it.node[1]));
    else if (it.kind === "netclass_flag" || it.kind === "directive_label") { const nc = kids(it.node, "property").find((p) => str(p[1]) === "Netclass"); if (nc) lines.push(str(nc[2])); }
    else if (it.kind === "sheet") lines.push([it.name, it.file].filter(Boolean).join(" "));
  }
  clipWrite(ctx, lines.join("\n")); return true;
}
