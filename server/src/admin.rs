//! The administrators' dashboard: `/admin` (the page) and `/api/admin/stats` (its numbers).
//!
//! Only the logins listed in `KC_ADMINS` get in (the same check as the plugin moderation and
//! the GitHub App registration, `plugins::is_admin`); everybody else gets a 403.  Every number
//! is read from the database on request, so it is the same on every replica, except "documents
//! open here", which is this replica's own count of live document actors.

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::auth::{self, AuthUser};
use crate::error::{AppError, AppResult};
use crate::pages::{esc, MARK, THEME_CSS};
use crate::AppState;

/// Days covered by the daily series on the page.
const DAYS: i32 = 90;

/// GET /admin
pub async fn page(State(state): State<AppState>, headers: HeaderMap, jar: CookieJar) -> Response {
    let Some(user) = auth::user_from_jar(&state, &jar).await else {
        return Redirect::to("/auth/github/login?next=/admin").into_response();
    };
    if !crate::plugins::is_admin(&user.login) {
        let origin = crate::oauth::origin_of(&state, &headers);
        return (
            StatusCode::FORBIDDEN,
            crate::oauth::page(
                "Admin",
                origin.split("://").nth(1).unwrap_or(&origin),
                &format!(
                    r#"<div class="body"><h1>Administrators only</h1><p>You are signed in as <b>{}</b>, which is not one of this server's administrators.</p></div>
<div class="actions"><a class="btn" href="/">Close</a></div>"#,
                    esc(&user.login)
                ),
            ),
        )
            .into_response();
    }
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let page = PAGE.get_or_init(|| include_str!("../static/admin.html").replace("{{THEME}}", THEME_CSS).replace("{{MARK}}", MARK));
    ([(header::CACHE_CONTROL, "no-store")], Html(page.clone())).into_response()
}

/// GET /static/dist/admin.js
pub async fn js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")],
        include_str!("../static/dist/admin.js"),
    )
        .into_response()
}

/// GET /api/admin/stats
pub async fn stats(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Response> {
    if !crate::plugins::is_admin(&user.login) {
        return Err(AppError::Api(StatusCode::FORBIDDEN, "not_admin", "only this server's administrators can see its statistics".into()));
    }
    let pool = &state.pool;
    let open_docs = state.registry.all().len();
    let body = json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "days": DAYS,
        "users": users(pool).await?,
        "activity": activity(pool, open_docs).await?,
        "projects": projects(pool).await?,
        "collaboration": collaboration(pool).await?,
        "ai": ai(pool).await?,
        "integrations": integrations(pool).await?,
        "storage": storage(pool).await?,
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

/// Run a query of single bigint columns and hand back the row as JSON numbers under `names`.
async fn counts(pool: &PgPool, sql: &str, names: &[&str]) -> AppResult<Value> {
    use sqlx::Row;
    let row = sqlx::query(sql).fetch_one(pool).await?;
    let mut out = serde_json::Map::new();
    for (i, n) in names.iter().enumerate() {
        let v: Option<i64> = row.try_get(i)?;
        out.insert((*n).to_string(), json!(v.unwrap_or(0)));
    }
    Ok(Value::Object(out))
}

/// A per-day series over the last `DAYS` days, oldest first: `inner` selects `(day date, n bigint)`.
async fn series(pool: &PgPool, inner: &str) -> AppResult<Vec<Value>> {
    let sql = format!(
        "WITH s AS ({inner})
         SELECT to_char(g.d, 'YYYY-MM-DD'), COALESCE(s.n, 0)::bigint
         FROM generate_series((now() AT TIME ZONE 'UTC')::date - ($1::int - 1), (now() AT TIME ZONE 'UTC')::date, '1 day') AS g(d)
         LEFT JOIN s ON s.day = g.d::date
         ORDER BY g.d"
    );
    let rows: Vec<(String, i64)> = sqlx::query_as(&sql).bind(DAYS).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(d, n)| json!([d, n])).collect())
}

const SINCE: &str = "now() - make_interval(days => 90)";

/// Who did anything, when: an edit, a heartbeat from an editor, an AI or MCP request.
const ACTORS: &str = "
    SELECT author_id AS user_id, created_at AS at FROM ops WHERE created_at > now() - interval '90 days'
    UNION ALL SELECT user_id, at FROM activity_beats WHERE at > now() - interval '90 days'
    UNION ALL SELECT user_id, created_at FROM mcp_changes WHERE created_at > now() - interval '90 days'
    UNION ALL SELECT user_id, day::timestamptz FROM ai_usage WHERE day > (now() - interval '90 days')::date";

