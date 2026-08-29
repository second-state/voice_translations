//! Configuration, read from one `config.toml`.
//!
//! Three crates own three parts of the file, and each parses only its own:
//! `[server] [audio] [asr] [llm] [tts]` belong to the `voice_translations`
//! library, `[medical]` to the `medical_translations` translator, and
//! `[auth] [email] [quota] [stripe] [admin]` to the `saas_core` service
//! layer. This module reads the file once and hands the text to all three.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

use medical_translations::config::MedicalConfig;
use saas_core::SaasConfig;

/// Everything loaded from `config.toml`.
pub struct AppConfig {
    /// Sections the library owns; consumed when the pipeline state is built.
    pub base: voice_translations::Config,
    /// The translator's own settings, shared with the standalone medical app.
    pub medical: MedicalConfig,
    /// Accounts, login links, quota, billing, and the dashboard.
    pub saas: SaasConfig,
}

impl AppConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read {}; copy config.example.toml to config.toml and fill in your \
                 credentials",
                path.display()
            )
        })?;
        // Parsed three times against three independent structs, each of
        // which ignores the tables it does not know, so no crate has to know
        // about another's settings.
        let base =
            toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))?;
        let root: FileRoot = toml::from_str(&raw)
            .with_context(|| format!("failed to parse [medical] in {}", path.display()))?;
        let medical = root.medical.normalized()?;
        let saas = SaasConfig::parse(&raw, crate::BRAND)
            .with_context(|| format!("in {}", path.display()))?;
        Ok(Self {
            base,
            medical,
            saas,
        })
    }
}

/// Only the section this app owns; every other table in the file is ignored.
#[derive(Debug, Deserialize)]
struct FileRoot {
    #[serde(default)]
    medical: MedicalConfig,
}
