//! Per-language clinical prompt material, written as text files under
//! `prompts/` and compiled into the binary.
//!
//! * `prompts/targets/<code>.txt` — general rendering notes for that language
//!   (register, script, loanword handling) plus the clinical layer: lay vs
//!   technical register, code-mixing conventions of that language's
//!   healthcare settings, how doses are said.
//! * `prompts/pairs/<src>-<tgt>.txt` — notes for exact source→target pairs,
//!   such as Mandarin→Cantonese, where character conversion masquerades as
//!   translation.

use voice_translations::lang_notes::{self, NoteTable};

macro_rules! prompt_files {
    ($dir:literal, $($key:literal),* $(,)?) => {
        &[ $( ($key, include_str!(concat!("../prompts/", $dir, "/", $key, ".txt"))) ),* ]
    };
}

/// Rendering notes, one per target language.
static TARGET_NOTES: NoteTable = prompt_files!(
    "targets", "en", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn",
    "ur", "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

/// Extra notes for specific source→target pairs, keyed `"<src>-<tgt>"`.
static PAIR_NOTES: NoteTable = prompt_files!("pairs", "zh-yue", "yue-zh");

/// The language notes for one turn: the target language's notes plus any
/// notes for the exact source→target pair, appended to the domain prompt.
pub fn language_notes(source_lang: Option<&str>, target_lang: &str) -> Option<String> {
    lang_notes::compose(TARGET_NOTES, PAIR_NOTES, source_lang, target_lang)
}

#[cfg(test)]
mod tests {
    use super::{language_notes, PAIR_NOTES, TARGET_NOTES};
    use crate::config::DEFAULT_LANGUAGES;
    use voice_translations::lang_notes::lang_code;

    #[test]
    fn every_offered_language_has_notes() {
        for lang in DEFAULT_LANGUAGES {
            assert!(
                language_notes(None, lang).is_some(),
                "no language notes for {lang}"
            );
        }
        assert_eq!(TARGET_NOTES.len(), DEFAULT_LANGUAGES.len());
        assert_eq!(PAIR_NOTES.len(), 2);
        for (code, text) in TARGET_NOTES {
            assert_eq!(lang_code(code), Some(*code), "unknown language {code}");
            assert!(!text.trim().is_empty(), "empty notes for {code}");
        }
    }

    #[test]
    fn cantonese_notes_carry_base_rules_and_hk_clinical_terms() {
        let notes = language_notes(None, "yue").unwrap();
        assert!(notes.contains("書面語"), "base register rule");
        assert!(notes.contains("覆診"), "clinical layer");
        assert!(notes.contains("食藥"));
    }

    #[test]
    fn pair_notes_stack_on_target_notes() {
        let combined = language_notes(Some("Chinese"), "Cantonese").unwrap();
        assert!(combined.contains("聽日"), "pair conversion table");
        let english = language_notes(Some("Korean"), "en").unwrap();
        assert!(!english.contains("PAIR NOTES"));
    }
}
