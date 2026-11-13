// Overlays.tsx — the toast, the popovers (desktop-only explanation, About, share link, Open in
// KiCad, Find, the grid menu) and the guest sign-in note on the stage.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { dispatch, useApp, type PopoverState } from "../store";
import { toast } from "../home/ui";
import { cx } from "../util";

export function Toast() {
  const toast = useApp((s) => s.toast);
  const [show, setShow] = useState(false);
  const [box, setBox] = useState<CSSProperties | null>(null);
  useEffect(() => {
    if (!toast) return;
    // In the editor the message is KiCad's infobar (WX_INFOBAR::ShowMessageFor): a bar over the top edge of the
    // canvas, laid over it rather than pushing it down; elsewhere a toast at the bottom of the window.
    // the Symbol Editor is its own frame over the editor, with its own infobar strip: the bar lies over its canvas
    const se = document.getElementById("se-canvas");
    const stage = se && se.offsetParent && se.getBoundingClientRect().width > 0 ? se : document.getElementById("stage");
    const measure = () => { const r = stage && stage.offsetParent ? stage.getBoundingClientRect() : null; setBox(r && r.width > 0 ? { left: r.left, top: r.top, width: r.width } : null); };
    measure();
    // A dock opening or closing while the bar is up (a plugin panel, the assistant) resizes the canvas: the bar follows it.
    const ro = stage && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null; if (ro && stage) ro.observe(stage);
    setShow(true);
    const t = setTimeout(() => setShow(false), toast.ms || 2200);
    return () => { clearTimeout(t); if (ro) ro.disconnect(); };
  }, [toast]);
  const close = <button type="button" className="kinfobar-x" aria-label="Close" onClick={() => setShow(false)}><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" /></svg></button>;
  const link = toast && toast.link ? <a href="#" className="kinfobar-link" onClick={(ev) => { ev.preventDefault(); setShow(false); toast.link!.run(); }}>{toast.link.text}</a> : null;
  if (box) return <div id="toast" role="status" aria-live="polite" className={cx("kinfobar", show && "show")} style={box}>{toast ? toast.text : ""}{link}{close}</div>;
  // transform-[…] rather than -translate-x-1/2: Tailwind's translate-* utilities emit the separate `translate`
  // property, and app.html's centring for #toast (if ever re-added) uses `transform` — keep the one property.
  return <div id="toast" role="status" aria-live="polite" className={cx("fixed left-1/2 bottom-10 transform-[translateX(-50%)] bg-ink text-paper rounded-sm py-2 px-3.5 opacity-0 transition-opacity duration-200 ease-[ease] pointer-events-none z-100 show:opacity-100", show && "show")}>{toast ? toast.text : ""}</div>;
}

const RELEASES = "https://github.com/notaroomba/junction/releases";
const H4 = "m-0 mb-2 text-base";                                                                              // was #popover h4
const INPUT = "w-full bg-paper border border-line rounded-sm py-1.5 px-2 text-ink font-mono text-sm";     // was #popover input

function PopoverBody({ p }: { p: PopoverState }) {
  const close = () => dispatch({ type: "popover", popover: null });
  switch (p.kind) {
    case "desktop":
      return (
        <>
          <h4 className={H4}>{p.title}</h4><p className="note">{p.why}</p>
          <p className="note"><a href="#" onClick={(ev) => { ev.preventDefault(); dispatch({ type: "popover", popover: { kind: "kicad", anchor: p.anchor } }); }}>Open this project in Junction…</a></p>
        </>
      );
    case "about":
      return <><h4 className={H4}>Junction</h4><p className="note">Real-time collaboration for KiCad, based on KiCad 10.<br />Web editor v1: move, rotate, delete footprints; comments; history; live presence.</p></>;
    case "share":
      return (
        <>
          <h4 className={H4}>Share link (editor)</h4>
          <input className={INPUT} value={p.url || ""} readOnly onClick={(ev) => ev.currentTarget.select()} />
          <p className="note">Copied to your clipboard. Anyone with it can join in the browser or from Junction → File → Join Session from URL…</p>
        </>
      );
    case "kicad":
      return (
        <>
          <h4 className={H4}>Open in Junction</h4>
          <p className="note">1. Install the desktop app from the <a href={RELEASES} target="_blank" rel="noreferrer">releases page</a>.<br />2. File → Join Session from URL… and paste a share link (File → Copy share link… here).<br />3. Edits sync both ways, live.</p>
        </>
      );
  }
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
  return <div id="popover" ref={ref} style={style} className="fixed hidden bg-panel border border-line rounded-md py-3 px-3.5 min-w-80 shadow-panel z-60">{p ? <PopoverBody p={p} /> : null}</div>;
}

/** The access note on the stage (the stage itself stays app.js's; this is portalled into it): a guest is told how to
 *  get more than looking, and someone who opened a share link without joining is offered the role it gives. */
export function SignInOverlay() {
  const guest = useApp((s) => s.guest);
  const can = useApp((s) => s.can);
  const project = useApp((s) => s.project);
  const inEditor = useApp((s) => s.view === "editor");
  const [busy, setBusy] = useState(false);
  const stage = document.getElementById("stage");
  if (!stage) return null;
  const offer = !guest && can?.join ? can.join : null;
  const join = async () => {
    if (!project || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${project.projectId}/join`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      // The project is opened again from the top: the role, the tools and the live session all follow.
      location.reload();
    } catch { setBusy(false); toast("That link no longer works. Ask the owner for a new one."); }
  };
  const roleWord = offer === "editor" ? "an editor" : offer === "commenter" ? "a commenter" : "a viewer";
  return createPortal(
    <div id="signinOverlay" data-kind={guest ? "guest" : offer ? "join" : undefined} style={{ display: inEditor && (guest || offer) ? "block" : "none" }}>
      {guest ? <>Viewing as a guest. <a id="signinLink" href={`/auth/github/login?next=${encodeURIComponent(location.pathname)}`}>Sign in</a> to comment or edit, if the project lets you.</>
        : <>You opened this project from a share link. <button type="button" id="joinLinkBtn" className="btn sm primary" disabled={busy} onClick={join}>{busy ? "Joining…" : `Join as ${roleWord}`}</button></>}
    </div>, stage);
}
