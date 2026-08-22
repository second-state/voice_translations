# Voice Translations

Real-time voice transcription and translation for the web, built with Rust
(Axum).

This repository is a **pure library crate plus the apps built on it**. The
root package, `voice-translations`, ships no binary: it is the speech pipeline
every app reuses. The apps live in subfolders, each a standalone binary with
its own configuration file, and can run side by side:

| App | What it is | Source |
| --- | --- | --- |
| [`conf_translations/`](conf_translations/) | Conference-call translator: pick target languages, and a call-type selector (business, formal, friends, politics, book club, tech) tunes the register of every translation | `conf_translations/` |
| [`medical_translations/`](medical_translations/) | Patient/clinician interpreter: two-party turns, per-specialty terminology rules, safety-first interpreting prompts | `medical_translations/` |
| [`medical_saas/`](medical_saas/) | The same interpreter run as a service: accounts in embedded SQLite, magic-link sign-in, a rolling weekly word allowance, Stripe subscriptions. Depends on `medical_translations` for the medical domain, so it carries only the service and its UI | `medical_saas/` |

## The pipeline (what the library does)

The browser runs the [Silero VAD](https://github.com/snakers4/silero-vad)
neural network locally (via [@ricky0123/vad-web](https://github.com/ricky0123/vad)
and onnxruntime-web, vendored under `vendor/` and compiled into each
app binary — no CDN required) to detect human speech. Audio is only sent to
the server when the model detects a speech segment; sentence breaks are a
configurable silence gap (default 1200 ms). Each detected utterance is sent to
the backend as 16 kHz WAV, which:

1. Forwards the audio to an OpenAI-compatible ASR endpoint
   (`/audio/transcriptions`) with automatic source-language detection.
2. Translates the transcript with a streaming LLM request per target language,
   with the past few messages included as context and per-language rendering
   notes (each app's `prompts/` directory) spliced into the system prompt via
   its domain prompt. Streaming uses
   **SSE over POST** so it passes through Cloudflare proxies.
3. Optionally reads any sentence aloud through an OpenAI-compatible TTS
   endpoint.

Every message carries a timestamp, the transcript survives page reloads, and
it exports as an SRT file whose cues carry every language on its own row.

## Building and running the apps

The repository is a Cargo workspace, so one command builds every app into a
shared `target/`:

```sh
cargo build --release                          # all apps
cargo build --release -p conf-translations     # just the conference app
cargo build --release -p medical-translations  # just the medical one
cargo build --release -p medical-saas          # just the hosted edition
```

| | Conference translator | Medical interpreter | Medical, hosted |
| --- | --- | --- | --- |
| Binary | `target/release/conf-translations` | `target/release/medical-translations` | `target/release/medical-saas` |
| Source | `conf_translations/` | `medical_translations/` | `medical_saas/` |
| Example config | `conf_translations/config.example.toml` | `medical_translations/config.example.toml` | `medical_saas/config.example.toml` |
| Default port | 8080 | 8090 | 8100 |
| Config env var | `CONF_TRANSLATIONS_CONFIG` | `MEDICAL_TRANSLATIONS_CONFIG` | `MEDICAL_SAAS_CONFIG` |

To run one from its folder:

```sh
cd conf_translations
cp config.example.toml config.toml   # then fill in your endpoints + API keys
cargo run --release -p conf-translations
```

Open http://127.0.0.1:8080, press **Start listening**, and speak.

> Browsers only allow microphone access on `localhost` or HTTPS origins.
> On a phone, a plain `http://<lan-ip>:8080` URL will load the page but
> `navigator.mediaDevices` will be missing — serve the app through an HTTPS
> proxy/tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`), or for
> quick testing enable the Chrome flag
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for that origin.

All binaries take the same flags:

```
-c, --config <path>   Configuration file to load [default: config.toml]
-h, --help            Print help
-V, --version         Print the version
```

## Configuration

Every app reads one `config.toml`: the library's sections below, plus the
app's own — `[conference]`, `[medical]`, and for the hosted edition
`[auth] [email] [quota] [stripe]` (see its
[README](medical_saas/README.md#configuration)). The shared sections:

| Section | Key | Meaning |
| --- | --- | --- |
| `[server]` | `host`, `port` | Listen address |
| `[audio]` | `sentence_break_ms` | Silence gap that ends a sentence (default 1200) |
| `[audio]` | `min_speech_ms` | Discard speech segments shorter than this |
| `[audio]` | `max_utterance_ms` | Force a break for very long utterances |
| `[audio]` | `vad_positive_threshold` | Silero speech probability that starts a segment (default 0.5) |
| `[audio]` | `vad_negative_threshold` | Silero speech probability that counts as silence (default 0.35) |
| `[audio]` | `pre_speech_pad_ms` | Audio prepended before speech onset (default 300) |
| `[languages]` | `default_source` | Fallback if ASR reports no language (ISO 639-1 code, e.g. `en`) |
| `[languages]` | `default_targets` | Languages pre-selected in the UI (ISO 639-1 codes, e.g. `["ko", "ja"]`) |
| `[asr]` / `[llm]` | `endpoint`, `api_key`, `model` | OpenAI-compatible services |
| `[llm]` | `context_messages` | Past messages sent as translation context |
| `[tts]` | `endpoint`, `api_key`, `model`, `voice` | Optional; adds read-aloud buttons to every sentence |

`config.toml` is git-ignored in every folder; never commit real credentials.

## Deploying

Each app binary is self-contained: the Silero VAD and onnxruntime assets are
compiled in, so a deployment is **one binary plus one config file**, and it
can live anywhere. Copy the apps to the same directory and give each its own
config:

```sh
scp target/release/{conf-translations,medical-translations,medical-saas} server:/opt/translate/
scp conf_translations/config.toml server:/opt/translate/conference.toml
scp medical_translations/config.toml server:/opt/translate/medical.toml
scp medical_saas/config.toml server:/opt/translate/saas.toml

# on the server, in /opt/translate:
./conf-translations    --config conference.toml  # :8080
./medical-translations --config medical.toml     # :8090
./medical-saas         --config saas.toml        # :8100, plus its SQLite file
```

Every app logs the **absolute path** of the configuration it loaded at
startup. This matters because they all default to `config.toml` in the working
directory, so launching one from another's directory would otherwise pick up
the wrong file silently.

Put the apps behind a TLS-terminating proxy: browsers only grant microphone
access on HTTPS or `localhost`, and every app redirects plain-HTTP visitors to
HTTPS when it sees an `X-Forwarded-Proto` header.

## Releases

Releases are built by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) and are
**always triggered by hand** — pushing code or a tag never publishes
anything. Go to *Actions → release → Run workflow*, pick the branch to build
from, and give it the version (`v0.1.0`). The workflow tags the commit it
ran against, so the release always matches the code that was built and
tested.

It first rejects a malformed version or one that already exists, then runs
`cargo fmt`, clippy, and the test suite — a build that fails its own tests
never becomes a release — and finally builds every app for five targets,
publishing one archive per app per target plus `SHA256SUMS`:

| Target | Notes |
| --- | --- |
| `x86_64-unknown-linux-musl` | Statically linked; runs on any Linux, including Alpine and distroless. Prefer this one. |
| `aarch64-unknown-linux-musl` | The same, for arm64 servers — Graviton, Ampere, an ARM VPS. |
| `x86_64-unknown-linux-gnu` | Needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12). |
| `aarch64-unknown-linux-gnu` | The same, on arm64. |
| `aarch64-apple-darwin` | Apple Silicon, for running an app on a development machine. |

Both Linux architectures are built on native runners, so the SQLite that
`rusqlite` compiles from C source is a first-class build rather than a
cross-compilation. Intel Macs are not built: every current Mac is arm64.

Each archive holds one binary, its `config.example.toml`, and its README —
the Silero VAD and onnxruntime assets are compiled in, so there is nothing
else to install:

```sh
tar xzf medical-saas-0.1.0-x86_64-unknown-linux-musl.tar.gz
cd medical-saas-0.1.0-x86_64-unknown-linux-musl
cp config.example.toml config.toml   # add your endpoints and keys
./medical-saas
```

Unchecking **publish** on that form builds and uploads the same archives as
workflow artifacts without creating a tag or a release — the way to test a
change to the pipeline, or to hand someone a build that is not public.

Every push and pull request also runs formatting, lints, tests, and a
start-up smoke test of each binary
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Using the library

Every stage of the pipeline is a plain function taking an `AppState`:

```rust
use voice_translations::{asr, translate, tts, AppState, Config};

let state = AppState::new(Config::load("config.toml")?);

// Transcribe, optionally pinning the expected language.
let opts = asr::TranscribeOptions {
    language: Some("es".into()),
    ..Default::default()
};
let heard = asr::transcribe(&state, &wav_bytes, &opts).await?;

// Translate, splicing domain instructions into the system prompt. They land
// after the general dictation-cleanup rules and before the rule that keeps the
// response free of commentary.
let req = translate::TranslateRequest {
    text: heard.text,
    target_lang: "Spanish".into(),
    source_lang: heard.language,
    domain_prompt: Some("Never convert or drop a dose.".into()),
    ..Default::default()
};
let response = translate::translate_sse(state, req);   // streaming SSE
```

Other pieces worth reusing:

| Item | Purpose |
| --- | --- |
| `asr::parse_audio_form` | Pulls the `audio` upload plus arbitrary extra text fields out of a multipart request |
| `asr::normalize_language` | ISO codes and lowercase names to the display names used throughout |
| `translate::build_system_prompt` | Inspect or rebuild the exact prompt the model will get |
| `lang_notes::compose` | Composes an app's own per-language and per-pair note tables (compiled-in text files) into prompt text |
| `tts::synthesize` | Text to audio, with a per-request voice override |
| `Config::client_view` | The settings JSON the browser needs, to merge your own keys into |
| `cli::Cli` | The shared `--config` flag parsing every app uses |
| `force_https` | Middleware that upgrades plain-HTTP visitors behind a proxy (browsers need HTTPS for microphone access) |
| `assets::vendor_router` | The VAD/onnxruntime assets, compiled in — enable the `embed-assets` feature |

Enable `embed-assets` when you depend on this crate, since a dependency cannot
reach this crate's `vendor/` tree at runtime:

```toml
voice-translations = { git = "https://github.com/second-state/voice_translations", features = ["embed-assets"] }
```

The apps in this workspace are worked examples: `conf_translations` adds a
call-type layer to a broadcast translator, `medical_translations` adds
interpreting rules, per-specialty terminology, and a two-party UI, and
`medical_saas` wraps that same interpreter in accounts, quotas, and billing —
none of them changes anything in the library's own behavior.
