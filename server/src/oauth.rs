//! The OAuth 2.1 authorization server in front of the MCP endpoint (mcp.rs).
//!
//! An MCP client (an AI app, a coding agent, a connector of any vendor) is given
//! nothing but the endpoint's URL.  It is answered 401 with a pointer to the protected
//! resource metadata, reads the authorization server metadata from there, registers
//! itself (RFC 7591), and sends the person's browser to `/oauth/authorize` with a PKCE
//! challenge.  The person signs in the way they always do (GitHub), sees who is asking
//! and for what, and allows or cancels.  The client then swaps the one-time code for an
//! access token (an hour) and a refresh token (ninety days, single use).
//!
//! Tokens are random and opaque, stored as hashes, tied to the grant the person gave: the
//! Connected apps page (`/connect`) lists the grants and removing one ends that
//! application's access at once, on every replica.  The session JWT the browser and the
//! desktop app carry is deliberately not what is handed out here: it cannot be revoked.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::{self, AuthUser};
use crate::error::{AppError, AppResult};
use crate::pages::{esc, MARK, STYLE};
use crate::persist::User;
use crate::AppState;

const ACCESS_TTL_SECS: i64 = 3600;
/// An access key (made on `/connect` for a service that cannot sign in) lasts a year.
const KEY_TTL_SECS: i64 = 365 * 24 * 3600;
const KEY_CLIENT_PREFIX: &str = "kcm_key_";
const MAX_KEYS: i64 = 20;
const REFRESH_TTL_SECS: i64 = 90 * 24 * 3600;
/// A refresh token that was just spent may be presented once more (the reply that carried
/// its successor was lost on the way).  After this it is treated as stolen.
const REFRESH_GRACE_SECS: f64 = 60.0;
const ACCESS_PREFIX: &str = "kcm_at_";
const REFRESH_PREFIX: &str = "kcm_rt_";
const KIND_REQUEST: &str = "mcp_request";
const KIND_CODE: &str = "mcp_code";

pub const SCOPE_READ: &str = "read";
pub const SCOPE_WRITE: &str = "write";

// ------------------------------------------------------------------ which host is this

/// The origin a client reached us on, when it is one of ours: `PUBLIC_URL`, `SITE_URL` or
/// one of `ALLOWED_ORIGINS`.  Everything in the metadata must be on the host the client
/// started from (it checks), and the consent page needs the session cookie of that host.
pub fn origin_of(state: &AppState, headers: &HeaderMap) -> String {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .map(|h| h.split(',').next().unwrap_or(h).trim().to_ascii_lowercase());
    let known = [state.cfg.public_url.as_str(), state.cfg.site_url.as_str()]
        .into_iter()
        .chain(state.cfg.allowed_origins.iter().map(String::as_str));
    if let Some(host) = host {
        for origin in known {
            let o = origin.trim_end_matches('/');
            let their = o.split("://").nth(1).unwrap_or(o).to_ascii_lowercase();
            if their == host {
                return o.to_string();
            }
        }
    }
    state.cfg.public_url.trim_end_matches('/').to_string()
}

pub fn resource_metadata_url(state: &AppState, headers: &HeaderMap) -> String {
    format!("{}/.well-known/oauth-protected-resource/mcp", origin_of(state, headers))
}

/// `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728).
pub async fn protected_resource(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let origin = origin_of(&state, &headers);
    Json(json!({
        "resource": format!("{origin}/mcp"),
        "authorization_servers": [origin],
        "scopes_supported": [SCOPE_READ, SCOPE_WRITE],
        "bearer_methods_supported": ["header"],
        "resource_name": "Junction",
        "resource_documentation": format!("{origin}/connect"),
    }))
}

/// `GET /.well-known/oauth-authorization-server` (RFC 8414), also served as OpenID
/// discovery because some clients only look there.
pub async fn authorization_server(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let origin = origin_of(&state, &headers);
    Json(json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/oauth/authorize"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "revocation_endpoint": format!("{origin}/oauth/revoke"),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": [SCOPE_READ, SCOPE_WRITE],
        "service_documentation": format!("{origin}/connect"),
    }))
}

// ------------------------------------------------------------------ errors, the OAuth way

fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}

fn bad(code: &str, description: &str) -> Response {
    oauth_error(StatusCode::BAD_REQUEST, code, description)
}

/// A request body that is a form (what the specification says) or JSON (what some clients send).
fn body_params(headers: &HeaderMap, body: &Bytes) -> Option<std::collections::HashMap<String, String>> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("json"));
    if is_json || body.first() == Some(&b'{') {
        let v: Value = serde_json::from_slice(body).ok()?;
        let obj = v.as_object()?;
        return Some(
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect(),
        );
    }
    serde_urlencoded::from_bytes(body).ok()
}

// ------------------------------------------------------------------ redirect URIs

fn loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// What an application may be sent back to: an https page, a loopback listener (a native
/// app, any port), or a private-use scheme the app registered with its operating system.
fn redirect_uri_ok(uri: &str) -> bool {
    if uri.len() > 2000 || uri.contains('#') || uri.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Ok(url) = uri.parse::<reqwest::Url>() else { return false };
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => url.host_str().is_some_and(loopback_host),
        "javascript" | "data" | "file" | "vbscript" | "blob" | "about" | "ws" | "wss" | "ftp" => false,
        _ => true,
    }
}

