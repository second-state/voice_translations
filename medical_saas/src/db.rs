//! The embedded SQLite database: accounts, magic-link and session tokens,
//! subscription state, and the word-usage ledger the quota is computed from.
//!
//! One file on disk, created and migrated at startup. Every operation is a
//! short synchronous statement — SQLite is microseconds fast at this size —
//! so the connection lives behind a plain mutex that is never held across an
//! await point.
//!
//! Tokens are stored as SHA-256 hashes rather than in the clear: a leaked
//! database copy then yields no usable session or login link.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Seconds since the Unix epoch. Timestamps are integers throughout so the
/// rolling-window quota query is plain arithmetic.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Hash a bearer-style token for storage and lookup.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// A random 256-bit token, hex encoded.
pub fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    hex::encode(bytes)
}

/// Normalize an address so `Bob@Example.COM ` and `bob@example.com` are one
/// account.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Whether an address is plausible enough to send a login link to. A full
/// RFC 5322 parse buys nothing here: delivery is the real validator.
pub fn is_plausible_email(email: &str) -> bool {
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && email.len() <= 254
        && !email.contains(char::is_whitespace)
}

/// One account.
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: String,
    pub email: String,
    /// `free` or `pro`; see [`User::is_pro`].
    pub plan: String,
    /// Stripe's own subscription status, kept for display and diagnosis.
    pub subscription_status: Option<String>,
    #[serde(skip)]
    pub stripe_customer_id: Option<String>,
    #[serde(skip)]
    pub stripe_subscription_id: Option<String>,
    pub created_at: i64,
}

impl User {
    /// Paid users translate without a word limit.
    pub fn is_pro(&self) -> bool {
        self.plan == PLAN_PRO
    }
}

pub const PLAN_FREE: &str = "free";
pub const PLAN_PRO: &str = "pro";

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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

CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_users_magic   ON users(magic_token_hash);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(stripe_customer_id);
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
";

