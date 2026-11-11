//! Fan-out between server replicas.
//!
//! Every replica keeps its own in-memory actor for each document its clients have open
//! (doc_actor.rs).  What makes several replicas one server is that the things an actor
//! used to know only by itself now travel through Postgres:
//!
//! - **Ops** are ordered by the `ops` primary key `(doc_id, seq)`: a replica that tries to
//!   take a seq another replica already took gets a unique violation, catches up from the
//!   table and tries the next one.  A notification then tells the other replicas that the
//!   document moved, and each reads the new ops from the table and hands them to its own
//!   clients in seq order.
//! - **Presence, joins and leaves, comments, resets** and "somebody's access changed" are
//!   notifications that the receiving replica replays to its own clients.
//!
//! The transport is `LISTEN`/`NOTIFY` on one channel.  It needs nothing besides the
//! database every replica already shares, and a single replica pays one notification per
//! op for it.  Notifications are not durable, which is fine: ops are read from the table
//! (and re-read on a timer and after a reconnect), and everything else is ephemeral.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sqlx::postgres::PgListener;
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::doc_actor::DocMsg;
use crate::registry::Registry;

const CHANNEL: &str = "kc_relay";
/// NOTIFY refuses payloads of 8000 bytes or more; leave room for the envelope.
const INLINE_MAX: usize = 7000;
const HEARTBEAT: Duration = Duration::from_secs(10);
/// A replica that has been silent this long is gone (three missed heartbeats).
const REPLICA_GONE: Duration = Duration::from_secs(35);

pub struct Relay {
    /// This process, as the other replicas know it.
    pub replica: String,
    out: mpsc::UnboundedSender<Value>,
    /// The other replicas and when each was last heard.
    others: Mutex<HashMap<String, Instant>>,
    started: Instant,
}

impl Relay {
    /// A relay that is not connected to anything yet; `start` connects it.
    pub fn new() -> (Arc<Relay>, mpsc::UnboundedReceiver<Value>) {
        let (out, rx) = mpsc::unbounded_channel();
        let relay = Relay {
            replica: Uuid::new_v4().simple().to_string(),
            out,
            others: Mutex::new(HashMap::new()),
            started: Instant::now(),
        };
        (Arc::new(relay), rx)
    }

    /// Tell the other replicas something.  Never blocks and never fails the caller: a
    /// message that cannot be sent is one the others recover from by themselves.
    pub fn publish(&self, mut msg: Value) {
        msg["r"] = json!(self.replica);
        let _ = self.out.send(msg);
    }

    /// Whether anybody else might be listening.  Presence is published twenty times a
    /// second per busy document, so a lone replica skips it; right after start-up nobody
    /// has had the chance to say hello yet, so assume there is someone.
    pub fn others_alive(&self) -> bool {
        self.started.elapsed() < REPLICA_GONE || !self.others.lock().unwrap().is_empty()
    }

    fn heard(&self, replica: &str) {
        self.others.lock().unwrap().insert(replica.to_string(), Instant::now());
    }

    /// Forget replicas that stopped talking; returns them.
    fn expire(&self) -> Vec<String> {
        let mut others = self.others.lock().unwrap();
        let gone: Vec<String> = others
            .iter()
            .filter(|(_, seen)| seen.elapsed() > REPLICA_GONE)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &gone {
            others.remove(id);
        }
        gone
    }
}

/// Start the publisher, the listener and the heartbeat.
pub fn start(
    relay: Arc<Relay>,
    mut outbox: mpsc::UnboundedReceiver<Value>,
    pool: PgPool,
    registry: Arc<Registry>,
    access_epoch: Arc<AtomicU64>,
) {
    // Publisher: one task, so notifications leave in the order they were published.
    {
        let pool = pool.clone();
        tokio::spawn(async move {
            while let Some(msg) = outbox.recv().await {
                if let Err(e) = send(&pool, &msg).await {
                    tracing::warn!("relay: publish failed: {e}");
                }
            }
        });
    }

    // Heartbeat, and the sweep of what the heartbeat makes obsolete.
    {
        let relay = relay.clone();
        let registry = registry.clone();
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(HEARTBEAT);
            loop {
                tick.tick().await;
                relay.publish(json!({ "t": "hb" }));
                for replica in relay.expire() {
                    tracing::info!("relay: replica {replica} is gone");
                    for tx in registry.all() {
                        let _ = tx.send(DocMsg::ReplicaGone { replica: replica.clone() }).await;
                    }
                }
                let _ = sqlx::query("DELETE FROM relay_overflow WHERE created < now() - interval '1 minute'")
                    .execute(&pool)
                    .await;
            }
        });
    }

    // Listener.
    tokio::spawn(async move {
        loop {
            let mut listener = match PgListener::connect_with(&pool).await {
                Ok(l) => l,
                Err(e) => {
                    tracing::warn!("relay: cannot listen: {e}; retrying");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            if let Err(e) = listener.listen(CHANNEL).await {
                tracing::warn!("relay: LISTEN failed: {e}; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            tracing::info!("relay: replica {} listening", relay.replica);

            loop {
                match listener.try_recv().await {
                    Ok(Some(n)) => {
                        if let Some(msg) = open(&pool, n.payload()).await {
                            dispatch(&relay, &registry, &access_epoch, msg).await;
                        }
                    }
                    // The connection dropped and was re-established: whatever was
                    // notified in between is lost.  Ops are in the table, so have every
                    // open document look.
                    Ok(None) => {
                        tracing::warn!("relay: listener reconnected; catching documents up");
                        for tx in registry.all() {
                            let _ = tx.send(DocMsg::Relay(json!({ "t": "op" }))).await;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("relay: listener failed: {e}; reconnecting");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        break;
                    }
                }
            }
        }
    });
}

async fn send(pool: &PgPool, msg: &Value) -> sqlx::Result<()> {
    let mut text = msg.to_string();
    if text.len() > INLINE_MAX {
        let (id,): (i64,) = sqlx::query_as("INSERT INTO relay_overflow (payload) VALUES ($1) RETURNING id")
            .bind(&text)
            .fetch_one(pool)
            .await?;
        text = json!({ "r": msg["r"], "o": id }).to_string();
    }
    sqlx::query("SELECT pg_notify($1, $2)").bind(CHANNEL).bind(text).execute(pool).await?;
    Ok(())
}

/// The message a notification stands for.
async fn open(pool: &PgPool, payload: &str) -> Option<Value> {
    let msg: Value = serde_json::from_str(payload).ok()?;
    let Some(id) = msg.get("o").and_then(Value::as_i64) else {
        return Some(msg);
    };
    let row: Option<(String,)> = sqlx::query_as("SELECT payload FROM relay_overflow WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()?;
    serde_json::from_str(&row?.0).ok()
}

async fn dispatch(relay: &Relay, registry: &Registry, access_epoch: &AtomicU64, msg: Value) {
    let Some(from) = msg.get("r").and_then(Value::as_str) else { return };
    if from == relay.replica {
        return;
    }
    relay.heard(from);

    match msg.get("t").and_then(Value::as_str) {
        Some("hb") => {}
        Some("access") => {
            access_epoch.fetch_add(1, Ordering::Relaxed);
        }
        Some(_) => {
            let doc_id = msg.get("d").and_then(Value::as_str).and_then(|d| Uuid::parse_str(d).ok());
            // Only a document somebody here has open cares.
            if let Some(tx) = doc_id.and_then(|d| registry.existing(d)) {
                let _ = tx.send(DocMsg::Relay(msg)).await;
            }
        }
        None => {}
    }
}
