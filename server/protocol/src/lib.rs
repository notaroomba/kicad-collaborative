//! Wire protocol (v1) for KiCad Collaborative: JSON over one WebSocket at `/ws`.
//!
//! This crate is the single source of truth for the message shapes.  It is
//! consumed by the sync server and compiles unchanged to
//! `wasm32-unknown-unknown` for browser clients — no std-only or native-only
//! dependencies belong here.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTO_VERSION: u32 = 1;

/// Messages a client (KiCad editor or web viewer) sends to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[allow(non_camel_case_types)]
pub enum ClientMsg {
    hello {
        proto: u32,
        /// Bearer JWT.  Web clients may send "" and authenticate with the
        /// session cookie riding the WebSocket upgrade request instead.
        token: String,
        #[serde(default, rename = "clientId")]
        client_id: Option<String>,
        #[serde(default, rename = "linkToken")]
        link_token: Option<String>,
        #[serde(default)]
        client: Option<String>,
    },
    join_doc {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        #[serde(default, rename = "sinceSeq")]
        since_seq: Option<i64>,
    },
    leave_doc {
        #[serde(rename = "docId")]
        doc_id: Uuid,
    },
    op {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        #[serde(rename = "clientOpId")]
        client_op_id: String,
        #[serde(default, rename = "baseSeq")]
        base_seq: Option<i64>,
        changes: Value,
    },
    presence {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        state: Value,
    },
    resync {
        #[serde(rename = "docId")]
        doc_id: Uuid,
    },
}

/// A peer as described in `doc_info`, `peer_joined` and presence updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerUser {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub color: String,
}

/// One sequenced op as broadcast to peers and replayed in tails.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedOp {
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<PeerUser>,
    pub changes: Value,
}

/// Messages the server sends to clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[allow(non_camel_case_types)]
pub enum ServerMsg {
    hello_ok {
        #[serde(rename = "clientId")]
        client_id: String,
        color: String,
    },
    doc_info {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        #[serde(rename = "docType")]
        doc_type: String,
        path: String,
        role: String,
        #[serde(rename = "headSeq")]
        head_seq: i64,
        peers: Vec<PeerUser>,
    },
    ops {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        from: i64,
        ops: Vec<SequencedOp>,
    },
    snapshot {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        seq: i64,
        file: String,
        #[serde(rename = "thenOps")]
        then_ops: Vec<SequencedOp>,
    },
    op {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        seq: i64,
        author: PeerUser,
        changes: Value,
    },
    ack {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        #[serde(rename = "clientOpId")]
        client_op_id: String,
        seq: i64,
    },
    presence {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        peers: Value,
    },
    peer_joined {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        user: PeerUser,
    },
    peer_left {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        #[serde(rename = "clientId")]
        client_id: String,
    },
    snapshot_request {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        seq: i64,
    },
    reset {
        #[serde(rename = "docId")]
        doc_id: Uuid,
        seq: i64,
    },
    error {
        code: String,
        #[serde(rename = "docId", skip_serializing_if = "Option::is_none")]
        doc_id: Option<Uuid>,
    },
}

/// The wire form of one item change inside an op's `changes` array — the JSON
/// produced by KiCad's `ITEM_CHANGE::ToJson()` plus the collab extensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemChangeWire {
    /// Bare KIID of the top-level item.
    pub id: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
    /// "ADDED" | "REMOVED" | "MODIFIED" (upper-case on the wire).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<Value>,
    /// Self-contained s-expression payload for ADDED / whole-item replace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sexpr: Option<String>,
    /// Board items: net identity travels by name, not board-local number.
    #[serde(rename = "netName", skip_serializing_if = "Option::is_none")]
    pub net_name: Option<String>,
    /// Footprints: pad number -> net name.
    #[serde(rename = "padNets", skip_serializing_if = "Option::is_none")]
    pub pad_nets: Option<Value>,
    /// Schematic ops: project-relative sheet file the change belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_web_hello_parses() {
        // A browser client omits optional keys instead of sending nulls.
        let text = r#"{"type":"hello","proto":1,"token":"","clientId":"web-1"}"#;
        let msg: ClientMsg = serde_json::from_str(text).unwrap();
        assert!(matches!(msg, ClientMsg::hello { link_token: None, client: None, .. }));

        let op = r#"{"type":"op","docId":"64912f74-6834-4aa6-98ff-55c3faec0bbf","clientOpId":"web:1","changes":[]}"#;
        let msg: ClientMsg = serde_json::from_str(op).unwrap();
        assert!(matches!(msg, ClientMsg::op { base_seq: None, .. }));
    }

    #[test]
    fn client_hello_round_trips() {
        let text = r#"{"type":"hello","proto":1,"token":"t","clientId":"c-1","linkToken":null,"client":"kicad"}"#;
        let msg: ClientMsg = serde_json::from_str(text).unwrap();
        match &msg {
            ClientMsg::hello { proto, token, client_id, .. } => {
                assert_eq!(*proto, 1);
                assert_eq!(token, "t");
                assert_eq!(client_id.as_deref(), Some("c-1"));
            }
            _ => panic!("wrong variant"),
        }
        let back: ClientMsg =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        assert!(matches!(back, ClientMsg::hello { .. }));
    }

    #[test]
    fn server_ack_matches_wire_shape() {
        let msg = ServerMsg::ack {
            doc_id: Uuid::nil(),
            client_op_id: "c-1:7".into(),
            seq: 42,
        };
        let v: Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "ack");
        assert_eq!(v["clientOpId"], "c-1:7");
        assert_eq!(v["seq"], 42);
    }

    #[test]
    fn item_change_wire_round_trips() {
        let text = r#"{"id":"aa-bb","typeName":"PCB_TRACK","kind":"ADDED",
                       "sexpr":"(kicad_pcb)","netName":"GND","properties":[]}"#;
        let change: ItemChangeWire = serde_json::from_str(text).unwrap();
        assert_eq!(change.kind, "ADDED");
        assert_eq!(change.net_name.as_deref(), Some("GND"));
        let v: Value = serde_json::to_value(&change).unwrap();
        assert_eq!(v["typeName"], "PCB_TRACK");
        assert!(v.get("padNets").is_none());
    }
}
