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
/** NET_SETTINGS::ForEachBusMember: a vector pattern "D[0..3]" is its members' patterns, anything else itself. */
export function busMemberPatterns(p: string): string[] {
  const v = /^(.*?)\[(\d+)\.\.(\d+)\](.*)$/.exec(p);
  if (v) { const a = +v[2], b = +v[3], out: string[] = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(v[1] + i + v[4]); return out; }
  return [p];
}
