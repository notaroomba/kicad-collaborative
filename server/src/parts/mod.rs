//! Vendor parts and saved part libraries.
//!
//! A part is a *reference*: a vendor (LCSC, Mouser, DigiKey), that vendor's part
//! number and the manufacturer's part number.  That is all a saved library
//! stores.  What the vendor says about the part — description, stock, prices,
//! and for LCSC the schematic symbol, footprint and 3D model — is fetched on
//! demand and kept in a server-wide cache (`parts`), so
//!
//!   * a library stays a short list that never goes stale by itself,
//!   * a part is fetched once however many people and libraries use it,
//!   * and a library still opens, places and exports when the vendor is down:
//!     the cached copy is served, marked stale, until a refetch succeeds.
//!
//! Placing a part embeds its symbol or footprint in the schematic or board, as
//! KiCad always does, so a design never depends on this cache either.
//!
//! Drawings come from EasyEDA, which shares LCSC's catalogue (easyeda.rs
//! converts them to KiCad's formats).  Mouser and DigiKey publish part data
//! only; a part from either borrows the drawings of the LCSC listing with the
//! same manufacturer part number when there is one.

pub mod easyeda;
pub mod tidy;
pub mod vendors;

use std::io::{Cursor, Write};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::persist::{self, User};
use crate::AppState;

use vendors::{ErrKind, Keys, PartInfo, VendorErr, VENDORS};

/// Stock and prices older than this are refetched when the part is next asked for.
const INFO_TTL_HOURS: i64 = 24;
/// How long a "no LCSC listing has this manufacturer part number" answer stands.
const CAD_RECHECK_DAYS: i64 = 7;
/// The library nickname drawings carry when they are not placed from a saved library.
const DEFAULT_LIB: &str = "LCSC";

fn api_err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> AppError {
    AppError::Api(status, code, msg.into())
}

impl From<VendorErr> for AppError {
    fn from(e: VendorErr) -> Self {
        match e.kind {
            ErrKind::Unreachable => api_err(StatusCode::BAD_GATEWAY, "vendor_unreachable", e.message),
            ErrKind::NotFound => api_err(StatusCode::NOT_FOUND, "part_not_found", e.message),
            ErrKind::NotConfigured => api_err(StatusCode::CONFLICT, "vendor_not_configured", e.message),
            ErrKind::Rejected => api_err(StatusCode::CONFLICT, "vendor_rejected_key", e.message),
            ErrKind::Other => api_err(StatusCode::BAD_GATEWAY, "vendor_error", e.message),
        }
    }
}

fn check_vendor(v: &str) -> AppResult<&'static str> {
    VENDORS.iter().copied().find(|k| *k == v).ok_or_else(|| AppError::BadRequest(format!("unknown vendor \"{v}\"")))
}

/// A vendor part number as stored: trimmed, LCSC numbers upper-cased.
fn clean_id(vendor: &str, id: &str) -> AppResult<String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 120 || id.chars().any(|c| c.is_control()) {
        return Err(AppError::BadRequest("missing or malformed part number".into()));
    }
    if vendor == "lcsc" {
        let up = id.to_ascii_uppercase();
        if !vendors::is_lcsc_id(&up) {
            return Err(AppError::BadRequest("an LCSC part number looks like C8734".into()));
        }
        return Ok(up);
    }
    Ok(id.to_string())
}

// ------------------------------------------------------------------ vendor credentials

fn cipher(state: &AppState) -> Aes256Gcm {
    let key = Sha256::digest(format!("kc-vendor-key:{}", state.cfg.jwt_secret).as_bytes());
    Aes256Gcm::new_from_slice(&key).expect("32-byte key")
}

fn seal(state: &AppState, plain: &str) -> AppResult<Vec<u8>> {
    let nonce: [u8; 12] = rand::random();
    let mut blob = nonce.to_vec();
    blob.extend(
        cipher(state)
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|_| anyhow::anyhow!("vendor key encryption failed"))?,
    );
    Ok(blob)
}

fn unseal(state: &AppState, blob: &[u8]) -> Option<String> {
    if blob.len() < 13 {
        return None;
    }
    let plain = cipher(state).decrypt(Nonce::from_slice(&blob[..12]), &blob[12..]).ok()?;
    String::from_utf8(plain).ok()
}

/// The user's own credentials, without the server-wide fallbacks.
async fn user_keys(state: &AppState, user_id: i64) -> AppResult<Keys> {
    let mut keys = Keys::default();
    let rows = sqlx::query("SELECT vendor, secret FROM vendor_keys WHERE user_id = $1").bind(user_id).fetch_all(&state.pool).await?;
    for r in rows {
        let vendor: String = r.get("vendor");
        let blob: Vec<u8> = r.get("secret");
        let Some(v) = unseal(state, &blob).and_then(|p| serde_json::from_str::<Value>(&p).ok()) else { continue };
        let g = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match vendor.as_str() {
            "mouser" if !g("api_key").is_empty() => keys.mouser = Some(g("api_key")),
            "digikey" if !g("client_id").is_empty() && !g("client_secret").is_empty() => keys.digikey = Some((g("client_id"), g("client_secret"))),
            "farnell" if !g("api_key").is_empty() => keys.farnell = Some((g("api_key"), vendors::farnell_store(&g("store")))),
            _ => {}
        }
    }
    Ok(keys)
}

async fn keys_for(state: &AppState, user_id: i64) -> AppResult<Keys> {
    Ok(user_keys(state, user_id).await?.with_server_defaults())
}

