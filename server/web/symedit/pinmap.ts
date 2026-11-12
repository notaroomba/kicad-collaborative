// symedit/pinmap.ts — the Symbol Properties "Pin Map" page (PANEL_SYMBOL_PIN_MAP): one column per named pin map, a
// footprint row binding each map to a footprint (associated_footprints), one row per logical pin (stacked pins
// expanded).  A blank or identical pad resolves 1:1; a malformed bracketed pad is flagged red.  The column menu has
// Rename Map..., Reset '<map>' to 1:1 and Copy From...; a double click on a map's header renames it.
import * as M from "./model";
import { h, promptText, confirmBox } from "../dialogs/dom";
import { messageBox } from "../dialogs/sch-items";
import { showMenu, closeMenus } from "./ui";

export interface PinMapState {
  pins: { number: string; name: string; unit: number }[];
  maps: { name: string; pads: string[] }[];
  assocs: M.AssocFootprint[];
  dirty: boolean;
}
/** PANEL_SYMBOL_PIN_MAP::SetSymbol + rebuildGrid's cell values: `own` holds the symbol's own maps, `flat` its pins. */
export function pinMapState(own: M.Node, flat: M.Node): PinMapState {
  const pins = M.logicalPinRows(flat); const d = M.pinMapData(own);
  return { pins, assocs: d.assocs.map((a) => ({ ...a })), dirty: false,
    maps: d.maps.map((m) => { const e = new Map(m.entries); return { name: m.name, pads: pins.map((p) => (e.has(p.number) ? e.get(p.number)! : p.number)) }; }) };
}
/** harvestGrid: a map keeps an entry only where its pad is set and differs from the pin number. */
export function harvestPinMaps(st: PinMapState): M.PinMapDef[] {
  return st.maps.map((m) => ({ name: m.name, entries: st.pins.map((p, i): [string, string] => [p.number, m.pads[i]]).filter(([pin, pad]) => pad !== "" && pad !== pin) }));
}
/** makeUniqueMapName: map1, map2, … */
export function uniqueMapName(st: PinMapState): string { for (let i = 1; ; i++) if (!st.maps.some((m) => m.name === "map" + i)) return "map" + i; }
const validLibId = (s: string): boolean => { const k = s.indexOf(":"); return k > 0 && k < s.length - 1; };

