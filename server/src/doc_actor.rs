use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use crate::persist::{self, Document};
use crate::relay::Relay;

const PRESENCE_FLUSH: Duration = Duration::from_millis(50);
const PRESENCE_STALE: Duration = Duration::from_secs(30);
const REAP_AFTER: Duration = Duration::from_secs(60);
const SNAPSHOT_LAG_OPS: i64 = 500;
const SNAPSHOT_REQUEST_COOLDOWN: Duration = Duration::from_secs(60);
/// With other replicas around, how often an open document checks the op table for ops a
/// lost notification would have announced.
const REMOTE_POLL: Duration = Duration::from_secs(3);
/// How many times an op is retried at the next seq when other replicas keep taking it.
const SEQ_RETRIES: usize = 50;

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerInfo {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub login: String,
    pub name: String,
    pub color: String,
    /// What kind of client this is ("web" for the browser editor, otherwise a desktop
    /// editor).  Desktop clients use it to decide who refills zones after a browser edit.
    #[serde(rename = "client", default)]
    pub kind: String,
}

#[derive(Debug)]
pub enum DocMsg {
    Join {
        peer: PeerInfo,
        role: String,
        since_seq: Option<i64>,
        /// Whether this client can answer a `snapshot_request` — see `maybe_request_snapshot`.
        can_snapshot: bool,
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
    /// A comment changed via REST; relay to every connected client.
    Comment {
        payload: Value,
    },
    Resync {
        client_id: String,
    },
    /// History restore: state was replaced out from under everyone, so tell
    /// every client to drop what it has and re-fetch.
    Reset {
        seq: i64,
    },
    /// Something about the project changed that open editors show (its versions, its
    /// branches): hand every client the message as it is.
    Notice {
        payload: Value,
    },
    /// Something is about to read the document's file (a GitHub push or pull): ask a
    /// client that can write one for a snapshot now, whatever the cooldown says.
    SnapshotNow,
    /// A client asks a desktop editor in the document to do something (fill zones).
    Request {
        client_id: String,
        action: String,
    },
    /// Something another replica published about this document (relay.rs).
    Relay(Value),
    /// A replica stopped answering: its clients are no longer in the document.
    ReplicaGone {
        replica: String,
    },
}

/// Somebody in the document through another replica.
/// Whether the user may still edit the document's project, asked of the database.
async fn still_editor(pool: &PgPool, user_id: i64, doc_id: Uuid) -> bool {
    let project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM documents WHERE id = $1")
        .bind(doc_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    match project {
        Some(p) => matches!(persist::effective_role(pool, user_id, p).await, Ok(Some(r)) if r == "editor"),
        None => false,
    }
}

struct RemotePeer {
    peer: PeerInfo,
    replica: String,
    presence: Option<Value>,
    /// Whether it can be asked to do desktop work: an editor that is a desktop client.
    capable: bool,
}

struct ClientState {
    tx: mpsc::Sender<String>,
    peer: PeerInfo,
    role: String,
    last_seen: Instant,
    /// Latest presence state; None until the client sends one.
    presence: Option<Value>,
    /// Whether this client can answer a `snapshot_request`.
    can_snapshot: bool,
}

pub fn spawn(pool: PgPool, doc: Document, relay: Arc<Relay>) -> mpsc::Sender<DocMsg> {
    let (tx, rx) = mpsc::channel(1024);
    tokio::spawn(run(pool, doc, relay, rx));
    tx
}

async fn run(pool: PgPool, doc: Document, relay: Arc<Relay>, mut rx: mpsc::Receiver<DocMsg>) {
    let doc_id = doc.id;
    let mut head_seq = match persist::head_seq(&pool, doc_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("doc {doc_id}: failed to load head seq: {e}");
            return;
        }
    };

    let mut clients: HashMap<String, ClientState> = HashMap::new();
    // People in the document through other replicas, and which of our own clients the
    // other replicas have been told about.
    let mut remote: HashMap<String, RemotePeer> = HashMap::new();
    let mut announced: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut last_remote_poll = Instant::now();
    // Ask who is already here elsewhere.
    relay.publish(json!({ "t": "who", "d": doc_id }));
    // clientId -> Some(state) = changed, None = left. Flushed every 50ms.
    let mut presence_dirty: HashMap<String, Option<Value>> = HashMap::new();
    let mut empty_since = Some(Instant::now());
    let mut last_snapshot_request = Instant::now() - SNAPSHOT_REQUEST_COOLDOWN;
    let folding = Arc::new(FoldState::default());
    let mut last_snapshot_check = Instant::now();
    let mut flush = tokio::time::interval(PRESENCE_FLUSH);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!("doc actor {doc_id} ({}) started at seq {head_seq}", doc.path);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    DocMsg::Join { peer, role, since_seq, can_snapshot, tx } => {
                        // A half-delivered join (doc_info or catch-up dropped)
                        // would leave the client receiving ops with no base
                        // state, so it is all-or-nothing: on failure the client
                        // is not registered and its join simply times out.
                        if handle_join(&pool, &doc, head_seq, &mut clients, &remote, &peer, &role,
                                       since_seq, can_snapshot, tx).await
                        {
                            // Announce to everyone else and share existing presence with the joiner.
                            let joined = json!({ "type": "peer_joined", "docId": doc_id, "peer": peer }).to_string();
                            broadcast_except(&mut clients, &mut presence_dirty, doc_id, &peer.client_id, &joined);
                            let existing: serde_json::Map<String, Value> = clients.iter()
                                .filter(|( id, c )| **id != peer.client_id && c.presence.is_some())
                                .map(|( id, c )| (id.clone(), json!({ "user": c.peer, "state": c.presence })))
                                .chain(remote.iter()
                                    .filter(|( _, r )| r.presence.is_some())
                                    .map(|( id, r )| (id.clone(), json!({ "user": r.peer, "state": r.presence }))))
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
                        // Another replica may take the seq we were about to use: the
                        // table's primary key refuses ours, we hand our clients what
                        // they missed and try the next one.
                        let mut attempt = 0;
                        let outcome = loop {
                            // With other replicas writing, queue for the document's
                            // sequencing lock and bring ourselves up to the head first.
                            let mut locked = None;
                            if relay.others_alive() {
                                match persist::lock_sequence(&pool, doc_id).await {
                                    Ok((tx, db_head)) => {
                                        if db_head > head_seq {
                                            catch_up(&pool, doc_id, &mut head_seq, &mut clients, &mut presence_dirty).await;
                                        }
                                        locked = Some(tx);
                                    }
                                    Err(e) => tracing::warn!("doc {doc_id}: sequencing lock failed, writing without it: {e}"),
                                }
                            }
                            let next = head_seq + 1;
                            let inserted = match locked {
                                Some(mut tx) => {
                                    match persist::insert_op_on(&mut tx, doc_id, next, user_id, &client_id, &client_op_id, base_seq, &changes).await {
                                        Ok(dup) => tx.commit().await.map(|_| dup),
                                        Err(e) => Err(e),
                                    }
                                }
                                None => persist::insert_op(&pool, doc_id, next, user_id, &client_id, &client_op_id, base_seq, &changes).await,
                            };
                            match inserted {
                                Err(e) if persist::is_seq_taken(&e) && attempt < SEQ_RETRIES => {
                                    attempt += 1;
                                    let before = head_seq;
                                    catch_up(&pool, doc_id, &mut head_seq, &mut clients, &mut presence_dirty).await;
                                    if head_seq == before {
                                        // The seq is taken by something we cannot read as
                                        // an op (a restore's snapshot): move past it.
                                        head_seq = persist::head_seq(&pool, doc_id).await.unwrap_or(head_seq).max(head_seq);
                                    }
                                }
                                other => break other.map(|dup| (next, dup)),
                            }
                        };
                        match outcome {
                            Ok((next, None)) => {
                                head_seq = next;
                                ack(&clients, &client_id, doc_id, &client_op_id, next);
                                let kind = clients.get(&client_id).map(|c| c.peer.kind.clone()).unwrap_or_default();
                                let msg = json!({
                                    "type": "op", "docId": doc_id, "seq": next,
                                    "author": { "clientId": client_id, "userId": user_id, "login": login, "client": kind },
                                    "changes": changes,
                                }).to_string();
                                broadcast_except(&mut clients, &mut presence_dirty, doc_id, &client_id, &msg);
                                relay.publish(json!({ "t": "op", "d": doc_id, "seq": next }));
                                maybe_request_snapshot(&pool, &doc, head_seq, &clients, &folding,
                                                       &mut last_snapshot_request).await;
                            }
                            Ok((_, Some(existing_seq))) => {
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
                    DocMsg::Comment { payload } => {
                        let msg = json!({ "type": "comment", "docId": doc_id,
                                          "comment": payload }).to_string();
                        broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg);
                    }
                    DocMsg::Reset { seq } => {
                        head_seq = head_seq.max(seq);
                        let msg = json!({ "type": "reset", "docId": doc_id, "seq": seq }).to_string();
                        broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg);
                    }
                    DocMsg::Notice { payload } => {
                        broadcast_all(&mut clients, &mut presence_dirty, doc_id, &payload.to_string());
                    }
                    DocMsg::SnapshotNow => {
                        request_snapshot_now(&clients, doc_id, &mut last_snapshot_request);
                        if !clients.values().any(|c| c.role == "editor" && c.can_snapshot) {
                            start_fold(&pool, &doc, head_seq, &folding);
                        }
                    }
                    DocMsg::Request { client_id, action } => {
                        touch(&mut clients, &client_id);
                        let from = clients.get(&client_id).map(|c| c.peer.clone());
                        let out = json!({ "type": "request", "docId": doc_id, "action": action, "from": from }).to_string();
                        // A desktop editor here, else one on another replica, else nobody.
                        // The role an actor holds for a client is the one it joined with, so
                        // the choice is checked against the database: a desktop whose owner
                        // was demoted since would have its fill refused.
                        let mut desktops: Vec<_> = clients.iter()
                            .filter(|(id, c)| **id != client_id && c.role == "editor" && c.can_snapshot)
                            .collect();
                        desktops.sort_by(|a, b| a.0.cmp(b.0));
                        let mut local = None;
                        for (_, c) in desktops {
                            if still_editor(&pool, c.peer.user_id, doc_id).await {
                                local = Some(c);
                                break;
                            }
                        }
                        if let Some(c) = local {
                            let _ = c.tx.try_send(out);
                        } else if let Some(id) = remote.iter().filter(|(_, r)| r.capable).map(|(id, _)| id).min() {
                            relay.publish(json!({ "t": "request", "d": doc_id, "to": id, "action": action, "from": from }));
                        } else if let Some(c) = clients.get(&client_id) {
                            let _ = c.tx.try_send(json!({
                                "type": "error", "code": "no_desktop", "docId": doc_id, "action": action,
                            }).to_string());
                        }
                    }
                    DocMsg::Relay(msg) => {
                        match msg.get("t").and_then(Value::as_str).unwrap_or("") {
                            "request" => {
                                let to = msg["to"].as_str().and_then(|id| clients.get(id));
                                let ok = match to {
                                    Some(c) => still_editor(&pool, c.peer.user_id, doc_id).await,
                                    None => false,
                                };
                                if let Some(c) = to.filter(|_| ok) {
                                    let _ = c.tx.try_send(json!({
                                        "type": "request", "docId": doc_id, "action": msg["action"], "from": msg["from"],
                                    }).to_string());
                                }
                            }
                            "op" => {
                                catch_up(&pool, doc_id, &mut head_seq, &mut clients, &mut presence_dirty).await;
                            }
                            "presence" => {
                                if let Some(peers) = msg.get("peers").and_then(Value::as_object) {
                                    let from = msg["r"].as_str().unwrap_or("").to_string();
                                    for (id, entry) in peers {
                                        if clients.contains_key(id) {
                                            continue;
                                        }
                                        match (entry.get("state"), entry.get("user")) {
                                            (Some(state), Some(user)) => {
                                                if let Some(r) = remote.get_mut(id) {
                                                    r.presence = Some(state.clone());
                                                } else if let Ok(peer) = serde_json::from_value::<PeerInfo>(user.clone()) {
                                                    // A join we never heard of (we started later).
                                                    let joined = json!({ "type": "peer_joined", "docId": doc_id, "peer": peer }).to_string();
                                                    broadcast_all(&mut clients, &mut presence_dirty, doc_id, &joined);
                                                    remote.insert(id.clone(), RemotePeer { peer, replica: from.clone(), presence: Some(state.clone()), capable: false });
                                                }
                                            }
                                            _ => {
                                                if let Some(r) = remote.get_mut(id) {
                                                    r.presence = None;
                                                }
                                            }
                                        }
                                    }
                                    let out = json!({ "type": "presence", "docId": doc_id, "peers": peers }).to_string();
                                    broadcast_all(&mut clients, &mut presence_dirty, doc_id, &out);
                                }
                            }
                            "joined" => {
                                if let Ok(peer) = serde_json::from_value::<PeerInfo>(msg["peer"].clone()) {
                                    if !clients.contains_key(&peer.client_id) {
                                        let joined = json!({ "type": "peer_joined", "docId": doc_id, "peer": peer }).to_string();
                                        broadcast_all(&mut clients, &mut presence_dirty, doc_id, &joined);
                                        remote.insert(peer.client_id.clone(), RemotePeer {
                                            peer, replica: msg["r"].as_str().unwrap_or("").to_string(), presence: None,
                                            capable: msg["capable"].as_bool().unwrap_or(false),
                                        });
                                    }
                                }
                            }
                            "left" => {
                                if let Some(id) = msg.get("clientId").and_then(Value::as_str) {
                                    // Only the replica that holds a client can say it left: the
                                    // same person reconnecting through another replica is
                                    // announced there first, and this must not undo that.
                                    let theirs = remote.get(id).is_some_and(|r| Some(r.replica.as_str()) == msg["r"].as_str());
                                    if theirs {
                                        remote.remove(id);
                                        remote_left(&mut clients, &mut presence_dirty, doc_id, id);
                                    }
                                }
                            }
                            "who" => {
                                if !clients.is_empty() {
                                    let roster: Vec<Value> = clients.values()
                                        .map(|c| json!({ "peer": c.peer, "presence": c.presence,
                                                         "capable": c.role == "editor" && c.can_snapshot }))
                                        .collect();
                                    relay.publish(json!({ "t": "roster", "d": doc_id, "to": msg["r"], "peers": roster }));
                                }
                            }
                            "roster" => {
                                if msg["to"].as_str() == Some(relay.replica.as_str()) {
                                    let from = msg["r"].as_str().unwrap_or("").to_string();
                                    for entry in msg["peers"].as_array().cloned().unwrap_or_default() {
                                        let Ok(peer) = serde_json::from_value::<PeerInfo>(entry["peer"].clone()) else { continue };
                                        if clients.contains_key(&peer.client_id) {
                                            continue;
                                        }
                                        let presence = Some(entry["presence"].clone()).filter(|p| !p.is_null());
                                        if !remote.contains_key(&peer.client_id) {
                                            let joined = json!({ "type": "peer_joined", "docId": doc_id, "peer": peer }).to_string();
                                            broadcast_all(&mut clients, &mut presence_dirty, doc_id, &joined);
                                        }
                                        if let Some(state) = &presence {
                                            let out = json!({ "type": "presence", "docId": doc_id,
                                                              "peers": { peer.client_id.clone(): { "user": peer, "state": state } } }).to_string();
                                            broadcast_all(&mut clients, &mut presence_dirty, doc_id, &out);
                                        }
                                        let capable = entry["capable"].as_bool().unwrap_or(false);
                                        remote.insert(peer.client_id.clone(), RemotePeer { peer, replica: from.clone(), presence, capable });
                                    }
                                }
                            }
                            "comment" => {
                                let out = json!({ "type": "comment", "docId": doc_id, "comment": msg["comment"] }).to_string();
                                broadcast_all(&mut clients, &mut presence_dirty, doc_id, &out);
                            }
                            "reset" => {
                                let seq = msg["seq"].as_i64().unwrap_or(0);
                                head_seq = head_seq.max(seq);
                                let out = json!({ "type": "reset", "docId": doc_id, "seq": seq }).to_string();
                                broadcast_all(&mut clients, &mut presence_dirty, doc_id, &out);
                            }
                            "notice" => {
                                broadcast_all(&mut clients, &mut presence_dirty, doc_id, &msg["payload"].to_string());
                            }
                            "snapshot_now" => {
                                request_snapshot_now(&clients, doc_id, &mut last_snapshot_request);
                            }
                            _ => {}
                        }
                    }
                    DocMsg::ReplicaGone { replica } => {
                        let gone: Vec<String> = remote.iter()
                            .filter(|(_, r)| r.replica == replica)
                            .map(|(id, _)| id.clone())
                            .collect();
                        for id in gone {
                            remote.remove(&id);
                            remote_left(&mut clients, &mut presence_dirty, doc_id, &id);
                        }
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
                // Notifications are not durable; the op table is.  While other replicas
                // exist, look at it now and then so a lost one costs seconds, not a resync.
                if !clients.is_empty() && relay.others_alive() && last_remote_poll.elapsed() >= REMOTE_POLL {
                    last_remote_poll = Instant::now();
                    if persist::head_seq(&pool, doc_id).await.is_ok_and(|h| h > head_seq) {
                        catch_up(&pool, doc_id, &mut head_seq, &mut clients, &mut presence_dirty).await;
                    }
                }
                if last_snapshot_check.elapsed() >= Duration::from_secs(60)
                    .min(snapshot_fresh_interval())
                {
                    last_snapshot_check = Instant::now();
                    maybe_request_snapshot(&pool, &doc, head_seq, &clients, &folding,
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
                    if relay.others_alive() {
                        relay.publish(json!({ "t": "presence", "d": doc_id, "peers": peers }));
                    }
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
                            // Everyone has left: what they did since the last snapshot becomes one, so the
                            // next open (and every reader of the stored file) starts from the design as it is.
                            if persist::latest_snapshot_seq(&pool, doc_id).await.is_ok_and(|s| s < head_seq) {
                                start_fold(&pool, &doc, head_seq, &folding);
                            }
                            break;
                        }
                        None => empty_since = Some(Instant::now()),
                        _ => {}
                    }
                }
            }
        }

        // Keep the other replicas' picture of who is here in step with ours, however a
        // client came or went (a join, a leave, a closed socket found while broadcasting).
        for (id, c) in clients.iter() {
            if announced.insert(id.clone()) {
                relay.publish(json!({ "t": "joined", "d": doc_id, "peer": c.peer,
                                      "capable": c.role == "editor" && c.can_snapshot }));
            }
        }
        if announced.len() != clients.len() {
            announced.retain(|id| {
                let here = clients.contains_key(id);
                if !here {
                    relay.publish(json!({ "t": "left", "d": doc_id, "clientId": id }));
                }
                here
            });
        }
    }
    for id in announced {
        relay.publish(json!({ "t": "left", "d": doc_id, "clientId": id }));
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
    remote: &HashMap<String, RemotePeer>,
    peer: &PeerInfo,
    role: &str,
    since_seq: Option<i64>,
    can_snapshot: bool,
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

    // Load the catch-up *before* announcing the join.  doc_info is what tells a client it is
    // live, so sending it and then failing to deliver the base state leaves that client
    // convinced it is in the session while the actor never registered it: its ops are still
    // accepted and broadcast to everyone else, but it never receives anything again, and on
    // the desktop the first seq gap latches a resync that can never be answered.
    let catchup = match since_seq {
        Some(since) if since <= head_seq => {
            let retained_from = persist::min_op_seq(pool, doc_id).await.ok().flatten();
            let covered = since >= head_seq || matches!(retained_from, Some(min) if since + 1 >= min);
            // A restore or a merge that replaced the document since then cannot be
            // caught up op by op: the client's base is no longer the document's.
            if covered && !crate::versions::reset_after(pool, doc_id, since).await {
                load_ops_tail(pool, doc_id, since).await
            } else {
                load_snapshot_catchup(pool, doc).await
            }
        }
        Some(_) | None => load_snapshot_catchup(pool, doc).await,
    };

    let Some(catchup) = catchup else {
        tracing::warn!("doc {doc_id}: no catch-up for {}; not registering", peer.client_id);
        let _ = tx.try_send(
            json!({ "type": "error", "code": "not_found", "docId": doc_id }).to_string(),
        );
        return false;
    };

    // Room for both frames, checked before either goes out: nothing else writes to this
    // client while we are here, so this is what makes the join all-or-nothing.
    if tx.capacity() < 2 {
        tracing::warn!("doc {doc_id}: join for {} dropped (queue full)", peer.client_id);
        return false;
    }

    let peers: Vec<&PeerInfo> = clients
        .values()
        .map(|c| &c.peer)
        .chain(remote.values().map(|r| &r.peer))
        .filter(|p| p.client_id != peer.client_id)
        .collect();
    let info = json!({
        "type": "doc_info", "docId": doc_id, "path": doc.path, "docType": doc.doc_type,
        "role": role, "headSeq": head_seq, "peers": peers,
    })
    .to_string();

    if tx.try_send(info).is_err() || tx.try_send(catchup).is_err() {
        tracing::warn!("doc {doc_id}: join for {} dropped mid-send", peer.client_id);
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
            can_snapshot,
        },
    );

