//! Time tracking: Junction's own record of the time people spend on a project, and WakaTime
//! heartbeats for the browser editor.
//!
//! The socket (ws.rs) calls [`activity`] whenever a signed-in person edits a document (an op)
//! or moves around in it (a presence message whose cursor or view changed; the editors' idle
//! keepalive repeats the last one and so does not count).  Like WakaTime's editor plugins, a
//! heartbeat goes out when the person turns to another file, when two minutes have passed
//! since the last one, or on the first edit after a heartbeat that was only looking.
//!
//! Every heartbeat is stored in `activity_beats` for the time views (`/api/me/time`,
//! `/api/projects/{id}/time`), from every client.  Heartbeats from the browser editor are also
//! sent to the person's WakaTime account (or Wakapi, Hackatime: any server that speaks the
//! WakaTime API) with the key they saved in Preferences → WakaTime; the key stays on the
//! server, sealed like the GitHub tokens.  The desktop app sends its own heartbeats through
//! wakatime-cli and ~/.wakatime.cfg on the person's computer (common/wakatime.cpp), so its
//! activity is only recorded here, never forwarded twice.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::access::Viewer;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::{persist, AppState};

/// WakaTime's own heartbeat rate: the editor plugins send at most one heartbeat for the same
/// file every two minutes.
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(120);
/// Gaps between heartbeats up to this long are time spent (WakaTime's default keystroke
/// timeout); a longer gap is a break.
pub const TIMEOUT_SECS: i64 = 15 * 60;
pub const DEFAULT_API_URL: &str = "https://api.wakatime.com/api/v1";
/// Other servers that speak the WakaTime API, offered in the settings.
pub const HACKATIME_API_URL: &str = "https://hackatime.hackclub.com/api/hackatime/v1";
pub const WAKAPI_API_URL: &str = "https://wakapi.dev/api/compat/wakatime/v1";
/// What WakaTime reads the editor from: `<cli>/<version> (<os>) <editor>/<version> <plugin>/<version>`.
fn user_agent() -> String {
    let v = env!("CARGO_PKG_VERSION");
    format!("wakatime/v1.0.0 (linux) junction/{v} junction-wakatime/{v}")
}

struct Last {
    doc: Uuid,
    at: Instant,
    write: bool,
}

static LAST: LazyLock<Mutex<HashMap<i64, Last>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether this bit of activity makes a heartbeat (and records it as sent if so).
fn due(user_id: i64, doc_id: Uuid, is_write: bool, now: Instant) -> bool {
    let mut last = LAST.lock().unwrap();
    let send = match last.get(&user_id) {
        None => true,
        Some(l) => l.doc != doc_id || now.duration_since(l.at) >= HEARTBEAT_EVERY || (is_write && !l.write),
    };
    if send {
        if last.len() > 50_000 {
            last.retain(|_, l| now.duration_since(l.at) < HEARTBEAT_EVERY);
        }
        last.insert(user_id, Last { doc: doc_id, at: now, write: is_write });
    }
    send
}

/// The WakaTime language of a document.
pub fn language(doc_type: &str, path: &str) -> &'static str {
    match doc_type {
        "kicad_sch" => "KiCad Schematic",
        "kicad_pcb" => "KiCad PCB",
        _ if path.ends_with(".kicad_sym") => "KiCad Symbol",
        _ if path.ends_with(".kicad_mod") => "KiCad Footprint",
        _ => "KiCad",
    }
}

/// Someone did something in a document.  `client` is the hello's client kind ("web",
/// "desktop"); AI assistants working through MCP and guests are not tracked.
pub fn activity(state: &AppState, user_id: i64, doc_id: Uuid, client: &str, is_write: bool) {
    if user_id <= 0 || client == "mcp" {
        return;
    }
    if !due(user_id, doc_id, is_write, Instant::now()) {
        return;
    }
    let state = state.clone();
    let client = client.to_string();
    tokio::spawn(async move {
        if let Err(e) = beat(&state, user_id, doc_id, &client, is_write).await {
            tracing::debug!("heartbeat for user {user_id}: {e}");
        }
    });
}

