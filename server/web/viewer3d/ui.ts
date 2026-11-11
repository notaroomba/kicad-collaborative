// viewer3d/ui.ts — the "3D Viewer" window: KiCad's EDA_3D_VIEWER_FRAME rebuilt as a floating,
// draggable, resizable panel over the board editor.  Menus follow 3d-viewer/3d_viewer/3d_menubar.cpp,
// the top toolbar toolbars_3d.cpp, the labels / tooltips / hotkeys / icons tools/eda_3d_actions.cpp, and
// the right-hand panel the rows of dialogs/appearance_controls_3D.cpp that the web viewer can draw.
import { BACKGROUND_BOTTOM, BACKGROUND_TOP, BOARD_BODY, RGBA, SILKSCREEN, SOLDER_MASK, SOLDER_PASTE, SURFACE_FINISH, css, fromHex, hex } from "./colors";
import ICONS from "./icons.json";
import { DEFAULT_VISIBILITY, Visibility } from "./scene";
import { Viewer } from "./viewer";

export interface OpenOptions {
  /** the board document to show (window.KiCadCanvas doc); null when no board is open */
  getDoc(): KDoc | null;
  /** board file name, for the title bar and the exported image's name */
  getName?(): string;
  /** called with a function to run whenever the document changes; returns the unsubscribe */
  subscribe?(onChange: () => void): () => void;
  toast?(text: string, ms?: number): void;
}

interface IconDef { vb?: string; light?: string; dark?: string }
const ICON_SET = ICONS as Record<string, IconDef>;

/** An action of the viewer: KiCad's friendly name, tooltip, icon and default hotkey. */
interface Action { id: string; label: string; tip?: string; icon?: string; key?: string; run(): void; checked?(): boolean; disabled?: string }
type MenuItem = Action | "-" | { label: string; icon?: string; sub: MenuItem[] };