    true
}

fn ops_to_json(rows: Vec<persist::OpRow>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            json!({
                "seq": r.seq,
                "author": { "clientId": r.client_id, "userId": r.author_id, "login": r.login },
                "changes": r.changes,
            })
        })
        .collect()
}

/// Hand our clients the ops other replicas committed since `head_seq`, in order.
async fn catch_up(
    pool: &PgPool,
    doc_id: Uuid,
    head_seq: &mut i64,
    clients: &mut HashMap<String, ClientState>,
    presence_dirty: &mut HashMap<String, Option<Value>>,
) {
    let rows = match persist::ops_since(pool, doc_id, *head_seq).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("doc {doc_id}: catch-up failed: {e}");
            return;
        }
    };
    for r in rows {
        *head_seq = (*head_seq).max(r.seq);
        // The author's own replica acked it; here it is somebody else's op to everyone,
        // except a client that wrote it through the other replica and has since
        // reconnected to this one.
        let msg = json!({
            "type": "op", "docId": doc_id, "seq": r.seq,
            "author": { "clientId": r.client_id, "userId": r.author_id, "login": r.login },
            "changes": r.changes,
        })
        .to_string();
        let author = r.client_id.clone();
        broadcast_except(clients, presence_dirty, doc_id, &author, &msg);
    }
}

