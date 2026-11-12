// pcbdialogs/inspect — the Inspect menu's dialogs in KiCad's layout: Design Rules Checker (DIALOG_DRC),
// Board Statistics (DIALOG_BOARD_STATISTICS), Net Inspector and Clearance Resolution.  The checks themselves
// are pcb-tools.js' (drc, netlist, boardStatistics, inspectClearance); this module lays their results out.
import { E } from "../state";
import { fitBox } from "../view";
import { DRC_ITEMS, drcItemTitle } from "../../canvas/drc-items";
import { NL } from "./canvas";
import { projectNetlist } from "./update-pcb";
import { runZoneFill } from "./zonefill";
import { checkField, download, fmtLenU, grid, h, notebook, openDialog, textField, type CellValue } from "./ui";

export interface Marker { code: string; severity: string; x: number; y: number; text: string; ids: string[] }
interface Settings { severities: Record<string, string>; netclasses: Record<string, { clearance?: number }>; clearance: number; edgeClearance: number; minTrackWidth: number; minViaDrill: number }
interface NetRow { name: string; code: number; padCount: number; viaCount: number; trackLength: number; zoneCount: number; unconnected: number }
interface Stats { footprints: { total: number; front: number; back: number; smd: number; tht: number; other: number }; pads: { total: number; smd: number; tht: number; npth: number; connect: number };
  vias: { total: number; through: number; blind: number; micro: number }; tracks: { count: number; length: number }; zones: number; drills: number; width: number; height: number; area: number }