/// GET /api/parts/vendors — the vendors, and which of them this user can search.
pub async fn list_vendors(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let own = user_keys(&state, user.id).await?;
    let all = own.clone().with_server_defaults();
    let entry = |id: &str, name: &str, note: &str, fields: Value, signup: &str| {
        json!({
            "id": id, "name": name, "note": note, "fields": fields, "signup": signup,
            "configured": all.has(id),
            "key_source": if id == "lcsc" { Value::Null } else if own.has(id) { json!("yours") } else if all.has(id) { json!("server") } else { Value::Null },
            "drawings": id == "lcsc",
        })
    };
    Ok(Json(json!({ "vendors": [
        entry("lcsc", "LCSC / JLCPCB", "Symbols, footprints and 3D models included. No key needed.", json!([]), ""),
        entry("mouser", "Mouser", "Part data, stock and prices. Drawings are matched from LCSC by manufacturer part number.",
              json!([{ "id": "api_key", "label": "Search API key" }]), "https://www.mouser.com/api-search/"),
        entry("digikey", "DigiKey", "Part data, stock and prices. Drawings are matched from LCSC by manufacturer part number.",
              json!([{ "id": "client_id", "label": "Client ID" }, { "id": "client_secret", "label": "Client secret" }]), "https://developer.digikey.com/"),
        entry("farnell", "Farnell / Newark / element14", "Part data, stock and prices from the store you name. Drawings are matched from LCSC by manufacturer part number.",
              json!([{ "id": "api_key", "label": "Product Search API key" }, { "id": "store", "label": "Store (uk.farnell.com, www.newark.com, au.element14.com, …)", "optional": true }]), "https://partner.element14.com/"),
    ] })))
}

/// PUT /api/parts/keys/{vendor} — store the user's own credentials for a vendor.
pub async fn put_key(State(state): State<AppState>, AuthUser(user): AuthUser, Path(vendor): Path<String>, LenientJson(body): LenientJson<Value>) -> AppResult<Json<Value>> {
    let vendor = check_vendor(&vendor)?;
    let g = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let secret = match vendor {
        "mouser" => {
            if g("api_key").is_empty() {
                return Err(AppError::BadRequest("Enter the Mouser Search API key.".into()));
            }
            json!({ "api_key": g("api_key") })
        }
        "digikey" => {
            if g("client_id").is_empty() || g("client_secret").is_empty() {
                return Err(AppError::BadRequest("Enter both the DigiKey client ID and the client secret.".into()));
            }
            json!({ "client_id": g("client_id"), "client_secret": g("client_secret") })
        }
        "farnell" => {
            if g("api_key").is_empty() {
                return Err(AppError::BadRequest("Enter the Farnell Product Search API key.".into()));
            }
            let store = vendors::farnell_store(&g("store"));
            if store.is_empty() {
                return Err(AppError::BadRequest("The store must be a host name such as uk.farnell.com or www.newark.com.".into()));
            }
            json!({ "api_key": g("api_key"), "store": store })
        }
        _ => return Err(AppError::BadRequest("LCSC needs no key.".into())),
    };
    // Try the credentials before keeping them, so a typo is caught here and not at the next search.
    let mut probe = Keys::default();
    match vendor {
        "mouser" => probe.mouser = Some(g("api_key")),
        "farnell" => probe.farnell = Some((g("api_key"), vendors::farnell_store(&g("store")))),
        _ => probe.digikey = Some((g("client_id"), g("client_secret"))),
    }
    let verified = match vendors::search(vendor, &probe, "STM32F103C8T6", 1).await {
        Ok(_) => true,
        Err(e) if e.kind == ErrKind::Rejected => return Err(e.into()),
        // unreachable right now: keep the key, say it could not be checked
        Err(_) => false,
    };
    sqlx::query(
        "INSERT INTO vendor_keys (user_id, vendor, secret) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, vendor) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()",
    )
    .bind(user.id)
    .bind(vendor)
    .bind(seal(&state, &secret.to_string())?)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "verified": verified })))
}

