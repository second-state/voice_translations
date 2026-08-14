# Medical Interpreter

Real-time, two-way interpreting for conversations between a patient and their
care team, tuned to a medical specialty.

Built on [`voice_translations`](https://github.com/second-state/voice_translations)
as a library: the browser-side Silero VAD, the ASR call, the streaming LLM
translation, and the text-to-speech all come from that crate. What this app
adds is the medical layer.

## What the medical layer does

**Two speakers, not one broadcast.** A clinical encounter is two people
alternating between exactly two languages. Each utterance's speaker is
inferred from its detected language — anything that is not the clinician's
language is treated as the patient, so an unexpected language still flows
toward the care team — and interpreted into the other side's language. Every
turn carries a **Clinician/Patient toggle** to reassign it (which re-runs the
interpretation in the right direction), and a turn whose detected language
contradicts its speaker's preset gets a warning chip.

**A specialty tunes the translator.** Pick from 19 specialties — primary
care, emergency, pediatrics, cardiology, oncology, orthopedics, dentistry,
OB/GYN, psychiatry, dermatology, gastroenterology, neurology, endocrinology,
pulmonology, ophthalmology, urology & nephrology, pharmacy, anesthesia,
physical therapy. Each supplies terminology and accuracy notes
(`prompts/specialties/`) covering the confusions specific to that field —
units versus millilitres for insulin, which eye the drops go in, sprain
versus strain versus fracture, curative versus palliative intent — and gives
the translator the vocabulary to **repair recognizer mishearings** ("lay six"
is Lasix, "hypo natremia" is hyponatremia) without ever touching a figure.

**General interpreting rules on every turn**, on top of the specialty's. These
are the ones whose failure modes are documented harms: numbers and units must
survive unconverted, negation must stay negative, laterality must never be
dropped, certainty must be neither hardened nor softened, questions get
interpreted rather than answered, and the patient's own everyday wording must
not be promoted into jargon. Speech is rendered in the first person, the way a
human interpreter does.

**Per-language rendering notes** (`prompts/targets/`, `prompts/pairs/`): for
each offered language, its general register conventions plus the clinical
layer — the vocabulary actually used in that language's healthcare settings
and its code-mixing habits — and pair-specific notes such as
Mandarin→Cantonese, where character conversion masquerades as translation.

**A number check on the result.** Doses, times, and vitals are the content
whose loss does the most damage, and a dropped figure is one of the few
interpreting errors detectable without a second model. Every figure spoken is
matched against the interpretation (across Arabic, Devanagari, Bengali, Thai
and fullwidth digits); anything missing raises an advisory flag. A language
that spells figures out in words will trip it, so it prompts a look rather
than declaring an error.

Every turn is also polished in its own language — fillers and false starts
removed, self-corrections resolved — under the same rule that no number,
negation, drug name, or body part may be touched while tidying.

## Setup

```sh
cp config.example.toml config.toml   # then fill in your endpoints + API keys
cargo run --release
```

Open http://127.0.0.1:8090, choose the specialty and the two languages, press
**Start listening**, and speak.

Every app in the workspace defaults to `config.toml` in the working directory
and logs the absolute path of the config it loaded — check that line if
something looks wrong. From the workspace root, pass the path explicitly:

```sh
cargo run --release -p medical-translations -- --config medical_translations/config.toml
```

## Build and deploy

This app is a member of the workspace rooted one level up, so all apps build
together into a shared `target/`:

```sh
cargo build --release                            # all apps
cargo build --release -p medical-translations    # just this one
```

The result is self-contained — the Silero VAD and onnxruntime assets are
compiled in — so a deployment is one binary plus one config file, in any
directory:

```sh
./medical-translations --config /etc/medical.toml
# or
MEDICAL_TRANSLATIONS_CONFIG=/etc/medical.toml ./medical-translations
```

It defaults to port 8090 rather than 8080 specifically so it can run beside
the conference translator. See the [workspace README](../README.md#deploying)
for deploying both together.

> Browsers only allow microphone access on `localhost` or HTTPS origins. On a
> phone or tablet at the bedside, a plain `http://<lan-ip>:8090` URL will load
> the page but `navigator.mediaDevices` will be missing — serve the app through
> an HTTPS proxy/tunnel (e.g. `cloudflared tunnel --url http://localhost:8090`).
> Behind such a proxy the server upgrades plain-HTTP visitors automatically.

## Configuration

Everything lives in one `config.toml`. The `[server] [audio] [asr] [llm] [tts]`
sections are the library's — see the [workspace README](../README.md#configuration).
This app adds `[medical]`:

| Key | Meaning |
| --- | --- |
| `default_specialty` | Specialty selected on load (see the id list in `config.example.toml`) |
| `clinician_language` | Language the care team speaks |
| `patient_language` | Language the patient speaks, pre-selected in the UI |
| `languages` | Languages offered in both pickers; the two above are always included |
| `clinician_voice` / `patient_voice` | Optional distinct read-aloud voices per side |

## Relationship to the library

This app depends on `voice-translations` with the `embed-assets` feature,
which compiles the Silero VAD and onnxruntime-web files (~15 MB) into this
binary — a dependency cannot reach the library's `vendor/` tree at runtime.
The result is a single self-contained executable plus a `config.toml`.

The library exposes the pipeline as plain functions plus a `domain_prompt`
hook spliced into the translation system prompt — general mechanisms, with
nothing medical in them. All the domain knowledge lives here, in `prompts/`
and the modules that compose it.

## Layout

```
src/
├── main.rs        # router and startup
├── config.rs      # [medical] settings on top of the library config
├── api.rs         # handlers: resolve specialty + speaker, delegate to the library
├── prompt.rs      # general medical interpreting rules, prompt composition
├── specialty.rs   # the 19 specialties (metadata; guidance in prompts/specialties/)
└── lang.rs        # per-language and per-pair note tables from prompts/
prompts/
├── specialties/   # terminology and accuracy notes, one file per specialty
├── targets/       # rendering notes, one file per offered language
└── pairs/         # notes for exact source→target pairs (zh-yue, yue-zh)
static/            # the two-party encounter UI
```

## Caveats

This is a machine interpreter. It is an aid for a bilingual encounter, not a
substitute for a qualified medical interpreter, and its output is not reviewed
by anyone before you see it. Verify anything clinical against the source
before acting on it or filing it.

Audio and transcripts are sent to the ASR and LLM services named in
`config.toml`; choose services whose data handling suits the patient
information you are about to send them. This server itself stores nothing —
no recording, no transcript — and the transcript lives only in the browser tab
until it is cleared or exported.
