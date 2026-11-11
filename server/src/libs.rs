//! Read-only access to KiCad's official symbol and footprint libraries for the web editor's
//! Choose Symbol / Choose Footprint dialogs and library browsers.
//!
//! Routes (signed-in users only, all `GET`, all JSON):
//!
//! * `/api/libs/symbols`                  → `{ ref, libraries: [{ name, description }] }`
//! * `/api/libs/symbols/{lib}`            → `{ library, symbols: [{ n, d, k, r, u, p?, e?, f?, ff? }] }`
//!   — a compact index: name, description, keywords, reference prefix, unit count, power flag,
//!   parent ("extends"), default footprint and footprint filters.  No geometry.
//! * `/api/libs/symbols/{lib}/{name}`     → `{ library, name, libId, symbol, parents: [..] }`
//!   — the `(symbol …)` s-expression exactly as the library stores it, plus the chain of
//!   parents a derived symbol extends (nearest first) so the client can flatten it.
//! * `/api/libs/footprints`               → `{ ref, libraries: [{ name, description }] }`
//! * `/api/libs/footprints/{lib}`         → `{ library, footprints: [{ n, d, k, p }] }` (`{lib}` may carry `.pretty`)
//! * `/api/libs/footprints/{lib}/{name}`  → `{ library, name, fpid, footprint }` — the `.kicad_mod` text
//!
//! The libraries come on demand from the official upstream repositories
//! (gitlab.com/kicad/libraries/kicad-symbols and kicad-footprints) at one pinned ref: the first
//! request for a kind downloads that repository's archive of the ref once (about 30 MB for the
//! symbols) and keeps it on disk (`KC_LIBS_CACHE_DIR`); the library table and every library are
//! then read out of that archive.  (GitLab throttles per-directory archive requests hard, and the
//! chooser wants the index of every library, so one download beats two hundred.)  A
//! `*.kicad_symdir` holds one symbol per file since KiCad 10; older refs keep one
//! `<lib>.kicad_sym` per library, and both layouts are read.  A parsed library stays in memory
//! under a byte budget, its compact index for good (and on disk across restarts).
//!
//! Environment:
//!
//! * `KC_LIBS_REF`             tag / branch / commit of both repositories (default `10.0.8`)
//! * `KC_LIBS_SYMBOLS_URL`     URL of the repository's zip archive (`{ref}` is replaced by the ref), or a
//!                             local directory laid out like the repository (tests, air-gapped installs)
//! * `KC_LIBS_FOOTPRINTS_URL`  likewise for footprints
//! * `KC_LIBS_CACHE_DIR`       download cache (default `./libs-cache`)
//! * `SSL_CERT_FILE`           extra PEM roots to trust (an egress proxy that re-terminates TLS)

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::AppState;

const DEFAULT_REF: &str = "10.0.8";
const DEFAULT_SYMBOLS_URL: &str = "https://gitlab.com/kicad/libraries/kicad-symbols/-/archive/{ref}/kicad-symbols-{ref}.zip";
const DEFAULT_FOOTPRINTS_URL: &str = "https://gitlab.com/kicad/libraries/kicad-footprints/-/archive/{ref}/kicad-footprints-{ref}.zip";
/// A repository archive may not exceed this.
const MAX_DOWNLOAD_BYTES: u64 = 768 * 1024 * 1024;
/// Unpacked size of one library; the biggest official ones are a few tens of MB.
const MAX_LIBRARY_BYTES: usize = 256 * 1024 * 1024;
/// Parsed libraries kept in memory (source text), least recently used dropped first.
const MEMORY_BUDGET_BYTES: usize = 192 * 1024 * 1024;
/// The whole archive download; a stalled transfer is cut after STALL_TIMEOUT without a byte.
const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// After a failed download the upstream is left alone this long (it answers 429 when pressed).
const RETRY_AFTER: Duration = Duration::from_secs(60);
const MAX_NAME_LEN: usize = 120;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/libs/symbols", get(symbol_libraries))
        .route("/api/libs/symbols/{lib}", get(symbol_index))
        .route("/api/libs/symbols/{lib}/{name}", get(symbol))
        .route("/api/libs/footprints", get(footprint_libraries))
        .route("/api/libs/footprints/{lib}", get(footprint_index))
        .route("/api/libs/footprints/{lib}/{name}", get(footprint))
}

// ---------------------------------------------------------------- errors

#[derive(Debug)]
pub enum LibError {
    NotFound,
    BadName,
    /// The upstream (or the fixture directory) could not deliver; the message is safe to show.
    Upstream(String),
    /// The upstream refused a moment ago: try again in this many seconds.
    Busy(u64, String),
}

impl IntoResponse for LibError {
    fn into_response(self) -> Response {
        if let LibError::Busy(secs, m) = self {
            let body = Json(json!({ "error": "busy", "message": m, "retryAfter": secs }));
            return (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, secs.to_string())], body).into_response();
        }
        let (status, code, msg) = match self {
            LibError::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found".to_string()),
            LibError::BadName => (StatusCode::BAD_REQUEST, "bad_request", "invalid library or item name".to_string()),
            LibError::Busy(_, m) | LibError::Upstream(m) => {
                tracing::warn!("library upstream: {m}");
                (StatusCode::BAD_GATEWAY, "upstream", m)
            }
        };
        (status, Json(json!({ "error": code, "message": msg }))).into_response()
    }
}

type LibResult<T> = Result<T, LibError>;

// ---------------------------------------------------------------- s-expressions (just enough to index a library)

#[derive(Debug)]
enum Sx {
    Atom(String),
    /// Children plus the byte span of the list in the source, parentheses included.
    List(Vec<Sx>, usize, usize),
}

