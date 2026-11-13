// pcb-tools/group-edit.ts: PCB_SELECTION_TOOL::EnterGroup / ExitGroup and PCB_PAINTER::draw( PCB_GROUP ).
// A group is entered by a double-click or Enter Group. Its members are then picked one by one, everything outside it
// is drawn at the Outside Group opacity, and Esc on an empty selection (or a click outside its box) leaves it.
import type { BoardDoc, PcbCtx } from "./types";
import { K, S } from "./state";
import { groupMembers, parentOf, selectionIds } from "./groups";

/** The entered group's id while it still exists. */
export function enteredGroup(doc: BoardDoc | null | undefined): string | null {
  const g = S.enteredGroup; if (!g) return null;
  if (doc && !doc.items.has(g)) { S.enteredGroup = null; return null; }
  return g;
}
/** The entered group and its ancestors: selection does not climb into them. */
export function enteredScope(doc: BoardDoc): Set<string> {
  const out = new Set<string>(); let g = enteredGroup(doc), guard = 0;
  while (g && guard++ < 32) { out.add(g); const p = parentOf(doc, g); g = p ? p.id : null; }
  return out;
}
/** Every item under a group, to any depth (the groups too). */
export function groupDeepMembers(doc: BoardDoc, id: string): Set<string> {
  const out = new Set<string>(); const walk = (gid: string, depth: number) => {
    const g = doc.items.get(gid); if (!g || depth > 32) return;
    for (const m of groupMembers(g.node)) { if (out.has(m)) continue; out.add(m); const it = doc.items.get(m); if (it && (it.kind === "group" || it.kind === "generated")) walk(m, depth + 1); }
  };
  walk(id, 0); return out;
}
/** PCB_GROUP::GetBoundingBox: the union of its members' boxes. */
export function groupBox(doc: BoardDoc, id: string): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const m of groupDeepMembers(doc, id)) {
    const it = doc.items.get(m); const r = it && it.bbox; if (!r) continue;
    b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : [r[0], r[1], r[2], r[3]];
  }
  return b;
}
/** The one group a selection stands for (EnterGroup needs the selection to be a single group). */
export function selectedTopGroup(ctx: PcbCtx): string | null {
  const doc = ctx.doc, scope = enteredScope(doc); let found: string | null = null;
  for (const id of selectionIds(ctx)) {
    const it = doc.items.get(id); if (!it || it.kind !== "group" || scope.has(id)) continue;
    const p = parentOf(doc, id); if (p && !scope.has(p.id) && selectionIds(ctx).has(p.id)) continue;   // a nested group under a selected one
    if (found && found !== id) return null; found = id;
  }
  return found;
}
/** EnterGroup: the selection empties and the group's members become pickable one by one. */
export function enterGroup(ctx: PcbCtx, id: string): boolean {
  if (!ctx.doc || !ctx.doc.items.has(id)) return false;
  S.enteredGroup = id; S.sel.clear(); if (ctx.setSelection) ctx.setSelection([]); else if (ctx.setSelected) ctx.setSelected(null);
  ctx.requestRender(); return true;
}
/** ExitGroup: the group is left; with `select` it ends up selected again. */
export function exitGroup(ctx: PcbCtx | null, select: boolean): boolean {
  const g = S.enteredGroup; if (!g) return false;
  S.enteredGroup = null;
  if (ctx && ctx.doc) {
    if (select && ctx.doc.items.has(g)) { const ids = [g, ...groupDeepMembers(ctx.doc, g)].filter((id) => ctx.doc.items.has(id)); S.sel = new Set(ids); if (ctx.setSelection) { ctx.setSelection(ids); } }
    ctx.requestRender();
  }
  return true;
}
/** The members drawn at full opacity while a group is entered (RENDER_SETTINGS::isInEnteredGroup), or null. */
export function enteredGroupIds(doc: BoardDoc | null | undefined): Set<string> | null {
  const g = enteredGroup(doc); if (!g || !doc) return null;
  const s = groupDeepMembers(doc, g); s.add(g); return s;
}
export const ANCHOR_COLOR = "#FF26E2";   // LAYER_ANCHOR (builtin_color_themes.h)
/**
 * PCB_PAINTER::draw( PCB_GROUP ) on LAYER_ANCHOR: a group selected on its own (not through a selected parent), or
 * the entered one, gets its bounding box at twice the outline width (2 px). When its name fits it also gets a title
 * tab with the name in italics, the text "scaled by zoom a bit, but not too much": ( 12 px + 2 × 12 mils ) / 3.
 */
export function drawGroupFrames(c: CanvasRenderingContext2D, ctx: PcbCtx, cpx: number) {
  const doc = ctx.doc; if (!doc) return;
  const sel = selectionIds(ctx), show = new Map<string, string>();
  const ent = enteredGroup(doc); if (ent) show.set(ent, ANCHOR_COLOR);
  for (const id of sel) {
    const it = doc.items.get(id); if (!it || it.kind !== "group") continue;
    const p = parentOf(doc, id); if (p && sel.has(p.id)) continue;
    show.set(id, (K.selectedColor as (c: string) => string)(ANCHOR_COLOR));   // GetColor of a selected item: m_layerColorsSel
  }
  if (!show.size) return;
  const m = c.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f];
  const stroke = K.drawStrokeText as (ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number) => void;
  for (const [id, col] of show) {
    const b = groupBox(doc, id); if (!b) continue; const w = b[2] - b[0], h = b[3] - b[1];
    c.save(); c.globalAlpha = 1; c.setLineDash([]); c.strokeStyle = col; c.lineWidth = 2 * cpx; c.lineCap = "round"; c.lineJoin = "round";
    c.strokeRect(b[0], b[1], w, h);
    const name = String(doc.items.get(id)!.node[1] ?? "");
    const textSize = (12 * cpx + 2 * 0.3048) / 3;
    if (name && Array.from(name).filter((ch) => ch > " ").length * textSize < w) {
      const th = textSize * 2;
      c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(b[0], b[1] - th); c.lineTo(b[2], b[1] - th); c.lineTo(b[2], b[1]); c.stroke();
      stroke(c, base, { x: b[0] + w / 2, y: b[1] - textSize * 0.5, text: name, size: textSize, rot: 0, mirror: false, h: "center", v: "bottom", pen: textSize / 8, italic: true, dy: 0 }, col, cpx);
    }
    c.restore();
  }
}
