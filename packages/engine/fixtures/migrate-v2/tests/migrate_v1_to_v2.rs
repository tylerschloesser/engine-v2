//! Native v1 -> v2 migration, both game types in one test binary (docs/plan/
//! 24b-upgrade-and-migration.md Order of work 3): `fx-migrate-v1` (schema 1) builds a real old
//! world and encodes it exactly as a snapshot's own store-section bytes would be; `fx-migrate-v2`
//! (schema 2, same 20Hz tick rate) brings it forward through `engine::migrate::migrate`.
//!
//! No `#[global_allocator]` here: `fx_migrate_v2::export_game!` already installs
//! `engine::abi::Arena` as this binary's one allocator (a library's global allocator applies to
//! any binary that links it -- `fixtures/machines/tests/journal_bench.rs`'s own precedent, and
//! exactly why `fx-migrate-v1` is a dev-dependency here only under its `as_dependency` feature,
//! which skips its own `export_game!`/second allocator). `migrate_v1_to_v2_preserves_ids_and_
//! occupancy` reads that allocator's counters for the Budgets "peak arena use <= old + new store
//! sizes" check.

use engine::bytes::{ByteReader, ByteSink};
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, SaveIncompatible, WorldWrite};
use engine::migrate::OldStore;
use engine::sim::{Record, Sim, WorldParams};
use engine::time::Tick;
use engine::world::{CacheCapacity, ChunkDims, TerrainStore, Tile, TilePos};
use engine::worldgen::Pristine;
use fx_migrate_v1::{Action as V1Action, Pos as V1Pos, V1};
use fx_migrate_v2::V2Game;

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

fn old_params(seed: u64) -> WorldParams<V1> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 10_000,
        max_modified_tiles: 10_000,
        max_action_growth: 100,
    }
}

/// Builds a `Sim<V1>` with: player 1 joined and one `Deposit` (seq 1, so `last_seq` carries a
/// real, non-default value); entity 1 kept by `migrate` (pos (1,1), period 10 old-ticks); entity 2
/// dropped (pos (2,2), period 20); two tile overlays for `carry_tiles` -- (0,0) set to the value
/// `fx-migrate-v2`'s own pristine will generate there (dropped by canonicalisation), (5,5) set to a
/// value neither build's pristine ever produces (kept).
fn build_two_entity_world(seed: u64) -> Sim<V1> {
    let mut sim = Sim::<V1>::genesis(old_params(seed));
    let mut out = Vec::new();
    sim.step(
        &[Record::Player {
            who: PlayerId(1),
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: V1Action::Deposit,
        }],
        &mut out,
    );
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: V1Action::PlaceTimer {
                at: V1Pos { x: 1, y: 1 },
                period: 10,
                keep: true,
            },
        }],
        &mut out,
    );
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: V1Action::PlaceTimer {
                at: V1Pos { x: 2, y: 2 },
                period: 20,
                keep: false,
            },
        }],
        &mut out,
    );
    // fx-migrate-v2's own pristine (`FlatWorldgen`) is `Tile::new(1, 0, 0)` everywhere: this entry
    // becomes redundant the moment `carry_tiles` runs against the new build.
    sim.authority_mut()
        .set_tile(TilePos::new(0, 0), Tile::new(1, 0, 0));
    // Neither build's pristine ever produces this value (fx-migrate-v1's own is `Tile::new(3, 0,
    // 0)`, fx-migrate-v2's is `Tile::new(1, 0, 0)`): must survive `carry_tiles`.
    sim.authority_mut()
        .set_tile(TilePos::new(5, 5), Tile::new(9, 0, 0));
    sim
}

fn encode(sim: &Sim<V1>) -> Vec<u8> {
    let mut bytes = Vec::new();
    sim.authority().store().encode(&mut VecSink(&mut bytes));
    bytes
}

fn new_v2_terrain(seed: u64) -> TerrainStore {
    TerrainStore::new(
        ChunkDims::new(V2Game::CHUNK_BITS),
        Box::new(Pristine::<<V2Game as Game>::Worldgen>::new(seed, ())),
        // Small on purpose (unlike production's 1,024-chunk default, `sim::DEFAULT_CACHE_CHUNKS`):
        // a big cache pool's own fixed reservation would dwarf the migration's own footprint and
        // make the peak-use assertion below trivially true regardless of whether `migrate` leaks.
        CacheCapacity::Chunks(4),
    )
}

fn decode_old(bytes: &[u8], tick: Tick) -> OldStore {
    let mut reader = ByteReader::new(bytes);
    OldStore::decode(
        &mut reader,
        1,
        V1::TICK_RATE.hz_value(),
        V2Game::TICK_RATE.hz_value(),
        tick,
        V2Game::CHUNK_BITS,
    )
    .expect("well-formed old store bytes")
}

