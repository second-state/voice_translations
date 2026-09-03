//! Accounts and sessions: email in, magic link out, session cookie back.
//!
//! There is no password to store, reset, or leak. A visitor types an address;
//! we mint a single-use token, mail a link containing it, and exchange that
//! link for a session cookie. Signing up and logging in are the same act —
//! the first link sent to an address creates the account it activates.
//!
//! Redeeming the link takes two requests, split by side effect. `GET /verify`
//! reads the token and renders a confirmation page naming the account; it
//! creates no session, sets no cookie, and does not touch the token. The
//! page's one button posts to `POST /verify/confirm`, which is the only place
//! a token is consumed and a session begun. The split exists because mail
//! security scanners (Safe Links, URL Defense, and their kind) fetch every
//! link in a message before the recipient sees it: a GET that consumed the
//! token would be consumed by the scanner, and the person would open a dead
//! link. Making links reusable instead would weaken every link for every
//! user to accommodate some mailboxes, so links stay strictly single-use.
//! The two paths are distinct URLs rather than two methods on one URL so
//! that "nothing under `GET /verify` ever mutates" is checkable by grep, and
//! so proxies and WAF rules can key on the path.
//!
//! Enumeration is deliberately not possible: requesting a link answers the
//! same way whether or not the address already has an account.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    Form, Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    db::{self, MagicLookup, User},
    error::AppError,
    quota,
    state::SaasState,
};

/// Name of the session cookie. Prefixed so it cannot collide with a cookie
/// from another app sharing the domain.
pub const SESSION_COOKIE: &str = "ms_session";

/// The account behind this request, or `None` for an anonymous visitor.
pub fn current_user(state: &SaasState, headers: &HeaderMap) -> Option<User> {
    let token = session_cookie(headers)?;
    let user = match state.db.user_by_session(&token) {
        Ok(user) => user,
        Err(err) => {
            tracing::error!("session lookup failed: {err:#}");
            None
        }
    }?;
    // Cheap and throttled inside the database: a request every few seconds
    // does not become a write every few seconds.
    if let Err(err) = state.db.touch_last_seen(&user.id) {
        tracing::warn!("could not record activity for {}: {err:#}", user.email);
    }
    Some(user)
}

