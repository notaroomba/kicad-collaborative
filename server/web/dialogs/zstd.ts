// dialogs/zstd.ts — a Zstandard (RFC 8878) frame decoder, used where the browser's DecompressionStream has no
// 'zstd' format, so the embedded files KiCad writes (EMBEDDED_FILES::CompressAndEncode: base64 of a zstd frame)
// can be read everywhere.  Raw, RLE and compressed blocks; Huffman literals (1 or 4 streams, treeless reuse);
// FSE sequences (predefined, RLE, compressed and repeat tables) with the three repeat offsets; skippable frames.
// Dictionaries are not supported (KiCad does not use one) and the content checksum is skipped, not verified.

class Out {
  buf = new Uint8Array(1 << 12); len = 0;
  private grow(n: number): void { if (this.len + n <= this.buf.length) return; let c = this.buf.length; while (c < this.len + n) c *= 2; const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
  push(src: Uint8Array, from: number, n: number): void { this.grow(n); this.buf.set(src.subarray(from, from + n), this.len); this.len += n; }
  fill(v: number, n: number): void { this.grow(n); this.buf.fill(v, this.len, this.len + n); this.len += n; }
  /** A match: `n` bytes from `off` back, overlapping copies byte by byte as LZ77 means them. */
  copy(off: number, n: number): void {
    if (off < 1 || off > this.len) throw new Error("zstd: offset out of range");
    this.grow(n); const b = this.buf; let s = this.len - off;
    for (let i = 0; i < n; i++) b[this.len++] = b[s++];
  }
}

/** Bits of `src` (from byte `base`) at bit positions [start, start + n), little-endian; positions below 0 read as 0. */
function bitsAt(src: Uint8Array, base: number, start: number, n: number): number {
  let v = 0, mul = 1, i = start, rem = n;
  while (rem > 0) {
    if (i < 0) { const k = Math.min(rem, -i); mul *= 2 ** k; i += k; rem -= k; continue; }
    const off = i & 7, k = Math.min(8 - off, rem);
    v += ((src[base + (i >> 3)] >> off) & ((1 << k) - 1)) * mul; mul *= 2 ** k; i += k; rem -= k;
  }
  return v;
}
const highBit = (v: number): number => 31 - Math.clz32(v);

/** A backward bit stream (Huffman and FSE payloads): read from the end, after the final byte's marker bit. */
class BackBits {
  pos: number;
  constructor(private src: Uint8Array, private base: number, len: number) {
    if (len < 1) throw new Error("zstd: empty bit stream");
    const last = src[base + len - 1]; if (!last) throw new Error("zstd: bit stream without end marker");
    this.pos = (len - 1) * 8 + highBit(last);
  }
  read(n: number): number { if (!n) return 0; this.pos -= n; return bitsAt(this.src, this.base, this.pos, n); }
  peek(n: number): number { return bitsAt(this.src, this.base, this.pos - n, n); }
  skip(n: number): void { this.pos -= n; }
}

interface FseTable { log: number; sym: Uint8Array; bits: Uint8Array; base: Uint16Array | Uint32Array }

/** FSE_buildDTable from normalized counts (-1 = "less than one"). */
function fseTable(norm: number[], log: number): FseTable {
  const size = 1 << log; const sym = new Uint8Array(size), bits = new Uint8Array(size), base = new Uint32Array(size);
  let high = size - 1; const next: number[] = [];
  norm.forEach((c, s) => { if (c === -1) { sym[high--] = s; next[s] = 1; } else next[s] = c; });
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1; let pos = 0;
  norm.forEach((c, s) => { for (let i = 0; i < c; i++) { sym[pos] = s; do pos = (pos + step) & mask; while (pos > high); } });
  if (pos !== 0) throw new Error("zstd: bad FSE table");
  for (let u = 0; u < size; u++) { const s = sym[u]; const ns = next[s]++; const nb = log - highBit(ns); bits[u] = nb; base[u] = (ns << nb) - size; }
  return { log, sym, bits, base };
}
const rleTable = (s: number): FseTable => ({ log: 0, sym: Uint8Array.of(s), bits: Uint8Array.of(0), base: Uint32Array.of(0) });

/** FSE_readNCount: a table description at `at`; returns the table and the bytes it took. */
function readFse(src: Uint8Array, at: number, end: number, maxSym: number, maxLog: number): [FseTable, number] {
  let bit = 0; const get = (n: number) => { const v = bitsAt(src, at, bit, n); bit += n; return v; };
  const log = get(4) + 5; if (log > maxLog) throw new Error("zstd: FSE accuracy too large");
  let remaining = (1 << log) + 1, threshold = 1 << log, nb = log + 1, s = 0, prev0 = false; const norm: number[] = [];
  while (remaining > 1 && s <= maxSym) {
    if (prev0) {
      let r: number; while ((r = get(2)) === 3) { for (let k = 0; k < 3; k++) norm[s++] = 0; }
      for (let k = 0; k < r; k++) norm[s++] = 0;
      if (s > maxSym) break;
    }
    const max = 2 * threshold - 1 - remaining; let c: number;
    const low = bitsAt(src, at, bit, nb - 1);
    if ((low & (threshold - 1)) < max) { c = low & (threshold - 1); bit += nb - 1; } else { c = bitsAt(src, at, bit, nb) & (2 * threshold - 1); if (c >= threshold) c -= max; bit += nb; }
    c--; remaining -= c < 0 ? -c : c; norm[s++] = c; prev0 = c === 0;
    while (remaining < threshold) { nb--; threshold >>= 1; }
  }
  if (remaining !== 1) throw new Error("zstd: bad FSE counts");
  const used = (bit + 7) >> 3; if (at + used > end) throw new Error("zstd: truncated FSE table");
  return [fseTable(norm, log), used];
}

interface Huff { maxBits: number; sym: Uint8Array; bits: Uint8Array }

/** HUF_readStats + HUF_readDTableX1: the tree description at `at`; returns the table and the bytes it took. */
function readHuffman(src: Uint8Array, at: number, end: number): [Huff, number] {
  const hb = src[at]; const w: number[] = []; let used: number;
  if (hb >= 128) {
    const n = hb - 127; used = 1 + ((n + 1) >> 1); if (at + used > end) throw new Error("zstd: truncated weights");
    for (let i = 0; i < n; i++) { const b = src[at + 1 + (i >> 1)]; w.push(i & 1 ? b & 15 : b >> 4); }
  } else {
    used = 1 + hb; if (at + used > end) throw new Error("zstd: truncated weights");
    const [t, tl] = readFse(src, at + 1, at + used, 255, 6);
    const bs = new BackBits(src, at + 1 + tl, hb - tl);
    let s1 = bs.read(t.log), s2 = bs.read(t.log);
    const step = (s: number): number => t.base[s] + bs.read(t.bits[s]);
    for (;;) {
      w.push(t.sym[s1]); s1 = step(s1); if (bs.pos < 0) { w.push(t.sym[s2]); break; }
      w.push(t.sym[s2]); s2 = step(s2); if (bs.pos < 0) { w.push(t.sym[s1]); break; }
      if (w.length > 255) throw new Error("zstd: too many weights");
    }
  }
  let total = 0; for (const x of w) if (x) total += 1 << (x - 1);
  if (!total) throw new Error("zstd: empty Huffman tree");
  const maxBits = highBit(total) + 1, rest = (1 << maxBits) - total;
  if (rest & (rest - 1)) throw new Error("zstd: bad Huffman weights");
  w.push(highBit(rest) + 1);
  if (maxBits > 11) throw new Error("zstd: Huffman depth too large");
  const size = 1 << maxBits, sym = new Uint8Array(size), bits = new Uint8Array(size);
  const count: number[] = new Array(maxBits + 2).fill(0); for (const x of w) if (x) count[x]++;
  const start: number[] = []; let p = 0; for (let x = 1; x <= maxBits; x++) { start[x] = p; p += count[x] << (x - 1); }
  w.forEach((x, s) => { if (!x) return; const n = 1 << (x - 1); for (let i = 0; i < n; i++) { sym[start[x] + i] = s; bits[start[x] + i] = maxBits + 1 - x; } start[x] += n; });
  return [{ maxBits, sym, bits }, used];
}

function huffStream(src: Uint8Array, at: number, len: number, h: Huff, n: number, out: Uint8Array, o: number): void {
  const bs = new BackBits(src, at, len);
  for (let i = 0; i < n; i++) { const k = bs.peek(h.maxBits); out[o + i] = h.sym[k]; bs.skip(h.bits[k]); }
}

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const LL_DEFAULT = fseTable([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
const ML_DEFAULT = fseTable([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1], 6);
const OF_DEFAULT = fseTable([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);

/** The state a frame carries from block to block. */
interface FrameState { rep: number[]; huff: Huff | null; ll: FseTable | null; of: FseTable | null; ml: FseTable | null }

function literals(src: Uint8Array, at: number, end: number, st: FrameState): [Uint8Array, number] {
  const b0 = src[at], type = b0 & 3, sf = (b0 >> 2) & 3;
  if (type < 2) {
    let n: number, hl: number;
    if (sf === 0 || sf === 2) { n = b0 >> 3; hl = 1; } else if (sf === 1) { n = (b0 >> 4) + (src[at + 1] << 4); hl = 2; } else { n = (b0 >> 4) + (src[at + 1] << 4) + (src[at + 2] << 12); hl = 3; }
    if (type === 0) { if (at + hl + n > end) throw new Error("zstd: truncated literals"); return [src.slice(at + hl, at + hl + n), hl + n]; }
    return [new Uint8Array(n).fill(src[at + hl]), hl + 1];
  }
  let regen: number, comp: number, hl: number; const b1 = src[at + 1], b2 = src[at + 2];
  if (sf < 2) { hl = 3; regen = (b0 >> 4) | ((b1 & 0x3f) << 4); comp = (b1 >> 6) | (b2 << 2); }
  else if (sf === 2) { hl = 4; regen = (b0 >> 4) | (b1 << 4) | ((b2 & 3) << 12); comp = (b2 >> 2) | (src[at + 3] << 6); }
  else { hl = 5; regen = (b0 >> 4) | (b1 << 4) | ((b2 & 0x3f) << 12); comp = (b2 >> 6) | (src[at + 3] << 2) | (src[at + 4] << 10); }
  let p = at + hl; const stop = p + comp; if (stop > end) throw new Error("zstd: truncated literals");
  if (type === 2) { const [h, used] = readHuffman(src, p, stop); st.huff = h; p += used; } else if (!st.huff) throw new Error("zstd: treeless literals without a table");
  const h = st.huff!; const out = new Uint8Array(regen);
  if (sf === 0) huffStream(src, p, stop - p, h, regen, out, 0);
  else {
    const s1 = src[p] | (src[p + 1] << 8), s2 = src[p + 2] | (src[p + 3] << 8), s3 = src[p + 4] | (src[p + 5] << 8); p += 6;
    const s4 = stop - p - s1 - s2 - s3; if (s4 < 1) throw new Error("zstd: bad jump table");
    const q = (regen + 3) >> 2;
    huffStream(src, p, s1, h, q, out, 0); huffStream(src, p + s1, s2, h, q, out, q); huffStream(src, p + s1 + s2, s3, h, q, out, 2 * q);
    huffStream(src, p + s1 + s2 + s3, s4, h, regen - 3 * q, out, 3 * q);
  }
  return [out, stop - at];
}

function compressedBlock(src: Uint8Array, at: number, end: number, st: FrameState, out: Out): void {
  const [lit, lused] = literals(src, at, end, st); let p = at + lused;
  let nSeq = src[p++];
  if (nSeq >= 128) { if (nSeq === 255) { nSeq = src[p] + (src[p + 1] << 8) + 0x7f00; p += 2; } else { nSeq = ((nSeq - 128) << 8) + src[p++]; } }
  if (!nSeq) { out.push(lit, 0, lit.length); return; }
  const modes = src[p++];
  const table = (mode: number, def: FseTable, prev: FseTable | null, maxSym: number, maxLog: number): FseTable => {
    if (mode === 0) return def;
    if (mode === 1) return rleTable(src[p++]);
    if (mode === 2) { const [t, used] = readFse(src, p, end, maxSym, maxLog); p += used; return t; }
    if (!prev) throw new Error("zstd: repeat table without a previous one");
    return prev;
  };
  st.ll = table(modes >> 6, LL_DEFAULT, st.ll, 35, 9); st.of = table((modes >> 4) & 3, OF_DEFAULT, st.of, 31, 8); st.ml = table((modes >> 2) & 3, ML_DEFAULT, st.ml, 52, 9);
  const LL = st.ll, OF = st.of, ML = st.ml, rep = st.rep;
  const bs = new BackBits(src, p, end - p);
  let sl = bs.read(LL.log), so = bs.read(OF.log), sm = bs.read(ML.log); let lp = 0;
  for (let i = 0; i < nSeq; i++) {
    const ofCode = OF.sym[so], mlCode = ML.sym[sm], llCode = LL.sym[sl];
    if (ofCode > 31 || mlCode > 52 || llCode > 35) throw new Error("zstd: bad sequence code");
    const ofValue = 2 ** ofCode + bs.read(ofCode);
    const ml = ML_BASE[mlCode] + bs.read(ML_BITS[mlCode]), ll = LL_BASE[llCode] + bs.read(LL_BITS[llCode]);
    let off: number;
    if (ofValue > 3) { off = ofValue - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; }
    else {
      const idx = ofValue - 1 + (ll === 0 ? 1 : 0);
      if (idx === 0) off = rep[0];
      else { off = idx === 3 ? rep[0] - 1 : rep[idx]; if (idx === 1) rep[1] = rep[0]; else { rep[2] = rep[1]; rep[1] = rep[0]; } rep[0] = off; }
    }
    if (lp + ll > lit.length) throw new Error("zstd: literals overrun");
    out.push(lit, lp, ll); lp += ll; out.copy(off, ml);
    if (i + 1 < nSeq) { sl = LL.base[sl] + bs.read(LL.bits[sl]); sm = ML.base[sm] + bs.read(ML.bits[sm]); so = OF.base[so] + bs.read(OF.bits[so]); }
  }
  out.push(lit, lp, lit.length - lp);
}

/** Every frame of `src` decoded and concatenated.  Throws on malformed input or a frame that needs a dictionary. */
export function zstdDecompress(src: Uint8Array): Uint8Array {
  const out = new Out(); let p = 0;
  const u32 = (i: number) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;
  while (p < src.length) {
    if (p + 4 > src.length) throw new Error("zstd: truncated frame");
    const magic = u32(p); p += 4;
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) { p += 4 + u32(p); continue; }   // a skippable frame
    if (magic !== 0xfd2fb528) throw new Error("zstd: not a zstd frame");
    const d = src[p++]; const fcsFlag = d >> 6, single = (d >> 5) & 1, checksum = (d >> 2) & 1, dictFlag = d & 3;
    if (d & 8) throw new Error("zstd: reserved bit set");
    if (!single) p++;   // the window descriptor: the output simply grows
    const dictLen = [0, 1, 2, 4][dictFlag]; let dict = 0; for (let i = 0; i < dictLen; i++) dict += src[p + i] * 2 ** (8 * i); p += dictLen;
    if (dict) throw new Error("zstd: frames that need a dictionary are not supported");
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    const st: FrameState = { rep: [1, 4, 8], huff: null, ll: null, of: null, ml: null };
    for (;;) {
      if (p + 3 > src.length) throw new Error("zstd: truncated block");
      const h = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16); p += 3;
      const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
      if (type === 0) { if (p + size > src.length) throw new Error("zstd: truncated block"); out.push(src, p, size); p += size; }
      else if (type === 1) { out.fill(src[p], size); p += 1; }
      else if (type === 2) { if (p + size > src.length) throw new Error("zstd: truncated block"); compressedBlock(src, p, p + size, st, out); p += size; }
      else throw new Error("zstd: reserved block type");
      if (last) break;
    }
    if (checksum) p += 4;
  }
  return out.buf.slice(0, out.len);
}
