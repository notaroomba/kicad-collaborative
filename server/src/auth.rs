use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::Engine;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::persist::{self, User};
use crate::AppState;

pub const TOKEN_TTL_SECS: i64 = 30 * 24 * 3600;
const PENDING_TTL: Duration = Duration::from_secs(600);
pub const COOKIE_NAME: &str = "kc_session";
/// Binds an in-flight OAuth `state` to the browser that started the flow.
/// ponytail: one cookie name, so two concurrent logins in one browser clobber
/// each other and the older tab fails closed. Key by state hash if that matters.
const OAUTH_STATE_COOKIE: &str = "kc_oauth_state";

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub login: String,
    pub iat: i64,
    pub exp: i64,
}

/// In-flight browser OAuth state, keyed by the random `state` we hand GitHub.
pub struct PendingLogin {
    pub next: String,
    /// Set when this login was initiated by a desktop PKCE authorize request.
    pub desktop: Option<PendingDesktop>,
    /// A non-canonical origin (e.g. the custom domain) to hand the finished
    /// session back to via a one-time adopt code, when the browser started the
    /// flow somewhere other than public_url.
    pub return_origin: Option<String>,
    pub created: Instant,
}

/// One-time code that hands a finished browser session to a non-canonical
/// host, so its cookie is set on that host rather than public_url.
pub struct PendingAdopt {
    pub user_id: i64,
    pub login: String,
    pub next: String,
    pub created: Instant,
}

#[derive(Clone)]
pub struct PendingDesktop {
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
}

/// One-time desktop auth code -> (pkce info, user id).
pub struct PendingDesktopCode {
    pub desktop: PendingDesktop,
    pub user_id: i64,
    pub login: String,
    pub created: Instant,
}

#[derive(Default)]
pub struct AuthPending {
    pub logins: Mutex<HashMap<String, PendingLogin>>,
    pub desktop_codes: Mutex<HashMap<String, PendingDesktopCode>>,
    pub adopt_codes: Mutex<HashMap<String, PendingAdopt>>,
}

impl AuthPending {
    fn purge(&self) {
        self.logins
            .lock()
            .unwrap()
            .retain(|_, v| v.created.elapsed() < PENDING_TTL);
        self.desktop_codes
            .lock()
            .unwrap()
            .retain(|_, v| v.created.elapsed() < PENDING_TTL);
        self.adopt_codes
            .lock()
            .unwrap()
            .retain(|_, v| v.created.elapsed() < PENDING_TTL);
    }
}

pub fn random_token() -> String {
    let bytes: [u8; 16] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn mint_jwt(state: &AppState, user_id: i64, login: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims { sub: user_id, login: login.to_string(), iat: now, exp: now + TOKEN_TTL_SECS };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(state.cfg.jwt_secret.as_bytes()))
        .expect("jwt encode")
}

/// The signed-in user carried by the session cookie, if any (for web pages and
/// cookie-authenticated endpoints).
pub async fn user_from_jar(state: &AppState, jar: &CookieJar) -> Option<crate::persist::User> {
    let claims = jar.get(COOKIE_NAME).and_then(|c| verify_jwt(state, c.value()))?;
    crate::persist::get_user(&state.pool, claims.sub).await.ok().flatten()
}


pub fn verify_jwt(state: &AppState, token: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|d| d.claims)
}

/// Extractor: authenticated user via Bearer token or session cookie.
pub struct AuthUser(pub User);

/// Like AuthUser but never rejects: anonymous requests yield None.  For
/// endpoints where signed-out access is meaningful (public-project reads).
pub struct MaybeAuthUser(pub Option<User>);

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(MaybeAuthUser(
            AuthUser::from_request_parts(parts, state).await.ok().map(|u| u.0),
        ))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let bearer = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string);

        let cookie = parts
            .headers
            .get(axum::http::header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| {
                raw.split(';').map(str::trim).find_map(|kv| {
                    kv.strip_prefix(&format!("{COOKIE_NAME}=")).map(str::to_string)
                })
            });

        let token = bearer.or(cookie).ok_or(AppError::Unauthorized)?;
        let claims = verify_jwt(state, &token).ok_or(AppError::Unauthorized)?;
        let user = persist::get_user(&state.pool, claims.sub)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(AuthUser(user))
    }
}

fn github_configured(state: &AppState) -> AppResult<(&str, &str)> {
    match (&state.cfg.github_client_id, &state.cfg.github_client_secret) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(AppError::AuthNotConfigured),
    }
}

// ---------- Web flow ----------

#[derive(Deserialize)]
pub struct LoginQuery {
    pub next: Option<String>,
    /// The origin to return the session to (set by the broker redirect only).
    pub origin: Option<String>,
}

