// pcbdialogs/track-via-model — what DIALOG_TRACK_VIA_PROPERTIES reads from and writes to a track or via node:
// the via's padstack (mode, per-layer diameters), annular-ring mode, IPC-4761 protection preset (tenting /
// covering / plugging / filling / capping), backdrills, hole post-machining and teardrop parameters, and a
// track's solder mask.  Children are written where pcb_io_kicad_sexpr puts them, and a value the person did
// not change is never rewritten.  Pure: the parser is handed in (KiCadCanvas.parse in the editor).
export type Parse = (text: string) => SNode;
const isList = Array.isArray;
export const kid = (n: SNode | null | undefined, key: string): SNode | null => { if (!n) return null; for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === key) return c as SNode; } return null; };
const num = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? n[i] as number : d);
const str = (n: SNode | null, i = 1): string => (n && n[i] !== undefined && !isList(n[i]) ? String(n[i]) : "");
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export const f6 = (v: number): string => String(+(+v).toFixed(6));
const yesNo = (n: SNode | null): boolean | undefined => { if (!n) return undefined; const v = str(n); return v === "" || v === "yes" ? true : v === "no" ? false : undefined; };

/** pcb_io_kicad_sexpr::format( PCB_TRACK* ): the order of a via's and a track's children. */
export const VIA_ORDER = ["at", "size", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "layers", "remove_unused_layers", "keep_end_layers", "start_end_only",
  "locked", "free", "zone_layer_connections", "tenting", "capping", "covering", "plugging", "filling", "padstack", "teardrops", "net", "uuid", "tstamp"];
export const TRACK_ORDER = ["start", "mid", "end", "width", "locked", "layer", "layers", "solder_mask_margin", "net", "uuid", "tstamp"];
/** Replace the (key …) child with `text` (null removes it), or insert it where `order` puts it. */
export function setChild(node: SNode, key: string, text: string | null, order: string[], parse: Parse): void {
  let at = -1; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) { at = j; break; } }
  if (text === null) { if (at > 0) node.splice(at, 1); return; }
  const n = parse(text);
  if (at > 0) { node[at] = n; return; }
  const rank = order.indexOf(key); let ins = node.length;
  if (rank >= 0) for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && order.indexOf(String(c[0])) > rank) { ins = j; break; } }
  node.splice(ins, 0, n);
}

// ---------------------------------------------------------------- annular rings (UNCONNECTED_LAYER_MODE)
/** m_annularRingsCtrl: 0 All copper layers, 1 Start, end, and connected layers, 2 Connected layers only, 3 Start and end layers only. */
export function annularMode(via: SNode): number {
  if (yesNo(kid(via, "start_end_only"))) return 3;
  if (yesNo(kid(via, "remove_unused_layers"))) return yesNo(kid(via, "keep_end_layers")) ? 1 : 2;
  return 0;
}
export function setAnnularMode(via: SNode, mode: number, parse: Parse): void {
  if (annularMode(via) === mode) return;
  for (const k of ["remove_unused_layers", "keep_end_layers", "start_end_only"]) setChild(via, k, null, VIA_ORDER, parse);
  if (mode === 1 || mode === 2) { setChild(via, "remove_unused_layers", "(remove_unused_layers yes)", VIA_ORDER, parse); setChild(via, "keep_end_layers", `(keep_end_layers ${mode === 1 ? "yes" : "no"})`, VIA_ORDER, parse); }
  else if (mode === 3) setChild(via, "start_end_only", "(start_end_only yes)", VIA_ORDER, parse);
  // GetRemoveUnconnected(): the zone layer overrides are written for every mode but All copper layers
  if (mode === 0) setChild(via, "zone_layer_connections", null, VIA_ORDER, parse);
  else if (!kid(via, "zone_layer_connections")) setChild(via, "zone_layer_connections", "(zone_layer_connections)", VIA_ORDER, parse);
}

