//! Junction's GitHub App: repository access limited to the repositories a person picks.
//!
//! Sign-in stays on the OAuth app (identity and e-mail only).  Repository access used to
//! be that same OAuth app asked for the `repo` scope, which reaches every repository the
//! person has, private ones included.  A GitHub App instead is installed on chosen
//! repositories with two permissions, Contents (read and write) and Pull requests, plus
//! the Metadata every app has; its user tokens see only those repositories and expire
//! after eight hours, so each is stored with its refresh token.
//!
//!   /admin/github-app          an administrator registers the app from a manifest: one
//!                              press on GitHub, and GitHub hands the app's id, client
//!                              secret and private key straight back to this server
//!   /auth/github/connect       (auth.rs) authorize the app for a signed-in person, then
//!                              send them to install it if it is not installed anywhere
//!   /auth/github/install       pick (or change) the repositories it may see
//!   /auth/github/installed     GitHub's setup URL: back to the page they came from
//!
//! A person still holding an old `repo` token keeps syncing with it until they switch;
//! switching revokes that grant on GitHub.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::{self, pending_put, pending_take, urlencode, PendingConnect};
use crate::error::{AppError, AppResult};
use crate::github::{seal, unseal_str, Grant};
use crate::pages::esc;
use crate::AppState;

const KIND_MANIFEST: &str = "app-manifest";
const KIND_INSTALL: &str = "app-install";
const UA: &str = "junction-server";

/// The app's public identity and OAuth client.
#[derive(Clone)]
pub struct AppCreds {
    pub slug: String,
    pub name: String,
    pub html_url: String,
    pub client_id: String,
    pub client_secret: String,
}

/// The registered app: `GITHUB_APP_SLUG` + `GITHUB_APP_CLIENT_ID` + `GITHUB_APP_CLIENT_SECRET`
/// when set (for a server whose app was made by hand), otherwise the one registered from
/// /admin/github-app.
pub async fn creds(state: &AppState) -> AppResult<Option<AppCreds>> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let (Some(slug), Some(client_id), Some(client_secret)) =
        (env("GITHUB_APP_SLUG"), env("GITHUB_APP_CLIENT_ID"), env("GITHUB_APP_CLIENT_SECRET"))
    {
        return Ok(Some(AppCreds {
            html_url: format!("{}/apps/{slug}", state.cfg.github_web_url),
            name: env("GITHUB_APP_NAME").unwrap_or_else(|| slug.clone()),
            slug,
            client_id,
            client_secret,
        }));
    }
    let row = sqlx::query("SELECT slug, name, html_url, client_id, client_secret FROM github_app WHERE id = 1")
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let Some(client_secret) = unseal_str(state, &row.get::<Vec<u8>, _>("client_secret")) else {
        tracing::warn!("github app: client secret sealed under another JWT_SECRET; register the app again");
        return Ok(None);
    };
    Ok(Some(AppCreds {
        slug: row.get("slug"),
        name: row.get("name"),
        html_url: row.get("html_url"),
        client_id: row.get("client_id"),
        client_secret,
    }))
}

fn http() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(UA)
        .build()
        .map_err(|e| anyhow::anyhow!("http client: {e}"))?)
}

/// Where to install the app (or change its repositories), carrying a state that brings
/// the browser back to `return_to` afterwards.
pub async fn install_url(state: &AppState, app: &AppCreds, return_to: &str) -> AppResult<String> {
    let key = auth::random_token();
    pending_put(state, KIND_INSTALL, &key, &json!({ "returnTo": return_to })).await?;
    Ok(format!(
        "{}/apps/{}/installations/new?state={}",
        state.cfg.github_web_url,
        urlencode(&app.slug),
        urlencode(&key)
    ))
}

// ------------------------------------------------------------------ user tokens

#[derive(Deserialize, Default)]
pub struct TokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub refresh_token_expires_in: Option<i64>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

