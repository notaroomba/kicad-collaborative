use std::io::{Cursor, Read, Write};

use axum::extract::{Multipart, Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use crate::auth::{self, AuthUser};
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

/// File names KiCad projects legitimately contain.
fn allowed_file(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    if matches!(base, "sym-lib-table" | "fp-lib-table") {
        return true;
    }
    let ext = base.rsplit('.').next().unwrap_or("");
    matches!(
        ext,
        "kicad_pro" | "kicad_sch" | "kicad_pcb" | "kicad_prl" | "kicad_sym" | "kicad_mod"
            | "kicad_dru" | "kicad_wks"
    )
}

fn doc_type_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "kicad_sch" => "kicad_sch",
        "kicad_pcb" => "kicad_pcb",
        "kicad_pro" => "kicad_pro",
        _ => "other",
    }
}

fn safe_zip_name(name: &str) -> Option<String> {
    let name = name.replace('\\', "/");
    if name.is_empty()
        || name.ends_with('/')
        || name.starts_with('/')
        || name.contains("..")
        || name.contains(':')
    {
        return None;
    }
    Some(name)
}

// ---------- Projects ----------

pub async fn create_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    mut multipart: Multipart,
) -> AppResult<Response> {
    let mut archive: Option<Vec<u8>> = None;
    let mut name: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("bad multipart: {e}")))?
    {
        match field.name() {
            Some("archive") => {
                archive = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::BadRequest(format!("archive read failed: {e}")))?
                        .to_vec(),
                )
            }
            Some("name") => name = field.text().await.ok(),
            _ => {}
        }
    }
    let archive = archive.ok_or_else(|| AppError::BadRequest("missing 'archive' field".into()))?;

    // Unzip + validate off the async runtime.
    let files = tokio::task::spawn_blocking(move || -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|e| e.to_string())?;
        if zip.len() > MAX_FILES {
            return Err(format!("too many files (max {MAX_FILES})"));
        }
        let mut out = Vec::new();
        let mut budget = MAX_TOTAL_BYTES;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            if f.is_dir() {
                continue;
            }
            let Some(name) = safe_zip_name(f.name()) else {
                return Err(format!("unsafe path in archive: {}", f.name()));
            };
            if !allowed_file(&name) {
                return Err(format!("file type not allowed: {name}"));
            }
            // f.size() is attacker-declared header metadata, not a decode
            // limit — cap the reader itself or a zip bomb OOMs the container.
            let cap = MAX_FILE_BYTES.min(budget);
            let mut buf = Vec::new();
            (&mut f).take(cap + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.len() as u64 > cap {
                return Err(format!("{name} is too large"));
            }
            budget -= buf.len() as u64;
            out.push((name, buf));
        }
        if out.is_empty() {
            return Err("archive contains no usable files".into());
        }
        Ok(out)
    })
    .await
    .map_err(|e| anyhow::anyhow!("unzip task failed: {e}"))?
    .map_err(AppError::BadRequest)?;

    let project_name = name
        .or_else(|| {
            files.iter().find(|(n, _)| n.ends_with(".kicad_pro")).map(|(n, _)| {
                n.rsplit('/').next().unwrap_or(n).trim_end_matches(".kicad_pro").to_string()
            })
        })
        .unwrap_or_else(|| "untitled".to_string());

    let project = persist::create_project(&state.pool, user.id, &project_name).await?;
    let mut docs = Vec::new();
    for (path, content) in &files {
        let doc = persist::create_document(&state.pool, project.id, path, doc_type_for(path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, content, None, Some(user.id)).await?;
        docs.push(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type }));
    }

    Ok(Json(json!({ "projectId": project.id, "name": project.name, "docs": docs })).into_response())
}

pub async fn get_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let docs: Vec<_> = docs
        .iter()
        .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type }))
        .collect();
    Ok(Json(json!({
        "projectId": project.id, "name": project.name, "ownerId": project.owner_id,
        "role": role, "docs": docs,
    }))
    .into_response())
}

pub async fn download_archive(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;

    let docs = persist::project_documents(&state.pool, id).await?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut manifest_docs = serde_json::Map::new();
    for d in &docs {
        if let Some((seq, content)) = persist::latest_snapshot(&state.pool, d.id).await? {
            manifest_docs.insert(
                d.path.clone(),
                json!({ "docId": d.id, "docType": d.doc_type, "snapshotSeq": seq }),
            );
            entries.push((d.path.clone(), content));
        }
    }
    let manifest = json!({
        "projectId": project.id,
        "name": project.name,
        "server": state.cfg.public_url,
        "docs": manifest_docs,
    });
    entries.push(("collab-manifest.json".into(), serde_json::to_vec_pretty(&manifest).unwrap()));

    let zip_bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(name, opts).map_err(|e| e.to_string())?;
            writer.write_all(&content).map_err(|e| e.to_string())?;
        }
        Ok(writer.finish().map_err(|e| e.to_string())?.into_inner())
    })
    .await
    .map_err(|e| anyhow::anyhow!("zip task failed: {e}"))?
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))?;

    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}.zip\"", project.name.replace('"', "")),
            ),
        ],
        zip_bytes,
    )
        .into_response())
}