impl Sx {
    fn head(&self) -> &str {
        match self {
            Sx::List(c, _, _) => c.first().and_then(Sx::atom).unwrap_or(""),
            Sx::Atom(_) => "",
        }
    }
    fn atom(&self) -> Option<&str> {
        match self {
            Sx::Atom(s) => Some(s),
            Sx::List(..) => None,
        }
    }
    fn children(&self) -> &[Sx] {
        match self {
            Sx::List(c, _, _) => c,
            Sx::Atom(_) => &[],
        }
    }
    fn arg(&self, i: usize) -> Option<&str> {
        self.children().get(i).and_then(Sx::atom)
    }
    fn lists<'a>(&'a self, head: &'a str) -> impl Iterator<Item = &'a Sx> + 'a {
        self.children().iter().filter(move |c| c.head() == head)
    }
    fn list(&self, head: &str) -> Option<&Sx> {
        self.children().iter().find(|c| c.head() == head)
    }
    fn span(&self) -> (usize, usize) {
        match self {
            Sx::List(_, a, b) => (*a, *b),
            Sx::Atom(_) => (0, 0),
        }
    }
}

/// Parse every top-level list of `src`.  Lenient: an unterminated list ends at the end of input.
fn parse_sexpr(src: &str) -> Vec<Sx> {
    let b = src.as_bytes();
    let mut i = 0usize;
    let mut stack: Vec<(Vec<Sx>, usize)> = Vec::new();
    let mut top: Vec<Sx> = Vec::new();
    while i < b.len() {
        match b[i] {
            b'(' => {
                stack.push((Vec::new(), i));
                i += 1;
            }
            b')' => {
                i += 1;
                if let Some((children, start)) = stack.pop() {
                    let node = Sx::List(children, start, i);
                    match stack.last_mut() {
                        Some((parent, _)) => parent.push(node),
                        None => top.push(node),
                    }
                }
            }
            b'"' => {
                i += 1;
                let mut out: Vec<u8> = Vec::new();
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' && i + 1 < b.len() {
                        i += 1;
                        out.push(match b[i] {
                            b'n' => b'\n',
                            b't' => b'\t',
                            b'r' => b'\r',
                            c => c,
                        });
                    } else {
                        out.push(b[i]);
                    }
                    i += 1;
                }
                i += 1;
                if let Some((parent, _)) = stack.last_mut() {
                    parent.push(Sx::Atom(String::from_utf8_lossy(&out).into_owned()));
                }
            }
            c if c.is_ascii_whitespace() => i += 1,
            _ => {
                let start = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'(' && b[i] != b')' && b[i] != b'"' {
                    i += 1;
                }
                if let Some((parent, _)) = stack.last_mut() {
                    parent.push(Sx::Atom(src[start..i].to_string()));
                }
            }
        }
    }
    while let Some((children, start)) = stack.pop() {
        let node = Sx::List(children, start, b.len());
        match stack.last_mut() {
            Some((parent, _)) => parent.push(node),
            None => top.push(node),
        }
    }
    top
}

// ---------------------------------------------------------------- parsed libraries

struct SymbolEntry {
    text: String,
    extends: Option<String>,
}

struct SymbolLib {
    index: String,
    symbols: HashMap<String, SymbolEntry>,
    bytes: usize,
}

struct FootprintLib {
    index: String,
    footprints: HashMap<String, String>,
    bytes: usize,
}

struct SymbolMeta {
    name: String,
    description: String,
    keywords: String,
    reference: String,
    footprint: String,
    fp_filters: String,
    extends: Option<String>,
    power: bool,
    units: u32,
}

/// `Name_<unit>_<bodyStyle>` → unit.
fn unit_of(sub: &str) -> Option<u32> {
    let mut it = sub.rsplitn(3, '_');
    let style = it.next()?;
    let unit = it.next()?;
    it.next()?;
    style.parse::<u32>().ok()?;
    unit.parse::<u32>().ok()
}

fn index_symbols(src: &str, out: &mut Vec<SymbolMeta>, texts: &mut HashMap<String, SymbolEntry>) {
    for top in parse_sexpr(src) {
        if top.head() != "kicad_symbol_lib" {
            continue;
        }
        for sym in top.lists("symbol") {
            let Some(name) = sym.arg(1) else { continue };
            let mut m = SymbolMeta {
                name: name.to_string(),
                description: String::new(),
                keywords: String::new(),
                reference: String::new(),
                footprint: String::new(),
                fp_filters: String::new(),
                extends: sym.list("extends").and_then(|e| e.arg(1)).map(str::to_string),
                power: sym.list("power").is_some(),
                units: 0,
            };
            for p in sym.lists("property") {
                let (Some(k), Some(v)) = (p.arg(1), p.arg(2)) else { continue };
                match k {
                    "Description" | "ki_description" => m.description = v.to_string(),
                    "ki_keywords" => m.keywords = v.to_string(),
                    "Reference" => m.reference = v.to_string(),
                    "Footprint" => m.footprint = v.to_string(),
                    "ki_fp_filters" => m.fp_filters = v.to_string(),
                    _ => {}
                }
            }
            for sub in sym.lists("symbol") {
                if let Some(u) = sub.arg(1).and_then(unit_of) {
                    m.units = m.units.max(u);
                }
            }
            let (a, b) = sym.span();
            texts.insert(name.to_string(), SymbolEntry { text: src[a..b].to_string(), extends: m.extends.clone() });
            out.push(m);
        }
    }
}

