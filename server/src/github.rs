//! GitHub repository sync for online projects.
//!
//! An online project can be linked to one folder of one branch of a repository.
//! From then on the server can tell, file by file, what changed online, what
//! changed on GitHub and what changed on both — because it remembers the git blob
//! id each file had the last time the two agreed (`project_github_files`).
//!
//!   push  — commit the files that changed online onto the branch (or onto a new
//!           branch with a pull request).  Files GitHub changed are left alone.
//!   pull  — bring the files that changed on GitHub into the project.  A file that
//!           changed on both sides is merged item by item (merge.rs); only an item
//!           both sides changed differently needs a side picked.
//!
//! Nothing here ever force-pushes, and nothing rewrites a design file except by
//! replacing it with bytes from one side or with a merge of exact spans from both.
//!
//! The project's content is each document's latest snapshot.  Edits newer than
//! that live only as ops (the server has no document model to apply them), so
//! before reading the files a connected desktop client is asked for a fresh
//! snapshot; what no desktop saves is folded into the file by the server (compact.rs),
//! and a pull refuses to overwrite a document whose ops still could not be folded.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::doc_actor::DocMsg;
use crate::error::{AppError, AppResult};
use crate::http::{
    allowed_file, doc_type_for, is_local_state_path, safe_zip_name, MAX_FILES, MAX_FILE_BYTES,
    MAX_TOTAL_BYTES,
};
use crate::lenient_json::LenientJson;
use crate::merge::{self, Prefer};
use crate::persist::{self, Document, User};
use crate::AppState;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ------------------------------------------------------------------ errors

fn api_err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> AppError {
    AppError::Api(status, code, msg.into())
}

fn not_connected() -> AppError {
    api_err(
        StatusCode::CONFLICT,
        "github_not_connected",
        "Connect your GitHub repositories first.",
    )
}

/// A failed GitHub API call.
#[derive(Debug)]
struct GhErr {
    status: u16,
    message: String,
}

impl From<GhErr> for AppError {
    fn from(e: GhErr) -> Self {
        match e.status {
            401 => api_err(
                StatusCode::CONFLICT,
                "github_not_connected",
                "GitHub no longer accepts this connection. Connect your repositories again.",
            ),
            403 => api_err(
                StatusCode::FORBIDDEN,
                "github_forbidden",
                format!("GitHub refused: {}", e.message),
            ),
            404 => api_err(
                StatusCode::NOT_FOUND,
                "github_not_found",
                "GitHub can't find that, or your connection can't see it. Junction sees only the repositories \
                 you chose: add this one to its repositories on GitHub.",
            ),
            0 => api_err(StatusCode::BAD_GATEWAY, "github_unreachable", "GitHub could not be reached."),
            _ => api_err(
                StatusCode::BAD_GATEWAY,
                "github_error",
                format!("GitHub answered {}: {}", e.status, e.message),
            ),
        }
    }
}

// ------------------------------------------------------------------ token storage

fn cipher(state: &AppState) -> Aes256Gcm {
    let key = Sha256::digest(format!("kc-github-token:{}", state.cfg.jwt_secret).as_bytes());
    Aes256Gcm::new_from_slice(&key).expect("32-byte key")
}

/// Seal a secret for the database (nonce + AES-GCM ciphertext).
pub(crate) fn seal(state: &AppState, plain: &[u8]) -> AppResult<Vec<u8>> {
    let nonce: [u8; 12] = rand::random();
    let mut blob = nonce.to_vec();
    blob.extend(
        cipher(state)
            .encrypt(Nonce::from_slice(&nonce), plain)
            .map_err(|_| anyhow::anyhow!("token encryption failed"))?,
    );
    Ok(blob)
}

/// Open a sealed secret; None when it was sealed under another JWT_SECRET.
pub(crate) fn unseal(state: &AppState, blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 13 {
        return None;
    }
    let (nonce, body) = blob.split_at(12);
    cipher(state).decrypt(Nonce::from_slice(nonce), body).ok()
}

pub(crate) fn unseal_str(state: &AppState, blob: &[u8]) -> Option<String> {
    unseal(state, blob).and_then(|b| String::from_utf8(b).ok())
}

/// A token from the old OAuth app's `repo` / `public_repo` grant.
pub async fn store_token(state: &AppState, user_id: i64, token: &str, scopes: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO github_tokens (user_id, token, scopes, kind) VALUES ($1, $2, $3, 'oauth')
         ON CONFLICT (user_id) DO UPDATE
           SET token = EXCLUDED.token, scopes = EXCLUDED.scopes, kind = 'oauth', refresh = NULL,
               expires_at = NULL, refresh_expires_at = NULL, updated_at = now()",
    )
    .bind(user_id)
    .bind(seal(state, token.as_bytes())?)
    .bind(scopes)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// A repository grant as stored.
pub(crate) struct Grant {
    pub token: String,
    pub scopes: String,
    /// "oauth" (the old blanket `repo` grant) or "app" (the GitHub App, chosen repositories only).
    pub kind: String,
}

