//! Reading a document as it stands, for the design tools (web/ai: design.ts, proposals.ts,
//! library.ts), which run in the browser for plugins and in the headless editor behind the MCP
//! endpoint (src/mcp.rs).
//!
//! There is no chat in the editor and the server holds no model API key: Claude works on a
//! project from outside, through the MCP endpoint, on the person's own Claude plan.  The tools'
//! other server-side needs live elsewhere: datasheets in datasheet.rs, libraries in kicadlib.rs.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::{persist, AppState};

/// The ops of a document after `since`, oldest first: with the latest snapshot
/// (`/api/docs/{id}/content`, whose `x-snapshot-seq` header is the `since` to pass) this gives
/// a document as it stands now, for reading one that is not the one open in the editor (a
/// tool reads the schematic while the board is open, and the other way round).
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
