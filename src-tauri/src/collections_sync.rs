//! Collections made on one device, shown on the others.
//!
//! How a library is grouped - "Sam Raimi Spider-Man" for what the filenames
//! call something else, a hand-made "The Amazing Spider-Man" - is decided by
//! whoever holds the files, in their own Theatre, and was kept there and
//! nowhere else. Every other device grouped the same titles from their
//! filenames alone, so the host's names and hand-made collections existed on
//! exactly one screen.
//!
//! The host now publishes them (`/collections.json`) and the others read them
//! alongside each library. Two things have to be translated on the way:
//!
//! * **Ids.** The host keys its choices by its own item ids, which mean nothing
//!   to anyone else; a copy of the same file elsewhere is
//!   `<device>:<slug>:<path>`. The published form is `<slug>:<path>`, which the
//!   reader prefixes with whose it is - the same rule `library::fetch_peer`
//!   uses to name the items themselves.
//! * **What may be seen.** A restricted title is not listed for a device that
//!   may not watch it, and its name must not leak through a collection either.
//!   Choices about titles the asker cannot see are left out.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// What a device publishes: its own choices, in ids anybody can recognise.
///
/// `local_items` are this device's own titles as the library lists them;
/// `slug_of` finds the published name of a share from its id; `allowed` says
/// whether the asker may know a title exists.
pub fn export(
    overrides: &Value,
    local_items: &[Value],
    slug_of: &dyn Fn(&str) -> Option<String>,
    allowed: &dyn Fn(&Value) -> bool,
) -> Value {
    // This device's id for a title -> the id anybody can use for it.
    let mut portable: HashMap<String, String> = HashMap::new();
    for item in local_items {
        if !allowed(item) {
            continue;
        }
        let (Some(id), Some(share), Some(rel)) = (
            item.get("id").and_then(|v| v.as_str()),
            item.get("shareId").and_then(|v| v.as_str()),
            item.get("relPath").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if let Some(slug) = slug_of(share) {
            portable.insert(id.to_string(), format!("{slug}:{rel}"));
        }
    }

    let object = |key: &str| overrides.get(key).and_then(|v| v.as_object());

    // Collections somebody made by hand: the keys their titles were filed under.
    let authored: HashSet<&str> = object("itemToKey")
        .map(|m| m.values().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    let mut item_to_key = Map::new();
    let mut used: HashSet<String> = HashSet::new();
    if let Some(map) = object("itemToKey") {
        for (id, key) in map {
            if let (Some(p), Some(k)) = (portable.get(id), key.as_str()) {
                item_to_key.insert(p.clone(), json!(k));
                used.insert(k.to_string());
            }
        }
    }

    let detached: Vec<Value> = overrides
        .get("detached")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().and_then(|id| portable.get(id)))
                .map(|p| json!(p))
                .collect()
        })
        .unwrap_or_default();

    let mut member_order = Map::new();
    if let Some(map) = object("memberOrder") {
        for (key, ids) in map {
            let mapped: Vec<Value> = ids
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|id| id.as_str().and_then(|id| portable.get(id)))
                        .map(|p| json!(p))
                        .collect()
                })
                .unwrap_or_default();
            if !mapped.is_empty() {
                member_order.insert(key.clone(), Value::Array(mapped));
            }
        }
    }

    // A name for a collection worked out from filenames applies to everyone who
    // has that collection; a name for one somebody made by hand is only worth
    // sending when something the asker can see is in it.
    let mut titles = Map::new();
    if let Some(map) = object("titles") {
        for (key, title) in map {
            if !authored.contains(key.as_str()) || used.contains(key) {
                titles.insert(key.clone(), title.clone());
            }
        }
    }

    json!({
        "itemToKey": item_to_key,
        "titles": titles,
        "detached": detached,
        "memberOrder": member_order,
    })
}

