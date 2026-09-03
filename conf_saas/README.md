# Conference Translator — hosted edition

The multi-language conference translator of
[`conf_translations`](../conf_translations/), run as a service: user
accounts in an embedded SQLite database, passwordless sign-in by emailed
magic link, a rolling weekly word allowance on the free plan, and Stripe
subscriptions for unlimited use.

**This crate contains only the glue and its UI.** Everything it translates,
every way it translates, and everything that makes it a service comes from
its three dependencies, not from copies:

| Comes from | What |
| --- | --- |
| [`voice_translations`](../) | The whole speech pipeline: Silero VAD assets, the ASR call, streaming LLM translation, TTS, config loading, the CLI, and the HTTPS middleware |
| [`conf_translations`](../conf_translations/) | The conference domain: the six call types, the register and terminology notes behind each, the per-language rendering notes, and the prompt files behind them |
| [`saas_core`](../saas_core/) | The service: accounts, magic-link sign-in, sessions, the rolling word quota, Stripe checkout and webhooks, the operator's dashboard, and the SQL migrations behind them — shared with the hosted [medical translator](../medical_saas/) |

So a change to a call type's guidance lands in the standalone app and here
at once, a change to how accounts or billing work lands in both hosted apps
at once, and this crate implements no speech, model, or account plumbing of
its own.

## What it does

To every sentence anyone on the call says, in order:

1. **Transcribes it**, whoever spoke and in whichever of 25 languages. The
   spoken language is detected sentence by sentence.
2. **Cleans it up**: fillers, false starts, and self-corrections come out;
   numbers, names, and dates are never touched.
3. **Translates it into every selected language at once**, in the register
   the call type calls for — a standup does not come out sounding like a
   communiqué.
4. **Keeps the record**: every sentence with the time it was said, in the
   original and every translation, surviving a reload and exporting as an
   SRT subtitle file.

## Two defaults that follow the interface language

The landing page, the sign-in page, and the console are translated into
**English, 简体中文, 繁體中文, Español, 한국어, and 日本語**. The language
follows the browser on a first visit — `zh-TW`, `zh-HK` and anything tagged
`Hant` get traditional characters, everything else Chinese gets simplified —
and a picker on every page overrides it. A hand-picked language persists
across sessions, and `?lang=ja` on any URL selects one for that visit.

**The translation targets start as the interface language.** Someone
reading the console in Korean wants, by default, to read the call in Korean;
switching the interface to Spanish moves the targets with it. Once the chips
are changed by hand, that set is remembered and stops following the
interface until it is changed again. If the interface language is not among
the configured `[conference] languages`, the `[languages] default_targets`
from the config are used instead.

**The spoken language is always auto-detected.** The console loads with
"Auto-detect" selected every time; pinning a language lasts for that visit
only and is never remembered. A call that switches between English and
Mandarin needs nothing changed mid-way.

Interface language and the chosen targets live in the browser's local
storage, alongside the transcript, so they are per browser rather than per
account. All six catalogues live in [`static/i18n.js`](static/i18n.js) and
are key-for-key identical; a string missing from one language falls back to
English rather than showing a bare key.

## Pages

| Path | What it is |
| --- | --- |
| `/` | Public landing page: what the service does, and the free vs. subscription plans. Links straight into the app when a session is found. |
| `/login` | Sign-in page: enter an email, receive a link. |
| `/app` | The translator console. Anonymous visitors are sent to `/login`, and every API it calls requires a session regardless. |
| `/admin` | The operator's dashboard, behind one password. Absent entirely unless `[admin] password` is set. |

## Accounts, the allowance, subscriptions, and the dashboard

These are `saas_core`'s, and behave identically here and in the medical
edition. The [medical README](../medical_saas/README.md) documents them in
full — sign-in, the rolling quota and how words are counted, Stripe setup
step by step (including local testing with the Stripe CLI and a
troubleshooting table), and the dashboard. What differs here:

- **Everyone who speaks draws on the same allowance.** The ledger records
  every utterance as `speaker`; there are no roles on a call.
- **Translating into five languages costs the same as one.** The allowance
  is spent when a sentence is transcribed, once. Each translation is a
  separate streaming request, and none of them count.
- The Stripe return URLs, sign-in links, and the dashboard's title carry
  this app's name and `base_url`.

An account that is out of words gets HTTP 402 with its current standing
attached, on both `/api/transcribe` and `/api/translate`, so a client that
ignores the first cannot simply call the second.

## Setup

```sh
cp config.example.toml config.toml   # then fill in endpoints, keys, and base_url
cargo run --release
```

