//! Composition of the domain prompts handed to the two upstream services.
//!
//! Two prompts are built here, from the same specialty entry:
//!
//! * [`asr_primer`] — a vocabulary sample for the speech recognizer.
//! * [`translation_prompt`] — the medical interpreting rules plus the
//!   specialty's terminology notes, spliced into the base system prompt by
//!   [`voice_translations::translate::build_system_prompt`].
//!
//! The rules below are the app's whole reason to exist. A general-purpose
//! translator optimizes for fluency; a medical interpreter optimizes for
//! nothing being added, dropped, or shaded — which is a different and
//! occasionally less natural-sounding target.

use serde::{Deserialize, Serialize};

use crate::specialty::Specialty;

/// Who is speaking this turn. Knowing the role lets the prompt tell the model
/// which direction the register runs — clinician-to-patient explanation, or
/// patient-to-clinician symptom description.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    /// The doctor, nurse, dentist, therapist, or other member of the care team.
    Clinician,
    /// The patient, or a family member speaking on their behalf.
    Patient,
    /// Not established for this turn; the prompt then says nothing about role.
    #[default]
    #[serde(other)]
    Unknown,
}

impl Speaker {
    /// Label shown in the transcript and used in exports.
    pub fn label(self) -> &'static str {
        match self {
            Speaker::Clinician => "Clinician",
            Speaker::Patient => "Patient",
            Speaker::Unknown => "Speaker",
        }
    }
}

/// The rules that make this a medical interpreter rather than a translator.
///
/// Every line here exists because getting it wrong has hurt someone: dropped
/// negations, converted units, guessed laterality, softened prognoses, and
/// helpfully answered questions are the classic failure modes of both human
/// and machine medical interpreting.
pub const INTERPRETING_RULES: &str = "\
MEDICAL INTERPRETING RULES - these outrank every general style preference \
stated above:\n\
- Accuracy outranks fluency. A smooth paraphrase that loses one clinical \
detail is a worse output than an awkward sentence that keeps everything.\n\
- Transfer the message completely and add nothing. Never answer a question, \
never give medical advice, never explain a term, never reassure, and never \
supply a fact the speaker did not say - not even if you know it is medically \
correct and would help.\n\
- Numbers, units, doses, routes, frequencies, and durations must appear in \
your output exactly as spoken: 5 milligrams, 2.5 millilitres, 12 units, twice \
a day, every 8 hours, for 10 days, 120 over 80. Never convert between unit \
systems, never round, never turn a figure into a word like \"a few\", and \
never drop the unit.\n\
- Negation is safety-critical. \"No fever\", \"not allergic\", \"never \
smoked\", \"don't take it with food\" must stay negative, and a positive \
statement must never acquire a negative.\n\
- Laterality and anatomical location are safety-critical. Left, right, both, \
upper, lower, inner, outer, and the specific body part must be reproduced \
exactly, and must never be dropped for the sake of a natural-sounding \
sentence.\n\
- Preserve certainty exactly as expressed. \"Might be\", \"we think\", \"it's \
possible\", \"we need to rule out\", \"probably\" must not become definite; \
definite statements must not become hedged. This is what the patient's consent \
rests on.\n\
- Preserve time references exactly: when a symptom started, how long it \
lasted, when a dose was last taken, what time to arrive, when to stop eating.\n\
- Keep medication names in the form the speaker used, generic or brand. Do not \
translate a drug name, do not localize it to a national product, and do not \
substitute a generic for a brand or the reverse.\n\
- Match the register of the speaker. When a patient uses everyday words for a \
symptom or body part, use everyday words in the target language; when a \
clinician uses a technical term, keep it technical. Never promote lay speech \
into jargon, and never simplify clinical speech into something vaguer than \
what was said.\n\
- Preserve ambiguity rather than resolving it. If the source is vague, \
incomplete, or self-contradictory, produce an equally vague output. Never \
guess a dose, a body part, a date, or a diagnosis that was not spoken.\n\
- Preserve emotional content and its intensity - fear, pain, anger, \
reluctance, refusal - without amplifying or muting it. A refusal must read as \
a refusal.\n\
- Use the forms of address and politeness level a clinical setting expects in \
the target language, including honorifics where that language requires them.\n\
- When the speaker uses a culture-bound illness term, a traditional remedy, or \
a folk diagnosis with no clinical equivalent, carry the term over as spoken \
rather than mapping it onto the nearest Western diagnosis.";

