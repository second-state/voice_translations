# Medical Interpreter

Real-time, two-way interpreting for conversations between a patient and their
care team, tuned to a medical specialty.

Built on [`voice_translations`](https://github.com/second-state/voice_translations)
as a library: the browser-side Silero VAD, the ASR call, the streaming LLM
translation, and the text-to-speech all come from that crate. What this app
adds is the medical layer.

## What the medical layer does

**Two speakers, not one broadcast.** The upstream app transcribes one speaker
and fans the result out to several target languages. A clinical encounter is
not that shape: it is two people alternating between exactly two languages. So
each utterance is attributed to the **clinician** or the **patient** and
interpreted into the other one's language. Tapping who is speaking pins the
language; leaving it on auto-detect infers the role from the language spoken,
treating anything that is not the clinician's language as the patient.

**A specialty tunes both models.** Pick from 19 specialties — primary care,
emergency, pediatrics, cardiology, oncology, orthopedics, dentistry, OB/GYN,
psychiatry, dermatology, gastroenterology, neurology, endocrinology,
pulmonology, ophthalmology, urology & nephrology, pharmacy, anesthesia,
physical therapy. Each supplies:

- a **vocabulary primer** for the speech recognizer, so it writes "Lasix" and
  "apixaban" instead of the common-word lookalikes it would otherwise pick;
- **terminology notes** for the translator, covering the confusions specific
  to that field — units versus millilitres for insulin, which eye the drops go
  in, sprain versus strain versus fracture, curative versus palliative intent.

**General interpreting rules on every turn**, on top of the specialty's. These
are the ones whose failure modes are documented harms: numbers and units must
survive unconverted, negation must stay negative, laterality must never be
dropped, certainty must be neither hardened nor softened, questions get
interpreted rather than answered, and the patient's own everyday wording must
not be promoted into jargon. Speech is rendered in the first person, the way a
human interpreter does.

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

Open http://127.0.0.1:8080, choose the specialty and the two languages, press
**Start listening**, and speak.

> Browsers only allow microphone access on `localhost` or HTTPS origins. On a
> phone or tablet at the bedside, a plain `http://<lan-ip>:8080` URL will load
> the page but `navigator.mediaDevices` will be missing — serve the app through
> an HTTPS proxy/tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`).
> Behind such a proxy the server upgrades plain-HTTP visitors automatically.

## Configuration

Everything lives in one `config.toml`. The `[server] [audio] [asr] [llm] [tts]`
sections are the upstream crate's — see its README. This app adds `[medical]`:

| Key | Meaning |
| --- | --- |
| `default_specialty` | Specialty selected on load (see the id list in `config.example.toml`) |
| `clinician_language` | Language the care team speaks |
| `patient_language` | Language the patient speaks, pre-selected in the UI |
| `languages` | Languages offered in both pickers; the two above are always included |
| `asr_primer` | `auto` (default), `always`, or `never` — see below |
| `clinician_voice` / `patient_voice` | Optional distinct read-aloud voices per side |
| `speak_translations` | Start with automatic read-aloud enabled |

### Why `asr_primer` defaults to `auto`

The vocabulary primers are written in English. A Whisper-family recognizer
given a primer in one language and audio in another tends to answer in the
primer's language — which would turn a patient's Spanish into English and send
the whole turn through the pipeline backwards. So `auto` sends the primer only
when the turn is known to be English, which is what naming the speaker in the
UI establishes. In a clinic where the care team speaks English that is exactly
where the dense jargon is, so the primer fires where it pays. Set `always` if
your ASR service is known to treat the primer purely as a spelling bias.

## Relationship to the upstream crate

This app depends on `voice-translations` with the `embed-assets` feature, which
compiles the Silero VAD and onnxruntime-web files (~15 MB) into this binary —
a dependency cannot reach the upstream crate's `static/` tree at runtime. The
result is a single self-contained executable plus a `config.toml`.

The upstream crate was extended rather than forked. It gained a `lib.rs` that
exposes the pipeline as plain functions, an ASR vocabulary `prompt`, and a
`domain_prompt` hook spliced into the translation system prompt — general
mechanisms, with nothing medical in them. All the domain knowledge lives here,
in `src/specialty.rs` and `src/prompt.rs`.

## Layout

```
src/
├── main.rs        # router and startup
├── config.rs      # [medical] settings on top of the upstream config
├── api.rs         # handlers: resolve specialty + speaker, delegate upstream
├── prompt.rs      # general medical interpreting rules, prompt composition
└── specialty.rs   # the 19 specialties and their prompt material
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
