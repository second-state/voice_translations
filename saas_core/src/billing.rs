//! Stripe subscriptions: opening Checkout, opening the billing portal, and
//! receiving the webhooks that move an account between the free and paid
//! plans.
//!
//! Nothing here trusts the browser. The client can ask for a Checkout URL,
//! but a paid plan is only ever the result of Stripe telling us, over a
//! signed webhook, that money actually moved — or of the operator granting
//! one by hand from the dashboard, which is `admin`'s to do, not this
//! module's.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::{auth, error::AppError, state::SaasState};

/// How far a webhook's timestamp may be from our clock. Stripe signs the
/// timestamp, so a narrow window turns a captured delivery into a useless
/// one; five minutes is Stripe's own recommendation and tolerates ordinary
/// skew.
const SIGNATURE_TOLERANCE_SECS: i64 = 300;

/// POST /api/billing/checkout — start a subscription for the signed-in
/// account and hand back the Stripe-hosted page to send them to.
pub async fn checkout(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state, &headers)?;
    let stripe = &state.cfg.stripe;
    if !stripe.enabled() {
        return Err(AppError::Unavailable(
            "Subscriptions are not configured on this deployment.".to_string(),
        ));
    }
    if user.is_pro() {
        return Err(AppError::BadRequest(
            "This account already has an active subscription.".to_string(),
        ));
    }

    let base = &state.cfg.email.base_url;
    let mut form: Vec<(String, String)> = vec![
        ("mode".into(), "subscription".into()),
        ("line_items[0][price]".into(), stripe.price_id.clone()),
        ("line_items[0][quantity]".into(), "1".into()),
        ("success_url".into(), format!("{base}/app?upgraded=1")),
        ("cancel_url".into(), format!("{base}/app")),
        // Three independent ways back to this account: Stripe echoes
        // client_reference_id on the session, and the metadata rides along
        // to the subscription so renewal and cancellation events carry it
        // too.
        ("client_reference_id".into(), user.id.clone()),
        ("metadata[user_id]".into(), user.id.clone()),
        (
            "subscription_data[metadata][user_id]".into(),
            user.id.clone(),
        ),
    ];
    match user.stripe_customer_id.as_deref() {
        Some(customer) => form.push(("customer".into(), customer.to_string())),
        None => form.push(("customer_email".into(), user.email.clone())),
    }

    let session = stripe_post(&state, "checkout/sessions", &form).await?;
    let url = session["url"]
        .as_str()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Stripe returned no checkout URL")))?;
    tracing::info!("opened a checkout session for {}", user.email);
    Ok(Json(json!({ "url": url })).into_response())
}

/// POST /api/billing/portal — send a subscriber to Stripe's own billing
/// portal, where they can update payment details or cancel. Cancellation
/// comes back to us as a webhook.
pub async fn portal(
    State(state): State<SaasState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let user = auth::require_user(&state, &headers)?;
    if !state.cfg.stripe.enabled() {
        return Err(AppError::Unavailable(
            "Subscriptions are not configured on this deployment.".to_string(),
        ));
    }
    let Some(customer) = user.stripe_customer_id.clone() else {
        return Err(AppError::BadRequest(
            "This account has no Stripe customer record yet.".to_string(),
        ));
    };

    let form = vec![
        ("customer".to_string(), customer),
        (
            "return_url".to_string(),
            format!("{}/app", state.cfg.email.base_url),
        ),
    ];
    let session = stripe_post(&state, "billing_portal/sessions", &form).await?;
    let url = session["url"]
        .as_str()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Stripe returned no portal URL")))?;
    Ok(Json(json!({ "url": url })).into_response())
}

async fn stripe_post(
    state: &SaasState,
    path: &str,
    form: &[(String, String)],
) -> Result<Value, AppError> {
    let resp = state
        .http
        .post(format!("https://api.stripe.com/v1/{path}"))
        .bearer_auth(&state.cfg.stripe.secret_key)
        .form(form)
        .send()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Stripe request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "Stripe {path} returned {status}: {body}"
        )));
    }
    serde_json::from_str(&body)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Stripe {path} returned non-JSON: {e}")))
}

