// Properties.tsx — an imperative island: props.js draws KiCad's property rows into the ref'd
// div (it needs app.js's tool context, so app.js does the call); we re-run it whenever the
// selection or the document changes.  props.js defers its own redraw while a field has focus.
import { useEffect, useRef } from "react";
import { useApp } from "../../store";

export function PropertiesPane() {
  const ref = useRef<HTMLDivElement>(null);
  const selV = useApp((s) => s.selection.version);
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const viewOnly = useApp((s) => s.viewOnly);
  useEffect(() => {
    const el = ref.current; const app = window.CollabApp;
    if (el && app) app.renderProps(el);
  }, [selV, docV, docId, viewOnly]);
  // .kbody (overflow/padding/flex/paper/12px) and .kbody h3 (props.js's section captions: 500 10px/1
  // mono, uppercase, .12em tracking, ink-3, 8px 0 6px) as utilities; `kbody`/`#props` stay as hooks and
  // `note` is app.html's class.
  return (
    <div
      className="kbody overflow-auto min-h-0 flex-auto bg-paper px-2 py-1.5 text-sm [&_h3]:mx-0 [&_h3]:mt-2 [&_h3]:mb-1.5 [&_h3]:font-mono [&_h3]:text-2xs [&_h3]:font-medium [&_h3]:leading-none [&_h3]:uppercase [&_h3]:tracking-[.12em] [&_h3]:text-ink-3"
      id="props"
      ref={ref}
    >
      <p className="note">No objects selected</p>
    </div>
  );
}
