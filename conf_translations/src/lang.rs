//! Per-language conference prompt material, written as text files under
//! `prompts/` and compiled into the binary.
//!
//! * `prompts/targets/<code>.txt` — general rendering notes for that language
//!   (register defaults, script, loanword handling) plus how its register
//!   machinery (tu/vous, speech levels, particles, code-mixing habits) maps
//!   onto the formality axis the call types move along.
//! * `prompts/pairs/<src>-<tgt>.txt` — notes for exact source→target pairs,
//!   such as Mandarin→Cantonese, where character conversion masquerades as
//!   translation and Hong Kong code-mixing must be produced or resolved.

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

/// The language notes for one utterance: the target language's notes plus any
/// notes for the exact source→target pair, appended to the domain prompt.
pub fn language_notes(source_lang: Option<&str>, target_lang: &str) -> Option<String> {
    lang_notes::compose(TARGET_NOTES, PAIR_NOTES, source_lang, target_lang)
}

#[cfg(test)]
mod tests {
    use super::{language_notes, PAIR_NOTES, TARGET_NOTES};
    use voice_translations::lang_notes::lang_code;

    #[test]
    fn every_notes_file_maps_to_a_known_language() {
        for (code, text) in TARGET_NOTES {
            assert_eq!(lang_code(code), Some(*code), "unknown language {code}");
            assert!(!text.trim().is_empty(), "empty notes for {code}");
        }
        assert_eq!(TARGET_NOTES.len(), 25);
        assert_eq!(PAIR_NOTES.len(), 2);
    }

    #[test]
    fn notes_carry_base_rules_and_the_conference_layer() {
        let korean = language_notes(None, "Korean").unwrap();
        assert!(korean.contains("해요체"), "base register default");
        assert!(korean.contains("합쇼체"), "conference register dial");
        let cantonese = language_notes(None, "yue").unwrap();
        assert!(cantonese.contains("書面語"));
        assert!(language_notes(None, "Klingon").is_none());
    }

    #[test]
    fn pair_notes_stack_on_target_notes() {
        let combined = language_notes(Some("Chinese"), "Cantonese").unwrap();
        assert!(combined.contains("聽日"), "base pair conversion table");
        assert!(combined.contains("收工"), "conference pair layer");
        let english = language_notes(Some("Korean"), "en").unwrap();
        assert!(!english.contains("PAIR NOTES"));
    }
}
