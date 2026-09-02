use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;

use crate::auth::{self, COOKIE_NAME};
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

pub(crate) fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const STYLE: &str = r#"
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 8vh auto; padding: 0 24px; line-height: 1.5; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 12px; padding: 32px; }
  h1 { margin-top: 0; font-size: 1.5rem; }
  .muted { opacity: .65; font-size: .9rem; }
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; background: #4477ee; color: white;
         text-decoration: none; font-weight: 600; margin-right: 12px; }
  .btn.secondary { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
                   font: inherit; cursor: pointer; }
  code { background: color-mix(in srgb, currentColor 10%, transparent); padding: 2px 6px; border-radius: 4px; }
  .linkbox { display: flex; gap: 8px; margin-top: 16px; }
  .linkbox input { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
                   background: transparent; color: inherit; }
</style>
"#;

/// The single-page web app (home + online editor).  Client-side routed: the
/// same shell serves `/`, `/app` and `/p/{id}/edit`.
pub async fn app_page() -> Html<&'static str> {
    Html(include_str!("../static/app.html"))
}

pub async fn app_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8"),
         (header::CACHE_CONTROL, "no-cache")],
        include_str!("../static/app.js"),
    )
        .into_response()
}

pub async fn index() -> Html<String> {
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KiCad Collaborative</title>{STYLE}</head><body>
<div class="card">
  <h1>KiCad Collaborative</h1>
  <p>Real-time multiplayer for KiCad — shared cursors, live edits, offline sync.</p>
  <p class="muted">To join a project, open the invite link someone shared with you,
     or paste it into KiCad &rarr; <b>File &rarr; Join Shared Project…</b></p>
</div></body></html>"#
    ))
}

pub async fn join_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
    jar: CookieJar,
) -> AppResult<Response> {
    let link = persist::get_valid_share_link(&state.pool, &token).await?;
    let Some(link) = link else {
        return Ok(Html(format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><title>Invalid link</title>{STYLE}</head><body>
<div class="card"><h1>Link invalid or expired</h1>
<p class="muted">Ask the project owner for a fresh invite link.</p></div></body></html>"#
        ))
        .into_response());
    };
    let project = persist::get_project(&state.pool, link.project_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let owner = persist::get_user(&state.pool, project.owner_id).await?;
    let owner_login = owner.map(|o| o.login).unwrap_or_else(|| "unknown".into());

    let signed_in = jar
        .get(COOKIE_NAME)
        .and_then(|c| auth::verify_jwt(&state, c.value()))
        .is_some();
    let signin_html = if signed_in {
        r#"<p class="muted">You're signed in — this project was added to your account.</p>"#.to_string()
    } else {
        format!(
            r#"<p><a class="btn secondary" href="/auth/github/login?next=/j/{}">Sign in with GitHub</a>
               <span class="muted">to keep access under your account</span></p>"#,
            esc(&token)
        )
    };

    let url = format!("{}/j/{}", state.cfg.public_url, token);
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join {name} — KiCad Collaborative</title>{STYLE}</head><body>
<div class="card">
  <h1>{name}</h1>
  <p class="muted">Shared by <b>{owner}</b> &middot; you'll join as <b>{role}</b></p>
  <p style="margin-top:24px">
    <a class="btn" href="kicad-collab://join/{token}">Open in KiCad</a>
    <a class="btn secondary" href="/p/{pid}/edit">Open in browser</a>
  </p>
  <p class="muted">Nothing happened? Copy the link below and paste it into KiCad &rarr;
     <b>File &rarr; Join Shared Project…</b></p>
  <div class="linkbox">
    <input id="lnk" readonly value="{url}">
    <button type="button" class="btn secondary" onclick="navigator.clipboard.writeText(document.getElementById('lnk').value);this.textContent='Copied!';">Copy</button>
  </div>
  {signin}
</div></body></html>"#,
        name = esc(&project.name),
        owner = esc(&owner_login),
        role = esc(&link.role),
        pid = link.project_id,
        token = esc(&token),
        url = esc(&url),
        signin = signin_html,
    );
    Ok(Html(html).into_response())
}


