// github/index.ts — the GitHub page (served by src/github.rs, built to static/dist/github.js).
//
//   /github          connect an account, bring a repository folder online as a project
//   /p/<id>/github   one project's link to a repository: what differs, push, pull, merge
//
// Plain DOM on purpose: the page is small, has no canvas, and must not depend on the
// editor bundles (it is reachable from the desktop app's browser hand-off too).

// ---------------------------------------------------------------- what the server sends (src/github.rs)
interface Connection { configured: boolean; connected: boolean; login: string; privateRepos?: boolean }
interface Repo { fullName: string; private: boolean; pushedAt?: string; defaultBranch?: string }
interface ScanProject { path: string; name: string; files: number }
interface Scan { repo: string; branch: string; branches: string[]; projects: ScanProject[]; truncated: boolean }
interface LastAuto { ok: boolean; message?: string; at: string; by?: string; checkpoint?: string; commitUrl?: string | null }
interface Link {
  repo: string; branch: string; path: string; url: string; linkedBy?: string | null; syncedAt?: string | null;
  autoPush: boolean; lastAuto?: LastAuto | null;
}
type FileState = "push" | "pull" | "conflict" | "synced";
interface FileEntry { path: string; state: FileState; detail: string; size: number; unsavedOps: number; mergeable: boolean }
interface Commit { sha: string; message: string; author?: string; date: string; url?: string }
interface Remote { reachable: boolean; reason?: string; branchExists: boolean; truncated: boolean; canPush: boolean; commits?: Commit[] }
interface Summary { push: number; pull: number; conflict: number; synced: number; unsaved: number }
interface ProjectInfo { projectId: string; name: string; isOwner: boolean; role: string }
interface Status { project: ProjectInfo; github: Connection; link: Link | null; remote: Remote; summary: Summary; files: FileEntry[] }
interface Change { kind: "added" | "removed" | "changed"; item: string; parts?: string[] }
interface Side { opaque?: boolean; oldSize: number; newSize: number; total: number; changes: Change[] }
interface Diff { hasBase: boolean; online?: Side; github?: Side; between?: Side }
interface PushResult { pushed: string[]; commit: string; commitUrl?: string | null; branch: string; pullRequest?: { number: number; url: string } }
interface PullConflict { item: string; kept: "github" | "online" }
interface PullUpdate { path: string; action: string; fromGithub: number; fromOnline: number; conflicts: PullConflict[] }
interface PullResult { updated: PullUpdate[]; skipped: { path: string; reason: string }[]; checkpoint?: string | null }
interface ListedProject { projectId: string; name: string; ownerLogin: string; updatedAt: string }
type Resolution = "merge" | "github" | "online" | "";

/** A failed request: the server's message, its status and its machine code. */
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => (e instanceof ApiError ? e.status : undefined);

const app = document.getElementById("app") as HTMLElement;
const projectId: string | null = (location.pathname.match(/^\/p\/([0-9a-f-]{36})\/github\/?$/i) || [])[1] || null;
const here = location.pathname;

// ---------------------------------------------------------------- helpers
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
/** The element matching `sel`. Typed loosely on purpose: the page writes its own markup, so a selector's element kind is known where it is used. */
function $<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T | null {
  return (root || document).querySelector<T>(sel);
}
/** As `$`, for an element the page has just rendered. */
function need<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T {
  const el = $<T>(sel, root);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}
function $$<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T[] {
  return Array.from((root || document).querySelectorAll<T>(sel));
}

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { credentials: "same-origin", method: opts.method };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers = { "Content-Type": "application/json" }; }
  const r = await fetch(path, init);
  let j: (T & { message?: string; error?: string }) | null = null;
  try { j = await r.json(); } catch (_) { /* not json */ }
  if (!r.ok) throw new ApiError((j && j.message) || `Request failed (${r.status})`, r.status, (j && j.error) || undefined);
  return j as T;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return new Date(iso).toLocaleDateString();
}
const kb = (n: number): string => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " kB" : n + " B");
const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : many || one + "s"}`;
const connectUrl = (access: string): string => `/auth/github/connect?next=${encodeURIComponent(here)}${access ? "&access=" + access : ""}`;

/** Run an async action behind a button: spinner while it runs, the error shown where the page says. */
async function busy(btn: HTMLButtonElement, fn: () => Promise<unknown>): Promise<void> {
  const label = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${label}`;
  try { await fn(); }
  catch (e) { showError(e); }
  finally { btn.disabled = false; btn.innerHTML = label; }
}