/// POST /stripe/webhook — the only path by which an account changes plan.
///
/// Always answers 200 once the signature verifies, even for events we ignore
/// or cannot attribute: a non-2xx tells Stripe to redeliver, and redelivering
/// an event we have deliberately skipped fixes nothing.
pub async fn webhook(
    State(state): State<SaasState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::WebhookVerificationFailed)?;
    verify_signature(
        &body,
        signature,
        &state.cfg.stripe.webhook_secret,
        crate::db::now(),
    )?;

    let event: Value = serde_json::from_slice(&body)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("webhook body was not JSON: {e}")))?;
    let event_type = event["type"].as_str().unwrap_or_default();
    let object = &event["data"]["object"];
    tracing::info!("stripe webhook: {event_type}");

    // Whoever this concerns, resolved once: the account is recorded against
    // every delivery, not only the ones that move a plan. A failed payment or
    // a refund changes nothing here and is exactly what someone reading the
    // dashboard later needs to see.
    let user = state.db.user_for_stripe(
        object["metadata"]["user_id"]
            .as_str()
            .or_else(|| object["client_reference_id"].as_str()),
        object["customer"].as_str(),
        subscription_id(object),
        object["customer_email"]
            .as_str()
            .or_else(|| object["customer_details"]["email"].as_str()),
    )?;
    if let Some(user) = &user {
        record_event(&state, &event, object, &user.id)?;
    }

    match event_type {
        // The subscription was just paid for the first time. One-off
        // payment sessions, if this account ever sells any, are not plans.
        "checkout.session.completed" if object["mode"].as_str() == Some("subscription") => {
            apply(&state, user.as_ref(), object, "active", true)?;
        }
        // Renewals, plan changes, cancellations scheduled or immediate.
        "customer.subscription.created" | "customer.subscription.updated" => {
            let status = object["status"].as_str().unwrap_or("unknown");
            // `past_due` keeps access while Stripe retries the card; the
            // terminal states below are what actually end a subscription.
            let entitled = matches!(status, "active" | "trialing" | "past_due");
            apply(&state, user.as_ref(), object, status, entitled)?;
        }
        "customer.subscription.deleted" => {
            apply(&state, user.as_ref(), object, "canceled", false)?;
        }
        _ => {}
    }

    Ok(StatusCode::OK)
}

/// Move one account to the plan an event implies.
/// A checkout session names the subscription it created; a subscription event
/// *is* that object.
fn subscription_id(object: &Value) -> Option<&str> {
    object["subscription"]
        .as_str()
        .or_else(|| object["id"].as_str().filter(|id| id.starts_with("sub_")))
}

/// Store one delivery against the account it concerns.
///
/// Money lives under a different key on every kind of object, and is absent
/// on plan changes and cancellations, which are still worth a line in the
/// history.
fn record_event(
    state: &SaasState,
    event: &Value,
    object: &Value,
    user_id: &str,
) -> Result<(), AppError> {
    let Some(event_id) = event["id"].as_str() else {
        tracing::warn!("stripe webhook: delivery has no event id; not recording it");
        return Ok(());
    };
    let amount = object["amount_paid"]
        .as_i64()
        .or_else(|| object["amount_total"].as_i64())
        .or_else(|| object["amount_due"].as_i64())
        .or_else(|| object["amount"].as_i64());

    state.db.record_payment_event(
        event_id,
        user_id,
        event["type"].as_str().unwrap_or("unknown"),
        object["status"].as_str(),
        amount,
        object["currency"].as_str(),
        object["id"].as_str(),
        event["created"].as_i64().unwrap_or_else(crate::db::now),
    )?;
    Ok(())
}

