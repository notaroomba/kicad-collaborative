//! Version history and branches.
//!
//! The server stores a document as whole-file snapshots (written by the desktop
//! editors, or by an upload) and a journal of ops after them, and it never builds a
//! file itself.  So everything here is expressed in the two things it does have:
//!
//! - A **point** in a document's history is `(snap_seq, seq)`: the snapshot at
//!   `snap_seq` with the ops up to `seq` laid over it.  A reader (the web editor)
//!   gets both from `GET /api/docs/{id}/at/{seq}` and applies the ops itself.
//! - A **version** pins one point per document of a project so it is never pruned.
//! - **Restoring** a point writes its snapshot again at the head of the document and
//!   journals its ops again after it, then tells every client to start over from
//!   there.  Nothing is removed, so a restore can itself be undone.
//! - A **branch** is a child project holding copies of the documents.  Merging is a
//!   replay: what one side journalled since the two last met is journalled again on
//!   the other, where the usual last-writer-wins rule applies it.  Items both sides
//!   touched are reported first and either side can be given the last word.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{AuthUser, MaybeAuthUser};
use crate::doc_actor::DocMsg;
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::persist::{self, Document, User};
use crate::AppState;

/// The client id of the marker op a restore leaves at the seq of its snapshot, and
/// of the ops it journals again after it.
pub const RESET_CLIENT: &str = "server:reset";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{id}/versions", get(list).post(create))
        .route("/api/projects/{id}/versions/{vid}", patch(update).delete(remove))
        .route("/api/projects/{id}/versions/{vid}/restore", post(restore_version))
        .route("/api/projects/{id}/restore", post(restore))
        .route("/api/projects/{id}/timeline", get(timeline))
        .route("/api/docs/{id}/at/{seq}", get(doc_at))
        .route("/api/docs/{id}/history", get(doc_history))
        .route("/api/projects/{id}/branches", get(list_branches).post(create_branch))
        .route("/api/projects/{id}/branches/{bid}", patch(update_branch).delete(delete_branch))
        .route("/api/projects/{id}/merge", post(merge))
        // the names these had before versions existed (the desktop app uses them)
        .route("/api/projects/{id}/checkpoints", get(list_checkpoints).post(create_checkpoint))
}

fn gone(msg: &str) -> AppError {
    AppError::Api(StatusCode::GONE, "history_gone", msg.to_string())
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::BadRequest(msg.into())
}

/// Documents that are edited item by item through ops.  Everything else (the project
/// file, library tables, rules) is stored whole: each edit is a new snapshot.
fn is_item_doc(doc_type: &str) -> bool {
    matches!(doc_type, "kicad_sch" | "kicad_pcb")
}

#[derive(Debug, Clone)]
pub struct Point {
    pub doc_id: Uuid,
    pub path: String,
    pub snap_seq: i64,
    pub seq: i64,
}

async fn editor(state: &AppState, user: &User, project_id: Uuid) -> AppResult<()> {
    match persist::effective_role(&state.pool, user.id, project_id).await? {
        Some(r) if r == "editor" => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

async fn member(state: &AppState, user: &User, project_id: Uuid) -> AppResult<String> {
    persist::effective_role(&state.pool, user.id, project_id).await?.ok_or(AppError::Forbidden)
}

// ---------- points ----------

/// The snapshot a point at `seq` is built on: the newest one at or before it, as long
/// as every op between the two is still there.
async fn base_snapshot(pool: &PgPool, doc_id: Uuid, seq: i64) -> AppResult<Option<i64>> {
    let snap: Option<i64> =
        sqlx::query_scalar("SELECT MAX(seq) FROM snapshots WHERE doc_id = $1 AND seq <= $2")
            .bind(doc_id)
            .bind(seq)
            .fetch_one(pool)
            .await?;
    let Some(snap) = snap else { return Ok(None) };
    let ops: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ops WHERE doc_id = $1 AND seq > $2 AND seq <= $3 AND client_id <> $4",
    )
    .bind(doc_id)
    .bind(snap)
    .bind(seq)
    .bind(RESET_CLIENT)
    .fetch_one(pool)
    .await?;
    // Ops a restore journalled again count too: they sit on the restore's snapshot.
    let again: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ops WHERE doc_id = $1 AND seq > $2 AND seq <= $3 AND client_id = $4",
    )
    .bind(doc_id)
    .bind(snap)
    .bind(seq)
    .bind(RESET_CLIENT)
    .fetch_one(pool)
    .await?;
    Ok((ops + again == seq - snap).then_some(snap))
}

async fn point_at(pool: &PgPool, doc: &Document, seq: i64) -> AppResult<Option<Point>> {
    Ok(base_snapshot(pool, doc.id, seq)
        .await?
        .map(|snap_seq| Point { doc_id: doc.id, path: doc.path.clone(), snap_seq, seq }))
}

async fn head_point(pool: &PgPool, doc: &Document) -> AppResult<Option<Point>> {
    let head = persist::head_seq(pool, doc.id).await?;
    if let Some(p) = point_at(pool, doc, head).await? {
        return Ok(Some(p));
    }
    // A journal with a hole in it: the newest snapshot is the best there is.
    let snap = persist::latest_snapshot_seq(pool, doc.id).await?;
    let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM snapshots WHERE doc_id = $1)")
        .bind(doc.id)
        .fetch_one(pool)
        .await?;
    Ok(any.then(|| Point { doc_id: doc.id, path: doc.path.clone(), snap_seq: snap, seq: snap }))
}

/// Every document of the project as it is now.
async fn head_points(pool: &PgPool, project_id: Uuid) -> AppResult<Vec<Point>> {
    let mut out = Vec::new();
    for doc in persist::project_documents(pool, project_id).await? {
        if let Some(p) = head_point(pool, &doc).await? {
            out.push(p);
        }
    }
    Ok(out)
}

/// The whole project as it was when `anchor` (a document at a seq) was its newest
/// edit: the other documents are taken at the same moment.
async fn points_at(pool: &PgPool, project_id: Uuid, anchor: (Uuid, i64)) -> AppResult<Vec<Point>> {
    let (anchor_doc, anchor_seq) = anchor;
    let when: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT COALESCE((SELECT created_at FROM ops WHERE doc_id = $1 AND seq = $2),
                         (SELECT created_at FROM snapshots WHERE doc_id = $1 AND seq = $2))",
    )
    .bind(anchor_doc)
    .bind(anchor_seq)
    .fetch_one(pool)
    .await?;
    let mut out = Vec::new();
    let mut found = false;
    for doc in persist::project_documents(pool, project_id).await? {
        if doc.id == anchor_doc {
            found = true;
            out.push(point_at(pool, &doc, anchor_seq).await?.ok_or_else(|| {
                gone("That point in the history is no longer kept. Named versions are kept for good; everything else for 30 days.")
            })?);
            continue;
        }
        let Some(when) = when else { continue };
        let seq: Option<i64> = sqlx::query_scalar(
            "SELECT GREATEST((SELECT MAX(seq) FROM ops WHERE doc_id = $1 AND created_at <= $2),
                             (SELECT MAX(seq) FROM snapshots WHERE doc_id = $1 AND created_at <= $2))",
        )
        .bind(doc.id)
        .bind(when)
        .fetch_one(pool)
        .await?;
        // No trace of it that early: the file did not exist yet.
        let Some(seq) = seq else { continue };
        if let Some(p) = point_at(pool, &doc, seq).await? {
            out.push(p);
        } else if let Some(snap) = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(seq) FROM snapshots WHERE doc_id = $1 AND seq <= $2",
        )
        .bind(doc.id)
        .bind(seq)
        .fetch_one(pool)
        .await?
        {
            out.push(Point { doc_id: doc.id, path: doc.path.clone(), snap_seq: snap, seq: snap });
        }
    }
    if !found {
        return Err(AppError::NotFound);
    }
    Ok(out)
}

