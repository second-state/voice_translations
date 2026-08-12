//! The medical specialties the app can be tuned to.
//!
//! Each entry carries one piece of domain knowledge:
//! [`Specialty::guidance`] — the terminology and accuracy notes appended to
//! the translation system prompt, on top of the general interpreting rules
//! in [`crate::prompt`]. The translator uses it both to interpret faithfully
//! and to repair phonetic mishearings the recognizer makes on specialty terms
//! ("Lasix" as "lay six", "hyponatremia" as "hypo notremia").

use serde::Serialize;

/// One medical specialty, with the prompt material that specializes the
/// translator to it.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Specialty {
    /// Stable identifier used on the wire and in `config.toml`.
    pub id: &'static str,
    /// Human-readable name shown in the picker.
    pub label: &'static str,
    /// Emoji shown next to the label.
    pub icon: &'static str,
    /// One-line description of the kinds of visit this covers.
    pub blurb: &'static str,
    /// Terminology and accuracy notes for the translator.
    #[serde(skip)]
    pub guidance: &'static str,
}

/// The specialty used when a request names none or names an unknown one.
pub const DEFAULT_SPECIALTY: &str = "primary_care";

/// Look a specialty up by [`Specialty::id`].
pub fn find(id: &str) -> Option<&'static Specialty> {
    let id = id.trim();
    SPECIALTIES.iter().find(|s| s.id.eq_ignore_ascii_case(id))
}

/// Look a specialty up, falling back to [`DEFAULT_SPECIALTY`].
pub fn find_or_default(id: Option<&str>) -> &'static Specialty {
    id.and_then(find)
        .or_else(|| find(DEFAULT_SPECIALTY))
        .expect("the default specialty is always present")
}

