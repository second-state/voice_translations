-- What the operator's dashboard at /admin needs and the account row could
-- not answer: when a subscription started and ended, and when the account
-- was last seen.
--
-- `subscribed_at` is the move from free to paid, not the latest renewal, so
-- it reads as the date they became a customer. `unsubscribed_at` is the
-- cancellation; both survive so a lapsed account still shows its history.
ALTER TABLE users ADD COLUMN subscribed_at INTEGER;
ALTER TABLE users ADD COLUMN unsubscribed_at INTEGER;

-- Last authenticated request. Written at most once every few minutes per
-- account, so a polling console does not become a write per poll.
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

-- Signed-in admins. Not accounts: the dashboard is one shared password, and
-- a session records the hash of the password that opened it so rotating that
-- password ends every session it opened.
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash    TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
