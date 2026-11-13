// Autorouter — the editor side: the Route ▸ Autoroute… command, its dialog, the progress window with a live
// preview, and the commit.  The router only ever runs when someone asks for it, and what it lays down goes through
// the editor's ordinary commit: one undo step, sent to everyone in the session as normal edits.
import { Router, RouteOptions, RouteResult } from "./route";
import { PROVENANCE } from "./weights";
import "../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = globalThis as any;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const CHUNK = 600;   // changes per commit: keeps one edit message well under the server's size limit

export interface AutorouteSummary { total: number; routed: number; failed: { net: string; a: [number, number]; b: [number, number] }[]; segments: number; vias: number; length: number; ms: number; zoneEnds: number; zoneCovered: number; dropped: number; cancelled: boolean; ids: string[]; pairs?: any[]; impedance?: any[]; matched?: any[]; refillAsked?: boolean }
interface Running { router: Router; cancelled: boolean; done: boolean }
let running: Running | null = null;

const docStamp = (doc: any) => { let v = 0; try { v = root.CollabApp.getState().document.version; } catch (e) { /* node, tests */ } return v + ":" + doc.items.size; };
const settingsOf = (ctx: any) => root.PcbTools.designSettings(ctx.designSettings || null);

/** The nets of the selected items (footprint pads, tracks, vias, zones). */
function selectedNets(ctx: any): string[] {
  const P = root.PcbTools, K = ctx.K || root.KiCadCanvas; const ids: Set<string> = P.selectionIds(ctx); const out = new Set<string>(); if (!ids.size) return [];
  const table = P.netTable(ctx.doc);
  for (const id of ids) {
    const it = ctx.doc.items.get(id); if (!it) continue;
    if (it.kind === "footprint") { for (const p of K.kids(it.node, "pad")) { const k = table.key(P.netOf(p)); if (k) out.add(k); } }
    else { const k = table.key(P.netOf(it.node)); if (k) out.add(k); }
  }
  return Array.from(out);
}

/**
 * Route and commit.  `ui` receives progress; resolves with what happened.  Nothing is committed when cancelled.
 * This is also the entry point for other tools (pass no ui for a headless run).
 */
export async function autoroute(ctx: any, opts: RouteOptions = {}, ui?: { progress(p: { done: number; total: number; routed: number; pass: number; net: string }): void }): Promise<AutorouteSummary> {
  const K = ctx.K || root.KiCadCanvas, P = root.PcbTools; const doc = ctx.doc;
  const empty: AutorouteSummary = { total: 0, routed: 0, failed: [], segments: 0, vias: 0, length: 0, ms: 0, zoneEnds: 0, zoneCovered: 0, dropped: 0, cancelled: false, ids: [] };
  if (!doc || ctx.viewOnly || running) return empty;
  const stamp = docStamp(doc); const router = new Router(K, P, doc, settingsOf(ctx), opts); const me: Running = running = { router, cancelled: false, done: false };
  let res: RouteResult;
  try {
    const it = router.run(); let step = it.next(); let last = Date.now();
    while (!step.done) {
      if (Date.now() - last > 40) { if (ui) ui.progress(step.value); if (ctx.requestRender) ctx.requestRender(); await new Promise((r) => setTimeout(r, 0)); last = Date.now(); }
      step = it.next();
    }
    res = step.value;
  } finally { me.done = true; if (running === me) running = null; }
  if (me.cancelled) { if (ctx.requestRender) ctx.requestRender(); return Object.assign(empty, { cancelled: true, total: res.total }); }
  let dropped = 0;
  if (docStamp(doc) !== stamp || doc !== (ctx.liveDoc ? ctx.liveDoc() : doc)) { dropped = router.revalidate(); res = router.result(); }
  const changes = res.items.map((i) => P.addedChange(doc, i.node, i.net)); const ids: string[] = changes.map((c: any) => c.id);
  for (let i = 0; i < changes.length; i += CHUNK) ctx.commit(changes.slice(i, i + CHUNK), "autoroute");
  if (ctx.requestRender) ctx.requestRender();
  // The zones are refilled by the editor's own filler when Automatically refill zones is on (the commits above
  // mark them dirty); otherwise Fill All Zones (B) completes the connections that rely on them.
  const refill = false;
  (empty as any).refillAsked = refill;
  return { refillAsked: refill, total: res.total, routed: res.routed, failed: res.failed, segments: res.segments, vias: res.vias, length: res.length, ms: res.ms, zoneEnds: res.zoneEnds, zoneCovered: res.zoneCovered, dropped, cancelled: false, ids, pairs: res.pairs || [], impedance: res.impedance || [], matched: res.matched || [] };
}

