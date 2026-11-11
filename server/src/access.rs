//! Who may do what on a project.
//!
//! Roles are ordered: viewer < commenter < editor.  The owner is an editor who
//! also manages access.  Someone can hold a role three ways: as the owner or a
//! member (a `permissions` row), as a visitor of a public project, or by having
//! opened a share link in this browser (the `kc_links` cookie).  The last two
//! never give more than reading to someone who is not signed in, and a link
//! that was only opened (not joined) never gives more than reading at all.
//!
//! Every handler that shows or changes project data asks here, so the web
//! editor, the desktop clients (same HTTP and WebSocket endpoints) and the MCP
//! endpoint all get the same answer.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::persist::User;
use crate::AppState;

/// Share links opened in this browser: tokens joined with '.', newest first.
pub const LINKS_COOKIE: &str = "kc_links";
const MAX_LINK_TOKENS: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Commenter,
    Editor,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "commenter" => Some(Role::Commenter),
            "editor" => Some(Role::Editor),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Commenter => "commenter",
            Role::Editor => "editor",
        }
    }

    /// A role from a request body, or the 400 that names the choices.
    pub fn checked(s: &str) -> AppResult<Role> {
        Role::parse(s)
            .ok_or_else(|| AppError::BadRequest("role must be editor, commenter or viewer".into()))
    }
}

/// The per-project permission settings (migration 0110).
#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub public: bool,
    pub public_role: Role,
    pub editors_can_share: bool,
    pub viewers_can_copy: bool,
    pub links_require_signin: bool,
}

impl Settings {
    pub fn to_json(self) -> Value {
        json!({
            "public": self.public,
            "publicRole": self.public_role.as_str(),
            "editorsCanShare": self.editors_can_share,
            "viewersCanCopy": self.viewers_can_copy,
            "linksRequireSignin": self.links_require_signin,
        })
    }
}

/// What one person may do on one project.
#[derive(Debug, Clone, Copy)]
pub struct Access {
    pub role: Role,
    pub owner: bool,
    /// Owner or holder of a grant: in the project, not just looking at it.
    pub member: bool,
    pub signed_in: bool,
    /// The role of the best share link this browser opened, when the person is not a
    /// member: what joining through it would give them.
    pub link_role: Option<Role>,
    pub settings: Settings,
}

impl Access {
    pub fn can_comment(&self) -> bool {
        self.signed_in && self.role >= Role::Commenter
    }

    pub fn can_edit(&self) -> bool {
        self.signed_in && self.role == Role::Editor
    }

    /// Download the files or make a copy of the project.
    pub fn can_copy(&self) -> bool {
        self.can_edit() || self.settings.viewers_can_copy
    }

    /// Invite people and make share links.
    pub fn can_share(&self) -> bool {
        self.owner || (self.member && self.can_edit() && self.settings.editors_can_share)
    }

    pub fn can_manage(&self) -> bool {
        self.owner
    }

    /// The role as clients know it.
    pub fn role_str(&self) -> &'static str {
        self.role.as_str()
    }

    /// `can` in the project info: what the interface should offer.
    pub fn can_json(&self) -> Value {
        json!({
            "edit": self.can_edit(), "comment": self.can_comment(), "copy": self.can_copy(),
            "share": self.can_share(), "manage": self.can_manage(),
            // Signed in and looking through a link: "Join as …" is on offer.
            "join": if self.signed_in && !self.member { self.link_role.map(Role::as_str) } else { None },
        })
    }
}

/// Whoever is asking: the signed-in user, if any, and the share links their
/// browser has opened.
#[derive(Debug, Clone, Default)]
pub struct Viewer {
    pub user: Option<User>,
    pub links: Vec<String>,
}

impl Viewer {
    pub fn user(user: &User) -> Viewer {
        Viewer { user: Some(user.clone()), links: Vec::new() }
    }

