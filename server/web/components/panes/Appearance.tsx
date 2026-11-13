// Appearance.tsx — the board's Appearance manager (pcbnew/widgets/appearance_controls.cpp): the
// Layers / Objects / Nets tabs, their display-option sections, and the Presets and Viewports
// choices under them.  The model lives in the editor bundle (web/editor/panels/appearance.ts) and
// every control here goes through CollabPanels.dispatch.  The schematic has no such pane in KiCad;
// its minimal version lists the layers and the items.  `#layers` keeps its id: pcb-tools.js
// watches it to know when a document's layer list was rebuilt.
import { Select } from "../Select";
import { useState } from "react";
import type { LayerInfo, LayerMenuCmd, NetClassRow, NetCmd, NetRow } from "../../panels-api";
import { dispatch, useApp, type ItemSummary } from "../../store";
import { cx } from "../../util";
import { KIcon } from "../Icon";
import { Collapsible, ColorPicker, ContextMenu, Swatch, pdispatch, useContextMenu, usePanels, type ColorAt, type MenuItem } from "./widgets";
import { IS_MAC, keyName } from "../../keys";

// A list row (`.layer`): flex, centred, 8px gap, 3px/4px padding, 2px radius; callers add the hover fill.
const ROW = "layer flex items-center gap-2 py-[3px] px-1 rounded-xs";
// The right-aligned mono count (`.layer .cnt`); `font: 11px var(--mono)` also reset weight and leading.
const CNT = "cnt ml-auto text-ink-3 text-xs font-mono font-normal leading-[normal]";

function fpName(fp: ItemSummary, sch: boolean): string {
  return sch ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()!) : (fp.lib || "?").split(":").pop()!;
}

function SchLayers() {
  const layers = useApp((s) => s.document.layers);
  const hidden = useApp((s) => s.document.hiddenLayers);
  const notice = useApp((s) => s.document.notice);
  if (notice) return <p className="note">{notice}</p>;
  if (!layers.length) return <p className="note">Nothing to show yet.</p>;
  return (
    <>
      {layers.map((l) => (
        <label className={cx(ROW, "hover:bg-panel")} key={l.key}>
          <input type="checkbox" className="m-0 accent-blue" data-lkey={l.key} checked={!hidden.includes(l.key)} onChange={(ev) => dispatch({ type: "setLayerVisible", key: l.key, visible: ev.target.checked })} />
          <span className="sw w-3.5 h-3.5 rounded-xs border border-black/40 flex-none" style={{ background: l.color }} /><span>{l.name}</span><span className={CNT}>{l.count}</span>
        </label>
      ))}
    </>
  );
}

function SchObjects() {
  const items = useApp((s) => s.document.items);
  const sheets = useApp((s) => s.document.sheets);
  const sch = useApp((s) => s.document.editor === "sch");
  const primary = useApp((s) => s.selection.primary);
  const [q, setQ] = useState("");
  const ql = q.toLowerCase();
  const list = items.filter((fp) => !ql || fpName(fp, sch).toLowerCase().includes(ql)).sort((a, b) => fpName(a, sch).localeCompare(fpName(b, sch)));
  return (
    <>
      <input id="objSearch" placeholder={sch ? "Filter symbols…" : "Filter footprints…"} value={q} onChange={(ev) => setQ(ev.target.value)}
        className="w-full mb-1.5 bg-canvas border border-line rounded-md py-1 px-1.5 text-ink" />
      <div id="objList">
        {sch && sheets.length ? (
          <>
            <div className={cx(ROW, "hover:bg-panel")}><span className="muted">Sheets</span><span className={CNT}>{sheets.length}</span></div>
            {sheets.map((sh) => (
              <div className={cx(ROW, "hover:bg-panel cursor-pointer pl-3.5")} key={sh.id} data-sheet={sh.file} onClick={() => dispatch({ type: "enterSheet", file: sh.file })}>
                <span>{sh.name || sh.file}</span><span className={CNT}>↗</span>
              </div>
            ))}
          </>
        ) : null}
        <div className={cx(ROW, "hover:bg-panel")}><span className="muted">{sch ? "Symbols" : "Footprints"}</span><span className={CNT}>{list.length}/{items.length}</span></div>
        {list.slice(0, 300).map((fp) => (
          // the selected row's fill used to be an inline style, which also beat the hover fill: keep both states
          <div className={cx(ROW, "cursor-pointer pl-3.5", primary && primary.id === fp.id ? "bg-panel-2 hover:bg-panel-2" : "hover:bg-panel")} key={fp.id} data-fp={fp.id}
            onClick={() => dispatch({ type: "selectItem", id: fp.id })}>
            <span>{fpName(fp, sch)}</span><span className={CNT}>{Math.round(fp.rot || 0)}°</span>
          </div>
        ))}
      </div>
    </>
  );
}


