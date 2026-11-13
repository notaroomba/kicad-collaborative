//! Folding a document's journal into a new snapshot when no desktop editor is there to
//! write one.
//!
//! A document is a snapshot (a whole KiCad file) plus the ops made since.  Desktop
//! editors answer `snapshot_request` with their file; the browser editor and the tools
//! cannot (their reader keeps only what it draws).  A project edited only from those
//! would carry its whole history as ops for ever: every open replays it, and the
//! server's own readers of "the file" (archive download, GitHub sync) would see the
//! last upload instead of the design.
//!
//! The fold itself is `web/mcp/compact.ts`, run in the tool host: it splices the edits
//! into the stored file's own bytes, applies them with the editor's applier, reads the
//! result back and refuses anything that is not exactly the live document.  Here is
//! only the bookkeeping: which ops, and storing the result at the seq of the last one.
//! Nothing is removed — the ops stay in the journal for history, undo and merges.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::persist::{self, Document};

/// The tool host that does the folding: one process of its own, shared by all documents.
const FOLD_HOST: i64 = i64::MIN;

pub fn foldable(doc_type: &str) -> bool {
    matches!(doc_type, "kicad_sch" | "kicad_pcb")
}

/// Fold the ops after the newest snapshot into a snapshot at the last of them.
/// `Ok(Some(seq))` when one was written (or was already there), `Ok(None)` when there
/// was nothing to fold, `Err` with the reason when the document was left as it is.
pub async fn fold(pool: &PgPool, doc: &Document) -> Result<Option<i64>, String> {
    if !foldable(&doc.doc_type) {
        return Ok(None);
    }
    let Some((snap_seq, content)) = persist::latest_snapshot(pool, doc.id).await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let ops = persist::ops_since(pool, doc.id, snap_seq).await.map_err(|e| e.to_string())?;
    let Some(last) = ops.last().map(|o| o.seq) else { return Ok(None) };
    // The journal after a snapshot has no holes (pruning stops at one); if it ever
    // does, the file those ops describe is not known and must not be invented.
    if ops.iter().enumerate().any(|(i, o)| o.seq != snap_seq + 1 + i as i64) {
        return Err(format!("the journal after seq {snap_seq} has a gap"));
    }
    let file = String::from_utf8(content).map_err(|_| "the stored file is not text".to_string())?;
    let request = json!({
        "base": "", "token": "", "agent": "", "canWrite": false,
        "user": { "id": 0, "login": "", "name": "" },
        "tool": "fold_ops", "project": Value::Null,
        "args": {
            "docType": doc.doc_type,
            "file": file,
            "ops": ops.iter().map(|o| json!({ "seq": o.seq, "changes": o.changes })).collect::<Vec<_>>(),
        },
    });
    let reply = crate::mcp::hosts()
        .call(FOLD_HOST, request, Duration::from_secs(240))
        .await
        .map_err(|e| e.to_string())?;
    if reply["ok"] != true {
        return Err(reply["error"].as_str().unwrap_or("the fold failed").to_string());
    }
    let result = &reply["result"];
    if result["ok"] != true {
        return Err(result["reason"].as_str().unwrap_or("refused").to_string());
    }
    let text = result["text"].as_str().ok_or("the fold returned no file")?;
    // Insert-only, like an editor's upload: a snapshot already at this seq (a desktop
    // answered meanwhile, or a named checkpoint) stands.
    persist::insert_snapshot_new(pool, doc.id, last, text.as_bytes(), None).await.map_err(|e| e.to_string())?;
    Ok(Some(last))
}

/// Fold every document of a project that has edits newer than its snapshot: what a
/// reader of the stored files (an archive, a GitHub push, a new branch) does first so
/// that it reads the design as it is.  Best effort: a document that cannot be folded
/// is logged and left as snapshot + ops.
pub async fn fold_project(pool: &PgPool, project_id: uuid::Uuid) {
    let Ok(docs) = persist::project_documents(pool, project_id).await else { return };
    for doc in docs.iter().filter(|d| foldable(&d.doc_type)) {
        let (Ok(head), Ok(snap)) = (persist::head_seq(pool, doc.id).await, persist::latest_snapshot_seq(pool, doc.id).await) else { continue };
        if snap >= head {
            continue;
        }
        match fold(pool, doc).await {
            Ok(Some(seq)) => tracing::info!(doc = %doc.id, seq, "journal folded into a snapshot"),
            Ok(None) => {}
            Err(why) => tracing::warn!(doc = %doc.id, "journal not folded: {why}"),
        }
    }
}
