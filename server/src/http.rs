use std::io::{Cursor, Read, Write};

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

use crate::access::{self, Role, Viewer};
use crate::auth::{self, AuthUser};
use crate::error::{AppError, AppResult};
use crate::lenient_json::LenientJson;
use crate::persist;
use crate::AppState;

pub(crate) const MAX_FILES: usize = 200;
pub(crate) const MAX_FILE_BYTES: u64 = 30 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

/// File names KiCad projects legitimately contain: design files, project-local
/// libraries, 3D models and library tables.
pub(crate) fn allowed_file(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    if matches!(base, "sym-lib-table" | "fp-lib-table" | "design-block-lib-table") {
        return true;
    }
    let ext = base.rsplit('.').next().unwrap_or("");
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "kicad_pro" | "kicad_sch" | "kicad_pcb" | "kicad_prl" | "kicad_sym" | "kicad_mod"
            | "kicad_dru" | "kicad_wks" | "step" | "stp" | "wrl" | "wrz"
            // SPICE / IBIS simulation model libraries (DIALOG_SIM_MODEL's "Browse Models" filter)
            | "lib" | "sub" | "cir" | "mod" | "spice" | "ibs"
    )
}

/// Auto-detected document class, from the file name.  Editors join only the types
/// they know; everything else just rides along in the archive.
pub(crate) fn doc_type_for(path: &str) -> &'static str {
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
        "lib" | "sub" | "cir" | "mod" | "spice" | "ibs" => "spice_model",
        _ => "other",
    }
}

/// A path inside a project's own bookkeeping: `<name>.collab/` (sync bases, journals),
/// `<name>-backups/`, `.history/` or `.git/`.  Never project content.
pub(crate) fn is_local_state_path(name: &str) -> bool {
    name.split('/').any(|dir| {
        dir.ends_with(".collab") || dir.ends_with("-backups") || dir == ".history" || dir == ".git"
    })
}

pub(crate) fn safe_zip_name(name: &str) -> Option<String> {
    let name = name.replace('\\', "/");
    if name.is_empty()
        || name.ends_with('/')
        || name.starts_with('/')
        || name.contains("..")
        || name.contains(':')
        || name.chars().any(char::is_control)
    {
        return None;
    }
    // "a//b" and "a/./b" name the same file as "a/b": store one spelling, or two
    // documents of a project end up pointing at one local file.
    let parts: Vec<&str> = name.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Drop a directory every file shares ("board/board.kicad_pro" -> "board.kicad_pro"),
/// but only when the project file itself sits inside it: nested sheet folders
/// of a project uploaded from its root must keep their paths.
fn strip_common_dir(files: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    let Some(first) = files.first().and_then(|(n, _)| n.split_once('/').map(|(d, _)| d.to_string()))
    else {
        return files;
    };
    let prefix = format!("{first}/");
    let all_inside = files.iter().all(|(n, _)| n.starts_with(&prefix));
    let has_root_pro = files.iter().any(|(n, _)| !n.contains('/') && n.ends_with(".kicad_pro"));
    if !all_inside || has_root_pro {
        return files;
    }
    strip_common_dir(
        files.into_iter().map(|(n, b)| (n[prefix.len()..].to_string(), b)).collect(),
    )
}

// ---------- Projects ----------

pub async fn create_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    mut multipart: Multipart,
) -> AppResult<Response> {
    let mut archive: Option<Vec<u8>> = None;
    let mut name: Option<String> = None;
    // Loose files (the web's folder / multi-file upload): each `file` part
    // carries its project-relative path as the part's file name.
    let mut loose: Vec<(String, Vec<u8>)> = Vec::new();
    let mut loose_bytes: u64 = 0;
    let mut skipped: Vec<String> = Vec::new();
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
            Some("file") => {
                let raw = field.file_name().unwrap_or("").to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(format!("file read failed: {e}")))?;
                let Some(path) = safe_zip_name(&raw) else {
                    return Err(AppError::BadRequest(format!("unsafe file path: {raw}")));
                };
                if is_local_state_path(&path) {
                    continue;
                }
                if !allowed_file(&path) {
                    skipped.push(path);
                    continue;
                }
                if loose.len() >= MAX_FILES {
                    return Err(AppError::BadRequest(format!("too many files (max {MAX_FILES})")));
                }
                loose_bytes += bytes.len() as u64;
                if bytes.len() as u64 > MAX_FILE_BYTES || loose_bytes > MAX_TOTAL_BYTES {
                    return Err(AppError::BadRequest(format!("{path} is too large")));
                }
                loose.push((path, bytes.to_vec()));
            }
            _ => {}
        }
    }

    let files = if let Some(archive) = archive {
        // Unzip + validate off the async runtime.
        let (files, zip_skipped) = tokio::task::spawn_blocking(
            move || -> Result<(Vec<(String, Vec<u8>)>, Vec<String>), String> {
                let mut zip =
                    zip::ZipArchive::new(Cursor::new(archive)).map_err(|e| e.to_string())?;
                if zip.len() > MAX_FILES {
                    return Err(format!("too many files (max {MAX_FILES})"));
                }
                let mut out = Vec::new();
                let mut skipped = Vec::new();
                let mut budget = MAX_TOTAL_BYTES;
                for i in 0..zip.len() {
                    let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
                    if f.is_dir() {
                        continue;
                    }
                    let Some(name) = safe_zip_name(f.name()) else {
                        return Err(format!("unsafe path in archive: {}", f.name()));
                    };
                    // People zip whole project folders: the sync folder, backups and local
                    // history hold copies of the design (a `<name>.collab/base/x.kicad_pcb`
                    // once became a second board document of a project), so those
                    // directories are skipped.
                    if is_local_state_path(&name) {
                        continue;
                    }
                    // Anything that is not a KiCad project file (a README, gerbers, a
                    // .DS_Store) is left out rather than failing the whole upload.
                    if !allowed_file(&name) {
                        skipped.push(name);
                        continue;
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
                Ok((out, skipped))
            },
        )
        .await
        .map_err(|e| anyhow::anyhow!("unzip task failed: {e}"))?
        .map_err(AppError::BadRequest)?;
        skipped.extend(zip_skipped);
        files
    } else if !loose.is_empty() || !skipped.is_empty() {
        loose
    } else {
        return Err(AppError::BadRequest("missing 'archive' field".into()));
    };

    // A zipped or dropped folder puts everything under one top-level directory
    // ("myboard/myboard.kicad_pro"); documents are stored project-relative.
    let files = strip_common_dir(files);
    // Two files that differ only in case cannot both exist in a working copy on
    // Windows or macOS, and the same path twice has no meaning at all.
    {
        let mut seen = std::collections::HashSet::new();
        for (path, _) in &files {
            if !seen.insert(path.to_lowercase()) {
                return Err(AppError::BadRequest(format!("duplicate file: {path}")));
            }
        }
    }
    if files.is_empty() {
        return Err(AppError::BadRequest(
            "no KiCad project files found (expected .kicad_pro, .kicad_sch, .kicad_pcb, …)".into(),
        ));
    }

    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if let Some(n) = &name {
        checked_name(n)?;
    }
    let project_name = name
        .or_else(|| {
            files.iter().find(|(n, _)| n.ends_with(".kicad_pro")).map(|(n, _)| {
                n.rsplit('/').next().unwrap_or(n).trim_end_matches(".kicad_pro").trim().to_string()
            })
        })
        // A file called ".kicad_pro" or "  .kicad_pro" gives no usable name.
        .filter(|n| !n.is_empty() && checked_name(n).is_ok())
        .unwrap_or_else(|| "untitled".to_string());
    let project_name: String = project_name.chars().take(MAX_NAME_CHARS).collect();

    let project = persist::create_project(&state.pool, user.id, &project_name).await?;
    let mut docs = Vec::new();
    for (path, content) in &files {
        let stored = async {
            let doc =
                persist::create_document(&state.pool, project.id, path, doc_type_for(path)).await?;
            persist::insert_snapshot(&state.pool, doc.id, 0, content, None, Some(user.id)).await?;
            Ok::<_, sqlx::Error>(doc)
        }
        .await;
        match stored {
            Ok(doc) => {
                docs.push(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type }))
            }
            Err(e) => {
                // Never leave half a project behind.
                let _ = persist::delete_project(&state.pool, project.id).await;
                return Err(e.into());
            }
        }
    }

    Ok(Json(json!({
        "projectId": project.id, "name": project.name, "docs": docs, "skipped": skipped,
    }))
    .into_response())
}