/// Somebody on another replica left: say so to our clients and clear their cursor.
fn remote_left(
    clients: &mut HashMap<String, ClientState>,
    presence_dirty: &mut HashMap<String, Option<Value>>,
    doc_id: Uuid,
    client_id: &str,
) {
    let left = json!({ "type": "peer_left", "docId": doc_id, "clientId": client_id }).to_string();
    broadcast_all(clients, presence_dirty, doc_id, &left);
    let gone = json!({ "type": "presence", "docId": doc_id, "peers": { client_id: Value::Null } }).to_string();
    broadcast_all(clients, presence_dirty, doc_id, &gone);
}

/// Ask one of our clients that can write the real file for a snapshot.
fn request_snapshot_now(clients: &HashMap<String, ClientState>, doc_id: Uuid, last_request: &mut Instant) {
    let editor = clients
        .iter()
        .filter(|(_, c)| c.role == "editor" && c.can_snapshot)
        .min_by(|a, b| a.0.cmp(b.0));
    if let Some((_, c)) = editor {
        *last_request = Instant::now();
        let _ = c.tx.try_send(json!({ "type": "snapshot_request", "docId": doc_id }).to_string());
    }
}

/// The `ops` tail frame, or None when it could not be loaded.
async fn load_ops_tail(pool: &PgPool, doc_id: Uuid, since: i64) -> Option<String> {
    match persist::ops_since(pool, doc_id, since).await {
        Ok(rows) => Some(
            json!({ "type": "ops", "docId": doc_id, "from": since + 1, "ops": ops_to_json(rows) })
                .to_string(),
        ),
        Err(e) => {
            tracing::error!("doc {doc_id}: ops tail load failed: {e}");
            None
        }
    }
}

