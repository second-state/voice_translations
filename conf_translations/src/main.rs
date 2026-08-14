//! Conference Translator — real-time multi-language translation for
//! conference calls.
//!
//! The speech pipeline (browser-side Silero VAD, ASR, streaming LLM
//! translation, TTS) is the `voice_translations` library. What this app adds
//! is a call-type picker — business meeting, formal event, friends, politics,
//! book club, tech — whose register and terminology notes shape every
//! translation, so a negotiation is not rendered like banter and banter is
//! not rendered like a communiqué.

mod api;
mod call_type;
mod config;
mod lang;

use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::header,
    middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Router,
};

use voice_translations::{
    assets,
    cli::{Cli, CliSpec},
    AppState,
};

use crate::{api::ConfState, config::AppConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "conf_translations=info,voice_translations=info".into()),
        )
        .init();

    let Some(cli) = Cli::parse(&CliSpec {
        app: "conf-translations",
        version: env!("CARGO_PKG_VERSION"),
        about: "Real-time translation for conference calls.",
        env_var: "CONF_TRANSLATIONS_CONFIG",
        default_config: "config.toml",
    })?
    else {
        return Ok(()); // --help or --version
    };

    // Every app in this workspace defaults to `config.toml`, so the resolved
    // absolute path is logged: running one from another's directory would
    // otherwise load the wrong file silently.
    tracing::info!(
        "loading configuration from {}",
        std::fs::canonicalize(&cli.config)
            .unwrap_or_else(|_| cli.config.clone())
            .display()
    );
    let cfg = AppConfig::load(&cli.config)?;
    let addr = cfg.base.listen_addr()?;
    let state = ConfState {
        base: AppState::new(cfg.base),
        cfg: Arc::new(cfg.conference),
    };

    tracing::info!(
        call_types = call_type::CALL_TYPES.len(),
        default = %state.cfg.default_type,
        "conference translator ready"
    );

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/config", get(api::api_config))
        .route("/api/transcribe", post(api::api_transcribe))
        .route("/api/translate", post(api::api_translate))
        .route("/api/tts", post(api::api_tts))
        // Silero VAD + onnxruntime-web, compiled into this binary by the
        // library crate's `embed-assets` feature.
        .nest("/vendor", assets::vendor_router())
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        // Microphone access requires HTTPS, so a plain-HTTP tunnel URL would
        // load the page and then silently have no microphone API.
        .layer(middleware::from_fn(voice_translations::force_https))
        .with_state(state);

    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

async fn app_js() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../static/app.js"),
    )
}

async fn style_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/style.css"),
    )
}
