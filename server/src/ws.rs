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
/// How often an idle socket looks whether anyone's access changed.
const ACCESS_RECHECK: Duration = Duration::from_secs(1);
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// One op is one message.  A zone travels with its fill, and the fill of a large pour
/// alone can pass a megabyte.
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// Presence is fanned out to every peer every 50ms, so an unbounded blob is a
/// broadcast amplifier any viewer can point at the doc.
const MAX_PRESENCE_BYTES: usize = 8 * 1024;

/// The user id a guest's peer entry carries: no account has it.
pub const GUEST_USER_ID: i64 = 0;

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
    // Share links this browser opened: what lets someone who is not a member (or not
    // signed in at all) watch a project (access.rs).
    let links = jar
        .get(crate::access::LINKS_COOKIE)
        .map(|c| crate::access::parse_links(c.value()))
        .unwrap_or_default();

    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = handle_socket(socket, state, cookie_token, links).await {
                tracing::debug!("ws connection ended: {e:#}");
            }
        })
}

use kicad_collab_protocol::ClientMsg;

struct JoinedDoc {
    tx: mpsc::Sender<DocMsg>,
    role: String,
    project_id: uuid::Uuid,
    /// AppState::access_epoch when `role` was looked up.
    epoch: u64,
}

/// The role this socket holds on a joined document, looked up again when
/// anyone's access changed since it was cached: a demoted editor stops writing
/// and a removed member stops receiving without having to reconnect.  `None`
/// means the access is gone.
///
/// `writing` is set for an op.  With other replicas around, the news that access changed
/// travels as a notification and can arrive a moment after the change itself, so a write
/// does not rely on it: it asks the database every time.
async fn current_role(state: &AppState, who: &Who, d: &mut JoinedDoc, writing: bool) -> Option<String> {
    let now = state.access_epoch.load(std::sync::atomic::Ordering::Relaxed);
    if now != d.epoch || (writing && state.relay.others_alive()) {
        match who.role(state, d.project_id).await {
            Ok(Some(role)) => {
                d.role = role;
                d.epoch = now;
            }
            Ok(None) => return None,
            // A failed lookup must not lock anyone out; try again on the next message.
            Err(e) => tracing::error!("role recheck failed: {e}"),
        }
    }
    Some(d.role.clone())
}

/// Whoever is on the socket: an account, or a guest who only watches.
struct Who {
    /// `None` for a guest: someone not signed in, looking at a public project or through
    /// a share link.  A guest never writes.
    user_id: Option<i64>,
    links: Vec<String>,
}

impl Who {
    /// The role on a project as the wire names it; a guest's is always "viewer".
    async fn role(&self, state: &AppState, project_id: Uuid) -> Result<Option<String>, sqlx::Error> {
        let access = crate::access::resolve_for(&state.pool, self.user_id, &self.links, project_id).await?;
        Ok(access.map(|a| {
            if self.user_id.is_none() { "viewer".to_string() } else { a.role_str().to_string() }
        }))
    }
}

