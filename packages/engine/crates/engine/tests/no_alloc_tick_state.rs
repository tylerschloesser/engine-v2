//! `tick_state_steady_no_alloc` (docs/plan/21b-timers-wakeups-and-tickcx.md Tests added, Budgets
//! "Allocation: `tick_state_steady_no_alloc`"). Own test binary (mirrors `no_alloc_terrain.rs`/
//! `no_alloc_authority.rs`): a `#[global_allocator]` only counts allocations made inside the binary
//! that installs it. A steady population of entities continuously re-schedules its own timer
//! (wake -> `wake_at`; due -> `count += 1`, reschedule again) -- the timer wheel's own steady-state
//! churn (insert on `wake_at`, remove on `next_due`) at a constant population.
//!
//! No-alloc assertion template (`.claude/rules/hot-paths.md`'s sibling for the native side, M15):
//! growth over a long window must equal growth over a short one -- not a hard-coded ceiling, and
//! not necessarily exactly zero, so a one-off allocator artefact does not make this flaky, but any
//! *real*, per-tick growth (the thing this test exists to catch) shows up as a difference between
//! the two windows. `engine::abi::arena::live_bytes()` counts live bytes (allocations minus frees).

use engine::abi::Arena;
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::sim::{Record, Sim, WorldParams};
use engine::time::Tick;
use engine::world::{ChunkCoord, Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NEntity {
    x: i32,
    y: i32,
    delay: u32,
    done_at: u32,
    count: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NGlobal;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NAction {
    x: i32,
    y: i32,
    delay: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NReject;
impl From<Unknown> for NReject {
    fn from(_: Unknown) -> Self {
        NReject
    }
}

struct NGen;
impl Worldgen for NGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

struct NGame;
impl Game for NGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = NGen;
    type Action = NAction;
    type Reject = NReject;
    type Entity = NEntity;
    type Player = NPlayer;
    type Global = NGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
    }
    fn prototype(_e: &NEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &NEntity) -> TilePos {
        TilePos::new(e.x, e.y)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, NPlayer);
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &NAction) -> Result<(), NReject> {
        w.spawn(NEntity {
            x: a.x,
            y: a.y,
            delay: a.delay,
            done_at: 0,
            count: 0,
        });
        Ok(())
    }
    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            let Some(mut e) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            e.done_at = cx.tick().0 + e.delay;
            let at = Tick(e.done_at);
            cx.put_entity(id, e);
            cx.wake_at(id, at);
        }
        while let Some(id) = cx.next_due() {
            let Some(mut e) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            e.count += 1;
            e.done_at = cx.tick().0 + e.delay; // reschedule immediately: steady population.
            let at = Tick(e.done_at);
            cx.put_entity(id, e);
            cx.wake_at(id, at);
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &NAction,
    ) -> Result<(), NReject> {
        Ok(())
    }
}

const POPULATION: u32 = 200;

#[test]
fn tick_state_steady_no_alloc() {
    let mut sim = Sim::<NGame>::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1_000_000,
        max_modified_tiles: 1_000_000,
        max_action_growth: 1_000_000,
    });
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(
        &[Record::Player {
            who: p1,
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    // One uniform delay: every entity re-schedules for the same relative offset, so the whole
    // population buckets together every cycle -- a single, small period. (A spread of several
    // different delays also converges, but only after a far longer warm-up: their common period is
    // the `lcm` of all of them, and this test does not need that extra realism to catch the defect
    // it guards against -- Deviations has the measured numbers for both.) Distinct positions (one
    // per chunk) give each entity its own, uncontended `ChunkIndex` entry.
    const DELAY: u32 = 5;
    let spawns: Vec<Record<NGame>> = (0..POPULATION)
        .map(|i| Record::Action {
            who: p1,
            seq: i + 1,
            action: NAction {
                x: (i as i32) * 32,
                y: 0,
                delay: DELAY,
            },
        })
        .collect();
    sim.step(&spawns, &mut out);
    sim.authority_mut().clear_changes();

    // `Authority::changes()` (the `ChangeLog`) is a real host driver's own responsibility to clear
    // every tick (`Host::seal`, docs/plan/15-connection-and-subscriptions.md) -- this test drives
    // `Sim` directly with no `Host`, so it must do the same, or an unrelated, ever-growing `Vec` of
    // undrained deltas would swamp the one thing this test measures: the timer wheel's own
    // steady-state churn.
    let mut step = |sim: &mut Sim<NGame>| {
        sim.step(&[], &mut out);
        sim.authority_mut().clear_changes();
    };

    // Warm-up: run past many full cycles so the timer wheel's own bucketed `BTreeMap` (`sim::
    // timers`'s own doc comment: bucketed by `Tick`, specifically to keep this bounded) settles at
    // its steady-state bucket set -- the counting allocator only starts measuring after this.
    for _ in 0..8_000 {
        step(&mut sim);
    }

    let before_short = live();
    for _ in 0..500 {
        step(&mut sim);
    }
    let short_growth = live().saturating_sub(before_short);

    let before_long = live();
    for _ in 0..2_500 {
        // 5x the short window
        step(&mut sim);
    }
    let long_growth = live().saturating_sub(before_long);

    assert_eq!(
        short_growth, long_growth,
        "steady-state growth must not scale with the number of ticks run (short: {short_growth} B \
         over 500 ticks, long: {long_growth} B over 2500 ticks)"
    );
}
