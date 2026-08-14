//! The kinds of conference call the app can be tuned to.
//!
//! Each entry carries one piece of domain knowledge:
//! [`CallType::guidance`] — register and terminology notes appended to the
//! translation system prompt. A negotiation, a wedding toast, and a group of
//! friends talking over each other fail in completely different ways when
//! translated with one generic register; the guidance names the failure modes
//! that matter for that kind of call.

use serde::Serialize;

/// One kind of conference call, with the prompt material that specializes the
/// translator to it.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CallType {
    /// Stable identifier used on the wire and in `config.toml`.
    pub id: &'static str,
    /// Human-readable name shown in the picker.
    pub label: &'static str,
    /// Emoji shown next to the label.
    pub icon: &'static str,
    /// One-line description of the kinds of call this covers.
    pub blurb: &'static str,
    /// Register and terminology notes for the translator.
    #[serde(skip)]
    pub guidance: &'static str,
}

/// The call type used when a request names none or names an unknown one.
pub const DEFAULT_CALL_TYPE: &str = "business";

/// Look a call type up by [`CallType::id`].
pub fn find(id: &str) -> Option<&'static CallType> {
    let id = id.trim();
    CALL_TYPES.iter().find(|t| t.id.eq_ignore_ascii_case(id))
}

/// Look a call type up, falling back to [`DEFAULT_CALL_TYPE`].
pub fn find_or_default(id: Option<&str>) -> &'static CallType {
    id.and_then(find)
        .or_else(|| find(DEFAULT_CALL_TYPE))
        .expect("the default call type is always present")
}

/// Every call type, in the order the picker shows them.
pub static CALL_TYPES: &[CallType] = &[
    CallType {
        id: "business",
        label: "Business meeting",
        icon: "💼",
        blurb: "Status meetings, negotiations, sales calls, planning sessions",
        guidance: include_str!("../prompts/types/business.txt"),
    },
    CallType {
        id: "formal",
        label: "Formal event",
        icon: "🎩",
        blurb: "Ceremonies, official announcements, diplomatic exchanges, speeches",
        guidance: include_str!("../prompts/types/formal.txt"),
    },
    CallType {
        id: "friends",
        label: "Friends & family",
        icon: "😄",
        blurb: "Casual catch-ups, group chats, banter between friends and relatives",
        guidance: include_str!("../prompts/types/friends.txt"),
    },
    CallType {
        id: "politics",
        label: "Politics & current affairs",
        icon: "🏛️",
        blurb: "Political discussion, debate, policy talk, news commentary",
        guidance: include_str!("../prompts/types/politics.txt"),
    },
    CallType {
        id: "book_club",
        label: "Book club",
        icon: "📚",
        blurb: "Literature discussion, reading groups, author talks",
        guidance: include_str!("../prompts/types/book_club.txt"),
    },
    CallType {
        id: "tech",
        label: "Tech & engineering",
        icon: "🛠️",
        blurb: "Engineering standups, code reviews, product and architecture calls",
        guidance: include_str!("../prompts/types/tech.txt"),
    },
];

#[cfg(test)]
mod tests {
    use super::{find, find_or_default, CALL_TYPES, DEFAULT_CALL_TYPE};

    #[test]
    fn default_call_type_exists() {
        assert!(find(DEFAULT_CALL_TYPE).is_some());
        assert_eq!(find_or_default(None).id, DEFAULT_CALL_TYPE);
        assert_eq!(find_or_default(Some("no-such-type")).id, DEFAULT_CALL_TYPE);
    }

    #[test]
    fn lookup_is_case_insensitive_and_trimmed() {
        assert_eq!(find(" Book_Club ").unwrap().id, "book_club");
    }

    #[test]
    fn every_call_type_carries_its_prompt_material() {
        for t in CALL_TYPES {
            assert!(!t.label.is_empty(), "{} has no label", t.id);
            assert!(!t.blurb.is_empty(), "{} has no blurb", t.id);
            assert!(
                t.guidance.len() > 200,
                "{} has a suspiciously short guidance block",
                t.id
            );
            assert!(
                t.id.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is not a safe id",
                t.id
            );
        }
    }
}
