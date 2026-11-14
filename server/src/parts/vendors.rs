//! The vendors a part can come from, and how each is asked.
//!
//!   lcsc     — LCSC / JLCPCB.  No credentials.  Search goes through JLCPCB's parts
//!              search (a public index of it as the fallback); a part's data and its drawings (symbol,
//!              footprint, 3D model) come from EasyEDA, which shares LCSC's catalogue.
//!   mouser   — Mouser Search API v1.  Needs an API key.  Part data only.
//!   farnell  — Farnell / Newark / element14 Product Search API.  Needs an API key;
//!              the store (uk.farnell.com, www.newark.com, …) picks stock and currency.
//!   digikey  — DigiKey Product Information API v4.  Needs a client id and secret
//!              (OAuth2 client credentials).  Part data only.
//!
//! Mouser and DigiKey publish no drawings, so a part from either borrows the
//! drawings of the LCSC listing with the same manufacturer part number, when
//! there is one (`find_lcsc_by_mpn`).
//!
//! Every base URL can be overridden from the environment, which is how the tests
//! run against a local stand-in (scripts/fake-vendors.mjs).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const VENDORS: [&str; 4] = ["lcsc", "mouser", "digikey", "farnell"];

pub struct VendorCfg {
    pub easyeda_url: String,
    pub easyeda_models_url: String,
    pub jlcsearch_url: String,
    pub jlcpcb_url: String,
    pub mouser_url: String,
    pub mouser_key: Option<String>,
    pub digikey_url: String,
    pub farnell_url: String,
    pub farnell_key: Option<String>,
    pub farnell_store: String,
    pub digikey_client_id: Option<String>,
    pub digikey_client_secret: Option<String>,
}

fn env_url(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| default.into()).trim_end_matches('/').to_string()
}
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn cfg() -> &'static VendorCfg {
    static CFG: OnceLock<VendorCfg> = OnceLock::new();
    CFG.get_or_init(|| VendorCfg {
        easyeda_url: env_url("EASYEDA_API_URL", "https://easyeda.com"),
        easyeda_models_url: env_url("EASYEDA_MODELS_URL", "https://modules.easyeda.com"),
        jlcsearch_url: env_url("JLCSEARCH_URL", "https://jlcsearch.tscircuit.com"),
        jlcpcb_url: env_url("JLCPCB_API_URL", "https://jlcpcb.com"),
        mouser_url: env_url("MOUSER_API_URL", "https://api.mouser.com"),
        mouser_key: env_opt("MOUSER_API_KEY"),
        farnell_url: env_url("FARNELL_API_URL", "https://api.element14.com"),
        farnell_key: env_opt("FARNELL_API_KEY"),
        farnell_store: env_opt("FARNELL_STORE").unwrap_or_else(|| FARNELL_DEFAULT_STORE.to_string()),
        digikey_url: env_url("DIGIKEY_API_URL", "https://api.digikey.com"),
        digikey_client_id: env_opt("DIGIKEY_CLIENT_ID"),
        digikey_client_secret: env_opt("DIGIKEY_CLIENT_SECRET"),
    })
}

fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; kicad-collab-parts/1.0)")
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(8))
            .build()
            .expect("http client")
    })
}

/// The credentials a request may use: the user's own first, then the server's.
#[derive(Debug, Clone, Default)]
pub struct Keys {
    pub mouser: Option<String>,
    pub digikey: Option<(String, String)>,
    /// API key and store host.
    pub farnell: Option<(String, String)>,
}

impl Keys {
    pub fn with_server_defaults(mut self) -> Self {
        let c = cfg();
        if self.mouser.is_none() {
            self.mouser = c.mouser_key.clone();
        }
        if self.farnell.is_none() {
            if let Some(k) = &c.farnell_key {
                self.farnell = Some((k.clone(), c.farnell_store.clone()));
            }
        }
        if self.digikey.is_none() {
            if let (Some(id), Some(secret)) = (&c.digikey_client_id, &c.digikey_client_secret) {
                self.digikey = Some((id.clone(), secret.clone()));
            }
        }
        self
    }
    pub fn has(&self, vendor: &str) -> bool {
        match vendor {
            "lcsc" => true,
            "mouser" => self.mouser.is_some(),
            "digikey" => self.digikey.is_some(),
            "farnell" => self.farnell.is_some(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrKind {
    /// The vendor could not be reached, or answered with a server error.
    Unreachable,
    NotFound,
    /// No credentials for a vendor that needs them.
    NotConfigured,
    /// The vendor refused the credentials.
    Rejected,
    Other,
}

#[derive(Debug, Clone)]
pub struct VendorErr {
    pub kind: ErrKind,
    pub message: String,
}

impl VendorErr {
    fn new(kind: ErrKind, message: impl Into<String>) -> Self {
        VendorErr { kind, message: message.into() }
    }
    fn net(what: &str, e: reqwest::Error) -> Self {
        let why = if e.is_timeout() { "timed out" } else if e.is_connect() { "could not be reached" } else { "did not answer properly" };
        VendorErr::new(ErrKind::Unreachable, format!("{what} {why}."))
    }
}

type VResult<T> = Result<T, VendorErr>;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PriceBreak {
    pub qty: i64,
    pub price: f64,
    pub currency: String,
}

/// What a vendor says about a part.  Stored as `parts.info`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PartInfo {
    pub vendor: String,
    pub vendor_id: String,
    pub mpn: String,
    pub manufacturer: String,
    pub description: String,
    pub package: String,
    pub category: String,
    pub datasheet: String,
    pub image: String,
    pub url: String,
    pub stock: Option<i64>,
    pub prices: Vec<PriceBreak>,
    pub attributes: BTreeMap<String, String>,
    /// JLCPCB's assembly class for an LCSC part: "basic", "preferred" or "extended".
    pub assembly: String,
    pub lifecycle: String,
}

pub fn vendor_label(vendor: &str) -> &'static str {
    match vendor {
        "lcsc" => "LCSC",
        "mouser" => "Mouser",
        "digikey" => "DigiKey",
        "farnell" => "Farnell",
        _ => "Vendor",
    }
}

pub fn is_lcsc_id(s: &str) -> bool {
    let s = s.trim();
    s.len() >= 2 && (s.starts_with('C') || s.starts_with('c')) && s[1..].chars().all(|c| c.is_ascii_digit())
}

/// Letters and digits only, upper-cased: how two spellings of a part number are compared.
pub fn norm_mpn(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn s(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(x)) => x.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn int(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(x)) => {
            let digits: String = x.chars().take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.' || *c == ' ').filter(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        }
        _ => None,
    }
}

/// "$1.23", "1,23 €", 1.23 → 1.23
fn money(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(x)) => {
            let t: String = x.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
            let t = if t.contains('.') { t.replace(',', "") } else { t.replace(',', ".") };
            t.parse().ok()
        }
        _ => None,
    }
}