fn build_symbol_lib(lib: &str, sources: Vec<String>) -> SymbolLib {
    let mut metas = Vec::new();
    let mut symbols = HashMap::new();
    for src in &sources {
        index_symbols(src, &mut metas, &mut symbols);
    }
    // A derived symbol draws its parent's body: units and the power flag come from the root.
    let by_name: HashMap<String, (Option<String>, bool, u32)> =
        metas.iter().map(|m| (m.name.clone(), (m.extends.clone(), m.power, m.units))).collect();
    for m in &mut metas {
        let mut parent = m.extends.clone();
        let mut depth = 0;
        while let Some(p) = parent {
            let Some((next, power, units)) = by_name.get(&p) else { break };
            m.power = m.power || *power;
            m.units = m.units.max(*units);
            parent = next.clone();
            depth += 1;
            if depth > 16 {
                break;
            }
        }
        m.units = m.units.max(1);
    }
    metas.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    let rows: Vec<Value> = metas
        .iter()
        .map(|m| {
            let mut o = json!({ "n": m.name, "d": m.description, "k": m.keywords, "r": m.reference, "u": m.units });
            if m.power {
                o["p"] = json!(true);
            }
            if let Some(e) = &m.extends {
                o["e"] = json!(e);
            }
            if !m.footprint.is_empty() {
                o["f"] = json!(m.footprint);
            }
            if !m.fp_filters.is_empty() {
                o["ff"] = json!(m.fp_filters);
            }
            o
        })
        .collect();
    let bytes = symbols.values().map(|s| s.text.len()).sum();
    SymbolLib { index: json!({ "library": lib, "symbols": rows }).to_string(), symbols, bytes }
}

fn build_footprint_lib(lib: &str, files: Vec<(String, String)>) -> FootprintLib {
    let mut rows: Vec<(String, Value)> = Vec::new();
    let mut footprints = HashMap::new();
    for (file_name, src) in files {
        let tops = parse_sexpr(&src);
        let Some(fp) = tops.iter().find(|t| matches!(t.head(), "footprint" | "module")) else { continue };
        // The file name is the footprint's identity in a .pretty library (FP_CACHE keys on it).
        let name = file_name.strip_suffix(".kicad_mod").unwrap_or(&file_name).to_string();
        let mut descr = fp.list("descr").and_then(|d| d.arg(1)).unwrap_or("").to_string();
        let tags = fp.list("tags").and_then(|d| d.arg(1)).unwrap_or("").to_string();
        for p in fp.lists("property") {
            if p.arg(1) == Some("Description") && descr.is_empty() {
                descr = p.arg(2).unwrap_or("").to_string();
            }
        }
        let mut pads: Vec<&str> = fp.lists("pad").filter_map(|p| p.arg(1)).filter(|n| !n.is_empty()).collect();
        pads.sort_unstable();
        pads.dedup();
        rows.push((name.to_lowercase(), json!({ "n": name, "d": descr, "k": tags, "p": pads.len() })));
        footprints.insert(name, src);
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let bytes = footprints.values().map(String::len).sum();
    let rows: Vec<Value> = rows.into_iter().map(|r| r.1).collect();
    FootprintLib { index: json!({ "library": lib, "footprints": rows }).to_string(), footprints, bytes }
}

/// `(sym_lib_table (lib (name X) … (descr "…")) …)` → `[{ name, description }]` in table order.
fn parse_lib_table(src: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for top in parse_sexpr(src) {
        for lib in top.lists("lib") {
            let Some(name) = lib.list("name").and_then(|n| n.arg(1)) else { continue };
            let descr = lib.list("descr").and_then(|n| n.arg(1)).unwrap_or("");
            if valid_name(name) {
                out.push((name.to_string(), descr.to_string()));
            }
        }
    }
    out
}

/// A library or item name that is safe inside a URL query and a cache file name.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name != "."
        && name != ".."
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | ',' | ' ' | '(' | ')' | '&'))
        && !name.starts_with(' ')
}

// ---------------------------------------------------------------- the store

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    Symbols,
    Footprints,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Kind::Symbols => "symbols",
            Kind::Footprints => "footprints",
        }
    }
    fn table(self) -> &'static str {
        match self {
            Kind::Symbols => "sym-lib-table",
            Kind::Footprints => "fp-lib-table",
        }
    }
    fn lib_dir(self, lib: &str) -> String {
        match self {
            Kind::Symbols => format!("{lib}.kicad_symdir"),
            Kind::Footprints => format!("{lib}.pretty"),
        }
    }
    fn item_ext(self) -> &'static str {
        match self {
            Kind::Symbols => ".kicad_sym",
            Kind::Footprints => ".kicad_mod",
        }
    }
}

enum Loaded {
    Symbols(Arc<SymbolLib>),
    Footprints(Arc<FootprintLib>),
}

impl Loaded {
    fn bytes(&self) -> usize {
        match self {
            Loaded::Symbols(l) => l.bytes,
            Loaded::Footprints(l) => l.bytes,
        }
    }
}

#[derive(Default)]
struct Memory {
    /// Most recently used last.
    libs: Vec<((Kind, String), Loaded)>,
    tables: HashMap<Kind, Arc<Vec<(String, String)>>>,
    /// The compact indexes stay for good: they are small, and the chooser asks for all of them.
    indexes: HashMap<(Kind, String), Arc<String>>,
    /// One lock per library being loaded: two requests for the same library share the download.
    loading: HashMap<(Kind, String), Arc<tokio::sync::Mutex<()>>>,
    /// The opened repository archives.
    repos: HashMap<Kind, Arc<Mutex<RepoZip>>>,
    /// A failed download: when the upstream may be asked again, and what it said.
    refused: HashMap<Kind, (std::time::Instant, String)>,
}

pub struct Libs {
    reference: String,
    symbols_base: String,
    footprints_base: String,
    cache_dir: PathBuf,
    http: reqwest::Client,
    memory: Mutex<Memory>,
    /// One archive download per kind at a time.
    fetching: [tokio::sync::Mutex<()>; 2],
}

