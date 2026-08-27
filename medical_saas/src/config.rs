//! Configuration, read from one `config.toml`.
//!
//! `[server] [audio] [asr] [llm] [tts]` belong to the `voice_translations`
//! library and `[medical]` to the `medical_translations` interpreter — both
//! are parsed by their own crates. What this file defines is only what the
//! hosted edition adds: `[auth] [email] [quota] [stripe]`.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

use medical_translations::config::MedicalConfig;

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
    pub admin: AdminConfig,
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
        let admin = root.admin.validated()?;
        Ok(Self {
            base,
            settings: Settings {
                medical,
                auth: root.auth,
                email,
                quota,
                stripe: root.stripe,
                admin,
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
    #[serde(default)]
    admin: AdminConfig,
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
            from_name: crate::BRAND.into(),
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
    /// What the landing page shows as the plan's price, e.g. `"$20 / month"`.
    /// Cosmetic only: Stripe charges what the price object says, and shows
    /// that amount at checkout. Left empty, the page says "Monthly" without
    /// naming a figure rather than risking a stale one.
    pub price_display: String,
}

impl StripeConfig {
    /// Whether subscriptions can be sold at all.
    pub fn enabled(&self) -> bool {
        !self.secret_key.trim().is_empty() && !self.price_id.trim().is_empty()
    }
}

/// The operator's dashboard at `/admin`.
///
/// One shared password rather than accounts of its own: the dashboard is for
/// whoever runs the deployment, and a second account system to administer
/// would be the thing most likely to go stale. Left empty the dashboard does
/// not exist at all — no page, no API, nothing to guess at.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct AdminConfig {
    /// Password for `/admin`. Empty disables the dashboard.
    pub password: String,
    /// How long an admin stays signed in before typing it again.
    pub session_hours: i64,
}

impl AdminConfig {
    /// Whether the dashboard is served at all.
    pub fn enabled(&self) -> bool {
        !self.password.trim().is_empty()
    }

    /// How long an admin session lasts, in seconds.
    pub fn session_secs(&self) -> i64 {
        let hours = if self.session_hours > 0 {
            self.session_hours
        } else {
            12
        };
        hours * 60 * 60
    }

    /// Short enough to be worth guessing. The dashboard lists every user's
    /// address, so this is worth saying out loud at startup.
    pub fn password_is_weak(&self) -> bool {
        self.enabled() && self.password.trim().len() < 12
    }

    fn validated(self) -> Result<Self> {
        if self.session_hours < 0 {
            anyhow::bail!("[admin] session_hours cannot be negative");
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{AdminConfig, AuthConfig, EmailConfig, FileRoot, QuotaConfig};

    fn parse(toml: &str) -> anyhow::Result<(EmailConfig, QuotaConfig, AuthConfig)> {
        let root: FileRoot = toml::from_str(toml)?;
        Ok((root.email.normalized()?, root.quota.validated()?, root.auth))
    }

    #[test]
    fn defaults_are_usable_without_any_saas_sections() {
        let (email, quota, auth) = parse("").expect("defaults validate");
        assert_eq!(quota.free_words_per_week, 1000);
        assert_eq!(auth.session_days, 30);
        assert_eq!(auth.magic_link_minutes, 60);
        assert_eq!(auth.database, "medical_saas.db");
        // No mail provider by default, so links are logged rather than sent.
        assert!(!email.sends_email());
        assert!(!email.echoes_link());
    }

    #[test]
    fn base_url_loses_its_trailing_slash() {
        // Sign-in links are built by concatenation, so a trailing slash
        // would produce https://host//verify.
        let (email, _, _) = parse("[email]\nbase_url = \"https://host/\"\n").unwrap();
        assert_eq!(email.base_url, "https://host");
    }

    #[test]
    fn empty_base_url_is_a_startup_error() {
        let err = parse("[email]\nbase_url = \"\"\n").unwrap_err();
        assert!(err.to_string().contains("base_url"));
    }

    #[test]
    fn echoing_links_from_a_real_deployment_is_refused() {
        // Handing sign-in links back over HTTP while mail actually works
        // would let anyone log in as anyone.
        let err =
            parse("[email]\nresend_api_key = \"re_live\"\ndev_echo_link = true\n").unwrap_err();
        assert!(err.to_string().contains("dev_echo_link"));

        let (email, _, _) = parse("[email]\ndev_echo_link = true\n").unwrap();
        assert!(email.echoes_link());
    }

    #[test]
    fn a_negative_allowance_is_a_startup_error() {
        let err = parse("[quota]\nfree_words_per_week = -1\n").unwrap_err();
        assert!(err.to_string().contains("negative"));
        // Zero is legitimate: it makes the service paid-only.
        assert!(parse("[quota]\nfree_words_per_week = 0\n").is_ok());
    }

    #[test]
    fn the_dashboard_is_off_until_a_password_is_set() {
        let root: FileRoot = toml::from_str("").unwrap();
        assert!(
            !root.admin.enabled(),
            "no [admin] section means no dashboard"
        );

        let root: FileRoot = toml::from_str("[admin]\npassword = \"   \"\n").unwrap();
        assert!(!root.admin.enabled(), "whitespace is not a password");

        let root: FileRoot =
            toml::from_str("[admin]\npassword = \"a-long-enough-secret\"\n").unwrap();
        assert!(root.admin.enabled());
        assert!(!root.admin.password_is_weak());
        assert_eq!(root.admin.session_secs(), 12 * 60 * 60);
    }

    #[test]
    fn a_short_admin_password_is_flagged_but_still_works() {
        let root: FileRoot = toml::from_str("[admin]\npassword = \"hunter2\"\n").unwrap();
        assert!(root.admin.enabled());
        assert!(root.admin.password_is_weak());
    }

    #[test]
    fn a_negative_admin_session_is_a_startup_error() {
        let cfg = AdminConfig {
            password: "x".into(),
            session_hours: -1,
        };
        assert!(cfg.validated().is_err());
    }

    #[test]
    fn billing_switches_off_unless_both_keys_are_present() {
        let root: FileRoot = toml::from_str("[stripe]\nsecret_key = \"sk_test\"\n").unwrap();
        assert!(!root.stripe.enabled(), "a price is required too");

        let root: FileRoot =
            toml::from_str("[stripe]\nsecret_key = \"sk_test\"\nprice_id = \"price_1\"\n").unwrap();
        assert!(root.stripe.enabled());
    }
}