async fn read_json(what: &str, resp: Result<reqwest::Response, reqwest::Error>) -> VResult<(u16, Value)> {
    let resp = resp.map_err(|e| VendorErr::net(what, e))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| VendorErr::net(what, e))?;
    if status >= 500 {
        return Err(VendorErr::new(ErrKind::Unreachable, format!("{what} is having trouble (it answered {status}).")));
    }
    let v = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    Ok((status, v))
}

// ------------------------------------------------------------------ LCSC / EasyEDA

fn lcsc_urls(id: &str) -> String {
    format!("https://www.lcsc.com/product-detail/{id}.html")
}

/// `1-9:1.4415,10-29:1.2527,…,1000-:0.98` (the index's tier string) or a bare number.
fn lcsc_prices(v: Option<&Value>) -> Vec<PriceBreak> {
    match v {
        Some(Value::Number(n)) => n.as_f64().map(|p| vec![PriceBreak { qty: 1, price: p, currency: "USD".into() }]).unwrap_or_default(),
        Some(Value::String(t)) => t
            .split(',')
            .filter_map(|tier| {
                let (range, price) = tier.split_once(':')?;
                let qty = range.split('-').next()?.trim().parse::<i64>().ok()?;
                Some(PriceBreak { qty, price: price.trim().parse().ok()?, currency: "USD".into() })
            })
            .collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|t| {
                let qty = int(t.get("qFrom").or(t.get("qty")).or(t.get("startNumber")))?;
                let price = money(t.get("price").or(t.get("productPrice")))?;
                Some(PriceBreak { qty, price, currency: "USD".into() })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn lcsc_from_index(c: &Value) -> Option<PartInfo> {
    let num = int(c.get("lcsc"))?;
    let id = format!("C{num}");
    let assembly = if c.get("is_basic").and_then(Value::as_bool).unwrap_or(false) {
        "basic"
    } else if c.get("is_preferred").and_then(Value::as_bool).unwrap_or(false) {
        "preferred"
    } else {
        "extended"
    };
    let mut attributes = BTreeMap::new();
    if let Some(Value::Object(extra)) = c.get("extra").or(c.get("attributes")) {
        for (k, v) in extra {
            if let Some(t) = v.as_str().filter(|t| !t.is_empty() && t.len() < 120) {
                attributes.insert(k.clone(), t.to_string());
            }
        }
    }
    Some(PartInfo {
        vendor: "lcsc".into(),
        url: lcsc_urls(&id),
        vendor_id: id,
        mpn: s(c, "mfr"),
        manufacturer: s(c, "manufacturer"),
        description: s(c, "description"),
        package: s(c, "package"),
        category: [s(c, "category"), s(c, "subcategory")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" / "),
        datasheet: s(c, "datasheet"),
        stock: int(c.get("stock")),
        prices: lcsc_prices(c.get("price")),
        attributes,
        assembly: assembly.into(),
        ..Default::default()
    })
}

fn lcsc_from_jlcpcb(c: &Value) -> Option<PartInfo> {
    let id = s(c, "componentCode").to_ascii_uppercase();
    if !is_lcsc_id(&id) {
        return None;
    }
    let assembly = if s(c, "componentLibraryType") == "base" {
        "basic"
    } else if c.get("preferredComponentFlag").and_then(Value::as_bool).unwrap_or(false) {
        "preferred"
    } else {
        "extended"
    };
    let mut attributes = BTreeMap::new();
    if let Some(a) = c.get("attributes").and_then(Value::as_array) {
        for at in a {
            let (k, v) = (s(at, "attribute_name_en"), s(at, "attribute_value_name"));
            if !k.is_empty() && !v.is_empty() && v != "-" {
                attributes.insert(k, v);
            }
        }
    }
    let prices = c
        .get("componentPrices")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|b| Some(PriceBreak { qty: int(b.get("startNumber"))?, price: money(b.get("productPrice"))?, currency: "USD".into() }))
                .collect()
        })
        .unwrap_or_default();
    let mut url = s(c, "lcscGoodsUrl");
    if !url.starts_with("http") {
        url = lcsc_urls(&id);
    }
    Some(PartInfo {
        vendor: "lcsc".into(),
        vendor_id: id,
        mpn: s(c, "componentModelEn"),
        manufacturer: super::easyeda::clean_maker(&s(c, "componentBrandEn")),
        description: s(c, "describe"),
        package: s(c, "componentSpecificationEn"),
        category: [s(c, "secondSortName"), s(c, "firstSortName")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" / "),
        datasheet: s(c, "dataManualUrl"),
        image: s(c, "minImageAccessIdUrl"),
        url,
        stock: int(c.get("stockCount")),
        prices,
        attributes,
        assembly: assembly.into(),
        ..Default::default()
    })
}

