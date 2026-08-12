//! Per-language prompt material, written as text files under `prompts/` and
//! compiled into the binary.
//!
//! Two kinds of files live here:
//!
//! * `prompts/primers/<code>.txt` — a general clinical vocabulary sample *in
//!   that language*, sent to the speech recognizer when the turn's language
//!   is known. English turns get the sharper per-specialty primer from
//!   [`crate::specialty`] instead.
//! * `prompts/targets/<code>.txt` — the clinical layer for rendering *into*
//!   that language (lay vs technical register, code-mixing conventions, how
//!   doses are said). These sit on top of the base crate's general
//!   per-language notes, which every translation request already receives.

use voice_translations::lang_notes::lang_code;

use crate::config::AsrPrimer;
use crate::prompt;
use crate::specialty::Specialty;

macro_rules! prompt_files {
    ($dir:literal, $($code:literal),* $(,)?) => {
        &[ $( ($code, include_str!(concat!("../prompts/", $dir, "/", $code, ".txt"))) ),* ]
    };
}

/// General clinical vocabulary primers, one per non-English language.
static PRIMERS: &[(&str, &str)] = prompt_files!(
    "primers", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn", "ur",
    "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

/// Clinical rendering notes, one per target language.
static CLINICAL_NOTES: &[(&str, &str)] = prompt_files!(
    "targets", "en", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn",
    "ur", "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

fn lookup(table: &'static [(&str, &str)], lang: &str) -> Option<&'static str> {
    let code = lang_code(lang)?;
    table
        .iter()
        .find(|(k, _)| *k == code)
        .map(|(_, text)| text.trim())
}

/// The vocabulary primer to send with one transcription request, given the
/// configured mode, the turn's (pinned) language, and the active specialty.
///
/// English turns get the specialty's own primer — dense drug and procedure
/// vocabulary. Turns pinned to another offered language get that language's
/// general clinical primer, so the recognizer is biased in the language it is
/// about to hear rather than confused by an English one. Turns of unknown
/// language get no primer in `Auto` mode; `Always` falls back to the English
/// specialty primer at the operator's own risk.
pub fn primer_for(
    mode: AsrPrimer,
    language: Option<&str>,
    specialty: &Specialty,
) -> Option<String> {
    if mode == AsrPrimer::Never {
        return None;
    }
    match language.and_then(lang_code) {
        Some("en") => Some(prompt::asr_primer(specialty)),
        Some(code) => lookup(PRIMERS, code).map(str::to_string),
        None => match mode {
            AsrPrimer::Always => Some(prompt::asr_primer(specialty)),
            _ => None,
        },
    }
}

/// The clinical layer of target-language notes for one translation turn,
/// appended to the domain prompt (the base crate contributes the general
/// per-language notes on its own).
pub fn clinical_notes(target_lang: &str) -> Option<&'static str> {
    lookup(CLINICAL_NOTES, target_lang)
}

#[cfg(test)]
mod tests {
    use super::{clinical_notes, primer_for, CLINICAL_NOTES, PRIMERS};
    use crate::config::{AsrPrimer, DEFAULT_LANGUAGES};
    use crate::specialty::find;

    #[test]
    fn every_offered_language_has_primer_and_notes() {
        for lang in DEFAULT_LANGUAGES {
            assert!(
                clinical_notes(lang).is_some(),
                "no clinical notes for {lang}"
            );
            if *lang != "English" {
                let spec = find("primary_care").unwrap();
                let primer = primer_for(AsrPrimer::Auto, Some(lang), spec)
                    .unwrap_or_else(|| panic!("no primer for {lang}"));
                assert!(!primer.trim().is_empty());
            }
        }
        assert_eq!(CLINICAL_NOTES.len(), DEFAULT_LANGUAGES.len());
        assert_eq!(PRIMERS.len(), DEFAULT_LANGUAGES.len() - 1);
    }

    #[test]
    fn english_turns_get_the_specialty_primer() {
        let spec = find("cardiology").unwrap();
        let primer = primer_for(AsrPrimer::Auto, Some("en"), spec).unwrap();
        assert!(primer.contains("cardiology"));
        assert!(primer.starts_with("Transcript of a"));
    }

    #[test]
    fn pinned_languages_get_their_own_primer() {
        let spec = find("primary_care").unwrap();
        let spanish = primer_for(AsrPrimer::Auto, Some("es"), spec).unwrap();
        assert!(spanish.contains("presión arterial"));
        let cantonese = primer_for(AsrPrimer::Auto, Some("Cantonese"), spec).unwrap();
        assert!(cantonese.contains("覆診"));
    }

    #[test]
    fn primer_modes_gate_the_unknown_language_case() {
        let spec = find("primary_care").unwrap();
        assert!(primer_for(AsrPrimer::Auto, None, spec).is_none());
        assert!(primer_for(AsrPrimer::Always, None, spec).is_some());
        assert!(primer_for(AsrPrimer::Never, Some("es"), spec).is_none());
    }

    #[test]
    fn cantonese_clinical_notes_keep_hk_terms() {
        let notes = clinical_notes("yue").unwrap();
        assert!(notes.contains("覆診"));
        assert!(notes.contains("食藥"));
    }
}
