//! One error type for the account, quota, and billing endpoints.
//!
//! Every variant renders as JSON with a stable machine-readable `code`, so
//! the browser can tell "log in again" from "you are out of words" from
//! "something broke" without parsing prose.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    /// No session, or one that has expired.
    Unauthorized(String),
    /// The free allowance is spent; the payload carries the current standing
    /// so the UI can show what to do about it.
    QuotaExceeded(crate::quota::Quota),
    /// The request itself was malformed.
    BadRequest(String),
    /// A feature that this deployment has not configured.
    Unavailable(String),
    /// A Stripe webhook whose signature did not verify.
    WebhookVerificationFailed,
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, extra) = match self {
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "unauthorized", msg, None),
            AppError::QuotaExceeded(quota) => (
                StatusCode::PAYMENT_REQUIRED,
                "quota_exceeded",
                "This week's free word allowance is used up. Subscribe for unlimited \
                 interpreting, or wait for the rolling window to free up."
                    .to_string(),
                Some(json!(quota)),
            ),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg, None),
            AppError::Unavailable(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, "unavailable", msg, None)
            }
            AppError::WebhookVerificationFailed => (
                StatusCode::BAD_REQUEST,
                "webhook_verification_failed",
                "Stripe signature verification failed".to_string(),
                None,
            ),
            AppError::Internal(err) => {
                tracing::error!("request failed: {err:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    format!("{err:#}"),
                    None,
                )
            }
        };
        let mut body = json!({ "error": message, "code": code });
        if let (Some(extra), Some(obj)) = (extra, body.as_object_mut()) {
            obj.insert("quota".into(), extra);
        }
        (status, Json(body)).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}