/// JLCPCB's own parts search (the LCSC catalogue with stock, prices and attributes).
async fn jlcpcb_search(q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    let base = &cfg().jlcpcb_url;
    let url = format!("{base}/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList");
    let body = json!({ "keyword": q, "currentPage": 1, "pageSize": limit.clamp(1, 100), "searchSource": "search", "componentAttributes": [] });
    let req = http().post(&url).header("Origin", base.as_str()).header("Referer", format!("{base}/parts")).json(&body);
    let (status, v) = read_json("JLCPCB's parts search", req.send().await).await?;
    let list = v.get("data").and_then(|d| d.get("componentPageInfo")).and_then(|p| p.get("list")).and_then(Value::as_array);
    match list {
        Some(a) if status < 400 => Ok(a.iter().filter_map(lcsc_from_jlcpcb).collect()),
        // "data": null with code 200 is how it says "nothing found"
        None if status < 400 && int(v.get("code")) == Some(200) => Ok(Vec::new()),
        _ => Err(VendorErr::new(ErrKind::Unreachable, format!("JLCPCB's parts search answered {status}."))),
    }
}

/// Search the LCSC catalogue: JLCPCB's search first, the public index as the fallback.
async fn lcsc_search(q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    match jlcpcb_search(q, limit).await {
        Ok(hits) => Ok(hits),
        Err(first) => match lcsc_index(q, limit).await {
            Ok(hits) => Ok(hits),
            Err(_) => Err(first),
        },
    }
}

async fn lcsc_index(q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    let url = format!("{}/api/search", cfg().jlcsearch_url);
    let lim = limit.to_string();
    let (status, v) = read_json("The LCSC parts index", http().get(&url).query(&[("q", q), ("limit", lim.as_str()), ("full", "true")]).send().await).await?;
    if status >= 400 {
        return Err(VendorErr::new(ErrKind::Other, format!("The LCSC parts index answered {status}.")));
    }
    Ok(v.get("components").and_then(Value::as_array).map(|a| a.iter().filter_map(lcsc_from_index).collect()).unwrap_or_default())
}

/// EasyEDA's answer for one LCSC part: the `result` object, drawings included.
pub async fn easyeda_component(lcsc_id: &str) -> VResult<Value> {
    let id = lcsc_id.trim().to_ascii_uppercase();
    if !is_lcsc_id(&id) {
        return Err(VendorErr::new(ErrKind::NotFound, "An LCSC part number looks like C8734."));
    }
    let url = format!("{}/api/products/{id}/components", cfg().easyeda_url);
    let (status, v) = read_json("EasyEDA (LCSC's drawing library)", http().get(&url).query(&[("version", "6.4.19.5")]).send().await).await?;
    let result = v.get("result").cloned().unwrap_or(Value::Null);
    if status == 404 || !result.is_object() || result.get("dataStr").is_none() {
        return Err(VendorErr::new(ErrKind::NotFound, format!("LCSC has no part {id}, or no drawings for it.")));
    }
    Ok(result)
}

/// Part data out of EasyEDA's answer (it names the part, its maker, package, stock and price).
pub fn lcsc_info_from_easyeda(id: &str, result: &Value, conv: Option<&super::easyeda::Converted>) -> PartInfo {
    let lcsc = result.get("lcsc").cloned().unwrap_or(Value::Null);
    let cpara = result.get("dataStr").and_then(|d| d.get("head")).and_then(|h| h.get("c_para")).cloned().unwrap_or(Value::Null);
    let mut url = s(&lcsc, "url");
    if url.is_empty() {
        url = lcsc_urls(id);
    } else if url.starts_with("//") {
        url = format!("https:{url}");
    }
    let class = super::easyeda::cpara_any(&cpara, &["JLCPCB Part Class", "BOM_JLCPCB Part Class"]).to_ascii_lowercase();
    let assembly = match class.as_str() {
        x if x.contains("basic") => "basic",
        x if x.contains("prefer") => "preferred",
        x if x.contains("extend") => "extended",
        _ => "",
    };
    let mut mpn = super::easyeda::cpara_any(&cpara, &["Manufacturer Part", "BOM_Manufacturer Part"]).trim().to_string();
    if mpn.is_empty() {
        mpn = if s(&cpara, "name").is_empty() { s(result, "title") } else { s(&cpara, "name") };
    }
    PartInfo {
        vendor: "lcsc".into(),
        vendor_id: id.to_string(),
        mpn,
        manufacturer: super::easyeda::clean_maker(super::easyeda::cpara_any(&cpara, &["Manufacturer", "BOM_Manufacturer"])),
        description: s(result, "description"),
        package: s(&cpara, "package"),
        // no datasheet link in the drawing: the product page, which links LCSC's copy of it
        datasheet: conv.map(|c| c.datasheet.clone()).filter(|d| !d.is_empty()).unwrap_or_else(|| url.clone()),
        url,
        stock: int(lcsc.get("stock")),
        prices: lcsc_prices(lcsc.get("price")),
        assembly: assembly.into(),
        ..Default::default()
    }
}

/// The LCSC listing with exactly this manufacturer part number, if the index has one.
pub async fn find_lcsc_by_mpn(mpn: &str) -> VResult<Option<PartInfo>> {
    let want = norm_mpn(mpn);
    if want.len() < 3 {
        return Ok(None);
    }
    let hits = lcsc_search(mpn, 25).await?;
    Ok(hits.into_iter().filter(|h| norm_mpn(&h.mpn) == want).max_by_key(|h| h.stock.unwrap_or(0)))
}

