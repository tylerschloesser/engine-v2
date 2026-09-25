//! `spawn_is_nearest_land_tile` (docs/plan/20b-reference-player-and-collect-ui.md Tests added, step
//! 5): `RefClient`'s own spawn rule (`client::nearest_land_tile`, a pure spiral search over
//! `RefWorldgen`'s per-tile terrain function, no engine read) against `../tests/fixtures/
//! landmarks.json`'s own `land` field -- the same fixture `landmarks_fixture.rs` keeps current by an
//! independent full-chunk scan, so this test would fail by name if the spiral and the scan ever
//! disagreed about which tile is nearest.

mod common;

use common::TEST_SEED;
use engine::world::TilePos;
use reference_sim::{RefParams, client::nearest_land_tile};

fn xy(v: &serde_json::Value) -> (i32, i32) {
    (
        v["x"].as_i64().unwrap() as i32,
        v["y"].as_i64().unwrap() as i32,
    )
}

#[test]
fn spawn_is_nearest_land_tile() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/landmarks.json"
    ))
    .expect("games/reference/tests/fixtures/landmarks.json must exist");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(TEST_SEED.to_string(), json["seed"].as_str().unwrap());
    let (want_x, want_y) = xy(&json["land"]);

    let spawn = nearest_land_tile(TEST_SEED, &RefParams::default());
    assert_eq!(spawn, TilePos::new(want_x, want_y));
}
