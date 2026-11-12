// media.ts — what `ffmpeg` does for a plugin that turns rendered frames into an animation, done by the browser.
//
// A desktop plugin starts ffmpeg to assemble PNG frames into a GIF or an MP4.  There is no ffmpeg in a browser
// tab; the pieces it would use are here instead: the browser decodes the frames and composes them on the
// background colour, a median-cut quantiser and an LZW writer make the GIF (one palette for the whole clip and
// error-diffusion dithering, as ffmpeg's palettegen / paletteuse pair does), and the browser's own video
// encoder (WebCodecs) makes the H.264 stream that a small ISO-BMFF writer wraps as an MP4.
//
// It is built by scripts/build-python.mjs into the Python runtime's files (kicad_media.js) and registers
// globalThis.__kcMedia; plugins/python/kicad_programs.py drives it.  The headless test harness runs the same
// file in Chromium (scripts/plugin-media.mjs).  No imports: it must stand alone in the plugin's sandboxed frame.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface JobOptions {
  format: "gif" | "mp4" | "palette" | "png";
  fps: number;                 // frames per second of the result
  width?: number; height?: number;   // of the result; the first frame's size when omitted
  background?: string;         // "#rrggbb" composed under every frame; "" keeps transparency (GIF) or black (MP4)
  even?: boolean;              // MP4: round the size down to even numbers, as yuv420p needs
  loop?: number;               // GIF: 0 forever (ffmpeg's default), -1 no loop, n times
  crf?: number;                // MP4: x264's quality number (18 by default here, 23 is ffmpeg's)
  dither?: boolean;            // GIF: error diffusion (on unless told otherwise)
  palette?: Uint8Array;        // GIF: a palette picture made earlier (palettegen's output)
  maxColors?: number;
}

type RGBA8 = Uint8ClampedArray;

function canvasOf(w: number, h: number): { c: any; ctx: any } {
  const c: any = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("this browser gave no 2D canvas");
  return { c, ctx };
}

async function blobOf(c: any, type: string): Promise<Uint8Array> {
  const blob: Blob = typeof c.convertToBlob === "function" ? await c.convertToBlob({ type }) : await new Promise<Blob>((ok, no) => c.toBlob((b: Blob | null) => (b ? ok(b) : no(new Error("could not encode the picture"))), type));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- colour quantisation (median cut)

/** Colours counted in 5 bits a channel: enough to pick 256 from, and a table small enough to walk. */
class Histogram {
  counts = new Uint32Array(32768);
  private sr = new Float64Array(32768); private sg = new Float64Array(32768); private sb = new Float64Array(32768);   // the exact colours of each cell, summed
  add(p: RGBA8, step: number): void {
    const c = this.counts;
    for (let i = 0; i < p.length; i += 4 * step) {
      if (p[i + 3] < 128) continue;
      const k = ((p[i] >> 3) << 10) | ((p[i + 1] >> 3) << 5) | (p[i + 2] >> 3); c[k]++; this.sr[k] += p[i]; this.sg[k] += p[i + 1]; this.sb[k] += p[i + 2];
    }
  }
  palette(max: number): number[][] {
    const c = this.counts; const cells: number[] = []; for (let i = 0; i < 32768; i++) if (c[i]) cells.push(i);
    if (!cells.length) return [[0, 0, 0]];
    type Box = { cells: number[]; n: number; range: number; axis: number };
    const box = (list: number[]): Box => {
      let n = 0; const lo = [31, 31, 31], hi = [0, 0, 0];
      for (const v of list) { n += c[v]; const ch = [v >> 10, (v >> 5) & 31, v & 31]; for (let k = 0; k < 3; k++) { if (ch[k] < lo[k]) lo[k] = ch[k]; if (ch[k] > hi[k]) hi[k] = ch[k]; } }
      const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]; const axis = r[1] >= r[0] && r[1] >= r[2] ? 1 : r[0] >= r[2] ? 0 : 2;
      return { cells: list, n, range: r[axis], axis };
    };
    const boxes: Box[] = [box(cells)];
    while (boxes.length < max) {
      // split the box that holds the most pixels among those that can still be split
      let at = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) { const b = boxes[i]; if (b.cells.length > 1 && b.range > 0) { const score = b.n * (b.range + 1); if (score > best) { best = score; at = i; } } }
      if (at < 0) break;
      const b = boxes[at]; const shift = b.axis === 0 ? 10 : b.axis === 1 ? 5 : 0;
      b.cells.sort((x, y) => ((x >> shift) & 31) - ((y >> shift) & 31));
      let half = b.n / 2, cut = 0, seen = 0;
      for (; cut < b.cells.length - 1; cut++) { seen += c[b.cells[cut]]; if (seen >= half) { cut++; break; } }
      cut = Math.max(1, Math.min(b.cells.length - 1, cut)); half = 0;
      boxes.splice(at, 1, box(b.cells.slice(0, cut)), box(b.cells.slice(cut)));
    }
    return boxes.map((b) => {
      let r = 0, g = 0, bl = 0;
      for (const v of b.cells) { r += this.sr[v]; g += this.sg[v]; bl += this.sb[v]; }
      return [Math.round(r / b.n), Math.round(g / b.n), Math.round(bl / b.n)];
    });
  }
}

