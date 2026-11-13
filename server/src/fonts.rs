//! Fonts for text in a design.
//!
//! KiCad draws text in its own stroke font or in any outline font named by
//! `(font (face "…"))`.  A face that is not installed where the design is opened is
//! substituted, and the text moves.  So the server keeps the font files:
//!
//! * every Google Font can be asked for by name; the file is fetched from Google once and
//!   kept for everybody (they are openly licensed: OFL, Apache 2.0 or the Ubuntu licence);
//! * a font that only exists on somebody's computer is uploaded by the desktop app into the
//!   project it is used in, when the font's own embedding permission allows it, and handed
//!   to the people who can open that project.
//!
//! `GET  /api/fonts/catalog`                 the Google Fonts list
//! `GET  /api/fonts/preview?family=`         the few glyphs needed to show a family's name in itself
//! `GET  /api/projects/{id}/fonts`           the fonts uploaded into a project
//! `GET  /api/projects/{id}/fonts/file`      a font file for `?family=&bold=&italic=` (`&exact=1`: no fallback style)
//! `PUT  /api/projects/{id}/fonts/file`      upload one (`?family=&bold=&italic=&index=&name=`)

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::access::{self, Viewer};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

const MAX_FONT_BYTES: usize = 40 * 1024 * 1024;
/// Font files one project may hold (a family is up to four).
const MAX_PROJECT_FILES: i64 = 240;

// ---- the Google Fonts catalogue ------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    pub family: String,
    /// sans, serif, display, hand, mono
    pub category: String,
    /// OFL-1.1, Apache-2.0, UFL-1.0, or "" where the list does not say (always one of the three)
    pub license: String,
    /// The weight that stands for regular (400 where the family has it).
    pub regular: u16,
    /// The weight that stands for bold, 0 when the family has no heavier weight.
    pub bold: u16,
    /// bit 0: the regular weight has an italic, bit 1: the bold weight has one
    pub italics: u8,
}

pub struct Catalog {
    pub families: Vec<Family>,
    by_key: HashMap<String, usize>,
    json: String,
}

impl Catalog {
    fn new(mut families: Vec<Family>, updated: &str) -> Catalog {
        families.sort_by_key(|f| f.family.to_lowercase());
        families.dedup_by(|a, b| a.family.eq_ignore_ascii_case(&b.family));
        let by_key = families.iter().enumerate().map(|(i, f)| (f.family.to_lowercase(), i)).collect();
        let rows: Vec<Value> = families.iter().map(|f| json!([f.family, f.category, f.license, f.regular, f.bold, f.italics])).collect();
        let json = json!({ "source": "Google Fonts", "updated": updated, "fonts": rows }).to_string();
        Catalog { families, by_key, json }
    }

    fn parse(text: &str) -> Option<Catalog> {
        let v: Value = serde_json::from_str(text).ok()?;
        let families = v["fonts"]
            .as_array()?
            .iter()
            .filter_map(|r| {
                Some(Family {
                    family: r[0].as_str()?.to_string(),
                    category: r[1].as_str()?.to_string(),
                    license: r[2].as_str()?.to_string(),
                    regular: r[3].as_u64()? as u16,
                    bold: r[4].as_u64()? as u16,
                    italics: r[5].as_u64()? as u8,
                })
            })
            .collect();
        Some(Catalog::new(families, v["updated"].as_str().unwrap_or("")))
    }

    pub fn find(&self, family: &str) -> Option<&Family> {
        self.by_key.get(&family.trim().to_lowercase()).map(|&i| &self.families[i])
    }
}

fn slot() -> &'static RwLock<Arc<Catalog>> {
    static SLOT: OnceLock<RwLock<Arc<Catalog>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(Arc::new(Catalog::parse(include_str!("../fonts/google-fonts.json")).expect("fonts/google-fonts.json"))))
}

pub fn catalog() -> Arc<Catalog> {
    slot().read().unwrap().clone()
}

