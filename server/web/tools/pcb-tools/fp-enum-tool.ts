// pcb-tools/fp-enum-tool.ts — PAD_TOOL::EnumeratePads's interactive loop (pcbnew/tools/pad_tool.cpp): after the
// Renumber Pads dialog, each pad clicked (or dragged over) takes the next number; clicking a renumbered pad again
// gives its old number back and that number goes to the next pad; a double-click (or another tool) pushes one
// "Renumber Pads" step; Esc reverts everything.  The new numbers show on the pads while the tool runs (local
// preview), the renumbered pads are highlighted, and the status popup follows the cursor.
import type { PcbCtx, Pt, PtrEvent } from "./types";
import { DBL_MS, S } from "./state";
import { replacedChange } from "./changes";
import { clone } from "./util";
import { enumBegin, enumChanges, enumPick, enumPopup, padsAlong, padsAt, type EnumState } from "./fp-pads";

interface EnumRun { st: EnumState; orig: Map<string, SNode>; last: Pt | null; cancelled: boolean; clickT: number; clickAt: Pt | null }

let run: EnumRun | null = null;
/** The parameters DIALOG_ENUM_PADS gave (set before the tool is armed). */
export let enumParams: { start: number; step: number; prefix: string } | null = null;
export function setEnumParams(p: { start: number; step: number; prefix: string } | null) { enumParams = p; }
export const enumRunning = () => !!run;

let escHooked = false;
function hookEsc() {
  if (escHooked || typeof document === "undefined") return; escHooked = true;
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && run) run.cancelled = true; }, true);
}

function popup(ctx: PcbCtx, at: Pt) { if (!run) return; S.popup = { text: enumPopup(run.st), at: at.slice() as Pt, until: Number.MAX_SAFE_INTEGER }; ctx.requestRender(); }

/** Show the session's numbers on the pads (a local change, never sent: the commit at the end is the step). */
function preview(ctx: PcbCtx) {
  if (!run || !ctx.doc) return;
  const ch: KChange[] = [];
  for (const [id, label] of run.st.numbers) {
    const it = ctx.doc.items.get(id); if (!it) continue;
    if (!run.orig.has(id)) run.orig.set(id, clone(it.node));
    if (String(it.node[1]) === label) continue;
    const n = clone(it.node); n[1] = label; ch.push(replacedChange(it, n));
  }
  if (ch.length && ctx.applyLocal) ctx.applyLocal(ch);
  ctx.setHighlight(new Set(run.st.picked));
}
/** Put every previewed pad back as it was (before the commit records the step, or on Esc). */
function restore(ctx: PcbCtx) {
  if (!run || !ctx.doc) return;
  const ch: KChange[] = [];
  for (const [id, node] of run.orig) { const it = ctx.doc.items.get(id); if (it) ch.push(replacedChange(it, node)); }
  if (ch.length && ctx.applyLocal) ctx.applyLocal(ch);
}

export function enumActivate(ctx: PcbCtx) {
  hookEsc();
  const p = enumParams || { start: 1, step: 1, prefix: "" };
  run = { st: enumBegin(p.prefix, p.start, p.step), orig: new Map(), last: null, cancelled: false, clickT: 0, clickAt: null };
  S.sel.clear(); S.padSel = null;
  if (ctx.setStatus) ctx.setStatus("Renumber Pads");
  popup(ctx, ctx.cursor || [0, 0]);
}
/** Leaving the tool: Esc reverts, anything else (another tool, a double-click) pushes the step. */
export function enumLeave(ctx: PcbCtx, commit: boolean) {
  if (!run) return;
  const r = run; restore(ctx);
  run = null; S.popup = null; ctx.setHighlight(null);
  if (commit && !r.cancelled && ctx.doc) { const ch = enumChanges(ctx.doc, r.st); if (ch.length) ctx.commit(ch, "Renumber Pads"); }
  if (ctx.setStatus) ctx.setStatus("");
  ctx.requestRender();
}
export function enumDown(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
  if (!run || !ctx.doc) return;
  // a double-click finishes (pointerdown's detail is not a click count in every browser: time and distance decide)
  const now = Date.now(), at = run.clickAt;
  const dbl = (ev.detail || 0) >= 2 || (!!at && now - run.clickT < DBL_MS && Math.hypot(mm[0] - at[0], mm[1] - at[1]) < 0.3);
  run.clickT = now; run.clickAt = mm.slice() as Pt;
  if (dbl) { enumLeave(ctx, true); ctx.setTool("select"); return; }
  run.last = mm.slice() as Pt;
  if (enumPick(run.st, ctx.doc, padsAt(ctx.doc, mm), true)) preview(ctx);
  popup(ctx, mm);
}
export function enumMove(ev: PtrEvent, mm: Pt, ctx: PcbCtx) {
  if (!run || !ctx.doc) return;
  if (ev && (ev.buttons || 0) & 1 && run.last) {   // a drag: every pad along the path since the last event
    if (enumPick(run.st, ctx.doc, padsAlong(ctx.doc, run.last, mm), false)) preview(ctx);
  }
  run.last = (ev && (ev.buttons || 0) & 1) ? mm.slice() as Pt : null;
  popup(ctx, mm);
}
