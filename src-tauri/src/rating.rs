//! How old you have to be, and who has been allowed.
//!
//! Two halves that only mean something together. A rating on a title is a
//! label; a label nothing enforces is decoration. So the rating lives here and
//! the enforcement lives in the server that hands out the bytes — the device
//! holding the file decides, every time, and no setting on the watching device
//! can change its mind.
//!
//! Ratings are kept as a minimum age rather than a letter. Every country
//! writes the letters differently — R, 18, TV-MA, NC-17, UA, FSK 16 — and a
//! number is the one thing they all agree on underneath. It also compares,
//! which a letter does not: "is 15 at least 12" is a question with an answer.

use serde::{Deserialize, Serialize};

/// The lowest age a title is meant for, or nothing when it is unrated.
///
/// `None` is genuinely different from zero: unrated means nobody has said,
/// and what to do about that is the host's decision rather than this module's.
pub type MinAge = Option<u8>;

/// A rating read from a filename, and what it stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rating {
    /// The lowest age this is meant for.
    pub min_age: u8,
    /// The label as it is usually written, for showing.
    pub label: &'static str,
}

/// Everything recognised, widest first so a longer token wins.
///
/// Ordered by length within each family: "pg-13" has to be tried before "pg",
/// or every PG-13 film in the library is labelled PG and shown to a nine year
/// old. The same for "tv-ma" against "tv-14" and "nc-17" against "n".
const KNOWN: &[(&str, u8, &str)] = &[
    // American film ratings.
    ("nc-17", 18, "NC-17"),
    ("nc17", 18, "NC-17"),
    ("pg-13", 13, "PG-13"),
    ("pg13", 13, "PG-13"),
    ("unrated", 18, "Unrated"),
    ("rated r", 17, "R"),
    // American television.
    ("tv-ma", 17, "TV-MA"),
    ("tv-14", 14, "TV-14"),
    ("tv-pg", 10, "TV-PG"),
    ("tv-y7", 7, "TV-Y7"),
    ("tv-g", 0, "TV-G"),
    // British.
    ("18+", 18, "18"),
    ("15+", 15, "15"),
    ("12a", 12, "12A"),
    ("uc", 0, "U"),
    // Indian, and common on the sort of release these names come from.
    ("u/a", 12, "U/A"),
    ("ua", 12, "U/A"),
    // Bare numbers, only with a marker that they are a rating.
    ("age 18", 18, "18"),
    ("age 16", 16, "16"),
    ("age 12", 12, "12"),
    ("pg", 10, "PG"),
    ("g", 0, "G"),
    ("r", 17, "R"),
];

/// Reads a rating out of a filename, when it says one plainly.
///
/// The hard part is not finding ratings, it is not finding them where they are
/// not. A release name is dense with letters that mean something else: the R
/// in WEB-DL, the G in HEVC, the 18 in a year. So a token only counts when it
/// stands alone between separators, and the shortest and most dangerous ones —
/// a lone "r" or "g" — are only believed inside brackets, where a rating is
/// what a single letter is doing there.
///
/// Wrong in the permissive direction on purpose. A film that should have been
/// restricted and was not is a real failure, but so is a children's film
/// hidden behind an approval because its title contained an R — and the second
/// happens hundreds of times in a library while the first happens once. The
/// host can set what the guess missed; the guess only has to be quiet when it
/// does not know.
pub fn guess(name: &str) -> Option<Rating> {
    let lower = name.to_ascii_lowercase();

    for (token, min_age, label) in KNOWN {
        let single = token.len() == 1;
        if let Some(at) = find_token(&lower, token, single) {
            let _ = at;
            return Some(Rating { min_age: *min_age, label });
        }
    }
    None
}

/// Whether `token` appears as a thing on its own.
///
/// Separators are what release names actually use between fields: spaces,
/// dots, underscores, dashes, and brackets of every kind. A token flanked by
/// letters or digits is part of a word and means nothing.
fn find_token(haystack: &str, token: &str, brackets_only: bool) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let mut from = 0;

    while let Some(rel) = haystack[from..].find(token) {
        let at = from + rel;
        let end = at + token.len();

        let before = at.checked_sub(1).map(|i| bytes[i] as char);
        let after = bytes.get(end).map(|b| *b as char);

        let bounded = before.is_none_or(|c| !c.is_ascii_alphanumeric())
            && after.is_none_or(|c| !c.is_ascii_alphanumeric());

        if bounded {
            if !brackets_only {
                return Some(at);
            }
            // A lone letter is only a rating inside brackets. Anywhere else it
            // is the R of WEB-DL or somebody's initial.
            let inside = matches!(before, Some('(' | '[' | '{'))
                && matches!(after, Some(')' | ']' | '}'));
            if inside {
                return Some(at);
            }
        }
        from = at + 1;
    }
    None
}

