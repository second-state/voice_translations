//! The operator's dashboard: who has signed up, who is paying, and how much
//! they are speaking.
//!
//! It is gated by one password from `config.toml`, not by an account system
//! of its own. With no password configured the dashboard does not exist:
//! every route here answers 404, so a deployment that never wanted it is not
//! quietly running a login form over its user list.
//!
//! The password buys a session cookie rather than being re-sent with each
//! request, and the session carries a hash of the password it was opened
//! with — so rotating a leaked password in the configuration ends the
//! sessions it opened.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{db, error::AppError, quota, state::SaasState};

/// Name of the admin session cookie, kept apart from the user session so
/// signing out of one does nothing to the other.
pub const ADMIN_COOKIE: &str = "ms_admin";

/// Accounts returned in one page of the dashboard. Far above any plausible
/// user count for this kind of deployment, and a bound rather than an
/// unbounded read of the table.
const MAX_ROWS: i64 = 5_000;

/// Billing events shown for one account. A monthly subscription generates a
/// handful a year; this is a bound, not a page size anyone will reach.
const MAX_EVENTS: i64 = 500;

/// How long a wrong password takes to be told it is wrong. Guessing is a
/// remote attack against one shared secret, so the cost per attempt is what
/// makes it impractical; the delay is fixed rather than escalating, which
/// would let anyone lock the operator out by guessing badly on purpose.
const WRONG_PASSWORD_DELAY: Duration = Duration::from_millis(600);

/// The configured password, hashed. Sessions are stamped with this so a
/// changed password invalidates them.
fn password_hash(state: &SaasState) -> String {
    db::hash_token(state.cfg.admin.password.trim())
}

/// 404 unless this deployment configured a dashboard password.
fn require_enabled(state: &SaasState) -> Result<(), AppError> {
    if state.cfg.admin.enabled() {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "No admin dashboard is configured on this deployment.".to_string(),
        ))
    }
}

fn admin_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == ADMIN_COOKIE)
        .map(|(_, value)| value.to_string())
}

/// Whether this request carries a live admin session.
fn signed_in(state: &SaasState, headers: &HeaderMap) -> bool {
    let Some(token) = admin_cookie(headers) else {
        return false;
    };
    match state.db.admin_session_valid(&token, &password_hash(state)) {
        Ok(valid) => valid,
        Err(err) => {
            tracing::error!("admin session lookup failed: {err:#}");
            false
        }
    }
}

/// Refuse anything but a signed-in admin on an enabled deployment.
fn require_admin(state: &SaasState, headers: &HeaderMap) -> Result<(), AppError> {
    require_enabled(state)?;
    if signed_in(state, headers) {
        Ok(())
    } else {
        Err(AppError::Unauthorized(
            "Sign in to the dashboard.".to_string(),
        ))
    }
}

