# saas_core

The hosted-service layer that the `*_saas` apps in this workspace share:
accounts in an embedded SQLite database, passwordless sign-in by emailed
magic link, a rolling weekly word allowance on the free plan, Stripe
subscriptions for unlimited use, the operator's dashboard, and the numbered
SQL migrations behind all of it.

This is a library. Nothing in it knows what is being translated: the
[medical](../medical_saas/) and [conference](../conf_saas/) editions each
hold one `SaasState` inside their own state, merge `saas_core::routes()` into
their router, and add only their domain and their UI. A change to how
accounts, quota, or billing work lands in both at once.

## Using it from an app

```rust
use axum::{extract::FromRef, Router};
use saas_core::{SaasConfig, SaasState};

#[derive(Clone)]
struct HostedState {
    base: voice_translations::AppState,   // the speech pipeline
    saas: SaasState,                       // this crate
    // ...the app's own domain settings...
}

// Every handler here takes `State<SaasState>`; this is what lets them pull
// it out of the app's state.
impl FromRef<HostedState> for SaasState {
    fn from_ref(state: &HostedState) -> SaasState {
        state.saas.clone()
    }
}

// At startup: parse this crate's sections out of the app's config.toml,
// open (and migrate) the database, and assemble the state.
let saas_cfg = SaasConfig::parse(&raw_toml, "Product Name")?;
let saas = SaasState::open(saas_cfg, base.http.clone(), "Product Name")?;
saas_core::report_configuration(&saas.cfg);

let app = Router::new()
    .merge(saas_core::routes())      // accounts, billing, the dashboard
    // ...the app's pages and domain API...
    .with_state(HostedState { base, saas, /* ... */ });
```

In the app's own handlers, `auth::require_user(&state.saas, &headers)`
resolves the account, `state.saas.enforce_quota(&user)` refuses a free
account that has spent its allowance (HTTP 402 with the standing attached),
`state.saas.db.record_words(...)` spends it, and `quota::count_words` counts
a transcript the way the allowance expects.

The one thing this crate needs from the app is a name — what the sign-in
email calls the product and what the dashboard is titled — since the browser
gets its own, translated, from the app's interface catalogue.

## What is in it

| Module | What it does |
| --- | --- |
| `config` | `[auth] [email] [quota] [stripe] [admin]`, parsed out of the app's `config.toml` and validated |
| `state` | `SaasState`: the settings, the database, the shared HTTP client, the brand; `quota_for` and `enforce_quota` |
| `db` | SQLite: accounts, hashed magic-link and session tokens, subscription state, the word ledger, admin sessions, payment events |
| `migrations` | The registry of `sql/migrations/*.sql`, compiled in, and the runner that applies each once in its own transaction |
| `auth` | `POST /auth/request`, `GET /verify`, `POST /auth/logout`, `GET /api/me`; the sign-in email |
| `quota` | The rolling seven-day allowance and CJK-aware word counting |
| `billing` | Stripe Checkout and billing portal, and the signed webhook that is the only thing that ever changes a plan |
| `admin` | `/admin`: the operator's dashboard behind one password, and its API |
| `error` | The JSON error type with stable codes (`unauthorized`, `quota_exceeded`, …) |
| `routes` | All of the above mounted on one `Router`, for the app to merge |

`static/admin.html` and `static/admin.js` are the dashboard page, served by
`admin` with the app's name substituted in.

The behaviour of each of these — how sign-in works, how the allowance is
counted, how a plan changes, what the dashboard shows — is documented in the
[medical edition's README](../medical_saas/README.md), which is the same
service with a different translator in front of it.

## Database migrations

The schema lives in `sql/migrations/` as numbered files — `0001_initial.sql`,
`0002_admin_dashboard.sql`, `0003_payment_events.sql` — and every one of them
is compiled into the app binaries with `include_str!`. A deployment is still
one binary and one config file: the folder is a source artifact, and nothing
looks for it at runtime.

Applied versions are recorded in a `schema_migrations` table, so each
migration runs exactly once, in order, each inside its own transaction
together with the row that records it. An interrupted upgrade therefore
leaves the database on a version boundary rather than half-way through one.

A database created before any of this existed still upgrades in place:
`0001_initial.sql` is written entirely with `IF NOT EXISTS`, so replaying it
against the schema it describes changes nothing, and the chain carries on
from `0002`.

To add one: write `sql/migrations/NNNN_what_it_does.sql`, add a line to
`MIGRATIONS` in `src/migrations.rs`, and write the test that would fail
without it. A test compares the registry against the files on disk, so a
script nobody registered fails the build rather than silently never running.

Migrations are forward-only. There is no `down`: rolling back a schema on a
live database is a restore-from-backup exercise, not a script.

Both hosted apps share this schema, but not a database: each deployment has
its own SQLite file, named by its own `[auth] database`.
