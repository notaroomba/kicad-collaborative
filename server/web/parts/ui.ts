// ui.ts — the Vendor Parts dialog: search LCSC, Mouser and DigiKey, look at a part's
// symbol and footprint, place it, and keep parts in saved libraries.
//
// Plain DOM on purpose: the dialog is its own small bundle (static/dist/parts.js) that
// works in the editor and on the project manager page alike, styled from the page's
// own colour variables.
import { api, ApiError, type Library, type LibraryItem, type LibrarySummary, type Part, type PartInfo, type Vendor } from "./api";
import { drawFootprint, drawSymbol } from "./preview";
import { canPlace, placePart } from "./place";
import { assignChanges, collect, fullCsv, jlcCsv, priceAt, totals, type BomLine } from "./bom";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const CSS = `
.kp-back{position:fixed;inset:0;background:#0006;z-index:200;display:flex;align-items:center;justify-content:center}
.kp{width:min(1120px,96vw);height:min(680px,92vh);background:var(--bench,#ECEBE6);color:var(--ink,#1B1B1B);border:1px solid var(--line,#CFCDC5);border-radius:6px;box-shadow:var(--shadow,0 10px 30px #0003);display:flex;flex-direction:column;font:13px/1.4 var(--font,system-ui,sans-serif);overflow:hidden}
.kp *{box-sizing:border-box}
.kp-head{display:flex;align-items:center;gap:2px;padding:6px 8px 0 10px;border-bottom:1px solid var(--line,#CFCDC5)}
.kp-title{font-weight:600;margin-right:14px;padding-bottom:6px}
.kp-tab{background:transparent;border:1px solid transparent;border-bottom:0;border-radius:4px 4px 0 0;padding:5px 12px;cursor:pointer;color:var(--ink-2,#5B5A55);margin-bottom:-1px}
.kp-tab:hover{color:var(--ink,#1B1B1B)}
.kp-tab.on{background:var(--paper,#F5F4EF);border-color:var(--line,#CFCDC5);color:var(--ink,#1B1B1B)}
.kp-x{margin-left:auto;background:transparent;border:0;font-size:18px;line-height:1;padding:2px 8px 8px;cursor:pointer;color:var(--ink-2,#5B5A55)}
.kp-x:hover{color:var(--ink,#1B1B1B)}
.kp-body{flex:1;min-height:0;display:flex;background:var(--paper,#F5F4EF)}
.kp-main{flex:1;min-width:0;display:flex;flex-direction:column}
.kp-bar{display:flex;gap:6px;padding:8px 10px;align-items:center;border-bottom:1px solid var(--line,#CFCDC5);flex-wrap:wrap}
.kp input[type=text],.kp input[type=password],.kp select{background:var(--panel,#fff);border:1px solid var(--line,#CFCDC5);border-radius:3px;padding:5px 8px;color:var(--ink,#1B1B1B);font:inherit;min-width:0}
.kp input:focus,.kp select:focus{outline:2px solid var(--blue,#4D7FC4);outline-offset:-1px}
.kp-btn{background:var(--panel,#fff);border:1px solid var(--line,#CFCDC5);border-radius:3px;padding:5px 11px;cursor:pointer;color:var(--ink,#1B1B1B);font:inherit;white-space:nowrap;text-decoration:none;display:inline-block}
.kp-btn:hover{border-color:var(--ink-3,#8C8B85);text-decoration:none}
.kp-btn:disabled{opacity:.45;cursor:default}
.kp-btn.primary{background:var(--copper,#C83434);border-color:var(--copper-2,#A82B2B);color:#fff;font-weight:500}
.kp-btn.primary:hover{background:var(--copper-2,#A82B2B)}
.kp-btn.danger{color:var(--err,#E6090D)}
.kp-btn.sm{padding:2px 8px;font-size:12px}
.kp-list{flex:1;min-height:0;overflow:auto}
.kp-table{width:100%;border-collapse:collapse;font-size:12px}
.kp-table th{position:sticky;top:0;background:var(--bench,#ECEBE6);text-align:left;font-weight:500;color:var(--ink-2,#5B5A55);padding:5px 8px;border-bottom:1px solid var(--line,#CFCDC5);white-space:nowrap;z-index:1}
.kp-table td{padding:5px 8px;border-bottom:1px solid var(--line,#CFCDC5);vertical-align:top}
.kp-table tr.kp-row{cursor:pointer}
.kp-table tr.kp-row:hover td{background:color-mix(in srgb,var(--blue,#4D7FC4) 8%,transparent)}
.kp-table tr.kp-row.on td{background:color-mix(in srgb,var(--blue,#4D7FC4) 18%,transparent)}
.kp-dim{color:var(--ink-2,#5B5A55);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.kp-table tr.kp-nopart{cursor:default}
.kp-mono{font-family:var(--mono,ui-monospace,monospace)}
.kp-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.kp-desc{color:var(--ink-2,#5B5A55);max-width:340px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.kp-badge{display:inline-block;border-radius:3px;padding:0 5px;font-size:11px;line-height:17px;border:1px solid var(--line,#CFCDC5);color:var(--ink-2,#5B5A55);white-space:nowrap}
.kp-badge.lcsc,.kp-badge.mouser,.kp-badge.farnell{border-color:var(--blue,#1E63B8);color:var(--blue,#1E63B8)}.kp-badge.digikey{border-color:var(--err,#C00);color:var(--err,#C00)}
.kp-badge.basic{border-color:var(--wire,#009600);color:var(--wire,#009600)}.kp-badge.preferred{border-color:var(--teal,#006464);color:var(--teal,#006464)}
.kp-badge.warn{border-color:var(--warn,#D19200);color:var(--warn,#D19200)}
.kp-empty{padding:28px 20px;color:var(--ink-2,#5B5A55);text-align:center}
.kp-empty b{color:var(--ink,#1B1B1B);font-weight:500}
.kp-note{padding:6px 10px;font-size:12px;color:var(--ink-2,#5B5A55);border-bottom:1px solid var(--line,#CFCDC5)}
.kp-note.err{color:var(--err,#E6090D)}.kp-note.warn{color:var(--warn,#D19200)}
.kp-side{width:380px;flex:none;border-left:1px solid var(--line,#CFCDC5);background:var(--bench,#ECEBE6);display:flex;flex-direction:column;min-height:0}
.kp-detail{flex:1;min-height:0;overflow:auto;padding:10px 12px}
.kp-detail h3{margin:0;font-size:15px;font-weight:600;word-break:break-word}
.kp-sub{color:var(--ink-2,#5B5A55);margin:2px 0 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.kp-views{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
.kp-view{border:1px solid var(--line,#CFCDC5);border-radius:3px;overflow:hidden;background:var(--panel,#fff)}
.kp-view canvas{display:block;width:100%;height:172px;cursor:zoom-in}
.kp-zoom{position:fixed;inset:0;background:#000a;z-index:210;display:flex;align-items:center;justify-content:center;cursor:zoom-out}
.kp-ask{position:fixed;inset:0;background:#0005;z-index:220;display:flex;align-items:center;justify-content:center}
.kp-ask form{width:min(420px,92vw);background:var(--bench,#ECEBE6);color:var(--ink,#1B1B1B);border:1px solid var(--line,#CFCDC5);border-radius:6px;box-shadow:var(--shadow,0 10px 30px #0003);padding:14px 16px;display:flex;flex-direction:column;gap:10px;animation:kp-in .12s ease-out}
.kp-ask b{font-size:14px}.kp-ask p{margin:0;color:var(--ink-2,#5B5A55);font-size:12.5px;line-height:1.45}
.kp-ask input{background:var(--panel,#fff);color:var(--ink,#1B1B1B);border:1px solid var(--line,#CFCDC5);border-radius:3px;padding:6px 8px;font:inherit}
.kp-ask div{display:flex;justify-content:flex-end;gap:6px}
@keyframes kp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.kp-zoom canvas{width:min(820px,92vw);height:min(820px,88vh);border-radius:4px;border:1px solid var(--line,#CFCDC5)}
.kp-view div{font-size:11px;color:var(--ink-2,#5B5A55);padding:2px 6px;border-top:1px solid var(--line,#CFCDC5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kp-facts{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;margin:8px 0}
.kp-facts dt{color:var(--ink-2,#5B5A55)}.kp-facts dd{margin:0;word-break:break-word}
.kp-actions{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--line,#CFCDC5);background:var(--paper,#F5F4EF)}
.kp-libs{width:210px;flex:none;border-right:1px solid var(--line,#CFCDC5);background:var(--bench,#ECEBE6);display:flex;flex-direction:column;min-height:0}
.kp-lib{padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--line,#CFCDC5)}
.kp-lib:hover{background:color-mix(in srgb,var(--blue,#4D7FC4) 8%,transparent)}
.kp-lib.on{background:color-mix(in srgb,var(--blue,#4D7FC4) 18%,transparent)}
.kp-lib small{display:block;color:var(--ink-2,#5B5A55);font-size:11px}
.kp-keys{padding:14px 16px;overflow:auto;flex:1;display:grid;gap:12px;align-content:start;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.kp-card{background:var(--panel,#fff);border:1px solid var(--line,#CFCDC5);border-radius:4px;padding:12px}
.kp-card h4{margin:0 0 4px;font-size:14px;display:flex;gap:8px;align-items:center}
.kp-card p{margin:0 0 8px;color:var(--ink-2,#5B5A55);font-size:12px}
.kp-card label{display:block;font-size:12px;color:var(--ink-2,#5B5A55);margin:6px 0 2px}
.kp-card input{width:100%}
.kp-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line,#CFCDC5);border-top-color:var(--blue,#4D7FC4);border-radius:50%;animation:kp-spin .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes kp-spin{to{transform:rotate(360deg)}}
.kp-ghost{position:fixed;display:none;align-items:center;justify-content:center;border:1.5px dashed #FF26E2;background:#FF26E214;color:#fff;font:11px var(--mono,monospace);pointer-events:none;z-index:150;text-shadow:0 0 3px #000}
`;

