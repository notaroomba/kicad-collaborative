// dialogs/find.ts — Edit → Find (Ctrl+F) and Find and Replace (Ctrl+Alt+F): eeschema/dialogs/dialog_sch_find.cpp.
// A modeless dialog: Find walks the hits (left to right, top to bottom, then on to the project's other sheets unless
// "Search the current sheet only" is ticked), selecting and centring each; Replace / Replace All edit references
// (when allowed), values, fields, labels and text as ordinary collab changes.
import { E, appState, applyView, centerOn, openDocId, pushUndoFor, toolCtx, cloneNode } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { findHits, replaceInNode, str, type FindHit, type FindOpts } from "./logic";
import { projectDocs, readDoc, submitDocOp } from "./project";

interface FindState extends FindOpts { replacement: string; backward: boolean; currentSheetOnly: boolean }
const F: FindState = { query: "", replacement: "", backward: false, matchCase: false, wholeWord: false, regex: false, pins: false, hiddenFields: false, currentSheetOnly: false, selectionOnly: false, replaceRefs: false, netNames: false };
let last: { docId: string | null; key: string } | null = null;   // the hit the cursor sits on
let api: DlgApi | null = null, statusEl: HTMLElement | null = null;
const otherDocs = new Map<string, KDoc>();
const resolveLib = (d: Pick<KDoc, "items" | "lib">, name: string) => KiCadCanvas.resolveLib(d as KDoc, name);
const keyOf = (hit: FindHit) => `${hit.id}\u0000${hit.what}\u0000${hit.field || ""}`;
const S = appState;
function setStatus(text: string, bad = false): void { if (statusEl) { statusEl.textContent = text; statusEl.style.color = bad ? "var(--err)" : "var(--ink-2)"; } }
function hitsHere(): FindHit[] { return E.kdoc ? findHits(E.kdoc, F, F.selectionOnly ? new Set<string>(E.selection) : null, resolveLib) : []; }
function describe(hit: FindHit): string { const it = E.kdoc && E.kdoc.items.get(hit.id); const ref = it && it.ref ? it.ref + " " : ""; return `${ref}${hit.what}: ${hit.text}`; }

function focusHit(hit: FindHit): void {
  const ctx = toolCtx(); ctx.setSelection([hit.id]);
  if (E.zoom < 2) { E.zoom = 3; E.viewTouched = true; applyView(); }
  centerOn(hit.x, hit.y);
}
async function otherSheetWithHits(dir: 1 | -1): Promise<{ docId: string; hits: FindHit[] } | null> {
  const sheets = projectDocs().filter((d) => d.docType === "kicad_sch"); const i = sheets.findIndex((d) => d.docId === S.docId); if (sheets.length < 2) return null;
  for (let k = 1; k < sheets.length; k++) {
    const d = sheets[((i + dir * k) % sheets.length + sheets.length) % sheets.length];
    let od = otherDocs.get(d.docId); if (!od) { try { od = await readDoc(d.docId, "kicad_sch"); otherDocs.set(d.docId, od); } catch (e) { continue; } }
    const hits = findHits(od, F, null, resolveLib); if (hits.length) return { docId: d.docId, hits };
  }
  return null;
}
function whenDocOpen(docId: string): Promise<boolean> {
  return new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (S.docId === docId && E.kdoc && E.kdoc.items.size) resolve(true); else if (Date.now() - t0 > 8000) resolve(false); else setTimeout(tick, 100); }; tick(); });
}
export async function findNext(reverse = false): Promise<FindHit | null> {
  if (!F.query) { setStatus(""); return null; }
  const dir: 1 | -1 = F.backward !== reverse ? -1 : 1, hits = hitsHere();
  let i = last && last.docId === S.docId ? hits.findIndex((x) => keyOf(x) === last!.key) : -1;
  let next = i < 0 ? (dir > 0 ? 0 : hits.length - 1) : i + dir;
  if (next < 0 || next >= hits.length) {
    if (!F.currentSheetOnly && !F.selectionOnly) {
      setStatus("Searching other sheets…");
      const o = await otherSheetWithHits(dir);
      if (o) { openDocId(o.docId); if (await whenDocOpen(o.docId)) { const hs = hitsHere(); const hit = hs[dir > 0 ? 0 : hs.length - 1]; if (hit) { last = { docId: S.docId, key: keyOf(hit) }; focusHit(hit); setStatus(`${describe(hit)}  (${dir > 0 ? 1 : hs.length} of ${hs.length} on this sheet)`); return hit; } } }
    }
    if (!hits.length) { last = null; setStatus(`'${F.query}' not found`, true); return null; }
    next = dir > 0 ? 0 : hits.length - 1;   // wrap around, as KiCad does after "Reached end of schematic"
  }
  const hit = hits[next]; last = { docId: S.docId, key: keyOf(hit) }; focusHit(hit);
  setStatus(`${describe(hit)}  (${next + 1} of ${hits.length} on this sheet)`);
  return hit;
}
/** MODIFIED changes replacing every replaceable hit of `hits` on `doc`. */
function replaceChanges(doc: KDoc, hits: FindHit[]): KChange[] {
  const byItem = new Map<string, FindHit[]>(); for (const x of hits) if (x.replaceable) { const l = byItem.get(x.id); if (l) l.push(x); else byItem.set(x.id, [x]); }
  const out: KChange[] = []; const setRef = CollabTools.sch && (CollabTools.sch._.setReference as ((n: SNode, r: string) => void) | undefined);
  for (const [id, list] of byItem) {
    const it = doc.items.get(id); if (!it) continue; const node = cloneNode(it.node) as SNode; let any = false;
    for (const x of list) if (replaceInNode(node, x, F, F.replacement)) { any = true; if (x.field === "Reference" && it.kind === "symbol" && setRef) { const p = KiCadCanvas.kids(node, "property").find((q) => str(q[1]) === "Reference"); if (p) setRef(node, str(p[2])); } }
    if (any) out.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null })));
  }
  return out;
}
export async function replaceOne(): Promise<void> {
  if (E.viewOnly) { setStatus("View-only access", true); return; }
  const hits = hitsHere(); let cur = last && last.docId === S.docId ? hits.find((x) => keyOf(x) === last!.key) : undefined;
  if (!cur || !cur.replaceable) { const n = await findNext(); if (!n) return; if (!n.replaceable) { setStatus(`${describe(n)} cannot be replaced`, true); } return; }
  const ch = E.kdoc ? replaceChanges(E.kdoc, [cur]) : []; if (ch.length) toolCtx().commit(ch, "replace");
  await findNext();
}
export async function replaceAll(): Promise<void> {
  if (E.viewOnly) { setStatus("View-only access", true); return; }
  const here = E.kdoc ? replaceChanges(E.kdoc, hitsHere()) : []; if (here.length) toolCtx().commit(here, "replace all");
  let total = here.length, sheets = here.length ? 1 : 0;
  if (!F.currentSheetOnly && !F.selectionOnly) {
    for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== S.docId)) {
      try { const od = await readDoc(d.docId, "kicad_sch"); otherDocs.delete(d.docId); const ch = replaceChanges(od, findHits(od, F, null, resolveLib)); if (ch.length) {
          // the step is undoable on that sheet: its Ctrl+Z puts the texts back (KiCad undoes all sheets at once; here each sheet has its own list)
          const inverse = ch.map((c) => { const it = od.items.get(c.id); return it ? KiCadCanvas.replaceChange(od, it) : null; }).filter(Boolean) as KChange[];
          await submitDocOp(d.docId, ch); pushUndoFor(d.docId, { label: "replace all", changes: ch, inverse }); total += ch.length; sheets++;
        } }
      catch (e) { setStatus(`Could not replace in ${d.path}: ${(e as Error).message}`, true); return; }
    }
  }
  last = null; setStatus(total ? `Replaced matches in ${total} item${total === 1 ? "" : "s"}${sheets > 1 ? ` on ${sheets} sheets` : ""}` : `'${F.query}' not found`, !total);
}

