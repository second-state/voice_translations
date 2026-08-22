//! Accounts and sessions: email in, magic link out, session cookie back.
//!
//! There is no password to store, reset, or leak. A visitor types an address;
//! we mint a single-use token, mail a link containing it, and exchange that
//! link for a session cookie. Signing up and logging in are the same act —
//! the first link sent to an address creates the account it activates.
//!
//! Enumeration is deliberately not possible: requesting a link answers the
//! same way whether or not the address already has an account.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    api::SaasState,
    db::{self, User},
    error::AppError,
    quota,
};

/// Name of the session cookie. Prefixed so it cannot collide with a cookie
/// from another app sharing the domain.
pub const SESSION_COOKIE: &str = "ms_session";

/// The account behind this request, or `None` for an anonymous visitor.
pub fn current_user(state: &SaasState, headers: &HeaderMap) -> Option<User> {
    let token = session_cookie(headers)?;
    match state.db.user_by_session(&token) {
        Ok(user) => user,
        Err(err) => {
            tracing::error!("session lookup failed: {err:#}");
            None
        }
    }
}

/// The account behind this request, or a 401 telling the browser to log in.
pub fn require_user(state: &SaasState, headers: &HeaderMap) -> Result<User, AppError> {
    current_user(state, headers)
        .ok_or_else(|| AppError::Unauthorized("Log in to use the interpreter.".to_string()))
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value.to_string())
}

/// Whether the session cookie should carry `Secure` for this request: an
/// explicit setting wins, otherwise exactly when the browser reached us over
/// HTTPS (directly or through a proxy that says so), so plain-HTTP local
/// development still logs in.
fn cookies_secure(state: &SaasState, headers: &HeaderMap) -> bool {
    if let Some(explicit) = state.cfg.auth.secure_cookies {
        return explicit;
    }
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

fn session_cookie_header(token: &str, max_age_secs: i64, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax{secure_attr}; Max-Age={max_age_secs}")
}

fn cleared_cookie_header(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax{secure_attr}; Max-Age=0")
}

#[derive(Debug, Deserialize)]
pub struct LinkRequest {
    pub email: String,
}

/// POST /auth/request — mail a login link to an address, creating the
/// account if this is its first one.
pub async fn request_link(
    State(state): State<SaasState>,
    Json(req): Json<LinkRequest>,
) -> Result<Response, AppError> {
    let email = db::normalize_email(&req.email);
    if !db::is_plausible_email(&email) {
        return Err(AppError::BadRequest(
            "That does not look like an email address.".to_string(),
        ));
    }

    let user = state.db.upsert_user(&email)?;
    let token = db::generate_token();
    let expires = db::now() + state.cfg.auth.magic_link_minutes * 60;
    state.db.set_magic_token(&user.id, &token, expires)?;

    let link = format!(
        "{}/verify?token={}",
        state.cfg.email.base_url,
        urlencoding::encode(&token)
    );

    let mut body = json!({
        "ok": true,
        "sent": state.cfg.email.sends_email(),
        "email": email,
        "expires_in_minutes": state.cfg.auth.magic_link_minutes,
    });

    if state.cfg.email.sends_email() {
        send_magic_email(&state, &email, &link).await?;
    } else {
        // No mail provider configured: the link goes to the log so a local
        // deployment is still usable, and into the response only when the
        // operator explicitly turned that on.
        tracing::warn!("no [email] resend_api_key configured; login link for {email}: {link}");
        if state.cfg.email.echoes_link() {
            body["link"] = json!(link);
        }
    }

    Ok(Json(body).into_response())
}

async fn send_magic_email(state: &SaasState, email: &str, link: &str) -> Result<(), AppError> {
    let cfg = &state.cfg.email;
    let minutes = state.cfg.auth.magic_link_minutes;
    let text = format!(
        "Click the link below to sign in to the Medical Interpreter:\n\n{link}\n\n\
         The link works once and expires in {minutes} minutes.\n\n\
         If you did not ask to sign in, you can ignore this email."
    );

    let resp = state
        .http
        .post("https://api.resend.com/emails")
        .header("Authorization", format!("Bearer {}", cfg.resend_api_key))
        .json(&json!({
            "from": format!("{} <{}>", cfg.from_name, cfg.from_address),
            "to": [email],
            "subject": "Your Medical Interpreter sign-in link",
            "text": text,
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Resend request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(anyhow::anyhow!(
            "Resend returned {status}: {detail}"
        )));
    }
    tracing::info!("sent a login link to {email}");
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct VerifyQuery {
    pub token: String,
}

/// GET /verify?token=… — exchange a login link for a session cookie.
pub async fn verify(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Query(query): Query<VerifyQuery>,
) -> Result<Response, AppError> {
    let Some(user) = state.db.redeem_magic_token(&query.token)? else {
        // Expired, already used, or never existed — one message for all
        // three, since distinguishing them helps only an attacker.
        return Ok(Redirect::to("/login?error=link").into_response());
    };

    let token = db::generate_token();
    let max_age = state.cfg.auth.session_days * 24 * 60 * 60;
    state
        .db
        .set_session(&user.id, &token, db::now() + max_age)?;

    tracing::info!("session started for {}", user.email);
    let cookie = session_cookie_header(&token, max_age, cookies_secure(&state, &headers));
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, cookie),
            (header::LOCATION, "/app".into()),
        ],
    )
        .into_response())
}

/// POST /auth/logout — end the session on this device.
pub async fn logout(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    if let Some(user) = current_user(&state, &headers) {
        state.db.clear_session(&user.id)?;
    }
    let cookie = cleared_cookie_header(cookies_secure(&state, &headers));
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

/// GET /api/me — who is signed in, what they may use, and whether this
/// deployment sells subscriptions. The UI polls this to render the account
/// bar, so it answers for anonymous visitors too.
pub async fn me(State(state): State<SaasState>, headers: HeaderMap) -> Result<Response, AppError> {
    let Some(user) = current_user(&state, &headers) else {
        return Ok(Json(json!({ "authenticated": false })).into_response());
    };
    let quota = quota::current(&state.db, &user, state.cfg.quota.free_words_per_week)?;
    Ok(Json(json!({
        "authenticated": true,
        "user": user,
        "quota": quota,
        "billing_enabled": state.cfg.stripe.enabled(),
    }))
    .into_response())
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
    fn session_cookie_is_found_among_others() {
        let h = headers_with("theme=dark; ms_session=abc123; other=1");
        assert_eq!(session_cookie(&h).as_deref(), Some("abc123"));

        let h = headers_with("ms_session=solo");
        assert_eq!(session_cookie(&h).as_deref(), Some("solo"));

        // A cookie whose name merely ends in ours must not match.
        let h = headers_with("not_ms_session=nope");
        assert_eq!(session_cookie(&h), None);
        assert_eq!(session_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn cookie_attributes_lock_the_session_down() {
        let secure = session_cookie_header("tok", 3600, true);
        assert!(secure.contains("HttpOnly"));
        assert!(secure.contains("SameSite=Lax"));
        assert!(secure.contains("; Secure"));
        assert!(secure.contains("Max-Age=3600"));

        // Plain HTTP (local development) omits Secure, or the browser would
        // discard the cookie and login would silently never work.
        let plain = session_cookie_header("tok", 3600, false);
        assert!(!plain.contains("Secure"));

        assert!(cleared_cookie_header(true).contains("Max-Age=0"));
    }
}