/// Every project the caller owns or is a member of — the "online files" list.
pub async fn list_projects(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> AppResult<Response> {
    let list = persist::list_projects_for_user(&state.pool, user.id).await?;
    let ids: Vec<Uuid> = list.iter().map(|p| p.id).collect();
    let linked = crate::github::linked_repos(&state.pool, &ids).await?;
    let projects: Vec<_> = list
        .into_iter()
        .map(|p| {
            json!({
                "github": linked.get(&p.id),
                "projectId": p.id, "name": p.name,
                "description": p.description,
                "ownerId": p.owner_id, "ownerLogin": p.owner_login,
                "ownerAvatarUrl": p.owner_avatar_url,
                "role": p.role, "public": p.public, "canCopy": p.can_copy, "docCount": p.doc_count,
                "memberCount": p.member_count, "starred": p.starred,
                "createdAt": p.created_at.to_rfc3339(),
                "updatedAt": p.updated_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(json!({ "projects": projects })).into_response())
}

const MAX_NAME_CHARS: usize = 120;

pub(crate) fn checked_name(name: &str) -> AppResult<()> {
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::BadRequest(format!("name too long ({MAX_NAME_CHARS} characters max)")));
    }
    // "." and ".." would become a folder name on a collaborator's disk.
    if name.chars().all(|c| c == '.' || c == ' ') {
        return Err(AppError::BadRequest("name must contain a letter or a digit".into()));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::BadRequest("name must not contain control characters".into()));
    }
    Ok(())
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
    LenientJson(req): LenientJson<UpdateProjectRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    let name = req.name.as_deref().map(str::trim);
    if name == Some("") {
        return Err(AppError::BadRequest("name must not be blank".into()));
    }
    if let Some(n) = name {
        checked_name(n)?;
    }
    let description = req.description.as_deref().map(str::trim);
    if description.is_some_and(|d| d.len() > 2000) {
        return Err(AppError::BadRequest("description too long (2000 chars max)".into()));
    }
    if name.is_none() && req.public.is_none() && description.is_none() {
        return Err(AppError::BadRequest("nothing to update".into()));
    }
    persist::update_project(&state.pool, id, name, req.public, description).await?;
    if req.public.is_some() {
        state.access_changed();
    }
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
    // AuthUser takes the web's cookie and the desktop's bearer token alike.
    AuthUser(user): AuthUser,
    Viewer { links, .. }: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    let access = access::resolve(&state.pool, &Viewer { user: Some(user.clone()), links },
                                 id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !access.can_copy() {
        return Err(AppError::Api(
            StatusCode::FORBIDDEN,
            "copy_disabled",
            "The owner of this project does not let viewers make copies.".into(),
        ));
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
    access::resolve(&state.pool, &Viewer::from_jar(&state, &jar).await, id)
        .await?
        .ok_or(AppError::Forbidden)?;

    let Some(kicad_cli) = state.cfg.kicad_cli.clone() else {
        // No renderer on this server: serve the latest client-pushed preview.
        let docs = persist::project_documents(&state.pool, id).await?;
        // Board first.  A project with no board, or whose board has nothing on it yet (nobody
        // pushes a picture of an empty board), shows its root sheet.
        let fit = q.fit.unwrap_or(true);
        let mut svg = None;
        for doc in docs.iter().find(|d| d.doc_type == "kicad_pcb").into_iter().chain(root_schematic(&docs)) {
            if let Some((_seq, found)) = persist::get_preview(&state.pool, doc.id, fit).await? {
                svg = Some(found);
                break;
            }
        }
        let Some(svg) = svg else {
            return Err(AppError::NotFound);
        };

        return Ok((
            [
                (axum::http::header::CONTENT_TYPE, "image/svg+xml"),
                // not "public": a private project's picture must not sit in a shared cache
                (axum::http::header::CACHE_CONTROL, "private, max-age=60"),
            ],
            svg,
        )
            .into_response());
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
/// Project summary for the web app: public projects for anyone, private
/// ones for members.  Carries the docs so the client can join the board.
pub async fn project_info(
    State(state): State<AppState>,
    who: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    
    let access = access::resolve(&state.pool, &who, id).await?.ok_or(AppError::NotFound)?;
    let viewer = who.user;
    let owner = persist::get_user(&state.pool, project.owner_id).await?;
    let all_docs = persist::project_documents(&state.pool, id).await?;
    let ids: Vec<Uuid> = all_docs.iter().map(|d| d.id).collect();
    let rendered: std::collections::HashSet<Uuid> =
        persist::docs_with_previews(&state.pool, &ids).await?.into_iter().collect();
    let docs: Vec<_> = all_docs
        
        .iter()
        .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type,
                         "hasPreview": rendered.contains(&d.id) }))
        .collect();
    Ok(Json(json!({
        "projectId": project.id, "name": project.name, "description": project.description,
        "public": project.public, "ownerId": project.owner_id,
        "ownerLogin": owner.map(|o| o.login).unwrap_or_default(),
        "role": access.role_str(), "docs": docs,
        // What the interface should offer; the server decides again on every request.
        "can": access.can_json(),
        "isOwner": access.owner, "isMember": access.member,
        "permissions": access.settings.to_json(),
        "viewer": viewer.map(|u| json!({ "id": u.id, "login": u.login })),
    }))
    .into_response())
}

/// The root sheet of a project: the schematic whose file name matches the
/// project, else the shortest path (a top-level sheet beats a nested one).
fn root_schematic(docs: &[persist::Document]) -> Option<&persist::Document> {
    let pro_stem = docs
        .iter()
        .find(|d| d.doc_type == "kicad_pro")
        .and_then(|d| d.path.rsplit('/').next())
        .and_then(|b| b.strip_suffix(".kicad_pro"))
        .map(str::to_string);
    let mut sheets: Vec<&persist::Document> = docs.iter().filter(|d| d.doc_type == "kicad_sch").collect();
    if let Some(stem) = pro_stem {
        if let Some(d) = sheets.iter().find(|d| d.path.rsplit('/').next() == Some(&format!("{stem}.kicad_sch"))) {
            return Some(d);
        }
    }
    sheets.sort_by_key(|d| (d.path.matches('/').count(), d.path.len()));
    sheets.first().copied()
}

async fn doc_with_access(
    state: &AppState,
    jar: &axum_extra::extract::CookieJar,
    doc_id: Uuid,
) -> AppResult<persist::Document> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    access::resolve(&state.pool, &Viewer::from_jar(state, jar).await, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    Ok(doc)
}

/// Per-document preview (a board or one schematic sheet), client-pushed by
/// the desktop editors.  Either fit variant serves when only one exists.
pub async fn doc_preview_svg(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(doc_id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
) -> AppResult<Response> {
    let doc = doc_with_access(&state, &jar, doc_id).await?;
    let fit = q.fit.unwrap_or(true);
    let preview = match persist::get_preview(&state.pool, doc.id, fit).await? {
        Some(p) => Some(p),
        None => persist::get_preview(&state.pool, doc.id, !fit).await?,
    };
    let Some((_seq, svg)) = preview else { return Err(AppError::NotFound) };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "image/svg+xml"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=60"),
        ],
        svg,
    )
        .into_response())
}