interface PcbToolsApi {
  state: { markers: Marker[] };
  drc(doc: KDoc, settings: unknown, opts?: { unconnected?: boolean; outline?: boolean }): Marker[];
  designSettings(src: unknown): Settings;
  netInspector(doc: KDoc): NetRow[];
  netItemIds(doc: KDoc, key: string): Set<string>;
  boardStatistics(doc: KDoc): Stats;
  inspectClearance(doc: KDoc, a: string, b: string, settings: unknown): { gap: number | null; required: number; sameNet: boolean; nets: string[] } | null;
  netclassOf(s: Settings, net: string): { clearance?: number };
  selectionIds(ctx: ToolCtx): Set<string>;
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const settings = (): Settings => PT().designSettings(E.proSettings || null);
const board = (): KDoc | null => (E.kdoc && E.kdoc.type === "pcb" ? (E.kdoc as KDoc) : null);

/** A short description of a board item for the lists (what KiCad's GetItemDescription gives). */
export function describeItem(doc: KDoc, id: string): string {
  const it = doc.items.get(id); if (!it) return "";
  const net = KiCadCanvas.netNameOf ? String((KiCadCanvas.netNameOf as (d: KDoc, n: SNode) => string)(doc, it.node) || "") : "";
  const layer = it.layer || String(((KiCadCanvas.kid(it.node, "layer") as SNode | null) || [])[1] || "");
  const on = (what: string): string => `${what}${net ? ` [${net}]` : ""}${layer ? ` on ${layer}` : ""}`;
  switch (it.kind) {
    case "footprint": return `Footprint ${it.ref || it.lib || ""}`;
    case "segment": return on("Track");
    case "arc": return on("Track (arc)");
    case "via": return `Via${net ? ` [${net}]` : ""}`;
    case "zone": return on("Zone");
    default: return on(it.kind.replace(/^gr_/, "Graphic ").replace(/_/g, " "));
  }
}

const UNCONNECTED = new Set(["unconnected_items"]);
const PARITY = new Set(DRC_ITEMS.slice(DRC_ITEMS.findIndex((i) => i[0] === "Schematic Parity") + 1, DRC_ITEMS.findIndex((i) => i[0] === "Signal Integrity")).map((i) => i[1]).filter((c) => c !== "unconnected_items"));

// what the last run found, kept while the board stays open so the dialog reopens on it (KiCad keeps its markers too)
const last: { doc: KDoc | null; markers: Marker[]; ran: boolean; elapsed: number } = { doc: null, markers: [], ran: false, elapsed: 0 };
const prefs = { refill: true, parity: true, errors: true, warnings: true, exclusions: false };

/** One DRC run as DIALOG_DRC lists it: the board checks, then schematic parity when asked and the schematic can be read. */
async function collectMarkers(doc: KDoc, parity: boolean): Promise<{ markers: Marker[]; parityError: string }> {
  const s = settings();
  let markers = PT().drc(doc, s); let parityError = parity ? "" : "not requested";
  if (parity) {
    const res = await projectNetlist();
    if ("error" in res) parityError = res.error;
    else {
      for (const p of NL().schematicParity(doc, res.netlist)) {
        const sev = s.severities[p.code] || (DRC_ITEMS.find((i) => i[1] === p.code) || ["", "", "warning"])[2];
        if (sev !== "ignore") markers.push({ ...p, severity: sev });
      }
    }
  }
  markers = markers.map((m) => (m.text.startsWith(drcItemTitle(m.code)) || !DRC_ITEMS.some((i) => i[1] === m.code) ? m : { ...m, text: `${drcItemTitle(m.code)}: ${m.text}` }));
  return { markers, parityError };
}

/**
 * The Design Rules Checker's result as data, for callers that have no dialog (a plugin running `kicad-cli pcb drc`):
 * each marker with the tab it belongs to and a description of every item it names.
 */
export async function drcReport(o: { parity?: boolean; text?: string } = {}): Promise<{ markers: (Marker & { group: "violation" | "unconnected" | "parity"; items: { id: string; description: string }[] })[]; parityError: string } | null> {
  // `text` is another board file's contents (a copy or a candidate a plugin wrote): it is checked instead of the open board, under the open project's rules.
  const doc = typeof o.text === "string" && o.text ? (KiCadCanvas.parseDoc as (t: string, k: string) => KDoc)(o.text, "kicad_pcb") : board(); if (!doc) return null;
  const r = await collectMarkers(doc, o.parity !== false);
  return { parityError: r.parityError, markers: r.markers.map((m) => ({ ...m, group: UNCONNECTED.has(m.code) ? "unconnected" as const : PARITY.has(m.code) ? "parity" as const : "violation" as const,
    items: m.ids.map((id) => ({ id, description: describeItem(doc, id) })) })) };
}

export function openDrc(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("The Design Rules Checker needs a board"); return; }
  if (last.doc !== doc) { last.doc = doc; last.markers = []; last.ran = false; }
  let selected: Marker | null = null, book: ReturnType<typeof notebook> | null = null;
  const lists: HTMLElement[] = [h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" })];
  const status = h("span", { class: "pd-status" });
  const badge = { errors: h("span", { class: "pd-badge" }, "0"), warnings: h("span", { class: "pd-badge" }, "0"), exclusions: h("span", { class: "pd-badge" }, "0") };
  const tabOf = (m: Marker): number => (UNCONNECTED.has(m.code) ? 1 : PARITY.has(m.code) ? 2 : 0);
  const shown = (m: Marker): boolean => (m.severity === "error" ? prefs.errors : prefs.warnings);
  const show = (): void => { PT().state.markers = last.markers.filter(shown); ctx.requestRender(); };
  const select = (m: Marker, row: HTMLElement): void => {
    selected = m;
    for (const l of lists) for (const r of Array.from(l.querySelectorAll(".it.sel"))) r.classList.remove("sel");
    row.classList.add("sel");
    ctx.setHighlight(m.ids.length ? new Set(m.ids) : null);
    if (m.ids.length || m.x || m.y) fitBox([m.x - 12, m.y - 9, m.x + 12, m.y + 9], 0.9);   // "Center on Cross-probe"
    ctx.requestRender();
  };
  const fill = (): void => {
    const sev = settings().severities;
    const counts = [0, 0, 0];
    for (const l of lists) l.replaceChildren();
    for (const m of last.markers) {
      const t = tabOf(m); counts[t]++;
      if (!shown(m)) continue;
      const row = h("div", { class: "it", "data-code": m.code }, h("span", { class: "pd-sev " + m.severity }), h("div", null, h("div", null, m.text),
        ...m.ids.map((id) => h("div", { class: "sub" }, describeItem(doc, id)))));
      row.addEventListener("click", () => select(m, row));
      lists[t].append(row);
    }
    if (!last.ran) for (const l of lists.slice(0, 3)) l.append(h("div", { class: "pd-empty" }, "DRC has not been run."));
    // ignored tests: the rules the project's severities switch off
    const ignored = DRC_ITEMS.filter((i) => i[1] && (sev[i[1]] || i[2]) === "ignore");
    for (const i of ignored) lists[3].append(h("div", { class: "it" }, h("span", { class: "pd-sev ignore" }), h("div", null, i[0])));
    if (book) { book.setLabel(0, `Violations (${last.ran ? counts[0] : "not run"})`); book.setLabel(1, `Unconnected Items (${last.ran ? counts[1] : "not run"})`); book.setLabel(2, `Schematic Parity (${last.ran ? counts[2] : "not run"})`); book.setLabel(3, `Ignored Tests (${ignored.length})`); }
    badge.errors.textContent = String(last.markers.filter((m) => m.severity === "error").length);
    badge.warnings.textContent = String(last.markers.filter((m) => m.severity !== "error").length);
  };
  const run = async (): Promise<void> => {
    const t0 = Date.now();
    // DRC_TOOL::RunTests: "Refilling all zones..." and ZONE_FILLER_TOOL::FillAllZones into the dialog's reporter
    if (prefs.refill && !ctx.viewOnly && [...doc.items.values()].some((it) => it.kind === "zone")) {
      status.textContent = "Refilling all zones...";
      await runZoneFill(ctx, { ids: [...doc.items.values()].filter((it) => it.kind === "zone").map((it) => it.id), status, label: "Fill Zone(s)" });
    }
    status.textContent = "Tests Running...";
    const markers = (await collectMarkers(doc, prefs.parity)).markers;
    last.markers = markers; last.ran = true; last.elapsed = (Date.now() - t0) / 1000; selected = null;
    status.textContent = `Done. Completed in ${last.elapsed.toFixed(2)} s`;
    ctx.setHighlight(null); fill(); show();
  };
  const report = (): string => {
    const lines = ["** Drc report for " + ((E.kdoc as KDoc & { fileName?: string }).fileName || "board") + " **", `** Created on ${new Date().toISOString().replace("T", " ").slice(0, 19)} **`, ""];
    const sect = (title: string, tab: number): void => {
      const list = last.markers.filter((m) => tabOf(m) === tab && shown(m));
      lines.push(`** Found ${list.length} ${title} **`);
      for (const m of list) { lines.push(`[${m.code}]: ${m.text}`, `    @(${m.x.toFixed(4)} mm, ${m.y.toFixed(4)} mm): ${m.severity}`); for (const id of m.ids) lines.push("    " + describeItem(doc, id)); }
      lines.push("");
    };
    sect("DRC violations", 0); sect("unconnected pads", 1); sect("Footprint errors", 2);
    lines.push("** End of Report **", "");
    return lines.join("\n");
  };
  const delMarker = (): void => { if (!selected) return; last.markers = last.markers.filter((m) => m !== selected); selected = null; ctx.setHighlight(null); fill(); show(); };
  const delAll = (): void => { last.markers = []; last.ran = false; selected = null; ctx.setHighlight(null); fill(); show(); };

  openDialog({ title: "Design Rules Checker", width: 760, okLabel: "Run DRC", cancelLabel: "Close", noEnter: true,
    extra: [{ label: "Delete Marker", fn: delMarker }, { label: "Delete All Markers", fn: delAll }],
    build(body) {
      const refill = checkField(prefs.refill, "Refill all zones before performing DRC", { key: "refill", ro: ctx.viewOnly, onChange: (v) => { prefs.refill = v; } });
      const parity = checkField(prefs.parity, "Test for parity between PCB and schematic", { key: "parity", onChange: (v) => { prefs.parity = v; } });
      book = notebook([{ label: "Violations", build: (el) => el.append(lists[0]) }, { label: "Unconnected Items", build: (el) => el.append(lists[1]) }, { label: "Schematic Parity", build: (el) => el.append(lists[2]) }, { label: "Ignored Tests", build: (el) => el.append(lists[3]) }]);
      const all = checkField(prefs.errors && prefs.warnings, "All", { key: "showAll", onChange: (v) => { prefs.errors = prefs.warnings = v; errors.set(v); warnings.set(v); fill(); show(); } });
      const sync = (): void => { all.set(prefs.errors && prefs.warnings); fill(); show(); };
      const errors = checkField(prefs.errors, "Errors", { key: "showErrors", onChange: (v) => { prefs.errors = v; sync(); } });
      const warnings = checkField(prefs.warnings, "Warnings", { key: "showWarnings", onChange: (v) => { prefs.warnings = v; sync(); } });
      const exclusions = checkField(prefs.exclusions, "Exclusions", { key: "showExclusions", ro: true, tip: "Marker exclusions are kept by the desktop application." });
      const save = h("button", { type: "button" }, "Save...");
      save.addEventListener("click", () => download("DRC.rpt", report()));
      body.append(h("div", { class: "pd-row" }, refill.el, parity.el, h("span", { style: "flex:1" }), status), book.el,
        h("div", { class: "pd-row pd-showrow" }, h("label", null, "Show:"), all.el, errors.el, badge.errors, warnings.el, badge.warnings, exclusions.el, badge.exclusions, h("span", { style: "flex:1" }), save));
      fill(); show();
    },
    ok() { void run(); return false; },
    cancel() { ctx.setHighlight(null); } });
}

/** Inspect > Clear DRC Markers. */
export function clearDrcMarkers(ctx: ToolCtx): void { last.markers = []; last.ran = false; PT().state.markers = []; ctx.requestRender(); }

// ---------------------------------------------------------------- Board Statistics
export function openBoardStatistics(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("Board Statistics needs a board"); return; }
  const s = PT().boardStatistics(doc), set = settings();
  // drill table: pads and vias by hole size
  const drills = new Map<string, { count: number; shape: string; x: number; y: number; plated: string; kind: string }>();
  const addDrill = (x: number, y: number, plated: boolean, kind: string): void => {
    const key = `${x}|${y}|${plated}|${kind}`; const d = drills.get(key);
    if (d) d.count++; else drills.set(key, { count: 1, shape: x === y ? "Round" : "Slot", x, y, plated: plated ? "PTH" : "NPTH", kind });
  };
  let minTrack = Infinity, minDrill = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") for (const p of KiCadCanvas.kids(it.node, "pad") as SNode[]) {
      const d = KiCadCanvas.kid(p, "drill") as SNode | null; if (!d) continue;
      const nums = d.slice(1).filter((v): v is number => typeof v === "number"); if (!nums.length) continue;
      addDrill(nums[0], nums.length > 1 && d.includes("oval") ? nums[1] : nums[0], String(p[2]) !== "np_thru_hole", "Pad"); minDrill = Math.min(minDrill, nums[0]);
    } else if (it.kind === "via") { const d = Number(((KiCadCanvas.kid(it.node, "drill") as SNode | null) || [])[1]) || 0; if (d) { addDrill(d, d, true, "Via"); minDrill = Math.min(minDrill, d); } }
    else if (it.kind === "segment" || it.kind === "arc") { const w = Number(((KiCadCanvas.kid(it.node, "width") as SNode | null) || [])[1]) || 0; if (w) minTrack = Math.min(minTrack, w); }
  }
  const tbl = (title: string, rows: [string, string | number][]): HTMLElement => {
    const t = h("table", { class: "pd-stat" }); t.append(h("tr", null, h("th", { colspan: "2" }, title)));
    for (const [k, v] of rows) t.append(h("tr", null, h("td", null, k), h("td", { class: "n" }, String(v))));
    return t;
  };
  const comp = h("table", { class: "pd-stat" });
  comp.append(h("tr", null, h("th", null, "Components"), h("th", null, "Front Side"), h("th", null, "Back Side"), h("th", null, "Total")));
  const sideCount = (pred: (toks: string[]) => boolean): [number, number] => { let f = 0, b = 0; for (const it of doc.items.values()) { if (it.kind !== "footprint") continue; const a = KiCadCanvas.kid(it.node, "attr") as SNode | null; if (!pred(a ? a.slice(1).map(String) : [])) continue; if (it.layer === "B.Cu") b++; else f++; } return [f, b]; };
  for (const [label, pred] of [["THT:", (t: string[]) => t.includes("through_hole")], ["SMD:", (t: string[]) => t.includes("smd")], ["Unspecified:", (t: string[]) => !t.includes("smd") && !t.includes("through_hole")]] as [string, (t: string[]) => boolean][]) {
    const [f, b] = sideCount(pred); comp.append(h("tr", null, h("td", null, label), h("td", { class: "n" }, String(f)), h("td", { class: "n" }, String(b)), h("td", { class: "n" }, String(f + b))));
  }
  comp.append(h("tr", { class: "total" }, h("td", null, "Total:"), h("td", { class: "n" }, String(s.footprints.front)), h("td", { class: "n" }, String(s.footprints.back)), h("td", { class: "n" }, String(s.footprints.total))));
  const drillRows: Record<string, CellValue>[] = Array.from(drills.values()).sort((a, b) => a.x - b.x || a.y - b.y).map((d) => ({ count: d.count, shape: d.shape, x: d.x, y: d.y, plated: d.plated, kind: d.kind, start: "F.Cu", stop: "B.Cu" }));
  const reportText = (): string => [
    "PCB statistics report", `Date: ${new Date().toISOString().replace("T", " ").slice(0, 19)}`, "", "Board", `- Width: ${fmtLenU(s.width)}`, `- Height: ${fmtLenU(s.height)}`, `- Area: ${s.area.toFixed(4)} mm²`, "",
    "Pads", `- Through hole: ${s.pads.tht}`, `- SMD: ${s.pads.smd}`, `- Connector: ${s.pads.connect}`, `- NPTH: ${s.pads.npth}`, "", "Vias", `- Through vias: ${s.vias.through}`, `- Blind/buried: ${s.vias.blind}`, `- Micro vias: ${s.vias.micro}`, "",
    "Components", `- Front: ${s.footprints.front}`, `- Back: ${s.footprints.back}`, `- Total: ${s.footprints.total}`, "", "Drill holes", ...drillRows.map((d) => `- ${d.count} × ${d.shape} ${d.x} x ${d.y} mm ${d.plated} ${d.kind}`), ""].join("\n");
  openDialog({ title: "Board Statistics", width: 720, noOk: true, extra: [{ label: "Generate Report File...", fn: () => download("board-statistics.txt", reportText()) }],
    build(body) {
      const general = h("div", { class: "pd-cols2" },
        h("div", null, comp, tbl("Pads", [["Through hole:", s.pads.tht], ["SMD:", s.pads.smd], ["Connector:", s.pads.connect], ["NPTH:", s.pads.npth], ["Total:", s.pads.total]])),
        h("div", null,
          tbl("Board", [["Dimensions:", s.width && s.height ? `${fmtLenU(s.width)} x ${fmtLenU(s.height)}` : "unknown"], ["Area:", s.area ? `${s.area.toFixed(4)} mm²` : "unknown"],
            ["Min track clearance:", fmtLenU(Math.min(...Object.values(set.netclasses).map((n) => n.clearance ?? set.clearance), set.clearance))], ["Min track width:", isFinite(minTrack) ? fmtLenU(minTrack) : "N/A"], ["Min drill diameter:", isFinite(minDrill) ? fmtLenU(minDrill) : "N/A"]]),
          tbl("Vias", [["Through vias:", s.vias.through], ["Blind/buried vias:", s.vias.blind], ["Micro vias:", s.vias.micro], ["Total:", s.vias.total]])));
      const book = notebook([{ label: "General", build: (el) => el.append(general) },
        { label: "Drill Holes", build: (el) => el.append(grid([{ label: "Count", key: "count" }, { label: "Shape", key: "shape" }, { label: "X Size", key: "x", type: "len" }, { label: "Y Size", key: "y", type: "len" }, { label: "Plated", key: "plated" }, { label: "Via/Pad", key: "kind" }, { label: "Start Layer", key: "start" }, { label: "Stop Layer", key: "stop" }], drillRows, { ro: true, height: "320px" }).el) }]);
      body.append(book.el);
    } });
}

