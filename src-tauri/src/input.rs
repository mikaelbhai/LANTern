//! Applying input that came from another device.
//!
//! This is the one part of LANTern that acts on the machine rather than
//! inside it. Everything else this application does is confined to its own
//! window; this moves the real pointer and presses real keys, in whatever has
//! focus, which may be a terminal or somebody's bank.
//!
//! So the gate matters more than the mechanism, and it is built the strict way
//! round:
//!
//! Nobody may send input until the person at this machine has said yes to that
//! specific device, in a dialog they did not ask for and can refuse. The grant
//! is held in memory only — it is never written down, so it cannot outlive the
//! process, and a machine that restarts wakes up controlled by nobody. Exactly
//! one device holds it at a time. It ends the moment it is revoked, the moment
//! that peer's link drops, and when the screen it was granted alongside stops
//! being shared.
//!
//! And when it ends, everything the controller was holding is released. A
//! session that ends mid-keypress would otherwise leave a key down on a
//! machine in another room, which is both baffling and, with the wrong key,
//! destructive.

use serde::{Deserialize, Serialize};

/// One input event, exactly as `src/lib/remote.ts` puts it on the wire.
///
/// The names are single letters because a finger produces sixty of these a
/// second and the field name would outweigh the number it labels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t")]
pub enum RemoteEvent {
    /// Pointer movement, relative to where it is now.
    #[serde(rename = "m")]
    Move { dx: i32, dy: i32 },
    /// A mouse button. `d` is true for pressed.
    #[serde(rename = "b")]
    Button { b: String, d: bool },
    /// A scroll, in wheel notches.
    #[serde(rename = "s")]
    Scroll { dx: i32, dy: i32 },
    /// A named key. `d` is true for pressed.
    #[serde(rename = "k")]
    Key { k: String, d: bool },
    /// Literal text, typed as though at the keyboard.
    #[serde(rename = "x")]
    Text { s: String },
}

/// How far one event may move the pointer.
///
/// A delta is a small number arrived at by adding up finger movement. A large
/// one is a bug or a hostile peer, and either way flinging the pointer into a
/// corner of the screen is worse than ignoring it. Two thousand covers the
/// widest sensible flick across the widest sensible monitor.
pub const MAX_STEP: i32 = 2000;

/// How much text one event may carry.
///
/// Typing is for filling in a field from a phone keyboard, not for pasting a
/// file into whatever happens to have focus.
pub const MAX_TEXT: usize = 512;

/// Whether this event is one we are willing to apply at all.
///
/// Separate from applying it so the rule can be read, and tested, without a
/// desktop session to press keys into.
pub fn is_sane(event: &RemoteEvent) -> bool {
    match event {
        RemoteEvent::Move { dx, dy } | RemoteEvent::Scroll { dx, dy } => {
            dx.abs() <= MAX_STEP && dy.abs() <= MAX_STEP
        }
        RemoteEvent::Text { s } => !s.is_empty() && s.len() <= MAX_TEXT,
        RemoteEvent::Button { b, .. } => matches!(b.as_str(), "left" | "right" | "middle"),
        RemoteEvent::Key { k, .. } => !k.is_empty() && k.len() <= 32,
    }
}

/// Who, if anyone, may drive this machine.
///
/// A single slot rather than a list. Two people moving one pointer is not a
/// feature, and the simplicity means there is never a question about who is
/// allowed to do what.
#[derive(Debug, Default)]
pub struct Control {
    /// Device id of the peer holding control, when one does.
    granted_to: Option<String>,
}

impl Control {
    /// Hands control to one device, taking it from whoever had it.
    pub fn grant(&mut self, device_id: &str) {
        self.granted_to = Some(device_id.to_string());
    }

    pub fn revoke(&mut self) {
        self.granted_to = None;
    }

    pub fn holder(&self) -> Option<&str> {
        self.granted_to.as_deref()
    }

    /// Whether this device may send input right now.
    ///
    /// The whole gate in one line, so there is no second place for it to be
    /// got wrong. Note it is not enough for *somebody* to hold control — it
    /// has to be this sender.
    pub fn allows(&self, device_id: &str) -> bool {
        self.granted_to.as_deref() == Some(device_id)
    }

    /// Ends the session if `device_id` was the one holding it.
    ///
    /// Called when a link drops. Another peer disconnecting must not quietly
    /// take control away from the one who has it.
    pub fn drop_peer(&mut self, device_id: &str) -> bool {
        if self.allows(device_id) {
            self.granted_to = None;
            return true;
        }
        false
    }
}

