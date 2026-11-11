// Guide.tsx — the guided first project: a small panel over the corner of the canvas that walks
// through one whole loop on a real board (read the schematic, open the board, route what is left,
// check it, share it).  It only watches: every step is done by the person in the editor itself,
// with the editor's own tools, and the panel notices when it has happened.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dispatch, useApp } from "../store";
import { Ic } from "../home/ui";
import { STEPS, getGuide, markStep, nextStep, patchGuide, setGuide, stepsDone, subscribeGuide, type GuideState, type StepId } from "./state";

interface BoardTools { ratsnest(doc: unknown): { name: string }[] }
const boardTools = () => (window as unknown as { PcbTools?: BoardTools }).PcbTools;
const editorDoc = () => (window as unknown as { CollabEditor?: { kdoc?: unknown; DOC_TYPE?: string } }).CollabEditor;

const TITLES: Record<StepId, string> = {
  schematic: "Read the schematic",
  board: "Open the board",
  route: "Route what is left",
  check: "Check the board",
  share: "Share it",
};

/** Connections on the open board that still need a track, or null while no board is open. */
function useOpenConnections(active: boolean): number | null {
  const editor = useApp((s) => s.document.editor);
  const version = useApp((s) => s.document.version);
  const hasDoc = useApp((s) => s.document.hasDoc);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (!active || editor !== "pcb" || !hasDoc) return;
    // After the edit has been drawn: counting walks the whole netlist.
    const t = window.setTimeout(() => {
      const tools = boardTools(), ed = editorDoc();
      if (!tools || !ed || !ed.kdoc || ed.DOC_TYPE !== "kicad_pcb") return;
      try { setOpen(tools.ratsnest(ed.kdoc).length); } catch { /* a board mid-load: the next change counts again */ }
    }, 120);
    return () => window.clearTimeout(t);
  }, [active, editor, version, hasDoc]);
  return open;
}

/**
 * Where the panel sits: over the foot of the panes left of the canvas (History, which a first
 * board does not need yet), so it never covers the copper the person is asked to route.
 */
