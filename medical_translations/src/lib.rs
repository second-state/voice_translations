//! Medical interpreting on top of the `voice_translations` pipeline.
//!
//! This crate is both the standalone interpreter binary (`src/main.rs`) and
//! the library that carries the medical domain: the specialties, the
//! interpreting rules, the per-language clinical notes, and the handlers that
//! assemble them. The hosted edition (`medical_saas`) depends on it so the
//! domain lives in exactly one place — a change to an interpreting rule or a
//! specialty's terminology reaches both apps at once — and adds only its own
//! layer: accounts, quota, billing, and the UI around them.
//!
//! Nothing about speech, translation, or audio is implemented here either;
//! that all comes from `voice_translations`.

pub mod api;
pub mod config;
pub mod lang;
pub mod prompt;
pub mod specialty;