/// The public gallery: opt-in projects, with previews when rendering is enabled.
pub async fn gallery_page(State(state): State<AppState>) -> AppResult<Response> {
    let projects = persist::list_public_projects(&state.pool, 100).await?;

    let cards: String = if projects.is_empty() {
        r#"<p class="muted">Nothing here yet. Make a project public from
           <code>PATCH /api/projects/{id} {"public": true}</code> (a toggle in the
           Online Projects dialog is on the roadmap) and it shows up for everyone.</p>"#
            .to_string()
    } else {
        projects
            .iter()
            .map(|e| {
                // Previews may be server-rendered (KICAD_CLI) or client-pushed;
                // emit the image either way and hide it if neither exists yet.
                let img = format!(
                    r#"<a href="/p/{id}"><img loading="lazy" alt="Board preview of {name}"
                         onerror="this.parentNode.style.display='none'"
                         src="/api/projects/{id}/preview.svg"></a>"#,
                    id = e.id,
                    name = esc(&e.name)
                );
                let blurb = if e.description.is_empty() {
                    String::new()
                } else {
                    format!(r#"<p class="blurb">{}</p>"#, esc(&e.description))
                };
                format!(
                    r#"<div class="tile">{img}
  <div class="tmeta"><a href="/p/{id}"><b>{name}</b></a>
  <span class="muted">by {owner}</span>{blurb}
  <span class="muted small">updated {updated}</span></div></div>"#,
                    id = e.id,
                    name = esc(&e.name),
                    owner = esc(&e.owner_login),
                    updated = e.updated_at.format("%Y-%m-%d"),
                )
            })
            .collect()
    };

    Ok(Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gallery — KiCad Collaborative</title>{STYLE}
<style>
  body {{ max-width: 1080px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }}
  .tile {{ border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 12px;
           overflow: hidden; }}
  .tile img {{ display: block; width: 100%; aspect-ratio: 4/3; object-fit: contain;
               background: #f4f1e6; padding: 8px; box-sizing: border-box; }}
  .tmeta {{ padding: 10px 14px; }}
  .tmeta a {{ color: inherit; text-decoration: none; }}
  .tmeta .blurb {{ margin: 6px 0 4px; font-size: .9rem; opacity: .85; }}
  .tmeta .small {{ font-size: .8rem; display: block; margin-top: 2px; }}
</style></head><body>
<h1>Gallery</h1>
<p class="muted">Public projects shared by the community. Everything else on this server stays private.</p>
<div class="grid">{cards}</div>
</body></html>"#
    ))
    .into_response())
}


/// A public (or member-visible) project page.
pub async fn project_page(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
    jar: CookieJar,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    let viewer = auth::user_from_jar(&state, &jar).await;

    if !project.public {
        let Some(user) = &viewer else { return Err(AppError::NotFound) };
        persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::NotFound)?;
    }

    let owner = persist::get_user(&state.pool, project.owner_id).await?;
    let owner_login = owner.map(|o| o.login).unwrap_or_else(|| "unknown".into());
    let is_owner = viewer.as_ref().is_some_and(|u| u.id == project.owner_id);
    let signed_in = viewer.is_some();
    let docs = persist::project_documents(&state.pool, id).await?;

    let doc_rows: String = docs
        .iter()
        .map(|d| format!("<li><code>{}</code> <span class=\"muted\">{}</span></li>",
                         esc(&d.path), esc(&d.doc_type)))
        .collect();

    let preview = if docs.iter().any(|d| d.doc_type == "kicad_pcb") {
        format!(
            r#"<p><img style="width:100%;background:#f4f1e6;border-radius:8px;padding:10px;box-sizing:border-box"
                 alt="Board preview" onerror="this.parentNode.style.display='none'"
                 src="/api/projects/{id}/preview.svg"></p>
<p><a class="btn secondary" href="/p/{id}/live">Watch live</a></p>"#
        )
    } else {
        String::new()
    };

    let description_html = if is_owner {
        format!(
            r#"<div id="descBox">
  <p id="descText" class="desc">{d}</p>
  <p><button class="btn secondary" id="descEdit">Edit description</button></p>
  <form id="descForm" style="display:none">
    <textarea id="descInput" rows="3" maxlength="2000"
      placeholder="What is this project?">{d}</textarea>
    <p><button class="btn" type="submit">Save</button>
       <button class="btn secondary" type="button" id="descCancel">Cancel</button></p>
  </form>
</div>
<script>
const box = document.getElementById("descBox");
const form = document.getElementById("descForm");
document.getElementById("descEdit").onclick = () => {{
  document.getElementById("descText").style.display = "none";
  document.getElementById("descEdit").style.display = "none";
  form.style.display = "block";
}};
document.getElementById("descCancel").onclick = () => location.reload();
form.onsubmit = async (ev) => {{
  ev.preventDefault();
  const r = await fetch("/api/projects/{id}", {{ method: "PATCH",
    headers: {{ "content-type": "application/json" }},
    body: JSON.stringify({{ description: document.getElementById("descInput").value }}) }});
  if (r.ok) location.reload(); else alert("Save failed: " + (await r.text()));
}};
</script>"#,
            d = esc(&project.description),
            id = id,
        )
    } else if project.description.is_empty() {
        String::new()
    } else {
        format!(r#"<p class="desc">{}</p>"#, esc(&project.description))
    };

    let clone_html = if signed_in {
        format!(
            r#"<p><button class="btn secondary" id="cloneBtn">Clone to my account</button></p>
<script>
document.getElementById("cloneBtn").onclick = async () => {{
  const r = await fetch("/api/projects/{id}/clone", {{ method: "POST" }});
  if (!r.ok) {{ alert("Clone failed: " + (await r.text())); return; }}
  const j = await r.json();
  location.href = "/p/" + j.projectId;
}};
</script>"#
        )
    } else {
        String::new()
    };

    Ok(Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} — KiCad Collaborative</title>{STYLE}<style>
  body {{ max-width: 860px; }}
  .desc {{ white-space: pre-wrap; }}
  #descForm textarea {{ width: 100%; box-sizing: border-box; }}
</style></head><body>
<p><a href="/gallery" class="muted">&larr; Gallery</a></p>
<div class="card">
  <h1>{name}</h1>
  <p class="muted">by <b>{owner}</b>{vis}</p>
  {description}
  {preview}
  <ul>{doc_rows}</ul>
  {clone}
  <p class="muted">To edit, join from KiCad: <b>File &rarr; Online Projects…</b></p>
</div></body></html>"#,
        name = esc(&project.name),
        owner = esc(&owner_login),
        vis = if project.public { " &middot; public" } else { " &middot; private" },
        description = description_html,
        clone = clone_html,
    ))
    .into_response())
}


