// pcbdialogs/refimage — Reference Image Properties (DIALOG_REFERENCE_IMAGE_PROPERTIES) for a board image.
// The layout follows dialog_reference_image_properties_base: Position X / Y, Rotation, Width / Height (both tied to the
// image scale), Opacity (a 0..1 spin, step 0.1), Associated layer and Locked, beside PANEL_IMAGE_EDITOR (the preview,
// Scale, PPI and the Convert to Greyscale / Invert Colors / Remove Background buttons).  OK runs
// PANEL_IMAGE_EDITOR::CheckValues (a negative scale, an image under 15 or over 6000 pixels at 300 PPI) and writes the
// item as PCB_IO_KICAD_SEXPR::format( PCB_REFERENCE_IMAGE ) does: (at) (layer) (rotate) (scale) (opacity) (locked)
// (data) (uuid), the optional ones only off their defaults.  An edited bitmap is written back as PNG (a JPEG as JPEG),
// as BITMAP_BASE::SaveImageData does once m_imageData is cleared.
import { checkField, errorMessage, form, h, coordField, lenField, messageBox, numField, openDialog, selectField, unitLabel, type Field } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const r6 = (v: number): number => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };
const MIN_SIZE = 15, MAX_SIZE = 6000;   // PANEL_IMAGE_EDITOR::CheckValues, pixels after scaling (at 300 PPI)
const DEFAULT_PPI = 300;

const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers ? doc.layers.get(name) : null; return l && l.userName ? l.userName : name; };
const layerOptions = (doc: KDoc, cur: string): [string, string][] => {
  const all = Array.from(doc.layers ? doc.layers.keys() : []).map((n): [string, string] => [n, layerLabel(doc, n)]);
  return cur && !all.some((o) => o[0] === cur) ? [[cur, cur], ...all] : all;
};

/** What the dialog shows (mm, degrees); pxW / pxH / ppi describe the bitmap itself. */
export interface RefImageValues {
  x: number; y: number; rotation: number; opacity: number; layer: string; locked: boolean; scale: number;
  pxW: number; pxH: number; ppi: number; data: string; type: string;
}

const dataOf = (node: SNode): string => { const d = kid(node, "data"); return d ? d.slice(1).map((s) => String(s)).join("") : ""; };

/** TransferDataToWindow.  `info` is the decoded bitmap's pixel size and resolution. */
export function refImageValues(node: SNode, info?: { w?: number; h?: number; ppi?: number; mime?: string } | null): RefImageValues {
  const at = kid(node, "at"), lk = kid(node, "locked");
  let scale = nval(kid(node, "scale"), 1, 1); if (!(scale > 0)) scale = 1;
  let opacity = nval(kid(node, "opacity"), 1, 1); opacity = Math.min(1, Math.max(0, opacity));
  return { x: nval(at), y: nval(at, 2), rotation: nval(kid(node, "rotate")), opacity, layer: String((kid(node, "layer") || [])[1] || "Dwgs.User"),
    locked: !!lk && String(lk[1]) !== "no", scale, pxW: (info && info.w) || 0, pxH: (info && info.h) || 0, ppi: (info && info.ppi) || DEFAULT_PPI,
    data: dataOf(node), type: info && info.mime === "image/jpeg" ? "jpeg" : "png" };
}

/** BITMAP_BASE::GetSize in mm: KiROUND( pixels * m_pixelSizeIu * scale ) nanometres, m_pixelSizeIu = 25.4 mm / ppi. */
export function refImageSize(v: { pxW: number; pxH: number; ppi: number }, scale: number): [number, number] {
  const iu = 25.4e6 / (v.ppi || DEFAULT_PPI) * scale;
  return [Math.round(v.pxW * iu) / 1e6, Math.round(v.pxH * iu) / 1e6];
}

/** PANEL_IMAGE_EDITOR::CheckValues: an error to show, a question to confirm, or nothing. */
export function checkImageScale(v: { pxW: number; pxH: number }, scale: number): { error?: string; confirm?: string } {
  if (scale < 0) return { error: "Scale must be a positive number." };
  const sizeMin = Math.trunc(Math.min(v.pxW * scale, v.pxH * scale));
  if (sizeMin < MIN_SIZE) return { error: `This scale results in an image which is too small (${(25.4 / 300 * sizeMin).toFixed(2)} mm or ${(1000 / 300 * sizeMin).toFixed(1)} mil).` };
  const sizeMax = Math.trunc(Math.max(v.pxW * scale, v.pxH * scale));
  if (sizeMax > MAX_SIZE) return { confirm: `This scale results in an image which is very large (${(25.4 / 300 * sizeMax).toFixed(1)} mm or ${(sizeMax / 300).toFixed(2)} in). Are you sure?` };
  return {};
}

