// symedit/find.ts — the Symbol Editor's Edit → Find (Ctrl+F) and Find and Replace (Ctrl+Alt+F): DIALOG_SCH_FIND as
// SYMBOL_EDIT_FRAME shows it (no sheet, pin, net name or reference options; pins are always searched) driving
// SCH_FIND_REPLACE_TOOL over the current symbol's draw items (LIB_SYMBOL::GetDrawItems: fields, pins, texts, text boxes
// of every unit and body style).  Find Next / Find Previous are F3 / Shift+F3.
import * as M from "./model";
import { KD, checkbox, h, textInput, type DlgApi } from "../dialogs/dom";
import { matcher, replaceText, type FindOpts } from "../dialogs/logic";
import type { SymbolEditor } from "./editor";
/** The editor's item id → node (editor.ts nodeOf, kept here so the search runs without the editor). */
function nodeOf(sym: M.Node, id: string): M.Node | null {
  if (id.startsWith("f:")) return M.fieldOf(sym, id.slice(2));
  const a = id.indexOf(":"), b = id.lastIndexOf(":"); if (a < 0 || b <= a) return null;
  return M.itemAt(sym, { sub: id.slice(a + 1, b), j: Number(id.slice(b + 1)) });
}

export interface SymFindOpts extends FindOpts { replacement: string; selectionOnly: boolean; searchAndReplace: boolean }
/** One searchable item: its editor id, its texts, its position (internal units: mm, Y down). */
export interface SymFindItem { id: string; kind: string; texts: string[]; x: number; y: number; visible: boolean }

const at = (n: M.Node): [number, number] => { const a = M.kidOf(n, "at"); return a ? [Number(a[1]) || 0, -(Number(a[2]) || 0)] : [0, 0]; };
/** The draw items in SCH_FIND_REPLACE_TOOL::nextMatch's order: by X, then Y (then the file order, standing in for the UUID). */
export function findItems(sym: M.Node, only?: Set<string> | null): SymFindItem[] {
  const out: SymFindItem[] = [];
  for (const p of M.kidsOf(sym, "property")) {
    const name = M.strOf(p[1]); if (name.startsWith("ki_")) continue;
    const id = "f:" + name; if (only && !only.has(id)) continue;
    const [x, y] = at(p); out.push({ id, kind: name === "Reference" ? "reference" : "field", texts: [M.strOf(p[2])], x, y, visible: !M.isHidden(p) });
  }
  for (const d of M.drawItems(sym)) {
    const k = String(d.node[0]); if (k !== "pin" && k !== "text" && k !== "text_box") continue;
    const id = (k === "pin" ? "p:" : "g:") + d.sub + ":" + d.j; if (only && !only.has(id)) continue;
    const [x, y] = k === "text_box" ? (() => { const s = M.kidOf(d.node, "start") || M.kidOf(d.node, "at"); return s ? [Number(s[1]) || 0, -(Number(s[2]) || 0)] as [number, number] : [0, 0] as [number, number]; })() : at(d.node);
    let texts: string[];
    if (k === "pin") { const nm = M.kidOf(d.node, "name"), nb = M.kidOf(d.node, "number"); texts = [nm ? M.strOf(nm[1]) : "", nb ? M.strOf(nb[1]) : ""]; }
    else texts = [M.strOf(d.node[1])];
    out.push({ id, kind: k, texts, x, y, visible: true });
  }
  return out.map((it, i) => ({ it, i })).sort((a, b) => a.it.x - b.it.x || a.it.y - b.it.y || a.i - b.i).map((e) => e.it);
}
/** SCH_FIELD / SCH_PIN / SCH_TEXT / SCH_TEXTBOX ::Matches in a library symbol.  A library symbol's Reference never matches
 *  (SCH_FIELD::Matches wants a placed symbol for it); hidden fields only with "Include hidden fields". */