/// Live view: the board preview with named peer cursors / selections / ghost
/// segments overlaid from the same WebSocket the editors use.  Sign-in via the
/// session cookie; the board renders full-page so presence coordinates (nm) map
/// 1:1 onto the SVG's mm user space.
pub async fn live_page(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
    jar: CookieJar,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    let viewer = auth::user_from_jar(&state, &jar).await;

    if !project.public {
        let Some(user) = &viewer else { return Err(AppError::NotFound) };
        persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::NotFound)?;
    }

    // Live presence requires joining the doc, which requires a signed-in user
    // (any user may view public projects).
    let can_join = viewer.is_some();

    let docs = persist::project_documents(&state.pool, id).await?;
    let doc = docs
        .iter()
        .find(|d| d.doc_type == "kicad_pcb")
        .ok_or_else(|| AppError::BadRequest("project has no board to watch".into()))?;

    let join_note = if can_join {
        String::new()
    } else {
        format!(
            r#"<p class="muted"><a href="/auth/github/login?next=/p/{id}/live">Sign in</a>
               to see live cursors; without signing in this is a static preview.</p>"#
        )
    };

    Ok(Html(format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} live — KiCad Collaborative</title>{STYLE}
<style>
  body {{ max-width: 1100px; }}
  #stage {{ position: relative; background: #f4f1e6; border-radius: 8px; touch-action: none;
            overflow: hidden; }}
  #world {{ transform-origin: 0 0; position: relative; }}
  #world img, #world svg {{ display: block; width: 100%; height: auto; }}
  #overlay {{ position: absolute; inset: 0; pointer-events: none; }}
  #status {{ font-size: .85rem; opacity: .7; margin-top: 8px; }}
  .chip {{ display:inline-block; padding: 2px 8px; border-radius: 999px; background: #d9822b22; }}
  .chip.err {{ background: #c0392b22; }}
  #cmtPanel {{ position: absolute; display: none; background: #fff; color: #222;
              border: 1px solid #0003; border-radius: 10px; padding: 10px 12px;
              min-width: 260px; max-width: 340px; box-shadow: 0 6px 24px #0003;
              font-size: .88rem; z-index: 5; }}
  #cmtPanel .meta {{ opacity: .6; font-size: .78rem; }}
  #cmtPanel .cbody {{ margin: 2px 0 8px; white-space: pre-wrap; }}
  #cmtPanel textarea {{ width: 100%; box-sizing: border-box; }}
  #cmtPanel button {{ font-size: .82rem; }}
  #modeBtn {{ margin-top: 8px; }}
</style></head><body>
<p><a href="/p/{id}" class="muted">&larr; {name}</a></p>
<div id="stage">
  <div id="world">
    <img id="base" alt="Board" src="/api/projects/{id}/preview.svg?fit=false" draggable="false">
    <svg id="overlay"><g id="peersG" style="pointer-events:none"></g><g id="selG"></g><g id="dragG"></g><g id="cmtG" style="pointer-events:auto"></g></svg>
  </div>
  <div id="cmtPanel"></div>
</div>
<div id="status">connecting&hellip;</div>
<p><button class="btn secondary" id="modeBtn">&#128172; Add comment</button>
<span class="muted" style="font-size:.82rem"> &nbsp; scroll to zoom &middot; right-drag to pan &middot;
click a part to select &middot; drag to move &middot; R rotates &middot; Del deletes &middot; Esc clears</span></p>
{join_note}
<script>
const PROJECT_ID = "{id}";
const DOC_ID = "{doc_id}";
const CAN_JOIN = {can_join};
const NS = "http://www.w3.org/2000/svg";
const stage = document.getElementById("stage");
const world = document.getElementById("world");
const overlay = document.getElementById("overlay");
const peersG = document.getElementById("peersG");
const selG = document.getElementById("selG");
const dragG = document.getElementById("dragG");
const statusEl = document.getElementById("status");
let ws = null;
let editsSeen = 0;
let opN = 0;
let viewOnly = false;
let vb = [0, 0, 297, 210];
let items = [];            // footprints: {{id, lib, x, y, rot}} in nm / degrees
let selected = null;       // a footprint from `items`
let drag = null;           // {{fp, curMm: [x, y], moved}}
let lastPresence = 0;

// ---- zoom & pan ----
let zoom = 1, panX = 0, panY = 0;

function applyView() {{
  world.style.transform = `translate(${{panX}}px, ${{panY}}px) scale(${{zoom}})`;
  drawComments();
  drawSelection();
}}

stage.addEventListener("wheel", (ev) => {{
  ev.preventDefault();
  const rect = stage.getBoundingClientRect();
  const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
  const factor = Math.pow(1.0018, -ev.deltaY);
  const next = Math.min(14, Math.max(0.6, zoom * factor));
  panX = cx - (cx - panX) * (next / zoom);
  panY = cy - (cy - panY) * (next / zoom);
  zoom = next;
  breakFollow();
  applyView();
}}, {{ passive: false }});

let followPeer = null;   // clientId being followed
let peerState = {{}};     // cumulative presence: clientId -> {{user, state}}

let stageW = 0;   // last known laid-out width (a hidden tab reads 0)

function knownStageW() {{
  const w = stage.getBoundingClientRect().width;
  if (w > 0) stageW = w;
  return stageW || 1100;
}}

function applyFollowWeb(peers) {{
  if (!followPeer) return;
  const entry = peers[followPeer];
  if (!entry) {{ followPeer = null; setStatus("&middot; stopped following (they left)"); return; }}
  const vp = (entry.state || {{}}).viewport;
  if (!vp || vp.length < 4 || vp[2] <= 0) return;
  const w = knownStageW();
  const xMm = vp[0] / 1e6, wMm = vp[2] / 1e6, yMm = vp[1] / 1e6;
  const nextZoom = Math.min(14, Math.max(0.6, vb[2] / wMm));
  zoom = nextZoom;
  panX = -((xMm - vb[0]) / vb[2]) * w * zoom;
  panY = -((yMm - vb[1]) / vb[3]) * (w * vb[3] / vb[2]) * zoom;
  suppressBreakout = true;
  applyView();
  suppressBreakout = false;
}}

let suppressBreakout = false;

function breakFollow(why) {{
  if (!followPeer || suppressBreakout) return;
  followPeer = null;
  setStatus("&middot; stopped following" + (why ? " (" + why + ")" : ""));
}}

let pan = null;
stage.addEventListener("contextmenu", (ev) => ev.preventDefault());
stage.addEventListener("pointerdown", (ev) => {{
  if (ev.button === 2 || ev.button === 1) {{
    pan = {{ x: ev.clientX - panX, y: ev.clientY - panY }};
    stage.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }}
}});
stage.addEventListener("pointermove", (ev) => {{
  if (pan) {{ panX = ev.clientX - pan.x; panY = ev.clientY - pan.y; breakFollow(); applyView(); }}
}});
stage.addEventListener("pointerup", (ev) => {{
  if (pan && (ev.button === 2 || ev.button === 1)) pan = null;
}});

// ---- live render refresh: previews are pushed by the editors; once ops have
// happened, poll the render until a fresh one loads. ----
let renderDirtySince = 0;
let renderTimer = 0;

function scheduleRenderRefresh() {{
  renderDirtySince = Date.now();
  if (renderTimer) return;
  renderTimer = setInterval(() => {{
    if (Date.now() - renderDirtySince > 120000) {{ clearInterval(renderTimer); renderTimer = 0; return; }}
    const probe = new Image();
    probe.onload = () => {{
      document.getElementById("base").src = probe.src;
    }};
    probe.src = `/api/projects/{id}/preview.svg?fit=false&v=${{Date.now()}}`;
  }}, 8000);
}}

function setStatus(extra) {{
  const mode = viewOnly ? '<span class="chip err">view-only</span>'
             : items.length ? '<span class="chip">live editing enabled</span>' : "";
  const edits = editsSeen ? ` &middot; ${{editsSeen}} edit(s) since load` : "";
  statusEl.innerHTML = `live${{edits}} ${{mode}} ${{extra || ""}}`;
}}

async function setup() {{
  const text = await (await fetch(document.getElementById("base").src)).text();
  const m = text.match(/viewBox="([^"]+)"/);
  if (m) {{ vb = m[1].split(/\s+/).map(Number); overlay.setAttribute("viewBox", m[1]); }}
  if (!CAN_JOIN) {{ statusEl.textContent = "static preview (not signed in)"; return; }}

  fetch(`/api/projects/${{PROJECT_ID}}/board-items`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {{ if (j) {{ items = j.footprints || []; setStatus(); }} }})
    .catch(() => {{}});

  connect();
}}

let retries = 0;
function connect() {{
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${{proto}}://${{location.host}}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({{ type: "hello", proto: 1, token: "", clientId: "web-" + Math.random().toString(36).slice(2, 10), linkToken: null, client: "web" }}));
  ws.onclose = () => {{
    peersG.replaceChildren();
    const delay = Math.min(15000, 1000 * Math.pow(2, retries++));
    statusEl.textContent = `disconnected — reconnecting in ${{Math.round(delay / 1000)}}s`;
    setTimeout(connect, delay);
  }};
  ws.onmessage = (ev) => {{
    const msg = JSON.parse(ev.data);
    if (msg.type === "hello_ok") {{ retries = 0; ws.send(JSON.stringify({{ type: "join_doc", docId: DOC_ID }})); }}
    if (msg.type === "doc_info") {{
      peerState = {{}};
      setStatus(`&middot; ${{(msg.peers || []).length}} peer(s) here`);
    }}
    if (msg.type === "presence") {{
      // Presence is a DELTA: only changed peers arrive, null means gone.
      for (const [cid, entry] of Object.entries(msg.peers || {{}})) {{
        if (entry === null) delete peerState[cid];
        else peerState[cid] = entry;
      }}
      drawPeers(peerState);
      applyFollowWeb(peerState);
    }}
    if (msg.type === "peer_left" && msg.clientId) {{
      delete peerState[msg.clientId];
      drawPeers(peerState);
      applyFollowWeb(peerState);
    }}
    if (msg.type === "error" && msg.code === "permission_denied") {{
      viewOnly = true;
      drag = null; selected = null;
      dragG.replaceChildren(); selG.replaceChildren();
      setStatus();
    }}
    if (msg.type === "comment") noteCommentMsg(msg);
    if (msg.type === "op") {{ editsSeen++; noteRemoteOp(msg); setStatus(); scheduleRenderRefresh(); }}
    if (msg.type === "ops") {{ editsSeen += (msg.ops || []).length; setStatus(); scheduleRenderRefresh(); }}
  }};
}}

function noteRemoteOp(msg) {{
  for (const c of msg.changes || []) {{
    if (c.typeName !== "FOOTPRINT") continue;
    if (c.kind === "REMOVED") {{
      items = items.filter((f) => f.id !== c.id);
      if (selected && selected.id === c.id) {{ selected = null; drawSelection(); }}
      continue;
    }}
    const fp = items.find((f) => f.id === c.id);
    if (!fp || c.kind !== "MODIFIED") continue;
    for (const p of c.properties || []) {{
      if (p.name === "Position X" && p.after) fp.x = p.after.v;
      if (p.name === "Position Y" && p.after) fp.y = p.after.v;
      if (p.name === "Orientation" && p.after) fp.rot = p.after.v;
    }}
  }}
  drawSelection();
}}

function worldMm(ev) {{
  const rect = world.getBoundingClientRect();
  return [
    vb[0] + ((ev.clientX - rect.left) / rect.width) * vb[2],
    vb[1] + ((ev.clientY - rect.top) / rect.height) * vb[3],
  ];
}}
const stageMm = worldMm;

function pxPerMm() {{
  const rect = world.getBoundingClientRect();
  return rect.width > 0 ? rect.width / vb[2] : 4;
}}

function sendPresence(mmPos, ghostSegs) {{
  const now = Date.now();
  if (!ws || ws.readyState !== 1 || (now - lastPresence < 80 && !ghostSegs)) return;
  lastPresence = now;
  const state = {{ cursor: [Math.round(mmPos[0] * 1e6), Math.round(mmPos[1] * 1e6)] }};
  if (ghostSegs) state.ghost = ghostSegs;
  ws.send(JSON.stringify({{ type: "presence", docId: DOC_ID, state }}));
}}

function sendOp(changes) {{
  ws.send(JSON.stringify({{ type: "op", docId: DOC_ID, clientOpId: `web:${{++opN}}`,
                            baseSeq: null, changes }}));
  editsSeen++;
  scheduleRenderRefresh();
}}

function nearestFootprint(x, y, radiusMm) {{
  let best = null, bestD = radiusMm;
  for (const fp of items) {{
    const d = Math.hypot(fp.x / 1e6 - x, fp.y / 1e6 - y);
    if (d < bestD) {{ best = fp; bestD = d; }}
  }}
  return best;
}}

function drawSelection() {{
  selG.replaceChildren();
  if (!selected) return;
  const s = pxPerMm();
  const x = selected.x / 1e6, y = selected.y / 1e6;
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", x); ring.setAttribute("cy", y); ring.setAttribute("r", 10 / s);
  ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#d9822b");
  ring.setAttribute("stroke-width", 2.5 / s); ring.setAttribute("stroke-dasharray", `${{5 / s}} ${{3 / s}}`);
  selG.appendChild(ring);
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", x + 12 / s); label.setAttribute("y", y - 12 / s);
  label.setAttribute("fill", "#d9822b"); label.setAttribute("font-size", 12 / s);
  label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "white");
  label.setAttribute("stroke-width", 3 / s);
  label.textContent = `${{selected.lib.split(":").pop()}} (${{Math.round(selected.rot || 0)}}\u00b0)`;
  selG.appendChild(label);
}}

