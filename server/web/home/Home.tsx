// Home.tsx — the projects window: everything stored online that you own or were given, with
// search, sort, upload, rename, share, visibility, download, leave and delete; plus Explore
// (public projects) and joining by link.  One layout from a phone to a wide desktop.
import { Select } from "../components/Select";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type CSSProperties, type MouseEvent as RMouseEvent } from "react";
import { flushSync } from "react-dom";
import { useApp, type User } from "../store";
import * as API from "./api";
import type { Project } from "./api";
import { ShareDialog, type ShareTarget } from "./ShareDialog";
import { cachedThumb, localThumb } from "./thumb";
import { filesFromDrop, UploadDialog } from "./UploadDialog";
import { TimePage } from "./TimePage";
import { FirstProject } from "../onboarding/FirstProject";
import { miniBoard, startGuidedProject } from "../onboarding/state";
import { ago, Avatar, Confirm, copyText, Ic, layerOpen, Menu, Modal, PHONE, toast, toastError, useMedia, type MenuAt, type MenuEntry } from "./ui";

const RELEASES = "https://github.com/notaroomba/junction/releases";
type Tab = "projects" | "explore" | "trash" | "time";
type Scope = "all" | "owned" | "shared" | "starred";
type Sort = "updated" | "name" | "created";
type Layout = "grid" | "list";

declare global {
  interface Window {
    CollabNav?: { navigate(path: string, replace?: boolean): void; reloadMe(): Promise<void> };
    CollabHome?: { openShare(projectId: string, name: string): void; refresh(): void; newProject(): void; join(): void; signOut(): void };
  }
}
const go = (path: string) => { if (window.CollabNav) window.CollabNav.navigate(path); else location.href = path; };
const editUrl = (id: string) => `/p/${id}/edit`;
/** A project just made opens on its schematic, where a KiCad design starts (the editor would pick the board). */
const newProjectUrl = (r: { projectId: string; docs?: unknown[] }) => {
  const sch = ((r.docs || []) as { docId?: string; path?: string; docType?: string }[])
    .filter((d) => d && d.docType === "kicad_sch" && d.docId && d.path)
    .sort((x, y) => x.path!.split("/").length - y.path!.split("/").length || x.path!.length - y.path!.length)[0];
  return editUrl(r.projectId) + (sch ? `?doc=${sch.docId}` : "");
};

function pref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
}
function savePref(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

/** Apply a list change as a view transition where the browser has them: cards glide to their new
 *  places and removed ones fade, instead of the grid jumping.  Elsewhere the change just happens. */
function smooth(change: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const many = document.querySelectorAll(".hp-items > .hp-item").length > 80;   // every card is a snapshot layer
  if (!d.startViewTransition || many || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) { change(); return; }
  let done = false;
  const run = () => { if (!done) { done = true; flushSync(change); } };
  try {
    const t = d.startViewTransition(run) as { finished?: Promise<unknown>; ready?: Promise<unknown>; updateCallbackDone?: Promise<unknown> };
    // A newer transition skips this one: that is fine, the change itself still ran.
    for (const pr of [t.finished, t.ready, t.updateCallbackDone]) pr?.catch(() => { run(); });
  } catch { run(); }
}

/** Deletes still on their way to the server: the Trash page waits for them, so a project trashed a moment ago is listed. */
const trashing = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> { trashing.add(p); const done = () => { trashing.delete(p); }; p.then(done, done); return p; }

/** The project just uploaded or copied: its card is highlighted once. */
let freshId: string | null = null;

// The list survives leaving for the editor and coming back: it shows at once and revalidates behind.
const cache: { mine: Project[] | null; gallery: Project[] | null; for: number | null } = { mine: null, gallery: null, for: null };

/** A change made from somewhere that may have outlived its page (a toast's Undo, after moving to another tab):
 *  it goes into the remembered list and whichever page is showing now looks again. */
function changeAnywhere(fn: (l: Project[]) => Project[]) {
  if (cache.mine) cache.mine = fn(cache.mine);
  window.CollabHome?.refresh();
}
const putBack = (ps: Project[]) => (l: Project[]) => [...l, ...ps.filter((p) => !l.some((x) => x.projectId === p.projectId))];

/** Several archives, without pop-ups (a click allows one new window; the rest are blocked): hidden download links, a moment apart. */
function downloadArchives(all: Project[]) {
  const ps = all.filter((p) => p.canCopy !== false);
  if (ps.length < all.length) toast(ps.length ? "Some projects were skipped: their owner does not let viewers download them." : "The owner does not let viewers download this project.", { kind: "err" });
  ps.forEach((p, i) => window.setTimeout(() => {
    const a = document.createElement("a");
    a.href = `/api/projects/${p.projectId}/archive`; a.download = ""; a.hidden = true;
    document.body.appendChild(a); a.click();
    window.setTimeout(() => a.remove(), 2000);
  }, i * 400));
}

function useProjects(kind: "mine" | "gallery", enabled: boolean, userId: number | null, tick: number) {
  if (kind === "mine" && cache.for !== userId) { cache.mine = null; cache.for = userId; }
  const [list, setList] = useState<Project[] | null>(enabled ? cache[kind] : null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const pending = useRef(0);   // changes whose request has not come back yet
  const load = useCallback(async () => {
    if (!enabled) { setList(null); return; }
    const mine = ++seq.current;
    setLoading(true);
    try {
      const l = await (kind === "mine" ? API.listProjects() : API.listGallery());
      if (mine !== seq.current) return;
      // While a change is on its way the server may still answer with the list from before it.
      if (!pending.current) { cache[kind] = l; setList(l); setError(null); setSignedOut(false); }
    } catch (e) { if (mine === seq.current) { setError(e instanceof Error ? e.message : String(e)); setSignedOut(e instanceof API.ApiError && e.status === 401); } }
    if (mine === seq.current) setLoading(false);
  }, [kind, enabled]);
  useEffect(() => { setList(enabled ? cache[kind] : null); load(); }, [load, tick, userId, kind, enabled]);
  // Someone may have shared or renamed something while the tab was in the background.
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => { if (Date.now() - last > 15000 && document.visibilityState === "visible") { last = Date.now(); load(); } };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [load]);
  // A local change outranks any list request already on its way: that answer is from before
  // the change and would put the old value back.  `request` is the change on its way to the
  // server; a fresh look follows once the last such request is back, however long it takes.
  const settle = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const mutate = useCallback((fn: (l: Project[]) => Project[], request?: Promise<unknown>, inPlace?: boolean) => {
    seq.current++; setLoading(false);
    const apply = () => setList((l) => { const next = l ? fn(l) : l; if (next) cache[kind] = next; return next; });
    if (inPlace) apply(); else smooth(apply);   // a change that moves no card needs no transition, and shows in the same frame
    window.clearTimeout(settle.current);
    const later = (ms: number) => { window.clearTimeout(settle.current); if (alive.current) settle.current = window.setTimeout(() => { load(); }, ms); };
    if (request) {
      pending.current++;
      const back = () => { pending.current--; seq.current++; if (alive.current) setLoading(false); if (!pending.current) later(300); };
      request.then(back, back);
    } else if (!pending.current) later(1200);
  }, [kind, load]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(settle.current); }; }, []);
  return { list, error, signedOut, loading, reload: load, mutate };
}