    /// From a cookie jar: the pages and the endpoints only a browser calls.
    pub async fn from_jar(state: &AppState, jar: &axum_extra::extract::CookieJar) -> Viewer {
        Viewer {
            user: crate::auth::user_from_jar(state, jar).await,
            links: jar.get(LINKS_COOKIE).map(|c| parse_links(c.value())).unwrap_or_default(),
        }
    }

    pub fn user_id(&self) -> Option<i64> {
        self.user.as_ref().map(|u| u.id)
    }
}

/// The tokens in a `kc_links` cookie value.
pub fn parse_links(raw: &str) -> Vec<String> {
    raw.split('.')
        .filter(|t| (16..=64).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .take(MAX_LINK_TOKENS)
        .map(str::to_string)
        .collect()
}

/// The links in a Cookie header.
pub fn links_from_headers(headers: &axum::http::HeaderMap) -> Vec<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|raw| raw.split(';'))
        .map(str::trim)
        .find_map(|kv| kv.strip_prefix(LINKS_COOKIE).and_then(|v| v.strip_prefix('=')))
        .map(parse_links)
        .unwrap_or_default()
}

/// The cookie that remembers `token` along with the links already there.
pub fn links_cookie(existing: &[String], token: &str, secure: bool) -> Cookie<'static> {
    let mut tokens = vec![token.to_string()];
    tokens.extend(existing.iter().filter(|t| t.as_str() != token).cloned());
    tokens.truncate(MAX_LINK_TOKENS);
    Cookie::build((LINKS_COOKIE, tokens.join(".")))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(30))
        .build()
}

impl FromRequestParts<AppState> for Viewer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let crate::auth::MaybeAuthUser(user) =
            crate::auth::MaybeAuthUser::from_request_parts(parts, state).await?;
        Ok(Viewer { user, links: links_from_headers(&parts.headers) })
    }
}

/// What `viewer` may do on the project; `None` when they may not even see it
/// (or it is gone or in the Trash).
pub async fn resolve(pool: &PgPool, viewer: &Viewer, project_id: Uuid) -> AppResult<Option<Access>> {
    Ok(resolve_for(pool, viewer.user_id(), &viewer.links, project_id).await?)
}

