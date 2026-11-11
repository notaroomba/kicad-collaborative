// dialogs/assign-footprints.ts — Tools → Assign Footprints… (KiCad's CvPcb, cvpcb/cvpcb_mainframe.cpp): the symbol
// list in the middle (number, reference, value : footprint), the footprint libraries on the left and the filtered
// footprints on the right.  The Footprint field of each symbol is free text; the library panes appear when the server
// offers the official libraries (GET /api/libs/footprints, /api/libs/footprints/{lib}) and stay empty otherwise.
// A double-click on a footprint assigns it to the selected symbol and moves to the next one, as CvPcb does.
import { E, appState, toast, toolCtx } from "./editor";
import { KD, checkbox, h, textInput } from "./dom";
import { libPins, refCmp, str, symbolRows, type SymRow } from "./logic";
import { projectDocs, readDoc, submitDocOp } from "./project";

interface Member { docId: string; id: string }
interface Row extends SymRow { members: Member[]; fp: string; orig: string; pins: number; filters: string }
interface FpLib { name: string; description?: string }
interface FpEntry { n: string; d?: string; k?: string; p?: number }
const S = appState;
async function getJson<T>(url: string): Promise<T | null> { try { const r = await fetch(url); if (!r.ok) return null; return (await r.json()) as T; } catch (e) { return null; } }

