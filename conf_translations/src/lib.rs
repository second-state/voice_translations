//! Conference-call translation on top of the `voice_translations` pipeline.
//!
//! This crate is both the standalone translator binary (`src/main.rs`) and
//! the library that carries the conference domain: the call types, the
//! register and terminology notes behind each, the per-language rendering
//! notes, and the handlers that assemble them. The hosted edition
//! (`conf_saas`) depends on it so the domain lives in exactly one place — a
//! change to a call type's guidance reaches both apps at once — and adds
//! only its own layer: accounts, quota, billing, and the UI around them.
//!
//! Nothing about speech, translation, or audio is implemented here either;
//! that all comes from `voice_translations`.

pub mod api;
pub mod call_type;
pub mod config;
pub mod lang;
pub mod prompt;
