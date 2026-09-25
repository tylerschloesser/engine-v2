//! `landmarks_fixture_current` (docs/plan/20-reference-game-v0.md Provides, Planning decisions
//! "Landmarks fixture"): recomputes the nearest land tile and the nearest tile of each resource to
//! the origin from `RefWorldgen` at `TEST_SEED`, and fails -- naming the fixture to update -- if
//! `../tests/fixtures/landmarks.json` (this crate's `CARGO_MANIFEST_DIR` is `games/reference/sim`,
//! so `tests/fixtures/` one level up is `games/reference/tests/fixtures/`, shared with the browser
//! suite) has drifted from what the generator now produces.

mod common;

use std::collections::BTreeMap;

use common::TEST_SEED;
use engine::game::Game;
use engine::world::{ChunkCoord, Tile};
use engine::worldgen::Worldgen;
use reference_sim::{RefGame, RefParams, RefWorldgen, content};

/// Chunks either side of the origin to search (Chebyshev radius in chunks): comfortably covers
/// every landmark this seed actually has (measured: all five within 16 tiles), while staying cheap
/// (`4*2 = 8` chunks per axis, 64 chunks, ~65k tile generations).
const SEARCH_CHUNK_RADIUS: i32 = 4;

fn edge() -> i32 {
    1 << <RefGame as Game>::CHUNK_BITS
}

/// Nearest-by-squared-distance-to-origin tile matching `want`, scanning every tile in the search
/// window (raster order, so the first minimum found in a tie is the lexically smallest `(y, x)` --
/// deterministic regardless of tie frequency, though none of this seed's own landmarks tie).
fn nearest(seed: u64, params: &RefParams, edge: i32, want: impl Fn(Tile) -> bool) -> (i32, i32) {
    let mut cache: BTreeMap<(i32, i32), Vec<Tile>> = BTreeMap::new();
    let mut best: Option<(i64, i32, i32)> = None;
    for cy in -SEARCH_CHUNK_RADIUS..SEARCH_CHUNK_RADIUS {
        for cx in -SEARCH_CHUNK_RADIUS..SEARCH_CHUNK_RADIUS {
            let tiles = cache.entry((cx, cy)).or_insert_with(|| {
                let mut out = vec![Tile::new(0, 0, 0); (edge * edge) as usize];
                RefWorldgen::generate(seed, params, ChunkCoord::new(cx, cy), &mut out);
                out
            });
            for ly in 0..edge {
                for lx in 0..edge {
                    let t = tiles[(ly * edge + lx) as usize];
                    if !want(t) {
                        continue;
                    }
                    let x = cx * edge + lx;
                    let y = cy * edge + ly;
                    let d = (x as i64) * (x as i64) + (y as i64) * (y as i64);
                    if best.is_none_or(|(bd, _, _)| d < bd) {
                        best = Some((d, x, y));
                    }
                }
            }
        }
    }
    let (_, x, y) = best.expect("no matching tile found within SEARCH_CHUNK_RADIUS");
    (x, y)
}

fn xy(v: &serde_json::Value) -> (i32, i32) {
    (
        v["x"].as_i64().unwrap() as i32,
        v["y"].as_i64().unwrap() as i32,
    )
}

#[test]
fn landmarks_fixture_current() {
    let params = RefParams::default();
    let edge = edge();

    let land = nearest(TEST_SEED, &params, edge, |t| {
        t.base() != content::DEEP_WATER && t.base() != content::WATER
    });
    let iron = nearest(TEST_SEED, &params, edge, |t| t.resource() == content::IRON);
    let wood = nearest(TEST_SEED, &params, edge, |t| t.resource() == content::WOOD);
    let stone = nearest(TEST_SEED, &params, edge, |t| t.resource() == content::STONE);
    let coal = nearest(TEST_SEED, &params, edge, |t| t.resource() == content::COAL);

    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/landmarks.json"
    ))
    .expect("games/reference/tests/fixtures/landmarks.json must exist");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();

    assert_eq!(TEST_SEED.to_string(), json["seed"].as_str().unwrap());
    assert_eq!(
        land,
        xy(&json["land"]),
        "nearest land tile drifted -- regenerate games/reference/tests/fixtures/landmarks.json"
    );
    assert_eq!(
        iron,
        xy(&json["resources"]["iron"]),
        "nearest iron tile drifted -- regenerate games/reference/tests/fixtures/landmarks.json"
    );
    assert_eq!(
        wood,
        xy(&json["resources"]["wood"]),
        "nearest wood tile drifted -- regenerate games/reference/tests/fixtures/landmarks.json"
    );
    assert_eq!(
        stone,
        xy(&json["resources"]["stone"]),
        "nearest stone tile drifted -- regenerate games/reference/tests/fixtures/landmarks.json"
    );
    assert_eq!(
        coal,
        xy(&json["resources"]["coal"]),
        "nearest coal tile drifted -- regenerate games/reference/tests/fixtures/landmarks.json"
    );
}