// ---------------------------------------------------------------- IPC-4761 protection (VIA_PROTECTION_UI_MIXIN)
type Surf = "board" | "none" | "front" | "back" | "both" | "custom";
type Drl = "board" | "no" | "yes";
interface Prot { tent: Surf; cover: Surf; plug: Surf; fill: Drl; cap: Drl }
const P = (tent: Surf = "none", cover: Surf = "none", plug: Surf = "none", fill: Drl = "no", cap: Drl = "no"): Prot => ({ tent, cover, plug, fill, cap });
/** m_IPC4761Presets and m_IPC4761Names, FROM_BOARD … VII (CUSTOM is not offered). */
export const IPC4761: [string, Prot][] = [
  ["From rules", P("board", "board", "board", "board", "board")], ["None", P()],
  ["Type I-a (tented top)", P("front")], ["Type I-b (tented both sides)", P("both")], ["Type I-a (tented bottom)", P("back")],
  ["Type II-a (covered & tented top)", P("front", "front")], ["Type II-b (covered & tented both sides)", P("both", "both")], ["Type II-a (covered & tented bottom)", P("back", "back")],
  ["Type III-a (plugged top)", P("none", "none", "front")], ["Type III-b (plugged both sides)", P("none", "none", "both")], ["Type III-a (plugged bottom)", P("none", "none", "back")],
  ["Type IV-a (plugged & tented top)", P("front", "none", "front")], ["Type IV-b (plugged & tented both sides)", P("both", "none", "both")], ["Type IV-a (plugged & tented bottom)", P("back", "none", "back")],
  ["Type V (filled)", P("none", "none", "none", "yes")], ["Type VI-a (filled & tented top)", P("front", "none", "none", "yes")], ["Type VI-b (filled & tented both sides)", P("both", "none", "none", "yes")],
  ["Type VI-a (filled & tented bottom)", P("back", "none", "none", "yes")], ["Type VII (filled & capped)", P("none", "none", "none", "yes", "yes")],
];
export const IPC4761_CUSTOM = IPC4761.length;
/** parseFrontBackOptBool: (key (front yes) (back no)), or the legacy (tenting front back) / (tenting none). */
function frontBack(via: SNode, key: string): [boolean | undefined, boolean | undefined] {
  const n = kid(via, key); if (!n) return [undefined, undefined];
  let front: boolean | undefined, back: boolean | undefined;
  for (let j = 1; j < n.length; j++) {
    const c = n[j];
    if (isList(c)) { const v = str(c); const b = v === "yes" ? true : v === "no" ? false : undefined; if (c[0] === "front") front = b; else if (c[0] === "back") back = b; }
    else if (c === "front") front = true; else if (c === "back") back = true; else if (c === "none") { front = undefined; back = undefined; }
  }
  return [front, back];
}
/** getProtectionSurface. */
function surface(front: boolean | undefined, back: boolean | undefined): Surf {
  const v: Surf = front === undefined ? "board" : front ? "front" : "none";
  if (back === undefined) return v === "board" ? "board" : "custom";
  if (back) return v === "front" ? "both" : v === "none" ? "back" : "custom";
  return v === "front" ? "front" : v === "none" ? "none" : "custom";
}
const drillOpt = (via: SNode, key: string): Drl => { const n = kid(via, key); if (!n) return "board"; const v = str(n); return v === "yes" ? "yes" : v === "no" ? "no" : "board"; };
/** getViaConfiguration: the preset index (IPC4761_CUSTOM when the via's features match none). */
export function protectionPreset(via: SNode): number {
  const [tf, tb] = frontBack(via, "tenting"), [cf, cb] = frontBack(via, "covering"), [pf, pb] = frontBack(via, "plugging");
  const c: Prot = { tent: surface(tf, tb), cover: surface(cf, cb), plug: surface(pf, pb), fill: drillOpt(via, "filling"), cap: drillOpt(via, "capping") };
  const i = IPC4761.findIndex(([, p]) => p.tent === c.tent && p.cover === c.cover && p.plug === c.plug && p.fill === c.fill && p.cap === c.cap);
  return i < 0 ? IPC4761_CUSTOM : i;
}
/** setViaConfiguration: a preset below CUSTOM rewrites the five features; the via's own text is kept when it already says the same. */
export function setProtectionPreset(via: SNode, preset: number, parse: Parse): void {
  if (preset < 0 || preset >= IPC4761_CUSTOM || protectionPreset(via) === preset) return;
  const p = IPC4761[preset][1];
  const fb = (s: Surf): [string, string] => (s === "board" ? ["none", "none"] : [s === "front" || s === "both" ? "yes" : "no", s === "back" || s === "both" ? "yes" : "no"]);
  const surf = (key: string, s: Surf): void => {
    const [f, b] = fb(s);
    // FormatOptBool: an unset side is "none"; both unset and no key written at all means "from rules"
    if (s === "board") { setChild(via, key, null, VIA_ORDER, parse); return; }
    setChild(via, key, `(${key} (front ${f}) (back ${b}))`, VIA_ORDER, parse);
  };
  surf("tenting", p.tent); surf("covering", p.cover); surf("plugging", p.plug);
  setChild(via, "capping", p.cap === "board" ? null : `(capping ${p.cap})`, VIA_ORDER, parse);
  setChild(via, "filling", p.fill === "board" ? null : `(filling ${p.fill})`, VIA_ORDER, parse);
}

