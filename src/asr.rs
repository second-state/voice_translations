use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Multipart, State},
    Json,
};
use serde::Serialize;
use serde_json::Value;

use crate::{AppError, AppState};

#[derive(Debug, Serialize)]
pub struct TranscribeResponse {
    pub text: String,
    /// Detected source language (normalized English name), if reported.
    pub language: Option<String>,
}

/// POST /api/transcribe — accepts a multipart form with an `audio` file and
/// forwards it to the configured OpenAI-compatible transcription endpoint.
pub async fn api_transcribe(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, AppError> {
    let mut audio: Option<(Vec<u8>, String, String)> = None;
    // Optional ISO 639-1 hint when the user picks a fixed source language.
    let mut language_hint: Option<String> = None;
    while let Some(field) = multipart.next_field().await? {
        match field.name() {
            Some("audio") => {
                let filename = field.file_name().unwrap_or("audio.webm").to_string();
                let mime = field.content_type().unwrap_or("audio/webm").to_string();
                let bytes = field.bytes().await?.to_vec();
                audio = Some((bytes, filename, mime));
            }
            Some("language") => {
                let value = field.text().await?.trim().to_string();
                if !value.is_empty() {
                    language_hint = Some(value);
                }
            }
            _ => {}
        }
    }
    let (bytes, filename, mime) =
        audio.ok_or_else(|| anyhow!("missing 'audio' field in form data"))?;

    // verbose_json includes the detected language; fall back to plain json for
    // servers that reject it.
    let hint = language_hint.as_deref();
    let value =
        match request_transcription(&state, &bytes, &filename, &mime, hint, "verbose_json").await {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!("verbose_json transcription failed ({err:#}); retrying with json");
                request_transcription(&state, &bytes, &filename, &mime, hint, "json").await?
            }
        };

    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let language = language_hint
        .as_deref()
        .or_else(|| value.get("language").and_then(Value::as_str))
        .map(normalize_language);

    tracing::info!(
        "transcribed {} bytes -> {:?} ({} chars)",
        bytes.len(),
        language,
        text.len()
    );
    Ok(Json(TranscribeResponse { text, language }))
}

async fn request_transcription(
    state: &AppState,
    bytes: &[u8],
    filename: &str,
    mime: &str,
    language: Option<&str>,
    response_format: &str,
) -> Result<Value> {
    let asr = &state.cfg.asr;
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(mime)
        .context("invalid audio content type")?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", asr.model.clone())
        .text("response_format", response_format.to_string());
    if let Some(language) = language {
        form = form.text("language", language.to_string());
    }

    let url = format!(
        "{}/audio/transcriptions",
        asr.endpoint.trim_end_matches('/')
    );
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&asr.api_key)
        .multipart(form)
        .send()
        .await
        .context("ASR request failed")?;

    let status = resp.status();
    let body = resp.text().await.context("failed to read ASR response")?;
    if !status.is_success() {
        anyhow::bail!("ASR endpoint returned {status}: {body}");
    }
    serde_json::from_str(&body).with_context(|| format!("ASR returned non-JSON response: {body}"))
}

/// Map ISO codes / lowercase names from ASR services to the English language
/// names used throughout the UI, so source/target comparison works.
pub fn normalize_language(raw: &str) -> String {
    let key = raw.trim().to_lowercase();
    let mapped = match key.as_str() {
        "en" | "eng" | "english" => "English",
        "ko" | "kr" | "kor" | "korean" => "Korean",
        "zh" | "cn" | "zho" | "chi" | "chinese" | "mandarin" => "Chinese",
        "ja" | "jp" | "jpn" | "japanese" => "Japanese",
        "es" | "spa" | "spanish" => "Spanish",
        "fr" | "fra" | "fre" | "french" => "French",
        "de" | "deu" | "ger" | "german" => "German",
        "it" | "ita" | "italian" => "Italian",
        "pt" | "por" | "portuguese" => "Portuguese",
        "ru" | "rus" | "russian" => "Russian",
        "ar" | "ara" | "arabic" => "Arabic",
        "hi" | "hin" | "hindi" => "Hindi",
        "vi" | "vie" | "vietnamese" => "Vietnamese",
        "th" | "tha" | "thai" => "Thai",
        "id" | "ind" | "indonesian" => "Indonesian",
        "nl" | "nld" | "dut" | "dutch" => "Dutch",
        "tr" | "tur" | "turkish" => "Turkish",
        "pl" | "pol" | "polish" => "Polish",
        "uk" | "ukr" | "ukrainian" => "Ukrainian",
        "sv" | "swe" | "swedish" => "Swedish",
        "is" | "isl" | "ice" | "icelandic" => "Icelandic",
        "no" | "nb" | "nn" | "nor" | "nob" | "nno" | "norwegian" => "Norwegian",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_language;

    #[test]
    fn normalizes_codes_and_names() {
        assert_eq!(normalize_language("en"), "English");
        assert_eq!(normalize_language("KOREAN"), "Korean");
        assert_eq!(normalize_language("zh"), "Chinese");
        assert_eq!(normalize_language("swahili"), "Swahili");
    }
}
