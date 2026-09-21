//! `Sim<G>` (docs/plan/12b-world-access-and-sim-driver.md Scope): the host driver. `genesis` builds
//! a fresh world and runs `Game::genesis` once at tick 0; `step` runs one frame's recorded inputs
//! in 0004 order (`on_player`, or `apply` then the host's per-player `last_seq = seq`), then
//! `Game::tick`, then advances the tick.

use crate::authority::{Authority, TickCx};
use crate::game::{Game, PlayerEvent, PlayerId};
use crate::time::Tick;
use crate::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
use crate::world_access::WorldWrite;
use crate::worldgen::{Pristine, Worldgen};

/// 0007 §8's host cache budget default (1,024 chunks = 4 MiB at the default 32x32 chunk size).
/// Not part of [`WorldParams`]: 0009's `WorldConfig.params` only lists the state-budget fields
/// this milestone's Scope names, and `cacheChunks` is a separate, host-only knob there.
const DEFAULT_CACHE_CHUNKS: u32 = 1024;

/// World params: seed, the game's worldgen params, and the state-budget fields of 0009
/// `WorldConfig.params` (0007 §8's defaults; the check itself is M21/M21b, Non-scope here).
pub struct WorldParams<G: Game> {
    pub seed: u64,
    pub worldgen: <G::Worldgen as Worldgen>::Params,
    pub max_entities: u32,
    pub max_modified_tiles: u32,
    pub max_action_growth: u32,
}

/// One recorded input to a frame (0004: "Engine-defined connection events ... are sequenced in the
/// same stream" as actions). `seq` is the client-assigned, per-player monotonic counter (0003,
/// 0004).
pub enum Record<G: Game> {
    Action {
        who: PlayerId,
        seq: u32,
        action: G::Action,
    },
    Player {
        who: PlayerId,
        ev: PlayerEvent,
    },
}

// Bounded on `G::Action: Clone` rather than requiring it of every `Record<G>` user (mirrors
// `Delta<G>`'s own manual `Clone`, `crate::delta`): `PlayerEvent`/`PlayerId` are already `Copy`.
impl<G: Game> Clone for Record<G>
where
    G::Action: Clone,
{
    fn clone(&self) -> Self {
        match self {
            Record::Action { who, seq, action } => Record::Action {
                who: *who,
                seq: *seq,
                action: action.clone(),
            },
            Record::Player { who, ev } => Record::Player { who: *who, ev: *ev },
        }
    }
}

/// An accepted action's result (0004 Decision), carrying nothing: with stable-key addressing
/// (0022 §6, "no id map") a spawned entity's id is deterministic from the log alone, so a client
/// never needs it echoed back.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Applied;

/// A rejected action (0004 Decision, verbatim shape). `Engine` variants are declared for a fixed,
/// Provides-stable `Rejected<G>` shape; nothing constructs one yet (state-budget checking and rate
/// limiting are Non-scope here: M21/M21b and host admission, respectively).
pub enum Rejected<G: Game> {
    Game(G::Reject),
    Engine(EngineReject),
}

/// 0004 Decision, verbatim: `RateLimited` (admission, never reaches `apply`), `StateBudgetFull`
/// (0007 §8's check), `EngineFault` (0005 skip-record recovery). None is produced by this
/// milestone (docs/plan/12b-world-access-and-sim-driver.md Non-scope).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EngineReject {
    RateLimited,
    StateBudgetFull,
    EngineFault,
}

/// One action's outcome (0004: `Ack<G>` minus the `tick` field, which the caller already knows
/// from [`Sim::tick`] when `step` returns).
pub struct Outcome<G: Game> {
    pub seq: u32,
    pub result: Result<Applied, Rejected<G>>,
}

/// The host driver (docs/plan/12b-world-access-and-sim-driver.md Scope). Wraps one [`Authority`]
/// and runs `Game`'s hooks against it in 0004 order.
pub struct Sim<G: Game> {
    authority: Authority<G>,
}

impl<G: Game> Sim<G> {
    /// Builds a fresh world (terrain over `G::Worldgen`, an empty `Store`) and runs `Game::genesis`
    /// once, at tick 0 (0003). `Store::new` needs a `G::Global` value before `Game::genesis`'s own
    /// first `put_global` overwrites it, and `G::Global` carries no `Default` bound in the `Game`
    /// trait itself (`crate::store`'s doc comment) -- this is the one caller that needs one, so the
    /// bound lives here rather than on `Game` (docs/plan/12b-world-access-and-sim-driver.md
    /// Deviations).
    pub fn genesis(params: WorldParams<G>) -> Self
    where
        G::Global: Default,
    {
        let dims = ChunkDims::new(G::CHUNK_BITS);
        let source: Box<dyn PristineSource> =
            Box::new(Pristine::<G::Worldgen>::new(params.seed, params.worldgen));
        let terrain = TerrainStore::new(dims, source, CacheCapacity::Chunks(DEFAULT_CACHE_CHUNKS));
        let mut authority = Authority::new(terrain, G::Global::default(), params.seed);
        G::genesis(&mut authority as &mut dyn WorldWrite<G>);
        // `max_entities`/`max_modified_tiles`/`max_action_growth` are carried on `WorldParams` for
        // a future milestone's state-budget check (Non-scope here); nothing reads them yet.
        let _ = (
            params.max_entities,
            params.max_modified_tiles,
            params.max_action_growth,
        );
        Sim { authority }
    }

    /// Runs `records` in host arrival order (0004: `on_player`, or `apply` then the host's
    /// per-player `last_seq = seq`), then `Game::tick`, then advances the tick. A rejecting
    /// `apply` that recorded a write panics (0004 Consequences: "the host asserts that a rejecting
    /// `apply` recorded no writes").
    pub fn step(&mut self, records: &[Record<G>], out: &mut Vec<Outcome<G>>) {
        out.clear();
        for record in records {
            match record {
                Record::Player { who, ev } => {
                    G::on_player(&mut self.authority as &mut dyn WorldWrite<G>, *who, *ev);
                }
                Record::Action { who, seq, action } => {
                    let before = self.authority.changes().len();
                    let result =
                        G::apply(&mut self.authority as &mut dyn WorldWrite<G>, *who, action);
                    assert!(
                        result.is_ok() || self.authority.changes().len() == before,
                        "a rejecting apply recorded a write (0004 Consequences): who={who:?} seq={seq}",
                    );
                    self.authority.record_ack(*who, *seq);
                    out.push(Outcome {
                        seq: *seq,
                        result: result.map(|()| Applied).map_err(Rejected::Game),
                    });
                }
            }
        }
        {
            let mut cx = TickCx::new(&mut self.authority);
            G::tick(&mut cx);
        }
        self.authority.advance_tick();
    }

    pub fn tick(&self) -> Tick {
        self.authority.tick()
    }

    pub fn state_hash(&self) -> u64 {
        self.authority.store().state_hash()
    }

    pub fn authority(&self) -> &Authority<G> {
        &self.authority
    }
}