let flash: { kind: string; html: string } | null = null; // shown once at the top of the next render
function showError(e: unknown): void {
  flash = { kind: "err", html: esc(message(e)) };
  const slot = $("#flash");
  if (slot) slot.innerHTML = flashHtml();
  else render();
}
function flashHtml(): string {
  if (!flash) return "";
  const f = flash; flash = null;
  return `<div class="callout ${f.kind}" role="status">${f.html}</div>`;
}

// ---------------------------------------------------------------- shared pieces
function connectBox(gh: Connection): string {
  if (!gh.configured) {
    return `<section class="box"><h2>GitHub account</h2><div class="in">
      <p>GitHub sign-in is not configured on this server, so repositories can't be connected.</p></div></section>`;
  }
  if (gh.connected) {
    return `<section class="box"><h2>GitHub account</h2><div class="in"><div class="row">
      <div class="grow"><b>${esc(gh.login)}</b> is connected
        <span class="pill">${gh.privateRepos === false ? "public repositories" : "repositories"}</span>
        ${gh.privateRepos === false ? `<div class="muted">Private repositories are not included. <a href="${connectUrl("")}">Add them</a>.</div>` : ""}</div>
      <button class="btn small" id="ghDisconnect">Disconnect</button></div></div></section>`;
  }
  return `<section class="box"><h2>GitHub account</h2><div class="in">
    <p>Signing in only tells this site who you are. To read and write your repositories it needs your permission separately — you can take it back at any time.</p>
    <div class="row actions">
      <a class="btn primary" id="ghConnect" href="${connectUrl("")}">Connect repositories</a>
      <a class="btn" id="ghConnectPublic" href="${connectUrl("public")}">Public repositories only</a>
    </div></div></section>`;
}
function bindConnectBox(after: () => Promise<unknown>): void {
  const d = $<HTMLButtonElement>("#ghDisconnect");
  if (d) d.onclick = () => busy(d, async () => { await api("/api/github", { method: "DELETE" }); await after(); });
}

/** A searchable repository list; calls onPick(fullName, repo). */
function repoPicker(el: HTMLElement, onPick: (fullName: string, repo: Repo | null) => void): void {
  el.innerHTML = `<label class="f">Repository
      <input type="text" id="repoQ" placeholder="Search your repositories, or type owner/name" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="list" id="repoList" style="margin-top:8px"><div class="empty">Loading your repositories…</div></div>`;
  const q = need<HTMLInputElement>("#repoQ", el), list = need("#repoList", el);
  let all: Repo[] = [], picked: string | null = null;
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    const hits = all.filter((r) => !needle || r.fullName.toLowerCase().includes(needle)).slice(0, 60);
    let html = hits.map((r) => `<button type="button" class="it${r.fullName === picked ? " sel" : ""}" data-repo="${esc(r.fullName)}">
        <span class="nm">${esc(r.fullName)}</span>${r.private ? '<span class="pill">private</span>' : ""}
        <span class="sp"></span><span class="muted">${esc(ago(r.pushedAt))}</span></button>`).join("");
    // A repository that is not in the list (not a member, or beyond the first few hundred) can still be named outright.
    if (/^[\w.-]+\/[\w.-]+$/.test(q.value.trim()) && !hits.some((r) => r.fullName.toLowerCase() === needle)) {
      html += `<button type="button" class="it" data-repo="${esc(q.value.trim())}"><span class="nm">Use ${esc(q.value.trim())}</span></button>`;
    }
    list.innerHTML = html || `<div class="empty">No repository matches.</div>`;
    $$(".it", list).forEach((b) => (b.onclick = () => {
      const name = b.dataset.repo || "";
      picked = name; draw();
      onPick(name, all.find((r) => r.fullName === name) || null);
    }));
  };
  q.oninput = draw;
  api<{ repos: Repo[] }>("/api/github/repos").then((j) => { all = j.repos; draw(); })
    .catch((e) => { list.innerHTML = `<div class="empty">${esc(message(e))}</div>`; });
}

