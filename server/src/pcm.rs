//! KiCad's official plugins for the web editor.
//!
//! The desktop installs plugins from KiCad's Plugin and Content Manager repository.  The web
//! editor runs the same Python packages inside the plugin sandbox (web/plugins/pyruntime.ts:
//! CPython compiled to WebAssembly, with `pcbnew` and `wx` provided over the collaborative
//! board), so this module does the two things a browser cannot: read the repository's package
//! list, and download and unpack one package.  What it hands back goes through the same
//! consent sheet and the same per-account store as any other plugin (plugins.rs).
//!
//! The server only ever fetches the repository index and the download addresses that index
//! names; nothing in a request chooses an address.  `KC_PCM_REPOSITORY` points it at another
//! index (tests use a local one).
//!
//! It also serves the Python runtime itself (`/static/pyodide/…`): the interpreter, its
//! standard library and our shim modules, readable from the sandbox's opaque origin.

use std::io::Read;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};

const DEFAULT_REPOSITORY: &str = "https://repository.kicad.org/repository.json";
const INDEX_TTL: Duration = Duration::from_secs(3600);
const MAX_INDEX_BYTES: usize = 24 * 1024 * 1024;
const MAX_ZIP_BYTES: usize = 24 * 1024 * 1024;
/// What one Python plugin may hold once unpacked (plugins.rs enforces the same on install).
pub const MAX_PY_FILES: usize = 1500;
pub const MAX_PY_BYTES: usize = 12 * 1024 * 1024;
const MAX_ONE_FILE: usize = 3 * 1024 * 1024;

/// The permissions a KiCad Python plugin is given: what `pcbnew` and `wx` need, and no network.
pub const PY_PERMISSIONS: &[&str] = &["design:read", "design:write", "view", "files:import", "files:export"];

/// How each official plugin fared against the web runtime (scripts/plugins-python.mjs).
const COMPAT: &str = include_str!("../plugins/python/compat.json");

fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadRequest(msg.into())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("kicad-collab-server (plugin repository)")
            .build()
            .unwrap_or_default()
    })
}

async fn fetch(url: &str, limit: usize) -> AppResult<Vec<u8>> {
    let local = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !url.starts_with("https://") && !(local && std::env::var("KC_PCM_REPOSITORY").is_ok()) {
        return Err(bad("the plugin repository named an address that is not https"));
    }
    let resp = http().get(url).send().await.map_err(|e| bad(format!("could not reach {}: {e}", host_of(url))))?;
    if !resp.status().is_success() {
        return Err(bad(format!("{} answered {}", host_of(url), resp.status().as_u16())));
    }
    let body = resp.bytes().await.map_err(|e| bad(format!("the download from {} was cut off: {e}", host_of(url))))?;
    if body.len() > limit {
        return Err(bad("that download is larger than the web editor accepts"));
    }
    Ok(body.to_vec())
}

