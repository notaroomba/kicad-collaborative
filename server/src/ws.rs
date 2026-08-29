use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth;
use crate::doc_actor::{DocMsg, PeerInfo};
use crate::persist;
use crate::AppState;

pub const PROTO_VERSION: u32 = 1;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// Presence is fanned out to every peer every 50ms, so an unbounded blob is a
/// broadcast amplifier any viewer can point at the doc.
const MAX_PRESENCE_BYTES: usize = 8 * 1024;

pub const PEER_COLORS: [&str; 8] = [
    "#e05d44", "#4477ee", "#22aa66", "#d4a017", "#9b59b6", "#e67e22", "#16a2b8", "#e83e8c",
];

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
) -> Response {
    // Web viewers authenticate with the session cookie riding the upgrade
    // request; native clients put a bearer token in the hello frame instead.
    let cookie_token =
        jar.get(crate::auth::COOKIE_NAME).map(|c| c.value().to_string()).unwrap_or_default();

    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = handle_socket(socket, state, cookie_token).await {
                tracing::debug!("ws connection ended: {e:#}");
            }
        })
}

use kicad_collab_protocol::ClientMsg;

struct JoinedDoc {
    tx: mpsc::Sender<DocMsg>,
    role: String,
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Send a handshake rejection and give the writer a moment to flush it.
///
/// Bailing straight out of the handshake drops the socket before the writer
/// task drains its queue, so the client would see a bare close with no reason.
async fn reject(out_tx: &mpsc::Sender<String>, writer: &tokio::task::JoinHandle<()>, msg: Value) {
    if out_tx.send(msg.to_string()).await.is_ok() {
        // The writer takes one message at a time; once the queue is empty again
        // the frame has been handed to the socket.
        for _ in 0..50 {
            if out_tx.capacity() == out_tx.max_capacity() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    let _ = writer;
}

async fn handle_socket(socket: WebSocket, state: AppState, cookie_token: String) -> anyhow::Result<()> {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Outbound pump: everything (doc actors and this task) sends pre-serialized
    // JSON through one bounded channel; the pump owns the sink and pings.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                msg = out_rx.recv() => {
                    let Some(msg) = msg else { break };
                    if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // --- Handshake ---
    let hello = tokio::time::timeout(HELLO_TIMEOUT, ws_rx.next())
        .await
        .map_err(|_| anyhow::anyhow!("hello timeout"))?
        .ok_or_else(|| anyhow::anyhow!("closed before hello"))??;
    let hello_text = match hello.to_text() {
        Ok(t) => t.to_string(),
        Err(_) => anyhow::bail!("first frame was not text"),
    };
    let hello: ClientMsg = match serde_json::from_str(&hello_text) {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!("bad hello: {e}; frame was: {}", truncate(&hello_text, 300));
            reject(&out_tx, &writer, json!({ "type": "error", "code": "bad_message" })).await;
            anyhow::bail!("bad hello");
        }
    };
    let ClientMsg::hello { proto, token, client_id, link_token, .. } = hello else {
        reject(&out_tx, &writer, json!({ "type": "error", "code": "bad_message" })).await;
        anyhow::bail!("first message must be hello");
    };
    if proto != PROTO_VERSION {
        reject(
            &out_tx,
            &writer,
            json!({ "type": "error", "code": "unsupported_protocol", "supported": [PROTO_VERSION] }),
        )
        .await;
        anyhow::bail!("unsupported protocol {proto}");
    }
    let token = if token.is_empty() { cookie_token } else { token };

    let Some(claims) = auth::verify_jwt(&state, &token) else {
        reject(&out_tx, &writer, json!({ "type": "error", "code": "auth_failed" })).await;
        anyhow::bail!("auth failed");
    };
    let Some(user) = persist::get_user(&state.pool, claims.sub).await? else {
        reject(&out_tx, &writer, json!({ "type": "error", "code": "auth_failed" })).await;
        anyhow::bail!("auth failed: no such user");
    };

    // Claim a share link presented at connect time.
    if let Some(link_token) = &link_token {
        if let Some(link) = persist::get_valid_share_link(&state.pool, link_token).await? {
            persist::claim_share_link(&state.pool, user.id, &link).await?;
        }
    }

    // clientId keys the doc-actor client map and the op-dedup index, so it must
    // be namespaced by the authenticated user: otherwise anyone who can read a
    // peer's id (it ships in doc_info) can evict them or spoof their ops. The
    // client's own suffix is preserved so dedup survives reconnects — and since
    // clients echo back the assigned id (own prefix included) when they
    // reconnect, any repetition of our own prefix is stripped first so the id
    // stays stable instead of growing one "uid:" per reconnect.
    let client_id = {
        let raw = client_id
            .filter(|c| c.len() <= 128)
            .unwrap_or_else(|| format!("c-{}", Uuid::new_v4()));
        let own_prefix = format!("{}:", user.id);
        let mut suffix = raw.as_str();
        while let Some(rest) = suffix.strip_prefix(&own_prefix) {
            suffix = rest;
        }
        format!("{}{}", own_prefix, suffix)
    };
    let color_idx = state.color_counter.fetch_add(1, Ordering::Relaxed) % PEER_COLORS.len();
    let peer = PeerInfo {
        client_id: client_id.clone(),
        user_id: user.id,
        login: user.login.clone(),
        name: user.name.clone().unwrap_or_else(|| user.login.clone()),
        color: PEER_COLORS[color_idx].to_string(),
    };
    let _ = out_tx.try_send(
        json!({
            "type": "hello_ok", "proto": PROTO_VERSION, "clientId": client_id,
            "userId": user.id, "login": user.login, "name": peer.name, "color": peer.color,
        })
        .to_string(),
    );

    // --- Main loop ---
    let mut joined: HashMap<Uuid, JoinedDoc> = HashMap::new();

    while let Some(frame) = ws_rx.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(_) => break,
        };
        let text = match frame {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            // Ping/Pong handled by the library; ignore binary.
            _ => continue,
        };
        let msg: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => {
                let _ = out_tx.try_send(json!({ "type": "error", "code": "bad_message" }).to_string());
                continue;
            }
        };

