//! 0003 "Plain data types": the reference game's `Action`, `Entity` and `Player` are plain data, so
//! none of them can hold a `Vec`, `String` or `Box`. Two checks that fail if one does: the `Copy`
//! bound is a compile error for an owning field, and `needs_drop` is false only for a type with no
//! owning field anywhere inside it (nothing in a `Copy` type can need drop, so the second also
//! catches a hand-written `Drop` added beside a removed `Copy`).

use engine::game::Game;
use reference_sim::RefGame;

fn assert_plain<T: Copy>(what: &str) {
    assert!(
        !std::mem::needs_drop::<T>(),
        "{what} owns heap data (0003: plain data, no Vec, String or Box)"
    );
}

#[test]
fn reference_action_entity_player_are_plain_data() {
    assert_plain::<<RefGame as Game>::Action>("Action");
    assert_plain::<<RefGame as Game>::Entity>("Entity");
    assert_plain::<<RefGame as Game>::Player>("Player");
}
