// pcbdialogs/find.ts — the board editor's Edit > Find (Ctrl+F): pcbnew/dialogs/dialog_find.cpp (DIALOG_FIND) with
// PCB_EDIT_FRAME::ShowFindDialog / FindNext and PCB_SELECTION_TOOL::FindItem.  A modeless dialog that lives for the
// session like m_findDialog: "Search for:" with the last ten searches, the match options, the item kinds, Find Next
// (default, Enter, F3), Find Previous (Shift+F3), Restart Search, Close, the status line and "Show search panel".
// The hit list is rebuilt when the search string changes, on Restart Search and after any board change
// (the BOARD_LISTENER callbacks that clear m_upToDate); each hit is selected and brought into view.
import { comboInput } from "../../dialogs/dom";
import { E } from "../state";
import { applyView, mmH, mmW, mmX0, mmY0, stage, world } from "../view";
import { centerOn } from "../comments";
import { clearSelection, filterAllows } from "../selection";
import { keyName } from "../../keys";
import { setStatusBar } from "../appstore";
import { showPane } from "../panes";
import { toolCtx } from "../tools";
import { h, openDialog, type DialogApi } from "./ui";

interface FindOpts { findString: string; matchCase: boolean; wholeWord: boolean; wildcards: boolean; hiddenFields: boolean; references: boolean; values: boolean; texts: boolean; markers: boolean; nets: boolean }
type Hit = { kind: "item"; id: string; what: string } | { kind: "marker"; index: number; x: number; y: number; text: string } | { kind: "net"; name: string; code: number };
interface FindApi {
  boardFindHits(doc: KDoc, o: FindOpts, src: { markers?: { x: number; y: number; text: string }[]; nets?: { name: string; code: number }[] }): Hit[];
  unescapeKiCad(s: string): string;
  netTable(doc: KDoc): { key(net: unknown): string };
  netOf(node: SNode): unknown;
  findStep(pos: number, count: number, forward: boolean, fresh: boolean, wrap: boolean): { pos: number; endReached: boolean };
  netlist(doc: KDoc): { nets: Map<string, { name: string; code: number; tracks: { id: string }[]; vias: { id: string }[]; zones: { id: string }[]; pads: { id: string }[] }> };
  state: { docVer: number; markers: { x: number; y: number; text: string }[]; sel: Set<string>; padSel: string | null };
}
const PT = (): FindApi | null => (window as unknown as { PcbTools?: FindApi }).PcbTools || null;

// the dialog's controls keep their values between openings (the dialog is created once per frame)
const O = { matchCase: false, wholeWord: false, wildcards: false, wrap: true, references: true, values: true, texts: true, markers: true, nets: true, hiddenFields: false };
const HISTORY_KEY = "kui.pcbFindHistory";
let history: string[] = (() => { try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, 10) : []; } catch (e) { return []; } })();
let hits: Hit[] = [], pos = -1, upToDate = false, builtFor = "", current: Hit | null = null;
let dlg: DialogApi | null = null, combo: HTMLInputElement | null = null, statusEl: HTMLElement | null = null;
let searchText = history[0] || "";

function saveHistory(): void { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) { /* private window */ } }
function setStatus(t: string): void { if (statusEl) statusEl.textContent = t; }
/** The board version the hit list was built for: any edit, local or remote, makes it stale (BOARD_LISTENER). */
function boardKey(): string { const P = PT(); return E.kdoc ? `${E.kdoc.items.size}|${P ? P.state.docVer : 0}|${P ? P.state.markers.length : 0}|${(E.kdoc as unknown as { __id?: string }).__id || ""}` : ""; }
let lastDoc: unknown = null;

/** A board point (mm) in client pixels. */
function toClient(x: number, y: number): [number, number] {
  const w = world.getBoundingClientRect();
  return [w.left + ((x - mmX0()) / mmW()) * w.width, w.top + ((y - mmY0()) / mmH()) * w.height];
}
type Rect = { l: number; t: number; r: number; b: number };
const grow = (q: Rect, d: number): Rect => ({ l: q.l - d, t: q.t - d, r: q.r + d, b: q.b + d });
const inside = (q: Rect, p: [number, number]) => p[0] >= q.l && p[0] <= q.r && p[1] >= q.t && p[1] <= q.b;
/** EDA_DRAW_FRAME::FocusOnLocation: the view moves only when the point is off screen (or within 10 % of the edge) or
 *  behind a dialog (or within 10 % of it); it is then centred in the largest part of the canvas the dialogs leave free
 *  (VIEW::SetCenter( aPos, obscuringScreenRects )). */
