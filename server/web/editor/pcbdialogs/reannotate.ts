// pcbdialogs/reannotate — Tools > Geographical Reannotate... (DIALOG_BOARD_REANNOTATE, dialog_board_reannotate_base.fbp):
// Footprint Order (eight directions with their pictures), Based on location of, Round locations to, Reannotation
// Scope, Exclude references, the front / back starts and prefixes, and the report.  "Reannotate PCB" renames the
// footprints as one "Annotation" commit and leaves the dialog open with the report; "Close" closes it.
import { E } from "../state";
import { store } from "../appstore";
import { pcbState } from "../gestures";
import { gridChoiceText, messageText, type GridDef } from "../../units";
type Units = Parameters<typeof messageText>[1];
import { checkField, h, messageBox, openDialog, reportPanel, selectField, type Field, type ReportLine } from "./ui";

type Severity = "info" | "action" | "warning" | "error";
interface Plan { ok: boolean; bad: unknown[]; report: { severity: Severity; text: string }[]; changes: KChange[]; renames: { from: string; to: string }[] }
interface PcbToolsApi {
  geographicalReannotate(doc: KDoc, o: Record<string, unknown>): Plan; reannotateOrder(code: number, pts: [number, number][]): number[];
  expandGroups?(doc: KDoc, ids: string[]): string[];
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
// m_sortButtons in order, with their tooltips
const DIRECTIONS: [string, string][] = [["Down_Right", "Horizontally: top left to bottom right"], ["Right_Down", "Horizontally: top right to bottom left"],
  ["Down_Left", "Horizontally: bottom left to top right"], ["Left_Down", "Horizontally:: bottom right to top left"], ["Up_Right", "Vertically: top left to bottom right"],
  ["Right_Up", "Vertically: bottom left to top right"], ["Up_Left", "Vertically: top right to bottom left"], ["Left_Up", "Vertically: bottom right to top left"]];
const VALIDPREFIX = "_-+=/\\";

/** BITMAPS::reannotate_*: a 3 x 3 grid of footprints and the path the sort takes through them. */
function directionPicture(code: number): HTMLCanvasElement {
  const cv = h("canvas", { class: "pd-reann-pic" }) as HTMLCanvasElement;
  const S = 40, dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  cv.width = S * dpr; cv.height = S * dpr; cv.style.width = S + "px"; cv.style.height = S + "px";
  requestAnimationFrame(() => {
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv), ink = css.getPropertyValue("--ink-2").trim() || "#52525B", acc = css.getPropertyValue("--copper").trim() || "#C83434";
    const pts: [number, number][] = []; for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) pts.push([8 + x * 12, 8 + y * 12]);
    const order = PT().reannotateOrder(code, pts);
    g.strokeStyle = acc; g.lineWidth = 1.5; g.beginPath();
    order.forEach((i, k) => { const [x, y] = pts[i]; if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    const a = pts[order[order.length - 2]], b = pts[order[order.length - 1]], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    g.fillStyle = acc; g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(b[0] - 5 * Math.cos(ang - 0.5), b[1] - 5 * Math.sin(ang - 0.5)); g.lineTo(b[0] - 5 * Math.cos(ang + 0.5), b[1] - 5 * Math.sin(ang + 0.5)); g.fill();
    g.fillStyle = ink; for (const [x, y] of pts) g.fillRect(x - 2, y - 2, 4, 4);
    const [sx, sy] = pts[order[0]]; g.strokeStyle = ink; g.lineWidth = 1; g.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
  });
  return cv;
}

export function openReannotate(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Geographical Reannotate needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const vp = store.get().viewport as { gridChoices: GridDef[]; units: Units; lastImperial: Units };
  const st = pcbState();
  const selected = new Set(st && st.sel ? (PT().expandGroups ? PT().expandGroups!(doc, Array.from(st.sel)) : Array.from(st.sel)) : []);
  const radios: HTMLInputElement[] = [];
  const order = h("div", { class: "pd-reann-dirs" });
  DIRECTIONS.forEach(([key, tip], i) => {
    const r = h("input", { type: "radio", name: "reann-dir", "data-k": key, checked: i === 0 }) as HTMLInputElement; radios.push(r);
    const pic = directionPicture(i); pic.title = tip;
    order.append(h("label", { class: "pd-reann-dir", title: tip }, r, pic));
  });
  const location = selectField<string>("0", [["0", "Footprint"], ["1", "Reference"]], { key: "locationChoice" });
  const grids = vp.gridChoices || [];
  const gi = Math.max(0, grids.findIndex((g) => Math.abs(g.mm - E.gridPitch) < 1e-9));
  const grid = selectField<string>(String(gi), grids.map((g, i): [string, string] => [String(i), gridChoiceText(g, vp.units, vp.lastImperial, "pcb")]), { key: "gridChoice" });
  grid.input.setAttribute("data-nopersist", "");
  location.el.style.width = "150px"; grid.el.style.width = "240px";   // m_Window.grid.last_size_idx
  const tipGrid = "Component position will be rounded\nto this grid before sorting.\nThis helps with misaligned parts.";
  const scopeRadio = (label: string, key: string, on = false): Field<boolean> => {
    const input = h("input", { type: "radio", name: "reann-scope", "data-k": key, checked: on }) as HTMLInputElement;
    return { el: h("label", { class: "pd-check" }, input, label), input, get: () => input.checked, set: (v) => { input.checked = v; } };
  };
  const all = scopeRadio("All", "annotateAll", true), fr = scopeRadio("Front", "annotateFront"), bk = scopeRadio("Back", "annotateBack"), sel = scopeRadio("Selection", "annotateSelection");
  // TransferDataToWindow: a selection picks Selection
  if (selected.size) sel.set(true);
  for (const r of [all, fr, bk, sel]) r.input.setAttribute("data-nopersist", "");
  const locked = checkField(false, "Exclude locked footprints", { key: "excludeLocked", tip: "Locked footprints will not be reannotated" });
  const exTip = "Do not re-annotate this type \nof reference (R means R*)";
  const exclude = h("input", { type: "text", "data-k": "excludeList", title: exTip, style: "width:100%" }) as HTMLInputElement;
  const text = (key: string, value: string, tip: string, digits: boolean): HTMLInputElement => {
    const el = h("input", { type: "text", "data-k": key, value, title: tip, style: digits ? "width:100px" : "width:100%" }) as HTMLInputElement;
    el.addEventListener("input", () => {
      if (digits) { const v = el.value.replace(/\D/g, ""); if (v !== el.value) el.value = v; return; }
      // FilterPrefix: a last character that is neither alphanumeric nor in VALIDPREFIX is dropped
      const c = el.value.slice(-1); if (c && !/[A-Za-z0-9]/.test(c) && !VALIDPREFIX.includes(c)) el.value = el.value.slice(0, -1);
    });
    return el;
  };
  const frontStart = text("frontRefDesStart", "1", "Default is 1", true);
  const backStart = text("backRefDesStart", "", "Leave blank or zero, or enter a number greater than the highest reference designation on the front.", true);
  const frontPrefix = text("frontPrefix", "", "Optional prefix for component side reference designations (e.g. F_)", false);
  const backPrefix = text("backPrefix", "", "Optional prefix for solder side reference designations (e.g. B_)", false);
  const rmFront = checkField(false, "Remove front prefix", { key: "removeFrontPrefix", tip: "If checked will remove the front side prefix\nin the front prefix box if present" });
  const rmBack = checkField(false, "Remove back prefix", { key: "removeBackPrefix", tip: "If checked will remove the Back side prefix\nin the back prefix box if present" });

  // WX_HTML_REPORT_PANEL (m_MessageWindow, report.txt): never cleared, so every run's messages follow the last one's
  const lines: ReportLine[] = [];
  const report = reportPanel("300px", { fileName: "report.txt", empty: "" });
  report.el.setAttribute("data-k", "report");
  const render = (): void => report.set(lines.slice());

  const opts = (): Record<string, unknown> => ({
    sortCode: Math.max(0, radios.findIndex((r) => r.checked)), useFootprintLocation: location.get() === "0", grid: (grids[Number(grid.get())] || { mm: 0.001 }).mm,
    scope: sel.get() ? "selection" : fr.get() ? "front" : bk.get() ? "back" : "all", selected, excludeLocked: locked.get(), exclude: exclude.value,
    frontStart: frontStart.value, backStart: backStart.value, frontPrefix: frontPrefix.value, backPrefix: backPrefix.value, removeFrontPrefix: rmFront.get(), removeBackPrefix: rmBack.get(),
    fmt: (mm: number) => messageText(mm, vp.units, "pcb") });
  const apply = (plan: Plan): void => {
    if (plan.changes.length) ctx.commit(plan.changes, "Annotation");
    lines.push({ severity: "action", text: "PCB successfully reannotated" },
      { severity: "warning", text: "PCB annotation changes should be synchronized with schematic using \"Update Schematic from PCB\"." });
    render(); ctx.requestRender();
  };
  openDialog({ title: "Geographical Reannotation", width: 760, okLabel: "Reannotate PCB", cancelLabel: "Close", persist: true,
    build(body) {
      const hd = (t: string): HTMLElement => h("div", { class: "pd-lbl", style: "font-weight:600;margin:6px 0 2px" }, t);
      const row = (...c: (HTMLElement | string)[]): HTMLElement => h("div", { style: "display:flex;align-items:center;gap:8px;margin:3px 0;flex-wrap:wrap" }, ...c);
      const grid4 = h("div", { style: "display:grid;grid-template-columns:auto 1fr auto 1fr;gap:4px 10px;align-items:center" },
        h("label", null, "Front reference start:"), frontStart, h("label", null, "Back reference start:"), backStart,
        h("label", null, "Front prefix:"), frontPrefix, h("label", null, "Back prefix:"), backPrefix,
        h("span"), rmFront.el, h("span"), rmBack.el);
      body.append(hd("Footprint Order"), h("hr", { class: "pd-sep" }), order,
        row(h("label", null, "Based on location of:"), location.el, h("label", { title: tipGrid }, "Round locations to:"), grid.el),
        hd("Reannotation Scope"), h("hr", { class: "pd-sep" }),
        row(all.el, fr.el, bk.el, sel.el, h("span", { style: "width:24px" }), locked.el),
        row(h("label", { title: exTip }, "Exclude references:"), h("div", { style: "flex:1;min-width:160px" }, exclude)),
        hd("Reference Designators"), h("hr", { class: "pd-sep" }), grid4,
        h("div", { style: "height:8px" }), report.el);
    },
    ok() {
      // OnApplyClick: the dialog stays open with the report
      const plan = PT().geographicalReannotate(doc, opts());
      lines.push(...plan.report); render();
      if (!plan.ok) return false;
      if (plan.bad.length) {
        const n = plan.bad.length;
        messageBox("Confirmation", `PCB has ${n} empty or invalid reference designations.\nYou may wish to run DRC with 'Test for parity between PCB and schematic' checked.\n \nReannotate anyway?`,
          [{ label: "Cancel" }, { label: "OK", fn: () => apply(plan) }], 0);
        return false;
      }
      apply(plan);
      return false;
    } });
}