async fn users(pool: &PgPool) -> AppResult<Value> {
    let mut v = counts(
        pool,
        "SELECT count(*),
                count(*) FILTER (WHERE created_at > now() - interval '1 day'),
                count(*) FILTER (WHERE created_at > now() - interval '7 days'),
                count(*) FILTER (WHERE created_at > now() - interval '30 days'),
                count(*) FILTER (WHERE email IS NOT NULL AND email <> '')
         FROM users",
        &["total", "new1d", "new7d", "new30d", "withEmail"],
    )
    .await?;
    let base: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM users WHERE created_at <= {SINCE}")).fetch_one(pool).await?;
    v["before"] = json!(base);
    v["signups"] = json!(series(pool, "SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n FROM users GROUP BY 1").await?);
    let recent: Vec<(String, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT login, name, avatar_url, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT 8").fetch_all(pool).await?;
    v["recent"] = json!(recent
        .into_iter()
        .map(|(login, name, avatar, at)| json!({ "login": login, "name": name, "avatarUrl": avatar, "at": at.to_rfc3339() }))
        .collect::<Vec<_>>());
    Ok(v)
}

async fn activity(pool: &PgPool, open_docs: usize) -> AppResult<Value> {
    let mut v = counts(
        pool,
        &format!(
            "WITH a AS ({ACTORS})
             SELECT count(DISTINCT user_id) FILTER (WHERE at > now() - interval '1 day'),
                    count(DISTINCT user_id) FILTER (WHERE at > now() - interval '7 days'),
                    count(DISTINCT user_id) FILTER (WHERE at > now() - interval '30 days'),
                    (SELECT count(DISTINCT user_id) FROM activity_beats WHERE at > now() - interval '5 minutes'),
                    (SELECT count(DISTINCT project_id) FROM activity_beats WHERE at > now() - interval '5 minutes')
             FROM a"
        ),
        &["dau", "wau", "mau", "liveUsers", "liveProjects"],
    )
    .await?;
    v["openDocsHere"] = json!(open_docs);
    v["daily"] = json!(series(pool, &format!("SELECT (at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT user_id) AS n FROM ({ACTORS}) a GROUP BY 1")).await?);
    // Time spent, WakaTime's rule: gaps under 15 minutes between one person's heartbeats.
    let hours: Option<f64> = sqlx::query_scalar(
        "WITH b AS (SELECT at, at - lag(at) OVER (PARTITION BY user_id ORDER BY at) AS gap
                    FROM activity_beats WHERE at > now() - interval '30 days')
         SELECT (sum(EXTRACT(EPOCH FROM gap)) FILTER (WHERE gap < interval '15 minutes') / 3600)::float8 FROM b",
    )
    .fetch_one(pool)
    .await?;
    v["hours30d"] = json!(hours.unwrap_or(0.0));
    let clients: Vec<(String, i64)> = sqlx::query_as(
        "SELECT client, count(DISTINCT user_id) FROM activity_beats WHERE at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 6",
    )
    .fetch_all(pool)
    .await?;
    v["clients30d"] = json!(clients.into_iter().map(|(c, n)| json!([c, n])).collect::<Vec<_>>());
    let top: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT u.login, u.avatar_url, count(*), count(DISTINCT d.project_id)
         FROM ops o JOIN users u ON u.id = o.author_id JOIN documents d ON d.id = o.doc_id
         WHERE o.created_at > now() - interval '30 days'
         GROUP BY u.id ORDER BY 3 DESC LIMIT 8",
    )
    .fetch_all(pool)
    .await?;
    v["topEditors30d"] = json!(top
        .into_iter()
        .map(|(login, avatar, edits, projects)| json!({ "login": login, "avatarUrl": avatar, "edits": edits, "projects": projects }))
        .collect::<Vec<_>>());
    Ok(v)
}

async fn projects(pool: &PgPool) -> AppResult<Value> {
    let mut v = counts(
        pool,
        "SELECT count(*) FILTER (WHERE parent_id IS NULL AND deleted_at IS NULL),
                count(*) FILTER (WHERE parent_id IS NULL AND deleted_at IS NULL AND public),
                count(*) FILTER (WHERE parent_id IS NULL AND deleted_at IS NULL AND NOT public),
                count(*) FILTER (WHERE parent_id IS NULL AND deleted_at IS NOT NULL),
                count(*) FILTER (WHERE parent_id IS NOT NULL AND deleted_at IS NULL),
                count(*) FILTER (WHERE parent_id IS NULL AND deleted_at IS NULL AND created_at > now() - interval '30 days'),
                count(DISTINCT owner_id) FILTER (WHERE parent_id IS NULL AND deleted_at IS NULL)
         FROM projects",
        &["total", "public", "private", "trashed", "branches", "new30d", "owners"],
    )
    .await?;
    v["created"] = json!(series(pool, "SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n FROM projects WHERE parent_id IS NULL GROUP BY 1").await?);
    let docs: Vec<(String, i64)> = sqlx::query_as(
        "SELECT d.doc_type, count(*) FROM documents d JOIN projects p ON p.id = d.project_id
         WHERE p.parent_id IS NULL AND p.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC",
    )
    .fetch_all(pool)
    .await?;
    v["documents"] = json!(docs.into_iter().map(|(t, n)| json!([t, n])).collect::<Vec<_>>());
    Ok(v)
}

