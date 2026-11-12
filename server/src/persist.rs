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
    /// The author's login (empty when the account is gone).
    pub login: String,
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
            // User already has a row on this project: upgrade role if the invite is higher
            // (unless the owner set that role by hand).
            sqlx::query(
                "UPDATE permissions SET role = $3
                 WHERE project_id = $1 AND user_id = $2 AND NOT role_pinned
                   AND (CASE role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END) < (CASE $3 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END)",
            )
            .bind(project_id)
            .bind(user_id)
            .bind(&role)
            .execute(pool)
            .await?;
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
    pub owner_avatar_url: Option<String>,
    pub description: String,
    pub role: String,
    pub public: bool,
    /// Whether this user may download or copy the project (access.rs).
    pub can_copy: bool,
    pub doc_count: i64,
    pub member_count: i64,
    pub starred: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Every project the user owns or has a claimed grant on, most recently
/// edited first. "Edited" is the newest op or snapshot in any of its docs.
pub async fn list_projects_for_user(pool: &PgPool, user_id: i64) -> DbResult<Vec<ProjectListing>> {
    sqlx::query_as::<_, ProjectListing>(
        "SELECT p.id, p.name, p.owner_id, u.login AS owner_login,
                u.avatar_url AS owner_avatar_url, p.description,
                CASE WHEN p.owner_id = $1 THEN 'editor' ELSE perm.role END AS role,
                p.public,
                (p.owner_id = $1 OR perm.role = 'editor' OR p.viewers_can_copy) AS can_copy,
                (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS doc_count,
                (SELECT COUNT(*) FROM permissions m WHERE m.project_id = p.id AND m.user_id IS NOT NULL AND m.user_id <> p.owner_id) AS member_count,
                EXISTS (SELECT 1 FROM project_stars st
                        WHERE st.project_id = p.id AND st.user_id = $1) AS starred,
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
         WHERE (p.owner_id = $1 OR perm.user_id IS NOT NULL) AND p.deleted_at IS NULL
           AND p.parent_id IS NULL
         ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// Change the per-project permission settings (migration 0110); `None` leaves one as it is.
pub async fn update_project_permissions(
    pool: &PgPool,
    id: Uuid,
    public_role: Option<&str>,
    editors_can_share: Option<bool>,
    viewers_can_copy: Option<bool>,
    links_require_signin: Option<bool>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE projects SET public_role = COALESCE($2, public_role),
                             editors_can_share = COALESCE($3, editors_can_share),
                             viewers_can_copy = COALESCE($4, viewers_can_copy),
                             links_require_signin = COALESCE($5, links_require_signin)
         WHERE id = $1",
    )
    .bind(id)
    .bind(public_role)
    .bind(editors_can_share)
    .bind(viewers_can_copy)
    .bind(links_require_signin)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
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
         WHERE p.public AND p.deleted_at IS NULL AND p.parent_id IS NULL ORDER BY updated_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Delete for good.  Documents, ops, snapshots, permissions and share links all cascade.
pub async fn delete_project(pool: &PgPool, id: Uuid) -> DbResult<bool> {
    let res = sqlx::query("DELETE FROM projects WHERE id = $1").bind(id).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Move a project to the Trash: it vanishes for everyone (get_project and
/// effective_role no longer see it) but nothing is destroyed until prune()
/// purges it 30 days later, so the owner can take the delete back.
pub async fn trash_project(pool: &PgPool, id: Uuid) -> DbResult<bool> {
    let res = sqlx::query("UPDATE projects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn restore_project(pool: &PgPool, id: Uuid, owner_id: i64) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE projects SET deleted_at = NULL
         WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(owner_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Purge one of the caller's trashed projects now instead of waiting for prune().
pub async fn purge_trashed_project(pool: &PgPool, id: Uuid, owner_id: i64) -> DbResult<bool> {
    let res = sqlx::query(
        "DELETE FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(owner_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrashedProject {
    pub id: Uuid,
    pub name: String,
    pub doc_count: i64,
    pub deleted_at: chrono::DateTime<chrono::Utc>,
}

/// The caller's own trashed projects, most recently deleted first.
pub async fn list_trash(pool: &PgPool, owner_id: i64) -> DbResult<Vec<TrashedProject>> {
    sqlx::query_as::<_, TrashedProject>(
        "SELECT p.id, p.name, p.deleted_at,
                (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS doc_count
         FROM projects p
         WHERE p.owner_id = $1 AND p.deleted_at IS NOT NULL AND p.parent_id IS NULL
         ORDER BY p.deleted_at DESC",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await
}

pub async fn set_star(pool: &PgPool, user_id: i64, project_id: Uuid, on: bool) -> DbResult<()> {
    let sql = if on {
        "INSERT INTO project_stars (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
    } else {
        "DELETE FROM project_stars WHERE user_id = $1 AND project_id = $2"
    };
    sqlx::query(sql).bind(user_id).bind(project_id).execute(pool).await?;
    Ok(())
}

/// Hand a project to one of its members: they become the owner and the former
/// owner stays on as an editor.  One transaction, so the project is never
/// ownerless and nobody holds both a grant and the ownership.
pub async fn transfer_ownership(
    pool: &PgPool,
    project_id: Uuid,
    from_owner: i64,
    to_member: i64,
) -> DbResult<bool> {
    let mut tx = pool.begin().await?;
    let removed = sqlx::query("DELETE FROM permissions WHERE project_id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(to_member)
        .execute(&mut *tx)
        .await?;
    if removed.rows_affected() == 0 {
        return Ok(false); // not a member: dropping tx rolls back
    }
    let moved = sqlx::query(
        "UPDATE projects SET owner_id = $3 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(project_id)
    .bind(from_owner)
    .bind(to_member)
    .execute(&mut *tx)
    .await?;
    if moved.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query("UPDATE projects SET owner_id = $2 WHERE parent_id = $1")
        .bind(project_id)
        .bind(to_member)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor')
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'editor'",
    )
    .bind(project_id)
    .bind(from_owner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
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
           SET role = CASE WHEN (CASE permissions.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END) >= (CASE EXCLUDED.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END)
                           THEN permissions.role ELSE EXCLUDED.role END",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

/// Pending (unclaimed) invites on a project: (permission id, login, email, role, invited by).
pub async fn list_pending_invites(
    pool: &PgPool,
    project_id: Uuid,
) -> DbResult<Vec<(i64, Option<String>, Option<String>, String, Option<i64>)>> {
    let rows = sqlx::query(
        "SELECT id, invited_login, invited_email, role, created_by FROM permissions
         WHERE project_id = $1 AND user_id IS NULL
         ORDER BY id",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| (r.get("id"), r.get("invited_login"), r.get("invited_email"), r.get("role"), r.get("created_by")))
        .collect())
}

/// Cancel a pending invite; with `only_by`, only one that user sent.
pub async fn delete_pending_invite(
    pool: &PgPool,
    project_id: Uuid,
    perm_id: i64,
    only_by: Option<i64>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "DELETE FROM permissions WHERE id = $1 AND project_id = $2 AND user_id IS NULL
           AND ($3::bigint IS NULL OR created_by = $3)",
    )
    .bind(perm_id)
    .bind(project_id)
    .bind(only_by)
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
        "SELECT p.id, p.owner_id, p.name, p.public, p.description FROM projects p
         WHERE p.id = $1 AND p.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM projects r WHERE r.id = p.parent_id AND r.deleted_at IS NOT NULL)",
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

/// Remove a document and everything hanging off it (snapshots, ops, comments, previews: ON DELETE CASCADE).
pub async fn delete_document(pool: &PgPool, id: Uuid) -> DbResult<bool> {
    let res = sqlx::query("DELETE FROM documents WHERE id = $1").bind(id).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Move a document to another path inside its project (a footprint renamed or moved to another library).
pub async fn rename_document(pool: &PgPool, id: Uuid, path: &str) -> DbResult<Option<Document>> {
    sqlx::query_as::<_, Document>(
        "UPDATE documents SET path = $2 WHERE id = $1 RETURNING id, project_id, path, doc_type",
    )
    .bind(id)
    .bind(path)
    .fetch_optional(pool)
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

/// Effective role of a signed-in user on a project ("editor", "commenter" or "viewer"):
/// the owner is an editor, a member has the role of their grant, and a public project
/// gives everyone else the role its owner chose for visitors.  See access.rs.
pub async fn effective_role(pool: &PgPool, user_id: i64, project_id: Uuid) -> DbResult<Option<String>> {
    Ok(crate::access::resolve_for(pool, Some(user_id), &[], project_id)
        .await?
        .map(|a| a.role_str().to_string()))
}

pub async fn create_share_link(
    pool: &PgPool,
    token: &str,
    project_id: Uuid,
    role: &str,
    created_by: i64,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    label: Option<&str>,
) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO share_links (token, project_id, role, created_by, expires_at, label)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(token)
    .bind(project_id)
    .bind(role)
    .bind(created_by)
    .bind(expires_at)
    .bind(label)
    .execute(pool)
    .await?;
    Ok(())
}

/// A share link that is neither revoked nor expired.
pub async fn get_valid_share_link(pool: &PgPool, token: &str) -> DbResult<Option<ShareLink>> {
    sqlx::query_as::<_, ShareLink>(
        "SELECT sl.token, sl.project_id, sl.role FROM share_links sl
         JOIN projects p ON p.id = sl.project_id AND p.deleted_at IS NULL
         WHERE sl.token = $1 AND sl.revoked_at IS NULL
           AND (sl.expires_at IS NULL OR sl.expires_at > now())",
    )
    .bind(token)
    .fetch_optional(pool)
    .await
}

/// Turn a link off: its project's owner can, and so can whoever made it.
pub async fn revoke_share_link(pool: &PgPool, token: &str, by_user: i64) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE share_links l SET revoked_at = now()
         FROM projects p
         WHERE l.token = $1 AND l.project_id = p.id AND (p.owner_id = $2 OR l.created_by = $2)
           AND l.revoked_at IS NULL",
    )
    .bind(token)
    .bind(by_user)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Claim a share link: grant its role, never downgrading an existing one and never
/// overriding a role the owner set by hand.
pub async fn claim_share_link(pool: &PgPool, user_id: i64, link: &ShareLink) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO permissions (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
           SET role = CASE WHEN permissions.role_pinned
                             OR (CASE permissions.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END) >= (CASE EXCLUDED.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END)
                           THEN permissions.role ELSE EXCLUDED.role END",
    )
    .bind(link.project_id)
    .bind(user_id)
    .bind(&link.role)
    .execute(pool)
    .await?;
    sqlx::query("UPDATE share_links SET uses = uses + 1, last_used_at = now() WHERE token = $1")
        .bind(&link.token)
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
    /// What the thread is pinned to (root comments only): 'item' or 'net'.
    pub anchor_kind: Option<String>,
    /// The item's uuid, or the net's name.
    pub anchor_id: Option<String>,
    pub anchor_label: Option<String>,
    /// For a net: the item the thread was started on.
    pub anchor_item: Option<String>,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// What a new thread is pinned to.
#[derive(Debug, Clone, Default)]
pub struct CommentAnchor {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub item: Option<String>,
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
            "editedAt": self.edited_at.map(|t| t.to_rfc3339()),
            "anchor": self.anchor_kind.as_ref().map(|kind| serde_json::json!({
                "kind": kind,
                "id": self.anchor_id,
                "label": self.anchor_label,
                "item": self.anchor_item,
            })),
        })
    }
}

const COMMENT_COLS: &str = "c.id, c.doc_id, c.parent_id, c.author_id, u.login AS author_login,
                            c.x_nm, c.y_nm, c.body, c.resolved, c.created_at,
                            c.anchor_kind, c.anchor_id, c.anchor_label, c.anchor_item, c.edited_at";

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
    anchor: Option<&CommentAnchor>,
) -> DbResult<Comment> {
    sqlx::query_as::<_, Comment>(&format!(
        "WITH ins AS (
            INSERT INTO comments (doc_id, parent_id, author_id, x_nm, y_nm, body,
                                  anchor_kind, anchor_id, anchor_label, anchor_item)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
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
    .bind(anchor.map(|a| a.kind.as_str()))
    .bind(anchor.map(|a| a.id.as_str()))
    .bind(anchor.map(|a| a.label.as_str()))
    .bind(anchor.and_then(|a| a.item.as_deref()))
    .fetch_one(pool)
    .await
}

/// Every comment of every document in a project, oldest first.
pub async fn list_project_comments(pool: &PgPool, project_id: Uuid) -> DbResult<Vec<Comment>> {
    sqlx::query_as::<_, Comment>(&format!(
        "SELECT {COMMENT_COLS} FROM comments c JOIN users u ON u.id = c.author_id
         JOIN documents d ON d.id = c.doc_id
         WHERE d.project_id = $1 ORDER BY c.id"
    ))
    .bind(project_id)
    .fetch_all(pool)
    .await
}

/// Rewrite a comment's text (its author only; the caller checks).
pub async fn update_comment_body(pool: &PgPool, id: i64, body: &str) -> DbResult<bool> {
    let res = sqlx::query("UPDATE comments SET body = $2, edited_at = now() WHERE id = $1")
        .bind(id)
        .bind(body)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Move a thread's pin: the position, and what it is pinned to (None unpins it).
pub async fn set_comment_anchor(
    pool: &PgPool,
    id: i64,
    x_nm: i64,
    y_nm: i64,
    anchor: Option<&CommentAnchor>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE comments SET x_nm = $2, y_nm = $3, anchor_kind = $4, anchor_id = $5,
                             anchor_label = $6, anchor_item = $7
         WHERE id = $1",
    )
    .bind(id)
    .bind(x_nm)
    .bind(y_nm)
    .bind(anchor.map(|a| a.kind.as_str()))
    .bind(anchor.map(|a| a.id.as_str()))
    .bind(anchor.map(|a| a.label.as_str()))
    .bind(anchor.and_then(|a| a.item.as_deref()))
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
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

/// Upsert the latest client-rendered preview for one (doc, variant).
pub async fn upsert_preview(
    pool: &PgPool,
    doc_id: Uuid,
    fit: bool,
    seq: i64,
    svg: &[u8],
) -> DbResult<()> {
    sqlx::query(
        "INSERT INTO doc_previews (doc_id, fit, seq, svg) VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id, fit) DO UPDATE
           SET seq = EXCLUDED.seq, svg = EXCLUDED.svg, created_at = now()
         WHERE doc_previews.seq <= EXCLUDED.seq",
    )
    .bind(doc_id)
    .bind(fit)
    .bind(seq)
    .bind(svg)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_preview(pool: &PgPool, doc_id: Uuid, fit: bool) -> DbResult<Option<(i64, Vec<u8>)>> {
    let row = sqlx::query("SELECT seq, svg FROM doc_previews WHERE doc_id = $1 AND fit = $2")
        .bind(doc_id)
        .bind(fit)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| (r.get("seq"), r.get("svg"))))
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
        "SELECT o.seq, o.author_id, o.client_id, o.changes, COALESCE(u.login, '') AS login
         FROM ops o LEFT JOIN users u ON u.id = o.author_id
         WHERE o.doc_id = $1 AND o.seq > $2 ORDER BY o.seq",
    )
    .bind(doc_id)
    .bind(since)
    .fetch_all(pool)
    .await
}

/// True when an op insert failed because another writer already holds that seq: with
/// several replicas the `(doc_id, seq)` primary key is what puts their ops in one order.
pub fn is_seq_taken(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|d| d.is_unique_violation() && d.constraint() == Some("ops_pkey"))
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
    let mut conn = pool.acquire().await?;
    insert_op_on(&mut conn, doc_id, seq, author_id, client_id, client_op_id, base_seq, changes).await
}

/// Take the document's sequencing lock for the length of a transaction and read the
/// newest seq in the op table.
///
/// With one replica the document's actor is the only writer and needs no lock.  With
/// several, each replica's actor would otherwise race for the next seq, and under a
/// burst the same one can lose every time; the lock queues them in arrival order, so
/// whoever holds it knows the head it read is the head it will write after.
pub async fn lock_sequence(pool: &PgPool, doc_id: Uuid) -> DbResult<(sqlx::Transaction<'static, sqlx::Postgres>, i64)> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;
    let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM ops WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_one(&mut *tx)
        .await?;
    Ok((tx, head))
}

/// [`insert_op`] on a connection the caller holds (inside [`lock_sequence`]'s transaction).
pub async fn insert_op_on(
    conn: &mut sqlx::PgConnection,
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
    .execute(&mut *conn)
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
    .fetch_optional(&mut *conn)
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

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Member {
    pub id: i64,
    pub login: String,
    pub avatar_url: Option<String>,
    pub role: String,
}

/// Members with a claimed grant (owner is implicit and not listed).
pub async fn list_members(pool: &PgPool, project_id: Uuid) -> DbResult<Vec<Member>> {
    sqlx::query_as::<_, Member>(
        "SELECT u.id, u.login, u.avatar_url, p.role FROM permissions p
         JOIN users u ON u.id = p.user_id
         WHERE p.project_id = $1
           AND p.user_id <> (SELECT owner_id FROM projects WHERE id = $1)
         ORDER BY u.login",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

/// Set a member's role exactly (unlike grant_role, this can downgrade).
pub async fn set_member_role(
    pool: &PgPool,
    project_id: Uuid,
    user_id: i64,
    role: &str,
) -> DbResult<bool> {
    let res = sqlx::query(
        // role_pinned: the owner chose this role, so a share link no longer raises it.
        "UPDATE permissions SET role = $3, role_pinned = true
         WHERE project_id = $1 AND user_id = $2
           AND user_id <> (SELECT owner_id FROM projects WHERE id = $1)",
    )
        .bind(project_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Change the role a pending invite will grant once it is claimed.
pub async fn set_invite_role(
    pool: &PgPool,
    project_id: Uuid,
    perm_id: i64,
    role: &str,
    only_by: Option<i64>,
) -> DbResult<bool> {
    let res = sqlx::query(
        "UPDATE permissions SET role = $3 WHERE id = $1 AND project_id = $2 AND user_id IS NULL
           AND ($4::bigint IS NULL OR created_by = $4)",
    )
    .bind(perm_id)
    .bind(project_id)
    .bind(role)
    .bind(only_by)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActiveLink {
    pub token: String,
    pub role: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub label: Option<String>,
    pub uses: i64,
    pub created_by: i64,
    pub created_by_login: String,
}

/// Share links of a project that still work (neither revoked nor expired), newest first.
pub async fn list_share_links(pool: &PgPool, project_id: Uuid) -> DbResult<Vec<ActiveLink>> {
    sqlx::query_as::<_, ActiveLink>(
        "SELECT l.token, l.role, l.created_at, l.expires_at, l.label, l.uses, l.created_by,
                u.login AS created_by_login
         FROM share_links l JOIN users u ON u.id = l.created_by
         WHERE l.project_id = $1 AND l.revoked_at IS NULL
           AND (l.expires_at IS NULL OR l.expires_at > now())
         ORDER BY l.created_at DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
}

pub async fn snapshot_at(pool: &PgPool, doc_id: Uuid, seq: i64) -> DbResult<Option<Vec<u8>>> {
    let row = sqlx::query("SELECT content FROM snapshots WHERE doc_id = $1 AND seq = $2")
        .bind(doc_id)
        .bind(seq)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get("content")))
}

/// Prune ops and unnamed snapshots that are safely behind snapshot coverage.
///
/// The full history (every op) is kept for 30 days so the timeline can be scrubbed
/// edit by edit; after that only what a kept version or a branch still needs stays.
pub async fn prune(pool: &PgPool) -> DbResult<()> {
    // Projects that sat in the Trash for 30 days are gone for good.
    sqlx::query("DELETE FROM projects WHERE deleted_at < now() - interval '30 days'")
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM ops o
         WHERE o.created_at < now() - interval '30 days'
           AND o.seq <= COALESCE((SELECT MAX(s.seq) FROM snapshots s
                                  WHERE s.doc_id = o.doc_id AND s.name IS NULL), 0)
           -- a kept version is its snapshot plus these ops
           AND NOT EXISTS (SELECT 1 FROM version_docs v
                           WHERE v.doc_id = o.doc_id AND o.seq > v.snap_seq AND o.seq <= v.seq)
           -- a branch is merged by replaying what either side did since they last met
           AND NOT EXISTS (SELECT 1 FROM branch_docs b
                           WHERE (b.doc_id = o.doc_id AND o.seq > LEAST(b.merged_seq, b.fork_seq))
                              OR (b.parent_doc_id = o.doc_id AND o.seq > LEAST(b.synced_seq, b.fork_seq)))",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM snapshots s
         WHERE s.name IS NULL
           AND s.created_at < now() - interval '30 days'
           AND s.seq < (SELECT MAX(s2.seq) FROM snapshots s2
                        WHERE s2.doc_id = s.doc_id AND s2.name IS NULL)
           AND NOT EXISTS (SELECT 1 FROM version_docs v
                           WHERE v.doc_id = s.doc_id AND v.snap_seq = s.seq)
           -- ops that are still kept need the snapshot they sit on
           AND NOT EXISTS (SELECT 1 FROM ops o WHERE o.doc_id = s.doc_id AND o.seq = s.seq + 1)
           -- a branch remembers where it started
           AND NOT EXISTS (SELECT 1 FROM branch_docs b
                           WHERE b.doc_id = s.doc_id AND s.seq <= b.fork_seq)",
    )
    .execute(pool)
    .await?;
    Ok(())
}


/// Doc ids (among `doc_ids`) that have at least one rendered preview.
pub async fn docs_with_previews(pool: &PgPool, doc_ids: &[Uuid]) -> DbResult<Vec<Uuid>> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT doc_id FROM doc_previews WHERE doc_id = ANY($1)",
    )
    .bind(doc_ids)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
