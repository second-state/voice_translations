# Medical Translator — hosted edition

The two-way patient/clinician translator of
[`medical_translations`](../medical_translations/), run as a service: user
accounts in an embedded SQLite database, passwordless sign-in by emailed
magic link, a rolling weekly word allowance on the free plan, and Stripe
subscriptions for unlimited use.

**This crate contains only the glue and its UI.** Everything it translates,
every way it translates, and everything that makes it a service comes from
its three dependencies, not from copies:

| Comes from | What |
| --- | --- |
| [`voice_translations`](../) | The whole speech pipeline: Silero VAD assets, the ASR call, streaming LLM translation, TTS, config loading, the CLI, and the HTTPS middleware |
| [`medical_translations`](../medical_translations/) | The medical domain: the 19 specialties, the translation rules, mishearing repair, the per-language clinical notes, and the prompt files behind them |
| [`saas_core`](../saas_core/) | The service: accounts, magic-link sign-in, sessions, the rolling word quota, Stripe checkout and webhooks, the operator's dashboard, and the SQL migrations behind them — shared with the hosted [conference translator](../conf_saas/) |

So a change to how medicine is translated lands in the standalone app and
here at once, a change to how accounts or billing work lands in both hosted
apps at once, and this crate implements no speech, model, or account
plumbing of its own. The sections below describe how that service behaves;
the code is in `saas_core`.

## Interface language

The landing page, the sign-in page, and the console are all translated into
**English, 简体中文, 繁體中文, Español, 한국어, and 日本語**.

The language follows the browser on a first visit — `zh-TW`, `zh-HK` and
anything tagged `Hant` get traditional characters, everything else Chinese
gets simplified — and a picker on every page overrides it. A hand-picked
language persists across sessions. `?lang=ja` on any URL selects one for that
visit and remembers it, which is useful for sending someone a link in the
language they read.

**The patient's language starts as the interface language.** Someone reading
the console in Spanish is, by default, sitting with a Spanish-speaking
patient; switching the interface to Korean moves the patient side with it.
The exception is when that would make both sides of the encounter the same
language, in which case the configured `patient_language` is kept, since two
identical sides have nothing to translate. Once either language is chosen by
hand — in the pickers or with the swap button — that pair is remembered and
stops following the interface until it is changed again.

Interface language and the chosen pair live in the browser's local storage,
alongside the transcript, so they are per browser rather than per account:
signing in on a different workstation starts from the browser's own
preference again.

All six catalogues live in [`static/i18n.js`](static/i18n.js) and are
key-for-key identical; a string missing from one language falls back to
English rather than showing a bare key.

## Pages

| Path | What it is |
| --- | --- |
| `/` | Public landing page: what the service does, and the free vs. subscription plans. Links straight into the app when a session is found. |
| `/login` | Sign-in page: enter an email, receive a link. |
| `/verify` | What a sign-in link opens: a confirmation naming the account, whose one button posts to `/verify/confirm` — the request that actually signs in. |
| `/app` | The translator console. Anonymous visitors are sent to `/login`, and every API it calls requires a session regardless. |
| `/admin` | The operator's dashboard, behind one password. Absent entirely unless `[admin] password` is set. |

## Accounts

**Signing up and logging in are the same act.** A visitor types an email
address; the server mints a single-use token, mails a link containing it, and
exchanges that link for a session cookie. The first link sent to an address
creates the account it activates. There is no password to choose, store,
reset, or leak.

- `POST /auth/request` `{email}` — mail a sign-in link. Answers identically
  whether or not the address already has an account, so the endpoint cannot
  be used to discover who has one.
- `GET /verify?token=…` — what the link in the email opens. It looks the
  token up, checks its expiry, and renders a small page naming the account
  with one **Continue** button. It is side-effect-free by contract: no
  session, no cookie, and the token is not touched, so it can be fetched any
  number of times.