/// DELETE /api/parts/keys/{vendor}
pub async fn delete_key(State(state): State<AppState>, AuthUser(user): AuthUser, Path(vendor): Path<String>) -> AppResult<Json<Value>> {
    let vendor = check_vendor(&vendor)?;
    sqlx::query("DELETE FROM vendor_keys WHERE user_id = $1 AND vendor = $2").bind(user.id).bind(vendor).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------------------ the cache

#[derive(Debug, Clone, sqlx::FromRow)]
struct PartRow {
    vendor: String,
    vendor_id: String,
    info: Value,
    info_fetched_at: Option<DateTime<Utc>>,
    cad_raw: Option<Value>,
    cad_vendor: Option<String>,
    cad_vendor_id: Option<String>,
    cad_checked_at: Option<DateTime<Utc>>,
}

const PART_COLS: &str = "vendor, vendor_id, info, info_fetched_at, cad_raw, cad_vendor, cad_vendor_id, cad_checked_at";

async fn load_part(state: &AppState, vendor: &str, id: &str) -> AppResult<Option<PartRow>> {
    Ok(sqlx::query_as::<_, PartRow>(&format!("SELECT {PART_COLS} FROM parts WHERE vendor = $1 AND vendor_id = $2"))
        .bind(vendor)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?)
}

async fn store_part(state: &AppState, info: &PartInfo, cad_raw: Option<&Value>) -> AppResult<()> {
    let mut stored = info.clone();
    // JLCPCB's image links are signed for half an hour; a cached copy would only ever be a dead link.
    if stored.vendor == "lcsc" {
        stored.image.clear();
    }
    sqlx::query(
        "INSERT INTO parts (vendor, vendor_id, mpn, manufacturer, info, info_fetched_at, cad_raw, cad_fetched_at)
         VALUES ($1, $2, $3, $4, $5, now(), $6, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (vendor, vendor_id) DO UPDATE SET
           mpn = EXCLUDED.mpn, manufacturer = EXCLUDED.manufacturer, info = EXCLUDED.info, info_fetched_at = now(),
           cad_raw = COALESCE(EXCLUDED.cad_raw, parts.cad_raw),
           cad_fetched_at = CASE WHEN EXCLUDED.cad_raw IS NULL THEN parts.cad_fetched_at ELSE now() END",
    )
    .bind(&stored.vendor)
    .bind(&stored.vendor_id)
    .bind(&stored.mpn)
    .bind(&stored.manufacturer)
    .bind(serde_json::to_value(&stored).unwrap_or(Value::Null))
    .bind(cad_raw)
    .execute(&state.pool)
    .await?;
    Ok(())
}

fn fresh(at: Option<DateTime<Utc>>, hours: i64) -> bool {
    at.is_some_and(|t| Utc::now() - t < chrono::Duration::hours(hours))
}

/// Ask the vendor about one part and cache the answer.
async fn fetch_part(state: &AppState, keys: &Keys, vendor: &str, id: &str) -> Result<(), VendorErr> {
    let stored = if vendor == "lcsc" {
        let raw = vendors::easyeda_component(id).await?;
        let conv = easyeda::convert(&raw).ok();
        let mut info = vendors::lcsc_info_from_easyeda(id, &raw, conv.as_ref());
        // EasyEDA knows the part and its drawings; JLCPCB's search knows the datasheet, the
        // attributes and the price breaks.  Best effort: the part stands without them.
        if let Ok(hits) = vendors::search("lcsc", keys, id, 5).await {
            if let Some(h) = hits.into_iter().find(|h| h.vendor_id == id) {
                if info.manufacturer.is_empty() {
                    info.manufacturer = h.manufacturer;
                }
                if info.description.is_empty() || h.description.len() > info.description.len() {
                    info.description = h.description;
                }
                if !h.datasheet.is_empty() {
                    info.datasheet = h.datasheet;
                }
                if h.prices.len() > info.prices.len() {
                    info.prices = h.prices;
                }
                if h.stock.is_some() {
                    info.stock = h.stock;
                }
                if !h.assembly.is_empty() {
                    info.assembly = h.assembly;
                }
                info.category = h.category;
                info.attributes = h.attributes;
                if !h.package.is_empty() && info.package.is_empty() {
                    info.package = h.package;
                }
            }
        }
        store_part(state, &info, Some(&raw)).await
    } else {
        let mut info = vendors::fetch_info(vendor, keys, id).await?;
        info.vendor_id = id.to_string();
        store_part(state, &info, None).await
    };
    stored.map_err(|_| VendorErr { kind: ErrKind::Other, message: "The part could not be saved.".into() })
}

/// The cached part, fetched or refreshed as needed.  The bool says the copy is
/// stale: older than it should be because the vendor could not be asked.
async fn ensure_part(state: &AppState, keys: &Keys, vendor: &str, id: &str, refresh: bool) -> AppResult<(PartRow, Option<String>)> {
    let have = load_part(state, vendor, id).await?;
    let wants_fetch = match &have {
        None => true,
        Some(row) => refresh || !fresh(row.info_fetched_at, INFO_TTL_HOURS) || (vendor == "lcsc" && row.cad_raw.is_none()),
    };
    if !wants_fetch {
        return Ok((have.unwrap(), None));
    }
    match fetch_part(state, keys, vendor, id).await {
        Ok(()) => Ok((load_part(state, vendor, id).await?.ok_or(AppError::NotFound)?, None)),
        Err(e) => match have {
            // the reference outlives the vendor's bad day
            Some(row) if e.kind != ErrKind::NotFound || row.cad_raw.is_some() => Ok((row, Some(e.message))),
            _ => Err(e.into()),
        },
    }
}

/// Where a part's drawings come from: itself for LCSC, else the LCSC listing with
/// the same manufacturer part number (looked up once, then remembered).
async fn cad_source(state: &AppState, keys: &Keys, row: &PartRow, info: &PartInfo) -> AppResult<Option<PartRow>> {
    if row.vendor == "lcsc" {
        return Ok(row.cad_raw.is_some().then(|| row.clone()));
    }
    let mut target = row.cad_vendor_id.clone().filter(|_| row.cad_vendor.as_deref() == Some("lcsc"));
    if target.is_none() && !fresh(row.cad_checked_at, CAD_RECHECK_DAYS * 24) && !info.mpn.is_empty() {
        match vendors::find_lcsc_by_mpn(&info.mpn).await {
            Ok(found) => {
                target = found.map(|f| f.vendor_id);
                sqlx::query("UPDATE parts SET cad_vendor = $3, cad_vendor_id = $4, cad_checked_at = now() WHERE vendor = $1 AND vendor_id = $2")
                    .bind(&row.vendor)
                    .bind(&row.vendor_id)
                    .bind(target.as_ref().map(|_| "lcsc"))
                    .bind(&target)
                    .execute(&state.pool)
                    .await?;
            }
            Err(_) => return Ok(None), // not recorded: asked again next time
        }
    }
    let Some(lcsc_id) = target else { return Ok(None) };
    match ensure_part(state, keys, "lcsc", &lcsc_id, false).await {
        Ok((src, _)) if src.cad_raw.is_some() => Ok(Some(src)),
        _ => Ok(None),
    }
}

fn info_of(row: &PartRow) -> PartInfo {
    let mut info: PartInfo = serde_json::from_value(row.info.clone()).unwrap_or_default();
    info.vendor = row.vendor.clone();
    info.vendor_id = row.vendor_id.clone();
    info
}

/// The fields a placed symbol carries so the part can be found, ordered and refetched.
fn part_fields(info: &PartInfo, cad_lcsc: Option<&str>) -> Vec<(String, String)> {
    let mut f = vec![("MPN".to_string(), info.mpn.clone()), ("Manufacturer".to_string(), info.manufacturer.clone())];
    f.push((vendors::vendor_label(&info.vendor).to_string(), info.vendor_id.clone()));
    if info.vendor != "lcsc" {
        if let Some(c) = cad_lcsc {
            f.push(("LCSC".to_string(), c.to_string()));
        }
    }
    f.retain(|(_, v)| !v.is_empty());
    f
}

struct Drawings {
    source_id: String,
    conv: easyeda::Converted,
    symbol: Option<String>,
    footprint: Option<String>,
}

/// Convert the cached vendor drawing data into KiCad library items for library `lib`.
fn drawings(info: &PartInfo, src: &PartRow, lib: &str) -> Option<Drawings> {
    let raw = src.cad_raw.as_ref()?;
    let conv = easyeda::convert(raw).ok()?;
    let fields = part_fields(info, Some(&src.vendor_id));
    let fp_ref = conv.footprint.as_ref().map(|f| format!("{lib}:{}", f.name)).unwrap_or_default();
    let datasheet = if info.datasheet.is_empty() { conv.datasheet.clone() } else { info.datasheet.clone() };
    let value = if info.mpn.is_empty() { conv.name.clone() } else { info.mpn.clone() };
    let symbol = conv.symbol.as_ref().map(|s| easyeda::symbol_sexpr(s, &conv.prefix, &value, &fp_ref, &datasheet, &info.description, &fields));
    let footprint = conv.footprint.as_ref().map(|f| {
        let model = f.model.as_ref().map(|m| format!("${{KICAD_COLLAB_3DMODELS}}/{lib}.3dshapes/{}.step", easyeda::lib_name(if m.title.is_empty() { &f.name } else { &m.title })));
        easyeda::footprint_sexpr(f, &value, &info.description, &format!("{} {}", info.vendor_id, info.mpn).trim().to_string(), model.as_deref())
    });
    Some(Drawings { source_id: src.vendor_id.clone(), conv, symbol, footprint })
}

fn lib_nick(raw: Option<&str>) -> String {
    let n = easyeda::lib_name(raw.unwrap_or(DEFAULT_LIB));
    if n.is_empty() || n == "PART" && raw.is_none_or(|r| r.trim().is_empty()) {
        DEFAULT_LIB.into()
    } else {
        n
    }
}

fn part_view(row: &PartRow, src: Option<&PartRow>, lib: &str, stale: Option<String>) -> Value {
    let info = info_of(row);
    let d = src.and_then(|s| drawings(&info, s, lib));
    let fields: serde_json::Map<String, Value> = part_fields(&info, d.as_ref().map(|d| d.source_id.as_str())).into_iter().map(|(k, v)| (k, json!(v))).collect();
    let cad = d.map(|d| {
        let model_qs = format!("vendor={}&id={}", row.vendor, urlencode(&row.vendor_id));
        json!({
            "source": { "vendor": "lcsc", "vendor_id": d.source_id },
            "lib": lib,
            "reference": d.conv.prefix,
            "symbol": d.conv.symbol.as_ref().zip(d.symbol.as_ref()).map(|(s, sexpr)| json!({
                "name": s.name, "lib_id": format!("{lib}:{}", s.name), "sexpr": sexpr, "units": s.units, "pins": s.pins,
            })),
            "footprint": d.conv.footprint.as_ref().zip(d.footprint.as_ref()).map(|(f, sexpr)| json!({
                "name": f.name, "fpid": format!("{lib}:{}", f.name), "sexpr": sexpr, "pads": f.pads, "through_hole": f.through_hole,
            })),
            "model": d.conv.footprint.as_ref().and_then(|f| f.model.as_ref()).map(|m| json!({
                "title": m.title, "url": format!("/api/parts/model.step?{model_qs}"),
            })),
        })
    });
    let mut v = serde_json::to_value(&info).unwrap_or_else(|_| json!({}));
    let o = v.as_object_mut().expect("part info is an object");
    o.insert("vendor_name".into(), json!(vendors::vendor_label(&info.vendor)));
    o.insert("cad".into(), cad.unwrap_or(Value::Null));
    o.insert("fields".into(), Value::Object(fields));
    o.insert("fetched_at".into(), json!(row.info_fetched_at));
    o.insert("stale".into(), json!(stale.is_some()));
    o.insert("stale_reason".into(), json!(stale));
    v
}

fn urlencode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

// ------------------------------------------------------------------ search and fetch

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    vendor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// GET /api/parts/search?q=&vendor=lcsc|mouser|digikey|all
pub async fn search(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<SearchQuery>) -> AppResult<Json<Value>> {
    let text = q.q.trim().to_string();
    if text.len() < 2 {
        return Err(AppError::BadRequest("Type at least two characters to search.".into()));
    }
    if text.len() > 200 {
        return Err(AppError::BadRequest("That search is too long.".into()));
    }
    let limit = q.limit.unwrap_or(25).clamp(1, 50);
    let keys = keys_for(&state, user.id).await?;
    let which = q.vendor.as_deref().unwrap_or("all");
    let wanted: Vec<&str> = if which == "all" { VENDORS.iter().copied().filter(|v| keys.has(v)).collect() } else { vec![check_vendor(which)?] };

    let mut results: Vec<PartInfo> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    // A bare LCSC number names one part: answer with exactly that part.
    if vendors::is_lcsc_id(&text) && wanted.contains(&"lcsc") {
        let id = text.to_ascii_uppercase();
        match ensure_part(&state, &keys, "lcsc", &id, false).await {
            Ok((row, _)) => results.push(info_of(&row)),
            Err(AppError::Api(_, code, msg)) if code != "part_not_found" => errors.push(json!({ "vendor": "lcsc", "code": code, "message": msg })),
            Err(AppError::Api(..)) => {}
            Err(e) => return Err(e),
        }
        if which != "all" || !results.is_empty() {
            return Ok(Json(json!({ "query": text, "results": results, "errors": errors })));
        }
    }

    let calls = wanted.iter().map(|v| {
        let keys = &keys;
        let text = &text;
        async move { (*v, vendors::search(v, keys, text, limit).await) }
    });
    for (vendor, res) in futures_util::future::join_all(calls).await {
        match res {
            Ok(hits) => results.extend(hits),
            Err(e) => {
                let app: AppError = e.into();
                if let AppError::Api(_, code, msg) = app {
                    errors.push(json!({ "vendor": vendor, "code": code, "message": msg }));
                }
            }
        }
    }
    // Which hits are already cached with drawings (so the list can say so without a fetch).
    let ids: Vec<String> = results.iter().filter(|r| r.vendor == "lcsc").map(|r| r.vendor_id.clone()).collect();
    let cached: Vec<String> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar("SELECT vendor_id FROM parts WHERE vendor = 'lcsc' AND cad_raw IS NOT NULL AND vendor_id = ANY($1)")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await?
    };
    let out: Vec<Value> = results
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap_or_else(|_| json!({}));
            v["vendor_name"] = json!(vendors::vendor_label(&r.vendor));
            v["cached"] = json!(r.vendor == "lcsc" && cached.contains(&r.vendor_id));
            v
        })
        .collect();
    Ok(Json(json!({ "query": text, "results": out, "errors": errors })))
}