/// What a reader keeps: a peer's published choices, with the ids made theirs.
pub fn import(peer_id: &str, published: &Value) -> Value {
    let prefix = |id: &str| json!(format!("{peer_id}:{id}"));

    let mut item_to_key = Map::new();
    if let Some(map) = published.get("itemToKey").and_then(|v| v.as_object()) {
        for (id, key) in map {
            item_to_key.insert(format!("{peer_id}:{id}"), key.clone());
        }
    }
    let list = |key: &str| -> Vec<Value> {
        published
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|id| id.as_str()).map(prefix).collect())
            .unwrap_or_default()
    };
    let mut member_order = Map::new();
    if let Some(map) = published.get("memberOrder").and_then(|v| v.as_object()) {
        for (key, ids) in map {
            let mapped: Vec<Value> = ids
                .as_array()
                .map(|a| a.iter().filter_map(|id| id.as_str()).map(prefix).collect())
                .unwrap_or_default();
            member_order.insert(key.clone(), Value::Array(mapped));
        }
    }

    json!({
        "itemToKey": item_to_key,
        "titles": published.get("titles").cloned().unwrap_or_else(|| json!({})),
        "detached": list("detached"),
        "memberOrder": member_order,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, share: &str, rel: &str) -> Value {
        json!({ "id": id, "shareId": share, "relPath": rel })
    }

    fn slug(share: &str) -> Option<String> {
        (share == "s1").then(|| "media".to_string())
    }

    #[test]
    fn a_renamed_saga_and_a_hand_made_collection_are_published_in_portable_ids() {
        let items = vec![
            item("s1:Spider-Man (2002)/a.mkv", "s1", "Spider-Man (2002)/a.mkv"),
            item("s1:Amazing/b.mkv", "s1", "Amazing/b.mkv"),
        ];
        let overrides = json!({
            "itemToKey": { "s1:Amazing/b.mkv": "custom:amazing" },
            "titles": { "saga:spiderman": "Sam Raimi Spider-Man", "custom:amazing": "The Amazing Spider-Man" },
            "detached": [],
            "order": [],
        });
        let out = export(&overrides, &items, &slug, &|_| true);
        assert_eq!(out["itemToKey"]["media:Amazing/b.mkv"], "custom:amazing");
        assert_eq!(out["titles"]["saga:spiderman"], "Sam Raimi Spider-Man");
        assert_eq!(out["titles"]["custom:amazing"], "The Amazing Spider-Man");
    }

    #[test]
    fn what_the_asker_may_not_see_is_not_named() {
        let items = vec![item("s1:secret.mkv", "s1", "secret.mkv"), item("s1:ok.mkv", "s1", "ok.mkv")];
        let overrides = json!({
            "itemToKey": { "s1:secret.mkv": "custom:private", "s1:ok.mkv": "custom:fine" },
            "titles": { "custom:private": "Private", "custom:fine": "Fine" },
            "detached": ["s1:secret.mkv"],
        });
        let only_ok = |i: &Value| i["relPath"] != "secret.mkv";
        let out = export(&overrides, &items, &slug, &only_ok);
        assert!(out["itemToKey"].get("media:secret.mkv").is_none());
        assert!(out["titles"].get("custom:private").is_none(), "a hidden collection's name leaked");
        assert_eq!(out["titles"]["custom:fine"], "Fine");
        assert_eq!(out["detached"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_reader_makes_the_ids_its_own() {
        let published = json!({
            "itemToKey": { "media:a.mkv": "custom:x" },
            "titles": { "saga:s": "Name" },
            "detached": ["media:b.mkv"],
            "memberOrder": { "custom:x": ["media:a.mkv"] },
        });
        let got = import("dev-1", &published);
        // The same id `library::fetch_peer` gives the item.
        assert_eq!(got["itemToKey"]["dev-1:media:a.mkv"], "custom:x");
        assert_eq!(got["detached"][0], "dev-1:media:b.mkv");
        assert_eq!(got["memberOrder"]["custom:x"][0], "dev-1:media:a.mkv");
        assert_eq!(got["titles"]["saga:s"], "Name");
    }

    #[test]
    fn garbage_in_is_empty_out() {
        let got = import("d", &json!("nonsense"));
        assert_eq!(got["itemToKey"], json!({}));
        let out = export(&json!(null), &[], &slug, &|_| true);
        assert_eq!(out["titles"], json!({}));
    }
}
