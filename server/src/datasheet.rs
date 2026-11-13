//! A datasheet reader for the assistant: `POST /api/ai/datasheet`.
//!
//! Handing a model a whole datasheet costs tens of thousands of tokens per question, and
//! every conversation pays again.  Here a PDF is downloaded and split into pages once, the
//! page text is kept in Postgres for everybody, and a question gets back only the few pages
//! that answer it (or the pages asked for by number).
//!
//! The address comes from a model, so it is treated as hostile: https only, public hosts
//! only (checked on the resolved address, which the request is then pinned to, and again on
//! every redirect), and a size limit.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

const MAX_PDF_BYTES: usize = 40 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
/// A cached copy older than this is fetched again (datasheets get revised).
const KEEP_DAYS: i64 = 30;
/// What one answer may carry: pages, and characters per page.
const DEFAULT_PAGES: usize = 3;
const MAX_PAGES: usize = 6;
const PAGE_CHARS: usize = 3600;
const FULL_PAGE_CHARS: usize = 7000;

#[derive(Deserialize)]
pub struct Req {
    url: String,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    pages: Option<Vec<usize>>,
    #[serde(default)]
    max_pages: Option<usize>,
}

fn fail(code: &'static str, msg: impl Into<String>) -> AppError {
    AppError::Api(StatusCode::BAD_GATEWAY, code, msg.into())
}

fn allow_local() -> bool {
    // For the test rig only: lets the reader fetch from a server on this machine.
    matches!(std::env::var("AI_DATASHEET_ALLOW_LOCAL").as_deref(), Ok("1"))
}

pub(crate) fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_multicast() || v.is_broadcast()
                || o[0] == 0 || (o[0] == 100 && (o[1] & 0xc0) == 64) || (o[0] == 192 && o[1] == 0 && o[2] == 0) || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return public(IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// The address to connect to for this URL, after checking it is one we may fetch.
async fn vet(url: &reqwest::Url) -> AppResult<Option<(String, SocketAddr)>> {
    let local = allow_local();
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err(AppError::BadRequest("the datasheet address must be an https link".into())),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::BadRequest("the datasheet address must not carry a login".into()));
    }
    let host = url.host_str().ok_or_else(|| AppError::BadRequest("the datasheet address has no host".into()))?.to_string();
    if local {
        return Ok(None);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.trim_matches(|c| c == '[' || c == ']'), port))
        .await
        .map_err(|_| fail("datasheet_unreachable", format!("{host} could not be found.")))?
        .collect();
    // Every address must be public: a name that also answers with a private one is not trusted.
    if addrs.is_empty() || !addrs.iter().all(|a| public(a.ip())) {
        return Err(AppError::BadRequest("the datasheet address must be a public web address".into()));
    }
    Ok(Some((host, addrs[0])))
}

async fn download(start: &str) -> AppResult<Vec<u8>> {
    let mut url = reqwest::Url::parse(start.trim()).map_err(|_| AppError::BadRequest("url is not a web address".into()))?;
    for _ in 0..=MAX_REDIRECTS {
        let pin = vet(&url).await?;
        let mut b = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; kicad-collab-datasheets)")
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(45));
        if let Some((host, addr)) = &pin {
            b = b.resolve(host, *addr);
        }
        let http = b.build().map_err(|e| anyhow::anyhow!(e))?;
        let r = http
            .get(url.clone())
            .header("accept", "application/pdf,*/*;q=0.5")
            .send()
            .await
            .map_err(|_| fail("datasheet_unreachable", format!("{} did not answer.", url.host_str().unwrap_or("The site"))))?;
        if r.status().is_redirection() {
            let to = r.headers().get("location").and_then(|v| v.to_str().ok()).and_then(|l| url.join(l).ok());
            url = to.ok_or_else(|| fail("datasheet_unreachable", "The site redirected nowhere."))?;
            continue;
        }
        if !r.status().is_success() {
            return Err(fail("datasheet_unreachable", format!("The site answered {} for that address.", r.status().as_u16())));
        }
        if r.content_length().is_some_and(|n| n as usize > MAX_PDF_BYTES) {
            return Err(fail("datasheet_too_large", "That file is too large to read here."));
        }
        let mut out = Vec::new();
        let mut body = r.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|_| fail("datasheet_unreachable", "The download was cut off."))?;
            out.extend_from_slice(&chunk);
            if out.len() > MAX_PDF_BYTES {
                return Err(fail("datasheet_too_large", "That file is too large to read here."));
            }
        }
        return Ok(out);
    }
    Err(fail("datasheet_unreachable", "The site redirected too many times."))
}