function focusOnLocation(x: number, y: number): void {
  const s = stage.getBoundingClientRect(); const view: Rect = { l: s.left, t: s.top, r: s.right, b: s.bottom };
  const dialogs: Rect[] = Array.from(document.querySelectorAll<HTMLElement>(".kd-dialog")).filter((d) => d.offsetParent !== null).map((d) => { const r = d.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
  const p = toClient(x, y);
  let center = !inside(grow(view, -(view.r - view.l) / 10), p);
  for (const d of dialogs) if (inside(grow(d, (d.r - d.l) / 10), p)) center = true;
  if (!center) return;
  // the free areas beside the dialogs, inside the canvas: the largest one gets the point at its centre
  let best: Rect = view, area = 0;
  const cands: Rect[] = [view];
  for (const d of dialogs) {
    if (d.r < view.l || d.l > view.r || d.b < view.t || d.t > view.b) continue;
    cands.length = 0;
    cands.push({ ...view, r: Math.min(view.r, d.l) }, { ...view, l: Math.max(view.l, d.r) }, { ...view, b: Math.min(view.b, d.t) }, { ...view, t: Math.max(view.t, d.b) });
    break;
  }
  for (const c of cands) { const a = Math.max(0, c.r - c.l) * Math.max(0, c.b - c.t); if (a > area) { area = a; best = c; } }
  centerOn(x, y);   // the point at the canvas centre, then shifted to the free area's centre
  const want: [number, number] = [(best.l + best.r) / 2, (best.t + best.b) / 2], now = toClient(x, y);
  E.panX += want[0] - now[0]; E.panY += want[1] - now[1]; applyView();
}

/** PCB_SELECTION_TOOL::FindItem: select the hit and bring it into view, zooming out (never in) when it does not fit. */
function focusHit(hit: Hit): void {
  const doc = E.kdoc; const P = PT(); if (!doc || !P) return;
  clearSelection();
  let center: [number, number] | null = null, box: number[] | null = null;
  if (hit.kind === "item") {
    const it = doc.items.get(hit.id); if (!it) return;
    toolCtx().setSelection([hit.id]);
    if (it.bbox) box = [it.bbox[0], it.bbox[1], it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1]];
    const at = it.kind === "zone" || !it.bbox ? null : KiCadCanvas.atOf(it.node);
    center = at ? [at[0], at[1]] : box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : null;
  } else if (hit.kind === "marker") {
    center = [hit.x, hit.y];
  } else if (hit.name) {   // netCode > 0: not the unconnected net
    // SelectAllItemsOnNet: the net's tracks, arcs and vias; the view goes to the net's bounding box centre
    const net = [...P.netlist(doc).nets.values()].find((n) => n.name === hit.name);
    if (net) {
      // PCB_TRACE_T, PCB_ARC_T, PCB_VIA_T and PCB_SHAPE_T (graphics assigned to the net), each through itemPassesFilter
      const NT = P.netTable(doc);
      const shapes = [...doc.items.values()].filter((it) => /^gr_/.test(it.kind) && it.kind !== "gr_text" && it.kind !== "gr_text_box" && KiCadCanvas.kid(it.node, "net") && NT.key(P.netOf(it.node)) === hit.name);
      const ids = [...new Set([...net.tracks, ...net.vias, ...shapes].map((c) => c.id))].filter((id) => { const it = doc.items.get(id); return !!it && filterAllows(it.kind, it); });
      toolCtx().setSelection(ids);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of [...net.tracks, ...net.vias, ...net.zones, ...net.pads]) { const b = doc.items.get(c.id)?.bbox; if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); } }
      if (x0 < Infinity) { box = [x0, y0, x1 - x0, y1 - y0]; center = [(x0 + x1) / 2, (y0 + y1) / 2]; }
    }
  }
  if (!center) { toolCtx().requestRender(); return; }
  focusOnLocation(center[0], center[1]);
  if (box && box[2] > 0 && box[3] > 0) {
    // the viewport in mm, halved for the margin: zoom out until the item fits it
    const ppm = stage.clientWidth / mmW(), vw = stage.clientWidth / (ppm * E.zoom), vh = stage.clientHeight / (ppm * E.zoom);
    const scale = Math.min(vw / 2 / box[2], vh / 2 / box[3]);
    if (scale < 1) { E.zoom *= scale; E.viewTouched = true; applyView(); focusOnLocation(box[0] + box[2] / 2, box[1] + box[3] / 2); }
  }
  toolCtx().requestRender();
}

