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

/// How one turn's language was resolved to one of the encounter's two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnLanguage {
    /// The language to treat the turn as being in. Always one of the two
    /// configured languages.
    pub language: String,
    /// Whether this is the care team's side of the conversation.
    pub clinician: bool,
    /// True when the recognizer named a language outside the encounter and
    /// the patient's language was substituted for it.
    pub substituted: bool,
}

impl MedicalConfig {
    /// Decide what language a turn is in, given what the recognizer thinks
    /// it heard.
    ///
    /// An encounter has exactly two languages, so a label outside that pair
    /// is noise rather than information. Recognizers confuse languages that
    /// share a script — Chinese reported as Japanese is the common one, and
    /// Han characters are why — and taking that label at face value does
    /// real damage: the turn is interpreted toward the wrong side, and the
    /// same-language cleanup pass, told the transcript is Japanese, quietly
    /// *translates* the Chinese it was given.
    ///
    /// So an unrecognized label is treated as the patient speaking their own
    /// language. Between the two possible readings that is the safe one: an
    /// unexpected language in a clinical encounter is far more likely to be
    /// the patient than the care team, and it keeps the turn flowing toward
    /// the clinician, who can see it was substituted and correct the turn if
    /// it was wrong.
    ///
    /// A recognizer that reports nothing at all is a different case — no
    /// claim rather than a wrong one — and falls back to the clinician's
    /// language, as this app has always done.
    pub fn resolve_turn_language(&self, detected: Option<&str>) -> TurnLanguage {
        let clinician = TurnLanguage {
            language: self.clinician_language.clone(),
            clinician: true,
            substituted: false,
        };
        let Some(detected) = detected.map(str::trim).filter(|d| !d.is_empty()) else {
            return clinician;
        };
        if detected.eq_ignore_ascii_case(&self.clinician_language) {
            return clinician;
        }
        TurnLanguage {
            language: self.patient_language.clone(),
            clinician: false,
            substituted: !detected.eq_ignore_ascii_case(&self.patient_language),
        }
    }

    /// Normalize language values to the display names the UI compares against,
    /// and reject a `default_specialty` that does not exist rather than
    /// silently falling back at every request.
    pub fn normalized(mut self) -> Result<Self> {
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
    fn a_turn_in_either_configured_language_is_taken_at_face_value() {
        let cfg =
            config("[medical]\nclinician_language = \"en\"\npatient_language = \"zh\"\n").unwrap();

        let heard = cfg.resolve_turn_language(Some("English"));
        assert_eq!(heard.language, "English");
        assert!(heard.clinician && !heard.substituted);

        let heard = cfg.resolve_turn_language(Some("Chinese"));
        assert_eq!(heard.language, "Chinese");
        assert!(!heard.clinician && !heard.substituted);
    }

    #[test]
    fn a_language_outside_the_encounter_becomes_the_patients() {
        let cfg =
            config("[medical]\nclinician_language = \"en\"\npatient_language = \"zh\"\n").unwrap();

        // The motivating case: Chinese speech transcribed correctly but
        // labelled Japanese. Taking the label would interpret the turn into
        // Japanese; substituting keeps it Chinese and flags the swap.
        let heard = cfg.resolve_turn_language(Some("Japanese"));
        assert_eq!(heard.language, "Chinese");
        assert!(!heard.clinician);
        assert!(heard.substituted);

        // Anything else unexpected lands the same way.
        assert_eq!(
            cfg.resolve_turn_language(Some("Korean")).language,
            "Chinese"
        );
    }

    #[test]
    fn silence_from_the_recognizer_falls_back_to_the_care_team() {
        let cfg =
            config("[medical]\nclinician_language = \"en\"\npatient_language = \"zh\"\n").unwrap();
        // No claim is not a wrong claim, so nothing is flagged.
        for nothing in [None, Some(""), Some("   ")] {
            let heard = cfg.resolve_turn_language(nothing);
            assert_eq!(heard.language, "English");
            assert!(heard.clinician && !heard.substituted);
        }
    }

    #[test]
    fn unknown_specialty_is_a_startup_error() {
        let err = config("[medical]\ndefault_specialty = \"astrology\"\n").unwrap_err();
        assert!(err.to_string().contains("not a known specialty"));
    }
}