// ---------------------------------------------------------------- backdrill (secondary / tertiary drill)
export interface Backdrill { size: number; end: string }
/** getBackdrillDrills: the drill started from F.Cu is the front one, from B.Cu the back one. */
export function backdrills(via: SNode): { front: Backdrill | null; back: Backdrill | null } {
  const out: { front: Backdrill | null; back: Backdrill | null } = { front: null, back: null };
  for (const key of ["backdrill", "tertiary_drill"]) {
    const n = kid(via, key); if (!n) continue;
    const ls = kid(n, "layers"), size = num(kid(n, "size")), start = str(ls, 1), end = str(ls, 2);
    if (!(size > 0) || !end) continue;
    if (start === "F.Cu" && !out.front) out.front = { size, end }; else if (start === "B.Cu" && !out.back) out.back = { size, end };
  }
  return out;
}
/** BACKDRILL_MODE: 0 None, 1 Bottom, 2 Top, 3 Both (m_backdrillChoice). */
export function backdrillMode(via: SNode): number { const b = backdrills(via); return b.front && b.back ? 3 : b.back ? 1 : b.front ? 2 : 0; }
export function setBackdrills(via: SNode, front: Backdrill | null, back: Backdrill | null, parse: Parse): void {
  const cur = backdrills(via);
  const same = (a: Backdrill | null, b: Backdrill | null): boolean => (!a && !b) || (!!a && !!b && Math.abs(a.size - b.size) < 1e-9 && a.end === b.end);
  if (same(cur.front, front) && same(cur.back, back)) return;
  const node = (key: string, start: string, d: Backdrill): string => `(${key} (size ${f6(d.size)}) (layers ${quote(start)} ${quote(d.end)}))`;
  // the secondary drill holds the top backdrill, the tertiary the bottom one (TransferDataFromWindow)
  setChild(via, "backdrill", front ? node("backdrill", "F.Cu", front) : null, VIA_ORDER, parse);
  setChild(via, "tertiary_drill", back ? node("tertiary_drill", "B.Cu", back) : null, VIA_ORDER, parse);
}

