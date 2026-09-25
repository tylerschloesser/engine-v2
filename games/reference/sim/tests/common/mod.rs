//! Shared native test support (docs/plan/20-reference-game-v0.md Provides: "native test helper
//! `sim/tests/common/mod.rs::RefScenario`"). `#![allow(dead_code)]`: each `tests/*.rs` file is its
//! own binary that includes this module whole, so a helper only some of them call (e.g. `landmarks_
//! fixture.rs` uses neither `RefScenario` nor most of its methods) would otherwise warn -- and
//! `pnpm lint`'s `-D warnings` would fail the build over an unused method in a *different* test
//! binary's copy of this shared file.
#![allow(dead_code)]

use engine::game::{PlayerEvent, PlayerId, WorldRead, WorldWrite};
use engine::sim::{Record, Rejected, Sim, WorldParams};
use engine::world::{Tile, TilePos};
use reference_sim::{RefAction, RefGame, RefParams, RefPlayer, RefReject};

/// The one seed every native test in this crate shares (Provides: "the `TEST_SEED` value").
pub const TEST_SEED: u64 = 0x5EED_1234_ABCD_0042;

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
                max_entities: 0,
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

    pub fn step_ticks(&mut self, n: u32) {
        for _ in 0..n {
            self.sim.step(&[], &mut self.out);
        }
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

    pub fn hash(&self) -> u64 {
        self.sim.state_hash()
    }
}

impl Default for RefScenario {
    fn default() -> Self {
        Self::new()
    }
}