// ================================================================ board
/** The eye of a row (KiCad's BITMAP_TOGGLE with visibility / visibility_off). */
function Eye({ on, onChange, title, k }: { on: boolean; onChange: (on: boolean) => void; title?: string; k?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} data-eye={k} title={title} className={cx("eye flex-none w-4 h-4 p-0 border-0 bg-transparent cursor-pointer [&_svg]:w-4 [&_svg]:h-4", !on && "opacity-60")}
      onClick={(ev) => { ev.stopPropagation(); onChange(!on); }}>
      <KIcon name={on ? "visibility" : "visibility_off"} size={16} />
    </button>
  );
}
const ROW2 = "flex items-center gap-1.5 h-[20px] px-1 whitespace-nowrap";
const RADIO = "flex items-center gap-1 mr-2.5";

const LAYER_MENU: ([LayerMenuCmd, string] | "-")[] = [
  ["showAllCu", "Show All Copper Layers"], ["hideAllCu", "Hide All Copper Layers"], "-",
  ["hideAllButActive", "Hide All Layers But Active"], "-",
  ["showAllNonCu", "Show All Non Copper Layers"], ["hideAllNonCu", "Hide All Non Copper Layers"], "-",
  ["showAll", "Show All Layers"], ["hideAll", "Hide All Layers"], "-",
  ["frontAssembly", "Show Only Front Assembly Layers"], ["front", "Show Only Front Layers"], ["inner", "Show Only Inner Layers"], ["back", "Show Only Back Layers"], ["backAssembly", "Show Only Back Assembly Layers"],
];

