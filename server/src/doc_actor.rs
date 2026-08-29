use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::persist::{self, Document};

const PRESENCE_FLUSH: Duration = Duration::from_millis(50);
const PRESENCE_STALE: Duration = Duration::from_secs(30);
const REAP_AFTER: Duration = Duration::from_secs(60);
const SNAPSHOT_LAG_OPS: i64 = 500;
const SNAPSHOT_REQUEST_COOLDOWN: Duration = Duration::from_secs(60);

/// With any un-snapshotted ops at all, ask for a fresh snapshot this often —
/// it is what keeps gallery previews and clones close to the live document.
/// Overridable for tests.
fn snapshot_fresh_interval() -> Duration {
    static INTERVAL: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *INTERVAL.get_or_init(|| {
        std::env::var("SNAPSHOT_FRESH_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(300))
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PeerInfo {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub login: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug)]
pub enum DocMsg {
    Join {
        peer: PeerInfo,
        role: String,
        since_seq: Option<i64>,
        tx: mpsc::Sender<String>,
    },
    Leave {
        client_id: String,
        /// Identifies the connection leaving: a stale socket's late Leave must
        /// not evict a newer connection that reused the same client id.
        tx: mpsc::Sender<String>,
    },
    SubmitOp {
        client_id: String,
        user_id: i64,
        login: String,
        client_op_id: String,
        base_seq: Option<i64>,
        changes: Value,
    },
    Presence {
        client_id: String,
        state: Value,
    },
    Resync {
        client_id: String,
    },
    /// History restore: state was replaced out from under everyone, so tell
    /// every client to drop what it has and re-fetch.
    Reset {
        seq: i64,
    },
}

struct ClientState {
    tx: mpsc::Sender<String>,
    peer: PeerInfo,
    role: String,
    last_seen: Instant,
    /// Latest presence state; None until the client sends one.
    presence: Option<Value>,
}

pub fn spawn(pool: PgPool, doc: Document) -> mpsc::Sender<DocMsg> {
    let (tx, rx) = mpsc::channel(1024);
    tokio::spawn(run(pool, doc, rx));
    tx
}

async fn run(pool: PgPool, doc: Document, mut rx: mpsc::Receiver<DocMsg>) {
    let doc_id = doc.id;
    let mut head_seq = match persist::head_seq(&pool, doc_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("doc {doc_id}: failed to load head seq: {e}");
            return;
        }
    };

    let mut clients: HashMap<String, ClientState> = HashMap::new();
    // clientId -> Some(state) = changed, None = left. Flushed every 50ms.
    let mut presence_dirty: HashMap<String, Option<Value>> = HashMap::new();
    let mut empty_since = Some(Instant::now());
    let mut last_snapshot_request = Instant::now() - SNAPSHOT_REQUEST_COOLDOWN;
    let mut last_snapshot_check = Instant::now();
    let mut flush = tokio::time::interval(PRESENCE_FLUSH);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!("doc actor {doc_id} ({}) started at seq {head_seq}", doc.path);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    DocMsg::Join { peer, role, since_seq, tx } => {
                        // A half-delivered join (doc_info or catch-up dropped)
                        // would leave the client receiving ops with no base
                        // state, so it is all-or-nothing: on failure the client
                        // is not registered and its join simply times out.
                        if handle_join(&pool, &doc, head_seq, &mut clients, &peer, &role,
                                       since_seq, tx).await
                        {
                            // Announce to everyone else and share existing presence with the joiner.
                            let joined = json!({ "type": "peer_joined", "docId": doc_id, "peer": peer }).to_string();
                            broadcast_except(&mut clients, &mut presence_dirty, doc_id, &peer.client_id, &joined);
                            let existing: serde_json::Map<String, Value> = clients.iter()
                                .filter(|( id, c )| **id != peer.client_id && c.presence.is_some())
                                .map(|( id, c )| (id.clone(), json!({ "user": c.peer, "state": c.presence })))
                                .collect();
                            if !existing.is_empty() {
                                if let Some(c) = clients.get(&peer.client_id) {
                                    let _ = c.tx.try_send(json!({
                                        "type": "presence", "docId": doc_id, "peers": existing
                                    }).to_string());
                                }
                            }
                            empty_since = None;
                        }
                    }
                    DocMsg::Leave { client_id, tx } => {
                        let owns = clients.get(&client_id)
                                          .is_some_and(|c| c.tx.same_channel(&tx));

                        if owns {
                            clients.remove(&client_id);
                            presence_dirty.insert(client_id.clone(), None);
                            let msg = json!({ "type": "peer_left", "docId": doc_id, "clientId": client_id }).to_string();
                            broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg);
                        }
                        if clients.is_empty() && empty_since.is_none() {
                            empty_since = Some(Instant::now());
                        }
                    }
                    DocMsg::SubmitOp { client_id, user_id, login, client_op_id, base_seq, changes } => {
                        touch(&mut clients, &client_id);
                        let next = head_seq + 1;
                        match persist::insert_op(&pool, doc_id, next, user_id, &client_id, &client_op_id, base_seq, &changes).await {
                            Ok(None) => {
                                head_seq = next;
                                ack(&clients, &client_id, doc_id, &client_op_id, next);
                                let msg = json!({
                                    "type": "op", "docId": doc_id, "seq": next,
                                    "author": { "clientId": client_id, "userId": user_id, "login": login },
                                    "changes": changes,
                                }).to_string();
                                broadcast_except(&mut clients, &mut presence_dirty, doc_id, &client_id, &msg);
                                maybe_request_snapshot(&pool, doc_id, head_seq, &clients,
                                                       &mut last_snapshot_request).await;
                            }
                            Ok(Some(existing_seq)) => {
                                // Idempotent resubmit after reconnect: re-ack, no re-broadcast.
                                head_seq = head_seq.max(existing_seq);
                                ack(&clients, &client_id, doc_id, &client_op_id, existing_seq);
                            }
                            Err(e) => {
                                tracing::error!("doc {doc_id}: op insert failed: {e}");

                                // An INSERT that committed but failed on the way
                                // back would leave head_seq stale and wedge the
                                // doc on PK conflicts forever; re-read it.
                                if let Ok(s) = persist::head_seq(&pool, doc_id).await {
                                    head_seq = head_seq.max(s);
                                }

                                if let Some(c) = clients.get(&client_id) {
                                    let _ = c.tx.try_send(json!({
                                        "type": "error", "code": "internal",
                                        "docId": doc_id, "clientOpId": client_op_id,
                                    }).to_string());
                                }
                            }
                        }
                    }
                    DocMsg::Presence { client_id, state } => {
                        touch(&mut clients, &client_id);
                        if let Some(c) = clients.get_mut(&client_id) {
                            c.presence = Some(state.clone());
                            presence_dirty.insert(client_id, Some(state));
                        }
                    }
                    DocMsg::Reset { seq } => {
                        head_seq = head_seq.max(seq);
                        let msg = json!({ "type": "reset", "docId": doc_id, "seq": seq }).to_string();
                        broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg);
                    }
                    DocMsg::Resync { client_id } => {
                        touch(&mut clients, &client_id);
                        if let Some(c) = clients.get(&client_id) {
                            let tx = c.tx.clone();

                            // If even the resync can't be delivered, unregister
                            // so the client's next join_doc does a full catch-up
                            // instead of silently receiving baseless ops.
                            if !send_snapshot_catchup(&pool, &doc, head_seq, &tx).await
                            {
                                clients.remove(&client_id);
                                presence_dirty.insert(client_id.clone(), None);
                                let msg = json!({ "type": "peer_left", "docId": doc_id,
                                                  "clientId": client_id }).to_string();
                                broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg);
                            }
                        }
                    }
                }
            }
            _ = flush.tick() => {
                if last_snapshot_check.elapsed() >= Duration::from_secs(60)
                    .min(snapshot_fresh_interval())
                {
                    last_snapshot_check = Instant::now();
                    maybe_request_snapshot(&pool, doc_id, head_seq, &clients,
                                           &mut last_snapshot_request).await;
                }
                // Evict stale presence (client stopped refreshing but is still connected).
                let now = Instant::now();
                for (id, c) in clients.iter_mut() {
                    if c.presence.is_some() && now.duration_since(c.last_seen) > PRESENCE_STALE {
                        c.presence = None;
                        presence_dirty.insert(id.clone(), None);
                    }
                }
                if !presence_dirty.is_empty() {
                    let peers: serde_json::Map<String, Value> = presence_dirty.drain()
                        .map(|(id, state)| {
                            let entry = match (&state, clients.get(&id)) {
                                (Some(s), Some(c)) => json!({ "user": c.peer, "state": s }),
                                _ => Value::Null,
                            };
                            (id, entry)
                        })
                        .collect();
                    let msg = json!({ "type": "presence", "docId": doc_id, "peers": peers }).to_string();
                    let mut dirty = HashMap::new();
                    broadcast_all(&mut clients, &mut dirty, doc_id, &msg);
                    presence_dirty.extend(dirty);
                }
                if clients.is_empty() {
                    match empty_since {
                        // Never reap with mail pending: a Join already sitting in
                        // the mailbox would be dropped and the sender would keep
                        // a dead handle. Closing first makes any racing send fail
                        // loudly so the registry respawns.
                        Some(t) if t.elapsed() > REAP_AFTER => {
                            if !rx.is_empty() {
                                continue;
                            }
                            rx.close();
                            if !rx.is_empty() {
                                continue;
                            }
                            break;
                        }
                        None => empty_since = Some(Instant::now()),
                        _ => {}
                    }
                }
            }
        }
    }
    tracing::info!("doc actor {doc_id} stopped");
}

