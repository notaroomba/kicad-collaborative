
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
/// How long an in-flight sign-in (an OAuth state or a one-time code) stays usable.
const PENDING_TTL_SECS: f64 = 600.0;
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
#[derive(Serialize, Deserialize)]
pub struct PendingLogin {
    pub next: String,
    /// Set when this login was initiated by a desktop PKCE authorize request.
    pub desktop: Option<PendingDesktop>,
    /// A non-canonical origin (e.g. the custom domain) to hand the finished
    /// session back to via a one-time adopt code, when the browser started the
    /// flow somewhere other than public_url.
    pub return_origin: Option<String>,
    /// Set when this is not a sign-in at all but a signed-in user granting
    /// repository access (github.rs): the token is stored, no session is minted.
    pub connect: Option<PendingConnect>,
}

/// A signed-in user adding repository access to their account.
#[derive(Serialize, Deserialize)]
pub struct PendingConnect {
    pub user_id: i64,
    pub github_id: i64,
    /// Where to send the browser afterwards (an allowed origin + a relative path).
    pub return_to: String,
    /// Through Junction's GitHub App rather than the sign-in OAuth app's `repo` scope.
    #[serde(default)]
    pub app: bool,
}

/// One-time code that hands a finished browser session to a non-canonical
/// host, so its cookie is set on that host rather than public_url.
#[derive(Serialize, Deserialize)]
pub struct PendingAdopt {
    pub user_id: i64,
    pub login: String,
    pub next: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingDesktop {
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
}

/// One-time desktop auth code -> (pkce info, user id).
#[derive(Serialize, Deserialize)]
pub struct PendingDesktopCode {
    pub desktop: PendingDesktop,
    pub user_id: i64,
    pub login: String,
}

/// In-flight sign-in state lives in Postgres rather than in this process.  A sign-in is
/// several requests long (GitHub's redirect back, the desktop app's token exchange, the
/// adopt hop to another host) and with more than one server replica each of them may land
/// on a different one; kept in memory, the second request found nothing and the sign-in
/// failed with "unknown or expired oauth state".
const KIND_LOGIN: &str = "login";
const KIND_DESKTOP: &str = "desktop";
const KIND_ADOPT: &str = "adopt";

pub(crate) async fn pending_put<T: Serialize>(state: &AppState, kind: &str, key: &str, value: &T) -> AppResult<()> {
    // Expired rows are swept on the way in; nothing else ever needs to.
    sqlx::query("DELETE FROM auth_pending WHERE created < now() - make_interval(secs => $1)")
        .bind(PENDING_TTL_SECS)
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO auth_pending (kind, key, payload) VALUES ($1, $2, $3)
         ON CONFLICT (kind, key) DO UPDATE SET payload = EXCLUDED.payload, created = now()",
    )
    .bind(kind)
    .bind(key)
    .bind(serde_json::to_value(value).map_err(|e| anyhow::anyhow!("pending state: {e}"))?)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Look at an unexpired entry without consuming it.
pub(crate) async fn pending_peek<T: serde::de::DeserializeOwned>(state: &AppState, kind: &str, key: &str) -> AppResult<Option<T>> {
    let row: Option<(serde_json::Value,)> = sqlx::query_as(
        "SELECT payload FROM auth_pending
         WHERE kind = $1 AND key = $2 AND created >= now() - make_interval(secs => $3)",
    )
    .bind(kind)
    .bind(key)
    .bind(PENDING_TTL_SECS)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.and_then(|(v,)| serde_json::from_value(v).ok()))
}

/// Consume an entry: exactly one request gets it, whichever replica it reaches.  An expired
/// entry is removed and reported as absent.
pub(crate) async fn pending_take<T: serde::de::DeserializeOwned>(state: &AppState, kind: &str, key: &str) -> AppResult<Option<T>> {
    let row: Option<(serde_json::Value, bool)> = sqlx::query_as(
        "DELETE FROM auth_pending WHERE kind = $1 AND key = $2
         RETURNING payload, created >= now() - make_interval(secs => $3)",
    )
    .bind(kind)
    .bind(key)
    .bind(PENDING_TTL_SECS)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.filter(|(_, fresh)| *fresh).and_then(|(v, _)| serde_json::from_value(v).ok()))
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
pub(crate) fn is_allowed_origin(state: &AppState, origin: &str) -> bool {
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

    start_github_flow(&state, client_id, next, None, return_origin, None, SIGN_IN_SCOPE).await
}

const SIGN_IN_SCOPE: &str = "read:user user:email";

#[derive(Deserialize)]
pub struct ConnectQuery {
    pub next: Option<String>,
    /// `public` asks for public repositories only; anything else for private ones too.
    pub access: Option<String>,
}

