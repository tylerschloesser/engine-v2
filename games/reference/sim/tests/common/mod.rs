//! Shared native test support (M20 Provides: "native test helper
//! `sim/tests/common/mod.rs::RefScenario`"). `#![allow(dead_code)]`: each `tests/*.rs` file is its
//! own binary that includes this module whole, so a helper only some of them call (e.g. `landmarks_
//! fixture.rs` uses neither `RefScenario` nor most of its methods) would otherwise warn -- and
//! `pnpm lint`'s `-D warnings` would fail the build over an unused method in a *different* test
//! binary's copy of this shared file.
#![allow(dead_code)]

use engine::game::{PlayerEvent, PlayerId, WorldRead, WorldWrite};
use engine::sim::{Record, Rejected, Sim, WorldParams};
use engine::world::{Tile, TilePos, TileRect};
use reference_sim::{RefAction, RefGame, RefParams, RefPlayer, RefReject, TileXY};

/// The one seed every native test in this crate shares (Provides: "the `TEST_SEED` value") --
/// `reference_sim::content::SEED` (M20b step 5 Deviations) is now the single source of that literal;
/// this alias keeps every existing test's own `TEST_SEED` reference unchanged.
pub const TEST_SEED: u64 = reference_sim::content::SEED;

/// A fresh `Sim<RefGame>` plus a per-player `seq` counter, so a test can `join`/`dispatch`/
/// `step_ticks` without repeating `Sim::genesis`/`Sim::step` plumbing (Provides: "new world, join a
/// player, dispatch, step ticks, read player and tile, state hash").
pub struct RefScenario {
    sim: Sim<RefGame>,
    out: Vec<engine::sim::Outcome<RefGame>>,
    seqs: std::collections::BTreeMap<PlayerId, u32>,
}

impl RefScenario {
    /// A fresh world at [`TEST_SEED`] with default `RefParams` -- the same seed and params
    /// `src/main.ts` uses, so a native test's landmark tiles are what a player actually sees.
    pub fn new() -> Self {
        RefScenario {
            sim: Sim::genesis(WorldParams {
                seed: TEST_SEED,
                worldgen: RefParams::default(),
                // Was `0`: an inert placeholder while the state-budget check was Non-scope
                // (M12b/M15). M21 makes it real, so this native test harness needs a genuine
                // headroom figure -- 0007 §8's own default -- instead of a value that would now
                // reject every entity-creating action as `StateBudgetFull`.
                max_entities: 262_144,
                max_modified_tiles: 1_048_576,
                max_action_growth: 4_096,
            }),
            out: Vec::new(),
            seqs: std::collections::BTreeMap::new(),
        }
    }