document.addEventListener("keydown", (ev) => {{
  if (ev.target.tagName === "TEXTAREA" || ev.target.tagName === "INPUT") return;
  if (ev.key === "Escape") {{
    drag = null; selected = null;
    dragG.replaceChildren(); drawSelection();
    return;
  }}
  if (!selected || viewOnly || !ws || ws.readyState !== 1) return;
  if (ev.key === "r" || ev.key === "R") {{
    const before = selected.rot || 0;
    const after = (before + 90) % 360;
    sendOp([{{ id: selected.id, typeName: "FOOTPRINT", kind: "MODIFIED", properties: [
      {{ name: "Orientation", before: {{ type: "double", v: before }}, after: {{ type: "double", v: after }} }},
    ] }}]);
    selected.rot = after;
    drawSelection();
    setStatus("&middot; rotated");
  }}
  if (ev.key === "Delete" || ev.key === "Backspace") {{
    sendOp([{{ id: selected.id, typeName: "FOOTPRINT", kind: "REMOVED", properties: [] }}]);
    items = items.filter((f) => f.id !== selected.id);
    selected = null;
    drawSelection();
    setStatus("&middot; deleted");
  }}
}});

function moveOp(fp, nxNm, nyNm) {{
  return {{ id: fp.id, typeName: "FOOTPRINT", kind: "MODIFIED", properties: [
    {{ name: "Position X", before: {{ type: "int", v: fp.x }}, after: {{ type: "int", v: nxNm }} }},
    {{ name: "Position Y", before: {{ type: "int", v: fp.y }}, after: {{ type: "int", v: nyNm }} }},
  ] }};
}}

