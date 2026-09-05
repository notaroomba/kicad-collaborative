// kicad-ui.js — the editor chrome, laid out like the desktop: KiCad's own toolbars
// (top main, top aux, left options, right draw tools) built from kicad-ui-spec.js
// (generated from the C++ toolbar configs, TOOL_ACTIONs and icon SVGs), the same
// menus, docked panels with caption bars, and the desktop's status bar fields.
//
// app.js registers what each action does with KUI.init({ handlers, tools }); an
// action nobody handles keeps its place on the toolbar (same layout as the desktop)
// but is dimmed and explains that it runs in the desktop app.
(function (root) {
"use strict";
const U = root.KICAD_UI || { actions: {}, toolbars: {}, icons: {} };
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

// Which KiCad draw actions map to which tool ids in the web modules (sch-tools / pcb-tools).
const TOOL_MAP = {
  sch: { selectSetRect: "select", placeSymbol: "place", placePower: "power", drawWire: "wire", drawBus: "bus", placeBusWireEntry: "busentry",
    placeNoConnect: "noconnect", placeJunction: "junction", placeLabel: "label", placeClassLabel: "classlabel", placeGlobalLabel: "glabel",
    placeHierLabel: "hlabel", placeSchematicText: "text", drawTextBox: "textbox", drawRectangle: "rect", drawCircle: "circle", drawArc: "arc",
    drawLines: "lines", deleteTool: "delete", zoomTool: "zoomtool", measureTool: "measure" },
  pcb: { selectSetRect: "select", routeSingleTrack: "route", drawVia: "via", drawLine: "gline", drawArc: "garc", drawRectangle: "grect",
    drawCircle: "gcircle", drawPolygon: "gpoly", placeText: "gtext", deleteTool: "delete", measureTool: "measure", zoomTool: "zoomtool" },
};
// Toolbar toggles whose state app.js owns (checkable buttons) and radio groups.
const RADIO = { Units: ["millimetersUnits", "inchesUnits", "milsUnits"], "Crosshair modes": ["cursorSmallCrosshairs", "cursorFullCrosshairs", "cursor45Crosshairs"],
  "Line modes": ["lineModeFree", "lineMode90", "lineMode45"], "Selection modes": ["selectSetRect", "selectSetLasso"] };

const S = { editor: null, handlers: {}, tools: {}, appTools: new Set(), moduleTools: {}, on: {}, groupCur: {}, activeTool: "select", popup: null, filters: {}, paneState: {} };

// ---------------------------------------------------------------- icons
function icon(name, size) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "kicon"); svg.setAttribute("aria-hidden", "true");
  const ic = U.icons[name];
  svg.setAttribute("viewBox", ic ? ic.vb || "0 0 24 24" : "0 0 24 24");
  if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
  if (ic) {
    const l = document.createElementNS(svgNS, "g"); l.setAttribute("class", "lt"); l.innerHTML = ic.light || ic.dark || "";
    const d = document.createElementNS(svgNS, "g"); d.setAttribute("class", "dk"); d.innerHTML = ic.dark || ic.light || "";
    svg.appendChild(l); svg.appendChild(d);
  } else {
    svg.innerHTML = `<rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  }
  return svg;
}

// ---------------------------------------------------------------- toolbar construction
function actionOf(item) { return item.act ? U.actions[item.act] || item : item; }
function keyFor(item) {
  const tid = S.tools[item.id]; const mt = tid && S.moduleTools[tid];
  return (mt && mt.key) || item.key || "";
}
function titleFor(item) {
  const a = actionOf(item); const k = keyFor(item);
  let t = (a.label || item.id) + (k ? `  (${k})` : "");
  if (a.tip && a.tip !== a.label) t += "\n" + a.tip;
  const why = unavailable(item);
  if (why) t += "\n— " + why;
  return t;
}
// Why an action is dimmed: null when it works here.
function unavailable(item) {
  const id = item.id;
  if (S.handlers[id]) return null;
  const tid = S.tools[id];
  if (tid) return S.appTools.has(tid) || S.moduleTools[tid] ? null : "not available in the web editor yet";
  return "runs in the desktop app";
}
function buttonFor(item) {
  const b = document.createElement("button");
  b.className = "kb"; b.dataset.uiact = item.id; b.type = "button";
  const a = actionOf(item);
  b.appendChild(icon(a.icon || "options_generic"));
  b.title = titleFor(item);
  if (unavailable(item)) b.classList.add("desk");
  if (S.tools[item.id]) b.dataset.ktool = S.tools[item.id];
  b.addEventListener("click", (ev) => dispatch(item.id, ev, b));
  b.addEventListener("contextmenu", (ev) => { const h = S.handlers[item.id + ":menu"]; if (h) { ev.preventDefault(); h(ev, b); } });
  return b;
}
function groupFor(group) {
  const wrap = document.createElement("div"); wrap.className = "kgroup"; wrap.dataset.group = group.group;
  const cur = S.groupCur[group.group] || group.items[0].id;
  const main = buttonFor(group.items.find((i) => i.id === cur) || group.items[0]);
  main.classList.add("kmain");
  const arrow = document.createElement("button"); arrow.className = "karrow"; arrow.type = "button"; arrow.title = group.group;
  arrow.innerHTML = `<svg viewBox="0 0 8 8"><path d="M1 2.5h6L4 6z" fill="currentColor"/></svg>`;
  arrow.addEventListener("click", (ev) => { ev.stopPropagation(); openPalette(wrap, group); });
  main.addEventListener("pointerdown", (ev) => {           // press-and-hold also opens the palette, like wx
    const t = setTimeout(() => openPalette(wrap, group), 450);
    const up = () => { clearTimeout(t); main.removeEventListener("pointerup", up); main.removeEventListener("pointerleave", up); };
    main.addEventListener("pointerup", up); main.addEventListener("pointerleave", up);
  });
  wrap.appendChild(main); wrap.appendChild(arrow);
  return wrap;
}
function openPalette(wrap, group) {
  closePopup();
  const pal = document.createElement("div"); pal.className = "kpalette";
  for (const it of group.items) {
    const row = document.createElement("button"); row.type = "button"; row.className = "krow" + (unavailable(it) ? " desk" : "") + ((S.groupCur[group.group] || group.items[0].id) === it.id ? " cur" : "");
    row.appendChild(icon(actionOf(it).icon || "options_generic"));
    const lab = document.createElement("span"); lab.textContent = paletteLabel(it, group); row.appendChild(lab);
    const k = keyFor(it); if (k) { const kb = document.createElement("kbd"); kb.textContent = k; row.appendChild(kb); }
    row.title = titleFor(it);
    row.addEventListener("click", (ev) => { closePopup(); setGroupCurrent(group.group, it.id, wrap); dispatch(it.id, ev, row); });
    pal.appendChild(row);
  }
  const r = wrap.getBoundingClientRect(); const vertical = wrap.closest(".ktb-v");
  pal.style.left = (vertical ? (wrap.closest("#tbRight") ? r.left - 4 : r.right + 4) : r.left) + "px";
  pal.style.top = (vertical ? r.top : r.bottom + 2) + "px";
  document.body.appendChild(pal); S.popup = pal;
  if (vertical && wrap.closest("#tbRight")) { pal.style.left = (r.left - pal.offsetWidth - 4) + "px"; }
  setTimeout(() => document.addEventListener("pointerdown", onDocDown, { capture: true, once: true }), 0);
}
// KiCad's line-mode actions share one friendly name; when a group's labels collide, show the tooltips.
function paletteLabel(it, group) {
  const labels = group.items.map((x) => actionOf(x).label || x.id);
  const a = actionOf(it);
  return new Set(labels).size < labels.length && a.tip ? a.tip : (a.label || it.id);
}
function onDocDown(ev) { if (S.popup && !S.popup.contains(ev.target)) closePopup(); }
function closePopup() { if (S.popup) { S.popup.remove(); S.popup = null; } }
function setGroupCurrent(groupName, id, wrap) {
  S.groupCur[groupName] = id;
  const hosts = wrap ? [wrap] : $$(`.kgroup[data-group="${CSS.escape(groupName)}"]`);
  for (const w of hosts) {
    const group = findGroup(groupName); if (!group) continue;
    const it = group.items.find((i) => i.id === id); if (!it) continue;
    const old = w.querySelector(".kmain"); const nb = buttonFor(it); nb.classList.add("kmain");
    if (S.on[id]) nb.classList.add("on");
    if (old) w.replaceChild(nb, old);
  }
  syncToolState();
}
function findGroup(name) {
  const ed = S.editor && U.toolbars[S.editor]; if (!ed) return null;
  for (const items of Object.values(ed)) for (const it of items) if (it.group === name) return it;
  return null;
}
function control(item) {
  const c = item.control;
  const wrap = document.createElement("span"); wrap.className = "kctl"; wrap.dataset.control = c;
  if (c === "currentVariant") { wrap.innerHTML = `<select class="ksel" title="Select the current variant to display and edit."><option>&lt; Default &gt;</option></select>`; }
  else if (c === "overrideLocks") { wrap.innerHTML = `<label class="kcheck" title="Allow editing locked items"><input type="checkbox"> Override locks</label>`; }
  else if (c === "trackWidth") { wrap.innerHTML = `<select id="trackWidthSel" class="ksel" title="Select the track width"></select>`; }
  else if (c === "viaDiameter") { wrap.innerHTML = `<select id="viaSizeSel" class="ksel" title="Select the via size"></select>`; }
  else if (c === "viaStack") { wrap.innerHTML = `<select class="ksel" title="Via stack"><option>Through</option></select>`; }
  else if (c === "layerSelector") { wrap.innerHTML = `<select id="layerSel" class="ksel klayer" title="Active layer"></select>`; }
  else if (c === "gridSelect") { wrap.innerHTML = `<select id="gridSel" class="ksel" title="Grid"></select>`; }
  else if (c === "zoomSelect") { wrap.innerHTML = `<select id="zoomSel" class="ksel" title="Zoom"><option value="auto">Auto</option>${[10, 25, 50, 75, 100, 150, 200, 300, 500, 1000].map((z) => `<option value="${z}">${z}%</option>`).join("")}</select>`; }
  else if (c === "ipcScripting") { return null; }
  return wrap;
}
function buildBar(host, items, vertical) {
  host.innerHTML = ""; host.classList.toggle("ktb-v", !!vertical);
  for (const it of items) {
    if (it.sep) { const s = document.createElement("span"); s.className = "ksep"; host.appendChild(s); }
    else if (it.group) host.appendChild(groupFor(it));
    else if (it.control) { const c = control(it); if (c) host.appendChild(c); }
    else host.appendChild(buttonFor(it));
  }
}
function build(editor) {
  S.editor = editor;
  const bars = U.toolbars[editor] || {};
  buildBar($("#tbTop"), bars.top || [], false);
  const aux = $("#tbAux"); buildBar(aux, bars.aux || [], false); aux.hidden = !(bars.aux && bars.aux.length);
  buildBar($("#tbLeft"), bars.left || [], true);
  buildBar($("#tbRight"), bars.right || [], true);
  // collab tools the desktop keeps in its File menu get a small block at the foot of the draw toolbar
  const extra = $("#tbRight");
  const sep = document.createElement("span"); sep.className = "ksep"; extra.appendChild(sep);
  for (const [id, name, glyph] of [["collabComment", "Add comment", "<path d='M4 5h16v11H9l-5 4z'/>"], ["collabFollow", "Follow a collaborator", "<circle cx='12' cy='8' r='4'/><path d='M4 21a8 8 0 0116 0'/>"], ["pan", "Pan the view", "<path d='M8 13V6a1.5 1.5 0 013 0v5M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8a5 5 0 01-10 0v-2a1.5 1.5 0 013 0'/>"]]) {
    const b = document.createElement("button"); b.className = "kb glyph"; b.type = "button"; b.dataset.uiact = id;
    b.innerHTML = `<svg class="kicon stroke" viewBox="0 0 24 24">${glyph}</svg>`;
    const tid = S.tools[id]; if (tid) b.dataset.ktool = tid;
    const k = tid && S.appTools.has(tid) ? { collabComment: "C", pan: "H", collabFollow: "" }[id] : "";
    b.title = name + (k ? `  (${k})` : "");
    b.addEventListener("click", (ev) => dispatch(id, ev, b));
    extra.appendChild(b);
  }
  buildMenus(editor);
  for (const [id, on] of Object.entries(S.on)) setOn(id, on);
  for (const [g, id] of Object.entries(S.groupCur)) setGroupCurrent(g, id);
  syncToolState();
  applyPaneState();
}

// ---------------------------------------------------------------- dispatch
function dispatch(id, ev, el) {
  closePopup();
  const h = S.handlers[id];
  if (h) { try { h(ev, el); } catch (e) { console.warn(e); } return; }
  const tid = S.tools[id];
  if (tid && (S.appTools.has(tid) || S.moduleTools[tid])) { S.handlers.__setTool && S.handlers.__setTool(tid); return; }
  const a = U.actions[(el && el.dataset.act) || ""] || actionOf({ id });
  const label = a.label || id;
  if (S.handlers.__desktopOnly) S.handlers.__desktopOnly(label, tid ? "This tool isn't in the web editor yet." : "This runs in the desktop app.", el);
}
function syncToolState() {
  $$("[data-uiact]").forEach((b) => {
    const id = b.dataset.uiact; const tid = S.tools[id];
    const why = unavailable({ id });
    b.classList.toggle("desk", !!why);
    if (tid) b.classList.toggle("on", S.activeTool === tid);
  });
}
function setActiveTool(toolId) { S.activeTool = toolId; syncToolState(); }
function setOn(id, on) { S.on[id] = !!on; $$(`[data-uiact="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle("on", !!on)); }
function setRadio(groupName, id) { for (const other of RADIO[groupName] || []) S.on[other] = other === id; setGroupCurrent(groupName, id); setOn(id, true); }
function setModuleTools(list) { S.moduleTools = {}; for (const t of list || []) S.moduleTools[t.id] = t; syncToolState(); $$("[data-uiact]").forEach((b) => { const it = { id: b.dataset.uiact }; if (U.actions[actKey(b.dataset.uiact)]) b.title = titleFor(Object.assign({ act: actKey(b.dataset.uiact) }, U.actions[actKey(b.dataset.uiact)])); }); }
function actKey(id) { for (const k of Object.keys(U.actions)) if (U.actions[k].id === id) return k; return null; }

// ---------------------------------------------------------------- menus (eeschema/menubar.cpp, pcbnew/menubar_pcb_editor.cpp)
const MENUS = {
  sch: [
    ["File", ["save", "-", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "-", "schematicSetup", "-", "pageSettings", "print", "plot", "-", "archive", "clone", "-", "openInKicad", "home"]],
    ["Edit", ["undo", "redo", "-", "cut", "copy", "paste", "doDelete", "-", "selectAll", "-", "find", "findAndReplace", "-", "deleteTool"]],
    ["View", [["Panels", ["showProperties", "showHierarchy", "showSelectionFilter", "showHistory", "showPeers", "showComments", "showAppearance"]], "-", "showSymbolBrowser", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomTool", "zoomRedraw", "-", "navigateBack", "navigateUp", "navigateForward", "-", "toggleHiddenPins", "toggleGrid"]],
    ["Place", ["placeSymbol", "placePower", "drawWire", "drawBus", "placeBusWireEntry", "placeNoConnect", "placeJunction", "placeLabel", "placeGlobalLabel", "placeClassLabel", "drawRuleArea", "-", "placeHierLabel", "drawSheet", "placeSheetPin", "syncAllSheetsPins", "-", "placeSchematicText", "drawTextBox", "drawTable", "drawRectangle", "drawCircle", "drawArc", "drawBezier", "drawPolygon", "drawLines", "placeImage"]],
    ["Inspect", ["runERC", "-", "showSimulator"]],
    ["Tools", ["updatePcbFromSchematic", "showPcbNew", "-", "showSymbolEditor", "showFootprintEditor", "-", "annotate", "assignFootprints", "editSymbolFields", "generateBOM"]],
    ["Preferences", ["theme", "-", "openPreferences"]],
    ["Help", ["help", "gettingStarted", "-", "downloadDesktop", "sourceCode", "-", "about"]],
  ],
  pcb: [
    ["File", ["save", "-", "collabCopyLink", "collabComments", "collabFollow", "collabHistory", "collabLeave", "-", "boardSetup", "-", "pageSettings", "print", "plot", "-", "archive", "clone", "-", "openInKicad", "home"]],
    ["Edit", ["undo", "redo", "-", "cut", "copy", "paste", "doDelete", "-", "selectAll", "-", "find", "-", "deleteTool"]],
    ["View", [["Panels", ["showLayersManager", "showProperties", "showSelectionFilter", "showHistory", "showPeers", "showComments"]], "-", "showFootprintBrowser", "show3DViewer", "-", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "zoomFitObjects", "zoomTool", "zoomRedraw", "-", "toggleGrid", "togglePolarCoords", "-", "showRatsnest", "highContrastMode", "zoneDisplayFilled", "zoneDisplayOutline", "padDisplayMode", "viaDisplayMode", "trackDisplayMode"]],
    ["Place", ["placeFootprint", "drawVia", "drawZone", "drawRuleArea", "-", "drawLine", "drawArc", "drawRectangle", "drawCircle", "drawPolygon", "drawBezier", "placeText", "drawTextBox", "drawTable", "-", "drawAlignedDimension", "drawOrthogonalDimension", "drawCenterDimension", "drawRadialDimension", "drawLeader", "-", "placeReferenceImage", "-", "gridSetOrigin", "drillOrigin"]],
    ["Route", ["routeSingleTrack", "routeDiffPair", "-", "tuneSingleTrack", "tuneDiffPair", "tuneSkew"]],
    ["Inspect", ["runDRC", "-", "measureTool"]],
    ["Tools", ["updatePcbFromSchematic", "showEeschema", "-", "showFootprintEditor", "-", "editFootprintFields"]],
    ["Preferences", ["theme", "-", "openPreferences"]],
    ["Help", ["help", "gettingStarted", "-", "downloadDesktop", "sourceCode", "-", "about"]],
  ],
};
// Labels for entries that are ours rather than KiCad TOOL_ACTIONs.
const LOCAL_LABELS = { save: "Save Checkpoint…", collabCopyLink: "Copy Share Link", collabComments: "Comments…", collabFollow: "Follow Next Peer", collabHistory: "History",
  collabLeave: "Leave Session", archive: "Download Project (.zip)", clone: "Clone to My Account", openInKicad: "Open in KiCad Collaborative…", home: "Back to Projects",
  showSelectionFilter: "Selection Filter", showHistory: "History", showPeers: "Collaborators", showComments: "Comments", showAppearance: "Appearance",
  theme: "Toggle Dark Theme", downloadDesktop: "Download Desktop App ↗", sourceCode: "Source on GitHub ↗", about: "About KiCad Collaborative", help: "Help ↗", gettingStarted: "Getting Started with KiCad ↗" };
function menuLabel(id) {
  if (LOCAL_LABELS[id]) return LOCAL_LABELS[id];
  const k = actKey(id); const a = k && U.actions[k];
  return a ? a.label.replace(/\.\.\.$/, "…") : id;
}
function buildMenus(editor) {
  const host = $("#kmenus"); if (!host) return; host.innerHTML = "";
  for (const [title, entries] of MENUS[editor] || []) {
    const m = document.createElement("div"); m.className = "menu"; m.dataset.menu = title.toLowerCase();
    const b = document.createElement("button"); b.type = "button"; b.textContent = title; m.appendChild(b);
    const dd = document.createElement("div"); dd.className = "dd";
    const add = (parent, e) => {
      if (e === "-") { const s = document.createElement("div"); s.className = "sep"; parent.appendChild(s); return; }
      if (Array.isArray(e)) { const sub = document.createElement("div"); sub.className = "sub"; const t = document.createElement("button"); t.type = "button"; t.innerHTML = `<span>${e[0]}</span><span>›</span>`; sub.appendChild(t); const inner = document.createElement("div"); inner.className = "dd"; for (const x of e[1]) add(inner, x); sub.appendChild(inner); parent.appendChild(sub); return; }
      const row = document.createElement("button"); row.type = "button"; row.dataset.uiact = e;
      const k = keyFor({ id: e });
      row.innerHTML = `<span>${menuLabel(e)}</span>${k ? `<kbd>${k}</kbd>` : ""}`;
      if (unavailable({ id: e })) row.classList.add("desk");
      row.addEventListener("click", (ev) => { closeMenus(); dispatch(e, ev, row); });
      parent.appendChild(row);
    };
    for (const e of entries) add(dd, e);
    m.appendChild(dd); host.appendChild(m);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); const open = m.classList.contains("open"); closeMenus(); if (!open) m.classList.add("open"); });
    b.addEventListener("mouseenter", () => { if ($("#kmenus .menu.open") && !m.classList.contains("open")) { closeMenus(); m.classList.add("open"); } });
  }
  document.addEventListener("click", closeMenus);
}
function closeMenus() { $$("#kmenus .menu.open").forEach((m) => m.classList.remove("open")); }

// ---------------------------------------------------------------- docked panes (wxAUI-style captions)
const PANE_ACTION = { props: "showProperties", hier: "showHierarchy", filter: "showSelectionFilter", history: "showHistory", peers: "showPeers", comments: "showComments", appearance: "showLayersManager" };
function paneKey() { return "kui.panes." + (S.editor || "x"); }
function applyPaneState() {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(paneKey()) || "{}"); } catch (e) { /* no storage */ }
  S.paneState = saved;
  $$(".kpane").forEach((p) => {
    const name = p.dataset.pane; const only = p.dataset.editor;
    const allowed = !only || only === S.editor;
    const shown = allowed && (saved[name] !== undefined ? saved[name] : p.dataset.default !== "hidden");
    p.hidden = !shown;
    if (PANE_ACTION[name]) setOn(PANE_ACTION[name], shown);
  });
  $$(".kdock").forEach((d) => { d.hidden = !$$(".kpane", d).some((p) => !p.hidden); });
}
function showPane(name, show) {
  const p = $(`.kpane[data-pane="${CSS.escape(name)}"]`); if (!p) return;
  if (p.dataset.editor && p.dataset.editor !== S.editor) return;
  const next = show === undefined ? p.hidden : !!show;
  p.hidden = !next; S.paneState[name] = next;
  try { localStorage.setItem(paneKey(), JSON.stringify(S.paneState)); } catch (e) { /* no storage */ }
  if (PANE_ACTION[name]) setOn(PANE_ACTION[name], next);
  $$(".kdock").forEach((d) => { d.hidden = !$$(".kpane", d).some((q) => !q.hidden); });
  if (next) p.scrollIntoView({ block: "nearest" });
  if (S.handlers.__layout) S.handlers.__layout();
}
function paneVisible(name) { const p = $(`.kpane[data-pane="${CSS.escape(name)}"]`); return !!p && !p.hidden; }

