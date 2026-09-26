//! `migrate_hz_change_rescales_engine_timers` (docs/plan/24b-upgrade-and-migration.md Tests
//! added): `fx-migrate-v1` (schema 1, 20Hz) into `fx-migrate-v2-hz30` (schema 2, 30Hz) -- a schema
//! bump *and* a tick-rate change at once, so the engine's own timer-wheel carry must go through
//! `Rescale::deadline`, not the identity path `fx-migrate-v2`'s own same-rate test exercises.
//!
//! No `#[global_allocator]` here for the same reason as `fx-migrate-v2`'s own cross-fixture test:
//! `fx_migrate_v2_hz30::export_game!` already installs one, and `fx-migrate-v1` is a dependency
//! only under its `as_dependency` feature (skips its own `export_game!`).

use engine::bytes::{ByteReader, ByteSink};
use engine::game::{EntityId, Game, PlayerEvent, PlayerId};
use engine::migrate::OldStore;
use engine::sim::{Record, Sim, WorldParams};
use engine::time::Tick;
use engine::world::{CacheCapacity, ChunkDims, TerrainStore};
use engine::worldgen::Pristine;
use fx_migrate_v1::{Action as V1Action, Pos as V1Pos, V1};
use fx_migrate_v2_hz30::V2Game;

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

#[test]
fn migrate_hz_change_rescales_engine_timers() {
    let mut sim = Sim::<V1>::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 10_000,
        max_modified_tiles: 10_000,
        max_action_growth: 100,
    });
    let mut out = Vec::new();
    sim.step(
        &[Record::Player {
            who: PlayerId(1),
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    // Spawned while processing at tick 1 (the `Joined` record's own step already advanced tick
    // 0 -> 1): `next_woken` schedules `wake_at(1 + Ticks(10)) = Tick(11)`.
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: V1Action::PlaceTimer {
                at: V1Pos { x: 1, y: 1 },
                period: 10,
                keep: true,
            },
        }],
        &mut out,
    );
    let tick = sim.tick();
    assert_eq!(tick, Tick(2));

    let mut bytes = Vec::new();
    sim.authority().store().encode(&mut VecSink(&mut bytes));

    let mut reader = ByteReader::new(&bytes);
    let old = OldStore::decode(
        &mut reader,
        1,
        V1::TICK_RATE.hz_value(),
        V2Game::TICK_RATE.hz_value(),
        tick,
        V2Game::CHUNK_BITS,
    )
    .expect("well-formed old store bytes");
    assert_eq!(V1::TICK_RATE.hz_value(), 20);
    assert_eq!(V2Game::TICK_RATE.hz_value(), 30);

    let terrain = TerrainStore::new(
        ChunkDims::new(V2Game::CHUNK_BITS),
        Box::new(Pristine::<<V2Game as Game>::Worldgen>::new(1, ())),
        CacheCapacity::Chunks(4),
    );
    let (authority, outcome) =
        engine::migrate::migrate::<V2Game>(old, terrain, tick, sim.authority().rng())
            .expect("migrate succeeds");
    assert_eq!(outcome.dropped_timers, 0);

    // Old deadline Tick(11), snapshot tick 2: distance 9 old-ticks at 20Hz -> 9*30/20 = 13.5
    // new-ticks, rounded to nearest with ties up (0006 Conversion rule) -> 14 -> Tick(2 + 14) =
    // Tick(16).
    let mut sim = Sim::from_parts(authority);
    let mut out = Vec::new();
    while sim.tick() < Tick(16) {
        sim.step(&[], &mut out);
        assert_eq!(
            sim.authority().store().entity(EntityId(1)).unwrap().fires,
            0,
            "must not fire before the rescaled deadline (tick {:?})",
            sim.tick()
        );
    }
    sim.step(&[], &mut out); // processed at tick 16: due now.
    assert_eq!(
        sim.authority().store().entity(EntityId(1)).unwrap().fires,
        1
    );
}