// ================================================================ /github
async function renderImport(): Promise<void> {
  document.title = "GitHub — KiCad Collaborative";
  let gh: Connection;
  try { gh = await api<Connection>("/api/github"); }
  catch (e) { return renderSignedOut(e); }
  need("#who").textContent = gh.login;

  app.innerHTML = `<div><h1>GitHub</h1>
      <p class="muted">Keep an online project and a repository folder in step: push what changed online, pull what changed on GitHub, and merge item by item when both did.</p></div>
    <div id="flash">${flashHtml()}</div>
    ${connectBox(gh)}
    ${gh.connected ? `<section class="box"><h2>Bring a repository online</h2><div class="in">
        <div id="picker"></div><div id="scan" style="margin-top:12px"></div></div></section>` : ""}
    <section class="box"><h2>Your online projects</h2><div id="mine"><div class="in muted">Loading…</div></div></section>`;
  bindConnectBox(renderImport);

  if (gh.connected) {
    repoPicker(need("#picker"), (full) => scan(full, null));
  }

  api<{ projects: ListedProject[] }>("/api/projects").then((j) => {
    need("#mine").innerHTML = j.projects.length
      ? j.projects.map((p) => `<a class="commit" href="/p/${p.projectId}/github" style="color:inherit">
          <span class="msg"><b>${esc(p.name)}</b> <span class="muted">· ${esc(p.ownerLogin)}</span></span>
          <span class="muted">${esc(ago(p.updatedAt))}</span><span class="pill">GitHub sync ›</span></a>`).join("")
      : `<div class="in muted">No projects yet. Bring one in from a repository above, or start a session from the desktop app.</div>`;
  }).catch((e) => { need("#mine").innerHTML = `<div class="in muted">${esc(message(e))}</div>`; });
}

async function scan(full: string, branch: string | null): Promise<void> {
  const el = need("#scan");
  el.innerHTML = `<div class="muted"><span class="spinner"></span> Looking for KiCad projects in ${esc(full)}…</div>`;
  let s: Scan;
  try { s = await api<Scan>(`/api/github/scan?repo=${encodeURIComponent(full)}${branch ? "&branch=" + encodeURIComponent(branch) : ""}`); }
  catch (e) { el.innerHTML = `<div class="callout err">${esc(message(e))}</div>`; return; }
  const branches = s.branches.includes(s.branch) ? s.branches : [s.branch].concat(s.branches);
  el.innerHTML = `<div class="row" style="margin-bottom:8px">
      <label class="f">Branch <select id="scanBranch">${branches.map((b) => `<option${b === s.branch ? " selected" : ""}>${esc(b)}</option>`).join("")}</select></label>
      <div class="grow muted">${s.projects.length ? `${plural(s.projects.length, "KiCad project")} in <b>${esc(s.repo)}</b>` : ""}</div></div>
    ${s.truncated ? `<div class="callout warn">This repository is too large for GitHub to list completely; some folders may be missing.</div>` : ""}
    <div class="list">${s.projects.length ? s.projects.map((p, i) => `<div class="it" style="cursor:default">
        <span class="nm">${esc(p.name)}</span><span class="muted mono">${esc(p.path || "/")}</span><span class="sp"></span>
        <span class="muted">${plural(p.files, "file")}</span>
        <button class="btn small primary" data-import="${i}">Bring online</button></div>`).join("")
      : `<div class="empty">No KiCad files on this branch.</div>`}</div>`;
  const pick = need<HTMLSelectElement>("#scanBranch");
  pick.onchange = () => scan(full, pick.value);
  $$<HTMLButtonElement>("[data-import]", el).forEach((b) => (b.onclick = () => busy(b, async () => {
    const p = s.projects[Number(b.dataset.import)];
    const j = await api<{ projectId: string }>("/api/github/import", { method: "POST", body: { repo: s.repo, branch: s.branch, path: p.path, name: p.name } });
    location.href = `/p/${j.projectId}/github`;
  })));
}