/** Nearest palette entry for a colour, remembered per 5-bit cell. */
class Mapper {
  private cache = new Int16Array(32768).fill(-1);
  constructor(private pal: number[][], private first = 0) {}
  index(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); const hit = this.cache[key]; if (hit >= 0) return hit;
    let best = this.first, bd = Infinity; const pal = this.pal;
    for (let i = this.first; i < pal.length; i++) { const p = pal[i]; const dr = p[0] - r, dg = p[1] - g, db = p[2] - b; const d = dr * dr * 3 + dg * dg * 4 + db * db * 2; if (d < bd) { bd = d; best = i; } }
    this.cache[key] = best; return best;
  }
}

/** One frame as palette indices; error diffusion with the sierra2_4a kernel (ffmpeg's default for paletteuse). */
function indexFrame(p: RGBA8, w: number, h: number, pal: number[][], map: Mapper, transparent: number, dither: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  if (!dither) { for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = transparent >= 0 && p[i + 3] < 128 ? transparent : map.index(p[i], p[i + 1], p[i + 2]); return out; }
  let cur = new Float32Array((w + 2) * 3), next = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, e = (x + 1) * 3;
      if (transparent >= 0 && p[i + 3] < 128) { out[y * w + x] = transparent; continue; }
      const r = Math.max(0, Math.min(255, p[i] + cur[e])), g = Math.max(0, Math.min(255, p[i + 1] + cur[e + 1])), b = Math.max(0, Math.min(255, p[i + 2] + cur[e + 2]));
      const k = map.index(r | 0, g | 0, b | 0); out[y * w + x] = k; const q = pal[k];
      const er = (r - q[0]) / 4, eg = (g - q[1]) / 4, eb = (b - q[2]) / 4;
      cur[e + 3] += er * 2; cur[e + 4] += eg * 2; cur[e + 5] += eb * 2;
      next[e - 3] += er; next[e - 2] += eg; next[e - 1] += eb;
      next[e] += er; next[e + 1] += eg; next[e + 2] += eb;
    }
    const t = cur; cur = next; next = t; next.fill(0);
  }
  return out;
}

// ---------------------------------------------------------------- GIF

class Bytes {
  buf = new Uint8Array(1 << 16); n = 0;
  private room(k: number): void { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  u8(v: number): void { this.room(1); this.buf[this.n++] = v & 255; }
  u16le(v: number): void { this.u8(v); this.u8(v >> 8); }
  u16(v: number): void { this.u8(v >> 8); this.u8(v); }
  u32(v: number): void { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  str(t: string): void { for (let i = 0; i < t.length; i++) this.u8(t.charCodeAt(i)); }
  put(b: Uint8Array): void { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  done(): Uint8Array { return this.buf.slice(0, this.n); }
}

/** GIF's variable-code-length LZW, written in 255-byte sub-blocks. */
function lzw(out: Bytes, px: Uint8Array, minCode: number): void {
  out.u8(minCode);
  const clear = 1 << minCode, eoi = clear + 1; let size = minCode + 1, next = eoi + 1;
  const block = new Uint8Array(255); let bn = 0, acc = 0, bits = 0;
  const emit = (code: number): void => {
    acc |= code << bits; bits += size;
    while (bits >= 8) { block[bn++] = acc & 255; acc >>>= 8; bits -= 8; if (bn === 255) { out.u8(255); out.put(block); bn = 0; } }
  };
  // the dictionary: (prefix code << 8 | byte) -> code, in an open-addressed table
  const HS = 1 << 13; const keys = new Int32Array(HS).fill(-1), vals = new Uint16Array(HS);
  emit(clear);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const c = px[i]; const key = (prefix << 8) | c; let h = ((prefix << 4) ^ (c * 31)) & (HS - 1);
    let found = -1;
    for (;;) { const k = keys[h]; if (k === key) { found = vals[h]; break; } if (k === -1) break; h = (h + 1) & (HS - 1); }
    if (found >= 0) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) { keys[h] = key; vals[h] = next++; if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); keys.fill(-1); size = minCode + 1; next = eoi + 1; }
    prefix = c;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) { block[bn++] = acc & 255; }
  if (bn) { out.u8(bn); out.put(block.subarray(0, bn)); }
  out.u8(0);
}

