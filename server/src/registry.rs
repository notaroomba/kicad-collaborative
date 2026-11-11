use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::doc_actor::{self, DocMsg};
use crate::persist::Document;
use crate::relay::Relay;

/// One in-memory actor per document open on this replica. Actors exit after
/// 60s with no clients; a dead handle is respawned lazily on next use.
pub struct Registry {
    docs: Mutex<HashMap<Uuid, mpsc::Sender<DocMsg>>>,
    relay: Arc<Relay>,
}

impl Registry {
    pub fn new(relay: Arc<Relay>) -> Self {
        Registry { docs: Mutex::new(HashMap::new()), relay }
    }

    /// The live actor for a doc, if one is loaded. Used to push server-initiated
    /// messages (history restore) without waking an idle document.
    pub fn existing(&self, doc_id: Uuid) -> Option<mpsc::Sender<DocMsg>> {
        let docs = self.docs.lock().unwrap();
        docs.get(&doc_id).filter(|tx| !tx.is_closed()).cloned()
    }

    /// Every live actor (and a chance to forget the dead ones).
    pub fn all(&self) -> Vec<mpsc::Sender<DocMsg>> {
        let mut docs = self.docs.lock().unwrap();
        docs.retain(|_, tx| !tx.is_closed());
        docs.values().cloned().collect()
    }

    pub fn get_or_spawn(&self, pool: &PgPool, doc: &Document) -> mpsc::Sender<DocMsg> {
        let mut docs = self.docs.lock().unwrap();
        if let Some(tx) = docs.get(&doc.id) {
            if !tx.is_closed() {
                return tx.clone();
            }
        }
        let tx = doc_actor::spawn(pool.clone(), doc.clone(), self.relay.clone());
        docs.insert(doc.id, tx.clone());
        tx
    }
}
