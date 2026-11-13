// pcbdialogs/color-picker — DIALOG_COLOR_PICKER (common/dialogs/dialog_color_picker.cpp), a child window over the
// dialog that opened it.  The "Color Picker" page: the RGB box (the three colour planes of createRGBBitmap with a
// white cursor per axis to drag) with Red / Green / Blue spins, and the HSV box (the hue / saturation disc of
// createHSVBitmap, a click or drag picks) with Hue / Saturation spins and the Value slider.  The "Defined Colors"
// page: the colorRefs() table, 7 rows filled down the columns; a click takes the colour, a double-click takes it and
// closes.  Below: Preview (old/new), the hex value (#RRGGBBAA, editable), Reset to Default ("Clear Color" when the
// default is unspecified) and Cancel / OK.  The Opacity slider shows only when the caller allows it.
import { ensureCss, h, notebook, spinField } from "./ui";

export interface RGBA { r: number; g: number; b: number; a: number }
/** colorRefs(): { blue, green, red, name } in EDA_COLOR_T order (common/gal/color4d.cpp). */
const COLOR_REFS: [number, number, number, string][] = [
  [0, 0, 0, "Black"], [72, 72, 72, "Gray 1"], [132, 132, 132, "Gray 2"], [194, 194, 194, "Gray 3"], [255, 255, 255, "White"], [194, 255, 255, "L.Yellow"], [191, 229, 255, "L.Orange"],
  [72, 0, 0, "Blue 1"], [0, 72, 0, "Green 1"], [72, 72, 0, "Cyan 1"], [0, 0, 72, "Red 1"], [72, 0, 72, "Magenta 1"], [0, 72, 72, "Brown 1"], [0, 77, 128, "Orange 1"],
  [132, 0, 0, "Blue 2"], [0, 132, 0, "Green 2"], [132, 132, 0, "Cyan 2"], [0, 0, 132, "Red 2"], [132, 0, 132, "Magenta 2"], [0, 132, 132, "Brown 2"], [0, 102, 204, "Orange 2"],
  [194, 0, 0, "Blue 3"], [0, 194, 0, "Green 3"], [194, 194, 0, "Cyan 3"], [0, 0, 194, "Red 3"], [194, 0, 194, "Magenta 3"], [0, 194, 194, "Yellow 3"], [0, 133, 221, "Orange 3"],
  [255, 0, 0, "Blue 4"], [0, 255, 0, "Green 4"], [255, 255, 0, "Cyan 4"], [0, 0, 255, "Red 4"], [255, 0, 255, "Magenta 4"], [0, 255, 255, "Yellow 4"], [0, 153, 255, "Orange 4"],
];

/** COLOR4D::ToHSV( aAlwaysDefineHue = true ). */
export function toHSV(c: RGBA): [number, number, number] {
  const min = Math.min(c.r, c.g, c.b), max = Math.max(c.r, c.g, c.b), delta = max - min;
  const v = max; let s = 0, hue = 0;
  if (max > 0) s = delta / max;
  if (delta !== 0) {
    if (c.r >= max) hue = (c.g - c.b) / delta; else if (c.g >= max) hue = 2 + (c.b - c.r) / delta; else hue = 4 + (c.r - c.g) / delta;
    hue *= 60; if (hue < 0) hue += 360;
  }
  return [hue, s, v];
}
/** COLOR4D::FromHSV (alpha kept). */
export function fromHSV(hue: number, s: number, v: number, a: number): RGBA {
  if (s <= 0) return { r: v, g: v, b: v, a };
  let hh = hue; while (hh >= 360) hh -= 360; hh /= 60;
  const i = Math.floor(hh), ff = hh - i, p = v * (1 - s), q = v * (1 - s * ff), t = v * (1 - s * (1 - ff));
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i] || [v, p, q];
  return { r: rgb[0], g: rgb[1], b: rgb[2], a };
}
const b255 = (x: number): number => Math.round(x * 255);
/** COLOR4D::ToHexString */
export const toHex = (c: RGBA): string => "#" + [c.r, c.g, c.b, c.a].map((x) => b255(x).toString(16).toUpperCase().padStart(2, "0")).join("");
/** COLOR4D::SetFromHexString: #RRGGBB or #RRGGBBAA, null when it is neither. */
export function fromHex(text: string): RGBA | null {
  const t = text.trim(); if (t.length < 7 || t[0] !== "#") return null;
  const m = t.slice(1).match(/^[0-9a-fA-F]+/); if (!m) return null;
  const tmp = parseInt(m[0].slice(0, 8), 16);
  if (t.length >= 9 && m[0].length >= 8) return { r: ((tmp >>> 24) & 255) / 255, g: ((tmp >>> 16) & 255) / 255, b: ((tmp >>> 8) & 255) / 255, a: (tmp & 255) / 255 };
  const v = parseInt(m[0].slice(0, 6), 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 };
}