/// Does the redirect URI of an authorization request match a registered one?  Exactly, except
/// that a loopback listener may be on any port (RFC 8252 §7.3): native apps pick a free one
/// each time.
fn redirect_matches(registered: &str, asked: &str) -> bool {
    if registered == asked {
        return true;
    }
    let (Ok(a), Ok(b)) = (registered.parse::<reqwest::Url>(), asked.parse::<reqwest::Url>()) else { return false };
    a.scheme() == "http"
        && b.scheme() == "http"
        && a.host_str().is_some_and(loopback_host)
        && a.host_str() == b.host_str()
        && a.path() == b.path()
        && a.query() == b.query()
}

// ------------------------------------------------------------------ registration

/// `POST /oauth/register` (RFC 7591): an application introduces itself.
pub async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let Ok(req) = serde_json::from_slice::<Value>(&body) else {
        return bad("invalid_client_metadata", "the body must be a JSON object");
    };
    let uris: Vec<String> = req["redirect_uris"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if uris.is_empty() || uris.len() > 20 {
        return bad("invalid_redirect_uri", "redirect_uris must list between 1 and 20 URIs");
    }
    if let Some(wrong) = uris.iter().find(|u| !redirect_uri_ok(u)) {
        return bad(
            "invalid_redirect_uri",
            &format!("{wrong} is not allowed: use https, a loopback http address, or an app scheme"),
        );
    }
    if let Some(method) = req["token_endpoint_auth_method"].as_str() {
        if method != "none" {
            return bad("invalid_client_metadata", "only public clients are supported: token_endpoint_auth_method must be none");
        }
    }
    let name: String = req["client_name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();
    let client_id = format!("kcm_{}{}", auth::random_token(), auth::random_token());

    // Registration is open to anyone, so the table is kept from growing without bound:
    // an application nobody ever allowed is forgotten after a day.
    let swept = sqlx::query(
        "DELETE FROM mcp_clients c WHERE c.created_at < now() - interval '1 day'
           AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.client_id = c.client_id)",
    )
    .execute(&state.pool)
    .await;
    if let Err(e) = swept {
        tracing::warn!("mcp: sweeping unused clients failed: {e}");
    }
    let stored = sqlx::query("INSERT INTO mcp_clients (client_id, name, redirect_uris) VALUES ($1, $2, $3)")
        .bind(&client_id)
        .bind(&name)
        .bind(json!(uris))
        .execute(&state.pool)
        .await;
    if let Err(e) = stored {
        tracing::error!("mcp: client registration failed: {e}");
        return oauth_error(StatusCode::INTERNAL_SERVER_ERROR, "server_error", "the registration could not be stored");
    }
    (
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "client_id": client_id,
            "client_id_issued_at": chrono::Utc::now().timestamp(),
            "client_name": name,
            "redirect_uris": uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": format!("{SCOPE_READ} {SCOPE_WRITE}"),
        })),
    )
        .into_response()
}

struct Client {
    name: String,
    redirect_uris: Vec<String>,
}

async fn load_client(state: &AppState, client_id: &str) -> AppResult<Option<Client>> {
    let row = sqlx::query("SELECT name, redirect_uris FROM mcp_clients WHERE client_id = $1")
        .bind(client_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(row.map(|r| Client {
        name: r.get("name"),
        redirect_uris: serde_json::from_value(r.get::<Value, _>("redirect_uris")).unwrap_or_default(),
    }))
}

// ------------------------------------------------------------------ authorize + consent

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    #[serde(default)]
    response_type: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    redirect_uri: String,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    code_challenge: String,
    #[serde(default)]
    code_challenge_method: String,
    #[serde(default)]
    scope: Option<String>,
}

/// An authorization the person is looking at (the consent page), then the one-time code.
#[derive(Serialize, Deserialize)]
struct PendingAuthorization {
    user_id: i64,
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: String,
    /// What the application asked for: with `write` in it the page offers the choice.
    write_asked: bool,
    /// Set when the person allowed it: what they granted.
    #[serde(default)]
    scope: String,
}

pub(crate) fn page(title: &str, host: &str, body: &str) -> Html<String> {
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title} — Junction</title>{STYLE}
<style>
  .kv dd code {{ word-break: break-all; }}
  .choice {{ display: flex; gap: 10px; align-items: flex-start; margin: 14px 0 4px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }}
  .choice input {{ margin-top: 3px; }}
  .choice small {{ display: block; color: var(--ink-2); margin-top: 2px; }}
</style></head><body>
<div class="dialog">
  <div class="titlebar"><span class="mark">{MARK}</span>{title}<span class="host">{host}</span></div>
  {body}
</div></body></html>"#,
        title = esc(title),
        host = esc(host),
    ))
}

fn problem_page(state: &AppState, headers: &HeaderMap, message: &str) -> Response {
    let host = host_label(&origin_of(state, headers));
    (
        StatusCode::BAD_REQUEST,
        page(
            "Connect an app",
            &host,
            &format!(
                r#"<div class="body"><h1>This connection request cannot be used</h1><p>{}</p>
<p class="muted">Start again from the app you were connecting. Nothing was shared.</p></div>
<div class="actions"><a class="btn" href="/">Close</a></div>"#,
                esc(message)
            ),
        ),
    )
        .into_response()
}