/// Regular and bold weights and which of them have italics, from a family's weight lists.
fn pick_styles(mut upright: Vec<u16>, mut italic: Vec<u16>) -> (u16, u16, u8) {
    upright.sort_unstable();
    italic.sort_unstable();
    if upright.is_empty() {
        upright = italic.clone();
    }
    if upright.is_empty() {
        return (400, 0, 0);
    }
    let regular = if upright.contains(&400) { 400 } else { *upright.iter().min_by_key(|&&w| ((w as i32 - 400).abs(), w)).unwrap() };
    let heavier: Vec<u16> = upright.iter().copied().filter(|&w| w > regular).collect();
    let bold = if heavier.contains(&700) { 700 } else { heavier.iter().copied().min_by_key(|&w| (w as i32 - 700).abs()).unwrap_or(0) };
    let italics = u8::from(italic.contains(&regular)) | (u8::from(bold != 0 && italic.contains(&bold)) << 1);
    (regular, bold, italics)
}

/// Google's own list (`fonts.google.com/metadata/fonts`) merged over the list this server was
/// built with: families published since then appear, licences already known are kept.
fn merge_metadata(base: &Catalog, text: &str, today: &str) -> Option<Catalog> {
    // the body may start with the ")]}'" guard line
    let body = text.trim_start().trim_start_matches(")]}'").trim_start();
    let v: Value = serde_json::from_str(body).ok()?;
    let list = v["familyMetadataList"].as_array()?;
    let mut out: Vec<Family> = Vec::with_capacity(list.len());
    for m in list {
        let Some(family) = m["family"].as_str() else { continue };
        let Some(fonts) = m["fonts"].as_object() else { continue };
        let (mut up, mut it) = (Vec::new(), Vec::new());
        for key in fonts.keys() {
            let (num, ital) = match key.strip_suffix('i') {
                Some(n) => (n, true),
                None => (key.as_str(), false),
            };
            if let Ok(w) = num.parse::<u16>() {
                if ital { it.push(w) } else { up.push(w) }
            }
        }
        let (regular, bold, italics) = pick_styles(up, it);
        let known = base.find(family);
        let category = match m["category"].as_str().unwrap_or("").to_lowercase().as_str() {
            "sans serif" | "sans-serif" => "sans",
            "serif" => "serif",
            "handwriting" => "hand",
            "monospace" => "mono",
            _ => "display",
        };
        out.push(Family {
            family: family.to_string(),
            category: category.to_string(),
            license: known.map(|k| k.license.clone()).unwrap_or_default(),
            regular,
            bold,
            italics,
        });
    }
    // a short answer is a broken answer: never shrink the list on its account
    if out.len() < base.families.len() / 2 {
        return None;
    }
    for f in &base.families {
        if !out.iter().any(|o| o.family.eq_ignore_ascii_case(&f.family)) {
            out.push(f.clone());
        }
    }
    Some(Catalog::new(out, today))
}

fn http() -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        // a plain agent is answered with TrueType files, one static file per style
        .user_agent("junction-fonts/1")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60));
    // the test rig sits behind a proxy with its own certificate authority
    if let Ok(path) = std::env::var("KC_EXTRA_CA_FILE") {
        if let Ok(pem) = std::fs::read(&path) {
            for cert in reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_default() {
                b = b.add_root_certificate(cert);
            }
        }
    }
    Ok(b.build().map_err(|e| anyhow::anyhow!(e))?)
}

/// Keep the list current: once shortly after start, then daily.  Failing is fine (the list
/// the server was built with stays).
pub fn spawn_refresh() {
    if matches!(std::env::var("KC_FONTS_NO_REFRESH").as_deref(), Ok("1")) {
        return;
    }
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let url = std::env::var("KC_GOOGLE_FONTS_LIST").unwrap_or_else(|_| "https://fonts.google.com/metadata/fonts".into());
            let got = async {
                let r = http().ok()?.get(&url).send().await.ok()?;
                if !r.status().is_success() {
                    return None;
                }
                r.text().await.ok()
            }
            .await;
            if let Some(text) = got {
                let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
                if let Some(next) = merge_metadata(&catalog(), &text, &today) {
                    tracing::info!("Google Fonts list refreshed: {} families", next.families.len());
                    *slot().write().unwrap() = Arc::new(next);
                }
            }
            tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        }
    });
}

pub async fn catalog_json() -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        catalog().json.clone(),
    )
        .into_response()
}

// ---- reading a font file ---------------------------------------------------------------------

#[derive(Debug)]
pub struct Sfnt {
    /// A standalone TrueType or OpenType file (a collection's face is copied out).
    pub data: Vec<u8>,
    /// OS/2 fsType, `None` when the font has no OS/2 table.
    pub fs_type: Option<u16>,
    pub family: String,
    pub license: String,
}

fn be16(d: &[u8], at: usize) -> Option<u16> {
    d.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}
