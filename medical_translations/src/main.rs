//! Medical Interpreter — real-time two-way interpreting for patient/clinician
//! conversations.
//!
//! The speech pipeline (browser-side Silero VAD, ASR, streaming LLM
//! translation, TTS) is the `voice_translations` crate. What this app adds is
//! medical domain knowledge: a specialty picker that primes the recognizer
//! with the field's vocabulary and gives the translator that field's
//! terminology rules, on top of a set of general medical-interpreting rules
//! aimed at the ways clinical meaning gets lost in translation.

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

use medical_translations::{
    api::{self, MedicalState},
    config::AppConfig,
    specialty,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "medical_translations=info,voice_translations=info".into()),
        )
        .init();

    let Some(cli) = Cli::parse(&CliSpec {
        app: "medical-translations",
        version: env!("CARGO_PKG_VERSION"),
        about: "Real-time interpreting for patient/clinician conversations.",
        env_var: "MEDICAL_TRANSLATIONS_CONFIG",
        default_config: "config.toml",
    })?
    else {
        return Ok(()); // --help or --version
    };

    // This app and the general translator both default to `config.toml`, so
    // the resolved absolute path is logged: running one from the other's
    // directory would otherwise load the wrong file silently.
    tracing::info!(
        "loading configuration from {}",
        std::fs::canonicalize(&cli.config)
            .unwrap_or_else(|_| cli.config.clone())
            .display()
    );
    let cfg = AppConfig::load(&cli.config)?;
    let addr = cfg.base.listen_addr()?;
    let state = MedicalState {
        base: AppState::new(cfg.base),
        cfg: Arc::new(cfg.medical),
    };

    tracing::info!(
        specialties = specialty::SPECIALTIES.len(),
        default = %state.cfg.default_specialty,
        clinician = %state.cfg.clinician_language,
        patient = %state.cfg.patient_language,
        "medical interpreter ready"
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
        // upstream crate's `embed-assets` feature.
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