let lastLiveMove = 0;

stage.addEventListener("pointerdown", (ev) => {{
  if (ev.button !== 0) return;   // pan handles the other buttons
  if (viewOnly || !items.length || !ws || ws.readyState !== 1 || commentMode) return;
  const [x, y] = worldMm(ev);
  const best = nearestFootprint(x, y, 5 / Math.max(1, zoom * 0.6));
  if (!best) {{ selected = null; drawSelection(); return; }}
  drag = {{ fp: best, startMm: [x, y], curMm: [x, y], moved: false }};
  stage.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}});

stage.addEventListener("pointermove", (ev) => {{
  const mm = worldMm(ev);
  if (!drag) {{ sendPresence(mm); return; }}
  drag.curMm = mm;
  if (!drag.moved && Math.hypot(mm[0] - drag.startMm[0], mm[1] - drag.startMm[1]) > 0.4) drag.moved = true;
  if (!drag.moved) return;
  drawDrag();

  // Figma-live: stream the position while dragging, throttled — peers see the
  // part move, not jump on release (LWW makes the stream safe).
  const now = Date.now();
  if (now - lastLiveMove > 150) {{
    lastLiveMove = now;
    sendOp([moveOp(drag.fp, Math.round(mm[0] * 1e6), Math.round(mm[1] * 1e6))]);
  }}

  // Ghost box for the desktops' overlay too.
  const s = 4;   // half-size mm
  const g = [[mm[0]-s, mm[1]-s, mm[0]+s, mm[1]-s], [mm[0]+s, mm[1]-s, mm[0]+s, mm[1]+s],
             [mm[0]+s, mm[1]+s, mm[0]-s, mm[1]+s], [mm[0]-s, mm[1]+s, mm[0]-s, mm[1]-s]]
    .map((seg) => [Math.round(seg[0]*1e6), Math.round(seg[1]*1e6), Math.round(seg[2]*1e6), Math.round(seg[3]*1e6), 100000]);
  sendPresence(mm, g);
}});

