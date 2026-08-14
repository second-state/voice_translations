//! Per-language conference prompt material, written as text files under
//! `prompts/` and compiled into the binary.
//!
//! Two kinds of files live here, layered on top of the base library's
//! general per-language notes (which every translation request already
//! receives):
//!
//! * `prompts/targets/<code>.txt` — how that language's register machinery
//!   (tu/vous, speech levels, particles, code-mixing habits) maps onto the
//!   formality axis the call types move along.
//! * `prompts/pairs/<src>-<tgt>.txt` — conference-specific notes for exact
//!   source→target pairs, such as how Hong Kong business code-mixing should
//!   be produced or resolved.

use voice_translations::lang_notes::lang_code;

macro_rules! prompt_files {
    ($dir:literal, $($key:literal),* $(,)?) => {
        &[ $( ($key, include_str!(concat!("../prompts/", $dir, "/", $key, ".txt"))) ),* ]
    };
}

/// Conference register notes, one per target language.
static CONFERENCE_NOTES: &[(&str, &str)] = prompt_files!(
    "targets", "en", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn",
    "ur", "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

/// Extra notes for specific source→target pairs, keyed `"<src>-<tgt>"`.
static PAIR_NOTES: &[(&str, &str)] = prompt_files!("pairs", "zh-yue", "yue-zh");

fn lookup(table: &'static [(&str, &str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, text)| text.trim())
}

/// The conference layer of language notes for one utterance: the target
/// language's register notes plus any notes for the exact source→target
/// pair. Appended to the domain prompt; the base crate contributes the
/// general per-language notes on its own.
pub fn conference_notes(source_lang: Option<&str>, target_lang: &str) -> Option<String> {
    let target = lang_code(target_lang)?;
    let mut out = String::new();
    if let Some(notes) = lookup(CONFERENCE_NOTES, target) {
        out.push_str(notes);
    }
    if let Some(pair) = source_lang
        .and_then(lang_code)
        .and_then(|src| lookup(PAIR_NOTES, &format!("{src}-{target}")))
    {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(pair);
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::{conference_notes, CONFERENCE_NOTES, PAIR_NOTES};
    use voice_translations::lang_notes::lang_code;

    #[test]
    fn every_notes_file_maps_to_a_known_language() {
        for (code, text) in CONFERENCE_NOTES {
            assert_eq!(lang_code(code), Some(*code), "unknown language {code}");
            assert!(!text.trim().is_empty(), "empty notes for {code}");
        }
        assert_eq!(CONFERENCE_NOTES.len(), 25);
        assert_eq!(PAIR_NOTES.len(), 2);
    }

    #[test]
    fn notes_resolve_from_names_or_codes() {
        assert!(conference_notes(None, "Korean").unwrap().contains("합쇼체"));
        assert!(conference_notes(None, "yue").unwrap().contains("書面語"));
        assert!(conference_notes(None, "Klingon").is_none());
    }

    #[test]
    fn pair_notes_stack_on_target_notes() {
        let combined = conference_notes(Some("Chinese"), "Cantonese").unwrap();
        assert!(combined.contains("CONFERENCE LANGUAGE NOTES"));
        assert!(combined.contains("CONFERENCE PAIR NOTES"));
        assert!(combined.contains("收工"));
        // No pair file for this direction: target notes alone.
        let english = conference_notes(Some("Korean"), "en").unwrap();
        assert!(!english.contains("PAIR NOTES"));
    }
}
