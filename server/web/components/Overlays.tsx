// Overlays.tsx — the toast, the popovers (desktop-only explanation, About, share link, Open in
// KiCad, Find, the grid menu) and the guest sign-in note on the stage.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { dispatch, useApp, type PopoverState } from "../store";
import { cx } from "../util";

export function Toast() {
  const toast = useApp((s) => s.toast);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), toast.ms || 2200);
    return () => clearTimeout(t);
  }, [toast]);
  // transform-[…] rather than -translate-x-1/2: Tailwind's translate-* utilities emit the separate `translate`
  // property, and app.html's centring for #toast (if ever re-added) uses `transform` — keep the one property.
  return <div id="toast" className={cx("fixed left-1/2 bottom-10 transform-[translateX(-50%)] bg-ink text-paper rounded-[3px] py-2 px-3.5 opacity-0 transition-opacity duration-200 ease-[ease] pointer-events-none z-100 show:opacity-100", show && "show")}>{toast ? toast.text : ""}</div>;
}

const RELEASES = "https://github.com/notaroomba/kicad-collaborative/releases";
const H4 = "m-0 mb-2 text-base";                                                                              // was #popover h4
const INPUT = "w-full bg-paper border border-line rounded-[3px] py-1.5 px-2 text-ink font-mono text-sm";     // was #popover input

function PopoverBody({ p }: { p: PopoverState }) {
  const gridPitch = useApp((s) => s.viewport.gridPitch);
  const gridChoices = useApp((s) => s.viewport.gridChoices);
  const close = () => dispatch({ type: "popover", popover: null });
  switch (p.kind) {
    case "desktop":
      return (
        <>
          <h4 className={H4}>{p.title}</h4><p className="note">{p.why}</p>
          <p className="note"><a href="#" onClick={(ev) => { ev.preventDefault(); dispatch({ type: "popover", popover: { kind: "kicad", anchor: p.anchor } }); }}>Open this project in KiCad Collaborative…</a></p>
        </>
      );
    case "about":
      return <><h4 className={H4}>KiCad Collaborative 1.0</h4><p className="note">Real-time collaboration for KiCad, based on KiCad 10.99.<br />Web editor v1: move, rotate, delete footprints; comments; history; live presence.</p></>;
    case "share":
      return (
        <>
          <h4 className={H4}>Share link (editor)</h4>
          <input className={INPUT} value={p.url || ""} readOnly onClick={(ev) => ev.currentTarget.select()} />
          <p className="note">Copied to your clipboard. Anyone with it can join in the browser or from KiCad Collaborative → File → Join Shared Project…</p>
        </>
      );
    case "kicad":
      return (
        <>
          <h4 className={H4}>Open in KiCad Collaborative</h4>
          <p className="note">1. Install the desktop app from the <a href={RELEASES} target="_blank" rel="noreferrer">releases page</a>.<br />2. File → Join Shared Project… and paste a share link (File → Copy share link… here).<br />3. Edits sync both ways, live.</p>
        </>
      );
    case "find":
      return <FindBody p={p} close={close} />;
    case "grid":
      return (
        <>
          <h4 className={H4}>Grid</h4>
          {gridChoices.map(([v, label]) => (
            <button type="button" key={v} data-grid={v}
              className={cx("kbtn block w-full text-left my-0.5 bg-panel border rounded-[3px] py-[3px] px-2.5 text-ink text-sm disabled:opacity-45",
                v === gridPitch ? "border-blue hover:border-blue" : "border-line hover:border-ink-3")}
              onClick={() => { dispatch({ type: "setGrid", pitch: v }); close(); }}>{label}</button>
          ))}
        </>
      );
  }
}

function FindBody({ p, close }: { p: PopoverState; close: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(p.query || "");
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 0); return () => clearTimeout(t); }, []);   // after the popover is positioned and shown
  const hits = p.hits;
  return (
    <>
      <h4 className={H4}>Find</h4>
      <input id="findQ" className={INPUT} ref={ref} placeholder="Reference or value…" value={q}
        onChange={(ev) => { setQ(ev.target.value); dispatch({ type: "find", query: ev.target.value }); }}
        onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") { dispatch({ type: "find", query: q }); close(); } if (ev.key === "Escape") close(); }} />
      <p className="note" id="findHits">{q.trim() && hits !== null && hits !== undefined ? `${hits} match${hits === 1 ? "" : "es"}` : ""}</p>
    </>
  );
}

export function Popover() {
  const p = useApp((s) => s.popover);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ display: "none" });
  useLayoutEffect(() => {
    if (!p) { setStyle({ display: "none" }); return; }
    const el = ref.current; const w = el ? el.offsetWidth : 320, h = el ? el.offsetHeight : 100;
    const r = p.anchor || { left: innerWidth / 2 - 160, bottom: 60, top: 54, right: innerWidth / 2 + 160 };
    setStyle({ display: "block", left: Math.min(r.left, innerWidth - w - 12) + "px", top: Math.min(r.bottom + 6, innerHeight - h - 12) + "px" });
  }, [p]);
  useEffect(() => {
    if (!p) return;
    const down = (ev: PointerEvent) => { const t = ev.target as Element; if (ref.current && !ref.current.contains(t)) dispatch({ type: "popover", popover: null }); };
    const t = setTimeout(() => document.addEventListener("pointerdown", down), 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", down); };
  }, [p]);
  return <div id="popover" ref={ref} style={style} className="fixed hidden bg-panel border border-line rounded-sm py-3 px-3.5 min-w-80 shadow-panel z-60">{p ? <PopoverBody p={p} /> : null}</div>;
}

/** "Viewing as a guest" on the stage (the stage itself stays app.js's; this is portalled into it). */
export function SignInOverlay() {
  const canJoin = useApp((s) => s.canJoin);
  const inEditor = useApp((s) => s.view === "editor");
  const stage = document.getElementById("stage");
  if (!stage) return null;
  return createPortal(
    <div id="signinOverlay" style={{ display: inEditor && !canJoin ? "block" : "none" }}>
      Viewing as a guest. <a id="signinLink" href={`/auth/github/login?next=${encodeURIComponent(location.pathname)}`}>Sign in</a> to edit, comment and see live cursors.
    </div>, stage);
}