/// Page texts of a PDF.  The parser is run off the async threads and behind a panic guard:
/// PDFs in the wild are malformed in every way there is.
async fn page_texts(bytes: Vec<u8>) -> AppResult<Vec<String>> {
    if !bytes.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Err(AppError::Api(
            StatusCode::UNPROCESSABLE_ENTITY,
            "datasheet_not_pdf",
            "That address is not a PDF. Read it as a web page instead, or find the PDF datasheet's own address.".into(),
        ));
    }
    let job = tokio::task::spawn_blocking(move || std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(&bytes)));
    let pages = match tokio::time::timeout(Duration::from_secs(120), job).await {
        Ok(Ok(Ok(Ok(p)))) => p,
        _ => return Err(AppError::Api(StatusCode::UNPROCESSABLE_ENTITY, "datasheet_unreadable", "That PDF could not be read as text.".into())),
    };
    let pages: Vec<String> = pages.iter().map(|p| tidy(p)).collect();
    if pages.iter().all(|p| p.len() < 20) {
        return Err(AppError::Api(StatusCode::UNPROCESSABLE_ENTITY, "datasheet_unreadable", "That PDF has no text layer (it is scanned images).".into()));
    }
    Ok(pages)
}

/// Page text as it is kept: no NULs (Postgres refuses them), no trailing spaces, no blank lines
/// (the extractor puts one after every line, which doubles what a page costs to send).
fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let l: String = line.chars().filter(|c| *c != '\0' && (!c.is_control() || *c == '\t')).collect();
        let l = l.trim_end();
        if l.trim().is_empty() {
            continue;
        }
        out.push_str(l);
        out.push('\n');
    }
    out.trim().to_string()
}

type Doc = Arc<Vec<String>>;

/// The last few documents read, so a run of questions about one datasheet does not go to
/// the database for megabytes of text each time.
fn recent() -> &'static Mutex<VecDeque<(String, Doc)>> {
    static R: OnceLock<Mutex<VecDeque<(String, Doc)>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(VecDeque::new()))
}
fn remember(key: &str, doc: &Doc) {
    if let Ok(mut r) = recent().lock() {
        r.retain(|(k, _)| k != key);
        r.push_front((key.to_string(), doc.clone()));
        r.truncate(6);
    }
}

/// The document's pages and whether they came from the cache.
async fn load(state: &AppState, url: &str) -> AppResult<(Doc, bool)> {
    // The fragment (#page=12) names a place in the document, not another document.
    let bare = url.split('#').next().unwrap_or(url).trim();
    let key: String = Sha256::digest(bare.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    if let Some(d) = recent().lock().ok().and_then(|r| r.iter().find(|(k, _)| *k == key).map(|(_, d)| d.clone())) {
        return Ok((d, true));
    }
    let row = sqlx::query("SELECT pages FROM datasheets WHERE url_hash = $1 AND fetched_at > now() - make_interval(days => $2)")
        .bind(&key)
        .bind(KEEP_DAYS as i32)
        .fetch_optional(&state.pool)
        .await?;
    if let Some(row) = row {
        let doc: Doc = Arc::new(row.get::<Vec<String>, _>("pages"));
        remember(&key, &doc);
        return Ok((doc, true));
    }
    // Parsing a large PDF takes seconds of a core: a few at a time.
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let _slot = GATE.get_or_init(|| tokio::sync::Semaphore::new(3)).acquire().await.map_err(|e| anyhow::anyhow!(e))?;
    let bytes = download(bare).await?;
    let size = bytes.len() as i64;
    let doc: Doc = Arc::new(page_texts(bytes).await?);
    sqlx::query(
        "INSERT INTO datasheets (url_hash, url, bytes, pages) VALUES ($1, $2, $3, $4)
         ON CONFLICT (url_hash) DO UPDATE SET url = EXCLUDED.url, bytes = EXCLUDED.bytes, pages = EXCLUDED.pages, fetched_at = now()",
    )
    .bind(&key)
    .bind(bare)
    .bind(size)
    .bind(&doc[..])
    .execute(&state.pool)
    .await?;
    remember(&key, &doc);
    Ok((doc, false))
}

// ------------------------------------------------------------------ search

fn terms(query: &str) -> Vec<String> {
    const SKIP: &[&str] = &["the", "and", "for", "of", "to", "in", "on", "is", "are", "what", "which", "with", "a", "an", "how", "does", "do", "be", "it", "at", "by", "or", "from"];
    let mut out: Vec<String> = Vec::new();
    for w in query.to_lowercase().split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '+' || c == '-')) {
        let w = w.trim_matches(|c| c == '.' || c == '-');
        if (w.chars().count() >= 2 || w.chars().any(|c| c.is_ascii_digit())) && !w.is_empty() && !SKIP.contains(&w) && !out.iter().any(|x| x == w) {
            out.push(w.to_string());
        }
    }
    out
}

