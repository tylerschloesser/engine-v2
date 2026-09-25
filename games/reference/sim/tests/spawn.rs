//! `spawn_is_nearest_land_tile` (docs/plan/20b-reference-player-and-collect-ui.md Tests added, step
//! 5): `RefClient`'s own spawn rule (`client::nearest_land_tile`, a pure spiral search over
//! `RefWorldgen`'s per-tile terrain function, no engine read) against `../tests/fixtures/
//! landmarks.json`'s own `land` field -- the same fixture `landmarks_fixture.rs` keeps current by an
//! independent full-chunk scan, so this test would fail by name if the spiral and the scan ever
//! disagreed about which tile is nearest.

mod common;

use common::TEST_SEED;
use engine::client::ClientSide;
use engine::world::{ChunkCoord, Tile, TilePos};
use engine::worldgen::Worldgen;
use reference_sim::{RefClient, RefParams, RefWorldgen, client::nearest_land_tile};

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

/// `spawn_alt_params_is_nearest_land_tile` (gate round 1 fix, docs/plan/
/// 20b-reference-player-and-collect-ui.md Deviations): guards `../tests/fixtures/
/// spawn-alt-params.json` the same way `landmarks_fixture.rs` guards `landmarks.json` -- an
/// independent full-chunk scan (`RefWorldgen::generate`, never `nearest_land_tile` itself), failing
/// by name with a regenerate instruction if the fixture drifts -- and separately asserts both the
/// real spiral (`client::nearest_land_tile`) and the real engine hook (`ClientSide::on_init`) against
/// the *same* fixture. `water_level` (`0.05`, raised from the default `-0.05` -- enough that
/// `TEST_SEED`'s own height-channel value of exactly `0.0` at the origin now reads as water) lives
/// only in the fixture and in `test-entry.ts`'s own `?altSpawnParams` literal; this assertion is what
/// keeps the two in sync if either drifts.
#[test]
fn spawn_alt_params_is_nearest_land_tile() {
    const EDGE: i32 = 32;
    const SEARCH_CHUNK_RADIUS: i32 = 2;

    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/spawn-alt-params.json"
    ))
    .expect("games/reference/tests/fixtures/spawn-alt-params.json must exist");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(TEST_SEED.to_string(), json["seed"].as_str().unwrap());
    let water_level = json["water_level"].as_f64().unwrap();
    assert_eq!(
        water_level, 0.05,
        "keep this in sync with client.rs's own override literal"
    );
    let (want_x, want_y) = xy(&json["land"]);

    let params = RefParams {
        water_level,
        ..RefParams::default()
    };

    // Independent full-chunk scan (`landmarks_fixture.rs`'s own `nearest()` shape), never the
    // spiral under test.
    let mut best: Option<(i64, i32, i32)> = None;
    for cy in -SEARCH_CHUNK_RADIUS..SEARCH_CHUNK_RADIUS {
        for cx in -SEARCH_CHUNK_RADIUS..SEARCH_CHUNK_RADIUS {
            let mut tiles = vec![Tile::new(0, 0, 0); (EDGE * EDGE) as usize];
            RefWorldgen::generate(TEST_SEED, &params, ChunkCoord::new(cx, cy), &mut tiles);
            for ly in 0..EDGE {
                for lx in 0..EDGE {
                    let t = tiles[(ly * EDGE + lx) as usize];
                    if t.base() == 0 || t.base() == 1 {
                        continue; // DEEP_WATER, WATER: not land.
                    }
                    let x = cx * EDGE + lx;
                    let y = cy * EDGE + ly;
                    let d = (x as i64) * (x as i64) + (y as i64) * (y as i64);
                    if best.is_none_or(|(bd, _, _)| d < bd) {
                        best = Some((d, x, y));
                    }
                }
            }
        }
    }
    let (_, scan_x, scan_y) = best.expect("no land tile found within SEARCH_CHUNK_RADIUS");
    assert_eq!(
        (scan_x, scan_y),
        (want_x, want_y),
        "nearest land tile under the alt params drifted -- regenerate games/reference/tests/\
         fixtures/spawn-alt-params.json"
    );

    let spiral = nearest_land_tile(TEST_SEED, &params);
    assert_eq!(
        spiral,
        TilePos::new(want_x, want_y),
        "the spiral (client::nearest_land_tile) disagrees with the independent scan"
    );

    // `ClientSide::on_init` (gate round 1 fix): the engine hook a real WASM instance calls once,
    // right after `Default::default()`, with the seed/params its own world was actually created
    // with -- proves the *hook*, not just the underlying `nearest_land_tile` function, updates
    // `Ui.spawn`'s own source correctly.
    let mut client = RefClient::default();
    client.on_init(TEST_SEED, &params);
    assert_eq!(
        client.spawn(),
        reference_sim::TileXY {
            x: want_x,
            y: want_y
        }
    );
}