fn http_client() -> reqwest::Client {
    let mut b = reqwest::Client::builder().timeout(FETCH_TIMEOUT).connect_timeout(Duration::from_secs(10));
    if let Some(pem) = std::env::var("SSL_CERT_FILE").ok().and_then(|p| std::fs::read(p).ok()) {
        if let Ok(certs) = reqwest::Certificate::from_pem_bundle(&pem) {
            for c in certs {
                b = b.add_root_certificate(c);
            }
        }
    }
    b.build().unwrap_or_default()
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

impl Libs {
    pub fn from_env() -> Libs {
        Libs::new(
            &env_or("KC_LIBS_REF", DEFAULT_REF),
            &env_or("KC_LIBS_SYMBOLS_URL", DEFAULT_SYMBOLS_URL),
            &env_or("KC_LIBS_FOOTPRINTS_URL", DEFAULT_FOOTPRINTS_URL),
            FsPath::new(&env_or("KC_LIBS_CACHE_DIR", "./libs-cache")),
        )
    }

    pub fn new(reference: &str, symbols_base: &str, footprints_base: &str, cache_dir: &FsPath) -> Libs {
        Libs {
            reference: reference.trim().to_string(),
            symbols_base: symbols_base.trim().to_string(),
            footprints_base: footprints_base.trim().to_string(),
            cache_dir: cache_dir.to_path_buf(),
            http: http_client(),
            memory: Mutex::new(Memory::default()),
            fetching: [tokio::sync::Mutex::new(()), tokio::sync::Mutex::new(())],
        }
    }

    fn base(&self, kind: Kind) -> &str {
        match kind {
            Kind::Symbols => &self.symbols_base,
            Kind::Footprints => &self.footprints_base,
        }
    }

    /// A base that is a directory on this machine (tests, air-gapped installs) rather than a URL.
    fn local_dir(&self, kind: Kind) -> Option<PathBuf> {
        let b = self.base(kind);
        if let Some(p) = b.strip_prefix("file://") {
            return Some(PathBuf::from(p));
        }
        if b.starts_with("http://") || b.starts_with("https://") {
            None
        } else {
            Some(PathBuf::from(b))
        }
    }

    fn cache_path(&self, kind: Kind, file: &str) -> PathBuf {
        let safe_ref: String =
            self.reference.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
        self.cache_dir.join(kind.dir()).join(safe_ref).join(file)
    }

    /// Stream the repository archive to `path` (atomically), within the size and stall limits.
    async fn download(&self, url: &str, path: &FsPath) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let mut resp = self
            .http
            .get(url)
            .header(reqwest::header::USER_AGENT, "kicad-collab-server")
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        if resp.content_length().map(|l| l > MAX_DOWNLOAD_BYTES).unwrap_or(false) {
            return Err("the archive is too large".into());
        }
        let dir = path.parent().ok_or("no cache directory")?;
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("cache directory: {e}"))?;
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| format!("cache file: {e}"))?;
        let mut total = 0u64;
        let result: Result<(), String> = async {
            loop {
                let chunk = tokio::time::timeout(STALL_TIMEOUT, resp.chunk())
                    .await
                    .map_err(|_| "the download stalled".to_string())?
                    .map_err(|e| e.without_url().to_string())?;
                let Some(chunk) = chunk else { break };
                total += chunk.len() as u64;
                if total > MAX_DOWNLOAD_BYTES {
                    return Err("the archive is too large".into());
                }
                file.write_all(&chunk).await.map_err(|e| format!("cache file: {e}"))?;
            }
            file.flush().await.map_err(|e| format!("cache file: {e}"))
        }
        .await;
        drop(file);
        match result {
            Ok(()) => tokio::fs::rename(&tmp, path).await.map_err(|e| format!("cache file: {e}")),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// The repository archive of one kind, downloaded once per ref and kept open.
    async fn repo(&self, kind: Kind) -> LibResult<Arc<Mutex<RepoZip>>> {
        if let Some(r) = self.memory.lock().unwrap().repos.get(&kind) {
            return Ok(r.clone());
        }
        let _guard = self.fetching[kind as usize].lock().await;
        if let Some(r) = self.memory.lock().unwrap().repos.get(&kind) {
            return Ok(r.clone());
        }
        let path = self.cache_path(kind, "repository.zip");
        if tokio::fs::metadata(&path).await.is_err() {
            if let Some((until, why)) = self.memory.lock().unwrap().refused.get(&kind).cloned() {
                let now = std::time::Instant::now();
                if until > now {
                    return Err(LibError::Busy((until - now).as_secs().max(1), why));
                }
            }
            let url = self.base(kind).replace("{ref}", &urlencode(&self.reference));
            tracing::info!("fetching the KiCad {} libraries at {}", kind.dir(), self.reference);
            if let Err(e) = self.download(&url, &path).await {
                let why = format!("could not fetch the KiCad {} libraries from upstream: {e}", kind.dir());
                self.memory.lock().unwrap().refused.insert(kind, (std::time::Instant::now() + RETRY_AFTER, why.clone()));
                return Err(LibError::Busy(RETRY_AFTER.as_secs(), why));
            }
        }
        let opened = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || RepoZip::open(&path, kind)).await.map_err(|e| LibError::Upstream(e.to_string()))?
        };
        let repo = match opened {
            Ok(r) => Arc::new(Mutex::new(r)),
            Err(e) => {
                // a damaged download must not stick: the next request fetches it again
                let _ = tokio::fs::remove_file(&path).await;
                return Err(e);
            }
        };
        self.memory.lock().unwrap().repos.insert(kind, repo.clone());
        Ok(repo)
    }

    /// The library table: `[(name, description)]`.
    async fn table(&self, kind: Kind) -> LibResult<Arc<Vec<(String, String)>>> {
        if let Some(t) = self.memory.lock().unwrap().tables.get(&kind) {
            return Ok(t.clone());
        }
        let rows = if let Some(dir) = self.local_dir(kind) {
            match tokio::fs::read_to_string(dir.join(kind.table())).await {
                Ok(text) => parse_lib_table(&text),
                Err(_) => local_libraries(&dir, kind),
            }
        } else {
            let repo = self.repo(kind).await?;
            tokio::task::spawn_blocking(move || repo.lock().unwrap().table()).await.map_err(|e| LibError::Upstream(e.to_string()))??
        };
        let rows = Arc::new(rows);
        self.memory.lock().unwrap().tables.insert(kind, rows.clone());
        Ok(rows)
    }

    fn remembered(&self, kind: Kind, lib: &str) -> Option<Loaded> {
        let mut m = self.memory.lock().unwrap();
        let i = m.libs.iter().position(|(k, _)| k.0 == kind && k.1 == lib)?;
        let entry = m.libs.remove(i);
        let out = match &entry.1 {
            Loaded::Symbols(l) => Loaded::Symbols(l.clone()),
            Loaded::Footprints(l) => Loaded::Footprints(l.clone()),
        };
        m.libs.push(entry);
        Some(out)
    }

    fn remember(&self, kind: Kind, lib: &str, loaded: Loaded) {
        let mut m = self.memory.lock().unwrap();
        m.libs.retain(|(k, _)| !(k.0 == kind && k.1 == lib));
        m.libs.push(((kind, lib.to_string()), loaded));
        let mut total: usize = m.libs.iter().map(|(_, l)| l.bytes()).sum();
        while total > MEMORY_BUDGET_BYTES && m.libs.len() > 1 {
            total -= m.libs.remove(0).1.bytes();
        }
    }

    /// The files of one library: `(file name, text)`.
    async fn library_files(&self, kind: Kind, lib: &str) -> LibResult<Vec<(String, String)>> {
        let lib = lib.to_string();
        if let Some(dir) = self.local_dir(kind) {
            return tokio::task::spawn_blocking(move || read_local_library(&dir, kind, &lib))
                .await
                .map_err(|e| LibError::Upstream(e.to_string()))?;
        }
        let repo = self.repo(kind).await?;
        tokio::task::spawn_blocking(move || repo.lock().unwrap().library(&lib)).await.map_err(|e| LibError::Upstream(e.to_string()))?
    }

    async fn load(&self, kind: Kind, lib: &str) -> LibResult<Loaded> {
        if !valid_name(lib) {
            return Err(LibError::BadName);
        }
        if let Some(l) = self.remembered(kind, lib) {
            return Ok(l);
        }
        // Only libraries the table lists are fetched: nothing else of the repository is reachable.
        if !self.table(kind).await?.iter().any(|(n, _)| n == lib) {
            return Err(LibError::NotFound);
        }
        let lock = {
            let mut m = self.memory.lock().unwrap();
            m.loading.entry((kind, lib.to_string())).or_default().clone()
        };
        let _guard = lock.lock().await;
        if let Some(l) = self.remembered(kind, lib) {
            return Ok(l);
        }
        let files = self.library_files(kind, lib).await?;
        let name = lib.to_string();
        let loaded = tokio::task::spawn_blocking(move || match kind {
            Kind::Symbols => Loaded::Symbols(Arc::new(build_symbol_lib(&name, files.into_iter().map(|f| f.1).collect()))),
            Kind::Footprints => Loaded::Footprints(Arc::new(build_footprint_lib(&name, files))),
        })
        .await
        .map_err(|e| LibError::Upstream(e.to_string()))?;
        let out = match &loaded {
            Loaded::Symbols(l) => Loaded::Symbols(l.clone()),
            Loaded::Footprints(l) => Loaded::Footprints(l.clone()),
        };
        let index = match &out {
            Loaded::Symbols(l) => l.index.clone(),
            Loaded::Footprints(l) => l.index.clone(),
        };
        if self.local_dir(kind).is_none() {
            // the index outlives a restart without unpacking the archive again
            let path = self.cache_path(kind, &format!("{lib}.index.json"));
            let tmp = path.with_extension(format!("tmp{}", std::process::id()));
            if tokio::fs::write(&tmp, &index).await.is_ok() && tokio::fs::rename(&tmp, &path).await.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
            }
        }
        {
            let mut m = self.memory.lock().unwrap();
            m.indexes.insert((kind, lib.to_string()), Arc::new(index));
            m.loading.remove(&(kind, lib.to_string()));
        }
        self.remember(kind, lib, loaded);
        Ok(out)
    }

    /// The compact index of one library: memory, then the disk cache, then a full load.
    async fn index_json(&self, kind: Kind, lib: &str) -> LibResult<String> {
        if !valid_name(lib) {
            return Err(LibError::BadName);
        }
        let key = (kind, lib.to_string());
        if let Some(i) = self.memory.lock().unwrap().indexes.get(&key) {
            return Ok(i.as_ref().clone());
        }
        if self.local_dir(kind).is_none() {
            if let Ok(text) = tokio::fs::read_to_string(self.cache_path(kind, &format!("{lib}.index.json"))).await {
                self.memory.lock().unwrap().indexes.insert(key, Arc::new(text.clone()));
                return Ok(text);
            }
        }
        Ok(match self.load(kind, lib).await? {
            Loaded::Symbols(l) => l.index.clone(),
            Loaded::Footprints(l) => l.index.clone(),
        })
    }

    async fn symbols(&self, lib: &str) -> LibResult<Arc<SymbolLib>> {
        match self.load(Kind::Symbols, lib).await? {
            Loaded::Symbols(l) => Ok(l),
            Loaded::Footprints(_) => Err(LibError::NotFound),
        }
    }

    async fn footprints(&self, lib: &str) -> LibResult<Arc<FootprintLib>> {
        match self.load(Kind::Footprints, lib).await? {
            Loaded::Footprints(l) => Ok(l),
            Loaded::Symbols(_) => Err(LibError::NotFound),
        }
    }

    pub async fn libraries_json(&self, symbols: bool) -> LibResult<String> {
        let kind = if symbols { Kind::Symbols } else { Kind::Footprints };
        let rows: Vec<Value> =
            self.table(kind).await?.iter().map(|(n, d)| json!({ "name": n, "description": d })).collect();
        Ok(json!({ "ref": self.reference, "libraries": rows }).to_string())
    }

    pub async fn symbol_index_json(&self, lib: &str) -> LibResult<String> {
        self.index_json(Kind::Symbols, lib).await
    }

    pub async fn symbol_json(&self, lib: &str, name: &str) -> LibResult<String> {
        let l = self.symbols(lib).await?;
        let entry = l.symbols.get(name).ok_or(LibError::NotFound)?;
        let mut parents: Vec<&str> = Vec::new();
        let mut next = entry.extends.as_deref();
        while let Some(p) = next {
            let Some(e) = l.symbols.get(p) else { break };
            parents.push(&e.text);
            next = e.extends.as_deref();
            if parents.len() > 16 {
                break;
            }
        }
        Ok(json!({ "library": lib, "name": name, "libId": format!("{lib}:{name}"), "symbol": entry.text, "parents": parents })
            .to_string())
    }

    pub async fn footprint_index_json(&self, lib: &str) -> LibResult<String> {
        self.index_json(Kind::Footprints, lib).await
    }

    pub async fn footprint_json(&self, lib: &str, name: &str) -> LibResult<String> {
        let l = self.footprints(lib).await?;
        let text = l.footprints.get(name).ok_or(LibError::NotFound)?;
        Ok(json!({ "library": lib, "name": name, "fpid": format!("{lib}:{name}"), "footprint": text }).to_string())
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Library names of a directory without a table: its `*.kicad_symdir` / `*.kicad_sym` / `*.pretty` entries.
fn local_libraries(dir: &FsPath, kind: Kind) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let lib = match kind {
                Kind::Symbols => name.strip_suffix(".kicad_symdir").or_else(|| name.strip_suffix(".kicad_sym")),
                Kind::Footprints => name.strip_suffix(".pretty"),
            };
            if let Some(lib) = lib.filter(|l| valid_name(l)) {
                if !out.iter().any(|(n, _)| n == lib) {
                    out.push((lib.to_string(), String::new()));
                }
            }
        }
    }
    out.sort();
    out
}