#[derive(Deserialize, Clone, Copy)]
pub struct At {
    #[serde(rename = "docId")]
    doc_id: Uuid,
    seq: i64,
}

// ---------- versions ----------

async fn insert_version(
    pool: &PgPool,
    project_id: Uuid,
    name: Option<&str>,
    description: &str,
    kind: &str,
    author: i64,
    points: &[Point],
) -> AppResult<Uuid> {
    let mut tx = pool.begin().await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO versions (project_id, name, description, kind, author_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(project_id)
    .bind(name)
    .bind(description)
    .bind(kind)
    .bind(author)
    .fetch_one(&mut *tx)
    .await?;
    for p in points {
        sqlx::query(
            "INSERT INTO version_docs (version_id, doc_id, path, snap_seq, seq) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(p.doc_id)
        .bind(&p.path)
        .bind(p.snap_seq)
        .bind(p.seq)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// Keep the project as it is now under a label of the server's own, so the step
/// about to be taken (a restore, a merge) can be taken back.
async fn keep_before(state: &AppState, user: &User, project_id: Uuid, label: &str) -> AppResult<()> {
    let points = head_points(&state.pool, project_id).await?;
    if !points.is_empty() {
        insert_version(&state.pool, project_id, Some(label), "", "auto", user.id, &points).await?;
    }
    Ok(())
}

/// Keep one document as it is now in an automatic version called `label` (GitHub pull
/// uses this for each file it is about to replace; the files of one pull share a version).
pub async fn keep_doc(pool: &PgPool, project_id: Uuid, user_id: i64, label: &str, doc: &Document) -> AppResult<()> {
    let Some(p) = head_point(pool, doc).await? else { return Ok(()) };
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM versions WHERE project_id = $1 AND name = $2 AND kind = 'auto'
           AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(project_id)
    .bind(label)
    .fetch_optional(pool)
    .await?;
    match existing {
        Some(id) => {
            sqlx::query(
                "INSERT INTO version_docs (version_id, doc_id, path, snap_seq, seq) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING",
            )
            .bind(id)
            .bind(p.doc_id)
            .bind(&p.path)
            .bind(p.snap_seq)
            .bind(p.seq)
            .execute(pool)
            .await?;
        }
        None => {
            insert_version(pool, project_id, Some(label), "", "auto", user_id, &[p]).await?;
        }
    }
    Ok(())
}

async fn versions_json(pool: &PgPool, project_id: Uuid) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT v.id, v.name, v.description, v.kind, v.created_at, v.author_id,
                u.login, u.name AS author_name, u.avatar_url
         FROM versions v LEFT JOIN users u ON u.id = v.author_id
         WHERE v.project_id = $1 ORDER BY v.created_at DESC, v.id",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    let docs = sqlx::query(
        "SELECT vd.version_id, vd.doc_id, vd.path, vd.snap_seq, vd.seq
         FROM version_docs vd JOIN versions v ON v.id = vd.version_id
         WHERE v.project_id = $1 ORDER BY vd.path",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    let mut by_version: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for d in docs {
        by_version.entry(d.get("version_id")).or_default().push(json!({
            "docId": d.get::<Uuid, _>("doc_id"), "path": d.get::<String, _>("path"),
            "snapSeq": d.get::<i64, _>("snap_seq"), "seq": d.get::<i64, _>("seq"),
        }));
    }
    Ok(rows
        .into_iter()
        .map(|r| {
            let id: Uuid = r.get("id");
            let author = r.get::<Option<i64>, _>("author_id").map(|uid| {
                json!({ "id": uid, "login": r.get::<Option<String>, _>("login"),
                        "name": r.get::<Option<String>, _>("author_name"),
                        "avatarUrl": r.get::<Option<String>, _>("avatar_url") })
            });
            json!({
                "id": id, "name": r.get::<Option<String>, _>("name"),
                "description": r.get::<String, _>("description"), "kind": r.get::<String, _>("kind"),
                "createdAt": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                "author": author, "docs": by_version.remove(&id).unwrap_or_default(),
            })
        })
        .collect())
}

/// Tell everyone who has the project open that its versions or branches changed.
async fn notify(state: &AppState, project_id: Uuid, what: &str) {
    let Ok(docs) = persist::project_documents(&state.pool, project_id).await else { return };
    for doc in docs {
        let payload = json!({ "type": "versions", "docId": doc.id, "projectId": project_id, "what": what });
        state.doc_event(doc.id, DocMsg::Notice { payload }).await;
    }
}

pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    member(&state, &user, id).await?;
    Ok(Json(json!({ "versions": versions_json(&state.pool, id).await? })).into_response())
}

#[derive(Deserialize)]
pub struct CreateVersion {
    name: String,
    #[serde(default)]
    description: String,
    /// Keep the project as it was at this point instead of as it is now.
    at: Option<At>,
}

async fn create_named(state: &AppState, user: &User, id: Uuid, req: &CreateVersion) -> AppResult<(Uuid, Vec<Point>)> {
    editor(state, user, id).await?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(bad("A version needs a name."));
    }
    if name.chars().count() > 120 {
        return Err(bad("That name is too long (120 characters at most)."));
    }
    let points = match req.at {
        Some(at) => points_at(&state.pool, id, (at.doc_id, at.seq)).await?,
        None => head_points(&state.pool, id).await?,
    };
    if points.is_empty() {
        return Err(bad("This project has no files to keep a version of yet."));
    }
    let vid = insert_version(&state.pool, id, Some(name), req.description.trim(), "named", user.id, &points).await?;
    notify(state, id, "version").await;
    Ok((vid, points))
}

pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<CreateVersion>,
) -> AppResult<Response> {
    let (vid, points) = create_named(&state, &user, id, &req).await?;
    let pushing = if req.at.is_none() { crate::github::push_on_checkpoint(&state, &user, id, &req.name).await } else { false };
    Ok(Json(json!({ "id": vid, "name": req.name.trim(), "docs": points.len(), "githubPush": pushing })).into_response())
}

#[derive(Deserialize)]
pub struct UpdateVersion {
    name: Option<String>,
    description: Option<String>,
}

async fn version_project(pool: &PgPool, id: Uuid, vid: Uuid) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM versions WHERE id = $1 AND project_id = $2)")
        .bind(vid)
        .bind(id)
        .fetch_one(pool)
        .await?;
    if ok { Ok(()) } else { Err(AppError::NotFound) }
}

/// Rename or describe a version.  Naming one the server kept by itself makes it a
/// named version.
pub async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, vid)): Path<(Uuid, Uuid)>,
    LenientJson(req): LenientJson<UpdateVersion>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    version_project(&state.pool, id, vid).await?;
    if let Some(name) = &req.name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(bad("A version needs a name of at most 120 characters."));
        }
        sqlx::query("UPDATE versions SET name = $2, kind = 'named' WHERE id = $1")
            .bind(vid)
            .bind(name)
            .execute(&state.pool)
            .await?;
    }
    if let Some(d) = &req.description {
        sqlx::query("UPDATE versions SET description = $2 WHERE id = $1")
            .bind(vid)
            .bind(d.trim())
            .execute(&state.pool)
            .await?;
    }
    notify(&state, id, "version").await;
    Ok(Json(json!({ "ok": true })).into_response())
}

pub async fn remove(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, vid)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    version_project(&state.pool, id, vid).await?;
    sqlx::query("DELETE FROM versions WHERE id = $1").bind(vid).execute(&state.pool).await?;
    notify(&state, id, "version").await;
    Ok(Json(json!({ "ok": true })).into_response())
}

