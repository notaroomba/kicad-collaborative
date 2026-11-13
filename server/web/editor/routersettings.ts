// routersettings.ts — the interactive router's two dialogs on the editor side:
//   · DIALOG_PNS_SETTINGS, "Interactive Router Settings" (Ctrl+<): the router mode and its options, with KiCad's
//     labels, tooltips and onModeChange enabling; OK hands the values to pcb-tools.js (setRouterSettings), which
//     keeps them in this browser as KiCad keeps them in pcbnew.json;
//   · the "Select Layer" picker the Select Layer and Place … Via commands open at the track end
//     (PCB_ONE_LAYER_SELECTOR), as a themed list of the copper layers.
// pcb-tools.js owns the settings and the router; this module only builds the pages and registers them through
// CollabTools.pcb.setRoutingDialogs / setLayerPicker.
import { KD, checkbox, h } from "../dialogs/dom";
import { E } from "./state";
import { toast } from "./util";
import "../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

/** pcb-tools.js's ROUTING_SETTINGS, by the parameter names KiCad stores in pcbnew.json's "tools.pns". */
export interface RouterSettings {
  mode: number; shove_vias: boolean; jump_over_obstacles: boolean; remove_loops: boolean; suggest_finish: boolean; smart_pads: boolean;
  smooth_dragged_segments: boolean; can_violate_drc: boolean; free_angle_mode: boolean; optimize_dragged_track: boolean; auto_posture: boolean;
  fix_all_segments: boolean; restrict_angles: boolean; keep_diff_pair_coupling_when_dragging: boolean;
  [k: string]: unknown;
}
interface RouterApi {
  routerSettings?(): RouterSettings; setRouterSettings?(patch: Partial<RouterSettings>): void;
  setRoutingDialogs?(d: Record<string, unknown>): void; setLayerPicker?(fn: LayerPicker): void;
}
export interface LayerPickOpts { layers: string[]; current: string; disallow?: Set<string>; at?: number[]; client?: [number, number] | null }
export type LayerPicker = (opts: LayerPickOpts, done: (layer: string | null) => void) => void;

const pcbApi = (): RouterApi | null => (typeof CollabTools !== "undefined" && CollabTools && (CollabTools.pcb as unknown as RouterApi)) || null;

export const RM_MARK = 0, RM_SHOVE = 1, RM_WALK = 2;

/** The rows of DIALOG_PNS_SETTINGS_BASE, in its order: [key, label, tooltip]. */
export const PNS_ROUTING_ROWS: [keyof RouterSettings, string, string][] = [
  ["remove_loops", "Remove redundant tracks", "If the new track has the same connection as an already existing track, the old track is removed."],
  ["smart_pads", "Optimize pad connections", "When enabled, the router tries to break out pads/vias in a clean way, avoiding acute angles and jagged breakout tracks."],
  ["auto_posture", "Use mouse path to set track posture", "When enabled, the posture of tracks will be guided by how the mouse is moved from the starting location"],
  ["fix_all_segments", "Fix all segments on click", "When enabled, all track segments will be fixed in place up to the cursor location.  When disabled, the last segment (closest to the cursor) will remain free and follow the cursor."],
];
export const PNS_DRAGGING_ROWS: [keyof RouterSettings, string, string][] = [
  ["smooth_dragged_segments", "Smooth dragged segments", "When enabled, the router attempts to merge several jagged segments into a single straight one (dragging mode)."],
  ["optimize_dragged_track", "Optimize entire track being dragged", "When enabled, the entire portion of the track that is visible on the screen will be optimized and re-routed when a segment is dragged.  When disabled, only the area near the segment being dragged will be optimized."],
  ["restrict_angles", "Avoid sharp angles", "When enabled, dragged traces will be optimized to avoid creating 90-degree or acute corners in most situations."],
  ["keep_diff_pair_coupling_when_dragging", "Keep coupling between differential pairs", "When enabled, dragging one track belonging to a differential pair drags the other, maintaining their coupling,"],
];
const TIP_VIOLATE = "(Highlight collisions mode only) - allows one to establish a track even if is violating the DRC rules.";
const TIP_SHOVE_VIAS = "When disabled, vias are treated as un-movable objects and hugged instead of shoved.";
const TIP_JUMP = "When enabled, the router tries to move colliding tracks behind solid obstacles (e.g. pads) instead of \"reflecting\" back the collision";