    pub fn join(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Joined,
            }],
            &mut self.out,
        );
    }

    /// Dispatches `action` for `who` (auto-incrementing `who`'s own `seq`) and steps one tick,
    /// returning the sim's own verdict.
    pub fn dispatch(&mut self, who: PlayerId, action: RefAction) -> Result<(), RefReject> {
        let seq = {
            let s = self.seqs.entry(who).or_insert(0);
            *s += 1;
            *s
        };
        self.sim
            .step(&[Record::Action { who, seq, action }], &mut self.out);
        match &self.out[0].result {
            Ok(_) => Ok(()),
            Err(Rejected::Game(r)) => Err(*r),
            Err(Rejected::Engine(e)) => panic!("unexpected engine reject: {e:?}"),
        }
    }

    /// Logs a `Disconnected` event for `who` (0004: connection events are logged records, so a
    /// replay cancels the same collect at the same tick).
    pub fn disconnect(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Disconnected,
            }],
            &mut self.out,
        );
    }

    /// Logs a `Connected` event for `who`.
    pub fn connect(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Connected,
            }],
            &mut self.out,
        );
    }

    /// Grants `n` of `item` with a direct player put (native-test-only, like [`Self::set_tile`]:
    /// not an action, not in the `.wasm`), so a test need not replay hundreds of collect ticks.
    pub fn give(&mut self, who: PlayerId, item: reference_sim::content::ItemId, n: u32) {
        let mut p = self.player(who);
        p.inventory.add(item, n);
        self.sim.authority_mut().put_player(who, p);
    }

    /// `PlaceFurnace { origin }` for `who` (Provides: `RefScenario::place(player, origin)`).
    pub fn place(&mut self, who: PlayerId, origin: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::PlaceFurnace {
                origin: TileXY::from_tile(origin),
            },
        )
    }

    /// `FurnaceDeposit { at, item, count }` for `who` (Provides: `RefScenario::deposit`).
    pub fn deposit(
        &mut self,
        who: PlayerId,
        at: TilePos,
        item: reference_sim::content::ItemId,
        count: u32,
    ) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnaceDeposit {
                at: TileXY::from_tile(at),
                item: item as u8,
                count,
            },
        )
    }

    /// `FurnaceTake { at }` for `who` (Provides: `RefScenario::take`).
    pub fn take(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnaceTake {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// `FurnacePickUp { at }` for `who` (Provides: `RefScenario::pick_up`).
    pub fn pick_up(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnacePickUp {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// The furnace whose footprint covers `at` on the host, by value (Provides:
    /// `RefScenario::furnace_at`).
    pub fn furnace_at(&self, at: TilePos) -> Option<reference_sim::Furnace> {
        let id = self.entity_at(at)?;
        self.sim
            .authority()
            .entity(id)
            .expect("host reads are total")
            .copied()
    }

    /// Replaces the furnace covering `at` with `f` by a direct put (native-test-only, like
    /// [`Self::give`]): reaches states that would take 999 smelts. The put wakes the furnace.
    pub fn put_furnace(&mut self, at: TilePos, f: reference_sim::Furnace) {
        let id = self.entity_at(at).expect("a furnace is there");
        self.sim.authority_mut().put_entity(id, f);
    }

    /// The host's world as a plain `&dyn WorldRead` (what `can_place` takes).
    pub fn read(&self) -> &dyn WorldRead<RefGame> {
        self.sim.authority()
    }

    /// Writes recorded since genesis (`Authority::changes`; nothing clears them here): two readings
    /// differ exactly when something was put in between.
    pub fn writes_logged(&self) -> usize {
        self.sim.authority().changes().len()
    }

    /// Entity puts (spawns included) recorded since genesis: a furnace placement is exactly one.
    pub fn entity_puts_logged(&self) -> usize {
        self.sim
            .authority()
            .changes()
            .iter()
            .filter(|(_, d)| matches!(d, engine::delta::Delta::EntityPut { .. }))
            .count()
    }

    /// Entities the last tick's rules visited (`next_woken`/`next_due` pops).
    pub fn visited_last_tick(&self) -> u64 {
        self.sim.authority().entities_visited_per_tick()
    }

    /// The occupant of `pos` on the host (real ids only: there is no prediction here).
    pub fn entity_at(&self, pos: TilePos) -> Option<engine::game::EntityId> {
        self.sim
            .authority()
            .entity_at(pos)
            .expect("host reads are total")
    }

    /// How many entities (furnaces) the host holds whose footprint touches the square of `radius`
    /// tiles around the origin (every test here places near it).
    pub fn furnace_count(&self) -> usize {
        let r = 200;
        let mut n = 0;
        self.sim
            .authority()
            .entities_in(
                TileRect::new(TilePos::new(-r, -r), TilePos::new(r, r)),
                &mut |_, _| n += 1,
            )
            .expect("host reads are total");
        n
    }

    /// Makes `w` x `h` tiles from `min` plain grass with no resource (native-test-only, like
    /// [`Self::set_tile`]): placement tests must not depend on what worldgen put there.
    pub fn clear_area(&mut self, min: TilePos, w: i32, h: i32) {
        for dy in 0..h {
            for dx in 0..w {
                self.set_tile(
                    TilePos::new(min.x + dx, min.y + dy),
                    Tile::new(reference_sim::content::GRASS, 0, 0),
                );
            }
        }
    }

    pub fn step_ticks(&mut self, n: u32) {
        for _ in 0..n {
            self.sim.step(&[], &mut self.out);
        }
    }

    pub fn tick(&self) -> engine::time::Tick {
        self.sim.authority().tick()
    }

    pub fn player(&self, who: PlayerId) -> RefPlayer {
        *self.sim.authority().player(who).expect("player exists")
    }

    pub fn tile(&self, pos: TilePos) -> Tile {
        self.sim.authority().tile(pos).expect("tile readable")
    }

    /// Direct world write, bypassing `apply` (native-test-only convenience: constructing a
    /// near-depleted tile without actually running nine real collects first).
    pub fn set_tile(&mut self, pos: TilePos, t: Tile) {
        self.sim.authority_mut().set_tile(pos, t);
    }

    /// The game's `Global` (per-player palette indices), by value.
    pub fn global(&self) -> reference_sim::RefGlobal {
        *self.sim.authority().global()
    }

    /// `Delta::Global` writes recorded since genesis (`writes_logged`'s sibling).
    pub fn global_puts_logged(&self) -> usize {
        self.sim
            .authority()
            .changes()
            .iter()
            .filter(|(_, d)| matches!(d, engine::delta::Delta::Global { .. }))
            .count()
    }

    /// The host's `SimRng` state (it is in the snapshot; `state_hash` does not cover it).
    pub fn rng(&self) -> engine::rng::SimRng {
        self.sim.authority().rng()
    }

    pub fn hash(&self) -> u64 {
        self.sim.state_hash()
    }

    /// Writes a snapshot of the host and restores it into a fresh `Sim` (what a saved world does on
    /// load: the same path `engine::testing::replay::heavy` uses), replacing `self.sim`.
    pub fn save_and_load(&mut self) {
        use engine::authority::Authority;
        use engine::game::Game as _;
        use engine::persist::{Identity, SnapshotProgress, SnapshotReader, SnapshotWriter};
        use engine::store::Store;
        use engine::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
        use engine::worldgen::{Pristine, WorldgenStamp};
        let identity = Identity {
            build_hash: [0; 16],
            engine_version: "0.0.0".to_string(),
            game_version: "0.0.0".to_string(),
            schema_version: RefGame::SCHEMA_VERSION,
            tick_rate_hz: RefGame::TICK_RATE.hz_value(),
            worldgen: WorldgenStamp {
                version:
                    <reference_sim::RefWorldgen as engine::worldgen::Worldgen>::WORLDGEN_VERSION,
                fingerprint: 0,
            },
        };
        let rng = self.sim.authority().rng();
        let mut w = SnapshotWriter::begin(
            self.sim.authority().store(),
            self.sim.tick(),
            &rng,
            0,
            0,
            0,
            &identity,
        );
        let mut bytes = vec![0u8; w.total_len()];
        let n = w.next(&mut bytes);
        assert_eq!(n, bytes.len());
        let source: Box<dyn PristineSource> = Box::new(
            Pristine::<reference_sim::RefWorldgen>::new(TEST_SEED, RefParams::default()),
        );
        let terrain = TerrainStore::new(
            ChunkDims::new(RefGame::CHUNK_BITS),
            source,
            CacheCapacity::Chunks(1024),
        );
        let shell = Store::new(terrain, Default::default());
        let mut reader: SnapshotReader<RefGame> = SnapshotReader::new(shell);
        let info = match reader.push(&bytes) {
            Ok(SnapshotProgress::Done(info)) => info,
            _ => panic!("a snapshot this process just wrote must decode"),
        };
        let authority = Authority::from_snapshot(reader.into_store(), info.rng, info.tick);
        self.sim = Sim::from_parts(authority);
    }
}

impl Default for RefScenario {
    fn default() -> Self {
        Self::new()
    }
}

pub mod bench_host;
pub mod bench_run;
