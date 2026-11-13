// SCH_CONNECTION::IsBusLabel: is a label's (unescaped) text a bus name, a vector (PREFIX[n..m]) or a group
// (NAME{A B C})?  Ports of NET_SETTINGS::ParseBusVector / ParseBusGroup (common/project/net_settings.cpp), only the
// yes / no answer: the member lists are not built here.
import { unescapeText } from "./text";

const isSuperSubOverbar = (c: string): boolean => c === "_" || c === "^" || c === "~";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
/** An odd run of backslashes before aPos escapes the character there. */
function isEscaped(s: string, pos: number): boolean {
  let n = 0; while (pos > 0 && s[pos - 1] === "\\") { n++; pos--; }
  return n % 2 === 1;
}

/** NET_SETTINGS::ParseBusVector( aBus, nullptr, nullptr ). */
export function isBusVector(bus: string): boolean {
  const len = bus.length; let i = 0, nest = 0, inQuotes = false, prefix = "", tmp = "", begin = 0, end = 0, parsedEnd = false;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === '"' && !isEscaped(bus, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) prefix += bus[++i]; else prefix += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(bus[i - 1])) { nest++; prefix += "{"; continue; } return false; }
    if (c === "}") { nest--; prefix += "}"; continue; }
    if (c === "\\" && i + 1 < len && bus[i + 1] === " ") { prefix += bus[++i]; continue; }
    if (c === " " || c === "]") return false;
    if (c === "[") break;
    prefix += c;
  }
  i++;                                                    // '['
  if (i >= len) return false;
  for (; i < len; ++i) {
    if (bus[i] === "." && i + 1 < len && bus[i + 1] === ".") { if (!tmp) return false; begin = parseInt(tmp, 10); i += 2; break; }
    if (!isDigit(bus[i])) return false;
    tmp += bus[i];
  }
  tmp = "";
  if (i >= len) return false;
  for (; i < len; ++i) {
    if (bus[i] === "]") { if (!tmp) return false; end = parseInt(tmp, 10); parsedEnd = true; ++i; break; }
    if (!isDigit(bus[i])) return false;
    tmp += bus[i];
  }
  if (!parsedEnd) return false;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === "}") nest--;
    else if (c !== "+" && c !== "-" && c !== "P" && c !== "N") return false;
  }
  if (nest !== 0) return false;
  return begin !== end;
}

/** NET_SETTINGS::ParseBusGroup( aGroup, nullptr, nullptr ). */
export function isBusGroup(group: string): boolean {
  const len = group.length; let i = 0, nest = 0, inQuotes = false;
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) ++i; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; continue; } break; }
    if (c === "}") { nest--; continue; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { ++i; continue; }
    if (c === " " || c === "[" || c === "]") return false;
  }
  if (nest !== 0) return false;
  i++;                                                    // '{'
  if (i >= len) return false;
  inQuotes = false;
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) ++i; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; continue; } return false; }
    if (c === "}") { if (nest) { nest--; continue; } return true; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { ++i; continue; }
  }
  return false;
}

const CACHE = new Map<string, boolean>();
/** SCH_CONNECTION::IsBusLabel( text ): the text is unescaped ({slash} → / …) first. */
export function isBusLabel(text: string): boolean {
  let v = CACHE.get(text);
  if (v === undefined) {
    const u = unescapeText(text);
    v = isBusVector(u) || isBusGroup(u);
    if (CACHE.size > 4096) CACHE.clear();
    CACHE.set(text, v);
  }
  return v;
}