export function openAssignFootprints(): void {
  if (!E.kdoc) return;
  const ro = !!E.viewOnly, here = S.docId || "", docs = new Map<string, KDoc>([[here, E.kdoc as KDoc]]);
  let rows: Row[] = [], sel = 0, libs: FpLib[] = [], curLib = "", entries: FpEntry[] = [], filterText = "", byPins = false, byLib = true;
  const index = new Map<string, FpEntry[]>();
  let symHost: HTMLElement | null = null, libHost: HTMLElement | null = null, fpHost: HTMLElement | null = null, statusEl: HTMLElement | null = null;
  const build = () => {
    const byRef = new Map<string, Row>(); rows = [];
    for (const [docId, d] of docs) for (const r of symbolRows(d, docId, !ro)) {
      const members = r.ids.map((id) => ({ docId, id })); const prev = r.ref && !/\?$/.test(r.ref) ? byRef.get(r.ref) : undefined; if (prev) { prev.members.push(...members); continue; }
      const it = d.items.get(r.id)!; const lid = KiCadCanvas.kid(it.node, "lib_name") || KiCadCanvas.kid(it.node, "lib_id"); const lib = lid ? KiCadCanvas.resolveLib(d, str(lid[1])) : null;
      const old = rows.find((x) => x.members[0].docId === docId && x.id === r.id);
      const row: Row = Object.assign(r, { members, fp: old ? old.fp : str(r.values.Footprint), orig: str(r.values.Footprint), pins: new Set(libPins(lib).map((p) => p.number)).size, filters: str(r.values.ki_fp_filters) });
      rows.push(row); if (r.ref) byRef.set(r.ref, row);
    }
    rows.sort((a, b) => refCmp(a.ref, b.ref));
  };
  const status = () => { if (!statusEl) return; const r = rows[sel]; const un = rows.filter((x) => !x.fp).length;
    statusEl.textContent = (r ? `${r.ref}: ${r.values.Value || ""}${r.pins ? `   Pin count: ${r.pins}` : ""}   ` : "") + `Unassigned: ${un} of ${rows.length}` + (libs.length ? "" : "   (no footprint libraries on this server: type the footprint as Library:Name)"); };
  const renderSyms = () => {
    if (!symHost) return; symHost.replaceChildren();
    rows.forEach((r, i) => {
      const inp = textInput(r.fp, (v) => { r.fp = v.trim(); status(); }, { disabled: ro || !r.editable, placeholder: "Library:Footprint" }); inp.dataset.row = String(i);
      inp.addEventListener("focus", () => { if (sel !== i) { sel = i; mark(); } });
      const tr = h("tr", { class: i === sel ? "sel" : "" }, h("td", { class: "ro", style: "width:34px;text-align:right" }, String(i + 1)), h("td", { class: "ro", style: "width:70px" }, r.ref), h("td", { class: "ro", style: "width:150px" }, str(r.values.Value)), h("td", null, inp));
      tr.addEventListener("pointerdown", () => { if (sel !== i) { sel = i; mark(); } });
      symHost!.append(tr);
    });
    status();
  };
  const mark = () => { if (symHost) [...symHost.children].forEach((tr, j) => tr.classList.toggle("sel", j === sel)); status(); renderFps(); const r = rows[sel]; if (r) { const ids = r.members.filter((m) => m.docId === here).map((m) => m.id); if (ids.length) { try { toolCtx().setSelection(ids); } catch (e) { /* cross-probe is best effort */ } } } };
  const assign = (fpid: string) => { const r = rows[sel]; if (!r || ro) return; r.fp = fpid; if (sel < rows.length - 1) sel++; renderSyms(); const tr = symHost && symHost.children[sel] as HTMLElement | undefined; if (tr) tr.scrollIntoView({ block: "nearest" }); renderFps(); };
  const renderLibs = () => { if (!libHost) return; libHost.replaceChildren(...libs.map((l) => { const d = h("div", { class: "kd-tb-node" + (l.name === curLib ? " on" : ""), title: l.description || "", style: "cursor:pointer" }, l.name); d.addEventListener("click", () => { void pickLib(l.name); }); return d; })); };
  const renderFps = () => {
    if (!fpHost) return; const r = rows[sel]; const q = filterText.trim().toLowerCase();
    let list: { lib: string; e: FpEntry }[] = [];
    if (byLib && curLib) list = entries.map((e) => ({ lib: curLib, e })); else if (!byLib || q) for (const [lib, es] of index) for (const e of es) list.push({ lib, e });
    if (q) list = list.filter((x) => q.split(/\s+/).every((t) => (x.lib + ":" + x.e.n + " " + (x.e.k || "") + " " + (x.e.d || "")).toLowerCase().includes(t)));
    if (byPins && r && r.pins) list = list.filter((x) => x.e.p === undefined || x.e.p === r.pins);
    const shown = list.slice(0, 400);
    fpHost.replaceChildren(...shown.map((x, i) => { const id = `${x.lib}:${x.e.n}`; const d = h("div", { class: "kd-tb-node", title: x.e.d || "", style: "cursor:pointer" }, `${i + 1}  ${id}`); d.dataset.fpid = id; d.addEventListener("dblclick", () => assign(id)); d.addEventListener("click", () => { [...fpHost!.children].forEach((c) => c.classList.remove("on")); d.classList.add("on"); }); return d; }));
    if (!shown.length) fpHost.append(h("div", { class: "kd-note", style: "padding:8px" }, libs.length ? (curLib || q ? "No footprints match." : "Select a library or type a filter.") : "Footprint libraries are not available on this server."));
    else if (list.length > shown.length) fpHost.append(h("div", { class: "kd-note", style: "padding:8px" }, `… ${list.length - shown.length} more; narrow the filter.`));
  };
  const pickLib = async (name: string) => { curLib = name; renderLibs(); if (!index.has(name)) { const j = await getJson<{ footprints?: FpEntry[] }>(`/api/libs/footprints/${encodeURIComponent(name)}`); index.set(name, j && Array.isArray(j.footprints) ? j.footprints : []); } entries = index.get(name) || []; renderFps(); };
  const apply = async (): Promise<boolean> => {
    if (ro) return true;
    const sch = CollabTools.sch as SchToolModule & { fieldsTableChanges(doc: KDoc, edits: { id: string; values: Record<string, string> }[]): KChange[] };
    const byDoc = new Map<string, { id: string; values: Record<string, string> }[]>();
    for (const r of rows) if (r.fp !== r.orig) for (const m of r.members) { const l = byDoc.get(m.docId) || []; l.push({ id: m.id, values: { Footprint: r.fp } }); byDoc.set(m.docId, l); }
    let n = 0;
    try { for (const [docId, edits] of byDoc) { const d = docs.get(docId); if (!d) continue; const ch = sch.fieldsTableChanges(d, edits); if (!ch.length) continue; n += ch.length; if (docId === here) toolCtx().commit(ch, "assign footprints"); else { await submitDocOp(docId, ch); docs.set(docId, await readDoc(docId, "kicad_sch")); } } }
    catch (e) { toast("Could not assign the footprints: " + (e as Error).message, 4000); return false; }
    for (const r of rows) r.orig = r.fp;
    toast(n ? `Assigned footprints to ${n} symbol${n === 1 ? "" : "s"}` : "No footprint changes");
    return true;
  };
  build();
  KD().open({ title: "Assign Footprints", width: 1100, cls: "kd-wide", readOnly: ro,
    extra: ro ? [] : [{ label: "Apply, Save Schematic & Continue", fn: () => { void apply(); } }],
    build(body) {
      const filter = textInput("", (v) => { filterText = v; renderFps(); }, { id: "kd-af-filter", placeholder: "Filter", style: "width:220px" });
      body.append(h("div", { class: "kd-row", style: "margin-bottom:8px;gap:16px" }, h("span", { style: "color:var(--ink-2)" }, "Footprint Filters:"),
        checkbox("Filter by pin count", byPins, (on) => { byPins = on; renderFps(); }, { id: "kd-af-pins", title: "Filter footprint list by pin count" }),
        checkbox("Filter by library", byLib, (on) => { byLib = on; renderFps(); }, { id: "kd-af-lib", title: "Filter footprint list by library" }), filter));
      libHost = h("div", { id: "kd-af-libs", style: "overflow:auto;height:52vh;border:1px solid var(--line);background:var(--panel)" });
      const symTable = h("table", { class: "kd-grid" }, h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Reference"), h("th", null, "Value"), h("th", null, "Footprint"))), (symHost = h("tbody", { id: "kd-af-syms" })));
      fpHost = h("div", { id: "kd-af-fps", style: "overflow:auto;height:52vh;border:1px solid var(--line);background:var(--panel)" });
      const col = (title: string, el: HTMLElement) => h("div", { style: "min-width:0" }, h("div", { style: "font-weight:600;margin-bottom:4px" }, title), el);
      body.append(h("div", { style: "display:grid;grid-template-columns:200px 1fr 300px;gap:10px" }, col("Footprint Libraries", libHost), col("Symbol : Footprint Assignments", h("div", { class: "kd-grid-wrap", style: "height:52vh" }, symTable)), col("Filtered Footprints", fpHost)),
        (statusEl = h("div", { id: "kd-af-status", style: "margin-top:8px;color:var(--ink-2);min-height:16px" })));
      renderSyms(); renderFps();
    },
    ok() { void apply(); } });
  void getJson<{ libraries?: FpLib[] }>("/api/libs/footprints").then((j) => { libs = j && Array.isArray(j.libraries) ? j.libraries.filter((l) => l && typeof l.name === "string") : []; if (!KD().isOpen()) return; renderLibs(); renderFps(); status();
    const r = rows[sel], lib = r && r.fp.includes(":") ? r.fp.split(":")[0] : ""; if (lib && libs.some((l) => l.name === lib)) void pickLib(lib); });
  const others = projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here);
  if (others.length) void Promise.all(others.map((d) => readDoc(d.docId, "kicad_sch").then((od) => { docs.set(d.docId, od); }, () => { /* left out */ }))).then(() => { if (KD().isOpen()) { build(); renderSyms(); } });
}
