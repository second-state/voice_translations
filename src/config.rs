use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

/// Application configuration loaded from `config.toml`.
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
            sentence_break_ms: 700,
            min_speech_ms: 250,
            max_utterance_ms: 15_000,
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