stage.addEventListener("pointerup", (ev) => {{
  if (ev.button !== 0 || !drag) return;
  const fp = drag.fp;
  const wasMoved = drag.moved;
  const nx = Math.round(drag.curMm[0] * 1e6);
  const ny = Math.round(drag.curMm[1] * 1e6);
  drag = null;
  dragG.replaceChildren();
  sendPresence([nx / 1e6, ny / 1e6], []);   // clear the ghost

  if (!wasMoved) {{
    selected = fp;
    drawSelection();
    return;
  }}

  if (nx !== fp.x || ny !== fp.y)
    sendOp([moveOp(fp, nx, ny)]);

  fp.x = nx; fp.y = ny;
  if (selected && selected.id === fp.id) drawSelection();
  setStatus("&middot; move sent");
}});

function drawDrag() {{
  dragG.replaceChildren();
  if (!drag) return;
  const s = pxPerMm();
  const [x, y] = drag.curMm;
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", drag.fp.x / 1e6); line.setAttribute("y1", drag.fp.y / 1e6);
  line.setAttribute("x2", x); line.setAttribute("y2", y);
  line.setAttribute("stroke", "#d9822b"); line.setAttribute("stroke-dasharray", `${{4 / s}} ${{3 / s}}`);
  line.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(line);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4 / s);
  dot.setAttribute("fill", "none"); dot.setAttribute("stroke", "#d9822b");
  dot.setAttribute("stroke-width", 1.5 / s);
  dragG.appendChild(dot);
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", x + 6 / s); label.setAttribute("y", y - 6 / s);
  label.setAttribute("fill", "#d9822b"); label.setAttribute("font-size", 12 / s);
  label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "white");
  label.setAttribute("stroke-width", 3 / s);
  label.textContent = drag.fp.lib.split(":").pop();
  dragG.appendChild(label);
}}

