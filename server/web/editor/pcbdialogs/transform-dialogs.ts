// transform-dialogs.ts — the board's edit dialogs that pcb-tools.js asks the editor to show (pcb.setRoutingDialogs):
//   · DIALOG_MOVE_EXACT, "Move Item" (Shift+M): Move X / Move Y (or Distance / Angle in polar coordinates) and Rotate,
//     each with Reset, the rotation anchor and the board-area bounds check; the values are remembered (DIALOG_SHIM);
//   · DIALOG_POSITION_RELATIVE (Shift+P): the reference (local origin, grid origin, a picked item or point) and the offset;
//   · DIALOG_SWAP_LAYERS: "Move items on:" / "To layer:" over the enabled copper layers;
//   · DIALOG_CLEANUP_TRACKS_AND_VIAS: the actions, the item filters and the two-step Build Changes / Update PCB.
import { E } from "../state";
import { store } from "../appstore";
import { box, checkField, currentUnits, fmtLen, h, lenField, numField, openDialog, parseLen, put, selectField, unitLabel, unitName, type DialogApi, type Field } from "./ui";
import "../../components/kselect";

type Pt = [number, number];
type MoveExactResult = { dx: number; dy: number; rotation: number; about: "anchor" | "center" | Pt };
interface CleanupDialogOpts { shorts: boolean; vias: boolean; danglingVias: boolean; merge: boolean; dangling: boolean; inPads: boolean; refill: boolean; net: string | null; netclass: string | null; layer: string | null; selectedOnly: boolean }
interface CleanupRequest {
  nets: string[]; netclasses: string[]; copper: string[]; activeLayer: string; highlightNet: string | null; currentNetclass: string;
  plan(o: CleanupDialogOpts): { text: string; ids: string[] }[]; apply(o: CleanupDialogOpts): number; focus(ids: string[] | null): void;
}

// ---------------------------------------------------------------- helpers
/** ORIGIN_TRANSFORMS::ToDisplay / FromDisplay for REL_X_COORD / REL_Y_COORD: a relative value only changes its sign. */
const relSign = (axis: "x" | "y"): number => { const vp = store.get().viewport as { invertX?: boolean; invertY?: boolean }; return (axis === "x" ? vp.invertX : vp.invertY) ? -1 : 1; };
const loadState = <T>(key: string): T | null => { try { return JSON.parse(localStorage.getItem("pd.state." + key) || "null") as T | null; } catch (e) { return null; } };
const saveState = (key: string, v: unknown): void => { try { localStorage.setItem("pd.state." + key, JSON.stringify(v)); } catch (e) { /* nothing remembered */ } };
const fmtDeg = (d: number): string => String(+d.toFixed(4));
/** EDA_ANGLE( VECTOR2D( x, y ) ) in degrees, as ToPolarDeg gives it (y down: the board's own sense). */
const polarOf = (x: number, y: number): { r: number; q: number } => { const r = Math.hypot(x, y); return { r, q: r ? (Math.atan2(y, x) * 180) / Math.PI : 0 }; };
/** A length / angle pair that switches between Cartesian and polar labels and units (updateDialogControls). */
function xyPair(labels: [string, string], keys: [string, string]) {
  const xl = h("label", null, labels[0]), yl = h("label", null, labels[1]);
  const x = lenField(0, { key: keys[0] }), yLen = lenField(0, { key: keys[1] });
  const yu = unitLabel();
  let polar = false;
  const yAng = numField(0, { key: keys[1] + "Angle" }); yAng.el.style.display = "none";
  const setPolar = (on: boolean, texts: [string, string]): void => { polar = on; xl.textContent = texts[0]; yl.textContent = texts[1]; yLen.el.style.display = on ? "none" : ""; yAng.el.style.display = on ? "" : "none"; yu.textContent = on ? "deg" : unitName(); };
  return { xl, yl, x, yLen, yAng, yu, setPolar, isPolar: () => polar };
}
const resetBtn = (tip: string, fn: () => void): HTMLButtonElement => { const b = h("button", { type: "button", class: "btn", title: tip }, "Reset"); b.addEventListener("click", fn); return b; };