/// `resolve` for a bare user id (and the links their browser opened, if known).
pub async fn resolve_for(
    pool: &PgPool,
    user_id: Option<i64>,
    links: &[String],
    project_id: Uuid,
) -> Result<Option<Access>, sqlx::Error> {
    let row = sqlx::query(
        // A branch (versions.rs) has no access list of its own: it answers with its
        // parent's owner, members, links and settings.
        "SELECT r.id AS root_id, r.owner_id, r.public, r.public_role, r.editors_can_share,
                r.viewers_can_copy, r.links_require_signin, perm.role AS member_role
         FROM projects p
         JOIN projects r ON r.id = COALESCE(p.parent_id, p.id)
         LEFT JOIN permissions perm ON perm.project_id = r.id AND perm.user_id = $1
         WHERE p.id = $2 AND p.deleted_at IS NULL AND r.deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else { return Ok(None) };

    let settings = Settings {
        public: row.get("public"),
        public_role: Role::parse(row.get::<String, _>("public_role").as_str()).unwrap_or(Role::Viewer),
        editors_can_share: row.get("editors_can_share"),
        viewers_can_copy: row.get("viewers_can_copy"),
        links_require_signin: row.get("links_require_signin"),
    };
    let signed_in = user_id.is_some();
    let owner = user_id == Some(row.get::<i64, _>("owner_id"));
    let member_role = row.get::<Option<String>, _>("member_role").and_then(|r| Role::parse(&r));

    let mut role = if owner { Some(Role::Editor) } else { member_role };
    let member = role.is_some();

    if settings.public {
        let visitor = if signed_in { settings.public_role } else { Role::Viewer };
        role = role.max(Some(visitor));
    }

    // A link that was opened but not joined: reading, unless the project wants a sign-in
    // first (then the link has to be joined, which makes its holder a member).
    let mut link_role = None;
    if !member && !links.is_empty() && !(settings.links_require_signin && !signed_in) {
        link_role = best_opened_link(pool, links, row.get("root_id")).await?.and_then(|l| Role::parse(&l.role));
        if link_role.is_some() {
            role = role.max(Some(Role::Viewer));
        }
    }

    Ok(role.map(|role| Access { role, owner, member, signed_in, link_role, settings }))
}

/// The share link with the most rights among those this browser opened for the project.
pub async fn best_opened_link(
    pool: &PgPool,
    links: &[String],
    project_id: Uuid,
) -> Result<Option<crate::persist::ShareLink>, sqlx::Error> {
    if links.is_empty() {
        return Ok(None);
    }
    sqlx::query_as::<_, crate::persist::ShareLink>(
        "SELECT token, project_id, role FROM share_links
         WHERE project_id = $1 AND token = ANY($2) AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY CASE role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END DESC
         LIMIT 1",
    )
    .bind(project_id)
    .bind(links)
    .fetch_optional(pool)
    .await
}

/// `resolve`, or the refusal a handler answers with: 404 for someone who may not
/// know the project exists, the same as for one that does not.
pub async fn require(pool: &PgPool, viewer: &Viewer, project_id: Uuid) -> AppResult<Access> {
    resolve(pool, viewer, project_id).await?.ok_or(if viewer.user.is_some() {
        AppError::Forbidden
    } else {
        AppError::NotFound
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_ordered() {
        assert!(Role::Viewer < Role::Commenter && Role::Commenter < Role::Editor);
        assert_eq!(Some(Role::Viewer).max(None), Some(Role::Viewer));
        for r in [Role::Viewer, Role::Commenter, Role::Editor] {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        assert!(Role::parse("owner").is_none());
    }

    fn access(role: Role, owner: bool, member: bool, signed_in: bool) -> Access {
        Access {
            role, owner, member, signed_in, link_role: None,
            settings: Settings { public: false, public_role: Role::Viewer, editors_can_share: false,
                                 viewers_can_copy: true, links_require_signin: false },
        }
    }

    #[test]
    fn capabilities_follow_the_role() {
        let viewer = access(Role::Viewer, false, true, true);
        assert!(!viewer.can_comment() && !viewer.can_edit() && viewer.can_copy() && !viewer.can_share());
        let commenter = access(Role::Commenter, false, true, true);
        assert!(commenter.can_comment() && !commenter.can_edit() && !commenter.can_share());
        let mut editor = access(Role::Editor, false, true, true);
        assert!(editor.can_comment() && editor.can_edit() && !editor.can_share() && !editor.can_manage());
        editor.settings.editors_can_share = true;
        assert!(editor.can_share() && !editor.can_manage());
        let owner = access(Role::Editor, true, true, true);
        assert!(owner.can_share() && owner.can_manage());
    }

    #[test]
    fn nobody_signed_out_writes_and_copying_can_be_turned_off() {
        let guest = access(Role::Commenter, false, false, false);
        assert!(!guest.can_comment() && !guest.can_edit());
        let mut viewer = access(Role::Viewer, false, true, true);
        viewer.settings.viewers_can_copy = false;
        assert!(!viewer.can_copy());
        let mut editor = access(Role::Editor, false, true, true);
        editor.settings.viewers_can_copy = false;
        assert!(editor.can_copy());
    }

    #[test]
    fn link_cookie_keeps_the_newest_and_drops_junk() {
        let a = "aaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbb";
        assert_eq!(parse_links(&format!("{a}.short.{b}.bad token!xxxxxxxxxxxx")), vec![a.to_string(), b.to_string()]);
        let c = links_cookie(&[a.to_string(), b.to_string()], b, false);
        assert_eq!(c.value(), format!("{b}.{a}"));
    }
}