- `POST /verify/confirm` `token=…` — what the button posts. The only place a
  token is consumed: it is validated again here, then cleared, and an
  `HttpOnly; SameSite=Lax` session cookie (with `Secure` whenever the request
  arrived over HTTPS) is set before redirecting to the app. A link works
  exactly once and expires.
- `POST /auth/logout` — end the session and clear the cookie.
- `GET /api/me` — who is signed in, their plan, and their current allowance.

Redemption is split in two because corporate mail security — Microsoft
Defender Safe Links, Proofpoint URL Defense, Mimecast and their kind — fetches
every URL in a message before the recipient ever sees it. A single GET that
consumed the token would be consumed by the scanner, leaving the person a dead
link. The alternative, reusable links, would weaken every link for every user
to accommodate some mailboxes; instead the GET changes nothing and the POST
does everything. The two are distinct paths rather than two methods on one
path, so that "nothing under `GET /verify` ever mutates" can be checked by
grep, and so proxies, CDNs and WAF rules can key on the URL.

When a link cannot be redeemed at either step, the browser is sent (303) to
`/login?error=invalid_link` — never issued, or already used — or
`/login?error=expired_link`. The sign-in page maps each code to its own
translated message above the email field and renders nothing for a code it
does not know, so the URL carries a code and never text. The two are kept
apart because they call for different reactions: an expired link just needs a
fresh one, a used link may mean someone else opened it.

Tokens are stored as SHA-256 hashes, never in the clear, so a leaked copy of
the database yields no usable session or sign-in link.

Without a mail provider configured, sign-in links are written to the server
log — enough to run locally. Setting `dev_echo_link` additionally returns the
link in the HTTP response; it is refused when an API key is present so it
cannot be left on in production by accident.

## The free allowance

A free account may translate **5,000 spoken words per rolling seven-day
window** (`[quota] free_words_per_week`). Paid accounts are unlimited.

- **Both sides count.** The clinician's turns and the patient's draw on the
  same allowance. The ledger labels each turn by role, inferred from the
  detected language, but the label is bookkeeping only.
- **Spoken words, counted once.** The allowance is spent when a turn is
  transcribed. Translations are free: one utterance costs the same
  whatever the target language needs, and reading a turn aloud costs nothing.
- **Rolling, literally.** Usage is summed from this instant back over seven
  days, so there is no reset hour, no calendar week to game, and no cliff:
  the allowance returns gradually as the oldest turns fall out of the window.
  `GET /api/me` reports when the next words free up.
- **Counting across scripts.** Space-delimited languages count whitespace
  tokens. Chinese and Japanese do not put spaces between words, so each
  ideograph counts as one and each unbroken run of kana counts as one — an
  approximation, but a stable and explainable one, which is what an allowance
  needs to be.

An account that is out of words gets HTTP 402 with its current standing
attached, on both `/api/transcribe` and `/api/translate`, so a client that
ignores the first cannot simply call the second.

## The dashboard

Set a password and `/admin` shows every account: address, plan, when they
subscribed or cancelled, when they were last active, and the words they have
spoken — this rolling week and in total. The list sorts by any column and
filters by plan, by activity, and by a search on the address.

```toml
[admin]
password = "something long and random"
session_hours = 12
```

Leave `password` empty and the dashboard is not there: `/admin`, its script,
and every `/api/admin/*` route answer 404, so a deployment that does not want
one is not quietly running a login form over its own user list. The server
says at startup whether the dashboard is on, and warns when the password is
under 12 characters — it is the only thing between the internet and every
user's email address.

There is no admin account, just the password. It buys a session cookie
(`HttpOnly`, `SameSite=Lax`, `Secure` behind HTTPS) rather than being re-sent
with each request, and the session records a hash of the password that opened
it: **change the password and restart, and every session opened with the old
one stops working.** That is the way to cut off a password you think has
leaked. A wrong guess takes 600 ms to be told so, which is what makes guessing
at a single shared secret impractical; the delay is fixed rather than
escalating, so nobody can lock the operator out by guessing badly on purpose.

