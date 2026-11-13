// pcb-tools/teardrop-edit.ts — Edit > Edit Teardrops... (DIALOG_GLOBAL_EDIT_TEARDROPS::TransferDataFromWindow):
// the pads and vias in scope get their TEARDROP_PARAMETERS removed (disabled), set to the board's defaults for
// their shape, or given the values the dialog specifies; teardrop zones left without a teardrop go.
import type { BoardDoc, PcbChange } from "./types";
import { removedChange, replacedChange } from "./changes";
import { netOf } from "./nets";
import { K } from "./state";
import { clone } from "./util";

/** pad-model's Teardrops (TEARDROP_PARAMETERS). */
export interface TeardropParams { enabled: boolean; twoSegments: boolean; preferZone: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean }
export interface TeardropEditOpts {
  vias: boolean; pthPads: boolean; smdPads: boolean; trackToTrack: boolean;
  action: "remove" | "removeAll" | "default" | "specified";
  /** TARGET_ROUND / TARGET_RECT from the board setup */
  defaults: { round: TeardropParams; rect: TeardropParams };
  /** the specified values; a missing one is the dialog's indeterminate state and leaves the item's value */
  specified?: Partial<Omit<TeardropParams, "enabled">>;
  roundOnly?: boolean; existingOnly?: boolean;
  /** Selected items only: ids of selected vias, pads (by uuid) and footprints */
  selected?: Set<string> | null;
  /** net / net class / layer filters: true leaves the item alone */
  skip?(info: { net: string; layer: string }): boolean;
}
interface PadModelApi { readTeardrops(n: SNode): TeardropParams; formatTeardrops(t: TeardropParams): string; setPadChild(pad: SNode, key: string, text: string | null): void; TD_DEFAULTS: TeardropParams }
const PM = (): PadModelApi => (K as unknown as { padModel: PadModelApi }).padModel;
const VIA_ORDER = ["at", "size", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "layers", "remove_unused_layers", "keep_end_layers", "start_end_only",
  "locked", "free", "zone_layer_connections", "tenting", "capping", "covering", "plugging", "filling", "padstack", "teardrops", "net", "uuid", "tstamp"];
const same = (a: TeardropParams, b: TeardropParams): boolean => (Object.keys(b) as (keyof TeardropParams)[]).every((k) => (typeof a[k] === "number" ? Math.abs((a[k] as number) - (b[k] as number)) < 1e-9 : a[k] === b[k]));
function writeTd(n: SNode, td: TeardropParams, via: boolean): void {
  // isDefaultTeardropParameters: a node at the defaults is left out
  const text = same(td, PM().TD_DEFAULTS) ? null : PM().formatTeardrops(td);
  if (!via) { PM().setPadChild(n, "teardrops", text); return; }
  const at = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "teardrops");
  if (text === null) { if (at > 0) n.splice(at, 1); return; }
  const node = K.parse(text) as SNode;
  if (at > 0) { n[at] = node; return; }
  const rank = VIA_ORDER.indexOf("teardrops"); let ins = n.length;
  for (let j = 1; j < n.length; j++) { const c = n[j]; if (Array.isArray(c) && VIA_ORDER.indexOf(String(c[0])) > rank) { ins = j; break; } }
  n.splice(ins, 0, node);
}
/** TEARDROP_MANAGER::IsUniformlyRound: a via, or a pad that is a circle (or a square oval) on every layer. */
function isRound(n: SNode, via: boolean): boolean {
  if (via) return true;
  const shape = K.str(n[3]), size = K.kid(n, "size"), ps = K.kid(n, "padstack");
  if (ps && K.kids(ps, "layer").some((l) => { const s = K.kid(l, "shape"), z = K.kid(l, "size"); const sh = s ? K.str(s[1]) : shape; return !(sh === "circle" || (sh === "oval" && z && K.num(z[1]) === K.num(z[2]))); })) return false;
  return shape === "circle" || (shape === "oval" && !!size && K.num(size[1]) === K.num(size[2]));
}
/** BOARD_ITEM::GetLayer for a via (its start layer) or a pad (its first copper layer). */
function firstCopper(n: SNode): string {
  const ls = K.kid(n, "layers"); const names = ls ? ls.slice(1).map((x) => K.str(x)) : [];
  for (const l of names) { if (l === "*.Cu" || l === "F&B.Cu") return "F.Cu"; if (/\.Cu$/.test(l)) return l; }
  return "F.Cu";
}