/// Mirrors the user session's rule: an explicit setting wins, otherwise
/// `Secure` exactly when the browser reached us over HTTPS.
fn cookies_secure(state: &SaasState, headers: &HeaderMap) -> bool {
    if let Some(explicit) = state.cfg.auth.secure_cookies {
        return explicit;
    }
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

fn cookie_header(token: &str, max_age_secs: i64, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{ADMIN_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax{secure_attr}; \
         Max-Age={max_age_secs}"
    )
}

fn cleared_cookie_header(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax{secure_attr}; Max-Age=0")
}

/// Compare without letting the time taken reveal how much of the password
/// was right.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// GET /admin — the dashboard page. Public HTML, like the console: it renders
/// a password form and asks the API below what it may show.
pub async fn page(State(state): State<SaasState>) -> Response {
    if !state.cfg.admin.enabled() {
        return not_configured();
    }
    // The page is shared by every app built on this crate; the one thing
    // that differs between them is what the product is called.
    Html(include_str!("../static/admin.html").replace("{{brand}}", state.brand)).into_response()
}

/// GET /admin.js
pub async fn script(State(state): State<SaasState>) -> Response {
    if !state.cfg.admin.enabled() {
        return not_configured();
    }
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../static/admin.js"),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

/// POST /admin/login — exchange the password for a session cookie.
pub async fn login(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Response, AppError> {
    require_enabled(&state)?;

    if !constant_time_eq(req.password.trim(), state.cfg.admin.password.trim()) {
        tokio::time::sleep(WRONG_PASSWORD_DELAY).await;
        tracing::warn!("admin dashboard: wrong password");
        return Err(AppError::Unauthorized("Wrong password.".to_string()));
    }

    let token = db::generate_token();
    let max_age = state.cfg.admin.session_secs();
    state
        .db
        .set_admin_session(&token, &password_hash(&state), db::now() + max_age)?;

    tracing::info!("admin dashboard: signed in");
    let cookie = cookie_header(&token, max_age, cookies_secure(&state, &headers));
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

/// POST /admin/logout
pub async fn logout(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    require_enabled(&state)?;
    if let Some(token) = admin_cookie(&headers) {
        state.db.clear_admin_session(&token)?;
    }
    let cookie = cleared_cookie_header(cookies_secure(&state, &headers));
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

/// GET /api/admin/session — whether this browser is signed in, so the page
/// knows whether to draw the form or the table.
pub async fn session(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    require_enabled(&state)?;
    Ok(Json(json!({ "authenticated": signed_in(&state, &headers) })).into_response())
}

/// GET /api/admin/users — every account with the numbers behind it.
///
/// The whole list is returned in one response and the page sorts and filters
/// it in the browser: at this size that is one query rather than one per
/// keystroke, and the operator gets instant sorting.
pub async fn users(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    require_admin(&state, &headers)?;

    let rows = state.db.admin_user_rows(quota::WINDOW_SECS, MAX_ROWS)?;
    let total = state.db.user_count()?;
    let events = state.db.payment_event_counts()?;

    let mut users = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut value = serde_json::to_value(row)?;
        if let Some(obj) = value.as_object_mut() {
            // Derived rather than stored: an account can be signed in without
            // speaking, and a long visit leaves no page loads behind.
            obj.insert("last_active".into(), json!(row.last_active()));
            // Just the count, so the table can say which rows have a billing
            // history worth opening without carrying every event.
            obj.insert(
                "payment_events".into(),
                json!(events.get(&row.id).copied().unwrap_or(0)),
            );
        }
        users.push(value);
    }

    Ok(Json(json!({
        "users": users,
        "total": total,
        "shown": rows.len(),
        "truncated": total > rows.len() as i64,
        "window_secs": quota::WINDOW_SECS,
        "free_words_per_week": state.cfg.quota.free_words_per_week,
        "billing_enabled": state.cfg.stripe.enabled(),
        "generated_at": db::now(),
    }))
    .into_response())
}

/// GET /api/admin/users/{id}/payments — one account's billing history.
///
/// Fetched when a row is opened rather than with the list: most accounts have
/// none, and the ones that do are read one at a time.
pub async fn payments(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Result<Response, AppError> {
    require_admin(&state, &headers)?;

    let Some(user) = state.db.user_by_id(&user_id)? else {
        return Err(AppError::NotFound("No such account.".to_string()));
    };
    let events = state.db.payment_events_for_user(&user.id, MAX_EVENTS)?;

    Ok(Json(json!({
        "user": { "id": user.id, "email": user.email },
        "events": events,
        "stripe_customer_id": user.stripe_customer_id,
        "stripe_subscription_id": user.stripe_subscription_id,
    }))
    .into_response())
}

/// A dashboard that was never configured is simply not there, and says so
/// the way any missing page would rather than in the API's JSON.
fn not_configured() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(cookie: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        h
    }

    #[test]
    fn the_admin_cookie_is_picked_out_of_the_jar() {
        let h = headers_with("other=1; ms_admin=abc123; ms_session=zzz");
        assert_eq!(admin_cookie(&h).as_deref(), Some("abc123"));

        // The user's session cookie is not mistaken for the admin's.
        let h = headers_with("ms_session=zzz");
        assert_eq!(admin_cookie(&h), None);
        assert_eq!(admin_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn the_admin_cookie_locks_down_like_the_user_session() {
        let secure = cookie_header("tok", 3600, true);
        assert!(secure.contains("HttpOnly"));
        assert!(secure.contains("SameSite=Lax"));
        assert!(secure.contains("; Secure"));
        assert!(secure.contains("Max-Age=3600"));

        assert!(!cookie_header("tok", 3600, false).contains("Secure"));
        assert!(cleared_cookie_header(true).contains("Max-Age=0"));
    }

    #[test]
    fn passwords_compare_in_constant_time() {
        assert!(constant_time_eq("a-long-secret", "a-long-secret"));
        assert!(!constant_time_eq("a-long-secret", "a-long-secreT"));
        assert!(!constant_time_eq("short", "a-long-secret"));
        assert!(constant_time_eq("", ""));
    }
}