fn be32(d: &[u8], at: usize) -> Option<u32> {
    d.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn bad(msg: &str) -> AppError {
    AppError::Api(StatusCode::UNSUPPORTED_MEDIA_TYPE, "font_unreadable", msg.to_string())
}

/// The tables of the face at `at`: (tag, offset, length), offsets from the start of the file.
fn tables(d: &[u8], at: usize) -> Option<(u32, Vec<([u8; 4], usize, usize)>)> {
    let version = be32(d, at)?;
    if !matches!(version, 0x0001_0000 | 0x4f54_544f | 0x7472_7565) {
        return None;
    }
    let n = be16(d, at + 4)? as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let r = at + 12 + 16 * i;
        let tag: [u8; 4] = d.get(r..r + 4)?.try_into().ok()?;
        let off = be32(d, r + 8)? as usize;
        let len = be32(d, r + 12)? as usize;
        if off.checked_add(len)? > d.len() {
            return None;
        }
        out.push((tag, off, len));
    }
    Some((version, out))
}

fn name_string(d: &[u8], name: &[u8], id: u16) -> Option<String> {
    let count = be16(name, 2)? as usize;
    let strings = be16(name, 4)? as usize;
    let mut best: Option<(u8, String)> = None;
    for i in 0..count {
        let r = 6 + 12 * i;
        let (platform, language, name_id) = (be16(name, r)?, be16(name, r + 4)?, be16(name, r + 6)?);
        if name_id != id {
            continue;
        }
        let (len, off) = (be16(name, r + 8)? as usize, be16(name, r + 10)? as usize);
        let Some(raw) = name.get(strings + off..strings + off + len) else { continue };
        let (rank, text) = match platform {
            0 | 3 => {
                let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                (if platform == 3 && language == 0x0409 { 3 } else { 2 }, String::from_utf16_lossy(&units))
            }
            1 => (1, raw.iter().map(|&b| b as char).collect()),
            _ => continue,
        };
        if best.as_ref().is_none_or(|(r, _)| rank > *r) {
            best = Some((rank, text));
        }
    }
    let _ = d;
    best.map(|(_, s)| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Check that `data` is a font this server can keep and hand to a browser and to FreeType,
/// and read what is needed from it.  `index` picks the face of a collection (.ttc).
pub fn inspect(data: &[u8], index: usize) -> AppResult<Sfnt> {
    if data.len() < 12 {
        return Err(bad("That file is not a font."));
    }
    let face_at = match &data[0..4] {
        b"ttcf" => {
            let n = be32(data, 8).unwrap_or(0) as usize;
            if index >= n {
                return Err(bad("That font collection has no such face."));
            }
            be32(data, 12 + 4 * index).ok_or_else(|| bad("That font collection is damaged."))? as usize
        }
        b"wOFF" | b"wOF2" => return Err(bad("Web font files (WOFF) cannot be stored; use the TrueType or OpenType file.")),
        _ => 0,
    };
    let (version, tabs) = tables(data, face_at).ok_or_else(|| bad("That file is not a TrueType or OpenType font."))?;
    let table = |tag: &[u8; 4]| tabs.iter().find(|t| &t.0 == tag).map(|t| &data[t.1..t.1 + t.2]);
    if table(b"head").is_none() || table(b"cmap").is_none() || (table(b"glyf").is_none() && table(b"CFF ").is_none() && table(b"CFF2").is_none()) {
        return Err(bad("That font has no outlines (bitmap fonts cannot be used)."));
    }
    let fs_type = table(b"OS/2").and_then(|t| be16(t, 8));
    let name = table(b"name");
    let family = name.and_then(|n| name_string(data, n, 16).or_else(|| name_string(data, n, 1))).unwrap_or_default();
    let license = name.and_then(|n| name_string(data, n, 13).or_else(|| name_string(data, n, 14)).or_else(|| name_string(data, n, 0))).unwrap_or_default();
    let license: String = license.chars().take(600).collect();

    // a single-font file is kept as it is; a collection's face is copied out into a file of its own
    let standalone = if face_at == 0 {
        data.to_vec()
    } else {
        let n = tabs.len();
        let mut sorted = tabs.clone();
        sorted.sort_by_key(|t| t.0);
        let mut out = Vec::with_capacity(12 + 16 * n + sorted.iter().map(|t| t.2 + 3).sum::<usize>());
        out.extend_from_slice(&version.to_be_bytes());
        out.extend_from_slice(&(n as u16).to_be_bytes());
        let pow = (n.max(1)).ilog2();
        let search = (1u16 << pow) * 16;
        out.extend_from_slice(&search.to_be_bytes());
        out.extend_from_slice(&(pow as u16).to_be_bytes());
        out.extend_from_slice(&((n as u16) * 16 - search).to_be_bytes());
        let mut at = 12 + 16 * n;
        for (tag, off, len) in &sorted {
            let body = &data[*off..*off + *len];
            let mut sum = 0u32;
            for c in body.chunks(4) {
                let mut w = [0u8; 4];
                w[..c.len()].copy_from_slice(c);
                sum = sum.wrapping_add(u32::from_be_bytes(w));
            }
            out.extend_from_slice(tag);
            out.extend_from_slice(&sum.to_be_bytes());
            out.extend_from_slice(&(at as u32).to_be_bytes());
            out.extend_from_slice(&(*len as u32).to_be_bytes());
            at += (len + 3) & !3;
        }
        for (_, off, len) in &sorted {
            out.extend_from_slice(&data[*off..*off + *len]);
            while out.len() % 4 != 0 {
                out.push(0);
            }
        }
        out
    };
    Ok(Sfnt { data: standalone, fs_type, family, license })
}

/// Whether the font's own embedding permission (OS/2 fsType) lets it travel with a document
/// that other people edit: the rule KiCad applies before it embeds a font (installable or
/// editable embedding; not restricted, preview-and-print only, or bitmap only).
pub fn may_embed(fs_type: Option<u16>) -> bool {
    let Some(t) = fs_type else { return false };
    if t & 0x0200 != 0 {
        return false;
    }
    let bits = t & 0x000f;
    bits == 0 || bits & 0x0008 != 0
}

fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

// ---- Google font files ------------------------------------------------------------------------

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn unreachable_err(msg: impl Into<String>) -> AppError {
    AppError::Api(StatusCode::BAD_GATEWAY, "fonts_unreachable", msg.into())
}

/// Download one style of a family from Google Fonts; with `text`, only the glyphs for it.
async fn google_download(family: &str, weight: u16, italic: bool, text: Option<&str>) -> AppResult<Vec<u8>> {
    let base = std::env::var("KC_GOOGLE_FONTS_CSS").ok();
    let mut url = format!(
        "{}?family={}:ital,wght@{},{}",
        base.as_deref().unwrap_or("https://fonts.googleapis.com/css2"),
        enc(family),
        u8::from(italic),
        weight
    );
    if let Some(t) = text {
        url.push_str("&text=");
        url.push_str(&enc(t).replace('+', "%20"));
    }
    let client = http()?;
    let r = client.get(&url).send().await.map_err(|_| unreachable_err("Google Fonts did not answer."))?;
    if !r.status().is_success() {
        return Err(if r.status().is_client_error() { AppError::NotFound } else { unreachable_err("Google Fonts did not answer.") });
    }
    let css = r.text().await.map_err(|_| unreachable_err("Google Fonts did not answer."))?;
    let file = css
        .split("url(")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(|u| u.trim_matches(|c| c == '\'' || c == '"').to_string())
        .ok_or_else(|| unreachable_err("Google Fonts sent no file for that font."))?;
    let parsed = reqwest::Url::parse(&file).map_err(|_| unreachable_err("Google Fonts sent no file for that font."))?;
    // the stylesheet is only trusted to point at Google's own file host
    if base.is_none() && !(parsed.scheme() == "https" && parsed.host_str() == Some("fonts.gstatic.com")) {
        return Err(unreachable_err("Google Fonts sent no file for that font."));
    }
    let r = client.get(parsed).send().await.map_err(|_| unreachable_err("Google Fonts did not answer."))?;
    if !r.status().is_success() {
        return Err(unreachable_err("Google Fonts did not answer."));
    }
    if r.content_length().is_some_and(|n| n as usize > MAX_FONT_BYTES) {
        return Err(unreachable_err("That font file is too large."));
    }
    let bytes = r.bytes().await.map_err(|_| unreachable_err("The download was cut off."))?;
    if bytes.len() > MAX_FONT_BYTES {
        return Err(unreachable_err("That font file is too large."));
    }
    Ok(bytes.to_vec())
}

/// The style of a Google family that answers a request for bold and/or italic: a missing
/// bold or italic falls back towards regular (the client then draws it synthetically, as
/// KiCad does for a font that lacks the style).
fn google_style(f: &Family, bold: bool, italic: bool) -> (bool, bool, u16) {
    let b = bold && f.bold != 0;
    let i = italic && (f.italics & if b { 2 } else { 1 }) != 0;
    (b, i, if b { f.bold } else { f.regular })
}

struct Served {
    data: Vec<u8>,
    sha256: String,
    bold: bool,
    italic: bool,
    family: String,
    source: &'static str,
}

async fn google_file(state: &AppState, f: &Family, bold: bool, italic: bool) -> AppResult<Served> {
    let (b, i, weight) = google_style(f, bold, italic);
    if let Some(row) = sqlx::query("SELECT sha256, data FROM google_font_files WHERE family = $1 AND bold = $2 AND italic = $3")
        .bind(&f.family)
        .bind(b)
        .bind(i)
        .fetch_optional(&state.pool)
        .await?
    {
        return Ok(Served { data: row.get("data"), sha256: row.get("sha256"), bold: b, italic: i, family: f.family.clone(), source: "google" });
    }
    let data = match google_download(&f.family, weight, i, None).await {
        Ok(d) => d,
        // a family made only of italics has no upright file: its italic is its one style, kept as such
        Err(AppError::NotFound) if !i && f.italics & 1 != 0 => google_download(&f.family, weight, true, None).await?,
        Err(e) => return Err(e),
    };
    let font = inspect(&data, 0)?;
    let sha256 = sha_hex(&font.data);
    sqlx::query("INSERT INTO google_font_files (family, bold, italic, weight, sha256, data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (family, bold, italic) DO NOTHING")
        .bind(&f.family)
        .bind(b)
        .bind(i)
        .bind(weight as i32)
        .bind(&sha256)
        .bind(&font.data)
        .execute(&state.pool)
        .await?;
    Ok(Served { data: font.data, sha256, bold: b, italic: i, family: f.family.clone(), source: "google" })
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    family: String,
}

/// The glyphs of a family's own name, to show the name set in the font in a font list.
pub async fn preview(Query(q): Query<PreviewQuery>) -> AppResult<Response> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let cat = catalog();
    let f = cat.find(&q.family).ok_or(AppError::NotFound)?;
    let hit = cache.lock().unwrap().get(&f.family).cloned();
    let data = match hit {
        Some(d) => d,
        None => {
            let italic = false;
            let d = match google_download(&f.family, f.regular, italic, Some(&f.family)).await {
                Ok(d) => d,
                Err(AppError::NotFound) if f.italics & 1 != 0 => google_download(&f.family, f.regular, true, Some(&f.family)).await?,
                Err(e) => return Err(e),
            };
            let d = Arc::new(d);
            let mut c = cache.lock().unwrap();
            if c.len() > 4000 {
                c.clear();
            }
            c.insert(f.family.clone(), d.clone());
            d
        }
    };
    Ok(([(header::CONTENT_TYPE, "font/ttf"), (header::CACHE_CONTROL, "public, max-age=2592000")], data.as_ref().clone()).into_response())
}

// ---- a project's fonts ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct FileQuery {
    family: String,
    #[serde(default)]
    bold: Option<String>,
    #[serde(default)]
    italic: Option<String>,
    /// `exact=1`: 404 rather than a fallback style when the family has no such bold or italic
    #[serde(default)]
    exact: Option<String>,
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    name: Option<String>,
}