Click a row and its Stripe history opens beside the table: every webhook that
resolved to that account, newest first, with what Stripe called it, the amount
it moved, and the object id to match against the Stripe dashboard. Failed
payments are shown as failed rather than as money collected, and events that
moved no money — a plan change, a cancellation — are still listed, because the
question being asked is usually "why is this account not paid?"

Four columns are worth knowing how they are built:

- **Last active** is the later of two things — the last request made with a
  session, and the last turn actually spoken. An account can be signed in
  without saying anything, and a long visit leaves no page loads behind. The
  first is recorded at most once every five minutes per account, so a polling
  console does not turn into a write per request.
- **Words this week** is the same rolling seven-day sum the quota enforces, so
  a free account at or over its allowance is shown in amber. **Words total**
  is every turn ever recorded.
- **Billing** counts the Stripe events recorded against the account, so it is
  clear which rows have a history to open. Events are stored under Stripe's
  own event id, so a redelivery — which Stripe does on any non-2xx — is stored
  once rather than twice.
- **Activated** is when the account's first sign-in link was redeemed —
  distinct from **Joined**, which is when the address was typed into the
  form. An account that requested a link and never opened the email shows
  `Not yet`. The plan filter distinguishes `Paid` (billed through Stripe)
  from `Comped` (granted from the dashboard); the summary line keeps the
  same split.

Recording happens in the webhook handler, so it captures deliveries the app
otherwise ignores: `invoice.paid` and `invoice.payment_failed` change no plan
but are the two events most worth seeing later. Anything Stripe sends that
resolves to an account is kept; anything that resolves to nobody is logged and
dropped, as before.

The drawer that opens on a row is also where plans are managed by hand, and
every action it takes is written into the account's billing history alongside
the Stripe events, as an `admin.*` row.

**Granting the unlimited plan** — for a partner, a tester, someone comped
for a month. A grant is marked `Comped`: paid-plan access with nothing billed
and no Stripe record behind it, removable from the same place. If the user
later subscribes through Stripe, the checkout webhook takes the subscription
over — they stay subscribed, the events log as usual — and from then on
Stripe's lifecycle governs the account. One edge is deliberate: a Stripe
cancellation arriving while the account is still merely comped changes
nothing, since a stale `deleted` for a long-ended subscription must not take
away a grant made afterwards.

**Cancelling a paid subscription** — a subscription Stripe is billing is
never flipped in the database (the charges would continue and the next
renewal event would hand the access straight back); the drawer instead asks
Stripe to cancel it. *Cancel at period end* stops the charges and lets the
user keep what they paid for, the account returning to the free plan when
Stripe's `deleted` event arrives at expiry. *Cancel immediately* is for
abuse: access ends at once, and Stripe refunds nothing by itself — the rest
of the period is forfeited unless refunded by hand in Stripe.

Beyond those writes there is no way to edit an account or read a
transcript — transcripts are never on the server to begin with.

## Subscriptions

`POST /api/billing/checkout` opens a Stripe Checkout session for the
signed-in account and returns the hosted URL; `POST /api/billing/portal`
sends an existing subscriber to Stripe's billing portal to change a card or
cancel.

**The browser never changes a plan.** It can start a checkout, but an
account moves between free and paid only through `POST /stripe/webhook` —
solely for a delivery carrying a valid `Stripe-Signature` — or by the
operator granting a subscription from the dashboard (see above).

Leaving `[stripe]` empty runs the service without paid plans: every account
stays free and the upgrade button disappears.

### Setting up Stripe

Do all of this in **Test mode** first (the toggle in the Stripe dashboard).
Test and live mode have separate keys, separate products, and separate
webhook endpoints — mixing them is the most common reason a subscription
never activates.

**1. Create the product and its monthly price.**
Dashboard → *Product catalogue* → *Add product*. Give it a name, then add a
**recurring** price — say USD 20.00, billing period *Monthly*. Save, open the
price, and copy its id (`price_…`). A one-off price will not work: the app
opens Checkout in `mode=subscription`, which requires a recurring price.

