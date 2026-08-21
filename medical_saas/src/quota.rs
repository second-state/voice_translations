//! The free plan's word allowance.
//!
//! Free accounts may translate a fixed number of spoken words in any rolling
//! seven-day window; paid accounts are unlimited. "Rolling" is literal: the
//! ledger is summed from this instant back over the window, so there is no
//! reset hour, no calendar week, and no burst that a user can wait out by
//! sitting on the boundary — the allowance returns gradually as the oldest
//! turns fall out the back of the window.
//!
//! Only *spoken* words are counted, once per turn, whoever spoke them — the
//! clinician's turns and the patient's both draw on the same allowance.
//! Interpretations are not counted: one utterance costs what it costs no
//! matter how many words the target language happens to need.

use serde::Serialize;

use crate::db::{Db, User};

/// Seven days, in seconds.
pub const WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// What an account has left, as shown in the UI and enforced on every turn.
#[derive(Debug, Clone, Serialize)]
pub struct Quota {
    /// Words spoken inside the current window.
    pub used: i64,
    /// The free allowance; `null` for paid accounts.
    pub limit: Option<i64>,
    /// Words left, or `null` when unlimited.
    pub remaining: Option<i64>,
    pub unlimited: bool,
    /// Unix seconds at which the oldest counted turn leaves the window, so
    /// the UI can say when a capped account frees up. `null` when nothing is
    /// counted or the account is unlimited.
    pub resets_at: Option<i64>,
    /// Length of the rolling window, for the UI's wording.
    pub window_secs: i64,
}

impl Quota {
    /// Whether this account may start another turn.
    pub fn allows_more(&self) -> bool {
        self.unlimited || self.remaining.is_some_and(|r| r > 0)
    }
}

/// Read an account's current standing.
pub fn current(db: &Db, user: &User, free_limit: i64) -> anyhow::Result<Quota> {
    let used = db.words_used_since(&user.id, WINDOW_SECS)?;
    if user.is_pro() {
        return Ok(Quota {
            used,
            limit: None,
            remaining: None,
            unlimited: true,
            resets_at: None,
            window_secs: WINDOW_SECS,
        });
    }
    Ok(Quota {
        used,
        limit: Some(free_limit),
        remaining: Some((free_limit - used).max(0)),
        unlimited: false,
        resets_at: db.window_resets_at(&user.id, WINDOW_SECS)?,
        window_secs: WINDOW_SECS,
    })
}

/// Count the words in one spoken turn.
///
/// Space-delimited scripts count whitespace-separated tokens. Chinese and
/// Japanese do not put spaces between words, so each ideograph counts as one
/// word and each unbroken run of kana counts as one — an approximation, but a
/// stable and explainable one, which is what an allowance needs to be.
pub fn count_words(text: &str) -> i64 {
    let mut words = 0i64;
    let mut in_plain_run = false;
    let mut in_kana_run = false;

    for ch in text.chars() {
        let ideograph = is_ideograph(ch);
        let kana = is_kana(ch);
        let boundary = ch.is_whitespace() || ideograph || kana;

        if boundary && in_plain_run {
            words += 1;
            in_plain_run = false;
        }
        if !kana && in_kana_run {
            in_kana_run = false;
        }

        if ideograph {
            words += 1;
        } else if kana {
            if !in_kana_run {
                words += 1;
                in_kana_run = true;
            }
        } else if !ch.is_whitespace() && !is_ignorable(ch) {
            in_plain_run = true;
        }
    }
    if in_plain_run {
        words += 1;
    }
    words
}

/// Han ideographs, as used by Chinese and in Japanese kanji.
fn is_ideograph(ch: char) -> bool {
    matches!(ch as u32,
        0x3400..=0x4DBF      // CJK Extension A
        | 0x4E00..=0x9FFF    // CJK Unified Ideographs
        | 0xF900..=0xFAFF    // Compatibility ideographs
        | 0x20000..=0x2FA1F) // Extensions B-F
}

fn is_kana(ch: char) -> bool {
    matches!(ch as u32, 0x3040..=0x30FF | 0x31F0..=0x31FF)
}

/// Punctuation alone is not a word. Latin punctuation attached to a token is
/// harmless (it rides along inside the run); this only matters for the
/// standalone marks that CJK text leaves between ideographs.
fn is_ignorable(ch: char) -> bool {
    matches!(ch as u32, 0x3000..=0x303F | 0xFF01..=0xFF20 | 0xFF3B..=0xFF40 | 0xFF5B..=0xFF65)
        || ch.is_ascii_punctuation()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn counts_space_delimited_words() {
        assert_eq!(count_words("take one tablet twice a day"), 6);
        assert_eq!(count_words("  spaced   out \n words "), 3);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   "), 0);
        // Punctuation rides along rather than becoming its own word.
        assert_eq!(count_words("Hello, how are you?"), 4);
        assert_eq!(count_words("..."), 0);
    }

    #[test]
    fn counts_cjk_without_spaces() {
        // Six ideographs, one full-stop that is not a word.
        assert_eq!(count_words("我们明天去医院。"), 7);
        // Korean is space-delimited like Latin.
        assert_eq!(count_words("오늘 병원에 갑니다"), 3);
        // Kanji count individually; the kana tail is one run.
        assert_eq!(count_words("薬を飲む"), 4);
    }

    #[test]
    fn counts_mixed_scripts() {
        // Latin letters embedded in CJK form their own token, and each
        // ideograph around them still counts one: 照 · X · 光 · 檢 · 查.
        assert_eq!(count_words("照X光檢查"), 5);
        assert_eq!(count_words("MRI 检查"), 3);
        // A Latin acronym inside a Japanese sentence. Kanji break the kana
        // into separate runs: CT · 検 · 査 · を · 受 · ける.
        assert_eq!(count_words("CT検査を受ける"), 6);
    }

    #[test]
    fn free_accounts_are_capped_and_paid_ones_are_not() {
        let db = Db::open_in_memory().unwrap();
        let user = db.upsert_user("a@b.com").unwrap();

        let q = current(&db, &user, 1000).unwrap();
        assert_eq!(q.used, 0);
        assert_eq!(q.remaining, Some(1000));
        assert!(q.allows_more());

        db.record_words(&user.id, 999, "patient").unwrap();
        let q = current(&db, &user, 1000).unwrap();
        assert_eq!(q.remaining, Some(1));
        assert!(q.allows_more());

        db.record_words(&user.id, 50, "clinician").unwrap();
        let q = current(&db, &user, 1000).unwrap();
        assert_eq!(q.used, 1049);
        // Overshoot inside one turn is allowed but clamps at zero left.
        assert_eq!(q.remaining, Some(0));
        assert!(!q.allows_more());
        assert!(q.resets_at.is_some());

        db.activate_subscription(&user.id, None, None, "active")
            .unwrap();
        let pro = db.user_by_id(&user.id).unwrap().unwrap();
        let q = current(&db, &pro, 1000).unwrap();
        assert!(q.unlimited);
        assert_eq!(q.remaining, None);
        assert!(q.allows_more());
    }
}