Open http://127.0.0.1:8110 for the landing page, or go straight to
http://127.0.0.1:8110/app. With no `resend_api_key` set, the sign-in link
appears in the server log (and in the response, with `dev_echo_link = true`).

From the workspace root, pass the config path explicitly:

```sh
cargo run --release -p conf-saas -- --config conf_saas/config.toml
```

## Build and deploy

```sh
cargo build --release                 # all apps
cargo build --release -p conf-saas    # just this one
```

The binary is self-contained — the Silero VAD and onnxruntime assets are
compiled in — so a deployment is one binary, one config file, and the SQLite
file it creates beside them:

```sh
./conf-saas --config /etc/conf-saas.toml
# or
CONF_SAAS_CONFIG=/etc/conf-saas.toml ./conf-saas
```

It defaults to port 8110, so it can run beside the standalone conference
translator (8080), the standalone medical one (8090), and the hosted medical
one (8100). It keeps its own database: `[auth] database` here names a
different file from the medical edition's, and the two do not share
accounts.

**Back up the database.** It is the only record of who has an account and
who has paid; the Stripe ids that reconnect a subscription to a user live
there too.

> Browsers only allow microphone access on `localhost` or HTTPS origins, and
> `[email] base_url` must be the address users actually reach, since sign-in
> links are built from it. Put the service behind a TLS-terminating proxy;
> plain-HTTP visitors are redirected to HTTPS when it forwards
> `X-Forwarded-Proto`.

## Configuration

One `config.toml`. The `[server] [audio] [languages] [asr] [llm] [tts]`
sections are the library's and `[conference]` is the translator's — see the
[workspace README](../README.md#configuration) and the
[standalone app](../conf_translations/README.md). Two of those matter
specifically here:

| Section | Key | Meaning |
| --- | --- | --- |
| `[conference]` | `languages` | The target chips. Keep every interface language in it, since the page starts by translating into the language it is read in |
| `[languages]` | `default_targets` | Fallback targets, used only when the interface language is not in the list above |

The hosted layer adds:

| Section | Key | Meaning |
| --- | --- | --- |
| `[auth]` | `database` | SQLite file holding accounts and the word ledger |
| `[auth]` | `magic_link_minutes` | How long a sign-in link stays valid (default 60) |
| `[auth]` | `session_days` | How long a session lasts (default 30) |
| `[auth]` | `secure_cookies` | Force the `Secure` flag; auto-detected from HTTPS when unset |
| `[email]` | `base_url` | Public origin, used to build sign-in links |
| `[email]` | `from_name`, `from_address` | Sender of the sign-in email; the name defaults to the product's |
| `[email]` | `resend_api_key` | Resend key; empty logs links instead of sending them |
| `[email]` | `dev_echo_link` | Development only: return the link in the response |
| `[quota]` | `free_words_per_week` | Free allowance per rolling seven days (default 5000) |
| `[stripe]` | `secret_key`, `price_id` | Checkout for the monthly plan; empty disables billing |
| `[stripe]` | `webhook_secret` | Endpoint signing secret; without it deliveries are refused |
| `[stripe]` | `price_display` | Optional, cosmetic: overrides the $20 / month the landing page shows by default |
| `[admin]` | `password` | Password for `/admin`; empty means no dashboard at all |
| `[admin]` | `session_hours` | How long an admin stays signed in (default 12) |

## Layout

```
src/
├── main.rs        # router and startup; mounts saas_core's routes
├── config.rs      # reads config.toml once, hands it to the three crates
└── api.rs         # handlers: resolve the account, enforce quota, delegate
static/            # home.html + home.css (landing page), login.html
                   #   (sign-in), and index.html/app.js/style.css (the console)
```

There is no `prompts/` directory and no `call_type.rs` here: that material
lives in `conf_translations`. There is no `db.rs`, `auth.rs`, `billing.rs`,
`admin.rs`, or `sql/` either: accounts, sessions, quota, Stripe, the
dashboard, and the numbered migrations live in [`saas_core`](../saas_core/).

## Caveats

This is a machine translator — an aid for following a call, not a certified
translation, and its output is not reviewed by anyone before you see it.
For anything contractual or legal, check the original before acting on it.

Audio and transcripts are sent to the ASR and LLM services named in
`config.toml`; choose services whose data handling suits what is said on
your calls. This server stores no recordings and no transcripts — the
transcript lives only in the browser tab until it is cleared or exported.
What it does store is the account itself: an email address, subscription
state, and the number of words each sentence spent.
