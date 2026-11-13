// "Design with an AI": a real run, played back by the scroll.  An AI app connected over MCP was
// asked for an ESP32-C3 devboard; it answered with two run_python calls (the scripts in
// scripts/demo-video/design), which drew the schematic and then placed and routed the board.
// scripts/landing-ai/record.mjs ran them against a real server and kept the finished documents
// plus the order in which every item appeared (ai/timeline.json).  Here the scroll position
// decides how far the run has got: how much of the prompt is typed, which schematic items exist,
// where each footprint is on its way from the pile to its place, and which tracks are laid.
// Nothing is invented: every item drawn is one the AI made, in the order it made them.

import { Box, HIDDEN, K, Pt, Rat, View, clamp, ease, fit, lerp, mixBox, ratsnest, span } from "./demo";
import { makeStage, reducedMotion, Stage } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Timeline {
  stats: { parts: number; nets: number; ercErrors: number; routed: number; connections: number; vias: number; length: number; width: number; height: number; layers: number; drcErrors: number; unrouted: string[] };
  runs: Record<string, { seconds: number; calls: number }>;
  kicad_sch: { order: [string, number][] };
  kicad_pcb: { order: [string, number][]; from: Record<string, [number, number, number]> };
}
const PROMPT = "Design an ESP32 devboard: bare chip, USB-C, Bluetooth, battery management with a JST battery connector, an IMU and a barometer. Raspberry Pi Pico size, 4 layers.";

// Where along the section (0 to 1) each part of the run happens.
const T = {
  type: [0.02, 0.15], call0: 0.165, sch: [0.18, 0.45], out0: 0.455,
  call1: 0.49, place: [0.5, 0.66], route: [0.68, 0.9], fill: 0.915, done: 0.94,
} as const;
const TRACKS = new Set(["segment", "via", "arc"]);