/// The `snapshot` frame (snapshot + the ops since it), or None when there is nothing to send.
async fn load_snapshot_catchup(pool: &PgPool, doc: &Document) -> Option<String> {
    let doc_id = doc.id;
    match persist::latest_snapshot(pool, doc_id).await {
        Ok(Some((snap_seq, content))) => {
            let file = String::from_utf8_lossy(&content).into_owned();
            let then_ops = match persist::ops_since(pool, doc_id, snap_seq).await {
                Ok(rows) => ops_to_json(rows),
                Err(_) => vec![],
            };
            Some(
                json!({
                    "type": "snapshot", "docId": doc_id, "seq": snap_seq,
                    "file": file, "thenOps": then_ops,
                })
                .to_string(),
            )
        }
        Ok(None) => None,
        Err(e) => {
            tracing::error!("doc {doc_id}: snapshot load failed: {e}");
            None
        }
    }
}

async fn send_snapshot_catchup(
    pool: &PgPool,
    doc: &Document,
    _head: i64,
    tx: &mpsc::Sender<String>,
) -> bool {
    match load_snapshot_catchup(pool, doc).await {
        Some(frame) => tx.try_send(frame).is_ok(),
        None => {
            let _ = tx.try_send(
                json!({ "type": "error", "code": "not_found", "docId": doc.id }).to_string(),
            );
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

/// A document's folding: whether one is running, and the head at which the last one was refused.
#[derive(Default)]
struct FoldState {
    busy: AtomicBool,
    refused_at: AtomicI64,
}

/// Fold the journal into a snapshot on the server (compact.rs), one fold of a document at a time.
fn start_fold(pool: &PgPool, doc: &Document, head_seq: i64, folding: &Arc<FoldState>) {
    if !crate::compact::foldable(&doc.doc_type) {
        return;
    }
    // A journal that could not be folded is not tried again on every check: only once it
    // has grown by another batch (an edit since may be what makes it foldable).
    let refused = folding.refused_at.load(Ordering::Acquire);
    if refused > 0 && head_seq < refused + SNAPSHOT_LAG_OPS {
        return;
    }
    if folding.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    let (pool, doc, folding) = (pool.clone(), doc.clone(), folding.clone());
    tokio::spawn(async move {
        match crate::compact::fold(&pool, &doc).await {
            Ok(Some(seq)) => {
                folding.refused_at.store(0, Ordering::Release);
                tracing::info!(doc = %doc.id, seq, "journal folded into a snapshot");
            }
            Ok(None) => {}
            // The document stays snapshot + ops, which is correct.
            Err(why) => {
                tracing::warn!(doc = %doc.id, "journal not folded: {why}");
                folding.refused_at.store(head_seq.max(1), Ordering::Release);
            }
        }
        folding.busy.store(false, Ordering::Release);
    });
}

async fn maybe_request_snapshot(
    pool: &PgPool,
    doc: &Document,
    head_seq: i64,
    clients: &HashMap<String, ClientState>,
    folding: &Arc<FoldState>,
    last_request: &mut Instant,
) {
    let doc_id = doc.id;
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
    // Pick one editor deterministically (lowest clientId) among the clients that can actually
    // produce a snapshot.  The browser editor cannot: its reader keeps only the items it knows
    // how to draw and drops the header, title block, sheet/symbol instances and embedded files,
    // so a file written from it would be a lossy replacement for the real document.  Asking it
    // anyway is worse than not asking — the request is dropped, the cooldown is stamped, and
    // the doc simply stops producing snapshots for as long as that client sorts lowest.
    let editor = clients
        .iter()
        .filter(|(_, c)| c.role == "editor" && c.can_snapshot)
        .min_by(|a, b| a.0.cmp(b.0));
    if let Some((_, c)) = editor {
        *last_request = Instant::now();
        let _ = c.tx.try_send(json!({ "type": "snapshot_request", "docId": doc_id }).to_string());
    } else {
        // Nobody here can write the file (browsers, the tools): the server folds the journal itself.
        *last_request = Instant::now();
        start_fold(pool, doc, head_seq, folding);
    }
}