// ---------------------------------------------------------------- one project (card or row)
/** The server's preview when it has one, else the board drawn right here (web/home/thumb.ts) once the card is on screen. */
function Thumb({ id, stamp, canKeep }: { id: string; stamp: string; canKeep?: boolean }) {
  const local = cachedThumb(id, stamp);
  const [src, setSrc] = useState<string | null>(local || `/api/projects/${id}/preview.svg?v=${encodeURIComponent(stamp)}`);
  const [state, setState] = useState<"load" | "ok" | "none">(local ? "ok" : local === null ? "none" : "load");
  const [fallback, setFallback] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fallback) return;
    let live = true;
    const start = () => localThumb(id, stamp, !!canKeep).then((url) => { if (!live) return; if (url) { setSrc(url); setState("ok"); } else setState("none"); });
    const el = box.current;
    if (!el || typeof IntersectionObserver !== "function") { start(); return () => { live = false; }; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [fallback, id, stamp, canKeep]);
  return (
    <div className={"hp-thumb " + state} ref={box}>
      {state !== "none" && src && !(fallback && state === "load") ? <img loading="lazy" decoding="async" src={src} alt="" onLoad={() => setState("ok")} onError={() => { if (!fallback) setFallback(true); else setState("none"); }} /> : null}
      {state !== "ok" ? <svg viewBox="0 0 64 48" aria-hidden="true"><path d="M10 34h14l6-10h10l6 10h8M24 34v-8M40 24V14h10" /><circle cx="24" cy="24" r="2.5" /><circle cx="50" cy="14" r="2.5" /><circle cx="10" cy="34" r="2.5" /></svg> : null}
    </div>
  );
}

interface ItemProps {
  p: Project; me: User | null; layout: Layout; renaming: boolean; fresh: boolean;
  onMenu: (p: Project, at: MenuAt) => void;
  onRename: (p: Project, name: string | null) => void; onStartRename: (p: Project) => void; onShare: (p: Project) => void;
  onStar: (p: Project) => void; onDelete: (p: Project) => void;
  /** Position in the list: staggers the entrance. */
  index: number;
  /** Selection mode: undefined when off, else whether this one is picked. */
  picked?: boolean; onPick: (p: Project, range: boolean) => void;
}
function ProjectItem({ p, me, layout, renaming, fresh, onMenu, onRename, onStartRename, onShare, onStar, onDelete, picked, onPick, index }: ItemProps) {
  const owned = !!me && p.ownerId === me.id;
  const role = owned ? "owner" : p.role || "";
  const open = (ev: RMouseEvent) => {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (picked !== undefined) { ev.preventDefault(); onPick(p, ev.shiftKey); return; }   // selecting: a click picks, it does not open
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;   // let the browser open a new tab
    ev.preventDefault(); go(editUrl(p.projectId));
  };
  // Keyboard focus returns to the card when its rename box goes away.
  const link = useRef<HTMLAnchorElement>(null);
  const was = useRef(renaming);
  useEffect(() => { if (was.current && !renaming && (!document.activeElement || document.activeElement === document.body)) link.current?.focus(); was.current = renaming; }, [renaming]);
  const key = (ev: RKeyboardEvent) => {
    if (renaming) return;
    if (ev.key === " " ) { ev.preventDefault(); onPick(p, ev.shiftKey); }
    else if (ev.key === "F2" && owned) { ev.preventDefault(); onStartRename(p); }
    else if (ev.key === "Delete") { ev.preventDefault(); onDelete(p); }
    else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); onMenu(p, { x: r.left + 24, y: r.top + 24 }); }
  };
  const more = (ev: RMouseEvent) => { ev.preventDefault(); ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); onMenu(p, { x: r.left, y: r.bottom + 4, right: r.right, top: r.top }); };
  const people = (p.memberCount || 0) + 1;
  return (
    <li className={"hp-item " + layout + (fresh ? " fresh" : "") + (picked !== undefined ? " picking" : "") + (picked ? " picked" : "")}
      style={{ viewTransitionName: "hp-" + p.projectId.replace(/[^a-zA-Z0-9_-]/g, ""), "--i": Math.min(index, 14) } as CSSProperties}>
      {picked !== undefined ? <span className="hp-pick" aria-hidden="true">{picked ? <Ic name="check" size={14} /> : null}</span> : null}
      <a className="hp-item-link" ref={link} aria-selected={picked} href={editUrl(p.projectId)} onClick={open} onKeyDown={key} draggable={false}
        onContextMenu={(ev) => { ev.preventDefault(); onMenu(p, { x: ev.clientX, y: ev.clientY }); }} aria-label={`Open ${p.name}`}>
        <Thumb id={p.projectId} stamp={p.updatedAt} canKeep={owned || p.role === "editor"} />
        <div className="hp-item-body">
          {renaming ? (
            <input className="hp-input hp-rename" defaultValue={p.name} maxLength={120} autoFocus aria-label="Project name"
              onFocus={(ev) => ev.currentTarget.select()} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}
              onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); onRename(p, ev.currentTarget.value); } else if (ev.key === "Escape") { ev.preventDefault(); onRename(p, null); } }}
              onBlur={(ev) => onRename(p, ev.currentTarget.value)} />
          ) : <div className="hp-item-name" title={p.name}>{p.name}</div>}
          {p.description ? <div className="hp-item-desc" title={p.description}>{p.description}</div> : null}
          <div className="hp-item-meta">
            <Avatar login={p.ownerLogin} url={p.ownerAvatarUrl} size={16} />
            <span className="hp-item-owner">{owned ? "you" : p.ownerLogin}</span>
            <span aria-hidden="true">·</span><span className="hp-item-when">{ago(p.updatedAt)}</span>
            {people > 1 ? <span className="hp-item-people" title={`${people} people have access`} aria-label={`${people} people have access`}><Ic name="people" size={12} />{people}</span> : null}
            {p.public ? <span className="hp-item-pub" title="Public: listed in Explore" aria-label="public"><Ic name="globe" size={12} /></span> : null}
            {p.github ? <span className="hp-item-gh" title={`Linked to ${p.github.repo} on GitHub (${p.github.branch})`} aria-label={`linked to ${p.github.repo} on GitHub`}><Ic name="branch" size={12} />{p.github.repo.split("/")[1]}</span> : null}
          </div>
        </div>
        <div className="hp-item-tags">
          {role ? <span className={"pill " + role}>{role}</span> : null}
          {p.public ? <span className="pill" title="Listed in Explore">public</span> : null}
        </div>
      </a>
      <button type="button" className={"hp-star" + (p.starred ? " on" : "")} aria-pressed={!!p.starred} title={p.starred ? "Starred. Click to unstar" : "Star to keep at the top"}
        aria-label={p.starred ? `Unstar ${p.name}` : `Star ${p.name}`} onClick={() => onStar(p)}><Ic name="star" size={16} /></button>
      <div className="hp-item-acts">
        {p.memberCount !== undefined ? (
          <button type="button" className="hp-chip" title={people === 1 ? "Only you. Share…" : `${people} people have access`} aria-label={`${people} ${people === 1 ? "person has" : "people have"} access. Share`}
            onClick={() => onShare(p)}><Ic name="people" size={14} />{people}</button>
        ) : null}
        <button type="button" className="hp-iconbtn" aria-label={`Actions for ${p.name}`} aria-haspopup="menu" onClick={more}><Ic name="more" /></button>
      </div>
    </li>
  );
}

