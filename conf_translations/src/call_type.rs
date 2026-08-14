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
        guidance: "BUSINESS MEETING NOTES:\n\
             - Numbers, prices, percentages, dates, and deadlines are the contract in the making: \
             render every figure and its currency or unit exactly as spoken, and never round or \
             restate one in a different unit.\n\
             - Keep the line between a commitment and a hedge exactly where the speaker put it: \
             \"we will deliver by Friday\" and \"we should be able to deliver by Friday\" are \
             different promises, and \"I'll look into it\" is not \"yes\".\n\
             - Company names, product names, and project code names stay exactly as spoken; do \
             not translate a product name or expand an acronym the speaker left as an acronym.\n\
             - Use the professional register of the target language's business culture, including \
             the forms of address it expects, without making the speaker sound stiffer or more \
             casual than they were.\n\
             - Action items must survive translation with their owner, task, and due date intact.",
    },
    CallType {
        id: "formal",
        label: "Formal event",
        icon: "🎩",
        blurb: "Ceremonies, official announcements, diplomatic exchanges, speeches",
        guidance: "FORMAL EVENT NOTES:\n\
             - Use the elevated, courteous register the occasion calls for in the target \
             language; a toast, a welcome address, or an official statement must sound like one.\n\
             - Titles, honorifics, and forms of address are part of the content: render them with \
             the target language's own conventions (Dr., Excellency, 教授, 先生/女士, 님) and \
             never drop or downgrade one.\n\
             - Ritual and set phrases (congratulations, condolences, welcomes, thanks) get the \
             target language's equivalent set phrase, not a literal gloss.\n\
             - Preserve the ceremony's exactness: names of people, institutions, and awards \
             letter-perfect, and quoted or cited passages clearly marked as such.\n\
             - Never inject casual fillers or contractions that lower the register below what the \
             speaker used.",
    },
    CallType {
        id: "friends",
        label: "Friends & family",
        icon: "😄",
        blurb: "Casual catch-ups, group chats, banter between friends and relatives",
        guidance: "CASUAL CONVERSATION NOTES:\n\
             - Keep it as relaxed as the speakers are: everyday words, contractions, the target \
             language's own casual particles and interjections. Formal register here is a \
             translation error.\n\
             - Jokes, teasing, sarcasm, and affectionate insults must land as jokes: carry the \
             tone, and swap idioms and slang for the target language's own equivalents rather \
             than translating them word-for-word into nonsense.\n\
             - Nicknames and pet names stay as the speaker used them.\n\
             - Emotional warmth, excitement, and complaint-for-fun should come through at the \
             same temperature - do not flatten enthusiasm into politeness.\n\
             - Kinship terms matter across languages (auntie, 表哥, 이모): pick the target term a \
             native speaker would use for the same relationship, and keep it consistent.",
    },
    CallType {
        id: "politics",
        label: "Politics & current affairs",
        icon: "🏛️",
        blurb: "Political discussion, debate, policy talk, news commentary",
        guidance: "POLITICAL DISCUSSION NOTES:\n\
             - Positions must cross the language barrier unmoved: never soften, sharpen, or \
             both-sides a speaker's stated view, and keep loaded terms as loaded as the speaker \
             made them.\n\
             - Attribution and epistemic markers are content: \"allegedly\", \"according to\", \
             \"claims\", \"denies\" must be preserved exactly - dropping one turns a report into \
             an assertion.\n\
             - Use the canonical target-language names for institutions, offices, parties, \
             treaties, and policies (the UN, 國會, la Casa Blanca), and keep politicians' names \
             in their standard rendering.\n\
             - Rhetorical devices - repetition, irony, pointed questions - are the argument; \
             reproduce the device, not a summary of it.\n\
             - Statistics, dates, vote counts, and margins exactly as spoken.",
    },
    CallType {
        id: "book_club",
        label: "Book club",
        icon: "📚",
        blurb: "Literature discussion, reading groups, author talks",
        guidance: "BOOK CLUB NOTES:\n\
             - Titles of books, stories, and poems get the published target-language title when a \
             well-known translation exists; otherwise keep the original title as spoken. Author \
             names stay in their standard rendering.\n\
             - Quoted passages are quotes: mark them clearly and translate them with more care \
             for the author's voice than for conversational smoothness.\n\
             - Literary terms (unreliable narrator, foreshadowing, 伏筆, motif) get the target \
             language's established term, not an improvised paraphrase.\n\
             - Interpretive nuance is the whole conversation: \"I read it as...\", \"maybe she \
             meant...\", \"it felt to me like...\" must keep their tentativeness, and disagreement \
             about a book must stay as strong or as mild as spoken.\n\
             - Character names stay as the speaker said them, consistently.",
    },
    CallType {
        id: "tech",
        label: "Tech & engineering",
        icon: "🛠️",
        blurb: "Engineering standups, code reviews, product and architecture calls",
        guidance: "TECH CALL NOTES:\n\
             - Technical terms, tool names, and jargon stay in the form practitioners of the \
             target language actually use - which is very often the English term (deploy, merge \
             conflict, pull request, API, backlog). Do not invent native translations for terms \
             the field says in English.\n\
             - Code identifiers, file names, branch names, version numbers, error messages, and \
             commands are verbatim strings: reproduce them character-for-character, never \
             translated.\n\
             - Numbers with units (latency, memory, cost, percentages) exactly as spoken.\n\
             - Keep the distinction between what is broken, what is suspected, and what is fixed; \
             \"it might be the cache\" must not become \"it is the cache\".\n\
             - Acronyms stay acronyms unless the speaker expanded them.",
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