// ---------- the old checkpoint routes ----------

#[derive(Deserialize)]
pub struct CheckpointRequest {
    name: String,
}

pub async fn create_checkpoint(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<CheckpointRequest>,
) -> AppResult<Response> {
    let req = CreateVersion { name: req.name, description: String::new(), at: None };
    let (vid, points) = create_named(&state, &user, id, &req).await?;
    let pushing = crate::github::push_on_checkpoint(&state, &user, id, &req.name).await;
    let docs: Vec<Value> = points.iter().map(|p| json!({ "docId": p.doc_id, "path": p.path, "seq": p.seq })).collect();
    Ok(Json(json!({ "name": req.name.trim(), "id": vid, "docs": docs, "githubPush": pushing })).into_response())
}

pub async fn list_checkpoints(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    member(&state, &user, id).await?;
    let mut rows = Vec::new();
    for v in versions_json(&state.pool, id).await? {
        if v["kind"] != "named" {
            continue;
        }
        for d in v["docs"].as_array().cloned().unwrap_or_default() {
            rows.push(json!({ "docId": d["docId"], "path": d["path"], "seq": d["seq"],
                              "name": v["name"], "createdAt": v["createdAt"], "versionId": v["id"] }));
        }
    }
    Ok(Json(json!({ "checkpoints": rows })).into_response())
}

// ---------- restore ----------

fn unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().is_some_and(|d| d.is_unique_violation())
}

/// Make `dst` read as `content` followed by the ops of `src` in `(after, upto]`:
/// a new snapshot at its head, a marker op on the same seq, the ops journalled again
/// behind it, and a `reset` so every client starts over from the snapshot.  Returns the
/// document's new head.
async fn reset_doc(
    state: &AppState,
    user_id: i64,
    dst: Uuid,
    content: &[u8],
    replay: Option<(Uuid, i64, i64)>,
) -> AppResult<i64> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let (mut tx, _) = persist::lock_sequence(&state.pool, dst).await?;
        let head: i64 = sqlx::query_scalar(
            "SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                             COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0))",
        )
        .bind(dst)
        .fetch_one(&mut *tx)
        .await?;
        let at = head + 1;
        let written: Result<i64, sqlx::Error> = async {
            sqlx::query("INSERT INTO snapshots (doc_id, seq, content, uploader_id) VALUES ($1, $2, $3, $4)")
                .bind(dst)
                .bind(at)
                .bind(content)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, changes)
                 VALUES ($1, $2, $3, $4, $5, '[]'::jsonb)",
            )
            .bind(dst)
            .bind(at)
            .bind(user_id)
            .bind(RESET_CLIENT)
            .bind(at.to_string())
            .execute(&mut *tx)
            .await?;
            let mut last = at;
            if let Some((src, after, upto)) = replay {
                // row_number, not the source seq: a source range may itself hold marker ops
                let n = sqlx::query(
                    "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, changes)
                     SELECT $1, $2 + row_number() OVER (ORDER BY o.seq), $3, $4,
                            ($2 + row_number() OVER (ORDER BY o.seq))::text, o.changes
                     FROM ops o WHERE o.doc_id = $5 AND o.seq > $6 AND o.seq <= $7
                       AND o.changes <> '[]'::jsonb",
                )
                .bind(dst)
                .bind(at)
                .bind(user_id)
                .bind(RESET_CLIENT)
                .bind(src)
                .bind(after)
                .bind(upto)
                .execute(&mut *tx)
                .await?;
                last = at + n.rows_affected() as i64;
            }
            Ok(last)
        }
        .await;
        match written {
            Ok(last) => {
                tx.commit().await?;
                state.doc_event(dst, DocMsg::Reset { seq: last }).await;
                return Ok(last);
            }
            // The document's own writer took the seq first: look again.
            Err(e) if unique_violation(&e) && attempt < 8 => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

/// Replace a document with a file that came from outside its own history (a GitHub pull).
pub async fn reset_to_content(state: &AppState, user_id: i64, doc_id: Uuid, content: &[u8]) -> AppResult<i64> {
    reset_doc(state, user_id, doc_id, content, None).await
}

/// Whether the document was replaced (restored, merged over, pulled) after `since`.
pub async fn reset_after(pool: &PgPool, doc_id: Uuid, since: i64) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM ops WHERE doc_id = $1 AND seq > $2 AND client_id = $3 AND changes = '[]'::jsonb)",
    )
    .bind(doc_id)
    .bind(since)
    .bind(RESET_CLIENT)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// Put a point of a document's own history (or of its twin in a branch) at its head.
async fn restore_point(state: &AppState, user_id: i64, dst: Uuid, src: &Point) -> AppResult<i64> {
    let content = persist::snapshot_at(&state.pool, src.doc_id, src.snap_seq)
        .await?
        .ok_or_else(|| gone("The file behind that version is no longer kept."))?;
    reset_doc(state, user_id, dst, &content, Some((src.doc_id, src.snap_seq, src.seq))).await
}

/// Whether the document already reads as `p` (nothing happened since).
async fn is_head(pool: &PgPool, p: &Point) -> AppResult<bool> {
    Ok(persist::head_seq(pool, p.doc_id).await? == p.seq)
}

async fn restore_points(state: &AppState, user: &User, project_id: Uuid, points: &[Point], label: &str) -> AppResult<Vec<Value>> {
    let mut todo = Vec::new();
    for p in points {
        if !is_head(&state.pool, p).await? {
            todo.push(p);
        }
    }
    if todo.is_empty() {
        return Ok(Vec::new());
    }
    keep_before(state, user, project_id, &format!("Before restoring {label}")).await?;
    let mut out = Vec::new();
    for p in todo {
        let seq = restore_point(state, user.id, p.doc_id, p).await?;
        out.push(json!({ "docId": p.doc_id, "path": p.path, "seq": seq }));
    }
    notify(state, project_id, "restore").await;
    Ok(out)
}

async fn version_points(pool: &PgPool, vid: Uuid) -> AppResult<Vec<Point>> {
    let rows = sqlx::query(
        "SELECT vd.doc_id, d.path, vd.snap_seq, vd.seq FROM version_docs vd
         JOIN documents d ON d.id = vd.doc_id WHERE vd.version_id = $1 ORDER BY d.path",
    )
    .bind(vid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Point { doc_id: r.get("doc_id"), path: r.get("path"), snap_seq: r.get("snap_seq"), seq: r.get("seq") })
        .collect())
}

async fn version_label(pool: &PgPool, vid: Uuid) -> AppResult<String> {
    let row = sqlx::query("SELECT name, created_at FROM versions WHERE id = $1").bind(vid).fetch_one(pool).await?;
    Ok(match row.get::<Option<String>, _>("name") {
        Some(n) => format!("\"{n}\""),
        None => row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").format("the version of %Y-%m-%d %H:%M UTC").to_string(),
    })
}

pub async fn restore_version(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, vid)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    version_project(&state.pool, id, vid).await?;
    let label = version_label(&state.pool, vid).await?;
    let points = version_points(&state.pool, vid).await?;
    let docs = restore_points(&state, &user, id, &points, &label).await?;
    Ok(Json(json!({ "restored": label, "docs": docs })).into_response())
}

#[derive(Deserialize)]
pub struct RestoreRequest {
    /// The old form: the newest version with this name.
    name: Option<String>,
    #[serde(rename = "versionId")]
    version_id: Option<Uuid>,
    /// Any point of the timeline.
    at: Option<At>,
    /// With `at`: "document" restores only that file, anything else the whole project
    /// as it was at that moment.
    scope: Option<String>,
    label: Option<String>,
}