fn flag(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1") | Some("true") | Some("yes"))
}

fn clean_family(raw: &str) -> AppResult<String> {
    let f = raw.trim();
    if f.is_empty() || f.chars().count() > 120 || f.chars().any(|c| c.is_control()) {
        return Err(AppError::BadRequest("family is not a font name".into()));
    }
    Ok(f.to_string())
}

/// Among a family's stored styles, the one that best answers bold/italic: the exact style,
/// else the one that keeps the weight, else regular.
fn best_style(have: &[(bool, bool)], bold: bool, italic: bool) -> Option<(bool, bool)> {
    have.iter().copied().max_by_key(|&(b, i)| (b == bold && i == italic, b == bold, i == italic, !b && !i))
}

/// `GET /api/projects/{id}/fonts/file?family=&bold=&italic=`: the font file to draw that
/// face with.  The answer says which style it really is (`x-font-bold`, `x-font-italic`),
/// since a family may lack the one asked for.  404 when the server has no such font.
pub async fn project_font_file(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    access::require(&state.pool, &viewer, project_id).await?;
    let family = clean_family(&q.family)?;
    let (bold, italic) = (flag(&q.bold), flag(&q.italic));

    let have: Vec<(bool, bool)> = sqlx::query("SELECT bold, italic FROM project_font_files WHERE project_id = $1 AND family_key = $2")
        .bind(project_id)
        .bind(family.to_lowercase())
        .fetch_all(&state.pool)
        .await?
        .iter()
        .map(|r| (r.get("bold"), r.get("italic")))
        .collect();
    let exact = flag(&q.exact);
    let stored = best_style(&have, bold, italic);
    if exact && stored.is_some_and(|s| s != (bold, italic)) {
        return Err(AppError::NotFound);
    }
    let served = if let Some((b, i)) = stored {
        let row = sqlx::query("SELECT family, sha256, data FROM project_font_files WHERE project_id = $1 AND family_key = $2 AND bold = $3 AND italic = $4")
            .bind(project_id)
            .bind(family.to_lowercase())
            .bind(b)
            .bind(i)
            .fetch_one(&state.pool)
            .await?;
        Served { data: row.get("data"), sha256: row.get("sha256"), bold: b, italic: i, family: row.get("family"), source: "upload" }
    } else {
        let cat = catalog();
        let f = cat.find(&family).ok_or(AppError::NotFound)?;
        if exact && { let (b, i, _) = google_style(f, bold, italic); (b, i) != (bold, italic) } {
            return Err(AppError::NotFound);
        }
        google_file(&state, f, bold, italic).await?
    };

    let etag = format!("\"{}\"", served.sha256);
    let mut h = HeaderMap::new();
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    h.insert("x-font-bold", HeaderValue::from_static(if served.bold { "1" } else { "0" }));
    h.insert("x-font-italic", HeaderValue::from_static(if served.italic { "1" } else { "0" }));
    h.insert("x-font-source", HeaderValue::from_static(served.source));
    if let Ok(v) = HeaderValue::from_str(&enc(&served.family).replace('+', "%20")) {
        h.insert("x-font-family", v);
    }
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, h).into_response());
    }
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(if served.data.starts_with(b"OTTO") { "font/otf" } else { "font/ttf" }));
    Ok((h, served.data).into_response())
}