#[derive(Deserialize)]
pub struct PartQuery {
    vendor: String,
    id: String,
    #[serde(default)]
    refresh: Option<String>,
    #[serde(default)]
    lib: Option<String>,
}

fn truthy(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1") | Some("true") | Some("yes"))
}

/// GET /api/parts/part?vendor=&id=[&refresh=1][&lib=Nickname] — one part, with its
/// KiCad symbol and footprint when the vendor (or its LCSC twin) has drawings.
pub async fn get_part(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<PartQuery>) -> AppResult<Json<Value>> {
    let vendor = check_vendor(&q.vendor)?;
    let id = clean_id(vendor, &q.id)?;
    let keys = keys_for(&state, user.id).await?;
    let (row, stale) = ensure_part(&state, &keys, vendor, &id, truthy(&q.refresh)).await?;
    let info = info_of(&row);
    let src = cad_source(&state, &keys, &row, &info).await?;
    Ok(Json(part_view(&row, src.as_ref(), &lib_nick(q.lib.as_deref()), stale)))
}

#[derive(Deserialize)]
pub struct CadLink {
    #[serde(default)]
    lcsc: Option<String>,
}

/// PUT /api/parts/cad?vendor=&id= {lcsc: "C8734" | null} — say which LCSC listing's
/// drawings stand in for a Mouser or DigiKey part (null: look it up again).
pub async fn link_cad(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<PartQuery>, LenientJson(body): LenientJson<CadLink>) -> AppResult<Json<Value>> {
    let vendor = check_vendor(&q.vendor)?;
    if vendor == "lcsc" {
        return Err(AppError::BadRequest("An LCSC part uses its own drawings.".into()));
    }
    let id = clean_id(vendor, &q.id)?;
    let keys = keys_for(&state, user.id).await?;
    let (row, _) = ensure_part(&state, &keys, vendor, &id, false).await?;
    let target = match body.lcsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(c) => {
            let c = clean_id("lcsc", c)?;
            let (src, _) = ensure_part(&state, &keys, "lcsc", &c, false).await?;
            if src.cad_raw.is_none() {
                return Err(api_err(StatusCode::NOT_FOUND, "part_not_found", format!("LCSC has no drawings for {c}.")));
            }
            Some(c)
        }
        None => None,
    };
    sqlx::query("UPDATE parts SET cad_vendor = $3, cad_vendor_id = $4, cad_checked_at = $5 WHERE vendor = $1 AND vendor_id = $2")
        .bind(&row.vendor)
        .bind(&row.vendor_id)
        .bind(target.as_ref().map(|_| "lcsc"))
        .bind(&target)
        .bind(target.as_ref().map(|_| Utc::now()))
        .execute(&state.pool)
        .await?;
    let row = load_part(&state, vendor, &id).await?.ok_or(AppError::NotFound)?;
    let info = info_of(&row);
    let src = cad_source(&state, &keys, &row, &info).await?;
    Ok(Json(part_view(&row, src.as_ref(), &lib_nick(q.lib.as_deref()), None)))
}

