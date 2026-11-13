mod access;
mod ai;
mod datasheet;
mod kicadlib;
mod auth;
mod doc_actor;
mod error;
mod github;
mod http;
mod lenient_json;
mod merge;
mod libs;
mod mcp;
mod mcp_host;
mod oauth;
mod pages;
mod pcm;
mod parts;
mod persist;
mod plugins;
mod registry;
mod relay;
mod templates;
mod versions;
mod ws;

use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub struct Config {
    pub public_url: String,
    /// Public-facing base URL for human links (share/invite).  Defaults to
    /// public_url.  Kept separate because public_url must stay on the host the
    /// GitHub OAuth callback is registered for, while share links should show
    /// the branded domain.
    pub site_url: String,
    pub jwt_secret: String,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    /// GitHub's REST API and web (OAuth) hosts.  Overridable so the repo-sync tests can
    /// run against a local stand-in, and for GitHub Enterprise.
    pub github_api_url: String,
    pub github_web_url: String,
    /// Path to kicad-cli for SVG previews; previews are disabled when unset.
    pub kicad_cli: Option<String>,
    pub render_cache_dir: String,
    /// Extra hostnames (besides public_url) the browser may sign in from; the
    /// OAuth dance is brokered on public_url and the session handed back here.
    pub allowed_origins: Vec<String>,
    /// `KC_DEV_LOGIN=1`: enable `/auth/dev` (session cookie from a JWT minted with the
    /// server's own secret) so a local browser test rig can sign in without GitHub.
    pub dev_login: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cfg: Arc<Config>,
    pub registry: Arc<registry::Registry>,
    pub color_counter: Arc<AtomicUsize>,
    /// Bumped whenever anybody's access to any project changes (role, removal,
    /// transfer, visibility, trash).  Live sockets cache their role per joined
    /// document; a changed epoch makes them look it up again (ws.rs).
    pub access_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// The link to the other server replicas, if there are any (relay.rs).
    pub relay: Arc<relay::Relay>,
}

impl AppState {
    pub fn access_changed(&self) {
        self.access_epoch.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.relay.publish(serde_json::json!({ "t": "access" }));
    }

    /// Deliver a server-initiated event (a comment, a history restore, a snapshot
    /// request) to everyone who has the document open, on whichever replica.  Returns
    /// whether anybody could have received it.
    pub async fn doc_event(&self, doc_id: uuid::Uuid, msg: doc_actor::DocMsg) -> bool {
        use doc_actor::DocMsg;
        let relayed = match &msg {
            DocMsg::Comment { payload } => Some(serde_json::json!({ "t": "comment", "d": doc_id, "comment": payload })),
            DocMsg::Reset { seq } => Some(serde_json::json!({ "t": "reset", "d": doc_id, "seq": seq })),
            DocMsg::SnapshotNow => Some(serde_json::json!({ "t": "snapshot_now", "d": doc_id })),
            DocMsg::Notice { payload } => Some(serde_json::json!({ "t": "notice", "d": doc_id, "payload": payload })),
            _ => None,
        };
        let mut delivered = false;
        if let Some(tx) = self.registry.existing(doc_id) {
            delivered = tx.send(msg).await.is_ok();
        }
        if let Some(relayed) = relayed {
            if self.relay.others_alive() {
                self.relay.publish(relayed);
                delivered = true;
            }
        }
        delivered
    }
}

