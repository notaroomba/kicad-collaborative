// TemplatePicker.tsx — choose a starter template for a new project: finished KiCad projects
// (schematic, board and project file) that pass KiCad's own ERC and DRC, shown with the pictures
// KiCad drew of them.  Used inside the New project dialog (UploadDialog.tsx).
import { useEffect, useState } from "react";
import { listTemplates, type Template } from "./api";

export interface TemplateChoice { template: string; name: string; guided: boolean }

export function TemplatePicker({ value, onChange, onSubmit, disabled }: {
  value: TemplateChoice; onChange: (next: TemplateChoice) => void; onSubmit: () => void; disabled?: boolean;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<"board" | "schematic">("board");
  const [named, setNamed] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true; setError(null);
    listTemplates().then((l) => { if (live) setList(l); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [tries]);

  const picked = list ? list.find((t) => t.id === value.template) || list[0] : null;
  // The name follows the template until the person types their own.
  useEffect(() => {
    if (!picked) return;
    if (picked.id !== value.template || (!named && value.name !== picked.title)) onChange({ template: picked.id, name: named ? value.name : picked.title, guided: value.guided && picked.guided });
  }, [picked, named]);   // eslint-disable-line

  if (error) return <p className="hp-note err" role="alert">Couldn't load the templates: {error} <button type="button" className="btn sm" onClick={() => setTries((n) => n + 1)}>Try again</button></p>;
  if (!list || !picked) return <div className="tp-grid" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="tp-card skel"><div className="tp-pic" /><b>&nbsp;</b></div>)}</div>;

  const pick = (t: Template) => onChange({ template: t.id, name: named ? value.name : t.title, guided: value.guided && t.guided });
  return (
    <div className="tp">
      <div className="tp-grid" role="radiogroup" aria-label="Template">
        {list.map((t) => (
          <button type="button" key={t.id} role="radio" aria-checked={t.id === picked.id} className={"tp-card" + (t.id === picked.id ? " on" : "")} disabled={disabled} onClick={() => pick(t)}>
            <span className="tp-pic"><img src={t.board} alt="" loading="lazy" /></span>
            <b>{t.title}</b>
            <span className="tp-level">{t.level}</span>
          </button>
        ))}
      </div>
      <div className="tp-detail">
        <div className="tp-view">
          <img key={picked.id + side} src={side === "board" ? picked.board : picked.schematic} alt={`${picked.title}: ${side === "board" ? "the board" : "the schematic"}`} className={side} />
          <div className="hp-seg tp-sides" role="group" aria-label="Picture">
            <button type="button" className={side === "board" ? "on" : undefined} aria-pressed={side === "board"} onClick={() => setSide("board")}>Board</button>
            <button type="button" className={side === "schematic" ? "on" : undefined} aria-pressed={side === "schematic"} onClick={() => setSide("schematic")}>Schematic</button>
          </div>
        </div>
        <div className="tp-about">
          <p className="tp-sum">{picked.summary}</p>
          <p className="tp-more">{picked.detail}</p>
          <p className="tp-meta">{picked.parts} parts · {picked.nets} nets · {picked.size[0]} × {picked.size[1]} mm · {picked.layers} copper layers</p>
          <p className="tp-meta ok">Passes KiCad's electrical and design rule checks.</p>
        </div>
      </div>
      <label className="hp-field"><span>Project name</span>
        <input className="hp-input" value={value.name} maxLength={120} disabled={disabled}
          onChange={(ev) => { setNamed(true); onChange({ ...value, template: picked.id, name: ev.target.value }); }}
          onKeyDown={(ev) => { if (ev.key === "Enter") onSubmit(); }} /></label>
      {picked.guided ? (
        <label className="tp-guided"><input type="checkbox" checked={value.guided} disabled={disabled} onChange={(ev) => onChange({ ...value, template: picked.id, guided: ev.target.checked })} />
          <span><b>Walk me through it.</b> Four connections are left for you to route, with a short guide beside the board.</span></label>
      ) : null}
    </div>
  );
}