/// The user's repository grant, if they connected one that still decrypts.  A GitHub
/// App token about to expire is refreshed first (github_app::fresh).
pub(crate) async fn load_grant(state: &AppState, user_id: i64) -> AppResult<Option<Grant>> {
    let row = sqlx::query(
        "SELECT token, scopes, kind, expires_at < now() + interval '5 minutes' AS stale
         FROM github_tokens WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let kind: String = row.get("kind");
    if kind == "app" && row.get::<Option<bool>, _>("stale").unwrap_or(false) {
        return crate::github_app::refresh(state, user_id).await;
    }
    let blob: Vec<u8> = row.get("token");
    // A token sealed under another JWT_SECRET is simply gone: reconnect.
    Ok(unseal_str(state, &blob).map(|token| Grant { token, scopes: row.get("scopes"), kind }))
}

pub(crate) async fn drop_token(state: &AppState, user_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM github_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

// ------------------------------------------------------------------ GitHub client

struct Gh {
    http: reqwest::Client,
    api: String,
    token: String,
    /// "app" when the token is a GitHub App user token (chosen repositories only).
    kind: String,
}

/// Percent-encode a path segment sequence, keeping `/`.
fn enc_path(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn enc(s: &str) -> String {
    enc_path(s).replace('/', "%2F")
}

impl Gh {
    async fn for_user(state: &AppState, user: &User) -> AppResult<Gh> {
        let Grant { token, kind, .. } = load_grant(state, user.id).await?.ok_or_else(not_connected)?;
        Ok(Gh {
            kind,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| anyhow::anyhow!("http client: {e}"))?,
            api: state.cfg.github_api_url.clone(),
            token,
        })
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, GhErr> {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.api, path))
            .header(reqwest::header::USER_AGENT, "kicad-collab-server")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| GhErr { status: 0, message: e.to_string() })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| GhErr { status: 0, message: e.to_string() })?;
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(GhErr { status, message });
        }
        Ok(value)
    }

    async fn get(&self, path: &str) -> Result<Value, GhErr> {
        self.call(reqwest::Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, GhErr> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    /// The commit a branch points at; None when the branch (or any commit) is missing.
    async fn branch_head(&self, repo: &RepoRef, branch: &str) -> Result<Option<String>, GhErr> {
        match self.get(&format!("/repos/{}/git/ref/heads/{}", repo.slug(), enc_path(branch))).await {
            Ok(v) => Ok(v["object"]["sha"].as_str().map(str::to_string)),
            // 404: no such branch.  409: the repository has no commits at all.
            Err(e) if e.status == 404 || e.status == 409 => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn commit_tree(&self, repo: &RepoRef, commit: &str) -> Result<String, GhErr> {
        let v = self.get(&format!("/repos/{}/git/commits/{commit}", repo.slug())).await?;
        v["tree"]["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or(GhErr { status: 502, message: "commit has no tree".into() })
    }

    /// Every blob under a tree: path -> (blob sha, size).  The bool is GitHub's
    /// "truncated" flag (a repository too large to list in one call).
    async fn tree(&self, repo: &RepoRef, tree: &str) -> Result<(BTreeMap<String, (String, u64)>, bool), GhErr> {
        let v = self.get(&format!("/repos/{}/git/trees/{tree}?recursive=1", repo.slug())).await?;
        let mut out = BTreeMap::new();
        for e in v["tree"].as_array().into_iter().flatten() {
            if e["type"] == "blob" {
                if let (Some(p), Some(s)) = (e["path"].as_str(), e["sha"].as_str()) {
                    out.insert(p.to_string(), (s.to_string(), e["size"].as_u64().unwrap_or(0)));
                }
            }
        }
        Ok((out, v["truncated"].as_bool().unwrap_or(false)))
    }

    /// The tree of a folder inside `root`, found one level at a time so a project
    /// in a small corner of a huge repository never lists the whole repository.
    /// None when the folder does not exist there.
    async fn subtree(&self, repo: &RepoRef, root: &str, subdir: &str) -> Result<Option<String>, GhErr> {
        let mut cur = root.to_string();
        for seg in subdir.split('/').filter(|s| !s.is_empty()) {
            let v = self.get(&format!("/repos/{}/git/trees/{cur}", repo.slug())).await?;
            let next = v["tree"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|e| e["type"] == "tree" && e["path"] == seg)
                .and_then(|e| e["sha"].as_str().map(str::to_string));
            match next {
                Some(sha) => cur = sha,
                None => return Ok(None),
            }
        }
        Ok(Some(cur))
    }

    /// Several blobs at once, a few requests at a time, in the order asked for.
    async fn blobs(&self, repo: &RepoRef, shas: &[String]) -> Result<Vec<Vec<u8>>, GhErr> {
        let mut out = Vec::with_capacity(shas.len());
        for group in shas.chunks(6) {
            let mut jobs = Vec::with_capacity(group.len());
            for sha in group {
                jobs.push(self.blob(repo, sha));
            }
            out.extend(futures_util::future::try_join_all(jobs).await?);
        }
        Ok(out)
    }

    async fn blob(&self, repo: &RepoRef, sha: &str) -> Result<Vec<u8>, GhErr> {
        let v = self.get(&format!("/repos/{}/git/blobs/{sha}", repo.slug())).await?;
        let content: String =
            v["content"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        B64.decode(content).map_err(|_| GhErr { status: 502, message: "blob is not valid base64".into() })
    }
}

/// `owner/name`, validated to GitHub's own alphabet so it can go into a URL path.
#[derive(Debug, Clone)]
struct RepoRef {
    owner: String,
    name: String,
}

impl RepoRef {
    fn parse(s: &str) -> AppResult<RepoRef> {
        let s = s
            .trim()
            .trim_start_matches("https://github.com/")
            .trim_start_matches("github.com/")
            .trim_end_matches(".git")
            .trim_matches('/');
        let ok = |p: &str| {
            !p.is_empty()
                && p.len() <= 100
                && p != "."
                && p != ".."
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        };
        match s.split_once('/') {
            Some((o, n)) if ok(o) && ok(n) => Ok(RepoRef { owner: o.into(), name: n.into() }),
            _ => Err(AppError::BadRequest("Write the repository as owner/name.".into())),
        }
    }

    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// A folder inside a repository: no leading/trailing slash, no dot segments.
fn clean_subdir(s: &str) -> AppResult<String> {
    let s = s.trim().replace('\\', "/");
    let s = s.trim_matches('/');
    if s.is_empty() || s == "." {
        return Ok(String::new());
    }
    if s.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") || s.contains(':') {
        return Err(AppError::BadRequest("That folder path is not valid.".into()));
    }
    Ok(s.to_string())
}

fn clean_branch(s: &str) -> AppResult<String> {
    let s = s.trim();
    let bad = s.is_empty()
        || s.len() > 200
        || s.starts_with('/')
        || s.ends_with('/')
        || s.starts_with('-')
        || s.contains("..")
        || s.contains("//")
        || s.ends_with(".lock")
        || s.bytes().any(|b| b <= b' ' || matches!(b, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\' | 0x7f));
    if bad {
        return Err(AppError::BadRequest("That branch name is not valid.".into()));
    }
    Ok(s.to_string())
}

/// The id git gives a file's content.
pub fn blob_sha(content: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", content.len()).as_bytes());
    h.update(content);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// ------------------------------------------------------------------ link storage

#[derive(Debug, Clone)]
struct Link {
    repo: RepoRef,
    branch: String,
    subdir: String,
    linked_by: Option<String>,
    base_commit: Option<String>,
    synced_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Push whenever a checkpoint is saved.
    auto_push: bool,
    /// What the last automatic push did.
    last_auto: Option<Value>,
}

impl Link {
    /// Repository path of a project file.
    fn repo_path(&self, doc_path: &str) -> String {
        if self.subdir.is_empty() {
            doc_path.to_string()
        } else {
            format!("{}/{}", self.subdir, doc_path)
        }
    }

    fn web_url(&self, state: &AppState) -> String {
        let mut url = format!(
            "{}/{}/tree/{}",
            state.cfg.github_web_url,
            self.repo.slug(),
            enc_path(&self.branch)
        );
        if !self.subdir.is_empty() {
            url.push('/');
            url.push_str(&enc_path(&self.subdir));
        }
        url
    }
}

async fn load_link(state: &AppState, project_id: Uuid) -> AppResult<Option<Link>> {
    let row = sqlx::query(
        "SELECT g.repo_owner, g.repo_name, g.branch, g.subdir, g.base_commit, g.synced_at, g.auto_push, g.last_auto, u.login
         FROM project_github g LEFT JOIN users u ON u.id = g.linked_by
         WHERE g.project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|r| Link {
        repo: RepoRef { owner: r.get("repo_owner"), name: r.get("repo_name") },
        branch: r.get("branch"),
        subdir: r.get("subdir"),
        linked_by: r.get("login"),
        base_commit: r.get("base_commit"),
        synced_at: r.get("synced_at"),
        auto_push: r.get("auto_push"),
        last_auto: r.get("last_auto"),
    }))
}

async fn save_link(
    state: &AppState,
    project_id: Uuid,
    repo: &RepoRef,
    branch: &str,
    subdir: &str,
    user_id: i64,
) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    // A new link starts with no shared history: whatever the old one remembered
    // describes a different folder.
    sqlx::query("DELETE FROM project_github_files WHERE project_id = $1")
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO project_github (project_id, repo_owner, repo_name, branch, subdir, linked_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id) DO UPDATE
           SET repo_owner = EXCLUDED.repo_owner, repo_name = EXCLUDED.repo_name,
               branch = EXCLUDED.branch, subdir = EXCLUDED.subdir, linked_by = EXCLUDED.linked_by,
               base_commit = NULL, synced_at = NULL, created_at = now(),
               auto_push = false, last_auto = NULL",
    )
    .bind(project_id)
    .bind(&repo.owner)
    .bind(&repo.name)
    .bind(branch)
    .bind(subdir)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The repository each of these projects is linked to, for the project list.
pub async fn linked_repos(pool: &sqlx::PgPool, ids: &[Uuid]) -> AppResult<HashMap<Uuid, Value>> {
    let rows = sqlx::query(
        "SELECT project_id, repo_owner, repo_name, branch FROM project_github WHERE project_id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let (owner, name): (String, String) = (r.get("repo_owner"), r.get("repo_name"));
            (r.get("project_id"), json!({ "repo": format!("{owner}/{name}"), "branch": r.get::<String, _>("branch") }))
        })
        .collect())
}

async fn load_base(state: &AppState, project_id: Uuid) -> AppResult<HashMap<String, String>> {
    let rows = sqlx::query("SELECT path, blob_sha FROM project_github_files WHERE project_id = $1")
        .bind(project_id)
        .fetch_all(&state.pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.get("path"), r.get("blob_sha"))).collect())
}

/// Record the blob ids the two sides now agree on, and the commit that was synced with.
async fn save_base(
    state: &AppState,
    project_id: Uuid,
    agreed: &[(String, String)],
    commit: Option<&str>,
) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    for (path, sha) in agreed {
        sqlx::query(
            "INSERT INTO project_github_files (project_id, path, blob_sha) VALUES ($1, $2, $3)
             ON CONFLICT (project_id, path) DO UPDATE SET blob_sha = EXCLUDED.blob_sha",
        )
        .bind(project_id)
        .bind(path)
        .bind(sha)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(commit) = commit {
        sqlx::query("UPDATE project_github SET base_commit = $2, synced_at = now() WHERE project_id = $1")
            .bind(project_id)
            .bind(commit)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ------------------------------------------------------------------ comparing the two sides

/// The project's own file: the document's latest snapshot.
struct LocalFile {
    doc: Document,
    sha: String,
    size: usize,
    /// Ops applied after that snapshot — edits the file does not contain yet.
    unsaved_ops: i64,
}

async fn local_files(state: &AppState, project_id: Uuid) -> AppResult<BTreeMap<String, LocalFile>> {
    let mut out = BTreeMap::new();
    for doc in persist::project_documents(&state.pool, project_id).await? {
        let Some((seq, content)) = persist::latest_snapshot(&state.pool, doc.id).await? else {
            continue;
        };
        let head = persist::head_seq(&state.pool, doc.id).await?;
        out.insert(
            doc.path.clone(),
            LocalFile { sha: blob_sha(&content), size: content.len(), unsaved_ops: head - seq, doc },
        );
    }
    Ok(out)
}

/// Ask connected desktop clients to save any document that has edits newer than its
/// snapshot, and give them a few seconds to do it.
async fn freshen(state: &AppState, project_id: Uuid) -> AppResult<()> {
    let mut waiting = Vec::new();
    for doc in persist::project_documents(&state.pool, project_id).await? {
        let head = persist::head_seq(&state.pool, doc.id).await?;
        if persist::latest_snapshot_seq(&state.pool, doc.id).await? >= head {
            continue;
        }
        if state.doc_event(doc.id, DocMsg::SnapshotNow).await {
            waiting.push(doc.id);
        }
    }
    for _ in 0..24 {
        if waiting.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let mut still = Vec::new();
        for id in waiting {
            // "Caught up" means a snapshot at the head as it is *now*; a document
            // being edited this very second keeps moving and is allowed to time out.
            let head = persist::head_seq(&state.pool, id).await?;
            if persist::latest_snapshot_seq(&state.pool, id).await? < head {
                still.push(id);
            }
        }
        waiting = still;
    }
    // Whatever is still behind has no desktop editor to save it (a browser-only project, or
    // nobody has it open): the server folds those edits into the file itself.
    crate::compact::fold_project(&state.pool, project_id).await;
    Ok(())
}

/// The remote side: the branch head and the project files under the linked folder,
/// keyed by project-relative path.
struct Remote {
    head: Option<String>,
    tree: Option<String>,
    files: BTreeMap<String, (String, u64)>,
    truncated: bool,
}

async fn remote_files(gh: &Gh, link: &Link) -> Result<Remote, GhErr> {
    let Some(head) = gh.branch_head(&link.repo, &link.branch).await? else {
        return Ok(Remote { head: None, tree: None, files: BTreeMap::new(), truncated: false });
    };
    let tree = gh.commit_tree(&link.repo, &head).await?;
    let Some(folder) = gh.subtree(&link.repo, &tree, &link.subdir).await? else {
        return Ok(Remote { head: Some(head), tree: Some(tree), files: BTreeMap::new(), truncated: false });
    };
    let (all, truncated) = gh.tree(&link.repo, &folder).await?;
    let files = all
        .into_iter()
        .filter(|(rel, _)| allowed_file(rel) && !is_local_state_path(rel) && safe_zip_name(rel).is_some())
        .collect();
    Ok(Remote { head: Some(head), tree: Some(tree), files, truncated })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    Synced,
    /// Only the online project changed it (or has it at all).
    Push,
    /// Only GitHub changed it (or has it at all).
    Pull,
    /// Both changed it, differently.
    Conflict,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Change::Synced => "synced",
            Change::Push => "push",
            Change::Pull => "pull",
            Change::Conflict => "conflict",
        }
    }
}

/// Where a file stands, from its blob id online, on GitHub and at the last sync.
fn classify(local: Option<&str>, remote: Option<&str>, base: Option<&str>) -> Option<(Change, &'static str)> {
    Some(match (local, remote) {
        (None, None) => return None,
        (Some(l), Some(r)) if l == r => (Change::Synced, "identical"),
        (Some(_), None) => match base {
            Some(_) => (Change::Push, "deleted on GitHub; pushing puts it back"),
            None => (Change::Push, "new online"),
        },
        (None, Some(_)) => (Change::Pull, "new on GitHub"),
        (Some(l), Some(r)) => match base {
            Some(b) if b == r => (Change::Push, "changed online"),
            Some(b) if b == l => (Change::Pull, "changed on GitHub"),
            Some(_) => (Change::Conflict, "changed on both sides"),
            None => (Change::Conflict, "differs, and the two were never synced"),
        },
    })
}

struct Entry {
    path: String,
    change: Change,
    detail: &'static str,
    local: Option<String>,
    remote: Option<String>,
    remote_size: u64,
}

fn compare(
    local: &BTreeMap<String, LocalFile>,
    remote: &Remote,
    base: &HashMap<String, String>,
) -> Vec<Entry> {
    let paths: std::collections::BTreeSet<&String> = local.keys().chain(remote.files.keys()).collect();
    paths
        .into_iter()
        .filter_map(|path| {
            let l = local.get(path).map(|f| f.sha.as_str());
            let r = remote.files.get(path).map(|(s, _)| s.as_str());
            let (change, detail) = classify(l, r, base.get(path).map(String::as_str))?;
            Some(Entry {
                path: path.clone(),
                change,
                detail,
                local: l.map(str::to_string),
                remote: r.map(str::to_string),
                remote_size: remote.files.get(path).map(|(_, s)| *s).unwrap_or(0),
            })
        })
        .collect()
}

// ------------------------------------------------------------------ access

struct Access {
    project: persist::Project,
    role: String,
    is_owner: bool,
}

async fn access(state: &AppState, user: &User, project_id: Uuid) -> AppResult<Access> {
    let project = persist::get_project(&state.pool, project_id).await?.ok_or(AppError::NotFound)?;
    let role = persist::effective_role(&state.pool, user.id, project_id)
        .await?
        .ok_or(AppError::Forbidden)?;
    let is_owner = project.owner_id == user.id;
    Ok(Access { project, role, is_owner })
}

fn require_editor(a: &Access) -> AppResult<()> {
    if a.role != "editor" {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only editors can sync a project with GitHub."));
    }
    Ok(())
}

// ------------------------------------------------------------------ connection endpoints

/// Whether the caller has granted repository access, and with what reach.
pub async fn connection(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Response> {
    let grant = load_grant(&state, user.id).await?;
    let app = crate::github_app::creds(&state).await?;
    let scopes = grant.as_ref().map(|g| g.scopes.clone()).unwrap_or_default();
    let via_app = grant.as_ref().is_some_and(|g| g.kind == "app");
    let private = via_app || scopes.split([',', ' ']).any(|s| s == "repo");
    Ok(Json(json!({
        "configured": state.cfg.github_client_id.is_some() || app.is_some(),
        "connected": grant.is_some(),
        "login": user.login,
        "avatarUrl": user.avatar_url,
        "scopes": scopes,
        "privateRepos": private,
        // Junction's GitHub App, when registered: connecting goes through it.
        "app": app.as_ref().map(|a| json!({ "name": a.name, "slug": a.slug, "url": a.html_url })),
        "via": grant.as_ref().map(|g| if g.kind == "app" { "app" } else { "oauth" }),
        // Still on the old grant that reaches every repository: offer the switch.
        "legacy": app.is_some() && grant.as_ref().is_some_and(|g| g.kind != "app"),
        "manageUrl": format!("{}/settings/installations", state.cfg.github_web_url),
    }))
    .into_response())
}

/// Forget the caller's repository token, and with a GitHub App token also withdraw the
/// app's authorization on GitHub.  Links stay; syncing them needs a connected account again.
pub async fn disconnect(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Response> {
    if let Some(g) = load_grant(&state, user.id).await?.filter(|g| g.kind == "app") {
        if let Some(app) = crate::github_app::creds(&state).await? {
            crate::github_app::revoke_grant(&state, &app.client_id, &app.client_secret, &g.token).await;
        }
    }
    drop_token(&state, user.id).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub struct RepoQuery {
    #[serde(default)]
    pub q: String,
}

/// Repositories the caller can reach, most recently pushed first.
pub async fn list_repos(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<RepoQuery>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let needle = q.q.trim().to_ascii_lowercase();
    let mut repos = Vec::new();
    let keep = |r: &Value, repos: &mut Vec<Value>| {
        let full = r["full_name"].as_str().unwrap_or("").to_string();
        if !needle.is_empty() && !full.to_ascii_lowercase().contains(&needle) {
            return;
        }
        repos.push(json!({
            "fullName": full,
            "private": r["private"].as_bool().unwrap_or(false),
            "defaultBranch": r["default_branch"],
            "description": r["description"],
            "pushedAt": r["pushed_at"],
            "canPush": r["permissions"]["push"].as_bool().unwrap_or(false),
        }));
    };
    if gh.kind == "app" {
        // Only what the person installed the app on: every installation they can see,
        // then the repositories each was given.
        let installs = gh.get("/user/installations?per_page=100").await?;
        for inst in installs["installations"].as_array().cloned().unwrap_or_default() {
            let Some(iid) = inst["id"].as_i64() else { continue };
            for page in 1..=10 {
                let v = gh.get(&format!("/user/installations/{iid}/repositories?per_page=100&page={page}")).await?;
                let items = v["repositories"].as_array().cloned().unwrap_or_default();
                for r in &items {
                    keep(r, &mut repos);
                }
                if items.len() < 100 {
                    break;
                }
            }
        }
        repos.sort_by(|a, b| b["pushedAt"].as_str().unwrap_or("").cmp(a["pushedAt"].as_str().unwrap_or("")));
        repos.dedup_by(|a, b| a["fullName"] == b["fullName"]);
        return Ok(Json(json!({ "repos": repos, "installations": installs["total_count"] })).into_response());
    }
    for page in 1..=3 {
        let v = gh
            .get(&format!(
                "/user/repos?per_page=100&page={page}&sort=pushed&affiliation=owner,collaborator,organization_member"
            ))
            .await?;
        let items = v.as_array().cloned().unwrap_or_default();
        let n = items.len();
        for r in items {
            let full = r["full_name"].as_str().unwrap_or("").to_string();
            if !needle.is_empty() && !full.to_ascii_lowercase().contains(&needle) {
                continue;
            }
            repos.push(json!({
                "fullName": full,
                "private": r["private"].as_bool().unwrap_or(false),
                "defaultBranch": r["default_branch"],
                "description": r["description"],
                "pushedAt": r["pushed_at"],
                "canPush": r["permissions"]["push"].as_bool().unwrap_or(false),
            }));
        }
        if n < 100 {
            break;
        }
    }
    Ok(Json(json!({ "repos": repos })).into_response())
}

#[derive(Deserialize)]
pub struct ScanQuery {
    pub repo: String,
    pub branch: Option<String>,
}

/// Folders of a repository that hold a KiCad project, so one can be picked.
pub async fn scan_repo(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ScanQuery>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let repo = RepoRef::parse(&q.repo)?;
    let info = gh.get(&format!("/repos/{}", repo.slug())).await?;
    let default_branch = info["default_branch"].as_str().unwrap_or("main").to_string();
    let branch = match q.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => default_branch.clone(),
    };
    let branches: Vec<String> = gh
        .get(&format!("/repos/{}/branches?per_page=100", repo.slug()))
        .await?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["name"].as_str().map(str::to_string))
        .collect();

    let link = Link {
        repo: repo.clone(),
        branch: branch.clone(),
        subdir: String::new(),
        linked_by: None,
        base_commit: None,
        synced_at: None,
        auto_push: false,
        last_auto: None,
    };
    let remote = remote_files(&gh, &link).await?;

    // A project is a folder with a .kicad_pro in it; its files are everything
    // usable at or below that folder.
    let mut folders: BTreeMap<String, String> = BTreeMap::new();
    for path in remote.files.keys() {
        if let Some(stem) = path.strip_suffix(".kicad_pro") {
            let (dir, name) = match stem.rsplit_once('/') {
                Some((d, n)) => (d.to_string(), n.to_string()),
                None => (String::new(), stem.to_string()),
            };
            folders.entry(dir).or_insert(name);
        }
    }
    // KiCad files but no project file anywhere: offer the root as it is.
    if folders.is_empty() && !remote.files.is_empty() {
        folders.insert(String::new(), repo.name.clone());
    }
    let projects: Vec<Value> = folders
        .iter()
        .map(|(dir, name)| {
            let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
            let files = remote.files.keys().filter(|p| p.starts_with(&prefix)).count();
            json!({ "path": dir, "name": name, "files": files })
        })
        .collect();

    Ok(Json(json!({
        "repo": repo.slug(),
        "private": info["private"].as_bool().unwrap_or(false),
        "canPush": info["permissions"]["push"].as_bool().unwrap_or(false),
        "defaultBranch": default_branch,
        "branch": branch,
        "branchExists": remote.head.is_some(),
        "branches": branches,
        "projects": projects,
        "truncated": remote.truncated,
    }))
    .into_response())
}

// ------------------------------------------------------------------ import

#[derive(Deserialize)]
pub struct ImportRequest {
    pub repo: String,
    pub branch: Option<String>,
    #[serde(default)]
    pub path: String,
    pub name: Option<String>,
}

/// Create an online project from a repository folder, already linked and in sync.
pub async fn import_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    LenientJson(req): LenientJson<ImportRequest>,
) -> AppResult<Response> {
    let gh = Gh::for_user(&state, &user).await?;
    let repo = RepoRef::parse(&req.repo)?;
    let subdir = clean_subdir(&req.path)?;
    let branch = match req.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => gh.get(&format!("/repos/{}", repo.slug())).await?["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string(),
    };
    let link = Link { repo: repo.clone(), branch: branch.clone(), subdir: subdir.clone(), linked_by: None, base_commit: None, synced_at: None, auto_push: false, last_auto: None };
    let remote = remote_files(&gh, &link).await?;
    let head = remote.head.clone().ok_or_else(|| {
        AppError::BadRequest(format!("{} has no branch named {branch}.", repo.slug()))
    })?;
    if remote.files.is_empty() {
        return Err(AppError::BadRequest("There are no KiCad files in that folder.".into()));
    }
    if remote.files.len() > MAX_FILES {
        return Err(AppError::BadRequest(format!("That folder has too many files (max {MAX_FILES}).")));
    }
    let total: u64 = remote.files.values().map(|(_, s)| *s).sum();
    if total > MAX_TOTAL_BYTES || remote.files.values().any(|(_, s)| *s > MAX_FILE_BYTES) {
        return Err(AppError::BadRequest("That project is too large to bring online.".into()));
    }

    // Download everything before creating anything, so a failure leaves no half project.
    let shas: Vec<String> = remote.files.values().map(|(sha, _)| sha.clone()).collect();
    let contents: Vec<(String, String, Vec<u8>)> = remote
        .files
        .keys()
        .cloned()
        .zip(shas.iter().cloned())
        .zip(gh.blobs(&repo, &shas).await?)
        .map(|((path, sha), bytes)| (path, sha, bytes))
        .collect();

    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| {
            remote.files.keys().find(|p| p.ends_with(".kicad_pro") && !p.contains('/')).map(|p| {
                p.trim_end_matches(".kicad_pro").to_string()
            })
        })
        .unwrap_or_else(|| subdir.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(&repo.name).to_string());

    let project = persist::create_project(&state.pool, user.id, &name).await?;
    let mut agreed = Vec::new();
    for (path, sha, content) in &contents {
        let doc = persist::create_document(&state.pool, project.id, path, doc_type_for(path)).await?;
        persist::insert_snapshot(&state.pool, doc.id, 0, content, None, Some(user.id)).await?;
        agreed.push((path.clone(), sha.clone()));
    }
    save_link(&state, project.id, &repo, &branch, &subdir, user.id).await?;
    save_base(&state, project.id, &agreed, Some(&head)).await?;

    Ok(Json(json!({ "projectId": project.id, "name": project.name, "files": contents.len() })).into_response())
}

// ------------------------------------------------------------------ link / unlink

#[derive(Deserialize)]
pub struct CreateRepo {
    pub name: String,
    #[serde(default = "yes")]
    pub private: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct LinkRequest {
    /// `owner/name` of an existing repository…
    pub repo: Option<String>,
    /// …or a new one to create under the caller's account.
    pub create: Option<CreateRepo>,
    pub branch: Option<String>,
    #[serde(default)]
    pub path: String,
}

/// Point a project at a repository folder.  Owner only.  Nothing is written to
/// GitHub (beyond creating the repository, when asked) until the first push.
pub async fn link_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<LinkRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    if !a.is_owner {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the project's owner can link it to a repository."));
    }
    let gh = Gh::for_user(&state, &user).await?;
    let subdir = clean_subdir(&req.path)?;

    let info = if let Some(create) = &req.create {
        if gh.kind == "app" {
            // The app is deliberately not allowed to administer repositories.
            return Err(api_err(
                StatusCode::BAD_REQUEST,
                "github_app_cannot_create",
                "Junction can only see the repositories you choose, so it can't create one. Create it on GitHub, \
                 add it to Junction's repositories, then pick it here.",
            ));
        }
        let name = create.name.trim();
        // Validates the name against GitHub's alphabet.
        RepoRef::parse(&format!("{}/{name}", user.login))?;
        gh.post(
            "/user/repos",
            json!({
                "name": name,
                "private": create.private,
                "description": format!("{} — KiCad project, synced with Junction", a.project.name),
                "auto_init": true,
            }),
        )
        .await
        .map_err(|e| match e.status {
            422 => AppError::BadRequest(format!("GitHub would not create \"{name}\": {}. Is the name taken?", e.message)),
            _ => e.into(),
        })?
    } else {
        let repo = RepoRef::parse(req.repo.as_deref().unwrap_or(""))?;
        gh.get(&format!("/repos/{}", repo.slug())).await?
    };

    let repo = RepoRef::parse(info["full_name"].as_str().unwrap_or(""))?;
    let branch = match req.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => clean_branch(b)?,
        None => info["default_branch"].as_str().unwrap_or("main").to_string(),
    };
    save_link(&state, id, &repo, &branch, &subdir, user.id).await?;
    Ok(Json(json!({ "ok": true, "repo": repo.slug(), "branch": branch, "path": subdir })).into_response())
}