        match msg {
            ClientMsg::hello { .. } => {
                let _ = out_tx.try_send(json!({ "type": "error", "code": "bad_message" }).to_string());
            }
            ClientMsg::join_doc { doc_id, since_seq } => {
                // These must not use `?`: an error return here skips the
                // Leave/abort cleanup below and leaves a ghost registration.
                let doc = match persist::get_document(&state.pool, doc_id).await {
                    Ok(Some(doc)) => doc,
                    Ok(None) => {
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "not_found", "docId": doc_id })
                                .to_string(),
                        );
                        continue;
                    }
                    Err(e) => {
                        tracing::error!("join_doc {doc_id}: db error: {e}");
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "internal", "docId": doc_id })
                                .to_string(),
                        );
                        continue;
                    }
                };
                let role = match persist::effective_role(&state.pool, user.id, doc.project_id).await
                {
                    Ok(Some(role)) => role,
                    Ok(None) => {
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "permission_denied", "docId": doc_id })
                                .to_string(),
                        );
                        continue;
                    }
                    Err(e) => {
                        tracing::error!("join_doc {doc_id}: role lookup failed: {e}");
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "internal", "docId": doc_id })
                                .to_string(),
                        );
                        continue;
                    }
                };

                let join = DocMsg::Join {
                    peer: peer.clone(),
                    role: role.clone(),
                    since_seq,
                    tx: out_tx.clone(),
                };

                // The actor may have reaped itself between get_or_spawn and
                // send; a rejected send hands the message back, so respawn and
                // retry once rather than registering a dead sender.
                let mut tx = state.registry.get_or_spawn(&state.pool, &doc);

                let tx = match tx.send(join).await {
                    Ok( () ) => tx,
                    Err( e ) => {
                        tx = state.registry.get_or_spawn(&state.pool, &doc);
                        let _ = tx.send(e.0).await;
                        tx
                    }
                };

                joined.insert(doc_id, JoinedDoc { tx, role });
            }
            ClientMsg::leave_doc { doc_id } => {
                if let Some(d) = joined.remove(&doc_id) {
                    let _ = d
                        .tx
                        .send(DocMsg::Leave {
                            client_id: client_id.clone(),
                            tx: out_tx.clone(),
                        })
                        .await;
                }
            }
            ClientMsg::op { doc_id, client_op_id, base_seq, changes } => {
                let Some(d) = joined.get(&doc_id) else {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "permission_denied", "docId": doc_id })
                            .to_string(),
                    );
                    continue;
                };
                if d.role != "editor" {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "permission_denied", "docId": doc_id,
                                "clientOpId": client_op_id }).to_string(),
                    );
                    continue;
                }
                if let Err(reason) = validate_changes(&changes) {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "bad_op", "docId": doc_id,
                                "clientOpId": client_op_id, "message": reason }).to_string(),
                    );
                    continue;
                }
                let _ = d
                    .tx
                    .send(DocMsg::SubmitOp {
                        client_id: client_id.clone(),
                        user_id: user.id,
                        login: user.login.clone(),
                        client_op_id,
                        base_seq,
                        changes,
                    })
                    .await;
            }
            ClientMsg::presence { doc_id, state: presence_state } => {
                if presence_state.to_string().len() > MAX_PRESENCE_BYTES {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "bad_message", "docId": doc_id,
                                "message": "presence state too large" })
                        .to_string(),
                    );
                    continue;
                }
                if let Some(d) = joined.get(&doc_id) {
                    let _ = d
                        .tx
                        .send(DocMsg::Presence {
                            client_id: client_id.clone(),
                            state: presence_state,
                        })
                        .await;
                }
            }
            ClientMsg::resync { doc_id } => {
                if let Some(d) = joined.get(&doc_id) {
                    let _ = d.tx.send(DocMsg::Resync { client_id: client_id.clone() }).await;
                }
            }
        }
    }

    for (_, d) in joined {
        let _ = d
            .tx
            .send(DocMsg::Leave { client_id: client_id.clone(), tx: out_tx.clone() })
            .await;
    }
    writer.abort();
    Ok(())
}