/// Whether a device allowed up to `allowed` may watch something rated `needs`.
///
/// Both halves of the unknown case are decisions, not oversights. A title
/// nobody has rated is allowed, because a library of hundreds arrives unrated
/// and a control that blocks everything on day one is a control that gets
/// turned off. A device nobody has approved gets the household default, which
/// the host sets.
pub fn may_watch(needs: MinAge, allowed: u8) -> bool {
    match needs {
        None => true,
        Some(age) => allowed >= age,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn age(name: &str) -> Option<u8> {
        guess(name).map(|r| r.min_age)
    }

    #[test]
    fn the_obvious_ones() {
        assert_eq!(age("Some Film (PG-13) 1080p"), Some(13));
        assert_eq!(age("Some Film [NC-17]"), Some(18));
        assert_eq!(age("Some Show S01E01 TV-MA"), Some(17));
        assert_eq!(age("Some Show TV-14"), Some(14));
    }

    /// The whole difficulty. A release name is full of letters that are not
    /// ratings, and a false positive hides a children's film behind an
    /// approval nobody knows to grant.
    #[test]
    fn release_junk_is_not_a_rating() {
        for name in [
            "Flow 2024 1080p WEB-DL HEVC x265 BONE",
            "Deadpool.2.2016.1080p.BluRay.x264-YTS.AG",
            "The Batman (2022) 2160p HDR DDP5.1",
            "Guardians of the Galaxy Vol 2 1080p WEBRip",
            "Mushoku Tensei Jobless Reincarnation Season 3 Episode 12",
            "Jaadugar A Witch In Mongolia Episode 9 In HD Online For Free Animenosub",
            "Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H264.MP4-BEN",
            "Frankenstein",
            "Smiling Friends",
        ] {
            assert_eq!(age(name), None, "{name} was read as rated");
        }
    }

    /// "pg" is inside "pg-13", and matching it first labels every PG-13 film
    /// as PG — which shows a thirteen-rated film to a ten year old.
    #[test]
    fn the_longer_label_wins() {
        assert_eq!(guess("Film (PG-13)").unwrap().label, "PG-13");
        assert_eq!(guess("Film (PG)").unwrap().label, "PG");
        assert_eq!(guess("Film (NC-17)").unwrap().label, "NC-17");
        assert_eq!(guess("Show TV-MA").unwrap().label, "TV-MA");
    }

    /// A single letter is only a rating where a single letter has no other
    /// business being.
    #[test]
    fn a_lone_letter_needs_brackets() {
        assert_eq!(age("Film (R) 1080p"), Some(17));
        assert_eq!(age("Film [R]"), Some(17));
        assert_eq!(age("Film (G)"), Some(0));
        // Not these: the R stands for something else every time.
        assert_eq!(age("Film R 1080p"), None);
        assert_eq!(age("Film - R - 1080p"), None);
        assert_eq!(age("R.I.P.D. 2013"), None);
    }

    #[test]
    fn unrated_is_treated_as_adult() {
        // A release labelled "Unrated" is the longer cut, and the longer cut
        // is never the tamer one.
        assert_eq!(age("Some Film UNRATED 1080p"), Some(18));
    }

    #[test]
    fn case_does_not_matter() {
        assert_eq!(age("film (pg-13)"), age("FILM (PG-13)"));
        assert_eq!(age("show tv-ma"), Some(17));
    }

    /* --------------------------------------------------------- permission */

    #[test]
    fn an_unrated_title_is_not_blocked() {
        // A library arrives unrated, and a control that blocks all of it on
        // the first day is a control that gets switched off.
        assert!(may_watch(None, 0));
        assert!(may_watch(None, 18));
    }

    #[test]
    fn age_is_compared_not_matched() {
        assert!(may_watch(Some(13), 18), "an adult was refused a PG-13 film");
        assert!(may_watch(Some(13), 13), "the exact age was refused");
        assert!(!may_watch(Some(17), 13));
        assert!(!may_watch(Some(18), 0));
    }

    #[test]
    fn a_device_allowed_nothing_still_sees_the_unrated_and_the_universal() {
        assert!(may_watch(Some(0), 0), "a U film was refused");
        assert!(!may_watch(Some(7), 0));
    }
}
