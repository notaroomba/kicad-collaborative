//! The design assistant (web/ai): a signed-in project member chats with Claude about the
//! open schematic or board.
//!
//! The split of work is deliberate.  The server never parses KiCad files, so the tools that
//! read the design and the ones that propose edits run in the browser, against the live
//! document the editor already holds.  What the server owns is everything that must not be
//! in a browser: the API key, the system prompt and the tool list (so the endpoint cannot
//! be used as a general-purpose proxy with a prompt of the caller's choosing), the
//! per-user daily allowance, and the usage record.  One request here is one model turn:
//! the browser sends the conversation so far, the reply streams back as the Messages API's
//! own server-sent events, the browser runs any design tools the model asked for and calls
//! again with their results.
//!
//! There is no official Anthropic SDK for Rust, so this talks to the Messages API directly.

use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::{persist, AppState};

const SYSTEM_PROMPT: &str = include_str!("../web/ai/system.md");
const DESIGN_TOOLS: &str = include_str!("../web/ai/tools.json");
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// A conversation is resent whole on every turn; past this it is a runaway, not a chat.
const MAX_BODY_BYTES: usize = 24 * 1024 * 1024;

struct AiConfig {
    /// The server's own key (`ANTHROPIC_API_KEY`).  Without it only people who stored a
    /// key of their own can use the assistant.
    server_key: Option<String>,
    api_url: String,
    model: String,
    effort: String,
    /// Requests per user per day on the server's key.  A person's own key is not limited.
    daily_requests: i64,
    web_tools: bool,
    fallbacks: bool,
}

fn config() -> &'static AiConfig {
    static CFG: OnceLock<AiConfig> = OnceLock::new();
    CFG.get_or_init(|| {
        let env = |k: &str| std::env::var(k).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let off = |k: &str| matches!(env(k).as_deref(), Some("0") | Some("off") | Some("false"));
        AiConfig {
            server_key: env("ANTHROPIC_API_KEY"),
            // Not ANTHROPIC_BASE_URL: that name is routinely set in development shells for
            // other tools, and silently sending a production server's traffic there would be
            // a nasty surprise.
            api_url: env("ANTHROPIC_API_URL")
                .unwrap_or_else(|| "https://api.anthropic.com".into())
                .trim_end_matches('/')
                .to_string(),
            model: env("AI_MODEL").unwrap_or_else(|| "claude-opus-5-5".into()),
            effort: env("AI_EFFORT").unwrap_or_else(|| "medium".into()),
            daily_requests: env("AI_DAILY_REQUESTS").and_then(|v| v.parse().ok()).unwrap_or(300),
            web_tools: !off("AI_WEB_TOOLS"),
            fallbacks: !off("AI_FALLBACKS"),
        }
    })
}

/// The tool list sent with every request: the design tools the browser runs, then the two
/// Anthropic-hosted web tools the datasheet work relies on.  It is identical for every
/// request on purpose — the tools are part of the cached prefix, and a conversation whose
/// tool list changes mid-way invalidates the thinking blocks already in its history.
fn tools() -> &'static Value {
    static TOOLS: OnceLock<Value> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let mut list: Vec<Value> = serde_json::from_str(DESIGN_TOOLS).expect("web/ai/tools.json is valid JSON");
        if config().web_tools {
            list.push(json!({ "type": "web_search_20260209", "name": "web_search", "max_uses": 8 }));
            list.push(json!({ "type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 8, "citations": { "enabled": true } }));
        }
        Value::Array(list)
    })
}

// ------------------------------------------------------------------ a person's own key

fn cipher(state: &AppState) -> Aes256Gcm {
    let key = Sha256::digest(format!("kc-ai-key:{}", state.cfg.jwt_secret).as_bytes());
    Aes256Gcm::new_from_slice(&key).expect("32-byte key")
}