/// Balanced-paren block starting at `start`; `None` if unbalanced.
fn sexpr_block(text: &str, start: usize) -> Option<&str> {
    let mut depth = 0i32;
    for (off, ch) in text[start..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..start + off + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The next quoted string after optional whitespace, and what follows it.
/// (Editors serialize with varying whitespace: `(property  "Reference"`.)
fn next_quoted(rest: &str) -> Option<(&str, &str)> {
    let t = rest.trim_start().strip_prefix('"')?;
    let end = t.find('"')?;
    Some((&t[..end], &t[end + 1..]))
}

/// The quoted string following `key` (e.g. `(uuid`), whitespace-tolerant.
fn quoted_after<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.find(key).and_then(|p| next_quoted(&block[p + key.len()..]).map(|(v, _)| v))
}

/// The value of the `(property "<name>" "<value>" ...)` entry called `name`.
fn prop_value<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let mut idx = 0usize;
    while let Some(rel) = block[idx..].find("(property") {
        let p = idx + rel + "(property".len();
        if let Some((n, rest)) = next_quoted(&block[p..]) {
            if n == name {
                return next_quoted(rest).map(|(v, _)| v);
            }
        }
        idx = p;
    }
    None
}

/// Numbers inside the `(key n n n)` list, whitespace-tolerant.
fn nums_after(block: &str, key: &str) -> Vec<f64> {
    match block.find(key) {
        Some(p) => {
            let rest = &block[p + key.len()..];
            match rest.find(')') {
                Some(close) => rest[..close].split_whitespace().filter_map(|n| n.parse().ok()).collect(),
                None => Vec::new(),
            }
        }
        None => Vec::new(),
    }
}

/// Schematic sheet contents for the web editor: placed symbols (with
/// reference/value) and hierarchical sheets, scraped from the latest
/// snapshot.  Coordinates are in millimetres as written in the file.
pub async fn doc_items(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let doc = doc_with_access(&state, &jar, doc_id).await?;
    if doc.doc_type != "kicad_sch" {
        return Err(AppError::BadRequest("items are only scraped for schematic sheets".into()));
    }
    let (seq, content) =
        persist::latest_snapshot(&state.pool, doc.id).await?.ok_or(AppError::NotFound)?;
    let text = String::from_utf8_lossy(&content);

    // Library definitions live in one big (lib_symbols ...) block; skip it.
    let lib_span = text
        .find("(lib_symbols")
        .and_then(|p| sexpr_block(&text, p).map(|b| (p, p + b.len())));
    let in_lib = |pos: usize| lib_span.is_some_and(|(a, b)| pos >= a && pos < b);

    let mut symbols = Vec::new();
    let mut sheets = Vec::new();
    let mut idx = 0usize;
    while let Some(rel) = text[idx..].find("(s") {
        let start = idx + rel;
        let rest = &text[start..];
        let head = if rest.starts_with("(symbol") { "symbol" } else if rest.starts_with("(sheet") { "sheet" } else { "" };
        if head.is_empty() || in_lib(start) {
            idx = start + 2;
            continue;
        }
        let Some(block) = sexpr_block(&text, start) else { break };
        let body = block[1 + head.len()..].trim_start();
        // Placed symbols open with (lib_id ...); sheets with (at ...).  Anything
        // else (lib definitions, sheet_instances) is not ours.
        if head == "symbol" && body.starts_with("(lib_id") {
            let at = nums_after(block, "(at");
            symbols.push(json!({
                "id": quoted_after(block, "(uuid").unwrap_or(""),
                "lib": quoted_after(block, "(lib_id").unwrap_or(""),
                "ref": prop_value(block, "Reference").unwrap_or(""),
                "value": prop_value(block, "Value").unwrap_or(""),
                "x": at.first().copied().unwrap_or(0.0),
                "y": at.get(1).copied().unwrap_or(0.0),
                "rot": at.get(2).copied().unwrap_or(0.0),
            }));
        } else if head == "sheet" && body.starts_with("(at") {
            let at = nums_after(block, "(at");
            let size = nums_after(block, "(size");
            sheets.push(json!({
                "id": quoted_after(block, "(uuid").unwrap_or(""),
                "name": prop_value(block, "Sheetname").unwrap_or(""),
                "file": prop_value(block, "Sheetfile").unwrap_or(""),
                "x": at.first().copied().unwrap_or(0.0),
                "y": at.get(1).copied().unwrap_or(0.0),
                "w": size.first().copied().unwrap_or(0.0),
                "h": size.get(1).copied().unwrap_or(0.0),
            }));
        }
        idx = start + block.len();
    }

    Ok(Json(json!({ "seq": seq, "symbols": symbols, "sheets": sheets })).into_response())
}

