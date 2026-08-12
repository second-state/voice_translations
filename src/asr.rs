use std::collections::HashMap;

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

/// Everything the transcription endpoint accepts besides the audio itself.
#[derive(Debug, Default, Clone)]
pub struct TranscribeOptions {
    /// Upload filename; some services pick the decoder from its extension.
    pub filename: Option<String>,
    /// Audio MIME type.
    pub mime: Option<String>,
    /// ISO 639-1 hint that pins the spoken language instead of detecting it.
    pub language: Option<String>,
}

/// An `audio` upload together with the text fields that came with it.
#[derive(Debug, Default)]
pub struct AudioForm {
    pub audio: Vec<u8>,
    pub options: TranscribeOptions,
    /// Text fields other than the ones folded into `options`, keyed by field
    /// name, so a downstream app can carry its own metadata (a specialty, a
    /// speaker role) on the same multipart request.
    pub fields: HashMap<String, String>,
}

/// POST /api/transcribe — accepts a multipart form with an `audio` file and
/// forwards it to the configured OpenAI-compatible transcription endpoint.
pub async fn api_transcribe(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, AppError> {
    let form = parse_audio_form(&mut multipart).await?;
    Ok(Json(transcribe(&state, &form.audio, &form.options).await?))
}

/// Pull the `audio` file and the recognized `language` text field out of a
/// multipart request, keeping any other text field in [`AudioForm::fields`].
pub async fn parse_audio_form(multipart: &mut Multipart) -> Result<AudioForm> {
    let mut audio: Option<Vec<u8>> = None;
    let mut options = TranscribeOptions::default();
    let mut fields = HashMap::new();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "audio" => {
                options.filename = Some(field.file_name().unwrap_or("audio.webm").to_string());
                options.mime = Some(field.content_type().unwrap_or("audio/webm").to_string());
                audio = Some(field.bytes().await?.to_vec());
            }
            "" => {}
            _ => {
                let value = field.text().await?.trim().to_string();
                if value.is_empty() {
                    continue;
                }
                match name.as_str() {
                    "language" => options.language = Some(value),
                    _ => {
                        fields.insert(name, value);
                    }
                }
            }
        }
    }

    Ok(AudioForm {
        audio: audio.ok_or_else(|| anyhow!("missing 'audio' field in form data"))?,
        options,
        fields,
    })
}

/// Transcribe one utterance. Asks for `verbose_json` first so the detected
/// language comes back, and retries as plain `json` for services that reject
/// the verbose format.
pub async fn transcribe(
    state: &AppState,
    audio: &[u8],
    options: &TranscribeOptions,
) -> Result<TranscribeResponse> {
    let value = match request_transcription(state, audio, options, "verbose_json").await {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!("verbose_json transcription failed ({err:#}); retrying with json");
            request_transcription(state, audio, options, "json").await?
        }
    };

    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // A pinned source language wins over whatever the service reports.
    let language = options
        .language
        .as_deref()
        .or_else(|| value.get("language").and_then(Value::as_str))
        .map(normalize_language);

    tracing::info!(
        "transcribed {} bytes -> {:?} ({} chars)",
        audio.len(),
        language,
        text.len()
    );
    Ok(TranscribeResponse { text, language })
}

async fn request_transcription(
    state: &AppState,
    audio: &[u8],
    options: &TranscribeOptions,
    response_format: &str,
) -> Result<Value> {
    let asr = &state.cfg.asr;
    let part = reqwest::multipart::Part::bytes(audio.to_vec())
        .file_name(
            options
                .filename
                .clone()
                .unwrap_or_else(|| "audio.wav".into()),
        )
        .mime_str(options.mime.as_deref().unwrap_or("audio/wav"))
        .context("invalid audio content type")?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", asr.model.clone())
        .text("response_format", response_format.to_string());
    if let Some(language) = &options.language {
        form = form.text("language", language.clone());
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
        "tl" | "fil" | "tgl" | "tagalog" | "filipino" => "Tagalog",
        "fa" | "fas" | "per" | "persian" | "farsi" => "Persian",
        "he" | "heb" | "hebrew" => "Hebrew",
        "bn" | "ben" | "bengali" => "Bengali",
        "ur" | "urd" | "urdu" => "Urdu",
        "pa" | "pan" | "punjabi" => "Punjabi",
        "ta" | "tam" | "tamil" => "Tamil",
        "te" | "tel" | "telugu" => "Telugu",
        "gu" | "guj" | "gujarati" => "Gujarati",
        "mr" | "mar" | "marathi" => "Marathi",
        "sw" | "swa" | "swahili" => "Swahili",
        "am" | "amh" | "amharic" => "Amharic",
        "so" | "som" | "somali" => "Somali",
        "ht" | "hat" | "haitian" | "haitian creole" => "Haitian Creole",
        // "yue chinese" is whisper-large-v3's verbose_json label for Cantonese.
        "yue" | "cantonese" | "yue chinese" | "zh-hk" | "zh-yue" => "Cantonese",
        "ro" | "ron" | "rum" | "romanian" => "Romanian",
        "el" | "ell" | "gre" | "greek" => "Greek",
        "hu" | "hun" | "hungarian" => "Hungarian",
        "cs" | "ces" | "cze" | "czech" => "Czech",
        "da" | "dan" | "danish" => "Danish",
        "fi" | "fin" | "finnish" => "Finnish",
        "ne" | "nep" | "nepali" => "Nepali",
        "my" | "mya" | "bur" | "burmese" => "Burmese",
        "km" | "khm" | "khmer" => "Khmer",
        "lo" | "lao" => "Lao",
        "hmn" | "hmong" => "Hmong",
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

    #[test]
    fn normalizes_languages_common_in_clinics() {
        assert_eq!(normalize_language("es"), "Spanish");
        assert_eq!(normalize_language("tl"), "Tagalog");
        assert_eq!(normalize_language("ht"), "Haitian Creole");
        assert_eq!(normalize_language("yue"), "Cantonese");
        assert_eq!(normalize_language("Yue Chinese"), "Cantonese");
    }
}
