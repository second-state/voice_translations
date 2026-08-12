//! Per-language clinical rendering notes, written as text files under
//! `prompts/targets/` and compiled into the binary.
//!
//! One file per offered language: the clinical layer for rendering *into*
//! that language (lay vs technical register, code-mixing conventions, how
//! doses are said). These sit on top of the base crate's general
//! per-language notes, which every translation request already receives.

use voice_translations::lang_notes::lang_code;

macro_rules! prompt_files {
    ($dir:literal, $($code:literal),* $(,)?) => {
        &[ $( ($code, include_str!(concat!("../prompts/", $dir, "/", $code, ".txt"))) ),* ]
    };
}

/// Clinical rendering notes, one per target language.
static CLINICAL_NOTES: &[(&str, &str)] = prompt_files!(
    "targets", "en", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn",
    "ur", "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

/// The clinical layer of target-language notes for one translation turn,
/// appended to the domain prompt (the base crate contributes the general
/// per-language notes on its own).
pub fn clinical_notes(target_lang: &str) -> Option<&'static str> {
    let code = lang_code(target_lang)?;
    CLINICAL_NOTES
        .iter()
        .find(|(k, _)| *k == code)
        .map(|(_, text)| text.trim())
}

#[cfg(test)]
mod tests {
    use super::{clinical_notes, CLINICAL_NOTES};
    use crate::config::DEFAULT_LANGUAGES;

    #[test]
    fn every_offered_language_has_clinical_notes() {
        for lang in DEFAULT_LANGUAGES {
            assert!(
                clinical_notes(lang).is_some(),
                "no clinical notes for {lang}"
            );
        }
        assert_eq!(CLINICAL_NOTES.len(), DEFAULT_LANGUAGES.len());
    }

    #[test]
    fn cantonese_clinical_notes_keep_hk_terms() {
        let notes = clinical_notes("yue").unwrap();
        assert!(notes.contains("覆診"));
        assert!(notes.contains("食藥"));
    }
}
