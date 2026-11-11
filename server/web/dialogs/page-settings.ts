// dialogs/page-settings.ts — File → Page Settings… (common/dialogs/dialog_page_settings.cpp), for both editors.
// OK sends one document-level change (see project.ts) carrying the new (paper …) and (title_block …).
import { E, applyChanges, isSch, publishUndo, redoStack, sendOp, toast, undoStack } from "./editor";
import { KD, checkbox, h, select, textInput } from "./dom";
import { PAPER_FORMATS, isoDate, pageSettingsChange, pageSettingsOf, type PageSettings } from "./logic";
import { currentDocEntry, projectDocs, readDoc, submitDocOp } from "./project";

type TbKey = "date" | "rev" | "title" | "company" | `comment${number}`;
const ROWS: [TbKey, string][] = [["date", "Issue Date:"], ["rev", "Revision:"], ["title", "Title:"], ["company", "Company:"],
  ...Array.from({ length: 9 }, (_, i) => [`comment${i + 1}`, `Comment${i + 1}:`] as [TbKey, string])];
const getTb = (p: PageSettings, k: TbKey): string => (k.startsWith("comment") ? p.comments[+k.slice(7) - 1] || "" : p[k as "date" | "rev" | "title" | "company"]);
const setTb = (p: PageSettings, k: TbKey, v: string): void => { if (k.startsWith("comment")) p.comments[+k.slice(7) - 1] = v; else p[k as "date" | "rev" | "title" | "company"] = v; };

