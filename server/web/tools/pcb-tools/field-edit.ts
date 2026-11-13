// pcb-tools/field-edit.ts — EDIT_TOOL's Rotate / Flip / Delete on a footprint field (PCB_FIELD_T) in the board
// editor: the selected field, or with nothing selected the field the hover selection collects under the cursor.
import type { BoardDoc, PcbChange, PcbCtx, Pt } from "./types";
import { fieldIsHidden, hiddenFieldNode, replacedChange } from "./changes";
import { K, S } from "./state";
import { selectionIds } from "./groups";
import { flipLayerKid, toggleMirror } from "./footprint";
import { angleKid, setAngleKid } from "./transforms";
import { clone, isList } from "./util";

/** A footprint field: the footprint's id and the field's name ("Reference", "Value", a user field). */
export interface FieldRef { id: string; name: string }

/** The (property "Name" …) child of a footprint node, or a legacy board's (fp_text reference|value …). */
export function footprintFieldNode(fp: SNode, name: string): SNode | null {
  for (const c of fp) if (isList(c) && c[0] === "property" && K.str(c[1]) === name) return c;
  const t = name === "Reference" ? "reference" : name === "Value" ? "value" : null;
  if (t) for (const c of fp) if (isList(c) && c[0] === "fp_text" && K.str(c[1]) === t) return c;
  return null;
}

/**
 * The field an EDIT_TOOL action works on, or null when the action takes the ordinary selection.  A selected field
 * (and nothing else) is the selection.  With nothing selected the hover selection takes the field under the cursor
 * when the collector keeps it: ctx.fieldAt already applies FilterCollectorForHierarchy (a field goes when its own
 * footprint is collected at the same point, by the footprint's hull within the accuracy), and any other item under
 * the cursor wins here as well (the field is then left to the ordinary candidates).
 */
export function requestField(ctx: PcbCtx, cursor: Pt | null): (FieldRef & { hover: boolean }) | null {
  if (S.forceHover || selectionIds(ctx).size || S.padSel) return null;
  const sel = typeof ctx.selectedField === "function" ? ctx.selectedField() : null;
  if (sel) return ctx.doc.items.has(sel.id) && footprintFieldNode(ctx.doc.items.get(sel.id)!.node, sel.name) ? { id: sel.id, name: sel.name, hover: false } : null;
  if (!cursor || typeof ctx.fieldAt !== "function") return null;
  const f = ctx.fieldAt(cursor); if (!f || !ctx.doc.items.has(f.id)) return null;
  let others: string[] = [];
  if (typeof ctx.candidatesAt === "function") { try { others = (ctx.candidatesAt(cursor) || []).map((id) => { const h = id.indexOf("#"); return h > 0 ? id.slice(0, h) : id; }).filter((id) => id !== f.id); } catch (e) { others = []; } }
  return others.length ? null : { id: f.id, name: f.name, hover: true };
}

/** One field of a footprint edited through fn (a clone of the footprint): the MODIFIED change, or null. */
function fieldChange(doc: BoardDoc, ref: FieldRef, fn: (field: SNode, fp: SNode) => boolean | void): PcbChange | null {
  const it = doc.items.get(ref.id); if (!it || it.kind !== "footprint") return null;
  const node = clone(it.node); const f = footprintFieldNode(node, ref.name); if (!f || !K.kid(f, "at")) return null;
  if (fn(f, node) === false) return null;
  return replacedChange(it, node);
}

/**
 * PCB_TEXT::Rotate about the field's own position (updateModificationPoint: a lone item turns about GetPosition()):
 * the position stays, the text angle becomes (angle + deg).Normalize(), as the file writes GetTextAngle() in [0, 360).
 */
export function rotateFieldChange(doc: BoardDoc, ref: FieldRef, deg: number): PcbChange | null {
  return fieldChange(doc, ref, (f) => { setAngleKid(f, angleKid(f) + deg); });
}

/**
 * PCB_TEXT::Flip about its own position (EDIT_TOOL::Flip, a lone item): the library position mirrors about itself
 * and so stays, the library angle reflects over the flip axis plus a half turn (left / right: lib -> -lib, so the
 * board angle 2·fpAngle − angle), the layer goes to the other side and a side-specific layer's text is mirrored.
 */
export function flipFieldChange(doc: BoardDoc, ref: FieldRef): PcbChange | null {
  return fieldChange(doc, ref, (f, fp) => {
    const a0 = K.atOf(fp)[2] || 0;
    setAngleKid(f, 2 * a0 - angleKid(f));
    flipLayerKid(f); toggleMirror(f);
  });
}

/**
 * EDIT_TOOL::DeleteItems on a PCB_FIELD: the field is hidden, never removed ("Hide Field"); an already hidden one
 * leaves the board alone and the infobar says "Use the Footprint Properties dialog to remove fields."
 */
export function hideFieldChanges(doc: BoardDoc, ref: FieldRef): PcbChange[] & { hideLabel?: string; infoError?: string } {
  const out: PcbChange[] & { hideLabel?: string; infoError?: string } = [];
  const it = doc.items.get(ref.id); if (!it) return out;
  const node = clone(it.node); const f = footprintFieldNode(node, ref.name); if (!f) return out;
  if (fieldIsHidden(f)) { out.infoError = "Use the Footprint Properties dialog to remove fields."; return out; }
  node.splice(node.indexOf(f), 1, hiddenFieldNode(f));
  out.push(replacedChange(it, node)); out.hideLabel = "Hide Field";
  return out;
}