/* --------------------------------------------------------- pressing things */

#[cfg(desktop)]
pub use desktop::{apply, Injector};

#[cfg(desktop)]
mod desktop {
    use super::{is_sane, RemoteEvent};
    use enigo::{
        Axis, Button as MouseButton, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
    };

    /// Holds the platform's input device open.
    ///
    /// Built once and reused: on Windows each construction opens handles, and
    /// doing that sixty times a second while somebody drags a finger is a
    /// measurable waste for no benefit.
    pub struct Injector {
        pub(crate) enigo: Enigo,
        /// Keys and buttons this session has pressed and not yet released.
        held_keys: Vec<String>,
        held_buttons: Vec<String>,
    }

    impl Injector {
        pub fn new() -> Result<Self, String> {
            let enigo = Enigo::new(&Settings::default())
                .map_err(|e| format!("no input device: {e}"))?;
            Ok(Self { enigo, held_keys: Vec::new(), held_buttons: Vec::new() })
        }

        /// Releases everything this session is still holding.
        ///
        /// The reason the struct tracks state at all. A session that ends
        /// while a key is down leaves it down, on a machine the person who
        /// pressed it cannot see.
        pub fn release_all(&mut self) {
            for name in std::mem::take(&mut self.held_keys) {
                if let Some(key) = key_for(&name) {
                    let _ = self.enigo.key(key, Direction::Release);
                }
            }
            for name in std::mem::take(&mut self.held_buttons) {
                if let Some(button) = button_for(&name) {
                    let _ = self.enigo.button(button, Direction::Release);
                }
            }
        }

        pub fn apply(&mut self, event: &RemoteEvent) -> Result<(), String> {
            if !is_sane(event) {
                return Err("refused".into());
            }
            match event {
                RemoteEvent::Move { dx, dy } => {
                    // Read where it is and move it there plus the delta,
                    // rather than asking for a relative move.
                    //
                    // A relative move on Windows goes through the pointer
                    // ballistics - the "enhance pointer precision" curve -
                    // which scales it by however fast the OS thinks the mouse
                    // is travelling. Asking for +40,+25 landed +57,+34 on this
                    // machine, and the phone has already applied its own
                    // acceleration, so the two curves multiplied. The result
                    // was a pointer that overshoots by a different amount
                    // every time and cannot be aimed.
                    //
                    // An absolute move is exactly the number given.
                    let (x, y) = self.enigo.location().map_err(|e| e.to_string())?;
                    self.enigo
                        .move_mouse(x + dx, y + dy, Coordinate::Abs)
                        .map_err(|e| e.to_string())
                }
                RemoteEvent::Scroll { dx, dy } => {
                    if *dy != 0 {
                        self.enigo.scroll(*dy, Axis::Vertical).map_err(|e| e.to_string())?;
                    }
                    if *dx != 0 {
                        self.enigo.scroll(*dx, Axis::Horizontal).map_err(|e| e.to_string())?;
                    }
                    Ok(())
                }
                RemoteEvent::Button { b, d } => {
                    let Some(button) = button_for(b) else {
                        return Err("unknown button".into());
                    };
                    self.track(&mut Tracked::Button(b.clone()), *d);
                    self.enigo
                        .button(button, if *d { Direction::Press } else { Direction::Release })
                        .map_err(|e| e.to_string())
                }
                RemoteEvent::Key { k, d } => {
                    let Some(key) = key_for(k) else {
                        return Err("unknown key".into());
                    };
                    self.track(&mut Tracked::Key(k.clone()), *d);
                    self.enigo
                        .key(key, if *d { Direction::Press } else { Direction::Release })
                        .map_err(|e| e.to_string())
                }
                RemoteEvent::Text { s } => self.enigo.text(s).map_err(|e| e.to_string()),
            }
        }

        fn track(&mut self, what: &mut Tracked, down: bool) {
            let (list, name) = match what {
                Tracked::Key(name) => (&mut self.held_keys, name),
                Tracked::Button(name) => (&mut self.held_buttons, name),
            };
            if down {
                if !list.iter().any(|held| held == name) {
                    list.push(name.clone());
                }
            } else {
                list.retain(|held| held != name);
            }
        }
    }

    enum Tracked {
        Key(String),
        Button(String),
    }

    fn button_for(name: &str) -> Option<MouseButton> {
        match name {
            "left" => Some(MouseButton::Left),
            "right" => Some(MouseButton::Right),
            "middle" => Some(MouseButton::Middle),
            _ => None,
        }
    }