/// Every specialty, in the order the picker shows them.
pub static SPECIALTIES: &[Specialty] = &[
    Specialty {
        id: "primary_care",
        label: "Primary care / family medicine",
        icon: "🩺",
        blurb: "Routine visits, chronic disease follow-up, screening, referrals",
        guidance: "PRIMARY CARE NOTES:\n\
             - Screening and follow-up intervals are instructions, not small talk: \"come back \
             in three months\", \"repeat the labs in two weeks\", \"you are due for a \
             colonoscopy\" must keep their exact interval and test name.\n\
             - Keep lab names and their values together and unconverted (A1c 7.2, LDL 130, blood \
             pressure 130 over 80). Do not restate a value in a different unit or scale.\n\
             - Medication changes are the highest-risk content in these visits: preserve start, \
             stop, hold, increase, decrease, and the dose that goes with each.\n\
             - Patients often describe chronic conditions with the name of the pill rather than \
             the diagnosis (\"my blood pressure medicine\"). Translate what they said; do not \
             substitute the drug name they did not use.",
    },
    Specialty {
        id: "emergency",
        label: "Emergency / urgent care",
        icon: "🚑",
        blurb: "Triage, acute injury and illness, time-critical decisions",
        guidance: "EMERGENCY NOTES:\n\
             - Timing is diagnostic. \"When did it start?\", \"how long has it been going on?\", \
             \"when did you last eat?\", \"when did you last take it?\" and every answer to them \
             must keep the exact time, duration, and clock reference (\"since 8 this morning\", \
             \"about two hours ago\", \"since Tuesday\").\n\
             - Pain descriptions carry diagnostic weight: crushing, stabbing, burning, dull, \
             pressure, tearing, radiating. Use the closest everyday equivalent, never a generic \
             \"pain\".\n\
             - Preserve pain-scale numbers exactly (\"seven out of ten\").\n\
             - Allergy, anticoagulant, and last-dose answers are safety-critical. A \"no\" here \
             must stay a clear \"no\", and an uncertain \"I think so\" must stay uncertain.\n\
             - Urgency in the clinician's voice is information: keep imperative instructions \
             imperative (\"don't eat or drink anything\", \"stay on the stretcher\") rather than \
             softening them into suggestions.",
    },
    Specialty {
        id: "pediatrics",
        label: "Pediatrics",
        icon: "🧸",
        blurb: "Well-child visits, immunizations, childhood illness",
        guidance: "PEDIATRIC NOTES:\n\
             - The caregiver usually speaks for the child. Keep their framing exactly as spoken \
             (\"she has had a fever since Friday\"); do not convert it to first person, and do \
             not convert the clinician's questions about the child into questions about the \
             caregiver.\n\
             - Pediatric doses are weight-based and are given in millilitres of a specific \
             concentration. Never round, never convert millilitres to teaspoons or teaspoons to \
             millilitres, and never drop the concentration (\"160 milligrams per 5 millilitres\").\n\
             - Ages and weights must survive exactly, including the unit (\"18 months\", not \
             \"a year and a half\"; \"12 kilos\", not \"about 26 pounds\").\n\
             - Vaccine names and schedules stay in their standard form; do not expand or \
             abbreviate an acronym the speaker did not use.\n\
             - Keep the caregiver's everyday words for a child's body and functions rather than \
             clinical terms, in whatever register the target language uses with parents.",
    },
    Specialty {
        id: "cardiology",
        label: "Cardiology",
        icon: "❤️",
        blurb: "Heart disease, rhythm problems, procedures and anticoagulation",
        guidance: "CARDIOLOGY NOTES:\n\
             - Anticoagulation is the most dangerous content in this specialty. \"Blood \
             thinner\", the drug name, the dose, the INR value, and any instruction to hold, \
             stop, restart, or bridge must all survive exactly and unhedged.\n\
             - Keep cardiac numbers with their units: ejection fraction 35 percent, blood \
             pressure 140 over 90, heart rate 110 beats per minute. Never convert or round.\n\
             - Distinguish the symptoms patients blur together: chest pain versus pressure \
             versus tightness, shortness of breath at rest versus on exertion, palpitations \
             versus a racing heart, swelling versus weight gain. Carry the speaker's own \
             distinction across.\n\
             - Exertion thresholds are clinical data (\"one flight of stairs\", \"two blocks\"); \
             keep the exact measure.\n\
             - \"Heart attack\", \"heart failure\", and \"cardiac arrest\" are different events \
             and are widely confused by patients and by dictionaries. Translate the one that was \
             said, using the target language's standard clinical term for it.",
    },
    Specialty {
        id: "oncology",
        label: "Oncology",
        icon: "🎗️",
        blurb: "Cancer diagnosis, staging, treatment planning, goals of care",
        guidance: "ONCOLOGY NOTES:\n\
             - Prognosis and probability wording is the content most often distorted by \
             interpreters trying to be kind. Percentages, survival figures, \"we cannot cure \
             this\", \"this is treatable but not curable\", \"we hope\", \"we expect\" must \
             cross over with exactly the certainty the speaker used - neither softened nor \
             hardened.\n\
             - Stage, grade, and tumor size are numbers with clinical meaning: stage III, grade \
             2, 2.4 centimeters, three of twelve lymph nodes. Reproduce them exactly.\n\
             - Treatment intent words (curative, palliative, adjuvant, neoadjuvant, \
             maintenance) change what the patient is consenting to. Do not blur them into \
             \"treatment\".\n\
             - Keep regimen names, cycle counts, and schedules intact (\"four cycles, every \
             three weeks\").\n\
             - Some languages and families avoid naming cancer directly. Render what the \
             speaker actually said - if the clinician says \"cancer\", say it; if the patient \
             uses a euphemism, keep the euphemism. Do not introduce or remove the word on your \
             own initiative.\n\
             - Never add reassurance, hope, or consolation that was not spoken.",
    },
    Specialty {
        id: "orthopedics",
        label: "Orthopedics & sports medicine",
        icon: "🦴",
        blurb: "Fractures, joints, spine, surgery and rehabilitation",
        guidance: "ORTHOPEDIC NOTES:\n\
             - Side is the single most dangerous word in this specialty. Left, right, both, and \
             bilateral must be reproduced exactly, and must never be dropped because the target \
             language would sound more natural without them. The same applies to upper/lower, \
             inner/outer, front/back, and the specific joint named.\n\
             - Weight-bearing status is a safety instruction with distinct levels: no weight, \
             touch-down, partial, weight-bearing as tolerated, full. Keep the exact level and \
             the exact duration (\"six weeks\").\n\
             - Keep the mechanism of injury as described (\"twisted it going down stairs\", \
             \"fell on an outstretched hand\") - it is diagnostic, not narrative colour.\n\
             - Distinguish sprain (ligament), strain (muscle), and fracture (bone); many \
             languages have one colloquial word that covers all three. Use the precise term \
             when the clinician does, and the patient's loose term when the patient does.\n\
             - Rehabilitation instructions carry counts and frequencies (\"three sets of ten, \
             twice a day\"); reproduce them exactly.",
    },
    Specialty {
        id: "dentistry",
        label: "Dentistry & oral surgery",
        icon: "🦷",
        blurb: "Exams, restorations, extractions, periodontics, orthodontics",
        guidance: "DENTAL NOTES:\n\
             - Tooth identification must be exact: the tooth number, the name (upper left first \
             molar), and the quadrant. Never approximate a tooth's position or let the side drop.\n\
             - Distinguish the procedures patients confuse: a filling, a crown, a root canal, \
             and an extraction are different treatments with different costs and consequences. \
             Use the target language's standard patient-facing term for the exact one named.\n\
             - \"Cleaning\" and \"deep cleaning\" (scaling and root planing) are not the same \
             procedure; keep the distinction.\n\
             - Anesthetic instructions and their timing matter (\"numb for two to three hours\", \
             \"don't chew until the numbness wears off\", \"bite on the gauze for 30 minutes\").\n\
             - Post-extraction instructions are safety content: no rinsing, no smoking, no \
             straws, and the exact time window each applies for.\n\
             - Cost, insurance coverage, and treatment-plan wording come up constantly here; \
             reproduce figures and coverage conditions exactly and never estimate.",
    },
    Specialty {
        id: "obgyn",
        label: "Obstetrics & gynecology",
        icon: "🤰",
        blurb: "Prenatal care, labor and delivery, gynecologic and reproductive health",
        guidance: "OBSTETRIC AND GYNECOLOGIC NOTES:\n\
             - Gestational age, dates, and counts are the backbone of this specialty: \"32 weeks \
             and 4 days\", \"due on the 14th\", \"gravida 2 para 1\", \"contractions every five \
             minutes for the last hour\". Reproduce every number and interval exactly.\n\
             - Distinguish the words that sound alike but are different events: miscarriage, \
             stillbirth, abortion, termination, ectopic pregnancy. Translate precisely the one \
             that was said, with the target language's clinical term, and add no judgement.\n\
             - Consent, choice, and option wording must stay neutral. If the clinician presents \
             alternatives, present all of them; never let one option sound recommended when it \
             was not.\n\
             - This conversation is intimate and often overheard by family. Keep the speaker's \
             own level of directness about anatomy, sexual history, and contraception - neither \
             euphemize what was said plainly, nor make explicit what was said delicately.\n\
             - Preserve everything about who is present, who may be told, and what the patient \
             asks to keep private.",
    },
    Specialty {
        id: "psychiatry",
        label: "Psychiatry & mental health",
        icon: "🧠",
        blurb: "Mood, anxiety, psychosis, substance use, medication and therapy",
        guidance: "MENTAL HEALTH NOTES:\n\
             - Anything about suicide, self-harm, harming others, or a plan or means for them \
             must be carried across completely and literally, with the speaker's exact degree of \
             intent and timeframe. Never soften, generalize, euphemize, or omit it, however \
             uncomfortable the wording, and never upgrade a passive thought into a plan.\n\
             - Screening questions are worded precisely for a reason (frequency, duration, \
             \"nearly every day\", \"more than half the days\", \"in the last two weeks\"). \
             Translate the question as constructed rather than paraphrasing its gist.\n\
             - Preserve the patient's own descriptions of internal experience, including \
             metaphors and culturally specific idioms of distress. Do not map them onto a \
             diagnosis or clinical term.\n\
             - Substance use amounts, frequencies, and last-use times must survive exactly, \
             without moralizing and without rounding.\n\
             - Keep the clinician's exact framing about confidentiality, voluntary versus \
             involuntary care, and who will be informed.\n\
             - Mental illness is stigmatized differently across languages; use the standard \
             clinical term of the target language rather than a colloquialism that carries an \
             insult.",
    },
    Specialty {
        id: "dermatology",
        label: "Dermatology",
        icon: "🧴",
        blurb: "Skin, hair and nail conditions, lesions, topical treatment",
        guidance: "DERMATOLOGY NOTES:\n\
             - How a lesion looks and changes is the diagnosis: colour, border, size in \
             millimetres, raised or flat, itchy or painful, spreading or shrinking, how long it \
             has been there. Keep every descriptor and every number.\n\
             - Body location must be exact and side-specific (\"the outer side of the left \
             forearm\"), never reduced to \"the arm\".\n\
             - Topical application instructions are dosing: how much (a thin layer, a \
             fingertip unit), where, how often, for how many days, and whether to stop. \
             Reproduce all of it, and keep any warning about not using a steroid on the face or \
             under a dressing.\n\
             - Distinguish an infection from an inflammation from a growth; patients call all \
             three \"a rash\", but the clinician's word choice is the diagnosis.\n\
             - Colour terms for lesions differ on different skin tones and across languages \
             (red, purple, brown, darker than the surrounding skin). Translate the description \
             given rather than the colour you would expect.",
    },
    Specialty {
        id: "gastroenterology",
        label: "Gastroenterology",
        icon: "🩻",
        blurb: "Digestive symptoms, endoscopy, liver and bowel disease",
        guidance: "GASTROENTEROLOGY NOTES:\n\
             - Bowel and stool descriptions are clinical data, not embarrassment to be tidied \
             up: frequency per day, consistency, colour, blood, black or tarry, mucus, urgency, \
             and how long it has been going on. Translate them plainly and completely in the \
             everyday register the speaker used.\n\
             - Pain location and its relationship to eating are diagnostic: upper versus lower, \
             left versus right, before or after meals, at night, radiating to the back or \
             shoulder. Keep all of it.\n\
             - Bowel-preparation instructions are the most consequential text in this \
             specialty. Every volume, time, and prohibition must be exact (\"drink half the \
             solution at 6 pm and the rest at 4 am\", \"clear liquids only, nothing red or \
             purple\", \"nothing by mouth after midnight\"). Never round a time or a volume.\n\
             - \"Blood in the stool\", \"black stools\", and \"vomiting blood\" are emergency \
             findings; never soften them into \"stomach trouble\".\n\
             - Foods, drinks, and traditional remedies named by the patient stay as named; do \
             not substitute a local equivalent.",
    },
    Specialty {
        id: "neurology",
        label: "Neurology",
        icon: "⚡",
        blurb: "Stroke, seizures, headache, memory and nerve disorders",
        guidance: "NEUROLOGY NOTES:\n\
             - For any sudden deficit, the time of onset decides the treatment. \"When were you \
             last completely normal?\", \"what time did it start?\", \"did you wake up with \
             it?\" and their answers must keep the exact clock time. Never let a time become \
             \"a while ago\".\n\
             - Numbness, tingling, weakness, heaviness, and clumsiness are different findings \
             that most languages blur colloquially. Carry across the exact sensation described, \
             and keep which limb and which side.\n\
             - Seizure descriptions must keep the sequence and duration exactly: what happened \
             first, whether there was loss of consciousness, how long it lasted, what the person \
             was like afterwards.\n\
             - Headache descriptions carry their diagnosis in the details: sudden or gradual, \
             one side or both, worst ever, with light sensitivity, nausea, or visual changes.\n\
             - Memory-related questions are often addressed to a family member as well as the \
             patient. Keep clear who is being asked and who answered, without adding framing.",
    },
    Specialty {
        id: "endocrinology",
        label: "Endocrinology & diabetes",
        icon: "💉",
        blurb: "Diabetes management, thyroid, hormones, bone health",
        guidance: "ENDOCRINOLOGY NOTES:\n\
             - Insulin is dosed in UNITS. Never render units as millilitres, never as \
             milligrams, and never drop the word. A confusion between units and millilitres is a \
             tenfold or hundredfold overdose. Reproduce the number, the word \"units\", the \
             insulin name, and the timing exactly as spoken.\n\
             - Keep basal and bolus insulin distinct, keep long-acting and rapid-acting \
             distinct, and keep sliding-scale rules intact with every threshold and number.\n\
             - Blood sugar values and A1c percentages must survive unchanged and unconverted. \
             Do not translate mg/dL into mmol/L or the reverse, even if the target country \
             normally uses the other unit - say the number and unit that was spoken.\n\
             - Hypoglycemia instructions are emergency content: the symptoms, the rule of \
             fifteen, what to eat, when to recheck, and when to use glucagon must all be \
             complete.\n\
             - Meal timing relative to medication (\"30 minutes before breakfast\", \"with the \
             first bite\") is dosing information, not a suggestion.",
    },
    Specialty {
        id: "pulmonology",
        label: "Pulmonology & respiratory",
        icon: "🫁",
        blurb: "Asthma, COPD, breathing tests, inhalers, sleep apnea",
        guidance: "PULMONOLOGY NOTES:\n\
             - Rescue and controller inhalers are used differently and confusing them is \
             dangerous. Keep the device name, whether it is the daily one or the as-needed one, \
             the number of puffs, how many times a day, and any instruction to rinse the mouth \
             afterwards.\n\
             - Steroid tapers must keep every step and day (\"40 milligrams for five days, then \
             20 for five days\").\n\
             - Breathlessness is measured by what it stops the patient doing: keep the exact \
             threshold (\"one flight of stairs\", \"can't finish a sentence\", \"only at \
             night\").\n\
             - Distinguish a dry cough from a productive one, and keep sputum colour and blood \
             exactly as described.\n\
             - Oxygen settings are prescriptions: litres per minute, continuous or only at \
             night, and with exertion. Reproduce the numbers exactly.\n\
             - Smoking history in pack-years and quit dates must keep its numbers.",
    },
    Specialty {
        id: "ophthalmology",
        label: "Ophthalmology & optometry",
        icon: "👁️",
        blurb: "Vision changes, glaucoma, cataracts, retinal disease, eye drops",
        guidance: "OPHTHALMOLOGY NOTES:\n\
             - Which eye is the critical fact in every sentence here: right, left, or both. It \
             must never be dropped, guessed, or swapped, including in drop instructions and \
             surgical plans.\n\
             - Eye-drop regimens are exact: how many drops, in which eye, how many times a day, \
             for how many days, in what order, and how long to wait between different drops. \
             Reproduce all of it.\n\
             - Sudden symptoms are emergencies and must not be flattened: a curtain or shadow \
             across the vision, a shower of new floaters, flashes of light, sudden loss of \
             vision, or eye pain with nausea.\n\
             - Keep visual-acuity notation and prescription numbers as spoken (20/40, minus \
             2.75, plus 1.50).\n\
             - Distinguish blurred vision, double vision, loss of part of the field, and \
             glare - patients often say \"I can't see well\" for all of them, so keep whichever \
             the speaker specified.",
    },
    Specialty {
        id: "urology_nephrology",
        label: "Urology & nephrology",
        icon: "🚿",
        blurb: "Urinary symptoms, kidney disease, dialysis, prostate health",
        guidance: "UROLOGY AND NEPHROLOGY NOTES:\n\
             - Urinary symptoms need their precise distinctions preserved: burning, urgency, \
             frequency, hesitancy, a weak stream, incomplete emptying, getting up at night, and \
             how many times. Keep the counts.\n\
             - Blood in the urine, inability to pass urine, and fever with flank pain are \
             urgent findings; never soften them.\n\
             - Kidney function numbers and stages must survive exactly (creatinine 2.1, GFR 38, \
             stage 3b).\n\
             - Fluid and diet restrictions are prescriptions with numbers: litres per day, \
             potassium, phosphorus, salt. Reproduce every limit and every named food.\n\
             - Dialysis logistics are clinical (which days, how many hours, missed sessions, \
             weight gain between sessions); keep the schedule exactly.\n\
             - Sexual and continence topics are embarrassing in many cultures. Keep the \
             speaker's own directness; do not euphemize a plain question, and do not make a \
             delicate one blunt.",
    },
    Specialty {
        id: "pharmacy",
        label: "Pharmacy & medication counseling",
        icon: "💊",
        blurb: "Prescriptions, dosing, interactions, adherence, refills",
        guidance: "MEDICATION COUNSELING NOTES:\n\
             - Dose, unit, route, frequency, and duration form one indivisible instruction. \
             Every part must appear in the translation exactly as spoken: \"500 milligrams, by \
             mouth, three times a day, for seven days\".\n\
             - Never convert between units or measures. Millilitres do not become teaspoons, \
             milligrams do not become tablets, and a number is never rounded. If the speaker \
             said \"5 millilitres\", the translation says 5 millilitres.\n\
             - Keep the drug name in the form used, generic or brand, without substituting one \
             for the other and without translating it into a local product name.\n\
             - Conditional and negative instructions carry the risk: \"only if the fever is \
             above 38\", \"not with grapefruit\", \"stop if you get a rash\", \"do not take it \
             with your blood thinner\", \"finish the whole course even if you feel better\". \
             Reproduce the condition and the negation exactly.\n\
             - As-needed dosing has a ceiling; always carry the maximum (\"up to four times a \
             day, no more than 3 grams in 24 hours\").\n\
             - Keep side effects that require stopping the drug distinct from ones that are \
             merely expected.",
    },
    Specialty {
        id: "anesthesia",
        label: "Anesthesia & pre-op",
        icon: "😴",
        blurb: "Pre-operative assessment, anesthesia consent, recovery",
        guidance: "ANESTHESIA AND PRE-OPERATIVE NOTES:\n\
             - Fasting instructions are the most safety-critical text in a pre-op conversation. \
             Keep the exact cut-off time, what is still allowed until when, and what is \
             forbidden - and keep it as an absolute instruction, never a suggestion.\n\
             - Instructions to hold, stop, or continue a medication before surgery must keep \
             the drug, the action, and the number of days. Confusing \"stop\" with \"continue\" \
             here causes bleeding or clotting.\n\
             - Personal and family history of anesthetic problems must be carried completely, \
             including vague answers - preserve the uncertainty rather than resolving it.\n\
             - Consent discussion of risks must include every risk named, with the frequency or \
             severity words attached. Do not shorten a list of risks and do not downgrade \
             \"rare but serious\" into \"unlikely\".\n\
             - Keep timing and logistics exact: arrival time, who drives the patient home, how \
             long in recovery.",
    },
    Specialty {
        id: "physical_therapy",
        label: "Physical therapy & rehab",
        icon: "🤸",
        blurb: "Movement assessment, exercise prescription, recovery plans",
        guidance: "PHYSICAL THERAPY NOTES:\n\
             - An exercise prescription is a set of numbers: how many repetitions, how many \
             sets, how many times a day, how many days a week, how long to hold, how much \
             resistance. Every one of them must survive.\n\
             - Movement directions and body parts must be exact and side-specific. Bending, \
             straightening, lifting to the side, rotating inward, and the specific joint are not \
             interchangeable.\n\
             - Keep pain rules exactly as stated: what level of discomfort is acceptable, what \
             means stop, and what means call the clinic. \"Some soreness is fine, sharp pain \
             means stop\" must not collapse into \"stop if it hurts\".\n\
             - Preserve ice-versus-heat instructions with their durations.\n\
             - Restrictions carry timeframes (\"no lifting over 10 pounds for four weeks\"); \
             keep the limit, the unit, and the duration.",
    },
];