/// Returns true if the client was registered (doc_info + catch-up both landed).
#[allow(clippy::too_many_arguments)]
async fn handle_join(
    pool: &PgPool,
    doc: &Document,
    head_seq: i64,
    clients: &mut HashMap<String, ClientState>,
    peer: &PeerInfo,
    role: &str,
    since_seq: Option<i64>,
    tx: mpsc::Sender<String>,
) -> bool {
    let doc_id = doc.id;

    // A client id is namespaced by user id upstream, so a collision here means
    // the same user reconnecting — take over. A different user must never be
    // able to displace someone's ClientState.
    if let Some(existing) = clients.get(&peer.client_id) {
        if existing.peer.user_id != peer.user_id {
            let _ = tx.try_send(
                json!({ "type": "error", "code": "permission_denied", "docId": doc_id }).to_string(),
            );
            return false;
        }
    }

    let peers: Vec<&PeerInfo> = clients.values().map(|c| &c.peer).collect();
    let info = json!({
        "type": "doc_info", "docId": doc_id, "path": doc.path, "docType": doc.doc_type,
        "role": role, "headSeq": head_seq, "peers": peers,
    })
    .to_string();

    if tx.try_send(info).is_err() {
        tracing::warn!("doc {doc_id}: join for {} dropped (queue full)", peer.client_id);
        return false;
    }

    // Catch-up: op tail if fully retained, else snapshot + tail.
    let delivered = match since_seq {
        Some(since) if since <= head_seq => {
            let retained_from = persist::min_op_seq(pool, doc_id).await.ok().flatten();
            let covered = since >= head_seq || matches!(retained_from, Some(min) if since + 1 >= min);
            if covered {
                send_ops_tail(pool, doc_id, since, &tx).await
            } else {
                send_snapshot_catchup(pool, doc, head_seq, &tx).await
            }
        }
        Some(_) | None => send_snapshot_catchup(pool, doc, head_seq, &tx).await,
    };

    if !delivered {
        tracing::warn!("doc {doc_id}: catch-up for {} failed; not registering", peer.client_id);
        return false;
    }

    clients.insert(
        peer.client_id.clone(),
        ClientState {
            tx,
            peer: peer.clone(),
            role: role.to_string(),
            last_seen: Instant::now(),
            presence: None,
        },
    );

    true
}

