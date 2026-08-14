//! Composition of the domain prompt handed to the translation service:
//! [`domain_prompt`] — the call setting plus the call type's register and
//! terminology notes, spliced into the base system prompt by
//! [`voice_translations::translate::build_system_prompt`].

use crate::call_type::CallType;

/// The domain prompt for one turn: the call setting plus the type's register
/// and terminology notes. Applies equally to the same-language polishing pass
/// (`editing`), where register must survive cleanup.
pub fn domain_prompt(call_type: &CallType, editing: bool) -> String {
    let task = if editing {
        "You are polishing the raw transcript of one utterance from this call for the record; \
         keep the speaker's own register while cleaning it up."
    } else {
        "You are translating one utterance of this call live; the register notes below govern \
         how it should sound in the target language."
    };
    format!(
        "CALL SETTING\nThis is a live conference call: {}. {}\n\n{}",
        call_type.blurb.to_lowercase(),
        task,
        call_type.guidance
    )
}

#[cfg(test)]
mod tests {
    use super::domain_prompt;
    use crate::call_type::find;

    #[test]
    fn domain_prompt_carries_setting_and_guidance() {
        let business = find("business").unwrap();
        let prompt = domain_prompt(business, false);
        assert!(prompt.contains("CALL SETTING"));
        assert!(prompt.contains("translating one utterance"));
        assert!(prompt.contains("BUSINESS MEETING NOTES"));

        let editing = domain_prompt(business, true);
        assert!(editing.contains("polishing the raw transcript"));
        assert!(editing.contains("BUSINESS MEETING NOTES"));
    }
}