/** TransferDataFromWindow on a copy of the node, in the writer's order. */
export function applyRefImage(orig: SNode, v: RefImageValues, sch = false): SNode {
  const node = (K().cloneNode as (n: SNode) => SNode)(orig);
  const drop = (key: string): void => { for (let j = node.length - 1; j > 0; j--) { const c = node[j]; if (isList(c) && c[0] === key) node.splice(j, 1); } };
  // SCH_IO_KICAD_SEXPR::saveBitmap: (at) (rotate) (scale) (opacity), then the uuid, (locked) and the data, which stay put
  for (const key of sch ? ["at", "rotate", "scale", "opacity"] : ["at", "layer", "rotate", "scale", "opacity", "locked"]) drop(key);
  const r4 = (x: number): number => { const y = +(+x).toFixed(4); return y === 0 ? 0 : y; };
  const head: SNode[] = sch ? [["at", r4(v.x), r4(v.y)]] : [["at", r6(v.x), r6(v.y)], ["layer", v.layer]];
  if (r6(v.rotation) !== 0) head.push(["rotate", r6(v.rotation)]);
  if (v.scale !== 1) head.push(["scale", +v.scale.toPrecision(6)]);
  const op = Math.min(1, Math.max(0, v.opacity));
  if (op < 1) head.push(["opacity", +op.toPrecision(6)]);
  if (v.locked && !sch) head.push(["locked", "yes"]);
  node.splice(1, 0, ...head);
  if (v.data !== dataOf(orig)) {
    const rows: string[] = []; for (let i = 0; i < v.data.length; i += 76) rows.push('"' + v.data.slice(i, i + 76) + '"');   // KICAD_FORMAT::FormatStreamData
    const d = K().parse("(data " + rows.join(" ") + ")") as SNode;
    const j = node.findIndex((c, i) => i > 0 && isList(c) && c[0] === "data");
    if (j > 0) node[j] = d; else { const u = node.findIndex((c, i) => i > 0 && isList(c) && c[0] === "uuid"); node.splice(u > 0 ? u : node.length, 0, d); }
  }
  return node;
}

// ---------------------------------------------------------------- PANEL_IMAGE_EDITOR's pixel operations (RGBA)
/** wxImage::ConvertToGreyscale( 0.299, 0.587, 0.114 ): the alpha stays. */
export function greyscalePixels(px: Uint8ClampedArray | number[]): void {
  for (let i = 0; i < px.length; i += 4) { const y = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114); px[i] = px[i + 1] = px[i + 2] = y; }
}
/** BITMAP_BASE::invertImageInPlace: 255 - each colour channel. */
export function invertPixels(px: Uint8ClampedArray | number[]): void {
  for (let i = 0; i < px.length; i += 4) { px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2]; }
}
/** ConvertColourToAlphaInPlace (GIMP's colour-to-alpha, thresholds 0 and 1). */
export function colourToAlpha(px: Uint8ClampedArray | number[], bg: [number, number, number]): void {
  const EPS = 0.00001, tT = 0 + EPS, oT = 1 - EPS, b = bg.map((c) => c / 255);
  for (let p = 0; p < px.length; p += 4) {
    const s = [px[p] / 255, px[p + 1] / 255, px[p + 2] / 255], sa = px[p + 3] / 255;
    let outA = 0, dist = 0;
    for (let i = 0; i < 3; i++) {
      const cd = Math.abs(s[i] - b[i]); let a: number;
      if (cd < tT) a = 0; else if (cd > oT) a = 1;
      else if (s[i] < b[i]) a = (cd - tT) / (Math.min(oT, b[i]) - tT);
      else a = (cd - tT) / (Math.min(oT, 1 - b[i]) - tT);
      if (a > outA) { outA = a; dist = cd; }
    }
    if (outA > EPS) {
      const ratio = tT / dist, inv = 1 / outA;
      for (let i = 0; i < 3; i++) { const c = b[i] + (s[i] - b[i]) * ratio; px[p + i] = Math.min(255, Math.max(0, Math.round((c + (s[i] - c) * inv) * 255))); }
    }
    px[p + 3] = Math.min(255, Math.max(0, Math.round(sa * outA * 255)));
  }
}