/// A 3D model (STEP) by EasyEDA's model id.
pub async fn easyeda_step(uuid: &str) -> VResult<Vec<u8>> {
    if uuid.is_empty() || !uuid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(VendorErr::new(ErrKind::NotFound, "No 3D model."));
    }
    let url = format!("{}/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}", cfg().easyeda_models_url);
    let resp = http().get(&url).send().await.map_err(|e| VendorErr::net("EasyEDA's 3D model store", e))?;
    if !resp.status().is_success() {
        return Err(VendorErr::new(
            if resp.status().is_server_error() { ErrKind::Unreachable } else { ErrKind::NotFound },
            "EasyEDA has no 3D model for this part.",
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| VendorErr::net("EasyEDA's 3D model store", e))?;
    if bytes.len() < 64 || bytes.len() > 40 * 1024 * 1024 || !bytes.starts_with(b"ISO-10303") {
        return Err(VendorErr::new(ErrKind::NotFound, "EasyEDA has no 3D model for this part."));
    }
    Ok(bytes.to_vec())
}

// ------------------------------------------------------------------ Mouser

fn mouser_part(p: &Value) -> Option<PartInfo> {
    let id = s(p, "MouserPartNumber");
    if id.is_empty() || id.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let mut attributes = BTreeMap::new();
    if let Some(a) = p.get("ProductAttributes").and_then(Value::as_array) {
        for at in a {
            let (k, v) = (s(at, "AttributeName"), s(at, "AttributeValue"));
            if !k.is_empty() && !v.is_empty() {
                attributes.insert(k, v);
            }
        }
    }
    let package = attributes.get("Package / Case").or(attributes.get("Packaging")).cloned().unwrap_or_default();
    let prices = p
        .get("PriceBreaks")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|b| Some(PriceBreak { qty: int(b.get("Quantity"))?, price: money(b.get("Price"))?, currency: s(b, "Currency") }))
                .collect()
        })
        .unwrap_or_default();
    Some(PartInfo {
        vendor: "mouser".into(),
        vendor_id: id,
        mpn: s(p, "ManufacturerPartNumber"),
        manufacturer: s(p, "Manufacturer"),
        description: s(p, "Description"),
        package,
        category: s(p, "Category"),
        datasheet: s(p, "DataSheetUrl"),
        image: s(p, "ImagePath"),
        url: s(p, "ProductDetailUrl"),
        stock: int(p.get("AvailabilityInStock")).or_else(|| int(p.get("Availability"))),
        prices,
        attributes,
        lifecycle: s(p, "LifecycleStatus"),
        ..Default::default()
    })
}

async fn mouser_call(key: &str, path: &str, body: Value) -> VResult<Vec<PartInfo>> {
    let url = format!("{}/api/v1/search/{path}", cfg().mouser_url);
    let (status, v) = read_json("Mouser", http().post(&url).query(&[("apiKey", key)]).json(&body).send().await).await?;
    let errors: Vec<String> = v
        .get("Errors")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|e| s(e, "Message")).filter(|m| !m.is_empty()).collect())
        .unwrap_or_default();
    if status == 401 || status == 403 || errors.iter().any(|m| m.to_ascii_lowercase().contains("api key") || m.to_ascii_lowercase().contains("invalid unique identifier")) {
        return Err(VendorErr::new(ErrKind::Rejected, "Mouser did not accept the API key."));
    }
    if status == 429 || errors.iter().any(|m| m.to_ascii_lowercase().contains("maximum calls")) {
        return Err(VendorErr::new(ErrKind::Unreachable, "Mouser's request limit for this API key is used up for now."));
    }
    if status >= 400 || !errors.is_empty() {
        return Err(VendorErr::new(ErrKind::Other, format!("Mouser answered: {}", if errors.is_empty() { status.to_string() } else { errors.join("; ") })));
    }
    Ok(v.get("SearchResults")
        .and_then(|r| r.get("Parts"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(mouser_part).collect())
        .unwrap_or_default())
}

async fn mouser_search(key: &str, q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    mouser_call(key, "keyword", json!({ "SearchByKeywordRequest": { "keyword": q, "records": limit.min(50), "startingRecord": 0, "searchOptions": "", "searchWithYourSignUpLanguage": "" } })).await
}

async fn mouser_get(key: &str, id: &str) -> VResult<PartInfo> {
    let hits = mouser_call(key, "partnumber", json!({ "SearchByPartRequest": { "mouserPartNumber": id, "partSearchOptions": "Exact" } })).await?;
    let want = norm_mpn(id);
    hits.into_iter()
        .find(|p| norm_mpn(&p.vendor_id) == want)
        .ok_or_else(|| VendorErr::new(ErrKind::NotFound, format!("Mouser has no part {id}.")))
}

// ------------------------------------------------------------------ DigiKey

fn digikey_tokens() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static T: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn digikey_token(id: &str, secret: &str) -> VResult<String> {
    // keyed by both halves: a cached token must not vouch for a different secret
    let cache_key = format!("{id}\n{secret}");
    if let Some((tok, until)) = digikey_tokens().lock().unwrap().get(&cache_key).cloned() {
        if until > Instant::now() {
            return Ok(tok);
        }
    }
    let url = format!("{}/v1/oauth2/token", cfg().digikey_url);
    let form = [("client_id", id), ("client_secret", secret), ("grant_type", "client_credentials")];
    let (status, v) = read_json("DigiKey", http().post(&url).form(&form).send().await).await?;
    let tok = s(&v, "access_token");
    if status >= 400 || tok.is_empty() {
        return Err(VendorErr::new(ErrKind::Rejected, "DigiKey did not accept the client id and secret."));
    }
    let ttl = int(v.get("expires_in")).unwrap_or(600).max(60) as u64;
    digikey_tokens().lock().unwrap().insert(cache_key, (tok.clone(), Instant::now() + Duration::from_secs(ttl - 30)));
    Ok(tok)
}