fn host_label(origin: &str) -> String {
    origin.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
}

fn redirect_with(uri: &str, params: &[(&str, &str)]) -> Response {
    let mut url = uri.to_string();
    let mut sep = if uri.contains('?') { '&' } else { '?' };
    for (k, v) in params {
        url.push(sep);
        url.push_str(k);
        url.push('=');
        url.push_str(&auth::urlencode(v));
        sep = '&';
    }
    Redirect::to(&url).into_response()
}

/// `GET /oauth/authorize`: the person's browser arrives from the application.
pub async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
    Query(q): Query<AuthorizeQuery>,
) -> AppResult<Response> {
    // Nothing is sent back to a redirect URI until it is known to belong to the client.
    let Some(client) = load_client(&state, &q.client_id).await? else {
        return Ok(problem_page(&state, &headers, "The app is not registered with this server (unknown client_id)."));
    };
    if !client.redirect_uris.iter().any(|r| redirect_matches(r, &q.redirect_uri)) {
        return Ok(problem_page(&state, &headers, "The address the app asked to be sent back to is not one it registered."));
    }
    let st = q.state.as_deref().unwrap_or("");
    let fail = |code: &str, description: &str| {
        let mut p = vec![("error", code), ("error_description", description)];
        if !st.is_empty() {
            p.push(("state", st));
        }
        redirect_with(&q.redirect_uri, &p)
    };
    if q.response_type != "code" {
        return Ok(fail("unsupported_response_type", "response_type must be code"));
    }
    if q.code_challenge_method != "S256" || q.code_challenge.len() < 43 || q.code_challenge.len() > 128 {
        return Ok(fail("invalid_request", "a PKCE code_challenge with method S256 is required"));
    }

    // Not signed in on this host yet: sign in first, then come straight back here.
    let Some(user) = auth::user_from_jar(&state, &jar).await else {
        let back = format!("/oauth/authorize?{}", raw.unwrap_or_default());
        return Ok(Redirect::to(&format!("/auth/github/login?next={}", auth::urlencode(&back))).into_response());
    };

    let scopes: Vec<&str> = q.scope.as_deref().unwrap_or("").split_whitespace().collect();
    // An application that names no scope is offered everything; the person still chooses.
    let write_asked = scopes.is_empty() || scopes.contains(&SCOPE_WRITE);
    let request = auth::random_token() + &auth::random_token();
    auth::pending_put(
        &state,
        KIND_REQUEST,
        &request,
        &PendingAuthorization {
            user_id: user.id,
            client_id: q.client_id.clone(),
            redirect_uri: q.redirect_uri.clone(),
            state: q.state.clone(),
            code_challenge: q.code_challenge.clone(),
            write_asked,
            scope: String::new(),
        },
    )
    .await?;

    let app = if client.name.is_empty() { "An app".to_string() } else { client.name.clone() };
    let target = q
        .redirect_uri
        .parse::<reqwest::Url>()
        .ok()
        .map(|u| match u.host_str() {
            Some(h) if loopback_host(h) => "an app on this computer".to_string(),
            Some(h) => h.to_string(),
            None => format!("{}:", u.scheme()),
        })
        .unwrap_or_default();
    let choice = if write_asked {
        r#"<label class="choice"><input type="checkbox" name="write" value="1" form="consent" checked>
      <span><b>Let it make changes</b><small>Edit schematics and boards (everyone in the project sees the edits live and each one can be undone), add comments, create projects and checkpoints. Without this it can only read.</small></span></label>"#
    } else {
        ""
    };
    let body = format!(
        r#"<div class="body">
    <h1>{app} wants to work with your projects</h1>
    <p>It is asking to act as you on Junction until you disconnect it.</p>
    <dl class="kv">
      <dt>Account</dt><dd><b>{login}</b></dd>
      <dt>App</dt><dd>{app} <span class="muted">(the name it gave itself)</span></dd>
      <dt>Sends you back to</dt><dd><code>{target}</code></dd>
      <dt>Can read</dt><dd>Your online projects and the ones shared with you: schematics, boards, comments</dd>
    </dl>
    {choice}
    <p class="muted">Only continue if you just asked to connect this app. You can disconnect it at any time under
       <b>Connected apps</b>.</p>
  </div>
  <form method="post" action="/oauth/authorize" class="actions" id="consent">
    <input type="hidden" name="request" value="{request}">
    <button type="submit" name="decision" value="deny" class="btn">Cancel</button>
    <button type="submit" name="decision" value="allow" class="btn primary">Allow</button>
  </form>"#,
        app = esc(&app),
        login = esc(&user.login),
        target = esc(&target),
        request = esc(&request),
    );
    let host = host_label(&origin_of(&state, &headers));
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            // the page must not be framed: a click on Allow has to be the person's own
            (header::HeaderName::from_static("x-frame-options"), "DENY"),
            (header::CONTENT_SECURITY_POLICY, "frame-ancestors 'none'"),
        ],
        page("Connect an app", &host, &body),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct Decision {
    request: String,
    #[serde(default)]
    decision: String,
    #[serde(default)]
    write: Option<String>,
}

