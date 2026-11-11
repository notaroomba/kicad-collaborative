// help-dialogs.ts — Help > List Hotkeys... and Help > About, in the KiCad dialog shell (kicad-dialogs.js).
//
// The hotkey list is DIALOG_LIST_HOTKEYS: PANEL_HOTKEYS_EDITOR read-only — a filter box over a list grouped by
// section ("Common", then the editor's own) with the Command, Hotkey, Alternate and Description columns — fed
// from every TOOL_ACTION (web/menuspec.ts) plus the keys only the web editor has.  Commands the web editor does
// not implement are listed greyed, as the desktop's.  About follows common/dialog_about: icon, name and
// version, then the About / Version / License pages.
import { hotkeyRows, hotkeyOwners, normKey, type HotkeyRow } from "../menuspec";
import { PRODUCT_VERSION } from "../generated/product-version";
import { EXTRA_TOOLS } from "../tables";
import { state } from "./appstore";
import { kicadActionAvailable } from "./hotkeys";
import { E } from "./state";
import { activeModule } from "./tools";
import { esc, toast } from "./util";
import { isSch } from "./view";

interface DialogSpec { title: string; width?: number; build(body: HTMLElement): void; okLabel?: string; ok?(): boolean | void }
const dialogs = () => (window as unknown as { KDialogs?: { open(spec: DialogSpec): void } }).KDialogs;
interface Keyed { id: string; label: string; key?: string | null }

/** An informational dialog has one button: hide the shell's Cancel. */
function singleButton(body: HTMLElement): void {
  const foot = body.parentElement && body.parentElement.querySelector(".kd-foot");
  const cancel = foot && foot.querySelector<HTMLElement>(".btn:not(.primary)"); if (cancel) cancel.style.display = "none";
}

/** The keys that exist only here: the collaboration tools and whatever a tool module binds beyond KiCad's defaults. */
function webRows(): HotkeyRow[] {
  const ed = isSch() ? "sch" : "pcb"; const out: HotkeyRow[] = [];
  for (const t of EXTRA_TOOLS) if (t.key) out.push({ section: "KiCad Collaborative", id: t.id, label: t.name, key: t.key, alt: "", tip: "" });
  out.push({ section: "KiCad Collaborative", id: "cancel", label: "Cancel / Select Tool", key: "Esc", alt: "", tip: "End the current operation; press again to return to the selection tool" });
  const mod = activeModule() as { tools?: Keyed[]; actions?: Record<string, Keyed> } | null;
  const seen = new Set<string>();
  for (const a of [...((mod && mod.tools) || []), ...Object.values((mod && mod.actions) || {})]) {
    if (!a || !a.key) continue;
    const key = normKey(String(a.key).replace(/^Delete$/, "Del").replace(/^Insert$/, "Ins").replace(/\+Delete$/, "+Del"));
    if (hotkeyOwners(ed, key).length || seen.has(key + a.label)) continue;      // KiCad's own binding: already in the lists above
    seen.add(key + a.label);
    out.push({ section: "KiCad Collaborative", id: a.id, label: a.label.replace(/…/g, "..."), key, alt: "", tip: "" });
  }
  return out;
}

export function openHotkeyList(): void {
  const D = dialogs(); if (!D) return;
  const inEditor = (state as { view?: string }).view === "editor" && !!E.kdoc;
  const ed = isSch() ? "sch" : "pcb";
  const rows = [...hotkeyRows(ed), ...(inEditor ? webRows() : [])];
  D.open({ title: "Hotkey List", width: 760,
    build(body) {
      body.innerHTML = `<input id="hkFilter" type="text" placeholder="Type filter text" autocomplete="off" spellcheck="false" style="margin-bottom:8px">
        <div id="hkList" style="height:min(60vh,520px);overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel)"></div>
        <p class="kd-note" style="margin:8px 0 0">Default hotkeys of KiCad. Greyed commands run in the desktop app.</p>`;
      const list = body.querySelector<HTMLElement>("#hkList")!, filter = body.querySelector<HTMLInputElement>("#hkFilter")!;
      const avail = new Map<string, boolean>();
      const isAvail = (r: HotkeyRow) => { if (r.section === "KiCad Collaborative" || !inEditor) return true; let v = avail.get(r.id); if (v === undefined) { v = kicadActionAvailable(r.id); avail.set(r.id, v); } return v; };
      const draw = () => {
        const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const hit = (r: HotkeyRow) => { const hay = `${r.label} ${r.key} ${r.alt} ${r.tip}`.toLowerCase(); return words.every((w) => hay.includes(w)); };
        const th = "position:sticky;top:0;background:var(--panel-2);text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-weight:600";
        let html = `<table style="width:100%;border-collapse:collapse"><thead><tr><th style="${th}">Command</th><th style="${th};width:110px">Hotkey</th><th style="${th};width:90px">Alternate</th><th style="${th}">Description</th></tr></thead><tbody>`;
        let section = "", n = 0;
        for (const r of rows) {
          if (!hit(r)) continue;
          if (r.section !== section) { section = r.section; html += `<tr class="hk-sec"><td colspan="4" style="padding:5px 8px;font-weight:700;background:var(--bench)">${esc(section)}</td></tr>`; }
          const dim = isAvail(r) ? "" : "opacity:.5;";
          html += `<tr data-hk="${esc(r.id)}" style="${dim}"><td style="padding:2px 8px 2px 22px">${esc(r.label)}</td><td style="padding:2px 8px;font-family:var(--mono)">${esc(r.key)}</td><td style="padding:2px 8px;font-family:var(--mono)">${esc(r.alt)}</td><td style="padding:2px 8px;color:var(--ink-2)">${esc(r.tip)}</td></tr>`;
          n++;
        }
        html += "</tbody></table>";
        list.innerHTML = n ? html : '<p class="kd-note" style="padding:10px">No commands match the filter.</p>';
      };
      filter.addEventListener("input", draw);
      draw(); singleButton(body);
      setTimeout(() => filter.focus(), 0);
    } });
}