pub async fn restore(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<RestoreRequest>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let (points, label) = if let Some(at) = req.at {
        let mut points = points_at(&state.pool, id, (at.doc_id, at.seq)).await?;
        if req.scope.as_deref() == Some("document") {
            points.retain(|p| p.doc_id == at.doc_id);
        }
        (points, req.label.clone().unwrap_or_else(|| "an earlier point".into()))
    } else {
        let vid: Option<Uuid> = match (req.version_id, &req.name) {
            (Some(v), _) => Some(v),
            (None, Some(name)) => sqlx::query_scalar(
                "SELECT id FROM versions WHERE project_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(id)
            .bind(name)
            .fetch_optional(&state.pool)
            .await?,
            _ => return Err(bad("Say which version to restore.")),
        };
        let vid = vid.ok_or(AppError::NotFound)?;
        version_project(&state.pool, id, vid).await?;
        (version_points(&state.pool, vid).await?, version_label(&state.pool, vid).await?)
    };
    let docs = restore_points(&state, &user, id, &points, &label).await?;
    Ok(Json(json!({ "restored": label, "docs": docs })).into_response())
}

// ---------- reading history ----------

async fn readable(state: &AppState, viewer: Option<User>, project_id: Uuid) -> AppResult<()> {
    let project = persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    if project.public {
        return Ok(());
    }
    let user = viewer.ok_or(AppError::Unauthorized)?;
    member(state, &user, project_id).await.map(|_| ())
}

#[derive(Deserialize, Default)]
pub struct AtQuery {
    /// Also hand out the ops that follow, up to the document's next snapshot (or its
    /// head): a reader scrubbing forward then needs no second request.  `upto` in
    /// the answer says how far they reach.
    #[serde(default)]
    span: Option<String>,
}

/// A document at a point of its history: the snapshot text and the ops to lay over
/// it.  `seq` is a number or `head`.
pub async fn doc_at(
    State(state): State<AppState>,
    MaybeAuthUser(viewer): MaybeAuthUser,
    Path((doc_id, seq)): Path<(Uuid, String)>,
    axum::extract::Query(q): axum::extract::Query<AtQuery>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    readable(&state, viewer, doc.project_id).await?;
    let head = persist::head_seq(&state.pool, doc_id).await?;
    let seq = if seq == "head" { head } else { seq.parse::<i64>().map_err(|_| bad("seq is a number or \"head\""))? };
    if seq > head || seq < 0 {
        return Err(AppError::NotFound);
    }
    let point = point_at(&state.pool, &doc, seq)
        .await?
        .ok_or_else(|| gone("That point in the history is no longer kept."))?;
    let content = persist::snapshot_at(&state.pool, doc_id, point.snap_seq).await?.ok_or(AppError::NotFound)?;
    let mut upto = seq;
    if q.span.is_some() {
        let next: Option<i64> = sqlx::query_scalar("SELECT MIN(seq) FROM snapshots WHERE doc_id = $1 AND seq > $2")
            .bind(doc_id)
            .bind(seq)
            .fetch_one(&state.pool)
            .await?;
        let limit = next.map(|n| n - 1).unwrap_or(head);
        // as far as the ops go on without a hole
        let reach: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(seq) FROM (SELECT seq, seq - row_number() OVER (ORDER BY seq) AS g FROM ops
                                   WHERE doc_id = $1 AND seq > $2 AND seq <= $3) t WHERE g = $2",
        )
        .bind(doc_id)
        .bind(seq)
        .bind(limit)
        .fetch_one(&state.pool)
        .await?;
        upto = reach.unwrap_or(seq);
    }
    let ops = sqlx::query("SELECT seq, changes FROM ops WHERE doc_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq")
        .bind(doc_id)
        .bind(point.snap_seq)
        .bind(upto)
        .fetch_all(&state.pool)
        .await?;
    let ops: Vec<Value> = ops
        .into_iter()
        .map(|r| json!({ "seq": r.get::<i64, _>("seq"), "changes": r.get::<Value, _>("changes") }))
        .collect();
    Ok(Json(json!({
        "docId": doc_id, "path": doc.path, "docType": doc.doc_type, "seq": seq, "head": head, "upto": upto,
        "snapSeq": point.snap_seq, "file": String::from_utf8_lossy(&content), "ops": ops,
    }))
    .into_response())
}

/// The earliest seq from which every later point of the document can still be built.
async fn floor_seq(pool: &PgPool, doc_id: Uuid) -> AppResult<Option<i64>> {
    // The seq right after the last hole in (ops ∪ snapshots); from the first snapshot
    // at or after it on, everything is there.
    let after_gap: Option<i64> = sqlx::query_scalar(
        "WITH p AS (SELECT seq FROM ops WHERE doc_id = $1 UNION SELECT seq FROM snapshots WHERE doc_id = $1),
              g AS (SELECT seq, LAG(seq) OVER (ORDER BY seq) AS prev FROM p)
         SELECT MAX(seq) FROM g WHERE seq - prev > 1",
    )
    .bind(doc_id)
    .fetch_one(pool)
    .await?;
    let floor: Option<i64> =
        sqlx::query_scalar("SELECT MIN(seq) FROM snapshots WHERE doc_id = $1 AND seq >= $2")
            .bind(doc_id)
            .bind(after_gap.unwrap_or(i64::MIN))
            .fetch_one(pool)
            .await?;
    Ok(floor)
}

fn op_kind(client_id: &str) -> &'static str {
    if client_id == RESET_CLIENT {
        "restore"
    } else if client_id.starts_with("branch:") {
        "merge"
    } else {
        "edit"
    }
}