fn apply(
    state: &SaasState,
    user: Option<&crate::db::User>,
    object: &Value,
    status: &str,
    entitled: bool,
) -> Result<(), AppError> {
    let subscription_id = subscription_id(object);
    let customer_id = object["customer"].as_str();

    let Some(user) = user else {
        tracing::warn!(
            "stripe webhook: no account matches customer={customer_id:?} \
             subscription={subscription_id:?}; ignoring"
        );
        return Ok(());
    };

    // A subscription granted from the dashboard is not Stripe's to end.
    // Once a Stripe subscription re-activates the account its status stops
    // being "comped" and the Stripe lifecycle governs it again; until then a
    // cancellation — including a stale redelivery for a subscription that
    // ended before the grant was made — changes nothing.
    if !entitled && user.is_comped() {
        tracing::info!(
            "stripe webhook: ignoring {status} for {}; their subscription was granted by \
             the operator and is not billed through Stripe",
            user.email
        );
        return Ok(());
    }

    // A cancellation for a subscription this account has already replaced
    // must not downgrade the replacement. Stripe can deliver a `deleted`
    // event for an old subscription after the user has resubscribed, and
    // deliveries are not ordered.
    if !entitled {
        if let (Some(event_sub), Some(current_sub)) =
            (subscription_id, user.stripe_subscription_id.as_deref())
        {
            if event_sub != current_sub && user.is_pro() {
                tracing::info!(
                    "stripe webhook: ignoring {status} for superseded subscription \
                     {event_sub}; {} now holds {current_sub}",
                    user.email
                );
                return Ok(());
            }
        }
    }

    if entitled {
        state
            .db
            .activate_subscription(&user.id, customer_id, subscription_id, status)?;
        tracing::info!("{} is now on the paid plan ({status})", user.email);
    } else {
        state.db.deactivate_subscription(&user.id, status)?;
        tracing::info!("{} returned to the free plan ({status})", user.email);
    }
    Ok(())
}

/// Verify Stripe's `Stripe-Signature` header against the raw body.
///
/// `now` is passed in so the replay window is testable.
fn verify_signature(payload: &[u8], header: &str, secret: &str, now: i64) -> Result<(), AppError> {
    if secret.trim().is_empty() {
        tracing::warn!(
            "stripe webhook rejected: [stripe] webhook_secret is empty, so deliveries cannot \
             be verified. Copy the endpoint's signing secret (whsec_…) into config.toml."
        );
        return Err(AppError::WebhookVerificationFailed);
    }

    let mut timestamp: Option<i64> = None;
    let mut signatures: Vec<&str> = Vec::new();
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", value)) => timestamp = value.parse().ok(),
            Some(("v1", value)) => signatures.push(value),
            _ => {}
        }
    }

    let Some(timestamp) = timestamp else {
        tracing::warn!("stripe webhook rejected: signature header carried no usable timestamp");
        return Err(AppError::WebhookVerificationFailed);
    };
    if signatures.is_empty() {
        tracing::warn!("stripe webhook rejected: signature header carried no v1 signature");
        return Err(AppError::WebhookVerificationFailed);
    }
    if (now - timestamp).abs() > SIGNATURE_TOLERANCE_SECS {
        tracing::warn!(
            "stripe webhook rejected: timestamp is {}s away from this server's clock \
             (tolerance {SIGNATURE_TOLERANCE_SECS}s) — a replayed delivery, or a clock that \
             needs syncing.",
            now - timestamp
        );
        return Err(AppError::WebhookVerificationFailed);
    }

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes())
        .map_err(|_| AppError::WebhookVerificationFailed)?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    let expected = hex::encode(mac.finalize().into_bytes());

    if signatures
        .iter()
        .any(|sig| constant_time_eq(sig, &expected))
    {
        Ok(())
    } else {
        // An 8-char prefix of an HMAC reveals nothing usable but separates
        // "wrong secret" (unrelated values) from "body altered in transit"
        // (values that should have matched).
        tracing::warn!(
            "stripe webhook rejected: signature mismatch (expected {}…, received {}…, \
             body {} bytes). Usually the wrong signing secret, or test/live mode crossed.",
            &expected[..8.min(expected.len())],
            signatures
                .first()
                .map(|s| &s[..8.min(s.len())])
                .unwrap_or(""),
            payload.len()
        );
        Err(AppError::WebhookVerificationFailed)
    }
}