async fn store_key(state: &AppState, user_id: i64, key: &str) -> AppResult<()> {
    let nonce: [u8; 12] = rand::random();
    let mut blob = nonce.to_vec();
    blob.extend(
        cipher(state)
            .encrypt(Nonce::from_slice(&nonce), key.as_bytes())
            .map_err(|_| anyhow::anyhow!("key encryption failed"))?,
    );
    let hint = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>();
    sqlx::query(
        "INSERT INTO ai_keys (user_id, key, hint) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET key = EXCLUDED.key, hint = EXCLUDED.hint, updated_at = now()",
    )
    .bind(user_id)
    .bind(blob)
    .bind(hint)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// The person's stored key and its last four characters, if there is one that still decrypts.
async fn load_key(state: &AppState, user_id: i64) -> AppResult<Option<(String, String)>> {
    let Some(row) = sqlx::query("SELECT key, hint FROM ai_keys WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
    else {
        return Ok(None);
    };
    let blob: Vec<u8> = row.get("key");
    if blob.len() < 13 {
        return Ok(None);
    }
    let (nonce, body) = blob.split_at(12);
    let Ok(plain) = cipher(state).decrypt(Nonce::from_slice(nonce), body) else {
        return Ok(None); // JWT_SECRET changed since it was stored: as good as gone
    };
    Ok(String::from_utf8(plain).ok().map(|k| (k, row.get("hint"))))
}

// ------------------------------------------------------------------ usage

async fn requests_today(state: &AppState, user_id: i64) -> AppResult<i64> {
    Ok(sqlx::query_scalar::<_, i32>("SELECT requests FROM ai_usage WHERE user_id = $1 AND day = CURRENT_DATE")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(0) as i64)
}

async fn note_request(state: &AppState, user_id: i64) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO ai_usage (user_id, day, requests) VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1",
    )
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn note_tokens(pool: &sqlx::PgPool, user_id: i64, input: i64, output: i64) {
    if input == 0 && output == 0 {
        return;
    }
    let r = sqlx::query(
        "UPDATE ai_usage SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3
         WHERE user_id = $1 AND day = CURRENT_DATE",
    )
    .bind(user_id)
    .bind(input)
    .bind(output)
    .execute(pool)
    .await;
    if let Err(e) = r {
        tracing::warn!("ai usage not recorded: {e}");
    }
}

/// Reads token counts out of the event stream as it passes through.  `message_start`
/// carries the input side (uncached, cache-written and cache-read tokens), and the last
/// `message_delta` the cumulative output.
#[derive(Default)]
struct UsageMeter {
    carry: String,
    input: i64,
    output: i64,
}

impl UsageMeter {
    fn feed(&mut self, chunk: &[u8]) {
        self.carry.push_str(&String::from_utf8_lossy(chunk));
        while let Some(nl) = self.carry.find('\n') {
            let line: String = self.carry.drain(..=nl).collect();
            let Some(data) = line.trim_end().strip_prefix("data:") else { continue };
            if !(data.contains("\"message_start\"") || data.contains("\"message_delta\"")) {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data.trim()) else { continue };
            let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
            match ev.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    let u = &ev["message"]["usage"];
                    self.input = n(u, "input_tokens") + n(u, "cache_creation_input_tokens") + n(u, "cache_read_input_tokens");
                }
                Some("message_delta") => self.output = self.output.max(n(&ev["usage"], "output_tokens")),
                _ => {}
            }
        }
        // A line can never legitimately grow without bound; do not let a broken upstream make us hold it.
        if self.carry.len() > 1 << 20 {
            self.carry.clear();
        }
    }
}

// ------------------------------------------------------------------ endpoints

/// `GET /api/ai` — whether the assistant can be used by this person, and on whose key.
pub async fn status(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    let cfg = config();
    let own = load_key(&state, user.id).await?;
    let used = requests_today(&state, user.id).await?;
    Ok(Json(json!({
        "available": own.is_some() || cfg.server_key.is_some(),
        "source": if own.is_some() { "own" } else if cfg.server_key.is_some() { "server" } else { "none" },
        "ownKeyHint": own.map(|(_, hint)| hint),
        "serverKey": cfg.server_key.is_some(),
        "model": cfg.model,
        "webTools": cfg.web_tools,
        "usage": { "requestsToday": used, "dailyLimit": cfg.daily_requests },
    })))
}

#[derive(Deserialize)]
pub struct KeyRequest {
    key: String,
}

