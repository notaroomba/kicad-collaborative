use axum::extract::{Path, State};
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
        token = esc(&token),
        url = esc(&url),
        signin = signin_html,
    );
    Ok(Html(html).into_response())
}


/// The public gallery: opt-in projects, with previews when rendering is enabled.
pub async fn gallery_page(State(state): State<AppState>) -> AppResult<Response> {
    let projects = persist::list_public_projects(&state.pool, 100).await?;
    let previews = state.cfg.kicad_cli.is_some();

    let cards: String = if projects.is_empty() {
        r#"<p class="muted">Nothing here yet. Make a project public from
           <code>PATCH /api/projects/{id} {"public": true}</code> (a toggle in the
           Online Projects dialog is on the roadmap) and it shows up for everyone.</p>"#
            .to_string()
    } else {
        projects
            .iter()
            .map(|(p, owner)| {
                let img = if previews {
                    format!(
                        r#"<a href="/p/{id}"><img loading="lazy" alt="Board preview of {name}"
                             src="/api/projects/{id}/preview.svg"></a>"#,
                        id = p.id,
                        name = esc(&p.name)
                    )
                } else {
                    String::new()
                };
                format!(
                    r#"<div class="tile">{img}
  <div class="tmeta"><a href="/p/{id}"><b>{name}</b></a>
  <span class="muted">by {owner}</span></div></div>"#,
                    id = p.id,
                    name = esc(&p.name),
                    owner = esc(owner),
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
    let docs = persist::project_documents(&state.pool, id).await?;

    let doc_rows: String = docs
        .iter()
        .map(|d| format!("<li><code>{}</code> <span class=\"muted\">{}</span></li>",
                         esc(&d.path), esc(&d.doc_type)))
        .collect();

    let preview = if state.cfg.kicad_cli.is_some()
        && docs.iter().any(|d| d.doc_type == "kicad_pcb")
    {
        format!(
            r#"<p><img style="width:100%;background:#f4f1e6;border-radius:8px;padding:10px;box-sizing:border-box"
                 alt="Board preview" src="/api/projects/{id}/preview.svg"></p>
<p><a class="btn secondary" href="/p/{id}/live">Watch live</a></p>"#
        )
    } else {
        String::new()
    };

    Ok(Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} — KiCad Collaborative</title>{STYLE}<style>body {{ max-width: 860px; }}</style></head><body>
<p><a href="/gallery" class="muted">&larr; Gallery</a></p>
<div class="card">
  <h1>{name}</h1>
  <p class="muted">by <b>{owner}</b>{vis}</p>
  {preview}
  <ul>{doc_rows}</ul>
  <p class="muted">To edit, join from KiCad: <b>File &rarr; Online Projects…</b></p>
</div></body></html>"#,
        name = esc(&project.name),
        owner = esc(&owner_login),
        vis = if project.public { " &middot; public" } else { " &middot; private" },
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
  #stage {{ position: relative; background: #f4f1e6; border-radius: 8px; }}
  #stage img, #stage svg {{ display: block; width: 100%; height: auto; }}
  #overlay {{ position: absolute; inset: 0; pointer-events: none; }}
  #status {{ font-size: .85rem; opacity: .7; margin-top: 8px; }}
  .chip {{ display:inline-block; padding: 2px 8px; border-radius: 999px; background: #d9822b22; }}
</style></head><body>
<p><a href="/p/{id}" class="muted">&larr; {name}</a></p>
<div id="stage">
  <img id="base" alt="Board" src="/api/projects/{id}/preview.svg?fit=false">
  <svg id="overlay"></svg>
</div>
<div id="status">connecting&hellip;</div>
{join_note}
<script>
const DOC_ID = "{doc_id}";
const CAN_JOIN = {can_join};
const NS = "http://www.w3.org/2000/svg";
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
let editsSeen = 0;

async function setup() {{
  // Copy the base SVG's viewBox so overlay coordinates line up; presence
  // coordinates are nanometres, the SVG user space is millimetres.
  const text = await (await fetch(document.getElementById("base").src)).text();
  const m = text.match(/viewBox="([^"]+)"/);
  if (m) overlay.setAttribute("viewBox", m[1]);
  if (!CAN_JOIN) {{ statusEl.textContent = "static preview (not signed in)"; return; }}

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${{proto}}://${{location.host}}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({{ type: "hello", proto: 1, token: "", clientId: "web-" + Math.random().toString(36).slice(2, 10) }}));
  ws.onclose = () => statusEl.textContent = "disconnected — reload to reconnect";
  ws.onmessage = (ev) => {{
    const msg = JSON.parse(ev.data);
    if (msg.type === "hello_ok") ws.send(JSON.stringify({{ type: "join_doc", docId: DOC_ID }}));
    if (msg.type === "doc_info") statusEl.textContent = `live &middot; ${{(msg.peers || []).length}} peer(s) here`;
    if (msg.type === "presence") drawPeers(msg.peers || {{}});
    if (msg.type === "op" || msg.type === "ops") {{
      editsSeen++;
      statusEl.innerHTML = `live &middot; <span class="chip">${{editsSeen}} edit(s) since load — reload to refresh the render</span>`;
    }}
  }};
}}

function drawPeers(peers) {{
  overlay.replaceChildren();
  const vb = (overlay.getAttribute("viewBox") || "0 0 297 210").split(/\s+/).map(Number);
  const pxPerMm = overlay.clientWidth > 0 ? overlay.clientWidth / vb[2] : 4;
  const mm = (nm) => nm / 1e6;

  for (const p of Object.values(peers)) {{
    const st = p.state || {{}};
    const color = (p.user && p.user.color) || "#4477ee";
    const name = (p.user && (p.user.name || p.user.login)) || "peer";

    for (const g of st.ghost || []) {{
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", mm(g[0])); line.setAttribute("y1", mm(g[1]));
      line.setAttribute("x2", mm(g[2])); line.setAttribute("y2", mm(g[3]));
      line.setAttribute("stroke", color); line.setAttribute("stroke-opacity", "0.55");
      line.setAttribute("stroke-width", Math.max(mm(g[4] || 0), 2 / pxPerMm));
      line.setAttribute("stroke-linecap", "round");
      overlay.appendChild(line);
    }}

    for (const b of st.boxes || []) {{
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mm(b[0])); rect.setAttribute("y", mm(b[1]));
      rect.setAttribute("width", mm(b[2])); rect.setAttribute("height", mm(b[3]));
      rect.setAttribute("fill", "none"); rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", 1.5 / pxPerMm);
      overlay.appendChild(rect);
    }}

    if (Array.isArray(st.cursor)) {{
      const x = mm(st.cursor[0]), y = mm(st.cursor[1]), s = 14 / pxPerMm;
      const tri = document.createElementNS(NS, "path");
      tri.setAttribute("d", `M ${{x}} ${{y}} L ${{x + 0.38 * s}} ${{y + s}} L ${{x + s}} ${{y + 0.38 * s}} Z`);
      tri.setAttribute("fill", color); tri.setAttribute("stroke", "white");
      tri.setAttribute("stroke-width", 1 / pxPerMm);
      overlay.appendChild(tri);

      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", x + 1.1 * s); label.setAttribute("y", y + 1.7 * s);
      label.setAttribute("fill", color); label.setAttribute("font-size", 12 / pxPerMm);
      label.setAttribute("font-family", "system-ui, sans-serif");
      label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "white");
      label.setAttribute("stroke-width", 3 / pxPerMm);
      label.textContent = name;
      overlay.appendChild(label);
    }}
  }}
}}

setup();
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
