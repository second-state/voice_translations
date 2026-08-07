mod asr;
mod config;
mod translate;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<config::Config>,
    pub http: reqwest::Client,
}

/// Wrapper so handlers can use `?` with any `anyhow`-compatible error.
pub struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("request failed: {:#}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, format!("{:#}", self.0)).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "voice_translations=info".into()),
        )
        .init();

    let cfg = config::Config::load("config.toml")?;
    let addr: SocketAddr = format!("{}:{}", cfg.server.host, cfg.server.port)
        .parse()
        .context("invalid [server] host/port in config.toml")?;

    let state = AppState {
        cfg: Arc::new(cfg),
        http: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/config", get(api_config))
        .route("/api/transcribe", post(asr::api_transcribe))
        .route("/api/translate", post(translate::api_translate))
        // Vendored Silero VAD + onnxruntime-web assets (large binaries, served
        // from disk rather than embedded in the executable).
        .nest_service(
            "/vendor",
            tower_http::services::ServeDir::new("static/vendor"),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
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

/// Expose the client-relevant configuration to the browser UI. Language
/// values from config.toml are ISO 639-1 codes (or full names); normalize
/// them to the display names the UI uses.
async fn api_config(State(state): State<AppState>) -> Json<Value> {
    let cfg = &state.cfg;
    let default_source = asr::normalize_language(&cfg.languages.default_source);
    let default_targets: Vec<String> = cfg
        .languages
        .default_targets
        .iter()
        .map(|lang| asr::normalize_language(lang))
        .collect();
    Json(json!({
        "sentence_break_ms": cfg.audio.sentence_break_ms,
        "min_speech_ms": cfg.audio.min_speech_ms,
        "max_utterance_ms": cfg.audio.max_utterance_ms,
        "vad_positive_threshold": cfg.audio.vad_positive_threshold,
        "vad_negative_threshold": cfg.audio.vad_negative_threshold,
        "pre_speech_pad_ms": cfg.audio.pre_speech_pad_ms,
        "default_source": default_source,
        "default_targets": default_targets,
        "context_messages": cfg.llm.context_messages,
    }))
}