// ---------------------------------------------------------------- Net Inspector
export function openNetInspector(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("The Net Inspector needs a board"); return; }
  const all = PT().netInspector(doc), set = settings();
  const classOf = (name: string): string => { const nc = PT().netclassOf(set, name); for (const [k, v] of Object.entries(set.netclasses)) if (v === nc) return k; return "Default"; };
  const host = h("div");
  let filter = "";
  const draw = (): void => {
    const rows = all.filter((r) => !filter || r.name.toLowerCase().includes(filter));
    const cells: Record<string, CellValue>[] = rows.map((r) => ({ name: r.name || "<no net>", netclass: classOf(r.name), pads: r.padCount, vias: r.viaCount, track: r.trackLength, total: r.trackLength, unconnected: r.unconnected, key: r.name }));
    host.replaceChildren(grid([{ label: "Name", key: "name" }, { label: "Netclass", key: "netclass", width: "110px" }, { label: "Pad Count", key: "pads", width: "80px" }, { label: "Via Count", key: "vias", width: "80px" },
      { label: "Track Length", key: "track", type: "len", width: "110px" }, { label: "Total Length", key: "total", type: "len", width: "110px" }, { label: "Unconnected", key: "unconnected", width: "90px" }], cells,
    { ro: true, height: "440px", onSelect: (i) => { const r = rows[i]; if (r) { ctx.setHighlight(PT().netItemIds(doc, r.name)); ctx.requestRender(); } } }).el);
  };
  openDialog({ title: "Net Inspector", width: 820, noOk: true,
    build(body) {
      const search = textField("", { placeholder: "Filter", key: "netFilter" });
      search.input.addEventListener("input", () => { filter = search.get().trim().toLowerCase(); draw(); });
      draw(); body.append(h("div", { class: "pd-row" }, search.el, h("span", { class: "pd-note" }, `${all.length} nets — select a row to highlight the net on the board`)), host);
    },
    cancel() { ctx.setHighlight(null); } });
}

