//! HTTP handlers.
//!
//! Each one resolves the signed-in account, checks what that account is
//! allowed to do, builds the domain prompt for the turn, and hands the actual
//! work to the `voice_translations` pipeline. The interpreting behaviour is
//! the standalone medical app's, unchanged; what this layer adds is who is
//! asking and whether they may.

use std::sync::Arc;

use axum::{
    extract::{Multipart, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use voice_translations::{
    asr,
    translate::{self, ContextPair, TranslateRequest},
    tts::{self, SpeechOptions},
    AppState,
};

use crate::{
    auth,
    config::Settings,
    db::Db,
    error::AppError,
    lang,
    prompt::{self, Speaker},
    quota,
    specialty::{self, SPECIALTIES},
};

/// The pipeline state, this app's settings, the account database, and the
/// HTTP client the email and Stripe calls share.
#[derive(Clone)]
pub struct SaasState {
    pub base: AppState,
    pub cfg: Arc<Settings>,
    pub db: Db,
    pub http: reqwest::Client,
}

impl SaasState {
    /// The signed-in account's current standing.
    fn quota_for(&self, user: &crate::db::User) -> Result<quota::Quota, AppError> {
        Ok(quota::current(
            &self.db,
            user,
            self.cfg.quota.free_words_per_week,
        )?)
    }

    /// Refuse the turn when a free account has spent its allowance. Checked
    /// before every billable step so a client that ignores the 402 on one
    /// endpoint cannot simply call the next one.
    fn enforce_quota(&self, user: &crate::db::User) -> Result<quota::Quota, AppError> {
        let quota = self.quota_for(user)?;
        if quota.allows_more() {
            Ok(quota)
        } else {
            Err(AppError::QuotaExceeded(quota))
        }
    }
}

/// GET /api/config — the pipeline's audio settings plus the specialty list
/// and encounter defaults the UI needs. Public: the sign-in page renders
/// before there is a session.
pub async fn api_config(State(state): State<SaasState>) -> Json<Value> {
    let mut view = state.base.cfg.client_view();
    if let Some(obj) = view.as_object_mut() {
        // The library's language settings do not apply: this app pairs one
        // clinician language with one patient language instead of
        // broadcasting to a set of targets.
        obj.remove("default_source");
        obj.remove("default_targets");
        let cfg = &state.cfg;
        obj.insert("specialties".into(), json!(SPECIALTIES));
        obj.insert(
            "default_specialty".into(),
            json!(cfg.medical.default_specialty),
        );
        obj.insert(
            "clinician_language".into(),
            json!(cfg.medical.clinician_language),
        );
        obj.insert(
            "patient_language".into(),
            json!(cfg.medical.patient_language),
        );
        obj.insert("languages".into(), json!(cfg.medical.languages));
        obj.insert("billing_enabled".into(), json!(cfg.stripe.enabled()));
        obj.insert(
            "free_words_per_week".into(),
            json!(cfg.quota.free_words_per_week),
        );
    }
    Json(view)
}

/// POST /api/transcribe — multipart `audio`, plus an optional `language`
/// field pinning the expected language.
///
/// This is where the allowance is spent: the words in the returned
/// transcript are the words the speaker said, counted once for the turn
/// whichever side spoke them.
pub async fn api_transcribe(
    State(state): State<SaasState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state, &headers)?;
    state.enforce_quota(&user)?;

    let form = asr::parse_audio_form(&mut multipart).await?;
    let heard = asr::transcribe(&state.base, &form.audio, &form.options).await?;

    let words = quota::count_words(&heard.text);
    let role = speaker_for(&state, heard.language.as_deref());
    state.db.record_words(&user.id, words, role)?;
    let quota = state.quota_for(&user)?;

    tracing::info!(
        user = %user.email,
        language = heard.language.as_deref().unwrap_or("auto"),
        role,
        words,
        used = quota.used,
        "transcribed a turn"
    );

    Ok(Json(json!({
        "text": heard.text,
        "language": heard.language,
        "words": words,
        "quota": quota,
    }))
    .into_response())
}

/// Which side of the encounter spoke, inferred the same way the UI infers
/// it: anything that is not the clinician's language is the patient. Used
/// only to label the usage ledger — both sides draw on the same allowance.
fn speaker_for(state: &SaasState, detected: Option<&str>) -> &'static str {
    match detected {
        Some(lang) if lang.eq_ignore_ascii_case(&state.cfg.medical.clinician_language) => {
            "clinician"
        }
        Some(_) => "patient",
        None => "unknown",
    }
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
///
/// Interpretation does not spend allowance of its own: the turn was already
/// counted when it was transcribed, so a long target language costs the user
/// nothing extra. The quota is still checked, so an exhausted account cannot
/// keep interpreting text it obtained some other way.
pub async fn api_translate(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Json(req): Json<MedicalTranslateRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state, &headers)?;
    state.enforce_quota(&user)?;

    let spec = specialty::find_or_default(req.specialty.as_deref());
    let speaker = req.speaker;

    let mut upstream = TranslateRequest {
        text: req.text,
        target_lang: req.target_lang,
        source_lang: req.source_lang,
        context: req.context,
        domain_prompt: None,
    };
    // Same source and target language means the transcript-polishing pass,
    // not an interpretation; the domain prompt is framed differently for it.
    let editing = translate::is_editing(&upstream);
    let mut domain = prompt::translation_prompt(spec, speaker, editing);
    // This app's per-language and per-pair rendering notes.
    if let Some(notes) =
        lang::language_notes(upstream.source_lang.as_deref(), &upstream.target_lang)
    {
        domain.push_str("\n\n");
        domain.push_str(&notes);
    }
    upstream.domain_prompt = Some(domain);

    tracing::info!(
        user = %user.email,
        specialty = spec.id,
        speaker = speaker.label(),
        target = %upstream.target_lang,
        editing,
        "interpreting turn"
    );
    Ok(translate::translate_sse(state.base, upstream).into_response())
}

#[derive(Debug, Deserialize)]
pub struct MedicalTtsRequest {
    pub text: String,
    /// Read clinician and patient turns in different voices when configured.
    #[serde(default)]
    pub speaker: Speaker,
}

/// POST /api/tts — reads one turn aloud. Reading back text the account has
/// already paid for costs no further allowance.
pub async fn api_tts(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Json(req): Json<MedicalTtsRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state, &headers)?;
    let options = SpeechOptions {
        voice: match req.speaker {
            Speaker::Clinician => state.cfg.medical.clinician_voice.clone(),
            Speaker::Patient => state.cfg.medical.patient_voice.clone(),
            Speaker::Unknown => None,
        },
        ..Default::default()
    };
    tracing::debug!(user = %user.email, "reading a turn aloud");
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