export function itemMatches(it: SymFindItem, o: SymFindOpts): boolean {
  const m = matcher(o); if (!m) return false;
  if (it.kind === "reference") return false;
  if ((it.kind === "field") && !it.visible && !o.hiddenFields) return false;
  return it.texts.some((t) => m(t));
}
/** nextMatch: the first match after `after` (null: from the start), walking backward when `reversed`. */
export function nextMatch(items: SymFindItem[], after: string | null, o: SymFindOpts, reversed: boolean): SymFindItem | null {
  const list = reversed ? [...items].reverse() : items;
  let past = !after;
  for (const it of list) { if (it.id === after) past = true; else if (past && itemMatches(it, o)) return it; }
  return null;
}
/** EDA_ITEM::Replace on the item's texts, in place on its node; true when something changed. */
export function replaceIn(sym: M.Node, id: string, o: SymFindOpts): boolean {
  const n = nodeOf(sym, id); if (!n) return false;
  const rep = (holder: M.Node, k: number) => { const r = replaceText(M.strOf(holder[k]), o, o.replacement); if (r === null) return false; holder[k] = r; return true; };
  if (n[0] === "property") return rep(n, 2);
  if (n[0] === "pin") { let any = false; for (const key of ["name", "number"]) { const c = M.kidOf(n, key); if (c && rep(c, 1)) any = true; } return any; }
  return rep(n, 1);
}

// ---------------------------------------------------------------- the dialog and the tool state
const F: SymFindOpts = { query: "", replacement: "", matchCase: false, wholeWord: false, regex: false, hiddenFields: false, selectionOnly: false, pins: true, searchAndReplace: false };
let afterItem: string | null = null, lastSearch = "", api: DlgApi | null = null, statusEl: HTMLElement | null = null, backward = false;