/// Every edit of one document that can still be scrubbed to: seq, time and author,
/// as parallel arrays (a busy board has tens of thousands).
pub async fn doc_history(
    State(state): State<AppState>,
    MaybeAuthUser(viewer): MaybeAuthUser,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    readable(&state, viewer, doc.project_id).await?;
    let head = persist::head_seq(&state.pool, doc_id).await?;
    let Some(floor) = floor_seq(&state.pool, doc_id).await? else {
        return Ok(Json(json!({ "docId": doc_id, "head": head, "floor": head, "seqs": [], "times": [], "who": [], "kinds": [], "people": [] })).into_response());
    };
    let rows = sqlx::query(
        "SELECT o.seq, o.created_at, o.author_id, o.client_id FROM ops o
         WHERE o.doc_id = $1 AND o.seq > $2 ORDER BY o.seq DESC LIMIT 50000",
    )
    .bind(doc_id)
    .bind(floor)
    .fetch_all(&state.pool)
    .await?;
    let floor_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT created_at FROM snapshots WHERE doc_id = $1 AND seq = $2")
            .bind(doc_id)
            .bind(floor)
            .fetch_optional(&state.pool)
            .await?;
    let mut people: Vec<i64> = Vec::new();
    let (mut seqs, mut times, mut who, mut kinds) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for r in rows.iter().rev() {
        let author: i64 = r.get("author_id");
        let idx = people.iter().position(|p| *p == author).unwrap_or_else(|| {
            people.push(author);
            people.len() - 1
        });
        seqs.push(r.get::<i64, _>("seq"));
        times.push(r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").timestamp_millis());
        who.push(idx);
        kinds.push(match op_kind(r.get::<String, _>("client_id").as_str()) { "restore" => 1, "merge" => 2, _ => 0 });
    }
    let floor = seqs.first().map(|s: &i64| (*s - 1).max(floor)).unwrap_or(floor);
    let mut people_json = Vec::new();
    for id in people {
        let u = persist::get_user(&state.pool, id).await?;
        people_json.push(json!({ "id": id, "login": u.as_ref().map(|u| u.login.clone()), "name": u.as_ref().and_then(|u| u.name.clone()),
                                 "avatarUrl": u.and_then(|u| u.avatar_url) }));
    }
    Ok(Json(json!({
        "docId": doc_id, "path": doc.path, "head": head, "floor": floor,
        "floorAt": floor_at.map(|t| t.timestamp_millis()),
        "seqs": seqs, "times": times, "who": who, "kinds": kinds, "people": people_json,
    }))
    .into_response())
}

/// The project's history for the timeline: its kept versions and the runs of edits
/// in between (one person working on one file without a long pause).
pub async fn timeline(
    State(state): State<AppState>,
    MaybeAuthUser(viewer): MaybeAuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let signed_in = viewer.is_some();
    readable(&state, viewer, id).await?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let mut docs_json = Vec::new();
    let mut floors: HashMap<Uuid, i64> = HashMap::new();
    for d in &docs {
        let head = persist::head_seq(&state.pool, d.id).await?;
        let floor = floor_seq(&state.pool, d.id).await?;
        if let Some(f) = floor {
            floors.insert(d.id, f);
        }
        docs_json.push(json!({ "docId": d.id, "path": d.path, "docType": d.doc_type, "head": head, "floor": floor.unwrap_or(head) }));
    }
    let ids: Vec<Uuid> = docs.iter().map(|d| d.id).collect();
    let rows = sqlx::query(
        "SELECT doc_id, author_id, kind, MIN(seq) AS from_seq, MAX(seq) AS to_seq, COUNT(*) AS n,
                MIN(created_at) AS started, MAX(created_at) AS ended
         FROM (
           SELECT *, SUM(brk) OVER (PARTITION BY doc_id ORDER BY seq) AS grp FROM (
             SELECT doc_id, seq, author_id, created_at,
                    CASE WHEN client_id = 'server:reset' THEN 'restore'
                         WHEN client_id LIKE 'branch:%' THEN 'merge' ELSE 'edit' END AS kind,
                    CASE WHEN LAG(author_id) OVER w IS DISTINCT FROM author_id
                           OR LAG(client_id LIKE 'branch:%' OR client_id = 'server:reset') OVER w
                              IS DISTINCT FROM (client_id LIKE 'branch:%' OR client_id = 'server:reset')
                           OR (client_id = 'server:reset' AND changes = '[]'::jsonb)
                           OR created_at - LAG(created_at) OVER w > interval '10 minutes'
                         THEN 1 ELSE 0 END AS brk
             FROM ops WHERE doc_id = ANY($1)
             WINDOW w AS (PARTITION BY doc_id ORDER BY seq)
           ) a
         ) b
         GROUP BY doc_id, grp, author_id, kind
         ORDER BY ended DESC LIMIT 500",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;
    let mut users: BTreeMap<i64, Value> = BTreeMap::new();
    let mut runs = Vec::new();
    for r in rows {
        let doc_id: Uuid = r.get("doc_id");
        let to: i64 = r.get("to_seq");
        // Before the floor the edits are still listed in the journal but the file
        // they applied to is gone.
        if floors.get(&doc_id).is_none_or(|f| to <= *f) {
            continue;
        }
        let author: i64 = r.get("author_id");
        if !users.contains_key(&author) {
            let u = persist::get_user(&state.pool, author).await?;
            users.insert(author, json!({ "id": author, "login": u.as_ref().map(|u| u.login.clone()),
                                         "name": u.as_ref().and_then(|u| u.name.clone()), "avatarUrl": u.and_then(|u| u.avatar_url) }));
        }
        let path = docs.iter().find(|d| d.id == doc_id).map(|d| d.path.clone()).unwrap_or_default();
        runs.push(json!({
            "docId": doc_id, "path": path, "from": r.get::<i64, _>("from_seq"), "to": to,
            "count": r.get::<i64, _>("n"), "kind": r.get::<String, _>("kind"), "author": users[&author],
            "startedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("started").to_rfc3339(),
            "endedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("ended").to_rfc3339(),
        }));
    }
    let family = family(&state.pool, id).await?;
    Ok(Json(json!({
        "projectId": id, "parentId": family.parent, "branchName": family.branch_name,
        "docs": docs_json, "versions": versions_json(&state.pool, id).await?, "runs": runs,
        "keptDays": 30, "signedIn": signed_in,
    }))
    .into_response())
}

// ---------- branches ----------

struct Family {
    /// The main project.
    root: Uuid,
    /// The parent, when the project asked about is a branch.
    parent: Option<Uuid>,
    branch_name: Option<String>,
}

async fn family(pool: &PgPool, id: Uuid) -> AppResult<Family> {
    let row = sqlx::query("SELECT parent_id, branch_name FROM projects WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let parent: Option<Uuid> = row.get("parent_id");
    Ok(Family { root: parent.unwrap_or(id), parent, branch_name: row.get("branch_name") })
}

fn branch_client(doc: Uuid) -> String {
    format!("branch:{doc}")
}

pub async fn list_branches(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let role = member(&state, &user, id).await?;
    let fam = family(&state.pool, id).await?;
    let root = persist::get_project(&state.pool, fam.root).await?.ok_or(AppError::NotFound)?;
    let rows = sqlx::query(
        "SELECT p.id, p.branch_name, p.description, p.created_at, p.branch_merged_at, p.branch_created_by,
                u.login, u.name AS user_name, u.avatar_url,
                COALESCE((SELECT SUM((SELECT COUNT(*) FROM ops o WHERE o.doc_id = b.doc_id AND o.seq > b.merged_seq
                                       AND o.changes <> '[]'::jsonb
                                       AND o.client_id <> 'branch:' || b.parent_doc_id::text))
                          FROM branch_docs b JOIN documents d ON d.id = b.doc_id WHERE d.project_id = p.id), 0)::bigint AS ahead,
                COALESCE((SELECT SUM((SELECT COUNT(*) FROM ops o WHERE o.doc_id = b.parent_doc_id AND o.seq > b.synced_seq
                                       AND o.changes <> '[]'::jsonb
                                       AND o.client_id <> 'branch:' || b.doc_id::text))
                          FROM branch_docs b JOIN documents d ON d.id = b.doc_id WHERE d.project_id = p.id), 0)::bigint AS behind,
                GREATEST(p.created_at,
                         COALESCE((SELECT MAX(o.created_at) FROM ops o JOIN documents d ON d.id = o.doc_id
                                   WHERE d.project_id = p.id AND o.client_id NOT LIKE 'branch:%'), p.created_at)) AS updated_at
         FROM projects p LEFT JOIN users u ON u.id = p.branch_created_by
         WHERE p.parent_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at",
    )
    .bind(fam.root)
    .fetch_all(&state.pool)
    .await?;
    let mut branches = Vec::new();
    for r in rows {
        let bid: Uuid = r.get("id");
        let docs: Vec<Value> = persist::project_documents(&state.pool, bid)
            .await?
            .iter()
            .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type }))
            .collect();
        branches.push(json!({
            "projectId": bid, "name": r.get::<Option<String>, _>("branch_name"),
            "description": r.get::<String, _>("description"),
            "createdAt": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
            "updatedAt": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at").to_rfc3339(),
            "mergedAt": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("branch_merged_at").map(|t| t.to_rfc3339()),
            "createdBy": r.get::<Option<i64>, _>("branch_created_by").map(|uid| json!({
                "id": uid, "login": r.get::<Option<String>, _>("login"), "name": r.get::<Option<String>, _>("user_name"),
                "avatarUrl": r.get::<Option<String>, _>("avatar_url") })),
            "ahead": r.get::<i64, _>("ahead"), "behind": r.get::<i64, _>("behind"), "docs": docs,
        }));
    }
    let main_docs: Vec<Value> = persist::project_documents(&state.pool, fam.root)
        .await?
        .iter()
        .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type }))
        .collect();
    Ok(Json(json!({
        "main": { "projectId": fam.root, "name": root.name, "docs": main_docs },
        "current": id, "canEdit": role == "editor", "branches": branches,
    }))
    .into_response())
}