pub async fn unlink_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    if !a.is_owner {
        return Err(api_err(StatusCode::FORBIDDEN, "forbidden", "Only the project's owner can unlink it."));
    }
    sqlx::query("DELETE FROM project_github_files WHERE project_id = $1").bind(id).execute(&state.pool).await?;
    sqlx::query("DELETE FROM project_github WHERE project_id = $1").bind(id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

// ------------------------------------------------------------------ status

fn link_json(state: &AppState, link: &Link) -> Value {
    json!({
        "repo": link.repo.slug(),
        "branch": link.branch,
        "path": link.subdir,
        "url": link.web_url(state),
        "linkedBy": link.linked_by,
        "baseCommit": link.base_commit,
        "syncedAt": link.synced_at.map(|t| t.to_rfc3339()),
        "autoPush": link.auto_push,
        "lastAuto": link.last_auto,
    })
}

/// Everything the sync page shows: the link, both sides' head, and each file's standing.
pub async fn project_status(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    let grant = load_grant(&state, user.id).await?;
    let connected = grant.is_some();
    let app = crate::github_app::creds(&state).await?;
    let app_ready = app.is_some();
    let mut out = json!({
        "project": { "projectId": a.project.id, "name": a.project.name, "role": a.role, "isOwner": a.is_owner },
        "github": {
            "configured": state.cfg.github_client_id.is_some() || app_ready,
            "connected": connected,
            "login": user.login,
            "via": grant.as_ref().map(|g| if g.kind == "app" { "app" } else { "oauth" }),
            "legacy": app_ready && grant.as_ref().is_some_and(|g| g.kind != "app"),
            "app": app.as_ref().map(|a| json!({ "name": a.name, "slug": a.slug, "url": a.html_url })),
        },
        "link": Value::Null,
    });
    let Some(link) = load_link(&state, id).await? else {
        return Ok(Json(out).into_response());
    };
    out["link"] = link_json(&state, &link);
    if !connected {
        return Ok(Json(out).into_response());
    }

    let gh = Gh::for_user(&state, &user).await?;
    // A repository the caller cannot see (or that is gone) is a state to show, not an error page.
    let info = match gh.get(&format!("/repos/{}", link.repo.slug())).await {
        Ok(v) => v,
        Err(e) if e.status == 404 || e.status == 403 => {
            out["remote"] = json!({ "reachable": false, "reason": AppError::from(e).to_string() });
            return Ok(Json(out).into_response());
        }
        Err(e) => return Err(e.into()),
    };
    let remote = remote_files(&gh, &link).await?;
    let local = local_files(&state, id).await?;
    let base = load_base(&state, id).await?;
    let entries = compare(&local, &remote, &base);

    // Files that are identical right now are a common ancestor whether or not a
    // push or pull ever recorded one (a project linked to a repository that already
    // held the same files).  Remember it, or the next edit on one side would look
    // like "differs, never synced" instead of a plain change.
    let newly_agreed: Vec<(String, String)> = entries
        .iter()
        .filter(|e| e.change == Change::Synced)
        .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s)))
        .filter(|(p, s)| base.get(p) != Some(s))
        .collect();
    if !newly_agreed.is_empty() {
        save_base(&state, id, &newly_agreed, None).await?;
    }

    let commits: Vec<Value> = match &remote.head {
        Some(_) => {
            let mut url = format!("/repos/{}/commits?per_page=6&sha={}", link.repo.slug(), enc(&link.branch));
            if !link.subdir.is_empty() {
                url.push_str(&format!("&path={}", enc(&link.subdir)));
            }
            gh.get(&url)
                .await
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .map(|c| {
                    json!({
                        "sha": c["sha"],
                        "message": c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""),
                        "author": c["author"]["login"].as_str().or(c["commit"]["author"]["name"].as_str()),
                        "date": c["commit"]["author"]["date"],
                        "url": c["html_url"],
                    })
                })
                .collect()
        }
        None => Vec::new(),
    };

    let count = |c: Change| entries.iter().filter(|e| e.change == c).count();
    let files: Vec<Value> = entries
        .iter()
        .map(|e| {
            let l = local.get(&e.path);
            json!({
                "path": e.path,
                "state": e.change.as_str(),
                "detail": e.detail,
                "docId": l.map(|f| f.doc.id),
                "docType": l.map(|f| f.doc.doc_type.clone()).unwrap_or_else(|| doc_type_for(&e.path).to_string()),
                "size": l.map(|f| f.size as u64).unwrap_or(e.remote_size),
                "unsavedOps": l.map(|f| f.unsaved_ops).unwrap_or(0),
                "mergeable": merge::mergeable(doc_type_for(&e.path)),
            })
        })
        .collect();

    out["remote"] = json!({
        "reachable": true,
        "private": info["private"].as_bool().unwrap_or(false),
        "canPush": info["permissions"]["push"].as_bool().unwrap_or(false),
        "defaultBranch": info["default_branch"],
        "branchExists": remote.head.is_some(),
        "head": remote.head,
        "commits": commits,
        "truncated": remote.truncated,
    });
    out["files"] = json!(files);
    out["summary"] = json!({
        "push": count(Change::Push), "pull": count(Change::Pull),
        "conflict": count(Change::Conflict), "synced": count(Change::Synced),
        "unsaved": local.values().filter(|f| f.unsaved_ops > 0).count(),
    });
    Ok(Json(out).into_response())
}

