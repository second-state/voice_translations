# Voice Translator

Real-time voice transcription and translation web app built with Rust (Axum).

The browser runs the [Silero VAD](https://github.com/snakers4/silero-vad) neural
network locally (via [@ricky0123/vad-web](https://github.com/ricky0123/vad) and
onnxruntime-web, vendored under `static/vendor/` — no CDN required) to detect
human speech. Audio is only sent to the server when the model detects a speech
segment; sentence breaks are a configurable silence gap (default 1200 ms). Each
detected utterance is sent to the backend as 16 kHz WAV, which:

1. Forwards the audio to an OpenAI-compatible ASR endpoint (`/audio/transcriptions`)
   with automatic source-language detection.
2. Translates the transcript into every language selected in the UI — one
   streaming LLM request per target language, all running in parallel, with the
   past few messages included as context. Streaming uses **SSE over POST** so it
   passes through Cloudflare proxies.

If the detected source language matches a selected target language, translation
is skipped for that language and the original text is shown instead.

Every message carries a timestamp, and the transcript (source or any target
language) can be exported as an SRT subtitle file.

## Setup

```sh
cp config.example.toml config.toml   # then fill in your endpoints + API keys
cargo run --release
```

Open http://127.0.0.1:8080, press **Start listening**, and speak.

> Browsers only allow microphone access on `localhost` or HTTPS origins.
> On a phone, a plain `http://<lan-ip>:8080` URL will load the page but
> `navigator.mediaDevices` will be missing — serve the app through an HTTPS
> proxy/tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`), or for
> quick testing enable the Chrome flag
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for that origin.

## Configuration (`config.toml`)

| Section | Key | Meaning |
| --- | --- | --- |
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

`config.toml` is git-ignored; never commit real credentials.

## Using it as a library

The crate is also a library, so another Axum app can reuse the pipeline and
specialize it for a domain instead of forking it. Every stage is a plain
function taking an `AppState`:

```rust
use voice_translations::{asr, translate, tts, AppState, Config};

let state = AppState::new(Config::load("config.toml")?);

// Transcribe, optionally priming the recognizer with domain vocabulary.
let opts = asr::TranscribeOptions {
    prompt: Some("apixaban, ejection fraction, atrial fibrillation".into()),
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
| `tts::synthesize` | Text to audio, with a per-request voice override |
| `Config::client_view` | The settings JSON the browser needs, to merge your own keys into |
| `force_https` | Middleware that upgrades plain-HTTP visitors behind a proxy (browsers need HTTPS for microphone access) |
| `assets::vendor_router` | The VAD/onnxruntime assets, compiled in — enable the `embed-assets` feature |

Enable `embed-assets` when you depend on this crate, since a dependency cannot
reach this crate's `static/` tree at runtime:

```toml
voice-translations = { git = "https://github.com/second-state/voice_translations", features = ["embed-assets"] }
```

[`medical_translations`](medical_translations/) is a worked example: it adds a
medical-specialty layer — a vocabulary primer per specialty for the recognizer,
interpreting rules for the translator, and a two-party patient/clinician UI —
without changing anything in this crate's own behavior.
