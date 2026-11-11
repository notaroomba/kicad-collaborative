// preview.ts — draw a KiCad library symbol or footprint (the s-expression the server
// converts a vendor's drawing into) on a canvas, in KiCad's own colours, so a part can be
// looked at before it is placed.  This is a preview, not the editor's renderer: it knows
// the handful of shapes a converted part contains.

type N = (string | number | N)[];

function parse(text: string): N | null {
  const K = (window as unknown as { KiCadCanvas?: { parse(t: string): N | null } }).KiCadCanvas;
  if (K && K.parse) { try { return K.parse(text); } catch { /* fall through to the local reader */ } }
  // a minimal reader, for pages where the editor's canvas library is not loaded
  let i = 0;
  const read = (): N | string | number | null => {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === "(") {
      i++; const list: N = [];
      for (;;) { while (i < text.length && /\s/.test(text[i])) i++; if (i >= text.length || text[i] === ")") { i++; return list; } const v = read(); if (v !== null) list.push(v); }
    }
    if (text[i] === '"') {
      let s = ""; i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") { i++; s += text[i] === "n" ? "\n" : text[i]; } else s += text[i]; i++; }
      i++; return s;
    }
    let j = i; while (j < text.length && !/[\s()]/.test(text[j])) j++;
    const tok = text.slice(i, j); i = j;
    return /^-?\d+(\.\d+)?$/.test(tok) ? parseFloat(tok) : tok;
  };
  const v = read();
  return Array.isArray(v) ? v : null;
}

const isL = (v: unknown): v is N => Array.isArray(v);
const kid = (n: N, k: string): N | null => (n.find((c) => isL(c) && c[0] === k) as N) || null;
const kids = (n: N, k: string): N[] => n.filter((c) => isL(c) && c[0] === k) as N[];
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !isNaN(+v) ? +v : d);
const xy = (n: N | null): [number, number] => (n ? [num(n[1]), num(n[2])] : [0, 0]);

interface Box { x0: number; y0: number; x1: number; y1: number }
const grow = (b: Box, x: number, y: number) => { if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; };

/** Centre of the circle through three points, or null when they are collinear. */
function circle3(a: [number, number], b: [number, number], c: [number, number]): [number, number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  return [ux, uy, Math.hypot(a[0] - ux, a[1] - uy)];
}
/** Points along the arc from `a` through `m` to `b`. */
function arcPts(a: [number, number], m: [number, number], b: [number, number]): [number, number][] {
  const c = circle3(a, m, b); if (!c) return [a, b];
  const ang = (p: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a); let am = ang(m) - a0, a1 = ang(b) - a0;
  const TAU = Math.PI * 2; const norm = (v: number) => ((v % TAU) + TAU) % TAU;
  am = norm(am); a1 = norm(a1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) a1 = TAU;                 // a full circle drawn as an arc
  const sweep = am <= a1 ? a1 : a1 - TAU;                                   // go the way that passes through the midpoint
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  return Array.from({ length: n + 1 }, (_, k) => { const t = a0 + (sweep * k) / n; return [c[0] + c[2] * Math.cos(t), c[1] + c[2] * Math.sin(t)] as [number, number]; });
}