// ---------------------------------------------------------------- Move Item
export function openMoveExact(req: { single: boolean; bbox: number[] | null }, done: (v: MoveExactResult) => void): void {
  // m_hash_key: the title, the anchor and the frame, so the state is not shared between the two cases
  const key = "Move Item" + (req.single ? "" : "|with_selection") + "|pcb_editor";
  const st = loadState<{ x: string; y: string; rot: string; anchor: number; polar: boolean; units: string }>(key);
  const pair = xyPair(["Move X:", "Move Y:"], ["moveX", "moveY"]);
  const rot = numField(0, { key: "rotate" });
  const anchors: [number, string][] = [[0, req.single ? "Rotate around item anchor" : "Rotate around selection center"], [1, "Rotate around local coordinates origin"], [2, "Rotate around drill/place origin"]];
  const anchor = selectField<number>(0, anchors, { key: "anchor" });
  const polar = checkField(false, "Use polar coordinates", { key: "polar" });
  // m_stateX / m_stateY / m_stateRadius / m_stateTheta (OnPolarChanged keeps the exact values across switches)
  let sx = 0, sy = 0, sr = 0, sq = 0;
  const readXY = (): Pt => [pair.x.get(), pair.isPolar() ? pair.yAng.get() : pair.yLen.get()];
  const onPolar = (on: boolean): void => {
    const [a, b] = readXY();
    pair.setPolar(on, on ? ["Distance:", "Angle:"] : ["Move X:", "Move Y:"]);
    if (on) {
      if (a !== sx || b !== sy) { sx = a; sy = b; const p = polarOf(sx, sy); sr = p.r; sq = p.q; }
      pair.x.set(sr); pair.yAng.set(+sq.toFixed(4));
    } else {
      if (a !== sr || b !== sq) { sr = a; sq = b; sx = sr * Math.cos((sq * Math.PI) / 180); sy = sr * Math.sin((sq * Math.PI) / 180); }
      pair.x.set(+sx.toFixed(6)); pair.yLen.set(+sy.toFixed(6));
    }
    check();
  };
  polar.input.addEventListener("change", () => onPolar(polar.get()));
  let api: DialogApi | null = null;
  // OnTextChanged: a move past the largest board (INT_MAX / √2 nm from the origin) is refused
  const MAX = (2147483647 * Math.SQRT1_2) / 1e6;
  const translation = (): Pt => {
    const [a, b] = readXY();
    const t: Pt = pair.isPolar() ? [a * Math.cos((b * Math.PI) / 180), a * Math.sin((b * Math.PI) / 180)] : [a, b];
    return [t[0] * relSign("x"), t[1] * relSign("y")];
  };
  const check = (): void => {
    const [dx, dy] = translation(), b = req.bbox;
    const bad = !!b && (b[0] + dx < -MAX || b[2] + dx > MAX || b[1] + dy < -MAX || b[3] + dy > MAX);
    const msg = bad ? "Invalid movement values.  Movement would place selection outside of the maximum board area." : "";
    for (const i of [pair.x.input, pair.yLen.input, pair.yAng.input]) { i.title = msg; i.classList.toggle("pd-bad", bad); }
    if (api && api.okButton) api.okButton.disabled = bad;
  };
  // OnTextFocusLost: an emptied entry shows 0
  for (const i of [pair.x.input, pair.yLen.input, pair.yAng.input, rot.input]) { i.addEventListener("blur", () => { if (!i.value.trim()) { i.value = "0"; i.dispatchEvent(new Event("change")); } }); i.addEventListener("input", () => setTimeout(check, 0)); i.addEventListener("change", check); }
  const clearX = resetBtn("", () => { pair.x.set(0); check(); api && api.okButton && api.okButton.focus(); });
  const clearY = resetBtn("", () => { if (pair.isPolar()) pair.yAng.set(0); else pair.yLen.set(0); check(); api && api.okButton && api.okButton.focus(); });
  const clearRot = resetBtn("", () => { rot.set(0); api && api.okButton && api.okButton.focus(); });
  api = openDialog({ title: "Move Item", width: 440,
    build(body) {
      const f = h("div", { class: "pd-form pd-form4" });
      f.append(pair.xl, pair.x.el, unitLabel(), clearX, pair.yl, h("span", null, pair.yLen.el, pair.yAng.el), pair.yu, clearY, h("label", null, "Rotate:"), rot.el, unitLabel("deg"), clearRot);
      put(body, f, h("div", { class: "pd-row", style: "margin-top:6px" }, anchor.el), polar.el);
      if (st) {
        // DIALOG_SHIM::LoadControlState: lengths come back only in the units they were typed in
        if (st.polar) { polar.set(true); pair.setPolar(true, ["Distance:", "Angle:"]); }
        if (st.units === currentUnits()) { const x = parseLen(st.x); if (!isNaN(x)) pair.x.set(x); if (st.polar) pair.yAng.set(Number(st.y) || 0); else { const y = parseLen(st.y); if (!isNaN(y)) pair.yLen.set(y); } }
        else if (st.polar) pair.yAng.set(Number(st.y) || 0);
        rot.set(Number(st.rot) || 0); anchor.set(Math.min(2, Math.max(0, st.anchor | 0)));
        sx = pair.isPolar() ? 0 : pair.x.get(); sy = pair.isPolar() ? 0 : pair.yLen.get();
      }
      setTimeout(() => { pair.x.input.focus(); (pair.x.input as HTMLInputElement).select(); check(); }, 0);
    },
    cancel() { remember(); return true; },
    ok() {
      remember();
      const [dx, dy] = translation(), a = anchor.get();
      const o = (E.pcbOrigins || {}) as { aux?: Pt };
      const about: MoveExactResult["about"] = a === 1 ? [E.localOrigin[0], E.localOrigin[1]] : a === 2 ? (o.aux ? [o.aux[0], o.aux[1]] : [0, 0]) : req.single ? "anchor" : "center";
      // KiCad rounds the translation to whole nanometres
      done({ dx: Math.round(dx * 1e6) / 1e6, dy: Math.round(dy * 1e6) / 1e6, rotation: rot.get(), about });
      return true;
    } });
  // DIALOG_SHIM::SaveControlState runs on every close
  function remember(): void { saveState(key, { x: pair.x.input.value, y: pair.isPolar() ? pair.yAng.input.value : pair.yLen.input.value, rot: rot.input.value, anchor: anchor.get(), polar: polar.get(), units: currentUnits() }); }
}

