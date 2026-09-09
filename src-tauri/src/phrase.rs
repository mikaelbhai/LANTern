//! Six-word pairing phrases.
//!
//! Two devices on different subnets cannot find each other: mDNS does not
//! cross a router, and neither device can guess the other's address. A phrase
//! is the out-of-band channel — something a person can read down a phone line
//! or write on a sticky note — that carries the address across the gap.
//!
//! Six words from a 264-word list is 6 x log2(264) = 48.3 bits, and an IPv4
//! address with a port is exactly 48. So a phrase is not a lookup key or a
//! token to be exchanged with a server: it *is* the address, written in words.
//! Nothing is stored, nothing expires, and it works with no third party.
//!
//! The list is generated from `src/lib/phrase.ts`; the two must agree exactly
//! or a phrase made on one device will not decode on another. `WORDS` is
//! checked against the same invariants the TypeScript relies on.

/// The pairing vocabulary. Order is significant: a word's position is its
/// digit, so reordering this list silently invalidates every phrase.
pub const WORDS: [&str; 264] = [
    "amber", "anchor", "apple", "arbor", "arrow", "atlas", "aurora", "autumn",
    "basin", "beacon", "birch", "bison", "blossom", "bramble", "brass", "breeze",
    "bridge", "bronze", "brook", "burrow", "cabin", "canvas", "canyon", "cedar",
    "cinder", "circuit", "cliff", "clover", "cobalt", "comet", "compass", "copper",
    "coral", "cotton", "crater", "crescent", "crimson", "crystal", "cypress", "dagger",
    "dawn", "delta", "dune", "dusk", "eagle", "ember", "engine", "estuary",
    "falcon", "fathom", "fern", "fjord", "flame", "flint", "forest", "fossil",
    "foxglove", "fresco", "frost", "gable", "galley", "garnet", "gateway", "geyser",
    "ginger", "glacier", "glimmer", "granite", "gravel", "grotto", "grove", "harbor",
    "harvest", "hazel", "heather", "hemlock", "heron", "hollow", "horizon", "ibis",
    "indigo", "inlet", "iris", "island", "ivory", "jasper", "jetty", "juniper",
    "kelp", "kestrel", "keystone", "kindle", "lagoon", "lantern", "lark", "lattice",
    "laurel", "ledger", "lichen", "lighthouse", "lilac", "linen", "lodge", "lotus",
    "lumen", "lunar", "lyric", "magnet", "mahogany", "mallow", "maple", "marble",
    "marina", "marsh", "meadow", "meridian", "mesa", "mica", "midnight", "mineral",
    "mirage", "mist", "monsoon", "moraine", "mosaic", "moss", "nectar", "needle",
    "nimbus", "north", "nova", "oasis", "obsidian", "ocean", "ochre", "olive",
    "onyx", "opal", "orbit", "orchard", "osprey", "otter", "outpost", "oxide",
    "pagoda", "palm", "papyrus", "parapet", "pasture", "pebble", "pelican", "pepper",
    "petal", "pewter", "pigeon", "pillar", "pine", "pivot", "plateau", "plume",
    "pollen", "poplar", "portal", "prairie", "prism", "pueblo", "pulsar", "pumice",
    "quarry", "quartz", "quiet", "quill", "radiant", "rafter", "rapids", "raven",
    "reed", "reef", "relay", "ridge", "rill", "ripple", "river", "rivet",
    "rowan", "rudder", "ruby", "runner", "saffron", "sage", "sandbar", "sapphire",
    "satchel", "savanna", "scarlet", "seaside", "sepia", "shale", "shelter", "shore",
    "signal", "silica", "silver", "sitka", "slate", "sleet", "socket", "solstice",
    "sonar", "spindle", "spire", "spruce", "stanza", "starling", "station", "steppe",
    "stone", "stratus", "stream", "sumac", "summit", "sunset", "switch", "sycamore",
    "talon", "tamarind", "tandem", "tangle", "tapestry", "teal", "tempo", "tendril",
    "terrace", "thicket", "thistle", "thunder", "tidal", "timber", "tinder", "topaz",
    "torrent", "tower", "trellis", "tributary", "trillium", "tundra", "tunnel", "turret",
    "umber", "valley", "vector", "velvet", "verdant", "vertex", "vessel", "vineyard",
    "violet", "vista", "walnut", "warren", "willow", "window", "winter", "zephyr",
];

