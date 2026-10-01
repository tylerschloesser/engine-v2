//! The standard large save (docs/decisions/0020 section 9; docs/plan/36-slow-tier-and-benchmarks.md
//! step 3): `reference_sim::bench::standard_large_save`, reached through `RefGame::genesis` when the
//! worldgen params carry the bench marker (`RefParams::bench`). `large_save_builder_is_deterministic`
//! is the fast 1/64-scale guard against rot; `slow_large_save_counts_and_determinism` asserts the
//! full-scale figures of section 9, computed from the `WorldConfig` defaults (0007 section 8's shares).
//! Needs the `bench` feature, which this crate's self dev-dependency turns on for its tests.

use std::collections::BTreeSet;

use engine::sim::{Sim, WorldParams};
use engine::time::Tick;
use reference_sim::bench::{
    ENTITIES_PER_CHUNK, ENTITY_SHARE_BYTES, MODIFIED_PER_CHUNK, NOMINAL_ENTITY_BYTES,
    OVERLAY_ENTRY_BYTES, OVERLAY_SHARE_BYTES, Shape,
};
use reference_sim::{RefGame, RefParams, content};

/// The `WorldConfig` defaults of `host::SimConfig` (`default_max_entities` and the following two),
/// written out here so the builder's own `Shape::FULL` is checked against them, not against itself.
const DEFAULT_MAX_ENTITIES: u32 = 262_144;
const DEFAULT_MAX_MODIFIED_TILES: u32 = 1_048_576;
const DEFAULT_MAX_ACTION_GROWTH: u32 = 4_096;

fn params(seed: u64, scale: u32) -> WorldParams<RefGame> {
    WorldParams {
        seed,
        worldgen: RefParams {
            bench: scale,
            ..RefParams::default()
        },
        max_entities: DEFAULT_MAX_ENTITIES / scale,
        max_modified_tiles: DEFAULT_MAX_MODIFIED_TILES / scale,
        max_action_growth: DEFAULT_MAX_ACTION_GROWTH,
    }
}

/// Entities, entity-bearing chunks, modified tiles, modified chunks of a built world.
fn counts(sim: &Sim<RefGame>) -> (u32, u32, u32, u32) {
    let store = sim.authority().store();
    let chunks: BTreeSet<(i32, i32)> = store
        .entities()
        .map(|(_, f)| (f.origin.x >> 5, f.origin.y >> 5))
        .collect();
    (
        store.entity_count(),
        chunks.len() as u32,
        store.modified_tile_count(),
        store.terrain().overlay_chunks().count() as u32,
    )
}

/// Furnaces per `smelt_done_at` phase (`(deadline - 2) % SMELT`).
fn phase_histogram(sim: &Sim<RefGame>) -> Vec<u32> {
    let mut h = vec![0u32; content::SMELT.0 as usize];
    for (_, f) in sim.authority().store().entities() {
        let Tick(d) = f
            .smelt_done_at
            .expect("every bench furnace carries a deadline");
        let n = h.len();
        h[(d - 2) as usize % n] += 1;
    }
    h
}

fn assert_uniform(h: &[u32], total: u32) {
    let (lo, hi) = (total / h.len() as u32, total.div_ceil(h.len() as u32));
    assert!(
        h.iter().all(|&n| n == lo || n == hi),
        "timers must be uniformly staggered over {} ticks: {lo}..={hi} per phase, got {h:?}",
        h.len()
    );
}

#[test]
fn shape_full_is_the_section_9_figures() {
    assert_eq!(Shape::FULL.entities, DEFAULT_MAX_ENTITIES);
    assert_eq!(Shape::FULL.modified_tiles, DEFAULT_MAX_MODIFIED_TILES);
    assert_eq!(ENTITY_SHARE_BYTES / NOMINAL_ENTITY_BYTES, 262_144);
    assert_eq!(OVERLAY_SHARE_BYTES / OVERLAY_ENTRY_BYTES, 1_048_576);
    // 0020 section 9: 262,144 / 200 = 1,311 chunks with entities; 1,048,576 / 256 = 4,096 modified.
    assert_eq!(Shape::FULL.entity_chunks(), 1_311);
    assert_eq!(Shape::FULL.modified_chunks(), 4_096);
}

#[test]
fn large_save_builder_is_deterministic() {
    const SCALE: u32 = 64;
    let shape = Shape::scaled(SCALE);
    let a = Sim::<RefGame>::genesis(params(7, SCALE));
    let b = Sim::<RefGame>::genesis(params(7, SCALE));
    let other = Sim::<RefGame>::genesis(params(8, SCALE));

    let want = (
        DEFAULT_MAX_ENTITIES / SCALE,
        (DEFAULT_MAX_ENTITIES / SCALE).div_ceil(ENTITIES_PER_CHUNK),
        DEFAULT_MAX_MODIFIED_TILES / SCALE,
        (DEFAULT_MAX_MODIFIED_TILES / SCALE).div_ceil(MODIFIED_PER_CHUNK),
    );
    assert_eq!(
        counts(&a),
        want,
        "entities, entity chunks, modified tiles, modified chunks"
    );
    assert_eq!((shape.entities, shape.modified_tiles), (want.0, want.2));
    assert!(
        a.authority().changes().is_empty(),
        "genesis writes are not logged (ADR 0046): the large save would hold ~210 MB of them"
    );
    assert_eq!(a.state_hash(), b.state_hash(), "one seed, one world");
    assert_ne!(
        a.state_hash(),
        other.state_hash(),
        "the seed reaches the timers"
    );
    assert_uniform(&phase_histogram(&a), want.0);

    let mut sim = a;
    // A genesis-armed timer fires at its deadline: the earliest furnace has made no ingot on the
    // tick before its `smelt_done_at` and one on it.
    let first = sim
        .authority()
        .store()
        .entities()
        .min_by_key(|(_, f)| f.smelt_done_at)
        .map(|(id, f)| (id, f.smelt_done_at.unwrap()))
        .unwrap();
    let ingots = |s: &Sim<RefGame>| s.authority().store().entity(first.0).unwrap().ingots_out;
    let mut out0 = Vec::new();
    while sim.tick().0 + 1 < first.1.0 {
        sim.step(&[], &mut out0);
    }
    assert_eq!(ingots(&sim), 0);
    sim.step(&[], &mut out0);
    sim.step(&[], &mut out0);
    assert_eq!(
        ingots(&sim),
        1,
        "armed at {:?}, tick now {:?}",
        first.1,
        sim.tick()
    );

    // The timers fire: after the first-wake re-arm every tick completes its share of furnaces
    // (4,096 / 100 = 40.96 per tick), none are lost, and each completion is one visit.
    let mut out = Vec::new();
    let mut visited = Vec::new();
    for _ in 0..260 {
        sim.step(&[], &mut out);
        visited.push(sim.authority().entities_visited_per_tick());
    }
    for (t, &v) in visited.iter().enumerate().skip(110) {
        assert!(
            (40..=42).contains(&v),
            "tick {t}: {v} furnaces visited, want about 41"
        );
    }
}

#[test]
fn slow_large_save_counts_and_determinism() {
    let a = Sim::<RefGame>::genesis(params(7, 1));
    assert_eq!(
        counts(&a),
        (262_144, 1_311, 1_048_576, 4_096),
        "section 9: furnaces, chunks with entities, depleted tiles, modified chunks"
    );
    assert_uniform(&phase_histogram(&a), 262_144);
    let b = Sim::<RefGame>::genesis(params(7, 1));
    assert_eq!(
        a.state_hash(),
        b.state_hash(),
        "two builds from one seed hash equal"
    );
}
