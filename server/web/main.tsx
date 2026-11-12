// main.tsx — mounts the React chrome into app.html's mount points.  app.js (loaded first) owns
// the stage, the canvas, the SVG overlays, pointer handling and the websocket, and publishes the
// store on window.CollabApp; each root below renders from it.  The hosts are `display: contents`
// wrappers so the rendered elements are the page grid's own children, exactly as the static
// markup used to be.
import { createRoot } from "react-dom/client";
import { Guide } from "./onboarding/Guide";
import type { ReactNode } from "react";
// chrome styling: web/styles/tailwind.css (built by @tailwindcss/cli into static/dist/ui.css)
import { MenuBar } from "./components/MenuBar";
import { AuxToolbar, LeftOptionsToolbar, RightDrawToolbar, TopToolbar } from "./components/Toolbar";
import { DockBottom, DockLeft, DockRight } from "./components/Dock";
import { StatusBar } from "./components/StatusBar";
import { MsgPanel } from "./components/MsgPanel";
import { Popover, SignInOverlay, Toast } from "./components/Overlays";
import { Home } from "./home/Home";
import { Toasts } from "./home/ui";
import { PluginDialogs, PluginDock } from "./plugins/PluginUi";
import { ContextMenu } from "./components/ContextMenu";
import { HistoryBar, VersionDialogs } from "./components/VersionHistory";
import { CompareWindow } from "./review/Compare";
import { installReview } from "./review/store";
import { installToolbarTooltips } from "./tooltip";
import { SPEC } from "./spec";
import { loadIconPack, packIcon } from "./iconpack";

// The Symbol Editor (web/symedit, in editor.js) draws its toolbars from the same spec and icons: published here so
// the 670 KB spec is not bundled twice.
Object.assign(window, {
  KiCadUiToolbars: SPEC.toolbars,
  KiCadIconFor: (name: string) => SPEC.icons[name] || packIcon(name),
  KiCadIconsReady: loadIconPack(),
});

function mount(id: string, node: ReactNode) {
  const host = document.getElementById(id);
  if (!host) { console.warn(`ui: no mount point #${id}`); return; }
  createRoot(host).render(node);
}

mount("ui-menubar", <MenuBar />);
mount("ui-tbTop", <TopToolbar />);
mount("ui-tbAux", <AuxToolbar />);
mount("ui-dockL", <DockLeft />);
mount("ui-tbLeft", <LeftOptionsToolbar />);
mount("ui-tbRight", <RightDrawToolbar />);
mount("ui-dockR", <DockRight />);
mount("ui-dockPlugins", <PluginDock />);
mount("ui-dockB", <DockBottom />);
mount("ui-msgpanel", <MsgPanel />);
mount("ui-statusbar", <StatusBar />);
mount("ui-home", <><Home /><Toasts /></>);
mount("ui-overlays", <><Toast /><Popover /><SignInOverlay /><ContextMenu /><PluginDialogs /><HistoryBar /><VersionDialogs /><CompareWindow /><Guide /></>);
installReview();
installToolbarTooltips();
