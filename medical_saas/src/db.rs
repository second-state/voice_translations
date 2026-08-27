//! The embedded SQLite database: accounts, magic-link and session tokens,
//! subscription state, and the word-usage ledger the quota is computed from.
//!
//! One file on disk, created and migrated at startup by
//! [`crate::migrations`] — the schema itself lives in `sql/migrations/`,
//! compiled into the binary. Every operation here is a short synchronous
//! statement — SQLite is microseconds fast at this size — so the connection
//! lives behind a plain mutex that is never held across an await point.
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

/// One account as the operator's dashboard sees it: the account row plus the
/// aggregates over its usage.
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserRow {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub subscription_status: Option<String>,
    pub created_at: i64,
    /// Last authenticated request, to the resolution below.
    pub last_seen_at: Option<i64>,
    pub subscribed_at: Option<i64>,
    pub unsubscribed_at: Option<i64>,
    /// Last turn actually spoken, which is a narrower thing than being seen.
    pub last_used_at: Option<i64>,
    pub words_window: i64,
    pub words_total: i64,
    pub turns: i64,
}

impl AdminUserRow {
    /// The later of being seen and speaking. An account can be signed in
    /// without saying anything, and a long visit leaves no page loads.
    pub fn last_active(&self) -> Option<i64> {
        match (self.last_seen_at, self.last_used_at) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        }
    }
}

/// One Stripe webhook as the dashboard shows it.
#[derive(Debug, Clone, Serialize)]
pub struct PaymentEvent {
    /// Stripe's event id (`evt_…`).
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub status: Option<String>,
    /// In the currency's minor unit, as Stripe sends it; null when the event
    /// moved no money.
    pub amount_cents: Option<i64>,
    pub currency: Option<String>,
    pub object_id: Option<String>,
    pub created_at: i64,
}

/// How stale `last_seen_at` may get before another write is worth it.
const LAST_SEEN_RESOLUTION_SECS: i64 = 300;

pub const PLAN_FREE: &str = "free";
pub const PLAN_PRO: &str = "pro";

