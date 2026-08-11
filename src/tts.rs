use anyhow::{anyhow, Context, Result};
use axum::{
    body::Bytes,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{AppError, AppState};

#[derive(Debug, Deserialize)]
pub struct TtsRequest {
    pub text: String,
    /// Overrides `[tts] voice` for this utterance; lets an app give different
    /// speakers different voices.
    #[serde(default)]
    pub voice: Option<String>,
}

/// Per-request overrides for [`synthesize`].
#[derive(Debug, Default, Clone)]
pub struct SpeechOptions {
    /// Voice name; falls back to `[tts] voice` from the configuration.
    pub voice: Option<String>,
    /// Audio container, e.g. `mp3` (the default) or `wav`.
    pub format: Option<String>,
}

/// Synthesized speech plus the content type the upstream service returned.
pub struct Speech {
    pub content_type: String,
    pub bytes: Bytes,
}

impl IntoResponse for Speech {
    fn into_response(self) -> Response {
        ([(header::CONTENT_TYPE, self.content_type)], self.bytes).into_response()
    }
}

/// POST /api/tts — forwards the text to the configured OpenAI-compatible
/// speech endpoint and returns the audio bytes.
pub async fn api_tts(
    State(state): State<AppState>,
    Json(req): Json<TtsRequest>,
) -> Result<Response, AppError> {
    let options = SpeechOptions {
        voice: req.voice,
        ..Default::default()
    };
    Ok(synthesize(&state, &req.text, &options)
        .await?
        .into_response())
}

/// Read `text` aloud with the configured speech service.
pub async fn synthesize(state: &AppState, text: &str, options: &SpeechOptions) -> Result<Speech> {
    let tts = state
        .cfg
        .tts
        .as_ref()
        .ok_or_else(|| anyhow!("[tts] is not configured in config.toml"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("nothing to speak"));
    }

    let url = format!("{}/audio/speech", tts.endpoint.trim_end_matches('/'));
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&tts.api_key)
        .json(&json!({
            "model": tts.model,
            "input": text,
            "voice": options.voice.as_deref().unwrap_or(&tts.voice),
            "response_format": options.format.as_deref().unwrap_or("mp3"),
        }))
        .send()
        .await
        .context("TTS request failed")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("TTS endpoint returned {status}: {body}"));
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    let bytes = resp.bytes().await.context("failed to read TTS audio")?;
    Ok(Speech {
        content_type,
        bytes,
    })
}