// ------------------------------------------------------------------ what changed inside a file

#[derive(Deserialize)]
pub struct DiffQuery {
    pub path: String,
}

const DIFF_LIMIT: usize = 200;

fn changes_json(old: Option<&[u8]>, new: Option<&[u8]>) -> Value {
    let (Some(old), Some(new)) = (old, new) else { return Value::Null };
    if old == new {
        return json!({ "changes": [], "total": 0 });
    }
    let items = match (std::str::from_utf8(old), std::str::from_utf8(new)) {
        (Ok(o), Ok(n)) => merge::diff(o, n),
        _ => None,
    };
    match items {
        Some(items) => json!({ "total": items.len(), "changes": items.into_iter().take(DIFF_LIMIT).collect::<Vec<_>>() }),
        // Not an s-expression (the project file, a 3D model): only sizes can be told.
        None => json!({ "opaque": true, "oldSize": old.len(), "newSize": new.len() }),
    }
}

/// Item-level changes in one file: what the online project did since the last
/// sync and what GitHub did.  Without a common ancestor, the difference between
/// the two as they stand (GitHub -> online).
pub async fn file_diff(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<DiffQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = safe_zip_name(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;

    let remote = remote_files(&gh, &link).await?;
    let local = match persist::project_documents(&state.pool, id).await?.into_iter().find(|d| d.path == path) {
        Some(doc) => persist::latest_snapshot(&state.pool, doc.id).await?.map(|(_, c)| c),
        None => None,
    };
    let theirs = match remote.files.get(&path) {
        Some((sha, size)) if *size <= MAX_FILE_BYTES => Some(gh.blob(&link.repo, sha).await?),
        _ => None,
    };
    if local.is_none() && theirs.is_none() {
        return Err(AppError::NotFound);
    }
    let base = match load_base(&state, id).await?.get(&path) {
        // GitHub has not moved: the base is the copy just downloaded.
        Some(sha) if remote.files.get(&path).is_some_and(|(r, _)| r == sha) => theirs.clone(),
        Some(sha) => gh.blob(&link.repo, sha).await.ok(),
        None => None,
    };

    let out = match &base {
        Some(b) => json!({
            "path": path, "hasBase": true,
            "online": changes_json(Some(b), local.as_deref()),
            "github": changes_json(Some(b), theirs.as_deref()),
        }),
        None => json!({
            "path": path, "hasBase": false,
            "between": changes_json(theirs.as_deref(), local.as_deref()),
        }),
    };
    Ok(Json(out).into_response())
}

// ------------------------------------------------------------------ history (design review)

#[derive(Deserialize)]
pub struct CommitsQuery {
    /// Project-relative path of the file whose history is wanted.
    pub path: String,
    pub limit: Option<u32>,
}

/// The commits on the linked branch that changed one project file, newest first:
/// the versions the visual diff can compare with.
pub async fn file_commits(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<CommitsQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = safe_zip_name(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;
    let limit = q.limit.unwrap_or(30).clamp(1, 100);

    let list = match gh
        .get(&format!(
            "/repos/{}/commits?sha={}&path={}&per_page={limit}",
            link.repo.slug(),
            enc(&link.branch),
            enc(&link.repo_path(&path)),
        ))
        .await
    {
        Ok(v) => v,
        // 404: no such branch.  409: the repository has no commits at all.
        Err(e) if e.status == 404 || e.status == 409 => Value::Array(vec![]),
        Err(e) => return Err(e.into()),
    };

    let commits: Vec<Value> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let sha = c["sha"].as_str()?;
            let message = c["commit"]["message"].as_str().unwrap_or("");
            Some(json!({
                "sha": sha,
                "message": message.lines().next().unwrap_or(""),
                "author": c["author"]["login"].as_str().or_else(|| c["commit"]["author"]["name"].as_str()),
                "date": c["commit"]["author"]["date"],
                "url": c["html_url"],
            }))
        })
        .collect();

    Ok(Json(json!({
        "path": path,
        "repo": link.repo.slug(),
        "branch": link.branch,
        "commits": commits,
    }))
    .into_response())
}

