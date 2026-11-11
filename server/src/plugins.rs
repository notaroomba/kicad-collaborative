//! Web editor plugins (web/plugins): the per-account store and the built-in catalog.
//!
//! The server's part is deliberately small.  A plugin is code that runs in a sandbox in the
//! browser of the person who installed it (web/plugins/sandbox.ts) and reaches the design
//! only through that person's own editor, so nothing a plugin does arrives here except as
//! the ordinary collaboration ops the editor sends for any edit — with that person's role
//! deciding, as always, whether they are accepted.  What is kept here is the copy: the
//! manifest, the plugin's text files, what the person granted, and whether it is enabled.
//!
//! The server never fetches a plugin from an address.  The browser does that and uploads
//! the result, so this endpoint cannot be used to make the server request arbitrary URLs.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::AppState;

const MAX_PLUGINS: i64 = 60;
const MAX_FILES: usize = 40;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 128 * 1024;

/// The plugins that ship with the server (server/plugins/<folder>): useful on their own and
/// the worked examples the developer guide points at.
const CATALOG: &[(&str, &[(&str, &str)])] = &[
    (include_str!("../plugins/bom-export/plugin.json"), &[("main.js", include_str!("../plugins/bom-export/main.js"))]),
    (include_str!("../plugins/design-stats/plugin.json"), &[
        ("main.js", include_str!("../plugins/design-stats/main.js")),
        ("panel.html", include_str!("../plugins/design-stats/panel.html")),
    ]),
    (include_str!("../plugins/snap-to-grid/plugin.json"), &[("main.js", include_str!("../plugins/snap-to-grid/main.js"))]),
    (include_str!("../plugins/field-lint/plugin.json"), &[("main.js", include_str!("../plugins/field-lint/main.js"))]),
    (include_str!("../plugins/placement-import/plugin.json"), &[("main.js", include_str!("../plugins/placement-import/main.js"))]),
];

fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadRequest(msg.into())
}

/// KiCad's plugin identifier rule (api/schemas/api.v1.schema.json).
fn valid_identifier(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() >= 2
        && b.len() <= 100
        && b[0].is_ascii_alphabetic()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn valid_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 120
        && !p.starts_with('/')
        && !p.starts_with('.')
        && !p.contains("..")
        && !p.contains("//")
        && p.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'/'))
}

const PERMISSIONS: &[&str] = &["design:read", "design:write", "view", "files:import", "files:export", "assistant"];

fn valid_permission(p: &str) -> bool {
    if let Some(host) = p.strip_prefix("network:") {
        return !host.is_empty()
            && host.len() <= 255
            && host.contains('.')
            && host.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'.' | b'*' | b':'));
    }
    PERMISSIONS.contains(&p)
}

/// The checks that matter for what is stored and later handed to a browser.  The browser
/// validates the manifest in full before it asks (web/plugins/types.ts); this is the part
/// that must hold even for a request that did not come from our page.
fn check(identifier: &str, manifest: &Value, files: &Map<String, Value>, granted: &[String]) -> AppResult<()> {
    if !valid_identifier(identifier) {
        return Err(bad("the plugin identifier is malformed"));
    }
    let m = manifest.as_object().ok_or_else(|| bad("manifest must be an object"))?;
    if m.get("identifier").and_then(Value::as_str) != Some(identifier) {
        return Err(bad("the manifest's identifier does not match the address"));
    }
    if m.get("name").and_then(Value::as_str).map(|s| s.is_empty() || s.len() > 200).unwrap_or(true) {
        return Err(bad("the manifest needs a name"));
    }
    let runtime = m.get("runtime").and_then(Value::as_object).ok_or_else(|| bad("the manifest needs a runtime"))?;
    if runtime.get("type").and_then(Value::as_str) != Some("web") {
        return Err(bad("only plugins with the \"web\" runtime are installed here; python and exec plugins belong to the desktop app"));
    }
    let entry = runtime.get("entrypoint").and_then(Value::as_str).ok_or_else(|| bad("runtime.entrypoint is required"))?;
    if serde_json::to_string(manifest).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_MANIFEST_BYTES {
        return Err(bad("the manifest is too large"));
    }
    if files.len() > MAX_FILES {
        return Err(bad(format!("a plugin holds at most {MAX_FILES} files")));
    }
    let mut total = 0usize;
    for (path, body) in files {
        if !valid_path(path) {
            return Err(bad(format!("\"{path}\" is not an acceptable file name")));
        }
        total += body.as_str().ok_or_else(|| bad("plugin files are text"))?.len();
    }
    if total > MAX_FILE_BYTES {
        return Err(bad("the plugin is larger than 2 MB"));
    }
    if !files.contains_key(entry) {
        return Err(bad("the entry point named in the manifest is missing"));
    }
    // What is granted can only be something the manifest asks for: a client cannot hand a
    // plugin more than its own description (and therefore the consent screen) showed.
    let asked: Vec<&str> = m.get("permissions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for p in granted {
        if !valid_permission(p) {
            return Err(bad(format!("unknown permission \"{p}\"")));
        }
        if !asked.contains(&p.as_str()) {
            return Err(bad(format!("\"{p}\" is not a permission this plugin asks for")));
        }
    }
    Ok(())
}