/// `POST /oauth/authorize`: Allow or Cancel on the consent page.
pub async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    axum::Form(form): axum::Form<Decision>,
) -> AppResult<Response> {
    let Some(mut pending) = auth::pending_take::<PendingAuthorization>(&state, KIND_REQUEST, &form.request).await? else {
        return Ok(problem_page(&state, &headers, "This request has expired or was already answered."));
    };
    // The request id was shown only to the person who is signed in; it is useless to anyone else.
    let user = auth::user_from_jar(&state, &jar).await;
    if user.map(|u| u.id) != Some(pending.user_id) {
        return Ok(problem_page(&state, &headers, "You are no longer signed in as the account this request was made for."));
    }
    let st = pending.state.clone().unwrap_or_default();
    if form.decision != "allow" {
        let mut p = vec![("error", "access_denied"), ("error_description", "the person cancelled")];
        if !st.is_empty() {
            p.push(("state", st.as_str()));
        }
        return Ok(redirect_with(&pending.redirect_uri, &p));
    }
    pending.scope = if pending.write_asked && form.write.is_some() {
        format!("{SCOPE_READ} {SCOPE_WRITE}")
    } else {
        SCOPE_READ.to_string()
    };
    let code = auth::random_token() + &auth::random_token();
    let redirect_uri = pending.redirect_uri.clone();
    auth::pending_put(&state, KIND_CODE, &code, &pending).await?;
    let mut p = vec![("code", code.as_str())];
    if !st.is_empty() {
        p.push(("state", st.as_str()));
    }
    Ok(redirect_with(&redirect_uri, &p))
}

// ------------------------------------------------------------------ tokens

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn new_token(prefix: &str) -> String {
    let bytes: [u8; 32] = rand::random();
    format!("{prefix}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

async fn issue(state: &AppState, grant_id: i64, scope: &str) -> AppResult<Response> {
    let access = new_token(ACCESS_PREFIX);
    let refresh = new_token(REFRESH_PREFIX);
    for (token, kind, ttl) in [(&access, "access", ACCESS_TTL_SECS), (&refresh, "refresh", REFRESH_TTL_SECS)] {
        sqlx::query("INSERT INTO mcp_tokens (hash, grant_id, kind, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))")
            .bind(hash(token))
            .bind(grant_id)
            .bind(kind)
            .bind(ttl as f64)
            .execute(&state.pool)
            .await?;
    }
    // Expired tokens are of no use to anyone; sweep them on the way in.
    sqlx::query("DELETE FROM mcp_tokens WHERE expires_at < now() - interval '1 day'").execute(&state.pool).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store"), (header::PRAGMA, "no-cache")],
        Json(json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL_SECS,
            "refresh_token": refresh,
            "scope": scope,
        })),
    )
        .into_response())
}

/// `POST /oauth/token`: a code for tokens, or a refresh token for new ones.
pub async fn token(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(p) = body_params(&headers, &body) else {
        return bad("invalid_request", "the body must be form encoded");
    };
    let get = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    let result = match get("grant_type") {
        "authorization_code" => exchange_code(&state, get("code"), get("code_verifier"), get("client_id"), get("redirect_uri")).await,
        "refresh_token" => refresh(&state, get("refresh_token"), get("client_id")).await,
        _ => return bad("unsupported_grant_type", "grant_type must be authorization_code or refresh_token"),
    };
    match result {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("mcp: token endpoint failed: {e}");
            oauth_error(StatusCode::INTERNAL_SERVER_ERROR, "server_error", "the token could not be issued")
        }
    }
}

async fn exchange_code(state: &AppState, code: &str, verifier: &str, client_id: &str, redirect_uri: &str) -> AppResult<Response> {
    let Some(pending) = auth::pending_take::<PendingAuthorization>(state, KIND_CODE, code).await? else {
        return Ok(bad("invalid_grant", "the code is unknown, expired or already used"));
    };
    if pending.client_id != client_id {
        return Ok(bad("invalid_grant", "the code was issued to another client"));
    }
    if !redirect_uri.is_empty() && pending.redirect_uri != redirect_uri {
        return Ok(bad("invalid_grant", "redirect_uri does not match the authorization request"));
    }
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    if verifier.len() < 43 || challenge != pending.code_challenge {
        return Ok(bad("invalid_grant", "PKCE verification failed"));
    }
    let grant_id: i64 = sqlx::query_scalar("INSERT INTO mcp_grants (user_id, client_id, scope) VALUES ($1, $2, $3) RETURNING id")
        .bind(pending.user_id)
        .bind(&pending.client_id)
        .bind(&pending.scope)
        .fetch_one(&state.pool)
        .await?;
    issue(state, grant_id, &pending.scope).await
}

