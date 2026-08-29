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

/// File names KiCad projects legitimately contain: design files, project-local
/// libraries, 3D models and library tables.
fn allowed_file(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    if matches!(base, "sym-lib-table" | "fp-lib-table" | "design-block-lib-table") {
        return true;
    }
    let ext = base.rsplit('.').next().unwrap_or("");
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "kicad_pro" | "kicad_sch" | "kicad_pcb" | "kicad_prl" | "kicad_sym" | "kicad_mod"
            | "kicad_dru" | "kicad_wks" | "step" | "stp" | "wrl" | "wrz"
    )
}

/// Auto-detected document class, from the file name.  Editors join only the types
/// they know; everything else just rides along in the archive.
fn doc_type_for(path: &str) -> &'static str {
    let base = path.rsplit('/').next().unwrap_or(path);
    if matches!(base, "sym-lib-table" | "fp-lib-table" | "design-block-lib-table") {
        return "lib_table";
    }
    match base.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "kicad_sch" => "kicad_sch",
        "kicad_pcb" => "kicad_pcb",
        "kicad_pro" => "kicad_pro",
        "kicad_sym" => "symbol_lib",
        "kicad_mod" => "footprint",
        "kicad_wks" => "worksheet",
        "kicad_dru" => "design_rules",
        "step" | "stp" | "wrl" | "wrz" => "model3d",
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

