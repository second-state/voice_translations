//! Configuration: the upstream `[server] [audio] [asr] [llm] [tts]` sections
//! plus this app's own `[medical]` section, read from one `config.toml`.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

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
    /// Voice used to read clinician turns aloud; falls back to `[tts] voice`.
    pub clinician_voice: Option<String>,
    /// Voice used to read patient turns aloud; falls back to `[tts] voice`.
    pub patient_voice: Option<String>,
}

impl Default for MedicalConfig {
    fn default() -> Self {
        Self {
            default_specialty: DEFAULT_SPECIALTY.into(),
            clinician_language: "English".into(),
            patient_language: "Spanish".into(),
            languages: DEFAULT_LANGUAGES.iter().map(|l| (*l).into()).collect(),
            clinician_voice: None,
            patient_voice: None,
        }
    }
}

/// Offered by default: the languages most often needed by interpreter
/// services in general practice, plus the app's own working language.
/// Every entry has a clinical notes file in `prompts/targets/`
/// (enforced by tests in [`crate::lang`]).
pub const DEFAULT_LANGUAGES: &[&str] = &[
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
}

#[cfg(test)]
mod tests {
    use super::MedicalConfig;

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
}