/** One line for the status toast. */
export function summaryText(s: AutorouteSummary): string {
  if (s.cancelled) return "Autoroute cancelled — nothing was changed";
  if (!s.total) return "Autoroute: nothing to route — every connection in scope is already made";
  let t = `Autoroute: ${s.routed} of ${plural(s.total, "connection")} routed, ${plural(s.segments, "track segment")}, ${plural(s.vias, "via")}`;
  if (s.failed.length) t += ` — ${s.failed.length} left unrouted`;
  const pairs = s.pairs || [], zs = s.impedance || [], ms = s.matched || [];
  if (pairs.length) { const c = pairs.filter((p: any) => p.coupled).length; t += `. ${c} of ${plural(pairs.length, "differential pair")} coupled`; }
  if (zs.length) { const a = zs.filter((z: any) => z.applied).length; t += `. Impedance: ${a} of ${plural(zs.length, "net group")} sized from the stackup${a < zs.length ? " (the rest need a width this board cannot carry)" : ""}`; }
  if (ms.length) { const all = ms.reduce((n: number, g: any) => n + g.members.length, 0), ok = ms.reduce((n: number, g: any) => n + g.members.filter((m: any) => m.matched).length, 0); t += `. Length matching: ${ok} of ${all} within tolerance`; }
  return t;
}

// ---------------------------------------------------------------- dialogs
const FIELD = "font:inherit;background:var(--panel);color:inherit;border:1px solid var(--line);border-radius:var(--r-2);padding:3px 5px";
function row(body: HTMLElement, label: string, control: HTMLElement): void {
  const r = document.createElement("label"); r.style.cssText = "display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;margin:4px 0";
  const s = document.createElement("span"); s.textContent = label; r.append(s, control); body.appendChild(r);
}
function note(body: HTMLElement, text: string): HTMLElement { const p = document.createElement("p"); p.className = "note"; p.style.margin = "6px 0"; p.textContent = text; body.appendChild(p); return p; }
function check(on: boolean, key: string): HTMLInputElement { const i = document.createElement("input"); i.type = "checkbox"; i.checked = on; i.dataset.k = key; i.style.cssText = "width:auto;justify-self:start"; return i; }

const EFFORT: Record<string, { label: string; passes: number; timeMs: number }> = {
  fast: { label: "Fast — one pass, up to 20 s", passes: 1, timeMs: 20000 },
  normal: { label: "Normal — three passes, up to 1 min", passes: 3, timeMs: 60000 },
  thorough: { label: "Thorough — six passes, up to 4 min", passes: 6, timeMs: 240000 },
};