function renderSignedOut(e: unknown): void {
  if (e && statusOf(e) !== 401) { app.innerHTML = `<div class="callout err">${esc(message(e))}</div>`; return; }
  app.innerHTML = `<section class="box"><h2>GitHub</h2><div class="in">
    <p>Sign in to connect repositories to your online projects.</p>
    <a class="btn primary" href="/auth/github/login?next=${encodeURIComponent(here)}">Sign in with GitHub</a></div></section>`;
}

// ================================================================ /p/<id>/github
let st: Status | null = null;                        // last status
const resolve: Record<string, Resolution> = {};      // how to settle each file changed on both sides
let lastResult: string | null = null;                // html of the last push/pull outcome

// ---------------------------------------------------------------- what changed inside a file
const openDiffs = new Set<string>();                 // paths whose change list is expanded
const diffs: Record<string, Diff | { error: string } | undefined> = {};   // undefined while loading

async function loadDiff(path: string): Promise<void> {
  diffs[path] = undefined;
  try { diffs[path] = await api<Diff>(`/api/projects/${projectId}/github/diff?path=${encodeURIComponent(path)}`); }
  catch (e) { diffs[path] = { error: message(e) }; }
  const cell = $$("[data-diffbody]").find((c) => c.dataset.diffbody === path);
  if (cell) cell.innerHTML = diffHtml(path);
}

function changeList(title: string, side: Side | undefined): string {
  if (!side) return "";
  let body: string;
  if (side.opaque) body = `<p class="muted">This file type can't be compared item by item (${kb(side.oldSize)} → ${kb(side.newSize)}).</p>`;
  else if (!side.total) body = `<p class="muted">No changes.</p>`;
  else body = `<ul class="changes">${side.changes.map((c) => `<li><span class="k ${c.kind}">${c.kind}</span> ${esc(c.item)}${
      c.parts && c.parts.length ? ` <span class="muted">— ${esc(c.parts.join(", "))}</span>` : ""}</li>`).join("")}${
      side.total > side.changes.length ? `<li class="muted">…and ${side.total - side.changes.length} more</li>` : ""}</ul>`;
  return `<div class="side"><h3>${title}${side.total ? ` <span class="muted">(${side.total})</span>` : ""}</h3>${body}</div>`;
}

function diffHtml(path: string): string {
  const d = diffs[path];
  if (!d) return `<div class="muted"><span class="spinner"></span> Comparing…</div>`;
  if ("error" in d) return `<div class="callout err">${esc(d.error)}</div>`;
  if (d.hasBase) return `<div class="sides">${changeList("Changed online", d.online)}${changeList("Changed on GitHub", d.github)}</div>`;
  return `<div class="sides">${changeList("Online, compared with GitHub", d.between)}</div>
    <p class="muted" style="margin-top:6px">These two were never synced, so there is no common version to tell who changed what.</p>`;
}

async function loadStatus(): Promise<void> {
  let now: Status;
  try { now = await api<Status>(`/api/projects/${projectId}/github`); }
  catch (e) {
    const code = statusOf(e);
    if (code === 401) return renderSignedOut(e);
    app.innerHTML = `<div class="callout err">${esc(code === 403 || code === 404 ? "You don't have access to this project." : message(e))}</div>`;
    return;
  }
  st = now;
  render();
  // A refresh may have changed the files: re-read the open change lists, close those that no longer apply.
  openDiffs.forEach((p) => {
    if (now.files && now.files.some((f) => f.path === p && f.state !== "synced")) loadDiff(p); else openDiffs.delete(p);
  });
}

const STATE_LABEL: Record<FileState, string> = { push: "push", pull: "pull", conflict: "both changed", synced: "in sync" };