    /// The key a name stands for.
    ///
    /// Named keys use the same spellings a browser's `KeyboardEvent.key` uses,
    /// so the phone can pass through what its own keyboard reports without a
    /// translation table of its own. Anything that is a single character is
    /// that character.
    pub(super) fn key_for(name: &str) -> Option<Key> {
        Some(match name {
            "ArrowUp" => Key::UpArrow,
            "ArrowDown" => Key::DownArrow,
            "ArrowLeft" => Key::LeftArrow,
            "ArrowRight" => Key::RightArrow,
            "Enter" | "Return" => Key::Return,
            "Escape" => Key::Escape,
            "Backspace" => Key::Backspace,
            "Tab" => Key::Tab,
            "Space" => Key::Space,
            "Delete" => Key::Delete,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "Shift" => Key::Shift,
            "Control" => Key::Control,
            "Alt" => Key::Alt,
            "Meta" => Key::Meta,
            "F1" => Key::F1,
            "F2" => Key::F2,
            "F3" => Key::F3,
            "F4" => Key::F4,
            "F5" => Key::F5,
            "F6" => Key::F6,
            "F7" => Key::F7,
            "F8" => Key::F8,
            "F9" => Key::F9,
            "F10" => Key::F10,
            "F11" => Key::F11,
            "F12" => Key::F12,
            other => {
                let mut chars = other.chars();
                let first = chars.next()?;
                // Exactly one character, or it is a name nothing recognises.
                if chars.next().is_some() {
                    return None;
                }
                Key::Unicode(first)
            }
        })
    }