/// Take this socket out of a document it may no longer see.
async fn drop_doc<K: std::hash::Hash + Eq + Copy>(
    joined: &mut std::collections::HashMap<K, JoinedDoc>,
    doc_id: K,
    client_id: &str,
    out_tx: &mpsc::Sender<String>,
) {
    if let Some(d) = joined.remove(&doc_id) {
        let _ = d
            .tx
            .send(DocMsg::Leave { client_id: client_id.to_string(), tx: out_tx.clone() })
            .await;
    }
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

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    cookie_token: String,
    links: Vec<String>,
) -> anyhow::Result<()> {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Outbound pump: everything (doc actors and this task) sends pre-serialized
    // JSON through one bounded channel; the pump owns the sink and pings.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        // The first tick fires immediately; a ping before the client's hello
        // makes the browser answer with a pong that would be read as the hello.
        ping.tick().await;
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
    // The hello is the first TEXT frame; control frames (a pong to our ping,
    // a stray ping) may legitimately arrive ahead of it and must be skipped.
    let hello_text = loop {
        let frame = tokio::time::timeout(HELLO_TIMEOUT, ws_rx.next())
            .await
            .map_err(|_| anyhow::anyhow!("hello timeout"))?
            .ok_or_else(|| anyhow::anyhow!("closed before hello"))??;
        match frame {
            Message::Text(t) => break t.to_string(),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => anyhow::bail!("closed before hello"),
            _ => anyhow::bail!("first frame was not text"),
        }
    };
    let hello: ClientMsg = match serde_json::from_str(&hello_text) {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!("bad hello: {e}; frame was: {}", truncate(&hello_text, 300));
            reject(&out_tx, &writer, json!({ "type": "error", "code": "bad_message" })).await;
            anyhow::bail!("bad hello");
        }
    };
    let ClientMsg::hello { proto, token, client_id, link_token, client: client_kind, agent } = hello else {
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
    // A token in the hello is a claim to be someone and must hold.  With none, the session
    // cookie decides; a browser with no session (or one that ran out) is a guest, who may
    // watch what a public project or an opened share link shows and nothing else.
    let user = if !token.is_empty() {
        let Some(claims) = auth::verify_jwt(&state, &token) else {
            reject(&out_tx, &writer, json!({ "type": "error", "code": "auth_failed" })).await;
            anyhow::bail!("auth failed");
        };
        let Some(user) = persist::get_user(&state.pool, claims.sub).await? else {
            reject(&out_tx, &writer, json!({ "type": "error", "code": "auth_failed" })).await;
            anyhow::bail!("auth failed: no such user");
        };
        Some(user)
    } else {
        match auth::verify_jwt(&state, &cookie_token) {
            Some(claims) => persist::get_user(&state.pool, claims.sub).await?,
            None => None,
        }
    };
    // Guests are for the browser; a native client signs in.
    if user.is_none() && client_kind.as_deref() != Some("web") {
        reject(&out_tx, &writer, json!({ "type": "error", "code": "auth_failed" })).await;
        anyhow::bail!("auth failed");
    }

    // Claim a share link presented at connect time.
    if let (Some(link_token), Some(user)) = (&link_token, &user) {
        if let Some(link) = persist::get_valid_share_link(&state.pool, link_token).await? {
            let project = persist::get_project(&state.pool, link.project_id).await?;
            // The owner opening their own link must not become a member of their own project.
            if project.is_some_and(|p| p.owner_id != user.id) {
                persist::claim_share_link(&state.pool, user.id, &link).await?;
                state.access_changed();
            }
        }
    }
    // A guest who names a link in the hello has opened it, the same as the cookie says.
    let mut links = links;
    if let (None, Some(link_token)) = (&user, &link_token) {
        links.extend(crate::access::parse_links(link_token));
    }
    let who = Who { user_id: user.as_ref().map(|u| u.id), links };

    // clientId keys the doc-actor client map and the op-dedup index, so it must
    // be namespaced by the authenticated user: otherwise anyone who can read a
    // peer's id (it ships in doc_info) can evict them or spoof their ops. The
    // client's own suffix is preserved so dedup survives reconnects — and since
    // clients echo back the assigned id (own prefix included) when they
    // reconnect, any repetition of our own prefix is stripped first so the id
    // stays stable instead of growing one "uid:" per reconnect.
    // A guest has no account to namespace by and sends no ops to deduplicate: the id is
    // made here, so one guest can never name (and so displace) another.
    let client_id = match &user {
        Some(user) => {
            let raw = client_id
                .filter(|c| c.len() <= 128)
                .unwrap_or_else(|| format!("c-{}", Uuid::new_v4()));
            let own_prefix = format!("{}:", user.id);
            let mut suffix = raw.as_str();
            while let Some(rest) = suffix.strip_prefix(&own_prefix) {
                suffix = rest;
            }
            format!("{}{}", own_prefix, suffix)
        }
        None => format!("guest:{}", Uuid::new_v4()),
    };
    // What the rest of the session calls this person.
    let (user_id, login, display_name) = match &user {
        Some(u) => (u.id, u.login.clone(), u.name.clone().unwrap_or_else(|| u.login.clone())),
        None => (GUEST_USER_ID, "guest".to_string(), "Guest".to_string()),
    };
    // One counter for every replica, so two people who meet in a document through
    // different replicas were not both handed the same colour.
    let color_idx = match sqlx::query_as::<_, (i64,)>("SELECT nextval('peer_color_seq')").fetch_one(&state.pool).await {
        Ok((n,)) => n as usize % PEER_COLORS.len(),
        Err(_) => state.color_counter.fetch_add(1, Ordering::Relaxed) % PEER_COLORS.len(),
    };
    let is_agent = client_kind.as_deref() == Some("mcp");
    let peer = PeerInfo {
        client_id: client_id.clone(),
        user_id,
        login: login.clone(),
        name: {
            let name = display_name;
            if is_agent {
                // An application working for the person (the MCP endpoint's headless editor):
                // peers see whose it is and that it is not the person's own hand.
                let label: String = agent.as_deref().unwrap_or("").chars().filter(|c| !c.is_control()).take(40).collect();
                let label = label.trim();
                format!("{name} ({})", if label.is_empty() { "AI assistant" } else { label })
            } else {
                name
            }
        },
        color: PEER_COLORS[color_idx].to_string(),
        kind: match client_kind.as_deref() {
            Some("web") => "web".into(),
            Some("mcp") => "mcp".into(),
            _ => "desktop".into(),
        },
    };
    let _ = out_tx.try_send(
        json!({
            "type": "hello_ok", "proto": PROTO_VERSION, "clientId": client_id,
            "userId": user_id, "login": login, "name": peer.name, "color": peer.color,
            "guest": user.is_none(),
        })
        .to_string(),
    );

    // Only a client that can write the real file back may be asked for a snapshot: the browser
    // editor parses a document down to the items it draws, so a file written from it would be
    // missing the header, title block, instance data and embedded files.  See
    // doc_actor::maybe_request_snapshot.
    let can_snapshot = !matches!(client_kind.as_deref(), Some("web") | Some("mcp"));

    // --- Main loop ---
    let mut joined: HashMap<Uuid, JoinedDoc> = HashMap::new();

    // Someone who only watches never sends anything, so losing access cannot wait for
    // their next message: the epoch is looked at on a timer as well, and every joined
    // document is rechecked when it moved.  A removed member, a project put in the
    // Trash or made private stops reaching this socket within about a second.
    let mut access_tick = tokio::time::interval(ACCESS_RECHECK);
    access_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut seen_epoch = state.access_epoch.load(std::sync::atomic::Ordering::Relaxed);

    loop {
        let frame = tokio::select! {
            frame = ws_rx.next() => frame,
            _ = access_tick.tick() => {
                let now = state.access_epoch.load(std::sync::atomic::Ordering::Relaxed);
                if now != seen_epoch {
                    seen_epoch = now;
                    let ids: Vec<Uuid> = joined.keys().copied().collect();
                    for doc_id in ids {
                        let Some(d) = joined.get_mut(&doc_id) else { continue };
                        let before = d.role.clone();
                        match current_role(&state, &who, d, false).await {
                            None => {
                                let _ = out_tx.try_send(
                                    json!({ "type": "error", "code": "permission_denied", "docId": doc_id })
                                        .to_string(),
                                );
                                drop_doc(&mut joined, doc_id, &client_id, &out_tx).await;
                            }
                            // Promoted or demoted while the document is open: say so, so the
                            // editor can switch its tools on or off without a reload.
                            Some(role) if role != before => {
                                let _ = out_tx.try_send(
                                    json!({ "type": "role", "docId": doc_id, "role": role }).to_string(),
                                );
                            }
                            Some(_) => {}
                        }
                    }
                }
                continue;
            }
        };
        let Some(frame) = frame else { break };
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
                let epoch = state.access_epoch.load(std::sync::atomic::Ordering::Relaxed);
                let role = match who.role(&state, doc.project_id).await {
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
                    can_snapshot,
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

                joined.insert(doc_id, JoinedDoc { tx, role, project_id: doc.project_id, epoch });
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
                let Some(d) = joined.get_mut(&doc_id) else {
                    // Not a permission problem: the op simply arrived before (or without) a
                    // join on this socket -- typically a client replaying its journal right
                    // after a reconnect. Reported as permission_denied this was read by the
                    // desktop as "your access has been withdrawn". No clientOpId on purpose:
                    // older clients treat an op-scoped refusal as final and roll the edit back,
                    // and this one is transient -- the client re-sends once the join lands.
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "not_joined", "docId": doc_id })
                            .to_string(),
                    );
                    continue;
                };
                let role = current_role(&state, &who, d, true).await;
                if role.as_deref() != Some("editor") || who.user_id.is_none() {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "permission_denied", "docId": doc_id,
                                "clientOpId": client_op_id, "role": role }).to_string(),
                    );
                    if role.is_none() {
                        drop_doc(&mut joined, doc_id, &client_id, &out_tx).await;
                    }
                    continue;
                }
                let Some(d) = joined.get(&doc_id) else { continue };
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
                        user_id,
                        login: login.clone(),
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
                // Presence is the heartbeat of someone who only watches: the place to
                // notice that their access was taken away.
                if let Some(d) = joined.get_mut(&doc_id) {
                    if current_role(&state, &who, d, false).await.is_none() {
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "permission_denied", "docId": doc_id })
                                .to_string(),
                        );
                        drop_doc(&mut joined, doc_id, &client_id, &out_tx).await;
                        continue;
                    }
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
            ClientMsg::request { doc_id, action } => {
                // Only an editor may set someone else's application to work, and only on
                // the short list of things there is a reason to ask for.
                let Some(d) = joined.get_mut(&doc_id) else { continue };
                let role = current_role(&state, &who, d, true).await;
                if role.as_deref() != Some("editor") || action != "fill_zones" {
                    let _ = out_tx.try_send(
                        json!({ "type": "error", "code": "request_refused", "docId": doc_id,
                                "action": action }).to_string(),
                    );
                    continue;
                }
                let Some(d) = joined.get(&doc_id) else { continue };
                let _ = d.tx.send(DocMsg::Request { client_id: client_id.clone(), action }).await;
            }
            ClientMsg::resync { doc_id } => {
                // A resync hands over the whole file: never to someone whose access went.
                if let Some(d) = joined.get_mut(&doc_id) {
                    if current_role(&state, &who, d, false).await.is_none() {
                        let _ = out_tx.try_send(
                            json!({ "type": "error", "code": "permission_denied", "docId": doc_id })
                                .to_string(),
                        );
                        drop_doc(&mut joined, doc_id, &client_id, &out_tx).await;
                        continue;
                    }
                }
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
