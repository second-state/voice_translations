# Conference Translator

Real-time translation of a conference call into any set of target languages,
tuned to the kind of call it is.

Built on [`voice_translations`](https://github.com/second-state/voice_translations)
as a library: the browser-side Silero VAD, the ASR call, the streaming LLM
translation, and the text-to-speech all come from that crate. What this app
adds is the conference layer.

## What the conference layer does

**One speaker, many listeners.** Each detected utterance is transcribed with
automatic language detection (or a pinned source language), then translated
into every language selected in the UI — one streaming request per target,
all in parallel. A target matching the source language shows the polished
original instead. Every message carries a timestamp, and any track (source or
target language) exports as an SRT subtitle file.

**A call type tunes the register.** Pick from 6 call types — business
meeting, formal event, friends & family, politics & current affairs, book
club, tech & engineering. Each supplies register and terminology notes
(`prompts/types/`) naming the failure modes that matter for that kind of
call: a hedge must not become a commitment in a negotiation, a joke must land
as a joke between friends, "allegedly" must survive a political discussion,
and a code identifier must cross a tech call character-for-character.

**Per-language rendering notes** (`prompts/targets/`, `prompts/pairs/`): for
each offered language, its general register conventions plus how its register
machinery — tu/vous, Korean speech levels, Japanese keigo, casual particles,
business code-mixing habits — maps onto the formality axis the call types
move along; and pair-specific notes such as Mandarin→Cantonese, where
character conversion masquerades as translation.

Every utterance is also polished in its own language — fillers and false
starts removed, self-corrections resolved — keeping the speaker's register
while cleaning it up.

## Setup

```sh
cp config.example.toml config.toml   # then fill in your endpoints + API keys
cargo run --release
```

Open http://127.0.0.1:8080, pick the call type and target languages, press
**Start listening**, and speak.

Every app in the workspace defaults to `config.toml` in the working directory
and logs the absolute path of the config it loaded — check that line if
something looks wrong. From the workspace root, pass the path explicitly:

```sh
cargo run --release -p conf-translations -- --config conf_translations/config.toml
```

## Build and deploy

This app is a member of the workspace rooted one level up, so all apps build
together into a shared `target/`:

```sh
cargo build --release                        # all apps
cargo build --release -p conf-translations   # just this one
```

The result is self-contained — the Silero VAD and onnxruntime assets are
compiled in — so a deployment is one binary plus one config file, in any
directory:

```sh
./conf-translations --config /etc/conference.toml
# or
CONF_TRANSLATIONS_CONFIG=/etc/conference.toml ./conf-translations
```

It defaults to port 8080; the medical interpreter defaults to 8090 so the two
can run side by side. See the [workspace README](../README.md#deploying) for
deploying both together.

> Browsers only allow microphone access on `localhost` or HTTPS origins. On a
> phone, a plain `http://<lan-ip>:8080` URL will load the page but
> `navigator.mediaDevices` will be missing — serve the app through an HTTPS
> proxy/tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`).
> Behind such a proxy the server upgrades plain-HTTP visitors automatically.

## Configuration

Everything lives in one `config.toml`. The `[server] [audio] [languages]
[asr] [llm] [tts]` sections are the library's — see the
[workspace README](../README.md#configuration). This app adds `[conference]`:

| Key | Meaning |
| --- | --- |
| `default_type` | Call type selected on load: `business`, `formal`, `friends`, `politics`, `book_club`, or `tech` |

## Relationship to the library

This app depends on `voice-translations` with the `embed-assets` feature,
which compiles the Silero VAD and onnxruntime-web files (~15 MB) into this
binary — a dependency cannot reach the library's `vendor/` tree at runtime.
The result is a single self-contained executable plus a `config.toml`.

The library exposes the pipeline as plain functions plus a `domain_prompt`
hook spliced into the translation system prompt — general mechanisms, with
nothing conference-specific in them. All the domain knowledge lives here, in
`prompts/` and the modules that compose it.

## Layout

```
src/
├── main.rs        # router and startup
├── config.rs      # [conference] settings on top of the library config
├── api.rs         # handlers: resolve the call type, delegate to the library
├── prompt.rs      # call-setting framing, prompt composition
├── call_type.rs   # the 6 call types (metadata; guidance in prompts/types/)
└── lang.rs        # per-language and per-pair note tables from prompts/
prompts/
├── types/         # register and terminology notes, one file per call type
├── targets/       # rendering notes, one file per offered language
└── pairs/         # notes for exact source→target pairs (zh-yue, yue-zh)
static/            # the multi-language call UI
```

## Caveats

This is machine translation. It is an aid for following a call across
languages, not a certified interpretation; verify anything consequential
against the source before acting on it.

Audio and transcripts are sent to the ASR and LLM services named in
`config.toml`; choose services whose data handling suits what is said on your
calls. This server itself stores nothing — no recording, no transcript — and
the transcript lives only in the browser tab until it is cleared or exported.