// ---------------------------------------------------------------- selection filter (panel_*selection_filter_base)
const FILTERS = {
  sch: [["symbols", "Symbols"], ["pins", "Pins"], ["wires", "Wires"], ["labels", "Labels"], ["graphics", "Graphics"], ["images", "Images"], ["text", "Text"], ["other", "Other items"]],
  pcb: [["footprints", "Footprints"], ["text", "Text"], ["tracks", "Tracks"], ["vias", "Vias"], ["pads", "Pads"], ["graphics", "Graphics"], ["zones", "Zones"], ["dimensions", "Dimensions"], ["other", "Other items"]],
};
function buildFilter(editor) {
  const list = FILTERS[editor] || []; const f = S.filters[editor] = S.filters[editor] || Object.fromEntries(list.map(([k]) => [k, true]));
  $$(".kfilter").forEach((host) => {
    host.innerHTML = `<label class="kcb all"><input type="checkbox" data-f="all"> All items</label><div class="kfgrid">` +
      list.map(([k, l]) => `<label class="kcb"><input type="checkbox" data-f="${k}"> ${l}</label>`).join("") + `</div>` +
      `<label class="kcb locked"><input type="checkbox" data-f="locked" disabled> Locked items</label>`;
    const sync = () => { $$("input[data-f]", host).forEach((cb) => { if (cb.dataset.f === "all") cb.checked = list.every(([k]) => f[k]); else if (cb.dataset.f !== "locked") cb.checked = !!f[cb.dataset.f]; }); };
    $$("input[data-f]", host).forEach((cb) => cb.addEventListener("change", () => {
      if (cb.dataset.f === "all") for (const [k] of list) f[k] = cb.checked; else f[cb.dataset.f] = cb.checked;
      sync(); if (S.handlers.__filterChanged) S.handlers.__filterChanged(filter());
    }));
    sync();
  });
}
function filter() { return S.filters[S.editor] || {}; }

