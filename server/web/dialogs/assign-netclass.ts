// dialogs/assign-netclass.ts — SCH_EDITOR_CONTROL::AssignNetclass and DIALOG_ASSIGN_NETCLASS ("Add Netclass
// Assignment"): the selected labelled nets as one pattern (GetNetclassPatternForSet), a net class to give them, the
// nets the pattern matches listed (and brightened on the sheet) as it is typed; OK adds the pattern assignment to the
// project's net_settings.netclass_patterns (NET_SETTINGS::SetNetclassPatternAssignment).
import { E, toast, toolCtx } from "./editor";
import { KD, h } from "./dom";
import { projectJson, saveProject, obj, sub } from "./project";
import { allNetNames, clearHighlight, netsOfItems, previewNets } from "../editor/schnets";
import { selectionIds } from "../editor/gestures";

const unescape = (s: string): string => (KiCadCanvas as unknown as { pcbNetlist: { unescapeNetName(s: string): string } }).pcbNetlist.unescapeNetName(s);
const matches = (p: string, n: string): boolean => (KiCadCanvas as unknown as { pcbSizes: { netclassPatternMatches(p: string, n: string): boolean } }).pcbSizes.netclassPatternMatches(p, n);

/** UpgradeGlobStarToRegex: a '*' not preceded by '.' becomes '.*'. */
export function upgradeGlobStar(p: string): string { return p.replace(/(^|[^.])\*/g, "$1.*"); }
/** StrNumSort( IGNORE_CASE ): natural order, case folded. */
function strNumCmp(a: string, b: string): number { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
/** GetNetclassPatternForSet: one name as it is; several as "<common prefix>(tail|tail…)" or "a|b|…". */
export function patternForSet(names: string[]): string {
  const set = [...new Set(names)]; if (!set.length) return ""; if (set.length === 1) return set[0];
  const list = set.map(upgradeGlobStar).sort(strNumCmp);
  let pre = list[0]; for (const s of list) { let i = 0; while (i < Math.min(pre.length, s.length) && pre[i] === s[i]) i++; pre = pre.slice(0, i); if (!pre) break; }
  if (pre && pre !== "/") return pre + "(" + list.map((s) => s.slice(pre.length)).join("|") + ")";
  return list.join("|");
}
/** getNetNamePattern: a bus vector "PRE[…]" is "PRE*", a group "PRE{…}" "PRE.*"; an unlabelled net has none. */
export function netNamePattern(e: { name: string; bus: boolean; members: { kind: string; power?: boolean }[] }): string | null {
  if (e.bus) { const v = /^(.*?)\[\d+\.\.\d+\]$/.exec(e.name); if (v) return v[1] + "*"; const g = /^(.*?)\{.*\}$/.exec(e.name); if (g) return g[1] + ".*"; return e.name; }
  // CONNECTION_SUBGRAPH::GetDriverPriority( driver ) >= SHEET_PIN: a label, a sheet pin or a power pin drives it
  const labelled = e.members.some((m) => m.kind === "label" || m.kind === "global_label" || m.kind === "hierarchical_label" || m.kind === "sheet_pin" || (m.kind === "pin" && m.power));
  return labelled ? e.name : null;
}

export function assignNetclass(): void {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.type !== "sch") return;
  const ids = selectionIds();
  const names: string[] = [];
  for (const e of netsOfItems(ids)) {
    if (!e) continue;
    const p = netNamePattern(e);
    if (!p) { toast("All selected nets must be labeled to assign a netclass.", 4000); return; }
    names.push(p);
  }
  if (!names.length) { toast("No nets selected.", 4000); return; }
  toolCtx().setSelection([]);
  const pro = projectJson(), classes = (Array.isArray(obj(pro.net_settings).classes) ? obj(pro.net_settings).classes as unknown[] : []).map((c) => String(obj(c as never).name || "")).filter((n) => n && n !== "Default");
  const candidates = allNetNames();
  let last: string | null = null;
  KD().open({ title: "Add Netclass Assignment", width: 560,
    build(body) {
      const pat = h("input", { id: "kd-anc-pattern", type: "text", value: patternForSet(names), style: "flex:1;min-width:240px" }) as HTMLInputElement;
      const sel = h("k-select", { id: "kd-anc-class" }, ...["Default", ...classes].map((n) => h("option", { value: n }, n))) as HTMLElement & { value: string };
      sel.value = classes.length ? classes[0] : "Default";   // the first non-Default net class
      const list = h("div", { id: "kd-anc-matches", style: "border:1px solid var(--line);background:var(--panel);height:200px;overflow:auto;padding:4px 8px;font-size:11px" });
      const update = () => {
        const p = pat.value; if (p === last) return; last = p; list.replaceChildren();
        const hit: string[] = [];
        if (p) { list.append(h("div", { style: "font-weight:600" }, "Currently matching nets:")); for (const n of candidates) if (matches(p, n)) { hit.push(n); list.append(h("div", null, unescape(n))); } }
        previewNets(hit);
      };
      pat.addEventListener("input", update);
      body.append(h("div", { class: "kd-row", style: "align-items:center;gap:6px;margin-bottom:8px" }, h("label", { for: "kd-anc-pattern", style: "white-space:nowrap" }, "Pattern:"), pat, h("label", { style: "margin-left:24px;white-space:nowrap" }, "Net class:"), sel),
        list, h("p", { class: "kd-note", style: "font-style:italic" }, "Note: complete netclass assignments can be edited in Schematic Setup > Project."));
      update();
    },
    ok() {
      const p = (document.getElementById("kd-anc-pattern") as HTMLInputElement).value, cls = (document.getElementById("kd-anc-class") as unknown as { value: string }).value || "Default";
      clearHighlight();
      if (!p) return;
      void saveProject((proj) => {
        const ns = sub(proj, "net_settings"); const list = Array.isArray(ns.netclass_patterns) ? ns.netclass_patterns as { pattern: string; netclass: string }[] : (ns.netclass_patterns = [] as never) as { pattern: string; netclass: string }[];
        for (const m of busMemberPatterns(p)) if (!list.some((x) => x.pattern === m && x.netclass === cls)) list.push({ netclass: cls, pattern: m });
      }, "assign netclass");
    },
    cancel() { clearHighlight(); } });
}
// NET_SETTINGS::ParseBusVector / ParseBusGroup with their member lists (common/project/net_settings.cpp).
const isSuperSubOverbar = (c: string): boolean => c === "_" || c === "^" || c === "~";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
function isEscaped(s: string, pos: number): boolean { let n = 0; while (pos > 0 && s[pos - 1] === "\\") { n++; pos--; } return n % 2 === 1; }
/** ParseBusVector( aBus, nullptr, &members ): null when the text is not a vector bus. */
function busVectorMembers(bus: string): string[] | null {
  const len = bus.length; let i = 0, nest = 0, inQuotes = false, fmtWrapsName = false, parsedEnd = false, padded = false, width = 0;
  let prefix = "", suffix = "", tmp = "", begin = 0, end = 0;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === '"' && !isEscaped(bus, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) prefix += bus[++i]; else prefix += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(bus[i - 1])) { nest++; prefix += "{"; continue; } return null; }
    if (c === "}") { nest--; prefix += "}"; continue; }
    if (c === "\\" && i + 1 < len && bus[i + 1] === " ") { prefix += bus[++i]; continue; }
    if (c === " " || c === "]") return null;
    if (c === "[") {
      if (nest > 0) {
        const f = prefix.lastIndexOf("{");
        if (f > 0 && isSuperSubOverbar(prefix[f - 1])) { if (f === prefix.length - 1) prefix = prefix.slice(0, f - 1); else fmtWrapsName = true; }
      }
      break;
    }
    prefix += c;
  }
  i++;
  if (i >= len) return null;
  for (; i < len; ++i) {
    if (bus[i] === "." && i + 1 < len && bus[i + 1] === ".") { if (!tmp) return null; begin = parseInt(tmp, 10); width = tmp.length; padded = width > 1 && tmp[0] === "0"; i += 2; break; }
    if (!isDigit(bus[i])) return null;
    tmp += bus[i];
  }
  tmp = "";
  if (i >= len) return null;
  for (; i < len; ++i) {
    if (bus[i] === "]") { if (!tmp) return null; end = parseInt(tmp, 10); padded = padded || (tmp.length > 1 && tmp[0] === "0"); width = Math.max(width, tmp.length); parsedEnd = true; ++i; break; }
    if (!isDigit(bus[i])) return null;
    tmp += bus[i];
  }
  if (!parsedEnd) return null;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === "}") { nest--; if (fmtWrapsName) suffix += c; }
    else if (c === "+" || c === "-" || c === "P" || c === "N") suffix += c;
    else return null;
  }
  if (nest !== 0 || begin === end) return null;
  if (begin > end) { const t = begin; begin = end; end = t; }
  const out: string[] = [];
  for (let idx = begin; idx <= end; idx++) { const n = String(idx); out.push(prefix + (padded && n.length < width ? "0".repeat(width - n.length) : "") + n + suffix); }
  return out;
}
/** ParseBusGroup( aGroup, nullptr, &members ): null when the text is not a bus group. */
function busGroupMembers(group: string): string[] | null {
  const len = group.length; let i = 0, nest = 0, inQuotes = false, tmp = "";
  const esc = (m: string) => m.replace(/ /g, "\\ ").replace(/\//g, "{slash}").replace(/[\r\n]/g, "");   // escapeSpacesForBus, EscapeString( CTX_NETNAME )
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) ++i; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; continue; } break; }
    if (c === "}") { nest--; continue; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { ++i; continue; }
    if (c === " " || c === "[" || c === "]") return null;
  }
  if (nest !== 0) return null;
  i++;
  if (i >= len) return null;
  inQuotes = false;
  const out: string[] = [];
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) tmp += group[++i]; else tmp += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; tmp += "{"; continue; } return null; }
    if (c === "}") { if (nest) { nest--; tmp += "}"; continue; } if (tmp) out.push(esc(tmp)); return out; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { tmp += group[++i]; continue; }
    if (c === " " || c === ",") { if (tmp) out.push(esc(tmp)); tmp = ""; continue; }
    tmp += c;
  }
  return null;
}
/**
 * NET_SETTINGS::ForEachBusMember: a vector pattern "D[0..3]" is its members' patterns, a group "NAME{A B[0..1]}" its
 * members' (each expanded again), anything else itself.
 */
export function busMemberPatterns(p: string): string[] {
  const v = busVectorMembers(p); if (v) return v;
  const g = busGroupMembers(p); if (g) return g.flatMap((m) => busMemberPatterns(m));
  return [p];
}