// ---------------------------------------------------------------- Position Relative To Reference Item
type AnchorType = "item" | "user" | "grid" | "point";
let anchorType: AnchorType = "item";   // DIALOG_POSITION_RELATIVE::s_anchorType
interface PcbPick { pickInteractively?(ctx: unknown, mode: string, prompt: string, done: (res: Pt | KItem | null) => void): void; anchorOf?(it: KItem): Pt; itemDescription?(doc: KDoc, id: string, units: string): string }
const PT = (): PcbPick => ((globalThis as { PcbTools?: PcbPick }).PcbTools || {}) as PcbPick;
export function openPositionRelative(req: { ctx: unknown; selAnchor: Pt }, done: (anchor: Pt, dx: number, dy: number) => void, again?: { anchorPos: Pt; anchorText: string; x: string; y: string; polar: boolean }): void {
  const key = "Position Relative To Reference Item";
  const st = again ? null : loadState<{ x: string; y: string; polar: boolean; units: string }>(key);
  let anchorPos: Pt = again ? again.anchorPos : [0, 0];
  const info = h("div", { "data-k": "referenceInfo", style: "margin-bottom:6px" });
  const grid = (): Pt => { const o = (E.pcbOrigins || {}) as { grid?: Pt }; return o.grid ? [o.grid[0], o.grid[1]] : [0, 0]; };
  const anchorNow = (): Pt => (anchorType === "grid" ? grid() : anchorType === "user" ? [E.localOrigin[0], E.localOrigin[1]] : anchorPos);
  const setInfo = (text?: string): void => {
    info.textContent = anchorType === "grid" ? "Reference location: grid origin" : anchorType === "user" ? "Reference location: local coordinates origin"
      : anchorType === "point" ? `Reference location: selected point (${fmtLen(anchorPos[0])} ${unitName()}, ${fmtLen(anchorPos[1])} ${unitName()})` : `Reference item: ${text || "<none selected>"}`;
  };
  setInfo(again ? again.anchorText : undefined);
  const pair = xyPair(["Offset X:", "Offset Y:"], ["offsetX", "offsetY"]);
  const polar = checkField(false, "Use polar coordinates", { key: "polar" });
  let sx = 0, sy = 0, sr = 0, sq = 0;
  const readXY = (): Pt => [pair.x.get(), pair.isPolar() ? pair.yAng.get() : pair.yLen.get()];
  const tips = (): void => {
    clearX.title = pair.isPolar() ? "Reset to the current distance from the reference position." : "Reset to the current X offset from the reference position.";
    clearY.title = pair.isPolar() ? "Reset to the current angle from the reference position." : "Reset to the current Y offset from the reference position.";
  };
  polar.input.addEventListener("change", () => {
    const [a, b] = readXY(), on = polar.get();
    pair.setPolar(on, on ? ["Distance:", "Angle:"] : ["Offset X:", "Offset Y:"]); tips();
    if (on) { if (a !== sx || b !== sy) { sx = a; sy = b; const p = polarOf(sx, sy); sr = p.r; sq = p.q; } pair.x.set(sr); pair.yAng.set(+sq.toFixed(4)); }
    else { if (a !== sr || b !== sq) { sr = a; sq = b; sx = sr * Math.cos((sq * Math.PI) / 180); sy = sr * Math.sin((sq * Math.PI) / 180); } pair.x.set(+sx.toFixed(6)); pair.yLen.set(+sy.toFixed(6)); }
  });
  // OnClear: the current offset of the selection from the reference
  const offsetNow = (): Pt => { const a = anchorNow(); return [(req.selAnchor[0] - a[0]) * relSign("x"), (req.selAnchor[1] - a[1]) * relSign("y")]; };
  const clearX = resetBtn("", () => { const o = offsetNow(), p = polarOf(o[0], o[1]); sx = o[0]; sr = p.r; pair.x.set(+(pair.isPolar() ? p.r : o[0]).toFixed(6)); });
  const clearY = resetBtn("", () => { const o = offsetNow(), p = polarOf(o[0], o[1]); sy = o[1]; sq = p.q; if (pair.isPolar()) pair.yAng.set(+p.q.toFixed(4)); else pair.yLen.set(+o[1].toFixed(6)); });
  tips();
  for (const i of [pair.x.input, pair.yLen.input, pair.yAng.input]) i.addEventListener("blur", () => { if (!i.value.trim()) { i.value = "0"; i.dispatchEvent(new Event("change")); } });
  let api: DialogApi | null = null;
  const snapshot = () => ({ anchorPos, anchorText: info.textContent ? info.textContent.replace(/^Reference item: /, "") : "", x: pair.x.input.value, y: (pair.isPolar() ? pair.yAng : pair.yLen).input.value, polar: polar.get() });
  // OnSelectItemClick / OnSelectPointClick: the dialog steps aside while the board picks, then comes back
  const pick = (mode: "item" | "point"): void => {
    const pt = PT(); if (!pt.pickInteractively) return;
    const keep = snapshot(); if (api) api.close();
    pt.pickInteractively(req.ctx, mode, mode === "item" ? "Select reference item..." : "Select reference point...", (res) => {
      let text = keep.anchorText, pos = keep.anchorPos;
      if (mode === "item") { anchorType = "item"; if (res && !Array.isArray(res)) { const it = res as KItem; pos = pt.anchorOf ? pt.anchorOf(it) : [it.x || 0, it.y || 0]; text = pt.itemDescription && E.kdoc ? pt.itemDescription(E.kdoc, it.id, currentUnits()) : it.kind; } }
      else { anchorType = "point"; if (res && Array.isArray(res)) pos = [res[0], res[1]]; }
      openPositionRelative(req, done, { ...keep, anchorPos: pos, anchorText: text });
    });
  };
  const btn = (label: string, fn: () => void, tip?: string): HTMLButtonElement => { const b = h("button", { type: "button", class: "btn", title: tip }, label); b.addEventListener("click", fn); return b; };
  api = openDialog({ title: "Position Relative To Reference Item", width: 520,
    build(body) {
      const f = h("div", { class: "pd-form pd-form4" });
      f.append(pair.xl, pair.x.el, unitLabel(), clearX, pair.yl, h("span", null, pair.yLen.el, pair.yAng.el), pair.yu, clearY);
      put(body, info, h("div", { class: "pd-row", style: "flex-wrap:wrap;gap:6px" },
        btn("Use Local Origin", () => { anchorType = "user"; setInfo(); }), btn("Use Grid Origin", () => { anchorType = "grid"; setInfo(); }),
        btn("Select Item...", () => pick("item"), "Click and select a board item.\nThe anchor position will be the position of the selected item."), btn("Select Point...", () => pick("point"))),
        h("hr", { class: "pd-sep" }), f, polar.el);
      const restore = again || (st ? { ...st } : null);
      if (restore) {
        if (restore.polar) { polar.set(true); pair.setPolar(true, ["Distance:", "Angle:"]); tips(); }
        const sameUnits = again || (st && st.units === currentUnits());
        if (sameUnits) { const x = parseLen(restore.x); if (!isNaN(x)) pair.x.set(x); if (restore.polar) pair.yAng.set(Number(restore.y) || 0); else { const y = parseLen(restore.y); if (!isNaN(y)) pair.yLen.set(y); } }
      }
      setTimeout(() => { pair.x.input.focus(); (pair.x.input as HTMLInputElement).select(); }, 0);
    },
    cancel() { remember(); return true; },
    ok() {
      remember();
      const [a, b] = readXY();
      const t: Pt = pair.isPolar() ? [a * Math.cos((b * Math.PI) / 180), a * Math.sin((b * Math.PI) / 180)] : [a, b];
      done(anchorNow(), Math.round(t[0] * relSign("x") * 1e6) / 1e6, Math.round(t[1] * relSign("y") * 1e6) / 1e6);
      return true;
    } });
  function remember(): void { saveState(key, { x: pair.x.input.value, y: (pair.isPolar() ? pair.yAng : pair.yLen).input.value, polar: polar.get(), units: currentUnits() }); }
}