/// Copy a document at a point into another project, keeping its sequence numbers.
async fn copy_doc(pool: &PgPool, src: &Document, p: &Point, into: Uuid) -> AppResult<Document> {
    let content = persist::snapshot_at(pool, src.id, p.snap_seq).await?.ok_or(AppError::NotFound)?;
    let new = persist::create_document(pool, into, &src.path, &src.doc_type).await?;
    sqlx::query("INSERT INTO snapshots (doc_id, seq, content, uploader_id) SELECT $1, $2, $3, uploader_id FROM snapshots WHERE doc_id = $4 AND seq = $2")
        .bind(new.id)
        .bind(p.snap_seq)
        .bind(&content)
        .bind(src.id)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, base_seq, changes, created_at)
         SELECT $1, seq, author_id, client_id, client_op_id, base_seq, changes, created_at
         FROM ops WHERE doc_id = $2 AND seq > $3 AND seq <= $4",
    )
    .bind(new.id)
    .bind(src.id)
    .bind(p.snap_seq)
    .bind(p.seq)
    .execute(pool)
    .await?;
    Ok(new)
}

#[derive(Deserialize)]
pub struct CreateBranch {
    name: String,
    #[serde(default)]
    description: String,
    /// Start from a kept version…
    #[serde(rename = "versionId")]
    version_id: Option<Uuid>,
    /// …or from any point of the timeline; otherwise from the project as it is now.
    at: Option<At>,
}

fn branch_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad("A branch needs a name."));
    }
    if name.chars().count() > 60 {
        return Err(bad("That name is too long (60 characters at most)."));
    }
    if name.eq_ignore_ascii_case("main") {
        return Err(bad("\"main\" is the name of the project's own line."));
    }
    Ok(name.to_string())
}

pub async fn create_branch(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<CreateBranch>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let fam = family(&state.pool, id).await?;
    if fam.parent.is_some() {
        return Err(bad("Branches start from the main line. Switch to main to start another one."));
    }
    let name = branch_name(&req.name)?;
    let root = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let points = match (req.version_id, req.at) {
        (Some(vid), _) => {
            version_project(&state.pool, id, vid).await?;
            version_points(&state.pool, vid).await?
        }
        (None, Some(at)) => points_at(&state.pool, id, (at.doc_id, at.seq)).await?,
        _ => head_points(&state.pool, id).await?,
    };
    if points.is_empty() {
        return Err(bad("This project has no files to branch from yet."));
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM projects WHERE parent_id = $1 AND deleted_at IS NULL AND lower(branch_name) = lower($2))",
    )
    .bind(id)
    .bind(&name)
    .fetch_one(&state.pool)
    .await?;
    if taken {
        return Err(AppError::Api(StatusCode::CONFLICT, "branch_exists", format!("There is already a branch called \"{name}\".")));
    }
    let bid: Uuid = sqlx::query_scalar(
        "INSERT INTO projects (owner_id, name, description, parent_id, branch_name, branch_created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(root.owner_id)
    .bind(&root.name)
    .bind(req.description.trim())
    .bind(id)
    .bind(&name)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await?;
    let docs = persist::project_documents(&state.pool, id).await?;
    for p in &points {
        let Some(src) = docs.iter().find(|d| d.id == p.doc_id) else { continue };
        let new = copy_doc(&state.pool, src, p, bid).await?;
        sqlx::query("INSERT INTO branch_docs (doc_id, parent_doc_id, fork_seq, merged_seq, synced_seq) VALUES ($1, $2, $3, $3, $3)")
            .bind(new.id)
            .bind(src.id)
            .bind(p.seq)
            .execute(&state.pool)
            .await?;
    }
    notify(&state, id, "branch").await;
    Ok(Json(json!({ "projectId": bid, "name": name })).into_response())
}

async fn branch_of(pool: &PgPool, id: Uuid, bid: Uuid) -> AppResult<Uuid> {
    let fam = family(pool, id).await?;
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1 AND parent_id = $2 AND deleted_at IS NULL)")
        .bind(bid)
        .bind(fam.root)
        .fetch_one(pool)
        .await?;
    if ok { Ok(fam.root) } else { Err(AppError::NotFound) }
}

#[derive(Deserialize)]
pub struct UpdateBranch {
    name: Option<String>,
    description: Option<String>,
}

pub async fn update_branch(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, bid)): Path<(Uuid, Uuid)>,
    LenientJson(req): LenientJson<UpdateBranch>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let root = branch_of(&state.pool, id, bid).await?;
    if let Some(name) = &req.name {
        let name = branch_name(name)?;
        let res = sqlx::query("UPDATE projects SET branch_name = $2 WHERE id = $1").bind(bid).bind(&name).execute(&state.pool).await;
        match res {
            Err(e) if unique_violation(&e) => {
                return Err(AppError::Api(StatusCode::CONFLICT, "branch_exists", format!("There is already a branch called \"{name}\".")));
            }
            other => {
                other?;
            }
        }
    }
    if let Some(d) = &req.description {
        sqlx::query("UPDATE projects SET description = $2 WHERE id = $1").bind(bid).bind(d.trim()).execute(&state.pool).await?;
    }
    notify(&state, root, "branch").await;
    notify(&state, bid, "branch").await;
    Ok(Json(json!({ "ok": true })).into_response())
}

/// Delete a branch.  Like a deleted project it is kept out of sight for 30 days and
/// then purged; the main line is not touched.
pub async fn delete_branch(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, bid)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    editor(&state, &user, id).await?;
    let root = branch_of(&state.pool, id, bid).await?;
    // Tell the people inside it before it disappears from under them.
    notify(&state, bid, "branch_deleted").await;
    persist::trash_project(&state.pool, bid).await?;
    state.access_changed();
    notify(&state, root, "branch").await;
    Ok(Json(json!({ "ok": true })).into_response())
}

// ---------- merge ----------

/// What a change is about: the item's id, or the one document-level thing it sets.
fn change_key(c: &Value) -> Option<String> {
    if c.get("docProps").is_some() {
        return Some("document settings".into());
    }
    match c.get("typeName").and_then(Value::as_str) {
        Some("BOARD_SETUP") => return Some("board setup".into()),
        Some("PROJECT_FILE") => return Some("project settings".into()),
        _ => {}
    }
    c.get("id").and_then(Value::as_str).map(str::to_string)
}

/// A name a person recognises for the item a change is about.
fn change_label(c: &Value) -> String {
    let key = change_key(c).unwrap_or_default();
    if c.get("id").and_then(Value::as_str) != Some(key.as_str()) {
        return key;
    }
    let kind = c.get("typeName").and_then(Value::as_str).unwrap_or("item");
    let kind = kind.strip_prefix("PCB_").or_else(|| kind.strip_prefix("SCH_")).unwrap_or(kind).to_lowercase().replace('_', " ");
    let reference = c
        .get("properties")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p["name"] == "Reference"))
        .and_then(|p| p["after"]["v"].as_str().map(str::to_string))
        .or_else(|| {
            let sexpr = c.get("sexpr").or_else(|| c.get("itemSexpr")).and_then(Value::as_str)?;
            let at = sexpr.find("(property \"Reference\" \"")? + 23;
            let end = sexpr[at..].find('"')?;
            Some(sexpr[at..at + end].to_string())
        });
    match reference {
        Some(r) if !r.is_empty() => format!("{kind} {r}"),
        _ => format!("{kind} {}", key.chars().take(8).collect::<String>()),
    }
}

