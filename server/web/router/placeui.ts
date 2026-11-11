// Auto place — the editor side: Tools ▸ Auto Place Footprints….  Runs only when someone asks for it; the moves go
// through the editor's ordinary commit: one undo step, sent to everyone in the session as normal edits.
import { place, placementChanges, PlaceOptions, PlaceResult } from "./place";
import { refOf } from "./route";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = globalThis as any;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export interface AutoplaceSummary { moved: number; parts: number; groups: number; score: PlaceResult["score"] | null; ids: string[] }

/** Place and commit (headless; also the entry point for other tools).  `refs` limits it to those footprints. */
export function autoplace(ctx: any, opts: PlaceOptions & { refs?: string[] } = {}): AutoplaceSummary {
  const K = ctx.K || root.KiCadCanvas, P = root.PcbTools; const doc = ctx.doc; const none: AutoplaceSummary = { moved: 0, parts: 0, groups: 0, score: null, ids: [] };
  if (!doc || ctx.viewOnly) return none;
  const o: PlaceOptions = { footprints: opts.footprints, outline: opts.outline, spacing: opts.spacing, grid: opts.grid };
  if (!o.footprints && opts.refs && opts.refs.length) o.footprints = opts.refs.map((ref) => ({ ref }));
  const res = place(K, P, doc, P.designSettings(ctx.designSettings || null), o);
  const changes = placementChanges(K, P, doc, res.placements); const ids: string[] = changes.map((c: any) => c.id);
  if (changes.length) ctx.commit(changes, "auto place");
  if (ctx.requestRender) ctx.requestRender();
  return { moved: changes.length, parts: res.placements.length, groups: res.groups.length, score: res.score, ids };
}
export function placeSummaryText(s: AutoplaceSummary): string {
  if (!s.parts) return "Auto place: no footprints to place";
  let t = `Auto place: ${plural(s.moved, "footprint")} moved in ${plural(s.groups, "group")}`;
  if (s.score) { t += `, ${s.score.ratsnest.toFixed(0)} mm of connections left to route`; const bad = s.score.overlaps + s.score.outside; if (bad) t += ` — ${plural(bad, "footprint")} could not be fitted cleanly`; }
  return t;
}

const FIELD = "font:inherit;background:var(--panel);color:inherit;border:1px solid var(--line);border-radius:3px;padding:3px 5px";
/** Tools ▸ Auto Place Footprints…: the command behind the menu entry. */
export function openPlace(ctx: any): boolean {
  if (!ctx || !ctx.doc) return false; if (ctx.viewOnly) { ctx.toast("View-only access"); return true; }
  const KD = root.KDialogs, P = root.PcbTools, K = ctx.K || root.KiCadCanvas; if (!KD || typeof document === "undefined") { ctx.toast("Auto place: dialogs are unavailable here"); return true; }
  const doc = ctx.doc; const all: string[] = [], sel: string[] = []; const ids: Set<string> = P.selectionIds(ctx);
  for (const it of doc.items.values()) if (it.kind === "footprint") { const r = refOf(K, it.node); if (!r) continue; all.push(r); if (ids.has(it.id)) sel.push(r); }
  if (!all.length) { ctx.toast("Auto place: the board has no footprints"); return true; }
  const hasOutline = !!P.boardOutline(doc).outline; let scope: HTMLSelectElement, spacing: HTMLInputElement;
  const row = (body: HTMLElement, label: string, control: HTMLElement) => { const r = document.createElement("label"); r.style.cssText = "display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;margin:4px 0"; const s = document.createElement("span"); s.textContent = label; r.append(s, control); body.appendChild(r); };
  const note = (body: HTMLElement, text: string) => { const p = document.createElement("p"); p.className = "note"; p.style.margin = "6px 0"; p.textContent = text; body.appendChild(p); };
  KD.open({
    title: "Auto Place Footprints", width: 470, okLabel: "Place",
    build(body: HTMLElement) {
      scope = document.createElement("select"); scope.dataset.k = "scope"; scope.style.cssText = FIELD;
      scope.add(new Option(`All unlocked footprints (${all.length})`, "all"));
      if (sel.length) { scope.add(new Option(`Selected footprints (${sel.length})`, "sel")); scope.value = "sel"; }
      row(body, "Place", scope);
      spacing = document.createElement("input"); spacing.type = "number"; spacing.min = "0"; spacing.step = "0.05"; spacing.value = "0.5"; spacing.dataset.k = "spacing"; spacing.style.cssText = FIELD + ";width:90px;justify-self:start";
      row(body, "Spacing (mm)", spacing);
      note(body, "Small parts are gathered around the larger part they connect to, each group is laid out as a tight block, and the blocks are then placed and rotated where their connections are shortest. Footprints that are not being placed, and parts nothing connects to such as mounting holes, stay where they are and are kept clear of.");
      note(body, hasOutline ? "Parts are kept inside the board outline. Tracks already attached to a footprint are not moved with it." : "The board has no outline yet: parts are placed in an area sized for them, and you can draw the outline around the result.");
    },
    ok() {
      const sp = Math.max(0, +spacing.value || 0);
      const s = autoplace(ctx, { refs: scope.value === "sel" ? sel : undefined, spacing: sp });
      ctx.toast(placeSummaryText(s), 6000);
      return undefined;
    },
  });
  return true;
}