fn read_local_library(dir: &FsPath, kind: Kind, lib: &str) -> LibResult<Vec<(String, String)>> {
    let sub = dir.join(kind.lib_dir(lib));
    let mut out = Vec::new();
    let mut total = 0usize;
    if let Ok(rd) = std::fs::read_dir(&sub) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(kind.item_ext()) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(e.path()) {
                total += text.len();
                if total > MAX_LIBRARY_BYTES {
                    return Err(LibError::Upstream("the library is too large".into()));
                }
                out.push((name, text));
            }
        }
        out.sort();
        return Ok(out);
    }
    if kind == Kind::Symbols {
        let file = format!("{lib}.kicad_sym");
        if let Ok(text) = std::fs::read_to_string(dir.join(&file)) {
            return Ok(vec![(file, text)]);
        }
    }
    Err(LibError::NotFound)
}

/// A repository archive on disk (`<top>/<lib dir>/<item file>`, `<top>/<table>`), with the entries
/// of each library found once at open.
struct RepoZip {
    archive: zip::ZipArchive<std::fs::File>,
    libs: HashMap<String, Vec<String>>,
    table: Option<String>,
}

impl RepoZip {
    fn open(path: &FsPath, kind: Kind) -> LibResult<RepoZip> {
        let bad = |e: String| LibError::Upstream(format!("the library archive is unreadable: {e}"));
        let file = std::fs::File::open(path).map_err(|e| bad(e.to_string()))?;
        let archive = zip::ZipArchive::new(file).map_err(|e| bad(e.to_string()))?;
        let mut libs: HashMap<String, Vec<String>> = HashMap::new();
        let mut table = None;
        let dir_suffix = kind.lib_dir("");
        for name in archive.file_names() {
            let parts: Vec<&str> = name.split('/').collect();
            match parts.as_slice() {
                [_, file] if *file == kind.table() => table = Some(name.to_string()),
                // refs before the one-symbol-per-file layout: the whole library is one file
                [_, file] if kind == Kind::Symbols && file.ends_with(".kicad_sym") => {
                    let lib = file.trim_end_matches(".kicad_sym");
                    libs.entry(lib.to_string()).or_default().push(name.to_string());
                }
                [_, dir, file] if dir.ends_with(&dir_suffix) && file.ends_with(kind.item_ext()) => {
                    let lib = &dir[..dir.len() - dir_suffix.len()];
                    libs.entry(lib.to_string()).or_default().push(name.to_string());
                }
                _ => {}
            }
        }
        if libs.is_empty() {
            return Err(bad(format!("it holds no {} libraries", kind.dir())));
        }
        for files in libs.values_mut() {
            files.sort();
        }
        Ok(RepoZip { archive, libs, table })
    }

