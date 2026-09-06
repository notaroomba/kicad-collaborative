// MenuBar.tsx — the project manager's bar on the home view and KiCad's editor menus (from
// eeschema/menubar.cpp / pcbnew/menubar_pcb_editor.cpp) in the editor.  The Edit, Tools and
// Inspect menus also take whatever `actions` the active tool module publishes, bound generically:
// the entry runs `module:<id>` through app.js, which calls the action with the tool context.
import { useEffect, useState } from "react";
import { HOME_MENUS, LINKS, MENUS, MODULE_ACTION_MENUS, type MenuEntry } from "../tables";
import { useApp, type ModuleAction } from "../store";
import { isOn, keyFor, labelFor, runUiAction, unavailable, useAvail, type Avail } from "../actions";
import { cx } from "../util";

// A menu entry (button or link): a full-width row with KiCad's blue hover, its shortcut at the right.
const ITEM = "flex justify-between w-full text-left bg-transparent border-0 py-1.5 px-2.5 rounded-xs text-ink hover:bg-blue hover:text-white hover:no-underline";
const KBD = "text-xs font-mono font-normal leading-[normal] text-ink-3 group-hover/item:text-white";
// A drop-down panel: the top-level one hangs below its button, a sub-menu's opens beside its row.
const DD = "hidden absolute min-w-[230px] bg-panel border border-line rounded-sm p-1 z-50 shadow-panel";

function Entry({ id, a, close }: { id: string; a: Avail; close: () => void }) {
  const toggles = useApp((s) => s.toggles);
  const panes = useApp((s) => s.panes);
  const viewOnly = useApp((s) => s.viewOnly);
  const undo = useApp((s) => s.undo);
  const k = keyFor(a, id);
  if (LINKS[id]) return <a className={ITEM} href={LINKS[id]} target="_blank" rel="noreferrer" data-uiact={id} onClick={close}><span>{labelFor(a, id)}</span></a>;
  const why = unavailable(a, id);
  const on = isOn(id, toggles, panes);
  const disabled = viewOnly && (id === "share" || id === "checkpoint");
  const title = id === "undo" && undo.undo ? `${undo.undo} step${undo.undo === 1 ? "" : "s"}` : id === "redo" && undo.redo ? `${undo.redo} step${undo.redo === 1 ? "" : "s"}` : why || undefined;
  return (
    <button type="button" className={cx(ITEM, "group/item disabled:opacity-40 disabled:cursor-default desk:opacity-50", why && "desk", on && "on")} data-uiact={id} disabled={disabled} title={title}
      onClick={(ev) => { close(); runUiAction(a, id, ev.currentTarget); }}>
      <span>{on ? "✓ " : ""}{labelFor(a, id)}</span>{k ? <kbd className={KBD}>{k}</kbd> : null}
    </button>
  );
}

function Entries({ entries, a, close }: { entries: MenuEntry[]; a: Avail; close: () => void }) {
  return (
    <>
      {entries.map((e, i) => {
        if (e === "-") return <div className="sep h-px bg-line my-1 mx-0.5" key={"sep" + i} />;
        if (Array.isArray(e)) {
          return (
            <div className="sub relative" key={"sub" + e[0]}>
              <button type="button" className={ITEM}><span>{e[0]}</span><span>›</span></button>
              <div className={`dd ${DD} left-full -top-1 [.sub:hover>&]:block`}><Entries entries={e[1]} a={a} close={close} /></div>
            </div>
          );
        }
        return <Entry id={e} a={a} close={close} key={e + i} />;
      })}
    </>
  );
}

/** Every id a menu tree lists (a module action with the same id backs that entry instead of adding one). */
function staticIds(menus: [string, MenuEntry[]][]): Set<string> {
  const out = new Set<string>();
  const walk = (es: MenuEntry[]) => { for (const e of es) { if (Array.isArray(e)) walk(e[1]); else if (e !== "-") out.add(e); } };
  for (const [, es] of menus) walk(es);
  return out;
}
/** Where a module action without a `menu` of its own goes: KiCad's grouping by what the command does, else Edit. */
function menuFor(a: ModuleAction): string {
  if (a.menu) return a.menu;
  if (/drc|erc|inspect|statistic|netInspector|ratsnest|highlight|clearance|marker|simulat/i.test(a.id)) return "Inspect";
  if (/cleanup|swapLayers|annotat|bom\b|fieldsTable|symbolFields|update|generate|export|import|remap|rescue|bus/i.test(a.id)) return "Tools";
  return "Edit";
}
/** A module's own entries for one menu: explicit `menu` first, then the grouping above; aliases (same label + key) collapse. */
function moduleEntries(actions: ModuleAction[], title: string, taken: Set<string>): MenuEntry[] {
  const seen = new Set<string>(); const mine: string[] = [];
  for (const x of actions) {
    if (taken.has(x.id)) continue;
    const menu = menuFor(x);
    if (menu.toLowerCase() !== title.toLowerCase() || !MODULE_ACTION_MENUS.some((m) => m.toLowerCase() === menu.toLowerCase())) continue;
    const sig = x.label + "\u0000" + (x.key || ""); if (seen.has(sig)) continue; seen.add(sig);
    mine.push("module:" + x.id);
  }
  return mine.length ? ["-", ...mine] : [];
}

