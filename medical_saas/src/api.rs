//! HTTP handlers.
//!
//! Each one resolves the signed-in account, checks what that account is
//! allowed to do, builds the domain prompt for the turn, and hands the actual
//! work to the `voice_translations` pipeline. The interpreting behaviour is
//! the standalone medical app's, unchanged; what this layer adds is who is
//! asking and whether they may.

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

use medical_translations::{
    api::{MedicalTranslateRequest, MedicalTtsRequest},
    config::{resolve_turn_language, MedicalConfig},
    prompt::{self, Speaker},
    specialty::{self, SPECIALTIES},
};

use saas_core::{auth, quota, AppError, SaasState};

/// The pipeline state, the translator's settings, and the service layer.
#[derive(Clone)]
pub struct HostedState {
    pub base: AppState,
    pub medical: Arc<MedicalConfig>,
    pub saas: SaasState,
}

/// What lets the service layer's handlers — accounts, billing, the dashboard
/// — mount on this app's router and pull their own state out of ours.
impl FromRef<HostedState> for SaasState {
    fn from_ref(state: &HostedState) -> SaasState {
        state.saas.clone()
    }
}

/// GET /api/config — the pipeline's audio settings plus the specialty list
/// and encounter defaults the UI needs. Public: the sign-in page renders
/// before there is a session.
pub async fn api_config(State(state): State<HostedState>) -> Json<Value> {
    let mut view = state.base.cfg.client_view();
    if let Some(obj) = view.as_object_mut() {
        // The library's language settings do not apply: this app pairs one
        // clinician language with one patient language instead of
        // broadcasting to a set of targets.
        obj.remove("default_source");
        obj.remove("default_targets");
        let medical = &state.medical;
        let saas = &state.saas.cfg;
        obj.insert("specialties".into(), json!(SPECIALTIES));
        obj.insert("default_specialty".into(), json!(medical.default_specialty));
        obj.insert(
            "clinician_language".into(),
            json!(medical.clinician_language),
        );
        obj.insert("patient_language".into(), json!(medical.patient_language));
        obj.insert("languages".into(), json!(medical.languages));
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
/// field pinning the expected language.
///
/// This is where the allowance is spent: the words in the returned
/// transcript are the words the speaker said, counted once for the turn
/// whichever side spoke them.
pub async fn api_transcribe(
    State(state): State<HostedState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    state.saas.enforce_quota(&user)?;

    let form = asr::parse_audio_form(&mut multipart).await?;
    let heard = asr::transcribe(&state.base, &form.audio, &form.options).await?;
    // Constrain the recognizer's answer to the two languages this encounter
    // actually involves, so a mislabelled turn is not interpreted toward a
    // language nobody in the room speaks.
    let (clinician_lang, patient_lang) = state.medical.encounter_languages(
        form.fields.get("clinician_language").map(String::as_str),
        form.fields.get("patient_language").map(String::as_str),
    );
    let turn = resolve_turn_language(&clinician_lang, &patient_lang, heard.language.as_deref());

    let words = quota::count_words(&heard.text);
    let role = if turn.clinician {
        "clinician"
    } else {
        "patient"
    };
    state.saas.db.record_words(&user.id, words, role)?;
    let quota = state.saas.quota_for(&user)?;

    tracing::info!(
        user = %user.email,
        detected = heard.language.as_deref().unwrap_or("none"),
        language = %turn.language,
        encounter = %format!("{clinician_lang}/{patient_lang}"),
        substituted = turn.substituted,
        role,
        words,
        used = quota.used,
        "transcribed a turn"
    );

    Ok(Json(json!({
        "text": heard.text,
        "language": turn.language,
        "detected": heard.language,
        "substituted": turn.substituted,
        "clinician": turn.clinician,
        "words": words,
        "quota": quota,
    }))
    .into_response())
}

/// POST /api/translate — streams the interpreted turn back as SSE.
///
/// Interpretation does not spend allowance of its own: the turn was already
/// counted when it was transcribed, so a long target language costs the user
/// nothing extra. The quota is still checked, so an exhausted account cannot
/// keep interpreting text it obtained some other way.
pub async fn api_translate(
    State(state): State<HostedState>,
    headers: HeaderMap,
    Json(req): Json<MedicalTranslateRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    state.saas.enforce_quota(&user)?;

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
    // The interpreting rules, the specialty's terminology, and the
    // per-language notes all come from the interpreter crate: this edition
    // does not have opinions of its own about medicine.
    upstream.domain_prompt = Some(prompt::domain_prompt(
        spec,
        speaker,
        editing,
        upstream.source_lang.as_deref(),
        &upstream.target_lang,
    ));

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

/// POST /api/tts — reads one turn aloud. Reading back text the account has
/// already paid for costs no further allowance.
pub async fn api_tts(
    State(state): State<HostedState>,
    headers: HeaderMap,
    Json(req): Json<MedicalTtsRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state.saas, &headers)?;
    let options = SpeechOptions {
        voice: match req.speaker {
            Speaker::Clinician => state.medical.clinician_voice.clone(),
            Speaker::Patient => state.medical.patient_voice.clone(),
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
    use medical_translations::config::MedicalConfig;

    /// The ledger's role follows the same resolution the UI shows, so what
    /// is billed and what is displayed can never disagree.
    #[test]
    fn the_ledger_labels_each_turn_by_resolved_side() {
        let cfg = MedicalConfig::default(); // English clinician, Spanish patient
        assert!(cfg.resolve_turn_language(Some("English")).clinician);
        assert!(!cfg.resolve_turn_language(Some("Spanish")).clinician);
        // A language outside the encounter counts as the patient.
        let odd = cfg.resolve_turn_language(Some("Japanese"));
        assert!(!odd.clinician && odd.substituted);
        assert_eq!(odd.language, "Spanish");
    }
}