export function pinMapPage(pg: HTMLElement, st: PinMapState, ro: boolean): void {
  let curCol = -1;
  const box = h("div", { id: "sp-pinmap", style: "height:300px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
  const add = h("button", { class: "btn", type: "button", id: "sp-pinmap-add", title: "Add pin map", disabled: ro, onclick: () => { st.maps.push({ name: uniqueMapName(st), pads: st.pins.map((p) => p.number) }); st.dirty = true; render(); } }, "+");
  const remove = h("button", { class: "btn", type: "button", id: "sp-pinmap-remove", title: "Remove pin map", style: "margin-left:25px", disabled: ro, onclick: () => void removeMap() }, "🗑");
  pg.append(box, h("div", { class: "kd-grid-btns", style: "display:flex;margin-top:6px" }, add, remove));

  const footprintOf = (name: string) => (st.assocs.find((a) => a.map === name) || { fpid: "" }).fpid;
  async function removeMap(): Promise<void> {
    if (!st.maps.length) return;
    let col = curCol;
    if (col < 0) { if (st.maps.length > 1) { await messageBox("Click a pin map column to choose which map to remove.", "Remove Pin Map"); return; } col = 0; }
    const m = st.maps[col]; if (!m) return;
    if (st.assocs.some((a) => a.map === m.name) && !(await confirmBox("Confirmation", `Remove pin map '${m.name}' and its footprint association?`, "Yes"))) return;
    st.maps.splice(col, 1); st.assocs = st.assocs.filter((a) => a.map !== m.name); curCol = -1; st.dirty = true; render();
  }
  async function rename(col: number): Promise<void> {
    const m = st.maps[col]; if (!m || ro) return;
    const v = await promptText("Rename Map", "Map name:", m.name); if (v === null) return;
    const nn = v.trim(); if (!nn || nn === m.name) return;
    if (st.maps.some((x) => x.name === nn)) { await messageBox(`A pin map named '${nn}' already exists.`, "Rename Map"); return; }
    for (const a of st.assocs) if (a.map === m.name) a.map = nn;
    m.name = nn; st.dirty = true; render();
  }
  async function setFootprint(col: number, value: string): Promise<void> {
    const m = st.maps[col]; if (!m) return;
    const fpid = value.trim();
    if (fpid && !validLibId(fpid)) { await messageBox("Invalid footprint identifier.", "Assign Footprint"); render(); return; }
    if (fpid && st.assocs.some((a) => a.map !== m.name && a.fpid === fpid)) { await messageBox("That footprint is already assigned to another pin map.", "Assign Footprint"); render(); return; }
    st.assocs = st.assocs.filter((a) => !(a.map === m.name && (fpid !== "" || a.fpid === fpid)));
    if (fpid) st.assocs.push({ fpid, map: m.name });
    else st.assocs = st.assocs.filter((a) => a.map !== m.name);
    st.dirty = true; render();
  }
  function colMenu(ev: MouseEvent, col: number): void {
    ev.preventDefault(); if (ro) return; curCol = col;
    // Escape closes the menu, not the dialog under it
    const esc = (k: KeyboardEvent) => { if (!document.querySelector(".se-menu")) { window.removeEventListener("keydown", esc, true); return; } if (k.key === "Escape") { k.preventDefault(); k.stopImmediatePropagation(); closeMenus(); window.removeEventListener("keydown", esc, true); } };
    window.addEventListener("keydown", esc, true);
    const others = st.maps.map((m, i) => ({ m, i })).filter((x) => x.i !== col);
    showMenu(ev.clientX, ev.clientY, [
      { label: "Rename Map...", run: () => void rename(col) },
      { label: `Reset '${st.maps[col].name}' to 1:1`, run: () => { st.maps[col].pads = st.pins.map((p) => p.number); st.dirty = true; render(); } },
      ...(others.length ? [{ label: "Copy From...", sub: others.map(({ m, i }) => ({ label: m.name, run: () => { closeMenus(); st.maps[col].pads = [...st.maps[i].pads]; st.dirty = true; render(); } })) }] : []),
    ]);
  }
  function render(): void {
    box.innerHTML = "";
    const th = "position:sticky;top:0;background:var(--panel-2,var(--panel));border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;font-weight:500;white-space:nowrap";
    const td = "border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:2px 6px;white-space:nowrap";
    const table = h("table", { style: "border-collapse:collapse;width:100%;font-size:12px" });
    const hr = h("tr", null, h("th", { style: th }, "Unit"), h("th", { style: th }, "Symbol Pin"), h("th", { style: th }, "Name"));
    st.maps.forEach((m, c) => {
      const cell = h("th", { style: th + ";min-width:84px;cursor:default", "data-map": m.name, title: "Double-click to rename" }, m.name);
      cell.addEventListener("dblclick", () => void rename(c)); cell.addEventListener("contextmenu", (ev) => colMenu(ev, c));
      hr.append(cell);
    });
    table.append(h("thead", null, hr));
    const tb = h("tbody");
    const fr = h("tr", null, h("td", { style: td + ";color:var(--ink-2)", colspan: 3 }, "Footprint"));
    st.maps.forEach((m, c) => {
      const inp = h("input", { type: "text", value: footprintOf(m.name), disabled: ro, "data-fp": m.name, style: "flex:1;min-width:0;border:0;background:transparent;padding:1px 2px" }) as HTMLInputElement;
      inp.addEventListener("focus", () => (curCol = c)); inp.addEventListener("change", () => void setFootprint(c, inp.value));
      const browse = h("button", { class: "btn sm", type: "button", disabled: ro, title: "Browse footprints", style: "padding:0 4px;min-width:0", onclick: async () => {
        curCol = c;
        const L = (window as unknown as { KiCadLibrary?: { openChooser(k: "footprint", o?: { title?: string }): Promise<{ fpid?: string; libId?: string } | null> } }).KiCadLibrary;
        if (!L) return; const ch = await L.openChooser("footprint", { title: "Choose Footprint" }); const id = ch && (ch.fpid || ch.libId); if (id) void setFootprint(c, id);
      } }, "…");
      const cell = h("td", { style: td }, h("div", { style: "display:flex;gap:2px;align-items:center" }, inp, browse)); cell.addEventListener("contextmenu", (ev) => colMenu(ev, c));
      fr.append(cell);
    });
    tb.append(fr);
    st.pins.forEach((p, r) => {
      const tr = h("tr", null, h("td", { style: td + ";color:var(--ink-2)" }, p.unit > 0 ? String(p.unit) : "-"), h("td", { style: td + ";color:var(--ink-2)" }, p.number), h("td", { style: td + ";color:var(--ink-2)" }, p.name));
      st.maps.forEach((m, c) => {
        const inp = h("input", { type: "text", value: m.pads[r], disabled: ro, "data-pad": `${m.name}:${p.number}`, style: "width:100%;border:0;background:transparent;padding:1px 2px" }) as HTMLInputElement;
        const paint = () => { const ok = inp.value === "" || M.expandStacked(inp.value).valid; cell.style.background = ok ? "" : "color-mix(in srgb, var(--err) 30%, transparent)"; };
        inp.addEventListener("focus", () => (curCol = c));
        inp.addEventListener("input", () => { m.pads[r] = inp.value; st.dirty = true; paint(); });
        const cell = h("td", { style: td }, inp); cell.addEventListener("contextmenu", (ev) => colMenu(ev, c));
        paint(); tr.append(cell);
      });
      tb.append(tr);
    });
    table.append(tb); box.append(table);
    (remove as HTMLButtonElement).disabled = ro || !st.maps.length;
  }
  render();
}
