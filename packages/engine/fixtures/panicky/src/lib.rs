//! Fixture game `fx-panicky` (docs/plan/24-recovery-and-migration.md Provides: "Fixture `panicky`:
//! actions `PanicInAdmit`, `PanicInApply`, `ArmTickPanic { at: Tick }`, `ArmTickAlloc { at: Tick }`
//! (the tick rule allocates past the arena), `OverflowStackInAdmit` (deterministic panics in each
//! phase; `sim_test_trap` exists for harnesses running other fixtures)"). Every action panics
//! deterministically, in a specific `Progress` phase, so the recovery machinery (this milestone's
//! own `Host`/loader plumbing, and the second implementer's `recovery.ts`) has a real, reachable
//! trap to recover from in each phase it fences differently:
//!
//! - `PanicInAdmit`/`OverflowStackInAdmit` panic inside `Game::admit` (0004 step 2, `Phase::Admit`):
//!   never logged (an admission rejection is never a record at all), so this deterministic panic
//!   is what a live host actually reaches when it retries the connection.
//! - `PanicInApply` is admitted cleanly (so it *is* logged, write-ahead) and panics inside
//!   `Game::apply` (`Phase::ApplyRecord`) -- the one phase 0005 "Panic recovery" step 3 fences with
//!   a `Skip` record.
//! - `ArmTickPanic { at }`/`ArmTickAlloc { at }` are admitted and applied without panicking (they
//!   just arm a `Global` flag); the panic happens later, inside `Game::tick` (`Phase::Tick`) once
//!   the sim reaches tick `at` -- deterministic and reproducible by replay, unlike a live-only
//!   crash. `ArmTickAlloc` allocates past the configured arena instead of calling `panic!`
//!   directly: `abi::arena::Arena`'s own debug-build check (`grow_live`) reports that as a panic
//!   through `panic::fatal` before the allocation completes (0005 Planning decisions 5: "a failed
//!   `memory.grow`/allocation failure arrives as a panic through the alloc-error path"). Native
//!   tests (no `engine_init`, so no arena is ever reserved) simply allocate and free the block --
//!   the point where it is reported as a trap only exists once this ships to `.wasm` under a real
//!   `arenaBytes` budget.

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

/// Arms `Game::tick`'s own deterministic panics: `Some(tick)` means "panic (or over-allocate) the
/// next time `Sim`'s tick counter reaches `tick`" (docs/plan/24-recovery-and-migration.md
/// Provides). Plain sim state -- hashed and logged like any other `Global`, so replay reaches the
/// exact same armed tick the live run did.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub armed_tick_panic: Option<u32>,
    pub armed_tick_alloc: Option<u32>,
    /// Bumped once at the top of every `apply` call, regardless of which action (docs/plan/
    /// 24-recovery-and-migration.md: the Skip/replay tests' own "additive action so a double-apply
    /// would show" -- a `Skip`-fenced record must leave this unchanged, and a resent `seq` must
    /// not bump it again after replay).
    pub apply_count: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    /// Panics inside `Game::admit` (`Phase::Admit`) -- never logged (0004: an admission rejection
    /// is not a record at all).
    PanicInAdmit,
    /// Admitted cleanly; panics inside `Game::apply` (`Phase::ApplyRecord`) -- the phase 0005
    /// fences with a `Skip` record.
    PanicInApply,
    /// Arms a `Global` flag; `Game::tick` panics once the sim reaches tick `at` (`Phase::Tick`).
    ArmTickPanic { at: u32 },
    /// Arms a `Global` flag; `Game::tick` allocates past the configured arena once the sim reaches
    /// tick `at` (`Phase::Tick`) -- a failed allocation, not a `panic!` call.
    ArmTickAlloc { at: u32 },
    /// Panics inside `Game::admit` (`Phase::Admit`) via the raw WASM `unreachable` instruction
    /// (`trap_no_panic`, this crate's own doc comment has the reasoning) -- a trap with **no**
    /// preceding `engine.panic` call, unlike every other action here (0014 §6: "a trap with no
    /// preceding `engine.panic` ... is reported with the `RuntimeError`'s own message").
    OverflowStackInAdmit,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    Unknown,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// `OverflowStackInAdmit`'s own trap: the raw WASM `unreachable` instruction, called directly