const CSS = `.pns-cols{display:flex;gap:14px;align-items:flex-start}.pns-cols>div{flex:1;min-width:0}
.pns-sub{margin:2px 0 6px 22px;display:flex;flex-direction:column;gap:3px}.pns-rows{display:flex;flex-direction:column;gap:3px}
.pns-radio{display:flex;align-items:center;gap:6px;margin:2px 0}.kd-chk.off{opacity:.5}
@media (max-width:560px){.pns-cols{flex-direction:column}}
.lsel-list{display:flex;flex-direction:column;max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:3px}
.lsel-row{display:flex;align-items:center;gap:8px;padding:4px 8px;cursor:pointer;color:var(--ink)}
.lsel-row:hover,.lsel-row.cur{background:var(--hover,rgba(127,127,127,.15))}.lsel-row.off{opacity:.45;cursor:default}
.dpd-grid{display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;align-items:center;margin-bottom:10px}.dpd-grid .off{opacity:.5}
.lsel-sw{width:14px;height:14px;border-radius:2px;border:1px solid var(--line);flex:none}`;
function styles(): void {
  if (typeof document === "undefined" || document.getElementById("pnsDialogCss")) return;
  const s = document.createElement("style"); s.id = "pnsDialogCss"; s.textContent = CSS; document.head.appendChild(s);
}

/**
 * The dialog's state machine without the page: DIALOG_PNS_SETTINGS's constructor (load), onModeChange (which options
 * are enabled) and TransferDataFromWindow (the values OK stores).  Exported for the tests.
 */
export function pnsForm(rs: RouterSettings) {
  const v: RouterSettings = { ...rs };
  return {
    values: v,
    enabled(key: keyof RouterSettings): boolean {
      if (key === "free_angle_mode" || key === "can_violate_drc") return v.mode === RM_MARK;
      if (key === "shove_vias" || key === "jump_over_obstacles") return v.mode === RM_SHOVE;
      return true;
    },
    set(key: keyof RouterSettings, value: unknown): void { (v as Record<string, unknown>)[key as string] = value; },
    /** TransferDataFromWindow: every control's value, the disabled ones too (KiCad stores them as they stand). */
    result(): Partial<RouterSettings> {
      const out: Partial<RouterSettings> = { mode: v.mode };
      for (const k of ["shove_vias", "jump_over_obstacles", "remove_loops", "suggest_finish", "smart_pads", "smooth_dragged_segments", "optimize_dragged_track", "auto_posture",
        "fix_all_segments", "can_violate_drc", "restrict_angles", "free_angle_mode", "keep_diff_pair_coupling_when_dragging"]) (out as Record<string, unknown>)[k] = !!v[k];
      return out;
    },
  };
}

/** ROUTER_TOOL::SettingsDialog — DIALOG_PNS_SETTINGS, "Interactive Router Settings". */
export function openRouterSettings(): void {
  const api = pcbApi(); if (!api || !api.routerSettings || !api.setRouterSettings) return;
  styles();
  const form = pnsForm(api.routerSettings());
  const v = form.values;
  KD().open({ title: "Interactive Router Settings", width: 640,
    build(body) {
      const cols = h("div", { class: "pns-cols" }); body.appendChild(cols);
      const left = h("div"), right = h("div"); cols.append(left, right);
      const deps: [keyof RouterSettings, HTMLLabelElement][] = [];
      const check = (key: keyof RouterSettings, label: string, tip?: string) => {
        const c = checkbox(label, !!v[key], (on) => form.set(key, on), { title: tip }); c.dataset.k = String(key); deps.push([key, c]); return c;
      };
      const sync = () => { for (const [k, c] of deps) { const on = form.enabled(k); const i = c.querySelector("input") as HTMLInputElement; i.disabled = !on; c.classList.toggle("off", !on); } };
      const radio = (mode: number, label: string) => {
        const r = h("input", { type: "radio", name: "pnsMode", checked: v.mode === mode, value: String(mode) });
        r.addEventListener("change", () => { if (r.checked) { form.set("mode", mode); sync(); } });
        return h("label", { class: "pns-radio" }, r, label);
      };
      const mode = KD().staticBox(left, "Mode");
      mode.append(radio(RM_MARK, "Highlight collisions"),
        h("div", { class: "pns-sub" }, check("free_angle_mode", "Free angle mode"), check("can_violate_drc", "Allow DRC violations", TIP_VIOLATE)),
        radio(RM_SHOVE, "Shove"),
        h("div", { class: "pns-sub" }, check("shove_vias", "Shove vias", TIP_SHOVE_VIAS), check("jump_over_obstacles", "Jump over obstacles", TIP_JUMP)),
        radio(RM_WALK, "Walk around"));
      const routing = KD().staticBox(right, "Routing"); const rr = h("div", { class: "pns-rows" }); routing.appendChild(rr);
      for (const [k, label, tip] of PNS_ROUTING_ROWS) rr.appendChild(check(k, label, tip));
      const dragging = KD().staticBox(right, "Dragging"); const dr = h("div", { class: "pns-rows" }); dragging.appendChild(dr);
      for (const [k, label, tip] of PNS_DRAGGING_ROWS) dr.appendChild(check(k, label, tip));
      sync();
    },
    ok() { api.setRouterSettings!(form.result()); return true; } });
}