/// Compare without leaking, through timing, how much of the value matched.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "whsec_test_secret";

    fn sign(payload: &[u8], timestamp: i64, secret: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(payload);
        format!(
            "t={timestamp},v1={}",
            hex::encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn accepts_a_correctly_signed_delivery() {
        let body = br#"{"type":"customer.subscription.deleted"}"#;
        let header = sign(body, 1_700_000_000, SECRET);
        assert!(verify_signature(body, &header, SECRET, 1_700_000_000).is_ok());
        // Inside the tolerance window.
        assert!(verify_signature(body, &header, SECRET, 1_700_000_200).is_ok());
    }

    #[test]
    fn rejects_tampering_wrong_secrets_and_replays() {
        let body = br#"{"type":"checkout.session.completed"}"#;
        let ts = 1_700_000_000;
        let header = sign(body, ts, SECRET);

        // Body altered after signing.
        assert!(verify_signature(b"{\"type\":\"evil\"}", &header, SECRET, ts).is_err());
        // Signed with someone else's secret.
        assert!(verify_signature(body, &sign(body, ts, "whsec_other"), SECRET, ts).is_err());
        // Captured and replayed an hour later.
        assert!(verify_signature(body, &header, SECRET, ts + 3600).is_err());
        // Unsigned deployment: refuse rather than trust.
        assert!(verify_signature(body, &header, "", ts).is_err());
        // Malformed headers.
        assert!(verify_signature(body, "nonsense", SECRET, ts).is_err());
        assert!(verify_signature(body, &format!("t={ts}"), SECRET, ts).is_err());
    }

    #[test]
    fn accepts_any_of_several_offered_signatures() {
        // Stripe sends two v1 values while a signing secret is being rolled.
        let body = br#"{"type":"customer.subscription.updated"}"#;
        let ts = 1_700_000_000;
        let good = sign(body, ts, SECRET);
        let v1 = good.split("v1=").nth(1).unwrap();
        let header = format!("t={ts},v1=deadbeef,v1={v1}");
        assert!(verify_signature(body, &header, SECRET, ts).is_ok());
    }

    #[test]
    fn constant_time_compare_still_compares() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
    #[test]
    fn a_granted_subscription_ignores_stripe_cancellations() {
        let state = crate::state::SaasState::test();
        let user = state.db.upsert_user("comp@example.com").unwrap();
        state
            .db
            .activate_subscription(&user.id, None, None, crate::db::STATUS_COMPED)
            .unwrap();
        let user = state.db.user_by_id(&user.id).unwrap().unwrap();

        // A cancellation arrives — a stale redelivery, or a subscription that
        // ended before the grant was made. The grant survives.
        let object = serde_json::json!({ "id": "sub_old", "customer": "cus_1" });
        apply(&state, Some(&user), &object, "canceled", false).unwrap();
        let after = state.db.user_by_id(&user.id).unwrap().unwrap();
        assert!(after.is_pro() && after.is_comped());
    }

    #[test]
    fn stripe_takes_over_a_granted_subscription_and_may_then_end_it() {
        let state = crate::state::SaasState::test();
        let user = state.db.upsert_user("comp@example.com").unwrap();
        state
            .db
            .activate_subscription(&user.id, None, None, crate::db::STATUS_COMPED)
            .unwrap();
        let user = state.db.user_by_id(&user.id).unwrap().unwrap();

        // The user subscribes through Checkout: still pro, no longer a grant.
        let checkout = serde_json::json!({
            "id": "cs_1", "mode": "subscription",
            "customer": "cus_1", "subscription": "sub_1",
        });
        apply(&state, Some(&user), &checkout, "active", true).unwrap();
        let paying = state.db.user_by_id(&user.id).unwrap().unwrap();
        assert!(paying.is_pro() && !paying.is_comped());
        assert_eq!(paying.subscription_status.as_deref(), Some("active"));

        // Now the Stripe lifecycle governs: its cancellation ends the plan.
        let deleted = serde_json::json!({ "id": "sub_1", "customer": "cus_1" });
        apply(&state, Some(&paying), &deleted, "canceled", false).unwrap();
        let after = state.db.user_by_id(&user.id).unwrap().unwrap();
        assert!(!after.is_pro());
        assert_eq!(after.subscription_status.as_deref(), Some("canceled"));
    }
}
