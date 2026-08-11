//! Real-time speech transcription and translation over OpenAI-compatible
//! services.
//!
//! This crate ships a complete web app (`src/main.rs`), but every stage of the
//! pipeline is also exposed as a plain function so other Axum apps can reuse
//! the machinery and specialize it for a domain:
//!
//! * [`asr::transcribe`] — audio bytes to text, with an optional vocabulary
//!   primer that biases the recognizer toward domain jargon.
//! * [`translate::translate_sse`] — a streaming translation response, with an
//!   optional [`translate::TranslateRequest::domain_prompt`] spliced into the
//!   system prompt.
//! * [`tts::synthesize`] — text to spoken audio.
//!
//! All three take a [`AppState`], so a downstream app that keeps its own
//! richer state only has to hold one of these alongside it:
//!
//! ```no_run
//! use std::sync::Arc;
//! use voice_translations::{asr, AppState, Config};
//!
//! # async fn example() -> anyhow::Result<()> {
//! let state = AppState::new(Config::load("config.toml")?);
//! let opts = asr::TranscribeOptions {
//!     prompt: Some("mitral regurgitation, atrial fibrillation".into()),
//!     ..Default::default()
//! };
//! let result = asr::transcribe(&state, b"...wav bytes...", &opts).await?;
//! println!("{}", result.text);
//! # Ok(())
//! # }
//! ```

pub mod asr;
pub mod config;
pub mod translate;
pub mod tts;

#[cfg(feature = "embed-assets")]
pub mod assets;

use std::sync::Arc;

use axum::{
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
};

pub use config::Config;

/// The handles every request needs: the loaded configuration, and one pooled
/// HTTP client shared across all calls to the upstream ASR/LLM/TTS services.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
}

impl AppState {
    /// Build state around a freshly loaded configuration.
    pub fn new(cfg: Config) -> Self {
        Self::with_shared(Arc::new(cfg))
    }

    /// Build state around an already-shared configuration, for apps that hold
    /// their own `Arc<Config>` and want the connection pool shared too.
    pub fn with_shared(cfg: Arc<Config>) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }
}

/// Wrapper so handlers can use `?` with any `anyhow`-compatible error.
pub struct AppError(pub anyhow::Error);

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
