-- Every Stripe webhook that resolves to an account, kept so the dashboard can
-- show one user's billing history: what Stripe said, when, and for how much.
--
-- The primary key is Stripe's own event id, so a redelivered webhook — which
-- Stripe does on any non-2xx, and may do anyway — updates nothing and
-- duplicates nothing.
--
-- Amounts are in the currency's minor unit (cents), exactly as Stripe sends
-- them, and are null for events that carry no money: a plan change or a
-- cancellation is worth seeing in the trail even though nothing was charged.
CREATE TABLE IF NOT EXISTS payment_events (
    id           TEXT PRIMARY KEY,
    user_id      TEXT REFERENCES users(id),
    type         TEXT NOT NULL,
    status       TEXT,
    amount_cents INTEGER,
    currency     TEXT,
    -- The Stripe object the event was about (sub_…, in_…, cs_…), for
    -- matching a row against the Stripe dashboard.
    object_id    TEXT,
    -- When Stripe says it happened, not when we stored it: deliveries are
    -- retried and are not ordered.
    created_at   INTEGER NOT NULL,
    recorded_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_events_user ON payment_events(user_id, created_at);