class GifWriter {
  private out = new Bytes(); private prev: Uint8Array | null = null; private clock = 0; private shown = 0;
  constructor(private w: number, private h: number, private pal: number[][], private transparent: number, private fps: number, loop: number) {
    const o = this.out; o.str("GIF89a"); o.u16le(w); o.u16le(h); o.u8(0xf7); o.u8(0); o.u8(0);
    for (let i = 0; i < 256; i++) { const p = pal[i] || [0, 0, 0]; o.u8(p[0]); o.u8(p[1]); o.u8(p[2]); }
    if (loop >= 0) { o.u8(0x21); o.u8(0xff); o.u8(11); o.str("NETSCAPE2.0"); o.u8(3); o.u8(1); o.u16le(loop); o.u8(0); }
  }
  frame(ix: Uint8Array): void {
    const { w, h, out: o } = this;
    // GIF counts time in hundredths of a second: the frames share out the rounding so the clip keeps its length
    this.clock += 100 / this.fps; const delay = Math.max(1, Math.round(this.clock) - this.shown); this.shown += delay;
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    const prev = this.prev;
    if (prev && this.transparent < 0) {
      // only the rectangle that changed is stored
      let top = 0; outer1: for (; top < h; top++) for (let x = 0; x < w; x++) if (ix[top * w + x] !== prev[top * w + x]) break outer1;
      if (top === h) { x0 = y0 = x1 = y1 = 0; }
      else {
        let bot = h - 1; outer2: for (; bot > top; bot--) for (let x = 0; x < w; x++) if (ix[bot * w + x] !== prev[bot * w + x]) break outer2;
        let left = w, right = -1;
        for (let y = top; y <= bot; y++) { const r = y * w; for (let x = 0; x < left; x++) if (ix[r + x] !== prev[r + x]) { left = x; break; } for (let x = w - 1; x > right; x--) if (ix[r + x] !== prev[r + x]) { right = x; break; } }
        x0 = left; x1 = right; y0 = top; y1 = bot;
      }
    }
    const fw = x1 - x0 + 1, fh = y1 - y0 + 1; let px = ix;
    if (fw !== w || fh !== h) { px = new Uint8Array(fw * fh); for (let y = 0; y < fh; y++) px.set(ix.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + fw), y * fw); }
    o.u8(0x21); o.u8(0xf9); o.u8(4); o.u8(this.transparent >= 0 ? 0x09 : 0x04); o.u16le(delay); o.u8(this.transparent >= 0 ? this.transparent : 0); o.u8(0);
    o.u8(0x2c); o.u16le(x0); o.u16le(y0); o.u16le(fw); o.u16le(fh); o.u8(0);
    lzw(o, px, 8);
    this.prev = ix;
  }
  finish(): Uint8Array { this.out.u8(0x3b); return this.out.done(); }
}

// ---------------------------------------------------------------- MP4 (ISO base media file, one video track)

function box(type: string, ...parts: (Uint8Array | Bytes)[]): Uint8Array {
  const bodies = parts.map((p) => (p instanceof Bytes ? p.done() : p)); const n = 8 + bodies.reduce((s, b) => s + b.length, 0);
  const o = new Bytes(); o.u32(n); o.str(type); for (const b of bodies) o.put(b); return o.done();
}
function full(type: string, version: number, flags: number, body: (o: Bytes) => void, ...kids: Uint8Array[]): Uint8Array {
  const o = new Bytes(); o.u32((version << 24) | flags); body(o); return box(type, o, ...kids);
}