async fn beat(state: &AppState, user_id: i64, doc_id: Uuid, client: &str, is_write: bool) -> AppResult<()> {
    let Some(doc) = persist::get_document(&state.pool, doc_id).await? else { return Ok(()) };
    let Some(project) = persist::get_project(&state.pool, doc.project_id).await? else { return Ok(()) };
    sqlx::query(
        "INSERT INTO activity_beats (user_id, project_id, doc_id, path, client, is_write) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user_id)
    .bind(project.id)
    .bind(doc.id)
    .bind(&doc.path)
    .bind(client)
    .bind(is_write)
    .execute(&state.pool)
    .await?;
    if client != "web" {
        return Ok(());
    }
    let Some(cfg) = load(state, user_id).await? else { return Ok(()) };
    if !cfg.enabled {
        return Ok(());
    }
    let Some(key) = cfg.key else { return Ok(()) };
    let hb = heartbeat(&project.name, &doc.path, language(&doc.doc_type, &doc.path), is_write);
    let result = send(&cfg.api_url, &key, &hb).await;
    record(state, user_id, &result).await;
    Ok(())
}

/// One heartbeat, in the WakaTime API's shape.
pub fn heartbeat(project: &str, entity: &str, language: &str, is_write: bool) -> Value {
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    json!({
        "entity": entity,
        "type": "file",
        "category": "designing",
        "time": time,
        "project": project,
        "language": language,
        "is_write": is_write,
        // Hackatime and Wakapi store these as sent; WakaTime reads the User-Agent
        "editor": "Junction",
        "plugin": format!("junction-wakatime/{}", env!("CARGO_PKG_VERSION")),
        "operating_system": "Web",
        "machine": "Junction web editor",
        "user_agent": user_agent(),
    })
}

// ------------------------------------------------------------------ settings

struct Settings {
    enabled: bool,
    key: Option<String>,
    hint: String,
    api_url: String,
    last_at: Option<chrono::DateTime<chrono::Utc>>,
    last_ok: Option<bool>,
    last_status: String,
}

async fn load(state: &AppState, user_id: i64) -> AppResult<Option<Settings>> {
    let row: Option<(bool, Option<Vec<u8>>, String, String, Option<chrono::DateTime<chrono::Utc>>, Option<bool>, String)> = sqlx::query_as(
        "SELECT enabled, api_key, hint, api_url, last_at, last_ok, last_status FROM wakatime_settings WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|(enabled, key, hint, api_url, last_at, last_ok, last_status)| Settings {
        enabled,
        // sealed under another JWT_SECRET: as good as no key
        key: key.and_then(|k| crate::github::unseal_str(state, &k)),
        hint,
        api_url,
        last_at,
        last_ok,
        last_status,
    }))
}

async fn record(state: &AppState, user_id: i64, result: &Result<u16, String>) {
    let (ok, status) = match result {
        Ok(code) => (true, format!("accepted ({code})")),
        Err(e) => (false, e.clone()),
    };
    let _ = sqlx::query("UPDATE wakatime_settings SET last_at = now(), last_ok = $2, last_status = $3 WHERE user_id = $1")
        .bind(user_id)
        .bind(ok)
        .bind(status)
        .execute(&state.pool)
        .await;
}

fn settings_json(s: Option<&Settings>) -> Value {
    match s {
        None => json!({ "enabled": false, "hasKey": false, "hint": "", "apiUrl": "", "defaultApiUrl": DEFAULT_API_URL, "presets": presets(), "last": null }),
        Some(s) => json!({
            "enabled": s.enabled,
            "hasKey": s.key.is_some(),
            "hint": if s.key.is_some() { s.hint.as_str() } else { "" },
            "apiUrl": s.api_url,
            "defaultApiUrl": DEFAULT_API_URL,
            "presets": presets(),
            "last": s.last_at.map(|at| json!({ "at": at, "ok": s.last_ok.unwrap_or(false), "status": s.last_status })),
        }),
    }
}

