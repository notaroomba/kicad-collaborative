mod auth;
mod doc_actor;
mod error;
mod http;
mod pages;
mod persist;
mod registry;
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
    pub jwt_secret: String,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cfg: Arc<Config>,
    pub auth_pending: Arc<auth::AuthPending>,
    pub registry: Arc<registry::Registry>,
    pub color_counter: Arc<AtomicUsize>,
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
        jwt_secret: std::env::var("JWT_SECRET").unwrap_or_else(|_| {
            tracing::warn!("JWT_SECRET not set — using a random secret; tokens won't survive restarts");
            auth::random_token()
        }),
        github_client_id: std::env::var("GITHUB_CLIENT_ID").ok().filter(|s| !s.is_empty()),
        github_client_secret: std::env::var("GITHUB_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
    };
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

    let state = AppState {
        pool: pool.clone(),
        cfg: Arc::new(cfg),
        auth_pending: Arc::new(auth::AuthPending::default()),
        registry: Arc::new(registry::Registry::default()),
        color_counter: Arc::new(AtomicUsize::new(0)),
    };

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
        .route("/", get(pages::index))
        .route("/healthz", get(http::healthz))
        .route("/j/{token}", get(pages::join_page))
        .route("/auth/github/login", get(auth::github_login))
        .route("/auth/github/callback", get(auth::github_callback))
        .route("/auth/desktop/authorize", get(auth::desktop_authorize))
        .route("/auth/desktop/token", post(auth::desktop_token))
        .route("/auth/desktop/confirm", post(auth::desktop_confirm))
        .route("/api/me", get(auth::me))
        .route("/api/projects", post(http::create_project))
        .route("/api/projects/{id}", get(http::get_project))
        .route("/api/projects/{id}/archive", get(http::download_archive))
        .route("/api/projects/{id}/links", post(http::create_link))
        .route("/api/projects/{id}/invites", post(http::invite))
        .route("/api/projects/{id}/members", get(http::list_members))
        .route("/api/projects/{id}/members/{member_id}", delete(http::remove_member))
        .route("/api/links/{token}", delete(http::revoke_link))
        .route("/api/join/{token}", post(http::claim_link))
        .route("/api/docs/{doc_id}/snapshots", post(http::upload_snapshot))
        .route("/api/docs/{doc_id}/snapshots/{seq}", get(http::get_snapshot))
        .route(
            "/api/projects/{id}/checkpoints",
            post(http::create_checkpoint).get(http::list_checkpoints),
        )
        .route("/api/projects/{id}/restore", post(http::restore_checkpoint))
        .route("/ws", get(ws::ws_handler))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("kicad-collab-server listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
