use std::{fs, net::SocketAddr, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::asr::normalize_language;

/// Application configuration loaded from `config.toml`.
///
/// Unknown sections are ignored, so a downstream app can keep its own
/// settings in the same file and deserialize them into its own struct.
#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub audio: AudioConfig,
    #[serde(default)]
    pub languages: LanguagesConfig,
    pub asr: AsrConfig,
    pub llm: LlmConfig,
    /// Optional; when absent, the read-aloud buttons are hidden in the UI.
    pub tts: Option<TtsConfig>,
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read {}; copy config.example.toml to config.toml and fill in your credentials",
                path.display()
            )
        })?;
        toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
    }

    /// The `[server]` host/port as a socket address.
    pub fn listen_addr(&self) -> Result<SocketAddr> {
        format!("{}:{}", self.server.host, self.server.port)
            .parse()
            .context("invalid [server] host/port in config.toml")
    }

    /// The settings the browser needs, as JSON.
    ///
    /// Language values in `config.toml` are ISO 639-1 codes (or full names);
    /// they are normalized here to the display names the UI compares against.
    /// A downstream app typically merges its own keys into this object.
    pub fn client_view(&self) -> Value {
        json!({
            "sentence_break_ms": self.audio.sentence_break_ms,
            "min_speech_ms": self.audio.min_speech_ms,
            "max_utterance_ms": self.audio.max_utterance_ms,
            "vad_positive_threshold": self.audio.vad_positive_threshold,
            "vad_negative_threshold": self.audio.vad_negative_threshold,
            "pre_speech_pad_ms": self.audio.pre_speech_pad_ms,
            "default_source": normalize_language(&self.languages.default_source),
            "default_targets": self
                .languages
                .default_targets
                .iter()
                .map(|lang| normalize_language(lang))
                .collect::<Vec<_>>(),
            "context_messages": self.llm.context_messages,
            "tts_enabled": self.tts.is_some(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8080,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    /// Silence duration (ms) that ends a sentence/utterance.
    pub sentence_break_ms: u64,
    /// Utterances shorter than this (ms) are discarded as noise.
    pub min_speech_ms: u64,
    /// Force a sentence break if one utterance runs longer than this (ms).
    pub max_utterance_ms: u64,
    /// Silero VAD speech probability above which a frame counts as speech.
    pub vad_positive_threshold: f64,
    /// Silero VAD speech probability below which a frame counts as silence.
    pub vad_negative_threshold: f64,
    /// Audio (ms) prepended before detected speech onset, so the first
    /// syllable is not clipped.
    pub pre_speech_pad_ms: u64,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sentence_break_ms: 1_200,
            min_speech_ms: 250,
            max_utterance_ms: 30_000,
            vad_positive_threshold: 0.5,
            vad_negative_threshold: 0.35,
            pre_speech_pad_ms: 300,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct LanguagesConfig {
    /// Fallback when the ASR service does not report a detected language.
    pub default_source: String,
    /// Languages pre-selected in the UI.
    pub default_targets: Vec<String>,
}

impl Default for LanguagesConfig {
    fn default() -> Self {
        Self {
            default_source: "English".into(),
            default_targets: vec!["Korean".into()],
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct AsrConfig {
    /// OpenAI-compatible base URL; `/audio/transcriptions` is appended.
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct LlmConfig {
    /// OpenAI-compatible base URL; `/chat/completions` is appended.
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    /// How many past messages to include as translation context.
    #[serde(default = "default_context_messages")]
    pub context_messages: usize,
    /// Omit to use the model's default sampling temperature.
    #[serde(default)]
    pub temperature: Option<f64>,
}

fn default_context_messages() -> usize {
    5
}

#[derive(Debug, Deserialize)]
pub struct TtsConfig {
    /// OpenAI-compatible base URL; `/audio/speech` is appended.
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_voice")]
    pub voice: String,
}

fn default_voice() -> String {
    "alloy".into()
}
