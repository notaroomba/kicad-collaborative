// pcb-tools/snap-pairs.ts — two PCB_CONTROL cycling hotkeys and their HOTKEY_CYCLE_POPUP feedback:
//   layerPairPresetsCycle (Shift+V)   CycleLayerPresets: the current routing layer pair steps to the next of
//                                      LAYER_PAIR_SETTINGS::GetEnabledLayerPairs (the last manual pair, "Manual",
//                                      first, then the enabled presets); nothing happens with fewer than two.
//                                      LayerPresetFeedback: "Preset Layer Pairs", "<A> / <B>" or "<A> / <B> (<name>)"
//   magneticSnapToggle (Shift+S)       SnapMode: MAGNETIC_SETTINGS::allLayers flips (Active Layer / All Layers), the
//   magneticSnapActiveLayer / AllLayers   two others set it; SnapModeFeedback: "Object Snapping".  With allLayers off
//                                      PCB_GRID_HELPER only snaps to items on the active layer.
import type { BoardDoc, PcbCtx } from "./types";
import { K, S } from "./state";

type Pair = [string, string];
const boardLayerName = (doc: BoardDoc, name: string) => { const l = doc && doc.layers && doc.layers.get ? doc.layers.get(name) : null; return l && l.userName ? l.userName : name; };
interface PresetLike { top: string; bottom: string; enabled?: boolean; name?: string }
const same = (a: Pair, b: Pair) => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);

/** LAYER_PAIR_SETTINGS::m_lastManualPair: the last pair set that was not an enabled preset. */
let lastManual: Pair | null = null;
export function resetLayerPairCycle() { lastManual = null; }

/** GetEnabledLayerPairs: the pairs Shift+V steps through and the index of the current one (-1: none). */
export function enabledLayerPairs(current: Pair, presets: PresetLike[]): { pairs: { pair: Pair; name?: string }[]; current: number } {
  const on = presets.filter((p) => p.enabled !== false).map((p) => ({ pair: [p.top, p.bottom] as Pair, name: p.name }));
  const isPreset = (pr: Pair) => on.some((p) => same(p.pair, pr));
  // SetCurrentLayerPair remembers a pair that is not a preset; a pair later added as a preset stops being the manual one
  if (!isPreset(current)) lastManual = [current[0], current[1]];
  else if (lastManual && isPreset(lastManual)) lastManual = null;
  const pairs: { pair: Pair; name?: string }[] = []; let cur = -1;
  if (lastManual) { pairs.push({ pair: lastManual, name: "Manual" }); if (same(current, lastManual)) cur = 0; }
  for (const p of on) { pairs.push(p); if (same(current, p.pair)) cur = pairs.length - 1; }
  return { pairs, current: cur };
}

type Popup = (title: string, items: string[], selection: number) => void;
const popup = (): Popup | null => (typeof window !== "undefined" && (window as unknown as { kcHotkeyCyclePopup?: Popup }).kcHotkeyCyclePopup) || null;

export function pairLabel(doc: BoardDoc, p: { pair: Pair; name?: string }) {
  const s = boardLayerName(doc, p.pair[0]) + " / " + boardLayerName(doc, p.pair[1]);
  return p.name ? `${s} (${p.name})` : s;
}

/** CycleLayerPresets + LayerPresetFeedback.  True when the pair changed. */
export function cycleLayerPairPresets(ctx: PcbCtx): boolean {
  const R = K.pcbSizes.state;
  const { pairs, current } = enabledLayerPairs(R.layerPair, R.layerPairPresets);
  if (pairs.length < 2) return false;
  const next = pairs[((current < 0 ? 0 : current) + 1) % pairs.length];
  R.setLayerPair(next.pair[0], next.pair[1]);
  const after = enabledLayerPairs(R.layerPair, R.layerPairPresets);
  const show = popup(); if (show) show("Preset Layer Pairs", after.pairs.map((p) => pairLabel(ctx.doc, p)), after.current);
  ctx.requestRender();
  return true;
}

// ---------------------------------------------------------------- magnetic snapping layers
const SNAP_KEY = (fp: boolean) => "kc.magneticAllLayers." + (fp ? "fpedit" : "pcb");
/** MAGNETIC_SETTINGS::allLayers (editing.magnetic_all_layers, default false), kept per editor like KiCad's two settings files. */
export function snapAllLayers(ctx: PcbCtx | null): boolean {
  const fp = !!(ctx && ctx.fpEditor);
  const v = fp ? S.snapAllLayersFp : S.snapAllLayers;
  if (typeof v === "boolean") return v;
  let stored = false; try { stored = typeof localStorage !== "undefined" && localStorage.getItem(SNAP_KEY(fp)) === "1"; } catch { /* storage blocked */ }
  if (fp) S.snapAllLayersFp = stored; else S.snapAllLayers = stored;
  return stored;
}
export function setSnapMode(ctx: PcbCtx, mode: "active" | "all" | "toggle"): boolean {
  const fp = !!ctx.fpEditor, now = snapAllLayers(ctx);
  const v = mode === "toggle" ? !now : mode === "all";
  if (fp) S.snapAllLayersFp = v; else S.snapAllLayers = v;
  try { if (typeof localStorage !== "undefined") localStorage.setItem(SNAP_KEY(fp), v ? "1" : "0"); } catch { /* storage blocked */ }
  const show = popup(); if (show) show("Object Snapping", ["Active Layer", "All Layers"], v ? 1 : 0);
  return true;
}

/** Whether an item counts for snapping on this layer (BOARD_ITEM::GetLayerSet): a footprint by its own layer, a through via on every copper layer. */
export function itemOnLayer(it: KItem, layer: string): boolean {
  if (!layer) return true;
  if (it.kind === "footprint") return it.layer === layer;
  if (it.kind === "via") {
    const ls = K.kid(it.node, "layers"); const names = ls ? ls.slice(1).map((v) => K.str(v)) : [];
    const through = !K.kid(it.node, "blind") && !K.kid(it.node, "micro") && !(it.node[1] === "blind" || it.node[1] === "micro");
    return /\.Cu$/.test(layer) && (through || names.includes(layer) || names.includes("*.Cu"));
  }
  if (it.layer === layer) return true;
  return it.geom.some((g) => g.layer === layer || g.layer === "*.Cu" && /\.Cu$/.test(layer));
}