interface Sample { data: Uint8Array; key: boolean; duration: number }

function mp4(samples: Sample[], w: number, h: number, timescale: number, codec: string, description: Uint8Array | null): Uint8Array {
  const total = samples.reduce((s, x) => s + x.duration, 0);
  const matrix = (o: Bytes): void => { for (const v of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) o.u32(v); };
  let config: Uint8Array, entry: string;
  if (codec.startsWith("avc1")) {
    if (!description) throw new Error("the encoder gave no H.264 configuration");
    entry = "avc1"; config = box("avcC", description);
  } else if (codec.startsWith("vp09")) {
    const f = codec.split("."); entry = "vp09";
    config = full("vpcC", 1, 0, (o) => { o.u8(parseInt(f[1] || "0", 10)); o.u8(parseInt(f[2] || "10", 10)); o.u8((parseInt(f[3] || "8", 10) << 4) | (1 << 1)); o.u8(1); o.u8(1); o.u8(1); o.u16(0); });
  } else if (codec.startsWith("av01")) {
    const f = codec.split("."); entry = "av01"; const o = new Bytes();
    o.u8(0x81); o.u8((parseInt(f[1] || "0", 10) << 5) | parseInt(f[2] || "8", 10)); o.u8(((f[2] || "").endsWith("H") ? 0x80 : 0) | (parseInt(f[3] || "8", 10) > 8 ? 0x40 : 0) | 0x0c); o.u8(0);
    if (description) o.put(description.length > 4 && description[0] === 0x81 ? description.subarray(4) : description);
    config = box("av1C", o);
  } else throw new Error("no MP4 sample entry for " + codec);
  const visual = new Bytes();
  visual.u32(0); visual.u16(0); visual.u16(1);                       // reserved, data reference index
  visual.u16(0); visual.u16(0); visual.u32(0); visual.u32(0); visual.u32(0);
  visual.u16(w); visual.u16(h); visual.u32(0x00480000); visual.u32(0x00480000); visual.u32(0); visual.u16(1);
  for (let i = 0; i < 32; i++) visual.u8(0);                         // compressor name
  visual.u16(0x18); visual.u16(0xffff);
  const stsd = full("stsd", 0, 0, (o) => o.u32(1), box(entry, visual, config));
  // runs of equal durations
  const runs: [number, number][] = []; for (const s of samples) { const last = runs[runs.length - 1]; if (last && last[1] === s.duration) last[0]++; else runs.push([1, s.duration]); }
  const stts = full("stts", 0, 0, (o) => { o.u32(runs.length); for (const r of runs) { o.u32(r[0]); o.u32(r[1]); } });
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter((i) => i);
  const stss = full("stss", 0, 0, (o) => { o.u32(keys.length); for (const k of keys) o.u32(k); });
  const stsc = full("stsc", 0, 0, (o) => { o.u32(1); o.u32(1); o.u32(samples.length); o.u32(1); });
  const stsz = full("stsz", 0, 0, (o) => { o.u32(0); o.u32(samples.length); for (const s of samples) o.u32(s.data.length); });
  const ftyp = box("ftyp", (() => { const o = new Bytes(); o.str("isom"); o.u32(0x200); o.str("isom"); o.str("iso2"); o.str(entry === "avc1" ? "avc1" : "iso6"); o.str("mp41"); return o; })());
  const moov = (dataAt: number): Uint8Array => box("moov",
    full("mvhd", 0, 0, (o) => { o.u32(0); o.u32(0); o.u32(timescale); o.u32(total); o.u32(0x10000); o.u16(0x100); o.u16(0); o.u32(0); o.u32(0); matrix(o); for (let i = 0; i < 6; i++) o.u32(0); o.u32(2); }),
    box("trak",
      full("tkhd", 0, 3, (o) => { o.u32(0); o.u32(0); o.u32(1); o.u32(0); o.u32(total); o.u32(0); o.u32(0); o.u16(0); o.u16(0); o.u16(0); o.u16(0); matrix(o); o.u32(w << 16); o.u32(h << 16); }),
      box("mdia",
        full("mdhd", 0, 0, (o) => { o.u32(0); o.u32(0); o.u32(timescale); o.u32(total); o.u16(0x55c4); o.u16(0); }),
        full("hdlr", 0, 0, (o) => { o.u32(0); o.str("vide"); o.u32(0); o.u32(0); o.u32(0); o.str("VideoHandler"); o.u8(0); }),
        box("minf",
          full("vmhd", 0, 1, (o) => { o.u16(0); o.u16(0); o.u16(0); o.u16(0); }),
          box("dinf", full("dref", 0, 0, (o) => o.u32(1), full("url ", 0, 1, () => undefined))),
          box("stbl", stsd, stts, stss, stsc, stsz, full("stco", 0, 0, (o) => { o.u32(1); o.u32(dataAt); }))))));
  // the index goes first, so the clip starts playing before it has fully arrived (ffmpeg's -movflags +faststart)
  const head = ftyp.length + moov(0).length + 8;
  const out = new Bytes(); out.put(ftyp); out.put(moov(head));
  out.u32(8 + samples.reduce((s, x) => s + x.data.length, 0)); out.str("mdat"); for (const s of samples) out.put(s.data);
  return out.done();
}

