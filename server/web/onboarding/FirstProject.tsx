// FirstProject.tsx — what the projects home shows someone with no projects yet: one clear way to
// begin (the guided first project), the starter templates, and the ways in for people who already
// have a design (upload it, or join one that was shared).
import { useEffect, useState } from "react";
import { listTemplates, type Template } from "../home/api";
import { Ic } from "../home/ui";

export function FirstProject({ onGuided, onTemplate, onUpload, onJoin, releases }: {
  onGuided: () => void; onTemplate: (id?: string) => void; onUpload: () => void; onJoin: () => void; releases: string;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => { let live = true; listTemplates().then((l) => { if (live) setList(l); }).catch(() => { /* the buttons below still work */ }); return () => { live = false; }; }, []);
  const guided = list ? list.find((t) => t.guided) : null;

  return (
    <div className="fp">
      <section className="fp-first">
        <div className="fp-pic">{guided ? <img src={guided.board} alt="A small board: a 555 timer blinking an LED, powered from USB-C" /> : null}</div>
        <div className="fp-say">
          <h2>Start with your first board</h2>
          <p>A finished 555 LED blinker with four connections left for you. A short guide beside the editor walks you through reading the schematic, routing the board, checking it and sharing it. It takes about five minutes.</p>
          <div className="fp-acts">
            <button type="button" className="btn primary" disabled={starting} onClick={() => { setStarting(true); onGuided(); window.setTimeout(() => setStarting(false), 4000); }}>{starting ? "Creating…" : "Start the guided project"}</button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="fp-h">Or start from a template</h3>
        <div className="fp-grid">
          {(list || []).map((t) => (
            <button type="button" key={t.id} className="fp-card" onClick={() => onTemplate(t.id)}>
              <span className="fp-thumb"><img src={t.board} alt="" loading="lazy" /></span>
              <b>{t.title}</b>
              <span>{t.summary}</span>
            </button>
          ))}
          {!list ? [0, 1, 2, 3].map((i) => <div key={i} className="fp-card skel"><span className="fp-thumb" /><b>&nbsp;</b><span>&nbsp;</span></div>) : null}
        </div>
      </section>

      <section className="fp-own">
        <h3 className="fp-h">Already have a design?</h3>
        <div className="fp-acts">
          <button type="button" className="btn" onClick={onUpload}><Ic name="upload" />Upload a KiCad project</button>
          <button type="button" className="btn" onClick={onJoin}><Ic name="link" />Join with link</button>
        </div>
        <p className="hp-note">Using the desktop app? Open a project there and choose File → Publish Project Online. <a href={releases} target="_blank" rel="noreferrer">Get the app</a></p>
      </section>
    </div>
  );
}