/// Grant repository access: the same OAuth app and callback as sign-in, asked for
/// the `repo` scope, by someone already signed in here.  Sign-in itself keeps
/// asking for nothing but identity, so nobody hands over their repositories just
/// to open a share link.
pub async fn github_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(q): Query<ConnectQuery>,
) -> AppResult<Response> {
    let next = sanitize_next(q.next.as_deref());
    let Some(user) = user_from_jar(&state, &jar).await else {
        let back = format!("/auth/github/connect?next={}", urlencode(&next));
        return Ok(Redirect::to(&format!("/auth/github/login?next={}", urlencode(&back))).into_response());
    };

    // Unlike sign-in this may start on any allowed host: the callback needs no
    // cookie from this browser (see github_callback), so nothing has to be
    // brokered through public_url first.
    let canonical = state.cfg.public_url.trim_end_matches('/');
    let origin = request_origin(&headers)
        .filter(|o| is_allowed_origin(&state, o))
        .unwrap_or_else(|| canonical.to_string());
    // With Junction's GitHub App registered, repository access goes through it: the person
    // picks the repositories, and the app asks for nothing but their files and pull
    // requests (github_app.rs).  Without one, the old OAuth scopes.
    if let Some(app) = crate::github_app::creds(&state).await? {
        let connect = PendingConnect {
            user_id: user.id,
            github_id: user.github_id,
            return_to: format!("{origin}{next}"),
            app: true,
        };
        return start_github_flow(&state, &app.client_id, next, None, None, Some(connect), "").await;
    }
    let (client_id, _) = github_configured(&state)?;
    let scope = if q.access.as_deref() == Some("public") {
        "read:user user:email public_repo"
    } else {
        "read:user user:email repo"
    };
    let connect = PendingConnect {
        user_id: user.id,
        github_id: user.github_id,
        return_to: format!("{origin}{next}"),
        app: false,
    };
    start_github_flow(&state, client_id, next, None, None, Some(connect), scope).await
}