async fn token_request(state: &AppState, app: &AppCreds, form: &[(&str, &str)]) -> AppResult<TokenResponse> {
    let mut all = vec![("client_id", app.client_id.as_str()), ("client_secret", app.client_secret.as_str())];
    all.extend_from_slice(form);
    http()?
        .post(format!("{}/login/oauth/access_token", state.cfg.github_web_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&all)
        .send()
        .await
        .map_err(|_| AppError::Api(StatusCode::BAD_GATEWAY, "github_unreachable", "GitHub could not be reached.".into()))?
        .json()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("github token response invalid: {e}")))
}

async fn store_tokens(
    exec: impl sqlx::PgExecutor<'_>,
    state: &AppState,
    user_id: i64,
    access: &str,
    t: &TokenResponse,
) -> AppResult<()> {
    let refresh = t.refresh_token.as_deref().map(|r| seal(state, r.as_bytes())).transpose()?;
    sqlx::query(
        "INSERT INTO github_tokens (user_id, token, scopes, kind, refresh, expires_at, refresh_expires_at)
         VALUES ($1, $2, '', 'app', $3,
                 now() + make_interval(secs => $4::float8), now() + make_interval(secs => $5::float8))
         ON CONFLICT (user_id) DO UPDATE
           SET token = EXCLUDED.token, scopes = '', kind = 'app', refresh = EXCLUDED.refresh,
               expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
               updated_at = now()",
    )
    .bind(user_id)
    .bind(seal(state, access.as_bytes())?)
    .bind(refresh)
    // A token that does not expire (the app opted out of expiry) has no times.
    .bind(t.expires_in.map(|s| s as f64))
    .bind(t.refresh_token_expires_in.map(|s| s as f64))
    .execute(exec)
    .await?;
    Ok(())
}

/// Swap an expiring app token for a fresh one.  The row is locked while GitHub answers:
/// a refresh token works once, so two requests refreshing together would otherwise
/// spend it twice and lose the grant.
pub async fn refresh(state: &AppState, user_id: i64) -> AppResult<Option<Grant>> {
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT token, refresh, kind, expires_at < now() + interval '5 minutes' AS stale
         FROM github_tokens WHERE user_id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let current = unseal_str(state, &row.get::<Vec<u8>, _>("token"));
    let grant = |token: String| Grant { token, scopes: String::new(), kind: "app".into() };
    if !row.get::<Option<bool>, _>("stale").unwrap_or(false) {
        tx.commit().await?;
        return Ok(current.map(grant)); // another request refreshed it meanwhile
    }
    let refresh_token = row.get::<Option<Vec<u8>>, _>("refresh").and_then(|b| unseal_str(state, &b));
    let app = creds(state).await?;
    let (Some(refresh_token), Some(app)) = (refresh_token, app) else {
        sqlx::query("DELETE FROM github_tokens WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    };
    let t = token_request(state, &app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh_token)]).await?;
    let Some(access) = t.access_token.clone() else {
        // bad_refresh_token: expired (six months unused) or the person revoked the app.
        tracing::info!("github app: refresh refused for user {user_id}: {:?}", t.error);
        sqlx::query("DELETE FROM github_tokens WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    };
    store_tokens(&mut *tx, state, user_id, &access, &t).await?;
    tx.commit().await?;
    Ok(Some(grant(access)))
}

/// Revoke a person's authorization of an OAuth client on GitHub (best effort).  Used for
/// the old blanket `repo` grant when they switch, and for the app when they disconnect.
pub async fn revoke_grant(state: &AppState, client_id: &str, client_secret: &str, token: &str) {
    let Ok(http) = http() else { return };
    let r = http
        .delete(format!("{}/applications/{}/grant", state.cfg.github_api_url, urlencode(client_id)))
        .basic_auth(client_id, Some(client_secret))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .json(&json!({ "access_token": token }))
        .send()
        .await;
    match r {
        Ok(r) if r.status().is_success() || r.status() == StatusCode::NOT_FOUND => {}
        Ok(r) => tracing::warn!("github: revoking a grant answered {}", r.status()),
        Err(e) => tracing::warn!("github: revoking a grant failed: {e}"),
    }
}

/// Finish "connect repositories" for the app: exchange the code, check it is the same
/// GitHub account, store the token, retire any old `repo` grant, then send the person to
/// install the app if it is not installed anywhere they can see yet.
pub async fn finish_connect(state: &AppState, connect: PendingConnect, code: &str) -> AppResult<Response> {
    let app = creds(state).await?.ok_or(AppError::AuthNotConfigured)?;
    let t = token_request(state, &app, &[("code", code)]).await?;
    let Some(access) = t.access_token.clone() else {
        return Err(AppError::BadRequest(format!(
            "GitHub rejected the authorization code{}",
            t.error_description.map(|d| format!(": {d}")).unwrap_or_default()
        )));
    };
    let http = http()?;
    let api = &state.cfg.github_api_url;
    let me: Value = gh_get(&http, &access, &format!("{api}/user")).await?;
    if me["id"].as_i64() != Some(connect.github_id) {
        return Err(AppError::BadRequest(format!(
            "GitHub is signed in as {}, which is not the account you use here. \
             Switch accounts on github.com and connect again.",
            me["login"].as_str().unwrap_or("someone else")
        )));
    }

    // The old grant reached every repository; it is retired the moment the app replaces it.
    let old = crate::github::load_grant(state, connect.user_id).await.ok().flatten();
    store_tokens(&state.pool, state, connect.user_id, &access, &t).await?;
    if let Some(old) = old.filter(|g| g.kind == "oauth") {
        if let (Some(id), Some(secret)) = (&state.cfg.github_client_id, &state.cfg.github_client_secret) {
            revoke_grant(state, id, secret, &old.token).await;
        }
    }

    let installs: Value = gh_get(&http, &access, &format!("{api}/user/installations?per_page=100")).await?;
    if installs["total_count"].as_i64().unwrap_or(0) == 0 {
        let url = install_url(state, &app, &connect.return_to).await?;
        return Ok(Redirect::to(&url).into_response());
    }
    Ok(Redirect::to(&connect.return_to).into_response())
}

async fn gh_get(http: &reqwest::Client, token: &str, url: &str) -> AppResult<Value> {
    let r = http
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| AppError::Api(StatusCode::BAD_GATEWAY, "github_unreachable", "GitHub could not be reached.".into()))?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::Api(
            StatusCode::BAD_GATEWAY,
            "github_error",
            format!("GitHub answered {}: {}", status.as_u16(), v["message"].as_str().unwrap_or("")),
        ));
    }
    Ok(v)
}