// ---------------------------------------------------------------- Swap Layers
const layerCss = (l: string): string => { try { return (KiCadCanvas as unknown as { pcbColor(l: string): string }).pcbColor(l); } catch (e) { return "transparent"; } };
const layerLabel = (l: string): string => { const rows = (E.kdoc && (E.kdoc as unknown as { layerNames?: Record<string, string> }).layerNames) || null; return (rows && rows[l]) || l; };
/** GRID_CELL_LAYER_RENDERER: the layer's colour swatch and its name. */
const layerCell = (l: string): HTMLElement => h("span", { class: "pd-layercell" }, h("span", { class: "sw", style: `background:${layerCss(l)}` }), layerLabel(l));
export function openSwapLayers(req: { copper: string[] }, done: (map: Record<string, string>) => void): void {
  const picks = new Map<string, Field<string>>();
  openDialog({ title: "Swap Layers", width: 420,
    build(body) {
      const table = h("table");
      table.append(h("thead", null, h("tr", null, h("th", { style: "width:50%" }, "Move items on:"), h("th", null, "To layer:"))));
      const tb = h("tbody");
      for (const l of req.copper) {
        const s = selectField<string>(l, req.copper.map((c): [string, string] => [c, layerLabel(c)]), { key: "swap-" + l });
        const sw = h("span", { class: "sw", style: `background:${layerCss(l)}` });
        s.input.addEventListener("change", () => { sw.style.background = layerCss(s.get()); });
        picks.set(l, s);
        tb.append(h("tr", null, h("td", { class: "ro" }, layerCell(l)), h("td", null, h("span", { class: "pd-layercell" }, sw, s.el))));
      }
      table.append(tb);
      put(body, h("div", { class: "pd-grid", style: "max-height:420px", "data-k": "swapGrid" }, table));
    },
    ok() { const map: Record<string, string> = {}; for (const [l, f] of picks) { const d = f.get(); if (req.copper.includes(d)) map[l] = d; } done(map); return true; } });
}