function drawPeers(peers) {{
  peersG.replaceChildren();
  const s = pxPerMm();
  const mm = (nm) => nm / 1e6;

  for (const [cid, p] of Object.entries(peers)) {{
    const st = p.state || {{}};
    const color = (p.user && p.user.color) || "#4477ee";
    const name = (p.user && (p.user.name || p.user.login)) || "peer";

    for (const g of st.ghost || []) {{
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(g[0])); line.setAttribute("y1", mm(g[1]));
      line.setAttribute("x2", mm(g[2])); line.setAttribute("y2", mm(g[3]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", Math.max(mm(g[4] || 0), 2 / s));
      line.setAttribute("stroke-linecap", "round");
      peersG.appendChild(line);
    }}

    for (const b of st.boxes || []) {{
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mm(b[0])); rect.setAttribute("y", mm(b[1]));
      rect.setAttribute("width", mm(b[2])); rect.setAttribute("height", mm(b[3]));
      rect.setAttribute("fill", color); rect.setAttribute("fill-opacity", "0.18");
      rect.setAttribute("stroke", color); rect.setAttribute("stroke-width", 3 / s);
      peersG.appendChild(rect);
    }}

    if (Array.isArray(st.cursor)) {{
      const x = mm(st.cursor[0]), y = mm(st.cursor[1]), t = 14 / s;
      const tri = document.createElementNS(NS, "path");
      tri.setAttribute("d", `M ${{x}} ${{y}} L ${{x + 0.38 * t}} ${{y + t}} L ${{x + t}} ${{y + 0.38 * t}} Z`);
      tri.setAttribute("fill", color); tri.setAttribute("stroke", "white");
      tri.setAttribute("stroke-width", 1 / s);
      peersG.appendChild(tri);

      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", x + 1.1 * t); label.setAttribute("y", y + 1.7 * t);
      label.setAttribute("fill", color); label.setAttribute("font-size", 12 / s);
      label.setAttribute("font-family", "system-ui, sans-serif");
      label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "white");
      label.setAttribute("stroke-width", 3 / s);
      label.textContent = followPeer === cid ? name + " \u2714 following" : name;
      label.style.pointerEvents = "auto";
      label.style.cursor = "pointer";
      label.addEventListener("click", (ev) => {{
        ev.stopPropagation();
        if (followPeer === cid) {{ followPeer = null; setStatus("&middot; stopped following"); }}
        else {{ followPeer = cid; setStatus("&middot; following " + name + " — zoom/pan to stop"); }}
      }});
      peersG.appendChild(label);
    }}
  }}
}}

// ---- comments ----
const cmtG = document.getElementById("cmtG");
const cmtPanel = document.getElementById("cmtPanel");
const modeBtn = document.getElementById("modeBtn");
let comments = [];            // roots + replies, server order
let commentMode = false;
let openThread = null;        // root comment id whose panel is open

async function loadComments() {{
  try {{
    const r = await fetch(`/api/docs/${{DOC_ID}}/comments`);
    if (r.ok) {{ comments = (await r.json()).comments || []; drawComments(); }}
  }} catch (e) {{}}
}}

function noteCommentMsg(msg) {{
  const c = msg.comment || {{}};
  const inner = c.comment || {{}};
  if (c.action === "deleted") comments = comments.filter((x) => x.id !== inner.id && x.parentId !== inner.id);
  else if (c.action === "updated") comments = comments.map((x) => (x.id === inner.id ? inner : x));
  else if (c.action === "added" && !comments.some((x) => x.id === inner.id)) comments.push(inner);
  drawComments();
  if (openThread !== null) showThread(openThread);
}}