const money = (v: number, cur: string) => (cur && cur !== "USD" ? `${v.toFixed(v < 1 ? 4 : 2)} ${cur}` : "$" + v.toFixed(v < 0.1 ? 4 : v < 1 ? 3 : 2));
const stockText = (n: number | null) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

interface Opts { ctx?: ToolCtx | null; tab?: Tab; query?: string }

/**
 * A small question over the dialog, in place of the browser's prompt / confirm: resolves with the
 * text (or "" for a plain yes) on OK and null on Cancel or Escape.
 */
function ask(o: { title: string; text?: string; input?: string | null; placeholder?: string; ok?: string; danger?: boolean; cancel?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = o.input !== undefined && o.input !== null ? h("input", { type: "text", id: "kp-ask-input", value: o.input, placeholder: o.placeholder || "", autocomplete: "off", spellcheck: "false" }) : null;
    const done = (v: string | null) => { back.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopImmediatePropagation(); ev.preventDefault(); done(null); } };
    const form = h("form", { onsubmit: (ev: Event) => { ev.preventDefault(); done(input ? input.value : ""); } },
      h("b", null, o.title), o.text ? h("p", null, o.text) : null, input,
      h("div", null, o.cancel === false ? null : h("button", { class: "kp-btn", type: "button", id: "kp-ask-cancel", onclick: () => done(null) }, "Cancel"),
        h("button", { class: "kp-btn " + (o.danger ? "danger" : "primary"), type: "submit", id: "kp-ask-ok" }, o.ok || "OK")));
    const back = h("div", { class: "kp-ask", onmousedown: (ev: Event) => { if (ev.target === back) done(null); } }, form);
    document.body.appendChild(back); document.addEventListener("keydown", key, true);
    if (input) { input.focus(); input.select(); } else (form.querySelector("#kp-ask-ok") as HTMLElement).focus();
  });
}
const tell = (title: string, text?: string) => ask({ title, text, cancel: false });

type Tab = "search" | "libraries" | "keys" | "bom";

/** "R1, R2, R3 +4" */
const refList = (refs: string[]) => (refs.length > 4 ? `${refs.slice(0, 3).join(", ")} +${refs.length - 3}` : refs.join(", "));