#[derive(Deserialize)]
pub struct FileAtQuery {
    pub path: String,
    /// The commit to read the file from.
    pub sha: String,
}

/// One project file as it was at a commit of the linked repository.
pub async fn file_at_commit(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<FileAtQuery>,
) -> AppResult<Response> {
    access(&state, &user, id).await?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let path = safe_zip_name(&q.path).ok_or_else(|| AppError::BadRequest("bad path".into()))?;
    if q.sha.len() < 7 || q.sha.len() > 64 || !q.sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("bad commit id".into()));
    }

    let tree = gh.commit_tree(&link.repo, &q.sha).await?;
    let repo_path = link.repo_path(&path);
    let (dir, name) = match repo_path.rsplit_once('/') {
        Some((d, n)) => (d, n),
        None => ("", repo_path.as_str()),
    };
    let folder = gh.subtree(&link.repo, &tree, dir).await?.ok_or(AppError::NotFound)?;
    let listing = gh.get(&format!("/repos/{}/git/trees/{folder}", link.repo.slug())).await?;
    let entry = listing["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| e["type"] == "blob" && e["path"] == name)
        .ok_or(AppError::NotFound)?;
    if entry["size"].as_u64().unwrap_or(0) > MAX_FILE_BYTES {
        return Err(AppError::BadRequest("That file is too large to compare.".into()));
    }
    let sha = entry["sha"].as_str().ok_or(AppError::NotFound)?;
    let content = gh.blob(&link.repo, sha).await?;

    Ok(([(axum::http::header::CONTENT_TYPE, "application/octet-stream")], content).into_response())
}