// ---------------------------------------------------------------- DIALOG_PNS_DIFF_PAIR_DIMENSIONS
export interface DpDims { width: number; gap: number; via_gap: number }
/**
 * The dialog's logic without the page: TransferDataToWindow (the router's current pair sizes), updateCheckbox
 * ("Via gap same as track gap" disables the via gap) and TransferDataFromWindow (the track gap must be positive).
 */
export function dpDimsForm(cur: DpDims, sameAsGap: boolean) {
  const v = { width: cur.width, gap: cur.gap, via_gap: cur.via_gap, same: !!sameAsGap };
  return {
    values: v,
    viaGapEnabled(): boolean { return !v.same; },
    /** null when OK may close, else KiCad's message */
    validate(): string | null { return v.gap > 0 ? null : "Track gap must be greater than 0."; },
    result(): { dims: DpDims; same: boolean } { return { dims: { width: v.width, gap: v.gap, via_gap: v.same ? v.gap : v.via_gap }, same: v.same }; },
  };
}
const lengthText = (mm: number, u: string): string => (u === "mil" ? `${+(mm / 0.0254).toFixed(4)}` : u === "in" ? `${+(mm / 25.4).toFixed(6)}` : `${+mm.toFixed(6)}`);
/** A UNIT_BINDER entry: a bare number is in the editor's units; mm / mils / in are understood. NaN when it is not a length. */
export function parseLength(text: string, u: string): number {
  const t = text.trim().toLowerCase().replace(",", "."); const m = /^(-?\d*\.?\d+)\s*(mm|mils?|thou|in|inch|")?$/.exec(t); if (!m) return NaN;
  const val = parseFloat(m[1]); const unit = m[2] || (u === "mil" ? "mil" : u === "in" ? "in" : "mm");
  return +(unit === "mm" ? val : unit === "in" || unit === "inch" || unit === '"' ? val * 25.4 : val * 0.0254).toFixed(6);
}
interface SizesState { routeDiffPair(net: string): { width: number; gap: number; viaGap: number }; diffPairViaGapSameAsGap: boolean; setCustomDiffPair(d: DpDims, same: boolean): void }
/** ROUTER_TOOL::DpDimensionsDialog — "Differential Pair Dimensions": Width, Track gap, Via gap, "Via gap same as track gap". */
export function openDiffPairDimensions(): void {
  const sizes = (KiCadCanvas as unknown as { pcbSizes: { state: SizesState } }).pcbSizes.state;
  const api = pcbApi() as (RouterApi & { routedNet?(): string; diffPairSizesChanged?(ctx: unknown): void }) | null;
  const net = api && api.routedNet ? api.routedNet() : "";
  const cur = sizes.routeDiffPair(net);
  const form = dpDimsForm({ width: cur.width, gap: cur.gap, via_gap: cur.viaGap }, sizes.diffPairViaGapSameAsGap);
  const u = String(E.units || "mm");
  const unitName = u === "mil" ? "mils" : u === "in" ? "in" : "mm";
  styles();
  const inputs: Record<string, HTMLInputElement> = {};
  KD().open({ title: "Differential Pair Dimensions", width: 340,
    build(body) {
      const grid = h("div", { class: "dpd-grid" }); body.appendChild(grid);
      const row = (key: "width" | "gap" | "via_gap", label: string) => {
        const inp = h("input", { type: "text", value: lengthText(form.values[key], u), "data-k": key }); inputs[key] = inp;
        const lab = h("span", { class: "dpd-l" }, label), unit = h("span", { class: "dpd-u" }, unitName);
        grid.append(lab, inp, unit); return [lab, inp, unit] as HTMLElement[];
      };
      row("width", "Width:"); row("gap", "Track gap:"); const via = row("via_gap", "Via gap:");
      const sync = () => { const on = form.viaGapEnabled(); (via[1] as HTMLInputElement).disabled = !on; for (const e of via) e.classList.toggle("off", !on); };
      body.appendChild(checkbox("Via gap same as track gap", form.values.same, (on) => { form.values.same = on; sync(); }));
      sync();
    },
    ok() {
      for (const k of ["width", "gap", "via_gap"] as const) {
        const inp = inputs[k]; if (!inp || (k === "via_gap" && inp.disabled)) continue;
        const v = parseLength(inp.value, u); if (isNaN(v)) { toast("Please enter a valid value."); inp.focus(); return false; }
        form.values[k] = v;
      }
      const err = form.validate(); if (err) { toast(err); if (inputs.gap) inputs.gap.focus(); return false; }
      const r = form.result(); sizes.setCustomDiffPair(r.dims, r.same);
      if (api && api.diffPairSizesChanged) api.diffPairSizesChanged(null);
      return true;
    } });
}

// ---------------------------------------------------------------- DIALOG_TUNING_PATTERN_PROPERTIES
/** pcb-tools.js's MEANDER_SETTINGS as the dialog shows them (lengths in mm; targetLength null = unconstrained). */
export interface TuneView { targetLength: number | null; minAmp: number; maxAmp: number; spacing: number; round: boolean; crPct: number; singleSided: boolean; overrideCustomRules: boolean; constraint?: string | null }
export type TuneMode = "single" | "diff_pair" | "diff_pair_skew";
/**
 * The dialog's logic without the page: TransferDataToWindow (an unconstrained target shows empty, the skew tuner
 * relabels the target, the target is editable only without a rule or with "Override custom rules") and
 * TransferDataFromWindow (an empty target is unconstrained).
 */
export function tuneForm(mode: TuneMode, cur: TuneView) {
  const v = Object.assign({}, cur);
  return {
    values: v,
    targetLabel: mode === "diff_pair_skew" ? "Target Skew: " : "Target Length:",
    delayLabel: mode === "diff_pair_skew" ? "Target Skew Delay: " : "Target Delay:",
    targetEnabled(): boolean { return !v.constraint || v.overrideCustomRules; },
    sourceInfo(): string | null { return v.constraint && !v.overrideCustomRules ? `(from ${v.constraint})` : null; },
    targetText(u: string): string { return v.targetLength == null ? "" : lengthText(v.targetLength, u); },
    setTarget(text: string, u: string): boolean {
      if (!text.trim()) { v.targetLength = null; return true; }
      const n = parseLength(text, u); if (isNaN(n)) return false; v.targetLength = n; return true;
    },
    result(): TuneView { const r = Object.assign({}, v); delete r.constraint; return r; },
  };
}
/** PCB_ACTIONS::lengthTunerSettings (Ctrl+L) — "Tuning Pattern Properties". */
export function openTuningSettings(req: { mode: TuneMode; settings: TuneView }, done: (v: TuneView) => void): void {
  const form = tuneForm(req.mode, req.settings);
  const u = String(E.units || "mm");
  const unitName = u === "mil" ? "mils" : u === "in" ? "in" : "mm";
  styles();
  const inputs: Record<string, HTMLInputElement> = {};
  let target: HTMLInputElement | null = null, src: HTMLElement | null = null, corner: HTMLSelectElement | null = null;
  KD().open({ title: "Tuning Pattern Properties", width: 400,
    build(body) {
      const grid = h("div", { class: "dpd-grid" }); body.appendChild(grid);
      const tl = h("span", null, form.targetLabel); target = h("input", { type: "text", value: form.targetText(u), "data-k": "target" });
      grid.append(tl, target, h("span", null, unitName));
      const dl = h("span", { class: "off" }, form.delayLabel), di = h("input", { type: "text", value: "", disabled: true, "data-k": "delay", title: "Time-domain tuning needs a tuning profile in Board Setup" });
      grid.append(dl, di, h("span", { class: "off" }, "ps"));
      const ov = checkbox("Override custom rules", form.values.overrideCustomRules, (on) => { form.values.overrideCustomRules = on; sync(); });
      src = h("span", { class: "dpd-src" }, "");
      body.appendChild(h("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:10px" }, ov, src));
      const g2 = h("div", { class: "dpd-grid" }); body.appendChild(g2);
      const row = (k: "minAmp" | "maxAmp" | "spacing", label: string, tip?: string) => {
        const inp = h("input", { type: "text", value: lengthText(form.values[k], u), "data-k": k, title: tip }); inputs[k] = inp;
        g2.append(h("span", { title: tip }, label), inp, h("span", null, unitName));
      };
      row("minAmp", "Minimum amplitude (A):"); row("maxAmp", "Maximum amplitude (A):");
      row("spacing", "Spacing (s):", "Minimum spacing between adjacent tuning segments. The resulting spacing may be greater based on design rules.");
      corner = h("k-select", { "data-k": "corner" }, h("option", { value: "0" }, "Chamfer"), h("option", { value: "1" }, "Fillet"));
      corner.value = form.values.round ? "1" : "0";
      g2.append(h("span", null, "Corner style:"), corner, h("span", null, ""));
      const r = h("input", { type: "text", value: String(form.values.crPct), "data-k": "crPct" }); inputs.crPct = r;
      g2.append(h("span", null, "Radius (r):"), r, h("span", null, "%"));
      body.appendChild(checkbox("Single-sided", form.values.singleSided, (on) => { form.values.singleSided = on; }));
      const sync = () => { const on = form.targetEnabled(); if (target) target.disabled = !on; tl.classList.toggle("off", !on); const s = form.sourceInfo(); if (src) { src.textContent = s || ""; src.style.display = s ? "" : "none"; } };
      sync();
      setTimeout(() => { if (target && !target.disabled) target.focus(); }, 0);
    },
    ok() {
      if (target && !target.disabled && !form.setTarget(target.value, u)) { toast("Please enter a valid value."); target.focus(); return false; }
      for (const k of ["minAmp", "maxAmp", "spacing"] as const) {
        const v = parseLength(inputs[k].value, u); if (isNaN(v) || v < 0) { toast("Please enter a valid value."); inputs[k].focus(); return false; }
        form.values[k] = v;
      }
      const pct = parseFloat(inputs.crPct.value); if (isNaN(pct) || pct < 0 || pct > 100) { toast("Please enter a valid value."); inputs.crPct.focus(); return false; }
      form.values.crPct = Math.round(pct);
      form.values.round = !!corner && corner.value === "1";
      done(form.result());
      return true;
    } });
}

