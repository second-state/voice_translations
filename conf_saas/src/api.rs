//! HTTP handlers.
//!
//! Each one resolves the signed-in account, checks what that account is
//! allowed to do, builds the domain prompt for the utterance, and hands the
//! actual work to the `voice_translations` pipeline. The translation
//! behaviour is the standalone conference app's, unchanged; what this layer
//! adds is who is asking and whether they may.

use std::sync::Arc;

use axum::{
    extract::{FromRef, Multipart, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use voice_translations::{
    asr,
    translate::{self, TranslateRequest},
    tts::{self, SpeechOptions},
    AppState,
};

use conf_translations::{
    api::{ConfTranslateRequest, ConfTtsRequest},
    call_type::{self, CALL_TYPES},
    config::ConferenceConfig,
    lang, prompt,
};

use saas_core::{auth, quota, AppError, SaasState};

/// The pipeline state, the translator's settings, and the service layer.
#[derive(Clone)]
pub struct HostedState {
    pub base: AppState,
    pub conference: Arc<ConferenceConfig>,
    pub saas: SaasState,
}

/// What lets the service layer's handlers — accounts, billing, the dashboard
/// — mount on this app's router and pull their own state out of ours.
impl FromRef<HostedState> for SaasState {
    fn from_ref(state: &HostedState) -> SaasState {
        state.saas.clone()
    }
}

/// GET /api/config — the pipeline's audio settings plus the call types and
/// the language list the UI needs. Public: the sign-in page renders before
/// there is a session.
pub async fn api_config(State(state): State<HostedState>) -> Json<Value> {
    let mut view = state.base.cfg.client_view();
    if let Some(obj) = view.as_object_mut() {
        // The spoken language is always detected here; the configured
        // default source is a fallback for a recognizer that reports none,
        // not a setting the page starts from.
        obj.remove("default_source");
        let conference = &state.conference;
        let saas = &state.saas.cfg;
        obj.insert("call_types".into(), json!(CALL_TYPES));
        obj.insert("default_type".into(), json!(conference.default_type));
        obj.insert("languages".into(), json!(conference.languages));
        obj.insert("billing_enabled".into(), json!(saas.stripe.enabled()));
        obj.insert(
            "free_words_per_week".into(),
            json!(saas.quota.free_words_per_week),
        );
        obj.insert("price_display".into(), json!(saas.stripe.price_display));
    }
    Json(view)
}

/// POST /api/transcribe — multipart `audio`, plus an optional `language`
/// field pinning the spoken language when the user has chosen one instead
/// of letting the recognizer detect it.
///
/// This is where the allowance is spent: the words in the returned
/// transcript are the words the speaker said, counted once for the
/// utterance however many languages it is then translated into.
pub async fn api_transcribe(
    State(state): State<HostedState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    state.saas.enforce_quota(&user)?;

    let form = asr::parse_audio_form(&mut multipart).await?;
    let heard = asr::transcribe(&state.base, &form.audio, &form.options).await?;

    let words = quota::count_words(&heard.text);
    state.saas.db.record_words(&user.id, words, "speaker")?;
    let quota = state.saas.quota_for(&user)?;

    tracing::info!(
        user = %user.email,
        pinned = form.options.language.as_deref().unwrap_or("auto"),
        detected = heard.language.as_deref().unwrap_or("none"),
        words,
        used = quota.used,
        "transcribed an utterance"
    );

    Ok(Json(json!({
        "text": heard.text,
        "language": heard.language,
        "words": words,
        "quota": quota,
    }))
    .into_response())
}

/// POST /api/translate — streams one translation of the utterance back as
/// SSE. The browser calls this once per target language, all at once.
///
/// Translation does not spend allowance of its own: the utterance was
/// already counted when it was transcribed, so five target languages cost
/// the same as one. The quota is still checked, so an exhausted account
/// cannot keep translating text it obtained some other way.
pub async fn api_translate(
    State(state): State<HostedState>,
    headers: HeaderMap,
    Json(req): Json<ConfTranslateRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    state.saas.enforce_quota(&user)?;

    let call_type = call_type::find_or_default(req.call_type.as_deref());

    let mut upstream = TranslateRequest {
        text: req.text,
        target_lang: req.target_lang,
        source_lang: req.source_lang,
        context: req.context,
        domain_prompt: None,
    };
    // Same source and target language means the transcript-polishing pass,
    // not a translation; the domain prompt is framed differently for it.
    let editing = translate::is_editing(&upstream);
    // The call setting, the type's register notes, and the per-language
    // notes all come from the conference crate: this edition has no opinions
    // of its own about how a meeting should sound.
    let mut domain = prompt::domain_prompt(call_type, editing);
    if let Some(notes) =
        lang::language_notes(upstream.source_lang.as_deref(), &upstream.target_lang)
    {
        domain.push_str("\n\n");
        domain.push_str(&notes);
    }
    upstream.domain_prompt = Some(domain);

    tracing::info!(
        user = %user.email,
        call_type = call_type.id,
        target = %upstream.target_lang,
        editing,
        "translating utterance"
    );
    Ok(translate::translate_sse(state.base, upstream).into_response())
}

/// POST /api/tts — reads one utterance aloud. Reading back text the account
/// has already paid for costs no further allowance.
pub async fn api_tts(
    State(state): State<HostedState>,
    headers: HeaderMap,
    Json(req): Json<ConfTtsRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    tracing::debug!(user = %user.email, "reading an utterance aloud");
    Ok(
        tts::synthesize(&state.base, &req.text, &SpeechOptions::default())
            .await?
            .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use conf_translations::api::ConfTranslateRequest;

    /// The request the console sends is the standalone app's, unchanged:
    /// nothing about accounts rides in the body, since the session cookie
    /// carries it.
    #[test]
    fn the_translate_request_is_the_standalone_apps() {
        let req: ConfTranslateRequest = serde_json::from_str(
            r#"{"text":"we ship Friday","target_lang":"Japanese","source_lang":"English",
                "call_type":"tech","context":[]}"#,
        )
        .unwrap();
        assert_eq!(req.call_type.as_deref(), Some("tech"));
        assert_eq!(req.target_lang, "Japanese");
    }
}
