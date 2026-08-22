# Medical Interpreter — hosted edition

The two-way patient/clinician interpreter of
[`medical_translations`](../medical_translations/), run as a service: user
accounts in an embedded SQLite database, passwordless sign-in by emailed
magic link, a rolling weekly word allowance on the free plan, and Stripe
subscriptions for unlimited use.

**This crate contains only the service and its UI.** Everything it
interprets and every way it interprets comes from its two dependencies, not
from copies:

| Comes from | What |
| --- | --- |
| [`voice_translations`](../) | The whole speech pipeline: Silero VAD assets, the ASR call, streaming LLM translation, TTS, config loading, the CLI, and the HTTPS middleware |
| [`medical_translations`](../medical_translations/) | The medical domain: the 19 specialties, the interpreting rules, mishearing repair, the per-language clinical notes, and the prompt files behind them |

So a change to how medicine is interpreted lands in the standalone app and
here at once, and neither this crate nor the standalone one implements any
speech or model plumbing of its own.

## Accounts

**Signing up and logging in are the same act.** A visitor types an email
address; the server mints a single-use token, mails a link containing it, and
exchanges that link for a session cookie. The first link sent to an address
creates the account it activates. There is no password to choose, store,
reset, or leak.

- `POST /auth/request` `{email}` — mail a sign-in link. Answers identically
  whether or not the address already has an account, so the endpoint cannot
  be used to discover who has one.
- `GET /verify?token=…` — redeem a link: sets an `HttpOnly; SameSite=Lax`
  session cookie (with `Secure` whenever the request arrived over HTTPS) and
  redirects to the app. A link works exactly once and expires.
- `POST /auth/logout` — end the session and clear the cookie.
- `GET /api/me` — who is signed in, their plan, and their current allowance.

Tokens are stored as SHA-256 hashes, never in the clear, so a leaked copy of
the database yields no usable session or sign-in link.

Without a mail provider configured, sign-in links are written to the server
log — enough to run locally. Setting `dev_echo_link` additionally returns the
link in the HTTP response; it is refused when an API key is present so it
cannot be left on in production by accident.

## The free allowance

A free account may interpret **1,000 spoken words per rolling seven-day
window** (`[quota] free_words_per_week`). Paid accounts are unlimited.

- **Both sides count.** The clinician's turns and the patient's draw on the
  same allowance. The ledger labels each turn by role, inferred from the
  detected language, but the label is bookkeeping only.
- **Spoken words, counted once.** The allowance is spent when a turn is
  transcribed. Interpretations are free: one utterance costs the same
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

## Subscriptions

`POST /api/billing/checkout` opens a Stripe Checkout session for the
signed-in account and returns the hosted URL; `POST /api/billing/portal`
sends an existing subscriber to Stripe's billing portal to change a card or
cancel.

**Only Stripe changes a plan.** The browser can start a checkout, but an
account moves between free and paid solely through `POST /stripe/webhook`,
and only for a delivery carrying a valid `Stripe-Signature`.

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

**5. Check `base_url`.** Checkout returns the user to `{base_url}/?upgraded=1`
on success and `{base_url}/` on cancel, and the portal returns to
`{base_url}`. If `[email] base_url` is wrong, payment still works but the
user lands somewhere useless.

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

Open http://127.0.0.1:8100. With no `resend_api_key` set, the sign-in link
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
(8080) and the standalone interpreter (8090).

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
library's and `[medical]` is the interpreter's — see the
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
| `[quota]` | `free_words_per_week` | Free allowance per rolling seven days (default 1000) |
| `[stripe]` | `secret_key`, `price_id` | Checkout for the monthly plan; empty disables billing |
| `[stripe]` | `webhook_secret` | Endpoint signing secret; without it deliveries are refused |

## Layout

```
src/
├── main.rs        # router and startup
├── config.rs      # [auth] [email] [quota] [stripe]; [medical] and the
│                  #   library sections are parsed by the crates that own them
├── api.rs         # handlers: resolve the account, enforce quota, delegate
├── auth.rs        # magic links, sessions, /api/me
├── billing.rs     # Stripe checkout, portal, and webhook
├── db.rs          # SQLite: accounts, tokens, subscription state, word ledger
├── quota.rs       # rolling-window allowance and word counting
└── error.rs       # JSON errors with stable codes (401, 402, …)
static/            # the two-party encounter UI, plus the sign-in page
```

There is no `prompts/` directory and no `specialty.rs` here: that material
lives in `medical_translations` and is used from there.

## Caveats

This is a machine interpreter — an aid for a bilingual encounter, not a
substitute for a qualified medical interpreter, and its output is not
reviewed by anyone before you see it. Verify anything clinical against the
source before acting on it or filing it.

Audio and transcripts are sent to the ASR and LLM services named in
`config.toml`; choose services whose data handling suits the patient
information you are about to send them. This server stores no recordings and
no transcripts — the transcript lives only in the browser tab until it is
cleared or exported. What it does store is the account itself: an email
address, subscription state, and the number of words each turn spent.