/// Handle to the account database.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Open (creating if needed) the database at `path` and migrate it.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let mut conn = Connection::open(path).with_context(|| {
            format!("failed to open the account database at {}", path.display())
        })?;
        Self::prepare(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// An in-memory database, for tests. Built by the same migration chain as
    /// a real one, so a test is never run against a schema that only exists
    /// in the test.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::prepare(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Connection settings, then the schema. `journal_mode` is a property of
    /// the file and `foreign_keys` of the connection, so neither belongs in a
    /// migration; both are set before one runs.
    fn prepare(conn: &mut Connection) -> Result<()> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .context("failed to configure the account database")?;
        crate::migrations::run(conn).context("failed to migrate the account database")
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
                        -- A renewal must not move the date they subscribed;
                        -- only the free-to-paid transition does.
                        subscribed_at = CASE WHEN plan = ?1 THEN COALESCE(subscribed_at, ?5)
                                             ELSE ?5 END,
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
                "UPDATE users SET plan = ?1, subscription_status = ?2,
                        unsubscribed_at = ?3, updated_at = ?3
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

    /// Note that this account did something just now.
    ///
    /// Called on every authenticated request, so it writes at most once every
    /// few minutes per account: the dashboard wants to know who is still
    /// around, not to the second.
    pub fn touch_last_seen(&self, user_id: &str) -> Result<()> {
        let ts = now();
        self.with(|conn| {
            conn.execute(
                "UPDATE users SET last_seen_at = ?1 WHERE id = ?2
                 AND (last_seen_at IS NULL OR last_seen_at < ?3)",
                params![ts, user_id, ts - LAST_SEEN_RESOLUTION_SECS],
            )
        })?;
        Ok(())
    }

    /// Open an admin session. The password's hash is stored alongside it, so
    /// changing the password in the configuration ends every session that was
    /// opened with the old one.
    pub fn set_admin_session(&self, token: &str, password_hash: &str, expires: i64) -> Result<()> {
        let hash = hash_token(token);
        let ts = now();
        self.with(|conn| {
            conn.execute("DELETE FROM admin_sessions WHERE expires_at <= ?1", params![ts])?;
            conn.execute(
                "INSERT OR REPLACE INTO admin_sessions (token_hash, password_hash, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![hash, password_hash, ts, expires],
            )
        })?;
        Ok(())
    }

    /// Whether this cookie is a live admin session opened with the password
    /// currently configured.
    pub fn admin_session_valid(&self, token: &str, password_hash: &str) -> Result<bool> {
        let hash = hash_token(token);
        let ts = now();
        self.with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM admin_sessions
                 WHERE token_hash = ?1 AND password_hash = ?2 AND expires_at > ?3",
                params![hash, password_hash, ts],
                |r| r.get::<_, i64>(0),
            )
        })
        .map(|n| n > 0)
    }

    pub fn clear_admin_session(&self, token: &str) -> Result<()> {
        let hash = hash_token(token);
        self.with(|conn| {
            conn.execute(
                "DELETE FROM admin_sessions WHERE token_hash = ?1",
                params![hash],
            )
        })?;
        Ok(())
    }

    /// Every account with the numbers the dashboard shows, newest first.
    ///
    /// One statement rather than a query per user: the two aggregates over
    /// the usage ledger are grouped once and joined, so the cost does not
    /// grow with the number of accounts on the page.
    pub fn admin_user_rows(&self, window_secs: i64, limit: i64) -> Result<Vec<AdminUserRow>> {
        let cutoff = now() - window_secs;
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT u.id, u.email, u.plan, u.subscription_status, u.created_at,
                        u.last_seen_at, u.subscribed_at, u.unsubscribed_at,
                        COALESCE(all_time.words, 0), COALESCE(all_time.turns, 0),
                        all_time.last_used, COALESCE(recent.words, 0)
                 FROM users u
                 LEFT JOIN (SELECT user_id, SUM(words) AS words, COUNT(*) AS turns,
                                   MAX(created_at) AS last_used
                            FROM word_usage GROUP BY user_id) all_time
                        ON all_time.user_id = u.id
                 LEFT JOIN (SELECT user_id, SUM(words) AS words FROM word_usage
                            WHERE created_at > ?1 GROUP BY user_id) recent
                        ON recent.user_id = u.id
                 ORDER BY u.created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![cutoff, limit], |row| {
                Ok(AdminUserRow {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    plan: row.get(2)?,
                    subscription_status: row.get(3)?,
                    created_at: row.get(4)?,
                    last_seen_at: row.get(5)?,
                    subscribed_at: row.get(6)?,
                    unsubscribed_at: row.get(7)?,
                    words_total: row.get(8)?,
                    turns: row.get(9)?,
                    last_used_at: row.get(10)?,
                    words_window: row.get(11)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// Record one Stripe webhook against the account it concerns.
    ///
    /// Keyed by Stripe's event id, so a redelivery — which Stripe does on any
    /// non-2xx, and may do anyway — is stored once.
    #[allow(clippy::too_many_arguments)]
    pub fn record_payment_event(
        &self,
        event_id: &str,
        user_id: &str,
        event_type: &str,
        status: Option<&str>,
        amount_cents: Option<i64>,
        currency: Option<&str>,
        object_id: Option<&str>,
        created_at: i64,
    ) -> Result<()> {
        self.with(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO payment_events
                     (id, user_id, type, status, amount_cents, currency, object_id,
                      created_at, recorded_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    event_id,
                    user_id,
                    event_type,
                    status,
                    amount_cents,
                    currency,
                    object_id,
                    created_at,
                    now()
                ],
            )
        })?;
        Ok(())
    }

    /// One account's billing history, newest first.
    pub fn payment_events_for_user(&self, user_id: &str, limit: i64) -> Result<Vec<PaymentEvent>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, type, status, amount_cents, currency, object_id, created_at
                 FROM payment_events WHERE user_id = ?1
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![user_id, limit], |row| {
                Ok(PaymentEvent {
                    id: row.get(0)?,
                    event_type: row.get(1)?,
                    status: row.get(2)?,
                    amount_cents: row.get(3)?,
                    currency: row.get(4)?,
                    object_id: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// How many billing events each account has, so the dashboard can show
    /// which rows are worth opening without fetching them all.
    pub fn payment_event_counts(&self) -> Result<std::collections::HashMap<String, i64>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT user_id, COUNT(*) FROM payment_events
                 WHERE user_id IS NOT NULL GROUP BY user_id",
            )?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()
        })
    }

    /// How many accounts exist, which the page reports when the list is
    /// capped.
    pub fn user_count(&self) -> Result<i64> {
        self.with(|conn| conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)))
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
    fn the_dashboard_query_reports_usage_inside_and_outside_the_window() {
        let db = db();
        let quiet = db.upsert_user("quiet@example.com").unwrap();
        let busy = db.upsert_user("busy@example.com").unwrap();

        db.record_words(&busy.id, 120, "clinician").unwrap();
        db.record_words(&busy.id, 80, "patient").unwrap();
        // One turn older than the window: all-time counts it, this week does not.
        db.record_words(&busy.id, 500, "patient").unwrap();
        db.with(|c| {
            c.execute(
                "UPDATE word_usage SET created_at = ?1 WHERE words = 500",
                params![now() - 604_800 - 60],
            )
        })
        .unwrap();

        let rows = db.admin_user_rows(604_800, 100).unwrap();
        assert_eq!(rows.len(), 2);
        let row = rows.iter().find(|r| r.id == busy.id).unwrap();
        assert_eq!(row.words_window, 200);
        assert_eq!(row.words_total, 700);
        assert_eq!(row.turns, 3);
        assert!(row.last_used_at.is_some());

        // An account that has never spoken still appears, with zeros.
        let row = rows.iter().find(|r| r.id == quiet.id).unwrap();
        assert_eq!((row.words_window, row.words_total, row.turns), (0, 0, 0));
        assert!(row.last_used_at.is_none());
        assert!(row.last_active().is_none());
    }

    #[test]
    fn last_active_takes_the_later_of_being_seen_and_speaking() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.touch_last_seen(&user.id).unwrap();
        let seen_only = db.admin_user_rows(604_800, 10).unwrap();
        let row = &seen_only[0];
        assert!(row.last_seen_at.is_some() && row.last_used_at.is_none());
        assert_eq!(row.last_active(), row.last_seen_at);

        // A turn spoken after that moves it on.
        db.with(|c| {
            c.execute(
                "UPDATE users SET last_seen_at = ?1 WHERE id = ?2",
                params![now() - 900, user.id],
            )
        })
        .unwrap();
        db.record_words(&user.id, 10, "patient").unwrap();
        let row = db.admin_user_rows(604_800, 10).unwrap().remove(0);
        assert_eq!(row.last_active(), row.last_used_at);
    }

    #[test]
    fn last_seen_is_not_rewritten_on_every_request() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.touch_last_seen(&user.id).unwrap();
        let first: i64 = db
            .with(|c| {
                c.query_row(
                    "SELECT last_seen_at FROM users WHERE id = ?1",
                    params![user.id],
                    |r| r.get(0),
                )
            })
            .unwrap();

        // A second request moments later leaves the stamp alone.
        db.touch_last_seen(&user.id).unwrap();
        let again: i64 = db
            .with(|c| {
                c.query_row(
                    "SELECT last_seen_at FROM users WHERE id = ?1",
                    params![user.id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(first, again);

        // Once the stamp is stale, the next request refreshes it.
        db.with(|c| {
            c.execute(
                "UPDATE users SET last_seen_at = ?1 WHERE id = ?2",
                params![now() - LAST_SEEN_RESOLUTION_SECS - 1, user.id],
            )
        })
        .unwrap();
        db.touch_last_seen(&user.id).unwrap();
        let refreshed: i64 = db
            .with(|c| {
                c.query_row(
                    "SELECT last_seen_at FROM users WHERE id = ?1",
                    params![user.id],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(refreshed > now() - 5);
    }

    #[test]
    fn subscribing_is_dated_once_and_cancelling_is_dated_too() {
        let db = db();
        let user = db.upsert_user("a@b.com").unwrap();
        db.activate_subscription(&user.id, Some("cus_1"), Some("sub_1"), "active")
            .unwrap();
        let subscribed = db
            .admin_user_rows(604_800, 10)
            .unwrap()
            .remove(0)
            .subscribed_at;
        assert!(subscribed.is_some());

        // A renewal keeps the original date rather than moving it forward.
        db.with(|c| {
            c.execute(
                "UPDATE users SET subscribed_at = ?1 WHERE id = ?2",
                params![now() - 86_400, user.id],
            )
        })
        .unwrap();
        db.activate_subscription(&user.id, None, None, "active")
            .unwrap();
        let row = db.admin_user_rows(604_800, 10).unwrap().remove(0);
        assert_eq!(row.subscribed_at, Some(now() - 86_400));
        assert!(row.unsubscribed_at.is_none());

        db.deactivate_subscription(&user.id, "canceled").unwrap();
        let row = db.admin_user_rows(604_800, 10).unwrap().remove(0);
        assert!(row.unsubscribed_at.is_some());
        // The date they first subscribed survives the cancellation.
        assert_eq!(row.subscribed_at, Some(now() - 86_400));

        // Subscribing again after a cancellation does move the date.
        db.activate_subscription(&user.id, None, None, "active")
            .unwrap();
        let row = db.admin_user_rows(604_800, 10).unwrap().remove(0);
        assert!(row.subscribed_at.unwrap() > now() - 5);
    }

    #[test]
    fn admin_sessions_expire_and_die_with_the_password() {
        let db = db();
        let token = generate_token();
        let pw = hash_token("correct horse battery staple");
        db.set_admin_session(&token, &pw, now() + 3600).unwrap();
        assert!(db.admin_session_valid(&token, &pw).unwrap());

        // A different password means this session was opened with the old one.
        assert!(!db
            .admin_session_valid(&token, &hash_token("rotated"))
            .unwrap());
        assert!(!db.admin_session_valid("not-a-token", &pw).unwrap());

        db.clear_admin_session(&token).unwrap();
        assert!(!db.admin_session_valid(&token, &pw).unwrap());

        let stale = generate_token();
        db.set_admin_session(&stale, &pw, now() - 1).unwrap();
        assert!(!db.admin_session_valid(&stale, &pw).unwrap());
    }

    #[test]
    fn payment_events_are_stored_once_per_stripe_event() {
        let db = db();
        let user = db.upsert_user("payer@example.com").unwrap();

        db.record_payment_event(
            "evt_1",
            &user.id,
            "invoice.paid",
            Some("paid"),
            Some(2000),
            Some("usd"),
            Some("in_1"),
            now() - 60,
        )
        .unwrap();
        // Stripe redelivers on any non-2xx; the event id keeps that to one row.
        db.record_payment_event(
            "evt_1",
            &user.id,
            "invoice.paid",
            Some("paid"),
            Some(2000),
            Some("usd"),
            Some("in_1"),
            now() - 60,
        )
        .unwrap();
        db.record_payment_event(
            "evt_2",
            &user.id,
            "customer.subscription.deleted",
            Some("canceled"),
            None,
            None,
            Some("sub_1"),
            now(),
        )
        .unwrap();

        let events = db.payment_events_for_user(&user.id, 100).unwrap();
        assert_eq!(events.len(), 2);
        // Newest first.
        assert_eq!(events[0].id, "evt_2");
        assert_eq!(events[0].amount_cents, None);
        assert_eq!(events[1].event_type, "invoice.paid");
        assert_eq!(events[1].amount_cents, Some(2000));
        assert_eq!(events[1].currency.as_deref(), Some("usd"));

        let counts = db.payment_event_counts().unwrap();
        assert_eq!(counts.get(&user.id).copied(), Some(2));

        // An account nobody has paid for has no history and no count.
        let other = db.upsert_user("free@example.com").unwrap();
        assert!(db
            .payment_events_for_user(&other.id, 100)
            .unwrap()
            .is_empty());
        assert!(!counts.contains_key(&other.id));
    }

    #[test]
    fn the_dashboard_row_carries_its_billing_count() {
        let db = db();
        let user = db.upsert_user("payer@example.com").unwrap();
        db.record_payment_event(
            "evt_1",
            &user.id,
            "invoice.paid",
            None,
            Some(2000),
            Some("usd"),
            None,
            now(),
        )
        .unwrap();
        let counts = db.payment_event_counts().unwrap();
        let rows = db.admin_user_rows(604_800, 10).unwrap();
        assert_eq!(counts.get(&rows[0].id).copied(), Some(1));
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