fn presets() -> Value {
    json!([
        { "id": "wakatime", "label": "WakaTime", "apiUrl": "", "keyUrl": "https://wakatime.com/settings/api-key" },
        { "id": "hackatime", "label": "Hackatime", "apiUrl": HACKATIME_API_URL, "keyUrl": "https://hackatime.hackclub.com/my/settings" },
        { "id": "wakapi", "label": "Wakapi", "apiUrl": WAKAPI_API_URL, "keyUrl": "https://wakapi.dev/settings" },
    ])
}

/// GET /api/me/wakatime
pub async fn get_settings(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let s = load(&state, user.id).await?;
    Ok(Json(settings_json(s.as_ref())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBody {
    enabled: Option<bool>,
    /// A new key; "" removes the stored one; absent keeps it.
    api_key: Option<String>,
    /// "" means WakaTime itself.
    api_url: Option<String>,
}

/// A key as WakaTime prints it (`waka_<uuid>`, or a bare uuid for older accounts); Wakapi and
/// Hackatime keys are uuids too.  Anything else is most likely a paste of the wrong thing.
fn valid_key(k: &str) -> bool {
    let bare = k.strip_prefix("waka_").unwrap_or(k);
    (8..=200).contains(&k.len()) && bare.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// PUT /api/me/wakatime
pub async fn put_settings(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<SettingsBody>,
) -> AppResult<Json<Value>> {
    let old = load(&state, user.id).await?;
    let enabled = body.enabled.unwrap_or_else(|| old.as_ref().map(|s| s.enabled).unwrap_or(true));
    let api_url = match body.api_url {
        Some(u) => clean_url(&u)?,
        None => old.as_ref().map(|s| s.api_url.clone()).unwrap_or_default(),
    };
    let (sealed, hint): (Option<Vec<u8>>, String) = match body.api_key.as_deref().map(str::trim) {
        Some("") => (None, String::new()),
        Some(k) => {
            if !valid_key(k) {
                return Err(AppError::Api(axum::http::StatusCode::BAD_REQUEST, "bad_key", "That does not look like a WakaTime API key. Copy it from your WakaTime, Hackatime or Wakapi settings.".into()));
            }
            let hint: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            (Some(crate::github::seal(&state, k.as_bytes())?), hint)
        }
        None => {
            let row: Option<(Option<Vec<u8>>, String)> = sqlx::query_as("SELECT api_key, hint FROM wakatime_settings WHERE user_id = $1")
                .bind(user.id)
                .fetch_optional(&state.pool)
                .await?;
            row.map(|(k, h)| (k, h)).unwrap_or((None, String::new()))
        }
    };
    let changed_key = body.api_key.is_some();
    sqlx::query(
        "INSERT INTO wakatime_settings (user_id, enabled, api_key, hint, api_url) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET enabled = $2, api_key = $3, hint = $4, api_url = $5, updated_at = now(),
           last_at = CASE WHEN $6 THEN NULL ELSE wakatime_settings.last_at END,
           last_ok = CASE WHEN $6 THEN NULL ELSE wakatime_settings.last_ok END,
           last_status = CASE WHEN $6 THEN '' ELSE wakatime_settings.last_status END",
    )
    .bind(user.id)
    .bind(enabled)
    .bind(sealed)
    .bind(hint)
    .bind(&api_url)
    .bind(changed_key)
    .execute(&state.pool)
    .await?;
    let s = load(&state, user.id).await?;
    Ok(Json(settings_json(s.as_ref())))
}

/// DELETE /api/me/wakatime: forget the key and the settings.
pub async fn delete_settings(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM wakatime_settings WHERE user_id = $1").bind(user.id).execute(&state.pool).await?;
    Ok(Json(settings_json(None)))
}

/// POST /api/me/wakatime/test: send one heartbeat now and say what the server answered.
pub async fn test_settings(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let Some(cfg) = load(&state, user.id).await? else {
        return Err(AppError::Api(axum::http::StatusCode::BAD_REQUEST, "no_key", "Save a WakaTime API key first.".into()));
    };
    let Some(key) = cfg.key.clone() else {
        return Err(AppError::Api(axum::http::StatusCode::BAD_REQUEST, "no_key", "Save a WakaTime API key first.".into()));
    };
    let hb = heartbeat("Junction", "Junction connection test", "KiCad", false);
    let result = send(&cfg.api_url, &key, &hb).await;
    record(&state, user.id, &result).await;
    let s = load(&state, user.id).await?;
    Ok(Json(json!({ "ok": result.is_ok(), "status": match &result { Ok(c) => format!("accepted ({c})"), Err(e) => e.clone() }, "settings": settings_json(s.as_ref()) })))
}

// ------------------------------------------------------------------ sending

fn allow_local() -> bool {
    // For the test rig only: lets heartbeats go to a server on this machine.
    matches!(std::env::var("KC_WAKATIME_ALLOW_LOCAL").as_deref(), Ok("1"))
}

/// The API address as stored: "" for WakaTime, else an https address with no login, query or
/// trailing slash (".../api/v1" for WakaTime and Wakapi's compat API, ".../api/hackatime/v1").
fn clean_url(u: &str) -> AppResult<String> {
    let u = u.trim().trim_end_matches('/');
    if u.is_empty() || u == DEFAULT_API_URL {
        return Ok(String::new());
    }
    let bad = |m: &str| AppError::Api(axum::http::StatusCode::BAD_REQUEST, "bad_url", m.to_string());
    let url = reqwest::Url::parse(u).map_err(|_| bad("The API URL is not a web address."))?;
    match url.scheme() {
        "https" => {}
        "http" if allow_local() => {}
        _ => return Err(bad("The API URL must start with https://.")),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(bad("The API URL must not carry a login, query or fragment."));
    }
    if url.host_str().is_none() {
        return Err(bad("The API URL has no host."));
    }
    // .../users/current/heartbeats pasted whole: keep the base
    let s = url.as_str().trim_end_matches('/');
    let s = s.strip_suffix("/users/current/heartbeats").or_else(|| s.strip_suffix("/users/current/heartbeats.bulk")).unwrap_or(s);
    Ok(s.to_string())
}

/// Where to connect for this URL: every address the name answers with must be public (the
/// URL is the person's to choose, so it must not reach inside the server's network).
async fn vet(url: &reqwest::Url) -> Result<Option<(String, SocketAddr)>, String> {
    if allow_local() {
        return Ok(None);
    }
    let host = url.host_str().ok_or("no host")?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.trim_matches(|c| c == '[' || c == ']'), port))
        .await
        .map_err(|_| format!("{host} could not be found"))?
        .collect();
    if addrs.is_empty() || !addrs.iter().all(|a| crate::datasheet::public(a.ip())) {
        return Err(format!("{host} is not a public address"));
    }
    Ok(Some((host, addrs[0])))
}

/// POST one heartbeat; the HTTP status on success, a short reason otherwise.
pub async fn send(api_url: &str, key: &str, hb: &Value) -> Result<u16, String> {
    let base = if api_url.is_empty() { DEFAULT_API_URL } else { api_url };
    // The bulk endpoint with a one-item array: WakaTime, Wakapi and Hackatime all take it
    // (Hackatime's single endpoint also wants an array, WakaTime's wants an object).
    let url = reqwest::Url::parse(&format!("{base}/users/current/heartbeats.bulk")).map_err(|_| "bad API URL".to_string())?;
    let pin = vet(&url).await?;
    let mut b = reqwest::Client::builder()
        .user_agent(user_agent())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20));
    if let Some((host, addr)) = &pin {
        b = b.resolve(host, *addr);
    }
    if let Ok(path) = std::env::var("KC_EXTRA_CA_FILE") {
        if let Ok(pem) = std::fs::read(&path) {
            for cert in reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_default() {
                b = b.add_root_certificate(cert);
            }
        }
    }
    let http = b.build().map_err(|e| e.to_string())?;
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(key));
    let r = http
        .post(url.clone())
        .header("authorization", auth)
        .json(&json!([hb]))
        .send()
        .await
        .map_err(|_| format!("{} did not answer", url.host_str().unwrap_or("the server")))?;
    let code = r.status().as_u16();
    match code {
        200..=299 => Ok(code),
        401 | 403 => Err(format!("the key was refused ({code})")),
        _ => Err(format!("the server answered {code}")),
    }
}