    fn read(&mut self, name: &str, budget: &mut usize) -> LibResult<String> {
        let bad = |e: String| LibError::Upstream(format!("the library archive is unreadable: {e}"));
        let f = self.archive.by_name(name).map_err(|e| bad(e.to_string()))?;
        let mut text = String::new();
        // bounded read: the declared size is not trusted
        f.take(*budget as u64 + 1).read_to_string(&mut text).map_err(|e| bad(e.to_string()))?;
        if text.len() > *budget {
            return Err(LibError::Upstream("the library is too large".into()));
        }
        *budget -= text.len();
        Ok(text)
    }

    /// The repository's library table, or just the library names when it ships none.
    fn table(&mut self) -> LibResult<Vec<(String, String)>> {
        if let Some(name) = self.table.clone() {
            let mut budget = 16 * 1024 * 1024;
            let rows = parse_lib_table(&self.read(&name, &mut budget)?);
            return Ok(rows.into_iter().filter(|(n, _)| self.libs.contains_key(n)).collect());
        }
        let mut names: Vec<(String, String)> = self.libs.keys().filter(|n| valid_name(n)).map(|n| (n.clone(), String::new())).collect();
        names.sort();
        Ok(names)
    }

    fn library(&mut self, lib: &str) -> LibResult<Vec<(String, String)>> {
        let names = self.libs.get(lib).cloned().ok_or(LibError::NotFound)?;
        let mut budget = MAX_LIBRARY_BYTES;
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let text = self.read(&name, &mut budget)?;
            out.push((name.rsplit('/').next().unwrap_or("").to_string(), text));
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------- handlers

fn libs() -> &'static Libs {
    static LIBS: OnceLock<Libs> = OnceLock::new();
    LIBS.get_or_init(Libs::from_env)
}

fn json_response(body: LibResult<String>) -> Response {
    match body {
        // pinned ref: the content never changes, so the browser may keep it
        Ok(b) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "private, max-age=3600")], b)
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn symbol_libraries(_user: AuthUser) -> Response {
    json_response(libs().libraries_json(true).await)
}