async fn collaboration(pool: &PgPool) -> AppResult<Value> {
    let mut v = counts(
        pool,
        "SELECT
           (SELECT count(*) FROM ops WHERE created_at > now() - interval '30 days'),
           (SELECT count(*) FROM (SELECT d.project_id FROM ops o JOIN documents d ON d.id = o.doc_id
                                  WHERE o.created_at > now() - interval '30 days'
                                  GROUP BY 1 HAVING count(DISTINCT o.author_id) > 1) m),
           (SELECT count(DISTINCT p.project_id) FROM permissions p JOIN projects pr ON pr.id = p.project_id
              WHERE pr.deleted_at IS NULL AND p.user_id IS NOT NULL AND p.user_id <> pr.owner_id),
           (SELECT count(*) FROM permissions WHERE user_id IS NULL),
           (SELECT count(*) FROM share_links WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())),
           (SELECT count(*) FROM comments WHERE parent_id IS NULL),
           (SELECT count(*) FROM comments WHERE parent_id IS NULL AND NOT resolved),
           (SELECT count(*) FROM comments WHERE created_at > now() - interval '30 days'),
           (SELECT count(*) FROM versions WHERE kind = 'named'),
           (SELECT count(*) FROM versions WHERE kind = 'named' AND created_at > now() - interval '30 days')",
        &["edits30d", "multiplayerProjects30d", "sharedProjects", "pendingInvites", "activeLinks",
          "threads", "openThreads", "comments30d", "versions", "versions30d"],
    )
    .await?;
    v["edits"] = json!(series(pool, "SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n FROM ops WHERE created_at > now() - interval '91 days' GROUP BY 1").await?);
    Ok(v)
}

async fn ai(pool: &PgPool) -> AppResult<Value> {
    let mut v = counts(
        pool,
        "SELECT
           (SELECT sum(requests)::bigint FROM ai_usage WHERE day > (now() - interval '30 days')::date),
           (SELECT sum(input_tokens)::bigint FROM ai_usage WHERE day > (now() - interval '30 days')::date),
           (SELECT sum(output_tokens)::bigint FROM ai_usage WHERE day > (now() - interval '30 days')::date),
           (SELECT count(DISTINCT user_id) FROM ai_usage WHERE day > (now() - interval '30 days')::date),
           (SELECT count(*) FROM ai_keys),
           (SELECT count(DISTINCT user_id) FROM mcp_grants),
           (SELECT count(*) FROM mcp_grants WHERE last_used_at > now() - interval '30 days'),
           (SELECT count(*) FROM mcp_changes WHERE created_at > now() - interval '30 days'),
           (SELECT count(*) FROM mcp_changes WHERE created_at > now() - interval '30 days' AND undone_at IS NOT NULL)",
        &["requests30d", "inputTokens30d", "outputTokens30d", "users30d", "ownKeys",
          "mcpUsers", "mcpGrantsUsed30d", "mcpChanges30d", "mcpUndone30d"],
    )
    .await?;
    v["requests"] = json!(series(pool, "SELECT day, sum(requests)::bigint AS n FROM ai_usage GROUP BY 1").await?);
    let clients: Vec<(String, i64)> = sqlx::query_as(
        "SELECT COALESCE(NULLIF(c.name, ''), 'Unnamed app'), count(DISTINCT g.user_id)
         FROM mcp_grants g JOIN mcp_clients c ON c.client_id = g.client_id GROUP BY 1 ORDER BY 2 DESC LIMIT 6",
    )
    .fetch_all(pool)
    .await?;
    v["mcpClients"] = json!(clients.into_iter().map(|(c, n)| json!([c, n])).collect::<Vec<_>>());
    Ok(v)
}

async fn integrations(pool: &PgPool) -> AppResult<Value> {
    counts(
        pool,
        "SELECT
           (SELECT count(*) FROM project_github g JOIN projects p ON p.id = g.project_id WHERE p.deleted_at IS NULL),
           (SELECT count(DISTINCT user_id) FROM github_tokens),
           (SELECT count(DISTINCT user_id) FROM github_tokens WHERE kind = 'app'),
           (SELECT count(*) FROM plugin_registry),
           (SELECT count(*) FROM plugin_reports WHERE resolved_at IS NULL),
           (SELECT count(*) FROM wakatime_settings WHERE enabled AND api_key IS NOT NULL)",
        &["githubProjects", "githubUsers", "githubAppUsers", "registryPlugins", "openPluginReports", "wakatimeUsers"],
    )
    .await
}

async fn storage(pool: &PgPool) -> AppResult<Value> {
    let db: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())").fetch_one(pool).await?;
    let tables: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT relname::text, pg_total_relation_size(relid), n_live_tup::bigint
         FROM pg_stat_user_tables
         WHERE schemaname = 'public' AND relname <> '_sqlx_migrations'
         ORDER BY 2 DESC LIMIT 10",
    )
    .fetch_all(pool)
    .await?;
    let snaps = counts(pool, "SELECT count(*), count(DISTINCT doc_id) FROM snapshots", &["snapshots", "documents"]).await?;
    Ok(json!({
        "databaseBytes": db,
        "tables": tables.into_iter().map(|(t, b, rows)| json!({ "name": t, "bytes": b, "rows": rows })).collect::<Vec<_>>(),
        "snapshots": snaps["snapshots"],
        "snapshotDocs": snaps["documents"],
    }))
}