fn ops_to_json(rows: Vec<persist::OpRow>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            json!({
                "seq": r.seq,
                "author": { "clientId": r.client_id, "userId": r.author_id },
                "changes": r.changes,
            })
        })
        .collect()
}

async fn send_ops_tail(pool: &PgPool, doc_id: Uuid, since: i64, tx: &mpsc::Sender<String>) -> bool {
    match persist::ops_since(pool, doc_id, since).await {
        Ok(rows) => {
            let ops = ops_to_json(rows);
            tx.try_send(
                json!({ "type": "ops", "docId": doc_id, "from": since + 1, "ops": ops }).to_string(),
            )
            .is_ok()
        }
        Err(e) => {
            tracing::error!("doc {doc_id}: ops tail load failed: {e}");
            false
        }
    }
}

async fn send_snapshot_catchup(
    pool: &PgPool,
    doc: &Document,
    _head: i64,
    tx: &mpsc::Sender<String>,
) -> bool {
    let doc_id = doc.id;
    match persist::latest_snapshot(pool, doc_id).await {
        Ok(Some((snap_seq, content))) => {
            let file = String::from_utf8_lossy(&content).into_owned();
            let then_ops = match persist::ops_since(pool, doc_id, snap_seq).await {
                Ok(rows) => ops_to_json(rows),
                Err(_) => vec![],
            };
            tx.try_send(
                json!({
                    "type": "snapshot", "docId": doc_id, "seq": snap_seq,
                    "file": file, "thenOps": then_ops,
                })
                .to_string(),
            )
            .is_ok()
        }
        Ok(None) => {
            let _ = tx.try_send(
                json!({ "type": "error", "code": "not_found", "docId": doc_id }).to_string(),
            );
            false
        }
        Err(e) => {
            tracing::error!("doc {doc_id}: snapshot load failed: {e}");
            false
        }
    }
}