#[cfg(test)]
mod tests {
    use super::{find, find_or_default, DEFAULT_SPECIALTY, SPECIALTIES};
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_url_safe() {
        let mut seen = HashSet::new();
        for s in SPECIALTIES {
            assert!(seen.insert(s.id), "duplicate specialty id {}", s.id);
            assert!(
                s.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{} is not a safe id",
                s.id
            );
        }
    }

    #[test]
    fn every_specialty_carries_its_prompt_material() {
        for s in SPECIALTIES {
            assert!(!s.label.is_empty(), "{} has no label", s.id);
            assert!(!s.blurb.is_empty(), "{} has no blurb", s.id);
            assert!(
                s.guidance.len() > 200,
                "{} has a suspiciously short guidance block",
                s.id
            );
        }
    }

    #[test]
    fn unknown_ids_fall_back_to_the_default() {
        assert!(find(DEFAULT_SPECIALTY).is_some());
        assert_eq!(find_or_default(None).id, DEFAULT_SPECIALTY);
        assert_eq!(
            find_or_default(Some("not_a_specialty")).id,
            DEFAULT_SPECIALTY
        );
        assert_eq!(find_or_default(Some("cardiology")).id, "cardiology");
        assert_eq!(find_or_default(Some(" Cardiology ")).id, "cardiology");
    }
}