async fn refresh(state: &AppState, token: &str, client_id: &str) -> AppResult<Response> {
    let row = sqlx::query(
        "SELECT t.grant_id, g.client_id, g.scope, t.expires_at > now() AS live,
                t.replaced_at IS NOT NULL AS spent,
                COALESCE(t.replaced_at > now() - make_interval(secs => $2), false) AS just_spent
         FROM mcp_tokens t JOIN mcp_grants g ON g.id = t.grant_id
         WHERE t.hash = $1 AND t.kind = 'refresh'",
    )
    .bind(hash(token))
    .bind(REFRESH_GRACE_SECS)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Ok(bad("invalid_grant", "the refresh token is unknown or was revoked"));
    };
    let grant_id: i64 = row.get("grant_id");
    if !client_id.is_empty() && row.get::<String, _>("client_id") != client_id {
        return Ok(bad("invalid_grant", "the refresh token was issued to another client"));
    }
    if !row.get::<bool, _>("live") {
        return Ok(bad("invalid_grant", "the refresh token has expired; connect again"));
    }
    if row.get::<bool, _>("spent") && !row.get::<bool, _>("just_spent") {
        // A single-use token came back long after it was used: somebody else has a copy.
        sqlx::query("DELETE FROM mcp_grants WHERE id = $1").bind(grant_id).execute(&state.pool).await?;
        tracing::warn!("mcp: a spent refresh token was presented again; grant {grant_id} revoked");
        return Ok(bad("invalid_grant", "the refresh token was already used; connect again"));
    }
    sqlx::query("UPDATE mcp_tokens SET replaced_at = COALESCE(replaced_at, now()) WHERE hash = $1")
        .bind(hash(token))
        .execute(&state.pool)
        .await?;
    // The access tokens of this grant are replaced with the pair issued now.
    sqlx::query("DELETE FROM mcp_tokens WHERE grant_id = $1 AND kind = 'access' AND created_at < now() - interval '2 minutes'")
        .bind(grant_id)
        .execute(&state.pool)
        .await?;
    issue(state, grant_id, &row.get::<String, _>("scope")).await
}

/// `POST /oauth/revoke` (RFC 7009): the application gives its tokens back.  Either token
/// ends the whole grant; an unknown token is answered 200 as the RFC asks.
pub async fn revoke(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = body_params(&headers, &body).and_then(|p| p.get("token").cloned()).unwrap_or_default();
    if !token.is_empty() {
        let r = sqlx::query("DELETE FROM mcp_grants WHERE id IN (SELECT grant_id FROM mcp_tokens WHERE hash = $1)")
            .bind(hash(&token))
            .execute(&state.pool)
            .await;
        if let Err(e) = r {
            tracing::error!("mcp: revoke failed: {e}");
            return oauth_error(StatusCode::INTERNAL_SERVER_ERROR, "server_error", "the token could not be revoked");
        }
    }
    StatusCode::OK.into_response()
}

// ------------------------------------------------------------------ who is calling the endpoint

pub struct Caller {
    pub user: User,
    pub can_write: bool,
    /// The application's name, for the record of changes; empty for a session token.
    pub client: String,
}

/// The person behind a bearer token on the MCP endpoint: an access token issued here, or
/// the session token the desktop app holds (full access, the way it has everywhere else).
/// Cookies are never looked at, so no web page can drive the endpoint with a visitor's session.
pub async fn caller(state: &AppState, headers: &HeaderMap) -> AppResult<Option<Caller>> {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim)
    else {
        return Ok(None);
    };
    if token.starts_with(ACCESS_PREFIX) {
        let row = sqlx::query(
            "SELECT g.id, g.user_id, g.scope, c.name FROM mcp_tokens t
             JOIN mcp_grants g ON g.id = t.grant_id JOIN mcp_clients c ON c.client_id = g.client_id
             WHERE t.hash = $1 AND t.kind = 'access' AND t.expires_at > now()",
        )
        .bind(hash(token))
        .fetch_optional(&state.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let Some(user) = crate::persist::get_user(&state.pool, row.get("user_id")).await? else { return Ok(None) };
        // "last used" is for the Connected apps page; once a minute is plenty.
        sqlx::query("UPDATE mcp_grants SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')")
            .bind(row.get::<i64, _>("id"))
            .execute(&state.pool)
            .await?;
        let scope: String = row.get("scope");
        return Ok(Some(Caller { user, can_write: scope.split_whitespace().any(|s| s == SCOPE_WRITE), client: row.get("name") }));
    }
    let Some(claims) = auth::verify_jwt(state, token) else { return Ok(None) };
    Ok(crate::persist::get_user(&state.pool, claims.sub)
        .await?
        .map(|user| Caller { user, can_write: true, client: String::new() }))
}

// ------------------------------------------------------------------ Connected apps

/// `GET /api/mcp/grants`: the applications this person has connected.
pub async fn list_grants(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    Ok(Json(json!({ "grants": grants_of(&state, user.id).await? })))
}

async fn grants_of(state: &AppState, user_id: i64) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT g.id, c.name, c.client_id, g.scope, g.created_at, g.last_used_at FROM mcp_grants g
         JOIN mcp_clients c ON c.client_id = g.client_id
         WHERE g.user_id = $1
           AND EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.grant_id = g.id AND t.expires_at > now() AND t.replaced_at IS NULL)
         ORDER BY g.created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let scope: String = r.get("scope");
            json!({
                "id": r.get::<i64, _>("id"),
                "name": r.get::<String, _>("name"),
                "key": r.get::<String, _>("client_id").starts_with(KEY_CLIENT_PREFIX),
                "canWrite": scope.split_whitespace().any(|s| s == SCOPE_WRITE),
                "createdAt": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                "lastUsedAt": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_used_at").map(|t| t.to_rfc3339()),
            })
        })
        .collect())
}

#[derive(Deserialize)]
pub struct NewKey {
    #[serde(default)]
    name: String,
    #[serde(default)]
    write: bool,
}