/** x264's CRF as a bit rate for the browser's encoder, which is steered by rate: about what x264 spends on rendered boards. */
function bitrateFor(crf: number, w: number, h: number, fps: number): number {
  const bpp = 0.22 * Math.pow(2, (18 - crf) / 6);
  return Math.max(150000, Math.min(60e6, Math.round(w * h * fps * bpp)));
}

async function pickCodec(w: number, h: number, fps: number, bitrate: number): Promise<{ config: any; codec: string } | null> {
  const VE: any = (globalThis as any).VideoEncoder; if (typeof VE !== "function") return null;
  const level = w * h > 2073600 ? "33" : w * h > 921600 ? "2a" : "1f";
  const tries: any[] = [
    { codec: "avc1.6400" + level, avc: { format: "avc" } }, { codec: "avc1.4d00" + level, avc: { format: "avc" } }, { codec: "avc1.4200" + level, avc: { format: "avc" } },
    { codec: "vp09.00.40.08" }, { codec: "av01.0.08M.08" },
  ];
  for (const t of tries) {
    const config = Object.assign({ width: w, height: h, framerate: fps, bitrate, bitrateMode: "variable", latencyMode: "quality" }, t);
    try { const s = await VE.isConfigSupported(config); if (s && s.supported) return { config, codec: t.codec }; } catch { /* not this one */ }
  }
  return null;
}

// ---------------------------------------------------------------- a job: frames in, one file out

class Job {
  private frames: Blob[] = [];
  constructor(private o: JobOptions) {}

  /** One frame: the bytes of a PNG or JPEG file. */
  add(bytes: Uint8Array): number { this.frames.push(new Blob([bytes as unknown as BlobPart])); return this.frames.length; }

  private async size(): Promise<[number, number]> {
    let w = this.o.width || 0, h = this.o.height || 0;
    if (!w || !h) { const first = await createImageBitmap(this.frames[0]); w = w || first.width; h = h || first.height; first.close(); }
    if (this.o.even) { w -= w % 2; h -= h % 2; }
    return [Math.max(1, w), Math.max(1, h)];
  }

  /** Frame i composed on the background at the result's size. */
  private async draw(ctx: any, i: number, w: number, h: number, opaque: boolean): Promise<void> {
    const bmp = await createImageBitmap(this.frames[i]);
    ctx.clearRect(0, 0, w, h);
    if (this.o.background || opaque) { ctx.fillStyle = this.o.background || "#000000"; ctx.fillRect(0, 0, w, h); }
    // ffmpeg's overlay puts the frame at the top left of the background at its own size
    if (this.o.background && (bmp.width !== w || bmp.height !== h) && !this.o.even) ctx.drawImage(bmp, 0, 0);
    else ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
  }

