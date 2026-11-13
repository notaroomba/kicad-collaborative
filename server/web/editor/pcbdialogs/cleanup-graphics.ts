// pcbdialogs/cleanup-graphics — Tools > Cleanup Graphics... (DIALOG_CLEANUP_GRAPHICS, dialog_cleanup_graphics_base.fbp):
// Merge lines into rectangles, Delete redundant graphics, Fix discontinuities in board outlines with its Tolerance.
// Every checkbox reruns the dry run into "Changes to be applied:"; OK ("Update PCB") applies them as one
// "Cleanup Graphics" commit.  Selecting a change highlights its items on the board.
import { E } from "../state";
import { checkField, form, h, lenField, openDialog, unitLabel } from "./ui";

interface Opts { mergeRects: boolean; deleteRedundant: boolean; fixBoardOutlines: boolean; tolerance: number }
interface Plan { items: { text: string; ids: string[] }[]; changes: KChange[] }
interface PcbToolsApi { graphicsCleanup(doc: KDoc, o: Opts, dryRun: boolean): Plan; applySelection?(ctx: ToolCtx, ids: string[]): void }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

/** s_defaultTolerance: 2 mm, then whatever the last OK used, for the session. */
let lastTolerance = 2;

export function openCleanupGraphics(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Cleanup Graphics needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const setHl = (ids: string[] | null): void => { const c = ctx as ToolCtx & { setHighlight?(s: Set<string> | null): void }; if (c.setHighlight) c.setHighlight(ids && ids.length ? new Set(ids) : null); ctx.requestRender(); };
  const rects = checkField(false, "Merge lines into rectangles", { key: "createRectangles" });
  const redundant = checkField(false, "Delete redundant graphics", { key: "deleteRedundant" });
  const outlines = checkField(false, "Fix discontinuities in board outlines", { key: "fixBoardOutlines" });
  const tol = lenField(lastTolerance, { key: "tolerance", min: 0 });
  tol.input.setAttribute("data-nopersist", "");   // TransferDataToWindow sets it from s_defaultTolerance
  const list = h("div", { class: "pd-report", style: "height:250px;min-height:0", "data-k": "changes" });
  const opts = (): Opts => ({ mergeRects: rects.get(), deleteRedundant: redundant.get(), fixBoardOutlines: outlines.get(), tolerance: tol.get() });
  const dryRun = (): void => {
    setHl(null);
    const items = PT().graphicsCleanup(doc, opts(), true).items;
    list.replaceChildren(...items.map((it) => {
      const row = h("div", { class: "ln action", tabindex: "0" }, it.text);
      row.addEventListener("click", () => { for (const r of Array.from(list.children)) r.classList.toggle("sel", r === row); setHl(it.ids); });
      return row;
    }));
  };
  openDialog({ title: "Cleanup Graphics", width: 680, okLabel: "Update PCB", persist: true,
    build(body) {
      body.append(h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rects.el, redundant.el, outlines.el,
        h("div", { style: "margin-left:22px" }, form([["Tolerance:", tol.el, unitLabel()]]))),
        h("div", { class: "pd-lbl", style: "margin:10px 0 4px" }, "Changes to be applied:"), list);
      body.addEventListener("change", (ev) => { if (!list.contains(ev.target as Node)) dryRun(); });
      dryRun();
    },
    restored() { dryRun(); },
    cancel() { setHl(null); return true; },
    ok() {
      lastTolerance = tol.get();
      setHl(null);
      const sel = PT().applySelection; if (sel) sel(ctx, []);   // ACTIONS::selectionClear
      const plan = PT().graphicsCleanup(doc, opts(), false);
      if (plan.changes.length) ctx.commit(plan.changes, "Cleanup Graphics");
      ctx.requestRender();
      return true;
    } });
}