// ---------------------------------------------------------------- status bar (EDA_DRAW_FRAME::UpdateStatusBar)
const UNITS = { mm: { name: "mm", f: (v) => v, d: 4 }, in: { name: "in", f: (v) => v / 25.4, d: 4 }, mil: { name: "mils", f: (v) => v / 0.0254, d: 2 } };
let units = "mm";
function fmtLen(mm) { const u = UNITS[units]; return u.f(mm).toFixed(u.d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); }
function setUnits(u) { if (UNITS[u]) units = u; const el = $("#sbUnits"); if (el) el.textContent = UNITS[units].name; }
function status(f) {
  if (f.zoom !== undefined) { const el = $("#sbZoom"); if (el) el.textContent = "Z " + (f.zoom >= 10 ? f.zoom.toFixed(0) : f.zoom.toFixed(2)); }
  if (f.x !== undefined) { const el = $("#sbCursor"); if (el) el.textContent = `X ${fmtLen(f.x)}  Y ${fmtLen(f.y)}`; }
  if (f.dx !== undefined) { const el = $("#sbDelta"); if (el) el.textContent = f.polar ? `r ${fmtLen(Math.hypot(f.dx, f.dy))}  θ ${(Math.atan2(-f.dy, f.dx) * 180 / Math.PI).toFixed(1)}°` : `dx ${fmtLen(f.dx)}  dy ${fmtLen(f.dy)}  dist ${fmtLen(Math.hypot(f.dx, f.dy))}`; }
  if (f.grid !== undefined) { const el = $("#sbGrid"); if (el) el.textContent = `grid ${fmtLen(f.grid)} ${UNITS[units].name}`; }
  if (f.message !== undefined) { const el = $("#sbMsg"); if (el) el.textContent = f.message; }
}

// ---------------------------------------------------------------- init
function init(opts) {
  S.handlers = opts.handlers || {};
  S.appTools = new Set(opts.appTools || []);
  S.tools = Object.assign({}, TOOL_MAP.sch);          // filled per editor in setEditor
  applyTheme();
}
function setEditor(editor, moduleTools) {
  S.tools = Object.assign({ collabComment: "comment", collabFollow: "follow", pan: "pan" }, TOOL_MAP[editor] || {});
  S.moduleTools = {}; for (const t of moduleTools || []) S.moduleTools[t.id] = t;
  document.body.dataset.editor = editor;
  build(editor); buildFilter(editor);
}
function applyTheme() {
  const saved = (() => { try { return localStorage.getItem("kui.theme"); } catch (e) { return null; } })();
  if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kui.theme", next); } catch (e) { /* no storage */ }
}

root.KUI = { init, setEditor, setModuleTools, dispatch, setOn, setRadio, setActiveTool, setGroupCurrent, showPane, paneVisible, filter, buildFilter,
  status, setUnits, fmtLen, units: () => units, icon, toggleTheme, closePopup, TOOL_MAP, RADIO, spec: U };
})(window);
