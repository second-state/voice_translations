-- The schema as first released: accounts, the credentials attached to them,
-- and the word-usage ledger the rolling quota is summed from.
--
-- Every statement is IF NOT EXISTS, so this runs harmlessly against a
-- database created before migrations were tracked. That is what lets an
-- existing deployment adopt the migration chain without being rebuilt.

CREATE TABLE IF NOT EXISTS users (
    id                     TEXT PRIMARY KEY,
    email                  TEXT NOT NULL UNIQUE,
    plan                   TEXT NOT NULL DEFAULT 'free',
    magic_token_hash       TEXT,
    magic_expires          INTEGER,
    session_token_hash     TEXT,
    session_expires        INTEGER,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    subscription_status    TEXT,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session      ON users(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_users_magic        ON users(magic_token_hash);
CREATE INDEX IF NOT EXISTS idx_users_customer     ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_subscription ON users(stripe_subscription_id);

-- One row per spoken turn. The quota is a SUM over a rolling window of this
-- table, so nothing has to be reset on a schedule.
CREATE TABLE IF NOT EXISTS word_usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    words      INTEGER NOT NULL,
    role       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user_time ON word_usage(user_id, created_at);