/** DIALOG_FIND::search( aDirection ). */
export function search(forward: boolean): void {
  const P = PT(), doc = E.kdoc; if (!P || !doc) return;
  if (combo) searchText = combo.value;
  if (!searchText) { if (!boardFindIsOpen()) openBoardFind(); return; }
  // the search string moves to the top of the history (at most ten)
  const idx = history.indexOf(searchText);
  if (idx !== 0) { if (idx > 0) history.splice(idx, 1); history.unshift(searchText); history = history.slice(0, 10); upToDate = false; saveHistory(); }
  if (doc !== lastDoc || boardKey() !== builtFor) upToDate = false;
  let fresh = false;
  if (!upToDate) {
    setStatus("Searching...");
    const nets = [...P.netlist(doc).nets.values()].map((n) => ({ name: n.name, code: n.code }));
    hits = P.boardFindHits(doc, { findString: searchText, ...O }, { markers: P.state.markers, nets });
    upToDate = true; fresh = true; builtFor = boardKey(); lastDoc = doc;
  }
  const step = P.findStep(pos, hits.length, forward, fresh, O.wrap); pos = step.pos;
  if (!hits.length) {
    setStatusBar({ message: "" });
    const msg = `'${searchText}' not found`; toolCtx().toast(msg); setStatus(msg); current = null;
  } else if (step.endReached || pos >= hits.length) {
    setStatusBar({ message: "" });
    toolCtx().toast("No more items to show"); setStatus("No hits");
  } else {
    current = hits[pos]; focusHit(current);
    setStatusBar({ message: `'${searchText}' found` });
    setStatus(`Hit(s): ${pos + 1} / ${hits.length}`);
  }
}
/** PCB_EDIT_FRAME::FindNext (F3 / Shift+F3): opens the dialog the first time. */
export function boardFindNext(reverse: boolean): void { if (!boardFindIsOpen()) openBoardFind(); search(!reverse); }
export function boardFindIsOpen(): boolean { return !!dlg && !!dlg.dialog.isConnected; }