async fn start_github_flow(
    state: &AppState,
    client_id: &str,
    next: String,
    desktop: Option<PendingDesktop>,
    return_origin: Option<String>,
    connect: Option<PendingConnect>,
    scope: &str,
) -> AppResult<Response> {
    let oauth_state = random_token();
    pending_put(state, KIND_LOGIN, &oauth_state, &PendingLogin { next, desktop, return_origin, connect }).await?;
    let url = format!(
        "{}/login/oauth/authorize?client_id={}&redirect_uri={}{}&state={}",
        state.cfg.github_web_url,
        urlencode(client_id),
        urlencode(&format!("{}/auth/github/callback", state.cfg.public_url)),
        if scope.is_empty() { String::new() } else { format!("&scope={}", urlencode(scope)) },
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

    Ok((CookieJar::new().add(cookie), Redirect::to(&url)).into_response())
}

/// Only allow same-site relative redirect targets.
fn sanitize_next(next: Option<&str>) -> String {
    match next {
        Some(n) if n.starts_with('/') && !n.starts_with("//") => n.to_string(),
        _ => "/".to_string(),
    }
}

pub(crate) fn urlencode(s: &str) -> String {
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
    /// Comma-separated scopes actually granted (the user can untick some).
    #[serde(default)]
    scope: Option<String>,
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

    // A sign-in must come back to the browser that started it (the state cookie).
    // A repository grant is bound differently: its state names the account it is
    // for, and the token is refused below unless it belongs to that very GitHub
    // user — so a state in the wrong browser can attach nothing to anyone.
    let is_connect = pending_peek::<PendingLogin>(&state, KIND_LOGIN, &q.state)
        .await?
        .is_some_and(|p| p.connect.is_some());
    if !is_connect && jar.get(OAUTH_STATE_COOKIE).map(|c| c.value()) != Some(q.state.as_str()) {
        return Err(AppError::BadRequest("oauth state mismatch".into()));
    }

    let jar = jar.remove( Cookie::build( ( OAUTH_STATE_COOKIE, "" ) ).path( "/auth" ).build() );

    let pending: PendingLogin = pending_take(&state, KIND_LOGIN, &q.state)
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown or expired oauth state".into()))?;

    if let Some(connect) = pending.connect.as_ref().filter(|c| c.app) {
        let connect = PendingConnect { return_to: connect.return_to.clone(), user_id: connect.user_id, github_id: connect.github_id, app: true };
        let resp = crate::github_app::finish_connect(&state, connect, &q.code).await?;
        return Ok((jar, resp).into_response());
    }
    let (client_id, client_secret) = github_configured(&state)?;

    let http = reqwest::Client::new();
    let token: GithubTokenResponse = http
        .post(format!("{}/login/oauth/access_token", state.cfg.github_web_url))
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

    let api = &state.cfg.github_api_url;
    let gh_user: GithubUser = github_api(&http, &access, &format!("{api}/user")).await?;

    if let Some(connect) = pending.connect {
        if gh_user.id != connect.github_id {
            return Err(AppError::BadRequest(format!(
                "GitHub is signed in as {}, which is not the account you use here. \
                 Switch accounts on github.com and connect again.",
                gh_user.login
            )));
        }
        crate::github::store_token(
            &state,
            connect.user_id,
            &access,
            token.scope.as_deref().unwrap_or(""),
        )
        .await?;
        return Ok((jar, Redirect::to(&connect.return_to)).into_response());
    }

    let emails: Vec<GithubEmail> =
        github_api(&http, &access, &format!("{api}/user/emails")).await.unwrap_or_default();
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

#[derive(Deserialize)]
pub struct DevLoginQuery {
    pub jwt: String,
    #[serde(default)]
    pub next: Option<String>,
}

/// Development only (`KC_DEV_LOGIN=1`): set the session cookie from a JWT minted with the
/// server's secret, then continue to `next`.  A local browser test rig cannot inject the
/// cookie itself, and the GitHub round trip needs a registered OAuth app.
pub async fn dev_login(
    State(state): State<AppState>,
    Query(q): Query<DevLoginQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    if !state.cfg.dev_login {
        return Err(AppError::NotFound);
    }
    verify_jwt(&state, &q.jwt).ok_or_else(|| AppError::BadRequest("bad token".into()))?;
    let cookie = Cookie::build((COOKIE_NAME, q.jwt.clone()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();
    let jar = jar.add(cookie);
    let next = q.next.filter(|n| n.starts_with('/') && !n.starts_with("//")).unwrap_or_else(|| "/".into());
    Ok((jar, Redirect::to(&next)).into_response())
}

/// POST /auth/logout: drop the browser session cookie.  Desktop tokens live in
/// the OS keychain and are forgotten there.
pub async fn logout(jar: CookieJar) -> Response {
    let cookie = Cookie::build((COOKIE_NAME, "")).path("/").build();
    (jar.remove(cookie), Json(json!({ "ok": true }))).into_response()
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
    let pending: PendingAdopt = pending_take(&state, KIND_ADOPT, &q.code)
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown or expired sign-in code".into()))?;

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
        pending_put(
            state,
            KIND_ADOPT,
            &code,
            &PendingAdopt { user_id: user.id, login: user.login.clone(), next: pending.next.clone() },
        )
        .await?;
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
        pending_put(
            state,
            KIND_DESKTOP,
            &code,
            &PendingDesktopCode { desktop, user_id: user.id, login: user.login.clone() },
        )
        .await?;

        // The code never leaves the server until the user clicks Allow, so a
        // local process that opens this URL cannot silently obtain a token.
        // The loopback URI is shown because it is the only thing that
        // distinguishes the real KiCad listener from an impostor's port.
        let host = state
            .cfg
            .site_url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string();
        let page = format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize sign-in — Junction</title>{style}</head><body>
<div class="dialog">
  <div class="titlebar"><span class="mark">{mark}</span>Authorize sign-in<span class="host">{host}</span></div>
  <div class="body">
    <h1>Junction wants to sign in as you</h1>
    <p>The desktop app on this computer is asking to use your account for 30 days.</p>
    <dl class="kv">
      <dt>Account</dt><dd><b>{login}</b></dd>
      <dt>App address</dt><dd><code>{uri}</code></dd>
      <dt>Access</dt><dd>Your online projects and live sessions</dd>
    </dl>
    <p class="muted">Only continue if you just chose <b>File &rarr; Sign In to Collaboration</b> in Junction.
       The address above is the app that receives the sign-in — a stranger's app would show a different one.</p>
  </div>
  <form method="post" action="/auth/desktop/confirm" class="actions">
    <input type="hidden" name="code" value="{code}">
    <a class="btn" href="/">Cancel</a>
    <button type="submit" class="btn primary">Allow</button>
  </form>
</div></body></html>"#,
            style = crate::pages::STYLE,
            mark = crate::pages::MARK,
            host = crate::pages::esc(&host),
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
        let pending: PendingDesktopCode = pending_peek(&state, KIND_DESKTOP, &form.code)
            .await?
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
    headers: HeaderMap,
    axum::extract::RawQuery(raw_query): axum::extract::RawQuery,
    Query(q): Query<DesktopAuthorizeQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let (client_id, _) = github_configured(&state)?;

    // The GitHub callback + the state cookie must live on public_url.  Desktop
    // apps still point at a non-canonical host (e.g. the old railway default),
    // so broker the whole flow onto public_url — otherwise the cookie is set on
    // the desktop's host and the callback on public_url can't match it
    // ("oauth state mismatch").
    let canonical = state.cfg.public_url.trim_end_matches('/');

    if let Some(here) = request_origin(&headers) {
        if here != canonical && is_allowed_origin(&state, &here) {
            let qs = raw_query.unwrap_or_default();
            let url = format!(
                "{}/auth/desktop/authorize{}{}",
                canonical,
                if qs.is_empty() { "" } else { "?" },
                qs
            );
            return Ok(Redirect::to(&url).into_response());
        }
    }

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
                PendingLogin { next: "/".into(), desktop: Some(desktop), return_origin: None, connect: None };
            return finish_login(&state, jar, user, pending).await;
        }
    }

    start_github_flow(&state, client_id, "/".into(), Some(desktop), None, None, SIGN_IN_SCOPE).await
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
    let pending: PendingDesktopCode = pending_take(&state, KIND_DESKTOP, &req.code)
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown or expired code".into()))?;
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
