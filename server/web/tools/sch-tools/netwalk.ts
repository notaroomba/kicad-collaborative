import type { SchCtx } from "./types";
import { cursorOf, selectedItems, setSelectionIds } from "./commands";
import { isNetLine } from "./drag";
import { NET_PICK, netItems, pickNet } from "./highlight";
import { hitNonSymbol } from "./hit";
import { mmPerPx } from "./snap";

// ---------------------------------------------------------------- select connection / node, net walking
export function selectConnection(ctx: SchCtx) {
  const doc = ctx.doc, ids = new Set<string>();
  for (const it of selectedItems(ctx)) if (NET_PICK.has(it.kind) || it.kind === "symbol" || it.kind === "sheet") for (const id of netItems(doc, it, cursorOf(ctx))) ids.add(id);
  if (!ids.size) { const pick = pickNet(ctx, cursorOf(ctx)); if (pick) for (const id of netItems(doc, pick.item, pick.at)) ids.add(id); }
  if (!ids.size) return false;
  setSelectionIds(ctx, ids); return true;
}
export function selectNode(ctx: SchCtx) {
  const hit = hitNonSymbol(ctx.doc, cursorOf(ctx)[0], cursorOf(ctx)[1], Math.max(0.3, 5 * mmPerPx(ctx)));
  if (!hit || !isNetLine(hit.kind)) return false;
  setSelectionIds(ctx, [hit.id]); return true;
}
export function stepNetItem(ctx: SchCtx, dir: number) {
  const items = selectedItems(ctx); if (!items.length) return false;
  const ids = Array.from(netItems(ctx.doc, items[0], cursorOf(ctx))).sort(); if (ids.length < 2) return false;
  const i = ids.indexOf(items[0].id), next = ids[((i < 0 ? 0 : i) + dir + ids.length) % ids.length];
  setSelectionIds(ctx, [next]); return true;
}
export function unselectAll(ctx: SchCtx) { setSelectionIds(ctx, []); return true; }