/** PCB_EDIT_FRAME::ShowFindDialog: preload the value of a selected footprint or the text of a selected text. */
export function openBoardFind(): void {
  const doc = E.kdoc; if (!doc) return;
  let preload = "";
  const ids = new Set<string>(E.selection as Set<string>); if (E.selected) ids.add(E.selected.id); const P = PT(); if (P) for (const id of P.state.sel) ids.add(id);
  const unesc = (t: string) => (P ? P.unescapeKiCad(t) : t);
  const at = current && current.kind === "item" ? current.id : null;
  if (E.selField && !ids.size) {
    // PCB_FIELD_T: a footprint's Reference, Value or user field picked on its own
    const it = doc.items.get(E.selField.id), name = E.selField.name;
    if (it) {
      const p = KiCadCanvas.kids(it.node, "property").find((q) => KiCadCanvas.str(q[1]) === name)
        || KiCadCanvas.kids(it.node, "fp_text").find((q) => KiCadCanvas.str(q[1]) === name.toLowerCase());
      if (p) preload = unesc(KiCadCanvas.str(p[2])).split("\n")[0];
    }
  } else if (ids.size === 1) {
    const it = doc.items.get([...ids][0]);
    if (it && it.id !== at) {
      if (it.kind === "footprint") { const v = KiCadCanvas.kids(it.node, "property").find((p) => KiCadCanvas.str(p[1]) === "Value") || KiCadCanvas.kids(it.node, "fp_text").find((p) => KiCadCanvas.str(p[1]) === "value"); preload = unesc(v ? KiCadCanvas.str(v[2]) : it.value || ""); }
      else if (it.kind === "gr_text") preload = unesc(KiCadCanvas.str(it.node[1])).split("\n")[0];
    }
  }
  if (preload) searchText = preload;
  if (dlg && dlg.dialog.isConnected) { if (combo) { if (preload) combo.value = preload; combo.focus(); combo.select(); } return; }
  dlg = openDialog({ title: "Find", width: 560, modeless: true, noOk: true,
    build(body, api) {
      const foot = api.dialog.querySelector<HTMLElement>(".kd-foot"); if (foot) foot.style.display = "none";
      combo = h("input", { id: "kd-pfind-q", type: "text", class: "kd-input", title: "Text with optional wildcards", value: searchText, style: "flex:1;min-width:0", autocomplete: "off" });
      comboInput(combo, () => history.slice());   // the search history drop-down
      combo.addEventListener("input", () => { searchText = combo!.value; });
      combo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); search(true); } });
      const chk = (label: string, key: keyof typeof O, id: string) => {
        const box = h("input", { type: "checkbox", id, checked: O[key] }) as HTMLInputElement;
        box.addEventListener("change", () => { O[key] = box.checked; if (key !== "wrap") upToDate = false; });   // DIALOG_FIND::onOptionChanged
        return h("label", { class: "kd-chk", style: "display:flex;align-items:center;gap:6px;margin:3px 0;white-space:nowrap" }, box, label);
      };
      const btn = (label: string, id: string, fn: () => void, primary = false) => h("button", { class: "btn" + (primary ? " primary" : ""), type: "button", id, style: "width:120px", onclick: fn }, label);
      const left = h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px" }, h("label", { for: "kd-pfind-q" }, "Search for:"), combo),
        h("div", { style: "display:grid;grid-template-columns:max-content max-content;gap:0 24px" },
          chk("Match case", "matchCase", "kd-pfind-case"), h("span"), chk("Whole words only", "wholeWord", "kd-pfind-word"), h("span"),
          chk("Wildcards", "wildcards", "kd-pfind-wild"), h("span"), chk("Wrap", "wrap", "kd-pfind-wrap"), h("span")),
        h("hr", { style: "border:none;border-top:1px solid var(--line);margin:8px 0" }),
        h("div", { style: "display:grid;grid-template-columns:max-content max-content;gap:0 24px" },
          chk("Search footprint reference designators", "references", "kd-pfind-refs"), chk("Search DRC markers", "markers", "kd-pfind-markers"),
          chk("Search footprint values", "values", "kd-pfind-values"), chk("Search net names", "nets", "kd-pfind-nets"),
          chk("Include hidden fields", "hiddenFields", "kd-pfind-hidden"), chk("Search other text items", "texts", "kd-pfind-texts")));
      const right = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:none" },
        btn("Find Next", "kd-pfind-next", () => search(true), true),
        btn("Find Previous", "kd-pfind-prev", () => search(false)),
        btn("Restart Search", "kd-pfind-restart", () => { upToDate = false; search(true); }),
        btn("Close", "kd-pfind-close", () => api.close()));
      statusEl = h("div", { id: "kd-pfind-status", style: "min-height:16px;color:var(--ink-2);flex:1" });
      const link = h("a", { href: "#", id: "kd-pfind-panel", style: "color:var(--accent);white-space:nowrap" }, "Show search panel (" + keyName("Ctrl+G") + ")");
      link.addEventListener("click", (ev) => { ev.preventDefault(); showPane("search", true); api.close(); setTimeout(() => { const b = document.getElementById("searchBox") as HTMLInputElement | null; if (b) b.focus(); }, 50); });
      body.append(h("div", { style: "display:flex;gap:16px" }, left, right), h("div", { style: "display:flex;align-items:center;gap:12px;margin-top:10px" }, statusEl, link));
      // F3 / Shift+F3 work while the dialog has the focus (DIALOG_FIND::OnCharHook)
      api.dialog.addEventListener("keydown", (ev) => { if (ev.key === "F3") { ev.preventDefault(); ev.stopPropagation(); search(!ev.shiftKey); } });
      setTimeout(() => { if (combo) { combo.focus(); combo.select(); } }, 0);
    },
    cancel() { dlg = null; combo = null; statusEl = null; } });
}

// dialogs/index.ts (Edit > Find, Ctrl+F, F3 / Shift+F3) reaches the dialog through these
(E.hooks as Record<string, unknown>).boardFind = openBoardFind;
(E.hooks as Record<string, unknown>).boardFindNext = boardFindNext;