// ---------- Share links & invites ----------

#[derive(Deserialize)]
pub struct CreateLinkRequest {
    pub role: Option<String>,
    #[serde(rename = "expiresInDays")]
    pub expires_in_days: Option<i64>,
}

pub async fn create_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateLinkRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    let role = req.role.unwrap_or_else(|| "editor".into());
    if !matches!(role.as_str(), "editor" | "viewer") {
        return Err(AppError::BadRequest("role must be editor or viewer".into()));
    }
    let expires_at = req.expires_in_days.map(|d| chrono::Utc::now() + chrono::Duration::days(d));
    let token = auth::random_token();
    persist::create_share_link(&state.pool, &token, id, &role, user.id, expires_at).await?;
    Ok(Json(json!({
        "token": token,
        "url": format!("{}/j/{}", state.cfg.public_url, token),
        "role": role,
    }))
    .into_response())
}

pub async fn revoke_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(token): Path<String>,
) -> AppResult<Response> {
    if persist::revoke_share_link(&state.pool, &token, user.id).await? {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

/// Signed-in user claims a share link (web flow); KiCad claims via ws hello.
pub async fn claim_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(token): Path<String>,
) -> AppResult<Response> {
    let link = persist::get_valid_share_link(&state.pool, &token)
        .await?
        .ok_or(AppError::NotFound)?;
    persist::claim_share_link(&state.pool, user.id, &link).await?;
    Ok(Json(json!({ "projectId": link.project_id, "role": link.role })).into_response())
}

/// Revoking a link doesn't revoke the grants it already handed out, so the
/// owner needs a way to take access back.
pub async fn list_members(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    let members: Vec<_> = persist::list_members(&state.pool, id)
        .await?
        .into_iter()
        .map(|(uid, login, role)| json!({ "userId": uid, "login": login, "role": role }))
        .collect();
    Ok(Json(json!({ "ownerId": project.owner_id, "members": members })).into_response())
}

pub async fn remove_member(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, member_id)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    // ponytail: takes effect on the member's next join_doc; live sockets keep
    // their cached role until they reconnect. Add a Kick DocMsg if that matters.
    if persist::remove_member(&state.pool, id, member_id).await? {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

#[derive(Deserialize)]
pub struct InviteRequest {
    pub login: Option<String>,
    pub email: Option<String>,
    pub role: Option<String>,
}

pub async fn invite(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<InviteRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    if req.login.is_none() && req.email.is_none() {
        return Err(AppError::BadRequest("provide login or email".into()));
    }
    let role = req.role.unwrap_or_else(|| "editor".into());
    if !matches!(role.as_str(), "editor" | "viewer") {
        return Err(AppError::BadRequest("role must be editor or viewer".into()));
    }
    persist::add_invite(&state.pool, id, req.login.as_deref(), req.email.as_deref(), &role, user.id)
        .await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

// ---------- Snapshots ----------

#[derive(Deserialize)]
pub struct SnapshotQuery {
    pub seq: i64,
}

pub async fn upload_snapshot(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(doc_id): Path<Uuid>,
    Query(q): Query<SnapshotQuery>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }
    let head = persist::head_seq(&state.pool, doc_id).await?;
    let latest = persist::latest_snapshot_seq(&state.pool, doc_id).await?;
    if q.seq > head {
        return Err(AppError::BadRequest(format!("seq {} is beyond head {head}", q.seq)));
    }
    if q.seq < latest {
        return Err(AppError::BadRequest(format!("seq {} is older than snapshot {latest}", q.seq)));
    }
    persist::insert_snapshot(&state.pool, doc_id, q.seq, &body, None, Some(user.id)).await?;
    Ok(Json(json!({ "ok": true, "docId": doc_id, "seq": q.seq })).into_response())
}

// ---------- Version history ----------

#[derive(Deserialize)]
pub struct CheckpointRequest {
    pub name: String,
}

/// Name the current snapshot of every document in the project. Docs whose
/// snapshot lags head are still named — the ops after it replay on restore.
pub async fn create_checkpoint(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<CheckpointRequest>,
) -> AppResult<Response> {
    let role = persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }
    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("checkpoint name required".into()));
    }

    let docs = persist::project_documents(&state.pool, id).await?;
    let mut named = Vec::new();

    for d in &docs {
        if let Some(seq) = persist::name_latest_snapshot(&state.pool, d.id, &req.name).await? {
            named.push(json!({ "docId": d.id, "path": d.path, "seq": seq }));
        }
    }

    if named.is_empty() {
        return Err(AppError::BadRequest("project has no snapshots to name".into()));
    }

    Ok(Json(json!({ "name": req.name, "docs": named })).into_response())
}