let lastTab = 0;   // m_ColorPicker.default_tab
/**
 * DIALOG_COLOR_PICKER( parent, aCurrentColor, aAllowOpacityControl, nullptr, aDefaultColor ): `done` gets the colour
 * when OK closes it (nothing on Cancel).  `def` null is COLOR4D::UNSPECIFIED (the Clear Color button).
 */
export function colorPicker(current: RGBA | null, allowOpacity: boolean, done: (c: RGBA) => void, def: RGBA | null = null): void {
  if (typeof KDialogs === "undefined" || !KDialogs) return;
  ensureCss();
  const prev: RGBA = current ? { ...current } : { r: 0, g: 0, b: 0, a: 0 };
  let col: RGBA = { ...prev };
  if (!allowOpacity && current) { prev.a = 1; col.a = 1; }
  let [hue, sat, val] = toHSV(col);
  if (!current) val = 1;   // UNSPECIFIED: start with the value slider up
  const SIZE = 264, CURSOR = 8;
  let bg = "#ffffff";
  const rgbCanvas = h("canvas", { "data-k": "rgbBitmap", style: `width:${SIZE}px;height:${SIZE}px;display:block;margin:5px auto;cursor:default` }) as HTMLCanvasElement;
  const hsvCanvas = h("canvas", { "data-k": "hsvBitmap", style: `width:${SIZE}px;height:${SIZE}px;display:block;margin:5px auto;cursor:default` }) as HTMLCanvasElement;
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  for (const c of [rgbCanvas, hsvCanvas]) { c.width = Math.round(SIZE * dpr); c.height = Math.round(SIZE * dpr); }
  let rgbBase: ImageData | null = null, hsvBase: ImageData | null = null;
  const parseBg = (): [number, number, number] => { const m = bg.match(/\d+(\.\d+)?/g); return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [255, 255, 255]; };
  const half = (): number => Math.floor(SIZE * dpr / 2) - Math.floor(CURSOR * dpr / 2);
  const slope = (): number => (SIZE * dpr / 5.28) / half();
  /** createRGBBitmap: the red / blue, red / green and blue / green planes of the colour cube. */
  const makeRGB = (ctx: CanvasRenderingContext2D): ImageData => {
    const W = rgbCanvas.width, img = ctx.createImageData(W, W), [br, bgc, bb] = parseBg(), hs = half(), inc = 255 / hs, sl = slope();
    for (let i = 0; i < W * W; i++) { img.data[i * 4] = br; img.data[i * 4 + 1] = bgc; img.data[i * 4 + 2] = bb; img.data[i * 4 + 3] = 255; }
    const put = (x: number, y: number, r: number, g: number, b: number): void => { const px = Math.trunc(W / 2 + x), py = Math.trunc(W / 2 - y); if (px < 0 || py < 0 || px >= W || py >= W) return; const o = (py * W + px) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; };
    for (let xx = 0; xx < hs; xx++) for (let yy = 0; yy < hs; yy++) put(xx, yy - sl * xx, inc * yy, 0, inc * xx);
    for (let xx = 0; xx < hs; xx++) for (let yy = 0; yy < hs; yy++) put(-xx, yy - sl * xx, inc * yy, inc * xx, 0);
    for (let xx = 0; xx < hs; xx++) for (let yy = 0; yy < hs; yy++) { const dx = -xx + yy, dy = -Math.trunc(Math.min(xx, yy) * 0.9); put(dx, dy - Math.abs(Math.trunc(sl * dx)), 0, inc * xx, inc * yy); }
    return img;
  };
  /** createHSVBitmap: hue round the disc, saturation out from the centre, value 1. */
  const makeHSV = (ctx: CanvasRenderingContext2D): ImageData => {
    const W = hsvCanvas.width, img = ctx.createImageData(W, W), [br, bgc, bb] = parseBg(), hs = half(), sq = hs * hs;
    for (let i = 0; i < W * W; i++) { img.data[i * 4] = br; img.data[i * 4 + 1] = bgc; img.data[i * 4 + 2] = bb; img.data[i * 4 + 3] = 255; }
    for (let xx = -hs; xx < hs; xx++) for (let yy = -hs; yy < hs; yy++) {
      let s = (xx * xx + yy * yy) / sq; if (s > 1) continue; s = Math.sqrt(s);
      let hh = Math.atan2(yy, xx) * 180 / Math.PI; if (hh < 0) hh += 360;
      const c = fromHSV(hh, s, 1, 1), px = Math.trunc(W / 2 + xx), py = Math.trunc(W / 2 - yy), o = (py * W + px) * 4;
      img.data[o] = c.r * 255; img.data[o + 1] = c.g * 255; img.data[o + 2] = c.b * 255;
    }
    return img;
  };
  // cursor positions (bitmap pixels, origin at the centre, y up), as drawRGBPalette leaves them
  let curR = [0, 0], curG = [0, 0], curB = [0, 0];
  const drawRGB = (): void => {
    const ctx = rgbCanvas.getContext("2d"); if (!ctx) return;
    if (!rgbBase) rgbBase = makeRGB(ctx);
    ctx.putImageData(rgbBase, 0, 0);
    const W = rgbCanvas.width, c = W / 2, hs = half(), sl = slope(), cs = CURSOR * dpr;
    ctx.save(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 * dpr;
    curR = [0, col.r * hs]; curB = [col.b * hs, -sl * col.b * hs]; curG = [-col.g * hs, -sl * col.g * hs];
    for (const [x, y] of [curR, curB, curG]) ctx.strokeRect(c + x - cs / 2, c - y - cs / 2, cs, cs);
    const ax = hs + hs / 5;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c, c - ax); ctx.moveTo(c, c); ctx.lineTo(c + ax, c + ax * sl); ctx.moveTo(c, c); ctx.lineTo(c - ax, c + ax * sl); ctx.stroke();
    ctx.restore();
  };
  const drawHSV = (): void => {
    const ctx = hsvCanvas.getContext("2d"); if (!ctx) return;
    if (!hsvBase) hsvBase = makeHSV(ctx);
    ctx.putImageData(hsvBase, 0, 0);
    const W = hsvCanvas.width, c = W / 2, hs = half(), cs = CURSOR * dpr;
    const x = Math.cos(hue * Math.PI / 180) * hs * sat, y = Math.sin(hue * Math.PI / 180) * hs * sat;
    ctx.save(); ctx.strokeStyle = "#000000"; ctx.lineWidth = 2 * dpr; ctx.strokeRect(c + x - cs / 2, c - y - cs / 2, cs, cs); ctx.restore();
  };
  /** COLOR_SWATCH::MakeBitmap: the colour over a checkerboard where it is translucent. */
  const swatchStyle = (c: RGBA): string => `background:linear-gradient(rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${c.a}),rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${c.a})),repeating-conic-gradient(#c0c0c0 0 25%, #ffffff 0 50%) 0 0 / 8px 8px`;
  const oldRect = h("span", { "data-k": "oldColor", style: `display:inline-block;width:20px;height:20px;border:1px solid var(--line);${swatchStyle(prev)}` });
  const newRect = h("span", { "data-k": "newColor", style: `display:inline-block;width:20px;height:20px;border:1px solid var(--line);${swatchStyle(col)}` });
  const paintNew = (): void => { newRect.setAttribute("style", `display:inline-block;width:20px;height:20px;border:1px solid var(--line);${swatchStyle(col)}`); };
  const hex = h("input", { type: "text", "data-k": "colorValue", style: "width:190px;font-family:var(--mono)" }) as HTMLInputElement;
  type Changed = "init" | "r" | "g" | "b" | "hue" | "sat" | "val" | "hex" | "alpha" | "all";
  const red = spinField(b255(col.r), { min: 0, max: 255, key: "red", onChange: (v) => { col.r = v / 255; setEdit("r", true); drawAll(); } });
  const green = spinField(b255(col.g), { min: 0, max: 255, key: "green", onChange: (v) => { col.g = v / 255; setEdit("g", true); drawAll(); } });
  const blue = spinField(b255(col.b), { min: 0, max: 255, key: "blue", onChange: (v) => { col.b = v / 255; setEdit("b", true); drawAll(); } });
  const hueSpin = spinField(Math.trunc(hue), { min: 0, max: 359, wrap: true, key: "hue", onChange: (v) => { hue = v; col = fromHSV(hue, sat, val, col.a); setEdit("hue", true); drawAll(); } });
  const satSpin = spinField(Math.trunc(sat * 255), { min: 0, max: 255, key: "saturation", onChange: (v) => { sat = v / 255; col = fromHSV(hue, sat, val, col.a); setEdit("sat", true); drawAll(); } });
  /** wxSlider( wxSL_INVERSE | wxSL_LABELS | wxSL_VERTICAL ): max at the top, the value beside the thumb. */
  const vslider = (key: string, max: number, init: number, onChange: (v: number) => void): { el: HTMLElement; set(v: number): void } => {
    const track = h("div", { "data-k": key, tabindex: "0", style: "position:relative;width:6px;flex:1 1 auto;min-height:150px;margin:0 22px 0 8px;border-radius:3px;background:var(--line);cursor:default" });
    const thumb = h("div", { style: "position:absolute;left:-5px;width:16px;height:10px;border-radius:2px;background:var(--panel);border:1px solid var(--line-2);box-sizing:border-box" });
    const label = h("div", { style: "position:absolute;left:16px;font-size:11px;color:var(--ink-2);white-space:nowrap;transform:translateY(-50%)" });
    track.append(thumb, label);
    let cur = init;
    const place = (): void => { const f = 1 - cur / max; thumb.style.top = `calc(${f * 100}% - 5px)`; label.style.top = `${f * 100}%`; label.textContent = String(cur); };
    const fromY = (y: number): void => { const r = track.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (y - r.top) / Math.max(1, r.height))); const v = Math.round((1 - f) * max); if (v !== cur) { cur = v; place(); onChange(v); } };
    track.addEventListener("pointerdown", (ev) => { track.setPointerCapture(ev.pointerId); fromY(ev.clientY); track.focus(); });
    track.addEventListener("pointermove", (ev) => { if (track.hasPointerCapture(ev.pointerId)) fromY(ev.clientY); });
    track.addEventListener("keydown", (ev) => { const d = ev.key === "ArrowUp" || ev.key === "ArrowRight" ? 1 : ev.key === "ArrowDown" || ev.key === "ArrowLeft" ? -1 : ev.key === "PageUp" ? 10 : ev.key === "PageDown" ? -10 : 0; if (!d) return; ev.preventDefault(); const v = Math.min(max, Math.max(0, cur + d)); if (v !== cur) { cur = v; place(); onChange(v); } });
    place();
    const el = h("div", { style: "display:flex;flex-direction:column;align-items:flex-start;height:100%" },
      h("div", { style: "font-size:11px;color:var(--ink-2);margin:0 0 4px 4px" }, String(max)), track, h("div", { style: "font-size:11px;color:var(--ink-2);margin:4px 0 0 4px" }, "0"));
    return { el, set(v) { cur = v; place(); } };
  };
  const value = vslider("value", 255, b255(val), (v) => { val = v / 255; col = fromHSV(hue, sat, val, col.a); setEdit("val", true); drawAll(); });
  const alpha = vslider("opacity", 100, Math.round(col.a * 100), (v) => { col.a = v / 100; paintNew(); setEdit("alpha", false); });
  /** SetEditVals */
  const setEdit = (changed: Changed, checkTransparency: boolean): void => {
    if (checkTransparency && col.a === 0) col.a = 1;
    alpha.set(Math.round(col.a * 100));
    if (changed === "r" || changed === "g" || changed === "b") [hue, sat, val] = toHSV(col);
    if (changed !== "r") red.set(b255(col.r));
    if (changed !== "g") green.set(b255(col.g));
    if (changed !== "b") blue.set(b255(col.b));
    if (changed !== "hue") hueSpin.set(Math.trunc(hue));
    if (changed !== "sat") satSpin.set(Math.trunc(sat * 255));
    if (changed !== "val") value.set(b255(val));
    if (changed !== "hex") hex.value = toHex(col);
  };
  const drawAll = (): void => { paintNew(); drawHSV(); drawRGB(); };
  hex.addEventListener("input", () => { const c = fromHex(hex.value); if (c) { col = c; [hue, sat, val] = toHSV(col); } setEdit("hex", false); drawAll(); });
  // the RGB box: a press on a cursor picks it, a drag along its axis sets that channel (onRGBMouseClick / Drag)
  let picked: "r" | "g" | "b" | null = null;
  const local = (cv: HTMLCanvasElement, ev: PointerEvent): [number, number] => { const r = cv.getBoundingClientRect(); const x = (ev.clientX - r.left) * dpr - cv.width / 2, y = -((ev.clientY - r.top) * dpr - cv.height / 2); return [x, y]; };
  rgbCanvas.addEventListener("pointerdown", (ev) => {
    const [x, y] = local(rgbCanvas, ev), cs = CURSOR * dpr / 2;
    picked = Math.abs(curR[0] - x) <= cs && Math.abs(curR[1] - y) <= cs ? "r" : Math.abs(curG[0] - x) <= cs && Math.abs(curG[1] - y) <= cs ? "g" : Math.abs(curB[0] - x) <= cs && Math.abs(curB[1] - y) <= cs ? "b" : null;
    if (picked) rgbCanvas.setPointerCapture(ev.pointerId);
  });
  rgbCanvas.addEventListener("pointermove", (ev) => {
    if (!picked || !(ev.buttons & 1)) return;
    const [x, y] = local(rgbCanvas, ev), hs = half();
    if (picked === "r") { if (y < 0 || y > hs) return; col.r = y / hs; }
    if (picked === "g") { if (-x < 0 || -x > hs) return; col.g = -x / hs; }
    if (picked === "b") { if (x < 0 || x > hs) return; col.b = x / hs; }
    [hue, sat, val] = toHSV(col); setEdit("all", true); drawAll();
  });
  rgbCanvas.addEventListener("pointerup", () => { picked = null; });
  /** setHSvaluesFromCursor */
  const hsvAt = (ev: PointerEvent): void => {
    const [x, y] = local(hsvCanvas, ev), full = Math.floor(hsvCanvas.width / 2), d = Math.hypot(x, y);
    if (d > full) return;
    sat = Math.min(1, d / half()); hue = Math.atan2(y, x) / Math.PI * 180; if (hue < 0) hue += 360;
    col = fromHSV(hue, sat, val, col.a); setEdit("all", true); drawAll();
  };
  hsvCanvas.addEventListener("pointerdown", (ev) => { hsvCanvas.setPointerCapture(ev.pointerId); hsvAt(ev); });
  hsvCanvas.addEventListener("pointermove", (ev) => { if (ev.buttons & 1) hsvAt(ev); });

  let api: { close(): void } | null = null;
  const take = (c: [number, number, number, string]): void => { col = { r: c[2] / 255, g: c[1] / 255, b: c[0] / 255, a: 1 }; [hue, sat, val] = toHSV(col); setEdit("all", false); drawAll(); };
  const box = (title: string, ...children: HTMLElement[]): HTMLElement => h("fieldset", { style: "border:1px solid var(--line);border-radius:var(--r-2);margin:0;padding:4px 8px 8px;min-width:0;flex:1 1 0" }, h("legend", { style: "padding:0 4px;color:var(--ink)" }, title), ...children);
  const spinGrid = (labels: string[], spins: HTMLElement[]): HTMLElement => {
    const g = h("div", { style: `display:grid;grid-template-columns:repeat(${labels.length}, minmax(0, 1fr));gap:2px 8px;margin-top:6px` });
    for (const l of labels) g.append(h("label", null, l));
    for (const s of spins) { (s as HTMLElement).style.width = "100%"; g.append(s); }
    return g;
  };
  KDialogs.open({ title: "Color Picker", child: true, width: allowOpacity ? 720 : 660,
    build(body: HTMLElement, a: { close(): void }) {
      api = a;
      bg = getComputedStyle(body).backgroundColor || bg;
      if (/rgba\(\s*0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) { const d = body.closest(".kd-dialog") as HTMLElement | null; bg = d ? getComputedStyle(d).backgroundColor : "#ffffff"; }
      const nb = notebook([
        { label: "Color Picker", build(p) {
          p.append(h("div", { style: "display:flex;gap:10px;padding-top:6px" },
            box("RGB", rgbCanvas, spinGrid(["Red:", "Green:", "Blue:"], [red.el, green.el, blue.el])),
            box("HSV", h("div", { style: "display:flex;gap:4px" }, h("div", { style: "flex:1 1 auto;min-width:0" }, hsvCanvas, spinGrid(["Hue:", "Saturation:"], [hueSpin.el, satSpin.el])),
              h("div", { style: "display:flex;flex-direction:column;align-items:center" }, h("label", { style: "margin:4px 0" }, "Value:"), value.el)))));
        } },
        { label: "Defined Colors", build(p) {
          // m_fgridColor: 10 columns (swatch, name) × 5, filled row by row from colorRefs() read down 7-row columns
          const g = h("div", { "data-k": "definedColors", style: "display:grid;grid-template-columns:repeat(5, max-content minmax(0, 1fr));gap:25px 5px;padding:10px;align-items:center" });
          const rows = 7;
          for (let row = 0; row < rows; row++) for (let colI = 0; colI < 5; colI++) {
            const c = COLOR_REFS[row + colI * rows]; if (!c) continue;
            const sw = h("span", { "data-color": c[3], style: `display:inline-block;width:24px;height:16px;border:1px solid var(--line);cursor:pointer;background:rgb(${c[2]},${c[1]},${c[0]})` });
            sw.addEventListener("mousedown", () => take(c));
            sw.addEventListener("dblclick", () => { take(c); finish(); });
            g.append(sw, h("span", { style: "margin-right:15px;white-space:nowrap" }, c[3]));
          }
          p.append(g);
        } },
      ], { start: lastTab, onShow: (i) => { lastTab = i; } });
      const upper = h("div", { style: "display:flex;gap:10px;align-items:stretch" }, h("div", { style: "flex:1 1 auto;min-width:0" }, nb.el));
      if (allowOpacity) upper.append(h("div", { style: "display:flex;flex-direction:column;align-items:center;padding-top:25px" }, h("label", { style: "margin-bottom:6px" }, "Opacity:"), alpha.el));
      const reset = h("button", { type: "button", class: "btn", "data-k": "resetColor" }, def ? "Reset to Default" : "Clear Color");
      reset.addEventListener("click", () => { col = def ? { ...def } : { r: 0, g: 0, b: 0, a: 0 }; [hue, sat, val] = toHSV(col); setEdit("all", false); drawAll(); });
      body.append(upper, h("div", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" }, h("span", null, "Preview (old/new):"), oldRect, newRect, hex, h("span", { style: "width:20px" }), reset));
      setEdit("init", false); hex.value = toHex(col); drawAll();
    },
    ok: () => { done({ ...col }); return true; } });
  const finish = (): void => { const dlg = rgbCanvas.closest(".kd-dialog") || hsvCanvas.closest(".kd-dialog"); const ok = dlg ? dlg.querySelector<HTMLButtonElement>(".kd-foot .btn.primary") : null; if (ok) ok.click(); else if (api) { done({ ...col }); api.close(); } };
}