function LayersTab({ pickColor }: { pickColor: (c: ColorAt) => void }) {
  const layers = usePanels((s) => s.appearance.layers);
  const active = usePanels((s) => s.appearance.active);
  const inactive = usePanels((s) => s.appearance.inactive);
  const flip = usePanels((s) => s.appearance.flip);
  const notice = useApp((s) => s.document.notice);
  const menu = useContextMenu();
  const hasInner = layers.some((l) => l.copper && l.key !== "F.Cu" && l.key !== "B.Cu");
  const items: MenuItem[] = LAYER_MENU.filter((m) => m === "-" || m[0] !== "inner" || hasInner).map((m) => m === "-" ? "-" : { label: m[1], run: () => pdispatch({ t: "layerMenu", cmd: m[0] }) });
  const swatch = (l: LayerInfo, ev: { clientX: number; clientY: number }) => pickColor({ x: ev.clientX, y: ev.clientY, title: `${l.name} color`, color: l.color, canClear: l.color.toLowerCase() !== l.defaultColor.toLowerCase(), clearLabel: "Reset to Default",
    set: (c) => pdispatch({ t: "layerColor", key: l.key, color: c }) });
  return (
    <>
      <div id="layers" className="flex-auto min-h-0 overflow-auto bg-paper py-0.5" onContextMenu={(ev) => menu.open(ev, items)}>
        {notice ? <p className="note px-2">{notice}</p> : !layers.length ? <p className="note px-2">Nothing to show yet.</p> : layers.map((l) => (
          <div key={l.key} className={cx("layer", ROW2, "cursor-default hover:bg-panel cur:bg-sel", l.key === active && "cur")} data-layer={l.key} title={l.tip}
            onClick={() => pdispatch({ t: "layerActive", key: l.key })}>
            <span className="arrow inline-block w-2.5 flex-none text-blue text-xs leading-none">{l.key === active ? "▶" : ""}</span>
            <Swatch color={l.color} title="Left double click or middle click for color change, right click for menu" onPick={(ev) => swatch(l, ev)} />
            <Eye on={l.visible} k={l.key} title="Click to make layer visible / hidden" onChange={(on) => pdispatch({ t: "layerVisible", key: l.key, on })} />
            <span className="lname">{l.name}</span>
          </div>
        ))}
      </div>
      <Collapsible title="Layer Display Options" id="layerOpts">
        <div className="mb-1">Inactive layers:</div>
        <div className="flex mb-1.5">
          {([["normal", "Normal", "Inactive layers will be shown in full color"], ["dim", "Dim", "Inactive layers will be dimmed"], ["hide", "Hide", "Inactive layers will be hidden"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kInactive" data-inactive={m} checked={inactive === m} onChange={() => pdispatch({ t: "inactive", mode: m })} />{label}</label>
          ))}
        </div>
        <label className="flex items-center gap-1.5"><input type="checkbox" className="m-0 accent-blue" data-flip checked={flip} onChange={(ev) => pdispatch({ t: "flip", on: ev.target.checked })} />Flip board view</label>
      </Collapsible>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </>
  );
}

function ObjectsTab() {
  const objects = usePanels((s) => s.appearance.objects);
  return (
    <div id="objects" className="flex-auto min-h-0 overflow-auto bg-paper py-0.5">
      {objects.map((o, i) => o.spacer ? <div key={"sp" + i} className="h-2.5" /> : (
        <div key={o.id} className={cx(ROW2, "hover:bg-panel")} data-object={o.id} title={o.tip}>
          {o.canHide ? <Eye on={!!o.visible} k={o.id} onChange={(on) => pdispatch({ t: "objVisible", id: o.id, on })} /> : <span className="w-4 flex-none" />}
          <span className="flex-auto min-w-0 overflow-hidden text-ellipsis">{o.label}</span>
          {o.opacity !== undefined ? (
            <input type="range" min={0} max={100} step={1} value={Math.round(o.opacity * 100)} data-opacity={o.id} title={`Set opacity of ${o.label.toLowerCase()}`}
              className="flex-none w-[84px] h-3 m-0 accent-blue" onChange={(ev) => pdispatch({ t: "objOpacity", id: o.id, value: +ev.target.value / 100 })} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function netMenu(n: NetRow, pick: (ev: { clientX: number; clientY: number }) => void, ev: { clientX: number; clientY: number }): MenuItem[] {
  const cmd = (c: NetCmd) => () => pdispatch({ t: "netCmd", cmd: c, name: n.name });
  return [
    { label: "Set Net Color", run: () => pick(ev) }, { label: "Clear Net Color", run: () => pdispatch({ t: "netColor", name: n.name, color: null }), disabled: !n.color }, "-",
    { label: `Highlight ${n.name}`, run: cmd("highlight") }, { label: `Select Tracks and Vias in ${n.name}`, run: cmd("select") }, { label: `Unselect Tracks and Vias in ${n.name}`, run: cmd("unselect") }, "-",
    { label: "Show All Nets", run: cmd("showAll") }, { label: "Hide All Other Nets", run: cmd("hideOthers") },
  ];
}
function classMenu(c: NetClassRow, pick: (ev: { clientX: number; clientY: number }) => void, ev: { clientX: number; clientY: number }): MenuItem[] {
  const cmd = (k: NetCmd) => () => pdispatch({ t: "classCmd", cmd: k, name: c.name });
  return [
    { label: "Set Netclass Color", run: () => pick(ev) }, { label: "Clear Netclass Color", run: () => pdispatch({ t: "classColor", name: c.name, color: null }), disabled: !c.color }, "-",
    { label: `Highlight Nets in ${c.name}`, run: cmd("highlight") }, { label: `Select Tracks and Vias in ${c.name}`, run: cmd("select") }, { label: `Unselect Tracks and Vias in ${c.name}`, run: cmd("unselect") }, "-",
    { label: "Show All Netclasses", run: cmd("showAll") }, { label: "Hide All Other Netclasses", run: cmd("hideOthers") },
  ];
}

function NetsTab({ pickColor }: { pickColor: (c: ColorAt) => void }) {
  const nets = usePanels((s) => s.appearance.nets);
  const classes = usePanels((s) => s.appearance.netClasses);
  const colorMode = usePanels((s) => s.appearance.netColorMode);
  const ratsMode = usePanels((s) => s.appearance.ratsnestMode);
  const [q, setQ] = useState("");
  const menu = useContextMenu();
  const ql = q.trim().toLowerCase();
  const list = ql ? nets.filter((n) => n.name.toLowerCase().includes(ql)) : nets;
  const netColor = (n: NetRow) => (ev: { clientX: number; clientY: number }) => pickColor({ x: ev.clientX, y: ev.clientY, title: `${n.name} color`, color: n.color, canClear: !!n.color, clearLabel: "Clear Net Color", set: (c) => pdispatch({ t: "netColor", name: n.name, color: c }) });
  const classColor = (c: NetClassRow) => (ev: { clientX: number; clientY: number }) => pickColor({ x: ev.clientX, y: ev.clientY, title: `${c.name} color`, color: c.color, canClear: !!c.color, clearLabel: "Clear Netclass Color", set: (v) => pdispatch({ t: "classColor", name: c.name, color: v }) });
  return (
    <>
      <div id="nets" className="flex flex-col flex-auto min-h-0 bg-paper">
        <div className="flex-none px-1.5 pt-1 font-semibold">Nets</div>
        <div className="flex-none px-1.5 py-1"><input id="netFilter" type="search" placeholder="Filter nets" value={q} onChange={(ev) => setQ(ev.target.value)} className="w-full bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" /></div>
        <div className="knets flex-[3_1_0] min-h-[60px] overflow-auto border-y border-line">
          {list.length ? list.slice(0, 600).map((n) => (
            <div key={n.name} className={cx(ROW2, "hover:bg-panel")} data-net={n.name} onContextMenu={(ev) => menu.open(ev, netMenu(n, netColor(n), ev))}>
              <Swatch color={n.color} title="Left double click or middle click for color change, right click for menu" onPick={netColor(n)} />
              <Eye on={n.visible} k={n.name} title="Show or hide ratsnest for this net" onChange={(on) => pdispatch({ t: "netVisible", name: n.name, on })} />
              <span className="overflow-hidden text-ellipsis">{n.name}</span>
            </div>
          )) : <p className="note px-2">{nets.length ? "No nets match the filter." : "This board has no nets yet."}</p>}
        </div>
        <div className="flex-none px-1.5 pt-1.5 pb-0.5 font-semibold">Net Classes</div>
        <div className="kclasses flex-[1_1_0] min-h-[44px] overflow-auto">
          {classes.map((c) => (
            <div key={c.name} className={cx(ROW2, "hover:bg-panel")} data-netclass={c.name} onContextMenu={(ev) => menu.open(ev, classMenu(c, classColor(c), ev))}>
              <Swatch color={c.color} title="Left double click or middle click for color change, right click for menu" onPick={classColor(c)} />
              <Eye on={c.visible} k={c.name} title="Show or hide ratsnest for nets in this class" onChange={(on) => pdispatch({ t: "classVisible", name: c.name, on })} />
              <span className="overflow-hidden text-ellipsis">{c.name}</span>
            </div>
          ))}
        </div>
      </div>
      <Collapsible title="Net Display Options" id="netOpts">
        <div className="mb-1" title="Choose when to show net and netclass colors">Net colors:</div>
        <div className="flex mb-1.5">
          {([["all", "All", "Net and netclass colors are shown on all copper items"], ["ratsnest", "Ratsnest", "Net and netclass colors are shown on the ratsnest only"], ["off", "None", "Net and netclass colors are not shown"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kNetColor" data-netcolor={m} checked={colorMode === m} onChange={() => pdispatch({ t: "netColorMode", mode: m })} />{label}</label>
          ))}
        </div>
        <div className="mb-1" title="Choose which ratsnest lines to display">Ratsnest display:</div>
        <div className="flex">
          {([["all", "All", "Show ratsnest lines to items on all layers"], ["visible", "Visible layers", "Show ratsnest lines to items on visible layers"], ["none", "None", "Hide all ratsnest lines"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kRats" data-rats={m} checked={ratsMode === m} onChange={() => pdispatch({ t: "ratsnestMode", mode: m })} />{label}</label>
          ))}
        </div>
      </Collapsible>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </>
  );
}

const SELECT = "w-full text-sm";
// include/dialogs/eda_view_switcher.h: on macOS the physical Control key (WXK_RAW_CONTROL, Cmd+Tab is the system's
// application switcher) and Option; elsewhere Ctrl and Shift.  APPEARANCE_CONTROLS::rebuildLayerPresetsWidget /
// rebuildViewportsWidget write the labels with KeyNameFromKeyCode over the form's "Ctrl+Tab" / "Alt+Tab".
const PRESET_SWITCH_KEY = IS_MAC ? "RawCtrl" : "Ctrl";
const VIEWPORT_SWITCH_KEY = IS_MAC ? "Alt" : "Shift";
function PresetsAndViewports() {
  const presets = usePanels((s) => s.appearance.presets);
  const builtin = usePanels((s) => s.appearance.builtinPresets);
  const preset = usePanels((s) => s.appearance.preset);
  const viewports = usePanels((s) => s.appearance.viewports);
  const viewport = usePanels((s) => s.appearance.viewport);
  const user = presets.filter((p) => !builtin.includes(p));
  return (
    <div className="flex-none px-1.5 py-1.5 border-t border-line bg-bench">
      <div className="mb-0.5" data-label="presets">Presets ({keyName(PRESET_SWITCH_KEY + "+Tab")}):</div>
      <Select id="presetSel" className={SELECT} title="Layer presets" value={preset || ""}
        options={[...(preset ? [] : [{ value: "", label: "(unsaved)" }]), ...builtin.map((p) => ({ value: p, label: p })), ...user.map((p) => ({ value: p, label: p })),
          { value: "\u0001sep", label: "---", sep: true }, { value: "\u0001save", label: "Save preset..." }, { value: "\u0001delete", label: "Delete preset...", disabled: !user.length }]}
        onChange={(v) => { if (v === "\u0001save") pdispatch({ t: "presetSave" }); else if (v === "\u0001delete") pdispatch({ t: "presetDelete" }); else if (v) pdispatch({ t: "preset", name: v }); }} />
      <div className="mt-1.5 mb-0.5" data-label="viewports">Viewports ({keyName(VIEWPORT_SWITCH_KEY + "+Tab")}):</div>
      <Select id="viewportSel" className={SELECT} title="Viewports" value={viewport && viewports.includes(viewport) ? viewport : ""}
        options={[{ value: "", label: "(unsaved)" }, ...viewports.map((p) => ({ value: p, label: p })),
          { value: "\u0001sep", label: "---", sep: true }, { value: "\u0001save", label: "Save viewport..." }, { value: "\u0001delete", label: "Delete viewport...", disabled: !viewports.length }]}
        onChange={(v) => { if (v === "\u0001save") pdispatch({ t: "viewportSave" }); else if (v === "\u0001delete") pdispatch({ t: "viewportDelete" }); else if (v) pdispatch({ t: "viewport", name: v }); }} />
    </div>
  );
}

const TABS = "ktabs flex flex-none border-b border-line bg-bench";
const TAB = "flex-1 bg-transparent border-0 border-b-2 border-b-transparent py-1 px-0 text-sm text-ink-2 on:text-ink on:border-b-blue on:bg-paper";

function BoardAppearance() {
  const [tab, setTab] = useState<"layers" | "objects" | "nets">("layers");
  const [color, setColor] = useState<ColorAt | null>(null);
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className={TABS}>
        {(["layers", "objects", "nets"] as const).map((t) => (
          <button type="button" key={t} className={cx(TAB, tab === t && "on")} data-atab={t} onClick={() => setTab(t)}>{t === "layers" ? "Layers" : t === "objects" ? "Objects" : "Nets"}</button>
        ))}
      </div>
      <div className={cx("flex flex-col flex-auto min-h-0", tab !== "layers" && "hidden")}><LayersTab pickColor={setColor} /></div>
      {tab === "objects" ? <ObjectsTab /> : null}
      {tab === "nets" ? <NetsTab pickColor={setColor} /> : null}
      <PresetsAndViewports />
      <ColorPicker at={color} onClose={() => setColor(null)} />
    </div>
  );
}

// ================================================================ schematic (minimal)
function SchAppearance() {
  const [tab, setTab] = useState<"layers" | "objects">("layers");
  return (
    <div className="kbody overflow-auto py-1.5 px-2 min-h-0 flex-auto bg-paper text-sm">
      <div className={cx(TABS, "-mt-1.5 -mx-2 mb-1.5")}>
        {(["layers", "objects"] as const).map((t) => (
          <button type="button" key={t} className={cx(TAB, tab === t && "on")} data-atab={t} onClick={() => setTab(t)}>{t === "layers" ? "Layers" : "Objects"}</button>
        ))}
      </div>
      <div id="layers" hidden={tab !== "layers"}><SchLayers /></div>
      <div id="objects" hidden={tab !== "objects"}>{tab === "objects" ? <SchObjects /> : null}</div>
    </div>
  );
}

export function AppearancePane() {
  const editor = useApp((s) => s.document.editor);
  return editor === "pcb" ? <BoardAppearance /> : <SchAppearance />;
}
