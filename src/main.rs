use axum::{
    extract::{DefaultBodyLimit, State},
    http::header,
    middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use voice_translations::{asr, translate, tts, AppState, Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "voice_translations=info".into()),
        )
        .init();

    let cfg = Config::load("config.toml")?;
    let addr = cfg.listen_addr()?;
    let state = AppState::new(cfg);

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/config", get(api_config))
        .route("/api/transcribe", post(asr::api_transcribe))
        .route("/api/translate", post(translate::api_translate))
        .route("/api/tts", post(tts::api_tts))
        // Vendored Silero VAD + onnxruntime-web assets (large binaries, served
        // from disk rather than embedded in the executable).
        .nest_service(
            "/vendor",
            tower_http::services::ServeDir::new("static/vendor"),
        )
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
