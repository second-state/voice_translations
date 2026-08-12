//! Per-target-language and per-pair rendering notes, written as text files
//! under `prompts/` and compiled into the binary.
//!
//! Every translation request automatically receives the target language's
//! notes (register, formality, script conventions) plus, when one exists, a
//! note for the exact source→target pair — Mandarin→Cantonese being the
//! motivating case, where character conversion masquerades as translation.
//!
//! Downstream apps layer their own domain files on top through
//! [`crate::translate::TranslateRequest::domain_prompt`]; these base notes are
//! general-purpose and domain-free.

/// Compile a `(key, file contents)` table out of `prompts/<dir>/<key>.txt`.
macro_rules! note_files {
    ($dir:literal, $($key:literal),* $(,)?) => {
        &[ $( ($key, include_str!(concat!("../prompts/", $dir, "/", $key, ".txt"))) ),* ]
    };
}

/// Display name (as produced by [`crate::asr::normalize_language`]) → ISO code
/// used in prompt file names.
const LANG_CODES: &[(&str, &str)] = &[
    ("English", "en"),
    ("Spanish", "es"),
    ("Chinese", "zh"),
    ("Cantonese", "yue"),
    ("Vietnamese", "vi"),
    ("Tagalog", "tl"),
    ("Korean", "ko"),
    ("Arabic", "ar"),
    ("Russian", "ru"),
    ("Haitian Creole", "ht"),
    ("Portuguese", "pt"),
    ("French", "fr"),
    ("Hindi", "hi"),
    ("Bengali", "bn"),
    ("Urdu", "ur"),
    ("Persian", "fa"),
    ("Japanese", "ja"),
    ("Somali", "so"),
    ("Amharic", "am"),
    ("Nepali", "ne"),
    ("Burmese", "my"),
    ("Ukrainian", "uk"),
    ("Polish", "pl"),
    ("German", "de"),
    ("Italian", "it"),
];

/// One rendering-notes file per target language.
static TARGET_NOTES: &[(&str, &str)] = note_files!(
    "targets", "en", "es", "zh", "yue", "vi", "tl", "ko", "ar", "ru", "ht", "pt", "fr", "hi", "bn",
    "ur", "fa", "ja", "so", "am", "ne", "my", "uk", "pl", "de", "it",
);

/// Extra notes for specific source→target pairs, keyed `"<src>-<tgt>"`.
static PAIR_NOTES: &[(&str, &str)] = note_files!("pairs", "zh-yue", "yue-zh");

/// ISO code for a language given as a code, a display name, or anything
/// [`crate::asr::normalize_language`] understands. `None` when unknown.
pub fn lang_code(lang: &str) -> Option<&'static str> {
    let trimmed = lang.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    if let Some((_, code)) = LANG_CODES
        .iter()
        .find(|(name, code)| lower == *code || lower == name.to_lowercase())
    {
        return Some(code);
    }
    let name = crate::asr::normalize_language(trimmed);
    LANG_CODES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, code)| *code)
}

fn lookup(table: &'static [(&str, &str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, text)| text.trim())
}

/// The rendering notes for one target language, if any exist.
pub fn target_notes(target_lang: &str) -> Option<&'static str> {
    lookup(TARGET_NOTES, lang_code(target_lang)?)
}

/// The notes for one exact source→target pair, if any exist.
pub fn pair_notes(source_lang: &str, target_lang: &str) -> Option<&'static str> {
    let key = format!("{}-{}", lang_code(source_lang)?, lang_code(target_lang)?);
    lookup(PAIR_NOTES, &key)
}

/// Everything the system prompt should say about rendering into
/// `target_lang`: the target's own notes plus any pair-specific notes.
pub fn notes_for(source_lang: Option<&str>, target_lang: &str) -> Option<String> {
    let mut out = String::new();
    if let Some(notes) = target_notes(target_lang) {
        out.push_str(notes);
    }
    if let Some(pair) = source_lang.and_then(|src| pair_notes(src, target_lang)) {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(pair);
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::{lang_code, notes_for, pair_notes, target_notes, LANG_CODES, TARGET_NOTES};

    #[test]
    fn every_language_has_target_notes() {
        for (name, code) in LANG_CODES {
            let notes =
                target_notes(name).unwrap_or_else(|| panic!("no target notes for {name} ({code})"));
            assert!(!notes.is_empty());
        }
        assert_eq!(LANG_CODES.len(), TARGET_NOTES.len());
    }

    #[test]
    fn languages_resolve_from_code_or_name() {
        assert_eq!(lang_code("yue"), Some("yue"));
        assert_eq!(lang_code("Cantonese"), Some("yue"));
        assert_eq!(lang_code("Haitian Creole"), Some("ht"));
        assert_eq!(lang_code("KOREAN"), Some("ko"));
        assert_eq!(lang_code("kr"), Some("ko"));
        assert_eq!(lang_code("Klingon"), None);
        assert_eq!(lang_code(""), None);
    }

    #[test]
    fn cantonese_notes_demand_spoken_hong_kong_cantonese() {
        let notes = target_notes("Cantonese").unwrap();
        assert!(notes.contains("我哋聽日去醫院"));
        assert!(notes.contains("書面語"));
    }

    #[test]
    fn mandarin_to_cantonese_gets_the_pair_notes() {
        assert!(pair_notes("Chinese", "Cantonese").unwrap().contains("聽日"));
        assert!(pair_notes("Cantonese", "Chinese").unwrap().contains("明天"));
        assert!(pair_notes("English", "Cantonese").is_none());

        let combined = notes_for(Some("zh"), "yue").unwrap();
        assert!(combined.contains("TARGET LANGUAGE NOTE"));
        assert!(combined.contains("PAIR NOTES"));
    }
}
