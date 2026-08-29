//! What every handler in this crate needs, held once inside the app's own
//! state.

use std::sync::Arc;

use anyhow::{Context, Result};

use crate::{
    config::SaasConfig,
    db::{Db, User},
    error::AppError,
    quota::{self, Quota},
};

/// The service layer's settings, the account database, and the HTTP client
/// the email and Stripe calls share.
#[derive(Clone)]
pub struct SaasState {
    pub cfg: Arc<SaasConfig>,
    pub db: Db,
    pub http: reqwest::Client,
    /// The product name, as a person reading an email from us sees it.
    ///
    /// The browser gets its own name from the app's interface catalogue,
    /// translated per language; this is the English one the server sends
    /// out and the dashboard is titled with. It comes from the app, since it
    /// is the one thing about the product this crate cannot know.
    pub brand: &'static str,
}

impl SaasState {
    /// Open (creating if needed) the account database named in the
    /// configuration and migrate it, then assemble the state around it.
    ///
    /// `http` is the app's client, so Resend and Stripe reuse the pipeline's
    /// connection pool rather than opening a second one.
    pub fn open(cfg: SaasConfig, http: reqwest::Client, brand: &'static str) -> Result<Self> {
        let db = Db::open(&cfg.auth.database)
            .with_context(|| format!("could not open [auth] database {}", cfg.auth.database))?;
        tracing::info!(
            "accounts stored in {}",
            std::fs::canonicalize(&cfg.auth.database)
                .unwrap_or_else(|_| cfg.auth.database.clone().into())
                .display()
        );
        Ok(Self {
            cfg: Arc::new(cfg),
            db,
            http,
            brand,
        })
    }

    /// The signed-in account's current standing.
    pub fn quota_for(&self, user: &User) -> Result<Quota, AppError> {
        Ok(quota::current(
            &self.db,
            user,
            self.cfg.quota.free_words_per_week,
        )?)
    }

    /// Refuse the turn when a free account has spent its allowance. An app
    /// checks this before every billable step, so a client that ignores the
    /// 402 on one endpoint cannot simply call the next one.
    pub fn enforce_quota(&self, user: &User) -> Result<Quota, AppError> {
        let quota = self.quota_for(user)?;
        if quota.allows_more() {
            Ok(quota)
        } else {
            Err(AppError::QuotaExceeded(quota))
        }
    }
}