/// `POST /api/mcp/keys`: an access key, for an AI service or script that cannot open a
/// sign-in page (a model API's remote MCP tool, an automation, an agent around a local
/// model).  It is a connection like any other: a grant with one long-lived access token and
/// no refresh token, listed with the connected apps and removed there.  The key is shown
/// once; only its hash is kept.
pub async fn create_key(State(state): State<AppState>, AuthUser(user): AuthUser, Json(req): Json<NewKey>) -> AppResult<Response> {
    let name: String = req.name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("Give the key a name, such as the service that will use it.".into()));
    }
    let have: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mcp_grants g WHERE g.user_id = $1 AND g.client_id LIKE 'kcm\\_key\\_%'
           AND EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.grant_id = g.id AND t.expires_at > now())",
    )
    .bind(user.id)
    .fetch_one(&state.pool)
    .await?;
    if have >= MAX_KEYS {
        return Err(AppError::BadRequest(format!("You already have {MAX_KEYS} access keys. Remove one you no longer use first.")));
    }
    let scope = if req.write { format!("{SCOPE_READ} {SCOPE_WRITE}") } else { SCOPE_READ.to_string() };
    let client_id = format!("{KEY_CLIENT_PREFIX}{}{}", auth::random_token(), auth::random_token());
    let key = new_token(ACCESS_PREFIX);
    let mut tx = state.pool.begin().await?;
    // No redirect URI, so the client cannot be used on the authorization endpoint.
    sqlx::query("INSERT INTO mcp_clients (client_id, name, redirect_uris) VALUES ($1, $2, '[]'::jsonb)")
        .bind(&client_id)
        .bind(&name)
        .execute(&mut *tx)
        .await?;
    let grant_id: i64 = sqlx::query_scalar("INSERT INTO mcp_grants (user_id, client_id, scope) VALUES ($1, $2, $3) RETURNING id")
        .bind(user.id)
        .bind(&client_id)
        .bind(&scope)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO mcp_tokens (hash, grant_id, kind, expires_at) VALUES ($1, $2, 'access', now() + make_interval(secs => $3))")
        .bind(hash(&key))
        .bind(grant_id)
        .bind(KEY_TTL_SECS as f64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "id": grant_id, "name": name, "key": key, "canWrite": req.write, "expiresIn": KEY_TTL_SECS })),
    )
        .into_response())
}