// ---------------------------------------------------------------- hole post-machining
export interface PostMachining { mode: "none" | "countersink" | "counterbore"; size: number; depth: number; angle: number }
export function postMachining(via: SNode, front: boolean): PostMachining {
  const n = kid(via, front ? "front_post_machining" : "back_post_machining");
  if (!n) return { mode: "none", size: 0, depth: 0, angle: 0 };
  const m = str(n); return { mode: m === "countersink" || m === "counterbore" ? m : "none", size: num(kid(n, "size")), depth: num(kid(n, "depth")), angle: num(kid(n, "angle")) };
}
export function setPostMachining(via: SNode, front: boolean, pm: PostMachining, parse: Parse): void {
  const cur = postMachining(via, front);
  if (cur.mode === pm.mode && cur.size === pm.size && cur.depth === pm.depth && cur.angle === pm.angle) return;
  const key = front ? "front_post_machining" : "back_post_machining";
  if (pm.mode === "none") { setChild(via, key, null, VIA_ORDER, parse); return; }
  setChild(via, key, `(${key} ${pm.mode}${pm.size > 0 ? ` (size ${f6(pm.size)})` : ""}${pm.depth > 0 ? ` (depth ${f6(pm.depth)})` : ""}${pm.angle > 0 ? ` (angle ${f6(pm.angle)})` : ""})`, VIA_ORDER, parse);
}

// ---------------------------------------------------------------- teardrops (TEARDROP_PARAMETERS)
export interface Teardrops { enabled: boolean; allowTwo: boolean; maxLen: number; maxWidth: number; bestLength: number; bestWidth: number; filter: number; curved: boolean; preferZone: boolean }
export const TEARDROP_DEFAULTS: Teardrops = { enabled: false, allowTwo: true, maxLen: 1, maxWidth: 2, bestLength: 0.5, bestWidth: 1, filter: 0.9, curved: false, preferZone: true };
export function teardrops(n: SNode): Teardrops {
  const t = kid(n, "teardrops"); if (!t) return { ...TEARDROP_DEFAULTS };
  const b = (k: string, d: boolean): boolean => { const v = yesNo(kid(t, k)); return v === undefined ? d : v; };
  return { enabled: b("enabled", false), allowTwo: b("allow_two_segments", true), maxLen: num(kid(t, "max_length"), 1, 1), maxWidth: num(kid(t, "max_width"), 1, 2),
    bestLength: num(kid(t, "best_length_ratio"), 1, 0.5), bestWidth: num(kid(t, "best_width_ratio"), 1, 1), filter: num(kid(t, "filter_ratio"), 1, 0.9), curved: b("curved_edges", false), preferZone: b("prefer_zone_connections", true) };
}
const sameTd = (a: Teardrops, b: Teardrops): boolean => (Object.keys(a) as (keyof Teardrops)[]).every((k) => (typeof a[k] === "number" ? Math.abs((a[k] as number) - (b[k] as number)) < 1e-9 : a[k] === b[k]));
/** isDefaultTeardropParameters leaves the node out; formatTeardropParameters otherwise. */
export function setTeardrops(n: SNode, td: Teardrops, order: string[], parse: Parse): void {
  if (sameTd(teardrops(n), td)) return;
  if (sameTd(td, TEARDROP_DEFAULTS)) { setChild(n, "teardrops", null, order, parse); return; }
  const yn = (v: boolean): string => (v ? "yes" : "no");
  setChild(n, "teardrops", `(teardrops (best_length_ratio ${f6(td.bestLength)}) (max_length ${f6(td.maxLen)}) (best_width_ratio ${f6(td.bestWidth)}) (max_width ${f6(td.maxWidth)}) (curved_edges ${yn(td.curved)}) (filter_ratio ${f6(td.filter)}) (enabled ${yn(td.enabled)}) (allow_two_segments ${yn(td.allowTwo)}) (prefer_zone_connections ${yn(td.preferZone)}))`, order, parse);
}

