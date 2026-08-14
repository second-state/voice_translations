//! Configuration: the upstream `[server] [audio] [languages] [asr] [llm]
//! [tts]` sections plus this app's own `[conference]` section, read from one
//! `config.toml`.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::call_type::{self, DEFAULT_CALL_TYPE};

/// Everything loaded from `config.toml`.
pub struct AppConfig {
    /// Sections the upstream crate owns.
    pub base: voice_translations::Config,
    /// This app's `[conference]` section.
    pub conference: ConferenceConfig,
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
        // Parsed twice against two independent structs: the upstream config
        // ignores `[conference]`, and this one ignores everything else, so
        // neither crate has to know about the other's settings.
        let base =
            toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))?;
        let root: FileRoot = toml::from_str(&raw)
            .with_context(|| format!("failed to parse [conference] in {}", path.display()))?;
        let conference = root.conference.validated()?;
        Ok(Self { base, conference })
    }
}

/// Only the section this app owns; every other table in the file is ignored.
#[derive(Debug, Deserialize)]
struct FileRoot {
    #[serde(default)]
    conference: ConferenceConfig,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ConferenceConfig {
    /// Call type selected when the page loads.
    pub default_type: String,
}

impl Default for ConferenceConfig {
    fn default() -> Self {
        Self {
            default_type: DEFAULT_CALL_TYPE.into(),
        }
    }
}

impl ConferenceConfig {
    /// Reject a `default_type` that does not exist rather than silently
    /// falling back at every request.
    fn validated(self) -> Result<Self> {
        if call_type::find(&self.default_type).is_none() {
            anyhow::bail!(
                "[conference] default_type = {:?} is not a known call type; valid ids: {}",
                self.default_type,
                call_type::CALL_TYPES
                    .iter()
                    .map(|t| t.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::ConferenceConfig;

    fn config(toml: &str) -> anyhow::Result<ConferenceConfig> {
        let root: super::FileRoot = toml::from_str(toml)?;
        root.conference.validated()
    }

    #[test]
    fn defaults_are_usable() {
        let cfg = config("").expect("defaults validate");
        assert_eq!(cfg.default_type, "business");
    }

    #[test]
    fn known_type_is_accepted() {
        let cfg = config("[conference]\ndefault_type = \"book_club\"\n").unwrap();
        assert_eq!(cfg.default_type, "book_club");
    }

    #[test]
    fn unknown_type_is_a_startup_error() {
        let err = config("[conference]\ndefault_type = \"seance\"\n").unwrap_err();
        assert!(err.to_string().contains("not a known call type"));
    }
}