/// `DELETE /api/mcp/grants/{id}`: disconnect one.  Its tokens stop working at once.
pub async fn delete_grant(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let done = sqlx::query("DELETE FROM mcp_grants WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// `GET /connect`: how to connect an AI assistant, and what is connected now.
pub async fn connect_page(State(state): State<AppState>, headers: HeaderMap, jar: CookieJar) -> AppResult<Response> {
    let origin = origin_of(&state, &headers);
    let url = format!("{origin}/mcp");
    let user = auth::user_from_jar(&state, &jar).await;
    let apps = match &user {
        None => r#"<p class="muted"><a href="/auth/github/login?next=/connect">Sign in</a> to see the apps connected to your account.</p>"#.to_string(),
        Some(u) => {
            let grants = grants_of(&state, u.id).await?;
            if grants.is_empty() {
                r#"<p class="muted" id="none">No app is connected to your account yet.</p>"#.to_string()
            } else {
                let rows: String = grants
                    .iter()
                    .map(|g| {
                        format!(
                            r#"<tr data-grant="{id}"><td><b>{name}</b>{kind}</td><td>{access}</td><td class="when" data-t="{created}"></td><td class="when" data-t="{used}"></td><td><button class="btn" data-disconnect="{id}">{remove}</button></td></tr>"#,
                            id = g["id"],
                            name = esc(g["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Unnamed app")),
                            remove = if g["key"] == true { "Remove" } else { "Disconnect" },
                            kind = if g["key"] == true { r#" <span class="tag">access key</span>"# } else { "" },
                            access = if g["canWrite"] == true { "Read and change" } else { "Read only" },
                            created = esc(g["createdAt"].as_str().unwrap_or("")),
                            used = esc(g["lastUsedAt"].as_str().unwrap_or("")),
                        )
                    })
                    .collect();
                format!(r#"<table class="apps"><thead><tr><th>App</th><th>Access</th><th>Connected</th><th>Last used</th><th></th></tr></thead><tbody>{rows}</tbody></table>"#)
            }
        }
    };
    let keys = if user.is_some() {
        r#"<form id="keyForm" class="keyform" autocomplete="off">
  <input id="keyName" type="text" maxlength="60" placeholder="Name, such as the service that will use it" aria-label="Key name">
  <label class="chk"><input id="keyWrite" type="checkbox" checked> Let it make changes</label>
  <button class="btn primary" type="submit">Create key</button>
</form>
<p class="err" id="keyErr" hidden></p>
<div class="card" id="keyOut" hidden>
  <h3>Your new key</h3>
  <p class="muted">Copy it now: it is shown only this once. Anyone who has it can act as you in your projects, so keep it out of chats and repositories.</p>
  <div class="url"><code id="keyValue"></code><button class="btn primary" id="keyCopy" type="button">Copy</button></div>
  <p class="muted">Send it with every request as the header <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</div>"#
    } else {
        r#"<p class="muted"><a href="/auth/github/login?next=/connect">Sign in</a> to create an access key.</p>"#
    };
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Connect an AI assistant — Junction</title>{STYLE}
<style>
  body {{ display: block; }}
  main {{ max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; }}
  header.top {{ display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }}
  header.top .mark svg {{ width: 26px; height: 26px; display: block; }}
  header.top a {{ color: var(--ink-2); text-decoration: none; margin-left: auto; }}
  h1 {{ font-size: 26px; margin: 0 0 6px; }}
  h2 {{ font-size: 17px; margin: 30px 0 8px; }}
  p {{ line-height: 1.55; }}
  .lead {{ color: var(--ink-2); max-width: 64ch; }}
  .url {{ display: flex; gap: 8px; align-items: center; margin: 14px 0 4px; }}
  .url code, pre {{ font-family: var(--mono); font-size: 13px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }}
  .url code {{ padding: 9px 12px; flex: 1; overflow-wrap: anywhere; }}
  pre {{ padding: 12px 14px; overflow-x: auto; margin: 8px 0; }}
  .card {{ background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 4px 18px 14px; margin: 12px 0; }}
  .card h3 {{ font-size: 15px; margin: 14px 0 4px; }}
  ol {{ padding-left: 20px; line-height: 1.6; margin: 6px 0; }}
  table.apps {{ width: 100%; border-collapse: collapse; }}
  table.apps th {{ text-align: left; font-weight: 500; color: var(--ink-2); font-size: 13px; }}
  table.apps th, table.apps td {{ padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); }}
  .muted {{ color: var(--ink-2); }}
  .tag {{ font-size: 12px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; margin-left: 6px; font-weight: 400; white-space: nowrap; }}
  .keyform {{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 10px 0 4px; }}
  .keyform input[type=text] {{ flex: 1 1 260px; min-width: 0; height: 34px; padding: 0 10px; font: inherit; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 6px; }}
  .keyform input[type=text]:focus {{ outline: 2px solid var(--blue); outline-offset: -1px; }}
  .chk {{ display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }}
  .err {{ color: var(--err); margin: 4px 0; }}
  ul.can {{ columns: 2; column-gap: 28px; padding-left: 18px; line-height: 1.6; }}
  @media (max-width: 640px) {{ ul.can {{ columns: 1; }} table.apps th:nth-child(3), table.apps td:nth-child(3) {{ display: none; }} }}
</style></head><body><main>
<header class="top"><span class="mark">{MARK}</span><b>Junction</b><a href="/">Back to projects</a></header>
<h1>Connect an AI assistant</h1>
<p class="lead">Any AI model or service can open your online projects, read schematics and boards, run the rule checks, look parts
up, and make changes that everyone in the project sees live, with its own cursor. It connects over MCP, the open standard that
Claude, ChatGPT, Gemini, Copilot, Cursor and most agent tools speak, and signs in as you; you choose whether it may change things.
Nothing here is tied to one vendor, and the work runs on whatever plan or key you already have.</p>
<div class="url"><code id="url">{url}</code><button class="btn primary" id="copy">Copy</button></div>

<h2>How to connect</h2>
<div class="card">
  <h3>Claude</h3>
  <ol><li>On the web or in the desktop app, open <b>Settings</b>, then <b>Connectors</b>, and choose <b>Add custom connector</b>.</li>
      <li>Name it Junction, paste the address above, choose <b>Connect</b>, sign in here and allow it.</li></ol>
  <p class="muted">In Claude Code, run the line below, then <code>/mcp</code>, pick <b>kicad</b> and sign in.</p>
  <pre>claude mcp add --transport http kicad {url}</pre>
  <h3>ChatGPT</h3>
  <ol><li>Open <b>Settings</b>, then <b>Apps and connectors</b>, and turn on <b>Developer mode</b> under the advanced settings.</li>
      <li>Choose <b>Create</b>, paste the address above, sign in here and allow it.</li></ol>
  <p class="muted">In Codex CLI, run the line below and sign in when it asks.</p>
  <pre>codex mcp add kicad --url {url}</pre>
  <h3>Gemini CLI</h3>
  <pre>gemini mcp add --transport http kicad {url}</pre>
  <h3>Cursor</h3>
  <p class="muted">Add this to <code>~/.cursor/mcp.json</code>, then sign in from Cursor's MCP settings.</p>
  <pre>{{ "mcpServers": {{ "kicad": {{ "url": "{url}" }} }} }}</pre>
  <h3>VS Code with GitHub Copilot</h3>
  <p class="muted">Add this to <code>.vscode/mcp.json</code> in your workspace and start the server from the editor.</p>
  <pre>{{ "servers": {{ "kicad": {{ "type": "http", "url": "{url}" }} }} }}</pre>
  <h3>Anything else</h3>
  <p class="muted">Add a remote MCP server (Streamable HTTP) with the address above. Sign-in is standard OAuth with automatic
  registration, so there is no client ID or secret to fill in. A model you run yourself works through any agent that speaks MCP.</p>
</div>

<h2>Access keys</h2>
<p class="lead">For a service that cannot open a sign-in page, such as a model API's remote MCP tool, an automation or an agent
around a local model, create a key and give it to that service instead.</p>
{keys}

<h2>What it can do</h2>
<ul class="can">
  <li>List and open your projects</li><li>Read components, nets, pins and raw items</li>
  <li>Run ERC and DRC</li><li>See the schematic or board as an image</li>
  <li>Find parts and read datasheets</li><li>Place symbols, wires and labels</li>
  <li>Update the board from the schematic</li><li>Place footprints and autoroute</li>
  <li>Set design rules</li><li>Comment on the design</li>
  <li>Run a Python script that does a whole design step</li><li>Undo any change it made</li>
</ul>

<h2>Connected apps</h2>
{apps}
</main>
<script>
  document.getElementById("copy").addEventListener("click", async (e) => {{
    try {{ await navigator.clipboard.writeText(document.getElementById("url").textContent); e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy"), 1500); }} catch (err) {{ /* blocked: the address is selectable */ }}
  }});
  const kf = document.getElementById("keyForm");
  if (kf) {{
    const err = document.getElementById("keyErr");
    kf.addEventListener("submit", async (e) => {{
      e.preventDefault();
      err.hidden = true;
      const name = document.getElementById("keyName").value.trim();
      if (!name) {{ err.textContent = "Give the key a name, such as the service that will use it."; err.hidden = false; document.getElementById("keyName").focus(); return; }}
      const button = kf.querySelector("button"); button.disabled = true;
      try {{
        const r = await fetch("/api/mcp/keys", {{ method: "POST", headers: {{ "content-type": "application/json" }}, body: JSON.stringify({{ name, write: document.getElementById("keyWrite").checked }}) }});
        const j = await r.json().catch(() => ({{}}));
        if (!r.ok) throw new Error(j.message || "The key could not be created.");
        document.getElementById("keyValue").textContent = j.key;
        document.getElementById("keyOut").hidden = false;
        document.getElementById("keyName").value = "";
        addRow(j);
      }} catch (ex) {{ err.textContent = ex.message; err.hidden = false; }}
      button.disabled = false;
    }});
    document.getElementById("keyCopy").addEventListener("click", async (e) => {{
      try {{ await navigator.clipboard.writeText(document.getElementById("keyValue").textContent); e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy"), 1500); }} catch (ex) {{ /* blocked: the key is selectable */ }}
    }});
  }}
  const stamp = (td) => {{ const t = td.dataset.t; td.textContent = t ? new Date(t).toLocaleString(undefined, {{ dateStyle: "medium", timeStyle: "short" }}) : "Never"; }};
  function addRow(k) {{
    let table = document.querySelector("table.apps");
    if (!table) {{
      const none = document.getElementById("none");
      none.outerHTML = '<table class="apps"><thead><tr><th>App</th><th>Access</th><th>Connected</th><th>Last used</th><th></th></tr></thead><tbody></tbody></table>';
      table = document.querySelector("table.apps");
    }}
    const tr = document.createElement("tr");
    const cell = () => tr.appendChild(document.createElement("td"));
    const b = document.createElement("b"); b.textContent = k.name;
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "access key";
    cell().append(b, " ", tag);
    cell().textContent = k.canWrite ? "Read and change" : "Read only";
    const made = cell(); made.className = "when"; made.dataset.t = new Date().toISOString(); stamp(made);
    const used = cell(); used.className = "when"; used.dataset.t = ""; stamp(used);
    const rm = document.createElement("button"); rm.className = "btn"; rm.dataset.disconnect = k.id; rm.textContent = "Remove";
    cell().append(rm); wire(rm);
    table.tBodies[0].prepend(tr);
  }}
  for (const td of document.querySelectorAll("td.when")) stamp(td);
  function wire(b) {{ b.addEventListener("click", async () => {{
    b.disabled = true;
    const r = await fetch("/api/mcp/grants/" + b.dataset.disconnect, {{ method: "DELETE" }});
    if (r.ok) {{ const row = b.closest("tr"); const body = row.parentElement; row.remove(); if (!body.children.length) body.closest("table").outerHTML = '<p class="muted" id="none">No app is connected to your account yet.</p>'; }} else b.disabled = false;
  }}); }}
  for (const b of document.querySelectorAll("[data-disconnect]")) wire(b);
</script></body></html>"#
    );
    Ok(([(header::CACHE_CONTROL, "no-store")], Html(html)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_uris_allowed_and_refused() {
        for ok in ["https://claude.ai/api/mcp/auth_callback", "http://localhost:3000/callback", "http://127.0.0.1/cb", "http://[::1]:9/cb", "cursor://anysphere.cursor-mcp/oauth/callback", "com.example.app:/oauth"] {
            assert!(redirect_uri_ok(ok), "{ok}");
        }
        for no in ["http://example.com/cb", "javascript:alert(1)", "data:text/html,x", "https://a.example/cb#frag", "not a uri", "file:///etc/passwd", ""] {
            assert!(!redirect_uri_ok(no), "{no}");
        }
    }

    #[test]
    fn loopback_redirects_match_on_any_port() {
        assert!(redirect_matches("http://localhost/callback", "http://localhost:53112/callback"));
        assert!(redirect_matches("http://127.0.0.1:1/cb", "http://127.0.0.1:2/cb"));
        assert!(!redirect_matches("http://localhost/callback", "http://localhost:1/other"));
        assert!(!redirect_matches("https://claude.ai/cb", "https://claude.ai:444/cb"));
        assert!(!redirect_matches("https://claude.ai/cb", "https://evil.example/cb"));
        assert!(redirect_matches("https://claude.ai/cb", "https://claude.ai/cb"));
    }
}
