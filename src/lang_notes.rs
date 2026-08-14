//! Language-code resolution and note-table composition.
//!
//! This module carries **no prompt content**. Apps write their per-language
//! and per-pair rendering notes as text files in their own `prompts/`
//! directories, compile them into `(key, contents)` tables with
//! `include_str!`, and hand those tables to [`compose`] when building a
//! [`crate::translate::TranslateRequest::domain_prompt`]. See
//! `conf_translations` and `medical_translations` for the pattern.

/// A compiled-in table of `(key, file contents)` pairs, keyed by ISO language
/// code (`"ko"`) for target notes or `"<src>-<tgt>"` (`"zh-yue"`) for pair
/// notes.
pub type NoteTable = &'static [(&'static str, &'static str)];

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

fn lookup(table: NoteTable, key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, text)| text.trim())
}

/// Everything an app's note tables say about rendering into `target_lang`:
/// the target's own notes plus, when the source is known and a file exists,
/// the notes for the exact source→target pair. Language arguments may be ISO
/// codes or display names.
pub fn compose(
    targets: NoteTable,
    pairs: NoteTable,
    source_lang: Option<&str>,
    target_lang: &str,
) -> Option<String> {
    let target = lang_code(target_lang)?;
    let mut out = String::new();
    if let Some(notes) = lookup(targets, target) {
        out.push_str(notes);
    }
    if let Some(pair) = source_lang
        .and_then(lang_code)
        .and_then(|src| lookup(pairs, &format!("{src}-{target}")))
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
    use super::{compose, lang_code};

    const TARGETS: super::NoteTable = &[("yue", "target notes"), ("ko", "korean notes")];
    const PAIRS: super::NoteTable = &[("zh-yue", "pair notes")];

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
    fn compose_stacks_target_and_pair_notes() {
        let combined = compose(TARGETS, PAIRS, Some("Chinese"), "Cantonese").unwrap();
        assert_eq!(combined, "target notes\n\npair notes");
        // No pair file for this direction: target notes alone.
        assert_eq!(
            compose(TARGETS, PAIRS, Some("en"), "ko").unwrap(),
            "korean notes"
        );
        // Unknown target: nothing.
        assert!(compose(TARGETS, PAIRS, None, "Klingon").is_none());
    }
}
