// github.js — the GitHub page (served by src/github.rs).
//
//   /github          connect an account, bring a repository folder online as a project
//   /p/<id>/github   one project's link to a repository: what differs, push, pull, merge
//
// Plain DOM on purpose: the page is small, has no canvas, and must not depend on the
// editor bundles (it is reachable from the desktop app's browser hand-off too).
(function () {
  "use strict";

  const app = document.getElementById("app");
  const projectId = (location.pathname.match(/^\/p\/([0-9a-f-]{36})\/github\/?$/i) || [])[1] || null;
  const here = location.pathname;

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  async function api(path, opts) {
    const o = Object.assign({ credentials: "same-origin", headers: {} }, opts || {});
    if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["Content-Type"] = "application/json"; }
    const r = await fetch(path, o);
    let j = null;
    try { j = await r.json(); } catch (_) { /* not json */ }
    if (!r.ok) {
      const e = new Error((j && j.message) || `Request failed (${r.status})`);
      e.status = r.status; e.code = j && j.error;
      throw e;
    }
    return j;
  }

  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
    return new Date(iso).toLocaleDateString();
  }
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " kB" : n + " B");
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const connectUrl = (access) => `/auth/github/connect?next=${encodeURIComponent(here)}${access ? "&access=" + access : ""}`;

  /** Run an async action behind a button: spinner while it runs, the error shown where the page says. */
  async function busy(btn, fn) {
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label}`;
    try { return await fn(); }
    catch (e) { showError(e); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  }

  let flash = null; // { kind, html } shown once at the top of the next render
  function showError(e) {
    flash = { kind: "err", html: esc(e.message || String(e)) };
    const slot = $("#flash");
    if (slot) slot.innerHTML = flashHtml();
    else render();
  }
  function flashHtml() {
    if (!flash) return "";
    const f = flash; flash = null;
    return `<div class="note ${f.kind}" role="status">${f.html}</div>`;
  }

  // ---------------------------------------------------------------- shared pieces
  function connectBox(gh) {
    if (!gh.configured) {
      return `<section class="box"><h2>GitHub account</h2><div class="in">
        <p>GitHub sign-in is not configured on this server, so repositories can't be connected.</p></div></section>`;
    }
    if (gh.connected) {
      return `<section class="box"><h2>GitHub account</h2><div class="in"><div class="row">
        <div class="grow"><b>${esc(gh.login)}</b> is connected
          <span class="tag">${gh.privateRepos === false ? "public repositories" : "repositories"}</span>
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
  function bindConnectBox(after) {
    const d = $("#ghDisconnect");
    if (d) d.onclick = () => busy(d, async () => { await api("/api/github", { method: "DELETE" }); await after(); });
  }

  /** A searchable repository list; calls onPick(fullName, repo). */
  function repoPicker(el, onPick) {
    el.innerHTML = `<label class="f">Repository
        <input type="text" id="repoQ" placeholder="Search your repositories, or type owner/name" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="list" id="repoList" style="margin-top:8px"><div class="empty">Loading your repositories…</div></div>`;
    const q = $("#repoQ", el), list = $("#repoList", el);
    let all = [], picked = null;
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      const hits = all.filter((r) => !needle || r.fullName.toLowerCase().includes(needle)).slice(0, 60);
      let html = hits.map((r) => `<button type="button" class="it${r.fullName === picked ? " sel" : ""}" data-repo="${esc(r.fullName)}">
          <span class="nm">${esc(r.fullName)}</span>${r.private ? '<span class="tag">private</span>' : ""}
          <span class="sp"></span><span class="muted">${esc(ago(r.pushedAt))}</span></button>`).join("");
      // A repository that is not in the list (not a member, or beyond the first few hundred) can still be named outright.
      if (/^[\w.-]+\/[\w.-]+$/.test(q.value.trim()) && !hits.some((r) => r.fullName.toLowerCase() === needle)) {
        html += `<button type="button" class="it" data-repo="${esc(q.value.trim())}"><span class="nm">Use ${esc(q.value.trim())}</span></button>`;
      }
      list.innerHTML = html || `<div class="empty">No repository matches.</div>`;
      $$(".it", list).forEach((b) => (b.onclick = () => {
        picked = b.dataset.repo; draw();
        onPick(picked, all.find((r) => r.fullName === picked) || null);
      }));
    };
    q.oninput = draw;
    api("/api/github/repos").then((j) => { all = j.repos; draw(); })
      .catch((e) => { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  // ================================================================ /github
  async function renderImport() {
    document.title = "GitHub — KiCad Collaborative";
    let gh;
    try { gh = await api("/api/github"); }
    catch (e) { return renderSignedOut(e); }
    $("#who").textContent = gh.login;

    app.innerHTML = `<div><h1>GitHub</h1>
        <p class="muted">Keep an online project and a repository folder in step: push what changed online, pull what changed on GitHub, and merge item by item when both did.</p></div>
      <div id="flash">${flashHtml()}</div>
      ${connectBox(gh)}
      ${gh.connected ? `<section class="box"><h2>Bring a repository online</h2><div class="in">
          <div id="picker"></div><div id="scan" style="margin-top:12px"></div></div></section>` : ""}
      <section class="box"><h2>Your online projects</h2><div id="mine"><div class="in muted">Loading…</div></div></section>`;
    bindConnectBox(renderImport);

    if (gh.connected) {
      repoPicker($("#picker"), (full) => scan(full, null));
    }

    api("/api/projects").then((j) => {
      $("#mine").innerHTML = j.projects.length
        ? j.projects.map((p) => `<a class="commit" href="/p/${p.projectId}/github" style="color:inherit">
            <span class="msg"><b>${esc(p.name)}</b> <span class="muted">· ${esc(p.ownerLogin)}</span></span>
            <span class="muted">${esc(ago(p.updatedAt))}</span><span class="tag">GitHub sync ›</span></a>`).join("")
        : `<div class="in muted">No projects yet. Bring one in from a repository above, or start a session from the desktop app.</div>`;
    }).catch((e) => { $("#mine").innerHTML = `<div class="in muted">${esc(e.message)}</div>`; });
  }

  async function scan(full, branch) {
    const el = $("#scan");
    el.innerHTML = `<div class="muted"><span class="spin"></span> Looking for KiCad projects in ${esc(full)}…</div>`;
    let s;
    try { s = await api(`/api/github/scan?repo=${encodeURIComponent(full)}${branch ? "&branch=" + encodeURIComponent(branch) : ""}`); }
    catch (e) { el.innerHTML = `<div class="note err">${esc(e.message)}</div>`; return; }
    const branches = s.branches.includes(s.branch) ? s.branches : [s.branch].concat(s.branches);
    el.innerHTML = `<div class="row" style="margin-bottom:8px">
        <label class="f">Branch <select id="scanBranch">${branches.map((b) => `<option${b === s.branch ? " selected" : ""}>${esc(b)}</option>`).join("")}</select></label>
        <div class="grow muted">${s.projects.length ? `${plural(s.projects.length, "KiCad project")} in <b>${esc(s.repo)}</b>` : ""}</div></div>
      ${s.truncated ? `<div class="note warn">This repository is too large for GitHub to list completely; some folders may be missing.</div>` : ""}
      <div class="list">${s.projects.length ? s.projects.map((p, i) => `<div class="it" style="cursor:default">
          <span class="nm">${esc(p.name)}</span><span class="muted mono">${esc(p.path || "/")}</span><span class="sp"></span>
          <span class="muted">${plural(p.files, "file")}</span>
          <button class="btn small primary" data-import="${i}">Bring online</button></div>`).join("")
        : `<div class="empty">No KiCad files on this branch.</div>`}</div>`;
    $("#scanBranch").onchange = (ev) => scan(full, ev.target.value);
    $$("[data-import]", el).forEach((b) => (b.onclick = () => busy(b, async () => {
      const p = s.projects[+b.dataset.import];
      const j = await api("/api/github/import", { method: "POST", body: { repo: s.repo, branch: s.branch, path: p.path, name: p.name } });
      location.href = `/p/${j.projectId}/github`;
    })));
  }

  function renderSignedOut(e) {
    if (e && e.status !== 401) { app.innerHTML = `<div class="note err">${esc(e.message)}</div>`; return; }
    app.innerHTML = `<section class="box"><h2>GitHub</h2><div class="in">
      <p>Sign in to connect repositories to your online projects.</p>
      <a class="btn primary" href="/auth/github/login?next=${encodeURIComponent(here)}">Sign in with GitHub</a></div></section>`;
  }

  // ================================================================ /p/<id>/github
  let st = null;                 // last status
  const resolve = {};            // path -> merge | github | online
  let lastResult = null;         // html of the last push/pull outcome

  // ---------------------------------------------------------------- what changed inside a file
  const openDiffs = new Set();   // paths whose change list is expanded
  const diffs = {};              // path -> response | { error } | undefined while loading

  async function loadDiff(path) {
    diffs[path] = undefined;
    try { diffs[path] = await api(`/api/projects/${projectId}/github/diff?path=${encodeURIComponent(path)}`); }
    catch (e) { diffs[path] = { error: e.message }; }
    const cell = $$("[data-diffbody]").find((c) => c.dataset.diffbody === path);
    if (cell) cell.innerHTML = diffHtml(path);
  }

  function changeList(title, side) {
    if (!side) return "";
    let body;
    if (side.opaque) body = `<p class="muted">This file type can't be compared item by item (${kb(side.oldSize)} → ${kb(side.newSize)}).</p>`;
    else if (!side.total) body = `<p class="muted">No changes.</p>`;
    else body = `<ul class="changes">${side.changes.map((c) => `<li><span class="k ${c.kind}">${c.kind}</span> ${esc(c.item)}${
        c.parts && c.parts.length ? ` <span class="muted">— ${esc(c.parts.join(", "))}</span>` : ""}</li>`).join("")}${
        side.total > side.changes.length ? `<li class="muted">…and ${side.total - side.changes.length} more</li>` : ""}</ul>`;
    return `<div class="side"><h3>${title}${side.total ? ` <span class="muted">(${side.total})</span>` : ""}</h3>${body}</div>`;
  }

  function diffHtml(path) {
    const d = diffs[path];
    if (!d) return `<div class="muted"><span class="spin"></span> Comparing…</div>`;
    if (d.error) return `<div class="note err">${esc(d.error)}</div>`;
    if (d.hasBase) return `<div class="sides">${changeList("Changed online", d.online)}${changeList("Changed on GitHub", d.github)}</div>`;
    return `<div class="sides">${changeList("Online, compared with GitHub", d.between)}</div>
      <p class="muted" style="margin-top:6px">These two were never synced, so there is no common version to tell who changed what.</p>`;
  }

  async function loadStatus() {
    try { st = await api(`/api/projects/${projectId}/github`); }
    catch (e) {
      if (e.status === 401) return renderSignedOut(e);
      app.innerHTML = `<div class="note err">${esc(e.status === 403 || e.status === 404 ? "You don't have access to this project." : e.message)}</div>`;
      return;
    }
    render();
    // A refresh may have changed the files: re-read the open change lists, close those that no longer apply.
    openDiffs.forEach((p) => {
      if (st.files && st.files.some((f) => f.path === p && f.state !== "synced")) loadDiff(p); else openDiffs.delete(p);
    });
  }

  function render() {
    if (!projectId) return renderImport();
    if (!st) return;
    const p = st.project, gh = st.github, link = st.link;
    document.title = `${p.name} — GitHub — KiCad Collaborative`;
    $("#crumb").textContent = "· " + p.name;
    $("#who").textContent = gh.login;
    const back = $("#back"); back.textContent = "Open project"; back.href = `/p/${p.projectId}/edit`;

    let html = `<div id="flash">${flashHtml()}</div>`;
    if (lastResult) { html += lastResult; }

    if (!link) {
      html += `<div><h1>${esc(p.name)}</h1><p class="muted">This project is not linked to a repository yet.</p></div>`;
      html += connectBox(gh);
      if (!p.isOwner) html += `<div class="note">Only the project's owner can link it to a repository.</div>`;
      else if (gh.connected) html += linkForm(p);
      app.innerHTML = html;
      bindConnectBox(loadStatus);
      if (p.isOwner && gh.connected) bindLinkForm(p);
      return;
    }

    html += `<section class="box"><h2>${esc(p.name)}<span class="sp"></span>
        ${p.isOwner ? `<button class="btn small danger" id="unlink">Unlink</button>` : ""}</h2><div class="in">
        <div class="row"><div class="grow">
          <a href="${esc(link.url)}" target="_blank" rel="noreferrer"><b>${esc(link.repo)}</b></a>
          <span class="tag">${esc(link.branch)}</span>${link.path ? ` <span class="tag">/${esc(link.path)}</span>` : ""}
          <div class="muted">${link.syncedAt ? `Last synced ${esc(ago(link.syncedAt))}` : "Not synced yet"}${link.linkedBy ? ` · linked by ${esc(link.linkedBy)}` : ""}</div>
        </div><button class="btn small" id="refresh">Refresh</button></div></div></section>`;

    if (!gh.connected) {
      html += connectBox(gh);
      app.innerHTML = html; bindConnectBox(loadStatus); bindCommon();
      return;
    }
    const r = st.remote;
    if (!r.reachable) {
      html += `<div class="note err">${esc(r.reason)}</div>`;
      app.innerHTML = html; bindCommon();
      return;
    }

    const s = st.summary, files = st.files;
    const canWrite = p.role === "editor";
    const chip = (cls, n, text) => `<div class="chip ${n ? cls : "zero"}"><b>${n}</b><span>${text}</span></div>`;
    html += `<div class="chips">${chip("push", s.push, "to push")}${chip("pull", s.pull, "to pull")}${chip("conflict", s.conflict, "changed on both")}${chip("synced", s.synced, "in sync")}</div>`;

    if (!r.branchExists) html += `<div class="note">The branch <b>${esc(link.branch)}</b> does not exist on GitHub yet. The first push creates it.</div>`;
    if (r.truncated) html += `<div class="note warn">This repository is too large for GitHub to list completely; some files may be missing from the comparison.</div>`;
    if (s.unsaved) html += `<div class="note warn">${plural(s.unsaved, "document has", "documents have")} live edits that are not saved into the project file yet. Pushing asks an open desktop app to save first; without one, the last saved version is what gets pushed.</div>`;
    if (!canWrite) html += `<div class="note">You can view this project's sync state. Pushing and pulling need edit access.</div>`;
    else if (!r.canPush) html += `<div class="note warn">Your GitHub account can read <b>${esc(link.repo)}</b> but not write to it, so you can pull but not push.</div>`;

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
        ${link.autoPush && link.lastAuto ? `<div class="note ${link.lastAuto.ok ? "ok" : "warn"}" id="lastAuto" style="margin-top:8px">Checkpoint <b>${esc(link.lastAuto.checkpoint || "")}</b>, ${esc(ago(link.lastAuto.at))}${link.lastAuto.by ? ` by ${esc(link.lastAuto.by)}` : ""}: ${link.lastAuto.ok ? "" : "not pushed. "}${esc(link.lastAuto.message || "")}${link.lastAuto.commitUrl ? ` · <a href="${esc(link.lastAuto.commitUrl)}" target="_blank" rel="noreferrer">view commit</a>` : ""}</div>` : ""}
        ${s.conflict ? `<div class="row" style="margin-top:12px"><span class="muted">When both sides changed the same item, keep</span>
            <span class="seg" id="prefer"><button type="button" data-v="online" class="on">the online version</button><button type="button" data-v="github">GitHub's version</button></span></div>` : ""}
      </div></section>`;
    }

    html += `<section class="box"><h2>Files<span class="sp"></span><span class="muted" style="font-weight:400">${plural(files.length, "file")}</span></h2>
      <table class="files"><thead><tr><th>File</th><th>State</th><th>What changed</th><th></th></tr></thead><tbody>
      ${files.map((f) => `<tr>
        <td class="path">${esc(f.path)}</td>
        <td class="st"><span class="tag ${f.state}">${{ push: "push", pull: "pull", conflict: "both changed", synced: "in sync" }[f.state]}</span></td>
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
    $$("[data-resolve]").forEach((sel) => {
      if (resolve[sel.dataset.resolve] !== undefined) sel.value = resolve[sel.dataset.resolve];
      sel.onchange = () => { resolve[sel.dataset.resolve] = sel.value; };
    });
    $$("[data-diff]").forEach((b) => (b.onclick = () => {
      const path = b.dataset.diff;
      if (openDiffs.has(path)) openDiffs.delete(path); else { openDiffs.add(path); loadDiff(path); }
      render();
    }));
    const seg = $("#prefer");
    if (seg) $$("button", seg).forEach((b) => (b.onclick = () => { $$("button", seg).forEach((x) => x.classList.toggle("on", x === b)); }));
    const auto = $("#autoPush");
    if (auto) auto.onchange = async () => {
      auto.disabled = true;
      try {
        await api(`/api/projects/${projectId}/github/settings`, { method: "POST", body: { autoPush: auto.checked } });
        st.link.autoPush = auto.checked;
        render();
      } catch (e) { auto.checked = !auto.checked; auto.disabled = false; showError(e); }
    };
    const pullBtn = $("#pull"), pushBtn = $("#push");
    if (pullBtn) pullBtn.onclick = () => busy(pullBtn, () => doPull(false));
    if (pushBtn) pushBtn.onclick = () => busy(pushBtn, doPush);
  }

  function bindCommon() {
    const rf = $("#refresh"); if (rf) rf.onclick = () => busy(rf, async () => { lastResult = null; await loadStatus(); });
    const un = $("#unlink");
    if (un) un.onclick = () => {
      if (!confirm("Unlink this project from its repository? Nothing is deleted on either side.")) return;
      busy(un, async () => { await api(`/api/projects/${projectId}/github`, { method: "DELETE" }); lastResult = null; await loadStatus(); });
    };
  }

  async function doPush() {
    const body = { message: $("#msg").value, pullRequest: $("#asPr").checked };
    const j = await api(`/api/projects/${projectId}/github/push`, { method: "POST", body });
    const sha = String(j.commit).slice(0, 7);
    lastResult = j.pullRequest
      ? `<div class="note ok" id="result">Pushed ${plural(j.pushed.length, "file")} to <b>${esc(j.branch)}</b> and opened <a href="${esc(j.pullRequest.url)}" target="_blank" rel="noreferrer">pull request #${esc(j.pullRequest.number)}</a>. The files show as in sync once it is merged.</div>`
      : `<div class="note ok" id="result">Pushed ${plural(j.pushed.length, "file")} to <b>${esc(j.branch)}</b> as ${j.commitUrl ? `<a class="mono" href="${esc(j.commitUrl)}" target="_blank" rel="noreferrer">${esc(sha)}</a>` : `<span class="mono">${esc(sha)}</span>`}.</div>`;
    await loadStatus();
  }

  async function doPull(force) {
    const seg = $("#prefer");
    const prefer = seg ? ($(".on", seg) || {}).dataset.v : "online";
    const res = {};
    st.files.filter((f) => f.state === "conflict").forEach((f) => {
      const v = resolve[f.path] !== undefined ? resolve[f.path] : (f.mergeable ? "merge" : "");
      if (v) res[f.path] = v;
    });
    const j = await api(`/api/projects/${projectId}/github/pull`, { method: "POST", body: { resolve: res, prefer, force } });
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
      (lines.length ? `<div class="note ok">Pulled from GitHub:<ul>${lines.join("")}</ul>${j.checkpoint ? `<p class="muted" style="margin-top:6px">The previous versions are kept in History as “${esc(j.checkpoint)}”.</p>` : ""}</div>` : "") +
      (skipped.length ? `<div class="note warn" style="margin-top:8px">Left alone:<ul>${skipped.join("")}</ul>${needsForce ? `<p style="margin-top:8px"><button class="btn small" id="forcePull">Pull anyway, discarding the unsaved edits</button></p>` : ""}</div>` : "") +
      (!lines.length && !skipped.length ? `<div class="note">Nothing to pull.</div>` : "") + `</div>`;
    await loadStatus();
    const fp = $("#forcePull");
    if (fp) fp.onclick = () => busy(fp, () => doPull(true));
  }

  // ---------------------------------------------------------------- link form
  function linkForm(p) {
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
  function bindLinkForm() {
    let mode = "existing", picked = null;
    const btn = $("#doLink");
    const sync = () => { btn.disabled = mode === "existing" ? !picked : !$("#newName").value.trim(); };
    $$("#mode button").forEach((b) => (b.onclick = () => {
      mode = b.dataset.v;
      $$("#mode button").forEach((x) => x.classList.toggle("on", x === b));
      $("#existing").classList.toggle("hide", mode !== "existing");
      $("#new").classList.toggle("hide", mode !== "new");
      sync();
    }));
    $("#newName").oninput = sync;
    repoPicker($("#picker"), (full, repo) => {
      picked = full;
      if (repo && repo.defaultBranch) $("#lBranch").placeholder = repo.defaultBranch + " (default)";
      sync();
    });
    btn.onclick = () => busy(btn, async () => {
      const body = { branch: $("#lBranch").value, path: $("#lPath").value };
      if (mode === "existing") body.repo = picked;
      else body.create = { name: $("#newName").value.trim(), private: $("#newPrivate").value === "1" };
      await api(`/api/projects/${projectId}/github`, { method: "PUT", body });
      await loadStatus();
    });
  }

  // ---------------------------------------------------------------- go
  if (projectId) loadStatus(); else renderImport();
})();
