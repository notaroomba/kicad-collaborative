// web/fab/zip — a ZIP archive from in-memory files.  Entries are deflated with the browser's (or node's)
// CompressionStream when there is one and stored otherwise; fabricators' upload forms take either.
export interface ZipEntry { name: string; data: Uint8Array | string }

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as unknown as { CompressionStream?: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (!CS || data.length < 64) return null;
  try {
    const cs = new CS("deflate-raw");
    const writer = cs.writable.getWriter(); void writer.write(data); void writer.close();
    const chunks: Uint8Array[] = []; let total = 0;
    const reader = cs.readable.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
    const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out.length < data.length ? out : null;
  } catch (e) { return null; }
}

function dosTime(d: Date): [number, number] {
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

/** Build the archive.  File names are stored as UTF-8 (general purpose flag bit 11). */
export async function zip(entries: ZipEntry[], when = new Date()): Promise<Uint8Array> {
  const enc = new TextEncoder(); const [time, date] = dosTime(when);
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const name = enc.encode(e.name); const crc = crc32(raw);
    const packed = await deflateRaw(raw); const body = packed || raw; const method = packed ? 8 : 0;
    const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
    const cen = new Uint8Array(46 + name.length); const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cen.set(name, 46);
    parts.push(local, body); central.push(cen); offset += local.length + body.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const c of central) { out.set(c, o); o += c.length; }
  out.set(end, o);
  return out;
}
