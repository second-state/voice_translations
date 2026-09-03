//! The hosted-service layer: everything that turns a translator into a
//! service with accounts, and nothing about what it translates.
//!
//! Two apps in this workspace run a translator as a service — the medical
//! one and the conference one — and they need exactly the same things around
//! it: accounts in an embedded SQLite database, passwordless sign-in by
//! emailed magic link, a rolling weekly word allowance on the free plan,
//! Stripe subscriptions for unlimited use, and an operator's dashboard behind
//! one password. That layer lives here once. Each app keeps only its own
//! domain (from its `*_translations` crate) and its own UI.
//!
//! An app holds one [`SaasState`] inside its own state and makes it reachable
//! with [`axum::extract::FromRef`]; every handler here takes
//! `State<SaasState>`, so [`routes`] mounts straight onto the app's router:
//!
//! ```no_run
//! use axum::{extract::FromRef, Router};
//! use saas_core::{SaasConfig, SaasState};
//!
//! #[derive(Clone)]
//! struct HostedState {
//!     saas: SaasState,
//!     // ...the pipeline, the domain settings...
//! }
//!
//! impl FromRef<HostedState> for SaasState {
//!     fn from_ref(state: &HostedState) -> SaasState {
//!         state.saas.clone()
//!     }
//! }
//!
//! # fn build(state: HostedState) -> Router {
//! Router::new()
//!     .merge(saas_core::routes())
//!     // ...the app's own pages and API...
//!     .with_state(state)
//! # }
//! ```
//!
//! The one thing the layer needs from the app is a name — what the sign-in
//! email and the dashboard call the product — since the browser gets its own,
//! translated, from the app's interface catalogue.

pub mod admin;
pub mod auth;
pub mod billing;
pub mod config;
pub mod db;
pub mod error;
pub mod migrations;
pub mod quota;
pub mod state;

use axum::{
    extract::FromRef,
    routing::{get, post},
    Router,
};

pub use config::SaasConfig;
pub use error::AppError;
pub use state::SaasState;

/// Every route the service layer owns, ready to merge into an app's router.
///
/// Accounts, billing, and the dashboard. The app adds its own pages and its
/// domain API — transcribe, translate, speak — around these; see the crate
/// docs for the state wiring that makes the two share one router.
pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    SaasState: FromRef<S>,
{
    Router::new()
        // Accounts. A sign-in link is redeemed in two steps split by side
        // effect: GET /verify only reads the token and renders a confirmation
        // (mail scanners fetch links before people do), and POST
        // /verify/confirm is the one request that consumes it. Distinct
        // paths, so "nothing under GET /verify mutates" is checkable by grep.
        .route("/auth/request", post(auth::request_link))
        .route("/verify", get(auth::verify_page))
        .route("/verify/confirm", post(auth::verify_confirm))
        .route("/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        // Billing: the browser may start a checkout, but only Stripe's
        // signed webhook ever changes a plan.
        .route("/api/billing/checkout", post(billing::checkout))
        .route("/api/billing/portal", post(billing::portal))
        .route("/stripe/webhook", post(billing::webhook))
        // The operator's dashboard, gated by one password from config.toml.
        // Every route 404s when none is set.
        .route("/admin", get(admin::page))
        .route("/admin.js", get(admin::script))
        .route("/admin/login", post(admin::login))
        .route("/admin/logout", post(admin::logout))
        .route("/api/admin/session", get(admin::session))
        .route("/api/admin/users", get(admin::users))
        .route("/api/admin/users/{id}/payments", get(admin::payments))
        .route("/api/admin/users/{id}/plan", post(admin::set_plan))
        .route(
            "/api/admin/users/{id}/cancel_subscription",
            post(admin::cancel_subscription),
        )
}

/// Say at startup what the service is configured to do, and warn about the
/// settings that silently make it useless: no mail provider, no billing, a
/// billing endpoint that will refuse every delivery, a guessable dashboard
/// password.
pub fn report_configuration(cfg: &SaasConfig) {
    if !cfg.email.sends_email() {
        tracing::warn!(
            "[email] resend_api_key is empty: sign-in links will be written to this log \
             instead of delivered{}",
            if cfg.email.echoes_link() {
                " and returned in the HTTP response (dev_echo_link)"
            } else {
                ""
            }
        );
    }
    if cfg.admin.enabled() {
        tracing::info!(
            "admin dashboard at /admin (sessions last {} hours)",
            cfg.admin.session_secs() / 3600
        );
        if cfg.admin.password_is_weak() {
            tracing::warn!(
                "[admin] password is under 12 characters. It is the only thing between the \
                 internet and every user's email address; make it long."
            );
        }
    }
    if !cfg.stripe.enabled() {
        tracing::warn!(
            "[stripe] is not configured: every account stays on the free plan and the \
             upgrade button is hidden"
        );
    } else if cfg.stripe.webhook_secret.trim().is_empty() {
        tracing::warn!(
            "[stripe] webhook_secret is empty: subscription webhooks will be refused, so \
             paid accounts would never be activated"
        );
    }
}