// ------------------------------------------------------------------ time views

#[derive(Deserialize)]
pub struct TimeQuery {
    /// How many days back, today included (1..=365, default 14).
    days: Option<i64>,
    /// The browser's `Date.getTimezoneOffset()` in minutes, so days start at local midnight.
    tz: Option<i64>,
}

fn window(q: &TimeQuery) -> (i64, i64) {
    (q.days.unwrap_or(14).clamp(1, 365), q.tz.unwrap_or(0).clamp(-14 * 60, 14 * 60))
}

/// Each heartbeat of the users in `who` since the window opened, with the seconds it stands for
/// (the gap to that person's next heartbeat, when under the timeout).  `$1` days, `$2` tz offset.
const SPANS: &str = "
    WITH span AS (SELECT (date_trunc('day', now() - make_interval(mins => $2::int)) - make_interval(days => $1::int - 1)) + make_interval(mins => $2::int) AS since),
    b AS (
        SELECT a.user_id, a.project_id, a.path, a.client, a.at,
               LEAD(a.at) OVER (PARTITION BY a.user_id ORDER BY a.at) AS nxt
        FROM activity_beats a, span WHERE a.at >= span.since AND {who}
    ),
    d AS (
        SELECT user_id, project_id, path, client, at,
               CASE WHEN nxt IS NOT NULL AND nxt - at <= make_interval(secs => {timeout}) THEN EXTRACT(EPOCH FROM nxt - at)::float8 ELSE 0 END AS secs,
               (at - make_interval(mins => $2::int))::date AS day
        FROM b
    )";