    /// Applies one event with a short-lived device, for a single press.
    pub fn apply(event: &RemoteEvent) -> Result<(), String> {
        Injector::new()?.apply(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_format_matches_the_phone() {
        // These strings are what `src/lib/remote.ts` actually emits. A mismatch
        // here is a control that silently does nothing.
        let move_event: RemoteEvent = serde_json::from_str(r#"{"t":"m","dx":4,"dy":-2}"#).unwrap();
        assert_eq!(move_event, RemoteEvent::Move { dx: 4, dy: -2 });

        let button: RemoteEvent =
            serde_json::from_str(r#"{"t":"b","b":"left","d":true}"#).unwrap();
        assert_eq!(button, RemoteEvent::Button { b: "left".into(), d: true });

        let key: RemoteEvent = serde_json::from_str(r#"{"t":"k","k":"ArrowUp","d":false}"#).unwrap();
        assert_eq!(key, RemoteEvent::Key { k: "ArrowUp".into(), d: false });

        let scroll: RemoteEvent = serde_json::from_str(r#"{"t":"s","dx":0,"dy":3}"#).unwrap();
        assert_eq!(scroll, RemoteEvent::Scroll { dx: 0, dy: 3 });

        let text: RemoteEvent = serde_json::from_str(r#"{"t":"x","s":"hello"}"#).unwrap();
        assert_eq!(text, RemoteEvent::Text { s: "hello".into() });
    }

    #[test]
    fn an_ordinary_event_is_allowed() {
        assert!(is_sane(&RemoteEvent::Move { dx: 12, dy: -4 }));
        assert!(is_sane(&RemoteEvent::Scroll { dx: 0, dy: 3 }));
        assert!(is_sane(&RemoteEvent::Button { b: "right".into(), d: true }));
        assert!(is_sane(&RemoteEvent::Key { k: "ArrowUp".into(), d: true }));
        assert!(is_sane(&RemoteEvent::Text { s: "hello".into() }));
    }

    #[test]
    fn a_pointer_cannot_be_flung_off_the_screen() {
        assert!(!is_sane(&RemoteEvent::Move { dx: 100_000, dy: 0 }));
        assert!(!is_sane(&RemoteEvent::Move { dx: 0, dy: -100_000 }));
        assert!(!is_sane(&RemoteEvent::Scroll { dx: 0, dy: i32::MAX }));
        // The boundary itself is fine; one past it is not.
        assert!(is_sane(&RemoteEvent::Move { dx: MAX_STEP, dy: -MAX_STEP }));
        assert!(!is_sane(&RemoteEvent::Move { dx: MAX_STEP + 1, dy: 0 }));
    }

    #[test]
    fn text_is_for_filling_in_a_field() {
        assert!(!is_sane(&RemoteEvent::Text { s: String::new() }));
        assert!(is_sane(&RemoteEvent::Text { s: "a".repeat(MAX_TEXT) }));
        assert!(!is_sane(&RemoteEvent::Text { s: "a".repeat(MAX_TEXT + 1) }));
    }

    #[test]
    fn only_the_three_buttons_exist() {
        for name in ["left", "right", "middle"] {
            assert!(is_sane(&RemoteEvent::Button { b: name.into(), d: true }), "{name}");
        }
        for name in ["", "back", "Left", "0", "../../etc"] {
            assert!(!is_sane(&RemoteEvent::Button { b: name.into(), d: true }), "{name}");
        }
    }

    #[test]
    fn a_key_name_is_short() {
        assert!(!is_sane(&RemoteEvent::Key { k: String::new(), d: true }));
        assert!(!is_sane(&RemoteEvent::Key { k: "x".repeat(33), d: true }));
    }

    /* ------------------------------------------------------------- consent */

    #[test]
    fn nobody_controls_this_machine_to_begin_with() {
        let control = Control::default();
        assert!(control.holder().is_none());
        assert!(!control.allows("any-device"));
        // Including the empty string, which is what an unidentified peer has.
        assert!(!control.allows(""));
    }

    #[test]
    fn a_grant_is_to_one_device_and_not_the_others() {
        let mut control = Control::default();
        control.grant("phone");
        assert!(control.allows("phone"));
        assert!(!control.allows("laptop"), "a grant to one let another in");
        assert_eq!(control.holder(), Some("phone"));
    }

    #[test]
    fn granting_again_moves_it_rather_than_sharing_it() {
        let mut control = Control::default();
        control.grant("phone");
        control.grant("tablet");
        assert!(control.allows("tablet"));
        assert!(!control.allows("phone"), "two devices held control at once");
    }

    #[test]
    fn revoking_ends_it_for_everyone() {
        let mut control = Control::default();
        control.grant("phone");
        control.revoke();
        assert!(!control.allows("phone"));
        assert!(control.holder().is_none());
        // And revoking again is not an error.
        control.revoke();
        assert!(control.holder().is_none());
    }

    #[test]
    fn a_link_dropping_ends_only_its_own_session() {
        let mut control = Control::default();
        control.grant("phone");

        // Somebody else's link going down must not take control away from the
        // device that has it - that would be a peer on the network able to
        // interrupt a session it is not part of.
        assert!(!control.drop_peer("laptop"));
        assert!(control.allows("phone"), "another peer's disconnect ended the session");

        assert!(control.drop_peer("phone"));
        assert!(!control.allows("phone"));
        assert!(control.holder().is_none());
    }

    #[cfg(desktop)]
    #[test]
    fn the_keys_a_phone_sends_are_all_understood() {
        use super::desktop::key_for;
        // Everything `PAD_KEYS` in remote.ts can produce, plus what a phone
        // keyboard reports. An unmapped name is a button that does nothing.
        for name in [
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Escape", "Return",
            "Enter", "Shift", "Tab", "Backspace", "Delete", "Control", "Alt", "Meta", "Home",
            "End", "PageUp", "PageDown", "F1", "F12", "a", "Z", "7", ".", "/",
        ] {
            assert!(key_for(name).is_some(), "no key for {name}");
        }
    }

    /// Actually moves this machine's pointer, and puts it back.
    ///
    /// Ignored by default because it takes over a real cursor for a few
    /// milliseconds, which is rude in the middle of somebody's work. But
    /// "the crate compiles" is not evidence that a key press reaches the
    /// operating system, and this is the only thing that is.
    #[cfg(desktop)]
    #[test]
    #[ignore = "moves the real pointer"]
    fn the_pointer_actually_moves() {
        use enigo::Mouse;

        let mut injector = Injector::new().expect("no input device");
        let before = injector.enigo.location().expect("cannot read the cursor");

        injector
            .apply(&RemoteEvent::Move { dx: 40, dy: 25 })
            .expect("the move was refused");
        std::thread::sleep(std::time::Duration::from_millis(60));
        let after = injector.enigo.location().expect("cannot read the cursor");

        // Put it back before asserting, so a failure does not also leave the
        // cursor somewhere the person did not put it.
        let _ = injector.apply(&RemoteEvent::Move { dx: -40, dy: -25 });

        assert_eq!(
            (after.0 - before.0, after.1 - before.1),
            (40, 25),
            "asked for +40,+25 and got {before:?} -> {after:?}",
        );
    }

    #[cfg(desktop)]
    #[test]
    fn and_a_name_that_is_not_a_key_is_refused() {
        use super::desktop::key_for;
        for name in ["", "NoSuchKey", "ArrowUpp", "ctrl+c"] {
            assert!(key_for(name).is_none(), "{name} was accepted as a key");
        }
    }
}