/// Structural validation only: the server never interprets change contents.
pub fn validate_changes(changes: &Value) -> Result<(), &'static str> {
    let Some(arr) = changes.as_array() else {
        return Err("changes must be an array");
    };
    if arr.is_empty() {
        return Err("changes must not be empty");
    }
    for c in arr {
        let Some(kind) = c.get("kind").and_then(Value::as_str) else {
            return Err("each change needs a kind");
        };
        if !matches!(kind, "ADDED" | "REMOVED" | "MODIFIED") {
            return Err("kind must be ADDED, REMOVED or MODIFIED");
        }
        if c.get("id").and_then(Value::as_str).is_none() {
            return Err("each change needs an id");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_changes_accepts_wire_shape() {
        let ops = json!([
            { "id": "a1b2", "typeName": "SCH_SYMBOL", "kind": "MODIFIED",
              "properties": [{ "name": "Position X", "before": 1, "after": 2 }] },
            { "id": "e5f6", "typeName": "SCH_LINE", "kind": "ADDED", "sexpr": "(wire ...)" },
            { "id": "dead", "kind": "REMOVED" },
        ]);
        assert!(validate_changes(&ops).is_ok());
    }

    #[test]
    fn presence_size_cap_is_enforceable() {
        let ok = json!({ "cursor": [1016000, 508000], "selection": ["a1b2"] });
        assert!(ok.to_string().len() <= MAX_PRESENCE_BYTES);

        let flood = json!({ "cursor": [0, 0], "pad": "x".repeat(MAX_PRESENCE_BYTES) });
        assert!(flood.to_string().len() > MAX_PRESENCE_BYTES);
    }

    #[test]
    fn validate_changes_rejects_bad_input() {
        assert!(validate_changes(&json!({})).is_err());
        assert!(validate_changes(&json!([])).is_err());
        assert!(validate_changes(&json!([{ "id": "x", "kind": "COLLISION" }])).is_err());
        assert!(validate_changes(&json!([{ "kind": "ADDED" }])).is_err());
    }
}