#[derive(Deserialize)]
pub struct InstallQuery {
    pub next: Option<String>,
}

/// GET /auth/github/install: choose which repositories the app sees (installs it first
/// if needed).  GitHub's own page handles both.
pub async fn install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<InstallQuery>,
) -> AppResult<Response> {
    let app = creds(&state).await?.ok_or(AppError::AuthNotConfigured)?;
    let next = q.next.filter(|n| n.starts_with('/') && !n.starts_with("//")).unwrap_or_else(|| "/github".into());
    let origin = crate::oauth::origin_of(&state, &headers);
    let url = install_url(&state, &app, &format!("{origin}{next}")).await?;
    Ok(Redirect::to(&url).into_response())
}

#[derive(Deserialize)]
pub struct InstalledQuery {
    pub state: Option<String>,
}

/// GET /auth/github/installed: GitHub's setup URL, reached after installing the app or
/// changing its repositories.  Back to where the person started.
pub async fn installed(State(state): State<AppState>, Query(q): Query<InstalledQuery>) -> AppResult<Response> {
    let back = match q.state.as_deref() {
        Some(key) => pending_take::<Value>(&state, KIND_INSTALL, key)
            .await?
            .and_then(|v| v["returnTo"].as_str().map(str::to_string)),
        None => None,
    };
    Ok(Redirect::to(&back.unwrap_or_else(|| format!("{}/github", state.cfg.site_url))).into_response())
}

// ------------------------------------------------------------------ registration

