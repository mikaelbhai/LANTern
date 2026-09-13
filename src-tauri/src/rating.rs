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

use crate::state::AppState;

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

/* ------------------------------------------------------------ age gating */

/// The default age this household allows a device nobody has set.
///
/// Twelve rather than eighteen: a new device is more often somebody's tablet
/// than a stranger's, and a default of nothing means every new phone appears
/// broken until the host notices. Twelve leaves the thing this feature exists
/// for behind an approval, which is the point.
pub const DEFAULT_MAX_AGE: u8 = 12;

/// The oldest content one device may watch here.
pub fn allowed_age(state: &AppState, device_id: &str) -> u8 {
    state.with(|s| {
        s.device_ages.get(device_id).copied().unwrap_or_else(|| {
            s.db.as_ref()
                .and_then(|db| {
                    db.query_row(
                        "SELECT value FROM preferences WHERE key = 'default_max_age'",
                        [],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                })
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_MAX_AGE)
        })
    })
}

/// Which device is behind a request, from the key it presented.
///
/// `None` means nobody identifiable — a browser typing the address in, or a
/// peer from before this version. Those are treated as the household default
/// rather than refused outright, because the plain-HTTP library is a feature:
/// any browser on the network can open it, and that stays true for everything
/// nobody has restricted.
pub fn requester(state: &AppState, key: Option<&str>) -> Option<String> {
    let key = key?;
    if key.is_empty() {
        return None;
    }
    state.with(|s| {
        s.issued_keys
            .iter()
            .find(|(_, issued)| issued.as_str() == key)
            .map(|(device, _)| device.clone())
    })
}

/// What a title is rated: the host's word if they gave one, else the guess.
pub fn min_age_for(state: &AppState, stream_path: &str, name: &str) -> crate::rating::MinAge {
    if let Some(set) = state.with(|s| s.title_ages.get(stream_path).copied()) {
        return Some(set);
    }
    crate::rating::guess(name).map(|r| r.min_age)
}

/// Whether the device behind this request may watch this title.
///
/// The single place the decision is made, so there is one thing to read to
/// know whether restricted content can leave this machine.
pub fn may_serve(state: &AppState, key: Option<&str>, stream_path: &str, name: &str) -> bool {
    let needs = min_age_for(state, stream_path, name);
    let allowed = match requester(state, key) {
        Some(device) => allowed_age(state, &device),
        None => allowed_age(state, ""),
    };
    crate::rating::may_watch(needs, allowed)
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

#[cfg(test)]
mod gate_tests {
    use super::*;
    use crate::state::AppState;

    /// A host with one approved device, one restricted device, and one title
    /// it has rated by hand.
    fn household() -> AppState {
        let state = AppState::new();
        state.with(|s| {
            s.issued_keys.insert("grown-up".into(), "key-grown".into());
            s.issued_keys.insert("child".into(), "key-child".into());
            s.device_ages.insert("grown-up".into(), 18);
            s.device_ages.insert("child".into(), 7);
            s.title_ages.insert("/media/Some Film.mkv".into(), 18);
        });
        state
    }

    #[test]
    fn a_key_says_which_device_is_asking() {
        let state = household();
        assert_eq!(requester(&state, Some("key-child")).as_deref(), Some("child"));
        assert_eq!(requester(&state, Some("key-grown")).as_deref(), Some("grown-up"));
    }

    #[test]
    fn and_anything_else_says_nobody() {
        let state = household();
        // Every one of these is a request the server cannot attribute, and
        // must not attribute by accident to whoever is first in the map.
        for attempt in [None, Some(""), Some("guessed"), Some("key-"), Some("KEY-CHILD")] {
            assert_eq!(requester(&state, attempt), None, "{attempt:?} matched a device");
        }
    }

    #[test]
    fn the_host_s_rating_beats_the_guess() {
        let state = household();
        // The filename says nothing; the host said eighteen.
        assert_eq!(min_age_for(&state, "/media/Some Film.mkv", "Some Film.mkv"), Some(18));
        // And where the host has said nothing, the filename is used.
        assert_eq!(min_age_for(&state, "/media/Other.mkv", "Other (PG-13).mkv"), Some(13));
        assert_eq!(min_age_for(&state, "/media/Plain.mkv", "Plain.mkv"), None);
    }

    #[test]
    fn a_restricted_title_is_refused_to_a_child_and_served_to_an_adult() {
        let state = household();
        let path = "/media/Some Film.mkv";
        assert!(!may_serve(&state, Some("key-child"), path, "Some Film.mkv"));
        assert!(may_serve(&state, Some("key-grown"), path, "Some Film.mkv"));
    }

    /// The whole point of a key. Guessing one, dropping it, or presenting
    /// somebody else's must not open the door.
    #[test]
    fn a_restricted_title_is_refused_to_anyone_unidentified() {
        let state = household();
        let path = "/media/Some Film.mkv";
        for attempt in [None, Some(""), Some("key-guessed")] {
            assert!(
                !may_serve(&state, attempt, path, "Some Film.mkv"),
                "{attempt:?} was served a restricted title",
            );
        }
    }

    /// A default of twelve, so an unknown device is neither locked out of
    /// everything nor handed everything.
    #[test]
    fn an_unknown_device_gets_the_household_default() {
        let state = household();
        assert_eq!(allowed_age(&state, "never-seen"), crate::rating::DEFAULT_MAX_AGE);
        assert!(may_serve(&state, None, "/media/Kids.mkv", "Kids (PG).mkv"));
        assert!(!may_serve(&state, None, "/media/Adult.mkv", "Adult (NC-17).mkv"));
    }

    /// The ordinary case, and the one that must not regress: a library nobody
    /// has rated stays open to everybody.
    #[test]
    fn an_unrated_library_is_untouched() {
        let state = household();
        for name in [
            "Flow 2024 1080p WEB-DL HEVC x265 BONE.mkv",
            "Smiling Friends S01E01.mkv",
            "Jaadugar A Witch In Mongolia Episode 9 In HD Online For Free.mkv",
        ] {
            let path = format!("/media/{name}");
            assert!(
                may_serve(&state, Some("key-child"), &path, name),
                "{name} was withheld from a child who should see it",
            );
        }
    }

    /// A correction can be taken back, not merely replaced.
    #[test]
    fn a_rating_can_be_cleared() {
        let state = household();
        state.with(|s| s.title_ages.remove("/media/Some Film.mkv"));
        assert_eq!(min_age_for(&state, "/media/Some Film.mkv", "Some Film.mkv"), None);
        assert!(may_serve(&state, Some("key-child"), "/media/Some Film.mkv", "Some Film.mkv"));
    }

    /// Two devices sharing a household must not share an allowance.
    #[test]
    fn one_device_being_approved_does_not_approve_another() {
        let state = household();
        let path = "/media/Some Film.mkv";
        assert!(may_serve(&state, Some("key-grown"), path, "Some Film.mkv"));
        assert!(
            !may_serve(&state, Some("key-child"), path, "Some Film.mkv"),
            "approving one device approved another",
        );
    }
}