```toml
[stripe]
price_id = "price_1AbCdEf…"
```

**2. Copy the secret API key.**
Dashboard → *Developers* → *API keys* → *Secret key* (`sk_test_…` in test
mode, `sk_live_…` in live mode). This is a server-side secret: it belongs in
`config.toml`, never in the browser.

```toml
secret_key = "sk_test_…"
```

**3. Create the webhook endpoint.**
Dashboard → *Developers* → *Webhooks* → *Add endpoint*.

- **Endpoint URL:** `https://<your-host>/stripe/webhook` — the same host as
  `[email] base_url`, reachable from the public internet over HTTPS.
- **Events to send:** exactly these four. Nothing else is read, and each one
  is load-bearing:

  | Event | Why it is needed |
  | --- | --- |
  | `checkout.session.completed` | The first payment succeeded. Marks the account paid and stores its Stripe customer and subscription ids. Without this, a user pays and stays on the free plan. |
  | `customer.subscription.created` | Confirms the subscription exists, and covers flows where a subscription is created outside Checkout. |
  | `customer.subscription.updated` | Renewals, plan changes, payment trouble, and scheduled cancellations. This is what moves an account between paid and free as the status changes. |
  | `customer.subscription.deleted` | The subscription actually ended. Returns the account to the free plan. |

- Save, then **copy the signing secret** (`whsec_…`) shown on the endpoint's
  page — it is specific to *this* endpoint, and a different one is issued for
  the live-mode endpoint you create later.

```toml
webhook_secret = "whsec_…"
```

The webhook is deliberately unauthenticated — Stripe has no session cookie —
so the signature *is* the authentication. With `webhook_secret` empty, every
delivery is refused and no account can ever become paid; the server logs a
warning at startup saying so.

**4. Turn on the customer portal.**
Dashboard → *Settings* → *Billing* → *Customer portal* → save a
configuration (allow customers to cancel, and to update payment methods).
Until this is saved once per mode, `POST /api/billing/portal` fails with
Stripe's "No configuration provided" error and subscribers have no way to
cancel from inside the app.

**5. Check `base_url`.** Checkout returns the user to
`{base_url}/app?upgraded=1` on success and `{base_url}/app` on cancel, and
the portal returns to `{base_url}/app`. If `[email] base_url` is wrong,
payment still works but the user lands somewhere useless.

**6. Set `price_display` if you do not charge $20 a month.** Left empty, the
landing page prints its built-in figure, $20 / month, in whichever language
the visitor is reading. `price_display` replaces that (`"$35 / month"`,
`"€18 / month"`). It is cosmetic — Stripe charges whatever the price object
says and shows that amount at checkout — so a deployment on a different
price must set this, or the page quotes a figure it will not honour.

### Trying it locally