/// The app GitHub is asked to create.  Only what repository sync uses: file contents
/// (read and write) and pull requests; Metadata is implied.  No webhook events.
fn manifest(state: &AppState, origin: &str, name: &str) -> Value {
    let public = state.cfg.public_url.trim_end_matches('/');
    json!({
        "name": name,
        "url": state.cfg.site_url,
        "description": "Sync Junction projects with the GitHub repositories you choose.",
        "hook_attributes": { "url": format!("{public}/api/github/webhook"), "active": false },
        "redirect_url": format!("{origin}/admin/github-app/created"),
        "callback_urls": [format!("{public}/auth/github/callback")],
        "setup_url": format!("{public}/auth/github/installed"),
        "setup_on_update": true,
        "request_oauth_on_install": false,
        "public": true,
        "default_permissions": { "contents": "write", "metadata": "read", "pull_requests": "write" },
        "default_events": [],
    })
}

#[derive(Serialize, Deserialize)]
struct PendingManifest {
    user_id: i64,
}

fn admin_only(state: &AppState, headers: &HeaderMap, msg: &str) -> Response {
    let host = crate::oauth::origin_of(state, headers);
    (
        StatusCode::FORBIDDEN,
        crate::oauth::page(
            "GitHub App",
            host.split("://").nth(1).unwrap_or(&host),
            &format!(r#"<div class="body"><h1>Administrators only</h1><p>{}</p></div>
<div class="actions"><a class="btn" href="/">Close</a></div>"#, esc(msg)),
        ),
    )
        .into_response()
}

/// GET /admin/github-app: show the registered app, or register one.
pub async fn admin_page(State(state): State<AppState>, headers: HeaderMap, jar: CookieJar) -> AppResult<Response> {
    let Some(user) = auth::user_from_jar(&state, &jar).await else {
        return Ok(Redirect::to("/auth/github/login?next=/admin/github-app").into_response());
    };
    if !crate::plugins::is_admin(&user.login) {
        return Ok(admin_only(&state, &headers, "Only the logins listed in KC_ADMINS can register this server's GitHub App."));
    }
    let origin = crate::oauth::origin_of(&state, &headers);
    let host = origin.split("://").nth(1).unwrap_or(&origin).to_string();
    let web = &state.cfg.github_web_url;

    let registered = creds(&state).await?;
    let body = if let Some(app) = &registered {
        format!(
            r#"<div class="body"><h1>{name} is registered</h1>
<p>People connect repositories through it and choose which ones it can see. It can read and change files and open pull requests in those repositories, and nothing else.</p>
<dl class="kv"><dt>App</dt><dd><a href="{url}" target="_blank" rel="noopener">{url}</a></dd>
<dt>Client ID</dt><dd><code>{cid}</code></dd></dl>
<p class="muted">Settings, permissions and keys live on GitHub: <a href="{web}/settings/apps/{slug}" target="_blank" rel="noopener">open the app's settings</a>.</p></div>
<div class="actions"><a class="btn" href="/github">Back to GitHub sync</a><a class="btn primary" href="/auth/github/install?next=/github">Install on your repositories</a></div>"#,
            name = esc(&app.name),
            url = esc(&app.html_url),
            cid = esc(&app.client_id),
            slug = esc(&app.slug),
        )
    } else {
        let key = auth::random_token();
        pending_put(&state, KIND_MANIFEST, &key, &PendingManifest { user_id: user.id }).await?;
        let m = manifest(&state, &origin, "Junction");
        format!(
            r#"<form id="reg" method="post" action="{web}/settings/apps/new?state={key}">
<div class="body"><h1>Register the GitHub App</h1>
<p>Repository sync will use a GitHub App instead of the <code>repo</code> scope, so people choose which repositories Junction can see. It asks for file contents (read and write) and pull requests only.</p>
<p>Press <b>Register on GitHub</b>, then <b>Create GitHub App</b> on GitHub's page. GitHub sends the app's keys straight back to this server; nothing has to be copied.</p>
<label class="field"><span>App name (must be unused on GitHub)</span><input id="appName" class="input" value="Junction" maxlength="34" required></label>
<label class="field"><span>Owner organization (leave empty for your own account)</span><input id="appOrg" class="input" placeholder="your account" maxlength="39"></label>
<input type="hidden" name="manifest" id="manifest" value="{m}">
</div>
<div class="actions"><a class="btn" href="/">Cancel</a><button class="btn primary" type="submit">Register on GitHub</button></div>
</form>
<style>.field{{display:grid;gap:4px;margin:0 0 var(--s-3)}}.field span{{font-size:var(--fs-sm);color:var(--ink-2)}}
.input{{min-height:var(--h-lg);padding:6px 10px;border-radius:var(--r-2);border:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit}}</style>
<script>
(function () {{
  var f = document.getElementById("reg"), m = document.getElementById("manifest");
  var base = {mj};
  f.addEventListener("submit", function () {{
    var name = document.getElementById("appName").value.trim() || "Junction";
    var org = document.getElementById("appOrg").value.trim();
    base.name = name; m.value = JSON.stringify(base);
    f.action = {webj} + (org ? "/organizations/" + encodeURIComponent(org) : "") + "/settings/apps/new?state={key}";
  }});
}})();
</script>"#,
            web = esc(web),
            key = esc(&key),
            m = esc(&m.to_string()),
            mj = m,
            webj = Value::String(web.clone()),
        )
    };
    Ok(crate::oauth::page("GitHub App", &host, &body).into_response())
}

#[derive(Deserialize)]
pub struct CreatedQuery {
    pub code: String,
    pub state: String,
}

/// GET /admin/github-app/created: GitHub made the app; collect its credentials.
pub async fn admin_created(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CreatedQuery>,
) -> AppResult<Response> {
    let pending: PendingManifest = pending_take(&state, KIND_MANIFEST, &q.state)
        .await?
        .ok_or_else(|| AppError::BadRequest("This registration link has expired. Start again from /admin/github-app.".into()))?;
    let admin = crate::persist::get_user(&state.pool, pending.user_id).await?;
    if !admin.as_ref().is_some_and(|u| crate::plugins::is_admin(&u.login)) {
        return Ok(admin_only(&state, &headers, "The person who started this registration is no longer an administrator."));
    }
    let r = http()?
        .post(format!("{}/app-manifests/{}/conversions", state.cfg.github_api_url, urlencode(&q.code)))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| AppError::Api(StatusCode::BAD_GATEWAY, "github_unreachable", "GitHub could not be reached.".into()))?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(AppError::BadRequest(format!(
            "GitHub would not hand over the new app ({}): {}",
            status.as_u16(),
            v["message"].as_str().unwrap_or("")
        )));
    }
    let need = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| AppError::Other(anyhow::anyhow!("github app conversion: no {k}")));
    let (slug, name, html_url, client_id, client_secret, pem) =
        (need("slug")?, need("name")?, need("html_url")?, need("client_id")?, need("client_secret")?, need("pem")?);
    let webhook = v["webhook_secret"].as_str().map(|w| seal(&state, w.as_bytes())).transpose()?;
    sqlx::query(
        "INSERT INTO github_app (id, app_id, slug, name, owner_login, html_url, client_id, client_secret,
                                 webhook_secret, private_key, created_by)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
           owner_login = EXCLUDED.owner_login, html_url = EXCLUDED.html_url, client_id = EXCLUDED.client_id,
           client_secret = EXCLUDED.client_secret, webhook_secret = EXCLUDED.webhook_secret,
           private_key = EXCLUDED.private_key, created_by = EXCLUDED.created_by, created_at = now()",
    )
    .bind(v["id"].as_i64().unwrap_or(0))
    .bind(&slug)
    .bind(&name)
    .bind(v["owner"]["login"].as_str().unwrap_or(""))
    .bind(&html_url)
    .bind(&client_id)
    .bind(seal(&state, client_secret.as_bytes())?)
    .bind(webhook)
    .bind(seal(&state, pem.as_bytes())?)
    .bind(pending.user_id)
    .execute(&state.pool)
    .await?;
    tracing::info!("github app registered: {slug} ({html_url})");
    Ok(Redirect::to("/admin/github-app").into_response())
}