/// `PUT /api/ai/key` — keep a key of the person's own, encrypted, to use instead of the server's.
pub async fn put_key(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    LenientJson(req): LenientJson<KeyRequest>,
) -> AppResult<Json<Value>> {
    let key = req.key.trim();
    if !key.starts_with("sk-ant-") || key.len() < 20 || key.len() > 400 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::BadRequest("that does not look like an Anthropic API key (they start with sk-ant-)".into()));
    }
    store_key(&state, user.id, key).await?;
    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /api/ai/key`
pub async fn delete_key(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM ai_keys WHERE user_id = $1").bind(user.id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChatRequest {
    messages: Vec<Value>,
}

/// `POST /api/projects/{id}/ai/chat` — one model turn, streamed back as server-sent events.
pub async fn chat(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(project_id): Path<Uuid>,
    LenientJson(req): LenientJson<ChatRequest>,
) -> AppResult<Response> {
    // Any member may ask about the design.  Whether an accepted proposal can be applied is
    // the op pipeline's decision, made from the role at the moment the op arrives.
    persist::effective_role(&state.pool, user.id, project_id).await?.ok_or(AppError::Forbidden)?;

    let cfg = config();
    let own = load_key(&state, user.id).await?;
    let key = match (&own, &cfg.server_key) {
        (Some((k, _)), _) => k.clone(),
        (None, Some(k)) => {
            if requests_today(&state, user.id).await? >= cfg.daily_requests {
                return Err(AppError::Api(
                    StatusCode::TOO_MANY_REQUESTS,
                    "ai_daily_limit",
                    format!("You have used today's {} assistant requests. Add your own API key in the assistant's settings to keep going.", cfg.daily_requests),
                ));
            }
            k.clone()
        }
        (None, None) => {
            return Err(AppError::Api(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_not_configured",
                "The assistant has no API key yet. Add your own in its settings, or ask the server's owner to set ANTHROPIC_API_KEY.".into(),
            ))
        }
    };

    if req.messages.is_empty() || req.messages.len() > 2000 {
        return Err(AppError::BadRequest("messages must be a non-empty list".into()));
    }
    for m in &req.messages {
        // Only the two conversational roles: a `system` entry would be an operator instruction
        // written by the caller.
        match m.get("role").and_then(Value::as_str) {
            Some("user") | Some("assistant") => {}
            _ => return Err(AppError::BadRequest("each message needs the role user or assistant".into())),
        }
    }

    let mut body = json!({
        "model": cfg.model,
        "max_tokens": 32000,
        "stream": true,
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": { "effort": cfg.effort },
        // The system prompt and tools never change and the history only grows, so every turn
        // after the first reads the whole prefix from cache.
        "cache_control": { "type": "ephemeral" },
        "system": SYSTEM_PROMPT,
        "tools": tools(),
        "messages": req.messages,
    });
    if cfg.fallbacks {
        body["fallbacks"] = json!("default");
    }
    let payload = serde_json::to_vec(&body).map_err(|e| anyhow::anyhow!(e))?;
    if payload.len() > MAX_BODY_BYTES {
        return Err(AppError::Api(
            StatusCode::PAYLOAD_TOO_LARGE,
            "ai_conversation_too_long",
            "This conversation has grown too long. Start a new chat.".into(),
        ));
    }

    note_request(&state, user.id).await?;

    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow::anyhow!(e))?;
    let mut call = http
        .post(format!("{}/v1/messages", cfg.api_url))
        .header("x-api-key", &key)
        .header("anthropic-version", API_VERSION)
        .header(header::CONTENT_TYPE, "application/json");
    if cfg.fallbacks {
        call = call.header("anthropic-beta", FALLBACK_BETA);
    }
    let upstream = call.body(payload).send().await.map_err(|e| {
        tracing::warn!("assistant: could not reach the model API: {e}");
        AppError::Api(StatusCode::BAD_GATEWAY, "ai_unreachable", "The assistant could not reach the model service. Try again in a moment.".into())
    })?;

    let status = upstream.status();
    if !status.is_success() {
        let text = upstream.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default();
        tracing::warn!("assistant: model API answered {status}: {detail}");
        let on_own_key = own.is_some();
        return Err(match status.as_u16() {
            401 | 403 => AppError::Api(
                StatusCode::BAD_GATEWAY,
                "ai_key_rejected",
                if on_own_key { "Your API key was rejected. Check it in the assistant's settings.".into() }
                else { "The server's API key was rejected. Its owner needs to check ANTHROPIC_API_KEY.".into() },
            ),
            429 => AppError::Api(StatusCode::TOO_MANY_REQUESTS, "ai_rate_limited", "The model service is rate limiting this key. Wait a little and try again.".into()),
            413 => AppError::Api(StatusCode::PAYLOAD_TOO_LARGE, "ai_conversation_too_long", "This conversation has grown too long. Start a new chat.".into()),
            529 | 500..=599 => AppError::Api(StatusCode::BAD_GATEWAY, "ai_overloaded", "The model service is busy right now. Try again in a moment.".into()),
            _ => AppError::Api(
                StatusCode::BAD_GATEWAY,
                "ai_request_refused",
                if detail.is_empty() { format!("The model service refused the request ({status}).") } else { format!("The model service refused the request: {detail}") },
            ),
        });
    }

    // Pass the event stream through untouched, counting tokens on the way.
    let pool = state.pool.clone();
    let user_id = user.id;
    let mut bytes = upstream.bytes_stream();
    let stream = async_stream(move |tx| async move {
        let mut meter = UsageMeter::default();
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(b) => {
                    meter.feed(&b);
                    if tx.send(Ok(b)).await.is_err() {
                        break; // the browser went away (Stop was pressed)
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e))).await;
                    break;
                }
            }
        }
        note_tokens(&pool, user_id, meter.input, meter.output).await;
    });

    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            // Railway's edge (and nginx in front of a self-hosted copy) must not hold the stream back.
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

type Chunk = Result<axum::body::Bytes, std::io::Error>;

/// A stream fed by a task, so the usage write happens when the stream ends however it ends —
/// including the browser disconnecting mid-reply, which drops the response body.
fn async_stream<F, Fut>(f: F) -> impl futures_util::Stream<Item = Chunk>
where
    F: FnOnce(tokio::sync::mpsc::Sender<Chunk>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Chunk>(32);
    tokio::spawn(f(tx));
    futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) })
}

/// The ops of a document after `since`, oldest first: with the latest snapshot
/// (`/api/docs/{id}/content`, whose `x-snapshot-seq` header is the `since` to pass) this gives
/// a document as it stands now, for reading one that is not the one open in the editor (the
/// assistant reads the schematic while the board is open, and the other way round).
#[derive(Deserialize)]
pub struct OpsQuery { since: i64 }

pub async fn doc_ops(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    crate::access::Viewer { links, .. }: crate::access::Viewer,
    Path(doc_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<OpsQuery>,
) -> AppResult<Json<Value>> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    crate::access::require(&state.pool, &crate::access::Viewer { user: Some(user), links }, doc.project_id).await?;
    let ops = persist::ops_since(&state.pool, doc_id, q.since).await?;
    let head = ops.last().map(|o| o.seq).unwrap_or(q.since);
    Ok(Json(json!({ "since": q.since, "head": head, "ops": ops.iter().map(|o| json!({ "seq": o.seq, "changes": o.changes })).collect::<Vec<_>>() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_is_well_formed() {
        let list: Vec<Value> = serde_json::from_str(DESIGN_TOOLS).unwrap();
        assert!(list.len() >= 10);
        for t in &list {
            assert!(t["name"].as_str().is_some_and(|n| !n.is_empty()));
            assert!(t["description"].as_str().is_some_and(|d| d.len() > 40), "{} needs a real description", t["name"]);
            assert_eq!(t["input_schema"]["type"], "object");
        }
    }

    #[test]
    fn meter_reads_usage_across_chunk_boundaries() {
        let mut m = UsageMeter::default();
        let stream = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":3000,\"cache_creation_input_tokens\":40,\"output_tokens\":1}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"message_delta is just a word here\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":87}}\n\n",
        );
        for piece in stream.as_bytes().chunks(7) {
            m.feed(piece);
        }
        assert_eq!(m.input, 3052);
        assert_eq!(m.output, 87);
    }
}