fn row_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "identifier": r.get::<String, _>("identifier"),
        "manifest": r.get::<Value, _>("manifest"),
        "files": r.get::<Value, _>("files"),
        "granted": r.get::<Value, _>("granted"),
        "enabled": r.get::<bool, _>("enabled"),
        "source": r.get::<String, _>("source"),
        "installedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("installed_at"),
        "updatedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

/// `GET /api/plugins` — the signed-in person's plugins, with their files.
pub async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let rows = sqlx::query("SELECT identifier, manifest, files, granted, enabled, source, installed_at, updated_at FROM plugins WHERE user_id = $1 ORDER BY installed_at, identifier")
        .bind(user.id)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(json!({ "plugins": rows.iter().map(row_json).collect::<Vec<_>>() })))
}

/// `GET /api/plugins/catalog` — the built-in plugins.  Public: it is the same for everyone.
pub async fn catalog() -> Json<Value> {
    let plugins: Vec<Value> = CATALOG
        .iter()
        .map(|(manifest, files)| {
            let manifest: Value = serde_json::from_str(manifest).expect("server/plugins manifests are valid JSON");
            let files: Map<String, Value> = files.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect();
            json!({ "manifest": manifest, "files": files })
        })
        .collect();
    Json(json!({ "plugins": plugins }))
}

#[derive(Deserialize)]
pub struct InstallRequest {
    manifest: Value,
    files: Map<String, Value>,
    #[serde(default)]
    granted: Vec<String>,
    #[serde(default)]
    source: String,
}

/// `PUT /api/plugins/{identifier}` — install a plugin, or replace the installed copy.
pub async fn install(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(identifier): Path<String>,
    LenientJson(req): LenientJson<InstallRequest>,
) -> AppResult<Json<Value>> {
    check(&identifier, &req.manifest, &req.files, &req.granted)?;
    let source: String = req.source.chars().filter(|c| !c.is_control()).take(500).collect();
    let have: i64 = sqlx::query_scalar("SELECT count(*) FROM plugins WHERE user_id = $1 AND identifier <> $2")
        .bind(user.id)
        .bind(&identifier)
        .fetch_one(&state.pool)
        .await?;
    if have >= MAX_PLUGINS {
        return Err(bad(format!("an account holds at most {MAX_PLUGINS} plugins; uninstall one first")));
    }
    sqlx::query(
        "INSERT INTO plugins (user_id, identifier, manifest, files, granted, source) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, identifier) DO UPDATE SET manifest = EXCLUDED.manifest, files = EXCLUDED.files, granted = EXCLUDED.granted, source = EXCLUDED.source, updated_at = now()",
    )
    .bind(user.id)
    .bind(&identifier)
    .bind(&req.manifest)
    .bind(Value::Object(req.files))
    .bind(json!(req.granted))
    .bind(&source)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct StateRequest {
    enabled: bool,
}

/// `POST /api/plugins/{identifier}/state` — enable or disable an installed plugin.
pub async fn set_state(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(identifier): Path<String>,
    LenientJson(req): LenientJson<StateRequest>,
) -> AppResult<Json<Value>> {
    let done = sqlx::query("UPDATE plugins SET enabled = $3 WHERE user_id = $1 AND identifier = $2")
        .bind(user.id)
        .bind(&identifier)
        .bind(req.enabled)
        .execute(&state.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/plugins/{identifier}`
pub async fn uninstall(State(state): State<AppState>, AuthUser(user): AuthUser, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM plugins WHERE user_id = $1 AND identifier = $2")
        .bind(user.id)
        .bind(&identifier)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entry: &str) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert(entry.to_string(), Value::String("kicad.actions.register('a', () => {});".into()));
        m
    }
    fn manifest(perms: &[&str]) -> Value {
        json!({ "identifier": "com.example.p", "name": "P", "description": "", "runtime": { "type": "web", "entrypoint": "main.js" }, "permissions": perms, "actions": [] })
    }

    #[test]
    fn accepts_a_plain_plugin() {
        assert!(check("com.example.p", &manifest(&["design:read"]), &files("main.js"), &["design:read".into()]).is_ok());
    }

    #[test]
    fn grants_cannot_exceed_the_manifest() {
        assert!(check("com.example.p", &manifest(&["design:read"]), &files("main.js"), &["design:write".into()]).is_err());
        assert!(check("com.example.p", &manifest(&[]), &files("main.js"), &["network:evil.example".into()]).is_err());
    }

    #[test]
    fn rejects_what_is_not_a_web_plugin() {
        let mut m = manifest(&[]);
        m["runtime"]["type"] = json!("python");
        assert!(check("com.example.p", &m, &files("main.js"), &[]).is_err());
        assert!(check("com.example.other", &manifest(&[]), &files("main.js"), &[]).is_err());
        assert!(check("com.example.p", &manifest(&[]), &files("other.js"), &[]).is_err());
        assert!(check("com.example.p", &manifest(&[]), &files("../main.js"), &[]).is_err());
    }

    #[test]
    fn the_catalog_is_installable() {
        for (m, fs) in CATALOG {
            let m: Value = serde_json::from_str(m).unwrap();
            let id = m["identifier"].as_str().unwrap().to_string();
            let files: Map<String, Value> = fs.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect();
            let granted: Vec<String> = m["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
            check(&id, &m, &files, &granted).unwrap_or_else(|e| panic!("{id}: {e}"));
        }
    }
}