function status(se: SymbolEditor, msg: string): void { se.infoBarMessage(msg, 2000); if (statusEl) statusEl.textContent = msg; }
/** SCH_FIND_REPLACE_TOOL::FindNext. */
export function findNext(se: SymbolEditor, reverse = false): SymFindItem | null {
  const sym = se.symbol(); const t = se.tab; if (!sym || !t) return null;
  if (!F.query) { openSymbolFind(se, F.searchAndReplace); return null; }
  if (F.query !== lastSearch) { afterItem = null; lastSearch = F.query; }
  const items = findItems(sym, F.selectionOnly ? t.sel : null); const rev = reverse !== backward;
  let item: SymFindItem | null = null, wrapped = false;
  for (let attempt = 0; attempt < 2 && !item; attempt++) {
    if (attempt === 1) { if (!afterItem) break; afterItem = null; wrapped = true; }
    item = nextMatch(items, afterItem, F, rev);
  }
  if (!item) { afterItem = null; status(se, "No matches found."); return null; }
  afterItem = item.id;
  if (!F.selectionOnly) { t.sel = new Set([item.id]); se.selChanged(); }
  const doc = se.kdoc(); const it = doc && doc.items.get(item.id); const bb = it && it.bbox;
  se.focusOn(bb ? (bb[0] + bb[2]) / 2 : item.x, bb ? (bb[1] + bb[3]) / 2 : item.y);
  if (wrapped) status(se, "Reached end of symbol."); else if (statusEl) statusEl.textContent = "";
  return item;
}
/** The match the next Replace acts on (SCH_FIND_REPLACE_TOOL::getCurrentMatch / HasMatch). */
function currentMatch(se: SymbolEditor): string | null {
  const t = se.tab; const sym = se.symbol(); if (!t || !sym) return null;
  const id = F.selectionOnly ? afterItem : [...t.sel][0] || null; if (!id) return null;
  const it = findItems(sym).find((x) => x.id === id); return it && itemMatches(it, F) ? id : null;
}
/** ReplaceAndFindNext: replace in the current match, then find the next one. */
export function replaceAndFindNext(se: SymbolEditor): void {
  if (!F.query) { openSymbolFind(se, true); return; }
  const id = currentMatch(se);
  if (id) { se.edit("Find and Replace", (s) => { if (!replaceIn(s, id, F)) return false; }); findNext(se); }
  else findNext(se);
}
/** ReplaceAll over the symbol (or the selection), one undo step. */
export function replaceAll(se: SymbolEditor): number {
  const sym = se.symbol(); const t = se.tab; if (!sym || !t || !F.query) return 0;
  let n = 0; const sel = F.selectionOnly ? new Set(t.sel) : null;
  se.edit("Find and Replace All", (s) => { for (const it of findItems(s, sel)) if (itemMatches(it, F) && replaceIn(s, it.id, F)) n++; if (!n) return false; });
  afterItem = null;
  if (!n) status(se, "No matches found.");
  return n;
}
/** SCH_BASE_FRAME::ShowFindReplaceDialog: one selected field or text seeds the search string. */
export function openSymbolFind(se: SymbolEditor, replace: boolean): void {
  const t = se.tab; const sym = se.symbol();
  let seed = "";
  if (t && sym && t.sel.size === 1) {
    const id = [...t.sel][0]; const n = id !== afterItem ? nodeOf(sym, id) : null;
    if (n && n[0] === "property") seed = M.strOf(n[2]);
    else if (n && n[0] === "text") seed = M.strOf(n[1]).split("\n")[0];
  }
  if (seed) F.query = seed;
  F.searchAndReplace = replace;
  if (api) { api.close(); api = null; }
  const ro = se.readOnly();
  api = KD().open({ title: replace ? "Find and Replace" : "Find", width: 520, modeless: true, cls: "kd-find", buttons: [],
    build(body, a) {
      a.foot.style.display = "none";
      const q = textInput(F.query, (v) => { F.query = v; }, { id: "se-find-q" });
      q.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); F.query = q.value; findNext(se, ev.shiftKey); } });
      const rw = textInput(F.replacement, (v) => { F.replacement = v; }, { id: "se-find-r", disabled: ro });
      const opt = (label: string, key: "matchCase" | "wholeWord" | "regex" | "hiddenFields" | "selectionOnly", id: string) =>
        checkbox(label, !!F[key], (on) => { F[key] = on; afterItem = null; }, { id });
      const fields = h("div", { class: "kv", style: "margin-bottom:10px" }, h("label", null, "Search for:"), q);
      if (replace) fields.append(h("label", null, "Replace with:"), rw);
      const left = h("div", { style: "flex:1;min-width:0" }, fields,
        h("div", { style: "display:flex;flex-direction:column;gap:2px" }, opt("Match case", "matchCase", "se-find-case"), opt("Whole words only", "wholeWord", "se-find-word"),
          opt("Regular Expression", "regex", "se-find-regex"), opt("Include hidden fields", "hiddenFields", "se-find-hidden"), opt("Search the current selection only", "selectionOnly", "se-find-sel")));
      const btn = (label: string, id: string, fn: () => void, primary = false, disabled = false) => h("button", { class: "btn" + (primary ? " primary" : ""), type: "button", id, disabled, style: "width:104px", onclick: fn }, label);
      const right = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:none" }, btn("Find", "se-find-next", () => { F.query = q.value; findNext(se); }, true),
        replace ? btn("Replace", "se-find-replace", () => { F.query = q.value; F.replacement = rw.value; replaceAndFindNext(se); }, false, ro) : null,
        replace ? btn("Replace All", "se-find-replaceall", () => { F.query = q.value; F.replacement = rw.value; replaceAll(se); }, false, ro) : null,
        btn("Close", "se-find-close", () => a.finish(false)));
      statusEl = h("div", { id: "se-find-status", style: "margin-top:8px;min-height:16px;color:var(--ink-2)" });
      body.append(h("div", { style: "display:flex;gap:16px" }, left, right), statusEl);
      setTimeout(() => { q.focus(); q.select(); }, 0);
    },
    cancel() { api = null; statusEl = null; } });
}
/** The editor closed or switched symbols: the remembered match no longer applies. */
export function resetFind(): void { afterItem = null; }
