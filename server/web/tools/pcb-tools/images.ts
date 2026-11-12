// pcb-tools/images.ts — reference images: decoding and sizing.


// ---------------------------------------------------------------- reference images
export const IMAGE_PPI = 300;   // BITMAP_BASE's default when the file carries no resolution
// Node's Buffer: a free variable that only exists under node (the tests); the browser takes atob.
declare const Buffer: { from(data: string, enc: "base64"): Uint8Array };
export function base64Bytes(b64: string) {
  if (typeof atob === "function") { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
/** Pixel size and resolution of a PNG / JPEG the way BITMAP_BASE reads them: pHYs / JFIF density, else 300 ppi. */
/** A bitmap's pixel size and resolution. */
export interface ImageInfo { type: string; w: number; h: number; ppi: number }
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3], be16 = (i: number) => (b[i] << 8) + b[i + 1];
  const tag = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (b.length > 24 && b[0] === 0x89 && tag(1) === "PNG\r") {
    const out = { type: "png", w: be32(16), h: be32(20), ppi: IMAGE_PPI };
    for (let i = 8; i + 8 <= b.length; i += 12 + be32(i)) {
      const t = tag(i + 4);
      if (t === "pHYs" && i + 17 <= b.length) { if (b[i + 16] === 1) out.ppi = Math.round(be32(i + 8) * 0.0254); break; }   // pixels per metre
      if (t === "IDAT" || t === "IEND") break;
    }
    return out.w && out.h ? out : null;
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    const out = { type: "jpeg", w: 0, h: 0, ppi: IMAGE_PPI };
    for (let i = 2; i + 4 <= b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1]; if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }   // standalone markers
      const len = be16(i + 2);
      if (m === 0xE0 && len >= 16 && tag(i + 4) === "JFIF") { const u = b[i + 11], dx = be16(i + 12); if (dx && u === 1) out.ppi = dx; else if (dx && u === 2) out.ppi = Math.round(dx * 2.54); }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { out.h = be16(i + 5); out.w = be16(i + 7); break; }   // SOFn
      if (m === 0xDA) break;
      i += 2 + len;
    }
    return out.w && out.h ? out : null;
  }
  return null;
}
export const imageMm = (info: ImageInfo) => [info.w * 25.4 / info.ppi, info.h * 25.4 / info.ppi];