/// `GET /api/projects/{id}/fonts`: the fonts uploaded into the project.
pub async fn project_fonts(State(state): State<AppState>, viewer: Viewer, Path(project_id): Path<Uuid>) -> AppResult<Json<Value>> {
    access::require(&state.pool, &viewer, project_id).await?;
    let rows = sqlx::query("SELECT family, bold, italic, file_name, license, sha256, bytes FROM project_font_files WHERE project_id = $1 ORDER BY family_key, bold, italic")
        .bind(project_id)
        .fetch_all(&state.pool)
        .await?;
    let mut fonts: Vec<Value> = Vec::new();
    for r in rows {
        let family: String = r.get("family");
        let style = json!({ "bold": r.get::<bool, _>("bold"), "italic": r.get::<bool, _>("italic"), "bytes": r.get::<i64, _>("bytes"), "sha256": r.get::<String, _>("sha256"), "fileName": r.get::<String, _>("file_name") });
        match fonts.last_mut().filter(|f| f["family"].as_str().is_some_and(|x| x.eq_ignore_ascii_case(&family))) {
            Some(f) => f["styles"].as_array_mut().unwrap().push(style),
            None => fonts.push(json!({ "family": family, "source": "upload", "license": r.get::<String, _>("license"), "styles": [style] })),
        }
    }
    Ok(Json(json!({ "fonts": fonts })))
}

