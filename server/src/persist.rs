use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub type DbResult<T> = Result<T, sqlx::Error>;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub github_id: i64,
    pub login: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Project {
    pub id: Uuid,
    pub owner_id: i64,
    pub name: String,
    pub public: bool,
    pub description: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Document {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub doc_type: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ShareLink {
    pub token: String,
    pub project_id: Uuid,
    pub role: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OpRow {
    pub seq: i64,
    pub author_id: i64,
    pub client_id: String,
    pub changes: Value,
}

pub async fn get_user(pool: &PgPool, id: i64) -> DbResult<Option<User>> {
    sqlx::query_as::<_, User>(
        "SELECT id, github_id, login, name, email, avatar_url FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn upsert_user(
    pool: &PgPool,
    github_id: i64,
    login: &str,
    name: Option<&str>,
    email: Option<&str>,
    avatar_url: Option<&str>,
) -> DbResult<User> {
    sqlx::query_as::<_, User>(
        "INSERT INTO users (github_id, login, name, email, avatar_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (github_id) DO UPDATE
           SET login = EXCLUDED.login, name = EXCLUDED.name,
               email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url
         RETURNING id, github_id, login, name, email, avatar_url",
    )
    .bind(github_id)
    .bind(login)
    .bind(name)
    .bind(email)
    .bind(avatar_url)
    .fetch_one(pool)
    .await
}

/// Attach pending invite grants (by login or any verified email) to a user.
/// If the user already has a permissions row on a project, keep the higher role.
pub async fn fill_pending_grants(
    pool: &PgPool,
    user_id: i64,
    login: &str,
    verified_emails: &[String],
) -> DbResult<()> {
    let pending = sqlx::query(
        "SELECT id, project_id, role FROM permissions
         WHERE user_id IS NULL AND (invited_login = $1 OR invited_email = ANY($2))",
    )
    .bind(login)
    .bind(verified_emails)
    .fetch_all(pool)
    .await?;

    for row in pending {
        let perm_id: i64 = row.get("id");
        let project_id: Uuid = row.get("project_id");
        let role: String = row.get("role");
        let claimed = sqlx::query(
            "UPDATE permissions SET user_id = $1 WHERE id = $2 AND user_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM permissions WHERE project_id = $3 AND user_id = $1)",
        )
        .bind(user_id)
        .bind(perm_id)
        .bind(project_id)
        .execute(pool)
        .await?;
        if claimed.rows_affected() == 0 {
            // User already has a row on this project: upgrade role if the invite is higher.
            if role == "editor" {
                sqlx::query(
                    "UPDATE permissions SET role = 'editor' WHERE project_id = $1 AND user_id = $2",
                )
                .bind(project_id)
                .bind(user_id)
                .execute(pool)
                .await?;
            }
            sqlx::query("DELETE FROM permissions WHERE id = $1 AND user_id IS NULL")
                .bind(perm_id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProjectListing {
    pub id: Uuid,
    pub name: String,
    pub owner_id: i64,
    pub owner_login: String,
    pub role: String,
    pub public: bool,
    pub doc_count: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Every project the user owns or has a claimed grant on, most recently
/// edited first. "Edited" is the newest op or snapshot in any of its docs.
pub async fn list_projects_for_user(pool: &PgPool, user_id: i64) -> DbResult<Vec<ProjectListing>> {
    sqlx::query_as::<_, ProjectListing>(
        "SELECT p.id, p.name, p.owner_id, u.login AS owner_login,
                CASE WHEN p.owner_id = $1 THEN 'editor' ELSE perm.role END AS role,
                p.public,
                (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS doc_count,
                p.created_at,
                GREATEST(
                    p.created_at,
                    COALESCE((SELECT MAX(o.created_at) FROM ops o
                              JOIN documents d ON d.id = o.doc_id
                              WHERE d.project_id = p.id), p.created_at),
                    COALESCE((SELECT MAX(s.created_at) FROM snapshots s
                              JOIN documents d ON d.id = s.doc_id
                              WHERE d.project_id = p.id), p.created_at)
                ) AS updated_at
         FROM projects p
         JOIN users u ON u.id = p.owner_id
         LEFT JOIN permissions perm ON perm.project_id = p.id AND perm.user_id = $1
         WHERE p.owner_id = $1 OR perm.user_id IS NOT NULL
         ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

pub async fn update_project(
    pool: &PgPool,
    id: Uuid,
    name: Option<&str>,
    public: Option<bool>,
    description: Option<&str>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE projects SET name = COALESCE($2, name), public = COALESCE($3, public),
                             description = COALESCE($4, description)
         WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(public)
    .bind(description)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GalleryEntry {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub owner_login: String,
    pub doc_count: i64,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Gallery: every public project, most recently edited first.  "Edited" is
/// the newest op or snapshot in any of its docs, like the user listing.
pub async fn list_public_projects(pool: &PgPool, limit: i64) -> DbResult<Vec<GalleryEntry>> {
    sqlx::query_as::<_, GalleryEntry>(
        "SELECT p.id, p.name, p.description, u.login AS owner_login,
                (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS doc_count,
                GREATEST(
                    p.created_at,
                    COALESCE((SELECT MAX(o.created_at) FROM ops o
                              JOIN documents d ON d.id = o.doc_id
                              WHERE d.project_id = p.id), p.created_at),
                    COALESCE((SELECT MAX(s.created_at) FROM snapshots s
                              JOIN documents d ON d.id = s.doc_id
                              WHERE d.project_id = p.id), p.created_at)
                ) AS updated_at
         FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE p.public ORDER BY updated_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Documents, ops, snapshots, permissions and share links all cascade.
pub async fn delete_project(pool: &PgPool, id: Uuid) -> DbResult<bool> {
    let res = sqlx::query("DELETE FROM projects WHERE id = $1").bind(id).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Prefix match on login or display name, for the share-dialog typeahead.
pub async fn search_users(pool: &PgPool, query: &str, limit: i64) -> DbResult<Vec<User>> {
    let escaped =
        query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    sqlx::query_as::<_, User>(
        "SELECT id, github_id, login, name, email, avatar_url FROM users
         WHERE lower(login) LIKE lower($1) || '%'
            OR lower(COALESCE(name, '')) LIKE lower($1) || '%'
         ORDER BY lower(login) LIMIT $2",
    )
    .bind(escaped)
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub async fn find_user_by_login(pool: &PgPool, login: &str) -> DbResult<Option<User>> {
    sqlx::query_as::<_, User>(
        "SELECT id, github_id, login, name, email, avatar_url FROM users
         WHERE lower(login) = lower($1)
         ORDER BY id LIMIT 1",
    )
    .bind(login)
    .fetch_optional(pool)
    .await
}

pub async fn find_user_by_email(pool: &PgPool, email: &str) -> DbResult<Option<User>> {
    sqlx::query_as::<_, User>(
        "SELECT id, github_id, login, name, email, avatar_url FROM users
         WHERE lower(email) = lower($1)
         ORDER BY id LIMIT 1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
}

/// Grant a role directly (invitee already has an account), never downgrading.
pub async fn grant_role(pool: &PgPool, project_id: Uuid, user_id: i64, role: &str) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO permissions (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
           SET role = CASE WHEN permissions.role = 'editor' THEN 'editor' ELSE EXCLUDED.role END",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

/// Pending (unclaimed) invites on a project: (permission id, login, email, role).
pub async fn list_pending_invites(
    pool: &PgPool,
    project_id: Uuid,
) -> DbResult<Vec<(i64, Option<String>, Option<String>, String)>> {
    let rows = sqlx::query(
        "SELECT id, invited_login, invited_email, role FROM permissions
         WHERE project_id = $1 AND user_id IS NULL
         ORDER BY id",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| (r.get("id"), r.get("invited_login"), r.get("invited_email"), r.get("role")))
        .collect())
}

pub async fn delete_pending_invite(pool: &PgPool, project_id: Uuid, perm_id: i64) -> DbResult<bool> {
    let res = sqlx::query(
        "DELETE FROM permissions WHERE id = $1 AND project_id = $2 AND user_id IS NULL",
    )
    .bind(perm_id)
    .bind(project_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn create_project(pool: &PgPool, owner_id: i64, name: &str) -> DbResult<Project> {
    sqlx::query_as::<_, Project>(
        "INSERT INTO projects (owner_id, name) VALUES ($1, $2)\n         RETURNING id, owner_id, name, public, description",
    )
    .bind(owner_id)
    .bind(name)
    .fetch_one(pool)
    .await
}

pub async fn get_project(pool: &PgPool, id: Uuid) -> DbResult<Option<Project>> {
    sqlx::query_as::<_, Project>(
        "SELECT id, owner_id, name, public, description FROM projects WHERE id = $1",
    )
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn create_document(
    pool: &PgPool,
    project_id: Uuid,
    path: &str,
    doc_type: &str,
) -> DbResult<Document> {
    sqlx::query_as::<_, Document>(
        "INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3)
         RETURNING id, project_id, path, doc_type",
    )
    .bind(project_id)
    .bind(path)
    .bind(doc_type)
    .fetch_one(pool)
    .await
}

pub async fn get_document(pool: &PgPool, id: Uuid) -> DbResult<Option<Document>> {
    sqlx::query_as::<_, Document>(
        "SELECT id, project_id, path, doc_type FROM documents WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn project_documents(pool: &PgPool, project_id: Uuid) -> DbResult<Vec<Document>> {
    sqlx::query_as::<_, Document>(
        "SELECT id, project_id, path, doc_type FROM documents WHERE project_id = $1 ORDER BY path",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

/// Effective role of a user on a project: owner => editor, else permissions row.
pub async fn effective_role(pool: &PgPool, user_id: i64, project_id: Uuid) -> DbResult<Option<String>> {
    let row = sqlx::query(
        "SELECT CASE
                  WHEN p.owner_id = $1 THEN 'editor'
                  WHEN perm.role IS NOT NULL THEN perm.role
                  WHEN p.public THEN 'viewer'
                  ELSE NULL
                END AS role
         FROM projects p
         LEFT JOIN permissions perm ON perm.project_id = p.id AND perm.user_id = $1
         WHERE p.id = $2",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|r| r.get::<Option<String>, _>("role")))
}

pub async fn create_share_link(
    pool: &PgPool,
    token: &str,
    project_id: Uuid,
    role: &str,
    created_by: i64,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO share_links (token, project_id, role, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(token)
    .bind(project_id)
    .bind(role)
    .bind(created_by)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// A share link that is neither revoked nor expired.
pub async fn get_valid_share_link(pool: &PgPool, token: &str) -> DbResult<Option<ShareLink>> {
    sqlx::query_as::<_, ShareLink>(
        "SELECT token, project_id, role FROM share_links
         WHERE token = $1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(token)
    .fetch_optional(pool)
    .await
}

pub async fn revoke_share_link(pool: &PgPool, token: &str, by_user: i64) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE share_links l SET revoked_at = now()
         FROM projects p
         WHERE l.token = $1 AND l.project_id = p.id AND p.owner_id = $2 AND l.revoked_at IS NULL",
    )
    .bind(token)
    .bind(by_user)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Claim a share link: grant its role, never downgrading an existing one.
pub async fn claim_share_link(pool: &PgPool, user_id: i64, link: &ShareLink) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO permissions (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
           SET role = CASE WHEN permissions.role = 'editor' THEN 'editor' ELSE EXCLUDED.role END",
    )
    .bind(link.project_id)
    .bind(user_id)
    .bind(&link.role)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn add_invite(
    pool: &PgPool,
    project_id: Uuid,
    invited_login: Option<&str>,
    invited_email: Option<&str>,
    role: &str,
    created_by: i64,
) -> DbResult<()> {
    // No unique constraint covers pending rows (user_id is NULL), so guard
    // against duplicate invites here.
    sqlx::query(
        "INSERT INTO permissions (project_id, invited_login, invited_email, role, created_by)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
             SELECT 1 FROM permissions
             WHERE project_id = $1 AND user_id IS NULL
               AND invited_login IS NOT DISTINCT FROM $2
               AND invited_email IS NOT DISTINCT FROM $3
         )",
    )
    .bind(project_id)
    .bind(invited_login)
    .bind(invited_email)
    .bind(role)
    .bind(created_by)
    .execute(pool)
    .await?;
    Ok(())
}

// ---------- Snapshots & ops ----------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Comment {
    pub id: i64,
    pub doc_id: Uuid,
    pub parent_id: Option<i64>,
    pub author_id: i64,
    pub author_login: String,
    pub x_nm: i64,
    pub y_nm: i64,
    pub body: String,
    pub resolved: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl Comment {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "docId": self.doc_id,
            "parentId": self.parent_id,
            "authorId": self.author_id,
            "authorLogin": self.author_login,
            "x": self.x_nm,
            "y": self.y_nm,
            "body": self.body,
            "resolved": self.resolved,
            "createdAt": self.created_at.to_rfc3339(),
        })
    }
}

const COMMENT_COLS: &str = "c.id, c.doc_id, c.parent_id, c.author_id, u.login AS author_login,
                            c.x_nm, c.y_nm, c.body, c.resolved, c.created_at";

pub async fn list_comments(pool: &PgPool, doc_id: Uuid) -> DbResult<Vec<Comment>> {
    sqlx::query_as::<_, Comment>(&format!(
        "SELECT {COMMENT_COLS} FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.doc_id = $1 ORDER BY c.id"
    ))
    .bind(doc_id)
    .fetch_all(pool)
    .await
}

pub async fn insert_comment(
    pool: &PgPool,
    doc_id: Uuid,
    parent_id: Option<i64>,
    author_id: i64,
    x_nm: i64,
    y_nm: i64,
    body: &str,
) -> DbResult<Comment> {
    sqlx::query_as::<_, Comment>(&format!(
        "WITH ins AS (
            INSERT INTO comments (doc_id, parent_id, author_id, x_nm, y_nm, body)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
         )
         SELECT {} FROM ins c JOIN users u ON u.id = c.author_id",
        COMMENT_COLS
    ))
    .bind(doc_id)
    .bind(parent_id)
    .bind(author_id)
    .bind(x_nm)
    .bind(y_nm)
    .bind(body)
    .fetch_one(pool)
    .await
}

pub async fn get_comment(pool: &PgPool, id: i64) -> DbResult<Option<Comment>> {
    sqlx::query_as::<_, Comment>(&format!(
        "SELECT {COMMENT_COLS} FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn set_comment_resolved(pool: &PgPool, id: i64, resolved: bool) -> DbResult<bool> {
    let res = sqlx::query("UPDATE comments SET resolved = $2 WHERE id = $1")
        .bind(id)
        .bind(resolved)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn delete_comment(pool: &PgPool, id: i64) -> DbResult<bool> {
    let res = sqlx::query("DELETE FROM comments WHERE id = $1").bind(id).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

pub async fn insert_snapshot(
    pool: &PgPool,
    doc_id: Uuid,
    seq: i64,
    content: &[u8],
    name: Option<&str>,
    uploader_id: Option<i64>,
) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO snapshots (doc_id, seq, content, name, uploader_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (doc_id, seq) DO UPDATE
           SET content = EXCLUDED.content,
               name = COALESCE(EXCLUDED.name, snapshots.name),
               uploader_id = EXCLUDED.uploader_id",
    )
    .bind(doc_id)
    .bind(seq)
    .bind(content)
    .bind(name)
    .bind(uploader_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Insert-only variant for client-driven snapshot uploads: never overwrites an
/// existing row — a snapshot at some seq, once written, is immutable (named
/// checkpoint rows especially must survive later freshness uploads racing in
/// at a stale seq).  Returns whether a row was written.
pub async fn insert_snapshot_new(
    pool: &PgPool,
    doc_id: Uuid,
    seq: i64,
    content: &[u8],
    uploader_id: Option<i64>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "INSERT INTO snapshots (doc_id, seq, content, name, uploader_id)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (doc_id, seq) DO NOTHING",
    )
    .bind(doc_id)
    .bind(seq)
    .bind(content)
    .bind(uploader_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn latest_snapshot(pool: &PgPool, doc_id: Uuid) -> DbResult<Option<(i64, Vec<u8>)>> {
    let row = sqlx::query(
        "SELECT seq, content FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1",
    )
    .bind(doc_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.get("seq"), r.get("content"))))
}

pub async fn latest_snapshot_seq(pool: &PgPool, doc_id: Uuid) -> DbResult<i64> {
    let row = sqlx::query("SELECT COALESCE(MAX(seq), 0) AS seq FROM snapshots WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_one(pool)
        .await?;
    Ok(row.get("seq"))
}

pub async fn head_seq(pool: &PgPool, doc_id: Uuid) -> DbResult<i64> {
    let row = sqlx::query(
        "SELECT GREATEST(
            COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
            COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)
         ) AS head",
    )
    .bind(doc_id)
    .fetch_one(pool)
    .await?;
    Ok(row.get("head"))
}

/// The lowest op seq still retained, if any ops exist.
pub async fn min_op_seq(pool: &PgPool, doc_id: Uuid) -> DbResult<Option<i64>> {
    let row = sqlx::query("SELECT MIN(seq) AS s FROM ops WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_one(pool)
        .await?;
    Ok(row.get("s"))
}

pub async fn ops_since(pool: &PgPool, doc_id: Uuid, since: i64) -> DbResult<Vec<OpRow>> {
    sqlx::query_as::<_, OpRow>(
        "SELECT seq, author_id, client_id, changes FROM ops
         WHERE doc_id = $1 AND seq > $2 ORDER BY seq",
    )
    .bind(doc_id)
    .bind(since)
    .fetch_all(pool)
    .await
}

/// Insert an op at the given seq. Returns Ok(None) on success; if the
/// (client_id, client_op_id) pair was already used, returns the existing seq
/// (idempotent resubmit after reconnect).
pub async fn insert_op(
    pool: &PgPool,
    doc_id: Uuid,
    seq: i64,
    author_id: i64,
    client_id: &str,
    client_op_id: &str,
    base_seq: Option<i64>,
    changes: &Value,
) -> DbResult<Option<i64>> {
    let res = sqlx::query(
        "INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, base_seq, changes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (doc_id, client_id, client_op_id) DO NOTHING",
    )
    .bind(doc_id)
    .bind(seq)
    .bind(author_id)
    .bind(client_id)
    .bind(client_op_id)
    .bind(base_seq)
    .bind(changes)
    .execute(pool)
    .await?;

    if res.rows_affected() > 0 {
        return Ok(None);
    }

    // Verify the author too: a re-ack for someone else's row would tell this
    // client its op committed when the changes were actually discarded.
    let row = sqlx::query(
        "SELECT seq FROM ops
         WHERE doc_id = $1 AND client_id = $2 AND client_op_id = $3 AND author_id = $4",
    )
    .bind(doc_id)
    .bind(client_id)
    .bind(client_op_id)
    .bind(author_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(row) => Ok(Some(row.get("seq"))),
        None => Err(sqlx::Error::RowNotFound),
    }
}

pub async fn remove_member(pool: &PgPool, project_id: Uuid, user_id: i64) -> DbResult<bool> {
    let res = sqlx::query("DELETE FROM permissions WHERE project_id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Members with a claimed grant (owner is implicit and not listed).
pub async fn list_members(pool: &PgPool, project_id: Uuid) -> DbResult<Vec<(i64, String, String)>> {
    let rows = sqlx::query(
        "SELECT u.id, u.login, p.role FROM permissions p
         JOIN users u ON u.id = p.user_id
         WHERE p.project_id = $1 ORDER BY u.login",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| (r.get("id"), r.get("login"), r.get("role")))
        .collect())
}

/// Name the latest snapshot of a document, making it a permanent checkpoint.
pub async fn name_latest_snapshot(pool: &PgPool, doc_id: Uuid, name: &str) -> DbResult<Option<i64>> {
    let row = sqlx::query(
        "UPDATE snapshots SET name = $2
         WHERE doc_id = $1 AND seq = (SELECT MAX(seq) FROM snapshots WHERE doc_id = $1)
         RETURNING seq",
    )
    .bind(doc_id)
    .bind(name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.get("seq")))
}

/// (doc_id, seq, name, created_at) for every named checkpoint in a project.
pub async fn list_checkpoints(
    pool: &PgPool,
    project_id: Uuid,
) -> DbResult<Vec<(Uuid, String, i64, String, chrono::DateTime<chrono::Utc>)>> {
    let rows = sqlx::query(
        "SELECT s.doc_id, d.path, s.seq, s.name, s.created_at
         FROM snapshots s JOIN documents d ON d.id = s.doc_id
         WHERE d.project_id = $1 AND s.name IS NOT NULL
         ORDER BY s.created_at DESC, d.path",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get("doc_id"),
                r.get("path"),
                r.get("seq"),
                r.get("name"),
                r.get("created_at"),
            )
        })
        .collect())
}

pub async fn snapshot_at(pool: &PgPool, doc_id: Uuid, seq: i64) -> DbResult<Option<Vec<u8>>> {
    let row = sqlx::query("SELECT content FROM snapshots WHERE doc_id = $1 AND seq = $2")
        .bind(doc_id)
        .bind(seq)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get("content")))
}

/// Content of a project's named checkpoint, per document.
pub async fn checkpoint_contents(
    pool: &PgPool,
    project_id: Uuid,
    name: &str,
) -> DbResult<Vec<(Uuid, Vec<u8>)>> {
    let rows = sqlx::query(
        "SELECT s.doc_id, s.content FROM snapshots s
         JOIN documents d ON d.id = s.doc_id
         WHERE d.project_id = $1 AND s.name = $2",
    )
    .bind(project_id)
    .bind(name)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| (r.get("doc_id"), r.get("content"))).collect())
}

/// Prune ops and unnamed snapshots that are safely behind snapshot coverage.
pub async fn prune(pool: &PgPool) -> DbResult<()> {
    sqlx::query(
        "DELETE FROM ops o
         WHERE o.created_at < now() - interval '7 days'
           AND o.seq <= COALESCE((SELECT MAX(s.seq) FROM snapshots s
                                  WHERE s.doc_id = o.doc_id AND s.name IS NULL), 0)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM snapshots s
         WHERE s.name IS NULL
           AND s.created_at < now() - interval '30 days'
           AND s.seq < (SELECT MAX(s2.seq) FROM snapshots s2
                        WHERE s2.doc_id = s.doc_id AND s2.name IS NULL)",
    )
    .execute(pool)
    .await?;
    Ok(())
}