/// Handle to the account database.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Open (creating if needed) the database at `path` and apply the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let conn = Connection::open(path).with_context(|| {
            format!("failed to open the account database at {}", path.display())
        })?;
        conn.execute_batch(SCHEMA)
            .context("failed to apply the account database schema")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// An in-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("account database lock poisoned"))?;
        Ok(f(&conn)?)
    }

    /// Look up an account by address, or create one. Signup and login are the
    /// same act with a magic link: the first link sent to an address creates
    /// the account it activates.
    pub fn upsert_user(&self, email: &str) -> Result<User> {
        let email = normalize_email(email);
        let ts = now();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO users (id, email, plan, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(email) DO NOTHING",
                params![uuid::Uuid::new_v4().to_string(), email, PLAN_FREE, ts],
            )?;
            row_to_user(conn, "email = ?1", params![email])
        })?
        .ok_or_else(|| anyhow::anyhow!("user vanished immediately after insert"))
    }

    pub fn user_by_email(&self, email: &str) -> Result<Option<User>> {
        let email = normalize_email(email);
        self.with(|conn| row_to_user(conn, "email = ?1", params![email]))
    }

    pub fn user_by_id(&self, id: &str) -> Result<Option<User>> {
        self.with(|conn| row_to_user(conn, "id = ?1", params![id]))
    }

    /// Store the hash of a freshly issued magic-link token.
    pub fn set_magic_token(&self, user_id: &str, token: &str, expires: i64) -> Result<()> {
        let hash = hash_token(token);
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET magic_token_hash = ?1, magic_expires = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![hash, expires, now(), user_id],
            )
        })?;
        Ok(())
    }

    /// Redeem a magic-link token: returns the account it belongs to only when
    /// the token matches and has not expired, and clears it either way so a
    /// link works exactly once.
    pub fn redeem_magic_token(&self, token: &str) -> Result<Option<User>> {
        let hash = hash_token(token);
        let ts = now();
        self.with(|conn| {
            let user = row_to_user(conn, "magic_token_hash = ?1", params![hash])?;
            let Some(user) = user else { return Ok(None) };
            let expires: Option<i64> = conn.query_row(
                "SELECT magic_expires FROM users WHERE id = ?1",
                params![user.id],
                |r| r.get(0),
            )?;
            conn.execute(
                "UPDATE users SET magic_token_hash = NULL, magic_expires = NULL, updated_at = ?1
                 WHERE id = ?2",
                params![ts, user.id],
            )?;
            Ok(match expires {
                Some(exp) if exp >= ts => Some(user),
                _ => None,
            })
        })
    }

    /// Start a session, replacing any previous one for that account.
    pub fn set_session(&self, user_id: &str, token: &str, expires: i64) -> Result<()> {
        let hash = hash_token(token);
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET session_token_hash = ?1, session_expires = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![hash, expires, now(), user_id],
            )
        })?;
        Ok(())
    }

    /// The account a session cookie belongs to, if the session is still valid.
    pub fn user_by_session(&self, token: &str) -> Result<Option<User>> {
        let hash = hash_token(token);
        let ts = now();
        self.with(|conn| {
            row_to_user(
                conn,
                "session_token_hash = ?1 AND session_expires > ?2",
                params![hash, ts],
            )
        })
    }

    pub fn clear_session(&self, user_id: &str) -> Result<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET session_token_hash = NULL, session_expires = NULL, updated_at = ?1
                 WHERE id = ?2",
                params![now(), user_id],
            )
        })?;
        Ok(())
    }

    /// Record the words spoken in one turn.
    pub fn record_words(&self, user_id: &str, words: i64, role: &str) -> Result<()> {
        if words <= 0 {
            return Ok(());
        }
        self.with(|conn| {
            conn.execute(
                "INSERT INTO word_usage (user_id, words, role, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![user_id, words, role, now()],
            )
        })?;
        Ok(())
    }

    /// Words spoken by this account within the last `window_secs` — the
    /// rolling window, counted from this instant backwards, so there is no
    /// reset moment and no calendar week to align to.
    pub fn words_used_since(&self, user_id: &str, window_secs: i64) -> Result<i64> {
        let cutoff = now() - window_secs;
        self.with(|conn| {
            conn.query_row(
                "SELECT COALESCE(SUM(words), 0) FROM word_usage
                 WHERE user_id = ?1 AND created_at > ?2",
                params![user_id, cutoff],
                |r| r.get(0),
            )
        })
    }

    /// When the oldest words still inside the window fall out of it — the
    /// moment a capped free account regains some allowance.
    pub fn window_resets_at(&self, user_id: &str, window_secs: i64) -> Result<Option<i64>> {
        let cutoff = now() - window_secs;
        self.with(|conn| {
            conn.query_row(
                "SELECT MIN(created_at) FROM word_usage WHERE user_id = ?1 AND created_at > ?2",
                params![user_id, cutoff],
                |r| r.get::<_, Option<i64>>(0),
            )
        })
        .map(|oldest| oldest.map(|t| t + window_secs))
    }

    /// Attach Stripe identifiers and mark the account paid.
    pub fn activate_subscription(
        &self,
        user_id: &str,
        customer_id: Option<&str>,
        subscription_id: Option<&str>,
        status: &str,
    ) -> Result<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET plan = ?1, subscription_status = ?2,
                        stripe_customer_id = COALESCE(?3, stripe_customer_id),
                        stripe_subscription_id = COALESCE(?4, stripe_subscription_id),
                        updated_at = ?5
                 WHERE id = ?6",
                params![
                    PLAN_PRO,
                    status,
                    customer_id,
                    subscription_id,
                    now(),
                    user_id
                ],
            )
        })?;
        Ok(())
    }

    /// Drop the account back to the free plan, keeping the Stripe ids so a
    /// later renewal event still resolves to this user.
    pub fn deactivate_subscription(&self, user_id: &str, status: &str) -> Result<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET plan = ?1, subscription_status = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![PLAN_FREE, status, now(), user_id],
            )
        })?;
        Ok(())
    }

    /// Resolve the account a webhook event refers to: by our own id in the
    /// session metadata, else by the Stripe customer or subscription id we
    /// stored when the subscription began, else by the billing email.
    pub fn user_for_stripe(
        &self,
        user_id: Option<&str>,
        customer_id: Option<&str>,
        subscription_id: Option<&str>,
        email: Option<&str>,
    ) -> Result<Option<User>> {
        if let Some(id) = user_id {
            if let Some(user) = self.user_by_id(id)? {
                return Ok(Some(user));
            }
        }
        if let Some(sub) = subscription_id {
            let found =
                self.with(|conn| row_to_user(conn, "stripe_subscription_id = ?1", params![sub]))?;
            if found.is_some() {
                return Ok(found);
            }
        }
        if let Some(cust) = customer_id {
            let found =
                self.with(|conn| row_to_user(conn, "stripe_customer_id = ?1", params![cust]))?;
            if found.is_some() {
                return Ok(found);
            }
        }
        match email {
            Some(email) => self.user_by_email(email),
            None => Ok(None),
        }
    }
}