fn touch(clients: &mut HashMap<String, ClientState>, client_id: &str) {
    if let Some(c) = clients.get_mut(client_id) {
        c.last_seen = Instant::now();
    }
}

fn ack(clients: &HashMap<String, ClientState>, client_id: &str, doc_id: Uuid, client_op_id: &str, seq: i64) {
    if let Some(c) = clients.get(client_id) {
        let _ = c.tx.try_send(
            json!({ "type": "ack", "docId": doc_id, "clientOpId": client_op_id, "seq": seq }).to_string(),
        );
    }
}

/// try_send to every client except `skip`.
///
/// A full queue drops only the *message* — the client stays registered so its
/// resync (and its acks) keep working; it notices the seq gap and asks for a
/// resync. Only a closed channel removes the client, and that removal is
/// announced like a normal leave so peers don't render ghost cursors.
fn broadcast_except(
    clients: &mut HashMap<String, ClientState>,
    presence_dirty: &mut HashMap<String, Option<Value>>,
    doc_id: Uuid,
    skip: &str,
    msg: &str,
) {
    let mut closed: Vec<String> = Vec::new();

    for (id, c) in clients.iter() {
        if id == skip {
            continue;
        }
        match c.tx.try_send(msg.to_string()) {
            Ok( () ) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!("client {id} is behind; dropping a frame (it will resync)");
                notify_desynced(&c.tx, doc_id);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => closed.push(id.clone()),
        }
    }

    reap_closed(clients, presence_dirty, doc_id, closed);
}

fn broadcast_all(
    clients: &mut HashMap<String, ClientState>,
    presence_dirty: &mut HashMap<String, Option<Value>>,
    doc_id: Uuid,
    msg: &str,
) {
    let mut closed: Vec<String> = Vec::new();

    for (id, c) in clients.iter() {
        match c.tx.try_send(msg.to_string()) {
            Ok( () ) => {}
            Err(mpsc::error::TrySendError::Full(_)) => notify_desynced(&c.tx, doc_id),
            Err(mpsc::error::TrySendError::Closed(_)) => closed.push(id.clone()),
        }
    }

    reap_closed(clients, presence_dirty, doc_id, closed);
}

/// Tell a client that fell behind to re-join with its last applied seq. Sent on
/// a task because its queue is full right now by definition.
fn notify_desynced(tx: &mpsc::Sender<String>, doc_id: Uuid) {
    let tx = tx.clone();
    tokio::spawn(async move {
        let _ = tx
            .send(json!({ "type": "error", "code": "desynced", "docId": doc_id }).to_string())
            .await;
    });
}

fn reap_closed(
    clients: &mut HashMap<String, ClientState>,
    presence_dirty: &mut HashMap<String, Option<Value>>,
    doc_id: Uuid,
    closed: Vec<String>,
) {
    for id in closed {
        clients.remove(&id);
        presence_dirty.insert(id.clone(), None);

        let msg = json!({ "type": "peer_left", "docId": doc_id, "clientId": id }).to_string();

        for c in clients.values() {
            let _ = c.tx.try_send(msg.clone());
        }
    }
}

async fn maybe_request_snapshot(
    pool: &PgPool,
    doc_id: Uuid,
    head_seq: i64,
    clients: &HashMap<String, ClientState>,
    last_request: &mut Instant,
) {
    if last_request.elapsed() < SNAPSHOT_REQUEST_COOLDOWN.min(snapshot_fresh_interval()) {
        return;
    }
    let snap_seq = persist::latest_snapshot_seq(pool, doc_id).await.unwrap_or(0);
    let lag = head_seq - snap_seq;
    if lag <= 0 {
        return;
    }
    // A big lag is a catch-up problem (join cost) and snapshots on the short
    // cooldown; a small one is only a freshness problem and waits the longer
    // interval.
    if lag <= SNAPSHOT_LAG_OPS && last_request.elapsed() < snapshot_fresh_interval() {
        return;
    }
    // Pick one editor deterministically (lowest clientId).
    let editor = clients
        .iter()
        .filter(|(_, c)| c.role == "editor")
        .min_by(|a, b| a.0.cmp(b.0));
    if let Some((_, c)) = editor {
        *last_request = Instant::now();
        let _ = c.tx.try_send(json!({ "type": "snapshot_request", "docId": doc_id }).to_string());
    }
}