fn spans(who: &str) -> String {
    SPANS.replace("{who}", who).replace("{timeout}", &TIMEOUT_SECS.to_string())
}

fn days_json(rows: Vec<(chrono::NaiveDate, f64)>, days: i64, tz: i64) -> Vec<Value> {
    let today = (chrono::Utc::now() - chrono::Duration::minutes(tz)).date_naive();
    let by: HashMap<chrono::NaiveDate, f64> = rows.into_iter().collect();
    (0..days)
        .rev()
        .map(|i| {
            let d = today - chrono::Duration::days(i);
            json!({ "day": d.to_string(), "seconds": by.get(&d).copied().unwrap_or(0.0).round() as i64 })
        })
        .collect()
}

/// GET /api/me/time: the signed-in person's time, by day, project and client.
pub async fn my_time(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<TimeQuery>) -> AppResult<Json<Value>> {
    let (days, tz) = window(&q);
    let base = spans("a.user_id = $3");
    let by_day: Vec<(chrono::NaiveDate, f64)> = sqlx::query_as(&format!("{base} SELECT day, SUM(secs)::float8 FROM d GROUP BY day"))
        .bind(days).bind(tz).bind(user.id).fetch_all(&state.pool).await?;
    let by_project: Vec<(Uuid, String, f64, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(&format!(
        "{base} SELECT d.project_id, p.name, SUM(d.secs)::float8 AS s, MAX(d.at) FROM d JOIN projects p ON p.id = d.project_id
         WHERE p.deleted_at IS NULL GROUP BY d.project_id, p.name ORDER BY s DESC"
    ))
    .bind(days).bind(tz).bind(user.id).fetch_all(&state.pool).await?;
    let by_client: Vec<(String, f64)> = sqlx::query_as(&format!("{base} SELECT client, SUM(secs)::float8 AS s FROM d GROUP BY client ORDER BY s DESC"))
        .bind(days).bind(tz).bind(user.id).fetch_all(&state.pool).await?;
    let total: f64 = by_day.iter().map(|r| r.1).sum();
    Ok(Json(json!({
        "days": days_json(by_day, days, tz),
        "total": total.round() as i64,
        "projects": by_project.into_iter().map(|(id, name, s, last)| json!({ "projectId": id, "name": name, "seconds": s.round() as i64, "lastAt": last })).collect::<Vec<_>>(),
        "clients": by_client.into_iter().map(|(c, s)| json!({ "client": c, "seconds": s.round() as i64 })).collect::<Vec<_>>(),
    })))
}

/// GET /api/projects/{id}/time: time on one project, by day, person and document.  Anyone who
/// can see the project can see it.
pub async fn project_time(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
    Query(q): Query<TimeQuery>,
) -> AppResult<Json<Value>> {
    crate::access::require(&state.pool, &viewer, project_id).await?;
    let project = persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    let (days, tz) = window(&q);
    // A person's gap before turning to another project belongs to this one, so their whole
    // stream is ordered first and only then narrowed to this project.
    let base = spans("a.user_id IN (SELECT DISTINCT user_id FROM activity_beats WHERE project_id = $3)");
    let by_day: Vec<(chrono::NaiveDate, f64)> =
        sqlx::query_as(&format!("{base} SELECT day, SUM(secs)::float8 FROM d WHERE project_id = $3 GROUP BY day"))
            .bind(days).bind(tz).bind(project_id).fetch_all(&state.pool).await?;
    let by_user: Vec<(i64, String, Option<String>, Option<String>, f64, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(&format!(
        "{base} SELECT u.id, u.login, u.name, u.avatar_url, SUM(d.secs)::float8 AS s, MAX(d.at) FROM d JOIN users u ON u.id = d.user_id
         WHERE d.project_id = $3 GROUP BY u.id, u.login, u.name, u.avatar_url ORDER BY s DESC"
    ))
    .bind(days).bind(tz).bind(project_id).fetch_all(&state.pool).await?;
    let by_doc: Vec<(String, f64)> = sqlx::query_as(&format!(
        "{base} SELECT path, SUM(secs)::float8 AS s FROM d WHERE project_id = $3 GROUP BY path ORDER BY s DESC LIMIT 50"
    ))
    .bind(days).bind(tz).bind(project_id).fetch_all(&state.pool).await?;
    let total: f64 = by_day.iter().map(|r| r.1).sum();
    Ok(Json(json!({
        "projectId": project_id,
        "name": project.name,
        "days": days_json(by_day, days, tz),
        "total": total.round() as i64,
        "people": by_user.into_iter().map(|(id, login, name, avatar, s, last)| json!({ "userId": id, "login": login, "name": name, "avatarUrl": avatar, "seconds": s.round() as i64, "lastAt": last })).collect::<Vec<_>>(),
        "docs": by_doc.into_iter().map(|(p, s)| json!({ "path": p, "seconds": s.round() as i64 })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttles_like_wakatime() {
        let t0 = Instant::now();
        let (u, a, b) = (987_654_321, Uuid::new_v4(), Uuid::new_v4());
        assert!(due(u, a, false, t0));
        assert!(!due(u, a, false, t0 + Duration::from_secs(30)));
        // the first edit after looking goes out at once, later edits wait
        assert!(due(u, a, true, t0 + Duration::from_secs(40)));
        assert!(!due(u, a, true, t0 + Duration::from_secs(50)));
        // another file goes out at once
        assert!(due(u, b, false, t0 + Duration::from_secs(60)));
        assert!(!due(u, b, false, t0 + Duration::from_secs(179)));
        assert!(due(u, b, false, t0 + Duration::from_secs(181)));
    }

    #[test]
    fn urls_and_keys() {
        assert_eq!(clean_url("").unwrap(), "");
        assert_eq!(clean_url("https://api.wakatime.com/api/v1/").unwrap(), "");
        assert_eq!(clean_url("https://wakapi.dev/api/compat/wakatime/v1").unwrap(), "https://wakapi.dev/api/compat/wakatime/v1");
        assert_eq!(clean_url("https://hackatime.hackclub.com/api/hackatime/v1/users/current/heartbeats").unwrap(), "https://hackatime.hackclub.com/api/hackatime/v1");
        assert!(clean_url("http://example.com/api").is_err());
        assert!(clean_url("https://user:pw@example.com/api").is_err());
        assert!(clean_url("ftp://example.com").is_err());
        assert!(valid_key("waka_12345678-1234-1234-1234-123456789abc"));
        assert!(valid_key("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_key("hello world"));
        assert!(!valid_key("short"));
        assert_eq!(language("kicad_sch", "a.kicad_sch"), "KiCad Schematic");
        assert_eq!(language("kicad_pcb", "a.kicad_pcb"), "KiCad PCB");
    }
}
