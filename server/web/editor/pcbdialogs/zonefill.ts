// pcbdialogs/zonefill — ZONE_FILLER_TOOL (pcbnew/tools/zone_filler_tool.cpp) for the web board editor:
//
//   Fill All Zones (B)                    every board zone, WX_PROGRESS_REPORTER "Fill All Zones" (5 phases),
//                                         commit "Fill Zone(s)"
//   Draft Fill Selected Zone(s)           the selected zones, reporter "Fill Zone", commit "Fill Zone(s)"
//   ZoneFillDirty                         after an edit, when Preferences > PCB Editor > Editing Options >
//                                         Automatically refill zones is on: the zones the edit touched (and every
//                                         unfilled one) refilled into the edit's own undo step ("Auto-fill
//                                         Zone(s)"), a reporter "Refill %d Zones" only past 1000 fill points, and
//                                         after 3 s the infobar hint that the refill can be turned off
//   CheckAllZones                         the DRC dialog's "Refill all zones before performing DRC"
//
// The filler is ZONE_FILLER ported to TypeScript (web/fab/zonefill.ts, in the fab bundle).  It runs in a Web
// Worker built from the same two scripts the page loads, so the editor keeps drawing; Cancel terminates the
// worker and nothing is committed (BOARD_COMMIT::Revert).  Where a worker cannot start it runs on the page,
// yielding between zones.
import type { FillProgress, FillRules, ZoneFillResult } from "../../fab/zonefill";
import type { KiCadFabApi } from "../../fab/index";
import { loadFab } from "../fab-outputs";
import { selectionIds } from "../gestures";
import { prefs } from "../../dialogs/prefs";
import { E } from "../state";
import { store } from "../appstore";
import { loadBoardHeader } from "./board-setup";
import { h, openDialog, type DialogApi } from "./ui";
import { type Damage, type ZoneInfo, itemLayers, staleZones } from "./zone-damage";

interface Settings { clearance: number; minClearance?: number; holeClearance?: number; edgeClearance: number; netclasses: Record<string, { clearance?: number }> }
interface PcbToolsApi {
  designSettings(src: unknown): Settings;
  netclassOf(s: Settings, net: string): { clearance?: number };
  replacedChange(item: KItem, node: SNode): KChange;
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const board = (): KDoc | null => (E.kdoc && (E.kdoc as KDoc).type === "pcb" ? (E.kdoc as KDoc) : null);

/** Rules as plain data (a worker cannot be handed a function): each net's netclass clearance and the board minimums. */
interface RuleData { nets: Record<string, number>; dflt: number; minClearance: number; holeClearance: number; edgeClearance: number }
function ruleData(doc: KDoc): RuleData {
  const P = PT(); const s = P.designSettings(E.proSettings || null);
  const nets: Record<string, number> = {};
  const names = new Set<string>(doc.nets ? [...doc.nets.values()] : []);
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" && it.kind !== "footprint") continue;
    const visit = (n: SNode): void => { for (const c of n) if (Array.isArray(c)) { if (c[0] === "net" || c[0] === "net_name") { const v = c[c.length - 1]; if (typeof v === "string") names.add(v); } else if (c[0] === "pad") visit(c as SNode); } };
    visit(it.node);
  }
  for (const n of names) { const nc = P.netclassOf(s, n); nets[n] = nc && nc.clearance !== undefined ? nc.clearance : s.clearance; }
  return { nets, dflt: s.clearance, minClearance: s.minClearance || 0, holeClearance: s.holeClearance || 0, edgeClearance: s.edgeClearance };
}
const rulesOf = (d: RuleData): FillRules => ({ netClearance: (n: string) => (n in d.nets ? d.nets[n] : d.dflt), minClearance: d.minClearance, holeClearance: d.holeClearance, edgeClearance: d.edgeClearance });