fn host_of(url: &str) -> &str {
    url.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

type Index = Arc<Vec<Value>>;

/// The repository's plugin packages, cached for an hour.
async fn index() -> AppResult<Index> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, Index)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut slot = cache.lock().await;
    if let Some((at, idx)) = slot.as_ref() {
        if at.elapsed() < INDEX_TTL {
            return Ok(idx.clone());
        }
    }
    let repo_url = std::env::var("KC_PCM_REPOSITORY").unwrap_or_else(|_| DEFAULT_REPOSITORY.to_string());
    let loaded: AppResult<Index> = async {
        let repo: Value = serde_json::from_slice(&fetch(&repo_url, MAX_INDEX_BYTES).await?).map_err(|_| bad("KiCad's plugin repository sent something that is not JSON"))?;
        let packages_url = repo.pointer("/packages/url").and_then(Value::as_str).ok_or_else(|| bad("KiCad's plugin repository names no package list"))?;
        let raw = fetch(packages_url, MAX_INDEX_BYTES).await?;
        if let Some(want) = repo.pointer("/packages/sha256").and_then(Value::as_str) {
            if !want.eq_ignore_ascii_case(&hex(&Sha256::digest(&raw))) {
                return Err(bad("KiCad's package list does not match its checksum"));
            }
        }
        let list: Value = serde_json::from_slice(&raw).map_err(|_| bad("KiCad's package list is not JSON"))?;
        let packages = list.get("packages").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(Arc::new(packages.into_iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("plugin")).collect()))
    }
    .await;
    match loaded {
        Ok(idx) => {
            *slot = Some((Instant::now(), idx.clone()));
            Ok(idx)
        }
        // A repository that is briefly unreachable does not take the list away.
        Err(e) => slot.as_ref().map(|(_, idx)| idx.clone()).ok_or(e),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The version of a package the web runtime should install: the newest listed one.
fn pick_version(pkg: &Value) -> Option<&Value> {
    let versions = pkg.get("versions").and_then(Value::as_array)?;
    versions.iter().rev().find(|v| v.get("download_url").and_then(Value::as_str).is_some() && v.get("status").and_then(Value::as_str) != Some("deprecated")).or_else(|| versions.iter().rev().find(|v| v.get("download_url").is_some()))
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", s[..end].trim_end())
}

fn runtime_of(version: &Value) -> &str {
    match version.get("runtime").and_then(Value::as_str) {
        Some("ipc") => "ipc",
        _ => "swig",
    }
}

fn compat_of(identifier: &str) -> Value {
    static TABLE: OnceLock<Value> = OnceLock::new();
    let table = TABLE.get_or_init(|| serde_json::from_str(COMPAT).unwrap_or(Value::Null));
    table.get(identifier).cloned().unwrap_or(Value::Null)
}

/// The manifest a PCM package gets in the web plugin store.
fn manifest_of(pkg: &Value, version: &Value) -> Value {
    let s = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    json!({
        "identifier": s(pkg, "identifier"),
        "name": clip(&s(pkg, "name"), 200),
        "description": clip(&s(pkg, "description"), 500),
        "version": clip(&s(version, "version"), 40),
        "author": clip(pkg.pointer("/author/name").and_then(Value::as_str).unwrap_or(""), 120),
        "homepage": pkg.pointer("/resources/homepage").and_then(Value::as_str).filter(|u| u.starts_with("https://")).unwrap_or(""),
        "license": clip(&s(pkg, "license"), 60),
        "runtime": { "type": "kicad-python", "api": runtime_of(version) },
        "permissions": PY_PERMISSIONS,
    })
}

/// `GET /api/plugins/pcm` — KiCad's official plugins, with how each fares in the web editor.
pub async fn list() -> AppResult<Json<Value>> {
    let idx = index().await?;
    let mut out = Vec::with_capacity(idx.len());
    for pkg in idx.iter() {
        let Some(version) = pick_version(pkg) else { continue };
        let identifier = pkg.get("identifier").and_then(Value::as_str).unwrap_or("");
        if identifier.is_empty() {
            continue;
        }
        out.push(json!({
            "identifier": identifier,
            "manifest": manifest_of(pkg, version),
            "details": clip(pkg.get("description_full").and_then(Value::as_str).unwrap_or(""), 1500),
            "size": version.get("download_size").and_then(Value::as_u64).unwrap_or(0),
            "compat": compat_of(identifier),
        }));
    }
    out.sort_by(|a, b| {
        let name = |v: &Value| v.pointer("/manifest/name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        name(a).cmp(&name(b))
    });
    Ok(Json(json!({ "plugins": out })))
}

fn is_text(path: &str, body: &[u8]) -> bool {
    const TEXT: &[&str] = &[
        "py", "pyi", "json", "txt", "md", "rst", "csv", "tsv", "xml", "xrc", "html", "htm", "css", "js", "yaml", "yml", "toml", "ini", "cfg", "conf", "fbp", "svg", "po", "pot", "lua",
        "sh", "bat", "in", "tpl", "template", "dru", "net", "cmp", "pro", "lib", "mod", "dcm", "kicad_pcb", "kicad_sch", "kicad_sym", "kicad_mod", "kicad_pro", "kicad_dru", "kicad_wks",
    ];
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    TEXT.contains(&ext.as_str()) && !body.contains(&0) && std::str::from_utf8(body).is_ok()
}

/// A file name the Python runtime can be handed (it only ever names a file in the sandbox's own memory).
pub fn valid_py_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 240 && !p.starts_with('/') && !p.contains("..") && !p.contains("//") && !p.contains('\\') && p.chars().all(|c| !c.is_control())
}

/// Unpack a PCM archive into the files the runtime needs: `plugins/`, `resources/` and `metadata.json`.
fn unpack(zip_bytes: Vec<u8>) -> AppResult<Map<String, Value>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|_| bad("the package is not a zip archive"))?;
    let mut files = Map::new();
    let mut total = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| bad("the package archive is damaged"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
        let wanted = name == "metadata.json" || name.starts_with("plugins/") || name.starts_with("resources/");
        if !wanted || !valid_py_path(&name) || name.contains("/__pycache__/") || name.ends_with(".pyc") || name.contains("/.git/") {
            continue;
        }
        if entry.size() as usize > MAX_ONE_FILE {
            continue;
        }
        let mut body = Vec::with_capacity(entry.size() as usize);
        entry.by_ref().take(MAX_ONE_FILE as u64 + 1).read_to_end(&mut body).map_err(|_| bad("the package archive is damaged"))?;
        if body.len() > MAX_ONE_FILE {
            continue;
        }
        let stored = if is_text(&name, &body) { String::from_utf8(body).unwrap_or_default() } else { format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&body)) };
        total += stored.len();
        if total > MAX_PY_BYTES || files.len() >= MAX_PY_FILES {
            return Err(bad("this plugin is larger than the web editor can hold (12 MB unpacked)"));
        }
        files.insert(name, Value::String(stored));
    }
    if !files.keys().any(|k| k.starts_with("plugins/")) {
        return Err(bad("the package holds no plugin code"));
    }
    Ok(files)
}