fn digikey_part(p: &Value) -> Option<PartInfo> {
    let variations = p.get("ProductVariations").and_then(Value::as_array).cloned().unwrap_or_default();
    // Prefer the variation people buy in ones (cut tape) over a full reel.
    let pick = variations
        .iter()
        .min_by_key(|v| int(v.get("MinimumOrderQuantity")).unwrap_or(i64::MAX))
        .cloned()
        .unwrap_or(Value::Null);
    let mut id = s(&pick, "DigiKeyProductNumber");
    if id.is_empty() {
        id = s(p, "DigiKeyPartNumber");
    }
    let mpn = if s(p, "ManufacturerProductNumber").is_empty() { s(p, "ManufacturerPartNumber") } else { s(p, "ManufacturerProductNumber") };
    if id.is_empty() {
        id = mpn.clone();
    }
    if id.is_empty() {
        return None;
    }
    let mut attributes = BTreeMap::new();
    if let Some(a) = p.get("Parameters").and_then(Value::as_array) {
        for at in a {
            let k = if s(at, "ParameterText").is_empty() { s(at, "Parameter") } else { s(at, "ParameterText") };
            let v = if s(at, "ValueText").is_empty() { s(at, "Value") } else { s(at, "ValueText") };
            if !k.is_empty() && !v.is_empty() && v != "-" {
                attributes.insert(k, v);
            }
        }
    }
    let package = attributes.get("Package / Case").or(attributes.get("Supplier Device Package")).cloned().unwrap_or_default();
    let desc = p.get("Description").cloned().unwrap_or(Value::Null);
    let description = match &desc {
        Value::String(t) => t.clone(),
        d => {
            let long = s(d, "DetailedDescription");
            if long.is_empty() {
                s(d, "ProductDescription")
            } else {
                long
            }
        }
    };
    let mut prices: Vec<PriceBreak> = pick
        .get("StandardPricing")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|b| Some(PriceBreak { qty: int(b.get("BreakQuantity"))?, price: money(b.get("UnitPrice"))?, currency: "USD".into() }))
                .collect()
        })
        .unwrap_or_default();
    if prices.is_empty() {
        if let Some(u) = money(p.get("UnitPrice")) {
            prices.push(PriceBreak { qty: 1, price: u, currency: "USD".into() });
        }
    }
    let nested = |key: &str, inner: &str| p.get(key).map(|m| s(m, inner)).unwrap_or_default();
    Some(PartInfo {
        vendor: "digikey".into(),
        vendor_id: id,
        mpn,
        manufacturer: nested("Manufacturer", "Name"),
        description,
        package,
        category: nested("Category", "Name"),
        datasheet: {
            let d = s(p, "DatasheetUrl");
            if d.starts_with("//") {
                format!("https:{d}")
            } else {
                d
            }
        },
        image: s(p, "PhotoUrl"),
        url: s(p, "ProductUrl"),
        stock: int(p.get("QuantityAvailable")),
        prices,
        attributes,
        lifecycle: nested("ProductStatus", "Status"),
        ..Default::default()
    })
}

fn digikey_req(req: reqwest::RequestBuilder, id: &str, token: &str) -> reqwest::RequestBuilder {
    req.bearer_auth(token)
        .header("X-DIGIKEY-Client-Id", id)
        .header("X-DIGIKEY-Locale-Site", "US")
        .header("X-DIGIKEY-Locale-Language", "en")
        .header("X-DIGIKEY-Locale-Currency", "USD")
}

fn digikey_status(status: u16, v: &Value) -> VResult<()> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(VendorErr::new(ErrKind::Rejected, "DigiKey refused the request. Check that the app has the Product Information v4 API enabled.")),
        404 => Err(VendorErr::new(ErrKind::NotFound, "DigiKey has no such part.")),
        429 => Err(VendorErr::new(ErrKind::Unreachable, "DigiKey's request limit for this app is used up for now.")),
        _ => {
            let detail = [s(v, "detail"), s(v, "ErrorMessage"), s(v, "title")].into_iter().find(|m| !m.is_empty()).unwrap_or_else(|| status.to_string());
            Err(VendorErr::new(ErrKind::Other, format!("DigiKey answered: {detail}")))
        }
    }
}