// ------------------------------------------------------------------ push

#[derive(Deserialize, Default)]
pub struct PushRequest {
    pub message: Option<String>,
    /// Only these project paths; everything pushable when absent.
    pub paths: Option<Vec<String>>,
    /// Paths in conflict to push anyway, replacing GitHub's version.
    #[serde(default)]
    pub overwrite: Vec<String>,
    /// Commit to a new branch and open a pull request instead of committing to the linked branch.
    #[serde(default, rename = "pullRequest")]
    pub pull_request: bool,
}

pub async fn push(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<PushRequest>,
) -> AppResult<Response> {
    Ok(Json(push_as(&state, &user, id, req).await?).into_response())
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    #[serde(rename = "autoPush")]
    pub auto_push: bool,
}

/// Turn pushing on every checkpoint on or off.
pub async fn settings(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<SettingsRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let done = sqlx::query("UPDATE project_github SET auto_push = $2 WHERE project_id = $1")
        .bind(id)
        .bind(req.auto_push)
        .execute(&state.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::BadRequest("This project is not linked to a repository.".into()));
    }
    Ok(Json(json!({ "ok": true, "autoPush": req.auto_push })).into_response())
}

/// Called when a checkpoint is saved: if the project asks for it, push what
/// changed to GitHub in the background, as the person who saved the checkpoint.
/// Files changed on both sides are left for the sync page.  Returns whether a
/// push was started.
pub async fn push_on_checkpoint(state: &AppState, user: &User, project_id: Uuid, checkpoint: &str) -> bool {
    match load_link(state, project_id).await {
        Ok(Some(link)) if link.auto_push => {}
        _ => return false,
    }
    let (state, user, name) = (state.clone(), user.clone(), checkpoint.trim().to_string());
    tokio::spawn(async move {
        let req = PushRequest { message: Some(format!("Checkpoint: {name}")), ..Default::default() };
        let mut report = match push_as(&state, &user, project_id, req).await {
            Ok(v) => json!({
                "ok": true,
                "message": match v["pushed"].as_array().map_or(0, Vec::len) {
                    1 => "Pushed 1 file".to_string(),
                    n => format!("Pushed {n} files"),
                },
                "commit": v["commit"], "commitUrl": v["commitUrl"],
            }),
            Err(AppError::Api(_, "nothing_to_push", _)) => json!({ "ok": true, "message": "Nothing had changed" }),
            Err(e) => json!({ "ok": false, "message": e.to_string() }),
        };
        report["at"] = json!(chrono::Utc::now().to_rfc3339());
        report["by"] = json!(user.login);
        report["checkpoint"] = json!(name);
        if let Err(e) = sqlx::query("UPDATE project_github SET last_auto = $2 WHERE project_id = $1")
            .bind(project_id)
            .bind(&report)
            .execute(&state.pool)
            .await
        {
            tracing::warn!("recording an automatic github push failed: {e}");
        }
    });
    true
}

