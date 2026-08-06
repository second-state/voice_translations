# Voice Translator

Real-time voice transcription and translation web app built with Rust (Axum).

The browser captures microphone audio and detects sentence breaks (a configurable
silence gap, default 50 ms). Each utterance is sent to the backend, which:

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

## Configuration (`config.toml`)

| Section | Key | Meaning |
| --- | --- | --- |
| `[audio]` | `sentence_break_ms` | Silence gap that ends a sentence (default 50) |
| `[audio]` | `silence_threshold` | RMS level treated as silence |
| `[audio]` | `min_speech_ms` | Discard utterances shorter than this |
| `[audio]` | `max_utterance_ms` | Force a break for very long utterances |
| `[languages]` | `default_source` | Fallback if ASR reports no language (ISO 639-1 code, e.g. `en`) |
| `[languages]` | `default_targets` | Languages pre-selected in the UI (ISO 639-1 codes, e.g. `["ko", "ja"]`) |
| `[asr]` / `[llm]` | `endpoint`, `api_key`, `model` | OpenAI-compatible services |
| `[llm]` | `context_messages` | Past messages sent as translation context |

`config.toml` is git-ignored; never commit real credentials.