async fn digikey_search(creds: &(String, String), q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    let token = digikey_token(&creds.0, &creds.1).await?;
    let url = format!("{}/products/v4/search/keyword", cfg().digikey_url);
    let body = json!({ "Keywords": q, "Limit": limit.min(50), "Offset": 0 });
    let (status, v) = read_json("DigiKey", digikey_req(http().post(&url), &creds.0, &token).json(&body).send().await).await?;
    digikey_status(status, &v)?;
    let mut out: Vec<PartInfo> = Vec::new();
    for key in ["ExactMatches", "Products"] {
        if let Some(a) = v.get(key).and_then(Value::as_array) {
            for p in a.iter().filter_map(digikey_part) {
                if !out.iter().any(|o| o.vendor_id == p.vendor_id) {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

async fn digikey_get(creds: &(String, String), id: &str) -> VResult<PartInfo> {
    let token = digikey_token(&creds.0, &creds.1).await?;
    let base = reqwest::Url::parse(&format!("{}/products/v4/search/", cfg().digikey_url)).map_err(|_| VendorErr::new(ErrKind::Other, "bad DigiKey URL"))?;
    let mut url = base;
    url.path_segments_mut().map_err(|_| VendorErr::new(ErrKind::Other, "bad DigiKey URL"))?.pop_if_empty().push(id).push("productdetails");
    let (status, v) = read_json("DigiKey", digikey_req(http().get(url), &creds.0, &token).send().await).await?;
    digikey_status(status, &v)?;
    let mut part = v.get("Product").and_then(digikey_part).ok_or_else(|| VendorErr::new(ErrKind::NotFound, format!("DigiKey has no part {id}.")))?;
    // keep the number that was asked for, so the reference stays stable across refetches
    part.vendor_id = id.to_string();
    Ok(part)
}

// ------------------------------------------------------------------ Farnell / Newark / element14
//
// One API (api.element14.com) serves every storefront of the group; `storeInfo.id` is the
// store's host name and decides stock, prices and their currency.

pub const FARNELL_DEFAULT_STORE: &str = "uk.farnell.com";

/// A store host as the API wants it: bare, lower case.  Empty when it is not a host name.
pub fn farnell_store(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    let t = t.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    if t.is_empty() {
        return FARNELL_DEFAULT_STORE.to_string();
    }
    if t.len() > 64 || !t.contains('.') || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return String::new();
    }
    t.to_string()
}

fn farnell_currency(store: &str) -> &'static str {
    match store {
        "uk.farnell.com" | "onecall.farnell.com" => "GBP",
        "www.newark.com" | "mexico.newark.com" => "USD",
        "sg.element14.com" => "SGD",
        "canada.newark.com" => "CAD",
        "au.element14.com" => "AUD",
        "nz.element14.com" => "NZD",
        "in.element14.com" => "INR",
        "cn.element14.com" => "CNY",
        "hk.element14.com" => "HKD",
        "my.element14.com" => "MYR",
        "ch.farnell.com" => "CHF",
        "se.farnell.com" => "SEK",
        "dk.farnell.com" => "DKK",
        "no.farnell.com" => "NOK",
        "pl.farnell.com" => "PLN",
        "cz.farnell.com" => "CZK",
        "hu.farnell.com" => "HUF",
        _ if store.ends_with(".farnell.com") => "EUR",
        _ => "",
    }
}

fn farnell_part(p: &Value, store: &str) -> Option<PartInfo> {
    let id = s(p, "sku");
    if id.is_empty() {
        return None;
    }
    let mut attributes = BTreeMap::new();
    if let Some(a) = p.get("attributes").and_then(Value::as_array) {
        for at in a {
            let (k, v, u) = (s(at, "attributeLabel"), s(at, "attributeValue"), s(at, "attributeUnit"));
            if !k.is_empty() && !v.is_empty() {
                attributes.insert(k.trim().to_string(), if u.is_empty() { v } else { format!("{v} {u}") });
            }
        }
    }
    let package = ["IC Case / Package", "Case / Package", "Resistor Case / Package", "Capacitor Case / Package", "Transistor Case Style", "Diode Case Style"]
        .iter()
        .find_map(|k| attributes.iter().find(|(name, _)| name.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()))
        .unwrap_or_default();
    let currency = farnell_currency(store);
    let prices = p
        .get("prices")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|b| Some(PriceBreak { qty: int(b.get("from"))?, price: money(b.get("cost"))?, currency: currency.to_string() })).collect())
        .unwrap_or_default();
    let datasheet = p
        .get("datasheets")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().map(|d| s(d, "url")).find(|u| !u.is_empty()))
        .unwrap_or_default();
    let image = p
        .get("image")
        .map(|i| (s(i, "vrntPath"), s(i, "baseName")))
        .filter(|(_, b)| !b.is_empty())
        .map(|(v, b)| format!("https://{store}/productimages/standard/{}{}", if v.is_empty() { "en_GB/".to_string() } else { v }, b.trim_start_matches('/')))
        .unwrap_or_default();
    let brand = s(p, "brandName");
    Some(PartInfo {
        vendor: "farnell".into(),
        vendor_id: id.clone(),
        mpn: s(p, "translatedManufacturerPartNumber"),
        manufacturer: if brand.is_empty() { s(p, "vendorName") } else { brand },
        description: s(p, "displayName"),
        package,
        datasheet,
        image,
        url: format!("https://{store}/search?st={id}"),
        stock: p.get("stock").and_then(|st| int(st.get("level"))).or_else(|| int(p.get("inv"))),
        prices,
        attributes,
        lifecycle: s(p, "productStatus"),
        ..Default::default()
    })
}

/// `term` is the API's own query form: `any:<keywords>`, `id:<order code>`, `manuPartNum:<mpn>`.
async fn farnell_call(key: &(String, String), term: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    let (api_key, store) = key;
    let store = farnell_store(store);
    if store.is_empty() {
        return Err(VendorErr::new(ErrKind::Rejected, "The Farnell store must be a host name such as uk.farnell.com or www.newark.com."));
    }
    let url = format!("{}/catalog/products", cfg().farnell_url);
    let n = limit.clamp(1, 50).to_string();
    let query = [
        ("term", term),
        ("storeInfo.id", store.as_str()),
        ("resultsSettings.offset", "0"),
        ("resultsSettings.numberOfResults", n.as_str()),
        ("resultsSettings.responseGroup", "large"),
        ("callInfo.responseDataFormat", "JSON"),
        ("callInfo.apiKey", api_key.as_str()),
    ];
    let (status, v) = read_json("Farnell", http().get(&url).query(&query).send().await).await?;
    if status == 401 || status == 403 {
        return Err(VendorErr::new(ErrKind::Rejected, "Farnell did not accept the API key."));
    }
    if status == 429 {
        return Err(VendorErr::new(ErrKind::Unreachable, "Farnell's request limit for this API key is used up for now."));
    }
    if let Some(f) = v.get("Fault") {
        let msg = f.get("Detail").and_then(|d| d.get("searchException")).map(|e| s(e, "exceptionString")).filter(|m| !m.is_empty()).unwrap_or_else(|| s(f, "Reason"));
        return Err(VendorErr::new(ErrKind::Other, format!("Farnell answered: {}", if msg.is_empty() { status.to_string() } else { msg })));
    }
    if status >= 400 {
        return Err(VendorErr::new(ErrKind::Other, format!("Farnell answered: {status}")));
    }
    // the wrapper is named after the kind of search: keywordSearchReturn, premierFarnellPartNumberReturn, …
    Ok(v.as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(|r| r.get("products").and_then(Value::as_array))
        .flat_map(|a| a.iter().filter_map(|p| farnell_part(p, &store)))
        .collect())
}