/// The STEP model behind a part's footprint, fetched once and kept.
async fn model_bytes(state: &AppState, uuid: &str) -> AppResult<Vec<u8>> {
    if let Some(bytes) = sqlx::query_scalar::<_, Vec<u8>>("SELECT step FROM part_models WHERE uuid = $1").bind(uuid).fetch_optional(&state.pool).await? {
        return Ok(bytes);
    }
    let bytes = vendors::easyeda_step(uuid).await?;
    sqlx::query("INSERT INTO part_models (uuid, step) VALUES ($1, $2) ON CONFLICT (uuid) DO NOTHING").bind(uuid).bind(&bytes).execute(&state.pool).await?;
    Ok(bytes)
}

/// GET /api/parts/model.step?vendor=&id=
pub async fn get_model(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<PartQuery>) -> AppResult<Response> {
    let vendor = check_vendor(&q.vendor)?;
    let id = clean_id(vendor, &q.id)?;
    let keys = keys_for(&state, user.id).await?;
    let (row, _) = ensure_part(&state, &keys, vendor, &id, false).await?;
    let info = info_of(&row);
    let src = cad_source(&state, &keys, &row, &info).await?.ok_or(AppError::NotFound)?;
    let d = drawings(&info, &src, DEFAULT_LIB).ok_or(AppError::NotFound)?;
    let model = d.conv.footprint.and_then(|f| f.model).ok_or(AppError::NotFound)?;
    let bytes = model_bytes(&state, &model.uuid).await?;
    let name = easyeda::lib_name(if model.title.is_empty() { &id } else { &model.title });
    Ok((
        [
            (header::CONTENT_TYPE, "model/step".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}.step\"")),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        bytes,
    )
        .into_response())
}

// ------------------------------------------------------------------ saved libraries

#[derive(Debug, Clone, sqlx::FromRow)]
struct LibRow {
    id: Uuid,
    owner_id: i64,
    project_id: Option<Uuid>,
    name: String,
    description: String,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, PartialEq)]
enum Access {
    View,
    Edit,
}