/// (`core::arch::wasm32::unreachable`, bypassing Rust's panic machinery entirely, the same
/// mechanism `abi::panic::fatal` falls back to) rather than genuine unbounded recursion. A first
/// version of this fixture used real non-tail recursion to force a hardware stack overflow; under
/// Node/V8 that reliably took down the whole worker process with `SIGABRT` -- an uncatchable crash,
/// not a trap `EngineTrap` could ever report -- rather than a catchable `WebAssembly.RuntimeError`
/// (deep WASM recursion crashing the host process outright is a known V8 behaviour, not specific to
/// this fixture). `unreachable` is 0014 §6's *other* named example of "a trap with no preceding
/// `engine.panic` call" (stack overflow, out-of-bounds) and produces the identical observable
/// property this action exists to test -- an `EngineTrap` whose `panicMessage` is the raw
/// `RuntimeError`'s own text, never this crate's `panic!` formatting -- with no risk to the test
/// process. Native builds (`cargo test`, never exercised by any test here: this action is reached
/// only from a WASM-under-Node test) fall back to `std::process::abort()`, mirroring `abi::panic::
/// fatal`'s own native fallback.
fn trap_no_panic() -> ! {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    std::process::abort();
}

/// `ArmTickAlloc`'s own over-budget allocation: comfortably past any `arenaBytes` this repo's own
/// configs ever use. Written to (not just allocated) so nothing optimises it away, then dropped.
const OVERSIZED_ALLOC_BYTES: usize = 512 * 1024 * 1024;

fn oversized_alloc() {
    let mut v: Vec<u8> = Vec::with_capacity(OVERSIZED_ALLOC_BYTES);
    v.push(1);
    core::hint::black_box(&v);
}

pub struct Panicky;

impl Game for Panicky {
    const SCHEMA_VERSION: u32 = 1;
    const GAME_VERSION: &'static str = env!("CARGO_PKG_VERSION");
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, engine::world::Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(_e: &Entity) -> TilePos {
        TilePos::new(0, 0)
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            // Never reached live: `admit` already trapped before either could be queued. Present
            // only so the match stays exhaustive (and so replay of a hand-built log naming one by
            // mistake fails loudly rather than silently no-op-ing).
            Action::PanicInAdmit | Action::OverflowStackInAdmit => {
                panic!("panicky: {a:?} reached apply -- admit should have trapped first")
            }
            Action::PanicInApply => {
                panic!("panicky: PanicInApply")
            }
            Action::ArmTickPanic { at } => {
                let mut g = *w.global();
                g.armed_tick_panic = Some(*at);
                g.apply_count = g.apply_count.wrapping_add(1);
                w.put_global(g);
                Ok(())
            }
            Action::ArmTickAlloc { at } => {
                let mut g = *w.global();
                g.armed_tick_alloc = Some(*at);
                g.apply_count = g.apply_count.wrapping_add(1);
                w.put_global(g);
                Ok(())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        let g = *cx.global();
        if let Some(at) = g.armed_tick_panic
            && cx.tick().0 == at
        {
            panic!("panicky: ArmTickPanic reached tick {at}");
        }
        if let Some(at) = g.armed_tick_alloc
            && cx.tick().0 == at
        {
            oversized_alloc();
        }
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        a: &Action,
    ) -> Result<(), Reject> {
        match a {
            Action::PanicInAdmit => panic!("panicky: PanicInAdmit"),
            Action::OverflowStackInAdmit => trap_no_panic(),
            Action::PanicInApply | Action::ArmTickPanic { .. } | Action::ArmTickAlloc { .. } => {
                Ok(())
            }
        }
    }
}

/// A trivial deterministic worldgen (mirrors `fx-persist::FlatWorldgen`): nothing here depends on
/// interesting terrain.
pub struct FlatWorldgen;

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

engine::export_game!(Panicky);

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings_enginereject() {
        // Same reasoning as `fx-puts`/`fx-machines`/`fx-persist`'s own hand-written copy of this
        // test: ts-rs's derive-generated `export_bindings_*` test for `engine::sim::EngineReject`
        // lives in the `engine` crate itself, never run by this crate's own `cargo test
        // export_bindings`.
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
