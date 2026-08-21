# Medical Interpreter — hosted edition

The two-way patient/clinician interpreter of
[`medical_translations`](../medical_translations/), run as a service: user
accounts in an embedded SQLite database, passwordless sign-in by emailed
magic link, a rolling weekly word allowance on the free plan, and Stripe
subscriptions for unlimited use.

The interpreting itself is identical — same 19 specialties, same safety-first
interpreting rules, same per-language notes, same two-party UI. Everything
here is the layer around it.

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

`POST /api/billing/checkout` opens a Stripe Checkout session for the signed-in
account and returns the hosted URL; `POST /api/billing/portal` sends an
existing subscriber to Stripe's billing portal to change a card or cancel.

**Only Stripe changes a plan.** The browser can start a checkout, but the
account moves between free and paid solely through
`POST /stripe/webhook`, which requires a valid `Stripe-Signature`:

| Event | Effect |
| --- | --- |
| `checkout.session.completed` (subscription mode) | Plan → paid; the Stripe customer and subscription ids are stored |
| `customer.subscription.created` / `.updated` | `active`/`trialing`/`past_due` keep access; anything else returns the account to free |
| `customer.subscription.deleted` | Plan → free |

`past_due` deliberately keeps access while Stripe retries the card. A
cancellation naming a subscription the account has already replaced is
ignored, so an out-of-order delivery cannot downgrade a resubscribed user.
Signatures are verified with HMAC-SHA256 over the raw body, compared in
constant time, and rejected outside a five-minute window so a captured
delivery cannot be replayed.

Point the Stripe endpoint at `https://<your-host>/stripe/webhook` and
subscribe it to those four events. Leaving `[stripe]` empty runs the service
without paid plans: every account stays free and the upgrade button
disappears.

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
├── config.rs      # [medical] [auth] [email] [quota] [stripe] on top of the library config
├── api.rs         # handlers: resolve the account, enforce quota, delegate to the library
├── auth.rs        # magic links, sessions, /api/me
├── billing.rs     # Stripe checkout, portal, and webhook
├── db.rs          # SQLite: accounts, tokens, subscription state, word ledger
├── quota.rs       # rolling-window allowance and word counting
├── error.rs       # JSON errors with stable codes (401, 402, …)
├── prompt.rs      # general medical interpreting rules, prompt composition
├── specialty.rs   # the 19 specialties (metadata; guidance in prompts/specialties/)
└── lang.rs        # per-language and per-pair note tables from prompts/
prompts/           # specialties/, targets/, pairs/ — as in the standalone app
static/            # the two-party encounter UI, plus the sign-in page
```

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