#[test]
fn migrate_v1_to_v2_preserves_ids_and_occupancy() {
    let sim = build_two_entity_world(1);
    let tick = sim.tick();
    let rng = sim.authority().rng();
    let bytes = encode(&sim);
    assert_eq!(tick, Tick(4), "four steps from genesis");

    let base = engine::abi::arena::live_bytes();
    let before_decode = engine::abi::arena::live_bytes();
    let old = decode_old(&bytes, tick);
    let old_store_live = engine::abi::arena::live_bytes().saturating_sub(before_decode);

    let terrain = new_v2_terrain(1);
    let high_before_migrate = engine::abi::arena::high_water_bytes();
    let (authority, outcome) =
        engine::migrate::migrate::<V2Game>(old, terrain, tick, rng).expect("migrate succeeds");
    let high_after_migrate = engine::abi::arena::high_water_bytes();
    let peak_during_migrate = high_after_migrate.saturating_sub(high_before_migrate);
    let new_store_live = engine::abi::arena::live_bytes().saturating_sub(base);

    // Budgets "Memory per instance": old and new stores coexist inside one fixed arena (0015);
    // the peak reached while `migrate` ran must not exceed each store's own measured live
    // footprint added together (drain semantics free old bytes as `migrate` consumes them, so in
    // practice the real peak is well under this sum -- see this milestone's Deviations for the
    // measured numbers and the "prove it can fail" experiment).
    assert!(
        peak_during_migrate <= old_store_live + new_store_live,
        "peak_during_migrate={peak_during_migrate} old_store_live={old_store_live} \
         new_store_live={new_store_live}"
    );

    // Ids and occupancy (Planning decisions 3/4).
    assert!(authority.store().entity(EntityId(1)).is_some(), "kept");
    assert!(authority.store().entity(EntityId(2)).is_none(), "dropped");
    assert_eq!(
        authority.store().entity_at(TilePos::new(1, 1)),
        Some(EntityId(1))
    );
    assert_eq!(authority.store().entity_at(TilePos::new(2, 2)), None);
    assert_eq!(
        authority.store().next_entity_id(),
        3,
        "carried counter: the next spawn allocates above every old id, kept or not"
    );

    // Player table + last processed seq (Planning decisions 3: engine-carried).
    let slot = authority
        .store()
        .player_slot(PlayerId(1))
        .expect("player 1 carried");
    // `last_seq` is "last processed", not "last Deposit": every record `record_ack`s player 1,
    // including the two `PlaceTimer` actions after the `Deposit` (seq 1, 2, 3 in that order).
    assert_eq!(
        slot.last_seq, 3,
        "last_seq carried from the old player table"
    );
    assert_eq!(slot.state.deposits, 1, "migrate's own put_player value");

    // Dropped-registration accounting (entity 2's timer never re-created).
    assert_eq!(outcome.dropped_timers, 1);
}

#[test]
fn migrate_drops_timers_of_dropped_entities() {
    let sim = build_two_entity_world(2);
    let tick = sim.tick();
    let rng = sim.authority().rng();
    let bytes = encode(&sim);
    let old = decode_old(&bytes, tick);
    let terrain = new_v2_terrain(2);

    let (authority, outcome) =
        engine::migrate::migrate::<V2Game>(old, terrain, tick, rng).expect("migrate succeeds");

    // Only entity 1's timer survives (`timers_pending` is public, Provides).
    assert_eq!(authority.store().timers_pending(), 1);
    assert_eq!(outcome.dropped_timers, 1);

    // Running the migrated world forward must never observe entity 2 (it does not exist) and must
    // fire entity 1's timer at its old, unrescaled deadline (identity rescale: same 20Hz on both
    // sides).
    let mut sim = Sim::from_parts(authority);
    let mut out = Vec::new();
    // Old deadline: spawned at tick 2, `wake_at(tick + Ticks(10))` = Tick(12).
    while sim.tick() < Tick(12) {
        sim.step(&[], &mut out);
    }
    assert_eq!(
        sim.authority().store().entity(EntityId(1)).unwrap().fires,
        0
    );
    sim.step(&[], &mut out); // processed at tick 12: due now.
    assert_eq!(
        sim.authority().store().entity(EntityId(1)).unwrap().fires,
        1
    );
}

#[test]
fn carry_tiles_canonicalises_against_new_pristine() {
    let sim = build_two_entity_world(3);
    let tick = sim.tick();
    let rng = sim.authority().rng();
    let bytes = encode(&sim);
    let old = decode_old(&bytes, tick);
    let terrain = new_v2_terrain(3);

    let (authority, _outcome) =
        engine::migrate::migrate::<V2Game>(old, terrain, tick, rng).expect("migrate succeeds");

    // (0,0) now equals the new build's own pristine value: dropped, not re-stored as an overlay.
    // (5,5) still differs: kept. `modified_tile_count` (public) counts overlay entries only.
    assert_eq!(
        authority.store().modified_tile_count(),
        1,
        "only (5,5) remains a real overlay entry"
    );
    assert_eq!(
        authority.store().terrain().tile(TilePos::new(0, 0)),
        Tile::new(1, 0, 0)
    );
    assert_eq!(
        authority.store().terrain().tile(TilePos::new(5, 5)),
        Tile::new(9, 0, 0)
    );
}

#[test]
fn migrating_footprint_collision_is_incompatible() {
    let mut sim = Sim::<V1>::genesis(old_params(4));
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: V1Action::PlaceTimer {
                at: V1Pos { x: 7, y: 7 },
                period: 10,
                keep: true,
            },
        }],
        &mut out,
    );
    // Same tile, also kept: `fx-migrate-v2`'s own `migrate` will `put_entity` both under their old
    // ids, colliding on the second insert (Planning decisions 4).
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: V1Action::PlaceTimer {
                at: V1Pos { x: 7, y: 7 },
                period: 10,
                keep: true,
            },
        }],
        &mut out,
    );
    let tick = sim.tick();
    let rng = sim.authority().rng();
    let bytes = encode(&sim);
    let old = decode_old(&bytes, tick);
    let terrain = new_v2_terrain(4);

    let result = engine::migrate::migrate::<V2Game>(old, terrain, tick, rng);
    assert_eq!(result.err(), Some(SaveIncompatible));
}
