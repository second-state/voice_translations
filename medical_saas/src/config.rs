//! Configuration: the library's `[server] [audio] [asr] [llm] [tts]` sections
//! plus this app's own `[medical] [auth] [email] [quota] [stripe]` sections,
//! read from one `config.toml`.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

use voice_translations::asr::normalize_language;

use crate::specialty::{self, DEFAULT_SPECIALTY};

/// Everything loaded from `config.toml`.
pub struct AppConfig {
    /// Sections the library owns; consumed when the pipeline state is built.
    pub base: voice_translations::Config,
    /// Everything this app owns, shared with handlers behind an `Arc`.
    pub settings: Settings,
}

/// This app's own settings: the interpreter, plus what makes it a service.
#[derive(Debug)]
pub struct Settings {
    /// Interpreter settings, shared with the standalone medical app.
    pub medical: MedicalConfig,
    /// Accounts, login links, quota, and billing.
    pub auth: AuthConfig,
    pub email: EmailConfig,
    pub quota: QuotaConfig,
    pub stripe: StripeConfig,
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
        let root: FileRoot = toml::from_str(&raw).with_context(|| {
            format!(
                "failed to parse the [medical]/[auth]/[email]/[quota]/[stripe] sections in {}",
                path.display()
            )
        })?;
        let medical = root.medical.normalized()?;
        let email = root.email.normalized()?;
        let quota = root.quota.validated()?;
        Ok(Self {
            base,
            settings: Settings {
                medical,
                auth: root.auth,
                email,
                quota,
                stripe: root.stripe,
            },
        })
    }
}

/// Only the sections this app owns; every other table in the file is ignored.
#[derive(Debug, Deserialize)]
struct FileRoot {
    #[serde(default)]
    medical: MedicalConfig,
    #[serde(default)]
    auth: AuthConfig,
    #[serde(default)]
    email: EmailConfig,
    #[serde(default)]
    quota: QuotaConfig,
    #[serde(default)]
    stripe: StripeConfig,
}

/// Where accounts live and how long credentials last.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    /// SQLite file holding accounts and the word ledger. Created on first
    /// run; the parent directory must exist.
    pub database: String,
    /// How long a login link stays valid.
    pub magic_link_minutes: i64,
    /// How long a session cookie lasts before the user must click a new
    /// login link.
    pub session_days: i64,
    /// Force the `Secure` cookie attribute on or off. Left unset, it is on
    /// exactly when the request reached us over HTTPS, so local plain-HTTP
    /// development still works.
    pub secure_cookies: Option<bool>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            database: "medical_saas.db".into(),
            magic_link_minutes: 60,
            session_days: 30,
            secure_cookies: None,
        }
    }
}

/// Delivery of login links.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct EmailConfig {
    /// Public origin of this deployment, used to build the link in the
    /// email. Must be the address users actually reach, not the bind
    /// address.
    pub base_url: String,
    pub from_name: String,
    pub from_address: String,
    /// Resend API key. Empty puts login links in the server log instead of
    /// an inbox — usable for local development, useless in production.
    pub resend_api_key: String,
    /// Development only: also return the login link in the HTTP response so
    /// a browser or test can follow it without an inbox. Refused when an
    /// API key is configured, so it cannot be left on by accident in
    /// production.
    pub dev_echo_link: bool,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:8100".into(),
            from_name: "Medical Interpreter".into(),
            from_address: "login@example.com".into(),
            resend_api_key: String::new(),
            dev_echo_link: false,
        }
    }
}

impl EmailConfig {
    /// Whether login links are actually delivered to inboxes.
    pub fn sends_email(&self) -> bool {
        !self.resend_api_key.trim().is_empty()
    }

    /// Whether the link may be handed back in the HTTP response.
    pub fn echoes_link(&self) -> bool {
        self.dev_echo_link && !self.sends_email()
    }

    fn normalized(mut self) -> Result<Self> {
        self.base_url = self.base_url.trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            anyhow::bail!("[email] base_url must be set to this deployment's public URL");
        }
        if self.dev_echo_link && self.sends_email() {
            anyhow::bail!(
                "[email] dev_echo_link = true together with a resend_api_key would hand \
                 login links to anyone who can POST an address; set one or the other"
            );
        }
        Ok(self)
    }
}

/// The free plan's allowance.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct QuotaConfig {
    /// Spoken words a free account may translate in any rolling seven-day
    /// window. Both sides of the conversation draw on it.
    pub free_words_per_week: i64,
}

impl Default for QuotaConfig {
    fn default() -> Self {
        Self {
            free_words_per_week: 1000,
        }
    }
}

impl QuotaConfig {
    fn validated(self) -> Result<Self> {
        if self.free_words_per_week < 0 {
            anyhow::bail!("[quota] free_words_per_week cannot be negative");
        }
        Ok(self)
    }
}

/// Stripe subscription billing. Leave the keys empty to run without paid
/// plans: the upgrade button disappears and every account stays free.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct StripeConfig {
    /// Secret API key (`sk_...`), used to open Checkout sessions.
    pub secret_key: String,
    /// Recurring price (`price_...`) the monthly plan subscribes to.
    pub price_id: String,
    /// Signing secret (`whsec_...`) of the webhook endpoint. Without it,
    /// webhook deliveries are refused rather than trusted.
    pub webhook_secret: String,
}

impl StripeConfig {
    /// Whether subscriptions can be sold at all.
    pub fn enabled(&self) -> bool {
        !self.secret_key.trim().is_empty() && !self.price_id.trim().is_empty()
    }
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