const RELEASES = "https://github.com/notaroomba/kicad-collaborative/releases";
const SOURCE = "https://github.com/notaroomba/kicad-collaborative";
const LOGO = `<svg viewBox="0 0 32 32" width="64" height="64" aria-hidden="true"><rect width="32" height="32" rx="5" fill="#001023"/><path d="M10.5 10.5 L21.5 21.5" stroke="#F2EDA1" stroke-width="2.6" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="4.2" fill="#C83434"/><circle cx="21.5" cy="21.5" r="4.2" fill="#4D7FC4"/></svg>`;

/** The text KiCad's "Copy Version Info" puts on the clipboard, for this client. */
export function versionInfo(): string {
  const spec = (window as unknown as { KiCadCanvas?: { VERSION?: string } }).KiCadCanvas;
  return [`Application: KiCad Collaborative web editor`, `Version: ${PRODUCT_VERSION}, based on KiCad 10.99`, `Platform: ${navigator.platform || "browser"}, ${navigator.userAgent}`,
    `Display: ${window.innerWidth}x${window.innerHeight} @ ${window.devicePixelRatio || 1}x`, `Locale: ${navigator.language}`, spec && spec.VERSION ? `Canvas: ${spec.VERSION}` : ""].filter(Boolean).join("\n");
}

export function openAbout(): void {
  const D = dialogs(); if (!D) return;
  const link = (url: string, text?: string) => `<a href="${url}" target="_blank" rel="noreferrer">${esc(text || url)}</a>`;
  const pages: Record<string, string> = {
    About: `<p><b><u>Description</u></b></p><p>The KiCad EDA Suite is a set of open source applications for the creation of electronic schematics and printed circuit boards.</p>
      <p>KiCad Collaborative adds real-time collaboration: several people edit the same schematic and board at once, in the desktop application or in this web editor, with live cursors, comments and version history.</p>
      <p><b><u>KiCad Collaborative on the web</u></b></p><ul><li>Source code - ${link(SOURCE)}</li><li>Desktop application - ${link(RELEASES)}</li></ul>
      <p><b><u>KiCad on the web</u></b></p><ul><li>The official KiCad website - ${link("http://www.kicad.org")}</li><li>Developer website - ${link("https://go.kicad.org/dev")}</li><li>Official KiCad library repositories - ${link("https://go.kicad.org/libraries")}</li></ul>
      <p><b><u>KiCad users group and community</u></b></p><ul><li>KiCad forum - ${link("https://go.kicad.org/forum")}</li></ul>`,
    Version: `<pre id="abVersion" style="margin:0;white-space:pre-wrap;font-family:var(--mono);user-select:text">${esc(versionInfo())}</pre>`,
    License: `<p>The complete KiCad EDA Suite is released under the</p><p><b>GNU General Public License (GPL) version 3 or any later version</b></p>
      <p>KiCad Collaborative is a fork of KiCad and is distributed under the same license. The source code is available from ${link(SOURCE)}.</p>`,
  };
  D.open({ title: "About KiCad Collaborative", width: 640,
    build(body) {
      body.innerHTML = `<div style="display:flex;gap:16px;align-items:center;margin-bottom:12px">${LOGO}<div><div style="font-size:20px;font-weight:700">KiCad Collaborative</div>
        <div style="font-family:var(--mono);color:var(--ink-2);margin-top:2px" id="abVer">Version: ${esc(PRODUCT_VERSION)}, web editor</div><div style="color:var(--ink-2);margin-top:2px">Based on KiCad 10.99</div></div></div>
        <div id="abTabs" style="display:flex;gap:2px;border-bottom:1px solid var(--line)">${Object.keys(pages).map((t, i) => `<button type="button" data-tab="${t}" class="${i ? "" : "on"}" style="border:1px solid var(--line);border-bottom:0;border-radius:var(--r-3) var(--r-3) 0 0;padding:5px 12px;background:${i ? "transparent" : "var(--panel)"};color:var(--ink);font:inherit;cursor:pointer">${t}</button>`).join("")}</div>
        <div id="abPage" style="height:260px;overflow:auto;border:1px solid var(--line);border-top:0;background:var(--panel);padding:10px 14px;line-height:1.5"></div>
        <div style="margin-top:10px"><button type="button" class="btn" id="abCopy">Copy Version Info</button></div>`;
      const page = body.querySelector<HTMLElement>("#abPage")!;
      const show = (t: string) => { page.innerHTML = pages[t] || ""; body.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle("on", on); b.style.background = on ? "var(--panel)" : "transparent"; b.style.fontWeight = on ? "600" : "400"; }); };
      body.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab || "About")));
      body.querySelector("#abCopy")!.addEventListener("click", (ev) => {
        const btn = ev.currentTarget as HTMLElement;
        navigator.clipboard.writeText(versionInfo()).then(() => { btn.textContent = "Copied..."; }, () => toast("Could not open clipboard to write version information."));
      });
      show("About"); singleButton(body);
    } });
}
