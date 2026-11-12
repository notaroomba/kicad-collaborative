// props/numeric.ts — numeric input (libs/kimath NUMERIC_EVALUATOR)
// What KiCad's unit-aware text fields accept: + - * / and parentheses over numbers that may carry a unit
// (mm, cm, um / µm, in / ", mil / mils / thou; ° / deg for angles).  A number without a unit is in
// `defUnit` ("mm" | "in" | "mil"; "" for plain numbers, where a unit is an error).  Returns millimetres
// (or the plain number), NaN when the text does not parse.
import { r6, str } from "./sexpr";

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, um: 0.001, "µm": 0.001, "in": 25.4, '"': 25.4, inch: 25.4, mil: 0.0254, mils: 0.0254, thou: 0.0254 };
export function evalExpr(text: unknown, defUnit?: string): number {
  const src = str(text).trim().replace(/,/g, "."); if (!src) return NaN;
  const scale = defUnit ? (UNIT_MM[defUnit] || 1) : 1;
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  function primary(): number {
    ws();
    if (src[i] === "(") { i++; const v = sum(); ws(); if (src[i] !== ")") return NaN; i++; return v; }
    if (src[i] === "-") { i++; return -primary(); }
    if (src[i] === "+") { i++; return primary(); }
    const m = /^(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)/i.exec(src.slice(i)); if (!m) return NaN;
    i += m[0].length; let v = parseFloat(m[0]);
    ws();
    const u = /^(mm|cm|um|µm|inch|in|"|mils|mil|thou|°|deg)/i.exec(src.slice(i));
    if (u) {
      i += u[0].length; const key = u[0].toLowerCase();
      if (key === "°" || key === "deg") return defUnit ? NaN : v;
      if (!defUnit) return NaN;
      return v * UNIT_MM[key];
    }
    return v * scale;
  }
  // a product of two lengths would be an area: only the first unit-carrying factor is scaled, later bare
  // factors are plain multipliers ("2 * 1.5" in mm is 3 mm, as NUMERIC_EVALUATOR treats it)
  function product(): number {
    let v = primary();
    for (;;) {
      ws(); const op = src[i]; if (op !== "*" && op !== "/") return v;
      i++; const r = primary() / scale;
      v = op === "*" ? v * r : v / r;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) { ws(); const op = src[i]; if (op !== "+" && op !== "-") return v; i++; const r = product(); v = op === "+" ? v + r : v - r; }
  }
  const out = sum(); ws();
  return i < src.length || !isFinite(out) ? NaN : r6(out);
}
/** A millimetre length as KiCad's property grid shows it in the given units: "1.27 mm", "50 mils", "0.05 in". */
export function formatLength(v: number, unit?: string): string {
  const u: [number, number, string] = unit === "in" ? [25.4, 6, "in"] : unit === "mil" ? [0.0254, 3, "mils"] : [1, 4, "mm"];
  let t = (v / u[0]).toFixed(u[1]); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (t === "-0") t = "0";
  return t + " " + u[2];
}