async fn push_as(state: &AppState, user: &User, id: Uuid, req: PushRequest) -> AppResult<Value> {
    let (state, user) = (state.clone(), user.clone());
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let repo = &link.repo;

    freshen(&state, id).await?;
    let remote = remote_files(&gh, &link).await?;
    let local = local_files(&state, id).await?;
    let base = load_base(&state, id).await?;
    let entries = compare(&local, &remote, &base);

    let overwrite: HashSet<&str> = req.overwrite.iter().map(String::as_str).collect();
    let only: Option<HashSet<&str>> = req.paths.as_ref().map(|p| p.iter().map(String::as_str).collect());
    let targets: Vec<&Entry> = entries
        .iter()
        .filter(|e| match e.change {
            Change::Push => true,
            Change::Conflict => overwrite.contains(e.path.as_str()),
            _ => false,
        })
        .filter(|e| only.as_ref().is_none_or(|o| o.contains(e.path.as_str())))
        .collect();
    if targets.is_empty() {
        return Err(api_err(StatusCode::CONFLICT, "nothing_to_push", "There is nothing to push."));
    }

    // Read the files to commit.  The blob id must still be the one compared above:
    // a snapshot landing in between would otherwise be recorded as synced unseen.
    let mut files: Vec<(String, String, Vec<u8>)> = Vec::new();
    for e in &targets {
        let lf = &local[&e.path];
        let (_, content) = persist::latest_snapshot(&state.pool, lf.doc.id)
            .await?
            .ok_or(AppError::NotFound)?;
        files.push((e.path.clone(), blob_sha(&content), content));
    }

    let message = req
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Update {} from Junction", a.project.name));

    if req.pull_request && remote.head.is_none() {
        return Err(AppError::BadRequest(format!(
            "A pull request needs the branch {} to exist on GitHub. Push normally first.",
            link.branch
        )));
    }

    // Where the commit goes: the linked branch, created from the default branch if
    // it does not exist yet — or seeded with a first commit in an empty repository.
    let mut parent = remote.head.clone();
    let mut parent_tree = remote.tree.clone();
    let mut seeded: Option<String> = None;
    if parent.is_none() {
        let info = gh.get(&format!("/repos/{}", repo.slug())).await?;
        let default_branch = info["default_branch"].as_str().unwrap_or("main").to_string();
        match gh.branch_head(repo, &default_branch).await? {
            Some(sha) if default_branch != link.branch => {
                parent_tree = Some(gh.commit_tree(repo, &sha).await?);
                parent = Some(sha);
            }
            _ => {
                // No commits at all: git's object API refuses an empty repository,
                // the contents API does not.  It makes the first commit with one file.
                let (path, _, content) = &files[0];
                let v = gh
                    .call(
                        reqwest::Method::PUT,
                        &format!("/repos/{}/contents/{}", repo.slug(), enc_path(&link.repo_path(path))),
                        Some(json!({ "message": message, "content": B64.encode(content), "branch": link.branch })),
                    )
                    .await?;
                let sha = v["commit"]["sha"].as_str().unwrap_or("").to_string();
                parent_tree = Some(gh.commit_tree(repo, &sha).await?);
                parent = Some(sha.clone());
                seeded = Some(sha);
            }
        }
    }
    let parent = parent.expect("parent commit resolved above");

    let rest: Vec<&(String, String, Vec<u8>)> =
        files.iter().skip(if seeded.is_some() { 1 } else { 0 }).collect();
    let mut commit_sha = parent.clone();
    let mut commit_url = Value::Null;

    let target_branch = if req.pull_request {
        format!("kicad-collab/{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"))
    } else {
        link.branch.clone()
    };

    if !rest.is_empty() {
        let mut tree_items = Vec::new();
        for (path, sha, content) in &rest {
            let v = gh
                .post(
                    &format!("/repos/{}/git/blobs", repo.slug()),
                    json!({ "content": B64.encode(content), "encoding": "base64" }),
                )
                .await?;
            if v["sha"].as_str() != Some(sha.as_str()) {
                return Err(anyhow::anyhow!("github stored {path} under an unexpected blob id").into());
            }
            tree_items.push(json!({ "path": link.repo_path(path), "mode": "100644", "type": "blob", "sha": sha }));
        }
        let tree = gh
            .post(
                &format!("/repos/{}/git/trees", repo.slug()),
                json!({ "base_tree": parent_tree, "tree": tree_items }),
            )
            .await?;
        let commit = gh
            .post(
                &format!("/repos/{}/git/commits", repo.slug()),
                json!({ "message": message, "tree": tree["sha"], "parents": [parent] }),
            )
            .await?;
        commit_sha = commit["sha"].as_str().unwrap_or("").to_string();
        commit_url = commit["html_url"].clone();

        // Move the branch — never forced.  If GitHub's branch moved since it was
        // read, this fails and nothing is recorded.
        let moved = |e: GhErr| match e.status {
            422 | 409 => api_err(
                StatusCode::CONFLICT,
                "remote_moved",
                "The branch changed on GitHub while pushing. Refresh and try again.",
            ),
            _ => e.into(),
        };
        let exists = !req.pull_request && (remote.head.is_some() || seeded.is_some());
        if exists {
            gh.call(
                reqwest::Method::PATCH,
                &format!("/repos/{}/git/refs/heads/{}", repo.slug(), enc_path(&target_branch)),
                Some(json!({ "sha": commit_sha, "force": false })),
            )
            .await
            .map_err(moved)?;
        } else {
            gh.post(
                &format!("/repos/{}/git/refs", repo.slug()),
                json!({ "ref": format!("refs/heads/{target_branch}"), "sha": commit_sha }),
            )
            .await
            .map_err(moved)?;
        }
    }

    let pushed: Vec<&str> = files.iter().map(|(p, _, _)| p.as_str()).collect();

    if req.pull_request {
        // The linked branch has not moved, so nothing is recorded as synced: the
        // files show as synced by themselves once the pull request is merged.
        let pr = gh
            .post(
                &format!("/repos/{}/pulls", repo.slug()),
                json!({
                    "title": message,
                    "head": target_branch,
                    "base": link.branch,
                    "body": format!(
                        "Changes to **{}** made in Junction.\n\nFiles:\n{}",
                        a.project.name,
                        pushed.iter().map(|p| format!("- `{}`", link.repo_path(p))).collect::<Vec<_>>().join("\n")
                    ),
                }),
            )
            .await?;
        return Ok(json!({
            "ok": true, "pushed": pushed, "commit": commit_sha, "branch": target_branch,
            "pullRequest": { "number": pr["number"], "url": pr["html_url"] },
        }));
    }

    // Now level: what was pushed, plus everything that was already identical.
    let mut agreed: Vec<(String, String)> = files.iter().map(|(p, s, _)| (p.clone(), s.clone())).collect();
    agreed.extend(
        entries
            .iter()
            .filter(|e| e.change == Change::Synced)
            .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s))),
    );
    save_base(&state, id, &agreed, Some(&commit_sha)).await?;

    Ok(json!({
        "ok": true, "pushed": pushed, "commit": commit_sha, "commitUrl": commit_url, "branch": target_branch,
    }))
}

// ------------------------------------------------------------------ pull

#[derive(Deserialize, Default)]
pub struct PullRequest {
    /// Only these project paths; everything pullable when absent.
    pub paths: Option<Vec<String>>,
    /// What to do with a file changed on both sides: `merge` (default where the
    /// file type allows), `github` (take theirs) or `online` (keep ours).
    #[serde(default)]
    pub resolve: HashMap<String, String>,
    /// Which side wins an item both changed, inside a merge: `online` (default) or `github`.
    pub prefer: Option<String>,
    /// Replace documents that still have edits not saved into a snapshot.
    #[serde(default)]
    pub force: bool,
}