function Skeleton({ layout }: { layout: Layout }) {
  return <ul className={"hp-items " + layout} aria-busy="true" aria-label="Loading projects">{Array.from({ length: 6 }, (_, i) => <li className={"hp-item skel " + layout} key={i} style={{ "--i": i } as CSSProperties}><div className="hp-thumb load" /><div className="hp-item-body"><i /><i /></div></li>)}</ul>;
}

// ---------------------------------------------------------------- small dialogs
function JoinDialog({ me, onClose }: { me: User | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const going = useRef(false);
  const join = async (raw = text) => {
    if (going.current) return;
    const direct = raw.match(/\/p\/([0-9a-f-]{36})/i);
    if (direct) { onClose(); go(editUrl(direct[1])); return; }
    const token = API.linkToken(raw);
    if (!token) { setError("That doesn't look like a share link. It should look like https://…/j/…"); return; }
    if (!me) { location.href = `/auth/github/login?next=${encodeURIComponent("/j/" + token)}`; return; }
    going.current = true; setBusy(true); setError(null);
    try { const j = await API.claimLink(token); cache.mine = null; onClose(); toast(`Joined as ${j.role}`); go(editUrl(j.projectId)); }
    catch (e) { going.current = false; setBusy(false); setError(e instanceof API.ApiError && e.status === 404 ? "That link is no longer valid. Ask the owner for a new one." : e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Modal title="Join with a link" onClose={onClose} width={460} busy={busy}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => join()} disabled={busy || !text.trim()}>{busy ? "Joining…" : me ? "Join" : "Sign in and join"}</button></>}>
      <label className="hp-field"><span>Share link</span>
        <input className="hp-input mono" data-autofocus placeholder="https://…/j/…" value={text} spellCheck={false} autoComplete="off"
          onChange={(ev) => { setText(ev.target.value); setError(null); }}
          onPaste={(ev) => { const t = ev.clipboardData.getData("text"); if (API.linkToken(t) && me) { ev.preventDefault(); setText(t.trim()); join(t); } }}
          onKeyDown={(ev) => { if (ev.key === "Enter") join(); }} /></label>
      {error ? <p className="hp-note err" role="alert">{error}</p> : <p className="hp-note">Paste the link someone sent you. The project is added to your list and opens right away. The same link works in the desktop app under File → Join Session from URL…</p>}
    </Modal>
  );
}

function DetailsDialog({ p, onClose, onSaved }: { p: Project; onClose: () => void; onSaved: (patch: { name: string; description: string }) => void }) {
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await API.patchProject(p.projectId, { name: name.trim(), description: description.trim() }); onSaved({ name: name.trim(), description: description.trim() }); onClose(); toast("Saved"); }
    catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title="Project details" onClose={onClose} width={480} busy={busy}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button></>}>
      <label className="hp-field"><span>Name</span><input className="hp-input" data-autofocus value={name} maxLength={120} onChange={(ev) => setName(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") save(); }} /></label>
      <label className="hp-field"><span>Description <small>{description.length}/2000</small></span>
        <textarea className="hp-input" rows={4} maxLength={2000} value={description} placeholder="What is this board? Shown in the list and in Explore." onChange={(ev) => setDescription(ev.target.value)} /></label>
      <p className="hp-note">Renaming here changes the name online only. Files and folders on anyone's computer keep their names.</p>
    </Modal>
  );
}

/** What an error offers: another try, or, when the session is over, the way back in. */
function Retry({ signedOut, onRetry, small }: { signedOut: boolean; onRetry: () => void; small?: boolean }) {
  return signedOut ? <a className={"btn primary" + (small ? " sm" : "")} href={API.loginUrl()}>Sign in</a>
    : <button type="button" className={"btn" + (small ? " sm" : "")} onClick={onRetry}>Try again</button>;
}