  async finish(progress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; codec: string; width: number; height: number; frames: number }> {
    const n = this.frames.length; if (!n) throw new Error("no frames were given");
    const [w, h] = await this.size(); const { c, ctx } = canvasOf(w, h); const o = this.o;
    const result = (bytes: Uint8Array, codec: string) => ({ bytes, codec, width: w, height: h, frames: n });
    if (o.format === "png") { await this.draw(ctx, 0, w, h, false); return result(await blobOf(c, "image/png"), "png"); }
    if (o.format === "palette" || o.format === "gif") {
      const keepAlpha = !o.background; const max = Math.max(2, Math.min(256, o.maxColors || 256)) - (keepAlpha ? 1 : 0);
      let pal: number[][] | null = null;
      if (o.format === "gif" && o.palette) {
        const bmp = await createImageBitmap(new Blob([o.palette as unknown as BlobPart])); const pc = canvasOf(bmp.width, bmp.height); pc.ctx.drawImage(bmp, 0, 0);
        const d: RGBA8 = pc.ctx.getImageData(0, 0, bmp.width, bmp.height).data; pal = [];
        for (let i = 0; i < d.length && pal.length < 256; i += 4) pal.push([d[i], d[i + 1], d[i + 2]]);
        bmp.close();
      } else {
        const hist = new Histogram(); const step = Math.max(1, Math.floor((w * h * n) / 6e6));
        for (let i = 0; i < n; i++) { await this.draw(ctx, i, w, h, false); hist.add(ctx.getImageData(0, 0, w, h).data, step); if (progress && o.format === "palette") progress(i + 1, n); }
        pal = hist.palette(max);
      }
      if (o.format === "palette") {
        // a 16 x 16 picture of the colours, as ffmpeg's palettegen writes
        const pc = canvasOf(16, 16); const img = pc.ctx.createImageData(16, 16);
        for (let i = 0; i < 256; i++) { const p = pal[Math.min(i, pal.length - 1)]; img.data.set([p[0], p[1], p[2], 255], i * 4); }
        pc.ctx.putImageData(img, 0, 0); return result(await blobOf(pc.c, "image/png"), "png");
      }
      let transparent = -1; const colours = pal.slice(0, keepAlpha ? 255 : 256);
      if (keepAlpha) { transparent = colours.length; colours.push([0, 0, 0]); }
      const map = new Mapper(colours.slice(0, transparent >= 0 ? transparent : colours.length));
      const gif = new GifWriter(w, h, colours, transparent, o.fps, o.loop === undefined ? 0 : o.loop);
      for (let i = 0; i < n; i++) {
        await this.draw(ctx, i, w, h, false);
        gif.frame(indexFrame(ctx.getImageData(0, 0, w, h).data, w, h, colours, map, transparent, o.dither !== false));
        if (progress) progress(i + 1, n);
      }
      return result(gif.finish(), "gif");
    }
    // MP4
    const bitrate = bitrateFor(o.crf === undefined ? 18 : o.crf, w, h, o.fps); const pick = await pickCodec(w, h, o.fps, bitrate);
    if (!pick) throw new Error("this browser has no video encoder (WebCodecs) for an MP4; a GIF or a PNG sequence can still be made");
    const G: any = globalThis; const samples: Sample[] = []; let description: Uint8Array | null = null; let failed: Error | null = null;
    const timescale = 15360; const tick = Math.round(timescale / o.fps);
    const enc = new G.VideoEncoder({
      output: (chunk: any, meta: any) => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); samples.push({ data, key: chunk.type === "key", duration: tick });
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d && !description) description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      },
      error: (e: Error) => { failed = e; },
    });
    enc.configure(pick.config);
    for (let i = 0; i < n; i++) {
      if (failed) break;
      await this.draw(ctx, i, w, h, true);
      const frame = new G.VideoFrame(c, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
      enc.encode(frame, { keyFrame: i % Math.max(1, Math.round(o.fps * 2)) === 0 }); frame.close();
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      if (progress) progress(i + 1, n);
    }
    await enc.flush(); enc.close();
    if (failed) throw failed;
    return result(mp4(samples, w, h, timescale, pick.codec, description), pick.codec);
  }
}

(globalThis as any).__kcMedia = {
  open(options: JobOptions): Job { return new Job(Object.assign({}, options)); },
  /** Is an MP4 possible here, and with which codec? */
  async video(width: number, height: number, fps: number): Promise<string> { const p = await pickCodec(width, height, fps, bitrateFor(18, width, height, fps)); return p ? p.codec : ""; },
};
