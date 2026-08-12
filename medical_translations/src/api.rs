//! HTTP handlers.
//!
//! Each one is a thin wrapper: it resolves the specialty and speaker role for
//! the request, builds the matching domain prompt, and hands the actual work
//! to the upstream `voice_translations` pipeline.

use std::sync::Arc;

use axum::{
    extract::{Multipart, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use voice_translations::{
    asr::{self, TranscribeResponse},
    translate::{self, ContextPair, TranslateRequest},
    tts::{self, SpeechOptions},
    AppError, AppState,
};

use crate::{
    config::MedicalConfig,
    prompt::{self, Speaker},
    specialty::{self, SPECIALTIES},
};

/// The upstream pipeline state plus this app's own settings.
#[derive(Clone)]
pub struct MedicalState {
    pub base: AppState,
    pub cfg: Arc<MedicalConfig>,
}

/// GET /api/config — the upstream audio/VAD settings, plus the specialty list
/// and the encounter defaults the UI needs.
pub async fn api_config(State(state): State<MedicalState>) -> Json<Value> {
    let mut view = state.base.cfg.client_view();
    if let Some(obj) = view.as_object_mut() {
        // The upstream language settings do not apply: this app pairs one
        // clinician language with one patient language instead of broadcasting
        // to a set of targets.
        obj.remove("default_source");
        obj.remove("default_targets");
        let cfg = &state.cfg;
        obj.insert("specialties".into(), json!(SPECIALTIES));
        obj.insert("default_specialty".into(), json!(cfg.default_specialty));
        obj.insert("clinician_language".into(), json!(cfg.clinician_language));
        obj.insert("patient_language".into(), json!(cfg.patient_language));
        obj.insert("languages".into(), json!(cfg.languages));
        obj.insert("speak_translations".into(), json!(cfg.speak_translations));
    }
    Json(view)
}

/// POST /api/transcribe — multipart `audio`, plus optional `language` and
/// `specialty` fields. The specialty selects the vocabulary primer sent to the
/// recognizer.
pub async fn api_transcribe(
    State(state): State<MedicalState>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, AppError> {
    let mut form = asr::parse_audio_form(&mut multipart).await?;
    let spec = specialty::find_or_default(form.fields.get("specialty").map(String::as_str));

    if state.cfg.send_primer(form.options.language.as_deref()) {
        form.options.prompt = Some(prompt::asr_primer(spec));
    }

    tracing::info!(
        specialty = spec.id,
        language = form.options.language.as_deref().unwrap_or("auto"),
        primed = form.options.prompt.is_some(),
        "transcribing utterance"
    );
    Ok(Json(
        asr::transcribe(&state.base, &form.audio, &form.options).await?,
    ))
}

/// One turn to translate, with the medical context the prompt needs.
#[derive(Debug, Deserialize)]
pub struct MedicalTranslateRequest {
    pub text: String,
    pub target_lang: String,
    #[serde(default)]
    pub source_lang: Option<String>,
    /// Recent turns of this encounter, oldest first.
    #[serde(default)]
    pub context: Vec<ContextPair>,
    #[serde(default)]
    pub specialty: Option<String>,
    /// Who spoke this turn; `unknown` when the UI is auto-detecting.
    #[serde(default)]
    pub speaker: Speaker,
}

/// POST /api/translate — streams the interpreted turn back as SSE.
pub async fn api_translate(
    State(state): State<MedicalState>,
    Json(req): Json<MedicalTranslateRequest>,
) -> impl IntoResponse {
    let spec = specialty::find_or_default(req.specialty.as_deref());
    let speaker = req.speaker;

    let mut upstream = TranslateRequest {
        text: req.text,
        target_lang: req.target_lang,
        source_lang: req.source_lang,
        context: req.context,
        domain_prompt: None,
    };
    // Same source and target language means the transcript-polishing pass, not
    // an interpretation; the domain prompt is framed differently for it.
    let editing = translate::is_editing(&upstream);
    let mut domain = prompt::translation_prompt(spec, speaker, editing);
    if let Some(notes) = prompt::language_notes(&upstream.target_lang) {
        domain.push_str("\n\n");
        domain.push_str(notes);
    }
    upstream.domain_prompt = Some(domain);

    tracing::info!(
        specialty = spec.id,
        speaker = speaker.label(),
        target = %upstream.target_lang,
        editing,
        "interpreting turn"
    );
    translate::translate_sse(state.base, upstream)
}

#[derive(Debug, Deserialize)]
pub struct MedicalTtsRequest {
    pub text: String,
    /// Read clinician and patient turns in different voices when configured.
    #[serde(default)]
    pub speaker: Speaker,
}

/// POST /api/tts — reads one turn aloud.
pub async fn api_tts(
    State(state): State<MedicalState>,
    Json(req): Json<MedicalTtsRequest>,
) -> Result<Response, AppError> {
    let options = SpeechOptions {
        voice: match req.speaker {
            Speaker::Clinician => state.cfg.clinician_voice.clone(),
            Speaker::Patient => state.cfg.patient_voice.clone(),
            Speaker::Unknown => None,
        },
        ..Default::default()
    };
    Ok(tts::synthesize(&state.base, &req.text, &options)
        .await?
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::{MedicalTranslateRequest, MedicalTtsRequest};
    use crate::prompt::Speaker;

    #[test]
    fn translate_request_defaults_the_optional_fields() {
        let req: MedicalTranslateRequest =
            serde_json::from_str(r#"{"text":"hola","target_lang":"English"}"#).unwrap();
        assert_eq!(req.speaker, Speaker::Unknown);
        assert!(req.specialty.is_none());
        assert!(req.context.is_empty());
    }

    #[test]
    fn translate_request_reads_speaker_and_specialty() {
        let req: MedicalTranslateRequest = serde_json::from_str(
            r#"{"text":"take two tablets","target_lang":"Spanish","source_lang":"English",
                "specialty":"pharmacy","speaker":"clinician",
                "context":[{"source":"hello","translation":"hola"}]}"#,
        )
        .unwrap();
        assert_eq!(req.speaker, Speaker::Clinician);
        assert_eq!(req.specialty.as_deref(), Some("pharmacy"));
        assert_eq!(req.context.len(), 1);
    }

    #[test]
    fn tts_request_accepts_a_bare_text_body() {
        let req: MedicalTtsRequest = serde_json::from_str(r#"{"text":"hello"}"#).unwrap();
        assert_eq!(req.speaker, Speaker::Unknown);
    }
}