pub async fn pull(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    LenientJson(req): LenientJson<PullRequest>,
) -> AppResult<Response> {
    let a = access(&state, &user, id).await?;
    require_editor(&a)?;
    let link = load_link(&state, id).await?.ok_or_else(|| AppError::BadRequest("This project is not linked to a repository.".into()))?;
    let gh = Gh::for_user(&state, &user).await?;
    let repo = &link.repo;

    freshen(&state, id).await?;
    let remote = remote_files(&gh, &link).await?;
    let head = remote.head.clone().ok_or_else(|| {
        AppError::BadRequest(format!("{} has no branch named {} yet. Push first.", repo.slug(), link.branch))
    })?;
    let local = local_files(&state, id).await?;
    let base = load_base(&state, id).await?;
    let entries = compare(&local, &remote, &base);
    let only: Option<HashSet<&str>> = req.paths.as_ref().map(|p| p.iter().map(String::as_str).collect());
    let prefer = if req.prefer.as_deref() == Some("github") { Prefer::Theirs } else { Prefer::Ours };

    if local.len() + entries.iter().filter(|e| e.local.is_none()).count() > MAX_FILES {
        return Err(AppError::BadRequest(format!("Pulling would exceed {MAX_FILES} files in the project.")));
    }

    let stamp = format!("Before GitHub pull {}", chrono::Utc::now().format("%Y-%m-%d %H:%M"));
    let mut updated = Vec::new();
    let mut skipped = Vec::new();
    let mut agreed: Vec<(String, String)> = Vec::new();

    for e in &entries {
        if !matches!(e.change, Change::Pull | Change::Conflict) {
            continue;
        }
        if only.as_ref().is_some_and(|o| !o.contains(e.path.as_str())) {
            continue;
        }
        let remote_sha = e.remote.clone().expect("pull/conflict entries exist remotely");
        let lf = local.get(&e.path);
        let mut skip = |why: &str| skipped.push(json!({ "path": e.path, "reason": why }));

        if e.remote_size > MAX_FILE_BYTES {
            skip("too large");
            continue;
        }

        let choice = match e.change {
            Change::Pull => "github",
            _ => match req.resolve.get(&e.path).map(String::as_str) {
                Some(c @ ("merge" | "github" | "online")) => c,
                _ if merge::mergeable(doc_type_for(&e.path)) => "merge",
                _ => {
                    skip("changed on both sides; choose which version to keep");
                    continue;
                }
            },
        };

        // Keeping ours changes nothing online; it only records that GitHub's
        // version has been seen, so the file becomes a plain "changed online".
        if choice == "online" {
            agreed.push((e.path.clone(), remote_sha));
            updated.push(json!({ "path": e.path, "action": "kept online" }));
            continue;
        }

        if let Some(lf) = lf {
            if lf.unsaved_ops > 0 && !req.force {
                skip("has live edits that are not saved yet; save in the desktop app, or pull anyway");
                continue;
            }
        }

        let theirs = gh.blob(repo, &remote_sha).await?;
        let mut report = json!({ "path": e.path, "action": "updated" });
        let content = if choice == "merge" {
            let lf = lf.expect("a conflict has a local file");
            let (_, ours) = persist::latest_snapshot(&state.pool, lf.doc.id).await?.ok_or(AppError::NotFound)?;
            // The common ancestor, if GitHub still has it; without one the merge
            // is two-way (every difference is a conflict, nothing is deleted).
            let base_bytes = match base.get(&e.path) {
                Some(sha) => gh.blob(repo, sha).await.ok(),
                None => None,
            };
            let merged = match (std::str::from_utf8(&ours), std::str::from_utf8(&theirs)) {
                (Ok(o), Ok(t)) => merge::merge3(
                    base_bytes.as_deref().and_then(|b| std::str::from_utf8(b).ok()),
                    o,
                    t,
                    prefer,
                ),
                _ => None,
            };
            let Some(m) = merged else {
                skip("could not be merged automatically; choose which version to keep");
                continue;
            };
            report = json!({
                "path": e.path, "action": "merged",
                "fromGithub": m.from_theirs, "fromOnline": m.from_ours, "conflicts": m.conflicts,
            });
            m.text.into_bytes()
        } else {
            theirs
        };

        match lf {
            Some(lf) => {
                if blob_sha(&content) != lf.sha {
                    // Keep what is being replaced as a version: restorable from History
                    // and never pruned.
                    crate::versions::keep_doc(&state.pool, id, user.id, &stamp, &lf.doc).await?;
                    crate::versions::reset_to_content(&state, user.id, lf.doc.id, &content).await?;
                }
            }
            None => {
                let doc = persist::create_document(&state.pool, id, &e.path, doc_type_for(&e.path)).await?;
                persist::insert_snapshot(&state.pool, doc.id, 0, &content, None, Some(user.id)).await?;
                report["action"] = json!("added");
            }
        }
        // GitHub's version is now the common ancestor (a merge result that differs
        // from it shows as "changed online", ready to push).
        agreed.push((e.path.clone(), remote_sha));
        updated.push(report);
    }

    agreed.extend(
        entries
            .iter()
            .filter(|e| e.change == Change::Synced)
            .filter_map(|e| e.local.clone().map(|s| (e.path.clone(), s))),
    );
    save_base(&state, id, &agreed, Some(&head)).await?;

    Ok(Json(json!({
        "ok": true, "updated": updated, "skipped": skipped, "head": head,
        "checkpoint": if updated.iter().any(|u| matches!(u["action"].as_str(), Some("updated" | "merged"))) { json!(stamp) } else { Value::Null },
    }))
    .into_response())
}

// ------------------------------------------------------------------ page

/// The GitHub page: `/github` (bring a repository online) and `/p/{id}/github`
/// (one project's sync).  One self-contained document; web/github/index.ts draws it.
pub async fn page() -> Response {
    // The script is asked for with its own content hash, so a browser (or a proxy that
    // adds its own max-age) never runs an older copy against this server.
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let page = PAGE.get_or_init(|| {
        let v = format!("{:x}", Sha256::digest(include_str!("../static/dist/github.js").as_bytes()));
        include_str!("../static/github.html")
            .replace("{{THEME}}", crate::pages::THEME_CSS)
            .replace("{{MARK}}", crate::pages::MARK)
            .replace("\"/static/github.js\"", &format!("\"/static/github.js?v={}\"", &v[..16]))
    });
    ([(header::CACHE_CONTROL, "no-cache")], Html(page.clone())).into_response()
}

/// The theme's tokens only (static/theme.css up to its components marker): for a page that
/// brings its own component styles, the home page.  Pages that want the shared components
/// too use `pages::THEME_CSS`.
pub(crate) fn theme_tokens() -> &'static str {
    let css = crate::pages::THEME_CSS;
    match css.find("/* ==== components ==== */") {
        Some(end) => &css[..end],
        None => css,
    }
}

pub async fn page_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")],
        include_str!("../static/dist/github.js"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_takes_its_colours_from_the_app() {
        let t = theme_tokens();
        assert!(t.contains("--bench:") && t.contains("--ink:") && t.contains("--copper:"), "{t}");
        assert!(t.contains("[data-theme=\"dark\"]"), "explicit dark theme block is carried over");
        assert_eq!(t.matches('{').count(), t.matches('}').count(), "balanced css");
        assert!(!t.contains(".btn {"), "tokens only, no component rules");
        for page in [include_str!("../static/github.html"), include_str!("../static/app.html"), include_str!("../static/landing.html"),
                     include_str!("../static/styleguide.html")] {
            assert!(!page.contains("--bench: #"), "no page carries a palette of its own");
        }
    }

    #[test]
    fn blob_ids_match_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn classification() {
        use Change::*;
        let c = |l, r, b| classify(l, r, b).map(|(c, _)| c);
        assert_eq!(c(None, None, None), None);
        assert_eq!(c(Some("a"), Some("a"), None), Some(Synced));
        assert_eq!(c(Some("a"), Some("a"), Some("z")), Some(Synced));
        assert_eq!(c(Some("b"), Some("a"), Some("a")), Some(Push));
        assert_eq!(c(Some("a"), Some("b"), Some("a")), Some(Pull));
        assert_eq!(c(Some("b"), Some("c"), Some("a")), Some(Conflict));
        assert_eq!(c(Some("b"), Some("c"), None), Some(Conflict));
        assert_eq!(c(Some("a"), None, None), Some(Push));
        assert_eq!(c(Some("a"), None, Some("a")), Some(Push));
        assert_eq!(c(None, Some("a"), None), Some(Pull));
    }

    #[test]
    fn repo_and_path_validation() {
        assert_eq!(RepoRef::parse("https://github.com/o/r.git").unwrap().slug(), "o/r");
        assert_eq!(RepoRef::parse(" o/r ").unwrap().slug(), "o/r");
        assert!(RepoRef::parse("o").is_err());
        assert!(RepoRef::parse("o/r/x").is_err());
        assert!(RepoRef::parse("o/..").is_err());
        assert!(RepoRef::parse("o/r?x=1").is_err());
        assert_eq!(clean_subdir("/hw/board/").unwrap(), "hw/board");
        assert_eq!(clean_subdir("").unwrap(), "");
        assert!(clean_subdir("a/../b").is_err());
        assert!(clean_branch("feature/x").is_ok());
        assert!(clean_branch("a..b").is_err());
        assert!(clean_branch("a b").is_err());
    }
}
