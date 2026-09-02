//! Schema migrations: the ordered list, and the runner that applies it.
//!
//! Each migration is a numbered file under `sql/migrations/`, compiled into
//! the binary by `include_str!` below — the folder is a development artifact,
//! never something a deployment has to carry. Adding one means writing the
//! file and adding a line here; a test keeps the two in step.
//!
//! Applied versions are recorded in `schema_migrations`, so every migration
//! runs exactly once and in order. A database created before this table
//! existed still works: `0001_initial` is written entirely with
//! `IF NOT EXISTS`, so replaying it against the schema it describes changes
//! nothing, and the chain carries on from there.

use anyhow::{Context, Result};
use rusqlite::Connection;

/// Every migration, oldest first. Order is the order they are applied in.
pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_initial",
        include_str!("../sql/migrations/0001_initial.sql"),
    ),
    (
        "0002_admin_dashboard",
        include_str!("../sql/migrations/0002_admin_dashboard.sql"),
    ),
    (
        "0003_payment_events",
        include_str!("../sql/migrations/0003_payment_events.sql"),
    ),
    (
        "0004_activation",
        include_str!("../sql/migrations/0004_activation.sql"),
    ),
];

/// Bring the database up to the latest schema.
///
/// Each migration runs inside its own transaction together with the row that
/// records it, so an interrupted upgrade leaves the database on a version
/// boundary rather than half-way through one.
pub fn run(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    TEXT PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );",
    )
    .context("failed to create the schema_migrations table")?;

    for (version, sql) in MIGRATIONS {
        let applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            [version],
            |row| row.get(0),
        )?;
        if applied {
            continue;
        }

        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .with_context(|| format!("migration {version} failed"))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, crate::db::now()],
        )?;
        tx.commit()?;
        tracing::info!("applied database migration {version}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        conn
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn a_fresh_database_ends_up_with_every_table() {
        let conn = migrated();
        for table in ["users", "word_usage", "admin_sessions", "payment_events"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{table} is missing");
        }
        assert!(columns(&conn, "users").contains(&"subscribed_at".to_string()));
    }

    #[test]
    fn every_migration_is_recorded_and_running_again_does_nothing() {
        let mut conn = migrated();
        let recorded: Vec<String> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let expected: Vec<String> = MIGRATIONS.iter().map(|(v, _)| v.to_string()).collect();
        assert_eq!(recorded, expected);

        // Idempotent: the second run applies nothing, which is what makes an
        // ordinary restart safe.
        run(&mut conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn a_database_from_before_migrations_is_upgraded_in_place() {
        // Exactly the shape v0.1.7 created, with a row in it and no
        // schema_migrations table.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../sql/migrations/0001_initial.sql"))
            .unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, email, plan, created_at, updated_at)
             VALUES ('u1', 'old@example.com', 'free', 1, 1);",
        )
        .unwrap();
        assert!(!columns(&conn, "users").contains(&"last_seen_at".to_string()));

        run(&mut conn).unwrap();

        // The account survived and the new columns are there.
        let email: String = conn
            .query_row("SELECT email FROM users WHERE id = 'u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(email, "old@example.com");
        assert!(columns(&conn, "users").contains(&"last_seen_at".to_string()));
        // 0001 replayed against its own schema without complaint, and is
        // recorded so it will not be replayed again.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn accounts_that_predate_activation_tracking_cannot_report_a_signup() {
        // The upgrade a live deployment actually performs: rows already in
        // the table, then 0004 arrives. Those accounts have signed in
        // already, so none of them may look like a first activation the next
        // time they follow a link — that would be a conversion reported for
        // someone who signed up months ago.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../sql/migrations/0001_initial.sql"))
            .unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, email, plan, created_at, updated_at)
             VALUES ('u1', 'old@example.com', 'free', 111, 111),
                    ('u2', 'older@example.com', 'free', 222, 222);",
        )
        .unwrap();

        run(&mut conn).unwrap();

        let unactivated: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE activated_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unactivated, 0, "an existing account was left uncounted");
        let dated: i64 = conn
            .query_row("SELECT activated_at FROM users WHERE id = 'u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(dated, 111, "the backfill should use the account's own date");
    }

    #[test]
    fn the_registry_matches_the_files_on_disk() {
        // The scripts are compiled in, so a file nobody registered would
        // simply never run — and the mistake would be invisible until a
        // deployment was missing a table. This test only reads the repo, and
        // the binary it guards has no such dependency.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("sql/migrations");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("sql/migrations should exist in the source tree")
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                name.strip_suffix(".sql").map(str::to_string)
            })
            .collect();
        on_disk.sort();

        let registered: Vec<String> = MIGRATIONS.iter().map(|(v, _)| v.to_string()).collect();
        let mut sorted = registered.clone();
        sorted.sort();

        assert_eq!(on_disk, sorted, "sql/migrations and MIGRATIONS disagree");
        assert_eq!(
            registered, sorted,
            "MIGRATIONS must be listed in version order"
        );

        // Numbered from one, with no gaps, so the order is unambiguous.
        for (index, version) in registered.iter().enumerate() {
            let expected = format!("{:04}_", index + 1);
            assert!(
                version.starts_with(&expected),
                "{version} should start with {expected}"
            );
        }
    }
}