function useDockCorner(): { left: number; bottom: number; width: number } | undefined {
  const [at, setAt] = useState<{ left: number; bottom: number; width: number }>();
  useEffect(() => {
    const stage = document.getElementById("stage"); if (!stage || typeof ResizeObserver === "undefined") return;
    const place = () => {
      const r = stage.getBoundingClientRect();
      // A phone has no panes beside the canvas: the stylesheet lays the panel along the bottom there.
      if (!r.width || window.innerWidth <= 760) { setAt(undefined); return; }
      const next = { left: 8, bottom: Math.max(8, Math.round(window.innerHeight - r.bottom) + 8), width: Math.min(320, Math.max(264, Math.round(r.left) - 16)) };
      setAt((cur) => (cur && cur.bottom === next.bottom && cur.width === next.width ? cur : next));
    };
    const ro = new ResizeObserver(place); ro.observe(stage); ro.observe(document.body);
    window.addEventListener("resize", place); place();
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  return at;
}

function Key({ children }: { children: ReactNode }) { return <span className="kbd">{children}</span>; }

export function Guide() {
  const guide = useSyncExternalStore(subscribeGuide, getGuide, () => null);
  const view = useApp((s) => s.view);
  const projectId = useApp((s) => s.project?.projectId || null);
  const here = !!guide && !guide.closed && view === "editor" && projectId === guide.projectId;
  return here && guide ? <Panel guide={guide} /> : null;
}

function Panel({ guide }: { guide: GuideState }) {
  const editor = useApp((s) => s.document.editor);
  const docs = useApp((s) => s.document.docs);
  const picked = useApp((s) => s.selection.primary);
  const viewOnly = useApp((s) => s.viewOnly);
  const open = useOpenConnections(true);
  const current = nextStep(guide);
  const sch = docs.find((d) => d.docType === "kicad_sch"), pcb = docs.find((d) => d.docType === "kicad_pcb");
  const corner = useDockCorner();
  const started = useRef<number | null>(null);
  if (open !== null && started.current === null) started.current = open;

  // What the editor shows decides the first three steps; the last two are things the person runs.
  useEffect(() => {
    if (current === "schematic" && editor === "sch" && picked && picked.ref && !picked.ref.startsWith("#")) markStep("schematic");
    else if (current === "board" && editor === "pcb") markStep("board");
    else if (current === "route" && editor === "pcb" && open === 0) markStep("route");
  }, [current, editor, picked, open]);
  useEffect(() => {
    const on = (ev: Event) => {
      const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
      if (id === "runDRC") markStep("check"); else if (id === "share") markStep("share");
    };
    window.addEventListener("kc:action", on);
    return () => window.removeEventListener("kc:action", on);
  }, []);

  const show = (docId: string | undefined) => { if (docId) dispatch({ type: "openDoc", docId }); };
  const run = (id: string) => dispatch({ type: "action", id });
  const done = stepsDone(guide), finished = !current;

  const body: Record<StepId, ReactNode> = {
    schematic: (
      <>
        <p>Every board starts as a schematic: what is connected to what. This one is a 555 timer that blinks an LED about once a second.</p>
        <p>{editor === "sch" ? <>Click a part, for example <b>U1</b>, the timer. Its properties show beside the drawing.</> : "Open it and have a look around."}</p>
        {editor !== "sch" ? <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => show(sch?.docId)} disabled={!sch}>Open the schematic</button></div> : null}
      </>
    ),
    board: (
      <>
        <p>The board holds the same parts as footprints, and copper tracks do the job of the schematic's wires.</p>
        <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => show(pcb?.docId)} disabled={!pcb}>Open the board</button></div>
      </>
    ),
    route: (
      <>
        {open ? <p className="kg-count" aria-live="polite"><b>{open}</b> {open === 1 ? "connection" : "connections"} left{started.current && started.current > open ? ` of ${started.current}` : ""}. Each thin line is one.</p>
          : <p>The thin lines are connections that still need a track.</p>}
        <p>Press <Key>X</Key>, click a pad at one end of a thin line, click where the track should turn, and click the pad at the other end. While routing, <Key>V</Key> drops a via and carries on on the other side of the board.</p>
        <div className="kg-acts">
          {editor === "pcb" ? <button type="button" className="btn primary sm" onClick={() => dispatch({ type: "setTool", tool: "route" })} disabled={viewOnly}>Route Tracks</button>
            : <button type="button" className="btn primary sm" onClick={() => show(pcb?.docId)} disabled={!pcb}>Open the board</button>}
          {editor === "pcb" ? <button type="button" className="btn sm" onClick={() => run("module:autoroute")} disabled={viewOnly}>Autoroute the rest…</button> : null}
        </div>
      </>
    ),
    check: (
      <>
        <p>The Design Rules Checker looks for what a board house would send back: tracks too close together, connections left open, copper too near the edge.</p>
        <div className="kg-acts">
          {editor === "pcb" ? <button type="button" className="btn primary sm" onClick={() => run("module:runDRC")}>Run the checker</button>
            : <button type="button" className="btn primary sm" onClick={() => show(pcb?.docId)} disabled={!pcb}>Open the board</button>}
        </div>
        <p className="kg-hint">It is in the menus as Inspect → Design Rules Checker.</p>
      </>
    ),
    share: (
      <>
        <p>A project is shared by GitHub name, email or link. Everyone you invite works on these same files, and you see each other's cursors as you go.</p>
        <div className="kg-acts"><button type="button" className="btn primary sm" onClick={() => run("share")}>Open Share</button></div>
        <p className="kg-hint">You do not have to invite anyone now. It is in the menus as File → Share.</p>
      </>
    ),
  };

  if (guide.folded) {
    return (
      <aside className="kg kg-folded" style={corner ? { left: corner.left, bottom: corner.bottom } : undefined} aria-label="Guided first project">
        <button type="button" className="kg-unfold" onClick={() => patchGuide({ folded: false })} aria-expanded="false">
          <span className="kg-ring" style={{ ["--kg-done" as string]: String(done / STEPS.length) }} aria-hidden="true" />
          <span>{finished ? "First board: done" : `First board: ${TITLES[current!]}`}</span>
          <span className="kg-n">{done}/{STEPS.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="kg" style={corner} aria-label="Guided first project">
      <header className="kg-h">
        <b>Your first board</b>
        <span className="kg-n">{done} of {STEPS.length}</span>
        <button type="button" className="kg-x" title="Fold away" aria-label="Fold the guide away" onClick={() => patchGuide({ folded: true })}><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></button>
        <button type="button" className="kg-x" title="Close the guide" aria-label="Close the guide" onClick={() => patchGuide({ closed: true })}><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></button>
      </header>
      <div className="kg-bar" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={done}><i style={{ width: `${(done / STEPS.length) * 100}%` }} /></div>
      {!done && guide.from === "mini" ? <p className="kg-lead">This is the board you were routing on the home page. It is a real project of yours now, with its schematic.</p> : null}
      {finished ? (
        <div className="kg-done">
          <h3>That is the whole loop</h3>
          <p>You read a schematic, routed a board, checked it and know how to share it. This project stays in your list, so keep going with it, or start your own.</p>
          <div className="kg-acts">
            <a className="btn primary sm" href="/?new=template">Start from a template</a>
            <a className="btn sm" href="/">Your projects</a>
          </div>
          <button type="button" className="kg-skip" onClick={() => setGuide(null)}>Close the guide</button>
        </div>
      ) : (
        <ol className="kg-steps">
          {STEPS.map((id, i) => {
            const state = guide.done[id], cur = id === current;
            return (
              <li key={id} className={cur ? "cur" : state ? "ok" : undefined} aria-current={cur ? "step" : undefined}>
                <div className="kg-step-h">
                  <span className="kg-dot" aria-hidden="true">{state === "done" ? <Ic name="check" size={12} /> : i + 1}</span>
                  <span className="kg-step-t">{TITLES[id]}</span>
                  {state === "skipped" ? <span className="kg-tag">skipped</span> : null}
                </div>
                {cur ? <div className="kg-step-b">{body[id]}<button type="button" className="kg-skip" onClick={() => markStep(id, "skipped")}>Skip this step</button></div> : null}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