/// `PUT /api/projects/{id}/fonts/file?family=&bold=&italic=&index=&name=`, the body being the
/// font file: keep a font from an editor's computer with the project.  A Google family is
/// not stored again; a font whose embedding permission forbids it is refused.
pub async fn upload_project_font(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(project_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
    body: axum::body::Bytes,
) -> AppResult<Json<Value>> {
    let acc = access::require(&state.pool, &Viewer::user(&user), project_id).await?;
    if !acc.can_edit() {
        return Err(AppError::Forbidden);
    }
    let family = clean_family(&q.family)?;
    let (bold, italic) = (flag(&q.bold), flag(&q.italic));
    if catalog().find(&family).is_some() {
        return Ok(Json(json!({ "stored": false, "source": "google", "family": family })));
    }
    if body.len() > MAX_FONT_BYTES {
        return Err(AppError::Api(StatusCode::PAYLOAD_TOO_LARGE, "font_too_large", "That font file is too large to keep with the project (40 MB at most).".into()));
    }
    let font = inspect(&body, q.index.unwrap_or(0))?;
    if !may_embed(font.fs_type) {
        return Err(AppError::Api(
            StatusCode::FORBIDDEN,
            "font_restricted",
            format!("The licence of \"{family}\" does not allow the font to be embedded in a document, so it stays on your computer only."),
        ));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM project_font_files WHERE project_id = $1").bind(project_id).fetch_one(&state.pool).await?;
    if count >= MAX_PROJECT_FILES {
        return Err(AppError::Api(StatusCode::PAYLOAD_TOO_LARGE, "font_too_many", "This project already holds as many fonts as it can.".into()));
    }
    let sha256 = sha_hex(&font.data);
    let name: String = q.name.as_deref().unwrap_or("").chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').take(120).collect();
    sqlx::query(
        "INSERT INTO project_font_files (project_id, family_key, family, bold, italic, file_name, fs_type, license, sha256, bytes, data, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (project_id, family_key, bold, italic) DO UPDATE SET family = EXCLUDED.family, file_name = EXCLUDED.file_name,
           fs_type = EXCLUDED.fs_type, license = EXCLUDED.license, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, created_at = now()",
    )
    .bind(project_id)
    .bind(family.to_lowercase())
    .bind(&family)
    .bind(bold)
    .bind(italic)
    .bind(&name)
    .bind(font.fs_type.unwrap_or(0) as i32)
    .bind(&font.license)
    .bind(&sha256)
    .bind(font.data.len() as i64)
    .bind(&font.data)
    .bind(user.id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "stored": true, "source": "upload", "family": family, "bold": bold, "italic": italic, "sha256": sha256, "bytes": font.data.len() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal font: the tables `inspect` looks at, with the given fsType and names.
    fn tiny_font(fs_type: u16, family: &str) -> Vec<u8> {
        let utf16: Vec<u8> = family.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        let mut name = vec![0, 0, 0, 1, 0, 18];
        name.extend_from_slice(&[0, 3, 0, 1, 0x04, 0x09, 0, 1]);
        name.extend_from_slice(&(utf16.len() as u16).to_be_bytes());
        name.extend_from_slice(&[0, 0]);
        name.extend_from_slice(&utf16);
        let mut os2 = vec![0u8; 78];
        os2[8..10].copy_from_slice(&fs_type.to_be_bytes());
        let tabs: Vec<(&[u8; 4], Vec<u8>)> = vec![(b"OS/2", os2), (b"cmap", vec![0; 8]), (b"glyf", vec![1, 2, 3, 4, 5]), (b"head", vec![0; 54]), (b"name", name)];
        let mut out = vec![0, 1, 0, 0, 0, tabs.len() as u8, 0, 64, 0, 2, 0, 16];
        let mut at = 12 + 16 * tabs.len();
        for (tag, body) in &tabs {
            out.extend_from_slice(*tag);
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&(at as u32).to_be_bytes());
            out.extend_from_slice(&(body.len() as u32).to_be_bytes());
            at += (body.len() + 3) & !3;
        }
        for (_, body) in &tabs {
            out.extend_from_slice(body);
            while out.len() % 4 != 0 {
                out.push(0);
            }
        }
        out
    }

    #[test]
    fn the_bundled_list_loads() {
        let c = catalog();
        assert!(c.families.len() > 1800);
        let roboto = c.find("roboto").unwrap();
        assert_eq!((roboto.family.as_str(), roboto.regular, roboto.bold, roboto.italics), ("Roboto", 400, 700, 3));
        assert_eq!(c.find(" Lobster ").unwrap().bold, 0);
        assert!(c.find("Helvetica Neue").is_none());
        // every licence named in the list is one that allows the font to be stored and handed on
        assert!(c.families.iter().all(|f| matches!(f.license.as_str(), "OFL-1.1" | "Apache-2.0" | "UFL-1.0" | "")));
    }

    #[test]
    fn styles_fall_back_towards_regular() {
        let c = catalog();
        assert_eq!(google_style(c.find("Roboto").unwrap(), true, true), (true, true, 700));
        assert_eq!(google_style(c.find("Lobster").unwrap(), true, true), (false, false, 400));
        assert_eq!(google_style(c.find("Buda").unwrap(), false, false), (false, false, 300));
        assert_eq!(pick_styles(vec![300, 600, 800], vec![300]), (300, 600, 1));
        assert_eq!(pick_styles(vec![], vec![400]), (400, 0, 1));
        assert_eq!(best_style(&[(false, false), (true, false)], true, true), Some((true, false)));
        assert_eq!(best_style(&[(false, false), (false, true)], true, true), Some((false, true)));
        assert_eq!(best_style(&[(false, false)], true, false), Some((false, false)));
        assert_eq!(best_style(&[], false, false), None);
    }

    #[test]
    fn googles_list_merges_over_ours() {
        let base = catalog();
        let mut list: Vec<Value> = base.families.iter().map(|f| json!({ "family": f.family, "category": "Sans Serif", "fonts": { "400": {} } })).collect();
        list.push(json!({ "family": "Brand New Face", "category": "Handwriting", "fonts": { "400": {}, "400i": {}, "700": {}, "700i": {} } }));
        let text = format!(")]}}'\n{}", json!({ "familyMetadataList": list }));
        let c = merge_metadata(&base, &text, "2026-11-13").unwrap();
        let f = c.find("Brand New Face").unwrap();
        assert_eq!((f.category.as_str(), f.regular, f.bold, f.italics, f.license.as_str()), ("hand", 400, 700, 3, ""));
        assert_eq!(c.find("Roboto").unwrap().license, "OFL-1.1");
        assert_eq!(c.families.len(), base.families.len() + 1);
        // a truncated answer does not replace the list
        assert!(merge_metadata(&base, r#"{"familyMetadataList":[{"family":"X","fonts":{"400":{}}}]}"#, "x").is_none());
        assert!(merge_metadata(&base, "<html>", "x").is_none());
    }

    #[test]
    fn a_font_is_read_and_its_permission_respected() {
        let f = inspect(&tiny_font(0, "Corp Sans"), 0).unwrap();
        assert_eq!((f.family.as_str(), f.fs_type), ("Corp Sans", Some(0)));
        assert!(may_embed(Some(0)));
        assert!(may_embed(Some(0x0008)));
        assert!(may_embed(Some(0x0108)));
        assert!(!may_embed(Some(0x0002)));
        assert!(!may_embed(Some(0x0004)));
        assert!(!may_embed(Some(0x0200)));
        assert!(!may_embed(None));
        assert!(inspect(b"not a font at all", 0).is_err());
        assert!(inspect(b"wOF2aaaaaaaaaaaaaaaa", 0).is_err());
    }

    #[test]
    fn a_collection_face_is_copied_out() {
        let a = tiny_font(0, "First Face");
        let b = tiny_font(8, "Second Face");
        // ttcf header, two offsets, then the two fonts with their table offsets moved
        let shift = |font: &[u8], by: usize| {
            let mut f = font.to_vec();
            let n = be16(&f, 4).unwrap() as usize;
            for i in 0..n {
                let r = 12 + 16 * i + 8;
                let off = be32(&f, r).unwrap() + by as u32;
                f[r..r + 4].copy_from_slice(&off.to_be_bytes());
            }
            f
        };
        let head = 12 + 8;
        let mut ttc = b"ttcf".to_vec();
        ttc.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 2]);
        ttc.extend_from_slice(&(head as u32).to_be_bytes());
        ttc.extend_from_slice(&((head + a.len()) as u32).to_be_bytes());
        ttc.extend_from_slice(&shift(&a, head));
        ttc.extend_from_slice(&shift(&b, head + a.len()));
        let second = inspect(&ttc, 1).unwrap();
        assert_eq!((second.family.as_str(), second.fs_type), ("Second Face", Some(8)));
        // the copy is a font file on its own
        let again = inspect(&second.data, 0).unwrap();
        assert_eq!(again.family, "Second Face");
        assert_eq!(again.data.len(), b.len());
        assert!(inspect(&ttc, 2).is_err());
    }

    #[test]
    fn family_names_are_escaped_for_google() {
        assert_eq!(enc("Open Sans"), "Open+Sans");
        assert_eq!(enc("M PLUS 1p"), "M+PLUS+1p");
        assert_eq!(enc("a&b=c"), "a%26b%3Dc");
    }
}