/// `GET /api/plugins/pcm/{identifier}` — download one official plugin and hand its manifest and files to the browser.
pub async fn get(AuthUser(_user): AuthUser, Path(identifier): Path<String>) -> AppResult<Json<Value>> {
    let idx = index().await?;
    let pkg = idx.iter().find(|p| p.get("identifier").and_then(Value::as_str) == Some(identifier.as_str())).ok_or_else(|| AppError::NotFound)?;
    let version = pick_version(pkg).ok_or_else(|| bad("that plugin has no downloadable version"))?;
    let url = version.get("download_url").and_then(Value::as_str).unwrap_or("");
    let zip_bytes = fetch(url, MAX_ZIP_BYTES).await?;
    if let Some(want) = version.get("download_sha256").and_then(Value::as_str) {
        if !want.eq_ignore_ascii_case(&hex(&Sha256::digest(&zip_bytes))) {
            return Err(bad("the download does not match the checksum KiCad's repository lists for it"));
        }
    }
    let files = tokio::task::spawn_blocking(move || unpack(zip_bytes)).await.map_err(|_| bad("the package could not be unpacked"))??;
    let ver = version.get("version").and_then(Value::as_str).unwrap_or("");
    Ok(Json(json!({ "manifest": manifest_of(pkg, version), "files": files, "source": format!("kicad:{ver}"), "compat": compat_of(&identifier) })))
}

// ---------------------------------------------------------------- the Python runtime's files

/// Where the built runtime lives: `npm run build` writes it to static/dist/pyodide, and the
/// image carries it beside the binary.  It is read from disk rather than compiled in: it is
/// 14 MB that the server never looks inside, and a `cargo build` without node still works.
fn runtime_dir() -> Option<&'static std::path::PathBuf> {
    static DIR: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let mut tries: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(d) = std::env::var("KC_PYODIDE_DIR") { tries.push(d.into()); }
        tries.push("static/dist/pyodide".into());
        tries.push(concat!(env!("CARGO_MANIFEST_DIR"), "/static/dist/pyodide").into());
        tries.push("/usr/local/share/kicad-collab/pyodide".into());
        tries.into_iter().find(|d| d.join("pyodide.asm.wasm").is_file() && d.join("kicad-python.json").is_file())
    }).as_ref()
}

/// `GET /static/pyodide/{file}` — the interpreter, its standard library and our shim modules.
/// The sandbox frame has an opaque origin, so these are readable from anywhere; they hold
/// nothing that is not already public.
pub async fn runtime(Path(file): Path<String>) -> Response {
    let kind = match file.as_str() {
        "pyodide.js" | "pyodide.asm.mjs" => "application/javascript; charset=utf-8",
        "pyodide.asm.wasm" => "application/wasm",
        "python_stdlib.zip" => "application/zip",
        "pyodide-lock.json" | "kicad-python.json" => "application/json; charset=utf-8",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let Some(dir) = runtime_dir() else { return (StatusCode::SERVICE_UNAVAILABLE, "the Python runtime is not built on this server (npm run build)").into_response() };
    let Ok(body) = tokio::fs::read(dir.join(&file)).await else { return StatusCode::NOT_FOUND.into_response() };
    // The shim changes with every build of ours; the interpreter only with its version.
    let cache = if file == "kicad-python.json" { "no-cache" } else { "public, max-age=86400" };
    ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, cache), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::HeaderName::from_static("cross-origin-resource-policy"), "cross-origin")], body).into_response()
}
