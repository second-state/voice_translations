//! The small command line both apps share.
//!
//! Deployment is the reason this exists: a binary that only ever reads
//! `./config.toml` forces the operator to control which configuration is used
//! by controlling the working directory, which is easy to get wrong and
//! invisible when it goes wrong. `--config <path>` makes it explicit, and the
//! app logs the absolute path it resolved.

use std::{ffi::OsString, path::PathBuf};

use anyhow::{bail, Result};

/// How one app presents itself on the command line.
pub struct CliSpec<'a> {
    /// Binary name, used in usage output.
    pub app: &'a str,
    /// Version reported by `--version`; pass the *binary's*
    /// `env!("CARGO_PKG_VERSION")`, not this crate's.
    pub version: &'a str,
    /// One-line description for the usage output.
    pub about: &'a str,
    /// Environment variable consulted when `--config` is absent.
    pub env_var: &'a str,
    /// Config file used when neither the flag nor the variable is set.
    pub default_config: &'a str,
}

/// Parsed command line.
#[derive(Debug, PartialEq, Eq)]
pub struct Cli {
    /// Configuration file to load.
    pub config: PathBuf,
}

impl Cli {
    /// Parse the process arguments.
    ///
    /// Returns `Ok(None)` when `--help` or `--version` was handled and the
    /// caller should exit successfully — printing and exiting is left to the
    /// caller rather than done here, so this stays usable from a test.
    pub fn parse(spec: &CliSpec<'_>) -> Result<Option<Self>> {
        Self::parse_from(spec, std::env::args_os().skip(1))
    }

    /// Parse an explicit argument list (the process name already removed).
    pub fn parse_from<I>(spec: &CliSpec<'_>, args: I) -> Result<Option<Self>>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut args = args.into_iter();
        let mut config: Option<PathBuf> = None;

        while let Some(arg) = args.next() {
            let text = arg.to_string_lossy().into_owned();
            match text.as_str() {
                "-c" | "--config" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--config needs a file path"))?;
                    config = Some(PathBuf::from(value));
                }
                "-h" | "--help" => {
                    print!("{}", usage(spec));
                    return Ok(None);
                }
                "-V" | "--version" => {
                    println!("{} {}", spec.app, spec.version);
                    return Ok(None);
                }
                // `--config=path`, and the same for the short form.
                _ if text.starts_with("--config=") => {
                    config = Some(PathBuf::from(&text["--config=".len()..]));
                }
                _ if text.starts_with("-c") && text.len() > 2 => {
                    config = Some(PathBuf::from(&text[2..]));
                }
                other => bail!("unrecognized argument {other:?}; run with --help"),
            }
        }

        let config = config
            .or_else(|| std::env::var_os(spec.env_var).map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from(spec.default_config));
        if config.as_os_str().is_empty() {
            bail!("the configuration file path is empty");
        }
        Ok(Some(Self { config }))
    }
}

fn usage(spec: &CliSpec<'_>) -> String {
    format!(
        "{app} {version}\n{about}\n\n\
         USAGE:\n    {app} [--config <path>]\n\n\
         OPTIONS:\n\
         \x20   -c, --config <path>  Configuration file to load\n\
         \x20                        [env: {env}] [default: {default}]\n\
         \x20   -h, --help           Print this help\n\
         \x20   -V, --version        Print the version\n",
        app = spec.app,
        version = spec.version,
        about = spec.about,
        env = spec.env_var,
        default = spec.default_config,
    )
}

#[cfg(test)]
mod tests {
    use super::{Cli, CliSpec};
    use std::{ffi::OsString, path::PathBuf};

    const SPEC: CliSpec<'static> = CliSpec {
        app: "test-app",
        version: "1.2.3",
        about: "a test",
        // A name no test environment will have set, so the default applies.
        env_var: "VOICE_TRANSLATIONS_TEST_CONFIG_UNSET",
        default_config: "config.toml",
    };

    fn parse(args: &[&str]) -> anyhow::Result<Option<Cli>> {
        Cli::parse_from(&SPEC, args.iter().map(OsString::from))
    }

    #[test]
    fn defaults_when_no_arguments() {
        let cli = parse(&[]).unwrap().unwrap();
        assert_eq!(cli.config, PathBuf::from("config.toml"));
    }

    #[test]
    fn accepts_every_flag_spelling() {
        for args in [
            vec!["--config", "/etc/app.toml"],
            vec!["-c", "/etc/app.toml"],
            vec!["--config=/etc/app.toml"],
            vec!["-c/etc/app.toml"],
        ] {
            let cli = parse(&args).unwrap().unwrap();
            assert_eq!(cli.config, PathBuf::from("/etc/app.toml"), "{args:?}");
        }
    }

    #[test]
    fn help_and_version_stop_startup() {
        assert!(parse(&["--help"]).unwrap().is_none());
        assert!(parse(&["-h"]).unwrap().is_none());
        assert!(parse(&["--version"]).unwrap().is_none());
        assert!(parse(&["-V"]).unwrap().is_none());
    }

    #[test]
    fn rejects_bad_input_instead_of_guessing() {
        assert!(parse(&["--config"]).is_err());
        assert!(parse(&["--nonsense"]).is_err());
        assert!(parse(&["extra-positional"]).is_err());
        assert!(parse(&["--config="]).is_err());
    }

    #[test]
    fn usage_mentions_the_env_var_and_default() {
        let text = super::usage(&SPEC);
        assert!(text.contains("test-app 1.2.3"));
        assert!(text.contains(SPEC.env_var));
        assert!(text.contains("config.toml"));
    }
}
