//! `Sim<G>` (docs/plan/12b-world-access-and-sim-driver.md Scope): the host driver. `genesis` builds
//! a fresh world and runs `Game::genesis` once at tick 0; `step` runs one frame's recorded inputs
//! in 0004 order (`on_player`, or `apply` then the host's per-player `last_seq = seq`), then
//! `Game::tick`, then advances the tick.
//!
//! `timers`/`wake`/`active` (docs/plan/21b-timers-wakeups-and-tickcx.md): the timer wheel, wake
//! queue and per-system active lists `Store` holds as sim state (0007 §7); `Authority`/`TickCx`
//! (`crate::authority`) are the only callers, so every type here is `pub(crate)`.

pub(crate) mod active;
pub(crate) mod timers;
pub(crate) mod wake;

use crate::authority::{Authority, TickCx};
use crate::budget;
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
/// milestone (docs/plan/12b-world-access-and-sim-driver.md Non-scope). `Serialize` (docs/plan/
/// 16-action-round-trip.md): a rejected action's result JSON (`client.onActionResult`) needs to
/// encode this half of `Rejected<G>`, tagged `{"Engine":<this>}` -- `game_instance::
/// push_result_record` keeps `Rejected<G>`'s own `Game`/`Engine` level in the JSON rather than
/// flattening it away (orchestrator ruling at the M16 gate): 0004's Decision defines `Rejected<G>`
/// as exactly this two-variant enum, and collapsing the tag would make a game's own reject variant
/// indistinguishable from the engine's by name alone once `RateLimited` (M31) and `StateBudgetFull`
/// (M21) are real. `TS` (docs/plan/16-action-round-trip.md step 4), deliberately **without**
/// `#[ts(export)]`: `EngineReject` is engine-side, not a `G::Reject`, and ts-rs's own derive macro
/// puts its `export_bindings_<type>` test in the crate that derives `TS` -- `engine` here, not a
/// downstream game crate -- so `cargo test export_bindings` run from `fixtures/puts` (0017 §5's own
/// command, scoped to that one package, no `-p`/`--workspace`) would never run it anyway; worse,
/// `#[ts(export)]` here would make *every* `cargo test -p engine` (this crate's own fast-tier
/// suite, `pnpm test rust`) write `crates/engine/bindings/EngineReject.ts` as an unwanted side
/// effect, since ts-rs generates `output_path()`/`export_all()` unconditionally and only
/// `#[ts(export)]` decides whether it *also* emits its own auto-run test (found the hard way: a
/// stray `crates/engine/bindings/` appeared after running the plain engine suite once with the
/// attribute present). `fixtures/puts/src/lib.rs` instead has its own `#[test] fn export_bindings_
/// enginereject()` that calls `<engine::sim::EngineReject as ts_rs::TS>::export_all(&Config::
/// from_env())` directly -- `export_all` needs no `#[ts(export)]` at all, so this is the same call
/// the derive macro's own generated test would have made, just written by hand in the one crate
/// whose `cargo test export_bindings` actually runs, landing `EngineReject.ts` in the fixture's own
/// `bindings/` alongside `Action`/`Reject`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, ts_rs::TS)]
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
        authority.set_budget(
            params.max_entities,
            params.max_modified_tiles,
            params.max_action_growth,
        );
        G::genesis(&mut authority as &mut dyn WorldWrite<G>);
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
                    // 0004 "State-budget check" / 0023 "The check": host only, before `apply`,
                    // for game actions only. Reads only sim state and world params, so the live
                    // host, replay and recovery decide identically (docs/plan/
                    // 21-entities-and-timers.md Deviations: lives at `crate::budget`, not
                    // `host::budget`, since this runs from here -- the deterministic core).
                    let declared = G::growth(action);
                    if let Err(reject) = budget::check(&self.authority, declared) {
                        self.authority.record_ack(*who, *seq);
                        out.push(Outcome {
                            seq: *seq,
                            result: Err(Rejected::Engine(reject)),
                        });
                        continue;
                    }
                    let before = self.authority.changes().len();
                    let counts_before = (
                        self.authority.store().entity_count(),
                        self.authority.store().modified_tile_count(),
                    );
                    // The undo journal (docs/plan/21b-timers-wakeups-and-tickcx.md Planning
                    // decisions, adopted -- `authority::UNDO_JOURNAL_ADOPTED`'s own doc comment has
                    // the measured numbers): always records, so a rejecting `apply` that wrote can
                    // be rolled back below instead of only asserted against.
                    self.authority.begin_apply_journal();
                    let result =
                        G::apply(&mut self.authority as &mut dyn WorldWrite<G>, *who, action);
                    if result.is_err() && self.authority.changes().len() != before {
                        self.authority
                            .handle_rejected_apply_write(*who, *seq, before);
                    } else {
                        self.authority.commit_apply_journal();
                    }
                    if result.is_ok() {
                        budget::audit(&mut self.authority, declared, counts_before);
                    }
                    self.authority.record_ack(*who, *seq);
                    out.push(Outcome {
                        seq: *seq,
                        result: result.map(|()| Applied).map_err(Rejected::Game),
                    });
                }
            }
        }
        // The fixed point (0007 §7; docs/plan/21b-timers-wakeups-and-tickcx.md Scope): swap the
        // wake queue at the start of `G::tick`, compact every active list's tombstones and drop
        // whatever the wake queue's `now` list still holds at the end of it.
        self.authority.begin_tick();
        {
            let mut cx = TickCx::new(&mut self.authority);
            G::tick(&mut cx);
        }
        self.authority.end_tick();
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

    /// Mutable access, additive beyond this milestone's own Provides (docs/plan/
    /// 15-connection-and-subscriptions.md Deviations): `host::Host::seal` clears the just-built
    /// tick's `ChangeLog` (`Authority::clear_changes`) once every connection's frame has read it,
    /// which needs `&mut Authority<G>` from outside this module -- `Authority::clear_changes`
    /// itself was already `pub`, just previously unreachable from `Host` without this accessor.
    pub fn authority_mut(&mut self) -> &mut Authority<G> {
        &mut self.authority
    }
}
