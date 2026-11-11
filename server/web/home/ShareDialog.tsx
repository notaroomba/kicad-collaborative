// ShareDialog.tsx — who can open a project and what they may do in it: invite by GitHub username
// or email as an editor, a commenter or a viewer, change roles, remove people, make share links
// (view and comment links open without an account), and the project's permission settings.  The
// owner manages; an editor may invite and make links when the owner allows it; everyone else in
// the project sees the list read-only.
import { useCallback, useEffect, useRef, useState } from "react";
import * as API from "./api";
import type { FoundUser, Invite, Member, Members, Permissions, Role, ShareLink } from "./api";
import { ago, Avatar, Confirm, copyText, Ic, Modal, toast, toastError } from "./ui";

export interface ShareTarget { projectId: string; name: string; isPublic?: boolean }

function RoleSelect({ value, onChange, disabled, label, onMakeOwner }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string; onMakeOwner?: () => void }) {
  return (
    <select className="hp-select" aria-label={label} value={value} disabled={disabled}
      onChange={(ev) => { if (ev.target.value === "owner") { ev.target.value = value; onMakeOwner?.(); } else onChange(ev.target.value as Role); }}>
      <option value="editor">Can edit</option>
      <option value="commenter">Can comment</option>
      <option value="viewer">Can view</option>
      {onMakeOwner ? <option value="owner">Make owner…</option> : null}
    </select>
  );
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isLogin = (s: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s);

/** The invite row: a text field with a typeahead over server accounts and GitHub users. */
function InviteRow({ projectId, taken, onInvited }: { projectId: string; taken: Set<string>; onInvited: () => void }) {
  const [text, setText] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [found, setFound] = useState<FoundUser[]>([]);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const q = text.trim().replace(/^@/, "");
  useEffect(() => {
    if (q.length < 2 || q.includes("@")) { setFound([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      // The first suggestion is preselected, so Enter invites the person shown, not the letters typed so far.
      API.searchUsers(q, ctl.signal).then((u) => { const f = u.filter((x) => !taken.has(x.login.toLowerCase())); setFound(f); setCur(f.length ? 0 : -1); }).catch(() => {});
    }, 180);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, taken]);

  const send = async (who?: string) => {
    const target = (who ?? q).trim();
    if (!target || busy) return;
    const email = isEmail(target);
    if (!email && !isLogin(target)) { setNote({ text: "Enter a GitHub username or an email address.", err: true }); return; }
    if (!email && taken.has(target.toLowerCase())) { setNote({ text: `${target} already has access.`, err: true }); return; }
    setBusy(true); setNote(null); setOpen(false);
    try {
      const r = await API.invite(projectId, email ? { email: target } : { login: target }, role);
      setText(""); setFound([]);
      setNote({ text: r.status === "granted" ? `${r.login || target} can now ${API.ROLE_VERB[r.role || role]} this project.`
        : `${target} will get access the first time they sign in.` });
      onInvited();
    } catch (e) { setNote({ text: e instanceof Error ? e.message : String(e), err: true }); }
    setBusy(false); input.current?.focus();
  };

  const show = open && found.length > 0;
  return (
    <div className="hp-invite">
      <div className="hp-invite-row">
        <div className="hp-combo" data-popup-open={show ? "" : undefined}>
          <input ref={input} className="hp-input" data-autofocus placeholder="GitHub username or email" value={text} autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded={show} aria-controls="hp-invite-list" aria-label="Invite by GitHub username or email"
            onChange={(ev) => { setText(ev.target.value); setOpen(true); setNote(null); }}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(ev) => {
              if (ev.key === "ArrowDown" && show) { ev.preventDefault(); setCur((c) => (c + 1) % found.length); }
              else if (ev.key === "ArrowUp" && show) { ev.preventDefault(); setCur((c) => (c <= 0 ? found.length - 1 : c - 1)); }
              else if (ev.key === "Enter") { ev.preventDefault(); const exact = found.find((u) => u.login.toLowerCase() === q.toLowerCase()); send(exact ? exact.login : show && cur >= 0 ? found[cur].login : undefined); }
              else if (ev.key === "Escape" && show) { ev.stopPropagation(); setOpen(false); }
            }} />
          {show ? (
            <ul className="hp-suggest" id="hp-invite-list" role="listbox">
              {found.map((u, i) => (
                <li key={u.login} role="option" aria-selected={i === cur} className={i === cur ? "cur" : undefined}
                  onMouseDown={(ev) => { ev.preventDefault(); send(u.login); }} onMouseEnter={() => setCur(i)}>
                  <Avatar login={u.login} url={u.avatarUrl} size={20} />
                  <span className="hp-suggest-login">{u.login}</span>
                  {u.name ? <span className="hp-dim">{u.name}</span> : null}
                  <span className="hp-suggest-src">{u.source === "server" ? "has an account" : "GitHub"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <RoleSelect value={role} onChange={setRole} label="Role for the invite" />
        <button type="button" className="btn primary" onClick={() => send()} disabled={busy || !q}>{busy ? "Inviting…" : "Invite"}</button>
      </div>
      {note ? <p className={"hp-note" + (note.err ? " err" : "")} role={note.err ? "alert" : "status"}>{note.text}</p> : null}
    </div>
  );
}

export function ShareDialog({ target, onClose, onChanged }: { target: ShareTarget; onClose: () => void; onChanged?: () => void }) {
  const id = target.projectId;
  const [data, setData] = useState<Members | null>(null);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | undefined>(target.isPublic);
  const [linkRole, setLinkRole] = useState<Role>("editor");
  const [linkDays, setLinkDays] = useState(0);
  const [linkLabel, setLinkLabel] = useState("");
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; action: string; run: () => Promise<void> }>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // An answer that was asked for before a local edit is from before it: `seq` moves with every
  // load and every edit, and only the newest answer is shown.
  const seq = useRef(0);
  const editing = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const stale = () => !alive.current || mine !== seq.current || editing.current > 0;
    try {
      const m = await API.listMembers(id);
      if (stale()) return;
      setData(m); setError(null);
      if (m.permissions) { setPerms(m.permissions); setIsPublic(m.permissions.public); }
      if (m.canShare && !m.canManage) { const l = await API.listLinks(id); if (!stale()) setLinks(l); }
      if (m.canManage) {
        const [l, info] = await Promise.all([API.listLinks(id), API.api<{ public?: boolean }>(`/api/projects/${id}/info`).catch(() => null)]);
        if (stale()) return;
        setLinks(l); if (info && typeof info.public === "boolean") setIsPublic(info.public);
      }
    } catch (e) { if (!stale()) setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  /** An optimistic edit: the row changes at once, the server's view is fetched again once the last edit under way has landed. */
  const edit = async (apply: (d: Members) => Members, request: () => Promise<unknown>, done?: () => void) => {
    seq.current++; editing.current++;
    setData((d) => d && apply(d));
    try { await request(); done?.(); } catch (e) { toastError(e); }
    seq.current++;
    if (!--editing.current && alive.current) load();
  };
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onChanged?.(); };
  const can = !!data?.canManage;
  /** May invite and make links: the owner, or an editor when the owner allows it. */
  const canShare = can || !!data?.canShare;
  const taken = new Set<string>([...(data?.members || []).map((m) => m.login.toLowerCase()), ...(data?.owner ? [data.owner.login.toLowerCase()] : []),
    ...(data?.pending || []).map((p) => (p.login || "").toLowerCase()).filter(Boolean)]);

  // Optimistic edits: the row changes at once and snaps back if the server refuses.
  const memberRole = (m: Member, role: Role) => edit((d) => ({ ...d, members: d.members.map((x) => (x.userId === m.userId ? { ...x, role } : x)) }),
    () => API.setMemberRole(id, m.userId, role), () => onChanged?.());
  const inviteRole = (p: Invite, role: Role) => edit((d) => ({ ...d, pending: d.pending.map((x) => (x.inviteId === p.inviteId ? { ...x, role } : x)) }),
    () => API.setInviteRole(id, p.inviteId, role));
  const removeMember = (m: Member) => setConfirm({
    title: "Remove access", action: "Remove", body: `${m.login} will no longer be able to open “${target.name}”. Their local copies are not touched.`,
    run: async () => { await API.removeMember(id, m.userId); toast(`Removed ${m.login}`); changed(); },
  });
  const makeOwner = (m: Member) => setConfirm({
    title: "Transfer ownership", action: "Make owner",
    body: `${m.login} becomes the owner of “${target.name}” and can rename, share and delete it. You stay on as an editor and can no longer manage who has access.`,
    run: async () => { await API.transferProject(id, m.userId); toast(`${m.login} now owns “${target.name}”`); changed(); },
  });
  const revokeInvite = (p: Invite) => edit((d) => ({ ...d, pending: d.pending.filter((x) => x.inviteId !== p.inviteId) }),
    () => API.revokeInvite(id, p.inviteId), () => toast("Invite cancelled"));
  const newLink = async () => {
    setLinkBusy(true);
    try { const l = await API.createLink(id, linkRole, linkDays || undefined, linkLabel.trim() || undefined); await copyText(l.url, "Link created and copied"); setLinkLabel(""); setLinks(await API.listLinks(id)); }
    catch (e) { toastError(e); }
    setLinkBusy(false);
  };
  const revokeLink = (l: ShareLink) => setConfirm({
    title: "Turn off link", action: "Turn off", body: "The link stops working at once, also for people looking at the project through it right now. People who joined with it keep their access until the owner removes them.",
    run: async () => { await API.revokeLink(l.token); setLinks((x) => x.filter((y) => y.token !== l.token)); toast("Link turned off"); },
  });
  const togglePublic = async (next: boolean) => {
    setIsPublic(next);
    try { await API.patchProject(id, { public: next }); setPerms((p) => p && { ...p, public: next }); toast(next ? "Listed in Explore" : "Now private"); onChanged?.(); }
    catch (e) { setIsPublic(!next); toastError(e); }
  };
  /** One permission setting: shown changed at once, put back if the server refuses. */
  const setPerm = async (patch: Partial<Omit<Permissions, "public">>, done: string) => {
    const before = perms;
    setPerms((p) => p && { ...p, ...patch });
    try { setPerms(await API.setPermissions(id, patch)); toast(done); }
    catch (e) { setPerms(before); toastError(e); }
  };

  return (
    <Modal title={<>Share <span className="hp-dim">“{target.name}”</span></>} onClose={onClose} width={540}
      footer={<><span className="hp-foot-note">{can ? "Changes apply right away, also for people who have the project open." : ""}</span><button type="button" className="btn" onClick={onClose}>Done</button></>}>
      {error ? <div className="hp-error" role="alert"><span>{error}</span><button type="button" className="btn sm" onClick={load}>Try again</button></div> : null}
      {!data && !error ? <div className="hp-skel-rows" aria-busy="true"><i /><i /><i /></div> : null}
      {data ? (
        <>
          {canShare ? <InviteRow projectId={id} taken={taken} onInvited={changed} /> : null}
          {!can ? <p className="hp-note hp-yourrole" id="hp-yourrole">{data.myRole ? <span className={"pill " + data.myRole}>{data.myRole}</span> : null}
            <span>{canShare ? "You can invite people and make links. Only the owner changes roles or removes people."
              : `You can ${data.myRole ? API.ROLE_VERB[data.myRole] : "view"} this project. Only the owner can invite people or change roles.`}</span></p> : null}

          <h3 className="hp-h3">People with access</h3>
          <ul className="hp-people">
            {data.owner ? (
              <li><Avatar login={data.owner.login} url={data.owner.avatarUrl} size={28} />
                <span className="hp-person"><b>{data.owner.login}</b></span><span className="pill owner">owner</span></li>
            ) : null}
            {data.members.map((m) => (
              <li key={m.userId}>
                <Avatar login={m.login} url={m.avatarUrl} size={28} />
                <span className="hp-person"><b>{m.login}</b></span>
                {can ? <><RoleSelect value={m.role} onChange={(r) => memberRole(m, r)} label={`Role of ${m.login}`} onMakeOwner={() => makeOwner(m)} />
                  <button type="button" className="hp-iconbtn" title={`Remove ${m.login}`} aria-label={`Remove ${m.login}`} onClick={() => removeMember(m)}><Ic name="close" /></button></>
                  : <span className={"pill " + m.role}>{m.role}</span>}
              </li>
            ))}
            {data.pending.map((p) => (
              <li key={"p" + p.inviteId} className="pending">
                <Avatar login={p.login || p.email || "?"} size={28} />
                <span className="hp-person"><b>{p.login || p.email}</b><small>Invited · gets access at first sign-in</small></span>
                <RoleSelect value={p.role} onChange={(r) => inviteRole(p, r)} label={`Role of ${p.login || p.email}`} />
                <button type="button" className="hp-iconbtn" title="Cancel invite" aria-label={`Cancel invite for ${p.login || p.email}`} onClick={() => revokeInvite(p)}><Ic name="close" /></button>
              </li>
            ))}
            {!data.members.length && !data.pending.length ? <li className="hp-people-empty">Nobody else yet.{canShare ? " Invite someone above, or send them a link." : ""}</li> : null}
          </ul>

          {canShare ? (
            <>
              <h3 className="hp-h3">Share links</h3>
              <p className="hp-note" id="hp-link-note">{linkRole === "editor" ? "Anyone with this link can edit after signing in."
                : perms?.linksRequireSignin ? `Anyone with this link can ${linkRole === "commenter" ? "view and comment" : "view"} after signing in.`
                : linkRole === "commenter" ? "Anyone with this link can view without an account, and comment after signing in. They cannot change the design."
                : "Anyone with this link can view without an account. They cannot comment or change the design."} Links also open in KiCad Collaborative (File → Join Session from URL…).</p>
              <div className="hp-linknew">
                <RoleSelect value={linkRole} onChange={setLinkRole} label="Role the link grants" />
                <select className="hp-select" aria-label="Link expiry" value={linkDays} onChange={(ev) => setLinkDays(Number(ev.target.value))}>
                  <option value={0}>Never expires</option><option value={1}>Expires in 1 day</option><option value={7}>Expires in 7 days</option><option value={30}>Expires in 30 days</option>
                </select>
                <input className="hp-input" aria-label="Name for the link (optional)" placeholder="Name (optional)" maxLength={80} value={linkLabel}
                  onChange={(ev) => setLinkLabel(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); newLink(); } }} />
                <button type="button" className="btn" onClick={newLink} disabled={linkBusy}><Ic name="link" />{linkBusy ? "Creating…" : "Create and copy link"}</button>
              </div>
              {links.length ? (
                <ul className="hp-links">
                  {links.map((l) => (
                    <li key={l.token} data-role={l.role}>
                      <input className="hp-input mono" readOnly value={l.url} aria-label={l.label ? `Share link “${l.label}”` : "Share link"} onFocus={(ev) => ev.currentTarget.select()} />
                      <span className="hp-link-meta">{l.label ? <span className="hp-link-name" title={l.label}>{l.label}</span> : null}<span className={"pill " + l.role}>{l.role}</span>
                        <span className="hp-dim" title={l.createdBy ? `Made by ${l.createdBy} ${ago(l.createdAt)}` : undefined}>{l.expiresAt ? `expires ${new Date(l.expiresAt).toLocaleDateString()}` : `made ${ago(l.createdAt)}`}
                          {l.uses ? ` · ${l.uses} joined` : ""}</span></span>
                      <button type="button" className="hp-iconbtn" title="Copy link" aria-label="Copy link" onClick={() => copyText(l.url, "Link copied")}><Ic name="copy" /></button>
                      {l.canRevoke !== false ? <button type="button" className="hp-iconbtn" title="Turn off link" aria-label="Turn off link" onClick={() => revokeLink(l)}><Ic name="trash" /></button> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          {can ? (
            <>
              <h3 className="hp-h3">Permissions</h3>
              <div className="hp-perms" id="hp-perms">
                <label className="hp-access">
                  <Ic name={isPublic ? "globe" : "lock"} size={18} />
                  <span className="hp-person"><b>{isPublic ? "Public" : "Private"}</b>
                    <small>{isPublic ? "Listed in Explore. Anyone can view it." : "Only the people above, and people with a link, can open it."}</small></span>
                  <select className="hp-select" aria-label="General access" value={isPublic ? "public" : "private"} onChange={(ev) => togglePublic(ev.target.value === "public")}>
                    <option value="private">Private</option><option value="public">Public</option>
                  </select>
                </label>
                {perms ? (
                  <>
                    {isPublic ? (
                      <label className="hp-access sub">
                        <span className="hp-person"><b>Signed-in visitors</b><small>What someone who finds the project in Explore may do.</small></span>
                        <select className="hp-select" aria-label="What signed-in visitors can do" value={perms.publicRole}
                          onChange={(ev) => setPerm({ publicRole: ev.target.value as "viewer" | "commenter" }, ev.target.value === "commenter" ? "Visitors can now comment" : "Visitors can now only view")}>
                          <option value="viewer">Can view</option><option value="commenter">Can comment</option>
                        </select>
                      </label>
                    ) : null}
                    <label className="hp-access">
                      <input type="checkbox" checked={perms.editorsCanShare} onChange={(ev) => setPerm({ editorsCanShare: ev.target.checked }, ev.target.checked ? "Editors can now share" : "Only you can share now")} />
                      <span className="hp-person"><b>Editors can share</b><small>Editors may invite people and make links. Only you change roles or remove people.</small></span>
                    </label>
                    <label className="hp-access">
                      <input type="checkbox" checked={perms.viewersCanCopy} onChange={(ev) => setPerm({ viewersCanCopy: ev.target.checked }, ev.target.checked ? "Viewers can download and copy" : "Viewers can no longer download or copy")} />
                      <span className="hp-person"><b>Viewers and commenters can download and copy</b><small>Off: Download .zip and Clone are refused for them. They can still open and read the design.</small></span>
                    </label>
                    <label className="hp-access">
                      <input type="checkbox" checked={perms.linksRequireSignin} onChange={(ev) => setPerm({ linksRequireSignin: ev.target.checked }, ev.target.checked ? "Links now need a sign-in" : "View links open without an account")} />
                      <span className="hp-person"><b>Links need a sign-in</b><small>Off: view and comment links show the design to anyone who has them, without an account.</small></span>
                    </label>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {confirm ? <Confirm title={confirm.title} body={confirm.body} action={confirm.action} danger onConfirm={confirm.run} onClose={() => setConfirm(null)} /> : null}
    </Modal>
  );
}