A local server has no public URL, so use the
[Stripe CLI](https://stripe.com/docs/stripe-cli) to forward events:

```sh
stripe login
stripe listen --forward-to localhost:8100/stripe/webhook
```

`stripe listen` prints its **own** signing secret (`whsec_…`), different from
the dashboard endpoint's. Put *that* one in `config.toml` while you are
forwarding, and remember to swap it back for deployment.

Then subscribe with the test card `4242 4242 4242 4242`, any future expiry,
any CVC. Or fire events directly:

```sh
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

Triggered events carry Stripe's own fixtures rather than your account's
metadata, so the server will log that no account matches and ignore them —
that is the identifier fallback working, not a failure. To exercise the real
path, click through Checkout as a signed-in user.

### Going live

Switch the dashboard to live mode and repeat steps 1–4 there: a live product
and price, the live secret key, a **new** webhook endpoint on your production
host with the same four events, and a saved live portal configuration. Then
put the live `sk_live_…`, `price_…`, and `whsec_…` into the deployment's
`config.toml`. Nothing carries over from test mode.

### How a plan actually changes

| Event | Effect |
| --- | --- |
| `checkout.session.completed` (subscription mode) | Plan → paid; the Stripe customer and subscription ids are stored |
| `customer.subscription.created` / `.updated` | `active`/`trialing`/`past_due` keep access; anything else returns the account to free |
| `customer.subscription.deleted` | Plan → free |

`past_due` deliberately keeps access while Stripe retries the card, so a
temporary card failure does not cut off an encounter in progress. A
cancellation naming a subscription the account has already replaced is
ignored, because deliveries are not ordered and a late `deleted` for an old
subscription must not downgrade a user who has resubscribed.

The account behind an event is resolved in this order: the `user_id` this app
put in the session metadata, then `client_reference_id`, then the stored
subscription id, then the stored customer id, then the billing email. Any one
of them is enough, which is why a renewal a year later still finds the right
user.

Signatures are verified with HMAC-SHA256 over the **raw** request body,
compared in constant time, and rejected outside a five-minute window so a
captured delivery cannot be replayed.

### When it does not work

| Symptom | Usual cause |
| --- | --- |
| Startup warns that `[stripe]` is not configured | `secret_key` or `price_id` is empty; billing stays off by design |
| Startup warns that `webhook_secret` is empty | Deliveries will be refused — paste the endpoint's signing secret |
| Webhook 400, log says *signature mismatch* | The secret belongs to a different endpoint, or test/live mode is crossed. The log prints both signature prefixes: unrelated values mean the wrong secret, matching-but-failing means something rewrote the body in transit |
| Webhook 400, log says *timestamp is Ns away* | The server clock has drifted more than five minutes, or the delivery is a replay |
| Webhook 200 but the plan never changes, log says *no account matches* | The event carries no metadata linking it to a user — typical of `stripe trigger` fixtures, or a subscription created by hand in the dashboard |
| Checkout returns 401 | The browser had no session; sign in first |
| Checkout returns *already has an active subscription* | The account is already paid — send them to the portal instead |
| Portal returns Stripe's *No configuration provided* | Step 4 was skipped in this mode |

Put the webhook path in front of any proxy that might buffer or rewrite
bodies: the signature covers the exact bytes Stripe sent, so a proxy that
re-encodes JSON will invalidate every delivery.

## Setup

```sh
cp config.example.toml config.toml   # then fill in endpoints, keys, and base_url
cargo run --release
```

Open http://127.0.0.1:8100 for the landing page, or go straight to
http://127.0.0.1:8100/app. With no `resend_api_key` set, the sign-in link
appears in the server log (and in the response, with `dev_echo_link = true`).

From the workspace root, pass the config path explicitly:

```sh
cargo run --release -p medical-saas -- --config medical_saas/config.toml
```

## Build and deploy

```sh
cargo build --release                    # all apps
cargo build --release -p medical-saas    # just this one
```

The binary is self-contained — the Silero VAD and onnxruntime assets are
compiled in — so a deployment is one binary, one config file, and the SQLite
file it creates beside them:

```sh
./medical-saas --config /etc/medical-saas.toml
# or
MEDICAL_SAAS_CONFIG=/etc/medical-saas.toml ./medical-saas
```

It defaults to port 8100, so it can run beside the conference translator
(8080) and the standalone translator (8090).

**Back up the database.** `[auth] database` is the only record of who has an
account and who has paid; the Stripe ids that reconnect a subscription to a
user live there too.

> Browsers only allow microphone access on `localhost` or HTTPS origins, and
> `[email] base_url` must be the address users actually reach, since sign-in
> links are built from it. Put the service behind a TLS-terminating proxy;
> plain-HTTP visitors are redirected to HTTPS when it forwards
> `X-Forwarded-Proto`.

## Configuration

One `config.toml`. The `[server] [audio] [asr] [llm] [tts]` sections are the
library's and `[medical]` is the translator's — see the
[workspace README](../README.md#configuration) and the
[standalone app](../medical_translations/README.md#configuration). This
edition adds:

| Section | Key | Meaning |
| --- | --- | --- |
| `[auth]` | `database` | SQLite file holding accounts and the word ledger |
| `[auth]` | `magic_link_minutes` | How long a sign-in link stays valid (default 60) |
| `[auth]` | `session_days` | How long a session lasts (default 30) |
| `[auth]` | `secure_cookies` | Force the `Secure` flag; auto-detected from HTTPS when unset |
| `[email]` | `base_url` | Public origin, used to build sign-in links |
| `[email]` | `from_name`, `from_address` | Sender of the sign-in email |
| `[email]` | `resend_api_key` | Resend key; empty logs links instead of sending them |
| `[email]` | `dev_echo_link` | Development only: return the link in the response |
| `[quota]` | `free_words_per_week` | Free allowance per rolling seven days (default 5000) |
| `[stripe]` | `secret_key`, `price_id` | Checkout for the monthly plan; empty disables billing |
| `[stripe]` | `webhook_secret` | Endpoint signing secret; without it deliveries are refused |
| `[stripe]` | `price_display` | Optional, cosmetic: overrides the $20 / month the landing page shows by default |
| `[admin]` | `password` | Password for `/admin`; empty means no dashboard at all |
| `[admin]` | `session_hours` | How long an admin stays signed in (default 12) |

## Database migrations

The schema lives in [`saas_core/sql/migrations/`](../saas_core/sql/migrations/) as numbered files — `0001_initial.sql`,
`0002_admin_dashboard.sql`, and so on — and every one of them is compiled into
the binary with `include_str!`. A deployment is still one binary and one config
file: the folder is a source artifact, and nothing looks for it at runtime.

Applied versions are recorded in a `schema_migrations` table, so each migration
runs exactly once, in order, each inside its own transaction together with the
row that records it. An interrupted upgrade therefore leaves the database on a
version boundary rather than half-way through one.

A database created before any of this existed still upgrades in place:
`0001_initial.sql` is written entirely with `IF NOT EXISTS`, so replaying it
against the schema it describes changes nothing, and the chain carries on from
`0002`. That is what lets a v0.1.x deployment adopt migrations by being
restarted.

To add one: write `saas_core/sql/migrations/NNNN_what_it_does.sql`, add a
line to `MIGRATIONS` in `saas_core/src/migrations.rs`, and write the test that
would fail without it. A test compares the registry against the files on disk, so a script nobody
registered fails the build rather than silently never running.

Migrations are forward-only. There is no `down`: rolling back a schema on a
live database is a restore-from-backup exercise, not a script.

## Layout

```
src/
├── main.rs        # router and startup; mounts saas_core's routes
├── config.rs      # reads config.toml once, hands it to the three crates
└── api.rs         # handlers: resolve the account, enforce quota, delegate
static/            # home.html + home.css (landing page), login.html
                   #   (sign-in), and index.html/app.js/style.css (the console)
```

There is no `prompts/` directory and no `specialty.rs` here: that material
lives in `medical_translations`. There is no `db.rs`, `auth.rs`,
`billing.rs`, `admin.rs`, or `sql/` either: accounts, sessions, quota,
Stripe, the dashboard (`/admin`, served with this app's name), and the
numbered migrations live in [`saas_core`](../saas_core/), whose README
covers how to add a migration.

## Caveats

This is a machine translator — an aid for a bilingual encounter, not a
substitute for a qualified medical interpreter, and its output is not
reviewed by anyone before you see it. Verify anything clinical against the
source before acting on it or filing it.

Audio and transcripts are sent to the ASR and LLM services named in
`config.toml`; choose services whose data handling suits the patient
information you are about to send them. This server stores no recordings and
no transcripts — the transcript lives only in the browser tab until it is
cleared or exported. What it does store is the account itself: an email
address, subscription state, and the number of words each turn spent.