fn count(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

/// Pages ranked for a query: each term counts by how rare it is in the document and how
/// often the page has it (with diminishing returns), and a page that has the terms close
/// together, or the whole phrase, ranks above one that merely mentions them all.
fn rank(doc: &[String], query: &str) -> Vec<(usize, f64)> {
    let ts = terms(query);
    if ts.is_empty() {
        return Vec::new();
    }
    // Lower case with single spaces, so words a line break separates still read as a phrase.
    let lower: Vec<String> = doc.iter().map(|p| p.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")).collect();
    let raw: Vec<String> = doc.iter().map(|p| p.to_lowercase()).collect();
    let n = lower.len() as f64;
    let weights: Vec<f64> = ts
        .iter()
        .map(|t| {
            let df = lower.iter().filter(|p| p.contains(t.as_str())).count() as f64;
            if df == 0.0 { 0.0 } else { (1.0 + n / df).ln() }
        })
        .collect();
    let phrase = ts.join(" ");
    let pairs: Vec<String> = ts.windows(2).map(|w| format!("{} {}", w[0], w[1])).collect();
    let mut out: Vec<(usize, f64)> = Vec::new();
    for (i, p) in lower.iter().enumerate() {
        let mut score = 0.0;
        let mut hit = 0;
        for (t, w) in ts.iter().zip(&weights) {
            let c = count(p, t);
            if c > 0 {
                hit += 1;
                score += w * (1.0 + (c as f64).ln());
            }
        }
        if hit == 0 {
            continue;
        }
        score *= 0.4 + 0.6 * hit as f64 / ts.len() as f64; // pages with all the terms first
        if ts.len() > 1 {
            // The words side by side (a heading, a table caption, the parameter's own name) are
            // worth far more than the same words scattered over a page.
            let adjacent = pairs.iter().filter(|pr| p.contains(pr.as_str())).count();
            score *= 1.0 + 1.2 * adjacent as f64 / pairs.len() as f64;
            if ts.len() > 2 && p.contains(&phrase) {
                score *= 1.5;
            }
            // Lines that carry two or more of the terms: the table row or sentence that answers.
            let dense = raw[i].lines().filter(|l| ts.iter().filter(|t| l.contains(t.as_str())).count() >= 2).count();
            score *= 1.0 + 0.1 * (dense.min(6) as f64);
        }
        // A contents page lists every heading and answers nothing.
        if p.matches(". . .").count() + p.matches("....").count() > 12 {
            score *= 0.25;
        }
        out.push((i, score));
    }
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn cut(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (s.chars().take(max).collect::<String>(), true)
}

/// The part of a page worth sending for a query: the whole page when it is short, else the
/// lines around the matches.
fn excerpt(page: &str, ts: &[String], max: usize) -> (String, bool) {
    if page.chars().count() <= max {
        return (page.to_string(), false);
    }
    let lines: Vec<&str> = page.lines().collect();
    let mut keep = vec![false; lines.len()];
    for (i, l) in lines.iter().enumerate() {
        let low = l.to_lowercase();
        if ts.iter().any(|t| low.contains(t.as_str())) {
            for k in i.saturating_sub(4)..(i + 9).min(lines.len()) {
                keep[k] = true;
            }
        }
    }
    let mut out = String::new();
    let mut gap = false;
    for (i, l) in lines.iter().enumerate() {
        if keep[i] {
            if gap && !out.is_empty() {
                out.push_str("[…]\n");
            }
            gap = false;
            out.push_str(l);
            out.push('\n');
        } else {
            gap = true;
        }
    }
    if out.is_empty() {
        return cut(page, max);
    }
    let (text, _) = cut(out.trim_end(), max);
    (text, true)
}

fn answer(doc: &[String], url: &str, cached: bool, req: &Req) -> Value {
    let total = doc.len();
    let want = req.max_pages.unwrap_or(DEFAULT_PAGES).clamp(1, MAX_PAGES);
    let mut out = json!({ "url": url, "page_count": total, "cached": cached });
    if let Some(list) = req.pages.as_ref().filter(|l| !l.is_empty()) {
        let mut pages = Vec::new();
        let mut seen: HashMap<usize, ()> = HashMap::new();
        for &n in list.iter().filter(|n| **n >= 1 && **n <= total).take(MAX_PAGES) {
            if seen.insert(n, ()).is_some() {
                continue;
            }
            let (text, truncated) = cut(&doc[n - 1], FULL_PAGE_CHARS);
            pages.push(json!({ "page": n, "text": text, "truncated": truncated }));
        }
        out["pages"] = Value::Array(pages);
        return out;
    }
    let query = req.query.as_deref().unwrap_or("").trim();
    if query.is_empty() {
        // No question: the opening page (what the part is), and how to ask for more.
        let (text, truncated) = cut(doc.first().map(String::as_str).unwrap_or(""), 1800);
        out["pages"] = json!([{ "page": 1, "text": text, "truncated": truncated }]);
        out["note"] = json!("Give a query to find the pages that answer a question, or pages to read by number.");
        return out;
    }
    let ranked = rank(doc, query);
    let ts = terms(query);
    // Best first, and only pages in the same league as the best: a weak match is listed by
    // number below instead of being sent.
    let best = ranked.first().map(|r| r.1).unwrap_or(0.0);
    let top: Vec<usize> = ranked.iter().take(want).filter(|(_, sc)| *sc >= best * 0.45).map(|(i, _)| *i).collect();
    let want = top.len();
    out["pages"] = Value::Array(
        top.iter()
            .map(|&i| {
                let (text, partial) = excerpt(&doc[i], &ts, PAGE_CHARS);
                json!({ "page": i + 1, "text": text, "excerpt": partial })
            })
            .collect(),
    );
    let more: Vec<usize> = ranked.iter().skip(want).take(8).map(|(i, _)| i + 1).collect();
    if !more.is_empty() {
        out["other_matching_pages"] = json!(more);
    }
    if ranked.is_empty() {
        out["note"] = json!("No page has those words. Try the datasheet's own terms (a pin name, a parameter symbol, a section title).");
    }
    out
}

/// `POST /api/ai/datasheet` — the pages of a PDF datasheet that answer a query, or pages by number.
pub async fn read(State(state): State<AppState>, _user: AuthUser, Json(req): Json<Req>) -> AppResult<Json<Value>> {
    if req.url.len() > 2000 {
        return Err(AppError::BadRequest("url is too long".into()));
    }
    let (doc, cached) = load(&state, &req.url).await?;
    Ok(Json(answer(&doc, req.url.split('#').next().unwrap_or(&req.url), cached, &req)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses_are_refused() {
        for a in ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(!public(a.parse().unwrap()), "{a}");
        }
        for a in ["8.8.8.8", "151.101.1.1", "2606:4700::1111"] {
            assert!(public(a.parse().unwrap()), "{a}");
        }
    }

    #[test]
    fn search_finds_the_page_that_answers() {
        let doc: Vec<String> = vec![
            "RP2040 Datasheet\nA microcontroller by Raspberry Pi".into(),
            "Contents\n1. Introduction . . . . 3\n2. Crystal . . . . 9\n".into(),
            "2.9 Crystal oscillator\nThe crystal load capacitance is 15 pF with a 1 kΩ series resistor.\n".into(),
            "4.1 Decoupling\nPlace a 100 nF capacitor on every IOVDD pin.\n".into(),
        ];
        let r = rank(&doc, "crystal load capacitance");
        assert_eq!(r[0].0, 2);
        let req = Req { url: "https://x/y.pdf".into(), query: Some("IOVDD decoupling".into()), pages: None, max_pages: Some(1) };
        let a = answer(&doc, "https://x/y.pdf", true, &req);
        assert_eq!(a["pages"][0]["page"], 4);
        let req = Req { url: "u".into(), query: None, pages: Some(vec![3, 99]), max_pages: None };
        let a = answer(&doc, "u", true, &req);
        assert_eq!(a["pages"].as_array().unwrap().len(), 1);
    }
}
