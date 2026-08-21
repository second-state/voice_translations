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
        guidance: include_str!("../prompts/specialties/primary_care.txt"),
    },
    Specialty {
        id: "emergency",
        label: "Emergency / urgent care",
        icon: "🚑",
        blurb: "Triage, acute injury and illness, time-critical decisions",
        guidance: include_str!("../prompts/specialties/emergency.txt"),
    },
    Specialty {
        id: "pediatrics",
        label: "Pediatrics",
        icon: "🧸",
        blurb: "Well-child visits, immunizations, childhood illness",
        guidance: include_str!("../prompts/specialties/pediatrics.txt"),
    },
    Specialty {
        id: "cardiology",
        label: "Cardiology",
        icon: "❤️",
        blurb: "Heart disease, rhythm problems, procedures and anticoagulation",
        guidance: include_str!("../prompts/specialties/cardiology.txt"),
    },
    Specialty {
        id: "oncology",
        label: "Oncology",
        icon: "🎗️",
        blurb: "Cancer diagnosis, staging, treatment planning, goals of care",
        guidance: include_str!("../prompts/specialties/oncology.txt"),
    },
    Specialty {
        id: "orthopedics",
        label: "Orthopedics & sports medicine",
        icon: "🦴",
        blurb: "Fractures, joints, spine, surgery and rehabilitation",
        guidance: include_str!("../prompts/specialties/orthopedics.txt"),
    },
    Specialty {
        id: "dentistry",
        label: "Dentistry & oral surgery",
        icon: "🦷",
        blurb: "Exams, restorations, extractions, periodontics, orthodontics",
        guidance: include_str!("../prompts/specialties/dentistry.txt"),
    },
    Specialty {
        id: "obgyn",
        label: "Obstetrics & gynecology",
        icon: "🤰",
        blurb: "Prenatal care, labor and delivery, gynecologic and reproductive health",
        guidance: include_str!("../prompts/specialties/obgyn.txt"),
    },
    Specialty {
        id: "psychiatry",
        label: "Psychiatry & mental health",
        icon: "🧠",
        blurb: "Mood, anxiety, psychosis, substance use, medication and therapy",
        guidance: include_str!("../prompts/specialties/psychiatry.txt"),
    },
    Specialty {
        id: "dermatology",
        label: "Dermatology",
        icon: "🧴",
        blurb: "Skin, hair and nail conditions, lesions, topical treatment",
        guidance: include_str!("../prompts/specialties/dermatology.txt"),
    },
    Specialty {
        id: "gastroenterology",
        label: "Gastroenterology",
        icon: "🩻",
        blurb: "Digestive symptoms, endoscopy, liver and bowel disease",
        guidance: include_str!("../prompts/specialties/gastroenterology.txt"),
    },
    Specialty {
        id: "neurology",
        label: "Neurology",
        icon: "⚡",
        blurb: "Stroke, seizures, headache, memory and nerve disorders",
        guidance: include_str!("../prompts/specialties/neurology.txt"),
    },
    Specialty {
        id: "endocrinology",
        label: "Endocrinology & diabetes",
        icon: "💉",
        blurb: "Diabetes management, thyroid, hormones, bone health",
        guidance: include_str!("../prompts/specialties/endocrinology.txt"),
    },
    Specialty {
        id: "pulmonology",
        label: "Pulmonology & respiratory",
        icon: "🫁",
        blurb: "Asthma, COPD, breathing tests, inhalers, sleep apnea",
        guidance: include_str!("../prompts/specialties/pulmonology.txt"),
    },
    Specialty {
        id: "ophthalmology",
        label: "Ophthalmology & optometry",
        icon: "👁️",
        blurb: "Vision changes, glaucoma, cataracts, retinal disease, eye drops",
        guidance: include_str!("../prompts/specialties/ophthalmology.txt"),
    },
    Specialty {
        id: "urology_nephrology",
        label: "Urology & nephrology",
        icon: "🚿",
        blurb: "Urinary symptoms, kidney disease, dialysis, prostate health",
        guidance: include_str!("../prompts/specialties/urology_nephrology.txt"),
    },
    Specialty {
        id: "pharmacy",
        label: "Pharmacy & medication counseling",
        icon: "💊",
        blurb: "Prescriptions, dosing, interactions, adherence, refills",
        guidance: include_str!("../prompts/specialties/pharmacy.txt"),
    },
    Specialty {
        id: "anesthesia",
        label: "Anesthesia & pre-op",
        icon: "😴",
        blurb: "Pre-operative assessment, anesthesia consent, recovery",
        guidance: include_str!("../prompts/specialties/anesthesia.txt"),
    },
    Specialty {
        id: "physical_therapy",
        label: "Physical therapy & rehab",
        icon: "🤸",
        blurb: "Movement assessment, exercise prescription, recovery plans",
        guidance: include_str!("../prompts/specialties/physical_therapy.txt"),
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