// PNG chunk CRC, to carry the bitmap's resolution (pHYs) into a re-encoded PNG as wxImage::SaveFile does.
let CRC: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
/** A PNG with its pHYs chunk (pixels per metre) set to ppi, right after IHDR. */
export function pngWithPpi(png: Uint8Array, ppi: number): Uint8Array {
  const ppm = Math.round(ppi / 0.0254);
  const chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // drop an existing pHYs, then insert after IHDR (8-byte signature + 25-byte IHDR)
  const parts: Uint8Array[] = [png.subarray(0, 33), chunk];
  for (let i = 33; i + 8 <= png.length;) {
    const len = new DataView(png.buffer, png.byteOffset + i, 4).getUint32(0), end = i + 12 + len;
    const tag = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]);
    if (tag !== "pHYs") parts.push(png.subarray(i, end));
    i = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const b64ToBytes = (s: string): Uint8Array => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const bytesToB64 = (b: Uint8Array): string => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000))); return btoa(s); };

interface ImageEntry { w?: number; h?: number; ppi?: number; mime?: string; img?: HTMLImageElement | null; loaded?: boolean }

/** DIALOG_REFERENCE_IMAGE_PROPERTIES (PCB_BASE_EDIT_FRAME::ShowReferenceImagePropertiesDialog). */
/**
 * With sch, eeschema's DIALOG_IMAGE_PROPERTIES (dialog_image_properties_base): Position X / Y, Rotation and Opacity over
 * the same PANEL_IMAGE_EDITOR, committed as "Image Properties".
 */