function render(): void {
  if (!projectId) { renderImport(); return; }
  if (!st) return;
  const status = st;
  const p = status.project, gh = status.github, link = status.link;
  document.title = `${p.name} — GitHub — KiCad Collaborative`;
  need("#crumb").textContent = "· " + p.name;
  need("#who").textContent = gh.login;
  const back = need<HTMLAnchorElement>("#back"); back.textContent = "Open project"; back.href = `/p/${p.projectId}/edit`;

  let html = `<div id="flash">${flashHtml()}</div>`;
  if (lastResult) { html += lastResult; }

  if (!link) {
    html += `<div><h1>${esc(p.name)}</h1><p class="muted">This project is not linked to a repository yet.</p></div>`;
    html += connectBox(gh);
    if (!p.isOwner) html += `<div class="callout">Only the project's owner can link it to a repository.</div>`;
    else if (gh.connected) html += linkForm(p);
    app.innerHTML = html;
    bindConnectBox(loadStatus);
    if (p.isOwner && gh.connected) bindLinkForm();
    return;
  }

  html += `<section class="box"><h2>${esc(p.name)}<span class="sp"></span>
      ${p.isOwner ? `<button class="btn small danger" id="unlink">Unlink</button>` : ""}</h2><div class="in">
      <div class="row"><div class="grow">
        <a href="${esc(link.url)}" target="_blank" rel="noreferrer"><b>${esc(link.repo)}</b></a>
        <span class="pill">${esc(link.branch)}</span>${link.path ? ` <span class="pill">/${esc(link.path)}</span>` : ""}
        <div class="muted">${link.syncedAt ? `Last synced ${esc(ago(link.syncedAt))}` : "Not synced yet"}${link.linkedBy ? ` · linked by ${esc(link.linkedBy)}` : ""}</div>
      </div><button class="btn small" id="refresh">Refresh</button></div></div></section>`;

  if (!gh.connected) {
    html += connectBox(gh);
    app.innerHTML = html; bindConnectBox(loadStatus); bindCommon();
    return;
  }
  const r = status.remote;
  if (!r.reachable) {
    html += `<div class="callout err">${esc(r.reason)}</div>`;
    app.innerHTML = html; bindCommon();
    return;
  }

  const s = status.summary, files = status.files;
  const canWrite = p.role === "editor";
  const chip = (cls: string, n: number, text: string): string => `<div class="chip ${n ? cls : "zero"}"><b>${n}</b><span>${text}</span></div>`;
  html += `<div class="chips">${chip("push", s.push, "to push")}${chip("pull", s.pull, "to pull")}${chip("conflict", s.conflict, "changed on both")}${chip("synced", s.synced, "in sync")}</div>`;

  if (!r.branchExists) html += `<div class="callout">The branch <b>${esc(link.branch)}</b> does not exist on GitHub yet. The first push creates it.</div>`;
  if (r.truncated) html += `<div class="callout warn">This repository is too large for GitHub to list completely; some files may be missing from the comparison.</div>`;
  if (s.unsaved) html += `<div class="callout warn">${plural(s.unsaved, "document has", "documents have")} live edits that are not saved into the project file yet. Pushing asks an open desktop app to save first; without one, the last saved version is what gets pushed.</div>`;
  if (!canWrite) html += `<div class="callout">You can view this project's sync state. Pushing and pulling need edit access.</div>`;
  else if (!r.canPush) html += `<div class="callout warn">Your GitHub account can read <b>${esc(link.repo)}</b> but not write to it, so you can pull but not push.</div>`;

  if (canWrite) {
    const nothing = !s.push && !s.pull && !s.conflict;
    html += `<section class="box"><h2>Sync</h2><div class="in">
      ${nothing ? `<p class="muted">Everything is in sync with <b>${esc(link.branch)}</b>.</p>` : ""}
      <div class="row actions">
        <button class="btn primary" id="pull" ${s.pull || s.conflict ? "" : "disabled"}>Pull from GitHub${s.pull + s.conflict ? ` (${s.pull + s.conflict})` : ""}</button>
        <button class="btn primary" id="push" ${s.push && r.canPush ? "" : "disabled"}>Push to GitHub${s.push ? ` (${s.push})` : ""}</button>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="f grow">Commit message <input type="text" id="msg" placeholder="Update ${esc(p.name)} from KiCad Collaborative" maxlength="200"></label>
        <label class="muted" style="display:flex;gap:6px;align-items:center;min-height:34px"><input type="checkbox" id="asPr" ${r.branchExists ? "" : "disabled"}> Open a pull request instead</label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="muted" style="display:flex;gap:6px;align-items:center;min-height:34px"><input type="checkbox" id="autoPush" ${link.autoPush ? "checked" : ""}> Push to GitHub every time a checkpoint is saved</label>
      </div>
      ${link.autoPush && link.lastAuto ? `<div class="callout ${link.lastAuto.ok ? "ok" : "warn"}" id="lastAuto" style="margin-top:8px">Checkpoint <b>${esc(link.lastAuto.checkpoint || "")}</b>, ${esc(ago(link.lastAuto.at))}${link.lastAuto.by ? ` by ${esc(link.lastAuto.by)}` : ""}: ${link.lastAuto.ok ? "" : "not pushed. "}${esc(link.lastAuto.message || "")}${link.lastAuto.commitUrl ? ` · <a href="${esc(link.lastAuto.commitUrl)}" target="_blank" rel="noreferrer">view commit</a>` : ""}</div>` : ""}
      ${s.conflict ? `<div class="row" style="margin-top:12px"><span class="muted">When both sides changed the same item, keep</span>
          <span class="seg" id="prefer"><button type="button" data-v="online" class="on">the online version</button><button type="button" data-v="github">GitHub's version</button></span></div>` : ""}
    </div></section>`;
  }

  html += `<section class="box"><h2>Files<span class="sp"></span><span class="muted" style="font-weight:400">${plural(files.length, "file")}</span></h2>
    <table class="files"><thead><tr><th>File</th><th>State</th><th>What changed</th><th></th></tr></thead><tbody>
    ${files.map((f) => `<tr>
      <td class="path">${esc(f.path)}</td>
      <td class="st"><span class="pill ${f.state}">${STATE_LABEL[f.state]}</span></td>
      <td class="detail">${esc(f.detail)}${f.unsavedOps > 0 ? ` · ${plural(f.unsavedOps, "unsaved edit")}` : ""} <span class="muted">· ${kb(f.size)}</span></td>
      <td class="act">${f.state === "conflict" && canWrite ? `<select data-resolve="${esc(f.path)}" aria-label="How to resolve ${esc(f.path)}">
          ${f.mergeable ? `<option value="merge">Merge both</option>` : `<option value="">Choose…</option>`}
          <option value="github">Use GitHub's</option><option value="online">Keep online</option></select>` : ""}${
          f.state !== "synced" ? `<button class="btn small" data-diff="${esc(f.path)}" aria-expanded="${openDiffs.has(f.path)}">Changes</button>` : ""}</td></tr>
      ${f.state !== "synced" && openDiffs.has(f.path) ? `<tr class="diffrow"><td colspan="4" data-diffbody="${esc(f.path)}">${diffHtml(f.path)}</td></tr>` : ""}`).join("")
      || `<tr><td colspan="4" class="muted">No KiCad files on either side yet.</td></tr>`}
    </tbody></table></section>`;

  if (r.commits && r.commits.length) {
    html += `<section class="box"><h2>Recent commits on ${esc(link.branch)}</h2>
      ${r.commits.map((c) => `<div class="commit"><a class="mono" href="${esc(c.url || "#")}" target="_blank" rel="noreferrer">${esc(String(c.sha).slice(0, 7))}</a>
        <span class="msg">${esc(c.message)}</span><span class="muted">${esc(c.author || "")} · ${esc(ago(c.date))}</span></div>`).join("")}</section>`;
  }

  app.innerHTML = html;
  bindCommon();
  $$<HTMLSelectElement>("[data-resolve]").forEach((sel) => {
    const path = sel.dataset.resolve || "";
    const chosen = resolve[path];
    if (chosen !== undefined) sel.value = chosen;
    sel.onchange = () => { resolve[path] = sel.value as Resolution; };
  });
  $$("[data-diff]").forEach((b) => (b.onclick = () => {
    const path = b.dataset.diff || "";
    if (openDiffs.has(path)) openDiffs.delete(path); else { openDiffs.add(path); loadDiff(path); }
    render();
  }));
  const seg = $("#prefer");
  if (seg) $$("button", seg).forEach((b) => (b.onclick = () => { $$("button", seg).forEach((x) => x.classList.toggle("on", x === b)); }));
  const auto = $<HTMLInputElement>("#autoPush");
  if (auto) auto.onchange = async () => {
    auto.disabled = true;
    try {
      await api(`/api/projects/${projectId}/github/settings`, { method: "POST", body: { autoPush: auto.checked } });
      link.autoPush = auto.checked;
      render();
    } catch (e) { auto.checked = !auto.checked; auto.disabled = false; showError(e); }
  };
  const pullBtn = $<HTMLButtonElement>("#pull"), pushBtn = $<HTMLButtonElement>("#push");
  if (pullBtn) pullBtn.onclick = () => busy(pullBtn, () => doPull(false));
  if (pushBtn) pushBtn.onclick = () => busy(pushBtn, doPush);
}

function bindCommon(): void {
  const rf = $<HTMLButtonElement>("#refresh"); if (rf) rf.onclick = () => busy(rf, async () => { lastResult = null; await loadStatus(); });
  const un = $<HTMLButtonElement>("#unlink");
  if (un) un.onclick = () => {
    if (!confirm("Unlink this project from its repository? Nothing is deleted on either side.")) return;
    busy(un, async () => { await api(`/api/projects/${projectId}/github`, { method: "DELETE" }); lastResult = null; await loadStatus(); });
  };
}

async function doPush(): Promise<void> {
  const body = { message: need<HTMLInputElement>("#msg").value, pullRequest: need<HTMLInputElement>("#asPr").checked };
  const j = await api<PushResult>(`/api/projects/${projectId}/github/push`, { method: "POST", body });
  const sha = String(j.commit).slice(0, 7);
  lastResult = j.pullRequest
    ? `<div class="callout ok" id="result">Pushed ${plural(j.pushed.length, "file")} to <b>${esc(j.branch)}</b> and opened <a href="${esc(j.pullRequest.url)}" target="_blank" rel="noreferrer">pull request #${esc(j.pullRequest.number)}</a>. The files show as in sync once it is merged.</div>`
    : `<div class="callout ok" id="result">Pushed ${plural(j.pushed.length, "file")} to <b>${esc(j.branch)}</b> as ${j.commitUrl ? `<a class="mono" href="${esc(j.commitUrl)}" target="_blank" rel="noreferrer">${esc(sha)}</a>` : `<span class="mono">${esc(sha)}</span>`}.</div>`;
  await loadStatus();
}

async function doPull(force: boolean): Promise<void> {
  const seg = $("#prefer");
  const prefer = seg ? $(".on", seg)?.dataset.v : "online";
  const res: Record<string, Resolution> = {};
  (st ? st.files : []).filter((f) => f.state === "conflict").forEach((f) => {
    const v: Resolution = resolve[f.path] !== undefined ? resolve[f.path] : (f.mergeable ? "merge" : "");
    if (v) res[f.path] = v;
  });
  const j = await api<PullResult>(`/api/projects/${projectId}/github/pull`, { method: "POST", body: { resolve: res, prefer, force } });
  const lines = j.updated.map((u) => {
    let t = `<span class="mono">${esc(u.path)}</span> — ${esc(u.action)}`;
    if (u.action === "merged") {
      t += `: ${plural(u.fromGithub, "change")} from GitHub, ${plural(u.fromOnline, "change")} kept from online`;
      if (u.conflicts.length) {
        t += `; ${plural(u.conflicts.length, "item")} changed on both sides:<ul>` +
          u.conflicts.slice(0, 12).map((c) => `<li>${esc(c.item)} — kept the ${c.kept === "github" ? "GitHub" : "online"} version</li>`).join("") +
          (u.conflicts.length > 12 ? `<li>…and ${u.conflicts.length - 12} more</li>` : "") + `</ul>`;
      }
    }
    return `<li>${t}</li>`;
  });
  const skipped = j.skipped.map((s) => `<li><span class="mono">${esc(s.path)}</span> — ${esc(s.reason)}</li>`);
  const needsForce = j.skipped.some((s) => /live edits/.test(s.reason));
  lastResult = `<div id="result">` +
    (lines.length ? `<div class="callout ok">Pulled from GitHub:<ul>${lines.join("")}</ul>${j.checkpoint ? `<p class="muted" style="margin-top:6px">The previous versions are kept in History as “${esc(j.checkpoint)}”.</p>` : ""}</div>` : "") +
    (skipped.length ? `<div class="callout warn" style="margin-top:8px">Left alone:<ul>${skipped.join("")}</ul>${needsForce ? `<p style="margin-top:8px"><button class="btn small" id="forcePull">Pull anyway, discarding the unsaved edits</button></p>` : ""}</div>` : "") +
    (!lines.length && !skipped.length ? `<div class="callout">Nothing to pull.</div>` : "") + `</div>`;
  await loadStatus();
  const fp = $<HTMLButtonElement>("#forcePull");
  if (fp) fp.onclick = () => busy(fp, () => doPull(true));
}

// ---------------------------------------------------------------- link form
function linkForm(p: ProjectInfo): string {
  return `<section class="box"><h2>Link to a repository</h2><div class="in">
    <div class="seg" id="mode" style="margin-bottom:12px"><button type="button" data-v="existing" class="on">Existing repository</button><button type="button" data-v="new">New repository</button></div>
    <div id="existing"><div id="picker"></div></div>
    <div id="new" class="hide"><div class="row">
      <label class="f grow">Repository name <input type="text" id="newName" value="${esc(p.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "kicad-project")}" autocapitalize="off" spellcheck="false"></label>
      <label class="f">Visibility <select id="newPrivate"><option value="1">Private</option><option value="0">Public</option></select></label></div></div>
    <div class="row" style="margin-top:12px">
      <label class="f grow">Branch <input type="text" id="lBranch" placeholder="the repository's default branch" autocapitalize="off" spellcheck="false"></label>
      <label class="f grow">Folder in the repository <input type="text" id="lPath" placeholder="/ (the repository root)" autocapitalize="off" spellcheck="false"></label>
    </div>
    <p class="muted" style="margin-top:10px">Linking writes nothing to GitHub. After linking you see what differs and choose to push or pull.</p>
    <div class="row actions" style="margin-top:4px"><button class="btn primary" id="doLink" disabled>Link</button></div>
  </div></section>`;
}
function bindLinkForm(): void {
  let mode = "existing", picked: string | null = null;
  const btn = need<HTMLButtonElement>("#doLink");
  const newName = need<HTMLInputElement>("#newName"), branch = need<HTMLInputElement>("#lBranch");
  const sync = () => { btn.disabled = mode === "existing" ? !picked : !newName.value.trim(); };
  $$("#mode button").forEach((b) => (b.onclick = () => {
    mode = b.dataset.v || "existing";
    $$("#mode button").forEach((x) => x.classList.toggle("on", x === b));
    need("#existing").classList.toggle("hide", mode !== "existing");
    need("#new").classList.toggle("hide", mode !== "new");
    sync();
  }));
  newName.oninput = sync;
  repoPicker(need("#picker"), (full, repo) => {
    picked = full;
    if (repo && repo.defaultBranch) branch.placeholder = repo.defaultBranch + " (default)";
    sync();
  });
  btn.onclick = () => busy(btn, async () => {
    const body: { branch: string; path: string; repo?: string | null; create?: { name: string; private: boolean } } =
      { branch: branch.value, path: need<HTMLInputElement>("#lPath").value };
    if (mode === "existing") body.repo = picked;
    else body.create = { name: newName.value.trim(), private: need<HTMLSelectElement>("#newPrivate").value === "1" };
    await api(`/api/projects/${projectId}/github`, { method: "PUT", body });
    await loadStatus();
  });
}

// ---------------------------------------------------------------- go
if (projectId) loadStatus(); else renderImport();

export {};