fn row_to_user(
    conn: &Connection,
    where_clause: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<Option<User>> {
    let sql = format!(
        "SELECT id, email, plan, subscription_status, stripe_customer_id,
                stripe_subscription_id, created_at
         FROM users WHERE {where_clause}"
    );
    conn.query_row(&sql, params, |row| {
        Ok(User {
            id: row.get(0)?,
            email: row.get(1)?,
            plan: row.get(2)?,
            subscription_status: row.get(3)?,
            stripe_customer_id: row.get(4)?,
            stripe_subscription_id: row.get(5)?,
            created_at: row.get(6)?,
        })
    })
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn signup_is_idempotent_and_case_insensitive() {
        let db = db();
        let a = db.upsert_user("Bob@Example.COM ").unwrap();
        let b = db.upsert_user("bob@example.com").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.email, "bob@example.com");
        assert_eq!(a.plan, PLAN_FREE);
        assert!(!a.is_pro());
    }

    #[test]
    fn magic_token_works_once_and_expires() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();

        let token = generate_token();
        db.set_magic_token(&user.id, &token, now() + 600).unwrap();
        assert_eq!(db.redeem_magic_token(&token).unwrap().unwrap().id, user.id);
        // Second use finds nothing: redemption cleared it.
        assert!(db.redeem_magic_token(&token).unwrap().is_none());

        let stale = generate_token();
        db.set_magic_token(&user.id, &stale, now() - 1).unwrap();
        assert!(db.redeem_magic_token(&stale).unwrap().is_none());

        assert!(db.redeem_magic_token("not-a-token").unwrap().is_none());
    }

    #[test]
    fn sessions_validate_and_clear() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        let token = generate_token();
        db.set_session(&user.id, &token, now() + 3600).unwrap();
        assert_eq!(db.user_by_session(&token).unwrap().unwrap().id, user.id);

        db.clear_session(&user.id).unwrap();
        assert!(db.user_by_session(&token).unwrap().is_none());

        let expired = generate_token();
        db.set_session(&user.id, &expired, now() - 1).unwrap();
        assert!(db.user_by_session(&expired).unwrap().is_none());
    }

    #[test]
    fn tokens_are_not_stored_in_the_clear() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        let token = generate_token();
        db.set_session(&user.id, &token, now() + 3600).unwrap();
        let stored: String = db
            .with(|c| {
                c.query_row(
                    "SELECT session_token_hash FROM users WHERE id = ?1",
                    params![user.id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored, hash_token(&token));
    }

    #[test]
    fn usage_sums_only_inside_the_window() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.record_words(&user.id, 100, "clinician").unwrap();
        db.record_words(&user.id, 250, "patient").unwrap();
        // Zero-word turns are not recorded at all.
        db.record_words(&user.id, 0, "patient").unwrap();
        assert_eq!(db.words_used_since(&user.id, 604_800).unwrap(), 350);

        // Backdate one row past the window: it stops counting.
        db.with(|c| {
            c.execute(
                "UPDATE word_usage SET created_at = ?1 WHERE words = 250",
                params![now() - 604_800 - 60],
            )
        })
        .unwrap();
        assert_eq!(db.words_used_since(&user.id, 604_800).unwrap(), 100);
    }

    #[test]
    fn window_reset_follows_the_oldest_counted_turn() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        assert!(db.window_resets_at(&user.id, 604_800).unwrap().is_none());
        db.record_words(&user.id, 10, "patient").unwrap();
        let resets = db.window_resets_at(&user.id, 604_800).unwrap().unwrap();
        assert!(resets > now() + 604_000 && resets <= now() + 604_800);
    }

    #[test]
    fn subscription_state_moves_both_ways() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.activate_subscription(&user.id, Some("cus_1"), Some("sub_1"), "active")
            .unwrap();
        let pro = db.user_by_id(&user.id).unwrap().unwrap();
        assert!(pro.is_pro());
        assert_eq!(pro.stripe_customer_id.as_deref(), Some("cus_1"));

        db.deactivate_subscription(&user.id, "canceled").unwrap();
        let free = db.user_by_id(&user.id).unwrap().unwrap();
        assert!(!free.is_pro());
        // Stripe ids survive so a later renewal still resolves to this user.
        assert_eq!(free.stripe_subscription_id.as_deref(), Some("sub_1"));
    }

    #[test]
    fn webhook_lookup_falls_back_through_every_identifier() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.activate_subscription(&user.id, Some("cus_9"), Some("sub_9"), "active")
            .unwrap();

        let by_id = db
            .user_for_stripe(Some(&user.id), None, None, None)
            .unwrap();
        assert_eq!(by_id.unwrap().id, user.id);
        let by_sub = db.user_for_stripe(None, None, Some("sub_9"), None).unwrap();
        assert_eq!(by_sub.unwrap().id, user.id);
        let by_cust = db.user_for_stripe(None, Some("cus_9"), None, None).unwrap();
        assert_eq!(by_cust.unwrap().id, user.id);
        let by_email = db
            .user_for_stripe(None, None, None, Some("A@B.com"))
            .unwrap();
        assert_eq!(by_email.unwrap().id, user.id);
        assert!(db
            .user_for_stripe(Some("nope"), Some("nope"), Some("nope"), Some("no@one.com"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn email_plausibility_is_checked_before_sending() {
        assert!(is_plausible_email("a@b.co"));
        assert!(is_plausible_email("first.last+tag@sub.example.com"));
        assert!(!is_plausible_email("no-at-sign"));
        assert!(!is_plausible_email("@example.com"));
        assert!(!is_plausible_email("a@b"));
        assert!(!is_plausible_email("a@b.com extra"));
        assert!(!is_plausible_email("two@at@signs.com"));
    }
}