/// The account behind this request, or a 401 telling the browser to log in.
pub fn require_user(state: &SaasState, headers: &HeaderMap) -> Result<User, AppError> {
    current_user(state, headers)
        .ok_or_else(|| AppError::Unauthorized("Log in to continue.".to_string()))
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

/// Subject and body of the sign-in email, so the wording can be tested
/// without a mail provider.
fn magic_link_email(brand: &str, link: &str, minutes: i64) -> (String, String) {
    (
        format!("Your {brand} sign-in link"),
        format!(
            "Open the link below and press Continue to sign in to the {brand}:\n\n{link}\n\n\
             The link works once and expires in {minutes} minutes.\n\n\
             If you did not ask to sign in, you can ignore this email."
        ),
    )
}

async fn send_magic_email(state: &SaasState, email: &str, link: &str) -> Result<(), AppError> {
    let cfg = &state.cfg.email;
    let (subject, text) = magic_link_email(state.brand, link, state.cfg.auth.magic_link_minutes);

    let resp = state
        .http
        .post("https://api.resend.com/emails")
        .header("Authorization", format!("Bearer {}", cfg.resend_api_key))
        .json(&json!({
            "from": format!("{} <{}>", cfg.from_name, cfg.from_address),
            "to": [email],
            "subject": subject,
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

/// Query-string error codes the sign-in page understands. The page maps
/// each to its own translated message and renders nothing for anything
/// else, so the URL carries a code and never text.
pub const ERROR_INVALID_LINK: &str = "invalid_link";
pub const ERROR_EXPIRED_LINK: &str = "expired_link";

/// Send the browser back to the sign-in page with one of the codes above.
fn back_to_login(code: &str) -> Response {
    Redirect::to(&format!("/login?error={code}")).into_response()
}

#[derive(Debug, Deserialize)]
pub struct VerifyQuery {
    /// Optional so that a link with the token stripped is a redirect with a
    /// reason, not a 400 with no way forward.
    pub token: Option<String>,
}

/// GET /verify?token=… — show what a sign-in link would do, and do nothing.
///
/// Side-effect-free by contract: the token is looked up and checked for
/// expiry, and a page naming the account is rendered with a single Continue
/// button. No session is created, no cookie is set, and the token is not
/// touched, so a mail scanner fetching the link — as many times as it likes —
/// leaves it as good as new. Naming the account lets someone with several,
/// or someone forwarded a link, see whose session they are about to open.
pub async fn verify_page(
    State(state): State<SaasState>,
    Query(query): Query<VerifyQuery>,
) -> Result<Response, AppError> {
    let Some(token) = query.token.filter(|t| !t.is_empty()) else {
        return Ok(back_to_login(ERROR_INVALID_LINK));
    };
    let user = match state.db.peek_magic_token(&token)? {
        MagicLookup::Valid(user) => user,
        MagicLookup::Expired => return Ok(back_to_login(ERROR_EXPIRED_LINK)),
        MagicLookup::Unknown => return Ok(back_to_login(ERROR_INVALID_LINK)),
    };
    let page = include_str!("../static/verify.html")
        .replace("{{brand}}", &html_escape(state.brand))
        .replace("{{email}}", &html_escape(&user.email))
        .replace("{{token}}", &html_escape(&token));
    // The page carries the token; nothing should keep a copy of it.
    Ok(([(header::CACHE_CONTROL, "no-store")], Html(page)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ConfirmForm {
    pub token: Option<String>,
}

/// POST /verify/confirm — consume the sign-in link and start the session.
///
/// The only place a magic token is spent. The token is validated again here
/// rather than trusted from the page: it may have expired, or been consumed
/// by another request, since the page was rendered, and this is the request
/// that acts on it. Consumption is a conditional clear in the database, so a
/// replay finds nothing to clear and is sent back to the sign-in page rather
/// than signed in again.
pub async fn verify_confirm(
    State(state): State<SaasState>,
    headers: HeaderMap,
    Form(form): Form<ConfirmForm>,
) -> Result<Response, AppError> {
    let Some(token) = form.token.filter(|t| !t.is_empty()) else {
        return Ok(back_to_login(ERROR_INVALID_LINK));
    };
    let user = match state.db.redeem_magic_token(&token)? {
        MagicLookup::Valid(user) => user,
        MagicLookup::Expired => return Ok(back_to_login(ERROR_EXPIRED_LINK)),
        MagicLookup::Unknown => return Ok(back_to_login(ERROR_INVALID_LINK)),
    };

    let session = db::generate_token();
    let max_age = state.cfg.auth.session_days * 24 * 60 * 60;
    state
        .db
        .set_session(&user.id, &session, db::now() + max_age)?;

    // Redeeming the first link is the moment the account exists in any real
    // sense, and the only one an ad platform should be told about. Returning
    // sign-ins go to the same place without the marker, so a signup is
    // reported once per account rather than once per visit.
    let first_activation = state.db.mark_activated(&user.id)?;
    let destination = if first_activation {
        "/app?signup=1"
    } else {
        "/app"
    };

    if first_activation {
        tracing::info!("account activated: {}", user.email);
    } else {
        tracing::info!("session started for {}", user.email);
    }
    let cookie = session_cookie_header(&session, max_age, cookies_secure(&state, &headers));
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, cookie),
            (header::LOCATION, destination.into()),
        ],
    )
        .into_response())
}

/// Escape a value for placement in HTML text or a quoted attribute.
fn html_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
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

    #[test]
    fn the_sign_in_email_calls_the_product_by_its_name() {
        let brand = "Test Translator";
        let (subject, body) = magic_link_email(brand, "https://example.test/auth/abc", 60);
        assert_eq!(subject, format!("Your {brand} sign-in link"));
        assert!(body.contains(brand), "{body}");
        assert!(body.contains("https://example.test/auth/abc"));
        assert!(body.contains("expires in 60 minutes"));
        // The email is the one place a rename is easy to miss, because no
        // page shows it: it only appears in someone's inbox.
        assert!(!subject.contains("Interpreter"));
        assert!(!body.contains("Interpreter"));
    }

    #[test]
    fn html_escaping_covers_the_characters_that_matter() {
        assert_eq!(
            html_escape(r#"<b a="1">&'x'</b>"#),
            "&lt;b a=&quot;1&quot;&gt;&amp;&#39;x&#39;&lt;/b&gt;"
        );
        assert_eq!(html_escape("plain@example.com"), "plain@example.com");
    }

    /// The two-step redemption, driven through the real router so the tests
    /// see exactly what a browser — or a mail scanner — would.
    mod flow {
        use super::*;
        use crate::db::MagicLookup;
        use axum::{body::Body, http::Request, Router};
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        fn app() -> (SaasState, Router) {
            let state = SaasState::test();
            let router = crate::routes::<SaasState>().with_state(state.clone());
            (state, router)
        }

        fn fresh_link(state: &SaasState, email: &str) -> (User, String) {
            let user = state.db.upsert_user(email).unwrap();
            let token = db::generate_token();
            state
                .db
                .set_magic_token(&user.id, &token, db::now() + 600)
                .unwrap();
            (user, token)
        }

        async fn send(router: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
            let resp = router.clone().oneshot(req).await.unwrap();
            let status = resp.status();
            let headers = resp.headers().clone();
            let body = resp.into_body().collect().await.unwrap().to_bytes();
            (status, headers, String::from_utf8_lossy(&body).into_owned())
        }

        fn get_verify(query: &str) -> Request<Body> {
            Request::get(format!("/verify{query}"))
                .body(Body::empty())
                .unwrap()
        }

        fn post_confirm(body: &str) -> Request<Body> {
            Request::post("/verify/confirm")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(body.to_string()))
                .unwrap()
        }

        fn location(headers: &HeaderMap) -> &str {
            headers
                .get(header::LOCATION)
                .expect("a redirect names where to go")
                .to_str()
                .unwrap()
        }

        /// The session token a response set, if it set one.
        fn session_set(headers: &HeaderMap) -> Option<String> {
            let raw = headers.get(header::SET_COOKIE)?.to_str().ok()?;
            let (name, rest) = raw.split_once('=')?;
            assert_eq!(name, SESSION_COOKIE);
            Some(rest.split(';').next()?.to_string())
        }

        fn lookup(state: &SaasState, token: &str) -> MagicLookup {
            state.db.peek_magic_token(token).unwrap()
        }

        fn activated_at(state: &SaasState, user_id: &str) -> Option<i64> {
            state
                .db
                .admin_user_rows(quota::WINDOW_SECS, 100)
                .unwrap()
                .into_iter()
                .find(|row| row.id == user_id)
                .expect("the account is listed")
                .activated_at
        }

        #[tokio::test]
        async fn get_verify_reads_the_link_and_changes_nothing() {
            let (state, app) = app();
            let (user, token) = fresh_link(&state, "scanned@example.com");

            // A mail scanner may fetch the link any number of times before
            // the person does. Every fetch must find it as good as new.
            for _ in 0..3 {
                let (status, headers, body) =
                    send(&app, get_verify(&format!("?token={token}"))).await;
                assert_eq!(status, StatusCode::OK);
                assert!(body.contains("scanned@example.com"), "names the account");
                assert!(
                    body.contains(&format!("name=\"token\" value=\"{token}\"")),
                    "carries the token forward to the confirm step"
                );
                assert!(body.contains("action=\"/verify/confirm\""));
                assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
                assert!(session_set(&headers).is_none(), "GET never sets a cookie");
            }

            assert!(matches!(lookup(&state, &token), MagicLookup::Valid(_)));
            assert_eq!(activated_at(&state, &user.id), None, "GET never activates");
        }

        #[tokio::test]
        async fn post_confirm_consumes_the_link_exactly_once() {
            let (state, app) = app();
            let (user, token) = fresh_link(&state, "first@example.com");

            let (status, headers, _) = send(&app, post_confirm(&format!("token={token}"))).await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert_eq!(
                location(&headers),
                "/app?signup=1",
                "first activation is marked"
            );
            let session = session_set(&headers).expect("the confirm step signs in");
            assert_eq!(
                state.db.user_by_session(&session).unwrap().unwrap().id,
                user.id
            );
            assert!(activated_at(&state, &user.id).is_some());
            assert!(
                matches!(lookup(&state, &token), MagicLookup::Unknown),
                "spent"
            );

            // A replay — the back button, a scanner that submits forms, an
            // attacker with a copied token — is sent back to sign in, not
            // signed in again.
            let (status, headers, _) = send(&app, post_confirm(&format!("token={token}"))).await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert_eq!(location(&headers), "/login?error=invalid_link");
            assert!(session_set(&headers).is_none());
            // ...and the session from the real redemption is untouched.
            assert!(state.db.user_by_session(&session).unwrap().is_some());

            // A returning sign-in lands on the app without the signup marker.
            let (_, again) = fresh_link(&state, "first@example.com");
            let (_, headers, _) = send(&app, post_confirm(&format!("token={again}"))).await;
            assert_eq!(location(&headers), "/app");
        }

        #[tokio::test]
        async fn an_expired_link_is_called_expired_at_both_steps() {
            let (state, app) = app();
            let user = state.db.upsert_user("late@example.com").unwrap();
            let token = db::generate_token();
            state
                .db
                .set_magic_token(&user.id, &token, db::now() - 1)
                .unwrap();

            let (status, headers, _) = send(&app, get_verify(&format!("?token={token}"))).await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert_eq!(location(&headers), "/login?error=expired_link");
            assert!(session_set(&headers).is_none());

            let (status, headers, _) = send(&app, post_confirm(&format!("token={token}"))).await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert_eq!(location(&headers), "/login?error=expired_link");
            assert!(session_set(&headers).is_none());
            assert_eq!(activated_at(&state, &user.id), None);
            // Still expired, not "unknown": the reason stays stable on a retry.
            assert!(matches!(lookup(&state, &token), MagicLookup::Expired));
        }

        #[tokio::test]
        async fn unknown_or_missing_tokens_are_invalid_links() {
            let (_, app) = app();
            for req in [
                get_verify(""),
                get_verify("?token="),
                get_verify("?token=never-issued"),
            ] {
                let (status, headers, _) = send(&app, req).await;
                assert_eq!(status, StatusCode::SEE_OTHER);
                assert_eq!(location(&headers), "/login?error=invalid_link");
                assert!(session_set(&headers).is_none());
            }
            for body in ["token=never-issued", "token=", ""] {
                let (status, headers, _) = send(&app, post_confirm(body)).await;
                assert_eq!(status, StatusCode::SEE_OTHER);
                assert_eq!(location(&headers), "/login?error=invalid_link");
                assert!(session_set(&headers).is_none());
            }
        }

        #[tokio::test]
        async fn the_wrong_method_on_either_path_is_refused_and_touches_nothing() {
            let (state, app) = app();
            let (user, token) = fresh_link(&state, "methods@example.com");

            // POST on the render path.
            let req = Request::post(format!("/verify?token={token}"))
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(format!("token={token}")))
                .unwrap();
            let (status, headers, _) = send(&app, req).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
            assert!(session_set(&headers).is_none());

            // GET on the confirm path.
            let req = Request::get(format!("/verify/confirm?token={token}"))
                .body(Body::empty())
                .unwrap();
            let (status, headers, _) = send(&app, req).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
            assert!(session_set(&headers).is_none());

            assert!(matches!(lookup(&state, &token), MagicLookup::Valid(_)));
            assert_eq!(activated_at(&state, &user.id), None);

            // The link is still good for the one request that may spend it.
            let (status, headers, _) = send(&app, post_confirm(&format!("token={token}"))).await;
            assert_eq!(status, StatusCode::SEE_OTHER);
            assert!(session_set(&headers).is_some());
        }

        #[tokio::test]
        async fn the_account_name_is_escaped_on_the_page() {
            let (state, app) = app();
            // Not a deliverable address, but the store accepts what the
            // request handler normalises, and the page must not trust it.
            let user = state.db.upsert_user("<img src=x>@example.com").unwrap();
            let token = db::generate_token();
            state
                .db
                .set_magic_token(&user.id, &token, db::now() + 600)
                .unwrap();
            let (status, _, body) = send(&app, get_verify(&format!("?token={token}"))).await;
            assert_eq!(status, StatusCode::OK);
            assert!(!body.contains("<img"));
            assert!(body.contains("&lt;img src=x&gt;@example.com"));
        }
    }
}