/// The origin (scheme://host) this request arrived on; prod is always https.
fn request_origin(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(axum::http::header::HOST)?.to_str().ok()?;
    Some(format!("https://{host}"))
}

/// A host the browser may sign in from: public_url itself, or one listed in
/// ALLOWED_ORIGINS.  Guards the adopt redirect against handing a session to an
/// arbitrary origin.
fn is_allowed_origin(state: &AppState, origin: &str) -> bool {
    let canon = state.cfg.public_url.trim_end_matches('/');
    origin == canon || state.cfg.allowed_origins.iter().any(|o| o == origin)
}

pub async fn github_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LoginQuery>,
) -> AppResult<Response> {
    let (client_id, _) = github_configured(&state)?;
    let next = sanitize_next(q.next.as_deref());
    let canonical = state.cfg.public_url.trim_end_matches('/');

    // The GitHub OAuth app's callback + the flow's cookies all live on
    // public_url.  If the browser started somewhere else (the custom domain),
    // send the whole dance to public_url and remember where to hand the
    // session back, so the state and session cookies are never set on a host
    // the callback can't read.
    if q.origin.is_none() {
        if let Some(here) = request_origin(&headers) {
            if here != canonical && is_allowed_origin(&state, &here) {
                let url = format!(
                    "{}/auth/github/login?next={}&origin={}",
                    canonical,
                    urlencode(&next),
                    urlencode(&here),
                );
                return Ok(Redirect::to(&url).into_response());
            }
        }
    }

    let return_origin = q
        .origin
        .as_deref()
        .map(|o| o.trim_end_matches('/'))
        .filter(|o| *o != canonical && is_allowed_origin(&state, o))
        .map(str::to_string);

    Ok(start_github_flow(&state, client_id, next, None, return_origin))
}

fn start_github_flow(
    state: &AppState,
    client_id: &str,
    next: String,
    desktop: Option<PendingDesktop>,
    return_origin: Option<String>,
) -> Response {
    state.auth_pending.purge();
    let oauth_state = random_token();
    state.auth_pending.logins.lock().unwrap().insert(
        oauth_state.clone(),
        PendingLogin { next, desktop, return_origin, created: Instant::now() },
    );
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read%3Auser%20user%3Aemail&state={}",
        urlencode(client_id),
        urlencode(&format!("{}/auth/github/callback", state.cfg.public_url)),
        urlencode(&oauth_state),
    );

    // Without this the callback accepts any browser presenting a known state,
    // which lets an attacker plant their own session in a victim's browser.
    let cookie = Cookie::build((OAUTH_STATE_COOKIE, oauth_state))
        .path("/auth")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.cfg.public_url.starts_with("https://"))
        .build();

    (CookieJar::new().add(cookie), Redirect::to(&url)).into_response()
}