/** Commit page settings on the open document: applied locally, sent as an op, undoable. */
export function commitPageSettings(next: PageSettings): boolean {
  if (!E.kdoc) return false;
  const before = pageSettingsChange(pageSettingsOf(E.kdoc)), after = pageSettingsChange(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  applyChanges([after]); sendOp([after]);
  undoStack.push({ label: "page settings", changes: [after], inverse: [before] }); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; publishUndo();
  return true;
}

function drawPreview(cv: HTMLCanvasElement, p: PageSettings): void {
  const c = cv.getContext("2d"); if (!c) return;
  const fmt = PAPER_FORMATS.find((f) => f.type === p.paper) || PAPER_FORMATS[1];
  let w = p.paper === "User" ? p.width : fmt.w, hh = p.paper === "User" ? p.height : fmt.h; if (p.portrait && p.paper !== "User") [w, hh] = [hh, w];
  const W = cv.width, H = cv.height, s = Math.min((W - 16) / w, (H - 16) / hh), x0 = (W - w * s) / 2, y0 = (H - hh * s) / 2;
  const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue("--ink-2") || "#555";
  c.clearRect(0, 0, W, H); c.fillStyle = "#fff"; c.strokeStyle = ink; c.lineWidth = 1;
  c.fillRect(x0, y0, w * s, hh * s); c.strokeRect(x0 + 0.5, y0 + 0.5, w * s, hh * s);
  c.strokeStyle = "#840000"; const m = 10 * s; c.strokeRect(x0 + m, y0 + m, w * s - 2 * m, hh * s - 2 * m);
  const tw = Math.min(108, w - 20) * s, th = Math.min(32, hh - 20) * s; c.strokeRect(x0 + w * s - m - tw, y0 + hh * s - m - th, tw, th);
  if (p.title) { c.fillStyle = "#840000"; c.font = `${Math.max(6, Math.min(10, th / 4))}px sans-serif`; c.fillText(p.title.slice(0, 40), x0 + w * s - m - tw + 3, y0 + hh * s - m - th / 2, tw - 6); }
}

export function openPageSettings(): void {
  const doc = E.kdoc as KDoc & { sheetCount?: number; pageNumber?: string; paper?: string; portrait?: boolean; titleBlock?: Record<string, string> } | null;
  if (!doc) return;
  const ro = !!E.viewOnly, p = pageSettingsOf(doc), exportTo = new Set<TbKey>(); let exportPaper = false;
  const others = isSch() ? projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== (currentDocEntry() || { docId: "" }).docId) : [];
  let preview: HTMLCanvasElement | null = null; const redraw = () => { if (preview) drawPreview(preview, p); };
  KD().open({ title: "Page Settings", width: 820, cls: "kd-wide", readOnly: ro,
    build(body) {
      const custom = () => p.paper === "User";
      const wIn = textInput(String(+p.width.toFixed(4)), (v) => { p.width = Math.max(0.254, +v || p.width); redraw(); }, { id: "kd-ps-width", type: "number", step: "1", disabled: ro || !custom() });
      const hIn = textInput(String(+p.height.toFixed(4)), (v) => { p.height = Math.max(0.254, +v || p.height); redraw(); }, { id: "kd-ps-height", type: "number", step: "1", disabled: ro || !custom() });
      const orient = select(["Landscape", "Portrait"], p.portrait ? "Portrait" : "Landscape", (v) => { p.portrait = v === "Portrait"; redraw(); }, { id: "kd-ps-orient", disabled: ro || custom() });
      // a standard paper shows its nominal size in the (disabled) custom fields, as the desktop dialog does
      const showSize = () => { if (custom()) return; const f = PAPER_FORMATS.find((x) => x.type === p.paper); if (!f) return; p.width = p.portrait ? f.h : f.w; p.height = p.portrait ? f.w : f.h; wIn.value = String(+p.width.toFixed(2)); hIn.value = String(+p.height.toFixed(2)); };
      orient.addEventListener("change", showSize);
      const size = select(PAPER_FORMATS.map((f) => [f.type, f.label] as [string, string]), p.paper, (v) => {
        p.paper = v; const c = custom(); wIn.disabled = hIn.disabled = ro || !c; orient.disabled = ro || c; if (c) { p.portrait = false; orient.value = "Landscape"; } showSize(); redraw(); }, { id: "kd-ps-size", disabled: ro });
      showSize();
      const left = h("div", { style: "width:230px;flex:none" },
        h("h3", null, "Paper"),
        h("div", { style: "display:grid;gap:4px" }, h("label", null, "Size:"), size, h("label", { style: "margin-top:6px" }, "Orientation:"), orient,
          h("label", { style: "margin-top:6px" }, "Custom paper size:"),
          h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content" }, h("label", null, "Height:"), hIn, h("span", { class: "ro" }, "mm"), h("label", null, "Width:"), wIn, h("span", { class: "ro" }, "mm"))),
        others.length ? checkbox("Export to other sheets", false, (on) => { exportPaper = on; }, { disabled: ro, id: "kd-ps-export-paper" }) : null,
        h("h3", null, "Preview"), (preview = h("canvas", { width: 220, height: 150, id: "kd-ps-preview", style: "border:1px solid var(--line);background:var(--panel)" })),
        h("h3", null, "Drawing Sheet"), h("div", { class: "kv" }, h("label", null, "File:"), textInput("", undefined, { disabled: true, placeholder: "(KiCad default)" })));
      const tb = h("div", { class: "kv", style: `grid-template-columns:max-content 1fr${others.length ? " max-content" : ""};align-items:center` });
      for (const [k, label] of ROWS) {
        const inp = textInput(getTb(p, k), (v) => { setTb(p, k, v); if (k === "title") redraw(); }, { id: "kd-ps-" + k, disabled: ro });
        let ctl: HTMLElement = inp;
        if (k === "date") {
          inp.style.flex = "1"; inp.style.minWidth = "90px";
          const pick = h("input", { type: "date", id: "kd-ps-datepick", style: "width:128px;flex:none", disabled: ro, value: isoDate(new Date()) });
          const set = h("button", { class: "btn sm", type: "button", title: "Use the date on the right", disabled: ro, id: "kd-ps-dateset", onclick: () => { const v = (pick as HTMLInputElement).value || isoDate(new Date()); inp.value = v; setTb(p, k, v); } }, "<<<");
          ctl = h("div", { class: "kd-row" }, inp, set, pick);
        }
        tb.append(h("label", null, label), ctl);
        if (others.length) tb.append(checkbox("Export to other sheets", false, (on) => { if (on) exportTo.add(k); else exportTo.delete(k); }, { disabled: ro }));
      }
      const right = h("div", { style: "flex:1;min-width:0" }, h("h3", null, "Title Block"),
        h("div", { class: "kd-row", style: "justify-content:space-between;margin-bottom:8px;color:var(--ink-2)" }, h("span", null, `Number of sheets: ${doc.sheetCount || 1}`), h("span", null, `Sheet number: ${doc.pageNumber || "1"}`)), tb);
      body.append(h("div", { style: "display:flex;gap:22px" }, left, right)); redraw();
    },
    ok() {
      if (ro) return;
      const changed = commitPageSettings(p);
      if (changed) toast("Page settings updated");
      if (others.length && (exportTo.size || exportPaper)) {
        const keys = [...exportTo], withPaper = exportPaper;
        Promise.all(others.map(async (d) => {
          const od = await readDoc(d.docId, "kicad_sch"); const op = pageSettingsOf(od as unknown as Parameters<typeof pageSettingsOf>[0]);
          for (const k of keys) setTb(op, k, getTb(p, k));
          if (withPaper) { op.paper = p.paper; op.portrait = p.portrait; op.width = p.width; op.height = p.height; }
          await submitDocOp(d.docId, [pageSettingsChange(op)]);
        })).then(() => toast(`Exported to ${others.length} other sheet${others.length === 1 ? "" : "s"}`), (e: Error) => toast("Export to other sheets failed: " + e.message, 4000));
      }
    } });
}