/** PCB_ONE_LAYER_SELECTOR — "Select Layer": the copper layers, the current one marked, the disallowed ones greyed. */
export const pickLayer: LayerPicker = (opts, done) => {
  styles();
  const kc = (typeof KiCadCanvas !== "undefined" ? KiCadCanvas : null) as unknown as { pcbColor?(l: string): string } | null;
  const color = (l: string) => (kc && kc.pcbColor ? kc.pcbColor(l) : "#888");
  let answered = false; const answer = (l: string | null) => { if (answered) return; answered = true; done(l); };
  const dlg = KD().open({ title: "Select Layer", width: 280, okLabel: "OK",
    build(body) {
      const list = h("div", { class: "lsel-list", role: "listbox" }); body.appendChild(list);
      for (const l of opts.layers) {
        const off = !!(opts.disallow && opts.disallow.has(l));
        const row = h("div", { class: "lsel-row" + (l === opts.current ? " cur" : "") + (off ? " off" : ""), role: "option", "data-layer": l, "aria-disabled": off ? "true" : undefined },
          h("span", { class: "lsel-sw", style: `background:${color(l)}` }), h("span", null, l));
        if (!off) row.addEventListener("click", () => { answer(l); dlg.close(); });
        list.appendChild(row);
      }
      // the shell's OK has nothing to apply: the list picks with one click, as KiCad's grid does
      const foot = body.parentElement && body.parentElement.querySelector<HTMLElement>(".kd-foot .btn.primary"); if (foot) foot.style.display = "none";
    },
    ok() { answer(null); return true; },
    cancel() { answer(null); } });
};

/** Registers both with pcb-tools.js. */
export function installRouterDialogs(): void {
  const api = pcbApi(); if (!api) return;
  if (api.setRoutingDialogs) api.setRoutingDialogs({ routerSettings: openRouterSettings, diffPair: openDiffPairDimensions, tuning: openTuningSettings });
  if (api.setLayerPicker) api.setLayerPicker(pickLayer);
}