/// Every project the caller owns or is a member of — the "online files" list.
pub async fn list_projects(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> AppResult<Response> {
    let projects: Vec<_> = persist::list_projects_for_user(&state.pool, user.id)
        .await?
        .into_iter()
        .map(|p| {
            json!({
                "projectId": p.id, "name": p.name,
                "ownerId": p.owner_id, "ownerLogin": p.owner_login,
                "role": p.role, "public": p.public, "docCount": p.doc_count,
                "createdAt": p.created_at.to_rfc3339(),
                "updatedAt": p.updated_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(json!({ "projects": projects })).into_response())
}

#[derive(Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub public: Option<bool>,
    pub description: Option<String>,
}

pub async fn update_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateProjectRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    let name = req.name.as_deref().map(str::trim);
    if name == Some("") {
        return Err(AppError::BadRequest("name must not be blank".into()));
    }
    let description = req.description.as_deref().map(str::trim);
    if description.is_some_and(|d| d.len() > 2000) {
        return Err(AppError::BadRequest("description too long (2000 chars max)".into()));
    }
    if name.is_none() && req.public.is_none() && description.is_none() {
        return Err(AppError::BadRequest("nothing to update".into()));
    }
    persist::update_project(&state.pool, id, name, req.public, description).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

/// The public gallery: no auth, opt-in projects only.
pub async fn gallery(State(state): State<AppState>) -> AppResult<Response> {
    let projects: Vec<_> = persist::list_public_projects(&state.pool, 100)
        .await?
        .into_iter()
        .map(|e| {
            json!({ "projectId": e.id, "name": e.name, "description": e.description,
                    "ownerLogin": e.owner_login, "docCount": e.doc_count,
                    "updatedAt": e.updated_at.to_rfc3339() })
        })
        .collect();
    Ok(Json(json!({ "projects": projects })).into_response())
}

/// Copy a visible project into the caller's account: a private copy of every
/// document at its latest checkpointed snapshot.  Live ops past the newest
/// snapshot are not included — the server has no document model to apply
/// them; the actor's snapshot-freshness requests keep that gap small.
pub async fn clone_project(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let user = auth::user_from_jar(&state, &jar).await.ok_or(AppError::Forbidden)?;
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    if !project.public {
        persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::NotFound)?;
    }

    let name = format!("{} (copy)", project.name);
    let clone = persist::create_project(&state.pool, user.id, &name).await?;

    if !project.description.is_empty() {
        persist::update_project(&state.pool, clone.id, None, None, Some(&project.description))
            .await?;
    }

    for doc in persist::project_documents(&state.pool, id).await? {
        let new_doc =
            persist::create_document(&state.pool, clone.id, &doc.path, &doc.doc_type).await?;
        if let Some((_, content)) = persist::latest_snapshot(&state.pool, doc.id).await? {
            persist::insert_snapshot(&state.pool, new_doc.id, 0, &content, Some("cloned"),
                                     Some(user.id))
                .await?;
        }
    }

    Ok(Json(json!({ "projectId": clone.id, "name": name })).into_response())
}

/// Render (and cache) an SVG preview of a project's board via kicad-cli.
/// Available to members always, and to everyone for public projects.
pub async fn preview_svg(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    if !project.public {
        let user = auth::user_from_jar(&state, &jar).await.ok_or(AppError::Forbidden)?;
        persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    }

    let Some(kicad_cli) = state.cfg.kicad_cli.clone() else {
        return Err(AppError::BadRequest("previews not enabled on this server".into()));
    };

    let docs = persist::project_documents(&state.pool, id).await?;
    let doc = docs
        .iter()
        .find(|d| d.doc_type == "kicad_pcb")
        .ok_or_else(|| AppError::BadRequest("project has no board to preview".into()))?;

    let (seq, content) =
        persist::latest_snapshot(&state.pool, doc.id).await?.ok_or(AppError::NotFound)?;

    let fit = q.fit.unwrap_or(true);
    let cache_dir = std::path::Path::new(&state.cfg.render_cache_dir);
    let cache_file = cache_dir.join(format!(
        "{}-{}-{}.svg",
        doc.id,
        seq,
        if fit { "fit" } else { "page" }
    ));

    if let Ok(bytes) = tokio::fs::read(&cache_file).await {
        return Ok(([(header::CONTENT_TYPE, "image/svg+xml")], bytes).into_response());
    }

    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|e| anyhow::anyhow!("render cache dir: {e}"))?;

    let work = cache_dir.join(format!("work-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&work).await.map_err(|e| anyhow::anyhow!("workdir: {e}"))?;
    let board_file = work.join("board.kicad_pcb");
    tokio::fs::write(&board_file, &content)
        .await
        .map_err(|e| anyhow::anyhow!("write board: {e}"))?;
    let out_file = work.join("out.svg");

    let mut cmd = tokio::process::Command::new(&kicad_cli);
    cmd.arg("pcb")
        .arg("export")
        .arg("svg")
        .args(["--layers", "F.Cu,B.Cu,Edge.Cuts,F.SilkS"])
        .arg("--exclude-drawing-sheet");
    if fit {
        cmd.arg("--fit-page-to-board");
    }
    cmd.arg("-o").arg(&out_file).arg(&board_file);

    let status = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.status())
        .await
        .map_err(|_| anyhow::anyhow!("kicad-cli timed out"))?
        .map_err(|e| anyhow::anyhow!("kicad-cli spawn: {e}"))?;

    let svg = if status.success() {
        tokio::fs::read(&out_file).await.map_err(|e| anyhow::anyhow!("read svg: {e}"))?
    } else {
        let _ = tokio::fs::remove_dir_all(&work).await;
        return Err(AppError::Other(anyhow::anyhow!("kicad-cli render failed")));
    };

    let _ = tokio::fs::write(&cache_file, &svg).await;
    let _ = tokio::fs::remove_dir_all(&work).await;

    Ok(([(header::CONTENT_TYPE, "image/svg+xml")], svg).into_response())
}

/// Best-effort footprint index for the web viewer's hit-testing: uuid, lib id
/// and position scraped from the latest board snapshot.  This is a read-only
/// convenience for the browser — the authoritative document semantics still
/// live entirely in the editors.
pub async fn board_items(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    if !project.public {
        let user = auth::user_from_jar(&state, &jar).await.ok_or(AppError::Forbidden)?;
        persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    }

    let docs = persist::project_documents(&state.pool, id).await?;
    let doc = docs
        .iter()
        .find(|d| d.doc_type == "kicad_pcb")
        .ok_or_else(|| AppError::BadRequest("project has no board".into()))?;

    let (seq, content) =
        persist::latest_snapshot(&state.pool, doc.id).await?.ok_or(AppError::NotFound)?;
    let text = String::from_utf8_lossy(&content);

    let mut items = Vec::new();
    let mut idx = 0usize;

    while let Some(rel) = text[idx..].find("(footprint \"") {
        let start = idx + rel;
        // Balanced-paren scan for the block end.
        let mut depth = 0i32;
        let mut end = start;
        for (off, ch) in text[start..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = start + off + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        if end <= start {
            break;
        }
        let block = &text[start..end];
        idx = end;

        let lib = block
            .strip_prefix("(footprint \"")
            .and_then(|r| r.split('"').next())
            .unwrap_or("")
            .to_string();
        let uuid = block
            .find("(uuid \"")
            .and_then(|p| block[p + 7..].split('"').next())
            .unwrap_or("")
            .to_string();
        // Two position forms exist in the wild: newer generators write
        // "(transform (translate x y) ...)", older ones "(at x y [rot])".
        // For the legacy form the first "(at" in the block is the
        // footprint's own — header fields precede all children.
        let parse_pair = |rest: &str| -> Option<(f64, f64)> {
            let close = rest.find(')')?;
            let mut nums = rest[..close].split_whitespace();
            let x: f64 = nums.next()?.parse().ok()?;
            let y: f64 = nums.next()?.parse().ok()?;
            Some((x, y))
        };
        let at = block
            .find("(translate ")
            .and_then(|p| parse_pair(&block[p + 11..]))
            .or_else(|| block.find("(at ").and_then(|p| parse_pair(&block[p + 4..])));

        if let (false, Some((x_mm, y_mm))) = (uuid.is_empty(), at) {
            items.push(json!({
                "id": uuid,
                "lib": lib,
                "x": (x_mm * 1e6) as i64,
                "y": (y_mm * 1e6) as i64,
            }));
        }
    }

    Ok(Json(json!({ "docId": doc.id, "seq": seq, "footprints": items })).into_response())
}

#[derive(Deserialize)]
pub struct NewCommentRequest {
    pub body: String,
    #[serde(default)]
    pub x: i64,
    #[serde(default)]
    pub y: i64,
    #[serde(rename = "parentId")]
    pub parent_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateCommentRequest {
    pub resolved: Option<bool>,
}

/// Comment access: any member may read and write (commenting is the viewer
/// role's superpower); anyone may read on public projects.
async fn comment_access(
    state: &AppState,
    jar: &axum_extra::extract::CookieJar,
    auth_user: Option<&persist::User>,
    doc_id: Uuid,
    write: bool,
) -> Result<(persist::Document, Option<persist::User>), AppError> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let project =
        persist::get_project(&state.pool, doc.project_id).await?.ok_or(AppError::NotFound)?;

    let user = match auth_user {
        Some(u) => Some(u.clone()),
        None => auth::user_from_jar(state, jar).await,
    };

    let member_role = match &user {
        Some(u) => persist::effective_role(&state.pool, u.id, doc.project_id).await?,
        None => None,
    };

    if write {
        if user.is_none() || (member_role.is_none() && !project.public) {
            return Err(AppError::Forbidden);
        }
    } else if member_role.is_none() && !project.public {
        return Err(AppError::Forbidden);
    }

    Ok((doc, user))
}

pub async fn list_comments(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let _ = comment_access(&state, &jar, None, doc_id, false).await?;

    let comments: Vec<_> = persist::list_comments(&state.pool, doc_id)
        .await?
        .iter()
        .map(persist::Comment::to_json)
        .collect();

    Ok(Json(json!({ "comments": comments })).into_response())
}

pub async fn create_comment(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(doc_id): Path<Uuid>,
    Json(req): Json<NewCommentRequest>,
) -> AppResult<Response> {
    let (_, user) = comment_access(&state, &jar, None, doc_id, true).await?;
    let user = user.ok_or(AppError::Forbidden)?;

    let body = req.body.trim();

    if body.is_empty() || body.len() > 4000 {
        return Err(AppError::BadRequest("comment must be 1-4000 characters".into()));
    }

    // A reply inherits its thread; it must reference a root on the same doc.
    if let Some(parent_id) = req.parent_id {
        let parent =
            persist::get_comment(&state.pool, parent_id).await?.ok_or(AppError::NotFound)?;

        if parent.doc_id != doc_id || parent.parent_id.is_some() {
            return Err(AppError::BadRequest("parentId must be a root comment here".into()));
        }
    }

    let comment = persist::insert_comment(&state.pool, doc_id, req.parent_id, user.id, req.x,
                                          req.y, body)
        .await?;

    if let Some(tx) = state.registry.existing(doc_id) {
        let _ = tx
            .send(crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "added", "comment": comment.to_json() }),
            })
            .await;
    }

    Ok(Json(comment.to_json()).into_response())
}