function Menu({ title, entries, open, setOpen, a }: { title: string; entries: MenuEntry[]; open: boolean; setOpen: (t: string | null, hover?: boolean) => void; a: Avail }) {
  const long = entries.length > 28;   // a module's whole command set lands here: scroll instead of overflowing the window
  return (
    <div className={cx("menu group relative", open && "open")} data-menu={title.toLowerCase()}>
      <button type="button" className="bg-transparent border-0 py-1 px-2.5 rounded-[3px] text-ink hover:bg-paper hover:shadow-[inset_0_0_0_1px_var(--line)] group-open:bg-paper group-open:shadow-[inset_0_0_0_1px_var(--line)]"
        onClick={(ev) => { ev.stopPropagation(); setOpen(open ? null : title); }} onMouseEnter={() => setOpen(title, true)}>{title}</button>
      <div className={cx("dd", DD, "top-[calc(100%+2px)] left-0 group-open:block long:max-h-[calc(100vh-56px)] long:overflow-y-auto", long && "long")}><Entries entries={entries} a={a} close={() => setOpen(null)} /></div>
    </div>
  );
}

export function MenuBar() {
  const a = useAvail();
  const view = useApp((s) => s.view);
  const editor = useApp((s) => s.document.editor);
  const me = useApp((s) => s.me);
  const project = useApp((s) => s.project);
  const role = useApp((s) => s.role);
  const moduleActions = useApp((s) => s.tool.moduleActions);
  const [open, setOpenRaw] = useState<string | null>(null);
  const setOpen = (t: string | null, hover?: boolean) => { if (hover) { if (open && open !== t) setOpenRaw(t); } else setOpenRaw(t); };
  useEffect(() => {
    const close = () => setOpenRaw(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  useEffect(() => { setOpenRaw(null); }, [view, editor]);
  const inEditor = view === "editor" && !!editor;
  const taken = inEditor ? staticIds(MENUS[editor]) : new Set<string>();
  const menus: [string, MenuEntry[]][] = inEditor
    ? MENUS[editor].map(([title, entries]) => [title, [...entries, ...moduleEntries(moduleActions, title, taken)]] as [string, MenuEntry[]])
    : HOME_MENUS;
  const next = encodeURIComponent(location.pathname);
  return (
    <div id="menubar" className="flex items-center gap-0.5 px-2 bg-bench border-b border-line select-none">
      <div className="brand flex items-center gap-2 font-semibold mr-3">
        <svg className="logo w-4.5 h-4.5 block" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="5" fill="#001023" /><path d="M10.5 10.5 L21.5 21.5" stroke="#F2EDA1" strokeWidth="2.6" strokeLinecap="round" /><circle cx="10.5" cy="10.5" r="4.2" fill="#C83434" /><circle cx="21.5" cy="21.5" r="4.2" fill="#4D7FC4" /></svg>
        KiCad Collaborative <span className="ver text-xs font-mono font-normal leading-[normal] text-ink-3">1.0.3</span>
      </div>
      <div id={inEditor ? "kmenus" : "homeMenus"} className="flex gap-0.5">
        {menus.map(([title, entries]) => <Menu key={title} title={title} entries={entries} open={open === title} setOpen={setOpen} a={a} />)}
      </div>
      {inEditor && project ? (
        <>
          <span className="name ml-3.5 font-semibold" id="projName">{project.name}</span>
          <span className={cx("pill", role, "ml-1.5")} id="roleChip">{role || "guest"}</span>
        </>
      ) : null}
      <div className="spacer flex-1" />
      <div className="user flex items-center gap-2 text-ink-2" id="userBox">
        {me ? (
          <>
            {me.avatarUrl ? <img className="w-5 h-5 rounded-[50%]" src={me.avatarUrl} alt="" /> : null}
            <span>{me.name || me.login}</span>
          </>
        ) : <a className="btn sm" id="signinBtn" href={`/auth/github/login?next=${next}`}>Sign in with GitHub</a>}
      </div>
    </div>
  );
}