export function refImageDialog(ctx: ToolCtx, item: KItem, sch = false): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, ro = !!ctx.viewOnly;
  const g = (item.geom || []).find((x) => (x as { t?: string }).t === "image") as { entry?: ImageEntry } | undefined;
  const entry = (g && g.entry) || null;
  const v0 = refImageValues(node0, entry);
  const fields: Record<string, Field<string | number | boolean>> = {};
  const reg = <T extends string | number | boolean>(k: string, f: Field<T>): Field<T> => { fields[k] = f as unknown as Field<string | number | boolean>; return f; };
  // the working image (PANEL_IMAGE_EDITOR::m_workingImage): pixels on a canvas once the bitmap has decoded
  let work: HTMLCanvasElement | null = null, edited = false, scale = v0.scale, opacityIn: HTMLInputElement | null = null, preview: HTMLCanvasElement | null = null;
  const drawPreview = (): void => {
    if (!preview || !work) return;
    const c = preview.getContext("2d"); if (!c) return;
    c.clearRect(0, 0, preview.width, preview.height);
    const k = Math.min(preview.width / work.width, preview.height / work.height);
    c.drawImage(work, (preview.width - work.width * k) / 2, (preview.height - work.height * k) / 2, work.width * k, work.height * k);
  };
  const edit = (fn: (px: Uint8ClampedArray) => void): void => {
    if (!work) return; const c = work.getContext("2d"); if (!c) return;
    const im = c.getImageData(0, 0, work.width, work.height); fn(im.data); c.putImageData(im, 0, 0); edited = true; drawPreview();
  };
  const current = (): RefImageValues => {
    const gv = (k: string): unknown => fields[k].get();
    let data = v0.data;
    if (edited && work) {   // BITMAP_BASE::SaveImageData: a JPEG stays a JPEG, everything else is written as PNG
      const url = work.toDataURL(v0.type === "jpeg" ? "image/jpeg" : "image/png"); let b64 = url.slice(url.indexOf(",") + 1);
      if (v0.type !== "jpeg") b64 = bytesToB64(pngWithPpi(b64ToBytes(b64), v0.ppi));
      data = b64;
    }
    return { ...v0, x: Number(gv("x")), y: Number(gv("y")), rotation: Number(gv("rotation")), opacity: opacityIn ? Math.min(1, Math.max(0, Number(opacityIn.value) || 0)) : v0.opacity,
      layer: String(gv("layer")), locked: !!gv("locked"), scale: Number(gv("scale")), data };   // TransferToImage reads the Scale text
  };
  let api: { close(): void } | null = null;
  api = openDialog({ title: sch ? "Image Properties" : "Reference Image Properties", width: sch ? 600 : 680, readOnly: ro,
    build(body) {
      const x = reg("x", coordField(v0.x, "x", { ro, key: "x" })), y = reg("y", coordField(v0.y, "y", { ro, key: "y" }));
      const rot = reg("rotation", numField(v0.rotation, { ro, key: "rotation", digits: 3 }));
      const [w0, h0] = refImageSize(v0, v0.scale);
      const wd = reg("width", lenField(w0, { ro, key: "width" })), ht = reg("height", lenField(h0, { ro, key: "height" }));
      const sc = reg("scale", numField(v0.scale, { ro, key: "scale", digits: 6 }));
      opacityIn = h("input", { type: "number", min: "0", max: "1", step: "0.1", value: v0.opacity.toFixed(1), "data-k": "opacity", disabled: ro, style: "width:100%" });
      const layer = reg("layer", selectField<string>(v0.layer, layerOptions(doc, v0.layer), { ro, key: "layer" }));
      const locked = reg("locked", checkField(v0.locked, "Locked", { ro, key: "locked", tip: "Locked items cannot be freely moved and oriented on the canvas and can only be selected when the 'Locked items' checkbox is checked in the selection filter." }));
      // onWidthChanged / onHeightChanged / onScaleChanged: the three stay tied together
      const onSize = (axis: 0 | 1): void => {
        const nv = Number((axis ? ht : wd).get()); if (!(nv > 0)) return;
        const size = refImageSize(v0, scale)[axis]; if (!(size > 0)) return;
        scale = scale * nv / size; sc.set(+scale.toPrecision(6));
        const ns = refImageSize(v0, scale); (axis ? wd : ht).set(ns[axis ? 0 : 1]);
      };
      wd.input.addEventListener("input", () => onSize(0)); ht.input.addEventListener("input", () => onSize(1));
      sc.input.addEventListener("input", () => { const s = Number(sc.get()); if (!(s > 0)) return; scale = s; const ns = refImageSize(v0, s); wd.set(ns[0]); ht.set(ns[1]); });
      preview = h("canvas", { width: 220, height: 160, "data-k": "preview", style: "width:220px;height:160px;border:1px solid var(--line);background:var(--bench);display:block" });
      const img = entry && entry.loaded ? entry.img : null;
      if (img && typeof document !== "undefined") {
        work = document.createElement("canvas"); work.width = img.naturalWidth; work.height = img.naturalHeight;
        const c = work.getContext("2d"); if (c) c.drawImage(img, 0, 0); else work = null;
        drawPreview();
      }
      const btn = (label: string, key: string, fn: () => void): HTMLButtonElement => { const b = h("button", { type: "button", "data-k": key, disabled: ro || !work }, label); b.addEventListener("click", fn); return b; };
      // OnRemoveBackground: DIALOG_COLOR_PICKER, white by default (most images are crops from documents)
      const bgPick = h("input", { type: "color", value: "#ffffff", "data-k": "bgColor", style: "display:none" });
      bgPick.addEventListener("change", () => { const hex = bgPick.value; edit((px) => colourToAlpha(px, [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)])); });
      const edForm = form([["Scale:", sc.el], ["PPI:", h("span", { "data-k": "ppi" }, String(v0.ppi))]], true);
      const edBtns = h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:6px" },
        btn("Convert to Greyscale", "grey", () => edit(greyscalePixels)), btn("Invert Colors", "invert", () => edit(invertPixels)),
        btn("Remove Background", "removeBg", () => bgPick.click()), bgPick);
      // PANEL_IMAGE_EDITOR: the preview, with Scale / PPI and the buttons beside it (under it in the board dialog's column)
      const editor = sch ? h("div", { class: "pd-box", style: "display:flex;gap:12px;align-items:flex-start;margin-top:8px" }, preview, h("div", { style: "flex:1;min-width:0" }, edForm, edBtns))
        : h("div", { class: "pd-box" }, preview, edForm, edBtns);
      if (sch) {   // fgSizerPos above m_imageSizer
        body.append(form([["Position X:", x.el, unitLabel()], ["Position Y:", y.el, unitLabel()], ["Rotation:", rot.el, unitLabel("deg")], ["Opacity:", opacityIn]], true), editor);
        return;
      }
      body.append(h("div", { class: "pd-cols2" },
        h("div", null,
          form([["Position X:", x.el, unitLabel()], ["Position Y:", y.el, unitLabel()], ["Rotation:", rot.el, unitLabel("deg")],
            ["Width:", wd.el, unitLabel()], ["Height:", ht.el, unitLabel()], ["Opacity:", opacityIn], ["Associated layer:", layer.el]], true),
          h("div", { class: "pd-row", style: "margin-top:8px" }, locked.el)),
        editor));
    },
    ok() {
      if (ro) return true;
      const v = current();
      const finish = (): void => {
        const node = applyRefImage(node0, v, sch);
        if (K().serialize(node) === K().serialize(node0)) return;   // nothing changed: the item stays as it is
        ctx.commit([K().replaceChange(doc, { ...item, node, geom: [], bbox: null })], sch ? "Image Properties" : "Edit Reference Image Properties");
      };
      const chk = v0.pxW && v0.pxH ? checkImageScale(v0, v.scale) : (v.scale < 0 ? { error: "Scale must be a positive number." } : {});
      if (chk.error) { errorMessage(chk.error); return false; }
      if (chk.confirm) { messageBox("Confirmation", chk.confirm, [{ label: "No" }, { label: "Yes", fn: () => { finish(); if (api) api.close(); } }]); return false; }   // IsOK: No keeps the dialog
      finish(); return true;
    } });
  return !!api;
}