class PartsDialog {
  private root: HTMLElement; private bodyEl: HTMLElement; private tabs: Record<string, HTMLButtonElement> = {};
  private ctx: ToolCtx | null; private tab: Tab;
  private vendors: Vendor[] = []; private libs: LibrarySummary[] = [];
  // search
  private q = ""; private vendor = "all"; private results: PartInfo[] | null = null; private searchErrors: { vendor: string; message: string }[] = []; private searching = false; private searchSeq = 0;
  // the part shown in the side pane
  private sel: { vendor: string; id: string; lib?: string } | null = null; private part: Part | null = null; private partErr = ""; private partLoading = false; private partSeq = 0;
  // libraries
  private lib: Library | null = null; private libBusy = ""; private libNote = "";
  // the bill of materials of the open document, and the line a search is looking for a part for
  private bom: BomLine[] | null = null; private boards = 1; private bomSheets = 1; private assign: { ids: string[]; refs: string[] } | null = null;
  private onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !ev.defaultPrevented && !document.querySelector(".kp-ask")) { ev.stopPropagation(); this.close(); } };

  constructor(opts: Opts) {
    this.ctx = opts.ctx || null; this.tab = opts.tab || "search"; this.q = opts.query || "";
    if (!document.getElementById("kp-style")) document.head.append(h("style", { id: "kp-style" }, CSS));
    const tab = (id: Tab, label: string) => (this.tabs[id] = h("button", { class: "kp-tab", type: "button", "data-tab": id, onclick: () => this.setTab(id) }, label));
    this.bodyEl = h("div", { class: "kp-body" });
    const box = h("div", { class: "kp", role: "dialog", "aria-label": "Vendor Parts" },
      h("div", { class: "kp-head" }, h("span", { class: "kp-title" }, "Vendor Parts"), tab("search", "Search"), tab("libraries", "My Libraries"), this.ctx && this.ctx.doc ? tab("bom", "BOM") : null, tab("keys", "API Keys"),
        h("button", { class: "kp-x", type: "button", title: "Close (Esc)", onclick: () => this.close() }, "×")),
      this.bodyEl);
    // keep the editor's hotkeys and tools out of the dialog
    for (const t of ["keydown", "keyup", "keypress", "wheel", "pointerdown", "mousedown", "contextmenu", "paste", "copy", "cut"]) box.addEventListener(t, (ev) => { if (!(t === "keydown" && (ev as KeyboardEvent).key === "Escape")) ev.stopPropagation(); });
    this.root = h("div", { class: "kp-back", id: "kp-dialog", onpointerdown: (ev: Event) => { if (ev.target === this.root) this.close(); } }, box);
    document.body.append(this.root);
    document.addEventListener("keydown", this.onKey, true);
    this.render();
    void this.load();
  }

  close() { document.removeEventListener("keydown", this.onKey, true); this.root.remove(); if (current === this) current = null; }

  private projectId(): string | null {
    const p = this.ctx && (this.ctx.project as { id?: string } | null);
    if (p && p.id) return p.id;
    const m = /^\/p\/([0-9a-f-]{36})/.exec(location.pathname); return m ? m[1] : null;
  }

  private async load() {
    try {
      const [vendors, libs] = await Promise.all([api.vendors(), api.libraries(this.projectId())]);
      this.vendors = vendors; this.libs = libs; this.render();
      if (this.q && this.tab === "search") void this.search();
      if (this.tab === "libraries" && !this.lib && this.libs.length) void this.openLibrary(this.libs[0].id);
      if (this.tab === "bom") void this.loadBom();
    } catch (e) { this.bodyEl.replaceChildren(h("div", { class: "kp-empty", style: "flex:1" }, h("b", null, errText(e)), e instanceof ApiError && e.status === 401 ? h("p", null, h("a", { class: "kp-btn primary", href: `/auth/github/login?next=${encodeURIComponent(location.pathname)}` }, "Sign in with GitHub")) : null)); }
  }

  private setTab(t: Tab) {
    this.tab = t; this.sel = null; this.part = null; this.partErr = "";
    if (t === "libraries" && !this.lib && this.libs.length) void this.openLibrary(this.libs[0].id);
    if (t !== "search") this.assign = null;
    if (t === "bom") void this.loadBom();
    this.render();
  }

  // ------------------------------------------------------------ render
  private render() {
    for (const [id, b] of Object.entries(this.tabs)) b.classList.toggle("on", id === this.tab);
    if (this.tab === "keys") { this.bodyEl.replaceChildren(this.renderKeys()); return; }
    const main = this.tab === "search" ? this.renderSearch() : this.tab === "bom" ? this.renderBom() : this.renderLibrary();
    const kids: Node[] = [];
    if (this.tab === "libraries") kids.push(this.renderLibList());
    kids.push(main, this.renderSide());
    // the search box keeps its focus and caret across a re-render
    const active = document.activeElement as HTMLInputElement | null; const keep = active && (active.id === "kp-q" || active.id === "kp-boards") ? [active.selectionStart, active.selectionEnd] : null;
    this.bodyEl.replaceChildren(...kids);
    if (keep) { const q = this.bodyEl.querySelector<HTMLInputElement>("#" + active!.id); if (q) { q.focus(); try { q.setSelectionRange(keep[0], keep[1]); } catch { /* a number input has no caret to restore */ } } }
    this.paint();
  }

  private paint() {
    const s = this.bodyEl.querySelector<HTMLCanvasElement>("#kp-sym"), f = this.bodyEl.querySelector<HTMLCanvasElement>("#kp-fp");
    if (s) drawSymbol(s, this.part && this.part.cad && this.part.cad.symbol ? this.part.cad.symbol.sexpr : null);
    if (f) drawFootprint(f, this.part && this.part.cad && this.part.cad.footprint ? this.part.cad.footprint.sexpr : null);
  }

  /** A preview at full size, to read the pin names or check the pads before placing. */
  private zoom(kind: "symbol" | "footprint") {
    const cad = this.part && this.part.cad; if (!cad) return;
    const canvas = h("canvas", { id: "kp-zoom-canvas" });
    const back = h("div", { class: "kp-zoom", onclick: () => back.remove() }, canvas);
    this.root.append(back);
    if (kind === "symbol") drawSymbol(canvas, cad.symbol ? cad.symbol.sexpr : null); else drawFootprint(canvas, cad.footprint ? cad.footprint.sexpr : null);
  }

  private vendorBadge(vendor: string, name: string) { return h("span", { class: `kp-badge ${vendor}` }, name); }

  private renderSearch(): HTMLElement {
    const input = h("input", { type: "text", id: "kp-q", placeholder: "Part number, value or keywords — e.g. STM32F103C8T6, 10k 0603, C8734", value: this.q, style: "flex:1", spellcheck: "false", autocomplete: "off",
      oninput: (ev: Event) => { this.q = (ev.target as HTMLInputElement).value; },
      onkeydown: (ev: KeyboardEvent) => { if (ev.key === "Enter") void this.search(); else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); this.step(ev.key === "ArrowDown" ? 1 : -1); } } });
    const sel = h("select", { id: "kp-vendor", title: "Where to search", onchange: (ev: Event) => { this.vendor = (ev.target as HTMLSelectElement).value; if (this.q.trim().length >= 2) void this.search(); } },
      h("option", { value: "all" }, "All vendors"),
      ...this.vendors.map((v) => h("option", { value: v.id, disabled: !v.configured }, v.configured ? v.name : `${v.name} — needs a key`)));
    sel.value = this.vendor;
    const bar = h("div", { class: "kp-bar" }, input, sel, h("button", { class: "kp-btn primary", type: "button", id: "kp-go", onclick: () => void this.search() }, "Search"));
    const notes: Node[] = this.searchErrors.map((e) => h("div", { class: "kp-note err" }, e.message));
    const missing = this.vendors.filter((v) => !v.configured);
    if (missing.length && this.results && !this.searchErrors.length && this.vendor === "all")
      notes.push(h("div", { class: "kp-note" }, `Searched ${this.vendors.filter((v) => v.configured).map((v) => v.name).join(", ")}. `, h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); this.setTab("keys"); } }, `Add a key to search ${missing.map((v) => v.name).join(" and ")} too.`)));
    let list: HTMLElement;
    if (this.searching) list = h("div", { class: "kp-empty" }, h("span", { class: "kp-spin" }), "Searching…");
    else if (!this.results) list = h("div", { class: "kp-empty" }, h("b", null, "Find a part by number, value or description."), h("p", null, "LCSC parts come with a symbol, a footprint and a 3D model. Mouser and DigiKey parts use the drawings of the matching LCSC listing."));
    else if (!this.results.length) list = h("div", { class: "kp-empty" }, this.searchErrors.length ? "No results." : h("b", null, `Nothing found for “${this.q.trim()}”.`));
    else list = this.partsTable(this.results.map((r) => ({ key: r.vendor + "\n" + r.vendor_id, vendor: r.vendor, vendor_name: r.vendor_name, vendor_id: r.vendor_id, mpn: r.mpn, manufacturer: r.manufacturer, description: r.description, package: r.package, stock: r.stock, prices: r.prices, assembly: r.assembly })), null);
    return h("div", { class: "kp-main" }, bar, ...notes, h("div", { class: "kp-list", id: "kp-results" }, list));
  }

  private partsTable(rows: { key: string; vendor: string; vendor_name: string; vendor_id: string; mpn: string; manufacturer: string; description: string; package: string; stock: number | null; prices: { qty: number; price: number; currency: string }[]; assembly: string; item?: LibraryItem }[], lib: Library | null): HTMLElement {
    const selKey = this.sel ? this.sel.vendor + "\n" + this.sel.id : "";
    return h("table", { class: "kp-table" },
      h("thead", null, h("tr", null, h("th", null, "Part"), h("th", null, "Description"), h("th", null, "Package"), h("th", { class: "kp-num" }, "Stock"), h("th", { class: "kp-num" }, "Price"), h("th", null, "Vendor"), lib ? h("th", null, "") : null)),
      h("tbody", null, rows.map((r) => {
        const p = r.prices[0];
        return h("tr", { class: "kp-row" + (r.key === selKey ? " on" : ""), "data-vendor": r.vendor, "data-id": r.vendor_id,
          onclick: () => void this.select(r.vendor, r.vendor_id, lib ? lib.nickname : undefined),
          ondblclick: () => void this.place() },
          h("td", null, h("div", { class: "kp-mono" }, r.mpn || r.vendor_id), h("div", { style: "color:var(--ink-2,#5B5A55)" }, r.manufacturer)),
          h("td", null, h("div", { class: "kp-desc", title: r.description }, r.description), r.item && r.item.note ? h("div", { style: "color:var(--teal,#006464)" }, r.item.note) : null,
            r.item && !r.item.cached ? h("span", { class: "kp-badge warn", title: "Not in the cache yet: it is fetched when you open it" }, "not fetched") : null,
            r.item && r.item.cached && !r.item.has_cad ? h("span", { class: "kp-badge warn" }, "no drawings") : null),
          h("td", null, r.package),
          h("td", { class: "kp-num" }, stockText(r.stock)),
          h("td", { class: "kp-num" }, p ? money(p.price, p.currency) : "—"),
          h("td", null, this.vendorBadge(r.vendor, r.vendor_name), " ", h("span", { class: "kp-mono" }, r.vendor_id), r.assembly === "basic" || r.assembly === "preferred" ? h("div", null, h("span", { class: `kp-badge ${r.assembly}`, title: "JLCPCB assembly class" }, r.assembly === "basic" ? "Basic" : "Preferred")) : null),
          lib ? h("td", null, lib.can_edit && r.item ? h("button", { class: "kp-btn sm", type: "button", title: "Remove from this library", onclick: (ev: Event) => { ev.stopPropagation(); void this.removeItem(r.item!); } }, "Remove") : null) : null);
      })));
  }

  private step(d: number) {
    const rows = this.tab === "search" ? (this.results || []).map((r) => [r.vendor, r.vendor_id]) : this.lib ? this.lib.items.map((i) => [i.vendor, i.vendor_id]) : [];
    if (!rows.length) return;
    const i = this.sel ? rows.findIndex((r) => r[0] === this.sel!.vendor && r[1] === this.sel!.id) : -1;
    const n = Math.max(0, Math.min(rows.length - 1, i + d));
    void this.select(rows[n][0], rows[n][1], this.tab === "libraries" && this.lib ? this.lib.nickname : undefined);
  }

  private renderSide(): HTMLElement {
    const side = h("div", { class: "kp-side", id: "kp-side" });
    if (this.partLoading && !this.part) { side.append(h("div", { class: "kp-empty" }, h("span", { class: "kp-spin" }), "Fetching the part…")); return side; }
    if (this.partErr && !this.part) { side.append(h("div", { class: "kp-empty" }, h("b", null, this.partErr), h("p", null, h("button", { class: "kp-btn", type: "button", onclick: () => this.sel && void this.select(this.sel.vendor, this.sel.id, this.sel.lib) }, "Try again")))); return side; }
    const p = this.part;
    if (!p) { side.append(h("div", { class: "kp-empty" }, "Select a part to see its symbol and footprint.")); return side; }
    const cad = p.cad;
    const facts = h("dl", { class: "kp-facts" });
    const fact = (k: string, v: Child | Child[]) => { if (v === "" || v === null || v === undefined || v === false) return; facts.append(h("dt", null, k), h("dd", null, v)); };
    fact("Package", p.package);
    fact("Stock", p.stock === null ? "" : stockText(p.stock));
    if (p.prices.length) fact("Price", p.prices.slice(0, 5).map((b) => h("div", null, `${b.qty.toLocaleString("en-US")}+  ${money(b.price, b.currency)}`)));
    fact("Category", p.category);
    fact("Lifecycle", p.lifecycle);
    for (const [k, v] of Object.entries(p.attributes || {}).slice(0, 10)) fact(k, v);
    if (cad && cad.source.vendor_id !== p.vendor_id) fact("Drawings", ["from LCSC ", h("span", { class: "kp-mono" }, cad.source.vendor_id), " (same manufacturer part number) ", h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); void this.relink(); } }, "change")]);
    if (p.fetched_at) fact("Fetched", new Date(p.fetched_at).toLocaleString());

    const detail = h("div", { class: "kp-detail" },
      h("h3", { id: "kp-part-title" }, p.mpn || p.vendor_id),
      h("div", { class: "kp-sub" }, p.manufacturer, this.vendorBadge(p.vendor, p.vendor_name), h("span", { class: "kp-mono" }, p.vendor_id),
        p.assembly ? h("span", { class: `kp-badge ${p.assembly}`, title: "JLCPCB assembly class" }, p.assembly[0].toUpperCase() + p.assembly.slice(1)) : null,
        this.partLoading ? h("span", { class: "kp-spin" }) : null),
      p.stale ? h("div", { class: "kp-note warn", style: "border:0;padding:0 0 6px" }, `Showing the saved copy: ${p.stale_reason || "the vendor could not be reached."}`) : null,
      this.partErr ? h("div", { class: "kp-note err", style: "border:0;padding:0 0 6px" }, this.partErr) : null,
      h("div", null, p.description),
      cad ? h("div", { class: "kp-views" },
        h("div", { class: "kp-view" }, h("canvas", { id: "kp-sym", title: "Click to enlarge", onclick: () => this.zoom("symbol") }), h("div", { title: cad.symbol ? cad.symbol.lib_id : "" }, cad.symbol ? `Symbol · ${cad.symbol.pins} pins${cad.symbol.units > 1 ? ` · ${cad.symbol.units} units` : ""}` : "No symbol")),
        h("div", { class: "kp-view" }, h("canvas", { id: "kp-fp", title: "Click to enlarge", onclick: () => this.zoom("footprint") }), h("div", { title: cad.footprint ? cad.footprint.fpid : "" }, cad.footprint ? `${cad.footprint.name} · ${cad.footprint.pads} pads` : "No footprint")))
        : h("div", { class: "kp-note warn", id: "kp-nocad", style: "border:1px solid var(--line,#CFCDC5);border-radius:3px;margin:8px 0;padding:8px" },
          p.vendor === "lcsc" ? "LCSC has no drawings for this part." : [`${p.vendor_name} publishes no drawings, and no LCSC listing has the manufacturer part number ${p.mpn || "of this part"}. `,
            h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); void this.relink(); } }, "Use the drawings of an LCSC part…")]),
      facts);

    const why = canPlace(this.ctx, p);
    const kind = this.ctx && this.ctx.doc ? (this.ctx.isSch ? "Place Symbol" : "Place Footprint") : "Place";
    const editable = this.libs.filter((l) => l.can_edit);
    const addSel = h("select", { id: "kp-add", title: "Save this part to one of your libraries", onchange: (ev: Event) => { const v = (ev.target as HTMLSelectElement).value; (ev.target as HTMLSelectElement).value = ""; if (v) void this.addTo(v); } },
      h("option", { value: "" }, "Add to library…"), ...editable.map((l) => h("option", { value: l.id }, l.name)), h("option", { value: "+" }, "New library…"));
    const canAssign = this.assign && this.ctx && this.ctx.doc && !this.ctx.viewOnly;
    const actions = h("div", { class: "kp-actions" },
      canAssign ? h("button", { class: "kp-btn primary", type: "button", id: "kp-assign", title: "Write this part's vendor number, MPN and manufacturer onto " + this.assign!.refs.join(", "), onclick: () => this.assignPart() }, `Assign to ${refList(this.assign!.refs)}`) : null,
      h("button", { class: "kp-btn" + (canAssign ? "" : " primary"), type: "button", id: "kp-place", disabled: !!why, title: why || "Put this part on the cursor", onclick: () => void this.place() }, kind),
      addSel,
      p.datasheet ? h("a", { class: "kp-btn", href: p.datasheet, target: "_blank", rel: "noreferrer" }, "Datasheet ↗") : null,
      p.url ? h("a", { class: "kp-btn", href: p.url, target: "_blank", rel: "noreferrer" }, `${p.vendor_name} ↗`) : null,
      cad && cad.model ? h("a", { class: "kp-btn", href: cad.model.url, title: `3D model: ${cad.model.title}` }, "3D model ↓") : null,
      h("button", { class: "kp-btn", type: "button", id: "kp-refresh", title: "Fetch this part from the vendor again", onclick: () => this.sel && void this.select(this.sel.vendor, this.sel.id, this.sel.lib, true) }, "Refresh"));
    side.append(detail, actions);
    return side;
  }

  // ------------------------------------------------------------ search and part
  private async search() {
    const q = this.q.trim();
    if (q.length < 2) { this.searchErrors = [{ vendor: "", message: "Type at least two characters to search." }]; this.results = null; this.render(); return; }
    const seq = ++this.searchSeq; this.searching = true; this.searchErrors = []; this.render();
    try {
      const r = await api.search(q, this.vendor); if (seq !== this.searchSeq) return;
      this.results = r.results; this.searchErrors = r.errors.filter((e) => e.code !== "vendor_not_configured" || this.vendor !== "all");
      this.searching = false; this.render();
      if (r.results.length === 1) void this.select(r.results[0].vendor, r.results[0].vendor_id);
    } catch (e) { if (seq !== this.searchSeq) return; this.searching = false; this.results = []; this.searchErrors = [{ vendor: "", message: errText(e) }]; this.render(); }
  }

  private async select(vendor: string, id: string, lib?: string, refresh = false) {
    const same = this.sel && this.sel.vendor === vendor && this.sel.id === id;
    this.sel = { vendor, id, lib }; const seq = ++this.partSeq;
    if (!same) this.part = null;
    this.partErr = ""; this.partLoading = true; this.render();
    try {
      const p = await api.part(vendor, id, { lib, refresh }); if (seq !== this.partSeq) return;
      this.part = p; this.partLoading = false; this.render();
    } catch (e) { if (seq !== this.partSeq) return; this.partLoading = false; this.partErr = errText(e); this.render(); }
  }

  private async relink() {
    const p = this.part; if (!p) return;
    const cur = p.cad ? p.cad.source.vendor_id : "";
    const v = await ask({ title: "Symbol and footprint", text: `LCSC part number whose symbol and footprint to use for ${p.mpn || p.vendor_id}. Leave it empty to look it up again by manufacturer part number.`, input: cur, placeholder: "C8734", ok: "Use" });
    if (v === null) return;
    try { this.part = await api.linkCad(p.vendor, p.vendor_id, v.trim() || null, this.sel ? this.sel.lib : undefined); this.partErr = ""; } catch (e) { this.partErr = errText(e); }
    this.render();
  }

  private async place() {
    const p = this.part; const ctx = this.ctx;
    if (!p || !ctx || canPlace(ctx, p)) return;
    this.close();
    try { await placePart(freshCtx(ctx), p); } catch (e) { ctx.toast("Placing failed: " + errText(e), 4000); }
  }

  // ------------------------------------------------------------ bill of materials
  private async loadBom() {
    const ctx = this.ctx; if (!ctx || !ctx.doc) { this.bom = []; return; }
    this.bom = null; this.render();
    // a schematic is several sheets: read the others as they are stored, so the BOM covers the design
    const others: { name: string; doc: KDoc }[] = [];
    if (ctx.isSch) {
      const rest = (ctx.docs as { docId: string; docType?: string; path?: string }[] || []).filter((d) => d.docId !== ctx.docId && (d.docType === "sch" || /\.kicad_sch$/.test(d.path || "")));
      await Promise.all(rest.map(async (d) => {
        try { const r = await fetch(`/api/docs/${d.docId}/content`, { credentials: "same-origin" }); if (r.ok) others.push({ name: (d.path || "").split("/").pop()!.replace(/\.kicad_sch$/, ""), doc: ctx.K.parseDoc(await r.text(), "kicad_sch") }); } catch { /* that sheet is left out */ }
      }));
      if (this.tab !== "bom" || this.ctx !== ctx) return;
    }
    this.bomSheets = others.length + 1;
    const lines = collect(ctx.K, ctx.doc, ctx.isSch, others); this.bom = lines;
    const todo = lines.filter((l) => l.vendor); for (const l of todo) l.loading = true;
    this.render();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const l = todo[next++]; if (!l) return;
        try { l.part = await api.part(l.vendor!, l.vendorId); } catch (e) { l.err = errText(e); }
        l.loading = false;
        if (this.bom === lines && this.tab === "bom") this.render();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private download(name: string, text: string) {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private findFor(l: BomLine) {
    const size = /(?:^|[_\-:])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[_\-]|$)/.exec(l.footprint);
    this.assign = { ids: l.ids, refs: l.refs }; this.q = l.mpn || [l.value, size ? size[1] : ""].filter(Boolean).join(" ");
    this.tab = "search"; this.sel = null; this.part = null; this.partErr = ""; this.results = null; this.render(); void this.search();
  }

  private assignPart() {
    const ctx = this.ctx, p = this.part, a = this.assign; if (!ctx || !ctx.doc || !p || !a) return;
    const changes = assignChanges(ctx.K, ctx.doc, a.ids, p.fields);
    if (!changes.length) { this.toast("Those parts are no longer in the document."); return; }
    ctx.commit(changes, "assign part"); ctx.requestRender();
    ctx.toast(`${p.mpn || p.vendor_id} assigned to ${refList(a.refs)}`, 3000);
    this.assign = null; this.setTab("bom");
  }

  private renderBom(): HTMLElement {
    const ctx = this.ctx; const lines = this.bom || []; const t = totals(lines, this.boards);
    const what = ctx && ctx.isSch ? (this.bomSheets > 1 ? `${this.bomSheets} sheets` : "this sheet") : "this board";
    const stem = ((ctx && (ctx.project as { name?: string } | null)?.name) || "bom").replace(/[^\w.-]+/g, "_");
    const bar = h("div", { class: "kp-bar" },
      h("label", { style: "display:flex;align-items:center;gap:6px" }, "Boards", h("input", { type: "number", id: "kp-boards", min: "1", max: "100000", value: String(this.boards), style: "width:76px",
        oninput: (ev: Event) => { const n = Math.floor(+(ev.target as HTMLInputElement).value); if (n >= 1 && n !== this.boards) { this.boards = Math.min(n, 100000); this.render(); } } })),
      h("span", { id: "kp-bom-sum", style: "flex:1;color:var(--ink-2,#5B5A55)" }, lines.length
        ? `${t.parts} parts in ${t.lines} lines on ${what} · ${t.matched} with a vendor part${t.matched ? ` · ${money(t.cost, t.currency)} for ${this.boards === 1 ? "one board" : this.boards + " boards"}` : ""}${t.short ? ` · ${t.short} short of stock` : ""}` : ""),
      h("button", { class: "kp-btn", type: "button", id: "kp-bom-jlc", disabled: !lines.length, title: "Comment, Designator, Footprint, LCSC Part #: the file JLCPCB's assembly order asks for", onclick: () => this.download(`${stem}-jlcpcb-bom.csv`, jlcCsv(lines)) }, "JLCPCB BOM ↓"),
      h("button", { class: "kp-btn", type: "button", id: "kp-bom-csv", disabled: !lines.length, title: "Every line with stock and prices, for a spreadsheet", onclick: () => this.download(`${stem}-bom.csv`, fullCsv(lines, this.boards)) }, "Full BOM ↓"));
    const table = h("table", { class: "kp-table", id: "kp-bom" }, h("thead", null, h("tr", null, h("th", null, "References"), h("th", { class: "kp-num" }, "Qty"), h("th", null, "Value"), h("th", null, "Part"), h("th", { class: "kp-num" }, "Stock"), h("th", { class: "kp-num" }, "Each"), h("th", { class: "kp-num" }, "Total"))));
    const body = h("tbody"); table.append(body);
    for (const l of lines) {
      const need = l.refs.length * this.boards; const p = l.part; const pr = p ? priceAt(p.prices, need) : null;
      const on = !!(this.sel && l.vendor === this.sel.vendor && l.vendorId === this.sel.id);
      const part: Child[] = l.vendor
        ? [h("div", null, (p && p.mpn) || l.mpn || l.vendorId), h("div", { class: "kp-dim" }, this.vendorBadge(l.vendor, p ? p.vendor_name : l.vendor.toUpperCase()), " ", h("span", { class: "kp-mono" }, l.vendorId), l.loading ? h("span", { class: "kp-spin", style: "margin-left:6px" }) : null, l.err ? h("span", { style: "color:var(--err,#E6090D);margin-left:6px", title: l.err }, "not found") : null)]
        : !l.ids.length ? [h("span", { class: "kp-dim", title: "Open that sheet to give these parts a vendor part" }, "on " + l.elsewhere.join(", "))] : [h("button", { class: "kp-btn sm kp-find", type: "button", title: "Search the vendors for this part and write the choice onto " + l.refs.join(", "), onclick: (ev: Event) => { ev.stopPropagation(); this.findFor(l); } }, "Find a part…"), l.mpn ? h("span", { class: "kp-dim", style: "margin-left:6px" }, l.mpn) : null];
      body.append(h("tr", { class: "kp-row" + (on ? " on" : "") + (l.vendor ? "" : " kp-nopart"), "data-key": l.key, "data-vendor": l.vendor || "", "data-id": l.vendorId, onclick: () => { if (l.vendor) void this.select(l.vendor, l.vendorId); } },
        h("td", { title: l.refs.join(", ") }, refList(l.refs)), h("td", { class: "kp-num" }, String(need)),
        h("td", null, h("div", null, l.value), h("div", { class: "kp-dim", title: l.footprint }, l.footprint.includes(":") ? l.footprint.slice(l.footprint.indexOf(":") + 1) : l.footprint)),
        h("td", null, ...part),
        h("td", { class: "kp-num", style: p && p.stock !== null && p.stock < need ? "color:var(--err,#E6090D)" : "" }, p && p.stock !== null ? stockText(p.stock) : ""),
        h("td", { class: "kp-num" }, pr ? money(pr.price, pr.currency) : ""), h("td", { class: "kp-num" }, pr ? money(pr.price * need, pr.currency) : "")));
    }
    const empty = !lines.length ? h("div", { class: "kp-empty" }, h("b", null, `No parts on ${what}.`), h("p", null, "Symbols marked “exclude from BOM” or “do not populate”, and power symbols, are left out.")) : null;
    return h("div", { class: "kp-main" }, bar, this.bom === null ? h("div", { class: "kp-empty" }, h("span", { class: "kp-spin" }), "Reading the design…") : null,
      this.bom === null ? null : h("div", { class: "kp-list" }, empty || table));
  }

  // ------------------------------------------------------------ libraries
  private async reloadLibs() { try { this.libs = await api.libraries(this.projectId()); } catch { /* the list on screen stands */ } }

  private async openLibrary(id: string) {
    this.libBusy = "open"; this.libNote = ""; this.render();
    try { this.lib = await api.library(id); } catch (e) { this.libNote = errText(e); this.lib = null; }
    this.libBusy = ""; this.sel = null; this.part = null; this.render();
  }

  private async newLibrary(): Promise<string | null> {
    const name = await ask({ title: "New library", input: "", placeholder: "Library name", ok: "Create" }); if (!name || !name.trim()) return null;
    try { const lib = await api.createLibrary(name.trim()); await this.reloadLibs(); return lib.id; } catch (e) { void tell("The library could not be created", errText(e)); return null; }
  }

  private async addTo(libId: string) {
    const p = this.part; if (!p) return;
    let id: string | null = libId;
    if (libId === "+") { id = await this.newLibrary(); if (!id) { this.render(); return; } }
    try {
      const lib = await api.addItem(id!, p.vendor, p.vendor_id); await this.reloadLibs();
      if (this.lib && this.lib.id === lib.id) this.lib = lib;
      this.toast(`Added ${p.mpn || p.vendor_id} to ${lib.name}`);
    } catch (e) { this.partErr = errText(e); }
    this.render();
  }

  private toast(msg: string) { if (this.ctx) this.ctx.toast(msg, 2500); else { this.libNote = msg; } }

  private async removeItem(item: LibraryItem) {
    if (!this.lib) return;
    try { this.lib = await api.removeItem(this.lib.id, item.id); await this.reloadLibs(); if (this.sel && this.sel.vendor === item.vendor && this.sel.id === item.vendor_id) { this.sel = null; this.part = null; } } catch (e) { this.libNote = errText(e); }
    this.render();
  }

  private renderLibList(): HTMLElement {
    const list = h("div", { class: "kp-list" }, this.libs.map((l) => h("div", { class: "kp-lib" + (this.lib && this.lib.id === l.id ? " on" : ""), "data-lib": l.id, onclick: () => void this.openLibrary(l.id) },
      l.name, h("small", null, `${l.items} part${l.items === 1 ? "" : "s"}`, l.project_name ? ` · shared with ${l.project_name}` : "", l.mine ? "" : ` · by ${l.owner_login}`))));
    if (!this.libs.length) list.append(h("div", { class: "kp-empty" }, "No libraries yet."));
    return h("div", { class: "kp-libs" }, list, h("div", { style: "padding:8px;border-top:1px solid var(--line,#CFCDC5)" },
      h("button", { class: "kp-btn", type: "button", id: "kp-newlib", style: "width:100%", onclick: async () => { const id = await this.newLibrary(); if (id) await this.openLibrary(id); else this.render(); } }, "New Library…")));
  }

  private renderLibrary(): HTMLElement {
    const lib = this.lib;
    if (this.libBusy === "open") return h("div", { class: "kp-main" }, h("div", { class: "kp-empty" }, h("span", { class: "kp-spin" }), "Opening…"));
    if (!lib) return h("div", { class: "kp-main" }, h("div", { class: "kp-empty" }, this.libNote ? h("b", null, this.libNote) : [h("b", null, "A library is a list of part references."), h("p", null, "It stores only where each part comes from and its part numbers. The symbol, footprint and prices are fetched when you use the part, and kept so the library still works when a vendor is unreachable.")]));
    const pid = this.projectId(); const busy = !!this.libBusy;
    const run = async (what: string, fn: () => Promise<void>) => { this.libBusy = what; this.libNote = ""; this.render(); try { await fn(); } catch (e) { this.libNote = errText(e); } this.libBusy = ""; this.render(); };
    const bar = h("div", { class: "kp-bar" },
      h("b", { id: "kp-libname", style: "margin-right:auto" }, lib.name, lib.project_name ? h("span", { class: "kp-badge", style: "margin-left:8px;font-weight:400" }, `shared with ${lib.project_name}`) : null),
      lib.can_edit ? h("button", { class: "kp-btn", type: "button", disabled: busy, onclick: async () => { const n = await ask({ title: "Rename library", input: lib.name, ok: "Rename" }); if (n && n.trim() && n.trim() !== lib.name) void run("rename", async () => { this.lib = await api.updateLibrary(lib.id, { name: n.trim() }); await this.reloadLibs(); }); } }, "Rename…") : null,
      lib.mine && pid && lib.project_id !== pid ? h("button", { class: "kp-btn", type: "button", id: "kp-share", disabled: busy, title: "Everyone in this project can use the library; its editors can add to it", onclick: () => void run("share", async () => { this.lib = await api.updateLibrary(lib.id, { project_id: pid }); await this.reloadLibs(); }) }, "Share with This Project") : null,
      lib.mine && lib.project_id ? h("button", { class: "kp-btn", type: "button", id: "kp-unshare", disabled: busy, onclick: () => void run("share", async () => { this.lib = await api.updateLibrary(lib.id, { project_id: null }); await this.reloadLibs(); }) }, "Stop Sharing") : null,
      h("button", { class: "kp-btn", type: "button", id: "kp-refreshlib", disabled: busy || !lib.items.length, title: "Fetch every part in this library from its vendor again", onclick: () => void run("refresh", async () => { const r = await api.refreshLibrary(lib.id); this.lib = r.library; this.libNote = r.failed.length ? `${r.refreshed} refreshed, ${r.failed.length} could not be reached and kept their saved copy.` : `${r.refreshed} part${r.refreshed === 1 ? "" : "s"} refreshed.`; }) }, this.libBusy === "refresh" ? [h("span", { class: "kp-spin" }), "Refreshing…"] : "Refresh All"),
      h("a", { class: "kp-btn", id: "kp-export", href: api.exportUrl(lib.id), title: "A .kicad_sym symbol library, a .pretty footprint folder and the 3D models, for desktop KiCad" }, "Export for KiCad ↓"),
      lib.mine ? h("button", { class: "kp-btn danger", type: "button", disabled: busy, onclick: async () => { if (await ask({ title: `Delete “${lib.name}”?`, text: "Designs that already use its parts are not affected.", ok: "Delete", danger: true }) !== null) void run("delete", async () => { await api.deleteLibrary(lib.id); this.lib = null; await this.reloadLibs(); }); } }, "Delete") : null);
    const body = lib.items.length
      ? this.partsTable(lib.items.map((i) => ({ key: i.vendor + "\n" + i.vendor_id, vendor: i.vendor, vendor_name: i.vendor_name, vendor_id: i.vendor_id, mpn: i.mpn, manufacturer: i.manufacturer, description: i.description, package: i.package, stock: i.stock, prices: i.prices || [], assembly: i.assembly, item: i })), lib)
      : h("div", { class: "kp-empty" }, h("b", null, "This library is empty."), h("p", null, "Find a part under Search and choose “Add to library…”."));
    return h("div", { class: "kp-main" }, bar, this.libNote ? h("div", { class: "kp-note", id: "kp-libnote" }, this.libNote) : null, h("div", { class: "kp-list", id: "kp-items" }, body));
  }

  // ------------------------------------------------------------ keys
  private renderKeys(): HTMLElement {
    return h("div", { class: "kp-keys" }, this.vendors.map((v) => {
      const status = h("span", { class: "kp-badge " + (v.configured ? "basic" : "warn") }, !v.fields.length ? "No key needed" : v.key_source === "yours" ? "Your key" : v.key_source === "server" ? "Server key" : "No key");
      const card = h("div", { class: "kp-card", "data-vendor": v.id }, h("h4", null, v.name, status), h("p", null, v.note));
      if (!v.fields.length) return card;
      const inputs: Record<string, HTMLInputElement> = {};
      const msg = h("p", { style: "margin:8px 0 0" });
      for (const f of v.fields) { inputs[f.id] = h("input", { type: f.id.includes("secret") || f.id.includes("key") ? "password" : "text", placeholder: v.key_source === "yours" ? "•••••••• (saved)" : "", autocomplete: "off", "data-field": f.id }); card.append(h("label", null, f.label), inputs[f.id]); }
      const save = h("button", { class: "kp-btn primary", type: "button", onclick: async () => {
        save.disabled = true; msg.textContent = "Checking the key with " + v.name + "…"; msg.style.color = "";
        try {
          const r = await api.putKey(v.id, Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])));
          this.vendors = await api.vendors(); this.render();
          if (!r.verified) void tell("Key saved", `${v.name} could not be reached to check it.`);
        } catch (e) { msg.textContent = errText(e); msg.style.color = "var(--err,#E6090D)"; save.disabled = false; }
      } }, "Save");
      card.append(h("div", { style: "display:flex;gap:6px;margin-top:10px;align-items:center" }, save,
        v.key_source === "yours" ? h("button", { class: "kp-btn", type: "button", onclick: async () => { try { await api.deleteKey(v.id); this.vendors = await api.vendors(); } catch (e) { void tell("The key could not be removed", errText(e)); } this.render(); } }, "Remove") : null,
        h("a", { href: v.signup, target: "_blank", rel: "noreferrer", style: "margin-left:auto;font-size:12px" }, "Get a key ↗")), msg);
      return card;
    }));
  }
}

let current: PartsDialog | null = null;
/** A context as of now: the document or sheet may have changed since the dialog opened. */
let ctxSource: (() => ToolCtx | null) | null = null;
function freshCtx(fallback: ToolCtx): ToolCtx { const c = ctxSource ? ctxSource() : null; return c && c.doc ? c : fallback; }

export function setCtxSource(fn: () => ToolCtx | null) { ctxSource = fn; }
export function openParts(opts: Opts = {}): void { if (current) current.close(); current = new PartsDialog({ ...opts, ctx: opts.ctx || (ctxSource ? ctxSource() : null) }); }
export function closeParts(): void { if (current) current.close(); }
export function isOpen(): boolean { return !!current; }