async fn farnell_search(key: &(String, String), q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    farnell_call(key, &format!("any:{q}"), limit).await
}

async fn farnell_get(key: &(String, String), id: &str) -> VResult<PartInfo> {
    let hits = farnell_call(key, &format!("id:{id}"), 1).await?;
    hits.into_iter().find(|p| p.vendor_id.eq_ignore_ascii_case(id)).ok_or_else(|| VendorErr::new(ErrKind::NotFound, format!("Farnell has no part {id}.")))
}

// ------------------------------------------------------------------ dispatch

fn not_configured(vendor: &str) -> VendorErr {
    VendorErr::new(
        ErrKind::NotConfigured,
        match vendor {
            "mouser" => "Mouser needs an API key. Add yours under API keys.",
            "digikey" => "DigiKey needs a client id and secret. Add yours under API keys.",
            "farnell" => "Farnell needs an API key. Add yours under API keys.",
            _ => "This vendor is not set up.",
        },
    )
}

pub async fn search(vendor: &str, keys: &Keys, q: &str, limit: usize) -> VResult<Vec<PartInfo>> {
    match vendor {
        "lcsc" => lcsc_search(q, limit).await,
        "mouser" => mouser_search(keys.mouser.as_deref().ok_or_else(|| not_configured(vendor))?, q, limit).await,
        "digikey" => digikey_search(keys.digikey.as_ref().ok_or_else(|| not_configured(vendor))?, q, limit).await,
        "farnell" => farnell_search(keys.farnell.as_ref().ok_or_else(|| not_configured(vendor))?, q, limit).await,
        _ => Err(VendorErr::new(ErrKind::NotFound, "Unknown vendor.")),
    }
}