/// The library, if this user may see it; with whether they may change it.
async fn library_for(state: &AppState, user: &User, id: Uuid) -> AppResult<(LibRow, Access)> {
    let lib = sqlx::query_as::<_, LibRow>("SELECT id, owner_id, project_id, name, description, updated_at FROM part_libraries WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    if lib.owner_id == user.id {
        return Ok((lib, Access::Edit));
    }
    if let Some(pid) = lib.project_id {
        match persist::effective_role(&state.pool, user.id, pid).await?.as_deref() {
            Some("editor") => return Ok((lib, Access::Edit)),
            Some(_) => return Ok((lib, Access::View)),
            None => {}
        }
    }
    Err(AppError::NotFound)
}

fn clean_name(raw: &str) -> AppResult<String> {
    let n = raw.trim();
    if n.is_empty() || n.len() > 80 {
        return Err(AppError::BadRequest("Give the library a name of up to 80 characters.".into()));
    }
    Ok(n.to_string())
}

#[derive(Deserialize)]
pub struct LibListQuery {
    #[serde(default)]
    project: Option<Uuid>,
}

/// GET /api/libraries[?project=<id>] — my libraries, plus those shared through
/// projects I belong to (all of them, or just the named project's).
pub async fn list_libraries(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<LibListQuery>) -> AppResult<Json<Value>> {
    let rows = sqlx::query(
        "SELECT l.id, l.owner_id, l.project_id, l.name, l.description, l.updated_at, u.login AS owner_login, p.name AS project_name,
                (SELECT count(*) FROM part_library_items i WHERE i.library_id = l.id) AS items,
                CASE WHEN l.owner_id = $1 OR p.owner_id = $1 OR perm.role = 'editor' THEN true ELSE false END AS can_edit
         FROM part_libraries l
         JOIN users u ON u.id = l.owner_id
         LEFT JOIN projects p ON p.id = l.project_id
         LEFT JOIN permissions perm ON perm.project_id = l.project_id AND perm.user_id = $1
         WHERE (l.owner_id = $1 OR p.owner_id = $1 OR perm.role IS NOT NULL)
           AND ($2::uuid IS NULL OR l.project_id = $2 OR l.owner_id = $1)
         ORDER BY (l.project_id IS NOT DISTINCT FROM $2 AND $2::uuid IS NOT NULL) DESC, lower(l.name)",
    )
    .bind(user.id)
    .bind(q.project)
    .fetch_all(&state.pool)
    .await?;
    let libs: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"), "name": r.get::<String, _>("name"), "description": r.get::<String, _>("description"),
                "project_id": r.get::<Option<Uuid>, _>("project_id"), "project_name": r.get::<Option<String>, _>("project_name"),
                "owner_login": r.get::<String, _>("owner_login"), "mine": r.get::<i64, _>("owner_id") == user.id,
                "items": r.get::<i64, _>("items"), "can_edit": r.get::<bool, _>("can_edit"), "updated_at": r.get::<DateTime<Utc>, _>("updated_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "libraries": libs })))
}

#[derive(Deserialize)]
pub struct LibBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// Present and null detaches the library from its project; absent leaves it alone.
    #[serde(default, deserialize_with = "double_option")]
    project_id: Option<Option<Uuid>>,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

async fn may_share_with(state: &AppState, user: &User, project: Uuid) -> AppResult<()> {
    match persist::effective_role(&state.pool, user.id, project).await?.as_deref() {
        Some("editor") => Ok(()),
        _ => Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only an editor of that project can share a library with it.")),
    }
}

/// POST /api/libraries {name, description?, project_id?}
pub async fn create_library(State(state): State<AppState>, AuthUser(user): AuthUser, LenientJson(body): LenientJson<LibBody>) -> AppResult<Json<Value>> {
    let name = clean_name(body.name.as_deref().unwrap_or(""))?;
    let project = body.project_id.flatten();
    if let Some(pid) = project {
        may_share_with(&state, &user, pid).await?;
    }
    let id: Uuid = sqlx::query_scalar("INSERT INTO part_libraries (owner_id, project_id, name, description) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(user.id)
        .bind(project)
        .bind(&name)
        .bind(body.description.as_deref().unwrap_or("").trim())
        .fetch_one(&state.pool)
        .await?;
    library_json(&state, &user, id).await
}

/// PATCH /api/libraries/{id}
pub async fn update_library(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>, LenientJson(body): LenientJson<LibBody>) -> AppResult<Json<Value>> {
    let (lib, access) = library_for(&state, &user, id).await?;
    if access != Access::Edit {
        return Err(AppError::Forbidden);
    }
    let name = match body.name.as_deref() {
        Some(n) => clean_name(n)?,
        None => lib.name.clone(),
    };
    let project = match body.project_id {
        Some(p) => {
            // moving a library between projects, or out of one, is its owner's call
            if lib.owner_id != user.id {
                return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the library's owner can change who it is shared with."));
            }
            if let Some(pid) = p {
                may_share_with(&state, &user, pid).await?;
            }
            p
        }
        None => lib.project_id,
    };
    sqlx::query("UPDATE part_libraries SET name = $2, description = $3, project_id = $4, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(&name)
        .bind(body.description.as_deref().map(str::trim).unwrap_or(&lib.description))
        .bind(project)
        .execute(&state.pool)
        .await?;
    library_json(&state, &user, id).await
}

/// DELETE /api/libraries/{id} — the owner only.  The parts stay in the cache.
pub async fn delete_library(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (lib, _) = library_for(&state, &user, id).await?;
    if lib.owner_id != user.id {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the library's owner can delete it."));
    }
    sqlx::query("DELETE FROM part_libraries WHERE id = $1").bind(id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn library_json(state: &AppState, user: &User, id: Uuid) -> AppResult<Json<Value>> {
    let (lib, access) = library_for(state, user, id).await?;
    let rows = sqlx::query(
        "SELECT i.id, i.vendor, i.vendor_id, i.mpn, i.manufacturer, i.note, i.added_at,
                p.info, p.info_fetched_at, (p.cad_raw IS NOT NULL OR p.cad_vendor_id IS NOT NULL) AS has_cad
         FROM part_library_items i
         LEFT JOIN parts p ON p.vendor = i.vendor AND p.vendor_id = i.vendor_id
         WHERE i.library_id = $1
         ORDER BY i.added_at, i.id",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let vendor: String = r.get("vendor");
            let info: Option<Value> = r.get("info");
            let info: PartInfo = info.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            json!({
                "id": r.get::<Uuid, _>("id"), "vendor": vendor, "vendor_name": vendors::vendor_label(&vendor),
                "vendor_id": r.get::<String, _>("vendor_id"), "mpn": r.get::<String, _>("mpn"), "manufacturer": r.get::<String, _>("manufacturer"),
                "note": r.get::<String, _>("note"), "added_at": r.get::<DateTime<Utc>, _>("added_at"),
                // what the cache holds for the reference right now (absent until first fetched)
                "cached": r.get::<Option<DateTime<Utc>>, _>("info_fetched_at").is_some(),
                "fetched_at": r.get::<Option<DateTime<Utc>>, _>("info_fetched_at"),
                "has_cad": r.get::<Option<bool>, _>("has_cad").unwrap_or(false),
                "description": info.description, "package": info.package, "stock": info.stock, "prices": info.prices,
                "datasheet": info.datasheet, "url": info.url, "assembly": info.assembly,
            })
        })
        .collect();
    let project_name: Option<String> = match lib.project_id {
        Some(pid) => sqlx::query_scalar("SELECT name FROM projects WHERE id = $1").bind(pid).fetch_optional(&state.pool).await?,
        None => None,
    };
    Ok(Json(json!({
        "id": lib.id, "name": lib.name, "nickname": easyeda::lib_name(&lib.name), "description": lib.description,
        "project_id": lib.project_id, "project_name": project_name,
        "mine": lib.owner_id == user.id, "can_edit": access == Access::Edit, "updated_at": lib.updated_at, "items": items,
    })))
}

/// GET /api/libraries/{id}
pub async fn get_library(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    library_json(&state, &user, id).await
}

#[derive(Deserialize)]
pub struct ItemBody {
    vendor: String,
    vendor_id: String,
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/libraries/{id}/items {vendor, vendor_id, note?} — add a reference.
/// The part is fetched into the cache first, so a typo never lands in a library.
pub async fn add_item(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>, LenientJson(body): LenientJson<ItemBody>) -> AppResult<Json<Value>> {
    let (_, access) = library_for(&state, &user, id).await?;
    if access != Access::Edit {
        return Err(AppError::Forbidden);
    }
    let vendor = check_vendor(&body.vendor)?;
    let vid = clean_id(vendor, &body.vendor_id)?;
    let keys = keys_for(&state, user.id).await?;
    let (row, _) = ensure_part(&state, &keys, vendor, &vid, false).await?;
    let info = info_of(&row);
    // resolve the drawings now so the library shows straight away whether the part can be placed
    let _ = cad_source(&state, &keys, &row, &info).await?;
    sqlx::query(
        "INSERT INTO part_library_items (library_id, vendor, vendor_id, mpn, manufacturer, note, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (library_id, vendor, vendor_id) DO UPDATE SET mpn = EXCLUDED.mpn, manufacturer = EXCLUDED.manufacturer,
           note = CASE WHEN EXCLUDED.note = '' THEN part_library_items.note ELSE EXCLUDED.note END",
    )
    .bind(id)
    .bind(vendor)
    .bind(&vid)
    .bind(&info.mpn)
    .bind(&info.manufacturer)
    .bind(body.note.as_deref().unwrap_or("").trim())
    .bind(user.id)
    .execute(&state.pool)
    .await?;
    sqlx::query("UPDATE part_libraries SET updated_at = now() WHERE id = $1").bind(id).execute(&state.pool).await?;
    library_json(&state, &user, id).await
}

#[derive(Deserialize)]
pub struct NoteBody {
    note: String,
}

/// PATCH /api/libraries/{id}/items/{item}
pub async fn update_item(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, item)): Path<(Uuid, Uuid)>, LenientJson(body): LenientJson<NoteBody>) -> AppResult<Json<Value>> {
    let (_, access) = library_for(&state, &user, id).await?;
    if access != Access::Edit {
        return Err(AppError::Forbidden);
    }
    let note: String = body.note.trim().chars().take(500).collect();
    sqlx::query("UPDATE part_library_items SET note = $3 WHERE library_id = $1 AND id = $2").bind(id).bind(item).bind(note).execute(&state.pool).await?;
    library_json(&state, &user, id).await
}

/// DELETE /api/libraries/{id}/items/{item}
pub async fn remove_item(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, item)): Path<(Uuid, Uuid)>) -> AppResult<Json<Value>> {
    let (_, access) = library_for(&state, &user, id).await?;
    if access != Access::Edit {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM part_library_items WHERE library_id = $1 AND id = $2").bind(id).bind(item).execute(&state.pool).await?;
    sqlx::query("UPDATE part_libraries SET updated_at = now() WHERE id = $1").bind(id).execute(&state.pool).await?;
    library_json(&state, &user, id).await
}

async fn library_refs(state: &AppState, id: Uuid) -> AppResult<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT vendor, vendor_id FROM part_library_items WHERE library_id = $1 ORDER BY added_at, id").bind(id).fetch_all(&state.pool).await?;
    Ok(rows.iter().map(|r| (r.get("vendor"), r.get("vendor_id"))).collect())
}

/// POST /api/libraries/{id}/refresh — refetch every part the library names.
pub async fn refresh_library(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    library_for(&state, &user, id).await?;
    let keys = keys_for(&state, user.id).await?;
    let mut refreshed = 0;
    let mut failed: Vec<Value> = Vec::new();
    for (vendor, vid) in library_refs(&state, id).await? {
        match ensure_part(&state, &keys, &vendor, &vid, true).await {
            Ok((_, None)) => refreshed += 1,
            Ok((_, Some(why))) => failed.push(json!({ "vendor": vendor, "vendor_id": vid, "message": why, "kept": true })),
            Err(AppError::Api(_, _, msg)) => failed.push(json!({ "vendor": vendor, "vendor_id": vid, "message": msg, "kept": false })),
            Err(e) => return Err(e),
        }
    }
    let Json(lib) = library_json(&state, &user, id).await?;
    Ok(Json(json!({ "refreshed": refreshed, "failed": failed, "library": lib })))
}

/// GET /api/libraries/{id}/export.zip — the library as KiCad reads it:
/// `<Name>.kicad_sym`, `<Name>.pretty/*.kicad_mod`, `<Name>.3dshapes/*.step`.
/// Every reference is resolved through the cache, fetching what is missing.
pub async fn export_library(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<Uuid>, Query(q): Query<ExportQuery>) -> AppResult<Response> {
    let (lib, _) = library_for(&state, &user, id).await?;
    let keys = keys_for(&state, user.id).await?;
    let nick = easyeda::lib_name(&lib.name);
    let with_models = !matches!(q.models.as_deref(), Some("0") | Some("false") | Some("no"));

    let mut symbols: Vec<String> = Vec::new();
    let mut sym_names: Vec<String> = Vec::new();
    let mut footprints: Vec<(String, String)> = Vec::new();
    let mut models: Vec<(String, Vec<u8>)> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    for (vendor, vid) in library_refs(&state, id).await? {
        let label = format!("{} {vid}", vendors::vendor_label(&vendor));
        let row = match ensure_part(&state, &keys, &vendor, &vid, false).await {
            Ok((row, _)) => row,
            Err(AppError::Api(_, _, msg)) => {
                notes.push(format!("{label}: left out — {msg}"));
                continue;
            }
            Err(e) => return Err(e),
        };
        let info = info_of(&row);
        let Some(src) = cad_source(&state, &keys, &row, &info).await? else {
            notes.push(format!("{label} ({}): left out — no symbol or footprint is available for it.", info.mpn));
            continue;
        };
        let Some(d) = drawings(&info, &src, &nick) else {
            notes.push(format!("{label} ({}): left out — its drawings could not be converted.", info.mpn));
            continue;
        };
        if let (Some(s), Some(sexpr)) = (&d.conv.symbol, &d.symbol) {
            if !sym_names.contains(&s.name) {
                sym_names.push(s.name.clone());
                symbols.push(sexpr.clone());
            }
        } else {
            notes.push(format!("{label} ({}): no schematic symbol.", info.mpn));
        }
        if let (Some(f), Some(sexpr)) = (&d.conv.footprint, &d.footprint) {
            if !footprints.iter().any(|(n, _)| n == &f.name) {
                footprints.push((f.name.clone(), sexpr.clone()));
                if let (true, Some(m)) = (with_models, &f.model) {
                    let name = easyeda::lib_name(if m.title.is_empty() { &f.name } else { &m.title });
                    if !models.iter().any(|(n, _)| n == &name) {
                        match model_bytes(&state, &m.uuid).await {
                            Ok(bytes) => models.push((name, bytes)),
                            Err(_) => notes.push(format!("{label} ({}): its 3D model could not be fetched.", info.mpn)),
                        }
                    }
                }
            }
        } else {
            notes.push(format!("{label} ({}): no footprint.", info.mpn));
        }
    }

    let sym_file = format!(
        "(kicad_symbol_lib\n\t(version 20241209)\n\t(generator \"kicad-collab-parts\")\n\t(generator_version \"9.0\")\n{}\n)\n",
        symbols.iter().map(|s| format!("\t{s}")).collect::<Vec<_>>().join("\n")
    );
    let readme = format!(
        "{name} — a Junction part library\n\
         ==========================================\n\n\
         {symbols} symbols, {fps} footprints, {models} 3D models.\n\n\
         To use it in KiCad:\n\
         \x20 1. Preferences > Manage Symbol Libraries > add  {nick}.kicad_sym  with the nickname  {nick}\n\
         \x20 2. Preferences > Manage Footprint Libraries > add the folder  {nick}.pretty  with the nickname  {nick}\n\
         \x20 3. Preferences > Configure Paths > add  KICAD_COLLAB_3DMODELS  pointing at the folder that holds  {nick}.3dshapes\n\n\
         The nickname matters: each symbol's Footprint field reads \"{nick}:<footprint>\".\n\
         Symbols carry the vendor part number, manufacturer part number and manufacturer as fields, for the BOM.\n\
         {notes}",
        name = lib.name,
        symbols = symbols.len(),
        fps = footprints.len(),
        models = models.len(),
        notes = if notes.is_empty() { String::new() } else { format!("\nNotes\n-----\n{}\n", notes.join("\n")) },
    );

    let zipped = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(format!("{nick}.kicad_sym"), opts)?;
        zip.write_all(sym_file.as_bytes())?;
        for (name, sexpr) in &footprints {
            zip.start_file(format!("{nick}.pretty/{name}.kicad_mod"), opts)?;
            zip.write_all(sexpr.as_bytes())?;
            zip.write_all(b"\n")?;
        }
        for (name, bytes) in &models {
            zip.start_file(format!("{nick}.3dshapes/{name}.step"), opts)?;
            zip.write_all(bytes)?;
        }
        zip.start_file("README.txt", opts)?;
        zip.write_all(readme.as_bytes())?;
        Ok(zip.finish()?.into_inner())
    })
    .await
    .map_err(|e| anyhow::anyhow!("zip task failed: {e}"))??;

    let file = easyeda::lib_name(&lib.name);
    Ok((
        [(header::CONTENT_TYPE, "application/zip".to_string()), (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{file}.zip\""))],
        zipped,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    models: Option<String>,
}