pub async fn board_items(
    State(state): State<AppState>,
    jar: axum_extra::extract::CookieJar,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    access::resolve(&state.pool, &Viewer::from_jar(&state, &jar).await, id)
        .await?
        .ok_or(AppError::Forbidden)?;

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
        let parse_nums = |rest: &str| -> Vec<f64> {
            match rest.find(')') {
                Some(close) => rest[..close]
                    .split_whitespace()
                    .filter_map(|n| n.parse().ok())
                    .collect(),
                None => Vec::new(),
            }
        };
        // Newer generators: (transform (translate x y) (rotate r)); legacy: (at x y [r]).
        let (at, rot) = if let Some(p) = block.find("(translate ") {
            let pair = parse_nums(&block[p + 11..]);
            let rot = block
                .find("(rotate ")
                .map(|rp| parse_nums(&block[rp + 8..]))
                .and_then(|v| v.first().copied())
                .unwrap_or(0.0);
            (
                (pair.len() >= 2).then(|| (pair[0], pair[1])),
                rot,
            )
        } else if let Some(p) = block.find("(at ") {
            let nums = parse_nums(&block[p + 4..]);
            (
                (nums.len() >= 2).then(|| (nums[0], nums[1])),
                nums.get(2).copied().unwrap_or(0.0),
            )
        } else {
            (None, 0.0)
        };

        if let (false, Some((x_mm, y_mm))) = (uuid.is_empty(), at) {
            items.push(json!({
                "id": uuid,
                "lib": lib,
                "x": (x_mm * 1e6) as i64,
                "y": (y_mm * 1e6) as i64,
                "rot": rot,
            }));
        }
    }

    Ok(Json(json!({ "docId": doc.id, "seq": seq, "footprints": items })).into_response())
}

/// What a thread is pinned to, as the clients send it.
#[derive(Deserialize)]
pub struct AnchorRequest {
    /// "item" (a part, a track … by uuid) or "net".
    pub kind: String,
    /// The item's uuid, or the net's name.
    pub id: String,
    /// What a person calls it: "R1", "GND".
    #[serde(default)]
    pub label: String,
    /// For a net: the uuid of the item the thread was started on.
    pub item: Option<String>,
}

impl AnchorRequest {
    fn checked(self) -> AppResult<persist::CommentAnchor> {
        let id = self.id.trim().to_string();
        let label = self.label.trim().to_string();
        let item = self.item.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if self.kind != "item" && self.kind != "net" {
            return Err(AppError::BadRequest("anchor kind must be item or net".into()));
        }
        if id.is_empty() || id.len() > 300 || label.len() > 300 || item.as_ref().is_some_and(|s| s.len() > 100) {
            return Err(AppError::BadRequest("bad anchor".into()));
        }
        Ok(persist::CommentAnchor { kind: self.kind, id, label, item })
    }
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
    /// The part or net a new thread is about; replies have none.
    pub anchor: Option<AnchorRequest>,
}

#[derive(Deserialize)]
pub struct UpdateCommentRequest {
    pub resolved: Option<bool>,
    /// New text (the author only).
    pub body: Option<String>,
    /// Move the thread's pin: a new position, and optionally a new anchor.
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub anchor: Option<AnchorRequest>,
    /// true drops the anchor, leaving the thread pinned to its position.
    #[serde(default)]
    pub unpin: bool,
}

/// Comment access (access.rs): anyone who can see the project reads its comments;
/// writing one (a new thread, a reply, resolving) takes the commenter role or more,
/// and an account to write it as.
async fn comment_access(
    state: &AppState,
    viewer: &Viewer,
    doc_id: Uuid,
    write: bool,
) -> Result<(persist::Document, Option<persist::User>), AppError> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let access = access::resolve(&state.pool, viewer, doc.project_id).await?.ok_or(AppError::Forbidden)?;

    if write && !access.can_comment() {
        return Err(if viewer.user.is_none() {
            AppError::Unauthorized
        } else {
            AppError::Api(
                StatusCode::FORBIDDEN,
                "comment_denied",
                "You can view this project but not comment on it.".into(),
            )
        });
    }

    Ok((doc, viewer.user.clone()))
}

pub async fn list_comments(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let _ = comment_access(&state, &viewer, doc_id, false).await?;

    let comments: Vec<_> = persist::list_comments(&state.pool, doc_id)
        .await?
        .iter()
        .map(persist::Comment::to_json)
        .collect();

    Ok(Json(json!({ "comments": comments })).into_response())
}

/// Every thread of a project, document by document: the review list.
pub async fn list_project_comments(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(project_id): Path<Uuid>,
) -> AppResult<Response> {
    // The same rule as one document's comments: whoever can see the project reads them.
    persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    access::resolve(&state.pool, &viewer, project_id).await?.ok_or(AppError::Forbidden)?;
    let docs = persist::project_documents(&state.pool, project_id).await?;

    let comments: Vec<_> = persist::list_project_comments(&state.pool, project_id)
        .await?
        .iter()
        .map(persist::Comment::to_json)
        .collect();
    let docs: Vec<_> = docs
        .iter()
        .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type }))
        .collect();

    Ok(Json(json!({ "comments": comments, "docs": docs })).into_response())
}

pub async fn create_comment(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(doc_id): Path<Uuid>,
    LenientJson(req): LenientJson<NewCommentRequest>,
) -> AppResult<Response> {
    let (_, user) = comment_access(&state, &viewer, doc_id, true).await?;
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

    // Only a thread's root is pinned to something.
    let anchor = match (req.anchor, req.parent_id) {
        (Some(a), None) => Some(a.checked()?),
        _ => None,
    };

    let comment = persist::insert_comment(&state.pool, doc_id, req.parent_id, user.id, req.x,
                                          req.y, body, anchor.as_ref())
        .await?;

    state
        .doc_event(doc_id, crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "added", "comment": comment.to_json() }),
        })
        .await;

    Ok(Json(comment.to_json()).into_response())
}

pub async fn update_comment(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<i64>,
    LenientJson(req): LenientJson<UpdateCommentRequest>,
) -> AppResult<Response> {
    let comment = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let (doc, user) = comment_access(&state, &viewer, comment.doc_id, true).await?;
    let user = user.ok_or(AppError::Forbidden)?;

    let _ = doc;
    let mut any = false;

    // Anyone who can comment may resolve/unresolve (the Figma model).
    if let Some(resolved) = req.resolved {
        persist::set_comment_resolved(&state.pool, id, resolved).await?;
        any = true;
    }

    // The text belongs to its author.
    if let Some(body) = &req.body {
        if comment.author_id != user.id {
            return Err(AppError::Forbidden);
        }
        let body = body.trim();
        if body.is_empty() || body.len() > 4000 {
            return Err(AppError::BadRequest("comment must be 1-4000 characters".into()));
        }
        persist::update_comment_body(&state.pool, id, body).await?;
        any = true;
    }

    // Anyone who can comment may move a thread's pin (to another part, a net, or a bare spot).
    if req.anchor.is_some() || req.unpin || req.x.is_some() || req.y.is_some() {
        if comment.parent_id.is_some() {
            return Err(AppError::BadRequest("only a thread's first comment is pinned".into()));
        }
        let anchor = match req.anchor {
            Some(a) => Some(a.checked()?),
            None if req.unpin => None,
            None => comment.anchor_kind.clone().map(|kind| persist::CommentAnchor {
                kind,
                id: comment.anchor_id.clone().unwrap_or_default(),
                label: comment.anchor_label.clone().unwrap_or_default(),
                item: comment.anchor_item.clone(),
            }),
        };
        persist::set_comment_anchor(&state.pool, id, req.x.unwrap_or(comment.x_nm),
                                    req.y.unwrap_or(comment.y_nm), anchor.as_ref())
            .await?;
        any = true;
    }

    if !any {
        return Err(AppError::BadRequest("nothing to update".into()));
    }

    let updated = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;

    state
        .doc_event(updated.doc_id, crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "updated", "comment": updated.to_json() }),
        })
        .await;

    Ok(Json(updated.to_json()).into_response())
}

