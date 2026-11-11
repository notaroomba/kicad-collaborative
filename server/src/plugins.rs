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

// ---------------------------------------------------------------- the community registry

/// Identifiers under this prefix are the built-in catalog's; nobody may publish under it.
const RESERVED_PREFIX: &str = "dev.notaroomba.kicad-collab.";

fn catalog_entry(identifier: &str) -> Option<(Value, Map<String, Value>)> {
    CATALOG.iter().find_map(|(manifest, files)| {
        let manifest: Value = serde_json::from_str(manifest).ok()?;
        if manifest.get("identifier").and_then(Value::as_str) != Some(identifier) {
            return None;
        }
        Some((manifest, files.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect()))
    })
}

#[derive(Deserialize)]
pub struct RegistryQuery {
    #[serde(default)]
    q: String,
}

/// `GET /api/plugins/registry?q=` — published plugins, newest first, with who published
/// each and how many people have it installed.  Public, like the catalog; files are left
/// out of the listing and fetched per plugin.
pub async fn registry_list(State(state): State<AppState>, axum::extract::Query(query): axum::extract::Query<RegistryQuery>) -> AppResult<Json<Value>> {
    let q: String = query.q.trim().chars().take(80).collect();
    let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = sqlx::query(
        "SELECT r.identifier, r.manifest, r.published_at, r.updated_at, u.login,
                (SELECT count(*) FROM plugins p WHERE p.identifier = r.identifier AND p.source LIKE 'registry:%') AS installs
         FROM plugin_registry r JOIN users u ON u.id = r.owner_id
         WHERE $1 = '' OR r.identifier ILIKE $2 OR r.manifest->>'name' ILIKE $2 OR r.manifest->>'description' ILIKE $2 OR u.login ILIKE $2
         ORDER BY r.updated_at DESC LIMIT 200",
    )
    .bind(&q)
    .bind(&like)
    .fetch_all(&state.pool)
    .await?;
    let plugins: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "identifier": r.get::<String, _>("identifier"),
                "manifest": r.get::<Value, _>("manifest"),
                "publisher": r.get::<String, _>("login"),
                "installs": r.get::<i64, _>("installs"),
                "publishedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("published_at"),
                "updatedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "plugins": plugins })))
}

