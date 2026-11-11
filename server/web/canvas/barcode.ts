// barcode.ts — the bar patterns of PCB_BARCODE's 1D symbologies (Code 39 and Code 128), with the module tables of
// the Zint library KiCad links (thirdparty/zint/backend/code.c C39Table, code128.c C128Table), so a (barcode …) item
// draws the same bars pcbnew does.  The 2D symbologies (QR, Micro QR, Data Matrix) are not encoded here: their
// geometry draws the finder patterns only (geom-pcb.ts).

/** Code 39: 9 elements per character (bar, space, …; 1 narrow, 2 wide) and the inter-character gap; [43] is the start / stop "*". */
const C39 = "1112212111 2112111121 1122111121 2122111111 1112211121 2112211111 1122211111 1112112121 2112112111 1122112111 2111121121 1121121121 2121121111 1111221121 2111221111 1121221111 1111122121 2111122111 1121122111 1111222111 2111111221 1121111221 2121111211 1111211221 2111211211 1121211211 1111112221 2111112211 1121112211 1111212211 2211111121 1221111121 2221111111 1211211121 2211211111 1221211111 1211112121 2211112111 1221112111 1212121111 1212111211 1211121211 1112121211 1211212111".split(" ");
const C39_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
/** Code 128 symbol values 0..106: 6 elements each (bar, space, … in modules); the stop pattern is 2331112. */
const C128 = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 211133".split(" ");
const C128_STOP = "2331112";

/** Bars of a pattern of element widths (bar first) as [x0, x1] in modules, appended at `x`; returns the new x. */
function bars(pattern: string, x: number, out: [number, number][]): number {
  for (let i = 0; i < pattern.length; i++) { const w = pattern.charCodeAt(i) - 48; if (i % 2 === 0) out.push([x, x + w]); x += w; }
  return x;
}

export interface Barcode1D { modules: number; bars: [number, number][] }

/** Code 39 as Zint draws it (no check digit, upper-case only): null when a character is not in the set. */
export function code39(text: string): Barcode1D | null {
  const out: [number, number][] = []; let x = bars(C39[43], 0, out);
  for (const ch of text.toUpperCase()) { const i = C39_CHARS.indexOf(ch); if (i < 0) return null; x = bars(C39[i], x, out); }
  x = bars(C39[43].slice(0, 9), x, out);
  return { modules: x, bars: out };
}

/** Code 128: set C for an all-digit text of even length (at least 4), set B otherwise; the mod-103 check symbol and the stop. */
export function code128(text: string): Barcode1D | null {
  const values: number[] = [];
  if (/^\d+$/.test(text) && text.length >= 4 && text.length % 2 === 0) { values.push(105); for (let i = 0; i < text.length; i += 2) values.push(parseInt(text.slice(i, i + 2), 10)); }
  else { values.push(104); for (const ch of text) { const c = ch.charCodeAt(0); if (c < 32 || c > 127) return null; values.push(c - 32); } }
  let sum = values[0]; for (let i = 1; i < values.length; i++) sum += i * values[i];
  values.push(sum % 103);
  const out: [number, number][] = []; let x = 0;
  for (const v of values) x = bars(C128[v], x, out);
  x = bars(C128_STOP, x, out);
  return { modules: x, bars: out };
}