/// The MCP endpoint and the OAuth endpoints its clients call themselves (mcp.rs, oauth.rs).
/// They authenticate with a bearer token, never a cookie, so any origin may call them: a
/// browser-based MCP client is as welcome as a native one.
fn mcp_routes() -> Router<AppState> {
    use axum::http::{header, Method};
    use tower_http::cors::{Any, CorsLayer};
    Router::new()
        .route("/mcp", post(mcp::post).get(mcp::get).delete(mcp::delete))
        .route("/.well-known/oauth-protected-resource", get(oauth::protected_resource))
        .route("/.well-known/oauth-protected-resource/mcp", get(oauth::protected_resource))
        .route("/.well-known/oauth-authorization-server", get(oauth::authorization_server))
        .route("/.well-known/oauth-authorization-server/mcp", get(oauth::authorization_server))
        .route("/.well-known/openid-configuration", get(oauth::authorization_server))
        .route("/oauth/register", post(oauth::register))
        .route("/oauth/token", post(oauth::token))
        .route("/oauth/revoke", post(oauth::revoke))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
                .allow_headers(Any)
                .expose_headers([header::WWW_AUTHENTICATE, header::HeaderName::from_static("mcp-session-id")]),
        )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let cfg = Config {
        public_url: std::env::var("PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://localhost:{port}"))
            .trim_end_matches('/')
            .to_string(),
        site_url: std::env::var("SITE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("PUBLIC_URL").ok())
            .unwrap_or_else(|| format!("http://localhost:{port}"))
            .trim_end_matches('/')
            .to_string(),
        jwt_secret: std::env::var("JWT_SECRET").unwrap_or_else(|_| {
            tracing::warn!("JWT_SECRET not set — using a random secret; tokens won't survive restarts");
            auth::random_token()
        }),
        github_client_id: std::env::var("GITHUB_CLIENT_ID").ok().filter(|s| !s.is_empty()),
        github_client_secret: std::env::var("GITHUB_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
        github_api_url: std::env::var("GITHUB_API_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.github.com".into())
            .trim_end_matches('/')
            .to_string(),
        github_web_url: std::env::var("GITHUB_WEB_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://github.com".into())
            .trim_end_matches('/')
            .to_string(),
        kicad_cli: std::env::var("KICAD_CLI").ok().filter(|s| !s.is_empty()),
        render_cache_dir: std::env::var("RENDER_CACHE_DIR")
            .unwrap_or_else(|_| "./render-cache".into()),
        allowed_origins: std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        dev_login: std::env::var("KC_DEV_LOGIN").map(|v| v == "1").unwrap_or(false),
    };
    if cfg.dev_login {
        tracing::warn!("KC_DEV_LOGIN=1 — /auth/dev accepts any JWT signed with JWT_SECRET (development only)");
    }
    if cfg.github_client_id.is_none() {
        tracing::warn!("GITHUB_CLIENT_ID/SECRET not set — sign-in disabled until configured");
    }

    let db_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set"))?;

    // Railway's Postgres can come up after us: retry for a while.
    let pool = {
        let mut attempt = 0u32;
        loop {
            match PgPoolOptions::new()
                .max_connections(10)
                .acquire_timeout(Duration::from_secs(5))
                .connect(&db_url)
                .await
            {
                Ok(pool) => break pool,
                Err(e) if attempt < 12 => {
                    attempt += 1;
                    tracing::warn!("db connect failed (attempt {attempt}): {e}; retrying");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Err(e) => return Err(e.into()),
            }
        }
    };
    sqlx::migrate!("./migrations").run(&pool).await?;

    let (relay, relay_outbox) = relay::Relay::new();
    let state = AppState {
        pool: pool.clone(),
        cfg: Arc::new(cfg),
        registry: Arc::new(registry::Registry::new(relay.clone())),
        color_counter: Arc::new(AtomicUsize::new(0)),
        access_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        relay: relay.clone(),
    };
    relay::start(relay, relay_outbox, pool.clone(), state.registry.clone(), state.access_epoch.clone());

    // Daily pruning of ops/snapshots behind snapshot coverage.
    {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
            loop {
                tick.tick().await;
                if let Err(e) = persist::prune(&pool).await {
                    tracing::error!("prune failed: {e}");
                }
            }
        });
    }

    let app = Router::new()
        .route("/", get(pages::home))
        .route("/app", get(pages::app_page))
        .route("/p/{id}/edit", get(pages::app_page))
        .route("/static/dist/editor.js", get(pages::editor_js))
        .route("/static/dist/editor.js.map", get(pages::editor_js_map))
        .route("/static/dist/autoroute.js", get(pages::autoroute_js))
        .route("/static/dist/autoroute.js.map", get(pages::autoroute_js_map))
        .route("/static/dist/viewer3d.js", get(pages::viewer3d_js))
        .route("/static/dist/sim-ngspice.js", get(pages::sim_ngspice_js))
        .route("/static/dist/fab.js", get(pages::fab_js))
        .route("/static/dist/fab.js.map", get(pages::fab_js_map))
        .route("/static/dist/kicad-icons.json", get(pages::kicad_icons_json))
        .route("/static/kicad-canvas.js", get(pages::canvas_js))
        .route("/static/sch-tools.js", get(pages::sch_tools_js))
        .route("/static/pcb-tools.js", get(pages::pcb_tools_js))
        .route("/static/props.js", get(pages::props_js))
        .route("/static/kicad-dialogs.js", get(pages::kicad_dialogs_js))
        .route("/static/dist/ui.js", get(pages::ui_js))
        .route("/static/dist/ui.js.map", get(pages::ui_js_map))
        .route("/static/dist/ui.css", get(pages::ui_css))
        .route("/static/theme.css", get(pages::theme_css))
        .route("/styleguide", get(pages::styleguide_page))
        .route("/static/dist/styleguide.js", get(pages::styleguide_js))
        .route("/welcome", get(pages::landing_page))
        .route("/favicon.svg", get(pages::favicon))
        .route("/favicon.ico", get(pages::favicon_ico))
        .route("/favicon.png", get(pages::icon_file))
        .route("/icon-64.png", get(pages::icon_file))
        .route("/icon-192.png", get(pages::icon_file))
        .route("/icon-512.png", get(pages::icon_file))
        .route("/apple-touch-icon.png", get(pages::icon_file))
        .route("/apple-touch-icon-precomposed.png", get(pages::icon_file))
        .route("/static/dist/landing.js", get(pages::landing_js))
        .route("/static/dist/landing.js.map", get(pages::landing_js_map))
        .route("/static/landing/{name}", get(pages::landing_image))
        .route("/api/projects/{id}/info", get(http::project_info))
        .route("/api/projects/{id}/first-doc", get(http::first_doc_content))
        .route("/healthz", get(http::healthz))
        .route("/j/{token}", get(pages::join_page))
        .route("/auth/github/login", get(auth::github_login))
        .route("/auth/github/callback", get(auth::github_callback))
        .route("/auth/desktop/authorize", get(auth::desktop_authorize))
        .route("/auth/desktop/token", post(auth::desktop_token))
        .route("/auth/desktop/confirm", post(auth::desktop_confirm))
        .route("/api/me", get(auth::me))
        .route("/api/ws-ticket", get(auth::ws_ticket))
        .route("/auth/adopt", get(auth::adopt))
        .route("/auth/dev", get(auth::dev_login))
        .route("/auth/logout", post(auth::logout))
        .route("/api/projects", post(http::create_project).get(http::list_projects))
        .route(
            "/api/projects/{id}",
            get(http::get_project).patch(http::update_project).delete(http::delete_project),
        )
        .route("/api/projects/blank", post(http::create_blank_project))
        .route("/api/templates", get(templates::list))
        .route("/api/templates/{id}/{name}", get(templates::picture))
        .route("/api/projects/from-template", post(templates::create))
        .route("/api/trash", get(http::list_trash))
        .route("/api/projects/{id}/undelete", post(http::undelete_project))
        .route("/api/projects/{id}/star", axum::routing::put(http::star_project).delete(http::unstar_project))
        .route("/api/projects/{id}/transfer", post(http::transfer_project))
        .route("/api/gallery", get(http::gallery))
        .route("/api/projects/{id}/preview.svg", get(http::preview_svg))
        .route("/api/projects/{id}/board-items", get(http::board_items))
        .route("/api/docs/{id}/preview", post(http::upload_preview))
        .route("/api/docs/{id}/preview.svg", get(http::doc_preview_svg))
        .route("/api/docs/{id}/items", get(http::doc_items))
        .route("/api/projects/{id}/docs", post(http::create_doc))
        .route("/api/docs/{id}/content", get(http::doc_content))
        .route("/api/docs/{id}", delete(http::delete_doc).patch(http::move_doc))
        .route("/api/projects/{id}/clone", post(http::clone_project))
        .route(
            "/api/docs/{id}/comments",
            get(http::list_comments).post(http::create_comment),
        )
        .route("/api/projects/{id}/comments", get(http::list_project_comments))
        .route(
            "/api/comments/{id}",
            axum::routing::patch(http::update_comment).delete(http::delete_comment),
        )
        .route("/gallery", get(pages::app_page))
        .route("/trash", get(pages::app_page))
        .route("/gallery-legacy", get(pages::gallery_page))
        .route("/p/{id}", get(pages::app_page))
        .route("/p/{id}/about", get(pages::project_page))
        .route("/p/{id}/live", get(pages::app_page))
        .route("/p/{id}/live-legacy", get(pages::live_page))
        .route("/api/projects/{id}/archive", get(http::download_archive))
        .route("/api/projects/{id}/links", post(http::create_link).get(http::list_links))
        .route("/api/projects/{id}/invites", post(http::invite))
        .route(
            "/api/projects/{id}/invites/{invite_id}",
            delete(http::revoke_invite).patch(http::set_invite_role),
        )
        .route("/api/users/search", get(http::search_users))
        .route("/api/projects/{id}/members", get(http::list_members))
        .route(
            "/api/projects/{id}/members/{member_id}",
            delete(http::remove_member).patch(http::set_member_role),
        )
        .route("/api/projects/{id}/leave", post(http::leave_project))
        .route("/api/projects/{id}/join", post(http::join_opened))
        .route(
            "/api/projects/{id}/permissions",
            get(http::get_permissions).patch(http::set_permissions),
        )
        .route("/api/links/{token}", delete(http::revoke_link))
        .route("/api/join/{token}", post(http::claim_link))
        .route("/api/docs/{doc_id}/snapshots", post(http::upload_snapshot))
        .route("/api/docs/{doc_id}/snapshots/{seq}", get(http::get_snapshot))
        // Version history and branches (versions.rs); the checkpoint routes are the old names
        .merge(versions::routes())
        // GitHub repository sync (github.rs)
        .route("/auth/github/connect", get(auth::github_connect))
        .route("/github", get(github::page))
        .route("/p/{id}/github", get(github::page))
        .route("/static/github.js", get(github::page_js))
        .route("/api/github", get(github::connection).delete(github::disconnect))
        .route("/api/github/repos", get(github::list_repos))
        .route("/api/github/scan", get(github::scan_repo))
        .route("/api/github/import", post(github::import_project))
        .route(
            "/api/projects/{id}/github",
            get(github::project_status).put(github::link_project).delete(github::unlink_project),
        )
        .route("/api/projects/{id}/github/diff", get(github::file_diff))
        .route("/api/projects/{id}/github/commits", get(github::file_commits))
        .route("/api/projects/{id}/github/file", get(github::file_at_commit))
        .route("/api/projects/{id}/github/push", post(github::push))
        .route("/api/projects/{id}/github/settings", post(github::settings))
        .route("/api/projects/{id}/github/pull", post(github::pull))
        // The design assistant (ai.rs)
        .route("/api/ai/datasheet", post(datasheet::read))
        .route("/api/docs/{id}/ops", get(ai::doc_ops))
        .route("/api/kicad-lib/list", get(kicadlib::list))
        .route("/api/kicad-lib/item", get(kicadlib::item))
        .route("/api/kicad-lib/search", get(kicadlib::search))
        .route("/api/kicad-lib/model", get(kicadlib::model))
        // vendor parts and saved part libraries (src/parts)
        .route("/static/dist/parts.js", get(pages::parts_js))
        .route("/static/dist/parts.js.map", get(pages::parts_js_map))
        .route("/api/parts/vendors", get(parts::list_vendors))
        .route("/api/parts/keys/{vendor}", axum::routing::put(parts::put_key).delete(parts::delete_key))
        .route("/api/parts/search", get(parts::search))
        .route("/api/parts/part", get(parts::get_part))
        .route("/api/parts/cad", axum::routing::put(parts::link_cad))
        .route("/api/parts/model.step", get(parts::get_model))
        .route("/api/libraries", get(parts::list_libraries).post(parts::create_library))
        .route("/api/libraries/{id}", get(parts::get_library).patch(parts::update_library).delete(parts::delete_library))
        .route("/api/libraries/{id}/items", post(parts::add_item))
        .route("/api/libraries/{id}/items/{item}", axum::routing::patch(parts::update_item).delete(parts::remove_item))
        .route("/api/libraries/{id}/refresh", post(parts::refresh_library))
        .route("/api/libraries/{id}/export.zip", get(parts::export_library))
        // web editor plugins (the per-account store and the built-in catalog)
        .route("/api/plugins", get(plugins::list))
        .route("/api/plugins/catalog", get(plugins::catalog))
        .route("/api/plugins/pcm", get(pcm::list))
        .route("/api/plugins/pcm/{identifier}", get(pcm::get))
        .route("/api/plugins/pcm/{identifier}/fetch", post(pcm::net_fetch))
        .route("/api/plugins/pcm/{identifier}/icon", get(pcm::icon))
        .route("/api/plugins/{identifier}/files", get(plugins::plugin_files))
        .route("/static/pyodide/{file}", get(pcm::runtime))
        .route("/api/plugins/registry", get(plugins::registry_list))
        .route("/api/plugins/moderation", get(plugins::moderation_list))
        .route("/api/plugins/registry/{identifier}/report", post(plugins::registry_report))
        .route("/api/plugins/registry/{identifier}/moderate", post(plugins::registry_moderate))
        .route("/api/plugins/registry/{identifier}", get(plugins::registry_get).put(plugins::registry_publish).delete(plugins::registry_unpublish))
        .route("/api/projects/{id}/plugins", get(plugins::project_list))
        .route("/api/projects/{id}/plugins/{identifier}", axum::routing::put(plugins::project_recommend).delete(plugins::project_unrecommend))
        .route("/api/plugins/{identifier}", axum::routing::put(plugins::install).delete(plugins::uninstall))
        .route("/api/plugins/{identifier}/state", post(plugins::set_state))
        .route("/ws", get(ws::ws_handler))
        .merge(libs::routes())
        // AI assistants over MCP: the consent page, the Connected apps list and access keys (oauth.rs)
        .route("/oauth/authorize", get(oauth::authorize).post(oauth::decide))
        .route("/connect", get(oauth::connect_page))
        .route("/api/mcp/grants", get(oauth::list_grants))
        .route("/api/mcp/keys", post(oauth::create_key))
        .route("/api/mcp/grants/{id}", delete(oauth::delete_grant))
        .merge(mcp_routes())
        .layer(axum::middleware::from_fn(pages::cache_versioned_assets))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        // SVG previews are ~10x smaller compressed; pages benefit too.
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("kicad-collab-server listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