/// The interpreting rules, framed for a first-person spoken translation.
fn translation_framing(specialty: &Specialty, speaker: Speaker) -> String {
    let mut framing = format!(
        "CLINICAL SETTING\n\
         This is a live, spoken medical encounter in {} between a patient and their care \
         team, and you are the interpreter. ",
        specialty.label.to_lowercase()
    );
    framing.push_str(match speaker {
        Speaker::Clinician => {
            "This turn is the clinician speaking to the patient: explanations, questions, \
             findings, and instructions. Render it so a patient with no medical training hears \
             exactly what the clinician said, at the same level of detail - do not simplify away \
             a term the clinician chose to use."
        }
        Speaker::Patient => {
            "This turn is the patient (or a family member speaking for them) talking to the \
             care team: symptoms, history, worries, and questions. Render it so the clinician \
             hears exactly what was described, including hesitation, uncertainty, and everyday \
             or folk wording - do not tidy a symptom description into a diagnosis."
        }
        Speaker::Unknown => {
            "The speaker may be either the patient or a member of the care team; render the \
             turn faithfully either way."
        }
    });
    framing.push_str(
        "\n\nRender the speech in the FIRST person, exactly as the speaker said it (\"I have \
         had this pain for three days\"). Never add reporting frames such as \"the patient \
         says\" or \"he is asking whether\".",
    );
    framing
}

/// The domain prompt for a translation turn: setting, interpreting rules, and
/// the specialty's own terminology notes.
///
/// `editing` marks the same-language cleanup pass that polishes the source
/// transcript, where the same accuracy rules apply but there is no target
/// language to render into.
pub fn translation_prompt(specialty: &Specialty, speaker: Speaker, editing: bool) -> String {
    let framing = if editing {
        format!(
            "CLINICAL SETTING\n\
             This is the raw transcript of one turn in a live medical encounter in {}, spoken by \
             the {}. You are cleaning it up for the medical record, not translating it.\n\n\
             Remove only disfluency: filler sounds, stutters, repeated words, and abandoned \
             false starts. Everything with clinical meaning stays, in the speaker's own words \
             and first person. In particular, never drop or alter a number, unit, dose, \
             frequency, duration, negation, side of the body, drug name, or anatomical term \
             while tidying the sentence, and never complete a sentence the speaker left \
             unfinished by guessing what they meant.",
            specialty.label.to_lowercase(),
            speaker.label().to_lowercase()
        )
    } else {
        translation_framing(specialty, speaker)
    };

    format!(
        "{framing}\n\n{INTERPRETING_RULES}\n\n{}",
        specialty.guidance
    )
}

/// The vocabulary primer for the speech recognizer.
///
/// Returned as the specialty's term list preceded by a short framing clause,
/// which is how recognizers that accept a `prompt` expect preceding context.
pub fn asr_primer(specialty: &Specialty) -> String {
    format!(
        "Transcript of a {} visit. Expected terminology: {}.",
        specialty.label.to_lowercase(),
        specialty.asr_primer.trim_end_matches('.')
    )
}

#[cfg(test)]
mod tests {
    use super::{asr_primer, translation_prompt, Speaker, INTERPRETING_RULES};
    use crate::specialty::{find, SPECIALTIES};

    #[test]
    fn speaker_parses_leniently() {
        let parse = |s: &str| serde_json::from_str::<Speaker>(s).unwrap();
        assert_eq!(parse("\"clinician\""), Speaker::Clinician);
        assert_eq!(parse("\"patient\""), Speaker::Patient);
        // Anything unrecognized (including the UI's "auto") is Unknown rather
        // than a request error.
        assert_eq!(parse("\"auto\""), Speaker::Unknown);
        assert_eq!(parse("\"\""), Speaker::Unknown);
    }

    #[test]
    fn translation_prompt_carries_setting_rules_and_specialty() {
        let cardiology = find("cardiology").unwrap();
        let prompt = translation_prompt(cardiology, Speaker::Patient, false);
        assert!(prompt.contains("CLINICAL SETTING"));
        assert!(prompt.contains(INTERPRETING_RULES));
        assert!(prompt.contains("CARDIOLOGY NOTES"));
        assert!(prompt.contains("Anticoagulation"));
        assert!(prompt.contains("FIRST person"));
        assert!(prompt.contains("patient (or a family member"));
    }

    #[test]
    fn clinician_and_patient_turns_get_different_framings() {
        let s = find("oncology").unwrap();
        let clinician = translation_prompt(s, Speaker::Clinician, false);
        let patient = translation_prompt(s, Speaker::Patient, false);
        assert_ne!(clinician, patient);
        assert!(clinician.contains("clinician speaking to the patient"));
        assert!(patient.contains("talking to the care team"));
    }

    #[test]
    fn editing_prompt_forbids_dropping_clinical_content() {
        let s = find("pharmacy").unwrap();
        let prompt = translation_prompt(s, Speaker::Clinician, true);
        assert!(prompt.contains("cleaning it up for the medical record"));
        assert!(prompt.contains("never drop or alter a number"));
        // The specialty notes still apply while polishing.
        assert!(prompt.contains("MEDICATION COUNSELING NOTES"));
    }

    #[test]
    fn every_specialty_produces_a_usable_primer() {
        for s in SPECIALTIES {
            let primer = asr_primer(s);
            assert!(primer.starts_with("Transcript of a "));
            assert!(primer.ends_with('.'));
            assert!(!primer.contains(".."));
        }
    }
}