struct Incoming {
    seq: i64,
    changes: Vec<Value>,
}

/// The ops of `doc` after `after` that are its own work: not markers, and not ops
/// that were themselves merged in from `other`.
async fn own_ops(pool: &PgPool, doc: Uuid, after: i64, other: Uuid) -> AppResult<Vec<Incoming>> {
    let rows = sqlx::query(
        "SELECT seq, changes FROM ops WHERE doc_id = $1 AND seq > $2 AND client_id <> $3
           AND changes <> '[]'::jsonb ORDER BY seq",
    )
    .bind(doc)
    .bind(after)
    .bind(branch_client(other))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Incoming { seq: r.get("seq"), changes: r.get::<Value, _>("changes").as_array().cloned().unwrap_or_default() })
        .collect())
}

/// Whether the ops after `after` tell the whole story of the document since then:
/// nothing replaced it (a restore, a pull) and no op is missing.
async fn linear(pool: &PgPool, doc: Uuid, after: i64) -> AppResult<bool> {
    let head = persist::head_seq(pool, doc).await?;
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ops WHERE doc_id = $1 AND seq > $2 AND NOT (client_id = $3 AND changes = '[]'::jsonb)",
    )
    .bind(doc)
    .bind(after)
    .bind(RESET_CLIENT)
    .fetch_one(pool)
    .await?;
    Ok(n == head - after)
}