// ---------------------------------------------------------------- the progress reporter (WX_PROGRESS_REPORTER)
export interface Reporter { phase(n: number, text: string): void; advance(done: number, total: number): void; cancelled(): boolean; close(): void; onCancel?: () => void }

/** A modal progress dialog: the phase message, a gauge, the elapsed time and Cancel. */
export function progressDialog(title: string, phases: number): Reporter {
  let cancelled = false; let phase = 1, frac = 0; let api: DialogApi | null = null;
  const msg = h("div", { class: "zf-msg", style: "min-height:1.4em;margin:2px 0 8px" }, "");
  const bar = h("div", { class: "zf-bar", style: "height:100%;width:0%;background:var(--accent);transition:width .1s" });
  const gauge = h("div", { class: "zf-gauge", role: "progressbar", style: "height:14px;border:1px solid var(--line);border-radius:var(--r-1);background:var(--paper);overflow:hidden" }, bar);
  const elapsed = h("div", { class: "zf-time", style: "margin-top:8px;color:var(--ink-2);font-variant-numeric:tabular-nums" }, "Elapsed time: 0:00:00");
  const t0 = Date.now();
  const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); elapsed.textContent = `Elapsed time: ${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }, 250);
  const rep: Reporter = {
    phase(n, text) { phase = n; frac = 0; if (text) msg.textContent = text; draw(); },
    advance(done, total) { frac = total ? done / total : 0; draw(); },
    cancelled: () => cancelled,
    close() { clearInterval(tick); if (api) { const a = api; api = null; a.close(); } },
  };
  const draw = (): void => { bar.style.width = `${Math.min(100, ((phase - 1 + frac) / phases) * 100).toFixed(1)}%`; };
  api = openDialog({ title, width: 420, noOk: true, cancelLabel: "Cancel",
    build(body) { body.classList.add("zf-progress"); body.append(msg, gauge, elapsed); },
    cancel() { if (!api) return; cancelled = true; api = null; clearInterval(tick); if (rep.onCancel) rep.onCancel(); } });
  return rep;
}

// ---------------------------------------------------------------- running the filler
let workerUrl: Promise<string> | null = null;
function scriptUrl(path: string): string {
  const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
  const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
  return new URL(path + (query ? "?" + query : ""), location.href).href;
}
/** The worker: kicad-canvas (text strokes, the document model) and the fab bundle (the filler), fetched as the page fetches them. */
function fillWorkerUrl(): Promise<string> {
  if (workerUrl) return workerUrl;
  workerUrl = (async () => {
    const [canvas, fab] = await Promise.all([fetch(scriptUrl("/static/kicad-canvas.js")).then((r) => r.text()), fetch(scriptUrl("/static/dist/fab.js")).then((r) => r.text())]);
    if (!/fillZones/.test(fab)) throw new Error("this fab bundle has no zone filler");
    const main = `;(function(){var F=self.KiCadFab;self.onmessage=function(e){var d=e.data;var R=d.rules;
(d.fonts||[]).forEach(function(f){self.KiCadCanvas.setFontData(f[0],f[1],f[2],f[3])});
var rules={netClearance:function(n){return Object.prototype.hasOwnProperty.call(R.nets,n)?R.nets[n]:R.dflt},minClearance:R.minClearance,holeClearance:R.holeClearance,edgeClearance:R.edgeClearance};
var prog={phase:function(n,t){self.postMessage({t:"phase",n:n,text:t})},advance:function(a,b){self.postMessage({t:"adv",a:a,b:b})},cancelled:function(){return false},yield:function(){return Promise.resolve()}};
F.fillZones({doc:d.doc,setup:d.setup},rules,d.ids,prog).then(function(r){self.postMessage({t:"done",r:r})},function(err){self.postMessage({t:"error",m:String(err&&err.stack||err)})});};})();`;
    return URL.createObjectURL(new Blob([canvas, "\n;\n", fab, "\n", main], { type: "text/javascript" }));
  })();
  workerUrl.catch(() => { workerUrl = null; });
  return workerUrl;
}

/** The document without what the renderer caches on it (Path2D outlines, which a worker cannot be sent). */
function stripCaches(v: unknown): unknown {
  if (v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
  if (typeof Path2D !== "undefined" && v instanceof Path2D) return undefined;
  if (Array.isArray(v)) return v.map(stripCaches);
  if (v instanceof Map || v instanceof Set) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const y = stripCaches(x); if (y !== undefined) out[k] = y; }
  return out;
}
function transferable(doc: KDoc): KDoc {
  const items = new Map<string, unknown>();
  for (const [id, it] of doc.items) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(it as unknown as Record<string, unknown>)) o[k] = k === "node" ? x : stripCaches(x);
    items.set(id, o);
  }
  return { ...(doc as unknown as Record<string, unknown>), items } as unknown as KDoc;
}

/** The fill of `ids` (all zones when null); null when cancelled. */
async function computeFill(doc: KDoc, ids: string[] | null, rep: Reporter | null, F: KiCadFabApi): Promise<ZoneFillResult[] | null> {
  const header = await loadBoardHeader().catch(() => null);
  const setup = header && header.setup ? header.setup : null;
  const rd = ruleData(doc);
  // a worker first: the page keeps drawing and Cancel stops it outright
  let url: string | null = null; try { url = await fillWorkerUrl(); } catch (e) { url = null; }
  if (url && typeof Worker !== "undefined") {
    let payload: unknown = null;
    try { payload = { doc: transferable(doc), setup, ids, rules: rd, fonts: KiCadCanvas.allFontData() }; structuredClone(payload); } catch (e) { console.warn("zone fill: board not transferable", e); payload = null; }
    if (payload) {
      const res = await new Promise<ZoneFillResult[] | null | "fallback">((resolve) => {
        let w: Worker; try { w = new Worker(url as string); } catch (e) { resolve("fallback"); return; }
        if (rep) rep.onCancel = () => { w.terminate(); resolve(null); };
        w.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { t: string; n?: number; text?: string; a?: number; b?: number; r?: ZoneFillResult[]; m?: string };
          if (m.t === "phase" && rep) rep.phase(m.n || 1, m.text || "");
          else if (m.t === "adv" && rep) rep.advance(m.a || 0, m.b || 0);
          else if (m.t === "done") { w.terminate(); resolve(m.r || null); }
          else if (m.t === "error") { w.terminate(); console.warn("zone fill worker:", m.m); resolve("fallback"); }
        };
        w.onerror = (ev) => { ev.preventDefault(); w.terminate(); resolve("fallback"); };
        w.postMessage(payload);
      });
      if (res !== "fallback") return res;
    }
  }
  // on the page, yielding between zones
  let cancelled = false; if (rep) rep.onCancel = () => { cancelled = true; };
  const prog: FillProgress = { phase: (n, t) => rep && rep.phase(n, t), advance: (a, b) => rep && rep.advance(a, b), cancelled: () => cancelled, yield: () => new Promise((r) => setTimeout(r, 0)) };
  const out = await F.fillZones({ doc: doc as never, setup: setup as never }, rulesOf(rd), ids, prog);
  return cancelled ? null : out;
}

/** The zone items' nodes with the new fills, as MODIFIED changes. */
function fillChanges(doc: KDoc, results: ZoneFillResult[], F: KiCadFabApi): KChange[] {
  const out: KChange[] = [];
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  for (const r of results) {
    const it = doc.items.get(r.id); if (!it) continue;
    const node = F.filledZoneNode(it.node as never, r, copper, (n) => (KiCadCanvas.cloneNode as (x: SNode) => SNode)(n as unknown as SNode) as never) as unknown as SNode;
    if (KiCadCanvas.serialize(node) === KiCadCanvas.serialize(it.node)) continue;   // nothing changed: no edit
    out.push(PT().replacedChange(it, node));
  }
  return out;
}

let inProgress = false;
export const fillInProgress = (): boolean => inProgress;

/**
 * PCB_EDIT_FRAME::m_ZoneFillsDirty.  OnModify sets it for every change to the board — a local commit (an unfill
 * too), an undo or redo, a settings change, and here another user's edit — and only a fill of every zone
 * (FillAllZones, CheckAllZones) clears it.  The document's change counter (bumped by applyChanges for all of
 * those) is noted when such a fill ends; the fills are dirty once it moves on or the document is another one.
 */
let cleanAt: { doc: unknown; version: number } | null = null;
const docVersion = (): number => store.get().document.version;
export function zoneFillsDirty(): boolean { return !cleanAt || cleanAt.doc !== E.kdoc || cleanAt.version !== docVersion(); }
export function markZoneFillsClean(): void { cleanAt = { doc: E.kdoc, version: docVersion() }; }
/** the counter a fill that started at `before` leaves when nothing else changed the board meanwhile */
export function fillOnlyVersion(before: number, committed: boolean): number { return before + (committed ? 1 : 0); }

export interface FillOptions {
  ids: string[] | null;
  /** the progress reporter's title; none for a quiet refill */
  title?: string | null; phases?: number;
  label: string; amend?: boolean;
  /** a fill of every zone (FillAllZones / CheckAllZones): the board's fills are clean afterwards */
  all?: boolean;
  /** report into an existing status line instead of a dialog (the DRC dialog) */
  status?: HTMLElement | null;
}

/** Fill, then commit the fills as one undo step.  True when it committed (or there was nothing to change). */
export async function runZoneFill(ctx: ToolCtx, o: FillOptions): Promise<boolean> {
  const doc = board(); if (!doc) return false;
  if (inProgress) return false;
  if (ctx.viewOnly) { ctx.toast("View only"); return false; }
  inProgress = true;
  const v0 = docVersion();
  let rep: Reporter | null = null;
  try {
    const F = await loadFab();
    if (o.status) { const st = o.status; rep = { phase(n, t) { if (t) st.textContent = t; }, advance() {}, cancelled: () => false, close() {} }; }
    else if (o.title) rep = progressDialog(o.title, o.phases || 5);
    const results = await computeFill(doc, o.ids, rep, F);
    if (!results || board() !== doc) return false;
    const changes = fillChanges(doc, results, F);
    if (changes.length) ctx.commit(changes, o.label, o.amend ? { amend: true } : undefined);
    // an edit that landed while the filler ran (another user's) leaves the fills dirty
    if (o.all && docVersion() === fillOnlyVersion(v0, changes.length > 0)) markZoneFillsClean();
    ctx.requestRender();
    return true;
  } catch (e) {
    console.error(e); ctx.toast("Zone fill failed: " + (e instanceof Error ? e.message : String(e)));
    return false;
  } finally {
    inProgress = false;
    if (rep) rep.close();
  }
}

// ---------------------------------------------------------------- the actions
const zoneIds = (doc: KDoc, ids: Iterable<string>): string[] => { const out: string[] = []; for (const id of ids) { const it = doc.items.get(id); if (it && it.kind === "zone") out.push(id); } return out; };
const allZoneIds = (doc: KDoc): string[] => [...doc.items.values()].filter((it) => it.kind === "zone").map((it) => it.id);

/** ZONE_FILLER_TOOL::ZoneFillAll. */
export function zoneFillAll(ctx: ToolCtx): boolean {
  const doc = board(); if (!doc) return false;
  if (inProgress) return true;
  void runZoneFill(ctx, { ids: allZoneIds(doc), title: "Fill All Zones", phases: 5, label: "Fill Zone(s)", all: true });
  return true;
}
/** ZONE_FILLER_TOOL::ZoneFill: the selected zones (wxBell when there are none or a fill is running). */
export function zoneFillSelected(ctx: ToolCtx): boolean {
  const doc = board(); if (!doc) return false;
  const ids = zoneIds(doc, selectionIds());
  if (inProgress || !ids.length) { bell(); return true; }
  void runZoneFill(ctx, { ids, title: "Fill Zone", phases: 5, label: "Fill Zone(s)" });
  return true;
}
function bell(): void {
  try { const AC = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext; if (!AC) return; const a = new AC(); const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.04; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.08); setTimeout(() => { void a.close(); }, 200); } catch (e) { /* no audio */ }
}

// ---------------------------------------------------------------- ZoneFillDirty
const autoRefillOn = (): boolean => !!prefs().pcbEditing.autoRefillZones;
const FILL_LABELS = new Set(["Fill Zone(s)", "Auto-fill Zone(s)", "Unfill Zone", "Unfill All Zones"]);
const damageOf = (doc: KDoc, it: KItem | undefined): Damage | null => (it && it.bbox ? { box: it.bbox, layers: itemLayers(it.node, doc.copper) } : null);

/** The zones an edit dirtied (BOARD_COMMIT::propagateDamage → ZONE_FILLER_TOOL::ZoneFillDirty). */
export function dirtyZones(doc: KDoc, before: Map<string, Damage | null>, changes: KChange[]): string[] {
  const damage: Damage[] = []; const changed = new Set<string>();
  for (const c of changes) {
    changed.add(c.id);
    const d0 = before.get(c.id); if (d0) damage.push(d0);
    const d1 = damageOf(doc, doc.items.get(c.id)); if (d1) damage.push(d1);
  }
  const zones: ZoneInfo[] = [];
  for (const it of doc.items.values()) if (it.kind === "zone") zones.push({ id: it.id, node: it.node, bbox: it.bbox });
  return staleZones(zones, damage, changed, doc.copper);
}

let pending: { before: Map<string, Damage | null>; changes: KChange[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Called by commitChanges before and after every local edit. */
export function noteCommit(phase: "before" | "after", changes: KChange[], label: string | undefined, ctx: () => ToolCtx): void {
  const doc = board(); if (!doc || !autoRefillOn() || inProgress) return;
  if (label && FILL_LABELS.has(label)) return;
  if (phase === "before") {
    const before = pending ? pending.before : new Map<string, Damage | null>();
    for (const c of changes) if (!before.has(c.id)) before.set(c.id, damageOf(doc, doc.items.get(c.id)));
    pending = { before, changes: pending ? pending.changes : [] };
    return;
  }
  if (!pending) return;
  pending.changes = pending.changes.concat(changes);
  if (timer) clearTimeout(timer);
  // after the tool's own commits have settled (a route commits in several pieces)
  timer = setTimeout(() => { timer = null; void zoneFillDirty(ctx()); }, 30);
}

/** ZONE_FILLER_TOOL::ZoneFillDirty. */
export async function zoneFillDirty(ctx: ToolCtx): Promise<void> {
  const doc = board(); const p = pending; pending = null;
  if (!doc || !p) return;
  const ids = dirtyZones(doc, p.before, p.changes); if (!ids.length) return;
  // a reporter only when the fills are big (more than 1000 points)
  let pts = 0; for (const id of ids) { const it = doc.items.get(id); if (!it) continue; for (const c of it.node) if (Array.isArray(c) && c[0] === "filled_polygon") { const ptsN = KiCadCanvas.kid(c as SNode, "pts") as SNode | null; pts += ptsN ? ptsN.length - 1 : 0; } }
  const t0 = Date.now();
  const ok = await runZoneFill(ctx, { ids, title: pts > 1000 ? `Refill ${ids.length} Zones` : null, phases: 5, label: "Auto-fill Zone(s)", amend: true });
  if (ok && Date.now() - t0 > 3000) ctx.toast("Automatic refill of zones can be turned off in Preferences if it becomes too slow.", 10000);
}
