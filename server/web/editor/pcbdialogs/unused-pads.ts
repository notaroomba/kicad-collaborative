// pcbdialogs/unused-pads — Tools > Remove Unused Pads... (GLOBAL_EDIT_TOOL::RemoveUnusedPads, DIALOG_UNUSED_PAD_LAYERS,
// dialog_unused_pad_layers_base.fbp): which items (Vias, Pads), Selected only and Keep outside layers, with the
// cross-section preview beside them.  OK ("Remove Unused Layers") sets remove_unused_layers on the plated through-hole
// pads and multi-layer vias in scope, Apply ("Restore All Layers") clears it; either is one "Remove Unused Pads" step.
import { E } from "../state";
import { pcbState } from "../gestures";
import { checkField, h, openDialog } from "./ui";

interface UnusedOpts { vias: boolean; pads: boolean; remove: boolean; keepOutside: boolean }
interface PcbToolsApi { unusedPadLayerChanges(doc: KDoc, ids: Iterable<string> | null, o: UnusedOpts): KChange[] }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

/**
 * BITMAPS::pads_remove_unused / pads_remove_unused_keep_bottom: a four-layer cross-section of a plated hole whose
 * inner rings are gone (dashed), the outside ones kept or not.
 */
function drawPreview(cv: HTMLCanvasElement, keepOutside: boolean): void {
  const g = cv.getContext("2d"); if (!g) return;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1, W = 150, H = 120;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(cv), v = (n: string, d: string): string => (css.getPropertyValue(n) || "").trim() || d;
  const copper = v("--copper", "#C83434"), board = v("--line-2", "#C8C8CE"), ink = v("--ink-3", "#71717A"), track = v("--teal", "#006464");
  const x0 = 10, x1 = W - 10, cx = W / 2, hole = 12, ring = 14;
  g.fillStyle = board; g.fillRect(x0, 18, x1 - x0, H - 36);
  g.clearRect(cx - hole, 18, hole * 2, H - 36);
  g.fillStyle = copper; g.fillRect(cx - hole, 18, 3, H - 36); g.fillRect(cx + hole - 3, 18, 3, H - 36);   // the barrel
  const ys = [18, 18 + (H - 36) / 3, 18 + 2 * (H - 36) / 3, H - 18];
  ys.forEach((y, i) => {
    const outer = i === 0 || i === ys.length - 1, connected = i === 1;   // a track on In1 keeps that ring
    if (connected) { g.fillStyle = track; g.fillRect(cx + hole + ring, y - 2, x1 - (cx + hole + ring), 4); }
    if (connected || (outer && keepOutside)) { g.fillStyle = copper; g.fillRect(cx - hole - ring, y - 2, ring, 4); g.fillRect(cx + hole, y - 2, ring, 4); }
    else { g.strokeStyle = ink; g.setLineDash([3, 2]); g.lineWidth = 1; g.strokeRect(cx - hole - ring + 0.5, y - 1.5, ring - 1, 3); g.strokeRect(cx + hole + 0.5, y - 1.5, ring - 1, 3); g.setLineDash([]); }
  });
}

export function openUnusedPads(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Remove Unused Pads needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const st = pcbState(); const selection = st && st.sel ? Array.from(st.sel) : [];
  const vias = checkField(false, "Vias", { key: "vias" }), pads = checkField(false, "Pads", { key: "pads" });
  const selOnly = checkField(false, "Selected only", { key: "selectedOnly" });
  const keep = checkField(true, "Keep outside layers", { key: "keepOutside", onChange: () => sync() });
  if (!selection.length) { (selOnly.input as HTMLInputElement).disabled = true; selOnly.el.classList.add("disabled"); selOnly.input.setAttribute("data-nopersist", ""); }
  const cv = h("canvas", { "data-k": "preview", "data-nopersist": "" }) as HTMLCanvasElement;
  const sync = (): void => drawPreview(cv, keep.get());
  const run = (remove: boolean): void => {
    const ids = selOnly.get() && selection.length ? selection : null;
    const changes = PT().unusedPadLayerChanges(doc, ids, { vias: vias.get(), pads: pads.get(), remove, keepOutside: keep.get() });
    if (changes.length) ctx.commit(changes, "Remove Unused Pads");
    ctx.requestRender();
  };
  const api = openDialog({ title: "Unused Pads", width: 380, okLabel: "Remove Unused Layers", persist: true,
    extra: [{ label: "Restore All Layers", fn: () => { run(false); api && api.close(); } }],
    build(body) {
      const left = h("div", { style: "display:flex;flex-direction:column;gap:2px" }, vias.el, pads.el, h("div", { style: "height:15px" }), selOnly.el, keep.el);
      body.append(h("div", { style: "display:grid;grid-template-columns:1fr auto;gap:0 16px;align-items:start" }, left, cv));
      sync();
    },
    restored() { sync(); },
    ok() { run(true); return true; } });
}