const BASE: u64 = WORDS.len() as u64;

/// Encodes an address and port as six words.
///
/// Returns `None` for anything that is not IPv4 — there is no honest way to
/// fit an IPv6 address into six words, and a truncated one would connect to
/// the wrong machine rather than fail.
pub fn encode(ip: &str, port: u16) -> Option<String> {
    let octets: Vec<u8> = ip
        .split('.')
        .map(|part| part.parse::<u8>().ok())
        .collect::<Option<Vec<_>>>()?;
    if octets.len() != 4 {
        return None;
    }

    let address = u32::from_be_bytes([octets[0], octets[1], octets[2], octets[3]]);
    let mut value = ((address as u64) << 16) | port as u64;

    // Base-264, least significant digit first, then reversed so the phrase
    // reads most significant first — the order it will be written down in.
    let mut words = Vec::with_capacity(6);
    for _ in 0..6 {
        words.push(WORDS[(value % BASE) as usize]);
        value /= BASE;
    }
    words.reverse();
    Some(words.join(" "))
}

/// Turns six words back into an address and port.
///
/// Every failure is a refusal rather than a guess: a misheard word, a missing
/// one, or a value that could not have come from an address all return `None`.
pub fn decode(phrase: &str) -> Option<(String, u16)> {
    let words: Vec<&str> = phrase.split_whitespace().collect();
    if words.len() != 6 {
        return None;
    }

    let mut value: u64 = 0;
    for word in words {
        let lower = word.to_ascii_lowercase();
        let digit = WORDS.iter().position(|w| *w == lower)? as u64;
        value = value * BASE + digit;
    }

    // Six base-264 digits can express more than 48 bits, so a phrase can be
    // well-formed and still not name an address.
    if value >= 1u64 << 48 {
        return None;
    }

    let port = (value & 0xFFFF) as u16;
    let address = (value >> 16) as u32;
    let [a, b, c, d] = address.to_be_bytes();
    Some((format!("{a}.{b}.{c}.{d}"), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_word_list_is_what_the_encoding_assumes() {
        assert_eq!(WORDS.len(), 264, "changing the size changes every phrase");
        let mut sorted = WORDS.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "a duplicate word makes decoding ambiguous");
    }

    #[test]
    fn a_phrase_round_trips() {
        for (ip, port) in [
            ("192.168.100.67", 7979u16),
            ("10.0.0.1", 1),
            ("255.255.255.255", 65535),
            ("0.0.0.0", 0),
        ] {
            let phrase = encode(ip, port).expect("encodes");
            assert_eq!(phrase.split_whitespace().count(), 6, "{phrase}");
            assert_eq!(decode(&phrase), Some((ip.to_string(), port)));
        }
    }

    #[test]
    fn different_addresses_give_different_phrases() {
        let a = encode("192.168.1.10", 7979).unwrap();
        let b = encode("192.168.1.11", 7979).unwrap();
        assert_ne!(a, b, "the phrase must carry the address, not a constant");
    }

    #[test]
    fn case_and_spacing_do_not_matter() {
        let phrase = encode("192.168.100.67", 7979).unwrap();
        let shouted = format!("  {}  ", phrase.to_uppercase());
        assert_eq!(decode(&shouted), decode(&phrase));
    }

    #[test]
    fn nonsense_is_refused_rather_than_guessed() {
        assert_eq!(decode(""), None);
        assert_eq!(decode("amber lantern quiet river copper"), None, "five words");
        assert_eq!(
            decode("amber lantern quiet river copper notaword"),
            None,
            "a word outside the list"
        );
        // Six real words whose value is beyond 48 bits.
        let top = WORDS[WORDS.len() - 1];
        assert_eq!(decode(&vec![top; 6].join(" ")), None);
    }

    #[test]
    fn ipv6_is_refused_because_it_would_not_fit() {
        assert_eq!(encode("fe80::1", 7979), None);
        assert_eq!(encode("192.168.1", 7979), None);
        assert_eq!(encode("192.168.1.256", 7979), None);
    }
}