pub async fn delete_comment(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let comment = persist::get_comment(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    // Taking a comment back needs no right to write new ones: its author may, whatever
    // their role is now, and so may the owner.
    let (_, user) = comment_access(&state, &viewer, comment.doc_id, false).await?;
    let user = user.ok_or(AppError::Forbidden)?;

    let doc =
        persist::get_document(&state.pool, comment.doc_id).await?.ok_or(AppError::NotFound)?;
    let owner_id =
        persist::get_project(&state.pool, doc.project_id).await?.map(|p| p.owner_id);

    if comment.author_id != user.id && owner_id != Some(user.id) {
        return Err(AppError::Forbidden);
    }

    persist::delete_comment(&state.pool, id).await?;

    state
        .doc_event(comment.doc_id, crate::doc_actor::DocMsg::Comment {
                payload: json!({ "action": "deleted",
                                 "comment": { "id": id, "docId": comment.doc_id } }),
        })
        .await;

    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    pub fit: Option<bool>,
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub permanent: bool,
}

/// Owner deletes the whole project.  By default it goes to the Trash, where it
/// can be restored for 30 days; `?permanent=true` destroys it at once.  Either
/// way it is gone for every collaborator immediately.  Live doc actors are not
/// kicked — their next durable write fails and clients surface the error; the
/// actors reap themselves once idle.
pub async fn delete_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<DeleteQuery>,
) -> AppResult<Response> {
    match persist::get_project(&state.pool, id).await? {
        Some(project) => {
            if project.owner_id != user.id {
                return Err(AppError::Forbidden);
            }
            if q.permanent {
                persist::delete_project(&state.pool, id).await?;
            } else {
                persist::trash_project(&state.pool, id).await?;
            }
        }
        // Already in the Trash: only a permanent delete has anything left to do.
        None => {
            if !q.permanent || !persist::purge_trashed_project(&state.pool, id, user.id).await? {
                return Err(AppError::NotFound);
            }
        }
    }
    // Only now: a socket that looked its role up before the change landed would
    // otherwise keep the old one (ws.rs).
    state.access_changed();
    Ok(Json(json!({ "ok": true, "trashed": !q.permanent })).into_response())
}

/// GET /api/trash: the caller's deleted projects that can still be restored.
pub async fn list_trash(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> AppResult<Response> {
    let projects: Vec<_> = persist::list_trash(&state.pool, user.id)
        .await?
        .into_iter()
        .map(|p| {
            json!({
                "projectId": p.id, "name": p.name, "docCount": p.doc_count,
                "deletedAt": p.deleted_at.to_rfc3339(),
                "purgeAt": (p.deleted_at + chrono::Duration::days(30)).to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(json!({ "projects": projects })).into_response())
}

/// POST /api/projects/{id}/undelete: take a project back out of the Trash.
pub async fn undelete_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    if persist::restore_project(&state.pool, id, user.id).await? {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

/// PUT / DELETE /api/projects/{id}/star: pin a project to the top of the
/// caller's own list.  Stars are per user and need access to the project.
pub async fn star_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::Forbidden)?;
    persist::set_star(&state.pool, user.id, id, true).await?;
    Ok(Json(json!({ "ok": true, "starred": true })).into_response())
}

pub async fn unstar_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    persist::set_star(&state.pool, user.id, id, false).await?;
    Ok(Json(json!({ "ok": true, "starred": false })).into_response())
}

#[derive(Deserialize)]
pub struct TransferRequest {
    #[serde(rename = "userId")]
    pub user_id: i64,
}

/// POST /api/projects/{id}/transfer: the owner hands the project to a member
/// and stays on as an editor.
pub async fn transfer_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<TransferRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    if req.user_id == user.id {
        return Err(AppError::BadRequest("you already own this project".into()));
    }
    if persist::transfer_ownership(&state.pool, id, user.id, req.user_id).await? {
        state.access_changed();
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::BadRequest("only someone who already has access can become the owner".into()))
    }
}

#[derive(Deserialize)]
pub struct BlankProjectRequest {
    pub name: String,
}

/// A name that is safe as the stem of the project's files.
pub(crate) fn file_stem_for(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') { c } else { '_' })
        .collect();
    let stem = stem.trim().trim_matches('.').replace(' ', "_");
    if stem.is_empty() { "untitled".into() } else { stem.chars().take(64).collect() }
}

