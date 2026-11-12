import type { SchCtx, Pt } from "./types";
import { root } from "../root";
import { closePrompt, promptImpl } from "./dom";
import { arcNode, bezierNode, circleNode, polygonNode, polylineNode, rectangleNode, ruleAreaNode, sheetNode, tableNode, textBoxNode } from "./nodes";
import { rememberPlaced } from "./repeat";
import { SHEET_EXT, nextPage, placeSheet, placeSheetNode, sheetFileFor, sheetInstance } from "./sheets";
import { K, S, kids, str } from "./state";
import { addNode, r4, same } from "./util";
import { simplify } from "./wire";

// ---------------------------------------------------------------- graphic shapes (KiCad's two/three-click drawing)
// S.draw = { shape, pts (fixed clicks), cur (cursor) }: rect and textbox take two corners, circle its
// centre then a radius point, arc its start, end and then a point on the arc, lines any number of
// points until Enter, a double click or a click on the last point.
export function drawPoint(ctx: SchCtx, mm: Pt) { return ctx.snap([mm[0], mm[1]]).map(r4); }
export function startDraw(ctx: SchCtx, shape: string, p: Pt) { S.draw = { shape, pts: [p], cur: p.slice() }; ctx.requestRender(); }
export function cancelDraw(ctx: SchCtx) { S.draw = null; closePrompt(); ctx.requestRender(); }
export function undoDrawPoint(ctx: SchCtx) { const d = S.draw; if (!d) return; if (d.pts.length > 1) d.pts.pop(); else S.draw = null; ctx.requestRender(); }
export function drawClick(ctx: SchCtx, shape: string, p: Pt) {
  const d = S.draw;
  if (!d || d.shape !== shape) { startDraw(ctx, shape, p); return; }
  d.cur = p.slice();
  const last = d.pts[d.pts.length - 1];
  if (shape === "lines" || shape === "polygon" || shape === "rulearea") {
    if (same(p, last)) { finishDraw(ctx); return; }
    if (shape !== "lines" && d.pts.length >= 3 && same(p, d.pts[0])) { finishDraw(ctx); return; }   // back on the first point closes it
    d.pts.push(p); ctx.requestRender(); return;
  }
  if (shape === "bezier") {                        // start, control 1, end, then the far handle (BEZIER_GEOM_MANAGER)
    if (d.pts.length === 2 && same(p, d.pts[0])) { ctx.toast("The curve's end must differ from its start"); return; }
    d.pts.push(p); if (d.pts.length === 4) finishDraw(ctx); else ctx.requestRender(); return;
  }
  if (shape === "arc") {
    if (d.pts.length === 1) { if (!same(p, last)) d.pts.push(p); ctx.requestRender(); return; }
    if (!K.arcFrom3(d.pts[0], p, d.pts[1]) || same(p, d.pts[0]) || same(p, d.pts[1])) { ctx.toast("Click a point on the arc, off the line between its ends"); return; }
    d.pts.push(p); finishDraw(ctx); return;
  }
  if (same(p, last)) return;                     // a zero-size shape is not a shape
  d.pts.push(p); finishDraw(ctx);
}
export function finishDraw(ctx: SchCtx) {
  const d = S.draw; if (!d) return;
  const doc = ctx.doc, pts = d.pts; let node = null, label = d.shape;
  if (d.shape === "rect") node = rectangleNode(pts[0], pts[1]), label = "rectangle";
  else if (d.shape === "circle") node = circleNode(pts[0], Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
  else if (d.shape === "arc") node = arcNode(pts[0], pts[2], pts[1]);
  else if (d.shape === "lines") { const p = simplify(pts); if (p.length >= 2) node = polylineNode(p); label = "lines"; }
  else if (d.shape === "polygon") { const p = simplify(pts); if (p.length >= 3) node = polygonNode(p); }
  else if (d.shape === "rulearea") { const p = simplify(pts); if (p.length >= 3) node = ruleAreaNode(p); label = "rule area"; }
  else if (d.shape === "bezier") {
    // KiCad's fourth click is the handle beyond the end: control 2 is its reflection over the end point
    if (pts.length === 4) { const e = pts[2], c2 = [r4(2 * e[0] - pts[3][0]), r4(2 * e[1] - pts[3][1])]; node = bezierNode(pts[0], pts[1], c2, e); }
  }
  else if (d.shape === "table") {
    d.await = true; ctx.requestRender();
    promptImpl("Rows x cols", "2x2", S.cursorClient, (spec) => {
      if (S.draw !== d) return; S.draw = null;
      const m = spec && spec.match(/^\s*(\d+)\s*[x×*,\s]\s*(\d+)\s*$/i);
      if (m) commitShape(ctx, tableNode(pts[0], pts[1], +m[1], +m[2], ctx.gridPitch), "table");
      else if (spec) ctx.toast("Rows x cols, e.g. 3x2");
      ctx.requestRender();
    });
    return;
  }
  else if (d.shape === "sheet") {
    // the rectangle is fixed; DIALOG_SHEET_PROPERTIES opens on "Untitled Sheet" / "untitled.kicad_sch", then the file is made
    d.await = true; ctx.requestRender();
    const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
    if (KD && KD.schItemDialog && !ctx.viewOnly) {
      const sn = sheetNode(pts[0], pts[1], "Untitled Sheet", "untitled" + SHEET_EXT);
      const inst = sheetInstance(ctx, ctx.doc, nextPage(ctx, ctx.doc)); if (inst) sn.push(inst);
      const it = { id: "", kind: "sheet", node: sn, geom: [], bbox: null };
      KD.schItemDialog(ctx, it, { cancel() { if (S.draw === d) { S.draw = null; ctx.requestRender(); } }, onCreate(staged) {
        if (S.draw !== d) return; S.draw = null;
        const fp = kids(staged, "property").find((q) => /^Sheet ?file$/i.test(str(q[1])));
        placeSheetNode(ctx, staged, fp ? str(fp[2]) : "untitled" + SHEET_EXT);
      } });
      return;
    }
    promptImpl("Sheet name", "", S.cursorClient, (name) => {
      if (S.draw !== d) return;
      if (!name) { S.draw = null; ctx.requestRender(); return; }
      promptImpl("Sheet file", sheetFileFor(name), S.cursorClient, (file) => {
        if (S.draw !== d) return; S.draw = null;
        if (file) placeSheet(ctx, pts[0], pts[1], name, file); else ctx.requestRender();
      });
    });
    return;
  }
  else if (d.shape === "textbox") {
    // the box is fixed; DIALOG_TEXT_PROPERTIES opens for its text, Cancel drops the box
    d.await = true; ctx.requestRender();
    const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
    if (KD && (KD.openNew as typeof KD.openNew | undefined) && !ctx.viewOnly) {
      const tb = textBoxNode("", pts[0], pts[1]);
      KD.openItem(ctx, { id: "", kind: "text_box", node: tb, geom: [], bbox: null }, { generic: true, cancel() { if (S.draw === d) { S.draw = null; ctx.requestRender(); } },
        onCreate(staged) { if (S.draw !== d) return; S.draw = null; commitShape(ctx, staged, "text box"); ctx.requestRender(); } });
      return;
    }
    promptImpl("Text box", "", S.cursorClient, (text) => { if (S.draw !== d) return; S.draw = null; if (text) commitShape(ctx, textBoxNode(text, pts[0], pts[1]), "text box"); ctx.requestRender(); });
    return;
  }
  S.draw = null;
  if (node) commitShape(ctx, node, label);
  ctx.requestRender();
}
export function commitShape(ctx: SchCtx, node: SNode, label: string) {
  const { item, change } = addNode(ctx.doc, node);
  ctx.commit([change], label);
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null);
  return item;
}