// ---------------------------------------------------------------- Cleanup Tracks and Vias
const CLEANUP_ACTIONS: [keyof CleanupDialogOpts, string, string, boolean][] = [
  ["shorts", "Delete tracks connecting different nets", "remove track segments connecting nodes belonging to different nets (short circuit)", true],
  ["vias", "Delete redundant vias", "remove vias on through hole pads and superimposed vias", true],
  ["danglingVias", "Delete vias connected on only one layer", "", true],
  ["merge", "Merge co-linear tracks", "merge aligned track segments, and remove null segments", true],
  ["dangling", "Delete tracks unconnected at one end", "delete tracks having at least one dangling end", true],
  ["inPads", "Delete tracks fully inside pads", "Delete tracks that have both start and end positions inside of a pad", false]];
export function openCleanupTracks(req: CleanupRequest): void {
  let firstRun = true;
  const refill = checkField(true, "Refill zones before and after cleanup", { key: "refillZones" });
  const acts = CLEANUP_ACTIONS.map(([k, label, tip, def]) => ({ k, f: checkField(def, label, { key: "cleanup-" + k, tip }) }));
  const netOpt = checkField(false, "Filter items by net:", { key: "netFilterOpt" });
  const net = selectField<string>(req.highlightNet && req.nets.includes(req.highlightNet) ? req.highlightNet : req.nets[0] || "", req.nets.map((n): [string, string] => [n, n]), { key: "netFilter" });
  const ncOpt = checkField(false, "Filter items by net class:", { key: "netclassFilterOpt" });
  const nc = selectField<string>(req.currentNetclass, req.netclasses.map((n): [string, string] => [n, n]), { key: "netclassFilter" });
  const layerOpt = checkField(false, "Filter items by layer:", { key: "layerFilterOpt" });
  const layer = selectField<string>(req.copper.includes(req.activeLayer) ? req.activeLayer : req.copper[0], req.copper.map((l): [string, string] => [l, l]), { key: "layerFilter" });
  const selOnly = checkField(false, "Selected items only", { key: "selectedItemsFilter" });
  for (const s of [net, nc, layer]) s.input.setAttribute("data-nopersist", "");   // TransferDataToWindow picks these from the board
  const list = h("div", { class: "pd-report", style: "height:180px;min-height:0", "data-k": "changes" });
  let api: DialogApi | null = null;
  const opts = (): CleanupDialogOpts => {
    const o = { refill: refill.get(), net: netOpt.get() ? net.get() : null, netclass: ncOpt.get() ? nc.get() : null, layer: layerOpt.get() ? layer.get() : null, selectedOnly: selOnly.get() } as CleanupDialogOpts;
    for (const a of acts) (o as unknown as Record<string, boolean>)[a.k] = a.f.get();
    return o;
  };
  const label = (): void => { if (api && api.okButton) api.okButton.textContent = firstRun ? "Build Changes" : "Update PCB"; };
  // OnCheckBox: any change empties the changes list and asks for a new build
  const reset = (): void => { list.replaceChildren(); req.focus(null); firstRun = true; label(); };
  const build = (): void => {
    const items = req.plan(opts());
    list.replaceChildren(...items.map((it) => { const row = h("div", { class: "ln action", tabindex: "0" }, it.text); row.addEventListener("click", () => { for (const r of Array.from(list.children)) r.classList.toggle("sel", r === row); req.focus(it.ids); }); return row; }));
    if (!items.length) list.append(h("div", { class: "ln" }, "No changes."));
  };
  api = openDialog({ title: "Cleanup Tracks and Vias", width: 620, okLabel: "Build Changes", persist: true,
    build(body) {
      const filters = h("div", { class: "pd-form" });
      filters.append(netOpt.el, net.el, h("span"), ncOpt.el, nc.el, h("span"), layerOpt.el, layer.el, h("span"));
      put(body, h("div", { class: "pd-cols2" },
        box("Actions", refill.el, h("hr", { class: "pd-sep" }), ...acts.map((a) => a.f.el)),
        box("Filter Items", filters, selOnly.el)),
        h("div", { class: "pd-lbl", style: "margin:8px 0 4px" }, "Changes to be applied:"), list);
      body.addEventListener("change", (ev) => { if (!list.contains(ev.target as Node)) reset(); });
    },
    restored() { reset(); },
    cancel() { req.focus(null); return true; },
    ok() {
      // TransferDataFromWindow: the first press is a dry run that lists the changes; the second one applies them
      if (firstRun) { build(); firstRun = false; label(); return false; }
      req.apply(opts()); return true;
    } });
}

/** pcb.setRoutingDialogs: these four join the routing dialogs pcb-tools.js asks for. */
export function installTransformDialogs(): void {
  const pcb = (typeof CollabTools !== "undefined" && CollabTools && CollabTools.pcb) as unknown as { setRoutingDialogs?(d: Record<string, unknown>): void } | undefined;
  if (pcb && pcb.setRoutingDialogs) pcb.setRoutingDialogs({ moveExact: openMoveExact, positionRelative: openPositionRelative, swapLayers: openSwapLayers, cleanup: openCleanupTracks });
}