function openDialog(ctx: any): boolean {
  const KD = root.KDialogs, P = root.PcbTools; if (!KD || typeof document === "undefined") { ctx.toast("Autoroute: dialogs are unavailable here"); return true; }
  const doc = ctx.doc; const copper: string[] = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const rats = P.ratsnest(doc); const sel = selectedNets(ctx); const selSet = new Set(sel); const selCount = rats.filter((l: any) => selSet.has(l.net)).length;
  if (!rats.length) { ctx.toast("Autoroute: the board has no unrouted connections"); return true; }
  const s = settingsOf(ctx); const dflt = P.netclassOf(s, "");
  let scope: HTMLSelectElement, effort: HTMLSelectElement, vias: HTMLInputElement, rip: HTMLInputElement, zones: HTMLInputElement; const layerBoxes: [string, HTMLInputElement][] = [];
  KD.open({
    title: "Autoroute", width: 470, okLabel: "Route",
    build(body: HTMLElement) {
      scope = document.createElement("k-select"); scope.dataset.k = "scope"; scope.style.cssText = FIELD;
      scope.add(new Option(`All unrouted nets (${plural(rats.length, "connection")})`, "all"));
      if (selCount) { scope.add(new Option(`Nets of the selection (${plural(selCount, "connection")})`, "sel")); scope.value = "sel"; }
      row(body, "Route", scope);
      const lbox = document.createElement("div"); lbox.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 12px";
      for (const name of copper) {
        const on = (doc.layers.get(name) || { type: "signal" }).type !== "power"; const c = check(on, "layer:" + name); layerBoxes.push([name, c]);
        const l = document.createElement("label"); l.style.cssText = "display:inline-flex;align-items:center;gap:4px"; l.append(c, document.createTextNode(name)); lbox.appendChild(l);
      }
      row(body, "Layers", lbox);
      vias = check(copper.length > 1, "vias"); row(body, "Place vias", vias);
      rip = check(true, "rip"); row(body, "Rip up and retry", rip);
      zones = check(true, "zones"); row(body, "Connect to zones", zones);
      effort = document.createElement("k-select"); effort.dataset.k = "effort"; effort.style.cssText = FIELD;
      for (const [k, e] of Object.entries(EFFORT)) effort.add(new Option(e.label, k)); effort.value = "normal";
      row(body, "Effort", effort);
      note(body, `Track width, clearance and via size come from each net's class in Board Setup (Default: ${dflt.track_width} mm tracks, ${dflt.clearance} mm clearance, ${dflt.via_diameter}/${dflt.via_drill} mm vias). Existing tracks are kept and never moved.`);
      const n = PROVENANCE.boards.reduce((a, b) => a + b.connections, 0);
      if (n) note(body, `Rule-based line-probe router; its route scoring was fitted on ${n} hand-routed connections from ${PROVENANCE.boards.length} open hardware boards.`);
    },
    ok() {
      const layers = layerBoxes.filter(([, c]) => c.checked).map(([nm]) => nm); if (!layers.length) { ctx.toast("Autoroute: pick at least one layer"); return false; }
      const e = EFFORT[effort.value] || EFFORT.normal;
      const opts: RouteOptions = { nets: scope.value === "sel" ? sel : null, layers, allowVias: vias.checked, ripUp: rip.checked, zones: zones.checked, passes: e.passes, timeMs: e.timeMs };
      setTimeout(() => runWithProgress(ctx, opts), 0);
      return undefined;
    },
  });
  return true;
}

function runWithProgress(ctx: any, opts: RouteOptions): void {
  const KD = root.KDialogs; let bar: HTMLElement, text: HTMLElement, finished = false;
  KD.open({
    title: "Autorouting…", width: 420, okLabel: "Stop and keep",
    build(body: HTMLElement) {
      text = note(body, "Reading the board…");
      const track = document.createElement("div"); track.style.cssText = "height:8px;border:1px solid var(--line);border-radius:var(--r-3);background:var(--panel);overflow:hidden;margin:8px 0";
      bar = document.createElement("div"); bar.style.cssText = "height:100%;width:0;background:var(--blue);transition:width .1s"; track.appendChild(bar); body.appendChild(track);
      note(body, "Stop and keep lays down what is routed so far. Cancel changes nothing.");
    },
    ok() { if (running) running.router.stopped = true; return finished ? undefined : false; },
    cancel() { if (running && !finished) { running.cancelled = true; running.router.stopped = true; } },
  });
  // let the window paint before the grid is built
  setTimeout(() => {
    autoroute(ctx, opts, { progress(p) { bar.style.width = (100 * p.done / Math.max(1, p.total)).toFixed(1) + "%"; text.textContent = `Pass ${p.pass + 1}: ${p.routed} of ${plural(p.total, "connection")} routed — ${p.net}`; } })
      .then((s) => { finished = true; if (KD.close) KD.close(); ctx.toast(summaryText(s), 6000); if (!s.cancelled && s.total) report(ctx, s); })
      .catch((e) => { finished = true; if (KD.close) KD.close(); console.warn(e); ctx.toast("Autoroute failed: " + (e && e.message ? e.message : e)); });
  }, 30);
}

