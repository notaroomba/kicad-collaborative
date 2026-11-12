// pcb-tools/assistants.ts — the drawing assistants (dimension labels, status popups), text placement and cancelling what is in flight.
import type { DrawState, PcbCtx, Pt } from "./types";

/** An editor dialog for a new item: it edits the node and hands it back, or null on Cancel. */
export type NewItemDialog = (ctx: PcbCtx, node: SNode, done: (node: SNode | null) => void) => void;
import { addedChange } from "./changes";
import { closeTextPrompt } from "./dom";
import { askText } from "./draw-tools";
import { sizeUnits } from "./edit-commands";
import { applySelection } from "./groups";
import { textNode } from "./nodes";
import { line } from "./overlay";
import { editHandleUp } from "./point-editor";
import { routeUnhighlight } from "./route-fix";
import { beginCarryMove, finishSelectMove } from "./select-move";
import { K, S, lastCtx } from "./state";
import { vsub } from "./util";

/** STATUS_TEXT_POPUP::PopupFor: a one-line note 20 px right of and below the cursor that goes away by itself. */
export function statusPopup(ctx: PcbCtx, text: string, at: Pt, ms: number) {
  S.popup = { text, at: at.slice(), until: Date.now() + ms }; ctx.requestRender();
  if (typeof setTimeout === "function") setTimeout(() => { if (S.popup && Date.now() >= S.popup.until - 5) { S.popup = null; if (lastCtx) lastCtx.requestRender(); } }, ms);
}
/** KIGFX::PREVIEW::DimensionLabel: "l: 12.345 mm", at the preview precision of the user's units. */
export function dimensionLabel(prefix: string, mm: number, deg?: boolean) {
  if (deg) return `${prefix}: ${mm.toFixed(1)}°`;
  const u = sizeUnits();
  return `${prefix}: ${u === "mil" ? (mm / 0.0254).toFixed(1) + " mils" : u === "in" ? (mm / 25.4).toFixed(4) + " in" : mm.toFixed(3) + " mm"}`;
}
/**
 * TWO_POINT_ASSISTANT::ViewDraw: next to the cursor, on the side away from the origin, a line shows its length and
 * angle (+90° up), a rectangle its width and height, a circle its radius (with the radius line drawn).
 */
export function drawTwoPointAssistant(c: CanvasRenderingContext2D, d: DrawState, px: number, colour: string) {
  const t = d.shape; if ((t !== "gline" && t !== "grect" && t !== "gcircle") || !d.cur) return;
  const o = d.start, e = d.cur, v = vsub(e, o); if (!v[0] && !v[1]) return;
  const strs = t === "gline" ? [dimensionLabel("l", Math.hypot(v[0], v[1])), dimensionLabel("θ", Math.atan2(-v[1], v[0]) * 180 / Math.PI, true)]
    : t === "grect" ? [dimensionLabel("x", Math.abs(v[0])), dimensionLabel("y", Math.abs(v[1]))] : [dimensionLabel("r", Math.hypot(v[0], v[1]))];
  if (t === "gcircle") { c.save(); c.globalAlpha = 1; c.lineWidth = px; line(c, o, e); c.restore(); }
  textNextToCursor(c, e, vsub(o, e), strs, px, colour);   // DrawTextNextToCursor( end, origin - end )
}
/** KIGFX::PREVIEW::DrawTextNextToCursor: the lines beside the cursor, on the side away from aTextQuadrant. */
export function textNextToCursor(c: CanvasRenderingContext2D, e: Pt, q: Pt, strs: string[], px: number, colour: string) {
  c.save(); c.globalAlpha = 1;
  const fs = 12 * px, pitch = fs * 1.4;
  c.font = `${fs}px sans-serif`; c.fillStyle = colour; c.textBaseline = "top";
  let x = e[0], y = e[1];
  if (q[1] > 0) y -= pitch * (strs.length + 1);
  if (q[0] < 0) { c.textAlign = "left"; x += 15 * px; } else { c.textAlign = "right"; x -= 15 * px; }
  strs.forEach((sx: string, i: number) => c.fillText(sx, x, y + (i + 0.5) * pitch));
  c.restore();
}
export function drawStatusPopup(c: CanvasRenderingContext2D, px: number) {
  const p = S.popup; if (!p) return;
  if (Date.now() > p.until) { S.popup = null; return; }
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const fs = 12 * px, m = 5 * px; c.save(); c.globalAlpha = 1; c.font = `${fs}px sans-serif`;
  const w = c.measureText(p.text).width + 2 * m, h = fs + 2 * m, x = p.at[0] + 20 * px, y = p.at[1] + 20 * px;
  c.fillStyle = css("--panel", "#2b2b2b"); c.strokeStyle = css("--line", "#555"); c.lineWidth = px; c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
  c.fillStyle = css("--ink", "#e0e0e0"); c.textBaseline = "top"; c.fillText(p.text, x + m, y + m); c.restore();
}
export function placeText(ctx: PcbCtx, mm: Pt, text: string) { ctx.commit([addedChange(ctx.doc, textNode(text, mm[0], mm[1], S.gfxLayer))], "text"); }
// the editor's dialogs for a new item (pcbdialogs/item-props.ts): kind -> (ctx, node, done(node | null))
export let newItemDialogs: Record<string, NewItemDialog | undefined> = {};
/**
 * DRAWING_TOOL::PlaceText: the click makes a PCB_TEXT on the active layer with the layer class's size and thickness
 * (Board Setup's text defaults), left / bottom justified and mirrored on a back layer, and opens Text Properties on
 * it.  OK with printable text: the text hangs on the cursor until the next click places it ("Draw Text", selected);
 * placed at once when the dialog changed its position.  Cancel or blank text: nothing.
 */
export function placeTextAt(ctx: PcbCtx, at: Pt) {
  if (ctx.viewOnly || S.move) return;
  const dlg = newItemDialogs.gr_text;
  if (!dlg) { askText(ctx, "Text", "", (v: string | null) => { if (v) placeText(ctx, at, v); }); return; }
  applySelection(ctx, []);
  dlg(ctx, textNode("", at[0], at[1], S.gfxLayer), (n: SNode | null) => {
    if (!n || !/[^\s]/.test(K.str(n[1]).replace(/\\n/g, ""))) return;   // NoPrintableChars
    const p = K.atOf(n); const moved = Math.abs(p[0] - at[0]) > 1e-9 || Math.abs(p[1] - at[1]) > 1e-9;
    const c = addedChange(ctx.doc, n); ctx.commit([c], "Draw Text"); applySelection(ctx, [c.id]);
    if (!moved) beginCarryMove(ctx, { placing: [c.id], origin: at });
    ctx.requestRender();
  });
}
export function cancelOps() { if (S.drag && lastCtx && lastCtx.doc) { const D = S.drag; S.drag = null; routeUnhighlight(lastCtx, D.subs[0]); } if (S.route) { K.pcbSizes.state.endRoute(); const rt = S.route; S.route = null; if (lastCtx && lastCtx.doc) routeUnhighlight(lastCtx, rt); } S.violations = null; S.draw = null; S.drag = null; S.image = null; S.pending = null; if (S.move && lastCtx) finishSelectMove(lastCtx, false); S.move = null; if (S.pedit && lastCtx) editHandleUp(lastCtx, false); closeTextPrompt(); if (S.tune) S.tune.pattern = null; }
/** pcb.setNewItemDialogs: the editor's dialogs for a new item. */
export function setNewItemDialogsImpl(d: Record<string, NewItemDialog | undefined>) { newItemDialogs = d; }