pub async fn update_comment(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<i64>,
    Json(req): Json<UpdateCommentRequest>,
) -> AppResult<Response> {
    let comment = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let (doc, user) = comment_access(&state, &jar, None, comment.doc_id, true).await?;
    let user = user.ok_or(AppError::Forbidden)?;

    // Anyone who can comment may resolve/unresolve (the Figma model); only
    // the author or the project owner may do anything else later.
    let Some(resolved) = req.resolved else {
        return Err(AppError::BadRequest("nothing to update".into()));
    };

    let _ = (doc, user);
    persist::set_comment_resolved(&state.pool, id, resolved).await?;

    let updated = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    if let Some(tx) = state.registry.existing(updated.doc_id) {
        let _ = tx
            .send(crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "updated", "comment": updated.to_json() }),
            })
            .await;
    }

    Ok(Json(updated.to_json()).into_response())
}

pub async fn delete_comment(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let comment = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let (_, user) = comment_access(&state, &jar, None, comment.doc_id, true).await?;
    let user = user.ok_or(AppError::Forbidden)?;

    let doc =
        persist::get_document(&state.pool, comment.doc_id).await?.ok_or(AppError::NotFound)?;
    let owner_id =
        persist::get_project(&state.pool, doc.project_id).await?.map(|p| p.owner_id);

    if comment.author_id != user.id && owner_id != Some(user.id) {
        return Err(AppError::Forbidden);
    }

    persist::delete_comment(&state.pool, id).await?;

    if let Some(tx) = state.registry.existing(comment.doc_id) {
        let _ = tx
            .send(crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "deleted",
                                 "comment": { "id": id, "docId": comment.doc_id } }),
            })
            .await;
    }

    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    pub fit: Option<bool>,
}