function report(ctx: any, s: AutorouteSummary): void {
  const KD = root.KDialogs; if (!s.failed.length && !s.zoneEnds && !s.zoneCovered && !s.dropped) return;
  KD.open({
    title: "Autoroute finished", width: 460, okLabel: "Close",
    build(body: HTMLElement) {
      note(body, `${s.routed} of ${plural(s.total, "connection")} routed with ${plural(s.segments, "track segment")} and ${plural(s.vias, "via")} (${s.length.toFixed(1)} mm) in ${(s.ms / 1000).toFixed(1)} s. Undo takes the whole run back.`);
      if (s.zoneEnds || s.zoneCovered) note(body, `${plural(s.zoneEnds + s.zoneCovered, "connection")} rely on a copper zone of their net (${s.zoneEnds} reach it through a new via). Refill the zones (Edit > Fill All Zones, B) to complete them.`);
      if (s.dropped) note(body, `The board changed while routing: ${plural(s.dropped, "route")} no longer fitted and were left out.`);
      if (s.failed.length) {
        note(body, `${plural(s.failed.length, "connection")} could not be routed within the design rules and are still shown in the ratsnest:`);
        const box = document.createElement("div"); box.style.cssText = "max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);font:12px var(--mono);padding:4px 6px";
        for (const f of s.failed) { const d = document.createElement("div"); d.textContent = `${f.net}  (${f.a[0].toFixed(2)}, ${f.a[1].toFixed(2)}) → (${f.b[0].toFixed(2)}, ${f.b[1].toFixed(2)})`; box.appendChild(d); }
        body.appendChild(box);
      }
    },
  });
}

// ---------------------------------------------------------------- live preview
function drawPreview(c: CanvasRenderingContext2D, K: any): void {
  const r = running && !running.done ? running.router : null; if (!r) return; const G = r.G;
  c.save(); c.lineCap = "round"; c.lineJoin = "round"; c.globalAlpha = 0.8;
  for (const conn of r.conns) {
    if (!conn.nodes) continue;
    for (const o of conn.shapes) {
      const sh = o.shape; const layer = G.layers[o.layers[0]];
      if (sh.t === "seg") { c.strokeStyle = (K.PCB_COLORS && K.PCB_COLORS[layer]) || "#C83434"; c.lineWidth = sh.r * 2; c.beginPath(); c.moveTo(sh.a[0], sh.a[1]); c.lineTo(sh.b[0], sh.b[1]); c.stroke(); }
      else if (sh.t === "circle") { c.fillStyle = "#ECECEC"; c.beginPath(); c.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2); c.fill(); }
    }
  }
  c.restore();
}

/** Route ▸ Autoroute…: the command behind the menu entry. */
export function open(ctx: any): boolean {
  if (!ctx || !ctx.doc) return false; if (ctx.viewOnly) { ctx.toast("View-only access"); return true; } if (running) { ctx.toast("The autorouter is already running"); return true; }
  return openDialog(ctx);
}
export function install(): void {
  const pcb = root.CollabTools && root.CollabTools.pcb; if (!pcb || pcb.autorouteInstalled) return;
  try {
    const draw = pcb.drawOverlay; pcb.autorouteInstalled = true;
    pcb.drawOverlay = function (c: CanvasRenderingContext2D, view: any, ctx: any) { if (draw) draw.call(pcb, c, view, ctx); try { drawPreview(c, (ctx && ctx.K) || root.KiCadCanvas); } catch (e) { /* a preview must never break the canvas */ } };
  } catch (e) { /* no preview, the router still works */ }
}
