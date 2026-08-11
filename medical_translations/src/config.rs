//! Configuration: the upstream `[server] [audio] [asr] [llm] [tts]` sections
//! plus this app's own `[medical]` section, read from one `config.toml`.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use voice_translations::asr::normalize_language;

use crate::specialty::{self, DEFAULT_SPECIALTY};

/// Everything loaded from `config.toml`.
pub struct AppConfig {
    /// Sections the upstream crate owns.
    pub base: voice_translations::Config,
    /// This app's `[medical]` section.
    pub medical: MedicalConfig,
}

impl AppConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read {}; copy config.example.toml to config.toml and fill in your \
                 credentials",
                path.display()
            )
        })?;
        // Parsed twice against two independent structs: the upstream config
        // ignores `[medical]`, and this one ignores everything else, so
        // neither crate has to know about the other's settings.
        let base =
            toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))?;
        let root: FileRoot = toml::from_str(&raw)
            .with_context(|| format!("failed to parse [medical] in {}", path.display()))?;
        let medical = root.medical.normalized()?;
        Ok(Self { base, medical })
    }
}

/// Only the section this app owns; every other table in the file is ignored.
#[derive(Debug, Deserialize)]
struct FileRoot {
    #[serde(default)]
    medical: MedicalConfig,
}

/// When to send the specialty vocabulary primer to the speech recognizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AsrPrimer {
    /// Send it only when the utterance is known to be English.
    ///
    /// The primers are written in English, and a Whisper-family recognizer
    /// given a primer in one language and audio in another tends to emit the
    /// primer's language — which would silently turn a patient's Spanish into
    /// English and send the whole turn through the pipeline backwards. Pinning
    /// "who is speaking" in the UI is what makes a turn known-English, so the
    /// primer fires on exactly the turns that carry the dense jargon.
    #[default]
    Auto,
    /// Send it on every utterance, including auto-detected ones.
    Always,
    /// Never send it; the recognizer gets audio only.
    Never,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct MedicalConfig {
    /// Specialty selected when the page loads.
    pub default_specialty: String,
    /// Language the care team speaks.
    pub clinician_language: String,
    /// Language the patient speaks, pre-selected in the UI.
    pub patient_language: String,
    /// Languages offered in both pickers (ISO 639-1 codes or names).
    pub languages: Vec<String>,
    /// When to prime the recognizer with specialty vocabulary.
    pub asr_primer: AsrPrimer,
    /// Voice used to read clinician turns aloud; falls back to `[tts] voice`.
    pub clinician_voice: Option<String>,
    /// Voice used to read patient turns aloud; falls back to `[tts] voice`.
    pub patient_voice: Option<String>,
    /// Start with automatic read-aloud of each finished translation enabled.
    pub speak_translations: bool,
}

impl Default for MedicalConfig {
    fn default() -> Self {
        Self {
            default_specialty: DEFAULT_SPECIALTY.into(),
            clinician_language: "English".into(),
            patient_language: "Spanish".into(),
            languages: DEFAULT_LANGUAGES.iter().map(|l| (*l).into()).collect(),
            asr_primer: AsrPrimer::default(),
            clinician_voice: None,
            patient_voice: None,
            speak_translations: false,
        }
    }
}

/// Offered by default: the languages most often needed by interpreter
/// services in general practice, plus the app's own working language.
const DEFAULT_LANGUAGES: &[&str] = &[
    "English",
    "Spanish",
    "Chinese",
    "Cantonese",
    "Vietnamese",
    "Tagalog",
    "Korean",
    "Arabic",
    "Russian",
    "Haitian Creole",
    "Portuguese",
    "French",
    "Hindi",
    "Bengali",
    "Urdu",
    "Persian",
    "Japanese",
    "Somali",
    "Amharic",
    "Nepali",
    "Burmese",
    "Ukrainian",
    "Polish",
    "German",
    "Italian",
];