interface Theme { bg: string; body: string; fill: string; pin: string; pinName: string; pinNum: string; text: string }
const SCH: Theme = { bg: "#F5F4EF", body: "#840000", fill: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", text: "#006464" };
const PCB_LAYER: Record<string, string> = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Fab": "#AFAFAF", "B.Fab": "#585D84", "F.CrtYd": "#FF26E2", "F.Paste": "#B4A09A", "F.Mask": "#D864FF", "Edge.Cuts": "#D0D2CD", "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC" };

function setup(canvas: HTMLCanvasElement, bg: string, box: Box, flipY: boolean, pad = 14) {
  const dpr = window.devicePixelRatio || 1; const w = canvas.clientWidth || 260, h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const bw = Math.max(box.x1 - box.x0, 0.5), bh = Math.max(box.y1 - box.y0, 0.5);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const X = (x: number) => w / 2 + (x - cx) * s; const Y = (y: number) => h / 2 + (flipY ? -(y - cy) : y - cy) * s;
  g.lineJoin = "round"; g.lineCap = "round";
  return { g, s, X, Y, w, h };
}

function blank(canvas: HTMLCanvasElement, bg: string, fg: string, msg: string) {
  const { g, w, h } = setup(canvas, bg, { x0: 0, y0: 0, x1: 1, y1: 1 }, false);
  g.fillStyle = fg; g.font = "12px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(msg, w / 2, h / 2);
}

/** Draw unit `unit` (1-based) of a library symbol. */
export function drawSymbol(canvas: HTMLCanvasElement, sexpr: string | null | undefined, unit = 1): void {
  const root = sexpr ? parse(sexpr) : null;
  if (!root || root[0] !== "symbol") { blank(canvas, SCH.bg, "#8C8B85", "No symbol"); return; }
  const subs = kids(root, "symbol").filter((u) => { const m = /_(\d+)_(\d+)$/.exec(String(u[1])); return !m || m[1] === "0" || +m[1] === unit; });
  const hideNames = !!kid(root, "pin_names") && JSON.stringify(kid(root, "pin_names")).includes("hide");
  const hideNums = !!kid(root, "pin_numbers") && JSON.stringify(kid(root, "pin_numbers")).includes("hide");
  const box: Box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const pinEnd = (p: N): [number, number, number, number, number] => {
    const at = kid(p, "at")!; const [x, y] = xy(at); const a = num(at[3]); const len = num((kid(p, "length") || [])[1], 2.54);
    const r = (a * Math.PI) / 180; return [x, y, x + len * Math.cos(r), y + len * Math.sin(r), a];
  };
  for (const u of subs) for (const c of u) {
    if (!isL(c)) continue;
    if (c[0] === "rectangle") { grow(box, ...xy(kid(c, "start"))); grow(box, ...xy(kid(c, "end"))); }
    else if (c[0] === "circle") { const [x, y] = xy(kid(c, "center")); const r = num((kid(c, "radius") || [])[1]); grow(box, x - r, y - r); grow(box, x + r, y + r); }
    else if (c[0] === "polyline" || c[0] === "bezier") for (const p of kids(kid(c, "pts") || [], "xy")) grow(box, num(p[1]), num(p[2]));
    else if (c[0] === "arc") for (const p of arcPts(xy(kid(c, "start")), xy(kid(c, "mid")), xy(kid(c, "end")))) grow(box, p[0], p[1]);
    else if (c[0] === "pin") { const e = pinEnd(c); grow(box, e[0], e[1]); grow(box, e[2], e[3]); }
  }
  if (box.x0 > box.x1) { blank(canvas, SCH.bg, "#8C8B85", "No symbol"); return; }
  const { g, s, X, Y } = setup(canvas, SCH.bg, box, true, 18);
  const lw = Math.max(1, 0.15 * s);
  const style = (c: N) => {
    const t = String((kid(kid(c, "fill") || [], "type") || [])[1] || "none");
    g.strokeStyle = SCH.body; g.lineWidth = lw; g.fillStyle = t === "background" ? SCH.fill : t === "outline" ? SCH.body : "transparent";
    return t !== "none";
  };
  // fills first, so pins and text read on top
  for (const pass of [0, 1]) for (const u of subs) for (const c of u) {
    if (!isL(c)) continue;
    if (c[0] === "rectangle") {
      const a = xy(kid(c, "start")), b = xy(kid(c, "end")); const filled = style(c);
      const x = Math.min(X(a[0]), X(b[0])), y = Math.min(Y(a[1]), Y(b[1])), w = Math.abs(X(b[0]) - X(a[0])), h = Math.abs(Y(b[1]) - Y(a[1]));
      if (pass === 0) { if (filled) g.fillRect(x, y, w, h); } else g.strokeRect(x, y, w, h);
    } else if (c[0] === "circle") {
      const [x, y] = xy(kid(c, "center")); const r = num((kid(c, "radius") || [])[1]); const filled = style(c);
      g.beginPath(); g.arc(X(x), Y(y), Math.max(r * s, 0.5), 0, Math.PI * 2); if (pass === 0) { if (filled) g.fill(); } else g.stroke();
    } else if (c[0] === "polyline" || c[0] === "arc" || c[0] === "bezier") {
      let pts: [number, number][];
      if (c[0] === "arc") pts = arcPts(xy(kid(c, "start")), xy(kid(c, "mid")), xy(kid(c, "end")));
      else pts = kids(kid(c, "pts") || [], "xy").map((p) => [num(p[1]), num(p[2])] as [number, number]);
      if (pts.length < 2) continue; const filled = style(c);
      g.beginPath();
      if (c[0] === "bezier" && pts.length === 4) { g.moveTo(X(pts[0][0]), Y(pts[0][1])); g.bezierCurveTo(X(pts[1][0]), Y(pts[1][1]), X(pts[2][0]), Y(pts[2][1]), X(pts[3][0]), Y(pts[3][1])); }
      else pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      if (pass === 0) { if (filled && c[0] !== "arc") g.fill(); } else g.stroke();
    } else if (pass === 1 && c[0] === "text") {
      const [x, y] = xy(kid(c, "at")); g.fillStyle = SCH.text; g.font = `${Math.max(7, 1.27 * s)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(c[1]), X(x), Y(y));
    } else if (pass === 1 && c[0] === "pin") {
      const [x, y, ex, ey, a] = pinEnd(c);
      g.strokeStyle = SCH.pin; g.lineWidth = lw; g.beginPath(); g.moveTo(X(x), Y(y)); g.lineTo(X(ex), Y(ey)); g.stroke();
      const fs = Math.min(11, Math.max(0, 1.1 * s)); if (fs < 5) continue;   // too small to read: the pin lines alone give the shape
      const name = String((kid(c, "name") || [])[1] || ""), number = String((kid(c, "number") || [])[1] || "");
      const horiz = a === 0 || a === 180; const dir = a === 0 || a === 90 ? 1 : -1;
      g.font = `${fs}px sans-serif`;
      const label = (txt: string, px: number, py: number, align: CanvasTextAlign, base: CanvasTextBaseline, color: string) => {
        g.save(); g.translate(px, py); if (!horiz) g.rotate(-Math.PI / 2); g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(txt, 0, 0); g.restore();
      };
      if (!hideNames && name && name !== "~") {
        const off = 0.6 * s;
        if (horiz) label(name, X(ex) + dir * off, Y(ey), dir > 0 ? "left" : "right", "middle", SCH.pinName);
        else label(name, X(ex), Y(ey) - dir * off, dir > 0 ? "left" : "right", "middle", SCH.pinName);
      }
      if (!hideNums && number && number !== "~") {
        const mx = (X(x) + X(ex)) / 2, my = (Y(y) + Y(ey)) / 2;
        if (horiz) label(number, mx, my - 2, "center", "bottom", SCH.pinNum); else label(number, mx - 2, my, "center", "bottom", SCH.pinNum);
      }
    }
  }
}

/** Draw a footprint: copper, paste openings left out, silk, fab, courtyard, drills. */
export function drawFootprint(canvas: HTMLCanvasElement, sexpr: string | null | undefined): void {
  const BG = "#001023";
  const root = sexpr ? parse(sexpr) : null;
  if (!root || root[0] !== "footprint") { blank(canvas, BG, "#7B838D", "No footprint"); return; }
  const box: Box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const layerOf = (c: N) => String((kid(c, "layer") || [])[1] || "");
  const shapes = root.filter((c) => isL(c) && /^fp_(line|rect|circle|arc|poly)$/.test(String(c[0]))) as N[];
  const pads = kids(root, "pad");
  const ptsOf = (c: N): [number, number][] => {
    if (c[0] === "fp_line") return [xy(kid(c, "start")), xy(kid(c, "end"))];
    if (c[0] === "fp_rect") { const a = xy(kid(c, "start")), b = xy(kid(c, "end")); return [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
    if (c[0] === "fp_arc") return arcPts(xy(kid(c, "start")), xy(kid(c, "mid")), xy(kid(c, "end")));
    if (c[0] === "fp_poly") { const p = kids(kid(c, "pts") || [], "xy").map((q) => [num(q[1]), num(q[2])] as [number, number]); if (p.length) p.push(p[0]); return p; }
    const ce = xy(kid(c, "center")), e = xy(kid(c, "end")); const r = Math.hypot(e[0] - ce[0], e[1] - ce[1]);
    return Array.from({ length: 41 }, (_, k) => [ce[0] + r * Math.cos((k * Math.PI) / 20), ce[1] + r * Math.sin((k * Math.PI) / 20)] as [number, number]);
  };
  for (const c of shapes) if (layerOf(c) !== "F.Paste") for (const p of ptsOf(c)) grow(box, p[0], p[1]);
  for (const p of pads) {
    const [x, y] = xy(kid(p, "at")); const sz = kid(p, "size"); const w = num(sz ? sz[1] : 0), h = num(sz ? sz[2] : 0); const m = Math.max(w, h) / 2;
    grow(box, x - m, y - m); grow(box, x + m, y + m);
    for (const q of kids(kid(kid(kid(p, "primitives") || [], "gr_poly") || [], "pts") || [], "xy")) grow(box, x + num(q[1]), y + num(q[2]));
  }
  if (box.x0 > box.x1) { blank(canvas, BG, "#7B838D", "No footprint"); return; }
  const { g, s, X, Y } = setup(canvas, BG, box, false, 14);
  const order = ["F.Fab", "F.CrtYd", "Dwgs.User", "Cmts.User", "Edge.Cuts", "F.Mask", "F.SilkS"];
  const drawShapes = (layer: string) => {
    for (const c of shapes) {
      if (layerOf(c) !== layer) continue;
      const pts = ptsOf(c); if (pts.length < 2) continue;
      const w = num((kid(kid(c, "stroke") || [], "width") || [])[1], 0.1);
      const filled = c[0] === "fp_poly" || String((kid(c, "fill") || [])[1]) === "yes";
      g.strokeStyle = g.fillStyle = PCB_LAYER[layer] || "#888"; g.lineWidth = Math.max(1, w * s); g.globalAlpha = layer === "F.Fab" ? 0.55 : 1;
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      if (filled) g.fill(); if (!filled || w > 0) g.stroke(); g.globalAlpha = 1;
    }
  };
  for (const l of order.slice(0, 5)) drawShapes(l);
  for (const p of pads) {
    const at = kid(p, "at")!; const [x, y] = xy(at); const rot = num(at[3]); const sz = kid(p, "size"); const w = num(sz ? sz[1] : 0) * s, h = num(sz ? sz[2] : 0) * s;
    const kind = String(p[2]), shape = String(p[3]); const th = kind === "thru_hole" || kind === "np_thru_hole";
    const layers = (kid(p, "layers") || []).slice(1).map(String);
    g.save(); g.translate(X(x), Y(y)); g.rotate((-rot * Math.PI) / 180);
    g.fillStyle = kind === "np_thru_hole" ? "#1A2B40" : th ? "#C2C200" : layers.some((l) => l.startsWith("B.")) ? PCB_LAYER["B.Cu"] : PCB_LAYER["F.Cu"];
    g.beginPath();
    if (shape === "custom") {
      const pts = kids(kid(kid(kid(p, "primitives") || [], "gr_poly") || [], "pts") || [], "xy");
      pts.forEach((q, i) => (i ? g.lineTo(num(q[1]) * s, num(q[2]) * s) : g.moveTo(num(q[1]) * s, num(q[2]) * s))); g.closePath();
    } else if (shape === "circle") g.arc(0, 0, w / 2, 0, Math.PI * 2);
    else if (shape === "oval") { const r = Math.min(w, h) / 2; g.roundRect(-w / 2, -h / 2, w, h, r); }
    else if (shape === "roundrect") g.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.25);
    else g.rect(-w / 2, -h / 2, w, h);
    g.fill();
    const drill = kid(p, "drill");
    if (drill) {
      const oval = drill[1] === "oval"; const dw = num(drill[oval ? 2 : 1]) * s, dh = oval ? num(drill[3]) * s : dw;
      g.fillStyle = BG; g.beginPath(); g.roundRect(-dw / 2, -dh / 2, dw, dh, Math.min(dw, dh) / 2); g.fill();
    }
    g.restore();
    const name = String(p[1] || ""); const fs = Math.min(Math.min(w, h) * 0.6, 11);
    if (name && fs >= 6) { g.fillStyle = "#FFFFFF"; g.font = `${fs}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(name, X(x), Y(y)); }
  }
  for (const l of order.slice(5)) drawShapes(l);
}

/** The size of a footprint's courtyard (or its whole extent) in mm, for the placement outline. */
export function footprintExtent(sexpr: string): { w: number; h: number; cx: number; cy: number } {
  const root = parse(sexpr); const box: Box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  if (root) {
    for (const c of root) {
      if (!isL(c)) continue;
      if (c[0] === "fp_rect" && String((kid(c, "layer") || [])[1]) === "F.CrtYd") { grow(box, ...xy(kid(c, "start"))); grow(box, ...xy(kid(c, "end"))); }
    }
    if (box.x0 > box.x1) for (const p of kids(root, "pad")) { const [x, y] = xy(kid(p, "at")); grow(box, x - 0.5, y - 0.5); grow(box, x + 0.5, y + 0.5); }
  }
  if (box.x0 > box.x1) return { w: 2, h: 2, cx: 0, cy: 0 };
  return { w: box.x1 - box.x0, h: box.y1 - box.y0, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2 };
}