/// Owner deletes the whole project. Live doc actors are not kicked — their
/// next durable write fails and clients surface the error; the actors reap
/// themselves once idle.
pub async fn delete_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    persist::delete_project(&state.pool, id).await?;
    Ok(Json(json!({ "ok": true })).into_response())
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
    let pending: Vec<_> = persist::list_pending_invites(&state.pool, id)
        .await?
        .into_iter()
        .map(|(perm_id, login, email, role)| {
            json!({ "inviteId": perm_id, "login": login, "email": email, "role": role })
        })
        .collect();
    Ok(Json(json!({ "ownerId": project.owner_id, "members": members, "pending": pending }))
        .into_response())
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, invite_id)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    if persist::delete_pending_invite(&state.pool, id, invite_id).await? {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
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

    // If the invitee already has an account, grant access immediately instead
    // of parking a pending row they would only pick up at next sign-in.
    let existing = match (&req.login, &req.email) {
        (Some(login), _) => persist::find_user_by_login(&state.pool, login).await?,
        (None, Some(email)) => persist::find_user_by_email(&state.pool, email).await?,
        (None, None) => None,
    };

    if let Some(invitee) = existing {
        if invitee.id == project.owner_id {
            return Err(AppError::BadRequest("that user owns this project".into()));
        }
        persist::grant_role(&state.pool, id, invitee.id, &role).await?;
        return Ok(Json(json!({
            "ok": true, "status": "granted",
            "userId": invitee.id, "login": invitee.login,
        }))
        .into_response());
    }

    persist::add_invite(&state.pool, id, req.login.as_deref(), req.email.as_deref(), &role, user.id)
        .await?;
    Ok(Json(json!({ "ok": true, "status": "pending" })).into_response())
}

// ---------- User search (share-dialog typeahead) ----------

#[derive(Deserialize)]
pub struct UserSearchQuery {
    pub q: String,
}

/// Prefix search over server accounts, topped up with GitHub user search when
/// OAuth credentials are configured — so the share dialog can find people who
/// have never signed in here, the way GitHub's collaborator picker does.
pub async fn search_users(
    State(state): State<AppState>,
    AuthUser(_user): AuthUser,
    Query(q): Query<UserSearchQuery>,
) -> AppResult<Response> {
    const MAX_RESULTS: usize = 8;

    let query = q.q.trim();
    if query.len() < 2 || query.len() > 64 {
        return Ok(Json(json!({ "users": [] })).into_response());
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for u in persist::search_users(&state.pool, query, MAX_RESULTS as i64).await? {
        seen.insert(u.login.to_lowercase());
        out.push(json!({
            "login": u.login, "name": u.name, "avatarUrl": u.avatar_url,
            "userId": u.id, "source": "server",
        }));
    }

    if out.len() < MAX_RESULTS {
        if let (Some(client_id), Some(client_secret)) =
            (&state.cfg.github_client_id, &state.cfg.github_client_secret)
        {
            if let Some(items) = github_user_search(query, client_id, client_secret).await {
                for item in items {
                    if out.len() >= MAX_RESULTS {
                        break;
                    }
                    if seen.insert(item.login.to_lowercase()) {
                        out.push(json!({
                            "login": item.login, "name": serde_json::Value::Null,
                            "avatarUrl": item.avatar_url, "userId": serde_json::Value::Null,
                            "source": "github",
                        }));
                    }
                }
            }
        }
    }

    Ok(Json(json!({ "users": out })).into_response())
}

#[derive(Deserialize)]
struct GithubSearchUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GithubSearchResponse {
    #[serde(default)]
    items: Vec<GithubSearchUser>,
}

/// Best-effort: any failure (rate limit, timeout) just means fewer results.
async fn github_user_search(
    query: &str,
    client_id: &str,
    client_secret: &str,
) -> Option<Vec<GithubSearchUser>> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = http
        .get("https://api.github.com/search/users")
        .query(&[("q", format!("{query} in:login")), ("per_page", "10".into())])
        // OAuth-app basic auth lifts the anonymous search rate limit.
        .basic_auth(client_id, Some(client_secret))
        .header(reqwest::header::USER_AGENT, "kicad-collab-server")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<GithubSearchResponse>().await.ok().map(|r| r.items)
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
    // Insert-only: a snapshot at this seq may already exist (another client
    // answered the same freshness request, or this seq is a named checkpoint,
    // which an update would silently clobber — that corrupted a restore once).
    let written =
        persist::insert_snapshot_new(&state.pool, doc_id, q.seq, &body, Some(user.id)).await?;
    Ok(Json(json!({ "ok": true, "docId": doc_id, "seq": q.seq, "written": written }))
        .into_response())
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