/// POST /api/projects/blank: start an empty project online — the same three
/// stub files KiCad's project manager writes for File > New Project (see
/// KICAD_MANAGER_FRAME::CreateNewProject), in the KiCad 9 file format so every
/// client can open them; an editor upgrades the format only when content needs it.
pub async fn create_blank_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    LenientJson(req): LenientJson<BlankProjectRequest>,
) -> AppResult<Response> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("give the project a name".into()));
    }
    checked_name(name)?;
    let stem = file_stem_for(name);
    let pro = serde_json::to_vec_pretty(&json!({
        "board": { "design_settings": { "defaults": {}, "diff_pair_dimensions": [], "drc_exclusions": [],
                                         "rules": {}, "track_widths": [], "via_dimensions": [] } },
        "boards": [],
        "libraries": { "pinned_footprint_libs": [], "pinned_symbol_libs": [] },
        "meta": { "filename": format!("{stem}.kicad_pro"), "version": 1 },
        "net_settings": { "classes": [], "meta": { "version": 0 } },
        "pcbnew": { "page_layout_descr_file": "" },
        "sheets": [],
        "text_variables": {}
    }))
    .unwrap();
    let sch = format!(
        "(kicad_sch\n\t(version 20250114)\n\t(generator \"eeschema\")\n\t(generator_version \"9.0\")\n\t(uuid \"{}\")\n\t(paper \"A4\")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n",
        Uuid::new_v4()
    );
    // The header KiCad writes for a new board: without the layer table there is no copper to route on.
    let pcb = concat!(
        "(kicad_pcb\n\t(version 20241229)\n\t(generator \"pcbnew\")\n\t(generator_version \"9.0\")\n",
        "\t(general\n\t\t(thickness 1.6)\n\t\t(legacy_teardrops no)\n\t)\n\t(paper \"A4\")\n\t(layers\n",
        "\t\t(0 \"F.Cu\" signal)\n\t\t(2 \"B.Cu\" signal)\n\t\t(9 \"F.Adhes\" user \"F.Adhesive\")\n\t\t(11 \"B.Adhes\" user \"B.Adhesive\")\n",
        "\t\t(13 \"F.Paste\" user)\n\t\t(15 \"B.Paste\" user)\n\t\t(5 \"F.SilkS\" user \"F.Silkscreen\")\n\t\t(7 \"B.SilkS\" user \"B.Silkscreen\")\n",
        "\t\t(1 \"F.Mask\" user)\n\t\t(3 \"B.Mask\" user)\n\t\t(17 \"Dwgs.User\" user \"User.Drawings\")\n\t\t(19 \"Cmts.User\" user \"User.Comments\")\n",
        "\t\t(21 \"Eco1.User\" user \"User.Eco1\")\n\t\t(23 \"Eco2.User\" user \"User.Eco2\")\n\t\t(25 \"Edge.Cuts\" user)\n\t\t(27 \"Margin\" user)\n",
        "\t\t(31 \"F.CrtYd\" user \"F.Courtyard\")\n\t\t(29 \"B.CrtYd\" user \"B.Courtyard\")\n\t\t(35 \"F.Fab\" user)\n\t\t(33 \"B.Fab\" user)\n\t)\n",
        "\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t\t(allow_soldermask_bridges_in_footprints no)\n\t\t(tenting front back)\n\t)\n",
        "\t(embedded_fonts no)\n)\n"
    );

    let project = persist::create_project(&state.pool, user.id, name).await?;
    let mut docs = Vec::new();
    for (path, content) in [
        (format!("{stem}.kicad_pro"), pro),
        (format!("{stem}.kicad_sch"), sch.into_bytes()),
        (format!("{stem}.kicad_pcb"), pcb.as_bytes().to_vec()),
    ] {
        let doc = persist::create_document(&state.pool, project.id, &path, doc_type_for(&path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
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
    let access = access::require(&state.pool, &Viewer::user(&user), id).await?;
    let docs = persist::project_documents(&state.pool, id).await?;
    let docs: Vec<_> = docs
        .iter()
        .map(|d| json!({ "docId": d.id, "path": d.path, "docType": d.doc_type }))
        .collect();
    Ok(Json(json!({
        "projectId": project.id, "name": project.name, "ownerId": project.owner_id,
        "role": access.role_str(), "docs": docs,
        "can": access.can_json(), "isOwner": access.owner,
        "permissions": access.settings.to_json(),
    }))
    .into_response())
}

pub async fn download_archive(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let access = access::require(&state.pool, &Viewer::user(&user), id).await?;
    if !access.can_copy() {
        return Err(AppError::Api(
            StatusCode::FORBIDDEN,
            "copy_disabled",
            "The owner of this project does not let viewers download it.".into(),
        ));
    }

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
//
// Who may do what here (access.rs): the owner manages everything.  When the project's
// "editors can share" setting is on, an editor may also invite people and make links,
// never above editor, and may take back the invites and links they made themselves.
// Changing or removing someone who is already in stays with the owner.

/// The caller's access, refused unless they may share the project.
async fn sharing_access(state: &AppState, user: &persist::User, id: Uuid) -> AppResult<access::Access> {
    let access = access::resolve(&state.pool, &Viewer::user(user), id).await?.ok_or(AppError::NotFound)?;
    if !access.can_share() {
        return Err(AppError::Forbidden);
    }
    Ok(access)
}

async fn owner_only(state: &AppState, user: &persist::User, id: Uuid) -> AppResult<persist::Project> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        return Err(AppError::Forbidden);
    }
    Ok(project)
}

fn link_json(state: &AppState, l: &persist::ActiveLink, me: i64, is_owner: bool) -> serde_json::Value {
    json!({
        "token": l.token,
        "url": format!("{}/j/{}", state.cfg.site_url, l.token),
        "role": l.role,
        "label": l.label,
        "uses": l.uses,
        "createdBy": l.created_by_login,
        "canRevoke": is_owner || l.created_by == me,
        "createdAt": l.created_at.to_rfc3339(),
        "expiresAt": l.expires_at.map(|t| t.to_rfc3339()),
    })
}

#[derive(Deserialize)]
pub struct CreateLinkRequest {
    pub role: Option<String>,
    #[serde(rename = "expiresInDays")]
    pub expires_in_days: Option<i64>,
    pub label: Option<String>,
}

pub async fn create_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<CreateLinkRequest>,
) -> AppResult<Response> {
    sharing_access(&state, &user, id).await?;
    let role = Role::checked(req.role.as_deref().unwrap_or("editor"))?;
    let expires_at = match req.expires_in_days {
        Some(d) if (1..=3650).contains(&d) => Some(
            chrono::Utc::now()
                .checked_add_signed(chrono::Duration::days(d))
                .ok_or_else(|| AppError::BadRequest("expiresInDays is out of range".into()))?,
        ),
        Some(_) => {
            return Err(AppError::BadRequest("expiresInDays must be between 1 and 3650".into()))
        }
        None => None,
    };
    let label = req.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
    if label.is_some_and(|l| l.chars().count() > 80 || l.chars().any(char::is_control)) {
        return Err(AppError::BadRequest("label too long (80 characters max)".into()));
    }
    let token = auth::random_token();
    persist::create_share_link(&state.pool, &token, id, role.as_str(), user.id, expires_at, label).await?;
    Ok(Json(json!({
        "token": token,
        "url": format!("{}/j/{}", state.cfg.site_url, token),
        "role": role.as_str(),
        "label": label,
        "expiresAt": expires_at.map(|t| t.to_rfc3339()),
    }))
    .into_response())
}

pub async fn revoke_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(token): Path<String>,
) -> AppResult<Response> {
    if persist::revoke_share_link(&state.pool, &token, user.id).await? {
        // Someone looking through the link (not joined) loses the project now.
        state.access_changed();
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
    // The owner opening their own link must not become a member of their own project.
    let project = persist::get_project(&state.pool, link.project_id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id == user.id {
        return Ok(Json(json!({ "projectId": link.project_id, "role": "editor" })).into_response());
    }
    persist::claim_share_link(&state.pool, user.id, &link).await?;
    state.access_changed();
    let role = persist::effective_role(&state.pool, user.id, link.project_id)
        .await?
        .unwrap_or_else(|| link.role.clone());
    Ok(Json(json!({ "projectId": link.project_id, "role": role })).into_response())
}

/// POST /api/projects/{id}/join: someone who is looking at the project through a
/// share link they opened (not yet a member) joins it with that link's role.
pub async fn join_opened(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Viewer { links, .. }: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id != user.id {
        let link = access::best_opened_link(&state.pool, &links, id).await?.ok_or(AppError::NotFound)?;
        persist::claim_share_link(&state.pool, user.id, &link).await?;
        state.access_changed();
    }
    let role = persist::effective_role(&state.pool, user.id, id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "projectId": id, "role": role })).into_response())
}

