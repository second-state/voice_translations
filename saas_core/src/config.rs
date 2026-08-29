//! The service layer's own sections of `config.toml`: `[auth] [email] [quota]
//! [stripe] [admin]`.
//!
//! An app's configuration file also carries the pipeline's sections and its
//! domain section; those are parsed by the crates that own them. This parser
//! reads the same file and ignores every table it does not know, so no crate
//! has to know about another's settings.

use anyhow::{Context, Result};
use serde::Deserialize;

/// Everything the hosted-service layer is configured by.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SaasConfig {
    pub auth: AuthConfig,
    pub email: EmailConfig,
    pub quota: QuotaConfig,
    pub stripe: StripeConfig,
    pub admin: AdminConfig,
}

impl SaasConfig {
    /// Parse the service sections out of a whole `config.toml`, validating
    /// them. `brand` fills in the sign-in email's sender name when the file
    /// does not set one.
    pub fn parse(raw: &str, brand: &str) -> Result<Self> {
        let cfg: Self = toml::from_str(raw)
            .context("failed to parse the [auth]/[email]/[quota]/[stripe]/[admin] sections")?;
        Ok(Self {
            auth: cfg.auth,
            email: cfg.email.normalized(brand)?,
            quota: cfg.quota.validated()?,
            stripe: cfg.stripe,
            admin: cfg.admin.validated()?,
        })
    }
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
            database: "accounts.db".into(),
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
    /// Sender name. Left empty, the product name is used.
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
            from_name: String::new(),
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

    fn normalized(mut self, brand: &str) -> Result<Self> {
        self.base_url = self.base_url.trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            anyhow::bail!("[email] base_url must be set to this deployment's public URL");
        }
        if self.from_name.trim().is_empty() {
            self.from_name = brand.to_string();
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
    /// window. Everyone who speaks draws on it.
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
    /// that amount at checkout. Left empty, the page prints its own default.
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
    use super::{AdminConfig, SaasConfig};

    const BRAND: &str = "Test Translator";

    fn parse(toml: &str) -> anyhow::Result<SaasConfig> {
        SaasConfig::parse(toml, BRAND)
    }

    #[test]
    fn defaults_are_usable_without_any_saas_sections() {
        let cfg = parse("").expect("defaults validate");
        assert_eq!(cfg.quota.free_words_per_week, 1000);
        assert_eq!(cfg.auth.session_days, 30);
        assert_eq!(cfg.auth.magic_link_minutes, 60);
        assert_eq!(cfg.auth.database, "accounts.db");
        // No mail provider by default, so links are logged rather than sent.
        assert!(!cfg.email.sends_email());
        assert!(!cfg.email.echoes_link());
        assert!(!cfg.stripe.enabled());
        assert!(!cfg.admin.enabled());
    }

    #[test]
    fn other_sections_in_the_file_are_ignored() {
        // The pipeline's and the domain's tables live in the same file.
        let cfg = parse(
            "[server]\nport = 1\n[medical]\ndefault_specialty = \"x\"\n[conference]\n\
             default_type = \"tech\"\n[quota]\nfree_words_per_week = 5\n",
        )
        .unwrap();
        assert_eq!(cfg.quota.free_words_per_week, 5);
    }

    #[test]
    fn the_sender_name_defaults_to_the_brand() {
        let cfg = parse("").unwrap();
        assert_eq!(cfg.email.from_name, BRAND);
        let cfg = parse("[email]\nfrom_name = \"Front Desk\"\n").unwrap();
        assert_eq!(cfg.email.from_name, "Front Desk");
        let cfg = parse("[email]\nfrom_name = \"   \"\n").unwrap();
        assert_eq!(cfg.email.from_name, BRAND, "whitespace is not a name");
    }

    #[test]
    fn base_url_loses_its_trailing_slash() {
        // Sign-in links are built by concatenation, so a trailing slash
        // would produce https://host//verify.
        let cfg = parse("[email]\nbase_url = \"https://host/\"\n").unwrap();
        assert_eq!(cfg.email.base_url, "https://host");
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

        let cfg = parse("[email]\ndev_echo_link = true\n").unwrap();
        assert!(cfg.email.echoes_link());
    }

    #[test]
    fn a_negative_allowance_is_a_startup_error() {
        let err = parse("[quota]\nfree_words_per_week = -1\n").unwrap_err();
        assert!(err.to_string().contains("negative"));
        // Zero is legitimate: it makes the service paid-only.
        assert!(parse("[quota]\nfree_words_per_week = 0\n").is_ok());
    }

    #[test]
    fn billing_switches_off_unless_both_keys_are_present() {
        let cfg = parse("[stripe]\nsecret_key = \"sk_test\"\n").unwrap();
        assert!(!cfg.stripe.enabled(), "a price is required too");

        let cfg = parse("[stripe]\nsecret_key = \"sk_test\"\nprice_id = \"price_1\"\n").unwrap();
        assert!(cfg.stripe.enabled());
    }

    #[test]
    fn the_dashboard_is_off_until_a_password_is_set() {
        let cfg = parse("").unwrap();
        assert!(
            !cfg.admin.enabled(),
            "no [admin] section means no dashboard"
        );

        let cfg = parse("[admin]\npassword = \"   \"\n").unwrap();
        assert!(!cfg.admin.enabled(), "whitespace is not a password");

        let cfg = parse("[admin]\npassword = \"a-long-enough-secret\"\n").unwrap();
        assert!(cfg.admin.enabled());
        assert!(!cfg.admin.password_is_weak());
        assert_eq!(cfg.admin.session_secs(), 12 * 60 * 60);
    }

    #[test]
    fn a_short_admin_password_is_flagged_but_still_works() {
        let cfg = parse("[admin]\npassword = \"hunter2\"\n").unwrap();
        assert!(cfg.admin.enabled());
        assert!(cfg.admin.password_is_weak());
    }

    #[test]
    fn a_negative_admin_session_is_a_startup_error() {
        let cfg = AdminConfig {
            password: "x".into(),
            session_hours: -1,
        };
        assert!(cfg.validated().is_err());
    }
}
