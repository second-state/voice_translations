use anyhow::{anyhow, Context};
use axum::{
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
}

/// POST /api/tts — forwards the text to the configured OpenAI-compatible
/// speech endpoint and returns the audio bytes.
pub async fn api_tts(
    State(state): State<AppState>,
    Json(req): Json<TtsRequest>,
) -> Result<Response, AppError> {
    let tts = state
        .cfg
        .tts
        .as_ref()
        .ok_or_else(|| anyhow!("[tts] is not configured in config.toml"))?;
    let text = req.text.trim();
    if text.is_empty() {
        return Err(anyhow!("nothing to speak").into());
    }

    let url = format!("{}/audio/speech", tts.endpoint.trim_end_matches('/'));
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&tts.api_key)
        .json(&json!({
            "model": tts.model,
            "input": text,
            "voice": tts.voice,
            "response_format": "mp3",
        }))
        .send()
        .await
        .context("TTS request failed")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("TTS endpoint returned {status}: {body}").into());
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    let bytes = resp.bytes().await.context("failed to read TTS audio")?;
    Ok(([(header::CONTENT_TYPE, content_type)], bytes).into_response())
}