pub async fn list_checkpoints(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;

    let rows: Vec<_> = persist::list_checkpoints(&state.pool, id)
        .await?
        .into_iter()
        .map(|(doc_id, path, seq, name, created)| {
            json!({ "docId": doc_id, "path": path, "seq": seq, "name": name,
                    "createdAt": created.to_rfc3339() })
        })
        .collect();

    Ok(Json(json!({ "checkpoints": rows })).into_response())
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((doc_id, seq)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    persist::effective_role(&state.pool, user.id, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;

    let content = persist::snapshot_at(&state.pool, doc_id, seq).await?.ok_or(AppError::NotFound)?;

    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], content).into_response())
}

/// Restore = hard reset: the checkpoint file becomes a new snapshot at the head
/// of the op line and every client is told to resync. The server can't diff
/// s-expressions, so replaying a reverse-patch isn't an option.
pub async fn restore_checkpoint(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<CheckpointRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }

    let contents = persist::checkpoint_contents(&state.pool, id, &req.name).await?;
    if contents.is_empty() {
        return Err(AppError::NotFound);
    }

    let mut restored = Vec::new();

    for (doc_id, content) in contents {
        let head = persist::head_seq(&state.pool, doc_id).await?;
        let seq = head + 1;
        persist::insert_snapshot(&state.pool, doc_id, seq, &content, None, Some(user.id)).await?;

        if let Some(tx) = state.registry.existing(doc_id) {
            let _ = tx.send(crate::doc_actor::DocMsg::Reset { seq }).await;
        }

        restored.push(json!({ "docId": doc_id, "seq": seq }));
    }

    Ok(Json(json!({ "restored": req.name, "docs": restored })).into_response())
}

pub async fn healthz(State(state): State<AppState>) -> AppResult<&'static str> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok("ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_name_safety() {
        assert_eq!(safe_zip_name("main.kicad_sch").as_deref(), Some("main.kicad_sch"));
        assert_eq!(safe_zip_name("sub\\sheet.kicad_sch").as_deref(), Some("sub/sheet.kicad_sch"));
        assert!(safe_zip_name("../evil.kicad_sch").is_none());
        assert!(safe_zip_name("a/../evil.kicad_sch").is_none());
        assert!(safe_zip_name("/abs.kicad_sch").is_none());
        assert!(safe_zip_name("C:\\evil.kicad_sch").is_none());
        assert!(safe_zip_name("dir/").is_none());
    }

    #[test]
    fn file_whitelist() {
        assert!(allowed_file("main.kicad_sch"));
        assert!(allowed_file("boards/rev2.kicad_pcb"));
        assert!(allowed_file("sym-lib-table"));
        assert!(!allowed_file("evil.exe"));
        assert!(!allowed_file("notes.txt"));
    }

    /// The extraction loop must bound the decoder, not trust the header's
    /// declared uncompressed size (which a zip bomb lies about).
    #[test]
    fn zip_extraction_is_bounded_by_the_decoder() {
        use std::io::Write;

        // ~40 MB of zeros: compresses tiny, exceeds the per-file cap when read.
        let payload = vec![0u8; 40 * 1024 * 1024];
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("bomb.kicad_pcb", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&payload).unwrap();
        let archive = zip.finish().unwrap().into_inner();

        // Extract with a deliberately small cap, mirroring the handler's loop.
        let cap: u64 = 1024;
        let mut zr = zip::ZipArchive::new(Cursor::new(archive)).unwrap();
        let mut f = zr.by_index(0).unwrap();
        // f.size() is the (here honest, but attacker-controlled) header value —
        // the guard must come from the reader instead.
        let mut buf = Vec::new();
        (&mut f).take(cap + 1).read_to_end(&mut buf).unwrap();
        assert!(buf.len() as u64 > cap, "reader cap must trigger the too-large branch");
        assert_eq!(buf.len() as u64, cap + 1, "must stop at the cap, not decode 40MB");
    }
}