/// Who has access.  Any member can read the list (so collaborators can see who
/// else is in the project); pending invites are shown to whoever may share.
pub async fn list_members(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let access = access::resolve(&state.pool, &Viewer::user(&user), id).await?;
    // A public project gives everyone a role, which is not membership.
    let Some(access) = access.filter(|a| a.member) else {
        return Err(AppError::Forbidden);
    };
    let rows = persist::list_members(&state.pool, id).await?;
    let owner = persist::get_user(&state.pool, project.owner_id).await?;
    let members: Vec<_> = rows
        .into_iter()
        .map(|m| json!({ "userId": m.id, "login": m.login, "avatarUrl": m.avatar_url, "role": m.role }))
        .collect();
    let pending: Vec<_> = if access.can_share() {
        persist::list_pending_invites(&state.pool, id)
            .await?
            .into_iter()
            .filter(|i| access.owner || i.4 == Some(user.id))
            .map(|(perm_id, login, email, role, _)| {
                json!({ "inviteId": perm_id, "login": login, "email": email, "role": role })
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!({
        "ownerId": project.owner_id,
        "owner": owner.map(|o| json!({ "userId": o.id, "login": o.login, "avatarUrl": o.avatar_url })),
        "canManage": access.can_manage(),
        "canShare": access.can_share(),
        "myRole": access.role_str(),
        "permissions": access.settings.to_json(),
        "members": members, "pending": pending,
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct RoleRequest {
    pub role: String,
}

/// PATCH /api/projects/{id}/members/{userId}: the owner changes a member's role.
/// Like removal, it reaches a live socket within about a second.
pub async fn set_member_role(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, member_id)): Path<(Uuid, i64)>,
    LenientJson(req): LenientJson<RoleRequest>,
) -> AppResult<Response> {
    owner_only(&state, &user, id).await?;
    let role = Role::checked(&req.role)?;
    if persist::set_member_role(&state.pool, id, member_id, role.as_str()).await? {
        state.access_changed();
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

/// PATCH /api/projects/{id}/invites/{inviteId}: change what a pending invite grants.
pub async fn set_invite_role(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, invite_id)): Path<(Uuid, i64)>,
    LenientJson(req): LenientJson<RoleRequest>,
) -> AppResult<Response> {
    let access = sharing_access(&state, &user, id).await?;
    let role = Role::checked(&req.role)?;
    let only_by = if access.owner { None } else { Some(user.id) };
    if persist::set_invite_role(&state.pool, id, invite_id, role.as_str(), only_by).await? {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

/// GET /api/projects/{id}/links: the share links that still work, so whoever may
/// share can see what is out there and turn it off.
pub async fn list_links(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let access = sharing_access(&state, &user, id).await?;
    let links: Vec<_> = persist::list_share_links(&state.pool, id)
        .await?
        .iter()
        // An editor who may share sees the links they made, not the owner's.
        .filter(|l| access.owner || l.created_by == user.id)
        .map(|l| link_json(&state, l, user.id, access.owner))
        .collect();
    Ok(Json(json!({ "links": links })).into_response())
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, invite_id)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let access = sharing_access(&state, &user, id).await?;
    let only_by = if access.owner { None } else { Some(user.id) };
    if persist::delete_pending_invite(&state.pool, id, invite_id, only_by).await? {
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
    owner_only(&state, &user, id).await?;
    if persist::remove_member(&state.pool, id, member_id).await? {
        // Live sockets look their role up again on their next message (ws.rs).
        state.access_changed();
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(AppError::NotFound)
    }
}

/// POST /api/projects/{id}/leave: a member drops their own access.  The owner
/// cannot leave (delete the project instead).
pub async fn leave_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if project.owner_id == user.id {
        return Err(AppError::BadRequest(
            "the owner cannot leave a project; delete it instead".into(),
        ));
    }
    persist::remove_member(&state.pool, id, user.id).await?;
    state.access_changed();
    Ok(Json(json!({ "ok": true })).into_response())
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
    LenientJson(req): LenientJson<InviteRequest>,
) -> AppResult<Response> {
    let project = persist::get_project(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    sharing_access(&state, &user, id).await?;
    if req.login.is_none() && req.email.is_none() {
        return Err(AppError::BadRequest("provide login or email".into()));
    }
    let role = Role::checked(req.role.as_deref().unwrap_or("editor"))?;
    let role = role.as_str();

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
        // Never downgrades: only the owner lowers a role (set_member_role).
        persist::grant_role(&state.pool, id, invitee.id, role).await?;
        state.access_changed();
        let now = persist::effective_role(&state.pool, invitee.id, id).await?;
        return Ok(Json(json!({
            "ok": true, "status": "granted",
            "userId": invitee.id, "login": invitee.login,
            "role": now.unwrap_or_else(|| role.to_string()),
        }))
        .into_response());
    }

    persist::add_invite(&state.pool, id, req.login.as_deref(), req.email.as_deref(), role, user.id)
        .await?;
    Ok(Json(json!({ "ok": true, "status": "pending", "role": role })).into_response())
}

#[derive(Deserialize)]
pub struct PermissionsRequest {
    #[serde(rename = "publicRole")]
    pub public_role: Option<String>,
    #[serde(rename = "editorsCanShare")]
    pub editors_can_share: Option<bool>,
    #[serde(rename = "viewersCanCopy")]
    pub viewers_can_copy: Option<bool>,
    #[serde(rename = "linksRequireSignin")]
    pub links_require_signin: Option<bool>,
}

/// GET /api/projects/{id}/permissions: the project's permission settings and what
/// the caller may do, for anyone who can see the project.
pub async fn get_permissions(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let access = access::require(&state.pool, &viewer, id).await?;
    Ok(Json(json!({
        "role": access.role_str(), "isOwner": access.owner, "isMember": access.member,
        "can": access.can_json(), "permissions": access.settings.to_json(),
    }))
    .into_response())
}

/// PATCH /api/projects/{id}/permissions: the owner changes the permission settings.
pub async fn set_permissions(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<PermissionsRequest>,
) -> AppResult<Response> {
    owner_only(&state, &user, id).await?;
    let public_role = match req.public_role.as_deref() {
        Some(r) => match Role::parse(r) {
            Some(r @ (Role::Viewer | Role::Commenter)) => Some(r.as_str()),
            _ => return Err(AppError::BadRequest("publicRole must be viewer or commenter".into())),
        },
        None => None,
    };
    if public_role.is_none()
        && req.editors_can_share.is_none()
        && req.viewers_can_copy.is_none()
        && req.links_require_signin.is_none()
    {
        return Err(AppError::BadRequest("nothing to update".into()));
    }
    persist::update_project_permissions(
        &state.pool,
        id,
        public_role,
        req.editors_can_share,
        req.viewers_can_copy,
        req.links_require_signin,
    )
    .await?;
    // Open sockets look their role up again: a visitor's may just have changed.
    state.access_changed();
    let access = access::require(&state.pool, &Viewer::user(&user), id).await?;
    Ok(Json(json!({ "ok": true, "permissions": access.settings.to_json() })).into_response())
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
    /// An explicit save (the Footprint Editor's Save): everyone with the project open is told,
    /// so their "modified" marks and library caches follow.  Freshness snapshots leave it out.
    #[serde(default)]
    pub saved: Option<bool>,
}

/// Latest snapshot bytes for one document (members only) — the receiver-side
/// download when a peer adds a new sheet file mid-session.
pub async fn doc_content(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    // Readable by members, and by anyone for a public project (the web editor
    // draws the document itself, signed in or not).
    // A share link that was opened in this browser counts as well (access.rs).
    if access::resolve(&state.pool, &viewer, doc.project_id).await?.is_none() {
        return Err(if viewer.user.is_some() { AppError::Forbidden } else { AppError::Unauthorized });
    }

    let Some((seq, content)) = persist::latest_snapshot(&state.pool, doc_id).await? else {
        return Err(AppError::NotFound);
    };

    let mut response = (
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        content,
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::HeaderName::from_static("x-snapshot-seq"),
        axum::http::HeaderValue::from_str(&seq.to_string()).unwrap(),
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct NewDocRequest {
    pub path: String,
    #[serde(rename = "docType")]
    pub doc_type: Option<String>,
}

/// Add a document to an existing project mid-session — a hierarchical sheet
/// created during live editing needs a server doc for its new file.  The
/// caller uploads the initial content as snapshot 0 afterwards.  Idempotent:
/// an existing doc at the same path is returned as-is.
pub async fn create_doc(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<NewDocRequest>,
) -> AppResult<Response> {
    let role = persist::effective_role(&state.pool, user.id, id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }

    let Some(path) = safe_zip_name(&req.path) else {
        return Err(AppError::BadRequest("bad path".into()));
    };
    if !allowed_file(&path) {
        return Err(AppError::BadRequest("file type not allowed".into()));
    }

    // The same rules as an upload: nothing from a project's own bookkeeping, and no
    // second file that differs from an existing one only in case.
    if is_local_state_path(&path) {
        return Err(AppError::BadRequest("that path is not part of a project".into()));
    }
    let documents = persist::project_documents(&state.pool, id).await?;
    for existing in &documents {
        if existing.path == path {
            return Ok(Json(json!({ "docId": existing.id, "path": existing.path,
                                   "docType": existing.doc_type, "existing": true }))
                .into_response());
        }
        if existing.path.to_lowercase() == path.to_lowercase() {
            return Err(AppError::BadRequest(format!("duplicate file: {}", existing.path)));
        }
    }
    if documents.len() >= MAX_FILES {
        return Err(AppError::BadRequest(format!("too many files (max {MAX_FILES})")));
    }

    let doc_type = req.doc_type.unwrap_or_else(|| doc_type_for(&path).to_string());
    let doc = persist::create_document(&state.pool, id, &path, &doc_type).await?;

    Ok(Json(json!({ "docId": doc.id, "path": doc.path, "docType": doc.doc_type,
                    "existing": false }))
        .into_response())
}

/// The document types a client may delete or move: library files (a footprint, a symbol library, a library table,
/// a 3D model, a drawing sheet) and other loose files.  A project's own schematic, board and project file stay put.
fn doc_is_movable(doc_type: &str) -> bool {
    matches!(doc_type, "footprint" | "symbol_lib" | "lib_table" | "model3d" | "worksheet" | "spice_model" | "other")
}

/// DELETE /api/docs/{id}: the Footprint Editor's Delete Footprint (and the same for other library files).
pub async fn delete_doc(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(doc_id): Path<Uuid>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }
    if !doc_is_movable(&doc.doc_type) {
        return Err(AppError::BadRequest(format!("a {} cannot be deleted here", doc.doc_type)));
    }
    let deleted = persist::delete_document(&state.pool, doc_id).await?;
    Ok(Json(json!({ "ok": deleted, "docId": doc_id })).into_response())
}

#[derive(Deserialize)]
pub struct MoveDocRequest {
    pub path: String,
}

/// PATCH /api/docs/{id} {path}: rename or move a library file inside its project (same file type).
pub async fn move_doc(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(doc_id): Path<Uuid>,
    LenientJson(req): LenientJson<MoveDocRequest>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }
    if !doc_is_movable(&doc.doc_type) {
        return Err(AppError::BadRequest(format!("a {} cannot be moved here", doc.doc_type)));
    }
    let Some(path) = safe_zip_name(&req.path) else {
        return Err(AppError::BadRequest("bad path".into()));
    };
    if !allowed_file(&path) || is_local_state_path(&path) {
        return Err(AppError::BadRequest("file type not allowed".into()));
    }
    if doc_type_for(&path) != doc.doc_type {
        return Err(AppError::BadRequest("a file keeps its type when it moves".into()));
    }
    for existing in persist::project_documents(&state.pool, doc.project_id).await? {
        if existing.id != doc_id && existing.path.to_lowercase() == path.to_lowercase() {
            return Err(AppError::BadRequest(format!("duplicate file: {}", existing.path)));
        }
    }
    let moved = persist::rename_document(&state.pool, doc_id, &path).await?.ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "ok": true, "docId": moved.id, "path": moved.path, "docType": moved.doc_type })).into_response())
}

#[derive(Deserialize)]
pub struct PreviewUploadQuery {
    pub seq: i64,
    #[serde(default)]
    pub fit: bool,
}

/// Editors push their own SVG render of the board here (they have the real
/// plotter; the server has no KiCad).  Newest seq wins per variant.
pub async fn upload_preview(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(doc_id): Path<Uuid>,
    Query(q): Query<PreviewUploadQuery>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, doc.project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if role != "editor" {
        return Err(AppError::Forbidden);
    }
    if body.len() > 8 * 1024 * 1024 {
        return Err(AppError::BadRequest("preview too large (8 MB max)".into()));
    }
    let head = body.iter().take(512).copied().collect::<Vec<u8>>();
    let head_text = String::from_utf8_lossy(&head);
    if !head_text.trim_start().starts_with("<?xml") && !head_text.trim_start().starts_with("<svg")
    {
        return Err(AppError::BadRequest("body must be an SVG document".into()));
    }
    persist::upsert_preview(&state.pool, doc_id, q.fit, q.seq, &body).await?;
    Ok(Json(json!({ "ok": true, "docId": doc_id, "seq": q.seq, "fit": q.fit }))
        .into_response())
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
    if q.saved == Some(true) {
        // Tell every open document of the project (each socket joins one document): the saved
        // document's own editors clear their '*', the others drop what they cached of it.
        if let Ok(docs) = persist::project_documents(&state.pool, doc.project_id).await {
            for d in docs {
                let payload = json!({ "type": "saved", "docId": d.id, "savedDocId": doc_id, "projectId": doc.project_id,
                                      "seq": q.seq, "by": user.login });
                state.doc_event(d.id, crate::doc_actor::DocMsg::Notice { payload }).await;
            }
        }
    }
    Ok(Json(json!({ "ok": true, "docId": doc_id, "seq": q.seq, "written": written }))
        .into_response())
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Viewer { links, .. }: Viewer,
    Path((doc_id, seq)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, doc_id).await?.ok_or(AppError::NotFound)?;
    access::require(&state.pool, &Viewer { user: Some(user), links }, doc.project_id).await?;

    let content = persist::snapshot_at(&state.pool, doc_id, seq).await?.ok_or(AppError::NotFound)?;

    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], content).into_response())
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
        assert!(allowed_file("models/opamp.lib") && allowed_file("spice/q.SUB") && allowed_file("x.ibs"));
        assert_eq!(doc_type_for("models/opamp.lib"), "spice_model");
        assert_eq!(doc_type_for("sim/test.CIR"), "spice_model");
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
