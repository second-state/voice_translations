//! Medical Translator (hosted edition) — the two-way patient/clinician
//! translator of `medical_translations`, run as a service.
//!
//! Two dependencies carry everything this app does not invent: the speech
//! pipeline (browser-side Silero VAD, ASR, streaming LLM translation, TTS)
//! is the `voice_translations` library, and the medical domain —
//! specialties, interpreting rules, per-language clinical notes, and the
//! prompt files behind them — is the `medical_translations` crate. Neither
//! is copied here.
//!
//! What this edition adds is only the service around them: accounts in an
//! embedded SQLite database, passwordless sign-in by emailed magic link, a
//! rolling weekly word allowance on the free plan, Stripe subscriptions for
//! unlimited use, and the UI for all of it.

/// The product name, as a person reading an email from us sees it.
///
/// The browser gets its own name from the interface catalogue, translated per
/// language; this is the English one the server sends out. Keeping it in a
/// single place is what stops a rename from reaching the pages and leaving
/// the sign-in email still using the old name.
pub const BRAND: &str = "Medical Translator";

mod admin;
mod api;
mod auth;
mod billing;
mod config;
mod db;
mod error;
mod migrations;
mod quota;

use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::header,
    middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Router,
};

use voice_translations::{
    assets,
    cli::{Cli, CliSpec},
    AppState,
};

use medical_translations::specialty;

use crate::{api::SaasState, config::AppConfig, db::Db};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "medical_saas=info,voice_translations=info".into()),
        )
        .init();

    let Some(cli) = Cli::parse(&CliSpec {
        app: "medical-saas",
        version: env!("CARGO_PKG_VERSION"),
        about: "Hosted medical translation with accounts, quotas, and subscriptions.",
        env_var: "MEDICAL_SAAS_CONFIG",
        default_config: "config.toml",
    })?
    else {
        return Ok(()); // --help or --version
    };

    // Every app in the workspace defaults to `config.toml`, so the resolved
    // absolute path is logged: running one from another's directory would
    // otherwise load the wrong file silently.
    tracing::info!(
        "loading configuration from {}",
        std::fs::canonicalize(&cli.config)
            .unwrap_or_else(|_| cli.config.clone())
            .display()
    );
    let cfg = AppConfig::load(&cli.config)?;
    let addr = cfg.base.listen_addr()?;
    let settings = Arc::new(cfg.settings);

    let db = Db::open(&settings.auth.database)?;
    tracing::info!(
        "accounts stored in {}",
        std::fs::canonicalize(&settings.auth.database)
            .unwrap_or_else(|_| settings.auth.database.clone().into())
            .display()
    );

    if !settings.email.sends_email() {
        tracing::warn!(
            "[email] resend_api_key is empty: sign-in links will be written to this log \
             instead of delivered{}",
            if settings.email.echoes_link() {
                " and returned in the HTTP response (dev_echo_link)"
            } else {
                ""
            }
        );
    }
    if settings.admin.enabled() {
        tracing::info!(
            "admin dashboard at /admin (sessions last {} hours)",
            settings.admin.session_secs() / 3600
        );
        if settings.admin.password_is_weak() {
            tracing::warn!(
                "[admin] password is under 12 characters. It is the only thing between the \
                 internet and every user's email address; make it long."
            );
        }
    }
    if !settings.stripe.enabled() {
        tracing::warn!(
            "[stripe] is not configured: every account stays on the free plan and the \
             upgrade button is hidden"
        );
    } else if settings.stripe.webhook_secret.trim().is_empty() {
        tracing::warn!(
            "[stripe] webhook_secret is empty: subscription webhooks will be refused, so \
             paid accounts would never be activated"
        );
    }

    let base = AppState::new(cfg.base);
    let state = SaasState {
        // Resend and Stripe reuse the pipeline's client and its connection
        // pool rather than opening a second one.
        http: base.http.clone(),
        base,
        cfg: Arc::clone(&settings),
        db,
    };

    tracing::info!(
        specialties = specialty::SPECIALTIES.len(),
        default = %settings.medical.default_specialty,
        clinician = %settings.medical.clinician_language,
        patient = %settings.medical.patient_language,
        free_words_per_week = settings.quota.free_words_per_week,
        billing = settings.stripe.enabled(),
        "hosted medical translator ready"
    );

    let app = Router::new()
        // Pages: a public landing page at the root, the interpreter itself
        // behind /app, and the sign-in page between them.
        .route("/", get(home_page))
        .route("/app", get(app_page))
        .route("/login", get(login_page))
        .route("/app.js", get(app_js))
        // Interface strings, shared by all three pages.
        .route("/i18n.js", get(i18n_js))
        .route("/style.css", get(style_css))
        .route("/home.css", get(home_css))
        // The operator's dashboard, gated by one password from config.toml.
        // Every route 404s when none is set.
        .route("/admin", get(admin::page))
        .route("/admin.js", get(admin::script))
        .route("/admin/login", post(admin::login))
        .route("/admin/logout", post(admin::logout))
        .route("/api/admin/session", get(admin::session))
        .route("/api/admin/users", get(admin::users))
        .route("/api/admin/users/{id}/payments", get(admin::payments))
        // Accounts
        .route("/auth/request", post(auth::request_link))
        .route("/verify", get(auth::verify))
        .route("/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        // Billing: the browser may start a checkout, but only Stripe's
        // signed webhook ever changes a plan.
        .route("/api/billing/checkout", post(billing::checkout))
        .route("/api/billing/portal", post(billing::portal))
        .route("/stripe/webhook", post(billing::webhook))
        // The interpreter itself
        .route("/api/config", get(api::api_config))
        .route("/api/transcribe", post(api::api_transcribe))
        .route("/api/translate", post(api::api_translate))
        .route("/api/tts", post(api::api_tts))
        // Silero VAD + onnxruntime-web, compiled into this binary by the
        // library crate's `embed-assets` feature.
        .nest("/vendor", assets::vendor_router())
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        // Microphone access requires HTTPS, so a plain-HTTP tunnel URL would
        // load the page and then silently have no microphone API.
        .layer(middleware::from_fn(voice_translations::force_https))
        .with_state(state);

    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// The public landing page: what the service does and what the two plans
/// cost. Reachable signed out, and links straight into the app when a
/// session is found.
async fn home_page() -> Html<&'static str> {
    Html(include_str!("../static/home.html"))
}

/// The interpreter console. The page itself is public; its scripts send an
/// unauthenticated visitor to the sign-in page, and every API it calls
/// requires a session regardless.
async fn app_page() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

async fn login_page() -> Html<&'static str> {
    Html(include_str!("../static/login.html"))
}

async fn i18n_js() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../static/i18n.js"),
    )
}

async fn app_js() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../static/app.js"),
    )
}

async fn style_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/style.css"),
    )
}

async fn home_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/home.css"),
    )
}