impl MedicalConfig {
    /// Normalize language values to the display names the UI compares against,
    /// and reject a `default_specialty` that does not exist rather than
    /// silently falling back at every request.
    fn normalized(mut self) -> Result<Self> {
        if specialty::find(&self.default_specialty).is_none() {
            anyhow::bail!(
                "[medical] default_specialty = {:?} is not a known specialty; valid ids: {}",
                self.default_specialty,
                specialty::SPECIALTIES
                    .iter()
                    .map(|s| s.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        self.clinician_language = normalize_language(&self.clinician_language);
        self.patient_language = normalize_language(&self.patient_language);
        if self.clinician_language.is_empty() || self.patient_language.is_empty() {
            anyhow::bail!(
                "[medical] clinician_language and patient_language must both be set to a \
                 language code or name"
            );
        }

        let mut languages: Vec<String> = Vec::new();
        // Both configured languages must be selectable even if the operator
        // trimmed the list, and the UI keys off exact names, so de-duplicate.
        for lang in self.languages.iter().map(|l| normalize_language(l)).chain([
            self.clinician_language.clone(),
            self.patient_language.clone(),
        ]) {
            if !lang.is_empty() && !languages.contains(&lang) {
                languages.push(lang);
            }
        }
        self.languages = languages;
        Ok(self)
    }

    /// Whether to prime the recognizer for an utterance whose language is
    /// `pinned` (`None` when the UI leaves detection to the recognizer).
    pub fn send_primer(&self, pinned: Option<&str>) -> bool {
        match self.asr_primer {
            AsrPrimer::Never => false,
            AsrPrimer::Always => true,
            AsrPrimer::Auto => pinned.is_some_and(|lang| normalize_language(lang) == "English"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AsrPrimer, MedicalConfig};

    fn config(toml: &str) -> anyhow::Result<MedicalConfig> {
        let root: super::FileRoot = toml::from_str(toml)?;
        root.medical.normalized()
    }

    #[test]
    fn defaults_are_usable() {
        let cfg = config("").expect("defaults normalize");
        assert_eq!(cfg.clinician_language, "English");
        assert_eq!(cfg.patient_language, "Spanish");
        assert!(cfg.languages.contains(&"Spanish".to_string()));
        assert_eq!(cfg.asr_primer, AsrPrimer::Auto);
    }

    #[test]
    fn language_codes_become_display_names() {
        let cfg = config(
            "[medical]\nclinician_language = \"en\"\npatient_language = \"vi\"\n\
             languages = [\"en\", \"vi\", \"ko\"]\n",
        )
        .unwrap();
        assert_eq!(cfg.clinician_language, "English");
        assert_eq!(cfg.patient_language, "Vietnamese");
        assert_eq!(cfg.languages, ["English", "Vietnamese", "Korean"]);
    }

    #[test]
    fn configured_languages_are_always_selectable() {
        let cfg = config(
            "[medical]\nclinician_language = \"en\"\npatient_language = \"so\"\n\
             languages = [\"en\"]\n",
        )
        .unwrap();
        assert_eq!(cfg.languages, ["English", "Somali"]);
    }

    #[test]
    fn unknown_specialty_is_a_startup_error() {
        let err = config("[medical]\ndefault_specialty = \"astrology\"\n").unwrap_err();
        assert!(err.to_string().contains("not a known specialty"));
    }

    #[test]
    fn auto_primer_only_fires_on_pinned_english() {
        let cfg = config("").unwrap();
        assert!(cfg.send_primer(Some("en")));
        assert!(cfg.send_primer(Some("English")));
        assert!(!cfg.send_primer(Some("es")));
        assert!(!cfg.send_primer(None));
    }

    #[test]
    fn primer_policy_overrides_apply() {
        let always = config("[medical]\nasr_primer = \"always\"\n").unwrap();
        assert!(always.send_primer(None));
        assert!(always.send_primer(Some("es")));

        let never = config("[medical]\nasr_primer = \"never\"\n").unwrap();
        assert!(!never.send_primer(Some("en")));
    }
}