/// Part data from a vendor that has no drawings (Mouser, DigiKey).
pub async fn fetch_info(vendor: &str, keys: &Keys, id: &str) -> VResult<PartInfo> {
    match vendor {
        "mouser" => mouser_get(keys.mouser.as_deref().ok_or_else(|| not_configured(vendor))?, id).await,
        "digikey" => digikey_get(keys.digikey.as_ref().ok_or_else(|| not_configured(vendor))?, id).await,
        "farnell" => farnell_get(keys.farnell.as_ref().ok_or_else(|| not_configured(vendor))?, id).await,
        _ => Err(VendorErr::new(ErrKind::NotFound, "Unknown vendor.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prices_and_numbers() {
        assert_eq!(money(Some(&json!("$1,234.50"))), Some(1234.5));
        assert_eq!(money(Some(&json!("0,123 €"))), Some(0.123));
        assert_eq!(int(Some(&json!("6,609 In Stock"))), Some(6609));
        let tiers = lcsc_prices(Some(&json!("1-9:1.4415,10-29:1.2527,1000-:0.98")));
        assert_eq!(tiers.len(), 3);
        assert_eq!(tiers[2], PriceBreak { qty: 1000, price: 0.98, currency: "USD".into() });
        assert!(is_lcsc_id("C8734") && !is_lcsc_id("CAP") && !is_lcsc_id("C"));
        assert_eq!(norm_mpn("stm32f103c8t6-tr"), "STM32F103C8T6TR");
    }

    // ---- against the real vendors.  Not run by default: they need the network and, apart
    // from LCSC, API keys in the environment.
    //   MOUSER_API_KEY=… DIGIKEY_CLIENT_ID=… DIGIKEY_CLIENT_SECRET=… FARNELL_API_KEY=… \
    //     cargo test -- --ignored --nocapture live_
    // A vendor whose key is not set is reported as skipped, not failed.

    fn live_check(vendor: &str, hits: &[PartInfo]) {
        let hit = hits.iter().find(|p| norm_mpn(&p.mpn).starts_with("STM32F103C8T6")).unwrap_or_else(|| panic!("{vendor}: no STM32F103C8T6 among {} results", hits.len()));
        println!("{vendor}: {} {} by {} · stock {:?} · {} price breaks · {}", hit.vendor_id, hit.mpn, hit.manufacturer, hit.stock, hit.prices.len(), hit.url);
        assert!(!hit.vendor_id.is_empty() && !hit.manufacturer.is_empty(), "{vendor}: the part number or manufacturer did not parse");
        assert!(!hit.prices.is_empty() && hit.prices[0].price > 0.0, "{vendor}: prices did not parse");
        assert!(hit.stock.is_some(), "{vendor}: stock did not parse");
    }

    #[tokio::test]
    #[ignore]
    async fn live_lcsc() {
        let hits = search("lcsc", &Keys::default(), "STM32F103C8T6", 10).await.expect("LCSC search");
        live_check("lcsc", &hits);
        let raw = easyeda_component("C8734").await.expect("EasyEDA component C8734");
        let c = super::super::easyeda::convert(&raw).expect("convert C8734");
        println!("lcsc: C8734 converts to {} with symbol {} and footprint {}", c.name, c.symbol.is_some(), c.footprint.is_some());
        assert!(c.symbol.is_some() && c.footprint.is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn live_mouser() {
        let keys = Keys::default().with_server_defaults();
        if keys.mouser.is_none() {
            println!("mouser: skipped, MOUSER_API_KEY is not set");
            return;
        }
        let hits = search("mouser", &keys, "STM32F103C8T6", 10).await.expect("Mouser search");
        live_check("mouser", &hits);
        let id = hits.iter().find(|p| norm_mpn(&p.mpn) == "STM32F103C8T6").map(|p| p.vendor_id.clone()).expect("an exact Mouser hit");
        let one = fetch_info("mouser", &keys, &id).await.expect("Mouser part by number");
        assert_eq!(one.vendor_id, id);
    }

    #[tokio::test]
    #[ignore]
    async fn live_digikey() {
        let keys = Keys::default().with_server_defaults();
        if keys.digikey.is_none() {
            println!("digikey: skipped, DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET are not set");
            return;
        }
        let hits = search("digikey", &keys, "STM32F103C8T6", 10).await.expect("DigiKey search");
        live_check("digikey", &hits);
        let id = hits.iter().find(|p| norm_mpn(&p.mpn).starts_with("STM32F103C8T6")).map(|p| p.vendor_id.clone()).unwrap();
        let one = fetch_info("digikey", &keys, &id).await.expect("DigiKey part by number");
        assert_eq!(one.vendor_id, id);
    }

    #[tokio::test]
    #[ignore]
    async fn live_farnell() {
        let keys = Keys::default().with_server_defaults();
        if keys.farnell.is_none() {
            println!("farnell: skipped, FARNELL_API_KEY is not set");
            return;
        }
        let hits = search("farnell", &keys, "STM32F103C8T6", 10).await.expect("Farnell search");
        live_check("farnell", &hits);
        let one = fetch_info("farnell", &keys, &hits[0].vendor_id).await.expect("Farnell part by order code");
        assert_eq!(one.vendor_id, hits[0].vendor_id);
    }

    #[test]
    fn reads_a_farnell_part() {
        let p = json!({
            "sku": "1447637", "displayName": "STMICROELECTRONICS - STM32F103C8T6 - ARM MCU, 32bit, 72MHz, LQFP-48", "productStatus": "STOCKED",
            "brandName": "STMICROELECTRONICS", "translatedManufacturerPartNumber": "STM32F103C8T6",
            "datasheets": [{ "type": "T", "url": "https://www.farnell.com/datasheets/1681173.pdf" }],
            "prices": [{ "from": 1, "to": 9, "cost": 4.12 }, { "from": 10, "to": 99, "cost": 3.21 }],
            "stock": { "level": 4521 },
            "attributes": [{ "attributeLabel": "IC Case / Package", "attributeValue": "LQFP" }, { "attributeLabel": "CPU Speed", "attributeUnit": "MHz", "attributeValue": "72" }]
        });
        let part = farnell_part(&p, "uk.farnell.com").unwrap();
        assert_eq!((part.vendor_id.as_str(), part.mpn.as_str(), part.stock), ("1447637", "STM32F103C8T6", Some(4521)));
        assert_eq!((part.prices.len(), part.prices[1].qty, part.prices[1].currency.as_str()), (2, 10, "GBP"));
        assert_eq!(part.package, "LQFP");
        assert_eq!(part.attributes.get("CPU Speed").map(String::as_str), Some("72 MHz"));
        assert_eq!(farnell_store(" https://WWW.Newark.com/ "), "www.newark.com");
        assert_eq!(farnell_store(""), "uk.farnell.com");
        assert_eq!(farnell_store("evil host/../x"), "");
    }

    #[test]
    fn reads_a_mouser_part() {
        let p = json!({
            "Availability": "6609 In Stock", "DataSheetUrl": "https://example.com/ds.pdf", "Description": "ARM MCU",
            "Manufacturer": "STMicroelectronics", "ManufacturerPartNumber": "STM32F103C8T6", "MouserPartNumber": "511-STM32F103C8T6",
            "PriceBreaks": [{ "Quantity": 1, "Price": "$5.61", "Currency": "USD" }, { "Quantity": 10, "Price": "$4.20", "Currency": "USD" }],
            "ProductAttributes": [{ "AttributeName": "Package / Case", "AttributeValue": "LQFP-48" }],
            "ProductDetailUrl": "https://www.mouser.com/ProductDetail/511-STM32F103C8T6"
        });
        let part = mouser_part(&p).unwrap();
        assert_eq!(part.vendor_id, "511-STM32F103C8T6");
        assert_eq!(part.stock, Some(6609));
        assert_eq!(part.package, "LQFP-48");
        assert_eq!(part.prices[1].price, 4.2);
    }

    #[test]
    fn reads_a_digikey_part() {
        let p = json!({
            "Description": { "ProductDescription": "IC MCU 32BIT 64KB FLASH 48LQFP", "DetailedDescription": "ARM Cortex-M3 STM32F1 Microcontroller IC" },
            "Manufacturer": { "Id": 497, "Name": "STMicroelectronics" }, "ManufacturerProductNumber": "STM32F103C8T6",
            "UnitPrice": 5.61, "ProductUrl": "https://www.digikey.com/en/products/detail/x/1646338", "DatasheetUrl": "//www.st.com/ds.pdf",
            "QuantityAvailable": 12000,
            "ProductVariations": [
                { "DigiKeyProductNumber": "497-6063-ND", "MinimumOrderQuantity": 1, "StandardPricing": [{ "BreakQuantity": 1, "UnitPrice": 5.61 }] },
                { "DigiKeyProductNumber": "497-6063-2-ND", "MinimumOrderQuantity": 1500, "StandardPricing": [{ "BreakQuantity": 1500, "UnitPrice": 3.1 }] }
            ],
            "Parameters": [{ "ParameterText": "Package / Case", "ValueText": "48-LQFP" }],
            "Category": { "Name": "Embedded - Microcontrollers" }, "ProductStatus": { "Status": "Active" }
        });
        let part = digikey_part(&p).unwrap();
        assert_eq!(part.vendor_id, "497-6063-ND");
        assert_eq!(part.manufacturer, "STMicroelectronics");
        assert_eq!(part.datasheet, "https://www.st.com/ds.pdf");
        assert_eq!(part.package, "48-LQFP");
        assert_eq!(part.lifecycle, "Active");
    }
}
