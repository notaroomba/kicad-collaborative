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