// ---------------------------------------------------------------- padstack (PADSTACK::MODE)
export type PadstackMode = "normal" | "front_inner_back" | "custom";
/** The via's diameters: "all" (normal), or by layer ("F.Cu", "Inner", "B.Cu", "In1.Cu" …). */
export function padstack(via: SNode): { mode: PadstackMode; sizes: Record<string, number> } {
  const size = num(kid(via, "size")), ps = kid(via, "padstack");
  const m = str(kid(ps, "mode")), mode: PadstackMode = m === "front_inner_back" || m === "custom" ? m : "normal";
  const sizes: Record<string, number> = { "F.Cu": size };
  if (ps) for (let j = 1; j < ps.length; j++) { const c = ps[j]; if (isList(c) && c[0] === "layer") sizes[str(c)] = num(kid(c as SNode, "size"), 1, size); }
  return { mode, sizes };
}
/** The diameter on one edit layer: F.Cu holds the "(size …)" of every mode; others fall back to it. */
export function padstackSize(ps: { mode: PadstackMode; sizes: Record<string, number> }, layer: string): number {
  if (ps.mode === "normal" || layer === "F.Cu" || layer === "all") return ps.sizes["F.Cu"];
  return ps.sizes[layer] ?? ps.sizes["F.Cu"];
}
/** Write the mode and the diameters (size is the front layer's; a normal stack has no (padstack …) node). */
export function setPadstack(via: SNode, ps: { mode: PadstackMode; sizes: Record<string, number> }, copper: string[], parse: Parse): void {
  const cur = padstack(via), front = ps.sizes["F.Cu"];
  if (Math.abs(num(kid(via, "size")) - front) > 1e-9) setChild(via, "size", `(size ${f6(front)})`, VIA_ORDER, parse);
  const layers = ps.mode === "front_inner_back" ? ["Inner", "B.Cu"] : ps.mode === "custom" ? copper.filter((l) => l !== "F.Cu") : [];
  const same = cur.mode === ps.mode && layers.every((l) => Math.abs(padstackSize(cur, l) - padstackSize(ps, l)) < 1e-9);
  if (same) return;
  if (ps.mode === "normal") { setChild(via, "padstack", null, VIA_ORDER, parse); return; }
  setChild(via, "padstack", `(padstack (mode ${ps.mode})${layers.map((l) => ` (layer ${quote(l)} (size ${f6(padstackSize(ps, l))}))`).join("")})`, VIA_ORDER, parse);
}

// ---------------------------------------------------------------- track solder mask
/** HasSolderMask: the track's layer set holds its side's mask layer. */
export function trackHasMask(t: SNode): boolean { const ls = kid(t, "layers"); return !!ls && ls.slice(1).some((l) => /\.Mask$/.test(String(l))); }
export function trackLayer(t: SNode): string { const l = kid(t, "layer"); if (l) return str(l); const ls = kid(t, "layers"); return ls ? str(ls) : ""; }
export function trackMaskMargin(t: SNode): number | null { const m = kid(t, "solder_mask_margin"); return m ? num(m) : null; }
/** SetLayer / SetHasSolderMask / SetLocalSolderMaskMargin, written as format( PCB_TRACK* ) does. */
export function setTrackLayerAndMask(t: SNode, layer: string, mask: boolean, margin: number | null, parse: Parse): void {
  const external = layer === "F.Cu" || layer === "B.Cu";
  const wantMask = mask && external;
  const was = { layer: trackLayer(t), mask: trackHasMask(t), margin: trackMaskMargin(t) };
  if (was.layer !== layer || was.mask !== wantMask) {
    setChild(t, "layer", null, TRACK_ORDER, parse); setChild(t, "layers", null, TRACK_ORDER, parse);
    if (wantMask) setChild(t, "layers", `(layers ${quote(layer)} ${quote(layer === "F.Cu" ? "F.Mask" : "B.Mask")})`, TRACK_ORDER, parse);
    else setChild(t, "layer", `(layer ${quote(layer)})`, TRACK_ORDER, parse);
  }
  const m = wantMask ? margin : null;
  if (!(m === was.margin || (m !== null && was.margin !== null && Math.abs(m - was.margin) < 1e-9))) setChild(t, "solder_mask_margin", m === null ? null : `(solder_mask_margin ${f6(m)})`, TRACK_ORDER, parse);
}