// ---------------------------------------------------------------- Clearance Resolution
export function openClearance(ctx: ToolCtx): void {
  const doc = board(); if (!doc) return;
  const ids = Array.from(PT().selectionIds(ctx));   // the editor's selection and the board module's (tracks, vias, graphics)
  if (ids.length !== 2) { ctx.toast("Select two items for a clearance resolution report."); return; }
  const set = settings(), r = PT().inspectClearance(doc, ids[0], ids[1], set);
  if (!r) { ctx.toast("Both items need copper"); return; }
  const a = describeItem(doc, ids[0]), b = describeItem(doc, ids[1]);
  const ncName = (net: string): string => { const nc = PT().netclassOf(set, net); for (const [k, v] of Object.entries(set.netclasses)) if (v === nc) return k; return "Default"; };
  const lines: (string | [string, string])[] = [["h", "Clearance resolution for:"], ["li", a], ["li", b], ""];
  if (r.sameNet) lines.push(`Items belong to the same net ('${r.nets[0]}'). Min clearance is 0.`);
  else {
    for (const [i, net] of r.nets.entries()) lines.push(`Checking netclass '${ncName(net)}' clearance for ${i ? b : a}: ${fmtLenU(PT().netclassOf(set, net).clearance ?? set.clearance)}.`);
    lines.push("", `Resolved min clearance: ${fmtLenU(r.required)}.`, r.gap === null ? "The items share no copper layer." : `Actual clearance: ${fmtLenU(r.gap)}${r.gap < r.required - 1e-6 ? "  (violation)" : ""}.`);
  }
  openDialog({ title: "Clearance Report", width: 600, noOk: true,
    build(body) {
      const rep = h("div", { class: "pd-report", style: "min-height:220px" });
      for (const l of lines) rep.append(Array.isArray(l) ? h("div", { class: l[0] === "h" ? "ln hd" : "ln li" }, (l[0] === "li" ? "• " : "") + l[1]) : h("div", { class: "ln" }, l || " "));
      body.append(notebook([{ label: "Clearance", build: (el) => el.append(rep) }]).el);
    } });
}