export function teardropEditChanges(doc: BoardDoc, o: TeardropEditOpts): PcbChange[] {
  const removeAll = o.action === "removeAll";
  // processItem
  const process = (n: SNode, via: boolean): boolean => {
    const before = PM().readTeardrops(n); let td: TeardropParams;
    if (o.action === "remove" || removeAll) td = { ...before, enabled: false };
    else if (o.action === "default") td = { ...(isRound(n, via) ? o.defaults.round : o.defaults.rect), enabled: true };
    else {
      td = { ...before, ...(o.specified || {}) } as TeardropParams;
      for (const k of Object.keys(td) as (keyof TeardropParams)[]) if (td[k] === undefined) (td as unknown as Record<string, unknown>)[k] = before[k];
      if (!o.existingOnly) td.enabled = true;
    }
    if (same(td, before)) return false;
    writeTd(n, td, via); return true;
  };
  // visitItem
  const visit = (n: SNode, via: boolean, picked: boolean, always: boolean): boolean => {
    if (o.selected && !picked) return false;
    if (always) return process(n, via);
    if (o.skip && o.skip({ net: netOf(n).name, layer: firstCopper(n) })) return false;
    if (o.roundOnly && !isRound(n, via)) return false;
    if (o.existingOnly && !PM().readTeardrops(n).enabled) return false;
    return process(n, via);
  };
  const out: PcbChange[] = [], edited = new Map<string, SNode>();
  for (const it of doc.items.values()) {
    if (it.kind === "via" && (o.vias || removeAll)) {
      const n = clone(it.node); if (visit(n, true, !!o.selected && o.selected.has(it.id), removeAll)) { out.push(replacedChange(it, n)); edited.set(it.id, n); }
    } else if (it.kind === "footprint") {
      const n = clone(it.node); let changed = false;
      for (const p of K.kids(n, "pad")) {
        const u = K.kid(p, "uuid"), picked = !!o.selected && (o.selected.has(it.id) || (!!u && o.selected.has(K.str(u[1]))));
        const type = K.str(p[2]);
        if (removeAll) { if (visit(p, false, picked, true)) changed = true; continue; }
        if (o.pthPads && type === "thru_hole") { if (visit(p, false, picked, false)) changed = true; }
        else if (o.smdPads && (type === "smd" || type === "connect" || type === "non_component")) { if (visit(p, false, picked, false)) changed = true; }
      }
      if (changed) { out.push(replacedChange(it, n)); edited.set(it.id, n); }
    }
  }
  // TEARDROP_MANAGER: teardrops nothing asks for any more go (track-to-track ones when that target is cleared)
  if (o.action === "remove" || removeAll) {
    const disabled: { at: [number, number]; r: number; net: string }[] = [];
    for (const it of doc.items.values()) {
      const n = edited.get(it.id) || it.node;
      if (it.kind === "via") { const a = K.kid(n, "at"), s = K.kid(n, "size"); if (a && !PM().readTeardrops(n).enabled) disabled.push({ at: [K.num(a[1]), K.num(a[2])], r: (s ? K.num(s[1]) : 0.8) / 2, net: netOf(n).name }); }
      else if (it.kind === "footprint") {
        // the footprint's (at …) or KiCad 10's (transform (translate …) (rotate …) (scale …)): TRANSFORM_TRS
        const [fx, fy, deg] = K.atOf(n), rot = deg * Math.PI / 180, tr = K.kid(n, "transform"), sc = tr && K.kid(tr, "scale");
        const sx = sc ? K.num(sc[1], 1) || 1 : 1, sy = sc ? K.num(sc[2], 1) || 1 : 1;
        for (const p of K.kids(n, "pad")) {
          if (PM().readTeardrops(p).enabled) continue;
          const a = K.kid(p, "at"), s = K.kid(p, "size"); if (!a) continue;
          const x = K.num(a[1]) * sx, y = K.num(a[2]) * sy, c = Math.cos(rot), sn = Math.sin(rot);
          disabled.push({ at: [fx + x * c + y * sn, fy - x * sn + y * c], r: s ? Math.max(K.num(s[1]), K.num(s[2])) / 2 : 1, net: netOf(p).name });
        }
      }
    }
    for (const it of doc.items.values()) {
      if (it.kind !== "zone") continue;
      const attr = K.kid(it.node, "attr"), td = attr && K.kid(attr, "teardrop"); if (!td) continue;
      const tt = K.kid(td, "type"), type = tt ? K.str(tt[1]) : "padvia";
      if (type === "track_end") { if (removeAll || o.trackToTrack) out.push(removedChange(it)); continue; }
      if (removeAll) { out.push(removedChange(it)); continue; }
      const nn = K.kid(it.node, "net_name"), net = nn ? K.str(nn[1]) : netOf(it.node).name, pts = K.ptsOf(K.kid(it.node, "polygon") || it.node) as [number, number][];
      if (disabled.some((d) => d.net === net && pts.some((p) => Math.hypot(p[0] - d.at[0], p[1] - d.at[1]) <= d.r + 1e-3))) out.push(removedChange(it));
    }
  }
  return out;
}
