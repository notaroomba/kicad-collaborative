import type { Mods, SchCtx, Pt } from "./types";
import { pinsAt } from "./connect";
import { ptsOf } from "./state";
import { r4 } from "./util";

// ---------------------------------------------------------------- cursor snapping
export function mmPerPx(ctx: SchCtx) {
  if (ctx.worldMm && ctx.stage) { try { const a = ctx.worldMm({ clientX: 0, clientY: 0 }), b = ctx.worldMm({ clientX: 100, clientY: 0 }); const v = (b[0] - a[0]) / 100; if (v > 0 && isFinite(v)) return v; } catch (e) { /* no layout yet */ } }
  return ctx.pxPerMm ? 1 / ctx.pxPerMm : 0.25;
}
// Grid snap, but a pin or line end within reach wins (KiCad's connection snapping).  As in every SCH tool loop,
// Shift turns the magnetic snap to anchors off (grid.SetSnap( !MD_SHIFT )) and Ctrl the grid (DisableGridSnapping).
/** The modifier keys of the event behind a click or a move. */
export function snapConn(ctx: SchCtx, mm: Pt, kind: string, ev?: Mods | null): Pt {
  const noGrid = !!(ev && (ev.ctrlKey || ev.metaKey)), noAnchors = !!(ev && ev.shiftKey);
  const g = noGrid ? [mm[0], mm[1]] : ctx.snap([mm[0], mm[1]]);
  if (noAnchors) return [r4(g[0]), r4(g[1])];
  const r = Math.max((ctx.gridPitch || 1.27) * 0.45, 6 * mmPerPx(ctx));
  let best: Pt | null = null as Pt | null, bd = r;
  const take = (x: number, y: number) => { const d = Math.hypot(x - mm[0], y - mm[1]); if (d < bd) { bd = d; best = [x, y]; } };
  if (kind !== "bus") for (const p of pinsAt(ctx.doc, mm[0], mm[1], r)) take(p.x, p.y);
  for (const it of ctx.doc.items.values()) { if (it.kind !== (kind || "wire")) continue; for (const p of ptsOf(it.node)) if (Math.abs(p[0] - mm[0]) <= r && Math.abs(p[1] - mm[1]) <= r) take(p[0], p[1]); }
  return best ? [r4(best[0]), r4(best[1])] : [r4(g[0]), r4(g[1])];
}