/// `GET /api/plugins/registry/{identifier}` — one published plugin with its files.
pub async fn registry_get(State(state): State<AppState>, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    let r = sqlx::query("SELECT r.manifest, r.files, r.updated_at, u.login FROM plugin_registry r JOIN users u ON u.id = r.owner_id WHERE r.identifier = $1")
        .bind(&identifier)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(json!({
        "manifest": r.get::<Value, _>("manifest"),
        "files": r.get::<Value, _>("files"),
        "publisher": r.get::<String, _>("login"),
        "updatedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })))
}

#[derive(Deserialize)]
pub struct PublishRequest {
    manifest: Value,
    files: Map<String, Value>,
}

/// `PUT /api/plugins/registry/{identifier}` — publish a plugin, or a new version of one
/// the caller published.  The identifier is theirs from then on.
pub async fn registry_publish(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(identifier): Path<String>,
    LenientJson(req): LenientJson<PublishRequest>,
) -> AppResult<Json<Value>> {
    check(&identifier, &req.manifest, &req.files, &[])?;
    if identifier.starts_with(RESERVED_PREFIX) || catalog_entry(&identifier).is_some() {
        return Err(bad("that identifier belongs to the built-in catalog; publish under an identifier of your own"));
    }
    if req.manifest.get("version").and_then(Value::as_str).map(|v| v.is_empty() || v.len() > 40).unwrap_or(true) {
        return Err(bad("a published plugin needs a version in its manifest, so people can tell an update from what they have"));
    }
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM plugin_registry WHERE identifier = $1").bind(&identifier).fetch_optional(&state.pool).await?;
    if owner.is_some_and(|o| o != user.id) {
        return Err(AppError::Api(axum::http::StatusCode::CONFLICT, "identifier_taken", "someone else has published a plugin with that identifier".into()));
    }
    let mine: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_registry WHERE owner_id = $1 AND identifier <> $2").bind(user.id).bind(&identifier).fetch_one(&state.pool).await?;
    if mine >= MAX_PLUGINS {
        return Err(bad(format!("an account publishes at most {MAX_PLUGINS} plugins")));
    }
    sqlx::query(
        "INSERT INTO plugin_registry (identifier, owner_id, manifest, files) VALUES ($1, $2, $3, $4)
         ON CONFLICT (identifier) DO UPDATE SET manifest = EXCLUDED.manifest, files = EXCLUDED.files, updated_at = now() WHERE plugin_registry.owner_id = EXCLUDED.owner_id",
    )
    .bind(&identifier)
    .bind(user.id)
    .bind(&req.manifest)
    .bind(Value::Object(req.files))
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/plugins/registry/{identifier}` — unpublish.  Copies people already
/// installed stay theirs; projects stop recommending it.
pub async fn registry_unpublish(State(state): State<AppState>, AuthUser(user): AuthUser, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    let done = sqlx::query("DELETE FROM plugin_registry WHERE identifier = $1 AND owner_id = $2").bind(&identifier).bind(user.id).execute(&state.pool).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("DELETE FROM project_plugins WHERE identifier = $1 AND origin = 'registry'").bind(&identifier).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------- what a project recommends

/// `GET /api/projects/{id}/plugins` — the plugins this project suggests, each with the
/// copy to install.  Anyone who can open the project can see them; seeing is all it does.
pub async fn project_list(State(state): State<AppState>, AuthUser(user): AuthUser, Path(project_id): Path<uuid::Uuid>) -> AppResult<Json<Value>> {
    let role = crate::persist::effective_role(&state.pool, user.id, project_id).await?.ok_or(AppError::Forbidden)?;
    let rows = sqlx::query(
        "SELECT pp.identifier, pp.origin, u.login AS added_by, r.manifest, r.files, ru.login AS publisher
         FROM project_plugins pp
         LEFT JOIN users u ON u.id = pp.added_by
         LEFT JOIN plugin_registry r ON pp.origin = 'registry' AND r.identifier = pp.identifier
         LEFT JOIN users ru ON ru.id = r.owner_id
         WHERE pp.project_id = $1 ORDER BY pp.added_at",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    let mut plugins = Vec::new();
    for r in &rows {
        let identifier: String = r.get("identifier");
        let origin: String = r.get("origin");
        let (manifest, files, publisher) = if origin == "catalog" {
            match catalog_entry(&identifier) {
                Some((m, f)) => (m, Value::Object(f), None),
                None => continue,
            }
        } else {
            match r.get::<Option<Value>, _>("manifest") {
                Some(m) => (m, r.get::<Value, _>("files"), r.get::<Option<String>, _>("publisher")),
                None => continue,
            }
        };
        plugins.push(json!({ "identifier": identifier, "origin": origin, "addedBy": r.get::<Option<String>, _>("added_by"), "publisher": publisher, "manifest": manifest, "files": files }));
    }
    Ok(Json(json!({ "plugins": plugins, "canEdit": role == "editor" })))
}

#[derive(Deserialize)]
pub struct RecommendRequest {
    origin: String,
}

/// `PUT /api/projects/{id}/plugins/{identifier}` — an editor recommends a catalog or
/// registry plugin to the project's collaborators.
pub async fn project_recommend(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((project_id, identifier)): Path<(uuid::Uuid, String)>,
    LenientJson(req): LenientJson<RecommendRequest>,
) -> AppResult<Json<Value>> {
    if crate::persist::effective_role(&state.pool, user.id, project_id).await?.as_deref() != Some("editor") {
        return Err(AppError::Forbidden);
    }
    let known = match req.origin.as_str() {
        "catalog" => catalog_entry(&identifier).is_some(),
        "registry" => sqlx::query_scalar::<_, i64>("SELECT count(*) FROM plugin_registry WHERE identifier = $1").bind(&identifier).fetch_one(&state.pool).await? > 0,
        _ => return Err(bad("origin is catalog or registry")),
    };
    if !known {
        return Err(bad("only a plugin from the catalog or the registry can be recommended, so that collaborators can get it"));
    }
    let have: i64 = sqlx::query_scalar("SELECT count(*) FROM project_plugins WHERE project_id = $1").bind(project_id).fetch_one(&state.pool).await?;
    if have >= 30 {
        return Err(bad("a project recommends at most 30 plugins"));
    }
    sqlx::query("INSERT INTO project_plugins (project_id, identifier, origin, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, identifier) DO UPDATE SET origin = EXCLUDED.origin")
        .bind(project_id)
        .bind(&identifier)
        .bind(&req.origin)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/projects/{id}/plugins/{identifier}`
pub async fn project_unrecommend(State(state): State<AppState>, AuthUser(user): AuthUser, Path((project_id, identifier)): Path<(uuid::Uuid, String)>) -> AppResult<Json<Value>> {
    if crate::persist::effective_role(&state.pool, user.id, project_id).await?.as_deref() != Some("editor") {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM project_plugins WHERE project_id = $1 AND identifier = $2").bind(project_id).bind(&identifier).execute(&state.pool).await?;
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