const STYLE_ID = "v3d-style";
const CSS = `
.v3d-win{position:fixed;z-index:55;display:flex;flex-direction:column;min-width:420px;min-height:300px;background:var(--bench);color:var(--ink);
  border:1px solid var(--line);border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.35);font:12px var(--font);outline:none;overflow:hidden}
.v3d-win.v3d-max{border-radius:0}
.v3d-title{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 10px;background:var(--paper);border-bottom:1px solid var(--line);cursor:move;user-select:none;font-weight:600;flex:none}
.v3d-title .v3d-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v3d-title button{all:unset;cursor:pointer;color:var(--ink-2);width:22px;height:20px;display:grid;place-items:center;border-radius:3px;font-size:14px;line-height:1}
.v3d-title button:hover{background:var(--line);color:var(--ink)}
.v3d-menubar{display:flex;gap:0;padding:0 4px;background:var(--bench);border-bottom:1px solid var(--line);flex:none;user-select:none}
.v3d-menubar>button{all:unset;padding:4px 9px;cursor:default;border-radius:3px}
.v3d-menubar>button:hover,.v3d-menubar>button.open{background:var(--accent);color:var(--on-accent)}
.v3d-menu{position:fixed;z-index:70;min-width:230px;padding:4px 0;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:4px;box-shadow:var(--shadow);font:12px var(--font);user-select:none}
.v3d-menu .v3d-mi{display:grid;grid-template-columns:22px 1fr auto 12px;align-items:center;gap:6px;padding:3px 10px 3px 6px;cursor:default;white-space:nowrap;position:relative}
.v3d-menu .v3d-mi:hover{background:var(--accent);color:var(--on-accent)}
.v3d-menu .v3d-mi.dis{color:var(--ink-3)}
.v3d-menu .v3d-mi.dis:hover{background:none;color:var(--ink-3)}
.v3d-menu .v3d-mi .k{color:var(--ink-3);font-size:11px;padding-left:18px}
.v3d-menu .v3d-mi:hover .k{color:#fff}
.v3d-menu .v3d-mi .chk{width:16px;text-align:center}
.v3d-menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}
.v3d-ic{display:block;width:24px;height:24px}
.v3d-menu .v3d-ic{width:18px;height:18px}
.v3d-ic .dk{display:none}
:root[data-theme="dark"] .v3d-ic .lt{display:none}
:root[data-theme="dark"] .v3d-ic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .v3d-ic .lt{display:none}:root:not([data-theme="light"]) .v3d-ic .dk{display:inline}}
.v3d-toolbar{display:flex;align-items:center;gap:1px;padding:2px 4px;background:var(--bench);border-bottom:1px solid var(--line);flex:none;flex-wrap:wrap}
.v3d-toolbar button{all:unset;width:28px;height:28px;display:grid;place-items:center;border-radius:3px;cursor:pointer}
.v3d-toolbar button:hover{background:var(--line)}
.v3d-toolbar button.on{background:var(--line);box-shadow:inset 0 0 0 1px var(--blue)}
.v3d-toolbar button.dis{opacity:.35;cursor:default}
.v3d-toolbar button.dis:hover{background:none}
.v3d-toolbar .sep{width:1px;height:20px;background:var(--line);margin:0 4px}
.v3d-body{flex:1;display:flex;min-height:0}
.v3d-stage{flex:1;min-width:0;position:relative;overflow:hidden}
.v3d-msg{position:absolute;inset:0;display:grid;place-items:center;color:#1b1b1b;font-size:13px;text-align:center;padding:20px;pointer-events:none}
.v3d-side{width:212px;flex:none;border-left:1px solid var(--line);background:var(--bench);overflow:auto;padding:6px 0}
.v3d-side h4{margin:2px 10px 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.v3d-row{display:grid;grid-template-columns:18px 18px 1fr;align-items:center;gap:6px;padding:2px 10px;cursor:default}
.v3d-row:hover{background:var(--paper)}
.v3d-row .sw{width:14px;height:14px;border:1px solid var(--line-2);border-radius:2px;box-sizing:border-box}
.v3d-row input[type=checkbox]{margin:0;width:14px;height:14px}
.v3d-row input[type=color]{width:18px;height:16px;padding:0;border:1px solid var(--line-2);border-radius:2px;background:none;grid-column:1 / span 2;justify-self:start}
.v3d-side hr{border:0;border-top:1px solid var(--line);margin:6px 0}
.v3d-status{display:flex;gap:16px;padding:3px 10px;border-top:1px solid var(--line);background:var(--bench);color:var(--ink-2);font:11px var(--mono);flex:none;white-space:nowrap;overflow:hidden}
.v3d-status .grow{flex:1;overflow:hidden;text-overflow:ellipsis}
.v3d-grip{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;z-index:2;
  background:linear-gradient(135deg,transparent 50%,var(--ink-3) 50%,var(--ink-3) 58%,transparent 58%,transparent 70%,var(--ink-3) 70%,var(--ink-3) 78%,transparent 78%)}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
}

/** One of KiCad's icons (light and dark variants; the theme picks, as the editor chrome's KIcon does). */
function icon(name: string | undefined): HTMLElement {
  const wrap = el("span"); const ic = name ? ICON_SET[name] : undefined;
  if (!ic) return wrap;
  wrap.innerHTML = `<svg class="v3d-ic" viewBox="${ic.vb || "0 0 24 24"}" aria-hidden="true"><g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g></svg>`;
  return wrap.firstElementChild as HTMLElement;
}

/** Does a keyboard event match a hotkey in KiCad's notation ("Shift+Z", "Left", "Home")? */
function keyMatches(ev: KeyboardEvent, key: string): boolean {
  const parts = key.split("+"); const k = parts[parts.length - 1];
  const want = { shift: parts.includes("Shift"), ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt") };
  if (ev.shiftKey !== want.shift || (ev.ctrlKey || ev.metaKey) !== want.ctrl || ev.altKey !== want.alt) return false;
  const named: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Home: "Home" };
  if (named[k]) return ev.key === named[k];
  return ev.key.toUpperCase() === k.toUpperCase();
}

export class ViewerWindow {
  readonly root: HTMLDivElement;
  readonly viewer: Viewer | null = null;
  private opts: OpenOptions;
  private actions = new Map<string, Action>();
  private toolButtons = new Map<string, HTMLButtonElement>();
  private nameEl: HTMLElement; private stage: HTMLDivElement; private side: HTMLDivElement; private statusEl: HTMLElement; private zoomEl: HTMLElement;
  private menu: HTMLElement[] = [];
  private menuButton: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private reloadTimer = 0;
  private restore: { left: string; top: string; width: string; height: string } | null = null;
  private onDocPointer = (ev: Event) => { if (this.menu.length && !this.menu.some((m) => m.contains(ev.target as Node)) && !(this.menuButton && this.menuButton.contains(ev.target as Node))) this.closeMenu(); };
  private onWinResize = () => this.clamp();
  closed = false;
  /** the last build's statistics and time (tests) */
  lastBuildMs = 0;
  builds = 0;

  constructor(opts: OpenOptions) {
    ensureStyle();
    this.opts = opts;
    const root = this.root = el("div", "v3d-win"); root.tabIndex = -1; root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "3D Viewer");
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(480, Math.min(1100, Math.round(vw * 0.62))), h = Math.max(360, Math.min(820, Math.round(vh * 0.72)));
    root.style.width = w + "px"; root.style.height = h + "px";
    root.style.left = Math.max(8, Math.round((vw - w) / 2)) + "px"; root.style.top = Math.max(8, Math.round((vh - h) / 2)) + "px";

    // ---- title bar
    const title = el("div", "v3d-title"); title.appendChild(icon("three_d"));
    this.nameEl = el("span", "v3d-name"); title.appendChild(this.nameEl);
    const maxBtn = el("button", "v3d-maxbtn", "□"); maxBtn.title = "Maximize"; maxBtn.addEventListener("click", () => this.toggleMaximize());
    const closeBtn = el("button", "v3d-close", "✕"); closeBtn.title = "Close"; closeBtn.addEventListener("click", () => this.close());
    title.append(maxBtn, closeBtn); root.appendChild(title);
    title.addEventListener("dblclick", (ev) => { if (!(ev.target as HTMLElement).closest("button")) this.toggleMaximize(); });
    this.bindDrag(title);

    this.stage = el("div", "v3d-stage"); this.side = el("div", "v3d-side");
    try { this.viewer = new Viewer(this.stage); }
    catch (e) { console.warn("3D viewer: WebGL is not available", e); const m = el("div", "v3d-msg", "The 3D viewer needs WebGL, which this browser could not start."); this.stage.appendChild(m); }
    this.defineActions();

    // ---- menu bar, toolbar
    const menubar = el("div", "v3d-menubar");
    for (const [label, items] of this.menus()) {
      const b = el("button", undefined, label);
      b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); if (this.menuButton === b) this.closeMenu(); else this.openMenu(b, items); });
      b.addEventListener("pointerenter", () => { if (this.menuButton && this.menuButton !== b) this.openMenu(b, items); });
      menubar.appendChild(b);
    }
    root.appendChild(menubar);
    root.appendChild(this.buildToolbar());

    // ---- body: canvas + appearance panel, status bar
    const body = el("div", "v3d-body"); body.append(this.stage, this.side); root.appendChild(body);
    this.buildAppearance();
    const status = el("div", "v3d-status"); this.statusEl = el("span", "grow"); this.zoomEl = el("span");
    status.append(this.statusEl, this.zoomEl); root.appendChild(status);
    const grip = el("div", "v3d-grip"); root.appendChild(grip); this.bindResize(grip);

    root.addEventListener("keydown", (ev) => this.onKey(ev));
    // keep the keyboard on the viewer while the pointer works in it (the board editor's keys must not fire)
    root.addEventListener("pointerdown", (ev) => { const t = ev.target as HTMLElement; if (!t.closest("input,select,textarea")) setTimeout(() => { if (!this.closed && !root.contains(document.activeElement)) root.focus({ preventScroll: true }); }, 0); }, true);
    document.addEventListener("pointerdown", this.onDocPointer, true);
    window.addEventListener("resize", this.onWinResize);
    document.body.appendChild(root);
    if (this.viewer) this.viewer.onFrame = () => { this.zoomEl.textContent = "Zoom " + this.viewer!.zoomLevel.toFixed(2); };
    this.syncToggles(); this.updateTitle();
    root.focus({ preventScroll: true });
    if (opts.subscribe) this.unsubscribe = opts.subscribe(() => this.scheduleReload());
    this.reload(true);
  }

  // ---------------------------------------------------------------- actions

  private defineActions(): void {
    const v = this.viewer;
    const add = (a: Action) => { this.actions.set(a.id, a); };
    const vis = (key: keyof Visibility) => () => { if (v) { v.setVisibility({ [key]: !v.visibility[key] }); this.syncToggles(); } };
    add({ id: "reloadBoard", label: "Reload board", tip: "Reload board and refresh 3D view", icon: "import3d", run: () => this.reload(false) });
    add({ id: "copyToClipboard", label: "Copy 3D image to clipboard", tip: "Copy the current 3D image to the clipboard", icon: "copy", key: "Ctrl+C", run: () => { void this.copyImage(); } });
    add({ id: "exportImage", label: "Export Image...", tip: "Export the Current View as an image file", icon: "export_file", run: () => { void this.exportImage(); } });
    add({ id: "toggleRaytacing", label: "Use raytracing", tip: "Render current view using Raytracing", icon: "ray_tracing", run: () => {}, disabled: "Raytracing runs in the desktop app" });
    add({ id: "zoomRedraw", label: "Refresh", icon: "refresh", key: "F5", run: () => { if (v) v.requestRender(); } });
    add({ id: "zoomInCenter", label: "Zoom In", icon: "zoom_in", key: "+", run: () => { if (v) v.zoomIn(); } });
    add({ id: "zoomOutCenter", label: "Zoom Out", icon: "zoom_out", key: "-", run: () => { if (v) v.zoomOut(); } });
    add({ id: "zoomFitScreen", label: "Zoom to Fit", icon: "zoom_fit_in_page", key: "Home", run: () => { if (v) v.fit(); } });
    add({ id: "rotateXCW", label: "Rotate X Clockwise", icon: "rotate_cw_x", run: () => { if (v) v.rotate("x", true); } });
    add({ id: "rotateXCCW", label: "Rotate X Counterclockwise", icon: "rotate_ccw_x", run: () => { if (v) v.rotate("x", false); } });
    add({ id: "rotateYCW", label: "Rotate Y Clockwise", icon: "rotate_cw_y", run: () => { if (v) v.rotate("y", true); } });
    add({ id: "rotateYCCW", label: "Rotate Y Counterclockwise", icon: "rotate_ccw_y", run: () => { if (v) v.rotate("y", false); } });
    add({ id: "rotateZCW", label: "Rotate Z Clockwise", icon: "rotate_cw_z", key: "Shift+R", run: () => { if (v) v.rotate("z", true); } });
    add({ id: "rotateZCCW", label: "Rotate Z Counterclockwise", icon: "rotate_ccw_z", key: "R", run: () => { if (v) v.rotate("z", false); } });
    add({ id: "flipView", label: "Flip Board", tip: "Flip the board view", icon: "flip_board", key: "F", run: () => { if (v) v.flip(); } });
    add({ id: "moveLeft", label: "Move Board Left", icon: "left", key: "Left", run: () => { if (v) v.move(-1, 0); } });
    add({ id: "moveRight", label: "Move Board Right", icon: "right", key: "Right", run: () => { if (v) v.move(1, 0); } });
    add({ id: "moveUp", label: "Move Board Up", icon: "up", key: "Up", run: () => { if (v) v.move(0, 1); } });
    add({ id: "moveDown", label: "Move Board Down", icon: "down", key: "Down", run: () => { if (v) v.move(0, -1); } });
    add({ id: "toggleOrtho", label: "Toggle Orthographic Projection", tip: "Enable/disable orthographic projection", icon: "ortho", run: () => { if (v) { v.setOrtho(!v.ortho); this.syncToggles(); } }, checked: () => !!v && v.ortho });
    add({ id: "showLayersManager", label: "Show Appearance Manager", tip: "Show/hide the appearance manager", icon: "layers_manager", run: () => { this.side.style.display = this.side.style.display === "none" ? "" : "none"; this.syncToggles(); if (v) v.resize(); }, checked: () => this.side.style.display !== "none" });
    add({ id: "viewTop", label: "View Top", icon: "axis3d_top", key: "Z", run: () => { if (v) v.view("top"); } });
    add({ id: "viewBottom", label: "View Bottom", icon: "axis3d_bottom", key: "Shift+Z", run: () => { if (v) v.view("bottom"); } });
    add({ id: "viewRight", label: "View Right", icon: "axis3d_right", key: "X", run: () => { if (v) v.view("right"); } });
    add({ id: "viewLeft", label: "View Left", icon: "axis3d_left", key: "Shift+X", run: () => { if (v) v.view("left"); } });
    add({ id: "viewFront", label: "View Front", icon: "axis3d_front", key: "Y", run: () => { if (v) v.view("front"); } });
    add({ id: "viewBack", label: "View Back", icon: "axis3d_back", key: "Shift+Y", run: () => { if (v) v.view("back"); } });
    add({ id: "showTHT", label: "Show Through Hole 3D Models", tip: "Show 3D models for 'Through hole' type footprints", icon: "show_tht", key: "T", run: vis("tht"), checked: () => !!v && v.visibility.tht });
    add({ id: "showSMD", label: "Show SMD 3D Models", tip: "Show 3D models for 'Surface mount' type footprints", icon: "show_smt", key: "S", run: vis("smd"), checked: () => !!v && v.visibility.smd });
    add({ id: "showVirtual", label: "Show Unspecified 3D Models", tip: "Show 3D models for 'unspecified' type footprints", icon: "show_other", key: "V", run: vis("virtual"), checked: () => !!v && v.visibility.virtual });
    add({ id: "resetDefaults", label: "Reset to Default Settings", run: () => this.resetDefaults() });
    add({ id: "close", label: "Close", icon: "exit", run: () => this.close() });
  }

  /** Run an action by KiCad's id (also the test seam). */
  run(id: string): boolean { const a = this.actions.get(id); if (!a || a.disabled) return false; a.run(); return true; }

  private menus(): [string, MenuItem[]][] {
    const a = (id: string): Action => this.actions.get(id) as Action;
    return [
      ["File", [a("exportImage"), "-", a("close")]],
      ["Edit", [a("copyToClipboard")]],
      ["View", [a("zoomInCenter"), a("zoomOutCenter"), a("zoomFitScreen"), a("zoomRedraw"), "-",
        a("viewTop"), a("viewBottom"), a("viewRight"), a("viewLeft"), a("viewFront"), a("viewBack"), "-",
        { label: "Rotate Board", icon: "rotate_cw", sub: [a("rotateXCW"), a("rotateXCCW"), "-", a("rotateYCW"), a("rotateYCCW"), "-", a("rotateZCW"), a("rotateZCCW")] },
        a("flipView"),
        { label: "Move Board", icon: "move", sub: [a("moveLeft"), a("moveRight"), a("moveUp"), a("moveDown")] }, "-",
        a("showLayersManager")]],
      ["Preferences", [a("toggleRaytacing"), a("resetDefaults")]],
    ];
  }

  private buildToolbar(): HTMLElement {
    const bar = el("div", "v3d-toolbar");
    // toolbars_3d.cpp TOOLBAR_LOC::TOP_MAIN, separators included
    const order = ["reloadBoard", "-", "copyToClipboard", "-", "toggleRaytacing", "-", "zoomRedraw", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "-",
      "rotateXCW", "rotateXCCW", "-", "rotateYCW", "rotateYCCW", "-", "rotateZCW", "rotateZCCW", "-", "flipView", "-",
      "moveLeft", "moveRight", "moveUp", "moveDown", "-", "toggleOrtho", "-", "showLayersManager"];
    for (const id of order) {
      if (id === "-") { bar.appendChild(el("span", "sep")); continue; }
      const a = this.actions.get(id); if (!a) continue;
      const b = el("button"); b.dataset.action = id; b.appendChild(icon(a.icon));
      b.title = a.disabled || ((a.tip || a.label) + (a.key ? "  (" + a.key + ")" : "")); b.setAttribute("aria-label", a.label);
      if (a.disabled) b.classList.add("dis");
      b.addEventListener("click", () => { if (!a.disabled) a.run(); });
      this.toolButtons.set(id, b); bar.appendChild(b);
    }
    return bar;
  }

  private syncToggles(): void {
    for (const [id, b] of this.toolButtons) { const a = this.actions.get(id); if (a && a.checked) b.classList.toggle("on", a.checked()); }
    const v = this.viewer; if (!v) return;
    this.side.querySelectorAll<HTMLInputElement>("input[data-vis]").forEach((i) => { i.checked = v.visibility[i.dataset.vis as keyof Visibility]; });
  }

  // ---------------------------------------------------------------- appearance panel

  private buildAppearance(): void {
    const side = this.side; side.replaceChildren(); const v = this.viewer;
    side.appendChild(el("h4", undefined, "Appearance"));
    // appearance_controls_3D.cpp s_layerSettings: label, tooltip; the swatch is the layer's default colour
    const rows: ([string, keyof Visibility, RGBA | null, string] | null)[] = [
      ["Board Body", "board", BOARD_BODY, "Show board body"],
      ["Plated Barrels", "barrels", SURFACE_FINISH, "Show barrels of plated through-holes and vias"],
      ["F.Cu", "copperTop", SURFACE_FINISH, "Show front copper / surface finish color"],
      ["B.Cu", "copperBottom", SURFACE_FINISH, "Show back copper / surface finish color"],
      ["Solder Paste", "paste", SOLDER_PASTE, "Show solder paste"],
      ["F.Silkscreen", "silkTop", SILKSCREEN, "Show front silkscreen"],
      ["B.Silkscreen", "silkBottom", SILKSCREEN, "Show back silkscreen"],
      ["F.Mask", "maskTop", SOLDER_MASK, "Show front solder mask"],
      ["B.Mask", "maskBottom", SOLDER_MASK, "Show back solder mask"],
      null,
      ["Through-hole Models", "tht", null, "Show 3D models for 'Through hole' type footprints"],
      ["SMD Models", "smd", null, "Show 3D models for 'Surface mount' type footprints"],
      ["Virtual Models", "virtual", null, "Show 3D models for 'unspecified' type footprints"],
    ];
    for (const r of rows) {
      if (!r) { side.appendChild(el("hr")); continue; }
      const [label, key, color, tip] = r;
      const row = el("label", "v3d-row"); row.title = tip;
      const sw = el("span", color ? "sw" : undefined); if (color) sw.style.background = css(color, 1);
      const cb = el("input"); cb.type = "checkbox"; cb.dataset.vis = key; cb.checked = v ? v.visibility[key] : DEFAULT_VISIBILITY[key];
      cb.addEventListener("change", () => { if (v) { v.setVisibility({ [key]: cb.checked }); this.syncToggles(); } });
      row.append(sw, cb, el("span", undefined, label)); side.appendChild(row);
    }
    side.appendChild(el("hr"));
    const bg = (label: string, tip: string, which: "top" | "bottom") => {
      const row = el("label", "v3d-row"); row.title = tip;
      const inp = el("input"); inp.type = "color"; inp.dataset.bg = which; inp.value = hex(v ? v.background[which] : (which === "top" ? BACKGROUND_TOP : BACKGROUND_BOTTOM));
      inp.addEventListener("input", () => { if (!v) return; const c = fromHex(inp.value); if (which === "top") v.setBackground(c, v.background.bottom); else v.setBackground(v.background.top, c); });
      row.append(inp, el("span", undefined, label)); side.appendChild(row);
    };
    bg("Background Start", "Background gradient start color", "top");
    bg("Background End", "Background gradient end color", "bottom");
  }

  private resetDefaults(): void {
    const v = this.viewer; if (!v) return;
    v.setVisibility(Object.assign({}, DEFAULT_VISIBILITY)); v.setBackground(BACKGROUND_TOP, BACKGROUND_BOTTOM); v.setOrtho(false);
    this.buildAppearance(); this.syncToggles(); v.view("top");
  }

  // ---------------------------------------------------------------- menus

  private openMenu(button: HTMLElement, items: MenuItem[]): void {
    this.closeMenu(); this.menuButton = button; button.classList.add("open");
    const r = button.getBoundingClientRect(); this.showMenu(items, r.left, r.bottom, 0);
  }

  private showMenu(items: MenuItem[], x: number, y: number, depth: number): void {
    while (this.menu.length > depth) { const m = this.menu.pop(); if (m) m.remove(); }
    const m = el("div", "v3d-menu"); m.style.left = x + "px"; m.style.top = y + "px";
    for (const it of items) {
      if (it === "-") { m.appendChild(el("hr")); continue; }
      const row = el("div", "v3d-mi");
      const ic = el("span"); const lab = el("span", undefined, it.label); const k = el("span", "k"); const arrow = el("span");
      if ("sub" in it) {
        ic.appendChild(icon(it.icon)); arrow.textContent = "▸";
        row.addEventListener("pointerenter", () => { const rr = row.getBoundingClientRect(); this.showMenu(it.sub, rr.right - 2, rr.top - 4, depth + 1); });
      } else {
        row.dataset.action = it.id;
        if (it.checked) { ic.className = "chk"; ic.textContent = it.checked() ? "✓" : ""; } else ic.appendChild(icon(it.icon));
        if (it.key) k.textContent = it.key;
        if (it.disabled) { row.classList.add("dis"); row.title = it.disabled; } else if (it.tip) row.title = it.tip;
        row.addEventListener("pointerenter", () => { while (this.menu.length > depth + 1) { const s = this.menu.pop(); if (s) s.remove(); } });
        row.addEventListener("click", () => { if (it.disabled) return; this.closeMenu(); it.run(); this.root.focus({ preventScroll: true }); });
      }
      row.append(ic, lab, k, arrow); m.appendChild(row);
    }
    document.body.appendChild(m); this.menu.push(m);
    // keep it on screen
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) m.style.left = Math.max(4, window.innerWidth - 4 - r.width) + "px";
    if (r.bottom > window.innerHeight - 4) m.style.top = Math.max(4, window.innerHeight - 4 - r.height) + "px";
  }

  private closeMenu(): void {
    for (const m of this.menu) m.remove(); this.menu = [];
    if (this.menuButton) this.menuButton.classList.remove("open"); this.menuButton = null;
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement;
    // the window owns the keyboard while it has the focus: nothing reaches the board editor's shortcuts
    ev.stopPropagation();
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && (t as HTMLInputElement).type !== "checkbox") return;
    if (ev.key === "Escape") { if (this.menu.length) { this.closeMenu(); ev.preventDefault(); } return; }
    if ((ev.key === "=" || ev.key === "+") && !ev.ctrlKey && !ev.metaKey) { this.run("zoomInCenter"); ev.preventDefault(); return; }
    if ((ev.key === "-" || ev.key === "_") && !ev.ctrlKey && !ev.metaKey) { this.run("zoomOutCenter"); ev.preventDefault(); return; }
    for (const a of this.actions.values()) {
      if (!a.key || a.disabled || a.key === "+" || a.key === "-" || !keyMatches(ev, a.key)) continue;
      ev.preventDefault(); a.run(); return;
    }
  }

  // ---------------------------------------------------------------- window management

  private bindDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest("button") || this.restore) return;
      const r = this.root.getBoundingClientRect(); const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        const x = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, e.clientX - ox)), y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
        this.root.style.left = x + "px"; this.root.style.top = y + "px";
      };
      const up = (e: PointerEvent) => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); try { handle.releasePointerCapture(e.pointerId); } catch { /* released */ } };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
    });
  }

  private bindResize(grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.restore) return; ev.preventDefault();
      const r = this.root.getBoundingClientRect(); const sx = ev.clientX, sy = ev.clientY;
      grip.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        this.root.style.width = Math.max(420, Math.min(window.innerWidth - r.left, r.width + e.clientX - sx)) + "px";
        this.root.style.height = Math.max(300, Math.min(window.innerHeight - r.top, r.height + e.clientY - sy)) + "px";
        if (this.viewer) this.viewer.resize();
      };
      const up = (e: PointerEvent) => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up); try { grip.releasePointerCapture(e.pointerId); } catch { /* released */ } };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
    });
  }

  toggleMaximize(): void {
    const s = this.root.style;
    if (this.restore) { s.left = this.restore.left; s.top = this.restore.top; s.width = this.restore.width; s.height = this.restore.height; this.restore = null; this.root.classList.remove("v3d-max"); }
    else { this.restore = { left: s.left, top: s.top, width: s.width, height: s.height }; s.left = "0"; s.top = "0"; s.width = "100vw"; s.height = "100vh"; this.root.classList.add("v3d-max"); }
    if (this.viewer) this.viewer.resize();
  }

  /** Keep the title bar reachable when the browser window shrinks. */
  private clamp(): void {
    if (this.restore) return;
    const r = this.root.getBoundingClientRect();
    if (r.left > window.innerWidth - 80) this.root.style.left = Math.max(0, window.innerWidth - 80) + "px";
    if (r.top > window.innerHeight - 30) this.root.style.top = Math.max(0, window.innerHeight - 30) + "px";
  }

  focus(): void { this.root.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- board

  private updateTitle(): void {
    const name = this.opts.getName ? this.opts.getName() : "";
    // EDA_3D_VIEWER_FRAME: "<board file> — 3D Viewer"
    this.nameEl.textContent = (name ? name + " — " : "") + "3D Viewer";
  }

  private setStatus(text: string): void { this.statusEl.textContent = text; }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => { this.reloadTimer = 0; this.reload(false); }, 350);
  }

  /** Rebuild the board from the current document (Reload board); `fit` also resets the camera. */
  reload(fit: boolean): void {
    if (this.closed || !this.viewer) return;
    const doc = this.opts.getDoc();
    this.updateTitle();
    if (!doc || doc.type !== "pcb") { this.setStatus("No board is open"); return; }
    const t0 = performance.now();
    try {
      const st = this.viewer.setDoc(doc, fit);
      this.lastBuildMs = performance.now() - t0; this.builds++;
      // EDA_3D_CANVAS reports "Reload time %.3f s" in its status bar
      this.setStatus(`Reload time ${(this.lastBuildMs / 1000).toFixed(3)} s` + (st.fallbackOutline ? "  —  no closed Edge.Cuts outline: using the board's bounding box" : ""));
    } catch (e) {
      console.warn("3D viewer: could not build the board", e);
      this.setStatus("Could not build the board: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  private fileStem(): string { const n = this.opts.getName ? this.opts.getName() : ""; return (n.split("/").pop() || "board").replace(/\.kicad_pcb$/, "") || "board"; }

  async exportImage(): Promise<Blob | null> {
    if (!this.viewer) return null;
    try {
      const blob = await this.viewer.snapshot("image/png");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = this.fileStem() + ".png";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      this.setStatus("Exported " + a.download);
      return blob;
    } catch (e) { this.setStatus("Export failed: " + (e instanceof Error ? e.message : String(e))); return null; }
  }

  async copyImage(): Promise<void> {
    if (!this.viewer) return;
    try {
      const blob = await this.viewer.snapshot("image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      this.setStatus("Copied the 3D image to the clipboard");
    } catch (e) { this.setStatus("Copy failed: " + (e instanceof Error ? e.message : String(e))); }
  }

  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.unsubscribe) this.unsubscribe();
    this.closeMenu();
    document.removeEventListener("pointerdown", this.onDocPointer, true);
    window.removeEventListener("resize", this.onWinResize);
    if (this.viewer) this.viewer.dispose();
    this.root.remove();
  }
}
