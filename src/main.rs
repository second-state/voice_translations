use std::path::Path;

use axum::{
    extract::{DefaultBodyLimit, State},
    http::header,
    middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use voice_translations::{
    asr,
    cli::{Cli, CliSpec},
    translate, tts, AppState, Config,
};

/// Vendored assets on disk, relative to the working directory.
const VENDOR_DIR: &str = "static/vendor";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "voice_translations=info".into()),
        )
        .init();

    let Some(cli) = Cli::parse(&CliSpec {
        app: "voice-translations",
        version: env!("CARGO_PKG_VERSION"),
        about: "Real-time speech transcription and translation.",
        env_var: "VOICE_TRANSLATIONS_CONFIG",
        default_config: "config.toml",
    })?
    else {
        return Ok(()); // --help or --version
    };

    // Log the resolved absolute path: which configuration a service ended up
    // with should never be a guess.
    tracing::info!(
        "loading configuration from {}",
        std::fs::canonicalize(&cli.config)
            .unwrap_or_else(|_| cli.config.clone())
            .display()
    );
    let cfg = Config::load(&cli.config)?;
    let addr = cfg.listen_addr()?;
    let state = AppState::new(cfg);

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/config", get(api_config))
        .route("/api/transcribe", post(asr::api_transcribe))
        .route("/api/translate", post(translate::api_translate))
        .route("/api/tts", post(tts::api_tts));

    // Vendored Silero VAD + onnxruntime-web assets. Served from disk when the
    // source tree is there, so they can be swapped without a rebuild; a
    // deployed binary has no source tree and falls back to the copy compiled
    // into it.
    let app = if Path::new(VENDOR_DIR).is_dir() {
        tracing::info!("serving vendor assets from {VENDOR_DIR}");
        app.nest_service("/vendor", tower_http::services::ServeDir::new(VENDOR_DIR))
    } else {
        tracing::info!("serving vendor assets embedded in the binary");
        app.nest("/vendor", voice_translations::assets::vendor_router())
    };

    let app = app
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
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

/// Expose the client-relevant configuration to the browser UI.
async fn api_config(State(state): State<AppState>) -> Json<Value> {
    Json(state.cfg.client_view())
}