export function startAi(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
  const track = root.querySelector<HTMLElement>(".ai-track")!;
  const typed = root.querySelector<HTMLElement>("[data-prompt]")!;
  const caret = root.querySelector<HTMLElement>("[data-caret]");
  const calls = Array.from(root.querySelectorAll<HTMLElement>("[data-call]"));
  const outs = Array.from(root.querySelectorAll<HTMLElement>("[data-out]"));
  const done = root.querySelector<HTMLElement>("[data-done]");
  const chat = root.querySelector<HTMLElement>(".chat-body");
  const still = reducedMotion();
  let u = 0, asked = false, ready = false, failed = false;

  let sch: KDoc | null = null, pcb: KDoc | null = null, tl: Timeline | null = null;
  // Schematic: items in the order they appeared.  Board: footprints, tracks, the rest, each in order.
  let schIds: string[] = [], schBase = new Set<string>(), schBox: Box = [0, 0, 1, 1];
  let fps: string[] = [], routes: string[] = [], others: string[] = [], zones: string[] = [];
  const home = new Map<string, Pt>(), pile = new Map<string, Pt>(), at = new Map<string, Pt>();
  let boardBox: Box = [0, 0, 1, 1], pileBox: Box = [0, 0, 1, 1];
  let planes: { net: number; layers: string[] }[] = [];
  let ratKey = "", rats: Rat[] = [];

  function load(): void {
    if (asked) return;
    asked = true;
    const get = (name: string) => fetch("/static/landing/" + name).then((r) => { if (!r.ok) throw new Error(name + " " + r.status); return r.text(); });
    Promise.all([get("ai-esp32.kicad_sch"), get("ai-esp32.kicad_pcb"), get("ai-timeline.json")]).then(([s, b, t]) => {
      tl = JSON.parse(t) as Timeline;
      sch = K.parseDoc(s); pcb = K.parseDoc(b);
      prepare(); ready = true; fill(); stage.invalidate();
    }).catch(() => { failed = true; stage.invalidate(); });
  }

  function prepare(): void {
    const s = sch!, b = pcb!, t = tl!;
    // The sheet: everything the AI drew, framed by what it drew rather than the whole paper.
    schIds = t.kicad_sch.order.filter(([id, i]) => i >= 0 && s.items.has(id)).map(([id]) => id);
    schBase = new Set(t.kicad_sch.order.filter(([, i]) => i < 0).map(([id]) => id));
    // Framed as the editor opens a sheet: the whole page, border and title block included.
    schBox = [-4, -4, s.page[0] + 4, s.page[1] + 4];

    for (const [id, i] of t.kicad_pcb.order) {
      const it = b.items.get(id); if (!it) continue;
      if (it.kind === "footprint") fps.push(id);
      else if (TRACKS.has(it.kind)) routes.push(id);
      else if (it.kind === "zone" && !isKeepout(it)) zones.push(id);
      else if (i >= 0 || it.kind === "gr_line" || it.kind === "gr_rect" || it.kind === "gr_arc") others.push(id);
    }
    for (const id of fps) {
      const it: any = b.items.get(id), a = K.atOf(it.node), f = t.kicad_pcb.from[id];
      home.set(id, [a[0], a[1]]); pile.set(id, f ? [f[0], f[1]] : [a[0], a[1]]); at.set(id, [a[0], a[1]]);
    }
    boardBox = boxOf(b, others.filter((id) => /^gr_/.test(b.items.get(id)?.kind || "")), 2);
    pileBox = boardBox.slice() as Box;
    for (const p of pile.values()) { pileBox[0] = Math.min(pileBox[0], p[0] - 3); pileBox[1] = Math.min(pileBox[1], p[1] - 3); pileBox[2] = Math.max(pileBox[2], p[0] + 3); pileBox[3] = Math.max(pileBox[3], p[1] + 3); }
    // The planes the AI poured, so that the airwires they take over go away once they are filled.
    const byNet = new Map<number, string[]>();
    for (const id of zones) { const z = b.items.get(id), g = zoneInfo(z); if (g) { const l = byNet.get(g.net) || []; l.push(...g.layers); byNet.set(g.net, l); } }
    planes = [...byNet].map(([net, layers]) => ({ net, layers }));
  }
  const isKeepout = (it: any): boolean => Array.isArray(it.node) && !!K.kid(it.node, "keepout");
  function zoneInfo(it: any): { net: number; layers: string[] } | null {
    const n = K.kid(it.node, "net"), l = K.kid(it.node, "layer"), ls = K.kid(it.node, "layers");
    const net = n ? Number(n[1]) : 0, layers = l ? [K.str(l[1])] : ls ? ls.slice(1).map((x: any) => K.str(x)) : [];
    return net ? { net, layers } : null;
  }
  function boxOf(doc: KDoc, ids: string[], pad: number): Box {
    const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of ids) { const it = doc.items.get(id); if (!it || !it.bbox) continue; b[0] = Math.min(b[0], it.bbox[0]); b[1] = Math.min(b[1], it.bbox[1]); b[2] = Math.max(b[2], it.bbox[2]); b[3] = Math.max(b[3], it.bbox[3]); }
    return isFinite(b[0]) ? [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] : [0, 0, 100, 100];
  }

  // ------------------------------------------------------------------ the conversation

  /** The tool results, worded from the run's own numbers. */
  function fill(): void {
    const s = tl!.stats;
    const lines = [
      [`${s.parts} parts and ${s.nets} nets placed in the shared schematic`, `grouped into sections: USB-C, charger, regulator, ESP32-C3, crystal, antenna, sensors, pins`, `ERC: ${s.ercErrors} errors`],
      [`${s.width} × ${s.height} mm, ${s.layers} copper layers, ground and 3.3 V planes`, `${s.parts} footprints placed`, `${s.routed} of ${s.connections} connections routed, ${s.vias} vias, ${s.length} mm of track`,
        s.unrouted.length ? `left for you: ${s.unrouted.map((x) => x.replace(/ \(blocked\)$/, "")).join("; ")}` : "nothing left unrouted"],
    ];
    outs.forEach((el, k) => { el.innerHTML = ""; for (const line of lines[k] || []) { const li = document.createElement("li"); li.textContent = line; el.appendChild(li); } });
    const secs = Object.values(tl!.runs).reduce((a, r) => a + r.seconds, 0);
    if (done) done.querySelector("p")!.textContent = `Done in about ${Math.round(secs / 60)} minutes. The board is in your project; ${s.unrouted.length ? `${s.connections - s.routed} connections need a look before you order it.` : "run the checks before you order it."}`;
  }

  function chatTo(p: number): void {
    const n = Math.round(PROMPT.length * span(p, T.type[0], T.type[1]));
    if (typed.textContent!.length !== n) typed.textContent = PROMPT.slice(0, n);
    if (caret) caret.hidden = n >= PROMPT.length;
    root.dataset.typed = n >= PROMPT.length ? "1" : "0";
    const show = [p >= T.call0, p >= T.call1];
    calls.forEach((el, k) => {
      el.classList.toggle("on", show[k]);
      const busy = k === 0 ? p < T.out0 : p < T.done;
      el.classList.toggle("busy", show[k] && busy);
      const o = outs[k]; if (o) o.classList.toggle("on", show[k] && !busy);
    });
    if (done) done.classList.toggle("on", p >= T.done);
    if (chat) chat.scrollTop = chat.scrollHeight;
    root.dataset.phase = p < T.call0 ? "ask" : p < T.call1 ? "sch" : "pcb";
  }

  // ------------------------------------------------------------------ scroll

  function readScroll(): void {
    const r = track.getBoundingClientRect();
    if (r.top < window.innerHeight * 2 && r.bottom > -window.innerHeight) load();
    const room = r.height - window.innerHeight;
    u = room > 0 ? clamp(-r.top / room) : 0;
    chatTo(u);
    stage.invalidate();
  }

  // ------------------------------------------------------------------ drawing

  const stage: Stage = makeStage(canvas, (s) => {
    const { ctx, w: W, h: H } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!ready) {
      ctx.fillStyle = "#F5F4EF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.fillStyle = "#8A8A84"; ctx.font = "13px ui-monospace, monospace"; ctx.textAlign = "center";
      ctx.fillText(failed ? "The recorded run could not be loaded." : "Loading the recorded run…", W / 2, H / 2);
      return false;
    }
    if (u < T.call1) drawSch(ctx, W, H, s.dpr);
    else drawPcb(ctx, W, H, s.dpr);
    return false;
  });

  function drawSch(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number): void {
    const doc = sch!, k = span(u, T.sch[0], T.sch[1]), n = Math.round(schIds.length * k);
    const ids = new Set<string>(schBase); for (let i = 0; i < n; i++) ids.add(schIds[i]);
    // What the AI is adding right now is shown selected, as the editor shows an AI's edit.
    const fresh = new Set<string>(); for (let i = Math.max(0, n - 12); i < n && k < 1; i++) fresh.add(schIds[i]);
    const view = fit(W, H, dpr, schBox);
    K.render(doc, ctx, view, { ids, grid: 1.27, selected: fresh.size ? fresh : null });
  }

  function drawPcb(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number): void {
    const doc = pcb!, pp = span(u, T.place[0], T.place[1]), rp = span(u, T.route[0], T.route[1]), filled = u >= T.fill;
    const ids = new Set<string>(others);
    // Placement: the footprints arrive in a pile beside the board (where syncing from the schematic
    // put them), then the placer moves each to its spot, one after another.
    const N = fps.length, moving = new Set<string>();
    fps.forEach((id, i) => {
      const arrive = (i / N) * 0.18;
      if (pp < arrive && pp < 1) return;
      ids.add(id);
      const t0 = 0.2 + (i / N) * 0.62, t = ease(span(pp, t0, t0 + 0.18));
      const a = pile.get(id)!, b = home.get(id)!, p: Pt = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
      if (t > 0 && t < 1) moving.add(id);
      const c = at.get(id)!;
      if (Math.abs(c[0] - p[0]) > 1e-4 || Math.abs(c[1] - p[1]) > 1e-4) { K.moveItem(doc, doc.items.get(id), p[0], p[1], 1e6); at.set(id, p); }
    });
    // Routing: tracks and vias in the order they were laid.
    const nR = Math.round(routes.length * rp), fresh = new Set<string>(moving);
    for (let i = 0; i < nR; i++) { ids.add(routes[i]); if (i >= nR - 6 && rp < 1) fresh.add(routes[i]); }
    // The pours are drawn once the AI has filled them, at the end of its run.
    if (filled) for (const z of zones) ids.add(z);
    const key = `${Math.round(pp * 60)}|${nR}|${filled}`;
    if (key !== ratKey) {
      ratKey = key;
      const only = new Set<string>(); for (let i = 0; i < nR; i++) only.add(routes[i]);
      rats = ratsnest(doc, { only, planes: filled ? planes : [] });
    }
    const box = mixBox(pileBox, boardBox, ease(span(pp, 0.55, 1)));
    const view = fit(W, H, dpr, box);
    K.render(doc, ctx, view, { ids, hidden: HIDDEN, grid: 1, ratsnest: pp > 0 ? rats : [], selected: fresh.size ? fresh : null, zoneFill: filled, activeLayer: "F.Cu" });
  }

  window.addEventListener("scroll", readScroll, { passive: true });
  window.addEventListener("resize", readScroll);
  readScroll();
  if (still) root.classList.add("still");
}