function drawComments() {{
  cmtG.replaceChildren();
  const s = pxPerMm();
  for (const c of comments) {{
    if (c.parentId) continue;
    const x = c.x / 1e6, y = c.y / 1e6, r = 9 / s;
    const pin = document.createElementNS(NS, "g");
    pin.setAttribute("cursor", "pointer");
    const bubble = document.createElementNS(NS, "circle");
    bubble.setAttribute("cx", x); bubble.setAttribute("cy", y); bubble.setAttribute("r", r);
    bubble.setAttribute("fill", c.resolved ? "#9aa" : "#d9822b");
    bubble.setAttribute("stroke", "white"); bubble.setAttribute("stroke-width", 1.5 / s);
    bubble.setAttribute("fill-opacity", c.resolved ? "0.55" : "0.92");
    pin.appendChild(bubble);
    const glyph = document.createElementNS(NS, "text");
    glyph.setAttribute("x", x); glyph.setAttribute("y", y + 3.2 / s);
    glyph.setAttribute("text-anchor", "middle"); glyph.setAttribute("fill", "white");
    glyph.setAttribute("font-size", 10 / s); glyph.setAttribute("font-family", "system-ui, sans-serif");
    glyph.textContent = String(comments.filter((x) => x.id === c.id || x.parentId === c.id).length);
    pin.appendChild(glyph);
    pin.addEventListener("pointerdown", (ev) => {{ ev.stopPropagation(); }});
    pin.addEventListener("click", (ev) => {{ ev.stopPropagation(); showThread(c.id); }});
    cmtG.appendChild(pin);
  }}
}}

function esc(t) {{
  const d = document.createElement("span"); d.textContent = t; return d.innerHTML;
}}

function panelAt(xNm, yNm) {{
  const rect = stage.getBoundingClientRect();
  const px = ((xNm / 1e6 - vb[0]) / vb[2]) * rect.width;
  const py = ((yNm / 1e6 - vb[1]) / vb[3]) * rect.height;
  cmtPanel.style.left = Math.min(px + 14, rect.width - 350) + "px";
  cmtPanel.style.top = Math.max(0, py - 10) + "px";
  cmtPanel.style.display = "block";
}}

function showThread(rootId) {{
  const root = comments.find((c) => c.id === rootId);
  if (!root) {{ cmtPanel.style.display = "none"; openThread = null; return; }}
  openThread = rootId;
  const thread = [root, ...comments.filter((c) => c.parentId === rootId)];
  cmtPanel.innerHTML = thread.map((c) =>
    `<div class="meta">${{esc(c.authorLogin)}} &middot; ${{c.createdAt.slice(0, 16).replace("T", " ")}}</div>
     <div class="cbody">${{esc(c.body)}}</div>`).join("")
    + (CAN_JOIN ? `<textarea id="replyText" rows="2" placeholder="Reply&hellip;"></textarea>
       <p><button class="btn" id="replyBtn">Reply</button>
       <button class="btn secondary" id="resolveBtn">${{root.resolved ? "Reopen" : "Resolve"}}</button>
       <button class="btn secondary" id="closeBtn">Close</button></p>` :
       `<p><button class="btn secondary" id="closeBtn">Close</button></p>`);
  panelAt(root.x, root.y);
  document.getElementById("closeBtn").onclick = () => {{ cmtPanel.style.display = "none"; openThread = null; }};
  const replyBtn = document.getElementById("replyBtn");
  if (replyBtn) replyBtn.onclick = async () => {{
    const text = document.getElementById("replyText").value.trim();
    if (!text) return;
    await fetch(`/api/docs/${{DOC_ID}}/comments`, {{ method: "POST",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{ body: text, parentId: rootId }}) }});
  }};
  const resolveBtn = document.getElementById("resolveBtn");
  if (resolveBtn) resolveBtn.onclick = async () => {{
    await fetch(`/api/comments/${{rootId}}`, {{ method: "PATCH",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{ resolved: !root.resolved }}) }});
  }};
}}

modeBtn.onclick = () => {{
  commentMode = !commentMode;
  modeBtn.textContent = commentMode ? "\u2715 Click the board to place your comment" : "\ud83d\udcac Add comment";
}};

stage.addEventListener("click", (ev) => {{
  if (!commentMode) return;
  commentMode = false;
  modeBtn.textContent = "\ud83d\udcac Add comment";
  const [x, y] = stageMm(ev);
  const xNm = Math.round(x * 1e6), yNm = Math.round(y * 1e6);
  openThread = null;
  cmtPanel.innerHTML = `<div class="meta">New comment</div>
    <textarea id="newText" rows="3" placeholder="Say something about this spot&hellip;"></textarea>
    <p><button class="btn" id="postBtn">Post</button>
    <button class="btn secondary" id="cancelBtn">Cancel</button></p>`;
  panelAt(xNm, yNm);
  document.getElementById("newText").focus();
  document.getElementById("cancelBtn").onclick = () => cmtPanel.style.display = "none";
  document.getElementById("postBtn").onclick = async () => {{
    const text = document.getElementById("newText").value.trim();
    if (!text) return;
    cmtPanel.style.display = "none";
    await fetch(`/api/docs/${{DOC_ID}}/comments`, {{ method: "POST",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{ body: text, x: xNm, y: yNm }}) }});
  }};
}});

setup();
loadComments();
</script>
</body></html>"##,
        id = id,
        name = esc(&project.name),
        doc_id = doc.id,
        can_join = can_join,
        join_note = join_note,
    ))
    .into_response())
}