// ---------------------------------------------------------------- the projects page
function Projects({ me, tick, onUpload, onGuided, onJoin, onShare }: { me: User; tick: number; onUpload: () => void; onGuided: () => void; onJoin: () => void; onShare: (t: ShareTarget) => void }) {
  const { list, error, signedOut, loading, reload, mutate } = useProjects("mine", true, me.id, tick);
  // `q` is what the box says, `find` what the list is filtered by: it follows a frame later, as a view transition.
  const [q, setQ] = useState("");
  const [find, setFind] = useState("");
  const typed = (v: string) => { setQ(v); smooth(() => setFind(v)); };
  const [scope, setScope] = useState<Scope>(() => pref<Scope>("kc.home.scope", "all", ["all", "owned", "shared", "starred"]));
  const [sort, setSort] = useState<Sort>(() => pref<Sort>("kc.home.sort", "updated", ["updated", "name", "created"]));
  const [layoutPref, setLayout] = useState<Layout>(() => pref<Layout>("kc.home.layout", "grid", ["grid", "list"]));
  const phone = useMedia(PHONE);
  const layout: Layout = phone ? "list" : layoutPref;
  const [menu, setMenu] = useState<{ p: Project; at: MenuAt } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [details, setDetails] = useState<Project | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "delete" | "leave" | "bulk"; p: Project }>(null);
  const search = useRef<HTMLInputElement>(null);
  // Selecting several projects to act on at once.  `sel` is null while selection mode is off.
  const [sel, setSel] = useState<Set<string> | null>(null);
  const anchor = useRef<string | null>(null);
  // The card of a project that just arrived is highlighted once, then the mark is spent.
  const [fresh, setFresh] = useState(freshId);
  useEffect(() => {
    if (freshId && freshId !== fresh) setFresh(freshId);
    if (!fresh || !list?.some((p) => p.projectId === fresh)) return;
    const t = window.setTimeout(() => { if (freshId === fresh) freshId = null; setFresh(null); }, 2600);
    return () => window.clearTimeout(t);
  }, [fresh, list]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (ev.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !document.querySelector(".hp-scrim")) { ev.preventDefault(); search.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const owned = (p: Project) => p.ownerId === me.id;
  const counts = useMemo(() => ({ all: list?.length || 0, owned: list?.filter(owned).length || 0, shared: list?.filter((p) => !owned(p)).length || 0,
    starred: list?.filter((p) => p.starred).length || 0 }), [list, me.id]);   // eslint-disable-line
  const shown = useMemo(() => {
    if (!list) return [];
    const needle = find.trim().toLowerCase();
    const out = list.filter((p) => (scope === "all" || (scope === "starred" ? !!p.starred : (scope === "owned") === owned(p)))
      && (!needle || p.name.toLowerCase().includes(needle) || p.ownerLogin.toLowerCase().includes(needle) || (p.description || "").toLowerCase().includes(needle)));
    const t = (s?: string) => (s ? new Date(s).getTime() : 0);
    // Starred projects stay at the top, whatever the order below them.
    out.sort((a, b) => (a.starred ? 0 : 1) - (b.starred ? 0 : 1) || (sort === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
      : sort === "created" ? t(b.createdAt) - t(a.createdAt) : t(b.updatedAt) - t(a.updatedAt)));
    return out;
  }, [list, find, scope, sort, me.id]);   // eslint-disable-line

  const pick = (p: Project, range: boolean) => {
    setSel((cur) => {
      const next = new Set(cur || []);
      const ids = shown.map((x) => x.projectId);
      const a = anchor.current ? ids.indexOf(anchor.current) : -1, b = ids.indexOf(p.projectId);
      if (range && a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
      else if (next.has(p.projectId)) next.delete(p.projectId); else next.add(p.projectId);
      anchor.current = p.projectId;
      return next;
    });
  };
  // Only what is on screen counts as selected: a project the search or the filter has hidden is not acted on.
  const picked = useMemo(() => (sel ? shown.filter((p) => sel.has(p.projectId)) : []), [sel, shown]);
  useEffect(() => {
    if (!sel) return;
    const onKey = (ev: KeyboardEvent) => {
      if (document.querySelector(".hp-scrim, .hp-menu-scrim") || /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target as HTMLElement).tagName)) return;
      if (ev.key === "Escape") setSel(null);
      else if ((ev.metaKey || ev.ctrlKey) && (ev.key === "a" || ev.key === "A")) { ev.preventDefault(); setSel(new Set(shown.map((p) => p.projectId))); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sel, shown]);
  const bulkStar = async (on: boolean) => {
    const targets = picked.filter((p) => !!p.starred !== on);
    const reqs = targets.map((p) => API.setStar(p.projectId, on));
    targets.forEach((p, i) => patch(p.projectId, { starred: on }, reqs[i]));
    const failed = (await Promise.allSettled(reqs)).filter((r) => r.status === "rejected").length;
    if (failed) { toast(`${failed} of ${targets.length} could not be ${on ? "starred" : "unstarred"}`, { kind: "err" }); reload(); }
    else toast(on ? `Starred ${targets.length}` : `Removed ${targets.length} star${targets.length === 1 ? "" : "s"}`);
  };
  /** Owned projects go to the Trash, shared ones are left; one toast undoes the trashing. */
  const bulkRemove = async () => {
    const mine = picked.filter(owned), theirs = picked.filter((p) => !owned(p));
    const all = [...mine, ...theirs], total = all.length;
    const ids = new Set(all.map((p) => p.projectId));
    const reqs = Promise.allSettled([...mine.map((p) => track(API.deleteProject(p.projectId))), ...theirs.map((p) => API.leaveProject(p.projectId))]);
    mutate((l) => l.filter((x) => !ids.has(x.projectId)), reqs);
    setSel(null);
    const res = await reqs;
    const failed = all.filter((_, i) => res[i].status === "rejected");
    const done = mine.filter((_, i) => res[i].status === "fulfilled");
    if (failed.length) { mutate(putBack(failed)); toast(`${failed.length} of ${total} could not be removed`, { kind: "err" }); }
    else toast([mine.length ? `Moved ${mine.length} to Trash` : "", theirs.length ? `left ${theirs.length}` : ""].filter(Boolean).join(", ").replace(/^l/, "L"),
      done.length ? { action: { label: "Undo", run: async () => { const back = await Promise.allSettled(done.map((p) => API.undeleteProject(p.projectId))); changeAnywhere(putBack(done.filter((_, i) => back[i].status === "fulfilled"))); } } } : {});
  };
  const patch = (id: string, change: Partial<Project>, request?: Promise<unknown>, inPlace?: boolean) => mutate((l) => l.map((x) => (x.projectId === id ? { ...x, ...change } : x)), request, inPlace);
  /** Take a change back when the server refused it, unless something newer has replaced it meanwhile. */
  const unpatch = <K extends keyof Project>(id: string, key: K, was: Project[K], tried: Project[K]) =>
    mutate((l) => l.map((x) => (x.projectId === id && x[key] === tried ? { ...x, [key]: was } : x)));
  const rename = async (p: Project, value: string | null) => {
    if (renaming !== p.projectId) return;   // Enter then blur both land here
    setRenaming(null);
    const name = (value || "").trim();
    if (!name || name === p.name) return;
    const req = API.patchProject(p.projectId, { name });
    patch(p.projectId, { name }, req, sort !== "name");   // the new name is there the moment the box closes; only a list sorted by name re-orders
    try { await req; toast("Renamed"); } catch (e) { unpatch(p.projectId, "name", p.name, name); toastError(e); }
  };
  const setPublic = async (p: Project, next: boolean) => {
    const req = API.patchProject(p.projectId, { public: next });
    patch(p.projectId, { public: next }, req);
    try {
      await req;
      // Undo may be pressed from another page than this one: it does not lean on this list.
      const undo = async () => {
        try { await API.patchProject(p.projectId, { public: !next }); changeAnywhere((l) => l.map((x) => (x.projectId === p.projectId ? { ...x, public: !next } : x))); toast(next ? "Now private" : "Listed in Explore"); }
        catch (e) { toastError(e); }
      };
      toast(next ? "Listed in Explore" : "Now private", { action: { label: "Undo", run: undo } });
    } catch (e) { unpatch(p.projectId, "public", !next, next); toastError(e); }
  };
  const star = async (p: Project) => {
    const next = !p.starred;
    const req = API.setStar(p.projectId, next);
    patch(p.projectId, { starred: next }, req);
    try { await req; } catch (e) { unpatch(p.projectId, "starred", !next, next); toastError(e); }
  };
  // Deleting moves the project to the Trash, so it can be taken back: from the toast right away, or from Trash for 30 days.
  const trash = async (p: Project) => {
    const req = track(API.deleteProject(p.projectId));
    mutate((l) => l.filter((x) => x.projectId !== p.projectId), req);
    try {
      await req;
      toast(`Moved “${p.name}” to Trash`, { action: { label: "Undo", run: async () => { try { await API.undeleteProject(p.projectId); changeAnywhere(putBack([p])); } catch (e) { toastError(e); } } } });
    } catch (e) { mutate(putBack([p])); toastError(e); }   // only this one comes back: whatever else changed meanwhile stays
  };
  /** Delete on a card.  While selecting it means the selection, never the card that happens to have the focus. */
  const remove = (p: Project) => {
    if (sel) { if (picked.length) setConfirm({ kind: "bulk", p: picked[0] }); return; }
    if (!owned(p)) setConfirm({ kind: "leave", p }); else if ((p.memberCount || 0) > 0) setConfirm({ kind: "delete", p }); else trash(p);
  };
  const duplicate = async (p: Project) => {
    try { const c = await API.cloneProject(p.projectId); freshId = c.projectId; toast(`Made “${c.name}”`); reload(); } catch (e) { toastError(e); }
  };

  const menuFor = (p: Project): MenuEntry[] => {
    const mine = owned(p);
    const url = location.origin + editUrl(p.projectId);
    return [
      { id: "open", label: "Open", icon: "open", run: () => go(editUrl(p.projectId)) },
      { id: "tab", label: "Open in new tab", icon: "open", run: () => { window.open(editUrl(p.projectId), "_blank", "noopener"); } },
      "-",
      { id: "star", label: p.starred ? "Remove star" : "Add star", icon: "star", run: () => { star(p); } },
      { id: "share", label: mine ? "Share…" : "See who has access…", icon: "share", run: () => onShare({ projectId: p.projectId, name: p.name, isPublic: p.public }) },
      { id: "copy", label: "Copy link", icon: "link", run: () => { copyText(url, "Link copied"); } },
      { id: "time", label: "Time spent", icon: "clock", run: () => go(`/time?project=${p.projectId}`) },
      ...(mine ? [
        { id: "rename", label: "Rename", icon: "edit", run: () => setRenaming(p.projectId) },
        { id: "details", label: "Edit details…", icon: "info", run: () => setDetails(p) },
        { id: "public", label: p.public ? "Make private" : "Make public", icon: p.public ? "lock" : "globe", run: () => { setPublic(p, !p.public); } },
      ] as MenuEntry[] : []),
      "-",
      // Not offered when the owner keeps viewers and commenters from downloading or copying (the server refuses too).
      ...(p.canCopy !== false ? [
        { id: "copyp", label: "Make a copy", icon: "copy", run: () => { duplicate(p); } },
        { id: "zip", label: "Download .zip", icon: "download", run: () => { location.href = `/api/projects/${p.projectId}/archive`; } },
      ] as MenuEntry[] : []),
      ...(mine ? [{ id: "github", label: "GitHub sync…", icon: "branch", run: () => { location.href = `/p/${p.projectId}/github`; } }] as MenuEntry[] : []),
      "-",
      // Nobody else to surprise: straight to the Trash, with Undo.  A shared project asks first.
      mine ? { id: "delete", label: (p.memberCount || 0) > 0 ? "Move to Trash…" : "Move to Trash", icon: "trash", danger: true, run: () => { if ((p.memberCount || 0) > 0) setConfirm({ kind: "delete", p }); else trash(p); } }
        : { id: "leave", label: "Leave project…", icon: "leave", danger: true, run: () => setConfirm({ kind: "leave", p }) },
    ];
  };

  const empty = list && !list.length;
  return (
    <>
      <header className="hp-head">
        <div className="hp-head-title"><h1>Projects</h1>
          <button type="button" className={"hp-iconbtn" + (loading ? " spin" : "")} title="Refresh" aria-label="Refresh" onClick={reload}><Ic name="refresh" /></button></div>
        <div className="hp-head-acts">
          <button type="button" className="btn" onClick={onJoin}><Ic name="link" />Join with link</button>
          <button type="button" className="btn primary" onClick={onUpload}><Ic name="plus" />New project</button>
        </div>
      </header>

      {list && !empty ? (
        <div className="hp-tools">
          <label className="hp-search"><Ic name="search" />
            <input ref={search} type="search" placeholder="Search projects" aria-label="Search projects" value={q} onChange={(ev) => typed(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Escape" && q) { ev.preventDefault(); typed(""); } }} /><kbd>/</kbd></label>
          <div className="hp-seg" role="tablist" aria-label="Which projects">
            {(["all", "owned", "shared", "starred"] as Scope[]).map((s) => (
              <button type="button" role="tab" key={s} aria-selected={scope === s} className={scope === s ? "on" : undefined} onClick={() => { smooth(() => setScope(s)); savePref("kc.home.scope", s); }}>
                {s === "all" ? "All" : s === "owned" ? (phone ? "Mine" : "Owned by me") : s === "shared" ? (phone ? "Shared" : "Shared with me") : "Starred"}<span>{counts[s]}</span></button>
            ))}
          </div>
          <div className="hp-tools-end">
            <Select className="hp-select" label="Sort by" value={sort} onChange={(v) => { smooth(() => setSort(v as Sort)); savePref("kc.home.sort", v); }}
              options={[{ value: "updated", label: "Last edited" }, { value: "name", label: "Name" }, { value: "created", label: "Date created" }]} />
            <button type="button" className={"btn hp-selbtn" + (sel ? " on" : "")} aria-pressed={!!sel} title="Select several projects (Space on a project)" onClick={() => { anchor.current = null; setSel(sel ? null : new Set()); }}><Ic name="check" />Select</button>
            {!phone ? (
              <div className="hp-seg icons" role="group" aria-label="Layout">
                {(["grid", "list"] as Layout[]).map((l) => <button type="button" key={l} className={layout === l ? "on" : undefined} aria-pressed={layout === l} title={l === "grid" ? "Grid" : "List"} aria-label={l === "grid" ? "Grid" : "List"} onClick={() => { smooth(() => setLayout(l)); savePref("kc.home.layout", l); }}><Ic name={l} /></button>)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {sel ? (
        <div className="hp-bulk" role="toolbar" aria-label="Selected projects">
          <b>{picked.length} selected</b>
          <button type="button" className="btn sm" onClick={() => setSel(new Set(shown.map((p) => p.projectId)))} disabled={shown.every((p) => sel.has(p.projectId))}>Select all</button>
          <span className="hp-bulk-gap" />
          <button type="button" className="btn sm" disabled={!picked.length} onClick={() => bulkStar(!picked.every((p) => p.starred))}><Ic name="star" size={14} />{picked.length && picked.every((p) => p.starred) ? "Remove stars" : "Star"}</button>
          <button type="button" className="btn sm" disabled={!picked.length} onClick={() => downloadArchives(picked)}><Ic name="download" size={14} />Download</button>
          <button type="button" className="btn sm hp-danger" disabled={!picked.length} onClick={() => setConfirm({ kind: "bulk", p: picked[0] })}><Ic name="trash" size={14} />Remove</button>
          <button type="button" className="hp-iconbtn" aria-label="Done selecting" title="Done (Esc)" onClick={() => setSel(null)}><Ic name="close" /></button>
        </div>
      ) : null}

      {error && !list ? <div className="hp-error big" role="alert"><b>Couldn't load your projects</b><span>{error}</span><Retry signedOut={signedOut} onRetry={reload} /></div> : null}
      {error && list ? <div className="hp-error" role="alert"><span>Couldn't refresh: {error}</span><Retry signedOut={signedOut} onRetry={reload} small /></div> : null}
      {!list && !error ? <Skeleton layout={layout} /> : null}

      {empty ? <FirstProject onGuided={onGuided} onUpload={onUpload} onJoin={onJoin} releases={RELEASES} /> : null}

      {list && list.length && !shown.length ? (
        <div className="hp-empty small"><p>{find.trim() ? <>Nothing matches “{find.trim()}”.</> : scope === "shared" ? "Nobody has shared a project with you yet." : scope === "starred" ? "No starred projects. Star one to keep it at the top of the list." : "You don't own any projects yet."}</p>
          {find.trim() || scope !== "all" ? <button type="button" className="btn" onClick={() => { setQ(""); setFind(""); setScope("all"); savePref("kc.home.scope", "all"); }}>Show all projects</button> : null}</div>
      ) : null}

      {shown.length ? (
        <ul className={"hp-items " + layout}>
          {shown.map((p, index) => <ProjectItem key={p.projectId} p={p} index={index} me={me} layout={layout} renaming={renaming === p.projectId} fresh={fresh === p.projectId}
            onMenu={(pp, at) => setMenu({ p: pp, at })} onRename={rename} onStartRename={(pp) => setRenaming(pp.projectId)}
            onShare={(pp) => onShare({ projectId: pp.projectId, name: pp.name, isPublic: pp.public })} onStar={star}
            picked={sel ? sel.has(p.projectId) : undefined} onPick={pick}
            onDelete={remove} />)}
        </ul>
      ) : null}

      {menu ? <Menu items={menuFor(menu.p)} at={menu.at} title={menu.p.name} onClose={() => setMenu(null)} /> : null}
      {details ? <DetailsDialog p={details} onClose={() => setDetails(null)} onSaved={(c) => patch(details.projectId, c)} /> : null}
      {confirm?.kind === "delete" ? (
        <Confirm title="Move to Trash" action="Move to Trash" danger onClose={() => setConfirm(null)}
          body={<><p>Move <b>“{confirm.p.name}”</b> to the Trash?</p><p>It closes for you and the {confirm.p.memberCount} other {confirm.p.memberCount === 1 ? "person" : "people"} it is shared with. You can restore it from Trash for 30 days, with its history, comments and sharing intact. Copies on anyone's computer are not touched.</p></>}
          onConfirm={() => trash(confirm.p)} />
      ) : null}
      {confirm?.kind === "bulk" ? (() => {
        const mine = picked.filter(owned).length, theirs = picked.length - mine;
        return (
          <Confirm title="Remove projects" action={theirs && !mine ? "Leave" : "Move to Trash"} danger onClose={() => setConfirm(null)}
            body={<>{mine ? <p>Move <b>{mine} project{mine === 1 ? "" : "s"}</b> you own to the Trash? {mine === 1 ? "It closes" : "They close"} for everyone {mine === 1 ? "it is" : "they are"} shared with, and can be restored from Trash for 30 days.</p> : null}
              {theirs ? <p>Leave <b>{theirs} project{theirs === 1 ? "" : "s"}</b> shared with you? You lose access until the owner invites you again.</p> : null}</>}
            onConfirm={bulkRemove} />
        );
      })() : null}
      {confirm?.kind === "leave" ? (
        <Confirm title="Leave project" action="Leave" danger onClose={() => setConfirm(null)}
          body={<p>You will lose access to <b>“{confirm.p.name}”</b>. {confirm.p.ownerLogin} can invite you again. Your local copy is not touched.</p>}
          onConfirm={async () => { const gone = confirm.p; await API.leaveProject(gone.projectId); mutate((l) => l.filter((x) => x.projectId !== gone.projectId)); toast(`Left “${gone.name}”`); }} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- explore
function Explore({ me, tick }: { me: User | null; tick: number }) {
  const { list, error, reload, loading } = useProjects("gallery", true, null, tick);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const phone = useMedia(PHONE);
  const layout: Layout = phone ? "list" : "grid";
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list || []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.ownerLogin.toLowerCase().includes(needle) || (p.description || "").toLowerCase().includes(needle));
  }, [list, q]);
  const copy = async (p: Project) => {
    if (!me) { location.href = `/auth/github/login?next=${encodeURIComponent("/gallery")}`; return; }
    setBusy(p.projectId);
    try { const c = await API.cloneProject(p.projectId); cache.mine = null; freshId = c.projectId; toast(`“${c.name}” is in your projects`, { action: { label: "Open", run: () => go(editUrl(c.projectId)) } }); }
    catch (e) { toastError(e); }
    setBusy(null);
  };
  return (
    <>
      <header className="hp-head">
        <div className="hp-head-title"><h1>Explore</h1>
          <button type="button" className={"hp-iconbtn" + (loading ? " spin" : "")} title="Refresh" aria-label="Refresh" onClick={reload}><Ic name="refresh" /></button></div>
      </header>
      <p className="hp-lead">Public projects on this server. Open one to look around, or make a copy to edit it as your own.</p>
      {list && list.length ? (
        <div className="hp-tools"><label className="hp-search"><Ic name="search" />
          <input type="search" placeholder="Search public projects" aria-label="Search public projects" value={q} onChange={(ev) => setQ(ev.target.value)} /></label></div>
      ) : null}
      {error && !list ? <div className="hp-error big" role="alert"><b>Couldn't load public projects</b><span>{error}</span><button type="button" className="btn" onClick={reload}>Try again</button></div> : null}
      {!list && !error ? <Skeleton layout={layout} /> : null}
      {list && !list.length ? <div className="hp-empty small"><p>Nothing is public yet. Owners can list a project here from its Share dialog.</p></div> : null}
      {list && list.length && !shown.length ? <div className="hp-empty small"><p>Nothing matches “{q.trim()}”.</p></div> : null}
      {shown.length ? (
        <ul className={"hp-items " + layout}>
          {shown.map((p, index) => (
            <li className={"hp-item pub " + layout} key={p.projectId} style={{ "--i": Math.min(index, 14) } as CSSProperties}>
              <a className="hp-item-link" href={editUrl(p.projectId)} aria-label={`Open ${p.name}`}
                onClick={(ev) => { if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); go(editUrl(p.projectId)); }}>
                <Thumb id={p.projectId} stamp={p.updatedAt} />
                <div className="hp-item-body">
                  <div className="hp-item-name" title={p.name}>{p.name}</div>
                  {p.description ? <div className="hp-item-desc">{p.description}</div> : null}
                  <div className="hp-item-meta"><Avatar login={p.ownerLogin} size={16} /><span className="hp-item-owner">{p.ownerLogin}</span><span aria-hidden="true">·</span><span className="hp-item-when">{ago(p.updatedAt)}</span></div>
                </div>
              </a>
              <div className="hp-item-acts"><button type="button" className="btn sm" disabled={busy === p.projectId} onClick={() => copy(p)}><Ic name="copy" size={14} />{busy === p.projectId ? "Copying…" : "Make a copy"}</button></div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- trash
function Trash({ tick }: { tick: number }) {
  const [list, setList] = useState<API.Trashed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [confirm, setConfirm] = useState<null | { all?: boolean; p?: API.Trashed }>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try { await Promise.allSettled([...trashing]); const l = await API.listTrash(); if (mine !== seq.current) return; smooth(() => setList(l)); setError(null); setSignedOut(false); }
    catch (e) { if (mine !== seq.current) return; setError(e instanceof Error ? e.message : String(e)); setSignedOut(e instanceof API.ApiError && e.status === 401); }
  }, []);
  useEffect(() => { load(); }, [load, tick]);
  const drop = (gone: API.Trashed[]) => { seq.current++; smooth(() => setList((l) => l && l.filter((x) => !gone.some((g) => g.projectId === x.projectId)))); };
  const restore = async (p: API.Trashed) => {
    drop([p]);
    try { await API.undeleteProject(p.projectId); cache.mine = null; freshId = p.projectId; toast(`Restored “${p.name}”`, { action: { label: "Show", run: () => go("/") } }); }
    catch (e) { toastError(e); load(); }
  };
  const days = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
  return (
    <>
      <header className="hp-head">
        <div className="hp-head-title"><h1>Trash</h1></div>
        {list && list.length ? <div className="hp-head-acts always">
          <button type="button" className="btn" onClick={async () => { const all = list; drop(all); const bad = (await Promise.allSettled(all.map((p) => API.undeleteProject(p.projectId)))).filter((r) => r.status === "rejected").length; cache.mine = null; if (bad) { toast(`${bad} could not be restored`, { kind: "err" }); load(); } else toast(`Restored ${all.length} project${all.length === 1 ? "" : "s"}`, { action: { label: "Show", run: () => go("/") } }); }}><Ic name="restore" />Restore all</button>
          <button type="button" className="btn" onClick={() => setConfirm({ all: true })}><Ic name="trash" />Empty Trash</button></div> : null}
      </header>
      <p className="hp-lead">Deleted projects stay here for 30 days, then they are removed for good. Restoring one brings back its history, comments and sharing.</p>
      {error ? <div className="hp-error" role="alert"><span>{error}</span><Retry signedOut={signedOut} onRetry={load} small /></div> : null}
      {!list && !error ? <Skeleton layout="list" /> : null}
      {list && !list.length ? <div className="hp-empty small"><p>Trash is empty.</p></div> : null}
      {list && list.length ? (
        <ul className="hp-items list">
          {list.map((p) => (
            <li className="hp-item list hp-trash-row" key={p.projectId} style={{ viewTransitionName: "hpt-" + p.projectId.replace(/[^a-zA-Z0-9_-]/g, "") } as CSSProperties}>
              <div className="hp-item-body">
                <div className="hp-item-name">{p.name}</div>
                <div className="hp-item-meta"><span>deleted {ago(p.deletedAt)}</span><span aria-hidden="true">·</span><span>{days(p.purgeAt) <= 1 ? "removed for good within a day" : `${days(p.purgeAt)} days left`}</span></div>
              </div>
              <div className="hp-item-acts">
                <button type="button" className="btn sm" onClick={() => restore(p)}><Ic name="restore" size={14} />Restore</button>
                <button type="button" className="hp-iconbtn" title="Delete forever" aria-label={`Delete ${p.name} forever`} onClick={() => setConfirm({ p })}><Ic name="trash" /></button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {confirm ? (
        <Confirm title={confirm.all ? "Empty Trash" : "Delete forever"} action={confirm.all ? "Empty Trash" : "Delete forever"} danger onClose={() => setConfirm(null)}
          body={confirm.all ? <p>Permanently delete the {list?.length} project{list?.length === 1 ? "" : "s"} in Trash? This can't be undone.</p>
            : <p>Permanently delete <b>“{confirm.p!.name}”</b>, with its history and comments? This can't be undone.</p>}
          onConfirm={async () => {
            if (!confirm.all) { const p = confirm.p!; await API.deleteProject(p.projectId, true); drop([p]); toast(`Deleted “${p.name}” forever`); return; }
            // Each one stands alone: those that went are taken off the list even when another did not.
            const targets = list || [];
            const res = await Promise.allSettled(targets.map((t) => API.deleteProject(t.projectId, true)));
            const gone = targets.filter((_, i) => res[i].status === "fulfilled");
            drop(gone);
            if (gone.length === targets.length) toast("Trash emptied");
            else { toast(`${targets.length - gone.length} of ${targets.length} could not be deleted`, { kind: "err" }); load(); }
          }} />
      ) : null}
    </>
  );
}

function Welcome({ onJoin }: { onJoin: () => void }) {
  return (
    <div className="hp-welcome">
      <h1>KiCad, together</h1>
      <p className="hp-lead">Keep KiCad projects online and edit them with other people in real time: shared cursors, live edits, comments and history, in the desktop app and here in the browser.</p>
      <div className="hp-empty-acts">
        <a className="btn primary" href={API.loginUrl(location.pathname.startsWith("/trash") ? location.pathname : "/")}><Ic name="people" />Sign in with GitHub</a>
        <button type="button" className="btn" onClick={onJoin}><Ic name="link" />Join with link</button>
        <button type="button" className="btn" onClick={() => go("/gallery")}><Ic name="explore" />Browse public projects</button>
      </div>
      <ol className="hp-steps">
        <li><b>Put a project online.</b> Upload it here after signing in, or use File → Publish Project Online in the <a href={RELEASES} target="_blank" rel="noreferrer">desktop app</a>.</li>
        <li><b>Share it.</b> Invite people by GitHub username or email, or send a link.</li>
        <li><b>Work together.</b> Everyone edits the same schematic and board, from Junction or the browser.</li>
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- shell
export function Home() {
  const me = useApp((s) => s.me);
  const view = useApp((s) => s.view);
  const homeTab = useApp((s) => s.homeTab);
  const tab: Tab = homeTab === "explore" ? "explore" : homeTab === "trash" ? "trash" : homeTab === "time" ? "time" : "projects";
  const tick = useApp((s) => s.homeTick) || 0;
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [upload, setUpload] = useState<null | { files?: API.UploadFile[] }>(null);
  const [join, setJoin] = useState(false);
  const [account, setAccount] = useState<MenuAt | null>(null);
  const [drag, setDrag] = useState(false);
  const [bump, setBump] = useState(0);
  const dragDepth = useRef(0);

  // The editor's File → Share… opens the same dialog.
  useEffect(() => {
    window.CollabHome = { openShare: (projectId, name) => setShare({ projectId, name }), refresh: () => setBump((n) => n + 1),
      newProject: () => acts.current.newProject(), join: () => setJoin(true), signOut: () => acts.current.signOut() };
    return () => { delete window.CollabHome; };
  }, []);
  const acts = useRef({ newProject: () => {}, signOut: () => {} });

  // Going somewhere else (Back out of the editor, another project) leaves no dialog of the old place behind.
  const where = useApp((s) => (s.view || "") + ":" + (s.project?.projectId || "") + ":" + (s.homeTab || ""));
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setShare(null); setJoin(false); setAccount(null); setUpload((u) => (u && uploading.current ? u : null)); }, [where]);
  const uploading = useRef(false);

  const startUpload = (files?: API.UploadFile[]) => { if (!me) { location.href = API.loginUrl("/"); return; } setUpload({ files }); };
  // The guided first project: made from the blinker (or from the board the visitor was routing on
  // the home page) and opened with its guide beside it.
  const guiding = useRef(false);
  const startGuided = async (from: "home" | "mini") => {
    if (guiding.current) return;
    if (!me) { location.href = API.loginUrl("/?start=" + (from === "mini" ? "mini" : "guided")); return; }
    guiding.current = true;
    try { const r = await startGuidedProject(from); cache.mine = null; freshId = r.projectId; go(editUrl(r.projectId)); }
    catch (e) { toast(`Couldn't start the first project: ${e instanceof Error ? e.message : String(e)}`, { kind: "err" }); }
    finally { guiding.current = false; }
  };
  // Links that start something: /?start=mini (the home page's small editor), /?start=guided,
  // Read once, then taken out of the address so Back does not start it again.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || view !== "home" || !me) return;   // signed out, / is the public home page, which sends these through sign-in
    const q = new URLSearchParams(location.search), start = q.get("start");
    if (!start) return;
    linked.current = true;
    q.delete("start");
    history.replaceState(history.state, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    if (start === "mini" || start === "guided") startGuided(start === "mini" && miniBoard() ? "mini" : "home");
  }, [view, me]);   // eslint-disable-line
  const signOut = async () => { try { await API.api("/auth/logout", { method: "POST" }); } catch { /* the reload decides */ } cache.mine = null; location.href = "/"; };
  acts.current = { newProject: () => startUpload(), signOut };
  const home = view === "home";

  // Files dragged over the window.  The listeners sit on the window, not on the page: a dialog's
  // backdrop is outside the page, and a file dropped there would otherwise make the browser open it
  // and leave.  Dropped on the bare page they start an upload; over a dialog they are simply refused
  // (the upload dialog takes its own).
  const dropRef = useRef({ home, startUpload, uploading: !!upload });
  dropRef.current = { home, startUpload, uploading: !!upload };
  useEffect(() => {
    const hasFiles = (ev: DragEvent) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
    const ours = (ev: DragEvent) => hasFiles(ev) && !dropRef.current.uploading && (dropRef.current.home || !!(ev.target as Element | null)?.closest?.(".hp-scrim, .hp-menu-scrim"));
    const free = () => dropRef.current.home && !layerOpen();
    const enter = (ev: DragEvent) => { if (!ours(ev) || !free()) return; dragDepth.current++; setDrag(true); };
    const over = (ev: DragEvent) => { if (!ours(ev)) return; ev.preventDefault(); if (!free() && ev.dataTransfer) ev.dataTransfer.dropEffect = "none"; };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false); };
    const drop = async (ev: DragEvent) => {
      if (!ours(ev)) return;
      ev.preventDefault(); dragDepth.current = 0; setDrag(false);
      if (!free() || !ev.dataTransfer) return;
      const f = await filesFromDrop(ev.dataTransfer); if (f.length) dropRef.current.startUpload(f);
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, []);

  // The session ended behind the page's back: show the signed-out home, with the way back in.
  const meRef = useRef(me); meRef.current = me;
  useEffect(() => {
    const out = () => {
      if (!meRef.current) return;
      cache.mine = null;
      window.CollabNav?.reloadMe();
      toast("You were signed out.", { kind: "err", ms: 9000, action: { label: "Sign in", run: () => { location.href = API.loginUrl(); } } });
    };
    window.addEventListener(API.SIGNED_OUT, out);
    return () => window.removeEventListener(API.SIGNED_OUT, out);
  }, []);

  const nav = (
    <>
      <a aria-label="Projects" className={tab === "projects" ? "on" : undefined} href="/" aria-current={tab === "projects" ? "page" : undefined} onClick={(ev) => { ev.preventDefault(); go("/"); }}><Ic name="projects" size={18} /><span>Projects</span></a>
      <a aria-label="Explore" className={tab === "explore" ? "on" : undefined} href="/gallery" aria-current={tab === "explore" ? "page" : undefined} onClick={(ev) => { ev.preventDefault(); go("/gallery"); }}><Ic name="explore" size={18} /><span>Explore</span></a>
    </>
  );
  const accountBtn = me ? (
    <button type="button" className="hp-account" aria-haspopup="menu" aria-label={`Account: ${me.login}`}
      onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setAccount({ x: r.left, y: r.bottom + 4, right: r.right, top: r.top }); }}>
      <Avatar login={me.login} url={me.avatarUrl} size={24} /><span>{me.login}</span><Ic name="chevron" size={14} /></button>
  ) : <a className="btn primary hp-signin" href={API.loginUrl(location.pathname.startsWith("/trash") ? location.pathname : "/")}>Sign in</a>;

  return (
    <>
      {home ? (
        <div className="hp">
          <aside className="hp-side" aria-label="Projects navigation">
            <nav className="hp-nav" aria-label="Views">{nav}</nav>
            <div className="hp-side-acts">
              <button type="button" aria-label="New project" className="hp-side-btn" onClick={() => startUpload()}><Ic name="plus" size={18} /><span>New project</span></button>
              <button type="button" aria-label="Join with link" className="hp-side-btn" onClick={() => setJoin(true)}><Ic name="link" size={18} /><span>Join with link</span></button>
              {me ? <a aria-label="Trash" aria-current={tab === "trash" ? "page" : undefined} className={"hp-side-btn" + (tab === "trash" ? " on" : "")} href="/trash" onClick={(ev) => { ev.preventDefault(); go("/trash"); }}><Ic name="trash" size={18} /><span>Trash</span></a> : null}
              {me ? <a aria-label="Import from GitHub" className="hp-side-btn" href="/github"><Ic name="branch" size={18} /><span>Import from GitHub</span></a> : null}
              {me ? <button type="button" id="homeParts" aria-label="Part libraries" className="hp-side-btn" onClick={() => (window as unknown as { KiCadParts?: { open(o: { tab: string }): void } }).KiCadParts?.open({ tab: "libraries" })}><Ic name="grid" size={18} /><span>Part libraries</span></button> : null}
              {me ? <button type="button" id="homePlugins" aria-label="Plugins" className="hp-side-btn" onClick={() => (window as unknown as { KcPlugins?: { openManager(): void } }).KcPlugins?.openManager()}><Ic name="plugin" size={18} /><span>Plugins</span></button> : null}
              {me ? <a aria-label="Time spent" aria-current={tab === "time" ? "page" : undefined} className={"hp-side-btn" + (tab === "time" ? " on" : "")} id="homeTime" href="/time" onClick={(ev) => { ev.preventDefault(); go("/time"); }}><Ic name="clock" size={18} /><span>Time spent</span></a> : null}
              {me ? <a aria-label="Connect AI" className="hp-side-btn" id="homeConnect" href="/connect"><Ic name="link" size={18} /><span>Connect AI</span></a> : null}
            </div>
            <div className="hp-side-foot">
              <a aria-label="Get the desktop app" className="hp-side-btn" href={RELEASES} target="_blank" rel="noreferrer"><Ic name="desktop" size={18} /><span>Get the desktop app</span></a>
              {accountBtn}
              {me ? <button type="button" aria-label="Log out" className="hp-side-btn hp-logout" onClick={() => signOut()}><Ic name="signout" size={18} /><span>Log out</span></button> : null}
            </div>
          </aside>
          <main className="hp-main" id="homeMain">
            <div className="hp-topbar"><span className="hp-brand">Junction</span>{accountBtn}</div>
            <div className="hp-page">
              {tab === "explore" ? <Explore me={me} tick={tick + bump} />
                : tab === "trash" && me ? <Trash tick={tick + bump} />
                : tab === "time" && me ? <TimePage tick={tick + bump} />
                : me ? <Projects me={me} tick={tick + bump} onUpload={() => startUpload()} onGuided={() => startGuided("home")} onJoin={() => setJoin(true)} onShare={setShare} />
                : <Welcome onJoin={() => setJoin(true)} />}
            </div>
          </main>
          <nav className="hp-tabbar" aria-label="Home">
            {nav}
            <button type="button" onClick={() => startUpload()}><Ic name="plus" size={18} /><span>New</span></button>
            <button type="button" onClick={() => setJoin(true)}><Ic name="link" size={18} /><span>Join</span></button>
          </nav>
          {drag ? <div className="hp-dropveil"><div><Ic name="upload" size={30} /><b>Drop to upload as a new project</b></div></div> : null}
        </div>
      ) : null}

      {share ? <ShareDialog target={share} onClose={() => setShare(null)} onChanged={() => setBump((n) => n + 1)} /> : null}
      {upload ? <UploadDialog initial={upload.files} onClose={() => setUpload(null)} onBusy={(b) => { uploading.current = b; }}
        onBlank={(r) => { setUpload(null); cache.mine = null; freshId = r.projectId; toast(`Created “${r.name}”`); go(newProjectUrl(r)); }}
        onDone={(r) => { setUpload(null); cache.mine = null; freshId = r.projectId; setBump((n) => n + 1); if (tab !== "projects") go("/");
          const left = r.skipped?.length || 0;
          toast(`“${r.name}” is online${left ? ` (${left} non-KiCad file${left === 1 ? "" : "s"} left out)` : ""}`, { action: { label: "Open", run: () => go(editUrl(r.projectId)) } }); }} /> : null}
      {join ? <JoinDialog me={me} onClose={() => setJoin(false)} /> : null}
      {account && me ? <Menu at={account} title={me.login} onClose={() => setAccount(null)} items={[
        { id: "trash", label: "Trash", icon: "trash", run: () => go("/trash") },
        { id: "time", label: "Time spent", icon: "clock", run: () => go("/time") },
        { id: "waka", label: "WakaTime settings", icon: "clock", run: () => { go("/time"); setTimeout(() => document.getElementById("wakatime")?.scrollIntoView({ block: "start" }), 300); } },
        { id: "sync", label: "GitHub sync", icon: "branch", run: () => { location.href = "/github"; } },
        { id: "mcp", label: "Connect an AI assistant (MCP)", icon: "link", run: () => { location.href = "/connect"; } },
        { id: "gh", label: "GitHub profile", icon: "open", run: () => { window.open(`https://github.com/${me.login}`, "_blank", "noopener"); } },
        { id: "app", label: "Get the desktop app", icon: "desktop", run: () => { window.open(RELEASES, "_blank", "noopener"); } },
        "-",
        { id: "out", label: "Log out", icon: "signout", run: () => { signOut(); } },
      ]} /> : null}
    </>
  );
}