/// Journal `ops` on `dst` as merged in from `src`, and hand them to whoever has it open.
async fn replay(state: &AppState, user_id: i64, src: Uuid, dst: Uuid, ops: &[Incoming]) -> AppResult<()> {
    if ops.is_empty() {
        return Ok(());
    }
    let client = branch_client(src);
    let mut attempt = 0;
    let last = loop {
        attempt += 1;
        let (mut tx, _) = persist::lock_sequence(&state.pool, dst).await?;
        let head: i64 = sqlx::query_scalar(
            "SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                             COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0))",
        )
        .bind(dst)
        .fetch_one(&mut *tx)
        .await?;
        let mut seq = head;
        let mut failed = None;
        for op in ops {
            seq += 1;
            let res = sqlx::query(
                "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, changes) VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(dst)
            .bind(seq)
            .bind(user_id)
            .bind(&client)
            .bind(format!("{}@{}", op.seq, head))
            .bind(Value::Array(op.changes.clone()))
            .execute(&mut *tx)
            .await;
            if let Err(e) = res {
                failed = Some(e);
                break;
            }
        }
        match failed {
            None => {
                tx.commit().await?;
                break seq;
            }
            Some(e) if unique_violation(&e) && attempt < 8 => continue,
            Some(e) => return Err(e.into()),
        }
    };
    if let Some(tx) = state.registry.existing(dst) {
        let _ = tx.send(DocMsg::Relay(json!({ "t": "op", "d": dst, "seq": last }))).await;
    }
    if state.relay.others_alive() {
        state.relay.publish(json!({ "t": "op", "d": dst, "seq": last }));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct MergeRequest {
    /// `into_main` brings the branch's work to the main line, `from_main` brings the
    /// main line's newer work into the branch.
    direction: String,
    /// `merge` replays the changes; `replace` makes the receiving side read exactly
    /// as the other one.
    #[serde(default)]
    mode: Option<String>,
    /// Who has the last word on items both sides changed: `incoming` (default) or `current`.
    #[serde(default)]
    prefer: Option<String>,
    #[serde(rename = "dryRun", default)]
    dry_run: bool,
}

struct Pair {
    src: Document,
    dst: Option<Document>,
    /// (src's ops after this are new to dst, dst's ops after this are new to src)
    since: Option<(i64, i64)>,
}

async fn latest_bytes(pool: &PgPool, doc: Uuid) -> AppResult<Option<Vec<u8>>> {
    Ok(persist::latest_snapshot(pool, doc).await?.map(|(_, c)| c))
}

/// Merge a branch and its main line, one way.  Called on the branch.
pub async fn merge(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<MergeRequest>,
) -> AppResult<Response> {
    let pool = &state.pool;
    let fam = family(pool, id).await?;
    let Some(parent) = fam.parent else { return Err(bad("Only a branch can be merged.")) };
    if req.dry_run {
        member(&state, &user, id).await?;
    } else {
        editor(&state, &user, id).await?;
    }
    let into_main = match req.direction.as_str() {
        "into_main" => true,
        "from_main" => false,
        _ => return Err(bad("direction is into_main or from_main")),
    };
    let replace = req.mode.as_deref() == Some("replace");
    let keep_current = req.prefer.as_deref() == Some("current");
    let (src_project, dst_project) = if into_main { (id, parent) } else { (parent, id) };
    let branch_label = fam.branch_name.clone().unwrap_or_else(|| "branch".into());

    // Pair the documents: by the record of where a branch document came from, else by path.
    let links = sqlx::query(
        "SELECT b.doc_id, b.parent_doc_id, b.merged_seq, b.synced_seq FROM branch_docs b
         JOIN documents d ON d.id = b.doc_id WHERE d.project_id = $1",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let src_docs = persist::project_documents(pool, src_project).await?;
    let dst_docs = persist::project_documents(pool, dst_project).await?;
    let mut pairs = Vec::new();
    for src in src_docs {
        let link = links.iter().find(|l| {
            let (b, p): (Uuid, Uuid) = (l.get("doc_id"), l.get("parent_doc_id"));
            if into_main { b == src.id } else { p == src.id }
        });
        let (dst, since) = match link {
            Some(l) => {
                let (b, p): (Uuid, Uuid) = (l.get("doc_id"), l.get("parent_doc_id"));
                let (merged, synced): (i64, i64) = (l.get("merged_seq"), l.get("synced_seq"));
                let dst_id = if into_main { p } else { b };
                (dst_docs.iter().find(|d| d.id == dst_id).cloned(), Some(if into_main { (merged, synced) } else { (synced, merged) }))
            }
            None => (dst_docs.iter().find(|d| d.path == src.path).cloned(), None),
        };
        pairs.push(Pair { src, dst, since });
    }

    // Plan.
    struct Step {
        pair: Pair,
        action: &'static str,
        incoming: Vec<Incoming>,
        conflicts: Vec<(String, String)>,
        linear: bool,
        dst_changed: bool,
    }
    let mut steps = Vec::new();
    let mut all_linear = true;
    for pair in pairs {
        let mut step = Step { action: "none", incoming: Vec::new(), conflicts: Vec::new(), linear: true, dst_changed: false, pair };
        let Some(dst) = step.pair.dst.clone() else {
            step.action = "add";
            steps.push(step);
            continue;
        };
        let src = step.pair.src.clone();
        match step.pair.since {
            Some((src_after, dst_after)) if is_item_doc(&src.doc_type) => {
                step.incoming = own_ops(pool, src.id, src_after, dst.id).await?;
                let theirs = own_ops(pool, dst.id, dst_after, src.id).await?;
                step.dst_changed = !theirs.is_empty();
                step.linear = linear(pool, src.id, src_after).await? && linear(pool, dst.id, dst_after).await?;
                let mut dst_keys: HashSet<String> = HashSet::new();
                for op in &theirs {
                    dst_keys.extend(op.changes.iter().filter_map(change_key));
                }
                let mut seen = HashSet::new();
                for op in &step.incoming {
                    for c in &op.changes {
                        if let Some(k) = change_key(c) {
                            if dst_keys.contains(&k) && seen.insert(k.clone()) {
                                step.conflicts.push((k, change_label(c)));
                            }
                        }
                    }
                }
                let src_reset = !linear(pool, src.id, src_after).await?;
                step.action = if !step.incoming.is_empty() || src_reset { "merge" } else { "none" };
                if step.action == "merge" && !step.linear {
                    all_linear = false;
                }
            }
            _ => {
                // A file stored whole (or one both sides created on their own): compare
                // the files, with the branch's starting copy as the common ancestor.
                let a = latest_bytes(pool, src.id).await?;
                let b = latest_bytes(pool, dst.id).await?;
                if a != b {
                    let branch_doc = if into_main { src.id } else { dst.id };
                    let base: Option<Vec<u8>> = match step.pair.since {
                        Some(_) => sqlx::query_scalar("SELECT content FROM snapshots WHERE doc_id = $1 ORDER BY seq LIMIT 1")
                            .bind(branch_doc)
                            .fetch_optional(pool)
                            .await?,
                        None => None,
                    };
                    if base.is_some() && a == base {
                        step.action = "none"; // only the receiving side changed it
                        step.dst_changed = true;
                    } else if base.is_some() && b == base {
                        step.action = "take";
                    } else {
                        step.action = "take";
                        step.dst_changed = true;
                        step.conflicts.push((src.path.clone(), format!("the file {}", src.path)));
                    }
                }
            }
        }
        steps.push(step);
    }

    let nothing = steps.iter().all(|s| s.action == "none") && !(replace && steps.iter().any(|s| s.dst_changed));
    let report: Vec<Value> = steps
        .iter()
        .map(|s| {
            json!({
                "path": s.pair.src.path, "action": s.action, "ops": s.incoming.len(),
                "changes": s.incoming.iter().map(|o| o.changes.len()).sum::<usize>(),
                "conflicts": s.conflicts.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
                "changedHere": s.dst_changed,
            })
        })
        .collect();
    let conflicts: usize = steps.iter().map(|s| s.conflicts.len()).sum();
    let summary = json!({
        "direction": req.direction, "branch": branch_label, "docs": report, "conflicts": conflicts,
        "nothing": nothing,
        // Replaying needs the full story of both sides since they last met.
        "canMerge": all_linear,
        "reason": if all_linear { Value::Null } else {
            json!("One side was restored to an earlier version (or replaced by a pull) since the two last met, so its changes cannot be replayed one by one. Replacing is still possible.")
        },
    });
    if req.dry_run {
        return Ok(Json(summary).into_response());
    }
    if nothing {
        return Ok(Json(json!({ "merged": false, "summary": summary })).into_response());
    }
    if !replace && !all_linear {
        return Err(AppError::Api(StatusCode::CONFLICT, "not_linear", summary["reason"].as_str().unwrap_or("").to_string()));
    }

    let before = if into_main { format!("Before merging \"{branch_label}\"") } else { "Before updating from main".to_string() };
    keep_before(&state, &user, dst_project, &before).await?;

    for step in steps {
        let src = step.pair.src;
        match (step.pair.dst, step.action) {
            (None, _) => {
                // A file the other side does not have yet: it gets a copy and the two are linked.
                let Some(p) = head_point(pool, &src).await? else { continue };
                let new = copy_doc(pool, &src, &p, dst_project).await?;
                let (b, par) = if into_main { (src.id, new.id) } else { (new.id, src.id) };
                sqlx::query(
                    "INSERT INTO branch_docs (doc_id, parent_doc_id, fork_seq, merged_seq, synced_seq) VALUES ($1, $2, $3, $3, $3)
                     ON CONFLICT (doc_id) DO UPDATE SET parent_doc_id = EXCLUDED.parent_doc_id, fork_seq = EXCLUDED.fork_seq,
                       merged_seq = EXCLUDED.merged_seq, synced_seq = EXCLUDED.synced_seq",
                )
                .bind(b)
                .bind(par)
                .bind(p.seq)
                .execute(pool)
                .await?;
            }
            (Some(dst), action) => {
                let item = is_item_doc(&src.doc_type) && step.pair.since.is_some();
                let src_head = persist::head_seq(pool, src.id).await?;
                if replace {
                    if action != "none" || step.dst_changed {
                        let Some(p) = head_point(pool, &src).await? else { continue };
                        restore_point(&state, user.id, dst.id, &p).await?;
                    }
                } else if item {
                    let skip: HashSet<&str> = if keep_current { step.conflicts.iter().map(|(k, _)| k.as_str()).collect() } else { HashSet::new() };
                    let ops: Vec<Incoming> = step
                        .incoming
                        .into_iter()
                        .map(|op| Incoming {
                            seq: op.seq,
                            changes: op.changes.into_iter().filter(|c| change_key(c).is_none_or(|k| !skip.contains(k.as_str()))).collect(),
                        })
                        .filter(|op| !op.changes.is_empty())
                        .collect();
                    replay(&state, user.id, src.id, dst.id, &ops).await?;
                } else if action == "take" && !(keep_current && !step.conflicts.is_empty()) {
                    let Some(p) = head_point(pool, &src).await? else { continue };
                    restore_point(&state, user.id, dst.id, &p).await?;
                }
                // Record that the two have met.
                let dst_head = persist::head_seq(pool, dst.id).await?;
                let (b, merged, synced) = if into_main { (src.id, src_head, None) } else { (dst.id, dst_head, Some(src_head)) };
                if step.pair.since.is_some() {
                    if replace {
                        // identical now: both are fully known to each other
                        let (bh, ph) = if into_main { (src_head, dst_head) } else { (dst_head, src_head) };
                        sqlx::query("UPDATE branch_docs SET merged_seq = $2, synced_seq = $3 WHERE doc_id = $1")
                            .bind(b)
                            .bind(bh)
                            .bind(ph)
                            .execute(pool)
                            .await?;
                    } else if into_main {
                        sqlx::query("UPDATE branch_docs SET merged_seq = $2 WHERE doc_id = $1").bind(b).bind(merged).execute(pool).await?;
                    } else if let Some(s) = synced {
                        sqlx::query("UPDATE branch_docs SET synced_seq = $2 WHERE doc_id = $1").bind(b).bind(s).execute(pool).await?;
                    }
                }
            }
        }
    }
    if into_main {
        sqlx::query("UPDATE projects SET branch_merged_at = now() WHERE id = $1").bind(id).execute(pool).await?;
    }
    notify(&state, parent, "merge").await;
    notify(&state, id, "merge").await;
    Ok(Json(json!({ "merged": true, "summary": summary })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_name_the_part() {
        let c = json!({ "id": "aaaaaaaa-1111", "typeName": "PCB_FOOTPRINT", "kind": "MODIFIED",
                        "properties": [{ "name": "Reference", "after": { "v": "R7" } }] });
        assert_eq!(change_label(&c), "footprint R7");
        let c = json!({ "id": "bbbbbbbb-2222", "typeName": "SCH_SYMBOL", "kind": "ADDED",
                        "sexpr": "(symbol (property \"Reference\" \"U3\" (at 0 0)))" });
        assert_eq!(change_label(&c), "symbol U3");
        let c = json!({ "id": "cccccccc-3333", "typeName": "PCB_TRACK", "kind": "REMOVED" });
        assert_eq!(change_label(&c), "track cccccccc");
        assert_eq!(change_label(&json!({ "docProps": {} })), "document settings");
    }

    #[test]
    fn keys_tell_items_from_document_level_changes() {
        assert_eq!(change_key(&json!({ "id": "x", "typeName": "PCB_VIA" })).as_deref(), Some("x"));
        assert_eq!(change_key(&json!({ "id": "project", "typeName": "PROJECT_FILE" })).as_deref(), Some("project settings"));
        assert_eq!(change_key(&json!({ "typeName": "BOARD_SETUP", "section": "rules" })).as_deref(), Some("board setup"));
        assert!(change_key(&json!({ "kind": "MODIFIED" })).is_none());
    }
}