async fn symbol_index(_user: AuthUser, Path(lib): Path<String>) -> Response {
    let lib = lib.strip_suffix(".kicad_sym").unwrap_or(&lib).to_string();
    json_response(libs().symbol_index_json(&lib).await)
}

async fn symbol(_user: AuthUser, Path((lib, name)): Path<(String, String)>) -> Response {
    let lib = lib.strip_suffix(".kicad_sym").unwrap_or(&lib).to_string();
    json_response(libs().symbol_json(&lib, &name).await)
}

async fn footprint_libraries(_user: AuthUser) -> Response {
    json_response(libs().libraries_json(false).await)
}

async fn footprint_index(_user: AuthUser, Path(lib): Path<String>) -> Response {
    let lib = lib.strip_suffix(".pretty").unwrap_or(&lib).to_string();
    json_response(libs().footprint_index_json(&lib).await)
}

async fn footprint(_user: AuthUser, Path((lib, name)): Path<(String, String)>) -> Response {
    let lib = lib.strip_suffix(".pretty").unwrap_or(&lib).to_string();
    let name = name.strip_suffix(".kicad_mod").unwrap_or(&name).to_string();
    json_response(libs().footprint_json(&lib, &name).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = r#"(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "R" (pin_numbers (hide yes)) (in_bom yes)
    (property "Reference" "R" (at 2.032 0 90))
    (property "Value" "R" (at 0 0 90))
    (property "Footprint" "" (at -1.778 0 90))
    (property "Description" "Resistor (\"fixed\")" (at 0 0 0))
    (property "ki_keywords" "R res resistor" (at 0 0 0))
    (property "ki_fp_filters" "R_*" (at 0 0 0))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1")))))"#;
    const OPAMP: &str = r#"(kicad_symbol_lib (version 20251024)
  (symbol "LM2904" (property "Reference" "U" (at 0 5.08 0)) (property "Description" "Dual op-amp" (at 0 0 0))
    (symbol "LM2904_1_1" (pin output line (at 7.62 0 180) (length 2.54) (name "~") (number "1")))
    (symbol "LM2904_2_1" (pin output line (at 7.62 0 180) (length 2.54) (name "~") (number "7")))
    (symbol "LM2904_3_1" (pin power_in line (at -2.54 7.62 270) (length 3.81) (name "V+") (number "8")))))"#;
    const DERIVED: &str = r#"(kicad_symbol_lib (version 20251024)
  (symbol "LM358" (extends "LM2904") (property "Reference" "U" (at 0 5.08 0)) (property "Value" "LM358" (at 0 0 0))
    (property "Description" "Low-power dual op-amp" (at 0 0 0))))"#;
    const GND: &str = r##"(kicad_symbol_lib (symbol "GND" (power global) (property "Reference" "#PWR" (at 0 0 0))
    (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27)))) (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "~") (number "1")))))"##;
    const FP: &str = r#"(footprint "R_0603_1608Metric" (version 20241229) (generator "kicad-footprint-generator") (layer "F.Cu")
  (descr "Resistor SMD 0603") (tags "resistor") (property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste")))"#;

    fn fixture() -> (PathBuf, Libs) {
        let dir = std::env::temp_dir().join(format!("kc-libs-test-{}-{}", std::process::id(), rand::random::<u32>()));
        let sym = dir.join("sym");
        let fp = dir.join("fp");
        std::fs::create_dir_all(sym.join("Device.kicad_symdir")).unwrap();
        std::fs::create_dir_all(sym.join("Amplifier_Operational.kicad_symdir")).unwrap();
        std::fs::create_dir_all(fp.join("Resistor_SMD.pretty")).unwrap();
        std::fs::write(sym.join("Device.kicad_symdir/R.kicad_sym"), R).unwrap();
        std::fs::write(sym.join("Amplifier_Operational.kicad_symdir/LM2904.kicad_sym"), OPAMP).unwrap();
        std::fs::write(sym.join("Amplifier_Operational.kicad_symdir/LM358.kicad_sym"), DERIVED).unwrap();
        // a pre-10 single-file library next to the directories
        std::fs::write(sym.join("power.kicad_sym"), GND).unwrap();
        std::fs::write(
            sym.join("sym-lib-table"),
            r#"(sym_lib_table (version 7)
  (lib (name "Amplifier_Operational") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Amplifier_Operational.kicad_symdir") (options "") (descr "Operational amplifiers"))
  (lib (name "Device") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Device.kicad_symdir") (options "") (descr "Generic symbols"))
  (lib (name "power") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/power.kicad_sym") (options "") (descr "Power symbols")))"#,
        )
        .unwrap();
        std::fs::write(fp.join("Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod"), FP).unwrap();
        let libs = Libs::new("test", sym.to_str().unwrap(), &format!("file://{}", fp.display()), &dir.join("cache"));
        (dir, libs)
    }

    #[test]
    fn sexpr_spans_and_escapes() {
        let src = r#"(a "b \"c\"" (d 1 2) e)"#;
        let t = parse_sexpr(src);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].head(), "a");
        assert_eq!(t[0].arg(1), Some("b \"c\""));
        let (s, e) = t[0].list("d").unwrap().span();
        assert_eq!(&src[s..e], "(d 1 2)");
        assert_eq!(unit_of("LM2904_3_1"), Some(3));
        assert_eq!(unit_of("R_0603_1"), Some(603));
        assert_eq!(unit_of("R"), None);
    }

    #[test]
    fn names_are_confined() {
        assert!(valid_name("Connector_PinHeader_2.54mm"));
        assert!(valid_name("MCU_ST_STM32F4"));
        assert!(!valid_name("../etc"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("a?b=c"));
        assert!(!valid_name(""));
    }

    #[tokio::test]
    async fn fixture_libraries() {
        let (dir, libs) = fixture();
        let list: Value = serde_json::from_str(&libs.libraries_json(true).await.unwrap()).unwrap();
        assert_eq!(list["ref"], "test");
        let names: Vec<&str> = list["libraries"].as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Amplifier_Operational", "Device", "power"]);
        assert_eq!(list["libraries"][1]["description"], "Generic symbols");

        let idx: Value = serde_json::from_str(&libs.symbol_index_json("Device").await.unwrap()).unwrap();
        let r = &idx["symbols"][0];
        assert_eq!(r["n"], "R");
        assert_eq!(r["d"], "Resistor (\"fixed\")");
        assert_eq!(r["k"], "R res resistor");
        assert_eq!(r["r"], "R");
        assert_eq!(r["u"], 1);
        assert_eq!(r["ff"], "R_*");
        assert!(r.get("p").is_none());

        // a derived symbol reports its parent's units and comes with the parent chain
        let idx: Value = serde_json::from_str(&libs.symbol_index_json("Amplifier_Operational").await.unwrap()).unwrap();
        let lm358 = idx["symbols"].as_array().unwrap().iter().find(|s| s["n"] == "LM358").unwrap();
        assert_eq!(lm358["u"], 3);
        assert_eq!(lm358["e"], "LM2904");
        let sym: Value = serde_json::from_str(&libs.symbol_json("Amplifier_Operational", "LM358").await.unwrap()).unwrap();
        assert_eq!(sym["libId"], "Amplifier_Operational:LM358");
        assert!(sym["symbol"].as_str().unwrap().starts_with("(symbol \"LM358\""));
        assert_eq!(sym["parents"].as_array().unwrap().len(), 1);
        assert!(sym["parents"][0].as_str().unwrap().starts_with("(symbol \"LM2904\""));

        // the single-file layout, and the power flag
        let idx: Value = serde_json::from_str(&libs.symbol_index_json("power").await.unwrap()).unwrap();
        assert_eq!(idx["symbols"][0]["n"], "GND");
        assert_eq!(idx["symbols"][0]["p"], true);

        assert!(matches!(libs.symbol_json("Device", "Nope").await, Err(LibError::NotFound)));
        assert!(matches!(libs.symbol_index_json("NotInTable").await, Err(LibError::NotFound)));
        assert!(matches!(libs.symbol_index_json("../sym").await, Err(LibError::BadName)));

        // footprints: no table in the fixture, the directory listing stands in
        let list: Value = serde_json::from_str(&libs.libraries_json(false).await.unwrap()).unwrap();
        assert_eq!(list["libraries"][0]["name"], "Resistor_SMD");
        let idx: Value = serde_json::from_str(&libs.footprint_index_json("Resistor_SMD").await.unwrap()).unwrap();
        assert_eq!(idx["footprints"][0]["n"], "R_0603_1608Metric");
        assert_eq!(idx["footprints"][0]["d"], "Resistor SMD 0603");
        assert_eq!(idx["footprints"][0]["p"], 2);
        let fp: Value = serde_json::from_str(&libs.footprint_json("Resistor_SMD", "R_0603_1608Metric").await.unwrap()).unwrap();
        assert_eq!(fp["fpid"], "Resistor_SMD:R_0603_1608Metric");
        assert!(fp["footprint"].as_str().unwrap().contains("(pad \"2\""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn archive_layout() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("kc-libs-zip-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("repository.zip");
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            let mut put = |name: &str, body: &str| {
                w.start_file(name, o).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            };
            put("kicad-symbols-x/README.md", "no");
            put(
                "kicad-symbols-x/sym-lib-table",
                r#"(sym_lib_table (lib (name "Device") (descr "Generic symbols")) (lib (name "power") (descr "Power symbols")) (lib (name "Gone") (descr "not in the archive")))"#,
            );
            put("kicad-symbols-x/Device.kicad_symdir/R.kicad_sym", R);
            put("kicad-symbols-x/Device.kicad_symdir/notes.txt", "no");
            put("kicad-symbols-x/power.kicad_sym", GND);
            put("kicad-symbols-x/tools/deep/Other.kicad_symdir/X.kicad_sym", R);
            w.finish().unwrap();
        }
        let mut repo = RepoZip::open(&path, Kind::Symbols).unwrap();
        assert_eq!(repo.table().unwrap(), [("Device".to_string(), "Generic symbols".to_string()), ("power".to_string(), "Power symbols".to_string())]);
        let files = repo.library("Device").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "R.kicad_sym");
        let lib = build_symbol_lib("Device", files.into_iter().map(|f| f.1).collect());
        assert!(lib.symbols.contains_key("R"));
        assert_eq!(repo.library("power").unwrap()[0].0, "power.kicad_sym");
        assert!(matches!(repo.library("Other"), Err(LibError::NotFound)));
        assert!(RepoZip::open(&path, Kind::Footprints).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

}