/// Only allow same-site relative redirect targets.
fn sanitize_next(next: Option<&str>) -> String {
    match next {
        Some(n) if n.starts_with('/') && !n.starts_with("//") => n.to_string(),
        _ => "/".to_string(),
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: String,
}

#[derive(Deserialize)]
struct GithubTokenResponse {
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct GithubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GithubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

pub async fn github_callback(
    State(state): State<AppState>,
    Query(q): Query<CallbackQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let (client_id, client_secret) = github_configured(&state)?;

    if jar.get(OAUTH_STATE_COOKIE).map(|c| c.value()) != Some(q.state.as_str()) {
        return Err(AppError::BadRequest("oauth state mismatch".into()));
    }

    let jar = jar.remove( Cookie::build( ( OAUTH_STATE_COOKIE, "" ) ).path( "/auth" ).build() );

    let pending = state
        .auth_pending
        .logins
        .lock()
        .unwrap()
        .remove(&q.state)
        .ok_or_else(|| AppError::BadRequest("unknown or expired oauth state".into()))?;
    if pending.created.elapsed() > PENDING_TTL {
        return Err(AppError::BadRequest("expired oauth state".into()));
    }

    let http = reqwest::Client::new();
    let token: GithubTokenResponse = http
        .post("https://github.com/login/oauth/access_token")
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", q.code.as_str()),
        ])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("github token exchange failed: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("github token response invalid: {e}"))?;
    let access = token
        .access_token
        .ok_or_else(|| AppError::BadRequest("github rejected the authorization code".into()))?;

    let gh_user: GithubUser = github_api(&http, &access, "https://api.github.com/user").await?;
    let emails: Vec<GithubEmail> =
        github_api(&http, &access, "https://api.github.com/user/emails").await.unwrap_or_default();
    let primary_email = emails
        .iter()
        .find(|e| e.primary && e.verified)
        .or_else(|| emails.iter().find(|e| e.verified))
        .map(|e| e.email.clone());
    let verified_emails: Vec<String> =
        emails.iter().filter(|e| e.verified).map(|e| e.email.clone()).collect();

    let user = persist::upsert_user(
        &state.pool,
        gh_user.id,
        &gh_user.login,
        gh_user.name.as_deref(),
        primary_email.as_deref(),
        gh_user.avatar_url.as_deref(),
    )
    .await?;
    persist::fill_pending_grants(&state.pool, user.id, &user.login, &verified_emails).await?;

    finish_login(&state, jar, user, pending).await
}

/// Shared tail of the browser flow: either hand a one-time code back to the
/// desktop loopback, or set the session cookie and continue to `next`.
#[derive(Deserialize)]
pub struct AdoptQuery {
    pub code: String,
}

/// Land the browser on the origin it started from and set the session cookie
/// there.  Reached only via the one-time code minted in finish_login for a
/// brokered cross-origin sign-in.
pub async fn adopt(
    State(state): State<AppState>,
    Query(q): Query<AdoptQuery>,
) -> AppResult<Response> {
    state.auth_pending.purge();
    let pending = state
        .auth_pending
        .adopt_codes
        .lock()
        .unwrap()
        .remove(&q.code)
        .ok_or_else(|| AppError::BadRequest("unknown or expired sign-in code".into()))?;
    if pending.created.elapsed() > PENDING_TTL {
        return Err(AppError::BadRequest("expired sign-in code".into()));
    }

    let jwt = mint_jwt(&state, pending.user_id, &pending.login);
    let cookie = Cookie::build((COOKIE_NAME, jwt))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(true)
        .build();

    Ok((CookieJar::new().add(cookie), Redirect::to(&pending.next)).into_response())
}

async fn finish_login(
    state: &AppState,
    jar: CookieJar,
    user: User,
    pending: PendingLogin,
) -> AppResult<Response> {
    // Brokered sign-in from another host (the custom domain): its cookie must
    // be set on that host, not public_url, so mint a one-time adopt code and
    // bounce the browser back there.
    if let Some(origin) = pending.return_origin.clone() {
        let code = random_token();
        state.auth_pending.adopt_codes.lock().unwrap().insert(
            code.clone(),
            PendingAdopt {
                user_id: user.id,
                login: user.login.clone(),
                next: pending.next.clone(),
                created: Instant::now(),
            },
        );
        let url = format!("{}/auth/adopt?code={}", origin.trim_end_matches('/'), urlencode(&code));
        return Ok(Redirect::to(&url).into_response());
    }

    let jwt = mint_jwt(state, user.id, &user.login);
    // Session cookie (no max_age): the JWT inside carries its own 30-day expiry.
    let cookie = Cookie::build((COOKIE_NAME, jwt))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.cfg.public_url.starts_with("https://"))
        .build();
    let jar = jar.add(cookie);

    if let Some(desktop) = pending.desktop {
        let code = random_token();
        let redirect_uri = desktop.redirect_uri.clone();
        state.auth_pending.desktop_codes.lock().unwrap().insert(
            code.clone(),
            PendingDesktopCode {
                desktop,
                user_id: user.id,
                login: user.login.clone(),
                created: Instant::now(),
            },
        );

        // The code never leaves the server until the user clicks Allow, so a
        // local process that opens this URL cannot silently obtain a token.
        // The loopback URI is shown because it is the only thing that
        // distinguishes the real KiCad listener from an impostor's port.
        let page = format!(
            r#"<!doctype html><meta charset="utf-8"><title>Authorize sign-in</title>
<style>body{{font-family:system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 24px;line-height:1.5}}
button{{padding:10px 20px;border:0;border-radius:8px;background:#4477ee;color:#fff;font:inherit;font-weight:600;cursor:pointer}}
code{{background:#8883;padding:2px 6px;border-radius:4px}}</style>
<h1>Authorize desktop sign-in</h1>
<p>An application on this computer (<code>{uri}</code>) is asking to sign in as
<b>{login}</b> for 30 days.</p>
<p>If you did not just start a sign-in from KiCad, close this page.</p>
<form method="post" action="/auth/desktop/confirm">
  <input type="hidden" name="code" value="{code}">
  <button type="submit">Allow</button>
</form>"#,
            uri = crate::pages::esc(&redirect_uri),
            login = crate::pages::esc(&user.login),
            code = crate::pages::esc(&code),
        );

        return Ok((jar, axum::response::Html(page)).into_response());
    }

    Ok((jar, Redirect::to(&pending.next)).into_response())
}


#[derive(Deserialize)]
pub struct DesktopConfirm
{
    pub code: String,
}


/// Second leg of the desktop flow: only now does the one-time code reach the
/// loopback listener.
pub async fn desktop_confirm(
    State(state): State<AppState>,
    axum::Form(form): axum::Form<DesktopConfirm>,
) -> AppResult<Response> {
    let url = {
        let codes = state.auth_pending.desktop_codes.lock().unwrap();
        let pending = codes
            .get(&form.code)
            .ok_or_else(|| AppError::BadRequest("unknown or expired code".into()))?;

        format!(
            "{}?code={}&state={}",
            pending.desktop.redirect_uri,
            urlencode(&form.code),
            urlencode(&pending.desktop.state)
        )
    };

    Ok(Redirect::to(&url).into_response())
}

async fn github_api<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    url: &str,
) -> AppResult<T> {
    Ok(http
        .get(url)
        .header(reqwest::header::USER_AGENT, "kicad-collab-server")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("github api {url} failed: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("github api {url} response invalid: {e}"))?)
}

// ---------- Desktop PKCE broker ----------

#[derive(Deserialize)]
pub struct DesktopAuthorizeQuery {
    pub redirect_uri: String,
    pub state: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
}

pub async fn desktop_authorize(
    State(state): State<AppState>,
    Query(q): Query<DesktopAuthorizeQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let (client_id, _) = github_configured(&state)?;

    if q.code_challenge_method != "S256" {
        return Err(AppError::BadRequest("code_challenge_method must be S256".into()));
    }
    let uri: reqwest::Url = q
        .redirect_uri
        .parse()
        .map_err(|_| AppError::BadRequest("invalid redirect_uri".into()))?;
    let host_ok = matches!(uri.host_str(), Some("127.0.0.1") | Some("localhost"));
    if uri.scheme() != "http" || !host_ok {
        return Err(AppError::BadRequest("redirect_uri must be a http://127.0.0.1 loopback".into()));
    }

    let desktop = PendingDesktop {
        code_challenge: q.code_challenge,
        redirect_uri: q.redirect_uri,
        state: q.state,
    };

    // Already signed in in this browser? Complete immediately without GitHub.
    if let Some(claims) = jar
        .get(COOKIE_NAME)
        .and_then(|c| verify_jwt(&state, c.value()))
    {
        if let Some(user) = persist::get_user(&state.pool, claims.sub).await? {
            let pending =
                PendingLogin { next: "/".into(), desktop: Some(desktop), return_origin: None, created: Instant::now() };
            return finish_login(&state, jar, user, pending).await;
        }
    }

    Ok(start_github_flow(&state, client_id, "/".into(), Some(desktop), None).into_response())
}

#[derive(Deserialize)]
pub struct DesktopTokenRequest {
    pub grant_type: String,
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

pub async fn desktop_token(
    State(state): State<AppState>,
    Json(req): Json<DesktopTokenRequest>,
) -> AppResult<Response> {
    if req.grant_type != "authorization_code" {
        return Err(AppError::BadRequest("unsupported grant_type".into()));
    }
    let pending = state
        .auth_pending
        .desktop_codes
        .lock()
        .unwrap()
        .remove(&req.code)
        .ok_or_else(|| AppError::BadRequest("unknown or expired code".into()))?;
    if pending.created.elapsed() > PENDING_TTL {
        return Err(AppError::BadRequest("expired code".into()));
    }
    if pending.desktop.redirect_uri != req.redirect_uri {
        return Err(AppError::BadRequest("redirect_uri mismatch".into()));
    }
    let digest = Sha256::digest(req.code_verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    if challenge != pending.desktop.code_challenge {
        return Err(AppError::BadRequest("PKCE verification failed".into()));
    }

    let jwt = mint_jwt(&state, pending.user_id, &pending.login);
    Ok(Json(json!({
        "access_token": jwt,
        "token_type": "bearer",
        "expires_in": TOKEN_TTL_SECS,
    }))
    .into_response())
}

/// A short-lived token for authenticating a WebSocket.  The browser can't put
/// its httpOnly session cookie into a hello frame, and cookies riding a WS
/// upgrade are unreliable (SameSite, tracking protection, some proxies), so
/// the page fetches this over a normal request (where the cookie is sent) and
/// sends it in the hello frame like the desktop does.
pub async fn ws_ticket(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Json<serde_json::Value> {
    Json(json!({ "token": mint_jwt(&state, user.id, &user.login) }))
}

pub async fn me(AuthUser(user): AuthUser) -> Json<serde_json::Value> {
    Json(json!({
        "id": user.id,
        "login": user.login,
        "name": user.name,
        "email": user.email,
        "avatarUrl": user.avatar_url,
    }))
}