export function openFind(replace: boolean): void {
  otherDocs.clear();
  const ro = !!E.viewOnly;
  api = KD().open({ title: replace ? "Find and Replace" : "Find", width: 560, modeless: true, cls: "kd-find", buttons: [],
    build(body, a) {
      a.foot.style.display = "none";
      const q = textInput(F.query, (v) => { F.query = v; last = null; }, { id: "kd-find-q" });
      q.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); F.query = q.value; void findNext(ev.shiftKey); } });
      const rw = textInput(F.replacement, (v) => { F.replacement = v; }, { id: "kd-find-r", disabled: ro });
      const radio = (label: string, back: boolean) => { const r = h("input", { type: "radio", name: "kd-find-dir", checked: F.backward === back, id: back ? "kd-find-back" : "kd-find-fwd" }); r.addEventListener("change", () => { if ((r as HTMLInputElement).checked) F.backward = back; }); return h("label", { class: "kd-chk" }, r, label); };
      const opt = (label: string, key: keyof FindState, id: string) => checkbox(label, !!F[key], (on) => { (F as unknown as Record<string, boolean>)[key] = on; last = null; }, { id });
      const fields = h("div", { class: "kv", style: "margin-bottom:10px" }, h("label", null, "Search for:"), q);
      if (replace) fields.append(h("label", null, "Replace with:"), rw);
      const left = h("div", { style: "flex:1;min-width:0" }, fields,
        h("div", { style: "display:flex;gap:28px" },
          h("div", null, h("div", { style: "color:var(--ink-2);margin-bottom:4px" }, "Direction:"), radio("Forward", false), radio("Backward", true)),
          h("div", null, opt("Match case", "matchCase", "kd-find-case"), opt("Whole words only", "wholeWord", "kd-find-word"), opt("Regular Expression", "regex", "kd-find-regex"),
            opt("Search pin names and numbers", "pins", "kd-find-pins"), opt("Include hidden fields", "hiddenFields", "kd-find-hidden"), opt("Search the current sheet only", "currentSheetOnly", "kd-find-sheet"),
            opt("Search the current selection only", "selectionOnly", "kd-find-sel"), replace ? opt("Replace matches in reference designators", "replaceRefs", "kd-find-refs") : null, opt("Search net names", "netNames", "kd-find-nets"))));
      const btn = (label: string, id: string, fn: () => void, primary = false, disabled = false) => h("button", { class: "btn" + (primary ? " primary" : ""), type: "button", id, disabled, style: "width:104px", onclick: fn }, label);
      const right = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:none" }, btn("Find", "kd-find-next", () => { F.query = q.value; void findNext(); }, true),
        replace ? btn("Replace", "kd-find-replace", () => { F.query = q.value; F.replacement = rw.value; void replaceOne(); }, false, ro) : null,
        replace ? btn("Replace All", "kd-find-replaceall", () => { F.query = q.value; F.replacement = rw.value; void replaceAll(); }, false, ro) : null,
        btn("Close", "kd-find-close", () => a.finish(false)));
      statusEl = h("div", { id: "kd-find-status", style: "margin-top:8px;min-height:16px;color:var(--ink-2)" });
      body.append(h("div", { style: "display:flex;gap:16px" }, left, right), statusEl);
    },
    cancel() { api = null; statusEl = null; } });
}
export function findIsOpen(): boolean { return !!api && KD().isOpen(); }
