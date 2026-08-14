//! HTTP handlers.
//!
//! Each one is a thin wrapper: it resolves the call type for the request,
//! builds the matching domain prompt, and hands the actual work to the
//! upstream `voice_translations` pipeline.

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
    call_type::{self, CallType, CALL_TYPES},
    config::ConferenceConfig,
};

/// The upstream pipeline state plus this app's own settings.
#[derive(Clone)]
pub struct ConfState {
    pub base: AppState,
    pub cfg: Arc<ConferenceConfig>,
}

/// GET /api/config — the upstream audio/VAD and language settings, plus the
/// call-type list and default the UI needs.
pub async fn api_config(State(state): State<ConfState>) -> Json<Value> {
    let mut view = state.base.cfg.client_view();
    if let Some(obj) = view.as_object_mut() {
        obj.insert("call_types".into(), json!(CALL_TYPES));
        obj.insert("default_type".into(), json!(state.cfg.default_type));
    }
    Json(view)
}

/// POST /api/transcribe — multipart `audio`, plus an optional `language`
/// field pinning the expected language.
pub async fn api_transcribe(
    State(state): State<ConfState>,
    mut multipart: Multipart,
) -> Result<Json<TranscribeResponse>, AppError> {
    let form = asr::parse_audio_form(&mut multipart).await?;
    tracing::info!(
        language = form.options.language.as_deref().unwrap_or("auto"),
        "transcribing utterance"
    );
    Ok(Json(
        asr::transcribe(&state.base, &form.audio, &form.options).await?,
    ))
}

/// One utterance to translate, with the call type the prompt needs.
#[derive(Debug, Deserialize)]
pub struct ConfTranslateRequest {
    pub text: String,
    pub target_lang: String,
    #[serde(default)]
    pub source_lang: Option<String>,
    /// Recent utterances of this call, oldest first.
    #[serde(default)]
    pub context: Vec<ContextPair>,
    #[serde(default)]
    pub call_type: Option<String>,
}

/// The domain prompt for one turn: the call setting plus the type's register
/// and terminology notes. Applies equally to the same-language polishing pass
/// (`editing`), where register must survive cleanup.
fn domain_prompt(call_type: &CallType, editing: bool) -> String {
    let task = if editing {
        "You are polishing the raw transcript of one utterance from this call for the record; \
         keep the speaker's own register while cleaning it up."
    } else {
        "You are translating one utterance of this call live; the register notes below govern \
         how it should sound in the target language."
    };
    format!(
        "CALL SETTING\nThis is a live conference call: {}. {}\n\n{}",
        call_type.blurb.to_lowercase(),
        task,
        call_type.guidance
    )
}

/// POST /api/translate — streams the translated utterance back as SSE.
pub async fn api_translate(
    State(state): State<ConfState>,
    Json(req): Json<ConfTranslateRequest>,
) -> impl IntoResponse {
    let call_type = call_type::find_or_default(req.call_type.as_deref());

    let mut upstream = TranslateRequest {
        text: req.text,
        target_lang: req.target_lang,
        source_lang: req.source_lang,
        context: req.context,
        domain_prompt: None,
    };
    let editing = translate::is_editing(&upstream);
    upstream.domain_prompt = Some(domain_prompt(call_type, editing));

    tracing::info!(
        call_type = call_type.id,
        target = %upstream.target_lang,
        editing,
        "translating utterance"
    );
    translate::translate_sse(state.base, upstream)
}

#[derive(Debug, Deserialize)]
pub struct ConfTtsRequest {
    pub text: String,
}

/// POST /api/tts — reads one utterance aloud.
pub async fn api_tts(
    State(state): State<ConfState>,
    Json(req): Json<ConfTtsRequest>,
) -> Result<Response, AppError> {
    Ok(
        tts::synthesize(&state.base, &req.text, &SpeechOptions::default())
            .await?
            .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use super::{domain_prompt, ConfTranslateRequest};
    use crate::call_type::find;

    #[test]
    fn translate_request_defaults_the_optional_fields() {
        let req: ConfTranslateRequest =
            serde_json::from_str(r#"{"text":"hello","target_lang":"Korean"}"#).unwrap();
        assert!(req.call_type.is_none());
        assert!(req.context.is_empty());
    }

    #[test]
    fn domain_prompt_carries_setting_and_guidance() {
        let business = find("business").unwrap();
        let prompt = domain_prompt(business, false);
        assert!(prompt.contains("CALL SETTING"));
        assert!(prompt.contains("translating one utterance"));
        assert!(prompt.contains("BUSINESS MEETING NOTES"));

        let editing = domain_prompt(business, true);
        assert!(editing.contains("polishing the raw transcript"));
        assert!(editing.contains("BUSINESS MEETING NOTES"));
    }
}
