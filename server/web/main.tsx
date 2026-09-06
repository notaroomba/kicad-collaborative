// main.tsx — mounts the React chrome into app.html's mount points.  app.js (loaded first) owns
// the stage, the canvas, the SVG overlays, pointer handling and the websocket, and publishes the
// store on window.CollabApp; each root below renders from it.  The hosts are `display: contents`
// wrappers so the rendered elements are the page grid's own children, exactly as the static
// markup used to be.
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
// chrome styling: web/styles/tailwind.css (built by @tailwindcss/cli into static/dist/ui.css)
import { MenuBar } from "./components/MenuBar";
import { AuxToolbar, LeftOptionsToolbar, RightDrawToolbar, TopToolbar } from "./components/Toolbar";
import { DockLeft, DockRight } from "./components/Dock";
import { StatusBar } from "./components/StatusBar";
import { Popover, SignInOverlay, Toast } from "./components/Overlays";

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
mount("ui-statusbar", <StatusBar />);
mount("ui-overlays", <><Toast /><Popover /><SignInOverlay /></>);
